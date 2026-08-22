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

use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

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
    // 추가 채팅 창
    pub const OPEN_SESSION_WINDOW: &str = "win:open-session";
    pub const SESSION_WINS_LIST: &str = "session-wins:list";
    pub const SESSION_WINS_FOCUS: &str = "session-wins:focus";
    pub const SESSION_WINS_CLOSE: &str = "session-wins:close";
    pub const SESSION_REPORT: &str = "session-wins:report";
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
    // accounts (읽기 전용)
    pub const AUTH_LIST_ACCOUNTS: &str = "auth:list-accounts";
    pub const CODEX_LIST_ACCOUNTS: &str = "codex-auth:list-accounts";
}

static NULL: Value = Value::Null;
fn arg(payload: &Value, i: usize) -> &Value {
    payload.get(i).unwrap_or(&NULL)
}
fn unimplemented() -> Value {
    json!({ "__unimplemented": true })
}

#[tauri::command]
pub async fn ipc_call(app: AppHandle, window: WebviewWindow, channel: String, payload: Value) -> Value {
    dispatch(&app, &window, &channel, &payload)
}

fn dispatch(app: &AppHandle, window: &WebviewWindow, channel: &str, p: &Value) -> Value {
    match channel {
        // ── app meta ────────────────────────────────────────────────────────
        ch::APP_GET_VERSION => json!(env!("CARGO_PKG_VERSION")),
        // "AgentCodeGUI로 열기"(파일 탐색기 컨텍스트 메뉴)는 M12 설치기와 함께 온다
        ch::APP_GET_INITIAL_DIR => Value::Null,
        // 앱 자동 업데이트(electron-updater 자리)는 아직 없다 — 정직하게 idle.
        // AppUpdateGate는 phase가 available/downloading/downloaded/error일 때만 뜬다.
        ch::UPDATE_GET_STATUS => json!({
            "phase": "idle", "version": Value::Null, "percent": 0, "log": [], "error": Value::Null
        }),

        // ── engine ─────────────────────────────────────────────────────────
        // 두 엔진 CLI 공통 자동 업데이트 플래그. 인자 있으면 설정, 항상 현재 값 반환.
        ch::ENGINE_AUTO_UPDATE => {
            if let Some(enabled) = arg(p, 0).as_bool() {
                let _ = ccg_store::write_home_file(
                    "engine-auto-update.json",
                    &json!({ "enabled": enabled }).to_string(),
                );
            }
            json!(auto_update())
        }
        // 부팅 엔진 업데이트 흐름은 M3(엔진)과 함께 — 지금은 "돌고 있지 않다"가 진실.
        ch::ENGINE_UPDATE_STATUS => json!({
            "active": false, "items": [], "cleanup": "pending", "freedBytes": 0, "done": false
        }),
        ch::ENGINE_STATE => engine_state("engines", "config.json", "@anthropic-ai/claude-agent-sdk"),
        ch::CODEX_ENGINE_STATE => engine_state("codex-engines", "codex-config.json", "@openai/codex"),

        // ── stores (앱 홈 — 2.6.2 포맷 그대로) ──────────────────────────────
        ch::PROFILE_GET => ccg_store::prefs::read_profile().unwrap_or(Value::Null),
        ch::PROFILE_SAVE => {
            let _ = ccg_store::prefs::write_profile(arg(p, 0));
            Value::Null
        }
        // 부팅 조회는 경량(light) — 활성 채팅만 스냅샷, 나머지는 unloaded 마커
        ch::CHATS_GET => ccg_store::chats::read_chats(true),
        ch::CHATS_SAVE => {
            ccg_store::chats::write_chats(arg(p, 0));
            Value::Null
        }
        ch::CHAT_LOAD => ccg_store::chats::read_chat(arg(p, 0)),
        ch::UI_PREFS_GET => ccg_store::prefs::read_ui_prefs(),
        ch::UI_PREFS_SAVE => {
            let prefs = arg(p, 0);
            let _ = ccg_store::prefs::write_ui_prefs(prefs);
            broadcast_ui_prefs(app, prefs);
            Value::Null
        }

        // ── 멀티채팅 워크스페이스 (chats와 같은 팬아웃·같은 unloaded 규약) ──
        // 부팅 조회는 경량(light) — 활성 세션만 패널 스냅샷, 나머지는 마커.
        ch::MA_GET => ccg_store::ma::read_multi(true),
        ch::MA_SAVE => {
            ccg_store::ma::write_multi(arg(p, 0));
            Value::Null
        }
        ch::MA_LOAD_SESSION => ccg_store::ma::read_session(arg(p, 0)),

        // ── 추가 채팅 창 (창당 비용이 3.0의 주 전장 — win.rs 헤더) ──────────
        ch::OPEN_SESSION_WINDOW => {
            if let Err(e) = crate::win::open_session_window(app) {
                eprintln!("[win] 추가 채팅 창 생성 실패: {e}");
            }
            Value::Null
        }
        ch::SESSION_WINS_LIST => crate::win::session_list(),
        ch::SESSION_WINS_FOCUS => {
            if let Some(id) = arg(p, 0).as_str() {
                crate::win::session_focus(app, id);
            }
            Value::Null
        }
        ch::SESSION_WINS_CLOSE => {
            if let Some(id) = arg(p, 0).as_str() {
                crate::win::session_close(app, id);
            }
            Value::Null
        }
        ch::SESSION_REPORT => {
            let info = arg(p, 0);
            crate::win::session_report(
                app,
                window.label(),
                info.get("title").and_then(Value::as_str),
                info.get("status").and_then(Value::as_str),
            );
            Value::Null
        }

        // ── 창 컨트롤 ───────────────────────────────────────────────────────
        ch::WIN_MINIMIZE => {
            crate::win::minimize(window);
            Value::Null
        }
        ch::WIN_MAXIMIZE_TOGGLE => json!(crate::win::toggle_maximize(window)),
        ch::WIN_CLOSE => {
            crate::win::close(window);
            Value::Null
        }
        ch::WIN_IS_MAXIMIZED => json!(crate::win::is_maximized(window)),
        ch::WIN_FIRST_PAINT => {
            crate::win::show_once(window);
            Value::Null
        }
        ch::WIN_MOUNTED => {
            crate::crash::note_mounted(window.label());
            Value::Null
        }

        // ── fs / dialog ─────────────────────────────────────────────────────
        ch::DIR_EXISTS => {
            let ok = arg(p, 0)
                .as_str()
                .map(|d| std::path::Path::new(d).is_dir())
                .unwrap_or(false);
            json!(ok)
        }
        ch::PICK_DIRECTORY => pick_directory(app),

        // ── 계정 (읽기 전용 — 토큰 복호 없이 표시용 메타만) ─────────────────
        ch::AUTH_LIST_ACCOUNTS => list_claude_accounts(),
        ch::CODEX_LIST_ACCOUNTS => list_codex_accounts(),

        _ => unimplemented(),
    }
}

// ── 엔진 버전 상태 ───────────────────────────────────────────────────────────
fn auto_update() -> bool {
    // 2.6.2: 파일이 없거나 깨졌으면 켬(기본값), enabled === false 일 때만 끔
    ccg_store::read_home_json("engine-auto-update.json")
        .and_then(|v| v.get("enabled").and_then(Value::as_bool))
        .unwrap_or(true)
}

/// 대략적인 semver 내림차순 (2.6.2 compareVersionsDesc와 같은 자릿수 비교)
fn cmp_desc(a: &str, b: &str) -> std::cmp::Ordering {
    let pa: Vec<i64> = a.split('.').map(|x| x.parse().unwrap_or(0)).collect();
    let pb: Vec<i64> = b.split('.').map(|x| x.parse().unwrap_or(0)).collect();
    for i in 0..pa.len().max(pb.len()) {
        let d = pb.get(i).copied().unwrap_or(0) - pa.get(i).copied().unwrap_or(0);
        if d != 0 {
            return d.cmp(&0);
        }
    }
    std::cmp::Ordering::Equal
}

/// 앱 홈에 버전별로 깔린 엔진 CLI의 실제 설치 상태. `bundled`는 3.0에 없다 —
/// 2.6.2는 앱에 SDK를 번들해 폴백으로 썼지만, 3.0은 Rust가 CLI를 직접 몬다(M3).
fn engine_state(dir: &str, config: &str, package: &str) -> Value {
    let home = ccg_store::app_home();
    let root = home.join(dir);
    let mut installed: Vec<String> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&root) {
        for e in entries.flatten() {
            if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            // 진짜 설치본인지 = node_modules/<pkg>/package.json의 version이 읽히는지
            let mut pkg_json = root.join(&name).join("node_modules");
            for part in package.split('/') {
                pkg_json = pkg_json.join(part);
            }
            let ok = std::fs::read_to_string(pkg_json.join("package.json"))
                .ok()
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                .and_then(|v| v.get("version").and_then(Value::as_str).map(str::to_string))
                .is_some();
            if ok {
                installed.push(name);
            }
        }
    }
    installed.sort_by(|a, b| cmp_desc(a, b));
    let active = std::fs::read_to_string(home.join(config))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("activeVersion").and_then(Value::as_str).map(str::to_string))
        .filter(|v| installed.contains(v));
    json!({
        "package": package,
        "bundled": "unknown",
        "active": active,
        "installed": installed
    })
}

// ── ui-prefs 브로드캐스트 (2.6.2 uiPrefsSave의 조건을 그대로) ────────────────
struct UiBroadcast {
    glass: Option<f64>,
    lang: String,
}
fn ui_broadcast() -> &'static Mutex<UiBroadcast> {
    static S: OnceLock<Mutex<UiBroadcast>> = OnceLock::new();
    S.get_or_init(|| {
        let prefs = ccg_store::prefs::read_ui_prefs();
        Mutex::new(UiBroadcast {
            glass: prefs.get("ui.glass").and_then(Value::as_f64),
            lang: if prefs.get("ui.lang").and_then(Value::as_str) == Some("en") { "en" } else { "ko" }.into(),
        })
    })
}

/// 유리(벽지 비침)·UI 언어는 **바뀐 저장에만** 전 창으로 뿌린다. 나란히 뜬 아크릴 창의
/// 비침이 어긋나거나 언어가 창마다 다르면 바로 보이기 때문(2.6.2와 같은 조건·같은 채널).
fn broadcast_ui_prefs(app: &AppHandle, prefs: &Value) {
    let mut st = ui_broadcast().lock().unwrap();
    if let Some(g) = prefs.get("ui.glass").and_then(Value::as_f64) {
        if st.glass != Some(g) {
            st.glass = Some(g);
            let _ = app.emit(ch::UI_GLASS_CHANGED, g);
        }
    }
    let lang = if prefs.get("ui.lang").and_then(Value::as_str) == Some("en") { "en" } else { "ko" };
    if st.lang != lang {
        st.lang = lang.to_string();
        let _ = app.emit(ch::UI_LANG_CHANGED, lang);
    }
}

// ── 폴더 선택 ────────────────────────────────────────────────────────────────

/// 지금 열려 있는 네이티브 파일 대화상자 수. 0이 아닐 때만 크래시 복구가
/// 고아 창 정리(아래 `close_orphan_dialogs`)를 위해 Win32 창 목록을 훑는다.
static DIALOGS_OPEN: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn pick_directory(app: &AppHandle) -> Value {
    use std::sync::atomic::Ordering;
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    DIALOGS_OPEN.fetch_add(1, Ordering::SeqCst);
    app.dialog().file().pick_folder(move |p| {
        let _ = tx.send(p);
    });
    let r = rx.recv();
    DIALOGS_OPEN.fetch_sub(1, Ordering::SeqCst);
    match r {
        Ok(Some(p)) => p
            .into_path()
            .map(|pb| json!(pb.to_string_lossy().to_string()))
            .unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

/// **고아 대화상자 정리** — 크래시 복구가 문서를 다시 세우기 직전에 부른다(crash.rs).
///
/// R4 크리틱 A5 실측: 네이티브 '폴더 선택'을 연 채 렌더러가 죽으면 복구는 되는데
/// 대화상자만 화면에 남는다. 받을 렌더러가 없으니 사용자가 폴더를 골라도 아무 일도
/// 안 일어난다 = 사용자가 실물 버그로 제보한 "고아 상태(유령 UI)" 계열이다.
///
/// 우리 프로세스의 **최상위 `#32770`(Win32 대화상자 클래스) 가시 창**에만 `WM_CLOSE`를
/// 보낸다 = 사용자가 '취소'를 누른 것과 같다(rfd 콜백이 `None`으로 깨어나 `pick_folder`가
/// 풀린다). tao가 만드는 우리 창의 클래스는 `Window Class`라 이 그물에 걸리지 않고,
/// 열린 대화상자가 하나도 없으면 창 열거 자체를 하지 않는다.
#[cfg(windows)]
pub fn close_orphan_dialogs() -> usize {
    use std::sync::atomic::Ordering;
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        FindWindowExW, GetWindowThreadProcessId, IsWindowVisible, PostMessageW, WM_CLOSE,
    };
    if DIALOGS_OPEN.load(Ordering::SeqCst) == 0 {
        return 0;
    }
    let me = std::process::id();
    let mut closed = 0usize;
    let mut prev: Option<HWND> = None;
    unsafe {
        // 최상위 창을 클래스로 훑는다(부모 None = 데스크톱의 자식 = 최상위).
        while let Ok(h) = FindWindowExW(None, prev, w!("#32770"), PCWSTR::null()) {
            prev = Some(h);
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(h, Some(&mut pid));
            if pid == me && IsWindowVisible(h).as_bool() && PostMessageW(Some(h), WM_CLOSE, Default::default(), Default::default()).is_ok() {
                closed += 1;
            }
        }
    }
    closed
}

#[cfg(not(windows))]
pub fn close_orphan_dialogs() -> usize {
    0
}

// ── 계정 목록 (스토어 파일만 읽는다 — CLI 스폰·토큰 복호 없음) ───────────────
fn list_claude_accounts() -> Value {
    let Some(f) = ccg_store::read_home_json("accounts.json") else { return json!([]) };
    // v3가 현재 포맷, v2도 계정 모양이 같아 읽는다(2.6.2 readStoreFile과 동일)
    let version = f.get("version").and_then(Value::as_u64).unwrap_or(0);
    if version != 3 && version != 2 {
        return json!([]);
    }
    let empty = vec![];
    let accounts = f.get("accounts").and_then(Value::as_array).unwrap_or(&empty);
    let emails: Vec<&str> = accounts
        .iter()
        .filter_map(|a| a.get("email").and_then(Value::as_str))
        .collect();
    // 기본 계정: defaultEmail이 목록에 있으면 그것, 아니면 첫 계정("기본 없음"은 안 만든다)
    let default_email = f
        .get("defaultEmail")
        .and_then(Value::as_str)
        .filter(|d| emails.contains(d))
        .or_else(|| emails.first().copied());
    let out: Vec<Value> = accounts
        .iter()
        .filter_map(|a| {
            let email = a.get("email").and_then(Value::as_str)?;
            let mut o = serde_json::Map::new();
            o.insert("email".into(), json!(email));
            if let Some(sub) = a.get("subscriptionType").and_then(Value::as_str) {
                o.insert("subscriptionType".into(), json!(sub));
            }
            o.insert("isDefault".into(), json!(Some(email) == default_email));
            Some(Value::Object(o))
        })
        .collect();
    json!(out)
}

fn list_codex_accounts() -> Value {
    let Some(f) = ccg_store::read_home_json("codex-accounts.json") else { return json!([]) };
    if f.get("version").and_then(Value::as_u64).unwrap_or(0) != 1 {
        return json!([]);
    }
    let empty = vec![];
    let accounts = f.get("accounts").and_then(Value::as_array).unwrap_or(&empty);
    let emails: Vec<&str> = accounts
        .iter()
        .filter_map(|a| a.get("email").and_then(Value::as_str))
        .collect();
    let default_email = f
        .get("defaultEmail")
        .and_then(Value::as_str)
        .filter(|d| emails.contains(d))
        .or_else(|| emails.first().copied());
    let out: Vec<Value> = accounts
        .iter()
        .filter_map(|a| {
            let email = a.get("email").and_then(Value::as_str)?;
            Some(json!({
                "email": email,
                "plan": a.get("plan").and_then(Value::as_str),
                "isDefault": Some(email) == default_email
            }))
        })
        .collect();
    json!(out)
}

/// M2 이후 창 라우팅이 쓸 헬퍼 — 라벨로 창을 찾아 같은 채널로 이벤트를 보낸다.
#[allow(dead_code)]
pub fn emit_to_window(app: &AppHandle, label: &str, channel: &str, payload: Value) {
    if app.get_webview_window(label).is_some() {
        let _ = app.emit_to(label, channel, payload);
    }
}
