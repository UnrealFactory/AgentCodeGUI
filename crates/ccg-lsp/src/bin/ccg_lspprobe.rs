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
//!
//! **언어는 환경 변수로 바꾼다**(R3) — 기본값은 TS 픽스처라 옛 호출이 그대로 돈다:
//!
//! | 변수 | 뜻 | 기본 |
//! |---|---|---|
//! | `CCG_LSPPROBE_SYMS` | 표본을 찍을 식별자들(쉼표) | `makeConfig,summarize` |
//! | `CCG_LSPPROBE_CROSS` | 크로스 파일 적중으로 셀 목적지 파일명 | `lib.ts` |
//! | `CCG_LSPPROBE_COMPL` | 완성을 물을 줄(끝이 `.`) | `  return registry.` |
//! | `CCG_LSPPROBE_ANCHOR` | 그 줄을 꽂을 앵커 주석 | `// EDIT-ANCHOR` |

use serde_json::{json, Value};
use std::time::{Duration, Instant};

fn envs(key: &str, dflt: &str) -> String {
    std::env::var(key).ok().filter(|s| !s.is_empty()).unwrap_or_else(|| dflt.to_string())
}

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

    // 이 파일을 맡는 스펙과 **서버 루트** — C#의 `ReferencingSolution`이 어느 폴더를 골랐는지
    // 결과에 남는다(미끼 솔루션에 걸리면 여기서 바로 드러난다).
    {
        let a = std::path::Path::new(&cwd).join(&rel);
        if let Some(spec) = ccg_lsp::spec::spec_for_path(&a) {
            out["specId"] = json!(spec.id);
            out["serverRoot"] =
                json!(ccg_lsp::manager::root_of(spec, &a, std::path::Path::new(&cwd)).to_string_lossy());
        }
    }

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
    let mut unsupported = false;
    loop {
        let r = ccg_lsp::semantic_tokens(&cwd, &rel);
        // **`null` = 이 서버엔 시맨틱 토큰이 없다**(pyright). 렌더러도 같은 신호로 폴링을
        // 멈춘다 — 프로브가 안 멈추면 여기서 90초를 버리고 그 시간이 다른 눈금에 섞인다.
        if r.is_none() {
            unsupported = true;
            break;
        }
        let len = r.as_ref().and_then(|v| v.get("data")).and_then(Value::as_array).map(|a| a.len()).unwrap_or(0);
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
    out["tokenMs"] = json!(if unsupported { Value::Null } else { json!(ms(t).round()) });
    out["tokens"] = json!(tokens);
    out["tokenTries"] = json!(tries);
    out["semanticSupported"] = json!(!unsupported);

    // ── 표본 위치: 파일 안의 식별자들을 훑어 고른다 ──────────────────────────
    let syms: Vec<String> = envs("CCG_LSPPROBE_SYMS", "makeConfig,summarize")
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let cross_name = envs("CCG_LSPPROBE_CROSS", "lib.ts").to_lowercase();
    let abs = std::path::Path::new(&cwd).join(&rel);
    let text = std::fs::read_to_string(&abs).unwrap_or_default();
    let mut spots: Vec<(u32, u32)> = Vec::new();
    for (li, line) in text.lines().enumerate() {
        if spots.len() >= n {
            break;
        }
        if let Some(c) = syms.iter().find_map(|s| line.find(s.as_str())) {
            spots.push((li as u32, (c + 3) as u32));
        }
    }
    out["spots"] = json!(spots.len());
    out["syms"] = json!(syms);

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
            if r[0]["path"].as_str().map(|p| p.to_lowercase().ends_with(cross_name.as_str())).unwrap_or(false) {
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
    // 앵커 자리에 `PRE | COMPL | POST`를 꽂고 COMPL 줄 끝에서 묻는다.
    // 문법 껍데기(PRE/POST)가 언어마다 다르므로 값으로 뺀다 — 기본값은 TS 픽스처.
    let pre: Vec<String> =
        envs("CCG_LSPPROBE_PRE", "export function __probe(): unknown {").split('|').map(str::to_string).collect();
    let compl_line = envs("CCG_LSPPROBE_COMPL", "  return registry.");
    let post: Vec<String> = envs("CCG_LSPPROBE_POST", "}").split('|').map(str::to_string).collect();
    let anchor_txt = envs("CCG_LSPPROBE_ANCHOR", "// EDIT-ANCHOR");
    let lines: Vec<&str> = text.split('\n').collect();
    let anchor = lines
        .iter()
        .position(|l| l.trim_start().starts_with(&anchor_txt))
        .unwrap_or(lines.len().saturating_sub(1));
    let query_line = (anchor + pre.len()) as u32;
    for i in 0..10 {
        let mut next: Vec<String> = lines.iter().map(|s| s.to_string()).collect();
        let mut block: Vec<String> = pre.clone();
        block.push(compl_line.clone());
        block.extend(post.iter().cloned());
        // 회차마다 버퍼를 아주 조금 바꿔 서버 캐시에 그대로 얹히지 않게 한다
        block.push(format!("// probe{i}"));
        for (k, l) in block.into_iter().enumerate() {
            next.insert(anchor + k, l);
        }
        let buf = next.join("\n");
        let t = Instant::now();
        let r = ccg_lsp::completion(&cwd, &rel, query_line, compl_line.len() as u32, buf);
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

    // ── 멤버십 재통지(스펙 필드 두 개)의 런타임 증거 ─────────────────────────
    // `CCG_LSPPROBE_MEMBERSHIP=1`이면 이 서버의 멤버십 파일을 **실제로 건드리고**,
    // 그 뒤 토큰 왕복이 재프라임의 조용 간격만큼 늘어나는지를 본다.
    //   기준(t_base)  아무 일도 없을 때의 왕복
    //   앱 경유(t_app) 파일 touch + `files_changed` 통지 → `reload_if_membership`
    //   밖에서(t_ext)  파일 touch만(통지 없음) → `watch_membership` 폴러
    // 재프라임이 예약되면 다음 토큰 요청이 조용 간격(스펙 값)만큼 세워지므로, t_app/t_ext가
    // t_base보다 그만큼 커지는 것이 "훅이 실제로 돌았다"의 증거다.
    if std::env::var("CCG_LSPPROBE_MEMBERSHIP").ok().as_deref() == Some("1") {
        let root = std::path::Path::new(&cwd).join(&rel);
        let spec = ccg_lsp::spec::spec_for_path(&root);
        let server_root = spec.map(|s| ccg_lsp::manager::root_of(s, &root, std::path::Path::new(&cwd)));
        let files = match (spec, &server_root) {
            (Some(s), Some(r)) => (s.membership_files)(r),
            _ => Vec::new(),
        };
        let touch = |p: &std::path::Path| {
            if let Ok(txt) = std::fs::read_to_string(p) {
                let _ = std::fs::write(p, format!("{txt}\n<!-- probe -->"));
                let _ = std::fs::write(p, txt); // 내용은 되돌리고 mtime만 남긴다
            }
        };
        let round = || {
            let t = Instant::now();
            ccg_lsp::semantic_tokens(&cwd, &rel);
            ms(t).round()
        };
        let base = round();
        // 프라임이 유효한 상태에서 시작한다(재프라임 예약의 유무가 곧 신호가 되게)
        let primed_before = json!(ccg_lsp::primed(&cwd, &rel));
        let mut app = json!(Value::Null);
        let mut ext = json!(Value::Null);
        if let Some(f) = files.first() {
            // ① 앱 경유 — 파일이 바뀌었다고 **통지**한다(`files_changed`)
            touch(f);
            ccg_lsp::files_changed(&[f.to_string_lossy().to_string()]);
            app = json!({ "primedAfter": ccg_lsp::primed(&cwd, &rel), "nextTokenMs": round() });
            // ② 밖에서 — 통지 없이 파일만 바꾼다. 폴러(2s 주기 + 조용 한 틱)만이 이걸 본다.
            touch(f);
            std::thread::sleep(Duration::from_millis(6_000));
            ext = json!({ "primedAfter": ccg_lsp::primed(&cwd, &rel), "nextTokenMs": round() });
        }
        // 대조군 — **아무것도 안 건드리고** 같은 시간을 재운다. 여기서 primed가 true로
        // 남아야 위 두 false가 "훅이 돌았다"의 증거가 된다(시간이 흐른 탓이 아니라는 뜻).
        std::thread::sleep(Duration::from_millis(6_000));
        let control = json!({ "primedAfter": ccg_lsp::primed(&cwd, &rel), "nextTokenMs": round() });
        out["membership"] = json!({
            "root": server_root.map(|p| p.to_string_lossy().to_string()),
            "files": files.iter().map(|p| p.to_string_lossy().to_string()).collect::<Vec<_>>(),
            "baseMs": base, "primedBefore": primed_before,
            "appNotify": app, "externalTouch": ext, "control": control
        });
    }

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
