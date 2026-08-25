//! ★R28e(CASX2) — **되살리기를 좁혀서 무엇을 잃었나**를 실측하는 프로브.
//!
//! 이 라운드는 되살리기의 근거를 「바이트 동일성 · 개수」에서 **「우리 장부가 그들 스냅샷을
//! 짚었나」**로 바꿨다. 짚지 못하면 한 건도 안 지운다 — 그게 안전한 방향이지만 **공짜가
//! 아니다**: M11 R4가 세운 *"잠금 모르는 이웃에게 우리 쓰기가 먹힌다"*는 보증의 일부(=
//! 그들의 로그아웃을 우리가 대신 살려 주는 부분)가 그만큼 얇아진다.
//!
//! 여기서 그 손실을 **세 판으로 결정적으로** 잰다. 게이트가 아니라 장부라서 `#[ignore]`다:
//! 같은 파일을 옛 코드(`6f2f312`) 위에서도 돌려 A/B를 냈고, 그 수가 보고서에 그대로 간다.
//!
//! ```text
//! cargo test -p ccg-auth --test probe_casx2_loss -- --ignored --nocapture --test-threads=1
//! ```

use ccg_auth::claude;
use serde_json::{json, Value};

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

fn rotate(email: &str, refresh: &str) -> bool {
    let Some(base) = claude::freshest_creds(email) else { return false };
    let Some(next) = claude::apply_refresh(&base, &format!("A-{refresh}"), Some(refresh), 3600.0, now_ms()) else { return false };
    claude::persist_refreshed_report(email, &next).both()
}

fn store_path() -> std::path::PathBuf {
    ccg_store::app_home().join("accounts.json")
}

fn read_raw() -> (Option<String>, Vec<Value>) {
    let Ok(s) = std::fs::read_to_string(store_path()) else { return (None, Vec::new()) };
    let Ok(v) = serde_json::from_str::<Value>(&s) else { return (None, Vec::new()) };
    (
        v.get("defaultEmail").and_then(Value::as_str).map(str::to_string),
        v.get("accounts").and_then(Value::as_array).cloned().unwrap_or_default(),
    )
}

fn peer_body(default_email: Option<&str>, accounts: &[Value]) -> String {
    let mut root = serde_json::Map::new();
    root.insert("version".into(), json!(3));
    if let Some(d) = default_email {
        root.insert("defaultEmail".into(), json!(d));
    }
    root.insert("accounts".into(), Value::Array(accounts.to_vec()));
    serde_json::to_string_pretty(&Value::Object(root)).unwrap()
}

fn land(mut held: std::fs::File, body: &str) {
    use std::io::{Seek, Write};
    held.set_len(0).expect("자르기");
    held.seek(std::io::SeekFrom::Start(0)).expect("되감기");
    held.write_all(body.as_bytes()).expect("이웃의 통짜 쓰기");
    drop(held);
}

fn gone_within(email: &str, ms: usize) -> Option<usize> {
    for k in 0..(ms / 5) {
        std::thread::sleep(std::time::Duration::from_millis(5));
        if !read_raw().1.iter().any(|a| claude::email_of(a) == Some(email)) {
            return Some((k + 1) * 5);
        }
    }
    None
}

/// ★손실 ① — **마지막 한 계정의 로그아웃**이 묻히면 못 살린다.
///
/// 이웃의 `removeAccount`가 계정 하나짜리 목록을 비우면 그들 원문은 `{"accounts":[]}`다.
/// 그 원문에는 우리가 짚을 **앵커가 하나도 없다** — 그리고 같은 바이트가 2.6.2
/// `readStoreFile`의 `catch { accounts: [] }`(오독)에서도 나온다. 둘을 못 가르므로
/// **안 지운다**(모듈의 우선순위: 확신이 없으면 되살리지 않는다).
///
/// R4는 이 판을 살렸다(`gone.len() == 1`이라 「로그아웃」으로 통과). 그래서 이건 **회귀**다.
/// 대신 R4는 같은 규칙으로 계정 둘 이상인 오독 통짜 쓰기를 거절해야 했고, 그 규칙이
/// §3-2의 진짜 로그아웃 영구 취소를 낳았다.
///
/// 사용자가 겪는 것: 「지운 계정이 아직 목록에 있다」 → **한 번 더 지우면 산다**(그 두 번째
/// 로그아웃이 우리 커밋과 또 겹칠 확률은 첫 번째와 독립이다).
#[test]
#[ignore]
fn loss_1_the_last_account_logout_is_not_revived() {
    let home = ccg_store::testhome::take("casx2-loss1");
    std::env::set_var("CCG_NO_NET", "1");
    claude::bury_stats::reset();
    seed("only@x", "o-1");
    assert!(rotate("only@x", "o-2"), "전제 — 회전이 정착했다");

    let body = peer_body(None, &[]); // 그들의 마지막 로그아웃 = 계정 0개
    let held = std::fs::OpenOptions::new().write(true).open(store_path()).expect("이웃의 열기");
    // 계정이 하나뿐이라 커밋을 낼 다른 계정이 없다 — 같은 계정의 회전으로 갈아끼운다.
    assert!(rotate("only@x", "o-3"), "전제 — 커밋이 정착했다");
    land(held, &body);

    let g = gone_within("only@x", 1500);
    println!(
        "[casx2-loss1] 마지막 계정 로그아웃이 살았나 = {g:?}ms · 장부(지연={} 근거못짚음={} 되살릴것없음={} 자물쇠안={})",
        claude::bury_stats::late(),
        claude::bury_stats::refused(),
        claude::bury_stats::late_kept(),
        claude::bury_stats::in_lock()
    );
    let _ = std::fs::remove_dir_all(&home);
}

/// ★손실 ② — **이웃이 자기 손으로 `credEnc`를 간 행**은 앵커가 못 된다.
///
/// 2.6.2도 토큰을 회전한다(`auth.ts:485` — `f.accounts.map(a => a.email === email ? {...a, credEnc} : a)`).
/// 그 결과 행은 우리가 쓴 적 없는 바이트라 우리 장부에 없다. 그들이 남긴 행이 **전부**
/// 그런 행이면 스냅샷을 못 짚고, 그러면 같은 쓰기에 담긴 로그아웃도 못 살린다.
///
/// 여기서는 그 극단을 결정적으로 만든다(남는 행 하나를 이웃이 직접 갈아 놓는다).
#[test]
#[ignore]
fn loss_2_a_neighbour_rotated_row_is_not_an_anchor() {
    let home = ccg_store::testhome::take("casx2-loss2");
    std::env::set_var("CCG_NO_NET", "1");
    claude::bury_stats::reset();
    seed("mine@x", "m-1");
    seed("ghost@x", "g-1");

    // 이웃이 **자기 손으로** mine@x의 credEnc를 갈고, 같은 쓰기로 ghost@x를 지운다.
    let (def, accounts) = read_raw();
    let their: Vec<Value> = accounts
        .iter()
        .filter(|a| claude::email_of(a) == Some("mine@x"))
        .map(|_| row_of("mine@x", "PEER-ROTATED"))
        .collect();
    let body = peer_body(def.as_deref(), &their);
    let held = std::fs::OpenOptions::new().write(true).open(store_path()).expect("이웃의 열기");
    assert!(rotate("mine@x", "m-2"), "전제 — 커밋이 정착했다");
    land(held, &body);

    let g = gone_within("ghost@x", 1500);
    println!(
        "[casx2-loss2] 이웃이 회전한 행만 남은 로그아웃이 살았나 = {g:?}ms · 장부(지연={} 근거못짚음={} 되살릴것없음={})",
        claude::bury_stats::late(),
        claude::bury_stats::refused(),
        claude::bury_stats::late_kept()
    );
    let _ = std::fs::remove_dir_all(&home);
}

/// ★유지 ④ — 손실 ②의 **현실적인 판**은 안 잃는다.
///
/// 손실 ②는 「이웃이 회전한 행이 그 회전을 담은 쓰기와 **같은 쓰기**로 처음 디스크에
/// 나타난다」는 극단이다. 실제 2.6.2는 회전과 로그아웃이 **다른 쓰기**이고, 그 사이에
/// 우리 편집이 한 번이라도 파일을 읽으면 그 행은 장부에 들어온다(`ledger::note`가
/// **잠금 안에서 읽은 목록도** 적는 이유가 이것이다). 그러면 앵커가 서고 판정도 선다.
#[test]
#[ignore]
fn kept_4_a_neighbour_rotation_we_have_already_seen_is_a_valid_anchor() {
    let home = ccg_store::testhome::take("casx2-keep4");
    std::env::set_var("CCG_NO_NET", "1");
    claude::bury_stats::reset();
    seed("mine@x", "m-1");
    seed("ghost@x", "g-1");

    // ① 이웃이 자기 손으로 mine@x를 회전한다(별개 쓰기 — 디스크에 그대로 앉는다).
    let (def, accounts) = read_raw();
    let rotated: Vec<Value> = accounts
        .iter()
        .map(|a| if claude::email_of(a) == Some("mine@x") { row_of("mine@x", "PEER-ROTATED") } else { a.clone() })
        .collect();
    std::fs::write(store_path(), peer_body(def.as_deref(), &rotated)).expect("이웃의 회전 쓰기");
    // ② 우리 편집이 한 번 지나간다 — 이 읽기가 그 행을 장부에 넣는다.
    assert!(rotate("ghost@x", "g-2"), "전제 — 우리 편집 한 번");
    // ③ 그제서야 이웃이 ghost@x를 로그아웃한다(그들 원문의 mine@x는 ①의 회전본이다).
    let (def, accounts) = read_raw();
    let kept: Vec<Value> = accounts.iter().filter(|a| claude::email_of(a) != Some("ghost@x")).cloned().collect();
    let body = peer_body(def.as_deref(), &kept);
    let held = std::fs::OpenOptions::new().write(true).open(store_path()).expect("이웃의 열기");
    assert!(rotate("mine@x", "m-2"), "전제 — 커밋이 정착했다");
    land(held, &body);

    let g = gone_within("ghost@x", 1500);
    println!(
        "[casx2-keep4] 이미 본 이웃 회전본이 앵커가 됐나 = {g:?}ms · 장부(지연={} 근거못짚음={} 되살릴것없음={})",
        claude::bury_stats::late(),
        claude::bury_stats::refused(),
        claude::bury_stats::late_kept()
    );
    let _ = std::fs::remove_dir_all(&home);
}

/// ★유지 ③(대조) — **평범한 로그아웃 매장은 그대로 산다.**
///
/// 손실 둘을 재는 프로브가 「전부 못 살린다」의 증거로 오해되지 않게, 같은 파일에서
/// 살아나는 판을 같이 잰다. 이웃이 남긴 행이 우리가 쓴 그 바이트면 앵커가 서고,
/// 그 순간 판정은 추론이 아니라 차집합이다.
#[test]
#[ignore]
fn kept_3_an_ordinary_buried_logout_still_revives() {
    let home = ccg_store::testhome::take("casx2-keep3");
    std::env::set_var("CCG_NO_NET", "1");
    claude::bury_stats::reset();
    seed("mine@x", "m-1");
    seed("ghost@x", "g-1");

    let (def, accounts) = read_raw();
    let kept: Vec<Value> = accounts.iter().filter(|a| claude::email_of(a) != Some("ghost@x")).cloned().collect();
    let body = peer_body(def.as_deref(), &kept);
    let held = std::fs::OpenOptions::new().write(true).open(store_path()).expect("이웃의 열기");
    assert!(rotate("mine@x", "m-2"), "전제 — 커밋이 정착했다");
    land(held, &body);

    let g = gone_within("ghost@x", 1500);
    println!(
        "[casx2-keep3] 평범한 매장 로그아웃이 살았나 = {g:?}ms · 장부(지연={} 근거못짚음={} 되살릴것없음={})",
        claude::bury_stats::late(),
        claude::bury_stats::refused(),
        claude::bury_stats::late_kept()
    );
    let _ = std::fs::remove_dir_all(&home);
}
