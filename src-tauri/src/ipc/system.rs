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
