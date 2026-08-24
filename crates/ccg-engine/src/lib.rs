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
/// Codex(app-server) 엔진 — 같은 상태기계 위에 얹은 두 번째 드라이버(M4).
pub mod codex;
pub mod driver;
pub mod event;
pub mod frames;
pub mod identity;
pub mod ids;
pub mod job;
pub mod limit;
pub mod live;
pub mod queue;
pub mod runtime;
pub mod state;
/// 엔진 CLI 버전 관리(목록·설치·제거·활성·정리)의 **두 엔진 공용** 알맹이.
/// Claude는 최종 파리티 T2가, Codex는 M4가 이 문을 쓴다.
pub mod versions;

pub use clock::{Clock, Millis, SystemClock, VirtualClock};
pub use codex::{CodexDriver, CodexPlan};
pub use identity::{
    ApplyPolicy, BillingAxis, BillingKind, CwdProbe, EffortId, EngineAxis, EngineKind,
    FallbackArm, FallbackVia, IdentityAxis, IdentityDefaults, IdentityError, IdentityField,
    IdentityRejectReason, ModeId, OutputStyle, PendingOp, RawBilling, RawEngine, RawIdentity,
    RawIdentityPatch, RawTools, RunIdentity, SkillOverride, Staged,
};
pub use ids::{ChatId, FrameSeq, LiveId, RunId, StreamId};
pub use limit::{classify_limit_error, is_limit_error, LimitHit, LimitProbe, LimitVerdict};
pub use live::{Gating, LiveItem, LiveKind, LiveLedger, Liveness, ProbeSource, SettleReason};
pub use runtime::ChatRuntime;
pub use state::{ResidentWhy, StateTag, StreamClosePolicy};
