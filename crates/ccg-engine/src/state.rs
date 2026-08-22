//! D3 — 명시적 상태기계. **전이는 데이터(표)이고 코드가 표를 소비한다.**
//! (`docs/design/m-logic.md` §3.3 A 38행 · §3.3-B B 22행 · §3.6 명령표 23×8 · §3.7 사영표 24행)
//!
//! 왜 표인가: 2.6.2의 규약(소프트 중단·무음 보류·통지 재주입·상주·5s 유예·compact)은
//! 전부 **주석과 if문 사이**에 흩어져 있었다. 표로 올리면 ① 전이 추가가 표 한 행이 되고
//! ② "표에는 있는데 테스트가 없는 줄"을 커버리지 게이트가 구조적으로 잡는다.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StateTag {
    Idle,
    Starting,
    Streaming,
    AwaitingUser,
    HeldResult,
    Interrupting,
    Resident,
    Terminating,
    /// `Ended`는 명령을 받지 않는다 — T26이 같은 tick에서 `Idle`로 내보낸다(§3.6 8열 각주).
    Ended,
}

impl StateTag {
    /// UI busy(전송 게이트용) — **원시 상태**다. 표시용 `effectiveStatus`와 다르다(§3.2).
    pub fn busy(self) -> bool {
        matches!(
            self,
            StateTag::Starting
                | StateTag::Streaming
                | StateTag::AwaitingUser
                | StateTag::HeldResult
                | StateTag::Interrupting
        )
    }
    /// 명령표의 열 인덱스(8열). `Ended`는 열이 없다.
    pub fn col(self) -> Option<usize> {
        Some(match self {
            StateTag::Idle => 0,
            StateTag::Starting => 1,
            StateTag::Streaming => 2,
            StateTag::AwaitingUser => 3,
            StateTag::HeldResult => 4,
            StateTag::Interrupting => 5,
            StateTag::Resident => 6,
            StateTag::Terminating => 7,
            StateTag::Ended => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResidentWhy {
    /// 원장에 항목이 있다 → 표시는 '작업 중'.
    LiveItems,
    /// 원장이 **워치독 추정 정착으로** 비었다 → '진행 상태 불명' + [엔진 정리].
    Unverified,
    Linger,
    KeepOpen,
}

/// §3.4-b — 종료 정책이 **명시 축**이어야 실와이어 픽스처(`keep_open` 조건에서 채집)와
/// 출하 기본값(`on_idle`)을 같은 SUT로 재생할 수 있다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamClosePolicy {
    /// 출하 기본값. 원장 비면 즉시 `close_input()`(2.6.2 `maybeCloseInput` 파리티).
    OnIdle,
    /// 원장 비어도 ms 동안 stdin 유지. `Linger(0)`은 §3.4의 「드레인 보류」 자리다.
    Linger(crate::clock::Millis),
    /// 명시 종료까지 유지 — 재생 하네스 전용.
    KeepOpen,
}

impl Default for StreamClosePolicy {
    fn default() -> Self {
        StreamClosePolicy::OnIdle
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// A. 수명 전이 38행 (§3.3)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    /// C — 렌더러 명령
    Cmd(&'static str),
    /// F — CLI 프레임
    Frame(&'static str),
    /// W — 워치독/타이머
    Watchdog(&'static str),
    /// X — 외부 사건(프로세스/OS)
    External(&'static str),
}

pub struct TransitionSpec {
    pub id: &'static str,
    pub from: &'static [StateTag],
    pub trigger: Trigger,
    pub guard: &'static str,
    /// 표의 To 열 그대로(문자열) — `§3.4`처럼 판정지로 가는 행이 있어 열거형이 아니다.
    pub to: &'static str,
    pub note: &'static str,
}

use StateTag as S;
const ANY: &[StateTag] = &[
    S::Idle,
    S::Starting,
    S::Streaming,
    S::AwaitingUser,
    S::HeldResult,
    S::Interrupting,
    S::Resident,
    S::Terminating,
];
const ANY_LIVE: &[StateTag] = &[
    S::Starting,
    S::Streaming,
    S::AwaitingUser,
    S::HeldResult,
    S::Interrupting,
    S::Resident,
    S::Terminating,
];

pub static LIFECYCLE: &[TransitionSpec] = &[
    TransitionSpec { id: "T1",   from: &[S::Idle],        trigger: Trigger::Cmd("send|drain"),  guard: "hold 없음 ∧ 정규화 성공", to: "Starting",    note: "정체성 확정 → job 등록 → spawn → initialize → 첫 user 프레임" },
    TransitionSpec { id: "T2",   from: &[S::Starting],    trigger: Trigger::Frame("control_response(initialize)+system/init"), guard: "-", to: "Streaming", note: "session_id 채택(id 변화만 새 세션)" },
    TransitionSpec { id: "T3",   from: &[S::Starting],    trigger: Trigger::Watchdog("20s"),    guard: "-", to: "Terminating{SpawnFailed}", note: "notice + status:error, 원장 비어 있음" },
    TransitionSpec { id: "T4",   from: &[S::Streaming],   trigger: Trigger::Frame("can_use_tool|request_user_dialog"), guard: "-", to: "AwaitingUser", note: "AskCard 등록(소유=StreamId)" },
    TransitionSpec { id: "T5",   from: &[S::AwaitingUser],trigger: Trigger::Cmd("respond_*"),   guard: "request_id가 이 스트림 것", to: "Streaming", note: "control_response 송신(toolUseID 항상 동봉), 카드 Answered. dialog 수락은 폴백 리비전" },
    TransitionSpec { id: "T6",   from: &[S::AwaitingUser],trigger: Trigger::Frame("control_cancel_request"), guard: "-", to: "Streaming", note: "카드 Withdrawn — CLI가 회수" },
    TransitionSpec { id: "T7",   from: &[S::Streaming],   trigger: Trigger::Frame("result"),    guard: "턴 활동 ∨ 결과 텍스트", to: "§3.4", note: "result + 종결 status 1회, finish_wrap()" },
    TransitionSpec { id: "T8",   from: &[S::Streaming],   trigger: Trigger::Frame("result"),    guard: "무음", to: "HeldResult", note: "종결 보류, 재장전 0" },
    TransitionSpec { id: "T9",   from: &[S::HeldResult],  trigger: Trigger::Frame("활동 프레임"), guard: "-", to: "Streaming", note: "보류 취소, 미니턴 오판 복구" },
    TransitionSpec { id: "T10",  from: &[S::HeldResult],  trigger: Trigger::Watchdog("2.5s"),   guard: "재장전<8", to: "HeldResult", note: "슬라이딩 재장전. ★설계와 의도적 어긋남(보고서 §7 #9): 설계 가드는 '재장전<8 ∧ (프레임 흘렀음 ∨ delivered_notifs 있음)'인데 그대로 넣으면 **아무 프레임도 안 온 무음 보류가 첫 2.5s에 무너진다**(T11 즉시). 무음 보류의 존재 이유가 사라지므로 앞항만 채택" },
    TransitionSpec { id: "T11",  from: &[S::HeldResult],  trigger: Trigger::Watchdog("재장전 소진"), guard: "delivered_notifs 비었음", to: "§3.4", note: "무음 턴 정착 + notice(silent)" },
    TransitionSpec { id: "T12",  from: &[S::HeldResult],  trigger: Trigger::Watchdog("만료"),   guard: "delivered_notifs 있음 ∧ 활동 없음 ∧ replayed_once=false ∧ 중단 요청 없음", to: "Streaming", note: "프롬프트 재주입(같은 턴 연장). ★R2 — '중단 요청 없음'이 R1 표에서 빠져 있었다(크리틱 C6): 중단 뒤 CLI가 고아 통지로 깬 턴에 기계가 다시 프롬프트를 밀어 넣던 자리다. '활동 없음'은 HeldResult 진입 조건(T8)이 이미 보장한다" },
    TransitionSpec { id: "T13",  from: &[S::Streaming, S::AwaitingUser, S::HeldResult], trigger: Trigger::Cmd("interrupt"), guard: "-", to: "Interrupting", note: "카드 전부 해제 → 큐 비움+undo+hold 해제 → control_request{interrupt}" },
    TransitionSpec { id: "T14",  from: &[S::Interrupting],trigger: Trigger::Frame("result(aborted_*)"), guard: "≤6s", to: "§3.4", note: "interrupted 마커, 재주입 금지 표식" },
    TransitionSpec { id: "T15",  from: &[S::Interrupting],trigger: Trigger::Watchdog("6s 무응답"), guard: "-", to: "Terminating{HardCancel}", note: "하드 강등" },
    TransitionSpec { id: "T16",  from: &[S::Resident],    trigger: Trigger::Cmd("send"),        guard: "정체성 일치 ∧ 스레드 연속", to: "Streaming", note: "주입: 같은 stdin에 user 프레임, 새 run_id" },
    TransitionSpec { id: "T17",  from: &[S::Resident],    trigger: Trigger::Cmd("send"),        guard: "정체성 불일치", to: "Terminating→T1", note: "stream_close{IdentityChanged{리프 diff}} 예고 + 원장 정착" },
    TransitionSpec { id: "T18",  from: &[S::Resident],    trigger: Trigger::Cmd("send"),        guard: "스레드 불일치", to: "Terminating→T1", note: "stream_close{ThreadChanged} — 사유가 T17과 다르다" },
    TransitionSpec { id: "T19",  from: &[S::Resident],    trigger: Trigger::Frame("user(<task-notification>)"), guard: "-", to: "Streaming", note: "CLI 자발 기상 턴 — **새 run_id**" },
    TransitionSpec { id: "T19b", from: &[S::Resident],    trigger: Trigger::Frame("메인경로 활동(선행 user 없음)"), guard: "saw_turn_activity", to: "Streaming", note: "정리 턴 재개 — 새 run_id(불변식 3)" },
    TransitionSpec { id: "T20",  from: &[S::Resident],    trigger: Trigger::Frame("background_tasks_changed(빈 REPLACE)"), guard: "비었음 ∧ pending_settles 없음 ∧ confidence=Observed ∧ OnIdle", to: "Terminating{AllClear}", note: "close_input() — CLI가 직접 말한 빔" },
    TransitionSpec { id: "T20b", from: &[S::Resident],    trigger: Trigger::Frame("background_tasks_changed(빈 REPLACE)"), guard: "같은 가드 ∧ Linger{ms}", to: "Resident{Linger}", note: "타이머만 건다(T33 대기)" },
    TransitionSpec { id: "T21",  from: &[S::Resident],    trigger: Trigger::Watchdog("리스 만료+Unknown+hard_limit"), guard: "-", to: "Resident{Unverified}", note: "Watchdog{probe:none} 정착. **close_input 안 함**(추정)" },
    TransitionSpec { id: "T21b", from: &[S::Resident],    trigger: Trigger::Watchdog("능동 프로브 Dead"), guard: "-", to: "Resident(→F13이 T20)", note: "Watchdog{probe:active} 즉시 — **관측된** 정착" },
    TransitionSpec { id: "T22",  from: ANY_LIVE,          trigger: Trigger::External("stdout EOF|exit"), guard: "-", to: "Terminating{StreamClosed}", note: "원장 일괄 정착 — StreamGuard::drop, 스킵 불가" },
    TransitionSpec { id: "T23",  from: ANY_LIVE,          trigger: Trigger::Cmd("stop_all"),    guard: "-", to: "Terminating{Cancelled}", note: "큐 비움+undo+hold 해제 → interrupt(1.5s) → close_input → kill" },
    TransitionSpec { id: "T24",  from: ANY,               trigger: Trigger::External("app_quit"), guard: "-", to: "Terminating{AppQuit}", note: "아무것도 기다리지 않는다. job object가 손자까지 보증" },
    TransitionSpec { id: "T25",  from: &[S::Terminating], trigger: Trigger::External("exit|kill 상한"), guard: "원장 비었음", to: "Ended", note: "스트림 해제, run_boundary 로그" },
    TransitionSpec { id: "T26",  from: &[S::Ended],       trigger: Trigger::Watchdog("즉시"),   guard: "-", to: "Idle", note: "pending_identity 있으면 적용" },
    TransitionSpec { id: "T27",  from: &[S::Idle],        trigger: Trigger::Watchdog("큐 있음"), guard: "hold 없음", to: "Starting", note: "큐 head의 **정체성 스냅샷**으로 T1" },
    TransitionSpec { id: "T28",  from: &[S::Streaming],   trigger: Trigger::Frame("system/compact_boundary"), guard: "-", to: "Streaming", note: "compact_pending 버퍼(다음 assistant와 짝맞춤)" },
    TransitionSpec { id: "T29",  from: &[S::Streaming],   trigger: Trigger::Frame("model_refusal_fallback|message.model 변화"), guard: "메인 경로 ∧ §6.2가 '리비전 생성'", to: "Streaming", note: "정체성 자동 리비전 + 배너 + 되돌리기" },
    TransitionSpec { id: "T30",  from: &[S::Streaming],   trigger: Trigger::Frame("rate_limit blocked|result 한도"), guard: "-", to: "§3.4", note: "hold 장전 — 큐 게이트만" },
    TransitionSpec { id: "T31",  from: &[S::Resident, S::Idle], trigger: Trigger::Cmd("identity_set"), guard: "적용 가능", to: "같은 상태", note: "정체성 교체 + 리비전. Resident면 재스폰 비용 예고" },
    TransitionSpec { id: "T32",  from: &[S::Resident],    trigger: Trigger::Watchdog("stream_idle_limit 6h"), guard: "턴 없음", to: "Terminating{IdleReclaim}", note: "행한 CLI의 마지막 탈출구. ★설계와 의도적 어긋남(보고서 §7 #10): 설계 From은 `Resident{Unverified|Policy}`인데 `StateTag`가 `why`를 안 들고 다녀 표현할 수 없다. 실질 무해 — 6h 전에 T21이 Unverified로 내린다" },
    TransitionSpec { id: "T33",  from: &[S::Resident],    trigger: Trigger::Watchdog("linger 만료"), guard: "원장·큐 비었음", to: "Terminating{AllClear}", note: "close_input()" },
    TransitionSpec { id: "T34",  from: &[S::Starting],    trigger: Trigger::Cmd("interrupt|stop_all"), guard: "-", to: "Terminating{Cancelled}", note: "spawn 취소. 정착할 항목 없음. 큐는 T13과 동일" },
    TransitionSpec { id: "T35",  from: &[S::Resident],    trigger: Trigger::Cmd("interrupt"),   guard: "-", to: "Resident{LiveItems|Unverified}", note: "턴 없음 → interrupt 미송신. stop_task N회 + 큐 비움 + 결과 통지" },
];

// ─────────────────────────────────────────────────────────────────────────────
// B. 프레임 소화 전이 22행 (§3.3-B) — 상태는 그대로, 원장·회계만 바뀐다
// ─────────────────────────────────────────────────────────────────────────────

pub struct FrameSpec {
    pub id: &'static str,
    pub frame: &'static str,
    pub states: &'static str,
    pub action: &'static str,
    /// 리스 효과(§5.4) — 이 열이 워치독의 증거 등급과 1:1이다.
    pub lease: &'static str,
}

pub static FRAME_DIGEST: &[FrameSpec] = &[
    FrameSpec { id: "F1",  frame: "system/init 재도착", states: "Streaming|Resident", action: "session_id 같으면 아무것도 안 한다(★ 'init=새 세션' 판정 금지)", lease: "없음" },
    FrameSpec { id: "F2",  frame: "stream_event text_delta(메인)", states: "Streaming", action: "StreamingMsg 열기/이어붙임, saw_turn_activity=true", lease: "스트림" },
    FrameSpec { id: "F3",  frame: "stream_event thinking_delta", states: "Streaming", action: "Thinking 갱신(90자)", lease: "스트림" },
    FrameSpec { id: "F4",  frame: "stream_event content_block_start:tool_use", states: "Streaming", action: "Thinking{도구 라벨}", lease: "스트림" },
    FrameSpec { id: "F5",  frame: "stream_event(사이드체인)", states: "임의", action: "즉시 버림(완성 프레임만 쓴다)", lease: "스트림만" },
    FrameSpec { id: "F6",  frame: "assistant text(메인)", states: "Streaming", action: "StreamingMsg 정착 + Thinking 해제", lease: "스트림" },
    FrameSpec { id: "F7",  frame: "assistant tool_use(메인)", states: "Streaming", action: "RunningTool 원장 등록(+첫 도구에서 status:working)", lease: "항목 생성" },
    FrameSpec { id: "F8",  frame: "assistant(사이드체인)", states: "임의", action: "부모 Subagent 카드 activity 한 줄 — 메인 경로 오염 금지", lease: "부모 재장전" },
    FrameSpec { id: "F9",  frame: "assistant.message.usage", states: "Streaming", action: "컨텍스트 게이지 + compact 짝맞춤", lease: "스트림" },
    FrameSpec { id: "F10", frame: "assistant.message.model 변화", states: "Streaming", action: "§6.2 합류 규약으로 분기(T29 또는 미러만)", lease: "스트림" },
    FrameSpec { id: "F11", frame: "user tool_result(메인)", states: "Streaming", action: "RunningTool 정착 + file-change/terminal 가공", lease: "항목 정착" },
    FrameSpec { id: "F12", frame: "user <task-notification>", states: "Streaming", action: "delivered_notifs 적재(T12 재주입 재료)", lease: "해당 항목 재장전" },
    FrameSpec { id: "F13", frame: "system/background_tasks_changed(REPLACE)", states: "Streaming|AwaitingUser|HeldResult|Resident", action: "원장 재조정: 목록에 있고 원장에 없으면 생성(task_type 3분류), 원장에 있고 목록에 없으면 pending_settles로", lease: "멤버십 = 최상위 증거(①a)" },
    FrameSpec { id: "F14", frame: "system/task_started", states: "Streaming", action: "tool_use_id → task_id 매핑 등록", lease: "항목 생성/예약" },
    FrameSpec { id: "F15", frame: "system/task_progress + workflow_progress", states: "Streaming|Resident", action: "Workflow 항목 생성/갱신(스냅샷 전체 교체)", lease: "하트비트 = Alive(③)" },
    FrameSpec { id: "F16", frame: "system/task_progress(workflow_progress 없음)", states: "Streaming|Resident", action: "보드로 승격 안 함. 그러나 원장에선 버리지 않는다", lease: "하트비트 = Alive(③)" },
    FrameSpec { id: "F17", frame: "system/task_notification", states: "Streaming|Resident", action: "정착 에지. by_user면 즉시 제거, 아니면 pending_settles + wf_notify_seq", lease: "항목 정착(증거 있는)" },
    FrameSpec { id: "F18", frame: "system/notification·informational", states: "임의", action: "notice 통과. 상태·원장 무영향", lease: "스트림" },
    FrameSpec { id: "F19", frame: "rate_limit_event(allowed)", states: "임의", action: "resets_at·type만 기록. hold 장전 아님", lease: "스트림" },
    FrameSpec { id: "F20", frame: "stderr 줄", states: "임의", action: "terminal{muted}", lease: "없음(★ stderr는 증거가 아니다)" },
    FrameSpec { id: "F21", frame: "미지 type/subtype", states: "임의", action: "조용히 버린다 + 로그 1줄", lease: "스트림" },
    FrameSpec { id: "F22", frame: "control_request hook_callback|mcp_message|elicitation|oauth_*", states: "임의", action: "프로토콜 §4.4 (c)~(f) 자동 응답. UI 카드로 안 올린다", lease: "스트림" },
];

// ─────────────────────────────────────────────────────────────────────────────
// §3.6 명령 허용표 23×8 — **빈칸 없음**(D7 침묵 no-op 금지)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cell {
    /// ✅ 즉시 수행 (+ 대응 전이 id)
    Accept(&'static str),
    /// 📥 큐에 넣고 그 사실을 UI에 표시
    Queue,
    /// ⏳ 예약 적용
    Defer(&'static str),
    /// ⚠️ 확인 카드(비용을 문장으로)
    Confirm(&'static str),
    /// ⛔ 거부 + 사유 문자열
    Reject(&'static str),
}

pub struct CommandRow {
    pub cmd: &'static str,
    /// [Idle, Starting, Streaming, AwaitingUser, HeldResult, Interrupting, Resident, Terminating]
    pub cells: [Cell; 8],
}

use Cell::*;

pub static COMMANDS: &[CommandRow] = &[
    CommandRow { cmd: "send", cells: [Accept("T1"), Queue, Queue, Queue, Queue, Queue, Accept("T16|T17|T18"), Queue] },
    CommandRow { cmd: "enqueue", cells: [Accept("T27"), Queue, Queue, Queue, Queue, Queue, Queue, Queue] },
    CommandRow { cmd: "interrupt", cells: [Reject("nothing_running"), Accept("T34"), Accept("T13"), Accept("T13"), Accept("T13"), Reject("already_interrupting"), Accept("T35"), Reject("ending")] },
    CommandRow { cmd: "stop_all", cells: [Reject("nothing_running"), Accept("T34"), Accept("T23"), Accept("T23"), Accept("T23"), Accept("T23"), Accept("T23"), Reject("already_ending")] },
    CommandRow { cmd: "queue.restore", cells: [Accept("-"), Accept("-"), Accept("-"), Accept("-"), Accept("-"), Accept("-"), Accept("-"), Accept("-")] },
    CommandRow { cmd: "respond_permission", cells: [Reject("no_card"), Reject("no_card"), Reject("no_card"), Accept("T5"), Reject("no_card"), Reject("interrupting"), Reject("no_card"), Reject("ending")] },
    CommandRow { cmd: "respond_question", cells: [Reject("no_card"), Reject("no_card"), Reject("no_card"), Accept("T5"), Reject("no_card"), Reject("interrupting"), Reject("no_card"), Reject("ending")] },
    CommandRow { cmd: "respond_dialog", cells: [Reject("no_card"), Reject("no_card"), Reject("no_card"), Accept("T5"), Reject("no_card"), Reject("interrupting"), Reject("no_card"), Reject("ending")] },
    CommandRow { cmd: "bg_task.stop", cells: [Reject("no_stream"), Reject("no_stream"), Accept("-"), Accept("-"), Accept("-"), Accept("-"), Accept("-"), Reject("ending")] },
    CommandRow { cmd: "bg_task.background", cells: [Reject("no_stream"), Reject("no_stream"), Accept("-"), Accept("-"), Accept("-"), Reject("interrupting"), Reject("no_foreground_tool"), Reject("ending")] },
    CommandRow { cmd: "identity_set", cells: [Accept("T31"), Defer("turn_end"), Defer("turn_end"), Defer("turn_end"), Defer("turn_end"), Defer("turn_end"), Accept("T31"), Defer("next_stream")] },
    CommandRow { cmd: "identity_set.cancel", cells: [Reject("no_pending"), Accept("-"), Accept("-"), Accept("-"), Accept("-"), Accept("-"), Reject("no_pending"), Accept("-")] },
    CommandRow { cmd: "identity_revert", cells: [Accept("T31"), Defer("turn_end"), Defer("turn_end"), Defer("turn_end"), Defer("turn_end"), Defer("turn_end"), Accept("T31"), Defer("next_stream")] },
    CommandRow { cmd: "queue.mutate", cells: [Accept("-"), Accept("-"), Accept("-"), Accept("-"), Accept("-"), Accept("-"), Accept("-"), Accept("-")] },
    CommandRow { cmd: "hold.cancel", cells: [Accept("-"), Accept("-"), Accept("-"), Accept("-"), Accept("-"), Accept("-"), Accept("-"), Accept("-")] },
    CommandRow { cmd: "clear", cells: [Accept("-"), Accept("T34"), Accept("T23"), Accept("T23"), Accept("T23"), Accept("T23"), Accept("T23"), Defer("next_stream")] },
    CommandRow { cmd: "switch_chat", cells: [Accept("-"), Accept("-"), Accept("-"), Accept("-"), Accept("-"), Accept("-"), Accept("-"), Accept("-")] },
    CommandRow { cmd: "new_chat", cells: [Accept("-"), Accept("-"), Accept("-"), Accept("-"), Accept("-"), Accept("-"), Accept("-"), Accept("-")] },
    CommandRow { cmd: "delete_chat", cells: [Accept("-"), Confirm("run_in_flight"), Confirm("run_in_flight"), Confirm("run_in_flight"), Confirm("run_in_flight"), Confirm("run_in_flight"), Confirm("bg_alive"), Accept("-")] },
    CommandRow { cmd: "fork_btw", cells: [Accept("-"), Accept("-"), Accept("-"), Accept("-"), Accept("-"), Accept("-"), Accept("-"), Accept("-")] },
    CommandRow { cmd: "compact", cells: [Accept("T1"), Queue, Queue, Queue, Queue, Queue, Accept("T16"), Queue] },
    CommandRow { cmd: "force_settle", cells: [Accept("-"), Accept("-"), Accept("-"), Accept("-"), Accept("-"), Accept("-"), Accept("-"), Accept("-")] },
    CommandRow { cmd: "dispose", cells: [Accept("-"), Accept("-"), Confirm("run_in_flight"), Confirm("run_in_flight"), Confirm("run_in_flight"), Confirm("run_in_flight"), Confirm("bg_alive"), Accept("-")] },
];

/// 명령표 조회. `Ended`는 열이 없다(T26이 같은 tick에 Idle로 내보낸다).
pub fn command_cell(cmd: &str, state: StateTag) -> Option<Cell> {
    let col = state.col()?;
    COMMANDS
        .iter()
        .find(|r| r.cmd == cmd)
        .map(|r| r.cells[col])
}

/// 전이 조회 — 표에 없는 전이를 코드가 발화하면 여기서 걸린다.
pub fn transition(id: &str) -> Option<&'static TransitionSpec> {
    LIFECYCLE.iter().find(|t| t.id == id)
}

/// §3.7 사영표 — 설계 §3.7 **표 그대로 32행**(§8.4 매핑 28행 = 1b·4b·10b·22b 포함 + 와이어 4행).
/// **빈칸이 하나라도 있으면 그 프레임은 진입점이 없다** = P8 계열 버그의 씨앗.
///
/// ★R2(크리틱 C8): R1 주석은 *"§8.4의 24행 + 와이어 4행"*이라 적었다. 24는 설계 **산문**의
/// 수이고 같은 절의 **표**는 28행이다(설계 자체의 불일치). 코드는 표를 따랐으므로 32가 맞고,
/// 틀린 것은 주석뿐이었다.
pub static PROJECTION_8_4: &[(&str, &[&str])] = &[
    ("system/init (첫 도착)", &["T2"]),
    ("system/init (재도착)", &["F1"]),
    ("stream_event text_delta", &["F2"]),
    ("stream_event thinking_delta", &["F3"]),
    ("stream_event content_block_start:tool_use", &["F4"]),
    ("stream_event (사이드체인)", &["F5"]),
    ("assistant text", &["F6"]),
    ("assistant tool_use", &["F7"]),
    ("assistant (사이드체인)", &["F8"]),
    ("assistant.message.usage", &["F9", "T28"]),
    ("assistant.message.model 변화", &["F10", "T29"]),
    ("user tool_result", &["F11"]),
    ("user <task-notification>", &["T19", "F12"]),
    ("result", &["T7", "T8", "T14"]),
    ("system/compact_boundary", &["T28"]),
    ("system/model_refusal_fallback", &["T29"]),
    ("system/notification", &["F18"]),
    ("system/informational", &["F18"]),
    ("system/background_tasks_changed", &["F13", "T20", "T20b"]),
    ("system/task_progress", &["F15", "F16"]),
    ("system/task_started", &["F14"]),
    ("system/task_notification", &["F17"]),
    ("control_request can_use_tool", &["T4"]),
    ("can_use_tool (AskUserQuestion)", &["T4"]),
    ("control_request request_user_dialog", &["T4", "T5"]),
    ("control_cancel_request", &["T6"]),
    ("stderr 줄", &["F20"]),
    ("스트림 이상 종료", &["T22", "T25", "T26"]),
    // §8.4에 없지만 와이어에 있는 것
    ("rate_limit_event(allowed)", &["F19"]),
    ("rate_limit_event(blocked · 미관측)", &["T30"]),
    ("control_request (c)~(f)", &["F22"]),
    ("미지 type/subtype", &["F21"]),
];

/// 표가 아는 전이 id 전체 = 38 + 22 = **60**.
pub fn all_transition_ids() -> Vec<&'static str> {
    LIFECYCLE
        .iter()
        .map(|t| t.id)
        .chain(FRAME_DIGEST.iter().map(|f| f.id))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_sizes_match_design() {
        assert_eq!(LIFECYCLE.len(), 38, "A 수명 전이 38행(§3.3)");
        assert_eq!(FRAME_DIGEST.len(), 22, "B 프레임 소화 22행(§3.3-B)");
        assert_eq!(all_transition_ids().len(), 60, "총 전이 60");
        assert_eq!(COMMANDS.len(), 23, "명령표 23행(§3.6)");
    }

    #[test]
    fn transition_ids_are_unique() {
        let mut ids = all_transition_ids();
        ids.sort();
        let n = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), n, "전이 id 중복");
    }

    #[test]
    fn projection_has_no_blank_and_only_known_transitions() {
        let known = all_transition_ids();
        for (frame, ts) in PROJECTION_8_4 {
            assert!(!ts.is_empty(), "사영표 빈칸: {frame}");
            for t in *ts {
                assert!(known.contains(t), "{frame} → 모르는 전이 {t}");
            }
        }
        // §8.4 24행 + 와이어 전용 4행
        assert_eq!(PROJECTION_8_4.len(), 32);
    }

    #[test]
    fn command_table_cells_reference_known_transitions() {
        for row in COMMANDS {
            for (i, c) in row.cells.iter().enumerate() {
                if let Cell::Accept(t) = c {
                    if *t == "-" {
                        continue;
                    }
                    for id in t.split('|') {
                        assert!(
                            transition(id).is_some(),
                            "{}[{}] → 모르는 전이 {id}",
                            row.cmd,
                            i
                        );
                    }
                }
            }
        }
    }
}
