//! ★M11 — **실 HTTP 실행기**. M5 R1이 조립까지만 해 둔 [`crate::HttpRequest`]를 여기서 던진다.
//!
//! 이 파일이 이 크레이트에서 유일하게 네트워크를 만지는 자리이고, `net` 피처 안에 있다.
//! 기본 빌드·`cargo test -p ccg-auth`에는 **존재하지 않는다** — M5 R1 §1.2가 세운
//! *"테스트가 실수로 사용자 실계정을 건드릴 수 없다"* 는 성질을 피처 경계로 유지한다.
//!
//! ## 안전장치 셋
//!
//! | # | 무엇 | 왜 |
//! |---|---|---|
//! | ① | `net` 피처(기본 꺼짐) | 켜는 곳은 `src-tauri` 하나 |
//! | ② | `CCG_NO_NET=1` 킬 스위치 | 하네스·재생은 합성 usage로 돌아야 한다. 켜져 있으면 전 호출이 즉시 [`NetError::Disabled`] |
//! | ③ | 전역 직렬화 + [`crate::usage::USAGE_GAP_MS`] 간격 | usage API는 같은 IP의 병렬 2건 중 1건이 429다(M5 R1 실측). 프로세스 전체 호출이 이 게이트 하나를 지난다 |
//!
//! **쓰는 요청은 하나도 없다**: `GET /api/oauth/usage`(읽기)와 토큰 리프레시 교환뿐이다.
//! `claude auth logout`(서버 토큰 해지) 같은 파괴적 경로는 여기 없다 — 그건 여전히
//! [`crate::verify`]가 **명령 조립**까지만 하고 셸이 사용자 조작으로만 실행한다.

use crate::usage::{self, AccountUsage};
use crate::{claude, HttpRequest};
use serde_json::Value;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NetError {
    /// `CCG_NO_NET=1` — 하네스/재생 주행이다.
    Disabled,
    /// 이 계정에 쓸 토큰이 없다(만료 + 리프레시 실패 포함).
    NoToken,
    /// 서버가 답했지만 성공이 아니다.
    Status(u16),
    /// 연결·타임아웃·TLS.
    Transport(String),
    /// 본문이 JSON이 아니다.
    BadBody,
}

impl std::fmt::Display for NetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NetError::Disabled => write!(f, "network disabled (CCG_NO_NET)"),
            NetError::NoToken => write!(f, "no usable access token"),
            NetError::Status(s) => write!(f, "http {s}"),
            NetError::Transport(m) => write!(f, "transport: {m}"),
            NetError::BadBody => write!(f, "response body was not JSON"),
        }
    }
}

pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

/// 킬 스위치 — 하네스는 이걸 켜고 돈다.
pub fn disabled() -> bool {
    std::env::var("CCG_NO_NET").is_ok_and(|v| !v.is_empty() && v != "0")
}

/// 프로세스 전역 호출 게이트. 2.6.2가 전 usage 호출을 큐 하나로 직렬화하고 사이에 간격을
/// 둔 것과 같은 정책(`usage.rs` 헤더) — 여기서는 뮤텍스 + 마지막 호출 시각이다.
static GATE: Mutex<Option<Instant>> = Mutex::new(None);

fn throttle() {
    let mut g = GATE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(last) = *g {
        let gap = Duration::from_millis(usage::USAGE_GAP_MS);
        let since = last.elapsed();
        if since < gap {
            std::thread::sleep(gap - since);
        }
    }
    *g = Some(Instant::now());
}

/// 조립된 요청 하나를 그대로 던진다. **재시도 없음** — 429 백오프는 부르는 쪽이 정한다.
pub fn send(req: &HttpRequest) -> Result<HttpResponse, NetError> {
    if disabled() {
        return Err(NetError::Disabled);
    }
    throttle();
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_millis(req.timeout_ms))
        // 리다이렉트를 따라가면 Authorization 헤더가 남의 호스트로 새어 나간다.
        .redirects(0)
        .build();
    let mut r = agent.request(req.method, &req.url);
    for (k, v) in &req.headers {
        r = r.set(k, v);
    }
    let res = match &req.body {
        Some(b) => r.send_string(b),
        None => r.call(),
    };
    match res {
        Ok(resp) => {
            let status = resp.status();
            let body = resp.into_string().unwrap_or_default();
            Ok(HttpResponse { status, body })
        }
        // ureq는 4xx/5xx를 에러로 준다 — 상태 코드는 생사검증의 판정 재료라 살려 보낸다.
        Err(ureq::Error::Status(code, resp)) => Ok(HttpResponse {
            status: code,
            body: resp.into_string().unwrap_or_default(),
        }),
        Err(e) => Err(NetError::Transport(e.to_string())),
    }
}

/// 액세스 토큰 확보 — 신선한 게 있으면 그대로, 없고 리프레시 재료가 있으면 **교환한다**.
///
/// 교환 결과는 폴더·백업 **둘 다**에 되쓴다([`claude::persist_refreshed`]) — 회전된
/// refresh 토큰을 한쪽에만 남기면 다른 쪽이 죽은 토큰이 되고, 그게 곧 재로그인이다.
pub fn access_token(email: &str) -> Result<String, NetError> {
    if let Some(t) = claude::account_access_token(email) {
        return Ok(t);
    }
    let refresh = claude::refresh_token(email).ok_or(NetError::NoToken)?;
    let base = claude::freshest_creds(email).ok_or(NetError::NoToken)?;
    let mut last = NetError::NoToken;
    // 2.6.2는 두 엔드포인트를 **순서대로** 시도한다(앞이 4xx면 다음).
    for req in usage::refresh_requests(&refresh) {
        let resp = match send(&req) {
            Ok(r) => r,
            Err(e @ NetError::Disabled) => return Err(e),
            Err(e) => {
                last = e;
                continue;
            }
        };
        if !(200..300).contains(&resp.status) {
            last = NetError::Status(resp.status);
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&resp.body) else {
            last = NetError::BadBody;
            continue;
        };
        let Some(access) = v.get("access_token").and_then(Value::as_str) else {
            last = NetError::BadBody;
            continue;
        };
        let next = claude::apply_refresh(
            &base,
            access,
            v.get("refresh_token").and_then(Value::as_str),
            v.get("expires_in").and_then(Value::as_f64).unwrap_or(3600.0),
            now_ms(),
        );
        if let Some(next) = next {
            let _ = claude::persist_refreshed(email, &next);
        }
        return Ok(access.to_string());
    }
    Err(last)
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/// 계정 한 건의 한도 — `GET /api/oauth/usage` + [`usage::parse_account_usage`].
///
/// 429는 **한 번만** 재시도한다(`Retry-After` 우선, 상한 [`usage::RETRY_AFTER_MAX_MS`]).
/// 두 번 이상 물고 늘어지면 계정 6개 훑기가 분 단위로 늘어난다 — 그 자리는 캐시가 메운다.
pub fn fetch_account_usage(email: &str) -> Result<AccountUsage, NetError> {
    let token = access_token(email)?;
    let req = usage::usage_request(&token);
    let mut resp = send(&req)?;
    if resp.status == 429 {
        let wait = retry_after_ms(&resp.body);
        std::thread::sleep(Duration::from_millis(wait));
        resp = send(&req)?;
    }
    if !(200..300).contains(&resp.status) {
        return Err(NetError::Status(resp.status));
    }
    let v: Value = serde_json::from_str(&resp.body).map_err(|_| NetError::BadBody)?;
    Ok(usage::parse_account_usage(email, &v))
}

/// 429 본문의 `retry_after`(초) — 없으면 기본값, 상한까지만 믿는다.
fn retry_after_ms(body: &str) -> u64 {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| {
            v.get("retry_after")
                .or_else(|| v.get("error").and_then(|e| e.get("retry_after")))
                .and_then(Value::as_f64)
        })
        .map(|s| (s * 1000.0) as u64)
        .unwrap_or(usage::RETRY_AFTER_DEFAULT_MS)
        .clamp(0, usage::RETRY_AFTER_MAX_MS)
}

/// 생사검증 — [`crate::verify::preflight`]의 `probe`를 던져 판정까지 간다.
pub fn liveness(probe: &HttpRequest) -> Result<crate::verify::Liveness, NetError> {
    let resp = send(probe)?;
    Ok(crate::verify::liveness_from_http(resp.status))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 킬 스위치가 **유일한 출구**([`send`])를 막는가. 다른 함수는 전부 이 문을 지난다.
    #[test]
    fn the_kill_switch_blocks_the_only_exit() {
        std::env::set_var("CCG_NO_NET", "1");
        assert!(disabled());
        assert_eq!(send(&usage::usage_request("tok")).err(), Some(NetError::Disabled));
        assert_eq!(fetch_account_usage("nobody@example.com").err(), Some(NetError::NoToken), "토큰 조회가 먼저 막는다");
        std::env::remove_var("CCG_NO_NET");
        assert!(!disabled());
        std::env::set_var("CCG_NO_NET", "0");
        assert!(!disabled(), "`0`은 끄는 값이다");
        std::env::remove_var("CCG_NO_NET");
    }

    #[test]
    fn retry_after_is_read_and_capped() {
        assert_eq!(retry_after_ms(r#"{"retry_after":3}"#), 3_000);
        assert_eq!(retry_after_ms(r#"{"error":{"retry_after":2.5}}"#), 2_500);
        assert_eq!(retry_after_ms("nope"), usage::RETRY_AFTER_DEFAULT_MS);
        assert_eq!(retry_after_ms(r#"{"retry_after":600}"#), usage::RETRY_AFTER_MAX_MS);
    }
}
