//! D8/D9 — 라이브 항목 원장 + 워치독 프로브 등급 + 스킵 불가 정착(`StreamGuard`).
//! (`docs/design/m-logic.md` §5)
//!
//! 핵심 재배치: **원장의 색인 키는 `StreamId`**다. "내가 최신 실행인가"(2.6.2
//! `activeRunId === runId`)를 물을 필요가 없으므로 스트림이 어떻게 끝나든 정착이 옳다(P9·P8b).

use crate::clock::{Millis, MIN, SEC};
use crate::event::{Event, EventSink, LiveWire, SettledWire};
use crate::identity::IdentityField;
use crate::ids::{LiveId, RunId, StreamId};
use serde::Serialize;
use std::cell::{Cell, RefCell};
use std::rc::Rc;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LiveKind {
    Workflow,
    BgShell,
    BgAgent,
    Subagent,
    AskCard,
    RunningTool,
    CmdCard,
    StreamingMsg,
    Thinking,
    PendingSettle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Liveness {
    Observed,
    Unverified,
    Settling,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Gating {
    /// 확인 카드(⚠️)까지만 낼 수 있다.
    MayWarn,
    /// 절대 막지 못한다. 표시만.
    NeverBlocks,
}

/// 원장이 **관측으로** 비었나, **추정으로** 비었나 — `close_input` 여부를 가른다(§5.4-c 규약 3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Confidence {
    Observed,
    Unverified,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CloseCause {
    CliExit,
    Crash,
    AppQuit,
    ExternalKill,
    AllClear,
    Cancelled,
    HardCancel,
    IdleReclaim,
    SpawnFailed,
    IdentityChanged,
    ThreadChanged,
}

/// 어느 프로브가 정착을 판정했나. `Active`(⑥이 Dead라 말함 = **관측**) vs `None`(**추정**).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProbeSource {
    Active,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SettleReason {
    Completed,
    Failed { message: String },
    Stopped { by_user: bool },
    /// 턴 종료 정리(백그라운드 셸 5s 유예 착지) — "끝남"이 아니라 "턴이 끝나서 정리됨".
    TurnEnded,
    IdentityChanged { diff: Vec<IdentityField> },
    ThreadChanged,
    Cancelled,
    StreamClosed { cause: CloseCause },
    Watchdog { probe: ProbeSource },
    /// `PendingSettle` 전용 — 완료 통지를 10분 안에 못 받아 마감(2.6.2 `engine.ts:731` 파리티).
    NotifyTimeout,
    ForcedByUser,
}

impl SettleReason {
    /// 표시 규약(§5.2): `Completed`만 "완료". 나머지는 "정리됨" + 사유 부제.
    pub fn is_completion(&self) -> bool {
        matches!(self, SettleReason::Completed)
    }
    pub fn wire(&self) -> String {
        match self {
            SettleReason::Completed => "completed".into(),
            SettleReason::Failed { .. } => "failed".into(),
            SettleReason::Stopped { by_user } => format!("stopped:by_user={by_user}"),
            SettleReason::TurnEnded => "turn_ended".into(),
            SettleReason::IdentityChanged { diff } => format!(
                "identity_changed:[{}]",
                diff.iter().map(|f| f.path()).collect::<Vec<_>>().join(",")
            ),
            SettleReason::ThreadChanged => "thread_changed".into(),
            SettleReason::Cancelled => "cancelled".into(),
            SettleReason::StreamClosed { cause } => {
                format!("stream_closed:{}", format!("{cause:?}").to_lowercase())
            }
            SettleReason::Watchdog { probe } => match probe {
                ProbeSource::Active => "watchdog:active".into(),
                ProbeSource::None => "watchdog:none".into(),
            },
            SettleReason::NotifyTimeout => "notify_timeout".into(),
            SettleReason::ForcedByUser => "forced_by_user".into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AskKind {
    Permission,
    Question,
    Dialog,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AskInfo {
    pub ask_kind: AskKind,
    /// **매칭 키**(`protocol-claude-cli.md` §4.4a). `tool_use_id`는 동봉만 한다.
    pub request_id: String,
    pub tool_use_id: Option<String>,
    pub dialog_kind: Option<String>,
}

// ── 리스 상수 (전부 첫 숫자다 — O7/O16/O18이 열려 있다) ─────────────────────────
pub const LEASE_WORKFLOW: Millis = 90 * SEC;
pub const LEASE_BG_SHELL: Millis = 90 * SEC;
pub const LEASE_BG_AGENT: Millis = 10 * MIN;
pub const LEASE_PENDING_SETTLE: Millis = 10 * MIN;
pub const HARD_WORKFLOW: Millis = 30 * MIN;
pub const HARD_BG_SHELL: Millis = 30 * MIN;
pub const HARD_BG_AGENT: Millis = 60 * MIN;
pub const HARD_PENDING_SETTLE: Millis = 10 * MIN;
/// 턴 종료 직후 CLI가 백그라운드 bash를 정리하는 유예(2.6.2 관측치 — O7 미실측).
pub const SHELL_TURN_GRACE: Millis = 5 * SEC;

impl LiveKind {
    /// 리스를 가진 종류만 워치독의 대상이다 = `evidence_bearing()`(§5.4-c).
    pub fn lease(self) -> Option<Millis> {
        match self {
            LiveKind::Workflow => Some(LEASE_WORKFLOW),
            LiveKind::BgShell => Some(LEASE_BG_SHELL),
            LiveKind::BgAgent => Some(LEASE_BG_AGENT),
            LiveKind::PendingSettle => Some(LEASE_PENDING_SETTLE),
            _ => None,
        }
    }
    pub fn hard_limit(self) -> Option<Millis> {
        match self {
            LiveKind::Workflow => Some(HARD_WORKFLOW),
            LiveKind::BgShell => Some(HARD_BG_SHELL),
            LiveKind::BgAgent => Some(HARD_BG_AGENT),
            LiveKind::PendingSettle => Some(HARD_PENDING_SETTLE),
            _ => None,
        }
    }
    pub fn default_gating(self) -> Gating {
        match self {
            // 정착을 기다리는 **회계** 항목이지 사용자가 볼 작업이 아니다(N12).
            LiveKind::PendingSettle => Gating::NeverBlocks,
            _ => Gating::MayWarn,
        }
    }
    /// 중지 명령(`stop_task`)을 보낼 수 있는 종류 — T35가 쓴다.
    pub fn is_stoppable(self) -> bool {
        matches!(self, LiveKind::Workflow | LiveKind::BgShell | LiveKind::BgAgent)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveItem {
    pub id: LiveId,
    pub kind: LiveKind,
    /// ★ 소유자는 스트림. run_id 아님(P9).
    pub owner: StreamId,
    pub born_run: RunId,
    pub label: String,
    pub liveness: Liveness,
    pub lease_until: Millis,
    pub last_evidence: Millis,
    pub gating: Gating,
    /// 백그라운드 셸의 턴종료 5s 유예 — 이 안에 목록에서 빠지면 사유가 `TurnEnded`다.
    pub grace_until: Option<Millis>,
    pub ask: Option<AskInfo>,
}

impl LiveItem {
    pub fn new(
        id: impl Into<LiveId>,
        kind: LiveKind,
        owner: StreamId,
        born_run: RunId,
        label: impl Into<String>,
        now: Millis,
    ) -> LiveItem {
        let lease = kind.lease().unwrap_or(0);
        LiveItem {
            id: id.into(),
            kind,
            owner,
            born_run,
            label: label.into(),
            liveness: Liveness::Observed,
            lease_until: now + lease,
            last_evidence: now,
            gating: kind.default_gating(),
            grace_until: None,
            ask: None,
        }
    }
    pub fn rearm(&mut self, now: Millis) {
        self.last_evidence = now;
        self.lease_until = now + self.kind.lease().unwrap_or(0);
        self.liveness = Liveness::Observed;
    }
    pub fn wire(&self) -> LiveWire {
        LiveWire {
            id: self.id.clone(),
            kind: self.kind,
            label: self.label.clone(),
            liveness: self.liveness,
            gating: self.gating,
            born_run: self.born_run,
            ask: self.ask.as_ref().map(|a| crate::event::AskWire {
                ask_kind: a.ask_kind,
                request_id: a.request_id.clone(),
                tool_use_id: a.tool_use_id.clone(),
                dialog_kind: a.dialog_kind.clone(),
            }),
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 프로브 등급 — "무슨 판정을 낼 자격이 있는가"를 타입이 고정한다 (§5.4-b)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeVerdict {
    Alive,
    Dead,
    Unknown,
}

pub trait Probe {
    const CAN_SAY_ALIVE: bool;
    const CAN_SAY_DEAD: bool;
    const NAME: &'static str;
}

/// 등급 밖 판정을 **컴파일 시점에** 막는다(단상화 시 const 평가).
struct AssertAlive<P: Probe>(std::marker::PhantomData<P>);
impl<P: Probe> AssertAlive<P> {
    const OK: () = assert!(P::CAN_SAY_ALIVE, "이 프로브는 Alive를 낼 자격이 없다");
}
struct AssertDead<P: Probe>(std::marker::PhantomData<P>);
impl<P: Probe> AssertDead<P> {
    const OK: () = assert!(P::CAN_SAY_DEAD, "이 프로브는 Dead를 낼 자격이 없다");
}

impl ProbeVerdict {
    pub fn alive<P: Probe>() -> ProbeVerdict {
        let () = AssertAlive::<P>::OK;
        ProbeVerdict::Alive
    }
    pub fn dead<P: Probe>() -> ProbeVerdict {
        let () = AssertDead::<P>::OK;
        ProbeVerdict::Dead
    }
}

/// ⓪ CLI 프로세스 생존 — **Alive를 절대 못 낸다.** P8의 정의가 "프로세스는 살아 있다"이다.
pub struct ProcessAliveProbe;
impl Probe for ProcessAliveProbe {
    const CAN_SAY_ALIVE: bool = false;
    const CAN_SAY_DEAD: bool = true;
    const NAME: &'static str = "process_alive";
}
/// ①a 그 항목을 **지목한** 프레임.
pub struct NamedFrameProbe;
impl Probe for NamedFrameProbe {
    const CAN_SAY_ALIVE: bool = true;
    const CAN_SAY_DEAD: bool = false;
    const NAME: &'static str = "named_frame";
}
/// ①b 스트림 프레임 흐름(`PendingSettle` 전용).
pub struct StreamFlowProbe;
impl Probe for StreamFlowProbe {
    const CAN_SAY_ALIVE: bool = true;
    const CAN_SAY_DEAD: bool = false;
    const NAME: &'static str = "stream_flow";
}
/// ③ `task_progress` 하트비트.
pub struct HeartbeatProbe;
impl Probe for HeartbeatProbe {
    const CAN_SAY_ALIVE: bool = true;
    const CAN_SAY_DEAD: bool = false;
    const NAME: &'static str = "heartbeat";
}
/// ④ 파일 mtime(전사·outputFile·subagents/**).
pub struct MtimeProbe;
impl Probe for MtimeProbe {
    const CAN_SAY_ALIVE: bool = true;
    const CAN_SAY_DEAD: bool = false;
    const NAME: &'static str = "mtime";
}
/// ⑥ 능동 프로브 — `initialize` 재전송. **Alive/Dead 둘 다 낼 자격이 있는 유일한 프로브.**
pub struct ActiveInitProbe;
impl Probe for ActiveInitProbe {
    const CAN_SAY_ALIVE: bool = true;
    const CAN_SAY_DEAD: bool = true;
    const NAME: &'static str = "active_init";
}

// ─────────────────────────────────────────────────────────────────────────────
// 원장
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Default)]
pub struct LiveLedger {
    items: Vec<LiveItem>,
    pub confidence: Confidence,
    /// ★R3 리셋 규약이 있는 플래그(§5.4-c). 리셋이 없으면 다음 턴의 정상적인 빔에도
    /// "워치독으로 비었다"가 붙어 `close_input`이 영원히 막힌다.
    pub last_removal_was_watchdog: bool,
}

impl Default for Confidence {
    fn default() -> Self {
        Confidence::Observed
    }
}

impl LiveLedger {
    pub fn items(&self) -> &[LiveItem] {
        &self.items
    }
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
    pub fn len(&self) -> usize {
        self.items.len()
    }
    pub fn get(&self, id: &str) -> Option<&LiveItem> {
        self.items.iter().find(|i| i.id == id)
    }
    pub fn get_mut(&mut self, id: &str) -> Option<&mut LiveItem> {
        self.items.iter_mut().find(|i| i.id == id)
    }
    pub fn has(&self, id: &str) -> bool {
        self.items.iter().any(|i| i.id == id)
    }
    pub fn insert(&mut self, item: LiveItem) {
        // 신규 항목 = 원장이 관측으로 채워졌다 → 플래그 리셋(§5.4-c 리셋 규약).
        self.last_removal_was_watchdog = false;
        self.confidence = Confidence::Observed;
        if let Some(slot) = self.items.iter_mut().find(|i| i.id == item.id) {
            *slot = item;
        } else {
            self.items.push(item);
        }
    }
    pub fn remove(&mut self, id: &str, watchdog_guess: bool) -> Option<LiveItem> {
        let idx = self.items.iter().position(|i| i.id == id)?;
        let it = self.items.remove(idx);
        self.last_removal_was_watchdog = watchdog_guess;
        Some(it)
    }
    pub fn kinds_count(&self) -> Vec<(LiveKind, usize)> {
        let mut out: Vec<(LiveKind, usize)> = vec![];
        for i in &self.items {
            match out.iter_mut().find(|(k, _)| *k == i.kind) {
                Some((_, c)) => *c += 1,
                None => out.push((i.kind, 1)),
            }
        }
        out
    }
    /// 리스를 가진 항목만. 턴 수명 항목은 **스트림 종속**이라 워치독이 손대지 않는다
    /// (그래서 4분짜리 Bash가 도는 조용한 턴이 오판되지 않는다).
    pub fn evidence_bearing(&self) -> Vec<LiveId> {
        self.items
            .iter()
            .filter(|i| i.kind.lease().is_some())
            .map(|i| i.id.clone())
            .collect()
    }
    pub fn owned_by(&self, s: StreamId) -> Vec<LiveId> {
        self.items
            .iter()
            .filter(|i| i.owner == s)
            .map(|i| i.id.clone())
            .collect()
    }
    pub fn drain_owned_by(&mut self, s: StreamId) -> Vec<LiveItem> {
        let mut out = vec![];
        let mut keep = vec![];
        for i in self.items.drain(..) {
            if i.owner == s {
                out.push(i);
            } else {
                keep.push(i);
            }
        }
        self.items = keep;
        out
    }
    pub fn snapshot(&self) -> Vec<LiveWire> {
        self.items.iter().map(|i| i.wire()).collect()
    }
    /// 게이팅을 실제로 낼 수 있는 항목 — `liveness == Observed` ∧ `MayWarn`(§5.5 규칙 1).
    pub fn gating_blockers(&self) -> Vec<LiveId> {
        self.items
            .iter()
            .filter(|i| i.liveness == Liveness::Observed && i.gating == Gating::MayWarn)
            .map(|i| i.id.clone())
            .collect()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// StreamGuard — 스킵 불가 정착 (§5.3)
// ─────────────────────────────────────────────────────────────────────────────

/// 스트림이 어떻게 끝나든(정상·에러·패닉·취소·앱종료) 이 `Drop`이 **그 스트림의** 원장을 비운다.
/// 조건부 정리(`if activeRunId === runId`)는 존재하지 않는다 — 색인이 `StreamId`이기 때문이다.
pub struct StreamGuard {
    pub id: StreamId,
    ledger: Rc<RefCell<LiveLedger>>,
    sink: Rc<RefCell<EventSink>>,
    cause: Rc<Cell<CloseCause>>,
    now: Rc<Cell<Millis>>,
    /// 이미 이유를 붙여 정착시킨 뒤라면(T17/T18의 예고 정착) Drop이 중복 방출하지 않게 한다.
    disarmed: Rc<Cell<bool>>,
}

impl StreamGuard {
    pub fn new(
        id: StreamId,
        ledger: Rc<RefCell<LiveLedger>>,
        sink: Rc<RefCell<EventSink>>,
        now: Rc<Cell<Millis>>,
    ) -> (StreamGuard, Rc<Cell<CloseCause>>, Rc<Cell<bool>>) {
        let cause = Rc::new(Cell::new(CloseCause::Crash)); // 기본은 최악값
        let disarmed = Rc::new(Cell::new(false));
        (
            StreamGuard {
                id,
                ledger,
                sink,
                cause: cause.clone(),
                now,
                disarmed: disarmed.clone(),
            },
            cause,
            disarmed,
        )
    }
}

impl Drop for StreamGuard {
    fn drop(&mut self) {
        let cause = self.cause.get();
        let now = self.now.get();
        let drained = self.ledger.borrow_mut().drain_owned_by(self.id);
        let mut sink = self.sink.borrow_mut();
        let mut settled: Vec<SettledWire> = vec![];
        for item in drained {
            let reason = SettleReason::StreamClosed { cause };
            sink.emit(Event::Settled {
                id: item.id.clone(),
                kind: item.kind,
                reason: reason.clone(),
                at_ms: now,
            });
            settled.push(SettledWire {
                id: item.id,
                kind: item.kind,
                reason,
            });
        }
        sink.emit(Event::Exit {
            stream: self.id,
            cause,
        });
        let _ = self.disarmed.get();
    }
}
