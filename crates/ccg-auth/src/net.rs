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
    /// ★R2 C1 — **서버는 회전시켰는데 우리가 못 받아 적었다.**
    ///
    /// 교환이 성공하면 그 순간 옛 refresh 토큰은 **서버에서 죽는다**. 새 토큰을 폴더와
    /// 백업 양쪽에 못 쓰면 남는 것은 죽은 토큰뿐이고 그 계정의 출구는 **재로그인**이다.
    /// R1은 이 자리를 `let _ =`로 삼켰다(로그 한 줄도 없었다) — 계정 6개가 걸린 자리라
    /// 여기서만은 조용한 실패를 금지한다: 재시도까지 하고도 실패하면 **에러로 착지**한다.
    TokenLost(String),
}

impl std::fmt::Display for NetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NetError::Disabled => write!(f, "network disabled (CCG_NO_NET)"),
            NetError::NoToken => write!(f, "no usable access token"),
            NetError::Status(s) => write!(f, "http {s}"),
            NetError::Transport(m) => write!(f, "transport: {m}"),
            NetError::BadBody => write!(f, "response body was not JSON"),
            NetError::TokenLost(m) => write!(f, "rotated refresh token could not be saved: {m}"),
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
        // ureq 2.x는 native-tls를 자동으로 안 쓴다 — 커넥터를 손으로 준다.
        .tls_connector(tls_connector()?)
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

/// TLS 커넥터는 **프로세스당 하나**면 된다(핸드셰이크마다 만들 이유가 없다).
/// OS 스토어(schannel)를 그대로 쓴다 — 루트 인증서를 앱에 번들하지 않는다.
fn tls_connector() -> Result<std::sync::Arc<native_tls::TlsConnector>, NetError> {
    static TLS: std::sync::OnceLock<Result<std::sync::Arc<native_tls::TlsConnector>, String>> =
        std::sync::OnceLock::new();
    TLS.get_or_init(|| native_tls::TlsConnector::new().map(std::sync::Arc::new).map_err(|e| e.to_string()))
        .clone()
        .map_err(NetError::Transport)
}

/// 회전 결과 저장 재시도 — 파일 잠금·바이러스 검사기 같은 **일시 실패**에 계정 하나를
/// 잃을 수는 없다. 3번까지 시도하고 그래도 안 되면 그때 [`NetError::TokenLost`]다.
const PERSIST_TRIES: u32 = 3;
const PERSIST_BACKOFF_MS: u64 = 40;

/// ★R2 C1(b) — **단일 비행**(2.6.2 `auth.ts:411 refreshInflight`의 이식).
///
/// > *"같은 계정 동시 요청은 단일 비행으로 합쳐 **이중 회전**을 막는다."*
///
/// 이중 회전은 두 번째 교환이 첫 번째가 방금 받은 refresh 토큰을 **모른 채** 옛 토큰으로
/// 나가는 것이라, 잘해야 4xx 한 번이고 나쁘면 방금 저장한 토큰이 죽는다. R1에서는
/// 호출자가 워커 스레드 하나라 *우연히* 안전했을 뿐이고 그 성질은 코드 어디에도 없었다
/// (크리틱 C1-⑤). 이제 계정별 레인이 그 성질을 코드로 들고 있다 — 뒤따라온 쪽은
/// 앞 주자가 **저장까지 끝낸 뒤** 깨어나 그 결과를 재확인하고 쓴다(아래 이중 검사).
static LANES: Mutex<std::collections::BTreeMap<String, std::sync::Arc<Mutex<()>>>> =
    Mutex::new(std::collections::BTreeMap::new());

fn lane(email: &str) -> std::sync::Arc<Mutex<()>> {
    let mut g = LANES.lock().unwrap_or_else(|e| e.into_inner());
    g.entry(email.to_string()).or_default().clone()
}

/// 액세스 토큰 확보 — 신선한 게 있으면 **그대로 쓰고**, 만료됐고 리프레시 재료가 있으면
/// 그때만 **교환한다**(2.6.2 `freshAccountToken(force=false)`와 같은 의미론).
///
/// 교환 결과는 폴더·백업 **둘 다**에 되쓴다([`claude::persist_refreshed`]) — 회전된
/// refresh 토큰을 한쪽에만 남기면 다른 쪽이 죽은 토큰이 되고, 그게 곧 재로그인이다.
/// 저장에 실패하면 **[`NetError::TokenLost`]로 착지한다**(R1은 `let _`로 삼켰다).
pub fn access_token(email: &str) -> Result<String, NetError> {
    // ① 신선하면 회전 없음 — 이 문이 "노는 계정만 교환한다"의 실체다.
    if let Some(t) = claude::account_access_token(email) {
        return Ok(t);
    }
    // ② 계정별 단일 비행. 이 락을 잡는 동안 같은 계정의 다른 호출은 여기서 줄을 선다.
    let lane = lane(email);
    let _flight = lane.lock().unwrap_or_else(|e| e.into_inner());
    // ③ 이중 검사 — 줄 서 있는 사이에 앞 주자가 회전+저장을 끝냈으면 그 토큰이 답이다.
    if let Some(t) = claude::account_access_token(email) {
        return Ok(t);
    }
    rotate(email)
}

/// 실제 교환 한 바퀴. **[`access_token`]의 레인 안에서만** 불린다.
fn rotate(email: &str) -> Result<String, NetError> {
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
        // ★ 여기서부터는 **되돌릴 수 없다**: 서버가 200을 줬다 = 옛 refresh 토큰은 죽었다.
        return store_rotation(email, &base, &v, &refresh, now_ms());
    }
    Err(last)
}

/// ★R2 C1(a) — **교환 응답을 디스크에 정착시킨다.** 네트워크가 필요 없는 조각으로 떼어 둔
/// 이유는 하나다: *"회전은 났는데 저장이 실패했다"* 를 **실 HTTP 없이 재생**할 수 있어야
/// 하기 때문이다(아래 `a_rotation_that_cannot_be_saved_is_a_fatal_error`).
///
/// 판정:
///
/// | 응답 | 저장 | 결과 |
/// |---|---|---|
/// | 회전 있음(새 `refresh_token`) | 성공 | `Ok(access)` |
/// | 회전 있음 | **실패**(재시도 3회 뒤) | **`Err(TokenLost)`** — 이 계정은 재로그인이다 |
/// | 회전 없음(액세스만 갱신) | 실패 | `Ok(access)` + 경고 — 옛 refresh는 아직 살아 있다 |
pub fn store_rotation(
    email: &str,
    base_creds: &str,
    body: &Value,
    sent_refresh: &str,
    now_ms_: f64,
) -> Result<String, NetError> {
    let Some(access) = body.get("access_token").and_then(Value::as_str) else {
        return Err(NetError::BadBody);
    };
    let returned = body.get("refresh_token").and_then(Value::as_str);
    // **회전했다** = 서버가 우리가 보낸 것과 다른 refresh 토큰을 돌려줬다.
    let rotated = returned.is_some_and(|r| r != sent_refresh);
    let saved = match claude::apply_refresh(
        base_creds,
        access,
        returned,
        body.get("expires_in").and_then(Value::as_f64).unwrap_or(3600.0),
        now_ms_,
    ) {
        // `apply_refresh`의 `None`은 base가 JSON 객체가 아니라는 뜻이다 — 회전된 토큰을
        // 접어 넣을 그릇이 없다. R1은 이 가지에서 **아무 말 없이** 옛 토큰을 남겼다.
        None => Err("크리덴셜 원문이 JSON 객체가 아니라 회전 결과를 접어 넣을 수 없다".to_string()),
        Some(next) => {
            let mut r = Err(String::new());
            for i in 0..PERSIST_TRIES {
                match claude::persist_refreshed(email, &next) {
                    Ok(()) => {
                        r = Ok(());
                        break;
                    }
                    Err(e) => {
                        r = Err(e.to_string());
                        if i + 1 < PERSIST_TRIES {
                            std::thread::sleep(Duration::from_millis(PERSIST_BACKOFF_MS));
                        }
                    }
                }
            }
            r
        }
    };
    match saved {
        Ok(()) => Ok(access.to_string()),
        Err(why) => {
            // 침묵 금지 — 이 줄이 "왜 갑자기 재로그인이 떴나"의 유일한 원전이다.
            eprintln!("[auth] ★ 리프레시 결과 저장 실패 {email}: {why} (서버 회전={rotated})");
            if rotated {
                Err(NetError::TokenLost(format!("{email}: {why}")))
            } else {
                // 서버가 같은 refresh를 그대로 돌려줬다 = 잃은 것은 이번 액세스 토큰뿐이다.
                Ok(access.to_string())
            }
        }
    }
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
    use crate::testkit::temp_home;
    use serde_json::json;

    /// 격리 홈에 합성 계정 하나(가짜 토큰). 실계정은 이 파일 어디에도 없다.
    fn seed(email: &str, expires_at_ms: f64, refresh: Option<&str>) {
        let mut oauth = json!({
            "accessToken": format!("A-{email}"),
            "expiresAt": expires_at_ms,
            "scopes": ["user:inference"],
        });
        if let Some(r) = refresh {
            oauth["refreshToken"] = json!(r);
        }
        let creds = json!({ "claudeAiOauth": oauth }).to_string();
        let snap = json!({ "creds": creds, "account": { "emailAddress": email, "uuid": format!("u-{email}") } });
        let enc = ccg_store::safe_storage::encrypt(&snap.to_string()).expect("safeStorage");
        let mut accounts: Vec<Value> = crate::claude::read_store_file().accounts.clone();
        accounts.retain(|a| crate::claude::email_of(a) != Some(email));
        accounts.push(json!({ "email": email, "credEnc": enc, "subscriptionType": "max" }));
        crate::claude::write_store_file(&accounts, Some(email));
    }

    fn refresh_of(email: &str) -> Option<String> {
        claude::refresh_token(email)
    }

    /// ★R2 C1(a) — **회전은 났는데 저장이 실패한 판.** R1은 `let _ = persist_refreshed(..)`로
    /// 삼켰다: 서버에서 이미 죽은 옛 토큰만 남고 로그 한 줄도 없다 = 조용한 재로그인.
    /// 실 HTTP 없이 재생한다(교환 응답을 손으로 만들어 [`store_rotation`]에 먹인다).
    #[test]
    fn a_rotation_that_cannot_be_saved_is_a_fatal_error() {
        let h = temp_home("rotate");
        seed("idle@x", 1_000.0, Some("r-old"));
        let base = claude::freshest_creds("idle@x").expect("시드 크리덴셜");

        // ① 정상 — 회전된 토큰이 폴더·백업 양쪽에 남는다.
        let ok = json!({ "access_token": "A-new", "refresh_token": "r-new", "expires_in": 3600 });
        assert_eq!(store_rotation("idle@x", &base, &ok, "r-old", now_ms()), Ok("A-new".into()));
        assert_eq!(refresh_of("idle@x").as_deref(), Some("r-new"), "회전 결과가 정착해야 한다");
        assert_eq!(claude::account_access_token("idle@x").as_deref(), Some("A-new"), "만료도 밀렸다");

        // ② ★ 회전 + 저장 불가 — 스토어에서 계정이 사라진 판(`NotRegistered`).
        //    실제로 이 모양이 되는 경로: 조회 중에 사용자가 그 계정을 로그아웃했다.
        crate::claude::write_store_file(&[], None);
        let rot = json!({ "access_token": "A-2", "refresh_token": "r-2", "expires_in": 3600 });
        let verdict = store_rotation("idle@x", &base, &rot, "r-old", 2_000_000.0);
        println!("[C1] 회전→저장실패 = {verdict:?}");
        assert!(
            matches!(verdict, Err(NetError::TokenLost(ref m)) if m.contains("idle@x")),
            "★ 회전 결과를 못 남겼으면 치명 에러여야 한다(삼키면 그 계정은 재로그인이다): {verdict:?}"
        );

        // ③ 회전이 **없었으면**(서버가 같은 refresh를 그대로) 저장 실패는 치명이 아니다 —
        //    잃은 것은 이번 액세스 토큰뿐이고 옛 refresh는 아직 살아 있다.
        let same = json!({ "access_token": "A-3", "refresh_token": "r-old", "expires_in": 3600 });
        assert_eq!(store_rotation("idle@x", &base, &same, "r-old", 3_000_000.0), Ok("A-3".into()));
        let none = json!({ "access_token": "A-4", "expires_in": 3600 });
        assert_eq!(store_rotation("idle@x", &base, &none, "r-old", 4_000_000.0), Ok("A-4".into()));

        // ④ 액세스 토큰이 없는 응답은 교환 실패다(그릇을 건드리지 않는다).
        assert_eq!(store_rotation("idle@x", &base, &json!({ "ok": true }), "r-old", 0.0), Err(NetError::BadBody));
        drop(h);
    }

    /// ★R2 C1(b) — **단일 비행**(2.6.2 `refreshInflight`). 뒤따라온 호출은 앞 주자가
    /// 저장을 끝낼 때까지 기다렸다가 **그 결과를 쓴다** — 두 번째 교환이 나가지 않는다.
    ///
    /// 판별식은 킬 스위치다: `CCG_NO_NET=1`에서 교환을 시도하면 `Err(Disabled)`이고,
    /// 앞 주자의 결과를 쓰면 `Ok(그 토큰)`이다. 단일 비행이 없으면 이 테스트는 전자다.
    #[test]
    fn a_second_caller_waits_for_the_first_rotation_instead_of_rotating_again() {
        let h = temp_home("inflight");
        std::env::set_var("CCG_NO_NET", "1");
        seed("sf@x", 1_000.0, Some("r-old")); // 만료 액세스 + 살아 있는 refresh = 교환 대상
        assert!(claude::account_access_token("sf@x").is_none());

        // 앞 주자가 레인을 잡고 교환 중인 상태를 손으로 만든다.
        let held = lane("sf@x");
        let guard = held.lock().unwrap();
        let t = std::thread::spawn(|| access_token("sf@x"));
        std::thread::sleep(Duration::from_millis(80));
        assert!(!t.is_finished(), "★ 같은 계정의 두 번째 호출은 레인에서 줄을 서야 한다");

        // 앞 주자가 회전 + 저장을 끝냈다.
        let base = claude::freshest_creds("sf@x").unwrap();
        let next = claude::apply_refresh(&base, "A-rotated", Some("r-new"), 3600.0, now_ms()).unwrap();
        claude::persist_refreshed("sf@x", &next).expect("저장");
        drop(guard);

        let got = t.join().unwrap();
        println!("[C1] 뒤따라온 호출 = {got:?}");
        assert_eq!(got, Ok("A-rotated".into()), "★ 두 번째 교환이 나갔다면 여기는 Err(Disabled)다");
        std::env::remove_var("CCG_NO_NET");
        drop(h);
    }

    /// 킬 스위치가 **유일한 출구**([`send`])를 막는가. 다른 함수는 전부 이 문을 지난다.
    #[test]
    fn the_kill_switch_blocks_the_only_exit() {
        // 격리 홈에서 돈다 — `CCG_NO_NET` 토글이 다른 테스트와 겹치지 않게 직렬화하고,
        // `fetch_account_usage`가 사용자 실홈의 계정 목록을 여는 일도 없게 한다.
        let h = temp_home("killswitch");
        std::env::set_var("CCG_NO_NET", "1");
        assert!(disabled());
        assert_eq!(send(&usage::usage_request("tok")).err(), Some(NetError::Disabled));
        assert_eq!(fetch_account_usage("nobody@example.com").err(), Some(NetError::NoToken), "토큰 조회가 먼저 막는다");
        std::env::remove_var("CCG_NO_NET");
        assert!(!disabled());
        std::env::set_var("CCG_NO_NET", "0");
        assert!(!disabled(), "`0`은 끄는 값이다");
        std::env::remove_var("CCG_NO_NET");
        drop(h);
    }

    #[test]
    fn retry_after_is_read_and_capped() {
        assert_eq!(retry_after_ms(r#"{"retry_after":3}"#), 3_000);
        assert_eq!(retry_after_ms(r#"{"error":{"retry_after":2.5}}"#), 2_500);
        assert_eq!(retry_after_ms("nope"), usage::RETRY_AFTER_DEFAULT_MS);
        assert_eq!(retry_after_ms(r#"{"retry_after":600}"#), usage::RETRY_AFTER_MAX_MS);
    }
}
