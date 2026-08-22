//! claude.exe 스폰 + JSONL 프레이밍 + 컨트롤 봉투 헬퍼.
//! docs/protocol-claude-cli.md §2(스폰) §3(프레이밍) §4(컨트롤)의 Rust 구현.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Write as _;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

/// 한 프레임 상한. 초과하면 그 줄을 버린다(대용량 tool_result 방어) — §3.1.
pub const MAX_LINE: usize = 64 * 1024 * 1024;
const CHUNK: usize = 8192;

pub fn home() -> PathBuf {
    PathBuf::from(std::env::var("USERPROFILE").unwrap_or_else(|_| std::env::var("HOME").unwrap()))
        .join(".agentcodegui")
}

/// §1.2 SDK의 CLI 해석 규칙을 그대로 조립 (node resolve 불필요 — 레이아웃이 평평).
pub fn cli_path() -> PathBuf {
    let engine = std::env::var("CCG_ENGINE").unwrap_or_else(|_| {
        std::fs::read_to_string(home().join("config.json"))
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v["activeVersion"].as_str().map(String::from))
            .unwrap_or_else(|| "0.3.239".into())
    });
    let (dir, exe) = if cfg!(windows) {
        ("claude-agent-sdk-win32-x64", "claude.exe")
    } else {
        ("claude-agent-sdk-linux-x64", "claude")
    };
    home()
        .join("engines")
        .join(engine)
        .join("node_modules/@anthropic-ai")
        .join(dir)
        .join(exe)
}

pub fn out_dir() -> PathBuf {
    let d = std::env::temp_dir().join("ccg-poc-rs");
    std::fs::create_dir_all(&d).ok();
    d
}

/// 기본 계정(accounts.json defaultEmail)의 물질화된 폴더 = 구독 과금 경로.
pub fn default_account_dir() -> PathBuf {
    let acc: Value = serde_json::from_str(
        &std::fs::read_to_string(home().join("accounts.json")).expect("accounts.json"),
    )
    .expect("accounts.json parse");
    let email = acc["defaultEmail"].as_str().expect("defaultEmail");
    let prefix = email.replace('@', "_").replace('+', "-");
    let root = home().join("accounts");
    for e in std::fs::read_dir(&root).expect("accounts dir").flatten() {
        let n = e.file_name().to_string_lossy().to_string();
        if n.starts_with(&prefix) {
            return root.join(n);
        }
    }
    panic!("no account dir for {email}");
}

/// 자격증명 없는 빈 폴더 = 0원 스모크(§2.3).
pub fn noauth_config_dir() -> PathBuf {
    let d = out_dir().join("noauth-config");
    std::fs::create_dir_all(&d).ok();
    d
}

#[derive(Default, Clone, Debug)]
pub struct FrameStats {
    pub read_calls: usize,
    pub bytes: usize,
    pub lines: usize,
    pub parse_errors: usize,
    pub empty_lines: usize,
    /// 여러 번의 read()에 걸쳐 완성된 줄 수 = 부분 라인 처리가 실제로 일어난 횟수
    pub lines_spanning_reads: usize,
    pub max_line_len: usize,
    pub oversized_dropped: usize,
}

pub enum Out {
    Line(String),
    /// stdin EOF = endInput. CLI가 정리 후 종료한다(§3.2).
    Close,
}

pub struct Harness {
    pub child: Child,
    pub pid: u32,
    tx: mpsc::UnboundedSender<Out>,
    pub rx: mpsc::Receiver<Value>,
    pub stats: Arc<Mutex<FrameStats>>,
    pub stderr_lines: Arc<Mutex<Vec<String>>>,
    pub log: PathBuf,
    pub config_dir: PathBuf,
}

pub struct SpawnOpts {
    pub scenario: String,
    pub live: bool,
    pub cwd: PathBuf,
    /// 추가 argv (예: --resume=<id>, --fork-session)
    pub extra_args: Vec<String>,
    pub permission_mode: String,
    /// job object에 넣을지
    pub job: Option<Arc<crate::job::Job>>,
}

impl SpawnOpts {
    pub fn new(scenario: &str, live: bool) -> Self {
        let cwd = out_dir().join("work");
        std::fs::create_dir_all(&cwd).ok();
        Self {
            scenario: scenario.into(),
            live,
            cwd,
            extra_args: vec![],
            permission_mode: "default".into(),
            job: None,
        }
    }
}

impl Harness {
    pub fn spawn(o: SpawnOpts) -> std::io::Result<Harness> {
        let cli = cli_path();
        assert!(cli.exists(), "CLI not found: {}", cli.display());
        let config_dir = if o.live {
            default_account_dir()
        } else {
            noauth_config_dir()
        };

        // §2.1 argv — 2.6.2 engine.ts가 만드는 것과 동일(haiku + thinking disabled).
        let settings = json!({ "permissions": { "defaultMode": o.permission_mode } }).to_string();
        let mut args: Vec<String> = vec![
            "--output-format".into(),
            "stream-json".into(),
            "--verbose".into(),
            "--input-format".into(),
            "stream-json".into(),
            "--thinking".into(),
            "disabled".into(),
            "--model".into(),
            "haiku".into(),
            "--permission-prompt-tool".into(),
            "stdio".into(),
            "--setting-sources=user,project,local".into(),
            "--permission-mode".into(),
            o.permission_mode.clone(),
            "--include-partial-messages".into(),
        ];
        args.extend(o.extra_args.iter().cloned());
        // --settings 는 맨 뒤(§2.1 #40)
        args.push("--settings".into());
        args.push(settings);

        // §2.3 env — 지정 시 process.env "대체" 의미론이지만, 여기선 상속 + 덮어쓰기
        //  (2.6.2 engine.ts와 같은 방식: {...process.env, CLAUDE_CONFIG_DIR}).
        let mut cmd = Command::new(&cli);
        cmd.args(&args)
            .current_dir(&o.cwd)
            .env("CLAUDE_CODE_ENTRYPOINT", "sdk-ts")
            .env("CLAUDE_AGENT_SDK_VERSION", "0.3.239")
            .env("CLAUDE_CONFIG_DIR", &config_dir)
            .env("MSBUILDDISABLENODEREUSE", "1")
            .env_remove("NODE_OPTIONS") // ★ 남기면 CLI 오작동
            .env_remove("DEBUG")
            .env_remove("ANTHROPIC_API_KEY") // 구독 경로
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(false);
        #[cfg(windows)]
        {
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }

        let mut child = cmd.spawn()?;
        let pid = child.id().unwrap_or(0);

        // ★ job 편입은 spawn 직후, 첫 write 전에.
        #[cfg(windows)]
        if let Some(job) = &o.job {
            let h = child.raw_handle().expect("raw_handle");
            job.assign(h as *mut std::ffi::c_void)
                .expect("AssignProcessToJobObject");
        }

        let log = out_dir().join(format!("{}.jsonl", o.scenario));
        std::fs::write(&log, "").ok();

        // ── stdin writer 태스크 (프레임 인터리브 방지 — §8.1-3)
        let (tx, mut rx_in) = mpsc::unbounded_channel::<Out>();
        let mut stdin = child.stdin.take().unwrap();
        tokio::spawn(async move {
            while let Some(m) = rx_in.recv().await {
                match m {
                    Out::Line(s) => {
                        if stdin.write_all(s.as_bytes()).await.is_err() {
                            break;
                        }
                        if stdin.write_all(b"\n").await.is_err() {
                            break;
                        }
                        let _ = stdin.flush().await;
                    }
                    Out::Close => break, // drop(stdin) ⇒ EOF
                }
            }
            drop(stdin);
        });

        // ── stdout reader: 직접 바이트 루프. \n 을 만나기 전엔 절대 파싱하지 않는다.
        let (tx_out, rx_out) = mpsc::channel::<Value>(1024);
        let stats = Arc::new(Mutex::new(FrameStats::default()));
        let stats2 = stats.clone();
        let log2 = log.clone();
        let mut stdout = child.stdout.take().unwrap();
        tokio::spawn(async move {
            let mut buf: Vec<u8> = Vec::with_capacity(1 << 16);
            let mut chunk = vec![0u8; CHUNK];
            let mut logf = std::fs::OpenOptions::new()
                .append(true)
                .open(&log2)
                .unwrap();
            loop {
                let n = match stdout.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                let carry = buf.len(); // 이전 read 에서 넘어온 미완성 꼬리
                {
                    let mut s = stats2.lock().unwrap();
                    s.read_calls += 1;
                    s.bytes += n;
                }
                buf.extend_from_slice(&chunk[..n]);
                let mut start = 0usize;
                let mut first_line = true;
                while let Some(pos) = buf[start..].iter().position(|&b| b == b'\n') {
                    let end = start + pos;
                    let line = &buf[start..end];
                    start = end + 1;
                    {
                        let mut s = stats2.lock().unwrap();
                        s.max_line_len = s.max_line_len.max(line.len());
                        if first_line && carry > 0 {
                            s.lines_spanning_reads += 1;
                        }
                    }
                    first_line = false;
                    let txt = String::from_utf8_lossy(line);
                    let txt = txt.trim_end_matches('\r');
                    if txt.trim().is_empty() {
                        stats2.lock().unwrap().empty_lines += 1;
                        continue; // ★ 빈 줄 스킵
                    }
                    if txt.len() > MAX_LINE {
                        stats2.lock().unwrap().oversized_dropped += 1;
                        continue;
                    }
                    match serde_json::from_str::<Value>(txt) {
                        Ok(v) => {
                            stats2.lock().unwrap().lines += 1;
                            let _ = writeln!(logf, "{txt}");
                            if tx_out.send(v).await.is_err() {
                                return;
                            }
                        }
                        Err(_) => {
                            // ★ 파싱 실패 줄은 버리고 계속 — 절대 죽지 않는다
                            stats2.lock().unwrap().parse_errors += 1;
                            eprintln!("!!! non-JSON stdout: {}", &txt[..txt.len().min(200)]);
                        }
                    }
                }
                buf.drain(..start);
            }
            // EOF에 개행 없는 꼬리가 남았으면 여기서 한 번 시도
            if !buf.is_empty() {
                let txt = String::from_utf8_lossy(&buf).trim().to_string();
                if !txt.is_empty() {
                    match serde_json::from_str::<Value>(&txt) {
                        Ok(v) => {
                            stats2.lock().unwrap().lines += 1;
                            let _ = tx_out.send(v).await;
                        }
                        Err(_) => {
                            stats2.lock().unwrap().parse_errors += 1;
                        }
                    }
                }
            }
        });

        // ── stderr: 완전 분리. JSON 아님. exit 후에도 마저 드레인(§3.1).
        let errs = Arc::new(Mutex::new(Vec::<String>::new()));
        let errs2 = errs.clone();
        let mut stderr = child.stderr.take().unwrap();
        tokio::spawn(async move {
            let mut acc = Vec::new();
            let mut chunk = vec![0u8; 4096];
            loop {
                match stderr.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => acc.extend_from_slice(&chunk[..n]),
                }
                let s = String::from_utf8_lossy(&acc).to_string();
                let mut parts: Vec<&str> = s.split('\n').collect();
                let tail = parts.pop().unwrap_or("").to_string();
                for p in parts {
                    let p = p.trim();
                    if !p.is_empty() {
                        eprintln!("[stderr] {p}");
                        errs2.lock().unwrap().push(p.to_string());
                    }
                }
                acc = tail.into_bytes();
            }
        });

        Ok(Harness {
            child,
            pid,
            tx,
            rx: rx_out,
            stats,
            stderr_lines: errs,
            log,
            // (cwd는 SpawnOpts에만 필요)
            config_dir,
        })
    }

    pub fn send(&self, v: &Value) {
        let s = v.to_string();
        println!(">>> {}", &s[..s.len().min(220)]);
        let _ = self.tx.send(Out::Line(s));
    }

    pub fn close_input(&self) {
        println!(">>> (stdin EOF)");
        let _ = self.tx.send(Out::Close);
    }

    pub async fn next(&mut self, secs: u64) -> Option<Value> {
        match tokio::time::timeout(Duration::from_secs(secs), self.rx.recv()).await {
            Ok(v) => v,
            Err(_) => None,
        }
    }

    pub fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    pub fn dump_stats(&self) {
        let s = self.stats.lock().unwrap().clone();
        println!(
            "--- framing: read()={} bytes={} frames={} spanning_reads={} max_line={} parse_err={} empty={} oversized={}",
            s.read_calls, s.bytes, s.lines, s.lines_spanning_reads, s.max_line_len, s.parse_errors, s.empty_lines, s.oversized_dropped
        );
        let e = self.stderr_lines.lock().unwrap();
        println!("--- stderr lines: {} {:?}", e.len(), &e[..e.len().min(5)]);
        println!("--- frames log: {}", self.log.display());
    }
}

// ── 프레임 헬퍼 ────────────────────────────────────────────────

/// §4.2 — systemPrompt는 **넣지 않는다**(claude_code 프리셋 유지).
pub fn init_req(id: &str) -> Value {
    json!({"type":"control_request","request_id":id,"request":{
        "subtype":"initialize",
        "forwardSubagentText": true,
        "supportedDialogKinds": ["refusal_fallback_prompt"]
    }})
}

pub fn user_msg(text: &str) -> Value {
    json!({"type":"user","session_id":"","parent_tool_use_id":null,
           "message":{"role":"user","content":[{"type":"text","text":text}]}})
}

pub fn ctrl_req(id: &str, req: Value) -> Value {
    json!({"type":"control_request","request_id":id,"request":req})
}

pub fn ctrl_ok(request_id: &str, response: Value) -> Value {
    json!({"type":"control_response","response":{
        "subtype":"success","request_id":request_id,"response":response}})
}

/// 사람이 읽는 한 줄 태그.
pub fn tag(m: &Value) -> String {
    let t = m["type"].as_str().unwrap_or("?");
    let sub = m["subtype"].as_str();
    let mut s = match sub {
        Some(x) => format!("{t}/{x}"),
        None => t.to_string(),
    };
    match t {
        "stream_event" => {
            let e = &m["event"];
            s.push_str(&format!(
                " {}{}",
                e["type"].as_str().unwrap_or("?"),
                e["delta"]["type"]
                    .as_str()
                    .map(|d| format!(":{d}"))
                    .unwrap_or_default()
            ));
            if let Some(txt) = e["delta"]["text"].as_str() {
                s.push_str(&format!(" {:?}", &txt[..txt.len().min(40)]));
            }
        }
        "assistant" => {
            let blocks: Vec<String> = m["message"]["content"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|b| {
                            let bt = b["type"].as_str().unwrap_or("?");
                            match bt {
                                "text" => format!(
                                    "text{:?}",
                                    &b["text"].as_str().unwrap_or("")
                                        [..b["text"].as_str().unwrap_or("").len().min(60)]
                                ),
                                "tool_use" => {
                                    format!("tool_use({})", b["name"].as_str().unwrap_or("?"))
                                }
                                o => o.to_string(),
                            }
                        })
                        .collect()
                })
                .unwrap_or_default();
            s.push_str(&format!(" [{}]", blocks.join(",")));
            if let Some(e) = m["error"].as_str() {
                s.push_str(&format!(" error={e}"));
            }
        }
        "user" => {
            let blocks: Vec<String> = m["message"]["content"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|b| {
                            let bt = b["type"].as_str().unwrap_or("?");
                            if bt == "tool_result" {
                                let c = b["content"].to_string();
                                format!("tool_result(is_error={}) {}", b["is_error"], &c[..c.len().min(120)])
                            } else if bt == "text" {
                                let c = b["text"].as_str().unwrap_or("");
                                format!("text {:?}", &c[..c.len().min(120)])
                            } else {
                                bt.to_string()
                            }
                        })
                        .collect()
                })
                .unwrap_or_default();
            s.push_str(&format!(" [{}]", blocks.join(",")));
        }
        "control_request" => {
            let r = &m["request"];
            s.push_str(&format!(
                "/{} id={} tool={} tool_use_id={} requires_user_interaction={}",
                r["subtype"].as_str().unwrap_or("?"),
                m["request_id"].as_str().unwrap_or("?"),
                r["tool_name"].as_str().unwrap_or("-"),
                r["tool_use_id"].as_str().unwrap_or("-"),
                r["requires_user_interaction"]
            ));
        }
        "control_response" => {
            let r = &m["response"];
            let payload = r["response"].to_string();
            s.push_str(&format!(
                "/{} id={} {}",
                r["subtype"].as_str().unwrap_or("?"),
                r["request_id"].as_str().unwrap_or("?"),
                &payload[..payload.len().min(200)]
            ));
            if let Some(e) = r["error"].as_str() {
                s.push_str(&format!(" error={e}"));
            }
        }
        "result" => {
            s.push_str(&format!(
                " is_error={} cost={} turns={} stop={} result={}",
                m["is_error"],
                m["total_cost_usd"],
                m["num_turns"],
                m["stop_reason"],
                {
                    let r = m["result"].to_string();
                    r[..r.len().min(160)].to_string()
                }
            ));
        }
        "system" if sub == Some("init") => {
            s.push_str(&format!(
                " session={} model={} apiKeySource={} mode={} caps={}",
                m["session_id"].as_str().unwrap_or("?"),
                m["model"].as_str().unwrap_or("?"),
                m["apiKeySource"].as_str().unwrap_or("?"),
                m["permissionMode"].as_str().unwrap_or("?"),
                m["capabilities"]
            ));
        }
        _ => {}
    }
    s
}

/// 프레임 종류별 카운트 요약.
pub fn kinds_summary(frames: &[Value]) -> String {
    let mut m: HashMap<String, usize> = HashMap::new();
    let mut order: Vec<String> = vec![];
    for f in frames {
        let t = f["type"].as_str().unwrap_or("?");
        let mut k = match f["subtype"].as_str() {
            Some(s) => format!("{t}/{s}"),
            None => t.to_string(),
        };
        if t == "stream_event" {
            k.push_str(&format!(":{}", f["event"]["type"].as_str().unwrap_or("?")));
        }
        if !m.contains_key(&k) {
            order.push(k.clone());
        }
        *m.entry(k).or_insert(0) += 1;
    }
    order
        .iter()
        .map(|k| format!("{k}×{}", m[k]))
        .collect::<Vec<_>>()
        .join(", ")
}
