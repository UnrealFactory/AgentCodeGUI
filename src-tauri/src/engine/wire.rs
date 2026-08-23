//! 와이어 번역 — **원시 CLI 프레임 → 2.6.2 `EngineEvent`**(`src/shared/protocol.ts:391`).
//!
//! 왜 여기 있나: 상태기계(`ccg-engine`)가 내는 `Event`는 *상태·원장·판정*이고, 렌더러가
//! 그리는 것은 *내용*(스트리밍 텍스트·도구 인자·질문 선택지)이다. 두 축은 겹치지 않는다.
//! 얼려 둔 2.6.2 렌더러는 `engine:event` 하나로 그 내용을 받으므로, 셸이 프레임을 그
//! 모양으로 번역한다. (`docs/design/ux-chat-unify.md` §6.2 — "이벤트는 역방향:
//! `chat:event`를 옛 렌더러가 구독한 `engine:event`로도 함께 내보낸다".)
//!
//! **범위(★R3)**: 계약면의 `EngineEvent` **23종 전부**를 옮긴다. R2까지는 세로 조각
//! (부팅→메시지→스트리밍→승인→완료)에 필요한 14종뿐이었고 나머지 아홉 칸은 화면이
//! 비어 있었다 — 할 일 · 변경 파일 · 터미널 · 서브에이전트 · 백그라운드 셸 · 워크플로 ·
//! 생각 줄 정리 · 오류. 안 옮긴 **필드**는 파일 끝 「미배선」에 이름으로 남긴다 —
//! 조용히 빠뜨리지 않는 것이 규약이다. 미지 프레임은 **아무 이벤트도 내지 않는다**
//! (렌더러는 못 본 것과 같다). 절대 패닉하지 않는다.
//!
//! **원본**: 2.6.2 `src/main/claude/engine.ts`. 의도적으로 다르게 한 두 곳은 주석에
//! 이유를 적었다(워크플로 정착 방출 순서 · 깨진 스트림의 `error` vs `notice`).

use super::diff::{self, Baselines, PendingChange};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};

/// 도구 한 행 — `tool-end`의 `durationMs`와 **보류된 파일 변경**을 들고 있다.
struct ToolRow {
    verb: String,
    name: String,
    started_ms: u64,
    /// `Write`/`Edit`/`MultiEdit`가 **성공하면** 그때 `file-change`로 나갈 값.
    pending: Option<PendingChange>,
}

/// 할 일 한 줄(`TaskCreate`/`TaskUpdate` 누적본). 삽입 순서가 표시 순서라 `Vec`다.
struct TodoRow {
    id: String,
    label: String,
    status: &'static str,
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

    // ── R3에서 채운 자리 ────────────────────────────────────────────────────
    /// `system/init`의 `cwd` — 상대 경로 표시와 백그라운드 출력 파일 유도에 쓴다.
    cwd: String,
    session_id: String,
    /// 이 런의 파일 기준선(누적 diff의 좌변).
    baselines: Baselines,
    /// 생각 줄이 열려 있나 — 답변 텍스트가 오면 `thinking-clear`로 닫는다.
    thinking_open: bool,
    /// 이 assistant 메시지에서 델타가 흘렀나(완성 프레임의 중복 생각 줄 방지).
    streamed_this_msg: bool,
    /// 살아 있는(스폰을 목격한) 서브에이전트 `tool_use_id`.
    subagents: BTreeSet<String>,
    /// 서브에이전트가 보고한 실행 모델 표시명 — **값이 바뀔 때만** 부분 업데이트.
    subagent_models: BTreeMap<String, String>,
    /// `TodoWrite`가 아니라 `TaskCreate`/`TaskUpdate` 계열이 채우는 누적 할 일.
    todos: Vec<TodoRow>,
    task_seq: u64,
    /// 살아 있는 백그라운드 **셸**(`bg-tasks` 목록에 실리는 것) · 에이전트 · 워크플로.
    live_bg: BTreeSet<String>,
    live_bg_agents: BTreeSet<String>,
    live_workflows: BTreeSet<String>,
    /// 한 번이라도 워크플로였던 task_id — 정착 통지는 목록에서 빠진 **뒤에** 온다.
    wf_ids: BTreeSet<String>,
    wf_snaps: BTreeMap<String, Value>,
    /// `task_started`의 `tool_use_id → task_id`(백그라운드 접수증 판별).
    task_by_tool_use: BTreeMap<String, String>,
    /// 사용자가 중지 버튼으로 끊은 작업 — 정착 통지의 표기를 가른다(`byUser`).
    user_bg_stops: BTreeSet<String>,
    /// `result`를 본 뒤인가 — 이후의 `stopped`는 사용자 중지가 아니라 CLI 정리다.
    turn_ended: bool,
    /// `system/init`이 보고한 실행 모델(원시 id). `modelUsage`가 없는 판에서
    /// `result.tokenUsage`의 모델 이름 폴백이다(2.6.2 `curModelDisplay || req.model`).
    cur_model: String,
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

/// 공백을 접고 `max`자에서 자른다(2.6.2 `oneLine`).
fn one_line(v: &str, max: usize) -> String {
    let t = v.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.chars().count() > max {
        t.chars().take(max.saturating_sub(1)).collect::<String>() + "…"
    } else {
        t
    }
}

/// **실제 컨텍스트 창 크기**(`result.contextWindow`) — 모델별 usage의 최대값.
///
/// 서브에이전트가 작은 창의 모델로 돌면 항목이 여러 개다. 메인 대화는 가장 큰 창에서
/// 도므로 max를 쓴다(2.6.2 `windowFromModelUsage` — `engine.ts:98-106`). 없으면 `null`
/// 이고 렌더러가 모델 기본 창으로 폴백한다.
fn context_window(mu: Option<&Value>) -> Value {
    let Some(Value::Object(m)) = mu else { return Value::Null };
    let max = m
        .values()
        .filter_map(|e| e.get("contextWindow").and_then(Value::as_u64))
        .max()
        .unwrap_or(0);
    if max > 0 {
        json!(max)
    } else {
        Value::Null
    }
}

/// **실행 1건의 모델별 실측 토큰**(`result.tokenUsage`) — 2.6.2 `tokenUseFromResult`
/// (`engine.ts:112-144`) 이식.
///
/// 표시명이 같아지는 id(`[1m]` 컨텍스트 변형)는 하나로 합치고, 전부 0인 항목은 안 낸다.
/// `modelUsage`가 없거나 전부 0인 옛 CLI 판은 합산 `usage`를 현재 모델 하나로 폴백한다.
fn token_usage(mu: Option<&Value>, usage: &Value, fallback_model: &str) -> Value {
    fn push(out: &mut Vec<(String, [u64; 4])>, model: String, t: [u64; 4]) {
        if t.iter().sum::<u64>() == 0 {
            return;
        }
        match out.iter_mut().find(|(m, _)| *m == model) {
            Some((_, acc)) => {
                for i in 0..4 {
                    acc[i] += t[i];
                }
            }
            None => out.push((model, t)),
        }
    }
    let mut out: Vec<(String, [u64; 4])> = vec![];
    if let Some(Value::Object(m)) = mu {
        for (id, u) in m {
            let g = |k: &str| u.get(k).and_then(Value::as_u64).unwrap_or(0);
            push(
                &mut out,
                model_display(id),
                [
                    g("inputTokens"),
                    g("outputTokens"),
                    g("cacheReadInputTokens"),
                    g("cacheCreationInputTokens"),
                ],
            );
        }
    }
    if out.is_empty() {
        let g = |k: &str| usage.get(k).and_then(Value::as_u64).unwrap_or(0);
        let name = match model_display(fallback_model) {
            // `system/init`을 못 본 판(합성 result 등) — 2.6.2와 같은 자리표시자.
            s if s.is_empty() => "다른 모델".to_string(),
            s => s,
        };
        push(
            &mut out,
            name,
            [
                g("input_tokens"),
                g("output_tokens"),
                g("cache_read_input_tokens"),
                g("cache_creation_input_tokens"),
            ],
        );
    }
    Value::Array(
        out.into_iter()
            .map(|(model, t)| {
                json!({ "model": model, "inTok": t[0], "outTok": t[1], "cacheRead": t[2], "cacheWrite": t[3] })
            })
            .collect(),
    )
}

/// **웹 행의 링크**(`tool-end.links`) — 2.6.2 `extractWebLinks`(`engine.ts:2429-2457`) 이식.
///
/// `WebSearch`의 결과 본문에는 `Links: [{"title":…,"url":…}, …]` 블록이 온다. 잘리거나
/// 변형된 블록은 `"url": "https://…"` 폴백이 줍는다. 최대 20개 · 중복 url 제거.
fn extract_web_links(text: &str) -> Vec<Value> {
    fn push(out: &mut Vec<Value>, seen: &mut BTreeSet<String>, title: &str, url: &str) {
        if out.len() >= 20 || !(url.starts_with("http://") || url.starts_with("https://")) {
            return;
        }
        if !seen.insert(url.to_string()) {
            return;
        }
        let t = title.trim();
        out.push(json!({ "title": if t.is_empty() { url } else { t }, "url": url }));
    }
    let mut out: Vec<Value> = vec![];
    let mut seen: BTreeSet<String> = BTreeSet::new();
    // `Links:` 뒤의 JSON 배열 — 한 줄 안에서만 찾는다(2.6.2의 `[^\n]*`와 같은 범위).
    for line in text.lines() {
        let Some(at) = line.find("Links:") else { continue };
        let rest = line[at + "Links:".len()..].trim_start();
        if !rest.starts_with('[') {
            continue;
        }
        let end = match rest.rfind(']') {
            Some(e) => e + 1,
            None => continue,
        };
        if let Ok(Value::Array(arr)) = serde_json::from_str::<Value>(&rest[..end]) {
            for it in arr {
                let url = it.get("url").and_then(Value::as_str).unwrap_or("");
                let title = it.get("title").and_then(Value::as_str).unwrap_or("");
                push(&mut out, &mut seen, title, url);
            }
        }
    }
    if out.is_empty() {
        // 폴백 — 본문 어디든 `"url": "https://…"`.
        let mut rest = text;
        while let Some(i) = rest.find("\"url\"") {
            rest = &rest[i + 5..];
            let Some(c) = rest.find(':') else { break };
            let after = rest[c + 1..].trim_start();
            if !after.starts_with('"') {
                continue;
            }
            let body = &after[1..];
            let Some(q) = body.find('"') else { break };
            push(&mut out, &mut seen, "", &body[..q]);
        }
    }
    out
}

/// 모델 원시 id → 표시명(`claude-opus-5-1` → `Opus 5.1`). 워크플로 에이전트 칩과
/// 서브에이전트 카드가 같은 문자열을 쓴다.
/// ★R4 — 2.6.2의 정규식(`/claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?\b/i`,
/// `engine.ts:2238`)과 **같은 판정**으로 고쳤다. R3 판은 `'-'`로 통째로 쪼개서
/// `claude-opus-5-1[1m]`의 부번호를 `"1[1m]"`으로 읽고 `Opus 5`로 떨어뜨렸다 —
/// `[1m]` 컨텍스트 변형이 **다른 모델로 보여** `result.tokenUsage`가 두 줄로 갈리고
/// 모델 전환 감지도 오탐한다(메모리 「사이드체인 모델 프레임」의 핑퐁과 같은 얼굴).
fn model_display(id: &str) -> String {
    let lower = id.to_ascii_lowercase();
    let Some(at) = lower.find("claude-") else {
        return id.to_string();
    };
    let rest = &lower[at + "claude-".len()..];
    let Some(fam) = ["fable", "opus", "sonnet", "haiku"].into_iter().find(|f| rest.starts_with(f)) else {
        return id.to_string();
    };
    let Some(after) = rest[fam.len()..].strip_prefix('-') else {
        return id.to_string();
    };
    let major: String = after.chars().take_while(char::is_ascii_digit).collect();
    if major.is_empty() {
        return id.to_string();
    }
    // 선택적 `-<1~2자리>` + **낱말 경계**(정규식의 `\b`).
    let minor = after[major.len()..].strip_prefix('-').and_then(|t| {
        let d: String = t.chars().take(2).take_while(char::is_ascii_digit).collect();
        if d.is_empty() {
            return None;
        }
        match t[d.len()..].chars().next() {
            None => Some(d),
            Some(c) if !c.is_ascii_alphanumeric() && c != '_' => Some(d),
            _ => None,
        }
    });
    let mut fam_disp = fam.to_string();
    fam_disp[..1].make_ascii_uppercase();
    match minor {
        Some(m) => format!("{fam_disp} {major}.{m}"),
        None => format!("{fam_disp} {major}"),
    }
}

/// SDK 원시 상태값 → `TodoStatus`.
fn todo_status(v: &str) -> &'static str {
    match v {
        "completed" | "done" => "done",
        "in_progress" | "running" => "running",
        _ => "pending",
    }
}

/// 서브에이전트 결과에서 SDK가 붙이는 `agentId: …` 꼬리를 떼어 낸다(재개용 배관이지 답이 아니다).
fn agent_result(text: &str) -> String {
    let lower = text.to_ascii_lowercase();
    match lower.find("agentid:") {
        Some(i) => text[..i].trim_end().to_string(),
        None => text.trim().to_string(),
    }
}

/// 백그라운드 작업의 **라이브 출력 파일 후보**(CLI 실측 규칙).
/// `%TEMP%\claude\<cwd의 영숫자 외→'-'>\<session>\tasks\<task_id>.output`.
/// 종료 통지가 실제 경로를 실어 오면 렌더러가 그것으로 덮는다.
fn bg_output_file(cwd: &str, session: &str, task_id: &str) -> Option<String> {
    if session.is_empty() {
        return None;
    }
    let slug: String = cwd
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    Some(
        std::env::temp_dir()
            .join("claude")
            .join(slug)
            .join(session)
            .join("tasks")
            .join(format!("{task_id}.output"))
            .to_string_lossy()
            .to_string(),
    )
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

/// 패널을 먹이는 도구 — 도구 행(로그)을 만들지 않는다.
const TASK_TOOLS: [&str; 5] = ["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "Task"];

/// 도구 인자가 스트리밍되는 동안(도구 행이 아직 없는 구간) 표시할 라벨.
fn tool_gen_label(name: &str) -> &'static str {
    match tool_label(name).1 {
        "read" => "파일 읽는 중",
        "search" => "검색하는 중",
        "write" => "파일 작성 중",
        "edit" => "파일 수정 중",
        "bash" => "명령 실행 중",
        "task" => "서브에이전트 실행 중",
        "web" => "웹 검색 중",
        _ => "도구 실행 중",
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
        self.thinking_open = false;
        self.streamed_this_msg = false;
        self.turn_ended = false;
        // 파일 기준선은 **런 단위**다 — 새 턴은 지금 디스크를 다시 기준으로 잡는다.
        self.baselines.clear();
        json!({ "type": "status", "runId": run_id, "status": "analyzing" })
    }

    /// 사용자가 중지 버튼으로 끊은 백그라운드 작업 — 정착 통지의 `byUser` 표식.
    pub fn note_user_bg_stop(&mut self, id: &str) {
        self.user_bg_stops.insert(id.to_string());
    }

    /// `modelUsage`가 없는 판의 폴백 모델 표시명(2.6.2 `curModelDisplay || req.model`).
    fn model_display_now(&self) -> String {
        self.cur_model.clone()
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
        // ★ **고아 알약 금지** — 스트림이 닫히면 CLI 프로세스도 죽으므로 워크플로·백그라운드
        //   셸·서브에이전트는 **전부** 죽는다. 통지가 못 온 것들을 여기서 손수 정착시키지
        //   않으면 알약이 도는 채로 화면에 남는다(m-logic P8의 백그라운드 판). 2.6.2도
        //   런 루프 teardown에서 같은 셋을 냈다(`engine.ts:1826-1860`).
        let mut out = self.settle_all_background(true);
        // ★ `spawn_failed`·`crash`는 "끝난 것"이 아니라 "깨진 것"이다 — 2.6.2는 그 경로에서
        //   안내(notice)가 아니라 **오류 말풍선**(`error`)을 냈다(`engine.ts:1796`). 같게 간다.
        //   나머지 사유(외부 kill·정상 종료·유휴 회수·하드 취소)는 안내 한 줄 그대로다.
        let broke = matches!(cause, "spawn_failed" | "crash");
        out.push(if broke {
            json!({ "type": "error", "runId": run, "message": format!("{why}{tail}.") })
        } else {
            json!({ "type": "notice", "runId": run,
                    "text": format!("{why}{tail}. 다시 보내면 새 프로세스로 이어집니다.") })
        });
        if !self.saw_result {
            // ★ 결과 없는 종료. `isError:true`로 두는 이유: 이 턴은 **끝난 게 아니라
            //   끊긴 것**이고, 렌더러의 명령 카드 정착 경로도 `isError`를 본다.
            self.saw_result = true;
            self.cur_msg = None;
            out.push(json!({
                "type": "result", "runId": run,
                "isError": true,
                // 깨진 경로는 위의 `error`가 이미 빨간 말풍선을 세웠다 — 여기서 텍스트를
                // 또 실으면 같은 사유가 두 벌 뜬다(`session.ts:1000` `rerr…`). 합성 result
                // 자체는 여전히 필요하다: 카드 해제·스피너 정착·컴포저 해제가 여기 달려 있다.
                "text": if broke { String::new() } else { format!("{why} — 이 턴은 완료되지 않았습니다.") },
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
        self.baselines.clear();
        out
    }

    /// **살아 있는 백그라운드 표시를 전부 정착시킨다.**
    ///
    /// 스트림이 닫히면(정상 종료·취소·급사 어느 쪽이든) CLI 프로세스와 함께 그 안에서
    /// 돌던 워크플로 · 백그라운드 셸 · 서브에이전트가 **전부** 죽는다. 통지를 못 받은
    /// 것들이 남으면 화면에는 영원히 도는 알약이 뜬다 — 그게 이 함수가 막는 것이다.
    ///
    /// `at_turn_end`는 표시 문구를 가른다(사용자가 중지한 것이 아니라 CLI 정리다).
    fn settle_all_background(&mut self, at_turn_end: bool) -> Vec<Value> {
        let run = self.run_id.clone();
        let mut out = vec![];
        for (id, snap) in std::mem::take(&mut self.wf_snaps) {
            if snap.get("status").and_then(Value::as_str) == Some("running") {
                let mut wf = snap;
                if let Some(o) = wf.as_object_mut() {
                    o.insert("status".into(), json!("stopped"));
                }
                out.push(json!({ "type": "workflow", "runId": run, "wf": wf }));
            }
            self.wf_ids.remove(&id);
        }
        for id in std::mem::take(&mut self.live_bg) {
            out.push(json!({
                "type": "bg-task-end", "runId": run, "id": id,
                "status": "stopped", "atTurnEnd": at_turn_end
            }));
        }
        if !out.is_empty() || !self.live_bg_agents.is_empty() {
            out.push(json!({ "type": "bg-tasks", "runId": run, "tasks": [] }));
        }
        for id in std::mem::take(&mut self.subagents) {
            let dur = self.tools.get(&id).map(|r| now_ms().saturating_sub(r.started_ms));
            out.push(json!({
                "type": "subagent", "runId": run,
                "agent": { "id": id, "name": "", "role": "", "status": "done",
                           "activity": "턴 종료로 정리됨", "tools": [], "durationMs": dur }
            }));
        }
        self.live_workflows.clear();
        self.live_bg_agents.clear();
        self.subagent_models.clear();
        self.task_by_tool_use.clear();
        self.user_bg_stops.clear();
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

    /// `tool_use` 블록 1개 → 이벤트들. **패널을 먹이는 도구는 도구 행을 만들지 않는다**
    /// (2.6.2 `handleToolUse` 규약): `Task`/`Agent` → 서브에이전트 카드,
    /// `TodoWrite`/`Task*` → 할 일 패널, 나머지 → 도구 행(+ Bash면 터미널 줄,
    /// Write/Edit면 **보류된** 파일 변경).
    fn tool_start(&mut self, b: &Value, parent: Option<&str>) -> Vec<Value> {
        let run = self.run_id.clone();
        let mut out = vec![];
        let id = s(b, "id").unwrap_or_default();
        let name = s(b, "name").unwrap_or_default();
        let input = b.get("input").cloned().unwrap_or(json!({}));
        if id.is_empty() || name.is_empty() {
            return out;
        }
        // 질문 카드는 도구 행이 아니다(`control_request`가 카드로 그린다).
        if name == "AskUserQuestion" {
            return out;
        }

        // ── 서브에이전트 스폰 ────────────────────────────────────────────────
        if name == "Task" || name == "Agent" {
            let sub_type = input
                .get("subagent_type")
                .and_then(Value::as_str)
                .or_else(|| input.get("description").and_then(Value::as_str))
                .unwrap_or("agent")
                .to_string();
            let desc = input
                .get("description")
                .and_then(Value::as_str)
                .or_else(|| input.get("prompt").and_then(Value::as_str))
                .unwrap_or("")
                .to_string();
            self.tools.insert(
                id.clone(),
                ToolRow { verb: "Task".into(), name: name.clone(), started_ms: now_ms(), pending: None },
            );
            self.subagents.insert(id.clone());
            let role = one_line(&desc, 40);
            let act = one_line(&desc, 200);
            out.push(json!({
                "type": "subagent", "runId": run,
                "agent": {
                    "id": id, "name": sub_type,
                    "role": if role.is_empty() { "서브에이전트".to_string() } else { role },
                    "status": "running",
                    "activity": if act.is_empty() { "작업 중".to_string() } else { act },
                    "tools": []
                }
            }));
            return out;
        }

        // ── 할 일 패널 ──────────────────────────────────────────────────────
        if name == "TodoWrite" {
            let rows: Vec<Value> = input
                .get("todos")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .enumerate()
                        .map(|(i, t)| {
                            json!({
                                "id": (i + 1).to_string(),
                                "label": t.get("content").and_then(Value::as_str)
                                    .or_else(|| t.get("activeForm").and_then(Value::as_str)).unwrap_or(""),
                                "status": todo_status(t.get("status").and_then(Value::as_str).unwrap_or("pending")),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            out.push(json!({ "type": "todos", "runId": run, "todos": rows }));
            return out;
        }
        if matches!(name.as_str(), "TaskCreate" | "TaskUpdate" | "TaskList") {
            // id는 우리가 생성 순서로 발급한다 — 입력에는 없고, SDK의 세션 내 번호와 같은 규칙이다.
            if name == "TaskCreate" {
                let subject = input
                    .get("subject")
                    .and_then(Value::as_str)
                    .or_else(|| input.get("description").and_then(Value::as_str))
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if !subject.is_empty() {
                    self.task_seq += 1;
                    self.todos.push(TodoRow {
                        id: self.task_seq.to_string(),
                        label: subject,
                        status: "pending",
                    });
                }
            } else if name == "TaskUpdate" {
                let tid = input.get("taskId").and_then(Value::as_str).unwrap_or("").to_string();
                let st = input.get("status").and_then(Value::as_str).unwrap_or("");
                if st == "deleted" {
                    self.todos.retain(|t| t.id != tid);
                } else if let Some(row) = self.todos.iter_mut().find(|t| t.id == tid) {
                    if !st.is_empty() {
                        row.status = todo_status(st);
                    }
                    if let Some(sj) = input.get("subject").and_then(Value::as_str) {
                        row.label = sj.to_string();
                    }
                }
            }
            let rows: Vec<Value> = self
                .todos
                .iter()
                .map(|t| json!({ "id": t.id, "label": t.label, "status": t.status }))
                .collect();
            out.push(json!({ "type": "todos", "runId": run, "todos": rows }));
            return out;
        }

        // ── 보통 도구 행 ────────────────────────────────────────────────────
        let (verb, kind) = tool_label(&name);
        let target = tool_target(&input);
        let mut row = ToolRow { verb: verb.clone(), name: name.clone(), started_ms: now_ms(), pending: None };
        let mut tool = Map::new();
        tool.insert("id".into(), json!(id));
        tool.insert("verb".into(), json!(verb));
        tool.insert("kind".into(), json!(kind));
        tool.insert("target".into(), json!(target));
        tool.insert("status".into(), json!("running"));
        if let Some(p) = parent.filter(|p| !p.is_empty()) {
            tool.insert("parentToolId".into(), json!(p));
        }
        out.push(json!({ "type": "tool-start", "runId": run, "tool": Value::Object(tool) }));

        if name == "Bash" {
            // 명령은 **즉시** 보여 준다. 출력은 tool_result가 온 뒤다.
            let cmd = input.get("command").and_then(Value::as_str).unwrap_or("");
            if !cmd.is_empty() {
                out.push(json!({ "type": "terminal", "runId": run,
                                 "line": { "type": "cmd", "text": cmd } }));
            }
        } else if matches!(name.as_str(), "Write" | "Edit" | "MultiEdit") {
            // 디프는 **성공한 뒤에** 낸다 — 거부·실패한 편집이 유령 diff를 남기지 않게.
            row.pending = diff::build_pending(&mut self.baselines, &name, &input, &self.cwd);
        }
        self.tools.insert(id, row);
        out
    }

    /// `tool_result` 블록 1개 → 이벤트들(서브에이전트 완료 · 파일 변경 · 터미널 · 도구 행 종료).
    fn tool_end(&mut self, b: &Value) -> Vec<Value> {
        let run = self.run_id.clone();
        let mut out = vec![];
        let id = s(b, "tool_use_id").unwrap_or_default();
        let is_err = b.get("is_error").and_then(Value::as_bool).unwrap_or(false);
        let content = match &b["content"] {
            Value::String(t) => t.clone(),
            Value::Array(a) => a
                .iter()
                .filter_map(|x| x.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n"),
            _ => String::new(),
        };

        // ── 서브에이전트 종료 ────────────────────────────────────────────────
        if self.subagents.contains(&id) {
            // 백그라운드로 돌린 서브에이전트의 tool_result는 "백그라운드로 시작됨"
            // **접수증**이다 — 완료가 아니다. 판정: 그 작업이 아직 살아 있으면 접수증.
            let low = content.to_ascii_lowercase();
            let receipt = !is_err
                && (self.task_by_tool_use.contains_key(&id)
                    || low.contains("running in background")
                    || low.contains("backgrounded")
                    || low.contains("async agent launched"));
            if receipt {
                out.push(json!({
                    "type": "subagent", "runId": run,
                    "agent": { "id": id, "name": "", "role": "", "status": "running",
                               "activity": "백그라운드에서 진행 중", "tools": [] }
                }));
                return out;
            }
            self.subagents.remove(&id);
            let dur = self.tools.get(&id).map(|r| now_ms().saturating_sub(r.started_ms));
            let act = agent_result(&content);
            out.push(json!({
                "type": "subagent", "runId": run,
                "agent": { "id": id, "name": "", "role": "", "status": "done",
                           "activity": if act.is_empty() { "완료".to_string() } else { act },
                           "tools": [], "durationMs": dur }
            }));
            return out;
        }

        let row = self.tools.remove(&id);
        let dur = row.as_ref().map(|r| now_ms().saturating_sub(r.started_ms));

        // ── 파일 변경 — 편집이 **실제로 성공한 뒤**에만 ───────────────────────
        if let Some(p) = row.as_ref().and_then(|r| r.pending.as_ref()) {
            if !is_err {
                out.push(json!({
                    "type": "file-change", "runId": run,
                    "file": p.file, "diff": p.diff, "whole": p.whole
                }));
            }
        }

        // ── 터미널 줄 ────────────────────────────────────────────────────────
        if row.as_ref().is_some_and(|r| r.name == "Bash") {
            for ln in content.lines().take(200) {
                if !ln.trim().is_empty() {
                    out.push(json!({ "type": "terminal", "runId": run,
                                     "line": { "type": if is_err { "err" } else { "out" }, "text": ln } }));
                }
            }
            if !is_err {
                out.push(json!({ "type": "terminal", "runId": run,
                                 "line": { "type": "ok", "text": "✓ 완료" } }));
            }
        }

        // 패널을 먹이는 도구(TodoWrite·Task*)는 도구 행이 없으므로 종료 행도 없다.
        if row.as_ref().is_some_and(|r| TASK_TOOLS.contains(&r.name.as_str())) {
            return out;
        }

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
        // 편집 행의 요약은 +N −N이다(누적이 아니라 이 도구 한 번의 값 — `file.add/del`).
        if let Some(p) = row.as_ref().and_then(|r| r.pending.as_ref()).filter(|_| !is_err) {
            let (a, d) = (p.file["add"].as_u64().unwrap_or(0), p.file["del"].as_u64().unwrap_or(0));
            e.insert(
                "result".into(),
                json!(if p.file["tag"] == "new" { format!("새 파일 +{a}") } else { format!("+{a} −{d}") }),
            );
        } else if !tail.is_empty() {
            // ★R4(§R3.8-K) — 웹 검색이 찾은 페이지 목록. 실려야 그 행이 펼쳐진다.
            let links = if row.as_ref().is_some_and(|r| r.name == "WebSearch") && !is_err {
                extract_web_links(&tail)
            } else {
                vec![]
            };
            if links.is_empty() {
                let one = tail.replace(['\r', '\n'], " ");
                let short: String = one.chars().take(160).collect();
                e.insert("result".into(), json!(short));
            } else {
                // 2.6.2와 같은 요약 문구 — 링크가 있으면 본문 꼬리 대신 개수를 쓴다.
                e.insert("result".into(), json!(format!("{}개 결과", links.len())));
                e.insert("links".into(), Value::Array(links));
            }
            if row.as_ref().is_some_and(|r| r.verb == "Bash") {
                e.insert("output".into(), json!(tail));
            }
        }
        if let Some(d) = dur {
            e.insert("durationMs".into(), json!(d));
        }
        out.push(Value::Object(e));
        out
    }

    /// 프레임 1개 → `EngineEvent` 0..N개.
    pub fn translate(&mut self, f: &Value) -> Vec<Value> {
        let mut out: Vec<Value> = vec![];
        let ty = f.get("type").and_then(Value::as_str).unwrap_or("");
        let sub = f.get("subtype").and_then(Value::as_str).unwrap_or("");
        let run = self.run_id.clone();
        // **사이드체인 조기 분리**(메모리 「사이드체인 모델 프레임 + 폴백 확인 카드」).
        // 서브에이전트는 자기 정의대로 메인과 다른 모델로 돈다(Fable 메인 아래 Explore=Opus).
        // 그 프레임을 메인 경로에 태우면 ① 모델 전환 배너가 인터리브마다 핑퐁으로 도배되고
        // ② usage가 서브에이전트 컨텍스트라 게이지가 오염되고 ③ 내레이션이 메인 말풍선에
        // 섞이고 ④ `cur_msg`가 중간에 리셋돼 말풍선이 쪼개진다. 그래서 **가장 먼저** 가른다.
        // `subagent_type`도 함께 보는 이유: 부모 id 없이 종류만 실려 오는 판이 있다.
        let sidechain = f.get("parent_tool_use_id").map(|x| !x.is_null()).unwrap_or(false)
            || f.get("subagent_type").map(|x| !x.is_null()).unwrap_or(false);
        let parent = s(f, "parent_tool_use_id");

        match ty {
            "system" if sub == "init" => {
                self.via_api = f
                    .get("apiKeySource")
                    .and_then(Value::as_str)
                    .is_some_and(|v| !v.is_empty() && v != "none");
                self.cwd = s(f, "cwd").unwrap_or_default();
                self.session_id = s(f, "session_id").unwrap_or_default();
                // `modelUsage`가 없는 CLI 판에서 `result.tokenUsage`의 모델 이름이 되는 값.
                self.cur_model = s(f, "model").unwrap_or_default();
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
            // ── 백그라운드 작업 REPLACE ─────────────────────────────────────
            //
            // **순서 규약**: 이 프레임은 *살아 있는 목록 전체*다(레벨 신호). 목록에서
            // 빠진 항목은 렌더러가 곧바로 "끝난 것"으로 접고, **상세는 뒤따르는
            // `bg-task-end`가 채운다**(`protocol.ts:409-415`). 그래서 우리는 프레임
            // 도착 순서를 그대로 지키기만 하면 된다 — REPLACE 먼저, 정착 통지 나중.
            // 목록에 워크플로·백그라운드 서브에이전트도 섞여 오지만 `bg-tasks`에는
            // **셸 계열만** 싣는다(칩 이름값대로 — 나머지는 각자 전용 표시가 있다).
            "system" if sub == "background_tasks_changed" => {
                let empty = vec![];
                let all = f.get("tasks").and_then(Value::as_array).unwrap_or(&empty);
                self.live_workflows.clear();
                self.live_bg_agents.clear();
                let mut shells: Vec<Value> = vec![];
                let mut next_shell = BTreeSet::new();
                for t in all {
                    let Some(id) = t.get("task_id").and_then(Value::as_str) else { continue };
                    let kind = t.get("task_type").and_then(Value::as_str).unwrap_or("");
                    let low = kind.to_ascii_lowercase();
                    if low.contains("workflow") {
                        self.live_workflows.insert(id.to_string());
                        self.wf_ids.insert(id.to_string());
                    } else if low.contains("bash") || low.contains("shell") {
                        next_shell.insert(id.to_string());
                        shells.push(json!({
                            "id": id, "kind": kind,
                            "description": t.get("description").and_then(Value::as_str).unwrap_or(""),
                            "outputFile": bg_output_file(&self.cwd, &self.session_id, id),
                        }));
                    } else {
                        self.live_bg_agents.insert(id.to_string());
                    }
                }
                self.live_bg = next_shell;
                out.push(json!({ "type": "bg-tasks", "runId": run, "tasks": shells }));
            }
            // 워크플로 진행 — `workflow_progress`가 실린 `task_progress`만 보드가 된다.
            // 배열엔 phase와 agent가 섞여 오고 **매번 전체 스냅샷**이라 REPLACE로 흘린다.
            "system" if sub == "task_progress" => {
                let Some(task_id) = s(f, "task_id") else { return out };
                let empty = vec![];
                let wp = f.get("workflow_progress").and_then(Value::as_array).unwrap_or(&empty);
                if wp.is_empty() {
                    return out; // 그냥 하트비트다 — 표시할 것이 없다(상태기계가 리스만 재장전).
                }
                let mut phases: Vec<Value> = vec![];
                let mut agents: Vec<Value> = vec![];
                for e in wp {
                    match e.get("type").and_then(Value::as_str) {
                        Some("workflow_phase") => phases.push(json!({
                            "index": e.get("index").and_then(Value::as_u64).unwrap_or(0),
                            "title": e.get("title").and_then(Value::as_str).unwrap_or(""),
                        })),
                        Some("workflow_agent") => {
                            let state = e.get("state").and_then(Value::as_str).unwrap_or("").to_string();
                            let note_src = if state == "done" { "resultPreview" } else { "promptPreview" };
                            let note = one_line(e.get(note_src).and_then(Value::as_str).unwrap_or(""), 140);
                            let mut m = Map::new();
                            m.insert("label".into(), json!(e.get("label").and_then(Value::as_str).unwrap_or("")));
                            m.insert("phase".into(), json!(e.get("phaseIndex").and_then(Value::as_u64).unwrap_or(0)));
                            m.insert("phaseTitle".into(), json!(e.get("phaseTitle").and_then(Value::as_str).unwrap_or("")));
                            m.insert("model".into(), json!(model_display(e.get("model").and_then(Value::as_str).unwrap_or(""))));
                            m.insert("state".into(), json!(state));
                            for k in ["tokens", "toolCalls", "durationMs"] {
                                if let Some(v) = e.get(k).and_then(Value::as_u64) {
                                    m.insert(k.into(), json!(v));
                                }
                            }
                            if !note.is_empty() {
                                m.insert("note".into(), json!(note));
                            }
                            agents.push(Value::Object(m));
                        }
                        _ => {}
                    }
                }
                let prev = self
                    .wf_snaps
                    .get(&task_id)
                    .and_then(|w| w.get("summary").and_then(Value::as_str))
                    .unwrap_or("")
                    .to_string();
                let summary = s(f, "summary").map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).unwrap_or(prev);
                let u = &f["usage"];
                let wf = json!({
                    "id": task_id, "summary": summary, "status": "running",
                    "phases": phases, "agents": agents,
                    "totalTokens": u["total_tokens"].as_u64().unwrap_or(0),
                    "toolUses": u["tool_uses"].as_u64().unwrap_or(0),
                    "durationMs": u["duration_ms"].as_u64().unwrap_or(0),
                });
                self.wf_snaps.insert(task_id.clone(), wf.clone());
                self.wf_ids.insert(task_id);
                out.push(json!({ "type": "workflow", "runId": run, "wf": wf }));
            }
            // 작업 시작 북엔드 — `tool_use ↔ task` 매핑(백그라운드 접수증 판별에 쓴다).
            "system" if sub == "task_started" => {
                if let (Some(tu), Some(tid)) = (s(f, "tool_use_id"), s(f, "task_id")) {
                    self.task_by_tool_use.insert(tu, tid);
                }
            }
            // 정착 통지 — 워크플로 마감 · `bg-task-end` · 백그라운드 서브에이전트 완료.
            "system" if sub == "task_notification" => {
                let Some(task_id) = s(f, "task_id") else { return out };
                let st = f.get("status").and_then(Value::as_str).unwrap_or("");
                if !matches!(st, "completed" | "failed" | "stopped") {
                    return out;
                }
                let by_user = self.user_bg_stops.remove(&task_id);
                let summary = s(f, "summary").map(|x| x.trim().to_string()).filter(|x| !x.is_empty());
                // 워크플로는 bg 목록에서 **이미 빠진 뒤**에 통지가 온다 → `wf_ids`로 판별.
                if self.wf_ids.contains(&task_id) {
                    self.live_workflows.remove(&task_id);
                    if let Some(snap) = self.wf_snaps.get_mut(&task_id) {
                        if snap.get("status").and_then(Value::as_str) == Some("running") {
                            if let Some(o) = snap.as_object_mut() {
                                o.insert("status".into(), json!(st));
                                if o.get("summary").and_then(Value::as_str).unwrap_or("").is_empty() {
                                    o.insert("summary".into(), json!(summary.clone().unwrap_or_default()));
                                }
                            }
                            out.push(json!({ "type": "workflow", "runId": run, "wf": snap.clone() }));
                        }
                    }
                }
                self.live_bg.remove(&task_id);
                self.live_bg_agents.remove(&task_id);
                let mut e = Map::new();
                e.insert("type".into(), json!("bg-task-end"));
                e.insert("runId".into(), json!(run));
                e.insert("id".into(), json!(task_id));
                e.insert("status".into(), json!(st));
                if let Some(x) = &summary {
                    e.insert("summary".into(), json!(x));
                }
                if let Some(x) = s(f, "output_file") {
                    e.insert("outputFile".into(), json!(x));
                }
                e.insert("atTurnEnd".into(), json!(self.turn_ended));
                if by_user {
                    e.insert("byUser".into(), json!(true));
                }
                out.push(Value::Object(e));
                // 백그라운드 서브에이전트의 **진짜** 완료. Task의 tool_result는 "백그라운드로
                // 시작됨" 접수증이라 카드가 일찍 done이 되면 안 된다(아래 tool_result 분기가
                // 그 경우 running을 유지한다) — 완료는 이 통지가 맡는다.
                if let Some(tu) = s(f, "tool_use_id") {
                    if self.subagents.remove(&tu) {
                        let label = match st {
                            "completed" => "완료",
                            "stopped" if self.turn_ended => "턴 종료로 정리됨",
                            "stopped" => "중지됨",
                            _ => "실패",
                        };
                        let dur = self.tools.get(&tu).map(|r| now_ms().saturating_sub(r.started_ms));
                        out.push(json!({
                            "type": "subagent", "runId": run,
                            "agent": { "id": tu, "name": "", "role": "", "status": "done",
                                       "activity": summary.unwrap_or_else(|| label.to_string()),
                                       "tools": [], "durationMs": dur }
                        }));
                    }
                    self.task_by_tool_use.remove(&tu);
                }
            }
            "stream_event" if !sidechain => {
                let ev = &f["event"];
                match ev.get("type").and_then(Value::as_str).unwrap_or("") {
                    "content_block_start" => {
                        let cb = &ev["content_block"];
                        if cb["type"] == "text" {
                            let id = self.next_msg_id();
                            self.cur_msg = Some(id);
                        } else if cb["type"] == "tool_use" && !self.thinking_open {
                            // 도구 인자가 스트리밍되는 동안(Write면 파일 본문 전체)에는 답변
                            // 텍스트도 도구 행도 없어 화면이 멈춘 것처럼 보인다. 그 구간을
                            // 도구별 라벨로 채운다. `thinking_open`은 **건드리지 않는다** —
                            // 완성 프레임에서 clear가 안 나야 1프레임 깜빡임이 없다.
                            let name = cb.get("name").and_then(Value::as_str).unwrap_or("");
                            out.push(json!({ "type": "thinking", "runId": run, "text": tool_gen_label(name) }));
                        }
                    }
                    "content_block_delta" => {
                        let d = &ev["delta"];
                        match d.get("type").and_then(Value::as_str).unwrap_or("") {
                            "text_delta" => {
                                let delta = d.get("text").and_then(Value::as_str).unwrap_or("");
                                if !delta.is_empty() {
                                    // 답변이 시작됐다 = 생각 줄은 끝났다.
                                    if self.thinking_open {
                                        self.thinking_open = false;
                                        out.push(json!({ "type": "thinking-clear", "runId": run }));
                                    }
                                    let id = match &self.cur_msg {
                                        Some(i) => i.clone(),
                                        None => {
                                            let i = self.next_msg_id();
                                            self.cur_msg = Some(i.clone());
                                            i
                                        }
                                    };
                                    self.streamed_this_msg = true;
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
                                    self.thinking_open = true;
                                    self.streamed_this_msg = true;
                                    out.push(json!({ "type": "thinking", "runId": run, "text": one_line(t, 90) }));
                                }
                            }
                            _ => {}
                        }
                    }
                    _ => {}
                }
            }
            // ── 사이드체인(서브에이전트 내부) — **카드의 activity 한 줄로만** ────────
            //
            // 내부 `tool_use`는 부모 카드에 귀속(`parentToolId`), 내레이션/생각은 그 카드의
            // activity로. 메인 말풍선·게이지·모델 전환 배너는 **여기서 절대 건드리지 않는다**.
            "assistant" if sidechain => {
                let pid = parent.unwrap_or_default();
                if let Some(m) = f["message"]["model"].as_str() {
                    let disp = model_display(m);
                    if !pid.is_empty()
                        && self.subagents.contains(&pid)
                        && self.subagent_models.get(&pid) != Some(&disp)
                    {
                        self.subagent_models.insert(pid.clone(), disp.clone());
                        out.push(json!({
                            "type": "subagent", "runId": run,
                            "agent": { "id": pid, "name": "", "role": "", "status": "running",
                                       "activity": "", "tools": [], "model": disp }
                        }));
                    }
                }
                if let Some(blocks) = f["message"].get("content").and_then(Value::as_array) {
                    for b in blocks {
                        match b.get("type").and_then(Value::as_str).unwrap_or("") {
                            "tool_use" => {
                                let child = self.tool_start(b, Some(&pid));
                                out.extend(child);
                            }
                            kind @ ("text" | "thinking") => {
                                // 스폰을 목격한 서브에이전트만 — 모르는 pid에 빈 카드를 만들지 않는다.
                                if pid.is_empty() || !self.subagents.contains(&pid) {
                                    continue;
                                }
                                let key = if kind == "text" { "text" } else { "thinking" };
                                let line = one_line(b.get(key).and_then(Value::as_str).unwrap_or(""), 200);
                                if !line.is_empty() {
                                    out.push(json!({
                                        "type": "subagent", "runId": run,
                                        "agent": { "id": pid, "name": "", "role": "", "status": "running",
                                                   "activity": line, "tools": [] }
                                    }));
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
            "assistant" if !sidechain => {
                let msg = &f["message"];
                let mut text = String::new();
                if let Some(blocks) = msg.get("content").and_then(Value::as_array) {
                    let mut saw = vec![];
                    for b in blocks {
                        match b.get("type").and_then(Value::as_str).unwrap_or("") {
                            "text" => text.push_str(b.get("text").and_then(Value::as_str).unwrap_or("")),
                            "thinking" => {
                                // 델타가 하나도 안 흐른 경우의 폴백(완성 프레임만 오는 판).
                                let th = b.get("thinking").and_then(Value::as_str).unwrap_or("");
                                if !self.streamed_this_msg && !th.is_empty() {
                                    self.thinking_open = true;
                                    out.push(json!({ "type": "thinking", "runId": run, "text": one_line(th, 90) }));
                                }
                            }
                            "tool_use" => {
                                self.working(&mut out);
                                saw.push(b.clone());
                            }
                            _ => {}
                        }
                    }
                    // 답변 텍스트/도구 행이 자리를 넘겨받으면 생각 줄은 닫는다.
                    if (!text.trim().is_empty() || !saw.is_empty()) && self.thinking_open {
                        self.thinking_open = false;
                        out.push(json!({ "type": "thinking-clear", "runId": run }));
                    }
                    for b in &saw {
                        let evs = self.tool_start(b, None);
                        out.extend(evs);
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
                self.streamed_this_msg = false;
                if let Some(t) = msg["usage"]["input_tokens"].as_u64() {
                    let ctx = t
                        + msg["usage"]["cache_read_input_tokens"].as_u64().unwrap_or(0)
                        + msg["usage"]["cache_creation_input_tokens"].as_u64().unwrap_or(0);
                    out.push(json!({ "type": "context", "runId": run, "contextTokens": ctx }));
                }
            }
            // `tool_result`는 **사이드체인도 처리한다** — 서브에이전트의 자식 도구 행도
            // 끝나야 한다(그 행은 `parentToolId`로 카드에 귀속돼 있다). 사이드체인에서
            // 갈리는 것은 텍스트·usage뿐이고 그건 위 분기가 이미 가져갔다.
            "user" => {
                if let Some(blocks) = f["message"].get("content").and_then(Value::as_array) {
                    for b in blocks {
                        if b.get("type").and_then(Value::as_str) != Some("tool_result") {
                            continue;
                        }
                        let evs = self.tool_end(b);
                        out.extend(evs);
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
                // 오류 계열 subtype은 `result` 대신 **`errors: string[]`**를 싣는다
                // (`protocol-claude-cli.md` §5). R2까지는 그 경우 빈 문자열이 나갔다.
                let text = s(f, "result").filter(|t| !t.is_empty()).unwrap_or_else(|| {
                    let errs: Vec<&str> = f
                        .get("errors")
                        .and_then(Value::as_array)
                        .map(|a| a.iter().filter_map(Value::as_str).collect())
                        .unwrap_or_default();
                    if errs.is_empty() {
                        if is_error { "실행이 실패했습니다.".to_string() } else { String::new() }
                    } else {
                        errs.join("; ")
                    }
                });
                // 이후의 `stopped` 통지는 사용자 중지가 아니라 **턴 종료 정리**다.
                self.turn_ended = true;
                let usage = &f["usage"];
                let ctx = usage["input_tokens"].as_u64().map(|t| {
                    t + usage["cache_read_input_tokens"].as_u64().unwrap_or(0)
                        + usage["cache_creation_input_tokens"].as_u64().unwrap_or(0)
                });
                // ★R4(§R3.8-J) — `modelUsage`를 읽는다. R3까지 이 둘은 `null`이라
                // 컨텍스트 팝오버의 '토큰 사용량' 표가 비고 게이지의 분모가 모델 기본
                // 창으로 폴백했다. 2.6.2 `windowFromModelUsage`/`tokenUseFromResult`
                // (`engine.ts:97-144`)를 그대로 옮긴다.
                let mu = f.get("modelUsage");
                out.push(json!({
                    "type": "result", "runId": run,
                    "isError": is_error,
                    "text": text,
                    "costUsd": f.get("total_cost_usd").and_then(Value::as_f64),
                    "durationMs": f.get("duration_ms").and_then(Value::as_u64),
                    "numTurns": f.get("num_turns").and_then(Value::as_u64),
                    "contextTokens": ctx,
                    "contextWindow": context_window(mu),
                    "viaApi": self.via_api,
                    "tokenUsage": token_usage(mu, usage, &self.model_display_now()),
                }));
                self.cur_msg = None;
                self.saw_result = true;
            }
            _ => {}
        }
        out
    }
}

// ── 미배선 (R4 이후 남은 것) ─────────────────────────────────────────────────
// R3의 셋(`result.tokenUsage` · `result.contextWindow` · `tool-end.links`)은 **R4에서
// 닫았다** — 각각 `token_usage()` · `context_window()` · `extract_web_links()`.
//
// 남은 것:
// - Codex(app-server) 엔진 · `btw:open` 포크 · `allow_always`의 `updatedPermissions`.
// - `tool-end.target`(완료 때 확정되는 대상 — Codex webSearch 전용) — Claude 경로에는
//   해당 프레임이 없다.
//
// ★ 등급을 함께 적는 것이 규약이다(크리틱 배선 R1 §6). 위는 전부
//   **"그 UI만 비어 있다"**다 — 정지·증발 등급은 R2에서 셋 다 닫혔다.

#[cfg(test)]
mod tests {
    use super::*;

    fn wire() -> Wire {
        let mut w = Wire::default();
        w.begin_run("r1");
        w
    }
    fn types(evs: &[Value]) -> Vec<String> {
        evs.iter().map(|e| e["type"].as_str().unwrap_or("").to_string()).collect()
    }

    #[test]
    fn bg_replace_then_end_keeps_the_shell_chip_order() {
        let mut w = wire();
        w.translate(&json!({ "type": "system", "subtype": "init", "session_id": "S1", "cwd": "C:\\w" }));
        let a = w.translate(&json!({
            "type": "system", "subtype": "background_tasks_changed",
            "tasks": [{ "task_id": "t1", "task_type": "local_bash", "description": "빌드" },
                      { "task_id": "w1", "task_type": "local_workflow", "description": "wf" }]
        }));
        assert_eq!(types(&a), vec!["bg-tasks"]);
        // 워크플로는 셸 칩 목록에 안 들어간다(전용 표시가 있다).
        let tasks = a[0]["tasks"].as_array().unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0]["id"], "t1");
        assert!(tasks[0]["outputFile"].as_str().unwrap().ends_with("t1.output"));

        // REPLACE가 먼저(목록에서 빠짐), 정착 상세가 나중 — protocol.ts의 순서 규약.
        let b = w.translate(&json!({ "type": "system", "subtype": "background_tasks_changed", "tasks": [] }));
        assert_eq!(b[0]["tasks"].as_array().unwrap().len(), 0);
        let c = w.translate(&json!({
            "type": "system", "subtype": "task_notification",
            "task_id": "t1", "status": "completed", "summary": "끝", "output_file": "C:\\o.txt"
        }));
        assert_eq!(types(&c), vec!["bg-task-end"]);
        assert_eq!(c[0]["status"], "completed");
        assert_eq!(c[0]["summary"], "끝");
        assert_eq!(c[0]["atTurnEnd"], false);
    }

    #[test]
    fn a_running_workflow_never_survives_the_stream_close() {
        let mut w = wire();
        let a = w.translate(&json!({
            "type": "system", "subtype": "task_progress", "task_id": "w1", "summary": "정리",
            "usage": { "total_tokens": 10, "tool_uses": 2, "duration_ms": 5 },
            "workflow_progress": [
                { "type": "workflow_phase", "index": 1, "title": "조사" },
                { "type": "workflow_agent", "label": "탐색", "phaseIndex": 1, "phaseTitle": "조사",
                  "model": "claude-opus-5-1", "state": "start", "promptPreview": "무엇을\n찾을까" }
            ]
        }));
        assert_eq!(types(&a), vec!["workflow"]);
        assert_eq!(a[0]["wf"]["status"], "running");
        assert_eq!(a[0]["wf"]["agents"][0]["model"], "Opus 5.1");
        assert_eq!(a[0]["wf"]["agents"][0]["note"], "무엇을 찾을까");

        // 스트림이 닫히면 알약이 남으면 안 된다(고아 알약 금지).
        let closed = w.stream_closed("external_kill", 0);
        let wf = closed.iter().find(|e| e["type"] == "workflow").expect("워크플로 정착");
        assert_eq!(wf["wf"]["status"], "stopped");
        assert!(closed.iter().any(|e| e["type"] == "notice"));
    }

    #[test]
    fn a_broken_stream_is_an_error_bubble_not_a_notice() {
        let mut w = wire();
        let evs = w.stream_closed("spawn_failed", 0);
        assert!(evs.iter().any(|e| e["type"] == "error"), "{:?}", types(&evs));
        assert!(!evs.iter().any(|e| e["type"] == "notice"), "말을 두 번 하지 않는다");
        let r = evs.iter().find(|e| e["type"] == "result").expect("합성 result");
        assert_eq!(r["isError"], true, "카드 해제·컴포저 해제가 여기 달려 있다");
        assert_eq!(r["text"], "", "사유는 error 말풍선이 이미 말했다 — 두 벌 금지");
    }

    #[test]
    fn thinking_is_cleared_when_the_answer_starts() {
        let mut w = wire();
        let a = w.translate(&json!({ "type": "stream_event",
            "event": { "type": "content_block_delta", "delta": { "type": "thinking_delta", "thinking": "음…" } } }));
        assert_eq!(types(&a), vec!["thinking"]);
        let b = w.translate(&json!({ "type": "stream_event",
            "event": { "type": "content_block_delta", "delta": { "type": "text_delta", "text": "답" } } }));
        assert_eq!(types(&b), vec!["thinking-clear", "status", "assistant-stream"]);
    }

    #[test]
    fn a_bash_tool_paints_the_command_then_its_output() {
        let mut w = wire();
        let a = w.translate(&json!({ "type": "assistant", "message": { "content": [
            { "type": "tool_use", "id": "tu1", "name": "Bash", "input": { "command": "echo hi" } }] } }));
        assert_eq!(types(&a), vec!["status", "tool-start", "terminal"]);
        assert_eq!(a[2]["line"]["type"], "cmd");
        let b = w.translate(&json!({ "type": "user", "message": { "content": [
            { "type": "tool_result", "tool_use_id": "tu1", "content": "hi" }] } }));
        assert_eq!(types(&b), vec!["terminal", "terminal", "tool-end"]);
        assert_eq!(b[0]["line"], json!({ "type": "out", "text": "hi" }));
        assert_eq!(b[1]["line"]["type"], "ok");
    }

    #[test]
    fn a_failed_write_leaves_no_phantom_diff() {
        let mut w = wire();
        let dir = std::env::temp_dir().join(format!("ccg-wire-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let p = dir.join("x.txt");
        let _ = std::fs::remove_file(&p);
        w.cwd = dir.to_string_lossy().to_string();
        w.translate(&json!({ "type": "assistant", "message": { "content": [
            { "type": "tool_use", "id": "tu1", "name": "Write",
              "input": { "file_path": p.to_string_lossy(), "content": "a\nb\n" } }] } }));
        let bad = w.translate(&json!({ "type": "user", "message": { "content": [
            { "type": "tool_result", "tool_use_id": "tu1", "is_error": true, "content": "denied" }] } }));
        assert!(!bad.iter().any(|e| e["type"] == "file-change"), "거부된 편집은 디프를 남기지 않는다");

        w.translate(&json!({ "type": "assistant", "message": { "content": [
            { "type": "tool_use", "id": "tu2", "name": "Write",
              "input": { "file_path": p.to_string_lossy(), "content": "a\nb\n" } }] } }));
        let good = w.translate(&json!({ "type": "user", "message": { "content": [
            { "type": "tool_result", "tool_use_id": "tu2", "content": "ok" }] } }));
        let fc = good.iter().find(|e| e["type"] == "file-change").expect("성공하면 디프가 나간다");
        assert_eq!(fc["file"]["tag"], "new");
        assert_eq!(fc["file"]["add"], 2);
        assert_eq!(fc["whole"], true);
    }

    #[test]
    fn a_sidechain_frame_never_touches_the_main_bubble_or_the_gauge() {
        let mut w = wire();
        w.translate(&json!({ "type": "assistant", "message": { "content": [
            { "type": "tool_use", "id": "task1", "name": "Task",
              "input": { "subagent_type": "Explore", "description": "찾아봐" } }] } }));
        assert!(w.subagents.contains("task1"));
        let evs = w.translate(&json!({
            "type": "assistant", "parent_tool_use_id": "task1",
            "message": { "model": "claude-opus-5", "content": [{ "type": "text", "text": "훑는 중" }],
                         "usage": { "input_tokens": 99_999 } }
        }));
        assert_eq!(types(&evs), vec!["subagent", "subagent"], "모델 + 내레이션만");
        assert_eq!(evs[0]["agent"]["model"], "Opus 5");
        assert_eq!(evs[1]["agent"]["activity"], "훑는 중");
        assert!(
            !evs.iter().any(|e| e["type"] == "context" || e["type"] == "assistant-done"),
            "게이지·말풍선 오염 금지"
        );
    }

    #[test]
    fn todos_come_from_todowrite_and_from_the_incremental_task_tools() {
        let mut w = wire();
        let a = w.translate(&json!({ "type": "assistant", "message": { "content": [
            { "type": "tool_use", "id": "t1", "name": "TodoWrite", "input": { "todos": [
                { "content": "하나", "status": "in_progress" }, { "content": "둘", "status": "pending" }] } }] } }));
        let todos = a.iter().find(|e| e["type"] == "todos").expect("todos");
        assert_eq!(todos["todos"][0], json!({ "id": "1", "label": "하나", "status": "running" }));
        assert!(!a.iter().any(|e| e["type"] == "tool-start"), "패널 도구는 도구 행을 안 만든다");

        w.translate(&json!({ "type": "assistant", "message": { "content": [
            { "type": "tool_use", "id": "t2", "name": "TaskCreate", "input": { "subject": "셋" } }] } }));
        let c = w.translate(&json!({ "type": "assistant", "message": { "content": [
            { "type": "tool_use", "id": "t3", "name": "TaskUpdate", "input": { "taskId": "1", "status": "completed" } }] } }));
        let last = c.iter().find(|e| e["type"] == "todos").unwrap();
        assert_eq!(last["todos"][0]["status"], "done");
    }

    #[test]
    fn an_error_result_carries_the_errors_array() {
        let mut w = wire();
        let evs = w.translate(&json!({
            "type": "result", "subtype": "error_during_execution", "is_error": true,
            "errors": ["ede_diagnostic", "aborted_tools"]
        }));
        assert_eq!(evs[0]["text"], "ede_diagnostic; aborted_tools");
    }
    // ── ★R4 — R3이 `null`로 내보내던 세 칸 ────────────────────────────────
    #[test]
    fn the_result_carries_the_real_context_window_and_per_model_tokens() {
        let mut w = wire();
        w.translate(&json!({ "type": "system", "subtype": "init", "session_id": "S1",
                             "cwd": "C:\\w", "model": "claude-opus-5-1" }));
        let evs = w.translate(&json!({
            "type": "result", "subtype": "success", "is_error": false, "result": "끝",
            "usage": { "input_tokens": 10, "output_tokens": 20 },
            "modelUsage": {
                // 같은 표시명으로 접히는 두 id([1m] 변형) — 하나로 합쳐야 한다.
                "claude-opus-5-1":      { "contextWindow": 200000, "inputTokens": 5,
                                          "outputTokens": 7, "cacheReadInputTokens": 11,
                                          "cacheCreationInputTokens": 3 },
                "claude-opus-5-1[1m]":  { "contextWindow": 1000000, "inputTokens": 1,
                                          "outputTokens": 2 },
                // 전부 0인 항목은 안 낸다(서브에이전트가 안 돈 판).
                "claude-haiku-4":       { "contextWindow": 200000 }
            }
        }));
        let r = &evs[0];
        assert_eq!(r["contextWindow"], 1_000_000, "여러 모델이면 **가장 큰 창**이 메인이다");
        let tu = r["tokenUsage"].as_array().expect("tokenUsage 배열");
        assert_eq!(tu.len(), 1, "표시명이 같은 id는 하나로 접힌다: {tu:?}");
        assert_eq!(tu[0]["model"], "Opus 5.1");
        assert_eq!(tu[0]["inTok"], 6);
        assert_eq!(tu[0]["outTok"], 9);
        assert_eq!(tu[0]["cacheRead"], 11);
        assert_eq!(tu[0]["cacheWrite"], 3);
    }

    #[test]
    fn without_model_usage_the_summed_usage_falls_back_to_the_current_model() {
        let mut w = wire();
        w.translate(&json!({ "type": "system", "subtype": "init", "session_id": "S1",
                             "cwd": "C:\\w", "model": "claude-haiku-4-5" }));
        let evs = w.translate(&json!({
            "type": "result", "subtype": "success", "is_error": false, "result": "끝",
            "usage": { "input_tokens": 3, "output_tokens": 4, "cache_read_input_tokens": 5 }
        }));
        assert_eq!(evs[0]["contextWindow"], Value::Null, "모르면 null — 지어내지 않는다");
        let tu = evs[0]["tokenUsage"].as_array().unwrap();
        assert_eq!(tu.len(), 1);
        assert_eq!(tu[0]["model"], "Haiku 4.5");
        assert_eq!(tu[0]["inTok"], 3);
        assert_eq!(tu[0]["cacheRead"], 5);
    }

    #[test]
    fn a_web_search_row_carries_its_links() {
        let mut w = wire();
        w.translate(&json!({ "type": "system", "subtype": "init", "session_id": "S1", "cwd": "C:\\w" }));
        w.translate(&json!({ "type": "assistant", "message": { "content": [
            { "type": "tool_use", "id": "t1", "name": "WebSearch", "input": { "query": "rust queue" } }] } }));
        let body = "Web search results for query: rust queue\n\nLinks: [{\"title\":\"VecDeque\",\"url\":\"https://doc.rust-lang.org/vd\"},{\"title\":\"\",\"url\":\"https://example.com/x\"}]\n\n요약…";
        let evs = w.translate(&json!({ "type": "user", "message": { "content": [
            { "type": "tool_result", "tool_use_id": "t1", "content": body }] } }));
        let end = evs.iter().find(|e| e["type"] == "tool-end").expect("tool-end");
        let links = end["links"].as_array().expect("links");
        assert_eq!(links.len(), 2);
        assert_eq!(links[0]["title"], "VecDeque");
        assert_eq!(links[1]["title"], "https://example.com/x", "제목이 없으면 url을 쓴다");
        assert_eq!(end["result"], "2개 결과");
    }

    #[test]
    fn a_broken_links_block_still_yields_urls_and_other_tools_get_none() {
        let mut w = wire();
        w.translate(&json!({ "type": "system", "subtype": "init", "session_id": "S1", "cwd": "C:\\w" }));
        w.translate(&json!({ "type": "assistant", "message": { "content": [
            { "type": "tool_use", "id": "t1", "name": "WebSearch", "input": { "query": "q" } }] } }));
        // 잘린 블록 — 폴백이 url만 줍는다.
        let evs = w.translate(&json!({ "type": "user", "message": { "content": [
            { "type": "tool_result", "tool_use_id": "t1",
              "content": "Links: [{\"title\":\"a\",\"url\":\"https://a.test/1\" , {\"url\": \"https://b.test/2\"}" }] } }));
        let end = evs.iter().find(|e| e["type"] == "tool-end").unwrap();
        let links = end["links"].as_array().expect("폴백이 줍는다");
        assert_eq!(links.len(), 2);
        assert_eq!(links[0]["url"], "https://a.test/1");

        // Read 행에는 링크를 달지 않는다(웹 행만 펼쳐진다).
        w.translate(&json!({ "type": "assistant", "message": { "content": [
            { "type": "tool_use", "id": "t2", "name": "Read", "input": { "file_path": "C:\\w\\a.txt" } }] } }));
        let evs = w.translate(&json!({ "type": "user", "message": { "content": [
            { "type": "tool_result", "tool_use_id": "t2", "content": "https://not-a-link-row.test/x" }] } }));
        let end = evs.iter().find(|e| e["type"] == "tool-end").unwrap();
        assert!(end.get("links").is_none(), "웹 도구가 아니면 링크 없음: {end}");
    }
}
