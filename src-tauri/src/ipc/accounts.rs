//! 계정 **쓰기** 채널 — 최종 파리티 감사 **T1**.
//!
//! 감사 실측: `auth:login`·`auth:logout`·`auth:set-default-account`·`auth:remove-account`·
//! `auth:reorder-accounts`의 Rust 핸들러가 **0개**였다(읽기 두 개만 있었다 —
//! `system.rs`의 `auth:list-accounts`·`codex-auth:list-accounts`). 그래서 설정 ▸ Account의
//! 「＋계정 추가」·「기본으로」·「삭제」가 전부 무반응이었고, 무엇보다 —
//!
//! > **새 사용자는 3.0에서 로그인할 방법이 없었다.** 2.6.2의 홈을 승계해야만 쓸 수 있었다.
//!
//! 도메인은 이미 `ccg-auth`에 다 있다(M5). 여기는 **배선**이다: 채널 ↔ 값, 자식 프로세스
//! 실행, 로그인 URL 방출. 세 가지를 지킨다.
//!
//! ## 1. 실홈 불가침 — 타입이 강제한다
//! `claude auth login/logout/status`는 전부 [`ccg_auth::IsolatedConfigDir`]로만 조립한다
//! (`ccg_auth::verify`). 그 타입은 **앱 홈 밖 경로로 만들어지지 않는다** — 사용자의
//! `~/.claude`를 향해 `auth logout`(서버 토큰 해지 = 되돌릴 수 없다)을 쏠 방법이 코드에 없다.
//!
//! ## 2. 목록을 바꾸는 쓰기는 예외 없이 CAS 경로
//! 로그인 편입·로그아웃·기본 계정·순서는 전부 `ccg_auth::claude`의
//! `update_store`(flock + 3-way 병합 + compare-and-swap)를 지난다. 직접 `write_store_file`을
//! 부르는 우회로는 이 파일에 없다. M11 R4가 회전 경로에서 닫은 창을 T1 배선이 로그인
//! 경로에서 다시 열지 않기 위해 f1ab32d가 CAS를 목록 편집까지 넓혀 뒀다.
//!
//! ## 3. 로그인 자식은 **우리가 스폰한 것만** 죽인다
//! 이름 기반 kill이 없다. 진행 중인 프로세스 핸들 하나를 [`LOGIN`]에 들고 있고,
//! 취소·5분 상한 둘 다 그 핸들로만 죽인다.

use super::{arg, ch};
use serde_json::{json, Value};
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use ccg_auth::claude;
use ccg_auth::verify::{self, AuthStatus};
use ccg_auth::{CommandSpec, IsolatedConfigDir};

/// 이 모듈이 답하는 채널인가.
///
/// `ipc_call`이 이 목록을 보고 **전용 블로킹 풀**로 보낸다. 이유가 파일·Git 팔과 같다
/// (오히려 더 극단적이다): `auth:login`은 사용자가 브라우저에서 로그인을 끝낼 때까지
/// **최대 5분** 막히고, `auth:logout`은 해지 왕복 20초다. tauri의 async 워커는 코어
/// 수만큼의 tokio 스레드라 거기서 5분을 자면 그동안 다른 창의 IPC가 통째로 굶는다.
pub fn owns(channel: &str) -> bool {
    matches!(
        channel,
        ch::AUTH_LOGIN | ch::AUTH_LOGIN_CANCEL | ch::AUTH_LOGOUT | ch::AUTH_SET_DEFAULT_ACCOUNT | ch::AUTH_REMOVE_ACCOUNT | ch::AUTH_REORDER_ACCOUNTS
    )
}

pub fn dispatch(app: &AppHandle, channel: &str, p: &Value) -> Option<Value> {
    Some(match channel {
        ch::AUTH_LOGIN => login(app, arg(p, 0).as_bool().unwrap_or(false)),
        ch::AUTH_LOGIN_CANCEL => {
            cancel_login();
            Value::Null
        }
        ch::AUTH_LOGOUT => {
            let email = arg(p, 0).as_str().unwrap_or("").to_string();
            logout(&email)
        }
        // 기본 계정 지정 — 목록에 없는 이메일이면 도메인이 조용히 무시한다(2.6.2와 같다).
        ch::AUTH_SET_DEFAULT_ACCOUNT => {
            claude::set_default_account(arg(p, 0).as_str().unwrap_or(""));
            super::system::list_claude_accounts()
        }
        // 해지 **없이** 목록에서만 뺀다. 해지까지 하는 문은 `auth:logout`이다.
        ch::AUTH_REMOVE_ACCOUNT => {
            claude::remove_account(arg(p, 0).as_str().unwrap_or(""));
            super::system::list_claude_accounts()
        }
        ch::AUTH_REORDER_ACCOUNTS => {
            let emails: Vec<String> = arg(p, 0)
                .as_array()
                .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_default();
            claude::reorder_accounts(&emails);
            super::system::list_claude_accounts()
        }
        _ => return None,
    })
}

// ── 로그인 ───────────────────────────────────────────────────────────────────

/// 진행 중인 로그인 자식 **하나**. 2.6.2 `loginProc`와 같은 자리 —
/// 취소(`auth:login-cancel`)와 5분 상한이 이 핸들로만 죽인다(이름 기반 kill 없음).
static LOGIN: Mutex<Option<Child>> = Mutex::new(None);

fn cancel_login() {
    if let Some(mut c) = LOGIN.lock().unwrap_or_else(|e| e.into_inner()).take() {
        let _ = c.kill();
        let _ = c.wait(); // 좀비를 남기지 않는다
    }
}

/// `claude auth login` — 브라우저 OAuth. **로그인 전엔 이메일을 모르므로** 임시 폴더
/// (`~/.agentcodegui/login`)로 붙고, 끝난 뒤 그 폴더의 신원을 읽어 스토어에 편입한다.
/// 기존 계정은 한 번도 위협받지 않는다(전역 크리덴셜을 덮어쓰는 경로 자체가 없다).
///
/// 브라우저는 **CLI가 직접 연다**("Opening browser to sign in…" 실측). 우리가 또 열면
/// 같은 인증 페이지가 두 장 뜬다 — 뽑은 URL은 `auth:login-url`로 렌더러에 보내 "안 열렸을
/// 때 눌러 보는 링크"로만 쓴다(2.6.2와 같은 규약).
fn login(app: &AppHandle, use_console: bool) -> Value {
    let bin = crate::engine::versions::claude_bin();
    if !crate::engine::versions::claude_bin_exists() {
        return status_wire(false, &AuthStatus::default(), Some(NO_BIN));
    }
    cancel_login(); // 이전 시도가 있으면 정리(2.6.2와 같은 첫 줄)

    let dir = IsolatedConfigDir::for_claude_login();
    // 이전의 부분 상태를 지우고 시작한다 — 반쯤 남은 `.credentials.json`을 이번 로그인의
    // 결과로 오독하면 **엉뚱한 계정이 편입된다**.
    let _ = std::fs::remove_dir_all(dir.path());
    if let Err(e) = std::fs::create_dir_all(dir.path()) {
        return status_wire(false, &AuthStatus::default(), Some(&format!("로그인 폴더를 만들지 못했어요: {e}")));
    }

    let spec = verify::login_command(&bin.to_string_lossy(), use_console);
    let mut cmd = build(&spec);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return status_wire(false, &AuthStatus::default(), Some(&format!("{NO_BIN} ({e})"))),
    };

    // 출력 두 갈래를 한 채널로 모은다 — URL은 stdout에도 stderr에도 올 수 있다.
    let (tx, rx) = channel::<String>();
    for pipe in [
        child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>),
        child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut pipe = pipe;
            let mut buf = [0u8; 4096];
            // **줄 단위가 아니라 청크 단위**로 읽는다: CLI가 URL을 개행 없이 뱉고
            // 사용자를 기다리면 `read_line`은 영영 안 돌아온다(URL이 화면에 못 닿는다).
            while let Ok(n) = pipe.read(&mut buf) {
                if n == 0 || tx.send(String::from_utf8_lossy(&buf[..n]).to_string()).is_err() {
                    return;
                }
            }
        });
    }
    drop(tx);
    *LOGIN.lock().unwrap_or_else(|e| e.into_inner()) = Some(child);

    let deadline = std::time::Instant::now() + Duration::from_millis(spec.timeout_ms);
    let mut sent_url = false;
    loop {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() {
            cancel_login(); // 5분 상한(2.6.2의 setTimeout과 같은 값)
            break;
        }
        match rx.recv_timeout(left) {
            Ok(chunk) => {
                if !sent_url {
                    if let Some(url) = verify::extract_login_url(&chunk) {
                        sent_url = true;
                        let _ = app.emit(ch::AUTH_LOGIN_URL, json!(url));
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                cancel_login();
                break;
            }
            // 파이프 둘이 다 닫혔다 = 자식이 끝났다.
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    if let Some(mut c) = LOGIN.lock().unwrap_or_else(|e| e.into_inner()).take() {
        let _ = c.wait();
    }

    // 결과 판정은 종료 코드가 아니라 `auth status --json`이다 — 로그아웃 상태면 CLI가
    // **비-0으로 끝나면서** JSON에 `loggedIn:false`를 준다(verify 모듈 헤더).
    let status = status_for(&bin.to_string_lossy(), &dir);
    let ok = status.logged_in && status.email.is_some();
    if ok {
        let email = status.email.clone().unwrap_or_default();
        // 편입은 CAS 경로(`update_store`)를 탄다. 가드는 2.6.2 `authLogin`과 같은 `None` —
        // 방금 그 계정으로 붙은 것이 확실하므로 토큰 충돌 검사로 막지 않는다.
        if let Err(e) = claude::import_account_from_dir(dir.path(), &email, status.subscription_type.as_deref(), ccg_auth::claude::ImportGuard::None) {
            let _ = std::fs::remove_dir_all(dir.path());
            return status_wire(false, &status, Some(&format!("계정을 저장하지 못했어요: {e}")));
        }
    }
    // 평문 토큰을 임시 자리에 남기지 않는다(성공이든 실패든).
    let _ = std::fs::remove_dir_all(dir.path());
    status_wire(ok, &status, None)
}

const NO_BIN: &str = "claude 실행 파일을 찾지 못했어요";

/// `auth status --json` 한 번(20초 상한).
fn status_for(bin: &str, dir: &IsolatedConfigDir) -> AuthStatus {
    let spec = verify::status_command(bin, dir);
    match run(&spec) {
        Some(out) => verify::parse_status(&out),
        None => AuthStatus::default(),
    }
}

/// 2.6.2 `AuthStatus & { ok }`의 모양 그대로. `undefined`였던 자리는 키를 **빼서** 보낸다
/// (렌더러가 `typeof x === 'string'`으로 보는 자리라 `null`이 들어가면 안 된다).
fn status_wire(ok: bool, s: &AuthStatus, error: Option<&str>) -> Value {
    let mut o = serde_json::Map::new();
    o.insert("ok".into(), json!(ok));
    o.insert("loggedIn".into(), json!(s.logged_in));
    for (k, v) in [
        ("email", &s.email),
        ("authMethod", &s.auth_method),
        ("subscriptionType", &s.subscription_type),
        ("orgName", &s.org_name),
    ] {
        if let Some(v) = v {
            o.insert(k.into(), json!(v));
        }
    }
    if let Some(e) = error {
        o.insert("error".into(), json!(e));
    }
    Value::Object(o)
}

// ── 로그아웃 ─────────────────────────────────────────────────────────────────

/// 계정 하나를 **버린다**: 서버 토큰 해지 → 스토어 제거 → 계정 폴더 삭제.
///
/// 해지가 실패해도(네트워크·이미 만료) 로컬은 지운다 — 목록에 거짓 항목을 남기지 않는
/// 것이 2.6.2의 규약이다. 반대로 **해지를 건너뛰는 경우는 하나뿐**이다: 계정 폴더를
/// 물질화조차 못 했을 때(스냅샷 손상). 그때는 보낼 토큰 자체가 없다.
///
/// `CCG_NO_NET`이 켜져 있으면 해지를 **생략한다**. 하네스가 이 문을 지나가도 사용자
/// 실계정의 토큰이 서버에서 죽지 않게 하는 안전핀이다(`ccg_auth::net::disabled`와 같은 키).
fn logout(email: &str) -> Value {
    if !email.is_empty() && !no_net() {
        if let Ok(dir) = IsolatedConfigDir::for_claude_account(email) {
            let bin = crate::engine::versions::claude_bin();
            if crate::engine::versions::claude_bin_exists() {
                let _ = run(&verify::logout_command(&bin.to_string_lossy(), &dir));
            }
        }
    }
    // 스토어 제거 + 폴더 삭제 + 건강 장부 청소(전부 `ccg_auth::claude::remove_account`).
    claude::remove_account(email);
    super::system::list_claude_accounts()
}

fn no_net() -> bool {
    std::env::var("CCG_NO_NET").is_ok_and(|v| !v.is_empty() && v != "0")
}

// ── 자식 프로세스 ────────────────────────────────────────────────────────────

/// [`CommandSpec`] → [`Command`]. env는 **덧씌우기**다(전체 치환이 아니다 — 그러면
/// PATH·SystemRoot가 사라져 CLI가 못 뜬다).
fn build(spec: &CommandSpec) -> Command {
    let mut c = Command::new(&spec.program);
    c.args(&spec.args);
    for (k, v) in &spec.env {
        c.env(k, v);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW — 콘솔 창이 번쩍이지 않게
    }
    c
}

/// 한 방에 끝나는 명령(status·logout). stdout을 돌려주고, 상한을 넘으면 **우리가 스폰한
/// 그 자식만** 죽인다. `None` = 실행 못 했거나 상한 초과.
fn run(spec: &CommandSpec) -> Option<String> {
    let mut cmd = build(spec);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = channel::<String>();
    std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stdout.read_to_string(&mut s);
        let _ = tx.send(s);
    });
    match rx.recv_timeout(Duration::from_millis(spec.timeout_ms)) {
        Ok(s) => {
            let _ = child.wait();
            Some(s)
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 와이어 모양이 2.6.2 `AuthStatus & { ok }`와 같은가 — 없는 값은 **키째** 빠진다.
    #[test]
    fn status_wire_drops_absent_fields_instead_of_nulling_them() {
        let empty = status_wire(false, &AuthStatus::default(), Some("x"));
        assert_eq!(empty["ok"], json!(false));
        assert_eq!(empty["loggedIn"], json!(false));
        assert!(empty.get("email").is_none(), "undefined 자리에 null이 들어가면 안 된다: {empty}");
        assert_eq!(empty["error"], json!("x"));

        let full = status_wire(
            true,
            &AuthStatus {
                logged_in: true,
                email: Some("a@b.c".into()),
                auth_method: Some("claudeai".into()),
                subscription_type: Some("max".into()),
                org_name: None,
            },
            None,
        );
        assert_eq!(full["email"], json!("a@b.c"));
        assert_eq!(full["subscriptionType"], json!("max"));
        assert!(full.get("orgName").is_none());
        assert!(full.get("error").is_none(), "성공에는 error 키가 없다");
    }

    /// 다섯 쓰기 채널이 전부 이 모듈 것이어야 `ipc_call`이 블로킹 풀로 보낸다.
    /// (하나라도 빠지면 그 채널만 async 워커에서 5분을 잔다 = 앱 전체가 멈춘다.)
    #[test]
    fn the_five_write_channels_are_all_claimed() {
        for c in ["auth:login", "auth:login-cancel", "auth:logout", "auth:set-default-account", "auth:remove-account", "auth:reorder-accounts"] {
            assert!(owns(c), "{c}");
        }
        assert!(!owns("auth:list-accounts"), "읽기는 system.rs 것이다");
        assert!(!owns("codex-auth:list-accounts"));
    }

    /// 취소는 **없는 자식에게도 안전**해야 한다(사용자가 카드를 두 번 닫는다).
    #[test]
    fn cancelling_with_no_login_in_flight_is_a_no_op() {
        cancel_login();
        cancel_login();
        assert!(LOGIN.lock().unwrap().is_none());
    }
}
