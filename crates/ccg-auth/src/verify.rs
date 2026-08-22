//! 생사검증·전환 전 오염가드·CLI 경로 조립.
//!
//! **이 모듈은 아무것도 실행하지 않는다.** 요청/명령을 조립하고, 결과 코드를 판정으로
//! 옮기는 순수 함수만 있다. 이유가 둘이다:
//! 1. 사용자 **실계정**이다. 테스트가 실수로 `auth logout`을 부르면 그 순간 서버에서
//!    토큰이 해지되고, 그 토큰을 담은 저장 스냅샷까지 같이 죽는다(1.6.1에 실제로 밟은 함정 —
//!    죽은 토큰을 복원하면 CLI가 401을 맞고 크리덴셜을 243B 껍데기로 덮어 "Not logged in").
//! 2. 전송 계층을 크레이트가 갖지 않으면 그런 사고가 **구조적으로** 불가능하다.
//!
//! 판정 규약(1.6.1 `validateSnapshotToken`):
//! - usage API가 **401/403** → 그 토큰은 죽었다(`Dead`). 적용하지 않고 안내 + 제거 대상.
//! - **만료된** 토큰은 `Dead`가 아니라 `Unknown`이다 — 리프레시로 살아난다(전환 허용).
//! - 429·5xx·네트워크 오류도 `Unknown`(레이트리밋을 사망으로 오독하면 멀쩡한 계정이 지워진다).

use crate::claude;
use crate::{AuthError, CommandSpec, HttpRequest};
use serde_json::Value;
use std::path::Path;

// ── CLI 경로 조립 (Anthropic) ───────────────────────────────────────────────

/// `claude auth status --json` — 그 config 폴더만 본다(전역 무관). **읽기 전용**이다
/// (파일을 쓰지 않는 것 실측).
pub fn status_command(bin: &str, config_dir: &Path) -> CommandSpec {
    CommandSpec {
        program: bin.into(),
        args: vec!["auth".into(), "status".into(), "--json".into()],
        env: vec![("CLAUDE_CONFIG_DIR".into(), config_dir.to_string_lossy().to_string())],
        timeout_ms: 20_000,
    }
}

/// `claude auth login` — 로그인 전엔 이메일을 모르므로 임시 폴더로 붙는다
/// (`claude::login_dir`). 완료 후 신원을 읽어 편입하고 임시 폴더는 지운다
/// (평문 토큰을 임시 자리에 남기지 않는다).
pub fn login_command(bin: &str, use_console: bool) -> CommandSpec {
    CommandSpec {
        program: bin.into(),
        args: vec!["auth".into(), "login".into(), if use_console { "--console".into() } else { "--claudeai".into() }],
        env: vec![("CLAUDE_CONFIG_DIR".into(), claude::login_dir().to_string_lossy().to_string())],
        timeout_ms: 5 * 60 * 1000,
    }
}

/// `claude auth logout` — **서버에서 토큰을 해지한다(되돌릴 수 없다).**
/// 해지가 실패해도 로컬은 지운다(목록에 거짓 항목을 남기지 않는다).
pub fn logout_command(bin: &str, config_dir: &Path) -> CommandSpec {
    CommandSpec {
        program: bin.into(),
        args: vec!["auth".into(), "logout".into()],
        env: vec![("CLAUDE_CONFIG_DIR".into(), config_dir.to_string_lossy().to_string())],
        timeout_ms: 20_000,
    }
}

/// `codex login` / `codex logout` — CODEX_HOME 격리. codex는 `shell: true`로 띄운다
/// (2.6.2 실측 — .cmd 셰임 때문).
pub fn codex_login_command(bin: &str) -> CommandSpec {
    CommandSpec {
        program: bin.into(),
        args: vec!["login".into()],
        env: vec![("CODEX_HOME".into(), crate::codex::login_dir().to_string_lossy().to_string())],
        timeout_ms: 5 * 60 * 1000,
    }
}

pub fn codex_logout_command(bin: &str, codex_home: &Path) -> CommandSpec {
    CommandSpec {
        program: bin.into(),
        args: vec!["logout".into()],
        env: vec![("CODEX_HOME".into(), codex_home.to_string_lossy().to_string())],
        timeout_ms: 15_000,
    }
}

/// `auth status --json`의 출력. 로그아웃 상태면 CLI가 **비-0으로 끝나면서** JSON에
/// `loggedIn:false`를 준다 — 종료 코드로 판정하면 안 되고 stdout을 읽어야 한다.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AuthStatus {
    pub logged_in: bool,
    pub email: Option<String>,
    pub auth_method: Option<String>,
    pub subscription_type: Option<String>,
    pub org_name: Option<String>,
}

pub fn parse_status(stdout: &str) -> AuthStatus {
    let t = stdout.trim();
    if !t.starts_with('{') {
        return AuthStatus::default();
    }
    let Ok(j) = serde_json::from_str::<Value>(t) else { return AuthStatus::default() };
    let s = |k: &str| j.get(k).and_then(Value::as_str).map(str::to_string);
    AuthStatus {
        logged_in: j.get("loggedIn").and_then(Value::as_bool).unwrap_or(false),
        email: s("email"),
        auth_method: s("authMethod"),
        subscription_type: s("subscriptionType"),
        org_name: s("orgName"),
    }
}

/// 로그인 출력에서 브라우저 URL 뽑기 — 브라우저는 **CLI가 직접 연다**. 앱이 또 열면 인증
/// 페이지가 두 장 뜬다. 이건 "안 열린 환경" 대비 폴백 링크용이고, codex는 첫 URL이 로컬
/// 로그인 서버(`http://localhost:1455.`)라 **https만** 잡는다.
pub fn extract_login_url(chunk: &str) -> Option<String> {
    let i = chunk.find("https://")?;
    let rest = &chunk[i..];
    let end = rest
        .find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == ')' || c == '）')
        .unwrap_or(rest.len());
    Some(rest[..end].trim_end_matches(['.', ',']).to_string())
}

// ── 생사검증 ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Liveness {
    /// usage API가 200 — 토큰이 서버에서도 살아 있다.
    Alive,
    /// 401/403 — 서버가 무효화했다(해지·그랜트 회전). 이 계정을 적용하면 안 된다.
    Dead,
    /// 429·5xx·네트워크 오류·만료(리프레시하면 살 수 있음) — **판단 보류**.
    Unknown,
    /// 리프레시 토큰조차 없다 — 재로그인 외에 길이 없다.
    NeedsLogin,
}

/// HTTP 상태 코드 → 판정. 2.6.2가 401/403에서만 죽음을 확정하는 것과 같다.
pub fn liveness_from_http(status: u16) -> Liveness {
    match status {
        200..=299 => Liveness::Alive,
        401 | 403 => Liveness::Dead,
        _ => Liveness::Unknown,
    }
}

/// 전환/바인딩 전 점검 결과. `probe`가 Some이면 "이 요청을 던져 [`liveness_from_http`]에
/// 넣어라"는 뜻이고, None이면 요청 없이 `verdict`가 이미 결론이다.
#[derive(Debug, Clone, PartialEq)]
pub struct Preflight {
    pub email: String,
    pub verdict: PreflightVerdict,
    /// 토큰 지문(sha256 앞 12자) — 진단 로그용. **원문은 나가지 않는다.**
    pub token_fingerprint: Option<String>,
    pub probe: Option<HttpRequest>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreflightVerdict {
    /// 살아 보이는 토큰이 있다 — `probe`로 서버 확인까지 하면 확정.
    Probe,
    /// 토큰이 만료됐지만 리프레시 재료가 있다 — 확인 없이 진행 가능(`Unknown` 취급).
    NeedsRefresh,
    /// 리프레시 토큰조차 없다.
    NeedsLogin,
    /// **오염** — 같은 토큰이 다른 이메일로도 저장돼 있다. 이름표만 다르고 실토큰은 하나라,
    /// 적용하면 다음 실행에서 CLI가 토큰 주인으로 자가 교정해 "계정이 되돌아간다".
    Contaminated(String),
    /// 스토어·스냅샷 문제.
    Failed(AuthError),
}

/// 전환/바인딩 전 점검 — **네트워크 없이** 여기까지 온다.
pub fn preflight(email: &str) -> Preflight {
    let mk = |verdict, fp, probe| Preflight { email: email.to_string(), verdict, token_fingerprint: fp, probe };
    // 미등록 / 복호 불가 / 스냅샷 손상을 **파일을 쓰지 않고** 구분한다(안내 문구가 갈린다).
    if let Err(e) = claude::snapshot_of(email) {
        return mk(PreflightVerdict::Failed(e), None, None);
    }
    let Some(creds) = claude::freshest_creds(email) else {
        return mk(PreflightVerdict::Failed(AuthError::CorruptSnapshot(email.into())), None, None);
    };
    let fp = Some(crate::token_fingerprint(&creds));
    // 오염가드가 생사검증보다 **먼저**다. 오염된 항목은 살아 있는 토큰을 물고 있어
    // 서버 확인을 통과해 버린다 — 통과시키면 그게 곧 "되돌아감"이다.
    if let Some(other) = claude::token_owner(&creds) {
        if other != email {
            return mk(PreflightVerdict::Contaminated(other), fp, None);
        }
    }
    match claude::account_access_token(email) {
        Some(tok) => mk(PreflightVerdict::Probe, fp, Some(crate::usage::usage_request(&tok))),
        None if claude::refresh_token(email).is_some() => mk(PreflightVerdict::NeedsRefresh, fp, None),
        None => mk(PreflightVerdict::NeedsLogin, fp, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::temp_home;
    use serde_json::json;

    fn creds(access: &str, exp: f64) -> String {
        json!({ "claudeAiOauth": { "accessToken": access, "refreshToken": "r-".to_string() + access, "expiresAt": exp } }).to_string()
    }
    fn seed(email: &str, access: &str, exp: f64) {
        let snap = json!({ "creds": creds(access, exp), "account": { "emailAddress": email } });
        let enc = ccg_store::safe_storage::encrypt(&snap.to_string()).unwrap();
        let f = claude::read_store_file();
        let mut accounts = f.accounts.clone();
        accounts.push(json!({ "email": email, "credEnc": enc }));
        claude::write_store_file(&accounts, f.default_email.as_deref());
    }

    #[test]
    fn status_is_read_from_stdout_not_the_exit_code() {
        let s = parse_status(r#"{"loggedIn":true,"email":"a@x.com","subscriptionType":"max","orgName":"Acme"}"#);
        assert!(s.logged_in);
        assert_eq!(s.email.as_deref(), Some("a@x.com"));
        assert_eq!(s.subscription_type.as_deref(), Some("max"));
        // 로그아웃 상태 — CLI는 비-0으로 끝나지만 JSON은 준다
        assert_eq!(parse_status(r#"{"loggedIn":false}"#), AuthStatus::default());
        assert_eq!(parse_status("Error: not logged in"), AuthStatus::default());
    }

    #[test]
    fn login_url_extraction_ignores_the_local_server_and_trailing_dots() {
        assert_eq!(
            extract_login_url("Opening browser to sign in… https://claude.ai/oauth/authorize?x=1.").as_deref(),
            Some("https://claude.ai/oauth/authorize?x=1")
        );
        // codex는 http://localhost:1455. 를 먼저 뱉는다 — https만 잡아야 한다
        assert_eq!(extract_login_url("Started local login server at http://localhost:1455."), None);
        assert_eq!(extract_login_url("see \"https://a.b/c\" now").as_deref(), Some("https://a.b/c"));
    }

    #[test]
    fn commands_carry_the_isolating_env() {
        let h = temp_home("cmds");
        let dir = h.path("accounts/a");
        let c = status_command("claude.exe", &dir);
        assert_eq!(c.args, ["auth", "status", "--json"]);
        assert_eq!(c.env, [("CLAUDE_CONFIG_DIR".to_string(), dir.to_string_lossy().to_string())]);
        assert_eq!(logout_command("claude.exe", &dir).args, ["auth", "logout"]);
        assert_eq!(login_command("claude.exe", true).args, ["auth", "login", "--console"]);
        assert_eq!(login_command("claude.exe", false).args, ["auth", "login", "--claudeai"]);
        assert!(login_command("claude.exe", false).env[0].1.ends_with("login"), "로그인은 임시 폴더로 — 기존 계정을 위협하지 않는다");
        assert_eq!(codex_logout_command("codex", &dir).env[0].0, "CODEX_HOME");
    }

    #[test]
    fn liveness_only_declares_death_on_401_403() {
        assert_eq!(liveness_from_http(200), Liveness::Alive);
        assert_eq!(liveness_from_http(401), Liveness::Dead);
        assert_eq!(liveness_from_http(403), Liveness::Dead);
        assert_eq!(liveness_from_http(429), Liveness::Unknown, "레이트리밋을 사망으로 읽으면 멀쩡한 계정이 지워진다");
        assert_eq!(liveness_from_http(500), Liveness::Unknown);
    }

    #[test]
    fn preflight_assembles_the_probe_but_sends_nothing() {
        let _h = temp_home("preflight");
        seed("a@x.com", "tok-live", 9e12);
        let p = preflight("a@x.com");
        assert_eq!(p.verdict, PreflightVerdict::Probe);
        let r = p.probe.expect("조립된 요청");
        assert_eq!(r.url, crate::usage::USAGE_URL);
        assert_eq!(r.headers[0].1, "Bearer tok-live");
        assert!(p.token_fingerprint.is_some());
        assert!(!p.token_fingerprint.unwrap().contains("tok-live"), "지문에 원문이 새면 안 된다");
    }

    #[test]
    fn expired_token_is_refreshable_not_dead() {
        let _h = temp_home("preflight-expired");
        seed("a@x.com", "tok-old", 1000.0);
        assert_eq!(preflight("a@x.com").verdict, PreflightVerdict::NeedsRefresh);
    }

    #[test]
    fn a_credential_without_a_refresh_token_needs_a_new_login() {
        let _h = temp_home("preflight-nologin");
        let snap = json!({ "creds": json!({ "claudeAiOauth": { "accessToken": "t", "expiresAt": 1000.0 } }).to_string(), "account": { "emailAddress": "a@x.com" } });
        let enc = ccg_store::safe_storage::encrypt(&snap.to_string()).unwrap();
        claude::write_store_file(&[json!({ "email": "a@x.com", "credEnc": enc })], None);
        assert_eq!(preflight("a@x.com").verdict, PreflightVerdict::NeedsLogin);
    }

    /// 오염 판정이 생사검증보다 앞선다 — 오염 항목의 토큰은 **살아 있어서** 서버 확인을
    /// 통과해 버리고, 통과시키는 순간 그게 "전환이 되돌아감"이다.
    #[test]
    fn contamination_short_circuits_before_any_probe() {
        let _h = temp_home("preflight-contaminated");
        seed("a@x.com", "same-token", 9e12);
        seed("b@x.com", "same-token", 9e12);
        let p = preflight("b@x.com");
        assert_eq!(p.verdict, PreflightVerdict::Contaminated("a@x.com".into()));
        assert!(p.probe.is_none(), "오염 항목은 서버에 물어볼 것도 없다");
    }

    #[test]
    fn unregistered_and_undecryptable_are_told_apart() {
        let _h = temp_home("preflight-fail");
        assert_eq!(preflight("nobody@x.com").verdict, PreflightVerdict::Failed(AuthError::NotRegistered("nobody@x.com".into())));
        claude::write_store_file(&[json!({ "email": "a@x.com", "credEnc": "bm90LWEtcmVhbC1ibG9i" })], None);
        assert_eq!(preflight("a@x.com").verdict, PreflightVerdict::Failed(AuthError::Undecryptable("a@x.com".into())));
    }
}
