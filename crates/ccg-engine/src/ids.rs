//! 식별자 newtype 모음. "무엇이 무엇을 소유하는가"(m-logic §3.1)를 타입으로 못박는다.

use serde::Serialize;

/// 프레임 도착 순번. 폴백 arm과 정체성 패치 접수의 **선후 판정**에 쓴다(§4.2-b 규약 2).
pub type FrameSeq = u64;

/// 채팅 주소 — 표면 구분 없음(R2 리드 확정: `ChatRef` 삭제).
pub type ChatId = String;

/// 라이브 항목 id = 프레임의 `task_id` / `tool_use_id` / `request_id`.
pub type LiveId = String;

/// **스트림(=CLI 프로세스 수명) id.** 라이브 항목의 소유자는 run이 아니라 이것이다(P9).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
pub struct StreamId(pub u64);

impl std::fmt::Display for StreamId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "s{}", self.0)
    }
}

/// 턴 id. 발급 지점은 T1·T16·T19·T19b 넷뿐이다(§3.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
pub struct RunId(pub u64);

impl std::fmt::Display for RunId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "r{}", self.0)
    }
}
