//! **M4 크리틱 — Transcoder 공격 하네스**(순수 SUT, 제품 코드 수정 없음).
//!
//! 워크트리의 `crates/ccg-engine/tests/`로 복사해서 돌린다:
//!   cp docs/critic/tools/critic-m4-transcode.rs crates/ccg-engine/tests/critic_m4.rs
//!   cargo test -p ccg-engine --offline --test critic_m4 -- --nocapture
//!
//! 재는 것은 넷이다.
//!  ① 결과 카드 두 장(빌더가 "고쳤다"고 한 결함 1)이 **반대 순서**에서도 막히는가.
//!  ② `error` 통지의 turnId 게이트 3종(2.6.2 engine.ts:606-609)이 이식됐는가.
//!  ③ 모르는 프레임(신버전 가정)이 침묵인가 크래시인가.
//!  ④ 잘못된 타입/모양의 프레임에 패닉이 나는가.

use ccg_engine::codex::transcode::Egress;
use ccg_engine::codex::{CodexPlan, Transcoder};
use ccg_engine::driver::{initialize_request, user_message};
use serde_json::{json, Value};

fn plan() -> CodexPlan {
    CodexPlan {
        model: "gpt-5.6-terra".into(),
        effort: "medium".into(),
        approval_policy: "untrusted".into(),
        sandbox: "workspace-write".into(),
        cwd: "C:\\w".into(),
        ..Default::default()
    }
}

pub struct Rig {
    t: Transcoder,
    frames: Vec<Value>,
    rpcs: Vec<Value>,
}
impl Rig {
    fn new() -> Rig {
        Rig { t: Transcoder::new(plan()), frames: vec![], rpcs: vec![] }
    }
    fn take(&mut self, e: Vec<Egress>) {
        for x in e {
            match x {
                Egress::Frame(f) => self.frames.push(f),
                Egress::Rpc(r) => self.rpcs.push(r),
                Egress::Tail { .. } => {}
            }
        }
    }
    fn out(&mut self, v: Value) -> &mut Self {
        let e = self.t.on_outgoing(&v, 0);
        self.take(e);
        self
    }
    fn rpc(&mut self, v: Value) -> &mut Self {
        let e = self.t.on_rpc(&v, 1_000);
        self.take(e);
        self
    }
    fn clear(&mut self) {
        self.frames.clear();
        self.rpcs.clear();
    }
    fn results(&self) -> Vec<&Value> {
        self.frames.iter().filter(|f| f["type"] == "result").collect()
    }
}

/// 핸드셰이크 → 스레드 → 턴(tu-1)까지 밀어 둔다.
fn started() -> Rig {
    let mut r = Rig::new();
    r.out(initialize_request("init-1", None));
    r.rpc(json!({ "jsonrpc": "2.0", "id": 1, "result": { "userAgent": "codex/0.149.0" } }));
    r.out(user_message("작업 시작"));
    r.rpc(json!({ "jsonrpc": "2.0", "id": 2, "result": { "thread": { "id": "th-1" } } }));
    r.rpc(json!({ "jsonrpc": "2.0", "id": 3, "result": { "turn": { "id": "tu-1" } } }));
    r.clear();
    r
}

// ─────────────────────────────────────────────────────────────────────────────
// ① 결과 카드 두 장 — 순서를 뒤집으면?
// ─────────────────────────────────────────────────────────────────────────────

/// 빌더가 잠근 순서: error{willRetry:false} → turn/completed{failed} = result 1장.
#[test]
fn a1_builder_order_is_one_card() {
    let mut r = started();
    r.rpc(json!({ "method": "error", "params": { "threadId": "th-1", "turnId": "tu-1",
        "willRetry": false, "error": { "message": "401", "codexErrorInfo": "other" } } }));
    r.rpc(json!({ "method": "turn/completed", "params": { "threadId": "th-1",
        "turn": { "id": "tu-1", "status": "failed", "error": { "message": "401" } } } }));
    println!("[a1] results={}", r.results().len());
    assert_eq!(r.results().len(), 1, "빌더가 잠근 순서 — 한 장이어야 한다");
}

/// **공격**: 반대 순서. turn/completed{failed}가 먼저, 늦은 error가 뒤.
/// 2.6.2는 `endedTurnIds`를 settleTurn에서 채워 두 번째를 삼킨다(engine.ts:592·607).
#[test]
fn a2_reversed_order_should_still_be_one_card() {
    let mut r = started();
    r.rpc(json!({ "method": "turn/completed", "params": { "threadId": "th-1",
        "turn": { "id": "tu-1", "status": "failed", "error": { "message": "401" } } } }));
    r.rpc(json!({ "method": "error", "params": { "threadId": "th-1", "turnId": "tu-1",
        "willRetry": false, "error": { "message": "401", "codexErrorInfo": "other" } } }));
    let n = r.results().len();
    println!("[a2] results={n}  frames={}", serde_json::to_string(&r.frames).unwrap());
    assert_eq!(n, 1, "★ 늦은 error가 결과 카드를 한 장 더 그린다");
}

/// **공격**: 성공한 턴 뒤에 늦은 error. 사용자가 보는 것 = "성공" 카드 + "실패" 카드.
#[test]
fn a3_late_error_after_a_successful_turn() {
    let mut r = started();
    r.rpc(json!({ "method": "turn/completed", "params": { "threadId": "th-1",
        "turn": { "id": "tu-1", "status": "completed", "durationMs": 100 } } }));
    assert_eq!(r.results().len(), 1);
    r.rpc(json!({ "method": "error", "params": { "threadId": "th-1", "turnId": "tu-1",
        "willRetry": false, "error": { "message": "late 500" } } }));
    let n = r.results().len();
    println!("[a3] results={n}");
    assert_eq!(n, 1, "★ 마감한 턴의 늦은 error가 두 번째 result를 낸다");
}

/// **공격**: turn/completed 중복 도착(같은 turnId 두 번).
#[test]
fn a4_duplicate_turn_completed() {
    let mut r = started();
    let c = json!({ "method": "turn/completed", "params": { "threadId": "th-1",
        "turn": { "id": "tu-1", "status": "completed" } } });
    r.rpc(c.clone());
    r.rpc(c);
    let n = r.results().len();
    println!("[a4] results={n}");
    assert_eq!(n, 1, "★ 같은 턴의 completed 두 번 = 결과 카드 두 장");
}

/// **공격**: 턴이 없는데(유휴) 도착한 error. 2.6.2: `errTurnId && !activeTurnId` → 버림.
#[test]
fn a5_error_with_no_active_turn_is_dropped_in_262() {
    let mut r = Rig::new();
    r.out(initialize_request("init-1", None));
    r.rpc(json!({ "jsonrpc": "2.0", "id": 1, "result": {} }));
    r.out(user_message("hi"));
    r.rpc(json!({ "jsonrpc": "2.0", "id": 2, "result": { "thread": { "id": "th-1" } } }));
    r.clear();
    // turn/start 응답이 아직 안 왔다 = 시작 창. 이전 턴의 늦은 error가 여기 떨어진다.
    r.rpc(json!({ "method": "error", "params": { "threadId": "th-1", "turnId": "tu-OLD",
        "willRetry": false, "error": { "message": "stale" } } }));
    let n = r.results().len();
    println!("[a5] results={n} frames={}", serde_json::to_string(&r.frames).unwrap());
    assert_eq!(n, 0, "★ 시작 창의 잔재 error가 새 실행을 즉사시킨다");
}

/// **공격**: 다른 턴의 error가 현재 턴을 죽이는가(engine.ts:609).
#[test]
fn a6_error_for_another_turn_is_dropped_in_262() {
    let mut r = started();
    r.rpc(json!({ "method": "error", "params": { "threadId": "th-1", "turnId": "tu-OTHER",
        "willRetry": false, "error": { "message": "다른 턴의 오류" } } }));
    let n = r.results().len();
    println!("[a6] results={n}");
    assert_eq!(n, 0, "★ 남의 턴 오류가 지금 턴을 정착시킨다");
}

// ─────────────────────────────────────────────────────────────────────────────
// ② 모르는 프레임 — 신버전 가정
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn b1_unknown_notifications_are_silent() {
    let mut r = started();
    let unknown = [
        json!({ "method": "thread/compaction/started", "params": { "threadId": "th-1" } }),
        json!({ "method": "item/videoGeneration/delta", "params": { "threadId": "th-1", "delta": "x" } }),
        json!({ "method": "turn/usage/v2", "params": { "threadId": "th-1", "usage": { "x": 1 } } }),
        json!({ "method": "item/started", "params": { "threadId": "th-1",
            "item": { "id": "z1", "type": "brandNewToolKind", "foo": "bar" } } }),
        json!({ "method": "item/completed", "params": { "threadId": "th-1",
            "item": { "id": "z1", "type": "brandNewToolKind" } } }),
        json!({ "method": "item/reasoning/encryptedDelta", "params": { "threadId": "th-1", "delta": "??" } }),
    ];
    for u in unknown {
        r.rpc(u.clone());
        assert!(r.frames.is_empty(), "모르는 통지가 프레임을 냈다: {u} → {:?}", r.frames);
        assert!(r.rpcs.is_empty(), "모르는 통지가 RPC를 냈다: {u}");
    }
    println!("[b1] 모르는 통지 6종 전부 침묵 ok");
}

#[test]
fn b2_unknown_server_request_gets_an_rpc_error_not_a_hang() {
    let mut r = started();
    r.rpc(json!({ "jsonrpc": "2.0", "id": 77, "method": "brandNew/requestSomething",
                  "params": { "threadId": "th-1" } }));
    assert_eq!(r.rpcs.len(), 1, "서버 요청은 반드시 답이 나가야 한다(안 그러면 서버가 멈춘다)");
    assert_eq!(r.rpcs[0]["id"], 77);
    assert!(r.rpcs[0]["error"]["message"].as_str().unwrap().contains("unsupported"));
    println!("[b2] 모르는 서버 요청 → RPC error 회신 ok");
}

/// ★ 신버전이 **승인 요청 이름을 바꾸면** 어떻게 되나 —
/// 우리는 error로 거절하고 서버는 폴백하지만, 화면에는 아무 말도 안 나간다.
#[test]
fn b3_a_renamed_approval_request_is_silently_declined() {
    let mut r = started();
    r.rpc(json!({ "jsonrpc": "2.0", "id": 78, "method": "item/mcpToolCall/requestApproval",
                  "params": { "threadId": "th-1", "tool": "deploy" } }));
    println!("[b3] frames={} rpcs={}", r.frames.len(), r.rpcs.len());
    assert!(r.frames.is_empty(), "승인 카드가 안 뜬다(설계상 — 서버가 폴백한다)");
}

// ─────────────────────────────────────────────────────────────────────────────
// ③ 망가진 모양 — 패닉이 나면 드라이버 스레드가 죽는다
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn c1_malformed_frames_do_not_panic() {
    let mut r = started();
    let bad = [
        json!({ "method": "turn/completed", "params": { "threadId": "th-1", "turn": "문자열" } }),
        json!({ "method": "turn/completed", "params": { "threadId": "th-1" } }),
        json!({ "method": "turn/plan/updated", "params": { "threadId": "th-1", "plan": { "not": "array" } } }),
        json!({ "method": "thread/tokenUsage/updated", "params": { "threadId": "th-1", "tokenUsage": 5 } }),
        json!({ "method": "thread/tokenUsage/updated", "params": { "threadId": "th-1",
            "tokenUsage": { "last": { "totalTokens": -3 }, "total": { "inputTokens": 1e30 } } } }),
        json!({ "method": "item/completed", "params": { "threadId": "th-1",
            "item": { "id": "f1", "type": "fileChange", "status": "completed", "changes": "문자열" } } }),
        json!({ "method": "item/agentMessage/delta", "params": { "threadId": "th-1", "delta": 12345 } }),
        json!({ "method": "error", "params": { "threadId": "th-1", "error": "문자열", "willRetry": "yes" } }),
        json!({ "method": "item/started", "params": { "threadId": "th-1", "item": null } }),
        json!({ "method": "item/completed", "params": null }),
        json!({ "params": { "threadId": "th-1" } }),
        json!({ "jsonrpc": "2.0", "id": 9, "result": null }),
        json!(null),
        json!([1, 2, 3]),
    ];
    for b in bad {
        let before = r.frames.len();
        r.rpc(b.clone());
        println!("[c1] {} → +{} 프레임", b, r.frames.len() - before);
    }
    println!("[c1] 패닉 없음 ok");
}

/// 정수 오버플로 / 음수 토큰이 usage 회계를 깨는가.
#[test]
fn c2_absurd_token_numbers() {
    let mut r = started();
    r.rpc(json!({ "method": "thread/tokenUsage/updated", "params": { "threadId": "th-1",
        "tokenUsage": { "last": { "inputTokens": u64::MAX, "outputTokens": u64::MAX, "totalTokens": u64::MAX },
                        "total": { "inputTokens": u64::MAX, "outputTokens": u64::MAX, "totalTokens": u64::MAX },
                        "modelContextWindow": u64::MAX } } }));
    r.rpc(json!({ "method": "turn/completed", "params": { "threadId": "th-1",
        "turn": { "id": "tu-1", "status": "completed" } } }));
    let res = r.results()[0].clone();
    println!("[c2] result.usage={} modelUsage={}", res["usage"], res["modelUsage"]);
}

// ─────────────────────────────────────────────────────────────────────────────
// ④ 질문 카드 — 답 개수와 qid 개수가 안 맞으면
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn d1_question_answer_arity_mismatch() {
    let mut r = started();
    r.rpc(json!({ "jsonrpc": "2.0", "id": 55, "method": "item/tool/requestUserInput",
        "params": { "threadId": "th-1", "questions": [
            { "id": "q1", "header": "H1", "question": "Q1", "options": [{ "label": "A" }] },
            { "id": "q2", "header": "H2", "question": "Q2", "options": [{ "label": "B" }] } ] } }));
    let card = r.frames.iter().find(|f| f["type"] == "control_request").cloned().unwrap();
    let rid = card["request_id"].as_str().unwrap().to_string();
    r.clear();
    // 답을 하나만 보낸다(렌더러가 한 질문만 답한 경우).
    r.out(json!({ "type": "control_response", "response": { "subtype": "success",
        "request_id": rid, "response": { "behavior": "allow", "ccgAnswers": [["A"]] } } }));
    println!("[d1] rpc={}", serde_json::to_string(&r.rpcs).unwrap());
    assert_eq!(r.rpcs.len(), 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑤ 중단 — 턴이 없을 때 interrupt를 보내면 아무것도 안 나간다
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn e1_interrupt_with_no_turn_emits_nothing() {
    let mut r = Rig::new();
    r.out(initialize_request("init-1", None));
    r.rpc(json!({ "jsonrpc": "2.0", "id": 1, "result": {} }));
    r.clear();
    r.out(json!({ "type": "control_request", "request_id": "int-1",
                  "request": { "subtype": "interrupt" } }));
    println!("[e1] frames={} rpcs={}", r.frames.len(), r.rpcs.len());
    assert!(r.rpcs.is_empty());
    assert!(r.frames.is_empty(), "상태기계가 interrupt의 응답을 기다리면 굳는다");
}

/// **공격**: 중단 뒤 서버가 `turn/completed{interrupted}`를 영영 안 주면?
/// (2.6.2는 3s 캡으로 스스로 마감한다 — engine.ts의 중단 캡)
#[test]
fn e2_interrupt_without_a_completed_never_settles_here() {
    let mut r = started();
    r.out(json!({ "type": "control_request", "request_id": "int-1",
                  "request": { "subtype": "interrupt" } }));
    assert_eq!(r.rpcs.len(), 1, "turn/interrupt는 나간다");
    assert_eq!(r.rpcs[0]["method"], "turn/interrupt");
    r.clear();
    // 서버가 응답만 주고 통지를 안 준다
    r.rpc(json!({ "jsonrpc": "2.0", "id": 4, "result": {} }));
    println!("[e2] 통지 없이 frames={}", r.frames.len());
    assert!(r.frames.is_empty(), "옮김기는 스스로 마감하지 않는다(상태기계의 캡에 맡긴다)");
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑥ 수용량 초과 — 2.6.2는 activeThreadId 조건이 붙는다(engine.ts:620)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn f1_capacity_error_does_not_settle_but_speaks() {
    let mut r = started();
    r.rpc(json!({ "method": "error", "params": { "threadId": "th-1", "turnId": "tu-1", "willRetry": false,
        "error": { "message": "We're at capacity — try a different model",
                   "codexErrorInfo": "serverOverloaded" } } }));
    println!("[f1] frames={}", serde_json::to_string(&r.frames).unwrap());
    assert_eq!(r.results().len(), 0, "수용량은 turn/completed가 정착시킨다");
    assert_eq!(r.frames[0]["subtype"], "notification");
}

/// **공격**: 수용량 오류 뒤 turn/completed{failed}가 오면 정착하는가(카드 1장).
#[test]
fn f2_capacity_then_completed_settles_once() {
    let mut r = started();
    r.rpc(json!({ "method": "error", "params": { "threadId": "th-1", "turnId": "tu-1", "willRetry": false,
        "error": { "message": "at capacity", "codexErrorInfo": "serverOverloaded" } } }));
    r.rpc(json!({ "method": "turn/completed", "params": { "threadId": "th-1",
        "turn": { "id": "tu-1", "status": "failed", "error": { "message": "at capacity" } } } }));
    println!("[f2] results={}", r.results().len());
    assert_eq!(r.results().len(), 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑦ 다중 턴 — 한 프로세스에서 두 턴을 돌리면(T16 상주 재사용)
// ─────────────────────────────────────────────────────────────────────────────

/// **공격(현실 경로)**: 1턴이 실패로 정착(카드 1장) → 사용자가 다시 보냄(2턴) →
/// 1턴의 늦은 error가 도착. 2.6.2는 turnId 게이트 3종으로 막는다(engine.ts:606-609).
#[test]
fn g1_a_late_error_from_turn1_kills_turn2() {
    let mut r = started();
    // 1턴 — 치명 오류로 정착
    r.rpc(json!({ "method": "error", "params": { "threadId": "th-1", "turnId": "tu-1",
        "willRetry": false, "error": { "message": "401" } } }));
    assert_eq!(r.results().len(), 1);
    r.clear();
    // 2턴 — 같은 프로세스·같은 스레드(T16 상주 재사용)
    r.out(user_message("다시 해 줘"));
    r.rpc(json!({ "jsonrpc": "2.0", "id": 4, "result": { "turn": { "id": "tu-2" } } }));
    r.rpc(json!({ "method": "item/agentMessage/delta",
                  "params": { "threadId": "th-1", "itemId": "m1", "delta": "안녕" } }));
    r.clear();
    // 1턴의 재시도 스톰이 늦게 도착
    r.rpc(json!({ "method": "error", "params": { "threadId": "th-1", "turnId": "tu-1",
        "willRetry": false, "error": { "message": "stale 401 from turn 1" } } }));
    let n = r.results().len();
    println!("[g1] 2턴 중 늦은 tu-1 error → results={n} {}", serde_json::to_string(&r.frames).unwrap());
    assert_eq!(n, 0, "★ 1턴의 잔재가 2턴을 즉사시킨다");
}

/// **공격**: 1턴의 늦은 `turn/completed`가 2턴을 정착시키는가.
/// 2.6.2: `if (this.activeTurnId && turn.id !== this.activeTurnId) return`(engine.ts:598).
#[test]
fn g2_a_late_turn_completed_from_turn1_settles_turn2() {
    let mut r = started();
    // 1턴을 상태기계가 스스로 마감했다고 가정(T11 무음 정착 — 옮김기는 모른다).
    // 서버는 아직 tu-1의 completed를 안 보냈다.
    r.clear();
    // 2턴 시작
    r.out(user_message("두 번째"));
    r.rpc(json!({ "jsonrpc": "2.0", "id": 4, "result": { "turn": { "id": "tu-2" } } }));
    r.rpc(json!({ "method": "turn/started", "params": { "threadId": "th-1", "turn": { "id": "tu-2" } } }));
    r.clear();
    // 1턴의 늦은 완료가 도착
    r.rpc(json!({ "method": "turn/completed", "params": { "threadId": "th-1",
        "turn": { "id": "tu-1", "status": "interrupted" } } }));
    let n = r.results().len();
    println!("[g2] results={n} {}", serde_json::to_string(&r.frames).unwrap());
    assert_eq!(n, 0, "★ 1턴의 늦은 completed가 2턴을 정착시킨다");
}

/// **공격**: `turn/completed` 없이 상태기계가 턴을 마감하면 `turn_id`가 안 지워진다 →
/// 다음 턴의 `turn/interrupt`가 **옛 turnId**로 나간다(= Esc가 안 먹는다).
#[test]
fn g3_stale_turn_id_misroutes_the_next_interrupt() {
    let mut r = started();     // turn_id = tu-1
    // 서버가 tu-1의 completed를 안 준 채(무음 턴) 상태기계가 T11로 마감했다.
    // 사용자가 새 프롬프트를 보낸다 → turn/start 응답이 tu-2를 준다.
    r.out(user_message("두 번째"));
    r.rpc(json!({ "jsonrpc": "2.0", "id": 4, "result": { "turn": { "id": "tu-2" } } }));
    r.rpc(json!({ "method": "turn/started", "params": { "threadId": "th-1", "turn": { "id": "tu-2" } } }));
    r.clear();
    // Esc — 지금 도는 턴은 tu-2다.
    r.out(json!({ "type": "control_request", "request_id": "int-1",
                  "request": { "subtype": "interrupt" } }));
    let sent = r.rpcs.iter().find(|x| x["method"] == "turn/interrupt").cloned().unwrap();
    println!("[g3] turn/interrupt → {}", sent["params"]);
    assert_eq!(sent["params"]["turnId"], "tu-2", "★ 중단이 옛 턴을 겨눈다 = Esc 무효");
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑧ 백그라운드 셸 — 사용자가 '중지'를 눌렀을 때의 정착 사연
// ─────────────────────────────────────────────────────────────────────────────

/// 2.6.2는 `stopped`를 기억해 `status:'stopped'`(사유 없음)로 정착시킨다
/// (engine.ts:867-877 · 1415 — "우리가 죽인 프로세스는 exit -1 + status failed로 온다").
#[test]
fn h1_a_user_stopped_background_shell_should_not_read_as_failed() {
    let mut r = started();
    // 명령 행 하나 → 백그라운드로 전환
    r.rpc(json!({ "method": "item/started", "params": { "threadId": "th-1",
        "item": { "id": "i1", "type": "commandExecution", "command": "npm run dev" } } }));
    r.rpc(json!({ "jsonrpc": "2.0", "id": 4, "result": { "data": [
        { "itemId": "i1", "processId": "p-1", "command": "npm run dev" } ] } }));
    // 위 응답은 pending이 없으면 무시되므로 tick으로 list를 먼저 보낸다
    r.clear();
    let e = r.t.tick(999_999);
    r.take(e);
    let list_id = r.rpcs.iter().find(|x| x["method"] == "thread/backgroundTerminals/list")
        .and_then(|x| x["id"].as_i64()).expect("list 나감");
    r.clear();
    r.rpc(json!({ "jsonrpc": "2.0", "id": list_id, "result": { "data": [
        { "itemId": "i1", "processId": "p-1", "command": "npm run dev" } ] } }));
    let chip = r.frames.iter().find(|f| f["subtype"] == "background_tasks_changed").cloned().unwrap();
    println!("[h1] 칩 = {}", chip["tasks"]);
    r.clear();
    // 사용자가 칩의 '중지'를 눌렀다 → stop_task
    r.out(json!({ "type": "control_request", "request_id": "st-1",
                  "request": { "subtype": "stop_task", "task_id": "p-1" } }));
    println!("[h1] terminate rpc = {}", serde_json::to_string(&r.rpcs).unwrap());
    r.clear();
    // 실측: 우리가 죽인 프로세스는 exit -1 + failed로 온다
    r.rpc(json!({ "method": "item/completed", "params": { "threadId": "th-1",
        "item": { "id": "i1", "type": "commandExecution", "exitCode": -1, "aggregatedOutput": "" } } }));
    let notif = r.frames.iter().find(|f| f["subtype"] == "task_notification").cloned().unwrap();
    println!("[h1] 정착 통지 = {notif}");
    assert_eq!(notif["status"], "stopped", "★ 사용자가 멈춘 셸이 '실패 exit -1'로 뜬다");
}

/// 2.6.2는 백그라운드로 넘어간 명령이 **자연 종료**하면 최종 출력으로 도구 행을 되살린다
/// (engine.ts:851-866). 3.0은 행을 되살리는 프레임이 없다 → 로그를 못 본다.
#[test]
fn h2_a_finished_background_command_revives_its_tool_row() {
    let mut r = started();
    r.rpc(json!({ "method": "item/started", "params": { "threadId": "th-1",
        "item": { "id": "i1", "type": "commandExecution", "command": "build" } } }));
    r.clear();
    let e = r.t.tick(999_999);
    r.take(e);
    let list_id = r.rpcs.iter().find(|x| x["method"] == "thread/backgroundTerminals/list")
        .and_then(|x| x["id"].as_i64()).unwrap();
    r.clear();
    r.rpc(json!({ "jsonrpc": "2.0", "id": list_id, "result": { "data": [
        { "itemId": "i1", "processId": "p-1", "command": "build" } ] } }));
    r.clear();
    r.rpc(json!({ "method": "item/completed", "params": { "threadId": "th-1",
        "item": { "id": "i1", "type": "commandExecution", "exitCode": 0,
                  "aggregatedOutput": "BUILD-LOG-1234", "durationMs": 900 } } }));
    println!("[h2] frames = {}", serde_json::to_string(&r.frames).unwrap());
    let has_log = r.frames.iter().any(|f| serde_json::to_string(f).unwrap().contains("BUILD-LOG-1234"));
    assert!(has_log, "★ 백그라운드 명령의 최종 출력이 어디에도 안 실린다");
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑨ 사이드체인 — 서브에이전트 스레드의 turn/completed (engine.ts:806-823)
// ─────────────────────────────────────────────────────────────────────────────

/// 2.6.2는 서브에이전트 스레드의 `turn/completed`로 카드를 **완료**시킨다
/// ("턴 완료가 곧 작업 완료(+소요)" — engine.ts:737-739·806-823).
/// 3.0 `on_agent_notification`은 `item/started`·`item/completed` 둘만 받는다.
#[test]
fn i1_a_subagent_thread_turn_completed_closes_the_task_row() {
    let mut r = started();
    // subAgentActivity{started} → Task 도구 행이 열린다
    r.rpc(json!({ "method": "item/started", "params": { "threadId": "th-1",
        "item": { "id": "sa1", "type": "subAgentActivity", "kind": "started",
                  "agentThreadId": "ag-1", "agentPath": "agents/explore" } } }));
    let opened = r.frames.iter().any(|f| serde_json::to_string(f).unwrap().contains("\"Task\""));
    assert!(opened, "Task 행이 안 열렸다: {:?}", r.frames);
    r.clear();
    // 서브에이전트 스레드가 턴을 끝냈다
    r.rpc(json!({ "method": "turn/completed", "params": { "threadId": "ag-1",
        "turn": { "id": "ag-tu-1", "status": "completed", "durationMs": 500 } } }));
    println!("[i1] frames={}", serde_json::to_string(&r.frames).unwrap());
    let closed = r.frames.iter().any(|f| serde_json::to_string(f).unwrap().contains("tool_result"));
    assert!(closed, "★ 서브에이전트 카드가 영영 '실행 중'으로 남는다(도구 행 미정착)");
}

/// 같은 자리의 `turn/started`(sendInput 재개)도 2.6.2는 카드를 실행 중으로 되돌린다.
#[test]
fn i2_a_subagent_thread_turn_started_reopens_the_card() {
    let mut r = started();
    r.rpc(json!({ "method": "item/started", "params": { "threadId": "th-1",
        "item": { "id": "sa1", "type": "subAgentActivity", "kind": "started", "agentThreadId": "ag-1" } } }));
    r.clear();
    r.rpc(json!({ "method": "turn/started", "params": { "threadId": "ag-1", "turn": { "id": "ag-tu-2" } } }));
    println!("[i2] frames={}", serde_json::to_string(&r.frames).unwrap());
    assert!(!r.frames.is_empty(), "★ 서브에이전트 턴 재개가 화면에 안 보인다");
}
