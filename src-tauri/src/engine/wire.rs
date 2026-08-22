//! 와이어 번역 — **원시 CLI 프레임 → 2.6.2 `EngineEvent`**(`src/shared/protocol.ts:391`).
//!
//! 왜 여기 있나: 상태기계(`ccg-engine`)가 내는 `Event`는 *상태·원장·판정*이고, 렌더러가
//! 그리는 것은 *내용*(스트리밍 텍스트·도구 인자·질문 선택지)이다. 두 축은 겹치지 않는다.
//! 얼려 둔 2.6.2 렌더러는 `engine:event` 하나로 그 내용을 받으므로, 셸이 프레임을 그
//! 모양으로 번역한다. (`docs/design/ux-chat-unify.md` §6.2 — "이벤트는 역방향:
//! `chat:event`를 옛 렌더러가 구독한 `engine:event`로도 함께 내보낸다".)
//!
//! **범위**: 세로 조각(부팅→메시지→스트리밍→승인→완료)이 화면에 그려지는 데 필요한
//! 프레임만 옮긴다. 안 옮긴 것은 파일 끝 「미배선」에 이름으로 남긴다 — 조용히 빠뜨리지
//! 않는 것이 규약이다. 미지 프레임은 **아무 이벤트도 내지 않는다**(렌더러는 못 본 것과
//! 같다). 절대 패닉하지 않는다.

use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

/// 도구 한 행의 시작 시각 — `tool-end`의 `durationMs`를 만든다.
struct ToolRow {
    verb: String,
    started_ms: u64,
}

#[derive(Default)]
pub struct Wire {
    /// 지금 턴의 runId(2.6.2 문자열). 렌더러는 이 값으로 이벤트를 자기 실행에 붙인다.
    pub run_id: String,
    /// 스트리밍 중인 assistant 메시지 id(없으면 아직 블록이 안 열렸다).
    cur_msg: Option<String>,
    msg_seq: u64,
    tools: BTreeMap<String, ToolRow>,
    /// `system/init`의 `apiKeySource` — `result.viaApi`의 진실(토글이 아니라 인증 경로).
    via_api: bool,
    /// 이번 턴에 `working`을 이미 알렸나(상태 칩이 깜빡이지 않게).
    said_working: bool,
    /// `AskUserQuestion` 카드의 `request_id` → 그 질문 목록(응답 문구 조립에 쓴다).
    pub questions: BTreeMap<String, Value>,
    /// 이번 턴에 `result`를 이미 냈나. **스트림 급사(T22) 때 합성 종료를 낼지**를 가른다 —
    /// 이미 냈으면 두 번 내지 않는다(렌더러가 결과 카드를 두 벌 그린다).
    saw_result: bool,
    /// 폴백 확인 다이얼로그를 **질문 카드로** 그렸을 때의 `request_id` → 수락 선택지 라벨.
    /// 2.6.2 렌더러에는 다이얼로그 카드가 없다 — 질문 카드가 그 자리다(`engine.ts:930-1019`).
    dialogs: BTreeMap<String, DialogCard>,
}

/// 폴백 확인 카드 1건 — 답을 `{behavior:…}`로 되옮기는 데 필요한 최소값.
pub struct DialogCard {
    /// "계속 진행" 선택지의 라벨(이 문자열로 돌아오면 수락).
    pub accept_label: String,
    pub from_model: String,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_string)
}

/// 도구 이름 → (표시 동사, `ToolKind`). 2.6.2 `toolLabel` 파리티의 축소판.
fn tool_label(name: &str) -> (String, &'static str) {
    match name {
        "Read" | "NotebookRead" => ("Read".into(), "read"),
        "Write" => ("Write".into(), "write"),
        "Edit" | "MultiEdit" | "NotebookEdit" => ("Edit".into(), "edit"),
        "Bash" | "BashOutput" | "KillBash" => ("Bash".into(), "bash"),
        "Grep" | "Glob" => ("Search".into(), "search"),
        "WebSearch" | "WebFetch" => ("Web".into(), "web"),
        "Task" | "Agent" => ("Task".into(), "task"),
        "TodoWrite" => ("Todo".into(), "other"),
        n if n.starts_with("mcp__") => (n.to_string(), "mcp"),
        n => (n.to_string(), "other"),
    }
}

/// 도구 인자에서 사람이 읽는 대상 한 줄. 없으면 빈 문자열(렌더러가 동사만 그린다).
fn tool_target(input: &Value) -> String {
    for k in ["file_path", "path", "notebook_path", "command", "pattern", "query", "url", "description", "prompt"] {
        if let Some(v) = input.get(k).and_then(Value::as_str) {
            let one = v.replace(['\r', '\n'], " ");
            return if one.chars().count() > 180 {
                one.chars().take(180).collect::<String>() + "…"
            } else {
                one
            };
        }
    }
    String::new()
}

impl Wire {
    /// 새 실행 시작 — runId를 갈고 턴 상태를 리셋한다. 반환값은 첫 `status` 이벤트.
    pub fn begin_run(&mut self, run_id: &str) -> Value {
        self.run_id = run_id.to_string();
        self.cur_msg = None;
        self.said_working = false;
        self.saw_result = false;
        json!({ "type": "status", "runId": run_id, "status": "analyzing" })
    }

    /// 이 `request_id`가 **다이얼로그를 질문 카드로 그린 것**인가 — 응답 번역에 쓴다.
    pub fn dialog(&self, request_id: &str) -> Option<&DialogCard> {
        self.dialogs.get(request_id)
    }
    pub fn take_dialog(&mut self, request_id: &str) -> Option<DialogCard> {
        self.dialogs.remove(request_id)
    }

    /// **T22 착지의 화면 문장**(m-logic §5.2 표시 규약 · §5.6).
    ///
    /// 스트림이 죽으면 상태기계가 원장을 사유와 함께 정착시키지만, 얼려 둔 2.6.2
    /// 렌더러에는 그 사유를 읽는 구독자가 없다 — 카드를 닫는 이벤트는 `result`뿐이고
    /// (`session.ts:933` `pendingPermission: null`), busy를 내리는 것은 종결 `status`다.
    /// 그래서 여기서 셋을 만든다:
    ///   ① `notice` — "정리됨(엔진 종료)" 사유 한 줄
    ///   ② `result`(합성) — **CLI가 result를 못 보내고 죽은 경우에만**. 카드 해제 +
    ///      말풍선/도구 스피너 정착 + 컴포저 해제가 이 하나에 달려 있다
    ///   ③ 정착 목록은 `chat:run-state.settled`가 REPLACE로 이미 싣는다(hub.rs)
    ///
    /// 사용자 의사로 닫힌 경로(`AllClear`·`Cancelled`·`AppQuit`)와 재스폰
    /// (`IdentityChanged`·`ThreadChanged`)은 **여기 오지 않는다** — 호출부가 가른다.
    pub fn stream_closed(&mut self, cause: &str, settled: usize) -> Vec<Value> {
        let run = self.run_id.clone();
        let why = match cause {
            "external_kill" => "엔진(CLI)이 외부에서 종료됐어요",
            "cli_exit" => "엔진(CLI)이 스스로 종료했어요",
            "spawn_failed" => "엔진을 시작하지 못했어요",
            "idle_reclaim" => "오래 조용한 엔진을 정리했어요",
            "hard_cancel" => "중단 응답이 없어 엔진을 강제로 정리했어요",
            _ => "엔진(CLI)이 예기치 않게 종료됐어요",
        };
        let tail = if settled > 0 {
            format!(" — 진행 중이던 표시 {settled}개를 정리했어요")
        } else {
            String::new()
        };
        let mut out = vec![json!({
            "type": "notice", "runId": run,
            "text": format!("{why}{tail}. 다시 보내면 새 프로세스로 이어집니다.")
        })];
        if !self.saw_result {
            // ★ 결과 없는 종료. `isError:true`로 두는 이유: 이 턴은 **끝난 게 아니라
            //   끊긴 것**이고, 렌더러의 명령 카드 정착 경로도 `isError`를 본다.
            self.saw_result = true;
            self.cur_msg = None;
            out.push(json!({
                "type": "result", "runId": run,
                "isError": true,
                "text": format!("{why} — 이 턴은 완료되지 않았습니다."),
                "costUsd": Value::Null,
                "durationMs": Value::Null,
                "numTurns": Value::Null,
                "contextTokens": Value::Null,
                "contextWindow": Value::Null,
                "viaApi": self.via_api,
            }));
        }
        self.dialogs.clear();
        self.questions.clear();
        self.tools.clear();
        out
    }

    fn next_msg_id(&mut self) -> String {
        self.msg_seq += 1;
        format!("{}-m{}", self.run_id, self.msg_seq)
    }

    fn working(&mut self, out: &mut Vec<Value>) {
        if !self.said_working {
            self.said_working = true;
            out.push(json!({ "type": "status", "runId": self.run_id, "status": "working" }));
        }
    }

    /// 프레임 1개 → `EngineEvent` 0..N개.
    pub fn translate(&mut self, f: &Value) -> Vec<Value> {
        let mut out: Vec<Value> = vec![];
        let ty = f.get("type").and_then(Value::as_str).unwrap_or("");
        let sub = f.get("subtype").and_then(Value::as_str).unwrap_or("");
        let run = self.run_id.clone();
        // 사이드체인(서브에이전트 내부)은 본 스레드에 섞지 않는다 — 2.6.2도 분리해
        // 그렸다(메모리 「사이드체인 모델 프레임」). 이번 라운드는 **버린다**(미배선).
        let sidechain = f.get("parent_tool_use_id").map(|x| !x.is_null()).unwrap_or(false);

        match ty {
            "system" if sub == "init" => {
                self.via_api = f
                    .get("apiKeySource")
                    .and_then(Value::as_str)
                    .is_some_and(|v| !v.is_empty() && v != "none");
                out.push(json!({
                    "type": "session",
                    "runId": run,
                    "sessionId": s(f, "session_id").unwrap_or_default(),
                    "model": s(f, "model").unwrap_or_default(),
                    "cwd": s(f, "cwd").unwrap_or_default(),
                    "tools": f.get("tools").cloned().unwrap_or(json!([])),
                }));
            }
            "system" if sub == "notification" || sub == "informational" => {
                let text = s(f, "text").or_else(|| s(f, "message")).unwrap_or_default();
                if !text.is_empty() {
                    out.push(json!({ "type": "notice", "runId": run, "text": text }));
                }
            }
            "system" if sub == "compact_boundary" => {
                out.push(json!({
                    "type": "compact",
                    "runId": run,
                    "trigger": f["compact_metadata"]["trigger"].as_str().unwrap_or("auto"),
                    "preTokens": f["compact_metadata"]["pre_tokens"].as_u64(),
                    "afterTokens": Value::Null,
                }));
            }
            "stream_event" if !sidechain => {
                let ev = &f["event"];
                match ev.get("type").and_then(Value::as_str).unwrap_or("") {
                    "content_block_start" => {
                        if ev["content_block"]["type"] == "text" {
                            let id = self.next_msg_id();
                            self.cur_msg = Some(id);
                        }
                    }
                    "content_block_delta" => {
                        let d = &ev["delta"];
                        match d.get("type").and_then(Value::as_str).unwrap_or("") {
                            "text_delta" => {
                                let delta = d.get("text").and_then(Value::as_str).unwrap_or("");
                                if !delta.is_empty() {
                                    let id = match &self.cur_msg {
                                        Some(i) => i.clone(),
                                        None => {
                                            let i = self.next_msg_id();
                                            self.cur_msg = Some(i.clone());
                                            i
                                        }
                                    };
                                    self.working(&mut out);
                                    out.push(json!({
                                        "type": "assistant-stream", "runId": run,
                                        "messageId": id, "delta": delta
                                    }));
                                }
                            }
                            "thinking_delta" => {
                                let t = d.get("thinking").and_then(Value::as_str).unwrap_or("");
                                if !t.is_empty() {
                                    out.push(json!({ "type": "thinking", "runId": run, "text": t }));
                                }
                            }
                            _ => {}
                        }
                    }
                    _ => {}
                }
            }
            "assistant" if !sidechain => {
                let msg = &f["message"];
                let mut text = String::new();
                if let Some(blocks) = msg.get("content").and_then(Value::as_array) {
                    for b in blocks {
                        match b.get("type").and_then(Value::as_str).unwrap_or("") {
                            "text" => text.push_str(b.get("text").and_then(Value::as_str).unwrap_or("")),
                            "tool_use" => {
                                let id = s(b, "id").unwrap_or_default();
                                let name = s(b, "name").unwrap_or_default();
                                let (verb, kind) = tool_label(&name);
                                let target = tool_target(&b["input"]);
                                self.tools.insert(
                                    id.clone(),
                                    ToolRow {
                                        verb: verb.clone(),
                                        started_ms: now_ms(),
                                    },
                                );
                                self.working(&mut out);
                                out.push(json!({
                                    "type": "tool-start", "runId": run,
                                    "tool": { "id": id, "verb": verb, "kind": kind,
                                              "target": target, "status": "running" }
                                }));
                            }
                            _ => {}
                        }
                    }
                }
                if !text.is_empty() {
                    let id = self.cur_msg.take().unwrap_or_else(|| {
                        self.msg_seq += 1;
                        format!("{}-m{}", self.run_id, self.msg_seq)
                    });
                    out.push(json!({
                        "type": "assistant-done", "runId": run, "messageId": id, "text": text
                    }));
                }
                if let Some(t) = msg["usage"]["input_tokens"].as_u64() {
                    let ctx = t
                        + msg["usage"]["cache_read_input_tokens"].as_u64().unwrap_or(0)
                        + msg["usage"]["cache_creation_input_tokens"].as_u64().unwrap_or(0);
                    out.push(json!({ "type": "context", "runId": run, "contextTokens": ctx }));
                }
            }
            "user" if !sidechain => {
                if let Some(blocks) = f["message"].get("content").and_then(Value::as_array) {
                    for b in blocks {
                        if b.get("type").and_then(Value::as_str) != Some("tool_result") {
                            continue;
                        }
                        let id = s(b, "tool_use_id").unwrap_or_default();
                        let is_err = b.get("is_error").and_then(Value::as_bool).unwrap_or(false);
                        let row = self.tools.remove(&id);
                        let dur = row.as_ref().map(|r| now_ms().saturating_sub(r.started_ms));
                        let content = match &b["content"] {
                            Value::String(t) => t.clone(),
                            Value::Array(a) => a
                                .iter()
                                .filter_map(|x| x.get("text").and_then(Value::as_str))
                                .collect::<Vec<_>>()
                                .join("\n"),
                            _ => String::new(),
                        };
                        let tail: String = if content.chars().count() > 4000 {
                            content.chars().skip(content.chars().count() - 4000).collect()
                        } else {
                            content
                        };
                        let mut e = Map::new();
                        e.insert("type".into(), json!("tool-end"));
                        e.insert("runId".into(), json!(run));
                        e.insert("id".into(), json!(id));
                        e.insert("status".into(), json!(if is_err { "error" } else { "done" }));
                        if !tail.is_empty() {
                            let one = tail.replace(['\r', '\n'], " ");
                            let short: String = one.chars().take(160).collect();
                            e.insert("result".into(), json!(short));
                            if row.as_ref().is_some_and(|r| r.verb == "Bash") {
                                e.insert("output".into(), json!(tail));
                            }
                        }
                        if let Some(d) = dur {
                            e.insert("durationMs".into(), json!(d));
                        }
                        out.push(Value::Object(e));
                    }
                }
            }
            "control_request" => {
                let r = &f["request"];
                let request_id = s(f, "request_id").unwrap_or_default();
                let subtype = r.get("subtype").and_then(Value::as_str).unwrap_or("");
                let tool_name = s(r, "tool_name").unwrap_or_default();
                if subtype == "can_use_tool" && tool_name == "AskUserQuestion" {
                    let questions = r["input"]["questions"].clone();
                    self.questions.insert(request_id.clone(), questions.clone());
                    out.push(json!({
                        "type": "question-request", "runId": run,
                        "requestId": request_id,
                        "questions": if questions.is_array() { questions } else { json!([]) },
                    }));
                } else if subtype == "can_use_tool" {
                    let (verb, _) = tool_label(&tool_name);
                    let target = tool_target(&r["input"]);
                    let summary = if target.is_empty() { verb.clone() } else { format!("{verb} {target}") };
                    out.push(json!({
                        "type": "permission-request", "runId": run,
                        "requestId": request_id, "toolName": tool_name, "summary": summary,
                    }));
                } else if subtype == "request_user_dialog" {
                    // **폴백 확인**(§4.4b). 상태기계는 이미 T4로 `AwaitingUser`에 들어가
                    // 카드를 원장에 세운다 — 여기서 이벤트를 안 내면 화면에는 아무것도
                    // 안 뜨는데 채팅만 굳는다(크리틱 배선 R1 §3: kill 없이 도달하는 §2-E).
                    // 2.6.2는 이것을 **질문 카드**로 그렸다(`engine.ts:930-1019`) — 같은 모양.
                    let p = &r["payload"];
                    let from = p.get("originalModel").and_then(Value::as_str).unwrap_or("현재 모델").to_string();
                    let to = p.get("fallbackModel").and_then(Value::as_str).unwrap_or("다른 모델").to_string();
                    let why = p.get("apiRefusalCategory").and_then(Value::as_str).unwrap_or("");
                    let accept_label = format!("{to}로 계속");
                    let sub = if why.is_empty() {
                        format!("{from} 이(가) 응답을 거부했어요.")
                    } else {
                        format!("{from} 이(가) 응답을 거부했어요({why}).")
                    };
                    self.dialogs.insert(
                        request_id.clone(),
                        DialogCard { accept_label: accept_label.clone(), from_model: from },
                    );
                    out.push(json!({
                        "type": "question-request", "runId": run,
                        "requestId": request_id,
                        "questions": [{
                            "question": format!("{sub} {to} 로 이어서 시도할까요?"),
                            "header": "폴백 확인",
                            "multiSelect": false,
                            "options": [
                                { "label": accept_label, "description": "거부된 답변을 지우고 다시 시도합니다" },
                                { "label": "중단", "description": "이 턴을 여기서 멈춥니다" }
                            ]
                        }],
                    }));
                }
            }
            "result" => {
                let is_error = f.get("is_error").and_then(Value::as_bool).unwrap_or(false);
                let text = s(f, "result").unwrap_or_default();
                let usage = &f["usage"];
                let ctx = usage["input_tokens"].as_u64().map(|t| {
                    t + usage["cache_read_input_tokens"].as_u64().unwrap_or(0)
                        + usage["cache_creation_input_tokens"].as_u64().unwrap_or(0)
                });
                out.push(json!({
                    "type": "result", "runId": run,
                    "isError": is_error,
                    "text": text,
                    "costUsd": f.get("total_cost_usd").and_then(Value::as_f64),
                    "durationMs": f.get("duration_ms").and_then(Value::as_u64),
                    "numTurns": f.get("num_turns").and_then(Value::as_u64),
                    "contextTokens": ctx,
                    "contextWindow": Value::Null,
                    "viaApi": self.via_api,
                }));
                self.cur_msg = None;
                self.saw_result = true;
            }
            _ => {}
        }
        out
    }
}

// ── 미배선(이번 라운드) ──────────────────────────────────────────────────────
// file-change(Write/Edit → 디프)  ·  terminal(Bash 실시간 줄)  ·  todos(TodoWrite)
// subagent(사이드체인 말풍선)     ·  workflow  ·  bg-tasks / bg-task-end
// thinking-clear                  ·  tokenUsage / contextWindow
//
// ★ 이 목록의 성격을 정확히 적는다(크리틱 배선 R1 §6 — R1의 마무리 문장이 "미배선 =
//   무해"라는 인상을 줬다). 위 항목은 전부 **"그 UI만 비어 있다"**가 맞다. 반면
//   `request_user_dialog`는 **"채팅이 굳는다"**였기 때문에 등급이 달랐고, 이번
//   라운드에서 질문 카드로 배선했다. 미배선을 적을 때는 **결과가 빈 화면인지
//   정지인지**를 함께 적는다.
