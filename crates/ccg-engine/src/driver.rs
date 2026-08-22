//! CLI 드라이버 — 상주 `claude.exe` 스폰 · JSONL 프레이밍 · 컨트롤 봉투.
//! (`docs/protocol-claude-cli.md` §2 스폰 · §3 프레이밍 · §4 컨트롤)
//!
//! 상태기계는 이 trait만 본다 → 재생 하네스는 `FakeCli`를, 출하는 [`ClaudeDriver`]를 꽂는다.

use crate::clock::Millis;
use crate::identity::{BillingAxis, EffortId, EngineAxis, ModeId, RunIdentity};
use crate::live::LiveItem;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{channel, Receiver, TryRecvError};
use std::sync::{Arc, Mutex};

/// 한 프레임 상한. **누적 중에** 검사한다 — 다 읽은 뒤 버리면 상한이 아니다
/// (`docs/critic/m3-poc.md` §5-3이 PoC `wire.rs`에서 지적한 결함).
pub const MAX_LINE: usize = 64 * 1024 * 1024;
const CHUNK: usize = 16 * 1024;

#[derive(Debug, Clone)]
pub struct SpawnSpec {
    pub cli: PathBuf,
    pub argv: Vec<String>,
    pub cwd: PathBuf,
    /// **대체 의미론**이 아니라 상속 + 덮어쓰기(2.6.2 `engine.ts:894` 파리티).
    pub env_set: Vec<(String, String)>,
    pub env_remove: Vec<String>,
    pub resume: Option<String>,
}

/// 스폰 인자 조립. **정체성만으로 결정된다** — 이 함수가 "스폰 시점에만 정해지는 값"의 정의다.
///
/// 함정(실측): `systemPrompt`는 `initialize`에 **생략**해야 `claude_code` 프리셋이 산다.
/// `undefined`를 넘기면 빈 프롬프트가 주입된다 → [`initialize_request`] 참조.
pub fn build_spawn_spec(
    cli: PathBuf,
    id: &RunIdentity,
    resume: Option<&str>,
    fork: bool,
    config_dir: Option<PathBuf>,
    api_key: Option<&str>,
) -> SpawnSpec {
    let mut argv: Vec<String> = vec![
        "--output-format".into(),
        "stream-json".into(),
        "--verbose".into(),
        "--input-format".into(),
        "stream-json".into(),
    ];

    let (model, effort) = match id.engine() {
        EngineAxis::Claude { model, effort } => (model.clone(), *effort),
        EngineAxis::Codex { model, effort, .. } => (model.clone(), *effort),
    };
    // effortToOptions(engine.ts:223-226): minimal은 thinking off. 단 fable은 **아무것도 안 보낸다**
    // (Fable 5가 명시적 disabled에 400을 낸다).
    match (effort, model.as_str()) {
        (EffortId::Minimal, "fable") => {}
        (EffortId::Minimal, _) => {
            argv.push("--thinking".into());
            argv.push("disabled".into());
        }
        (e, _) => {
            argv.push("--effort".into());
            argv.push(effort_str(e).into());
        }
    }
    argv.push("--model".into());
    argv.push(model);
    argv.push("--permission-prompt-tool".into());
    argv.push("stdio".into());
    argv.push("--setting-sources=user,project,local".into());
    argv.push("--permission-mode".into());
    argv.push(mode_to_permission(id.mode()).into());
    if id.mode() == ModeId::Bypass {
        // 이게 없으면 bypassPermissions 모드는 무력하다(engine.ts:890).
        argv.push("--allow-dangerously-skip-permissions".into());
    }
    argv.push("--include-partial-messages".into());
    for d in id.add_dirs() {
        argv.push("--add-dir".into());
        argv.push(d.as_str().to_string());
    }
    if let Some(r) = resume {
        argv.push(format!("--resume={r}"));
        if fork {
            argv.push("--fork-session".into());
        }
    }

    // --settings 는 맨 뒤. CLI 플래그 계층은 user/project/local 설정을 이긴다.
    let mut settings = json!({
        "permissions": { "defaultMode": mode_to_permission(id.mode()) }
    });
    if let Some(style) = id.to_raw().output_style {
        settings["outputStyle"] = json!(style);
    }
    if !id.tools().skill_overrides.is_empty() {
        let mut m = serde_json::Map::new();
        for k in id.tools().skill_overrides.keys() {
            m.insert(k.clone(), json!("off"));
        }
        settings["skillOverrides"] = Value::Object(m);
    }
    if !id.tools().denied_mcp.is_empty() {
        settings["deniedMcpServers"] = Value::Array(
            id.tools()
                .denied_mcp
                .iter()
                .map(|s| json!({ "serverName": s }))
                .collect(),
        );
    }
    argv.push("--settings".into());
    argv.push(settings.to_string());

    let mut env_set = vec![
        ("CLAUDE_CODE_ENTRYPOINT".to_string(), "sdk-ts".to_string()),
        ("MSBUILDDISABLENODEREUSE".to_string(), "1".to_string()),
    ];
    let mut env_remove = vec!["NODE_OPTIONS".to_string(), "DEBUG".to_string()];
    if let Some(dir) = &config_dir {
        env_set.push((
            "CLAUDE_CONFIG_DIR".to_string(),
            dir.to_string_lossy().to_string(),
        ));
    }
    match id.billing() {
        BillingAxis::ApiKey { .. } => {
            if let Some(k) = api_key {
                env_set.push(("ANTHROPIC_API_KEY".to_string(), k.to_string()));
            }
        }
        BillingAxis::Subscription { drop_env_key, .. } => {
            if *drop_env_key {
                env_remove.push("ANTHROPIC_API_KEY".to_string());
            }
        }
    }

    SpawnSpec {
        cli,
        argv,
        cwd: PathBuf::from(id.cwd().as_str()),
        env_set,
        env_remove,
        resume: resume.map(|s| s.to_string()),
    }
}

pub fn effort_str(e: EffortId) -> &'static str {
    match e {
        EffortId::Minimal => "minimal",
        EffortId::Low => "low",
        EffortId::Medium => "medium",
        EffortId::High => "high",
        EffortId::Xhigh => "xhigh",
        EffortId::Max => "max",
    }
}

/// `engine.ts:228-241` 그대로.
pub fn mode_to_permission(m: ModeId) -> &'static str {
    match m {
        ModeId::Plan => "plan",
        ModeId::AcceptEdits | ModeId::Auto => "acceptEdits",
        ModeId::Bypass => "bypassPermissions",
        ModeId::Normal => "default",
    }
}

/// `initialize` 컨트롤 요청. **`systemPrompt` 키를 아예 넣지 않는다**(§4.2 실측 함정):
/// `undefined`를 실어 보내면 CLI가 빈 프롬프트를 주입해 `claude_code` 프리셋이 죽는다.
/// 채팅별 프롬프트가 있을 때만 `{type:'preset',preset:'claude_code',append}`를 싣는다.
pub fn initialize_request(request_id: &str, append_prompt: Option<&str>) -> Value {
    let mut req = json!({
        "subtype": "initialize",
        "forwardSubagentText": true,
        "supportedDialogKinds": ["refusal_fallback_prompt"],
    });
    if let Some(p) = append_prompt {
        req["systemPrompt"] = json!({ "type": "preset", "preset": "claude_code", "append": p });
    }
    json!({ "type": "control_request", "request_id": request_id, "request": req })
}

pub fn user_message(text: &str) -> Value {
    json!({
        "type": "user",
        "session_id": "",
        "parent_tool_use_id": null,
        "message": { "role": "user", "content": [{ "type": "text", "text": text }] }
    })
}

/// 승인/질문/다이얼로그 응답.
///
/// **`toolUseID`는 항상 넣는다.** 라이브 매칭 키는 `request_id`지만(m3-poc §2.1 실측),
/// 고아·지연 승인 경로가 `toolUseID`를 키로 쓰고 없으면 **조용히 폐기**한다
/// (`claude.exe`: `handleOrphanedPermission: dropping orphaned permission — permissionResult is missing toolUseID`).
pub fn control_response(request_id: &str, tool_use_id: Option<&str>, payload: Value) -> Value {
    let mut resp = payload;
    if let Some(t) = tool_use_id {
        resp["toolUseID"] = json!(t);
    }
    json!({
        "type": "control_response",
        "response": { "subtype": "success", "request_id": request_id, "response": resp }
    })
}

pub fn control_request(request_id: &str, req: Value) -> Value {
    json!({ "type": "control_request", "request_id": request_id, "request": req })
}

// ─────────────────────────────────────────────────────────────────────────────

pub trait CliDriver {
    fn spawn(&mut self, spec: &SpawnSpec) -> std::io::Result<()>;
    fn send(&mut self, line: Value);
    /// stdin EOF = endInput. CLI가 정리 후 스스로 종료한다.
    fn close_input(&mut self);
    fn kill(&mut self);
    /// ⓪ 프로세스 생존. **`Alive` 판정에 쓰면 안 된다** — 타입이 아니라 규약으로 막는 자리라
    /// 호출부(워치독)가 이 값을 `last_evidence`에 반영하지 않는지 불변식 11이 감시한다.
    fn process_alive(&self) -> bool;
    /// 지금까지 도착한 프레임을 가져간다(재생 하네스는 예약된 응답을 여기서 흘린다).
    fn poll_frames(&mut self, now: Millis) -> Vec<Value>;
    /// ④ mtime 프로브 — 그 항목이 파일을 최근에 건드렸나.
    fn mtime_fresh(&self, _item: &LiveItem, _now: Millis) -> bool {
        false
    }
    fn spawn_count(&self) -> usize {
        0
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 실제 드라이버
// ─────────────────────────────────────────────────────────────────────────────

pub struct ClaudeDriver {
    child: Option<Child>,
    stdin: Option<std::process::ChildStdin>,
    rx: Option<Receiver<Value>>,
    stderr_rx: Option<Receiver<String>>,
    job: Option<Arc<crate::job::Job>>,
    /// 진단: 프레이밍 통계(read 경계를 넘은 줄 수 등).
    pub stats: Arc<Mutex<FrameStats>>,
    spawns: usize,
    /// 디버그 덤프 경로(`CCG_ENGINE_LOG`).
    dump: Option<PathBuf>,
}

#[derive(Debug, Default, Clone)]
pub struct FrameStats {
    pub read_calls: usize,
    pub bytes: usize,
    pub frames: usize,
    pub parse_errors: usize,
    pub lines_spanning_reads: usize,
    pub max_line_len: usize,
    pub oversized_dropped: usize,
}

impl ClaudeDriver {
    pub fn new(job: Option<Arc<crate::job::Job>>, dump: Option<PathBuf>) -> ClaudeDriver {
        ClaudeDriver {
            child: None,
            stdin: None,
            rx: None,
            stderr_rx: None,
            job,
            stats: Arc::new(Mutex::new(FrameStats::default())),
            spawns: 0,
            dump,
        }
    }
    pub fn pid(&self) -> Option<u32> {
        self.child.as_ref().map(|c| c.id())
    }
    pub fn drain_stderr(&mut self) -> Vec<String> {
        let mut out = vec![];
        if let Some(rx) = &self.stderr_rx {
            while let Ok(l) = rx.try_recv() {
                out.push(l);
            }
        }
        out
    }
}

impl CliDriver for ClaudeDriver {
    fn spawn(&mut self, spec: &SpawnSpec) -> std::io::Result<()> {
        let mut cmd = Command::new(&spec.cli);
        cmd.args(&spec.argv)
            .current_dir(&spec.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (k, v) in &spec.env_set {
            cmd.env(k, v);
        }
        for k in &spec.env_remove {
            cmd.env_remove(k);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = cmd.spawn()?;

        // ★ job 편입은 spawn 직후, 첫 write 전에.
        #[cfg(windows)]
        if let Some(job) = &self.job {
            use std::os::windows::io::AsRawHandle;
            job.assign_raw(child.as_raw_handle() as *mut std::ffi::c_void)?;
        }

        self.stdin = child.stdin.take();
        let stdout = child.stdout.take().expect("stdout piped");
        let stderr = child.stderr.take().expect("stderr piped");

        let (tx, rx) = channel::<Value>();
        let stats = self.stats.clone();
        let dump = self.dump.clone();
        std::thread::spawn(move || read_frames(stdout, tx, stats, dump, MAX_LINE));

        let (etx, erx) = channel::<String>();
        std::thread::spawn(move || {
            use std::io::BufRead;
            let r = std::io::BufReader::new(stderr);
            for l in r.lines().map_while(Result::ok) {
                let _ = etx.send(l);
            }
        });

        self.child = Some(child);
        self.rx = Some(rx);
        self.stderr_rx = Some(erx);
        self.spawns += 1;
        Ok(())
    }

    fn send(&mut self, line: Value) {
        if let Some(si) = &mut self.stdin {
            let s = line.to_string();
            let _ = si.write_all(s.as_bytes());
            let _ = si.write_all(b"\n");
            let _ = si.flush();
        }
    }

    fn close_input(&mut self) {
        self.stdin.take(); // drop = EOF
    }

    fn kill(&mut self) {
        if let Some(c) = &mut self.child {
            let _ = c.kill();
        }
    }

    fn process_alive(&self) -> bool {
        // `try_wait`는 &mut가 필요해 여기선 stdin/child 존재로만 근사한다.
        // 정확한 종료 관측은 stdout EOF(리더 스레드 종료)가 준다 — 그게 T22의 트리거다.
        self.child.is_some()
    }

    fn poll_frames(&mut self, _now: Millis) -> Vec<Value> {
        let mut out = vec![];
        if let Some(rx) = &self.rx {
            loop {
                match rx.try_recv() {
                    Ok(v) => out.push(v),
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        // stdout EOF — 스트림 급사/정상 종료. 상위(T22)가 처리한다.
                        break;
                    }
                }
            }
        }
        out
    }

    fn spawn_count(&self) -> usize {
        self.spawns
    }
}

/// 바이트 루프. **`lines()`로 읽지 않는다** — `initialize` 응답이 13.5KB라 read 경계를 넘고,
/// 줄 조립을 프레임워크에 맡기면 부분 라인이 조용히 유실되거나 파싱 에러로 죽는다.
fn read_frames<R: std::io::Read>(
    mut stdout: R,
    tx: std::sync::mpsc::Sender<Value>,
    stats: Arc<Mutex<FrameStats>>,
    dump: Option<PathBuf>,
    max_line: usize,
) {
    let mut buf: Vec<u8> = Vec::with_capacity(1 << 16);
    let mut chunk = vec![0u8; CHUNK];
    // 상한을 넘긴 줄은 "개행까지 폐기" 상태로 전이한다(누적 중 검사 — 크리틱 §5-3).
    let mut discarding = false;
    let mut logf = dump.and_then(|p| {
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(p)
            .ok()
    });
    let mut pending: VecDeque<()> = VecDeque::new();
    loop {
        let n = match stdout.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        {
            let mut s = stats.lock().unwrap();
            s.read_calls += 1;
            s.bytes += n;
        }
        let carry = buf.len();
        let mut first_line = true;
        let mut start = 0usize;
        let data = &chunk[..n];
        if discarding {
            // 개행을 찾을 때까지 통째로 버린다.
            match data.iter().position(|&b| b == b'\n') {
                Some(p) => {
                    discarding = false;
                    start = p + 1;
                }
                None => continue,
            }
        }
        buf.extend_from_slice(&data[start..]);
        if buf.len() > max_line && !buf.contains(&b'\n') {
            stats.lock().unwrap().oversized_dropped += 1;
            buf.clear();
            discarding = true;
            continue;
        }
        let mut cut = 0usize;
        while let Some(pos) = buf[cut..].iter().position(|&b| b == b'\n') {
            let end = cut + pos;
            let line = &buf[cut..end];
            cut = end + 1;
            {
                let mut s = stats.lock().unwrap();
                s.max_line_len = s.max_line_len.max(line.len());
                if first_line && carry > 0 {
                    s.lines_spanning_reads += 1;
                }
            }
            first_line = false;
            let txt = String::from_utf8_lossy(line);
            let txt = txt.trim_end_matches('\r');
            if txt.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<Value>(txt) {
                Ok(v) => {
                    stats.lock().unwrap().frames += 1;
                    if let Some(f) = &mut logf {
                        let _ = writeln!(f, "{txt}");
                    }
                    if tx.send(v).is_err() {
                        return;
                    }
                }
                Err(_) => {
                    // 파싱 실패 줄은 버리고 계속 — 절대 죽지 않는다(§3.1).
                    stats.lock().unwrap().parse_errors += 1;
                }
            }
        }
        buf.drain(..cut);
        pending.clear();
    }
    // EOF에 개행 없는 꼬리
    if !buf.is_empty() {
        if let Ok(v) = serde_json::from_slice::<Value>(&buf) {
            let _ = tx.send(v);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::*;
    use std::collections::BTreeSet;
    use std::io::Read;

    /// read()가 **작게 쪼개져 들어오는** 스트림. `initialize` 13.5KB가 경계를 넘는 상황의 축소판.
    struct Trickle {
        data: Vec<u8>,
        pos: usize,
        step: usize,
    }
    impl Read for Trickle {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            if self.pos >= self.data.len() {
                return Ok(0);
            }
            let n = self.step.min(out.len()).min(self.data.len() - self.pos);
            out[..n].copy_from_slice(&self.data[self.pos..self.pos + n]);
            self.pos += n;
            Ok(n)
        }
    }

    fn run(data: String, step: usize, max_line: usize) -> (Vec<Value>, FrameStats) {
        let (tx, rx) = channel::<Value>();
        let stats = Arc::new(Mutex::new(FrameStats::default()));
        read_frames(
            Trickle {
                data: data.into_bytes(),
                pos: 0,
                step,
            },
            tx,
            stats.clone(),
            None,
            max_line,
        );
        let mut out = vec![];
        while let Ok(v) = rx.try_recv() {
            out.push(v);
        }
        let s = stats.lock().unwrap().clone();
        (out, s)
    }

    #[test]
    fn frames_survive_read_boundaries() {
        let big = "x".repeat(20_000);
        let data = format!(
            "{}\n{}\n{}\n",
            json!({"type":"system","subtype":"init","session_id":"S"}),
            json!({"type":"assistant","message":{"content":[{"type":"text","text":big}]}}),
            json!({"type":"result","subtype":"success"})
        );
        // 7바이트씩 흘려도 3프레임이 온전히 나와야 한다.
        let (frames, stats) = run(data, 7, MAX_LINE);
        assert_eq!(frames.len(), 3);
        assert_eq!(frames[2]["type"], "result");
        assert!(stats.lines_spanning_reads > 0, "경계를 넘은 줄이 실제로 있었다");
        assert_eq!(stats.parse_errors, 0);
    }

    #[test]
    fn oversized_line_is_dropped_during_accumulation() {
        // 상한을 넘긴 줄은 **누적 중에** 버리고 개행까지 폐기한다. 그 다음 줄은 정상 파싱된다.
        let huge = "y".repeat(4096);
        let data = format!(
            "{}\n{}\n",
            json!({ "type": "assistant", "message": { "content": huge } }),
            json!({"type":"result","subtype":"success"})
        );
        let (frames, stats) = run(data, 512, 1024);
        assert_eq!(stats.oversized_dropped, 1, "상한 초과 1줄 폐기");
        assert_eq!(frames.len(), 1, "뒤 프레임은 살아 있다");
        assert_eq!(frames[0]["type"], "result");
    }

    #[test]
    fn non_json_line_does_not_kill_the_reader() {
        let data = format!(
            "this is not json\n\n{}\n",
            json!({"type":"result","subtype":"success"})
        );
        let (frames, stats) = run(data, 3, MAX_LINE);
        assert_eq!(stats.parse_errors, 1);
        assert_eq!(frames.len(), 1);
    }

    fn ident(model: &str, mode: ModeId) -> RunIdentity {
        let mut raw = RawIdentity {
            engine: RawEngine {
                kind: EngineKind::Claude,
                model: model.into(),
                effort: EffortId::Minimal,
                codex_account: None,
            },
            billing: RawBilling {
                kind: BillingKind::Subscription,
                account: Some("a@x".into()),
                drop_env_key: Some(true),
            },
            cwd: r"C:\ccg-fixture\work".into(),
            add_dirs: vec![],
            mode,
            system_prompt: None,
            output_style: None,
            tools: RawTools::default(),
        };
        raw.add_dirs = vec![r"C:\ccg-fixture\ref".into()];
        RunIdentity::normalize(
            raw,
            &IdentityDefaults {
                known_accounts: BTreeSet::from(["a@x".to_string()]),
                // 전역 ANTHROPIC_API_KEY가 **있는** 상황 — 없으면 drop_env_key는 false로 고정된다(§2.3).
                env_api_key_present: true,
                ..Default::default()
            },
        )
        .unwrap()
    }

    #[test]
    fn argv_matches_protocol_2_1() {
        let spec = build_spawn_spec(
            PathBuf::from("claude.exe"),
            &ident("haiku", ModeId::Normal),
            None,
            false,
            Some(PathBuf::from(r"C:\home\accounts\a_x")),
            None,
        );
        let a = spec.argv.join(" ");
        assert!(a.contains("--output-format stream-json"));
        assert!(a.contains("--input-format stream-json"));
        assert!(a.contains("--thinking disabled"), "minimal + 비-fable");
        assert!(a.contains("--model haiku"));
        assert!(a.contains("--permission-prompt-tool stdio"));
        assert!(a.contains("--setting-sources=user,project,local"));
        assert!(a.contains("--permission-mode default"));
        assert!(a.contains("--include-partial-messages"));
        assert!(a.contains("--add-dir"));
        assert_eq!(spec.argv[spec.argv.len() - 2], "--settings", "맨 뒤가 --settings");
        // drop_env_key=true → 전역 키를 제거한다(P1e).
        assert!(spec.env_remove.contains(&"ANTHROPIC_API_KEY".to_string()));
        assert!(spec.env_remove.contains(&"NODE_OPTIONS".to_string()));
        assert!(spec
            .env_set
            .iter()
            .any(|(k, v)| k == "CLAUDE_CONFIG_DIR" && v.ends_with("a_x")));
    }

    #[test]
    fn fable_minimal_sends_nothing_for_thinking() {
        // Fable 5는 명시적 `thinking: disabled`에 400을 낸다 → 아무것도 안 보낸다.
        let spec = build_spawn_spec(
            PathBuf::from("claude.exe"),
            &ident("fable", ModeId::Bypass),
            Some("sess-1"),
            true,
            None,
            None,
        );
        let a = spec.argv.join(" ");
        assert!(!a.contains("--thinking"));
        assert!(!a.contains("--effort"));
        assert!(a.contains("--permission-mode bypassPermissions"));
        assert!(
            a.contains("--allow-dangerously-skip-permissions"),
            "이게 없으면 bypass 모드는 무력하다"
        );
        assert!(a.contains("--resume=sess-1"));
        assert!(a.contains("--fork-session"));
    }

    #[test]
    fn initialize_omits_system_prompt_by_default() {
        // ★ 실측 함정: 키를 넣으면(undefined여도) claude_code 프리셋이 죽는다.
        let v = initialize_request("init-1", None);
        assert!(v["request"].get("systemPrompt").is_none());
        assert_eq!(v["request"]["forwardSubagentText"], true);
        let v2 = initialize_request("init-1", Some("추가 지시"));
        assert_eq!(v2["request"]["systemPrompt"]["preset"], "claude_code");
    }

    #[test]
    fn control_response_always_carries_tool_use_id() {
        let v = control_response("req-1", Some("toolu_9"), json!({"behavior":"allow"}));
        assert_eq!(v["response"]["response"]["toolUseID"], "toolu_9");
        assert_eq!(v["response"]["request_id"], "req-1");
    }
}
