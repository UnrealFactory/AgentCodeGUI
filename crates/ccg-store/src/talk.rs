//! `chat-talk.json` — 은퇴한 1.x "채팅 모드"의 대화 블롭. 원본: src/main/talkStore.ts.
//!
//! 2.6.2에서도 이미 **읽어서 일반 채팅으로 1회 편입하고 비우는** 파일이다
//! (`App.tsx:528-594`). 3.0에서는 마이그레이터가 같은 일을 하고(`migrate_v3` 5단계),
//! 통합 스토어 플래그가 켜지면 `talk:get`은 **빈 블롭**·`talk:save`는 **no-op**이 된다
//! (M-UX §6.2 별칭 표) — 옛 렌더러가 다시 편입을 시도해도 아무 일도 일어나지 않게.

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

// ─────────────────────────────────────────────────────────────────────────────
// ★M10 — **대화 연결**(세션 간 소통)의 설정. 위쪽 은퇴 블롭과 **이름만 겹친다.**
//
// 이름 충돌 주의: 1.x "채팅 모드"가 `talk:*` 채널과 `chat-talk.json`을 이미 먹었다.
// M10은 그래서 파일도 채널도 갈라 쓴다(`crosstalk:*` · `talk-config.json`) — 같은
// 모듈에 있는 것은 도메인 낱말이 같기 때문이지 데이터가 이어지기 때문이 아니다.
//
// **기본값은 꺼짐이다.** 이 기능의 롤백 사유가 "자율 상호 호출이 위험하다"였고
// (2.6.2 peer 롤백), 켜는 행위 자체가 사용자의 동의여야 한다. 파일이 없으면 꺼짐.
// ─────────────────────────────────────────────────────────────────────────────

const CFG_FILE: &str = "talk-config.json";

/// 홉 상한 기본값 — 사람의 한 번의 지시가 만들 수 있는 **세션 간 건네주기 횟수**.
/// 4면 A→B→A→B다: 넷이 한 바퀴 돌 만큼이면서, 잘못 물리면 네 턴에서 멎는다.
pub const DEFAULT_MAX_HOPS: u64 = 4;
/// 한 연쇄(chain)가 태울 수 있는 **총 메시지 수**. 방송(broadcast)이 섞이면 홉보다
/// 먼저 닿는다: 4패널에서 홉 1회 방송 = 3건이므로 12는 홉 4회분의 방송 예산이다.
pub const DEFAULT_MAX_MSGS: u64 = 12;
/// 한 턴이 한 번에 보낼 수 있는 **수신자 수**. 6자리 보드에서도 5로 안 늘린다 —
/// 방송 한 줄이 다섯 세션의 턴을 동시에 태우는 것이 이 기능의 가장 비싼 사고다.
pub const DEFAULT_MAX_FANOUT: u64 = 3;

/// 설정 전문(없으면 기본값 = 꺼짐).
pub fn config() -> Value {
    let v = crate::read_home_json(CFG_FILE).unwrap_or(Value::Null);
    let g = |k: &str, d: u64| v.get(k).and_then(Value::as_u64).filter(|n| *n > 0).unwrap_or(d);
    json!({
        "version": 1,
        "enabled": v.get("enabled").and_then(Value::as_bool).unwrap_or(false),
        "boards": v.get("boards").filter(|b| b.is_object()).cloned().unwrap_or_else(|| json!({})),
        "maxHops": g("maxHops", DEFAULT_MAX_HOPS),
        "maxMsgs": g("maxMsgs", DEFAULT_MAX_MSGS),
        "maxFanout": g("maxFanout", DEFAULT_MAX_FANOUT),
    })
}

/// 부분 갱신 — 준 키만 덮는다. `board`/`on`이 함께 오면 그 보드의 옵트인을 켜고 끈다.
/// 돌려주는 값은 **갱신 후 전문**이다(렌더러가 되읽지 않아도 되게).
pub fn set_config(patch: &Value) -> Value {
    let mut cur = config();
    let o = cur.as_object_mut().expect("config()는 객체다");
    for k in ["enabled"] {
        if let Some(b) = patch.get(k).and_then(Value::as_bool) {
            o.insert(k.into(), json!(b));
        }
    }
    for k in ["maxHops", "maxMsgs", "maxFanout"] {
        // 0은 받지 않는다 — "무제한"으로 읽힐 여지를 남기지 않기 위해서다.
        if let Some(n) = patch.get(k).and_then(Value::as_u64).filter(|n| *n > 0) {
            o.insert(k.into(), json!(n.min(64)));
        }
    }
    if let Some(board) = patch.get("board").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        let on = patch.get("on").and_then(Value::as_bool).unwrap_or(false);
        let mut boards = o.get("boards").cloned().unwrap_or_else(|| json!({}));
        if let Some(m) = boards.as_object_mut() {
            if on {
                m.insert(board.into(), json!(true));
            } else {
                m.remove(board);
            }
        }
        o.insert("boards".into(), boards);
    }
    if let Ok(text) = serde_json::to_string(&cur) {
        let _ = crate::write_home_file(CFG_FILE, &text);
    }
    cur
}

#[cfg(test)]
mod m10_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn talk_is_off_until_someone_turns_it_on() {
        let _h = crate::testkit::temp_home("m10-off");
        let c = config();
        assert_eq!(c["enabled"], json!(false), "설정 파일이 없으면 꺼짐이다");
        assert_eq!(c["maxHops"], json!(DEFAULT_MAX_HOPS));
        assert_eq!(c["boards"], json!({}));
    }

    #[test]
    fn opting_a_board_in_and_back_out_round_trips_through_disk() {
        let _h = crate::testkit::temp_home("m10-optin");
        set_config(&json!({ "enabled": true, "board": "b-1", "on": true }));
        let c = config();
        assert_eq!(c["enabled"], json!(true));
        assert_eq!(c["boards"]["b-1"], json!(true));
        // 끄면 **키가 사라진다** — false를 남겨 두면 "예전에 켰던 보드"가 목록에 쌓인다.
        set_config(&json!({ "board": "b-1", "on": false }));
        assert_eq!(config()["boards"].get("b-1"), None);
        assert_eq!(config()["enabled"], json!(true), "보드 하나를 꺼도 전역은 그대로다");
    }

    #[test]
    fn caps_never_become_zero_or_absurd() {
        let _h = crate::testkit::temp_home("m10-caps");
        set_config(&json!({ "maxHops": 0, "maxMsgs": 999, "maxFanout": 2 }));
        let c = config();
        assert_eq!(c["maxHops"], json!(DEFAULT_MAX_HOPS), "0은 무제한이 아니라 무시다");
        assert_eq!(c["maxMsgs"], json!(64), "상한을 넘기면 상한으로 접는다");
        assert_eq!(c["maxFanout"], json!(2));
    }
}
