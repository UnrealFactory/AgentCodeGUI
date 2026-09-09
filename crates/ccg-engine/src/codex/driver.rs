//! `CodexDriver` — `codex app-server` 프로세스 + JSONL(JSON-RPC) 파이프.
//!
//! [`crate::driver::CliDriver`]를 구현하므로 상태기계는 이것이 Claude인지 Codex인지
//! **모른다**. 프레임 옮김은 전부 [`super::transcode::Transcoder`](순수)가 하고, 여기는
//! 프로세스·스레드·파일 같은 더러운 것만 맡는다:
//!
//! | 여기 | 옮김기 |
//! |---|---|
//! | 스폰 · CODEX_HOME · job object · CREATE_NO_WINDOW | — |
//! | stdout 바이트 루프(줄 조립) · stderr · EOF 래치 | — |
//! | 백그라운드 테일 파일 쓰기 | 무엇을 쓸지 결정 |
//! | — | JSON-RPC ↔ Claude 프레임 |

use super::transcode::{Egress, Transcoder};
use super::CodexPlan;
use crate::clock::Millis;
use crate::driver::{read_frames, CliDriver, FrameStats, SpawnSpec, MAX_LINE};
use crate::live::CloseCause;
use serde_json::Value;
use std::collections::VecDeque;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{channel, Receiver, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// `ClaudeDriver`와 같은 값 — stdout EOF 뒤 종료 코드를 기다리는 상한.
const EXIT_CODE_GRACE: Duration = Duration::from_millis(700);

/// 계정 → 격리 `CODEX_HOME`. **셸이 꽂는다**(계정 스토어는 `ccg-auth` 소관이고 엔진
/// 크레이트는 그것을 모른다). 꽂지 않으면 `CODEX_HOME`을 **설정하지 않는다** —
/// 그때 codex는 사용자 실홈(`~/.codex`)을 쓴다. 앱은 실홈을 건드리지 않는 것이 규약이라
/// 셸은 항상 이 훅을 꽂아야 한다(`engine/any.rs`).
pub type HomeResolver = Arc<dyn Fn(&CodexPlan) -> Option<PathBuf> + Send + Sync>;
pub type ContextResolver = Arc<dyn Fn(&CodexPlan) -> std::io::Result<super::ContextOverrides> + Send + Sync>;

pub struct CodexDriver {
    observer: Option<crate::driver::ProtocolObserver>,
    observed_errors: (usize,usize),
    /// **앱이 관리하는 codex 실행본**(없으면 전역 `codex`). `SpawnSpec.cli`는 Claude용
    /// 경로라 쓰지 않는다 — 엔진마다 바이너리가 다르다는 사실을 여기서 흡수한다.
    bin: PathBuf,
    child: Option<Child>,
    stdin: Option<std::process::ChildStdin>,
    rx: Option<Receiver<Value>>,
    stderr_rx: Option<Receiver<String>>,
    job: Option<Arc<crate::job::Job>>,
    dump: Option<PathBuf>,
    pub stats: Arc<Mutex<FrameStats>>,
    spawns: usize,
    eof_at: Option<Instant>,
    exit_code: Option<Option<i32>>,
    tx: Transcoder,
    /// 상태기계에게 넘길 프레임 대기열(한 RPC가 프레임 여럿을 낳는다).
    out: VecDeque<Value>,
    home: Option<HomeResolver>,
    context: Option<ContextResolver>,
    /// 마지막 스폰이 쓴 `CODEX_HOME`(진단 — `engine:debug`가 읽는다).
    pub last_home: Option<PathBuf>,
}

impl CodexDriver {
    pub fn new(bin: PathBuf, job: Option<Arc<crate::job::Job>>, dump: Option<PathBuf>) -> CodexDriver {
        CodexDriver {
            observer: None,
            observed_errors: (0,0),
            bin,
            child: None,
            stdin: None,
            rx: None,
            stderr_rx: None,
            job,
            dump,
            stats: Arc::new(Mutex::new(FrameStats::default())),
            spawns: 0,
            eof_at: None,
            exit_code: None,
            tx: Transcoder::new(CodexPlan::default()),
            out: VecDeque::new(),
            home: None,
            context: None,
            last_home: None,
        }
    }

    /// 계정별 격리 `CODEX_HOME` 훅. 셸이 꽂는다([`HomeResolver`] 참고).
    pub fn with_home_resolver(mut self, r: HomeResolver) -> Self {
        self.home = Some(r);
        self
    }
    pub fn with_observer(mut self, observer: crate::driver::ProtocolObserver) -> Self {
        self.observer = Some(observer);
        self
    }

    /// Read saved settings at each process start, including thread resume.
    pub fn with_context_resolver(mut self, r: ContextResolver) -> Self {
        self.context = Some(r);
        self
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

    pub fn thread_id(&self) -> Option<&str> {
        self.tx.thread_id()
    }

    /// 옮김기의 산출을 실행한다 — 프레임은 큐로, RPC는 stdin으로, 테일은 파일로.
    fn drive(&mut self, egress: Vec<Egress>) {
        for e in egress {
            match e {
                Egress::Frame(f) => self.out.push_back(f),
                Egress::Rpc(v) => self.write_line(&v),
                Egress::Tail { file, text } => append_tail(&file, &text),
            }
        }
    }

    fn write_line(&mut self, v: &Value) {
        if let Some(observer) = &self.observer { observer("protocol-out", v); }
        if let Some(si) = &mut self.stdin {
            let _ = si.write_all(v.to_string().as_bytes());
            let _ = si.write_all(b"\n");
            let _ = si.flush();
        }
    }
}

/// 실행 준비된 `Command`.
///
/// 1순위는 **네이티브 실행본 직접 스폰**이다(`versions::codex_bin`이 그걸 찾아 준다).
/// `cmd /C`를 경유하는 것은 **커널이 직접 못 띄우는 확장자**로 떨어졌을 때뿐이다
/// (`.cmd` shim 등 — [`needs_shell`]).
///
/// ★ 그 경로의 인용은 **`raw_arg`로 직접 쓴다.** `arg()`는 MSVC 규칙으로 `\"`를 넣는데
/// `cmd.exe`는 백슬래시 이스케이프를 모른다 — 그래서 경로가 통째로 깨진다(이 라운드에
/// `poc-codex --only=handshake`가 실측으로 잡았다). 올바른 모양은 바깥 따옴표 한 겹이다:
/// `cmd /C ""C:\a b\codex.cmd" app-server"`.
/// `pub`인 이유: 셸의 `codex:models`(파리티 R1 H4)가 턴을 만들지 않고 app-server에
/// 두 줄만 묻는데, 그 스폰도 **이 인용 규칙을 그대로 타야** 한다. 규칙을 복사하면
/// 위 실측(공백 있는 경로가 통째로 깨지는 사고)이 한쪽에서만 고쳐진 채로 남는다.
///
/// ## ★R28d EXTN R2 — **맨 이름의 해석을 셸에 맡기지 않는다**
///
/// R1까지 맨 이름 `codex`는 그대로 `cmd /C ""codex" app-server"`로 나갔다. 그런데
/// **`cmd.exe`는 `PATH`보다 현재 폴더를 먼저 뒤지고**, 이 명령의 현재 폴더는
/// `CodexDriver::spawn`이 꽂는 `spec.cwd` — **사용자가 연 프로젝트 폴더**다. 그래서
/// 게이트([`super::versions::resolve_bin`] = 실행 파일 폴더 + `PATH`)가 「창구 없음」이라
/// 답한 판에서도 턴은 **그 폴더의 `codex.exe`로 떴다**. EXTN 확인 크리틱 R2 §5의 실측:
///
/// ```text
/// parentCwd = C:\Temp          childCwd = C:\Temp\ccg-x2r2-projtest
/// resolve_bin("codex") = null          ← 게이트: "물어볼 창구가 없다" → 한도 Unknown = 눈감고 발사
/// cmd /C ""codex" app-server" → 뜬 파일 = C:\Temp\ccg-x2r2-projtest\codex.exe   ← 스폰
/// ```
///
/// 그래서 맨 이름은 **여기서 게이트와 같은 함수로 해석해** 넘긴다:
///
/// | 해석 | 넘기는 값 | 셸이 다시 훑는가 |
/// |---|---|---|
/// | 찾았다 | 그 **절대 경로** | 아니오(`cmd`로 가도 경로가 박혀 있다) |
/// | 못 찾았다 | `Command::new(맨 이름)` | 아니오 — Rust의 `Command`는 **CWD를 안 본다** |
///
/// 못 찾은 값을 `cmd`에 안 넘기는 것이 이 수정의 전부다. 그 판의 스폰은 그 자리에서
/// 실패하고(`runtime.rs`가 그 오류를 삼키지 않는다 — ★R4 §R3.8-M), 「없다」가 게이트와
/// **한 벌**이 된다. 반대 선택지(게이트가 `CWD`를 보게 하기)를 안 고른 이유는
/// `super::versions::search_dirs`에 적었다 — 요약하면 **남의 저장소를 열기만 해도 그 안의
/// `codex.exe`가 엔진으로 뜨는 것**을 사실로 인정하고 싶지 않아서다.
///
/// 남는 오차는 `Command`가 `system32`·`windows`를 더 본다는 것 하나인데 둘 다 사실상 언제나
/// `PATH`에 있다(크리틱이 이 컴퓨터에서 다시 셌다).
pub fn command_for(bin: &PathBuf) -> Command {
    // ★R28c CPATH — 맨 이름 판정은 `versions::is_bare_name` **한 벌**이다. 여기 사본을
    // 두면 "PATH에서 찾아 띄운다"와 "PATH에서 찾을 수 있나"가 서로 다른 규칙이 된다.
    // ★R28d EXTN R2 — 이제 **해석까지** 한 벌이다(위 표).
    let resolved: PathBuf = if cfg!(windows) && super::versions::is_bare_name(bin) {
        match super::versions::resolve_bin(bin) {
            Some(p) => p,
            // 게이트가 「없다」고 답한 이름 — 셸에 넘기면 셸이 **현재 폴더**를 뒤진다.
            None => return Command::new(bin),
        }
    } else {
        bin.clone()
    };
    let s = resolved.to_string_lossy().to_string();
    if !needs_shell(&resolved) {
        let mut c = Command::new(&resolved);
        c.arg("app-server");
        return c;
    }
    let mut c = Command::new("cmd");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.raw_arg("/C");
        c.raw_arg(format!("\"\"{s}\" app-server\""));
    }
    #[cfg(not(windows))]
    {
        c.arg("/C").arg(format!("\"{s}\" app-server"));
    }
    c
}

/// `cmd /C`를 경유해야 하는 값인가 = **커널이 직접 못 띄우는 확장자**인가(Windows만).
///
/// R1까지 이 판정은 `.cmd` · `.bat` · **맨 이름** 셋이었다. 맨 이름은 [`command_for`]가 먼저
/// 해석해서 사라졌고(위 표), 남은 둘 대신 **`.exe`·`.com`이 아닌 확장자 전부**를 셸로 보낸다.
/// 게이트 쪽 후보는 `PATHEXT` **전부**(`versions::path_exts`)라 여기만 둘이면 「띄울 수 있다」고
/// 답한 값을 직접 스폰해 실패하는 판이 남는다(`codex.vbs`·`codex.js` — 보고서 §7.3의 비대칭).
/// 확장자가 **없는** 값은 그대로 커널에 준다(그쪽은 `CreateProcess`가 `.exe`를 붙여 본다).
fn needs_shell(bin: &Path) -> bool {
    if !cfg!(windows) {
        return false;
    }
    match bin.extension().and_then(|e| e.to_str()) {
        None => false,
        Some(e) => !matches!(e.to_ascii_lowercase().as_str(), "exe" | "com"),
    }
}

fn append_tail(file: &str, text: &str) {
    if text.is_empty() {
        return;
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(file) {
        let _ = f.write_all(text.as_bytes());
    }
}

impl CliDriver for CodexDriver {
    fn spawn(&mut self, spec: &SpawnSpec) -> std::io::Result<()> {
        let mut plan = spec.codex.clone().unwrap_or_default();
        if let Some(resolve) = &self.context {
            plan.context = resolve(&plan)?;
        }
        // 계정 격리 홈은 **스폰 인자가 아니라 계정 스토어의 산물**이라 여기서 묻는다.
        self.last_home = self.home.as_ref().and_then(|r| r(&plan));
        self.tx = Transcoder::new(plan);
        self.out.clear();

        let mut cmd = command_for(&self.bin);
        if let Some(h) = &self.last_home {
            cmd.env("CODEX_HOME", h);
        }
        cmd.current_dir(&spec.cwd)
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

        // job 편입은 spawn 직후, 첫 write 전에(앱이 죽으면 커널이 손자까지 거둔다).
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
        self.eof_at = None;
        self.exit_code = None;
        Ok(())
    }

    /// 상태기계의 컨트롤 봉투. **여기서 JSON을 그대로 쓰지 않는다** — 옮김기가 번역한다.
    fn send(&mut self, line: Value) {
        let now = now_ms();
        let e = self.tx.on_outgoing(&line, now);
        self.drive(e);
    }

    fn close_input(&mut self) {
        self.stdin.take(); // drop = EOF → app-server가 정리 후 종료한다
    }

    fn kill(&mut self) {
        if let Some(c) = &mut self.child {
            let _ = c.kill();
        }
    }

    fn process_alive(&self) -> bool {
        self.child.is_some() && self.eof_at.is_none()
    }

    fn stream_eof(&mut self) -> Option<CloseCause> {
        let at = self.eof_at?;
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
            None if at.elapsed() < EXIT_CODE_GRACE => None,
            None => Some(CloseCause::Crash),
        }
    }

    fn poll_frames(&mut self, now: Millis) -> Vec<Value> {
        if let Some(observer)=&self.observer {
            let counts={let stats=self.stats.lock().unwrap_or_else(|e|e.into_inner());(stats.parse_errors,stats.oversized_dropped)};
            if counts!=self.observed_errors {self.observed_errors=counts;observer("protocol-in",&serde_json::json!({"type":"coverage-gap","text":"Engine parser rejected or exceeded the size limit for a frame","parseErrors":counts.0,"oversizedFrames":counts.1}));}
        }
        let mut rpcs: Vec<Value> = vec![];
        if let Some(rx) = &self.rx {
            loop {
                match rx.try_recv() {
                    Ok(v) => rpcs.push(v),
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        if self.eof_at.is_none() {
                            self.eof_at = Some(Instant::now());
                        }
                        break;
                    }
                }
            }
        }
        let wall = now_ms();
        for v in rpcs {
            if let Some(observer) = &self.observer { observer("protocol-in", &v); }
            let e = self.tx.on_rpc(&v, wall);
            self.drive(e);
        }
        let e = self.tx.tick(wall);
        self.drive(e);
        let _ = now;
        self.out.drain(..).collect()
    }

    fn spawn_count(&self) -> usize {
        self.spawns
    }
}

/// 옮김기의 시각 축은 **벽시계 ms**다(백그라운드 폴링 간격에만 쓴다). 상태기계의
/// 단조 시계와 섞지 않으려고 인자로 받지 않고 여기서 읽는다.
fn now_ms() -> Millis {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn archive_observer_keeps_unknown_original_rpc_payloads_before_translation() {
        let seen=Arc::new(Mutex::new(Vec::new()));let copy=seen.clone();
        let mut driver=CodexDriver::new(PathBuf::from("unused"),None,None).with_observer(Arc::new(move|source,value|{copy.lock().unwrap().push((source.to_string(),value.clone()));}));
        let (tx,rx)=channel();driver.rx=Some(rx);
        let frame=serde_json::json!({"method":"future/tool/fullResult","params":{"content":"원문 🧪\n".repeat(50_000),"unknownFields":{"preserved":true}}});
        tx.send(frame.clone()).unwrap();driver.poll_frames(0);
        assert_eq!(seen.lock().unwrap().iter().find(|(source,_)|source=="protocol-in").unwrap().1,frame);
    }

    /// 네이티브 실행본은 **cmd를 안 거친다**(프로세스 하나 · 인용 문제 없음).
    #[test]
    fn a_native_exe_is_spawned_directly() {
        let p = PathBuf::from("C:\\a b\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe");
        let c = command_for(&p);
        assert_eq!(c.get_program(), p.as_os_str());
        let args: Vec<String> = c.get_args().map(|a| a.to_string_lossy().to_string()).collect();
        assert_eq!(args, vec!["app-server".to_string()]);
    }

    #[cfg(windows)]
    #[test]
    fn a_cmd_shim_is_launched_through_cmd_exe() {
        // `.cmd`는 커널이 직접 못 띄운다 → cmd 경유. 인용은 raw로 나가야 한다
        // (`arg()`의 `\"` 이스케이프를 cmd가 못 읽는다 — 실측으로 밟은 자리).
        let c = command_for(&PathBuf::from("C:\\a b\\codex.cmd"));
        assert_eq!(c.get_program().to_string_lossy(), "cmd");
        // raw_arg는 `get_args`에 그대로 실린다.
        let args: Vec<String> = c.get_args().map(|a| a.to_string_lossy().to_string()).collect();
        assert_eq!(args[0], "/C");
        assert_eq!(args[1], "\"\"C:\\a b\\codex.cmd\" app-server\"");
    }

    /// ★R2 — **인용 회귀를 실제로 잠근다.**
    ///
    /// 위 단언(`get_args()`)은 동어반복이다: `arg()`와 `raw_arg()`는 **논리 인자가 같고**
    /// 차이는 `CreateProcess`에 넘길 커맨드라인을 만들 때만 난다. 크리틱이 뮤테이션으로
    /// 증명했다 — `raw_arg`를 `arg`로 되돌려도 그 테스트는 초록이다. 그래서 여기서는
    /// **공백 있는 경로에 shim을 만들어 실제로 띄우고**, 같은 문자열을 `arg()`로 넘긴
    /// 대조군이 못 뜨는 것까지 함께 본다(결함이 실재한다는 증거를 테스트가 들고 있게).
    #[cfg(windows)]
    #[test]
    fn a_cmd_shim_in_a_path_with_spaces_actually_launches() {
        use std::os::windows::process::CommandExt;
        let dir = std::env::temp_dir().join(format!("ccg rawarg {}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let shim = dir.join("codex.cmd");
        std::fs::write(&shim, "@echo off\r\necho SHIM-OK %1\r\n").unwrap();

        // ① 제품이 만드는 커맨드 — 바깥 따옴표 한 겹(`cmd /C ""C:\a b\codex.cmd" app-server"`).
        let mut c = command_for(&shim);
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW — 콘솔 깜빡임 방지
        let a = c.output().expect("spawn");
        let a_out = String::from_utf8_lossy(&a.stdout).to_string()
            + &String::from_utf8_lossy(&a.stderr);

        // ② 뮤테이션 대조 — `arg()`는 MSVC 규칙으로 `\"`를 넣는데 cmd.exe는 그걸 모른다.
        let s = shim.to_string_lossy().to_string();
        let mut c2 = Command::new("cmd");
        c2.arg("/C").arg(format!("\"\"{s}\" app-server\""));
        c2.creation_flags(0x0800_0000);
        let b = c2.output().expect("spawn");
        let b_out = String::from_utf8_lossy(&b.stdout).to_string()
            + &String::from_utf8_lossy(&b.stderr);

        let _ = std::fs::remove_dir_all(&dir);
        assert!(a_out.contains("SHIM-OK"), "제품 경로가 shim을 못 띄웠다: {a_out}");
        assert!(a_out.contains("app-server"), "인자가 안 실렸다: {a_out}");
        assert!(
            !b_out.contains("SHIM-OK"),
            "`arg()`로도 떴다 = 이 테스트가 인용 회귀를 못 잡는다: {b_out}"
        );
    }

    /// ★R28d EXTN R2 — **맨 이름은 여기서 해석한다**(셸이 훑을 기회를 안 준다).
    ///
    /// R1까지 이 테스트는 *"맨 이름도 셸을 지난다"*(`get_program() == "cmd"`)였다. 그 규칙이
    /// 확인 크리틱 R2 §5의 구멍이었다 — `cmd.exe`는 `PATH`보다 **현재 폴더**를 먼저 뒤지고
    /// 그 폴더는 채팅의 작업 폴더다. 이제 두 갈래로 갈린다:
    ///  ① 해석된다 → 셸에 **절대 경로**가 실린다(맨 이름이 실리면 회귀다),
    ///  ② 아무 데도 없다 → 셸로 **안 보낸다**(= cmd가 현재 폴더를 볼 기회 자체가 없다).
    ///
    /// PATH를 안 만지고 재는 방법: 게이트의 **첫 폴더가 실행 파일 폴더**라(`search_dirs`)
    /// 이 테스트 바이너리 옆에 shim을 심으면 그 자리가 그대로 답이 된다.
    #[cfg(windows)]
    #[test]
    fn a_bare_name_is_resolved_here_so_the_shell_never_searches() {
        let me = std::env::current_exe().unwrap();
        let name = format!("ccg-extn-cmdfor-{}", std::process::id());
        let shim = me.parent().unwrap().join(format!("{name}.cmd"));
        std::fs::write(&shim, "@echo off\r\n").unwrap();

        let c = command_for(&PathBuf::from(&name));
        let args: Vec<String> = c.get_args().map(|a| a.to_string_lossy().to_string()).collect();
        let _ = std::fs::remove_file(&shim);
        assert_eq!(c.get_program().to_string_lossy(), "cmd", "`.cmd`는 여전히 셸을 지난다");
        // 붙는 확장자는 `PATHEXT`의 **글자 그대로**다(이 컴퓨터의 값은 `.CMD`) — 같은 파일이다.
        assert_eq!(
            args[1].to_ascii_lowercase(),
            format!("\"\"{}\" app-server\"", shim.display()).to_ascii_lowercase(),
            "★ 셸에 맨 이름을 넘겼다 = cmd가 **현재 폴더부터** 다시 훑는다"
        );

        // ② 아무 데도 없는 이름 — 그대로 스폰해서 실패시킨다(게이트의 답과 한 벌).
        let ghost = format!("ccg-extn-ghost-{}", std::process::id());
        let g = command_for(&PathBuf::from(&ghost));
        assert_eq!(
            g.get_program().to_string_lossy(),
            ghost,
            "★ 게이트가 「없다」고 답한 맨 이름을 cmd에 넘겼다"
        );
    }

    /// ★R28d EXTN R2 — **연 폴더에만 codex가 있는 판에서 게이트와 스폰의 답이 같다.**
    ///
    /// 확인 크리틱 R2 §5가 판 구멍이고 크리틱이 요구한 못이다. 게이트(`resolve_bin`)는
    /// 실행 파일 폴더 + `PATH`만 보는데 스폰은 `cmd /C`라 **채팅의 작업 폴더**를 먼저 봤다:
    /// 게이트 `null`(→ `can_ask=false` → 한도 `Unknown` → 눈감고 발사)인데 턴은 그 폴더의
    /// 실행본으로 떴다.
    ///
    /// **`NoDefaultCurrentDirectoryInExePath`를 지우고 잰다.** Git Bash가 그 변수를 넣기
    /// 때문에(레지스트리엔 없다 — 크리틱 §5.4) 안 지우면 `cmd`가 현재 폴더를 아예 안 뒤져
    /// 이 못이 **조용히 초록**이 된다. 데스크탑에서 뜨는 사용자 앱에는 그 변수가 없다.
    /// 그래서 대조 팔(고치기 전의 모양)이 이 못 안에 들어 있다 — 그쪽이 빨갛지 않으면
    /// 이 못은 아무것도 안 잡는다는 뜻이라 같이 실패한다.
    #[cfg(windows)]
    #[test]
    fn the_gate_and_a_real_spawn_agree_when_the_cli_sits_only_in_the_chat_folder() {
        use std::os::windows::process::CommandExt;
        let dir = std::env::temp_dir().join(format!("ccg-extn-cwd-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // 「사용자가 연 폴더에 떨어져 있는 codex」 — 뜨면 표식을 남긴다.
        let name = format!("ccg-extn-cwd-{}", std::process::id());
        std::fs::write(dir.join(format!("{name}.cmd")), "@echo off\r\necho x> ran.txt\r\n").unwrap();
        let ran = dir.join("ran.txt");

        // ① 게이트 — 실행 파일 폴더에도 PATH에도 없는 이름이다.
        let gate = crate::codex::versions::resolve_bin(Path::new(&name));

        // ② 제품 경로 — 드라이버가 하는 그대로(현재 폴더 = 채팅의 작업 폴더).
        let mut c = command_for(&PathBuf::from(&name));
        c.current_dir(&dir)
            .env_remove("NoDefaultCurrentDirectoryInExePath")
            .creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let _ = c.output(); // 스폰 실패가 정상 착지다
        let product_ran = ran.exists();

        // ③ 대조 — R1까지의 모양(맨 이름을 그대로 `cmd /C`에).
        let mut ctl = Command::new("cmd");
        ctl.raw_arg("/C");
        ctl.raw_arg(format!("\"\"{name}\" app-server\""));
        ctl.current_dir(&dir)
            .env_remove("NoDefaultCurrentDirectoryInExePath")
            .creation_flags(0x0800_0000);
        let _ = ctl.output();
        let control_ran = ran.exists();

        let _ = std::fs::remove_dir_all(&dir);
        assert!(gate.is_none(), "게이트가 이미 그 폴더를 본다면 이 못의 전제가 다르다: {gate:?}");
        assert!(
            control_ran,
            "옛 모양이 연 폴더의 {name}.cmd를 안 띄웠다 = 이 컴퓨터에서는 이 못이 아무것도 못 잡는다"
        );
        assert!(
            !product_ran,
            "★ 게이트는 「창구 없음」인데 스폰이 **연 폴더의 실행본**을 띄웠다(= 한도 Unknown으로 눈감고 발사)"
        );
    }

    /// `.exe`·`.com`이 아닌 확장자는 전부 셸을 지난다 — 게이트의 후보가 `PATHEXT` 전부라
    /// (`versions::path_exts`) 여기만 `.cmd`/`.bat`면 「띄울 수 있다」고 답한 값을 직접
    /// 스폰해 실패한다(보고서 §7.3의 비대칭).
    #[cfg(windows)]
    #[test]
    fn a_scripted_extension_goes_through_the_shell_but_a_native_one_does_not() {
        for (p, shell) in [
            ("C:\\x\\codex.vbs", true),
            ("C:\\x\\codex.js", true),
            ("C:\\x\\codex.bat", true),
            ("C:\\x\\codex.exe", false),
            ("C:\\x\\codex.COM", false),
        ] {
            let c = command_for(&PathBuf::from(p));
            assert_eq!(
                c.get_program().to_string_lossy() == "cmd",
                shell,
                "{p}의 갈래가 게이트와 어긋난다"
            );
        }
    }
}
