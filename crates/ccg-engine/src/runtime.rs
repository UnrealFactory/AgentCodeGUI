//! `ChatRuntime` — 정체성·큐·hold·원장·스트림을 한 곳에서 직렬화하는 유일한 행위자.
//! (`docs/design/m-logic.md` §3~§7)
//!
//! 이 파일이 지키는 것 셋:
//! 1. **표가 진실이다** — 상태 전이는 `state.rs`의 표에 있는 id로만 발화한다([`ChatRuntime::set_state`]가 검증).
//! 2. **침묵 no-op 금지**(D7) — 모든 명령은 표의 셀을 먼저 조회하고 `Verdict`를 방출한다.
//! 3. **소유자는 스트림**(P9) — 정착은 `StreamGuard::drop`이 무조건 한다.

use crate::clock::{Clock, Millis, MIN, SEC};
use crate::driver::{
    build_spawn_spec, control_request, control_response, initialize_request, user_message,
    CliDriver,
};
use crate::event::{
    Event, EventSink, EvidenceSource, RevisionOrigin, SettledWire, TerminalStatus, Verdict,
};
use crate::frames::{ask_kind_of, classify_task_type, Frame};
use crate::identity::{
    resolve_fallback_conflicts, ApplyPolicy, BillingAxis, FallbackArm, FallbackVia,
    IdentityDefaults, IdentityError, IdentityField, IdentityRejectReason, PendingOp, RawIdentity,
    RawIdentityPatch, RunIdentity, Staged,
};
use crate::limit::{classify_limit_error, LimitVerdict, MAX_AUTO_ATTEMPTS};
use crate::ids::{ChatId, FrameSeq, LiveId, RunId, StreamId};
use crate::live::{
    AskInfo, AskKind, CloseCause, Confidence, Gating, LiveItem, LiveKind, LiveLedger, Liveness,
    ProbeSource, SettleReason, StreamGuard, SHELL_TURN_GRACE,
};
use crate::queue::{
    drain_plan, LimitHold, OnDrift, QueueInput, QueueOp, QueueOrigin, QueueUndo, QueuedMessage,
    ThreadIntent,
};
use crate::state::{command_cell, Cell as TCell, ResidentWhy, StateTag, StreamClosePolicy};
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};
use std::collections::{BTreeSet, VecDeque};
use std::rc::Rc;
use std::sync::Arc;

/// 워치독 tick(§5.4-c). 재생 하네스는 이 간격으로 시계를 밀어 준다.
pub const TICK: Millis = 5 * SEC;
/// 능동 프로브 ⑥ 최소 간격(채팅당) / 응답 타임아웃.
pub const PROBE_MIN_GAP: Millis = 30 * SEC;
pub const PROBE_TIMEOUT: Millis = 3 * SEC;
/// `Starting` 타임아웃(T3) · 중단 응답 대기(T15) · 유휴 회수(T32).
pub const START_TIMEOUT: Millis = 20 * SEC;
pub const INTERRUPT_TIMEOUT: Millis = 6 * SEC;
pub const STREAM_IDLE_LIMIT: Millis = 6 * 60 * MIN;
/// 무음 `result` 슬라이딩 보류(T10) — 2.5s × 최대 8회 ≈ 22s.
pub const HELD_SLIDE: Millis = 2500;
pub const HELD_MAX_REARMS: u32 = 8;
/// T35의 이탈 확인 유예.
pub const STOP_TASK_GRACE: Millis = 3 * SEC;
/// **T22 백스톱**(§5.4-b ⓪) — `Streaming`/`AwaitingUser`에서 프레임이 이만큼 끊기면
/// ⓪ 프로세스 생존을 *한 번* 묻는다. `Alive`는 아무 의미도 없고(리스를 재장전하지
/// **않는다**), **`Dead`일 때만** 정착시킨다.
///
/// 왜 필요한가: 1차 경로는 stdout EOF(T22)다. 그 신호가 유실되는 경우(리더 스레드가
/// 막히거나 파이프가 상속돼 EOF가 안 오는 경우)에도 채팅이 영구히 굳지 않게 하는
/// 두 번째 그물이다. **`AwaitingUser`의 승인 대기는 무기한이 계약이므로**(m-logic §3.2)
/// 프로세스가 살아 있는 동안에는 이 아크가 절대 발화하지 않는다.
pub const STREAM_STALL_BACKSTOP: Millis = 90 * SEC;

#[derive(Debug, Clone)]
pub enum Cmd {
    Send { text: String },
    /// 예약(★R4 — 본문뿐이던 것이 `{text, images, picker}`가 됐다).
    /// 상태에 따라 *지금 보낼지 세울지*가 갈리므로 명령표의 `enqueue` 행을 탄다.
    Enqueue(QueueInput),
    Interrupt,
    StopAll,
    QueueRestore { token: String },
    Respond { kind: AskKind, request_id: String, accept: bool },
    BgStop { id: LiveId },
    BgBackground,
    IdentitySet { patch: RawIdentityPatch, policy: ApplyPolicy, op: PendingOp },
    IdentityRevert { to: u32 },
    /// 큐 자체를 만지는 op(취소·재정렬·비움). R3까지는 인자 없는 **무동작**이었다
    /// (M-UX R2.1 표 #2: `execute`의 `_ => verdict`).
    QueueMutate(QueueOp),
    HoldCancel,
    Clear,
    SwitchChat,
    NewChat,
    DeleteChat,
    ForkBtw,
    Compact,
    ForceSettle { id: LiveId },
    Dispose,
}

impl Cmd {
    pub fn name(&self) -> &'static str {
        match self {
            Cmd::Send { .. } => "send",
            Cmd::Enqueue(_) => "enqueue",
            Cmd::Interrupt => "interrupt",
            Cmd::StopAll => "stop_all",
            Cmd::QueueRestore { .. } => "queue.restore",
            Cmd::Respond { kind, .. } => match kind {
                AskKind::Permission => "respond_permission",
                AskKind::Question => "respond_question",
                AskKind::Dialog => "respond_dialog",
            },
            Cmd::BgStop { .. } => "bg_task.stop",
            Cmd::BgBackground => "bg_task.background",
            Cmd::IdentitySet { op, .. } => {
                if matches!(op, PendingOp::Cancel) {
                    "identity_set.cancel"
                } else {
                    "identity_set"
                }
            }
            Cmd::IdentityRevert { .. } => "identity_revert",
            Cmd::QueueMutate(_) => "queue.mutate",
            Cmd::HoldCancel => "hold.cancel",
            Cmd::Clear => "clear",
            Cmd::SwitchChat => "switch_chat",
            Cmd::NewChat => "new_chat",
            Cmd::DeleteChat => "delete_chat",
            Cmd::ForkBtw => "fork_btw",
            Cmd::Compact => "compact",
            Cmd::ForceSettle { .. } => "force_settle",
            Cmd::Dispose => "dispose",
        }
    }
}

/// 재사용 판정 — 좌변은 **`stream.spawn_identity`**다(§3.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReuseDecision {
    Reuse,
    Respawn {
        identity: Vec<IdentityField>,
        thread: bool,
    },
    ColdStart,
}

#[derive(Debug, Clone, Default)]
pub struct ThreadLink {
    pub session_id: Option<String>,
    /// **그 `session_id`를 발급한 엔진.** 세션 신원은 엔진 축에 매여 있다 —
    /// Claude의 `session_id`를 codex `thread/resume`의 `threadId`로 넘기면 서버가
    /// 모르는 스레드라 거절하고(반대 방향은 `claude.exe --resume=<codex threadId>`)
    /// **전환 후 첫 턴이 오류 카드로 죽는다.** 스폰 직전에 이 값으로 가른다.
    pub engine: Option<crate::identity::EngineKind>,
    pub cwd_at_bind: Option<String>,
    pub forked_from: Option<String>,
    pub fork_consumed: bool,
    /// `/btw` 등으로 "다음 send는 새 스레드"가 예약된 상태.
    pub want_fresh: bool,
}

struct Turn {
    run_id: RunId,
    turn_ended: bool,
    /// **메인 경로 프레임을 하나라도 봤나.** 문턱이 아주 낮다 — `ping` 한 장이면 선다.
    /// 무음 result 보류(T8)와 미니턴 오판 복구(T9)가 쓰는 값이고, 그 자리에서는 낮은
    /// 문턱이 옳다("CLI가 살아서 뭔가 보내는 중"이 판정 대상이다).
    saw_turn_activity: bool,
    /// ★R28d WCAP R2 — **화면에 남는 산출을 냈나**(`saw_turn_activity`보다 좁다).
    ///
    /// 한도 재발사 상한의 구분자 ②([`ChatRuntime::arm_hold`])만 이 값을 본다. 위의
    /// 넓은 문턱을 그대로 썼더니 `ping`·`message_start`·`thinking_delta` **한 장**이면
    /// 「일했다」가 되어, 시각 미상 축(= codex 대기표의 기본 축)에서 RCAP의 「자동은
    /// 최대 2발」이 통째로 사라졌다 — WCAP 확인 크리틱 R1 §3.2 실측: 같은 12시간 대본에
    /// **엔진 71발 / 렌더러 2발**. 렌더러 짝(`app/src/lib/limitResume.ts::turnDidWork`)은
    /// 화면에 **남은** 어시스턴트 텍스트와 **비어 있지 않은** 도구 그룹만 세므로 이쪽도
    /// 같은 문턱으로 좁힌다: 비어 있지 않은 어시스턴트 텍스트 · 도구 호출 · 도구 결과.
    ///
    /// ★R28d WCAP **R3** — 그 셋째 항목에 **경계**가 붙었다(WCAP 확인 크리틱 R2 §3.3).
    /// R2는 "무엇을 세는가"만 맞추고 **"어느 턴의 것으로 세는가"**를 안 맞췄다: 이 깃발은
    /// *프레임이 도착한 엔진 턴*에 적히는데 렌더러의 `turnDidWork`는 *마지막 사용자 말풍선
    /// 뒤 구간*에서 읽는다. 도구가 그 경계를 넘으면(앞 턴에서 열린 도구의 결과가 재개 턴에
    /// 도착) 엔진만 「일했다」가 되어 같은 71 대 2가 되살아났다. 지금은 **이 턴 안에서
    /// 열린** 도구의 결과만 센다([`Frame::User`] 처리부).
    saw_turn_output: bool,
    held_until: Option<Millis>,
    rearms: u32,
    #[allow(dead_code)]
    turn_start_seq: FrameSeq,
    replayed_once: bool,
    sent_terminal_status: bool,
    delivered_notifs: Vec<String>,
    #[allow(dead_code)]
    from_cli: bool,
    compact_pending: Option<String>,
    result_text: Option<String>,
}

impl Turn {
    /// **유일 생성자.** §3.5의 턴 불변식 리셋이 여기 한 곳에 모여 있다 —
    /// 필드 직접 대입 경로가 없으므로 "리셋을 빠뜨린 턴"이 만들어지지 않는다.
    fn new(run_id: RunId, seq: FrameSeq, from_cli: bool) -> Turn {
        Turn {
            run_id,
            turn_ended: false,
            saw_turn_activity: false,
            saw_turn_output: false,
            held_until: None,
            rearms: 0,
            turn_start_seq: seq,
            replayed_once: false,
            sent_terminal_status: false,
            delivered_notifs: vec![],
            from_cli,
            compact_pending: None,
            result_text: None,
        }
    }
}

struct Stream {
    id: StreamId,
    spawn_identity: RunIdentity,
    /// ★M10 R6 — 이 스트림이 **실제로 들고 뜬** 대화 연결 안내. `spawn_identity`와 같은
    /// 이유로 스트림에 굳는다: 재사용 판정의 좌변은 「지금 설정」이 아니라 「이 프로세스가
    /// 뜰 때의 값」이어야 한다. 이 값이 현재 값과 다르면 재스폰이다(`reuse_decision`).
    spawn_guide: Option<String>,
    state: StateTag,
    why: Option<ResidentWhy>,
    /// 스폰 시점에 굳은 종료 정책(§3.4-b). 런타임 기본값이 바뀌어도 이 스트림은 뜬 값으로 산다.
    #[allow(dead_code)]
    close_policy: StreamClosePolicy,
    last_frame_at: Millis,
    started_at: Millis,
    session_id: Option<String>,
    init_ack: bool,
    init_frame: bool,
    turn: Option<Turn>,
    /// 읽지 않는다 — **존재 자체가 계약**이다. 이 값이 drop 되는 순간 원장이 정착한다(§5.3).
    #[allow(dead_code)]
    guard: Option<StreamGuard>,
    cause: Rc<Cell<CloseCause>>,
    linger_deadline: Option<Millis>,
    interrupt_deadline: Option<Millis>,
    /// **재주입 금지 표식**(T14 note · T12 가드의 "중단 요청 없음" — ★R2 크리틱 C6).
    ///
    /// 턴이 아니라 **스트림**에 붙는다. 중단은 턴을 끝내지만(T14) 그 뒤에 CLI가 고아 통지로
    /// 스스로 깨는 턴(T19)이 남아 있고, 그 턴이 또 무음이면 T12가 *"이어서 진행해 주세요"*를
    /// 자동으로 밀어 넣는다 — **사용자가 방금 세운 것을 기계가 다시 켜는 자리**다
    /// (메모리의 실버그 *"중단 1회 → 고아 통지 → 턴마다 CLI 사망 루프"*와 정확히 인접하다).
    /// 사용자가 **직접** 다음 턴을 시작하면(T16) 그때 내려간다.
    interrupt_marker: bool,
    stop_deadline: Option<Millis>,
    stopping: Vec<LiveId>,
    closing: bool,
    last_probe_at: Option<Millis>,
    probe_inflight_until: Option<Millis>,
    probe_expect: Vec<LiveId>,
    pub hung_probes: u32,
    probe_id: u64,
}

pub struct ChatRuntime<D: CliDriver> {
    pub chat_id: ChatId,
    clock: Arc<dyn Clock>,
    now_cell: Rc<Cell<Millis>>,
    sink: Rc<RefCell<EventSink>>,
    ledger: Rc<RefCell<LiveLedger>>,
    pub defaults: IdentityDefaults,
    identity_raw: RawIdentity,
    identity: RunIdentity,
    pub unresolved: Option<IdentityRejectReason>,
    pending: Option<Staged>,
    revision: u32,
    revisions: Vec<(u32, RunIdentity)>,
    fallback_arms: Vec<FallbackArm>,
    observed_model: Option<String>,
    pub thread: ThreadLink,
    queue: VecDeque<QueuedMessage>,
    queue_undo: Option<QueueUndo>,
    hold: Option<LimitHold>,
    stream: Option<Stream>,
    driver: D,
    frame_seq: FrameSeq,
    next_stream: u64,
    next_run: u64,
    next_qid: u64,
    pub close_policy: StreamClosePolicy,
    pub spawns: usize,
    pub exits: usize,
    /// ★M10 R6 — 스폰 직전에 시스템 프롬프트에 덧붙일 **「대화 연결」 안내**.
    ///
    /// R5 실증이 남긴 결함 하나가 여기다: 이 앱은 발신자에게 `@talk[…]` 라는 통로가
    /// 있다고 **말해 준 적이 없었다**(`@talk` 문법이 모델에게 적히는 자리는 이미 봉투를
    /// 받은 세션에게 주는 회신 안내 한 곳뿐이었다). 그래서 기능이 도는지가 「모델이
    /// 사용자 프롬프트의 주장을 믿어 주느냐」에 달려 있었다 — 정당한 협업 프롬프트도
    /// 5회 중 1회는 *"저는 다른 세션으로 메시지를 보낼 수 없습니다"* 로 끝났다.
    ///
    /// **정체성(`RunIdentity`)에 안 넣는 이유.** 정체성은 `Event::Identity` →
    /// `chats_v3::set_owned`로 **디스크에 굳는다**. 보드 옵트인은 사용자가 언제든 걷는
    /// 값인데, 그 문면이 채팅 설정 파일에 남으면 보드를 꺼도 흔적이 산다 —
    /// 「꺼짐이 진짜 꺼짐」이 깨진다. 그래서 셸이 스폰마다 얹는 **비영속 축**이다.
    ///
    /// 대신 [`ChatRuntime::reuse_decision`]이 이 값을 함께 본다. 안 그러면
    /// 보드를 끈 뒤에도 **도는 CLI는 계속 그 통로를 알고 있다**(라우터가 `off`로
    /// 거절하므로 나가지는 않지만, 모델에게 거짓을 가르친 채로 도는 것은 그 자체가 결함이다).
    talk_guide: Option<String>,
    cli_path: std::path::PathBuf,
    /// 앱 홈 — 계정 격리 `CLAUDE_CONFIG_DIR`의 뿌리.
    pub home: std::path::PathBuf,
    account_dir_override: Option<std::path::PathBuf>,
    /// 실제로 밟은 전이/프레임소화 id — 커버리지 게이트의 원본 데이터(재생 §3.5 `covers`).
    fired: RefCell<std::collections::BTreeSet<&'static str>>,
    /// 재스폰 진행 중 표식 — 종료 처리(T25/T26)가 **다음 큐 항목을 먼저 집어가는 것**을 막는다.
    /// 없으면 드레인 순서가 뒤집히고 스폰이 하나 더 난다(재생 #4가 잡아낸 실제 함정).
    suspend_drain: bool,
    /// F14의 `tool_use_id → task_id` 매핑.
    task_by_tool_use: std::collections::BTreeMap<String, String>,
    /// stdin으로 나간 프롬프트 — 불변식 7(이중 전송 없음)이 읽는다.
    sent_user_texts: Vec<String>,
    /// `request_id` → 그 카드의 **응답 본문 오버라이드**(1회 소비). 비어 있는 것이 기본이다.
    staged_payloads: std::collections::BTreeMap<String, Value>,
    /// **한도 해제를 스스로 발사해도 되는가**(스펙 ⑤ 기본값 — ux-chat-unify §8-5).
    ///
    /// R2 제안이 그대로 기본값이다: *"보이는 자리 + 열린 창 = 자동 발사 / 나머지 =
    /// `ready`만 표시하고 사용자가 누르면 발사"*. 그래서 이 값은 **셸이 정한다**
    /// (`set_auto_resume`) — 부팅 재장전은 화면 밖 채팅 6개가 동시에 토큰을 쓰기
    /// 시작하는 일을 만들면 안 된다.
    ///
    /// 기본은 `true`다 — 라이브 경로(사용자가 지금 보고 있는 채팅에서 한도에 걸림)는
    /// 2.6.2와 같아야 하고, 재생 시나리오 전부가 그 동작을 잠그고 있다.
    auto_resume: bool,
    /// **방금 스트림으로 나간 사용자 발화**(★R4 — 1회 소비).
    ///
    /// 엔진이 스스로 연 턴(예약 드레인 T16/T17/T27 · 한도 재개)에는 렌더러가 만든
    /// 말풍선이 없다 — 답만 도착한다(M-UX R2.1 표 #4). 셸이 그 자리에 사용자 에코를
    /// 그리려면 *원문*(첨부 노트가 접히기 **전** 값)과 첨부 목록이 필요하다.
    last_echo: Option<SentEcho>,
    /// ★R5 — **연속으로 헛돈 자동 재개** 수. 재개 턴이 또 한도 에러로 죽으면 다음 대기표가
    /// 이 값을 `attempts`로 물려받아 백오프·상한을 적용한다. 사용자 발화·사용자가 누른
    /// 이어가기·한도 없이 착지한 턴이 0으로 되돌린다.
    ///
    /// ★R28d WCAP — 되돌리는 자리가 둘 더 있다([`Self::arm_hold`]): **창이 진짜로 넘어갔거나
    /// 그 턴이 일을 했으면 헛돈 것이 아니다.** 그 둘이 없던 판에서는 5시간을 꽉 채워 일하고
    /// 다음 창에서 막힌 재개까지 이 값을 올려, 밤샘 연속 주행이 창 두 개에서 잘렸다.
    auto_resume_streak: u32,
    /// ★R28d WCAP — **직전에 자동 발사한 대기표의 리셋 시각**(런타임 ms · 모르면 `None`).
    /// [`Self::arm_hold`]의 구분자 ①이 읽는 유일한 값이다: 새 한도 문구의 시각이 이보다
    /// 뒤면 5시간 창이 진짜로 넘어갔다는 뜻이고, 그 사이의 재개는 헛발질이 아니다.
    ///
    /// [`Self::auto_resume_streak`]와 **짝으로만** 의미가 있다. 값을 넣는 자리는 계수를
    /// 올리는 자리 하나뿐이라([`Self::consume_hold`]) `streak > 0`이면 이 값도 그 발사의
    /// 것임이 보장된다 — 계수를 0으로 되돌리는 네 자리는 이 값을 안 지워도 무해하다
    /// (계수가 0이면 아래 판정이 어차피 0을 낸다).
    auto_resume_at: Option<Millis>,
    /// ★R28e WFIRE — **직전 자동 발사의 시각**(런타임 ms). [`Self::arm_hold`]의 구분자 ②가
    /// 「그 턴이 얼마나 살았나」를 재는 유일한 기준점이고, 렌더러 짝은 스토어의
    /// `SessionState.turnAt`이다(`app/src/lib/useLimitResume.ts`).
    ///
    /// `auto_resume_at`(직전에 쏜 **표의 리셋 시각**)과 헷갈리기 쉬워 이름을 나눠 둔다:
    /// 저쪽은 *벽의 좌표*, 이쪽은 *발사 순간*이다. 둘 다 [`Self::consume_hold`] 한 곳에서만
    /// 놓인다.
    auto_resume_fired_at: Option<Millis>,
    /// ★R28e WFIRE — **이 한도 에피소드에서 태운 자동 재개 턴의 총계**
    /// ([`crate::limit::MAX_EPISODE_FIRES`]).
    ///
    /// [`Self::auto_resume_streak`]와 **지우는 자리가 다른 것이 요점이다.** 연속 계수는
    /// 「창이 넘어갔다(①)」·「그 턴이 일했다(②)」가 0으로 되돌리지만 이 예산은 안 되돌린다 —
    /// 그래서 *산출 한 줄*로는 못 지운다. 되돌아가는 자리는 사람 손이 닿은 세 곳
    /// (사용자 발화 · 사용자가 누른 이어가기 · 계정 전환)과 **한도 없이 착지한 턴** 하나다.
    ///
    /// 겨눈 격차(WCAP 확인 크리틱 R2 §5.1): 시각 미상 축에서 재개 턴이 텍스트 한 줄만 내면
    /// `auto_resume_streak`가 영영 0이 되어 12시간 **71발**이 나갔다.
    episode_fires: u32,
    /// ★R5 — 발화 직전 신선 usage 재검증 훅([`crate::limit::LimitProbe`]).
    /// 기본은 `NoProbe`(=미배선)라 기존 동작과 같고, 셸이 붙이면 2.6.2 `fire()`가 된다.
    limit_probe: Arc<dyn crate::limit::LimitProbe>,
    /// ★M11 — 한도 소진 시 **노는 계정으로 갈아타기** 훅. 기본은 `NoSwitch`(항상 `None`)라
    /// 이 기능이 없던 판과 동작이 같다. 설정이 꺼져 있으면 셸이 붙인 훅도 `None`을 낸다.
    switcher: Arc<dyn crate::limit::AccountSwitcher>,
    /// ★M11 — **이 한도 에피소드에서 이미 거쳐 온 계정.** A→B→A 핑퐁을 막는 유일한
    /// 장치다(B가 곧바로 또 막히면 A는 아직 안 풀렸을 확률이 높다). 한도 없이 착지한
    /// 턴이 `auto_resume_streak`과 함께 비운다 — 에피소드가 끝났다는 같은 신호다.
    switch_tried: BTreeSet<String>,
    /// ★M11 R2(C2) — **같은 훅을 쓰는 채팅들의 후보 예약 장부**(스탬피드 방지).
    /// 훅을 안 꽂은 런타임은 자기만의 빈 장부를 들고 있어 아무 일도 안 한다.
    switch_ledger: Arc<crate::limit::SwitchLedger>,
}

/// ★M11 — 대기 문장을 미뤄 둘 수 있는 최대 시간. 훅이 이 안에 답을 못 내면 그냥 말한다
/// (침묵보다 늦은 말이 낫다 — D7).
const HOLD_NOTICE_GRACE: Millis = 5_000;

/// ★M11 R2(C2) — 훅이 낡은 답을 줬을 때 **다시 물어보는** 횟수 상한.
///
/// 대기하던 채팅들이 한 tick에 동시에 열리면 전부 같은 1등을 받는다. 이미 다른 채팅이
/// 집은 계정이면([`crate::limit::SwitchLedger`]) 그 답은 낡은 것이므로 그 계정을 빼고
/// 한 번 더 묻는다. 계정 수만큼 반복될 수 있으므로 상한을 둔다(무한 재질문 금지).
const SWITCH_REASK_MAX: usize = 8;

/// 셸이 사용자 에코를 그리는 데 필요한 최소값.
#[derive(Debug, Clone)]
pub struct SentEcho {
    pub run_id: RunId,
    /// 사용자가 실제로 친 문장(첨부 노트 **없음**).
    pub text: String,
    pub images: Vec<String>,
    pub origin: QueueOrigin,
}

/// 재검증 훅이 없을 때의 기본 — 언제나 `Unknown`(=2.6.2 `fire()`의 `catch` 가지).
struct NoProbe;
impl crate::limit::LimitProbe for NoProbe {
    fn blocked_until(&self, _a: &BillingAxis, _now_epoch_ms: u64) -> LimitVerdict {
        LimitVerdict::Unknown
    }
}

/// ★M11 — 전환 훅이 없을 때의 기본. **언제나 후보 없음** = 이 기능이 없던 판 그대로.
struct NoSwitch;
impl crate::limit::AccountSwitcher for NoSwitch {
    fn pick(&self, _r: &crate::limit::SwitchRequest) -> Option<crate::limit::SwitchPick> {
        None
    }
}

/// 부팅 재장전이 실어 오는 한도 대기표(§5.8 2단계). `account`는 **지금 정체성**에서
/// 다시 만든다 — 계정이 바뀌었으면 대기표는 무효라는 §7.3 규약을 재장전에도 그대로
/// 적용하기 위해서다(발화 시점에 `check_hold`가 잰다).
#[derive(Debug, Clone, Copy, Default)]
pub struct ReloadHold {
    /// **지금부터 남은 시간(ms)** — 절대 시각이 아니다.
    ///
    /// 디스크의 `resetsAt`은 epoch 초이고 런타임 시계는 프로세스 기동 기준 단조
    /// 밀리초다(`SystemClock` — 사용자가 시각을 바꿔도 타이머가 과거로 점프하지 않게).
    /// 두 축을 섞으면 대기표가 1970년으로 읽혀 **부팅이 곧 전송**이 된다. 그래서
    /// 경계에서 남은 시간으로 옮기고, 여기서 `now`를 더한다.
    pub in_ms: Option<Millis>,
    pub ready: bool,
    /// ★R28f WFIRE — **연속 헛발질 계수**([`LimitHold::attempts`]의 디스크 짝).
    ///
    /// R28e까지 이 칸이 없었고 [`Self::reload_state`]가 무조건 `0`을 놓았다. 렌더러
    /// (`sanitizeHold`)는 R28c부터 이 값을 살려 복원하고 있었으므로 **두 축의 규칙이
    /// 갈린 자리**였다 — 재시작 한 번이 「눈감고 두 발」을 공짜로 만들었다.
    pub attempts: u32,
    /// ★R28f WFIRE — **이 에피소드가 이미 태운 자동 재개의 총계**
    /// ([`ChatRuntime::episode_fires`]의 디스크 짝 · 상한은 [`crate::limit::MAX_EPISODE_FIRES`]).
    ///
    /// **왜 이 칸이 예산의 존폐를 가르나**(R28e 확인 크리틱 R1 §4.1 실측): 예산을 다 쓴
    /// 대본을 새 런타임에 `reload_state`로 재장전하니 20시간 **12발 재충전**이 나왔다.
    /// 「아무 구분자도 못 지우는 총계」라고 적어 둔 값이 프로세스 경계 하나에 통째로
    /// 지워지면 그건 예산이 아니라 **재시작 버튼 하나짜리 무제한**이다.
    ///
    /// 예산을 **0으로 되돌리는** 자리는 셋이다 — 사람 손(`resume_now`·사용자 전송) ·
    /// 한도가 아닌 착지 · `/clear`류. 재시작은 그 셋이 아니다.
    ///
    /// ★R28g BANNER — 다만 「재시작은 예산을 못 지운다」를 **절대문으로** 적으면 거짓이다
    /// (R28f 확인 크리틱 R1 F2). `hub::persist_hold`는 표가 없으면 디스크에 `null`을 적으므로,
    /// *발사한 직후 ~ 다음 표가 설 때까지*는 예산이 디스크에 아예 없다. R28f 보고서 §미완 2는
    /// 그 창을 「턴 하나(분 단위)」라고 적었는데 **크기가 틀렸다** — 크리틱의 실측
    /// (`c7_disk_blind_window`)은 에피소드 시간의 **44~77%**이고 최장 공백이 **4.5시간**이다:
    ///
    /// | 대본 | 표가 디스크에 없는 시간 | 최장 공백 |
    /// |---|---|---|
    /// | 밤샘(45분 작업) | 5.25h / 12h = **44%** | 45분 |
    /// | 5시간 창·4.5시간 작업(예산 12발을 정의하는 그 대본) | 54h / 70h = **77%** | **4.5시간** |
    /// | 텍스트 즉사(빠른 헛돌이) | 0h (0%) | 0 |
    ///
    /// 즉 「분 단위」가 맞는 것은 예산이 필요 없는 대본뿐이고, 예산이 존재하는 이유인
    /// 「오래 일하며 천천히 죽는」 축에서는 에피소드의 3/4이 무방비다. 실손해는 여전히
    /// 제한적이다(그 창에서 재시작하면 다음 표를 세우는 데 턴이 하나 필요하고, 그게 사용자
    /// 턴이면 어차피 예산이 열린다) — 그러나 **문장은 사실이어야 한다.**
    pub fires: u32,
    /// ★R28g BANNER — **이 표는 이미 접혀 있었다**([`crate::queue::LimitHold::auto_paused`]의
    /// 디스크 짝 · 쓰는 쪽은 `hub::persist_hold`, 나르는 쪽은 `status::HoldLite::paused`).
    ///
    /// R28f는 이 칸을 **일부러 안 뒀다**. 근거는 「`auto_paused`는 판정 결과이고 판정은
    /// 부팅 뒤 `check_hold`가 다시 한다」였는데, 확인 크리틱 R1 F1이 그 문장을 실측으로
    /// 깼다 — `check_hold`의 첫 문이 `filter(|h| !h.ready)`라 **접힌 표(=`ready:true`)는
    /// 재판정에 도달하지 못한다.** 그래서 부팅 행이 `paused:false`로 서고, 12발을 태우고
    /// 여전히 막힌 표에 대고 배너가 「한도가 풀렸어요 — 눌러서 이어가기」라고 말했다
    /// (포획된 실앱 원문: `{"ready":true,"fires":12,"paused":false}` → 실번들
    /// `budgetLanding(false,12)=false`).
    ///
    /// 고치는 길은 셋이었고(영속 · 재판정 · 부팅 행에서 `fires`로 재구성) **첫째를 본선으로**
    /// 골랐다: 참이었던 상태를 잃지 않는 것이 가장 정직하고, 부팅 행이 진실을 담으면
    /// `status.rs`의 상수 `false`도 자연히 사라진다. 재판정(둘째)은 [`Self::reload_state`]가
    /// 켜는 [`crate::queue::LimitHold::reloaded`]로 **함께** 처리한다 — 접힘의 근거
    /// (`attempts`·`fires`)도 같이 건너오므로 그 재판정은 같은 답을 낸다(못 ⑰의 대조군).
    pub paused: bool,
}

impl<D: CliDriver> ChatRuntime<D> {
    pub fn new(
        chat_id: impl Into<ChatId>,
        raw: RawIdentity,
        defaults: IdentityDefaults,
        clock: Arc<dyn Clock>,
        driver: D,
    ) -> Result<ChatRuntime<D>, IdentityError> {
        let identity = RunIdentity::normalize(raw.clone(), &defaults)?;
        let now = clock.now_ms();
        let rt = ChatRuntime {
            chat_id: chat_id.into(),
            clock,
            now_cell: Rc::new(Cell::new(now)),
            sink: Rc::new(RefCell::new(EventSink::default())),
            ledger: Rc::new(RefCell::new(LiveLedger::default())),
            defaults,
            identity_raw: raw,
            identity: identity.clone(),
            unresolved: None,
            pending: None,
            revision: 0,
            revisions: vec![(0, identity.clone())],
            fallback_arms: vec![],
            observed_model: None,
            thread: ThreadLink::default(),
            queue: VecDeque::new(),
            queue_undo: None,
            hold: None,
            stream: None,
            driver,
            frame_seq: 0,
            next_stream: 1,
            next_run: 1,
            next_qid: 1,
            close_policy: StreamClosePolicy::OnIdle,
            spawns: 0,
            exits: 0,
            talk_guide: None,
            cli_path: std::path::PathBuf::from("claude.exe"),
            home: std::path::PathBuf::from("C:\\ccg-fixture\\home\\.agentcodegui"),
            account_dir_override: None,
            fired: RefCell::new(Default::default()),
            suspend_drain: false,
            task_by_tool_use: Default::default(),
            sent_user_texts: vec![],
            staged_payloads: Default::default(),
            auto_resume: true,
            last_echo: None,
            auto_resume_streak: 0,
            auto_resume_at: None,
            auto_resume_fired_at: None,
            episode_fires: 0,
            limit_probe: Arc::new(NoProbe),
            switcher: Arc::new(NoSwitch),
            switch_tried: BTreeSet::new(),
            switch_ledger: Arc::new(crate::limit::SwitchLedger::default()),
        };
        rt.emit(Event::Identity {
            origin: RevisionOrigin::Default,
            revision: 0,
            hash: identity.hash(),
            changed: vec![],
            drifted: vec![],
            kept_by_fallback: vec![],
        });
        Ok(rt)
    }

    pub fn with_cli_path(mut self, p: std::path::PathBuf) -> Self {
        self.cli_path = p;
        self
    }

    /// ★M10 R6 — 셸이 턴을 열 때마다 다시 얹는 **「대화 연결」 안내**(§[`Self::talk_guide`]).
    ///
    /// `None` = 이 채팅은 대화 연결이 꺼진 자리다. 그때 `initialize` 프레임은
    /// `systemPrompt` 키 자체를 **안 싣는다** — 꺼진 보드의 프롬프트 바이트는
    /// 한 톨도 안 변한다(그게 이 기능의 옵트인 규약이다).
    pub fn set_talk_guide(&mut self, guide: Option<String>) {
        self.talk_guide = guide;
    }

    /// `initialize`에 실을 **append 프롬프트**. 둘을 이어 붙인다:
    ///
    /// | 조각 | 어디서 | R6 전 |
    /// |---|---|---|
    /// | 채팅별 추가 지시(`RunIdentity::system_prompt`) | 사용자 설정 | Codex는 `developerInstructions`로 이미 싣고 있었는데 **Claude는 한 번도 안 나갔다** — 두 호출처가 무조건 `None`이었다 |
    /// | 대화 연결 안내 | 보드 옵트인(비영속) | 아예 없었다 |
    ///
    /// 둘 다 없으면 `None`이고, 그때 `initialize_request`는 `systemPrompt` 키를
    /// 넣지 않는다(빈 문자열을 실으면 CLI가 `claude_code` 프리셋을 죽인다 — driver §4.2).
    fn append_prompt(id: &RunIdentity, guide: Option<&str>) -> Option<String> {
        let mut parts: Vec<&str> = vec![];
        if let Some(p) = id.system_prompt() {
            parts.push(p);
        }
        if let Some(g) = guide.filter(|g| !g.trim().is_empty()) {
            parts.push(g);
        }
        (!parts.is_empty()).then(|| parts.join("\n\n"))
    }
    /// ★R5 — 발화 직전 **신선 usage 재검증** 훅을 꽂는다(2.6.2 `useLimitResume.fire()`).
    ///
    /// 안 꽂으면 `Unknown`만 돌려주는 기본 훅이 서고, 그때의 안전장치는 로컬 상한
    /// ([`crate::limit::MAX_AUTO_ATTEMPTS`])과 지수 백오프다.
    pub fn with_limit_probe(mut self, p: Arc<dyn crate::limit::LimitProbe>) -> Self {
        self.limit_probe = p;
        self
    }
    /// ★M11 — **한도 소진 시 노는 계정으로 갈아타기** 훅([`crate::limit::AccountSwitcher`]).
    ///
    /// 안 꽂으면 후보가 늘 없어서 옛 경로(대기표)만 남는다. 설정이 꺼져 있을 때 셸이
    /// 붙인 훅이 내는 값도 마찬가지 `None`이다 — **꺼짐 = 무동작**이 두 층에서 참이다.
    pub fn with_account_switcher(mut self, s: Arc<dyn crate::limit::AccountSwitcher>) -> Self {
        // ★M11 R2(C2) — 같은 훅을 나눠 쓰는 채팅들은 **같은 예약 장부**를 본다.
        // 그래야 한 tick에 동시에 열린 채팅들이 같은 계정을 두 번 집지 않는다.
        self.switch_ledger = crate::limit::ledger_for(&s);
        self.switcher = s;
        self
    }
    /// 이 한도 에피소드에서 거쳐 온 계정(진단·하네스 판독용).
    pub fn switch_tried(&self) -> &BTreeSet<String> {
        &self.switch_tried
    }
    /// unix **초** → **런타임 시계 ms**.
    ///
    /// 한도 리셋 시각은 바깥 세계의 값이라 벽시계 축이고(에러 문구 꼬리 ·
    /// `rate_limit_event.resetsAt`), 타이머는 단조 축이다. 섞으면 대기표가 1970년
    /// (부팅이 곧 전송) 또는 2026년(영원히 안 풀림)에 앉는다 — 이 함수 하나가 그 환승역이다.
    /// 이미 지난 시각은 `now`로 접고, 너무 먼 시각은 [`crate::limit::MAX_WAIT`]로 깎는다
    /// (사용자 시계가 어긋나 있으면 표가 몇 년 뒤에 앉는다).
    fn epoch_secs_to_runtime(&self, epoch_secs: u64) -> Millis {
        let now = self.now();
        let wall = self.clock.now_epoch_ms();
        let left = epoch_secs
            .saturating_mul(1000)
            .saturating_sub(wall)
            .min(crate::limit::MAX_WAIT);
        now + left
    }
    pub fn with_close_policy(mut self, p: StreamClosePolicy) -> Self {
        self.close_policy = p;
        self
    }
    pub fn with_home(mut self, p: std::path::PathBuf) -> Self {
        self.home = p;
        self
    }

    /// 계정 격리 `CLAUDE_CONFIG_DIR`(§8.6 `accountRunDir`).
    ///
    /// 실물 폴더 이름은 `<slug>-<임의 접미사>`다(예: `a_x-68e935`) — 슬러그만으로 조립하면
    /// **존재하지 않는 폴더**가 되어 CLI가 미로그인 상태로 뜬다. 그래서 접두 스캔이 1순위,
    /// 조립은 폴백이다(2.6.2 `accountRunDir` + PoC `default_account_dir` 파리티).
    pub fn account_dir(&self, email: &str) -> std::path::PathBuf {
        if let Some(p) = &self.account_dir_override {
            return p.clone();
        }
        let slug = email.replace('@', "_").replace('+', "-");
        let root = self.home.join("accounts");
        if let Ok(rd) = std::fs::read_dir(&root) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().to_string();
                if n == slug || n.starts_with(&format!("{slug}-")) {
                    return root.join(n);
                }
            }
        }
        root.join(slug)
    }

    /// 라이브 스모크 전용 — 자격증명을 **복사한** 격리 폴더를 강제한다(실홈 쓰기 방지).
    pub fn with_account_dir_override(mut self, p: std::path::PathBuf) -> Self {
        self.account_dir_override = Some(p);
        self
    }

    // ── 접근자 ───────────────────────────────────────────────────────────────
    pub fn now(&self) -> Millis {
        self.clock.now_ms()
    }
    pub fn state(&self) -> StateTag {
        self.stream.as_ref().map(|s| s.state).unwrap_or(StateTag::Idle)
    }
    pub fn resident_why(&self) -> Option<ResidentWhy> {
        self.stream.as_ref().and_then(|s| s.why)
    }
    pub fn busy(&self) -> bool {
        self.state().busy()
    }
    pub fn identity(&self) -> &RunIdentity {
        &self.identity
    }
    pub fn identity_raw(&self) -> &RawIdentity {
        &self.identity_raw
    }
    pub fn revision(&self) -> u32 {
        self.revision
    }
    pub fn queue_len(&self) -> usize {
        self.queue.len()
    }
    pub fn queue_texts(&self) -> Vec<String> {
        self.queue.iter().map(|m| m.text.clone()).collect()
    }
    /// 큐 전문 — 셸이 `chat:queue` REPLACE에 **첨부·정체성 스냅샷까지** 실을 때 쓴다(★R4).
    /// `queue_texts`만 있던 R3에서는 렌더러가 그 목록으로 자기 예약을 대체할 수 없었다.
    pub fn queue_items(&self) -> impl Iterator<Item = &QueuedMessage> {
        self.queue.iter()
    }
    pub fn hold(&self) -> Option<&LimitHold> {
        self.hold.as_ref()
    }
    /// ★R28e WFIRE — 이 한도 에피소드가 지금까지 태운 자동 재개 턴 수
    /// ([`crate::limit::MAX_EPISODE_FIRES`] 예산의 소비분). 표 밖에 사는 값이라
    /// [`Self::hold`]로는 안 보인다 — 못(`tests/wcap_limit_streak.rs` ⑩~⑬)과 셸의 진단이 읽는다.
    pub fn episode_fires(&self) -> u32 {
        self.episode_fires
    }
    /// 지금 턴의 `RunId`(스트림·턴이 없으면 `None`).
    pub fn run_id(&self) -> Option<RunId> {
        self.stream.as_ref().and_then(|s| s.turn.as_ref().map(|t| t.run_id))
    }
    /// 방금 나간 사용자 발화를 **가져가며 비운다**(★R4 — 셸의 에코 1회 소비).
    pub fn take_echo(&mut self) -> Option<SentEcho> {
        self.last_echo.take()
    }
    pub fn auto_resume(&self) -> bool {
        self.auto_resume
    }
    /// 스펙 ⑤ — **보이는 자리 + 열린 창만 자동 발사**. 셸이 부팅 재장전과 자리 변화에서 정한다.
    pub fn set_auto_resume(&mut self, on: bool) {
        self.auto_resume = on;
    }

    /// **부팅 재장전**(m-logic §5.8 부팅 경로 2단계 · ux-chat-unify §4.3).
    ///
    /// "복원"이 아니라 "재장전"이다: 저장된 `resetsAt`으로 타이머를 **다시 걸 뿐**이고
    /// 발화 판정(계정 재검증 · `ready`)은 [`Self::check_hold`]가 그때 다시 한다.
    ///
    /// **드레인하지 않는다.** 앱을 켜는 것은 "보내라"가 아니다 — 예약분은 큐에 그대로
    /// 서 있고, 나가는 계기는 ① 사용자의 다음 전송 ② 한도 해제(§7.3)뿐이다.
    /// (2.6.2도 재시작 직후 예약을 스스로 쏘지 않았다.)
    pub fn reload_state(&mut self, queued: Vec<QueueInput>, hold: Option<ReloadHold>) {
        let now = self.sync_now();
        for q in queued {
            if q.text.is_empty() && q.images.is_empty() {
                continue;
            }
            // ★M10 R2 C4 — **신분은 재시작으로 바뀌지 않는다.** 여기가 `User` 고정이던
            // 탓에, 디스크에 `talk`으로 앉아 있던 세션 간 예약이 부팅 한 번에 사람 것으로
            // 되살아나 그 값이 다시 굳었다(크리틱 A7). 셸이 원본을 안 실으면(옛 파일 ·
            // 2.6.2 문자열 배열) 여전히 `User`다 — 그쪽은 실제로 사람의 예약이다.
            let origin = q.origin.unwrap_or(QueueOrigin::User);
            let m = self.make_queue_item(q, origin, now);
            self.queue.push_back(m);
        }
        if let Some(h) = hold {
            self.hold = Some(LimitHold {
                account: self.identity.billing().clone(),
                // ★R5 — 저장된 값이 없으면 **미상 그대로** 둔다(옛 판은 `now + 5분`으로
                // 채워 부팅 6.5분 뒤 헛 재개를 한 번 태웠다). 미상 대기는 `due_at`이
                // 2.6.2 `PROBE_MS`(10분)로 잡는다.
                resets_at: h.in_ms.map(|d| now + d),
                verified_at: None,
                ready: h.ready,
                // ★R28g BANNER — **접힘도 물려받는다.** R28f는 이 자리에 `false`를 놓고
                // 「판정 결과는 안 나르고 `check_hold`가 재장전 뒤 다시 판정한다」고 적었는데,
                // 그 문장이 **거짓**이었다(확인 크리틱 R1 F1): `check_hold`의 첫 문
                // `filter(|h| !h.ready)`가 접힌 표를 영영 재판정에서 뺀다. 그래서 12발을
                // 태운 표가 부팅 한 번에 `paused:false`로 되살아나 배너가 「한도가 풀렸어요」
                // 라고 말했다. 참이었던 상태를 잃지 않는 쪽이 정직하다.
                //
                // 아래 `reloaded`가 그 재판정을 **실제로 있게** 만든다 — 둘은 경쟁이 아니라
                // 짝이다: 이 칸이 부팅 **첫 프레임**의 진실을 맡고, `reloaded`가 그 뒤의
                // 재판정을 맡는다(접힘의 근거인 `attempts`·`fires`도 같이 건너오므로 그
                // 재판정은 같은 답을 낸다 — `tests/wcap_limit_streak.rs` ⑰).
                auto_paused: h.paused,
                // ★R28f WFIRE — **재장전은 새 에피소드가 아니다.** R28e까지 이 자리는
                // `attempts: 0`이었고 주석은 "지난 판의 헛발질 횟수는 디스크에 없다"였다 —
                // 그 문장이 사실이었던 이유는 우리가 안 적었기 때문이다(경계가 안 실어
                // 보냈다). 이제 `hub::persist_hold`가 적고 `status::HoldLite`가 읽는다.
                attempts: h.attempts,
                probes: 0,
                probed_at: None,
                armed_from_run: RunId(0),
                // 재장전된 예약은 표와 **같은 순간**에 선다 — `>` 비교라 "표 뒤에 온
                // 사용자 메시지"로 오인되지 않는다(그래야 §7.3의 재개 항목이 그대로 산다).
                armed_at: now,
                // 재장전은 문장을 말하지 않는다(부팅 직후 옛 한도 문구를 다시 뱉을 이유가
                // 없다) — 미뤄 둔 문장도 없다.
                notice_due: false,
                // ★R28g BANNER — **부팅 뒤 첫 판정 통행권**([`crate::queue::LimitHold::reloaded`]).
                // 이 칸을 켜는 자리는 여기 하나뿐이다: 표가 `ready`로 디스크에서 돌아왔다는
                // 것은 「지난 프로세스가 그렇게 판정했다」이지 「이 프로세스가 판정했다」가
                // 아니다. 켜지 않으면 `check_hold`의 `filter(|h| !h.ready)`가 그 표를 영영
                // 안 보고, 자동 재개가 켜진 채팅의 배너는 「곧 이어서 계속해요」라고 말한
                // 뒤 아무 일도 하지 않는다(크리틱 R1 F3 실측: 20시간 0발).
                reloaded: true,
            });
            // ★R28f WFIRE — 예산은 표 **밖**에 산다([`Self::episode_fires`]) — 표를 다시
            // 세우는 것만으로는 안 돌아온다. 여기서 함께 놓지 않으면 위 `attempts`만
            // 물려받고 「천천히 죽는 축」의 천장(12발)은 재시작마다 새로 열린다
            // (R28e 확인 크리틱 R1 §4.1 실측: 재장전 뒤 20시간 12발 재충전).
            //
            // 짝인 `auto_resume_at`/`auto_resume_fired_at`은 **안 놓는다.** 그 둘은
            // *직전에 쏜 표의 벽*과 *그 발사의 런타임 시각*이고, 런타임 시계는 프로세스마다
            // 0에서 다시 시작한다 — 옛 프로세스의 ms를 새 축에 놓으면 구분자 ①·②가
            // 거짓 「넘어갔다」를 낸다. 모르면 `None`이 정답이고, `None`은 안전한 쪽
            // (「일했다고 인정하지 않는다」 = 상한이 살아 있는 쪽)으로 떨어진다.
            self.episode_fires = h.fires;
        }
        self.broadcast_plan();
    }

    /// 사용자가 "이어서"를 눌렀다 — `ready`인 대기표를 **지금** 소진한다(스펙 ⑤ 후반부).
    ///
    /// 자동 발사가 꺼진 채팅(화면 밖)이 초록 점을 띄우고 기다리는 상태의 유일한 출구다.
    /// 누른 것 자체가 "이 채팅은 이제 사용자가 보고 있다"는 뜻이므로 자동도 함께 켠다.
    pub fn resume_now(&mut self) -> Verdict {
        let ready = self.hold.as_ref().is_some_and(|h| h.ready);
        self.auto_resume = true;
        if !ready {
            return Verdict::Rejected("hold_not_ready");
        }
        // 사용자가 눌렀다 = 이 재개는 엔진의 헛발질 계산에 들어가지 않는다(★R5).
        self.consume_hold(false);
        self.drain_if_possible();
        Verdict::Accepted
    }

    /// 대기표 소진 — §7.3의 "`ready`가 되면 큐 head에 `origin:'limit_resume'` 항목을 삽입".
    ///
    /// **예외 하나(★R4 — 재개 단일 소유)**: 표가 걸린 **뒤에** 접수된 사용자 메시지가
    /// 큐에 있으면 나팔을 넣지 않는다. 그 메시지가 이 채팅의 재개이기 때문이다.
    ///
    /// 왜 필요한가: 얼려 둔 렌더러에는 아직 `useLimitResume`이 살아 있고, 그것이 Rust보다
    /// 먼저 발화하면 재개 프롬프트가 `chat:run`으로 들어와 **게이트에 주차**된다. 그 뒤
    /// Rust가 표를 소진하며 나팔을 앞에 끼우면 *한 번의 해제에 두 턴*이 나간다
    /// (M-UX R2.9가 적어 둔 재현 축: 한도 사망 → 재시작 → 리셋 도달 → 전송 1회인가 2회인가).
    /// 표가 걸리기 **전에** 쌓인 예약(재생 #4의 "2"·"3")은 재개가 아니므로 규약 그대로다.
    ///
    /// `auto` = 엔진 스스로 발사한 것인가(`check_hold`)인가, 사용자가 누른 것인가
    /// (`resume_now`)인가. 헛 재개 상한([`crate::limit::MAX_AUTO_ATTEMPTS`])이 세는 것은
    /// **앞쪽뿐**이다 — 사용자가 누른 이어가기는 몇 번이든 사용자의 판단이다(★R5).
    fn consume_hold(&mut self, auto: bool) {
        let now = self.sync_now();
        let armed_at = self.hold.as_ref().map(|h| h.armed_at).unwrap_or(0);
        // 표가 걸린 뒤에 들어온 사용자 메시지 = 렌더러(또는 사용자)가 이미 건 재개.
        let already = self
            .queue
            .iter()
            .any(|m| m.origin == QueueOrigin::User && m.created_at > armed_at);
        // ★R28d WCAP — 걷기 **전에** 이 표의 리셋 시각을 챙긴다. 다음 한도 문구의 시각과
        // 견줄 상대가 바로 이 값이고(구분자 ①), 표는 이 줄 다음에 사라진다.
        let fired_at = self.hold.as_ref().and_then(|h| h.resets_at);
        self.hold = None;
        // 사람 손이 닿은 재개(누름 · 대기 중 걸어 둔 메시지)는 카운터를 되돌린다.
        //
        // ★R28e WFIRE — 되돌아가는 카운터가 **셋**이 됐다. `auto_resume_streak`(연속 헛발질)와
        // `auto_resume_at`(직전 벽)은 R28d 그대로이고, 여기 더해지는 둘은
        //  * [`Self::auto_resume_fired_at`] — 이 발사의 **시각**. 다음 한도 착지에서
        //    `now - 이 값`이 곧 그 재개 턴의 수명이고, 구분자 ②가 그 값으로 「일했다」를 가린다.
        //  * [`Self::episode_fires`] — 이 에피소드의 **총 발사 수**. 연속 계수와 달리
        //    구분자 ①·②가 못 지운다. 여기서만 오르고, 사람 손이 닿는 이 else 가지와
        //    「한도 없이 착지」에서만 0으로 돌아간다.
        self.auto_resume_streak = if auto && !already {
            self.auto_resume_at = fired_at;
            self.auto_resume_fired_at = Some(now);
            self.episode_fires = self.episode_fires.saturating_add(1);
            self.auto_resume_streak.saturating_add(1)
        } else {
            self.auto_resume_at = None;
            self.auto_resume_fired_at = None;
            self.episode_fires = 0;
            0
        };
        if already {
            // 침묵 금지(D7) — 나팔을 삼킨 이유를 한 줄 남긴다.
            self.emit(Event::Notice(
                "사용 한도가 풀렸어요 — 대기 중에 걸어 둔 메시지로 이어서 보냅니다.".into(),
            ));
            self.broadcast_plan();
            return;
        }
        self.push_resume_nudge(now);
        self.broadcast_plan();
    }

    /// 큐 head에 **재개 나팔**을 끼운다. 정체성은 **지금 값**(§7.3), `onDrift=use_current`.
    ///
    /// [`Self::consume_hold`]와 [`Self::try_auto_switch`]가 같은 자리를 쓴다 — 표가 풀려
    /// 이어가든 계정을 갈아 이어가든, *죽은 턴을 다시 밀어 주는 문장*은 하나여야 한다.
    fn push_resume_nudge(&mut self, now: Millis) {
        let mut m = self.make_queue_item(
            QueueInput::text("이어서 진행해 주세요"),
            QueueOrigin::LimitResume,
            now,
        );
        m.on_drift = OnDrift::UseCurrent;
        self.queue.push_front(m);
    }

    /// ★M11 — **한도 소진 → 노는 계정으로 갈아타고 이어가기.** 갈아탔으면 `true`.
    ///
    /// 부르는 자리는 둘이고 둘 다 대기표가 살아 있을 때다:
    ///  ① [`Self::arm_hold`] — 표를 건 그 순간(셸의 한도 스냅샷이 이미 따뜻하면 즉시 전환)
    ///  ② [`Self::check_hold`] — 매 tick(첫 시도가 "조회 아직"이었으면 몇 초 뒤 성사된다)
    ///
    /// **거절하는 자리들**(전부 의도된 문이다):
    ///
    /// | 조건 | 왜 |
    /// |---|---|
    /// | 훅 미배선 · 설정 꺼짐 | 기본값. 기능이 없던 판과 같아야 한다 |
    /// | `!auto_resume` | 스펙 ⑤ — 화면 밖 채팅이 **조용히 다른 계정을 태우기 시작**하면 안 된다. 사용자가 [이어가기]를 누르면 `auto_resume`가 켜지고 그다음 소진에서 전환이 열린다 |
    /// | `auto_paused` | 이미 자동을 멈춘 표다. 자동 전환도 자동이다 |
    /// | `billing != Subscription` | API 키 실행에는 갈아탈 계정이 없다 |
    /// | 정규화 실패 | 그 계정이 로그아웃됐다 → 다음 후보는 다음 tick에(이번 계정은 `tried`에 넣는다) |
    ///
    /// 성사되면 **대기표를 먼저 걷고** 리비전을 올린다. 순서가 계약이다:
    /// [`Self::apply_identity`]의 §7.3 무효화("계정을 바꿔서 대기표를 취소했어요")가
    /// 먼저 돌면 사용자는 *취소했다*는 문장만 읽고 왜 계정이 바뀌었는지는 못 읽는다.
    fn try_auto_switch(&mut self) -> bool {
        let Some(hold) = self.hold.as_ref() else { return false };
        if hold.auto_paused || !self.auto_resume {
            return false;
        }
        let armed_at = hold.armed_at;
        let old_axis = self.identity.billing().clone();
        let BillingAxis::Subscription { account: cur, .. } = old_axis.clone() else {
            return false;
        };
        // ★M11 R2(C2) — **낡은 1등은 다시 묻는다.**
        //
        // 훅이 보는 `busy`는 스폰이 끝나야 참이 된다(허브가 `state != Idle`로 만든다).
        // 그래서 워커 스냅샷이 도착한 그 tick에 대기하던 채팅들이 동시에 열리면 전부
        // 같은 1등을 받는다 — 규칙 ①("노는 계정만")이 뚫리는 지점이다(R1 크리틱 C2).
        // 방금 다른 채팅이 집은 계정이면([`SwitchLedger`]) 그 답을 **거절하고** 그
        // 계정을 뺀 채 한 번 더 묻는다. 훅이 예약을 아는 경우(셸의 `Switcher`)에는
        // 첫 답이 이미 옳아서 이 루프가 한 바퀴로 끝난다.
        let now_epoch = self.clock.now_epoch_ms();
        let mut refused: BTreeSet<String> = BTreeSet::new();
        let pick = loop {
            let tried: BTreeSet<String> = if refused.is_empty() {
                BTreeSet::new()
            } else {
                self.switch_tried.union(&refused).cloned().collect()
            };
            let req = crate::limit::SwitchRequest {
                chat_id: self.chat_id.as_str(),
                current: self.identity.billing(),
                model: self.identity.model(),
                tried: if refused.is_empty() { &self.switch_tried } else { &tried },
                now_epoch_ms: now_epoch,
            };
            let Some(p) = self.switcher.pick(&req) else { break None };
            if !self.switch_ledger.taken_by_other(self.chat_id.as_str(), &p.account, now_epoch)
                || refused.len() >= SWITCH_REASK_MAX
            {
                break Some(p);
            }
            refused.insert(p.account);
        };
        let Some(pick) = pick else { return false };
        if self.switch_ledger.taken_by_other(self.chat_id.as_str(), &pick.account, now_epoch) {
            return false; // 재질문 상한까지 갔는데도 남이 집은 계정뿐이다 — 다음 tick에.
        }
        if pick.account == cur {
            return false;
        }
        // 이번 에피소드에서 다시 고르지 않도록 **먼저** 적는다 — 정규화가 실패해도
        // 같은 계정을 매 tick 되묻지 않는다(로그아웃된 계정으로 무한 재시도 금지).
        self.switch_tried.insert(cur.clone());
        self.switch_tried.insert(pick.account.clone());
        let mut patch = RawIdentityPatch::default();
        patch.billing.account = Some(pick.account.clone());
        let next = match RunIdentity::normalize(self.identity_raw.patched(&patch), &self.defaults) {
            Ok(v) => v,
            Err(e) => {
                self.emit(Event::IdentityRejected { reason: e.reason() });
                return false;
            }
        };
        if next == self.identity {
            return false;
        }
        let changed = self.identity.diff(&next);
        // ★M11 R2(C2) — **집었다고 장부에 적는다.** 같은 tick의 다음 채팅은 이 줄을 보고
        // 다른 계정을 고른다(정규화가 실패한 판에는 적지 않는다 — 안 집은 것이다).
        self.switch_ledger.take(self.chat_id.as_str(), &pick.account, now_epoch);
        // ★M11 R3(F8) — 셸의 예약 장부도 **여기서만** 선다. `pick` 안에서 걸면 엔진이
        // 거절한 후보까지 예약돼 남의 후보를 30초 가린다(확인 크리틱 F8).
        self.switcher.confirm(self.chat_id.as_str(), &pick.account);
        // ① 표를 걷는다(§7.3의 일반 무효화 문장이 이 전환을 가리지 않게).
        self.hold = None;
        // 계정이 바뀌었으니 옛 계정에서 센 헛발질은 이 계정과 무관하다.
        // ★R28e WFIRE — 에피소드 예산도 같은 이유로 새로 연다(다른 계정 = 다른 한도 창).
        self.auto_resume_streak = 0;
        self.episode_fires = 0;
        self.auto_resume_fired_at = None;
        let revert_to = self.revision;
        // ② 리비전 — origin이 곧 "내가 고른 값이 아니다"라는 표식이다.
        self.apply_identity(next, RevisionOrigin::AutoAccountSwitch, changed, vec![], vec![]);
        // ③ 배너(사용자가 읽는 사실) + 되돌리기 지점.
        self.emit(Event::AccountSwitched {
            from: cur,
            to: pick.account.clone(),
            soonest_reset: pick.soonest_reset,
            revert_to,
        });
        // ④ **큐에 주차된 항목을 새 계정으로 옮긴다.**
        //
        // 큐 항목은 접수 시점의 정체성 스냅샷을 들고 다니고(`make_queue_item`),
        // 드레인은 그 스냅샷으로 스폰한다(`reuse_decision(&m.identity, …)`). 사용자가
        // 직접 계정을 바꿨을 때는 그게 옳다 — 그 메시지에 그 계정을 고른 건 사용자다.
        // 그러나 여기서 우리가 떠나는 계정은 **방금 한도로 막힌 계정**이다. 주차된 말을
        // 그 스냅샷 그대로 보내면 스폰 한 번을 버리고 같은 한도 에러를 다시 받는다
        // (실측: 재생 ⑦이 `spawns=["a_x","a_x"]` — 갈아탄 뒤에도 옛 계정으로 나갔다).
        //
        // 옮기는 대상은 **소진된 축에 못 박힌 항목만**이다. 사용자가 어떤 예약에 다른
        // 계정을 손수 골라 뒀다면 그건 이 한도와 무관한 선택이라 건드리지 않는다.
        // (`OnDrift`는 선언만 있고 읽는 자리가 없다 — 그 배선은 이 라운드의 몫이 아니라
        //  여기서 축 비교로 같은 뜻을 낸다.)
        let rev = self.revision;
        let defaults = &self.defaults;
        let mut repinned = 0usize;
        for m in self.queue.iter_mut() {
            if *m.identity.billing() != old_axis {
                continue;
            }
            if let Ok(v) = RunIdentity::normalize(m.identity.to_raw().patched(&patch), defaults) {
                m.identity = v;
                m.identity_rev = rev;
                repinned += 1;
            }
        }
        if repinned > 0 {
            self.broadcast_queue();
        }
        // ⑤ 죽은 턴을 다시 민다 — 표 소진과 **같은 규약**(대기 중 사용자 메시지가
        //    있으면 그것이 이 채팅의 재개다. 나팔을 더하면 한 번에 두 턴이 나간다).
        //
        // ★R1 크리틱(자기 재생) — 여기서 **드레인하지 않는다.** `consume_hold`가 나팔만
        // 넣고 발사는 호출자(tick)에게 맡기는 것과 **같은 규약**이고, 그 규약을 깨면 이
        // 함수가 `arm_hold` → `on_result` 한복판에서 불릴 때 재앙이 된다:
        //
        //  · 그 순간 죽은 턴의 CLI는 **아직 살아 있다**(EOF도 land_turn도 아직이다).
        //    거기서 드레인하면 나팔이 **옛 계정 프로세스로** 나가 같은 한도 에러를 또
        //    받는다 → 표가 다시 서고(사용자 눈엔 "갈아탔는데 또 대기"), 그 두 번째
        //    `on_result`가 또 전환을 시도한다.
        //  · 되돌아온 `on_result`는 이어서 "한도 없이 착지했다"(hold == None)로 읽고
        //    **에피소드 집합을 지운다** → A→B→C→A 무한 루프.
        //
        // 실측: R1 부분 작업 그대로는 재생 ①이 `hold=Some`으로 떨어지고 ④가 영영 안 끝났다.
        // 지금은 나팔을 큐 head에 두고 나가면 `land_turn` → `after_ledger_change`(또는
        // 다음 tick의 `check_hold`)가 **정체성 드리프트를 본 뒤** 새 계정으로 스폰한다.
        let now = self.sync_now();
        let already = self
            .queue
            .iter()
            .any(|m| m.origin == QueueOrigin::User && m.created_at > armed_at);
        if !already {
            self.push_resume_nudge(now);
        }
        self.broadcast_plan();
        true
    }

    /// 드레인 게이트 — 대기표가 **열려 있는가**.
    ///
    /// `ready`만으로는 부족하다: 스펙 ⑤의 "나머지 = 눌러야 발사"는 *ready인데도 안 나가는*
    /// 상태를 요구한다. 자동이 켜져 있으면(기본) 옛 조건과 글자 그대로 같다.
    /// (★R5 `auto_paused`도 게이트를 닫는다 — 자동 상한을 넘긴 표는 `ready`지만
    /// 사용자가 누르기 전까지 이 채팅의 예약분도 혼자 나가면 안 된다.)
    fn hold_gate_open(&self) -> bool {
        self.hold
            .as_ref()
            .is_none_or(|h| h.ready && self.auto_resume && !h.auto_paused)
    }
    pub fn pending_preview(&self) -> Option<&RunIdentity> {
        self.pending.as_ref().map(|s| &s.preview)
    }
    pub fn ledger(&self) -> std::cell::Ref<'_, LiveLedger> {
        self.ledger.borrow()
    }
    pub fn events(&self) -> Vec<Event> {
        self.sink.borrow().events.clone()
    }
    /// **가져가면서 비운다** — 출하 셸(src-tauri 엔진 글루)의 브로드캐스트 펌프 전용.
    ///
    /// [`Self::events`]는 재생 하네스가 *순서 전체*를 단언하려고 누적본을 통째로 복사한다.
    /// 상주 앱에서 그 모양을 쓰면 (a) 사인크가 턴마다 무한히 커지고 (b) 펌프가 매 틱
    /// 전체를 다시 훑어 이미 보낸 이벤트를 또 보낸다. 하네스는 이 메서드를 부르지
    /// 않으므로 97개 테스트의 단언 대상(누적본)은 한 글자도 바뀌지 않는다.
    pub fn drain_events(&self) -> Vec<Event> {
        std::mem::take(&mut self.sink.borrow_mut().events)
    }
    pub fn driver(&mut self) -> &mut D {
        &mut self.driver
    }
    pub fn driver_ref(&self) -> &D {
        &self.driver
    }
    pub fn session_id(&self) -> Option<String> {
        self.thread.session_id.clone()
    }
    pub fn stream_id(&self) -> Option<StreamId> {
        self.stream.as_ref().map(|s| s.id)
    }
    /// 게이팅을 실제로 낼 수 있는 항목(§5.5) — 없으면 어떤 조작도 안 막힌다.
    pub fn gating_blockers(&self) -> Vec<LiveId> {
        self.ledger.borrow().gating_blockers()
    }
    pub fn hung_probes(&self) -> u32 {
        self.stream.as_ref().map(|s| s.hung_probes).unwrap_or(0)
    }
    /// 이 `request_id`가 지금 원장에 어떤 **종류의 카드**로 떠 있나.
    ///
    /// 왜 공개하나: 얼려 둔 2.6.2 렌더러에는 다이얼로그 채널이 없어 폴백 확인을
    /// **질문 카드**로 그린다(`engine.ts:930-1019` 파리티). 그러면 답이 질문 채널로
    /// 돌아오는데 `t5_respond`는 종류가 어긋난 응답을 거부한다(N16) — 옳은 가드다.
    /// 어긋남을 푸는 것은 **원장을 볼 수 있는 셸**의 몫이고, 그 조회창이 이 함수다.
    pub fn ask_kind_of(&self, request_id: &str) -> Option<AskKind> {
        self.ledger
            .borrow()
            .items()
            .iter()
            .find_map(|i| i.ask.as_ref().filter(|a| a.request_id == request_id).map(|a| a.ask_kind))
    }

    fn emit(&self, e: Event) {
        self.sink.borrow_mut().emit(e);
    }

    /// 표의 행 하나를 **실제로 밟았다**고 기록한다. 커버리지 게이트가 이 집합을 읽는다.
    fn fire(&self, id: &'static str) {
        debug_assert!(
            crate::state::all_transition_ids().contains(&id),
            "표에 없는 id를 밟았다고 기록: {id}"
        );
        self.fired.borrow_mut().insert(id);
    }
    pub fn fired(&self) -> std::collections::BTreeSet<String> {
        self.fired.borrow().iter().map(|s| s.to_string()).collect()
    }
    pub fn sent_user_texts(&self) -> Vec<String> {
        self.sent_user_texts.clone()
    }

    /// 다음 [`Cmd::Respond`]가 **이 본문 그대로** 나가게 세워 둔다(그 `request_id` 1회).
    ///
    /// 왜 필요한가: `Cmd::Respond`의 어휘는 `accept: bool`이다 — 재생 하네스가 60전이를
    /// 밟는 데는 그것으로 충분하지만, **실 CLI 왕복에는 값이 더 필요한 카드가 있다.**
    /// `AskUserQuestion`은 `canUseTool`이 allow/deny만 받으므로 2.6.2가 답을
    /// **`deny` + `message`(선택 요약)** 로 되먹인다(`protocol-claude-cli.md` §4.4a
    /// "AskUserQuestion 트릭"). `allow_always`도 `updatedPermissions` 배열이 실려야 산다.
    ///
    /// 그 2.6.2 파리티 본문을 **셸(엔진 글루)이 만들고**, 상태기계는 매칭·정착·`AskClosed`
    /// 규약을 그대로 돈다. 세워 두지 않으면 기본 본문이라 기존 동작은 한 글자도 안 바뀐다.
    pub fn stage_respond_payload(&mut self, request_id: &str, payload: Value) {
        self.staged_payloads.insert(request_id.to_string(), payload);
    }
    /// 프롬프트 송신의 유일 경로 — 불변식 7(이중 전송 없음)이 이 목록을 읽는다.
    fn send_user(&mut self, text: &str) {
        self.sent_user_texts.push(text.to_string());
        self.driver.send(user_message(text));
    }

    /// F20 — stderr 줄. **리스 증거가 아니다**(죽어 가는 프로세스도 stderr를 뱉는다).
    pub fn on_stderr(&mut self, line: &str) {
        self.fire("F20");
        self.emit(Event::Notice(format!("[stderr] {line}")));
    }

    fn sync_now(&self) -> Millis {
        let n = self.clock.now_ms();
        self.now_cell.set(n);
        n
    }

    // ── 상태 대입 ────────────────────────────────────────────────────────────

    /// **표에 있는 전이 id로만** 상태를 바꾼다. `source`는 불변식 15가 읽는다.
    fn set_state(&mut self, source: &'static str, to: StateTag, why: Option<ResidentWhy>) {
        self.set_state_inner(source, to, why, true)
    }
    /// `Resident{Linger(0)}`처럼 **브로드캐스트하지 않는** 중간 상태용(§3.4-a 3번).
    fn set_state_silent(&mut self, source: &'static str, to: StateTag, why: Option<ResidentWhy>) {
        self.set_state_inner(source, to, why, false)
    }
    fn set_state_inner(
        &mut self,
        source: &'static str,
        to: StateTag,
        why: Option<ResidentWhy>,
        broadcast: bool,
    ) {
        debug_assert!(
            source == "watchdog_loop"
                || source == "§3.4"
                || crate::state::transition(source).is_some(),
            "표에 없는 전이 id로 상태를 바꿨다: {source}"
        );
        let from = self.state();
        if let Some(s) = &mut self.stream {
            s.state = to;
            s.why = why;
        }
        if crate::state::transition(source).is_some() {
            self.fire(source);
        }
        self.emit(Event::StateAssign { source, from, to });
        if broadcast {
            self.emit_run_state(vec![]);
        }
    }

    fn emit_run_state(&self, settled: Vec<SettledWire>) {
        let l = self.ledger.borrow();
        self.emit(Event::RunState {
            state: self.state(),
            resident_why: self.resident_why(),
            run_id: self
                .stream
                .as_ref()
                .and_then(|s| s.turn.as_ref().map(|t| t.run_id)),
            live: l.snapshot(),
            ledger_confidence: l.confidence,
            settled,
        });
    }

    // ── 명령 ─────────────────────────────────────────────────────────────────

    pub fn dispatch(&mut self, cmd: Cmd) -> Verdict {
        self.sync_now();
        let name = cmd.name();
        let state = self.state();
        let cell = command_cell(name, state).unwrap_or(TCell::Reject("ended"));
        let verdict = match cell {
            TCell::Reject(r) => Verdict::Rejected(r),
            TCell::Queue => Verdict::Queued,
            TCell::Defer(at) => Verdict::Deferred(at),
            TCell::Confirm(_) => Verdict::NeedsConfirm,
            TCell::Accept(_) => Verdict::Accepted,
        };
        let verdict = self.execute(cmd, verdict);
        self.emit(Event::Verdict {
            cmd: name,
            verdict: verdict.clone(),
        });
        verdict
    }

    fn execute(&mut self, cmd: Cmd, verdict: Verdict) -> Verdict {
        let now = self.now();
        match cmd {
            Cmd::Send { text } => self.accept_user_message(QueueInput::text(text), verdict, now),
            Cmd::Enqueue(input) => self.accept_user_message(input, verdict, now),
            Cmd::Interrupt => {
                if verdict != Verdict::Accepted {
                    return verdict;
                }
                match self.state() {
                    StateTag::Starting => self.t34_cancel_spawn(),
                    StateTag::Resident => self.t35_resident_interrupt(),
                    _ => self.t13_interrupt(),
                }
                Verdict::Accepted
            }
            Cmd::StopAll | Cmd::Clear => {
                if verdict != Verdict::Accepted {
                    return verdict;
                }
                if self.state() == StateTag::Starting {
                    self.t34_cancel_spawn();
                } else if self.stream.is_some() {
                    self.t23_stop_all();
                }
                Verdict::Accepted
            }
            Cmd::QueueRestore { token } => {
                let ok = self
                    .queue_undo
                    .as_ref()
                    .is_some_and(|u| u.token == token && u.valid_until >= now);
                if !ok {
                    return Verdict::Rejected("undo_expired");
                }
                let u = self.queue_undo.take().unwrap();
                for (i, m) in u.items.into_iter().enumerate() {
                    self.queue.insert(i, m);
                }
                self.hold = u.hold;
                self.broadcast_queue();
                // ★ 복원이 곧 전송이면 위험하다 — 드레인을 자동으로 돌리지 않는다(§7.4).
                Verdict::Accepted
            }
            Cmd::Respond {
                kind,
                request_id,
                accept,
            } => {
                if verdict != Verdict::Accepted {
                    return verdict;
                }
                self.t5_respond(kind, &request_id, accept)
            }
            Cmd::BgStop { id } => {
                if verdict != Verdict::Accepted {
                    return verdict;
                }
                self.send_control("stop_task", json!({ "task_id": id }));
                if let Some(it) = self.ledger.borrow_mut().get_mut(&id) {
                    it.liveness = Liveness::Settling;
                }
                Verdict::Accepted
            }
            Cmd::BgBackground => verdict,
            Cmd::IdentitySet { patch, policy, op } => self.set_identity(patch, policy, op),
            Cmd::IdentityRevert { to } => self.revert_identity(to),
            Cmd::HoldCancel => {
                // "자동 이어서 끄기" = **포기**다. 게이트만 내리고 드레인을 깨우지 않는다.
                //
                // 설계 근거(★R2 — 크리틱 R1 C3): 드레인을 여는 유일한 hold 경로는 §7.3의
                // **소진**(`ready` → 재개 항목 삽입 → 일반 드레인)이다. 취소는 그 반대쪽이다.
                // §7.4는 같은 이유로 `queue.restore`가 드레인을 안 돌게 못박았고
                // ("되돌리기가 곧 전송이면 위험하다"), §7.3은 interrupt/stop_all이 대기표를
                // 함께 끄는 이유를 *"안 그러면 중지했는데 몇 시간 뒤 혼자 이어서 보낸다"*로 적었다.
                // R1 구현은 `Esc → 되돌리기 → 자동 이어서 끄기`의 **마지막 클릭이 큐 head를
                // 그 자리에서 전송**했다 — L1이 죽이려던 바로 그 형태다.
                self.hold = None;
                self.broadcast_plan();
                Verdict::Accepted
            }
            Cmd::ForkBtw => {
                // 다음 send는 **새 스레드**다 → T18(ThreadChanged). 정체성은 그대로.
                self.thread.want_fresh = true;
                Verdict::Accepted
            }
            Cmd::ForceSettle { id } => {
                let item = self.ledger.borrow_mut().remove(&id, false);
                if let Some(it) = item {
                    self.settle_emit(&it, SettleReason::ForcedByUser);
                    self.emit_run_state(vec![]);
                    Verdict::Accepted
                } else {
                    Verdict::Rejected("no_item")
                }
            }
            Cmd::Compact => {
                if verdict == Verdict::Accepted {
                    let m = self.make_queue_item(QueueInput::text("/compact"), QueueOrigin::User, now);
                    self.queue.push_back(m);
                    self.drain_if_possible();
                }
                verdict
            }
            // ★R4 — R3까지 이 명령은 **접수만 하고 아무것도 안 했다**(M-UX R2.1 #2).
            //   드레인은 **어느 op도 돌리지 않는다**: 큐를 만졌다는 이유로 head가
            //   그 자리에서 나가면 §7.4가 죽인 그 사고(되돌리기가 곧 전송)와 같은 모양이다.
            Cmd::QueueMutate(op) => {
                if verdict != Verdict::Accepted {
                    return verdict;
                }
                match op {
                    QueueOp::Remove { id } => {
                        let before = self.queue.len();
                        self.queue.retain(|m| m.id != id);
                        if self.queue.len() == before {
                            return Verdict::Rejected("no_item");
                        }
                        self.broadcast_plan();
                        Verdict::Accepted
                    }
                    QueueOp::Reorder { ids } => {
                        if ids.is_empty() {
                            return Verdict::Noop;
                        }
                        let mut rest: Vec<QueuedMessage> = self.queue.drain(..).collect();
                        let mut out: Vec<QueuedMessage> = Vec::with_capacity(rest.len());
                        for want in &ids {
                            if let Some(i) = rest.iter().position(|m| &m.id == want) {
                                out.push(rest.remove(i));
                            }
                        }
                        // 목록에 없던 항목은 **원래 순서대로 뒤에** 남는다 — 낡은 목록으로
                        // 재정렬해도 예약이 증발하지 않는다.
                        out.extend(rest);
                        self.queue = out.into();
                        self.broadcast_plan();
                        Verdict::Accepted
                    }
                    QueueOp::Clear => {
                        if self.queue.is_empty() && self.hold.is_none() {
                            return Verdict::Noop;
                        }
                        self.clear_queue_with_undo();
                        Verdict::Accepted
                    }
                    QueueOp::Noop => Verdict::Noop,
                }
            }
            _ => verdict,
        }
    }

    /// `send`·`enqueue`의 공통 착지 — 큐에 세우고, 판정이 `Accepted`면 드레인까지 본다.
    fn accept_user_message(&mut self, input: QueueInput, verdict: Verdict, now: Millis) -> Verdict {
        // ★M10 — 넣은 자가 사람이 아닐 수 있다(대화 연결: 다른 채팅의 세션).
        let origin = input.origin.unwrap_or(QueueOrigin::User);
        // ★M10 R3 — **하한을 못 걸면 안 넣는다**(fail-closed · 크리틱 D4).
        // `make_queue_item`의 폴백은 "정체성 오류로 예약이 사라지는 것보다 보던 대로가
        // 낫다"인데, 봉투 턴의 picker는 *보던 대로*가 아니라 **권한 하한**이다.
        if input.require_picker
            && matches!(verdict, Verdict::Accepted | Verdict::Queued)
            && input
                .picker
                .as_ref()
                .filter(|p| !p.is_empty())
                .is_some_and(|p| RunIdentity::normalize(self.identity_raw.patched(p), &self.defaults).is_err())
        {
            return Verdict::Rejected("picker_unavailable");
        }
        // 사용자가 직접 말을 걸었다 = 엔진의 헛 재개 연쇄는 여기서 끊긴다(★R5).
        // **사람만** 끊는다: AI가 보낸 줄이 사람의 개입을 사칭하면 헛 재개 상한이
        // 세션 사이의 왕복만으로 무한정 초기화된다.
        if matches!(verdict, Verdict::Accepted | Verdict::Queued) && origin == QueueOrigin::User {
            // ★R28e WFIRE — 에피소드 예산도 여기서 새로 열린다. 사람이 말을 건 것은
            // 「이 채팅을 지금 보고 있다」는 뜻이라, 예산을 다 쓴 채팅도 그 한마디로 살아난다
            // (막다른 방 금지 — `resume_now`가 계수를 0으로 되돌리는 것과 같은 규약).
            self.auto_resume_streak = 0;
            self.episode_fires = 0;
            self.auto_resume_fired_at = None;
        }
        match verdict {
            Verdict::Accepted => {
                let m = self.make_queue_item(input, origin, now);
                self.queue.push_back(m);
                self.broadcast_queue();
                self.drain_if_possible();
                Verdict::Accepted
            }
            Verdict::Queued => {
                let m = self.make_queue_item(input, origin, now);
                self.queue.push_back(m);
                self.broadcast_queue();
                Verdict::Queued
            }
            v => v,
        }
    }

    fn make_queue_item(&mut self, input: QueueInput, origin: QueueOrigin, now: Millis) -> QueuedMessage {
        let id = format!("q{}", self.next_qid);
        self.next_qid += 1;
        let QueueInput {
            text, images, picker, ..
        } = input;
        // 예약 시점의 picker → **이 항목만의** 정체성 스냅샷. 채팅의 정체성은 안 건드린다
        // (그건 `Cmd::IdentitySet`의 몫이다 — 저자를 늘리지 않는다).
        // 정규화가 실패하면(폴더 없음·계정 없음) 조용히 지금 값으로 떨어진다: 예약 하나가
        // 정체성 오류로 사라지는 것보다 "보던 대로"에서 한 축 어긋나는 편이 낫다.
        let (identity, identity_rev) = match picker.filter(|p| !p.is_empty()) {
            Some(p) => match RunIdentity::normalize(self.identity_raw.patched(&p), &self.defaults) {
                Ok(id) => (id, self.revision),
                Err(_) => (self.identity.clone(), self.revision),
            },
            None => (self.identity.clone(), self.revision),
        };
        QueuedMessage {
            id,
            text,
            attachments: images,
            identity,
            identity_rev,
            thread: if self.thread.want_fresh {
                ThreadIntent::Fresh
            } else {
                ThreadIntent::Continue
            },
            on_drift: OnDrift::KeepSnapshot,
            created_at: now,
            origin,
        }
    }

    fn broadcast_queue(&self) {
        self.emit(Event::Queue {
            items: self.queue_texts(),
            plan: vec![],
        });
    }

    fn broadcast_plan(&self) {
        let plan = drain_plan(
            &self.queue.make_contiguous_ref(),
            self.stream.as_ref().map(|s| &s.spawn_identity),
        );
        self.emit(Event::Queue {
            items: self.queue_texts(),
            plan,
        });
    }

    // ── 정체성 명령 (§4) ─────────────────────────────────────────────────────

    fn set_identity(
        &mut self,
        patch: RawIdentityPatch,
        policy: ApplyPolicy,
        op: PendingOp,
    ) -> Verdict {
        if op == PendingOp::Cancel {
            return match self.pending.take() {
                Some(_) => Verdict::Applied,
                None => Verdict::Rejected("no_pending"),
            };
        }
        // 엔진 전환은 모델을 같이 줘야 한다 — 모델 id 공간이 갈린다(§4.2).
        if patch.engine.kind.is_some() && patch.engine.model.is_none() {
            self.emit(Event::IdentityRejected {
                reason: IdentityRejectReason::EngineSwitchNeedsModel,
            });
            return Verdict::Rejected("engine_switch_needs_model");
        }
        let preview = match RunIdentity::normalize(
            self.identity_raw.patched(&patch),
            &self.defaults,
        ) {
            Ok(v) => v,
            Err(e) => {
                self.emit(Event::IdentityRejected { reason: e.reason() });
                return Verdict::Rejected(match e.reason() {
                    IdentityRejectReason::CwdMissing => "cwd_missing",
                    IdentityRejectReason::AccountUnavailable => "account_unavailable",
                    IdentityRejectReason::ApiKeyMissing => "api_key_missing",
                    _ => "rejected",
                });
            }
        };
        if preview == self.identity && self.pending.is_none() {
            return Verdict::Noop;
        }
        let costly = !self.ledger.borrow().is_empty();
        match (self.state(), policy) {
            (StateTag::Idle | StateTag::Resident, ApplyPolicy::AskIfCostly) if costly => {
                Verdict::NeedsConfirm
            }
            (StateTag::Idle | StateTag::Resident, _) => {
                self.fire("T31");
                let changed = self.identity.diff(&preview);
                self.apply_identity(preview, RevisionOrigin::User, changed, vec![], vec![]);
                Verdict::Applied
            }
            _ => {
                // 턴 중 → **리프 단위 패치를 누적**한다. 착지에서 재정규화 + 폴백 우선 규칙.
                let seq = self.frame_seq;
                let base = self.revision;
                let staged = self.pending.get_or_insert_with(|| Staged {
                    patch: RawIdentityPatch::default(),
                    touched_at: Default::default(),
                    base_revision: base,
                    preview: preview.clone(),
                    policy,
                });
                match op {
                    PendingOp::Replace => {
                        staged.patch = patch.clone();
                        staged.touched_at.clear();
                    }
                    _ => staged.patch.merge_leaves_from(patch.clone()),
                }
                for leaf in RawIdentity::touched(&patch) {
                    staged.touched_at.insert(leaf, seq);
                }
                staged.preview = preview;
                let (h, b) = (staged.preview.hash(), staged.base_revision);
                self.emit(Event::IdentityPending {
                    preview_hash: h,
                    at: "turn_end",
                    base_revision: b,
                });
                Verdict::Deferred("turn_end")
            }
        }
    }

    fn revert_identity(&mut self, to: u32) -> Verdict {
        let Some((_, target)) = self.revisions.iter().find(|(n, _)| *n == to).cloned() else {
            return Verdict::Rejected("no_revision");
        };
        let changed = self.identity.diff(&target);
        self.apply_identity(target, RevisionOrigin::Revert(to), changed, vec![], vec![]);
        Verdict::Applied
    }

    fn apply_identity(
        &mut self,
        next: RunIdentity,
        origin: RevisionOrigin,
        changed: Vec<IdentityField>,
        drifted: Vec<IdentityField>,
        kept: Vec<IdentityField>,
    ) {
        self.identity_raw = next.to_raw();
        self.identity = next.clone();
        self.revision += 1;
        self.revisions.push((self.revision, next.clone()));
        self.emit(Event::Identity {
            origin,
            revision: self.revision,
            hash: next.hash(),
            changed,
            drifted,
            kept_by_fallback: kept,
        });
        // 계정이 바뀌면 대기표는 **즉시** 무효다(§7.3). 2.6.2는 옛 계정 기준으로 재검증하고
        // 옛 계정으로 재전송했다 — 그게 "계정 바꿨는데 왜 저 계정으로 나가지"의 정체다.
        let stale = self
            .hold
            .as_ref()
            .is_some_and(|h| h.account != *self.identity.billing());
        if stale {
            self.hold = None;
            self.emit(Event::Notice("계정을 바꿔서 대기표를 취소했어요".into()));
            self.broadcast_plan();
            self.drain_if_possible();
        }
    }

    /// §3.4 착지 — **접수 시점 값이 아니라 지금 값에** 패치를 얹는다(폴백이 살아남는 자리).
    fn land_pending(&mut self) {
        let Some(staged) = self.pending.take() else {
            return;
        };
        let (patch, kept) = resolve_fallback_conflicts(&staged, &self.fallback_arms);
        let landed =
            match RunIdentity::normalize(self.identity_raw.patched(&patch), &self.defaults) {
                Ok(v) => v,
                Err(e) => {
                    self.emit(Event::IdentityRejected { reason: e.reason() });
                    return;
                }
            };
        let drifted = staged.preview.diff(&landed);
        let changed = self.identity.diff(&landed);
        if changed.is_empty() && drifted.is_empty() && kept.is_empty() {
            return;
        }
        self.apply_identity(landed, RevisionOrigin::DeferredApply, changed, drifted, kept);
    }

    // ── 폴백 합류 (§6.2) ─────────────────────────────────────────────────────

    /// F10 — 메인 경로의 `assistant.message.model` 관측(§6.2 경로 C/C'/C'').
    ///
    /// **함정(실와이어가 드러낸 것)**: 프레임의 model은 *해석된* id
    /// (`claude-haiku-4-5-20251001`)이고 정체성의 model은 *picker 별칭*(`haiku`)이다.
    /// 그대로 비교하면 **모든 턴이 폴백으로 보인다** → 재사용 판정이 매번 Respawn이 된다.
    /// 그래서 ① 별칭 공간으로 접고 ② **첫 관측은 기준선**으로 삼는다(2.6.2 `curModelDisplay`가
    /// 세션 시작값으로 초기화되고 *변화*에서만 `model-fallback`을 내는 것과 같은 규약).
    fn observe_model(&mut self, wire_model: &str) {
        let alias = model_alias(wire_model);
        match self.observed_model.clone() {
            None => self.observed_model = Some(alias),
            Some(prev) if prev == alias => {}
            Some(_) => self.fallback_signal(&alias, FallbackVia::ModelDelta),
        }
    }

    fn fallback_signal(&mut self, to_model: &str, via: FallbackVia) {
        let has_arm = self.fallback_arms.iter().any(|a| a.to_model == to_model);
        match via {
            // A/B'/C'' — arm이 없으면 리비전 생성. 있으면 소비/미러만.
            FallbackVia::RefusalFrame | FallbackVia::Dialog | FallbackVia::ModelDelta
                if !has_arm =>
            {
                let from = self.identity.model().to_string();
                let revert_to = self.revision;
                let mut raw = self.identity_raw.clone();
                raw.engine.model = to_model.to_string();
                if let Ok(next) = RunIdentity::normalize(raw, &self.defaults) {
                    self.fire("T29");
                    let changed = self.identity.diff(&next);
                    self.apply_identity(
                        next,
                        RevisionOrigin::EngineFallback(via),
                        changed,
                        vec![],
                        vec![],
                    );
                    self.fallback_arms.push(FallbackArm {
                        to_model: to_model.to_string(),
                        via,
                        at_seq: self.frame_seq,
                    });
                    self.observed_model = Some(to_model.to_string());
                    self.emit(Event::FallbackBanner {
                        from_model: from,
                        to_model: to_model.to_string(),
                        via,
                        revert_to,
                    });
                }
            }
            // B(arm 있음) = 소비만 · C'(arm 있음) = 미러만. 어느 쪽도 리비전·배너 없음.
            _ => {
                self.observed_model = Some(to_model.to_string());
            }
        }
    }

    // ── 스트림 수명 ──────────────────────────────────────────────────────────

    fn reuse_decision(&self, want: &RunIdentity, thread: ThreadIntent) -> ReuseDecision {
        let Some(s) = &self.stream else {
            return ReuseDecision::ColdStart;
        };
        if s.state != StateTag::Resident {
            return ReuseDecision::ColdStart;
        }
        let mut idiff = s.spawn_identity.diff(want);
        // ★M10 R6 — 대화 연결 안내는 정체성 밖(비영속)이지만 **스폰 축**이다: 보드를
        // 껐는데 도는 CLI가 계속 그 통로를 알고 있으면 「꺼짐이 진짜 꺼짐」이 아니다.
        // 새 어휘를 만들지 않고 `SystemPrompt`로 보고한다 — 실제로 그 프레임의 `append`가
        // 바뀌는 것이고, 사용자가 읽는 재스폰 문장도 그 낱말이 맞다.
        if s.spawn_guide.as_deref() != self.talk_guide.as_deref()
            && !idiff.contains(&IdentityField::SystemPrompt)
        {
            idiff.push(IdentityField::SystemPrompt);
        }
        let thread_changed = thread == ThreadIntent::Fresh
            || self
                .thread
                .cwd_at_bind
                .as_deref()
                .is_some_and(|c| c != want.cwd().as_str());
        if idiff.is_empty() && !thread_changed {
            ReuseDecision::Reuse
        } else {
            ReuseDecision::Respawn {
                identity: idiff,
                thread: thread_changed,
            }
        }
    }

    fn next_run_id(&mut self) -> RunId {
        let r = RunId(self.next_run);
        self.next_run += 1;
        r
    }

    /// T1 — 콜드 스타트. `hold`가 있으면 여기 오지 않는다(드레인 게이트가 막는다).
    fn t1_spawn(&mut self, m: QueuedMessage) {
        let now = self.sync_now();
        let sid = StreamId(self.next_stream);
        self.next_stream += 1;
        // ★R2 — **세션 신원은 엔진 축에 매인다.** 엔진이 갈렸으면 스레드도 갈린다:
        //   Claude의 `session_id`를 codex에 주면 `thread/resume{threadId}`가 모르는
        //   스레드를 가리켜 RPC 오류로 거절당하고, 반대로 codex의 `threadId`를 주면
        //   `claude.exe --resume=<그것>`이 뜬다. 둘 다 **전환 후 첫 턴이 죽는다.**
        //   T17(전환 재스폰)이 이 자리를 지나가지만, 스트림이 이미 닫힌 채 picker만
        //   바뀐 경우(콜드 스타트)에는 T17이 안 도므로 판정을 여기 한 곳에 둔다.
        let engine_now = m.identity.engine_kind();
        if self.thread.engine.is_some_and(|k| k != engine_now) {
            self.thread.session_id = None;
            self.thread.forked_from = None;
            self.thread.want_fresh = false;
            self.thread.engine = None;
        }
        // /btw 포크 = `--resume=<id> --fork-session`(resume이 있을 때만 fork가 유효하다).
        let fork = m.thread == ThreadIntent::Fresh
            && self.thread.want_fresh
            && self.thread.session_id.is_some();
        let resume = if m.thread == ThreadIntent::Fresh && !fork {
            None
        } else {
            self.thread.session_id.clone()
        };
        // 계정 격리 폴더는 **큐 항목의 정체성 스냅샷**에서 나온다 —
        // 지금 채팅의 계정이 아니라 "예약할 때 보던 계정"으로 나가야 한다(P5의 약속).
        let config_dir = match m.identity.billing() {
            crate::identity::BillingAxis::Subscription { account, .. } => {
                Some(self.account_dir(account))
            }
            crate::identity::BillingAxis::ApiKey { .. } => None,
        };
        let spec = build_spawn_spec(
            self.cli_path.clone(),
            &m.identity,
            resume.as_deref(),
            fork,
            config_dir,
            self.defaults.api_key.as_deref(),
        );
        // ★R4(§R3.8-M) — **IO 오류를 삼키지 않는다.** R3까지 이 줄은 `let _ =` 였고,
        //   `claude.exe`가 없거나 실행 권한이 없으면 아무 말 없이 `Starting`으로 들어가
        //   **T3(20초)** 까지 침묵했다. 오류는 그 자리에서 이미 확정된 사실이다.
        let spawn_err = self.driver.spawn(&spec).err();
        self.spawns += 1;
        self.emit(Event::Spawn {
            stream: sid,
            identity_hash: m.identity.hash(),
            resume: resume.clone(),
        });
        let (guard, cause, _) = StreamGuard::new(
            sid,
            self.ledger.clone(),
            self.sink.clone(),
            self.now_cell.clone(),
        );
        let run_id = self.next_run_id();
        self.stream = Some(Stream {
            id: sid,
            spawn_identity: m.identity.clone(),
            spawn_guide: self.talk_guide.clone(),
            state: StateTag::Starting,
            why: None,
            close_policy: self.close_policy,
            last_frame_at: now,
            started_at: now,
            session_id: None,
            init_ack: false,
            init_frame: false,
            turn: Some(Turn::new(run_id, self.frame_seq, false)),
            guard: Some(guard),
            cause,
            linger_deadline: None,
            interrupt_deadline: None,
            interrupt_marker: false,
            stop_deadline: None,
            stopping: vec![],
            closing: false,
            last_probe_at: None,
            probe_inflight_until: None,
            probe_expect: vec![],
            hung_probes: 0,
            probe_id: 0,
        });
        if m.thread == ThreadIntent::Fresh {
            self.thread.session_id = None;
            self.thread.want_fresh = false;
            self.thread.fork_consumed = true;
        }
        // 관측 모델 기준선은 **스트림마다** 새로 잡는다(§6.2 미러는 프로세스 종속이다).
        self.observed_model = None;
        self.set_state("T1", StateTag::Starting, None);
        if let Some(e) = spawn_err {
            // 셀은 T3와 **같다**(`Starting → Terminating{SpawnFailed}`) — 계기만 다르다:
            // 20초 무응답이 아니라 커널이 방금 거절했다. `Event::Exit{SpawnFailed}`가
            // 셸의 `stream_closed`로 이어져 오류 말풍선 · 스피너 정착 · 컴포저 해제까지
            // 간다(그 배선은 R3 §R3.1의 `error` 항목).
            self.emit(Event::Notice(format!(
                "엔진을 시작하지 못했어요 — {} ({e})",
                self.cli_path.display()
            )));
            self.set_state("T3", StateTag::Terminating, None);
            self.close_and_finish(CloseCause::SpawnFailed);
            return;
        }
        // ★M10 R6 — **여기가 R5가 「빠진 배선」이라고 적은 그 자리다.** R5까지 이 인자는
        // 무조건 `None`이었고, 그래서 대화 연결을 켜도 CLI에 들어가는 프롬프트 바이트가
        // 0 변했다(채팅별 추가 지시도 같은 이유로 Claude에서는 사문이었다).
        let append = Self::append_prompt(&m.identity, self.talk_guide.as_deref());
        self.driver
            .send(initialize_request("init-1", append.as_deref()));
        let prompt = compose_prompt(&m);
        self.note_echo(run_id, &m);
        self.send_user(&prompt);
    }

    /// T16 — 같은 stdin에 주입. **새 `run_id`**(§3.5 발급 4지점 중 하나).
    fn t16_inject(&mut self, m: QueuedMessage) {
        let run_id = self.next_run_id();
        let seq = self.frame_seq;
        if let Some(s) = &mut self.stream {
            s.turn = Some(Turn::new(run_id, seq, false));
            s.linger_deadline = None;
            // 사용자가 **직접** 다음 턴을 시작했다 → 재주입 금지 표식 해제(T12 가드).
            s.interrupt_marker = false;
        }
        let prompt = compose_prompt(&m);
        self.note_echo(run_id, &m);
        self.send_user(&prompt);
        self.set_state("T16", StateTag::Streaming, None);
    }

    /// 사용자 에코 한 건을 적어 둔다 — 셸이 [`Self::take_echo`]로 가져간다.
    fn note_echo(&mut self, run_id: RunId, m: &QueuedMessage) {
        self.last_echo = Some(SentEcho {
            run_id,
            text: m.text.clone(),
            images: m.attachments.clone(),
            origin: m.origin,
        });
    }

    /// T17/T18 — 재사용 불가. **사유는 배타가 아니다**(둘 다 실릴 수 있다 — §3.3 `—` 규약 행).
    fn t17_respawn(&mut self, m: QueuedMessage, identity: Vec<IdentityField>, thread: bool) {
        let reason = if identity.is_empty() {
            SettleReason::ThreadChanged
        } else {
            SettleReason::IdentityChanged {
                diff: identity.clone(),
            }
        };
        let ids = self
            .stream
            .as_ref()
            .map(|s| self.ledger.borrow().owned_by(s.id))
            .unwrap_or_default();
        let mut kills: Vec<(LiveKind, usize)> = vec![];
        for id in ids {
            let item = self.ledger.borrow_mut().remove(&id, false);
            if let Some(it) = item {
                match kills.iter_mut().find(|(k, _)| *k == it.kind) {
                    Some((_, c)) => *c += 1,
                    None => kills.push((it.kind, 1)),
                }
                self.settle_emit(&it, reason.clone());
            }
        }
        let text = respawn_text(&identity, thread, &kills);
        self.emit(Event::RespawnNotice {
            identity: identity.clone(),
            thread_changed: thread,
            kills,
            text,
        });
        let cause = if identity.is_empty() {
            CloseCause::ThreadChanged
        } else {
            CloseCause::IdentityChanged
        };
        self.set_state(
            if identity.is_empty() { "T18" } else { "T17" },
            StateTag::Terminating,
            None,
        );
        self.suspend_drain = true;
        self.close_and_finish(cause);
        self.suspend_drain = false;
        // ★R2 — 엔진이 갈렸으면 **세션 신원도 갈린다**(`ThreadLink::engine` 참고).
        //   `thread.engine`이 비어 있는 경우(셸이 저장된 sessionId를 꽂아 준 직후)에도
        //   확실히 끊기도록, 진단이 이미 "engine.kind가 바뀌었다"고 말한 이 자리에서
        //   한 번 더 자른다. 정체성 진단이 곧 근거다.
        if identity.contains(&IdentityField::EngineKind) {
            self.thread.session_id = None;
            self.thread.forked_from = None;
            self.thread.want_fresh = false;
            self.thread.engine = None;
        }
        self.t1_spawn(m);
    }

    fn close_and_finish(&mut self, cause: CloseCause) {
        let to_close = match &mut self.stream {
            Some(s) if !s.closing => {
                s.closing = true;
                Some(s.id)
            }
            _ => None,
        };
        if let Some(sid) = to_close {
            self.driver.close_input();
            self.emit(Event::CloseInput { stream: sid });
        }
        self.driver.kill();
        self.finish_termination(cause);
    }

    /// T25 → T26. `StreamGuard::drop`이 남은 원장을 **무조건** 정착시킨다.
    fn finish_termination(&mut self, cause: CloseCause) {
        let Some(mut s) = self.stream.take() else {
            return;
        };
        // 종결 status 1회 보장(§5.3 emit_terminal_status_once).
        // 사용자가 끊은 경로(T23/T34/T15)는 **오류가 아니다** — F11과 같은 이유로
        // 어휘를 가른다(그 값이 `status.json`에 남는다).
        let terminal = match cause {
            CloseCause::Cancelled | CloseCause::HardCancel => TerminalStatus::Aborted,
            _ => TerminalStatus::Error,
        };
        if let Some(t) = &mut s.turn {
            if !t.sent_terminal_status {
                t.sent_terminal_status = true;
                self.emit(Event::Status {
                    run_id: t.run_id,
                    status: terminal,
                });
            }
        }
        s.cause.set(cause);
        let from = s.state;
        self.fire("T25");
        self.emit(Event::StateAssign {
            source: "T25",
            from,
            to: StateTag::Ended,
        });
        drop(s); // ← 여기서 StreamGuard::drop: 원장 정착 + Exit 방출
        self.exits += 1;
        self.fire("T26");
        self.emit(Event::StateAssign {
            source: "T26",
            from: StateTag::Ended,
            to: StateTag::Idle,
        });
        self.ledger.borrow_mut().confidence = Confidence::Observed;
        self.emit_run_state(vec![]);
        // T26 — 예약분이 남아 있으면 여기서 적용된다.
        self.land_pending();
        self.drain_if_possible();
    }

    fn settle_emit(&self, it: &LiveItem, reason: SettleReason) {
        self.emit(Event::Settled {
            id: it.id.clone(),
            kind: it.kind,
            reason,
            at_ms: self.now_cell.get(),
        });
    }

    // ── 드레인 (§7.2) ────────────────────────────────────────────────────────

    pub fn drain_if_possible(&mut self) {
        if self.suspend_drain {
            return;
        }
        loop {
            let st = self.state();
            if !(st == StateTag::Idle || st == StateTag::Resident) {
                return;
            }
            if !self.hold_gate_open() {
                return;
            }
            let Some(m) = self.queue.front().cloned() else {
                return;
            };
            match self.reuse_decision(&m.identity, m.thread) {
                ReuseDecision::Reuse => {
                    self.queue.pop_front();
                    self.broadcast_queue();
                    self.t16_inject(m);
                    return;
                }
                ReuseDecision::Respawn { identity, thread } => {
                    self.queue.pop_front();
                    self.broadcast_queue();
                    self.t17_respawn(m, identity, thread);
                    return;
                }
                ReuseDecision::ColdStart => {
                    if st == StateTag::Idle && self.stream.is_none() && self.queue.len() >= 1 {
                        // T27 — 큐 head의 **정체성 스냅샷**으로 콜드 스타트
                        self.fire("T27");
                    }
                    self.queue.pop_front();
                    self.broadcast_queue();
                    if self.stream.is_some() {
                        // Resident인데 ColdStart가 나올 수는 없다(방어).
                        self.close_and_finish(CloseCause::AllClear);
                    }
                    self.t1_spawn(m);
                    return;
                }
            }
        }
    }

    // ── 턴 종료 판정 (§3.4) ──────────────────────────────────────────────────

    fn land_turn(&mut self) {
        let now = self.sync_now();
        // ★ 중단으로 끝난 턴은 `Done`이 아니다(크리틱 배선 R1 F11). 이 값은
        //   `status.json`에 영속되고 `load_boot`는 `done`을 안 내리므로, `Done`으로
        //   적으면 사용자가 끊은 턴이 재시작 뒤에도 "완료"로 남는다.
        let aborted = self.stream.as_ref().is_some_and(|s| s.interrupt_marker);
        if let Some(s) = &mut self.stream {
            if let Some(t) = &mut s.turn {
                t.turn_ended = true;
                if !t.sent_terminal_status {
                    t.sent_terminal_status = true;
                    let status = if aborted {
                        TerminalStatus::Aborted
                    } else {
                        TerminalStatus::Done
                    };
                    let run_id = t.run_id;
                    self.sink.borrow_mut().emit(Event::Status { run_id, status });
                }
            }
        }
        // 턴이 먼저 끝나면 짝을 못 찾은 compact는 `after=null`로 방출한다(§3.3 T28).
        let pending = self
            .stream
            .as_mut()
            .and_then(|s| s.turn.as_mut().and_then(|t| t.compact_pending.take()));
        if let Some(trigger) = pending {
            self.emit(Event::Compact {
                trigger,
                after_tokens: None,
            });
        }
        self.land_pending();
        self.fallback_arms.clear();

        // 턴 종료 시 백그라운드 셸에 5s 유예를 건다(§3.4-b).
        {
            let mut l = self.ledger.borrow_mut();
            for it in l.items().iter().map(|i| i.id.clone()).collect::<Vec<_>>() {
                if let Some(item) = l.get_mut(&it) {
                    if item.kind == LiveKind::BgShell {
                        item.grace_until = Some(now + SHELL_TURN_GRACE);
                    }
                }
            }
        }

        let drainable = !self.queue.is_empty() && self.hold_gate_open();
        let empty = self.ledger.borrow().is_empty();
        match (empty, drainable) {
            (false, _) => {
                self.set_state("§3.4", StateTag::Resident, Some(ResidentWhy::LiveItems));
                self.drain_if_possible();
            }
            (true, true) => {
                // ★ close 결정을 **보류**한다(§3.4-a). 여기서 닫으면 T16 주입이 불가능해져
                //   §7.2의 배칭이 출하 기본값에서 거짓말이 된다.
                self.set_state_silent("§3.4", StateTag::Resident, Some(ResidentWhy::Linger));
                if let Some(s) = &mut self.stream {
                    s.linger_deadline = Some(now); // Linger(0) = 즉시 만료하는 안전망
                }
                self.drain_if_possible();
            }
            (true, false) => match self.close_policy {
                StreamClosePolicy::OnIdle => {
                    self.set_state("§3.4", StateTag::Terminating, None);
                    self.close_and_finish(CloseCause::AllClear);
                }
                StreamClosePolicy::Linger(ms) => {
                    if let Some(s) = &mut self.stream {
                        s.linger_deadline = Some(now + ms);
                    }
                    self.set_state("T20b", StateTag::Resident, Some(ResidentWhy::Linger));
                }
                StreamClosePolicy::KeepOpen => {
                    self.set_state("§3.4", StateTag::Resident, Some(ResidentWhy::KeepOpen));
                }
            },
        }
    }

    // ── 중단 계열 ────────────────────────────────────────────────────────────

    fn clear_queue_with_undo(&mut self) {
        if self.queue.is_empty() && self.hold.is_none() {
            return;
        }
        let now = self.now();
        let items: Vec<QueuedMessage> = self.queue.drain(..).collect();
        let count = items.len();
        let hold = self.hold.take();
        let token = format!("undo-{}", self.next_qid);
        self.next_qid += 1;
        let hold_cancelled = hold.is_some();
        self.queue_undo = Some(QueueUndo {
            items,
            hold,
            token: token.clone(),
            valid_until: now + 5 * MIN,
        });
        self.emit(Event::Queue {
            items: vec![],
            plan: vec![],
        });
        self.emit(Event::QueueCleared {
            count,
            hold_cancelled,
            undo_token: token,
        });
    }

    /// T13 — 카드 전부 해제 → 큐 비움 → `control_request{interrupt}`.
    fn t13_interrupt(&mut self) {
        let now = self.now();
        self.release_all_cards("interrupt");
        self.clear_queue_with_undo();
        if let Some(s) = &mut self.stream {
            s.interrupt_marker = true; // T12 재주입 금지(§3.3 T12 가드 · T14 note)
            s.interrupt_deadline = Some(now + INTERRUPT_TIMEOUT);
        }
        self.send_control("interrupt", json!({}));
        self.set_state("T13", StateTag::Interrupting, None);
    }

    /// T34 — `Starting` 중 취소. 첫 프레임 전이라 정착할 항목이 없다.
    fn t34_cancel_spawn(&mut self) {
        self.clear_queue_with_undo();
        self.set_state("T34", StateTag::Terminating, None);
        self.close_and_finish(CloseCause::Cancelled);
    }

    /// T23 — 하드 취소.
    fn t23_stop_all(&mut self) {
        self.release_all_cards("stop_all");
        self.clear_queue_with_undo();
        let turn_running = self
            .stream
            .as_ref()
            .and_then(|s| s.turn.as_ref())
            .is_some_and(|t| !t.turn_ended);
        if turn_running {
            self.send_control("interrupt", json!({}));
        }
        let ids = self
            .stream
            .as_ref()
            .map(|s| self.ledger.borrow().owned_by(s.id))
            .unwrap_or_default();
        for id in ids {
            let it = self.ledger.borrow_mut().remove(&id, false);
            if let Some(it) = it {
                self.settle_emit(&it, SettleReason::Cancelled);
            }
        }
        self.set_state("T23", StateTag::Terminating, None);
        self.close_and_finish(CloseCause::Cancelled);
    }

    /// T35 — `Resident`의 interrupt. **턴이 없으므로 `interrupt`를 보내지 않는다.**
    fn t35_resident_interrupt(&mut self) {
        self.fire("T35");
        let now = self.now();
        let targets: Vec<LiveId> = self
            .ledger
            .borrow()
            .items()
            .iter()
            .filter(|i| i.kind.is_stoppable())
            .map(|i| i.id.clone())
            .collect();
        for id in &targets {
            self.send_control("stop_task", json!({ "task_id": id }));
            if let Some(it) = self.ledger.borrow_mut().get_mut(id) {
                it.liveness = Liveness::Settling;
            }
        }
        self.clear_queue_with_undo();
        if let Some(s) = &mut self.stream {
            s.interrupt_marker = true; // 상주 중단도 "중단 요청"이다(T12 가드)
            s.stopping = targets.clone();
            s.stop_deadline = Some(now + STOP_TASK_GRACE);
        }
        self.emit(Event::Notice(format!(
            "작업 {}개를 중지했어요 — [되돌리기 불가]",
            targets.len()
        )));
        self.emit_run_state(vec![]);
    }

    fn release_all_cards(&mut self, how: &'static str) {
        let cards: Vec<(LiveId, AskInfo)> = self
            .ledger
            .borrow()
            .items()
            .iter()
            .filter_map(|i| i.ask.clone().map(|a| (i.id.clone(), a)))
            .collect();
        for (id, ask) in cards {
            // 닫힌 stdin에 쓰지 않는다(§5.7 규약 4) — 스트림이 살아 있을 때만 전송.
            if self.stream.as_ref().is_some_and(|s| !s.closing) {
                self.driver.send(control_response(
                    &ask.request_id,
                    ask.tool_use_id.as_deref(),
                    json!({ "behavior": "deny", "message": "사용자가 중지했습니다" }),
                ));
            }
            let it = self.ledger.borrow_mut().remove(&id, false);
            if let Some(it) = it {
                self.settle_emit(&it, SettleReason::Stopped { by_user: true });
            }
            self.emit(Event::AskClosed {
                request_id: ask.request_id,
                how,
            });
        }
    }

    fn t5_respond(&mut self, kind: AskKind, request_id: &str, accept: bool) -> Verdict {
        let found = self
            .ledger
            .borrow()
            .items()
            .iter()
            .find(|i| i.ask.as_ref().is_some_and(|a| a.request_id == request_id))
            .map(|i| (i.id.clone(), i.ask.clone().unwrap()));
        let Some((id, ask)) = found else {
            return Verdict::Rejected("no_card");
        };
        if ask.ask_kind != kind {
            // 종류가 어긋난 응답은 **조용히 먹지 않는다**(N16·X9).
            return Verdict::Rejected("wrong_card_kind");
        }
        // 셸이 미리 세워 둔 응답 본문이 있으면 그걸 쓴다(§4.4a — 아래 stage_respond_payload).
        // 없으면 재생 하네스가 쓰는 최소 본문. **매칭·정착·AskClosed는 어느 쪽이든 같다.**
        let payload = self.staged_payloads.remove(request_id).unwrap_or_else(|| match kind {
            AskKind::Permission => {
                if accept {
                    json!({ "behavior": "allow" })
                } else {
                    json!({ "behavior": "deny", "message": "거부" })
                }
            }
            AskKind::Question => json!({ "behavior": "allow" }),
            AskKind::Dialog => json!({ "accepted": accept }),
        });
        // ★ toolUseID는 항상 동봉한다(고아 경로가 이걸 키로 쓴다).
        self.driver.send(control_response(
            &ask.request_id,
            ask.tool_use_id.as_deref(),
            payload,
        ));
        let it = self.ledger.borrow_mut().remove(&id, false);
        if let Some(it) = it {
            self.settle_emit(&it, SettleReason::Completed);
        }
        self.emit(Event::AskClosed {
            request_id: request_id.to_string(),
            how: "answered",
        });
        // 폴백 다이얼로그 **수락**은 정체성을 바꾼다(§6.2 경로 A).
        if kind == AskKind::Dialog && accept {
            if let Some(m) = ask.dialog_kind.as_deref() {
                if m == "refusal_fallback_prompt" {
                    // 실물은 `payload.fallbackModel`이 대상 모델이다(§4.4b). 재생
                    // 픽스처의 합성 규약(대상 모델을 `tool_use_id` 자리에)은 폴백으로
                    // 남긴다 — 실 `toolu_…`를 모델로 삼으면 정체성이 도구 id로 덮인다.
                    if let Some(to) = ask.fallback_model.clone().or_else(|| ask.tool_use_id.clone()) {
                        self.fallback_signal(&to, FallbackVia::Dialog);
                    }
                }
            }
        }
        self.set_state("T5", StateTag::Streaming, None);
        Verdict::Accepted
    }

    fn send_control(&mut self, subtype: &'static str, mut body: Value) {
        body["subtype"] = json!(subtype);
        let rid = format!("ctl-{}", self.frame_seq);
        let target = body
            .get("task_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        self.driver.send(control_request(&rid, body));
        self.emit(Event::ControlSent { subtype, target });
    }

    // ── 프레임 소화 ──────────────────────────────────────────────────────────

    pub fn on_frame(&mut self, v: &Value) {
        let now = self.sync_now();
        self.frame_seq += 1;
        if let Some(s) = &mut self.stream {
            s.last_frame_at = now;
        }
        let f = Frame::parse(v);
        match f {
            Frame::Unknown => {
                // F21 — 조용히 버린다. 죽지 않는다.
                self.fire("F21");
                self.emit(Event::UnknownFrameDropped);
            }
            Frame::SystemStatus { .. } => {}
            Frame::ControlResponse { request_id, .. } => {
                let is_probe = self
                    .stream
                    .as_ref()
                    .is_some_and(|s| request_id == format!("probe-{}", s.probe_id));
                if is_probe {
                    // 응답 자체는 신호가 아니다 — 뒤따르는 REPLACE가 판정한다(§5.4-b).
                } else if !request_id.starts_with("init") && !request_id.starts_with("ctl") {
                    self.emit(Event::UnmatchedControlResponse { request_id });
                } else if request_id.starts_with("init") {
                    if let Some(s) = &mut self.stream {
                        s.init_ack = true;
                    }
                    self.maybe_t2();
                }
            }
            Frame::SystemInit { session_id, model } => {
                // 세션 시작 모델 = **기준선**. 이걸 안 잡으면 첫 assistant 프레임이 폴백으로 오인된다.
                if let Some(m) = &model {
                    if self.observed_model.is_none() {
                        self.observed_model = Some(model_alias(m));
                    }
                }
                let same = self
                    .stream
                    .as_ref()
                    .and_then(|s| s.session_id.clone())
                    .is_some_and(|c| c == session_id);
                if let Some(s) = &mut self.stream {
                    s.init_frame = true;
                    if s.session_id.is_none() {
                        s.session_id = Some(session_id.clone());
                    }
                }
                if same {
                    // F1 — 같은 session_id의 재도착은 **아무것도 하지 않는다**
                    //      ("init 도착 = 새 세션" 판정 금지 · m3-poc §3 실측).
                    self.fire("F1");
                } else {
                    self.thread.session_id = Some(session_id);
                    // 이 세션을 발급한 엔진을 함께 적는다 — 스폰 시점의 정체성이 진실이다
                    // (지금 picker가 이미 다른 엔진으로 넘어가 있을 수 있다).
                    self.thread.engine = Some(
                        self.stream
                            .as_ref()
                            .map(|s| s.spawn_identity.engine_kind())
                            .unwrap_or_else(|| self.identity.engine_kind()),
                    );
                    self.thread.cwd_at_bind = Some(self.identity.cwd().as_str().to_string());
                }
                self.maybe_t2();
            }
            Frame::StreamEvent {
                sidechain,
                kind,
                delta_kind,
            } => {
                if sidechain {
                    self.fire("F5"); // 즉시 버림 — 완성 프레임만 쓴다
                    return;
                }
                match (kind.as_str(), delta_kind.as_deref()) {
                    (_, Some("text_delta")) => self.fire("F2"),
                    (_, Some("thinking_delta")) => self.fire("F3"),
                    ("content_block_start", _) => self.fire("F4"),
                    _ => {}
                }
                self.mark_activity();
                // ★R28d WCAP R2 — 좁은 문턱은 **글자가 남는 델타**만 센다(`Turn::saw_turn_output`).
                // `thinking_delta`는 렌더러에서 result가 오면 스토어가 걷어내고
                // (`store/session.ts`의 `THINKING_ID` 필터), `ping`·`message_start`·
                // `content_block_start`는 애초에 말풍선을 안 만든다. 빈 문자열 델타도 안 센다 —
                // 렌더러 `turnDidWork`의 `.trim()` 짝이다.
                // (`mark_activity`가 먼저다: 상주 정리턴 재개(T19b)가 거기서 턴을 새로 연다.)
                if delta_kind.as_deref() == Some("text_delta") && nonblank(&v["event"]["delta"]["text"]) {
                    self.mark_output();
                }
            }
            Frame::Assistant {
                sidechain,
                model,
                has_text,
                tool_uses,
                usage_tokens,
            } => {
                if sidechain {
                    self.fire("F8"); // 부모 카드 activity 한 줄 — 메인 경로 오염 금지
                    return;
                }
                if has_text {
                    self.fire("F6");
                }
                if !tool_uses.is_empty() {
                    self.fire("F7");
                }
                if let Some(after) = usage_tokens {
                    self.fire("F9");
                    // T28 짝맞춤 — 보류된 compact를 **다음 assistant의 usage**와 짝지어 방출한다.
                    let pending = self
                        .stream
                        .as_mut()
                        .and_then(|s| s.turn.as_mut().and_then(|t| t.compact_pending.take()));
                    if let Some(trigger) = pending {
                        self.emit(Event::Compact {
                            trigger,
                            after_tokens: Some(after),
                        });
                    }
                }
                if has_text || !tool_uses.is_empty() {
                    self.mark_activity();
                    // ★R28d WCAP R2 — 좁은 문턱. 도구 호출은 렌더러에서 **비어 있지 않은**
                    // 도구 그룹이 되므로 그대로 세고, 텍스트는 **내용이 있을 때만** 센다
                    // (`has_text`는 빈 `{"type":"text","text":""}` 블록에도 참이다 —
                    // codex 트랜스코더의 `agentMessage` 완료 프레임이 그 모양이 될 수 있다).
                    if !tool_uses.is_empty() || nonblank_assistant_text(v) {
                        self.mark_output();
                    }
                }
                for (id, name) in tool_uses {
                    self.ledger_insert(id, LiveKind::RunningTool, name);
                }
                if let Some(m) = model {
                    self.fire("F10");
                    self.observe_model(&m);
                }
            }
            Frame::User {
                sidechain,
                tool_results,
                task_notifications,
                ..
            } => {
                if sidechain {
                    self.fire("F8");
                    return;
                }
                if !tool_results.is_empty() {
                    self.fire("F11");
                }
                if !task_notifications.is_empty() {
                    self.fire("F12");
                }
                for id in tool_results {
                    let it = self.ledger.borrow_mut().remove(&id, false);
                    // ★R28d WCAP **R3** — 산출로 세기 전에 **어느 턴의 도구인지**를 본다
                    //   (WCAP 확인 크리틱 R2 §3.3). 원장 항목의 `born_run`이 그 답이다.
                    let born = it.as_ref().map(|i| i.born_run);
                    if let Some(it) = &it {
                        self.settle_emit(it, SettleReason::Completed);
                    }
                    self.mark_activity();
                    // ★R28d WCAP R2 → **R3에서 경계가 붙었다.**
                    //
                    // R2는 도구 결과를 **무조건** 산출로 셌다("렌더러에서 그 그룹은 이미
                    // 비어 있지 않다"). 그 문장은 도구가 **같은 턴 안에서** 열렸을 때만
                    // 참이다. 렌더러의 `tool-end`는 **있는 도구를 제자리에서 패치만** 하고
                    // 항목을 새로 붙이지 않으므로(`app/src/store/session.ts`의 `tool-end`),
                    // 앞 턴에서 열린 도구의 결과가 뒤늦게 오면 그 도구 그룹은 재개의 사용자
                    // 말풍선 **앞**에 남는다 — 뒤에서부터 훑는 `turnDidWork`는 사용자
                    // 말풍선에서 멎고 **거짓**을 낸다. 엔진만 참이면 그 자리에서 71 대 2가
                    // 되살아난다(크리틱 R2 §3.3 실측: 같은 12시간 대본에 엔진 71발 ·
                    // attempts 0 · 안 접힘 / 렌더러 2발 · 접힘).
                    //
                    // 도달 경로는 좁지만 실재한다: 도구가 미정착인 채 한도 에러가 오면
                    // 스트림은 `Resident`로 남고(재스폰 0 · 재개는 `drain_if_possible`이
                    // `Resident`에서도 돌아 **주입**으로 나간다), 그 프로세스가 뒤늦게 그
                    // 도구의 결과를 흘리면 정확히 그 대본이다.
                    //
                    // 그래서 **이 턴 안에서 열린** 도구의 결과만 센다. 짝 없는 결과(원장에
                    // 없는 `tool_use_id`)도 안 센다 — 렌더러에서 그 `tool-end`는 붙일 행을
                    // 못 찾고 스레드를 그대로 돌려준다(무동작).
                    //
                    // *같은 턴* 판에서 이 줄이 하는 일은 사실 없다(그 턴의 `Frame::Assistant`
                    // 가 `tool_use`를 보며 이미 산출을 적었다). 남겨 두는 이유는 렌더러의
                    // 「비어 있지 않은 도구 그룹」과 글자를 맞추기 위해서다.
                    let cur = self
                        .stream
                        .as_ref()
                        .and_then(|s| s.turn.as_ref())
                        .map(|t| t.run_id);
                    if born.is_some() && born == cur {
                        self.mark_output();
                    }
                }
                if !task_notifications.is_empty() {
                    // F12 + T19: 상주 중이면 CLI 자발 기상 턴이다(새 run_id).
                    if self.state() == StateTag::Resident {
                        let run_id = self.next_run_id();
                        let seq = self.frame_seq;
                        if let Some(s) = &mut self.stream {
                            s.turn = Some(Turn::new(run_id, seq, true));
                        }
                        self.set_state("T19", StateTag::Streaming, None);
                    }
                    for tid in &task_notifications {
                        if let Some(s) = &mut self.stream {
                            if let Some(t) = &mut s.turn {
                                t.delivered_notifs.push(tid.clone());
                            }
                        }
                        self.rearm(tid, EvidenceSource::NamedFrame);
                    }
                }
            }
            Frame::ControlRequest {
                request_id,
                subtype,
                tool_name,
                tool_use_id,
                dialog_kind,
                description,
                fallback_model,
            } => {
                match ask_kind_of(&subtype, tool_name.as_deref()) {
                    Some(kind) => {
                        // T4 — 승인/질문/다이얼로그 카드
                        if self
                            .ledger
                            .borrow()
                            .items()
                            .iter()
                            .any(|i| i.ask.as_ref().is_some_and(|a| a.request_id == request_id))
                        {
                            return; // 중복 렌더 방지(initialize 재배달 곁가지)
                        }
                        let sid = match &self.stream {
                            Some(s) => s.id,
                            None => return,
                        };
                        let run = self
                            .stream
                            .as_ref()
                            .and_then(|s| s.turn.as_ref().map(|t| t.run_id))
                            .unwrap_or(RunId(0));
                        let mut item = LiveItem::new(
                            request_id.clone(),
                            LiveKind::AskCard,
                            sid,
                            run,
                            description.unwrap_or_else(|| tool_name.clone().unwrap_or_default()),
                            now,
                        );
                        item.ask = Some(AskInfo {
                            ask_kind: kind,
                            request_id: request_id.clone(),
                            tool_use_id: tool_use_id.clone(),
                            dialog_kind: dialog_kind.clone(),
                            fallback_model: fallback_model.clone(),
                        });
                        self.ledger.borrow_mut().insert(item);
                        self.emit(Event::AskOpened {
                            request_id,
                            ask_kind: kind,
                        });
                        self.set_state("T4", StateTag::AwaitingUser, None);
                    }
                    None => {
                        // F22 — hook_callback·mcp_message·미지 subtype: 자동 응답, UI 카드 0건.
                        self.fire("F22");
                        self.driver
                            .send(control_response(&request_id, None, json!({})));
                        self.emit(Event::ControlSent {
                            subtype: "auto_response",
                            target: Some(subtype),
                        });
                    }
                }
            }
            Frame::ControlCancel { request_id } => {
                // T6 — CLI가 카드를 회수했다.
                let found = self
                    .ledger
                    .borrow()
                    .items()
                    .iter()
                    .find(|i| i.ask.as_ref().is_some_and(|a| a.request_id == request_id))
                    .map(|i| i.id.clone());
                if let Some(id) = found {
                    let it = self.ledger.borrow_mut().remove(&id, false);
                    if let Some(it) = it {
                        self.settle_emit(&it, SettleReason::Stopped { by_user: false });
                    }
                    self.emit(Event::AskClosed {
                        request_id,
                        how: "withdrawn",
                    });
                    self.set_state("T6", StateTag::Streaming, None);
                }
            }
            Frame::CompactBoundary { trigger, .. } => {
                if let Some(s) = &mut self.stream {
                    if let Some(t) = &mut s.turn {
                        t.compact_pending = Some(trigger);
                    }
                }
                self.set_state("T28", StateTag::Streaming, None);
            }
            Frame::ModelRefusalFallback { fallback_model } => {
                self.fallback_signal(&fallback_model, FallbackVia::RefusalFrame);
            }
            Frame::Notification { text } => {
                self.fire("F18");
                self.emit(Event::Notice(text));
            }
            Frame::RateLimit { blocked, resets_at } => {
                if blocked {
                    // ★R5 — `resetsAt`은 **unix 초**다(`protocol-claude-cli.md:1059`의
                    // 실측값 `1787377200`). R4의 `s * 1000`은 그것을 **런타임 시계 ms**로
                    // 그대로 앉혔다 — 실기(단조 시계는 앱 기동 뒤 몇 초)에서는 대기표가
                    // 2026년에 앉아 **영원히 안 풀린다**. 1순위 근거가 미관측(O14)이라
                    // 아무도 밟지 않았을 뿐이다.
                    self.arm_hold(resets_at.map(|s| self.epoch_secs_to_runtime(s)));
                } else {
                    // F19 — allowed는 정보일 뿐이다. **hold 장전이 아니다.**
                    self.fire("F19");
                }
            }
            Frame::BackgroundTasksChanged { tasks } => self.f13_replace(tasks, now),
            Frame::TaskProgress {
                task_id,
                has_workflow,
                label,
            } => {
                if has_workflow {
                    self.fire("F15");
                    let l = label.unwrap_or_else(|| task_id.clone());
                    if !self.ledger.borrow().has(&task_id) {
                        self.ledger_insert(task_id.clone(), LiveKind::Workflow, l);
                    }
                } else {
                    // 보드로 **승격하지 않는다**(2.6.2 파리티). 그러나 원장에선 버리지 않는다.
                    self.fire("F16");
                }
                self.rearm(&task_id, EvidenceSource::Heartbeat);
            }
            Frame::TaskStarted {
                task_id,
                tool_use_id,
            } => {
                // F14 — `tool_use_id → task_id` 매핑. 이 매핑이 "서브에이전트 tool_result가
                // 백그라운드 시작 접수증인지"를 **문구 스니핑 없이** 판정하게 한다.
                self.fire("F14");
                if let Some(tu) = tool_use_id {
                    self.task_by_tool_use.insert(tu, task_id);
                }
            }
            Frame::TaskNotification {
                task_id,
                status,
                by_user,
                ..
            } => {
                self.fire("F17");
                let it = self.ledger.borrow_mut().remove(&task_id, false);
                if let Some(it) = it {
                    let reason = if by_user {
                        SettleReason::Stopped { by_user: true }
                    } else {
                        match status.as_str() {
                            "completed" => SettleReason::Completed,
                            "failed" => SettleReason::Failed {
                                message: String::new(),
                            },
                            _ => SettleReason::Stopped { by_user: false },
                        }
                    };
                    self.settle_emit(&it, reason);
                    self.emit_run_state(vec![]);
                }
                self.after_ledger_change(now);
            }
            Frame::Result {
                is_error,
                terminal_reason,
                text,
                error_text,
                ..
            } => self.on_result(is_error, terminal_reason, text, error_text),
        }
    }

    fn maybe_t2(&mut self) {
        let ready = self
            .stream
            .as_ref()
            .is_some_and(|s| s.init_ack && s.init_frame && s.state == StateTag::Starting);
        if ready {
            self.set_state("T2", StateTag::Streaming, None);
        }
    }

    /// T19b — 상주 중에 **선행 `user` 프레임 없이** 메인 경로 활동이 오면 정리 턴 재개다.
    /// 2.6.2는 같은 `run_id`로 `done→working→done`을 왕복했다(`engine.ts:1259-1268`) —
    /// 3.0은 **새 `run_id`**를 발급해 "run_id당 종결 status 1회" 불변식을 지킨다.
    fn maybe_resume_cleanup_turn(&mut self) {
        if self.state() != StateTag::Resident {
            return;
        }
        let run_id = self.next_run_id();
        let seq = self.frame_seq;
        if let Some(s) = &mut self.stream {
            s.turn = Some(Turn::new(run_id, seq, true));
        }
        self.set_state("T19b", StateTag::Streaming, None);
    }

    fn mark_activity(&mut self) {
        self.maybe_resume_cleanup_turn();
        let held = self
            .stream
            .as_ref()
            .and_then(|s| s.turn.as_ref())
            .is_some_and(|t| t.held_until.is_some());
        if let Some(s) = &mut self.stream {
            if let Some(t) = &mut s.turn {
                t.saw_turn_activity = true;
                t.held_until = None;
            }
        }
        if held || self.state() == StateTag::HeldResult {
            // T9 — 보류 취소, 미니턴 오판 복구
            self.set_state("T9", StateTag::Streaming, None);
        }
    }

    /// ★R28d WCAP R2 — 좁은 문턱의 흔적([`Turn::saw_turn_output`]). **늘
    /// [`Self::mark_activity`] 뒤에** 부른다: 상주 정리턴 재개(T19b)가 거기서 턴을
    /// 새로 열기 때문에, 먼저 부르면 방금 열린 턴이 아니라 없는 턴에 적게 된다.
    fn mark_output(&mut self) {
        if let Some(s) = &mut self.stream {
            if let Some(t) = &mut s.turn {
                t.saw_turn_output = true;
            }
        }
    }

    fn ledger_insert(&mut self, id: impl Into<LiveId>, kind: LiveKind, label: impl Into<String>) {
        let now = self.now_cell.get();
        let Some(sid) = self.stream.as_ref().map(|s| s.id) else {
            return;
        };
        let run = self
            .stream
            .as_ref()
            .and_then(|s| s.turn.as_ref().map(|t| t.run_id))
            .unwrap_or(RunId(0));
        let item = LiveItem::new(id, kind, sid, run, label, now);
        self.ledger.borrow_mut().insert(item);
    }

    fn rearm(&self, id: &str, src: EvidenceSource) {
        debug_assert!(
            src != EvidenceSource::ProcessAlive,
            "프로세스 생존은 리스를 재장전할 수 없다(§5.4-b ⓪)"
        );
        let now = self.now_cell.get();
        let mut l = self.ledger.borrow_mut();
        if let Some(it) = l.get_mut(id) {
            it.rearm(now);
            self.emit(Event::EvidenceRearm {
                id: id.to_string(),
                source: src,
            });
        }
    }

    /// F13 — REPLACE 재조정. **레벨이 진실, 에지는 장식.**
    fn f13_replace(&mut self, tasks: Vec<crate::frames::TaskEntry>, now: Millis) {
        self.fire("F13");
        // 능동 프로브 ⑥의 판정이 먼저다(T21b) — 그 다음 일반 재조정이 돈다.
        let probing = self
            .stream
            .as_ref()
            .and_then(|s| s.probe_inflight_until.map(|_| s.probe_expect.clone()));
        if let Some(expect) = probing {
            let present: Vec<String> = tasks.iter().map(|t| t.task_id.clone()).collect();
            for id in expect {
                if present.contains(&id) {
                    self.rearm(&id, EvidenceSource::ActiveProbe);
                } else {
                    let it = self.ledger.borrow_mut().remove(&id, false); // 관측이므로 추정 아님
                    if let Some(it) = it {
                        self.settle_emit(
                            &it,
                            SettleReason::Watchdog {
                                probe: ProbeSource::Active,
                            },
                        );
                        self.fire("T21b");
                    }
                }
            }
            if let Some(s) = &mut self.stream {
                s.probe_inflight_until = None;
                s.probe_expect.clear();
            }
        }

        let sid = match &self.stream {
            Some(s) => s.id,
            None => return,
        };
        let run = self
            .stream
            .as_ref()
            .and_then(|s| s.turn.as_ref().map(|t| t.run_id))
            .unwrap_or(RunId(0));
        let present: Vec<String> = tasks.iter().map(|t| t.task_id.clone()).collect();

        // 목록에 있는데 원장에 없으면 생성.
        for t in &tasks {
            if self.ledger.borrow().has(&t.task_id) {
                self.rearm(&t.task_id, EvidenceSource::NamedFrame);
            } else {
                let kind = classify_task_type(&t.task_type);
                let item = LiveItem::new(
                    t.task_id.clone(),
                    kind,
                    sid,
                    run,
                    t.description.clone(),
                    now,
                );
                self.ledger.borrow_mut().insert(item);
            }
        }
        // 원장에 있는데 목록에서 빠졌으면 → 5s 유예 안의 셸은 TurnEnded, 아니면 PendingSettle.
        let missing: Vec<LiveId> = self
            .ledger
            .borrow()
            .items()
            .iter()
            .filter(|i| {
                matches!(
                    i.kind,
                    LiveKind::Workflow | LiveKind::BgShell | LiveKind::BgAgent
                ) && !present.contains(&i.id)
            })
            .map(|i| i.id.clone())
            .collect();
        for id in missing {
            let stopping = self
                .stream
                .as_ref()
                .is_some_and(|s| s.stopping.contains(&id));
            let item = self.ledger.borrow_mut().remove(&id, false);
            let Some(it) = item else { continue };
            if stopping {
                // T35 ⓐ — 이탈이 **관측**됐다.
                self.settle_emit(&it, SettleReason::Stopped { by_user: true });
                if let Some(s) = &mut self.stream {
                    s.stopping.retain(|x| x != &id);
                }
                continue;
            }
            if it.kind == LiveKind::BgShell && it.grace_until.is_some_and(|g| now <= g) {
                self.settle_emit(&it, SettleReason::TurnEnded);
                continue;
            }
            // 정착 통지는 목록이 빈 **뒤에** 온다 — 여기서 바로 닫으면 보고 턴이 잘린다.
            let mut ps = LiveItem::new(
                it.id.clone(),
                LiveKind::PendingSettle,
                it.owner,
                it.born_run,
                it.label.clone(),
                now,
            );
            ps.gating = Gating::NeverBlocks;
            self.ledger.borrow_mut().insert(ps);
        }
        self.emit_run_state(vec![]);
        self.after_ledger_change(now);
    }

    /// 원장이 비었을 때의 회수 판정(T20/T20b/T33).
    fn after_ledger_change(&mut self, now: Millis) {
        if self.state() != StateTag::Resident {
            return;
        }
        let l = self.ledger.borrow();
        let empty = l.is_empty();
        let observed = l.confidence == Confidence::Observed;
        drop(l);
        if !empty || !observed {
            return;
        }
        if !self.queue.is_empty() && self.hold_gate_open() {
            self.drain_if_possible();
            return;
        }
        match self.close_policy {
            StreamClosePolicy::OnIdle => {
                self.set_state("T20", StateTag::Terminating, None);
                self.close_and_finish(CloseCause::AllClear);
            }
            StreamClosePolicy::Linger(ms) => {
                if let Some(s) = &mut self.stream {
                    s.linger_deadline = Some(now + ms);
                }
                self.set_state("T20b", StateTag::Resident, Some(ResidentWhy::Linger));
            }
            StreamClosePolicy::KeepOpen => {}
        }
    }

    fn on_result(
        &mut self,
        is_error: bool,
        terminal_reason: Option<String>,
        text: Option<String>,
        error_text: Option<String>,
    ) {
        let aborted = terminal_reason
            .as_deref()
            .is_some_and(|r| r.starts_with("aborted"));
        // T30 — 한도 문구 분류(2순위 근거. 1순위 프레임은 아직 미관측 · O14)
        //
        // ★R5 — 분류가 **리셋 시각까지** 돌려준다(2.6.2 `classifyLimitError`는 늘 그랬다.
        // 이식이 `hit` 반쪽만 옮겨서 꼬리 `…|1755150000`이 버려지고 있었다 — R14 F2).
        // 이 턴이 한도에 막혔나. 아래 에피소드 정리가 읽는 **직접 신호**다.
        let mut limited = false;
        if is_error {
            if let Some(t) = &error_text {
                let found = classify_limit_error(t);
                if found.hit {
                    limited = true;
                    let at = found.resets_at.map(|s| self.epoch_secs_to_runtime(s));
                    self.arm_hold(at);
                }
            }
        }
        // 한도 없이 착지한 턴 = 이 에피소드는 끝났다. 헛 재개 카운터를 되돌린다.
        // ★M11 — 거쳐 온 계정 목록도 같이 비운다. 같은 신호("이제 안 막힌다")이고,
        // 안 비우면 다음 소진 때 후보가 부당하게 줄어든다(하루 뒤의 한도인데도
        // 아침에 거쳐 간 계정이 영영 제외된다).
        //
        // ★R1 크리틱(자기 재생) — 게이트가 `hold.is_none()` **하나뿐이면 M11이 그걸
        // 뒤집는다**: 바로 위 `arm_hold`가 표를 걸고 그 안에서 전환이 성사되면 표는 다시
        // `None`이 되어 돌아온다. 그러면 이 줄이 "한도 없이 착지했다"로 오독하고 **방금
        // 거쳐 온 계정을 지운다** → 다음 소진에서 A로 되돌아가는 핑퐁(재생 ④는 그걸로
        // 영원히 안 끝났다). `limited`는 표의 생사와 무관한 사실이라 뒤집히지 않는다.
        // (전환이 없던 판에서는 `limited`가 참이면 표가 항상 서 있으므로 동작이 같다.)
        if !limited && self.hold.is_none() {
            // ★R28e WFIRE — **에피소드가 끝났다는 유일한 기계적 신호**가 이 줄이다.
            // 한도 없이 착지한 턴 하나면 예산이 통째로 되살아난다 — 그래서 "일하다가 가끔
            // 한도를 만나는" 정상 주행은 이 예산을 영영 못 만난다.
            self.auto_resume_streak = 0;
            self.episode_fires = 0;
            self.auto_resume_fired_at = None;
            self.switch_tried.clear();
        }
        if self.state() == StateTag::Interrupting || aborted {
            self.fire("T14");
            if let Some(s) = &mut self.stream {
                s.interrupt_deadline = None;
            }
            self.land_turn();
            return;
        }
        let activity = self
            .stream
            .as_ref()
            .and_then(|s| s.turn.as_ref())
            .is_some_and(|t| t.saw_turn_activity);
        let has_text = text.as_deref().is_some_and(|t| !t.trim().is_empty());
        if activity || has_text || is_error {
            if let Some(s) = &mut self.stream {
                if let Some(t) = &mut s.turn {
                    t.result_text = text;
                }
            }
            self.fire("T7");
            self.land_turn();
        } else {
            // T8 — 무음 result 보류(슬라이딩 재장전)
            self.fire("T8");
            let now = self.now();
            if let Some(s) = &mut self.stream {
                if let Some(t) = &mut s.turn {
                    t.held_until = Some(now + HELD_SLIDE);
                    t.rearms = 0;
                }
            }
            self.set_state("T8", StateTag::HeldResult, None);
        }
    }

    /// T30 — 한도 대기표 장전. `resets_at`은 **런타임 시계 ms**(모르면 `None`).
    ///
    /// ★R5(R14 확인 크리틱 F2) — R4까지 이 함수는 `None`을 받으면 `now + 5분`으로
    /// **덮어썼다**. 결과가 셋이었다:
    ///  ① 에러 문구의 리셋 꼬리(`…|1755150000`)를 아무도 읽지 않았고(호출부가 늘 `None`),
    ///  ② 화면이 5시간 한도에도 "약 5분 뒤 자동으로 이어서 계속해요"라고 적었고,
    ///  ③ 6.5분마다(=5분 + 90초 재검증) 헛 재개가 돌았다 — 30분에 4회, 5시간 창이면 ~46회.
    /// 이제 미상은 미상으로 두고, 대기 간격은 [`LimitHold::due_at`]이 2.6.2 규약
    /// (`PROBE_MS` 10분 + 지수 백오프)으로 정한다.
    fn arm_hold(&mut self, resets_at: Option<Millis>) {
        self.fire("T30");
        let run = self
            .stream
            .as_ref()
            .and_then(|s| s.turn.as_ref().map(|t| t.run_id))
            .unwrap_or(RunId(0));
        let now = self.now();
        // 방금 죽은 턴이 **엔진이 스스로 연 재개**였다면 그 시도는 헛방이었다 —
        // 그 사실을 표에 물려 다음 대기를 늘리고(백오프) 상한을 센다.
        //
        // ★R28d WCAP — **다만 "헛방"인지를 이제 실제로 본다**(RCAP 확인 크리틱 R1 §4.1).
        // R28c까지는 한도로 죽은 착지마다 무조건 올랐다. 그 턴이 30초 만에 같은 벽에
        // 부딪혔는지, 5시간을 꽉 채워 일하고 **다음 창에서** 막혔는지를 아무도 안 봤다 —
        // 그래서 22시 한도 → 03시 재개(성공) → 08시 새 한도 → 13시 재개(성공) → 18시 새
        // 한도에서 자동이 접혔다. 그 사용자가 읽는 「자동으로 이어서 보낸 턴이 계속 한도에
        // 막혔어요」는 사실이 아니다. 값싼 구분자 둘을 받는다(렌더러
        // `limitResume.ts::carriedAttempts`가 글자 그대로 같은 둘을 같은 순서로 본다):
        //
        //  ① **창이 넘어갔다** — 이번 문구의 리셋 시각이 직전에 쏜 표(`auto_resume_at`)보다
        //     뒤이고, **아직 오지 않았다**(`> now`). 두 번째 다리가 이 축에서 하중을 다 진다:
        //     `epoch_secs_to_runtime`이 **지난 epoch을 `now`로 접기** 때문에(`saturating_sub`)
        //     같은 벽에 다시 부딪힌 표의 런타임 `resets_at`은 늘 "지금"이 되고, 그러면 첫
        //     다리만으로는 언제나 「넘어갔다」가 된다. 실측(초안): 그 판이 6시간에 **39발**
        //     (`tests/wcap_limit_streak.rs` ④의 유래). 렌더러 짝은 epoch 축이라 첫 다리가
        //     그대로 살아 있고, 두 다리를 다 두어 **같은 규칙 한 벌**로 맞춘다.
        //  ② **그 턴이 일을 했다** — 어시스턴트 출력·도구 호출·**이 턴에서 연 도구의**
        //     결과를 하나라도 봤다(`saw_turn_output`). 한도로 문전박대당한 턴에는 result
        //     에러 하나뿐이다.
        //
        // ★R28d WCAP **R2** — ②가 읽는 값이 `saw_turn_activity`에서 `saw_turn_output`으로
        // 좁아졌다(WCAP 확인 크리틱 R1 §3.2). 앞의 것은 `Frame::StreamEvent`의 맨 끝줄에서
        // **조건 없이** 서므로 `ping` 한 장이면 「일했다」가 됐고, 시각 미상 축에서는 ②가
        // 유일 판정자라 그 한 장이 RCAP의 「자동은 최대 2발」을 통째로 지웠다. 같은 12시간
        // 대본 실측: `ping`/`message_start`/`thinking_delta` 한 장 → **엔진 71발**, 그런데
        // 같은 판의 **렌더러는 2발**(그 셋은 화면에 아무것도 안 남긴다 — `thinking`은
        // result가 오면 스토어가 걷는다). 파리티가 깨진 자리이자 회귀의 자리였다.
        // 이제 양쪽 문턱이 같다: **비어 있지 않은 어시스턴트 텍스트 · 도구 호출 · 도구 결과.**
        // (넓은 `saw_turn_activity`는 자기 자리인 T8/T9에 그대로 남는다.)
        //
        // ★R28d WCAP **R3** — R2의 그 문장은 「무엇을」만 맞췄고 **「어느 턴의 것으로」**를
        // 안 맞췄다(WCAP 확인 크리틱 R2 §3.3). 앞 턴에서 열린 도구의 결과가 재개 턴에 뒤늦게
        // 도착하는 다리에서 **엔진 71발 / 렌더러 2발**이 그대로 되살아났다 — 렌더러의
        // `tool-end`는 있는 도구를 제자리에서 패치만 하므로 그 도구 그룹은 재개의 사용자
        // 말풍선 **앞**에 남고, 뒤에서부터 훑는 `turnDidWork`가 거기서 멎기 때문이다.
        // 지금 셋째 항목의 정확한 문장은 **「이 턴 안에서 연 도구의 결과」**다.
        //
        // **OR가 아니라 우선순위다.** 시각을 둘 다 아는 판에서 ①의 답은 이미 완전하다
        // (진짜로 넘어갔다면 새 창의 리셋은 반드시 더 뒤다). 거기서 ②로 뒤집으면, 토큰
        // 한 줄을 내고 같은 벽에 다시 부딪히는 판(서버가 지난 epoch을 계속 되돌려 주는
        // 판)에서 계수가 영영 0이 되고 **RCAP이 막은 무한 재발사가 15초 간격으로 돌아온다**
        // (`due_at` = `max(resets_at + 90s, armed_at + 15s)`이고 그 시각은 이미 지났다).
        // 그래서 시각을 아는 판은 시계가 판정하고, 한쪽이라도 미상인 판(codex 배너형처럼
        // 읽을 꼬리가 없어 ①이 영영 침묵하는 축)만 일한 흔적이 판정한다.
        //
        // 계수는 표 안팎 두 벌이므로 되돌릴 때도 **둘 다** 놓는다. 밖(`auto_resume_streak`)만
        // 남으면 다음 소진이 그 값에서 +1 해서 되돌린 것이 도로 살아난다.
        //
        // ★R28e WFIRE — ②에 **수명**이 붙었다(WCAP 확인 크리틱 R2 §5.1). R4까지 ②는 「무엇을
        // 냈나」만 봤고, 그래서 시각 미상 축에서 *한 줄 내고 즉사하는 턴*이 *다섯 시간을 태운
        // 턴*과 같은 답을 받았다 — 12시간 **71발 · `attempts` 0 · 안 접힘**(어시스턴트 텍스트
        // 한 줄 / 도구 하나 열고 결과 없이 죽음 / 한도 문구 자체를 텍스트로 받은 턴). 계수가
        // 0이라 지수 백오프도 같이 죽어 10분 간격이 밤새 유지됐다.
        //
        // 이제 그 축의 문장은 R28d WCAP이 원래 쓰려던 문장 그대로다: **「30초 만에 같은 벽에
        // 부딪혔나, 창을 꽉 채워 일하고 다음 벽에서 막혔나」.** 기준점은 우리가 쏜 시각
        // ([`Self::auto_resume_fired_at`])이고, 렌더러 짝은 스토어의 `turnAt`이다.
        // 모르면(=우리가 쏜 턴이 아니면) 인정하지 않는다 — 상한은 「모른다」로 지워지면 안 된다.
        //
        // 이 문턱만으로는 못 막는 판이 하나 남는다: 산출을 흘리며 **천천히** 죽는 턴
        // (수명 ≥ [`MIN_WORK`]인데 매번 같은 벽). 그쪽은 [`Self::episode_fires`] 예산이
        // 받는다([`Self::check_hold`]) — 두 장치가 서로의 사각을 덮는다.
        let worked = self
            .stream
            .as_ref()
            .and_then(|s| s.turn.as_ref())
            .is_some_and(|t| t.saw_turn_output)
            && self
                .auto_resume_fired_at
                .is_some_and(|f| now.saturating_sub(f) >= crate::limit::MIN_WORK);
        let cleared = match (resets_at, self.auto_resume_at) {
            (Some(next), Some(prev)) => next > prev && next > now,
            _ => worked,
        };
        let attempts = if cleared { 0 } else { self.auto_resume_streak };
        self.auto_resume_streak = attempts;
        self.hold = Some(LimitHold {
            account: self.identity.billing().clone(),
            resets_at,
            verified_at: None,
            ready: false,
            auto_paused: false,
            attempts,
            // 새 표는 아직 아무것도 못 물어본 표가 아니라 **안 물어본** 표다(0).
            probes: 0,
            probed_at: None,
            armed_from_run: run,
            armed_at: now,
            notice_due: false,
            // 이 표는 **이 프로세스가 방금 세운** 표다 — 재장전 통행권은 재장전만 준다.
            reloaded: false,
        });
        // ★M11 — 표를 걸자마자 **노는 계정**을 묻는다. 있으면 대기 없이 갈아타고,
        // 없으면(설정 꺼짐 · 후보 없음 · 오염) 아래 문장 그대로 대기표 경로다.
        // 훅이 미배선이면 이 줄은 즉시 false다 = 기존 동작.
        //
        // **`pending`이라도 묻는다.** 셸의 훅은 이 물음을 받고서야 워커를 깨우기 때문이다
        // (★R2에서 부팅 프리웜을 걷어낸 뒤로는 *유일한* 계기다). `pending`일 때 안 물으면
        // 스냅샷이 영원히 차갑고 전환은 한 번도 안 일어난다 — R2 주행에서 실제로 밟았다.
        if self.try_auto_switch() {
            return;
        }
        // ★M11 — 훅이 "아직 모른다"면 대기 문장을 **한 tick 미룬다**.
        //
        // 실물 주행(R1)에서 두 줄이 연달아 떴다:
        //   「사용 한도에 걸려 대기합니다 — 풀리는 시각에 맞춰 이어서 보낼게요.」
        //   「사용 한도에 걸려 soon@… 계정으로 바꿔 이어갑니다 …」
        // 앞 줄은 **0.3초 만에 거짓이 됐다.** 셸의 한도 스냅샷이 차가워서 첫 물음이
        // "조회 중"이었을 뿐인데, 그 사이를 대기 선언으로 메운 것이다.
        // 미루면 [`Self::check_hold`]가 판명 직후(또는 [`HOLD_NOTICE_GRACE`] 뒤) 말한다 —
        // 침묵 no-op(D7)이 아니라 **말할 사실이 정해질 때까지의 유예**다.
        //
        // ★R2(C3) — 미뤄 둔 문장은 이제 **표 안에** 산다. 표가 죽으면 같이 죽는다.
        if self.switcher.pending() {
            if let Some(h) = &mut self.hold {
                h.notice_due = true;
            }
            return;
        }
        self.emit_hold_notice(resets_at);
    }

    /// 대기표 문장 — 침묵 금지(D7). 언제 다시 볼지를 담는다("모른다"도 값이다).
    fn emit_hold_notice(&mut self, resets_at: Option<Millis>) {
        if let Some(h) = &mut self.hold {
            h.notice_due = false;
        }
        self.emit(Event::Notice(if resets_at.is_some() {
            "사용 한도에 걸려 대기합니다 — 풀리는 시각에 맞춰 이어서 보낼게요.".into()
        } else {
            "사용 한도에 걸려 대기합니다 — 언제 풀리는지 알 수 없어 잠시 뒤 다시 확인할게요.".into()
        }));
    }

    // ── tick: 타이머 + 워치독 (§5.4-c) ───────────────────────────────────────

    /// 가장 이른 타이머 만료 시각. 실앱은 워치독 tick(5s)과 **별개의 타이머**로 이것들을 깨우고
    /// (2.6.2도 `setTimeout` 개별 타이머였다), 재생 하네스는 이 값으로 시계를 정확히 민다.
    /// 이게 없으면 2.5s 슬라이딩 보류가 5s tick에 삼켜져 **없는 동작**을 재생하게 된다.
    pub fn next_deadline(&self) -> Option<Millis> {
        let mut out: Option<Millis> = None;
        let mut put = |v: Option<Millis>| {
            if let Some(v) = v {
                out = Some(out.map_or(v, |o: Millis| o.min(v)));
            }
        };
        if let Some(s) = &self.stream {
            match s.state {
                StateTag::Starting => put(Some(s.started_at + START_TIMEOUT)),
                StateTag::Interrupting => put(s.interrupt_deadline),
                StateTag::HeldResult => put(s.turn.as_ref().and_then(|t| t.held_until)),
                // T22 백스톱 — 발화 조건은 `!process_alive()`라 살아 있는 스트림에서는
                // 이 시각에 깨어나 아무것도 안 하고 지나간다(리스 재장전도 없다).
                StateTag::Streaming | StateTag::AwaitingUser => {
                    put(Some(s.last_frame_at + STREAM_STALL_BACKSTOP))
                }
                StateTag::Resident => {
                    put(s.linger_deadline);
                    put(s.stop_deadline);
                    put(Some(s.last_frame_at + STREAM_IDLE_LIMIT));
                }
                _ => {}
            }
            put(s.probe_inflight_until);
        }
        put(self.hold.as_ref().filter(|h| !h.ready).and_then(|h| h.due_at()));
        out
    }

    pub fn tick(&mut self) {
        let now = self.sync_now();
        let frames = self.driver.poll_frames(now);
        for f in frames {
            self.on_frame(&f);
        }
        // ★ T22 — stdout EOF/프로세스 exit. **프레임을 다 소화한 뒤에** 본다(마지막
        //   result가 EOF와 같은 틱에 올 수 있다). 여기가 제품의 유일한 T22 진입점이다:
        //   이게 없던 동안 `stream_died()`의 호출자는 재생 테스트뿐이었고, 외부에서 CLI가
        //   죽으면 채팅이 영구히 굳었다(크리틱 배선 R1 §2-E/F = m-logic P8 그 자체).
        if self.stream.is_some() {
            if let Some(cause) = self.driver.stream_eof() {
                self.stream_died(cause);
                // 스트림이 없어졌다 — 이 틱의 타이머/워치독은 볼 것이 없다.
                self.check_hold(now);
                return;
            }
        }
        self.timers(now);
        self.watchdog(now);
        self.check_hold(now);
    }

    fn timers(&mut self, now: Millis) {
        let Some(s) = &self.stream else { return };
        let state = s.state;
        let started = s.started_at;
        let last_frame = s.last_frame_at;
        let linger = s.linger_deadline;
        let interrupt = s.interrupt_deadline;
        let stop = s.stop_deadline;
        let held = s.turn.as_ref().and_then(|t| t.held_until);
        let rearms = s.turn.as_ref().map(|t| t.rearms).unwrap_or(0);
        let notifs = s
            .turn
            .as_ref()
            .map(|t| !t.delivered_notifs.is_empty())
            .unwrap_or(false);
        let replayed = s.turn.as_ref().map(|t| t.replayed_once).unwrap_or(false);
        // T12 가드의 넷째 항 — "중단 요청 없음"(§3.3). 중단한 사용자에게 기계가 다시
        // 프롬프트를 밀어 넣지 않는다. 사용자가 손수 보낸 턴(T16)에서 해제된다.
        let interrupted = s.interrupt_marker;

        match state {
            StateTag::Starting if now - started >= START_TIMEOUT => {
                self.emit(Event::Notice("엔진이 20초 안에 응답하지 않았어요".into()));
                self.set_state("T3", StateTag::Terminating, None);
                self.close_and_finish(CloseCause::SpawnFailed);
                return;
            }
            StateTag::Interrupting if interrupt.is_some_and(|d| now >= d) => {
                self.set_state("T15", StateTag::Terminating, None);
                self.close_and_finish(CloseCause::HardCancel);
                return;
            }
            StateTag::HeldResult if held.is_some_and(|d| now >= d) => {
                if notifs && !replayed && !interrupted {
                    // T12 — 통지 삼킴 재주입(1회 제한)
                    if let Some(s) = &mut self.stream {
                        if let Some(t) = &mut s.turn {
                            t.replayed_once = true;
                            t.held_until = None;
                        }
                    }
                    self.land_turn_wrap_only();
                    self.driver
                        .send(user_message("이어서 진행해 주세요(통지 재주입)"));
                    self.set_state("T12", StateTag::Streaming, None);
                } else if rearms + 1 < HELD_MAX_REARMS {
                    if let Some(s) = &mut self.stream {
                        if let Some(t) = &mut s.turn {
                            t.rearms += 1;
                            t.held_until = Some(now + HELD_SLIDE);
                        }
                    }
                    self.set_state("T10", StateTag::HeldResult, None);
                } else {
                    self.emit(Event::Notice("응답이 비어 있어 턴을 마감했어요".into()));
                    self.fire("T11");
                    self.land_turn();
                }
                return;
            }
            // ★ T22 백스톱 아크(§5.4-b ⓪). R1까지 이 두 상태에는 아크가 **아예 없었다**
            //   = 무한. 스트림이 조용해진 지 오래인데 프로세스가 **죽은 것이 관측되면**
            //   그때만 정착시킨다. 살아 있으면 아무 일도 없다 — 승인 카드 무응답이
            //   영구 대기인 계약(m-logic §3.2)을 이 아크가 깨지 않게 하는 유일한 가드다.
            StateTag::Streaming | StateTag::AwaitingUser
                if now.saturating_sub(last_frame) >= STREAM_STALL_BACKSTOP
                    && !self.driver.process_alive() =>
            {
                self.stream_died(CloseCause::Crash);
                return;
            }
            StateTag::Resident => {
                if let Some(d) = stop {
                    if now >= d {
                        // T35 ⓑ — 3s 안에 이탈이 확인되지 않았다 → **추정** 정착
                        let ids = self
                            .stream
                            .as_ref()
                            .map(|s| s.stopping.clone())
                            .unwrap_or_default();
                        let mut forced = false;
                        for id in ids {
                            let it = self.ledger.borrow_mut().remove(&id, true);
                            if let Some(it) = it {
                                self.settle_emit(&it, SettleReason::ForcedByUser);
                                forced = true;
                            }
                        }
                        if let Some(s) = &mut self.stream {
                            s.stopping.clear();
                            s.stop_deadline = None;
                        }
                        if forced {
                            self.ledger.borrow_mut().confidence = Confidence::Unverified;
                            self.set_state("T35", StateTag::Resident, Some(ResidentWhy::Unverified));
                        }
                        return;
                    }
                }
                if linger.is_some_and(|d| now >= d)
                    && self.ledger.borrow().is_empty()
                    && self.queue.is_empty()
                {
                    self.set_state("T33", StateTag::Terminating, None);
                    self.close_and_finish(CloseCause::AllClear);
                    return;
                }
                if now.saturating_sub(last_frame) >= STREAM_IDLE_LIMIT {
                    // T32 — 행한 CLI의 마지막 탈출구
                    self.emit(Event::Notice("6시간 조용한 엔진을 정리했어요".into()));
                    self.set_state("T32", StateTag::Terminating, None);
                    self.close_and_finish(CloseCause::IdleReclaim);
                }
            }
            _ => {}
        }
    }

    /// T12 전용 — 회계만 마감하고 상태는 유지(같은 턴 연장).
    fn land_turn_wrap_only(&mut self) {
        self.land_pending();
    }

    /// §5.4-c 루프. **`Resident{*}` 밖에서 `state`를 대입하지 않는다**(N1 · 불변식 15).
    fn watchdog(&mut self, now: Millis) {
        let ids = self.ledger.borrow().evidence_bearing();
        let mut probe_needed: Vec<LiveId> = vec![];
        for id in ids {
            let (expired, kind, last_evidence) = {
                let l = self.ledger.borrow();
                match l.get(&id) {
                    Some(i) => (now >= i.lease_until, i.kind, i.last_evidence),
                    None => continue,
                }
            };
            if !expired {
                continue;
            }
            // ①a/①b·③은 도착 시점에 이미 재장전한다 — 리스가 만료됐다는 건 그들이 Unknown이라는 뜻.
            // ④ mtime(싼 프로브)을 먼저 묻는다.
            let fresh = {
                let l = self.ledger.borrow();
                l.get(&id).is_some_and(|i| self.driver.mtime_fresh(i, now))
            };
            if fresh {
                self.rearm(&id, EvidenceSource::Mtime);
                continue;
            }
            if kind != LiveKind::PendingSettle {
                probe_needed.push(id.clone());
            }
            {
                let mut l = self.ledger.borrow_mut();
                if let Some(i) = l.get_mut(&id) {
                    i.liveness = Liveness::Unverified; // ★ 게이팅 자격 즉시 상실
                }
            }
            let hard = kind.hard_limit().unwrap_or(u64::MAX);
            if now.saturating_sub(last_evidence) >= hard {
                let it = self.ledger.borrow_mut().remove(&id, true);
                if let Some(it) = it {
                    let reason = if kind == LiveKind::PendingSettle {
                        SettleReason::NotifyTimeout
                    } else {
                        self.fire("T21");
                        SettleReason::Watchdog {
                            probe: ProbeSource::None,
                        }
                    };
                    self.settle_emit(&it, reason);
                }
            }
        }

        // ⑥ 능동 프로브 — **채팅당 1회**로 합친다(항목이 3개여도 왕복 1회. O18).
        if !probe_needed.is_empty() {
            let can = self.stream.as_ref().is_some_and(|s| {
                s.probe_inflight_until.is_none()
                    && s.last_probe_at.is_none_or(|p| now.saturating_sub(p) >= PROBE_MIN_GAP)
                    && !s.closing
            });
            if can {
                let (sid, pid) = {
                    let s = self.stream.as_mut().unwrap();
                    s.probe_id += 1;
                    s.last_probe_at = Some(now);
                    s.probe_inflight_until = Some(now + PROBE_TIMEOUT);
                    s.probe_expect = probe_needed.clone();
                    (s.id, s.probe_id)
                };
                // ★M10 R6 — 프로브도 **뜰 때와 같은 append**를 싣는다. 이 프레임이 CLI에서
                // 무시되든 다시 적용되든 결과가 같아야 한다: `None`을 실으면 「다시 적용」
                // 쪽 구현에서 시스템 프롬프트가 조용히 지워진다. 좌변은 현재 설정이 아니라
                // **이 스트림이 뜰 때의 값**이다(설정이 바뀌었으면 재스폰이 그 일을 한다).
                let append = self.stream.as_ref().and_then(|s| {
                    Self::append_prompt(&s.spawn_identity, s.spawn_guide.as_deref())
                });
                self.driver
                    .send(initialize_request(&format!("probe-{pid}"), append.as_deref()));
                self.emit(Event::ProbeSent {
                    stream: sid,
                    at_ms: now,
                });
            }
        }
        // 프로브 타임아웃 → Unknown(+ stream_hung_probes)
        if let Some(s) = &mut self.stream {
            if s.probe_inflight_until.is_some_and(|d| now >= d) {
                s.probe_inflight_until = None;
                s.probe_expect.clear();
                s.hung_probes += 1;
            }
        }

        // ★ 상태 가드 — 없으면 진행 중 `Streaming`이 `Resident{Unverified}`로 튄다(N1).
        let should_flag = matches!(self.state(), StateTag::Resident) && {
            let l = self.ledger.borrow();
            l.is_empty() && l.last_removal_was_watchdog
        };
        if should_flag {
            self.ledger.borrow_mut().confidence = Confidence::Unverified;
            if self.resident_why() != Some(ResidentWhy::Unverified) {
                self.emit(Event::Notice(
                    "백그라운드 진행 상태를 알 수 없어 표시를 정리했어요. 엔진은 아직 살아 있습니다 — [엔진 정리]".into(),
                ));
                self.set_state("watchdog_loop", StateTag::Resident, Some(ResidentWhy::Unverified));
            }
        }
    }

    fn check_hold(&mut self, now: Millis) {
        // ★M11 — 표가 살아 있는 동안 매 tick 후보를 되묻는다.
        //
        // 왜 `arm_hold` 한 번으로 안 끝나나: 후보 판정에는 계정별 한도가 필요한데 그
        // 조회는 **네트워크**다. 허브 스레드(모든 채팅의 tick을 도는 그 스레드)에서
        // 동기 조회를 하면 다른 채팅의 스트리밍이 그만큼 멈춘다 — 그래서 셸의 훅은
        // 스냅샷만 읽고 즉시 답하며, 없으면 워커에게 갱신을 시키고 `None`을 낸다.
        // 그 갱신이 몇 초 뒤 도착하면 **여기서** 성사된다(사용자 체감: 한도 문구가
        // 뜨고 몇 초 뒤 다른 계정으로 이어짐).
        //
        // 훅이 미배선/설정 꺼짐이면 즉시 false라 이 줄의 비용은 함수 호출 하나다.
        //
        // 드레인은 **여기서** 한다(`try_auto_switch` 안이 아니라) — 아래 `consume_hold` 뒤의
        // 드레인과 같은 자리다. tick의 끝은 재진입이 없는 안전한 발사대다.
        if self.hold.is_some() && self.try_auto_switch() {
            // 갈아탔다 = 표가 사라졌고, 미뤄 둔 대기 문장도 그 표와 함께 죽었다(C3).
            self.drain_if_possible();
            return;
        }
        // 미뤄 둔 대기 문장(위 `arm_hold`) — **판명됐거나 유예가 끝나면** 말한다.
        // 유예 상한이 있는 이유: 훅이 영영 `pending`으로 굳으면(워커 사망) 그 채팅은
        // 아무 말도 못 듣는다 = D7 위반. 늦게라도 말하는 쪽이 항상 낫다.
        //
        // ★R2 C3 — 이 블록의 전제는 **표가 살아 있다**는 것이다. 표를 죽이는 자리는
        // 다섯이고(전환 성사 · §7.3 계정 변경 · `Cmd::HoldCancel` · undo · 소진) 그중
        // 셋은 이 플래그를 몰랐다. 이제 플래그가 표 안에 있어 표와 함께 죽는다 —
        // 「취소했어요」 바로 뒤에 「기다립니다」가 붙는 유령 문장이 구조적으로 불가능하다.
        if self.hold.as_ref().is_some_and(|h| h.notice_due) {
            let armed = self.hold.as_ref().map(|h| h.armed_at).unwrap_or(now);
            if !self.switcher.pending() || now.saturating_sub(armed) >= HOLD_NOTICE_GRACE {
                let at = self.hold.as_ref().and_then(|h| h.resets_at);
                self.emit_hold_notice(at);
            }
        }
        // ★R28g BANNER — **부팅 뒤 첫 판정은 `ready` 표도 한 번 본다**(R28f 확인 크리틱 R1 F1/F3).
        //
        // 아래 `filter(|h| !h.ready)`는 **인프로세스에서는 옳다**: `ready`가 켜진 채 살아남은
        // 표는 세 착지(접힘 · 화면 밖 · 조회 실패 소진) 중 하나이고, 다시 들여다보면 매 tick
        // 같은 문장을 되뇐다. 그런데 **재장전은 그 tick의 바깥**이다 — 디스크에 `ready:true`로
        // 적힌 표는 *이 프로세스가 한 번도 판정하지 않은 표*인데도 같은 필터에 걸려 영영
        // 판정에 도달하지 못했다(크리틱 c8 실측: 자동 켬 + 20시간 **0발**). 그동안 배너는
        // 「한도가 풀렸어요 — 곧 이어서 계속해요」라고 **지키지 못할 약속**을 했다.
        //
        // 통행권을 주는 조건이 곧 **배너가 약속을 하는 조건**이다:
        //
        // | 재장전된 `ready` 표 | 화면이 하는 말 | 통행권 |
        // |---|---|---|
        // | 자동 켬 · 안 접힘 | 「곧 이어서 계속해요」 = **약속** | **준다**(약속을 지킨다) |
        // | 자동 끔(화면 밖) | 「눌러서 이어가기」 + 버튼 | 안 준다 — 이미 정직하고 출구도 열려 있다 |
        // | 접힘(`auto_paused`) | 「N번 이어서 보냈는데 계속 막혔어요」 + 버튼 | 안 준다 — 접힘의 근거(`attempts`·`fires`)가 함께 건너와 재판정이 **같은 답**을 낸다(못 ⑰ 대조군: 근거만 주고 접힘을 안 줘도 같은 자리에서 다시 접힌다) |
        //
        // 들어갈 때 `ready`를 내리는 것이 계약이다. 그래야 아래 세 갈래(`Blocked` 재대기 ·
        // `Unavailable` 재확인 계수 · `Clear` 발사/접힘)가 인프로세스와 **글자 그대로 같은
        // 경로**를 탄다 — `ready`를 켠 채 들여보내면 `Blocked` 착지가 「아직 막혔는데 ready」
        // 라는 새 거짓말을 만든다.
        let reload_pass = self
            .hold
            .as_ref()
            .filter(|h| h.ready && h.reloaded && !h.auto_paused && self.auto_resume)
            .and_then(|h| h.due_at())
            .is_some_and(|d| now >= d);
        if reload_pass {
            if let Some(h) = &mut self.hold {
                h.ready = false;
            }
        }
        let due = self
            .hold
            .as_ref()
            .filter(|h| !h.ready)
            .and_then(|h| h.due_at())
            .is_some_and(|d| now >= d);
        if !due {
            return;
        }
        // 통행권은 **한 번**이다 — 판정에 들어간 표는 더 이상 「아직 판정 안 받은 표」가 아니다.
        if let Some(h) = &mut self.hold {
            h.reloaded = false;
        }
        // 계정이 바뀌었으면 대기표는 무효다(§7.3).
        let same_account = self
            .hold
            .as_ref()
            .is_some_and(|h| h.account == *self.identity.billing());
        if !same_account {
            self.hold = None;
            self.emit(Event::Notice("계정을 바꿔서 대기표를 취소했어요".into()));
            self.broadcast_plan();
            self.drain_if_possible();
            return;
        }
        // ★R5 — **발화 재검증**(2.6.2 `useLimitResume.fire()` · m-logic §7.3 "정제/발화").
        //
        //   *"장전 시점 판단을 믿지 않고 신선 usage로 재검증한다. 아직 막혀 있으면 그
        //     해제 시각으로 재장전, 풀렸으면 ready 표시만."*
        //
        //   재장전은 **CLI를 안 띄운다** — 이것이 헛 재개와 다른 점이다. 그래서 훅이
        //   붙어 있는 한 몇 번을 다시 걸어도 사용자 눈에는 대기표 하나뿐이다.
        //
        //   ★T3T4 R3 — 착지는 **넷**이다(이식본 `resumeVerdict`의 셋 + 훅 미배선).
        //   순서가 곧 계약이다: 막혔다는 신선한 증거가 먼저고, 그다음이 "못 물어봤다"이며,
        //   풀렸다는 맨 마지막이다.
        //
        //   ★CRIT R1 — 그리고 **어느 엔진의 한도인지**를 함께 넘긴다. R3까지는 표가 든
        //   과금 축(=클로드 계정)만 넘어가서, Codex 채팅의 재검증이 **클로드 주간 창**을
        //   보고 "아직 안 풀렸다"고 답했다(확인 크리틱 R3 §3 — 50시간 재장전 + 사용자
        //   메시지 큐 주차). 축은 표가 아니라 **지금 정체성**에서 읽는다: 표는 장전 시각의
        //   과금 축만 알고, 이 실행이 어느 서비스의 창을 태우는지는 정체성만 안다.
        let account = self.hold.as_ref().map(|h| h.account.clone());
        if let Some(acct) = account {
            let verdict = {
                let q = crate::limit::ProbeQuery {
                    billing: &acct,
                    engine: self.identity.engine_kind(),
                    codex_account: self.identity.codex_account(),
                    model: self.identity.model(),
                    now_epoch_ms: self.clock.now_epoch_ms(),
                };
                self.limit_probe.probe(&q)
            };
            match verdict {
                // ① 아직 막혀 있다 — 그 시각으로 재장전하고 실패 계수는 지운다.
                LimitVerdict::Blocked { resets_at } => {
                    let at = resets_at.map(|s| self.epoch_secs_to_runtime(s));
                    if let Some(h) = &mut self.hold {
                        h.resets_at = at;
                        h.armed_at = now;
                        h.verified_at = Some(now);
                        h.probes = 0;
                        h.probed_at = None;
                    }
                    self.emit(Event::Notice(
                        "확인해 보니 아직 한도가 안 풀렸어요 — 다시 기다립니다.".into(),
                    ));
                    self.broadcast_plan();
                    return;
                }
                // ② **못 물어봤다 ≠ 풀렸다**(최종 파리티 R28 확인 크리틱 R2의 최대 격차).
                //
                //   R2까지 이 자리는 `Unknown` 하나였고 그 뜻은 "풀린 것으로 두고 진행"
                //   이었다. 셸이 훅을 꽂는 순간 그 관대함은 **조회가 죽어 있는 동안
                //   눈감고 쏘는 재전송기**가 된다 — 렌더러에서 이미 한 번 고친 그 사고이고
                //   (`limitResume.ts` `resumeVerdict`), 본채팅은 `resumeOwner:"engine"`이라
                //   그 수정의 바깥에 있었다.
                LimitVerdict::Unavailable => {
                    let probes = self.hold.as_ref().map_or(0, |h| h.probes) + 1;
                    // 문구가 알려 준 리셋 시각이 **정말 지났나**.
                    //
                    // ★CRIT R1 — R3까지 이 값이 거짓이면 **영영 손을 안 들었다**(확인 크리틱
                    // R3 §3.4). `resets_at`이 `None`인 표(에러 문구에 `…|epoch` 꼬리가 없는
                    // 판 — codex 한도 문구가 그렇다)는 `past`가 영원히 거짓이라 아래 착지에
                    // 도달하지 못하고, 조회가 죽어 있으면 10분마다 조용히 다시 묻기만 한다.
                    // 그동안 `hold_gate_open()`이 닫혀 있어 **사용자가 직접 보낸 메시지도
                    // 큐에 선다** — ✕도 「이어가기」도 없는 상태가 무한히 이어진다.
                    // 시각을 모르는 것은 "기다릴 근거가 없다"는 뜻이지 "영원히 기다리라"가
                    // 아니다. [`crate::limit::MAX_BLIND_PROBES`]번 실패했으면 둘 다 사용자에게
                    // 넘긴다(아래 착지는 아무것도 안 태우고, 버튼은 사용자의 선택이다).
                    let known = self.hold.as_ref().is_some_and(|h| h.resets_at.is_some());
                    let past = self
                        .hold
                        .as_ref()
                        .and_then(|h| h.resets_at)
                        .is_some_and(|r| now >= r);
                    if let Some(h) = &mut self.hold {
                        h.probes = probes;
                        h.probed_at = Some(now);
                    }
                    if probes < crate::limit::MAX_BLIND_PROBES || (known && !past) {
                        // 침묵 금지(D7) — 다만 재확인마다 말하면 그게 스팸이다. 한 번만.
                        //
                        // **두 번째**부터 말하는 이유: 셸의 훅은 스냅샷이 차가우면 워커를
                        // 깨우고 그 회차는 「못 물어봤다」로 답한다(허브 스레드를 막지 않으려고).
                        // 정상 판에서도 첫 회차가 그 모양이라, 1에서 말하면 잘 돌아가는
                        // 재개마다 「조회 실패」라고 거짓말을 하게 된다.
                        if probes == 2 {
                            self.emit(Event::Notice(
                                "한도가 풀렸는지 확인하지 못했어요(조회 실패) — 보내지 않고 잠시 뒤 다시 확인합니다.".into(),
                            ));
                        }
                        self.broadcast_plan();
                        return;
                    }
                    // ②' 계속 실패했고 리셋 시각도 지났다 — **자동을 접고 사용자에게 넘긴다.**
                    //
                    //   이식본은 이 자리에서 *눈감고 한 번 쏜다*. 엔진이 그러지 않는 이유는
                    //   출구가 하나 더 있기 때문이다: `ready`를 켜면 배너가 「눌러서
                    //   이어가기」를 준다(`resumeOwner.ts` `canPressResume`). 아무것도 안
                    //   태우고 침묵도 아닌 착지이고, `auto_paused`가 예약분까지 잠근다.
                    if let Some(h) = &mut self.hold {
                        h.ready = true;
                        h.auto_paused = true;
                        h.verified_at = Some(now);
                    }
                    self.emit(Event::Notice(format!(
                        "한도가 풀렸는지 {probes}번 확인했는데 조회가 계속 실패해서 자동으로 보내지 않았어요 — 준비되면 눌러서 이어가세요."
                    )));
                    self.broadcast_plan();
                    return;
                }
                // ③ 풀렸다 / 훅 미배선(옛 계약 그대로 진행).
                LimitVerdict::Clear | LimitVerdict::Unknown => {
                    if let Some(h) = &mut self.hold {
                        h.probes = 0;
                        h.probed_at = None;
                    }
                }
            }
        }
        if let Some(h) = &mut self.hold {
            h.ready = true;
            h.verified_at = Some(now);
        }
        // ★R5 — **눈감고 쏘는 재개의 상한**(R14 확인 크리틱 F2). 재검증 훅이 없거나
        //   조회에 실패한 판에서, 재개 턴이 같은 한도 에러로 또 죽었다면 그것이 곧
        //   "아직 안 풀렸다"는 신선한 증거다. 상한을 넘기면 자동을 멈추고 `ready`만 켠 채
        //   사용자에게 넘긴다 — 아래 스펙 ⑤와 착지점이 같고 이유만 다르다.
        //   (F1과 겹칠 때가 최악이었다: 리셋으로 풀리지 않는 컨텍스트 초과 에러 하나가
        //    영원히 6.5분마다 재전송됐다. 그 문은 F1 쪽에서도 닫혔고 여기서도 닫는다.)
        let over = self.hold.as_ref().is_some_and(|h| h.attempts >= MAX_AUTO_ATTEMPTS);
        // ★R28e WFIRE — **두 번째 문: 에피소드 총 발사 예산**([`crate::limit::MAX_EPISODE_FIRES`]).
        //
        // 위의 `over`는 「연속 헛발질」을 세므로 구분자 ①·②가 0으로 되돌리는 순간 사라진다.
        // 그게 시각 미상 축에서 12시간 71발이 나오던 이유다(WCAP 확인 크리틱 R2 §5.1):
        // 재개 턴이 산출을 한 줄이라도 내면 계수가 영영 0이었다. 이 문은 **아무 구분자도
        // 못 지우는** 총계를 본다 — 되돌아가는 자리는 사람 손 셋과 「한도 없이 착지」 하나뿐이다.
        //
        // 밤샘 주행을 안 자르는 근거는 눈금 자체에 있다: 창 하나에 한 발이므로 12발이면
        // **60시간**이다. 반대로 10분마다 도는 헛돌이는 2시간 안에 예산을 다 쓴다.
        //
        // ★R28f WFIRE — 그래서 이 문의 불변식은 「밤샘은 안 잘린다」가 아니라
        // **「약 60시간까지는 안 잘린다」**이다(R28e 확인 크리틱 R1 §4.2 실측: 5시간 창 ·
        // 4.5시간 작업 대본이 12발 = 약 56~60시간에서 접힌다). 하룻밤(12시간 7발)이 한 발도
        // 안 깎이는 것이 유지 조건이고, 그 너머는 접히되 버튼이 열려 있다.
        let budget_out = self.episode_fires >= crate::limit::MAX_EPISODE_FIRES;
        if over || budget_out {
            if let Some(h) = &mut self.hold {
                h.auto_paused = true;
            }
            self.emit(Event::Notice(if over {
                // ★R28d WCAP R4 — 한글 문장 안의 `turn`을 「턴」으로(WCAP 확인 크리틱 R1 §6).
                // 화면에 그대로 나가는 공지다 — 같은 사실을 말하는 `Chat.tsx`의 배너와
                // 글자를 맞춘다.
                "자동으로 이어서 보낸 턴이 계속 한도에 막혀서 자동 재개를 멈췄어요 — 준비되면 눌러서 이어가세요.".into()
            } else {
                // 사실이 다르면 문장도 달라야 한다(D7) — 이쪽 턴들은 **막히기만 한 게 아니라
                // 일도 했다**. 그런데도 한도가 안 끝나서 예산을 다 썼다는 것이 이 착지다.
                format!(
                    "이 한도 창에서 자동으로 {}번 이어서 보냈는데 계속 한도에 걸려서 자동 재개를 멈췄어요 — 준비되면 눌러서 이어가세요.",
                    self.episode_fires
                )
            }));
            self.broadcast_plan();
            return;
        }
        // ★ 스펙 ⑤ — 자동 발사가 꺼진 채팅(화면 밖 · 닫힌 창)은 **여기서 멈춘다**.
        //   대기표는 `ready=true`로 남아 사이드바가 "이어갈 수 있음"을 그리고,
        //   실제 발사는 사용자가 누를 때(`resume_now`)다. 게이트는 `hold_gate_open()`이
        //   닫아 두므로 이 채팅의 예약분도 혼자 나가지 않는다.
        if !self.auto_resume {
            self.emit(Event::Notice(
                "사용 한도가 풀렸어요 — 이 채팅은 화면 밖이라 자동으로 보내지 않았습니다. 눌러서 이어가세요.".into(),
            ));
            self.broadcast_plan();
            return;
        }
        // 소진 — 나팔("이어서 진행해 주세요")을 넣을지는 `consume_hold`가 가른다(★R4).
        self.consume_hold(true);
        self.drain_if_possible();
    }

    // ── 외부 사건 / 폴트 ─────────────────────────────────────────────────────

    /// T22 — stdout EOF / 프로세스 exit. 원장 일괄 정착은 **스킵 불가**다.
    pub fn stream_died(&mut self, cause: CloseCause) {
        if self.stream.is_none() {
            return;
        }
        self.sync_now();
        self.set_state("T22", StateTag::Terminating, None);
        self.finish_termination(cause);
    }

    /// T24 — 앱 종료. 아무것도 기다리지 않는다(job object가 손자까지 보증).
    pub fn app_quit(&mut self) {
        if self.stream.is_none() {
            return;
        }
        self.sync_now();
        self.driver.kill();
        self.set_state("T24", StateTag::Terminating, None);
        self.finish_termination(CloseCause::AppQuit);
    }
}

/// 큐 항목 → **stdin으로 나갈 본문**. 첨부가 있으면 2.6.2 `promptWithNotes`와 같은
/// 노트 블록을 뒤에 붙인다(`App.tsx:146-159`).
///
/// 왜 여기인가: 첨부는 큐 항목에 **데이터로** 살아 있어야 하고(취소·재정렬·재장전이
/// 그 값을 만진다), CLI에는 경로 목록이 본문에 접혀 나가야 한다. 두 요구를 한 값으로
/// 만족시키려면 접는 자리가 드레인이어야 한다.
///
/// 첨부가 없으면 **원문 그대로**다 — 옛 경로(`chat:run`은 렌더러가 이미 접어 보낸다)의
/// 바이트가 한 글자도 안 바뀐다.
fn compose_prompt(m: &QueuedMessage) -> String {
    if m.attachments.is_empty() {
        return m.text.clone();
    }
    let list = m
        .attachments
        .iter()
        .map(|p| format!("- {p}"))
        .collect::<Vec<_>>()
        .join("\n");
    let note = format!("[첨부 파일 — Read 도구로 확인하세요]\n{list}");
    if m.text.is_empty() {
        note
    } else {
        format!("{}\n\n{}", m.text, note)
    }
}

/// ★R28d WCAP R2 — 문자열 값이 **공백만은 아닌가.** 렌더러 `turnDidWork`의
/// `(m.text ?? '').trim()` 짝이다. 문자열이 아니면(없음·null) 거짓.
fn nonblank(v: &Value) -> bool {
    v.as_str().is_some_and(|t| !t.trim().is_empty())
}

/// ★R28d WCAP R2 — `assistant` 프레임이 **화면에 남을 글자**를 실어 왔나.
///
/// `Frame::Assistant::has_text`는 `{"type":"text"}` 블록의 **존재**만 보므로 빈 문자열
/// 블록에도 참이다. 좁은 문턱은 렌더러와 같이 내용까지 본다.
fn nonblank_assistant_text(v: &Value) -> bool {
    v["message"]["content"]
        .as_array()
        .is_some_and(|bs| bs.iter().any(|b| b["type"] == "text" && nonblank(&b["text"])))
}

/// 와이어 모델 id → picker 별칭. `claude-opus-5[1m]` → `opus`.
/// 모르는 값은 **그대로 둔다**(조용히 바꾸느니 사유에 원문이 보이는 게 낫다).
pub fn model_alias(wire: &str) -> String {
    let l = wire.to_lowercase();
    for a in ["fable", "opus", "sonnet", "haiku"] {
        if l.contains(a) {
            return a.to_string();
        }
    }
    wire.to_string()
}

fn respawn_text(identity: &[IdentityField], thread: bool, kills: &[(LiveKind, usize)]) -> String {
    let mut parts: Vec<String> = vec![];
    if identity.iter().any(|f| *f == IdentityField::EngineModel) {
        parts.push("모델 자동 전환".into());
    }
    if identity.iter().any(|f| *f == IdentityField::BillingAccount) {
        parts.push("계정 변경".into());
    }
    if identity.iter().any(|f| *f == IdentityField::Cwd) {
        parts.push("폴더 변경".into());
    }
    if parts.is_empty() && !identity.is_empty() {
        parts.push("설정 변경".into());
    }
    if thread {
        parts.push("대화 새로 시작".into());
    }
    let n: usize = kills.iter().map(|(_, c)| *c).sum();
    // ★ 정리된 게 0개면 "N개 정리" 문장을 붙이지 않는다 — 없는 비용을 말하면 거짓말이다.
    if n == 0 {
        format!("{}(으)로 새 프로세스에서 시작했어요", parts.join(" · "))
    } else {
        format!(
            "{}(으)로 새 프로세스에서 시작했고, 진행 중이던 작업 {}개를 정리했어요",
            parts.join(" · "),
            n
        )
    }
}

/// `VecDeque`에서 슬라이스를 얻기 위한 보조.
trait Contig {
    fn make_contiguous_ref(&self) -> Vec<QueuedMessage>;
}
impl Contig for VecDeque<QueuedMessage> {
    fn make_contiguous_ref(&self) -> Vec<QueuedMessage> {
        self.iter().cloned().collect()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// T22 제품 배선 — stdout EOF가 **런타임 안에서** 원장을 거두는가
//
// 재생 하네스(`tests/replay*.rs`)는 `stream_died()`를 **직접 부른다**. 그래서 97개
// 시나리오가 초록인 채로 제품에는 진입점이 없었다(크리틱 배선 R1 §2-E/F). 여기서 재는
// 것은 그 진입점 하나다: 드라이버가 EOF를 값으로 올리면 `tick()`이 T22를 밟는가.
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod t22_tests {
    use super::*;
    use crate::clock::Clock;
    use crate::driver::SpawnSpec;
    use crate::identity::*;
    use std::collections::BTreeSet;

    #[derive(Default)]
    struct EofCli {
        eof: Option<CloseCause>,
        alive: bool,
        sent: Vec<Value>,
    }
    impl CliDriver for EofCli {
        fn spawn(&mut self, _spec: &SpawnSpec) -> std::io::Result<()> {
            self.alive = true;
            Ok(())
        }
        fn send(&mut self, line: Value) {
            self.sent.push(line);
        }
        fn close_input(&mut self) {}
        fn kill(&mut self) {
            self.alive = false;
        }
        fn process_alive(&self) -> bool {
            self.alive
        }
        fn stream_eof(&mut self) -> Option<CloseCause> {
            self.eof
        }
        fn poll_frames(&mut self, _now: Millis) -> Vec<Value> {
            vec![]
        }
    }

    struct Fixed;
    impl Clock for Fixed {
        fn now_ms(&self) -> Millis {
            1_000
        }
    }

    fn rt() -> ChatRuntime<EofCli> {
        let raw = RawIdentity {
            engine: RawEngine {
                kind: EngineKind::Claude,
                model: "haiku".into(),
                effort: EffortId::Minimal,
                codex_account: None,
            },
            billing: RawBilling {
                kind: BillingKind::Subscription,
                account: Some("a@x".into()),
                drop_env_key: Some(false),
            },
            cwd: r"C:\ccg-fixture\work".into(),
            add_dirs: vec![],
            mode: ModeId::Normal,
            system_prompt: None,
            output_style: None,
            tools: RawTools::default(),
        };
        let defaults = IdentityDefaults {
            known_accounts: BTreeSet::from(["a@x".to_string()]),
            ..Default::default()
        };
        ChatRuntime::new("c-1", raw, defaults, Arc::new(Fixed), EofCli::default()).expect("정규화")
    }

    /// 이 런타임이 CLI에 보낸 `initialize`의 `systemPrompt` 자리(없으면 `None`).
    fn init_append(rt: &ChatRuntime<EofCli>) -> Option<String> {
        let f = rt
            .driver
            .sent
            .iter()
            .find(|v| v["request"]["subtype"] == "initialize")
            .expect("initialize를 안 보냈다");
        f["request"]["systemPrompt"]["append"]
            .as_str()
            .map(str::to_string)
    }

    /// ★M10 R6 — **꺼짐이 진짜 꺼짐이다.**
    ///
    /// 대화 연결이 안 켜진 채팅의 `initialize` 프레임에는 `systemPrompt` 키가 아예 없다.
    /// (빈 문자열을 실으면 CLI가 `claude_code` 프리셋을 죽인다 — driver §4.2. 그래서
    /// 「없음」은 빈 값이 아니라 **키의 부재**여야 한다.)
    #[test]
    fn a_chat_without_a_talk_guide_changes_no_prompt_bytes() {
        let mut r = rt();
        r.dispatch(Cmd::Send { text: "안녕".into() });
        let f = r
            .driver
            .sent
            .iter()
            .find(|v| v["request"]["subtype"] == "initialize")
            .expect("initialize를 안 보냈다");
        assert!(
            f["request"].get("systemPrompt").is_none(),
            "꺼진 채팅에 systemPrompt 키가 실렸다: {f}"
        );
    }

    /// ★M10 R6 — **발신 배선.** 안내를 얹으면 그것이 실제로 CLI에 들어가고,
    /// 채팅별 추가 지시가 있으면 **둘 다** 들어간다.
    ///
    /// R5까지 이 인자는 두 호출처 모두 무조건 `None`이었다: 대화 연결을 켜도 프롬프트
    /// 바이트가 0 변했고(그래서 모델은 `@talk[…]` 통로가 있는지 몰랐다), `RunIdentity`의
    /// 채팅별 추가 지시도 Claude 쪽에서는 **한 번도 나간 적이 없었다**(Codex만
    /// `developerInstructions`로 실었다).
    #[test]
    fn the_talk_guide_actually_reaches_the_cli() {
        let mut r = rt();
        r.set_talk_guide(Some("[대화 연결] 2번 자리에게 말을 걸 수 있습니다.".into()));
        r.dispatch(Cmd::Send { text: "안녕".into() });
        let append = init_append(&r).expect("안내를 얹었는데 프레임에 안 실렸다");
        assert!(append.contains("[대화 연결]"), "안내가 안 들어갔다: {append}");

        // 채팅별 추가 지시와 **함께** 실린다(둘 중 하나가 다른 하나를 밀어내지 않는다).
        let id = r.identity().clone();
        let with_prompt =
            RunIdentity::normalize(id.to_raw().patched(&{
                let mut p = RawIdentityPatch::default();
                p.system_prompt = Some(Some("너는 코드 리뷰어다.".into()));
                p
            }), &r.defaults)
            .expect("정규화");
        let both = ChatRuntime::<EofCli>::append_prompt(
            &with_prompt,
            Some("[대화 연결] 안내"),
        )
        .expect("둘 다 있는데 None이다");
        assert!(both.contains("코드 리뷰어"), "채팅별 지시가 빠졌다: {both}");
        assert!(both.contains("[대화 연결]"), "대화 연결 안내가 빠졌다: {both}");
        // 아무것도 없으면 **키 자체가 없다**(빈 문자열이 아니다).
        assert_eq!(ChatRuntime::<EofCli>::append_prompt(&id, None), None);
        assert_eq!(ChatRuntime::<EofCli>::append_prompt(&id, Some("   ")), None, "공백은 없음이다");
    }

    /// ★M10 R6 — 보드를 끄면 **도는 CLI도 그것을 배워야 한다**.
    ///
    /// 안내는 정체성 밖(비영속)이라 `RunIdentity::diff`가 못 본다. 그런데 스폰 축이므로
    /// 재사용 판정이 이 값을 함께 봐야 한다 — 안 그러면 보드를 끈 뒤에도 상주 CLI는
    /// 계속 「@talk로 말을 걸 수 있다」고 알고 있다. 라우터가 `off`로 거절하니 나가지는
    /// 않지만, 모델에게 거짓을 가르친 채로 도는 것은 그 자체가 결함이다.
    #[test]
    fn turning_the_board_off_respawns_the_resident_cli() {
        let mut r = rt();
        r.set_talk_guide(Some("[대화 연결] 안내".into()));
        r.dispatch(Cmd::Send { text: "안녕".into() });
        // 상주로 올려 재사용 판정이 성립하게 한다.
        if let Some(s) = &mut r.stream {
            s.state = StateTag::Resident;
        }
        let want = r.identity().clone();
        assert_eq!(
            r.reuse_decision(&want, ThreadIntent::Continue),
            ReuseDecision::Reuse,
            "같은 안내인데 재스폰한다"
        );
        // 보드를 껐다 → 안내가 사라진다 → 이 프로세스는 낡은 것을 알고 있다.
        r.set_talk_guide(None);
        assert_eq!(
            r.reuse_decision(&want, ThreadIntent::Continue),
            ReuseDecision::Respawn {
                identity: vec![IdentityField::SystemPrompt],
                thread: false
            },
            "안내가 바뀌었는데 그대로 재사용한다"
        );
    }

    /// `Starting`→`Streaming`으로 올린 뒤 승인 카드를 세운다(공격 E의 자리).
    fn to_awaiting_user(rt: &mut ChatRuntime<EofCli>) {
        rt.dispatch(Cmd::Send { text: "안녕".into() });
        rt.on_frame(&json!({
            "type": "control_response",
            "response": { "subtype": "success", "request_id": "init-1", "response": {} }
        }));
        rt.on_frame(&json!({ "type": "system", "subtype": "init", "session_id": "S1", "model": "claude-haiku" }));
        assert_eq!(rt.state(), StateTag::Streaming, "T2까지 올라갔다");
        rt.on_frame(&json!({
            "type": "control_request", "request_id": "req-1",
            "request": { "subtype": "can_use_tool", "tool_name": "Write",
                         "tool_use_id": "toolu_1", "input": { "file_path": "a.txt" } }
        }));
        assert_eq!(rt.state(), StateTag::AwaitingUser);
        assert_eq!(rt.ledger().items().len(), 1, "AskCard가 원장에 있다");
    }

    #[test]
    fn stdout_eof_settles_the_ask_card_and_lands_idle() {
        let mut r = rt();
        to_awaiting_user(&mut r);
        let _ = r.drain_events();

        // CLI가 외부에서 죽었다 — 드라이버가 EOF를 값으로 올린다.
        r.driver().eof = Some(CloseCause::ExternalKill);
        r.tick();

        assert_eq!(r.state(), StateTag::Idle, "T22 → T25 → T26으로 내려온다");
        assert!(r.ledger().is_empty(), "파생 라이브 항목이 남으면 그게 유령 UI다");
        let evs = r.drain_events();
        let settled: Vec<_> = evs
            .iter()
            .filter_map(|e| match e {
                Event::Settled { id, reason, .. } => Some((id.to_string(), reason.wire())),
                _ => None,
            })
            .collect();
        assert_eq!(
            settled,
            vec![("req-1".to_string(), "stream_closed:externalkill".to_string())],
            "정착에 **사유가 실려야** 화면이 이유를 말할 수 있다"
        );
        assert!(
            evs.iter().any(|e| matches!(e, Event::Exit { cause: CloseCause::ExternalKill, .. })),
            "Exit(cause)가 셸까지 나가야 안내 문장을 만든다"
        );
        assert!(
            evs.iter().any(|e| matches!(e, Event::Status { status: TerminalStatus::Error, .. })),
            "종결 status 1회 보장(§5.3) — 이게 busy를 내린다"
        );
        assert!(r.fired().contains("T22"), "표의 T22를 실제로 밟았다");
    }

    #[test]
    fn eof_while_streaming_settles_too() {
        let mut r = rt();
        r.dispatch(Cmd::Send { text: "안녕".into() });
        r.on_frame(&json!({
            "type": "control_response",
            "response": { "subtype": "success", "request_id": "init-1", "response": {} }
        }));
        r.on_frame(&json!({ "type": "system", "subtype": "init", "session_id": "S1", "model": "claude-haiku" }));
        r.on_frame(&json!({
            "type": "assistant", "session_id": "S1",
            "message": { "role": "assistant", "content": [
                { "type": "tool_use", "id": "toolu_9", "name": "Bash", "input": { "command": "sleep 1" } }] }
        }));
        assert_eq!(r.ledger().items().len(), 1, "RunningTool이 원장에 있다");
        let _ = r.drain_events();

        r.driver().eof = Some(CloseCause::Crash);
        r.tick();
        assert_eq!(r.state(), StateTag::Idle);
        assert!(r.ledger().is_empty());
    }

    #[test]
    fn no_stream_no_t22() {
        // 스트림이 없을 때의 EOF는 **아무것도 아니다** — 유령 정착을 만들지 않는다.
        let mut r = rt();
        r.driver().eof = Some(CloseCause::CliExit);
        r.tick();
        assert_eq!(r.state(), StateTag::Idle);
        assert!(!r.fired().contains("T22"));
    }

    #[test]
    fn interrupted_turn_is_aborted_not_done() {
        // F11 — 사용자가 끊은 턴을 `Done`으로 적으면 재시작 뒤에도 "완료"로 남는다.
        let mut r = rt();
        to_awaiting_user(&mut r);
        r.dispatch(Cmd::Interrupt);
        assert_eq!(r.state(), StateTag::Interrupting);
        let _ = r.drain_events();
        r.on_frame(&json!({
            "type": "result", "subtype": "error_during_execution", "is_error": false,
            "result": "", "terminal_reason": "aborted_by_user", "session_id": "S1"
        }));
        let evs = r.drain_events();
        let statuses: Vec<_> = evs
            .iter()
            .filter_map(|e| match e {
                Event::Status { status, .. } => Some(*status),
                _ => None,
            })
            .collect();
        assert_eq!(statuses, vec![TerminalStatus::Aborted], "중단은 Done이 아니다: {statuses:?}");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 부팅 재장전 (§5.8 부팅 경로 2단계) + 스펙 ⑤ 자동/수동 발사
//
// R2까지 이 경로는 **없었다**(§R2.8-B: "재시작 후 자동 이어서가 조용히 안 산다").
// 여기서 재는 것 셋: ① 재장전이 큐·대기표를 세우되 **아무것도 보내지 않는다**
// ② 대기표가 풀리면 그때 이어진다 ③ 화면 밖 채팅은 `ready`만 켜고 멈춘다.
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod reload_tests {
    use super::*;
    use crate::clock::VirtualClock;
    use crate::driver::SpawnSpec;
    use crate::identity::*;
    use std::collections::BTreeSet;

    #[derive(Default)]
    struct QuietCli {
        alive: bool,
        spawns: usize,
    }
    impl CliDriver for QuietCli {
        fn spawn(&mut self, _spec: &SpawnSpec) -> std::io::Result<()> {
            self.alive = true;
            self.spawns += 1;
            Ok(())
        }
        fn send(&mut self, _line: Value) {}
        fn close_input(&mut self) {}
        fn kill(&mut self) {
            self.alive = false;
        }
        fn process_alive(&self) -> bool {
            self.alive
        }
        fn poll_frames(&mut self, _now: Millis) -> Vec<Value> {
            vec![]
        }
    }

    fn rt(clock: Arc<VirtualClock>) -> ChatRuntime<QuietCli> {
        let raw = RawIdentity {
            engine: RawEngine {
                kind: EngineKind::Claude,
                model: "haiku".into(),
                effort: EffortId::Minimal,
                codex_account: None,
            },
            billing: RawBilling {
                kind: BillingKind::Subscription,
                account: Some("a@x".into()),
                drop_env_key: Some(false),
            },
            cwd: r"C:\ccg-fixture\work".into(),
            add_dirs: vec![],
            mode: ModeId::Normal,
            system_prompt: None,
            output_style: None,
            tools: RawTools::default(),
        };
        let defaults = IdentityDefaults {
            known_accounts: BTreeSet::from(["a@x".to_string()]),
            ..Default::default()
        };
        ChatRuntime::new("c-1", raw, defaults, clock, QuietCli::default()).expect("정규화")
    }

    #[test]
    fn reload_restores_the_queue_and_hold_without_sending_anything() {
        let clock = VirtualClock::new();
        clock.advance_to(10 * SEC);
        let mut r = rt(clock.clone());
        r.reload_state(
            vec!["예약1".into(), "예약2".into()],
            Some(ReloadHold { in_ms: Some(60 * SEC), ready: false, ..Default::default() }),
        );
        assert_eq!(r.queue_len(), 2, "예약이 살아 있다");
        assert!(r.hold().is_some(), "대기표가 재장전됐다");
        assert_eq!(r.driver_ref().spawns, 0, "앱을 켜는 것은 '보내라'가 아니다");
        assert!(r.sent_user_texts().is_empty());
        // 대기표가 게이트를 닫고 있으므로 tick 몇 번으로도 안 나간다.
        clock.advance_by(30 * SEC);
        r.tick();
        assert_eq!(r.driver_ref().spawns, 0);
    }

    #[test]
    fn a_released_hold_resumes_the_reloaded_queue() {
        let clock = VirtualClock::new();
        clock.advance_to(10 * SEC);
        let mut r = rt(clock.clone());
        r.reload_state(
            vec!["예약1".into()],
            Some(ReloadHold { in_ms: Some(60 * SEC), ready: false, ..Default::default() }),
        );
        // resets_at = 재장전 시각(10s) + 남은 60s = 70s. due_at = +90s(§7.3 재검증 지연).
        clock.advance_to(10 * SEC + 60 * SEC + 91 * SEC);
        r.tick();
        assert!(r.hold().is_none(), "소진된 대기표는 사라진다");
        assert_eq!(r.driver_ref().spawns, 1, "해제되면 그때 이어진다");
        assert_eq!(
            r.sent_user_texts().first().map(String::as_str),
            Some("이어서 진행해 주세요"),
            "재개 항목이 큐 맨 앞에 들어간다: {:?}",
            r.sent_user_texts()
        );
        assert_eq!(r.queue_len(), 1, "예약분은 이 턴이 끝난 뒤 순서대로 나간다");
    }

    #[test]
    fn an_off_screen_chat_turns_ready_but_does_not_fire() {
        // 스펙 ⑤ — "보이는 자리 + 열린 창 = 자동 / 나머지 = ready만 표시".
        let clock = VirtualClock::new();
        clock.advance_to(10 * SEC);
        let mut r = rt(clock.clone());
        r.set_auto_resume(false);
        r.reload_state(
            vec!["예약1".into()],
            Some(ReloadHold { in_ms: Some(60 * SEC), ready: false, ..Default::default() }),
        );
        clock.advance_to(10 * SEC + 60 * SEC + 91 * SEC);
        r.tick();
        let hold = r.hold().cloned().expect("대기표는 남는다");
        assert!(hold.ready, "풀렸다는 표식은 켠다(사이드바 초록 점)");
        assert_eq!(r.driver_ref().spawns, 0, "화면 밖 6개가 동시에 토큰을 쓰기 시작하면 안 된다");
        assert!(r.sent_user_texts().is_empty());
        // 예약분도 혼자 나가지 않는다 — 게이트는 `ready && auto_resume`다.
        clock.advance_by(10 * MIN);
        r.tick();
        assert_eq!(r.driver_ref().spawns, 0);

        // 사용자가 누르면 그때 발사.
        assert_eq!(r.resume_now(), Verdict::Accepted);
        assert!(r.hold().is_none());
        assert_eq!(r.driver_ref().spawns, 1);
    }

    #[test]
    fn resume_now_on_a_chat_without_a_ready_hold_is_a_rejection_not_a_send() {
        let clock = VirtualClock::new();
        let mut r = rt(clock.clone());
        r.reload_state(vec!["예약1".into()], None);
        assert_eq!(r.resume_now(), Verdict::Rejected("hold_not_ready"));
        assert_eq!(r.driver_ref().spawns, 0, "누른 것이 예약분을 대신 쏘면 안 된다");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ★R4 — 큐 이관(§6.1 `chat:queue-mutate` op 3종 · 첨부 · picker 스냅샷)과
//        **재개 단일 소유**(m-logic P6 / M-UX R2.9의 재현 축), 그리고 스폰 IO 오류.
//
// 여기서 잠그는 것 넷:
//  ① `enqueue`가 `{text, images, picker}`를 잃지 않는다 — 드레인이 그 값으로 나간다.
//  ② `remove`/`reorder`는 **드레인을 깨우지 않는다**(§7.4: 큐를 만진 것이 곧 전송이면 위험하다).
//  ③ 한 번의 한도 해제에 재개 발화는 **정확히 1회**다 — 대기 중 걸린 메시지가 있으면
//     기계의 나팔("이어서 진행해 주세요")을 넣지 않는다.
//  ④ `claude.exe`가 없으면 **그 자리에서** SpawnFailed로 정착한다(20초 침묵 금지).
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod r4_queue_and_resume_tests {
    use super::*;
    use crate::clock::VirtualClock;
    use crate::driver::SpawnSpec;
    use crate::identity::*;
    use std::collections::BTreeSet;

    #[derive(Default)]
    struct Cli {
        alive: bool,
        spawns: usize,
        fail: bool,
    }
    impl CliDriver for Cli {
        fn spawn(&mut self, _spec: &SpawnSpec) -> std::io::Result<()> {
            self.spawns += 1;
            if self.fail {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "그런 파일이 없습니다",
                ));
            }
            self.alive = true;
            Ok(())
        }
        fn send(&mut self, _line: Value) {}
        fn close_input(&mut self) {}
        fn kill(&mut self) {
            self.alive = false;
        }
        fn process_alive(&self) -> bool {
            self.alive
        }
        fn poll_frames(&mut self, _now: Millis) -> Vec<Value> {
            vec![]
        }
    }

    fn rt(clock: Arc<VirtualClock>) -> ChatRuntime<Cli> {
        let raw = RawIdentity {
            engine: RawEngine {
                kind: EngineKind::Claude,
                model: "haiku".into(),
                effort: EffortId::Minimal,
                codex_account: None,
            },
            billing: RawBilling {
                kind: BillingKind::Subscription,
                account: Some("a@x".into()),
                drop_env_key: Some(false),
            },
            cwd: r"C:\ccg-fixture\work".into(),
            add_dirs: vec![],
            mode: ModeId::Normal,
            system_prompt: None,
            output_style: None,
            tools: RawTools::default(),
        };
        let defaults = IdentityDefaults {
            known_accounts: BTreeSet::from(["a@x".to_string()]),
            ..Default::default()
        };
        ChatRuntime::new("c-1", raw, defaults, clock, Cli::default()).expect("정규화")
    }

    fn qin(text: &str) -> QueueInput {
        QueueInput::text(text)
    }

    // ── ① 첨부·picker가 살아남는다 ────────────────────────────────────────
    #[test]
    fn an_enqueued_message_keeps_its_images_and_picker() {
        let clock = VirtualClock::new();
        let mut r = rt(clock.clone());
        // 턴 하나를 띄워 두 번째 예약이 **주차**되게 한다(Idle이면 곧장 나간다).
        r.dispatch(Cmd::Send { text: "첫 턴".into() });
        assert_eq!(r.state(), StateTag::Starting);

        let mut pick = RawIdentityPatch::default();
        pick.engine.model = Some("opus".into());
        pick.mode = Some(ModeId::Plan);
        let v = r.dispatch(Cmd::Enqueue(QueueInput {
            text: "이 그림 봐줘".into(),
            images: vec![r"C:\shot\a.png".into(), r"C:\shot\b.png".into()],
            picker: Some(pick),
            origin: None,
            require_picker: false,
        }));
        assert_eq!(v, Verdict::Queued);

        let item = r.queue_items().next().expect("예약 1건");
        assert_eq!(item.attachments.len(), 2, "첨부가 통째로 사라지던 자리다");
        assert_eq!(item.identity.model(), "opus", "예약 시점 picker로 나간다");
        assert_eq!(item.identity.mode(), ModeId::Plan);
        // 채팅 자체의 정체성은 **안 바뀐다** — 예약이 설정을 몰래 갈지 않는다.
        assert_eq!(r.identity().model(), "haiku");
        assert_eq!(r.identity().mode(), ModeId::Normal);
    }

    #[test]
    fn attachments_are_folded_into_the_prompt_when_it_drains() {
        let clock = VirtualClock::new();
        let mut r = rt(clock.clone());
        r.dispatch(Cmd::Enqueue(QueueInput {
            text: "이 그림 봐줘".into(),
            images: vec![r"C:\shot\a.png".into()],
            picker: None,
            origin: None,
            require_picker: false,
        }));
        // Idle에서의 enqueue는 곧장 나간다(명령표 `enqueue`/Idle = Accept T27).
        let sent = r.sent_user_texts().join("\n");
        assert!(sent.starts_with("이 그림 봐줘"), "원문이 앞에 온다: {sent}");
        assert!(sent.contains(r"- C:\shot\a.png"), "첨부 노트가 붙는다: {sent}");
        assert!(sent.contains("[첨부 파일"), "2.6.2 promptWithNotes 파리티: {sent}");
    }

    #[test]
    fn a_plain_send_is_byte_identical_to_before() {
        // 첨부가 없으면 본문은 한 글자도 안 바뀐다(옛 경로 무영향).
        let clock = VirtualClock::new();
        let mut r = rt(clock.clone());
        r.dispatch(Cmd::Send { text: "그냥 문장".into() });
        assert_eq!(r.sent_user_texts(), vec!["그냥 문장".to_string()]);
    }

    // ── ② remove / reorder / clear ────────────────────────────────────────
    fn parked(r: &mut ChatRuntime<Cli>, texts: &[&str]) {
        r.dispatch(Cmd::Send { text: "첫 턴".into() });
        for t in texts {
            assert_eq!(r.dispatch(Cmd::Enqueue(qin(t))), Verdict::Queued);
        }
    }

    #[test]
    fn remove_takes_exactly_one_item_and_never_drains() {
        let clock = VirtualClock::new();
        let mut r = rt(clock.clone());
        parked(&mut r, &["A", "B", "C"]);
        let ids: Vec<String> = r.queue_items().map(|m| m.id.clone()).collect();
        let before = r.driver_ref().spawns;
        assert_eq!(
            r.dispatch(Cmd::QueueMutate(QueueOp::Remove { id: ids[1].clone() })),
            Verdict::Accepted
        );
        assert_eq!(r.queue_texts(), vec!["A".to_string(), "C".to_string()]);
        assert_eq!(
            r.driver_ref().spawns,
            before,
            "큐를 만진 것이 곧 전송이면 안 된다(§7.4)"
        );
        // 없는 id는 **조용히 성공하지 않는다**(D7 — 침묵 no-op 금지).
        assert_eq!(
            r.dispatch(Cmd::QueueMutate(QueueOp::Remove { id: "q-없음".into() })),
            Verdict::Rejected("no_item")
        );
    }

    #[test]
    fn reorder_keeps_the_items_the_renderer_did_not_mention() {
        let clock = VirtualClock::new();
        let mut r = rt(clock.clone());
        parked(&mut r, &["A", "B", "C"]);
        let ids: Vec<String> = r.queue_items().map(|m| m.id.clone()).collect();
        // 낡은 목록(C·A만 안다)으로 재정렬 — B가 사라지면 안 된다.
        assert_eq!(
            r.dispatch(Cmd::QueueMutate(QueueOp::Reorder {
                ids: vec![ids[2].clone(), ids[0].clone()]
            })),
            Verdict::Accepted
        );
        assert_eq!(
            r.queue_texts(),
            vec!["C".to_string(), "A".to_string(), "B".to_string()]
        );
        assert_eq!(r.driver_ref().spawns, 1, "재정렬이 전송을 깨우지 않는다");
    }

    #[test]
    fn clear_leaves_an_undo_token_and_restore_puts_them_back() {
        let clock = VirtualClock::new();
        let mut r = rt(clock.clone());
        parked(&mut r, &["A", "B"]);
        let _ = r.drain_events();
        assert_eq!(
            r.dispatch(Cmd::QueueMutate(QueueOp::Clear)),
            Verdict::Accepted
        );
        assert_eq!(r.queue_len(), 0);
        let token = r
            .drain_events()
            .into_iter()
            .find_map(|e| match e {
                Event::QueueCleared { undo_token, .. } => Some(undo_token),
                _ => None,
            })
            .expect("되돌리기 토큰");
        assert_eq!(r.dispatch(Cmd::QueueRestore { token }), Verdict::Accepted);
        assert_eq!(r.queue_texts(), vec!["A".to_string(), "B".to_string()]);
        // 빈 큐를 또 비우는 것은 무동작이다(사유가 있는 무동작 — 침묵이 아니다).
        r.dispatch(Cmd::QueueMutate(QueueOp::Clear));
        assert_eq!(r.dispatch(Cmd::QueueMutate(QueueOp::Clear)), Verdict::Noop);
    }

    // ── ③ 재개 단일 소유 ──────────────────────────────────────────────────
    /// 재현 축(M-UX R2.9): 한도 사망 → 재시작 → 리셋 도달 → **전송이 한 번인가 두 번인가**.
    /// 얼려 둔 렌더러의 `useLimitResume`이 Rust보다 먼저 쏘면 그 프롬프트가 게이트에
    /// 주차된다. 그 뒤 Rust가 나팔을 앞에 끼우면 한 번의 해제에 두 턴이 나갔다.
    #[test]
    fn a_message_parked_during_the_hold_is_the_resume_no_second_turn() {
        let clock = VirtualClock::new();
        clock.advance_to(10 * SEC);
        let mut r = rt(clock.clone());
        r.reload_state(
            vec![],
            Some(ReloadHold {
                in_ms: Some(60 * SEC),
                ready: false,
                ..Default::default()
            }),
        );
        // 렌더러(또는 사용자)가 대기 중에 재개 프롬프트를 보낸다 → 게이트가 주차한다.
        clock.advance_by(5 * SEC);
        assert_eq!(
            r.dispatch(Cmd::Send {
                text: "사용 한도가 초기화됐어. 직전에 하던 작업을 이어서 계속해줘.".into()
            }),
            Verdict::Accepted
        );
        assert_eq!(r.driver_ref().spawns, 0, "대기표가 게이트를 닫고 있다");
        assert_eq!(r.queue_len(), 1);

        clock.advance_to(10 * SEC + 60 * SEC + 91 * SEC);
        r.tick();
        assert!(r.hold().is_none());
        assert_eq!(
            r.sent_user_texts(),
            vec!["사용 한도가 초기화됐어. 직전에 하던 작업을 이어서 계속해줘.".to_string()],
            "★ 재개 발화는 정확히 1회 — 기계의 나팔이 앞에 끼지 않는다"
        );
        assert_eq!(r.queue_len(), 0);
        assert_eq!(r.driver_ref().spawns, 1);
    }

    #[test]
    fn resume_now_with_a_parked_message_sends_that_message_once() {
        let clock = VirtualClock::new();
        clock.advance_to(10 * SEC);
        let mut r = rt(clock.clone());
        r.set_auto_resume(false);
        r.reload_state(
            vec![],
            Some(ReloadHold {
                in_ms: Some(60 * SEC),
                ready: false,
                ..Default::default()
            }),
        );
        clock.advance_by(5 * SEC);
        r.dispatch(Cmd::Send {
            text: "내가 건 재개".into(),
        });
        clock.advance_to(10 * SEC + 60 * SEC + 91 * SEC);
        r.tick();
        assert!(
            r.hold().is_some_and(|h| h.ready),
            "화면 밖 채팅은 ready만 켠다"
        );
        assert_eq!(r.resume_now(), Verdict::Accepted);
        assert_eq!(r.sent_user_texts(), vec!["내가 건 재개".to_string()]);
        assert_eq!(r.driver_ref().spawns, 1);
    }

    #[test]
    fn a_queue_that_predates_the_hold_still_gets_the_nudge() {
        // §7.3의 규약은 그대로다 — 표가 걸리기 **전에** 쌓인 예약은 재개가 아니다
        // (재생 #4가 잠근 동작. `>` 비교가 그 경계다).
        let clock = VirtualClock::new();
        clock.advance_to(10 * SEC);
        let mut r = rt(clock.clone());
        r.reload_state(
            vec![qin("표보다 먼저 선 예약")],
            Some(ReloadHold {
                in_ms: Some(60 * SEC),
                ready: false,
                ..Default::default()
            }),
        );
        clock.advance_to(10 * SEC + 60 * SEC + 91 * SEC);
        r.tick();
        assert_eq!(
            r.sent_user_texts().first().map(String::as_str),
            Some("이어서 진행해 주세요"),
            "재장전된 예약은 '대기 중에 건 재개'가 아니다: {:?}",
            r.sent_user_texts()
        );
    }

    // ── ④ 스폰 IO 오류 ────────────────────────────────────────────────────
    #[test]
    fn a_missing_cli_settles_at_once_not_after_twenty_seconds() {
        let clock = VirtualClock::new();
        let mut r = rt(clock.clone());
        r.driver().fail = true;
        let _ = r.drain_events();
        r.dispatch(Cmd::Send {
            text: "안녕".into(),
        });
        // R3까지는 여기서 `Starting`이었고 T3(20초)까지 아무 말도 없었다.
        assert_eq!(r.state(), StateTag::Idle, "그 자리에서 정착한다");
        let evs = r.drain_events();
        assert!(
            evs.iter()
                .any(|e| matches!(e, Event::Exit { cause: CloseCause::SpawnFailed, .. })),
            "SpawnFailed로 닫힌다: {evs:?}"
        );
        assert!(
            evs.iter()
                .any(|e| matches!(e, Event::Notice(t) if t.contains("엔진을 시작하지 못했어요"))),
            "사유 한 줄이 화면으로 나간다: {evs:?}"
        );
        assert!(
            r.sent_user_texts().is_empty(),
            "못 뜬 프로세스에 프롬프트를 적어 두지 않는다"
        );
        // 다음 전송이 막히지 않는다(래치가 남으면 채팅이 굳는다).
        r.driver().fail = false;
        r.dispatch(Cmd::Send {
            text: "다시".into(),
        });
        assert_eq!(r.state(), StateTag::Starting);
        assert_eq!(r.sent_user_texts(), vec!["다시".to_string()]);
    }
}
