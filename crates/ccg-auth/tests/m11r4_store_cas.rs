//! ★M11 R4(G1) — **잠금을 *모르는* 이웃과 겹칠 때 `accounts.json`이 버티나.**
//!
//! R3의 게이트(`m11r3_store_race.rs`)는 자식도 `ccg-auth`를 쓴다 = 자식도 `flock`을 잡는다.
//! 그건 "3.0 두 벌"의 판이고, F1이 막겠다고 적은 상대는 **2.6.2 실앱**이다. 그쪽의 쓰기는
//!
//! ```js
//! fs.writeFileSync(STORE_PATH, JSON.stringify({ version, defaultEmail, accounts }, null, 2))
//! ```
//!
//! 한 줄이고(`src/main/auth.ts:124`) 잠금도 병합도 mtime 검사도 없다. R3 확인 크리틱이
//! 그 실코드로 재서 **로그아웃 취소 2/150**을 냈고, 이 라운드가 같은 하네스로 재현한
//! 값은 **14/1500**이었다.
//!
//! 여기서는 그 이웃을 **같은 프로세스의 다른 스레드**로 세운다. `flock`은 프로세스 안팎
//! 두 겹인데 이 스레드는 어느 쪽도 안 잡고 `std::fs::write`만 한다 — 2.6.2와 같은 모양이다.
//! (실 Electron 하네스는 `docs/critic/tools/critic-m11r3-262race.mjs`. 그쪽이 진짜 상대고,
//! 이 파일은 그 판정을 **워크스페이스 게이트로** 붙잡아 두는 자리다.)
//!
//! 네트워크 0건 · `CCG_HOME` 격리 · 실홈은 열지 않는다.

use ccg_auth::claude;
use serde_json::{json, Value};

const ROUNDS: usize = 150;

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

fn creds_of(email: &str, refresh: &str) -> String {
    json!({ "claudeAiOauth": {
        "accessToken": format!("A-{email}-{refresh}"),
        "refreshToken": refresh,
        "expiresAt": 4_000_000_000_000f64,
    }})
    .to_string()
}

fn seed(email: &str, refresh: &str) {
    let snap = json!({ "creds": creds_of(email, refresh), "account": { "emailAddress": email } });
    let enc = ccg_store::safe_storage::encrypt(&snap.to_string()).expect("safeStorage");
    let mut accounts: Vec<Value> = claude::read_store_file().accounts.clone();
    accounts.retain(|a| claude::email_of(a) != Some(email));
    accounts.push(json!({ "email": email, "credEnc": enc, "subscriptionType": "max" }));
    claude::write_store_file(&accounts, Some(email)).expect("시드 저장");
}

/// 3.0의 배경 쓰기 한 바퀴(= 자동 전환 워커의 회전 정착).
fn rotate(email: &str, refresh: &str) -> bool {
    let Some(base) = claude::freshest_creds(email) else { return false };
    let Some(next) = claude::apply_refresh(&base, &format!("A-{refresh}"), Some(refresh), 3600.0, now_ms()) else {
        return false;
    };
    claude::persist_refreshed_report(email, &next).both()
}

fn store_refresh_of(email: &str) -> Option<String> {
    let f = claude::read_store_file();
    let a = f.accounts.iter().find(|a| claude::email_of(a) == Some(email))?;
    let raw = ccg_store::safe_storage::decrypt(claude::cred_enc_of(a)?)?;
    let creds = claude::Snapshot::parse(&raw).creds()?.to_string();
    let v: Value = serde_json::from_str(&creds).ok()?;
    v.get("claudeAiOauth")?.get("refreshToken")?.as_str().map(str::to_string)
}

/// **잠금을 모르는 이웃** — `auth.ts`의 모양 그대로(잠금·병합·CAS 어느 것도 안 쓴다).
mod peer {
    use super::*;

    fn path() -> std::path::PathBuf {
        ccg_store::app_home().join("accounts.json")
    }

    pub fn read_raw() -> (Option<String>, Vec<Value>) {
        let Ok(s) = std::fs::read_to_string(path()) else { return (None, Vec::new()) };
        let Ok(v) = serde_json::from_str::<Value>(&s) else { return (None, Vec::new()) };
        (
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
        // ★ 통짜 · 비원자 · 잠금 없음 — 2.6.2 `writeStoreFile`과 같다.
        let _ = std::fs::write(path(), serde_json::to_string_pretty(&Value::Object(root)).unwrap());
    }

    pub fn login(email: &str) {
        let (def, mut accounts) = read_raw();
        if accounts.iter().any(|a| claude::email_of(a) == Some(email)) {
            return;
        }
        let snap = json!({ "creds": creds_of(email, "g-0"), "account": { "emailAddress": email } });
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

/// ★G1 — 잠금을 모르는 이웃의 **로그아웃이 취소되지 않는다.**
///
/// 단정은 R3 게이트와 같은 모양이다: 되살아남 0. 되살아남은 **잠깐**일 수 있으므로
/// (다음 쓰기가 다시 지운다) 로그아웃 직후 15ms를 1ms 간격으로 훑는다 — 그 순간의
/// 파일이 곧 사용자가 보는 계정 목록이다.
#[test]
fn a_lock_unaware_neighbour_cannot_undo_a_logout() {
    // ★M11 R4(리드) — 홈 자물쇠는 ccg-store 공용(testhome). 한 바이너리 안의 병렬
    // 실행이 서로의 CCG_HOME을 갈아끼우던 자리다(critic_m11r3_attack.rs 주석 참고).
    let home = ccg_store::testhome::take("r4cas");
    std::env::set_var("CCG_NO_NET", "1");
    seed("mine@x", "m-init");

    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let s2 = stop.clone();
    // 3.0의 배경 쓰기(자동 전환 워커) — 잠금·CAS·좁히기를 전부 탄다.
    let writer = std::thread::spawn(move || {
        let mut i = 0usize;
        let mut ok = 0usize;
        while !s2.load(std::sync::atomic::Ordering::Relaxed) {
            if rotate("mine@x", &format!("m-{i}")) {
                ok += 1;
            }
            i += 1;
            std::thread::sleep(std::time::Duration::from_millis(3));
        }
        (i, ok)
    });

    let mut resurrected = 0usize;
    for _ in 0..ROUNDS {
        peer::login("ghost@x");
        std::thread::sleep(std::time::Duration::from_millis(3));
        peer::logout("ghost@x");
        for _ in 0..15 {
            std::thread::sleep(std::time::Duration::from_millis(1));
            if peer::has("ghost@x") {
                resurrected += 1;
                if resurrected <= 3 {
                    let raw = std::fs::read_to_string(ccg_store::app_home().join("accounts.json")).unwrap_or_default();
                    println!("[r4-cas][DBG] 되살아난 파일 = {}", raw.replace('\n', " "));
                }
                break;
            }
        }
    }
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    let (rounds, ok) = writer.join().expect("배경 쓰기 스레드");
    println!("[r4-cas] 이웃 로그아웃 {ROUNDS}판 · 배경 회전 {rounds}판(성공 {ok}) — 로그아웃이 취소된 판={resurrected}");
    println!("[r4-cas] 최종 store(mine)={:?} folder(mine)={:?}", store_refresh_of("mine@x"), claude::refresh_token("mine@x"));

    assert_eq!(resurrected, 0, "★ 잠금을 모르는 이웃의 로그아웃이 우리 배경 쓰기에 취소됐다");
    // 회전 재료는 어디에도 안 잃는다(폴더 사본이 마지막 완충 — R2 §5).
    assert!(claude::refresh_token("mine@x").is_some(), "★ 회전 재료가 어디에도 안 남았다");
    assert!(!peer::has("ghost@x"), "마지막 상태도 로그아웃이어야 한다");
    let _ = std::fs::remove_dir_all(&home);
}
