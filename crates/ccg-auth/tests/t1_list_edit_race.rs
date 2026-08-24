//! ★최종 파리티 **T1** — 목록을 바꾸는 **사용자 조작**이 잠금 모르는 이웃과 겹칠 때.
//!
//! M11 R4의 게이트(`m11r4_store_cas.rs`)가 재는 것은 **배경 쓰기**(자동 전환 워커의 토큰
//! 회전 = `update_account_record`) 한 문뿐이다. 그때는 그걸로 충분했다 — 목록을 바꾸는
//! 조작(로그인 편입·로그아웃·기본 계정·순서)을 **부를 길이 3.0에 없었기 때문**이다
//! (`auth:*` 쓰기 채널 IPC 핸들러 0개 = 감사 T1).
//!
//! T1 배선이 그 다섯 채널을 붙이면서 그 조작이 사용자 손에 들어왔다. 그러면 R4가 회전
//! 경로에서 닫은 창이 로그인·로그아웃·정렬 경로에서 그대로 열린다 — f1ab32d가 `cas_edit`을
//! 뽑아 `update_store`도 같은 CAS를 타게 한 이유이고, **이 파일이 그것을 실측으로 붙잡는
//! 자리**다.
//!
//! 상대는 R4와 같다: `src/main/auth.ts:124`의 통짜 `fs.writeFileSync` 한 줄. 잠금도 병합도
//! mtime 검사도 없는 2.6.2 실앱의 모양이다.
//!
//! 단정 셋 —
//!  ① 이웃의 **로그아웃이 영구히 취소되지 않는다**. 우리 목록 편집이 남의 지우기를 묻으면 안 된다.
//!  ② 우리 계정이 **한 건도 사라지지 않는다**.
//!  ③ 마지막 파일이 **읽히는 JSON**이다(찢어진 쓰기가 남지 않는다).
//!
//! ## 단정하지 **않는** 것 — 이웃의 로그인 유실 (측정만 한다)
//!
//! `cas_edit`의 파묻힌 쓰기 되살리기는 이웃의 **지우기만** 받고 더하기는 안 받는다
//! (`claude.rs`의 `Commit::Buried` 팔 — ABA 때문이다: `로그인 → 로그아웃`처럼 파일이 같은
//! 바이트로 돌아오는 판에서 더하기를 되살리면 그게 곧 막으려던 사고다). 비대칭은 의도된
//! 것이고 그 대가가 여기 숫자로 나온다 — **2.6.2가 방금 한 로그인이 3.0의 목록 편집에
//! 영구히 묻힐 수 있다.** 이 라운드 실측(80판 × 목록 편집 ~1,400판, 2회 주행): **1건 · 4건**.
//! 같은 주행에서 로그아웃 취소는 **영구 0 · 0**이다. 0으로 단정하면 코드가 주지 않는
//! 보증을 게이트가 주장하는 것이라 **세지기만 한다**(그 대가의 방향이 옳다는 판단은
//! 그 팔의 주석에 있다: 잃은 로그인은 사용자가 다시 하면 보이지만, 되살아난 계정은
//! 살아 있는 토큰째 조용히 돌아온다).
//!
//! 네트워크 0건 · `CCG_HOME` 격리 · 실홈은 열지 않는다.

use ccg_auth::claude;
use serde_json::{json, Value};

const ROUNDS: usize = 80;

fn creds_of(email: &str) -> String {
    json!({ "claudeAiOauth": {
        "accessToken": format!("A-{email}"), "refreshToken": format!("R-{email}"), "expiresAt": 4_000_000_000_000f64,
    }})
    .to_string()
}

/// 로그인 완료 폴더 흉내 — `claude auth login`이 임시 폴더에 남기는 그 두 파일.
fn login_dir_for(root: &std::path::Path, email: &str) -> std::path::PathBuf {
    let d = root.join(format!("login-{}", email.replace(['@', '.'], "_")));
    std::fs::create_dir_all(&d).expect("로그인 폴더");
    std::fs::write(d.join(".credentials.json"), creds_of(email)).expect("creds");
    std::fs::write(d.join(".claude.json"), json!({ "oauthAccount": { "emailAddress": email } }).to_string()).expect("cj");
    d
}

/// **잠금을 모르는 이웃**(2.6.2 `writeStoreFile` 그대로 — 통짜·비원자·잠금 없음).
mod peer {
    use super::*;

    fn path() -> std::path::PathBuf {
        ccg_store::app_home().join("accounts.json")
    }

    fn read_raw() -> (Option<String>, Vec<Value>) {
        let Ok(s) = std::fs::read_to_string(path()) else { return (None, Vec::new()) };
        let Ok(v) = serde_json::from_str::<Value>(&s) else { return (None, Vec::new()) };
        (
            v.get("defaultEmail").and_then(Value::as_str).map(str::to_string),
            v.get("accounts").and_then(Value::as_array).cloned().unwrap_or_default(),
        )
    }

    fn write_raw(default_email: Option<&str>, accounts: &[Value]) {
        let mut root = serde_json::Map::new();
        root.insert("version".into(), json!(3));
        if let Some(d) = default_email {
            root.insert("defaultEmail".into(), json!(d));
        }
        root.insert("accounts".into(), Value::Array(accounts.to_vec()));
        let _ = std::fs::write(path(), serde_json::to_string_pretty(&Value::Object(root)).unwrap());
    }

    pub fn login(email: &str) {
        let (def, mut accounts) = read_raw();
        if accounts.iter().any(|a| claude::email_of(a) == Some(email)) {
            return;
        }
        let snap = json!({ "creds": creds_of(email), "account": { "emailAddress": email } });
        let Some(enc) = ccg_store::safe_storage::encrypt(&snap.to_string()) else { return };
        accounts.push(json!({ "email": email, "credEnc": enc, "subscriptionType": "max" }));
        write_raw(def.as_deref(), &accounts);
    }

    pub fn logout(email: &str) {
        let (def, accounts) = read_raw();
        let kept: Vec<Value> = accounts.iter().filter(|a| claude::email_of(a) != Some(email)).cloned().collect();
        write_raw(def.as_deref(), &kept);
    }

    pub fn has(email: &str) -> bool {
        read_raw().1.iter().any(|a| claude::email_of(a) == Some(email))
    }
}

/// ★T1 — 사용자 조작(로그인 편입·기본 계정·정렬)이 도는 동안 이웃의 로그아웃이 살아남나.
#[test]
fn user_list_edits_never_undo_a_lock_unaware_neighbours_logout() {
    let home = ccg_store::testhome::take("t1-listrace");
    std::env::set_var("CCG_NO_NET", "1");

    // 우리 계정 둘을 **T1의 진짜 문**(로그인 편입)으로 심는다.
    let ours = ["mine@x", "other@x"];
    for e in ours {
        let d = login_dir_for(&home.dir, e);
        claude::import_account_from_dir(&d, e, Some("max"), claude::ImportGuard::None).expect("로그인 편입");
    }

    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let s2 = stop.clone();
    let root = home.dir.clone();
    // 3.0의 **사용자 조작 루프** — set-default → reorder → 재로그인(같은 이메일 편입).
    // 셋 다 `update_store` = f1ab32d가 CAS로 넓힌 그 문이다.
    let editor = std::thread::spawn(move || {
        let mut i = 0usize;
        while !s2.load(std::sync::atomic::Ordering::Relaxed) {
            match i % 3 {
                0 => {
                    claude::set_default_account(ours[i % 2]);
                }
                1 => {
                    let mut order: Vec<String> = ours.iter().map(|s| s.to_string()).collect();
                    if i % 2 == 1 {
                        order.reverse();
                    }
                    claude::reorder_accounts(&order);
                }
                _ => {
                    let e = ours[i % 2];
                    let d = login_dir_for(&root, e);
                    let _ = claude::import_account_from_dir(&d, e, Some("max"), claude::ImportGuard::None);
                }
            }
            i += 1;
            std::thread::sleep(std::time::Duration::from_millis(3));
        }
        i
    });

    // 두 방향을 **따로**, 그리고 **잠깐 vs 영구**를 따로 센다.
    //
    // 잠깐(`blip`)은 사실이고 숨기지 않는다: 우리 `rename`이 이웃의 쓰기를 묻는 순간과
    // CAS가 그걸 알아채고 되살리는 순간 사이에 창이 있다(실측 로그 —
    // `[auth] ★ accounts.json: 이웃의 로그아웃을 묻었다(3개 → 2개) — 즉시 되살린다`).
    // 그 창 안에 파일을 읽으면 취소된 것처럼 보인다. **보증은 영구값**이다: 가라앉은 뒤의
    // 파일이 이웃의 뜻과 같아야 한다. R4 게이트가 잰 것(1ms 폴링 0/150)은 배경 회전
    // 한 문뿐이고 쓰기 빈도가 훨씬 낮았다 — 목록 편집은 그보다 훨씬 자주 쓴다.
    let mut logout_blip = 0usize;
    let mut login_blip = 0usize;
    let mut logout_undone = 0usize;
    let mut login_undone = 0usize;
    let mut ours_blinked = 0usize;
    let mut ours_lost = 0usize;
    let settle = || std::thread::sleep(std::time::Duration::from_millis(60));
    for _ in 0..ROUNDS {
        peer::login("ghost@x");
        // 더한 것이 **살아 있나** — 우리 목록 편집이 그 사이에 여러 번 돈다.
        for _ in 0..15 {
            std::thread::sleep(std::time::Duration::from_millis(1));
            if !peer::has("ghost@x") {
                login_blip += 1;
                break;
            }
        }
        settle();
        if !peer::has("ghost@x") {
            login_undone += 1;
        }

        peer::logout("ghost@x");
        for _ in 0..15 {
            std::thread::sleep(std::time::Duration::from_millis(1));
            if peer::has("ghost@x") {
                logout_blip += 1;
                break;
            }
        }
        settle();
        if peer::has("ghost@x") {
            logout_undone += 1;
        }

        // 우리 계정은 이 판이 끝날 때 반드시 다 있어야 한다.
        let missing = ours.iter().filter(|e| !peer::has(e)).count();
        if missing > 0 {
            ours_blinked += 1;
            settle();
        }
        ours_lost += ours.iter().filter(|e| !peer::has(e)).count();
    }
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    let edits = editor.join().expect("편집 스레드");
    let raw = std::fs::read_to_string(ccg_store::app_home().join("accounts.json")).unwrap_or_default();
    println!(
        "[t1-race] 이웃 {ROUNDS}판(로그인+로그아웃) · 사용자 목록 편집 {edits}판\n\
         [t1-race]   영구: 취소된 로그아웃={logout_undone}(게이트 0) · 묻힌 이웃 로그인={login_undone}(ABA 비대칭의 대가 — 측정만) · 유실된 우리 계정={ours_lost}(게이트 0)\n\
         [t1-race]   잠깐(되살리기 전 창에서 관측): 로그아웃={logout_blip} · 로그인={login_blip} · 우리 계정={ours_blinked}"
    );

    assert_eq!(logout_undone, 0, "★ 사용자 목록 편집이 잠금 모르는 이웃의 로그아웃을 **영구히** 되돌렸다");
    assert_eq!(ours_lost, 0, "★ 우리 계정이 경합 끝에 사라졌다");
    // `login_undone`은 **단정하지 않는다**(모듈 헤더의 ABA 비대칭). 숫자만 남긴다.
    assert!(serde_json::from_str::<Value>(&raw).is_ok(), "★ 마지막 파일이 찢어져 있다: {raw}");
    let f = claude::read_store_file();
    assert_eq!(f.accounts.len(), ours.len(), "마지막 목록이 우리 둘이어야 한다: {raw}");
    let _ = std::fs::remove_dir_all(&home.dir);
}
