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

mod app_meta;
/// 파일·Git 도메인(M6). 다른 모듈과 달리 **블로킹 스레드**에서 돈다 — `ipc_call` 주석 참고.
mod fs;
mod git;
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
    /// ccg-page 스킴(뷰어 HTML 미리보기)은 **아직 없다** — 미구현으로 두면 심이 ''를
    /// 돌려주고 렌더러는 스피너에 머문다(Ctrl+D 코드 보기로 빠져나갈 수 있다).
    /// 상수만 두는 이유: 다음 라운드가 여기 한 줄을 붙이면 되게(M6 리포트 §미구현).
    #[allow(dead_code)]
    pub const FS_HTML_PREVIEW_URL: &str = "fs:html-preview-url";

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
    // 브로드캐스트(main → 렌더러)
    pub const CHAT_EVENT: &str = "chat:event";
    pub const CHAT_IDENTITY: &str = "chat:identity";
    pub const CHAT_QUEUE: &str = "chat:queue";
    pub const CHAT_RUN_STATE: &str = "chat:run-state";
    pub const CHAT_VERDICT: &str = "chat:verdict";
    /// 셸 내부 진단 — 계약면(protocol.ts)에 없다. 하네스가 런타임 회계를 읽는다.
    pub const ENGINE_DEBUG: &str = "engine:debug";

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
    // ── 파일·Git만 블로킹 스레드로 (M6) ──────────────────────────────────────
    // 나머지 채널은 메모리 스토어를 만지는 마이크로초짜리라 그대로 async 워커에서
    // 돌아도 된다. 이 둘은 다르다: 디렉터리 걷기·1.5MB 파일 읽기는 수십 ms고,
    // **git은 자식 프로세스**라 `push`/`pull`이 네트워크 왕복만큼(초 단위) 막힌다.
    // tauri의 async 런타임은 코어 수만큼의 워커를 가진 tokio라, 여기서 블로킹하면
    // 그 시간 동안 다른 창의 IPC(창 컨트롤·스토어 저장)가 통째로 굶는다.
    // `spawn_blocking`은 전용 풀(기본 512)로 빼므로 굶기지 않는다.
    if fs::owns(&channel) || git::owns(&channel) {
        let ch = channel.clone();
        return tauri::async_runtime::spawn_blocking(move || {
            fs::dispatch(&ch, &payload)
                .or_else(|| git::dispatch(&ch, &payload))
                .unwrap_or_else(unimplemented)
        })
        .await
        // 블로킹 작업이 panic으로 죽어도(=버그) 렌더러에는 안전값이 가야 한다.
        // `panic = "abort"` 프로파일에선 여기까지 못 오지만, 계약은 계약이다.
        .unwrap_or_else(|_| unimplemented());
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
    if let Some(v) = crate::engine::dispatch(app, window, channel, p) {
        return v;
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
