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
use crate::frames::{ask_kind_of, classify_task_type, is_limit_error, Frame};
use crate::identity::{
    resolve_fallback_conflicts, ApplyPolicy, FallbackArm, FallbackVia, IdentityDefaults,
    IdentityError, IdentityField, IdentityRejectReason, PendingOp, RawIdentity, RawIdentityPatch,
    RunIdentity, Staged,
};
use crate::ids::{ChatId, FrameSeq, LiveId, RunId, StreamId};
use crate::live::{
    AskInfo, AskKind, CloseCause, Confidence, Gating, LiveItem, LiveKind, LiveLedger, Liveness,
    ProbeSource, SettleReason, StreamGuard, SHELL_TURN_GRACE,
};
use crate::queue::{
    drain_plan, LimitHold, OnDrift, QueueOrigin, QueueUndo, QueuedMessage, ThreadIntent,
};
use crate::state::{command_cell, Cell as TCell, ResidentWhy, StateTag, StreamClosePolicy};
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
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

#[derive(Debug, Clone)]
pub enum Cmd {
    Send { text: String },
    Enqueue { text: String },
    Interrupt,
    StopAll,
    QueueRestore { token: String },
    Respond { kind: AskKind, request_id: String, accept: bool },
    BgStop { id: LiveId },
    BgBackground,
    IdentitySet { patch: RawIdentityPatch, policy: ApplyPolicy, op: PendingOp },
    IdentityRevert { to: u32 },
    QueueMutate,
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
            Cmd::Enqueue { .. } => "enqueue",
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
            Cmd::QueueMutate => "queue.mutate",
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
    pub cwd_at_bind: Option<String>,
    pub forked_from: Option<String>,
    pub fork_consumed: bool,
    /// `/btw` 등으로 "다음 send는 새 스레드"가 예약된 상태.
    pub want_fresh: bool,
}

struct Turn {
    run_id: RunId,
    turn_ended: bool,
    saw_turn_activity: bool,
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
            cli_path: std::path::PathBuf::from("claude.exe"),
            home: std::path::PathBuf::from("C:\\ccg-fixture\\home\\.agentcodegui"),
            account_dir_override: None,
            fired: RefCell::new(Default::default()),
            suspend_drain: false,
            task_by_tool_use: Default::default(),
            sent_user_texts: vec![],
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
    pub fn hold(&self) -> Option<&LimitHold> {
        self.hold.as_ref()
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
            Cmd::Send { text } | Cmd::Enqueue { text } => match verdict {
                Verdict::Accepted => {
                    let m = self.make_queue_item(text, QueueOrigin::User, now);
                    self.queue.push_back(m);
                    self.broadcast_queue();
                    self.drain_if_possible();
                    Verdict::Accepted
                }
                Verdict::Queued => {
                    let m = self.make_queue_item(text, QueueOrigin::User, now);
                    self.queue.push_back(m);
                    self.broadcast_queue();
                    Verdict::Queued
                }
                v => v,
            },
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
                    let m = self.make_queue_item("/compact".into(), QueueOrigin::User, now);
                    self.queue.push_back(m);
                    self.drain_if_possible();
                }
                verdict
            }
            _ => verdict,
        }
    }

    fn make_queue_item(&mut self, text: String, origin: QueueOrigin, now: Millis) -> QueuedMessage {
        let id = format!("q{}", self.next_qid);
        self.next_qid += 1;
        QueuedMessage {
            id,
            text,
            attachments: vec![],
            identity: self.identity.clone(),
            identity_rev: self.revision,
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
        let idiff = s.spawn_identity.diff(want);
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
        let _ = self.driver.spawn(&spec);
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
        self.driver.send(initialize_request("init-1", None));
        self.send_user(&m.text.clone());
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
        self.send_user(&m.text.clone());
        self.set_state("T16", StateTag::Streaming, None);
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
        if let Some(t) = &mut s.turn {
            if !t.sent_terminal_status {
                t.sent_terminal_status = true;
                self.emit(Event::Status {
                    run_id: t.run_id,
                    status: TerminalStatus::Error,
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
            if self.hold.as_ref().is_some_and(|h| !h.ready) {
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
        if let Some(s) = &mut self.stream {
            if let Some(t) = &mut s.turn {
                t.turn_ended = true;
                if !t.sent_terminal_status {
                    t.sent_terminal_status = true;
                    let status = TerminalStatus::Done;
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

        let drainable = !self.queue.is_empty() && self.hold.as_ref().is_none_or(|h| h.ready);
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
        let payload = match kind {
            AskKind::Permission => {
                if accept {
                    json!({ "behavior": "allow" })
                } else {
                    json!({ "behavior": "deny", "message": "거부" })
                }
            }
            AskKind::Question => json!({ "behavior": "allow" }),
            AskKind::Dialog => json!({ "accepted": accept }),
        };
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
                    if let Some(to) = ask.tool_use_id.clone() {
                        // 픽스처는 dialog에 대상 모델을 tool_use_id 자리에 싣는다(합성 규약).
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
                    if let Some(it) = it {
                        self.settle_emit(&it, SettleReason::Completed);
                    }
                    self.mark_activity();
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
                    self.arm_hold(resets_at.map(|s| s * 1000));
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
        if !self.queue.is_empty() && self.hold.as_ref().is_none_or(|h| h.ready) {
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
        if is_error {
            if let Some(t) = &error_text {
                if is_limit_error(t) {
                    self.arm_hold(None);
                }
            }
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

    fn arm_hold(&mut self, resets_at: Option<Millis>) {
        self.fire("T30");
        let run = self
            .stream
            .as_ref()
            .and_then(|s| s.turn.as_ref().map(|t| t.run_id))
            .unwrap_or(RunId(0));
        let now = self.now();
        self.hold = Some(LimitHold {
            account: self.identity.billing().clone(),
            // reset 시각을 모를 때(2순위 근거 = 문구 분류)는 **5분 뒤 재검증**한다.
            // 2.6.2 `useLimitResume`도 신선 usage를 주기적으로 다시 물어 판정했다.
            resets_at: Some(resets_at.unwrap_or(now + 5 * MIN)),
            verified_at: None,
            ready: false,
            armed_from_run: run,
        });
        self.emit(Event::Notice("사용 한도에 걸려 대기합니다".into()));
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
                self.driver
                    .send(initialize_request(&format!("probe-{pid}"), None));
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
        let due = self
            .hold
            .as_ref()
            .filter(|h| !h.ready)
            .and_then(|h| h.due_at())
            .is_some_and(|d| now >= d);
        if !due {
            return;
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
        if let Some(h) = &mut self.hold {
            h.ready = true;
            h.verified_at = Some(now);
        }
        // 재개 항목의 정체성 = **지금 값**(§7.3), onDrift=use_current.
        let mut m = self.make_queue_item("이어서 진행해 주세요".into(), QueueOrigin::LimitResume, now);
        m.on_drift = OnDrift::UseCurrent;
        self.queue.push_front(m);
        self.broadcast_plan();
        self.hold = None;
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
