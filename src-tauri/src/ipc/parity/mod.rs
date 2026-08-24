//! 최종 파리티 감사 R1이 남긴 **「눌러도 안 되는 것」** 을 채우는 모듈 묶음.
//!
//! 감사(`docs/critic/final-parity-r1.md`)의 결론은 화면이 아니라 배선이었다: 계약면
//! 216채널 중 46개가 Rust에 핸들러조차 없고, 심(`app/src/api/shim.ts:99`)이 시그니처에
//! 맞는 **안전값**으로 갈음하기 때문에 화면은 정상으로 뜨고 버튼도 그려지는데 눌러도
//! 아무 일이 없다. 이 묶음이 그중 이 라운드 몫을 구현한다.
//!
//! | 감사 번호 | 채널 | 파일 |
//! |---|---|---|
//! | **T3** | `usage:get` · `auth:accounts-usage` | `usage.rs` |
//! | **T4** | `btw:open` | `btw.rs` |
//! | **H1** | `dialog:pick-attachments` | `dialog.rs` |
//! | **H2** | `mcp:list`·`mcp:set-enabled`·`skill:list`·`skill:set-enabled` | `tooling.rs` |
//! | **H4** | `codex:models` | `codex.rs` |
//! | **M1·M3·M2** | `shortcut:close`·`ui:open-api-settings`·`app:get-initial-dir` | `misc.rs` |
//!
//! ## 왜 새 모듈인가 (병렬 규율)
//!
//! 지금 같은 워킹트리에서 빌더 셋이 동시에 돈다. `ipc/mod.rs`·`ipc/unified.rs`·
//! `main.rs`는 **공유 파일**이라 한 줄 추가도 충돌을 만든다. 그래서 이 묶음은
//! `mod.rs`에 **삽입점 하나**만 낸다(`mod parity;` + `ipc_call`의 팔 하나).
//! 채널이 늘어도 그 두 줄은 그대로다.
//!
//! ## 왜 블로킹 팔인가
//!
//! 이 묶음의 채널은 성격이 `fs`·`git`·`lsp`와 같다 — **바깥 세계를 기다린다**:
//! 한도 조회는 HTTP(게이트에서 최대 1.2초, 429면 최대 30초)고, MCP·스킬은 디스크
//! 스캔이며, 첨부 picker는 사용자가 대화상자를 닫을 때까지 무한정이다. tauri의 async
//! 런타임은 코어 수만큼의 워커를 가진 tokio라, 여기서 블로킹하면 그 시간 동안 다른
//! 창의 IPC(창 컨트롤·스토어 저장)가 통째로 굶는다. `spawn_blocking`은 전용 풀로
//! 빼므로 굶기지 않는다 — `ipc_call`의 파일·Git 팔과 **같은 이유, 같은 처방**이다.

use serde_json::Value;
use tauri::{AppHandle, WebviewWindow};

mod btw;
mod codex;
mod dialog;
pub mod misc;
mod tooling;
/// ★T3T4 R3 — `pub`인 이유는 하나다: 엔진의 한도 재검증 훅(`engine::limit_probe`)이
/// **여기와 같은 캐시**를 봐야 하기 때문이다. 조회 루프가 두 벌이 되면 그 둘이 각자
/// 만료를 세면서 오래 논 계정의 리프레시 토큰을 번갈아 회전시킨다(M11 R2 C1의 사고).
pub mod usage;

/// 채널 이름 — `protocol.ts`가 원본, 여기는 미러다(문자열이 어긋나면 그 채널만 조용히
/// 미구현으로 떨어진다 → 심의 1회 경고로 드러난다). `ipc/mod.rs`의 `ch`가 아니라 여기
/// 두는 이유는 `windows.rs` 헤더와 같다: `mod.rs`는 다른 라운드가 소유한 공유 파일이고,
/// 이 모듈이 이 채널들의 **유일한** 소비자라 진실이 두 곳이 되지 않는다.
pub mod ch {
    /// 한도 조회(`usage:get(fresh?, account?)` → `UsageInfo`).
    pub const USAGE_GET: &str = "usage:get";
    /// 등록 계정별 한도(`auth:accounts-usage()` → `AccountUsage[]`).
    pub const AUTH_ACCOUNTS_USAGE: &str = "auth:accounts-usage";
    /// `/btw` 포크 질문 창(`btw:open(BtwOpenRequest)` → void).
    pub const BTW_OPEN: &str = "btw:open";
    /// 첨부 파일 선택(`dialog:pick-attachments()` → `string[]`).
    pub const PICK_ATTACHMENTS: &str = "dialog:pick-attachments";
    /// MCP 서버 목록·토글(설정 ▸ MCP).
    pub const MCP_LIST: &str = "mcp:list";
    pub const MCP_SET_ENABLED: &str = "mcp:set-enabled";
    /// 스킬 목록·토글(설정 ▸ Skill).
    pub const SKILL_LIST: &str = "skill:list";
    pub const SKILL_SET_ENABLED: &str = "skill:set-enabled";
    /// Codex picker의 모델 목록(`codex:models()` → `CodexModelInfo[]`).
    pub const CODEX_MODELS: &str = "codex:models";
}

/// 이 묶음이 맡는 채널인가 — `ipc_call`이 **블로킹 팔로 보낼지** 가르는 유일한 판정.
///
/// 명시 목록이다. 접두사(`usage:` 같은)로 넓게 잡지 않는 이유: 다른 갈래가 같은 접두사로
/// 채널을 하나 더 만드는 순간 그게 조용히 이쪽으로 빨려 들어와 미구현이 된다.
pub fn owns(channel: &str) -> bool {
    matches!(
        channel,
        ch::USAGE_GET
            | ch::AUTH_ACCOUNTS_USAGE
            | ch::BTW_OPEN
            | ch::PICK_ATTACHMENTS
            | ch::MCP_LIST
            | ch::MCP_SET_ENABLED
            | ch::SKILL_LIST
            | ch::SKILL_SET_ENABLED
            | ch::CODEX_MODELS
    ) || misc::owns(channel)
}

/// `owns`가 참인 채널만 여기 온다. `None`을 돌려주는 다른 모듈들과 달리 `Value`를
/// 바로 주는 이유: 소유 판정이 이미 `owns`에서 끝났기 때문이다(두 번 셀 필요가 없다).
pub fn dispatch(app: &AppHandle, window: &WebviewWindow, channel: &str, p: &Value) -> Value {
    match channel {
        ch::BTW_OPEN => btw::open(app, window, super::arg(p, 0)),
        ch::USAGE_GET => {
            // 2.6.2 `getUsage(fresh, account)` — 인자 배열 그대로(심 규약 §2).
            let fresh = super::arg(p, 0).as_bool().unwrap_or(false);
            let account = super::arg(p, 1).as_str();
            usage::usage_get(fresh, account)
        }
        ch::AUTH_ACCOUNTS_USAGE => usage::accounts_usage(),

        ch::PICK_ATTACHMENTS => dialog::pick_attachments(app),

        // MCP·스킬은 `cwd` 하나를 받는다(그 폴더에서 도는 실행이 무엇을 보는가).
        ch::MCP_LIST => tooling::mcp_list(super::arg(p, 0).as_str().unwrap_or("")),
        ch::SKILL_LIST => tooling::skill_list(super::arg(p, 0).as_str().unwrap_or("")),
        // 토글 페이로드는 `{ name, enabled }` 한 덩어리다(`shim.ts:362`).
        ch::MCP_SET_ENABLED | ch::SKILL_SET_ENABLED => {
            let a = super::arg(p, 0);
            let name = a.get("name").and_then(Value::as_str).unwrap_or("");
            let enabled = a.get("enabled").and_then(Value::as_bool).unwrap_or(true);
            if channel == ch::MCP_SET_ENABLED {
                tooling::mcp_set_enabled(name, enabled)
            } else {
                tooling::skill_set_enabled(name, enabled)
            }
        }

        ch::CODEX_MODELS => codex::models(),

        _ => misc::dispatch(app, window, channel),
    }
}
