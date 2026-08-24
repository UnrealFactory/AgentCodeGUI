//! **가짜 `claude.exe`** — 하네스가 격리 홈의 엔진 자리에 꽂는 스텁. 기본 빌드에 없다
//! (`--features fakecli`). 실 CLI로는 값이 비싸거나 강제할 수 없는 경로를 $0에 밟는다.
//!
//! 왜 필요한가: `request_user_dialog`(폴백 확인)는 **모델이 응답을 거부해야** 오는
//! 프레임이라 라이브로 강제할 수가 없다. 그래서 R1은 이 경로를 코드 대조로만 남겼고,
//! 크리틱이 "kill 없이도 같은 영구 정지에 도달한다"고 지적했다(배선 R1 §3).
//! 스텁이 그 프레임을 **제품 경로 그대로**(spawn → stdout JSONL → 상태기계 → wire →
//! 렌더러 카드 → 응답 → stdin) 흘려 준다.
//!
//! 대본은 `CCG_FAKECLI_SCRIPT`(파일 경로)의 JSONL이다. 한 줄 = 한 지시:
//!
//! ```jsonc
//! {"emit": {...프레임...}}              // stdout으로 그대로 흘린다
//! {"emit": {...}, "afterMs": 300}       // 앞선 지시 뒤 300ms 기다렸다가
//! {"awaitResponse": "dlg-1"}            // 그 request_id의 control_response를 기다린다
//! {"exit": 0}                           // 종료(코드)
//! ```
//!
//! 받은 stdin 줄은 전부 `CCG_FAKECLI_IN`(있으면)에 그대로 덧붙인다 — 하네스가
//! "우리가 무엇을 돌려보냈나"를 바이트로 확인한다.
//!
//! ## ★M11 — **계정마다 다른 대본**
//!
//! 자동 계정 전환은 "A로는 막히고 B로는 된다"가 재현돼야 검증된다. 그런데 스텁은
//! 스폰마다 새 프로세스라 대본 하나로는 두 답을 낼 수 없다. 그래서 형제 파일을 본다:
//!
//! ```text
//!   CCG_FAKECLI_SCRIPT = …/fake.jsonl
//!   CLAUDE_CONFIG_DIR  = …/accounts/a_ccg.test     →  …/fake.a_ccg.test.jsonl 이 있으면 그것
//!                                                     없으면 …/fake.jsonl (지금까지의 동작)
//! ```
//!
//! 기존 하네스는 형제 파일을 안 만드니 **한 글자도 안 바뀐다.**

use std::io::{BufRead, Write};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::time::Duration;

/// ★M11 — `…/fake.jsonl` + `CLAUDE_CONFIG_DIR` 꼬리 → `…/fake.<slug>.jsonl`(있으면).
/// 없으면 원래 경로 그대로다(기존 하네스 무영향).
fn per_account_script(script: &str) -> String {
    let Ok(dir) = std::env::var("CLAUDE_CONFIG_DIR") else { return script.to_string() };
    let slug = dir.trim_end_matches(['\\', '/']).rsplit(['\\', '/']).next().unwrap_or_default();
    if slug.is_empty() {
        return script.to_string();
    }
    let per = match script.rsplit_once('.') {
        Some((stem, ext)) => format!("{stem}.{slug}.{ext}"),
        None => format!("{script}.{slug}"),
    };
    if std::path::Path::new(&per).exists() {
        per
    } else {
        script.to_string()
    }
}

fn main() {
    let script = std::env::var("CCG_FAKECLI_SCRIPT").unwrap_or_default();
    let inlog = std::env::var("CCG_FAKECLI_IN").ok();
    // ★T3T4 R3 — **받은 argv를 적는다**(옵트인). `git:ai-message`의 계약은 프롬프트가
    // 아니라 플래그에 있다(`--max-turns 1`이 "1턴"의 전부다) — 그걸 하네스가 바이트로
    // 확인할 자리가 없으면 "보냈다고 주장하는 코드"만 남는다. 이 변수를 안 주면
    // 한 글자도 안 바뀐다(기존 하네스 무영향).
    if let Ok(p) = std::env::var("CCG_FAKECLI_ARGV") {
        if !p.is_empty() {
            let argv: Vec<String> = std::env::args().skip(1).collect();
            let _ = std::fs::write(&p, serde_json::to_string(&argv).unwrap_or_default());
        }
    }
    let rx = spawn_stdin_reader(inlog);

    let text = std::fs::read_to_string(per_account_script(&script)).unwrap_or_default();
    let mut seen: Vec<String> = vec![];
    let out = std::io::stdout();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("//") {
            continue;
        }
        let Ok(step) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if let Some(ms) = step.get("afterMs").and_then(|v| v.as_u64()) {
            std::thread::sleep(Duration::from_millis(ms));
        }
        if let Some(want) = step.get("awaitResponse").and_then(|v| v.as_str()) {
            wait_for(&rx, &mut seen, want, Duration::from_secs(120));
        }
        if let Some(frame) = step.get("emit") {
            let mut h = out.lock();
            let _ = writeln!(h, "{frame}");
            let _ = h.flush();
        }
        if let Some(code) = step.get("exit").and_then(|v| v.as_i64()) {
            std::process::exit(code as i32);
        }
    }
    // 대본이 끝나도 바로 죽지 않는다 — stdin EOF(앱이 close_input)까지 산다.
    // 그래야 "정상 종료"와 "스트림 급사"를 하네스가 따로 연출할 수 있다.
    while rx.recv_timeout(Duration::from_secs(1)).is_ok() || !is_closed(&rx) {}
}

fn is_closed(rx: &Receiver<String>) -> bool {
    matches!(rx.recv_timeout(Duration::from_millis(1)), Err(RecvTimeoutError::Disconnected))
}

fn spawn_stdin_reader(log: Option<String>) -> Receiver<String> {
    let (tx, rx) = channel::<String>();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        for l in stdin.lock().lines().map_while(Result::ok) {
            if let Some(p) = &log {
                if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
                    let _ = writeln!(f, "{l}");
                }
            }
            if tx.send(l).is_err() {
                return;
            }
        }
    });
    rx
}

/// 그 `request_id`의 `control_response`가 올 때까지. 이미 지나간 줄도 본다.
fn wait_for(rx: &Receiver<String>, seen: &mut Vec<String>, request_id: &str, cap: Duration) {
    let hit = |l: &str| {
        serde_json::from_str::<serde_json::Value>(l)
            .ok()
            .filter(|v| v["type"] == "control_response")
            .map(|v| v["response"]["request_id"] == serde_json::json!(request_id))
            .unwrap_or(false)
    };
    if seen.iter().any(|l| hit(l)) {
        return;
    }
    let deadline = std::time::Instant::now() + cap;
    while std::time::Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(l) => {
                let ok = hit(&l);
                seen.push(l);
                if ok {
                    return;
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}
