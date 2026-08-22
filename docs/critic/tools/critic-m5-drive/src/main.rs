//! M5 R1 크리틱 — 쓰기 경로 공격 드라이버. ccg-auth의 **공개 API로만** 스토어를 바꾸고,
//! 그 산출물을 2.6.2(Electron safeStorage) 하네스가 읽는다. CCG_HOME 필수.

use serde_json::{json, Value};

fn main() {
    let home = std::env::var("CCG_HOME").expect("CCG_HOME 필수");
    let cmd = std::env::args().nth(1).unwrap_or_default();
    eprintln!("[drive] home={home} cmd={cmd}");
    match cmd.as_str() {
        // 계정 추가 — 로그인 완료 경로(ImportGuard::None)
        "add" => {
            let dir = std::path::PathBuf::from(std::env::var("SRC_DIR").expect("SRC_DIR"));
            let email = std::env::var("EMAIL").expect("EMAIL");
            let r = ccg_auth::claude::import_account_from_dir(&dir, &email, Some("max"), ccg_auth::claude::ImportGuard::None);
            println!("{}", json!({ "import": format!("{r:?}") }));
        }
        "reorder" => {
            let emails: Vec<String> = std::env::var("EMAILS").unwrap().split(',').map(str::to_string).collect();
            let out = ccg_auth::claude::reorder_accounts(&emails);
            println!("{}", json!({ "order": out.iter().map(|a| a.email.clone()).collect::<Vec<_>>() }));
        }
        "setdefault" => {
            let e = std::env::var("EMAIL").unwrap();
            let out = ccg_auth::claude::set_default_account(&e);
            println!("{}", json!({ "default": out.iter().find(|a| a.is_default).map(|a| a.email.clone()) }));
        }
        "remove" => {
            let e = std::env::var("EMAIL").unwrap();
            let out = ccg_auth::claude::remove_account(&e);
            println!("{}", json!({ "left": out.len() }));
        }
        // 되싱크(재암호화) — 계정 폴더에 더 신선한 토큰을 만들어 놓고 백업을 갱신시킨다
        "resync" => {
            let e = std::env::var("EMAIL").unwrap();
            println!("{}", json!({ "resynced": ccg_auth::claude::sync_account_tokens(&e) }));
        }
        "materialize" => {
            let e = std::env::var("EMAIL").unwrap();
            let d = ccg_auth::claude::account_run_dir(&e);
            println!("{}", json!({ "dir": format!("{d:?}") }));
        }
        // v2 → v3 승격(읽고 되쓰기)
        "promote" => {
            let f = ccg_auth::claude::read_store_file();
            ccg_auth::claude::write_store_file(&f.accounts, f.default_email.as_deref());
            println!("{}", json!({ "versionIn": f.version, "accounts": f.accounts.len() }));
        }
        // 오염 공격: 같은 토큰을 두 이메일에 심고 preflight를 양쪽으로 부른다
        "contamination" => {
            let a = std::env::var("A").unwrap();
            let b = std::env::var("B").unwrap();
            let pa = ccg_auth::verify::preflight(&a);
            let pb = ccg_auth::verify::preflight(&b);
            let d = ccg_auth::claude::diagnose();
            println!(
                "{}",
                json!({
                    "preflightA": format!("{:?}", pa.verdict), "probeA": pa.probe.is_some(),
                    "preflightB": format!("{:?}", pb.verdict), "probeB": pb.probe.is_some(),
                    "diagnose": d.iter().map(|x| json!({ "email": x.email, "collides": x.collides_with })).collect::<Vec<_>>(),
                })
            );
        }
        "dump" => {
            let f = ccg_auth::claude::read_store_file();
            println!(
                "{}",
                json!({
                    "version": f.version,
                    "default": f.default_email,
                    "emails": f.accounts.iter().filter_map(|a| ccg_auth::claude::email_of(a).map(str::to_string)).collect::<Vec<_>>(),
                })
            );
        }
        // 임의 계정 심기(합성) — creds/account를 직접 준다
        "seed" => {
            let spec: Value = serde_json::from_str(&std::env::var("SEED_JSON").unwrap()).unwrap();
            let mut accounts = Vec::new();
            for s in spec.as_array().unwrap() {
                let snap = json!({ "creds": s["creds"].as_str().unwrap(), "account": s["account"], "userID": "uid" });
                let enc = ccg_store::safe_storage::encrypt(&snap.to_string()).unwrap();
                accounts.push(json!({ "email": s["email"], "subscriptionType": "max", "credEnc": enc }));
            }
            ccg_auth::claude::write_store_file(&accounts, None);
            println!("{}", json!({ "seeded": accounts.len() }));
        }
        other => panic!("unknown cmd {other}"),
    }
}
