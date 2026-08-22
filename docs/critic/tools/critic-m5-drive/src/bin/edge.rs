//! 잡공격 — 스토어 버전 표기·usage 캐시 관대성·pretty JSON 바이트 동치.
use serde_json::{json, Value};

fn home() -> std::path::PathBuf {
    ccg_auth::app_home()
}
fn w(rel: &str, s: &str) {
    let p = home().join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, s).unwrap();
}

fn main() {
    std::env::var("CCG_HOME").expect("CCG_HOME");
    let _ = std::fs::remove_dir_all(home());
    std::fs::create_dir_all(home()).unwrap();

    // 1) version 표기 갈래 — JS는 3.0 === 3
    for v in ["3", "3.0", "\"3\"", "2", "2.0", "4"] {
        w("accounts.json", &format!("{{\"version\": {v}, \"accounts\": [{{\"email\":\"a@x.com\",\"credEnc\":\"X\"}}]}}"));
        let f = ccg_auth::claude::read_store_file();
        println!("version={v:6} -> accounts={} (JS는 3/3.0/2/2.0에서 1건)", f.accounts.len());
    }

    // 2) usage 캐시 관대성 — 2.6.2의 4키 폴백형 / at 없음 / 알 수 없는 키
    w(
        "usage-cache.json",
        &json!({
            "a@x.com": { "at": 1, "data": { "email": "a@x.com", "fiveHourPct": null, "weeklyPct": 3, "fablePct": null } },
            "b@x.com": { "data": { "email": "b@x.com", "fiveHourPct": 1, "weeklyPct": 1, "fablePct": 1 } },
            "c@x.com": { "at": 2, "data": { "email": "c@x.com", "fiveHourPct": 1, "weeklyPct": 1, "fablePct": 1, "fiveHourResetsAt": 9, "weeklyResetsAt": null, "fableResetsAt": null, "futureKey": 7 } },
            "d@x.com": { "at": 3, "data": null },
            "e@x.com": { "at": 4, "data": { "email": "e@x.com", "fiveHourPct": 93.4, "weeklyPct": 1, "fablePct": 1 } }
        })
        .to_string(),
    );
    let c = ccg_auth::usage::read_usage_cache();
    let mut keys: Vec<&String> = c.keys().collect();
    keys.sort();
    println!("usage cache 읽힌 키 = {keys:?}  (2.6.2는 a,b,c,e 4건 — data가 있으면 받는다)");

    // 3) to_json_2space vs JSON.stringify(_,null,2) — 까다로운 값들
    let nasty = json!({
        "ko": "한글 값 — 이모지 🙂",
        "esc": "quote\" back\\ slash/ tab\t nl\n cr\r bs\u{8} ff\u{c} ctrl\u{1}",
        "u2028": "line\u{2028}sep\u{2029}",
        "nums": [0, -0.5, 1e21, 1.5e-7, 9007199254740991i64, 1787410867317i64],
        "nested": { "empty_obj": {}, "empty_arr": [], "null": null, "t": true },
        "키": "비ASCII 키"
    });
    std::fs::write(home().join("nasty.json"), ccg_auth::to_json_2space(&nasty)).unwrap();
    println!("nasty.json {}B", ccg_auth::to_json_2space(&nasty).len());

    // 4) 슬러그 — 비ASCII/대문자/긴 것
    for e in ["A.B+tag@Example.COM", "한글@x.com", "a@x.com", "  spaced  @x.com", "UPPER@X.COM", "a..b@x.com", "+@+"] {
        println!("slug {e:?} -> {}", ccg_auth::account_slug(e));
    }

    // 5) apply_refresh 숫자 표기
    let base = json!({ "claudeAiOauth": { "accessToken": "o", "refreshToken": "r", "expiresAt": 1.0 } }).to_string();
    println!("apply_refresh -> {}", ccg_auth::claude::apply_refresh(&base, "n", None, 3600.0, 1_787_000_000_000.0).unwrap());

    // 6) creds_expires_at — 문자열 expiresAt / 없는 필드
    for raw in [
        r#"{"claudeAiOauth":{"accessToken":"t","expiresAt":"123"}}"#,
        r#"{"claudeAiOauth":{"accessToken":"t"}}"#,
        r#"{"claudeAiOauth":{"accessToken":""}}"#,
        r#"{"claudeAiOauth":{}}"#,
        r#"{}"#,
        r#"nope"#,
        r#"{"claudeAiOauth":{"accessToken":"t","expiresAt":1.5}}"#,
    ] {
        println!("credsExpiresAt {raw} -> {}", ccg_auth::claude::creds_expires_at(Some(raw)));
    }
    let _: Value = json!(null);
}
