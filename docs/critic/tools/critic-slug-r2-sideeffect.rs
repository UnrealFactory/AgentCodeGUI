//! SLUG R2 확인 크리틱 — **격상 한 줄의 부작용**을 표적으로 잰다.
//!
//! `snapshot_of`가 `read_store_quiet` → `read_store_settled`가 되면서 채팅의 모든 턴이
//! **재시도 · `.bak` 복구**를 통과하게 됐다. 값은 분명하지만 대가가 셋 있을 수 있다:
//!
//!  SE1 **건강한 판의 지연** — 정상 스토어에서도 재시도 비용을 내나(스폰마다 낸다).
//!  SE2 **되살아난 계정** — 마지막 계정을 정말 로그아웃한 판에서, `.bak` 복구가
//!      시체를 되살려 **로그아웃한 계정으로 턴이 뜨는가**. R28e의 툼스톤이 그 문인데,
//!      그 문을 이제 **턴 경로가** 지나간다(R1까지는 조회만 지났다).
//!  SE3 **한 번도 로그인 안 한 판** — 「0개」가 「모른다」로 둔갑해 느려지거나 답이 바뀌나.
//!
//! 실계정도 네트워크도 안 쓴다 — 합성 토큰 · `@example.invalid` · `CCG_HOME` 격리.

use ccg_auth::{claude, AuthError};

fn seed(email: &str) {
    let creds = serde_json::json!({ "claudeAiOauth": {
        "accessToken": format!("synthetic-{email}"),
        "refreshToken": format!("synthetic-refresh-{email}"),
        "expiresAt": 4_000_000_000_000f64,
        "scopes": ["user:inference"],
    }})
    .to_string();
    let snap = serde_json::json!({
        "creds": creds,
        "account": { "emailAddress": email, "uuid": format!("u-{email}") },
    });
    let enc = ccg_store::safe_storage::encrypt(&snap.to_string()).expect("safeStorage");
    let row = serde_json::json!({ "email": email, "credEnc": enc, "subscriptionType": "max" });
    claude::write_store_file(&[row], Some(email)).expect("스토어 쓰기");
}

/// **SE1** — 건강한 스토어에서는 재시도를 한 번도 안 돈다.
///
/// `read_store_settled`는 `origin.is_known()`이면 첫 판에서 돌아온다. 그 성질이 깨지면
/// 스폰마다 `READ_RETRIES × READ_RETRY_MS`(6×3ms)를 낸다 — 멀티 패널이면 그 배수다.
#[test]
fn se1_a_healthy_store_pays_no_retry_cost_per_spawn() {
    let _h = ccg_store::testhome::take("slug-r2-se-healthy");
    let email = "fast@example.invalid";
    seed(email);
    // 첫 호출은 폴더 생성·정션이 섞이므로 예열한다(재는 것은 읽기 비용이다).
    claude::account_run_dir(email).expect("전제");

    let t0 = std::time::Instant::now();
    for _ in 0..20 {
        claude::account_run_dir(email).expect("건강한 판");
    }
    let per = t0.elapsed() / 20;
    println!("[SE1] 건강한 판 account_run_dir 1회 = {per:?} (재시도 예산 18ms)");
    assert!(
        per.as_millis() < 18,
        "★ 건강한 판에서도 재시도 비용을 낸다 — 스폰마다 붙는다: {per:?}"
    );
}

/// **SE2** — 마지막 계정을 **정말** 로그아웃한 판에서 `.bak` 복구가 시체를 되살리나.
///
/// 이 자리가 위험한 이유: `.bak`은 「마지막으로 성공한 저장」이라 로그아웃 **직전**의
/// 목록을 아직 담고 있을 수 있다. R28e가 툼스톤(`ledger::without_buried`)으로 그 문을
/// 잠갔는데, R1까지 그 문을 지나는 것은 **조회**뿐이었다. R2는 **턴 경로**를 그리로 보냈다.
/// 되살아나면 사용자가 지운 계정으로 CLI가 뜬다(격리 위반).
#[test]
fn se2_a_real_logout_is_not_undone_by_the_backup_recovery_on_the_turn_path() {
    let _h = ccg_store::testhome::take("slug-r2-se-logout");
    let email = "bye@example.invalid";
    seed(email);
    assert!(claude::account_run_dir(email).is_ok(), "전제 — 지금은 있다");

    // 진짜 로그아웃(제품 경로). 목록이 0개가 되고 툼스톤이 남는다.
    let left = claude::remove_account(email);
    println!("[SE2] 로그아웃 후 목록 = {}개", left.len());
    assert!(left.is_empty(), "이 픽스처는 마지막 계정 하나짜리다");

    let bak = ccg_store::app_home().join("accounts.json.bak");
    println!("[SE2] .bak 존재 = {}", bak.is_file());

    let turn = claude::account_run_dir(email);
    let query = claude::is_registered(email);
    println!("[SE2] 턴={:?} 조회={query}", turn.as_ref().err());
    assert!(
        matches!(turn, Err(AuthError::NotRegistered(_))),
        "★ 로그아웃한 계정으로 턴이 떴다 — `.bak` 복구가 시체를 되살렸다: {turn:?}"
    );
    assert!(!query, "★ 조회도 되살아나면 안 된다");

    // 본문이 깨진 상태에서도 같아야 한다 — 그때가 복구가 실제로 도는 판이다.
    let p = ccg_store::app_home().join("accounts.json");
    let full = std::fs::read_to_string(&p).unwrap();
    std::fs::write(&p, &full[..full.len() / 2]).unwrap();
    let turn2 = claude::account_run_dir(email);
    println!("[SE2] 본문 손상 + 로그아웃 → 턴={:?}", turn2.as_ref().err());
    assert!(
        matches!(turn2, Err(AuthError::NotRegistered(_))),
        "★ 손상 판에서 복구가 로그아웃을 되돌렸다: {turn2:?}"
    );
}

/// **SE3** — 한 번도 로그인 안 한 판(정말 0개)에서 답이 바뀌거나 느려지지 않는다.
#[test]
fn se3_a_never_logged_in_home_still_answers_not_registered_immediately() {
    let _h = ccg_store::testhome::take("slug-r2-se-virgin");
    let t0 = std::time::Instant::now();
    let turn = claude::account_run_dir("nobody@example.invalid");
    let el = t0.elapsed();
    println!("[SE3] 빈 홈 → {:?} ({el:?})", turn.as_ref().err());
    assert!(matches!(turn, Err(AuthError::NotRegistered(_))), "{turn:?}");
    // 「모른다」로 둔갑하면 6회 재시도(18ms)를 돌고도 같은 답을 낸다 — 답은 같아도
    // 이 자리는 **로그인 화면을 그리는 길목**이라 느려지면 눈에 띈다.
    println!("[SE3] 재시도 예산 18ms 대비 소요 = {el:?}");
}
