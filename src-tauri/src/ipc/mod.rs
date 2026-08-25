//! IPC 디스패처 — Tauri 커맨드는 **하나**(`ipc_call`)뿐이고, 그 안의 채널 레지스트리가
//! 계약면(src/shared/protocol.ts)의 IPC 상수를 구현한다. 새 기능 = 레지스트리 1항목
//! (+ 필요하면 심 1메서드). 커맨드는 늘어나지 않는다 (ARCHITECTURE-3.0 확장점 #1).
//!
//! 호출 규약:
//!   invoke('ipc_call', { channel, payload })
//!     - channel : protocol.ts의 IPC 상수 문자열 그대로
//!     - payload : **인자 배열**. 2.6.2의 ipcRenderer.invoke(channel, ...args)가 가변
//!                 인자라(getUsage(fresh, account) 등) 배열로 통일해 개수를 보존한다.
//!   미구현 채널은 `{ "__unimplemented": true }`를 돌려준다 — 심이 채널당 1회 경고하고
//!   시그니처에 맞는 안전값으로 갈음한다. **어떤 화면도 크래시하지 않는 게 계약이다.**
//!
//! ── 모듈 분할 (M2) ──────────────────────────────────────────────────────────
//! 한 파일이 도메인 다섯 개를 들고 있어 "스토어 한 줄 고치기"가 창·크래시·계정 코드와
//! 같은 diff에 앉았다. 도메인별로 쪼개고 `dispatch`는 **순서 있는 위임**만 한다:
//!
//! ```text
//! dispatch → unified(플래그 켜졌을 때만) → app_meta → stores → windows → system
//! ```
//!
//! 각 모듈은 `Option<Value>`를 돌려준다 — `None` = "내 채널이 아니다". 첫 `Some`이 이긴다.
//! **`unified`가 맨 앞인 이유**: 옛 채널(`chats:*`·`ma:*`·`talk:*`)의 별칭 어댑터가
//! 2.6.2 핸들러를 가려야 하기 때문이다(M-UX §6.2). 플래그가 꺼져 있으면 이 줄 자체가
//! 실행되지 않으므로 **기본 경로의 동작은 한 글자도 바뀌지 않는다.**

/// 계정 **쓰기**(최종 파리티 T1 — 로그인·로그아웃·기본·삭제·순서). 읽기는 `system`.
/// 로그인이 사용자를 최대 5분 기다리므로 **블로킹 스레드**에서 돈다.
mod accounts;
mod app_meta;
/// 파일·Git 도메인(M6). 다른 모듈과 달리 **블로킹 스레드**에서 돈다 — `ipc_call` 주석 참고.
mod fs;
mod git;
/// 코드 인텔리전스(M7). fs·git과 같은 이유로 블로킹 — 전부 언어 서버 자식 프로세스 왕복이다.
mod lsp;
/// 최종 파리티 감사 R1이 남긴 미구현 채널 묶음(한도·btw·첨부·MCP/스킬·잡채널).
/// fs·git·lsp와 같은 이유로 **블로킹 스레드**에서 돈다 — 그 모듈 헤더 참고.
pub mod parity;
mod stores;
mod system;
/// `pub`인 이유: 창 브로드캐스트(`win.rs broadcast_sessions`)가 이 모듈의 병합 함수를
/// **조회 채널과 같은 원천으로** 써야 한다(R8-1).
pub mod unified;
/// `pub`인 이유: `win.rs`가 창 슬롯 브로드캐스트를 쏠 때 **이 모듈의 채널 상수**를
/// 그대로 써야 한다(문자열을 두 곳에 적으면 한쪽만 고쳐지는 순간 조용히 끊긴다).
pub mod windows;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

pub use system::close_orphan_dialogs;
/// 부팅 프리웜 — 셸이 `main()` **첫 줄**(단일 인스턴스 관문 직후 · `tauri::Builder`보다
/// **앞** = `main.rs:136`)에서 한 줄로 부른다. 창은 아직 없다.
///
/// (정정: R1까지 여기 "창을 만든 직후"라고 적혀 있었다 — 크리틱 §3.2의 *제안* 자리를
/// 그대로 옮겨 적은 오기다. `lsp.rs`의 주석이 맞고 이쪽이 틀렸었다. R19 확인 크리틱
/// §6-1이 잡았고, 같은 크리틱의 프리웜 A/B(§2.2)가 **이 자리가 `ready`의 전부**임을
/// 보였다 — `win:mounted` 뒤로 밀면 ready가 ~180ms → 481~557ms로 3배 나빠진다.)
///
/// M7 R2 §3.2: 방아쇠를 렌더러 번들보다 앞으로 당겨 `ready` 격차의 41ms를 없앤다.
/// 판정 로직은 전부 `lsp.rs`에 있다.
pub use lsp::boot_prewarm;

/// 채널 이름 — protocol.ts가 원본, 여기는 미러다(문자열이 어긋나면 그 채널만 조용히
/// 미구현으로 떨어진다 → 심의 1회 경고로 드러난다).
pub mod ch {
    // app meta / update
    pub const APP_GET_VERSION: &str = "app:get-version";
    pub const APP_GET_INITIAL_DIR: &str = "app:get-initial-dir";
    pub const UPDATE_GET_STATUS: &str = "app:update-status";
    // engine
    pub const ENGINE_AUTO_UPDATE: &str = "engine:auto-update";
    pub const ENGINE_UPDATE_STATUS: &str = "engine:update-status";
    pub const ENGINE_STATE: &str = "engine:state";
    pub const CODEX_ENGINE_STATE: &str = "codex-engine:state";
    // stores
    pub const PROFILE_GET: &str = "profile:get";
    pub const PROFILE_SAVE: &str = "profile:save";
    pub const CHATS_GET: &str = "chats:get";
    pub const CHATS_SAVE: &str = "chats:save";
    pub const CHAT_LOAD: &str = "chats:load";
    pub const UI_PREFS_GET: &str = "ui-prefs:get";
    pub const UI_PREFS_SAVE: &str = "ui-prefs:save";
    // 멀티채팅(주 게이트) 워크스페이스
    pub const MA_GET: &str = "ma:get";
    pub const MA_SAVE: &str = "ma:save";
    pub const MA_LOAD_SESSION: &str = "ma:load-session";
    // 채팅 모드(1.x 은퇴) 블롭 — 통합 스토어가 흡수한다(§6.2)
    pub const TALK_GET: &str = "talk:get";
    pub const TALK_SAVE: &str = "talk:save";
    // API 과금 설정 · 사용 원장
    pub const API_CONFIG_GET: &str = "api-config:get";
    pub const API_CONFIG_SET_KEY: &str = "api-config:set-key";
    pub const API_CONFIG_CLEAR_KEY: &str = "api-config:clear-key";
    pub const API_CONFIG_SET_BUDGET: &str = "api-config:set-budget";
    pub const API_CONFIG_RESET_BUDGET: &str = "api-config:reset-budget";
    pub const API_USAGE_LIST: &str = "api-usage:list";
    // 추가 채팅 창
    pub const OPEN_SESSION_WINDOW: &str = "win:open-session";
    pub const SESSION_WINS_LIST: &str = "session-wins:list";
    pub const SESSION_WINS_FOCUS: &str = "session-wins:focus";
    pub const SESSION_WINS_CLOSE: &str = "session-wins:close";
    pub const SESSION_REPORT: &str = "session-wins:report";
    /// ★ 추가 채팅 창의 **대화 저장/복원/이름**. 렌더러(`SessionWindow.tsx:342`·`:369`)는
    /// 이 셋을 실제로 부르는데 R1까지 상수조차 없어 `{__unimplemented:true}`로 떨어졌다
    /// → "Ctrl+Shift+N → 대화 → 창 닫기 = 증발"(크리틱 배선 R1 §5-S4).
    pub const SESSION_PERSIST: &str = "session-wins:persist";
    pub const SESSION_HYDRATE: &str = "session-wins:hydrate";
    pub const SESSION_WINS_RENAME: &str = "session-wins:rename";
    pub const SESSION_WINS_CHANGED: &str = "session-wins:changed";
    // broadcasts (main → renderer)
    pub const UI_GLASS_CHANGED: &str = "ui-glass:changed";
    pub const UI_LANG_CHANGED: &str = "ui-lang:changed";
    pub const WIN_STATE: &str = "win:state";
    // window controls
    pub const WIN_MINIMIZE: &str = "win:minimize";
    pub const WIN_MAXIMIZE_TOGGLE: &str = "win:maximize-toggle";
    pub const WIN_CLOSE: &str = "win:close";
    pub const WIN_IS_MAXIMIZED: &str = "win:is-maximized";
    /// 셸 내부 채널 — 렌더러 계약면(protocol.ts)에 없다. 주입된 splash.js가
    /// "첫 프레임을 그렸다"고 알리는 자리(win.rs 참고).
    pub const WIN_FIRST_PAINT: &str = "win:first-paint";
    /// 셸 내부 채널 — splash.js가 `#root`에 자식이 생긴 순간(=React 마운트) 쏜다.
    /// **크래시 복구가 실제로 붙었는지**를 가르는 하트비트다(crash.rs `note_mounted`).
    pub const WIN_MOUNTED: &str = "win:mounted";
    // fs / dialog
    pub const DIR_EXISTS: &str = "fs:dir-exists";
    pub const PICK_DIRECTORY: &str = "dialog:pick-directory";

    // ── 파일 탐색기 · 코드 뷰어 (M6 — ipc/fs.rs) ─────────────────────────────
    /// 폴더 하나의 항목들. 탐색기가 폴더를 펼칠 때마다 부른다(지연 로드).
    pub const FS_LIST_DIR: &str = "fs:list-dir";
    /// 프로젝트 전체 파일(상대 경로) — "@" 멘션 팔레트 + 탐색기 검색 인덱스.
    pub const FS_LIST_FILES: &str = "fs:list-files";
    pub const FS_READ_FILE: &str = "fs:read-file";
    pub const FS_WRITE_FILE: &str = "fs:write-file";
    pub const FS_RENAME: &str = "fs:rename";
    pub const FS_DELETE: &str = "fs:delete";
    pub const FS_CREATE: &str = "fs:create";
    pub const FS_MOVE: &str = "fs:move";
    pub const SHELL_OPEN_PATH: &str = "shell:open-path";
    pub const SHELL_REVEAL_PATH: &str = "shell:reveal-path";
    /// 뷰어 HTML 미리보기 — 서빙 루트를 등록하고 `http://ccg-page.localhost/…` URL을
    /// 발급한다(M6 R3. 스킴 등록은 `main.rs`, 판정은 `ccg_fs::serve`).
    pub const FS_HTML_PREVIEW_URL: &str = "fs:html-preview-url";
    /// 붙여넣기·브라우저 드래그 첨부(경로 없는 바이트) → 앱 홈 아래 임시 파일 경로.
    /// 이게 없으면 컴포저 첨부 트레이·라이트박스가 통째로 안 뜬다(M-UX §R3.9-1).
    pub const ATTACHMENT_SAVE_DATA: &str = "attachment:save-data";

    // ── LSP 코드 인텔리전스 (M7 — ipc/lsp.rs) ────────────────────────────────
    pub const LSP_STATUS: &str = "lsp:status";
    pub const LSP_HOVER: &str = "lsp:hover";
    pub const LSP_DEFINITION: &str = "lsp:definition";
    pub const LSP_SEMANTIC_TOKENS: &str = "lsp:semantic-tokens";
    pub const LSP_CACHED_TOKENS: &str = "lsp:cached-tokens";
    pub const LSP_COMPLETION: &str = "lsp:completion";
    pub const LSP_COMPLETION_RESOLVE: &str = "lsp:completion-resolve";
    pub const LSP_PREWARM: &str = "lsp:prewarm";
    pub const LSP_WARM: &str = "lsp:warm";
    pub const LSP_PROJECT_STATUS: &str = "lsp:project-status";
    pub const LSP_SERVERS: &str = "lsp:servers";
    /// 코드 파일 변화 브로드캐스트(main→모든 창) — 열린 뷰어의 토큰 재폴링 신호.
    /// **아직 쏘는 곳이 없다**(R2): 통지의 값어치는 C#처럼 "재프라임 전까지 새 타입이
    /// 무색인" 서버에서 나온다. TS는 `openDoc`의 mtime 재검사만으로 스스로 회복하고,
    /// 그 회복 시간을 하네스가 직접 잰다(`retokenize`). 쏘는 자리는 `fs:write-file`
    /// 경로이고 그 파일은 이 라운드의 경계 밖이라, 상수만 먼저 박아 둔다.
    #[allow(dead_code)]
    pub const LSP_FILES_CHANGED: &str = "lsp:files-changed";
    // Verse는 3.0 범위에서 제외(사용자 결정)지만 렌더러가 채널을 부른다 —
    // 미구현 경고 대신 **명시적 안전값**을 돌려주기 위해 상수를 둔다(ipc/lsp.rs).
    pub const LSP_VERSE_REGISTRY: &str = "lsp:verse-registry";
    pub const LSP_VERSE_DIGESTS: &str = "lsp:verse-digests";
    pub const LSP_VERSE_EXCLUDES: &str = "lsp:verse-excludes";

    // ── Git (M6 — ipc/git.rs) ────────────────────────────────────────────────
    pub const GIT_REPOS: &str = "git:repos";
    pub const GIT_STATUS: &str = "git:status";
    pub const GIT_LOG: &str = "git:log";
    pub const GIT_FILE_DIFF: &str = "git:file-diff";
    pub const GIT_COMMIT_DETAIL: &str = "git:commit-detail";
    pub const GIT_COMMIT_FILE_DIFF: &str = "git:commit-file-diff";
    pub const GIT_COMMIT: &str = "git:commit";
    pub const GIT_PUSH: &str = "git:push";
    pub const GIT_PULL: &str = "git:pull";
    pub const GIT_FETCH: &str = "git:fetch";
    pub const GIT_DISCARD: &str = "git:discard";
    pub const GIT_BRANCHES: &str = "git:branches";
    pub const GIT_SWITCH_BRANCH: &str = "git:switch-branch";
    pub const GIT_CREATE_BRANCH: &str = "git:create-branch";
    /// AI 커밋 메시지 — diff를 읽어 엔진 CLI를 1턴 돌린다. 실행 계통에 붙어야 해서
    /// 이번 라운드는 미구현(심이 `{ok:false}`로 갈음 → 사용자가 직접 쓴 메시지 유지).
    #[allow(dead_code)]
    pub const GIT_AI_MESSAGE: &str = "git:ai-message";
    // accounts (읽기 전용)
    pub const AUTH_LIST_ACCOUNTS: &str = "auth:list-accounts";
    pub const CODEX_LIST_ACCOUNTS: &str = "codex-auth:list-accounts";
    // ── 계정 쓰기(최종 파리티 T1 · `ipc/accounts.rs`) ─────────────────────────
    // 이 다섯이 비어 있는 동안 **새 사용자는 3.0에서 로그인할 방법이 없었다**
    // (2.6.2 홈을 승계해야만 썼다). 설정 ▸ Account의 세 버튼도 전부 무반응이었다.
    pub const AUTH_LOGIN: &str = "auth:login";
    pub const AUTH_LOGIN_CANCEL: &str = "auth:login-cancel";
    /// main → 렌더러: 로그인 OAuth URL. **브라우저는 CLI가 직접 연다** — 이건 안 열린
    /// 환경에서 사용자가 눌러 보는 폴백 링크다(앱이 또 열면 인증 페이지가 두 장 뜬다).
    pub const AUTH_LOGIN_URL: &str = "auth:login-url";
    pub const AUTH_LOGOUT: &str = "auth:logout";
    pub const AUTH_SET_DEFAULT_ACCOUNT: &str = "auth:set-default-account";
    pub const AUTH_REMOVE_ACCOUNT: &str = "auth:remove-account";
    pub const AUTH_REORDER_ACCOUNTS: &str = "auth:reorder-accounts";
    // ── Codex 계정 쓰기(R28f SHIPBLOCK N1 · `ipc/accounts.rs`) ─────────────────
    // 이 다섯이 비어 있는 동안 **Codex 축이 통째로 못 쓰였다**: 실홈의
    // `codex-accounts.json`은 `accounts: []`인데 「계정 추가」가 무반응이라 등록할 길이
    // 없었고(= 구독 엔진을 한 번도 못 켠다), 「맨 위로」·정렬은 심의 안전값 `[]`가
    // 그대로 목록 setter에 앉아 **화면의 OpenAI 계정이 통째로 사라졌다**
    // (최종 파리티 감사 R2 §N1 · 확인 크리틱 R1 §4).
    pub const CODEX_LOGIN: &str = "codex-auth:login";
    pub const CODEX_LOGIN_CANCEL: &str = "codex-auth:login-cancel";
    pub const CODEX_LOGOUT: &str = "codex-auth:logout";
    /// 「기본 계정」은 3.0에서 사라졌다(기본 = 맨 위). 이 채널은 **「맨 위로 이동」과
    /// 동치**다 — Anthropic 축의 `auth:set-default-account`와 같은 규약(§6.5).
    pub const CODEX_SET_DEFAULT_ACCOUNT: &str = "codex-auth:set-default-account";
    pub const CODEX_REORDER_ACCOUNTS: &str = "codex-auth:reorder-accounts";

    // ── 통합 스토어(chats-v3) — CCG_UNIFIED_STORE=1에서만 산다 (M-UX §6.1) ────
    /// 활성 채팅 전환. **즉시** 반영된다 — 저장 디바운스와 무관해야 "전환 직후 전송"이
    /// 남의 `ChatRuntime`에 붙지 않는다(§6.2 U3).
    pub const CHATS_SET_ACTIVE: &str = "chats:set-active";
    pub const BOARD_GET: &str = "board:get";
    pub const BOARD_LOAD: &str = "board:load";
    pub const BOARD_SAVE: &str = "board:save";
    /// main → 렌더러: 전 채팅 경량 상태 REPLACE(§4.3).
    /// 방출 주체는 M-LOGIC의 상태기계다(`engine/hub.rs`).
    pub const CHAT_STATUS: &str = "chat:status";

    // ── M-LOGIC 실행 채널 (engine/ 글루) ─────────────────────────────────────
    // 3.0 코어 — 주소는 페이로드의 `chatId` 하나(m-logic §4.3 ★R2).
    pub const CHAT_RUN: &str = "chat:run";
    pub const CHAT_INTERRUPT: &str = "chat:interrupt";
    pub const CHAT_CANCEL: &str = "chat:cancel";
    pub const CHAT_PERMISSION: &str = "chat:permission";
    pub const CHAT_ANSWER: &str = "chat:answer";
    pub const CHAT_RESPOND_DIALOG: &str = "chat:respond-dialog";
    pub const CHAT_BG_TASK: &str = "chat:bg-task";
    pub const CHAT_DISPOSE: &str = "chat:dispose";
    pub const CHAT_IDENTITY_GET: &str = "chat:identity-get";
    pub const CHAT_IDENTITY_SET: &str = "chat:identity-set";
    pub const CHAT_IDENTITY_REVERT: &str = "chat:identity-revert";
    pub const CHAT_QUEUE_MUTATE: &str = "chat:queue-mutate";
    pub const CHAT_FORCE_SETTLE: &str = "chat:force-settle";
    /// ★M9 R2 — 이 채팅의 도구 환경(MCP·스킬) **재조회**. 주소는 `chatId` 또는 `panelId`
    /// (멀티 패널의 칩은 자기 chatId를 모른다 — 보드 자리 키만 안다).
    pub const CHAT_TOOLING_GET: &str = "chat:tooling-get";
    // 브로드캐스트(main → 렌더러)
    pub const CHAT_EVENT: &str = "chat:event";
    pub const CHAT_IDENTITY: &str = "chat:identity";
    pub const CHAT_QUEUE: &str = "chat:queue";
    pub const CHAT_RUN_STATE: &str = "chat:run-state";
    pub const CHAT_VERDICT: &str = "chat:verdict";
    /// 셸 내부 진단 — 계약면(protocol.ts)에 없다. 하네스가 런타임 회계를 읽는다.
    pub const ENGINE_DEBUG: &str = "engine:debug";

    // ── M10 대화 연결(세션 간 소통) ─────────────────────────────────────────
    // **`talk:*`를 쓰지 않는다**: 위 `TALK_GET`/`TALK_SAVE`가 1.x의 은퇴한 "채팅 모드"
    // 블롭이고, 그 이름을 재사용하면 옛 렌더러의 호출이 새 라우터로 떨어진다.
    pub const CROSSTALK_CONFIG: &str = "crosstalk:config";
    pub const CROSSTALK_SET: &str = "crosstalk:set";
    pub const CROSSTALK_STOP: &str = "crosstalk:stop";
    /// 브로드캐스트 — 설정이 바뀌었다(긴급 정지 포함). 페이로드 = 설정 전문.
    pub const CROSSTALK_STATE: &str = "crosstalk:state";

    // ── 과도기 별칭: 2.6.2 실행 표면(§6.2) ───────────────────────────────────
    pub const CLAUDE_RUN: &str = "claude:run";
    pub const CLAUDE_CANCEL: &str = "claude:cancel";
    pub const CLAUDE_INTERRUPT: &str = "claude:interrupt";
    pub const CLAUDE_PERMISSION_RESPOND: &str = "claude:permission-respond";
    pub const CLAUDE_QUESTION_RESPOND: &str = "claude:question-respond";
    pub const CLAUDE_BG_TASK: &str = "claude:bg-task";
    pub const ENGINE_EVENT: &str = "engine:event";
    pub const SESSION_RUN: &str = "session:run";
    pub const SESSION_CANCEL: &str = "session:cancel";
    pub const SESSION_INTERRUPT: &str = "session:interrupt";
    pub const SESSION_PERMISSION_RESPOND: &str = "session:permission-respond";
    pub const SESSION_QUESTION_RESPOND: &str = "session:question-respond";
    pub const SESSION_BG_TASK: &str = "session:bg-task";
    pub const SESSION_EVENT: &str = "session:event";
    pub const MA_RUN: &str = "ma:run";
    pub const MA_CANCEL: &str = "ma:cancel";
    pub const MA_INTERRUPT: &str = "ma:interrupt";
    pub const MA_PERMISSION_RESPOND: &str = "ma:permission-respond";
    pub const MA_QUESTION_RESPOND: &str = "ma:question-respond";
    pub const MA_BG_TASK: &str = "ma:bg-task";
    pub const MA_DISPOSE: &str = "ma:dispose";
    pub const MA_EVENT: &str = "ma:event";
}

static NULL: Value = Value::Null;

pub(crate) fn arg(payload: &Value, i: usize) -> &Value {
    payload.get(i).unwrap_or(&NULL)
}

pub(crate) fn unimplemented() -> Value {
    json!({ "__unimplemented": true })
}

#[tauri::command]
pub async fn ipc_call(app: AppHandle, window: WebviewWindow, channel: String, payload: Value) -> Value {
    // ★최종 파리티 R1 — 한도·btw·첨부·MCP/스킬·잡채널(ipc/parity). 아래 파일·Git 팔과
    // **같은 이유로** 전용 블로킹 풀에서 돈다: HTTP 왕복(게이트 1.2초·429면 최대 30초)·
    // 디스크 스캔·사용자가 닫을 때까지 열려 있는 네이티브 대화상자.
    //
    // 그 팔보다 **앞**에 두는 이유 둘: (1) `parity::owns`는 명시 목록이라 저쪽과 겹칠 수
    // 없고, (2) 앞에 두면 파일·Git 귀속 팔(`CCG_NO_FS`)이 이 채널들까지 싸잡아 미구현으로
    // 떨어뜨리는 일이 없다 — 그 대조군이 재는 것은 파일·Git 비용이지 한도 조회가 아니다.
    if parity::owns(&channel) {
        let a = app.clone();
        let w = window.clone();
        let ch = channel.clone();
        return tauri::async_runtime::spawn_blocking(move || parity::dispatch(&a, &w, &ch, &payload))
            .await
            // 블로킹 작업이 panic으로 죽어도(=버그) 렌더러에는 안전값이 가야 한다.
            .unwrap_or_else(|_| unimplemented());
    }

    // ★최종 파리티 T1·T2 — 계정 쓰기(`ipc/accounts.rs`)와 엔진 CLI 버전 관리
    // (`engine/versions.rs`·`engine/codex_versions.rs`). 위 팔들과 **같은 이유**로 전용
    // 블로킹 풀에서 돌지만 막히는 시간의 자릿수가 다르다:
    //   auth:login   사용자가 브라우저에서 로그인을 끝낼 때까지 — **최대 5분**
    //   engine:install  `npm install` 왕복 — 수십 초
    //   engine:list-available  `npm view` — 8초 상한
    // async 워커(코어 수만큼의 tokio 스레드)에서 이걸 자면 그동안 **모든 창의 IPC가
    // 통째로 굶는다**(창 컨트롤·스토어 저장 포함). 두 `owns`는 명시 목록이라 위아래
    // 어느 팔과도 겹치지 않는다.
    if accounts::owns(&channel) || crate::engine::heavy_owns(&channel) {
        let a = app.clone();
        let ch = channel.clone();
        return tauri::async_runtime::spawn_blocking(move || {
            accounts::dispatch(&a, &ch, &payload)
                .or_else(|| crate::engine::heavy_dispatch(&a, &ch, &payload))
                .unwrap_or_else(unimplemented)
        })
        .await
        .unwrap_or_else(|_| unimplemented());
    }

    // ── 파일·Git만 블로킹 스레드로 (M6) ──────────────────────────────────────
    // 나머지 채널은 메모리 스토어를 만지는 마이크로초짜리라 그대로 async 워커에서
    // 돌아도 된다. 이 둘은 다르다: 디렉터리 걷기·1.5MB 파일 읽기는 수십 ms고,
    // **git은 자식 프로세스**라 `push`/`pull`이 네트워크 왕복만큼(초 단위) 막힌다.
    // tauri의 async 런타임은 코어 수만큼의 워커를 가진 tokio라, 여기서 블로킹하면
    // 그 시간 동안 다른 창의 IPC(창 컨트롤·스토어 저장)가 통째로 굶는다.
    // `spawn_blocking`은 전용 풀(기본 512)로 빼므로 굶기지 않는다.
    // LSP도 같은 이유로 여기 붙는다(M7): 호버 한 번이 자식 프로세스 왕복이고, 콜드
    // 시맨틱 토큰은 초 단위다. async 워커에서 돌면 그동안 다른 창의 IPC가 통째로 굶는다.
    if fs::owns(&channel) || git::owns(&channel) || lsp::owns(&channel) {
        // ★R4 귀속 팔 — 파일·Git 도메인을 통째로 미구현으로 떨어뜨린다(심이 안전값).
        // **LSP는 이 팔에 넣지 않는다** — 그 팔이 재는 것은 파일·Git 비용이고, 여기에
        // 코드 인텔리전스까지 끼면 그 대조군이 다른 것을 재게 된다.
        if crate::flags::no_fs() && !lsp::owns(&channel) {
            return unimplemented();
        }
        // ★M7 R4 — 앱을 거친 파일 변화를 언어 서버에 흘리는 자리(2.6.2 `notifyWatchedFiles`).
        // 경로만 미리 뽑고(인자 읽기뿐), 통지는 결과가 난 뒤에 한다. 파일을 안 바꾸는
        // 채널이면 빈 목록이라 공짜다. 로직은 전부 `ipc/lsp.rs`에 있다.
        let changed = lsp::changed_paths(&channel, &payload);
        let ch = channel.clone();
        let out = tauri::async_runtime::spawn_blocking(move || {
            fs::dispatch(&ch, &payload)
                .or_else(|| git::dispatch(&ch, &payload))
                .or_else(|| lsp::dispatch(&ch, &payload))
                .unwrap_or_else(unimplemented)
        })
        .await
        // 블로킹 작업이 panic으로 죽어도(=버그) 렌더러에는 안전값이 가야 한다.
        // `panic = "abort"` 프로파일에선 여기까지 못 오지만, 계약은 계약이다.
        .unwrap_or_else(|_| unimplemented());
        lsp::after_fs_change(&app, changed, &out);
        return out;
    }
    dispatch(&app, &window, &channel, &payload)
}

fn dispatch(app: &AppHandle, window: &WebviewWindow, channel: &str, p: &Value) -> Value {
    // 통합 스토어 옵트인 — 켜졌을 때만, 그리고 **맨 앞에서** 옛 채널을 가로챈다.
    if ccg_store::unified_store_enabled() {
        if let Some(v) = unified::dispatch(app, channel, p) {
            return v;
        }
    }
    // 실행(엔진) 채널. 스토어 별칭보다 **뒤**에 둔다 — `chats:*`·`ma:get` 같은 조회는
    // 엔진과 무관하고, 엔진 채널(`chat:run`·`claude:*`)과 이름이 겹치지도 않는다.
    // (★R4 귀속 팔 `CCG_NO_ENGINE_GLUE`: 엔진 글루를 통째로 빼고 재는 대조군)
    if !crate::flags::no_engine_glue() {
        if let Some(v) = crate::engine::dispatch(app, window, channel, p) {
            return v;
        }
    }
    if let Some(v) = app_meta::dispatch(channel, p) {
        return v;
    }
    if let Some(v) = stores::dispatch(app, channel, p) {
        return v;
    }
    if let Some(v) = windows::dispatch(app, window, channel, p) {
        return v;
    }
    if let Some(v) = system::dispatch(app, channel, p) {
        return v;
    }
    unimplemented()
}

/// M2 이후 창 라우팅이 쓸 헬퍼 — 라벨로 창을 찾아 같은 채널로 이벤트를 보낸다.
#[allow(dead_code)]
pub fn emit_to_window(app: &AppHandle, label: &str, channel: &str, payload: Value) {
    if app.get_webview_window(label).is_some() {
        let _ = app.emit_to(label, channel, payload);
    }
}
