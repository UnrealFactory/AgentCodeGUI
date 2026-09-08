//! **Codex 엔진(`codex app-server`)** — 2.6.2 `src/main/codex/engine.ts`의 3.0 이식.
//!
//! ## 왜 "드라이버"인가 (설계 결정 하나로 요약)
//!
//! m-logic §3.1은 상태기계를 **한 벌**로 둔다. Codex를 얹는 방법은 둘이었다:
//!
//! | | 방법 | 대가 |
//! |---|---|---|
//! | (a) | `frames.rs`에 Codex 분류기를 더하고 `runtime.rs`를 엔진별로 분기 | 60전이 표·97 재생 시나리오가 걸린 파일이 두 갈래가 된다. 「Codex일 때만 나는 버그」의 서식지 |
//! | (b) | **`CliDriver`를 하나 더 구현하고 와이어를 그 안에서 옮긴다** | 상태기계·원장·정체성·큐·한도는 **한 글자도 안 바뀐다** |
//!
//! (b)를 골랐다. `CliDriver`(`driver.rs`)는 이미 상태기계와 프로세스 사이의 **유일한**
//! 통로다 — 그 좁은 목에서 JSON-RPC ↔ Claude 프레임을 옮기면, 위층에게 Codex는
//! "조금 다른 CLI"일 뿐이다. 그래서 이 모듈이 지는 짐이 정확히 하나다:
//!
//! > **들어오는 것**: `codex app-server`의 JSON-RPC(JSONL) → 상태기계가 아는 프레임
//! > **나가는 것**: 상태기계의 컨트롤 봉투(`initialize`·`user`·`control_response`·
//! >   `interrupt`·`stop_task`) → `codex app-server`의 JSON-RPC 요청
//!
//! 옮김표 전체는 [`FRAME_MAP`]에 데이터로 있고(테스트가 그 표를 커버리지로 센다),
//! 옮기는 코드는 [`transcode::Transcoder`](순수)에, 프로세스·파이프는
//! [`driver::CodexDriver`]에 있다.
//!
//! ## 출처
//!
//! 이 모듈의 와이어 지식은 **전부 2.6.2 코드에서 왔다**(줄 번호 표기 = `src/main/codex/`).
//! 실 계정이 없어(M5 실측: 실홈 `codex-accounts.json` 계정 0건) 라이브로 재확인할 수
//! 없는 항목은 표의 「출처」열에 `engine.ts:NNN`으로 남긴다 — 추측한 자리는 없다.

pub mod driver;
pub mod transcode;
pub mod tooling;
pub mod versions;

pub use driver::CodexDriver;
pub use transcode::{Egress, Transcoder};

use crate::identity::{EffortId, EngineAxis, ModeId, RunIdentity};
use serde_json::{json, Value};

/// 우리 합성 프레임의 **단일 이름공간**. 상태기계에게는 미지 `system` 서브타입이라
/// F21(조용히 버림)로 떨어지고, 셸의 `wire.rs`만 이 이름을 읽는다.
///
/// 왜 이런 것이 필요한가: Codex에는 Claude 프레임에 **대응물이 없는 값**이 셋 있다 —
/// ① `fileChange`의 unified diff(Claude는 도구 입력에서 우리가 diff를 만든다)
/// ② `turn/plan/updated`(Claude는 `TodoWrite` 도구 호출)
/// ③ `thread/tokenUsage/updated`(Claude는 `assistant.message.usage`).
/// 억지로 Claude 모양에 끼워 넣으면 그 프레임이 상태기계의 회계(모델 전환 감지·
/// 턴 활동 판정)까지 건드린다. 그래서 **표시 전용 값은 표시 전용 통로로** 보낸다.
pub const SYNTH: &str = "ccg_codex";

/// Optional app overrides. Absent fields leave Codex's config/model defaults intact.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ContextOverrides {
    pub management: Option<bool>,
    pub window: Option<u64>,
    pub compact: Option<u64>,
}

/// `thread/start`·`thread/resume`의 config 오버라이드 (2.6.2 `engine.ts:53-56` 실측 0.144.4).
///
/// - `tools.experimental_request_user_input`: 빈 맵이어야 한다(**boolean은 거절됨**).
/// - `features.default_mode_request_user_input`: Default 모드 라우터가
///   "unavailable in Default mode"로 막는 것을 푼다.
/// - `features.unified_exec`: 명령을 PTY 세션으로 — 안 끝나는 명령이 턴을 막지 않는다.
/// - `suppress_unstable_features_warning`(★2026-09-05): 위 features가 「Under-development features
///   enabled … To suppress this warning, set suppress_unstable_features_warning = true」 `warning`
///   알림(0.153 실측)을 매 스레드마다 내고 그게 채팅에 안내 카드로 앉았다. 같은 config 오버라이드에
///   실으면 그 알림이 안 온다(app-server thread/start 직접 실측 — 있으면 warning 0건).
pub fn thread_config(add_dirs: &[String]) -> Value {
    let mut c = json!({
        "tools": { "experimental_request_user_input": {} },
        "features": { "default_mode_request_user_input": true, "unified_exec": true },
        "suppress_unstable_features_warning": true
    });
    if !add_dirs.is_empty() {
        // Codex에는 `--add-dir`이 없다 — workspace-write 샌드박스의 쓰기 루트로 얹는다
        // (읽기는 원래 전역 허용). 모델에게 알리는 쪽은 developerInstructions가 맡는다.
        c["sandbox_workspace_write"] = json!({ "writable_roots": add_dirs });
    }
    c
}

/// 스폰 시점에 굳는 Codex 실행 계획. `SpawnSpec`이 이 값을 실어 나른다 —
/// **정체성만으로 결정된다**(Claude의 `argv`와 같은 지위).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CodexPlan {
    pub model: String,
    /// 이미 사다리를 탄 codex reasoning effort 문자열.
    pub effort: String,
    /// `untrusted` | `on-request` | `never`
    pub approval_policy: String,
    /// `read-only` | `workspace-write` | `danger-full-access`
    pub sandbox: String,
    pub cwd: String,
    pub add_dirs: Vec<String>,
    pub developer_instructions: Option<String>,
    /// 이어 갈 threadId(`thread/resume`) — 없으면 `thread/start`.
    pub resume: Option<String>,
    /// 원본을 이어쓰지 않고 새 thread id로 분기합니다(/btw 첫 질문).
    pub fork_session: bool,
    /// API 키 모드(과금 경로 표시용 — `result.viaApi`).
    pub api_mode: bool,
    /// ★O4 — 이 실행이 소비할 OpenAI 계정(정규화가 기본 계정으로 접어 준 값).
    /// 격리 `CODEX_HOME` 물질화는 **셸**이 한다(`ccg-auth`가 auth.json·정션을 만든다) —
    /// 엔진 크레이트는 계정 스토어를 모른다.
    pub account: Option<String>,
    /// ★2026-09-05 — 속도 티어 id(app-server `serviceTier` · 실측 `"priority"` = Fast).
    /// `None` = 표준(파라미터를 싣지 않는다 — 서버 기본). `thread/start`·`thread/resume`·
    /// `turn/start` 셋에 다 싣는다: 스레드 값이 바뀌어도(TUI /fast 등) 우리 정체성이 이긴다.
    pub service_tier: Option<String>,
    pub context: ContextOverrides,
}

impl CodexPlan {
    pub fn thread_params(&self) -> Value {
        let mut p = json!({
            "cwd": self.cwd,
            "model": self.model,
            "approvalPolicy": self.approval_policy,
            "sandbox": self.sandbox,
            "config": thread_config(&self.add_dirs),
        });
        if let Some(enabled) = self.context.management {
            p["config"]["features"]["context_management"] = json!({ "experimental_mode": enabled });
        }
        if let Some(window) = self.context.window {
            p["config"]["model_context_window"] = json!(window);
        }
        if let Some(compact) = self.context.compact {
            p["config"]["model_auto_compact_token_limit"] = json!(compact);
        }
        if let Some(d) = &self.developer_instructions {
            p["developerInstructions"] = json!(d);
        }
        if let Some(t) = &self.service_tier {
            p["serviceTier"] = json!(t);
        }
        p
    }
}

/// picker `EffortId` → Codex reasoning effort (2.6.2 `codexEffort`, `engine.ts:64-72`).
///
/// `supported`는 `model/list`가 준 목록이다. 3.0 드라이버는 **스폰 시점에 그 목록이
/// 없다**(모델 목록 조회는 네트워크·인증이 필요하고 스폰을 그만큼 늦춘다) — 그래서
/// `None`으로 부르면 2.6.2가 목록 조회에 실패했을 때와 **같은 값**이 나온다.
pub fn codex_effort(effort: EffortId, supported: Option<&[String]>) -> String {
    let want = match effort {
        // minimal은 Codex에 없다 — 2.6.2와 같이 low로 접는다.
        EffortId::Minimal => "low",
        e => crate::driver::effort_str(e),
    };
    let Some(sup) = supported else { return want.to_string() };
    if sup.iter().any(|s| s == want) {
        return want.to_string();
    }
    const LADDER: [&str; 5] = ["max", "xhigh", "high", "medium", "low"];
    let from = LADDER.iter().position(|l| *l == want).unwrap_or(0);
    for e in &LADDER[from..] {
        if sup.iter().any(|s| s == *e) {
            return (*e).to_string();
        }
    }
    sup.last().cloned().unwrap_or_else(|| "medium".to_string())
}

/// picker `ModeId` → (approvalPolicy, sandbox) (2.6.2 `codexPolicy`, `engine.ts:75-92`).
pub fn codex_policy(m: ModeId) -> (&'static str, &'static str) {
    match m {
        // 플랜 대응: 읽기 전용 샌드박스 — 계획/분석만.
        ModeId::Plan => ("on-request", "read-only"),
        // 워크스페이스 안 편집은 자동, 그 밖(네트워크·바깥 경로)은 요청 시 승인.
        ModeId::AcceptEdits => ("on-request", "workspace-write"),
        ModeId::Auto => ("never", "workspace-write"),
        ModeId::Bypass => ("never", "danger-full-access"),
        ModeId::Normal => ("untrusted", "workspace-write"),
    }
}

/// 참조 폴더 안내문 — Codex에는 `--add-dir`이 없어 **모델에게 말로** 알린다
/// (2.6.2 `engine.ts:1553-1562`). 채팅 시스템 프롬프트가 있으면 그 앞에 붙는다.
pub fn developer_instructions(system_prompt: Option<&str>, add_dirs: &[String]) -> Option<String> {
    let mut notes: Vec<String> = vec![];
    if let Some(p) = system_prompt.map(str::trim).filter(|p| !p.is_empty()) {
        notes.push(p.to_string());
    }
    if !add_dirs.is_empty() {
        let list = add_dirs
            .iter()
            .map(|p| format!("- {p}"))
            .collect::<Vec<_>>()
            .join("\n");
        notes.push(format!(
            "[참조 폴더] 작업 폴더 외에 아래 폴더도 함께 사용할 수 있다 (읽기·수정 허용):\n{list}"
        ));
    }
    if notes.is_empty() {
        None
    } else {
        Some(notes.join("\n\n"))
    }
}

/// 정체성 → 실행 계획. Claude의 [`crate::driver::build_spawn_spec`]와 **같은 자리**의 함수다.
pub fn build_plan(id: &RunIdentity, resume: Option<&str>) -> CodexPlan {
    let (model, effort) = match id.engine() {
        EngineAxis::Codex { model, effort, .. } => (model.clone(), *effort),
        EngineAxis::Claude { model, effort } => (model.clone(), *effort),
    };
    let (approval_policy, sandbox) = codex_policy(id.mode());
    let add_dirs: Vec<String> = id.add_dirs().iter().map(|d| d.as_str().to_string()).collect();
    CodexPlan {
        // 2.6.2 `engine.ts:1564` — 빈 모델의 폴백.
        model: if model.is_empty() { "gpt-5.6-terra".into() } else { model },
        effort: codex_effort(effort, None),
        approval_policy: approval_policy.into(),
        sandbox: sandbox.into(),
        cwd: id.cwd().as_str().to_string(),
        developer_instructions: developer_instructions(id.system_prompt(), &add_dirs),
        add_dirs,
        resume: resume.map(str::to_string),
        fork_session: false,
        api_mode: matches!(id.billing(), crate::identity::BillingAxis::ApiKey { .. }),
        account: id.codex_account().map(str::to_string),
        service_tier: id.codex_tier().map(str::to_string),
        context: ContextOverrides::default(),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 옮김표 — 이 모듈의 계약면
// ─────────────────────────────────────────────────────────────────────────────

/// 와이어 한 줄이 무엇이 되는가. **표가 진실이고 코드가 표를 따른다**(state.rs와 같은 규약).
///
/// - `wire`: `codex app-server`의 method(또는 프레임 종류)
/// - `dir`: `S→C` 서버→클라 · `C→S` 클라→서버
/// - `to`: 상태기계가 받는 Claude 프레임(또는 나가는 RPC)
/// - `src`: 2.6.2 근거 위치
///
/// 테스트(`tests/codex_replay.rs`)가 **이 표의 모든 행을 한 번씩 밟는다** — 표에 있는데
/// 재생이 없으면 커버리지 게이트가 붉어진다.
pub struct FrameMap {
    pub wire: &'static str,
    pub dir: &'static str,
    pub to: &'static str,
    pub src: &'static str,
}

pub static FRAME_MAP: &[FrameMap] = &[
    // ── 핸드셰이크 / 턴 ──────────────────────────────────────────────────────
    FrameMap { wire: "initialize", dir: "C→S", to: "control_response{init-1} (T2 절반)", src: "engine.ts:384-393" },
    FrameMap { wire: "thread/start", dir: "C→S", to: "system/init{session_id=threadId} (T2 나머지)", src: "engine.ts:1628-1638" },
    FrameMap { wire: "thread/resume", dir: "C→S", to: "system/init{session_id=threadId}", src: "engine.ts:1617-1626" },
    FrameMap { wire: "turn/start", dir: "C→S", to: "(응답=turnId 채택)", src: "engine.ts:1652-1663" },
    FrameMap { wire: "turn/started", dir: "S→C", to: "(turnId 채택 — 시작 창 닫기)", src: "engine.ts:575-582" },
    FrameMap { wire: "turn/interrupt", dir: "C→S", to: "(control_request{interrupt}의 번역)", src: "engine.ts:1423-1430" },
    FrameMap { wire: "turn/completed", dir: "S→C", to: "result{subtype,is_error,usage,modelUsage}", src: "engine.ts:583-601 · 1069-1127" },
    // ── 스트리밍 ─────────────────────────────────────────────────────────────
    FrameMap { wire: "item/agentMessage/delta", dir: "S→C", to: "stream_event{content_block_delta/text_delta}", src: "engine.ts:489-497" },
    FrameMap { wire: "item/completed{agentMessage}", dir: "S→C", to: "assistant{text}", src: "engine.ts:835-838" },
    FrameMap { wire: "item/reasoning/summaryTextDelta", dir: "S→C", to: "stream_event{thinking_delta}", src: "engine.ts:498-506" },
    FrameMap { wire: "item/reasoning/textDelta", dir: "S→C", to: "stream_event{thinking_delta}", src: "engine.ts:498-506" },
    FrameMap { wire: "item/reasoning/summaryPartAdded", dir: "S→C", to: "(생각 버퍼 리셋 — 프레임 없음)", src: "engine.ts:507-510" },
    FrameMap { wire: "item/completed{reasoning}", dir: "S→C", to: "(생각 버퍼 리셋 — 프레임 없음)", src: "engine.ts:839-842" },
    // ── 도구 ────────────────────────────────────────────────────────────────
    FrameMap { wire: "item/started{commandExecution}", dir: "S→C", to: "assistant{tool_use Bash}", src: "engine.ts:644-646" },
    // 이름이 `Edit`이면 셸의 diff 조립기가 Claude 도구 입력을 기대해 빈 diff를 만든다 —
    // 전용 이름을 쓴다(`transcode.rs`의 주석 · `wire.rs::tool_label`이 같은 'edit'로 그린다).
    FrameMap { wire: "item/started{fileChange}", dir: "S→C", to: "assistant{tool_use codex_file_change}", src: "engine.ts:647-651" },
    FrameMap { wire: "item/started{mcpToolCall}", dir: "S→C", to: "assistant{tool_use mcp__…}", src: "engine.ts:652-654" },
    FrameMap { wire: "item/started{webSearch}", dir: "S→C", to: "assistant{tool_use WebSearch}", src: "engine.ts:655-659" },
    FrameMap { wire: "item/commandExecution/outputDelta", dir: "S→C", to: "(출력 누적 — tool_result에 실린다)", src: "engine.ts:520-532" },
    FrameMap { wire: "item/completed{commandExecution}", dir: "S→C", to: "user{tool_result + exit} · 백그라운드면 stopped 사유 + 최종 출력 되살림", src: "engine.ts:843-896" },
    FrameMap { wire: "item/completed{fileChange}", dir: "S→C", to: "user{tool_result} + system/ccg_codex{file_change}", src: "engine.ts:897-955" },
    FrameMap { wire: "item/completed{mcpToolCall|webSearch}", dir: "S→C", to: "user{tool_result}", src: "engine.ts:956-973" },
    // ── 승인 · 질문 ──────────────────────────────────────────────────────────
    FrameMap { wire: "item/commandExecution/requestApproval", dir: "S→C", to: "control_request{can_use_tool Bash}", src: "engine.ts:428-433" },
    FrameMap { wire: "execCommandApproval(legacy)", dir: "S→C", to: "control_request{can_use_tool Bash}", src: "engine.ts:434-438" },
    FrameMap { wire: "item/fileChange/requestApproval", dir: "S→C", to: "control_request{can_use_tool Edit}", src: "engine.ts:439-443" },
    FrameMap { wire: "applyPatchApproval(legacy)", dir: "S→C", to: "control_request{can_use_tool Edit}", src: "engine.ts:444-447" },
    FrameMap { wire: "item/tool/requestUserInput", dir: "S→C", to: "control_request{can_use_tool AskUserQuestion}", src: "engine.ts:448-470" },
    FrameMap { wire: "(그 밖의 서버 요청)", dir: "S→C", to: "JSON-RPC error{unsupported client request}", src: "engine.ts:471-474" },
    FrameMap { wire: "control_response{승인}", dir: "C→S", to: "decision accept|decline|acceptForSession", src: "engine.ts:1368-1380" },
    FrameMap { wire: "control_response{legacy 승인}", dir: "C→S", to: "decision approved|denied|approved_for_session", src: "engine.ts:1377-1378" },
    FrameMap { wire: "control_response{질문}", dir: "C→S", to: "{answers:{qid:{answers}}} 또는 RPC error(건너뜀)", src: "engine.ts:1382-1404" },
    // ── 상태·회계 ────────────────────────────────────────────────────────────
    FrameMap { wire: "turn/plan/updated", dir: "S→C", to: "system/ccg_codex{todos}", src: "engine.ts:533-542" },
    FrameMap { wire: "thread/tokenUsage/updated", dir: "S→C", to: "system/ccg_codex{context} + 턴 델타 회계", src: "engine.ts:543-574 · 1096-1107" },
    FrameMap { wire: "error{willRetry:true}", dir: "S→C", to: "system/notification", src: "engine.ts:612-619" },
    // 게이트 3종(마감한 턴 · 시작 창 · 남의 턴)을 통과한 것만 정착시킨다. 수용량 초과는
    // 여기서 안 죽이고 안내 한 줄만 낸다 — 같은 사연의 `turn/completed{failed}`가 정착시킨다.
    FrameMap { wire: "error{willRetry:false}", dir: "S→C", to: "turnId 게이트 3종 통과분만 result{is_error}", src: "engine.ts:602-628" },
    // ── 백그라운드 터미널(unified exec) ──────────────────────────────────────
    FrameMap { wire: "thread/backgroundTerminals/list", dir: "C→S", to: "system/background_tasks_changed(REPLACE)", src: "engine.ts:1016-1064" },
    FrameMap { wire: "thread/backgroundTerminals/terminate", dir: "C→S", to: "(control_request{stop_task}의 번역)", src: "engine.ts:1410-1421" },
    // ── 서브에이전트(collab) ─────────────────────────────────────────────────
    FrameMap { wire: "item/*{subAgentActivity}", dir: "S→C", to: "assistant{tool_use Task} / 사이드체인 종료", src: "engine.ts:692-735" },
    FrameMap { wire: "item/*{collabAgentToolCall}", dir: "S→C", to: "assistant{tool_use Task} / user{tool_result}", src: "engine.ts:665-690 · 976-1003" },
    // 4종이다 — 턴 계열 둘은 카드 **자체**의 상태라 사이드체인 봉투에 안 싼다.
    FrameMap { wire: "(서브에이전트 스레드의 알림)", dir: "S→C", to: "item/* 는 parent_tool_use_id 사이드체인 · turn/started·completed 는 카드 재개·정착", src: "engine.ts:740-828" },
    // ── 0.149.0 실측 추가분 ─────────────────────────────────────────────────
    // 2.6.2(0.144.x)에는 없던 통지들. `scripts/poc-codex.mjs --only=handshake`가 실
    // 바이너리에서 **자격증명 없이** 받아 적은 것이다(그 산출이 docs/critic/m4-r1-codex.json).
    FrameMap { wire: "warning", dir: "S→C", to: "system/notification", src: "poc-codex 0.149.0 실측" },
    FrameMap { wire: "item/*{userMessage}", dir: "S→C", to: "(버림 — 사용자 말풍선은 렌더러가 이미 그렸다)", src: "poc-codex 0.149.0 실측" },
    FrameMap { wire: "thread/started·settings/updated·status/changed", dir: "S→C", to: "(버림 — 대응 표시 없음)", src: "poc-codex 0.149.0 실측" },
    FrameMap { wire: "remoteControl/status/changed", dir: "S→C", to: "(버림 — 안 켜는 기능)", src: "poc-codex 0.149.0 실측" },
    FrameMap { wire: "error{willRetry:false} + turn/completed{failed}", dir: "S→C", to: "result 한 장(둘째는 ended_turns가 삼킨다)", src: "poc-codex 0.149.0 실측 · engine.ts:210-213" },
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_maps_modes_and_efforts_like_2_6_2() {
        assert_eq!(codex_policy(ModeId::Plan), ("on-request", "read-only"));
        assert_eq!(codex_policy(ModeId::Normal), ("untrusted", "workspace-write"));
        assert_eq!(codex_policy(ModeId::Bypass), ("never", "danger-full-access"));
        // minimal은 Codex에 없다 → low
        assert_eq!(codex_effort(EffortId::Minimal, None), "low");
        assert_eq!(codex_effort(EffortId::Xhigh, None), "xhigh");
        // 지원 목록이 있으면 사다리로 강등된다(max 미지원 → xhigh)
        let sup = ["low".to_string(), "medium".to_string(), "high".to_string(), "xhigh".to_string()];
        assert_eq!(codex_effort(EffortId::Max, Some(&sup)), "xhigh");
    }

    #[test]
    fn thread_config_needs_an_empty_map_not_a_boolean() {
        // 실측 함정(engine.ts:47-49): boolean은 서버가 거절한다.
        let c = thread_config(&[]);
        assert!(c["tools"]["experimental_request_user_input"].is_object());
        assert_eq!(c["features"]["default_mode_request_user_input"], true);
        assert_eq!(c["features"]["unified_exec"], true);
        // ★2026-09-05 — 실험 기능 경고 억제. 없으면 스레드마다 「Under-development features enabled」 카드.
        assert_eq!(c["suppress_unstable_features_warning"], true);
        assert!(c.get("sandbox_workspace_write").is_none());
        let c2 = thread_config(&["C:\\ref".to_string()]);
        assert_eq!(c2["sandbox_workspace_write"]["writable_roots"][0], "C:\\ref");
    }

    #[test]
    fn frame_map_rows_are_unique() {
        let mut seen = std::collections::BTreeSet::new();
        for r in FRAME_MAP {
            assert!(seen.insert(r.wire), "옮김표 중복: {}", r.wire);
            assert!(!r.src.is_empty(), "{} — 출처 없는 행은 추측이다", r.wire);
        }
    }
}
