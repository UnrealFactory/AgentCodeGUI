//! ★M11 R1 크리틱 — **native-tls 치환본이 정말 핸드셰이크를 하는가.** 실 HTTP **1건**.
//!
//! §6의 제안 diff(`ureq` features `tls` → `native-tls` + `AgentBuilder::tls_connector`)를
//! 적용한 워크트리에서만 의미가 있다. 무인증 GET 하나뿐이다 — Authorization 헤더 없음,
//! 토큰 없음, 쓰기 없음. 토큰 엔드포인트에 GET을 던지므로 **405가 정답**이고, 그게 곧
//! "TLS는 성립했고 HTTP도 왕복했다"는 증거다.
//!
//! ```text
//! cp docs/critic/tools/critic-m11-tls.rs <wt>/crates/ccg-auth/tests/critic_m11_tls.rs
//! CCG_CRITIC_LIVE_TLS=1 CARGO_TARGET_DIR=%TEMP%/… \
//!   cargo test -p ccg-auth --features cli --test critic_m11_tls -- --nocapture
//! ```
//! 실측(2026-08-23, schannel): `status=405 elapsed=258ms bodyLen=132`.
#![cfg(feature = "net")]
use ccg_auth::{net, HttpRequest};

#[test]
fn native_tls_completes_a_handshake_against_the_real_host() {
    // 기본은 **안 돈다** — 자동 주행이 실 네트워크를 건드리면 안 된다.
    if std::env::var("CCG_CRITIC_LIVE_TLS").is_err() {
        eprintln!("skip — CCG_CRITIC_LIVE_TLS 미설정");
        return;
    }
    std::env::remove_var("CCG_NO_NET");
    let req = HttpRequest {
        method: "GET",
        url: "https://console.anthropic.com/v1/oauth/token".into(),
        headers: vec![],
        body: None,
        timeout_ms: 10_000,
    };
    let t0 = std::time::Instant::now();
    match net::send(&req) {
        Ok(r) => println!("[TLS] status={} elapsed={}ms bodyLen={}", r.status, t0.elapsed().as_millis(), r.body.len()),
        Err(e) => panic!("[TLS] 핸드셰이크/전송 실패: {e}"),
    }
}
