//! SLUG R1 확인 크리틱 — **부작용 탐침**: 이 라운드가 채팅의 모든 턴을
//! `ccg_auth::claude::account_run_dir` 위에 올려놨다. 그 함수의 뿌리인 `snapshot_of`는
//! **단발 읽기**(`read_store_quiet`)를 쓴다.
//!
//! R28d(CASX R3)가 같은 병을 이미 진단했다(`claude.rs:142-161`의 주석) — "이웃의 통짜
//! 쓰기 한 번이 살아 있는 계정을 「로그아웃됐다」로 뒤집는다". 그때 격상된 조회는
//! `freshest_creds`와 `is_registered` 둘이고, `snapshot_of`는 **격상 목록에 없다**.
//!
//! SLUG R1 이전에는 그 약한 읽기가 채팅 턴에 안 걸렸다(옛 엔진은 `account_run_dir`을
//! 한 번도 안 불렀다 — 빌더 자신의 진술). 지금은 **턴마다** 걸리고, 실패하면 그 턴이
//! 죽고 사용자가 친 글이 사라진다.
//!
//! 여기서 재는 것은 하나: **같은 순간에 두 함수가 다른 답을 하는가.**
use ccg_auth::AuthError;

/// 합성 계정 한 벌을 격리 홈에 심는다(가짜 토큰 · 먼 미래 만료 · 실계정/네트워크 없음).
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
    ccg_auth::claude::write_store_file(&[row], Some(email)).expect("스토어 쓰기");
}

fn store_path() -> std::path::PathBuf {
    ccg_store::app_home().join("accounts.json")
}

/// **지나가는 반쪽** — 잠금을 모르는 이웃(2.6.2 `writeFileSync`)이 쓰는 도중의 모습.
/// R28d의 주석이 이 상황을 그대로 서술하고 있다.
#[test]
fn a_half_written_store_makes_the_turn_path_and_the_query_path_disagree() {
    let _h = ccg_store::testhome::take("slug-crit-store-half");
    let email = "race@example.invalid";
    seed(email);

    // 정상 상태 — 둘 다 「있다」
    assert!(ccg_auth::claude::is_registered(email), "심은 계정이 안 보인다");
    assert!(
        ccg_auth::claude::account_run_dir(email).is_ok(),
        "정상 상태에서 폴더를 못 낸다"
    );

    // 이웃이 쓰는 중 — 반쪽 JSON.
    let full = std::fs::read_to_string(store_path()).unwrap();
    std::fs::write(store_path(), &full[..full.len() / 2]).unwrap();

    let query = ccg_auth::claude::is_registered(email);
    let turn = ccg_auth::claude::account_run_dir(email);
    println!("[STORE-half] is_registered={query} account_run_dir={:?}", turn.as_ref().err());

    // 판정은 보고서가 한다 — 여기서는 **사실**을 못 박는다.
    assert!(
        matches!(turn, Err(AuthError::NotRegistered(_))),
        "반쪽을 보고도 폴더를 냈다면 이 탐침은 무효다: {turn:?}"
    );
    println!(
        "[STORE-half] ★ 같은 순간, 조회는 {}, 턴 경로는 「미등록」 — 화면 문장은 \
         「설정 ▸ Account에 등록된 계정이 아니에요(로그인이 필요해요)」",
        if query { "「등록돼 있다」" } else { "「없다」" }
    );

    // 되돌린다(홈은 어차피 버려지지만, 다음 단언의 전제를 분명히).
    std::fs::write(store_path(), &full).unwrap();
    assert!(ccg_auth::claude::account_run_dir(email).is_ok(), "복구 후엔 다시 열려야 한다");
}

/// **잠깐 사라진** 스토어 — rename 교체·백업 복원 등으로 파일이 순간 없는 판.
#[test]
fn a_vanished_store_makes_the_turn_path_and_the_query_path_disagree() {
    let _h = ccg_store::testhome::take("slug-crit-store-gone");
    let email = "gone@example.invalid";
    seed(email);
    assert!(ccg_auth::claude::is_registered(email));

    let full = std::fs::read_to_string(store_path()).unwrap();
    std::fs::remove_file(store_path()).unwrap();

    let query = ccg_auth::claude::is_registered(email);
    let turn = ccg_auth::claude::account_run_dir(email);
    println!("[STORE-gone] is_registered={query} account_run_dir={:?}", turn.as_ref().err());
    assert!(matches!(turn, Err(AuthError::NotRegistered(_))), "{turn:?}");

    std::fs::write(store_path(), &full).unwrap();
}

/// 격상된 조회(`read_store_settled`)가 실제로 **재시도로 살아난다**는 대조군 —
/// 이웃의 반쪽이 지나가면 `is_registered`는 다시 참이 된다. 즉 그 강도는 존재하고,
/// 턴 경로만 그것을 안 쓴다.
#[test]
fn the_query_path_survives_a_passing_half_but_the_turn_path_has_no_such_gear() {
    let _h = ccg_store::testhome::take("slug-crit-store-passing");
    let email = "pass@example.invalid";
    seed(email);
    let full = std::fs::read_to_string(store_path()).unwrap();

    // 「지나가는」 반쪽 — 다른 스레드가 잠시 뒤 되돌려 놓는다.
    std::fs::write(store_path(), &full[..full.len() / 2]).unwrap();
    let p = store_path();
    let back = full.clone();
    let h = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(60));
        std::fs::write(p, back).unwrap();
    });

    // 턴 경로는 **그 자리에서** 답한다(재시도 없음).
    let turn_now = ccg_auth::claude::account_run_dir(email);
    // 조회 경로는 재시도한다.
    let query = ccg_auth::claude::is_registered(email);
    h.join().unwrap();
    println!(
        "[STORE-passing] 턴경로={:?} 조회경로={query}",
        turn_now.as_ref().err()
    );
    assert!(
        turn_now.is_err() && query,
        "이 대조군이 성립해야 「격상 목록에서 빠졌다」가 말이 된다: turn={turn_now:?} query={query}"
    );
}
