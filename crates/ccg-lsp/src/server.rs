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
    /// 마지막으로 관측된 프로젝트 변화 시각(ms) — 재프라임의 조용 간격 기준.
    prime_dirty_ms: AtomicU64,
    /// 프라임을 이미 마쳤는가(변화가 오면 false로 되돌린다).
    primed: Mutex<bool>,
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
            let script = crate::launch::shipped_module(module)
                .ok_or_else(|| format!("번들 모듈을 못 찾음: node_modules/{}", module.join("/")))?;
            let node = crate::launch::node_exe().ok_or_else(|| {
                "Node 런타임을 못 찾음 (CCG_LSP_NODE · exe 옆 node.exe · PATH 순으로 찾는다)".to_string()
            })?;
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
        let rpc = Rpc::start(
            stdin,
            stdout,
            Box::new(move |method, params| {
                let w = hook_for_rpc.lock().unwrap().clone();
                if let Some(s) = w.and_then(|w| w.upgrade()) {
                    s.on_notify(method, params);
                }
            }),
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
            prime_dirty_ms: AtomicU64::new(0),
            primed: Mutex::new(false),
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
        let mut workspace = json!({ "workspaceFolders": true });
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
        let st = self.state.lock().unwrap();
        if st.status == Status::Ready && st.project_init_pending {
            Status::Starting
        } else {
            st.status
        }
    }
    pub fn raw_status(&self) -> Status {
        self.state.lock().unwrap().status
    }
    pub fn progress_pct(&self) -> Option<f64> {
        self.state.lock().unwrap().progress_pct
    }
    pub fn error(&self) -> Option<String> {
        self.state.lock().unwrap().err.clone()
    }

    /// `Ready`가 될 때까지 기다린다(에러면 즉시 false).
    pub fn wait_ready(&self, timeout: Duration) -> bool {
        let deadline = std::time::Instant::now() + timeout;
        let mut st = self.state.lock().unwrap();
        loop {
            match st.status {
                Status::Ready => return true,
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

    /// 라이브 편집 버퍼를 밀어 넣는다(완성 — 저장 안 된 내용과 부분 단어를 서버가 봐야 한다).
    /// 디스크 추적자를 무효로(-1) 찍어 다음 `open_doc`이 반드시 재검사하게 한다.
    pub fn sync_buffer(&self, abs: &Path, text: String) -> Result<String, String> {
        let uri = path_to_uri(abs);
        self.sync_locked(&uri, abs, text, -1, u64::MAX)
    }

    fn sync_locked(&self, uri: &str, abs: &Path, text: String, mtime_ms: i64, size: u64) -> Result<String, String> {
        let sync_kind = self.state.lock().unwrap().caps.sync_kind;
        let mut docs = self.docs.lock().unwrap();
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
        // 컴파일 입력이 실제로 바뀌었다 — 재프라임 스펙이 있으면 예약한다
        if !notify_open && mtime_ms != -1 && matches!(self.spec.reprime, Reprime::WorkspaceSymbol { .. }) {
            self.mark_prime_dirty();
        }
        Ok(uri.to_string())
    }

    pub fn doc_text(&self, uri: &str) -> Option<String> {
        self.docs.lock().unwrap().map.get(uri).map(|d| d.text.clone())
    }

    pub fn mark_prime_dirty(&self) {
        self.prime_dirty_ms.store(now_ms(), Ordering::Relaxed);
        *self.primed.lock().unwrap() = false;
    }

    /// 전 솔루션 시맨틱 프라임 — 스펙이 요구할 때만, 그리고 **조용 간격을 채운 뒤에만**.
    fn prime_if_needed(&self) {
        let Reprime::WorkspaceSymbol { quiet_gap_ms } = self.spec.reprime else { return };
        {
            if *self.primed.lock().unwrap() {
                return;
            }
        }
        // 마지막 변화로부터 조용 간격을 보장 — 그 전 프라임은 "새 파일이 빠진 컴파일"을
        // 완료로 확정하는 헛프라임이다(2.6.2 실측).
        let dirty = self.prime_dirty_ms.load(Ordering::Relaxed);
        if dirty > 0 {
            let waited = now_ms().saturating_sub(dirty);
            if waited < quiet_gap_ms {
                std::thread::sleep(Duration::from_millis(quiet_gap_ms - waited));
            }
        }
        let _ = self.rpc.request("workspace/symbol", json!({ "query": "" }), Duration::from_secs(60));
        *self.primed.lock().unwrap() = true;
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

    pub fn hover(&self, abs: &Path, line: u32, character: u32) -> Option<String> {
        let uri = self.open_doc(abs).ok()?;
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

    pub fn definition(&self, abs: &Path, line: u32, character: u32) -> Vec<(PathBuf, u32, u32)> {
        let Ok(uri) = self.open_doc(abs) else { return Vec::new() };
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
