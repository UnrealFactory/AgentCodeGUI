//! 계정 스토어 진단 프로브 — 리포트/크리틱 재현용 CLI. 앱 번들에는 안 들어간다
//! (`--features cli`에서만 빌드된다).
//!
//! ```text
//! CCG_HOME=<scratch> cargo run -p ccg-auth --features cli --bin ccg-auth-probe -- diagnose
//! CCG_HOME=<scratch> cargo run -p ccg-auth --features cli --bin ccg-auth-probe -- roundtrip
//! CCG_HOME=<scratch> … -- seed a@x b@x            # ★M11 하네스용 **합성 계정** 심기
//! CCG_HOME=<scratch> … -- seed-dup dirty@x a@x    # 같은 토큰 두 이름 = 오염 재현
//! ```
//!
//! **안전장치**: ① `CCG_HOME`이 없으면 실행을 거부한다(사용자 실홈을 절대 안 건드린다).
//! ② 출력에 토큰·이메일 원문이 없다 — 전부 sha256 앞 12자 지문이다.
//! ③ ~~네트워크 호출은 크레이트에 아예 없다~~ → **★M11 정정**: `cli` 피처가 `net`을
//!    켜므로 이 바이너리에는 실행기가 있다. 그러나 **읽기 1건**(`usage`)뿐이고, 그것도
//!    사람이 손으로 부를 때만이며, `CCG_NO_NET=1`이면 즉시 거절된다. 토큰 리프레시는
//!    하지 않는다(서버 회전 = 원본 홈의 토큰 사망) — `usage_once`의 계약을 보라.

use serde_json::{json, Value};

fn main() {
    let Ok(home) = std::env::var("CCG_HOME") else {
        eprintln!("CCG_HOME이 필요합니다 — 실홈에서 돌리지 마세요(복사본 경로를 주세요).");
        std::process::exit(2);
    };
    let cmd = std::env::args().nth(1).unwrap_or_else(|| "diagnose".into());
    match cmd.as_str() {
        "diagnose" => println!("{}", serde_json::to_string_pretty(&diagnose(&home)).unwrap()),
        "roundtrip" => println!("{}", serde_json::to_string_pretty(&roundtrip()).unwrap()),
        // ★M11 하네스 — 격리 홈에 **합성 계정**을 심는다. 실계정 복사가 아니다:
        // 토큰은 이 자리에서 만든 가짜 문자열이고, 어느 서버에도 유효하지 않다.
        // (그래서 M11 재생이 사용자 자격증명 없이 · 네트워크 없이 돌 수 있다.)
        "seed" => println!("{}", serde_json::to_string_pretty(&seed(&std::env::args().skip(2).collect::<Vec<_>>(), false)).unwrap()),
        // 같은 토큰을 **두 이름으로** 심는다 = 오염(`token_collision`)의 실물 재현.
        // 첫 인자가 오염된 쪽, 나머지는 평범한 계정이다.
        "seed-dup" => println!("{}", serde_json::to_string_pretty(&seed(&std::env::args().skip(2).collect::<Vec<_>>(), true)).unwrap()),
        // ★M11 — **실 조회 1건**(`GET /api/oauth/usage`). 예산이 있으므로 손으로만 부른다.
        "usage" => println!("{}", serde_json::to_string_pretty(&usage_once(std::env::args().nth(2).as_deref())).unwrap()),
        other => {
            eprintln!("알 수 없는 명령: {other} (diagnose | roundtrip | seed | seed-dup | usage)");
            std::process::exit(2);
        }
    }
}

/// 합성 계정 심기 — `accounts.json`에 **복호 가능한** 스냅샷을 넣는다.
///
/// `dup`이면 **첫 계정만** 다른 계정과 같은 토큰을 쓴다(오염가드가 `Contaminated`로
/// 걸러야 하는 그 모양 — 이름표만 다르고 실토큰은 하나다).
/// 만료는 먼 미래라 `preflight`가 `Probe`(= 후보 가능)를 낸다.
fn seed(emails: &[String], dup: bool) -> Value {
    if emails.is_empty() {
        eprintln!("seed <email> [<email>…]");
        std::process::exit(2);
    }
    let far_future = 4_000_000_000_000f64; // ms — 2096년
    let mut rows = vec![];
    let mut accounts: Vec<Value> = ccg_auth::claude::read_store_file().accounts.clone();
    for (i, email) in emails.iter().enumerate() {
        // `dup`이면 0번이 1번의 토큰을 그대로 쓴다.
        let owner = if dup && i == 0 { emails.get(1).unwrap_or(email) } else { email };
        let creds = json!({
            "claudeAiOauth": {
                "accessToken": format!("synthetic-{owner}"),
                "refreshToken": format!("synthetic-refresh-{owner}"),
                "expiresAt": far_future,
                "scopes": ["user:inference"],
            }
        })
        .to_string();
        let snap = json!({ "creds": creds, "account": { "emailAddress": email, "uuid": format!("u-{email}") } });
        let Some(enc) = ccg_store::safe_storage::encrypt(&snap.to_string()) else {
            eprintln!("safeStorage 암호화 불가 — 이 환경에서는 합성 계정을 못 심습니다");
            std::process::exit(3);
        };
        accounts.retain(|a| ccg_auth::claude::email_of(a) != Some(email.as_str()));
        accounts.push(json!({ "email": email, "credEnc": enc, "subscriptionType": "max" }));
        rows.push(json!({ "email": email, "tokenOwner": owner, "dup": dup && i == 0 }));
    }
    let default = emails[0].clone();
    ccg_auth::claude::write_store_file(&accounts, Some(&default)).expect("스토어 저장");
    json!({ "seeded": rows, "default": default, "total": ccg_auth::claude::list_accounts().len(),
            "preflight": emails.iter().map(|e| json!({
                "email": e,
                "verdict": format!("{:?}", ccg_auth::verify::preflight(e).verdict),
            })).collect::<Vec<_>>() })
}

fn diagnose(home: &str) -> Value {
    let f = ccg_auth::claude::read_store_file();
    let rows: Vec<Value> = ccg_auth::claude::diagnose()
        .into_iter()
        .map(|a| {
            json!({
                "emailFp": ccg_auth::token_fingerprint(&a.email),
                "slug": ccg_auth::account_slug(&a.email),
                "subscriptionType": a.subscription_type,
                "isDefault": a.is_default,
                "decrypted": a.decrypted,
                "snapshotOk": a.snapshot_ok,
                "backupFp": a.backup_fp,
                "backupExpiresAt": a.backup_expires_at,
                "dirPresent": a.dir_present,
                "dirFp": a.dir_fp,
                "dirExpiresAt": a.dir_expires_at,
                "junctions": a.junctions,
                "collidesWith": a.collides_with.as_deref().map(ccg_auth::token_fingerprint),
                "resyncPending": a.resync_pending,
            })
        })
        .collect();
    json!({
        "home": home,
        "writeScheme": ccg_store::safe_storage::write_scheme(),
        "encryptionAvailable": ccg_store::safe_storage::available(),
        "claude": { "version": f.version, "hasDefault": f.default_email.is_some(), "accounts": f.accounts.len(), "rows": rows },
        "codex": {
            "version": ccg_auth::codex::read_store_file().version,
            "accounts": ccg_auth::codex::read_store_file().accounts.len(),
        },
    })
}

/// 읽고 그대로 되쓴 뒤 바이트가 같은지 — 2.6.2 롤백 경로의 기계적 판정.
fn roundtrip() -> Value {
    let home = ccg_store::app_home();
    let mut out = serde_json::Map::new();
    {
        let p = home.join(ccg_auth::claude::STORE_FILE);
        let before = std::fs::read_to_string(&p).ok();
        let f = ccg_auth::claude::read_store_file();
        ccg_auth::claude::write_store_file(&f.accounts, f.default_email.as_deref()).expect("스토어 저장");
        let after = std::fs::read_to_string(&p).ok();
        out.insert(
            "accounts.json".into(),
            json!({ "versionIn": f.version, "accounts": f.accounts.len(), "identical": before == after,
                    "bytesIn": before.as_ref().map(String::len), "bytesOut": after.as_ref().map(String::len) }),
        );
    }
    {
        let p = home.join(ccg_auth::codex::STORE_FILE);
        let before = std::fs::read_to_string(&p).ok();
        let f = ccg_auth::codex::read_store_file();
        ccg_auth::codex::write_store_file(&f.accounts, f.default_email.as_deref());
        let after = std::fs::read_to_string(&p).ok();
        out.insert(
            "codex-accounts.json".into(),
            json!({ "accounts": f.accounts.len(), "identical": before == after,
                    "bytesIn": before.as_ref().map(String::len), "bytesOut": after.as_ref().map(String::len) }),
        );
    }
    Value::Object(out)
}

/// ★M11 — `net.rs`의 실행기가 **정말 도는가**를 실 계정 1건으로 잰다.
///
/// 왜 손으로만 부르나: 구독 한도 API는 공짜지만 레이트리밋이 빡빡하고(같은 IP 병렬
/// 2건 중 1건이 429 — M5 R1 실측), 무엇보다 **자동 주행이 실계정을 건드리면 안 된다**.
/// 그래서 이 명령은 하네스가 아니라 사람이 부른다.
///
/// **리프레시하지 않는다**가 이 함수의 계약이다. 액세스 토큰이 이미 만료됐으면
/// `skipped: token_expired`로 끝낸다 — 교환은 refresh 토큰을 **서버에서 회전**시켜서,
/// 복사본 홈에서 돌리면 원본 홈의 토큰이 그 순간 죽는다(되돌릴 수 없는 부작용).
fn usage_once(email: Option<&str>) -> Value {
    let Some(email) = email.map(str::to_string).or_else(ccg_auth::claude::default_account_email) else {
        return json!({ "error": "계정이 없습니다 — CCG_HOME에 accounts.json을 복사했나요?" });
    };
    if ccg_auth::net::disabled() {
        return json!({ "email": ccg_auth::token_fingerprint(&email), "skipped": "CCG_NO_NET" });
    }
    let Some(_tok) = ccg_auth::claude::account_access_token(&email) else {
        return json!({ "email": ccg_auth::token_fingerprint(&email), "skipped": "token_expired",
                       "note": "리프레시는 refresh 토큰을 서버에서 회전시킨다 — 복사본에서 하지 않는다" });
    };
    let t0 = std::time::Instant::now();
    let got = ccg_auth::net::fetch_account_usage(&email);
    // 출력에 이메일 원문·토큰은 없다(이 파일의 안전장치 ②).
    json!({
        "email": ccg_auth::token_fingerprint(&email),
        "elapsedMs": t0.elapsed().as_millis() as u64,
        "result": match got {
            Ok(u) => json!({ "ok": true, "fiveHourPct": u.five_hour_pct, "fiveHourResetsAt": u.five_hour_resets_at,
                             "weeklyPct": u.weekly_pct, "weeklyResetsAt": u.weekly_resets_at,
                             "fablePct": u.fable_pct, "fableResetsAt": u.fable_resets_at }),
            Err(e) => json!({ "ok": false, "error": e.to_string() }),
        },
    })
}
