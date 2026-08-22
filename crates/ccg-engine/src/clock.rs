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
}

impl VirtualClock {
    pub fn new() -> Arc<VirtualClock> {
        Arc::new(VirtualClock::default())
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
}

pub const SEC: Millis = 1_000;
pub const MIN: Millis = 60 * SEC;
pub const HOUR: Millis = 60 * MIN;
