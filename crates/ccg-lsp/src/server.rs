//! 서버 한 인스턴스 — 스폰 · `initialize` · 문서 동기화 · 기능 요청.
//!
//! **여기에는 언어 이름이 한 번도 안 나온다.** 언어별 차이는 전부 [`ServerSpec`]의 값으로
//! 들어온다(`spec.rs` 표 참고). 그 대신 2.6.2가 실측으로 얻은 **불변식 두 개**는 스펙과
//! 무관하게 엔진이 지킨다 — 스펙 작성자가 잊어도 서버가 죽지 않게:
//!
//! 1. **`didOpen`은 문서당 정확히 한 번.** 2.6.2에서는 `stat`/`readFile`의 await 갭에
//!    동시 요청(status 폴링·warm·semanticTokens·hover가 한꺼번에 온다)이 겹쳐 두 번 나갔고,
//!    Roslyn은 그걸 unhandled exception으로 받아 **프로세스째** 죽었다. 여기서는 판정·기록·
//!    통지가 전부 `docs` 뮤텍스 **한 임계 구역 안**에 있다 — 겹칠 틈 자체가 없다.
//! 2. **`didChange`는 서버가 선언한 `syncKind`를 존중한다.** incremental(2)을 선언한 서버에
//!    range 없는 전문 교체를 보내면 Roslyn은 NullReferenceException으로 죽는다. 전문 교체가
//!    필요하면 **문서 전체를 덮는 range**로 보낸다.

use crate::rpc::Rpc;
use crate::semcache::SemanticTokens;
use crate::spec::{Launch, Provision, Reprime, ServerSpec};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// 한 서버가 동시에 열어 두는 문서 상한 — 넘으면 가장 오래된 것을 `didClose`.
const MAX_OPEN_DOCS: usize = 32;
/// 초기화가 이만큼 지나도 응답이 없으면 죽은 것으로 본다.
/// (2.6.2는 600초 — Roslyn이 솔루션을 다 읽고서야 initialize에 답하기 때문. 같은 값)
const INIT_TIMEOUT: Duration = Duration::from_secs(600);

// ── 재프라임 규약 상수 (2.6.2 `primeFullSemantics` — manager.ts:2958) ────────────
/// **didOpen 뒤 최소 이만큼** 지나야 프라임한다. 2.6.2 주석의 실측: *갭 0ms=실패,
/// 1.5s=성공.* 문서 열림이 워크스페이스에 반영되기 전에 프라임하면 그 스냅샷이
/// "소스 제너레이터 멤버가 빠진 컴파일"로 확정된다.
const PRIME_MIN_OPEN_GAP_MS: u64 = 1_500;
/// 히트 0짜리 쿼리 — 어떤 쿼리든 전 인덱스 빌드를 유발하므로 **페이로드만 아낀다**.
/// (`""`를 보내면 전 워크스페이스 심볼 덤프가 돌아온다)
const PRIME_QUERY: &str = "zz__semantic_prime__";
/// 프라임 왕복 상한(2.6.2와 같은 180초 — 대형 솔루션의 첫 전 컴파일).
const PRIME_TIMEOUT: Duration = Duration::from_secs(180);
/// 멤버십 파일(스펙의 [`ServerSpec::membership_files`]) 폴링 주기. 재통지는 **한 주기
/// 조용해진 뒤** 한 번 — 2.6.2 `watchCsSolution`의 2초 디바운스와 같은 체감이다.
pub const MEMBERSHIP_POLL: Duration = Duration::from_millis(2_000);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Status {
    Starting,
    Ready,
    Error,
}

struct DocState {
    version: i64,
    /// 라이브 버퍼로 밀어 넣은 문서는 -1 — 다음 디스크 동기화가 무조건 재검사하게.
    mtime_ms: i64,
    size: u64,
    text: String,
}

#[derive(Default)]
struct Docs {
    map: HashMap<String, DocState>,
    order: Vec<String>,
}

#[derive(Default)]
struct Caps {
    sem_types: Vec<String>,
    sem_mods: Vec<String>,
    has_semantic: bool,
    /// 서버가 완성을 지원하는가(`completionProvider` 유무). `None` = 지원 안 함.
    compl_triggers: Option<Vec<String>>,
    compl_resolve: bool,
    /// 1 = full · 2 = incremental. 이 값을 존중하는 게 불변식 ②.
    sync_kind: i64,
}

struct State {
    status: Status,
    caps: Caps,
    /// `awaits_project_init` 서버의 인덱싱 게이트 — true인 동안 status는 `starting`.
    project_init_pending: bool,
    progress_pct: Option<f64>,
    err: Option<String>,
}

/// 완성 목록의 세대 + 원본 아이템 — `completionItem/resolve`가 원본을 그대로 되돌려보내야 한다.
#[derive(Default)]
struct ComplCache {
    gen: i64,
    items: Vec<Value>,
}

/// 전 솔루션 시맨틱 프라임의 상태 — 2.6.2 `wsSymPrime` 프라미스가 담던 것을 값으로 편다.
#[derive(Default)]
struct Prime {
    /// 유효한 프라임이 끝났다(변화가 오면 false로 되돌아간다).
    done: bool,
    /// 지금 누가 프라임을 돌고 있다 — **동시 요청은 한 번만 프라임한다**(규약 ⑤).
    running: bool,
    /// 변화 세대. 프라임 왕복 도중 올라가면 그 프라임은 낡은 것이다(규약 ③).
    dirty_gen: u64,
    /// 마지막으로 관측된 프로젝트 변화 시각(ms) — 조용 간격의 기준점(규약 ②).
    dirty_at_ms: u64,
}

pub struct Server {
    pub spec: &'static ServerSpec,
    pub root: PathBuf,
    pub pid: u32,
    rpc: Arc<Rpc>,
    child: Mutex<Option<Child>>,
    state: Mutex<State>,
    ready_cv: Condvar,
    docs: Mutex<Docs>,
    last_used_ms: AtomicU64,
    /// 마지막 `didOpen` 시각 — 프라임의 최소 오픈 갭(규약 ①) 기준점.
    last_open_ms: AtomicU64,
    prime: Mutex<Prime>,
    prime_cv: Condvar,
    compl: Mutex<ComplCache>,
    stderr_tail: Arc<Mutex<String>>,
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// 스펙의 실행 계획을 실제 명령으로 — 못 만들면 이유를 문자열로.
fn plan(spec: &ServerSpec, root: &Path) -> Result<(PathBuf, Vec<String>), String> {
    match &spec.launch {
        Launch::Node { module, args } => {
            let script = crate::launch::shipped_module(module).ok_or_else(|| {
                // **어디를 봤는지**까지 적는다 — 이유는 `launch::module_search_hint()` 주석.
                format!("번들 모듈을 못 찾음: node_modules/{} — {}", module.join("/"), crate::launch::module_search_hint())
            })?;
            // ★R3(크리틱 R2-C1) — R2까지 이 자리는 *"CCG_LSP_NODE · exe 옆 node.exe · **PATH**
            // 순으로 찾는다"*라고 말했다. 그런데 이 문자열이 뜨는 상황은 정확히 **배포본 +
            // 사이드카 유실**이고, 거기서 PATH는 **안 본다**. 사슬 ③(개발 스테이징)은 언급도
            // 없었고 뒤진 경로도 하나도 안 실었다. 사용자를 「node를 설치하라」는 헛수고로
            // 보내는 문장이었다 — 설치해도 안 낫는다. 이제 사슬과 **같은 목록**에서 만든다.
            let node = crate::launch::node_exe().ok_or_else(crate::launch::node_search_hint)?;
            let mut a = vec![script.to_string_lossy().to_string()];
            a.extend(args.iter().map(|s| s.to_string()));
            Ok((node, a))
        }
        Launch::Exe { bin, args, extra_args } => {
            let exe = crate::launch::installed_bin(spec.id, bin)
                .ok_or_else(|| format!("서버가 설치되지 않음: {bin}"))?;
            let mut a: Vec<String> = args.iter().map(|s| s.to_string()).collect();
            a.extend(extra_args(root));
            Ok((exe, a))
        }
    }
}

/// 이 스펙이 지금 기동 가능한가(설치·번들 상태) — status가 `need-install`/`unsupported`를
/// 가르는 판정. 실패 이유를 함께 돌려준다.
pub fn launchable(spec: &ServerSpec, root: &Path) -> Result<(), String> {
    plan(spec, root).map(|_| ())
}

impl Server {
    /// 스폰 + 초기화 시작. **즉시 돌아온다** — 초기화는 백그라운드 스레드에서 진행되고
    /// status는 그동안 `Starting`이다(뷰어가 폴링하는 그 상태).
    pub fn spawn(spec: &'static ServerSpec, root: &Path) -> Result<Arc<Server>, String> {
        let (cmd, args) = plan(spec, root)?;
        let mut c = Command::new(&cmd);
        c.args(&args)
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if matches!(spec.launch, Launch::Node { .. }) {
            // 2.6.2는 Electron을 Node로 쓰느라 이 변수가 필요했다. 진짜 node.exe에는
            // 무해하지만, 혹시 Electron 바이너리를 가리키게 되어도 같은 동작이 되게 남긴다.
            c.env("ELECTRON_RUN_AS_NODE", "1");
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW — 콘솔 창이 깜빡이지 않게
            c.creation_flags(0x0800_0000);
        }
        let mut child = c.spawn().map_err(|e| format!("서버 실행 실패: {e}"))?;
        let pid = child.id();
        // 앱이 어떤 식으로 죽든(크래시 포함) OS가 이 트리를 걷어가게 — jobkill.rs 헤더 참고.
        // 정상 경로의 회수(유휴 스윕·dispose_all)는 그대로 있고, 이건 그 밑의 안전망이다.
        crate::jobkill::adopt(pid);
        let stdin = child.stdin.take().ok_or("stdin 없음")?;
        let stdout = child.stdout.take().ok_or("stdout 없음")?;
        let stderr = child.stderr.take();

        let state = Mutex::new(State {
            status: Status::Starting,
            caps: Caps { sync_kind: 1, ..Default::default() },
            project_init_pending: spec.awaits_project_init,
            progress_pct: None,
            err: None,
        });

        // 통지 훅은 서버가 만들어지기 전에 필요하다 — 약한 참조로 뒤에 채운다.
        let hook_slot: Arc<Mutex<Option<std::sync::Weak<Server>>>> = Arc::new(Mutex::new(None));
        let hook_for_rpc = hook_slot.clone();
        // 설정 응답의 **값**은 스펙에서 온다 — 엔진도 rpc도 언어를 모른다(크리틱 C-5).
        let cfg_root = root.to_path_buf();
        let rpc = Rpc::start(
            stdin,
            stdout,
            Box::new(move |method, params| {
                let w = hook_for_rpc.lock().unwrap().clone();
                if let Some(s) = w.and_then(|w| w.upgrade()) {
                    s.on_notify(method, params);
                }
            }),
            Box::new(move |section| (spec.configuration)(&cfg_root, section)),
        );

        let stderr_tail = Arc::new(Mutex::new(String::new()));
        if let Some(mut e) = stderr {
            // **반드시 읽는다** — 안 읽으면 파이프가 차서 서버가 멈춘다(clangd는 평시에도
            // stderr로 로그를 쏟는다). 꼬리 4KB만 남겨 사인을 보존한다.
            let tail = stderr_tail.clone();
            std::thread::Builder::new()
                .name("ccg-lsp-err".into())
                .spawn(move || {
                    use std::io::Read;
                    let mut buf = [0u8; 8192];
                    while let Ok(n) = e.read(&mut buf) {
                        if n == 0 {
                            break;
                        }
                        let mut t = tail.lock().unwrap();
                        t.push_str(&String::from_utf8_lossy(&buf[..n]));
                        if t.len() > 4096 {
                            let cut = t.len() - 4096;
                            *t = t[cut..].to_string();
                        }
                    }
                })
                .ok();
        }

        let server = Arc::new(Server {
            spec,
            root: root.to_path_buf(),
            pid,
            rpc,
            child: Mutex::new(Some(child)),
            state,
            ready_cv: Condvar::new(),
            docs: Mutex::new(Docs::default()),
            last_used_ms: AtomicU64::new(now_ms()),
            last_open_ms: AtomicU64::new(0),
            prime: Mutex::new(Prime::default()),
            prime_cv: Condvar::new(),
            compl: Mutex::new(ComplCache::default()),
            stderr_tail,
        });
        *hook_slot.lock().unwrap() = Some(Arc::downgrade(&server));

        let init_target = server.clone();
        std::thread::Builder::new()
            .name("ccg-lsp-init".into())
            .spawn(move || init_target.initialize())
            .ok();
        Ok(server)
    }

    fn on_notify(&self, method: &str, params: &Value) {
        match method {
            "workspace/projectInitializationComplete" => {
                let mut st = self.state.lock().unwrap();
                st.project_init_pending = false;
                st.progress_pct = None;
                drop(st);
                self.ready_cv.notify_all();
            }
            "$/progress" => {
                let v = params.get("value");
                let kind = v.and_then(|v| v.get("kind")).and_then(Value::as_str);
                let mut st = self.state.lock().unwrap();
                if kind == Some("end") {
                    st.progress_pct = None;
                } else if let Some(p) = v.and_then(|v| v.get("percentage")).and_then(Value::as_f64) {
                    st.progress_pct = Some(p);
                }
            }
            _ => {}
        }
    }

    fn initialize(self: Arc<Self>) {
        let root_uri = path_to_uri(&self.root);
        let custom = (self.spec.workspace_folders)(&self.root);
        let folders: Vec<Value> = match &custom {
            Some(f) => f.iter().map(|(uri, name)| json!({ "uri": uri, "name": name })).collect(),
            None => vec![json!({
                "uri": root_uri,
                "name": self.root.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()
            })],
        };
        // `configuration`을 선언해야 서버가 `workspace/configuration`으로 **물어 온다**.
        // R2는 스펙에 `configuration` 필드를 만들어 놓고 이 선언을 안 해서, pyright는
        // 실측으로 그 경로를 **한 번도 밟지 않았다**(2.6.2도 같다 — 그쪽 `items.map(() => null)`
        // 핸들러를 치는 서버는 Roslyn뿐이었다). 언어 이름이 없는 LSP 클라이언트 능력이라
        // 다음 언어에서 이 줄이 다시 열리지 않는다.
        let mut workspace = json!({ "workspaceFolders": true, "configuration": true });
        if self.spec.declare_watched_files {
            // 스펙이 명시적으로 켤 때만. 끄는 게 기본인 이유는 spec.rs 표 참고
            // (Roslyn은 이걸 선언하는 순간 자기 폴백 워처를 꺼 버린다).
            workspace["didChangeWatchedFiles"] = json!({ "dynamicRegistration": false });
        }
        let mut params = json!({
            "processId": std::process::id(),
            "rootUri": if custom.is_some() { Value::Null } else { json!(root_uri) },
            "workspaceFolders": folders,
            "capabilities": {
                "textDocument": {
                    "hover": { "contentFormat": ["markdown", "plaintext"] },
                    "definition": {},
                    "completion": {
                        "completionItem": {
                            "snippetSupport": true,
                            "documentationFormat": ["markdown", "plaintext"],
                            "resolveSupport": { "properties": ["documentation", "detail"] }
                        }
                    },
                    "synchronization": { "dynamicRegistration": false },
                    "semanticTokens": {
                        "requests": { "full": true },
                        "tokenTypes": [
                            "namespace","type","class","enum","interface","struct","typeParameter","parameter",
                            "variable","property","enumMember","event","function","method","macro","keyword",
                            "modifier","comment","string","number","regexp","operator","decorator"
                        ],
                        "tokenModifiers": [
                            "declaration","definition","readonly","static","deprecated",
                            "abstract","async","modification","documentation","defaultLibrary"
                        ],
                        "formats": ["relative"]
                    }
                },
                "workspace": workspace,
                // 이걸 선언해야 clangd가 백그라운드 인덱싱 $/progress를 보낸다
                "window": { "workDoneProgress": true }
            }
        });
        if let Some(opts) = (self.spec.init_options)(&self.root) {
            params["initializationOptions"] = opts;
        }

        match self.rpc.request("initialize", params, INIT_TIMEOUT) {
            Ok(res) => {
                let caps = res.get("capabilities");
                let legend = caps
                    .and_then(|c| c.get("semanticTokensProvider"))
                    .and_then(|s| s.get("legend"));
                let types: Vec<String> = legend
                    .and_then(|l| l.get("tokenTypes"))
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
                    .unwrap_or_default();
                let mods: Vec<String> = legend
                    .and_then(|l| l.get("tokenModifiers"))
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
                    .unwrap_or_default();
                let cp = caps.and_then(|c| c.get("completionProvider"));
                let sync = caps.and_then(|c| c.get("textDocumentSync"));
                let sync_kind = sync
                    .and_then(Value::as_i64)
                    .or_else(|| sync.and_then(|s| s.get("change")).and_then(Value::as_i64))
                    .unwrap_or(1);
                {
                    let mut st = self.state.lock().unwrap();
                    st.caps.has_semantic = !types.is_empty();
                    st.caps.sem_types = types;
                    st.caps.sem_mods = mods;
                    st.caps.compl_triggers = cp.map(|c| {
                        c.get("triggerCharacters")
                            .and_then(Value::as_array)
                            .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
                            .unwrap_or_default()
                    });
                    st.caps.compl_resolve = cp
                        .and_then(|c| c.get("resolveProvider"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    st.caps.sync_kind = sync_kind;
                }
                self.rpc.notify("initialized", json!({}));
                if let Some(f) = self.spec.after_initialized {
                    let opened = f(&self.rpc, &self.root);
                    if !opened {
                        // 열 것이 없었다 — 기다릴 로드가 없으니 게이트를 바로 내린다
                        self.state.lock().unwrap().project_init_pending = false;
                    }
                }
                self.state.lock().unwrap().status = Status::Ready;
                self.ready_cv.notify_all();
                self.watch_membership();
            }
            Err(e) => {
                let tail = self.stderr_tail.lock().unwrap().clone();
                let mut st = self.state.lock().unwrap();
                st.status = Status::Error;
                st.err = Some(if tail.trim().is_empty() { e } else { format!("{e} · stderr: {}", tail.trim()) });
                drop(st);
                self.ready_cv.notify_all();
                // 초기화에 실패/행 한 서버는 영원히 남는다 — 접어서 쿨다운 재스폰이 깨끗하게
                self.shutdown("초기화 실패");
            }
        }
    }

    pub fn touch(&self) {
        self.last_used_ms.store(now_ms(), Ordering::Relaxed);
    }
    pub fn idle_ms(&self) -> u64 {
        now_ms().saturating_sub(self.last_used_ms.load(Ordering::Relaxed))
    }

    /// 렌더러가 보는 상태. `awaits_project_init` 서버는 인덱스가 끝나기 전까지 `starting`.
    pub fn status(&self) -> Status {
        let (st, pending) = {
            let s = self.state.lock().unwrap();
            (s.status, s.project_init_pending)
        };
        if st == Status::Ready {
            if self.is_dead() {
                return Status::Error;
            }
            if pending {
                return Status::Starting;
            }
        }
        st
    }

    /// 프로젝트 로드 게이트를 뺀 **원시** 상태 — 수명 판정(스윕·쿨다운)이 쓴다.
    ///
    /// ★ 크리틱 C-1: stdout EOF/파이프 에러로 rpc가 dispose된 서버는 **살아 있는 척하면
    /// 안 된다.** R1에는 `Ready → Error`로 가는 경로가 `initialize` 실패밖에 없어서,
    /// 밖에서 죽인 tsserver가 45초 내내 `ready`를 보고했고 좀비 스윕에도 안 걸렸다
    /// (2.6.2는 child `exit` 훅에서 `status='error' + diedAt`을 찍어 30초 뒤 재스폰한다 —
    /// manager.ts:2632). 여기서 rpc의 사망을 상태에 반영하면 그 두 경로가 함께 산다.
    pub fn raw_status(&self) -> Status {
        let st = self.state.lock().unwrap().status;
        if st == Status::Ready && self.is_dead() {
            Status::Error
        } else {
            st
        }
    }

    /// 자식과의 파이프가 끊겼는가(= 프로세스가 죽었거나 우리가 접었다).
    pub fn is_dead(&self) -> bool {
        self.rpc.is_dead()
    }
    pub fn progress_pct(&self) -> Option<f64> {
        self.state.lock().unwrap().progress_pct
    }
    pub fn error(&self) -> Option<String> {
        self.state.lock().unwrap().err.clone()
    }

    /// `Ready`가 될 때까지 기다린다(에러/사망이면 즉시 false).
    pub fn wait_ready(&self, timeout: Duration) -> bool {
        if self.is_dead() {
            return false; // 죽은 서버를 상대로 1.5초를 버리지 않는다(C-1)
        }
        let deadline = std::time::Instant::now() + timeout;
        let mut st = self.state.lock().unwrap();
        loop {
            match st.status {
                Status::Ready => return !self.is_dead(),
                Status::Error => return false,
                Status::Starting => {}
            }
            let now = std::time::Instant::now();
            if now >= deadline {
                return false;
            }
            let (g, _) = self.ready_cv.wait_timeout(st, deadline - now).unwrap();
            st = g;
        }
    }

    pub fn shutdown(&self, _why: &str) {
        self.rpc.dispose(_why);
        let mut c = self.child.lock().unwrap();
        if let Some(child) = c.as_mut() {
            // **트리째** 죽인다 — node가 tsserver를 자식으로 띄우므로 부모만 죽이면
            // 손자가 살아남아 좀비가 된다(2.6.2 killTree와 같은 이유).
            kill_tree(child.id());
            let _ = child.kill();
            let _ = child.wait();
        }
        *c = None;
    }

    // ── 문서 동기화 ──────────────────────────────────────────────────────────

    /// 디스크 내용으로 문서를 연다/맞춘다. **불변식 ①** — 판정·기록·통지가 한 임계 구역.
    pub fn open_doc(&self, abs: &Path) -> Result<String, String> {
        let uri = path_to_uri(abs);
        let md = std::fs::metadata(abs).map_err(|e| e.to_string())?;
        let mtime_ms = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let size = md.len();
        // 잠금 밖에서 먼저 빠른 검사 — 대부분의 호출(호버 연타)은 여기서 끝난다
        {
            let docs = self.docs.lock().unwrap();
            if let Some(d) = docs.map.get(&uri) {
                if d.mtime_ms == mtime_ms && d.size == size {
                    return Ok(uri);
                }
            }
        }
        let text = std::fs::read_to_string(abs).map_err(|e| e.to_string())?;
        self.sync_locked(&uri, abs, text, mtime_ms, size)
    }

    /// 데우기 전용 — **이미 열려 있으면 아무것도 안 한다.**
    /// `status` 폴링이 부르는 자리라, `open_doc`을 쓰면 저장 안 된 편집 버퍼를 디스크
    /// 내용으로 400ms마다 되엎는다(크리틱 C-2 후단의 "왕복으로 뒤집힌다").
    pub fn warm_doc(&self, abs: &Path) -> Result<String, String> {
        let uri = path_to_uri(abs);
        if self.docs.lock().unwrap().map.contains_key(&uri) {
            return Ok(uri);
        }
        self.open_doc(abs)
    }

    /// 라이브 편집 버퍼를 밀어 넣는다(완성 — 저장 안 된 내용과 부분 단어를 서버가 봐야 한다).
    /// 디스크 추적자를 무효로(-1) 찍어 다음 `open_doc`이 반드시 재검사하게 한다.
    pub fn sync_buffer(&self, abs: &Path, text: String) -> Result<String, String> {
        let uri = path_to_uri(abs);
        self.sync_locked(&uri, abs, text, -1, u64::MAX)
    }

    fn sync_locked(&self, uri: &str, abs: &Path, text: String, mtime_ms: i64, size: u64) -> Result<String, String> {
        let sync_kind = self.state.lock().unwrap().caps.sync_kind;
        let mut docs = self.docs.lock().unwrap();
        // 이 동기화 **전에** 이 문서가 라이브 버퍼(-1)였는가 — 재프라임 판정이 이걸 본다(아래).
        let was_live_buffer = docs.map.get(uri).map(|d| d.mtime_ms == -1).unwrap_or(false);
        let (notify_open, notify_change, evicted) = match docs.map.get_mut(uri) {
            None => {
                docs.map.insert(
                    uri.to_string(),
                    DocState { version: 1, mtime_ms, size, text: text.clone() },
                );
                docs.order.push(uri.to_string());
                let evicted = if docs.order.len() > MAX_OPEN_DOCS {
                    let old = docs.order.remove(0);
                    if old != uri {
                        docs.map.remove(&old);
                        Some(old)
                    } else {
                        docs.order.push(old);
                        None
                    }
                } else {
                    None
                };
                (true, None, evicted)
            }
            Some(cur) => {
                if cur.text == text {
                    // 내용이 같다 — 통지 없이 추적자만 최신으로(mtime만 바뀐 경우 포함)
                    cur.mtime_ms = mtime_ms;
                    cur.size = size;
                    return Ok(uri.to_string());
                }
                let prev = std::mem::replace(&mut cur.text, text.clone());
                cur.version += 1;
                cur.mtime_ms = mtime_ms;
                cur.size = size;
                (false, Some((cur.version, prev)), None)
            }
        };
        // 통지는 임계 구역 안에서 — 순서가 뒤집히면 서버의 문서 버전이 어긋난다
        if let Some(old) = evicted {
            self.rpc.notify("textDocument/didClose", json!({ "textDocument": { "uri": old } }));
        }
        if notify_open {
            // 프라임의 최소 오픈 갭(규약 ①)은 **이 시각**부터 잰다
            self.last_open_ms.store(now_ms(), Ordering::Relaxed);
            let lang = abs
                .extension()
                .and_then(|s| s.to_str())
                .and_then(|e| self.spec.language_id(e))
                .unwrap_or(self.spec.exts[0].1);
            self.rpc.notify(
                "textDocument/didOpen",
                json!({ "textDocument": { "uri": uri, "languageId": lang, "version": 1, "text": text } }),
            );
        } else if let Some((version, prev)) = notify_change {
            self.rpc.notify(
                "textDocument/didChange",
                json!({
                    "textDocument": { "uri": uri, "version": version },
                    "contentChanges": content_changes(sync_kind, &prev, &text)
                }),
            );
        }
        drop(docs);
        // 컴파일 입력이 **디스크에서** 바뀌었다 — 재프라임 스펙이 있으면 예약한다.
        //
        // 두 갈래를 뺀다(2.6.2 manager.ts:3098과 같은 조건):
        //   `mtime_ms == -1`      = 지금 밀어 넣은 게 라이브 편집 버퍼다(타이핑 중)
        //   `was_live_buffer`     = **직전이** 라이브 버퍼였다 = 이 재동기화는 그 버퍼를
        //                           디스크 내용으로 되돌리는 것뿐이다
        //
        // 두 번째를 빠뜨리면(R3 실측) 완성을 한 번 쓴 뒤의 첫 디스크 재동기화가 매번
        // 재프라임을 걸고, 그 다음 토큰 요청이 조용 간격(3초)만큼 통째로 세워진다 —
        // C# 재정확화가 2.6.2의 323ms 대 **3,285ms**로 벌어졌던 자리가 정확히 이것이다.
        if !notify_open
            && mtime_ms != -1
            && !was_live_buffer
            && matches!(self.spec.reprime, Reprime::WorkspaceSymbol { .. })
        {
            self.mark_prime_dirty();
        }
        Ok(uri.to_string())
    }

    pub fn doc_text(&self, uri: &str) -> Option<String> {
        self.docs.lock().unwrap().map.get(uri).map(|d| d.text.clone())
    }

    /// 프로젝트 입력이 바뀌었다 — 다음 요청이 **재프라임**하게 만든다.
    /// 세대를 올려 "프라임 도중에 온 변화"를 왕복 뒤에 알아볼 수 있게 한다(규약 ③).
    pub fn mark_prime_dirty(&self) {
        let mut p = self.prime.lock().unwrap();
        p.dirty_gen = p.dirty_gen.wrapping_add(1);
        p.dirty_at_ms = now_ms();
        p.done = false;
    }

    /// 전 솔루션 시맨틱 프라임 — 스펙이 요구할 때만.
    ///
    /// 2.6.2 `primeFullSemantics`(manager.ts:2958)의 규약 **다섯 개**를 전부 지킨다.
    /// R1은 이 중 조용 간격 하나만 있었다(크리틱 C-6):
    ///
    /// | # | 규약 | 여기 |
    /// |---|---|---|
    /// | ① | `didOpen` 뒤 **최소 1.5초**(실측: 갭 0ms=실패) | `PRIME_MIN_OPEN_GAP_MS` |
    /// | ② | 마지막 변화로부터 조용 간격 · **기다리는 동안 또 바뀌면 다시 기다린다** | 아래 대기 루프 |
    /// | ③ | 프라임 **도중** 변화가 오면 확정하지 않는다(다음 요청이 재프라임) | `dirty_gen` 대조 |
    /// | ④ | 히트 0짜리 쿼리로 페이로드만 아낀다 | `PRIME_QUERY` |
    /// | ⑤ | 동시 요청은 **한 번**만 프라임(2.6.2의 프라미스 공유) | `running` + condvar |
    fn prime_if_needed(&self) {
        let Reprime::WorkspaceSymbol { quiet_gap_ms } = self.spec.reprime else { return };
        // ⑤ 이미 끝났으면 그냥 통과, 누가 돌고 있으면 그 끝을 기다린다(스탬피드 방지).
        {
            let mut p = self.prime.lock().unwrap();
            loop {
                if p.done {
                    return;
                }
                if !p.running {
                    break;
                }
                let (g, t) = self.prime_cv.wait_timeout(p, PRIME_TIMEOUT).unwrap();
                p = g;
                if t.timed_out() {
                    return; // 앞선 프라임이 아직 안 끝났다 — 이 요청은 그냥 진행한다
                }
            }
            p.running = true;
        }
        // ①② 최소 오픈 갭과 조용 간격을 **둘 다** 채운다. 자는 동안 또 바뀌면 남은
        //     시간이 다시 늘어나 한 번 더 잔다(에이전트의 연속 편집을 한 프라임으로 합침).
        loop {
            let now = now_ms();
            let open_left = PRIME_MIN_OPEN_GAP_MS
                .saturating_sub(now.saturating_sub(self.last_open_ms.load(Ordering::Relaxed)));
            let dirty_at = self.prime.lock().unwrap().dirty_at_ms;
            let quiet_left =
                if dirty_at > 0 { quiet_gap_ms.saturating_sub(now.saturating_sub(dirty_at)) } else { 0 };
            let wait = open_left.max(quiet_left);
            if wait == 0 {
                break;
            }
            std::thread::sleep(Duration::from_millis(wait));
        }
        // ③ 왕복 **직전**의 세대를 들고 간다 — 돌아왔을 때 달라졌으면 낡은 프라임이다.
        let gen_before = self.prime.lock().unwrap().dirty_gen;
        let ok = self.rpc.request("workspace/symbol", json!({ "query": PRIME_QUERY }), PRIME_TIMEOUT).is_ok();
        {
            let mut p = self.prime.lock().unwrap();
            p.running = false;
            p.done = ok && p.dirty_gen == gen_before;
        }
        self.prime_cv.notify_all();
    }

    /// 프라임이 유효한 상태인가(테스트·진단).
    #[allow(dead_code)]
    pub fn primed(&self) -> bool {
        self.prime.lock().unwrap().done
    }

    // ── 멤버십 감시 ──────────────────────────────────────────────────────────
    /// 스펙이 댄 **멤버십 파일**(Roslyn: 로드한 sln/slnx·csproj)이 갈리는지 지켜본다.
    /// 갈리면 스펙의 [`ServerSpec::reload_project`]가 서버에 다시 알리고, 엔진은 재프라임만
    /// 예약한다 — **여기에도 언어 이름이 없다.**
    ///
    /// 2.6.2는 `fs.watch(솔루션 폴더) + 2초 디바운스`(watchCsSolution)였다. 여기서는 폴링인데
    /// 이유가 있다: 재생성은 삭제→생성으로 이벤트가 여러 번 튀고 Windows의 파일 핸들 워치는
    /// 그 사이에 끊긴다(2.6.2가 파일이 아니라 폴더를 감시한 이유). "한 주기 조용해진 뒤 한 번"은
    /// 폴링으로 공짜로 얻고, 비용은 서버당 2초에 stat 한두 번이다.
    fn watch_membership(self: &Arc<Self>) {
        let Some(reload) = self.spec.reload_project else { return };
        let weak = Arc::downgrade(self);
        std::thread::Builder::new()
            .name("ccg-lsp-membership".into())
            .spawn(move || {
                let mut seen: Option<String> = None;
                let mut pending: Option<String> = None;
                loop {
                    std::thread::sleep(MEMBERSHIP_POLL);
                    // 서버가 접혔으면(유휴 회수·종료) 이 스레드도 끝난다
                    let Some(s) = weak.upgrade() else { return };
                    if s.is_dead() {
                        return;
                    }
                    let now = membership_stamp(&(s.spec.membership_files)(&s.root));
                    let fire = membership_step(&mut seen, &mut pending, now);
                    if fire && s.raw_status() == Status::Ready && reload(&s.rpc, &s.root) {
                        s.mark_prime_dirty();
                    }
                }
            })
            .ok();
    }

    // ── 외부 파일 변화(앱을 거친 쓰기) ───────────────────────────────────────
    /// 2.6.2 `notifyWatchedFiles`(manager.ts:2337)가 **한 서버에** 하던 네 가지를 그대로:
    /// ① 재프라임 예약 ② 열린 문서의 디스크 재동기화 ③ 삭제 문서 `didClose`
    /// ④ `workspace/didChangeWatchedFiles` 통지.
    ///
    /// ②가 없으면 "낡은 열린 사본"으로 컴파일이 확정돼, 그 파일의 새 타입을 참조하는
    /// 다른 문서가 재프라임·재폴링을 다 해도 영영 무색으로 남는다(2.6.2 실측 주석).
    pub fn files_changed(&self, paths: &[PathBuf]) {
        if paths.is_empty() {
            return;
        }
        // ① 재프라임 예약 — 조용 간격의 기준점이 여기서 갱신된다
        if matches!(self.spec.reprime, Reprime::WorkspaceSymbol { .. }) {
            self.mark_prime_dirty();
        }
        // ②③ 열린 문서만 손댄다. `docs` 잠금은 목록을 뜨는 동안만 쥔다 —
        //     open_doc/close_doc이 그 잠금을 다시 잡기 때문이다.
        let open: Vec<String> = self.docs.lock().unwrap().order.clone();
        let mut changes: Vec<Value> = Vec::with_capacity(paths.len());
        for p in paths {
            let uri = path_to_uri(p);
            let exists = p.exists();
            changes.push(json!({ "uri": uri, "type": if exists { 2 } else { 3 } }));
            // URI 대조는 대소문자 무시 — 통지 경로와 열람 경로의 케이싱이 다를 수 있다
            let lower = uri.to_ascii_lowercase();
            let Some(known) = open.iter().find(|u| u.to_ascii_lowercase() == lower) else { continue };
            if exists {
                let _ = self.open_doc(p); // mtime/size가 바뀌었으면 didChange가 나간다
            } else {
                self.close_doc(known); // 유령 문서가 컴파일에 남지 않게
            }
        }
        // ④ 통지는 `declare_watched_files`와 무관하게 **항상** 보낸다 — 2.6.2와 같은
        //   "pyright류를 위한 최선 노력"(선언은 서버의 폴백 워처를 끄는 스위치일 뿐이다).
        self.rpc.notify("workspace/didChangeWatchedFiles", json!({ "changes": changes }));
        // ⑤ 멤버십 파일(솔루션·프로젝트 파일)이 이 배치에 있으면 스펙에 재통지를 맡긴다 —
        //   앱을 거친 변화의 짝(밖에서 일어난 재생성은 `watch_membership` 폴러가 잡는다).
        self.reload_if_membership(paths);
    }

    /// 바뀐 경로에 멤버십 파일이 섞여 있으면 스펙의 재통지를 부르고 재프라임을 예약한다.
    fn reload_if_membership(&self, paths: &[PathBuf]) {
        let Some(reload) = self.spec.reload_project else { return };
        let mem = (self.spec.membership_files)(&self.root);
        let hit = paths.iter().any(|p| {
            let a = p.to_string_lossy().to_ascii_lowercase();
            mem.iter().any(|m| m.to_string_lossy().to_ascii_lowercase() == a)
        });
        if hit && reload(&self.rpc, &self.root) {
            self.mark_prime_dirty();
        }
    }

    /// 열린 문서 하나를 닫는다(삭제·축출). 서버 문서 맵과 우리 맵을 함께 지운다.
    fn close_doc(&self, uri: &str) {
        {
            let mut docs = self.docs.lock().unwrap();
            if docs.map.remove(uri).is_none() {
                return;
            }
            docs.order.retain(|u| u != uri);
        }
        self.rpc.notify("textDocument/didClose", json!({ "textDocument": { "uri": uri } }));
    }

    // ── 기능 ────────────────────────────────────────────────────────────────

    pub fn semantic_tokens(&self, abs: &Path) -> Option<SemanticTokens> {
        let (types, mods, has) = {
            let st = self.state.lock().unwrap();
            (st.caps.sem_types.clone(), st.caps.sem_mods.clone(), st.caps.has_semantic)
        };
        if !has {
            return None; // 이 서버는 시맨틱 토큰 자체가 없다 → 렌더러가 폴링을 멈춘다
        }
        let uri = self.open_doc(abs).ok()?;
        self.prime_if_needed();
        let r = self
            .rpc
            .request(
                "textDocument/semanticTokens/full",
                json!({ "textDocument": { "uri": uri } }),
                Duration::from_secs(30),
            )
            .ok();
        let raw = r
            .as_ref()
            .and_then(|v| v.get("data"))
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_u64).map(|n| n as u32).collect::<Vec<u32>>())
            .unwrap_or_default();
        if raw.is_empty() {
            // "지원하지만 아직 없음"(인덱싱 중) — None은 "지원 안 함"에만 쓴다
            return Some(SemanticTokens { data: Vec::new(), types, mods });
        }
        Some(SemanticTokens { data: absolutize(&raw), types, mods })
    }

    /// 문서를 서버와 맞춘다 — **저장 안 된 편집 버퍼(`text`)가 있으면 그것이 진실**이다.
    /// (2.6.2 manager.ts:1994 `text != null ? syncBuffer(...) : openDoc(...)`와 같은 한 줄 분기)
    fn sync_for_query(&self, abs: &Path, text: Option<&str>) -> Result<String, String> {
        match text {
            Some(t) => self.sync_buffer(abs, t.to_string()),
            None => self.open_doc(abs),
        }
    }

    pub fn hover(&self, abs: &Path, line: u32, character: u32, text: Option<&str>) -> Option<String> {
        let uri = self.sync_for_query(abs, text).ok()?;
        let r = self
            .rpc
            .request(
                "textDocument/hover",
                json!({ "textDocument": { "uri": uri }, "position": { "line": line, "character": character } }),
                Duration::from_secs(15),
            )
            .ok()?;
        let md = hover_markdown(r.get("contents").unwrap_or(&Value::Null));
        (!md.trim().is_empty()).then_some(md)
    }

    pub fn definition(&self, abs: &Path, line: u32, character: u32, text: Option<&str>) -> Vec<(PathBuf, u32, u32)> {
        let Ok(uri) = self.sync_for_query(abs, text) else { return Vec::new() };
        let Ok(r) = self.rpc.request(
            "textDocument/definition",
            json!({ "textDocument": { "uri": uri }, "position": { "line": line, "character": character } }),
            Duration::from_secs(15),
        ) else {
            return Vec::new();
        };
        let arr: Vec<&Value> = match &r {
            Value::Array(a) => a.iter().collect(),
            Value::Null => Vec::new(),
            v => vec![v],
        };
        arr.iter().filter_map(|v| location_of(v)).collect()
    }

    /// 완성 — **라이브 버퍼**를 먼저 밀어 넣는다(저장 안 된 편집·부분 단어).
    pub fn completion(&self, abs: &Path, line: u32, character: u32, text: String) -> Option<(Vec<Value>, bool, i64)> {
        {
            let st = self.state.lock().unwrap();
            st.caps.compl_triggers.as_ref()?; // 완성 자체가 없는 서버 — 왕복하지 않는다
        }
        let uri = self.sync_buffer(abs, text).ok()?;
        let r = self
            .rpc
            .request(
                "textDocument/completion",
                json!({ "textDocument": { "uri": uri }, "position": { "line": line, "character": character } }),
                Duration::from_secs(15),
            )
            .ok()?;
        let (items, incomplete) = match &r {
            Value::Array(a) => (a.clone(), false),
            Value::Object(o) => (
                o.get("items").and_then(Value::as_array).cloned().unwrap_or_default(),
                o.get("isIncomplete").and_then(Value::as_bool).unwrap_or(false),
            ),
            _ => (Vec::new(), false),
        };
        if items.is_empty() {
            return None;
        }
        let mut c = self.compl.lock().unwrap();
        c.gen += 1;
        c.items = items.clone();
        Some((items, incomplete, c.gen))
    }

    /// 후보 문서 지연 로드 — 원본 아이템을 그대로 되돌려보내야 서버가 알아본다.
    pub fn resolve_completion(&self, gen: i64, ri: usize) -> Option<Value> {
        let raw = {
            let c = self.compl.lock().unwrap();
            if c.gen != gen {
                return None; // 낡은 목록의 resolve — 버린다
            }
            if !self.state.lock().unwrap().caps.compl_resolve {
                return None;
            }
            c.items.get(ri)?.clone()
        };
        self.rpc.request("completionItem/resolve", raw, Duration::from_secs(10)).ok()
    }
}

// ── 순수 함수(테스트 가능) ───────────────────────────────────────────────────

/// 멤버십 폴러의 **판정 한 걸음**(순수 함수 — 스레드 없이 시험할 수 있게 뺐다).
///
/// 규칙: 지문이 갈리면 **한 주기 더 같은 값으로 조용해진 뒤에** 딱 한 번 `true`.
/// 재생성은 삭제 → 생성으로 지문이 두세 번 튀는데, 그 중간(파일 없음) 상태로 재통지하면
/// 서버가 빈 솔루션을 로드해 버린다(2.6.2가 `fs.watch`에 2초 디바운스를 건 이유).
pub fn membership_step(seen: &mut Option<String>, pending: &mut Option<String>, now: String) -> bool {
    let Some(prev) = seen.clone() else {
        *seen = Some(now);
        return false; // 첫 관측 — 기준선만 잡는다
    };
    if now == prev {
        *pending = None;
        return false;
    }
    if pending.as_deref() != Some(now.as_str()) {
        *pending = Some(now); // 갈렸다 — 아직 흔들리는 중일 수 있다
        return false;
    }
    *seen = Some(now);
    *pending = None;
    true
}

/// 멤버십 파일 묶음의 지문 — 경로·mtime·크기. **목록 자체가 바뀌어도**(새 csproj 생성,
/// `.sln` → `.slnx` 교체) 지문이 달라지므로 "재생성"과 "추가"를 한 판정으로 잡는다.
/// 없는 파일은 `-`로 남긴다 — 삭제 → 재생성 사이의 순간도 변화로 센다.
pub fn membership_stamp(files: &[PathBuf]) -> String {
    let mut out = String::new();
    for f in files {
        out.push_str(&f.to_string_lossy().to_ascii_lowercase());
        match std::fs::metadata(f) {
            Ok(md) => {
                let t = md
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis())
                    .unwrap_or(0);
                out.push_str(&format!("|{t}|{}", md.len()));
            }
            Err(_) => out.push_str("|-"),
        }
        out.push(';');
    }
    out
}

/// `didChange`의 contentChanges. **불변식 ②** — incremental(2) 서버에는 range를 반드시 싣는다.
/// 최소 range(공통 prefix/suffix 절단)로 만들어 페이로드와 서버 재파싱을 편집 조각 크기로 줄인다.
pub fn content_changes(sync_kind: i64, prev: &str, next: &str) -> Value {
    if sync_kind != 2 {
        return json!([{ "text": next }]);
    }
    let c = minimal_range_change(prev, next);
    json!([{ "range": { "start": { "line": c.0 .0, "character": c.0 .1 }, "end": { "line": c.1 .0, "character": c.1 .1 } }, "text": c.2 }])
}

/// prev → next로 가는 최소 range 교체. 좌표는 **prev 기준**, UTF-16 코드 유닛.
/// (LSP position은 UTF-16 기준이다 — Rust의 char/byte 인덱스를 그대로 쓰면 비-ASCII에서 어긋난다)
pub fn minimal_range_change(prev: &str, next: &str) -> ((u32, u32), (u32, u32), String) {
    let p: Vec<u16> = prev.encode_utf16().collect();
    let n: Vec<u16> = next.encode_utf16().collect();
    let max = p.len().min(n.len());
    let mut a = 0usize;
    while a < max && p[a] == n[a] {
        a += 1;
    }
    let max_b = max - a;
    let mut b = 0usize;
    while b < max_b && p[p.len() - 1 - b] == n[n.len() - 1 - b] {
        b += 1;
    }
    // 서러게이트 쌍을 가르지 않게 한 칸 물린다
    let splits = |s: &[u16], i: usize| i > 0 && i < s.len() && (s[i - 1] & 0xfc00) == 0xd800 && (s[i] & 0xfc00) == 0xdc00;
    while a > 0 && (splits(&p, a) || splits(&n, a)) {
        a -= 1;
    }
    while b > 0 && (splits(&p, p.len() - b) || splits(&n, n.len() - b)) {
        b -= 1;
    }
    let start = pos_at(&p, a);
    let end = pos_at(&p, p.len() - b);
    let text = String::from_utf16_lossy(&n[a..n.len() - b]);
    (start, end, text)
}

/// UTF-16 오프셋 → LSP `{line, character}`
fn pos_at(s: &[u16], offset: usize) -> (u32, u32) {
    let nl = '\n' as u16;
    let mut line = 0u32;
    let mut line_start = 0usize;
    for (i, c) in s.iter().enumerate().take(offset) {
        if *c == nl {
            line += 1;
            line_start = i + 1;
        }
    }
    (line, (offset - line_start) as u32)
}

/// LSP 상대 좌표 5튜플 → 절대 좌표 5튜플 (렌더러가 기대하는 모양)
pub fn absolutize(raw: &[u32]) -> Vec<u32> {
    let mut out = Vec::with_capacity(raw.len());
    let mut line = 0u32;
    let mut ch = 0u32;
    let mut i = 0;
    while i + 4 < raw.len() {
        let d_line = raw[i];
        line = line.wrapping_add(d_line);
        ch = if d_line == 0 { ch.wrapping_add(raw[i + 1]) } else { raw[i + 1] };
        out.extend_from_slice(&[line, ch, raw[i + 2], raw[i + 3], raw[i + 4]]);
        i += 5;
    }
    out
}

/// hover `contents`(string | {value,language} | 배열) → 마크다운 한 덩어리
pub fn hover_markdown(contents: &Value) -> String {
    fn one(c: &Value) -> String {
        match c {
            Value::String(s) => s.clone(),
            Value::Object(o) => {
                let Some(v) = o.get("value").and_then(Value::as_str) else { return String::new() };
                match o.get("language").and_then(Value::as_str) {
                    Some(l) => format!("```{l}\n{v}\n```"),
                    None => v.to_string(),
                }
            }
            _ => String::new(),
        }
    }
    let parts: Vec<String> = match contents {
        Value::Array(a) => a.iter().map(one).collect(),
        v => vec![one(v)],
    };
    parts.into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n\n").trim().to_string()
}

/// Location | LocationLink → (절대경로, line, character)
fn location_of(v: &Value) -> Option<(PathBuf, u32, u32)> {
    let uri = v
        .get("uri")
        .or_else(|| v.get("targetUri"))
        .and_then(Value::as_str)?;
    let range = v
        .get("range")
        .or_else(|| v.get("targetSelectionRange"))
        .or_else(|| v.get("targetRange"))?;
    let start = range.get("start")?;
    let line = start.get("line").and_then(Value::as_u64).unwrap_or(0) as u32;
    let character = start.get("character").and_then(Value::as_u64).unwrap_or(0) as u32;
    Some((uri_to_path(uri)?, line, character))
}

// ── 경로 ↔ URI ───────────────────────────────────────────────────────────────
pub fn path_to_uri(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    let mut out = String::from("file:///");
    for (i, ch) in s.chars().enumerate() {
        // 드라이브 문자 뒤의 ':'는 그대로(file:///C:/…) — Node의 pathToFileURL과 같은 모양
        match ch {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '.' | '_' | '~' | '/' => out.push(ch),
            ':' if i == 1 => out.push(':'),
            _ => {
                let mut buf = [0u8; 4];
                for b in ch.encode_utf8(&mut buf).as_bytes() {
                    out.push_str(&format!("%{b:02X}"));
                }
            }
        }
    }
    out
}

pub fn uri_to_path(uri: &str) -> Option<PathBuf> {
    let rest = uri.strip_prefix("file:///").or_else(|| uri.strip_prefix("file://"))?;
    let mut out = String::with_capacity(rest.len());
    let bytes = rest.as_bytes();
    let mut i = 0;
    let mut raw: Vec<u8> = Vec::with_capacity(rest.len());
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&rest[i + 1..i + 3], 16) {
                raw.push(b);
                i += 3;
                continue;
            }
        }
        raw.push(bytes[i]);
        i += 1;
    }
    out.push_str(&String::from_utf8_lossy(&raw));
    Some(PathBuf::from(out.replace('/', "\\")))
}

#[cfg(windows)]
fn kill_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(0x0800_0000)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}
#[cfg(not(windows))]
fn kill_tree(_pid: u32) {}

#[allow(dead_code)]
fn provision_note(p: Provision) -> &'static str {
    match p {
        Provision::Bundled => "bundled",
        Provision::Download => "download",
        Provision::External => "external",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absolutize_matches_lsp_relative_encoding() {
        // 두 토큰: (line 0, char 5, len 3) · (같은 줄, +4 → char 12, len 2)
        let raw = [0, 5, 3, 1, 0, 0, 7, 2, 2, 0];
        assert_eq!(absolutize(&raw), vec![0, 5, 3, 1, 0, 0, 12, 2, 2, 0]);
        // 줄이 바뀌면 character는 리셋된다
        let raw2 = [0, 5, 3, 1, 0, 2, 4, 1, 0, 0];
        assert_eq!(absolutize(&raw2), vec![0, 5, 3, 1, 0, 2, 4, 1, 0, 0]);
    }

    #[test]
    fn absolutize_ignores_trailing_partial_tuple() {
        assert_eq!(absolutize(&[0, 1, 2, 3]), Vec::<u32>::new());
    }

    #[test]
    fn hover_markdown_flattens_all_shapes() {
        assert_eq!(hover_markdown(&json!("plain")), "plain");
        assert_eq!(hover_markdown(&json!({ "value": "md" })), "md");
        assert_eq!(hover_markdown(&json!({ "language": "ts", "value": "x: number" })), "```ts\nx: number\n```");
        assert_eq!(hover_markdown(&json!(["a", { "value": "b" }])), "a\n\nb");
        assert_eq!(hover_markdown(&Value::Null), "");
    }

    #[test]
    fn full_sync_server_gets_no_range() {
        let v = content_changes(1, "abc", "abd");
        assert!(v[0].get("range").is_none(), "{v}");
        assert_eq!(v[0]["text"], "abd");
    }

    /// **불변식 ②** — incremental 서버에는 range가 반드시 실린다(없으면 Roslyn이 죽는다).
    #[test]
    fn incremental_server_always_gets_a_range() {
        let v = content_changes(2, "let a = 1\nlet b = 2\n", "let a = 1\nlet b = 3\n");
        let r = v[0].get("range").expect("range 없음 — Roslyn이 죽는 그 페이로드다");
        assert_eq!(r["start"]["line"], 1);
        assert_eq!(r["start"]["character"], 8);
        assert_eq!(v[0]["text"], "3");
    }

    #[test]
    fn minimal_change_handles_identical_and_append() {
        let (s, e, t) = minimal_range_change("abc", "abc");
        assert_eq!((s, e, t.as_str()), ((0, 3), (0, 3), ""));
        let (s, e, t) = minimal_range_change("abc", "abcd");
        assert_eq!((s, e, t.as_str()), ((0, 3), (0, 3), "d"));
        let (s, e, t) = minimal_range_change("abab", "ab");
        assert_eq!(t, "");
        assert_eq!(s, (0, 2));
        assert_eq!(e, (0, 4));
    }

    #[test]
    fn minimal_change_utf16_positions() {
        // 이모지(서러게이트 쌍) 뒤의 좌표는 UTF-16 유닛 기준이어야 한다
        let (s, _, t) = minimal_range_change("a😀b", "a😀c");
        assert_eq!(s, (0, 3), "이모지는 UTF-16 2유닛");
        assert_eq!(t, "c");
    }

    /// 멤버십 지문 — **목록이 바뀌어도**(새 csproj·`.sln`→`.slnx` 교체) 달라져야 한다.
    /// 이게 같으면 폴러가 재생성을 못 보고, 새 프로젝트의 모든 파일이 무색으로 굳는다.
    #[test]
    fn membership_stamp_sees_content_and_list_changes() {
        let dir = std::env::temp_dir().join("ccg-lsp-memstamp");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("A.slnx");
        std::fs::write(&a, "<Solution/>").unwrap();
        let s1 = membership_stamp(&[a.clone()]);
        assert_eq!(s1, membership_stamp(&[a.clone()]), "안 바뀌었는데 지문이 흔들리면 헛재통지가 돈다");
        // 내용이 바뀌면(크기 변화) 지문이 달라진다
        std::fs::write(&a, "<Solution><Project Path=\"x.csproj\" /></Solution>").unwrap();
        assert_ne!(s1, membership_stamp(&[a.clone()]));
        // 목록 자체가 갈려도 달라진다
        let b = dir.join("B.slnx");
        assert_ne!(membership_stamp(&[a.clone()]), membership_stamp(&[b.clone()]));
        // 없는 파일은 `-` — 삭제→재생성의 '중간'도 변화로 센다
        assert!(membership_stamp(&[b]).ends_with("|-;"));
        assert_eq!(membership_stamp(&[]), "");
    }

    /// 폴러의 디바운스 — **한 주기 조용해진 뒤 한 번만** 재통지한다.
    /// 흔들리는 동안 쏘면 삭제-후-재생성의 중간(빈/없는 솔루션)을 서버에 로드시킨다.
    #[test]
    fn membership_poller_fires_once_after_one_quiet_tick() {
        let (mut seen, mut pending) = (None, None);
        // 첫 관측 = 기준선. 같은 값이 이어지는 동안은 조용하다
        assert!(!membership_step(&mut seen, &mut pending, "A".into()));
        assert!(!membership_step(&mut seen, &mut pending, "A".into()));
        // 재생성 시작(A → B → C: 삭제·쓰기·교체로 튄다) — 흔들리는 동안은 안 쏜다
        assert!(!membership_step(&mut seen, &mut pending, "B".into()));
        assert!(!membership_step(&mut seen, &mut pending, "C".into()));
        // C로 조용해졌다 → 한 번 쏜다
        assert!(membership_step(&mut seen, &mut pending, "C".into()));
        // 그 뒤로는 다시 조용 — 같은 변화로 두 번 쏘지 않는다
        assert!(!membership_step(&mut seen, &mut pending, "C".into()));
        assert!(!membership_step(&mut seen, &mut pending, "C".into()));
    }

    /// 스펙 정합 — 재통지 훅이 있는 서버는 **감시할 파일을 실제로 댄다**(반대도).
    /// 짝이 깨지면 폴러가 빈 목록을 돌거나(무해하지만 죽은 코드), 갈린 걸 보고도 보낼 게 없다.
    #[test]
    fn reload_hook_and_membership_files_come_as_a_pair() {
        let dir = std::env::temp_dir().join("ccg-lsp-memberpair");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // 네 언어의 프로젝트 파일을 한 폴더에 다 깔아 둔다 — 스펙이 자기 것만 집어야 한다
        for n in ["tsconfig.json", "pyproject.toml", "A.csproj", "compile_commands.json"] {
            std::fs::write(dir.join(n), "x").unwrap();
        }
        for s in crate::spec::SPECS {
            let files = (s.membership_files)(&dir);
            assert_eq!(
                s.reload_project.is_some(),
                !files.is_empty(),
                "{}: 재통지 훅과 멤버십 파일은 짝이다 ({files:?})",
                s.id
            );
        }
        // 각자 자기 것만 집는다 — 섞이면 남의 파일 변화로 재통지가 돈다
        let cs = crate::spec::spec_by_id("cs").unwrap();
        assert_eq!((cs.membership_files)(&dir), vec![dir.join("A.csproj")]);
        let cpp = crate::spec::spec_by_id("cpp").unwrap();
        assert_eq!((cpp.membership_files)(&dir), vec![dir.join("compile_commands.json")]);
    }

    #[test]
    fn uri_roundtrip() {
        let p = PathBuf::from("C:\\Code\\a b\\big.ts");
        let u = path_to_uri(&p);
        assert_eq!(u, "file:///C:/Code/a%20b/big.ts");
        assert_eq!(uri_to_path(&u).unwrap(), p);
    }

    #[test]
    fn uri_roundtrip_non_ascii() {
        let p = PathBuf::from("C:\\코드\\big.ts");
        assert_eq!(uri_to_path(&path_to_uri(&p)).unwrap(), p);
    }

    #[test]
    fn definition_accepts_location_and_locationlink() {
        let loc = json!({ "uri": "file:///C:/x/lib.ts", "range": { "start": { "line": 3, "character": 7 } } });
        let link = json!({ "targetUri": "file:///C:/x/lib.ts", "targetSelectionRange": { "start": { "line": 3, "character": 7 } } });
        for v in [loc, link] {
            let (p, l, c) = location_of(&v).unwrap();
            assert_eq!(p, PathBuf::from("C:\\x\\lib.ts"));
            assert_eq!((l, c), (3, 7));
        }
    }
}
