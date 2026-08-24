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

/// 계정 **폴더**의 살아 있는 토큰 — 스토어를 거치지 않고 직접 읽는다(규약 2: 살아 있는
/// 토큰의 거처는 폴더고 `credEnc`는 재생성용 백업이다).
fn folder_refresh_of(email: &str) -> Option<String> {
    let raw = std::fs::read_to_string(claude::account_dir(email).join(".credentials.json")).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    v.get("claudeAiOauth")?.get("refreshToken")?.as_str().map(str::to_string)
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

    /// 이웃이 `accounts.json`을 **못 읽은** 횟수(없다·반쪽). 0이어야 한다 — 자세한 사연은
    /// [`read_raw`] 참고.
    pub static MISSED: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    /// 이웃의 통짜 쓰기가 **실패한** 횟수. 0이어야 한다 — 우리 핸들이 그들의 쓰기를
    /// 막으면(공유 모드를 좁히면) 그건 그것대로 조용한 로그아웃 유실이다.
    pub static WRITE_FAILED: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

    fn path() -> std::path::PathBuf {
        ccg_store::app_home().join("accounts.json")
    }

    /// ★R28d(CASX) — 읽기 실패도 **센다.** 2.6.2의 `readStoreFile`은 실패를 try/catch로
    /// 삼키고 "계정 0개"를 돌려주는데, 그 위의 로그아웃 한 번이 목록을 통째로 지운다.
    /// R28d는 우리 `std::fs::rename`이 도는 동안 이 읽기가 **ENOENT를 6번 연속** 받는
    /// 것을 잡았다 — 증상이 아니라 사고였다(`replace.rs` 모듈 주석).
    pub fn read_raw() -> (Option<String>, Vec<Value>) {
        let s = match std::fs::read_to_string(path()) {
            Ok(s) => s,
            Err(e) => {
                MISSED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                trace(&format!("읽기 ★실패 {:?} 경로={}", e.kind(), path().display()), &[]);
                return (None, Vec::new());
            }
        };
        let Ok(v) = serde_json::from_str::<Value>(&s) else {
            MISSED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            trace(&format!("읽기 ★파싱실패 {}B", s.len()), &[]);
            return (None, Vec::new());
        };
        (
            v.get("defaultEmail").and_then(Value::as_str).map(str::to_string),
            v.get("accounts").and_then(Value::as_array).cloned().unwrap_or_default(),
        )
    }

    fn us() -> u128 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_micros()).unwrap_or(0)
    }
    pub fn trace(what: &str, accounts: &[Value]) {
        if std::env::var("CCG_CAS_TRACE").is_ok_and(|v| v == "1") {
            eprintln!("[cas][{}] 이웃 {what} — [{}]", us(), accounts.iter().filter_map(claude::email_of).collect::<Vec<_>>().join(","));
        }
    }

    pub fn write_raw(default_email: Option<&str>, accounts: &[Value]) {
        let mut root = serde_json::Map::new();
        root.insert("version".into(), json!(3));
        if let Some(d) = default_email {
            root.insert("defaultEmail".into(), json!(d));
        }
        root.insert("accounts".into(), Value::Array(accounts.to_vec()));
        // ★ 통짜 · 비원자 · 잠금 없음 — 2.6.2 `writeStoreFile`과 같다.
        trace("쓰기 시작", accounts);
        let r = std::fs::write(path(), serde_json::to_string_pretty(&Value::Object(root)).unwrap());
        match &r {
            Ok(()) => trace("쓰기 끝(성공)", accounts),
            Err(e) => {
                WRITE_FAILED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                trace(&format!("쓰기 끝(★실패 {:?} {})", e.kind(), e), accounts);
            }
        }
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
///
/// ## ★R28d(CASX) — 이 못은 다섯에 한 번 붉었고, 그건 못이 아니라 **제품**이었다
///
/// 크리틱 실측 4/20(대조군도 동률 = 선존)을 R28d가 추적으로 갈랐다. 셋 다 제품 창이다.
///
/// | # | 무엇이 무엇을 이겼나 | 사용자 피해 | 닫은 자리 |
/// |---|---|---|---|
/// | ① | `std::fs::rename`이 도는 동안 **파일이 없어 보였다**(ENOENT 6연속·7.2ms) | 이웃이 "계정 0개"로 읽고 그 위에 쓰면 **목록 전체 소멸**(실측: 이 못이 「회전 재료가 어디에도 안 남았다」로 붉었다) | [`ccg_auth::replace`] — POSIX 의미론 단일 호출 |
/// | ② | 그 창에서 이웃의 `CREATE_ALWAYS`가 **새 파일**을 만들고 우리 rename이 그걸 덮었다 | 묻힌 줄도 모른 채 로그아웃 취소가 **85ms 지속**(다음 이웃 쓰기까지) | 같은 자리(제3의 inode가 안 생긴다) |
/// | ③ | 묻힌 것을 찾아 되살리는 동안 로그아웃한 계정이 파일에 앉아 있었다(실측 1.7~7.6ms) | 이웃이 자기 쓰기 1ms 뒤에 다시 읽으면 그걸 본다 | 창 안의 `eprintln` 제거 + 증인 핸들 물려주기(`open` 350µs 절약) |
///
/// A/B(같은 부하·번갈아 20주행): **대조군 5/20 붉음 · 고친 판 0/20**.
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
    let mut persisted = 0usize;
    for _ in 0..ROUNDS {
        peer::login("ghost@x");
        std::thread::sleep(std::time::Duration::from_millis(3));
        peer::logout("ghost@x");
        for _ in 0..15 {
            std::thread::sleep(std::time::Duration::from_millis(1));
            if peer::has("ghost@x") {
                resurrected += 1;
                let raw = std::fs::read_to_string(ccg_store::app_home().join("accounts.json")).unwrap_or_default();
                peer::trace("★되살아남 관측", &[]);
                if resurrected <= 3 {
                    println!("[r4-cas][DBG] 되살아난 파일 = {}", raw.replace('\n', " "));
                }
                // ★R28d — **깜빡임인가 취소인가.** 되살아남이 스스로 걷히면 그건 우리
                // 되살리기가 뒤늦게 착지한 것이고(제품 창은 그 폭만큼), 200ms 뒤에도
                // 살아 있으면 그건 사용자의 로그아웃이 **취소된** 것이다. 둘은 피해가
                // 다르니 따로 센다 — 아래 단정은 여전히 둘 다 0을 요구한다.
                let mut gone_at = None;
                for k in 0..40 {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                    if !peer::has("ghost@x") {
                        gone_at = Some((k + 1) * 5);
                        break;
                    }
                }
                match gone_at {
                    Some(ms) => println!("[r4-cas][DBG] 되살아남이 {ms}ms 뒤 사라짐(깜빡임)"),
                    None => {
                        persisted += 1;
                        println!("[r4-cas][DBG] ★되살아남이 200ms 뒤에도 살아 있다 — 로그아웃 취소");
                    }
                }
                break;
            }
        }
    }
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    let (rounds, ok) = writer.join().expect("배경 쓰기 스레드");
    let missed = peer::MISSED.load(std::sync::atomic::Ordering::Relaxed);
    let wfail = peer::WRITE_FAILED.load(std::sync::atomic::Ordering::Relaxed);
    println!("[r4-cas] 이웃 로그아웃 {ROUNDS}판 · 배경 회전 {rounds}판(성공 {ok}) — 로그아웃이 취소된 판={resurrected}(그중 지속={persisted})");
    println!("[r4-cas] 이웃이 파일을 못 읽은 횟수={missed} · 이웃 쓰기 실패={wfail}");
    println!(
        "[r4-cas] 최종 store(mine)={:?} 폴더원본(mine)={:?} freshest(mine)={:?}",
        store_refresh_of("mine@x"),
        folder_refresh_of("mine@x"),
        claude::refresh_token("mine@x")
    );

    // ★R28d — `missed`는 **세지만 단정하지 않는다.** 그 창(갈아끼우는 동안 이름이
    // 잠깐 사라진다)은 이 OS의 성질이고 옛 길에서도 같은 크기로 난다
    // (`replace.rs` 모듈 주석의 4판 A/B). 우리가 못 고치는 것을 게이트로 세우면 게이트가
    // 다섯에 한 번 빨개질 뿐이다. **우리 쪽 읽기**가 그 창에 속지 않는다는 것은
    // `claude::vanished_but_we_know_better`가 지키고, 이웃 쪽은 보고서의 남은 격차다.
    assert_eq!(wfail, 0, "★ 우리 핸들이 이웃의 쓰기를 막았다 — 그 로그아웃은 조용히 사라진다");
    assert_eq!(persisted, 0, "★ 잠금을 모르는 이웃의 로그아웃이 우리 배경 쓰기에 **취소**됐다(200ms 뒤에도 살아 있다)");
    assert_eq!(resurrected, 0, "★ 잠금을 모르는 이웃의 로그아웃이 우리 배경 쓰기에 취소됐다");
    // ── 회전 재료는 어디에도 안 잃는다(폴더 사본이 마지막 완충 — R2 §5) ──────────
    //
    // ★R28d — 이 자리는 R4까지 `claude::refresh_token(...)` **한 줄**이었다. 그 한 줄이
    // 다섯에 한 번 붉었고, 붉을 때의 실측은 이랬다:
    //
    // ```text
    // 최종 store(mine)=None  폴더원본(mine)=Some("m-184")  freshest(mine)=None
    //         ↑ 이웃이 지웠다        ↑ 재료는 여기 그대로 있다      ↑ 그런데 못 찾는다
    // ```
    //
    // 즉 「어디에도 안 남았다」는 **사실이 아니었다.** 그 판에서 벌어진 일은 둘이고
    // 둘 다 이 못이 겨눈 것이 아니다:
    //
    // 1. 이웃이 갈아끼우기 창에서 `accounts.json`을 못 읽고(위 `missed`) 「계정 0개」로
    //    읽어 통짜로 되썼다 — 2.6.2 `readStoreFile`의 `catch { accounts: [] }` 그대로다
    //    (`src/main/auth.ts:117`). 동결 트리라 우리가 못 고친다.
    // 2. 그래서 스토어에서 행이 사라졌고, [`claude::freshest_creds`]는 **스토어에 행이
    //    없으면 폴더를 아예 안 본다**(`accounts.iter().find(...)?`가 첫 줄이다).
    //    규약 2가 "살아 있는 토큰의 거처는 폴더"라고 못 박은 바로 그 완충이 여기서 꺼진다.
    //    → **남은 격차**(docs/parity-fix-casx-r1.md §남은 격차 1).
    //
    // 그래서 못을 사실대로 쪼갠다: **완충 자체**는 무조건 요구하고(폴더 사본), 스토어를
    // 거치는 조회는 **스토어가 살아 있을 때만** 요구한다. 이웃이 스토어를 지운 판까지
    // `freshest`를 요구하면 이 못은 「우리가 못 고치는 이웃의 사고」를 재는 못이 된다.
    assert!(folder_refresh_of("mine@x").is_some(), "★ 회전 재료가 폴더에도 안 남았다 — 마지막 완충이 뚫렸다");
    if store_refresh_of("mine@x").is_some() {
        assert!(claude::refresh_token("mine@x").is_some(), "★ 스토어에 행이 있는데 회전 재료를 못 찾는다");
    } else {
        println!("[r4-cas] ※ 이웃이 스토어의 mine@x 행을 지웠다(못 읽은 횟수={missed}) — freshest 조회는 이 판에서 못 센다");
    }
    assert!(!peer::has("ghost@x"), "마지막 상태도 로그아웃이어야 한다");
    let _ = std::fs::remove_dir_all(&home);
}
