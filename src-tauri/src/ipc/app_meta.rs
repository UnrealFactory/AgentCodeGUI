//! 앱 메타 · 자동 업데이트 · 엔진 버전 상태. (ipc.rs에서 분리 — 동작 불변)

use super::{arg, ch};
use serde_json::{json, Value};

pub fn dispatch(channel: &str, p: &Value) -> Option<Value> {
    Some(match channel {
        // ── app meta ────────────────────────────────────────────────────────
        ch::APP_GET_VERSION => json!(env!("CARGO_PKG_VERSION")),
        // "AgentCodeGUI로 열기"(파일 탐색기 컨텍스트 메뉴)의 **콜드 런치 반쪽**.
        // 명령줄에 실려 온 폴더를 그대로 돌려준다(★파리티 R1 M2). 이미 떠 있는 앱에
        // 폴더가 또 오는 경우(`app:open-directory`)는 단일 인스턴스 잠금이 있어야 하고,
        // 그건 격리 홈 하네스 동시 주행을 죽이므로 설치기 라운드와 함께 간다 —
        // 이유는 `ipc/parity/misc.rs initial_dir` 주석에.
        ch::APP_GET_INITIAL_DIR => super::parity::misc::initial_dir(),
        // 앱 자동 업데이트(electron-updater 자리)는 아직 없다 — 정직하게 idle.
        // AppUpdateGate는 phase가 available/downloading/downloaded/error일 때만 뜬다.
        ch::UPDATE_GET_STATUS => json!({
            "phase": "idle", "version": Value::Null, "percent": 0, "log": [], "error": Value::Null
        }),

        // ── engine ─────────────────────────────────────────────────────────
        // 두 엔진 CLI 공통 자동 업데이트 플래그. 인자 있으면 설정, 항상 현재 값 반환.
        // 판정은 부팅 게이트와 **같은 함수**가 한다 — 화면의 토글과 실제로 도는 흐름이
        // 다른 사본을 읽으면 "켜 놨는데 안 돈다"가 조용히 생긴다.
        ch::ENGINE_AUTO_UPDATE => {
            if let Some(enabled) = arg(p, 0).as_bool() {
                let _ = ccg_store::write_home_file(
                    "engine-auto-update.json",
                    &json!({ "enabled": enabled }).to_string(),
                );
            }
            json!(crate::engine::boot_update::auto_update())
        }
        // ★R28 T1T2 R2 — R1까지 이 자리는 하드코딩 `{active:false}`였고 `engine:update-event`
        // 방출자는 0이었다. 그래서 `EngineGate`는 "자동 업데이트가 할 테니 비켜"라며
        // 물러나고 그 자동 업데이트는 존재하지 않았다(확인 크리틱 §4.2). 이제 진짜
        // 부팅 흐름의 스냅샷이다.
        ch::ENGINE_UPDATE_STATUS => crate::engine::boot_update::status(),
        ch::ENGINE_STATE => engine_state(&ccg_engine::versions::CLAUDE),
        ch::CODEX_ENGINE_STATE => engine_state(&ccg_engine::versions::CODEX),

        _ => return None,
    })
}

/// 앱 홈에 버전별로 깔린 엔진 CLI의 실제 설치 상태. `bundled`는 3.0에 없다 —
/// 2.6.2는 앱에 SDK를 번들해 폴백으로 썼지만, 3.0은 Rust가 CLI를 직접 몬다(M3).
///
/// ★R28 T1T2 R2 — R1까지 여기 `installed`/`active` 판정과 `cmp_desc`의 **사본**이
/// 있었다(확인 크리틱 §4.3: "세 번째 벌"). 판정 자체는 같았지만, 같은 질문에 두 코드가
/// 답하면 한쪽만 고쳐지는 순간 조용히 갈린다 — `ccg_engine::versions` 한 벌로 모은다.
fn engine_state(spec: &ccg_engine::versions::Spec) -> Value {
    let home = ccg_store::app_home();
    json!({
        "package": spec.package,
        "bundled": "unknown",
        "active": spec.active_version(&home),
        "installed": spec.list_installed(&home),
    })
}
