//! ★M11 R3(F1) — **다른 프로세스가 같은 홈을 쓸 때 `accounts.json`이 버티나.**
//!
//! R2 확인 크리틱 §5가 뚫은 자리를 제품 게이트로 옮겨 심는다. 그쪽 도구(T4)와 **같은
//! 모양**이라 숫자를 나란히 읽을 수 있다:
//!
//! | | 부모(이 테스트) | 자식(같은 바이너리) |
//! |---|---|---|
//! | 하는 일 | `mine@x`를 120회 회전 | `yours@x`를 120회 회전 + `ghost@x` 로그인/로그아웃 |
//! | 재는 것 | 내 회전이 **백업에서 지워졌나**(클로버) | 내 회전이 지워졌나 + **로그아웃이 취소됐나**(되살아남) |
//!
//! R2 실측: 클로버 1~6 / 120, 되살아남 **11 / 120(9.2%)**. 여기 단정은 **둘 다 0**이다.
//!
//! 네트워크는 0건이다 — 교환 응답을 손으로 만들어 저장 경로만 태운다(`net` 피처 불필요).
//! 홈은 `CCG_HOME` 격리이고 실홈은 열지 않는다.

use ccg_auth::claude;
use serde_json::{json, Value};

const CHILD_ENV: &str = "CCG_M11R3_CHILD";
const ROUNDS: usize = 120;

fn seed(email: &str, refresh: &str) {
    let creds = json!({ "claudeAiOauth": {
        "accessToken": format!("A-{email}"),
        "refreshToken": refresh,
        "expiresAt": 4_000_000_000_000f64,
        "scopes": ["user:inference"],
    }})
    .to_string();
    let snap = json!({ "creds": creds, "account": { "emailAddress": email, "uuid": format!("u-{email}") } });
    let enc = ccg_store::safe_storage::encrypt(&snap.to_string()).expect("safeStorage");
    let mut accounts: Vec<Value> = claude::read_store_file().accounts.clone();
    accounts.retain(|a| claude::email_of(a) != Some(email));
    accounts.push(json!({ "email": email, "credEnc": enc, "subscriptionType": "max" }));
    claude::write_store_file(&accounts, Some(email)).expect("시드 저장");
}

/// **백업(credEnc) 쪽** refresh 토큰만 본다(폴더는 안 본다) — 크리틱 T4의 판정 키와 같다.
fn store_refresh_of(email: &str) -> Option<String> {
    let f = claude::read_store_file();
    let a = f.accounts.iter().find(|a| claude::email_of(a) == Some(email))?;
    let raw = ccg_store::safe_storage::decrypt(claude::cred_enc_of(a)?)?;
    let creds = claude::Snapshot::parse(&raw).creds()?.to_string();
    let v: Value = serde_json::from_str(&creds).ok()?;
    v.get("claudeAiOauth")?.get("refreshToken")?.as_str().map(str::to_string)
}

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

/// 회전 한 바퀴 = 새 크리덴셜을 만들어 폴더·백업 양쪽에 되쓴다(`net::store_rotation`의 저장 반쪽).
fn rotate(email: &str, refresh: &str) -> bool {
    let Some(base) = claude::freshest_creds(email) else { return false };
    let Some(next) = claude::apply_refresh(&base, &format!("A-{refresh}"), Some(refresh), 3600.0, now_ms()) else {
        return false;
    };
    claude::persist_refreshed_report(email, &next).both()
}

/// 다른 앱에서의 "로그인" — 스토어에 계정 항목 하나를 되돌려 놓는다(잠금을 아는 경로).
fn add_ghost() {
    let f = claude::read_store_file();
    if f.accounts.iter().any(|a| claude::email_of(a) == Some("ghost@x")) {
        return;
    }
    let creds = json!({ "claudeAiOauth": { "accessToken": "A-ghost", "refreshToken": "g-0", "expiresAt": 4_000_000_000_000f64 } }).to_string();
    let snap = json!({ "creds": creds, "account": { "emailAddress": "ghost@x", "uuid": "u-ghost" } });
    let Some(enc) = ccg_store::safe_storage::encrypt(&snap.to_string()) else { return };
    let mut accounts = f.accounts.clone();
    accounts.push(json!({ "email": "ghost@x", "credEnc": enc, "subscriptionType": "max" }));
    let _ = claude::write_store_file(&accounts, f.default_email.as_deref());
}

#[test]
fn two_processes_rotating_the_same_store_lose_nothing() {
    if std::env::var(CHILD_ENV).is_ok() {
        return; // 자식 역할은 아래 전용 테스트가 맡는다
    }
    // ★M11 R4(리드) — 홈 자물쇠는 ccg-store 공용(testhome). 한 바이너리 안의 병렬
    // 실행이 서로의 CCG_HOME을 갈아끼우던 자리다(critic_m11r3_attack.rs 주석 참고).
    let home = ccg_store::testhome::take("r3race");
    std::env::set_var("CCG_NO_NET", "1");
    seed("mine@x", "m-init");
    seed("yours@x", "y-init");
    seed("ghost@x", "g-0");

    let exe = std::env::current_exe().expect("테스트 바이너리");
    let child = std::process::Command::new(exe)
        .args(["--exact", "child_rotates_the_other_account", "--nocapture"])
        .env(CHILD_ENV, "1")
        .env("CCG_HOME", &home)
        .env("CCG_NO_NET", "1")
        .stdout(std::process::Stdio::piped())
        .spawn()
        .expect("자식 프로세스");

    let mut clobbered = 0usize;
    for i in 0..ROUNDS {
        let want = format!("m-{i}");
        assert!(rotate("mine@x", &want), "저장은 성공한다(그게 이 판의 전제다) i={i}");
        if store_refresh_of("mine@x").as_deref() != Some(want.as_str()) {
            clobbered += 1;
        }
    }
    let out = child.wait_with_output().expect("자식 종료");
    let tail: String = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| l.starts_with("[race-child]"))
        .collect::<Vec<_>>()
        .join("\n");
    println!("{tail}");
    println!(
        "[race] 부모 {ROUNDS}회 회전 중 백업에서 지워진 건수={clobbered}  최종 mine={:?} yours={:?}",
        store_refresh_of("mine@x"),
        store_refresh_of("yours@x")
    );
    let child_ok = String::from_utf8_lossy(&out.stdout).contains("[race-child] lost=0 resurrected=0");
    assert_eq!(clobbered, 0, "★ 다른 프로세스의 통짜 쓰기가 우리 회전을 백업에서 지웠다");
    assert!(child_ok, "★ 자식 쪽에서 유실 또는 로그아웃 취소가 났다:\n{tail}");
    std::env::remove_var("CCG_NO_NET");
    let _ = std::fs::remove_dir_all(&home);
}

/// 자식 역할 — 부모가 `CCG_M11R3_CHILD`를 주고 부를 때만 일한다.
#[test]
fn child_rotates_the_other_account() {
    if std::env::var(CHILD_ENV).is_err() {
        return;
    }
    let mut lost = 0usize;
    let mut resurrected = 0usize;
    for i in 0..ROUNDS {
        let want = format!("y-{i}");
        if rotate("yours@x", &want) && store_refresh_of("yours@x").as_deref() != Some(want.as_str()) {
            lost += 1;
        }
        // 계정 목록 조작(= 사용자가 **다른 앱에서 로그아웃**). 이 값은 폴더에 사본이 없어
        // 잃어버린 갱신이 곧 "지운 계정이 되살아난다"다.
        add_ghost();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let g = claude::read_store_file();
        let kept: Vec<Value> = g.accounts.iter().filter(|a| claude::email_of(a) != Some("ghost@x")).cloned().collect();
        let _ = claude::write_store_file(&kept, g.default_email.as_deref());
        std::thread::sleep(std::time::Duration::from_millis(3));
        if claude::read_store_file().accounts.iter().any(|a| claude::email_of(a) == Some("ghost@x")) {
            resurrected += 1;
        }
    }
    println!("[race-child] lost={lost} resurrected={resurrected}");
}
