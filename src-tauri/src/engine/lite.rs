//! `ChatStatusLite` 합성 — **쓰기 주인은 Rust 하나**(m-logic §5.8 · M-UX §4.3).
//!
//! 다섯 줄 규약 중 이 파일이 지키는 것:
//!  - 값을 만드는 곳은 여기 하나다(런타임 상태 → lite). 렌더러 팬아웃은 이 필드를 못 쓴다.
//!  - 전이마다 **메모리 갱신 + 브로드캐스트**(즉시), 디스크는 `ccg_store::status`가
//!    500ms 디바운스로 쓴다. 브로드캐스트와 디스크의 지연이 다르다 — 크래시 창 최대 500ms.
//!  - `hold`·`queued`의 **진실은 런타임**이고 `status.json`은 파생 캐시다.
//!  - `unread`는 3.0.0에서 항상 0(스토어가 강제한다).
//!
//! `status`(2.6.2 `AgentStatus`)와 `bgActive`를 **따로** 싣는 이유: 메모리에 박힌 사용자
//! 정정 — *"완료 색은 bg까지 걷혀야 한다(effectiveStatus 단일 소스)"*. 두 값을 여기서
//! 미리 합치면 표시 쪽이 그 규칙을 다시 못 만든다. 합성은 UI의 몫으로 남긴다.

use ccg_engine::driver::CliDriver;
use ccg_engine::live::{AskKind, LiveKind};
use ccg_engine::runtime::ChatRuntime;
use ccg_engine::state::StateTag;
use serde_json::{json, Value};

/// 이 채팅의 마지막 종결 상태(턴이 끝난 뒤에도 남는 표시값).
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Terminal {
    None,
    Done,
    Error,
}

pub fn build<D: CliDriver>(rt: &ChatRuntime<D>, terminal: Terminal, now_ms: u64) -> Value {
    let state = rt.state();
    let ledger = rt.ledger();
    let ask = ledger
        .items()
        .iter()
        .filter_map(|i| i.ask.as_ref())
        .map(|a| match a.ask_kind {
            AskKind::Permission => "permission",
            AskKind::Question => "question",
            AskKind::Dialog => "dialog",
        })
        .next()
        .unwrap_or("none");
    let bg_active = ledger.items().iter().any(|i| {
        matches!(
            i.kind,
            LiveKind::BgShell | LiveKind::BgAgent | LiveKind::Workflow
        )
    });
    // 2.6.2 `AgentStatus` 어휘로 접는다(사이드바 알약·창 목록이 읽는 값).
    let status = match state {
        StateTag::Starting => "analyzing",
        StateTag::Streaming | StateTag::AwaitingUser | StateTag::HeldResult | StateTag::Interrupting => "working",
        _ => match terminal {
            Terminal::Done => "done",
            Terminal::Error => "error",
            Terminal::None => "idle",
        },
    };
    // 키 이름은 `ccg_store::status::truth_from_chat_file`와 **같아야** 한다 —
    // 그쪽이 `<chatId>.json`에서 만드는 파생 요약과 모양이 갈리면 규약 3("어긋나면
    // 채팅 파일이 이긴다")이 매번 발동해 화면이 깜빡인다.
    let hold = match rt.hold() {
        Some(h) => json!({ "resetAt": h.resets_at, "ready": h.ready }),
        None => Value::Null,
    };
    json!({
        "chatId": rt.chat_id,
        "status": status,
        "busy": rt.busy(),
        "bgActive": bg_active,
        "ask": ask,
        "hold": hold,
        "queued": rt.queue_len(),
        "unread": 0,
        "updatedAt": now_ms,
    })
}
