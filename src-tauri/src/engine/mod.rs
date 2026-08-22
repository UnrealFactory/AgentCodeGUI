//! **엔진 글루** — `ccg-engine`(상태기계·드라이버) × `ccg-store`(앱 홈) × 셸(창·IPC)의 결합점.
//!
//! 이 모듈이 있기 전까지 세 조각은 서로를 몰랐다: 엔진은 97개 재생 시나리오 안에서만
//! 돌았고, 스토어는 채널로만 만져졌고, 셸은 창만 띄웠다. 여기서 셋을 잇는다.
//!
//! ```text
//!   렌더러(2.6.2)                셸(src-tauri)                      크레이트
//!   ─────────────                ─────────────                      ────────
//!   claude:run      ──▶  ipc::dispatch ──▶ engine::dispatch ──Job──▶ [허브 스레드]
//!   engine:event    ◀──  fanout(chatId→창)  ◀──────────────────────  ChatRuntime
//!   chat:*(3.0)     ◀──▶  같은 허브                                   + ClaudeDriver
//! ```
//!
//! ## 주소 (m-logic §4.3 ★R2)
//!
//! 주소는 **`chatId` 문자열 하나**다. 표면(`surface`) 구분이 없다. 옛 채널은 각자
//! 자기 인자를 갖고 있으므로 **번역 함수 셋**만 둔다(타입이 아니다):
//!
//! | 옛 채널 | 대상 | 함수 |
//! |---|---|---|
//! | `claude:*` | 활성 채팅 | [`active_chat_id`] |
//! | `ma:*` `{panelId}` | 그 자리의 채팅 | [`panel_id_to_chat`] |
//! | `session:*` | 그 창의 채팅 | [`chat_for_window`] |
//!
//! ## 이 라운드에서 **배선하지 않은** 것 (조용히 빠뜨리지 않는다)
//!
//! - `btw:open`(포크 질문 창) · `talk:*`(은퇴) · Codex 엔진(app-server)
//! - `chat:answer`의 답을 **선택지 요약 문장**으로 되먹이는 것까지는 했지만,
//!   `allow_always`의 `updatedPermissions`는 아직 안 싣는다(허용은 1회로 동작).
//! - 부팅 시 큐·한도 대기 **재장전**(§5.8 부팅 경로 2단계) — 엔진에 로더가 없다.
//! - `file-change` / `terminal` / `todos` / `bg-tasks` 프레임(→ `wire.rs` 파일 끝 목록).

mod hub;
mod ident;
mod lite;
mod tap;
mod wire;

use super::ipc::{arg, ch};
use ccg_engine::identity::{ApplyPolicy, PendingOp};
use ccg_engine::live::AskKind;
use ccg_engine::runtime::Cmd;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, WebviewWindow};

pub use hub::shutdown;

/// 부팅 — 허브 스레드 + `status.json` 장전 + 첫 `chat:status` REPLACE.
///
/// 장전 순서가 규약이다(§5.8): **파일 로드 → 부팅 강제 → 브로드캐스트**. 강제 없이
/// 그리면 지난 세션의 `busy`·`ask`가 그대로 살아나 유령 알약이 뜬다.
pub fn boot(app: &AppHandle) {
    let ids = all_chat_ids();
    ccg_store::status::load_boot(&ids);
    hub::start(app.clone());
    let _ = app.emit(ch::CHAT_STATUS, status_array());
}

/// 전 채팅 `ChatStatusLite` — 계약면은 **배열**이다(§6.1 `chat:status  ChatStatusLite[]`).
/// (`chats:get`이 합쳐 주는 `statuses`는 객체 맵이다 — 그쪽은 id로 찾는 조회라서.)
pub fn status_array() -> Value {
    match ccg_store::status::snapshot() {
        Value::Object(m) => Value::Array(m.into_iter().map(|(_, v)| v).collect()),
        _ => Value::Array(vec![]),
    }
}

fn all_chat_ids() -> Vec<String> {
    if ccg_store::unified_store_enabled() {
        ccg_store::chats_v3::all_chats()
            .iter()
            .filter_map(|c| c.get("id").and_then(Value::as_str).map(str::to_string))
            .collect()
    } else {
        ccg_store::chats::read_chats(true)
            .get("chats")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|c| c.get("id").and_then(Value::as_str).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    }
}

/// 옛 `claude:*`의 대상 — **지금 활성 채팅**(§6.2 U3).
///
/// 진실 소스는 `chats:set-active`가 즉시 갱신하는 인덱스다. 얼려 둔 2.6.2 렌더러는 아직
/// 그 채널을 부르지 않으므로(이번 라운드는 app/ 금지) 마지막 `chats:save`의 값이 온다 —
/// 저장 디바운스(400ms)만큼 낡을 수 있다는 뜻이고, 그 창에서 채팅을 바꾸자마자 보내면
/// 남의 런타임에 붙는다. **다음 라운드에 렌더러 3곳 한 줄**이 이 구멍을 닫는다.
pub fn active_chat_id() -> String {
    let id = if ccg_store::unified_store_enabled() {
        ccg_store::chats_v3::active_chat_id()
    } else {
        ccg_store::read_home_json("chats/index.json")
            .and_then(|v| v.get("activeChatId").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_default()
    };
    if !id.is_empty() {
        return id;
    }
    // 활성 표식이 아직 없다(새 홈의 첫 부팅). 첫 채팅에 붙이고, 그것도 없으면
    // 고정 id 하나를 쓴다 — **조용히 남의 채팅에 붙이지는 않는다**.
    all_chat_ids().into_iter().next().unwrap_or_else(|| "chat-unassigned".into())
}

/// `${boardId}::${slot}` → 그 자리에 앉은 채팅. 보드가 진실이라 패널을 옮겨도 따라간다.
pub fn panel_id_to_chat(panel_id: &str) -> Option<String> {
    let (board, slot) = panel_id.split_once("::")?;
    let slot: usize = slot.parse().ok()?;
    let b = ccg_store::boards::read_board(&json!(board));
    b.get("slots")?
        .get(slot)?
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// 역인덱스 — 이 채팅이 어느 자리에 앉아 있나(`ma:event` 봉투용).
pub fn panel_id_for_chat(chat: &str) -> Option<String> {
    let all = ccg_store::boards::read_boards();
    for b in all.get("boards")?.as_array()? {
        let id = b.get("id")?.as_str()?;
        for (i, s) in b.get("slots")?.as_array()?.iter().enumerate() {
            if s.as_str() == Some(chat) {
                return Some(format!("{id}::{i}"));
            }
        }
    }
    None
}

/// 이 창(추가 채팅 창)이 보는 채팅. 메인 창이면 활성 채팅.
pub fn chat_for_window(window: &WebviewWindow) -> String {
    if window.label() == crate::win::MAIN {
        return active_chat_id();
    }
    crate::win::chat_for_label(window.label()).unwrap_or_else(active_chat_id)
}

// ── 채널 디스패치 ────────────────────────────────────────────────────────────

pub fn dispatch(_app: &AppHandle, window: &WebviewWindow, channel: &str, p: &Value) -> Option<Value> {
    // 3.0 코어(`chat:*`) — 주소가 인자 첫 자리에 온다.
    if let Some(v) = core_dispatch(channel, p) {
        return Some(v);
    }
    // 과도기 별칭 — 옛 채널은 주소를 안 싣는다. 번역 함수 셋이 주소를 만든다.
    let (chat, req_at): (String, usize) = match channel {
        ch::CLAUDE_RUN | ch::CLAUDE_CANCEL | ch::CLAUDE_INTERRUPT | ch::CLAUDE_PERMISSION_RESPOND
        | ch::CLAUDE_QUESTION_RESPOND | ch::CLAUDE_BG_TASK => (active_chat_id(), 0),
        ch::SESSION_RUN | ch::SESSION_CANCEL | ch::SESSION_INTERRUPT | ch::SESSION_PERMISSION_RESPOND
        | ch::SESSION_QUESTION_RESPOND | ch::SESSION_BG_TASK => (chat_for_window(window), 0),
        ch::MA_RUN => match arg(p, 0).get("panelId").and_then(Value::as_str).and_then(panel_id_to_chat) {
            Some(c) => (c, 0),
            None => return Some(Value::String(String::new())),
        },
        ch::MA_CANCEL | ch::MA_INTERRUPT | ch::MA_DISPOSE => {
            match arg(p, 0).as_str().and_then(panel_id_to_chat) {
                Some(c) => (c, 1),
                None => return Some(Value::Null),
            }
        }
        ch::MA_PERMISSION_RESPOND | ch::MA_QUESTION_RESPOND => {
            match arg(p, 0).get("panelId").and_then(Value::as_str).and_then(panel_id_to_chat) {
                Some(c) => (c, 0),
                None => return Some(Value::Null),
            }
        }
        ch::MA_BG_TASK => match arg(p, 0).as_str().and_then(panel_id_to_chat) {
            Some(c) => (c, 1),
            None => return Some(Value::Null),
        },
        _ => return None,
    };

    Some(match channel {
        ch::CLAUDE_RUN | ch::SESSION_RUN | ch::MA_RUN => hub::call(&chat, hub::Op::Run(arg(p, req_at).clone())),
        // 소프트 중단 — 턴만 끊고 상주는 유지한다(2.6.2가 프로세스를 죽여 만든
        // "중단 1회 → 턴마다 CLI 사망 루프"를 여기서 되풀이하지 않는다).
        ch::CLAUDE_INTERRUPT | ch::SESSION_INTERRUPT | ch::MA_INTERRUPT => {
            hub::cast(&chat, hub::Op::Cmd(Cmd::Interrupt));
            Value::Null
        }
        // 프로세스째 — `/clear`·폴더 전환·계정 전환 전용.
        ch::CLAUDE_CANCEL | ch::SESSION_CANCEL | ch::MA_CANCEL => {
            hub::cast(&chat, hub::Op::Cmd(Cmd::StopAll));
            Value::Null
        }
        ch::MA_DISPOSE => {
            hub::cast(&chat, hub::Op::Dispose);
            Value::Null
        }
        ch::CLAUDE_PERMISSION_RESPOND | ch::SESSION_PERMISSION_RESPOND | ch::MA_PERMISSION_RESPOND => {
            respond_permission(&chat, arg(p, req_at));
            Value::Null
        }
        ch::CLAUDE_QUESTION_RESPOND | ch::SESSION_QUESTION_RESPOND | ch::MA_QUESTION_RESPOND => {
            respond_question(&chat, arg(p, req_at));
            Value::Null
        }
        ch::CLAUDE_BG_TASK | ch::SESSION_BG_TASK | ch::MA_BG_TASK => {
            bg_task(&chat, arg(p, req_at));
            Value::Null
        }
        _ => return None,
    })
}

fn core_dispatch(channel: &str, p: &Value) -> Option<Value> {
    let chat = || arg(p, 0).get("chatId").and_then(Value::as_str).unwrap_or("").to_string();
    Some(match channel {
        ch::CHAT_RUN => hub::call(&chat(), hub::Op::Run(arg(p, 0).clone())),
        ch::CHAT_INTERRUPT => {
            hub::cast(&chat(), hub::Op::Cmd(Cmd::Interrupt));
            json!({ "ok": true })
        }
        ch::CHAT_CANCEL => {
            hub::cast(&chat(), hub::Op::Cmd(Cmd::StopAll));
            json!({ "ok": true })
        }
        ch::CHAT_PERMISSION => {
            respond_permission(&chat(), arg(p, 0));
            json!({ "ok": true })
        }
        ch::CHAT_ANSWER => {
            respond_question(&chat(), arg(p, 0));
            json!({ "ok": true })
        }
        ch::CHAT_RESPOND_DIALOG => {
            let a = arg(p, 0);
            hub::call(
                &chat(),
                hub::Op::Respond {
                    kind: AskKind::Dialog,
                    request_id: a.get("requestId").and_then(Value::as_str).unwrap_or("").to_string(),
                    accept: a.get("accepted").and_then(Value::as_bool).unwrap_or(false),
                    payload: None,
                },
            )
        }
        ch::CHAT_BG_TASK => {
            bg_task(&chat(), arg(p, 0));
            json!({ "ok": true })
        }
        ch::CHAT_DISPOSE => hub::call(&chat(), hub::Op::Dispose),
        ch::CHAT_IDENTITY_GET => hub::call(&chat(), hub::Op::IdentityGet),
        ch::CHAT_IDENTITY_SET => {
            let a = arg(p, 0);
            hub::call(
                &chat(),
                hub::Op::IdentitySet {
                    patch: ident::patch_from_json(a.get("patch").unwrap_or(&Value::Null)),
                    policy: match a.get("applyPolicy").and_then(Value::as_str) {
                        Some("now") => ApplyPolicy::Now,
                        Some("after_turn") => ApplyPolicy::AfterTurn,
                        // 생략 = 'ask_if_costly'(§4.3)
                        _ => ApplyPolicy::AskIfCostly,
                    },
                    op: match a.get("pendingOp").and_then(Value::as_str) {
                        Some("replace") => PendingOp::Replace,
                        Some("cancel") => PendingOp::Cancel,
                        _ => PendingOp::Merge,
                    },
                    corr: a.get("corrId").and_then(Value::as_str).map(str::to_string),
                },
            )
        }
        ch::CHAT_IDENTITY_REVERT => {
            let a = arg(p, 0);
            let to = a.get("revision").and_then(Value::as_u64).unwrap_or(0) as u32;
            hub::call(&chat(), hub::Op::IdentityRevert(to))
        }
        ch::CHAT_QUEUE_MUTATE => hub::call(&chat(), hub::Op::QueueMutate(arg(p, 0).clone())),
        ch::CHAT_FORCE_SETTLE => {
            let a = arg(p, 0);
            let id = a.get("liveItemId").and_then(Value::as_str).unwrap_or("").to_string();
            hub::call(&chat(), hub::Op::ForceSettle(id))
        }
        // 진단 — 하네스(scripts/poc-live-chat.mjs)가 런타임 회계를 읽는다.
        ch::ENGINE_DEBUG => hub::call("", hub::Op::Debug),
        _ => return None,
    })
}

/// 승인 카드 응답. `allow_always`는 지금 라운드에서 **1회 허용**과 같게 동작한다
/// (`updatedPermissions` 미배선 — 세션 규칙 추가는 다음 라운드).
fn respond_permission(chat: &str, res: &Value) {
    let request_id = res.get("requestId").and_then(Value::as_str).unwrap_or("").to_string();
    let behavior = res.get("behavior").and_then(Value::as_str).unwrap_or("deny");
    let accept = behavior != "deny";
    let payload = if accept {
        json!({ "behavior": "allow" })
    } else {
        json!({ "behavior": "deny",
                "message": res.get("message").and_then(Value::as_str).unwrap_or("사용자가 거부했습니다.") })
    };
    hub::cast(
        chat,
        hub::Op::Respond {
            kind: AskKind::Permission,
            request_id,
            accept,
            payload: Some(payload),
        },
    );
}

/// 질문 카드 응답 — **2.6.2 트릭**(`protocol-claude-cli.md` §4.4a):
/// `canUseTool`은 allow/deny만 받으므로 **`deny` + `message`(선택 요약)** 로 답을 되먹인다.
/// 모델은 그 message를 tool_result로 읽고 이어 간다. 답을 안 하고 닫으면 "건너뛰었습니다".
fn respond_question(chat: &str, res: &Value) {
    let request_id = res.get("requestId").and_then(Value::as_str).unwrap_or("").to_string();
    let answers = res.get("answers");
    let message = match answers.and_then(Value::as_array) {
        Some(rows) if !rows.is_empty() => {
            let picked: Vec<String> = rows
                .iter()
                .map(|r| {
                    r.as_array()
                        .map(|opts| {
                            opts.iter()
                                .filter_map(Value::as_str)
                                .collect::<Vec<_>>()
                                .join(", ")
                        })
                        .unwrap_or_default()
                })
                .filter(|s| !s.is_empty())
                .collect();
            if picked.is_empty() {
                "사용자가 건너뛰었습니다. 합리적인 기본값으로 계속 진행하세요.".to_string()
            } else {
                format!("사용자가 질문에 다음과 같이 답했습니다: {}", picked.join(" / "))
            }
        }
        _ => "사용자가 건너뛰었습니다. 합리적인 기본값으로 계속 진행하세요.".to_string(),
    };
    hub::cast(
        chat,
        hub::Op::Respond {
            kind: AskKind::Question,
            request_id,
            // 답을 되먹이는 경로가 deny라 accept=false지만, 카드는 "응답됨"으로 정착한다.
            accept: false,
            payload: Some(json!({ "behavior": "deny", "message": message })),
        },
    );
}

fn bg_task(chat: &str, req: &Value) {
    match req.get("action").and_then(Value::as_str) {
        Some("stop") => {
            if let Some(id) = req.get("id").and_then(Value::as_str) {
                hub::cast(
                    chat,
                    hub::Op::Cmd(Cmd::BgStop { id: id.to_string() }),
                );
            }
        }
        Some("background") => hub::cast(chat, hub::Op::Cmd(Cmd::BgBackground)),
        _ => {}
    }
}
