//! D5 — 예약 큐(정체성 스냅샷 동봉) · 한도 대기(큐 게이트) · 되돌리기 버퍼. (§7)

use crate::clock::Millis;
use crate::identity::{BillingAxis, RunIdentity};
use crate::ids::RunId;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueueOrigin {
    User,
    LimitResume,
    ViewerAsk,
    NotifReplay,
}

/// 예약 후 채팅 정체성이 바뀌었을 때의 정책. 기본은 **예약할 때 보던 대로**(P5의 약속 확장).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnDrift {
    KeepSnapshot,
    UseCurrent,
    Ask,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThreadIntent {
    Continue,
    Fresh,
}

#[derive(Debug, Clone)]
pub struct QueuedMessage {
    pub id: String,
    pub text: String,
    pub attachments: Vec<String>,
    /// 예약한 순간의 **확정** 정체성 — 이 값으로 나간다.
    pub identity: RunIdentity,
    pub identity_rev: u32,
    pub thread: ThreadIntent,
    pub on_drift: OnDrift,
    pub created_at: Millis,
    pub origin: QueueOrigin,
}

/// 한도 대기 = **큐 게이트**. 자동 이어서는 별개 행위자가 아니라 큐 항목이다(P6를 죽인다).
#[derive(Debug, Clone)]
pub struct LimitHold {
    /// 대기표도 정체성 축으로 식별 — 계정을 바꾸면 이 표는 무효다.
    pub account: BillingAxis,
    pub resets_at: Option<Millis>,
    pub verified_at: Option<Millis>,
    pub ready: bool,
    pub armed_from_run: RunId,
}

impl LimitHold {
    /// `resets_at + 90s`에 신선 usage 재검증(2.6.2 `useLimitResume` 규약 계승).
    pub fn due_at(&self) -> Option<Millis> {
        self.resets_at.map(|r| r + 90 * crate::clock::SEC)
    }
}

#[derive(Debug, Clone)]
pub struct QueueUndo {
    pub items: Vec<QueuedMessage>,
    pub hold: Option<LimitHold>,
    pub token: String,
    /// 다음 성공 send 또는 5분, 둘 중 먼저.
    pub valid_until: Millis,
}

/// §7.2 배칭 계획 — **연속 동일 정체성은 한 스트림에서 연속 주입**한다.
/// 이 계산이 참이 되려면 §3.4-a(드레인 가능하면 close 보류)가 있어야 한다.
pub fn drain_plan(
    items: &[QueuedMessage],
    current_stream_identity: Option<&RunIdentity>,
) -> Vec<crate::event::PlanGroup> {
    let mut out: Vec<crate::event::PlanGroup> = vec![];
    let mut left = current_stream_identity.map(|i| i.hash());
    for m in items {
        let h = m.identity.hash();
        match out.last_mut() {
            Some(g) if g.identity_hash == h => g.count += 1,
            _ => {
                let will_respawn = left.as_ref().is_some_and(|l| *l != h);
                out.push(crate::event::PlanGroup {
                    count: 1,
                    identity_hash: h.clone(),
                    will_respawn,
                    kills_live: vec![],
                });
                left = Some(h);
            }
        }
    }
    out
}
