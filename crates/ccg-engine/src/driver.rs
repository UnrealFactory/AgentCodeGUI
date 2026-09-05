//! CLI 드라이버 — 상주 `claude.exe` 스폰 · JSONL 프레이밍 · 컨트롤 봉투.
//! (`docs/protocol-claude-cli.md` §2 스폰 · §3 프레이밍 · §4 컨트롤)
//!
//! 상태기계는 이 trait만 본다 → 재생 하네스는 `FakeCli`를, 출하는 [`ClaudeDriver`]를 꽂는다.

use crate::clock::Millis;
use crate::identity::{BillingAxis, EffortId, EngineAxis, ModeId, RunIdentity};
use crate::live::{CloseCause, LiveItem};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{channel, Receiver, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// stdout EOF를 봤는데 아직 종료 코드가 관측되지 않았을 때 기다리는 상한.
/// 넘으면 `Crash`로 본다 — **EOF 자체가 이미 스트림의 죽음**이라 무한정 기다리면
/// T22가 다시 유령이 된다(크리틱 배선 R1 §2-E/F).
const EXIT_CODE_GRACE: Duration = Duration::from_millis(700);
/// ★3.0.5 — stdin EOF 뒤 CLI가 **스스로** 나가길 기다리는 유예(그 안에 마지막 어시스턴트
/// 메시지·`last-prompt`가 세션 파일에 내려앉는다 — 실측 +0.5s). 넘기면 kill.
const EXIT_GRACE: Duration = Duration::from_secs(8);
/// ★3.0.5 — 새 스폰 전에 **앞 프로세스의 퇴장**을 기다리는 상한. 같은 세션 파일을 두
/// 프로세스가 동시에 쓰지 않게 한다(앞 것의 늦은 쓰기가 새 프로세스의 resume 읽기 뒤에
/// 오면 그 답이 새 턴에 안 보인다). 넘기면 그냥 띄운다 — 리퍼가 앞 것을 책임진다.
const SPAWN_WAIT_PRIOR: Duration = Duration::from_millis(2500);

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
    /// **Codex 실행 계획**(M4). `Some`이면 이 스폰은 `codex app-server`다 —
    /// argv에 담을 수 없는 값(승인 정책·샌드박스·thread config·developerInstructions)이
    /// 있어서 구조체로 싣는다. Claude 경로에서는 항상 `None`이고, 이 필드가 붙기 전과
    /// 바이트 하나 다르지 않다.
    pub codex: Option<crate::codex::CodexPlan>,
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
    // ★M4 — Codex는 **같은 상태기계 위의 다른 프로세스**다. argv 문법이 겹치는 부분이
    // 하나도 없으므로(플래그가 아니라 JSON-RPC로 설정한다) 여기서 갈라 나간다.
    // Claude 경로는 이 줄 아래로 한 글자도 안 바뀐다.
    if matches!(id.engine(), EngineAxis::Codex { .. }) {
        return build_codex_spawn_spec(id, resume);
    }
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
        codex: None,
    }
}

/// Codex 스폰 인자. **바이너리 경로는 여기서 정하지 않는다** — 엔진마다 실행본이 다르고
/// (`codex-engines/<v>/…/codex.cmd`), 그 경로를 아는 것은 앱 홈을 읽는 셸이다.
/// `CodexDriver`가 자기 것을 쓰고 `cli`는 무시한다(같은 이유로 `argv`도 표시용이다).
fn build_codex_spawn_spec(id: &RunIdentity, resume: Option<&str>) -> SpawnSpec {
    SpawnSpec {
        cli: PathBuf::from("codex"),
        argv: vec!["app-server".into()],
        cwd: PathBuf::from(id.cwd().as_str()),
        // MSBuild 좀비 차단은 엔진과 무관한 앱 규약이라 여기도 그대로 간다.
        env_set: vec![("MSBUILDDISABLENODEREUSE".to_string(), "1".to_string())],
        env_remove: vec!["NODE_OPTIONS".to_string(), "DEBUG".to_string()],
        resume: resume.map(|s| s.to_string()),
        codex: Some(crate::codex::build_plan(id, resume)),
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
    /// ★3.0.5 — **정리 종료**: stdin EOF를 준 뒤 CLI가 스스로 나갈 유예를 주고, 넘기면 kill.
    /// 기본은 `kill()`과 같다(재생·Codex 드라이버는 유예를 모른다). `ClaudeDriver`가 덮어쓴다.
    fn kill_graceful(&mut self) {
        self.kill()
    }
    /// ⓪ 프로세스 생존. **`Alive` 판정에 쓰면 안 된다** — 타입이 아니라 규약으로 막는 자리라
    /// 호출부(워치독)가 이 값을 `last_evidence`에 반영하지 않는지 불변식 11이 감시한다.
    /// `false`는 **Dead 관측**이므로 T22 백스톱이 그것만 읽는다(§5.4-b ⓪).
    fn process_alive(&self) -> bool;
    /// **T22의 진입점** — stdout EOF(리더 스레드 종료) = 스트림의 죽음을 *값으로* 올린다.
    ///
    /// 이게 없던 동안 `poll_frames`가 `Disconnected`를 `break`로 삼켰고, 상위에 신호가
    /// 없어 `ChatRuntime::stream_died()`의 호출자가 **재생 테스트뿐**이었다 — 외부에서
    /// CLI가 죽으면 채팅이 영구히 굳었다(크리틱 배선 R1 §2-E/F, m-logic P8).
    ///
    /// 기본값 `None`: 재생 드라이버는 EOF를 모른다(폴트는 `stream_died()` 직접 호출로 준다).
    fn stream_eof(&mut self) -> Option<CloseCause> {
        None
    }
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
    /// stdout EOF를 **처음** 본 시각. `spawn`마다 리셋된다(드라이버는 스트림보다 오래 산다).
    eof_at: Option<Instant>,
    /// 관측된 종료 코드(있으면). `try_wait`은 한 번만 값을 주므로 기억해 둔다.
    exit_code: Option<Option<i32>>,
    /// ★3.0.5 — 정리 종료 중인 **앞 프로세스**의 리퍼 스레드(`kill_graceful`). 다음 `spawn`이
    /// 상한 안에서 그 퇴장을 기다린다.
    reaper: Option<std::thread::JoinHandle<()>>,
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
            eof_at: None,
            exit_code: None,
            reaper: None,
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
        // ★3.0.5 — 앞 프로세스가 정리 종료 중이면 잠깐 기다린다(같은 세션 파일의 쓰기 순서).
        if let Some(h) = self.reaper.take() {
            let t0 = Instant::now();
            while !h.is_finished() && t0.elapsed() < SPAWN_WAIT_PRIOR {
                std::thread::sleep(Duration::from_millis(20));
            }
            if h.is_finished() {
                let _ = h.join();
            }
            // 못 끝냈으면 놓아준다 — 리퍼가 유예 만기에 죽인다.
        }
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
        // 새 스트림 = 새 생사. 앞 스트림의 EOF 표식이 남아 있으면 방금 뜬 CLI를
        // T22로 즉사시킨다.
        self.eof_at = None;
        self.exit_code = None;
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

    /// ★3.0.5 — EOF를 주고 자식을 리퍼 스레드로 넘긴다: `EXIT_GRACE` 안에 스스로 나가면
    /// 그대로, 아니면 kill. 허브 스레드는 기다리지 않는다(`spawn`만 상한 안에서 기다린다).
    fn kill_graceful(&mut self) {
        // stdin이 열려 있으면 CLI는 상주한다(§0) — EOF가 먼저다.
        self.stdin.take();
        let Some(mut child) = self.child.take() else { return };
        // 앞 리퍼가 남아 있어도 잊는다 — 그 스레드는 제 자식을 끝까지 책임진다.
        let _ = self.reaper.take();
        self.reaper = Some(std::thread::spawn(move || {
            let t0 = Instant::now();
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => return,
                    Ok(None) => {}
                    Err(_) => break,
                }
                if t0.elapsed() >= EXIT_GRACE {
                    break;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            let _ = child.kill();
            let _ = child.wait();
        }));
    }

    fn process_alive(&self) -> bool {
        // `try_wait`는 &mut가 필요해 여기선 **관측된 사실만** 본다:
        //  · 자식이 없다 = 스폰 전/후 → 살아 있다고 말할 근거가 없다
        //  · stdout EOF를 봤다 = 리더 스레드가 끝났다 = **Dead 관측**(T22의 근거와 같다)
        // 그 밖에는 `true`지만, 이 값이 `Alive` 증거로 쓰이면 불변식 11이 잡는다(§5.4-b ⓪).
        self.child.is_some() && self.eof_at.is_none()
    }

    fn stream_eof(&mut self) -> Option<CloseCause> {
        let at = self.eof_at?;
        // 종료 코드로 **정상 종료(0)**와 외부 살해/크래시를 가른다. `try_wait`는 값을
        // 한 번만 주므로 기억해 두고, 아직 회수되지 않았으면 짧게만 기다린다.
        if self.exit_code.is_none() {
            if let Some(c) = &mut self.child {
                if let Ok(Some(st)) = c.try_wait() {
                    self.exit_code = Some(st.code());
                }
            }
        }
        match self.exit_code {
            Some(Some(0)) => Some(CloseCause::CliExit),
            Some(_) => Some(CloseCause::ExternalKill),
            // stdout은 닫혔는데 종료가 아직 안 보인다 — 유예 안에서는 다음 틱을 기다린다.
            None if at.elapsed() < EXIT_CODE_GRACE => None,
            None => Some(CloseCause::Crash),
        }
    }

    fn poll_frames(&mut self, _now: Millis) -> Vec<Value> {
        let mut out = vec![];
        if let Some(rx) = &self.rx {
            loop {
                match rx.try_recv() {
                    Ok(v) => out.push(v),
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        // stdout EOF — 스트림 급사/정상 종료. **삼키지 않는다**:
                        // 표식을 남기고 `stream_eof()`가 상위(T22)에 값으로 올린다.
                        if self.eof_at.is_none() {
                            self.eof_at = Some(Instant::now());
                        }
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
///
/// (M4) `codex app-server`의 JSONL도 **정확히 같은 문제**를 갖는다(`initialize` 응답이
/// 크고 `item/completed`의 diff가 더 크다) — 그래서 Codex 드라이버가 이 루프를 그대로
/// 재사용한다. 프레이밍 버그를 두 벌 만들지 않는 것이 이 `pub(crate)`의 이유다.
pub(crate) fn read_frames<R: std::io::Read>(
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
                codex_tier: None,
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

    /// **T22의 1차 신호를 실 프로세스로** 잰다 — `read_frames` 스레드가 끝나면
    /// `poll_frames`가 `Disconnected`를 보고, `stream_eof()`가 그것을 값으로 올린다.
    /// 종료 코드로 정상 종료(0)와 비정상(≠0)을 가르는 것까지 여기서 확인한다.
    #[cfg(windows)]
    fn eof_cause_of(exit_code: i32) -> Option<CloseCause> {
        let mut d = ClaudeDriver::new(None, None);
        let spec = SpawnSpec {
            cli: PathBuf::from("cmd.exe"),
            argv: vec!["/c".into(), format!("exit {exit_code}")],
            cwd: std::env::temp_dir(),
            env_set: vec![],
            env_remove: vec![],
            resume: None,
            codex: None,
        };
        d.spawn(&spec).expect("cmd.exe 스폰");
        assert!(d.process_alive(), "EOF 전에는 Dead라고 말하지 않는다");
        // 리더 스레드가 EOF를 볼 때까지(+ 종료 코드가 회수될 때까지) 짧게 돈다.
        for _ in 0..200 {
            let _ = d.poll_frames(0);
            if let Some(c) = d.stream_eof() {
                assert!(!d.process_alive(), "EOF = Dead 관측(⓪ 백스톱의 유일한 근거)");
                return Some(c);
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        None
    }

    #[cfg(windows)]
    #[test]
    fn stdout_eof_becomes_a_close_cause() {
        assert_eq!(eof_cause_of(0), Some(CloseCause::CliExit), "정상 종료");
        assert_eq!(
            eof_cause_of(1),
            Some(CloseCause::ExternalKill),
            "비정상 종료(taskkill /F의 코드가 1이다)"
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_fresh_spawn_clears_the_eof_latch() {
        // 드라이버는 스트림보다 오래 산다 — 앞 스트림의 EOF가 남아 있으면 방금 뜬
        // CLI를 T22로 즉사시킨다(재스폰이 조용히 죽는 회귀).
        let mut d = ClaudeDriver::new(None, None);
        let spec = |c: &str| SpawnSpec {
            cli: PathBuf::from("cmd.exe"),
            argv: vec!["/c".into(), c.into()],
            cwd: std::env::temp_dir(),
            env_set: vec![],
            env_remove: vec![],
            resume: None,
            codex: None,
        };
        d.spawn(&spec("exit 0")).unwrap();
        for _ in 0..200 {
            let _ = d.poll_frames(0);
            if d.stream_eof().is_some() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(d.stream_eof().is_some(), "첫 스트림은 EOF를 봤다");
        d.spawn(&spec("timeout /t 5 /nobreak")).unwrap();
        assert_eq!(d.stream_eof(), None, "새 스폰이 EOF 표식을 지웠다");
        assert!(d.process_alive());
        d.kill();
    }

    #[test]
    fn control_response_always_carries_tool_use_id() {
        let v = control_response("req-1", Some("toolu_9"), json!({"behavior":"allow"}));
        assert_eq!(v["response"]["response"]["toolUseID"], "toolu_9");
        assert_eq!(v["response"]["request_id"], "req-1");
    }
}
