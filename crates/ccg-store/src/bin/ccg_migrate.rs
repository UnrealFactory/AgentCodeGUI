//! `ccg-migrate` — 마이그레이션 하네스 전용 CLI(`--features cli`).
//!
//! 앱을 띄우지 않고 `CCG_HOME`의 3스토어를 chats-v3로 옮긴다. 검증 스크립트
//! (`scripts/poc-chat-unify-migrate.mjs`)가 before/after 인벤토리를 수집하는 사이에
//! **실제 프로덕션 코드**(`ccg_store::migrate_v3`)를 돌리는 게 목적이다 — 하네스가
//! 자기만의 마이그레이터를 흉내 내면 검증이 자기 자신을 검사하게 된다.
//!
//! 사용:
//! ```text
//! CCG_HOME=<홈> cargo run -p ccg-store --features cli --bin ccg-migrate -- migrate [--no-backup]
//! CCG_HOME=<홈> cargo run -p ccg-store --features cli --bin ccg-migrate -- read-chats [--light]
//! CCG_HOME=<홈> cargo run -p ccg-store --features cli --bin ccg-migrate -- save-chats <파일>
//! CCG_HOME=<홈> cargo run -p ccg-store --features cli --bin ccg-migrate -- read-boards
//! CCG_HOME=<홈> cargo run -p ccg-store --features cli --bin ccg-migrate -- status
//! CCG_HOME=<홈> cargo run -p ccg-store --features cli --bin ccg-migrate -- set-owned <chatId> <field> <파일|null>
//! CCG_HOME=<홈> cargo run -p ccg-store --features cli --bin ccg-migrate -- api-status
//! ```
//! 출력은 언제나 JSON 한 줄(stdout).

use serde_json::{json, Value};

fn out(v: Value) -> ! {
    println!("{v}");
    std::process::exit(0)
}

fn fail(msg: &str) -> ! {
    println!("{}", json!({ "ok": false, "error": msg }));
    std::process::exit(2)
}

/// 이 프로세스의 피크 워킹셋(바이트) — 부하 픽스처 수치를 리포트에 남기려고 잰다.
#[cfg(windows)]
fn peak_working_set() -> u64 {
    use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows::Win32::System::Threading::GetCurrentProcess;
    unsafe {
        let mut c = PROCESS_MEMORY_COUNTERS::default();
        let size = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        match GetProcessMemoryInfo(GetCurrentProcess(), &mut c, size) {
            Ok(()) => c.PeakWorkingSetSize as u64,
            Err(_) => 0,
        }
    }
}
#[cfg(not(windows))]
fn peak_working_set() -> u64 {
    0
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if std::env::var("CCG_HOME").map(|v| v.is_empty()).unwrap_or(true) {
        fail("CCG_HOME이 필요하다 — 사용자 실홈을 건드리지 않기 위한 안전장치");
    }
    let cmd = args.first().map(String::as_str).unwrap_or("");
    match cmd {
        "migrate" => {
            let backup = !args.iter().any(|a| a == "--no-backup");
            let mut r = ccg_store::migrate_v3::migrate(backup);
            if let Some(o) = r.as_object_mut() {
                o.insert("peakWorkingSetBytes".into(), json!(peak_working_set()));
            }
            out(r)
        }
        "read-chats" => {
            let light = args.iter().any(|a| a == "--light");
            let open: Vec<String> = args
                .iter()
                .skip_while(|a| *a != "--open")
                .skip(1)
                .take_while(|a| !a.starts_with("--"))
                .cloned()
                .collect();
            out(ccg_store::chats_v3::read_chats(light, &open))
        }
        "load-chat" => {
            let Some(id) = args.get(1) else { fail("chatId 인자가 없다") };
            out(ccg_store::chats_v3::read_chat(&json!(id)))
        }
        "save-chats" => {
            let Some(p) = args.get(1) else { fail("페이로드 파일 인자가 없다") };
            let Ok(raw) = std::fs::read_to_string(p) else { fail("페이로드 파일을 못 읽었다") };
            let Ok(v) = serde_json::from_str::<Value>(&raw) else { fail("페이로드가 JSON이 아니다") };
            ccg_store::chats_v3::write_chats(&v);
            ccg_store::status::flush();
            out(json!({ "ok": true }))
        }
        // ── 과도기 별칭 다리(§5.3-3 왕복 검사) ─────────────────────────────
        "alias-chats-get" => {
            let light = args.iter().any(|a| a == "--light");
            out(ccg_store::legacy_bridge::chats_get(light, &[]))
        }
        "alias-chats-save" => {
            let Some(p) = args.get(1) else { fail("페이로드 파일 인자가 없다") };
            let Ok(raw) = std::fs::read_to_string(p) else { fail("페이로드 파일을 못 읽었다") };
            let Ok(v) = serde_json::from_str::<Value>(&raw) else { fail("페이로드가 JSON이 아니다") };
            ccg_store::legacy_bridge::chats_save(&v);
            out(json!({ "ok": true }))
        }
        "alias-ma-get" => {
            let light = args.iter().any(|a| a == "--light");
            out(ccg_store::legacy_bridge::ma_get(light))
        }
        "alias-ma-save" => {
            let Some(p) = args.get(1) else { fail("페이로드 파일 인자가 없다") };
            let Ok(raw) = std::fs::read_to_string(p) else { fail("페이로드 파일을 못 읽었다") };
            let Ok(v) = serde_json::from_str::<Value>(&raw) else { fail("페이로드가 JSON이 아니다") };
            ccg_store::legacy_bridge::ma_save(&v);
            out(json!({ "ok": true }))
        }
        "set-active" => {
            let Some(id) = args.get(1) else { fail("chatId 인자가 없다") };
            out(json!({ "ok": ccg_store::chats_v3::set_active(id), "activeChatId": ccg_store::chats_v3::active_chat_id() }))
        }
        "read-boards" => out(ccg_store::boards::read_boards()),
        "save-boards" => {
            let Some(p) = args.get(1) else { fail("페이로드 파일 인자가 없다") };
            let Ok(raw) = std::fs::read_to_string(p) else { fail("페이로드 파일을 못 읽었다") };
            let Ok(v) = serde_json::from_str::<Value>(&raw) else { fail("페이로드가 JSON이 아니다") };
            ccg_store::boards::write_boards(&v);
            out(json!({ "ok": true }))
        }
        // 앱 부팅과 같은 순서: status.json 장전(+얕은 스캔) → 재장전 후보
        "status" => out(json!({
            "statuses": ccg_store::chats_v3::boot_statuses(),
            "reloadCandidates": ccg_store::chats_v3::reload_candidates(),
        })),
        "set-owned" => {
            let (Some(id), Some(field), Some(p)) = (args.get(1), args.get(2), args.get(3)) else {
                fail("set-owned <chatId> <field> <파일|null>")
            };
            let v = if p == "null" {
                Value::Null
            } else {
                let Ok(raw) = std::fs::read_to_string(p) else { fail("값 파일을 못 읽었다") };
                serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null)
            };
            ccg_store::chats_v3::set_owned(id, field, v);
            out(json!({ "ok": true }))
        }
        // 키 쓰기 스킴 검증용(D6) — 키 원문은 인자로만 받고 출력에 싣지 않는다
        "set-api-key" => {
            let Some(k) = args.get(1) else { fail("set-api-key <키>") };
            ccg_store::api_config::set_api_key(k);
            out(json!({ "ok": true, "scheme": ccg_store::safe_storage::write_scheme() }))
        }
        "api-status" => out(json!({
            "status": ccg_store::api_config::status(),
            // 키 원문은 절대 싣지 않는다 — 복호가 됐는지(승계 성공)와 길이만
            "keyDecrypts": ccg_store::api_config::api_key().is_some(),
            "keyLen": ccg_store::api_config::api_key().map(|k| k.len()).unwrap_or(0),
            "openaiDecrypts": ccg_store::api_config::openai_api_key().is_some(),
            "encryptionAvailable": ccg_store::safe_storage::available(),
        })),
        "talk" => out(ccg_store::talk::read()),
        "api-usage" => out(ccg_store::api_usage::list()),
        _ => fail("알 수 없는 명령"),
    }
}
