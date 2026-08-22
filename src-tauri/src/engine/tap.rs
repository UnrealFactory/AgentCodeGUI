//! `TapDriver` — 실 `ClaudeDriver`를 감싸 **지나가는 프레임을 한 벌 더 뜬다.**
//!
//! 왜 필요한가: `ChatRuntime::tick()`이 프레임을 스스로 꺼내 `on_frame`으로 삼킨다
//! (`runtime.rs:2104`). 상태기계에는 그게 옳지만, 렌더러가 그리는 것은 **프레임의 내용**
//! (스트리밍 텍스트·도구 인자·질문 선택지)이고 그 내용은 엔진 `Event`에 없다 —
//! `Frame::Assistant`는 `has_text: bool`까지만 안다(`frames.rs:47`).
//!
//! 선택지 둘 중 이쪽을 골랐다:
//!  - (a) `ChatRuntime`에 프레임 옵저버 훅을 낸다 → 엔진 크레이트의 공개면과 97 테스트가
//!        걸린 파일을 건드린다.
//!  - (b) **드라이버를 감싼다** → `CliDriver`는 이미 상태기계와 드라이버 사이의 유일한
//!        통로다(`driver.rs:220`). 엔진은 한 글자도 안 바뀌고, 순서도 정확하다
//!        (상태기계가 소화하는 것과 **같은 벡터**를 복사한다).
//!
//! 소유는 허브 스레드 하나다. 그래서 `Rc<RefCell<..>>`로 충분하다 — 이 값이 스레드를
//! 넘는 경로 자체가 없다(`ChatRuntime`도 `Rc`를 들고 있어 `!Send`다).

use ccg_engine::clock::Millis;
use ccg_engine::driver::{ClaudeDriver, CliDriver, SpawnSpec};
use ccg_engine::live::LiveItem;
use serde_json::Value;
use std::cell::RefCell;
use std::rc::Rc;

pub struct TapDriver {
    inner: ClaudeDriver,
    /// 이번 tick에 도착한 프레임(허브가 매 tick 비운다).
    tapped: Rc<RefCell<Vec<Value>>>,
}

impl TapDriver {
    pub fn new(inner: ClaudeDriver) -> (TapDriver, Rc<RefCell<Vec<Value>>>) {
        let tapped = Rc::new(RefCell::new(Vec::new()));
        (
            TapDriver {
                inner,
                tapped: tapped.clone(),
            },
            tapped,
        )
    }
    pub fn pid(&self) -> Option<u32> {
        self.inner.pid()
    }
    pub fn drain_stderr(&mut self) -> Vec<String> {
        self.inner.drain_stderr()
    }
}

impl CliDriver for TapDriver {
    fn spawn(&mut self, spec: &SpawnSpec) -> std::io::Result<()> {
        self.inner.spawn(spec)
    }
    fn send(&mut self, line: Value) {
        self.inner.send(line)
    }
    fn close_input(&mut self) {
        self.inner.close_input()
    }
    fn kill(&mut self) {
        self.inner.kill()
    }
    fn process_alive(&self) -> bool {
        self.inner.process_alive()
    }
    fn poll_frames(&mut self, now: Millis) -> Vec<Value> {
        let frames = self.inner.poll_frames(now);
        if !frames.is_empty() {
            self.tapped.borrow_mut().extend(frames.iter().cloned());
        }
        frames
    }
    fn mtime_fresh(&self, item: &LiveItem, now: Millis) -> bool {
        self.inner.mtime_fresh(item, now)
    }
    fn spawn_count(&self) -> usize {
        self.inner.spawn_count()
    }
}
