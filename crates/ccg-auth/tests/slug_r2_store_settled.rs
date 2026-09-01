//! ★SLUG R2(확인 크리틱 R1 **중대①**) — **턴 경로와 조회 경로는 같은 강도로 읽는다.**
//!
//! SLUG R1이 Claude 채팅의 *모든 턴*을 `account_run_dir` → `snapshot_of` 위에 올렸다.
//! 그런데 `snapshot_of`는 R28d(CASX R3)가 격상한 조회 목록에서 빠진 **단발 읽기**였다.
//! 잠금을 모르는 이웃(2.6.2 `writeFileSync`)이 쓰는 도중에 걸리면 `accounts`가 빈
//! 목록이고, 이 크레이트에서 그 뜻은 「0개」이지 「모른다」가 아니다. 그래서 **같은
//! 순간에** 조회는 「등록돼 있다」인데 턴은 `Err(NotRegistered)`였다 —
//! 자격증명이 폴더에 멀쩡히 살아 있는데 화면에는 「등록된 계정이 아니에요」가 뜨고,
//! 그 턴에 사용자가 친 글은 사라진다(컴포저는 `run()` 직전에 비워진다).
//!
//! 크리틱의 실측(`docs/critic/tools/critic-slug-r1-store.rs`) 세 줄이 그 자리다:
//!
//! ```text
//! [STORE-half]    is_registered=true   account_run_dir=Err(NotRegistered(...))
//! [STORE-gone]    is_registered=true   account_run_dir=Err(NotRegistered(...))
//! [STORE-passing] 턴경로=Err(NotRegistered)   조회경로=true
//! ```
//!
//! 여기서는 그 세 판을 **고쳐진 쪽에서** 못으로 박는다. 크리틱 계기는 결함을 고정하는
//! 탐침이라 고치면 붉어진다(그것이 결함이 사라졌다는 서명이다) — 그래서 초록으로 남을
//! 못이 따로 필요하다.
//!
//! **호출 순서 주의**: 판마다 턴 경로를 **먼저** 부른다. 조회를 먼저 부르면 "조회가
//! 이미 손상을 치워 준 것 아닌가"라는 반문이 남는다. 먼저 물어서 답하면 그 여지가 없다.
//!
//! 실계정도 네트워크도 안 쓴다 — 합성 토큰 · `@example.invalid` · `CCG_HOME` 격리.

use ccg_auth::claude;

/// 합성 계정 한 벌(가짜 토큰 · 먼 미래 만료).
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

fn store_path() -> std::path::PathBuf {
    ccg_store::app_home().join("accounts.json")
}

/// **지나가는 반쪽** — 이웃이 통짜로 쓰는 도중의 모습.
#[test]
fn a_half_written_store_no_longer_kills_the_turn() {
    let _h = ccg_store::testhome::take("slug-r2-store-half");
    let email = "race@example.invalid";
    seed(email);
    assert!(claude::account_run_dir(email).is_ok(), "정상 상태의 전제");

    let full = std::fs::read_to_string(store_path()).unwrap();
    std::fs::write(store_path(), &full[..full.len() / 2]).unwrap();

    // ★ 턴 경로를 **먼저**. 조회가 앞서면 "조회가 치워 준 것"이라는 반문이 남는다.
    let turn = claude::account_run_dir(email);
    let query = claude::is_registered(email);
    assert!(
        turn.is_ok(),
        "반쪽 한 번에 채팅 턴이 죽는다(그 턴의 입력도 함께 사라진다): {turn:?}"
    );
    assert!(query, "대조군 — 조회는 원래 이 판을 견딘다");
    assert!(
        turn.as_ref().unwrap().join(".credentials.json").is_file(),
        "폴더만 내고 자격증명을 안 넣으면 CLI가 미로그인으로 뜬다"
    );
}

/// **잠깐 사라진** 스토어 — rename 교체·백업 복원 등으로 파일이 순간 없는 판.
#[test]
fn a_vanished_store_no_longer_kills_the_turn() {
    let _h = ccg_store::testhome::take("slug-r2-store-gone");
    let email = "gone@example.invalid";
    seed(email);
    assert!(claude::account_run_dir(email).is_ok(), "정상 상태의 전제");

    let full = std::fs::read_to_string(store_path()).unwrap();
    std::fs::remove_file(store_path()).unwrap();

    let turn = claude::account_run_dir(email);
    let query = claude::is_registered(email);
    assert!(turn.is_ok(), "파일이 잠깐 없다고 계정이 없어진 것은 아니다: {turn:?}");
    assert!(query, "대조군");
    let _ = std::fs::write(store_path(), &full);
}

/// **지나가는** 반쪽 — 다른 스레드가 잠시 뒤 되돌린다. 재시도 기어가 있으면 살아난다.
#[test]
fn a_passing_half_is_ridden_out_by_the_turn_path_too() {
    let _h = ccg_store::testhome::take("slug-r2-store-passing");
    let email = "pass@example.invalid";
    seed(email);
    let full = std::fs::read_to_string(store_path()).unwrap();

    std::fs::write(store_path(), &full[..full.len() / 2]).unwrap();
    let p = store_path();
    let back = full.clone();
    let h = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(60));
        std::fs::write(p, back).unwrap();
    });

    let turn = claude::account_run_dir(email);
    h.join().unwrap();
    assert!(
        turn.is_ok(),
        "R1까지 턴 경로에는 이 기어가 없었다(조회에만 있었다): {turn:?}"
    );
}

/// **두 답이 갈리지 않는다** — 이 라운드가 닫은 성질을 한 줄로.
///
/// 크리틱의 표현 그대로: *"같은 순간에 조회는 「등록돼 있다」, 턴은 「미등록」"*.
/// 손상 세 모양 어디서도 그 어긋남이 없어야 한다.
#[test]
fn the_query_path_and_the_turn_path_never_disagree_about_registration() {
    let _h = ccg_store::testhome::take("slug-r2-store-agree");
    let email = "agree@example.invalid";
    seed(email);
    let full = std::fs::read_to_string(store_path()).unwrap();

    for (what, damage) in [
        ("반쪽", Some(full[..full.len() / 2].to_string())),
        ("빈 파일", Some(String::new())),
        ("사라짐", None),
    ] {
        match damage {
            Some(s) => std::fs::write(store_path(), s).unwrap(),
            None => {
                let _ = std::fs::remove_file(store_path());
            }
        }
        let turn_ok = claude::account_run_dir(email).is_ok();
        let query = claude::is_registered(email);
        assert_eq!(
            turn_ok, query,
            "★ {what} — 같은 순간에 두 답이 갈렸다(턴={turn_ok} 조회={query})"
        );
        assert!(turn_ok, "★ {what} — 자격증명이 살아 있는데 턴이 죽는다");
        std::fs::write(store_path(), &full).unwrap();
    }
}
