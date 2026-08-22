//! 계정별 한도(usage) — **2.6.2가 실제로 쓰는 두 경로를 그대로** 조립한다.
//!
//! | 엔진 | 경로 | 근거(2.6.2 코드) |
//! |---|---|---|
//! | Anthropic | `GET https://api.anthropic.com/api/oauth/usage`<br>`Authorization: Bearer <OAuth access token>` + `anthropic-beta: oauth-2025-04-20` | `src/main/auth.ts` `fetchAccountUsage`, `src/main/index.ts` `fetchUsage` |
//! | OpenAI(Codex) | `codex app-server` 스폰 → JSON-RPC `initialize`(id 1) → **`account/rateLimits/read`**(id 2) → kill | `src/main/codex/auth.ts` `codexRpcOnce` |
//!
//! CLI 서브커맨드로 얻는 게 아니다 — Anthropic은 저장된 OAuth 토큰으로 **직접 HTTPS**,
//! Codex는 짧게 띄운 **app-server의 JSON-RPC**다. 계정을 전환하지 않고 계정 수만큼 조회할 수
//! 있는 게 두 경로의 핵심 성질이고, 그래서 "계정별 한도 표시"가 가능하다.
//!
//! **이 모듈은 요청을 만들고 응답을 읽을 뿐, 아무것도 보내지 않는다**(크레이트에 전송
//! 계층이 없다). 배선 라운드가 [`crate::HttpRequest`]/[`crate::CommandSpec`]을 그대로 실어
//! 보내면 2.6.2와 같은 호출이 된다.

use crate::{CommandSpec, HttpRequest};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
pub const OAUTH_BETA: &str = "oauth-2025-04-20";
/// CLI와 같은 공개 클라이언트(로그인 URL 실측). 리프레시 교환에 쓴다.
pub const OAUTH_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
pub const OAUTH_TOKEN_URLS: &[&str] =
    &["https://console.anthropic.com/v1/oauth/token", "https://platform.claude.com/v1/oauth/token"];

/// usage API는 세게 레이트리밋된다(실측: 같은 IP의 병렬 2건 중 1건이 429, 짧은 연속 호출도
/// 429). 2.6.2는 전 프로세스의 usage 호출을 **하나의 큐로 직렬화**하고 사이에 간격을 뒀다 —
/// 이 상수들이 그 정책이다(실행은 배선 라운드).
pub const USAGE_GAP_MS: u64 = 1_200;
/// 계정별 한도 캐시 TTL(설정 Account 목록).
pub const ACCT_USAGE_TTL_MS: u64 = 2 * 60 * 1000;
/// 컨텍스트 팝오버 한도 캐시 TTL / 강제 새로고침의 바닥 TTL.
pub const USAGE_TTL_MS: u64 = 5 * 60 * 1000;
pub const USAGE_TTL_FRESH_MS: u64 = 15 * 1000;
/// 429의 Retry-After 상한(2.6.2: 기본 15s, 최대 30s).
pub const RETRY_AFTER_DEFAULT_MS: u64 = 15_000;
pub const RETRY_AFTER_MAX_MS: u64 = 30_000;
pub const USAGE_CACHE_FILE: &str = "usage-cache.json";

// ── 요청 조립 ───────────────────────────────────────────────────────────────

/// 한도 조회 1건. 생사검증도 **같은 요청**을 쓴다(401/403이면 그 토큰은 죽은 것 —
/// 1.6.1 `validateSnapshotToken`이 쓰던 판정과 같은 엔드포인트다).
pub fn usage_request(access_token: &str) -> HttpRequest {
    HttpRequest {
        method: "GET",
        url: USAGE_URL.into(),
        headers: vec![
            ("Authorization".into(), format!("Bearer {access_token}")),
            ("anthropic-beta".into(), OAUTH_BETA.into()),
        ],
        body: None,
        timeout_ms: 5_000,
    }
}

/// 리프레시 토큰 교환 — 2.6.2는 두 엔드포인트를 **순서대로** 시도한다(앞이 4xx면 다음).
pub fn refresh_requests(refresh_token: &str) -> Vec<HttpRequest> {
    OAUTH_TOKEN_URLS
        .iter()
        .map(|url| HttpRequest {
            method: "POST",
            url: (*url).into(),
            headers: vec![("content-type".into(), "application/json".into())],
            body: Some(
                json!({ "grant_type": "refresh_token", "refresh_token": refresh_token, "client_id": OAUTH_CLIENT_ID })
                    .to_string(),
            ),
            timeout_ms: 10_000,
        })
        .collect()
}

// ── 응답 해석 (Anthropic) ───────────────────────────────────────────────────

/// 설정 Account 목록의 계정 1행. 필드 이름은 2.6.2 `AccountUsage`(protocol.ts) 그대로 —
/// 디스크 캐시(`usage-cache.json`)가 이 모양이라 이름이 바뀌면 캐시가 통째로 무효가 된다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsage {
    pub email: String,
    pub five_hour_pct: Option<i64>,
    pub weekly_pct: Option<i64>,
    pub fable_pct: Option<i64>,
    pub five_hour_resets_at: Option<i64>,
    pub weekly_resets_at: Option<i64>,
    pub fable_resets_at: Option<i64>,
}

impl AccountUsage {
    pub fn empty(email: &str) -> AccountUsage {
        AccountUsage {
            email: email.into(),
            five_hour_pct: None,
            weekly_pct: None,
            fable_pct: None,
            five_hour_resets_at: None,
            weekly_resets_at: None,
            fable_resets_at: None,
        }
    }
}

/// 0~100 정수로 죈다. 2.6.2는 `utilization`이 문자열로도 오는 걸 실측해 `parseFloat`을 쓴다.
fn pct(v: Option<&Value>) -> Option<i64> {
    let v = v?;
    let n = match v {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) => parse_float_prefix(s)?,
        _ => return None,
    };
    Some((n.round() as i64).clamp(0, 100))
}

/// JS `parseFloat` — 앞에서부터 읽히는 만큼만 숫자로 본다("83%" → 83).
fn parse_float_prefix(s: &str) -> Option<f64> {
    let t = s.trim_start();
    let mut end = 0;
    let b = t.as_bytes();
    if end < b.len() && (b[end] == b'+' || b[end] == b'-') {
        end += 1;
    }
    while end < b.len() && b[end].is_ascii_digit() {
        end += 1;
    }
    if end < b.len() && b[end] == b'.' {
        end += 1;
        while end < b.len() && b[end].is_ascii_digit() {
            end += 1;
        }
    }
    t[..end].parse::<f64>().ok()
}

/// ISO 문자열 → unix 초. 2.6.2 `toTs`와 같은 규칙(파싱 실패는 null).
pub fn to_ts(s: Option<&str>) -> Option<i64> {
    let ms = crate::codex::parse_iso8601_ms(s?)?;
    Some((ms / 1000.0).floor() as i64)
}

/// `/api/oauth/usage` 응답 → 계정 행. (2.6.2 `fetchAccountUsage`)
///
/// Fable 5 주간 한도는 `seven_day_*` 같은 legacy 필드가 아니라 **`limits[]`** 로 온다 —
/// `kind === 'weekly_scoped'` + 모델 표시명에 `fable` 포함.
pub fn parse_account_usage(email: &str, body: &Value) -> AccountUsage {
    let fable = body.get("limits").and_then(Value::as_array).and_then(|ls| {
        ls.iter().find(|l| {
            l.get("kind").and_then(Value::as_str) == Some("weekly_scoped")
                && l.get("scope")
                    .and_then(|s| s.get("model"))
                    .and_then(|m| m.get("display_name"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_lowercase()
                    .contains("fable")
        })
    });
    AccountUsage {
        email: email.into(),
        five_hour_pct: pct(body.get("five_hour").and_then(|o| o.get("utilization"))),
        weekly_pct: pct(body.get("seven_day").and_then(|o| o.get("utilization"))),
        fable_pct: fable.and_then(|f| f.get("percent")).and_then(Value::as_f64).map(|n| (n.round() as i64).clamp(0, 100)),
        five_hour_resets_at: to_ts(body.get("five_hour").and_then(|o| o.get("resets_at")).and_then(Value::as_str)),
        weekly_resets_at: to_ts(body.get("seven_day").and_then(|o| o.get("resets_at")).and_then(Value::as_str)),
        fable_resets_at: to_ts(fable.and_then(|f| f.get("resets_at")).and_then(Value::as_str)),
    }
}

/// 컨텍스트 팝오버가 쓰는 더 넓은 모양 — 창 3종 + **추가 사용 크레딧**(claude.ai의 "사용
/// 크레딧"과 같은 데이터). 원본: `src/main/index.ts` `fetchUsage`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageInfo {
    pub five_hour: Option<UsageWindow>,
    pub weekly: Option<UsageWindow>,
    pub weekly_fable: Option<UsageWindow>,
    pub extra_credit: Option<ExtraCredit>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub pct: i64,
    pub resets_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtraCredit {
    pub enabled: bool,
    pub out_of_credits: bool,
    pub currency: String,
    pub used: Option<f64>,
    pub cap: Option<f64>,
    pub balance: Option<f64>,
    pub pct: Option<i64>,
}

/// 금액 — 숫자 그대로 / `{amount_minor, exponent}` / `{money|credits}` 래퍼를 모두 수용한다
/// (두 형태가 실측에서 다 관찰됐다).
fn money(m: Option<&Value>) -> Option<f64> {
    let m = m?;
    if m.is_null() {
        return None;
    }
    if let Some(n) = m.as_f64() {
        return Some(n);
    }
    if !m.is_object() {
        return None;
    }
    if let Some(minor) = m.get("amount_minor").and_then(Value::as_f64) {
        let exp = m.get("exponent").and_then(Value::as_f64).unwrap_or(2.0);
        return Some(minor / 10f64.powf(exp));
    }
    money(m.get("money")).or_else(|| money(m.get("credits")))
}

pub fn parse_usage_info(body: &Value) -> UsageInfo {
    let win = |o: Option<&Value>| -> Option<UsageWindow> {
        let o = o?;
        Some(UsageWindow {
            // 2.6.2: parseFloat(...) || 0 — 못 읽으면 0으로 본다(null이 아니다)
            pct: pct(o.get("utilization")).unwrap_or(0),
            resets_at: to_ts(o.get("resets_at").and_then(Value::as_str)),
        })
    };
    let fable = body.get("limits").and_then(Value::as_array).and_then(|ls| {
        ls.iter().find(|l| {
            l.get("kind").and_then(Value::as_str) == Some("weekly_scoped")
                && l.get("scope")
                    .and_then(|s| s.get("model"))
                    .and_then(|m| m.get("display_name"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_lowercase()
                    .contains("fable")
        })
    });
    let sp = body.get("spend").filter(|v| !v.is_null());
    let out_of_credits = sp.and_then(|s| s.get("disabled_reason")).and_then(Value::as_str) == Some("out_of_credits");
    UsageInfo {
        five_hour: win(body.get("five_hour")),
        weekly: win(body.get("seven_day")),
        weekly_fable: fable.map(|f| UsageWindow {
            pct: (f.get("percent").and_then(Value::as_f64).unwrap_or(0.0).round() as i64).clamp(0, 100),
            resets_at: to_ts(f.get("resets_at").and_then(Value::as_str)),
        }),
        extra_credit: sp.map(|sp| ExtraCredit {
            enabled: sp.get("enabled").and_then(Value::as_bool).unwrap_or(false),
            out_of_credits,
            currency: sp
                .get("used")
                .and_then(|u| u.get("currency"))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .unwrap_or("USD")
                .to_string(),
            used: money(sp.get("used")),
            cap: money(sp.get("cap")).or_else(|| money(sp.get("limit"))),
            balance: money(sp.get("balance")).or(if out_of_credits { Some(0.0) } else { None }),
            pct: sp.get("percent").and_then(Value::as_f64).map(|n| (n.round() as i64).clamp(0, 100)),
        }),
    }
}

// ── 디스크 캐시 ─────────────────────────────────────────────────────────────

/// `usage-cache.json` — 퍼센트뿐이라 민감정보가 아니고, 앱을 켜자마자 마지막 값이 보이게
/// 하는 용도다(레이트리밋으로 첫 조회가 늦어도 게이지가 비지 않는다).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CachedUsage {
    pub at: i64,
    pub data: AccountUsage,
}

pub fn read_usage_cache() -> std::collections::BTreeMap<String, CachedUsage> {
    let mut out = std::collections::BTreeMap::new();
    let Some(Value::Object(m)) = ccg_store::read_home_json(USAGE_CACHE_FILE) else { return out };
    for (k, v) in m {
        // 2.6.2: `if (v && v.data)` — 깨진 항목은 조용히 버린다
        if let Ok(c) = serde_json::from_value::<CachedUsage>(v) {
            out.insert(k, c);
        }
    }
    out
}

/// 2.6.2와 같이 **들여쓰기 없이** 쓴다(`JSON.stringify(Object.fromEntries(cache))`).
pub fn write_usage_cache(cache: &std::collections::BTreeMap<String, CachedUsage>) {
    let Ok(text) = serde_json::to_string(cache) else { return };
    let _ = ccg_store::write_home_file(USAGE_CACHE_FILE, &text);
}

// ── Codex: app-server JSON-RPC ──────────────────────────────────────────────

pub const CODEX_RATE_LIMITS_METHOD: &str = "account/rateLimits/read";

/// `codex app-server`를 그 계정의 `CODEX_HOME`으로 띄우는 명령. 2.6.2는 한 번 쏘고 죽인다
/// (스폰이 ≈0.7s라 폴링이 프로세스를 반복 생성하지 않게 2분 캐시가 앞에 있다).
pub fn codex_app_server_command(bin: &str, codex_home: &std::path::Path) -> CommandSpec {
    CommandSpec {
        program: bin.into(),
        args: vec!["app-server".into()],
        env: vec![("CODEX_HOME".into(), codex_home.to_string_lossy().to_string())],
        timeout_ms: 12_000,
    }
}

/// stdin에 흘려보낼 두 프레임(개행 구분 JSON-RPC). id 1의 응답이 오면 id 2를 쏜다.
pub fn codex_rpc_frames(method: &str) -> (String, String) {
    let init = json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": { "clientInfo": { "name": "agentcodegui", "title": "AgentCodeGUI", "version": "2.0.0" }, "capabilities": null }
    });
    let call = json!({ "jsonrpc": "2.0", "id": 2, "method": method });
    (init.to_string(), call.to_string())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAccountUsage {
    pub email: String,
    pub plan_type: Option<String>,
    pub windows: Vec<CodexWindow>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexWindow {
    /// 창 길이(분) — 라벨은 표시 계층이 만든다. 2.6.2는 여기서 문자열로 굳혀 렌더러가
    /// **라벨 텍스트로 시간창을 판별**했다(정렬 규칙이 '5h'/'Weekly'를 읽는다).
    pub window_minutes: i64,
    pub used_pct: i64,
    pub resets_at: Option<i64>,
}

/// `account/rateLimits/read`의 result → 계정 행. `primary`/`secondary` 순서를 지킨다.
pub fn parse_codex_rate_limits(email: &str, result: &Value) -> CodexAccountUsage {
    let rl = result.get("rateLimits");
    let mut windows = Vec::new();
    if let Some(rl) = rl {
        for key in ["primary", "secondary"] {
            let Some(w) = rl.get(key).filter(|v| !v.is_null()) else { continue };
            let (Some(used), Some(mins)) =
                (w.get("usedPercent").and_then(Value::as_f64), w.get("windowDurationMins").and_then(Value::as_f64))
            else {
                continue;
            };
            windows.push(CodexWindow {
                window_minutes: mins as i64,
                used_pct: (used.round() as i64).clamp(0, 100),
                resets_at: w.get("resetsAt").and_then(Value::as_f64).map(|n| n as i64),
            });
        }
    }
    CodexAccountUsage {
        email: email.into(),
        plan_type: rl.and_then(|r| r.get("planType")).and_then(Value::as_str).map(str::to_string),
        windows,
    }
}

/// 창 길이(분) → 표시 라벨. **영어 라벨이 규약**이다 — 설정 화면의 정렬이 `'5h'`/`'Weekly'`를
/// 읽어 시간창을 판별한다(2.6.2 `windowLabel` 그대로).
pub fn window_label_en(mins: i64) -> String {
    if mins <= 0 {
        return "Limit".into();
    }
    if mins <= 1440 {
        return format!("{}h", std::cmp::max(1, ((mins as f64) / 60.0).round() as i64));
    }
    let d = ((mins as f64) / 1440.0).round() as i64;
    if d == 7 {
        "Weekly".into()
    } else {
        format!("{d}d")
    }
}

pub fn window_label_ko(mins: i64) -> String {
    if mins <= 0 {
        return "한도".into();
    }
    if mins <= 1440 {
        return format!("{}시간", std::cmp::max(1, ((mins as f64) / 60.0).round() as i64));
    }
    let d = ((mins as f64) / 1440.0).round() as i64;
    if d == 7 {
        "주간".into()
    } else {
        format!("{d}일")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_request_is_the_2_6_2_call() {
        let r = usage_request("tok");
        assert_eq!(r.method, "GET");
        assert_eq!(r.url, "https://api.anthropic.com/api/oauth/usage");
        assert_eq!(r.headers[0], ("Authorization".into(), "Bearer tok".into()));
        assert_eq!(r.headers[1], ("anthropic-beta".into(), "oauth-2025-04-20".into()));
        assert_eq!(r.body, None);
    }

    #[test]
    fn refresh_tries_console_then_platform() {
        let rs = refresh_requests("r-1");
        assert_eq!(rs.len(), 2);
        assert_eq!(rs[0].url, "https://console.anthropic.com/v1/oauth/token");
        assert_eq!(rs[1].url, "https://platform.claude.com/v1/oauth/token");
        let b: Value = serde_json::from_str(rs[0].body.as_ref().unwrap()).unwrap();
        assert_eq!(b["grant_type"], json!("refresh_token"));
        assert_eq!(b["refresh_token"], json!("r-1"));
        assert_eq!(b["client_id"], json!(OAUTH_CLIENT_ID));
    }

    /// 실홈 `usage-cache.json`에서 관찰된 모양(5h 0% / 주간 93% / Fable 79%)을 응답으로 되짚는다.
    #[test]
    fn account_usage_parses_windows_and_the_fable_limit() {
        let body = json!({
            "five_hour": { "utilization": 0, "resets_at": "2026-08-20T15:00:00Z" },
            "seven_day": { "utilization": "93.4", "resets_at": "2026-08-20T23:59:59Z" },
            "limits": [
                { "kind": "weekly", "percent": 12 },
                { "kind": "weekly_scoped", "percent": 78.6, "resets_at": "2026-08-20T23:59:59Z",
                  "scope": { "model": { "display_name": "Claude Fable 5" } } }
            ]
        });
        let u = parse_account_usage("a@x.com", &body);
        assert_eq!(u.five_hour_pct, Some(0));
        assert_eq!(u.weekly_pct, Some(93), "문자열 utilization도 읽어야 한다");
        assert_eq!(u.fable_pct, Some(79));
        assert_eq!(u.weekly_resets_at, Some(1_787_270_399));
        assert_eq!(u.fable_resets_at, u.weekly_resets_at);
        // 필드가 통째로 없는 플랜
        let bare = parse_account_usage("a@x.com", &json!({}));
        assert_eq!(bare, AccountUsage::empty("a@x.com"));
    }

    #[test]
    fn usage_info_parses_both_money_shapes() {
        let a = parse_usage_info(&json!({
            "five_hour": { "utilization": 40 },
            "spend": { "enabled": true, "percent": 25, "used": { "amount_minor": 1234, "currency": "USD", "exponent": 2 }, "cap": { "amount_minor": 5000, "exponent": 2 } }
        }));
        let e = a.extra_credit.unwrap();
        assert_eq!(e.used, Some(12.34));
        assert_eq!(e.cap, Some(50.0));
        assert_eq!(e.currency, "USD");
        assert_eq!(e.pct, Some(25));
        assert_eq!(a.five_hour, Some(UsageWindow { pct: 40, resets_at: None }));

        // 토글은 켰지만 잔액 소진 — API가 enabled:false + out_of_credits로 내려준다
        let b = parse_usage_info(&json!({ "spend": { "enabled": false, "disabled_reason": "out_of_credits", "used": { "money": 7.5 } } }));
        let e = b.extra_credit.unwrap();
        assert!(e.out_of_credits);
        assert_eq!(e.balance, Some(0.0));
        assert_eq!(e.used, Some(7.5));
        assert_eq!(parse_usage_info(&json!({})).extra_credit, None);
    }

    #[test]
    fn usage_cache_is_written_without_indentation() {
        let h = crate::testkit::temp_home("usage-cache");
        let mut c = std::collections::BTreeMap::new();
        c.insert("a@x.com".to_string(), CachedUsage { at: 1787390138278, data: AccountUsage { five_hour_pct: Some(0), ..AccountUsage::empty("a@x.com") } });
        write_usage_cache(&c);
        let raw = h.read("usage-cache.json").unwrap();
        assert!(!raw.contains('\n'), "2.6.2는 들여쓰기 없이 쓴다: {raw}");
        assert!(raw.contains("\"fiveHourPct\":0"), "필드 이름이 2.6.2 캐시와 같아야 승계된다: {raw}");
        assert_eq!(read_usage_cache(), c);
    }

    /// 실홈 `usage-cache.json`의 실제 항목이 그대로 역직렬화되는가(승계 경로).
    #[test]
    fn real_home_usage_cache_deserializes() {
        let h = crate::testkit::temp_home("usage-cache-real");
        if !h.copy_real("usage-cache.json") {
            return;
        }
        let c = read_usage_cache();
        assert!(!c.is_empty(), "실홈 캐시가 있는데 한 항목도 못 읽으면 게이지가 빈 채로 뜬다");
        for (k, v) in &c {
            assert_eq!(&v.data.email, k);
        }
    }

    #[test]
    fn codex_rpc_frames_match_the_measured_handshake() {
        let (init, call) = codex_rpc_frames(CODEX_RATE_LIMITS_METHOD);
        let i: Value = serde_json::from_str(&init).unwrap();
        assert_eq!(i["method"], json!("initialize"));
        assert_eq!(i["id"], json!(1));
        assert_eq!(i["params"]["clientInfo"]["name"], json!("agentcodegui"));
        assert!(i["params"]["capabilities"].is_null());
        let c: Value = serde_json::from_str(&call).unwrap();
        assert_eq!(c["method"], json!("account/rateLimits/read"));
        assert_eq!(c["id"], json!(2));
    }

    #[test]
    fn codex_rate_limits_parse_and_label() {
        let r = json!({ "rateLimits": {
            "planType": "pro",
            "primary": { "usedPercent": 34.2, "windowDurationMins": 300, "resetsAt": 1784724661i64 },
            "secondary": { "usedPercent": 8.0, "windowDurationMins": 10080 }
        }});
        let u = parse_codex_rate_limits("me@openai.com", &r);
        assert_eq!(u.plan_type.as_deref(), Some("pro"));
        assert_eq!(u.windows.len(), 2);
        assert_eq!(u.windows[0], CodexWindow { window_minutes: 300, used_pct: 34, resets_at: Some(1784724661) });
        assert_eq!(u.windows[1].resets_at, None);
        assert_eq!(window_label_en(300), "5h");
        assert_eq!(window_label_en(10080), "Weekly");
        assert_eq!(window_label_ko(300), "5시간");
        assert_eq!(window_label_ko(10080), "주간");
        assert_eq!(window_label_en(0), "Limit");
        assert_eq!(window_label_en(4320), "3d");
        assert_eq!(window_label_en(30), "1h", "30분도 최소 1시간으로 올린다(2.6.2 max(1, …))");
        // 빈 결과는 빈 창 목록
        assert_eq!(parse_codex_rate_limits("x", &json!({})).windows.len(), 0);
    }
}
