//! ★M11 **R3 확인 크리틱** — 잠금·3-way 병합·건강 장부 재공격. 실 네트워크 0건.
//!
//! 돌리는 법(핀 워크트리에 복사해서):
//! ```text
//! cp docs/critic/tools/critic-m11r3-attack.rs <wt>/crates/ccg-auth/tests/critic_m11r3_attack.rs
//! CARGO_TARGET_DIR=%TEMP%/… cargo test -p ccg-auth --test critic_m11r3_attack -- --nocapture --test-threads=1
//! ```
//!
//! R3는 `accounts.json`에 세 겹(잠금·3-way 병합·좁히기)을 두고 "로그아웃 취소 11/120 → 0"을
//! 실증했다. 그 실증의 **자식이 잠금을 아는 프로세스**라는 것이 이 파일의 출발점이다 —
//! 진짜 이웃(2.6.2 실앱)은 `fs.writeFileSync` 한 줄이고 잠금을 모른다.
//!
//! | # | 과녁 |
//! |---|---|
//! | C1 | 잠금을 **모르는** 이웃(2.6.2 모양)과 겹칠 때 로그아웃 취소·회전 클로버가 남아 있나 |
//! | C2 | 병합의 기준점(base)이 **스레드에 묶여** 있다 — 읽은 스레드와 쓰는 스레드가 다르면? |
//! | C3 | 손상 안전문이 **정상적인 빈 목록**(마지막 계정 로그아웃)을 되살리나 |
//! | C4 | 잠금 잔재 · 잠금을 쥔 채 죽은 프로세스 · 4초를 넘게 쥔 프로세스 |
//! | C5 | 건강 표식의 지문이 **재로그인이 아닌 토큰 회전**에도 무효가 되나 |
//! | C6 | 지문을 못 뜬 표식(`tokenFp` 없음)은 **영원히** 안 풀리나 |
//! | C7 | `update_store`(제품 경로)에는 손상 안전문이 없다 — 깨진 파일 위의 로그인은? |

use ccg_auth::{claude, health};
use serde_json::{json, Value};

const CHILD_ENV: &str = "CCG_M11R3C_CHILD";
const ROUNDS: usize = 200;

// ── 공용 픽스처 ─────────────────────────────────────────────────────────────

/// ★M11 R4(리드) — 홈 자물쇠는 **ccg-store 공용**(`testhome`)이다.
///
/// 옛 판은 여기서 바로 `set_var`를 했다. 한 바이너리 안에서 테스트가 병렬로 돌면 서로의
/// 홈을 갈아끼워, **직렬 실행에서 14/14 초록인 이 파일이 배치 실행에서는 5개 붉게** 나왔다
/// (리드 실측). 실행 방식에 따라 답이 갈리는 게이트는 게이트가 아니다.
fn scratch_home(tag: &str) -> ccg_store::testhome::TestHome {
    let h = ccg_store::testhome::take(tag);
    std::env::set_var("CCG_NO_NET", "1");
    h
}

fn creds_of(email: &str, refresh: &str, expires: f64) -> String {
    json!({ "claudeAiOauth": {
        "accessToken": format!("A-{email}-{refresh}"),
        "refreshToken": refresh,
        "expiresAt": expires,
        "scopes": ["user:inference"],
    }})
    .to_string()
}

fn seed(email: &str, refresh: &str) {
    let snap = json!({ "creds": creds_of(email, refresh, 4_000_000_000_000f64), "account": { "emailAddress": email, "uuid": format!("u-{email}") } });
    let enc = ccg_store::safe_storage::encrypt(&snap.to_string()).expect("safeStorage");
    let mut accounts: Vec<Value> = claude::read_store_file().accounts.clone();
    accounts.retain(|a| claude::email_of(a) != Some(email));
    accounts.push(json!({ "email": email, "credEnc": enc, "subscriptionType": "max" }));
    claude::write_store_file(&accounts, Some(email)).expect("시드 저장");
}

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
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

/// 3.0의 배경 쓰기 한 바퀴(= `persist_refreshed`가 하는 일). 잠금·좁히기를 그대로 탄다.
fn background_rotate(email: &str, refresh: &str) -> bool {
    let Some(base) = claude::freshest_creds(email) else { return false };
    let Some(next) = claude::apply_refresh(&base, &format!("A-{refresh}"), Some(refresh), 3600.0, now_ms()) else {
        return false;
    };
    claude::persist_refreshed_report(email, &next).both()
}

// ── 잠금을 **모르는** 이웃(= 2.6.2 실앱의 모양) ─────────────────────────────
//
// `src/main/auth.ts:124 writeStoreFile`는 `fs.writeFileSync(STORE_PATH, JSON.stringify(...))`
// 한 줄이다 — 잠금도 병합도 mtime 검사도 없다. 여기서는 그 모양을 그대로 흉내 낸다
// (ccg-auth의 잠금 경로를 **한 줄도** 안 쓴다).
mod peer {
    use super::*;

    pub fn read_raw() -> (u64, Option<String>, Vec<Value>) {
        let p = ccg_store::app_home().join("accounts.json");
        let Ok(s) = std::fs::read_to_string(&p) else { return (3, None, Vec::new()) };
        let Ok(v) = serde_json::from_str::<Value>(&s) else { return (3, None, Vec::new()) };
        (
            v.get("version").and_then(Value::as_u64).unwrap_or(3),
            v.get("defaultEmail").and_then(Value::as_str).map(str::to_string),
            v.get("accounts").and_then(Value::as_array).cloned().unwrap_or_default(),
        )
    }

    pub fn write_raw(default_email: Option<&str>, accounts: &[Value]) {
        let mut root = serde_json::Map::new();
        root.insert("version".into(), json!(3));
        if let Some(d) = default_email {
            root.insert("defaultEmail".into(), json!(d));
        }
        root.insert("accounts".into(), Value::Array(accounts.to_vec()));
        let p = ccg_store::app_home().join("accounts.json");
        let _ = std::fs::write(&p, serde_json::to_string_pretty(&Value::Object(root)).unwrap());
    }

    /// 2.6.2의 로그인 — 계정 항목 하나를 넣는다(읽고 → 잠깐 일하고 → 쓴다).
    pub fn login(email: &str, gap_ms: u64) {
        let (_, def, mut accounts) = read_raw();
        if accounts.iter().any(|a| claude::email_of(a) == Some(email)) {
            return;
        }
        let snap = json!({ "creds": creds_of(email, "g-0", 4_000_000_000_000f64), "account": { "emailAddress": email } });
        let Some(enc) = ccg_store::safe_storage::encrypt(&snap.to_string()) else { return };
        accounts.push(json!({ "email": email, "credEnc": enc, "subscriptionType": "max" }));
        std::thread::sleep(std::time::Duration::from_millis(gap_ms));
        write_raw(def.as_deref(), &accounts);
    }

    /// 2.6.2의 로그아웃 — 읽고, (safeStorage·해지 API 만큼) 잠깐 일하고, 통째로 쓴다.
    pub fn logout(email: &str, gap_ms: u64) {
        let (_, def, accounts) = read_raw();
        let kept: Vec<Value> = accounts.iter().filter(|a| claude::email_of(a) != Some(email)).cloned().collect();
        std::thread::sleep(std::time::Duration::from_millis(gap_ms));
        write_raw(def.as_deref(), &kept);
    }

    pub fn has(email: &str) -> bool {
        read_raw().2.iter().any(|a| claude::email_of(a) == Some(email))
    }
}

// ── C1 — 잠금을 모르는 이웃과 200판 ─────────────────────────────────────────
//
// R3의 게이트(`m11r3_store_race.rs`)와 크리틱 T4는 **자식도 ccg-auth를 쓴다** = 자식도
// 잠금을 잡는다. 그건 "3.0 두 벌"의 판이지 "3.0 + 2.6.2"의 판이 아니다. 여기서는 자식이
// 잠금을 **모른다**(위 `peer` 모듈 = auth.ts의 모양).
#[test]
fn c1_a_lock_unaware_neighbour_still_races_the_background_writer() {
    if std::env::var(CHILD_ENV).is_ok() {
        return;
    }
    let home = scratch_home("c1");
    seed("mine@x", "m-init");
    seed("ghost@x", "g-0");

    let exe = std::env::current_exe().expect("테스트 바이너리");
    let child = std::process::Command::new(exe)
        .args(["--exact", "c1_child_is_the_lock_unaware_neighbour", "--nocapture"])
        .env(CHILD_ENV, "1")
        .env("CCG_HOME", &home)
        .env("CCG_NO_NET", "1")
        .stdout(std::process::Stdio::piped())
        .spawn()
        .expect("자식 프로세스");

    // 부모 = 3.0의 배경 쓰기(자동 전환 워커의 회전 정착). 잠금·좁히기를 다 쓴다.
    let mut clobbered = 0usize;
    let mut failed = 0usize;
    for i in 0..ROUNDS {
        let want = format!("m-{i}");
        if !background_rotate("mine@x", &want) {
            failed += 1;
            continue;
        }
        if store_refresh_of("mine@x").as_deref() != Some(want.as_str()) {
            clobbered += 1;
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    let out = child.wait_with_output().expect("자식 종료");
    let tail: String = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| l.starts_with("[C1-child]"))
        .collect::<Vec<_>>()
        .join("\n");
    println!("{tail}");
    println!("[C1] 부모(3.0) {ROUNDS}판 — 백업이 내 회전을 잃은 판={clobbered} 저장 실패={failed}");
    println!("[C1] 최종 store(mine)={:?} folder(mine)={:?}", store_refresh_of("mine@x"), claude::refresh_token("mine@x"));
    // 단정은 하나뿐 — **폴더 사본은 살아야 한다**(그게 유일한 완충이라고 R2가 적었다).
    assert!(claude::refresh_token("mine@x").is_some(), "★ 회전 재료가 어디에도 안 남았다");
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn c1_child_is_the_lock_unaware_neighbour() {
    if std::env::var(CHILD_ENV).is_err() {
        return;
    }
    let mut resurrected = 0usize;
    let mut rounds = 0usize;
    for _ in 0..ROUNDS {
        peer::login("ghost@x", 2);
        std::thread::sleep(std::time::Duration::from_millis(2));
        peer::logout("ghost@x", 2);
        rounds += 1;
        // 되살아남은 **잠깐**일 수 있다(다음 쓰기가 다시 지운다) — 그래도 그 순간의
        // 파일이 사용자가 보는 목록이다. 15ms를 1ms 간격으로 훑는다.
        let mut back = false;
        for _ in 0..15 {
            std::thread::sleep(std::time::Duration::from_millis(1));
            if peer::has("ghost@x") {
                back = true;
                break;
            }
        }
        if back {
            resurrected += 1;
        }
    }
    println!("[C1-child] 잠금 모르는 이웃 {rounds}판 — 로그아웃이 취소된 판={resurrected}");
}

// ── C2 — 병합의 기준점은 **스레드에 묶여 있다** ─────────────────────────────
//
// `record_base`는 `thread_local!`이다. `read_store_file()`을 부른 스레드와
// `write_store_file()`을 부르는 스레드가 다르면 base가 없고, base가 없으면 **병합을
// 통째로 건너뛴다**(`merge3`의 첫 줄) = R2의 통짜 덮어쓰기 그대로다.
#[test]
fn c2_the_merge_base_lives_on_the_reading_thread_only() {
    let home = scratch_home("c2");
    seed("a@x", "a-1");
    seed("b@x", "b-1");

    // ① 대조군 — 같은 스레드에서 읽고 쓴다(설계가 상정한 모양). 병합이 선다.
    let snap = claude::read_store_file();
    peer::logout("b@x", 0); // 옆 앱이 b를 로그아웃했다
    claude::write_store_file(&snap.accounts, snap.default_email.as_deref()).expect("저장");
    let same_thread = claude::read_store_file().accounts.iter().any(|a| claude::email_of(a) == Some("b@x"));
    println!("[C2] 같은 스레드 읽기→쓰기: 로그아웃한 b@x가 되살아났나 = {same_thread}");

    // ② 실험군 — 읽은 스레드와 **쓰는 스레드가 다르다**(허브가 읽고 워커가 쓰는 모양).
    //    기준점은 `thread_local!`이라 쓰는 스레드에는 없다.
    seed("b@x", "b-2");
    let snap2 = claude::read_store_file();
    peer::logout("b@x", 0);
    let (acc, def) = (snap2.accounts.clone(), snap2.default_email.clone());
    std::thread::spawn(move || claude::write_store_file(&acc, def.as_deref()).expect("저장"))
        .join()
        .expect("쓰기 스레드");
    let cross_thread = claude::read_store_file().accounts.iter().any(|a| claude::email_of(a) == Some("b@x"));
    println!("[C2] 다른 스레드 읽기→쓰기: 로그아웃한 b@x가 되살아났나 = {cross_thread}");

    assert!(!same_thread, "대조군이 이미 깨졌다(병합이 아예 안 선다)");
    assert!(!cross_thread, "★ 읽은 스레드가 다르면 병합이 사라진다 — 로그아웃이 취소됐다");
    let _ = std::fs::remove_dir_all(&home);
}

// ── C3 — 손상 안전문이 **정상적인 빈 목록**을 되살리나 ──────────────────────
//
// `merge3`의 안전문은 "디스크가 비었는데 base는 안 비었으면 병합을 건너뛴다"이다.
// 그런데 `read_store_file`은 **손상**과 **정상적인 빈 목록**(마지막 계정 로그아웃)을
// 구별하지 않는다. 후자에서 이 문이 열리면 그건 "지운 계정 전부 되살리기"다.
#[test]
fn c3_the_corruption_gate_cannot_tell_an_empty_store_from_a_broken_one() {
    let home = scratch_home("c3");
    seed("a@x", "a-1");
    seed("b@x", "b-1");
    let snap = claude::read_store_file(); // base = [a, b]

    // 옆 앱이 **둘 다** 로그아웃했다(정상적인 빈 목록 — 파일은 멀쩡한 v3다).
    peer::write_raw(None, &[]);
    let raw = std::fs::read_to_string(home.join("accounts.json")).unwrap();
    println!("[C3] 이웃이 남긴 파일 = {}", raw.replace('\n', " "));

    claude::write_store_file(&snap.accounts, snap.default_email.as_deref()).expect("저장");
    let after: Vec<String> = claude::read_store_file().accounts.iter().filter_map(|a| claude::email_of(a).map(str::to_string)).collect();
    println!("[C3] 우리 쓰기 뒤 계정 = {after:?}");
    assert!(after.is_empty(), "★ 마지막 계정 로그아웃이 통째로 취소됐다(안전문이 정상 상태에 발동) — {after:?}");
    let _ = std::fs::remove_dir_all(&home);
}

// ── C4 — 잠금 잔재 · 쥔 채 죽음 · 오래 쥠 ───────────────────────────────────
#[test]
fn c4_a_dead_or_stuck_lock_holder_never_freezes_us() {
    if std::env::var(CHILD_ENV).is_ok() {
        return;
    }
    let home = scratch_home("c4");
    seed("a@x", "a-1");
    let exe = std::env::current_exe().expect("테스트 바이너리");

    // ① 잠금을 쥔 채 **죽는** 프로세스 — 커널이 거둬야 우리가 안 막힌다.
    let mut child = std::process::Command::new(&exe)
        .args(["--exact", "c4_child_dies_holding_the_lock", "--nocapture"])
        .env(CHILD_ENV, "die")
        .env("CCG_HOME", &home)
        .stdout(std::process::Stdio::piped())
        .spawn()
        .expect("자식");
    std::thread::sleep(std::time::Duration::from_millis(400)); // 자식이 잠금을 잡을 시간
    let t0 = std::time::Instant::now();
    let g = ccg_auth::claude::store_lock();
    let waited = t0.elapsed();
    println!("[C4-①] 죽은 주인 뒤 잠금 획득: {waited:?} cross={}", g.cross_process());
    drop(g);
    let _ = child.wait();
    assert!(waited < std::time::Duration::from_secs(3), "★ 죽은 주인의 잠금이 안 풀린다: {waited:?}");

    // ② 잠금을 **오래 쥔**(살아 있는) 프로세스 — 규약 3대로 4초 뒤 없이 진행해야 한다.
    let mut child = std::process::Command::new(&exe)
        .args(["--exact", "c4_child_holds_the_lock_for_ten_seconds", "--nocapture"])
        .env(CHILD_ENV, "hold")
        .env("CCG_HOME", &home)
        .stdout(std::process::Stdio::piped())
        .spawn()
        .expect("자식");
    std::thread::sleep(std::time::Duration::from_millis(600));
    let t0 = std::time::Instant::now();
    let ok = background_rotate("a@x", "a-2");
    let waited = t0.elapsed();
    println!("[C4-②] 살아 있는 주인이 쥔 동안 배경 쓰기: {waited:?} 성공={ok} store={:?}", store_refresh_of("a@x"));
    let _ = child.kill();
    let _ = child.wait();
    assert!(ok, "★ 잠금 하나 때문에 사용자의 저장이 사라졌다");
    assert!(waited >= std::time::Duration::from_secs(4), "4초를 안 기다렸다 = 잠금이 안 걸린 것이다: {waited:?}");
    assert!(waited < std::time::Duration::from_secs(9), "★ 잠금 대기가 안 끝난다: {waited:?}");

    // ③ 잔재 — `.lock` 파일은 남는가(남아도 다음 획득을 막지 않아야 한다).
    let left = home.join("accounts.json.lock").exists();
    let t0 = std::time::Instant::now();
    let g = ccg_auth::claude::store_lock();
    println!("[C4-③] 잠금 파일 잔재={left} 재획득={:?} cross={}", t0.elapsed(), g.cross_process());
    assert!(g.cross_process(), "★ 잔재가 다음 획득을 막는다");
    drop(g);
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn c4_child_dies_holding_the_lock() {
    if std::env::var(CHILD_ENV).as_deref() != Ok("die") {
        return;
    }
    let g = ccg_auth::claude::store_lock();
    println!("[C4-child] 잠금 잡음 cross={} — 이제 죽는다", g.cross_process());
    std::mem::forget(g); // Drop을 안 부르고
    std::process::exit(3); // 프로세스째 죽는다(커널이 거두는지가 과녁)
}

#[test]
fn c4_child_holds_the_lock_for_ten_seconds() {
    if std::env::var(CHILD_ENV).as_deref() != Ok("hold") {
        return;
    }
    let g = ccg_auth::claude::store_lock();
    println!("[C4-child] 잠금 10초 보유 cross={}", g.cross_process());
    std::thread::sleep(std::time::Duration::from_secs(10));
    drop(g);
}

// ── C5 — 건강 표식의 지문은 **재로그인**만 가려내나 ─────────────────────────
//
// `health::needs_login`은 "지문이 달라졌다 = 재로그인했다"로 읽는다. 그런데 지문은
// **크리덴셜 원문 전체**의 sha256이라(`token_fingerprint`), 액세스 토큰 하나만 갱신돼도
// 달라진다 — CLI가 턴 중에 리프레시하면 그렇게 된다. 그러면 격리가 저절로 풀린다.
#[test]
fn c5_an_ordinary_token_refresh_dissolves_the_quarantine_mark() {
    let home = scratch_home("c5");
    seed("sick@x", "r-dead");
    health::mark_needs_login("sick@x", "TokenLost");
    assert!(health::needs_login("sick@x"), "표식이 서야 이 판이 성립한다");

    // CLI가 턴 중에 액세스 토큰만 갱신했다(refresh 토큰은 **그대로**, 재로그인 아님).
    let dir = claude::account_dir("sick@x");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(".credentials.json"), creds_of("sick@x", "r-dead", 4_100_000_000_000f64)).unwrap();

    let still = health::needs_login("sick@x");
    println!("[C5] 액세스 토큰만 갱신(같은 refresh) 뒤 표식 = {still} / 장부={:?}", health::read_all().keys().collect::<Vec<_>>());
    assert!(still, "★ 재로그인이 아닌 회전에 격리가 풀렸다 — 죽은 refresh를 문 계정이 다시 후보다");
    let _ = std::fs::remove_dir_all(&home);
}

// ── C6 — 지문을 못 뜬 표식은 **영원히** 안 풀린다 ───────────────────────────
//
// `mark_needs_login`은 `fingerprint()`가 `None`이면 `tokenFp`를 안 적는다. 그런데
// `needs_login`의 해제 규칙은 `token_fp.is_some() && ...`이라, 그 표식은 **어떤 재로그인
// 으로도** 무효가 되지 않는다. 그리고 셸의 `collect()`는 표식이 선 계정을 **조회하지
// 않고** `continue`하므로(acct_switch.rs) 성공으로 지워질 길도 없다.
//
// 도달 경로: 워커가 401을 받은 그 순간 사용자가 그 계정을 로그아웃한 판
// (로그아웃 = 토큰 해지라 401은 오히려 흔하다). `freshest_creds`가 None → 지문 None.
#[test]
fn c6_a_mark_without_a_fingerprint_is_a_life_sentence() {
    let home = scratch_home("c6");
    seed("gone@x", "r-1");
    // 사용자가 2.6.2에서 로그아웃했다(계정이 스토어에서 사라진다).
    peer::logout("gone@x", 0);
    let _ = std::fs::remove_dir_all(claude::account_dir("gone@x"));
    assert!(claude::freshest_creds("gone@x").is_none(), "이 판의 전제 — 크리덴셜을 못 읽는다");

    // 그 순간 워커의 조회가 401로 착지한다 → 표식(지문 없음).
    health::mark_needs_login("gone@x", "http 401");
    let raw = std::fs::read_to_string(home.join(health::FILE)).unwrap_or_default();
    println!("[C6] 표식 파일 = {}", raw.replace('\n', " "));
    assert!(!raw.contains("tokenFp"), "이 판의 전제 — 지문이 안 적혔다");

    // 사용자가 다시 로그인한다(완전히 새 크리덴셜).
    seed("gone@x", "r-fresh-after-login");
    let still = health::needs_login("gone@x");
    println!("[C6] 재로그인 뒤 needs_login = {still}");
    assert!(!still, "★ 재로그인해도 안 풀리는 표식이다 — 자동 전환에서 영구 제외 + 설정에 영구 배지");
    let _ = std::fs::remove_dir_all(&home);
}

// ── C8 — 제품 경로에 남은 창의 **폭**을 잰다 ────────────────────────────────
//
// `update_account_record`는 잠금 안에서 `read → 클로저 → write`다. 잠금을 모르는 이웃의
// 쓰기가 그 사이에 떨어지면 이웃의 로그아웃이 취소된다. 창이 얼마나 넓은가 — 제품의
// 클로저는 safeStorage **복호 + 암호**(DPAPI 2회)를 그 안에서 한다(`persist_refreshed_report`).
#[test]
fn c8_the_remaining_window_inside_the_lock_is_real_and_measurable() {
    let home = scratch_home("c8");
    seed("w@x", "w-0");
    // ① 폭 — 제품과 **같은 클로저**로 50판.
    let t0 = std::time::Instant::now();
    for i in 0..50 {
        assert!(background_rotate("w@x", &format!("w-{i}")));
    }
    let per = t0.elapsed() / 50;
    println!("[C8-①] persist_refreshed_report 1회 = {per:?} (읽기+DPAPI 2회+쓰기, 잠금 안)");

    // ② 그 창 안에 이웃의 로그아웃이 떨어지면? — 클로저가 60ms 걸리는 판으로 재현한다
    //    (제품에서 그 자리는 DPAPI 2회 + 디스크. 검사기·절전 복귀에 수십 ms는 흔하다).
    seed("ghost@x", "g-0");
    let t = std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_millis(20));
        peer::logout("ghost@x", 0); // 이웃(2.6.2)이 통째로 다시 쓴다
    });
    claude::update_account_record("w@x", |m| {
        std::thread::sleep(std::time::Duration::from_millis(60));
        m.insert("credEnc".into(), json!(format!("changed-{}", now_ms())));
    })
    .expect("배경 쓰기");
    t.join().unwrap();
    let back = peer::has("ghost@x");
    println!("[C8-②] 잠금 안 클로저(60ms) 중 이웃 로그아웃 → 되살아났나 = {back}");
    assert!(!back, "★ 잠금 안에서도 창이 남아 있다 — 그 창에 떨어진 로그아웃은 취소된다");
    let _ = std::fs::remove_dir_all(&home);
}

// ── C9 — Probe 한정의 대가: **네트워크가 멀쩡한 429**에서 후보가 사라진다 ───
//
// R3는 `plan`의 통과를 `Probe` 하나로 좁혔다. 그 근거는 "collect()가 조회 뒤 preflight를
// 다시 잰다"인데, 그 문장은 **조회가 성공했을 때만** 참이다. 조회가 429/5xx로 실패하면
//
//   ① 판정은 조회 전 값 그대로(`NeedsRefresh` → `Unverified`),
//   ② 새 usage가 없으니 캐시는 [`usage::ACCT_USAGE_TTL_MS`]=**2분** 뒤 낡고,
//   ③ 셸의 격리 백오프(`SICK_BACKOFF_BASE` 60초 → ×2 → 상한 30분)가 재조회를 막는다.
//
// 즉 usage API가 잠깐 흔들리면 그 계정은 **최대 30분** 후보에서 빠진다. 그 사이 사용자가
// 보는 것은 "갈아탈 계정이 없어요"다. 아래는 그 착지 지점(②의 결과)을 `plan`으로 확인한다.
#[test]
fn c9_a_live_account_without_fresh_usage_is_not_a_candidate() {
    use ccg_auth::switch::{plan, SkipWhy, SwitchInput};
    use ccg_auth::verify::PreflightVerdict;
    let now = 1_800_000_000i64;
    let order = vec!["cur@x".to_string(), "ok@x".to_string()];
    let mut pre = std::collections::BTreeMap::new();
    pre.insert("cur@x".to_string(), PreflightVerdict::Probe);
    pre.insert("ok@x".to_string(), PreflightVerdict::Probe); // 토큰은 **살아 있다**
    let p = plan(&SwitchInput {
        now_epoch_secs: now,
        order: &order,
        current: "cur@x",
        needs_fable: false,
        tried: &Default::default(),
        busy: &Default::default(),
        usage: &Default::default(), // 429 때문에 이번 창의 usage가 없다
        preflight: &pre,
    });
    println!("[C9] pick={:?} skipped={:?}", p.pick().map(|c| c.email.clone()), p.skipped);
    assert_eq!(p.pick().map(|c| c.email.clone()), None);
    assert!(p.skipped.iter().any(|s| s.email == "ok@x" && s.why == SkipWhy::UsageUnknown));
    println!("[C9] 캐시 TTL={}ms · 셸 백오프 60s→…→30min → 그 창 동안 후보 0", ccg_auth::usage::ACCT_USAGE_TTL_MS);
}

// ── X — 하네스용 배경 쓰기 루프(2.6.2 실코드 하네스가 부른다) ───────────────
//
// `CCG_M11R3C_BGW=<email>:<rounds>`가 있을 때만 일한다. 3.0의 자동 전환 워커가 하는
// 그 쓰기(`persist_refreshed` → `update_account_record`)를 그대로 반복한다.
#[test]
fn x_seed_for_the_262_harness() {
    let Ok(spec) = std::env::var("CCG_M11R3C_SEED") else { return };
    for email in spec.split(',').filter(|s| !s.is_empty()) {
        seed(email, "seed-0");
    }
    println!("[SEED] {:?}", claude::read_store_file().accounts.iter().filter_map(claude::email_of).collect::<Vec<_>>());
}

#[test]
fn x_background_writer_for_the_262_harness() {
    let Ok(spec) = std::env::var("CCG_M11R3C_BGW") else { return };
    let (email, rounds) = spec.split_once(':').expect("email:rounds");
    let rounds: usize = rounds.parse().expect("rounds");
    // 겹침 보장 — 하네스가 `go`를 놓을 때까지 기다리고 `done`이 뜨면 멈춘다.
    let gate = std::env::var("CCG_M11R3C_GATE").ok().map(std::path::PathBuf::from);
    if let Some(g) = &gate {
        let t0 = std::time::Instant::now();
        while !g.join("go").exists() && t0.elapsed() < std::time::Duration::from_secs(60) {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
    let mut ok = 0usize;
    let mut clobbered = 0usize;
    for i in 0..rounds {
        if gate.as_ref().is_some_and(|g| g.join("done").exists()) {
            println!("[BGW] 하네스가 끝났다 — i={i}에서 멈춘다");
            break;
        }
        let want = format!("bg-{i}");
        if background_rotate(email, &want) {
            ok += 1;
            if store_refresh_of(email).as_deref() != Some(want.as_str()) {
                clobbered += 1;
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(4));
    }
    println!("[BGW] rounds={rounds} ok={ok} clobbered={clobbered} store={:?} folder={:?}", store_refresh_of(email), claude::refresh_token(email));
}

// ── C7 — 제품 경로(`update_store`)에는 손상 안전문이 없다 ───────────────────
//
// 안전문은 `merge3`(= `write_store_file`) 안에만 있다. 그런데 목록을 바꾸는 제품 경로는
// `update_store`이고 그쪽은 잠금 안에서 읽은 값을 **그대로 믿는다**. 파일이 깨져 있으면
// `read_store_file`은 빈 스토어를 주므로, 그 위의 로그인 한 번이 **나머지 계정을 지운다**.
#[test]
fn c7_a_corrupt_store_plus_one_login_erases_every_other_account() {
    let home = scratch_home("c7");
    seed("a@x", "a-1");
    seed("b@x", "b-1");
    // 파일이 반쪽만 쓰였다(디스크 가득 참·전원 차단·바이러스 검사기).
    let p = home.join("accounts.json");
    let good = std::fs::read_to_string(&p).unwrap();
    std::fs::write(&p, &good[..good.len() / 2]).unwrap();
    assert!(claude::read_store_file().accounts.is_empty(), "이 판의 전제 — 깨진 파일은 빈 스토어로 읽힌다");

    // 사용자가 계정 하나를 새로 로그인한다(제품의 목록 변경 경로).
    claude::update_store(|f| {
        f.accounts.push(json!({ "email": "c@x", "credEnc": "x", "subscriptionType": "max" }));
    })
    .expect("저장");
    let after: Vec<String> = claude::read_store_file().accounts.iter().filter_map(|a| claude::email_of(a).map(str::to_string)).collect();
    println!("[C7] 깨진 파일 위 로그인 뒤 계정 = {after:?} (원본은 a@x·b@x)");
    assert!(after.len() >= 2, "★ 손상 위의 로그인 한 번이 다른 계정을 전부 지웠다 — 안전문이 이 경로엔 없다: {after:?}");
    let _ = std::fs::remove_dir_all(&home);
}
