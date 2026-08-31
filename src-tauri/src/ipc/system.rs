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
    // 부모 창은 **여전히 못 건다** — `tauri-plugin-dialog`의 `pick_folder`에 부모 지정이
    // 없다(rfd `set_parent` 미노출). `pick_attachments`와 같은 제약이고, 그쪽처럼
    // 고아 대화상자는 아래 `close_orphan_dialogs`가 거둔다. 2.6.2는 부모를 걸 수 있었다
    // (`BrowserWindow.fromWebContents`) — 그 차이는 장부에 남겼다(HOSTI18N R1 보고서).
    app.dialog().file().set_title(pick_directory_title()).pick_folder(move |p| {
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

    /// 못 ③ — 셸이 사용자에게 보내는 **`error` 필드에 생 한국어 리터럴이 없다.**
    ///
    /// 이 라운드가 닫은 부류의 재발을 막는 그물이다. 렌더러는 `r.error ?? t(…)` 꼴로
    /// 받으므로 **셸이 문자열을 실어 보내는 순간 번역문은 폴백으로 밀린다** — 즉 셸이
    /// 한국어를 보내면 en 사용자가 한국어를 본다. `src-tauri/src` 전체를 훑는다.
    ///
    /// 경계: `crates/` 아래는 안 본다(`ccg-lsp`는 옆 갈래 소유, `ccg-store`의 마이그레이션
    /// 리포트는 성격이 다르다 — 보고서의 이월 절에 적었다).
    #[test]
    fn the_shell_never_sends_a_raw_korean_error_to_the_renderer() {
        fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.extension().is_some_and(|x| x == "rs") {
                    out.push(p);
                }
            }
        }
        let mut files = Vec::new();
        walk(&repo("src"), &mut files);
        assert!(files.len() > 20, "훑기가 파일을 거의 못 찾았다({}개)", files.len());

        let mut bad = Vec::new();
        for f in &files {
            let Ok(src) = std::fs::read_to_string(f) else { continue };
            // **제품 구역만** 본다. `#[cfg(test)]` 뒤의 assert 메시지에는 한국어가 정상이고
            // (`"이유 없는 실패는 침묵이다"` 같은 것), 기대값 리터럴도 한국어가 맞다.
            let prod = src.find("#[cfg(test)]").map(|i| &src[..i]).unwrap_or(src.as_str());
            for (i, line) in prod.lines().enumerate() {
                if line.trim_start().starts_with("//") {
                    continue; // 주석은 한국어가 정상이다
                }
                let Some(at) = line.find("\"error\"") else { continue };
                let rest = &line[at + 7..];
                // **`ccg_fs::t(`로 감쌌으면 통과** — 그게 이 라운드의 처방이다.
                // (감싼 줄에도 ko 인자가 한국어로 남아 있으므로 이 면제가 없으면
                //  고친 자리가 그대로 다시 걸린다 — 실제로 초판이 그랬다.)
                if rest.contains("ccg_fs::t(") {
                    continue;
                }
                // `"error": "…한국어…"` — 따옴표 안에 한글이 든 생 리터럴.
                let Some(q) = rest.find('"') else { continue };
                let after = &rest[q + 1..];
                let Some(end) = after.find('"') else { continue };
                if after[..end].chars().any(|c| ('가'..='힣').contains(&c)) {
                    bad.push(format!("{}:{}  {}", f.display(), i + 1, line.trim()));
                }
            }
        }
        assert!(
            bad.is_empty(),
            "★셸이 렌더러로 생 한국어 `error`를 보낸다({}건) — `ccg_fs::t(ko, en)`으로 감싸라.\n렌더러는 `r.error ?? t(…)`라 셸 문자열이 번역문을 이긴다:\n{}",
            bad.len(),
            bad.join("\n")
        );
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
