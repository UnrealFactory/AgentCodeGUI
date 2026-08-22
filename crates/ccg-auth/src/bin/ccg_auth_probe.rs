//! 계정 스토어 진단 프로브 — 리포트/크리틱 재현용 CLI. 앱 번들에는 안 들어간다
//! (`--features cli`에서만 빌드된다).
//!
//! ```text
//! CCG_HOME=<scratch> cargo run -p ccg-auth --features cli --bin ccg-auth-probe -- diagnose
//! CCG_HOME=<scratch> cargo run -p ccg-auth --features cli --bin ccg-auth-probe -- roundtrip
//! ```
//!
//! **안전장치 둘**: ① `CCG_HOME`이 없으면 실행을 거부한다(사용자 실홈을 절대 안 건드린다).
//! ② 출력에 토큰·이메일 원문이 없다 — 전부 sha256 앞 12자 지문이다.
//! ③ 네트워크 호출은 크레이트에 아예 없다.

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
        other => {
            eprintln!("알 수 없는 명령: {other} (diagnose | roundtrip)");
            std::process::exit(2);
        }
    }
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
        ccg_auth::claude::write_store_file(&f.accounts, f.default_email.as_deref());
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
