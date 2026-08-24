//! ★M11 **R2 확인 크리틱** — native-tls(schannel)가 **인증서를 정말 검증하는가.**
//!
//! R1은 "핸드셰이크가 성립한다"(405)까지만 봤다. 성립은 검증의 증거가 아니다 —
//! 검증을 끈 커넥터도 405를 받는다. 그래서 이 파일은 **틀린 인증서에 붙여 실패하는지**를
//! 본다. 실 HTTP 최대 2건(무인증 GET · Authorization 헤더 없음 · 쓰기 없음).
//!
//! ```text
//! cp docs/critic/tools/critic-m11r2-tls.rs <wt>/crates/ccg-auth/tests/critic_m11r2_tls.rs
//! CCG_CRITIC_LIVE_TLS=1 CARGO_TARGET_DIR=%TEMP%/… \
//!   cargo test -p ccg-auth --features cli --test critic_m11r2_tls -- --nocapture --test-threads=1
//! ```
#![cfg(feature = "net")]
use ccg_auth::{net, HttpRequest};

fn get(url: &str) -> Result<net::HttpResponse, net::NetError> {
    net::send(&HttpRequest { method: "GET", url: url.into(), headers: vec![], body: None, timeout_ms: 12_000 })
}

/// ① 양성 대조 — 진짜 호스트에는 붙는다(405 = TLS 성립 + HTTP 왕복).
/// ② 음성 대조 — **호스트 이름이 틀린 인증서**에는 붙으면 안 된다.
#[test]
fn schannel_verifies_certificates_not_just_handshakes() {
    if std::env::var("CCG_CRITIC_LIVE_TLS").is_err() {
        eprintln!("skip — CCG_CRITIC_LIVE_TLS 미설정(기본은 네트워크 0건)");
        return;
    }
    std::env::remove_var("CCG_NO_NET");

    let t0 = std::time::Instant::now();
    let good = get("https://console.anthropic.com/v1/oauth/token");
    match &good {
        Ok(r) => println!("[TLS+] status={} elapsed={}ms bodyLen={}", r.status, t0.elapsed().as_millis(), r.body.len()),
        Err(e) => println!("[TLS+] 실패={e}"),
    }

    // 이 호스트의 인증서는 `*.badssl.com`이 아니라 **다른 이름**으로 발급돼 있다.
    let t1 = std::time::Instant::now();
    let bad = get("https://wrong.host.badssl.com/");
    match &bad {
        Ok(r) => println!("[TLS-] ★ 붙었다 status={} elapsed={}ms — 검증이 안 선다", r.status, t1.elapsed().as_millis()),
        Err(e) => println!("[TLS-] 거절됨(정상)={e}  elapsed={}ms", t1.elapsed().as_millis()),
    }

    let good_s = good.as_ref().map(|r| r.status).map_err(|e| e.to_string());
    let bad_s = bad.as_ref().map(|r| r.status).map_err(|e| e.to_string());
    assert!(matches!(good, Ok(ref r) if r.status == 405), "양성 대조가 안 선다(네트워크 문제일 수 있다): {good_s:?}");
    assert!(
        matches!(bad, Err(net::NetError::Transport(_))),
        "★ 호스트 이름이 틀린 인증서에 그대로 붙었다 = 인증서 검증이 꺼져 있다: {bad_s:?}"
    );
}
