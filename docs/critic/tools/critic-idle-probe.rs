//! `critic-idle` — 확인 크리틱 LSPIDLE R1이 **직접** 만든 수명 프로브.
//!
//! 빌더의 `ccg-lspidle`은 「회수 중에는 아무것도 안 묻는다」로 이상적인 경로만 본다.
//! 여기서 보는 것은 그 바깥이다:
//!   ① 사용자가 **파일을 열어 놓은 채** TTL이 지나면 어떻게 되는가
//!   ② 회수 **직후** 첫 호버/정의/토큰이 무엇을 돌려주는가(조용한 빈손인가)
//!   ③ 여러 언어를 동시에 열면 자리가 몇 개인가
//!   ④ cwd를 바꾼 직후 열면
//!
//! stdout에 JSON 한 줄씩. 격리 사본에만 있는 파일이다(제품 코드 아님).

use serde_json::{json, Value};
use std::io::Write;
use std::time::Instant;

fn ms(t: Instant) -> f64 {
    (t.elapsed().as_micros() as f64) / 1000.0
}

fn say(phase: &str, extra: Value) {
    let mut o = json!({ "phase": phase, "lifecycle": ccg_lsp::lifecycle() });
    if let (Some(a), Some(b)) = (o.as_object_mut(), extra.as_object()) {
        for (k, v) in b {
            a.insert(k.clone(), v.clone());
        }
    }
    println!("{o}");
    let _ = std::io::stdout().flush();
    // ★악수 — 하네스가 트리를 다 찍을 때까지 멈춘다. 없으면 「단계 이름」과 「표본 시각」이
    // 어긋나고(트리 조회는 PowerShell 왕복 수백 ms다) 「프리웜 직후」 표본이 실제로는
    // 「파일을 연 뒤」가 된다. 크리틱 1차 주행이 그걸 그대로 밟았다.
    if std::env::var("CRITIC_HANDSHAKE").as_deref() == Ok("1") {
        let mut ack = String::new();
        let _ = std::io::stdin().read_line(&mut ack);
    }
}

fn env_u64(key: &str, dflt: u64) -> u64 {
    std::env::var(key).ok().and_then(|s| s.parse().ok()).unwrap_or(dflt)
}

fn token_len(v: &Option<Value>) -> usize {
    v.as_ref().and_then(|t| t.get("data")).and_then(Value::as_array).map(Vec::len).unwrap_or(0)
}

fn hover_text(v: &Option<Value>) -> String {
    v.as_ref()
        .and_then(|h| h.get("contents"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .chars()
        .take(90)
        .collect()
}

/// ready까지 status 폴링(렌더러가 하는 그대로 400ms).
fn open_until_ready(cwd: &str, rel: &str) -> (&'static str, Option<f64>, u32) {
    let t = Instant::now();
    let mut polls = 0u32;
    let mut st = ccg_lsp::status(cwd, rel);
    loop {
        polls += 1;
        st = ccg_lsp::status(cwd, rel);
        match st {
            "ready" => return (st, Some(ms(t)), polls),
            "error" | "unsupported" | "need-install" => return (st, None, polls),
            _ => {}
        }
        if t.elapsed().as_secs() >= 90 {
            return (st, None, polls);
        }
        std::thread::sleep(std::time::Duration::from_millis(400));
    }
}

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    if a.is_empty() {
        eprintln!("사용법: critic-idle <mode> ...");
        std::process::exit(2);
    }
    match a[0].as_str() {
        // 파일을 열어 놓은 채 TTL이 지난다. `poll=1`이면 렌더러가 ready 뒤에도 계속
        // status를 물었다고 가정한다(실제 FileModal은 ready에서 폴링을 멈춘다).
        "viewing" => viewing(&a[1], &a[2], a[3].parse().unwrap(), a[4].parse().unwrap(), a.get(5).map(String::as_str) == Some("poll")),
        // 서로 다른 두 언어를 같은 프로세스에서 동시에 연다(멀티 패널 모사).
        "multi" => multi(&a[1], &a[2], &a[3]),
        // cwd를 바꾼 직후 연다(프리웜 → 프리웜 → 열람).
        "cwdchange" => cwdchange(&a[1], &a[2], &a[3]),
        // 회수와 요청이 서로를 스치게 한다(TTL·스윕을 밀리초로 주입하고 호버를 두들긴다).
        "thrash" => thrash(&a[1], &a[2], a[3].parse().unwrap(), a[4].parse().unwrap(), a[5].parse().unwrap()),
        // 켠 직후 첫 열람 — 이 라운드가 판 교환(+499ms)을 크레이트 층에서 그대로 잰다.
        "coldopen" => coldopen(&a[1], &a[2]),
        other => {
            eprintln!("모르는 모드: {other}");
            std::process::exit(2);
        }
    }
}

fn viewing(cwd: &str, rel: &str, line: u32, ch: u32, poll: bool) {
    let ttl = env_u64("CCG_LSP_IDLE_TTL_MS", 10 * 60_000);
    let sweep = env_u64("CCG_LSP_SWEEP_MS", 60_000);
    say("boot", json!({ "cwd": cwd, "rel": rel, "ttlMs": ttl, "sweepMs": sweep, "pollWhileViewing": poll }));

    let t = Instant::now();
    ccg_lsp::prewarm(cwd);
    let prewarm_ms = ms(t);
    std::thread::sleep(std::time::Duration::from_millis(1200));
    say("prewarmed", json!({ "prewarmMs": prewarm_ms }));

    let (st, ready_ms, polls) = open_until_ready(cwd, rel);
    say("opened", json!({ "status": st, "readyMs": ready_ms, "polls": polls }));
    if ready_ms.is_none() {
        // 실패할 때 **무슨 말을 하는가**가 이 자리의 핵심이다(조용히 죽으면 결함).
        say(
            "abort",
            json!({ "why": "ready로 안 갔다", "status": st, "servers": ccg_lsp::servers(),
                    "projectStatus": ccg_lsp::project_status(cwd) }),
        );
        ccg_lsp::dispose_all();
        return;
    }

    // 뷰어가 하는 일: 토큰을 받고(캐시가 채워진다) 사용자가 심볼에 마우스를 올린다.
    let t = Instant::now();
    let tok0 = ccg_lsp::semantic_tokens(cwd, rel);
    let tok0_ms = ms(t);
    let t = Instant::now();
    let hov0 = ccg_lsp::hover(cwd, rel, line, ch);
    let hov0_ms = ms(t);
    let def0 = ccg_lsp::definition(cwd, rel, line, ch);
    say(
        "firstUse",
        json!({
            "tokensMs": tok0_ms, "tokens": token_len(&tok0),
            "hoverMs": hov0_ms, "hoverHit": hov0.is_some(), "hover": hover_text(&hov0),
            "defs": def0.len(), "primed": ccg_lsp::primed(cwd, rel)
        }),
    );
    std::thread::sleep(std::time::Duration::from_millis(700));

    // ── 사용자가 파일을 **보고만 있다**. 렌더러는 ready 뒤 status 폴링을 멈춘다. ──
    let t = Instant::now();
    let budget = ttl + sweep * 4 + 20_000;
    let mut reclaim_ms: Option<f64> = None;
    let mut polls_during = 0u32;
    while reclaim_ms.is_none() && (t.elapsed().as_millis() as u64) < budget {
        std::thread::sleep(std::time::Duration::from_millis(200));
        if poll && (polls_during as u64 * 200) % 400 == 0 {
            let _ = ccg_lsp::status(cwd, rel);
            polls_during += 1;
        }
        if ccg_lsp::lifecycle()["live"] == json!(0) {
            reclaim_ms = Some(ms(t));
        }
    }
    // 「live 0」은 자리를 비운 순간이고 `shutdown`(taskkill)은 잠금 밖에서 그 뒤에 돈다 —
    // 그 사이에 트리를 찍으면 「회수했는데 프로세스가 남았다」는 헛경보가 난다. 가라앉힌다.
    std::thread::sleep(std::time::Duration::from_millis(2500));
    say(
        "viewedThroughTtl",
        json!({ "reclaimedAfterMs": reclaim_ms, "budgetMs": budget, "statusPolls": polls_during, "settledMs": 2500 }),
    );

    // ── 회수 **직후** 사용자가 같은 심볼에 마우스를 올린다. 여기가 이 프로브의 요점. ──
    let t = Instant::now();
    let hov1 = ccg_lsp::hover(cwd, rel, line, ch);
    let hov1_ms = ms(t);
    let same = hover_text(&hov1) == hover_text(&hov0);
    say(
        "hoverRightAfterReclaim",
        json!({ "ms": hov1_ms, "hit": hov1.is_some(), "sameAsBefore": same, "hover": hover_text(&hov1),
                "uiStatusWouldStillSay": "ready(렌더러는 ready에서 폴링을 멈춘다)" }),
    );

    let t = Instant::now();
    let def1 = ccg_lsp::definition(cwd, rel, line, ch);
    say("definitionRightAfter", json!({ "ms": ms(t), "defs": def1.len(), "sameCount": def1.len() == def0.len() }));

    let t = Instant::now();
    let tok1 = ccg_lsp::semantic_tokens(cwd, rel);
    say("tokensRightAfter", json!({ "ms": ms(t), "tokens": token_len(&tok1), "sameCount": token_len(&tok1) == token_len(&tok0) }));

    // 두 번째 시도(사용자가 다시 마우스를 올린다)
    let t = Instant::now();
    let hov2 = ccg_lsp::hover(cwd, rel, line, ch);
    say(
        "hoverSecondTry",
        json!({ "ms": ms(t), "hit": hov2.is_some(), "sameAsBefore": hover_text(&hov2) == hover_text(&hov0),
                "primed": ccg_lsp::primed(cwd, rel) }),
    );

    ccg_lsp::dispose_all();
    std::thread::sleep(std::time::Duration::from_millis(400));
    say("disposed", json!({}));
}

/// 회수와 요청이 **서로를 스치게** 한다. TTL·스윕을 밀리초로 주입해 매 호버 사이에 회수가
/// 끼어들 수 있게 하고, 답이 한 번이라도 빈손이거나 달라지는지 본다.
/// (제품에서 이 값을 쓰지는 않는다 — 경계의 존재를 재는 자리다.)
fn thrash(cwd: &str, rel: &str, line: u32, ch: u32, n: u32) {
    say("boot", json!({ "cwd": cwd, "rel": rel, "n": n,
        "ttlMs": env_u64("CCG_LSP_IDLE_TTL_MS", 0), "sweepMs": env_u64("CCG_LSP_SWEEP_MS", 0) }));
    let (st, ready_ms, _) = open_until_ready(cwd, rel);
    if ready_ms.is_none() {
        say("abort", json!({ "status": st }));
        return;
    }
    let base = ccg_lsp::hover(cwd, rel, line, ch);
    let base_txt = hover_text(&base);
    let mut miss = 0u32;
    let mut differ = 0u32;
    let mut worst = 0f64;
    let mut revivals_seen = 0u64;
    let mut tok_empty = 0u32;
    for i in 0..n {
        std::thread::sleep(std::time::Duration::from_millis(40));
        let t = Instant::now();
        let h = ccg_lsp::hover(cwd, rel, line, ch);
        let el = ms(t);
        if el > worst {
            worst = el;
        }
        if h.is_none() {
            miss += 1;
        } else if hover_text(&h) != base_txt {
            differ += 1;
        }
        if i % 3 == 0 {
            let tk = ccg_lsp::semantic_tokens(cwd, rel);
            if token_len(&tk) == 0 {
                tok_empty += 1;
            }
        }
        revivals_seen = ccg_lsp::lifecycle()["revivals"].as_u64().unwrap_or(0);
    }
    say(
        "thrashed",
        json!({ "tries": n, "hoverMiss": miss, "hoverDiffer": differ, "worstHoverMs": worst,
                "emptyTokenReplies": tok_empty, "revivals": revivals_seen, "base": base_txt }),
    );
    ccg_lsp::dispose_all();
    std::thread::sleep(std::time::Duration::from_millis(400));
    say("disposed", json!({}));
}

/// 「켠 직후 파일을 연다」 — 프리웜 직후 **기다리지 않고** 곧바로 연다.
///
/// 앱의 부팅 시간을 흉내 내려고 `CRITIC_BOOT_MS`만큼만 쉰 뒤 연다(기본 0 = 최악의 경우,
/// `bench/lsp.mjs`의 프리웜 눈금과 같은 자리). 폴링은 25ms로 촘촘히 해서 렌더러의 400ms
/// 격자에 값이 먹히지 않게 한다 — 재는 것은 **기동이 끝나는 시각**이지 폴링 격자가 아니다.
fn coldopen(cwd: &str, rel: &str) {
    let boot = env_u64("CRITIC_BOOT_MS", 0);
    say("boot", json!({ "cwd": cwd, "rel": rel, "bootMs": boot }));
    let t0 = Instant::now();
    ccg_lsp::prewarm(cwd);
    let prewarm_ms = ms(t0);
    std::thread::sleep(std::time::Duration::from_millis(boot));

    // ① 캐시 색칠 — 서버를 안 기다리는 경로.
    let t = Instant::now();
    let cached = ccg_lsp::cached_tokens(cwd, rel);
    let cached_ms = ms(t);

    // ② 기동이 끝날 때까지(= 호버·정의가 되는 시각).
    let t = Instant::now();
    let mut st = "";
    let mut ready_ms = None;
    while ready_ms.is_none() && t.elapsed().as_secs() < 60 {
        st = ccg_lsp::status(cwd, rel);
        match st {
            "ready" => ready_ms = Some(ms(t)),
            "error" | "unsupported" | "need-install" => break,
            _ => std::thread::sleep(std::time::Duration::from_millis(25)),
        }
    }

    // ③ 첫 실토큰(= 캐시 미적중 첫 색칠).
    let t = Instant::now();
    let tok = ccg_lsp::semantic_tokens(cwd, rel);
    let first_paint_ms = ms(t);
    let t = Instant::now();
    let hov = ccg_lsp::hover(cwd, rel, 3, 10);
    say(
        "coldOpen",
        json!({
            "prewarmMs": prewarm_ms,
            "cachedPaintMs": cached_ms, "cacheHit": cached.is_some(),
            "status": st, "readyMs": ready_ms,
            "firstLiveTokensMs": first_paint_ms, "tokens": token_len(&tok),
            "sinceStartToTokensMs": (t0.elapsed().as_micros() as f64) / 1000.0,
            "hoverMs": ms(t), "hoverHit": hov.is_some()
        }),
    );
    ccg_lsp::dispose_all();
    std::thread::sleep(std::time::Duration::from_millis(400));
    say("disposed", json!({}));
}

fn multi(cwd: &str, rel_a: &str, rel_b: &str) {
    say("boot", json!({ "cwd": cwd, "a": rel_a, "b": rel_b }));
    ccg_lsp::prewarm(cwd);
    std::thread::sleep(std::time::Duration::from_millis(1200));
    say("prewarmed", json!({}));
    let (sa, ma, _) = open_until_ready(cwd, rel_a);
    say("openedA", json!({ "status": sa, "readyMs": ma }));
    let (sb, mb, _) = open_until_ready(cwd, rel_b);
    say("openedB", json!({ "status": sb, "readyMs": mb }));
    let ta = ccg_lsp::semantic_tokens(cwd, rel_a);
    let tb = ccg_lsp::semantic_tokens(cwd, rel_b);
    say("bothTokens", json!({ "aTokens": token_len(&ta), "bTokens": token_len(&tb), "servers": ccg_lsp::servers().len() }));
    ccg_lsp::dispose_all();
    std::thread::sleep(std::time::Duration::from_millis(400));
    say("disposed", json!({}));
}

fn cwdchange(cwd_a: &str, cwd_b: &str, rel_b: &str) {
    say("boot", json!({ "a": cwd_a, "b": cwd_b, "relB": rel_b }));
    let t = Instant::now();
    ccg_lsp::prewarm(cwd_a);
    say("prewarmA", json!({ "ms": ms(t) }));
    std::thread::sleep(std::time::Duration::from_millis(900));
    say("afterPrewarmA", json!({}));
    let t = Instant::now();
    ccg_lsp::prewarm(cwd_b);
    say("prewarmB", json!({ "ms": ms(t) }));
    std::thread::sleep(std::time::Duration::from_millis(900));
    say("afterPrewarmB", json!({}));
    let (st, r, polls) = open_until_ready(cwd_b, rel_b);
    say("openedB", json!({ "status": st, "readyMs": r, "polls": polls }));
    let tok = ccg_lsp::semantic_tokens(cwd_b, rel_b);
    say("tokensB", json!({ "tokens": token_len(&tok) }));
    ccg_lsp::dispose_all();
    std::thread::sleep(std::time::Duration::from_millis(400));
    say("disposed", json!({}));
}
