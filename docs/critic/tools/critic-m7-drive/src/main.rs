//! M7 크리틱 드라이버 — `ccg-lsp`의 공개 API만 써서 엔진을 직접 두드린다.
//! 워크스페이스 밖 크레이트(별도 CARGO_TARGET_DIR) — 빌더의 target/을 안 건드린다.
//!
//! 서버는 `CCG_LSP_MODULES`로 가짜 LSP(`docs/critic/tools/m7-fakelsp`)를 물린다.
//! 실물 tsserver로는 못 만드는 상황(프로토콜 위반 사망·급사·설정 요구)을 재현하기 위해서.
//!
//!   m7drive <cmd> ...
//!     dupopen  <cwd> <rel> [threads]  동시 요청 폭탄 → didOpen이 문서당 정확히 1회인가
//!     storm    <cwd> <rel> [n]        완성 연타(타이핑 폭풍) → didChange 전부 range 있는가
//!     config   <cwd> <rel>            서버의 workspace/configuration 요청에 뭐라 답하나
//!     death    <cwd> <rel> [dieMs]    ready 뒤 서버 급사 → status·기능·재기동
//!     cache    <cwd> <rel>            토큰 디스크 캐시 오염 회복
//!     manydocs <cwd> <n>              문서 상한(32) 넘겨 열기 → didClose·정확성
use serde_json::{json, Value};
use std::path::Path;
use std::time::{Duration, Instant};

fn ms(t: Instant) -> f64 {
    (t.elapsed().as_micros() as f64) / 1000.0
}

fn log_lines() -> Vec<Value> {
    let p = std::env::var("FLSP_LOG").unwrap_or_default();
    std::fs::read_to_string(p)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .collect()
}

fn wait_ready(cwd: &str, rel: &str, budget_ms: u64) -> (String, f64) {
    let t = Instant::now();
    let mut st = ccg_lsp::status(cwd, rel).to_string();
    while st != "ready" && st != "error" && st != "unsupported" && t.elapsed() < Duration::from_millis(budget_ms) {
        std::thread::sleep(Duration::from_millis(40));
        st = ccg_lsp::status(cwd, rel).to_string();
    }
    (st, ms(t))
}

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    if a.is_empty() {
        eprintln!("m7drive <dupopen|storm|config|death|cache|manydocs> ...");
        std::process::exit(2);
    }
    let cmd = a[0].as_str();
    let cwd = a.get(1).cloned().unwrap_or_default();
    let rel = a.get(2).cloned().unwrap_or_default();
    let mut out = json!({ "cmd": cmd, "cwd": cwd, "rel": rel });

    match cmd {
        // ── 불변식 ① : didOpen은 문서당 정확히 한 번 ────────────────────────
        "dupopen" => {
            let threads: usize = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(16);
            let (st, rms) = wait_ready(&cwd, &rel, 30_000);
            out["ready"] = json!(st);
            out["readyMs"] = json!(rms.round());
            // ready 직후 동시 폭탄 — 2.6.2에서 중복 didOpen이 나던 그 겹침을 만든다
            let mut hs = Vec::new();
            for i in 0..threads {
                let (c, r) = (cwd.clone(), rel.clone());
                hs.push(std::thread::spawn(move || match i % 4 {
                    0 => { ccg_lsp::semantic_tokens(&c, &r); }
                    1 => { ccg_lsp::hover(&c, &r, 0, 1); }
                    2 => { ccg_lsp::definition(&c, &r, 0, 1); }
                    _ => { ccg_lsp::status(&c, &r); }
                }));
            }
            for h in hs { let _ = h.join(); }
            std::thread::sleep(Duration::from_millis(600));
            let lines = log_lines();
            let mut opens: std::collections::HashMap<String, u64> = Default::default();
            for l in &lines {
                if l["ev"] == "didOpen" {
                    *opens.entry(l["uri"].as_str().unwrap_or("").to_string()).or_default() += 1;
                }
            }
            out["didOpenPerUri"] = json!(opens);
            out["maxDidOpen"] = json!(opens.values().copied().max().unwrap_or(0));
            out["serverAlive"] = json!(!lines.iter().any(|l| l["ev"] == "selfKill" || l["ev"] == "exit"));
            out["procStarts"] = json!(lines.iter().filter(|l| l["ev"] == "start").count());
            out["tokensAfter"] = json!(ccg_lsp::semantic_tokens(&cwd, &rel)
                .and_then(|v| v.get("data").and_then(Value::as_array).map(|x| x.len() / 5)));
        }

        // ── 불변식 ② : didChange는 syncKind를 존중(range 필수) ──────────────
        "storm" => {
            let n: usize = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(120);
            let (st, rms) = wait_ready(&cwd, &rel, 30_000);
            out["ready"] = json!(st);
            out["readyMs"] = json!(rms.round());
            let abs = Path::new(&cwd).join(&rel);
            let base = std::fs::read_to_string(&abs).unwrap_or_default();
            let mut lat: Vec<f64> = Vec::new();
            let mut fails = 0;
            // "빠른 타이핑": 마지막 줄에 한 글자씩 덧붙이며 매번 완성을 부른다
            let mut typed = String::new();
            for i in 0..n {
                typed.push(char::from(b'a' + (i % 26) as u8));
                let buf = format!("{base}\nconst __t{} = '{}'\n", i, typed);
                let line = base.lines().count() as u32 + 1;
                let t = Instant::now();
                let r = ccg_lsp::completion(&cwd, &rel, line, 10, buf);
                lat.push(ms(t));
                if r.is_none() { fails += 1; }
            }
            std::thread::sleep(Duration::from_millis(400));
            let lines = log_lines();
            let changes: Vec<&Value> = lines.iter().filter(|l| l["ev"] == "recv" && l["method"] == "textDocument/didChange").collect();
            let rangeless = changes.iter().filter(|l| {
                l["changes"].as_array().map(|a| a.iter().any(|c| c["hasRange"] != json!(true))).unwrap_or(false)
            }).count();
            let versions: Vec<i64> = changes.iter().filter_map(|l| l["version"].as_i64()).collect();
            let monotonic = versions.windows(2).all(|w| w[1] > w[0]);
            let payload: i64 = changes.iter()
                .filter_map(|l| l["changes"].as_array())
                .flat_map(|a| a.iter())
                .filter_map(|c| c["textLen"].as_i64())
                .sum();
            lat.sort_by(|x, y| x.partial_cmp(y).unwrap());
            out["typing"] = json!({
                "n": n, "completionNone": fails,
                "p50": (lat[lat.len()/2]*100.0).round()/100.0,
                "p95": (lat[(lat.len() as f64*0.95) as usize % lat.len()]*100.0).round()/100.0,
                "max": (lat[lat.len()-1]*100.0).round()/100.0
            });
            out["didChange"] = json!({ "count": changes.len(), "rangeless": rangeless,
                                       "versionsMonotonic": monotonic, "totalChangeTextBytes": payload });
            out["serverAlive"] = json!(!lines.iter().any(|l| l["ev"] == "selfKill"));
            out["procStarts"] = json!(lines.iter().filter(|l| l["ev"] == "start").count());
            // 폭풍 뒤에도 토큰이 정확히 오는가
            out["tokensAfterStorm"] = json!(ccg_lsp::semantic_tokens(&cwd, &rel)
                .and_then(|v| v.get("data").and_then(Value::as_array).map(|x| x.len() / 5)));
            out["hoverAfterStorm"] = json!(ccg_lsp::hover(&cwd, &rel, 0, 1).is_some());
        }

        // ── 서버가 요구하는 설정(workspace/configuration)에 우리는 뭐라 답하나 ──
        "config" => {
            let (st, rms) = wait_ready(&cwd, &rel, 30_000);
            out["ready"] = json!(st);
            out["readyMs"] = json!(rms.round());
            ccg_lsp::semantic_tokens(&cwd, &rel);
            std::thread::sleep(Duration::from_millis(500));
            let lines = log_lines();
            let req = lines.iter().find(|l| l["ev"] == "serverRequest").cloned();
            let rep = lines.iter().find(|l| l["ev"] == "reply").cloned();
            out["serverAsked"] = req.clone().unwrap_or(Value::Null);
            out["clientAnswered"] = rep.clone().unwrap_or(Value::Null);
            let items = req.as_ref().and_then(|r| r["items"].as_u64()).unwrap_or(0) as usize;
            let got = rep.as_ref().and_then(|r| r["result"].as_array().map(|a| a.len())).unwrap_or(usize::MAX);
            out["lspContractOk"] = json!(got == items);
            out["note"] = json!("LSP 규약: workspace/configuration 응답은 items 수만큼의 원소를 가진 배열이어야 한다");
        }

        // ── ready 뒤 서버 급사 ───────────────────────────────────────────────
        "death" => {
            let die: u64 = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(2500);
            std::env::set_var("FLSP_DIE_AFTER_MS", die.to_string());
            let (st, rms) = wait_ready(&cwd, &rel, 30_000);
            out["ready"] = json!(st);
            out["readyMs"] = json!(rms.round());
            out["tokensBefore"] = json!(ccg_lsp::semantic_tokens(&cwd, &rel)
                .and_then(|v| v.get("data").and_then(Value::as_array).map(|x| x.len() / 5)));
            // 서버가 스스로 죽을 때까지
            std::thread::sleep(Duration::from_millis(die + 1200));
            let mut samples = Vec::new();
            let t0 = Instant::now();
            while t0.elapsed() < Duration::from_secs(40) {
                let ts = Instant::now();
                let s = ccg_lsp::status(&cwd, &rel);
                let s_ms = ms(ts);
                let tt = Instant::now();
                let tok = ccg_lsp::semantic_tokens(&cwd, &rel)
                    .and_then(|v| v.get("data").and_then(Value::as_array).map(|x| x.len() / 5))
                    .unwrap_or(0);
                let tok_ms = ms(tt);
                samples.push(json!({ "sinceDeathMs": t0.elapsed().as_millis() as u64, "status": s,
                                     "statusMs": (s_ms*100.0).round()/100.0, "tokens": tok,
                                     "tokensMs": (tok_ms*100.0).round()/100.0,
                                     "live": ccg_lsp::manager::live_count() }));
                std::thread::sleep(Duration::from_millis(2000));
            }
            let lines = log_lines();
            out["samples"] = json!(samples);
            out["procStarts"] = json!(lines.iter().filter(|l| l["ev"] == "start").count());
            out["statusesAfterDeath"] = json!(samples
                .iter()
                .filter_map(|s| s["status"].as_str().map(str::to_string))
                .collect::<std::collections::BTreeSet<String>>());
            out["recovered"] = json!(samples.iter().any(|s| s["tokens"].as_u64().unwrap_or(0) > 0));
        }

        // ── 토큰 디스크 캐시 오염 ────────────────────────────────────────────
        "cache" => {
            // 먼저 라이브로 한 번 채운다
            let (st, _) = wait_ready(&cwd, &rel, 30_000);
            out["ready"] = json!(st);
            let mut n = 0;
            for _ in 0..40 {
                if let Some(v) = ccg_lsp::semantic_tokens(&cwd, &rel) {
                    n = v["data"].as_array().map(|a| a.len() / 5).unwrap_or(0);
                    if n > 0 { break }
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            out["liveTokens"] = json!(n);
            std::thread::sleep(Duration::from_millis(800)); // 캐시 쓰기는 백그라운드 스레드
            let home = ccg_store::app_home().join("lsp").join("semcache");
            // 이 프로젝트의 캐시 파일을 전부 찾는다
            let mut files: Vec<std::path::PathBuf> = Vec::new();
            fn walk(d: &Path, out: &mut Vec<std::path::PathBuf>) {
                if let Ok(rd) = std::fs::read_dir(d) {
                    for e in rd.flatten() {
                        let p = e.path();
                        if p.is_dir() { walk(&p, out) } else if p.extension().map(|x| x == "json").unwrap_or(false) { out.push(p) }
                    }
                }
            }
            walk(&home, &mut files);
            out["cacheFiles"] = json!(files.len());
            let target = files.first().cloned();
            out["target"] = json!(target.as_ref().map(|p| p.to_string_lossy().to_string()));
            let mut cases = Vec::new();
            if let Some(f) = target {
                let orig = std::fs::read(&f).unwrap_or_default();
                let mut case = |name: &str, bytes: Vec<u8>| {
                    let _ = std::fs::write(&f, &bytes);
                    let t = Instant::now();
                    let r = std::panic::catch_unwind(|| ccg_lsp::cached_tokens(&cwd, &rel));
                    let took = (ms(t) * 100.0).round() / 100.0;
                    let (ok, shape) = match &r {
                        Ok(Some(v)) => (true, json!({ "data": v["data"].as_array().map(|a| a.len()),
                                                      "types": v["types"].as_array().map(|a| a.len()) })),
                        Ok(None) => (true, json!("null")),
                        Err(_) => (false, json!("PANIC")),
                    };
                    cases.push(json!({ "case": name, "noPanic": ok, "result": shape, "ms": took }));
                };
                case("truncated", orig[..orig.len() / 2].to_vec());
                case("empty", Vec::new());
                case("not-json", b"\x00\x01\x02 garbage".to_vec());
                case("valid-json-wrong-shape", br#"{"data":"nope","types":[],"mods":[]}"#.to_vec());
                // 5의 배수가 아닌 데이터 — 렌더러는 5튜플로 읽는다
                case("data-not-multiple-of-5", br#"{"data":[1,2,3],"types":["type"],"mods":[]}"#.to_vec());
                // 존재하지 않는 타입 인덱스 · 파일 끝을 넘는 줄 번호
                case("out-of-range-indices", br#"{"data":[999999,0,4,99,0],"types":["type"],"mods":[]}"#.to_vec());
                // u32 최대치 — 렌더러의 좌표 산술
                case("u32-max", br#"{"data":[4294967295,4294967295,4294967295,0,0],"types":["type"],"mods":[]}"#.to_vec());
                // 거대 배열(5MB) — 프리즈/메모리
                let big = format!(r#"{{"data":[{}],"types":["type"],"mods":[]}}"#,
                    (0..1_000_000).map(|i| (i % 7).to_string()).collect::<Vec<_>>().join(","));
                case("huge-1M-entries", big.into_bytes());
                let _ = std::fs::write(&f, &orig);
                // 원복 뒤 정상 적중하는가
                let back = ccg_lsp::cached_tokens(&cwd, &rel);
                out["restoredHit"] = json!(back.as_ref().and_then(|v| v["data"].as_array().map(|a| a.len() / 5)));
                // 손상 캐시를 스스로 치우는가(다음 실행에서도 계속 깨진 파일을 읽는지)
                let _ = std::fs::write(&f, b"broken");
                let _ = ccg_lsp::cached_tokens(&cwd, &rel);
                out["corruptFileStillThere"] = json!(f.exists());
                let _ = std::fs::write(&f, &orig);
            }
            out["cases"] = json!(cases);
        }

        // ── 문서 상한(32) 넘겨 열기 ─────────────────────────────────────────
        "manydocs" => {
            let n: usize = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(120);
            let root = Path::new(&cwd);
            let mut rels: Vec<String> = Vec::new();
            fn collect(d: &Path, root: &Path, out: &mut Vec<String>, cap: usize) {
                if out.len() >= cap { return }
                if let Ok(rd) = std::fs::read_dir(d) {
                    for e in rd.flatten() {
                        if out.len() >= cap { return }
                        let p = e.path();
                        if p.is_dir() {
                            if p.file_name().map(|x| x == "node_modules" || x == ".git").unwrap_or(false) { continue }
                            collect(&p, root, out, cap)
                        } else if p.extension().map(|x| x == "ts").unwrap_or(false) {
                            if let Ok(r) = p.strip_prefix(root) { out.push(r.to_string_lossy().replace('\\', "/")) }
                        }
                    }
                }
            }
            collect(root, root, &mut rels, n);
            out["files"] = json!(rels.len());
            let (st, rms) = wait_ready(&cwd, rels.first().map(String::as_str).unwrap_or(""), 60_000);
            out["ready"] = json!(st);
            out["readyMs"] = json!(rms.round());
            let mut lat: Vec<f64> = Vec::new();
            let mut empty = 0;
            let t0 = Instant::now();
            for r in &rels {
                let t = Instant::now();
                let v = ccg_lsp::semantic_tokens(&cwd, r);
                lat.push(ms(t));
                if v.as_ref().and_then(|x| x["data"].as_array().map(|a| a.is_empty())).unwrap_or(true) { empty += 1 }
            }
            out["totalMs"] = json!(ms(t0).round());
            lat.sort_by(|x, y| x.partial_cmp(y).unwrap());
            out["perFile"] = json!({ "p50": (lat[lat.len()/2]*100.0).round()/100.0,
                                     "p95": (lat[(lat.len() as f64*0.95) as usize % lat.len()]*100.0).round()/100.0,
                                     "max": (lat[lat.len()-1]*100.0).round()/100.0, "emptyTokens": empty });
            std::thread::sleep(Duration::from_millis(500));
            let lines = log_lines();
            let opens = lines.iter().filter(|l| l["ev"] == "didOpen").count();
            let closes = lines.iter().filter(|l| l["ev"] == "recv" && l["method"] == "textDocument/didClose").count();
            out["didOpen"] = json!(opens);
            out["didClose"] = json!(closes);
            out["procStarts"] = json!(lines.iter().filter(|l| l["ev"] == "start").count());
            out["serverAlive"] = json!(!lines.iter().any(|l| l["ev"] == "selfKill"));
            // 첫 파일을 다시 물었을 때 정확한가(축출 뒤 재개통)
            if let Some(first) = rels.first() {
                out["reopenFirst"] = json!(ccg_lsp::semantic_tokens(&cwd, first)
                    .and_then(|v| v["data"].as_array().map(|a| a.len() / 5)));
            }
        }
        _ => {
            eprintln!("알 수 없는 명령: {cmd}");
            std::process::exit(2);
        }
    }
    println!("{out}");
    ccg_lsp::dispose_all();
}
