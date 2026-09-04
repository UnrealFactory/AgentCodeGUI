//! `AnyDriver` — **스폰 인자가 엔진을 고른다.**
//!
//! `ChatRuntime<D>`는 드라이버 타입이 하나다. 그런데 채팅의 엔진은 정체성 리프
//! (`engine.kind`)라 **살아 있는 채팅에서 바뀔 수 있다**(picker에서 Codex로 전환 →
//! T17 재스폰). 런타임을 두 벌 들거나 채팅을 다시 만드는 대신, 드라이버 하나가 둘을
//! 품고 **매 스폰마다** 갈아탄다:
//!
//! ```text
//!   t1_spawn → build_spawn_spec(identity) → SpawnSpec{ codex: Some(plan) }?
//!                                              ├─ Some → CodexDriver (codex app-server)
//!                                              └─ None → ClaudeDriver (claude.exe)
//! ```
//!
//! 스트림은 채팅당 0..1개라 두 내부 드라이버가 동시에 살 일이 없다. 갈아타기 직전
//! 상태(EOF 래치·pid)는 각자 자기 것을 들고 있고, `active`가 가리키는 쪽만 답한다.
//!
//! **왜 `spec.cli`를 안 보나**: 그 값은 런타임의 `cli_path`(= `claude.exe`) 하나다.
//! 엔진마다 실행본이 다르다는 사실은 앱 홈을 읽는 셸만 알 수 있으므로,
//! codex 바이너리는 여기서 주입한다(`hub.rs::codex_bin`).

use ccg_engine::clock::Millis;
use ccg_engine::codex::CodexDriver;
use ccg_engine::driver::{ClaudeDriver, CliDriver, SpawnSpec};
use ccg_engine::live::{CloseCause, LiveItem};
use serde_json::Value;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Which {
    Claude,
    Codex,
}

pub struct AnyDriver {
    claude: ClaudeDriver,
    codex: CodexDriver,
    active: Which,
}

impl AnyDriver {
    pub fn new(claude: ClaudeDriver, codex: CodexDriver) -> AnyDriver {
        AnyDriver { claude, codex, active: Which::Claude }
    }
    pub fn active(&self) -> Which {
        self.active
    }
    pub fn pid(&self) -> Option<u32> {
        match self.active {
            Which::Claude => self.claude.pid(),
            Which::Codex => self.codex.pid(),
        }
    }
    pub fn drain_stderr(&mut self) -> Vec<String> {
        match self.active {
            Which::Claude => self.claude.drain_stderr(),
            Which::Codex => self.codex.drain_stderr(),
        }
    }
}

/// 활성 드라이버로 위임하는 한 줄짜리 매크로 — 열 개 넘는 메서드를 손으로 쓰면
/// **한 개를 빠뜨렸을 때 그 메서드만 조용히 Claude로 간다**(찾기 어려운 종류의 버그).
macro_rules! on_active {
    ($self:ident, $m:ident ( $($a:expr),* )) => {
        match $self.active {
            Which::Claude => $self.claude.$m($($a),*),
            Which::Codex => $self.codex.$m($($a),*),
        }
    };
}

impl CliDriver for AnyDriver {
    fn spawn(&mut self, spec: &SpawnSpec) -> std::io::Result<()> {
        self.active = if spec.codex.is_some() { Which::Codex } else { Which::Claude };
        on_active!(self, spawn(spec))
    }
    fn send(&mut self, line: Value) {
        on_active!(self, send(line))
    }
    fn close_input(&mut self) {
        on_active!(self, close_input())
    }
    fn kill(&mut self) {
        on_active!(self, kill())
    }
    fn kill_graceful(&mut self) {
        on_active!(self, kill_graceful())
    }
    fn process_alive(&self) -> bool {
        on_active!(self, process_alive())
    }
    fn stream_eof(&mut self) -> Option<CloseCause> {
        on_active!(self, stream_eof())
    }
    fn poll_frames(&mut self, now: Millis) -> Vec<Value> {
        on_active!(self, poll_frames(now))
    }
    fn mtime_fresh(&self, item: &LiveItem, now: Millis) -> bool {
        on_active!(self, mtime_fresh(item, now))
    }
    /// 스폰 횟수는 **두 드라이버의 합**이다 — 엔진을 갈아탄 채팅도 "몇 번 떴나"가 맞아야 한다.
    fn spawn_count(&self) -> usize {
        self.claude.spawn_count() + self.codex.spawn_count()
    }
}
