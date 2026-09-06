//! 파일시스템 · 네이티브 대화상자 · 계정 목록(읽기 전용). (ipc.rs에서 분리 — 동작 불변)

use super::{arg, ch};
use serde_json::{json, Value};
use tauri::AppHandle;

pub fn dispatch(app: &AppHandle, channel: &str, p: &Value) -> Option<Value> {
    Some(match channel {
        ch::DIR_EXISTS => {
            let ok = arg(p, 0)
                .as_str()
                .map(|d| std::path::Path::new(d).is_dir())
                .unwrap_or(false);
            json!(ok)
        }
        ch::PICK_DIRECTORY => pick_directory(app),
        "engine-environment:pick-path" => pick_engine_environment_path(app, arg(p, 0)),

        // ── 계정 (읽기 전용 — 토큰 복호 없이 표시용 메타만) ─────────────────
        ch::AUTH_LIST_ACCOUNTS => list_claude_accounts(),
        ch::CODEX_LIST_ACCOUNTS => list_codex_accounts(),

        _ => return None,
    })
}

// ── 폴더 선택 ────────────────────────────────────────────────────────────────

/// 지금 열려 있는 네이티브 파일 대화상자 수. 0이 아닐 때만 크래시 복구가
/// 고아 창 정리(아래 `close_orphan_dialogs`)를 위해 Win32 창 목록을 훑는다.
static DIALOGS_OPEN: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// 대화상자가 열려 있는 구간의 RAII 표식. 계수기를 **공유**해야 `close_orphan_dialogs`의
/// 그물이 첨부 picker(`ipc/parity/dialog.rs`)까지 덮는다 — 계수기를 따로 두면 그쪽이
/// 열려 있는 동안 렌더러가 죽었을 때 아래 정리가 0으로 조기 반환해 유령 창이 남는다.
pub struct DialogGuard;

impl DialogGuard {
    pub fn new() -> DialogGuard {
        DIALOGS_OPEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        DialogGuard
    }
}

impl Drop for DialogGuard {
    fn drop(&mut self) {
        DIALOGS_OPEN.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// 네이티브 대화상자를 붙일 **부모 창**. 2.6.2는 이벤트의 sender 창을 쓰고 없으면
/// 메인 창으로 떨어진다(`BrowserWindow.fromWebContents(_e.sender) ?? mainWindow`).
/// 3.0의 dispatch에는 보낸 창이 안 실려 오므로 **포커스된 창**이 그 자리를 대신한다 —
/// 대화상자를 여는 것은 사용자가 방금 클릭한 창이기 때문이다.
pub(crate) fn dialog_parent(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    use tauri::Manager;
    app.webview_windows()
        .values()
        .find(|w| w.is_focused().unwrap_or(false))
        .cloned()
        .or_else(|| app.get_webview_window(crate::win::MAIN))
}

/// 폴더 선택 창의 제목. 2.6.2 `src/main/index.ts:1339`에서 **글자 그대로** 옮겼다.
///
/// ★HOSTI18N R1 — 초판은 이 제목이 **아예 없었다**. 문구가 한국어로 굳은 게 아니라
/// 2.6.2가 주던 제목을 통째로 잃어서 OS 기본 제목이 떴다(확인 크리틱 R1 §4.2-2).
/// `const`가 아니라 `fn`인 이유는 `ipc/parity/dialog.rs`의 `labels()`와 같다 —
/// 호출 시점 평가라야 설정에서 바꾼 언어가 다음 창부터 따라온다.
pub(crate) fn pick_directory_title() -> String {
    ccg_fs::t("작업할 프로젝트 폴더 선택", "Choose a project folder to work in")
}

fn pick_directory(app: &AppHandle) -> Value {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    let guard = DialogGuard::new();
    // ★HOSTI18N R2(확인 크리틱 R1-D1) — **부모를 건다.**
    //
    // R1은 "플러그인에 부모 지정이 없다(rfd `set_parent` 미노출)"며 이월했다. **거짓이었다.**
    // `tauri-plugin-dialog-2.7.2`의 `set_parent`는 우리가 이미 쓰는 `set_title` **바로 옆**
    // 공개 메서드이고(`lib.rs:464`), `desktop.rs:99-102`가 `pick_folder`를 포함한 모든
    // `pick_*` 변환에 적용한다. 같은 거짓 전제가 `ipc/parity/dialog.rs` 헤더에도
    // SMALL3 R1부터 실려 있었다 — 거기도 같이 고쳤다.
    //
    // 부모는 **사용자가 방금 누른 창**이다(2.6.2 `BrowserWindow.fromWebContents(_e.sender)`).
    // 3.0의 `dispatch(app, channel, p)`에는 보낸 창이 안 실려 오므로 **포커스된 창**으로
    // 대신하고, 없으면 메인 창으로 떨어진다 — 2.6.2의 `?? mainWindow` 폴백과 같은 자리다.
    let b = app.dialog().file().set_title(pick_directory_title());
    let b = match dialog_parent(app) {
        Some(w) => b.set_parent(&w),
        None => b,
    };
    b.pick_folder(move |p| {
        let _ = tx.send(p);
    });
    let r = rx.recv();
    drop(guard);
    match r {
        Ok(Some(p)) => p
            .into_path()
            .map(|pb| json!(pb.to_string_lossy().to_string()))
            .unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

fn pick_engine_environment_path(app: &AppHandle, options: &Value) -> Value {
    use tauri_plugin_dialog::DialogExt;
    let folder = match options.get("kind").and_then(Value::as_str) {
        Some("cliPath") => false,
        Some("configDir") => true,
        _ => return json!({ "error": "Unknown path type" }),
    };
    let title = if folder {
        ccg_fs::t("설정 폴더 선택", "Choose configuration folder")
    } else {
        ccg_fs::t("CLI 실행 파일 선택", "Choose CLI executable")
    };
    let mut picker = app.dialog().file().set_title(title);
    if let Some(parent) = dialog_parent(app) {
        picker = picker.set_parent(&parent);
    }
    // Open at the current path, or the nearest existing parent of a typed path.
    let initial = std::path::Path::new(options.get("defaultPath").and_then(Value::as_str).unwrap_or("").trim());
    if initial.is_absolute() {
        if let Some(dir) = initial.ancestors().find(|p| p.is_dir()) {
            picker = picker.set_directory(dir);
        }
        if !folder && initial.is_file() {
            if let Some(name) = initial.file_name() {
                picker = picker.set_file_name(name.to_string_lossy());
            }
        }
    }
    #[cfg(windows)]
    if !folder {
        picker = picker
            .add_filter(ccg_fs::t("실행 파일", "Executables"), &["exe", "cmd", "bat", "com"])
            .add_filter(ccg_fs::t("모든 파일", "All files"), &["*"]);
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let _guard = DialogGuard::new();
    if folder {
        picker.pick_folder(move |path| { let _ = tx.send(path); });
    } else {
        picker.pick_file(move |path| { let _ = tx.send(path); });
    }
    match rx.recv() {
        Ok(Some(path)) => path.into_path().map(|p| json!(p.to_string_lossy())).unwrap_or(Value::Null),
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
            if pid == me
                && IsWindowVisible(h).as_bool()
                && PostMessageW(Some(h), WM_CLOSE, Default::default(), Default::default()).is_ok()
            {
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
/// `pub(super)`인 이유: 쓰기 채널(`ipc/accounts.rs` — 로그인·로그아웃·기본·순서)이
/// **같은 함수로** 새 목록을 만들어 돌려줘야 한다. 렌더러는 그 반환값으로 화면 상태를
/// 통째로 갈아끼우므로(`Settings.tsx:457`), 모양을 두 곳에서 조립하면 한쪽만 `needsLogin`을
/// 빠뜨리는 순간 "삭제하고 나니 재로그인 배지가 사라진다" 같은 유령이 태어난다.
pub(super) fn list_claude_accounts() -> Value {
    // ★R28 ACCT R2(F3) — 이 목록은 파일을 **직접** 읽는다(모양을 한 곳에서 만들기 위해).
    // 그래서 `ccg_auth`의 마이그레이션을 안 지나고, R1에서는 옛 `defaultEmail` 순서를
    // 그대로 돌려줬다 — 업그레이드 첫 세션의 화면·새 채팅이 통째로 옛 1번째 계정이었다.
    // 부팅에서도 한 번 부르지만(`main.rs`), 여기가 **읽기 직전**이라 순서를 보장한다
    // (프로세스당 1회 CAS라 두 번째부터는 아무 일도 안 한다).
    ccg_auth::claude::ensure_default_migrated();
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
    // ★R28 ACCT §4 — 기본 계정 = **맨 위**(파생값). `defaultEmail`은 안 읽는다.
    // 이 목록이 렌더러의 `AccountInfo.isDefault`를 통째로 정하므로, 여기가 파생값으로
    // 바뀌는 순간 새 채팅·오버라이드·picker가 전부 「맨 위」를 따른다(파급 전수 ①).
    let default_email = emails.first().copied();
    // ★M11 R3(F2) — 재로그인 대기 표식(`account-health.json`). 자동 전환 워커가 토큰
    // 교환 실패를 만난 순간 적고, 재로그인하면 지문이 달라져 스스로 무효가 된다.
    // 이 목록이 그 사실이 사용자에게 닿는 **유일한 경로**다(R2까지는 stderr 한 줄뿐이었다).
    let sick = ccg_auth::health::needs_login_emails();
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
            if sick.iter().any(|e| e == email) {
                o.insert("needsLogin".into(), json!(true));
            }
            Some(Value::Object(o))
        })
        .collect();
    json!(out)
}

/// `pub(super)`인 이유는 [`list_claude_accounts`]와 같다 — Codex 쓰기 채널
/// (`ipc/accounts.rs`의 로그인·로그아웃·맨 위로·순서)이 **같은 함수로** 새 목록을 만들어
/// 돌려줘야 렌더러가 받는 모양이 조회와 한 벌이다.
pub(super) fn list_codex_accounts() -> Value {
    // ★R28 ACCT R2(F3) — Anthropic 축과 같은 이유(위 참고).
    ccg_auth::codex::ensure_default_migrated();
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
    // ★R28 ACCT §4 — Codex 축도 「맨 위 = 기본」.
    let default_email = emails.first().copied();
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

// ─────────────────────────────────────────────────────────────────────────────
// ★HOSTI18N R1 — 호스트 문구가 `ui.lang`을 따르는가
//
// 확인 크리틱 R1·R2가 두 라운드 연속 「남은 최대 격차」로 지목한 §3.4-A의 **실물 세 자리**를
// 이 라운드가 닫았다. 못은 SMALL3(`ipc/parity/dialog.rs`)에서 세운 문법을 그대로 쓴다:
//
//   ① 격리 홈 실측 — 언어마다 **자식 프로세스**를 띄운다. `ccg_fs::t`의 언어 판정은 2초
//      TTL의 프로세스 전역 캐시라 한 프로세스에서 두 언어를 볼 수 없다.
//   ② 동결 원문 대조 — en을 우리가 지어내지 않았음을 `src/main/index.ts`에서 읽어 증명한다.
//   ③ 소스 훑기 — 셸이 사용자에게 보내는 `error` 필드에 생 한국어가 다시 안 생기게.
//
// 문구가 네 모듈(`ipc/lsp.rs`·`ipc/system.rs`·`win.rs`·`popout.rs`)에 흩어져 있어 각자
// 못을 두면 자식 프로세스가 넷이 된다. 그래서 **여기 한 곳**에 모으고 각 함수를
// `pub(crate)`로 열었다.
#[cfg(test)]
mod hosti18n_tests {
    use std::path::{Path, PathBuf};

    const CHILD_ENV: &str = "CCG_HOSTI18N_CHILD";
    const CHILD_TEST: &str = "ipc::system::hosti18n_tests::child_prints_the_host_strings";
    const MARK: &str = "HOSTI18N>";

    /// 이 라운드가 닫은 자리 전부. `필드=문구`로 찍어 **순서에 안 기댄다**
    /// (SMALL3 R3가 배운 것 — 위치 대응은 못 안에도 만들지 않는다).
    fn sites() -> Vec<(&'static str, String)> {
        vec![
            ("verse", crate::ipc::lsp::verse_out_of_scope()),
            ("pickdir", super::pick_directory_title()),
            ("win_chat", crate::win::session_window_title(false)),
            ("win_btw", crate::win::session_window_title(true)),
            ("panel", crate::win::popout::panel_window_title()),
        ]
    }

    /// 자식 역할 — `CHILD_ENV`가 있을 때만 일한다.
    #[test]
    #[ignore = "부모(the_host_strings_follow_ui_lang)가 격리 홈과 함께 직접 띄운다"]
    fn child_prints_the_host_strings() {
        if std::env::var(CHILD_ENV).is_err() {
            return;
        }
        let line: Vec<String> = sites().into_iter().map(|(k, v)| format!("{k}={v}")).collect();
        println!("{MARK}{}", line.join("\t"));
    }

    /// `ui.lang` 하나만 든 격리 홈에서 자식을 돌려 `필드=문구`를 받아 온다.
    /// 사용자 실홈은 읽지도 복사하지도 않는다 — `%TEMP%`에 새로 만들고 지운다.
    fn sites_under(tag: &str, lang: Option<&str>) -> Vec<(String, String)> {
        let home = std::env::temp_dir().join(format!(
            "ccg-hosti18n-{tag}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
        ));
        std::fs::create_dir_all(&home).expect("격리 홈을 못 만들었다");
        if let Some(l) = lang {
            std::fs::write(home.join("ui-prefs.json"), format!("{{\"ui.lang\":\"{l}\"}}"))
                .expect("ui-prefs.json을 못 썼다");
        }
        let out = std::process::Command::new(std::env::current_exe().expect("테스트 바이너리"))
            .args(["--exact", CHILD_TEST, "--nocapture", "--include-ignored"])
            .env(CHILD_ENV, "1")
            .env("CCG_HOME", &home)
            .output()
            .expect("자식 프로세스를 못 띄웠다");
        let _ = std::fs::remove_dir_all(&home);
        let text = String::from_utf8_lossy(&out.stdout).into_owned();
        let line = text
            .lines()
            .find_map(|l| l.strip_prefix(MARK))
            .unwrap_or_else(|| panic!("자식이 문구를 안 찍었다 ({tag}):\n{text}"));
        line.split('\t')
            .map(|kv| {
                let (k, v) = kv.split_once('=').unwrap_or_else(|| panic!("이름표가 없다: {kv}"));
                (k.to_string(), v.to_string())
            })
            .collect()
    }

    fn expect_pairs(words: [&str; 5]) -> Vec<(String, String)> {
        ["verse", "pickdir", "win_chat", "win_btw", "panel"]
            .iter()
            .zip(words)
            .map(|(k, w)| (k.to_string(), w.to_string()))
            .collect()
    }

    /// 못 ① — 다섯 자리가 전부 `ui.lang`을 따른다(격리 홈 실측).
    ///
    /// 크리틱이 지목한 증상이 여기다: en 사용자가 「Verse 서버 지정」을 누르면 한국어
    /// 한 문장을 받고, 둘째 채팅 창은 제목 표시줄이 한국어였다.
    #[test]
    fn the_host_strings_follow_ui_lang() {
        let ko = expect_pairs([
            "Verse 서버 지정은 3.0에서 아직 제공하지 않아요",
            "작업할 프로젝트 폴더 선택",
            "추가 채팅 — AgentCodeGUI",
            "btw 질문 — AgentCodeGUI",
            "패널 — AgentCodeGUI",
        ]);
        let en = expect_pairs([
            "Setting a Verse server isn't available in 3.0 yet",
            "Choose a project folder to work in",
            "Extra chat — AgentCodeGUI",
            "btw question — AgentCodeGUI",
            "Panel — AgentCodeGUI",
        ]);
        assert_eq!(sites_under("en", Some("en")), en, "★ui.lang=en인데 영어가 아니다");
        assert_eq!(sites_under("ko", Some("ko")), ko, "ui.lang=ko가 한국어가 아니다");
        // 무변 확인 — 언어를 한 번도 안 고른 홈은 예전과 같이 한국어다.
        assert_eq!(sites_under("default", None), ko, "기본(설정 없음)이 한국어가 아니다");
    }

    fn repo(rel: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join(rel)
    }

    /// 못 ② — **en을 우리가 지어내지 않았다.** 동결 구역 `src/main/index.ts`에서 읽어 대조한다.
    ///
    /// 넷은 2.6.2에 원문이 있고(폴더 선택 제목 · 창 제목 셋), `verse`만 **3.0 전용**이라
    /// 대조할 원문이 없다. 그 사실 자체를 여기 적어 둔다 — 나중에 누가 "왜 verse만
    /// 빠졌나"를 다시 묻지 않도록.
    #[test]
    fn the_en_strings_came_from_the_frozen_262_source() {
        let ts = std::fs::read_to_string(repo("../src/main/index.ts")).expect("동결 원문을 못 읽었다");
        // ★en을 **우리 소스에서 읽어** 2.6.2와 맞춘다.
        //
        // 초판은 기대값 넷을 이 못 안에 적어 두고 "2.6.2에 그게 있나"만 봤다. 그러면
        // 우리 쪽 en이 표류해도 안 걸린다 — 실제로 변이 H4(`Choose a project folder to
        // work in` → `Choose a folder`)에서 이 못이 **조용히 통과**했다(실측 못만 붉었다).
        // SMALL3 R3가 배운 것과 같은 함정이다: 기대값을 못 안에 두면 문구와 기대값을
        // 같이 바꾸는 손을 못 막는다. 그래서 **양쪽 다 파일에서 읽어** 대조한다.
        for (rel, ko) in [
            ("src/ipc/system.rs", "작업할 프로젝트 폴더 선택"),
            ("src/win.rs", "추가 채팅 — AgentCodeGUI"),
            ("src/win.rs", "btw 질문 — AgentCodeGUI"),
            ("src/popout.rs", "패널 — AgentCodeGUI"),
        ] {
            let ours = std::fs::read_to_string(repo(rel)).unwrap_or_else(|e| panic!("{rel}: {e}"));
            let needle = format!("ccg_fs::t(\"{ko}\", \"");
            let at = ours
                .find(&needle)
                .unwrap_or_else(|| panic!("★`{rel}`에 `ccg_fs::t(\"{ko}\", …)`가 없다"));
            let rest = &ours[at + needle.len()..];
            let en = &rest[..rest.find('"').expect("en 인자가 안 닫혔다")];
            let want = format!("t('{ko}', '{en}')");
            assert!(
                ts.contains(&want),
                "★우리 en(`{en}`)이 2.6.2 원문과 다르다 — `{rel}`의 `{ko}`.\n\
                 2.6.2 `src/main/index.ts`에 `{want}`가 없다(표류했거나 지어냈다)."
            );
        }
        // verse만 3.0 전용이다(2.6.2에는 Verse 지정이 실재하므로 대응 문구가 없다).
        assert!(
            !ts.contains("Verse 서버 지정은 3.0에서"),
            "2.6.2에 이 문구가 생겼다면 거기서 옮겨 와야 한다(지금은 3.0 전용이라 우리가 정했다)"
        );
    }

    /// 못 ③ — 셸이 사용자에게 보내는 값에 **한국어가 실려 나가지 않는다**(값 기준).
    ///
    /// 렌더러는 `r.error ?? t(…)` 꼴로 받으므로 **셸이 문자열을 실어 보내는 순간 번역문은
    /// 폴백으로 밀린다** — 즉 셸이 한국어를 보내면 en 사용자가 한국어를 본다. 그 부류를
    /// 통째로 막는 그물이다.
    ///
    /// ★HOSTI18N R2(확인 크리틱 R1-D4) — **모양에서 값으로 바꿨다.**
    ///
    /// R1의 못은 `"error"`와 한국어가 **같은 줄**에 있을 때만 봤다. 크리틱이 회피 다섯을
    /// 걸었더니 S0(한 줄) 하나만 잡고 **나머지 넷이 전부 통과**했다. 더 나쁜 것은
    /// **S2(변수 경유)가 가설이 아니라 실물**이었다는 점이다 — `accounts.rs`의
    /// `NO_BIN`·`NO_CODEX_BIN`이 정확히 그 모양으로 그물을 빠져나가 있었다(R2가 닫았다).
    /// S1(줄바꿈)은 적대적이지 않아도 난다: 줄이 길어지면 **rustfmt가 접는다**.
    /// (실제로 이 라운드에서 `dialog.rs`의 배선 못이 같은 이유로 헛디뎠다 — §R2-3.)
    ///
    /// 그래서 이제 이렇게 잰다:
    ///   ⓐ **키를 넓혔다** — `error`·`message`·`reason`(렌더러가 문구로 그리는 것들).
    ///   ⓑ **같은 줄 제약을 풀었다** — 키 뒤의 **값 표현식 전체**를 괄호 깊이로 잘라 본다.
    ///   ⓒ **값을 본다** — 직접 리터럴 · `\u{…}` 이스케이프(디코드해서 판정) ·
    ///      **한국어를 담은 심볼**(`const`/`static`/`let`)이 그 자리에 오는지.
    ///   ⓓ **`crates/`까지 걷는다**(R1은 `src-tauri`만 걸었다).
    ///
    /// `ccg_fs::t(`가 값 안에 있으면 면제한다 — 그게 이 라운드의 처방이기 때문이다.
    ///
    /// **한계**(감추지 않는다): 값이 **함수 호출**을 거치면 그 함수 본문까지 따라가지 않는다.
    /// 지금 트리의 헬퍼는 전부 `ccg_fs::t`로 감싸져 있어 실물 구멍은 없지만, 누군가
    /// `fn f() -> String { "한국어".into() }`를 만들어 `"error": f()`로 쓰면 이 못은 조용하다.
    /// 심볼(ⓒ)까지가 이번 라운드의 사정거리다.
    #[test]
    fn the_shell_never_sends_a_raw_korean_value_to_the_renderer() {
        /// 아직 못 고친 자리 — **왜 남았는지와 언제 닫는지**를 함께 적는다.
        /// 목록에 있는데 **안 걸리면 그것도 실패**다(고쳐졌으면 목록에서 지워야 한다).
        const CARRIED_OVER: &[(&str, &str, &str)] = &[
            // ★R2 갱신: `ccg-lsp`의 쌍둥이 문구와 `install.rs`의 제거 실패 문구는 **닫혔다**.
            // 전자는 이 라운드가(LSPDIST 종결로 접촉 금지가 풀렸다), 후자는 LSPDIST가
            // 자기 마감에서(`f0a3496` — en은 동결 `src/main/lsp/install.ts:195` 원문 그대로).
            // 그래서 목록에서 **지웠다** — 아래 자기검증이 "있는데 안 걸리면 실패"이므로
            // 지우지 않으면 이 못이 붉어진다(목록이 썩지 않게 하는 장치가 그것이다).
            (
                "ccg-engine/src/runtime.rs",
                "사용자가 중지했습니다",
                "§6.1이 이월한 `runtime.rs` 38건 덩어리의 일부 — 매 턴 보이는 채팅 기록이라 \
                 표 분리(`labels()` 모양)가 맞다. 별도 라운드",
            ),
            (
                "ccg-engine/src/runtime.rs",
                "거부",
                "위와 같은 덩어리(같은 라운드에서 함께)",
            ),
            (
                "ccg-store/src/migrate_v3.rs",
                "스테이징 디렉터리 생성 실패",
                "마이그레이션 **리포트** 문구다 — 사용자 UI가 아니라 진단 기록이라 성격이 다르다. \
                 HOSTI18N R1 §6.1이 이미 이 판단을 적었다",
            ),
            (
                "ccg-store/src/migrate_v3.rs",
                "채팅 파일 쓰기 실패",
                "위와 같음",
            ),
        ];

        fn has_ko(s: &str) -> bool {
            s.chars().any(|c| ('가'..='힣').contains(&c))
        }
        /// `\u{cca8}` 같은 이스케이프를 풀어 본다(크리틱의 S3 회피).
        fn decode_escapes(s: &str) -> String {
            let mut out = String::new();
            let b: Vec<char> = s.chars().collect();
            let mut i = 0;
            while i < b.len() {
                if b[i] == '\\' && i + 2 < b.len() && b[i + 1] == 'u' && b[i + 2] == '{' {
                    if let Some(close) = b[i + 3..].iter().position(|c| *c == '}') {
                        let hex: String = b[i + 3..i + 3 + close].iter().collect();
                        if let Ok(n) = u32::from_str_radix(&hex, 16) {
                            if let Some(c) = char::from_u32(n) {
                                out.push(c);
                            }
                        }
                        i += 3 + close + 1;
                        continue;
                    }
                }
                out.push(b[i]);
                i += 1;
            }
            out
        }
        /// 키 뒤의 **값 표현식**을 괄호 깊이로 잘라 온다(줄바꿈을 넘어간다 = S1 방어).
        fn value_after(src: &str, key_at: usize, key_len: usize) -> Option<&str> {
            let rest = &src[key_at..];
            // **JSON 키일 때만** 본다: 키 바로 뒤(공백만 건너뛰고)가 `:`여야 한다.
            // `out["error"] = …` 같은 **인덱싱**은 여기서 걸러진다 — 안 그러면 멀리 있는
            // 다음 `:`를 값의 시작으로 잘못 잡아 파일 끝까지 삼킨다(초판이 그랬다).
            let after_key = &rest[key_len..];
            let colon = after_key.len() - after_key.trim_start().len();
            if !after_key[colon..].starts_with(':') {
                return None;
            }
            let body = &after_key[colon + 1..];
            // 값 표현식이 이 정도를 넘으면 우리가 파싱을 놓친 것이다 — 잘라서 폭주를 막는다.
            // **문자 경계로** 자른다(바이트로 자르면 한국어 한가운데를 갈라 패닉한다).
            let cut = body.char_indices().nth(400).map(|(i, _)| i).unwrap_or(body.len());
            let body = &body[..cut];
            let (mut depth, mut in_str, mut esc) = (0i32, false, false);
            for (i, c) in body.char_indices() {
                if in_str {
                    if esc {
                        esc = false;
                    } else if c == '\\' {
                        esc = true;
                    } else if c == '"' {
                        in_str = false;
                    }
                    continue;
                }
                match c {
                    '"' => in_str = true,
                    '(' | '[' | '{' => depth += 1,
                    ')' | ']' | '}' => {
                        if depth == 0 {
                            return Some(&body[..i]);
                        }
                        depth -= 1;
                    }
                    ',' if depth == 0 => return Some(&body[..i]),
                    _ => {}
                }
            }
            Some(body)
        }

        // 훑을 파일 — 셸 + 크레이트(테스트 구역은 뺀다).
        fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
                if p.is_dir() {
                    if name != "target" && !name.starts_with("target-") && name != "tests" && name != "bin" {
                        walk(&p, out);
                    }
                } else if p.extension().is_some_and(|x| x == "rs") {
                    out.push(p);
                }
            }
        }
        let mut files = Vec::new();
        walk(&repo("src"), &mut files);
        walk(&repo("../crates"), &mut files);
        assert!(files.len() > 40, "훑기가 파일을 거의 못 찾았다({}개)", files.len());

        let mut bad: Vec<String> = Vec::new();
        let mut seen_carried: Vec<usize> = Vec::new();

        for f in &files {
            let Ok(raw) = std::fs::read_to_string(f) else { continue };
            // 제품 구역만 + 주석은 지운다(줄 번호는 유지되게 빈 줄로 바꾼다).
            let head = raw.find("#[cfg(test)]").map(|i| &raw[..i]).unwrap_or(raw.as_str());
            let src: String = head
                .lines()
                .map(|l| if l.trim_start().starts_with("//") { "" } else { l })
                .collect::<Vec<_>>()
                .join("\n");

            // ⓒ 한국어를 담은 심볼 이름을 먼저 모은다(변수 경유 = 크리틱의 S2).
            // `const`/`static`은 파일 전역, `let`은 **선언 근처만**(스코프 근사).
            // 파일 단위로 `let`을 전역 취급하면 같은 이름의 **다른 변수**가 멀리서 걸린다
            // (초판이 `transcode.rs`에서 그렇게 셋을 오검출했다 — 선언은 :802인데
            //  적중은 :607, 즉 선언보다 **앞**이었다).
            const LET_SCOPE_LINES: usize = 40;
            let mut syms: Vec<(String, Option<usize>)> = Vec::new();
            for (ln, line) in src.lines().enumerate() {
                if !has_ko(&decode_escapes(line)) || line.contains("ccg_fs::t(") {
                    continue;
                }
                for kw in ["const ", "static ", "let "] {
                    // **줄 맨 앞이 아니라 줄 안 어디서든** 찾는다.
                    // 초판은 `trim_start().strip_prefix(kw)`라 줄 첫 토큰만 봤고, 그래서
                    // 크리틱의 S2(`… => { let m = "한국어"; … "error": m }`)를 **놓쳤다**
                    // (실물 `const NO_CODEX_BIN`은 줄 첫 토큰이라 잡혔던 것뿐이다).
                    let mut from = 0usize;
                    while let Some(rel) = line[from..].find(kw) {
                        let at = from + rel;
                        from = at + kw.len();
                        // 단어 경계 — `varlet `·`sublet ` 같은 꼬리를 키워드로 읽지 않는다.
                        if line[..at].chars().last().is_some_and(|c| c.is_alphanumeric() || c == '_') {
                            continue;
                        }
                        let name: String = line[at + kw.len()..]
                            .trim_start()
                            .trim_start_matches("mut ")
                            .chars()
                            .take_while(|c| c.is_alphanumeric() || *c == '_')
                            .collect();
                        if !name.is_empty() {
                            syms.push((name, if kw == "let " { Some(ln) } else { None }));
                        }
                    }
                }
            }

            for key in ["\"error\"", "\"message\"", "\"reason\""] {
                let mut from = 0usize;
                while let Some(rel) = src[from..].find(key) {
                    let at = from + rel;
                    from = at + key.len();
                    let Some(val) = value_after(&src, at, key.len()) else { continue };
                    if val.contains("ccg_fs::t(") {
                        continue; // 감쌌으면 통과 — 그게 처방이다
                    }
                    let decoded = decode_escapes(val);
                    // 심볼 매칭은 **문자열 리터럴을 걷어낸 뒤** 한다. 안 그러면 값 안의
                    // `"message"` 같은 **키 이름**이 같은 이름의 변수와 겹쳐 거짓 양성이 된다
                    // (초판이 `transcode.rs`에서 영어 값 다섯을 그렇게 잡았다).
                    let code_only = {
                        let (mut out, mut in_str, mut esc) = (String::new(), false, false);
                        for c in val.chars() {
                            if in_str {
                                if esc {
                                    esc = false;
                                } else if c == '\\' {
                                    esc = true;
                                } else if c == '"' {
                                    in_str = false;
                                    out.push(' ');
                                }
                                continue;
                            }
                            if c == '"' {
                                in_str = true;
                            } else {
                                out.push(c);
                            }
                        }
                        out
                    };
                    let line_no = src[..at].matches('\n').count() + 1;
                    let by_sym = syms.iter().find(|(name, decl)| {
                        // `let`은 **선언 이후 가까운 범위**에서만 인정한다(스코프 근사).
                        if let Some(d) = decl {
                            if line_no + 1 <= *d || line_no > d + LET_SCOPE_LINES {
                                return false;
                            }
                        }
                        code_only.split(|c: char| !(c.is_alphanumeric() || c == '_')).any(|w| w == name.as_str())
                    });
                    if !has_ko(&decoded) && by_sym.is_none() {
                        continue;
                    }
                    let path = f.display().to_string().replace('\\', "/");
                    let hit = format!("{path}:{line_no}  {key} ← {}", val.trim().replace('\n', " ⏎ "));
                    // 이월 목록에 있으면 통과시키되 **봤다고 기록**한다.
                    match CARRIED_OVER.iter().position(|(p, s, _)| path.contains(p) && val.contains(s))
                    {
                        Some(i) => seen_carried.push(i),
                        None => bad.push(hit),
                    }
                }
            }
        }

        assert!(
            bad.is_empty(),
            "★셸이 렌더러로 한국어 값을 보낸다({}건) — `ccg_fs::t(ko, en)`으로 감싸라.\n렌더러는 `r.error ?? t(…)`라 셸 문자열이 번역문을 이긴다:\n{}",
            bad.len(),
            bad.join("\n")
        );
        // 이월 목록이 썩지 않게: 고쳐졌으면 목록에서 지워야 한다.
        for (i, (p, s, why)) in CARRIED_OVER.iter().enumerate() {
            assert!(
                seen_carried.contains(&i),
                "이월 목록의 `{p}` / `{s}`가 이제 안 걸린다 — 고쳐졌으면 목록에서 지워라(사유: {why})"
            );
        }
    }
    /// 못 ④ — **호출부가 정말 그 헬퍼를 쓰는가**(배선).
    ///
    /// ★SMALL3 R2의 D2가 가르친 것을 그대로 옮긴 자리다. 못 ①은 헬퍼를 **직접** 부르므로
    /// 헬퍼만 멀쩡하면 초록이다 — 즉 `set_title(...)` 한 줄을 지우거나 `.title(...)`을
    /// 리터럴로 되돌려도 ①은 아무 말도 안 한다(그때 제품은 다시 깨져 있다).
    /// 그래서 **호출부를 소스로 재는** 못을 따로 둔다.
    #[test]
    fn the_call_sites_use_the_translated_helpers() {
        // (파일, 제품 구역에 반드시 있어야 하는 배선, 사람이 읽을 이름)
        for (rel, wiring, what) in [
            ("src/ipc/lsp.rs", "\"error\": verse_out_of_scope()", "Verse 지정 버튼의 사유"),
            ("src/ipc/lsp.rs", "\"error\": ccg_fs::t(", "설치 대상 없음 사유"),
            ("src/ipc/system.rs", ".set_title(pick_directory_title())", "폴더 선택 창 제목"),
            ("src/win.rs", ".title(session_window_title(", "둘째 채팅 창 제목"),
            ("src/popout.rs", ".title(panel_window_title())", "패널 창 제목"),
        ] {
            let src = std::fs::read_to_string(repo(rel)).unwrap_or_else(|e| panic!("{rel}: {e}"));
            let prod = src.find("#[cfg(test)]").map(|i| &src[..i]).unwrap_or(src.as_str());
            assert!(
                prod.contains(wiring),
                "★{what}의 배선이 사라졌다 — `{rel}`에 `{wiring}`가 없다.\n\
                 헬퍼만 멀쩡하고 호출부가 우회하면 못 ①은 초록인 채 제품이 깨진다(SMALL3 R2 D2)."
            );
        }

        // 문구의 출처가 하나인가 — 헬퍼 밖에 같은 한국어가 되살아나면 잡는다.
        for (rel, helper, ko) in [
            ("src/win.rs", "pub(crate) fn session_window_title", "추가 채팅 — AgentCodeGUI"),
            ("src/popout.rs", "pub(crate) fn panel_window_title", "패널 — AgentCodeGUI"),
            ("src/ipc/system.rs", "pub(crate) fn pick_directory_title", "작업할 프로젝트 폴더 선택"),
        ] {
            let src = std::fs::read_to_string(repo(rel)).unwrap_or_else(|e| panic!("{rel}: {e}"));
            let prod = src.find("#[cfg(test)]").map(|i| &src[..i]).unwrap_or(src.as_str());
            // 주석을 걷고(주석에는 문구를 인용해도 된다) 헬퍼 본문 구간을 도려낸 나머지.
            let bare: String = prod
                .lines()
                .filter(|l| !l.trim_start().starts_with("//"))
                .collect::<Vec<_>>()
                .join("\n");
            let at = bare.find(helper).unwrap_or_else(|| panic!("{rel}: `{helper}`가 없다"));
            let end = bare[at..].find("\n}").map(|e| at + e).unwrap_or(bare.len());
            let outside = format!("{}{}", &bare[..at], &bare[end..]);
            assert!(
                !outside.contains(ko),
                "★`{ko}`가 `{rel}`의 헬퍼 밖에 있다 — 문구의 출처가 둘이 됐다(SMALL3 R3의 검사 ③)"
            );
        }
    }
}
