//! `ccg-engine` — AgentCodeGUI 3.0 엔진 코어.
//!
//! 계약 문서: `docs/design/m-logic.md`(R3) + `docs/design/m-logic-replay.md`(R3) +
//! `docs/protocol-claude-cli.md`(와이어).
//!
//! 층위(§3.1):
//! ```text
//! ChatRuntime (채팅당 1개, Rust 소유)
//!  ├─ identity / identity_raw / pending(Staged) / revisions / fallback_arms
//!  ├─ queue / queue_undo / hold
//!  ├─ live: LiveLedger           ← 진행 중 항목 원장. 소유자는 **스트림**(P9)
//!  └─ stream: Option<Stream>     ← 지금 떠 있는 CLI 프로세스 0..1개
//!      └─ state: StreamState     ← 60전이 상태기계
//! ```

pub mod canon;
pub mod clock;
pub mod driver;
pub mod event;
pub mod frames;
pub mod identity;
pub mod ids;
pub mod job;
pub mod live;
pub mod queue;
pub mod runtime;
pub mod state;

pub use clock::{Clock, Millis, SystemClock, VirtualClock};
pub use identity::{
    ApplyPolicy, BillingAxis, BillingKind, CwdProbe, EffortId, EngineAxis, EngineKind,
    FallbackArm, FallbackVia, IdentityAxis, IdentityDefaults, IdentityError, IdentityField,
    IdentityRejectReason, ModeId, OutputStyle, PendingOp, RawBilling, RawEngine, RawIdentity,
    RawIdentityPatch, RawTools, RunIdentity, SkillOverride, Staged,
};
pub use ids::{ChatId, FrameSeq, LiveId, RunId, StreamId};
pub use live::{Gating, LiveItem, LiveKind, LiveLedger, Liveness, ProbeSource, SettleReason};
pub use runtime::ChatRuntime;
pub use state::{ResidentWhy, StateTag, StreamClosePolicy};
