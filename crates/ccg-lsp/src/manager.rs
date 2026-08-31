//! 서버 레지스트리 — (스펙 id, 루트)마다 인스턴스 하나. 지연 스폰 · 유휴 회수 · 좀비 안전망.
//!
//! 2.6.2가 실측으로 세운 수명 규약을 그대로 옮긴다:
//!  - **지연 스폰**: 파일을 물었을 때 그 프로젝트의 서버를 띄운다. 프리웜은 그걸 앞당길 뿐.
//!  - **유휴 회수**: 마지막 사용에서 TTL(bundled 10분 / 무거운 서버 30분)이 지나면 프로세스째
//!    접는다. 회수가 없으면 폴더 수만큼 무한 누적된다(2.6.2 실측: 이틀 상주에 tsserver 세트
//!    6개 3GB+). 접어도 다음 요청이 도로 스폰하고, **토큰 디스크 캐시 + 프리웜** 덕에 복귀가
//!    싸다 — 그래서 회수가 체감 손해가 아니다.
//!  - **재스폰 쿨다운 30초**: 망가진 설치가 스폰 루프를 돌지 않게.
//!  - **좀비 안전망**: 자식이 이미 죽었는데 핸들만 남은 항목을 스윕이 걷어낸다.
//!
//! 테스트 주입: `CCG_LSP_IDLE_TTL_MS`(TTL 덮어쓰기) · `CCG_LSP_SWEEP_MS`(스윕 주기).
//! 기본값은 스펙/2.6.2 그대로 — 벤치가 10분을 기다리지 않고 회수를 실증하기 위한 문이다.

use crate::server::{now_ms, Server, Status};
use crate::spec::{root_for, ServerSpec};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// 죽은/실패한 서버는 이만큼 지나야 다시 띄운다(2.6.2 RESPAWN_COOLDOWN).
/// 밖에서 죽인 서버의 **자동 복귀 시간**이기도 하다 — 2.6.2 실측 30.6초와 같은 자리.
const RESPAWN_COOLDOWN_MS: u64 = 30_000;
const SWEEP_EVERY_MS_DEFAULT: u64 = 60_000;

/// ★LSPIDLE R1 — **절대 상한.** 어떤 유예도 이 나이를 넘겨 서버를 살려 두지 못한다.
///
/// [`Server::indexing`]이 도입한 되감기가 여는 구멍을 여기서 닫는다: 진행률 `end`를 영영
/// 안 보내는 서버(clangd가 실제로 그런다 — `project_state`가 그 때문에 진행률이 흐르는 동안을
/// 따로 다룬다)는 `indexing()`이 계속 참이라 타이머가 무한히 되감긴다. 그러면 이 라운드가
/// 고치려던 «항상 산다»를 다른 문으로 되살리는 셈이다.
///
/// 값은 2.6.2의 무거운 서버 TTL과 같은 30분이다 — 「그만큼 조용했으면 접는다」의 파리티.
/// 스펙의 `idle_ttl_ms`가 이보다 길면 그쪽을 존중한다(상한은 **유예**의 상한이지
/// 스펙의 상한이 아니다).
const IDLE_GRACE_CAP_MS: u64 = 30 * 60_000;

/// 원장에 남은 자식이 이 나이를 넘겼는데 주인이 없으면 걷는다([`crate::zombie::sweep`]).
/// 2.6.2 엔진 좀비 안전망과 같은 눈금.
const ZOMBIE_MAX_AGE_MS: u64 = 30 * 60_000;
/// 기능 호출이 "스폰이 끝나기"를 기다리는 상한. `status`는 이걸 **안 기다린다**(아래 `start`).
const SPAWN_WAIT: Duration = Duration::from_millis(5_000);

struct Entry {
    server: Option<Arc<Server>>,
    /// 이 키로 지금 스폰이 날고 있다 — **단일 비행**. 프리웜과 첫 `status`가 같은 순간에
    /// 들어와도 프로세스는 하나만 뜬다(크리틱 C-4: R1은 5/5 주행에서 두 벌을 띄웠다).
    spawning: bool,
    /// 죽음을 **처음 관측한** 시각(0 = 살아 있음) — 쿨다운 판정의 기준점.
    died_at_ms: u64,
    last_error: Option<String>,
    /// ★LSPIDLE R1 — **「회수됨」**. 유휴 스윕이 정상적으로 접은 시각(0 = 그런 적 없음).
    ///
    /// `died_at_ms`와 일부러 다른 칸이다. 죽음은 **사고**고 회수는 **정책**이라, 둘을 한
    /// 칸에 쓰면 회수가 재스폰 쿨다운 30초를 무는(= 재열람이 30초 멈추는) 일이 생긴다.
    /// 여기는 진단·계약면(`reclaimed`)이 읽는 자리이기도 하다.
    reclaimed_at_ms: u64,
    /// 회수 뒤 다시 살아난 횟수 — 「투명 재기동」이 실제로 도는지 벤치가 읽는 눈금.
    revivals: u32,
}

impl Entry {
    fn empty() -> Entry {
        Entry { server: None, spawning: false, died_at_ms: 0, last_error: None, reclaimed_at_ms: 0, revivals: 0 }
    }
}

/// `start()`가 돌려주는 자리 상태 — 렌더러의 `status` 세 값과 1:1이다.
pub enum Slot {
    Live(Arc<Server>),
    /// 스폰이 날고 있다(또는 방금 걸었다). 호출 스레드는 `CreateProcess`를 물지 않는다.
    Starting,
    Failed(String),
}

#[derive(Default)]
struct Registry {
    map: HashMap<String, Entry>,
}

static REG: OnceLock<(Mutex<Registry>, Condvar)> = OnceLock::new();
static SWEEPER: AtomicBool = AtomicBool::new(false);
/// `dispose_all` 뒤에 착지하는 스폰이 고아로 남지 않게 하는 문.
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

fn reg() -> &'static (Mutex<Registry>, Condvar) {
    REG.get_or_init(|| (Mutex::new(Registry::default()), Condvar::new()))
}

fn env_u64(key: &str) -> Option<u64> {
    std::env::var(key).ok()?.parse::<u64>().ok()
}

fn ttl_for(spec: &ServerSpec) -> u64 {
    env_u64("CCG_LSP_IDLE_TTL_MS").unwrap_or(spec.idle_ttl_ms)
}

/// 레지스트리 키에 쓰는 루트 표기 — **정규화한 뒤에** 만든다.
///
/// 크리틱 C-3: R1은 소문자화만 했고, 같은 폴더가 `C:\x`(프리웜의 `normalize`)와
/// `C:/x`·`C:\x\`(status의 원문 cwd)로 들어와 **서버가 두 벌** 떴다(실앱 실측).
/// 2.6.2는 `ensure`에서 `path.resolve(root)` 뒤에 키를 만들어(manager.ts:2427) 이 구멍이 없다.
///
/// `canonicalize`는 구분자·후행 슬래시에 더해 8.3 단축명·심볼릭 링크·디스크상 대소문자까지
/// 접는다. 없는 경로에서는 실패하므로 그때만 문법적 정규화로 떨어진다. 성공한 결과는
/// 폴더당 한 번만 syscall하도록 메모한다(`status`가 400ms마다 부르는 경로다).
pub(crate) fn canon_root(root: &Path) -> PathBuf {
    static MEMO: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();
    let raw = root.to_string_lossy().to_string();
    let memo = MEMO.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(p) = memo.lock().unwrap().get(&raw) {
        return p.clone();
    }
    let Ok(c) = std::fs::canonicalize(root) else {
        // 아직 없는 폴더 — 메모하지 않는다(나중에 생기면 진짜 정규형으로 바뀌어야 한다)
        return crate::normalize(root);
    };
    let out = strip_verbatim(&c);
    let mut m = memo.lock().unwrap();
    if m.len() > 512 {
        m.clear();
    }
    m.insert(raw, out.clone());
    out
}

/// `\\?\C:\x` → `C:\x`. UNC verbatim(`\\?\UNC\...`)은 접으면 다른 경로가 되므로 그대로 둔다.
fn strip_verbatim(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => p.to_path_buf(),
    }
}

fn key_of(spec: &ServerSpec, root: &Path) -> String {
    format!("{}|{}", spec.id, canon_root(root).to_string_lossy().to_ascii_lowercase())
}

/// 이 루트의 자리를 본다 — 없으면 **백그라운드로** 스폰을 걸고 곧바로 `Starting`.
///
/// `status`(=지연 스폰의 방아쇠)가 부르는 자리다. R1은 여기서 동기 `Command::spawn`을
/// 호출 스레드에서 돌아 첫 `status` 왕복이 `CreateProcess`를 통째로 물었다
/// (크리틱 §3.2: 2.6.2 12.3ms 대 3.0 50.4ms — **+38ms**). 렌더러는 어차피 폴링으로
/// ready를 따로 보므로 여기서 기다릴 이유가 없다.
///
/// **touch를 하지 않는다**(크리틱 C-1 ②): 상태 폴링이 유휴 타이머를 400ms마다 되감으면
/// 파일을 열어 둔 것만으로 TTL이 영원히 안 찬다 — 죽은 서버의 자리도 그래서 안 걷혔다.
/// 유휴 회수는 **실제 쿼리**(호버·정의·토큰·완성)가 있을 때만 미뤄져야 한다.
pub fn start(spec: &'static ServerSpec, root: &Path) -> Slot {
    let key = key_of(spec, root);
    prepare_once(spec, root, &key);
    // 스윕이 멎어 있으면 여기서 되살린다 — 회수가 도는 유일한 보장이다(★LSPIDLE R1).
    kick_sweeper_if_stalled();
    // 자리에서 밀려나는 죽은 서버 — 잠금을 놓은 뒤에 접는다(taskkill은 수십 ms).
    let stale: Option<Arc<Server>>;
    {
        let (m, _) = reg();
        let mut r = m.lock().unwrap();
        match r.map.get_mut(&key) {
            Some(e) => {
                let cooled = match &e.server {
                    None => false,
                    Some(s) if s.raw_status() != Status::Error => return Slot::Live(s.clone()),
                    Some(s) => {
                        // 죽었다 — **처음 관측한 시각**을 찍는다(스윕이 늦게 와도 복귀
                        // 시각이 밀리지 않게). 2.6.2의 child 'exit' 훅이 하던 일.
                        if e.died_at_ms == 0 {
                            e.died_at_ms = now_ms();
                            e.last_error = s.error().or_else(|| Some("LSP 서버가 종료됨".into()));
                        }
                        if now_ms().saturating_sub(e.died_at_ms) < RESPAWN_COOLDOWN_MS {
                            // 쿨다운 중 — 죽은 그대로 보고한다(status가 정직하게 error를 낸다)
                            return Slot::Live(s.clone());
                        }
                        true // 쿨다운을 넘겼다 → 자리를 비우고 새로 띄운다
                    }
                };
                // 이미 누가 띄우는 중이면 **여기서 끝난다** — 자리를 건드리지 않는다
                // (착지하는 스폰이 낡은 핸들을 접는다).
                if e.spawning {
                    return Slot::Starting;
                }
                stale = if cooled { e.server.take() } else { None };
                if e.died_at_ms > 0 && now_ms().saturating_sub(e.died_at_ms) < RESPAWN_COOLDOWN_MS {
                    return Slot::Failed(e.last_error.clone().unwrap_or_else(|| "재스폰 쿨다운".into()));
                }
                e.spawning = true;
            }
            None => {
                stale = None;
                let mut e = Entry::empty();
                e.spawning = true;
                r.map.insert(key.clone(), e);
            }
        }
    }
    // 파이프만 끊기고 프로세스가 남아 있을 수도 있다(드문 경우) — 트리째 접는다.
    // **호출 스레드에서 하지 않는다**: 이 경로는 `status` 폴링이고 `taskkill`은 수십 ms다.
    if let Some(old) = stale {
        std::thread::spawn(move || old.shutdown("죽은 서버 교체"));
    }
    spawn_in_background(spec, root.to_path_buf(), key);
    Slot::Starting
}

/// ★LSPIDLE R1 — **기동 없이 준비만.** 프리웜([`crate::prewarm`])이 부르는 자리.
///
/// R1까지 프리웜은 `start()`를 불렀고, 그래서 「프로젝트를 열었다」만으로 서버가 떴다 —
/// 코드 뷰어를 한 번도 안 열어도 헬퍼 세 개가 상주했다(`bench/results` gates 태그:
/// WS 115.5MB · Priv 101.6MB · 유휴 프로세스 8 대 7). 그 자리를 이 함수가 대신한다.
///
/// 여기서 하는 일은 **다음에 올 기동을 싸게 만드는 것**뿐이고, 프로세스는 하나도 안 뜬다:
///  - 스펙의 준비 훅(`prepare_root`) — C++의 `compile_commands.json`처럼 **서버 인자를
///    만들려면 먼저 파일이 있어야 하는** 언어가 있다. 이건 수 초~수 분짜리라 열람 시점으로
///    미루면 첫 호버가 그만큼 멈춘다. 기동과 달리 메모리를 상주시키지 않으므로 앞당겨도 된다.
///  - 루트 해석(`root_for`) — C#의 «참조 프로젝트 최대» 솔루션 스캔이 여기서 캐시에 앉는다.
///  - 실행 계획 해석(`launchable`) — node 런타임·번들 모듈 경로 사슬을 메모에 태운다.
///
/// 스윕도 여기서 깨우지 않는다 — 접을 서버가 없는데 60초마다 도는 스레드를 만들 이유가 없다.
pub fn prepare(spec: &'static ServerSpec, root: &Path) {
    prepare_once(spec, root, &key_of(spec, root));
    // 실행 계획을 한 번 풀어 경로 메모를 데운다. 결과(기동 가능 여부)는 여기서 안 쓴다 —
    // 못 띄우는 상태여도 그건 열람 시 `status`가 `need-install`로 정직하게 말할 일이다.
    let _ = crate::server::launchable(spec, root);
}

/// 지금 살아 있는 서버들의 PID — 재기동이 **정말 새 프로세스인지** 보는 눈금.
/// (회수가 이름만 바꾸고 같은 프로세스를 재사용하면 회수가 아니다.)
pub fn live_pids() -> Vec<u32> {
    let (m, _) = reg();
    let r = m.lock().unwrap();
    let mut v: Vec<u32> = r
        .map
        .values()
        .filter_map(|e| e.server.as_ref())
        .filter(|s| s.raw_status() != Status::Error)
        .map(|s| s.pid)
        .collect();
    v.sort_unstable();
    v
}

/// 지금 **회수돼 비어 있는** 자리 수와, 회수 뒤 되살아난 횟수(진단·벤치).
/// `(회수된 자리, 재기동 횟수)` — 「투명 재기동」이 실제로 도는지 보는 눈금이다.
pub fn reclaim_stats() -> (usize, u32) {
    let (m, _) = reg();
    let r = m.lock().unwrap();
    let reclaimed = r.map.values().filter(|e| e.server.is_none() && e.reclaimed_at_ms > 0).count();
    let revivals = r.map.values().map(|e| e.revivals).sum();
    (reclaimed, revivals)
}

/// 스펙의 **준비 훅**([`ServerSpec::prepare_root`]) — 루트당 한 번, 백그라운드로.
///
/// 왜 엔진이 이걸 알아야 하는가(R4, C++가 판 자리): 서버에 넘길 인자를 만들려면 먼저
/// 파일을 만들어야 하는 언어가 있다(clangd의 `compile_commands.json` — UE에서는
/// UnrealBuildTool이 수 초~수 분 걸려 만든다). 스폰 경로에서 동기로 하면 첫 호버가 그만큼
/// 멈추고, 비동기로 하면 그 사이에 뜬 서버는 **틀린 인자로 떠 있다**. 그래서 준비가 끝나
/// 훅이 `true`를 돌려주면 그 자리를 통째로 비운다 — 다음 요청이 새 인자로 재스폰한다.
///
/// 여기에도 언어 이름은 없다. 2.6.2는 같은 일을 `if (def.id === 'cpp') this.maybeUeDb(cwd)`
/// + `restart('cpp', cwd)`로 했다(manager.ts:1342·1526).
fn prepare_once(spec: &'static ServerSpec, root: &Path, key: &str) {
    let Some(prepare) = spec.prepare_root else { return };
    {
        static DONE: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
        let done = DONE.get_or_init(|| Mutex::new(std::collections::HashSet::new()));
        // `status`가 400ms마다 여기를 지난다 — 두 번째부터는 이 삽입 실패로 즉시 돌아간다
        if !done.lock().unwrap().insert(key.to_string()) {
            return;
        }
    }
    let (root, key) = (root.to_path_buf(), key.to_string());
    std::thread::Builder::new()
        .name("ccg-lsp-prepare".into())
        .spawn(move || {
            if prepare(&root) {
                drop_slot(&key, "서버 입력이 준비됨 — 새 인자로 재스폰");
            }
        })
        .ok();
}

/// 자리를 통째로 비운다 — 다음 요청이 **재스폰 쿨다운 없이** 새로 띄운다.
/// (죽은 서버로 두면 30초 쿨다운을 문다. 2.6.2 `restart`가 맵에서 먼저 지운 이유와 같다.)
///
/// ★ **날고 있는 스폰을 먼저 기다린다.** 준비 훅은 첫 `status`와 거의 동시에 끝나는데,
/// 그때 자리를 그냥 비우면 착지하는 스폰([`spawn_in_background`])이 `entry().or_insert()`로
/// 자리를 **다시 만들어** 낡은 인자의 프로세스를 꽂는다 — 그러면 유휴 TTL(30분)까지 틀린
/// 서버가 산다. 착지를 기다렸다가 비우면 그 창이 닫힌다.
fn drop_slot(key: &str, why: &'static str) {
    let (m, cv) = reg();
    let mut r = m.lock().unwrap();
    let deadline = Instant::now() + SPAWN_WAIT;
    while r.map.get(key).map(|e| e.spawning).unwrap_or(false) && Instant::now() < deadline {
        let (g, _t) = cv.wait_timeout(r, Duration::from_millis(100)).unwrap();
        r = g;
    }
    let old = r.map.remove(key).and_then(|e| e.server);
    drop(r);
    if let Some(s) = old {
        s.shutdown(why);
    }
}

/// 잠금 밖에서 프로세스를 만들고, 끝나면 자리에 꽂고 기다리는 쪽을 깨운다.
fn spawn_in_background(spec: &'static ServerSpec, root: PathBuf, key: String) {
    let run = move || {
        let spawned = Server::spawn(spec, &root);
        let (m, cv) = reg();
        let mut r = m.lock().unwrap();
        let e = r.map.entry(key).or_insert_with(Entry::empty);
        e.spawning = false;
        // 자리에 낡은(죽은) 핸들이 남아 있을 수 있다 — 밀어내고 잠금 밖에서 접는다
        let old = e.server.take();
        let fresh = match spawned {
            Ok(s) => {
                e.server = Some(s.clone());
                e.died_at_ms = 0;
                e.last_error = None;
                // 회수됐던 자리가 다시 찼다 = **투명 재기동**이 한 번 돌았다.
                if e.reclaimed_at_ms > 0 {
                    e.reclaimed_at_ms = 0;
                    e.revivals = e.revivals.saturating_add(1);
                }
                Some(s)
            }
            Err(err) => {
                e.died_at_ms = now_ms();
                e.last_error = Some(err);
                None
            }
        };
        drop(r);
        cv.notify_all();
        if let Some(o) = old {
            o.shutdown("낡은 서버 핸들 정리");
        }
        if let Some(s) = fresh {
            // 그 사이 앱이 종료를 시작했으면 방금 뜬 서버는 고아다 — 바로 접는다
            if SHUTTING_DOWN.load(Ordering::SeqCst) {
                s.shutdown("앱 종료 중 착지한 스폰");
            } else {
                start_sweeper();
            }
        }
    };
    if std::thread::Builder::new().name("ccg-lsp-spawn".into()).spawn(run).is_err() {
        // 스레드조차 못 만드는 상황 — 자리를 풀어 다음 호출이 다시 시도하게 한다
        let (m, cv) = reg();
        let mut r = m.lock().unwrap();
        for e in r.map.values_mut() {
            e.spawning = false;
        }
        drop(r);
        cv.notify_all();
    }
}

/// 이 파일을 맡는 서버(없으면 스폰이 끝날 때까지 잠깐 기다린다). 실패면 `Err(이유)`.
/// 기능 호출(호버·정의·토큰·완성)의 앞단 — `status`는 [`start`]를 쓴다.
pub fn ensure(spec: &'static ServerSpec, root: &Path) -> Result<Arc<Server>, String> {
    match start(spec, root) {
        Slot::Live(s) => Ok(s),
        Slot::Failed(e) => Err(e),
        Slot::Starting => wait_for_spawn(spec, root),
    }
}

fn wait_for_spawn(spec: &'static ServerSpec, root: &Path) -> Result<Arc<Server>, String> {
    let key = key_of(spec, root);
    let (m, cv) = reg();
    let mut r = m.lock().unwrap();
    let deadline = Instant::now() + SPAWN_WAIT;
    loop {
        match r.map.get(&key) {
            None => return Err("서버 자리가 사라짐".into()),
            Some(e) => {
                if let Some(s) = &e.server {
                    return Ok(s.clone());
                }
                if !e.spawning {
                    return Err(e.last_error.clone().unwrap_or_else(|| "서버 기동 실패".into()));
                }
            }
        }
        let now = Instant::now();
        if now >= deadline {
            return Err("서버 기동 대기 시간 초과".into());
        }
        let (g, _t) = cv.wait_timeout(r, deadline - now).unwrap();
        r = g;
    }
}

/// 이 파일의 서버 루트(스펙의 루트 규칙 적용).
pub fn root_of(spec: &ServerSpec, abs: &Path, cwd: &Path) -> PathBuf {
    root_for(spec, abs, cwd)
}

/// cwd 아래(또는 그 자체)에 뜬 서버들의 상태 — 탐색기 폴더 배지.
pub fn project_state(cwd: &Path) -> (&'static str, Option<f64>) {
    // 키와 **같은 정규화**를 거쳐야 접두 비교가 맞는다(C-3와 같은 자리)
    let root = canon_root(cwd).to_string_lossy().to_ascii_lowercase();
    let prefix = format!("{root}{}", std::path::MAIN_SEPARATOR);
    let (m, _) = reg();
    let r = m.lock().unwrap();
    let mut analyzing = false;
    let mut ready = false;
    let mut pct = None;
    for (k, e) in r.map.iter() {
        let sroot = &k[k.find('|').map(|i| i + 1).unwrap_or(0)..];
        if sroot != root && !sroot.starts_with(&prefix) {
            continue;
        }
        let Some(s) = &e.server else { continue };
        match s.raw_status() {
            Status::Error => continue,
            Status::Starting => {
                analyzing = true;
                if let Some(p) = s.progress_pct() {
                    pct = Some(p);
                }
            }
            Status::Ready => {
                if s.status() == Status::Starting {
                    analyzing = true;
                    if let Some(p) = s.progress_pct() {
                        pct = Some(p);
                    }
                } else if let Some(p) = s.progress_pct() {
                    // clangd: initialize는 즉시 끝나지만 백그라운드 인덱싱은 이어진다 —
                    // 진행률이 흐르는 동안은 '분석 중'으로 정직하게 보여 준다
                    analyzing = true;
                    pct = Some(p);
                } else {
                    ready = true;
                }
            }
        }
    }
    if analyzing {
        ("analyzing", pct)
    } else if ready {
        ("ready", None)
    } else {
        ("idle", None)
    }
}

/// 지금 살아 있는 서버 수(진단·테스트). **죽은 핸들은 세지 않는다** — C-1 이후로
/// `raw_status`가 사망을 반영하므로 이 수가 "실제로 말이 통하는 서버"와 같아진다.
pub fn live_count() -> usize {
    let (m, _) = reg();
    m.lock()
        .unwrap()
        .map
        .values()
        .filter(|e| e.server.as_ref().is_some_and(|s| s.raw_status() != Status::Error))
        .count()
}

/// 앱을 거친 파일 변화를 **서버들에** 흘린다(2.6.2 `notifyWatchedFiles`의 팬아웃 절반).
/// 서버 하나가 할 네 가지는 [`Server::files_changed`]에 있다.
/// 반환 = 실제로 어느 서버에든 통지된 경로들(렌더러 브로드캐스트의 원천).
pub fn notify_files_changed(paths: &[PathBuf]) -> Vec<PathBuf> {
    if paths.is_empty() {
        return Vec::new();
    }
    let live: Vec<Arc<Server>> = {
        let (m, _) = reg();
        let r = m.lock().unwrap();
        r.map.values().filter_map(|e| e.server.clone()).collect()
    };
    // 소문자 키 → 원본 경로(중복 제거). 순서를 재현 가능하게 두려고 BTreeMap.
    let mut notified: BTreeMap<String, PathBuf> = BTreeMap::new();
    for s in live {
        // 초기화 전 서버는 건너뛴다 — 로드 시점의 글롭 평가가 그 구간을 덮는다(2.6.2 조건)
        if s.status() != Status::Ready {
            continue;
        }
        // **루트 포함 여부로 거르지 않는다**: 서버 루트가 소스를 경로상 포함하지 않는
        // 배치가 실제로 있다(2.6.2 UnrealNetCore 합성 유닛). 대신 그 서버가 관심 가질
        // 확장자만 고른다 — `exts` + `watch_exts`(= C#의 csproj/sln/props/targets).
        let wanted: Vec<PathBuf> = paths
            .iter()
            .filter(|p| {
                p.extension().and_then(|e| e.to_str()).map(|e| s.spec.watches_ext(e)).unwrap_or(false)
            })
            .cloned()
            .collect();
        if wanted.is_empty() {
            continue;
        }
        for p in &wanted {
            notified.insert(p.to_string_lossy().to_ascii_lowercase(), p.clone());
        }
        s.files_changed(&wanted);
    }
    notified.into_values().collect()
}

/// 마지막 스윕이 **끝난** 시각(0 = 아직 한 번도 안 돌았다) — 워치독의 맥박.
static LAST_SWEEP_MS: AtomicU64 = AtomicU64::new(0);

fn sweep_every_ms() -> u64 {
    env_u64("CCG_LSP_SWEEP_MS").unwrap_or(SWEEP_EVERY_MS_DEFAULT)
}

fn start_sweeper() {
    if SWEEPER.swap(true, Ordering::SeqCst) {
        return;
    }
    let every = sweep_every_ms();
    let spawned = std::thread::Builder::new()
        .name("ccg-lsp-sweep".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_millis(every));
            sweep_idle();
        })
        .is_ok();
    if !spawned {
        // 스레드를 못 만들었다 — 깃발을 도로 내려 다음 스폰이 다시 시도하게 한다.
        // (여기서 참으로 남겨 두면 스윕이 **영원히** 안 돈다 = 회수도 안 돈다.)
        SWEEPER.store(false, Ordering::SeqCst);
    }
}

/// ★LSPIDLE R1 — **스윕 스레드의 워치독.** 맥박이 멎었으면 다시 띄운다.
///
/// 왜 필요한가: `SWEEPER`는 «한 번만 띄운다»는 래치라, 그 스레드가 어떤 이유로든 사라지면
/// (패닉·OS의 스레드 실패) 깃발만 참으로 남고 회수는 **영영 안 돈다**. 그 상태는 밖에서
/// 안 보인다 — 서버가 계속 사는 것으로만 나타난다. 이 라운드가 없애려는 증상 그대로다.
///
/// 스폰 경로에서만 부른다(= 서버가 실제로 있을 때만). 판정은 「마지막 스윕이 주기의 세 배보다
/// 오래됐다」 — 한 번 늦은 것을 고장으로 오해하지 않을 만큼 느슨하다.
fn kick_sweeper_if_stalled() {
    if !SWEEPER.load(Ordering::SeqCst) {
        return; // 아직 안 띄웠다 — start_sweeper가 할 일이다
    }
    let last = LAST_SWEEP_MS.load(Ordering::SeqCst);
    if last == 0 {
        return; // 첫 스윕 전 — 아직 맥박을 잴 수 없다
    }
    if now_ms().saturating_sub(last) <= sweep_every_ms().saturating_mul(3) {
        return;
    }
    SWEEPER.store(false, Ordering::SeqCst);
    start_sweeper();
}

/// 스윕이 살아 있는 서버 하나에 내리는 판정.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Sweep {
    /// 아직 TTL 안 — 그대로 둔다.
    Keep,
    /// 일하는 중 — 타이머를 되감는다(유예).
    Rewind,
    /// 접는다.
    Reclaim,
}

/// ★LSPIDLE R1 — 회수 규칙 **전부**가 여기 있다. 순수 함수인 이유는 하나다:
/// 이 규칙의 돌연변이(타이머 무시 · 유예 삭제 · 상한 삭제)가 각각 다른 테스트를 붉히게
/// 하려면, 판정이 실물 프로세스를 띄우지 않고도 불릴 수 있어야 한다.
///
/// 세 줄로 읽는다:
///  1. TTL을 아직 안 채웠으면 둔다.
///  2. 채웠지만 **일하는 중**이면(초기화·프로젝트 로드·인덱싱 진행률) 되감는다 —
///     쿼리가 없다는 것과 노는 것은 다르다.
///  3. 단, 그 유예도 [`IDLE_GRACE_CAP_MS`]까지다. 진행률 `end`를 영영 안 보내는 서버가
///     이 문으로 영생하면 이 라운드가 고친 「항상 산다」가 다른 이름으로 돌아온다.
fn sweep_decision(idle_ms: u64, ttl_ms: u64, indexing: bool) -> Sweep {
    if idle_ms < ttl_ms {
        return Sweep::Keep;
    }
    if indexing && idle_ms < IDLE_GRACE_CAP_MS {
        return Sweep::Rewind;
    }
    Sweep::Reclaim
}

/// 유휴 회수 + 좀비 정리. 스윕 스레드가 부르고, 테스트가 직접 부를 수도 있다.
pub fn sweep_idle() {
    let mut doomed: Vec<(Arc<Server>, &'static str)> = Vec::new();
    let mut live_pids: Vec<u32> = Vec::new();
    {
        let (m, _) = reg();
        let mut r = m.lock().unwrap();
        let mut drop_keys: Vec<String> = Vec::new();
        for (k, e) in r.map.iter_mut() {
            let Some(s) = &e.server else {
                // 실패 항목은 쿨다운이 지나면 자리째 비운다(맵이 루트 수만큼 자라지 않게)
                if !e.spawning
                    && e.died_at_ms > 0
                    && now_ms().saturating_sub(e.died_at_ms) > RESPAWN_COOLDOWN_MS * 4
                {
                    drop_keys.push(k.clone());
                }
                continue;
            };
            // ① 좀비 안전망 — 프로세스는 이미 죽었는데 핸들만 남은 항목.
            //    C-1 이후 `raw_status`가 rpc 사망을 반영하므로 **이 갈래가 실제로 돈다**.
            if s.raw_status() == Status::Error {
                doomed.push((s.clone(), "죽은 서버 정리"));
                e.server = None;
                // 죽음의 시각은 **처음 관측한 때**를 지킨다 — 스윕이 30초 뒤에 와도
                // 재스폰 쿨다운이 그만큼 밀리면 복귀가 60초가 된다.
                if e.died_at_ms == 0 {
                    e.died_at_ms = now_ms();
                }
                continue;
            }
            live_pids.push(s.pid);
            // ②③ 유휴 판정 — 규칙은 [`sweep_decision`]에 순수 함수로 있다(못이 거기 박힌다).
            match sweep_decision(s.idle_ms(), ttl_for(s.spec), s.indexing()) {
                Sweep::Keep => {}
                // 일하는 중이다 — 타이머를 되감는다(★LSPIDLE R1, [`Server::indexing`])
                Sweep::Rewind => s.touch(),
                Sweep::Reclaim => {
                    doomed.push((s.clone(), "유휴 서버 회수"));
                    e.server = None;
                    e.died_at_ms = 0; // 정상 회수 — 쿨다운 없이 다음 요청이 바로 되살린다
                    e.reclaimed_at_ms = now_ms(); // 「회수됨」 — 사고가 아니라 정책이다
                }
            }
        }
        for k in drop_keys {
            r.map.remove(&k);
        }
    }
    // 프로세스 종료(taskkill)는 잠금 밖에서 — 수십 ms 걸린다
    for (s, why) in doomed {
        s.shutdown(why);
    }
    // ④ 원장 스윕 — 위 셋을 **다 놓쳤을 때**의 마지막 겹(zombie.rs 헤더의 표 ③).
    //    방금 접은 것들은 이미 `forget`으로 내려갔으므로 여기 안 걸린다.
    let _ = crate::zombie::sweep(&live_pids, ZOMBIE_MAX_AGE_MS);
    LAST_SWEEP_MS.store(now_ms(), Ordering::SeqCst);
}

/// 앱 종료 — 서버를 전부 접는다(안 접으면 node/tsserver가 그대로 남는다).
/// 날고 있는 스폰은 착지하면서 스스로 접힌다(`SHUTTING_DOWN`).
pub fn dispose_all() {
    SHUTTING_DOWN.store(true, Ordering::SeqCst);
    let taken: Vec<Arc<Server>> = {
        let (m, _) = reg();
        let mut r = m.lock().unwrap();
        let list = r.map.values_mut().filter_map(|e| e.server.take()).collect();
        r.map.clear();
        list
    };
    for s in taken {
        s.shutdown("앱 종료");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// C-3 — 같은 폴더의 세 표기가 **같은 키**여야 한다(서버 두 벌 방지).
    #[test]
    fn key_folds_separator_and_trailing_slash() {
        let spec = crate::spec::spec_by_id("ts").unwrap();
        let dir = std::env::temp_dir().join("ccg-lsp-keytest");
        let _ = std::fs::create_dir_all(&dir);
        let base = dir.to_string_lossy().to_string();
        let a = key_of(spec, Path::new(&base));
        let b = key_of(spec, Path::new(&base.replace('\\', "/")));
        let c = key_of(spec, Path::new(&format!("{base}\\")));
        assert_eq!(a, b, "슬래시 표기가 다른 키를 만들면 서버가 두 벌 뜬다");
        assert_eq!(a, c, "후행 구분자가 다른 키를 만들면 서버가 두 벌 뜬다");
        // 대소문자도 접힌다(키는 소문자화된다)
        assert_eq!(a, key_of(spec, Path::new(&base.to_uppercase())));
    }

    /// ★LSPIDLE R1 — **회수 규칙의 못.** 세 돌연변이가 각각 다른 줄에서 붉어진다.
    #[test]
    fn the_reclaim_rule_honours_the_timer_the_grace_and_the_cap() {
        let ttl = 10 * 60_000; // bundled 기본값(2.6.2 준거)

        // ① 타이머 — TTL 전이면 무슨 일이 있어도 안 접는다.
        //    (돌연변이 「회수 타이머 무시」= 항상 Reclaim → 이 줄이 붉어진다)
        assert_eq!(sweep_decision(0, ttl, false), Sweep::Keep);
        assert_eq!(sweep_decision(ttl - 1, ttl, false), Sweep::Keep);
        assert_eq!(sweep_decision(ttl - 1, ttl, true), Sweep::Keep);

        // ② TTL을 채웠고 노는 중이면 접는다. **경계는 >= 다** — `>`로 바꾸면
        //    스윕 주기(60초)만큼 늦게 접힌다.
        assert_eq!(sweep_decision(ttl, ttl, false), Sweep::Reclaim);
        assert_eq!(sweep_decision(ttl * 9, ttl, false), Sweep::Reclaim);

        // ③ 유예 — 일하는 중이면 되감는다.
        //    (돌연변이 「유예 삭제」= indexing을 안 봄 → 이 줄이 붉어진다.
        //     그 상태의 대가는 clangd 인덱스를 30분마다 처음부터 다시 도는 방아다.)
        assert_eq!(sweep_decision(ttl, ttl, true), Sweep::Rewind);
        assert_eq!(sweep_decision(IDLE_GRACE_CAP_MS - 1, ttl, true), Sweep::Rewind);

        // ④ 절대 상한 — 유예도 여기까지다.
        //    (돌연변이 「안전망 제거」= 상한 조건 삭제 → 이 줄이 붉어진다)
        assert_eq!(sweep_decision(IDLE_GRACE_CAP_MS, ttl, true), Sweep::Reclaim);
        assert_eq!(sweep_decision(IDLE_GRACE_CAP_MS * 2, ttl, true), Sweep::Reclaim);

        // ⑤ 값 자체 — 2.6.2 파리티(10분/30분 · 안전망 30분)를 조용히 못 바꾸게.
        assert_eq!(IDLE_GRACE_CAP_MS, 30 * 60_000, "유예 상한이 2.6.2의 무거운 TTL과 갈렸다");
        assert_eq!(ZOMBIE_MAX_AGE_MS, 30 * 60_000, "좀비 안전망이 30분급이 아니다");
        assert_eq!(SWEEP_EVERY_MS_DEFAULT, 60_000, "스윕 주기가 2.6.2(IDLE_SWEEP_EVERY)와 갈렸다");
    }

    /// ★LSPIDLE R1 — 회수 TTL과 스윕 주기는 **주입 가능해야** 한다.
    /// 이 문이 없으면 벤치가 회수를 실증하려고 10분을 기다려야 하고, 그러면 아무도 안 잰다.
    #[test]
    fn the_timers_stay_injectable_for_the_bench() {
        let ts = crate::spec::spec_by_id("ts").unwrap();
        // 기본값은 스펙 그대로
        std::env::remove_var("CCG_LSP_IDLE_TTL_MS");
        assert_eq!(ttl_for(ts), ts.idle_ttl_ms);
        std::env::remove_var("CCG_LSP_SWEEP_MS");
        assert_eq!(sweep_every_ms(), SWEEP_EVERY_MS_DEFAULT);
        // 주입하면 그 값이 이긴다(bench/lsp.mjs가 6000/1000을 먹인다)
        std::env::set_var("CCG_LSP_IDLE_TTL_MS", "6000");
        std::env::set_var("CCG_LSP_SWEEP_MS", "1000");
        assert_eq!(ttl_for(ts), 6000);
        assert_eq!(sweep_every_ms(), 1000);
        std::env::remove_var("CCG_LSP_IDLE_TTL_MS");
        std::env::remove_var("CCG_LSP_SWEEP_MS");
    }

    /// 서버가 하나도 없어도 스윕은 죽지 않는다(원장 스윕까지 포함해서).
    #[test]
    fn sweeping_an_empty_registry_is_harmless() {
        sweep_idle();
        assert_eq!(live_count(), 0);
        // 회수한 적이 없으면 「회수됨」도 0이다(자리가 없는 것과 회수된 것은 다르다).
        assert_eq!(reclaim_stats().0, 0);
    }

    /// 없는 폴더도 키를 만들 수 있어야 한다(canonicalize 실패 → 문법적 정규화).
    #[test]
    fn key_survives_missing_folder() {
        let spec = crate::spec::spec_by_id("ts").unwrap();
        let a = key_of(spec, Path::new("C:\\ccg-nope\\x\\..\\y"));
        let b = key_of(spec, Path::new("C:/ccg-nope/y/"));
        assert_eq!(a, b, "{a} != {b}");
    }
}
