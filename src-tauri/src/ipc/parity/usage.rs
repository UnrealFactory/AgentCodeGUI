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

fn now_sec() -> i64 {
    (now_ms() / 1000) as i64
}

/// ★2026-09-05 — `UsageInfo` 모양(`usage:get`의 메모리 캐시)에서 **지난 창**이 있나.
/// 창의 `resetsAt`(unix 초)이 `now` 이하면 그 퍼센트는 지난 창의 값이다 — TTL이 남았어도
/// 적중이 아니다(`AccountUsage::rolled`와 같은 판정, 모양만 다르다).
fn info_rolled(v: &Value, now_sec: i64) -> bool {
    ["fiveHour", "weekly", "weeklyFable"].iter().any(|k| {
        v.get(k)
            .and_then(|w| w.get("resetsAt"))
            .and_then(Value::as_i64)
            .is_some_and(|r| r <= now_sec)
    })
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
    // ★2026-09-05 — 지난 창이 든 값은 TTL이 남았어도 적중이 아니다(한도가 초기화됐는데
    // 5분 동안 옛 「100%」를 돌려주던 자리 — 워크바 게이지·한도 재검증이 이 캐시를 본다).
    (e.token == token && now_ms().saturating_sub(e.at) < ttl && !info_rolled(&e.data, now_sec()))
        .then(|| e.data.clone())
}

/// 만료를 무시한 마지막 값 — 2.6.2 `fetchUsage`의 실패 폴백
/// (`index.ts:1050`·`:1110` `usageCache.get(cacheKey)?.data ?? empty`).
/// **다시 타임스탬프를 찍지 않는다** — 다음 호출이 또 시도해야 하기 때문이다.
fn stale(email: &str) -> Option<Value> {
    let g = cache().lock().unwrap_or_else(|e| e.into_inner());
    g.get(email).map(|e| e.data.clone())
}

/// ★T3T4 R3 — **논블로킹 엿보기.** 허브 스레드(모든 채팅의 tick을 도는 그 스레드)의 문이다.
///
/// [`usage_get`]을 그 스레드에서 부르면 안 되는 이유는 셋이고 전부 *초 단위*다:
/// 토큰이 만료됐으면 리프레시 **교환 POST**, 전역 게이트에서 최대 1.2초, 429면 최대 30초.
/// 그동안 다른 대화의 스트리밍이 통째로 멈춘다. 그래서 여기서는 **메모리 캐시만** 본다 —
/// 값이 없으면 `None`이고, 채우는 일은 워커(`engine::limit_probe`)가 한다.
///
/// **토큰 동치를 안 보는 이유**: 토큰을 얻는 것 자체가 네트워크일 수 있다. 캐시 키가
/// 이메일이라 값의 주인은 어차피 같은 계정이고, 이 값의 쓰임은 "그 계정의 창이 아직
/// 100%인가" 하나다. 자격이 갈렸을 때의 정확성은 `ttl`이 대신 지킨다.
pub fn peek_usage(email: &str, ttl_ms: u64) -> Option<Value> {
    let g = cache().lock().unwrap_or_else(|e| e.into_inner());
    let e = g.get(email)?;
    (now_ms().saturating_sub(e.at) < ttl_ms).then(|| e.data.clone())
}

/// ★CRIT R1 — **테스트 전용** 스냅샷 심기. `null`이면 지운다.
///
/// 한도 재검증의 판정은 "이 계정의 창이 지금 어떤가"에 달려 있고, 그 판을 진짜로 만들려면
/// 실계정 HTTP가 필요하다(=토큰 회전 위험). 캐시에 직접 앉히면 **HTTP 0건**으로 같은 판을
/// 만든다 — `engine/limit_probe.rs`의 엔진 축 테스트가 이걸로 「클로드 주간 100%」를 세운다.
#[cfg(test)]
pub fn seed_peek_for_test(email: &str, data: Value) {
    let mut g = cache().lock().unwrap_or_else(|e| e.into_inner());
    if data.is_null() {
        g.remove(email);
        return;
    }
    g.insert(email.to_string(), Entry { at: now_ms(), token: "test-seed".into(), data });
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

// ── ★R28 ACCT §1 — 「Account를 눌렀는데 한도가 안 뜨거나 엄청 느리다」 ──────────
//
// 사용자 보고의 원인은 구조였다: 규약이 **1200ms 직렬 × 계정 수 + 실 HTTP**라 계정이
// N개면 첫 표시까지 수 초를 그냥 기다리고, 429·네트워크 실패면 「안 됨」으로 보인다.
// 규약(레이트 안전)은 2.6.2 대조라 못 바꾼다 — 바꿀 수 있는 것은 **UI가 그걸 기다리는
// 것**이다. 그래서 이 파일에 문 셋이 생겼다:
//
// | 옵션 | 무엇 | 누가 쓰나 |
// |---|---|---|
// | `cachedOnly` | HTTP를 **한 번도** 안 쏘고 디스크 캐시만 그린다(<수 ms) | 첫 페인트(stale-while-revalidate의 앞쪽) |
// | `priority` | 그 계정을 **맨 먼저** 조회한다 | 사용자가 지금 보는 계정(활성/이 채팅의 계정) |
// | `warm` | 로컬 액세스 토큰이 **살아 있는** 계정만 조회 | 시작·포커스 선행 워밍 |
// | `retry` | 실패 격리를 **넘는다**(사람이 눌렀다) | 「한도를 못 불러왔어요 · 다시 시도」 |
//
// `warm`이 따로 있는 이유는 M11 R2 C1이다: 부팅 프리웜을 들어낸 것은 **오래 논 계정의
// 리프레시 토큰 회전이 되돌릴 수 없는 부작용**이기 때문이었다. 워밍은 회전을 유발하지
// 않는 계정만 건드린다 — 그러면 "앱을 켠 것만으로 토큰이 회전한다"가 코드에서 불가능해진다.
// (사용자가 Account 탭을 직접 열면 `warm:false`라 그때는 옛 규약 그대로 교환까지 간다.)

/// 연속 실패 계정의 **격리**(§1 「죽은 계정 격리」).
///
/// 직렬 큐라 죽은 계정 하나가 5초(전송 타임아웃)를 먹으면 그 뒤 계정 전부가 그만큼
/// 늦는다. 실패가 쌓이면 그 계정은 조회를 **건너뛰고** 캐시로 갈음한다 —
/// 목록에서 사라지지도, 큐를 막지도 않는다. 성공하면 즉시 풀린다.
const DEAD_AFTER_FAILS: u32 = 2;
const DEAD_BACKOFF_MS: u64 = 3 * 60 * 1000;

struct Dead {
    fails: u32,
    until: u64,
}

fn dead_book() -> &'static Mutex<HashMap<String, Dead>> {
    static D: std::sync::OnceLock<Mutex<HashMap<String, Dead>>> = std::sync::OnceLock::new();
    D.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 지금 이 계정을 건너뛰나.
fn is_dead(email: &str) -> bool {
    let g = dead_book().lock().unwrap_or_else(|e| e.into_inner());
    g.get(email).is_some_and(|d| d.fails >= DEAD_AFTER_FAILS && now_ms() < d.until)
}

/// 실패 한 건을 적는다. `hold_ms`는 **서버가 부른 대기**([`ccg_auth::net::NetError::RateLimited`]) —
/// 있으면 사다리를 세지 않고 **즉시** 그 길이만큼 격리한다(실측 `Retry-After: 3600`: 두 번
/// 실패를 기다렸다 3분만 쉬고 되두드리면 차단이 안 풀린다).
fn note_fail(email: &str, hold_ms: Option<u64>) {
    let mut g = dead_book().lock().unwrap_or_else(|e| e.into_inner());
    let d = g.entry(email.to_string()).or_insert(Dead { fails: 0, until: 0 });
    d.fails = d.fails.saturating_add(1);
    match hold_ms {
        Some(hold) => {
            d.fails = d.fails.max(DEAD_AFTER_FAILS);
            d.until = now_ms() + hold.clamp(DEAD_BACKOFF_MS, ccg_auth::usage::RETRY_AFTER_HOLD_MAX_MS);
        }
        // 지수는 안 쓴다 — 이 격리는 벌이 아니라 **큐를 안 막기 위한 우회**다.
        None => d.until = now_ms() + DEAD_BACKOFF_MS,
    }
}

/// 실패에서 **서버가 부른 대기**를 꺼낸다 — 429의 Retry-After만 그렇다.
fn rate_hold(e: &ccg_auth::net::NetError) -> Option<u64> {
    match e {
        ccg_auth::net::NetError::RateLimited { retry_after_ms } => Some(*retry_after_ms),
        _ => None,
    }
}

fn note_ok(email: &str) {
    dead_book().lock().unwrap_or_else(|e| e.into_inner()).remove(email);
}

/// ★R28 ACCT R2(F5) — **사람이 「다시 시도」를 눌렀다**는 사실은 격리를 넘는다.
///
/// 격리는 *"직렬 큐를 죽은 계정 하나가 막지 않게"* 하는 우회지 벌이 아니다. 그런데 R1은
/// 그 사실을 셸에 실을 인자가 없어서(`refreshUsage`가 보낸 것은 `{priority, warm}`뿐),
/// 연속 2회 실패한 계정은 사용자가 버튼을 눌러도 `fallback_row`로 곧장 떨어졌다 —
/// **3분 동안 그 버튼은 아무 일도 안 했다**(확인 크리틱 R1 F5).
///
/// 자동 경로(워밍·주기 갱신)는 이 문을 안 지나므로 큐 보호는 그대로다.
fn clear_dead(email: &str) {
    dead_book().lock().unwrap_or_else(|e| e.into_inner()).remove(email);
}

/// 테스트·하네스용 — 격리 장부를 비운다.
#[cfg(test)]
fn forget_dead() {
    dead_book().lock().unwrap_or_else(|e| e.into_inner()).clear();
}

// ── ★R28 ACCT R2(N1) — **창이 둘이면 스토어도 둘이다** ───────────────────────
//
// §1의 「두 표면 인플라이트 중복 0」은 `app/src/lib/accounts.ts`의 합류로 세웠는데,
// 그 성질은 **한 창 안에서만** 참이다: `#session`(추가 채팅 창)·`#mapanel`(팝아웃)은
// 같은 번들의 다른 OS 창 = **다른 JS 힙**이라 스토어를 한 벌씩 들고, 그 창들도 계정
// picker를 그린다. 두 창이 겹치면
//
//  ⑴ 같은 계정에 조회가 **두 벌** 나가고(코드 주석 자신이 「분당 1~2건 실측」이라 적은
//     엔드포인트다 — 429의 지름길이다),
//  ⑵ 나중에 끝난 훑기가 자기 **낡은 스냅샷**을 통째로 되박아 상대의 신선한 값을 지웠다.
//
// (확인 크리틱 R1 N1 — 양쪽 다 못 봤던 자리.) 합류의 진실을 **셸로 내린다**: 렌더러가
// 몇 벌이든 조회는 이 관문 하나를 지난다.
//
// | 조각 | 무엇 |
// |---|---|
// | 계정별 레인 | 같은 계정을 도는 훑기가 있으면 **줄을 선다** |
// | 레인 안 재확인 | 깨어나서 **디스크를 다시 본다** — 앞 주자가 적어 뒀으면 HTTP 0회 |
// | 병합 쓰기 | 내 줄만 얹는다(`usage::merge_usage_cache`) — ⑵의 답 |

fn sweep_lanes() -> &'static Mutex<HashMap<String, Arc<Mutex<()>>>> {
    static L: std::sync::OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = std::sync::OnceLock::new();
    L.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 이 계정의 조회 레인. `net`의 `lane(email)`과 **다른 축**이다 — 저쪽은 토큰 교환의
/// 이중 회전을 막는 자리이고, 여기는 *조회 자체*의 중복을 막는다(교환이 필요 없는 계정도
/// 두 창이 겹치면 두 번 나갔다).
fn sweep_lane(email: &str) -> Arc<Mutex<()>> {
    let mut g = sweep_lanes().lock().unwrap_or_else(|e| e.into_inner());
    g.entry(email.to_string()).or_default().clone()
}

/// 레인에서 깨어난 뒤 **지금 파일**에 신선한 값이 있나(앞 주자가 방금 적었나).
fn fresh_on_disk(email: &str, now: i64) -> Option<ccg_auth::usage::CachedUsage> {
    ccg_auth::usage::read_usage_cache()
        .remove(email)
        .filter(|c| (now - c.at) >= 0 && ((now - c.at) as u64) < ccg_auth::usage::ACCT_USAGE_TTL_MS)
        .filter(|c| !c.data.rolled(now / 1000))
}

/// 조회 한 건의 **유일한 문**.
///
/// ★R28 ACCT R2(N2) — 워밍이면 [`ccg_auth::rotation`] 금지 구역 안에서 부른다. R1의
/// 워밍 문(`account_access_token().is_none()`이면 건너뛴다)은 **로컬 만료 시각만** 본다:
/// "시간상 살아 있는데 서버가 이미 죽인" 토큰은 그 문을 통과하고, 401/403 →
/// `force_refresh` → `rotate`로 교환 POST가 나갔다. 성공하면 그 순간 옛 refresh 토큰이
/// 서버에서 죽는다 — 앱을 켠 것 말고 사용자가 한 일이 없는데(확인 크리틱 R1 N2).
fn fetch_one(email: &str, warm: bool) -> Result<ccg_auth::usage::AccountUsage, ccg_auth::net::NetError> {
    // 하네스 조회기도 **구역 안에서** 돌아야 배선을 잴 수 있다(구역 밖에서 부르면
    // 하네스가 보는 것은 언제나 "금지 아님"이라 이 문을 걷어내도 초록이다).
    let go = || {
        #[cfg(test)]
        if let Some(f) = test_fetch() {
            return f(email, warm);
        }
        ccg_auth::net::fetch_account_usage(email)
    };
    if warm {
        ccg_auth::rotation::forbid(go)
    } else {
        go()
    }
}

/// 하네스가 갈아끼우는 조회기(**테스트 전용**). 실 HTTP 없이 "두 창이 겹치면 몇 번
/// 나가나"를 세려면 성공하는 조회가 있어야 한다 — `CCG_NO_NET`을 켜면 전부 실패해
/// 캐시가 안 생기고, 그러면 합류를 걷어내도 초록이라 측정 자체가 죽는다.
#[cfg(test)]
type TestFetch = fn(&str, bool) -> Result<ccg_auth::usage::AccountUsage, ccg_auth::net::NetError>;
#[cfg(test)]
fn test_fetch_slot() -> &'static Mutex<Option<TestFetch>> {
    static F: std::sync::OnceLock<Mutex<Option<TestFetch>>> = std::sync::OnceLock::new();
    F.get_or_init(|| Mutex::new(None))
}
#[cfg(test)]
fn test_fetch() -> Option<TestFetch> {
    *test_fetch_slot().lock().unwrap_or_else(|e| e.into_inner())
}
#[cfg(test)]
fn set_test_fetch(f: Option<TestFetch>) {
    *test_fetch_slot().lock().unwrap_or_else(|e| e.into_inner()) = f;
}

/// `auth:accounts-usage(opts?)` → `AccountUsage[]`.
///
/// 2.6.2 `accountsUsage`(`auth.ts:598-612`)와 같다: 등록 **순서 그대로**, 계정마다
/// 디스크 캐시(2분) 적중이면 그대로, 아니면 조회 후 캐시 적재. 조회가 실패하면 낡은
/// 캐시를, 그것도 없으면 전부 `null`인 빈 행(계정은 목록에서 사라지지 않는다 —
/// 설정 화면의 행이 통째로 없어지는 쪽이 더 나쁘다).
///
/// **응답 순서는 언제나 등록 순서다** — `priority`는 *조회* 순서만 바꾼다. 순서를
/// 흔들면 설정 화면의 목록이 조회할 때마다 재배열된다(= 정렬이 곧 기본인 §4에서는
/// 기본 계정이 널뛴다).
///
/// **디스크 캐시를 쓰는 이유**: `engine/acct_switch.rs`의 자동 전환기가 같은
/// `usage-cache.json`을 읽고 쓴다. 여기서 메모리 캐시를 따로 두면 조회 루프가 두 벌이
/// 되고, 그 둘이 각자 만료를 세면서 **오래 논 계정의 리프레시 토큰을 서로 번갈아
/// 회전시킨다**(M11 R2 C1이 부팅 프리웜을 들어낸 바로 그 사고).
pub fn accounts_usage(opts: &Value) -> Value {
    let cached_only = opts.get("cachedOnly").and_then(Value::as_bool).unwrap_or(false);
    let warm = opts.get("warm").and_then(Value::as_bool).unwrap_or(false);
    let priority = opts.get("priority").and_then(Value::as_str).unwrap_or("").trim().to_string();
    // ★R28 ACCT R2(F5) — 「다시 시도」 표식. 사람이 누른 조회만 격리를 넘는다.
    // `cachedOnly`와 함께 오면 캐시 팔이 이긴다(HTTP 0회의 계약이 더 강하다).
    let retry = !cached_only && opts.get("retry").and_then(Value::as_bool).unwrap_or(false);

    let accounts = ccg_auth::claude::list_accounts();
    if accounts.is_empty() {
        return json!([]);
    }
    let mut disk = ccg_auth::usage::read_usage_cache();
    let now = now_ms() as i64;
    let emails: Vec<String> = accounts.into_iter().map(|a| a.email).collect();
    // 조회 순서만 바꾼다(응답은 등록 순서로 되돌린다).
    let mut order: Vec<usize> = (0..emails.len()).collect();
    if let Some(p) = emails.iter().position(|e| *e == priority) {
        order.retain(|i| *i != p);
        order.insert(0, p);
    }
    let mut rows: Vec<Option<Value>> = vec![None; emails.len()];
    let row_of = |d: &ccg_auth::usage::AccountUsage, email: &str| {
        serde_json::to_value(d).unwrap_or_else(|_| json!({ "email": email }))
    };

    for i in order {
        let email = emails[i].clone();
        // ★R28 ACCT R2(F5) — 수동 재시도는 **격리를 먼저 푼다**(2분 디스크 TTL은 그대로:
        // 그 안이면 값이 달라질 일이 없고, 사용자가 보는 화면도 안 바뀐다).
        if retry {
            clear_dead(&email);
        }
        // ★2026-09-05 — 2분 안이어도 **지난 창**이 든 행은 적중이 아니다. 리셋 시각을 넘긴
        // 퍼센트는 지난 창의 값이라(Anthropic이 초기화해 줬는데 화면은 「0% 남음 · 곧」)
        // 지금 물어야 한다. 격리·워밍 문은 그대로 지나므로 예산은 그 문들이 지킨다.
        let hit = disk
            .get(&email)
            .filter(|c| (now - c.at) >= 0 && ((now - c.at) as u64) < ccg_auth::usage::ACCT_USAGE_TTL_MS)
            .filter(|c| !c.data.rolled(now / 1000))
            .map(|c| c.data.clone());
        if let Some(d) = hit {
            rows[i] = Some(row_of(&d, &email));
            continue;
        }
        // ① 첫 페인트 · ② 격리된 계정 · ③ 워밍인데 토큰이 만료됐다(= 회전이 필요하다).
        //    셋 다 **조회하지 않고** 캐시로 갈음한다. ③이 M11 R2 C1의 그 문이다
        //    (그 문이 못 거르는 판 = 서버가 죽인 토큰은 R2에서 [`fetch_one`]이 막는다 — N2).
        let skip = cached_only || is_dead(&email) || (warm && ccg_auth::claude::account_access_token(&email).is_none());
        if skip {
            rows[i] = Some(fallback_row(&disk, &email));
            continue;
        }
        // ★R2(N1) — 계정별 레인. 다른 창의 훑기가 이 계정을 도는 중이면 여기서 줄을 선다.
        let lane = sweep_lane(&email);
        let _held = lane.lock().unwrap_or_else(|e| e.into_inner());
        // 줄 서 있는 사이 앞 주자가 적어 뒀을 수 있다 — **디스크를 다시 본다**(HTTP 0회).
        // 이 한 문이 「두 창 = 조회 2벌」을 「두 창 = 조회 1벌」로 만든다.
        if let Some(c) = fresh_on_disk(&email, now_ms() as i64) {
            rows[i] = Some(row_of(&c.data, &email));
            disk.insert(email, c);
            continue;
        }
        // 조회 — 429는 `fetch_account_usage`가 Retry-After만큼 자고 **1회만** 재시도한다.
        match fetch_one(&email, warm) {
            Ok(d) => {
                note_ok(&email);
                rows[i] = Some(row_of(&d, &email));
                // 캐시의 나이는 **받은 시각**이다(훑기 하나가 계정 수 × 1.2초라, 시작 시각을
                // 쓰면 방금 받은 값이 태어날 때부터 늙어 있다).
                let entry = ccg_auth::usage::CachedUsage { at: now_ms() as i64, data: d };
                // ★R2(N1) — **한 줄만 병합해서 즉시 쓴다.** 즉시여야 레인 뒤의 훑기가
                // 그 값을 보고, 병합이라야 그 사이 남이 적은 값을 안 지운다.
                ccg_auth::usage::merge_usage_cache(&[(email.clone(), entry.clone())]);
                disk.insert(email, entry);
            }
            Err(e) => {
                // 429의 Retry-After가 길면(실측 3600) 그 길이만큼 **즉시** 격리 — 되두드리지 않는다.
                if let Some(hold) = rate_hold(&e) {
                    eprintln!("[usage] {email}: {e} — {}초 동안 조회를 건너뛴다", hold / 1000);
                }
                note_fail(&email, rate_hold(&e));
                rows[i] = Some(fallback_row(&disk, &email));
            }
        }
    }
    Value::Array(rows.into_iter().map(|r| r.unwrap_or(Value::Null)).collect())
}

/// 조회를 못 했거나 안 한 계정의 행 — 낡은 캐시로 갈음한다(타임스탬프는 그대로.
/// 다음에 또 시도한다). 표식은 `usage:get`과 같은 규약이다: 값이 있으면 `stale`,
/// 없으면 `unavailable`. 여섯 필드가 전부 `null`인 행이 "한도 0"으로 읽히면
/// 「한도 적게 남은순」 정렬이 죽은 계정을 맨 위에 올린다.
fn fallback_row(disk: &std::collections::BTreeMap<String, ccg_auth::usage::CachedUsage>, email: &str) -> Value {
    let hit = disk.get(email).map(|c| c.data.clone());
    let stale_row = hit.is_some();
    let fallback = hit.unwrap_or_else(|| ccg_auth::usage::AccountUsage::empty(email));
    let mut row = serde_json::to_value(&fallback).unwrap_or_else(|_| json!({ "email": email }));
    if row.is_object() {
        row[if stale_row { "stale" } else { "unavailable" }] = json!(true);
    }
    row
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
        assert_eq!(accounts_usage(&Value::Null), json!([]));
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
        let rows = accounts_usage(&Value::Null);
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
        let hit = accounts_usage(&Value::Null);
        let row = &hit.as_array().expect("배열")[0];
        println!("[TTL] 1분 전 캐시 = {row}");
        assert_eq!(row["weeklyPct"], json!(93), "★ 2분 안인데 캐시를 안 썼다(= 매번 조회한다)");
        assert!(row.get("stale").is_none() && row.get("unavailable").is_none(), "적중인데 표식이 붙었다: {row}");

        // ② 만료(3분 전) — 조회가 나가고, `CCG_NO_NET`이라 실패해 낡은 값으로 떨어진다.
        seed(now - 3 * 60_000);
        let miss = accounts_usage(&Value::Null);
        let row = &miss.as_array().expect("배열")[0];
        println!("[TTL] 3분 전 캐시 = {row}");
        assert_eq!(row["weeklyPct"], json!(93), "낡아도 마지막 값은 지킨다(게이지가 빈 칸이 되지 않게)");
        assert_eq!(row["stale"], json!(true), "★ 만료됐는데 신선한 값 행세를 한다");
        assert!(row.get("unavailable").is_none(), "값이 있으면 unavailable이 아니다");

        // ③ 캐시가 아예 없으면 unavailable(퍼센트는 null) — 정렬이 죽은 계정을 맨 위에 못 올린다.
        ccg_auth::usage::write_usage_cache(&std::collections::BTreeMap::new());
        let bare = accounts_usage(&Value::Null);
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

    // ── ★R28 ACCT §1 — 캐시 우선 · 우선순위 · 워밍 · 죽은 계정 격리 ────────────

    /// 계정 3개 + 만료된 디스크 캐시를 심는다(전부 3분 전 = TTL 밖).
    fn seed_three(h: &ccg_store::testhome::TestHome, live_token_for: &[&str]) -> Vec<String> {
        let emails: Vec<String> = ["one@acct.test", "two@acct.test", "three@acct.test"].iter().map(|s| s.to_string()).collect();
        let accounts: Vec<Value> = emails.iter().map(|e| json!({ "email": e })).collect();
        let store = json!({ "version": 3, "accounts": accounts });
        std::fs::write(h.dir.join("accounts.json"), store.to_string()).expect("스토어 시드");
        let old = now_ms() as i64 - 3 * 60_000;
        let mut m = std::collections::BTreeMap::new();
        for (i, e) in emails.iter().enumerate() {
            m.insert(
                e.clone(),
                ccg_auth::usage::CachedUsage {
                    at: old,
                    data: ccg_auth::usage::AccountUsage { weekly_pct: Some(10 * i as i64), ..ccg_auth::usage::AccountUsage::empty(e) },
                },
            );
        }
        ccg_auth::usage::write_usage_cache(&m);
        // 만료가 먼 가짜 액세스 토큰 = `account_access_token`이 네트워크 없이 산다.
        let far = now_ms() as f64 + 3_600_000.0;
        for e in live_token_for {
            let dir = h.dir.join("accounts").join(ccg_auth::account_slug(e));
            std::fs::create_dir_all(&dir).expect("계정 폴더");
            let creds = json!({ "claudeAiOauth": { "accessToken": format!("A-{e}"), "expiresAt": far, "scopes": ["user:inference"] } });
            std::fs::write(dir.join(".credentials.json"), creds.to_string()).expect("크리덴셜 시드");
        }
        emails
    }

    /// ★ **첫 페인트는 HTTP를 안 기다린다.** `cachedOnly`는 만료된 캐시라도 즉시 그린다.
    ///
    /// 규약이 1200ms 직렬 × 계정 수라, 이 문이 없으면 계정 3개에서 Account 탭의 첫 표시가
    /// 수 초다(사용자 보고의 그 증상). 판별식은 **시간**이다 — 조회가 나갔으면 게이트에서
    /// 최소 1.2초를 잔다.
    #[test]
    fn cached_only_paints_from_disk_without_ever_touching_the_network() {
        let h = ccg_store::testhome::take("parity-usage-cachedonly");
        forget_dead();
        let emails = seed_three(&h, &[]);
        let t0 = std::time::Instant::now();
        let rows = accounts_usage(&json!({ "cachedOnly": true }));
        let dt = t0.elapsed();
        let rows = rows.as_array().expect("배열").clone();
        println!("[§1] cachedOnly {dt:?} = {}", Value::Array(rows.clone()));
        assert_eq!(rows.len(), 3);
        assert!(dt < std::time::Duration::from_millis(500), "★ 첫 페인트가 조회를 기다렸다: {dt:?}");
        // 등록 순서 그대로 + 낡은 값이라는 표식.
        for (i, e) in emails.iter().enumerate() {
            assert_eq!(rows[i]["email"], json!(e), "응답 순서는 등록 순서다");
            assert_eq!(rows[i]["weeklyPct"], json!(10 * i as i64), "마지막으로 안 값을 즉시 그린다");
            assert_eq!(rows[i]["stale"], json!(true), "낡은 값에는 표식이 붙는다");
        }
        drop(h);
    }

    /// `priority`는 **조회 순서**만 바꾼다 — 응답 순서를 흔들면 설정 목록이 재배열되고,
    /// 「정렬 맨 위가 곧 기본」(§4)인 3.0에서는 그게 **기본 계정이 널뛰는** 사고다.
    #[test]
    fn priority_reorders_the_fetches_but_never_the_rows() {
        let h = ccg_store::testhome::take("parity-usage-priority");
        forget_dead();
        std::env::set_var("CCG_NO_NET", "1");
        let emails = seed_three(&h, &[]);
        let rows = accounts_usage(&json!({ "priority": emails[2] }));
        let rows = rows.as_array().expect("배열").clone();
        println!("[§1] priority = {}", Value::Array(rows.clone()));
        let got: Vec<&str> = rows.iter().map(|r| r["email"].as_str().unwrap_or("")).collect();
        assert_eq!(got, emails.iter().map(String::as_str).collect::<Vec<_>>(), "★ 행 순서가 흔들렸다");
        // 없는 이메일을 우선순위로 줘도 죽지 않는다.
        assert_eq!(accounts_usage(&json!({ "priority": "nobody@x" })).as_array().map(Vec::len), Some(3));
        std::env::remove_var("CCG_NO_NET");
        drop(h);
    }

    /// ★ **워밍은 토큰을 회전시키지 않는다**(M11 R2 C1이 부팅 프리웜을 들어낸 그 이유).
    ///
    /// 로컬 액세스 토큰이 살아 있는 계정만 조회 대상이고, 만료된 계정은 **건드리지 않는다**
    /// = 리프레시 교환 POST가 나갈 방법이 없다. 판별식은 `CCG_NO_NET`이다: 조회를 시도한
    /// 계정만 실패로 격리 장부에 오른다.
    #[test]
    fn warming_skips_accounts_whose_token_would_have_to_be_rotated() {
        let h = ccg_store::testhome::take("parity-usage-warm");
        forget_dead();
        std::env::set_var("CCG_NO_NET", "1");
        let emails = seed_three(&h, &["two@acct.test"]);
        assert!(ccg_auth::claude::account_access_token(&emails[1]).is_some(), "전제: 2번만 토큰이 산다");
        assert!(ccg_auth::claude::account_access_token(&emails[0]).is_none());
        let rows = accounts_usage(&json!({ "warm": true }));
        println!("[§1] warm = {rows}");
        assert_eq!(rows.as_array().map(Vec::len), Some(3), "행은 그대로 셋");
        let dead: Vec<String> = {
            let g = dead_book().lock().unwrap();
            g.keys().cloned().collect()
        };
        println!("[§1] 워밍이 실제로 물어본 계정 = {dead:?}");
        assert_eq!(dead, vec![emails[1].clone()], "★ 토큰이 만료된 계정에 조회를 걸면 회전이 난다");
        std::env::remove_var("CCG_NO_NET");
        forget_dead();
        drop(h);
    }

    /// ★R28 ACCT R2(F5) — **「다시 시도」는 격리를 넘는다.**
    ///
    /// R1은 격리된 계정이 3분 동안 버튼을 눌러도 조회를 안 냈다(크리틱 F5 — 코드 경로
    /// 확정). 판별식은 격리 장부다: 재시도 조회가 실제로 나갔으면 그 계정이 **다시**
    /// 실패로 장부에 오른다(`CCG_NO_NET`이라 나가면 반드시 실패한다).
    /// 건너뛰었다면 장부는 비어 있는 그대로다.
    #[test]
    fn a_manual_retry_gets_past_the_isolation_window() {
        let h = ccg_store::testhome::take("parity-usage-retry");
        forget_dead();
        std::env::set_var("CCG_NO_NET", "1");
        let emails = seed_three(&h, &[]);
        let target = emails[0].clone();
        // 연속 2회 실패 = 격리(3분).
        note_fail(&target, None);
        note_fail(&target, None);
        assert!(is_dead(&target), "전제: 격리 상태");

        // ① 표식 없는 조회 — 건너뛴다. 장부는 그대로(다시 실패로 오르지 않는다).
        let _ = accounts_usage(&json!({ "priority": target.clone() }));
        let fails_plain = { dead_book().lock().unwrap().get(&target).map(|d| d.fails) };
        println!("[F5] 표식 없는 조회 뒤 fails = {fails_plain:?}");
        assert_eq!(fails_plain, Some(DEAD_AFTER_FAILS), "★ 격리인데 조회가 나갔다(큐 보호가 깨진다)");

        // ② `retry:true` — 격리를 풀고 실제로 물어본다. `CCG_NO_NET`이라 실패하고
        //    **처음부터** 다시 센다(fails = 1 = 아직 격리 아님).
        let rows = accounts_usage(&json!({ "priority": target.clone(), "retry": true }));
        let fails_retry = { dead_book().lock().unwrap().get(&target).map(|d| d.fails) };
        println!("[F5] 재시도 뒤 fails = {fails_retry:?} · rows = {rows}");
        assert_eq!(fails_retry, Some(1), "★ 「다시 시도」가 셸에서 무동작이다 — 조회가 안 나갔다");
        assert!(!is_dead(&target), "사람이 누른 뒤에는 사다리를 처음부터 센다");
        // 행은 여전히 셋이고 계정도 안 사라진다(실패는 실패라고 말할 뿐).
        assert_eq!(rows.as_array().map(Vec::len), Some(3));

        // ③ `cachedOnly`가 함께 오면 캐시 팔이 이긴다(HTTP 0회의 계약이 더 강하다).
        note_fail(&target, None);
        note_fail(&target, None);
        let before = { dead_book().lock().unwrap().get(&target).map(|d| d.fails) };
        let _ = accounts_usage(&json!({ "cachedOnly": true, "retry": true }));
        let after = { dead_book().lock().unwrap().get(&target).map(|d| d.fails) };
        assert_eq!(after, before, "★ cachedOnly인데 조회가 나갔다 — 첫 페인트의 계약이 깨진다");

        std::env::remove_var("CCG_NO_NET");
        forget_dead();
        drop(h);
    }

    // ── ★2026-09-05 — 지난 창은 적중이 아니다 · 긴 Retry-After는 즉시 격리 ────────

    /// **리셋 시각을 지난 행은 2분 TTL 안이어도 다시 묻는다.**
    ///
    /// 제보: Anthropic이 한도를 초기화해 줬는데 설정·picker는 「Fable 0% 남음 · 곧」을 붙들고
    /// 있었다. 캐시는 나이만 봤고, 지난 창의 값인지는 아무도 안 봤다. 여기서는 `CCG_NO_NET`으로
    /// 조회를 죽여 두고 **조회가 나갔는지**를 `stale` 표식으로 잰다(적중이면 표식이 없다).
    #[test]
    fn a_rolled_window_inside_the_ttl_is_a_miss_not_a_hit() {
        let h = ccg_store::testhome::take("parity-usage-rolled");
        forget_dead();
        std::env::set_var("CCG_NO_NET", "1");
        let email = "rolled@usage.test";
        let store = json!({ "version": 3, "defaultEmail": email, "accounts": [{ "email": email }] });
        std::fs::write(h.dir.join("accounts.json"), store.to_string()).expect("스토어 시드");
        let now = now_ms() as i64;
        let seed = |fable_resets_at: i64| {
            let mut m = std::collections::BTreeMap::new();
            m.insert(
                email.to_string(),
                ccg_auth::usage::CachedUsage {
                    at: now - 30_000, // 30초 전 = TTL 안
                    data: ccg_auth::usage::AccountUsage {
                        fable_pct: Some(100),
                        fable_resets_at: Some(fable_resets_at),
                        weekly_pct: Some(52),
                        weekly_resets_at: Some(now / 1000 + 6 * 86_400),
                        ..ccg_auth::usage::AccountUsage::empty(email)
                    },
                },
            );
            ccg_auth::usage::write_usage_cache(&m);
        };

        // ① 창이 아직 안 지났다(1시간 뒤 리셋) — 적중. 표식 없음.
        seed(now / 1000 + 3600);
        let row = accounts_usage(&Value::Null).as_array().expect("배열")[0].clone();
        println!("[ROLLED] 미래 리셋 = {row}");
        assert!(row.get("stale").is_none(), "안 지난 창인데 조회가 나갔다(TTL 무시)");
        assert_eq!(row["fablePct"], json!(100));

        // ② 창이 지났다(10초 전 리셋) — TTL 안이어도 **조회가 나간다**. 실패하니 stale로 떨어진다.
        seed(now / 1000 - 10);
        let row = accounts_usage(&Value::Null).as_array().expect("배열")[0].clone();
        println!("[ROLLED] 지난 리셋 = {row}");
        assert_eq!(row["stale"], json!(true), "★ 리셋을 지난 값을 신선한 적중으로 돌려줬다 — 화면이 「0% 남음 · 곧」을 붙든다");
        assert_eq!(row["fablePct"], json!(100), "실패하면 마지막 값은 지킨다(렌더러가 「초기화됨」으로 읽는다)");

        // ③ 메모리 캐시(`usage:get`)도 같은 규칙 — 지난 창이 든 값은 적중이 아니다.
        cache().lock().unwrap().clear();
        cache().lock().unwrap().insert(
            email.into(),
            Entry {
                at: now_ms(),
                token: "tok".into(),
                data: json!({ "fiveHour": { "pct": 3, "resetsAt": now / 1000 + 600 }, "weeklyFable": { "pct": 100, "resetsAt": now / 1000 - 5 } }),
            },
        );
        assert!(cached(email, "tok", 60_000).is_none(), "★ 지난 Fable 창이 든 값을 신선하다고 돌려줬다");
        assert!(stale(email).is_some(), "실패 폴백으로는 여전히 쓴다(게이지가 빈 칸이 되지 않게)");
        cache().lock().unwrap().clear();

        std::env::remove_var("CCG_NO_NET");
        forget_dead();
        drop(h);
    }

    /// **`Retry-After: 3600`은 3분짜리 사다리가 아니다** — 그 길이만큼 즉시 건너뛴다.
    ///
    /// 실측: 한 계정의 usage API가 `429 · Retry-After: 3600`을 돌려줬고, 앱은 30초 자고
    /// 되묻고(429) → 실패 1 → 다음 훑기 또 2건 → 실패 2 → 3분 격리 → 또… 차단 중인 계정에
    /// 시간당 수십 건이 나가 19시간째 캐시가 그대로였다.
    #[test]
    fn a_long_retry_after_isolates_the_account_for_that_long_at_once() {
        let h = ccg_store::testhome::take("parity-usage-ratelimit");
        forget_dead();
        fn limited(_e: &str, _w: bool) -> Result<ccg_auth::usage::AccountUsage, ccg_auth::net::NetError> {
            Err(ccg_auth::net::NetError::RateLimited { retry_after_ms: 3_600_000 })
        }
        set_test_fetch(Some(limited));
        let emails = seed_three(&h, &[]);
        let target = emails[1].clone();

        let rows = accounts_usage(&json!({ "priority": target.clone() }));
        let (fails, until) = {
            let g = dead_book().lock().unwrap();
            let d = g.get(&target).expect("장부에 올라야 한다");
            (d.fails, d.until)
        };
        let left_s = (until as i64 - now_ms() as i64) / 1000;
        println!("[RL] 첫 실패 뒤 fails={fails} until-now={left_s}s");
        assert!(is_dead(&target), "★ 429 한 번에 바로 격리돼야 한다 — 두 번째 실패를 기다리면 그게 곧 되두드리기다");
        assert!(left_s >= 3_500, "★ 격리 길이가 서버가 부른 1시간이 아니라 3분 사다리다(until-now = {left_s}s)");
        // 행은 낡은 캐시로 갈음(stale) — 계정이 목록에서 사라지지 않는다.
        let row = rows.as_array().expect("배열")[1].clone();
        assert_eq!(row["stale"], json!(true));

        // 격리 중의 다음 훑기는 이 계정에 **조회를 안 낸다**(fails가 안 오른다).
        let _ = accounts_usage(&Value::Null);
        let fails2 = dead_book().lock().unwrap().get(&target).map(|d| d.fails);
        assert_eq!(fails2, Some(fails), "★ 격리 중인데 또 두드렸다 — 차단이 안 풀리는 그 경로");

        // 사람이 「다시 시도」를 누르면 그때는 나간다(F5의 규약 그대로) — 또 429면 다시 그 길이.
        let _ = accounts_usage(&json!({ "priority": target.clone(), "retry": true }));
        let fails3 = dead_book().lock().unwrap().get(&target).map(|d| d.fails);
        assert!(fails3.is_some_and(|f| f >= DEAD_AFTER_FAILS), "재시도가 429면 다시 그 길이로 격리된다");
        assert!(is_dead(&target));

        set_test_fetch(None);
        forget_dead();
        drop(h);
    }

    // ── ★R28 ACCT R2 — N1(창 밖 합류) · N2(워밍은 회전을 시작하지 않는다) ──────

    /// 하네스 조회기의 관측 장부. `(이메일, 그 순간 회전이 금지였나)`.
    static SPY: Mutex<Vec<(String, bool)>> = Mutex::new(Vec::new());

    fn spy_fetch(email: &str, _warm: bool) -> Result<ccg_auth::usage::AccountUsage, ccg_auth::net::NetError> {
        SPY.lock()
            .unwrap_or_else(|e| e.into_inner())
            .push((email.to_string(), ccg_auth::rotation::forbidden()));
        // 두 훑기가 실제로 겹치도록 왕복을 흉내 낸다(즉답이면 경합이 안 난다).
        std::thread::sleep(std::time::Duration::from_millis(120));
        Ok(ccg_auth::usage::AccountUsage { weekly_pct: Some(77), ..ccg_auth::usage::AccountUsage::empty(email) })
    }

    fn spy_take() -> Vec<(String, bool)> {
        SPY.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// ★R28 ACCT R2(N1) — **두 창이 겹쳐도 조회는 계정당 한 벌.**
    ///
    /// §1의 「인플라이트 중복 0」은 렌더러 스토어로 세웠는데, 그 성질은 **한 창 안에서만**
    /// 참이었다: `#session`·`#mapanel`은 다른 JS 힙이라 스토어를 한 벌씩 들고 각자 훑기를
    /// 낸다(확인 크리틱 R1 N1). 분당 1~2건이 예산인 엔드포인트에 계정 수 × 2벌이다.
    ///
    /// 하네스 조회기를 쓰는 이유: `CCG_NO_NET`을 켜면 조회가 전부 **실패**해 캐시가 안 생기고,
    /// 그러면 합류를 통째로 걷어내도 이 테스트가 초록이다(= 못이 아니게 된다).
    #[test]
    fn two_windows_sweeping_at_once_ask_each_account_only_once() {
        let h = ccg_store::testhome::take("parity-usage-twowin");
        forget_dead();
        let emails = seed_three(&h, &[]);
        SPY.lock().unwrap().clear();
        set_test_fetch(Some(spy_fetch));

        // 두 창이 같은 순간 Account 탭/picker를 연 판.
        let a = std::thread::spawn(|| accounts_usage(&json!({})));
        let b = std::thread::spawn(|| accounts_usage(&json!({})));
        let (ra, rb) = (a.join().expect("훑기 A"), b.join().expect("훑기 B"));
        set_test_fetch(None);

        let hits = spy_take();
        let asked: Vec<&str> = hits.iter().map(|(e, _)| e.as_str()).collect();
        println!("[N1] 두 훑기가 실제로 물어본 횟수 = {} · {asked:?}", hits.len());
        assert_eq!(hits.len(), emails.len(), "★ 창이 둘이면 조회가 두 벌 나갔다: {asked:?}");
        for e in &emails {
            assert_eq!(asked.iter().filter(|x| *x == e).count(), 1, "★ {e}를 두 번 물었다");
        }
        // 두 훑기 다 **신선한 값**을 받는다(합류한 쪽이 빈 칸이면 화면이 깜빡인다).
        for (who, rows) in [("A", &ra), ("B", &rb)] {
            let rows = rows.as_array().expect("배열");
            assert_eq!(rows.len(), emails.len(), "{who}의 행 수");
            for (i, e) in emails.iter().enumerate() {
                assert_eq!(rows[i]["email"], json!(e), "{who}: 응답 순서는 등록 순서다");
                assert_eq!(rows[i]["weeklyPct"], json!(77), "★ {who}가 합류하고 낡은 값을 받았다");
                assert!(rows[i].get("stale").is_none(), "★ {who}가 「낡음」 표식을 달고 왔다");
            }
        }
        // 디스크에도 세 줄이 다 신선하게 남는다(나중에 끝난 쪽이 안 덮었다).
        let disk = ccg_auth::usage::read_usage_cache();
        for e in &emails {
            assert_eq!(disk.get(e).and_then(|c| c.data.weekly_pct), Some(77), "★ {e}의 신선한 값이 덮였다");
        }
        forget_dead();
        drop(h);
    }

    /// ★R28 ACCT R2(N2) — **워밍의 조회는 회전 금지 구역 안에서 돈다.**
    ///
    /// R1 보고서의 「워밍이 토큰을 회전시키는 건 구조적으로 불가능」은 사실보다 셌다:
    /// 워밍의 문은 **로컬 만료 시각만** 보므로, 서버가 이미 죽인 토큰은 그 문을 통과해
    /// 401/403 → `force_refresh` → `rotate`로 갔다(확인 크리틱 R1 N2). 구역이 그 길을 막는다.
    ///
    /// 반대쪽 못도 함께 박는다: **사용자가 직접 연 조회는 구역 밖**이다. 거기까지 막으면
    /// 만료된 계정의 게이지가 영영 안 낫는다(옛 규약은 그때 교환까지 간다).
    #[test]
    fn only_the_warm_sweep_fetches_inside_the_no_rotate_scope() {
        let h = ccg_store::testhome::take("parity-usage-norotate");
        forget_dead();
        let emails = seed_three(&h, &["two@acct.test"]);
        SPY.lock().unwrap().clear();
        set_test_fetch(Some(spy_fetch));

        // ① 워밍 — 토큰이 살아 있는 계정만 조회 대상이고, 그 조회는 구역 안이다.
        let _ = accounts_usage(&json!({ "warm": true }));
        let warm_hits = spy_take();
        println!("[N2] 워밍 = {warm_hits:?}");
        assert_eq!(warm_hits.len(), 1, "전제: 토큰이 산 계정 하나만 묻는다");
        assert_eq!(warm_hits[0].0, emails[1]);
        assert!(warm_hits[0].1, "★ 워밍이 회전 금지 구역 **밖에서** 조회했다 — 401이면 그대로 교환 POST다");

        // ② 사용자가 연 조회 — 구역 밖. (①이 캐시를 신선하게 만들었으니 비우고 다시 잰다.)
        SPY.lock().unwrap().clear();
        ccg_auth::usage::write_usage_cache(&std::collections::BTreeMap::new());
        let _ = accounts_usage(&json!({}));
        let open_hits = spy_take();
        set_test_fetch(None);
        println!("[N2] 사용자 조회 = {open_hits:?}");
        assert_eq!(open_hits.len(), emails.len(), "사용자가 열면 전 계정을 묻는다");
        assert!(open_hits.iter().all(|(_, banned)| !*banned), "★ 사용자 조회까지 회전을 막으면 만료 계정이 영영 안 낫는다");
        assert!(!ccg_auth::rotation::forbidden(), "★ 금지가 훑기 밖으로 샜다 — 이후 모든 회전이 죽는다");
        forget_dead();
        drop(h);
    }

    /// 연속 실패 계정은 **큐를 막지 않는다** — 격리 창 안에서는 조회를 건너뛰고 캐시로
    /// 갈음한다. 성공(여기서는 장부 청소)하면 즉시 풀린다.
    #[test]
    fn a_repeatedly_failing_account_is_skipped_instead_of_stalling_the_queue() {
        let _h = ccg_store::testhome::take("parity-usage-dead");
        forget_dead();
        let e = "dead@acct.test";
        assert!(!is_dead(e), "처음부터 격리면 안 된다");
        note_fail(e, None);
        assert!(!is_dead(e), "한 번 실패로 격리하면 잠깐의 네트워크 끊김에 계정이 사라진다");
        note_fail(e, None);
        assert!(is_dead(e), "★ 연속 실패인데 매번 5초를 태운다");
        note_ok(e);
        assert!(!is_dead(e), "성공하면 즉시 풀린다");
        forget_dead();
    }
}
