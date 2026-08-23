//! ★M11 R1 크리틱 — **토큰 회전 안전 감사**. 실 네트워크 0건(`CCG_NO_NET=1`을 켜고 돈다).
//!
//! 돌리는 법(핀 워크트리에 복사해서):
//! ```text
//! cp docs/critic/tools/critic-m11-token.rs <wt>/crates/ccg-auth/tests/critic_m11_token.rs
//! CARGO_TARGET_DIR=%TEMP%/… cargo test -p ccg-auth --features cli --test critic_m11_token -- --nocapture --test-threads=1
//! ```
//!
//! 묻는 것 하나: **제품 경로가 refresh 토큰 교환(=서버 회전)을 일으키는가.**
//!
//! 빌더 자신이 `ccg_auth_probe::usage_once`에 이렇게 적어 뒀다 —
//! *"**리프레시하지 않는다**가 이 함수의 계약이다. … 교환은 refresh 토큰을 **서버에서
//! 회전**시켜서, 복사본 홈에서 돌리면 원본 홈의 토큰이 그 순간 죽는다(되돌릴 수 없는
//! 부작용)."* 진단 도구에는 그 문(`account_access_token()`이 `None`이면 중단)이 있다.
//! **제품 경로(`acct_switch::fetch` → `net::fetch_account_usage`)에는 그 문이 없다.**
//!
//! 증명 방식(네트워크 없이): `CCG_NO_NET=1`이면 `net::send`가 **유일한 출구**에서
//! 즉시 `Disabled`를 낸다. 따라서
//!   · 결과가 `NoToken`  = 교환을 **시도조차 안 했다**(토큰 조회 단계에서 끝)
//!   · 결과가 `Disabled` = `send()`까지 **갔다** = 킬 스위치가 없었으면 POST가 나갔다
//! 만료 액세스 토큰 + 살아 있는 refresh 토큰인 계정에서 어느 쪽이 나오는지가 답이다.
#![cfg(feature = "net")]

use ccg_auth::net::{self, NetError};
use ccg_auth::{claude, usage};
use serde_json::{json, Value};

/// 격리 홈에 합성 계정 하나를 심는다(`ccg_auth_probe::seed`와 같은 모양, 만료만 손댄다).
fn seed(email: &str, expires_at_ms: f64, refresh: Option<&str>) {
    let mut oauth = json!({
        "accessToken": format!("synthetic-{email}"),
        "expiresAt": expires_at_ms,
        "scopes": ["user:inference"],
    });
    if let Some(r) = refresh {
        oauth["refreshToken"] = json!(r);
    }
    let creds = json!({ "claudeAiOauth": oauth }).to_string();
    let snap = json!({ "creds": creds, "account": { "emailAddress": email, "uuid": format!("u-{email}") } });
    let enc = ccg_store::safe_storage::encrypt(&snap.to_string()).expect("safeStorage");
    let mut accounts: Vec<Value> = claude::read_store_file().accounts.clone();
    accounts.retain(|a| claude::email_of(a) != Some(email));
    accounts.push(json!({ "email": email, "credEnc": enc, "subscriptionType": "max" }));
    claude::write_store_file(&accounts, Some(email));
}

fn scratch_home() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("ccg-m11c-auth-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::env::set_var("CCG_HOME", &dir);
    std::env::set_var("CCG_NO_NET", "1"); // ★ 이 파일 전체가 네트워크 0건이다
    dir
}

/// ★ 본 감사 — **노는 계정의 만료 토큰**에서 제품 경로가 무엇을 하는가.
#[test]
fn the_product_path_does_attempt_a_refresh_exchange_on_an_idle_account() {
    let home = scratch_home();
    println!("[T] CCG_HOME={} CCG_NO_NET={}", home.display(), net::disabled());
    assert!(net::disabled(), "이 감사는 킬 스위치를 켜고 돈다");

    // ① 노는 계정의 정상 상태: 액세스 토큰은 만료(1시간짜리다), refresh는 살아 있다.
    seed("idle@x", 1_000.0, Some("refresh-idle"));
    // ② 대조군: refresh조차 없는 계정 — 여기서는 교환 시도 자체가 불가능하다.
    seed("dead@x", 1_000.0, None);
    // ③ 대조군: 방금 쓴 계정(액세스 토큰 신선) — 교환이 필요 없다.
    seed("fresh@x", 4_000_000_000_000.0, Some("refresh-fresh"));

    assert!(claude::account_access_token("idle@x").is_none(), "만료 = 쓸 수 있는 액세스 토큰 없음");
    assert!(claude::refresh_token("idle@x").is_some(), "refresh 재료는 있다");

    let idle = net::access_token("idle@x").err();
    let dead = net::access_token("dead@x").err();
    let fresh = net::access_token("fresh@x").ok().is_some();
    let via_usage = net::fetch_account_usage("idle@x").err();
    println!("[T] access_token(idle)={idle:?}  access_token(dead)={dead:?}  fresh_ok={fresh}");
    println!("[T] fetch_account_usage(idle)={via_usage:?}   ← acct_switch::fetch가 부르는 그 함수");

    // 대조군이 `NoToken`이라는 것이 판별식의 근거다: 토큰 조회 단계에서 끝나면 `NoToken`이다.
    assert_eq!(dead, Some(NetError::NoToken), "refresh가 없으면 교환 시도 없음 = NoToken");
    assert!(fresh, "신선한 토큰은 그대로 쓴다(교환 없음)");

    // ★ 여기가 답이다. `Disabled`는 `send()`까지 갔다는 뜻이고, `access_token()` 안에서
    //   `send`가 불리는 자리는 `usage::refresh_requests`(POST /v1/oauth/token,
    //   grant_type=refresh_token) **하나뿐**이다.
    assert_eq!(
        idle,
        Some(NetError::Disabled),
        "★ 킬 스위치가 없었다면 refresh 교환 POST가 나갔다(= 서버 토큰 회전)"
    );
    assert_eq!(via_usage, Some(NetError::Disabled), "★ 제품 진입점도 같은 문을 지난다");

    // 그 POST가 정말 회전 요청인지 — 조립된 요청의 모양으로 못 박는다.
    let reqs = usage::refresh_requests("refresh-idle");
    let body: Value = serde_json::from_str(reqs[0].body.as_ref().unwrap()).unwrap();
    println!("[T] refresh req: {} {} body.grant_type={}", reqs[0].method, reqs[0].url, body["grant_type"]);
    assert_eq!(reqs[0].method, "POST");
    assert_eq!(body["grant_type"], json!("refresh_token"));
    assert!(reqs[0].url.contains("/v1/oauth/token"));

    let _ = std::fs::remove_dir_all(&home);
}
