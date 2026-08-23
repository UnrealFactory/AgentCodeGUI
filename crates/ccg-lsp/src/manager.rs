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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// 죽은/실패한 서버는 이만큼 지나야 다시 띄운다(2.6.2 RESPAWN_COOLDOWN).
/// 밖에서 죽인 서버의 **자동 복귀 시간**이기도 하다 — 2.6.2 실측 30.6초와 같은 자리.
const RESPAWN_COOLDOWN_MS: u64 = 30_000;
const SWEEP_EVERY_MS_DEFAULT: u64 = 60_000;
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
}

impl Entry {
    fn empty() -> Entry {
        Entry { server: None, spawning: false, died_at_ms: 0, last_error: None }
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

fn start_sweeper() {
    if SWEEPER.swap(true, Ordering::SeqCst) {
        return;
    }
    let every = env_u64("CCG_LSP_SWEEP_MS").unwrap_or(SWEEP_EVERY_MS_DEFAULT);
    std::thread::Builder::new()
        .name("ccg-lsp-sweep".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_millis(every));
            sweep_idle();
        })
        .ok();
}

/// 유휴 회수 + 좀비 정리. 스윕 스레드가 부르고, 테스트가 직접 부를 수도 있다.
pub fn sweep_idle() {
    let mut doomed: Vec<(Arc<Server>, &'static str)> = Vec::new();
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
            // ② 유휴 회수
            if s.idle_ms() >= ttl_for(s.spec) {
                doomed.push((s.clone(), "유휴 서버 회수"));
                e.server = None;
                e.died_at_ms = 0; // 정상 회수 — 쿨다운 없이 다음 요청이 바로 되살린다
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

    /// 없는 폴더도 키를 만들 수 있어야 한다(canonicalize 실패 → 문법적 정규화).
    #[test]
    fn key_survives_missing_folder() {
        let spec = crate::spec::spec_by_id("ts").unwrap();
        let a = key_of(spec, Path::new("C:\\ccg-nope\\x\\..\\y"));
        let b = key_of(spec, Path::new("C:/ccg-nope/y/"));
        assert_eq!(a, b, "{a} != {b}");
    }
}
