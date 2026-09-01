//! SLUG R2 확인 크리틱 — **코덱스 쌍둥이의 사실 관계**를 내 손으로 잰다.
//!
//! 빌더는 「같은 병이지만 이 패스와 무관한 기존 성질이고, Claude처럼 한 줄로는 안 닫히며
//! (R28d가 지은 재시도·`StoreOrigin`·`.bak` 기계가 코덱스엔 없다), 증상은 **조용한
//! 미인증**이라 두 답이 갈리지도 않는다」며 별도 라운드로 이월했다.
//!
//! 이월 판단은 **사실 관계에 달려 있다**. 그래서 넷을 잰다:
//!
//!  CX1 같은 병인가 — 손상 세 모양에서 `codex::account_run_dir`이 죽는가
//!  CX2 기계가 정말 없는가 — 백업 파일 · 원점(모른다 vs 0개) · 재시도
//!  CX3 두 답이 갈리는가 — 조회(`default_account_email`)도 같이 눈이 머는가
//!  CX4 대조군 — **같은 손상에서 Claude 축은 살아남는가**(= 한 줄이 통한 이유)
//!
//! 그리고 이월 명세가 착수 가능한지에 필요한 재료 하나: **자료는 살아 있는가**
//! (폴더의 `auth.json`이 멀쩡하면 다음 라운드가 되살릴 재료가 있다는 뜻이다).
//!
//! 실계정도 네트워크도 안 쓴다 — 합성 토큰 · `@example.invalid` · `CCG_HOME` 격리.

use ccg_auth::{codex, AuthError};

fn cx_seed(email: &str) {
    let auth = serde_json::json!({
        "tokens": { "id_token": format!("synthetic-{email}"), "refresh_token": "synthetic-r" },
        "last_refresh": "2026-01-01T00:00:00Z",
    })
    .to_string();
    let enc = ccg_store::safe_storage::encrypt(&auth).expect("safeStorage");
    let row = serde_json::json!({ "email": email, "authEnc": enc, "plan": "plus" });
    codex::write_store_file(&[row], Some(email));
}

fn cx_store() -> std::path::PathBuf {
    ccg_store::app_home().join(codex::STORE_FILE)
}

fn cl_seed(email: &str) {
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

/// 손상 세 모양을 한 함수로 — 반쪽 · 빈 파일 · 사라짐.
fn damage(p: &std::path::Path, kind: &str, full: &str) {
    match kind {
        "half" => std::fs::write(p, &full[..full.len() / 2]).unwrap(),
        "empty" => std::fs::write(p, "").unwrap(),
        "gone" => {
            let _ = std::fs::remove_file(p);
        }
        _ => unreachable!(),
    }
}

/// **CX1+CX3** — 같은 병인가, 그리고 두 답이 갈리는가.
#[test]
fn cx_the_codex_store_goes_blind_on_damage_and_the_query_goes_blind_with_it() {
    let _h = ccg_store::testhome::take("slug-r2-cx-blind");
    let email = "cx@example.invalid";
    cx_seed(email);

    // 정상 — 둘 다 보인다. 그리고 폴더가 물질화된다.
    let dir = codex::account_run_dir(email).expect("정상 상태의 전제");
    assert!(dir.join("auth.json").is_file(), "물질화 전제");
    assert_eq!(codex::default_account_email().as_deref(), Some(email));
    println!("[CX-normal]   run_dir=Ok({}) default={:?}", dir.display(), codex::default_account_email());

    let p = cx_store();
    let full = std::fs::read_to_string(&p).unwrap();

    for kind in ["half", "empty", "gone"] {
        damage(&p, kind, &full);
        // ★ 턴 경로를 **먼저** 묻는다(조회가 치워 줬다는 반문 차단 — 빌더의 규약과 같게).
        let turn = codex::account_run_dir(email);
        let query = codex::default_account_email();
        println!(
            "[CX-{kind:<5}]   run_dir={:?} default={:?}",
            turn.as_ref().err(),
            query
        );
        assert!(
            matches!(turn, Err(AuthError::NotRegistered(_))),
            "★ {kind}: 코덱스 턴 경로가 손상을 견뎠다면 「같은 병」이 아니다: {turn:?}"
        );
        // **동시 실명** — 조회도 같이 눈이 먼다. Claude 축에서 문제였던 「두 답이 갈린다」가
        // 여기서는 안 생긴다는 빌더의 주장이 여기서 참/거짓이 된다.
        assert_eq!(
            query, None,
            "★ {kind}: 조회는 보이는데 턴만 죽으면 증상이 Claude와 **같은** 것이다(이월 근거가 약해진다)"
        );
        // 자료는 살아 있나 — 다음 라운드가 되살릴 재료.
        assert!(
            dir.join("auth.json").is_file(),
            "★ {kind}: 폴더의 auth.json까지 없으면 이월이 아니라 지금 고칠 일이다"
        );
        std::fs::write(&p, &full).unwrap();
    }

    // 복구되면 다시 보인다 — 손상이 영구 상태를 만들지는 않는다.
    assert!(codex::account_run_dir(email).is_ok());
    println!("[CX-restored] run_dir=Ok");
}

/// **CX2** — 기계가 정말 없는가. 백업 파일 · 원점 · 재시도 셋을 각각 잰다.
#[test]
fn cx_the_recovery_machinery_claude_has_does_not_exist_on_the_codex_axis() {
    let _h = ccg_store::testhome::take("slug-r2-cx-machinery");
    let email = "cx2@example.invalid";
    cx_seed(email);
    ccg_auth::claude::write_store_file(&[], None).ok(); // Claude 쪽도 한 번 써서 .bak을 만든다
    cl_seed("cl2@example.invalid");

    // ① 백업 파일 — Claude에는 있고 코덱스에는 없다.
    let cl_bak = ccg_store::app_home().join("accounts.json.bak");
    let cx_bak = ccg_store::app_home().join(format!("{}.bak", codex::STORE_FILE));
    println!("[CX-bak] claude .bak 존재={} codex .bak 존재={}", cl_bak.is_file(), cx_bak.is_file());
    assert!(cl_bak.is_file(), "Claude 축에는 마지막 성공본이 있다(복구 재료)");
    assert!(
        !cx_bak.is_file(),
        "★ 코덱스에 백업이 이미 있다면 「새로 지어야 한다」는 이월 근거가 무너진다"
    );

    // ② 원점 — 「모른다」와 「0개」를 코덱스가 구분하나. 손상과 진짜 빈 목록이 같은 값이면
    //    구분이 없는 것이다.
    let p = cx_store();
    let full = std::fs::read_to_string(&p).unwrap();
    std::fs::write(&p, &full[..full.len() / 2]).unwrap();
    let torn = codex::read_store_file();
    codex::write_store_file(&[], None); // 진짜로 0개
    let truly_empty = codex::read_store_file();
    println!(
        "[CX-origin] 손상={}개 진짜0개={}개 — 구분 불가={}",
        torn.accounts.len(),
        truly_empty.accounts.len(),
        torn.accounts.len() == truly_empty.accounts.len()
    );
    assert_eq!(
        torn.accounts.len(),
        truly_empty.accounts.len(),
        "★ 코덱스가 「모른다」와 「0개」를 구분한다면 이월 명세가 달라진다"
    );

    // ③ 재시도 — 「지나가는 반쪽」을 견디나. 견디면 기어가 있는 것이다.
    std::fs::write(&p, &full).unwrap();
    std::fs::write(&p, &full[..full.len() / 2]).unwrap();
    let p2 = p.clone();
    let back = full.clone();
    let h = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(60));
        std::fs::write(p2, back).unwrap();
    });
    let t0 = std::time::Instant::now();
    let turn = codex::account_run_dir(email);
    let elapsed = t0.elapsed();
    h.join().unwrap();
    println!("[CX-retry] 지나가는 반쪽 → {:?} (소요 {:?})", turn.as_ref().err(), elapsed);
    assert!(turn.is_err(), "★ 코덱스에 재시도 기어가 있다면 이월 근거가 약해진다");
    assert!(elapsed.as_millis() < 30, "재시도가 없다는 것은 **즉시** 답한다는 뜻이다: {elapsed:?}");
}

/// **CX4 대조군** — 같은 손상 세 모양에서 **Claude 축은 살아남는다**(R2가 고친 그 자리).
/// 이 대조가 없으면 「한 줄로 닫혔다 / 코덱스는 새로 지어야 한다」는 비교가 성립하지 않는다.
#[test]
fn cl_the_claude_axis_survives_the_same_three_damages() {
    let _h = ccg_store::testhome::take("slug-r2-cx-contrast");
    let email = "contrast@example.invalid";
    cl_seed(email);
    assert!(ccg_auth::claude::account_run_dir(email).is_ok(), "전제");

    let p = ccg_store::app_home().join("accounts.json");
    let full = std::fs::read_to_string(&p).unwrap();
    for kind in ["half", "empty", "gone"] {
        damage(&p, kind, &full);
        let turn = ccg_auth::claude::account_run_dir(email);
        let query = ccg_auth::claude::is_registered(email);
        println!("[CL-{kind:<5}] turn_ok={} query={query}", turn.is_ok());
        assert!(turn.is_ok(), "★ {kind}: Claude 축이 안 살아남으면 R2가 안 닫힌 것이다: {turn:?}");
        assert_eq!(turn.is_ok(), query, "★ {kind}: 두 답이 갈렸다");
        std::fs::write(&p, &full).unwrap();
    }
}
