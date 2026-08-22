//! 앱 홈 스토어 채널 — **2.6.2 포맷 그대로**(플래그가 꺼진 기본 경로).
//! `chats:*` / `ma:*` / `talk:*`는 통합 스토어가 켜지면 `unified`가 앞에서 가로챈다.

use super::{arg, ch};
use serde_json::Value;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

pub fn dispatch(app: &AppHandle, channel: &str, p: &Value) -> Option<Value> {
    Some(match channel {
        ch::PROFILE_GET => ccg_store::prefs::read_profile().unwrap_or(Value::Null),
        ch::PROFILE_SAVE => {
            let _ = ccg_store::prefs::write_profile(arg(p, 0));
            Value::Null
        }
        // 부팅 조회는 경량(light) — 활성 채팅만 스냅샷, 나머지는 unloaded 마커
        ch::CHATS_GET => ccg_store::chats::read_chats(true),
        ch::CHATS_SAVE => {
            ccg_store::chats::write_chats(arg(p, 0));
            Value::Null
        }
        ch::CHAT_LOAD => ccg_store::chats::read_chat(arg(p, 0)),
        ch::UI_PREFS_GET => ccg_store::prefs::read_ui_prefs(),
        ch::UI_PREFS_SAVE => {
            let prefs = arg(p, 0);
            let _ = ccg_store::prefs::write_ui_prefs(prefs);
            broadcast_ui_prefs(app, prefs);
            Value::Null
        }

        // ── 멀티채팅 워크스페이스 (chats와 같은 팬아웃·같은 unloaded 규약) ──
        // 부팅 조회는 경량(light) — 활성 세션만 패널 스냅샷, 나머지는 마커.
        ch::MA_GET => ccg_store::ma::read_multi(true),
        ch::MA_SAVE => {
            ccg_store::ma::write_multi(arg(p, 0));
            Value::Null
        }
        ch::MA_LOAD_SESSION => ccg_store::ma::read_session(arg(p, 0)),

        // ── 채팅 모드(1.x 은퇴) 블롭 — 2.6.2가 부팅마다 1회 편입하고 비우는 파일 ──
        ch::TALK_GET => ccg_store::talk::read(),
        ch::TALK_SAVE => {
            ccg_store::talk::write(arg(p, 0));
            Value::Null
        }

        // ── API 과금 설정 · 사용 원장 ───────────────────────────────────────
        // 키 원문은 여기서 나가지 않는다 — 상태는 존재 여부 + 끝 4자리뿐.
        ch::API_CONFIG_GET => ccg_store::api_config::status(),
        ch::API_CONFIG_SET_KEY => {
            // (key, provider?) — provider 'openai'면 Codex 키
            let key = arg(p, 0).as_str().unwrap_or("");
            if arg(p, 1).as_str() == Some("openai") {
                ccg_store::api_config::set_openai_api_key(key);
            } else {
                ccg_store::api_config::set_api_key(key);
            }
            ccg_store::api_config::status()
        }
        ch::API_CONFIG_CLEAR_KEY => {
            if arg(p, 0).as_str() == Some("openai") {
                ccg_store::api_config::clear_openai_api_key();
            } else {
                ccg_store::api_config::clear_api_key();
            }
            ccg_store::api_config::status()
        }
        ch::API_CONFIG_SET_BUDGET => {
            ccg_store::api_config::set_budget(arg(p, 0).as_f64());
            ccg_store::api_config::status()
        }
        ch::API_CONFIG_RESET_BUDGET => {
            ccg_store::api_config::reset_budget();
            ccg_store::api_config::status()
        }
        ch::API_USAGE_LIST => ccg_store::api_usage::list(),

        _ => return None,
    })
}

// ── ui-prefs 브로드캐스트 (2.6.2 uiPrefsSave의 조건을 그대로) ────────────────
struct UiBroadcast {
    glass: Option<f64>,
    lang: String,
}

fn ui_broadcast() -> &'static Mutex<UiBroadcast> {
    static S: OnceLock<Mutex<UiBroadcast>> = OnceLock::new();
    S.get_or_init(|| {
        let prefs = ccg_store::prefs::read_ui_prefs();
        Mutex::new(UiBroadcast {
            glass: prefs.get("ui.glass").and_then(Value::as_f64),
            lang: if prefs.get("ui.lang").and_then(Value::as_str) == Some("en") { "en" } else { "ko" }.into(),
        })
    })
}

/// 유리(벽지 비침)·UI 언어는 **바뀐 저장에만** 전 창으로 뿌린다. 나란히 뜬 아크릴 창의
/// 비침이 어긋나거나 언어가 창마다 다르면 바로 보이기 때문(2.6.2와 같은 조건·같은 채널).
fn broadcast_ui_prefs(app: &AppHandle, prefs: &Value) {
    let mut st = ui_broadcast().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(g) = prefs.get("ui.glass").and_then(Value::as_f64) {
        if st.glass != Some(g) {
            st.glass = Some(g);
            let _ = app.emit(ch::UI_GLASS_CHANGED, g);
        }
    }
    let lang = if prefs.get("ui.lang").and_then(Value::as_str) == Some("en") { "en" } else { "ko" };
    if st.lang != lang {
        st.lang = lang.to_string();
        let _ = app.emit(ch::UI_LANG_CHANGED, lang);
    }
}
