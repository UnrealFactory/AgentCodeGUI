//! **Codex 와이어 재생** — 2.6.2 코드에서 뽑은 프레임 스키마를 합성 대본으로 되돌린다.
//!
//! ## 출처 (추측한 자리는 없다)
//!
//! 여기 나오는 JSON은 전부 `src/main/codex/engine.ts`(2.6.2, codex-cli 0.144.3~0.144.4
//! 실측이라 주석에 적힌 판)의 **읽는 코드**에서 역산했다. 각 대본 줄 위에 근거 줄 번호를
//! 적었고, 같은 목록이 [`ccg_engine::codex::FRAME_MAP`]에 데이터로 있다. 실 계정이 0건
//! (M5 실측)이라 라이브로 다시 관측할 수 없는 값은 **역산 그대로**이고, 그 사실이 이
//! 파일의 한계다 — 스키마가 틀렸다면 여기 통과하는 코드도 틀린다.
//!
//! ## 게이트
//!
//! [`frame_map_is_fully_replayed`]가 `FRAME_MAP`의 **모든 행**을 이 파일이 한 번씩
//! 밟았는지 센다. 표에 행을 더하고 재생을 안 쓰면 붉어진다(`state.rs`의 커버리지 규약과 같다).

use ccg_engine::codex::transcode::Egress;
use ccg_engine::codex::{build_plan, CodexPlan, Transcoder, FRAME_MAP};
use ccg_engine::driver::{build_spawn_spec, control_response, initialize_request, user_message};
use ccg_engine::identity::*;
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::BTreeSet;

thread_local! {
    static COVER: RefCell<BTreeSet<&'static str>> = RefCell::new(BTreeSet::new());
    /// 재생이 **실제로 낸** 프레임의 모양(`type` · `type/subtype`).
    static SHAPES: RefCell<BTreeSet<String>> = RefCell::new(BTreeSet::new());
    /// 재생이 실제로 낸 `assistant{tool_use}`의 이름.
    static TOOLS: RefCell<BTreeSet<String>> = RefCell::new(BTreeSet::new());
    /// 재생이 실제로 stdin으로 보낸 JSON-RPC method.
    static METHODS: RefCell<BTreeSet<String>> = RefCell::new(BTreeSet::new());
    /// `parent_tool_use_id`가 붙은 프레임을 한 번이라도 냈는가.
    static SIDECHAIN: RefCell<bool> = const { RefCell::new(false) };
}
fn cover(k: &'static str) {
    COVER.with(|c| c.borrow_mut().insert(k));
}

/// 산출 하나를 장부에 적는다 — **게이트가 `wire` 열 밖도 볼 수 있게 하는 재료**.
/// 표의 `to` 열이 "무엇이 된다"고 적은 것을 재생이 실제로 냈는지 대조하는 데 쓴다
/// (크리틱 §5: 게이트가 `wire` 문자열만 세는 동안 `to`·`src` 열이 세 번 낡았다).
fn record_frame(f: &Value) {
    let Some(ty) = f["type"].as_str().filter(|t| !t.is_empty()) else { return };
    SHAPES.with(|s| {
        let mut s = s.borrow_mut();
        s.insert(ty.to_string());
        if let Some(sub) = f["subtype"].as_str() {
            s.insert(format!("{ty}/{sub}"));
        }
    });
    if f.get("parent_tool_use_id").map(|x| !x.is_null()).unwrap_or(false) {
        SIDECHAIN.with(|c| *c.borrow_mut() = true);
    }
    if let Some(blocks) = f["message"]["content"].as_array() {
        for b in blocks {
            if b["type"] == "tool_use" {
                if let Some(n) = b["name"].as_str() {
                    TOOLS.with(|t| t.borrow_mut().insert(n.to_string()));
                }
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────

struct Rig {
    t: Transcoder,
    frames: Vec<Value>,
    rpcs: Vec<Value>,
    tails: Vec<(String, String)>,
}

impl Rig {
    fn new(plan: CodexPlan) -> Rig {
        Rig { t: Transcoder::new(plan), frames: vec![], rpcs: vec![], tails: vec![] }
    }
    fn take(&mut self, e: Vec<Egress>) {
        for x in e {
            match x {
                Egress::Frame(f) => {
                    record_frame(&f);
                    self.frames.push(f);
                }
                Egress::Rpc(r) => {
                    if let Some(m) = r["method"].as_str() {
                        METHODS.with(|s| s.borrow_mut().insert(m.to_string()));
                    }
                    self.rpcs.push(r);
                }
                Egress::Tail { file, text } => self.tails.push((file, text)),
            }
        }
    }
    /// 상태기계 → 드라이버 (컨트롤 봉투 한 줄).
    fn out(&mut self, v: Value) -> &mut Self {
        let e = self.t.on_outgoing(&v, 0);
        self.take(e);
        self
    }
    /// app-server → 드라이버 (JSON-RPC 한 줄).
    fn rpc(&mut self, v: Value) -> &mut Self {
        let e = self.t.on_rpc(&v, 1_000);
        self.take(e);
        self
    }
    fn tick(&mut self, now: u64) -> &mut Self {
        let e = self.t.tick(now);
        self.take(e);
        self
    }
    fn clear(&mut self) {
        self.frames.clear();
        self.rpcs.clear();
        self.tails.clear();
    }
    /// 마지막으로 나간 RPC 중 그 method의 것.
    fn sent(&self, method: &str) -> Option<&Value> {
        self.rpcs.iter().rev().find(|r| r["method"] == method)
    }
    fn frames_of(&self, ty: &str) -> Vec<&Value> {
        self.frames.iter().filter(|f| f["type"] == ty).collect()
    }
}

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

/// 핸드셰이크까지 밀어 둔 리그(대부분의 시나리오가 여기서 시작한다).
fn started() -> Rig {
    let mut r = Rig::new(plan());
    r.out(initialize_request("init-1", None));
    cover("initialize");
    r.rpc(json!({ "jsonrpc": "2.0", "id": 1, "result": { "userAgent": "codex/0.149.0" } }));
    r.out(user_message("작업 시작"));
    r.rpc(json!({ "jsonrpc": "2.0", "id": 2, "result": { "thread": { "id": "th-1" } } }));
    cover("thread/start");
    // turn/start 응답 (engine.ts:1652-1663 — `{turn:{id}}`)
    r.rpc(json!({ "jsonrpc": "2.0", "id": 3, "result": { "turn": { "id": "tu-1" } } }));
    cover("turn/start");
    r.clear();
    r
}

// ─────────────────────────────────────────────────────────────────────────────
// ① 핸드셰이크 — T2의 두 조각
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn handshake_produces_both_halves_of_t2() {
    let mut r = Rig::new(plan());
    r.out(initialize_request("init-1", None));
    cover("initialize");
    // engine.ts:386-391 — clientInfo + capabilities.experimentalApi
    let init = r.sent("initialize").expect("initialize가 나갔다").clone();
    assert_eq!(init["params"]["capabilities"]["experimentalApi"], true);
    assert_eq!(init["params"]["clientInfo"]["name"], "agentcodegui");

    r.rpc(json!({ "jsonrpc": "2.0", "id": 1, "result": {} }));
    assert_eq!(r.frames[0]["type"], "control_response");
    assert_eq!(r.frames[0]["response"]["request_id"], "init-1", "T2의 init_ack");

    r.out(user_message("첫 지시"));
    // engine.ts:1628-1638 — thread/start {cwd, model, approvalPolicy, sandbox, config}
    let ts = r.sent("thread/start").expect("thread/start").clone();
    assert_eq!(ts["params"]["cwd"], "C:\\w");
    assert_eq!(ts["params"]["approvalPolicy"], "untrusted");
    assert_eq!(ts["params"]["sandbox"], "workspace-write");
    assert!(ts["params"]["config"]["tools"]["experimental_request_user_input"].is_object());
    assert_eq!(ts["params"]["config"]["features"]["unified_exec"], true);

    r.rpc(json!({ "jsonrpc": "2.0", "id": 2, "result": { "thread": { "id": "th-1" } } }));
    cover("thread/start");
    let init_frame = r.frames_of("system").into_iter().find(|f| f["subtype"] == "init").expect("system/init");
    assert_eq!(init_frame["session_id"], "th-1", "T2의 init_frame + resume 키");
    assert_eq!(init_frame["model"], "gpt-5.6-terra");

    // engine.ts:1652-1657 — turn/start {threadId, input[{type,text,text_elements}], model, effort}
    let tu = r.sent("turn/start").expect("turn/start").clone();
    assert_eq!(tu["params"]["threadId"], "th-1");
    assert_eq!(tu["params"]["input"][0]["type"], "text");
    assert!(tu["params"]["input"][0]["text_elements"].is_array(), "실측 스키마의 필수 자리");
    assert_eq!(tu["params"]["effort"], "medium");
    cover("turn/start");
}

#[test]
fn resume_reuses_the_saved_thread_id() {
    // engine.ts:1617-1626 — thread/resume {threadId, …}
    let mut r = Rig::new(CodexPlan { resume: Some("th-old".into()), ..plan() });
    r.out(initialize_request("init-1", None));
    r.rpc(json!({ "jsonrpc": "2.0", "id": 1, "result": {} }));
    r.out(user_message("이어서"));
    let rs = r.sent("thread/resume").expect("thread/resume").clone();
    assert_eq!(rs["params"]["threadId"], "th-old");
    assert!(r.sent("thread/start").is_none(), "resume가 있으면 start를 부르지 않는다");
    // 서버가 id를 안 주면 우리가 준 id를 그대로 쓴다(engine.ts:1626 `?? req.resume`).
    r.rpc(json!({ "jsonrpc": "2.0", "id": 2, "result": {} }));
    let init_frame = r.frames_of("system").into_iter().find(|f| f["subtype"] == "init").unwrap();
    assert_eq!(init_frame["session_id"], "th-old");
    cover("thread/resume");
}

#[test]
fn context_overrides_reach_start_and_resume_without_disabling_other_features() {
    use ccg_engine::codex::ContextOverrides;
    for resume in [None, Some("th-existing".to_string())] {
        for management in [None, Some(true), Some(false)] {
            let mut p = plan();
            p.resume = resume.clone();
            p.context = ContextOverrides { management, window: Some(512000), compact: Some(430000) };
            let mut r = Rig::new(p);
            r.out(initialize_request("context-init", None));
            r.rpc(json!({"id":1,"result":{}}));
            r.out(user_message("context settings"));
            let request = r.sent(if resume.is_some() { "thread/resume" } else { "thread/start" }).unwrap();
            let c = &request["params"]["config"];
            assert_eq!(c["model_context_window"], 512000);
            assert_eq!(c["model_auto_compact_token_limit"], 430000);
            assert_eq!(c["features"]["unified_exec"], true);
            assert!(c["tools"]["experimental_request_user_input"].is_object());
            match management {
                Some(enabled) => assert_eq!(c["features"]["context_management"]["experimental_mode"], enabled),
                None => assert!(c["features"].get("context_management").is_none()),
            }
        }
    }
    let p = plan().thread_params();
    assert!(p["config"].get("model_context_window").is_none());
    assert!(p["config"].get("model_auto_compact_token_limit").is_none());
}

// ─────────────────────────────────────────────────────────────────────────────
// ② 스트리밍 · 생각 줄
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn streaming_deltas_become_claude_stream_events() {
    let mut r = started();
    // engine.ts:575-582 — turn/started가 응답보다 먼저 올 수 있다
    r.rpc(json!({ "method": "turn/started", "params": { "threadId": "th-1", "turn": { "id": "tu-1" } } }));
    cover("turn/started");

    // engine.ts:498-506 — reasoning 델타 두 종류
    r.rpc(json!({ "method": "item/reasoning/summaryTextDelta",
                  "params": { "threadId": "th-1", "itemId": "r1", "delta": "무엇부터 할지 고르는 중" } }));
    cover("item/reasoning/summaryTextDelta");
    let th = &r.frames[0]["event"]["delta"];
    assert_eq!(th["type"], "thinking_delta");
    assert_eq!(th["thinking"], "무엇부터 할지 고르는 중");
    r.rpc(json!({ "method": "item/reasoning/textDelta",
                  "params": { "threadId": "th-1", "itemId": "r1", "delta": " …그리고 계속" } }));
    cover("item/reasoning/textDelta");
    assert_eq!(
        r.frames[1]["event"]["delta"]["thinking"], "무엇부터 할지 고르는 중 …그리고 계속",
        "생각 버퍼는 누적이고 꼬리를 보낸다(engine.ts:501-504)"
    );
    // engine.ts:507-510 — 요약 파트가 새로 열리면 버퍼를 비운다
    r.rpc(json!({ "method": "item/reasoning/summaryPartAdded", "params": { "threadId": "th-1", "itemId": "r1" } }));
    cover("item/reasoning/summaryPartAdded");
    r.clear();
    r.rpc(json!({ "method": "item/reasoning/summaryTextDelta",
                  "params": { "threadId": "th-1", "itemId": "r1", "delta": "새 요약" } }));
    assert_eq!(r.frames[0]["event"]["delta"]["thinking"], "새 요약", "버퍼가 비워졌다");

    // engine.ts:489-497 — 답변 델타. 첫 델타가 블록을 연다(렌더러의 messageId 발급 지점).
    r.clear();
    r.rpc(json!({ "method": "item/agentMessage/delta",
                  "params": { "threadId": "th-1", "itemId": "m1", "delta": "안녕" } }));
    cover("item/agentMessage/delta");
    assert_eq!(r.frames[0]["event"]["type"], "content_block_start");
    assert_eq!(r.frames[1]["event"]["delta"]["text"], "안녕");
    r.clear();
    r.rpc(json!({ "method": "item/agentMessage/delta",
                  "params": { "threadId": "th-1", "itemId": "m1", "delta": "하세요" } }));
    assert_eq!(r.frames.len(), 1, "같은 메시지의 둘째 델타는 블록을 다시 열지 않는다");

    // engine.ts:835-838 — 완성 답변
    r.clear();
    r.rpc(json!({ "method": "item/completed",
                  "params": { "threadId": "th-1", "item": { "id": "m1", "type": "agentMessage", "text": "안녕하세요" } } }));
    cover("item/completed{agentMessage}");
    assert_eq!(r.frames[0]["message"]["content"][0]["text"], "안녕하세요");
    // engine.ts:839-842 — reasoning 완료는 버퍼만 비운다
    r.clear();
    r.rpc(json!({ "method": "item/completed",
                  "params": { "threadId": "th-1", "item": { "id": "r1", "type": "reasoning" } } }));
    cover("item/completed{reasoning}");
    assert!(r.frames.is_empty());
}

// ─────────────────────────────────────────────────────────────────────────────
// ③ 도구 4종
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn tool_items_become_tool_use_and_tool_result() {
    let mut r = started();
    // engine.ts:644-646 — commandExecution
    r.rpc(json!({ "method": "item/started", "params": { "threadId": "th-1",
        "item": { "id": "i1", "type": "commandExecution", "command": "cargo test" } } }));
    cover("item/started{commandExecution}");
    let tu = &r.frames[0]["message"]["content"][0];
    assert_eq!(tu["name"], "Bash");
    assert_eq!(tu["input"]["command"], "cargo test");

    // engine.ts:520-532 — 출력 델타는 누적만(프레임 없음)
    r.clear();
    r.rpc(json!({ "method": "item/commandExecution/outputDelta",
                  "params": { "threadId": "th-1", "itemId": "i1", "delta": "test result: ok" } }));
    cover("item/commandExecution/outputDelta");
    assert!(r.frames.is_empty());

    // engine.ts:843-896 — 완료(exitCode·aggregatedOutput)
    r.rpc(json!({ "method": "item/completed", "params": { "threadId": "th-1",
        "item": { "id": "i1", "type": "commandExecution", "exitCode": 0,
                  "aggregatedOutput": "test result: ok. 55 passed", "durationMs": 120 } } }));
    cover("item/completed{commandExecution}");
    let res = &r.frames[0]["message"]["content"][0];
    assert_eq!(res["tool_use_id"], "i1");
    assert_eq!(res["is_error"], false);
    assert_eq!(res["content"], "test result: ok. 55 passed");

    // engine.ts:647-651 · 897-955 — fileChange
    r.clear();
    r.rpc(json!({ "method": "item/started", "params": { "threadId": "th-1",
        "item": { "id": "i2", "type": "fileChange", "changes": [{ "path": "src/a.rs" }] } } }));
    cover("item/started{fileChange}");
    assert_eq!(
        r.frames[0]["message"]["content"][0]["name"], "codex_file_change",
        "Claude의 Edit로 위장하면 셸의 diff 조립기가 빈 변경을 만든다"
    );
    r.clear();
    r.rpc(json!({ "method": "item/completed", "params": { "threadId": "th-1",
        "item": { "id": "i2", "type": "fileChange", "status": "completed", "changes": [
            { "path": "src/a.rs", "kind": { "type": "update" }, "diff": "@@ -1 +1 @@\n-a\n+b\n" }] } } }));
    cover("item/completed{fileChange}");
    assert_eq!(r.frames[0]["subtype"], "ccg_codex");
    assert_eq!(r.frames[0]["kind"], "file_change");
    assert_eq!(r.frames[0]["changes"][0]["kind"]["type"], "update");
    assert_eq!(r.frames[1]["message"]["content"][0]["tool_use_id"], "i2", "행은 tool_result가 닫는다");

    // engine.ts:652-654 · 956-973 — mcpToolCall
    r.clear();
    r.rpc(json!({ "method": "item/started", "params": { "threadId": "th-1",
        "item": { "id": "i3", "type": "mcpToolCall", "server": "sqlite", "tool": "query" } } }));
    cover("item/started{mcpToolCall}");
    assert_eq!(r.frames[0]["message"]["content"][0]["name"], "mcp__sqlite__query");

    // engine.ts:655-659 — webSearch. 검색어는 **완료에만** 실린다(started는 빈 문자열).
    r.clear();
    r.rpc(json!({ "method": "item/started", "params": { "threadId": "th-1",
        "item": { "id": "i4", "type": "webSearch", "query": "", "action": null } } }));
    cover("item/started{webSearch}");
    assert_eq!(r.frames[0]["message"]["content"][0]["input"]["query"], "검색 중…");
    r.clear();
    r.rpc(json!({ "method": "item/completed", "params": { "threadId": "th-1",
        "item": { "id": "i4", "type": "webSearch", "status": "completed",
                  "action": { "type": "search", "queries": ["rust jsonrpc"] } } } }));
    cover("item/completed{mcpToolCall|webSearch}");
    assert_eq!(r.frames[0]["message"]["content"][0]["content"], "rust jsonrpc");
    assert_eq!(r.frames[0]["message"]["content"][0]["ccg_web_target"], "rust jsonrpc");
}

#[test]
fn mcp_details_keep_arguments_text_structured_results_and_errors() {
    // Shapes verified against codex 0.153.4 generate-ts: ThreadItem/McpToolCallResult/Error.
    let mut r = started();
    r.rpc(json!({ "method": "item/started", "params": { "threadId": "th-1",
        "item": { "id": "m1", "type": "mcpToolCall", "server": "sample", "tool": "lookup",
            "arguments": { "query": "실제 요청", "limit": 3 } } } }));
    assert_eq!(r.frames[0]["message"]["content"][0]["input"], json!({"query":"실제 요청","limit":3}));
    r.clear();
    r.rpc(json!({ "method": "item/completed", "params": { "threadId": "th-1",
        "item": { "id": "m1", "type": "mcpToolCall", "status": "completed", "durationMs": 123,
            "result": { "content": [{ "type": "text", "text": "실제 결과" },
                { "type": "resource", "resource": { "uri": "file:///example", "text": "resource body" } },
                { "type": "image", "data": "BASE64_NOT_FOR_LOGS", "mimeType": "image/png" }],
                "structuredContent": { "found": 3 }, "_meta": { "hidden": "PRIVATE_META" } }, "error": null } } }));
    let block = &r.frames[0]["message"]["content"][0];
    let body = block["content"].as_str().unwrap();
    assert!(body.contains("실제 결과") && body.contains("resource body") && body.contains("\"found\": 3"));
    assert!(body.contains("[image]") && !body.contains("BASE64_NOT_FOR_LOGS") && !body.contains("PRIVATE_META"));
    assert_eq!(block["is_error"], false);
    assert_eq!(block["ccg_duration_ms"], 123);
    r.clear();
    r.rpc(json!({ "method": "item/completed", "params": { "threadId": "th-1",
        "item": { "id": "m2", "type": "mcpToolCall", "status": "failed", "result": null,
            "error": { "message": "Permission denied by server" } } } }));
    assert_eq!(r.frames[0]["message"]["content"][0]["content"], "Permission denied by server");
    assert_eq!(r.frames[0]["message"]["content"][0]["is_error"], true);
}

#[test]
fn command_completion_uses_status_even_without_an_exit_code() {
    for (status, code, failed) in [
        ("failed", Value::Null, true), ("declined", Value::Null, true),
        ("completed", json!(2), true), ("completed", json!(0), false),
        ("completed", Value::Null, false),
    ] {
        let mut r = started();
        r.rpc(json!({"method":"item/completed","params":{"threadId":"th-1",
            "item":{"id":"cmd","type":"commandExecution","status":status,"exitCode":code,"aggregatedOutput":"","durationMs":12}}}));
        let block = &r.frames[0]["message"]["content"][0];
        assert_eq!(block["is_error"], failed, "{status} / {code}");
        assert_eq!(block["ccg_exit_code"], code);
        assert_eq!(block["ccg_duration_ms"], 12);
        if failed { assert!(!block["content"].as_str().unwrap().is_empty(), "empty failures need a reason"); }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ④ 승인 · 질문 (서버→클라 요청)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn all_four_approval_shapes_and_the_question_card() {
    let mut r = started();
    // engine.ts:428-433
    r.rpc(json!({ "id": 11, "method": "item/commandExecution/requestApproval",
                  "params": { "threadId": "th-1", "command": "rm -rf build", "reason": "위험" } }));
    cover("item/commandExecution/requestApproval");
    let c = r.frames[0].clone();
    assert_eq!(c["request"]["subtype"], "can_use_tool");
    assert_eq!(c["request"]["tool_name"], "Bash");
    let rid = c["request_id"].as_str().unwrap().to_string();
    r.clear();
    r.out(control_response(&rid, None, json!({ "behavior": "allow" })));
    cover("control_response{승인}");
    assert_eq!(r.rpcs[0]["id"], 11);
    assert_eq!(r.rpcs[0]["result"]["decision"], "accept");

    // engine.ts:434-438 (legacy)
    r.clear();
    r.rpc(json!({ "id": 12, "method": "execCommandApproval", "params": { "command": ["git", "push"] } }));
    cover("execCommandApproval(legacy)");
    let rid = r.frames[0]["request_id"].as_str().unwrap().to_string();
    r.clear();
    r.out(control_response(&rid, None, json!({ "behavior": "allow", "ccgAlways": true })));
    cover("control_response{legacy 승인}");
    assert_eq!(r.rpcs[0]["result"]["decision"], "approved_for_session");

    // engine.ts:439-443
    r.clear();
    r.rpc(json!({ "id": 13, "method": "item/fileChange/requestApproval",
                  "params": { "threadId": "th-1", "reason": "src/a.rs 수정" } }));
    cover("item/fileChange/requestApproval");
    assert_eq!(r.frames[0]["request"]["tool_name"], "Edit");
    assert_eq!(r.frames[0]["request"]["description"], "src/a.rs 수정");

    // engine.ts:444-447 (legacy)
    r.clear();
    r.rpc(json!({ "id": 14, "method": "applyPatchApproval", "params": { "threadId": "th-1" } }));
    cover("applyPatchApproval(legacy)");
    assert_eq!(r.frames[0]["request"]["tool_name"], "Edit");

    // engine.ts:448-470 — 질문 카드
    r.clear();
    r.rpc(json!({ "id": 15, "method": "item/tool/requestUserInput", "params": { "threadId": "th-1", "questions": [
        { "id": "q1", "header": "선택", "question": "어느 쪽으로?",
          "options": [{ "label": "A", "description": "가" }, { "label": "B", "description": "나" }] }] } }));
    cover("item/tool/requestUserInput");
    let q = r.frames[0].clone();
    assert_eq!(q["request"]["tool_name"], "AskUserQuestion");
    assert_eq!(q["request"]["input"]["questions"][0]["multiSelect"], false);
    assert_eq!(q["request"]["input"]["questions"][0]["options"][1]["label"], "B");
    let rid = q["request_id"].as_str().unwrap().to_string();
    r.clear();
    r.out(control_response(&rid, None, json!({ "behavior": "deny", "message": "…", "ccgAnswers": [["B"]] })));
    cover("control_response{질문}");
    assert_eq!(r.rpcs[0]["result"]["answers"]["q1"]["answers"][0], "B");

    // engine.ts:471-474 — 모르는 서버 요청은 **거절**한다(무시가 아니다: 서버가 기다린다)
    r.clear();
    r.rpc(json!({ "id": 16, "method": "chatgptAuthTokens/refresh" }));
    cover("(그 밖의 서버 요청)");
    assert_eq!(r.rpcs[0]["id"], 16);
    assert!(r.rpcs[0]["error"]["message"].as_str().unwrap().contains("unsupported"));
    assert!(r.frames.is_empty(), "카드로 올리지 않는다");
}

#[test]
fn async_questions_are_cards_and_answers_steer_the_same_turn() {
    let mut r = started();
    r.rpc(json!({ "method": "item/completed", "params": { "threadId": "th-1", "turnId": "tu-1",
        "item": { "type": "agentMessage", "id": "aq1", "text": "언제 떨리나요?",
            "questions": [{ "title": "언제 떨리나요?", "options": ["답변 중", "완료 후"] },
                { "title": "추가 설명", "options": null }] } } }));
    let card = r.frames.iter().find(|f| f["kind"] == "async_question").unwrap().clone();
    assert_eq!(card["questions"][0]["options"][1]["label"], "완료 후");
    assert_eq!(card["questions"][1]["options"], json!([]));
    assert!(r.frames_of("control_request").is_empty(), "async question must not block the engine");
    r.out(json!({ "type": "control_request", "request_id": card["requestId"],
        "request": { "subtype": "ccg_async_answer", "text": "답변 중" } }));
    let steer = r.sent("turn/steer").unwrap().clone();
    assert_eq!(steer["params"]["expectedTurnId"], "tu-1");
    assert_eq!(steer["params"]["input"][0]["text"], "답변 중");
    assert!(r.sent("turn/interrupt").is_none());
    assert!(r.sent("turn/start").is_none());
    r.rpc(json!({ "id": steer["id"], "result": { "turnId": "tu-1" } }));
    assert_eq!(r.frames.last().unwrap()["kind"], "async_answer_result");
    assert!(r.frames.last().unwrap()["error"].is_null());
    r.out(json!({ "type": "control_request", "request_id": card["requestId"],
        "request": { "subtype": "ccg_async_answer", "text": "다시 답변" } }));
    let id = r.sent("turn/steer").unwrap()["id"].clone();
    r.rpc(json!({ "id": id, "error": { "code": -32600, "message": "no active turn" } }));
    assert_eq!(r.frames.last().unwrap()["error"], "no active turn");
    assert!(r.frames_of("result").is_empty(), "a rejected answer must not terminate the run");
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑤ 회계 · 오류 · 중단
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn plan_usage_errors_and_completion() {
    let mut r = started();
    // engine.ts:533-542 — turn/plan/updated
    r.rpc(json!({ "method": "turn/plan/updated", "params": { "threadId": "th-1", "plan": [
        { "step": "코드 읽기", "status": "completed" },
        { "step": "고치기", "status": "inProgress" },
        { "step": "테스트", "status": "pending" }] } }));
    cover("turn/plan/updated");
    assert_eq!(r.frames[0]["kind"], "todos");
    assert_eq!(r.frames[0]["todos"][0]["status"], "done");
    assert_eq!(r.frames[0]["todos"][1]["status"], "running");
    assert_eq!(r.frames[0]["todos"][2]["status"], "pending");

    // engine.ts:543-574 — tokenUsage
    r.clear();
    r.rpc(json!({ "method": "thread/tokenUsage/updated", "params": { "threadId": "th-1", "tokenUsage": {
        "last": { "inputTokens": 500, "cachedInputTokens": 100, "outputTokens": 40, "totalTokens": 540 },
        "total": { "inputTokens": 500, "cachedInputTokens": 100, "outputTokens": 40, "totalTokens": 540 },
        "modelContextWindow": 272000 } } }));
    cover("thread/tokenUsage/updated");
    assert_eq!(r.frames[0]["kind"], "context");
    assert_eq!(r.frames[0]["tokens"], 540);
    assert_eq!(r.frames[0]["window"], 272000);

    // engine.ts:612-619 — 재시도 오류는 안내 한 줄(턴을 죽이지 않는다)
    r.clear();
    r.rpc(json!({ "method": "error", "params": { "threadId": "th-1", "turnId": "tu-1",
        "willRetry": true, "error": { "message": "일시적인 오류" } } }));
    cover("error{willRetry:true}");
    assert_eq!(r.frames[0]["subtype"], "notification");
    assert!(r.frames_of("result").is_empty(), "재시도는 턴을 정착시키지 않는다");

    // engine.ts:583-601 · 1069-1127 — 정상 완료
    r.clear();
    r.rpc(json!({ "method": "turn/completed", "params": { "threadId": "th-1",
        "turn": { "id": "tu-1", "status": "completed", "durationMs": 4242 } } }));
    cover("turn/completed");
    let res = r.frames[0].clone();
    assert_eq!(res["type"], "result");
    assert_eq!(res["is_error"], false);
    assert_eq!(res["duration_ms"], 4242);
    // 첫 통지에서 base = total − last → 이번 턴 = last 그대로
    let mu = &res["modelUsage"]["gpt-5.6-terra"];
    assert_eq!(mu["inputTokens"], 400, "비캐시 입력 = 500 − 100");
    assert_eq!(mu["cacheReadInputTokens"], 100);
    assert_eq!(mu["outputTokens"], 40);
    assert_eq!(res["usage"]["input_tokens"], 540, "컨텍스트 게이지 자리");
}

/// **0.149.0 실측 대본** — 자격증명 없는 턴이 실제로 뱉은 순서 그대로
/// (`docs/critic/m4-r1-codex.json` `steps.handshake.unauthenticatedTurn`).
/// 재는 것: ① 재시도 안내는 카드가 아니라 안내 ② 치명 오류는 **결과 한 장**.
#[test]
fn a_fatal_error_settles_the_turn_instead_of_going_silent() {
    let mut r = started();
    // 실측: userMessage 아이템이 먼저 온다(2.6.2에 없던 타입 — 버려야 한다)
    r.rpc(json!({ "method": "item/completed", "params": { "threadId": "th-1",
        "item": { "type": "userMessage", "id": "u1", "content": [{ "type": "text", "text": "ping" }] } } }));
    cover("item/*{userMessage}");
    assert!(r.frames.is_empty(), "사용자 말풍선은 렌더러가 이미 그렸다");

    // 실측: 재시도 5회(willRetry=true) — 턴을 죽이지 않는다
    r.rpc(json!({ "method": "error", "params": { "threadId": "th-1", "turnId": "tu-1", "willRetry": true,
        "error": { "message": "Reconnecting... 2/5",
                   "codexErrorInfo": { "responseStreamDisconnected": { "httpStatusCode": 401 } } } } }));
    assert_eq!(r.frames[0]["subtype"], "notification");
    r.clear();

    // 실측: 전송 경로 강등 경고 — 0.149.0에서 새로 생긴 통지
    r.rpc(json!({ "method": "warning", "params": { "threadId": "th-1",
        "message": "Falling back from WebSockets to HTTPS transport." } }));
    cover("warning");
    assert_eq!(r.frames[0]["subtype"], "notification");
    assert!(r.frames[0]["text"].as_str().unwrap().contains("Falling back"));
    r.clear();

    // 실측: 상태 통지 3종은 화면 대응물이 없다
    for m in ["thread/started", "thread/settings/updated", "thread/status/changed"] {
        r.rpc(json!({ "method": m, "params": { "threadId": "th-1", "status": { "type": "systemError" } } }));
    }
    cover("thread/started·settings/updated·status/changed");
    r.rpc(json!({ "method": "remoteControl/status/changed", "params": {} }));
    cover("remoteControl/status/changed");
    assert!(r.frames.is_empty());

    // engine.ts:620-627 — willRetry=false는 실행 오류로 정착한다
    r.rpc(json!({ "method": "error", "params": { "threadId": "th-1", "turnId": "tu-1",
        "willRetry": false, "error": { "message": "unexpected status 401 Unauthorized", "codexErrorInfo": "other" } } }));
    cover("error{willRetry:false}");
    let res = r.frames_of("result")[0].clone();
    assert_eq!(res["is_error"], true);
    assert_eq!(res["result"], "unexpected status 401 Unauthorized");

    // ★ 실측: 같은 사연의 turn/completed{failed}가 **뒤따라 온다**. 결과 카드는 한 장뿐.
    r.clear();
    r.rpc(json!({ "method": "turn/completed", "params": { "threadId": "th-1", "turn": {
        "id": "tu-1", "status": "failed",
        "error": { "message": "unexpected status 401 Unauthorized" } } } }));
    cover("error{willRetry:false} + turn/completed{failed}");
    assert!(r.frames_of("result").is_empty(), "두 번째 result가 새면 결과 카드가 두 장 그려진다");
}

#[test]
fn interrupt_translates_to_turn_interrupt_and_lands_aborted() {
    let mut r = started();
    // 상태기계의 T13 봉투(runtime.rs `send_control("interrupt")`)
    r.out(json!({ "type": "control_request", "request_id": "ctl-9",
                  "request": { "subtype": "interrupt" } }));
    cover("turn/interrupt");
    let it = r.sent("turn/interrupt").expect("turn/interrupt").clone();
    assert_eq!(it["params"]["threadId"], "th-1");
    assert_eq!(it["params"]["turnId"], "tu-1");
    r.clear();
    r.rpc(json!({ "method": "turn/completed", "params": { "threadId": "th-1",
        "turn": { "id": "tu-1", "status": "interrupted" } } }));
    assert_eq!(r.frames[0]["terminal_reason"], "aborted_by_user", "T14의 표식");
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑥ 백그라운드 터미널(unified exec)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn background_terminals_become_a_shell_chip_and_stop_terminates() {
    let mut r = started();
    r.rpc(json!({ "method": "item/started", "params": { "threadId": "th-1",
        "item": { "id": "i9", "type": "commandExecution", "command": "npm run dev" } } }));
    r.rpc(json!({ "method": "item/commandExecution/outputDelta",
                  "params": { "threadId": "th-1", "itemId": "i9", "delta": "\u{1b}[32mready\u{1b}[0m" } }));
    r.clear();
    // 5초 폴링(engine.ts:1669) — 푸시 통지가 없다
    r.tick(6_000);
    cover("thread/backgroundTerminals/list");
    let list = r.sent("thread/backgroundTerminals/list").expect("list").clone();
    assert_eq!(list["params"]["threadId"], "th-1");
    let id = list["id"].clone();
    r.clear();
    r.rpc(json!({ "jsonrpc": "2.0", "id": id, "result": { "data": [
        { "itemId": "i9", "processId": "p42", "command": "npm run dev" }] } }));
    assert_eq!(r.tails[0].1, "ready", "PTY 제어 시퀀스는 벗겨 평문으로 쓴다");
    let replace = r.frames_of("system").into_iter().find(|f| f["subtype"] == "background_tasks_changed").unwrap();
    assert_eq!(replace["tasks"][0]["task_id"], "p42");
    assert!(replace["tasks"][0]["output_file"].as_str().unwrap().contains("p42"));

    // 셸 칩의 중지 → terminate (원장의 task_id가 곧 processId)
    r.clear();
    r.out(json!({ "type": "control_request", "request_id": "ctl-1",
                  "request": { "subtype": "stop_task", "task_id": "p42" } }));
    cover("thread/backgroundTerminals/terminate");
    let te = r.sent("thread/backgroundTerminals/terminate").expect("terminate").clone();
    assert_eq!(te["params"]["processId"], "p42");
    // 칩은 중지를 누른 그 순간 목록에서 빠진다(2.6.2 `emitBgTasks`의 `!t.stopped`).
    let gone = r.frames_of("system").into_iter().find(|f| f["subtype"] == "background_tasks_changed").unwrap();
    assert_eq!(gone["tasks"].as_array().unwrap().len(), 0);

    // 프로세스의 진짜 종말 → REPLACE(빈 목록) + 정착 통지.
    // ★R2 — 우리가 죽인 프로세스는 `exit -1` + failed로 돌아온다(실측). 그대로 흘리면
    //   사용자가 스스로 멈춘 셸이 **빨간 실패**로 뜬다 — 주체를 기억해 `stopped`로 읽는다
    //   (2.6.2 `engine.ts:870-876`). 사유(`summary`)도 싣지 않는다.
    r.clear();
    r.rpc(json!({ "method": "item/completed", "params": { "threadId": "th-1",
        "item": { "id": "i9", "type": "commandExecution", "exitCode": -1 } } }));
    let replace = r.frames_of("system").into_iter().find(|f| f["subtype"] == "background_tasks_changed").unwrap();
    assert_eq!(replace["tasks"].as_array().unwrap().len(), 0);
    let note = r.frames_of("system").into_iter().find(|f| f["subtype"] == "task_notification").unwrap();
    assert_eq!(note["task_id"], "p42");
    assert_eq!(note["status"], "stopped", "사용자가 멈춘 셸은 실패가 아니다");
    assert_eq!(note["stopped_by_user"], true);
    assert!(note.get("summary").is_none(), "`exit -1`은 우리가 만든 사연이라 안 보여 준다");
}

/// ★R2 — 백그라운드 명령의 **자연 종료**는 도구 행을 되살린다(2.6.2 `engine.ts:851-866`).
/// 완료 아이템이 전체 출력을 들고 오므로, '백그라운드로 전환'으로 일찍 닫힌 행에
/// 최종 출력·성패를 정착시켜야 로그를 클릭해 볼 수 있다.
#[test]
fn a_finished_background_command_revives_its_tool_row() {
    let mut r = started();
    r.rpc(json!({ "method": "item/started", "params": { "threadId": "th-1",
        "item": { "id": "i9", "type": "commandExecution", "command": "cargo build" } } }));
    r.tick(6_000);
    let id = r.sent("thread/backgroundTerminals/list").expect("list")["id"].clone();
    r.rpc(json!({ "jsonrpc": "2.0", "id": id, "result": { "data": [
        { "itemId": "i9", "processId": "p43", "command": "cargo build" }] } }));
    r.clear();
    r.rpc(json!({ "method": "item/completed", "params": { "threadId": "th-1",
        "item": { "id": "i9", "type": "commandExecution", "exitCode": 0,
                  "aggregatedOutput": "BUILD-LOG", "durationMs": 900 } } }));
    let revived = r
        .frames_of("user")
        .into_iter()
        .find(|f| f["message"]["content"][0]["tool_use_id"] == "i9")
        .expect("★ 최종 출력이 어느 프레임에도 안 실린다");
    assert_eq!(revived["message"]["content"][0]["content"], "BUILD-LOG");
    assert_eq!(revived["message"]["content"][0]["is_error"], false);
    let note = r.frames_of("system").into_iter().find(|f| f["subtype"] == "task_notification").unwrap();
    assert_eq!(note["status"], "completed");
    assert_eq!(note["summary"], "exit 0");
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑦ 서브에이전트(collab)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn subagents_become_a_task_card_and_their_frames_are_sidechained() {
    let mut r = started();
    // engine.ts:692-735 — 실측상 스폰의 **주 경로**는 subAgentActivity{kind:'started'}
    r.rpc(json!({ "method": "item/completed", "params": { "threadId": "th-1", "item": {
        "id": "a0", "type": "subAgentActivity", "kind": "started",
        "agentThreadId": "th-agent", "agentPath": "/agents/explore" } } }));
    cover("item/*{subAgentActivity}");
    let tu = &r.frames[0]["message"]["content"][0];
    assert_eq!(tu["name"], "Task");
    assert_eq!(tu["input"]["subagent_type"], "explore");
    let card = tu["id"].as_str().unwrap().to_string();

    // engine.ts:740-828 — 자식 스레드의 프레임은 **카드로만** 흐른다
    r.clear();
    r.rpc(json!({ "method": "item/completed", "params": { "threadId": "th-agent",
        "item": { "id": "am1", "type": "agentMessage", "text": "찾았습니다" } } }));
    cover("(서브에이전트 스레드의 알림)");
    assert_eq!(r.frames[0]["parent_tool_use_id"], card, "메인 말풍선 오염 금지");
    assert_eq!(r.frames[0]["message"]["content"][0]["text"], "찾았습니다");

    // 종결 통지 → 카드 정착
    r.clear();
    r.rpc(json!({ "method": "item/completed", "params": { "threadId": "th-1", "item": {
        "id": "a1", "type": "subAgentActivity", "kind": "closed", "agentThreadId": "th-agent" } } }));
    assert_eq!(r.frames[0]["message"]["content"][0]["tool_use_id"], card);

    // engine.ts:665-690 · 976-1003 — spawnAgent 콜이 오는 흐름
    r.clear();
    r.rpc(json!({ "method": "item/started", "params": { "threadId": "th-1", "item": {
        "id": "c1", "type": "collabAgentToolCall", "tool": "spawnAgent",
        "prompt": "레포를 조사해 줘", "receiverThreadIds": ["th-b"] } } }));
    cover("item/*{collabAgentToolCall}");
    assert_eq!(r.frames[0]["message"]["content"][0]["name"], "Task");
    r.clear();
    r.rpc(json!({ "method": "item/completed", "params": { "threadId": "th-1", "item": {
        "id": "c2", "type": "collabAgentToolCall", "tool": "closeAgent",
        "agentsStates": { "th-b": "completed" } } } }));
    assert_eq!(r.frames[0]["message"]["content"][0]["tool_use_id"], "c1");
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑧ 다른 스레드 · 정체성(O4) · 스폰 인자
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn frames_from_an_unknown_thread_are_dropped_not_mixed_in() {
    let mut r = started();
    r.rpc(json!({ "method": "item/agentMessage/delta",
                  "params": { "threadId": "th-other", "itemId": "x", "delta": "남의 대화" } }));
    assert!(r.frames.is_empty(), "한 프로세스에 여러 스레드가 산다(engine.ts:480-486)");
}

fn raw_codex(model: &str, account: Option<&str>) -> RawIdentity {
    RawIdentity {
        engine: RawEngine {
            kind: EngineKind::Codex,
            model: model.into(),
            effort: EffortId::Minimal,
            codex_account: account.map(str::to_string),
            codex_tier: None,
        },
        billing: RawBilling {
            kind: BillingKind::Subscription,
            account: Some("a@x".into()),
            drop_env_key: Some(false),
        },
        cwd: "C:\\code\\proj".into(),
        add_dirs: vec!["C:\\ref".into()],
        mode: ModeId::Plan,
        system_prompt: Some("한국어로 답해".into()),
        output_style: None,
        tools: RawTools::default(),
    }
}

fn codex_defaults() -> IdentityDefaults {
    IdentityDefaults {
        known_accounts: BTreeSet::from(["a@x".to_string()]),
        default_codex_account: Some("me@openai.com".into()),
        known_codex_accounts: BTreeSet::from(["me@openai.com".to_string(), "other@openai.com".to_string()]),
        ..Default::default()
    }
}

/// **O4** — Codex 축이 Claude와 같은 규칙으로 접히는가.
#[test]
fn o4_codex_axis_normalizes_like_the_claude_one() {
    let d = codex_defaults();
    // ① 미지정 계정 → 기본 계정
    let id = RunIdentity::normalize(raw_codex("gpt-5.6-terra", None), &d).unwrap();
    assert_eq!(id.codex_account(), Some("me@openai.com"));
    // ② 명시 계정은 그대로
    let id2 = RunIdentity::normalize(raw_codex("gpt-5.6-terra", Some("other@openai.com")), &d).unwrap();
    assert_eq!(id2.codex_account(), Some("other@openai.com"));
    // ③ 모르는 계정은 거부 — 빈 CODEX_HOME으로 뜨는 것을 정규화가 막는다
    let e = RunIdentity::normalize(raw_codex("gpt-5.6-terra", Some("ghost@openai.com")), &d).unwrap_err();
    assert_eq!(e.reason(), IdentityRejectReason::AccountUnavailable);
    // ④ 정규화 ↔ 원시 왕복(골든 규약과 같은 성질)
    assert_eq!(RunIdentity::normalize(id.to_raw(), &d).unwrap(), id);
    // ⑤ 모델 id 공간이 갈려 있다 — Claude 정체성에는 codexAccount가 존재하지 않는다
    let claude = RunIdentity::normalize(
        RawIdentity { engine: RawEngine { kind: EngineKind::Claude, ..raw_codex("opus", Some("me@openai.com")).engine }, ..raw_codex("opus", None) },
        &d,
    )
    .unwrap();
    assert_eq!(claude.codex_account(), None);
    assert_ne!(claude.hash(), id.hash(), "엔진이 다르면 정체성이 다르다(재스폰 사유)");
}

#[test]
fn codex_subscription_does_not_require_an_unrelated_claude_login() {
    let d = codex_defaults();
    let mut raw = raw_codex("gpt-5.6-terra", Some("me@openai.com"));
    raw.billing.account = Some("removed@claude.test".into());
    let id = RunIdentity::normalize(raw.clone(), &d)
        .expect("a removed Claude binding must not lock a valid Codex session");
    assert_eq!(id.codex_account(), Some("me@openai.com"));
    assert_eq!(RunIdentity::normalize(id.to_raw(), &d).unwrap(), id);

    raw.billing.account = None;
    let codex_only = IdentityDefaults { known_accounts: BTreeSet::new(), default_account: None, ..d.clone() };
    let id = RunIdentity::normalize(raw.clone(), &codex_only)
        .expect("Codex-only users do not need a Claude account");
    assert_eq!(id.codex_account(), Some("me@openai.com"));
    assert_eq!(RunIdentity::normalize(id.to_raw(), &codex_only).unwrap(), id);

    // Validate the account actually used by the selected engine.
    raw.engine.codex_account = Some("removed@openai.com".into());
    assert!(matches!(RunIdentity::normalize(raw.clone(), &d),
        Err(IdentityError::AccountUnavailable(email)) if email == "removed@openai.com"));
    let api = RunIdentity::normalize(
        RawIdentity { billing: RawBilling { kind: BillingKind::ApiKey, ..raw.billing.clone() }, ..raw.clone() },
        &IdentityDefaults { api_key: Some("test-key".into()), ..d.clone() },
    ).expect("API execution does not require a subscription login");
    assert_eq!(api.codex_account(), None);
    raw.engine.kind = EngineKind::Claude;
    raw.engine.model = "opus".into();
    raw.billing.account = Some("removed@claude.test".into());
    assert!(matches!(RunIdentity::normalize(raw, &d),
        Err(IdentityError::AccountUnavailable(email)) if email == "removed@claude.test"));
}

#[test]
fn spawn_spec_for_codex_carries_a_plan_not_claude_argv() {
    let d = codex_defaults();
    let id = RunIdentity::normalize(raw_codex("gpt-5.6-terra", None), &d).unwrap();
    let spec = build_spawn_spec(std::path::PathBuf::from("claude.exe"), &id, Some("th-9"), false, None, None);
    let p = spec.codex.clone().expect("Codex 계획이 실려 있다");
    assert_eq!(spec.argv, vec!["app-server".to_string()]);
    assert!(!spec.argv.iter().any(|a| a.starts_with("--")), "Claude 플래그가 섞이면 안 된다");
    // plan 모드 → 읽기 전용 샌드박스(engine.ts:77-79)
    assert_eq!(p.approval_policy, "on-request");
    assert_eq!(p.sandbox, "read-only");
    // minimal은 Codex에 없다 → low
    assert_eq!(p.effort, "low");
    assert_eq!(p.resume.as_deref(), Some("th-9"));
    assert_eq!(p.account.as_deref(), Some("me@openai.com"));
    // 참조 폴더는 두 갈래(쓰기 루트 + 모델 안내문) — engine.ts:1545-1562
    let cfg = p.thread_params();
    // ★3.0.5 — 참조 폴더도 **원래 대소문자**로 나간다(작업 폴더 이름 소문자화 수정과 같은 축).
    assert_eq!(cfg["config"]["sandbox_workspace_write"]["writable_roots"][0], "C:\\ref");
    let dev = p.developer_instructions.clone().unwrap();
    assert!(dev.starts_with("한국어로 답해"));
    assert!(dev.contains("[참조 폴더]") && dev.contains("C:\\ref"));

    // 같은 정체성인데 Claude면 계획이 없다(= 이 스폰은 claude.exe다)
    let mut raw = raw_codex("opus", None);
    raw.engine.kind = EngineKind::Claude;
    let cid = RunIdentity::normalize(raw, &d).unwrap();
    let cspec = build_spawn_spec(std::path::PathBuf::from("claude.exe"), &cid, None, false, None, None);
    assert!(cspec.codex.is_none());
    assert!(cspec.argv.contains(&"--output-format".to_string()));
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑨ 엔진 전환 — 세션 신원은 엔진 축에 매인다 (★R2 · 크리틱 §4.1)
// ─────────────────────────────────────────────────────────────────────────────

/// 스폰 인자만 받아 적는 드라이버. 프로세스도 파이프도 없다 —
/// 재는 것은 "T17 뒤에 나가는 `SpawnSpec`에 **누구의** resume이 실렸나" 하나다.
#[derive(Default)]
struct SpecSpy {
    specs: Vec<ccg_engine::driver::SpawnSpec>,
}
impl ccg_engine::driver::CliDriver for SpecSpy {
    fn spawn(&mut self, spec: &ccg_engine::driver::SpawnSpec) -> std::io::Result<()> {
        self.specs.push(spec.clone());
        Ok(())
    }
    fn send(&mut self, _line: Value) {}
    fn close_input(&mut self) {}
    fn kill(&mut self) {}
    fn process_alive(&self) -> bool {
        true
    }
    fn poll_frames(&mut self, _now: ccg_engine::clock::Millis) -> Vec<Value> {
        vec![]
    }
    fn spawn_count(&self) -> usize {
        self.specs.len()
    }
}

fn switch_rig(kind: EngineKind, model: &str) -> ccg_engine::runtime::ChatRuntime<SpecSpy> {
    let mut raw = raw_codex(model, None);
    raw.engine.kind = kind;
    raw.mode = ModeId::Normal;
    let mut d = codex_defaults();
    d.default_account = Some("a@x".into());
    d.cwd_probe = CwdProbe::AssumeExists;
    ccg_engine::runtime::ChatRuntime::new(
        "c-switch",
        raw,
        d,
        std::sync::Arc::new(ccg_engine::clock::SystemClock::default()),
        SpecSpy::default(),
    )
    .expect("정규화")
    // 스트림을 살려 둬야 다음 전송이 **T17 재스폰**을 탄다(콜드 스타트가 아니라).
    .with_close_policy(ccg_engine::state::StreamClosePolicy::KeepOpen)
}

fn switch_engine(rt: &mut ccg_engine::runtime::ChatRuntime<SpecSpy>, kind: EngineKind, model: &str) {
    rt.dispatch(ccg_engine::runtime::Cmd::IdentitySet {
        patch: RawIdentityPatch {
            engine: EnginePatch {
                kind: Some(kind),
                model: Some(model.into()),
                ..Default::default()
            },
            ..Default::default()
        },
        policy: ApplyPolicy::Now,
        op: PendingOp::Merge,
    });
}

#[test]
fn only_claude_startup_requires_the_claude_account_directory() {
    for engine in [EngineKind::Codex, EngineKind::Claude] {
        let mut rt = switch_rig(engine, if engine == EngineKind::Codex { "gpt-5.6-terra" } else { "opus" })
            .with_account_resolver(std::sync::Arc::new(|_| Err("Claude credentials are unavailable".into())));
        rt.dispatch(ccg_engine::runtime::Cmd::Send { text: "Start this session".into() });
        assert_eq!(rt.driver_ref().specs.len(), usize::from(engine == EngineKind::Codex),
            "only a Claude run may be blocked by its credential resolver");
        if engine == EngineKind::Codex {
            assert_eq!(rt.driver_ref().specs[0].codex.as_ref().unwrap().account.as_deref(), Some("me@openai.com"));
        }
    }
}

/// ★치명(크리틱 §4.1) — Claude로 한 턴 돌린 채팅에서 picker를 Codex로 바꾸면
/// 드라이버는 갈아타는데 **세션 신원이 안 갈렸다**: Claude의 `session_id`가 그대로
/// `thread/resume{threadId}`로 나가 실 codex가 모르는 스레드라며 거절했고,
/// **전환 후 첫 턴이 오류 카드로 죽었다.**
#[test]
fn switching_the_engine_starts_a_new_thread_instead_of_resuming_the_other_engines_session() {
    let mut rt = switch_rig(EngineKind::Claude, "opus");
    rt.dispatch(ccg_engine::runtime::Cmd::Send { text: "첫 턴".into() });
    assert!(rt.driver_ref().specs[0].codex.is_none(), "첫 스폰은 claude.exe");
    // claude.exe가 세션 id를 줬다 → 이어붙이기 키로 저장된다.
    rt.on_frame(&json!({ "type": "system", "subtype": "init",
                         "session_id": "CL-1", "model": "claude-opus-4" }));
    rt.on_frame(&json!({ "type": "result", "subtype": "success", "is_error": false,
                         "result": "ok", "session_id": "CL-1" }));
    assert_eq!(rt.session_id().as_deref(), Some("CL-1"));

    // picker → Codex. T17이 돌고 그 다음 스폰부터 반대쪽 드라이버가 뜬다.
    switch_engine(&mut rt, EngineKind::Codex, "gpt-5.6-terra");
    rt.dispatch(ccg_engine::runtime::Cmd::Send { text: "전환 후 첫 턴".into() });
    assert_eq!(rt.spawns, 2, "T17 재스폰");
    let spec = rt.driver_ref().specs[1].clone();
    let plan = spec.codex.clone().expect("두 번째 스폰은 codex app-server");
    assert_eq!(spec.resume, None, "★ Claude의 session_id가 codex로 새면 안 된다");
    assert_eq!(plan.resume, None, "★ CodexPlan.resume = Claude session_id → thread/resume 유출");
    assert_eq!(rt.session_id(), None, "세션 신원도 함께 갈린다");

    // 와이어로 내려가서 확인한다 — `thread/resume`이 아니라 `thread/start`가 나가야
    // 전환 후 첫 턴이 산다.
    let mut r = Rig::new(plan);
    r.out(initialize_request("init-1", None));
    r.rpc(json!({ "jsonrpc": "2.0", "id": 1, "result": {} }));
    r.out(user_message("전환 후 첫 턴"));
    assert!(r.sent("thread/resume").is_none(), "★ 남의 엔진 세션으로 resume을 걸었다");
    let start = r.sent("thread/start").expect("새 스레드를 연다");
    assert!(start["params"].get("threadId").is_none());
    // 그리고 그 첫 턴이 실제로 **끝까지 산다**(스레드 → 턴 → 정착).
    r.rpc(json!({ "jsonrpc": "2.0", "id": 2, "result": { "thread": { "id": "th-new" } } }));
    r.rpc(json!({ "jsonrpc": "2.0", "id": 3, "result": { "turn": { "id": "tu-1" } } }));
    r.rpc(json!({ "method": "turn/completed", "params": { "threadId": "th-new",
        "turn": { "id": "tu-1", "status": "completed" } } }));
    let res = r.frames_of("result");
    assert_eq!(res.len(), 1, "전환 후 첫 턴이 결과 카드 한 장으로 정착한다");
    assert_eq!(res[0]["is_error"], false, "★ 전환 후 첫 턴이 오류로 죽었다");
}

/// 반대 방향도 같다 — `driver.rs:103`은 `resume`을 조건 없이 `--resume={r}`로 민다.
#[test]
fn switching_back_to_claude_does_not_pass_the_codex_thread_id_to_the_cli() {
    let mut rt = switch_rig(EngineKind::Codex, "gpt-5.6-terra");
    rt.dispatch(ccg_engine::runtime::Cmd::Send { text: "첫 턴".into() });
    assert!(rt.driver_ref().specs[0].codex.is_some());
    // codex의 threadId가 곧 우리 session_id다(옮김기가 system/init으로 올린다).
    rt.on_frame(&json!({ "type": "system", "subtype": "init",
                         "session_id": "th-1", "model": "gpt-5.6-terra" }));
    rt.on_frame(&json!({ "type": "result", "subtype": "success", "is_error": false,
                         "result": "ok", "session_id": "th-1" }));
    assert_eq!(rt.session_id().as_deref(), Some("th-1"));

    switch_engine(&mut rt, EngineKind::Claude, "opus");
    rt.dispatch(ccg_engine::runtime::Cmd::Send { text: "전환 후 첫 턴".into() });
    let spec = rt.driver_ref().specs[1].clone();
    assert!(spec.codex.is_none(), "두 번째 스폰은 claude.exe");
    assert_eq!(spec.resume, None);
    let resumes: Vec<&String> = spec.argv.iter().filter(|a| a.starts_with("--resume")).collect();
    assert!(resumes.is_empty(), "★ claude.exe에 codex threadId를 줬다: {resumes:?}");
}

/// 엔진이 **안 갈리면** 세션은 그대로 이어져야 한다(위 두 개가 과잉 차단이 아님을 잠근다).
#[test]
fn changing_only_the_model_keeps_the_session_id() {
    let mut rt = switch_rig(EngineKind::Claude, "opus");
    rt.dispatch(ccg_engine::runtime::Cmd::Send { text: "첫 턴".into() });
    rt.on_frame(&json!({ "type": "system", "subtype": "init",
                         "session_id": "CL-1", "model": "claude-opus-4" }));
    rt.on_frame(&json!({ "type": "result", "subtype": "success", "is_error": false,
                         "result": "ok", "session_id": "CL-1" }));
    switch_engine(&mut rt, EngineKind::Claude, "haiku");
    rt.dispatch(ccg_engine::runtime::Cmd::Send { text: "두 번째".into() });
    assert_eq!(rt.driver_ref().specs[1].resume.as_deref(), Some("CL-1"));
}

#[test]
fn build_plan_is_a_pure_function_of_the_identity() {
    let d = codex_defaults();
    let id = RunIdentity::normalize(raw_codex("gpt-5.6-terra", None), &d).unwrap();
    assert_eq!(build_plan(&id, None), build_plan(&id, None), "같은 정체성 = 같은 계획");
}

// ─────────────────────────────────────────────────────────────────────────────
// 게이트
// ─────────────────────────────────────────────────────────────────────────────

/// **표의 모든 행이 재생됐는가.** 붉어지면 둘 중 하나다: 옮김을 안 썼거나, 재생을 안 썼거나.
#[test]
fn frame_map_is_fully_replayed() {
    // 이 파일의 다른 테스트들이 먼저 돌아야 하므로 여기서 전부 한 번 더 실행한다
    // (cargo는 테스트를 병렬·임의 순서로 돌리고 `COVER`는 thread_local이다).
    handshake_produces_both_halves_of_t2();
    resume_reuses_the_saved_thread_id();
    streaming_deltas_become_claude_stream_events();
    tool_items_become_tool_use_and_tool_result();
    all_four_approval_shapes_and_the_question_card();
    plan_usage_errors_and_completion();
    a_fatal_error_settles_the_turn_instead_of_going_silent();
    interrupt_translates_to_turn_interrupt_and_lands_aborted();
    background_terminals_become_a_shell_chip_and_stop_terminates();
    subagents_become_a_task_card_and_their_frames_are_sidechained();

    let have = COVER.with(|c| c.borrow().clone());
    let missing: Vec<&str> = FRAME_MAP
        .iter()
        .map(|r| r.wire)
        .filter(|w| !have.contains(w))
        .collect();
    assert!(missing.is_empty(), "옮김표에 있는데 재생이 없는 행: {missing:?}");
    let unknown: Vec<&str> = have
        .iter()
        .copied()
        .filter(|k| !FRAME_MAP.iter().any(|r| r.wire == *k))
        .collect();
    assert!(unknown.is_empty(), "재생은 있는데 표에 없는 행: {unknown:?}");
    println!("[m4] 옮김표 {}행 전부 재생됨", FRAME_MAP.len());
}

/// ★R2 — **`to` 열도 검사한다.**
///
/// R1의 게이트는 `wire` 문자열 키만 셌다. 재생이 `cover("…")`를 손으로 부르는 장부일 뿐이라
/// `to`·`src` 열은 아무도 안 봤고, 그 사이 세 행이 실코드와 어긋났다(크리틱 §5:
/// `Edit` vs `codex_file_change` · `<tool>` vs `mcp__…` · 빠진 분기들).
/// 여기서는 표가 "이런 프레임이 된다"고 적은 것을 **재생이 실제로 낸 산출**과 대조한다.
#[test]
fn frame_map_claims_match_what_the_replay_actually_produced() {
    frame_map_is_fully_replayed(); // 같은 스레드에서 모든 시나리오를 한 번 밟아 장부를 채운다
    let shapes = SHAPES.with(|s| s.borrow().clone());
    let tools = TOOLS.with(|s| s.borrow().clone());
    let methods = METHODS.with(|s| s.borrow().clone());
    let sidechain = SIDECHAIN.with(|s| *s.borrow());

    // ① `to`가 이름 댄 프레임 모양이 실제로 나왔는가.
    const SHAPE_CLAIMS: &[(&str, &str)] = &[
        ("system/init", "system/init"),
        ("system/notification", "system/notification"),
        ("system/ccg_codex", "system/ccg_codex"),
        ("system/background_tasks_changed", "system/background_tasks_changed"),
        ("user{tool_result", "user"),
        ("result{", "result"),
        ("control_request{", "control_request"),
        ("control_response{", "control_response"),
        ("stream_event{", "stream_event"),
        ("assistant{text", "assistant"),
    ];
    for row in FRAME_MAP {
        for (needle, shape) in SHAPE_CLAIMS {
            if row.to.contains(needle) {
                assert!(
                    shapes.contains(*shape),
                    "표의 `{}` 행이 `{}`를 낸다고 적었는데 재생 산출에 없다",
                    row.wire,
                    shape
                );
            }
        }
        // ② `assistant{tool_use X}`의 X가 실제로 나온 도구 이름인가.
        //    (`…`로 끝나면 접두 일치 — `mcp__{server}__{tool}` 같은 생성 이름 자리)
        if let Some(rest) = row.to.split("assistant{tool_use ").nth(1) {
            let name = rest.split('}').next().unwrap_or("").trim();
            let hit = match name.strip_suffix('…') {
                Some(prefix) => tools.iter().any(|t| t.starts_with(prefix)),
                None => tools.contains(name),
            };
            assert!(hit, "표의 `{}` 행이 도구 `{name}`을 연다고 적었는데 재생이 낸 이름은 {tools:?}", row.wire);
        }
        // ③ 사이드체인이라고 적은 행은 실제로 `parent_tool_use_id`를 붙였는가.
        if row.to.contains("parent_tool_use_id") {
            assert!(sidechain, "표의 `{}` 행이 사이드체인이라 적었는데 붙은 프레임이 없다", row.wire);
        }
        // ④ `C→S` 행의 `wire`가 순수 method 이름이면 그 RPC가 실제로 나갔는가.
        let bare = !row.wire.contains(['{', '(', ' ']);
        if row.dir == "C→S" && bare {
            assert!(
                methods.contains(row.wire),
                "표의 `{}` 행이 `C→S`인데 그 method가 stdin으로 나간 적이 없다",
                row.wire
            );
        }
    }
    println!("[m4] `to` 열 대조 — 모양 {} · 도구 {tools:?} · method {}", shapes.len(), methods.len());
}

/// ★R2 — **`src` 열도 검사한다.** 근거로 적은 줄 범위가 2.6.2 파일에 실재하는가.
/// (2.6.2 소스가 트리에서 사라지면 조용히 건너뛴다 — 근거가 없어진 것이지 코드가 틀린 게 아니다.)
#[test]
fn frame_map_source_line_ranges_exist_in_the_262_engine() {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("src/main/codex/engine.ts");
    let Ok(text) = std::fs::read_to_string(&p) else {
        println!("[m4] 2.6.2 engine.ts가 없어 건너뜀 — {}", p.display());
        return;
    };
    let lines = text.lines().count();
    let mut checked = 0usize;
    for row in FRAME_MAP {
        for chunk in row.src.split("engine.ts:").skip(1) {
            let span: String = chunk
                .chars()
                .take_while(|c| c.is_ascii_digit() || *c == '-')
                .collect();
            let mut it = span.split('-').filter(|x| !x.is_empty());
            let (Some(a), Some(b)) = (it.next(), it.next()) else { continue };
            let (a, b) = (a.parse::<usize>().unwrap(), b.parse::<usize>().unwrap());
            assert!(a >= 1 && a <= b, "표 `{}`의 줄 범위가 거꾸로다: {a}-{b}", row.wire);
            assert!(
                b <= lines,
                "표 `{}`가 engine.ts:{a}-{b}를 근거로 드는데 파일은 {lines}줄뿐이다",
                row.wire
            );
            checked += 1;
        }
    }
    println!("[m4] `src` 열 {checked}개 줄 범위가 engine.ts({lines}줄) 안에 있다");
}
