//! 한도 조회 — `usage:get` · `auth:accounts-usage` (최종 파리티 감사 R1 §3.1 **T3**).
//!
//! ## 왜 이게 치명인가
//!
//! R1까지 두 채널 다 Rust 핸들러가 없어 심이 `{fiveHour:null, weekly:null, …}`를
//! 돌려줬다. 화면은 멀쩡히 뜨는데 셋이 조용히 죽어 있었다:
//!
//! 1. 워크바 한도 게이지가 「데이터 없음」 — **블라인드 A/B의 유일한 1패**.
//! 2. 설정 ▸ Account의 「한도 적게 남은순」 정렬이 근거 없이 돈다.
//! 3. ★ **한도 자동 이어서의 2단 재검증이 항상 「풀렸다」로 오판한다.**
//!    `useLimitResume.ts:144`의 `blockedResetsAt(await getUsage(...))`가 전부 `null`인
//!    창 목록을 받으면 "막는 창 없음"으로 착지한다(`limitResume.ts:62-71` — `!w` continue).
//!    즉 조회가 죽어 있는 동안 M11이 세운 안전장치는 **10분마다 다시 막히는 재전송기**였다.
//!    이 파일이 실값을 흘려 보내는 순간 그 판정이 되살아난다 — **훅은 한 글자도 안 고친다**
//!    (프로젝트 규약: 렌더러 이식본 불가침).
//!
//! ## 이 파일이 하는 일과 하지 않는 일
//!
//! `crates/ccg-auth`가 이미 **요청 빌더·파서·HTTP 실행기**를 전부 갖고 있다(M5·M11).
//! 그래서 여기는 조립만 한다 — ccg-auth는 **한 줄도 고치지 않는다**(T1T2 갈래가 같은
//! 크레이트를 만지고 있어 파일 단위로 겹치지 않는 게 이번 라운드의 규율이다).
//!
//! | 조각 | 어디서 |
//! |---|---|
//! | `GET /api/oauth/usage` + 헤더 2개 | `ccg_auth::usage::usage_request` |
//! | 응답 → `UsageInfo` / `AccountUsage` | `ccg_auth::usage::parse_usage_info` · `parse_account_usage` |
//! | 실행기(ureq·리다이렉트 0·**전역 1200ms 게이트**) | `ccg_auth::net::send` |
//! | 토큰(로컬 우선 → 만료면 리프레시·계정별 단일 비행) | `ccg_auth::net::access_token` |
//! | 429 1회 재시도 + 디스크 캐시 | `ccg_auth::net::fetch_account_usage` · `usage::{read,write}_usage_cache` |
//!
//! **여기서 새로 만드는 것은 캐시 계층 하나뿐이다**: 2.6.2 `index.ts:1006-1037`의
//! `usageCache`(메모리·토큰 동치·TTL 5분/신선 15초·in-flight 합류)를 그대로 옮긴 것.
//! `auth:accounts-usage` 쪽 2분 TTL은 **디스크 캐시**(`usage-cache.json`)를 읽는다 —
//! `engine/acct_switch.rs`의 자동 전환기가 쓰는 바로 그 파일이라, 둘이 서로의 조회를
//! 재사용하고 **두 벌의 조회 루프가 생기지 않는다**.
//!
//! ## 1200ms 직렬화는 여기 없다 — net 계층에 이미 있다
//!
//! 2.6.2는 `auth.ts:503` `usageSlot`(전역 프로미스 사슬)로 두 경로를 함께 직렬화했다.
//! 3.0은 같은 규약이 **`net::send`의 전역 `GATE`**에 있다(`USAGE_GAP_MS = 1_200`).
//! 더 아래(모든 발신 공통)라 여기서 또 감싸면 간격이 2400ms로 겹친다 — 감싸지 않는다.
//!
//! ## 블로킹
//!
//! `net::send`는 ureq(동기)이고 게이트에서 최대 1.2초, 429면 최대 30초를 **스레드째**
//! 잔다. 그래서 이 모듈의 채널은 `ipc_call`의 `spawn_blocking` 팔로 간다(`parity::owns`).
//! tokio 워커에서 돌면 그 시간 동안 다른 창의 IPC가 통째로 굶는다.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// 2.6.2 `index.ts:1026` `empty` — 조회 불가일 때의 안전값(심의 `NO_USAGE`와 같은 모양).
fn empty_usage() -> Value {
    json!({ "fiveHour": null, "weekly": null, "weeklyFable": null, "extraCredit": null })
}

/// ★확인 크리틱 R1 실패1 — **「못 물어봤다」와 「막는 창이 없다」를 구분하는 표식.**
///
/// 2.6.2는 이 둘을 구분하지 않았다(둘 다 `empty`). 그 모호함이 3.0에서 실제 사고가 됐다:
/// 한도 자동 이어서의 2단 재검증(`useLimitResume.ts` `fire`)이 창 넷이 전부 `null`인 값을
/// **「막는 창 없음 = 풀렸다」**로 읽어, 조회가 죽어 있는 동안 자동 전송을 했다
/// (크리틱 실측: `CCG_NO_NET=1` + 살아 있는 계정 → `blockedResetsAt`=null → `ready=true`).
///
/// **값의 모양은 그대로 두고 키 하나를 얹는다.** 창 넷은 여전히 `null`이라 이 키를 모르는
/// 화면(2.6.2 렌더러·워크바 게이지)은 한 글자도 다르게 동작하지 않는다 — 아는 쪽(훅)만
/// "판정 근거가 없다"를 읽는다. 계약면: `src/shared/protocol.ts` `UsageInfo.unavailable`.
fn unavailable_usage() -> Value {
    let mut v = empty_usage();
    v["unavailable"] = json!(true);
    v
}

/// 낡은 캐시로 갈음한 값에 붙는 표식 — **값은 있지만 방금 물어본 값은 아니다.**
///
/// 훅은 이걸 「유지」 판정에 쓰지 않는다(값이 있으면 그게 마지막 실측이고, 2.6.2도 그
/// 값으로 판정했다). 진단·하네스가 "실패 경로를 탔다"를 확인하는 자리다.
fn mark_stale(mut v: Value) -> Value {
    if v.is_object() {
        v["stale"] = json!(true);
    }
    v
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 메모리 캐시 1항목 — 2.6.2 `{ at, token, data }`.
///
/// **토큰을 함께 들고 있는 이유**(2.6.2 `index.ts:1030` `hit.token === tk.token`):
/// 계정 자격이 갈리면 TTL이 남아 있어도 그 값은 남의 한도다. 토큰 동치 검사가
/// 자격 교체를 즉시 무효화한다.
struct Entry {
    at: u64,
    token: String,
    data: Value,
}

fn cache() -> &'static Mutex<HashMap<String, Entry>> {
    static C: std::sync::OnceLock<Mutex<HashMap<String, Entry>>> = std::sync::OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 계정별 조회 차선 — 2.6.2 `usageInflight`의 자리.
///
/// 같은 계정에 동시 조회가 몰리면(본채팅 + 추가 채팅 + 멀티 패널이 같은 순간 마운트)
/// 첫 요청만 나가고 나머지는 차선 앞에서 기다렸다가 **캐시를 다시 본다**. 프로미스를
/// 공유하는 JS와 착지점이 같다: 요청 1회, 값 1벌.
fn lane(email: &str) -> Arc<Mutex<()>> {
    static L: std::sync::OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = std::sync::OnceLock::new();
    let m = L.get_or_init(|| Mutex::new(HashMap::new()));
    let mut g = m.lock().unwrap_or_else(|e| e.into_inner());
    g.entry(email.to_string()).or_default().clone()
}

fn cached(email: &str, token: &str, ttl: u64) -> Option<Value> {
    let g = cache().lock().unwrap_or_else(|e| e.into_inner());
    let e = g.get(email)?;
    (e.token == token && now_ms().saturating_sub(e.at) < ttl).then(|| e.data.clone())
}

/// 만료를 무시한 마지막 값 — 2.6.2 `fetchUsage`의 실패 폴백
/// (`index.ts:1050`·`:1110` `usageCache.get(cacheKey)?.data ?? empty`).
/// **다시 타임스탬프를 찍지 않는다** — 다음 호출이 또 시도해야 하기 때문이다.
fn stale(email: &str) -> Option<Value> {
    let g = cache().lock().unwrap_or_else(|e| e.into_inner());
    g.get(email).map(|e| e.data.clone())
}

/// `usage:get(fresh?, account?)` → `UsageInfo`.
///
/// 2.6.2 `getUsage`(`index.ts:1025-1037`)와 같은 순서:
/// 계정 확정 → 토큰 → 캐시(토큰 동치 + TTL) → 차선 → HTTP 1회 → 파싱 → 캐시 적재.
/// 실패(비200·전송 오류·본문 불량)는 **던지지 않는다** — 낡은 값이 있으면 그것을,
/// 없으면 `empty`를. 계약면이 "어떤 화면도 크래시하지 않는다"이기 때문이다.
///
/// 2.6.2와 일부러 같게 둔 것: **401/403 재시도가 없다.** 그쪽도 `usage:get` 경로에는
/// 없고(`auth:accounts-usage`에만 있다) 비200은 전부 캐시 폴백으로 떨어진다.
///
/// 2.6.2와 **다르게** 둔 것 하나: 실패는 [`unavailable_usage`]로 표시가 붙는다(위 참고).
pub fn usage_get(fresh: bool, account: Option<&str>) -> Value {
    let email = account
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(ccg_auth::claude::default_account_email);
    // 물어볼 계정이 없다 = 물어보지 못했다. "한도가 없다"가 아니다.
    let Some(email) = email else { return unavailable_usage() };

    let ttl = if fresh {
        ccg_auth::usage::USAGE_TTL_FRESH_MS
    } else {
        ccg_auth::usage::USAGE_TTL_MS
    };

    // 토큰이 먼저다 — 캐시 적중 판정에 토큰 동치가 들어가기 때문(2.6.2 `usageTokenFor`).
    // `net::access_token`은 **로컬 우선**이다: 디스크의 액세스 토큰이 아직 살아 있으면
    // 네트워크도 회전도 없이 그대로 돌려준다(`claude::account_access_token`).
    // 만료됐을 때만 리프레시 교환으로 가고, 그 경로는 계정별 단일 비행 + 회전 결과
    // 정착(M11 R2)이 지킨다.
    let Ok(token) = ccg_auth::net::access_token(&email) else {
        // 토큰을 못 얻었다(미등록·재로그인 필요·`CCG_NO_NET`). 2.6.2는 이 자리에서
        // 캐시조차 안 보고 `empty`를 준다(`index.ts:1028`) — 값은 같게 두고 표식만 얹는다.
        return unavailable_usage();
    };

    if let Some(v) = cached(&email, &token, ttl) {
        return v;
    }
    let lane = lane(&email);
    let _held = lane.lock().unwrap_or_else(|e| e.into_inner());
    // 차선을 잡는 사이 앞선 요청이 값을 채웠을 수 있다 — 그러면 그 값이 내 값이다.
    if let Some(v) = cached(&email, &token, ttl) {
        return v;
    }

    let req = ccg_auth::usage::usage_request(&token);
    let parsed = ccg_auth::net::send(&req).ok().and_then(|r| {
        (200..300).contains(&r.status).then(|| serde_json::from_str::<Value>(&r.body).ok())?
    });
    let Some(body) = parsed else {
        // 낡은 값이라도 있으면 그게 마지막 실측이다(게이지가 빈 칸이 되지 않게) — 다만
        // "방금 물어본 값"이 아니라고 표시한다. 아무것도 없으면 판정 근거가 0이다.
        return stale(&email).map(mark_stale).unwrap_or_else(unavailable_usage);
    };
    let info = ccg_auth::usage::parse_usage_info(&body);
    let data = serde_json::to_value(&info).unwrap_or_else(|_| empty_usage());
    cache().lock().unwrap_or_else(|e| e.into_inner()).insert(
        email,
        Entry { at: now_ms(), token, data: data.clone() },
    );
    data
}

/// `auth:accounts-usage()` → `AccountUsage[]`.
///
/// 2.6.2 `accountsUsage`(`auth.ts:598-612`)와 같다: 등록 **순서 그대로**, 계정마다
/// 디스크 캐시(2분) 적중이면 그대로, 아니면 조회 후 캐시 적재. 조회가 실패하면 낡은
/// 캐시를, 그것도 없으면 전부 `null`인 빈 행(계정은 목록에서 사라지지 않는다 —
/// 설정 화면의 행이 통째로 없어지는 쪽이 더 나쁘다).
///
/// **디스크 캐시를 쓰는 이유**: `engine/acct_switch.rs`의 자동 전환기가 같은
/// `usage-cache.json`을 읽고 쓴다. 여기서 메모리 캐시를 따로 두면 조회 루프가 두 벌이
/// 되고, 그 둘이 각자 만료를 세면서 **오래 논 계정의 리프레시 토큰을 서로 번갈아
/// 회전시킨다**(M11 R2 C1이 부팅 프리웜을 들어낸 바로 그 사고).
pub fn accounts_usage() -> Value {
    let accounts = ccg_auth::claude::list_accounts();
    if accounts.is_empty() {
        return json!([]);
    }
    let mut disk = ccg_auth::usage::read_usage_cache();
    let now = now_ms() as i64;
    let mut out: Vec<Value> = Vec::with_capacity(accounts.len());
    let mut dirty = false;

    for a in accounts {
        let email = a.email;
        let hit = disk
            .get(&email)
            .filter(|c| (now - c.at) >= 0 && ((now - c.at) as u64) < ccg_auth::usage::ACCT_USAGE_TTL_MS)
            .map(|c| c.data.clone());
        if let Some(d) = hit {
            out.push(serde_json::to_value(&d).unwrap_or_else(|_| json!({ "email": email })));
            continue;
        }
        // 조회 — 429는 `fetch_account_usage`가 Retry-After만큼 자고 **1회만** 재시도한다.
        match ccg_auth::net::fetch_account_usage(&email) {
            Ok(d) => {
                out.push(serde_json::to_value(&d).unwrap_or_else(|_| json!({ "email": email })));
                disk.insert(email, ccg_auth::usage::CachedUsage { at: now, data: d });
                dirty = true;
            }
            Err(_) => {
                // 실패는 낡은 캐시로 갈음한다(타임스탬프는 그대로 — 다음에 또 시도한다).
                // 표식은 `usage:get`과 같은 규약이다: 값이 있으면 `stale`, 없으면
                // `unavailable`. 여섯 필드가 전부 `null`인 행이 "한도 0"으로 읽히면
                // 「한도 적게 남은순」 정렬이 죽은 계정을 맨 위에 올린다.
                let hit = disk.get(&email).map(|c| c.data.clone());
                let stale_row = hit.is_some();
                let fallback = hit.unwrap_or_else(|| ccg_auth::usage::AccountUsage::empty(&email));
                let mut row = serde_json::to_value(&fallback).unwrap_or_else(|_| json!({ "email": email }));
                if row.is_object() {
                    row[if stale_row { "stale" } else { "unavailable" }] = json!(true);
                }
                out.push(row);
            }
        }
    }
    if dirty {
        ccg_auth::usage::write_usage_cache(&disk);
    }
    Value::Array(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 캐시 적중 규칙 — TTL 안 + 토큰 동치일 때만.
    #[test]
    fn a_cache_hit_needs_both_the_ttl_and_the_same_token() {
        let _h = ccg_store::testhome::take("parity-usage-cache");
        cache().lock().unwrap().clear();
        cache().lock().unwrap().insert(
            "a@x".into(),
            Entry { at: now_ms(), token: "tok-1".into(), data: json!({ "weekly": { "pct": 100 } }) },
        );
        assert!(cached("a@x", "tok-1", 60_000).is_some(), "신선 + 같은 토큰인데 빗나갔다");
        assert!(cached("a@x", "tok-2", 60_000).is_none(), "토큰이 갈렸는데 적중했다 = 남의 한도");
        assert!(cached("a@x", "tok-1", 0).is_none(), "TTL 0인데 적중했다");
        assert!(cached("b@x", "tok-1", 60_000).is_none(), "없는 계정이 적중했다");
    }

    /// 실패 폴백은 **만료를 무시하고** 마지막 값을 준다(게이지가 빈 칸이 되지 않게).
    #[test]
    fn the_stale_fallback_ignores_the_ttl() {
        let _h = ccg_store::testhome::take("parity-usage-stale");
        cache().lock().unwrap().clear();
        cache().lock().unwrap().insert(
            "a@x".into(),
            Entry { at: 0, token: "tok-1".into(), data: json!({ "weekly": { "pct": 42 } }) },
        );
        assert!(cached("a@x", "tok-1", 60_000).is_none(), "0ms에 찍힌 값이 신선할 리 없다");
        assert_eq!(stale("a@x").unwrap()["weekly"]["pct"], 42);
        assert!(stale("nobody@x").is_none());
    }

    /// 계정이 하나도 없으면 HTTP를 **한 번도** 쏘지 않고 빈 배열이다.
    #[test]
    fn accounts_usage_without_accounts_never_touches_the_network() {
        let _h = ccg_store::testhome::take("parity-usage-empty");
        assert_eq!(accounts_usage(), json!([]));
    }

    /// 계정이 없으면 `usage:get`도 조회 없이 안전값이다(심의 `NO_USAGE`와 같은 모양) —
    /// **다만 「못 물어봤다」 표식이 붙는다**(확인 크리틱 R1 실패1).
    #[test]
    fn usage_get_without_an_account_is_the_empty_shape() {
        let _h = ccg_store::testhome::take("parity-usage-noacct");
        let v = usage_get(true, None);
        for k in ["fiveHour", "weekly", "weeklyFable", "extraCredit"] {
            assert!(v.get(k).is_some_and(Value::is_null), "{k}가 빠졌다 — 심의 안전값과 모양이 달라진다");
        }
        assert_eq!(v["unavailable"], json!(true), "★ 조회 실패가 「한도 없음」과 구분되지 않으면 훅이 풀렸다고 오판한다");
    }

    /// ★확인 크리틱 R1 실패1의 **재현과 소멸** — 토큰은 있는데 전송이 죽는 판.
    ///
    /// 크리틱은 `CCG_NO_NET=1` + 살아 있는 계정에서 `usage:get`이 창 넷 전부 `null`을 내고
    /// 그 값이 훅을 「풀림」으로 착지시키는 것을 실측했다. 여기서는 같은 판을 **합성 계정**
    /// (만료가 먼 가짜 액세스 토큰)으로 만든다 — 실계정 자격은 한 줄도 안 읽고, 킬 스위치
    /// 때문에 HTTP도 한 번도 안 나간다. 착지가 `unavailable`이어야 한다.
    #[test]
    fn a_dead_send_with_a_live_token_lands_as_unavailable_not_as_empty() {
        let h = ccg_store::testhome::take("parity-usage-nonet");
        std::env::set_var("CCG_NO_NET", "1");
        cache().lock().unwrap().clear();
        let email = "seed@usage.test";
        // ① 스토어에 계정 하나(백업 credEnc 없이 — 폴더 크리덴셜만으로 충분하다).
        let store = json!({ "version": 3, "defaultEmail": email, "accounts": [{ "email": email, "subscriptionType": "max" }] });
        std::fs::write(h.dir.join("accounts.json"), store.to_string()).expect("스토어 시드");
        // ② 계정 폴더의 크리덴셜 — 만료가 한참 남았다 = `access_token`이 네트워크 없이 돈다.
        let dir = h.dir.join("accounts").join(ccg_auth::account_slug(email));
        std::fs::create_dir_all(&dir).expect("계정 폴더");
        let far = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as f64)
            .unwrap_or(0.0)
            + 3_600_000.0;
        let creds = json!({ "claudeAiOauth": { "accessToken": "A-seed", "expiresAt": far, "scopes": ["user:inference"] } });
        std::fs::write(dir.join(".credentials.json"), creds.to_string()).expect("크리덴셜 시드");
        assert_eq!(ccg_auth::net::access_token(email).as_deref(), Ok("A-seed"), "전제: 토큰은 나온다");

        // ③ 그 상태의 `usage:get` — 창 넷은 여전히 null(모양 불변)이고 표식이 붙는다.
        let v = usage_get(true, Some(email));
        println!("[실패1] CCG_NO_NET + 살아 있는 토큰 → usage:get = {v}");
        for k in ["fiveHour", "weekly", "weeklyFable", "extraCredit"] {
            assert!(v.get(k).is_some_and(Value::is_null), "{k}의 모양이 갈렸다");
        }
        assert_eq!(v["unavailable"], json!(true), "★ 이 표식이 없으면 훅이 「막는 창 없음」으로 읽는다");
        assert!(v.get("stale").is_none(), "캐시가 없는데 stale이면 거짓말이다");

        // ④ 계정별 목록도 같은 규약 — 행은 남되 「못 물어봤다」가 실린다.
        let rows = accounts_usage();
        println!("[실패1] auth:accounts-usage = {rows}");
        let row = &rows.as_array().expect("배열")[0];
        assert_eq!(row["email"], json!(email), "계정 행이 목록에서 사라지면 안 된다");
        assert_eq!(row["unavailable"], json!(true));
        assert!(row["weeklyPct"].is_null());

        std::env::remove_var("CCG_NO_NET");
        cache().lock().unwrap().clear();
        drop(h);
    }

    /// ★확인 크리틱 R1 [부분] — **2분 디스크 TTL에 테스트가 0건이었다.**
    ///
    /// 계정별 한도는 `usage-cache.json`을 2분 동안 그대로 쓴다(2.6.2 `ACCT_USAGE_TTL`).
    /// 그 문이 열려 있는지는 `CCG_NO_NET=1`로 가른다: 캐시가 신선하면 **조회 없이** 그
    /// 값이 나오고(HTTP가 불가능한 판인데 숫자가 나온다), 만료되면 조회가 실패해 낡은
    /// 값 + `stale` 표식으로 떨어진다.
    #[test]
    fn the_two_minute_disk_ttl_is_the_gate_between_a_hit_and_a_stale_fallback() {
        let h = ccg_store::testhome::take("parity-usage-ttl");
        std::env::set_var("CCG_NO_NET", "1");
        let email = "ttl@usage.test";
        let store = json!({ "version": 3, "defaultEmail": email, "accounts": [{ "email": email }] });
        std::fs::write(h.dir.join("accounts.json"), store.to_string()).expect("스토어 시드");
        let now = now_ms() as i64;
        let seed = |at: i64| {
            let mut m = std::collections::BTreeMap::new();
            m.insert(
                email.to_string(),
                ccg_auth::usage::CachedUsage {
                    at,
                    data: ccg_auth::usage::AccountUsage {
                        weekly_pct: Some(93),
                        five_hour_pct: Some(7),
                        ..ccg_auth::usage::AccountUsage::empty(email)
                    },
                },
            );
            ccg_auth::usage::write_usage_cache(&m);
        };

        // ① 신선(1분 전) — 조회 없이 캐시 적중. 표식이 붙으면 안 된다(방금 물어본 값과 같다).
        seed(now - 60_000);
        let hit = accounts_usage();
        let row = &hit.as_array().expect("배열")[0];
        println!("[TTL] 1분 전 캐시 = {row}");
        assert_eq!(row["weeklyPct"], json!(93), "★ 2분 안인데 캐시를 안 썼다(= 매번 조회한다)");
        assert!(row.get("stale").is_none() && row.get("unavailable").is_none(), "적중인데 표식이 붙었다: {row}");

        // ② 만료(3분 전) — 조회가 나가고, `CCG_NO_NET`이라 실패해 낡은 값으로 떨어진다.
        seed(now - 3 * 60_000);
        let miss = accounts_usage();
        let row = &miss.as_array().expect("배열")[0];
        println!("[TTL] 3분 전 캐시 = {row}");
        assert_eq!(row["weeklyPct"], json!(93), "낡아도 마지막 값은 지킨다(게이지가 빈 칸이 되지 않게)");
        assert_eq!(row["stale"], json!(true), "★ 만료됐는데 신선한 값 행세를 한다");
        assert!(row.get("unavailable").is_none(), "값이 있으면 unavailable이 아니다");

        // ③ 캐시가 아예 없으면 unavailable(퍼센트는 null) — 정렬이 죽은 계정을 맨 위에 못 올린다.
        ccg_auth::usage::write_usage_cache(&std::collections::BTreeMap::new());
        let bare = accounts_usage();
        let row = &bare.as_array().expect("배열")[0];
        println!("[TTL] 캐시 없음 = {row}");
        assert_eq!(row["unavailable"], json!(true));
        assert!(row["weeklyPct"].is_null());

        std::env::remove_var("CCG_NO_NET");
        drop(h);
    }

    /// 낡은 캐시로 갈음한 값은 `stale`이지 `unavailable`이 아니다 — **값이 있으면 판정한다**
    /// (그게 마지막 실측이고 2.6.2도 그 값으로 판정했다).
    #[test]
    fn a_cache_fallback_is_marked_stale_and_keeps_its_numbers() {
        let _h = ccg_store::testhome::take("parity-usage-stalemark");
        let v = mark_stale(json!({ "fiveHour": { "pct": 100, "resetsAt": 1_787_752_800i64 }, "weekly": null }));
        assert_eq!(v["stale"], json!(true));
        assert_eq!(v["fiveHour"]["pct"], json!(100), "표식을 붙이며 값을 건드리면 안 된다");
        assert!(v.get("unavailable").is_none(), "값이 있는데 '못 물어봤다'로 읽히면 재개가 영영 안 난다");
        // 배열·널 같은 비객체에는 아무것도 안 붙인다(패닉 금지).
        assert_eq!(mark_stale(Value::Null), Value::Null);
    }
}
