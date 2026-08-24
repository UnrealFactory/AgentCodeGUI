//! **부팅 엔진 자동 업데이트** — 2.6.2 `src/main/index.ts:2046 runBootEngineUpdate`의 3.0 자리.
//!
//! ## 왜 있나 (R28 T1T2 확인 크리틱 §4.2가 실패시킨 그 한 줄)
//!
//! T2가 `engine:*` 다섯 채널을 붙였는데도 *「CLI가 없는 컴퓨터에서 아무 안내도 안 뜬다」*
//! 는 증상이 **기본 설정에서 그대로**였다. 이유는 두 카드가 서로를 가렸기 때문이다:
//!
//! ```text
//!   EngineGate        "자동 업데이트가 켜져 있으니(기본 켬) 저쪽이 알아서 한다" → 물러남
//!   EngineUpdateGate  engine:update-status 가 하드코딩 {active:false} · 방출자 0 → 영영 안 뜸
//! ```
//!
//! 실측(크리틱, 격리 홈 · engines 0개 · `CCG_CLAUDE_BIN=''`): 25초 폴링 동안
//! `.sd-title = null` · `.eu-card = 0`. `engine-auto-update.json {enabled:false}`를
//! **심어야만** 안내가 떴다 — 즉 픽스처가 켜 주던 초록이었다.
//!
//! 2.6.2는 같은 판에서 침묵하지 않는다. 부팅 직후 두 엔진의 최신 버전을 조회해
//! **설치 → 활성화 → 이전 버전 정리**까지 끝내고 그 진행을 카드로 보여 준다. 이 파일이
//! 그 흐름이고, 방출하는 스냅샷(`engine:update-event`)의 모양은 계약면
//! `EngineUpdateStatus`(`src/shared/protocol.ts:984`) 그대로다.
//!
//! ## 왜 부팅 직후인가 (2.6.2 주석의 논거를 그대로 승계)
//!
//! 아직 어떤 세션도 돌기 전이라 **옛 버전 삭제가 실행 중 CLI를 물 수 없는 유일한 시점**이다.
//! 6시간 주기([`silent`])는 설치·활성화만 하고 삭제는 하지 않는다 — 진행 중 세션의 CLI가
//! 옛 폴더에서 돌고 있으면 Windows 파일 잠금으로 반쯤 지워지다 실패하고, 최악은 그 턴이
//! 깨진다. 남은 옛 버전은 다음 부팅 게이트가 정리한다.
//!
//! ## 하네스 규약
//!
//! 이 흐름은 **npm 왕복 + 수백 MB 설치**다. 격리 홈으로 앱을 띄우는 하네스가 전부
//! 그걸 시작하면 안 되므로 귀속 팔 `CCG_NO_BOOT_ENGINE_UPDATE=1`로 통째로 끌 수 있다
//! (`flags.rs` — 기본값은 켬이라 제품 동작은 한 글자도 안 바뀐다). `bench/fixture.mjs`가
//! 심는 `engine-auto-update.json {enabled:false}`도 여전히 같은 효과다.

use ccg_engine::versions::{cmp_desc, Spec, CLAUDE, CODEX};
use serde_json::{json, Value};
use std::cmp::Ordering;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering as Ord2};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// 계약면 `IPC.engineUpdateEvent`(`src/shared/protocol.ts:1240`) — REPLACE 스냅샷.
const EVENT: &str = "engine:update-event";
/// 2.6.2 `setInterval(silentEngineUpdate, 6h)`.
const SILENT_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// 2.6.2 `setTimeout(() => void runBootEngineUpdate(), 1500)` — *"렌더러가 뜬 뒤 카드가
/// 보이게 살짝 늦춘다"*. 없애면 안 되는 이유가 실제로 있다: npm 캐시가 더운 판에서는
/// 흐름이 **렌더러가 구독하기 전에 끝나** 진행 카드가 한 번도 안 뜬다
/// (`EngineUpdateGate`는 이미 `done`인 스냅샷을 뒤늦게 그리지 않는다 — `sawLiveRef`).
const BOOT_DELAY: Duration = Duration::from_millis(1500);

/// 관리 대상 엔진 하나 — 2.6.2 `updateTargets`의 한 항목.
struct Target {
    /// `EngineUpdateItem.id` — 렌더러가 로고를 고르는 값이다('claude' | 'codex').
    id: &'static str,
    label: &'static str,
    spec: Spec,
}

const TARGETS: [Target; 2] = [
    Target { id: "claude", label: "Claude Code", spec: CLAUDE },
    Target { id: "codex", label: "Codex CLI", spec: CODEX },
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ItemStatus {
    Pending,
    Installing,
    Done,
    Error,
}

impl ItemStatus {
    fn wire(self) -> &'static str {
        match self {
            ItemStatus::Pending => "pending",
            ItemStatus::Installing => "installing",
            ItemStatus::Done => "done",
            ItemStatus::Error => "error",
        }
    }
}

/// `EngineUpdateItem`(계약면) 한 줄.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Item {
    id: &'static str,
    label: &'static str,
    /// 현재 활성 버전(`null` = 신규 설치).
    from: Option<String>,
    to: String,
    status: ItemStatus,
    error: Option<String>,
}

impl Item {
    fn wire(&self) -> Value {
        let mut v = json!({
            "id": self.id, "label": self.label, "from": self.from,
            "to": self.to, "status": self.status.wire()
        });
        if let Some(e) = &self.error {
            v["error"] = json!(e);
        }
        v
    }
}

/// `EngineUpdateStatus`(계약면) 전체. **변화마다 통째로** 다시 보낸다(REPLACE).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Snapshot {
    active: bool,
    items: Vec<Item>,
    /// 'pending' | 'running' | 'done'
    cleanup: &'static str,
    freed: u64,
    done: bool,
}

impl Snapshot {
    fn fresh() -> Self {
        Snapshot { active: false, items: vec![], cleanup: "pending", freed: 0, done: false }
    }
    fn wire(&self) -> Value {
        json!({
            "active": self.active,
            "items": self.items.iter().map(Item::wire).collect::<Vec<_>>(),
            "cleanup": self.cleanup,
            "freedBytes": self.freed,
            "done": self.done,
        })
    }
}

static STATE: Mutex<Option<Snapshot>> = Mutex::new(None);
/// 부팅 흐름과 6시간 주기가 겹쳐 같은 폴더에 npm 둘을 붙이지 않게 하는 관문.
static RUNNING: AtomicBool = AtomicBool::new(false);

fn put(snap: &Snapshot) {
    *STATE.lock().unwrap_or_else(|e| e.into_inner()) = Some(snap.clone());
}

/// `engine:update-status` — 렌더러가 마운트 때 따라잡는 스냅샷 조회.
///
/// 아직 시작 전이면 `{active:false, done:false}`(= "조사 중")이다. 이 셋을 구분하는 것이
/// `EngineGate`의 새 판정 근거다: **돌고 있다**(active) / **끝났고 할 일이 없었다**(done)
/// / **아직 모른다**(둘 다 false).
pub fn status() -> Value {
    STATE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .unwrap_or_else(Snapshot::fresh)
        .wire()
}

/// 두 엔진 CLI 공통 자동 업데이트 플래그(설정 ▸ Engine · 기본 **켬**).
///
/// 2.6.2 `engineVersions.getAutoUpdate()` — 파일이 없거나 깨졌으면 켬, `enabled === false`
/// 일 때만 끔. `ipc/app_meta.rs`의 채널 핸들러도 이 함수를 부른다(사본을 만들지 않는다).
pub fn auto_update() -> bool {
    ccg_store::read_home_json("engine-auto-update.json")
        .and_then(|v| v.get("enabled").and_then(Value::as_bool))
        .unwrap_or(true)
}

/// 부팅 흐름 시작 — 셸의 `setup`이 창을 만든 직후 한 줄로 부른다.
///
/// 자기 스레드에서 돈다: `npm view`는 8초 상한이고 `npm install`은 수십 초라 이벤트
/// 루프에서 돌면 창이 그동안 얼어붙는다.
pub fn spawn(app: AppHandle) {
    if crate::flags::no_boot_engine_update() {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(BOOT_DELAY);
        run_boot(&app);
        loop {
            std::thread::sleep(SILENT_EVERY);
            silent();
        }
    });
}

/// 이 엔진에 할 일이 있나 — 2.6.2의 판정 한 줄을 그대로 옮긴 **순수 함수**.
///
/// - `latest`가 없다(오프라인·레지스트리 오류) → 건너뛴다(다음 부팅에 재시도).
/// - 활성이 latest **이상**이면 할 일 없음. `===`만 보던 2.6.2 초기 판정이 프리뷰↔stable
///   무한 사이클의 원인이었다: 프리뷰가 활성인데 stable을 "업데이트"로 깔면 정리 단계가
///   수치상 최신인 프리뷰만 남기고 방금 깐 stable을 도로 지운다.
fn plan(id: &'static str, label: &'static str, latest: Option<&str>, active: Option<&str>) -> Option<Item> {
    let to = latest?;
    if let Some(a) = active {
        if cmp_desc(to, a) != Ordering::Less {
            return None; // 활성 >= 최신
        }
    }
    Some(Item {
        id,
        label,
        from: active.map(str::to_string),
        to: to.to_string(),
        status: ItemStatus::Pending,
        error: None,
    })
}

/// 설치본이 둘 이상일 때만 정리한다(2.6.2와 같은 조건 — 하나뿐이면 지울 게 없다).
fn cleanup_if_stale(spec: &Spec, home: &Path) -> u64 {
    if spec.list_installed(home).len() > 1 {
        return spec.cleanup_old(home).freed_bytes;
    }
    0
}

/// ★ 부팅 게이트 본체 — 조사 → 설치 → 활성화 → 정리.
fn run_boot(app: &AppHandle) {
    if !auto_update() || RUNNING.swap(true, Ord2::SeqCst) {
        return;
    }
    let home = ccg_store::app_home();
    let mut work: Vec<(usize, Item)> = vec![];
    for (i, t) in TARGETS.iter().enumerate() {
        // 조회 실패(오프라인 등) 엔진은 조용히 건너뛴다 — 다음 부팅에 재시도.
        let latest = t.spec.list_available().ok().and_then(|a| a.latest);
        if let Some(item) = plan(t.id, t.label, latest.as_deref(), t.spec.active_version(&home).as_deref()) {
            work.push((i, item));
        }
    }

    if work.is_empty() {
        // 할 일 없음 — 지난 6시간 주기(사일런트 설치)가 남긴 옛 버전만 조용히 정리하고,
        // **끝났다고 말한다**. `done && !active`가 곧 "이번 부팅엔 할 일이 없었다"이고,
        // `EngineGate`는 그 신호를 보고서야 자기 안내 카드를 띄운다(아무도 안 도니까).
        for t in TARGETS.iter() {
            cleanup_if_stale(&t.spec, &home);
        }
        let snap = Snapshot { cleanup: "done", done: true, ..Snapshot::fresh() };
        put(&snap);
        let _ = app.emit(EVENT, snap.wire());
        RUNNING.store(false, Ord2::SeqCst);
        return;
    }

    let mut snap = Snapshot { active: true, items: work.iter().map(|(_, it)| it.clone()).collect(), ..Snapshot::fresh() };
    put(&snap);
    let _ = app.emit(EVENT, snap.wire());

    for (n, (ti, _)) in work.iter().enumerate() {
        let t = &TARGETS[*ti];
        snap.items[n].status = ItemStatus::Installing;
        put(&snap);
        let _ = app.emit(EVENT, snap.wire());
        let to = snap.items[n].to.clone();
        // 이미 깔려 있으면(사일런트 주기가 깔아 두고 활성만 안 옮긴 판) 설치를 건너뛴다.
        let installed = t.spec.installed_version_at(&home, &to).is_some();
        let r = if installed { Ok(()) } else { t.spec.install(&home, &to, |_| {}) }.and_then(|()| t.spec.set_active(&home, Some(&to)));
        match r {
            Ok(()) => snap.items[n].status = ItemStatus::Done,
            Err(e) => {
                snap.items[n].status = ItemStatus::Error;
                snap.items[n].error = Some(e);
            }
        }
        put(&snap);
        let _ = app.emit(EVENT, snap.wire());
    }

    snap.cleanup = "running";
    put(&snap);
    let _ = app.emit(EVENT, snap.wire());
    for t in TARGETS.iter() {
        // 실패한 설치본은 목록에 안 잡히므로(마커 없는 반쪽 폴더) 안전 — 최신 하나만
        // 남기고 삭제하며, 활성 포인터는 `cleanup_old`가 스스로 보정한다.
        snap.freed += cleanup_if_stale(&t.spec, &home);
    }
    snap.cleanup = "done";
    snap.done = true;
    put(&snap);
    let _ = app.emit(EVENT, snap.wire());
    RUNNING.store(false, Ord2::SeqCst);
}

/// 6시간 주기 — **설치 + 활성화만**. 카드도 없고 삭제도 없다(파일 헤더의 이유).
fn silent() {
    if !auto_update() || RUNNING.swap(true, Ord2::SeqCst) {
        return;
    }
    let home = ccg_store::app_home();
    for t in TARGETS.iter() {
        let latest = t.spec.list_available().ok().and_then(|a| a.latest);
        let Some(item) = plan(t.id, t.label, latest.as_deref(), t.spec.active_version(&home).as_deref()) else {
            continue;
        };
        if t.spec.installed_version_at(&home, &item.to).is_none() && t.spec.install(&home, &item.to, |_| {}).is_err() {
            continue; // 조용히 — 다음 주기에 재시도
        }
        let _ = t.spec.set_active(&home, Some(&item.to));
    }
    RUNNING.store(false, Ord2::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2.6.2의 판정표. **가장 중요한 줄은 마지막 둘**이다 — 활성이 없으면(새 컴퓨터)
    /// 언제나 할 일이 있고, 프리뷰가 활성이면 stable로 끌어내리지 않는다.
    #[test]
    fn the_plan_matches_2_6_2s_truth_table() {
        let p = |latest: Option<&str>, active: Option<&str>| plan("claude", "Claude Code", latest, active);
        assert_eq!(p(None, None), None, "레지스트리 조회 실패 = 건너뛴다");
        assert_eq!(p(None, Some("0.3.1")), None);
        assert_eq!(p(Some("0.3.1"), Some("0.3.1")), None, "같으면 할 일 없음");
        assert_eq!(p(Some("0.3.1"), Some("0.3.2")), None, "★프리뷰 활성을 stable로 끌어내리지 않는다");
        let up = p(Some("0.3.241"), Some("0.3.9")).expect("낡은 활성 = 업데이트");
        assert_eq!((up.from.as_deref(), up.to.as_str(), up.status), (Some("0.3.9"), "0.3.241", ItemStatus::Pending));
        // ★ 엔진이 하나도 없는 컴퓨터 — 크리틱이 실패시킨 그 판
        let new = p(Some("0.3.241"), None).expect("활성이 없으면 언제나 할 일이 있다");
        assert_eq!(new.from, None, "from=null = 신규 설치(카드가 '새로 설치'로 그린다)");
    }

    /// 방출하는 봉투가 계약면 `EngineUpdateStatus`와 **키·타입까지** 같은가.
    /// (렌더러 `EngineUpdateGate`는 `items[].status`·`cleanup` 문자열로 아이콘을 고른다 —
    /// 한 글자만 달라도 카드가 빈 줄로 뜨고, 그건 화면에서만 보인다.)
    #[test]
    fn the_wire_shape_is_the_contract_shape() {
        let fresh = Snapshot::fresh().wire();
        assert_eq!(fresh, json!({ "active": false, "items": [], "cleanup": "pending", "freedBytes": 0, "done": false }));
        let snap = Snapshot {
            active: true,
            items: vec![
                Item { id: "claude", label: "Claude Code", from: None, to: "0.3.241".into(), status: ItemStatus::Installing, error: None },
                Item { id: "codex", label: "Codex CLI", from: Some("0.1.0".into()), to: "0.2.0".into(), status: ItemStatus::Error, error: Some("npm 없음".into()) },
            ],
            cleanup: "running",
            freed: 1234,
            done: false,
        };
        let w = snap.wire();
        assert_eq!(w["items"][0]["from"], Value::Null);
        assert_eq!(w["items"][0]["status"], "installing");
        assert_eq!(w["items"][1]["error"], "npm 없음");
        assert_eq!(w["cleanup"], "running");
        assert_eq!(w["freedBytes"], 1234);
        // 실패가 없는 항목엔 error 키 자체가 없다(계약면의 `error?`).
        assert!(w["items"][0].get("error").is_none());
    }

    /// 정리는 **설치본이 둘 이상일 때만** 돈다. 하나뿐인데 돌면 `cleanup_old`가
    /// 지울 것이 없어 0을 돌려주지만, 그 판에서 폴더를 걷는 비용을 부팅마다 낸다.
    #[test]
    fn cleanup_only_runs_when_there_is_something_to_clean() {
        let home = crate::engine::testhome::take("bootupd-cleanup");
        let fake = |v: &str| {
            let d = CLAUDE.package_dir(&home.dir, v);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("package.json"), format!("{{\"version\":\"{v}\"}}")).unwrap();
        };
        assert_eq!(cleanup_if_stale(&CLAUDE, &home.dir), 0, "설치본 0개");
        fake("0.3.9");
        CLAUDE.set_active(&home.dir, Some("0.3.9")).unwrap();
        assert_eq!(cleanup_if_stale(&CLAUDE, &home.dir), 0, "하나뿐이면 손대지 않는다");
        assert_eq!(CLAUDE.list_installed(&home.dir), vec!["0.3.9"]);
        fake("0.3.241");
        assert!(cleanup_if_stale(&CLAUDE, &home.dir) > 0, "둘이면 옛 것을 지우고 바이트를 센다");
        assert_eq!(CLAUDE.list_installed(&home.dir), vec!["0.3.241"]);
        // 활성이 지워졌으면 남긴 최신으로 옮겨져 있어야 한다(정리가 실행을 끊으면 안 된다).
        assert_eq!(CLAUDE.active_version(&home.dir).as_deref(), Some("0.3.241"));
    }

    /// 자동 업데이트 기본값은 **켬**이고, `enabled === false`일 때만 끔.
    /// (이 판정이 뒤집히면 부팅 게이트가 조용히 안 돈다 — 크리틱이 잡은 그 침묵이다.)
    #[test]
    fn auto_update_defaults_to_on() {
        let home = crate::engine::testhome::take("bootupd-auto");
        assert!(auto_update(), "파일이 없으면 켬");
        std::fs::write(home.dir.join("engine-auto-update.json"), br#"{"enabled":false}"#).unwrap();
        assert!(!auto_update());
        std::fs::write(home.dir.join("engine-auto-update.json"), br#"{"enabled":true}"#).unwrap();
        assert!(auto_update());
        std::fs::write(home.dir.join("engine-auto-update.json"), b"{ not json").unwrap();
        assert!(auto_update(), "깨진 파일도 켬 — 조용히 꺼지면 안 된다");
    }

    /// 상태 조회는 **시작 전에도** 계약면 모양을 준다(렌더러가 부팅 즉시 부른다).
    #[test]
    fn status_is_contract_shaped_before_anything_runs() {
        let v = status();
        for k in ["active", "items", "cleanup", "freedBytes", "done"] {
            assert!(v.get(k).is_some(), "{k} 없음: {v}");
        }
        assert_eq!(v["items"], json!([]));
    }
}
