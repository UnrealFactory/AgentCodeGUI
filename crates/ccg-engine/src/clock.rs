//! 시계 주입. **모든 타이머는 이 trait만 본다** — 재생 하네스가 35분을 0ms에 지나간다.
//!
//! 실시계는 `Instant` 기준 단조 밀리초. 벽시계(SystemTime)를 쓰지 않는 이유:
//! 사용자가 시각을 바꾸거나 절전에서 깨면 리스/하드리밋이 과거로 점프한다.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

pub type Millis = u64;

pub trait Clock: Send + Sync {
    fn now_ms(&self) -> Millis;

    /// 벽시계 unix **밀리초**.
    ///
    /// 타이머는 단조 시계만 봐야 하지만(위 주석), **한도 리셋 시각**은 바깥 세계의 값이라
    /// 어쩔 수 없이 벽시계 축이다: 에러 문구 꼬리(`…|1755150000`)도 `rate_limit_event`의
    /// `resetsAt`(`1787377200`)도 unix 초다. 두 축을 섞으면 대기표가 1970년(=부팅이 곧
    /// 전송)이나 2026년(=영원히 안 풀림)에 앉는다 — 그래서 변환에 쓸 앵커를 **여기 하나만**
    /// 둔다(`ChatRuntime::epoch_secs_to_runtime`). 재생은 [`VirtualClock`]이 이 값도 쥔다.
    fn now_epoch_ms(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }
}

pub struct SystemClock {
    start: Instant,
}

impl Default for SystemClock {
    fn default() -> Self {
        SystemClock {
            start: Instant::now(),
        }
    }
}

impl Clock for SystemClock {
    fn now_ms(&self) -> Millis {
        self.start.elapsed().as_millis() as u64
    }
}

/// 가상 시계 — 스텝의 `at_ms`로 결정적으로 전진한다. 되감기는 금지(디버깅 지옥).
#[derive(Default)]
pub struct VirtualClock {
    now: AtomicU64,
    /// 가상 t=0이 가리키는 **unix 밀리초**. 기본 0 — 재생은 1970년에 산다. 한도 리셋
    /// 시각을 실전 값(`|1755150000`)으로 먹이는 시나리오가 "몇 십 년 뒤"를 결정적으로
    /// 재현하려면 이 값이 0이어야 한다(벽시계를 읽으면 오늘 날짜에 따라 답이 바뀐다).
    epoch_base: AtomicU64,
}

impl VirtualClock {
    pub fn new() -> Arc<VirtualClock> {
        Arc::new(VirtualClock::default())
    }
    /// 가상 t=0의 unix 밀리초를 놓는다 — "지금이 2026년인 판"을 재생할 때만 쓴다.
    pub fn set_epoch_base(&self, unix_ms: u64) {
        self.epoch_base.store(unix_ms, Ordering::SeqCst);
    }
    pub fn advance_to(&self, ms: Millis) {
        let cur = self.now.load(Ordering::SeqCst);
        assert!(ms >= cur, "가상 시계는 되감을 수 없다: {cur} → {ms}");
        self.now.store(ms, Ordering::SeqCst);
    }
    pub fn advance_by(&self, ms: Millis) {
        self.now.fetch_add(ms, Ordering::SeqCst);
    }
}

impl Clock for VirtualClock {
    fn now_ms(&self) -> Millis {
        self.now.load(Ordering::SeqCst)
    }
    fn now_epoch_ms(&self) -> u64 {
        self.epoch_base
            .load(Ordering::SeqCst)
            .saturating_add(self.now.load(Ordering::SeqCst))
    }
}

pub const SEC: Millis = 1_000;
pub const MIN: Millis = 60 * SEC;
pub const HOUR: Millis = 60 * MIN;
