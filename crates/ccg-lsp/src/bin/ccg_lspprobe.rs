//! `ccg-lspprobe` — 크레이트를 **셸 없이** 실물 언어 서버에 붙여 재는 프로브.
//!
//! ```text
//! cargo run -p ccg-lsp --features cli --bin ccg-lspprobe -- <cwd> <상대경로> [표본수]
//! ```
//!
//! 왜 따로 두는가: `bench/lsp.mjs`는 **앱 전체**를 잰다(렌더러 → IPC → 크레이트 → 서버).
//! 그 길에서 숫자가 나쁘면 어디가 느린지 모른다. 이 프로브는 같은 눈금을 **크레이트에서
//! 바로** 재서 앱 계층의 몫을 뺄셈으로 드러낸다. 또 4명이 동시에 셸을 고치는 라운드에서
//! 남의 컴파일 오류에 내 측정이 막히지 않는 독립 경로이기도 하다.
//!
//! 출력은 JSON 한 줄 — 하네스가 그대로 삼킬 수 있게.

use serde_json::{json, Value};
use std::time::{Duration, Instant};

fn ms(t: Instant) -> f64 {
    (t.elapsed().as_micros() as f64) / 1000.0
}

fn pct(v: &mut [f64], q: f64) -> Option<f64> {
    if v.is_empty() {
        return None;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let i = ((v.len() as f64) * q) as usize;
    Some((v[i.min(v.len() - 1)] * 100.0).round() / 100.0)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 2 {
        eprintln!("사용법: ccg-lspprobe <cwd> <상대경로> [표본수]");
        std::process::exit(2);
    }
    let cwd = args[0].clone();
    let rel = args[1].clone();
    let n: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(30);

    let mut out = json!({ "cwd": cwd, "rel": rel, "samples": n });

    // ── 캐시 적중(서버를 안 띄우는 즉시 색칠) ────────────────────────────────
    let t = Instant::now();
    let cached = ccg_lsp::cached_tokens(&cwd, &rel);
    out["cachedMs"] = json!((ms(t) * 100.0).round() / 100.0);
    out["cachedHit"] = json!(cached
        .as_ref()
        .and_then(|v| v.get("data"))
        .and_then(Value::as_array)
        .map(|a| !a.is_empty())
        .unwrap_or(false));

    // ── 프리웜 → ready ───────────────────────────────────────────────────────
    let t0 = Instant::now();
    ccg_lsp::prewarm(&cwd);
    let mut st = ccg_lsp::status(&cwd, &rel);
    let mut states = vec![st.to_string()];
    while st != "ready" && st != "error" && st != "unsupported" && t0.elapsed() < Duration::from_secs(180) {
        std::thread::sleep(Duration::from_millis(50));
        let now = ccg_lsp::status(&cwd, &rel);
        if now != st {
            states.push(now.to_string());
        }
        st = now;
    }
    out["prewarmMs"] = json!(ms(t0).round());
    out["status"] = json!(st);
    out["states"] = json!(states);
    if st != "ready" {
        println!("{out}");
        ccg_lsp::dispose_all();
        return;
    }

    // ── 첫 라이브 토큰(비지 않을 때까지) ─────────────────────────────────────
    let t = Instant::now();
    let mut tokens = 0usize;
    let mut tries = 0;
    loop {
        let r = ccg_lsp::semantic_tokens(&cwd, &rel);
        let len = r
            .as_ref()
            .and_then(|v| v.get("data"))
            .and_then(Value::as_array)
            .map(|a| a.len())
            .unwrap_or(0);
        if len > 0 {
            tokens = len / 5;
            break;
        }
        tries += 1;
        if t.elapsed() > Duration::from_secs(90) {
            break;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    out["tokenMs"] = json!(ms(t).round());
    out["tokens"] = json!(tokens);
    out["tokenTries"] = json!(tries);

    // ── 표본 위치: 파일 안의 식별자들을 훑어 고른다 ──────────────────────────
    let abs = std::path::Path::new(&cwd).join(&rel);
    let text = std::fs::read_to_string(&abs).unwrap_or_default();
    let mut spots: Vec<(u32, u32)> = Vec::new();
    for (li, line) in text.lines().enumerate() {
        if spots.len() >= n {
            break;
        }
        if let Some(c) = line.find("makeConfig").or_else(|| line.find("summarize")) {
            spots.push((li as u32, (c + 3) as u32));
        }
    }
    out["spots"] = json!(spots.len());

    // ── 호버 ─────────────────────────────────────────────────────────────────
    let mut hover_ms: Vec<f64> = Vec::new();
    let mut hover_hits = 0;
    for (l, c) in &spots {
        let t = Instant::now();
        let r = ccg_lsp::hover(&cwd, &rel, *l, *c);
        hover_ms.push(ms(t));
        if r.is_some() {
            hover_hits += 1;
        }
    }
    out["hover"] = json!({
        "n": spots.len(), "hits": hover_hits,
        "p50": pct(&mut hover_ms.clone(), 0.5), "p95": pct(&mut hover_ms, 0.95)
    });

    // ── 정의 이동 ────────────────────────────────────────────────────────────
    let mut def_ms: Vec<f64> = Vec::new();
    let mut def_hits = 0;
    let mut cross = 0;
    for (l, c) in &spots {
        let t = Instant::now();
        let r = ccg_lsp::definition(&cwd, &rel, *l, *c);
        def_ms.push(ms(t));
        if !r.is_empty() {
            def_hits += 1;
            if r[0]["path"].as_str().map(|p| p.to_lowercase().ends_with("lib.ts")).unwrap_or(false) {
                cross += 1;
            }
        }
    }
    out["definition"] = json!({
        "n": spots.len(), "hits": def_hits, "crossFile": cross,
        "p50": pct(&mut def_ms.clone(), 0.5), "p95": pct(&mut def_ms, 0.95)
    });

    // ── 자동완성 첫 후보 ─────────────────────────────────────────────────────
    // 라이브 버퍼에 `registry.` 한 줄을 꽂고 그 뒤를 묻는다(디스크는 안 건드린다).
    let mut compl_ms: Vec<f64> = Vec::new();
    let mut items = 0usize;
    let mut sample: Vec<String> = Vec::new();
    let lines: Vec<&str> = text.split('\n').collect();
    let anchor = lines.iter().position(|l| l.starts_with("// EDIT-ANCHOR")).unwrap_or(lines.len().saturating_sub(1));
    for i in 0..10 {
        let mut next: Vec<String> = lines.iter().map(|s| s.to_string()).collect();
        next.insert(anchor, "}".into());
        next.insert(anchor, "  return registry.".into());
        next.insert(anchor, format!("export function __probe{i}(): unknown {{"));
        let buf = next.join("\n");
        let t = Instant::now();
        let r = ccg_lsp::completion(&cwd, &rel, (anchor + 1) as u32, "  return registry.".len() as u32, buf);
        compl_ms.push(ms(t));
        if let Some(v) = r {
            let arr = v["items"].as_array().cloned().unwrap_or_default();
            items = items.max(arr.len());
            if sample.is_empty() {
                sample = arr.iter().take(5).filter_map(|x| x["label"].as_str().map(str::to_string)).collect();
            }
        }
    }
    out["completion"] = json!({
        "n": 10, "maxItems": items, "sample": sample,
        "p50": pct(&mut compl_ms.clone(), 0.5), "p95": pct(&mut compl_ms, 0.95)
    });

    // ── 유휴 회수 ────────────────────────────────────────────────────────────
    // CCG_LSP_IDLE_TTL_MS가 주입돼 있으면 그만큼 조용히 두고 서버가 실제로 사라지는지 본다.
    if let Ok(ttl) = std::env::var("CCG_LSP_IDLE_TTL_MS").map(|v| v.parse::<u64>().unwrap_or(0)) {
        if ttl > 0 {
            let before = ccg_lsp::manager::live_count();
            std::thread::sleep(Duration::from_millis(ttl + 500));
            ccg_lsp::manager::sweep_idle();
            let after = ccg_lsp::manager::live_count();
            let t = Instant::now();
            let back = ccg_lsp::semantic_tokens(&cwd, &rel).is_some();
            out["idleReclaim"] = json!({
                "ttlMs": ttl, "before": before, "after": after,
                "reclaimed": before > 0 && after == 0,
                "respawnMs": ms(t).round(), "respawnOk": back, "liveAfter": ccg_lsp::manager::live_count()
            });
        }
    }

    println!("{out}");

    // ── 잡 안전망 실증용 대기 ────────────────────────────────────────────────
    // `CCG_LSPPROBE_HOLD_MS`가 있으면 서버를 띄운 채로 버틴다. 이 상태에서 프로브를
    // **/T 없이** 강제 종료하면(= 자식·손자를 안 건드리는 방식) 잡이 없는 구현에서는
    // node+tsserver가 살아남는다. 잡이 있으면 OS가 걷어간다 — 그 차이를 재는 자리다.
    if let Ok(ms) = std::env::var("CCG_LSPPROBE_HOLD_MS").map(|v| v.parse::<u64>().unwrap_or(0)) {
        if ms > 0 {
            eprintln!("[probe] hold {ms}ms — 서버를 띄운 채 대기");
            std::thread::sleep(Duration::from_millis(ms));
        }
    }
    ccg_lsp::dispose_all();
}
