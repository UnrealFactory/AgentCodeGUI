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
        ch::ENGINE_AUTO_UPDATE => {
            if let Some(enabled) = arg(p, 0).as_bool() {
                let _ = ccg_store::write_home_file(
                    "engine-auto-update.json",
                    &json!({ "enabled": enabled }).to_string(),
                );
            }
            json!(auto_update())
        }
        // 부팅 엔진 업데이트 흐름은 M3(엔진)과 함께 — 지금은 "돌고 있지 않다"가 진실.
        ch::ENGINE_UPDATE_STATUS => json!({
            "active": false, "items": [], "cleanup": "pending", "freedBytes": 0, "done": false
        }),
        ch::ENGINE_STATE => engine_state("engines", "config.json", "@anthropic-ai/claude-agent-sdk"),
        ch::CODEX_ENGINE_STATE => engine_state("codex-engines", "codex-config.json", "@openai/codex"),

        _ => return None,
    })
}

// ── 엔진 버전 상태 ───────────────────────────────────────────────────────────
fn auto_update() -> bool {
    // 2.6.2: 파일이 없거나 깨졌으면 켬(기본값), enabled === false 일 때만 끔
    ccg_store::read_home_json("engine-auto-update.json")
        .and_then(|v| v.get("enabled").and_then(Value::as_bool))
        .unwrap_or(true)
}

/// 대략적인 semver 내림차순 (2.6.2 compareVersionsDesc와 같은 자릿수 비교)
fn cmp_desc(a: &str, b: &str) -> std::cmp::Ordering {
    let pa: Vec<i64> = a.split('.').map(|x| x.parse().unwrap_or(0)).collect();
    let pb: Vec<i64> = b.split('.').map(|x| x.parse().unwrap_or(0)).collect();
    for i in 0..pa.len().max(pb.len()) {
        let d = pb.get(i).copied().unwrap_or(0) - pa.get(i).copied().unwrap_or(0);
        if d != 0 {
            return d.cmp(&0);
        }
    }
    std::cmp::Ordering::Equal
}

/// 앱 홈에 버전별로 깔린 엔진 CLI의 실제 설치 상태. `bundled`는 3.0에 없다 —
/// 2.6.2는 앱에 SDK를 번들해 폴백으로 썼지만, 3.0은 Rust가 CLI를 직접 몬다(M3).
fn engine_state(dir: &str, config: &str, package: &str) -> Value {
    let home = ccg_store::app_home();
    let root = home.join(dir);
    let mut installed: Vec<String> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&root) {
        for e in entries.flatten() {
            if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            // 진짜 설치본인지 = node_modules/<pkg>/package.json의 version이 읽히는지
            let mut pkg_json = root.join(&name).join("node_modules");
            for part in package.split('/') {
                pkg_json = pkg_json.join(part);
            }
            let ok = std::fs::read_to_string(pkg_json.join("package.json"))
                .ok()
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                .and_then(|v| v.get("version").and_then(Value::as_str).map(str::to_string))
                .is_some();
            if ok {
                installed.push(name);
            }
        }
    }
    installed.sort_by(|a, b| cmp_desc(a, b));
    let active = std::fs::read_to_string(home.join(config))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("activeVersion").and_then(Value::as_str).map(str::to_string))
        .filter(|v| installed.contains(v));
    json!({
        "package": package,
        "bundled": "unknown",
        "active": active,
        "installed": installed
    })
}
