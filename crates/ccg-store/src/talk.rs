//! `chat-talk.json` — 은퇴한 1.x "채팅 모드"의 대화 블롭. 원본: src/main/talkStore.ts.
//!
//! 2.6.2에서도 이미 **읽어서 일반 채팅으로 1회 편입하고 비우는** 파일이다
//! (`App.tsx:528-594`). 3.0에서는 마이그레이터가 같은 일을 하고(`migrate_v3` 5단계),
//! 통합 스토어 플래그가 켜지면 `talk:get`은 **빈 블롭**·`talk:save`는 **no-op**이 된다
//! (M-UX §6.2 별칭 표) — 옛 렌더러가 다시 편입을 시도해도 아무 일도 일어나지 않게.
//!
//! ★R28k — R28b~R28h의 「대화 연결」(세션 간 소통) 설정·회계가 **이름이 같다는 이유로**
//! 이 모듈 아래쪽에 얹혀 있었다(`talk-config.json` · `talk-state.json`). 사용자 결정으로
//! 그 기능을 3.0에서 통째로 들어냈고, 그 몫만 걷어냈다 — 위 세 함수는 1.x 편입
//! 마이그레이션의 것이라 **파리티 항목**이고 그대로 산다.

use serde_json::{json, Value};

const FILE: &str = "chat-talk.json";

/// 저장된 블롭(없으면 Null) — 2.6.2 `talk:get` 그대로.
pub fn read() -> Value {
    crate::read_home_json(FILE).unwrap_or(Value::Null)
}

/// 블롭 저장(best effort) — 2.6.2 `talk:save` 그대로.
pub fn write(data: &Value) {
    let Ok(text) = serde_json::to_string(data) else { return };
    let _ = crate::write_home_file(FILE, &text);
}

/// 통합 스토어가 켜졌을 때의 `talk:get` — 편입은 끝났으므로 빈 블롭을 준다.
pub fn empty_blob() -> Value {
    json!({ "version": 1, "chats": [], "activeChatId": "" })
}
