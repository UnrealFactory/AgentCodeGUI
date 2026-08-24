//! ★M11 **R2 확인 크리틱** — 토큰 안전 재감사. 실 네트워크 0건(`CCG_NO_NET=1`).
//!
//! 돌리는 법(핀 워크트리에 복사해서):
//! ```text
//! cp docs/critic/tools/critic-m11r2-token.rs <wt>/crates/ccg-auth/tests/critic_m11r2_token.rs
//! CARGO_TARGET_DIR=%TEMP%/… cargo test -p ccg-auth --features cli \
//!   --test critic_m11r2_token -- --nocapture --test-threads=1
//! ```
//!
//! R1은 "회전 결과를 `let _`로 버린다"를 쳤다. R2는 그 자리를 `store_rotation` +
//! `TokenLost` + 레인으로 닫았다고 주장한다. 이 파일이 묻는 것은 **그 닫힘의 가장자리**다.
//!
//! | # | 과녁 |
//! |---|---|
//! | T1 | 회전은 났는데 응답에 `access_token`이 없다 — 새 refresh 토큰은 어디로 가나 |
//! | T2 | `TokenLost` 판정이 **오경보**일 수 있나(폴더에는 이미 저장됐는데) |
//! | T3 | 레인은 실패를 합치나 — 앞 주자가 실패하면 뒤 주자는 몇 번 더 나가나 |
//! | T4 | **다른 프로세스**가 같은 홈을 쓸 때 회전 결과가 서로를 지우나(실앱 + 3.0 동시 실행) |
//! | T5 | `TokenLost` 뒤 그 계정은 후보에서 빠지나(= 복구 경로가 있나) |
#![cfg(feature = "net")]

use ccg_auth::net::{self, NetError};
use ccg_auth::{claude, switch, usage, verify};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

// ── 공용 픽스처 ─────────────────────────────────────────────────────────────

fn seed(email: &str, expires_at_ms: f64, refresh: Option<&str>) {
    let mut oauth = json!({
        "accessToken": format!("A-{email}"),
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

/// ★M11 R4(리드) — 홈 자물쇠는 **ccg-store 공용**(`testhome`)이다. 사유는
/// `critic_m11r3_attack.rs`의 같은 함수 주석에.
fn scratch_home(tag: &str) -> ccg_store::testhome::TestHome {
    let h = ccg_store::testhome::take(tag);
    std::env::set_var("CCG_NO_NET", "1");
    h
}

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

// ── T1 — 회전 응답에 access_token이 없으면 새 refresh 토큰은 **말없이 버려진다** ──
//
// `store_rotation`은 `access_token`을 **맨 먼저** 본다. 없으면 `BadBody`로 즉시 나가고,
// 그 아래의 `rotated` 판정·저장·`TokenLost`는 한 줄도 안 돈다. 서버가 200과 함께
// 새 refresh 토큰을 줬다면 옛 토큰은 그 순간 죽었는데, 우리는 새 것을 안 적고
// **에러조차 TokenLost가 아니다**(= 진단 로그도 없다). R1이 친 바로 그 모양이다.
#[test]
fn t1_a_rotation_without_an_access_token_vanishes_without_a_word() {
    let home = scratch_home("t1");
    seed("idle@x", 1_000.0, Some("r-old"));
    let base = claude::freshest_creds("idle@x").expect("시드");

    // 서버가 200 + 새 refresh 토큰을 줬는데 access_token 필드가 없다(또는 이름이 바뀌었다).
    let body = json!({ "refresh_token": "r-NEW", "expires_in": 3600 });
    let verdict = net::store_rotation("idle@x", &base, &body, "r-old", now_ms());
    let after = claude::refresh_token("idle@x");
    println!("[T1] verdict={verdict:?}  저장된 refresh={after:?}");

    // 바라는 성질: 새 토큰을 적었거나, 못 적었으면 **소리를 내야** 한다(TokenLost).
    let closed = after.as_deref() == Some("r-NEW") || matches!(verdict, Err(NetError::TokenLost(_)));
    assert!(closed, "★ 200 + 새 refresh인데 저장도 TokenLost도 없다 — R1이 친 그 침묵이다: {verdict:?}");
    let _ = std::fs::remove_dir_all(&home);
}

// ── T2 — `TokenLost`는 오경보일 수 있다: 폴더에는 이미 새 토큰이 앉았다 ─────
//
// `persist_refreshed`는 **폴더를 먼저** 원자 저장하고 그다음 백업(accounts.json)을 만진다.
// 백업 단계에서만 실패하면(NotRegistered·Undecryptable·CorruptSnapshot) 폴더에는 회전
// 결과가 남아 있는데 판정은 `TokenLost`("이 계정은 재로그인")다. 방향은 안전하지만,
// 사용자에게 나가는 유일한 문장이 틀린다.
#[test]
fn t2_token_lost_can_be_a_false_alarm_because_the_folder_write_already_landed() {
    let home = scratch_home("t2");
    seed("solo@x", 1_000.0, Some("r-old"));
    let base = claude::freshest_creds("solo@x").expect("시드");

    // 백업만 깨뜨린다 — 스토어에서 계정을 지운다(사용자가 조회 중에 로그아웃한 판).
    claude::write_store_file(&[], None);
    let rot = json!({ "access_token": "A-2", "refresh_token": "r-2", "expires_in": 3600 });
    let verdict = net::store_rotation("solo@x", &base, &rot, "r-old", now_ms());
    let folder = home.join("accounts").join(dir_slug("solo@x")).join(".credentials.json");
    let on_disk = std::fs::read_to_string(&folder).unwrap_or_default();
    println!("[T2] verdict={verdict:?}\n     폴더 파일={} 있음={}", folder.display(), !on_disk.is_empty());
    println!("[T2] 폴더 내용에 r-2 있나 = {}", on_disk.contains("r-2"));

    // 바라는 성질: 폴더에 정착했으면 "재로그인이 필요할 수 있습니다"라고 말하지 않는다.
    let false_alarm = matches!(verdict, Err(NetError::TokenLost(_))) && on_disk.contains("r-2");
    assert!(!false_alarm, "★ 회전 결과가 폴더에 멀쩡히 앉았는데 판정은 TokenLost다(오경보): {verdict:?}");
    let _ = std::fs::remove_dir_all(&home);
}

/// `claude::account_dir`의 슬러그 규약을 밖에서 재현할 수 없어(해시) 폴더를 훑어 찾는다.
fn dir_slug(email: &str) -> String {
    let root = ccg_store::app_home().join("accounts");
    let head = email.replace(['@', '.'], "_");
    std::fs::read_dir(&root)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .find(|n| n.starts_with(&head))
        .unwrap_or(head)
}

// ── T3 — 레인은 **직렬화**지 단일 비행이 아니다: 실패는 합쳐지지 않는다 ──────
//
// 2.6.2의 `refreshInflight`는 **약속(promise)을 공유**한다 — 성공이든 실패든 뒤 주자는
// 앞 주자의 결과를 그대로 받고 자기 교환을 안 나간다. 여기 레인은 뮤텍스라서, 앞 주자가
// 실패하면(4xx·전송 실패) 뒤 주자의 이중 검사가 여전히 `None`이고 **자기 교환을 새로
// 나간다**. 죽은 refresh 토큰이면 대기자 수만큼 POST가 나간다(직렬로).
//
// 판별식은 킬 스위치다: `Disabled`에 도달했다 = `send()`까지 갔다 = 교환을 시도했다.
#[test]
fn t3_the_lane_serializes_but_does_not_merge_failures() {
    let home = scratch_home("t3");
    seed("dead@x", 1_000.0, Some("r-dead")); // 만료 액세스 + (서버에서 죽은) refresh
    let n = 4;
    let hands: Vec<_> = (0..n).map(|_| std::thread::spawn(|| net::access_token("dead@x"))).collect();
    let outs: Vec<_> = hands.into_iter().map(|h| h.join().unwrap()).collect();
    let tried = outs.iter().filter(|r| matches!(r, Err(NetError::Disabled))).count();
    println!("[T3] 동시 호출 {n}건 → 교환을 시도한 건수={tried} 결과={outs:?}");
    assert_eq!(tried, 1, "★ 레인당 1건이어야 하는데 {tried}건이 나갔다 — 실패는 합쳐지지 않는다");
    let _ = std::fs::remove_dir_all(&home);
}

// ── T4 — **다른 프로세스**(실앱 2.x + 3.0 동시 실행)와의 잃어버린 갱신 ──────
//
// `persist_refreshed`는 accounts.json을 **통째로 읽고-고쳐-쓴다**(`write_store_file`).
// 잠금도 없고 mtime 검사도 없다. 같은 홈을 쓰는 다른 프로세스가 그 사이에 자기 쓰기를
// 끝내면 **한쪽 갱신이 사라진다**. M11 R2 전에는 3.0이 배경에서 이 파일을 쓸 일이
// 없었다 — 자동 전환 워커가 그 성질을 새로 만들었다.
//
// 두 프로세스(부모=이 테스트, 자식=같은 테스트 바이너리)가 **서로 다른 계정**을 회전한다.
// 끝나고 스토어에 남은 것이 양쪽의 마지막 값이 아니면 그게 잃어버린 갱신이다.
const CHILD_ENV: &str = "CCG_M11R2C_CHILD_HOME";
const ROUNDS: usize = 120;

#[test]
fn t4_a_second_process_silently_erases_our_rotation_from_the_store() {
    if std::env::var(CHILD_ENV).is_ok() {
        return; // 자식 역할은 아래 전용 테스트가 맡는다
    }
    let home = scratch_home("t4");
    seed("mine@x", 4_000_000_000_000.0, Some("m-0"));
    seed("yours@x", 4_000_000_000_000.0, Some("y-0"));
    seed("ghost@x", 4_000_000_000_000.0, Some("g-0"));

    let exe = std::env::current_exe().expect("테스트 바이너리");
    let mut child = std::process::Command::new(exe)
        .args(["--exact", "t4_child_rotates_the_other_account", "--nocapture", "--include-ignored"])
        .env(CHILD_ENV, &home)
        .env("CCG_HOME", &home)
        .env("CCG_NO_NET", "1")
        .stdout(std::process::Stdio::piped())
        .spawn()
        .expect("자식 프로세스");

    let mut clobbered = 0usize;
    for i in 0..ROUNDS {
        let base = claude::freshest_creds("mine@x").expect("내 크리덴셜");
        let body = json!({ "access_token": format!("A-m-{i}"), "refresh_token": format!("m-{i}"), "expires_in": 3600 });
        let r = net::store_rotation("mine@x", &base, &body, &format!("m-{}", i.wrapping_sub(1)), now_ms());
        assert!(r.is_ok(), "저장은 성공한다(그게 이 판의 전제다): {r:?}");
        // 스토어 백업이 방금 쓴 값을 들고 있나 — 아니면 자식이 그 사이에 통째로 덮었다.
        if store_refresh_of("mine@x").as_deref() != Some(format!("m-{i}").as_str()) {
            clobbered += 1;
        }
    }
    let out = child.wait_with_output().expect("자식 종료");
    let tail: String = String::from_utf8_lossy(&out.stdout).lines().filter(|l| l.starts_with("[T4-child]")).collect::<Vec<_>>().join("\n");
    println!("{tail}");
    println!(
        "[T4] 부모 {ROUNDS}회 회전 중 백업에서 지워진 건수={clobbered}  \
         스토어 최종: mine={:?} yours={:?}",
        store_refresh_of("mine@x"),
        store_refresh_of("yours@x")
    );
    // 폴더(=살아 있는 쪽)는 계정마다 따로라 살아남는다 — 그게 지금의 유일한 완충이다.
    println!("[T4] freshest(mine)={:?}", claude::refresh_token("mine@x"));
    assert_eq!(clobbered, 0, "★ 다른 프로세스의 통짜 쓰기가 우리 회전을 백업에서 지웠다");
    let _ = std::fs::remove_dir_all(&home);
}

/// 스토어 **백업(credEnc)** 쪽 refresh 토큰만 본다(폴더는 안 본다).
fn store_refresh_of(email: &str) -> Option<String> {
    let f = claude::read_store_file();
    let a = f.accounts.iter().find(|a| claude::email_of(a) == Some(email))?;
    let raw = ccg_store::safe_storage::decrypt(claude::cred_enc_of(a)?)?;
    let creds = claude::Snapshot::parse(&raw).creds()?.to_string();
    let v: Value = serde_json::from_str(&creds).ok()?;
    v.get("claudeAiOauth")?.get("refreshToken")?.as_str().map(str::to_string)
}

/// 다른 앱에서의 "로그인" — 스토어에 계정 항목 하나를 되돌려 놓는다.
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
    claude::write_store_file(&accounts, f.default_email.as_deref());
}

/// 자식 역할 — 부모가 `CCG_M11R2C_CHILD_HOME`을 주고 부를 때만 일한다.
#[test]
fn t4_child_rotates_the_other_account() {
    let Ok(_home) = std::env::var(CHILD_ENV) else { return };
    let mut lost = 0usize;
    let mut resurrected = 0usize;
    for i in 0..ROUNDS {
        let Some(base) = claude::freshest_creds("yours@x") else { continue };
        let body = json!({ "access_token": format!("A-y-{i}"), "refresh_token": format!("y-{i}"), "expires_in": 3600 });
        let _ = net::store_rotation("yours@x", &base, &body, &format!("y-{}", i.wrapping_sub(1)), now_ms());
        if store_refresh_of("yours@x").as_deref() != Some(format!("y-{i}").as_str()) {
            lost += 1;
        }
        // 계정 목록 조작(= 사용자가 **다른 앱에서 로그아웃**). 이 값은 폴더에 사본이 없어
        // 잃어버린 갱신이 곧 "지운 계정이 되살아난다"다.
        let f = claude::read_store_file();
        let kept: Vec<Value> = f.accounts.iter().filter(|a| claude::email_of(a) != Some("ghost@x")).cloned().collect();
        let _ = kept;
        let _ = f;
        // 로그인 → (부모가 스냅샷을 뜰 틈) → 로그아웃 → 확인.
        add_ghost();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let g = claude::read_store_file();
        let kept: Vec<Value> = g.accounts.iter().filter(|a| claude::email_of(a) != Some("ghost@x")).cloned().collect();
        claude::write_store_file(&kept, g.default_email.as_deref());
        std::thread::sleep(std::time::Duration::from_millis(3));
        // 지운 직후에 다시 보이면 = 부모의 통짜 쓰기가 로그아웃 이전 스냅샷을 되돌린 것이다.
        if claude::read_store_file().accounts.iter().any(|a| claude::email_of(a) == Some("ghost@x")) {
            resurrected += 1;
        }
    }
    println!("[T4-child] 내 회전 {ROUNDS}회 중 백업에서 지워진 건수={lost}");
    println!("[T4-child] ★ 로그아웃한 ghost@x가 되살아난 횟수={resurrected} (부모의 통짜 쓰기가 옛 스냅샷을 되돌렸다)");
}

// ── T5 — `TokenLost` 뒤에도 그 계정은 **여전히 후보**다(복구 경로 없음) ─────
//
// `fetch()`는 `TokenLost`를 로그 한 줄로 흘리고 `None`을 돌려준다. 그런데
// ① 오염가드는 파일만 보므로 죽은 refresh 토큰도 `NeedsRefresh`(=통과)이고,
// ② `collect()`는 캐시에 값이 있으면 그대로 `usage_map`에 넣는다.
// 그래서 다음 tick의 `plan()`은 그 계정을 **1등으로도** 내줄 수 있다 — 갈아탄 뒤 CLI가
// 죽은 토큰으로 리프레시를 시도하고, 사용자는 그때 로그인 창을 본다.
#[test]
fn t5_an_account_whose_rotation_was_lost_is_still_offered_as_a_candidate() {
    let home = scratch_home("t5");
    seed("cur@x", 1_000.0, Some("r-cur"));
    seed("lost@x", 1_000.0, Some("r-DEAD")); // 회전 실패로 죽은 토큰만 남은 계정

    let v = verify::preflight("lost@x").verdict;
    println!("[T5] preflight(lost@x)={v:?}");
    assert!(matches!(v, verify::PreflightVerdict::NeedsRefresh), "죽은 토큰인지 파일로는 알 수 없다");

    // 캐시에 지난 조회값이 남아 있다(= 흔한 상태).
    let now = 1_800_000_000i64;
    let mut usage_map = BTreeMap::new();
    usage_map.insert(
        "lost@x".to_string(),
        usage::AccountUsage {
            email: "lost@x".into(),
            five_hour_pct: Some(10),
            five_hour_resets_at: Some(now + 600),
            weekly_pct: Some(5),
            weekly_resets_at: Some(now + 86_400),
            fable_pct: None,
            fable_resets_at: None,
        },
    );
    let mut pre = BTreeMap::new();
    pre.insert("lost@x".to_string(), verify::PreflightVerdict::NeedsRefresh);
    pre.insert("cur@x".to_string(), verify::PreflightVerdict::NeedsRefresh);
    let order = vec!["cur@x".to_string(), "lost@x".to_string()];
    let plan = switch::plan(&switch::SwitchInput {
        now_epoch_secs: now,
        order: &order,
        current: "cur@x",
        needs_fable: false,
        busy: &BTreeSet::new(),
        tried: &BTreeSet::new(),
        usage: &usage_map,
        preflight: &pre,
    });
    println!("[T5] pick={:?} skipped={:?}", plan.pick().map(|c| c.email.clone()), plan.skipped);
    assert_ne!(
        plan.pick().map(|c| c.email.as_str()),
        Some("lost@x"),
        "★ 회전을 잃은 계정이 다음 전환의 1등이다 — 갈아타면 로그인 창이다"
    );
    let _ = std::fs::remove_dir_all(&home);
}
