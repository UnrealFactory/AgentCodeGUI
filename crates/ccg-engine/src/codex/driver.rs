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
use std::path::PathBuf;
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

pub struct CodexDriver {
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
    /// 마지막 스폰이 쓴 `CODEX_HOME`(진단 — `engine:debug`가 읽는다).
    pub last_home: Option<PathBuf>,
}

impl CodexDriver {
    pub fn new(bin: PathBuf, job: Option<Arc<crate::job::Job>>, dump: Option<PathBuf>) -> CodexDriver {
        CodexDriver {
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
            last_home: None,
        }
    }

    /// 계정별 격리 `CODEX_HOME` 훅. 셸이 꽂는다([`HomeResolver`] 참고).
    pub fn with_home_resolver(mut self, r: HomeResolver) -> Self {
        self.home = Some(r);
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
/// `.cmd`/`.bat` shim이나 PATH 이름(`codex`)으로 떨어지는 경우에만 `cmd /C`를 경유한다 —
/// 커널이 배치 파일을 직접 실행할 수 없기 때문이다.
///
/// ★ 그 경로의 인용은 **`raw_arg`로 직접 쓴다.** `arg()`는 MSVC 규칙으로 `\"`를 넣는데
/// `cmd.exe`는 백슬래시 이스케이프를 모른다 — 그래서 경로가 통째로 깨진다(이 라운드에
/// `poc-codex --only=handshake`가 실측으로 잡았다). 올바른 모양은 바깥 따옴표 한 겹이다:
/// `cmd /C ""C:\a b\codex.cmd" app-server"`.
fn command_for(bin: &PathBuf) -> Command {
    let s = bin.to_string_lossy().to_string();
    let low = s.to_ascii_lowercase();
    let bare_name = !s.contains('\\') && !s.contains('/');
    let needs_shell = cfg!(windows) && (low.ends_with(".cmd") || low.ends_with(".bat") || bare_name);
    if !needs_shell {
        let mut c = Command::new(bin);
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
        let plan = spec.codex.clone().unwrap_or_default();
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

    #[cfg(windows)]
    #[test]
    fn a_bare_name_goes_through_the_shell_too() {
        // PATH 폴백(`codex`)도 Windows에선 `.cmd` shim이다.
        let c = command_for(&PathBuf::from("codex"));
        assert_eq!(c.get_program().to_string_lossy(), "cmd");
    }
}
