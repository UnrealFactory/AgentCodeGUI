//! M3 PoC — Rust(tokio)가 Node SDK 없이 Claude Code CLI를 직접 모는 최소 하네스.
//!
//!   cargo run -- smoke          # 0원. 스폰+initialize+1턴, JSONL 프레이밍/stderr 분리
//!   cargo run -- approve        # LIVE. can_use_tool 왕복 (toolUseID 포함) + 항상-허용
//!   cargo run -- approve-noid   # LIVE. toolUseID를 뺀 응답 → 툴이 멈추는가?
//!   cargo run -- park           # LIVE. 승인에 아예 응답 안 함 → park deadline 있나?
//!   cargo run -- ask            # LIVE. AskUserQuestion을 deny+message로 답하는 트릭
//!   cargo run -- interrupt      # LIVE. 소프트 중단 후 같은 프로세스로 다음 턴
//!   cargo run -- resume         # LIVE. resume 컨텍스트 승계 + forkSession 파일 보존
//!   cargo run -- job [--no-job] [--busy]       # job object 좀비 차단 대조
//!                               #   --busy 면 실계정 턴 스트리밍 중에 부모를 죽인다
//!   cargo run -- cleanup        # --no-job 잔존분을 PID 지정으로 정리
//!
//! 대조 실험 드라이버: `bash job-test.sh --with-job|--no-job [--busy]`
//!
//! 실행 결과 프레임은 %TEMP%\ccg-poc-rs\<scenario>.jsonl 에 전부 남는다.

mod job;
mod wire;

use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};
use wire::*;

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let scenario = args.first().cloned().unwrap_or_else(|| "help".into());
    println!("=== scenario: {scenario} ===");
    println!("CLI : {}", cli_path().display());
    match scenario.as_str() {
        "smoke" => smoke().await,
        "approve" => approve(true).await,
        "approve-noid" => approve(false).await,
        "park" => park().await,
        "ask" => ask().await,
        "interrupt" => interrupt().await,
        "resume" => resume().await,
        "job" => {
            job_scenario(
                !args.iter().any(|a| a == "--no-job"),
                args.iter().any(|a| a == "--busy"),
            )
            .await
        }
        "cleanup" => cleanup(),
        _ => println!(
            "scenarios: smoke | approve | approve-noid | park | ask | interrupt | resume \
             | job [--no-job] [--busy] | cleanup"
        ),
    }
}

// ── 1. 스폰 + initialize + 1턴 스트리밍 ────────────────────────
// 0원 경로(빈 CLAUDE_CONFIG_DIR): 와이어 모양·프레이밍·stderr 분리만 본다.
// --debug 를 얹어 stderr에 일부러 트래픽을 흘려, stdout JSONL이 오염되지 않는지 확인.
async fn smoke() {
    let mut o = SpawnOpts::new("smoke", false);
    o.extra_args.push("--debug".into());
    let mut h = Harness::spawn(o).expect("spawn");
    println!("pid={} cfg={}", h.pid, h.config_dir.display());
    h.send(&init_req("init-1"));
    h.send(&user_msg("hi"));
    let mut frames = vec![];
    let t0 = Instant::now();
    while let Some(f) = h.next(60).await {
        println!("<<< [{:>5}ms] {}", t0.elapsed().as_millis(), tag(&f));
        let done = f["type"] == "result";
        frames.push(f);
        if done {
            h.close_input();
            break;
        }
    }
    let _ = tokio::time::timeout(Duration::from_secs(10), h.child.wait()).await;
    // exit 관측 후에도 stderr를 마저 드레인(§3.1)
    tokio::time::sleep(Duration::from_millis(300)).await;
    println!("--- kinds: {}", kinds_summary(&frames));
    h.dump_stats();

    // stderr 분리 확인 — 일부러 잘못된 플래그를 줘 CLI가 stderr로만 떠들게 한다.
    // stdout JSONL 스트림이 오염되지 않는지(parse_err/frames)가 관전 포인트.
    println!("=== stderr separation probe (bogus flag) ===");
    let mut o2 = SpawnOpts::new("smoke-stderr", false);
    o2.extra_args.push("--ccg-bogus-flag".into());
    let mut h2 = Harness::spawn(o2).expect("spawn");
    h2.send(&init_req("init-1"));
    let _ = h2.next(15).await;
    let st = tokio::time::timeout(Duration::from_secs(15), h2.child.wait()).await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    println!("--- exit: {st:?}");
    h2.dump_stats();
}

// ── 2. can_use_tool 승인 왕복 (최우선 위험) ────────────────────
// with_id=true : SDK와 동일하게 toolUseID를 덧붙인 응답 + updatedPermissions(항상 허용)
// with_id=false: toolUseID를 뺀 응답 → CLI가 매칭 못 하면 툴이 영구 정지하는가?
async fn approve(with_id: bool) {
    let name = if with_id { "approve" } else { "approve-noid" };
    let mut h = Harness::spawn(SpawnOpts::new(name, true)).expect("spawn");
    println!("pid={} cfg={}", h.pid, h.config_dir.display());
    h.send(&init_req("init-1"));
    // ★ Bash(`echo …`)는 CLI의 커맨드 안전 분류기가 스스로 통과시켜 can_use_tool이
    //   아예 안 온다(실측 1차 시도 — asks=0). 승인 게이트를 확실히 때리는 건 Write.
    let prompt = if with_id {
        "Use the Write tool to create a file a.txt containing exactly AAA. Wait for it to finish, then use the Write tool again to create b.txt containing exactly BBB. One at a time, never both at once. Then reply with exactly: DONE"
    } else {
        "Use the Write tool to create a file noid.txt containing exactly NOID. Then reply with exactly: DONE"
    };
    h.send(&user_msg(prompt));

    let mut asks = 0usize;
    let mut pending: Option<(String, String, Value)> = None; // (request_id, tool_use_id, input)
    let t0 = Instant::now();
    let mut frames = vec![];
    let mut stalled = false;
    let mut recovered = false;
    let mut answered_at: Option<Instant> = None;

    loop {
        let wait = if pending.is_some() { 60 } else { 180 };
        let Some(f) = h.next(wait).await else {
            // 응답을 보낸 뒤 아무 프레임도 안 온다 = 정지
            if let Some((rid, tuid, input0)) = pending.clone() {
                println!(
                    "!!! {wait}s STALL — no frame after the permission response (request_id={rid})"
                );
                stalled = true;
                if !with_id {
                    // 같은 request_id로 이번엔 toolUseID를 붙여 재응답 → 회복되는가?
                    println!(">>> retry same request_id WITH toolUseID");
                    h.send(&ctrl_ok(
                        &rid,
                        json!({"behavior":"allow","updatedInput":input0,"toolUseID":tuid}),
                    ));
                    pending = None;
                    if let Some(f2) = h.next(60).await {
                        println!("<<< RECOVERED [{:>5}ms] {}", t0.elapsed().as_millis(), tag(&f2));
                        recovered = true;
                        frames.push(f2);
                        continue;
                    }
                    println!("!!! still nothing after the corrected response → sending interrupt");
                    h.send(&ctrl_req("int-1", json!({"subtype":"interrupt"})));
                    while let Some(f3) = h.next(20).await {
                        println!("<<< [{:>5}ms] {}", t0.elapsed().as_millis(), tag(&f3));
                        let done = f3["type"] == "result";
                        frames.push(f3);
                        if done {
                            break;
                        }
                    }
                }
            }
            break;
        };
        println!("<<< [{:>5}ms] {}", t0.elapsed().as_millis(), tag(&f));

        if f["type"] == "control_request" && f["request"]["subtype"] == "can_use_tool" {
            asks += 1;
            let rid = f["request_id"].as_str().unwrap_or("").to_string();
            let tuid = f["request"]["tool_use_id"].as_str().unwrap_or("").to_string();
            if asks == 1 {
                println!("--- can_use_tool payload keys: {:?}", keys(&f["request"]));
                println!(
                    "--- full request: {}",
                    serde_json::to_string_pretty(&f["request"]).unwrap()
                );
            }
            let input = f["request"]["input"].clone();
            let mut resp = json!({"behavior":"allow","updatedInput":input});
            // [critic] updatedPermissions는 with_id 경로에서만 붙인다.
            //   원본은 noid 경로에도 addRules를 실어, "툴이 진행된 건 세션 규칙이
            //   생겨서지 request_id 매칭 때문이 아니다"라는 대안 설명을 배제하지
            //   못했다. noid는 순수 {behavior,updatedInput}만 보낸다.
            if with_id && asks == 1 {
                // 2.6.2의 "항상 허용" — 세션 스코프 규칙 (engine.ts:2222-2228)
                resp["updatedPermissions"] = json!([{
                    "type":"addRules",
                    "rules":[{"toolName":"Write"}],
                    "behavior":"allow",
                    "destination":"session"
                }]);
            }
            if with_id {
                resp["toolUseID"] = json!(tuid);
            } else {
                println!("--- (deliberately omitting toolUseID)");
            }
            h.send(&ctrl_ok(&rid, resp));
            answered_at = Some(Instant::now()); // [critic] 응답→다음 프레임 지연 실측
            pending = Some((rid, tuid, input.clone()));
            frames.push(f);
            continue;
        }
        // 프레임이 흐르면 정지 아님
        if let Some(a) = answered_at.take() {
            println!(
                "--- [critic] first frame after permission response: +{} ms  ({})",
                a.elapsed().as_millis(),
                tag(&f)
            );
        }
        pending = None;
        let done = f["type"] == "result";
        frames.push(f);
        if done {
            h.close_input();
            break;
        }
    }
    println!("--- can_use_tool asks: {asks}");
    println!("--- stalled: {stalled}  recovered_after_retry: {recovered}");
    println!("--- kinds: {}", kinds_summary(&frames));
    let _ = tokio::time::timeout(Duration::from_secs(10), h.child.wait()).await;
    h.dump_stats();
}

// ── 2b. 응답을 아예 안 보내면? (park deadline 유무) ─────────────
// sdk.d.ts:209-217 경고 "승인 요청에는 park deadline이 없다"의 라이브 검증 +
// 멈춘 턴을 interrupt로 풀 수 있는지(엔진의 회복 경로).
async fn park() {
    let mut h = Harness::spawn(SpawnOpts::new("park", true)).expect("spawn");
    h.send(&init_req("init-1"));
    h.send(&user_msg(
        "Use the Write tool to create a file park.txt containing exactly PARK. Then reply with exactly: DONE",
    ));
    let t0 = Instant::now();
    let mut parked = false;
    while let Some(f) = h.next(180).await {
        println!("<<< [{:>5}ms] {}", t0.elapsed().as_millis(), tag(&f));
        if f["type"] == "control_request" && f["request"]["subtype"] == "can_use_tool" {
            println!("!!! NOT answering this permission request — parking for 90s");
            parked = true;
            break;
        }
    }
    assert!(parked, "no can_use_tool arrived");
    let mut frames_while_parked = 0;
    let park_t = Instant::now();
    while park_t.elapsed() < Duration::from_secs(90) {
        if let Some(f) = h.next(5).await {
            frames_while_parked += 1;
            println!("<<< [parked {:>3}s] {}", park_t.elapsed().as_secs(), tag(&f));
        }
    }
    println!("--- frames during 90s park: {frames_while_parked}  (0 ⇒ park deadline 없음 = 영구 정지)");
    println!("--- process alive while parked: {}", h.alive());

    println!(">>> interrupt to unwedge the parked turn");
    h.send(&ctrl_req("int-1", json!({"subtype":"interrupt"})));
    let mut unwedged = false;
    while let Some(f) = h.next(20).await {
        println!("<<< [{:>5}ms] {}", t0.elapsed().as_millis(), tag(&f));
        if f["type"] == "result" {
            unwedged = true;
            break;
        }
    }
    println!("--- interrupt unwedged the parked permission: {unwedged}");
    println!("--- process alive: {}", h.alive());
    if unwedged {
        println!(">>> next turn on the SAME process");
        h.send(&user_msg("Reply with exactly: AFTERPARK"));
        while let Some(f) = h.next(90).await {
            println!("<<< [{:>5}ms] {}", t0.elapsed().as_millis(), tag(&f));
            if f["type"] == "result" {
                break;
            }
        }
    }
    h.close_input();
    let st = tokio::time::timeout(Duration::from_secs(15), h.child.wait()).await;
    println!("--- exit: {st:?}");
    h.dump_stats();
}

// ── 3. AskUserQuestion — deny + message 트릭 ───────────────────
async fn ask() {
    let mut h = Harness::spawn(SpawnOpts::new("ask", true)).expect("spawn");
    h.send(&init_req("init-1"));
    h.send(&user_msg(
        "Call the AskUserQuestion tool once to ask me which language to use, with exactly two options: Rust and Go. \
         After you get my answer, reply with exactly one line: CHOSEN=<the language I picked>",
    ));
    let t0 = Instant::now();
    let mut frames = vec![];
    let mut saw_ask = false;
    while let Some(f) = h.next(180).await {
        println!("<<< [{:>5}ms] {}", t0.elapsed().as_millis(), tag(&f));
        if f["type"] == "control_request" && f["request"]["subtype"] == "can_use_tool" {
            let rid = f["request_id"].as_str().unwrap_or("").to_string();
            let tuid = f["request"]["tool_use_id"].as_str().unwrap_or("").to_string();
            let tool = f["request"]["tool_name"].as_str().unwrap_or("").to_string();
            println!(
                "--- request: {}",
                serde_json::to_string_pretty(&f["request"]).unwrap()
            );
            let resp = if tool == "AskUserQuestion" {
                saw_ask = true;
                // engine.ts:2372-2388 formatAnswers 와 같은 문법
                json!({"behavior":"deny",
                       "message":"사용자가 질문에 다음과 같이 답했습니다: Rust",
                       "toolUseID":tuid})
            } else {
                json!({"behavior":"allow","updatedInput":f["request"]["input"].clone(),"toolUseID":tuid})
            };
            h.send(&ctrl_ok(&rid, resp));
            frames.push(f);
            continue;
        }
        let done = f["type"] == "result";
        frames.push(f);
        if done {
            h.close_input();
            break;
        }
    }
    println!("--- AskUserQuestion observed: {saw_ask}");
    println!("--- kinds: {}", kinds_summary(&frames));
    let _ = tokio::time::timeout(Duration::from_secs(10), h.child.wait()).await;
    h.dump_stats();
}

// ── 4. interrupt — 턴만 끊고 프로세스는 산다 ────────────────────
async fn interrupt() {
    let mut h = Harness::spawn(SpawnOpts::new("interrupt", true)).expect("spawn");
    println!("pid={}", h.pid);
    h.send(&init_req("init-1"));
    h.send(&user_msg(
        "Count from 1 to 400, one number per line, nothing else.",
    ));
    let t0 = Instant::now();
    let mut frames = vec![];
    let mut deltas = 0usize;
    let mut sent = false;
    let mut int_resp: Option<Value> = None;
    let mut result1: Option<Value> = None;

    while let Some(f) = h.next(120).await {
        println!("<<< [{:>5}ms] {}", t0.elapsed().as_millis(), tag(&f));
        if f["event"]["delta"]["type"] == "text_delta" {
            deltas += 1;
        }
        if !sent && deltas >= 3 {
            sent = true;
            println!(">>> INTERRUPT after {deltas} deltas");
            h.send(&ctrl_req("int-1", json!({"subtype":"interrupt"})));
        }
        if f["type"] == "control_response" && f["response"]["request_id"] == "int-1" {
            int_resp = Some(f["response"].clone());
        }
        let done = f["type"] == "result";
        if done {
            result1 = Some(f.clone());
        }
        frames.push(f);
        if done {
            break;
        }
    }
    println!(
        "--- interrupt control_response: {}",
        int_resp
            .as_ref()
            .map(|v| v.to_string())
            .unwrap_or("(none)".into())
    );
    println!(
        "--- turn-1 result: subtype={} is_error={} stop_reason={} terminal_reason={}",
        result1.as_ref().map(|r| r["subtype"].clone()).unwrap_or(Value::Null),
        result1.as_ref().map(|r| r["is_error"].clone()).unwrap_or(Value::Null),
        result1.as_ref().map(|r| r["stop_reason"].clone()).unwrap_or(Value::Null),
        result1.as_ref().map(|r| r["terminal_reason"].clone()).unwrap_or(Value::Null),
    );
    tokio::time::sleep(Duration::from_millis(500)).await;
    println!("--- process alive after interrupt: {}", h.alive());

    // 같은 프로세스로 다음 턴 (2.6.2의 '중단 1회 → 매 턴 CLI 사망 루프' 재현 확인)
    println!(">>> turn 2 on the SAME process");
    h.send(&user_msg("Reply with exactly: SECOND"));
    let mut turn2_ok = false;
    let mut f2 = vec![];
    while let Some(f) = h.next(120).await {
        println!("<<< [{:>5}ms] {}", t0.elapsed().as_millis(), tag(&f));
        let done = f["type"] == "result";
        if done {
            turn2_ok = f["is_error"] == false;
        }
        f2.push(f);
        if done {
            break;
        }
    }
    println!("--- turn 2 completed ok: {turn2_ok}");
    println!("--- process alive after turn 2: {}", h.alive());

    // 세 번째 턴까지 — '매 턴 사망'이면 여기서 죽는다
    println!(">>> turn 3 on the SAME process");
    h.send(&user_msg("Reply with exactly: THIRD"));
    let mut turn3_ok = false;
    while let Some(f) = h.next(120).await {
        println!("<<< [{:>5}ms] {}", t0.elapsed().as_millis(), tag(&f));
        let done = f["type"] == "result";
        if done {
            turn3_ok = f["is_error"] == false;
            break;
        }
    }
    println!("--- turn 3 completed ok: {turn3_ok}");
    println!("--- process alive after turn 3: {}", h.alive());
    h.close_input();
    let st = tokio::time::timeout(Duration::from_secs(15), h.child.wait()).await;
    println!("--- exit after stdin EOF: {st:?}");
    println!("--- kinds(turn1): {}", kinds_summary(&frames));
    h.dump_stats();
}

// ── 5. resume + forkSession ────────────────────────────────────
async fn resume() {
    // turn 1 — 코드워드를 세션에 심는다
    let s1 = one_shot("resume-1", vec![], "Remember this codeword: BANANA47. Reply with exactly: OK").await;
    let sid = s1.0.expect("session id");
    println!("### session 1 = {sid}");
    let cfg = default_account_dir();
    let cwd = out_dir().join("work");
    let before = session_files(&cfg, &cwd);
    println!("### session files after turn1: {before:#?}");

    // turn 2 — resume: 컨텍스트가 이어지는가?
    let s2 = one_shot(
        "resume-2",
        vec![format!("--resume={sid}")],
        "What was the codeword? Reply with just the word, nothing else.",
    )
    .await;
    println!("### resumed session id = {:?}", s2.0);
    println!("### resumed answer     = {:?}", s2.1);
    println!(
        "### context carried    = {}",
        s2.1.as_deref().unwrap_or("").contains("BANANA47")
    );

    // turn 3 — fork: 새 id가 생기고 원본 파일이 보존되는가?
    let s3 = one_shot(
        "resume-3-fork",
        vec![format!("--resume={sid}"), "--fork-session".into()],
        "What was the codeword? Reply with just the word, nothing else.",
    )
    .await;
    println!("### forked session id  = {:?}", s3.0);
    println!("### forked answer      = {:?}", s3.1);
    let after = session_files(&cfg, &cwd);
    println!("### session files after fork: {after:#?}");
    println!(
        "### original transcript still present: {}",
        after.iter().any(|(n, _)| n.contains(&sid))
    );
    println!(
        "### fork produced a NEW id: {}",
        s3.0.as_deref().map(|x| x != sid).unwrap_or(false)
    );
    println!(
        "### resume kept the SAME id: {}",
        s2.0.as_deref().map(|x| x == sid).unwrap_or(false)
    );
}

/// 한 턴 돌리고 (session_id, result 텍스트) 반환. stdin은 result 후 닫는다.
async fn one_shot(name: &str, extra: Vec<String>, prompt: &str) -> (Option<String>, Option<String>) {
    let mut o = SpawnOpts::new(name, true);
    o.extra_args = extra;
    let mut h = Harness::spawn(o).expect("spawn");
    h.send(&init_req("init-1"));
    h.send(&user_msg(prompt));
    let mut sid = None;
    let mut res = None;
    let t0 = Instant::now();
    while let Some(f) = h.next(180).await {
        println!("<<< [{:>5}ms] {}", t0.elapsed().as_millis(), tag(&f));
        if f["type"] == "system" && f["subtype"] == "init" {
            sid = f["session_id"].as_str().map(String::from);
        }
        if f["type"] == "control_request" && f["request"]["subtype"] == "can_use_tool" {
            let rid = f["request_id"].as_str().unwrap_or("").to_string();
            let tuid = f["request"]["tool_use_id"].as_str().unwrap_or("").to_string();
            h.send(&ctrl_ok(
                &rid,
                json!({"behavior":"allow","updatedInput":f["request"]["input"].clone(),"toolUseID":tuid}),
            ));
            continue;
        }
        if f["type"] == "result" {
            res = f["result"].as_str().map(String::from);
            h.close_input();
            break;
        }
    }
    let _ = tokio::time::timeout(Duration::from_secs(10), h.child.wait()).await;
    h.dump_stats();
    (sid, res)
}

/// <config>/projects/<cwd 슬러그>/ 아래 전사 파일 목록.
fn session_files(cfg: &Path, cwd: &Path) -> Vec<(String, u64)> {
    let slug: String = cwd
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let dir = cfg.join("projects").join(&slug);
    let mut out = vec![];
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            let len = e.metadata().map(|m| m.len()).unwrap_or(0);
            out.push((n, len));
        }
    } else {
        out.push((format!("(missing) {}", dir.display()), 0));
    }
    out.sort();
    out
}

// ── 6. job object 좀비 차단 ────────────────────────────────────
async fn job_scenario(with_job: bool, busy: bool) {
    let j = if with_job {
        Some(Arc::new(job::Job::create().expect("CreateJobObject")))
    } else {
        None
    };
    println!("--- job object: {}", if with_job { "ON (KILL_ON_JOB_CLOSE)" } else { "OFF (control)" });

    // (a) 진짜 표적: 337MB claude.exe. 자격증명 없는 config로 띄우고 initialize만
    //     보내 상주시킨다(사용자 턴 없음 = 0원).
    //     --busy 면 실계정으로 긴 턴을 띄운 채(스트리밍 중) 부모를 죽인다 —
    //     "턴 중 앱 크래시"가 진짜 위험 케이스라서.
    let mut o = SpawnOpts::new(if with_job { "job-on" } else { "job-off" }, busy);
    o.job = j.clone();
    let mut h = Harness::spawn(o).expect("spawn");
    h.send(&init_req("init-1"));
    if busy {
        h.send(&user_msg(
            "Count from 1 to 2000, one number per line, nothing else.",
        ));
        // 실제로 스트리밍이 시작될 때까지 기다린다 = 턴 진행 중 상태 확보
        for _ in 0..40 {
            match h.next(10).await {
                Some(f) if f["event"]["delta"]["type"] == "text_delta" => {
                    println!("--- turn is streaming; killing the parent mid-turn");
                    break;
                }
                Some(_) => continue,
                None => break,
            }
        }
    } else {
        let _ = h.next(20).await;
    }

    // (b) 손자 사슬: cmd.exe → ping.exe
    let mut c = tokio::process::Command::new("cmd.exe");
    c.args(["/c", "ping -n 600 127.0.0.1 > NUL"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        c.creation_flags(0x0800_0000);
    }
    let child = c.spawn().expect("cmd");
    let cmd_pid = child.id().unwrap_or(0);
    #[cfg(windows)]
    if let Some(job) = &j {
        job.assign(child.raw_handle().expect("h") as *mut std::ffi::c_void)
            .expect("assign cmd");
    }

    let me = std::process::id();
    let pids = json!({
        "mode": if with_job { "with-job" } else { "no-job" },
        "self": me, "claude": h.pid, "cmd": cmd_pid
    });
    let pf = out_dir().join("job-pids.json");
    std::fs::write(&pf, pids.to_string()).unwrap();
    println!("--- pids: {pids}");
    println!("--- wrote {}", pf.display());

    // 외부 관측자(bash 드라이버)가 프로세스 트리를 찍을 시간을 준 뒤 자살 신호를 기다린다.
    let go = out_dir().join("job-go");
    std::fs::remove_file(&go).ok();
    println!("--- waiting for {} (touch it to make me taskkill /F myself)", go.display());
    for _ in 0..600 {
        if go.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    println!("--- taskkill /F /PID {me} (self)");
    // 부모를 '앱 크래시'처럼 강제 종료. 정상 정리 경로를 타지 않는다.
    let _ = std::process::Command::new("taskkill")
        .args(["/F", "/PID", &me.to_string()])
        .status();
    tokio::time::sleep(Duration::from_secs(5)).await;
    println!("--- (unreachable if taskkill worked)");
}

/// --no-job 대조군이 남긴 잔존 프로세스를 **PID 지정**으로만 정리한다.
/// 이름 기반 kill(taskkill /IM) 금지 — 사용자 실앱이 떠 있다.
fn cleanup() {
    let pf = out_dir().join("job-pids.json");
    let Ok(s) = std::fs::read_to_string(&pf) else {
        println!("no {}", pf.display());
        return;
    };
    let v: Value = serde_json::from_str(&s).unwrap();
    for k in ["claude", "cmd"] {
        if let Some(pid) = v[k].as_u64() {
            let st = std::process::Command::new("taskkill")
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .output();
            println!(
                "cleanup {k} pid={pid} → {}",
                st.map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                    .unwrap_or_default()
            );
        }
    }
}

fn keys(v: &Value) -> Vec<String> {
    v.as_object()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default()
}
