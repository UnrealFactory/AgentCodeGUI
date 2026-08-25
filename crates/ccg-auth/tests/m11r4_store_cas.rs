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

    pub fn path() -> std::path::PathBuf {
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

    /// 이웃이 쓰는 본문 한 벌(`writeStoreFile`의 `JSON.stringify(..., null, 2)`).
    pub fn body(default_email: Option<&str>, accounts: &[Value]) -> String {
        let mut root = serde_json::Map::new();
        root.insert("version".into(), json!(3));
        if let Some(d) = default_email {
            root.insert("defaultEmail".into(), json!(d));
        }
        root.insert("accounts".into(), Value::Array(accounts.to_vec()));
        serde_json::to_string_pretty(&Value::Object(root)).unwrap()
    }

    pub fn write_raw(default_email: Option<&str>, accounts: &[Value]) {
        // ★ 통짜 · 비원자 · 잠금 없음 — 2.6.2 `writeStoreFile`과 같다.
        trace("쓰기 시작", accounts);
        let r = std::fs::write(path(), body(default_email, accounts));
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
/// 로그아웃 직후 15ms를 1ms 간격으로 훑는다 — 그 순간의 파일이 곧 사용자가 보는 계정
/// 목록이다. 되살아남이 보이면 그것이 **깜빡임인가 취소인가**를 200ms까지 더 본다.
/// 단정하는 것은 취소(`persisted`)와 **침묵**(`silent`)이다(아래 단정 블록의 표).
///
/// ## ★R28d(CASX) — 이 못은 다섯에 한 번 붉었고, 그건 못이 아니라 **제품**이었다
///
/// 크리틱 실측 4/20(대조군도 동률 = 선존)을 R28d가 추적으로 갈랐다. 셋 다 제품 창이다.
///
/// | # | 무엇이 무엇을 이겼나 | 사용자 피해 | 지금 상태 |
/// |---|---|---|---|
/// | ① | 갈아끼우는 동안 **파일이 없어 보였다**(ENOENT 6연속·7.2ms) | 이웃이 "계정 0개"로 읽고 그 위에 쓰면 **목록 전체 소멸** | ❌ **안 닫혔다** — 아래 「철회」 참고. 우리 쪽 읽기만 `vanished_but_we_know_better`가 막는다 |
/// | ② | 그 창에서 이웃의 `CREATE_ALWAYS`가 **새 파일**을 만들고 우리 갈아끼우기가 그걸 덮었다 | 묻힌 줄도 모른 채 로그아웃 취소가 **85ms 지속**(다음 이웃 쓰기까지) | ❌ **기각**(R3) — 실측 유령 inode **0/23,083** · 이웃 열기 실패 0. 진짜 정체는 아래 ④ |
/// | ③ | 묻힌 것을 찾아 되살리는 동안 로그아웃한 계정이 파일에 앉아 있었다(실측 1.7~7.6ms) | 이웃이 자기 쓰기 1ms 뒤에 다시 읽으면 그걸 본다 | ✅ 창 안의 `eprintln` 제거 + 증인 핸들 물려주기(`open` 350µs 절약) |
/// | ④ | 이웃의 `CreateFile`이 **우리 `rename`과 첫 판독을 걸터탔다** — 옛 inode는 우리 눈에 "그대로"고 그들의 쓰기는 몇 ms 뒤에 그 이름 없는 inode로 떨어진다 | 로그아웃 취소가 **다음 이웃 쓰기까지 지속** · 우리 로그에는 **한 줄도 안 남는다** | ✅ **R3** — 커밋 뒤 자물쇠 밖 지연 감시(`claude::late_watch`)가 파내 되살리고 사연을 적는다 |
///
/// ### ★R28d(CASX R3) — ②를 기각하고 ④를 세운 근거(프로브 실측)
///
/// | 판정 | 판 |
/// |---|---|
/// | 첫 판독 = `expect` → 지름길 `Clean` | 1,010 |
/// | 그중 **뒤늦게** 옛 inode가 갈린 판 | **321 (31.8%)** |
/// | 그 321판 중 이웃의 열기가 우리 `rename` **뒤**였던 판 | **0** (전부 걸터탐) |
/// | 이웃이 **새 inode**를 만든 판(옛 가설 ②) | **0 / 23,083** |
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
/// 확인 크리틱 R2의 독립 재측: HEAD 140주행 **2붉음**(그중 지속 1) · **진단 0줄**(= §④).
#[test]
fn a_lock_unaware_neighbour_cannot_undo_a_logout() {
    // ★M11 R4(리드) — 홈 자물쇠는 ccg-store 공용(testhome). 한 바이너리 안의 병렬
    // 실행이 서로의 CCG_HOME을 갈아끼우던 자리다(critic_m11r3_attack.rs 주석 참고).
    let home = ccg_store::testhome::take("r4cas");
    std::env::set_var("CCG_NO_NET", "1");
    // 장부는 프로세스 전역이라 이 주행 것만 세려면 여기서 0으로 되돌린다.
    claude::bury_stats::reset();
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
    // ★R28d(CASX R3) — **되살아남마다 「제품이 그것을 봤나」를 같이 잰다.**
    //
    // 확인 크리틱 R2의 최대 격차는 되살아남 자체가 아니라 **그 판의 침묵**이었다
    // (붉은 주행에 되살리기·감시예산·복구 진단이 전부 0줄). 되살아남을 0으로 만드는 것과
    // "되살아났으면 제품 로그가 그 사실을 든다"는 **다른 요구**이고, 둘째가 더 근본이다 —
    // 첫째는 이 OS에서 0을 약속할 수 없지만(이웃의 열기가 우리 갈아끼우기를 걸터타는 창)
    // 둘째는 약속할 수 있다.
    let mut silent = 0usize;
    // 되살아남이 **몇 ms 만에 걷혔나**(= 우리 되살리기가 얼마나 늦었나)의 최악값.
    let mut worst_flicker_ms = 0usize;
    // "제품이 봤다"의 기준은 **로그아웃을 되살린 판**(자물쇠 안/밖) + 묻은 줄은 알고 원문을
    // 못 읽은 판 + 마지막 성공본으로 읽은 판이다. 그들의 *편집*을 묻은 판(`late_kept`)은
    // 무게가 달라 안 센다.
    //
    // ★ `recovered`를 넣는 이유(이걸 빼면 못이 **거짓으로** 붉는다): 되살아남의 출처는 둘이다.
    // 하나는 우리 갈아끼우기가 그들의 쓰기를 묻은 것이고, 다른 하나는 그들이 갈아끼우기 창에서
    // 파일을 못 읽고 반쪽을 남긴 뒤 우리가 그 반쪽을 `.bak`으로 복구한 것이다(복구본에는 그들이
    // 방금 지운 계정이 아직 있다). 둘째도 **침묵이 아니다** — `recover_store`가 사실을 한 줄
    // 적는다. 못이 재는 것은 "되살아남에 이름이 붙었나"이지 "어느 문으로 들어왔나"가 아니다.
    let repaired_or_unread =
        || claude::bury_stats::repaired() + claude::bury_stats::unread() + claude::bury_stats::recovered();
    for _ in 0..ROUNDS {
        peer::login("ghost@x");
        std::thread::sleep(std::time::Duration::from_millis(3));
        let seen_before = repaired_or_unread();
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
                // 다르니 따로 센다 — 단정하는 것은 **취소**(아래 `persisted`)다.
                let mut gone_at = None;
                for k in 0..40 {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                    if !peer::has("ghost@x") {
                        gone_at = Some((k + 1) * 5);
                        break;
                    }
                }
                // ★R28d(CASX R3) — 이 판을 **제품이 봤나.** 「봤다」는 자물쇠 안에서 파냈거나
                // (`in_lock`) 커밋 뒤 지연 감시가 파냈거나(`late`) 최소한 묻은 줄은 알고
                // 원문을 못 읽었다(`unread`)는 것이다. 셋 다 안 움직였으면 그 되살아남은
                // **아무도 모르는 채로** 지나간 것이다 — 그게 R2가 잡은 그 침묵이다.
                let saw = repaired_or_unread() > seen_before;
                if !saw {
                    silent += 1;
                }
                match gone_at {
                    Some(ms) => {
                        worst_flicker_ms = worst_flicker_ms.max(ms);
                        println!("[r4-cas][DBG] 되살아남이 {ms}ms 뒤 사라짐(깜빡임) · 제품이 봤나={saw}");
                    }
                    None => {
                        persisted += 1;
                        println!("[r4-cas][DBG] ★되살아남이 200ms 뒤에도 살아 있다 — 로그아웃 취소 · 제품이 봤나={saw}");
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
    println!(
        "[r4-cas] 이웃 로그아웃 {ROUNDS}판 · 배경 회전 {rounds}판(성공 {ok}) — 되살아난 판={resurrected}(★지속={persisted} · ★침묵={silent} · 최악 깜빡임={worst_flicker_ms}ms)"
    );
    println!(
        "[r4-cas] 우리가 이웃의 쓰기를 묻은 것을 본 판: 자물쇠안={}(되살림 {}) · 지연감시={} · 되살릴것없음={} · 못읽음={} · 못지켜봄={} · 복구본읽기={}",
        claude::bury_stats::in_lock(),
        claude::bury_stats::in_lock_revived(),
        claude::bury_stats::late(),
        claude::bury_stats::late_kept(),
        claude::bury_stats::unread(),
        claude::bury_stats::dropped(),
        claude::bury_stats::recovered()
    );
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
    // ── ★R28d(CASX R3) — 이 못이 **무엇을 단정하고 무엇을 세기만 하는가** ──────────
    //
    // R2까지 이 자리의 단정은 `resurrected == 0`이었다. 확인 크리틱 R2가 그 단정으로
    // HEAD를 140주행 돌려 **2붉음**(하나는 200ms 뒤에도 살아 있는 진짜 취소)을 냈고,
    // 무엇보다 그 판들에 **진단이 한 줄도 안 남았다**. R3이 그 침묵의 정체를 못 박았다
    // (모듈 주석의 걸터탄 열기 · 실측 321/1,010). 이제 갈라 적는다:
    //
    // | 값 | 무엇인가 | 단정 |
    // |---|---|---|
    // | `persisted` | 200ms 뒤에도 살아 있다 = **사용자의 로그아웃이 취소됐다** | **0** |
    // | `silent` | 되살아났는데 제품이 그것을 **못 봤다** | **0** |
    // | `resurrected` | 그들의 쓰기가 묻혔다가 우리가 되살릴 때까지의 **깜빡임** | 센다 · 안 단정한다 |
    //
    // 셋째를 안 단정하는 이유는 R1의 "못이 감은 눈"과 **반대**다. 그때는 못이 재던 성질을
    // 통째로 껐지만, 여기서는 같은 사고를 **더 센 단정 둘**로 바꿔 잡는다: 깜빡임의 폭은
    // 「그들의 쓰기가 도착한 순간 → 우리 되살리기가 착지한 순간」이고, 그 사이 시간은
    // 부하에 비례한다(실측: 6레인 + 릴리스빌드 부하에서 최악 20ms · 순차 20주행에서는 0건).
    // 이 OS에서 그 폭 0은 약속할 수 없다 — 우리 `sleep(250µs)`조차 부하가 걸리면 ms 단위로
    // 늘어난다. 약속할 수 있는 것은 **취소하지 않는다**와 **조용히 지나가지 않는다**이고,
    // 그 둘이 사용자가 겪는 사고(지운 계정이 credEnc째 돌아와 앉아 있다)의 정의다.
    // 깜빡임 수치는 위 줄에 그대로 찍히므로 다음 크리틱이 회귀를 잴 수 있다.
    assert_eq!(
        silent, 0,
        "★ 로그아웃이 되살아났는데 제품이 그것을 본 흔적이 0이다(침묵) — 로그가 이 사고를 안 들면 다음 사람이 같은 자리를 다시 판다"
    );
    assert_eq!(persisted, 0, "★ 잠금을 모르는 이웃의 로그아웃이 우리 배경 쓰기에 **취소**됐다(200ms 뒤에도 살아 있다)");
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
    //
    // ★R28d(CASX R3) — 다만 이 단정이 초록인 것의 뜻을 정확히 적어 둔다(확인 크리틱 R2 §5).
    // 이 값이 오르려면 **행 소멸 착지**(이웃이 「계정 0개」로 오독하고 통짜로 되쓰는 판)를
    // 지나야 하는데, 그 착지는 부하 프로파일에 따라 한 주행도 안 지날 수 있다 —
    // 크리틱 실측 **0/140주행**(`폴더완충만>0` 0주행), 이 라운드 실측도 순차 20주행 0건이다.
    // 그래서 여기서 초록인 것은 대개 **"그 착지를 안 지났다"**는 뜻이고
    // "그 착지를 지나도 안전하다"는 뜻이 아니다. 후자를 재는 것은 결정적 못
    // [`the_folder_copy_stays_reachable_when_the_row_vanishes_but_never_after_a_logout`]이고,
    // 아래 한 줄은 그 착지를 이 주행이 지났는지를 로그로 남긴다.
    println!(
        "[r4-cas] 행 소멸 착지를 지났나: 폴더완충만={folder_only} · 재료없음={no_material} (0이면 이 주행은 그 착지를 안 지났다)"
    );
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

/// ★R28d(CASX R3) — **커밋 뒤에 도착하는 이웃의 로그아웃도 잃지 않는다.**
///
/// 확인 크리틱 R2의 최대 격차는 되살아남 자체가 아니라 그 판의 **침묵**이었다: HEAD 140주행
/// 2붉음(하나는 200ms 뒤에도 살아 있는 진짜 취소)인데 되살리기·감시예산·복구 진단이 **전부
/// 0줄**. R3 프로브가 정체를 못 박았다 — R2까지 CAS가 딛고 선 문장
/// *"이웃의 `writeFileSync`는 여는 순간 파일을 자르므로 우리 갈아끼우기 전에 연 이웃이
/// 있었다면 첫 판독이 반드시 다르다"*가 **거짓**이다:
///
/// | 프로브 | 판 |
/// |---|---|
/// | 첫 판독 = `expect` → 지름길 `Clean` | 1,010 |
/// | 그중 **뒤늦게** 옛 inode가 갈린 판 | **321 (31.8%)** — 전부 「열기 ≤ 우리 rename」 |
/// | 「이름이 비어 이웃이 새 파일을 만든다」(옛 가설 ②) | **0 / 23,083** |
///
/// 이 못은 그 걸터탐을 부하가 아니라 **결정적으로** 세운다: 이웃의 열기를 테스트가 손에
/// 들고 있으면 `CreateFile`이 우리 `rename`을 걸터탄 상태가 정확히 재현된다.
#[test]
fn a_neighbour_logout_that_lands_after_our_swap_is_revived() {
    let home = ccg_store::testhome::take("r4casx3");
    std::env::set_var("CCG_NO_NET", "1");
    claude::bury_stats::reset();
    seed("mine@x", "m-1");
    peer::login("ghost@x");
    assert!(peer::has("ghost@x"), "전제 — 이웃이 계정을 하나 더 넣었다");

    // 이웃이 로그아웃하며 쓸 본문(그들의 스냅샷 = 지금 목록에서 ghost만 뺀 것).
    let (def, accounts) = peer::read_raw();
    let kept: Vec<Value> = accounts.iter().filter(|a| claude::email_of(a) != Some("ghost@x")).cloned().collect();
    let logout_body = peer::body(def.as_deref(), &kept);

    // ★ 걸터탄 열기 — `CreateFile`은 끝났고(이름은 지금 이 inode를 가리킨다) 자르기·쓰기는
    //   아직이다. 실 2.6.2에서 이 상태는 µs~ms짜리 창이고, 여기서는 손으로 붙잡는다.
    let mut held = std::fs::OpenOptions::new().write(true).open(peer::path()).expect("이웃의 열기");

    // 우리 배경 회전 한 바퀴 — 이 갈아끼우기가 저 핸들의 inode에서 **이름을 뗀다**.
    assert_eq!(rotate("mine@x", "m-2"), Landing::Both, "전제 — 회전이 양쪽에 정착했다");
    assert!(peer::has("ghost@x"), "전제 — 우리 쓰기는 목록을 안 건드린다(ghost는 아직 있다)");

    // 이제 그들의 통짜 쓰기가 도착한다 — 이름 없는 옛 inode로 간다(= 우리가 묻었다).
    {
        use std::io::{Seek, Write};
        held.set_len(0).expect("자르기");
        held.seek(std::io::SeekFrom::Start(0)).expect("되감기");
        held.write_all(logout_body.as_bytes()).expect("이웃의 통짜 쓰기");
        drop(held);
    }

    // 요구: 자물쇠 밖 지연 감시가 그 원문을 파내 **로그아웃을 되살린다.**
    let mut gone_at = None;
    for k in 0..400 {
        std::thread::sleep(std::time::Duration::from_millis(5));
        if !peer::has("ghost@x") {
            gone_at = Some((k + 1) * 5);
            break;
        }
    }
    println!(
        "[r4-casx3] 되살리기 = {gone_at:?}ms · 장부(자물쇠안={} 지연={} 되살릴것없음={} 못읽음={})",
        claude::bury_stats::in_lock(),
        claude::bury_stats::late(),
        claude::bury_stats::late_kept(),
        claude::bury_stats::unread()
    );
    assert!(
        gone_at.is_some(),
        "★ 커밋 뒤에 도착한 이웃의 로그아웃을 우리 갈아끼우기가 묻은 채로 뒀다 — 사용자가 지운 계정이 credEnc째 돌아와 앉아 있다"
    );
    assert!(claude::bury_stats::late() >= 1, "★ 되살리긴 했는데 장부에 안 남았다(로그가 이 사고를 못 든다)");
    assert!(claude::is_registered("mine@x"), "★ 되살리기가 이웃이 지우지 **않은** 계정까지 지웠다");
    assert_eq!(
        store_refresh_of("mine@x").as_deref(),
        Some("m-2"),
        "★ 되살리기가 방금 정착한 회전 결과를 되돌렸다(옛 credEnc로 돌아갔다)"
    );
    let _ = std::fs::remove_dir_all(&home);
}

/// ★R28d(CASX R3) — **살아 있는 계정을 「사용자가 로그아웃했다」고 말하지 않는다.**
///
/// R2가 [`claude::persist_refreshed_report`]의 `unregistered`에 폴더 반쪽을 OR로 붙였다.
/// 그 절의 원래 목적 방향 검출력은 0이고(폴더 `NotRegistered` ⊆ 백업 `NotRegistered`),
/// 대신 **반대 방향 오답**을 열었다 — 그때 두 반쪽의 **읽기 강도가 달랐기** 때문이다
/// (폴더 가드는 자물쇠 밖 무복구 단발 읽기, 백업 반쪽은 자물쇠 안 재시도 + `.bak` 복구).
///
/// 확인 크리틱 R2 §7의 결정적 재현을 그대로 못으로 박는다: `accounts.json`만 사라진 판에서
/// 백업 반쪽은 `.bak`으로 계정을 되살려 회전 결과를 `credEnc`에 앉히는데, R2의 보고서는
/// 그 계정을 「미등록」이라 말했다. 그 값은 `net.rs`에서 `NoToken`이 되고
/// `acct_switch::transient()`가 **계정 탓**으로 분류해 멀쩡한 계정이 자동 전환에서 빠진다.
///
/// 이 못은 이제 **둘을 같이** 잰다. `unregistered`가 자물쇠 안 반쪽 하나에만 매달리는 것과,
/// [`claude::is_registered`]가 그 반쪽과 **같은 강도로** 읽는 것(`read_store_settled`).
/// 강도가 올라간 결과 폴더 반쪽도 이 판에서 성공한다 — 살아 있는 계정이니 그게 맞다.
#[test]
fn a_backup_recovered_account_is_never_called_logged_out() {
    let home = ccg_store::testhome::take("r4casx3b");
    std::env::set_var("CCG_NO_NET", "1");
    seed("live@x", "L-1");
    assert!(ccg_store::app_home().join("accounts.json.bak").is_file(), "전제 — 마지막 성공본이 있다");

    // 행이 파일째 사라졌다(갈아끼우기 창의 오독 · 수동 삭제 · 지원 절차). 로그아웃이 **아니다**.
    std::fs::remove_file(peer::path()).expect("accounts.json 삭제");
    assert!(!claude::account_dir("live@x").exists(), "전제 — 폴더는 아직 안 팠다");
    // ★ 조회도 편집과 같은 강도로 읽는다 — 이 줄이 R3에서 뒤집혔다(전에는 「없다」였다).
    assert!(
        claude::is_registered("live@x"),
        "★ 살아 있는 계정을 조회가 「없다」고 본다 — 그 답으로 회전이 폴더를 안 파고 격리 표식이 풀린다"
    );

    let rep = claude::persist_refreshed_report("live@x", &creds_of("live@x", "L-2"));
    println!("[r4-casx3b] 착지 = folder:{:?} backup:{:?} unregistered={} landed={}", rep.folder, rep.backup, rep.unregistered, rep.landed());
    assert!(rep.backup.is_ok(), "전제 — .bak 복구가 백업 반쪽을 살린다");
    assert!(claude::is_registered("live@x"), "전제 — 그 계정은 목록에 살아 있다");
    assert!(
        !rep.unregistered,
        "★ 살아 있는 계정을 「사용자가 로그아웃했다」고 말했다 — 그 값이 NoToken이 되어 멀쩡한 계정이 자동 전환에서 빠진다"
    );
    assert!(rep.folder.is_ok(), "★ 살아 있는 계정의 폴더 되쓰기를 거절했다 — 마지막 완충이 낡아 죽는다: {:?}", rep.folder);
    let _ = std::fs::remove_dir_all(&home);
}

/// ★R28d(CASX R3) — **이웃이 쓰는 도중에 읽어도 회전 재료를 잃지 않는다.**
///
/// 확인 크리틱(dde4b34)의 부하 조건을 그대로 재서 대조군(현재 HEAD)이 낸 붉음 셋 중 하나가
/// 이 자리였다: `★재료없음=1`(배경 회전 699판 중 1판). 되살아남과는 다른 문이고, 정체는
/// **조회 경로의 읽기가 편집 경로보다 약한 것**이다 —
/// 잠금을 모르는 이웃의 `writeFileSync`는 원자적이 아니라서 그 도중에 읽으면 반쪽이 오고,
/// [`claude::freshest_creds`]는 그 반쪽의 빈 `accounts`를 **「계정 0개」로** 읽었다.
///
/// 그 판의 사용자 피해: 배경 회전이 "재료를 못 찾았다"로 끝난다(문구는 "재로그인이
/// 필요할 수 있습니다"). 폴더 사본이 아직 없는 계정 — 2.6.2에서 `credEnc`만 넘어왔거나
/// 로그인 직후 — 에서는 완충도 없어 그대로 실패다.
///
/// 여기서는 그 반쪽을 **결정적으로** 만든다(하네스가 손으로 반쪽 JSON을 남긴다).
#[test]
fn a_torn_neighbour_write_never_hides_the_rotation_material() {
    let home = ccg_store::testhome::take("r4casx3c");
    std::env::set_var("CCG_NO_NET", "1");
    claude::bury_stats::reset();
    seed("keep@x", "K-1");
    seed("live@x", "T-1");
    assert!(claude::freshest_creds("live@x").is_some(), "전제 — 평시에는 재료가 보인다");
    assert!(!claude::account_dir("live@x").exists(), "전제 — 폴더 완충은 아직 없다(스토어가 유일한 거처)");

    // 이웃의 통짜 쓰기 **도중**의 파일 — 열면서 자르고 절반만 썼다.
    let full = std::fs::read_to_string(peer::path()).expect("스토어 원문");
    let torn = full[..full.len() / 2].to_string();
    let lay_torn = || {
        std::fs::write(peer::path(), &torn).expect("반쪽 쓰기");
        assert!(serde_json::from_str::<Value>(&torn).is_err(), "전제 — 지금 파일은 반쪽이라 JSON이 아니다");
    };
    lay_torn();

    // 요구: 「0개」가 아니라 「모른다」로 읽고, 마지막 성공본에서 재료를 찾는다.
    assert_eq!(
        claude::refresh_token("live@x").as_deref(),
        Some("T-1"),
        "★ 이웃이 쓰는 도중에 읽었다고 회전 재료를 못 찾으면 그 판의 회전이 죽는다(사용자에게는 「재로그인」)"
    );
    assert!(
        claude::is_registered("live@x"),
        "★ 반쪽 한 장이 살아 있는 계정을 「로그아웃됐다」로 만든다 — 폴더를 안 파고 격리 표식이 풀린다"
    );
    // 그리고 그 판정이 **조용하지 않다** — 복구 한 줄이 장부에도 남는다.
    assert!(claude::bury_stats::recovered() >= 1, "★ 마지막 성공본으로 읽고도 그 사실이 아무 데도 안 남았다");

    // ── 뒷문 — 진짜 로그아웃은 이 문으로 **안 되살아난다**(`.bak`이 로그아웃을 이미 안다) ──
    std::fs::write(peer::path(), &full).expect("파일 되돌리기(성한 원문)");
    claude::remove_account("live@x");
    assert!(!claude::account_dir("live@x").exists(), "전제 — 로그아웃은 폴더도 지운다");
    lay_torn();
    assert!(
        claude::freshest_creds("live@x").is_none(),
        "★ 반쪽 한 장이 로그아웃한 계정의 회전 재료를 되살렸다 — 이 문의 뒷문이 열려 있다"
    );
    assert!(
        claude::is_registered("keep@x"),
        "★ 뒷문을 막느라 남은 계정까지 안 보이면 그건 문을 닫은 게 아니라 벽을 세운 것이다"
    );
    let _ = std::fs::remove_dir_all(&home);
}
