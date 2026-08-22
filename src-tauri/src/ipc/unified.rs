//! **통합 스토어(chats-v3) 채널 + 과도기 별칭 어댑터** — `CCG_UNIFIED_STORE=1`에서만 산다.
//!
//! 기본값은 **꺼짐**이다. 마이그레이션 PoC와 크리틱을 통과하기 전에는 사용자의 대화가
//! 옛 3스토어 경로로만 오간다 — 되돌릴 곳이 있는 상태를 유지한다.
//!
//! | | 채널 | 하는 일 |
//! |---|---|---|
//! | 코어(§6.1) | `chats:get/load/save/set-active` · `board:get/load/save` | 통합 레코드 |
//! | 별칭(§6.2) | 같은 `chats:*` + `ma:*` + `talk:*` + `session-wins:list` | 옛 블롭 모양으로 되그리기/번역 |
//!
//! 재조립·번역의 **본체는 `ccg_store::legacy_bridge`** 다(마이그레이션 하네스가 앱 없이
//! 같은 코드를 돌려야 하므로). 여기는 채널 → 그 함수의 배선뿐이다.

use super::{arg, ch};
use serde_json::{json, Value};
use tauri::AppHandle;

pub fn dispatch(_app: &AppHandle, channel: &str, p: &Value) -> Option<Value> {
    // 첫 통합 채널 접촉에서 1회 마이그레이션(이미 됐으면 no-op)
    if matches!(
        channel,
        ch::CHATS_GET
            | ch::CHAT_LOAD
            | ch::CHATS_SAVE
            | ch::CHATS_SET_ACTIVE
            | ch::BOARD_GET
            | ch::BOARD_LOAD
            | ch::BOARD_SAVE
            | ch::MA_GET
            | ch::MA_SAVE
            | ch::MA_LOAD_SESSION
    ) {
        ensure_migrated();
    }
    Some(match channel {
        // ── 스토어 코어 + 본채팅 별칭 ───────────────────────────────────────
        ch::CHATS_GET => {
            let opts = arg(p, 0);
            let light = opts.get("light").and_then(Value::as_bool).unwrap_or(true);
            let open: Vec<String> = opts
                .get("openChatIds")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_default();
            ccg_store::legacy_bridge::chats_get(light, &open)
        }
        ch::CHAT_LOAD => match arg(p, 0).as_str() {
            Some(id) => ccg_store::legacy_bridge::chats_load(id),
            None => Value::Null,
        },
        ch::CHATS_SAVE => {
            ccg_store::legacy_bridge::chats_save(arg(p, 0));
            Value::Null
        }
        // ★ 즉시 반영 — 저장 디바운스와 무관해야 "전환 직후 전송"이 남의 런타임에 안 붙는다
        ch::CHATS_SET_ACTIVE => json!(arg(p, 0).as_str().map(ccg_store::chats_v3::set_active).unwrap_or(false)),

        // ── 보드 ────────────────────────────────────────────────────────────
        ch::BOARD_GET => ccg_store::boards::read_boards(),
        ch::BOARD_LOAD => ccg_store::boards::read_board(arg(p, 0)),
        ch::BOARD_SAVE => {
            ccg_store::boards::write_boards(arg(p, 0));
            Value::Null
        }

        // ── 멀티 별칭 (board:* + chats:* 재조립) ───────────────────────────
        ch::MA_GET => ccg_store::legacy_bridge::ma_get(true),
        ch::MA_SAVE => {
            ccg_store::legacy_bridge::ma_save(arg(p, 0));
            Value::Null
        }
        ch::MA_LOAD_SESSION => match arg(p, 0).as_str() {
            Some(id) => ccg_store::legacy_bridge::ma_session(id, false),
            None => Value::Null,
        },

        // ── 채팅 모드 — 마이그레이션이 흡수했다(§6.2 표) ────────────────────
        ch::TALK_GET => ccg_store::talk::empty_blob(),
        ch::TALK_SAVE => Value::Null, // no-op

        // ── 추가 채팅 목록 별칭 (★R2 D7) ───────────────────────────────────
        ch::SESSION_WINS_LIST => {
            ensure_migrated();
            session_wins_list()
        }

        _ => return None,
    })
}

/// 열린 창(셸이 소유) + **영속된 추가 채팅**(스토어가 소유)을 합친 목록.
///
/// 2.6.2는 추가 채팅 창을 닫아도 사이드바에 남겼다(클릭하면 창을 되만든다). 3.0의
/// `win.rs session_list()`는 **열린 창만** 돌려주므로, 마이그레이션된 추가 채팅이 파일로는
/// 살아 있는데 화면 어디에도 없었다 — 사용자 눈에는 대화 증발과 구분되지 않는다(크리틱 D7).
/// 창 소유권은 그대로 셸에 두고, 여기서 **스토어의 진실만 얹는다**.
fn session_wins_list() -> Value {
    let open = crate::win::session_list();
    let mut out: Vec<Value> = open.as_array().cloned().unwrap_or_default();
    let open_ids: std::collections::HashSet<String> =
        out.iter().filter_map(|w| w.get("id").and_then(Value::as_str).map(str::to_string)).collect();
    for info in ccg_store::legacy_bridge::session_chat_infos() {
        let id = info.get("id").and_then(Value::as_str).unwrap_or("");
        if !open_ids.contains(id) {
            out.push(info);
        }
    }
    Value::Array(out)
}

/// 첫 통합 채널 접촉에서 1회 마이그레이션.
/// ★R2 D8 — `ok:false`(찢어진 커밋 등)면 **ONCE를 소비하지 않는다.** R1은 실패를
/// eprintln만 하고 넘어가, 보드 없는 영구 상태로 굳는 경로가 열려 있었다.
fn ensure_migrated() {
    use std::sync::atomic::{AtomicBool, Ordering};
    static DONE: AtomicBool = AtomicBool::new(false);
    static RUNNING: std::sync::Mutex<()> = std::sync::Mutex::new(());
    if DONE.load(Ordering::Acquire) {
        return;
    }
    let _lock = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
    if DONE.load(Ordering::Acquire) {
        return;
    }
    let r = ccg_store::migrate_v3::ensure_migrated();
    let skipped = r.get("skipped").and_then(Value::as_bool) == Some(true);
    let ok = skipped || r.get("ok").and_then(Value::as_bool) == Some(true);
    if !skipped {
        eprintln!("[store] chats-v3 마이그레이션: {r}");
    }
    if ok {
        DONE.store(true, Ordering::Release);
    } else {
        eprintln!("[store] 마이그레이션 미완 — 다음 통합 채널 접촉에서 재시도한다");
    }
}
