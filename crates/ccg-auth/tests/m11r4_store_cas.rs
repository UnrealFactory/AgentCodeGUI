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

/// 계정 행 한 벌(`accounts.json`의 원소).
fn row_of(email: &str, refresh: &str) -> Value {
    let snap = json!({ "creds": creds_of(email, refresh), "account": { "emailAddress": email } });
    let enc = ccg_store::safe_storage::encrypt(&snap.to_string()).expect("safeStorage");
    json!({ "email": email, "credEnc": enc, "subscriptionType": "max" })
}

fn seed(email: &str, refresh: &str) {
    let mut accounts: Vec<Value> = claude::read_store_file().accounts.clone();
    accounts.retain(|a| claude::email_of(a) != Some(email));
    accounts.push(row_of(email, refresh));
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
/// | ① | 갈아끼우는 동안 **파일이 없어 보였다**(ENOENT 6연속·7.2ms) | 이웃이 "계정 0개"로 읽고 그 위에 쓰면 **목록 전체 소멸** | ⚠️ **우리 쪽만 닫혔다** — 이웃의 오독 자체는 동결 트리라 못 고친다. R4가 닫은 것은 **우리가 그것을 대신 실행하지 않는다**까지다(★R28e부터 `ccg_auth::ledger::attribute` — R4의 `buried_removals`(개수 규칙)는 진짜 로그아웃까지 죽여서 걷어냈다 · 결정적 못 [`a_mis_read_whole_write_never_takes_the_whole_account_list_with_it`]). 우리 쪽 읽기는 `vanished_but_we_know_better`가 막는다 |
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
    //
    // ★R28d(CASX R4) — 여기에 `gave_up`·`refused`가 들어온다. 규칙은 하나다:
    // **한 건마다 한 줄이 찍히는 판만 「봤다」에 넣는다.** 둘 다 그렇다(각각
    // "…{REVIVE_RETRY_MS}ms 동안 자리에 없었다" · "…로그아웃 하나로는 못 만드는 상태다").
    // 반대로 `dropped`(감시 자리 부족)는 **안 넣는다** — 그 자리는 아예 안 본 자리라
    // 매장이 있었는지조차 모른다(`claude::bury_stats::dropped` 주석).
    let repaired_or_unread = || {
        claude::bury_stats::repaired()
            + claude::bury_stats::unread()
            + claude::bury_stats::recovered()
            + claude::bury_stats::gave_up()
            + claude::bury_stats::refused()
    };
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
    // ★R28d(CASX R4) — 이 라운드가 새로 세운 겹의 장부. 앞의 줄이 「무엇을 봤나」라면
    // 이 줄은 「보고 무엇을 안 했나」다(확인 크리틱 R3의 §3-1·§3-2·§3-3이 각각 여기 온다).
    // ★R28f — `못가름`을 같이 낸다. 부하에서 이 수가 0이 아니면 동률 세대의 새 가름이
    // 실제로 일한 것이고, 그만큼의 판이 「지우는 쪽」으로 골라진 것이다(로그에 사유 한 줄씩).
    println!(
        "[r4-cas] 이 라운드가 세운 겹: 세대증표로 안지움={} · ★못가름={} · 끝내못앉힘={} · 근거못짚음={} · 예산까지보고접음={}",
        claude::bury_stats::moved_on(),
        claude::bury_stats::unsure(),
        claude::bury_stats::gave_up(),
        claude::bury_stats::refused(),
        claude::bury_stats::watched_out()
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
    // ── ★R28d(CASX R4) — 셋째 값에도 **회귀 예산**을 박는다 ────────────────────
    //
    // 확인 크리틱 R3 §3-4의 요구다. R3이 단정을 `resurrected == 0`에서 내리면서 그 값이
    // 조용히 3.1배가 됐고(변수 하나짜리 A/B: 회전 1,000판당 0.80 대 0.26), 로그에만 남아서
    // 다음 사람이 A/B를 새로 짜야 알 수 있었다. 이제 못이 직접 든다.
    //
    // 값이 `0`이 아니라 예산인 이유는 위 표에 적은 그대로다 — 이 OS에서 깜빡임 0은 약속할
    // 수 없다(이웃의 열기가 우리 갈아끼우기를 걸터타는 창 · 실측 31.6%). 약속할 수 있는
    // 것은 **그 폭이 이 크기를 안 넘는다**이고, 크기는 실측에서 왔다: 이 라운드의 부하
    // 40주행(단독 20 + 병렬 20)에서 한 주행 최대 되살아남은 아래 로그에 찍힌다.
    // 예산은 로그아웃 판수의 **10%**로, 관측 최악값의 여러 배를 남긴다 — 예산이 하는
    // 일은 "다섯에 한 번 붉게 하는 것"이 아니라 **3배가 조용히 지나가지 않게 하는 것**이다.
    let budget = ROUNDS / 10;
    println!("[r4-cas] 깜빡임 회귀 예산: 되살아남 {resurrected} / 예산 {budget}(로그아웃 {ROUNDS}판의 10%)");
    assert!(
        resurrected <= budget,
        "★ 되살아남이 회귀 예산을 넘었다({resurrected} > {budget}) — 취소는 아니지만 사용자가 지운 계정이 그만큼 자주 파일에 돌아와 앉았다는 뜻이다"
    );
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

/// **걸터탄 열기**를 손에 든 채 우리 회전을 한 바퀴 돌린다 — 즉 이웃의 `CreateFile`은
/// 끝났고(이름은 지금 이 inode를 가리킨다) 자르기·쓰기는 아직인 그 창을, 우리 `rename`이
/// 통과하게 만든다. 돌려주는 핸들에 나중에 쓰면 그 쓰기는 **이름 없는 옛 inode**로 간다
/// (= 우리가 묻었다). 아래 세 못이 이 상태를 공유한다.
fn straddling_open(logout_of: &str) -> (std::fs::File, String) {
    straddling_open_many(&[logout_of])
}

/// 같은 상태를 **여럿 로그아웃한 한 벌 쓰기**로 만든다(확인 크리틱 R4 §3-2의 곁가지 P2).
fn straddling_open_many(logout_of: &[&str]) -> (std::fs::File, String) {
    let (def, accounts) = peer::read_raw();
    let kept: Vec<Value> = accounts.iter().filter(|a| claude::email_of(a).is_none_or(|e| !logout_of.contains(&e))).cloned().collect();
    let body = peer::body(def.as_deref(), &kept);
    let held = std::fs::OpenOptions::new().write(true).open(peer::path()).expect("이웃의 열기");
    (held, body)
}

/// 걸터탄 핸들로 통짜 쓰기를 마친다(2.6.2 `writeFileSync`의 자르기 + 쓰기).
fn land_whole_write(mut held: std::fs::File, body: &str) {
    use std::io::{Seek, Write};
    held.set_len(0).expect("자르기");
    held.seek(std::io::SeekFrom::Start(0)).expect("되감기");
    held.write_all(body.as_bytes()).expect("이웃의 통짜 쓰기");
    drop(held);
}

/// ★R28d(CASX R4) — **자물쇠 밖 되살리기는 커밋 뒤에 생긴 로그인을 안 지운다.**
///
/// 확인 크리틱 R3 §3-1(치명 · 결정적 재현)이 연 문이다. R3의 `late_revive`는 *커밋 시점의*
/// 스냅샷으로 계산한 삭제 목록을 **최대 107ms 뒤의 디스크**에 이메일로 적용했다. 자물쇠 안
/// `Commit::Buried`는 `expect` CAS로 묶여 이 사고가 구조적으로 불가능한데 자물쇠 밖에는
/// 그 묶음이 없었다 — 그래서 크리틱의 재현에서 커밋 14,713µs 뒤에 **방금 끝난 로그인이
/// `credEnc`째 지워졌고**, 제품 로그는 "이웃의 로그아웃을 되살렸다"고 정반대를 적었다.
///
/// 이 못은 그 순서를 손으로 세운다: 걸터탄 열기 → 우리 회전 커밋 → **같은 이메일 재로그인**
/// → 그제서야 옛 로그아웃 본문이 이름 없는 옛 inode로 착지. 요구는 둘이다.
///
/// 1. 그 새 행은 **살아남는다**(사용자가 겪는 값).
/// 2. 세대 증표가 **일했다는 사실**이 장부에 남는다(`moved_on`) — 침묵으로 지나가면
///    다음 사람은 "안 지웠다"와 "지울 것이 없었다"를 못 가른다.
#[test]
fn a_late_revive_never_deletes_a_login_that_landed_after_our_commit() {
    let home = ccg_store::testhome::take("r4casx4a");
    std::env::set_var("CCG_NO_NET", "1");
    claude::bury_stats::reset();
    seed("mine@x", "m-1");
    peer::login("ghost@x");
    assert!(peer::has("ghost@x"), "전제 — 이웃이 계정을 하나 더 넣었다");

    let (held, logout_body) = straddling_open("ghost@x");
    assert_eq!(rotate("mine@x", "m-2"), Landing::Both, "전제 — 회전이 양쪽에 정착했다(= 옛 inode에서 이름이 떨어졌다)");

    // ★ 사용자가 ghost@x로 **다시 로그인**한다 — 새 `credEnc`가 얹힌다.
    let snap = json!({ "creds": creds_of("ghost@x", "g-NEW"), "account": { "emailAddress": "ghost@x" } });
    let enc = ccg_store::safe_storage::encrypt(&snap.to_string()).expect("safeStorage");
    let fresh = json!({ "email": "ghost@x", "credEnc": enc, "subscriptionType": "max" });
    claude::update_store(|f| {
        f.accounts.retain(|a| claude::email_of(a) != Some("ghost@x"));
        f.accounts.push(fresh.clone());
    })
    .expect("재로그인 저장");
    assert!(peer::has("ghost@x"), "전제 — 재로그인이 앉았다");

    // 이제 **옛** 로그아웃 본문이 도착한다(그들의 스냅샷은 재로그인 이전 것이다).
    land_whole_write(held, &logout_body);

    // 지연 감시 예산을 넉넉히 넘겨 기다린다 — 지울 거라면 이 안에 지운다.
    std::thread::sleep(std::time::Duration::from_millis(800));
    println!(
        "[r4-casx4a] ghost 살아있나={} · 장부(지연={} 세대증표로안지움={} 되살릴것없음={})",
        peer::has("ghost@x"),
        claude::bury_stats::late(),
        claude::bury_stats::moved_on(),
        claude::bury_stats::late_kept()
    );
    assert!(
        peer::has("ghost@x"),
        "★ 커밋 뒤에 들어온 로그인을 자물쇠 밖 되살리기가 지웠다 — 사용자에게는 「로그인했는데 곧 계정이 사라졌다」이고 로그는 「로그아웃을 되살렸다」고 정반대를 적는다"
    );
    let (_, accounts) = peer::read_raw();
    assert!(
        accounts.iter().any(|a| a == &fresh),
        "★ 행은 남았는데 내용이 옛 credEnc로 돌아갔다 — 그건 로그인을 지운 것과 같다"
    );
    assert!(
        claude::bury_stats::moved_on() >= 1,
        "★ 되살리기가 그 행을 안 지운 것이 세대 증표 때문인지 「지울 것이 없어서」인지 장부로 못 가른다(증표가 한 번도 안 걸렸다)"
    );
    assert!(claude::is_registered("mine@x"), "★ 되살리기가 이웃이 지우지 **않은** 계정까지 지웠다");
    let _ = std::fs::remove_dir_all(&home);
}

/// ★R28d(CASX R4) — **파낸 로그아웃을 「지나가는 창」에 안 버린다.**
///
/// 확인 크리틱 R3 §3-2(높음 · 결정적 재현)가 연 문이다. R3는 `!dst.is_file()`이면 재시도도
/// `eprintln`도 없이 **영구히** 접었고(그 자리는 `late_watch_tick`이 이미 `true`를 돌려줘
/// 큐에서 빠진다 = 다시 안 본다), 그 창은 이 갈래가 스스로 실측해 표에 적어 둔 갈아끼우기
/// 창이다(ENOENT 6연속 · **7.2ms** — `ccg_auth::replace` 모듈 주석).
///
/// 여기서는 그 창을 손으로 만든다 — `accounts.json`을 잠깐 딴 이름으로 치웠다가 되돌린다.
/// 요구: 그 창이 지나가면 **되살리기가 다시 와서 앉는다**(포기가 아니라 재시도).
#[test]
fn a_dug_up_logout_is_retried_through_the_window_where_the_store_file_is_missing() {
    let home = ccg_store::testhome::take("r4casx4b");
    std::env::set_var("CCG_NO_NET", "1");
    claude::bury_stats::reset();
    seed("mine@x", "m-1");
    peer::login("ghost@x");

    let (held, logout_body) = straddling_open("ghost@x");
    assert_eq!(rotate("mine@x", "m-2"), Landing::Both, "전제 — 회전이 양쪽에 정착했다");

    // ★ 갈아끼우기 창의 결정적 재현 — 파일이 **잠깐 없다**.
    let hidden = ccg_store::app_home().join("accounts.json.gone");
    std::fs::rename(peer::path(), &hidden).expect("스토어 치우기");
    land_whole_write(held, &logout_body);
    // 감시가 그 원문을 파내고 「지금은 못 앉힌다」로 접어야 하는 시간(실측 창의 8배).
    std::thread::sleep(std::time::Duration::from_millis(60));
    assert!(claude::bury_stats::late() >= 1, "전제 — 이 사이에 감시가 로그아웃을 파냈어야 한다");
    assert_eq!(claude::bury_stats::gave_up(), 0, "★ 창이 아직 안 지났는데 벌써 접었다");
    std::fs::rename(&hidden, peer::path()).expect("스토어 되돌리기");

    let mut gone_at = None;
    for k in 0..80 {
        std::thread::sleep(std::time::Duration::from_millis(5));
        if !peer::has("ghost@x") {
            gone_at = Some((k + 1) * 5);
            break;
        }
    }
    println!(
        "[r4-casx4b] 창이 지난 뒤 되살리기 = {gone_at:?}ms · 장부(지연={} 끝내못앉힘={} 세대증표={})",
        claude::bury_stats::late(),
        claude::bury_stats::gave_up(),
        claude::bury_stats::moved_on()
    );
    assert!(
        gone_at.is_some(),
        "★ 파낸 로그아웃을 갈아끼우기 창에 버렸다 — 창은 7.2ms짜리인데 그 로그아웃은 영구히 취소된 채로 남는다"
    );
    assert_eq!(claude::bury_stats::gave_up(), 0, "★ 창이 지났는데도 접었다(재시도가 안 돌았다)");
    assert!(claude::is_registered("mine@x"), "★ 되살리기가 이웃이 지우지 **않은** 계정까지 지웠다");
    let _ = std::fs::remove_dir_all(&home);
}

/// ★R28d(CASX R4) — **이웃의 오독 통짜 쓰기를 되살려 계정 전부를 지우지 않는다.**
///
/// 확인 크리틱 R3 §3-1이 "같은 구멍의 더 나쁜 변형"으로 적은 착지다. `theirs`가 2.6.2
/// `readStoreFile`의 `catch { accounts: [] }`(`src/main/auth.ts:117`)면 `keep`이 비고
/// 지울 목록에 **우리 계정 전부**가 들어간다 — 되살리기가 그걸 실행하면 우리가 이웃의
/// 버그를 대신 수행하는 셈이고, 살아 있는 계정이 `credEnc`째 통째로 사라진다.
///
/// ★R28e(CASX2) — **가르는 근거가 바뀌었다.** R4는 [수 하나]로 갈랐다(로그아웃은 계정
/// 하나를 지운다 · 둘 이상이면 오독). 그 규칙이 이웃 스냅샷이 우리 로그인 하나만큼만
/// 낡아도 걸려 **진짜 로그아웃을 영구히 취소**했다(확인 크리틱 R4 §3-2). 이제 근거는
/// **「그 원문이 우리 어느 시점 목록에서 나왔나」**다(`ccg_auth::ledger::attribute`).
/// `{"accounts":[]}`에는 짚을 앵커가 하나도 없으므로 **한 건도 안 지운다** — 그리고
/// 그 사실을 로그가 사유와 함께 말한다(단정하지 않는다).
#[test]
fn a_mis_read_whole_write_never_takes_the_whole_account_list_with_it() {
    let home = ccg_store::testhome::take("r4casx4c");
    std::env::set_var("CCG_NO_NET", "1");
    claude::bury_stats::reset();
    seed("a@x", "A-1");
    seed("b@x", "B-1");

    // 이웃이 갈아끼우기 창에서 파일을 못 읽고 「계정 0개」 위에 통짜로 되쓴다.
    let bogus = peer::body(None, &[]);
    let held = std::fs::OpenOptions::new().write(true).open(peer::path()).expect("이웃의 열기");
    assert_eq!(rotate("a@x", "A-2"), Landing::Both, "전제 — 회전이 양쪽에 정착했다");
    land_whole_write(held, &bogus);

    std::thread::sleep(std::time::Duration::from_millis(800));
    println!(
        "[r4-casx4c] a 살아있나={} · b 살아있나={} · 장부(지연={} 오독통짜라안받음={} 자물쇠안={})",
        claude::is_registered("a@x"),
        claude::is_registered("b@x"),
        claude::bury_stats::late(),
        claude::bury_stats::refused(),
        claude::bury_stats::in_lock()
    );
    assert!(
        claude::is_registered("a@x") && claude::is_registered("b@x"),
        "★ 이웃의 오독 통짜 쓰기를 되살려 계정 목록을 통째로 지웠다 — 살아 있는 토큰째 사라지고 출구는 재로그인뿐이다"
    );
    assert!(
        claude::bury_stats::refused() >= 1,
        "★ 안 지운 것이 규칙 때문인지 우연인지 장부로 못 가른다(오독 통짜 판정이 한 번도 안 걸렸다)"
    );
    assert_eq!(store_refresh_of("a@x").as_deref(), Some("A-2"), "★ 회전 결과가 되돌려졌다");
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

// ══════════════════════════════════════════════════════════════════════════════
// ★R28e(CASX2) — 확인 크리틱 R4가 낸 결정적 재현 셋을 **못으로 박는다**
//
// 셋 다 크리틱이 폐기용 워크트리에서 손으로 세운 순서였고(레포 밖이라 회귀를 못 잡았다),
// 셋 다 「사용자의 로그아웃이 영구히 취소된다」는 이 갈래의 헤드라인 불변식을 직접 깬다.
// 이제 워크스페이스 게이트가 든다.
// ══════════════════════════════════════════════════════════════════════════════

/// ★P1(치명 · 확인 크리틱 R4 §3-1) — **우리 자신의 배경 회전이 로그아웃을 취소하지 않는다.**
///
/// R4의 세대 증표는 「지울 행이 우리가 커밋한 바이트 그대로인가」였다. 그 행의 바이트를
/// 가는 것은 재로그인만이 아니다 — `persist_refreshed_report`의 백업 반쪽이 그 계정의
/// `credEnc`를 다시 쓰면 같은 일이 난다. 그래서 **사용자가 아무것도 안 했는데** 이웃의
/// 로그아웃이 영구히 취소되고, 로그는 *"그 뒤에 다시 로그인돼 있어 그대로 뒀다"*고
/// 정반대를 적었다(크리틱 실측: HEAD 4/4 붉음 · 4단계만 뺀 대조군 4/4 초록).
///
/// 이 못은 크리틱의 순서를 그대로 세운다. 제품 못
/// [`a_late_revive_never_deletes_a_login_that_landed_after_our_commit`]와 **한 줄만** 다르다 —
/// 「재로그인」 자리에 **「우리 배경 회전」**을 놓았다. 그 한 줄이 R4의 못들이 원리적으로
/// 못 밟는 자리였다(헤드라인 못은 회전 대상과 로그아웃 대상을 갈라 놔서 `moved_on`이
/// 구조적으로 0이다).
#[test]
fn our_own_rotation_of_the_logged_out_account_never_cancels_that_logout() {
    let home = ccg_store::testhome::take("r28e-p1");
    std::env::set_var("CCG_NO_NET", "1");
    claude::bury_stats::reset();
    // ① 평시 — 두 계정이 있고 둘 다 회전이 돈다.
    seed("mine@x", "m-1");
    seed("ghost@x", "g-1");
    assert_eq!(rotate("ghost@x", "g-2"), Landing::Both, "전제 — 평시 회전이 양쪽에 정착했다");

    // ② 이웃(2.6.2)이 ghost@x를 로그아웃하려고 파일을 연다(걸터탄 열기).
    let (held, logout_body) = straddling_open("ghost@x");
    // ③ 우리 갈아끼우기가 저 핸들의 inode에서 이름을 뗀다(= 커밋 · 여기서 묻힌다).
    assert_eq!(rotate("mine@x", "m-2"), Landing::Both, "전제 — 커밋이 정착했다");
    // ④ ★ 배경 회전 한 바퀴 — **로그아웃 대상 계정의 `credEnc`가 갈린다.**
    //    사용자는 아무것도 안 했다. R4는 이 한 줄에서 로그아웃을 영구히 취소했다.
    assert_eq!(rotate("ghost@x", "g-3"), Landing::Both, "전제 — 그 회전도 양쪽에 정착했다");
    // ⑤ 그제서야 ②의 핸들이 로그아웃 본문을 이름 없는 옛 inode로 흘린다.
    land_whole_write(held, &logout_body);

    let mut gone_at = None;
    for k in 0..400 {
        std::thread::sleep(std::time::Duration::from_millis(5));
        if !peer::has("ghost@x") {
            gone_at = Some((k + 1) * 5);
            break;
        }
    }
    println!(
        "[r28e-p1] 되살리기 = {gone_at:?}ms · 장부(지연={} 신원세대로안지움={} 근거못짚음={} 되살릴것없음={})",
        claude::bury_stats::late(),
        claude::bury_stats::moved_on(),
        claude::bury_stats::refused(),
        claude::bury_stats::late_kept()
    );
    assert!(
        gone_at.is_some(),
        "★ 우리 배경 회전 한 바퀴가 이웃의 로그아웃을 영구히 취소했다 — 사용자가 지운 계정이 credEnc째 돌아와 앉아 있다(확인 크리틱 R4 §3-1)"
    );
    assert_eq!(claude::bury_stats::moved_on(), 0, "★ 회전을 「그 뒤에 다시 로그인됐다」로 셌다 — 로그가 정반대를 말한다");
    assert!(claude::is_registered("mine@x"), "★ 되살리기가 이웃이 지우지 **않은** 계정까지 지웠다");
    assert_eq!(store_refresh_of("mine@x").as_deref(), Some("m-2"), "★ 되살리기가 방금 정착한 회전 결과를 되돌렸다");
    let _ = std::fs::remove_dir_all(&home);
}

/// ★P2b(높음 · 확인 크리틱 R4 §3-2) — **이웃 스냅샷이 우리 로그인 하나만큼 낡아도
/// 진짜 로그아웃은 살고 새 로그인은 안 죽는다.**
///
/// 두 라운드가 이 배치에서 **반대 방향으로** 틀렸다:
///
/// | 코드 | 결과 |
/// |---|---|
/// | `63763c6`(R3) | `bye@x`와 함께 **`new@x`까지 지웠다**(막 앉은 로그인이 증발) |
/// | `6f2f312`(R4) | 「지우기 2건 = 오독한 통짜 쓰기」로 몰아 **둘 다 안 지웠다**(진짜 로그아웃 영구 취소) |
///
/// 「몇 개 지웠나」는 세대를 못 대신한다. 필요한 것은 **그들의 원문이 우리 어느 시점
/// 목록에서 나왔나**이고, `ccg_auth::ledger`가 그것을 짚는다.
#[test]
fn a_stale_neighbour_snapshot_drops_only_what_it_actually_logged_out() {
    let home = ccg_store::testhome::take("r28e-p2b");
    std::env::set_var("CCG_NO_NET", "1");
    claude::bury_stats::reset();
    seed("mine@x", "m-1");
    seed("bye@x", "b-1");

    // ① 이웃이 지금 목록을 읽고, bye를 뺀 본문을 손에 든다(스냅샷 = [mine, bye]).
    let (def, accounts) = peer::read_raw();
    let kept: Vec<Value> = accounts.iter().filter(|a| claude::email_of(a) != Some("bye@x")).cloned().collect();
    let logout_body = peer::body(def.as_deref(), &kept);
    // ② 그 사이 우리 쪽에 new@x 로그인이 앉는다 — **별개 커밋**이라 `added`와 무관하다.
    seed("new@x", "n-1");
    // ③ 이웃이 파일을 연다(걸터탄 열기). 그들의 스냅샷은 여전히 ①의 것이다
    //    (2.6.2 `removeAccount`는 read → deleteAccountDir → write라 그 사이가 ms다).
    let held = std::fs::OpenOptions::new().write(true).open(peer::path()).expect("이웃의 열기");
    // ④ 우리 배경 회전이 갈아끼운다 = 그들의 로그아웃이 묻힌다.
    assert_eq!(rotate("mine@x", "m-2"), Landing::Both, "전제 — 커밋이 정착했다");
    land_whole_write(held, &logout_body);

    std::thread::sleep(std::time::Duration::from_millis(1200));
    println!(
        "[r28e-p2b] bye 살아있나={} · new 살아있나={} · 장부(지연={} 신원세대로안지움={} 근거못짚음={})",
        claude::is_registered("bye@x"),
        claude::is_registered("new@x"),
        claude::bury_stats::late(),
        claude::bury_stats::moved_on(),
        claude::bury_stats::refused()
    );
    assert!(
        !claude::is_registered("bye@x"),
        "★ 이웃 스냅샷이 우리 로그인 하나만큼 낡았다는 이유로 **진짜 로그아웃**이 영구히 취소됐다(확인 크리틱 R4 §3-2)"
    );
    assert!(
        claude::is_registered("new@x"),
        "★ 그들이 본 적도 없는 새 로그인을 되살리기가 지웠다 — 사용자에게는 「로그인했는데 곧 계정이 사라졌다」다"
    );
    assert_eq!(store_refresh_of("new@x").as_deref(), Some("n-1"), "★ 새 로그인의 credEnc가 갈렸다");
    assert!(claude::is_registered("mine@x"), "★ 되살리기가 이웃이 지우지 **않은** 계정까지 지웠다");
    assert!(
        claude::bury_stats::moved_on() >= 1,
        "★ new@x를 안 지운 것이 규칙 때문인지 우연인지 장부로 못 가른다(보류 사연이 한 번도 안 남았다)"
    );
    let _ = std::fs::remove_dir_all(&home);
}

/// ★P2(곁가지 · 확인 크리틱 R4 §3-2) — **한 벌 쓰기가 둘을 지웠으면 둘 다 살린다.**
///
/// R4의 `REVIVE_MAX_REMOVALS = 1`은 이 판을 통째로 「오독한 통짜 쓰기」로 몰아 **둘 다
/// 영구 취소**했다(1/1). 개수는 판정의 근거가 아니라 결과여야 한다.
///
/// ## 이 못이 `rotate("mine@x", "m-2")`를 한 줄 더 두는 이유(정직하게 적는다)
///
/// 그 줄이 **앵커를 갱신한다.** 없으면 `{mine, bye1}`(bye2가 아직 없던 우리 상태)도
/// 그들 원문과 똑같이 맞아떨어져서, 「가장 적게 지우는 쪽」 규칙이 `bye1` 하나만
/// 귀속시킨다 — 그리고 그게 **맞는 보수적 답이다**(그들 스냅샷이 그 시점이었을 수도
/// 있으니까). 즉 남는 격차는 「앵커가 그 사이에 한 번도 안 갈린 판에서는 한 벌 로그아웃의
/// 일부만 산다」이고, 그때 사용자는 남은 계정을 한 번 더 지우면 된다. 보고서에 적었다.
#[test]
fn a_whole_write_that_dropped_two_accounts_revives_both() {
    let home = ccg_store::testhome::take("r28e-p2");
    std::env::set_var("CCG_NO_NET", "1");
    claude::bury_stats::reset();
    seed("mine@x", "m-1");
    seed("bye1@x", "b1-1");
    seed("bye2@x", "b2-1");
    assert_eq!(rotate("mine@x", "m-2"), Landing::Both, "전제 — 이웃이 읽을 상태를 한 번 갱신한다");

    let (held, logout_body) = straddling_open_many(&["bye1@x", "bye2@x"]);
    assert_eq!(rotate("mine@x", "m-3"), Landing::Both, "전제 — 커밋이 정착했다(여기서 묻힌다)");
    land_whole_write(held, &logout_body);

    std::thread::sleep(std::time::Duration::from_millis(1200));
    println!(
        "[r28e-p2] bye1={} bye2={} mine={} · 장부(지연={} 신원세대로안지움={} 근거못짚음={})",
        claude::is_registered("bye1@x"),
        claude::is_registered("bye2@x"),
        claude::is_registered("mine@x"),
        claude::bury_stats::late(),
        claude::bury_stats::moved_on(),
        claude::bury_stats::refused()
    );
    assert!(
        !claude::is_registered("bye1@x") && !claude::is_registered("bye2@x"),
        "★ 한 벌 쓰기가 계정 둘을 지웠는데 개수 규칙이 그것을 「오독」으로 몰아 둘 다 영구 취소했다"
    );
    assert!(claude::is_registered("mine@x"), "★ 되살리기가 그들이 지우지 **않은** 계정까지 지웠다");
    let _ = std::fs::remove_dir_all(&home);
}

// ══════════════════════════════════════════════════════════════════════════════
// ★R28f — 확인 크리틱 R28e가 낸 결정적 재현 둘을 **못으로 박는다**
// ══════════════════════════════════════════════════════════════════════════════

/// 어느 계정이 `ms` 안에 파일에서 사라지나. `Some(경과ms)` = 사라졌다.
fn gone_within(email: &str, ms: usize) -> Option<usize> {
    for k in 0..(ms / 5) {
        std::thread::sleep(std::time::Duration::from_millis(5));
        if !peer::has(email) {
            return Some((k + 1) * 5);
        }
    }
    None
}

/// 지금 디스크의 툼스톤 목록.
fn tombs() -> Vec<Value> {
    let p = ccg_store::app_home().join(ccg_auth::ledger::TOMB_FILE);
    let Ok(raw) = std::fs::read_to_string(p) else { return Vec::new() };
    serde_json::from_str::<Value>(&raw)
        .ok()
        .and_then(|v| v.get("tombstones").and_then(Value::as_array).cloned())
        .unwrap_or_default()
}

/// ★R28f-①(치명 · 회귀 · 확인 크리틱 R28e §3-1) — **이웃이 자기 손으로 회전한 계정의
/// 로그아웃이 영구히 취소되지 않는다.**
///
/// 크리틱의 다섯 걸음 그대로다. 핵심은 3번 — 우리 편집이 **아무것도 안 바꾸고 읽고만**
/// 지나간다. 제품에서 흔한 모양이다(`sync_account_tokens`가 「변화 없음」으로 돌아온 판 ·
/// 이미 맨 위인 계정의 `move_account_to_top` · 같은 순서의 `reorder_accounts`).
///
/// | 코드 | 크리틱 실측 10주행 |
/// |---|---|
/// | 대조군 `6f2f312`(R28d R4) | **10/10 살렸다**(10ms) |
/// | `9aa75b5`(R28e) | **10/10 못 살렸다** — 1,500ms 안에 안 사라진다 = 영구 취소 |
///
/// R28e의 로그는 그 행을 두고 *"그들이 못 본 행이다"*라고 **단정했다**. 그 행은 이웃이
/// 방금 자기 손으로 쓴 행이고 그들은 그것을 읽고 나서 로그아웃을 만들었다 — R4가
/// *"그 뒤에 다시 로그인돼 있어 그대로 뒀다"*로 단정해 불합격한 자리와 같은 종류의 거짓이다.
///
/// ## 이 못이 같이 단정하는 것
///
/// 이 판은 **파일만으로 못 가른다**(그들의 읽기가 이웃 회전보다 앞인지 뒤인지 디스크에
/// 안 남는다 — 두 경우 모두 그들 원문의 바이트가 같다). 그래서 「살았다」만으로는
/// 부족하다. `unsure >= 1`을 같이 단정해 **못 갈랐다는 사실이 장부와 로그에 남았는지**를
/// 잰다. 이 단정이 없으면 다음 라운드가 「그냥 다 지운다」로 바꿔도 못이 초록이다.
#[test]
fn a_logout_of_a_row_the_neighbour_rotated_is_never_permanently_cancelled() {
    let home = ccg_store::testhome::take("r28f-peerrot");
    std::env::set_var("CCG_NO_NET", "1");
    claude::bury_stats::reset();
    // ① mine@x · bye@x 두 계정을 심는다.
    seed("mine@x", "m-1");
    seed("bye@x", "b-1");

    // ② 이웃(2.6.2)이 **자기 손으로** bye@x의 credEnc만 간다(`auth.ts:485`의 그 모양 —
    //    `f.accounts.map(a => a.email === email ? { ...a, credEnc } : a)`). mine@x 행은 그대로다.
    let (def, accounts) = peer::read_raw();
    let rotated: Vec<Value> = accounts
        .iter()
        .map(|a| if claude::email_of(a) == Some("bye@x") { row_of("bye@x", "PEER-ROTATED") } else { a.clone() })
        .collect();
    peer::write_raw(def.as_deref(), &rotated);

    // ③ 우리 편집이 한 번 **읽고 지나간다**. 목록이 안 갈리니 갈아끼우기도 없다.
    claude::update_store(|_| ()).expect("무변화 편집");
    assert!(peer::has("bye@x"), "전제 — 무변화 편집은 아무것도 안 지운다");

    // ④ 이웃이 방금 그 상태를 읽고 bye@x를 로그아웃한다(걸터탄 열기).
    let (held, logout_body) = straddling_open("bye@x");
    // ⑤ 우리 배경 회전이 갈아끼운다 = 그들의 로그아웃이 묻힌다.
    assert_eq!(rotate("mine@x", "m-2"), Landing::Both, "전제 — 커밋이 정착했다");
    land_whole_write(held, &logout_body);

    let gone_at = gone_within("bye@x", 1500);
    println!(
        "[r28f-peerrot] 되살리기 = {gone_at:?}ms · 장부(지연={} 신원세대로안지움={} ★못가름={} 근거못짚음={} 되살릴것없음={})",
        claude::bury_stats::late(),
        claude::bury_stats::moved_on(),
        claude::bury_stats::unsure(),
        claude::bury_stats::refused(),
        claude::bury_stats::late_kept()
    );
    assert!(
        gone_at.is_some(),
        "★ 이웃이 자기 손으로 회전한 계정이라는 이유로 그들의 로그아웃이 **영구히** 취소됐다 — 사용자가 2.6.2에서 지운 계정이 credEnc째 목록에 남아 있다(확인 크리틱 R28e §3-1 · 대조군 6f2f312는 10/10 살렸다)"
    );
    assert!(
        claude::bury_stats::unsure() >= 1,
        "★ 살리긴 했는데 **못 갈랐다는 사실이 아무 데도 안 남았다** — 이 판은 파일만으로 못 가르는 판이고, 단정으로 적으면 그게 R28e가 불합격한 그 거짓이다"
    );
    assert_eq!(claude::bury_stats::moved_on(), 0, "★ 이웃의 회전을 「그들이 못 본 행」으로 셌다 — 로그가 정반대를 말한다");
    assert!(claude::is_registered("mine@x"), "★ 되살리기가 이웃이 지우지 **않은** 계정까지 지웠다");
    assert_eq!(store_refresh_of("mine@x").as_deref(), Some("m-2"), "★ 되살리기가 방금 정착한 회전 결과를 되돌렸다");
    let _ = std::fs::remove_dir_all(&home);
}

/// ★R28f-②(높음 · 확인 크리틱 R28e §3-2) — **되살리기가 남기는 툼스톤에 지문이 있다.**
///
/// 배치는 [`a_logout_tombstone_keeps_the_backup_from_resurrecting_the_account`]와 **같다**.
/// 다른 것은 로그아웃의 주체가 `remove_account`(사용자 조작)가 아니라 **되살리기**(이웃이
/// 낸 로그아웃을 우리가 파내 다시 적용했다)라는 것뿐이다 — 그리고 그 한 줄이 R28e에서
/// 갈렸다: 되살리기 세 자리는 전부 `ledger::bury(e, "…", None)`이라 툼스톤의 지문이
/// 문자열 `"0"`이었고, `ledger::without_buried`는 `t.fp == fp_of(a)`인 행만 걷어내므로
/// **영원히 안 맞았다.** 즉 이 갈래의 헤드라인 대상인 「이웃이 낸 로그아웃」만 복구본에서
/// `credEnc`째 되살아났고, 그 착지에 툼스톤을 언급하는 줄이 한 줄도 없었다.
#[test]
fn a_revived_neighbour_logout_leaves_a_tombstone_the_backup_respects() {
    let home = ccg_store::testhome::take("r28f-revive-tomb");
    std::env::set_var("CCG_NO_NET", "1");
    claude::bury_stats::reset();
    seed("keep@x", "K-1");
    seed("bye@x", "B-1");
    let bak = ccg_store::app_home().join(claude::STORE_BACKUP_FILE);
    let stale_backup = std::fs::read_to_string(&bak).expect("마지막 성공본");
    assert!(stale_backup.contains("bye@x"), "전제 — 복구본이 bye@x를 안다");

    // ① 이웃이 bye@x를 로그아웃하고, 우리 커밋이 그 쓰기를 묻는다 → 되살리기가 다시 적용.
    let (held, logout_body) = straddling_open("bye@x");
    assert_eq!(rotate("keep@x", "K-2"), Landing::Both, "전제 — 커밋이 정착했다");
    land_whole_write(held, &logout_body);
    let gone_at = gone_within("bye@x", 1500);
    assert!(gone_at.is_some(), "전제 — 되살리기가 이웃의 로그아웃을 다시 적용했다");

    // ② 그 로그아웃의 **영속 기록**을 본다 — 이메일만이 아니라 **지문**까지.
    let list = tombs();
    println!("[r28f-revive-tomb] 되살리기 {gone_at:?}ms · 툼스톤={list:?}");
    let t = list.iter().find(|t| t.get("email").and_then(Value::as_str) == Some("bye@x")).cloned();
    let t = t.expect("★ 되살리기가 실행한 로그아웃이 영속 기록을 안 남겼다 — 재시작을 넘으면 「누가 지웠나」를 모른다");
    let fp = t.get("fp").and_then(Value::as_str).unwrap_or("");
    assert!(
        fp != "0" && !fp.is_empty(),
        "★ 툼스톤에 지문이 없다(fp={fp:?}) — `without_buried`는 지문이 맞는 행만 걷어내므로 이 기록은 아무것도 안 막는다(확인 크리틱 R28e §3-2)"
    );

    // ③ 복구본이 로그아웃 **이전** 판으로 돌아가고 본문이 사라진다.
    std::fs::write(&bak, &stale_backup).expect("복구본 되돌리기");
    std::fs::remove_file(peer::path()).expect("본문 치우기");
    claude::update_store(|_| ()).expect("복구를 타는 편집");
    println!(
        "[r28f-revive-tomb] 복구 뒤 목록 = {:?}",
        claude::read_store_file().accounts.iter().filter_map(claude::email_of).collect::<Vec<_>>()
    );
    assert!(
        !claude::is_registered("bye@x"),
        "★ 복구본이 **이웃이 낸 로그아웃**을 credEnc째 되돌렸다 — 사용자가 2.6.2에서 지운 계정이 살아 있는 토큰째 돌아와 앉았다"
    );
    assert!(claude::is_registered("keep@x"), "★ 툼스톤을 지키느라 멀쩡한 계정까지 잃었다");
    assert!(claude::bury_stats::recovered() >= 1, "★ 복구본을 탄 사실이 장부에 안 남았다(침묵)");
    // 같은 이메일의 **새 로그인**은 지문이 달라 이 툼스톤에 안 걸린다.
    seed("bye@x", "B-2");
    assert!(claude::is_registered("bye@x"), "★ 되살리기의 툼스톤이 사용자의 재로그인을 막았다");
    let _ = std::fs::remove_dir_all(&home);
}

/// ★R28e(CASX2) — **툼스톤이 재시작을 넘어 로그아웃을 지킨다.**
///
/// 이 갈래가 일부러 열어 둔 문이 하나 있다: 본문이 깨지거나 사라지면 마지막 성공본
/// (`accounts.json.bak`)으로 목록을 되살린다(`claude::vanished_but_we_know_better`).
/// 그 복구본은 **우리가 그 뒤에 실행한 로그아웃을 아직 담고 있을 수 있고**, 그러면
/// 사용자가 지운 계정이 `credEnc`째 돌아온다 — R28d까지는 *"되살아난 계정은 사용자가
/// 다시 지우면 된다"*로 열어 뒀던 자리다.
///
/// 이제 로그아웃은 `ccg_auth::ledger`에 **영속 기록**을 남기고, 복구는 그 기록을
/// 존중한다. 지문이 그대로인 행만 걷어내므로 그 뒤에 앉은 **새 로그인은 안 건드린다**.
#[test]
fn a_logout_tombstone_keeps_the_backup_from_resurrecting_the_account() {
    let home = ccg_store::testhome::take("r28e-tomb");
    std::env::set_var("CCG_NO_NET", "1");
    claude::bury_stats::reset();
    seed("keep@x", "K-1");
    seed("bye@x", "B-1");
    // 마지막 성공본이 두 계정을 다 아는 상태를 만든다.
    let bak = ccg_store::app_home().join("accounts.json.bak");
    let stale_backup = std::fs::read_to_string(&bak).expect("마지막 성공본");
    assert!(stale_backup.contains("bye@x"), "전제 — 복구본이 bye@x를 안다");

    claude::remove_account("bye@x");
    let tomb = std::fs::read_to_string(ccg_store::app_home().join(ccg_auth::ledger::TOMB_FILE)).unwrap_or_default();
    assert!(tomb.contains("bye@x"), "★ 로그아웃이 영속 기록을 안 남겼다 — 재시작을 넘으면 「누가 지웠나」를 모른다");

    // ★ 복구본이 로그아웃 **이전** 상태로 되돌아간 판(로그아웃이 `.bak`을 갱신하기 전에
    //   본문이 사라졌다 — 갈아끼우기 창·수동 삭제·지원 절차 어느 쪽이든 같은 모양이다).
    std::fs::write(&bak, &stale_backup).expect("복구본 되돌리기");
    std::fs::remove_file(peer::path()).expect("본문 치우기");

    // 다음 편집 한 번이 복구를 탄다(`cas_edit` → `vanished_but_we_know_better`).
    claude::update_store(|_| ()).expect("복구를 타는 편집");
    println!(
        "[r28e-tomb] 복구 뒤 목록 = {:?}",
        claude::read_store_file().accounts.iter().filter_map(claude::email_of).collect::<Vec<_>>()
    );
    assert!(!claude::is_registered("bye@x"), "★ 마지막 성공본이 로그아웃한 계정을 credEnc째 되살렸다");
    assert!(claude::is_registered("keep@x"), "★ 툼스톤을 지키느라 멀쩡한 계정까지 잃었다");
    seed("later@x", "L-1");
    assert!(claude::is_registered("later@x"), "★ 복구 뒤의 새 로그인이 안 앉았다");

    // 같은 이메일로 **다시 로그인**하면 툼스톤이 그것을 막지 않는다(지문이 다르다).
    seed("bye@x", "B-2");
    assert!(claude::is_registered("bye@x"), "★ 툼스톤이 사용자의 재로그인을 막았다 — 지문으로 시체와 갈라야 한다");
    let _ = std::fs::remove_dir_all(&home);
}

// ══════════════════════════════════════════════════════════════════════════════
// ★R28g — 확인 크리틱 R28f §2-1: 「제품 경로로 강제가 안 된다」는 **사실이 아니었다**
// ══════════════════════════════════════════════════════════════════════════════

/// 자식 주행 표식. 이 변수가 있으면 아래 못은 **제품 경로 주행**만 하고, 없으면
/// 자기 자신을 자식으로 띄워 그 주행의 **stderr를 읽는다**.
const BLIND_CHILD: &str = "CCG_R28G_BLIND_CHILD";

/// 지금 디스크에 있는 그 계정의 **행 바이트**(이웃이 자기 손에 드는 것과 같은 값).
fn disk_row(email: &str) -> Option<Value> {
    peer::read_raw().1.into_iter().find(|a| claude::email_of(a) == Some(email))
}

/// ★R28g(확인 크리틱 R28f §2-1) — **앵커는 섰는데 맞는 세대가 없는 판이 `refused`로,
/// 그리고 한 줄로 착지한다** — 제품 경로에서.
///
/// R28f 보고서 §3과 그 완료 보고는 이렇게 적었다: *"크리틱과 같은 이유로 제품 경로 못은
/// 안 세웠다 — 우리 커밋의 읽기가 대개 그 이메일을 먼저 보기 때문에 **제품 경로로 강제가
/// 안 된다**."* 확인 크리틱 R28f가 그것을 반증했다(§2-1 · 5/5 결정적). 필요한 것은
/// 「우리가 못 본 이메일」이 아니라 **「한 세대에 같이 있은 적 없는 두 앵커 행」**이다.
///
/// ```text
/// ① our_login(anchor@x)      → 그때의 anchor@x 행 바이트를 뜬다
/// ② our_login(dropme@x)
/// ③ our_login(anchor@x) 다시  → 옛 anchor 행은 이제 어느 최신 세대에도 없다
/// ④ our_login(late@x)        → late@x 행 바이트를 뜬다
/// ⑤ 이웃 원문 = [①의 행, ④의 행] → dropme@x가 빠졌다(두 앵커가 한 세대에 같이 없다)
/// ⑥ 우리 회전이 커밋 → 이웃이 걸터탄 통짜 쓰기가 이름 없는 옛 inode로 착지
/// ```
///
/// 두 앵커는 **각각** 우리 장부에 있으므로 `anchors.is_empty()` 갈래에는 안 걸리고,
/// 두 앵커를 **함께** 담은 세대는 하나도 없으므로 후보가 텅 빈다 — R28e가 여기서
/// `Verdict::Nothing`을 돌려줬고 부르는 쪽이 그것을 「되살릴 것이 없다」로 읽어
/// `late_kept`만 올리고 **로그를 한 줄도 안 찍었다**(그 침묵이 R28e §3-3의 불합격 사유다).
///
/// | 코드 | 크리틱 실측 5주행 |
/// |---|---|
/// | `6f2f312`(R28d R4) | 근거 없이 10ms에 지운다 |
/// | `9aa75b5`(R28e) | `late_kept=1` · **로그 0줄**(그 침묵) |
/// | `0596b41`(R28f) | `refused=1` + **한 줄** |
///
/// ## 왜 자식 프로세스인가 (정직하게 적는다)
///
/// R28f가 세운 못은 `ledger.rs`의 **단위 못**뿐이었다(`Verdict::Blind`를 돌려주나).
/// 이 라운드가 닫는 것은 그 갈래가 아니라 **부르는 쪽**이다 — `claude.rs`의 `refused`
/// 집계와 `eprintln!` 한 줄. 그 한 줄은 **지연 감시 스레드의 stderr**로 나가므로 같은
/// 프로세스 안에서는 읽을 수단이 없다. 그래서 이 못은 자기 자신을 `--exact … --nocapture`로
/// 띄워 그 프로세스의 stderr를 그대로 읽는다(`critic_m11r3_attack.rs`·`m11r3_store_race.rs`가
/// 쓰는 것과 같은 자식 패턴). 자식이 자기 장부를 먼저 단정하므로 **어느 쪽이 붉어도**
/// 진단이 남는다.
///
/// 자물쇠 안 경로(`cas_edit`의 `Commit::Buried`)도 **같은 두 줄**을 쓴다
/// (`bury_stats::REFUSED` + `blind_line`). 그래서 이 못은 어느 쪽이 파냈든 같은 값을 잰다.
#[test]
fn an_anchor_without_a_matching_generation_is_refused_out_loud_on_the_product_path() {
    if std::env::var(BLIND_CHILD).is_ok() {
        return blind_child_run();
    }
    let home = ccg_store::testhome::take("r28g-blind");
    let exe = std::env::current_exe().expect("테스트 바이너리");
    let out = std::process::Command::new(exe)
        .args([
            "--exact",
            "an_anchor_without_a_matching_generation_is_refused_out_loud_on_the_product_path",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(BLIND_CHILD, "1")
        .env("CCG_HOME", home.dir.as_os_str())
        .env("CCG_NO_NET", "1")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .expect("자식 프로세스");
    let so = String::from_utf8_lossy(&out.stdout).to_string();
    let se = String::from_utf8_lossy(&out.stderr).to_string();
    // `--nocapture`는 `test <이름> ... `을 같은 줄 앞에 붙인다 — `starts_with`로 찾으면 못 찾는다.
    for l in so.lines().filter(|l| l.contains("[r28g-blind]")) {
        println!("{l}");
    }
    // 제품이 「못 짚었다」를 말한 줄 — §3-3의 그 갈래인지까지 본다(다른 `Blind` 셋과 가른다).
    let said: Vec<&str> = se.lines().filter(|l| l.contains("세대가 하나도 없다")).collect();
    for l in &said {
        println!("[r28g-blind] 제품 줄: {l}");
    }
    assert!(
        out.status.success(),
        "★ 자식(제품 경로 주행)이 붉었다 — 아래가 그 주행의 꼬리다\n--- stdout ---\n{}\n--- stderr ---\n{}",
        tail(&so, 40),
        tail(&se, 40)
    );
    assert_eq!(
        said.len(),
        1,
        "★ 앵커는 섰는데 맞는 세대가 없는 판이 **침묵으로** 지나갔다(제품 줄 {}개) — R28e가 불합격한 그 자리다\n--- stderr ---\n{}",
        said.len(),
        tail(&se, 40)
    );
    let line = said[0];
    assert!(line.contains("[auth] ★ accounts.json:"), "★ 그 줄이 제품의 매장 진단 줄이 아니다: {line}");
    assert!(
        line.contains("앵커 2행은 우리 장부에 있는데"),
        "★ 앵커가 둘 다 서 있는 판이 아니다 — 이 못이 재려던 판이 아니라 다른 `Blind` 갈래다: {line}"
    );
    assert!(
        line.contains("dropme@x"),
        "★ 못 짚은 계정 이름이 줄에 없다 — 지원 담당이 무엇을 못 살렸는지 못 읽는다: {line}"
    );
    // `.bak`·툼스톤·계정 폴더가 부모 홈 밖으로 샜는지 본다(자식은 이 홈만 만져야 한다).
    println!("[r28g-blind] 자식 홈 = {}", home.dir.display());
}

/// 자식 몫 — 위 여섯 걸음을 **제품 경로로** 밟고 자기 장부를 단정한다.
fn blind_child_run() {
    // 홈은 부모가 증표(`ccg_store::testhome::take`)를 들고 넘겨준다. 여기서 `CCG_HOME`을
    // 만들지도 지우지도 않는다 — 대신 **실홈으로 떨어지지 않았는지**만 확인한다.
    let home = std::env::var("CCG_HOME").expect("★ 부모가 격리 홈을 안 넘겼다 — 실홈으로 떨어진다");
    assert!(home.contains("r28g-blind"), "★ 격리 홈이 아니다: {home}");
    std::env::set_var("CCG_NO_NET", "1");
    claude::bury_stats::reset();

    // ① 우리 로그인 anchor@x → **그 행의 디스크 바이트**를 뜬다.
    seed("anchor@x", "A-1");
    let old_anchor = disk_row("anchor@x").expect("① anchor@x 행");
    // ② 우리 로그인 dropme@x — 나중에 이웃이 지웠다고 말할 계정.
    seed("dropme@x", "D-1");
    // ③ anchor@x 다시 로그인 — ①의 행은 이제 **어느 최신 세대에도 없다**.
    seed("anchor@x", "A-2");
    // ④ 우리 로그인 late@x → 그 행 바이트를 뜬다.
    seed("late@x", "L-1");
    let late_row = disk_row("late@x").expect("④ late@x 행");
    assert_ne!(disk_row("anchor@x"), Some(old_anchor.clone()), "전제 — ③이 anchor@x 행을 실제로 갈았다");

    // ⑤ 이웃 원문 = [①의 행, ④의 행]. dropme@x가 빠졌고, **두 앵커가 한 세대에 같이 있은
    //    적이 없다**(①의 행이 있던 세대에는 late@x가 없었고, late@x가 생긴 세대의 anchor@x는
    //    ③이 갈아 놓은 다른 행이다).
    let (def, _) = peer::read_raw();
    let theirs = peer::body(def.as_deref(), &[old_anchor, late_row]);
    let held = std::fs::OpenOptions::new().write(true).open(peer::path()).expect("이웃의 걸터탄 열기");
    // ⑥ 우리 회전이 갈아끼운다 → 이웃의 통짜 쓰기가 이름 없는 옛 inode로 착지 = 우리가 묻었다.
    assert_eq!(rotate("anchor@x", "A-3"), Landing::Both, "전제 — 커밋이 정착했다");
    land_whole_write(held, &theirs);

    std::thread::sleep(std::time::Duration::from_millis(1200));
    println!(
        "[r28g-blind] 장부(근거못짚음={} 되살릴것없음={} 지연={} 신원세대로안지움={} ★못가름={}) · dropme 살아있나={} anchor={} late={}",
        claude::bury_stats::refused(),
        claude::bury_stats::late_kept(),
        claude::bury_stats::late(),
        claude::bury_stats::moved_on(),
        claude::bury_stats::unsure(),
        claude::is_registered("dropme@x"),
        claude::is_registered("anchor@x"),
        claude::is_registered("late@x")
    );
    assert_eq!(
        claude::bury_stats::refused(),
        1,
        "★ 「못 짚었다」가 장부에 안 남았다 — R28e는 이 판을 `Nothing`으로 떨어뜨려 `late_kept`만 올렸다(확인 크리틱 R28e §3-3의 침묵)"
    );
    assert_eq!(
        claude::bury_stats::late_kept(),
        0,
        "★ 「그들이 지운 계정이 없다」로 셌다 — 지운 계정은 있고(dropme@x) 우리가 못 짚었을 뿐이다"
    );
    assert_eq!(claude::bury_stats::late(), 0, "★ 근거를 못 짚었다면서 무언가를 되살렸다(지웠다)");
    assert!(
        claude::is_registered("dropme@x"),
        "★ 근거 없이 지웠다 — 대조군 6f2f312의 거동(10ms에 소멸)이 돌아왔다. 「모르면 안 지운다」가 이 모듈의 우선순위다"
    );
    assert!(
        claude::is_registered("anchor@x") && claude::is_registered("late@x"),
        "★ 못 짚은 판정이 멀쩡한 계정까지 데려갔다"
    );
    assert_eq!(store_refresh_of("anchor@x").as_deref(), Some("A-3"), "★ 방금 정착한 회전 결과가 되돌아갔다");
}

/// 자식 출력의 꼬리 `n`줄 — 붉을 때 진단이 남게(전문을 다 붙이면 못 읽는다).
fn tail(s: &str, n: usize) -> String {
    let v: Vec<&str> = s.lines().collect();
    v[v.len().saturating_sub(n)..].join("\n")
}
