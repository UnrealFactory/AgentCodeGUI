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
    /// ★R3(F6·F2) — **최근 교환이 실패해 백오프 중**이라 이번엔 안 나갔다.
    ///
    /// 레인은 *직렬화*지 2.6.2 `refreshInflight`(약속 공유)가 아니라서, 앞 주자가 실패하면
    /// 뒤 주자가 자기 교환을 새로 나갔다(확인 크리틱 T3: 동시 4호출 → 4건 전부 교환).
    /// 죽은 refresh 토큰이면 그게 곧 **20초마다 무한 반복되는 교환 POST**다(F2-⑶).
    /// 이제 실패는 계정별 백오프로 남고, 그 창 안의 호출은 여기로 착지한다.
    RotateBackoff(String),
    /// ★R28 ACCT R2(N2) — **회전 금지 구역**([`crate::rotation`]) 안이라 교환을 안 했다.
    ///
    /// 선행 워밍이 그 구역이다. 이 착지는 실패가 아니라 *"물어보긴 했는데 토큰을 돌릴
    /// 수는 없어서 여기서 멈췄다"*이고, 호출부는 마지막 캐시로 갈음하면 된다 —
    /// 사용자가 Account 탭을 직접 열면 그때는 구역 밖이라 옛 규약대로 교환까지 간다.
    RotateForbidden(String),
    /// ★2026-09-05 — **429인데 서버가 부른 대기가 재시도 상한([`usage::RETRY_AFTER_MAX_MS`])보다
    /// 길다**, 또는 자고 나서 한 번 더 물었는데도 429다. 실측 `Retry-After: 3600`(계정 단위
    /// 시간 차단). 이 착지는 *"이 계정은 이만큼 건드리지 마라"*이고, 호출자의 격리 장부가
    /// 그 길이를 그대로 쓴다. 자거나 되묻지 않는다 — 차단 중 요청 하나하나가 차단을 늘린다.
    RateLimited {
        /// 서버가 부른 대기(ms) — [`usage::RETRY_AFTER_HOLD_MAX_MS`]까지만 믿는다.
        retry_after_ms: u64,
    },
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
            NetError::RotateBackoff(m) => write!(f, "refresh exchange backing off: {m}"),
            NetError::RotateForbidden(m) => write!(f, "refresh exchange forbidden here: {m}"),
            NetError::RateLimited { retry_after_ms } => write!(f, "http 429, retry after {}s", retry_after_ms / 1000),
        }
    }
}

pub struct HttpResponse {
    pub status: u16,
    pub body: String,
    /// ★T3T4 R2 — **응답 헤더**. R1은 상태와 본문만 들고 와서 429의 `Retry-After`를
    /// 읽을 수가 없었고(2.6.2 `auth.ts:552`가 읽는 바로 그 헤더), 대신 본문의
    /// `retry_after`를 봤다 — 그 필드가 없는 응답에서는 언제나 기본값 15초였다.
    pub headers: Vec<(String, String)>,
}

impl HttpResponse {
    /// 헤더 하나(대소문자 무시). HTTP 헤더 이름은 대소문자를 안 가린다.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
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
    let mut b = ureq::AgentBuilder::new()
        // ureq 2.x는 native-tls를 자동으로 안 쓴다 — 커넥터를 손으로 준다.
        .tls_connector(tls_connector()?)
        .timeout(Duration::from_millis(req.timeout_ms))
        // 리다이렉트를 따라가면 Authorization 헤더가 남의 호스트로 새어 나간다.
        .redirects(0);
    // ★R3(F9) — 명시 프록시. `proxy-from-env` 피처는 `default-features = false`라 꺼져
    // 있고 켜면 자동 감지가 기본값이 된다 — 그건 "몰래 프록시를 탄다"라 원하지 않는다.
    // 여기서는 **환경 변수를 우리가 읽어** 붙인다(없으면 R2와 한 글자도 다르지 않다).
    if let Some(p) = env_proxy(&req.url) {
        b = b.proxy(p);
    }
    let agent = b.build();
    let mut r = agent.request(req.method, &req.url);
    for (k, v) in &req.headers {
        r = r.set(k, v);
    }
    let res = match &req.body {
        Some(b) => r.send_string(b),
        None => r.call(),
    };
    match res {
        Ok(resp) => Ok(take(resp)),
        // ureq는 4xx/5xx를 에러로 준다 — 상태 코드는 생사검증의 판정 재료라 살려 보낸다.
        // **429가 바로 이 팔로 온다** — 헤더를 여기서 버리면 `Retry-After`도 함께 사라진다.
        Err(ureq::Error::Status(_, resp)) => Ok(take(resp)),
        Err(e) => Err(NetError::Transport(e.to_string())),
    }
}

/// ureq 응답 → [`HttpResponse`]. 본문을 읽으면 응답이 소비되므로 **헤더를 먼저** 뜬다.
fn take(resp: ureq::Response) -> HttpResponse {
    let status = resp.status();
    let headers = resp
        .headers_names()
        .into_iter()
        .filter_map(|k| resp.header(&k).map(|v| (k.clone(), v.to_string())))
        .collect();
    HttpResponse { status, body: resp.into_string().unwrap_or_default(), headers }
}

/// ★R3(F9) — `HTTPS_PROXY`·`ALL_PROXY`(+소문자)를 읽어 프록시를 만든다. `NO_PROXY`에
/// 걸리는 호스트는 통과. 사내 강제 프록시 환경에서는 이게 없으면 usage 조회도 **토큰
/// 회전도** 전부 `Transport` 실패였다(확인 크리틱 §6 — native-tls의 회귀가 아닌 선행 결함).
///
/// `ureq::Proxy::new`는 스킴으로 `http`/`socks*`만 받는다. `HTTPS_PROXY=https://…`는
/// "https 트래픽용 프록시"라는 뜻이지 프록시와 https로 말한다는 뜻이 아니므로 `http`로 읽는다.
fn env_proxy(url: &str) -> Option<ureq::Proxy> {
    let host = url.split("://").nth(1)?.split('/').next()?.split('@').next_back()?.split(':').next()?.to_lowercase();
    let get = |k: &str| std::env::var(k).ok().or_else(|| std::env::var(k.to_lowercase()).ok()).filter(|v| !v.trim().is_empty());
    if let Some(no) = get("NO_PROXY") {
        for pat in no.split(',').map(|s| s.trim().trim_start_matches('.').to_lowercase()).filter(|s| !s.is_empty()) {
            if pat == "*" || host == pat || host.ends_with(&format!(".{pat}")) {
                return None;
            }
        }
    }
    let raw = get("HTTPS_PROXY").or_else(|| get("ALL_PROXY"))?;
    let raw = raw.trim();
    let norm = raw.strip_prefix("https://").map(|r| format!("http://{r}")).unwrap_or_else(|| raw.to_string());
    // SOCKS는 `socks-proxy` 피처 밖이라 여기서 만들어 봐야 연결에서 죽는다. 스킴을 여기서
    // 걸러 **왜 안 되는지**를 한 줄로 남긴다(침묵 no-op 금지 · D7).
    if let Some((scheme, _)) = norm.split_once("://") {
        if scheme != "http" {
            eprintln!("[auth] 지원하지 않는 프록시 스킴({scheme})이라 직결로 진행한다: {raw}");
            return None;
        }
    }
    match ureq::Proxy::new(&norm) {
        Ok(p) => Some(p),
        Err(e) => {
            // 침묵 금지 — 프록시 설정 오타로 전 조회가 죽는 판의 유일한 원전이다.
            eprintln!("[auth] 프록시 주소를 못 읽었다({raw}): {e} — 프록시 없이 진행한다");
            None
        }
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

// ── ★R3(F6·F2) 계정별 교환 백오프 ───────────────────────────────────────────
//
// R2의 레인은 *직렬화*였다: 앞 주자가 실패하면 뒤 주자가 **자기 교환을 새로 나갔다**
// (확인 크리틱 T3 — 동시 4호출 → 4건 전부). 죽은 refresh 토큰이면 그건 대기자 수만큼의
// 헛 POST이고, 워커 쿨다운과 곱하면 **20초마다 영원히** 반복된다(F2-⑶, 상한 없음).
//
// 그래서 실패를 계정별로 남기고 지수 백오프를 건다. 성공하면 즉시 지운다 = 복구는
// "한 번 되면 끝"이다(사용자가 재로그인하면 그 다음 교환이 성공한다).

/// 첫 실패 뒤 쉬는 시간. 워커 쿨다운(20초)보다 커야 "매 tick 재시도"가 사라진다.
const ROTATE_BACKOFF_BASE: Duration = Duration::from_secs(60);
/// 상한 — 사용자가 재로그인해도 이 시간 안에는 다시 시도한다.
const ROTATE_BACKOFF_MAX: Duration = Duration::from_secs(30 * 60);
/// **계정 탓이 아닌** 실패(킬 스위치)도 *같은 순간의* 동시 호출끼리는 합친다 — 그게
/// 2.6.2 `refreshInflight`가 약속을 공유해서 얻던 성질이다. 지수 백오프는 안 붙인다:
/// `CCG_NO_NET`은 계정 상태가 아니라 프로세스 설정이고, 그걸로 계정을 벌하면 안 된다.
const SHARED_FLIGHT_TTL: Duration = Duration::from_millis(1_500);

struct Backoff {
    fails: u32,
    until: Instant,
    /// 마지막 실패의 사유(대기 중인 호출자에게 그대로 전한다 — 침묵 금지).
    why: String,
}

static ROTATE_FAILS: Mutex<Option<std::collections::BTreeMap<String, Backoff>>> = Mutex::new(None);

fn with_backoff<T>(f: impl FnOnce(&mut std::collections::BTreeMap<String, Backoff>) -> T) -> T {
    let mut g = ROTATE_FAILS.lock().unwrap_or_else(|e| e.into_inner());
    f(g.get_or_insert_with(Default::default))
}

/// 지금 이 계정의 교환이 막혀 있나 — 막혀 있으면 남은 사유.
fn backoff_hit(email: &str) -> Option<String> {
    with_backoff(|m| {
        let b = m.get(email)?;
        (Instant::now() < b.until).then(|| format!("{email}: {} (실패 {}회)", b.why, b.fails))
    })
}

fn note_rotate_failure(email: &str, why: &str) {
    with_backoff(|m| {
        let e = m.entry(email.to_string()).or_insert(Backoff { fails: 0, until: Instant::now(), why: String::new() });
        e.fails = e.fails.saturating_add(1);
        let wait = ROTATE_BACKOFF_BASE
            .saturating_mul(1u32 << (e.fails - 1).min(9))
            .min(ROTATE_BACKOFF_MAX);
        e.until = Instant::now() + wait;
        e.why = why.to_string();
        eprintln!("[auth] {email} 토큰 교환 실패 {}회 — {:?} 동안 재시도하지 않는다({why})", e.fails, wait);
    });
}

/// 계정 탓이 아닌 실패 — **결과만 공유**하고 실패 횟수는 안 올린다.
fn note_shared_flight(email: &str, why: &str) {
    with_backoff(|m| {
        let e = m.entry(email.to_string()).or_insert(Backoff { fails: 0, until: Instant::now(), why: String::new() });
        e.until = Instant::now() + SHARED_FLIGHT_TTL;
        e.why = why.to_string();
    });
}

/// 성공 = 복구. 사용자가 재로그인한 뒤 첫 성공에서 여기를 지난다.
pub fn clear_rotate_backoff(email: &str) {
    with_backoff(|m| m.remove(email));
}

/// 이 계정의 교환이 몇 번 연속 실패했나(진단·격리 판정). 0이면 건강하다.
pub fn rotate_failures(email: &str) -> u32 {
    with_backoff(|m| m.get(email).map(|b| b.fails).unwrap_or(0))
}

/// 테스트·하네스용 — 프로세스 전역 백오프 장부를 비운다.
pub fn forget_backoff() {
    with_backoff(|m| m.clear());
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
    // ★R3(F6) — ③' 앞 주자가 **실패**했으면 우리도 안 나간다. 여기가 2.6.2
    //   `refreshInflight`가 약속을 공유해 얻던 성질(= 실패도 합친다)의 자리다.
    if let Some(why) = backoff_hit(email) {
        return Err(NetError::RotateBackoff(why));
    }
    // ★R28 ACCT R2(N2) — ③'' 회전 금지 구역(선행 워밍)이면 여기서 멈춘다.
    if let Some(e) = rotation_gate(email) {
        return Err(e);
    }
    rotate(email)
}

/// ★R28 ACCT R2(N2) — 회전으로 가는 **두 문의 공통 관문**([`crate::rotation`]).
///
/// 문이 둘([`access_token`]·[`force_refresh`])이라 인자를 늘리는 방식은 하나를 빠뜨리는
/// 순간 성질이 조용히 사라진다. 관문을 하나 두고 둘 다 여기를 지나게 한다 — 그러면
/// *"워밍은 토큰을 회전시키지 않는다"*가 문장이 아니라 **코드의 성질**이 된다
/// (확인 크리틱 R1 N2: R1의 문은 로컬 만료 시각만 봐서 401/403 경로가 열려 있었다).
fn rotation_gate(email: &str) -> Option<NetError> {
    if !crate::rotation::forbidden() {
        return None;
    }
    // 침묵 no-op 금지 — "워밍인데 왜 값이 안 갱신됐나"의 유일한 원전이다.
    eprintln!("[auth] {email}: 회전 금지 구역(선행 워밍)이라 토큰 교환을 하지 않는다 — 마지막 캐시로 갈음한다");
    Some(NetError::RotateForbidden(email.to_string()))
}

/// 실제 교환 한 바퀴. **[`access_token`]의 레인 안에서만** 불린다.
fn rotate(email: &str) -> Result<String, NetError> {
    let out = rotate_once(email);
    match &out {
        Ok(_) => clear_rotate_backoff(email),
        // 킬 스위치는 **계정**의 문제가 아니다(하네스 주행). 그래도 이 순간 줄 서 있던
        // 호출자들에게는 같은 답을 준다 — 그게 "레인당 교환 1건"의 실체다(F6/T3).
        Err(e @ NetError::Disabled) => note_shared_flight(email, &e.to_string()),
        Err(e) => note_rotate_failure(email, &e.to_string()),
    }
    out
}

fn rotate_once(email: &str) -> Result<String, NetError> {
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
/// | 회전 있음 | **한쪽만**(폴더 또는 백업) | `Ok(access)` + 경고 — 신선한 쪽을 `freshest_creds`가 고른다 |
/// | 회전 있음 | **아무 데도 못 씀** | **`Err(TokenLost)`** — 이 계정은 재로그인이다 |
/// | 회전 있음 | 그 계정이 스토어에서 사라졌다 | `Err(NoToken)` — 사용자가 로그아웃한 것이지 토큰을 잃은 게 아니다 |
/// | 회전 없음(액세스만 갱신) | 실패 | `Ok(access)` + 경고 — 옛 refresh는 아직 살아 있다 |
///
/// ★R3(F3) — **`access_token` 검사보다 회전 판정이 먼저**다. R2는 첫 줄에서
/// `access_token`이 없으면 `BadBody`로 이탈했는데, 그 응답이 새 `refresh_token`을 물고
/// 있었다면 옛 토큰은 이미 서버에서 죽었고 새 것은 저장도 로그도 없이 사라졌다
/// (확인 크리틱 T1 — C1이 닫으려던 바로 그 침묵의 잔재).
///
/// ★R3(F7) — `TokenLost`는 **어디에도 안 남았을 때만**이다. 폴더에 정착했는데
/// "재로그인이 필요할 수 있습니다"라고 말하면 그 문장이 틀린다(T2).
pub fn store_rotation(
    email: &str,
    base_creds: &str,
    body: &Value,
    sent_refresh: &str,
    now_ms_: f64,
) -> Result<String, NetError> {
    let access = body.get("access_token").and_then(Value::as_str);
    let returned = body.get("refresh_token").and_then(Value::as_str);
    // **회전했다** = 서버가 우리가 보낸 것과 다른 refresh 토큰을 돌려줬다.
    let rotated = returned.is_some_and(|r| r != sent_refresh);
    if access.is_none() && !rotated {
        // 잃은 것이 없다 — 그냥 우리가 못 읽는 응답이다.
        return Err(NetError::BadBody);
    }
    let next = match access {
        Some(a) => claude::apply_refresh(
            base_creds,
            a,
            returned,
            body.get("expires_in").and_then(Value::as_f64).unwrap_or(3600.0),
            now_ms_,
        ),
        // ★F3 — 액세스 토큰이 없어도 **회전된 refresh는 반드시 적는다**. 만료 시각은
        // 건드리지 않는다(액세스 토큰은 여전히 만료 상태다 — 다음 호출이 다시 교환한다).
        None => claude::apply_rotated_refresh(base_creds, returned.unwrap_or(sent_refresh)),
    };
    let report = match next {
        // `apply_refresh`의 `None`은 base가 JSON 객체가 아니라는 뜻이다 — 회전된 토큰을
        // 접어 넣을 그릇이 없다. R1은 이 가지에서 **아무 말 없이** 옛 토큰을 남겼다.
        None => Err("크리덴셜 원문이 JSON 객체가 아니라 회전 결과를 접어 넣을 수 없다".to_string()),
        Some(next) => {
            let mut last = claude::persist_refreshed_report(email, &next);
            // 남은 시도는 **고칠 수 있는 실패**에만 쓴다. 로그아웃된 계정은 몇 번을 더
            // 해도 같은 답이라 재시도가 곧 40ms × 2의 낭비다.
            for _ in 1..PERSIST_TRIES {
                if last.both() || last.unregistered {
                    break;
                }
                std::thread::sleep(Duration::from_millis(PERSIST_BACKOFF_MS));
                last = claude::persist_refreshed_report(email, &next);
            }
            Ok(last)
        }
    };
    // 액세스 토큰이 없는 판(F3)은 저장에 성공해도 **돌려줄 값이 없다** — 다음 호출이
    // 방금 적은 새 refresh로 다시 교환한다. 그래서 `BadBody`로 착지하되 토큰은 남았다.
    let landed_value = || match access {
        Some(a) => Ok(a.to_string()),
        None => Err(NetError::BadBody),
    };
    if report.as_ref().map(|r| r.both()).unwrap_or(false) {
        return landed_value();
    }
    let why = match &report {
        Ok(r) => r.why(),
        Err(m) => m.clone(),
    };
    // 침묵 금지 — 이 줄이 "왜 갑자기 재로그인이 떴나"의 유일한 원전이다.
    eprintln!("[auth] ★ 리프레시 결과 저장 실패 {email}: {why} (서버 회전={rotated})");
    if report.as_ref().map(|r| r.unregistered).unwrap_or(false) {
        // 조회 중에 사용자가 그 계정을 로그아웃했다. 남길 곳이 없는 게 정상이고,
        // "재로그인이 필요할 수 있습니다"는 틀린 문장이다.
        //
        // ★R28d(CASX R3) — **어디에 남았는지는 사실대로 적는다.** R2가 [`claude::freshest_creds`]를
        // 폴더까지 보게 하면서, 「행은 없는데 폴더는 있다」는 판(로그아웃이 아니라 행 유실)에서
        // 폴더 반쪽이 **성공한 채로** 이 가지에 처음 도달하게 됐다(확인 크리틱 R2 §7 곁가지).
        // 그때 "남기지 않는다"는 틀린 문장이다 — 아래 `landed()` 검사는 이 `return` 뒤라
        // 영영 안 닿는다. 돌려주는 값(`NoToken`)은 그대로다: 스토어에 행이 없으면 사용자의
        // 계정 목록에도 없고, 그 계정을 자동 전환 후보로 계속 두는 쪽이 더 틀린다.
        if report.as_ref().map(|r| r.landed()).unwrap_or(false) {
            eprintln!("[auth] {email}는 스토어에서 사라졌다(로그아웃) — 회전 결과는 계정 폴더에만 남겼다");
        } else {
            eprintln!("[auth] {email}는 스토어에서 사라졌다(로그아웃) — 회전 결과를 남기지 않는다");
        }
        return Err(NetError::NoToken);
    }
    if report.as_ref().map(|r| r.landed()).unwrap_or(false) {
        // 한쪽만 남았다 = 회전 결과는 살아 있다(`freshest_creds`가 신선한 쪽을 고른다).
        eprintln!("[auth] {email}: 회전 결과가 한쪽에만 남았다 — 재로그인은 아니다");
        return landed_value();
    }
    if rotated {
        return Err(NetError::TokenLost(format!("{email}: {why}")));
    }
    // 서버가 같은 refresh를 그대로 돌려줬다 = 잃은 것은 이번 액세스 토큰뿐이다.
    landed_value()
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/// ★T3T4 R2 — **강제 교환**(2.6.2 `freshAccountToken(email, true)`).
///
/// 401/403은 "시간상 유효해 보이는 토큰이 서버에서는 죽었다"는 뜻이다(다른 프로세스의
/// 그랜트 회전 등). 그때만 부른다 — 평시 경로는 여전히 [`access_token`](로컬 우선)이다.
///
/// `stale`은 방금 거절당한 토큰이다. 레인에서 줄 서 있는 사이 앞 주자가 이미 새 토큰을
/// 받아 놨으면 **그것이 답이고 교환을 또 하지 않는다** — 이중 회전은 잘해야 4xx 한 번이고
/// 나쁘면 방금 저장한 refresh 토큰이 죽는다(R2 C1이 닫은 자리).
pub fn force_refresh(email: &str, stale: &str) -> Result<String, NetError> {
    let lane = lane(email);
    let _flight = lane.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(t) = claude::account_access_token(email) {
        if t != stale {
            return Ok(t);
        }
    }
    if let Some(why) = backoff_hit(email) {
        return Err(NetError::RotateBackoff(why));
    }
    // ★R28 ACCT R2(N2) — 401/403에서 여기로 온다. 워밍이면 **여기가 끝이다**.
    if let Some(e) = rotation_gate(email) {
        return Err(e);
    }
    rotate(email)
}

/// 계정 한 건의 한도 — `GET /api/oauth/usage` + [`usage::parse_account_usage`].
///
/// 2.6.2 `fetchAccountUsage`(`auth.ts:533-560`)와 **같은 순서**다:
///
/// | # | 응답 | 하는 일 |
/// |---|---|---|
/// | ① | 401·403 | 강제 교환 후 **1회** 재시도(토큰이 그대로면 재시도할 이유가 없다). ★R2(N2) — [`crate::rotation`] 금지 구역(선행 워밍) 안이면 **교환하지 않고** 그대로 실패로 착지한다 |
/// | ② | 429 | `Retry-After`만큼 자고 **1회** 재시도(**원래 토큰으로** — 그쪽도 `hit(token)`이다) |
/// | ③ | 그 밖의 비200 | 실패(호출부가 마지막 성공값으로 폴백) |
///
/// 재시도를 각각 1회로 묶는 이유: 두 번 이상 물고 늘어지면 계정 6개 훑기가 분 단위로
/// 늘어난다 — 그 자리는 캐시가 메운다.
pub fn fetch_account_usage(email: &str) -> Result<AccountUsage, NetError> {
    let token = access_token(email)?;
    let req = usage::usage_request(&token);
    let mut resp = send(&req)?;
    // ① 서버가 무효화한 토큰 — 시간만 보는 로컬 판정으로는 못 거른다.
    if resp.status == 401 || resp.status == 403 {
        if let Ok(fresh) = force_refresh(email, &token) {
            if fresh != token {
                resp = send(&usage::usage_request(&fresh))?;
            }
        }
    }
    // ② 레이트리밋 — 예산이 매우 빡빡한 엔드포인트(분당 1~2건 실측).
    //
    // ★2026-09-05 — 서버가 부른 대기가 **재시도 상한(30s)보다 길면 자지도 되묻지도 않는다.**
    // 실측 `Retry-After: 3600`을 30초로 잘라 자고 곧바로 다시 두드렸고(그 사이 직렬 큐가
    // 통째로 30초 멈춘다), 실패 → 3분 격리 → 또 2건… 차단 중인 계정에 시간당 수십 건이
    // 나가 차단이 풀리지 않았다. 그 길이는 호출자의 격리 장부로 넘긴다.
    if resp.status == 429 {
        let wait = retry_after_ms(&resp);
        if wait > usage::RETRY_AFTER_MAX_MS {
            return Err(NetError::RateLimited { retry_after_ms: wait });
        }
        std::thread::sleep(Duration::from_millis(wait));
        resp = send(&req)?;
        if resp.status == 429 {
            return Err(NetError::RateLimited { retry_after_ms: retry_after_ms(&resp) });
        }
    }
    if !(200..300).contains(&resp.status) {
        return Err(NetError::Status(resp.status));
    }
    let v: Value = serde_json::from_str(&resp.body).map_err(|_| NetError::BadBody)?;
    Ok(usage::parse_account_usage(email, &v))
}

/// BUG-0013(클로드 축) — 구독 종류의 서버 진실(`GET /api/oauth/profile`,
/// [`usage::parse_profile_subscription`]). 401·403이면 [`fetch_account_usage`]와 같은
/// 규칙으로 1회 교환 후 재시도한다. `Ok(None)`은 응답은 왔는데 종류를 못 읽었다는 뜻이다
/// (호출부가 아는 값을 유지한다). 429는 여기서 자지 않는다 — 구독 되싱크는 급하지 않다.
pub fn fetch_account_subscription(email: &str) -> Result<Option<String>, NetError> {
    let token = access_token(email)?;
    let mut resp = send(&usage::profile_request(&token))?;
    if resp.status == 401 || resp.status == 403 {
        if let Ok(fresh) = force_refresh(email, &token) {
            if fresh != token {
                resp = send(&usage::profile_request(&fresh))?;
            }
        }
    }
    if !(200..300).contains(&resp.status) {
        return Err(NetError::Status(resp.status));
    }
    let v: Value = serde_json::from_str(&resp.body).map_err(|_| NetError::BadBody)?;
    Ok(usage::parse_profile_subscription(&v))
}

/// 429의 대기 시간 — **`Retry-After` 헤더가 먼저다**(2.6.2가 읽는 그 값:
/// `parseInt(res.headers.get('retry-after'))` → 초). 없으면 본문의 `retry_after`(3.0이
/// 관찰한 형태), 그것도 없으면 기본값. 어느 쪽이든 상한([`usage::RETRY_AFTER_MAX_MS`])
/// 까지만 믿는다 — 서버가 3600을 불러도 계정 훑기를 한 시간 세울 수는 없다.
///
/// 2.6.2는 `parseInt`라 `"3.9"`는 3이고 `"120, 60"`도 120이다. 헤더는 초 단위 정수가
/// 규약(RFC 9110)이라 여기서도 **앞자리 정수만** 읽는다.
///
/// ★2026-09-05 — 상한은 [`usage::RETRY_AFTER_HOLD_MAX_MS`](1시간)다. 30초([`usage::RETRY_AFTER_MAX_MS`])는
/// *자고 되묻는* 상한이고 그 판정은 [`fetch_account_usage`]가 한다 — 여기서 30초로 잘라
/// 버리면 서버가 부른 「1시간」이 사라져 격리 장부가 3분짜리 곡선으로 되돌아간다.
fn retry_after_ms(resp: &HttpResponse) -> u64 {
    let from_header = resp.header("retry-after").and_then(|v| {
        let digits: String = v.trim().chars().take_while(char::is_ascii_digit).collect();
        digits.parse::<u64>().ok().map(|s| s.saturating_mul(1000))
    });
    from_header
        .or_else(|| {
            serde_json::from_str::<Value>(&resp.body)
                .ok()
                .and_then(|v| {
                    v.get("retry_after")
                        .or_else(|| v.get("error").and_then(|e| e.get("retry_after")))
                        .and_then(Value::as_f64)
                })
                .map(|s| (s * 1000.0) as u64)
        })
        .unwrap_or(usage::RETRY_AFTER_DEFAULT_MS)
        .clamp(0, usage::RETRY_AFTER_HOLD_MAX_MS)
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
        crate::claude::write_store_file(&accounts, Some(email)).expect("스토어 저장");
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

        // ② ★ 회전 + **어디에도** 못 씀. R2는 "스토어에서 계정이 사라진 판"을 이 자리에
        //    썼는데, 그건 폴더에는 멀쩡히 앉은 상태라 판정이 오경보였다(R2 확인 크리틱 T2).
        //    진짜 치명은 **두 반쪽이 다 실패**하는 판이다: 폴더 경로에 파일이 있어
        //    디렉터리를 못 만들고(잔재 파일·검사기 잠금), 백업 credEnc는 못 푼다.
        let dead = "dead@x";
        seed(dead, 1_000.0, Some("r-old"));
        let dead_base = claude::freshest_creds(dead).expect("시드 크리덴셜");
        let _ = std::fs::remove_dir_all(claude::account_dir(dead));
        std::fs::create_dir_all(claude::accounts_dir()).unwrap();
        std::fs::write(claude::account_dir(dead), b"not a directory").unwrap(); // 폴더 반쪽 파괴
        crate::claude::update_account_record(dead, |m| m.insert("credEnc".into(), json!("bm90LWEtcmVhbC1ibG9i")))
            .expect("백업 반쪽 파괴");
        let rot = json!({ "access_token": "A-2", "refresh_token": "r-2", "expires_in": 3600 });
        let verdict = store_rotation(dead, &dead_base, &rot, "r-old", 2_000_000.0);
        println!("[C1] 회전→양쪽 저장 실패 = {verdict:?}");
        assert!(
            matches!(verdict, Err(NetError::TokenLost(ref m)) if m.contains(dead)),
            "★ 회전 결과를 못 남겼으면 치명 에러여야 한다(삼키면 그 계정은 재로그인이다): {verdict:?}"
        );

        // ②' ★R3(F7) — 폴더에는 정착했는데 백업만 실패한 판은 **재로그인이 아니다**.
        let half = "half@x";
        seed(half, 1_000.0, Some("r-old"));
        let half_base = claude::freshest_creds(half).expect("시드");
        crate::claude::update_account_record(half, |m| m.insert("credEnc".into(), json!("bm90LWEtcmVhbC1ibG9i")))
            .expect("백업만 파괴");
        let ok_h = json!({ "access_token": "A-h", "refresh_token": "r-h", "expires_in": 3600 });
        let v2 = store_rotation(half, &half_base, &ok_h, "r-old", 5_000_000.0);
        println!("[R3/F7] 폴더만 정착 = {v2:?}");
        assert_eq!(v2, Ok("A-h".into()), "★ 폴더에 남았는데 TokenLost면 사용자에게 거짓말이다");
        let folder = std::fs::read_to_string(claude::account_dir(half).join(".credentials.json")).unwrap();
        assert!(folder.contains("r-h"), "회전된 토큰이 폴더에 있어야 그 판정이 참이다");

        // ②'' ★R3(F7) — 그 계정이 스토어에서 **사라졌다**(다른 창에서 로그아웃).
        //     남길 곳이 없는 게 정상이고 "재로그인이 필요할 수 있습니다"는 틀린 문장이다.
        crate::claude::write_store_file(&[], None).expect("스토어 저장");
        let ok_g = json!({ "access_token": "A-g", "refresh_token": "r-g", "expires_in": 3600 });
        let gone = store_rotation("idle@x", &base, &ok_g, "r-old", 6_000_000.0);
        println!("[R3/F7] 로그아웃된 계정 = {gone:?}");
        assert_eq!(gone, Err(NetError::NoToken), "★ 로그아웃은 토큰 유실이 아니다");
        seed("idle@x", 1_000.0, Some("r-new")); // 뒤 단계를 위해 되살린다

        // ③ 회전이 **없었으면**(서버가 같은 refresh를 그대로) 저장 실패는 치명이 아니다 —
        //    잃은 것은 이번 액세스 토큰뿐이고 옛 refresh는 아직 살아 있다.
        let base = claude::freshest_creds("idle@x").expect("시드");
        let same = json!({ "access_token": "A-3", "refresh_token": "r-new", "expires_in": 3600 });
        assert_eq!(store_rotation("idle@x", &base, &same, "r-new", 3_000_000.0), Ok("A-3".into()));
        let none = json!({ "access_token": "A-4", "expires_in": 3600 });
        assert_eq!(store_rotation("idle@x", &base, &none, "r-new", 4_000_000.0), Ok("A-4".into()));

        // ④ 액세스도 없고 회전도 없는 응답은 교환 실패다(그릇을 건드리지 않는다).
        assert_eq!(store_rotation("idle@x", &base, &json!({ "ok": true }), "r-new", 0.0), Err(NetError::BadBody));
        drop(h);
    }

    /// ★R3(F3) — **200인데 `access_token`이 없다.** 서버가 200을 준 순간 옛 refresh는
    /// 죽었다. R2는 첫 줄에서 `BadBody`로 이탈해 새 토큰을 저장도 로그도 없이 버렸다
    /// (확인 크리틱 T1). 이제는 착지가 `BadBody`여도 **새 refresh는 디스크에 있다**.
    #[test]
    fn a_rotation_without_an_access_token_still_lands_the_new_refresh() {
        let h = temp_home("rotate-noaccess");
        seed("t1@x", 1_000.0, Some("r-old"));
        let base = claude::freshest_creds("t1@x").expect("시드");
        let body = json!({ "refresh_token": "r-NEW", "expires_in": 3600 });
        let verdict = store_rotation("t1@x", &base, &body, "r-old", now_ms());
        println!("[R3/F3] verdict={verdict:?} 저장된 refresh={:?}", refresh_of("t1@x"));
        assert_eq!(refresh_of("t1@x").as_deref(), Some("r-NEW"), "★ 서버가 회전시킨 토큰을 말없이 버렸다");
        // 쓸 액세스 토큰은 여전히 없다 = 만료 상태 그대로여야 한다(숨기면 죽은 토큰으로 조회한다).
        assert!(claude::account_access_token("t1@x").is_none(), "만료를 앞당겨 밀면 안 된다");
        assert_eq!(verdict, Err(NetError::BadBody), "돌려줄 액세스 토큰은 없다");
        drop(h);
    }

    /// ★R3(F6) — 앞 주자가 **실패**하면 뒤 주자는 자기 교환을 새로 안 나간다.
    /// R2의 레인은 직렬화라 죽은 refresh 하나에 대기자 수만큼 POST가 나갔다(T3).
    #[test]
    fn a_failed_exchange_backs_off_instead_of_repeating_per_caller() {
        let h = temp_home("rotate-backoff");
        std::env::set_var("CCG_NO_NET", "1");
        forget_backoff();
        seed("bo@x", 1_000.0, Some("r-dead"));
        // ① 킬 스위치 실패는 계정 탓이 아니다 — 결과는 공유하되 실패 횟수는 안 올린다.
        assert_eq!(access_token("bo@x"), Err(NetError::Disabled));
        assert_eq!(rotate_failures("bo@x"), 0, "CCG_NO_NET은 계정 문제가 아니다");
        forget_backoff();
        std::env::remove_var("CCG_NO_NET");

        // ② 진짜 실패(4xx 등)를 심는다 → 그다음 호출들은 안 나간다.
        note_rotate_failure("bo@x", "http 400");
        let hands: Vec<_> = (0..4).map(|_| std::thread::spawn(|| access_token("bo@x"))).collect();
        let outs: Vec<_> = hands.into_iter().map(|t| t.join().unwrap()).collect();
        println!("[R3/F6] 백오프 중 4호출 = {outs:?}");
        assert!(outs.iter().all(|r| matches!(r, Err(NetError::RotateBackoff(_)))), "★ 백오프 창에서 교환이 또 나갔다");
        assert_eq!(rotate_failures("bo@x"), 1, "대기자는 실패 횟수를 늘리지 않는다");

        // ③ 복구 — 성공(또는 재로그인 뒤 첫 성공)이면 즉시 풀린다.
        clear_rotate_backoff("bo@x");
        assert_eq!(rotate_failures("bo@x"), 0);
        forget_backoff();
        drop(h);
    }

    /// ★R3(F9) — 명시 프록시. env가 없으면 R2와 동작이 같다(= `None`).
    #[test]
    fn the_proxy_comes_from_the_environment_and_respects_no_proxy() {
        let _h = temp_home("proxy"); // env 토글이 다른 테스트와 겹치지 않게 직렬화
        for k in ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"] {
            std::env::remove_var(k);
        }
        assert!(env_proxy(usage::USAGE_URL).is_none(), "env가 없으면 프록시도 없다");
        std::env::set_var("HTTPS_PROXY", "http://corp.proxy:8080");
        assert!(env_proxy(usage::USAGE_URL).is_some());
        // https:// 접두사는 "https 트래픽용"이라는 뜻이라 http로 읽는다(ureq는 거절한다)
        std::env::set_var("HTTPS_PROXY", "https://corp.proxy:8080");
        assert!(env_proxy(usage::USAGE_URL).is_some(), "https:// 표기를 못 읽으면 사내 환경에서 전 조회가 죽는다");
        std::env::set_var("NO_PROXY", "example.com,.anthropic.com");
        assert!(env_proxy(usage::USAGE_URL).is_none(), "NO_PROXY에 걸린 호스트는 직결이다");
        std::env::set_var("NO_PROXY", "example.com");
        assert!(env_proxy(usage::USAGE_URL).is_some());
        // SOCKS는 피처 밖이라 만들어 봐야 연결에서 죽는다 — 여기서 걸러 로그를 남긴다.
        std::env::set_var("HTTPS_PROXY", "socks5://corp.proxy:1080");
        assert!(env_proxy("https://x.test/y").is_none(), "지원 못 하는 스킴은 직결로(죽지 않는다)");
        for k in ["HTTPS_PROXY", "NO_PROXY"] {
            std::env::remove_var(k);
        }
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

    /// ★R28 ACCT R2(N2) — **금지 구역 안에서는 회전이 시작조차 안 된다.**
    ///
    /// 판별식은 **에러의 종류**다. 킬 스위치가 켜져 있어도 구역 밖이면 교환은 *시도*돼
    /// 전송에서 거절된다(`Disabled`) — 실제 서버라면 그 순간 POST가 나가고 성공하면
    /// 옛 refresh 토큰이 죽는다. 구역 안이면 그 앞에서 멈추므로 `RotateForbidden`이다.
    /// 두 착지가 갈리는 것이 곧 "워밍은 회전을 시작하지 않는다"의 증거다.
    ///
    /// (`cargo test -p ccg-auth --features net`에서만 돈다 — 기본 빌드에는 이 파일이
    ///  컴파일조차 안 된다. 정책 자체의 못은 `rotation.rs`에 따로 있다.)
    #[test]
    fn a_no_rotate_scope_stops_the_exchange_before_it_starts() {
        let h = temp_home("no-rotate");
        std::env::set_var("CCG_NO_NET", "1");
        forget_backoff();
        // 만료된 액세스 토큰 + 살아 있는 refresh = **회전이 필요한** 계정.
        let email = "warm@x";
        seed(email, 1_000.0, Some("r-1"));
        assert!(claude::account_access_token(email).is_none(), "전제: 로컬 토큰이 만료다");

        // ① 구역 밖 — 교환을 *시도*한다(킬 스위치라 전송에서 거절된다).
        let outside = access_token(email).err();
        println!("[N2] 구역 밖 = {outside:?}");
        assert_eq!(outside, Some(NetError::Disabled), "전제가 깨졌다 — 여기가 교환을 시도하는 자리다");

        // ② 구역 안 — **전송까지 가지 않는다**.
        forget_backoff();
        let inside = crate::rotation::forbid(|| access_token(email)).err();
        println!("[N2] 구역 안 = {inside:?}");
        assert!(
            matches!(inside, Some(NetError::RotateForbidden(_))),
            "★ 워밍이 토큰 교환을 시작했다(성공하면 옛 refresh가 서버에서 죽는다): {inside:?}"
        );
        // 401/403에서 오는 두 번째 문도 같은 관문을 지난다.
        forget_backoff();
        let forced = crate::rotation::forbid(|| force_refresh(email, "A-old")).err();
        println!("[N2] force_refresh(구역 안) = {forced:?}");
        assert!(matches!(forced, Some(NetError::RotateForbidden(_))), "★ 401 경로가 관문을 안 지난다: {forced:?}");
        // 구역을 나오면 원래대로다(금지가 새면 이후 모든 회전이 죽는다).
        forget_backoff();
        assert_eq!(access_token(email).err(), Some(NetError::Disabled), "★ 금지가 구역 밖으로 샜다");

        std::env::remove_var("CCG_NO_NET");
        forget_backoff();
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

    fn resp(status: u16, body: &str, headers: &[(&str, &str)]) -> HttpResponse {
        HttpResponse {
            status,
            body: body.to_string(),
            headers: headers.iter().map(|(k, v)| ((*k).to_string(), (*v).to_string())).collect(),
        }
    }

    /// ★T3T4 R2(확인 크리틱 [부분]) — **`Retry-After` 헤더가 먼저다.**
    /// R1은 헤더를 통째로 버리고(`HttpResponse`에 자리가 없었다) 본문만 봤다 —
    /// 그 필드가 없는 실제 429에서는 언제나 기본값 15초였다(2.6.2와 다른 동작).
    #[test]
    fn retry_after_prefers_the_header_then_the_body_and_is_capped() {
        assert_eq!(retry_after_ms(&resp(429, "", &[("retry-after", "3")])), 3_000, "헤더가 있으면 헤더다");
        assert_eq!(retry_after_ms(&resp(429, "", &[("Retry-After", "7")])), 7_000, "헤더 이름은 대소문자를 안 가린다");
        // 헤더가 이기고 본문은 안 본다(2.6.2와 같은 우선순위).
        assert_eq!(retry_after_ms(&resp(429, r#"{"retry_after":1}"#, &[("retry-after", "9")])), 9_000);
        // 2.6.2는 `parseInt`다 — 소수·꼬리 문자열은 앞자리 정수만.
        assert_eq!(retry_after_ms(&resp(429, "", &[("retry-after", "3.9")])), 3_000);
        assert_eq!(retry_after_ms(&resp(429, "", &[("retry-after", "Wed, 21 Oct 2026 07:28:00 GMT")])), usage::RETRY_AFTER_DEFAULT_MS, "HTTP-date 형식은 못 읽는다 = 기본값");
        // 헤더가 없으면 본문(3.0이 관찰한 형태) — R1의 동작을 유지한다.
        assert_eq!(retry_after_ms(&resp(429, r#"{"retry_after":3}"#, &[])), 3_000);
        assert_eq!(retry_after_ms(&resp(429, r#"{"error":{"retry_after":2.5}}"#, &[])), 2_500);
        assert_eq!(retry_after_ms(&resp(429, "nope", &[])), usage::RETRY_AFTER_DEFAULT_MS);
        // ★2026-09-05 — 긴 값은 **잘리지 않고 그대로** 온다(격리 장부가 그 길이를 쓴다). 자고
        // 되묻는 30초 상한은 `fetch_account_usage`의 판정이지 이 함수의 몫이 아니다.
        assert_eq!(retry_after_ms(&resp(429, "", &[("retry-after", "600")])), 600_000, "10분은 10분이다");
        assert_eq!(retry_after_ms(&resp(429, r#"{"retry_after":600}"#, &[])), 600_000);
        assert_eq!(retry_after_ms(&resp(429, "", &[("retry-after", "3600")])), usage::RETRY_AFTER_HOLD_MAX_MS, "실측 3600 = 1시간");
        // 그래도 상한은 있다 — 서버가 하루를 불러도 계정을 하루 동안 잊지는 않는다.
        assert_eq!(retry_after_ms(&resp(429, "", &[("retry-after", "86400")])), usage::RETRY_AFTER_HOLD_MAX_MS);
        assert!(usage::RETRY_AFTER_HOLD_MAX_MS > usage::RETRY_AFTER_MAX_MS, "격리 상한이 재시도 상한보다 길어야 판정이 갈린다");
    }

    /// ★T3T4 R2(확인 크리틱 [부분]) — **전역 게이트가 실제로 간격을 벌리는가.**
    /// 상수만 대조하는 테스트는 게이트를 통째로 걷어내도 초록이다(2.6.2 `usageSlot`의
    /// 간격이 사라지면 같은 IP의 연속 호출이 429로 튕긴다 — M5 R1 실측).
    #[test]
    fn the_global_gate_actually_spaces_the_calls() {
        let gap = Duration::from_millis(usage::USAGE_GAP_MS);
        throttle(); // 기준점 — 앞선 테스트가 남긴 시각과 무관하게 만든다
        let t0 = Instant::now();
        throttle();
        let first = t0.elapsed();
        let t1 = Instant::now();
        throttle();
        let second = t1.elapsed();
        println!("[gate] 연속 호출 간격 = {first:?} · {second:?} (규약 {gap:?})");
        // 타이머 눈금(Windows ~15.6ms)만큼의 여유만 준다.
        let slack = Duration::from_millis(30);
        assert!(first + slack >= gap, "★ 게이트가 간격을 안 벌렸다: {first:?}");
        assert!(second + slack >= gap, "★ 두 번째 호출도 간격이 필요하다: {second:?}");
        assert!(first < gap * 3, "필요 이상으로 잔다(호출 하나가 {first:?})");
    }

    /// 응답 헤더가 **실제로 실려 온다**(위 판정의 전제). 본문을 읽으면 응답이 소비되므로
    /// 헤더를 먼저 뜨는 순서가 깨지면 여기서 빈 목록이 된다.
    #[test]
    fn a_response_carries_its_headers() {
        let r = resp(429, "{}", &[("retry-after", "5"), ("x-req-id", "abc")]);
        assert_eq!(r.header("RETRY-AFTER"), Some("5"));
        assert_eq!(r.header("x-req-id"), Some("abc"));
        assert_eq!(r.header("nope"), None);
    }
}
