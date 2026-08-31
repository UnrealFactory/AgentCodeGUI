//! `ccg-lspidle` — **수명 시나리오**를 크레이트에서 바로 도는 프로브(★LSPIDLE R1).
//!
//! ```text
//! cargo run -p ccg-lsp --features cli --bin ccg-lspidle -- <cwd> <상대경로>
//! ```
//!
//! 왜 따로 두는가: 이 라운드의 주장은 **프로세스가 있느냐 없느냐**다. 그런데 앱 전체를
//! 띄우고 재면 유휴 프로세스 표에 웹뷰·GPU·타이머가 섞여, 「헬퍼가 0이다」와 「측정이
//! 헬퍼를 못 봤다」를 못 가른다(그 혼동이 실제로 §「2.6.2 헬퍼 0」 오독을 만들었다).
//! 여기서는 이 프로세스의 **자식만** 언어 서버라, 짝이 되는 하네스
//! (`scripts/poc-lspidle-reclaim.mjs`)가 프로세스 트리를 그대로 세면 된다.
//!
//! 단계마다 stdout에 **JSON 한 줄**을 흘린다 — 하네스가 그 줄을 읽고 그 순간의 프로세스
//! 트리를 찍는다(앱 안의 판정과 OS의 판정을 같은 순간에 맞대기 위해서다).
//!
//! TTL·스윕 주기는 호출자가 `CCG_LSP_IDLE_TTL_MS`·`CCG_LSP_SWEEP_MS`로 줄인다.
//! **제품 기본값은 스펙 그대로**(bundled 10분 / 무거운 서버 30분 · 스윕 60초)다.

use serde_json::{json, Value};
use std::io::Write;
use std::time::Instant;

fn ms(t: Instant) -> f64 {
    (t.elapsed().as_micros() as f64) / 1000.0
}

/// 단계 한 줄 — 하네스가 이 줄을 보고 그 순간의 프로세스 트리를 찍는다.
///
/// ★**그리고 하네스가 다 찍을 때까지 기다린다**(`CCG_LSPIDLE_HANDSHAKE=1`일 때).
///
/// 악수가 없던 초판이 조용히 틀린 수를 냈다: 하네스의 트리 조회는 PowerShell 왕복이라
/// 수백 ms가 걸리는데 그동안 프로브는 다음 단계로 넘어가 **서버를 띄웠다**. 그래서
/// 「프리웜 직후」라고 이름 붙은 표본이 실제로는 「파일을 연 뒤」의 트리였고,
/// 온디맨드가 멀쩡히 도는데도 자손 3개가 찍혔다. 단계 이름과 표본 시각이 어긋나면
/// 그 측정은 무엇을 재는지 모르는 측정이다.
fn say(phase: &str, extra: Value) {
    // ★LSPIDLE R2(크리틱 B급 ②) — `project_status`도 같이 싣는다. 프리로드 조각이 유실된
    // 세계에서 **죽은 이유가 계약면에 실려 나오는지**를 하네스가 이 칸으로 확인한다.
    let cwd = std::env::args().nth(1).unwrap_or_default();
    let mut o = json!({
        "phase": phase,
        "lifecycle": ccg_lsp::lifecycle(),
        "projectStatus": ccg_lsp::project_status(&cwd),
    });
    if let (Some(a), Some(b)) = (o.as_object_mut(), extra.as_object()) {
        for (k, v) in b {
            a.insert(k.clone(), v.clone());
        }
    }
    println!("{o}");
    let _ = std::io::stdout().flush();
    if std::env::var("CCG_LSPIDLE_HANDSHAKE").as_deref() == Ok("1") {
        let mut ack = String::new();
        // 하네스가 표본을 다 찍고 한 줄 돌려줄 때까지 여기서 멈춘다.
        // 파이프가 닫히면(=하네스가 죽었다) 읽기가 0을 내므로 그냥 진행한다.
        let _ = std::io::stdin().read_line(&mut ack);
    }
}

fn env_u64(key: &str, dflt: u64) -> u64 {
    std::env::var(key).ok().and_then(|s| s.parse().ok()).unwrap_or(dflt)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 2 {
        eprintln!("사용법: ccg-lspidle <cwd> <상대경로>");
        std::process::exit(2);
    }
    let (cwd, rel) = (args[0].clone(), args[1].clone());
    let ttl = env_u64("CCG_LSP_IDLE_TTL_MS", 10 * 60_000);

    // ── ① 아무것도 안 한 상태 ────────────────────────────────────────────────
    say("boot", json!({ "cwd": cwd, "rel": rel, "ttlMs": ttl }));

    // ── ② 프리웜 — 프로젝트를 열었다. **서버는 안 떠야 한다**(온디맨드) ──────
    let t = Instant::now();
    ccg_lsp::prewarm(&cwd);
    let prewarm_ms = ms(t);
    // 스폰은 백그라운드 스레드라 즉시 0인 것만으로는 부족하다 — 뜰 시간을 주고도 0이어야 한다.
    std::thread::sleep(std::time::Duration::from_millis(1200));
    say("prewarmed", json!({ "prewarmMs": prewarm_ms }));

    // ── ③ 캐시 색칠 — **서버 없이** 칠할 수 있는가(첫 열람의 색은 여기서 온다) ─
    let t = Instant::now();
    let cached_cold = ccg_lsp::cached_tokens(&cwd, &rel);
    say(
        "cachedBeforeOpen",
        json!({ "ms": ms(t), "hit": cached_cold.is_some(), "n": token_len(&cached_cold) }),
    );

    // ── ④ 열람 — 여기가 **지연 기동의 방아쇠**다 ────────────────────────────
    let t = Instant::now();
    let mut st = ccg_lsp::status(&cwd, &rel);
    let mut ready_ms = None;
    while ready_ms.is_none() && t.elapsed().as_secs() < 120 {
        st = ccg_lsp::status(&cwd, &rel);
        match st {
            "ready" => ready_ms = Some(ms(t)),
            "error" | "unsupported" | "need-install" => break,
            _ => std::thread::sleep(std::time::Duration::from_millis(50)),
        }
    }
    say("opened", json!({ "status": st, "readyMs": ready_ms }));
    if ready_ms.is_none() {
        say("abort", json!({ "why": "서버가 ready로 안 갔다", "status": st }));
        ccg_lsp::dispose_all();
        return;
    }

    // 첫 실토큰 — 이 왕복이 디스크 캐시를 채운다(다음 색칠이 캐시 적중이 되는 근거)
    let t = Instant::now();
    let live = ccg_lsp::semantic_tokens(&cwd, &rel);
    say("liveTokens", json!({ "ms": ms(t), "n": token_len(&live) }));
    // 캐시 쓰기는 요청 경로 밖(백그라운드 스레드)이다 — 앉을 시간을 준다
    std::thread::sleep(std::time::Duration::from_millis(600));

    // ── ⑤ 회수 — TTL + 스윕 주기가 지나면 프로세스가 사라져야 한다 ──────────
    let t = Instant::now();
    let mut reclaim_ms = None;
    let budget = ttl + env_u64("CCG_LSP_SWEEP_MS", 60_000) * 3 + 15_000;
    while reclaim_ms.is_none() && (t.elapsed().as_millis() as u64) < budget {
        std::thread::sleep(std::time::Duration::from_millis(200));
        // **회수 중에는 아무것도 안 묻는다** — 물으면 타이머가 되감긴다(그게 규약이다).
        if ccg_lsp::lifecycle()["live"] == json!(0) {
            reclaim_ms = Some(ms(t));
        }
    }
    say("reclaimed", json!({ "ms": reclaim_ms, "budgetMs": budget }));

    // ── ⑥ 재열람 — 캐시가 먼저 칠하고, 서버는 그 뒤에 투명하게 돌아온다 ─────
    let t = Instant::now();
    let cached_warm = ccg_lsp::cached_tokens(&cwd, &rel);
    let cached_ms = ms(t);
    say(
        "repaintFromCache",
        json!({ "ms": cached_ms, "hit": cached_warm.is_some(), "n": token_len(&cached_warm) }),
    );

    let t = Instant::now();
    let back = ccg_lsp::semantic_tokens(&cwd, &rel);
    let revive_ms = ms(t);
    say("revived", json!({ "ms": revive_ms, "n": token_len(&back) }));

    // ── ⑦ 정리 ──────────────────────────────────────────────────────────────
    ccg_lsp::dispose_all();
    std::thread::sleep(std::time::Duration::from_millis(400));
    say("disposed", json!({}));
}

fn token_len(v: &Option<Value>) -> usize {
    v.as_ref().and_then(|t| t.get("data")).and_then(Value::as_array).map(Vec::len).unwrap_or(0)
}
