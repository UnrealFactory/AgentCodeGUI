//! 방출 이벤트. 렌더러 브로드캐스트의 재료이자 **재생 하네스의 단언 대상**이다.
//!
//! 원칙(§5.6): 상태 + 원장은 **REPLACE**. 에지(추가/삭제)만 보내면 한 프레임을 놓쳤을 때
//! 영구 불일치가 된다 — 레벨이 진실, 에지는 장식.

use crate::identity::{FallbackVia, IdentityField, IdentityRejectReason};
use crate::ids::{LiveId, RunId, StreamId};
use crate::live::{AskKind, Confidence, LiveKind, Liveness, SettleReason};
use crate::state::{ResidentWhy, StateTag};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveWire {
    pub id: LiveId,
    pub kind: LiveKind,
    pub label: String,
    pub liveness: Liveness,
    pub gating: crate::live::Gating,
    pub born_run: RunId,
    pub ask: Option<AskWire>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AskWire {
    pub ask_kind: AskKind,
    pub request_id: String,
    pub tool_use_id: Option<String>,
    pub dialog_kind: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettledWire {
    pub id: LiveId,
    pub kind: LiveKind,
    pub reason: SettleReason,
}

/// 정체성 리비전의 출처. "누가 바꿨는가"가 기록된다(P3의 답).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RevisionOrigin {
    Default,
    User,
    EngineFallback(FallbackVia),
    DeferredApply,
    Revert(u32),
    Restore,
}

/// 워치독이 리스를 재장전한 근거. **불변식 11**(프로세스 생존은 근거가 될 수 없다)이 이걸 읽는다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvidenceSource {
    /// ①a 그 항목을 지목한 프레임
    NamedFrame,
    /// ①b 스트림에 프레임이 흐름(PendingSettle 전용)
    StreamFlow,
    /// ③ task_progress 하트비트
    Heartbeat,
    /// ④ 파일 mtime
    Mtime,
    /// ⑥ 능동 프로브(initialize 재전송)
    ActiveProbe,
    /// ⓪ 프로세스 생존 — **여기 등장하면 그 자체가 위반이다**(§5.4-b)
    ProcessAlive,
}

/// 턴의 종결값. **`Done`은 "완료"라는 뜻이고 그 값이 `status.json`에 영속된다** —
/// 사용자가 끊은 턴을 `Done`으로 적으면 재시작 뒤에도 "완료"로 남는다(크리틱 배선 R1 F11).
/// 그래서 어휘를 셋으로 둔다: 끝난 방식이 셋이기 때문이다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalStatus {
    Done,
    Error,
    /// 사용자가 중단한 턴(T13→T14/T15 · T23 · T34). 완료도 오류도 아니다.
    Aborted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Accepted,
    Queued,
    Deferred(&'static str),
    NeedsConfirm,
    Rejected(&'static str),
    Noop,
    Applied,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// 상태기계 상태 + 라이브 원장 REPLACE (§5.6).
    RunState {
        state: StateTag,
        resident_why: Option<ResidentWhy>,
        run_id: Option<RunId>,
        live: Vec<LiveWire>,
        ledger_confidence: Confidence,
        settled: Vec<SettledWire>,
    },
    /// **불변식 15** 전용 — 상태 대입마다 누가 대입했는지(전이 id 또는 `watchdog_loop`).
    StateAssign {
        source: &'static str,
        from: StateTag,
        to: StateTag,
    },
    Identity {
        origin: RevisionOrigin,
        revision: u32,
        hash: String,
        changed: Vec<IdentityField>,
        drifted: Vec<IdentityField>,
        kept_by_fallback: Vec<IdentityField>,
    },
    /// 예약분 접수 브로드캐스트(§4.1) — 컴포저 배지가 그리는 값. **판정이 안 보이는 경로는 없다**(D7).
    IdentityPending {
        preview_hash: String,
        at: &'static str,
        base_revision: u32,
    },
    /// 폴백 인라인 배너 — **전환당 정확히 1개**(불변식 13).
    FallbackBanner {
        from_model: String,
        to_model: String,
        via: FallbackVia,
        revert_to: u32,
    },
    Verdict {
        cmd: &'static str,
        verdict: Verdict,
    },
    /// 큐 REPLACE + 드레인 계획(§7.2).
    Queue {
        items: Vec<String>,
        plan: Vec<PlanGroup>,
    },
    QueueCleared {
        count: usize,
        hold_cancelled: bool,
        undo_token: String,
    },
    Notice(String),
    /// 종결 status — `run_id`마다 정확히 1회(불변식 3).
    Status {
        run_id: RunId,
        status: TerminalStatus,
    },
    Spawn {
        stream: StreamId,
        identity_hash: String,
        resume: Option<String>,
    },
    Exit {
        stream: StreamId,
        cause: crate::live::CloseCause,
    },
    /// stdin EOF. **불변식 12**가 "추정 정착 직후엔 0건"을 검사한다.
    CloseInput {
        stream: StreamId,
    },
    /// 능동 프로브 ⑥ 송신 — 불변식 16(30s 간격·tick당 1회).
    ProbeSent {
        stream: StreamId,
        at_ms: crate::clock::Millis,
    },
    /// 리스 재장전 근거 — 불변식 11.
    EvidenceRearm {
        id: LiveId,
        source: EvidenceSource,
    },
    Settled {
        id: LiveId,
        kind: LiveKind,
        reason: SettleReason,
        at_ms: crate::clock::Millis,
    },
    AskOpened {
        request_id: String,
        ask_kind: AskKind,
    },
    AskClosed {
        request_id: String,
        how: &'static str,
    },
    /// 재스폰 안내 — 사유가 정직해지는 자리(P1c). 정리된 항목이 0개면 문장에 개수를 넣지 않는다.
    RespawnNotice {
        identity: Vec<IdentityField>,
        thread_changed: bool,
        kills: Vec<(LiveKind, usize)>,
        text: String,
    },
    /// 컨트롤 채널로 나간 요청(테스트가 `stop_task`/`interrupt` 송신 유무를 본다).
    ControlSent {
        subtype: &'static str,
        target: Option<String>,
    },
    /// 미지 프레임을 조용히 버렸다(§5.16 · 불변식 10).
    UnknownFrameDropped,
    Compact {
        trigger: String,
        after_tokens: Option<u64>,
    },
    /// 늦게 온 control_response — 조용히 버리고 진단만(§5.7 규약 2).
    UnmatchedControlResponse {
        request_id: String,
    },
    IdentityRejected {
        reason: IdentityRejectReason,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanGroup {
    pub count: usize,
    pub identity_hash: String,
    pub will_respawn: bool,
    pub kills_live: Vec<(LiveKind, usize)>,
}

/// 이벤트 수집기. 코얼레싱 **전** 원본을 그대로 쌓는다(하네스가 순서를 본다).
#[derive(Debug, Default)]
pub struct EventSink {
    pub events: Vec<Event>,
}

impl EventSink {
    pub fn emit(&mut self, e: Event) {
        self.events.push(e);
    }
}
