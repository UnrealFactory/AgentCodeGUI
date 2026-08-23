//! 창 채널 — 추가 채팅 창 레지스트리 + 창 컨트롤. (ipc.rs에서 분리 — 동작 불변)
//! 실제 창 조작은 전부 `win.rs`가 한다. 여기는 채널 → 그 함수의 배선뿐이다.
//!
//! ## 3.0 창 자리 채널 (`win:chat-*` · `chat:windows`)
//!
//! 이름 상수를 `ipc/mod.rs`의 `ch`가 아니라 **여기 두는 이유**: `mod.rs`는 지금 다른
//! 라운드(M6 파일·Git 도메인)가 소유한 파일이라 한 줄 추가도 충돌을 만든다. 문자열의
//! 원본은 어차피 `src/shared/protocol.ts:1187-1198`이고 이 모듈이 그 채널의 **유일한**
//! 소비자이므로, 상수가 여기 있어도 진실이 두 곳이 되지 않는다.

use super::{arg, ch};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

/// 창 자리 4채널 + 목록 브로드캐스트 (protocol.ts `IPC.winChat*` · `IPC.chatWindows`).
pub const WIN_CHAT_OPEN: &str = "win:chat-open";
pub const WIN_CHAT_CLOSE: &str = "win:chat-close";
pub const WIN_CHAT_FOCUS: &str = "win:chat-focus";
pub const WIN_CHAT_LIST: &str = "win:chat-list";
pub const CHAT_WINDOWS: &str = "chat:windows";
/// main → 렌더러: **창 닫기 전 마지막 저장 요청**(`protocol.ts:1199` `chatFlushReq`).
pub const CHAT_FLUSH_REQ: &str = "chat:flush-req";

/// ── M8 창 표면 3종 ────────────────────────────────────────────────────────
/// 멀티 패널 팝아웃 창 7채널 (`protocol.ts:968-974` + 이벤트 `:1134`).
/// 구현은 `win::popout`. 상수를 여기 두는 이유는 위 블록과 같다(유일한 소비자).
pub const MA_PANEL_OPEN: &str = "ma:panel-open";
pub const MA_PANEL_HYDRATE: &str = "ma:panel-hydrate";
pub const MA_PANEL_PERSIST: &str = "ma:panel-persist";
pub const MA_PANEL_FOCUS: &str = "ma:panel-focus";
pub const MA_PANEL_CLOSE: &str = "ma:panel-close";
pub const MA_PANEL_STATES: &str = "ma:panel-states";
pub const MA_PANEL_LEFTOVER_CLEAR: &str = "ma:panel-leftover-clear";
/// 셸 내부 진단 — 계약면에 없다. `scripts/poc-winsurface.mjs`가 창 회계를 읽는다.
pub const WIN_SURFACE_DEBUG: &str = "win:surface-debug";

/// 그 채팅을 보고 있는 창에 "지금 저장해"라고 알린다(★R4 — 32채널의 마지막 한 칸).
///
/// **그 창에만** 보낸다. 브로드캐스트하면 메인 창까지 자기 대화를 flush하고, 그 순간
/// 활성 채팅이 다른 것이면 남의 자리에 저장이 떨어진다(R2.3이 `session-wins:persist`에서
/// 같은 이유로 폴백을 금지했다). 창이 없으면 아무 일도 없다 — 저장할 화면이 없다.
pub fn flush_req(app: &AppHandle, chat: &str) {
    let Some(label) = crate::win::session_label_for_chat(chat) else { return };
    let _ = app.emit_to(label.as_str(), CHAT_FLUSH_REQ, json!({ "chatId": chat }));
}

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

        // ── 창 자리 4채널 (3.0 계약면 §6.1) ─────────────────────────────────
        //
        // `session-wins:*`(2.6.2)와 **공존**한다. 같은 레지스트리를 보므로 어느 쪽으로
        // 열어도 다른 쪽 목록에 나타난다. 의미가 하나 다르고, 그 하나가 중요하다:
        //
        //   `session-wins:close` = **대화 삭제**(protocol.ts의 옛 계약)
        //   `win:chat-close`     = **창만 닫기**(통합 모델: 자리는 뷰, 대화는 남는다)
        //
        // 합쳐 쓰면 둘 중 하나가 반드시 대화를 잃는다 — `win.rs`도 함수를 나눠 둔다.
        WIN_CHAT_OPEN => {
            let a = arg(p, 0);
            let chat = a.get("chatId").and_then(Value::as_str).filter(|s| !s.is_empty());
            // 이미 그 채팅을 보는 창이 있으면 새로 만들지 않고 앞으로 가져온다
            // (`from`은 어디서 열었는지의 기록 — 복귀 정책의 재료다. 스펙 열린문제 ④).
            if let Some(id) = chat.filter(|id| crate::win::has_window_for(id)) {
                crate::win::session_focus(app, id);
                return Some(crate::win::window_slots(app));
            }
            match crate::win::open_session_window_for(app, chat) {
                Ok(_) => crate::win::window_slots(app),
                Err(e) => {
                    eprintln!("[win] 창 자리 열기 실패: {e}");
                    json!([])
                }
            }
        }
        WIN_CHAT_CLOSE => {
            let id = arg(p, 0)
                .get("chatId")
                .and_then(Value::as_str)
                .or_else(|| arg(p, 0).as_str())
                .unwrap_or("");
            json!(!id.is_empty() && crate::win::chat_window_close(app, id))
        }
        WIN_CHAT_FOCUS => {
            let id = arg(p, 0)
                .get("chatId")
                .and_then(Value::as_str)
                .or_else(|| arg(p, 0).as_str())
                .unwrap_or("");
            if !id.is_empty() {
                // 창이 없으면 **되만든다**(R2.3이 `session-wins:focus`에 넣은 의미와 같다).
                crate::win::session_focus(app, id);
            }
            crate::win::window_slots(app)
        }
        WIN_CHAT_LIST => crate::win::window_slots(app),

        // ── 멀티 패널 팝아웃 창 (M8 — win::popout) ──────────────────────────
        //
        // 소유권 규약이 2.6.2와 다르다. 저쪽은 엔진이 `panelId`에 매달려 있어 팝아웃이
        // **사본 이전**이었지만, 3.0은 `panel_id_to_chat()`이 보드에서 chatId를 읽어
        // 실행이 **채팅에 붙는다** — 창은 그 채팅을 보는 자리일 뿐이라 여닫아도 엔진이
        // 재스폰되지 않는다. 여기서 나르는 것은 렌더러 로컬 상태(초안·큐·메타·스냅샷)뿐.
        MA_PANEL_OPEN => {
            match crate::win::popout::open(app, arg(p, 0)) {
                Ok(label) => json!(label),
                Err(e) => {
                    eprintln!("[win] 팝아웃 창 열기 실패: {e}");
                    Value::Null
                }
            }
        }
        // 주소는 **부른 창**이다(페이로드의 panelId를 믿으면 남의 패널을 덮는다).
        MA_PANEL_HYDRATE => crate::win::popout::hydrate(window.label()),
        MA_PANEL_PERSIST => json!(crate::win::popout::persist(window.label(), arg(p, 0))),
        MA_PANEL_FOCUS => {
            if let Some(id) = arg(p, 0).as_str() {
                crate::win::popout::focus(app, id);
            }
            Value::Null
        }
        MA_PANEL_CLOSE => {
            if let Some(id) = arg(p, 0).as_str() {
                crate::win::popout::close(app, id);
            }
            Value::Null
        }
        MA_PANEL_STATES => crate::win::popout::states(arg(p, 0).as_str().unwrap_or("")),
        MA_PANEL_LEFTOVER_CLEAR => {
            if let Some(id) = arg(p, 0).as_str() {
                crate::win::popout::clear_leftover(id);
            }
            Value::Null
        }

        // ── 알림 토스트 창 (M8 — win::notify) ───────────────────────────────
        crate::win::notify::NOTIFY_EVENT => {
            crate::win::notify::event(app, window, arg(p, 0));
            Value::Null
        }
        crate::win::notify::NOTIFY_OPEN => {
            if let Some(key) = arg(p, 0).as_str() {
                crate::win::notify::open(app, key);
            }
            Value::Null
        }
        crate::win::notify::NOTIFY_CLOSE => {
            crate::win::notify::close_all(app);
            Value::Null
        }
        crate::win::notify::NOTIFY_RESIZE => {
            crate::win::notify::resize(app, arg(p, 0).as_f64().unwrap_or(0.0));
            Value::Null
        }

        // ── 트레이 우클릭 메뉴 창 (M8 — win::tray) ──────────────────────────
        crate::win::tray::TRAYMENU_RESIZE => {
            crate::win::tray::menu_resize(app, arg(p, 0).as_f64().unwrap_or(0.0));
            Value::Null
        }
        crate::win::tray::TRAYMENU_ACTION => {
            // 메뉴 창이 보낸 것만 받는다(다른 창이 이 채널로 앱을 끄지 못하게).
            if window.label() == crate::win::tray::MENU_WIN {
                crate::win::tray::menu_action(app, arg(p, 0).as_str().unwrap_or(""));
            }
            Value::Null
        }

        // 셸 내부 진단 — 창 표면 회계 한 덩어리(하네스 전용).
        //
        // `["traymenu-open"]`은 **트레이 우클릭의 대역**이다. 알림 영역 우클릭은 셸
        // (Explorer)의 OS 이벤트라 CDP로 합성할 수 없어(A/B `tray-menu`가 두 앱 모두
        // skip인 이유) 하네스가 진입 함수를 직접 부른다 — 그 뒤 경로는 실제와 같다.
        WIN_SURFACE_DEBUG if arg(p, 0).as_str() == Some("traymenu-open") => {
            let (x, y) = app
                .cursor_position()
                .map(|c| (c.x, c.y))
                .unwrap_or((400.0, 900.0));
            crate::win::tray::show_menu(app, x, y);
            json!({ "menuAt": [x, y] })
        }
        WIN_SURFACE_DEBUG => json!({
            "popout": crate::win::popout::debug_state(),
            "notify": crate::win::notify::debug_state(app),
            "tray": crate::win::tray::debug_state(app),
            "windows": app.webview_windows().keys().cloned().collect::<Vec<String>>(),
        }),

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
        // 렌더러가 실제로 섰다(splash.js가 `#root`에 자식이 생긴 순간 쏜다).
        ch::WIN_MOUNTED => {
            crate::crash::note_mounted(window.label());
            // ★ F12 — **첫 `chat:status`가 구독자보다 이르다**(§R2.8-R5).
            //   `engine::boot()`은 창이 만들어지기 **전에** 첫 REPLACE를 쏘고, 그 뒤로는
            //   상태 전이가 있어야만 다시 쏜다. 유휴 앱에는 전이가 없다 → 그 화면은
            //   영원히 빈 값으로 시작한다.
            //
            //   Rust 몫은 "구독 시 현재 상태 1회 송신"이다. Tauri에는 렌더러의 `listen`을
            //   셸이 관측할 방법이 없으므로, **관측 가능한 가장 가까운 지점**인 마운트에
            //   건다. 마운트(MutationObserver 콜백)는 `useEffect` 구독보다 **이르므로**
            //   짧은 지연 재송신을 한 번 더 붙인다 — REPLACE라 두 번 받아도 무해하다.
            //   (완전한 해법은 렌더러가 구독 직후 스냅샷을 한 번 당겨 가는 것이다.
            //    `app/`은 이번 라운드 경계 밖이라 그쪽은 열어 둔다.)
            // ★R4 귀속 팔(`CCG_NO_STATUS_TICK`) — 이 REPLACE를 렌더러가 받아 들고 있는
            //   몫을 가른다. 기본값에서는 R3과 같다.
            if crate::flags::no_status_tick() {
                return Some(Value::Null);
            }
            let payload = crate::engine::status_array();
            let _ = app.emit_to(window.label(), ch::CHAT_STATUS, payload);
            let handle = app.clone();
            let label = window.label().to_string();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(400));
                let _ = handle.emit_to(label.as_str(), ch::CHAT_STATUS, crate::engine::status_array());
                // 창 자리 목록도 같은 이유로 한 번 더(구독 전에 지나간 REPLACE 보충).
                let _ = handle.emit_to(label.as_str(), CHAT_WINDOWS, crate::win::window_slots(&handle));
            });
            Value::Null
        }

        _ => return None,
    })
}
