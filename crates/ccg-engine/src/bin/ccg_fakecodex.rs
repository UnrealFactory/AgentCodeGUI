//! **가짜 `codex app-server`** — 하네스가 codex 실행본 자리에 꽂는 JSON-RPC 스텁.
//! 기본 빌드에 없다(`--features fakecli`, `ccg-fakecli`와 같은 규약).
//!
//! 왜 필요한가: M5 실측으로 **실홈의 codex 계정은 0건**이다. 로그인 없이는 실
//! `codex app-server`가 첫 턴에서 죽으므로, 스트리밍·승인·질문·백그라운드 터미널이
//! 화면까지 도달하는지를 **제품 경로 그대로**(스폰 → stdout JSONL → CodexDriver →
//! 상태기계 → wire → 렌더러) 밟을 방법이 없다. 이 스텁이 그 길을 연다.
//!
//! 대본은 `CCG_FAKECODEX_SCRIPT`(파일 경로)의 JSONL이다. 한 줄 = 한 지시:
//!
//! ```jsonc
//! {"await":"initialize","result":{}}          // 그 method 요청을 기다렸다가 결과로 응답
//! {"await":"turn/start","error":"…"}          // 오류로 응답
//! {"emit":{...}}                              // 알림/서버요청을 그대로 stdout에
//! {"emit":{...},"afterMs":120}                // 앞 지시 뒤 120ms 기다렸다가
//! {"awaitResponse":7}                         // 그 id의 클라이언트 응답을 기다린다
//! {"exit":0}                                  // 종료
//! ```
//!
//! 받은 줄은 전부 `CCG_FAKECODEX_IN`(있으면)에 그대로 덧붙인다 — 하네스가
//! "우리가 무엇을 돌려보냈나"를 바이트로 확인한다.

use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

fn main() {
    let script = std::env::var("CCG_FAKECODEX_SCRIPT").unwrap_or_default();
    let inlog = std::env::var("CCG_FAKECODEX_IN").ok();
    let rx = spawn_stdin_reader(inlog);
    let text = std::fs::read_to_string(&script).unwrap_or_default();
    let mut seen: Vec<Value> = vec![];
    let out = std::io::stdout();

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("//") {
            continue;
        }
        let Ok(step) = serde_json::from_str::<Value>(line) else { continue };
        if let Some(ms) = step.get("afterMs").and_then(Value::as_u64) {
            std::thread::sleep(Duration::from_millis(ms));
        }
        if let Some(method) = step.get("await").and_then(Value::as_str) {
            let Some(req) = wait_for(&rx, &mut seen, Duration::from_secs(120), |v| {
                v.get("method").and_then(Value::as_str) == Some(method) && v.get("id").is_some()
            }) else {
                continue;
            };
            let id = req.get("id").cloned().unwrap_or(Value::Null);
            let body = match step.get("error").and_then(Value::as_str) {
                Some(e) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": e } }),
                None => json!({ "jsonrpc": "2.0", "id": id,
                                "result": step.get("result").cloned().unwrap_or(json!({})) }),
            };
            let mut h = out.lock();
            let _ = writeln!(h, "{body}");
            let _ = h.flush();
        }
        if let Some(want) = step.get("awaitResponse") {
            let want = want.clone();
            wait_for(&rx, &mut seen, Duration::from_secs(120), |v| {
                v.get("id") == Some(&want) && v.get("method").is_none()
            });
        }
        if let Some(frame) = step.get("emit") {
            let mut h = out.lock();
            let _ = writeln!(h, "{frame}");
            let _ = h.flush();
        }
        if let Some(code) = step.get("exit").and_then(Value::as_i64) {
            std::process::exit(code as i32);
        }
    }
    // 대본이 끝나도 바로 죽지 않는다 — stdin EOF(앱이 close_input)까지 산다.
    // 그래야 "정상 종료"와 "스트림 급사"를 하네스가 따로 연출할 수 있다.
    loop {
        match rx.recv_timeout(Duration::from_secs(1)) {
            Ok(_) => {}
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

fn spawn_stdin_reader(log: Option<String>) -> Receiver<Value> {
    let (tx, rx) = channel::<Value>();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        for l in stdin.lock().lines().map_while(Result::ok) {
            if let Some(p) = &log {
                if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
                    let _ = writeln!(f, "{l}");
                }
            }
            let Ok(v) = serde_json::from_str::<Value>(&l) else { continue };
            if tx.send(v).is_err() {
                return;
            }
        }
    });
    rx
}

/// 조건에 맞는 줄이 올 때까지. **이미 지나간 줄도 본다**(대본 순서와 도착 순서가 다를 수 있다).
fn wait_for(
    rx: &Receiver<Value>,
    seen: &mut Vec<Value>,
    cap: Duration,
    hit: impl Fn(&Value) -> bool,
) -> Option<Value> {
    if let Some(i) = seen.iter().position(&hit) {
        return Some(seen.remove(i));
    }
    let deadline = Instant::now() + cap;
    while Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(v) => {
                if hit(&v) {
                    return Some(v);
                }
                seen.push(v);
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return None,
        }
    }
    None
}
