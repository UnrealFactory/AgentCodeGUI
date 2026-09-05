//! **와이어 옮김기** — `codex app-server`의 JSON-RPC ↔ 상태기계가 아는 Claude 프레임.
//!
//! 이 타입은 **순수**하다: 프로세스도 파일도 시계도 모른다(시각은 인자로 받는다).
//! 그래서 재생 테스트가 실 바이너리 없이 2.6.2에서 뽑아낸 프레임 대본을 그대로 먹인다
//! (`tests/codex_replay.rs`). 파이프·자식 프로세스·파일 쓰기는 [`super::driver`]가 한다.
//!
//! 옮김의 전체 목록은 [`super::FRAME_MAP`]이고, 각 분기 위에 2.6.2 근거를 줄 번호로 적었다.

use super::{CodexPlan, SYNTH};
use crate::clock::Millis;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

/// 옮김기가 내놓는 것 셋. 부수효과는 전부 여기로 나가고, 실행은 드라이버가 한다.
#[derive(Debug, Clone, PartialEq)]
pub enum Egress {
    /// 상태기계로 올라가는 Claude 모양 프레임.
    Frame(Value),
    /// app-server stdin으로 나가는 JSON-RPC 한 줄.
    Rpc(Value),
    /// 백그라운드 터미널의 라이브 테일 — 드라이버가 그 파일에 덧붙인다.
    Tail { file: String, text: String },
}

/// 우리가 보낸 RPC 하나가 무엇을 기다리는가.
#[derive(Debug, Clone, PartialEq)]
enum Pending {
    Initialize,
    Thread,
    Turn,
    ToolConfig,
    Skills,
    Mcp,
    Reload(String),
    /// 백그라운드 터미널 목록. `Some(rid)`면 **능동 프로브 ⑥**가 시킨 것 —
    /// 응답이 오면 그 `request_id`의 `control_response`와 REPLACE를 함께 낸다.
    BgList(Option<String>),
    /// 답을 안 쓰는 호출(interrupt · terminate).
    Fire,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AskKind {
    /// `item/*/requestApproval` — `{decision: accept|acceptForSession|decline}`
    Modern,
    /// `execCommandApproval`·`applyPatchApproval` — ReviewDecision 어휘
    Legacy,
    Question,
}

#[derive(Debug, Clone)]
struct Ask {
    rpc_id: Value,
    kind: AskKind,
    /// 질문 카드의 질문 id 순서(위치 기반 답 → id 매핑).
    qids: Vec<String>,
}

#[derive(Debug, Clone, Default)]
struct Usage {
    in_tok: u64,
    cached: u64,
    out_tok: u64,
}

#[derive(Debug, Clone)]
struct Bg {
    process_id: String,
    command: String,
    file: String,
    /// 사용자가 칩의 **중지**를 눌렀다. 실측(2.6.2 `engine.ts:870-873`): 우리가 죽인
    /// 프로세스는 `exit -1` + `status:'failed'`로 돌아온다 — 그걸 그대로 흘리면
    /// 사용자가 스스로 멈춘 셸이 **빨간 실패**로 뜬다. 그래서 주체를 기억한다.
    stopped: bool,
}

/// 살아 있는 서브에이전트 카드 하나(= codex 서브에이전트 스레드 하나).
#[derive(Debug, Clone)]
struct Agent {
    /// 부모 대화의 `Task` 도구 행 id.
    tool_id: String,
    /// 행을 **다시 열 때** 그대로 쓰는 `tool_use.input`(이름·설명이 여기 산다).
    input: Value,
    /// 이미 `tool_result`로 닫혔는가. 닫는 경로가 셋(턴 완료 · `subAgentActivity{clos*}` ·
    /// `collabAgentToolCall.agentsStates`)이라 두 번 닫지 않게 표식이 필요하다.
    done: bool,
}

/// 도구 행 하나(= codex item 하나).
#[derive(Debug, Clone)]
struct Item {
    /// Claude 도구 이름(`Bash`·`codex_file_change`·`WebSearch`·`mcp__…`·`Task`).
    /// 백그라운드 전환은 **명령 행에만** 일어난다 — 그 판정에 쓴다.
    name: String,
    /// 명령 출력 누적(백그라운드로 넘어가기 전까지) — 완료 시 `tool_result`에 실린다.
    out: String,
}

/// 백그라운드 터미널 폴링 간격 — 2.6.2 `engine.ts:1669`(5s)와 같다. 푸시 통지가 없다.
pub const BG_POLL: Millis = 5_000;

pub struct Transcoder {
    plan: CodexPlan,
    rpc_id: i64,
    pending: BTreeMap<i64, Pending>,
    thread_id: Option<String>,
    turn_id: Option<String>,
    /// 이미 `result`로 마감한 턴 id들.
    ///
    /// **실측(0.149.0, `poc-codex --only=handshake`)**: 치명 오류는
    /// `error{willRetry:false}` **와** `turn/completed{status:'failed'}`로 **두 번** 온다.
    /// 앞의 것으로 정착시키고 뒤의 것을 그대로 흘리면 결과 카드가 두 장 그려진다
    /// (2.6.2가 `endedTurnIds`로 막던 자리 — `engine.ts:210-213`).
    ended_turns: std::collections::BTreeSet<String>,
    initialized: bool,
    /// initialize/thread 왕복을 기다리는 사이 도착한 프롬프트(T1은 둘을 연달아 보낸다).
    queued_prompt: Option<String>,
    tool_config: Option<Value>,
    skills: Option<Value>,
    mcp: Vec<Value>,
    mcp_complete: bool,
    tool_refresh_queued: bool,
    tool_errors: BTreeMap<String, String>,
    mcp_cursors: std::collections::BTreeSet<String>,
    asks: BTreeMap<String, Ask>,
    ask_seq: u64,
    items: BTreeMap<String, Item>,
    /// 지금 스트리밍 중인 답변 item — 첫 델타에서 `content_block_start`를 연다.
    open_msg: Option<String>,
    /// 진행 중 reasoning 요약 누적(2.6.2 `thinkingBuf` — 꼬리 300자를 보낸다).
    thinking: String,
    ctx_tokens: Option<u64>,
    ctx_window: Option<u64>,
    usage_total: Usage,
    usage_base: Usage,
    usage_adopt: bool,
    turn_started_at: Millis,
    bg: BTreeMap<String, Bg>,
    bg_by_process: BTreeMap<String, String>,
    last_bg_poll: Millis,
    /// 살아 있는 서브에이전트 스레드 id → 그 카드.
    agents: BTreeMap<String, Agent>,
    /// 임시 폴더(백그라운드 테일 파일의 뿌리) — 드라이버가 채운다.
    pub tmp_dir: String,
}

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_string)
}

/// 공백 접고 자르기(2.6.2 `oneLine`).
fn one_line(v: &str, max: usize) -> String {
    let t = v.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.chars().count() > max {
        t.chars().take(max.saturating_sub(1)).collect::<String>() + "…"
    } else {
        t
    }
}

/// PTY 출력의 터미널 제어 시퀀스를 벗긴다 — 셸 카드 테일은 평문이어야 한다
/// (2.6.2 `stripAnsi`, `engine.ts:183-188`).
pub fn strip_ansi(s: &str) -> String {
    let b: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0usize;
    while i < b.len() {
        if b[i] != '\u{1b}' {
            out.push(b[i]);
            i += 1;
            continue;
        }
        let next = b.get(i + 1).copied().unwrap_or('\0');
        match next {
            // OSC — BEL 또는 ESC \ 로 끝난다(창 제목 등)
            ']' => {
                i += 2;
                while i < b.len() {
                    if b[i] == '\u{7}' {
                        i += 1;
                        break;
                    }
                    if b[i] == '\u{1b}' && b.get(i + 1) == Some(&'\\') {
                        i += 2;
                        break;
                    }
                    i += 1;
                }
            }
            // CSI — 파라미터 뒤 최종 바이트(@~)
            '[' => {
                i += 2;
                while i < b.len() && !('@'..='~').contains(&b[i]) {
                    i += 1;
                }
                i += 1;
            }
            // 2글자 ESC
            c if ('@'..='_').contains(&c) => i += 2,
            _ => {
                out.push(b[i]);
                i += 1;
            }
        }
    }
    out
}

/// 2.6.2 `cxWebSearchTarget`(`engine.ts:155-161`) — 검색어는 완료에만 실린다.
fn web_target(item: &Value) -> String {
    let action = &item["action"];
    let queries: Vec<String> = action["queries"]
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    let q = s(item, "query")
        .filter(|q| !q.is_empty())
        .or_else(|| s(action, "query").filter(|q| !q.is_empty()))
        .unwrap_or_else(|| queries.join(" · "));
    if !q.is_empty() {
        return one_line(&q, 200);
    }
    if action.get("type").and_then(Value::as_str) == Some("other") {
        "검색한 페이지 열람".to_string()
    } else {
        String::new()
    }
}

impl Transcoder {
    pub fn new(plan: CodexPlan) -> Transcoder {
        Transcoder {
            plan,
            rpc_id: 0,
            pending: BTreeMap::new(),
            thread_id: None,
            turn_id: None,
            ended_turns: Default::default(),
            initialized: false,
            queued_prompt: None,
            tool_config: None,
            skills: None,
            mcp: Vec::new(),
            mcp_complete: false,
            tool_refresh_queued: false,
            tool_errors: BTreeMap::new(),
            mcp_cursors: std::collections::BTreeSet::new(),
            asks: BTreeMap::new(),
            ask_seq: 0,
            items: BTreeMap::new(),
            open_msg: None,
            thinking: String::new(),
            ctx_tokens: None,
            ctx_window: None,
            usage_total: Usage::default(),
            usage_base: Usage::default(),
            usage_adopt: true,
            turn_started_at: 0,
            bg: BTreeMap::new(),
            bg_by_process: BTreeMap::new(),
            last_bg_poll: 0,
            agents: BTreeMap::new(),
            tmp_dir: std::env::temp_dir().to_string_lossy().to_string(),
        }
    }

    pub fn thread_id(&self) -> Option<&str> {
        self.thread_id.as_deref()
    }
    pub fn plan(&self) -> &CodexPlan {
        &self.plan
    }

    fn req(&mut self, method: &str, params: Value, p: Pending) -> Egress {
        self.rpc_id += 1;
        self.pending.insert(self.rpc_id, p);
        Egress::Rpc(json!({ "jsonrpc": "2.0", "id": self.rpc_id, "method": method, "params": params }))
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 나가는 것 — 상태기계의 컨트롤 봉투 → JSON-RPC
    // ─────────────────────────────────────────────────────────────────────────

    /// `driver.send(line)` 한 줄. **드라이버는 이 함수 밖에서 stdin에 아무것도 안 쓴다.**
    pub fn on_outgoing(&mut self, line: &Value, now: Millis) -> Vec<Egress> {
        let mut out = vec![];
        match line.get("type").and_then(Value::as_str).unwrap_or("") {
            "control_request" => {
                let rid = s(line, "request_id").unwrap_or_default();
                let req = &line["request"];
                match req.get("subtype").and_then(Value::as_str).unwrap_or("") {
                    // T1의 첫 봉투 · 능동 프로브 ⑥(`probe-N`)이 같은 subtype으로 온다.
                    "initialize" => {
                        if rid.starts_with("probe") {
                            // 프로브는 **살아 있음의 증거**여야 한다(⓪ 프로세스 생존은 증거가
                            // 아니다 — m-logic §5.4-b). 그래서 서버가 실제로 처리해야 답이
                            // 오는 호출을 쓴다: 백그라운드 터미널 목록. 응답이 오면 그때
                            // `control_response`와 REPLACE를 함께 낸다.
                            if let Some(t) = self.thread_id.clone() {
                                out.push(self.req(
                                    "thread/backgroundTerminals/list",
                                    json!({ "threadId": t }),
                                    Pending::BgList(Some(rid)),
                                ));
                            }
                            return out;
                        }
                        if self.initialized {
                            return out;
                        }
                        out.push(self.req(
                            "initialize",
                            json!({
                                "clientInfo": { "name": "agentcodegui", "title": "AgentCodeGUI", "version": "3.0.0" },
                                // thread/backgroundTerminals/*는 opt-in이 필요하다
                                // (없으면 "requires experimentalApi capability"로 거절 — engine.ts:388-390)
                                "capabilities": { "experimentalApi": true }
                            }),
                            Pending::Initialize,
                        ));
                    }
                    // T13/T23 — 소프트 중단. 턴이 없으면 보낼 것이 없다.
                    "interrupt" => {
                        if self.pending.values().any(|p| matches!(p, Pending::Reload(_))) {
                            self.pending.retain(|_, p| !matches!(p, Pending::Reload(_)));
                            let mut result = self.fail_result("Turn interrupted", now);
                            result["terminal_reason"] = json!("aborted_by_user");
                            out.push(Egress::Frame(result));
                            return out;
                        }
                        if let (Some(t), Some(u)) = (self.thread_id.clone(), self.turn_id.clone()) {
                            out.push(self.req(
                                "turn/interrupt",
                                json!({ "threadId": t, "turnId": u }),
                                Pending::Fire,
                            ));
                        }
                    }
                    // 셸 칩의 중지 — 원장의 task_id가 곧 processId다(아래 bg REPLACE 참고).
                    "stop_task" => {
                        let pid = s(req, "task_id").unwrap_or_default();
                        if let Some(t) = self.thread_id.clone() {
                            if !pid.is_empty() {
                                // ★ **중지 주체를 기억한다.** 우리가 죽인 프로세스는 곧바로
                                //   `item/completed{exitCode:-1}`로 돌아오는데(실측 ~100ms),
                                //   그대로 흘리면 사용자가 스스로 멈춘 셸이 `failed / exit -1`로
                                //   뜬다(2.6.2 `engine.ts:1414-1415`).
                                let item = self.bg_by_process.get(&pid).cloned();
                                let mut marked = false;
                                if let Some(b) = item.and_then(|i| self.bg.get_mut(&i)) {
                                    if b.stopped {
                                        return out; // 이미 중지 요청을 보냈다 — 두 번 안 보낸다.
                                    }
                                    b.stopped = true;
                                    marked = true;
                                }
                                out.push(self.req(
                                    "thread/backgroundTerminals/terminate",
                                    json!({ "threadId": t, "processId": pid }),
                                    Pending::Fire,
                                ));
                                // 칩은 즉시 목록에서 빠진다(2.6.2 `emitBgTasks`가 stopped를
                                // 걸러 내는 것과 같은 시점). 정착 통지는 item/completed가 낸다.
                                if marked {
                                    out.extend(self.bg_replace());
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            // 승인·질문 카드의 답 (§4.4a의 본문이 그대로 온다).
            "control_response" => {
                let r = &line["response"];
                let rid = s(r, "request_id").unwrap_or_default();
                let body = &r["response"];
                if let Some(ask) = self.asks.remove(&rid) {
                    out.push(Egress::Rpc(self.answer_ask(&ask, body)));
                }
            }
            // 사용자 발화 — T1(스폰 직후) · T16(주입) · T12(통지 재주입)가 모두 이 모양이다.
            "user" => {
                let text = line["message"]["content"]
                    .as_array()
                    .map(|blocks| {
                        blocks
                            .iter()
                            .filter(|b| b["type"] == "text")
                            .filter_map(|b| b.get("text").and_then(Value::as_str))
                            .collect::<Vec<_>>()
                            .join("")
                    })
                    .unwrap_or_default();
                if text.is_empty() {
                    return out;
                }
                self.turn_started_at = now;
                if !self.initialized {
                    self.queued_prompt = Some(text);
                    return out;
                }
                out.extend(self.start_or_turn(text));
            }
            _ => {}
        }
        out
    }

    /// 스레드가 있으면 턴만, 없으면 스레드부터. 프롬프트는 턴이 나갈 때까지 들고 있는다.
    fn start_or_turn(&mut self, text: String) -> Vec<Egress> {
        if self.thread_id.is_some() {
            return vec![self.req("config/mcpServer/reload", json!({}), Pending::Reload(text))];
        }
        self.queued_prompt = Some(text);
        let params = self.plan.thread_params();
        let e = match self.plan.resume.clone() {
            Some(id) => {
                let mut p = params;
                p["threadId"] = json!(id);
                self.req("thread/resume", p, Pending::Thread)
            }
            None => self.req("thread/start", params, Pending::Thread),
        };
        vec![e]
    }

    fn turn_start(&mut self, text: &str) -> Egress {
        // ★ 앞 턴 마감. 2.6.2는 `finishRun`이 `activeTurnId`를 `endedTurnIds`로 옮기고
        //   비우는데(engine.ts:1341-1344), 3.0은 턴을 **상태기계**가 마감하는 길이 있다
        //   (무음 턴 T8→T10→T11). 그때 옮김기는 아무 통지도 못 받으므로 `turn_id`가
        //   옛 값으로 남고 ① 다음 턴의 `turn/interrupt`가 **옛 turnId**를 겨눠 서버가
        //   `-32600 no active turn`으로 거절하며(Esc가 하드 kill로 떨어진다) ② 새 턴의
        //   `turn/start` 응답이 `is_none()` 가드에 걸려 영영 안 앉는다.
        //   새 프롬프트를 보내는 이 지점이 "앞 턴은 끝났다"가 참인 유일한 자리다.
        if let Some(prev) = self.turn_id.take() {
            self.remember_ended(prev);
        }
        let mut params = json!({
            "threadId": self.thread_id.clone().unwrap_or_default(),
            // `text_elements`는 실측 스키마의 필수 자리(engine.ts:1654).
            "input": [{ "type": "text", "text": text, "text_elements": [] }],
            "model": self.plan.model,
            "effort": self.plan.effort,
        });
        // ★2026-09-05 — 속도 티어(스키마 `TurnStartParams.serviceTier`: "이 턴과 이후 턴의 티어를
        // 덮어쓴다"). 표준이면 싣지 않는다 — 스레드가 든 값을 건드리지 않는 것이 서버 기본.
        if let Some(t) = &self.plan.service_tier {
            params["serviceTier"] = json!(t);
        }
        self.req("turn/start", params, Pending::Turn)
    }

    /// 카드 응답 본문 → JSON-RPC 응답. **어휘가 셋**이다(engine.ts:1368-1404).
    fn answer_ask(&self, ask: &Ask, body: &Value) -> Value {
        let behavior = body.get("behavior").and_then(Value::as_str).unwrap_or("deny");
        let allow = behavior == "allow" || behavior == "allow_always";
        // `ccgAlways`/`ccgAnswers`는 **셸이 Codex 채팅에만 실어 주는 자리**다
        // (Claude 경로의 control_response에는 존재하지 않는다 — engine/hub.rs).
        let always = body.get("ccgAlways").and_then(Value::as_bool).unwrap_or(false);
        match ask.kind {
            AskKind::Modern => json!({ "jsonrpc": "2.0", "id": ask.rpc_id, "result": {
                "decision": if allow { if always { "acceptForSession" } else { "accept" } } else { "decline" } }}),
            AskKind::Legacy => json!({ "jsonrpc": "2.0", "id": ask.rpc_id, "result": {
                "decision": if allow { if always { "approved_for_session" } else { "approved" } } else { "denied" } }}),
            AskKind::Question => {
                let rows = body.get("ccgAnswers").and_then(Value::as_array).cloned().unwrap_or_default();
                if rows.is_empty() {
                    // 건너뛰기 — 오류로 풀면 **도구 호출만 실패하고 턴은 이어진다**
                    // (실측: 모델이 "응답을 받지 못했다"로 인지하고 진행 — engine.ts:1393-1397).
                    return json!({ "jsonrpc": "2.0", "id": ask.rpc_id,
                                   "error": { "code": -32000, "message": "user dismissed the question without answering" }});
                }
                let mut answers = Map::new();
                for (i, qid) in ask.qids.iter().enumerate() {
                    let picked = rows.get(i).cloned().unwrap_or(json!([]));
                    answers.insert(qid.clone(), json!({ "answers": picked }));
                }
                json!({ "jsonrpc": "2.0", "id": ask.rpc_id, "result": { "answers": answers } })
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 들어오는 것 — JSON-RPC → Claude 프레임
    // ─────────────────────────────────────────────────────────────────────────

    /// 주기 작업(백그라운드 터미널 폴링). 드라이버가 매 tick 부른다.
    pub fn tick(&mut self, now: Millis) -> Vec<Egress> {
        let mut out = vec![];
        let Some(t) = self.thread_id.clone() else { return out };
        // 턴이 돌지 않고 추적 중인 터미널도 없으면 폴링하지 않는다(유휴에 파이프를 안 깨운다).
        if self.turn_id.is_none() && self.bg.is_empty() {
            return out;
        }
        if now.saturating_sub(self.last_bg_poll) < BG_POLL {
            return out;
        }
        self.last_bg_poll = now;
        out.push(self.req(
            "thread/backgroundTerminals/list",
            json!({ "threadId": t }),
            Pending::BgList(None),
        ));
        out
    }

    pub fn on_rpc(&mut self, msg: &Value, now: Millis) -> Vec<Egress> {
        let has_method = msg.get("method").and_then(Value::as_str).is_some();
        let id = msg.get("id");
        match (id, has_method) {
            // ① 응답
            (Some(_), false) => self.on_response(msg, now),
            // ② 서버→클라 요청
            (Some(i), true) => self.on_server_request(i.clone(), msg),
            // ③ 알림
            (None, true) => self.on_notification(msg, now),
            _ => vec![],
        }
    }

    fn refresh_tooling(&mut self) -> Vec<Egress> {
        if self.thread_id.is_none() { return vec![]; }
        if self.pending.values().any(|p| matches!(p, Pending::ToolConfig | Pending::Skills | Pending::Mcp)) {
            self.tool_refresh_queued = true;
            return vec![];
        }
        self.mcp.clear();
        self.mcp_cursors.clear();
        self.mcp_complete = false;
        self.tool_errors.clear();
        vec![
            self.req("config/read", json!({"cwd":self.plan.cwd,"includeLayers":false}), Pending::ToolConfig),
            self.req("skills/list", json!({"cwds":[self.plan.cwd],"forceReload":true}), Pending::Skills),
            self.req("mcpServerStatus/list", json!({"threadId":self.thread_id,"limit":100,"detail":"toolsAndAuthOnly"}), Pending::Mcp),
        ]
    }

    fn tooling_frame(&self) -> Option<Egress> {
        if !self.mcp_complete || self.pending.values().any(|p| matches!(p, Pending::ToolConfig | Pending::Skills | Pending::Mcp)) { return None; }
        let tooling = super::tooling::snapshot(&self.plan.cwd,self.plan.account.as_deref(),self.plan.api_mode,
            self.tool_config.as_ref()?,self.skills.as_ref()?,&self.mcp,&self.tool_errors.values().cloned().collect::<Vec<_>>());
        Some(Egress::Frame(json!({"type":"system","subtype":SYNTH,"kind":"tooling","tooling":tooling})))
    }

    fn on_response(&mut self, msg: &Value, now: Millis) -> Vec<Egress> {
        let mut out = vec![];
        let Some(id) = msg.get("id").and_then(Value::as_i64) else { return out };
        let Some(p) = self.pending.remove(&id) else { return out };
        let err = msg
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let res = msg.get("result").cloned().unwrap_or(Value::Null);
        match p {
            Pending::Initialize => {
                if let Some(e) = err {
                    out.push(Egress::Frame(self.fail_result(&e, now)));
                    return out;
                }
                self.initialized = true;
                out.push(Egress::Rpc(json!({"jsonrpc":"2.0","method":"initialized","params":{}})));
                // T2의 절반 — 상태기계는 우리가 보낸 `init-1`의 응답을 기다린다.
                out.push(Egress::Frame(json!({
                    "type": "control_response",
                    "response": { "subtype": "success", "request_id": "init-1", "response": {} }
                })));
                if let Some(text) = self.queued_prompt.take() {
                    out.extend(self.start_or_turn(text));
                }
            }
            Pending::Thread => {
                if let Some(e) = err {
                    out.push(Egress::Frame(self.fail_result(&e, now)));
                    return out;
                }
                let tid = s(&res["thread"], "id")
                    .or_else(|| s(&res, "threadId"))
                    .or_else(|| self.plan.resume.clone())
                    .unwrap_or_default();
                if tid.is_empty() {
                    out.push(Egress::Frame(
                        self.fail_result("thread/start가 스레드 id를 주지 않았어요", now),
                    ));
                    return out;
                }
                // 스레드가 갈렸으면 토큰 누계 베이스도 새로 잡는다(engine.ts:1643-1648).
                if self.thread_id.as_deref() != Some(tid.as_str()) {
                    self.usage_total = Usage::default();
                    self.usage_base = Usage::default();
                    self.usage_adopt = true;
                }
                self.thread_id = Some(tid.clone());
                // T2의 나머지 — Codex의 threadId가 곧 우리 `session_id`다(resume 키).
                out.push(Egress::Frame(json!({
                    "type": "system", "subtype": "init",
                    "engine": "codex",
                    "session_id": tid,
                    "model": self.plan.model,
                    "cwd": self.plan.cwd,
                    "tools": [],
                    // `result.viaApi`의 진실(토글이 아니라 인증 경로 — wire.rs).
                    "apiKeySource": if self.plan.api_mode { "apiKey" } else { "none" },
                })));
                if let Some(text) = self.queued_prompt.take() {
                    out.push(self.turn_start(&text));
                }
                out.extend(self.refresh_tooling());
            }
            Pending::Reload(text) => {
                // An older CLI may not support reload. It must not swallow the
                // user's next turn; surface its diagnostic in the inventory.
                out.push(self.turn_start(&text));
                out.extend(self.refresh_tooling());
                if let Some(e) = err { self.tool_errors.insert("reload".into(),e); }
            }
            Pending::ToolConfig | Pending::Skills | Pending::Mcp => {
                let key = match p { Pending::ToolConfig => "config", Pending::Skills => "skills", _ => "mcp" };
                if let Some(e) = err { self.tool_errors.insert(key.into(),e); }
                match p {
                    Pending::ToolConfig => self.tool_config = Some(res),
                    Pending::Skills => self.skills = Some(res),
                    _ => {
                        if let Some(data) = res["data"].as_array() { self.mcp.extend(data.iter().cloned()); }
                        if let Some(cursor) = res["nextCursor"].as_str().filter(|s| !s.is_empty()) {
                            if self.mcp_cursors.insert(cursor.to_string()) {
                                out.push(self.req("mcpServerStatus/list",json!({"threadId":self.thread_id,"cursor":cursor,"limit":100,"detail":"toolsAndAuthOnly"}),Pending::Mcp));
                            } else {
                                self.tool_errors.insert("mcp".into(),"Codex returned a repeated MCP cursor".into());
                                self.mcp_complete = true;
                            }
                        } else { self.mcp_complete = true; }
                    }
                }
                out.extend(self.tooling_frame());
                if self.tool_refresh_queued && !self.pending.values().any(|p| matches!(p, Pending::ToolConfig | Pending::Skills | Pending::Mcp)) {
                    self.tool_refresh_queued = false;
                    out.extend(self.refresh_tooling());
                }
            }
            Pending::Turn => {
                if let Some(e) = err {
                    out.push(Egress::Frame(self.fail_result(&e, now)));
                    return out;
                }
                // 응답을 기다리는 사이 `turn/started`가 먼저 채택했으면 보존(engine.ts:1659-1663).
                let tid = s(&res["turn"], "id").or_else(|| s(&res, "id"));
                if self.turn_id.is_none() {
                    self.turn_id = tid;
                }
            }
            Pending::BgList(probe) => {
                if let Some(rid) = probe {
                    // 프로브 응답 자체는 신호가 아니다 — 뒤따르는 REPLACE가 판정한다(§5.4-b).
                    out.push(Egress::Frame(json!({
                        "type": "control_response",
                        "response": { "subtype": "success", "request_id": rid,
                                      "response": { "background_tasks": [] } }
                    })));
                }
                if err.is_none() {
                    out.extend(self.reconcile_bg(&res));
                }
            }
            Pending::Fire => {}
        }
        out
    }

    /// 턴 하나를 **마감 목록**에 올린다(최근 8개 — 2.6.2 `engine.ts:1341-1343`과 같은 상한).
    ///
    /// 마감 목록에 오른 턴의 늦은 통지(`error`·`turn/completed`)는 전부 버린다. 그 통지들이
    /// 오는 창은 **다음 턴 언저리**라서, 안 버리면 남의 턴이 그 사연으로 정착한다.
    fn remember_ended(&mut self, id: String) {
        if id.is_empty() {
            return;
        }
        self.ended_turns.insert(id);
        while self.ended_turns.len() > 8 {
            let first = self.ended_turns.iter().next().cloned().unwrap_or_default();
            self.ended_turns.remove(&first);
        }
    }

    /// 실패 한 건 → 턴을 정착시키는 `result`. **침묵 no-op 금지**(D7): 어떤 실패도
    /// 화면에 문장으로 나가야 한다.
    fn fail_result(&mut self, message: &str, now: Millis) -> Value {
        if let Some(t) = self.turn_id.take() {
            // 뒤따라 올 `turn/completed{failed}`는 같은 사연의 **두 번째 통지**다.
            self.remember_ended(t);
        }
        json!({
            "type": "result", "subtype": "error_during_execution", "is_error": true,
            "result": message, "error": message,
            "duration_ms": now.saturating_sub(self.turn_started_at),
            "num_turns": 1,
            "usage": {},
        })
    }

    fn on_server_request(&mut self, rpc_id: Value, msg: &Value) -> Vec<Egress> {
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        let params = msg.get("params").cloned().unwrap_or(json!({}));
        self.ask_seq += 1;
        let rid = format!("cx-{}", self.ask_seq);
        let ask = |kind: AskKind, qids: Vec<String>| Ask {
            rpc_id: rpc_id.clone(),
            kind,
            qids,
        };
        let card = |rid: &str, tool: &str, input: Value, desc: String| {
            Egress::Frame(json!({
                "type": "control_request", "request_id": rid,
                "request": { "subtype": "can_use_tool", "tool_name": tool,
                             "tool_use_id": rid, "description": desc, "input": input }
            }))
        };
        match method {
            "item/commandExecution/requestApproval" => {
                let cmd = s(&params, "command").unwrap_or_default();
                let reason = s(&params, "reason").unwrap_or_default();
                let shown = if !cmd.is_empty() { cmd.clone() } else if !reason.is_empty() { reason } else { "명령 실행".into() };
                self.asks.insert(rid.clone(), ask(AskKind::Modern, vec![]));
                vec![card(&rid, "Bash", json!({ "command": shown }), "명령 실행".into())]
            }
            "execCommandApproval" => {
                // legacy: command가 배열로 온다(engine.ts:435).
                let cmd = match &params["command"] {
                    Value::Array(a) => a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" "),
                    v => v.as_str().unwrap_or("").to_string(),
                };
                let shown = if cmd.is_empty() { "명령 실행".to_string() } else { cmd };
                self.asks.insert(rid.clone(), ask(AskKind::Legacy, vec![]));
                vec![card(&rid, "Bash", json!({ "command": shown }), "명령 실행".into())]
            }
            "item/fileChange/requestApproval" => {
                let reason = s(&params, "reason").unwrap_or_else(|| "파일 변경 적용".into());
                self.asks.insert(rid.clone(), ask(AskKind::Modern, vec![]));
                vec![card(&rid, "Edit", json!({ "description": reason.clone() }), reason)]
            }
            "applyPatchApproval" => {
                self.asks.insert(rid.clone(), ask(AskKind::Legacy, vec![]));
                vec![card(&rid, "Edit", json!({ "description": "파일 변경 적용" }), "파일 변경 적용".into())]
            }
            // 선택형 질문 — 스키마가 `AgentQuestion`과 1:1이라 질문 카드로 그대로 흐른다.
            "item/tool/requestUserInput" => {
                let raw = params["questions"].as_array().cloned().unwrap_or_default();
                if raw.is_empty() {
                    return vec![Egress::Rpc(json!({ "jsonrpc": "2.0", "id": rpc_id,
                        "error": { "code": -32000, "message": "empty questions" }}))];
                }
                let qids: Vec<String> = raw.iter().map(|q| s(q, "id").unwrap_or_default()).collect();
                let questions: Vec<Value> = raw
                    .iter()
                    .map(|q| {
                        json!({
                            "question": s(q, "question").unwrap_or_default(),
                            "header": s(q, "header").unwrap_or_default(),
                            // Codex 질문엔 다중 선택 개념이 없다(engine.ts:456).
                            "multiSelect": false,
                            "options": q["options"].as_array().map(|o| o.iter().map(|x| json!({
                                "label": s(x, "label").unwrap_or_default(),
                                "description": s(x, "description").unwrap_or_default(),
                            })).collect::<Vec<_>>()).unwrap_or_default(),
                        })
                    })
                    .collect();
                self.asks.insert(rid.clone(), ask(AskKind::Question, qids));
                vec![card(&rid, "AskUserQuestion", json!({ "questions": questions }), "질문".into())]
            }
            // 다룰 수 없는 서버 요청(chatgptAuthTokens/refresh 등) — 거절해 서버가 폴백하게.
            other => vec![Egress::Rpc(json!({ "jsonrpc": "2.0", "id": rpc_id,
                "error": { "code": -32000, "message": format!("unsupported client request: {other}") }}))],
        }
    }

    fn on_notification(&mut self, msg: &Value, now: Millis) -> Vec<Egress> {
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        let params = msg.get("params").cloned().unwrap_or(json!({}));
        // 다른 스레드의 알림 — 추적 중인 서브에이전트면 사이드체인으로, 아니면 버린다
        // (한 프로세스에 여러 스레드가 산다 — engine.ts:480-486).
        if let Some(tid) = params.get("threadId").and_then(Value::as_str) {
            if self.thread_id.as_deref().is_some_and(|m| m != tid) {
                let tid = tid.to_string();
                return if self.agents.contains_key(&tid) {
                    self.on_agent_notification(&tid, method, &params, now)
                } else {
                    vec![]
                };
            }
        }
        match method {
            "skills/changed" | "mcpServer/startupStatus/updated" => self.refresh_tooling(),
            "item/agentMessage/delta" => {
                let delta = s(&params, "delta").unwrap_or_default();
                let item = s(&params, "itemId").unwrap_or_default();
                let mut out = vec![];
                if self.open_msg.as_deref() != Some(item.as_str()) {
                    self.open_msg = Some(item);
                    out.push(Egress::Frame(json!({ "type": "stream_event", "event": {
                        "type": "content_block_start", "content_block": { "type": "text" } }})));
                }
                out.push(Egress::Frame(json!({ "type": "stream_event", "event": {
                    "type": "content_block_delta", "delta": { "type": "text_delta", "text": delta } }})));
                out
            }
            "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => {
                self.thinking.push_str(&s(&params, "delta").unwrap_or_default());
                let tail: String = {
                    let n = self.thinking.chars().count();
                    self.thinking.chars().skip(n.saturating_sub(300)).collect()
                };
                vec![Egress::Frame(json!({ "type": "stream_event", "event": {
                    "type": "content_block_delta", "delta": { "type": "thinking_delta", "thinking": tail } }}))]
            }
            "item/reasoning/summaryPartAdded" => {
                self.thinking.clear();
                vec![]
            }
            "item/started" => self.on_item_started(&params["item"]),
            "item/completed" => self.on_item_completed(&params["item"], now),
            "item/commandExecution/outputDelta" => {
                let item = s(&params, "itemId").unwrap_or_default();
                let delta = s(&params, "delta").unwrap_or_default();
                // 백그라운드로 넘어간 명령의 출력은 테일 파일로(렌더러 셸 카드가 폴링한다).
                if let Some(bg) = self.bg.get(&item) {
                    return vec![Egress::Tail { file: bg.file.clone(), text: strip_ansi(&delta) }];
                }
                if let Some(it) = self.items.get_mut(&item) {
                    it.out.push_str(&delta);
                    // 꼬리 8000자만 — tool_result가 통째로 IPC를 타지 않게(2.6.2와 같은 상한).
                    let n = it.out.chars().count();
                    if n > 8000 {
                        it.out = it.out.chars().skip(n - 8000).collect();
                    }
                }
                vec![]
            }
            "turn/plan/updated" => {
                let todos: Vec<Value> = params["plan"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .enumerate()
                            .map(|(i, p)| {
                                json!({
                                    "id": format!("cxtodo-{i}"),
                                    "label": s(p, "step").unwrap_or_default(),
                                    "status": match p.get("status").and_then(Value::as_str) {
                                        Some("completed") => "done",
                                        Some("inProgress") => "running",
                                        _ => "pending",
                                    },
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                vec![Egress::Frame(json!({ "type": "system", "subtype": SYNTH,
                                           "kind": "todos", "todos": todos }))]
            }
            "thread/tokenUsage/updated" => self.on_token_usage(&params["tokenUsage"]),
            "turn/started" => {
                // turn/start 응답보다 먼저 실리는 개시 통지 — 시작 창을 여기서 닫는다.
                if self.turn_id.is_none() {
                    self.turn_id = s(&params["turn"], "id");
                }
                self.turn_started_at = now;
                vec![]
            }
            "turn/completed" => self.on_turn_completed(&params["turn"], now),
            "error" => {
                // ★ turnId 게이트 3종(2.6.2 `engine.ts:606-609`) — 순서까지 그대로다.
                //   ① 마감한 턴의 늦은 error → 결과 카드가 두 장 그려진다.
                //   ② 시작 창(턴 채택 전)의 error → **새 실행이 이전 턴의 오류로 즉사한다.**
                //   ③ 남의 턴의 error → 지금 도는 턴이 남의 사연으로 정착한다.
                //   turnId가 없는 error(비정형)만 종전처럼 도착 순서로 흐른다 —
                //   `turn/start` 자체의 실패는 통지가 아니라 RPC 오류로 오기 때문이다.
                if let Some(et) = s(&params, "turnId").filter(|t| !t.is_empty()) {
                    if self.ended_turns.contains(&et) {
                        return vec![];
                    }
                    match self.turn_id.as_deref() {
                        None => return vec![],
                        Some(cur) if cur != et => return vec![],
                        _ => {}
                    }
                }
                let err = &params["error"];
                let message = s(err, "message").unwrap_or_else(|| "Codex 실행 오류".into());
                if params.get("willRetry").and_then(Value::as_bool) == Some(true) {
                    return vec![Egress::Frame(json!({ "type": "system", "subtype": "notification",
                        "text": format!("Codex: {message} — 다시 시도하는 중이에요.") }))];
                }
                // 수용량 초과(serverOverloaded)는 여기서 죽이지 않는다 — 같은 오류의
                // turn/completed(failed)가 곧 따라오고 그쪽이 정착시킨다(engine.ts:620-622).
                if is_capacity_err(err) {
                    return vec![Egress::Frame(json!({ "type": "system", "subtype": "notification",
                        "text": format!("Codex: {message}") }))];
                }
                vec![Egress::Frame(self.fail_result(&message, now))]
            }
            // ★ 0.149.0 실측(2.6.2에는 없던 통지) — 전송 경로 강등 같은 **사용자에게
            //   보여야 할 사연**이 여기로 온다("Falling back from WebSockets to HTTPS…").
            //   버리면 화면은 아무 일도 없는데 느려진 것처럼 보인다.
            "warning" => {
                let text = s(&params, "message").unwrap_or_default();
                if text.is_empty() {
                    return vec![];
                }
                vec![Egress::Frame(json!({ "type": "system", "subtype": "notification",
                                           "text": format!("Codex: {text}") }))]
            }
            // 아래는 **일부러 버린다**(0.149.0 실측으로 관측했고, 화면에 대응물이 없다):
            //  · thread/started · thread/settings/updated — 우리는 threadId를 RPC 응답에서 받는다
            //  · thread/status/changed — 같은 사연이 error/turn.completed로 이미 온다
            //  · remoteControl/status/changed — 원격 제어 기능(우리가 안 켠다)
            "thread/started" | "thread/settings/updated" | "thread/status/changed"
            | "remoteControl/status/changed" => vec![],
            _ => vec![],
        }
    }

    fn on_token_usage(&mut self, usage: &Value) -> Vec<Egress> {
        let g = |v: &Value, k: &str| v.get(k).and_then(Value::as_u64).unwrap_or(0);
        let last = &usage["last"];
        let total = &usage["total"];
        let ctx = last
            .get("totalTokens")
            .and_then(Value::as_u64)
            .or_else(|| total.get("totalTokens").and_then(Value::as_u64));
        if let Some(c) = ctx {
            self.ctx_tokens = Some(c);
        }
        if let Some(w) = usage.get("modelContextWindow").and_then(Value::as_u64) {
            self.ctx_window = Some(w);
        }
        if total.is_object() {
            self.usage_total = Usage {
                in_tok: g(total, "inputTokens"),
                cached: g(total, "cachedInputTokens"),
                out_tok: g(total, "outputTokens"),
            };
            if self.usage_adopt {
                // 스레드 교체 후 첫 통지 — base = total − last (resume이 과거 누계를
                // 실어 오는 경우 그 과거분이 이번 턴에 귀속되는 것을 막는다 · engine.ts:562-571).
                self.usage_adopt = false;
                self.usage_base = Usage {
                    in_tok: self.usage_total.in_tok.saturating_sub(g(last, "inputTokens")),
                    cached: self.usage_total.cached.saturating_sub(g(last, "cachedInputTokens")),
                    out_tok: self.usage_total.out_tok.saturating_sub(g(last, "outputTokens")),
                };
            }
        }
        match self.ctx_tokens {
            Some(c) => vec![Egress::Frame(json!({ "type": "system", "subtype": SYNTH, "kind": "context",
                                                  "tokens": c, "window": self.ctx_window }))],
            None => vec![],
        }
    }

    fn on_turn_completed(&mut self, turn: &Value, now: Millis) -> Vec<Egress> {
        // `error` 게이트와 **대칭**인 셋(2.6.2 `engine.ts:592-599`).
        //  ① 이미 마감한 턴의 늦은 통지 — 결과 카드를 두 장 그리지 않는다(중복 completed 포함).
        //  ② 시작 창에 도착한 id 달린 completed는 전부 잔재다 — 실측 와이어 순서가
        //     `turn/start` 응답 → `turn/started` → … → `completed` 라서 우리 턴의 completed는
        //     채택보다 먼저 올 수 없다.
        //  ③ 남의 턴의 completed — 1턴의 늦은 `interrupted`가 2턴을 `aborted_by_user`로 정착시킨다.
        // id 없는 프레임(비정형)만 종전처럼 도착 순서로 정착시킨다.
        if let Some(id) = turn.get("id").and_then(Value::as_str).filter(|i| !i.is_empty()) {
            if self.ended_turns.contains(id) {
                return vec![];
            }
            match self.turn_id.as_deref() {
                None => return vec![],
                Some(cur) if cur != id => return vec![],
                _ => {}
            }
            self.remember_ended(id.to_string());
        }
        let status = turn.get("status").and_then(Value::as_str).unwrap_or("completed");
        let failed = status == "failed";
        let interrupted = status == "interrupted";
        let err = &turn["error"];
        let msg = s(err, "message");
        self.turn_id = None;
        self.open_msg = None;
        self.thinking.clear();
        // 이 턴이 소모한 실측 토큰 = 스레드 누계의 정착 간 델타(engine.ts:1100-1107).
        let d_in = self.usage_total.in_tok.saturating_sub(self.usage_base.in_tok);
        let d_cached = self.usage_total.cached.saturating_sub(self.usage_base.cached);
        let d_out = self.usage_total.out_tok.saturating_sub(self.usage_base.out_tok);
        self.usage_base = self.usage_total.clone();
        let mut model_usage = Map::new();
        // 체크드 덧셈 — 서버가 말도 안 되는 숫자를 주면 디버그 빌드가 여기서 패닉한다
        // (`panic="abort"` 릴리스라면 앱이 통째로 죽는 자리다).
        if d_in.saturating_add(d_out) > 0 {
            model_usage.insert(
                self.plan.model.clone(),
                json!({
                    "inputTokens": d_in.saturating_sub(d_cached),
                    "outputTokens": d_out,
                    "cacheReadInputTokens": d_cached,
                    // Codex는 캐시 '쓰기'를 보고하지 않는다.
                    "cacheCreationInputTokens": 0,
                    "contextWindow": self.ctx_window,
                }),
            );
        }
        let text = if failed {
            msg.clone().unwrap_or_else(|| "실행이 실패했어요".into())
        } else if interrupted {
            "중단됨".to_string()
        } else {
            String::new()
        };
        let mut f = json!({
            "type": "result",
            "subtype": if failed { "error_during_execution" } else { "success" },
            "is_error": failed,
            "result": text,
            "duration_ms": turn.get("durationMs").and_then(Value::as_u64)
                .unwrap_or_else(|| now.saturating_sub(self.turn_started_at)),
            "num_turns": 1,
            // ★ `usage.input_tokens`는 **컨텍스트 게이지 전용 자리**로 쓴다(wire.rs가
            //   input+cache로 ctx를 만든다). 실 토큰 회계의 진실은 `modelUsage`다.
            "usage": { "input_tokens": self.ctx_tokens.unwrap_or(0), "output_tokens": 0,
                       "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0 },
            "modelUsage": Value::Object(model_usage),
        });
        if failed {
            f["error"] = json!(msg.unwrap_or_else(|| "실행이 실패했어요".into()));
        }
        if interrupted {
            // T14 — 중단으로 끝난 턴은 완료도 오류도 아니다(`Aborted`).
            f["terminal_reason"] = json!("aborted_by_user");
        }
        vec![Egress::Frame(f)]
    }

    // ── 아이템(도구 행) ──────────────────────────────────────────────────────

    fn on_item_started(&mut self, item: &Value) -> Vec<Egress> {
        let Some(id) = s(item, "id").filter(|i| !i.is_empty()) else { return vec![] };
        let ty = item.get("type").and_then(Value::as_str).unwrap_or("");
        let (name, input) = match ty {
            "commandExecution" => (
                "Bash".to_string(),
                json!({ "command": s(item, "command").unwrap_or_default() }),
            ),
            "fileChange" => {
                let paths = item["changes"]
                    .as_array()
                    .map(|a| a.iter().filter_map(|c| s(c, "path")).collect::<Vec<_>>())
                    .unwrap_or_default();
                // ★ 이름이 `Edit`이면 셸의 diff 조립기가 **Claude 도구 입력**을 기대해
                //   빈 diff를 만든다. Codex의 변경은 완료 프레임의 unified diff가 진실이라
                //   전용 이름을 쓴다(wire.rs `tool_label`이 같은 'edit' 종류로 그린다).
                ("codex_file_change".to_string(), json!({ "file_path": paths.join(", "), "file_paths": paths }))
            }
            "mcpToolCall" => {
                let server = s(item, "server").unwrap_or_default();
                let tool = s(item, "tool").unwrap_or_else(|| "MCP".into());
                (format!("mcp__{server}__{tool}"), json!({ "description": server }))
            }
            "webSearch" => {
                let t = web_target(item);
                (
                    "WebSearch".to_string(),
                    json!({ "query": if t.is_empty() { "검색 중…".to_string() } else { t } }),
                )
            }
            // 서브에이전트 — 도구 행이 아니라 카드다. 스폰 통지 두 갈래를 함께 받는다.
            "collabAgentToolCall" => return self.on_collab_started(&id, item),
            "subAgentActivity" => return self.on_subagent_activity(item),
            _ => return vec![],
        };
        self.items.insert(
            id.clone(),
            Item { name: name.clone(), out: String::new() },
        );
        vec![Egress::Frame(json!({ "type": "assistant", "message": { "content": [
            { "type": "tool_use", "id": id, "name": name, "input": input } ] }}))]
    }

    fn on_item_completed(&mut self, item: &Value, now: Millis) -> Vec<Egress> {
        let id = s(item, "id").unwrap_or_default();
        let ty = item.get("type").and_then(Value::as_str).unwrap_or("");
        match ty {
            "agentMessage" => {
                self.open_msg = None;
                vec![Egress::Frame(json!({ "type": "assistant", "message": { "content": [
                    { "type": "text", "text": s(item, "text").unwrap_or_default() } ] }}))]
            }
            "reasoning" => {
                self.thinking.clear();
                vec![]
            }
            "commandExecution" => {
                let exit = item.get("exitCode").and_then(Value::as_i64);
                let acc = self.items.get(&id).map(|i| i.out.clone()).unwrap_or_default();
                self.items.remove(&id);
                // 백그라운드로 넘어갔던 명령의 진짜 종말 — 칩은 REPLACE가 거둔다.
                if let Some(bg) = self.bg.remove(&id) {
                    self.bg_by_process.remove(&bg.process_id);
                    let output = s(item, "aggregatedOutput").unwrap_or_default();
                    let mut out = vec![];
                    // ★ **자연 종료면 도구 행을 되살린다**(2.6.2 `engine.ts:851-866`).
                    //   완료 아이템이 전체 출력을 들고 오므로, '백그라운드로 전환'으로 일찍
                    //   닫힌 행에 최종 출력·성패를 정착시켜 로그를 클릭해 볼 수 있게 한다.
                    //   중지는 제외 — 그 사연은 칩이 표기하고 행은 전환 표시를 유지한다.
                    if !bg.stopped && !output.is_empty() {
                        let tail: String = {
                            let n = output.chars().count();
                            output.chars().skip(n.saturating_sub(8000)).collect()
                        };
                        out.push(Egress::Frame(tool_result(
                            &id,
                            exit.is_some_and(|e| e != 0),
                            &tail,
                        )));
                    }
                    out.extend(self.bg_replace());
                    let mut note = json!({ "type": "system", "subtype": "task_notification",
                        "task_id": bg.process_id,
                        "status": if bg.stopped { "stopped" }
                                  else if exit == Some(0) { "completed" } else { "failed" },
                        "output_file": bg.file });
                    if bg.stopped {
                        // 사유 없음 — 우리가 죽여서 난 `exit -1`을 사용자에게 보여 주지 않는다.
                        // 대신 주체를 싣는다(`frames.rs`가 `by_user`로 읽어 정착 사유를 가른다).
                        note["stopped_by_user"] = json!(true);
                    } else {
                        note["summary"] = json!(format!(
                            "exit {}",
                            exit.map(|e| e.to_string()).unwrap_or_else(|| "?".into())
                        ));
                    }
                    out.push(Egress::Frame(note));
                    return out;
                }
                let output = s(item, "aggregatedOutput").filter(|o| !o.is_empty()).unwrap_or(acc);
                vec![Egress::Frame(tool_result(&id, exit.is_some_and(|e| e != 0), &output))]
            }
            "fileChange" => {
                let status = item.get("status").and_then(Value::as_str).unwrap_or("");
                let failed = status == "failed" || status == "declined";
                self.items.remove(&id);
                let mut out = vec![];
                if !failed {
                    // 변경 본문은 **셸이 디스크와 대조해** 누적 diff로 만든다(wire.rs) —
                    // 순수 옮김기는 와이어 값을 그대로 실어 보낸다.
                    out.push(Egress::Frame(json!({ "type": "system", "subtype": SYNTH,
                        "kind": "file_change", "itemId": id,
                        "cwd": self.plan.cwd,
                        "changes": item.get("changes").cloned().unwrap_or(json!([])) })));
                }
                out.push(Egress::Frame(tool_result(
                    &id,
                    failed,
                    if failed { "적용 안 됨" } else { "" },
                )));
                out
            }
            "mcpToolCall" | "webSearch" => {
                let failed = item
                    .get("status")
                    .and_then(Value::as_str)
                    .is_some_and(|s| s.to_ascii_lowercase().contains("fail"));
                self.items.remove(&id);
                let body = if ty == "webSearch" { web_target(item) } else { String::new() };
                vec![Egress::Frame(tool_result(&id, failed, &body))]
            }
            "collabAgentToolCall" => self.on_collab_completed(&id, item),
            "subAgentActivity" => self.on_subagent_activity(item),
            _ => {
                let _ = now;
                vec![]
            }
        }
    }

    // ── 서브에이전트 ─────────────────────────────────────────────────────────

    fn on_collab_started(&mut self, id: &str, item: &Value) -> Vec<Egress> {
        let tool = s(item, "tool").unwrap_or_default();
        let receivers: Vec<String> = item["receiverThreadIds"]
            .as_array()
            .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default();
        if tool != "spawnAgent" {
            return vec![]; // 제어 호출(wait·sendInput·closeAgent)은 행/카드가 없다.
        }
        let Some(aid) = receivers.first().cloned() else { return vec![] };
        let prompt = s(item, "prompt").unwrap_or_default();
        let input = json!({ "subagent_type": "Agent", "description": one_line(&prompt, 200),
                            "prompt": prompt });
        self.agents.insert(
            aid,
            Agent { tool_id: id.to_string(), input: input.clone(), done: false },
        );
        self.items.insert(
            id.to_string(),
            Item { name: "Task".into(), out: String::new() },
        );
        vec![Egress::Frame(agent_card(id, &input))]
    }

    fn on_collab_completed(&mut self, id: &str, item: &Value) -> Vec<Egress> {
        let states = item["agentsStates"].as_object().cloned().unwrap_or_default();
        let tool = s(item, "tool").unwrap_or_default();
        let mut out = vec![];
        for (aid, st) in states {
            let st = st.as_str().unwrap_or("").to_string();
            let ended = tool == "closeAgent"
                || ["completed", "errored", "shutdown", "closed", "notfound"]
                    .iter()
                    .any(|k| st.to_ascii_lowercase().contains(k));
            if !ended {
                continue;
            }
            if let Some(a) = self.agents.remove(&aid) {
                // 닫는 경로가 셋이라 두 번 닫지 않는다(턴 완료가 먼저 닫았을 수 있다).
                if !a.done {
                    out.push(Egress::Frame(tool_result(&a.tool_id, st.contains("error"), &st)));
                }
                self.items.remove(&a.tool_id);
            }
        }
        // spawnAgent 자체의 완료는 "접수 완료"일 뿐 — 카드는 살아 있다(engine.ts:974-976).
        if tool == "spawnAgent" && out.is_empty() {
            out.push(Egress::Frame(tool_result(id, false, "백그라운드에서 진행 중")));
        }
        out
    }

    /// `subAgentActivity{kind, agentThreadId, agentPath}` — started면 카드 생성,
    /// 종결 계열이면 카드 정착(engine.ts:703-735). started·completed 양쪽에서 온다.
    fn on_subagent_activity(&mut self, item: &Value) -> Vec<Egress> {
        let Some(aid) = s(item, "agentThreadId").filter(|a| !a.is_empty()) else { return vec![] };
        let kind = s(item, "kind").unwrap_or_default();
        if kind == "started" {
            if self.agents.contains_key(&aid) {
                return vec![];
            }
            let tool_id = format!("cxagent-{aid}");
            let name = s(item, "agentPath")
                .and_then(|p| p.split('/').filter(|s| !s.is_empty()).next_back().map(str::to_string))
                .unwrap_or_else(|| "Agent".into());
            let input = json!({ "subagent_type": name, "description": "서브에이전트" });
            self.agents.insert(
                aid,
                Agent { tool_id: tool_id.clone(), input: input.clone(), done: false },
            );
            self.items.insert(
                tool_id.clone(),
                Item { name: "Task".into(), out: String::new() },
            );
            return vec![Egress::Frame(agent_card(&tool_id, &input))];
        }
        let closing = ["clos", "end", "stop", "shutdown", "interrupt"]
            .iter()
            .any(|k| kind.to_ascii_lowercase().contains(k));
        if !closing {
            return vec![];
        }
        match self.agents.remove(&aid) {
            Some(a) => {
                self.items.remove(&a.tool_id);
                if a.done {
                    return vec![]; // 턴 완료가 이미 닫았다 — 카드를 두 번 정착시키지 않는다.
                }
                vec![Egress::Frame(tool_result(&a.tool_id, false, "완료"))]
            }
            None => vec![],
        }
    }

    /// 서브에이전트 스레드에서 온 알림 → **사이드체인 프레임**(부모 카드에 귀속).
    /// 메인 말풍선·게이지·모델 배너를 절대 건드리지 않는다(wire.rs의 조기 분리 규약).
    ///
    /// 2.6.2 `onAgentThreadNotification`(`engine.ts:740-828`)이 다루는 것은 **넷**이다 —
    /// `turn/started`·`item/started`·`item/completed`·`turn/completed`. 턴 계열 둘은
    /// 카드 **자체**의 상태라 사이드체인 봉투에 싸지 않는다(싸면 자기 자신의 자식이 된다).
    fn on_agent_notification(
        &mut self,
        aid: &str,
        method: &str,
        params: &Value,
        now: Millis,
    ) -> Vec<Egress> {
        let Some(agent) = self.agents.get(aid).cloned() else { return vec![] };
        let parent = agent.tool_id.as_str();
        let side = |v: Value| {
            let mut f = v;
            f["parent_tool_use_id"] = json!(parent);
            Egress::Frame(f)
        };
        match method {
            // sendInput 등으로 서브에이전트 턴이 다시 돌면 카드도 '실행 중'으로 되돌린다
            // (2.6.2 `engine.ts:741-750`). 같은 `tool_use`를 다시 실으면 셸이 카드를
            // upsert 한다 — 닫혔던 행이 되살아나고, 안 닫혔으면 아무것도 안 바뀐다.
            "turn/started" => {
                if let Some(a) = self.agents.get_mut(aid) {
                    a.done = false;
                }
                self.items
                    .entry(agent.tool_id.clone())
                    .or_insert_with(|| Item { name: "Task".into(), out: String::new() });
                vec![Egress::Frame(agent_card(&agent.tool_id, &agent.input))]
            }
            // ★ **주 종결 경로** — "턴 완료가 곧 작업 완료"(2.6.2 `engine.ts:806-823`).
            //   이게 없으면 남은 종결 경로 둘(`subAgentActivity{clos*}` ·
            //   `collabAgentToolCall.agentsStates`)이 안 올 때 Task 행이 원장에 **영구
            //   running**으로 남아 스피너가 안 멈추고 턴 정착이 늘어진다.
            "turn/completed" => {
                if agent.done {
                    return vec![];
                }
                if let Some(a) = self.agents.get_mut(aid) {
                    a.done = true;
                }
                self.items.remove(&agent.tool_id);
                let failed = params["turn"].get("status").and_then(Value::as_str)
                    == Some("failed");
                vec![Egress::Frame(tool_result(
                    &agent.tool_id,
                    failed,
                    if failed { "실패" } else { "완료" },
                ))]
            }
            "item/started" => {
                let inner = self.on_item_started(&params["item"]);
                inner
                    .into_iter()
                    .map(|e| match e {
                        Egress::Frame(f) => side(f),
                        other => other,
                    })
                    .collect()
            }
            "item/completed" => {
                let item = &params["item"];
                // 답변·생각은 카드 activity 한 줄로(도구가 아닌 활동).
                if item.get("type").and_then(Value::as_str) == Some("agentMessage") {
                    let text = one_line(&s(item, "text").unwrap_or_default(), 200);
                    return vec![side(json!({ "type": "assistant", "message": {
                        "content": [{ "type": "text", "text": text }] }}))];
                }
                self.on_item_completed(item, now)
                    .into_iter()
                    .map(|e| match e {
                        Egress::Frame(f) => side(f),
                        other => other,
                    })
                    .collect()
            }
            _ => vec![],
        }
    }

    // ── 백그라운드 터미널(unified exec) ──────────────────────────────────────

    /// `thread/backgroundTerminals/list` 결과 → 살아 있는 목록 REPLACE.
    fn reconcile_bg(&mut self, res: &Value) -> Vec<Egress> {
        let rows = res["data"].as_array().cloned().unwrap_or_default();
        let mut out = vec![];
        let mut seen: Vec<String> = vec![];
        for tk in &rows {
            let item_id = s(tk, "itemId").unwrap_or_default();
            let pid = s(tk, "processId").unwrap_or_default();
            if item_id.is_empty() || pid.is_empty() {
                continue;
            }
            seen.push(item_id.clone());
            if self.bg.contains_key(&item_id) {
                continue;
            }
            // 백그라운드로 넘어가는 것은 **명령 행뿐**이다. 모르는 item이 목록에 있으면
            // (서버가 우리에게 started를 안 준 명령) 행을 닫을 것도 없다 — 칩만 만든다.
            let is_cmd = self.items.get(&item_id).is_some_and(|i| i.name == "Bash");
            let file = format!(
                "{}/ccg-codex-term-{}.log",
                self.tmp_dir.trim_end_matches(['/', '\\']),
                pid.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).collect::<String>()
            );
            // 전환 전까지 쌓인 출력으로 테일을 시작한다(2.6.2 `engine.ts:1037`).
            let head = self.items.get(&item_id).map(|i| strip_ansi(&i.out)).unwrap_or_default();
            if !head.is_empty() {
                out.push(Egress::Tail { file: file.clone(), text: head });
            }
            self.bg.insert(
                item_id.clone(),
                Bg {
                    process_id: pid.clone(),
                    command: s(tk, "command").unwrap_or_default(),
                    file,
                    stopped: false,
                },
            );
            self.bg_by_process.insert(pid, item_id.clone());
            // 도구 행은 여기서 닫는다 — 스피너가 턴 끝까지 도는 것을 막는다(engine.ts:1043-1052).
            if is_cmd {
                out.push(Egress::Frame(tool_result(&item_id, false, "백그라운드로 전환")));
            }
        }
        // 목록에서 사라진 것 = 서버가 거둔 것. REPLACE가 알아서 정착시킨다.
        // 단 **중지 요청을 보낸 것은 남긴다** — terminate 직후 목록에서 먼저 빠지고
        // `item/completed{exit -1}`가 조금 뒤에 오는데, 여기서 지우면 그 완료가 bg 분기를
        // 못 타 사용자가 멈춘 셸이 다시 `failed`로 뜬다(2.6.2에는 이 쓸기 자체가 없다).
        let gone: Vec<String> = self
            .bg
            .iter()
            .filter(|(k, b)| !seen.contains(k) && !b.stopped)
            .map(|(k, _)| k.clone())
            .collect();
        for k in gone {
            if let Some(b) = self.bg.remove(&k) {
                self.bg_by_process.remove(&b.process_id);
            }
        }
        out.extend(self.bg_replace());
        out
    }

    /// 살아 있는 백그라운드 셸의 REPLACE 프레임.
    ///
    /// `task_type`에 `shell`을 넣는 이유: 분류기 둘(`frames.rs::classify_task_type`,
    /// 셸의 `wire.rs`)이 이름으로 셸/워크플로/에이전트를 가른다. 공유 파일을 안 건드리려고
    /// **우리 쪽 이름에 접미사를 붙였다** — 값의 뜻은 "codex unified exec = PTY 셸"이다.
    fn bg_replace(&self) -> Vec<Egress> {
        let tasks: Vec<Value> = self
            .bg
            .values()
            // 중지 요청을 보낸 셸은 즉시 칩에서 뺀다(2.6.2 `emitBgTasks`의 `!t.stopped`).
            .filter(|b| !b.stopped)
            .map(|b| {
                json!({
                    "task_id": b.process_id,
                    "task_type": "unified_exec_shell",
                    "description": one_line(&b.command, 120),
                    "output_file": b.file,
                })
            })
            .collect();
        vec![Egress::Frame(json!({ "type": "system", "subtype": "background_tasks_changed",
                                   "tasks": tasks }))]
    }
}

/// 서브에이전트 카드를 여는(또는 되살리는) `assistant{tool_use Task}` 한 장.
fn agent_card(tool_id: &str, input: &Value) -> Value {
    json!({ "type": "assistant", "message": { "content": [
        { "type": "tool_use", "id": tool_id, "name": "Task", "input": input } ] }})
}

/// `user{tool_result}` 한 장 — 도구 행을 닫는 유일한 모양(F11).
fn tool_result(id: &str, is_error: bool, content: &str) -> Value {
    json!({ "type": "user", "message": { "content": [
        { "type": "tool_result", "tool_use_id": id, "is_error": is_error, "content": content } ] }})
}

/// 모델 수용량 초과(2.6.2 `isCapacityErr`, `engine.ts:168-172`).
pub fn is_capacity_err(err: &Value) -> bool {
    if err.get("codexErrorInfo").and_then(Value::as_str) == Some("serverOverloaded") {
        return true;
    }
    let m = err.get("message").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
    m.contains("at capacity") || m.contains("try a different model")
}

#[cfg(test)]
mod tests {
    use super::*;

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

    fn frames(e: Vec<Egress>) -> Vec<Value> {
        e.into_iter()
            .filter_map(|x| match x {
                Egress::Frame(f) => Some(f),
                _ => None,
            })
            .collect()
    }
    fn rpcs(e: Vec<Egress>) -> Vec<Value> {
        e.into_iter()
            .filter_map(|x| match x {
                Egress::Rpc(f) => Some(f),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn strip_ansi_removes_csi_and_osc() {
        assert_eq!(strip_ansi("\u{1b}[31mred\u{1b}[0m"), "red");
        assert_eq!(strip_ansi("\u{1b}]0;title\u{7}body"), "body");
        assert_eq!(strip_ansi("plain"), "plain");
    }

    #[test]
    fn multi_file_edits_keep_exact_paths_instead_of_only_a_comma_joined_label() {
        let mut t = Transcoder::new(plan());
        let paths = json!(["src/one.rs", "src/with, comma.rs"]);
        let out = frames(t.on_rpc(&json!({"method":"item/started","params":{"item":{
            "id":"edit","type":"fileChange","changes":[{"path":paths[0]},{"path":paths[1]}]
        }}}),0));
        assert_eq!(out[0]["message"]["content"][0]["input"]["file_paths"],paths);
    }

    #[test]
    fn native_tooling_is_paginated_and_does_not_hold_up_the_first_turn() {
        let mut t = Transcoder::new(plan());
        t.on_outgoing(&crate::driver::initialize_request("init-1", None), 0);
        t.on_outgoing(&crate::driver::user_message("hello"), 0);
        t.on_rpc(&json!({"id":1,"result":{}}),1);
        let started = t.on_rpc(&json!({"id":2,"result":{"thread":{"id":"th"}}}),2);
        let requests = rpcs(started.clone());
        assert_eq!(requests[0]["method"],"turn/start","Inventory must not gate the first prompt");
        assert!(frames(started).iter().all(|f| f["kind"] != "tooling"));
        let id = |method: &str| requests.iter().find(|r| r["method"] == method).unwrap()["id"].clone();
        assert!(t.on_rpc(&json!({"id":id("config/read"),"result":{"config":{"mcp_servers":{"off":{"enabled":false}}}}}),3).is_empty());
        assert!(t.on_rpc(&json!({"id":id("skills/list"),"result":{"data":[{"skills":[{"name":"review","path":"/repo/SKILL.md","scope":"repo","enabled":true}]}]}}),4).is_empty());
        let page = t.on_rpc(&json!({"id":id("mcpServerStatus/list"),"result":{"data":[{"name":"one","tools":{"a":{}}}],"nextCursor":"page2"}}),5);
        assert!(frames(page.clone()).is_empty());
        let next = rpcs(page)[0].clone();
        assert_eq!(next["params"]["threadId"],"th");
        let done = frames(t.on_rpc(&json!({"id":next["id"],"result":{"data":[{"name":"two","tools":{},"runtimeStatus":"connected"}],"nextCursor":null}}),6));
        assert_eq!(done[0]["kind"],"tooling");
        assert_eq!(done[0]["tooling"]["mcp"].as_array().unwrap().len(),3);
        assert_eq!(done[0]["tooling"]["skills"][0]["path"],"/repo/SKILL.md");
        let reload = rpcs(t.on_outgoing(&crate::driver::user_message("next"),7))[0].clone();
        assert_eq!(reload["method"],"config/mcpServer/reload");
        let next_turn = rpcs(t.on_rpc(&json!({"id":reload["id"],"result":{}}),8));
        assert_eq!(next_turn[0]["method"],"turn/start");
        assert_eq!(next_turn[0]["params"]["input"][0]["text"],"next");
    }

    #[test]
    fn unsupported_inventory_methods_are_visible_without_failing_the_turn() {
        let mut t = Transcoder::new(plan());
        t.thread_id = Some("th".into());
        let requests = rpcs(t.refresh_tooling());
        let mut output = vec![];
        for request in requests {
            output.extend(t.on_rpc(&json!({"id":request["id"],"error":{"message":"Unsupported method"}}),0));
        }
        let f = frames(output);
        assert_eq!(f.len(),1);
        assert_eq!(f[0]["kind"],"tooling");
        assert_eq!(f[0]["tooling"]["errors"].as_array().unwrap().len(),3);
    }

    #[test]
    fn cancelling_during_config_reload_cannot_send_the_queued_prompt_later() {
        let mut t = Transcoder::new(plan());
        t.initialized = true;
        t.thread_id = Some("th".into());
        let req = rpcs(t.on_outgoing(&crate::driver::user_message("cancel me"),0))[0].clone();
        let cancelled = frames(t.on_outgoing(&json!({"type":"control_request","request":{"subtype":"interrupt"}}),1));
        assert_eq!(cancelled[0]["terminal_reason"],"aborted_by_user");
        assert!(t.on_rpc(&json!({"id":req["id"],"result":{}}),2).is_empty());
    }

    #[test]
    fn a_startup_change_during_inventory_loading_is_refreshed_after_the_current_batch() {
        let mut t = Transcoder::new(plan());
        t.thread_id = Some("th".into());
        let requests = rpcs(t.refresh_tooling());
        assert!(t.on_rpc(&json!({"method":"mcpServer/startupStatus/updated","params":{"threadId":"th"}}),0).is_empty());
        let mut output = vec![];
        for request in requests {
            output.extend(t.on_rpc(&json!({"id":request["id"],"result":{"data":[]}}),1));
        }
        assert_eq!(rpcs(output).len(),3,"The startup notification must not be lost while a list is in flight");
    }

    #[test]
    fn a_prompt_before_initialize_waits_for_the_handshake() {
        let mut t = Transcoder::new(plan());
        // T1은 initialize와 user 프레임을 **연달아** 보낸다 — 프롬프트가 먼저 나가면 안 된다.
        let a = t.on_outgoing(&crate::driver::initialize_request("init-1", None), 0);
        assert_eq!(rpcs(a)[0]["method"], "initialize");
        let b = t.on_outgoing(&crate::driver::user_message("안녕"), 0);
        assert!(rpcs(b).is_empty(), "핸드셰이크 전에는 아무것도 안 나간다");
        let c = t.on_rpc(&json!({ "id": 1, "result": {} }), 10);
        let (f, r) = (frames(c.clone()), rpcs(c));
        assert_eq!(f[0]["response"]["request_id"], "init-1");
        assert_eq!(r[0]["method"], "initialized");
        assert_eq!(r[1]["method"], "thread/start");
        let d = t.on_rpc(&json!({ "id": 2, "result": { "thread": { "id": "th-1" } } }), 20);
        let (f, r) = (frames(d.clone()), rpcs(d));
        assert_eq!(f[0]["subtype"], "init");
        assert_eq!(f[0]["session_id"], "th-1", "threadId가 곧 session_id(resume 키)다");
        assert_eq!(r[0]["method"], "turn/start");
        assert_eq!(r[0]["params"]["input"][0]["text"], "안녕");
    }

    /// ★2026-09-05 — 속도 티어는 `thread/start`와 `turn/start` **둘 다**에 `serviceTier`로 실리고,
    /// 표준(`None`)이면 키 자체가 없다(서버 기본을 건드리지 않는다).
    #[test]
    fn the_speed_tier_rides_on_thread_start_and_turn_start_and_standard_sends_nothing() {
        let run = |tier: Option<&str>| {
            let mut p = plan();
            p.service_tier = tier.map(str::to_string);
            let mut t = Transcoder::new(p);
            let _ = t.on_outgoing(&crate::driver::initialize_request("init-1", None), 0);
            let _ = t.on_outgoing(&crate::driver::user_message("안녕"), 0);
            let c = t.on_rpc(&json!({ "id": 1, "result": {} }), 10);
            let thread = rpcs(c).into_iter().find(|r| r["method"] == "thread/start").unwrap();
            let d = t.on_rpc(&json!({ "id": 2, "result": { "thread": { "id": "th-1" } } }), 20);
            let turn = rpcs(d)[0].clone();
            assert_eq!(thread["method"], "thread/start");
            assert_eq!(turn["method"], "turn/start");
            (thread["params"].clone(), turn["params"].clone())
        };
        let (th, tu) = run(Some("priority"));
        assert_eq!(th["serviceTier"], "priority", "thread/start에 티어가 없다: {th}");
        assert_eq!(tu["serviceTier"], "priority", "turn/start에 티어가 없다: {tu}");
        let (th, tu) = run(None);
        assert!(th.get("serviceTier").is_none(), "표준인데 thread/start에 키가 있다: {th}");
        assert!(tu.get("serviceTier").is_none(), "표준인데 turn/start에 키가 있다: {tu}");
    }

    #[test]
    fn question_answers_map_back_to_question_ids() {
        let mut t = Transcoder::new(plan());
        let card = t.on_rpc(
            &json!({ "id": 7, "method": "item/tool/requestUserInput", "params": { "questions": [
                { "id": "q1", "question": "어느 쪽?", "header": "선택",
                  "options": [{ "label": "A" }, { "label": "B" }] }]}}),
            0,
        );
        let f = frames(card);
        assert_eq!(f[0]["request"]["tool_name"], "AskUserQuestion");
        let rid = f[0]["request_id"].as_str().unwrap().to_string();
        let answer = crate::driver::control_response(
            &rid,
            None,
            json!({ "behavior": "deny", "message": "…", "ccgAnswers": [["A"]] }),
        );
        let r = rpcs(t.on_outgoing(&answer, 0));
        assert_eq!(r[0]["id"], 7);
        assert_eq!(r[0]["result"]["answers"]["q1"]["answers"][0], "A");
    }

    #[test]
    fn a_dismissed_question_fails_only_the_tool_call() {
        let mut t = Transcoder::new(plan());
        let f = frames(t.on_rpc(
            &json!({ "id": 9, "method": "item/tool/requestUserInput", "params": { "questions": [
                { "id": "q1", "question": "?", "options": [] }]}}),
            0,
        ));
        let rid = f[0]["request_id"].as_str().unwrap().to_string();
        let r = rpcs(t.on_outgoing(
            &crate::driver::control_response(&rid, None, json!({ "behavior": "deny" })),
            0,
        ));
        assert!(r[0]["error"]["message"].as_str().unwrap().contains("dismissed"));
    }

    #[test]
    fn approvals_use_two_different_decision_vocabularies() {
        let mut t = Transcoder::new(plan());
        let modern = frames(t.on_rpc(
            &json!({ "id": 1, "method": "item/commandExecution/requestApproval",
                     "params": { "command": "cargo test" } }),
            0,
        ));
        let rid = modern[0]["request_id"].as_str().unwrap().to_string();
        assert_eq!(modern[0]["request"]["input"]["command"], "cargo test");
        let r = rpcs(t.on_outgoing(
            &crate::driver::control_response(&rid, None, json!({ "behavior": "allow", "ccgAlways": true })),
            0,
        ));
        assert_eq!(r[0]["result"]["decision"], "acceptForSession");

        let legacy = frames(t.on_rpc(
            &json!({ "id": 2, "method": "execCommandApproval", "params": { "command": ["ls", "-la"] } }),
            0,
        ));
        let rid = legacy[0]["request_id"].as_str().unwrap().to_string();
        assert_eq!(legacy[0]["request"]["input"]["command"], "ls -la");
        let r = rpcs(t.on_outgoing(
            &crate::driver::control_response(&rid, None, json!({ "behavior": "deny" })),
            0,
        ));
        assert_eq!(r[0]["result"]["decision"], "denied");
    }

    #[test]
    fn an_interrupted_turn_carries_the_aborted_marker() {
        let mut t = Transcoder::new(plan());
        // 턴을 먼저 **채택**해 둔다 — id 달린 `turn/completed`는 채택된 턴의 것만 정착시킨다
        // (시작 창의 잔재를 걸러 내는 게이트 ②·③ · `engine.ts:596-598`).
        t.on_notification(
            &json!({ "method": "turn/started", "params": { "turn": { "id": "t1" } } }),
            0,
        );
        let f = frames(t.on_notification(
            &json!({ "method": "turn/completed", "params": { "turn": { "id": "t1", "status": "interrupted" } } }),
            500,
        ));
        assert_eq!(f[0]["type"], "result");
        assert_eq!(f[0]["terminal_reason"], "aborted_by_user");
        assert_eq!(f[0]["is_error"], false);
    }

    #[test]
    fn token_deltas_are_per_turn_not_thread_totals() {
        let mut t = Transcoder::new(plan());
        // 재개된 스레드가 과거 누계를 실어 온다 — 첫 통지에서 base = total − last.
        t.on_notification(
            &json!({ "method": "thread/tokenUsage/updated", "params": { "tokenUsage": {
                "last": { "inputTokens": 100, "outputTokens": 20, "totalTokens": 120 },
                "total": { "inputTokens": 900, "cachedInputTokens": 300, "outputTokens": 120 },
                "modelContextWindow": 272000 }}}),
            0,
        );
        let f = frames(t.on_notification(
            &json!({ "method": "turn/completed", "params": { "turn": { "status": "completed" } } }),
            0,
        ));
        let mu = &f[0]["modelUsage"]["gpt-5.6-terra"];
        assert_eq!(mu["inputTokens"], 100, "이번 턴 = 900 − (900−100)");
        assert_eq!(mu["outputTokens"], 20);
        assert_eq!(mu["contextWindow"], 272000);
        assert_eq!(f[0]["usage"]["input_tokens"], 120, "게이지 자리");
    }

    #[test]
    fn background_terminals_close_the_tool_row_and_become_a_shell_chip() {
        let mut t = Transcoder::new(plan());
        t.thread_id = Some("th".into());
        t.turn_id = Some("tu".into());
        t.items.insert("i1".into(), Item { name: "Bash".into(), out: "부분출력".into() });
        // 짝 없는 응답(우리가 안 보낸 id)은 조용히 무시한다.
        assert!(t
            .on_rpc(&json!({ "id": 99, "result": { "data": [] } }), 0)
            .is_empty());

        let poll = t.tick(BG_POLL + 1);
        assert_eq!(rpcs(poll)[0]["method"], "thread/backgroundTerminals/list");
        let e = t.on_rpc(
            &json!({ "id": 1, "result": { "data": [{ "itemId": "i1", "processId": "p9", "command": "npm run dev" }] } }),
            0,
        );
        let tails: Vec<_> = e
            .iter()
            .filter_map(|x| match x {
                Egress::Tail { file, text } => Some((file.clone(), text.clone())),
                _ => None,
            })
            .collect();
        assert_eq!(tails[0].1, "부분출력", "전환 전 출력이 테일 파일의 머리가 된다");
        let f = frames(e);
        assert_eq!(f[0]["message"]["content"][0]["content"], "백그라운드로 전환");
        assert_eq!(f[1]["subtype"], "background_tasks_changed");
        assert_eq!(f[1]["tasks"][0]["task_id"], "p9");
        assert!(f[1]["tasks"][0]["task_type"].as_str().unwrap().contains("shell"));
    }

    #[test]
    fn unknown_server_requests_are_refused_not_ignored() {
        let mut t = Transcoder::new(plan());
        let r = rpcs(t.on_rpc(&json!({ "id": 4, "method": "chatgptAuthTokens/refresh" }), 0));
        assert_eq!(r[0]["id"], 4);
        assert!(r[0]["error"]["message"].as_str().unwrap().contains("unsupported"));
    }
}
