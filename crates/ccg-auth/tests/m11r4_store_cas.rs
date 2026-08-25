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

/// ★R28d(CASX R2) — 배경 쓰기 한 바퀴의 **착지**.
///
/// R1까지 이 함수는 `bool`(= `both()`)이었고, 그래서 「폴더에만 남았다」와 「아무 데도 못
/// 남겼다」가 같은 `false`로 뭉개졌다. 확인 크리틱 R1이 잰 참사(배경 회전 1,143판 중
/// **마지막 880판 연속 실패**)는 그 뭉개진 값 안에 있었고, 못은 주행 **끝의 한 줄**로만
/// 그것을 봤다 — 그래서 2.5%짜리 제비뽑기가 됐다. 이제 착지를 셋으로 갈라 **매 판** 센다.
#[derive(Debug, PartialEq, Eq)]
enum Landing {
    /// 평시 — 폴더와 백업 둘 다.
    Both,
    /// 스토어 행이 없어 폴더 완충에만 남았다(규약 2의 그 완충이 실제로 일한 판).
    FolderOnly,
    /// ★ **회전 재료를 못 찾았다** — `freshest_creds`가 `None`. 이 값이 0이 아니면 그
    /// 계정은 그 순간 회전이 불가능하다(출구는 재로그인).
    NoMaterial,
    /// 재료는 찾았는데 어디에도 못 썼다(디스크·잠금 사고).
    NotStored,
}

/// 3.0의 배경 쓰기 한 바퀴(= 자동 전환 워커의 회전 정착).
fn rotate(email: &str, refresh: &str) -> Landing {
    let Some(base) = claude::freshest_creds(email) else { return Landing::NoMaterial };
    let Some(next) = claude::apply_refresh(&base, &format!("A-{refresh}"), Some(refresh), 3600.0, now_ms()) else {
        return Landing::NotStored;
    };
    let r = claude::persist_refreshed_report(email, &next);
    match (r.both(), r.folder.is_ok()) {
        (true, _) => Landing::Both,
        (false, true) => Landing::FolderOnly,
        (false, false) => Landing::NotStored,
    }
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
/// | # | 무엇이 무엇을 이겼나 | 사용자 피해 | 지금 상태 |
/// |---|---|---|---|
/// | ① | 갈아끼우는 동안 **파일이 없어 보였다**(ENOENT 6연속·7.2ms) | 이웃이 "계정 0개"로 읽고 그 위에 쓰면 **목록 전체 소멸** | ❌ **안 닫혔다** — 아래 「철회」 참고. 우리 쪽 읽기만 `vanished_but_we_know_better`가 막는다 |
/// | ② | 그 창에서 이웃의 `CREATE_ALWAYS`가 **새 파일**을 만들고 우리 갈아끼우기가 그걸 덮었다 | 묻힌 줄도 모른 채 로그아웃 취소가 **85ms 지속**(다음 이웃 쓰기까지) | ❌ **안 닫혔다**(①의 다른 얼굴) |
/// | ③ | 묻힌 것을 찾아 되살리는 동안 로그아웃한 계정이 파일에 앉아 있었다(실측 1.7~7.6ms) | 이웃이 자기 쓰기 1ms 뒤에 다시 읽으면 그걸 본다 | ✅ 창 안의 `eprintln` 제거 + 증인 핸들 물려주기(`open` 350µs 절약) |
///
/// ### ★R28d(CASX R2) — ①②의 「닫았다」는 **철회한다**
///
/// R1은 ①②를 "std `rename`이 지우고-옮기는 두 걸음으로 떨어지는 것"으로 진단하고
/// [`ccg_auth::replace`](POSIX 단일 호출)가 닫았다고 이 표에 적었다. **틀렸다.** 같은
/// 하네스로 네 판(옛 길/새 길 × 증인 보유/없음)을 18주행씩 번갈아 재니 그 창은 **옛 길에서
/// 더 컸다** = 이 OS에서 "이름 바꿔 덮기"의 성질이고 선존이다. 확인 크리틱 R1도 HEAD
/// 20주행 중 2주행에서 그대로 관측했다(아래 `missed`). R1 보고서 §2는 이미 철회했는데
/// 코드 주석 세 자리(여기 · `lib.rs` · `commit_locked`)가 아직 "닫았다"고 말하고 있었다.
/// [`ccg_auth::replace`]가 실제로 주는 것은 **되살리기 창의 속도**(③)다.
///
/// A/B(같은 부하·번갈아 20주행): **대조군 5/20 붉음 · 고친 판 0/20**.
/// 확인 크리틱 R1의 독립 재측: 대조군(옛 코드 + **새 못**) 2/20 · HEAD 0/20 ·
/// 되살아남 이벤트로 재면 대조군 40주행 4건 → HEAD 120주행 0건.
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
        let (mut ok, mut folder_only, mut no_material, mut not_stored) = (0usize, 0usize, 0usize, 0usize);
        while !s2.load(std::sync::atomic::Ordering::Relaxed) {
            match rotate("mine@x", &format!("m-{i}")) {
                Landing::Both => ok += 1,
                Landing::FolderOnly => folder_only += 1,
                Landing::NoMaterial => no_material += 1,
                Landing::NotStored => not_stored += 1,
            }
            i += 1;
            std::thread::sleep(std::time::Duration::from_millis(3));
        }
        (i, ok, folder_only, no_material, not_stored)
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
    let (rounds, ok, folder_only, no_material, not_stored) = writer.join().expect("배경 쓰기 스레드");
    let missed = peer::MISSED.load(std::sync::atomic::Ordering::Relaxed);
    let wfail = peer::WRITE_FAILED.load(std::sync::atomic::Ordering::Relaxed);
    println!("[r4-cas] 이웃 로그아웃 {ROUNDS}판 · 배경 회전 {rounds}판(성공 {ok}) — 로그아웃이 취소된 판={resurrected}(그중 지속={persisted})");
    println!("[r4-cas] 회전 착지: 양쪽={ok} · 폴더완충만={folder_only} · ★재료없음={no_material} · 저장실패={not_stored}");
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
    // 벌어진 일은 둘이다:
    //
    // 1. 이웃이 갈아끼우기 창에서 `accounts.json`을 못 읽고(위 `missed`) 「계정 0개」로
    //    읽어 통짜로 되썼다 — 2.6.2 `readStoreFile`의 `catch { accounts: [] }` 그대로다
    //    (`src/main/auth.ts:117`). 동결 트리라 **우리가 못 고친다.**
    // 2. 그래서 스토어에서 행이 사라졌고, [`claude::freshest_creds`]가 스토어에 행이 없으면
    //    폴더를 아예 안 봤다(`accounts.iter().find(...)?`가 첫 줄이었다).
    //
    // ★R28d(CASX R2) — R1은 여기서 **2를 못으로 재는 대신 단정을 조건부로 감았다.**
    // 확인 크리틱 R1이 그 대가를 쟀다: 이 착지의 비율은 대조군 1/40(🔴)에서 HEAD
    // 3/120(🟢 전부)으로 **한 톨도 안 줄었고**(2.5% → 2.5%) 경보만 꺼졌다. 그리고
    // 깜빡임이 아니었다 — 한 주행은 배경 회전 1,143판 중 **마지막 880판(77%)이 연속 실패**로
    // 끝났다. 제품어로는 계정 행이 목록에서 사라진 뒤 **폴더에 멀쩡히 앉아 있는 리프레시
    // 토큰에 제품이 도달할 길이 없어져 그 계정이 영원히 회전에 실패한다**(출구는 재로그인).
    //
    // 이제 2는 닫혔다([`claude::freshest_creds`]가 행이 없어도 폴더를 본다). 1은 여전히
    // 우리 밖이지만, **완충에 손이 닿는다**는 것이 이 못이 원래 재던 것이다 — 그래서
    // 단정을 **무조건으로 되돌린다.**
    // ★R28d(CASX R2) — **주행 끝의 한 줄이 아니라 매 판을 센다.** 아래 세 단정이 최종
    // 상태만 보던 R1의 눈을 판당 눈으로 바꾼다: 확인 크리틱이 잡은 참사(마지막 880판
    // 연속 실패)는 이제 `no_material=880`으로 **주행 중에** 드러난다.
    assert_eq!(
        no_material, 0,
        "★ 배경 회전이 {no_material}판에서 재료를 못 찾았다 — 폴더에 앉아 있는 리프레시 토큰에 제품이 못 닿는다(출구는 재로그인)"
    );
    assert!(ok + folder_only > 0, "★ 이 주행은 회전이 한 번도 정착 못 했다 — 하네스가 아무것도 안 잰 것이다");
    assert!(folder_refresh_of("mine@x").is_some(), "★ 회전 재료가 폴더에도 안 남았다 — 마지막 완충이 뚫렸다");
    assert!(
        claude::refresh_token("mine@x").is_some(),
        "★ 회전 재료가 폴더에 있는데 제품이 못 찾는다(store={:?} 폴더={:?}) — 그 계정은 영원히 회전에 실패한다",
        store_refresh_of("mine@x"),
        folder_refresh_of("mine@x")
    );
    if store_refresh_of("mine@x").is_none() || folder_only > 0 {
        println!(
            "[r4-cas] ※ 이웃이 스토어의 mine@x 행을 지웠다(못 읽은 횟수={missed} · 폴더완충만={folder_only}) — 완충으로 회전 재료는 살아 있다"
        );
    }
    assert!(!peer::has("ghost@x"), "마지막 상태도 로그아웃이어야 한다");
    let _ = std::fs::remove_dir_all(&home);
}

/// ★R28d(CASX R2) — **완충에 손이 닿는가.** 규약 2는 *"살아 있는 토큰의 거처는 계정
/// 폴더고 `credEnc`는 폴더 재생성용 백업"*이라고 못 박았는데, R1까지
/// [`claude::freshest_creds`]의 첫 줄은 `accounts.iter().find(...)?`였다 — 스토어 행이
/// 사라지면 폴더의 회전 재료가 **도달 불가**였고, 위 못은 그 착지를 확인 크리틱 R1의
/// 120주행 중 3주행에서 냈다(한 판은 배경 회전 1,143판 중 마지막 880판이 연속 실패).
///
/// 그 성질을 위 못은 **부하 안에서 우연히** 밟는다(그래서 R1이 단정을 감을 수 있었다).
/// 이 못은 같은 성질을 **결정적으로** 잰다. 세 판이고, 셋을 가르는 사실은 하나다 —
/// **로그아웃은 행과 폴더를 같이 지운다**(3.0 [`claude::remove_account`] · 2.6.2
/// `removeAccount` → `deleteAccountDir`, `src/main/auth.ts:176-183`).
///
/// | 판 | 스토어 행 | 계정 폴더 | 요구 |
/// |---|---|---|---|
/// | ① 행 유실(이웃의 오독 통짜 쓰기) | 없다 | **있다** | 회전 재료에 **도달한다** · 되쓰기도 계속 앉는다 · 행은 조용히 안 되살아난다 |
/// | ② 진짜 로그아웃 | 없다 | 없다 | `None` — 되살릴 것이 없다 |
/// | ③ 로그아웃 **뒤에 착지한** 회전 | 없다 | 없다 | 폴더를 **다시 파지 않는다**(①이 연 문의 뒷문 봉인) |
///
/// ③이 없으면 ①은 그 자체로 사고가 된다: 로그아웃 직후 비행 중이던 회전이 폴더를 다시
/// 파고 평문 refresh 토큰을 앉히면, ①의 문이 그것을 **다시 도달 가능하게** 만든다.
#[test]
fn the_folder_copy_stays_reachable_when_the_row_vanishes_but_never_after_a_logout() {
    let home = ccg_store::testhome::take("r4casx2");
    std::env::set_var("CCG_NO_NET", "1");

    // ── ① 이웃이 「계정 0개」로 오독하고 통짜로 되썼다(행만 사라진다) ──────────────
    seed("lost@x", "L-1");
    assert_eq!(rotate("lost@x", "L-2"), Landing::Both, "시드 회전이 양쪽에 정착해야 이 판의 전제가 선다");
    assert_eq!(folder_refresh_of("lost@x").as_deref(), Some("L-2"), "전제 — 폴더에 살아 있는 토큰이 앉았다");

    peer::write_raw(None, &[]); // ★ 폴더는 안 건드린다 = 이것은 로그아웃이 **아니다**
    assert!(!claude::is_registered("lost@x"), "전제 — 행이 사라졌다");
    assert_eq!(
        claude::refresh_token("lost@x").as_deref(),
        Some("L-2"),
        "★ 행이 사라졌다고 폴더의 회전 재료까지 못 찾으면 그 계정은 그 뒤로 영원히 회전에 실패한다(출구는 재로그인)"
    );

    // 그 재료로 회전이 계속 돈다 — 폴더 반쪽은 정착하고, 스토어 행은 **조용히 안 되살아난다**.
    let base = claude::freshest_creds("lost@x").expect("폴더 완충");
    let next = claude::apply_refresh(&base, "A-L-3", Some("L-3"), 3600.0, now_ms()).expect("회전 조립");
    let rep = claude::persist_refreshed_report("lost@x", &next);
    println!("[r4-casx2] ① 행 유실 뒤 되쓰기 = folder:{:?} unregistered={}", rep.folder, rep.unregistered);
    assert!(rep.folder.is_ok(), "★ 폴더가 멀쩡한데 되쓰기를 거절하면 마지막 완충이 낡아 죽는다: {:?}", rep.folder);
    assert!(rep.unregistered, "행이 없으니 백업 반쪽은 「저장 실패」가 아니라 「미등록」이다");
    assert_eq!(folder_refresh_of("lost@x").as_deref(), Some("L-3"), "★ 회전 결과가 폴더에 안 앉았다");
    assert!(!claude::is_registered("lost@x"), "★ 배경 회전이 스토어 행을 조용히 되살렸다(로그아웃 취소와 같은 방향)");

    // ── ② 진짜 로그아웃 — 행·폴더·건강 장부를 같이 지운다 ────────────────────────
    seed("bye@x", "B-1");
    assert_eq!(rotate("bye@x", "B-2"), Landing::Both, "전제 — 폴더가 물질화됐다");
    assert!(claude::account_dir("bye@x").exists(), "전제 — 폴더가 있다");
    claude::remove_account("bye@x");
    assert!(!claude::account_dir("bye@x").exists(), "전제 — 로그아웃은 폴더를 지운다(2.6.2·3.0 공통)");
    assert!(claude::freshest_creds("bye@x").is_none(), "★ 로그아웃했는데 크리덴셜이 읽힌다");
    assert!(claude::refresh_token("bye@x").is_none(), "★ 로그아웃한 계정의 회전 재료가 살아 있다 = 로그아웃이 안 된 것이다");

    // ── ③ 그 로그아웃 **뒤에** 비행 중이던 회전이 착지한다 ───────────────────────
    let stale = creds_of("bye@x", "B-3");
    let after = claude::persist_refreshed_report("bye@x", &stale);
    println!("[r4-casx2] ③ 로그아웃 뒤 착지 = folder:{:?} unregistered={}", after.folder, after.unregistered);
    assert!(after.folder.is_err(), "★ 로그아웃한 계정의 폴더를 배경 회전이 다시 팠다 — 평문 refresh 토큰이 되살아난다");
    assert!(!claude::account_dir("bye@x").exists(), "★ 로그아웃한 계정의 폴더가 되살아났다");
    assert!(after.unregistered, "그 착지는 「저장 실패」가 아니라 「사용자가 로그아웃했다」다(문구가 갈린다)");
    assert!(claude::freshest_creds("bye@x").is_none(), "★ 로그아웃 뒤 회전 재료가 다시 도달 가능해졌다");

    let _ = std::fs::remove_dir_all(&home);
}
