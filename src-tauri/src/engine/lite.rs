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
    /// 사용자가 끊은 턴. **`Done`으로 적으면 안 된다** — 이 값은 `status.json`에
    /// 영속되고 `load_boot`는 `done`을 안 내리므로, 중단한 턴이 재시작 뒤에도
    /// "완료"로 남는다(크리틱 배선 R1 F11). 2.6.2 `AgentStatus`에는 대응 어휘가
    /// 없으므로 **`idle`로 접는다** — "완료도 오류도 아니다"가 지금 낼 수 있는
    /// 가장 정확한 값이다(사이드바 점 색은 `done`과 같아 화면은 안 바뀐다).
    Aborted,
}

/// 런타임 시계 ms(단조) → **unix 초**. `hub::persist_hold`가 디스크로 내릴 때 하는 것과
/// 같은 환승이고, 짝인 되돌리기는 `engine::remaining_ms`다. 시각 미상(`None`)은 그대로
/// `null`로 나간다 — 렌더러가 "언제 풀리는지 모른다" 문장을 따로 갖고 있다.
fn runtime_ms_to_epoch_secs(rt_now: u64, wall_now_ms: u64, at: Option<u64>) -> Value {
    match at {
        Some(r) => json!((wall_now_ms as f64 + (r as f64 - rt_now as f64)) / 1000.0),
        None => Value::Null,
    }
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
            Terminal::Aborted | Terminal::None => "idle",
        },
    };
    // 키 이름은 `ccg_store::status::truth_from_chat_file`와 **같아야** 한다 —
    // 그쪽이 `<chatId>.json`에서 만드는 파생 요약과 모양이 갈리면 규약 3("어긋나면
    // 채팅 파일이 이긴다")이 매번 발동해 화면이 깜빡인다.
    //
    // ★R5 — `resetAt`은 **unix 초**다. 렌더러가 `managed.resetAt * 1000 - Date.now()`로
    // 남은 시간을 만들고(`Chat.tsx` `LimitHoldBar`), 디스크 짝(`hub::persist_hold`)도
    // 같은 축이다. R4까지 여기만 **런타임 시계 ms**(앱 기동 뒤 경과)를 그대로 실어
    // 배너의 "약 N 뒤"가 늘 0이었다 — F2가 적은 "화면도 거짓말한다"의 나머지 반쪽이다.
    let hold = match rt.hold() {
        Some(h) => json!({ "resetAt": runtime_ms_to_epoch_secs(rt.now(), now_ms, h.resets_at),
                           "ready": h.ready }),
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
        // ★R4 — **재개의 주인**(m-logic P6 "행위자 하나" · M-UX R2.9의 이중 전송 축).
        //
        // `resumeOwner: "engine"`은 *"이 채팅의 한도 재개는 Rust가 관장한다"*는 선언이고,
        // 렌더러의 `useLimitResume`은 이 값을 보고 **자기 발화를 꺼야 한다**(`enabled:false`).
        // `autoResume`은 그 안에서 갈리는 스펙 ⑤다: 보이는 자리·열린 창은 스스로 쏘고
        // (`true`), 화면 밖 채팅은 `hold.ready`만 켜고 사용자가 누를 때까지 멈춘다(`false`).
        // 두 값을 하나로 접지 않는 이유는 `status`/`bgActive`를 안 접는 것과 같다 —
        // "관장한다"와 "지금 자동이다"는 다른 사실이고, 표시 쪽이 둘 다 필요하다.
        "autoResume": rt.auto_resume(),
        "resumeOwner": "engine",
        "updatedAt": now_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ★R5 — `resetAt`은 렌더러가 `× 1000 - Date.now()`로 쓰는 **unix 초**여야 한다.
    /// 런타임 시계 ms를 그대로 실으면 배너의 남은 시간이 늘 0이 된다(R14 F2 후반부).
    #[test]
    fn reset_at_leaves_as_unix_seconds() {
        // 앱이 뜬 지 12초(런타임 ms), 벽시계는 1_755_000_000.000초.
        let rt_now = 12_000;
        let wall = 1_755_000_000_000;
        // 대기표는 런타임 기준 5시간 뒤 → 벽시계로 1_755_018_000초
        let v = runtime_ms_to_epoch_secs(rt_now, wall, Some(rt_now + 5 * 3600 * 1000));
        assert_eq!(v.as_f64(), Some(1_755_018_000.0));
        // 시각 미상은 null 그대로 — 렌더러가 "언제 풀리는지 모른다" 문장을 갖고 있다.
        assert!(runtime_ms_to_epoch_secs(rt_now, wall, None).is_null());
        // 이미 지난 시각도 과거로 정직하게 나간다(0으로 접지 않는다).
        let past = runtime_ms_to_epoch_secs(rt_now, wall, Some(2_000));
        assert_eq!(past.as_f64(), Some(1_754_999_990.0));
    }
}
