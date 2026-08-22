//! 창 채널 — 추가 채팅 창 레지스트리 + 창 컨트롤. (ipc.rs에서 분리 — 동작 불변)
//! 실제 창 조작은 전부 `win.rs`가 한다. 여기는 채널 → 그 함수의 배선뿐이다.

use super::{arg, ch};
use serde_json::{json, Value};
use tauri::{AppHandle, WebviewWindow};

/// 저장/복원의 주소. 1순위는 **부른 창**, 2순위는 페이로드의 명시 `id`(단 그것이
/// 이미 영속된 추가 채팅일 때만 — 아무 채팅이나 이 채널로 덮어쓰지 못한다).
fn session_target(window: &WebviewWindow, payload: &Value) -> Option<String> {
    if let Some(id) = crate::engine::session_chat_for_window(window) {
        return Some(id);
    }
    let id = payload.get("id").and_then(Value::as_str)?;
    ccg_store::legacy_bridge::is_session_chat(id).then(|| id.to_string())
}

pub fn dispatch(app: &AppHandle, window: &WebviewWindow, channel: &str, p: &Value) -> Option<Value> {
    Some(match channel {
        // ── 추가 채팅 창 (창당 비용이 3.0의 주 전장 — win.rs 헤더) ──────────
        ch::OPEN_SESSION_WINDOW => {
            if let Err(e) = crate::win::open_session_window(app) {
                eprintln!("[win] 추가 채팅 창 생성 실패: {e}");
            }
            Value::Null
        }
        ch::SESSION_WINS_LIST => crate::win::session_list(),
        ch::SESSION_WINS_FOCUS => {
            if let Some(id) = arg(p, 0).as_str() {
                crate::win::session_focus(app, id);
            }
            Value::Null
        }
        ch::SESSION_WINS_CLOSE => {
            if let Some(id) = arg(p, 0).as_str() {
                crate::win::session_close(app, id);
            }
            Value::Null
        }
        ch::SESSION_REPORT => {
            let info = arg(p, 0);
            crate::win::session_report(
                app,
                window.label(),
                info.get("title").and_then(Value::as_str),
                info.get("status").and_then(Value::as_str),
            );
            Value::Null
        }

        // ── 추가 채팅 창의 대화 저장/복원 (크리틱 배선 R1 §5-S4) ─────────────
        //
        // 주소는 **창**이다(`session_chat_for_window`). 메인 창으로 오면 활성 채팅으로
        // 폴백하지 **않는다** — 그러면 추가 채팅 저장 한 번이 본채팅을 덮는다.
        // 다만 명시 `id`가 실려 오고 그것이 영속된 추가 채팅이면 그 주소를 쓴다
        // (사이드바에서 이름·상태를 만지는 경로와 하네스가 그 형태다).
        ch::SESSION_PERSIST => {
            let payload = arg(p, 0);
            match session_target(window, payload) {
                Some(id) => json!(ccg_store::legacy_bridge::session_chat_persist(&id, payload)),
                None => json!(false),
            }
        }
        ch::SESSION_HYDRATE => match session_target(window, arg(p, 0)) {
            Some(id) => ccg_store::legacy_bridge::session_chat_hydrate(&id),
            None => Value::Null,
        },
        ch::SESSION_WINS_RENAME => {
            let id = arg(p, 0).as_str().unwrap_or("").to_string();
            let title = arg(p, 1).as_str().unwrap_or("").to_string();
            let ok = ccg_store::legacy_bridge::session_chat_rename(&id, &title);
            if ok {
                crate::win::session_rename(app, &id, &title);
            }
            json!(ok)
        }

        // ── 창 컨트롤 ───────────────────────────────────────────────────────
        ch::WIN_MINIMIZE => {
            crate::win::minimize(window);
            Value::Null
        }
        ch::WIN_MAXIMIZE_TOGGLE => json!(crate::win::toggle_maximize(window)),
        ch::WIN_CLOSE => {
            crate::win::close(window);
            Value::Null
        }
        ch::WIN_IS_MAXIMIZED => json!(crate::win::is_maximized(window)),
        ch::WIN_FIRST_PAINT => {
            crate::win::show_once(window);
            Value::Null
        }
        ch::WIN_MOUNTED => {
            crate::crash::note_mounted(window.label());
            Value::Null
        }

        _ => return None,
    })
}
