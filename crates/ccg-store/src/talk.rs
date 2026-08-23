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

/// 상한의 **실효 최대치**(★R2 D2). R1은 `n.min(64)`였다 — UI가 붙는 날 슬라이더가
/// 64/64/64면 사람의 한 지시가 64턴이다. 크리틱이 잰 제품 기본값의 천장이 12턴이었고
/// 그 숫자가 이미 "사용자가 상상했을 크기"의 경계다. 여기가 그 경계다.
pub const CAP_MAX_HOPS: u64 = 12;
pub const CAP_MAX_MSGS: u64 = 24;
pub const CAP_MAX_FANOUT: u64 = 5;

fn cap_of(k: &str) -> u64 {
    match k {
        "maxHops" => CAP_MAX_HOPS,
        "maxMsgs" => CAP_MAX_MSGS,
        _ => CAP_MAX_FANOUT,
    }
}

/// 설정 전문(없으면 기본값 = 꺼짐).
pub fn config() -> Value {
    let v = crate::read_home_json(CFG_FILE).unwrap_or(Value::Null);
    let g = |k: &str, d: u64| {
        v.get(k)
            .and_then(Value::as_u64)
            .filter(|n| *n > 0)
            .map(|n| n.min(cap_of(k)))
            .unwrap_or(d)
    };
    json!({
        "version": 1,
        "enabled": v.get("enabled").and_then(Value::as_bool).unwrap_or(false),
        "boards": v.get("boards").filter(|b| b.is_object()).cloned().unwrap_or_else(|| json!({})),
        "maxHops": g("maxHops", DEFAULT_MAX_HOPS),
        "maxMsgs": g("maxMsgs", DEFAULT_MAX_MSGS),
        "maxFanout": g("maxFanout", DEFAULT_MAX_FANOUT),
        // ★R2 D4 — **긴급 정지가 남긴 표식**(epoch 초). 디스크에서 정지와 그냥 꺼짐은
        // 둘 다 `enabled:false`로 보이지만 사용자에게 할 말이 정반대다: 정지 뒤에
        // 「설정에서 켜세요」라고 권하면 그건 정지가 아니다. 다시 켜면 사라진다.
        "stoppedAt": v.get("stoppedAt").and_then(Value::as_f64).map(Value::from).unwrap_or(Value::Null),
        // ★R3 C1 — **봉투 턴 권한 하한.** `readonly`(기본) = 그 한 건만 계획 모드로
        // 돈다 = 파일 수정·명령 실행의 수단이 아예 없다. `ask` = R2 동작(자동승인 3종만
        // 승인 필수로 강등 — 사용자의 allowlist는 그대로 자동 실행된다).
        // 모르는 값·손으로 고친 오타는 **안전한 쪽**으로 떨어진다.
        "injectPolicy": if v.get("injectPolicy").and_then(Value::as_str) == Some("ask") { "ask" } else { "readonly" },
        // ★R3 — 「켤 때 1회 확인 카드」를 본 적이 있나(고지의 영속). 카드 자체는 렌더러가
        // 그리지만 **봤다는 사실**은 홈에 남아야 창을 옮겨도 다시 뜨지 않는다.
        "noticeAckAt": v.get("noticeAckAt").and_then(Value::as_f64).map(Value::from).unwrap_or(Value::Null),
    })
}

/// 부분 갱신 — 준 키만 덮는다. `board`/`on`이 함께 오면 그 보드의 옵트인을 켜고 끈다.
/// 돌려주는 값은 **갱신 후 전문**이다(렌더러가 되읽지 않아도 되게).
///
/// 정지 전용 키 둘: `clearBoards`(전 보드 옵트인 철회 — D3) · `stopped`(표식 — D4).
pub fn set_config(patch: &Value) -> Value {
    let mut cur = config();
    let o = cur.as_object_mut().expect("config()는 객체다");
    for k in ["enabled"] {
        if let Some(b) = patch.get(k).and_then(Value::as_bool) {
            o.insert(k.into(), json!(b));
            // **다시 켜는 것이 정지 표식을 지우는 유일한 길이다.** 사용자가 스위치를
            // 올린 그 순간이 "정지 상태를 확인하고 풀었다"이므로.
            if b {
                o.insert("stoppedAt".into(), Value::Null);
            }
        }
    }
    if patch.get("stopped").and_then(Value::as_bool) == Some(true) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0);
        o.insert("stoppedAt".into(), json!(now));
    }
    if patch.get("clearBoards").and_then(Value::as_bool) == Some(true) {
        o.insert("boards".into(), json!({}));
    }
    // ★R3 C1 — 봉투 턴 하한. `readonly`/`ask` 둘뿐이고 그 외 값은 안 받는다
    // (「오타 하나가 벽을 낮춘다」가 이 축에서 가장 싼 사고다).
    if let Some(p) = patch.get("injectPolicy").and_then(Value::as_str) {
        if p == "readonly" || p == "ask" {
            o.insert("injectPolicy".into(), json!(p));
        }
    }
    // ★R3 — 켤 때 1회 확인 카드를 읽고 눌렀다.
    if patch.get("noticeAck").and_then(Value::as_bool) == Some(true) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0);
        o.insert("noticeAckAt".into(), json!(now));
    }
    for k in ["maxHops", "maxMsgs", "maxFanout"] {
        // 0은 받지 않는다 — "무제한"으로 읽힐 여지를 남기지 않기 위해서다.
        if let Some(n) = patch.get(k).and_then(Value::as_u64).filter(|n| *n > 0) {
            o.insert(k.into(), json!(n.min(cap_of(k))));
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

// ── 연쇄 회계 영속 (★M10 R2 C4) ──────────────────────────────────────────────
//
// 라우터의 홉·총량 회계는 R1에서 **순수 인메모리**였다. 그래서 재시작이 곧 예산
// 리셋이었고, 재시작을 건넌 봉투가 드레인될 때 그 세션은 어느 연쇄에도 서 있지
// 않았다. 설정과 **파일을 가르는** 이유는 수명이 다르기 때문이다: 설정은 사용자의
// 동의(영구)이고 이쪽은 30분 TTL짜리 도는 상태다. 한 파일에 섞으면 회계를 지우는
// 일이 동의를 건드릴 위험을 만든다.

const STATE_FILE: &str = "talk-state.json";

/// 저장된 연쇄 회계(없으면 Null).
pub fn read_state() -> Value {
    crate::read_home_json(STATE_FILE).unwrap_or(Value::Null)
}

/// 회계 저장 — `savedAt`(epoch 초)은 여기서 찍는다(호출측이 잊을 수 없게).
pub fn write_state(v: &Value) {
    let mut out = v.clone();
    if let Some(o) = out.as_object_mut() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0);
        o.insert("savedAt".into(), json!(now));
    }
    if let Ok(text) = serde_json::to_string(&out) {
        let _ = crate::write_home_file(STATE_FILE, &text);
    }
}

/// 저장된 회계의 나이(초). 파일이 없거나 `savedAt`이 없으면 `None` = **안 씀**.
pub fn state_age_secs(state: &Value) -> Option<u64> {
    let saved = state.get("savedAt").and_then(Value::as_f64)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    Some((now - saved).max(0.0) as u64)
}

/// 긴급 정지·전역 끄기의 짝 — 파일째 지운다(빈 객체를 남기지 않는다).
pub fn clear_state() {
    let _ = std::fs::remove_file(crate::app_home().join(STATE_FILE));
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
        assert_eq!(c["maxMsgs"], json!(CAP_MAX_MSGS), "상한을 넘기면 상한으로 접는다");
        assert_eq!(c["maxFanout"], json!(2));
    }

    /// ★R2 D2 — 손으로 쓴 파일이 상한을 넘겨도 **읽는 쪽에서** 접는다.
    /// `set_config`만 접으면 사용자가 `talk-config.json`에 64를 적어 두는 순간
    /// 사람 1지시가 64턴이 된다(크리틱 D2가 센 천장은 12였다).
    #[test]
    fn a_hand_edited_file_cannot_raise_the_ceiling() {
        let h = crate::testkit::temp_home("m10-cap-file");
        h.write("talk-config.json", &json!({ "enabled": true, "maxHops": 64, "maxMsgs": 999, "maxFanout": 40 }).to_string());
        let c = config();
        assert_eq!(c["maxHops"], json!(CAP_MAX_HOPS));
        assert_eq!(c["maxMsgs"], json!(CAP_MAX_MSGS));
        assert_eq!(c["maxFanout"], json!(CAP_MAX_FANOUT));
    }

    /// ★R2 D3 — 긴급 정지는 **무장 해제**다. 보드 옵트인을 남기면 복귀가 보드별
    /// 재동의가 아니라 전역 스위치 한 번이 된다(크리틱 D3의 실측 그대로).
    #[test]
    fn an_emergency_stop_disarms_every_board_and_leaves_a_mark() {
        let _h = crate::testkit::temp_home("m10-stop");
        set_config(&json!({ "enabled": true, "board": "b-1", "on": true }));
        set_config(&json!({ "enabled": true, "board": "b-2", "on": true }));
        assert_eq!(config()["boards"].as_object().unwrap().len(), 2);

        let after = set_config(&json!({ "enabled": false, "clearBoards": true, "stopped": true }));
        assert_eq!(after["enabled"], json!(false));
        assert_eq!(after["boards"], json!({}), "정지가 옵트인 목록을 남겼다 — 토글 한 번에 전원 재무장");
        assert!(after["stoppedAt"].as_f64().is_some(), "정지 표식이 없으면 다음 거절이 「설정에서 켜세요」로 나간다");

        // 다시 켜는 것이 표식을 지우는 유일한 길이고, 보드는 **여전히 하나도 안 켜져 있다**.
        let back = set_config(&json!({ "enabled": true }));
        assert_eq!(back["stoppedAt"], Value::Null);
        assert_eq!(back["boards"], json!({}), "전역만 켜면 아무 보드도 안 켜진 상태여야 한다");
    }

    /// ★R3 C1 — 봉투 턴 하한의 **기본값은 읽기 전용**이고, 손으로 고친 이상한 값은
    /// 거기로 떨어진다. 그리고 켤 때의 1회 고지 표식은 껐다 켜도 남는다.
    #[test]
    fn the_injected_turn_floor_defaults_to_read_only_and_rejects_junk() {
        let h = crate::testkit::temp_home("m10r3-policy");
        assert_eq!(config()["injectPolicy"], json!("readonly"), "기본값이 읽기 전용이 아니다");
        assert_eq!(config()["noticeAckAt"], Value::Null);
        assert_eq!(set_config(&json!({ "injectPolicy": "ask" }))["injectPolicy"], json!("ask"));
        // 오타·모르는 값은 **무시**된다(직전 값 유지). 파일을 직접 고쳐도 읽기 쪽에서 접는다.
        assert_eq!(set_config(&json!({ "injectPolicy": "yolo" }))["injectPolicy"], json!("ask"));
        h.write("talk-config.json", &json!({ "enabled": true, "injectPolicy": "off" }).to_string());
        assert_eq!(config()["injectPolicy"], json!("readonly"), "손으로 고친 값이 하한을 낮췄다");
        // 고지 표식은 한 번 서면 남는다 — 껐다 켜도 카드가 다시 뜨지 않게.
        assert!(set_config(&json!({ "noticeAck": true }))["noticeAckAt"].as_f64().is_some());
        assert!(set_config(&json!({ "enabled": false }))["noticeAckAt"].as_f64().is_some());
    }

    /// ★R2 C4 — 연쇄 회계는 디스크를 건너지만 **TTL이 지나면 안 안고 온다**.
    #[test]
    fn chain_accounting_round_trips_and_ages_out() {
        let h = crate::testkit::temp_home("m10-state");
        assert_eq!(state_age_secs(&read_state()), None, "파일이 없으면 나이도 없다(= 안 씀)");
        write_state(&json!({ "version": 1, "seq": 3, "chains": [{ "id": "tk-3", "msgs": 2 }] }));
        let st = read_state();
        assert_eq!(st["chains"][0]["id"], json!("tk-3"));
        assert!(state_age_secs(&st).unwrap() < 5, "방금 쓴 상태는 신선하다");

        // 어제 켠 대화 — 나이가 TTL을 넘으면 호출측이 버린다.
        let mut old = st.clone();
        old["savedAt"] = json!(old["savedAt"].as_f64().unwrap() - 3600.0);
        h.write("talk-state.json", &old.to_string());
        assert!(state_age_secs(&read_state()).unwrap() > 1800);

        clear_state();
        assert_eq!(read_state(), Value::Null, "정지는 회계 파일을 통째로 지운다");
    }
}
