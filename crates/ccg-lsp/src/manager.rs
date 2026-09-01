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

use crate::lifecycle::Sweep;
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
/// [`start`]가 불린 횟수 — **온디맨드 못의 관측점**(★LSPIDLE R2 · 크리틱 B급 ①).
///
/// 크리틱이 실측으로 보인 구멍: R1의 못 `prewarm_prepares_without_spawning_a_single_process`는
/// 「프로세스가 떴는가」를 봤는데, `Prewarm::Eager` 팔은 `server::launchable()` 실패에서 즉시
/// return하므로 **런타임·모듈이 안 잡히는 환경에서는 아무것도 안 띄우고 조용히 통과**했다.
/// 갓 클론한 레포·스테이징 안 한 CI·크리틱의 배치가 전부 그 환경이다.
///
/// 그래서 못이 보는 것을 「떴는가」에서 **「기동을 걸었는가」**로 내린다. 이 수는 디스크에도
/// PATH에도 안 기대므로 어느 기계에서나 같은 답을 낸다.
static START_CALLS: AtomicU64 = AtomicU64::new(0);
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

/// 이 서버에 걸리는 수명 예산 — **값은 스펙이 정한다**(★LSPIDLE R3).
///
/// R2는 TTL만 스펙에서 오고 멎음 유예는 엔진 상수(5분)였다. 그 비대칭이 크리틱 R2 §3
/// A급의 근인이다 — 유예를 만든 명분인 두 서버(cs·cpp)에 값을 따로 줄 수가 없었다.
/// 여기서 둘을 같은 자리에 세운다. 엔진은 여전히 언어 이름을 모른다.
///
/// `CCG_LSP_STALL_MS`는 `CCG_LSP_IDLE_TTL_MS`와 같은 성격의 **테스트 주입 문**이다
/// (벤치가 30분을 기다리지 않고 멎음 회수를 실증하기 위한 것).
fn budget_for(spec: &ServerSpec) -> crate::lifecycle::Budget {
    crate::lifecycle::Budget {
        ttl_ms: ttl_for(spec),
        stall_ms: env_u64("CCG_LSP_STALL_MS").unwrap_or(spec.stall_grace_ms),
    }
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
    START_CALLS.fetch_add(1, Ordering::Relaxed);
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

/// [`start`]가 지금까지 불린 횟수(진단·못 전용). 「기동을 걸었는가」의 관측점이다.
/// 「프로세스가 떴는가」와 달리 디스크·PATH에 안 기대므로 어느 기계에서나 같은 답을 낸다.
pub fn start_calls() -> u64 {
    START_CALLS.load(Ordering::Relaxed)
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

/// 지금 **유예 중인** 서버 수 — ★LSPIDLE R3 · 크리틱 R2 §5 C-3.
///
/// R2는 [`crate::server::Server::in_grace`]를 「진단·`lifecycle()`」이라 문서화해 놓고
/// `lifecycle()`에 안 실어서 죽은 코드로 뒀다. 유예는 이 라운드가 세운 개념 중 밖에서
/// 유일하게 안 보이던 것이고, 「지금 몇 개가 유예로 살아 있는가」는 회수 규칙을 의심할 때
/// 가장 먼저 묻게 되는 수다. 그래서 지우는 대신 **계약면에 태웠다**.
pub fn grace_count() -> usize {
    let (m, _) = reg();
    let r = m.lock().unwrap();
    r.map.values().filter_map(|e| e.server.as_ref()).filter(|s| s.in_grace()).count()
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
pub fn project_state(cwd: &Path) -> (&'static str, Option<f64>, Option<String>) {
    // 키와 **같은 정규화**를 거쳐야 접두 비교가 맞는다(C-3와 같은 자리)
    let root = canon_root(cwd).to_string_lossy().to_ascii_lowercase();
    let prefix = format!("{root}{}", std::path::MAIN_SEPARATOR);
    let (m, _) = reg();
    let r = m.lock().unwrap();
    let mut analyzing = false;
    let mut ready = false;
    let mut pct = None;
    // ★LSPIDLE R2(크리틱 B급 ②) — 죽은 서버의 **사유**. 이 자리 말고는 밖으로 나갈 길이 없었다.
    let mut err: Option<String> = None;
    for (k, e) in r.map.iter() {
        let sroot = &k[k.find('|').map(|i| i + 1).unwrap_or(0)..];
        if sroot != root && !sroot.starts_with(&prefix) {
            continue;
        }
        let Some(s) = &e.server else {
            // 서버가 없는 자리라도 **왜 없는지**는 남아 있을 수 있다(기동 실패·쿨다운).
            if err.is_none() {
                err = e.last_error.clone();
            }
            continue;
        };
        match s.raw_status() {
            Status::Error => {
                if err.is_none() {
                    err = s.error().or_else(|| e.last_error.clone());
                }
                continue;
            }
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
        ("analyzing", pct, None)
    } else if ready {
        ("ready", None, None)
    } else {
        // 「할 일이 없어 idle」과 「죽어서 idle」은 겉보기가 같다 — 사유가 있으면 실어 보낸다.
        ("idle", None, err)
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
        // ★LSPIDLE R3 — **자고 나서가 아니라 먼저 한 번 쓸고 잔다.**
        //   R2까지는 한 주기(60초)를 잔 뒤에야 첫 스윕이었다. 그러면 워치독
        //   ([`kick_sweeper_if_stalled`])이 멎은 스윕을 되살려도 회수는 **또 60초** 뒤다 —
        //   되살리는 의미가 그만큼 준다. 부팅 직후의 첫 스윕은 레지스트리가 비어 있어
        //   무해하고(좀비 원장도 비어 있다), 대신 「스윕이 정말 도는가」가 즉시 관측된다.
        .spawn(move || loop {
            sweep_idle();
            std::thread::sleep(Duration::from_millis(every));
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
            // ★LSPIDLE R2 — 판정과 전이를 **함께** 받는다([`Server::sweep_step`]).
            //   호출부에 남은 일은 `Reclaim`일 때 프로세스를 접는 것뿐이다 — 잊을 수 있는
            //   전이가 없으므로 크리틱의 `Rewind => {}` 돌연변이가 **쓸 수 없는 모양**이 됐다.
            //   규칙 자체와 그 못은 전부 `crate::lifecycle`에 있다.
            match s.sweep_step(budget_for(s.spec)) {
                Sweep::Keep | Sweep::Rewind | Sweep::Settle => {}
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

// ── ★LSPIDLE R3 — 못 전용 문 (크리틱 R2 §4-B의 생존 돌연변이를 붉히기 위한 것) ─────
//
// 크리틱이 생존시킨 일곱 중 넷은 **레지스트리와 스윕 루프를 실제로 지나야** 잡힌다
// (「호출부가 Reclaim을 실행 안 한다」·「step을 안 부른다」·「스윕 스레드를 안 띄운다」·
// 「기동 계수기를 지운다」). 진짜 언어 서버를 띄우는 못은 환경에 기대므로 못 쓴다 —
// R2가 B급 ①에서 이미 그 함정을 밟았다. 그래서 자리를 **합성**한다.
/// 레지스트리를 만지는 못끼리 겹치지 않게 하는 자물쇠(전역 상태라 병렬로 돌면 서로 지운다).
#[cfg(test)]
pub(crate) fn registry_test_lock() -> std::sync::MutexGuard<'static, ()> {
    static L: OnceLock<Mutex<()>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(())).lock().unwrap_or_else(|e| e.into_inner())
}

/// 살아 있는 서버 하나를 자리에 앉힌다(스윕이 볼 수 있게).
#[cfg(test)]
pub(crate) fn seed_server_for_test(root: &Path, server: Arc<Server>) {
    let key = key_of(server.spec, root);
    let (m, _) = reg();
    let mut r = m.lock().unwrap();
    let e = r.map.entry(key).or_insert_with(Entry::empty);
    e.server = Some(server);
    e.spawning = false;
    e.died_at_ms = 0;
    e.reclaimed_at_ms = 0;
}

/// 서버는 없고 **사유만 남은** 자리(기동 실패 뒤의 모양) — `project_state`의 err 경로용.
#[cfg(test)]
pub(crate) fn seed_error_for_test(spec: &'static ServerSpec, root: &Path, err: &str) {
    let key = key_of(spec, root);
    let (m, _) = reg();
    let mut r = m.lock().unwrap();
    let e = r.map.entry(key).or_insert_with(Entry::empty);
    e.server = None;
    e.spawning = false;
    e.last_error = Some(err.to_string());
}

/// `(자리에 서버가 있는가, 「회수됨」이 찍혔는가)`.
#[cfg(test)]
pub(crate) fn entry_state_for_test(spec: &'static ServerSpec, root: &Path) -> (bool, bool) {
    let key = key_of(spec, root);
    let (m, _) = reg();
    let r = m.lock().unwrap();
    r.map.get(&key).map(|e| (e.server.is_some(), e.reclaimed_at_ms > 0)).unwrap_or((false, false))
}

/// 못이 앉힌 자리를 도로 치운다(다른 못이 이 자리를 세지 않게).
#[cfg(test)]
pub(crate) fn drop_entry_for_test(spec: &'static ServerSpec, root: &Path) {
    let key = key_of(spec, root);
    let (m, _) = reg();
    m.lock().unwrap().map.remove(&key);
}

/// 스윕 래치를 내린다 — 「다시 띄우면 정말 도는가」를 볼 수 있게.
#[cfg(test)]
pub(crate) fn reset_sweeper_for_test() {
    SWEEPER.store(false, Ordering::SeqCst);
    LAST_SWEEP_MS.store(0, Ordering::SeqCst);
}

#[cfg(test)]
pub(crate) fn last_sweep_ms_for_test() -> u64 {
    LAST_SWEEP_MS.load(Ordering::SeqCst)
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

    /// ★LSPIDLE R2 — **회수 규칙은 이제 여기 없다.** 규칙과 그 못은 전부
    /// []로 갔다(크리틱 R1 §3 A급: 판정과 전이가 갈려 있어서
    /// 「호출부가 전이를 잊는」 돌연변이가 초록으로 지나갔다).
    ///
    /// 이 자리에 남는 것은 **2.6.2 파리티 값**뿐이다 — 조용히 바뀌면 안 되는 눈금들.
    #[test]
    fn the_lifetime_constants_still_match_the_262_contract() {
        assert_eq!(SWEEP_EVERY_MS_DEFAULT, 60_000, "스윕 주기가 2.6.2(IDLE_SWEEP_EVERY)와 갈렸다");
        assert_eq!(ZOMBIE_MAX_AGE_MS, 30 * 60_000, "좀비 안전망이 30분급이 아니다");
        assert_eq!(RESPAWN_COOLDOWN_MS, 30_000, "재스폰 쿨다운이 2.6.2 실측 30.6초 자리와 갈렸다");
        // 스펙의 TTL도 2.6.2 그대로(bundled 10분 / 무거운 서버 30분)
        for s in crate::spec::SPECS {
            let want = match s.id {
                "ts" | "py" => 10 * 60_000,
                _ => 30 * 60_000,
            };
            assert_eq!(s.idle_ttl_ms, want, "{}: 유휴 TTL이 2.6.2 규약과 갈렸다", s.id);
        }
        // ★LSPIDLE R3 — 새로 내려온 두 눈금도 **조용히** 바뀌면 안 된다.
        //   이 값들은 재지 않고 골랐다(스펙 주석) — 그래서 더더욱 근거 없이 움직이면 안 된다.
        for s in crate::spec::SPECS {
            let (stall, ready) = match s.id {
                "ts" | "py" => (15 * 60_000, 1_500),
                _ => (30 * 60_000, if s.id == "cs" { 5_000 } else { 4_000 }),
            };
            assert_eq!(s.stall_grace_ms, stall, "{}: 멎음 유예가 R3이 고른 값과 갈렸다", s.id);
            assert_eq!(s.ready_wait_ms, ready, "{}: ready 예산이 R3이 고른 값과 갈렸다", s.id);
            // 유예가 TTL보다 짧을 이유는 없지만, **0이면 유예가 통째로 사라진다** —
            // 그 상태를 값으로 만들 수 없게 막는다(크리틱 A-1의 공집합이 다른 얼굴로 돌아온다).
            assert!(s.stall_grace_ms > 0, "{}: 멎음 유예가 0이면 유예가 공집합이다", s.id);
            assert!(s.ready_wait_ms > 0, "{}: ready 예산이 0이면 모든 기능이 즉시 빈손이다", s.id);
        }
    }

    /// ★LSPIDLE R1 — 회수 TTL과 스윕 주기는 **주입 가능해야** 한다.
    /// 이 문이 없으면 벤치가 회수를 실증하려고 10분을 기다려야 하고, 그러면 아무도 안 잰다.
    #[test]
    fn the_timers_stay_injectable_for_the_bench() {
        let _g = registry_test_lock(); // 환경 변수는 프로세스 전역이다 — 남의 못과 안 겹치게
        let ts = crate::spec::spec_by_id("ts").unwrap();
        // 기본값은 스펙 그대로
        std::env::remove_var("CCG_LSP_IDLE_TTL_MS");
        assert_eq!(ttl_for(ts), ts.idle_ttl_ms);
        std::env::remove_var("CCG_LSP_SWEEP_MS");
        assert_eq!(sweep_every_ms(), SWEEP_EVERY_MS_DEFAULT);
        // ★LSPIDLE R3 — 멎음 유예도 같은 문을 갖는다(안 그러면 30분을 기다려야 잰다)
        std::env::remove_var("CCG_LSP_STALL_MS");
        assert_eq!(budget_for(ts), crate::lifecycle::Budget::of(ts), "주입이 없으면 스펙 값 그대로");
        // 주입하면 그 값이 이긴다(bench/lsp.mjs가 6000/1000을 먹인다)
        std::env::set_var("CCG_LSP_IDLE_TTL_MS", "6000");
        std::env::set_var("CCG_LSP_SWEEP_MS", "1000");
        std::env::set_var("CCG_LSP_STALL_MS", "2000");
        assert_eq!(ttl_for(ts), 6000);
        assert_eq!(sweep_every_ms(), 1000);
        assert_eq!(budget_for(ts), crate::lifecycle::Budget { ttl_ms: 6000, stall_ms: 2000 });
        std::env::remove_var("CCG_LSP_IDLE_TTL_MS");
        std::env::remove_var("CCG_LSP_SWEEP_MS");
        std::env::remove_var("CCG_LSP_STALL_MS");
    }

    // ── ★LSPIDLE R3 — 스윕 **루프**를 지키는 못들(크리틱 R2 §4-B의 B1·B2·B3·D1) ──────
    //
    // R2는 「호출부에 잊을 수 있는 것이 남아 있지 않다」고 적었지만, 남은 하나
    // (`Reclaim`일 때 실제로 접기)가 R1의 `Rewind => {}`와 **같은 모양으로** 무방비였다.
    // 잊을 자리가 둘에서 하나로 줄었을 뿐 사라지지 않았고, 그 하나에 못이 없었다.

    fn fixture_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("ccg-lspidle-r3-{name}"))
    }

    /// ★B1·B2형 — **판정이 맞아도 아무도 안 접으면 회수는 없다.**
    ///
    /// 살아 있는 서버 하나를 자리에 앉히고 TTL을 넘긴 뒤 `sweep_idle()`을 한 번 돌린다.
    /// 그 뒤 ① 자리가 비었고 ② 「회수됨」이 찍혔고 ③ 프로세스가 접혔어야 한다.
    /// - 호출부가 `Reclaim` 갈래에서 아무것도 안 하면(B1) 셋 다 안 일어난다.
    /// - 호출부가 `sweep_step`을 아예 안 부르면(B2) 판정 자체가 `Keep`이라 같은 결과다.
    #[test]
    fn the_sweep_actually_folds_the_server_it_decided_to_reclaim() {
        let _g = registry_test_lock();
        let root = fixture_root("reclaim");
        let spec = crate::spec::spec_by_id("ts").unwrap();
        drop_entry_for_test(spec, &root);
        let s = Server::inert_for_test(spec, &root, Status::Ready);
        // 「TTL을 넘길 만큼 시간이 흘렀다」 — 인덱싱도 아니고 쿼리도 없었다.
        s.rewind_clocks_for_test(ttl_for(spec) + 60_000);
        seed_server_for_test(&root, s.clone());
        assert_eq!(entry_state_for_test(spec, &root), (true, false), "픽스처가 자리에 안 앉았다");
        assert!(!s.is_dead(), "픽스처가 앉기도 전에 죽어 있다");

        sweep_idle();

        let (has_server, reclaimed) = entry_state_for_test(spec, &root);
        assert!(
            !has_server,
            "★TTL이 지난 서버가 자리에 그대로다 — 판정은 맞게 받고 **접지를 않았다**\
             (크리틱 R2 §4-B B1: R1의 `Rewind => {{}}`와 같은 모양으로 무방비였던 그 자리)"
        );
        assert!(reclaimed, "★「회수됨」이 안 찍혔다 — 사고와 정책을 가르는 칸이 비었다");
        assert!(
            s.is_dead(),
            "★자리에서는 내렸는데 프로세스를 안 접었다 — 회수가 이름만 회수다(핸들이 샌다)"
        );
        drop_entry_for_test(spec, &root);
    }

    /// 위 못의 **음성 대조** — 아직 TTL 안인 서버는 안 접힌다.
    /// (「스윕이 무조건 다 접는다」로 고쳐도 위 못이 초록이 되지 않게 한다.)
    #[test]
    fn the_sweep_leaves_a_server_that_is_still_inside_its_ttl() {
        let _g = registry_test_lock();
        let root = fixture_root("keep");
        let spec = crate::spec::spec_by_id("ts").unwrap();
        drop_entry_for_test(spec, &root);
        let s = Server::inert_for_test(spec, &root, Status::Ready);
        seed_server_for_test(&root, s.clone());
        sweep_idle();
        let (has_server, reclaimed) = entry_state_for_test(spec, &root);
        assert!(has_server && !reclaimed, "★TTL 안인데 접혔다 — 방금 쓴 서버가 사라진다");
        assert!(!s.is_dead());
        drop_entry_for_test(spec, &root);
        s.shutdown("못 정리");
    }

    /// ★B3형 — **스윕 스레드를 안 띄우면 회수는 영영 안 돈다.**
    ///
    /// 규칙도 호출부도 맞는데 루프가 안 돌면 밖에서는 「서버가 계속 산다」로만 보인다 —
    /// 이 라운드가 없애려는 증상 그대로다. 래치를 내리고 다시 띄워, 맥박
    /// (`LAST_SWEEP_MS`)이 실제로 뛰는지 본다. 첫 스윕이 **자기 전에** 오므로 즉시 관측된다.
    #[test]
    fn starting_the_sweeper_actually_makes_it_sweep() {
        let _g = registry_test_lock();
        reset_sweeper_for_test();
        assert_eq!(last_sweep_ms_for_test(), 0, "맥박을 못 내렸다 — 이 못은 무효다");
        start_sweeper();
        let deadline = Instant::now() + Duration::from_millis(3_000);
        while last_sweep_ms_for_test() == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_ne!(
            last_sweep_ms_for_test(),
            0,
            "★스윕 스레드를 띄웠는데 3초가 지나도 한 번도 안 쓸었다 — 회수 루프가 안 돈다"
        );
    }

    /// ★D1형 — 관측점은 **양쪽**을 봐야 한다.
    ///
    /// R2는 `START_CALLS`로 「기동을 안 걸었는가」(0이어야 한다)만 봤다. 그래서 계수기를
    /// 통째로 지워도 초록이었다 — 0은 언제나 0이기 때문이다. 「걸어야 할 때 걸었는가」를
    /// 여기서 본다. `start`는 이 기계에 서버가 있든 없든 **불린 사실**을 남겨야 한다.
    #[test]
    fn asking_for_a_server_is_always_counted_as_a_start_call() {
        let _g = registry_test_lock();
        let spec = crate::spec::spec_by_id("ts").unwrap();
        let root = fixture_root("startcalls");
        let _ = std::fs::create_dir_all(&root);
        let before = start_calls();
        // 자리를 미리 「기동 중」으로 만들어 둔다 — 이 못이 진짜 프로세스를 안 띄우게.
        // (묻는 것은 「띄웠는가」가 아니라 「기동을 걸었다고 셌는가」다.)
        {
            let key = key_of(spec, &root);
            let (m, _) = reg();
            let mut r = m.lock().unwrap();
            let e = r.map.entry(key).or_insert_with(Entry::empty);
            e.server = None;
            e.spawning = true;
        }
        let _ = start(spec, &root);
        let _ = start(spec, &root);
        assert_eq!(
            start_calls().saturating_sub(before),
            2,
            "★기동 요청을 걸었는데 관측점이 안 움직였다 — 계수기를 지워도 아무도 안 짖는다\
             (크리틱 R2 §4-B D1)"
        );
        drop_entry_for_test(spec, &root);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// ★LSPIDLE R3 마감 — **규약을 못으로 박는다**: 전역 레지스트리를 만지는 못은
    /// 예외 없이 [`registry_test_lock`]을 쥔다.
    ///
    /// 왜 한 줄 고침으로 안 끝냈나. 이 기능의 이력에서 **같은 모양이 세 번째**다:
    /// R2-7의 `semcache` 픽스처 오염(다른 못의 gc가 방금 쓴 파일을 지웠다) · R3이
    /// 레지스트리 픽스처를 들이면서 드러난 `files_changed_is_silent_without_a_live_server` ·
    /// 그 옆에 나란히 있던 `the_lifecycle_diagnostic_reports_the_grace`와
    /// `prewarm_prepares_without_spawning_a_single_process`. 셋 다 **원래 있던 못**이고,
    /// 전역 상태를 만지는 못이 하나 늘 때마다 자물쇠를 안 쥔 옛 못이 하나씩 드러났다.
    /// 즉 고쳐야 할 것은 그 못들이 아니라 **「다음에 또 이렇게 추가된다」**는 쪽이다.
    ///
    /// 그래서 소스를 읽는다. `#[test]` 본문에 전역 레지스트리를 만지는 문이 있으면
    /// 같은 본문에 `registry_test_lock()`이 있어야 한다. 새 못이 자물쇠 없이 들어오면
    /// **그 못이 아니라 이 못이** 붉어지고, 메시지가 무엇을 해야 하는지 말한다.
    ///
    /// 한계는 정직하게 적는다: 문자열 검색이라 **이름이 겹치면 오탐**할 수 있고,
    /// 간접 호출(`let f = live_count; f()`)은 못 본다. 그래도 실제로 일어난 세 번을
    /// 전부 잡고, 값싸며, 틀리면 붉어지는 쪽으로 틀린다.
    #[test]
    fn every_test_that_touches_the_global_registry_holds_the_lock() {
        // 이 못 자신도 자물쇠를 쥔다 — 아래 목록이 **본문에 그대로** 들어 있어서
        // 자기 자신이 「레지스트리를 만지는 못」으로 걸리기 때문이다. 예외를 두는 대신
        // 규약을 그대로 지키는 편이 낫다(쥐는 것은 무해하다 — 소스만 읽는다).
        let _g = registry_test_lock();

        /// 전역 레지스트리를 읽거나 쓰는 문들. 괄호까지 적어 이름 겹침을 줄인다.
        const TOUCHES: &[&str] = &[
            "sweep_idle(",
            "live_count(",
            "live_pids(",
            "reclaim_stats(",
            "grace_count(",
            "start_calls(",
            "lifecycle()",
            "project_status(",
            "files_changed(",
            "dispose_all(",
            "start_sweeper(",
            "seed_server_for_test(",
            "seed_error_for_test(",
            "entry_state_for_test(",
            "drop_entry_for_test(",
            "reset_sweeper_for_test(",
            "last_sweep_ms_for_test(",
        ];
        const SOURCES: &[(&str, &str)] = &[
            ("manager.rs", include_str!("manager.rs")),
            ("lib.rs", include_str!("lib.rs")),
            ("server.rs", include_str!("server.rs")),
        ];

        let mut naked: Vec<String> = Vec::new();
        for (file, src) in SOURCES {
            // `#[test]` 하나부터 **다음 `#[test]`까지**를 그 못의 몫으로 본다. 중괄호를
            // 세지 않는 이유: 본문의 포맷 문자열(`"{v}"`·`"{{}}"`)이 균형을 흔든다.
            // 넓게 잡는 쪽으로 틀리므로 **놓치지는 않고**, 넓어서 생기는 오탐은 위 한계다.
            let blocks: Vec<&str> = src.split("#[test]").skip(1).collect();
            for b in blocks {
                let name = b
                    .split("fn ")
                    .nth(1)
                    .and_then(|s| s.split(['(', '<']).next())
                    .unwrap_or("?")
                    .trim();
                let Some(hit) = TOUCHES.iter().find(|t| b.contains(**t)) else { continue };
                if !b.contains("registry_test_lock()") {
                    naked.push(format!("{file}::{name} (「{hit}」를 부른다)"));
                }
            }
        }
        assert!(
            naked.is_empty(),
            "★전역 레지스트리를 만지면서 자물쇠를 안 쥔 못이 있다 — 기본 병렬에서 남의 픽스처와 \
             경합해 **가끔** 붉어진다(이 기능에서 세 번 났다). 그 못 맨 앞에 \
             `let _g = registry_test_lock();` 한 줄을 넣어라: {naked:?}"
        );
    }

    /// 위 못이 **실제로 문다**는 대조 — 규약을 어긴 모양을 합성해 먹인다.
    /// (「필터가 아무것도 안 골랐다」와 「전부 지킨다」는 겉보기가 같다.)
    #[test]
    fn the_lock_convention_nail_actually_bites_a_naked_test() {
        let _g = registry_test_lock();
        // ★어트리뷰트 리터럴을 **쪼개서** 만든다. 통째로 적으면 위 못의 스캐너가 이 줄을
        //   진짜 못의 시작으로 읽어 `a_naked_one`이라는 유령 못을 만들어 낸다(실제로 그랬다).
        //   계기가 자기가 재는 대상을 오염시키지 않게 하는 자리다.
        let attr = concat!("#[te", "st]");
        let fake = format!("{attr}\nfn a_naked_one() {{\n    sweep_idle();\n}}\n");
        let blocks: Vec<&str> = fake.split(attr).skip(1).collect();
        assert_eq!(blocks.len(), 1);
        assert!(blocks[0].contains("sweep_idle("), "합성 픽스처가 규약 위반이 아니다");
        assert!(!blocks[0].contains("registry_test_lock()"), "합성 픽스처가 이미 자물쇠를 쥐었다");
    }

    /// 서버가 하나도 없어도 스윕은 죽지 않는다(원장 스윕까지 포함해서).
    #[test]
    fn sweeping_an_empty_registry_is_harmless() {
        // ★LSPIDLE R3 — 위 못들이 자리를 합성하므로 같은 자물쇠를 쥔다(안 그러면
        //   「비어 있다」를 세는 이 못이 남의 픽스처를 본다).
        let _g = registry_test_lock();
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
