//! stdin의 JSON 배열(응답 본문들)을 ccg-auth 파서에 통과시켜 결과 배열을 낸다.
use serde_json::{json, Value};
use std::io::Read;

fn main() {
    let mut s = String::new();
    std::io::stdin().read_to_string(&mut s).unwrap();
    let bodies: Vec<Value> = serde_json::from_str(&s).unwrap();
    let out: Vec<Value> = bodies
        .iter()
        .map(|b| {
            let a = ccg_auth::usage::parse_account_usage("e@x.com", b);
            let u = ccg_auth::usage::parse_usage_info(b);
            json!({ "account": a, "info": u })
        })
        .collect();
    println!("{}", serde_json::to_string(&out).unwrap());
}
