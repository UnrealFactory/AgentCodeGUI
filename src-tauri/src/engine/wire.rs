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
    ///
    /// ★M4 — `Vec`인 이유: Codex의 `fileChange` 아이템 하나가 **파일 여러 개**를
    /// 바꾼다(`changes[]`). Claude 경로는 언제나 0..1개라 동작이 같다.
    pending: Vec<PendingChange>,
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

    // ── M9: 이 채팅의 도구 환경(MCP·스킬) ──────────────────────────────────
    /// `/명령` 사전 — 이름 → 설명. **출처가 둘**이고 둘 다 REPLACE다:
    ///  ① `initialize` 컨트롤 **응답**의 `commands[]` (스폰당 1회, `system/init`보다 먼저 온다)
    ///  ② `system/commands_changed` 푸시 (세션 중간 변경 — `sdk.d.ts` "REPLACE your cached list")
    ///
    /// 왜 따로 드나: `system/init`의 `skills[]`는 **이름 문자열 배열**이다(실측 — 설명도
    /// 스코프도 없다). 설명은 오직 커맨드 사전에만 있다. 두 벌을 여기서 조인해야 팝오버가
    /// 이름만 나열하지 않는다.
    ///
    /// ★실측 주의(`poc-mcpskill.mjs --app`): ②는 CLI 수준에서는 확실히 오지만
    /// (`result` **뒤**에 REPLACE 한 장) **이 앱에는 안 닿았다** — 턴이 끝나면 CLI가
    /// 죽어서다(2턴 주행에서 `commands_changed` 0장 · `system/init` 3장). ②를 지우면
    /// 안 되는 이유는 상주 판(중단 복귀·예약 드레인)에서는 프로세스가 턴을 넘겨 살고,
    /// 그때 하위 폴더의 `.claude/skills`가 세션 중간에 발견되기 때문이다.
    cmd_desc: BTreeMap<String, String>,
    /// 마지막 `system/init`이 보고한 도구 환경 원재료. `None` = 아직 init을 못 봤다
    /// (그 상태에서는 `tooling` 이벤트를 **안 낸다** — 빈 목록과 미지는 다르다).
    env: Option<ToolEnv>,
    /// 이 채팅이 CLI에 **실제로 실은** 정책(m-logic P1e `tools` 축) — 끈 MCP 서버 이름.
    ///
    /// ★실측(`poc-mcpskill.mjs` C 픽스처 — B와 **같은 폴더**를 끄기 정책으로 한 번 더
    /// 띄운 판): `--settings`에 `deniedMcpServers:[{serverName}]`를 실으면 그 서버는
    /// `init.mcp_servers`에서 **행째로 사라지고**(`status:"disabled"`로 오지 **않는다**)
    /// `init.tools`의 `mcp__<서버>__*`도 함께 사라진다. 스킬의 `skillOverrides:{이름:'off'}`도
    /// 똑같이 `init.skills`에서 없어지고, **커맨드 사전에서도 빠진다**(그래서 되붙인 off
    /// 행에는 설명이 없다 — 화면은 「설정에서 껐어요」만 적는다). 안 끈 항목은 그대로 남아
    /// 정책이 목록을 통째로 비우는 것이 아님도 같이 봤다.
    ///
    /// 그래서 와이어만 보면 **"내가 껐다"와 "설정에 아예 없다"가 같은 얼굴**이 된다 —
    /// 사용자가 설정에서 끈 서버를 패널에서 찾으면 아무 흔적도 없다. 그 한 칸을 여기서
    /// 되살린다.
    denied_mcp: Vec<String>,
    off_skills: Vec<String>,
}

/// `system/init` 한 장에서 뽑은 도구 환경 원재료(설명 조인 전).
#[derive(Default)]
struct ToolEnv {
    /// `init.skills` — 이름 배열. **정렬하지 않는다**: CLI가 이미 개인·프로젝트 스킬을
    /// 앞에, 내장 스킬을 뒤에 놓는다(실측 A: `gamma-personal`(user) · `alpha-probe`(project)
    /// 뒤에 `deep-research`·`dataviz`… 14개). 이 폴더에서만 보이는 것이 먼저 읽혀야 하므로
    /// 그 순서가 곧 우리가 원하는 순서다.
    skills: Vec<String>,
    /// `init.mcp_servers` — `(name, status)`. 실측 status: `connected` · `failed`.
    mcp: Vec<(String, String)>,
    /// 정규화된 서버 이름 → 그 서버가 붙인 도구 이름들. `init.tools`의 `mcp__<서버>__<도구>`
    /// 접두사에서 갈라낸다 — **추가 컨트롤 왕복 없이** 서버별 도구 수를 아는 유일한 길이다.
    mcp_tools: BTreeMap<String, Vec<String>>,
    /// `init.plugins` — `(name, version?)`.
    plugins: Vec<(String, Option<String>)>,
    cwd: String,
}

/// MCP 도구 접두사의 서버 이름 정규화 — CLI가 `mcp__<정규화된 이름>__<도구>`를 만들 때
/// 쓰는 규칙(`sdk.d.ts` `mcp_call`: "non-[a-zA-Z0-9_-] becomes _"). 설정된 이름과
/// 접두사를 되맞추려면 이쪽에서 같은 변환을 해야 한다.
///
/// ★R2 정정(크리틱 실측 `critic-m9-norm.mjs` — 실 CLI 0.3.241에 5종을 물린 판):
/// R1은 `chars()`(유니코드 **스칼라**) 하나를 `_` 하나로 바꿨다. 그런데 CLI는 JS라
/// 정규식이 **UTF-16 코드 단위**를 돈다 — 서로게이트 쌍(비BMP)은 `_` **두 개**가 된다.
///
/// ```text
/// 설정 이름        실 CLI 접두사          R1 기대            판정
/// my.co tools     mcp__my_co_tools__     같음               일치
/// srv__dbl        mcp__srv__dbl__        같음               일치
/// 한글서버         mcp________           같음               일치 (BMP는 1자 = 1단위)
/// UPPER-Case      mcp__UPPER-Case__      같음               일치 (대문자 보존)
/// emoji🚀srv      mcp__emoji__srv__      mcp__emoji_srv__   ★불일치
/// ```
///
/// 불일치의 대가는 조용한 소멸이다: 그 서버 행은 「연결됨」인데 도구 이름도 `도구 N`
/// 배지도 없다(되맞춤 키가 어긋나 도구가 어느 행에도 안 붙는다). `len_utf16()`만큼
/// `_`를 넣으면 두 규칙이 같아진다.
fn mcp_norm(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for c in name.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            out.push(c);
        } else {
            // 서로게이트 쌍 1자 = `_` 2개(JS 정규식이 코드 단위를 돌기 때문).
            for _ in 0..c.len_utf16() {
                out.push('_');
            }
        }
    }
    out
}

/// 커맨드 설명 꼬리의 스코프 표식을 갈라낸다 — `"… (project)"` → `("…", Some("project"))`.
///
/// 실측(`scripts/poc-mcpskill.mjs`): 프로젝트 스킬은 `(project)`, 개인 스킬은 `(user)`가
/// 설명 **끝에** 붙는다. 같은 자리에 스킬이 아닌 꼬리도 온다(`(dynamic workflow)`,
/// `(Opus 5)`, `(resumable with /resume)`) — 그래서 **닫힌 집합만** 떼어낸다. 모르는
/// 꼬리는 설명의 일부로 남긴다(지어내지 않는다).
fn split_scope(desc: &str) -> (String, Option<&'static str>) {
    for scope in ["user", "project", "local", "plugin"] {
        let tail = format!(" ({scope})");
        if let Some(head) = desc.strip_suffix(&tail) {
            return (head.to_string(), Some(scope));
        }
    }
    (desc.to_string(), None)
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
        // ★M4 — Codex의 `fileChange`. 표시는 편집 행과 같지만 **이름이 달라야** 한다:
        // `Edit`이면 위의 `build_pending`이 Claude 도구 입력을 기대해 빈 diff를 만든다.
        // 실제 변경 본문은 합성 프레임(`ccg_codex{file_change}`)이 실어 온다.
        "codex_file_change" => ("Edit".into(), "edit"),
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
/// `skill`(Skill)·`name`(저장 워크플로 등)은 꼬리에 둔다 — description/prompt가 있는
/// 도구(Agent 등)는 그쪽이 먼저다. 대상이 비면 행이 「동사 …(공백)… 결과」로 갈라져
/// 결과 문장이 오른쪽 끝에 홀로 붙는다(2026-09-01 사용자 보고: Skill/Workflow 행).
fn tool_target(input: &Value) -> String {
    for k in ["file_path", "path", "notebook_path", "command", "pattern", "query", "url", "description", "prompt", "skill", "name"] {
        if let Some(v) = input.get(k).and_then(Value::as_str) {
            let one = v.replace(['\r', '\n'], " ");
            return if one.chars().count() > 180 {
                one.chars().take(180).collect::<String>() + "…"
            } else {
                one
            };
        }
    }
    // 인라인 워크플로 — 이름 키 없이 `script`뿐이다. 대본 규약상 머리의 **순수 리터럴**
    // `export const meta = { name: '…' }`에서 이름을 집는다(실패하면 빈 대상 그대로).
    if let Some(script) = input.get("script").and_then(Value::as_str) {
        if let Some(n) = script_meta_name(script) {
            return n;
        }
    }
    String::new()
}

/// 워크플로 대본 머리의 `meta.name` 리터럴 값. 파서가 아니라 표시용 추출 — meta는
/// 규약상 보간 없는 순수 리터럴이라 첫 `name:` 뒤의 따옴표 짝이면 충분하다.
fn script_meta_name(script: &str) -> Option<String> {
    let head: String = script.chars().take(600).collect();
    let rest = &head[head.find("name")? + 4..];
    let rest = rest.trim_start().strip_prefix(':')?.trim_start();
    let quote = rest.chars().next().filter(|c| matches!(c, '\'' | '"' | '`'))?;
    let body = &rest[quote.len_utf8()..];
    let name = &body[..body.find(quote)?];
    (!name.is_empty() && name.chars().count() <= 80).then(|| name.to_string())
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

    // ── M9: 도구 환경(MCP·스킬) ────────────────────────────────────────────

    /// 커맨드 사전을 갈아끼운다(REPLACE). 배열이 아니면 아무것도 안 하고 `false`.
    ///
    /// 반환값이 "스냅샷을 다시 낼 이유가 생겼나"다 — **내용이 실제로 바뀐 경우만** 참이다.
    /// 빈 배열도 **유효한 REPLACE**로 받는다(커맨드가 전부 사라진 판을 낡은 사전으로 덮으면
    /// 팝오버가 유령 스킬을 그린다).
    ///
    /// ★같은 사전을 다시 받았을 때 참을 주면 안 되는 이유(실측 `poc-mcpskill.mjs --app`):
    /// 이 앱은 **턴마다 CLI를 다시 띄운다**(2턴 주행에서 `system/init` 3장 — 패널A 2 ·
    /// 패널B 1). 그러면 2턴째 핸드셰이크의 `initialize` 응답이 **`system/init`보다 먼저**
    /// 도착하는데, 그 시점의 `env`는 아직 **지난 턴 것**이다. 무조건 방출하면 매 턴
    /// "직전 턴의 도구 환경"이 한 번씩 화면에 스쳤다가 곧바로 덮인다. 사전이 그대로면
    /// 새로 말할 것도 없으므로, 여기서 접으면 그 깜빡임이 사라진다.
    fn read_commands(&mut self, v: Option<&Value>) -> bool {
        let Some(arr) = v.and_then(Value::as_array) else { return false };
        let next: BTreeMap<String, String> = arr
            .iter()
            .filter_map(|c| {
                let name = c.get("name").and_then(Value::as_str)?;
                Some((
                    name.to_string(),
                    c.get("description").and_then(Value::as_str).unwrap_or("").to_string(),
                ))
            })
            .collect();
        if next == self.cmd_desc {
            return false;
        }
        self.cmd_desc = next;
        true
    }

    /// `system/init` 한 장에서 도구 환경 원재료를 뽑는다(REPLACE).
    fn read_init_env(&mut self, f: &Value) {
        let arr = |k: &str| f.get(k).and_then(Value::as_array).cloned().unwrap_or_default();
        let mut env = ToolEnv { cwd: self.cwd.clone(), ..Default::default() };
        env.skills = arr("skills").iter().filter_map(Value::as_str).map(str::to_string).collect();
        env.mcp = arr("mcp_servers")
            .iter()
            .filter_map(|m| {
                let name = m.get("name").and_then(Value::as_str)?;
                // status가 없는 판이 와도 행을 버리지 않는다 — **서버가 있다는 사실**이
                // 먼저다. 모르는 상태는 `unknown`으로 정직하게 적는다.
                let st = m.get("status").and_then(Value::as_str).unwrap_or("unknown");
                Some((name.to_string(), st.to_string()))
            })
            .collect();
        for t in arr("tools").iter().filter_map(Value::as_str) {
            // `mcp__<정규화된 서버>__<도구>`. 서버 이름 자체에 `__`가 들어갈 수 있으므로
            // **뒤에서** 가른다 — 도구 이름에는 `__`가 없다고 보는 쪽이 오탐이 적다.
            let Some(rest) = t.strip_prefix("mcp__") else { continue };
            let Some((server, tool)) = rest.rsplit_once("__") else { continue };
            // ★R2 — 접두사 조각도 [`mcp_norm`]에 한 번 통과시켜 키를 만든다. 이미 정규화된
            // 조각에는 **아무 일도 안 일어나고**(멱등: `_`·영숫자·`-`는 그대로), 정규화를
            // 안 거친 접두사가 오는 판에서만 양쪽이 같은 자리에 떨어진다. 그 판은 있다 —
            // 크리틱 A2는 `mcp__Ω_유니코드_🚀__hello`(공백만 `_`로 바꾼 조각)를 흘렸고,
            // R1은 원문 키로 담아 `mcp_norm("Ω 유니코드 🚀")`와 어긋나 도구를 잃었다.
            env.mcp_tools.entry(mcp_norm(server)).or_default().push(tool.to_string());
        }
        env.plugins = arr("plugins")
            .iter()
            .filter_map(|p| {
                let name = p.get("name").and_then(Value::as_str)?;
                Some((name.to_string(), p.get("version").and_then(Value::as_str).map(str::to_string)))
            })
            .collect();
        self.env = Some(env);
    }

    /// 이 채팅의 도구 정책(P1e)을 옮김기에 알린다. **바뀔 때만** 스냅샷을 다시 낸다 —
    /// 허브가 매 tick 부르므로 여기서 접지 않으면 20ms마다 REPLACE가 나간다.
    ///
    /// 반환값이 "스냅샷을 다시 낼 이유가 생겼나"다. 호출부는 그때만 [`Self::tooling`]을 부른다.
    pub fn set_policy(&mut self, denied_mcp: &BTreeSet<String>, off_skills: &BTreeSet<String>) -> bool {
        let denied: Vec<String> = denied_mcp.iter().cloned().collect();
        let off: Vec<String> = off_skills.iter().cloned().collect();
        if denied == self.denied_mcp && off == self.off_skills {
            return false;
        }
        self.denied_mcp = denied;
        self.off_skills = off;
        self.env.is_some()
    }

    /// 스냅샷을 다시 내야 할 때 호출부가 쓰는 공개 창구(`set_policy`가 true를 준 뒤).
    ///
    /// ★R2 — **질의 채널의 답도 여기서 나온다**(`chat:tooling-get` → `Hub::Op::ToolingGet`).
    /// R1은 값의 출처가 스폰당 푸시 한 장뿐이었고, 렌더러는 그것을 컴포넌트 state에만
    /// 담았다. 그래서 껍데기가 갈리면(「크게 보기」=오버레이 카드로 이동 · 팝아웃=다른 창
    /// · 복귀=그리드 재마운트) 칩이 증발했다 — **셸에는 `env`가 그대로 있는데 다시 물을
    /// 창구가 없었다**(크리틱 A9·A6). 같은 함수를 조회로도 열어 두면 재마운트가 한 번
    /// 물어보고 끝난다. 스냅샷은 여전히 **메모리에만** 있으므로(디스크 절임 없음)
    /// 재시작 뒤에는 아무것도 안 돌아온다 — R1이 세운 그 원칙은 그대로다.
    pub fn tooling(&self) -> Option<Value> {
        self.tooling_event()
    }

    /// 지금 아는 것으로 `tooling` 스냅샷을 만든다. `system/init`을 아직 못 봤으면
    /// **아무것도 내지 않는다** — 빈 목록("MCP 없음")과 미지("아직 모른다")는 다른 말이고,
    /// 화면은 그 둘을 다르게 그려야 한다.
    fn tooling_event(&self) -> Option<Value> {
        let env = self.env.as_ref()?;
        let mut skills: Vec<Value> = env
            .skills
            .iter()
            .map(|n| {
                let (desc, scope) = match self.cmd_desc.get(n) {
                    Some(d) => split_scope(d),
                    // 사전에 없는 이름 = 커맨드 응답이 아직 안 왔거나 이 판에 설명이 없다.
                    // 이름만이라도 낸다(스킬이 있다는 사실이 설명보다 먼저다).
                    None => (String::new(), None),
                };
                json!({ "name": n, "description": desc, "scope": scope })
            })
            .collect();
        let mut mcp: Vec<Value> = env
            .mcp
            .iter()
            .map(|(name, status)| {
                let tools = env.mcp_tools.get(&mcp_norm(name)).cloned().unwrap_or_default();
                json!({ "name": name, "status": status, "tools": tools })
            })
            .collect();
        // 끈 것들을 **꼬리에** 되붙인다(`status:"off"`). 와이어가 지운 행이라 다른 어떤
        // 경로로도 화면에 못 온다. 순서를 뒤가 아니라 앞으로 두면 "붙어 있는 것"보다
        // "안 쓰는 것"이 먼저 읽혀 목록의 의미가 뒤집힌다.
        for name in &self.denied_mcp {
            if env.mcp.iter().any(|(n, _)| n == name) {
                continue; // 껐는데도 와이어에 살아 있다면 와이어가 이긴다(재스폰 전 낡은 정책)
            }
            mcp.push(json!({ "name": name, "status": "off", "tools": [] }));
        }
        for name in &self.off_skills {
            if env.skills.iter().any(|n| n == name) {
                continue;
            }
            let desc = self.cmd_desc.get(name).map(|d| split_scope(d));
            skills.push(json!({
                "name": name,
                "description": desc.as_ref().map(|(d, _)| d.clone()).unwrap_or_default(),
                "scope": desc.and_then(|(_, s)| s),
                "off": true,
            }));
        }
        let plugins: Vec<Value> = env
            .plugins
            .iter()
            .map(|(n, v)| json!({ "name": n, "version": v }))
            .collect();
        Some(json!({
            "type": "tooling",
            "runId": self.run_id,
            "tooling": { "cwd": env.cwd, "mcp": mcp, "skills": skills, "plugins": plugins },
        }))
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
                ToolRow { verb: "Task".into(), name: name.clone(), started_ms: now_ms(), pending: vec![] },
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
        let mut row = ToolRow { verb: verb.clone(), name: name.clone(), started_ms: now_ms(), pending: vec![] };
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
            row.pending = diff::build_pending(&mut self.baselines, &name, &input, &self.cwd).into_iter().collect();
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
        if !is_err {
            for p in row.iter().flat_map(|r| r.pending.iter()) {
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
        let changed: Vec<&PendingChange> =
            if is_err { vec![] } else { row.iter().flat_map(|r| r.pending.iter()).collect() };
        if !changed.is_empty() {
            // 편집 행의 요약은 +N −N이다(누적이 아니라 이 도구 한 번의 값 — `file.add/del`).
            // 파일이 여럿이면(Codex `fileChange`) 합계 + 파일 수.
            let (a, d): (u64, u64) = changed.iter().fold((0, 0), |(a, d), p| {
                (a + p.file["add"].as_u64().unwrap_or(0), d + p.file["del"].as_u64().unwrap_or(0))
            });
            let one_new = changed.len() == 1 && changed[0].file["tag"] == "new";
            e.insert(
                "result".into(),
                json!(match (one_new, changed.len()) {
                    (true, _) => format!("새 파일 +{a}"),
                    (_, 1) => format!("+{a} −{d}"),
                    (_, n) => format!("파일 {n}개 +{a} −{d}"),
                }),
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
                // ★M9 — 같은 프레임의 `mcp_servers`·`skills`·`plugins`·`tools`. R4까지
                // `tools`만 `session`에 실려 갔고 나머지 셋은 **버려졌다**. 화면이 도구
                // 환경을 물으려면 디스크를 다시 스캔하는 수밖에 없었고(2.6.2 방식), 그건
                // "설정에 뭐가 적혀 있나"이지 "지금 이 대화에 뭐가 붙어 있나"가 아니다.
                self.read_init_env(f);
                out.extend(self.tooling_event());
            }
            // ★M9 — 커맨드 목록 REPLACE 푸시. 스킬은 세션 중간에도 늘어난다(에이전트가
            // 하위 폴더로 내려가면 그 폴더의 `.claude/skills`가 발견된다 — `sdk.d.ts`
            // `SDKCommandsChangedMessage`). 설명 사전만 갈고 스냅샷을 다시 낸다.
            "system" if sub == "commands_changed" => {
                if self.read_commands(f.get("commands")) {
                    out.extend(self.tooling_event());
                }
            }
            // `system/notification`·`informational`은 **여기서 옮기지 않는다.**
            //
            // 같은 프레임이 상태기계에도 올라가 `F18 → Event::Notice`가 되고, `hub.rs`가
            // 그것을 다시 `notice`로 팬아웃한다. 여기서 한 번 더 옮기면 화면에 **정확히
            // 두 배**로 찍힌다 — Claude는 이 프레임을 거의 안 보내 여태 안 보였고, Codex는
            // 재시도마다 보내서 크리틱이 9회 → 18줄로 잡았다(m4-r1 §4.6).
            //
            // 남는 한 곳을 상태기계 쪽으로 고른 이유: `state.rs`의 프레임 규약표(F18)가
            // 그 경로를 **선언**하고 있고 커버리지 게이트가 그것을 센다. 텍스트 추출도
            // `frames.rs:246-250`이 여기와 같은 규칙(`text` → `message`)으로 한다.
            "system" if sub == "notification" || sub == "informational" => {}
            // ── Codex 합성 프레임(M4) ────────────────────────────────────────
            //
            // Codex에는 Claude 프레임에 **대응물이 없는 값**이 셋 있다. 억지로 Claude
            // 모양에 끼우면 그 프레임이 상태기계의 회계(모델 전환 감지·턴 활동 판정)까지
            // 건드리므로, 표시 전용 값은 전용 통로로 온다(상태기계에는 미지 subtype =
            // F21로 조용히 버려진다). 이름공간은 `ccg-engine/src/codex/mod.rs::SYNTH`.
            "system" if sub == "ccg_codex" => {
                match f.get("kind").and_then(Value::as_str).unwrap_or("") {
                    // `turn/plan/updated` — Claude의 TodoWrite 자리.
                    "todos" => out.push(json!({ "type": "todos", "runId": run,
                                                "todos": f.get("todos").cloned().unwrap_or(json!([])) })),
                    // `thread/tokenUsage/updated` — Claude의 assistant.usage 자리.
                    "context" => {
                        if let Some(t) = f.get("tokens").and_then(Value::as_u64) {
                            out.push(json!({ "type": "context", "runId": run, "contextTokens": t }));
                        }
                    }
                    // `item/completed{fileChange}` — 와이어의 unified diff를 **여기서**
                    // 디스크와 대조해 누적 전체 diff로 승격한다(2.6.2와 같은 정책).
                    // 이벤트 자체는 뒤따르는 `tool_result`가 낸다 — 거부·실패한 편집이
                    // 유령 diff를 남기지 않는다는 규약이 Claude 경로와 같아진다.
                    "file_change" => {
                        let item = s(f, "itemId").unwrap_or_default();
                        let cwd = s(f, "cwd").unwrap_or_else(|| self.cwd.clone());
                        let empty = vec![];
                        let changes = f.get("changes").and_then(Value::as_array).unwrap_or(&empty);
                        let mut made = vec![];
                        for c in changes {
                            let kind = c["kind"]["type"].as_str().unwrap_or("update");
                            let path = c.get("path").and_then(Value::as_str).unwrap_or("");
                            let diff_text = c.get("diff").and_then(Value::as_str).unwrap_or("");
                            if let Some(p) =
                                diff::codex_pending(&mut self.baselines, &cwd, path, kind, diff_text)
                            {
                                made.push(p);
                            }
                        }
                        match self.tools.get_mut(&item) {
                            Some(row) => row.pending = made,
                            // 행이 없으면(started를 못 본 판) 그 자리에서 바로 낸다 —
                            // 변경 파일 칩이 비는 것보다 낫다.
                            None => {
                                for p in made {
                                    out.push(json!({ "type": "file-change", "runId": run,
                                                     "file": p.file, "diff": p.diff, "whole": p.whole }));
                                }
                            }
                        }
                    }
                    _ => {}
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
                        // ★ 알약은 첫 progress를 기다리지 않는다 — REPLACE 목록에 나타난
                        // 순간 최소 스냅샷으로 바로 세운다. 첫 `workflow_progress`가 늦거나
                        // (짧은 워크플로는) 아예 안 오면 알약이 영영 안 떴다(2026-09-01
                        // 사용자 보고: 뜰 때도 있고 안 뜰 때도 있음). 이후 progress가 오면
                        // 그 REPLACE가 이 자리를 덮고, 정착 통지도 이 스냅샷으로 닫힌다.
                        if !self.wf_snaps.contains_key(id) {
                            let wf = json!({
                                "id": id,
                                "summary": t.get("description").and_then(Value::as_str).unwrap_or(""),
                                "status": "running", "phases": [], "agents": [],
                                "totalTokens": 0, "toolUses": 0, "durationMs": 0,
                            });
                            self.wf_snaps.insert(id.to_string(), wf.clone());
                            out.push(json!({ "type": "workflow", "runId": run, "wf": wf }));
                        }
                    } else if low.contains("bash") || low.contains("shell") {
                        next_shell.insert(id.to_string());
                        shells.push(json!({
                            "id": id, "kind": kind,
                            "description": t.get("description").and_then(Value::as_str).unwrap_or(""),
                            // 프레임이 **실제 경로**를 실어 오면 그것이 이긴다. Claude CLI의
                            // REPLACE에는 이 자리가 없어(`protocol-claude-cli.md:955-969` —
                            // task_id·task_type·description뿐) 종전대로 규칙으로 유도하지만,
                            // Codex의 테일은 `%TEMP%\ccg-codex-term-<pid>.log`라 유도 규칙이
                            // 가리키는 곳에 파일이 아예 없다(칩의 로그 열기가 빈손이 된다).
                            "outputFile": s(t, "output_file")
                                .or_else(|| bg_output_file(&self.cwd, &self.session_id, id)),
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
            // ★M9 — 앱→CLI 요청의 **응답**. R4까지 이 계열은 통째로 무시했다(상태기계가
            // `initialize`/`interrupt` 응답을 따로 소화한다). 여기서 보는 것은 딱 하나,
            // `initialize` 성공 응답의 `commands[]`다 — `/명령` 설명의 **유일한 원전**이고
            // (`system/init`의 `skills[]`는 이름뿐), 스폰당 한 번 `system/init`보다 먼저 온다.
            //
            // subtype이 아니라 **모양으로** 고른다: 워치독의 능동 프로브(`probe-<pid>`)도
            // 같은 `initialize`라 request_id는 못 믿고, `reload_plugins` 응답도 같은 키에
            // 같은 뜻의 목록을 싣는다(`SDKControlReloadPluginsResponse`). 모양이 맞으면 받는다.
            "control_response" => {
                if self.read_commands(f.pointer("/response/response/commands")) {
                    out.extend(self.tooling_event());
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
        // 워크플로는 셸 칩 목록에 안 들어가고(전용 표시), 대신 알약 스냅샷이 즉시 선다.
        assert_eq!(types(&a), vec!["workflow", "bg-tasks"]);
        assert_eq!(a[0]["wf"]["id"], "w1");
        assert_eq!(a[0]["wf"]["status"], "running");
        assert_eq!(a[0]["wf"]["summary"], "wf");
        let tasks = a[1]["tasks"].as_array().unwrap();
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

    /// ★R2 — Codex의 셸 칩은 테일 파일이 `%TEMP%\ccg-codex-term-<pid>.log`다.
    /// Claude의 유도 규칙(`%TEMP%\claude\…\tasks\<id>.output`)을 그대로 쓰면 **없는 파일**을
    /// 가리켜 칩의 '로그 열기'가 빈손이 된다. 프레임이 실제 경로를 실어 오면 그것이 이긴다.
    #[test]
    fn a_task_that_carries_its_own_output_file_wins_over_the_derived_path() {
        let mut w = wire();
        w.translate(&json!({ "type": "system", "subtype": "init", "session_id": "S1", "cwd": "C:\\w" }));
        let a = w.translate(&json!({
            "type": "system", "subtype": "background_tasks_changed",
            "tasks": [{ "task_id": "p9", "task_type": "unified_exec_shell", "description": "npm run dev",
                        "output_file": "C:\\Temp\\ccg-codex-term-p9.log" }]
        }));
        assert_eq!(a[0]["tasks"][0]["outputFile"], "C:\\Temp\\ccg-codex-term-p9.log");
        // Claude의 REPLACE에는 그 자리가 없다(protocol-claude-cli.md:955-969) → 유도 규칙 그대로.
        let b = w.translate(&json!({
            "type": "system", "subtype": "background_tasks_changed",
            "tasks": [{ "task_id": "t1", "task_type": "local_bash", "description": "빌드" }]
        }));
        assert!(b[0]["tasks"][0]["outputFile"].as_str().unwrap().ends_with("t1.output"));
    }

    /// ★R2 — `system/notification`은 **여기서 옮기지 않는다**(상태기계의 F18 한 곳만).
    /// 두 경로가 살아 있으면 화면에 정확히 두 배로 찍힌다(크리틱 m4-r1 §4.6: 9회 → 18줄).
    #[test]
    fn a_notification_frame_is_not_translated_here() {
        let mut w = wire();
        let a = w.translate(&json!({ "type": "system", "subtype": "notification", "text": "재시도 중" }));
        assert!(a.is_empty(), "셸이 또 옮기면 안내가 두 배로 나간다: {a:?}");
        let b = w.translate(&json!({ "type": "system", "subtype": "informational", "message": "안내" }));
        assert!(b.is_empty());
    }

    /// 첫 progress가 아예 없는 짧은 워크플로 — 알약이 REPLACE에서 서고 통지에서 닫힌다
    /// (2026-09-01 사용자 보고: progress 도착 여부에 따라 알약이 뜰 때도 안 뜰 때도 있었다).
    #[test]
    fn a_workflow_without_progress_still_gets_a_pill_and_settles() {
        let mut w = wire();
        let a = w.translate(&json!({
            "type": "system", "subtype": "background_tasks_changed",
            "tasks": [{ "task_id": "w1", "task_type": "local_workflow", "description": "덧셈 스모크" }]
        }));
        assert_eq!(types(&a), vec!["workflow", "bg-tasks"]);
        assert_eq!(a[0]["wf"]["summary"], "덧셈 스모크");
        // 같은 목록의 재통지가 알약을 두 번 세우지 않는다(스냅샷 있으면 침묵)
        let again = w.translate(&json!({
            "type": "system", "subtype": "background_tasks_changed",
            "tasks": [{ "task_id": "w1", "task_type": "local_workflow", "description": "덧셈 스모크" }]
        }));
        assert_eq!(types(&again), vec!["bg-tasks"]);
        // progress 한 번 없이 곧장 통지 — 알약이 completed로 닫힌다
        let done = w.translate(&json!({
            "type": "system", "subtype": "task_notification",
            "task_id": "w1", "status": "completed", "summary": "합 17109"
        }));
        let wf = done.iter().find(|e| e["type"] == "workflow").expect("정착 이벤트");
        assert_eq!(wf["wf"]["status"], "completed");
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
    fn skill_and_workflow_rows_carry_a_target_beside_the_verb() {
        // 대상이 비면 행이 「동사 …(공백)… 결과」로 갈라진다(2026-09-01 사용자 보고)
        assert_eq!(tool_target(&json!({ "skill": "workflow-authoring" })), "workflow-authoring");
        assert_eq!(tool_target(&json!({ "name": "deep-research", "args": {} })), "deep-research");
        // 인라인 대본 — meta 리터럴의 name을 집는다 (따옴표 세 종 모두)
        let script = "export const meta = {\n  name: 'smoke-test',\n  description: 'x'\n}\nreturn 1";
        assert_eq!(tool_target(&json!({ "script": script })), "smoke-test");
        assert_eq!(script_meta_name("export const meta = { name: \"a-b\" }"), Some("a-b".into()));
        assert_eq!(script_meta_name("no meta here"), None);
        // description/prompt가 있는 도구(Agent 등)는 그쪽이 우선 — name이 가리지 않는다
        assert_eq!(tool_target(&json!({ "description": "리뷰", "name": "critic" })), "리뷰");
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

    // ── Codex(M4) — 옮김기가 낸 프레임이 2.6.2 EngineEvent가 되는가 ─────────────
    //
    // 입력 JSON은 손으로 쓴 것이 아니라 `ccg-engine`의 옮김기가 실제로 내는 모양이다
    // (`crates/ccg-engine/tests/codex_replay.rs`가 같은 값을 단언한다). 여기서 재는 것은
    // **그 프레임이 화면 이벤트가 되는가**뿐이다.

    #[test]
    fn codex_frames_become_the_same_engine_events_as_claude() {
        let mut w = wire();
        // system/init — threadId가 session_id 자리에 온다
        let evs = w.translate(&json!({ "type": "system", "subtype": "init", "session_id": "th-1",
                                       "model": "gpt-5.6-terra", "cwd": "C:\\w", "tools": [],
                                       "apiKeySource": "none" }));
        assert_eq!(evs[0]["type"], "session");
        assert_eq!(evs[0]["sessionId"], "th-1");
        assert_eq!(evs[0]["model"], "gpt-5.6-terra");

        // reasoning → thinking, agentMessage 델타 → 생각 줄 정리 + 스트리밍
        let evs = w.translate(&json!({ "type": "stream_event", "event": { "type": "content_block_delta",
            "delta": { "type": "thinking_delta", "thinking": "무엇부터 할지 고르는 중" } } }));
        assert_eq!(types(&evs), vec!["thinking"]);
        w.translate(&json!({ "type": "stream_event", "event": {
            "type": "content_block_start", "content_block": { "type": "text" } } }));
        let evs = w.translate(&json!({ "type": "stream_event", "event": { "type": "content_block_delta",
            "delta": { "type": "text_delta", "text": "안녕" } } }));
        assert_eq!(types(&evs), vec!["thinking-clear", "status", "assistant-stream"]);
        let evs = w.translate(&json!({ "type": "assistant", "message": { "content": [
            { "type": "text", "text": "안녕하세요" }] } }));
        assert_eq!(evs[0]["type"], "assistant-done");
        assert_eq!(evs[0]["text"], "안녕하세요");

        // commandExecution → Bash 행 + 터미널 줄
        let evs = w.translate(&json!({ "type": "assistant", "message": { "content": [
            { "type": "tool_use", "id": "i1", "name": "Bash", "input": { "command": "cargo test" } }] } }));
        assert_eq!(types(&evs), vec!["tool-start", "terminal"]);
        assert_eq!(evs[0]["tool"]["kind"], "bash");
        let evs = w.translate(&json!({ "type": "user", "message": { "content": [
            { "type": "tool_result", "tool_use_id": "i1", "is_error": false, "content": "55 passed" }] } }));
        assert!(types(&evs).contains(&"tool-end".to_string()));

        // turn/plan/updated → 할 일 패널
        let evs = w.translate(&json!({ "type": "system", "subtype": "ccg_codex", "kind": "todos",
            "todos": [{ "id": "cxtodo-0", "label": "고치기", "status": "running" }] }));
        assert_eq!(evs[0]["type"], "todos");
        assert_eq!(evs[0]["todos"][0]["status"], "running");

        // tokenUsage → 컨텍스트 게이지
        let evs = w.translate(&json!({ "type": "system", "subtype": "ccg_codex", "kind": "context",
                                       "tokens": 540, "window": 272000 }));
        assert_eq!(evs[0]["type"], "context");
        assert_eq!(evs[0]["contextTokens"], 540);

        // result — modelUsage가 토큰 표를, usage.input_tokens가 게이지를 먹인다
        let evs = w.translate(&json!({ "type": "result", "subtype": "success", "is_error": false,
            "result": "", "duration_ms": 4242, "num_turns": 1,
            "usage": { "input_tokens": 540, "output_tokens": 0,
                       "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0 },
            "modelUsage": { "gpt-5.6-terra": { "inputTokens": 400, "outputTokens": 40,
                            "cacheReadInputTokens": 100, "cacheCreationInputTokens": 0,
                            "contextWindow": 272000 } } }));
        let r = &evs[0];
        assert_eq!(r["type"], "result");
        assert_eq!(r["contextTokens"], 540);
        assert_eq!(r["contextWindow"], 272000);
        assert_eq!(r["tokenUsage"][0]["model"], "gpt-5.6-terra", "codex 모델 id는 그대로 표시된다");
        assert_eq!(r["tokenUsage"][0]["inTok"], 400);
        assert_eq!(r["tokenUsage"][0]["cacheRead"], 100);
    }

    #[test]
    fn a_codex_file_change_becomes_a_whole_file_diff_against_the_run_baseline() {
        let dir = std::env::temp_dir().join(format!("ccg-m4-wire-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join("a.txt");
        // Codex는 **적용을 마친 뒤** 훙크를 보낸다 — 디스크가 '적용 후'다.
        std::fs::write(&file, "one\nTWO\nthree\n").unwrap();

        let mut w = wire();
        w.translate(&json!({ "type": "system", "subtype": "init", "session_id": "th-1",
                             "cwd": dir.to_string_lossy(), "tools": [] }));
        w.translate(&json!({ "type": "assistant", "message": { "content": [
            { "type": "tool_use", "id": "i2", "name": "codex_file_change",
              "input": { "file_path": "a.txt" } }] } }));
        let evs = w.translate(&json!({ "type": "system", "subtype": "ccg_codex", "kind": "file_change",
            "itemId": "i2", "cwd": dir.to_string_lossy(),
            "changes": [{ "path": "a.txt", "kind": { "type": "update" },
                          "diff": "@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n" }] }));
        assert!(evs.is_empty(), "변경은 tool_result가 성공을 확인한 뒤에 나간다");

        let evs = w.translate(&json!({ "type": "user", "message": { "content": [
            { "type": "tool_result", "tool_use_id": "i2", "is_error": false, "content": "" }] } }));
        let fc = evs.iter().find(|e| e["type"] == "file-change").expect("file-change");
        assert_eq!(fc["file"]["path"], "a.txt");
        assert_eq!(fc["whole"], true, "훙크 조각이 아니라 파일 한 장");
        assert_eq!(fc["file"]["add"], 1);
        assert_eq!(fc["file"]["del"], 1);
        // 역적용으로 복원한 기준선("two")이 좌변이다 — 전체가 변경으로 칠해지지 않는다.
        let lines = fc["diff"]["lines"].as_array().unwrap();
        assert_eq!(lines.len(), 4, "ctx 2 + del 1 + add 1: {lines:?}");
        let end = evs.iter().find(|e| e["type"] == "tool-end").unwrap();
        assert_eq!(end["result"], "+1 −1");

        // 같은 런에서 같은 파일을 또 고치면 **런 기준선 대비 누적**이다.
        std::fs::write(&file, "one\nTWO\nTHREE\n").unwrap();
        w.translate(&json!({ "type": "assistant", "message": { "content": [
            { "type": "tool_use", "id": "i3", "name": "codex_file_change",
              "input": { "file_path": "a.txt" } }] } }));
        w.translate(&json!({ "type": "system", "subtype": "ccg_codex", "kind": "file_change",
            "itemId": "i3", "cwd": dir.to_string_lossy(),
            "changes": [{ "path": "a.txt", "kind": { "type": "update" },
                          "diff": "@@ -3 +3 @@\n-three\n+THREE\n" }] }));
        let evs = w.translate(&json!({ "type": "user", "message": { "content": [
            { "type": "tool_result", "tool_use_id": "i3", "is_error": false, "content": "" }] } }));
        let fc = evs.iter().find(|e| e["type"] == "file-change").unwrap();
        assert_eq!(fc["file"]["add"], 2, "두 번째 편집도 런 원본 대비(+2 −2)");
        assert_eq!(fc["file"]["del"], 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_declined_codex_edit_leaves_no_ghost_diff() {
        let mut w = wire();
        w.translate(&json!({ "type": "assistant", "message": { "content": [
            { "type": "tool_use", "id": "i9", "name": "codex_file_change",
              "input": { "file_path": "x.txt" } }] } }));
        // 거절된 변경은 옮김기가 애초에 합성 프레임을 안 낸다 — 행만 오류로 닫힌다.
        let evs = w.translate(&json!({ "type": "user", "message": { "content": [
            { "type": "tool_result", "tool_use_id": "i9", "is_error": true, "content": "적용 안 됨" }] } }));
        assert!(!types(&evs).contains(&"file-change".to_string()));
        let end = evs.iter().find(|e| e["type"] == "tool-end").unwrap();
        assert_eq!(end["status"], "error");
    }

    // ── M9: 도구 환경(MCP·스킬) ────────────────────────────────────────────
    // 아래 프레임은 전부 `scripts/poc-mcpskill.mjs`가 실 CLI 2.1.239에서 뜬 모양 그대로다
    // (`%TEMP%\ccg-mcpskill\frames.B.noauth.jsonl`). 지어낸 필드는 없다.

    /// 실 CLI가 보내는 순서 그대로 — `initialize` 응답이 `system/init`보다 **먼저** 온다.
    fn init_pair() -> (Value, Value) {
        let resp = json!({ "type": "control_response", "response": {
            "subtype": "success", "request_id": "init-1", "response": { "commands": [
                { "name": "beta-probe", "description": "B 픽스처 전용 스킬 (project)", "argumentHint": "" },
                { "name": "gamma", "description": "개인 스킬 (user)", "argumentHint": "" },
                { "name": "dataviz", "description": "차트를 그린다", "argumentHint": "" },
                { "name": "deep-research", "description": "리서치 하네스 (dynamic workflow)", "argumentHint": "" },
                { "name": "model", "description": "모델 바꾸기", "argumentHint": "" }
            ] } } });
        let init = json!({ "type": "system", "subtype": "init", "session_id": "S1", "cwd": "C:\\B",
            "tools": ["Bash", "mcp__ccg-probe-b__echo", "mcp__ccg-probe-b__ping", "Write"],
            "mcp_servers": [{ "name": "ccg-probe-b", "status": "connected" },
                            { "name": "ccg-broken-b", "status": "failed" }],
            "skills": ["beta-probe", "gamma", "dataviz", "deep-research"],
            "plugins": [{ "name": "clangd-lsp", "path": "C:\\p", "version": "1.0.0" }] });
        (resp, init)
    }

    #[test]
    fn init_carries_the_chats_mcp_and_skill_snapshot() {
        let mut w = wire();
        let (resp, init) = init_pair();
        // 커맨드 응답만으로는 아직 아무것도 안 낸다 — `system/init`을 못 봤으면 "미지"다.
        assert!(w.translate(&resp).is_empty(), "init 전 커맨드 응답은 스냅샷을 못 만든다");
        let evs = w.translate(&init);
        let t = evs.iter().find(|e| e["type"] == "tooling").expect("tooling 이벤트");
        let tl = &t["tooling"];
        assert_eq!(tl["cwd"], "C:\\B");
        // MCP — 이름·상태 그대로 + 그 서버가 붙인 도구를 `init.tools`에서 갈라낸 것.
        assert_eq!(tl["mcp"][0]["name"], "ccg-probe-b");
        assert_eq!(tl["mcp"][0]["status"], "connected");
        assert_eq!(tl["mcp"][0]["tools"], json!(["echo", "ping"]));
        // 실패한 서버도 **행이 남는다**(사라지면 "왜 안 붙었지"를 화면에서 물을 수 없다).
        assert_eq!(tl["mcp"][1]["name"], "ccg-broken-b");
        assert_eq!(tl["mcp"][1]["status"], "failed");
        assert_eq!(tl["mcp"][1]["tools"], json!([]));
        // 스킬 — 이름은 init, 설명은 커맨드 사전. 스코프 꼬리는 떼어 `scope`로.
        assert_eq!(tl["skills"][0], json!({ "name": "beta-probe", "description": "B 픽스처 전용 스킬", "scope": "project" }));
        assert_eq!(tl["skills"][1]["scope"], "user");
        assert_eq!(tl["skills"][2], json!({ "name": "dataviz", "description": "차트를 그린다", "scope": null }));
        // 스킬이 아닌 꼬리(`(dynamic workflow)`)는 **안 떼어낸다** — 닫힌 집합만 스코프다.
        assert_eq!(tl["skills"][3]["description"], "리서치 하네스 (dynamic workflow)");
        assert_eq!(tl["skills"][3]["scope"], Value::Null);
        // `/model` 같은 내장 커맨드는 스킬이 아니므로 목록에 없다(init.skills가 기준).
        assert_eq!(tl["skills"].as_array().unwrap().len(), 4);
        assert_eq!(tl["plugins"][0], json!({ "name": "clangd-lsp", "version": "1.0.0" }));
    }

    #[test]
    fn a_mid_session_commands_push_refreshes_the_snapshot() {
        let mut w = wire();
        let (resp, init) = init_pair();
        w.translate(&resp);
        w.translate(&init);
        // 세션 중간에 커맨드 목록이 바뀐다(하위 폴더의 `.claude/skills` 발견 등).
        let evs = w.translate(&json!({ "type": "system", "subtype": "commands_changed", "commands": [
            { "name": "beta-probe", "description": "설명이 바뀌었다 (project)", "argumentHint": "" }
        ] }));
        let tl = &evs.iter().find(|e| e["type"] == "tooling").expect("tooling 재방출")["tooling"];
        assert_eq!(tl["skills"][0]["description"], "설명이 바뀌었다");
        // REPLACE라 사전에서 빠진 이름은 설명을 잃는다 — 그래도 **행은 남는다**
        // (스킬이 있다는 사실이 설명보다 먼저다).
        assert_eq!(tl["skills"][2]["name"], "dataviz");
        assert_eq!(tl["skills"][2]["description"], "");
        // MCP 쪽은 init이 진실이라 그대로다.
        assert_eq!(tl["mcp"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn the_next_turns_handshake_does_not_flash_the_previous_turns_environment() {
        // ★실측(`poc-mcpskill.mjs --app`): 이 앱은 **턴마다 CLI를 다시 띄운다**
        // (2턴 주행 = `system/init` 3장). 그래서 2턴째의 `initialize` 응답이 그 턴의
        // `system/init`보다 먼저 오고, 그 순간 `env`는 아직 **지난 턴 것**이다.
        // 같은 사전이면 아무 말도 하지 않아야 한다 — 안 그러면 매 턴 낡은 목록이
        // 한 번 스쳤다가 덮인다(폴더를 바꾼 턴에서는 남의 폴더 목록이 스친다).
        let mut w = wire();
        let (resp, init) = init_pair();
        w.translate(&resp);
        w.translate(&init);
        assert!(
            w.translate(&resp).iter().all(|e| e["type"] != "tooling"),
            "같은 커맨드 사전을 다시 받으면 스냅샷을 다시 내지 않는다"
        );
        // 사전이 **진짜로** 바뀐 핸드셰이크는 여전히 말한다(하위 폴더 스킬 발견 등).
        let mut grown = resp.clone();
        grown["response"]["response"]["commands"]
            .as_array_mut()
            .unwrap()
            .push(json!({ "name": "beta-probe", "description": "설명이 바뀌었다 (project)" }));
        assert!(
            w.translate(&grown).iter().any(|e| e["type"] == "tooling"),
            "사전이 바뀌면 스냅샷을 다시 낸다"
        );
    }

    #[test]
    fn mcp_tool_prefix_matches_the_normalized_server_name() {
        // 실측 규칙: 접두사의 서버 이름은 비 `[A-Za-z0-9_-]`가 `_`로 바뀐 것이다.
        // 설정 이름은 점을 갖고 있어도 되고, 그때도 도구가 그 행에 붙어야 한다.
        let mut w = wire();
        let evs = w.translate(&json!({ "type": "system", "subtype": "init", "session_id": "S", "cwd": "C:\\w",
            "tools": ["mcp__my_co_tools__search"],
            "mcp_servers": [{ "name": "my.co tools", "status": "connected" }],
            "skills": [] }));
        let tl = &evs.iter().find(|e| e["type"] == "tooling").unwrap()["tooling"];
        assert_eq!(tl["mcp"][0]["name"], "my.co tools", "표시는 설정된 이름 그대로");
        assert_eq!(tl["mcp"][0]["tools"], json!(["search"]), "도구는 정규화 이름으로 되맞춘다");
    }

    /// ★R2 — 크리틱이 실 CLI(0.3.241)에서 읽어 온 접두사 5종을 그대로 못 박는다.
    /// R1의 `chars()` 규칙은 비BMP에서 갈라졌다(`emoji🚀srv` → 실 CLI `mcp__emoji__srv__`
    /// vs R1 기대 `mcp__emoji_srv__`). 이 표가 깨지면 그 서버의 도구가 조용히 사라진다.
    #[test]
    fn mcp_prefix_counts_utf16_units_like_the_cli_does() {
        let cases = [
            ("my.co tools", "mcp__my_co_tools__search", "search"),
            ("srv__dbl", "mcp__srv__dbl__ping", "ping"),
            ("한글서버", "mcp________echo", "echo"), // BMP 4자 = `_` 4개
            ("UPPER-Case", "mcp__UPPER-Case__go", "go"),
            ("emoji🚀srv", "mcp__emoji__srv__fire", "fire"), // 서로게이트 쌍 = `_` 2개
        ];
        for (name, tool_id, tool) in cases {
            let mut w = wire();
            let evs = w.translate(&json!({ "type": "system", "subtype": "init", "session_id": "S", "cwd": "C:\\w",
                "tools": [tool_id], "mcp_servers": [{ "name": name, "status": "connected" }], "skills": [] }));
            let tl = &evs.iter().find(|e| e["type"] == "tooling").unwrap()["tooling"];
            assert_eq!(tl["mcp"][0]["tools"], json!([tool]), "{name} ← {tool_id}");
        }
        // 정규화를 **안 거친** 접두사가 와도 같은 행에 붙는다(양쪽 정규화 · 멱등).
        let mut w = wire();
        let evs = w.translate(&json!({ "type": "system", "subtype": "init", "session_id": "S", "cwd": "C:\\w",
            "tools": ["mcp__Ω_유니코드_🚀__hello"],
            "mcp_servers": [{ "name": "Ω 유니코드 🚀", "status": "connected" }], "skills": [] }));
        let tl = &evs.iter().find(|e| e["type"] == "tooling").unwrap()["tooling"];
        assert_eq!(tl["mcp"][0]["tools"], json!(["hello"]), "원문 접두사도 되맞춘다");
    }

    #[test]
    fn a_server_turned_off_in_settings_still_gets_a_row() {
        // ★실측: `deniedMcpServers`/`skillOverrides:'off'`를 실으면 그 항목은
        // `system/init`에서 **행째로 사라진다**(`status:"disabled"`로 오지 않는다).
        // 되붙이지 않으면 "내가 껐다"와 "설정에 아예 없다"가 화면에서 같은 얼굴이 된다.
        let mut w = wire();
        let (resp, init) = init_pair();
        w.translate(&resp);
        w.translate(&init);
        let denied: BTreeSet<String> = ["ccg-off-server".to_string()].into_iter().collect();
        let off: BTreeSet<String> = ["gamma".to_string(), "dataviz".to_string()].into_iter().collect();
        assert!(w.set_policy(&denied, &off), "정책이 바뀌면 스냅샷을 다시 낸다");
        let tl = &w.tooling().expect("스냅샷")["tooling"];
        let mcp = tl["mcp"].as_array().unwrap();
        assert_eq!(mcp.len(), 3, "붙은 둘 + 끈 하나");
        assert_eq!(mcp[2], json!({ "name": "ccg-off-server", "status": "off", "tools": [] }));
        assert_eq!(mcp[0]["name"], "ccg-probe-b", "끈 행은 **꼬리에** 붙는다");
        // `dataviz`는 껐다고 적혔지만 init에 **살아 있다**(재스폰 전 낡은 정책) —
        // 그때는 와이어가 이긴다. 유령 off 행을 만들지 않는다.
        let skills = tl["skills"].as_array().unwrap();
        assert_eq!(skills.iter().filter(|s| s["name"] == "dataviz").count(), 1);
        assert!(skills.iter().find(|s| s["name"] == "dataviz").unwrap().get("off").is_none());
        // `gamma`는 init에도 있어 같은 규칙 — 이 픽스처엔 없는 이름을 하나 더 끈다.
        let off2: BTreeSet<String> = ["없는스킬".to_string()].into_iter().collect();
        assert!(w.set_policy(&BTreeSet::new(), &off2));
        let tl = &w.tooling().unwrap()["tooling"];
        let last = tl["skills"].as_array().unwrap().last().unwrap();
        assert_eq!(last["name"], "없는스킬");
        assert_eq!(last["off"], true);
        // 같은 정책을 또 주면 아무 일도 없다 — 허브가 매 tick 부르므로 이게 없으면
        // 20ms마다 REPLACE가 나간다.
        assert!(!w.set_policy(&BTreeSet::new(), &off2), "같은 정책은 재방출하지 않는다");
    }

    #[test]
    fn a_chat_with_no_mcp_reports_an_empty_list_not_silence() {
        // "MCP 없음"과 "아직 모른다"는 다른 말이다. init을 봤으면 빈 배열을 **낸다**.
        let mut w = wire();
        let evs = w.translate(&json!({ "type": "system", "subtype": "init", "session_id": "S", "cwd": "C:\\w",
            "tools": ["Bash"], "mcp_servers": [], "skills": [] }));
        let tl = &evs.iter().find(|e| e["type"] == "tooling").expect("빈 환경도 스냅샷을 낸다")["tooling"];
        assert_eq!(tl["mcp"], json!([]));
        assert_eq!(tl["skills"], json!([]));
    }
}
