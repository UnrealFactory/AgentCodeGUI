//! **가짜 `claude` 실행 파일** — T1(계정 쓰기 채널) 배선을 실측으로 밟는 하네스 전용 스텁.
//! 기본 빌드에 없다(`--features cli`, `ccg-auth-probe`와 같은 규약).
//!
//! ## 왜 필요한가
//!
//! T1이 붙인 다섯 채널 중 넷(`set-default`·`remove`·`reorder`·`logout`의 로컬 부분)은
//! CLI 없이도 밟힌다. **`auth:login`만은 자식 프로세스가 있어야 한다** — 그런데 진짜
//! `claude auth login`을 부르면 브라우저가 열리고 사용자 실계정이 걸린다(벤치 금지 —
//! `bench/screens.mjs:1770`이 같은 이유로 그 화면을 `skip`했다).
//!
//! 그래서 CLI 쪽 계약면만 흉내 낸다. 흉내 내는 것은 셋이고, 전부 `ccg-auth::verify`가
//! 조립하는 그 명령줄이다:
//!
//! ```text
//!   auth login --claudeai|--console   URL 한 줄을 뱉고 **기다린다**(취소·상한 시험)
//!                                     CCG_FAKE_LOGIN_OK=1이면 크리덴셜을 쓰고 끝난다
//!   auth status --json                CLAUDE_CONFIG_DIR에 크리덴셜이 있으면 loggedIn:true
//!                                     없으면 **비-0으로 끝나면서** loggedIn:false (실 CLI의 그 성질)
//!   auth logout                       CLAUDE_CONFIG_DIR에 `.logout-called` 표식만 남긴다
//! ```
//!
//! **네트워크 0건.** 토큰은 이 자리에서 만든 문자열이고 어디에도 안 보낸다.
//! `CLAUDE_CONFIG_DIR`이 없으면 아무것도 안 하고 죽는다 — 실홈을 향할 방법이 없다.

use std::io::Write;

fn cfg_dir() -> std::path::PathBuf {
    match std::env::var("CLAUDE_CONFIG_DIR") {
        Ok(d) if !d.is_empty() => std::path::PathBuf::from(d),
        _ => {
            eprintln!("[fake-claude] CLAUDE_CONFIG_DIR이 없다 — 거절");
            std::process::exit(2);
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let sub = args.iter().map(String::as_str).collect::<Vec<_>>();
    match sub.as_slice() {
        ["auth", "login", ..] => login(),
        ["auth", "status", ..] => status(),
        ["auth", "logout", ..] => {
            let d = cfg_dir();
            // 표식은 **앱 홈**에 남긴다. 계정 폴더 안에 쓰면 곧이어 그 폴더가 통째로
            // 지워져(로그아웃의 뒷반쪽) 하네스가 볼 수가 없다. 어느 폴더를 향해
            // 불렸는지도 같이 적는다 — 실홈을 향했으면 그 문자열로 드러난다.
            let mark = std::env::var("CCG_HOME").map(std::path::PathBuf::from).unwrap_or_else(|_| d.clone());
            let _ = std::fs::create_dir_all(&mark);
            let _ = std::fs::write(mark.join(".fake-logout-called"), d.to_string_lossy().as_bytes());
            println!("Logged out.");
        }
        _ => {
            eprintln!("[fake-claude] 모르는 명령: {sub:?}");
            std::process::exit(2);
        }
    }
}

/// 실 CLI가 뱉는 모양 그대로 — 앱은 여기서 https URL 하나를 뽑아 폴백 링크로 쓴다.
fn login() {
    let d = cfg_dir();
    let email = std::env::var("CCG_FAKE_LOGIN_EMAIL").unwrap_or_else(|_| "fake@t1t2.test".into());
    println!("Opening browser to sign in…");
    println!("https://claude.ai/oauth/authorize?code=FAKE-T1T2&email={email}");
    let _ = std::io::stdout().flush();

    if std::env::var("CCG_FAKE_LOGIN_OK").is_ok_and(|v| v == "1") {
        // 로그인 성공 — 실 CLI가 남기는 그 두 파일을 쓴다(토큰은 이 자리에서 만든 문자열).
        let _ = std::fs::create_dir_all(&d);
        let creds = serde_json::json!({ "claudeAiOauth": {
            "accessToken": format!("FAKE-A-{email}"), "refreshToken": format!("FAKE-R-{email}"),
            "expiresAt": 4_000_000_000_000f64, "scopes": ["user:inference"],
        }});
        let _ = std::fs::write(d.join(".credentials.json"), creds.to_string());
        let cj = serde_json::json!({ "oauthAccount": { "emailAddress": email, "accountUuid": "fake-uuid" }, "userID": "fake-user" });
        let _ = std::fs::write(d.join(".claude.json"), cj.to_string());
        println!("Login successful.");
        return;
    }
    // 성공 표식이 없으면 **기다린다** — 취소(`auth:login-cancel`)와 5분 상한이 죽이는
    // 그 자식이 이 프로세스다. 하네스가 영원히 매달리지 않게 상한 하나는 스스로 둔다.
    let ms: u64 = std::env::var("CCG_FAKE_LOGIN_WAIT_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(120_000);
    std::thread::sleep(std::time::Duration::from_millis(ms));
    eprintln!("[fake-claude] 로그인 대기 상한 — 종료");
    std::process::exit(1);
}

/// 로그아웃 상태면 **비-0으로 끝나면서** JSON을 준다(실 CLI의 성질 — `verify` 모듈 헤더).
fn status() {
    let d = cfg_dir();
    let raw = std::fs::read_to_string(d.join(".claude.json")).unwrap_or_default();
    let email = serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|v| v.get("oauthAccount")?.get("emailAddress")?.as_str().map(str::to_string));
    match email.filter(|_| d.join(".credentials.json").is_file()) {
        Some(e) => {
            println!(
                "{}",
                serde_json::json!({ "loggedIn": true, "email": e, "authMethod": "claudeai", "subscriptionType": "max" })
            );
        }
        None => {
            println!("{}", serde_json::json!({ "loggedIn": false }));
            std::process::exit(1);
        }
    }
}
