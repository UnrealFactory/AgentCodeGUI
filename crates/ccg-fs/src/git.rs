//! Git — 시스템 `git` CLI 얇은 래퍼(`git -C <root> …`). `src/main/git.ts`의 이식.
//!
//! 왜 라이브러리(git2/gix)가 아니라 CLI인가: 2.6.2가 CLI라서 **답이 같아야** 하고
//! (사용자의 credential helper·hook·config·LFS가 그대로 먹는다), 번들 크기가 0이며,
//! 이 앱을 쓰는 사람의 머신에는 git이 이미 있다. 저장소가 아니면 조용히 `repo:false`로
//! 떨어져 스트립 자체를 안 그리는 것도 2.6.2와 같다.
//!
//! 출력 파싱은 로케일·인용에 안 흔들리는 기계 출력만 쓴다:
//!   - status: `--porcelain=v2 --branch -z` (NUL 구분 → 한글 경로 그대로)
//!   - log/branch: `\x1f`(unit separator) 필드 구분 — 커밋 메시지에 나올 수 없는 글자
//!   - name-status: `-z` (R/C는 status·old·new 3연속 토큰)

use crate::diff::{compute_line_diff, new_file_diff, DiffLine, FileDiff};
use serde::Serialize;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

// ── 상한(크래시 규율) ───────────────────────────────────────────────────────

/// 한쪽 1.5MB 초과·바이너리는 diff 표시를 포기한다(뷰어 멈춤 방지). 2.6.2와 같은 값.
const MAX_DIFF_BYTES: usize = 1_500_000;
/// git stdout 상한 — Node `execFile`의 maxBuffer 32MB 자리. 넘으면 자식을 죽이고
/// 실패로 돌려준다(Rust `Command::output()`은 무제한이라 이 캡이 없으면 거대 blob
/// 하나가 프로세스 메모리를 그대로 먹는다).
const MAX_OUTPUT: usize = 32 * 1024 * 1024;
/// stderr는 한 줄만 쓴다 — 넉넉히 잡아도 이 이상은 의미가 없다.
const MAX_STDERR: usize = 256 * 1024;
/// log 필드 구분자 — 커밋 메시지에 나올 수 없는 unit separator.
const FS: char = '\x1f';

// ── 계약면 모양(protocol.ts) ────────────────────────────────────────────────

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatus {
    pub path: String,
    pub status: &'static str, // M A D R U
    #[serde(skip_serializing_if = "Option::is_none")]
    pub renamed_from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub untracked: Option<bool>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub repo: bool,
    pub root: String,
    pub branch: String,
    pub detached: bool,
    pub ahead: u32,
    pub behind: u32,
    pub upstream: Option<String>,
    pub has_remote: bool,
    pub files: Vec<GitFileStatus>,
}

#[derive(Serialize, Debug, Clone)]
pub struct GitRepoInfo {
    pub root: String,
    pub rel: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct GitCommit {
    pub hash: String,
    #[serde(rename = "shortHash")]
    pub short_hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub time: i64,
    pub refs: Vec<String>,
    pub subject: String,
    pub unpushed: bool,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitLogResult {
    pub commits: Vec<GitCommit>,
    pub has_more: bool,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDiffResult {
    pub diff: Option<FileDiff>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// 워크트리에서 지워진 파일 — 디스크에 없어 뷰어가 읽을 게 없으니 HEAD 내용을
    /// 스냅샷으로 준다("되돌리기 전에 뭘 잃는지"를 보게).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_content: Option<String>,
    /// 커밋 시점 조회(`git:commit-file-diff`)에서만 채운다 — 뷰어 override의 본문.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitFile {
    pub path: String,
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub renamed_from: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitDetail {
    pub hash: String,
    pub short_hash: String,
    pub author: String,
    pub time: i64,
    pub subject: String,
    pub body: String,
    pub files: Vec<GitCommitFile>,
}

#[derive(Serialize, Debug, Clone)]
pub struct GitBranch {
    pub name: String,
    pub current: bool,
    pub time: i64,
}

pub use crate::file::OpResult as GitResult;

fn not_repo() -> GitStatus {
    GitStatus {
        repo: false,
        root: String::new(),
        branch: String::new(),
        detached: false,
        ahead: 0,
        behind: 0,
        upstream: None,
        has_remote: false,
        files: Vec::new(),
    }
}

fn e_not_repo() -> String {
    crate::t("Git 저장소가 아니에요", "Not a Git repository")
}

// ── git 실행 ────────────────────────────────────────────────────────────────

struct Out {
    ok: bool,
    stdout: String,
    stderr: String,
    /// stdout이 `MAX_OUTPUT`을 넘어 자식을 죽였다. `ok:false`의 **이유**를 가르는 신호다 —
    /// 이게 없으면 "HEAD에 그 파일이 없다"와 구분이 안 돼 35MB blob이 "새 파일 +1 −0"으로
    /// 그려진다(크리틱 R1 §S5).
    over: bool,
}

impl Out {
    fn failed() -> Out {
        Out { ok: false, stdout: String::new(), stderr: String::new(), over: false }
    }
}

thread_local! {
    /// 이 **스레드**가 띄운 `git` 자식 수 — 측정용 계수기.
    ///
    /// 릴리스에도 남기는 이유: 「파일 하나당 스폰 하나」 같은 회귀는 결과가 맞아서 테스트로는
    /// 안 잡히고 **느려지기만** 한다(사용자가 "커밋이 느리다"고 말한 그 자리다).
    /// 스레드별인 이유: 병렬로 도는 테스트끼리 계수가 섞이면 숫자가 증거가 못 된다.
    /// `status()`처럼 자식을 **별도 스레드에서** 띄우는 자리는 그 스레드 쪽에 잡힌다.
    static SPAWNS: std::cell::Cell<u64> = std::cell::Cell::new(0);
}

/// 지금까지 이 스레드가 띄운 `git` 자식 수. 두 시점의 차가 「그 호출이 몇 번 띄웠나」다.
pub fn spawn_count() -> u64 {
    SPAWNS.with(|c| c.get())
}

/// `git -C <root> <args>` — stdin은 닫아 둔다(2.6.2 `execFile`과 같은 자리).
fn exec(root: &Path, args: &[&str]) -> Out {
    exec_in(root, args, None)
}

/// stdin으로 바이트를 밀어 넣는 변형 — **경로 목록과 커밋 메시지를 argv 밖으로 빼는 길**.
///
/// Windows `CreateProcess`의 명령줄 한계는 32,767자다. 고른 파일을 전부 argv로 넘기면
/// (2.6.2 `git add -A -- …files`, 3.0 R1도 같음) 수백 개·긴 경로에서 **스폰 자체가 실패**한다 —
/// 사용자가 "파일이 많으면 커밋이 안 된다"고 보고한 그 사고다. `--pathspec-from-file=-`과
/// `commit -F -`는 그 목록을 파이프로 받는다(길이 무제한).
fn exec_stdin(root: &Path, args: &[&str], input: &[u8]) -> Out {
    exec_in(root, args, Some(input))
}

/// 콘솔 창을 띄우지 않고, stdout은 `MAX_OUTPUT`에서 끊고 자식을 죽인다
/// (끊긴 실행은 `ok:false` — 반쪽 출력을 파싱해 거짓말하지 않는다).
fn exec_in(root: &Path, args: &[&str], input: Option<&[u8]>) -> Out {
    use std::process::{Command, Stdio};
    let mut cmd = Command::new("git");
    let stdin_mode = if input.is_some() { Stdio::piped() } else { Stdio::null() };
    cmd.arg("-C").arg(root).args(args).stdin(stdin_mode).stdout(Stdio::piped()).stderr(Stdio::piped());
    // 전역 pager·색은 기계 출력에 섞이면 안 된다(사용자 config가 켜 뒀을 수 있다)
    cmd.env("GIT_PAGER", "cat").env("GIT_TERMINAL_PROMPT", "0");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let Ok(mut child) = cmd.spawn() else {
        // git 미설치 — 2.6.2에서도 `ok:false`로 떨어져 "저장소 아님"이 된다
        return Out::failed();
    };
    SPAWNS.with(|c| c.set(c.get() + 1));
    // stdin도 **별도 스레드**다. 여기서 다 써 넣고 읽으러 가면, 목록이 파이프 버퍼(64KB)보다
    // 클 때 git이 stdout·stderr를 못 비워 서로 막힌다 — 파일 2,000개 경로가 정확히 그 언저리다.
    // 쓰기 실패(EPIPE)는 무시한다: git이 인자 오류로 먼저 죽으면 그 사유는 stderr에 있다.
    let stdin_pipe = child.stdin.take();
    let in_thread = input.map(|b| {
        let buf = b.to_vec();
        std::thread::spawn(move || {
            if let Some(mut p) = stdin_pipe {
                let _ = p.write_all(&buf);
                let _ = p.flush();
            } // drop = 파이프 닫힘 = git이 보는 EOF
        })
    });
    // stderr는 별도 스레드로 — 두 파이프를 한 스레드에서 순서대로 읽으면 상대가 가득
    // 차서 서로 막힌다(고전적 파이프 교착).
    // ★ 캡을 넘어도 **읽기는 계속한다**(버리기만). `take(256KB)`로 멈추면 파이프가
    //   차서 git이 write에서 막히거나(교착) 스레드 종료 시 EPIPE로 죽는다 —
    //   대량 warning을 뱉는 git이 오면 예측 못 할 상태가 되는 자리였다(크리틱 §7 R-3).
    let err_pipe = child.stderr.take();
    let err_thread = std::thread::spawn(move || {
        let mut buf: Vec<u8> = Vec::new();
        if let Some(mut p) = err_pipe {
            let mut chunk = [0u8; 8192];
            loop {
                match p.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if buf.len() < MAX_STDERR {
                            let room = (MAX_STDERR - buf.len()).min(n);
                            buf.extend_from_slice(&chunk[..room]);
                        }
                    }
                }
            }
        }
        buf
    });
    let mut out_buf: Vec<u8> = Vec::new();
    let mut over = false;
    if let Some(p) = child.stdout.take() {
        // 캡 + 1바이트까지 읽어 "넘쳤다"를 정확히 판정한다
        let _ = p.take(MAX_OUTPUT as u64 + 1).read_to_end(&mut out_buf);
        over = out_buf.len() > MAX_OUTPUT;
        if over {
            let _ = child.kill();
        }
    }
    let status = child.wait();
    let stderr = err_thread.join().unwrap_or_default();
    if let Some(h) = in_thread {
        let _ = h.join();
    }
    let ok = !over && status.map(|s| s.success()).unwrap_or(false);
    Out {
        ok,
        stdout: String::from_utf8_lossy(&out_buf).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        over,
    }
}

/// git 에러는 stderr가 본문 — 렌더러 한 줄 표시용으로 다듬는다(`fatal:` 접두 제거).
fn err_line(stderr: &str, stdout: &str) -> String {
    let raw = if !stderr.is_empty() { stderr } else { stdout };
    let first = raw.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    let low = first.to_lowercase();
    let s = if low.starts_with("fatal:") || low.starts_with("error:") { first[6..].trim() } else { first };
    if s.is_empty() { crate::t("알 수 없는 오류", "Unknown error") } else { s.to_string() }
}

/// 저장소 루트(toplevel) — git 미설치·저장소 아님이면 None.
pub fn repo_root(cwd: &str) -> Option<PathBuf> {
    if cwd.is_empty() {
        return None;
    }
    let r = exec(Path::new(cwd), &["rev-parse", "--show-toplevel"]);
    if !r.ok {
        return None;
    }
    let root = r.stdout.trim();
    if root.is_empty() {
        None
    } else {
        std::path::absolute(root).ok().map(|p| crate::resolve_lexical(&p, ""))
    }
}

/// 루트 밖으로 못 나가게 — git이 준 rel(포워드 슬래시)을 안전하게 절대 경로로.
fn abs_of(root: &Path, rel: &str) -> Option<PathBuf> {
    let abs = crate::resolve_lexical(root, rel);
    if crate::inside(root, &abs) { Some(abs) } else { None }
}

/// porcelain v2의 XY(index·worktree) 한 쌍 → 표시용 상태 문자 하나로 접기.
/// 스테이징 개념을 UI에 안 쓰므로 "워크트리 우선, 없으면 index" — R(개명)은 어느 쪽이든 R.
fn collapse_xy(xy: &str) -> &'static str {
    let mut it = xy.chars();
    let x = it.next().unwrap_or('.');
    let y = it.next().unwrap_or('.');
    if x == 'R' || y == 'R' {
        return "R";
    }
    let c = if y != '.' { y } else { x };
    match c {
        'A' | 'C' => "A",
        'D' => "D",
        _ => "M", // M·T·기타 → 수정
    }
}

// ── 저장소 발견 ─────────────────────────────────────────────────────────────

/// 걷기에서 건너뛰는 폴더 — 저장소가 있을 리 없는 무거운 생성물 폴더들(UE·JS·닷넷·유니티).
const REPO_WALK_SKIP: &[&str] = &[
    "node_modules", "Intermediate", "Saved", "Binaries", "DerivedDataCache", "Content",
    "dist", "out", "build", "Build", "obj", "bin", "Library", "Temp", "__pycache__",
];
const REPO_WALK_DEPTH: u32 = 3; // cwd(0) 아래 3단계 — Plugins/그룹/저장소 꼴까지

/// cwd가 속한(위쪽) 저장소 + cwd 아래 얕은 걷기로 찾은 저장소들.
/// 걷기는 fs만 쓴다(.git 존재 확인 — 파일이어도 인정: 서브모듈/워크트리의 gitfile).
/// 저장소로 판정된 폴더 아래로는 더 안 내려간다.
pub fn repos(cwd: &str) -> Vec<GitRepoInfo> {
    if cwd.is_empty() {
        return Vec::new();
    }
    let Ok(abs_cwd) = std::path::absolute(cwd) else { return Vec::new() };
    let base = crate::resolve_lexical(&abs_cwd, "");
    let mut out: Vec<GitRepoInfo> = Vec::new();
    let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    let mut add = |out: &mut Vec<GitRepoInfo>, root: &Path| {
        let r = crate::resolve_lexical(root, "");
        if !seen.insert(r.clone()) {
            return;
        }
        // base 밖(상위) 저장소는 rel '' — 스트립이 라벨 없이 그린다
        let rel = r
            .strip_prefix(&base)
            .ok()
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        out.push(GitRepoInfo { root: r.to_string_lossy().to_string(), rel });
    };
    if let Some(up) = repo_root(base.to_string_lossy().as_ref()) {
        add(&mut out, &up);
    }
    walk_repos(&base, 0, &mut out, &mut add);
    // cwd 자신/상위 저장소 먼저, 나머지는 경로순 — 스트립·카드 목록 순서
    out.sort_by(|a, b| match (a.rel.is_empty(), b.rel.is_empty()) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.rel.cmp(&b.rel),
    });
    out
}

fn walk_repos(
    dir: &Path,
    depth: u32,
    out: &mut Vec<GitRepoInfo>,
    add: &mut impl FnMut(&mut Vec<GitRepoInfo>, &Path),
) {
    let Ok(read) = std::fs::read_dir(dir) else { return };
    let mut subs: Vec<PathBuf> = Vec::new();
    let mut is_repo = false;
    for e in read.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name == ".git" {
            is_repo = true;
        }
        if e.file_type().map(|t| t.is_dir()).unwrap_or(false)
            && !name.starts_with('.')
            && !REPO_WALK_SKIP.contains(&name.as_str())
        {
            subs.push(dir.join(&name));
        }
    }
    // 이 폴더 자체가 저장소면 등록만 하고 안 내려간다
    if is_repo {
        add(out, dir);
        return;
    }
    if depth >= REPO_WALK_DEPTH {
        return;
    }
    for s in subs {
        walk_repos(&s, depth + 1, out, add);
    }
}

// ── status ─────────────────────────────────────────────────────────────────

pub fn status(cwd: &str) -> GitStatus {
    let Some(root) = repo_root(cwd) else { return not_repo() };
    status_at(&root)
}

/// 루트를 **이미 아는** 호출자용 — `rev-parse` 왕복 하나를 아낀다(`push`가 그렇다).
fn status_at(root: &Path) -> GitStatus {
    let root = root.to_path_buf();
    // 두 git을 **동시에** 띄운다. 스트립이 매 턴 폴링하는 자리라 왕복 하나가 그대로
    // 체감이 된다 — 2.6.2는 `Promise.all([status, remote])`였는데(git.ts:161) R1이
    // 순차로 옮기며 1.5~2배 느려졌다(크리틱 §S9: 3.0 61·80·132ms vs 2.6.2 44·66ms).
    let root2 = root.clone();
    let remote_job = std::thread::spawn(move || exec(&root2, &["remote"]));
    let st = exec(&root, &["status", "--porcelain=v2", "--branch", "-z"]);
    // 실패로 빠질 때도 자식을 거둬야 한다(join 없이 나가면 git.exe가 고아로 남는다)
    let remotes = remote_job.join().unwrap_or_else(|_| Out::failed());
    if !st.ok {
        return not_repo();
    }
    let mut out = GitStatus {
        repo: true,
        root: root.to_string_lossy().to_string(),
        branch: String::new(),
        detached: false,
        ahead: 0,
        behind: 0,
        upstream: None,
        has_remote: remotes.ok && !remotes.stdout.trim().is_empty(),
        files: Vec::new(),
    };
    let toks: Vec<&str> = st.stdout.split('\0').collect();
    let mut i = 0usize;
    while i < toks.len() {
        let tok = toks[i];
        i += 1;
        if tok.is_empty() {
            continue;
        }
        if let Some(h) = tok.strip_prefix("# branch.head ") {
            out.detached = h == "(detached)";
            out.branch = if out.detached { crate::t("HEAD 분리됨", "Detached HEAD") } else { h.to_string() };
        } else if let Some(u) = tok.strip_prefix("# branch.upstream ") {
            out.upstream = Some(u.to_string());
        } else if let Some(ab) = tok.strip_prefix("# branch.ab ") {
            // "+3 -0"
            for part in ab.split_whitespace() {
                if let Some(n) = part.strip_prefix('+') {
                    out.ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix('-') {
                    out.behind = n.parse().unwrap_or(0);
                }
            }
        } else if tok.starts_with("1 ") {
            // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
            if let Some((xy, path)) = split_fields(tok, 6) {
                out.files.push(GitFileStatus {
                    path: path.to_string(),
                    status: collapse_xy(xy),
                    renamed_from: None,
                    untracked: None,
                });
            }
        } else if tok.starts_with("2 ") {
            // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>  ← origPath는 다음 NUL 토큰
            let orig = toks.get(i).copied().unwrap_or("");
            i += 1;
            if let Some((_, path)) = split_fields(tok, 7) {
                out.files.push(GitFileStatus {
                    path: path.to_string(),
                    status: "R",
                    renamed_from: if orig.is_empty() { None } else { Some(orig.to_string()) },
                    untracked: None,
                });
            }
        } else if tok.starts_with("u ") {
            // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
            if let Some((_, path)) = split_fields(tok, 8) {
                out.files.push(GitFileStatus {
                    path: path.to_string(),
                    status: "U",
                    renamed_from: None,
                    untracked: None,
                });
            }
        } else if let Some(p) = tok.strip_prefix("? ") {
            out.files.push(GitFileStatus {
                path: p.to_string(),
                status: "A",
                renamed_from: None,
                untracked: Some(true),
            });
        }
    }
    out.files.sort_by(|a, b| crate::collate::name_cmp(&a.path, &b.path));
    out
}

/// `"<kind> <XY> <f1> … <fN> <path>"`에서 XY와 path를 뽑는다. `skip`은 XY 뒤에 건너뛸
/// 공백 구분 필드 수. path는 공백을 품을 수 있어 **나머지 전부**다(2.6.2 정규식의
/// `(.*)`와 같다 — 정규식 크레이트를 들이지 않으려고 splitn으로 쓴다).
fn split_fields(tok: &str, skip: usize) -> Option<(&str, &str)> {
    let mut it = tok.splitn(skip + 3, ' ');
    it.next()?; // 레코드 종류('1'·'2'·'u')
    let xy = it.next()?;
    for _ in 0..skip {
        it.next()?;
    }
    let path = it.next()?;
    Some((xy, path))
}

// ── log ────────────────────────────────────────────────────────────────────

pub fn log(cwd: &str, limit: usize, skip: usize) -> GitLogResult {
    let empty = GitLogResult { commits: Vec::new(), has_more: false };
    let Some(root) = repo_root(cwd) else { return empty };
    let fmt = format!("--pretty=format:%H{FS}%h{FS}%P{FS}%an{FS}%at{FS}%D{FS}%s");
    // limit+1로 한 장 더 받아 다음 페이지 유무를 안다
    let n = format!("-n{}", limit + 1);
    let sk = format!("--skip={skip}");
    let r = exec(&root, &["log", fmt.as_str(), n.as_str(), sk.as_str(), "HEAD"]);
    if !r.ok {
        return empty;
    }
    // 업스트림에 아직 없는 커밋 집합 — '푸시 안 됨' 점(업스트림 없으면 표시 안 함)
    let mut unpushed: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let up = exec(&root, &["rev-list", "@{upstream}..HEAD"]);
    if up.ok {
        for h in up.stdout.lines() {
            if !h.trim().is_empty() {
                unpushed.insert(h.trim());
            }
        }
    }
    let rows: Vec<&str> = r.stdout.lines().filter(|l| l.contains(FS)).collect();
    let has_more = rows.len() > limit;
    let commits = rows
        .iter()
        .take(limit)
        .map(|line| {
            // `%s`가 **마지막 칸**이라 splitn으로 나머지를 통째로 준다 — 제목에 `\x1f`가
            // 섞여도 앞 칸들이 밀리지 않는다(크리틱 §7 R-4).
            let f: Vec<&str> = line.splitn(7, FS).collect();
            let g = |i: usize| f.get(i).copied().unwrap_or("");
            GitCommit {
                hash: g(0).to_string(),
                short_hash: g(1).to_string(),
                parents: g(2).split(' ').filter(|s| !s.is_empty()).map(str::to_string).collect(),
                author: g(3).to_string(),
                time: g(4).parse().unwrap_or(0),
                refs: g(5)
                    .split(", ")
                    .map(|s| s.strip_prefix("HEAD -> ").unwrap_or(s).trim())
                    .filter(|s| !s.is_empty() && *s != "HEAD")
                    .map(str::to_string)
                    .collect(),
                subject: g(6).to_string(),
                unpushed: unpushed.contains(g(0)),
            }
        })
        .collect();
    GitLogResult { commits, has_more }
}

// ── diff (뷰어 계약: 전체 파일·LF·FileDiff) ─────────────────────────────────

fn looks_binary(s: &str) -> bool {
    s.contains('\0')
}

/// 어떤 리비전의 파일 내용 — **"없다"와 "못 읽었다"를 가른다.**
///
/// R1은 둘 다 `None`이었다. 그래서 35MB blob이 32MB stdout 캡에 걸려 실패하면
/// `file_diff`가 그걸 "HEAD에 없는 새 파일"로 읽어 **70만 줄을 잃은 파일을
/// "새 파일 +1 −0" 초록 한 줄로** 그렸다(크리틱 R1 §S5 — 그 카드 옆에 되돌리기가 있다).
enum Blob {
    /// 그 리비전에 있고, 내용을 다 읽었다.
    Text(String),
    /// 그 리비전에 없다(새 파일 / 삭제 이전).
    Absent,
    /// 있는데 32MB stdout 캡을 넘었다 — 내용을 안 본다.
    TooBig,
    /// 있는데 못 읽었다(git 실패). 조용히 "새 파일"로 둔갑시키지 않는다.
    Unreadable,
}

impl Blob {
    fn text(&self) -> Option<&str> {
        match self {
            Blob::Text(s) => Some(s.as_str()),
            _ => None,
        }
    }
    /// 이 blob 때문에 diff를 접어야 하면 그 사유 문구.
    fn fold_reason(&self) -> Option<String> {
        match self {
            Blob::TooBig => Some(crate::t(
                "파일이 너무 커요 — diff 표시는 1.5MB까지만",
                "File is too large — diffs are shown up to 1.5MB",
            )),
            Blob::Unreadable => Some(crate::t("내용을 읽을 수 없어요", "Could not read the contents")),
            _ => None,
        }
    }
}

fn show_at(root: &Path, rev: &str, rel: &str) -> Blob {
    let spec = format!("{rev}:{rel}");
    // `--` 뒤로 밀 수 없는 형태(rev:path)라, rev/rel이 옵션처럼 보이지 않게 미리 막는다.
    if rel.starts_with('-') {
        return Blob::Absent;
    }
    let r = exec(root, &["show", spec.as_str()]);
    if r.ok {
        return Blob::Text(r.stdout);
    }
    // 성공 경로는 위에서 끝났다 — 아래는 **실패의 이유를 가르는** 자리뿐이라
    // 기존 성공 동작(트리·서브모듈 포함)은 한 글자도 안 바뀐다.
    if r.over {
        return Blob::TooBig;
    }
    // `cat-file -e`는 객체 존재만 본다(blob을 안 읽으므로 거대 파일에도 싸다).
    if exec(root, &["cat-file", "-e", spec.as_str()]).ok {
        Blob::Unreadable
    } else {
        Blob::Absent
    }
}

fn build_file_diff(rel: &str, base: Option<&str>, cur: Option<&str>) -> GitFileDiffResult {
    let too_big = |s: Option<&str>| s.is_some_and(|x| x.len() > MAX_DIFF_BYTES);
    if too_big(base) || too_big(cur) {
        return GitFileDiffResult {
            error: Some(crate::t(
                "파일이 너무 커요 — diff 표시는 1.5MB까지만",
                "File is too large — diffs are shown up to 1.5MB",
            )),
            ..Default::default()
        };
    }
    if base.is_some_and(looks_binary) || cur.is_some_and(looks_binary) {
        return GitFileDiffResult {
            error: Some(crate::t("바이너리 파일 — diff를 표시할 수 없어요", "Binary file — cannot show a diff")),
            ..Default::default()
        };
    }
    if base.is_none() && cur.is_none() {
        return GitFileDiffResult {
            error: Some(crate::t("내용을 읽을 수 없어요", "Could not read the contents")),
            ..Default::default()
        };
    }
    let diff = match base {
        None | Some("") => {
            let (lines, add) = new_file_diff(cur.unwrap_or(""));
            FileDiff { path: rel.to_string(), tag: "new", add, del: 0, lines }
        }
        Some(b) => {
            let (lines, add, del) = compute_line_diff(b, cur.unwrap_or(""));
            FileDiff { path: rel.to_string(), tag: "edit", add, del, lines }
        }
    };
    GitFileDiffResult { diff: Some(diff), ..Default::default() }
}

/// 워킹트리 파일 diff — HEAD ↔ 디스크. 새 파일(HEAD에 없음)은 전체 추가.
pub fn file_diff(cwd: &str, rel: &str) -> GitFileDiffResult {
    let Some(root) = repo_root(cwd) else {
        return GitFileDiffResult { error: Some(e_not_repo()), ..Default::default() };
    };
    let Some(abs) = abs_of(&root, rel) else {
        return GitFileDiffResult {
            error: Some(crate::t("잘못된 경로", "Invalid path")),
            ..Default::default()
        };
    };
    let base = show_at(&root, "HEAD", rel);
    // HEAD blob이 캡에 걸렸거나 못 읽혔다 — **"새 파일"로 둔갑시키지 않는다**(§S5).
    if let Some(why) = base.fold_reason() {
        return GitFileDiffResult { error: Some(why), ..Default::default() };
    }
    // 삭제된 파일이면 None. 디스크 읽기는 뷰어와 같은 손실 UTF-8 규칙.
    let cur: Option<String> = std::fs::read(&abs).ok().map(|b| String::from_utf8_lossy(&b).into_owned());
    if cur.is_none() && base.text().is_none() {
        return GitFileDiffResult {
            error: Some(crate::t("내용을 읽을 수 없어요", "Could not read the contents")),
            ..Default::default()
        };
    }
    let mut d = build_file_diff(rel, base.text(), Some(cur.as_deref().unwrap_or("")));
    // 디스크에서 지워진 파일 — 뷰어가 읽을 게 없으니 HEAD 스냅샷을 같이 준다
    if cur.is_none() {
        if let Blob::Text(b) = base {
            if !looks_binary(&b) && b.len() <= MAX_DIFF_BYTES {
                d.head_content = Some(b);
            }
        }
    }
    d
}

// ── 여러 파일 diff를 한 번에 (AI 커밋 메시지 전용) ──────────────────────────
//
// 2.6.2는 AI 커밋 메시지를 만들 때 파일마다 `gitFileDiff`를 직렬로 불렀다 —
// **파일 N개 = git 스폰 2N회**(`rev-parse` + `show`). 300개를 고르면 600번 프로세스를
// 띄운다. 3.0 R1도 그대로 옮겼고, 여기서 끊는다.
//
// [실측한 제약] `git diff`에는 `--pathspec-from-file`이 **없다**(git 2.53.0.windows.1:
// usage 오류로 죽는다 — add·reset·commit에만 있다). 그래서 경로를 stdin으로 못 준다.
// 대신 1차는 **스폰 한 번**으로 끝낸다:
//   · argv에 담기는 규모(≤24K자) → `git diff … HEAD -- <경로들>` (딱 고른 파일만)
//   · 그보다 크면(= 사용자가 말한 "파일이 너무 많을 때") → **경로 없이 전 트리** diff 한 번을
//     받아 고른 파일만 추린다. argv는 절대 안 넘친다.
//
// [R1 확인 크리틱이 판 구멍 — 1차가 실패하는 두 자리] 답은 맞았지만 **속도가 옛날로**
// 돌아갔다. 배치 전체가 파일당 호출로 내려앉아서다:
//   · 커밋이 하나도 없는 저장소(unborn HEAD) 300파일 = 902스폰·31.3초
//   · 전 트리 diff가 32MB 캡을 넘음(600파일·45.2MB) = 1,202스폰·32.4초
// 그래서 1차 실패에 **두 단을 넣었다**: unborn은 git을 더 안 부르고 디스크에서 답하고
// (옛 쪽이 통째로 비어 있다는 뜻이므로), 캡 초과는 목록을 **반으로 갈라** 다시 부른다
// (600파일·45MB → 300+300 = 22.5MB씩 → 스폰 4회). 파일당 호출은 마지막 그물이다.

/// argv에 pathspec을 담아도 안전한 총 길이 — Windows 32,767에서 넉넉히 물러선 자리.
const ARGV_PATHSPEC_BUDGET: usize = 24_000;
/// 대량 diff에서 **본문으로 들고 있을** 총 바이트 상한. 넘으면 줄은 버리고 개수만 센다
/// (호출부의 예산은 12만 자라 프롬프트에 닿는 글자는 이 상한에 영향받지 않는다).
const BULK_TEXT_BUDGET: usize = 4 * 1024 * 1024;

#[derive(Default)]
struct Patch {
    add: usize,
    del: usize,
    lines: Vec<DiffLine>,
    binary: bool,
    new_file: bool,
}

/// `diff --git a/<p> b/<p>`에서 경로 하나를 뽑는다. 공백이 든 경로 때문에 좌우를 못 가르는
/// 자리라 **양쪽이 같은 경로**라는 사실(`--no-renames`)로 가운데를 찾는다.
/// C 인용(`"a/…"` — 제어문자 경로)은 포기하고 None을 준다: 호출부가 그 파일만 옛길로 돌린다.
fn split_git_header(rest: &str) -> Option<String> {
    if rest.starts_with('"') || !rest.starts_with("a/") {
        return None;
    }
    let len = rest.len();
    if len < 5 || (len - 5) % 2 != 0 {
        return None;
    }
    let p = (len - 5) / 2;
    let left = rest.get(2..2 + p)?;
    if rest.get(2 + p..5 + p)? != " b/" {
        return None;
    }
    if left != rest.get(5 + p..)? {
        return None;
    }
    Some(left.to_string())
}

/// `--- a/<p>` · `+++ b/<p>`의 경로. 경로에 공백이 있으면 git이 **뒤에 탭 하나**를 붙여
/// 구분해 준다(실측) — 그 탭만 걷어내면 이름이 그대로 나온다.
fn strip_ab(v: &str) -> Option<String> {
    if v.starts_with('"') {
        return None; // 인용 경로 — 파일 단위 폴백
    }
    let v = v.strip_prefix("a/").or_else(|| v.strip_prefix("b/"))?;
    Some(v.strip_suffix('\t').unwrap_or(v).to_string())
}

/// `git diff -U0` 출력 → 파일별 변경 줄. 두 번째 값은 **경로를 못 읽은 덩이가 있었나**로,
/// 참이면 호출부가 "diff에 없다 = 안 바뀌었다"라고 단정하지 않는다(조용한 거짓말 방지).
fn parse_bulk_patch(out: &str) -> (std::collections::HashMap<String, Patch>, bool) {
    let mut map: std::collections::HashMap<String, Patch> = std::collections::HashMap::new();
    let mut unparsed = false;
    let mut cur = Patch::default();
    let mut cur_path: Option<String> = None;
    let mut have = false;
    let mut in_hunk = false;
    let mut stored = 0usize;
    for line in out.lines() {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            if have {
                match cur_path.take() {
                    Some(p) => {
                        map.insert(p, std::mem::take(&mut cur));
                    }
                    None => unparsed = true,
                }
            }
            cur = Patch::default();
            cur_path = split_git_header(rest);
            have = true;
            in_hunk = false;
            continue;
        }
        if !have {
            continue;
        }
        if line.starts_with("@@ ") {
            in_hunk = true;
            continue;
        }
        if !in_hunk {
            // 파일 머리 — 여기서만 `---`/`+++`가 헤더다(본문에도 같은 글자가 나온다)
            if let Some(v) = line.strip_prefix("--- ") {
                if v == "/dev/null" {
                    cur.new_file = true;
                } else if let Some(p) = strip_ab(v) {
                    cur_path = Some(p);
                }
            } else if let Some(v) = line.strip_prefix("+++ ") {
                if v != "/dev/null" {
                    if let Some(p) = strip_ab(v) {
                        cur_path = Some(p);
                    }
                }
            } else if line.starts_with("Binary files ") || line.starts_with("Binary file ") {
                cur.binary = true;
            }
            continue;
        }
        // 훅 안 — `-U0`라 ctx는 없고 `+`/`-`뿐이다(`\ No newline…`은 버린다)
        let (t, text) = match line.as_bytes().first() {
            Some(b'+') => ("add", &line[1..]),
            Some(b'-') => ("del", &line[1..]),
            _ => continue,
        };
        if t == "add" {
            cur.add += 1;
        } else {
            cur.del += 1;
        }
        if stored + text.len() <= BULK_TEXT_BUDGET {
            stored += text.len();
            cur.lines.push(DiffLine { t, text: text.strip_suffix('\r').unwrap_or(text).to_string() });
        }
    }
    if have {
        match cur_path {
            Some(p) => {
                map.insert(p, cur);
            }
            None => unparsed = true,
        }
    }
    (map, unparsed)
}

/// `git diff` 한 판. 캡 초과(`over`)와 그냥 실패를 **가른다** — 캡 초과는 목록을 갈라
/// 다시 부르면 되지만, 실패(HEAD 없음 등)는 갈라도 똑같이 실패하기 때문이다.
enum DiffOut {
    Ok(std::collections::HashMap<String, Patch>, bool),
    /// stdout이 32MB를 넘어 잘렸다 — 목록을 반으로 갈라 다시 부를 자리.
    Over,
    Failed,
}

fn diff_once(root: &Path, paths: Option<&[String]>) -> DiffOut {
    let mut args: Vec<&str> = vec![
        // 한글 경로를 `\355\225\234`로 escape하지 않게 — 그러면 경로가 안 맞는다(실측)
        "-c",
        "core.quotePath=false",
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-renames",
        "-U0",
        "HEAD",
    ];
    if let Some(ps) = paths {
        args.push("--");
        args.extend(ps.iter().map(String::as_str));
    }
    let r = exec(root, &args);
    if r.ok {
        let (m, u) = parse_bulk_patch(&r.stdout);
        DiffOut::Ok(m, u)
    } else if r.over {
        DiffOut::Over
    } else {
        DiffOut::Failed
    }
}

/// 경로를 담아 부르되, argv 예산이나 32MB 캡에 걸리면 목록을 **반으로 갈라** 다시 부른다.
/// 스폰 수는 파일 수가 아니라 `log`로 는다(600파일·45MB = 2회). false면 호출부가 옛길로.
fn diff_into(
    root: &Path,
    files: &[String],
    map: &mut std::collections::HashMap<String, Patch>,
    unparsed: &mut bool,
) -> bool {
    if files.is_empty() {
        return true;
    }
    let total: usize = files.iter().map(|f| f.len() + 1).sum();
    if total <= ARGV_PATHSPEC_BUDGET && files.iter().all(|f| !f.is_empty()) {
        match diff_once(root, Some(files)) {
            DiffOut::Ok(m, u) => {
                for (k, v) in m {
                    map.entry(k).or_insert(v);
                }
                *unparsed |= u;
                return true;
            }
            // 파일 **하나**가 혼자 32MB를 넘겼다 — 더 못 가른다. 옛길이 사유를 낸다.
            DiffOut::Over if files.len() == 1 => return false,
            DiffOut::Over => {}
            DiffOut::Failed => return false,
        }
    }
    let mid = files.len() / 2;
    if mid == 0 {
        return false;
    }
    diff_into(root, &files[..mid], map, unparsed) && diff_into(root, &files[mid..], map, unparsed)
}

/// HEAD가 없는 저장소(첫 커밋 전)의 답 — **옛 쪽이 통째로 비어 있다**는 뜻이라
/// git을 부를 것이 없다. `file_diff`가 `show HEAD:<rel>` 실패 → `cat-file -e` 실패로
/// 도달하는 것과 **같은 결론**을 스폰 0회로 낸다(파일당 2스폰을 아낀다).
fn unborn_file_diff(root: &Path, rel: &str) -> GitFileDiffResult {
    let Some(abs) = abs_of(root, rel) else {
        return GitFileDiffResult {
            error: Some(crate::t("잘못된 경로", "Invalid path")),
            ..Default::default()
        };
    };
    match std::fs::read(&abs).ok().map(|b| String::from_utf8_lossy(&b).into_owned()) {
        Some(t) => build_file_diff(rel, None, Some(&t)),
        None => GitFileDiffResult {
            error: Some(crate::t("내용을 읽을 수 없어요", "Could not read the contents")),
            ..Default::default()
        },
    }
}

fn untracked_set(root: &Path) -> std::collections::HashSet<String> {
    // `-z`면 인용이 아예 없다(NUL 구분) — 한글·공백 경로가 그대로 온다.
    let r = exec(root, &["ls-files", "-z", "--others", "--exclude-standard"]);
    if !r.ok {
        return std::collections::HashSet::new();
    }
    r.stdout.split('\0').filter(|s| !s.is_empty()).map(str::to_string).collect()
}

fn patch_to_result(rel: &str, p: Patch) -> GitFileDiffResult {
    if p.binary {
        return GitFileDiffResult {
            error: Some(crate::t("바이너리 파일 — diff를 표시할 수 없어요", "Binary file — cannot show a diff")),
            ..Default::default()
        };
    }
    GitFileDiffResult {
        diff: Some(FileDiff {
            path: rel.to_string(),
            tag: if p.new_file { "new" } else { "edit" },
            add: p.add,
            del: p.del,
            lines: p.lines,
        }),
        ..Default::default()
    }
}

/// 고른 파일들의 워킹트리 diff를 **git 스폰 1~2회**로 모은다(AI 커밋 메시지용).
///
/// 반환은 `files`와 **같은 순서·같은 길이**다. `file_diff`와 다른 점 하나:
/// 담기는 줄이 **변경 줄뿐**이라(ctx 없음) 뷰어 계약("전체 파일")에는 못 쓴다.
/// 그 대신 프롬프트에 들어가는 것과 정확히 같은 것만 만들고, 1.5MB 초과라는 이유로
/// 본문을 통째로 접지 않는다(한 줄 고친 2MB 파일도 그 한 줄이 그대로 나온다).
///
/// 못 믿을 자리를 만나면 되돌아가는데, **되돌아가는 단위가 다르다**:
/// · 배치 전체 — git 실패(unborn·캡 초과를 갈라도 안 되는 자리).
/// · 그 파일만 — C 인용 경로·중복 경로·디스크에 없는 경로.
pub fn bulk_file_diffs(cwd: &str, files: &[String]) -> Vec<GitFileDiffResult> {
    if files.is_empty() {
        return Vec::new();
    }
    let Some(root) = repo_root(cwd) else {
        return files
            .iter()
            .map(|_| GitFileDiffResult { error: Some(e_not_repo()), ..Default::default() })
            .collect();
    };
    let root_s = root.to_string_lossy().to_string();
    let total: usize = files.iter().map(|f| f.len() + 1).sum();
    let fits_argv = total <= ARGV_PATHSPEC_BUDGET && files.iter().all(|f| !f.is_empty());
    // 1차 — 스폰 한 번. 담기면 고른 것만, 아니면 경로 없이 전 트리.
    let (mut map, unparsed) = match diff_once(&root, if fits_argv { Some(files) } else { None }) {
        DiffOut::Ok(m, u) => (m, u),
        other => {
            // HEAD가 없다(첫 커밋 전) — 갈라도 계속 실패한다. 디스크에서 바로 답한다.
            if matches!(other, DiffOut::Failed)
                && !exec(&root, &["rev-parse", "--verify", "--quiet", "HEAD"]).ok
            {
                return files.iter().map(|f| unborn_file_diff(&root, f)).collect();
            }
            // 캡 초과(전 트리가 45MB더라) — 목록을 갈라 다시. 그래도 안 되면 옛길.
            let mut m = std::collections::HashMap::new();
            let mut u = false;
            if !diff_into(&root, files, &mut m, &mut u) {
                return files.iter().map(|f| file_diff(&root_s, f)).collect();
            }
            (m, u)
        }
    };
    let mut untracked: Option<std::collections::HashSet<String>> = None;
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let mut out: Vec<GitFileDiffResult> = Vec::with_capacity(files.len());
    for rel in files {
        // 같은 경로가 두 번 오면(중복 선택) 두 번째는 옛길로 — 지도에서 이미 꺼냈다.
        if !seen.insert(rel.as_str()) {
            out.push(file_diff(&root_s, rel));
            continue;
        }
        if let Some(p) = map.remove(rel.as_str()) {
            out.push(patch_to_result(rel, p));
            continue;
        }
        // diff에 없다 = 미추적(새 파일)이거나 · 안 바뀌었거나 · 없는 경로다.
        let set = untracked.get_or_insert_with(|| untracked_set(&root));
        if set.contains(rel.as_str()) {
            let text = abs_of(&root, rel)
                .and_then(|abs| std::fs::read(&abs).ok())
                .map(|b| String::from_utf8_lossy(&b).into_owned());
            out.push(match text {
                Some(t) => build_file_diff(rel, None, Some(&t)),
                None => GitFileDiffResult {
                    error: Some(crate::t("내용을 읽을 수 없어요", "Could not read the contents")),
                    ..Default::default()
                },
            });
            continue;
        }
        // ★ `is_file()`이다 — `exists()`가 아니다. status는 미추적 **폴더**를 한 줄로 접어
        //   `새 폴더/`로 준다(그 행이 그대로 여기 온다). 폴더는 `ls-files --others`에도
        //   `git diff`에도 절대 안 실리므로 `exists()`로 보면 "추적 중인데 diff가 없다"로
        //   읽혀 **`+0 −0`("안 바뀌었다")이라는 거짓말**이 나갔다(R1 확인 크리틱 실측).
        //   옛길(`file_diff`)은 그 자리에서 "내용을 읽을 수 없어요"를 낸다 — 거기로 보낸다.
        let on_disk = abs_of(&root, rel).map(|p| p.is_file()).unwrap_or(false);
        if on_disk && !unparsed {
            // 추적 중인데 diff가 없다 = 안 바뀌었다. 변경 줄 0이 정확한 답이다.
            out.push(GitFileDiffResult {
                diff: Some(FileDiff { path: rel.clone(), tag: "edit", add: 0, del: 0, lines: Vec::new() }),
                ..Default::default()
            });
        } else {
            out.push(file_diff(&root_s, rel));
        }
    }
    out
}

fn valid_hash(hash: &str) -> bool {
    (4..=40).contains(&hash.len()) && hash.chars().all(|c| c.is_ascii_hexdigit())
}

/// 커밋 상세 — 메타(제목·본문·작성자·시각) + 바뀐 파일 목록(상태).
pub fn commit_detail(cwd: &str, hash: &str) -> Option<GitCommitDetail> {
    let root = repo_root(cwd)?;
    if !valid_hash(hash) {
        return None;
    }
    // 제목(`%s`)을 **마지막 칸**에 두고 본문(`%b`)은 따로 받는다. 한 줄에 둘 다 담으면
    // 제목에 섞인 `\x1f` 하나가 본문 칸을 밀어 버린다(크리틱 §7 R-4). git 왕복 한 번은
    // 카드 클릭 한 번짜리 비용이라 정확도와 바꿀 값이 아니다.
    let fmt = format!("--pretty=format:%H{FS}%h{FS}%an{FS}%at{FS}%s");
    let meta = exec(&root, &["log", "-1", fmt.as_str(), hash]);
    if !meta.ok {
        return None;
    }
    let body = exec(&root, &["log", "-1", "--pretty=format:%b", hash]);
    // -z: 상태와 경로가 NUL로 번갈아 온다 (R/C는 status·old·new 3연속)
    let names = exec(&root, &["show", "--name-status", "--format=", "-z", hash]);
    let f: Vec<&str> = meta.stdout.splitn(5, FS).collect();
    let g = |i: usize| f.get(i).copied().unwrap_or("");
    let mut files: Vec<GitCommitFile> = Vec::new();
    if names.ok {
        let toks: Vec<&str> = names.stdout.split('\0').collect();
        let mut i = 0usize;
        while i < toks.len() {
            let st = toks[i];
            i += 1;
            if st.is_empty() {
                continue;
            }
            let c = st.chars().next().unwrap_or(' ');
            if c == 'R' || c == 'C' {
                let from = toks.get(i).copied().unwrap_or("");
                let to = toks.get(i + 1).copied().unwrap_or("");
                i += 2;
                if !to.is_empty() {
                    files.push(GitCommitFile {
                        path: to.to_string(),
                        status: "R",
                        renamed_from: Some(from.to_string()),
                    });
                }
            } else {
                let p = toks.get(i).copied().unwrap_or("");
                i += 1;
                if !p.is_empty() {
                    files.push(GitCommitFile {
                        path: p.to_string(),
                        status: match c {
                            'A' => "A",
                            'D' => "D",
                            _ => "M",
                        },
                        renamed_from: None,
                    });
                }
            }
        }
    }
    Some(GitCommitDetail {
        hash: g(0).to_string(),
        short_hash: g(1).to_string(),
        author: g(2).to_string(),
        time: g(3).parse().unwrap_or(0),
        subject: g(4).to_string(),
        body: if body.ok { body.stdout.trim().to_string() } else { String::new() },
        files,
    })
}

/// 커밋 시점 파일 — 뷰어 override용: 그 시점 내용 + 부모 대비 diff. 삭제 파일은 내용 ''.
pub fn commit_file_diff(cwd: &str, hash: &str, rel: &str) -> GitFileDiffResult {
    let bad = || GitFileDiffResult { error: Some(e_not_repo()), ..Default::default() };
    let Some(root) = repo_root(cwd) else { return bad() };
    if !valid_hash(hash) {
        return bad();
    }
    let base = show_at(&root, &format!("{hash}^"), rel);
    let cur = show_at(&root, hash, rel);
    // 어느 쪽이든 캡/읽기 실패면 사유를 그대로 준다 — "새 파일"·"빈 파일"로 안 꾸민다.
    if let Some(why) = base.fold_reason().or_else(|| cur.fold_reason()) {
        return GitFileDiffResult { error: Some(why), ..Default::default() };
    }
    let mut d = build_file_diff(rel, base.text(), Some(cur.text().unwrap_or("")));
    d.content = Some(match cur {
        Blob::Text(s) => s,
        _ => String::new(),
    });
    d
}

// ── 쓰기 동작 — 전부 {ok, error} 한 모양 ────────────────────────────────────

/// 경로 목록 → `--pathspec-file-nul`이 읽는 바이트(NUL 구분). 경로에 NUL은 들어갈 수
/// 없으므로 개행·공백·한글이 섞여도 구분이 안 흔들린다.
fn nul_pathspec(paths: &[&str]) -> Vec<u8> {
    let mut b: Vec<u8> = Vec::with_capacity(paths.iter().map(|p| p.len() + 1).sum());
    for p in paths {
        b.extend_from_slice(p.as_bytes());
        b.push(0);
    }
    b
}

/// 고른 파일만 커밋 — add(그 경로만) 후 commit. 스테이징 용어는 UI에 없다.
///
/// **경로도 메시지도 argv로 안 나간다.** 2.6.2(`src/main/git.ts` `gitCommit`)와 3.0 R1은
/// 고른 파일 전부를 명령줄 인자로 넘겼고, Windows `CreateProcess`의 32,767자 한계에
/// 걸리면 **스폰 자체가 실패**했다(사용자 보고: "파일 개수가 너무 많으면 안 된다").
/// 이제 add·reset은 `--pathspec-from-file=- --pathspec-file-nul`로, 메시지는 `commit -F -`로
/// stdin을 탄다 — 파일 수·경로 길이·본문 길이 어느 것도 한계가 없다.
pub fn commit(cwd: &str, files: &[String], subject: &str, body: &str) -> GitResult {
    let Some(root) = repo_root(cwd) else { return GitResult::err(e_not_repo()) };
    // ★ 빈 경로는 버린다. 그리고 **하나도 안 남으면 여기서 끝낸다** — 빈 목록을 stdin으로
    //   주면 git은 "경로 제한 없음"으로 읽어 `add -A`가 **저장소 전체**를 스테이징한다
    //   (실측: 고르지 않은 파일까지 `A`로 올라왔고, 롤백 reset도 전부를 내렸다).
    //   argv 시절엔 `git add -A -- ""`가 pathspec 오류로 죽어 우연히 막혀 있던 자리다.
    let picked: Vec<&str> = files.iter().map(String::as_str).filter(|s| !s.is_empty()).collect();
    if picked.is_empty() {
        return GitResult::err(crate::t("커밋할 파일이 없어요", "No files to commit"));
    }
    if subject.trim().is_empty() {
        return GitResult::err(crate::t("커밋 메시지를 입력해 주세요", "Enter a commit message"));
    }
    let spec = nul_pathspec(&picked);
    let add_args = ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"];
    let add = exec_stdin(&root, &add_args, &spec);
    if !add.ok {
        return GitResult::err(err_line(&add.stderr, &add.stdout));
    }
    let subj = subject.trim();
    let bod = body.trim();
    // `-m subj -m bod`가 만들던 것과 같은 본문(제목·빈 줄·본문). `-F -`도 `-m`과 같은
    // 정리 규칙(cleanup=whitespace)을 탄다 — `#`로 시작하는 줄이 잘리지 않는다.
    let msg = if bod.is_empty() { format!("{subj}\n") } else { format!("{subj}\n\n{bod}\n") };
    let r = exec_stdin(&root, &["commit", "-F", "-"], msg.as_bytes());
    if r.ok {
        return GitResult::ok();
    }
    // 커밋이 거부되면(훅·identity 미설정 등) 방금 올린 스테이징을 되돌려 상태를 원래대로
    let reset_args = ["reset", "--pathspec-from-file=-", "--pathspec-file-nul"];
    let _ = exec_stdin(&root, &reset_args, &spec);
    let e = format!("{}{}", r.stderr, r.stdout);
    let low = e.to_lowercase();
    if low.contains("user.name") || low.contains("user.email") {
        return GitResult::err(crate::t(
            "git 사용자 정보가 없어요 — 터미널에서 git config --global user.name / user.email을 설정해 주세요",
            "Git identity is not set — run git config --global user.name / user.email in a terminal",
        ));
    }
    // "바뀐 게 없다"는 git이 stdout에 쓰고 첫 줄이 `On branch main`이라, 폴백이 그
    // **브랜치 이름을 오류 문구로** 띄웠다(크리틱 §S8 실측). 사유를 사람 말로 돌려준다.
    if low.contains("nothing to commit")
        || low.contains("nothing added to commit")
        || low.contains("no changes added to commit")
        || low.contains("커밋할 사항 없음")
        || low.contains("추가하지 않은 변경 사항")
    {
        return GitResult::err(crate::t("바뀐 내용이 없어요", "There is nothing to commit"));
    }
    GitResult::err(err_line(&r.stderr, &r.stdout))
}

pub fn push(cwd: &str) -> GitResult {
    let Some(root) = repo_root(cwd) else { return GitResult::err(e_not_repo()) };
    let st = status_at(&root);
    if !st.has_remote {
        return GitResult::err(crate::t(
            "원격 저장소(remote)가 없어요 — git remote add origin <url> 후 다시",
            "No remote configured — run git remote add origin <url> and try again",
        ));
    }
    // 업스트림이 없으면 첫 푸시 — origin에 현재 브랜치를 만든다
    let args: Vec<&str> = if st.upstream.is_some() { vec!["push"] } else { vec!["push", "-u", "origin", "HEAD"] };
    let r = exec(&root, &args);
    if r.ok { GitResult::ok() } else { GitResult::err(err_line(&r.stderr, &r.stdout)) }
}

pub fn pull(cwd: &str) -> GitResult {
    let Some(root) = repo_root(cwd) else { return GitResult::err(e_not_repo()) };
    let r = exec(&root, &["pull"]);
    if r.ok {
        return GitResult::ok();
    }
    let e = format!("{}{}", r.stderr, r.stdout);
    if e.to_uppercase().contains("CONFLICT") {
        return GitResult::err(crate::t(
            "병합 충돌이 났어요 — 충돌 파일을 정리한 뒤 커밋해 주세요",
            "Merge conflict — resolve the conflicted files, then commit",
        ));
    }
    GitResult::err(err_line(&r.stderr, &r.stdout))
}

pub fn fetch(cwd: &str) -> GitResult {
    let Some(root) = repo_root(cwd) else { return GitResult::err(e_not_repo()) };
    let r = exec(&root, &["fetch", "--prune"]);
    if r.ok { GitResult::ok() } else { GitResult::err(err_line(&r.stderr, &r.stdout)) }
}

/// 파일 하나 되돌리기 — 추적 파일은 HEAD로, 새(미추적) 파일은 휴지통으로(복구 가능).
/// 한 행 되돌리기. **파괴 반경이 가장 넓은 채널**이라 가드가 세 겹이다:
///
/// 1. **저장소 뿌리(`.`·``)는 거절** — `abs_of`는 `resolve_lexical(root, ".") == root`를
///    통과시키므로 R1에서는 `discard(cwd, ".", untracked=true)`가 저장소 폴더를 통째로
///    휴지통에 넣었다(크리틱 §S6 실측 `repo_still_there:false`). 렌더러는 `f.path`만
///    보내서 제품에서는 도달 불가지만, 채널은 렌더러만 부르는 게 아니다.
/// 2. **`.git`은 거절** — 메타데이터를 지우면 저장소가 죽는다. 되돌리기의 뜻이 아니다.
/// 3. **인덱스는 파일이 실제로 휴지통에 들어간 뒤에만 만진다** — R1은 순서가 반대라
///    잠긴 파일에서 `rm --cached`만 성공하고 휴지통이 실패해 **파일은 그대로인데
///    인덱스에서만 사라진** 유령 두 행(`D:` + `A:`)을 남겼다(§S4).
///
/// 그리고 checkout 실패를 무조건 "HEAD에 없던 새 파일"로 읽지 않는다 — HEAD에 **있는데**
/// 잠겨서 실패한 파일까지 휴지통으로 보내던 자리다(§S4의 진짜 뿌리).
pub fn discard(cwd: &str, rel: &str, untracked: bool) -> GitResult {
    let Some(root) = repo_root(cwd) else { return GitResult::err(e_not_repo()) };
    let Some(abs) = abs_of(&root, rel) else {
        return GitResult::err(crate::t("잘못된 경로", "Invalid path"));
    };
    let bad_path = || crate::t("잘못된 경로", "Invalid path");
    if abs == root {
        // 저장소 폴더 자체 — 되돌리기가 아니라 저장소 삭제다.
        return GitResult::err(bad_path());
    }
    // 루트 **아래**의 조각만 본다 — 저장소 경로 자체에 `.git`이 들어 있는 배치
    // (워크트리·서브모듈)에서 멀쩡한 되돌리기가 막히면 안 된다.
    if abs
        .strip_prefix(&root)
        .map(|r| r.components().any(|c| c.as_os_str().eq_ignore_ascii_case(".git")))
        .unwrap_or(true)
    {
        return GitResult::err(bad_path());
    }
    let trash_fail =
        || crate::t("파일을 휴지통으로 보내지 못했어요", "Could not move the file to the recycle bin");
    let to_trash = || match crate::file::delete_path("", abs.to_string_lossy().as_ref()) {
        r if r.ok => None,
        r => Some(r.error.unwrap_or_else(trash_fail)),
    };
    if untracked {
        return match to_trash() {
            None => GitResult::ok(),
            Some(e) => GitResult::err(e),
        };
    }
    // index에 올라가 있어도(A 포함) 한 번에 HEAD 상태로 — 스테이징·워크트리 모두 복원
    let r = exec(&root, &["checkout", "HEAD", "--", rel]);
    if r.ok {
        return GitResult::ok();
    }
    // checkout이 실패했다. **왜인지**를 git에 직접 묻는다 — "HEAD에 없다"가 아니면
    // (잠김·권한 등) 아무것도 지우지 않고 사유를 그대로 돌려준다.
    if matches!(show_at(&root, "HEAD", rel), Blob::Absent) {
        // HEAD에 없던(새로 add된) 파일 — **휴지통 먼저**, 성공했을 때만 스테이징 해제.
        if let Some(e) = to_trash() {
            return GitResult::err(e); // 인덱스는 안 건드렸다 = 유령 행 없음
        }
        let rm = exec(&root, &["rm", "--cached", "-f", "--ignore-unmatch", "--", rel]);
        return if rm.ok { GitResult::ok() } else { GitResult::err(err_line(&rm.stderr, &rm.stdout)) };
    }
    GitResult::err(err_line(&r.stderr, &r.stdout))
}

pub fn branches(cwd: &str) -> Vec<GitBranch> {
    let Some(root) = repo_root(cwd) else { return Vec::new() };
    let fmt = format!("--format=%(refname:short){FS}%(HEAD){FS}%(committerdate:unix)");
    let r = exec(&root, &["for-each-ref", "refs/heads", "--sort=-committerdate", fmt.as_str()]);
    if !r.ok {
        return Vec::new();
    }
    r.stdout
        .lines()
        .filter(|l| l.contains(FS))
        .map(|l| {
            let f: Vec<&str> = l.split(FS).collect();
            GitBranch {
                name: f.first().copied().unwrap_or("").to_string(),
                current: f.get(1).copied().unwrap_or("") == "*",
                time: f.get(2).copied().unwrap_or("").trim().parse().unwrap_or(0),
            }
        })
        .collect()
}

pub fn switch_branch(cwd: &str, name: &str) -> GitResult {
    let Some(root) = repo_root(cwd) else { return GitResult::err(e_not_repo()) };
    let r = exec(&root, &["switch", name]);
    if r.ok {
        return GitResult::ok();
    }
    let e = format!("{}{}", r.stderr, r.stdout).to_lowercase();
    if e.contains("would be overwritten") || e.contains("충돌") || e.contains("conflict") {
        return GitResult::err(crate::t(
            "지금 변경과 충돌해요 — 커밋하거나 되돌린 뒤 전환해 주세요",
            "Conflicts with your current changes — commit or discard them, then switch",
        ));
    }
    GitResult::err(err_line(&r.stderr, &r.stdout))
}

pub fn create_branch(cwd: &str, name: &str) -> GitResult {
    let Some(root) = repo_root(cwd) else { return GitResult::err(e_not_repo()) };
    let clean = name.trim();
    if clean.is_empty() {
        return GitResult::err(crate::t("브랜치 이름을 입력해 주세요", "Enter a branch name"));
    }
    let chk = exec(&root, &["check-ref-format", "--branch", clean]);
    if !chk.ok {
        return GitResult::err(crate::t("브랜치 이름으로 쓸 수 없는 형식이에요", "Not a valid branch name"));
    }
    let r = exec(&root, &["switch", "-c", clean]);
    if r.ok { GitResult::ok() } else { GitResult::err(err_line(&r.stderr, &r.stdout)) }
}

// ── 격리 레포 테스트 ────────────────────────────────────────────────────────
//
// 사용자의 실 레포를 절대 안 만진다: 매 테스트가 temp에 `git init`으로 자기 레포를
// 만들고, user.name/email·기본 브랜치도 그 레포 안에서만 설정한다(--global 금지).
#[cfg(test)]
mod tests {
    use super::*;

    /// 테스트마다 **자기만의** temp 폴더. 이름에 시각+카운터를 넣어, 지난 실행의
    /// 잔해(.git의 object는 읽기 전용이라 지워지지 않을 때가 있다)와 절대 안 겹친다.
    fn scratch(tag: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let n = N.fetch_add(1, Ordering::SeqCst);
        let ns = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let d = std::env::temp_dir().join(format!("ccg-fs-git-{tag}-{}-{ns}-{n}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// 이 환경에 git이 있나 — 없으면 테스트를 건너뛴다(크레이트의 git 기능 자체가
    /// 안 도는 환경이라 실패로 보고해봐야 정보가 없다).
    fn have_git() -> bool {
        std::process::Command::new("git")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    struct Repo(PathBuf);
    impl Repo {
        fn new(tag: &str) -> Option<Repo> {
            if !have_git() {
                return None;
            }
            let r = Repo(scratch(tag));
            r.git(&["init", "-q"]);
            if !r.0.join(".git").exists() {
                return None;
            }
            // 전부 **이 레포 안에서만** — `--global`은 절대 안 쓴다(사용자 config 불가침)
            r.git(&["config", "user.email", "t@example.com"]);
            r.git(&["config", "user.name", "T"]);
            r.git(&["config", "commit.gpgsign", "false"]);
            r.git(&["config", "core.autocrlf", "false"]);
            // unborn HEAD에서도 확실히 먹는 브랜치 지정(기본이 master인 git도 있다)
            r.git(&["symbolic-ref", "HEAD", "refs/heads/main"]);
            Some(r)
        }
        fn git(&self, args: &[&str]) -> Out {
            exec(&self.0, args)
        }
        fn cwd(&self) -> &str {
            self.0.to_str().unwrap()
        }
        fn write(&self, rel: &str, body: &str) {
            let p = self.0.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, body).unwrap();
        }
    }
    impl Drop for Repo {
        fn drop(&mut self) {
            // .git/objects는 읽기 전용이라 한 번에 안 지워질 수 있다 — 지우기 전에 푼다
            fn unlock(dir: &Path) {
                let Ok(read) = std::fs::read_dir(dir) else { return };
                for e in read.flatten() {
                    let p = e.path();
                    if p.is_dir() {
                        unlock(&p);
                    } else if let Ok(m) = std::fs::metadata(&p) {
                        let mut perm = m.permissions();
                        #[allow(clippy::permissions_set_readonly_false)]
                        perm.set_readonly(false);
                        let _ = std::fs::set_permissions(&p, perm);
                    }
                }
            }
            unlock(&self.0);
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    macro_rules! repo {
        ($tag:expr) => {
            match Repo::new($tag) {
                Some(r) => r,
                None => {
                    eprintln!("[skip] git 미설치 — {} 건너뜀", $tag);
                    return;
                }
            }
        };
    }

    #[test]
    fn a_plain_folder_is_not_a_repo() {
        let d = scratch("plain");
        let st = status(d.to_str().unwrap());
        assert!(!st.repo, "저장소가 아니면 스트립 자체를 안 그린다");
        assert!(!status("").repo);
        assert!(repos("").is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn status_reports_branch_untracked_modified_and_deleted() {
        let r = repo!("status");
        r.write("a.txt", "one\ntwo\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-qm", "init"]);
        r.write("a.txt", "one\nTWO\n");
        r.write("new.txt", "n");
        std::fs::write(r.0.join("gone.txt"), "g").unwrap();
        r.git(&["add", "gone.txt"]);
        r.git(&["commit", "-qm", "add gone"]);
        std::fs::remove_file(r.0.join("gone.txt")).unwrap();

        let st = status(r.cwd());
        assert!(st.repo);
        assert_eq!(st.branch, "main");
        assert!(!st.detached);
        assert!(!st.has_remote, "remote 없으면 push/pull 버튼을 접는다");
        let by = |p: &str| st.files.iter().find(|f| f.path == p).cloned();
        assert_eq!(by("a.txt").unwrap().status, "M");
        let n = by("new.txt").unwrap();
        assert_eq!((n.status, n.untracked), ("A", Some(true)));
        assert_eq!(by("gone.txt").unwrap().status, "D");
        // 정렬: 대소문자 무시 경로순
        let paths: Vec<&str> = st.files.iter().map(|f| f.path.as_str()).collect();
        let mut sorted = paths.clone();
        sorted.sort_by_key(|p| p.to_lowercase());
        assert_eq!(paths, sorted);
    }

    /// `-z` 파싱이 공백·한글을 깨면 탐색기 스트립의 파일 이름이 통째로 망가진다.
    /// (기본 `git status`는 미추적 **폴더**를 접어 보고하므로 루트에 바로 만든다)
    #[test]
    fn status_carries_hangul_and_spaced_paths_intact() {
        let r = repo!("hangul");
        r.write("한글 이름.txt", "가\n");
        r.write("seed.txt", "s\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-qm", "init"]);
        r.write("한글 이름.txt", "나\n");
        let st = status(r.cwd());
        assert!(
            st.files.iter().any(|f| f.path == "한글 이름.txt"),
            "공백/한글 경로가 그대로 와야 한다: {:?}",
            st.files.iter().map(|f| &f.path).collect::<Vec<_>>()
        );
        // 그 경로로 diff까지 이어져야 실제로 쓸 수 있는 것이다
        assert!(file_diff(r.cwd(), "한글 이름.txt").diff.is_some());
    }

    #[test]
    fn rename_keeps_the_original_path() {
        let r = repo!("rename");
        r.write("old.txt", "same content here\nline two\nline three\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-qm", "init"]);
        r.git(&["mv", "old.txt", "new.txt"]);
        let st = status(r.cwd());
        let f = st.files.iter().find(|f| f.path == "new.txt").expect("개명 항목");
        assert_eq!(f.status, "R");
        assert_eq!(f.renamed_from.as_deref(), Some("old.txt"));
    }

    #[test]
    fn detached_head_says_so_instead_of_showing_a_hash() {
        let r = repo!("detached");
        r.write("a.txt", "1\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-qm", "init"]);
        let head = r.git(&["rev-parse", "HEAD"]).stdout.trim().to_string();
        r.git(&["checkout", "-q", &head]);
        let st = status(r.cwd());
        assert!(st.detached);
        assert!(!st.branch.contains(&head[..6]));
    }

    #[test]
    fn log_pages_with_limit_plus_one_and_marks_unpushed() {
        let r = repo!("log");
        for i in 0..5 {
            r.write("a.txt", &format!("v{i}\n"));
            r.git(&["add", "."]);
            r.git(&["commit", "-qm", &format!("c{i}")]);
        }
        let first = log(r.cwd(), 2, 0);
        assert_eq!(first.commits.len(), 2);
        assert!(first.has_more);
        assert_eq!(first.commits[0].subject, "c4");
        assert_eq!(first.commits[0].author, "T");
        assert!(first.commits[0].time > 0);
        let last = log(r.cwd(), 2, 4);
        assert_eq!(last.commits.len(), 1);
        assert!(!last.has_more);
        // 업스트림이 없으니 unpushed 점은 안 켠다(2.6.2 규약)
        assert!(first.commits.iter().all(|c| !c.unpushed));
        // refs 장식에서 HEAD-> 는 벗겨진다
        assert!(first.commits[0].refs.iter().all(|s| !s.starts_with("HEAD")));
        assert!(first.commits[0].refs.iter().any(|s| s == "main"));
    }

    #[test]
    fn working_tree_diff_is_a_whole_file_diff() {
        let r = repo!("diff");
        r.write("a.txt", "one\ntwo\nthree\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-qm", "init"]);
        r.write("a.txt", "one\nTWO\nthree\n");
        let d = file_diff(r.cwd(), "a.txt");
        let fd = d.diff.expect("diff");
        assert_eq!((fd.add, fd.del, fd.tag), (1, 1, "edit"));
        assert_eq!(fd.lines.len(), 4, "전체 파일 — 컨텍스트 3 + 변경 2 중 ctx 2");
    }

    #[test]
    fn an_untracked_file_diffs_as_a_brand_new_file() {
        let r = repo!("newfile");
        r.write("seed.txt", "s\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-qm", "init"]);
        r.write("fresh.txt", "a\nb\n");
        let fd = file_diff(r.cwd(), "fresh.txt").diff.expect("diff");
        assert_eq!((fd.tag, fd.add, fd.del), ("new", 2, 0));
        assert_eq!(fd.lines[0].t, "hunk");
    }

    #[test]
    fn a_deleted_file_carries_its_head_snapshot() {
        let r = repo!("deleted");
        r.write("bye.txt", "keep me\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-qm", "init"]);
        std::fs::remove_file(r.0.join("bye.txt")).unwrap();
        let d = file_diff(r.cwd(), "bye.txt");
        assert_eq!(d.head_content.as_deref(), Some("keep me\n"), "되돌리기 전에 뭘 잃는지 보여준다");
        assert_eq!(d.diff.unwrap().del, 1);
    }

    /// ★ diff 캡 — 2.6.2에서 메인 프로세스를 죽인 자리. 1.5MB 초과·바이너리는
    /// **diff를 접고 사유를 준다**(크래시도, 빈 화면도 아니다).
    #[test]
    fn oversize_and_binary_files_fold_the_diff_with_a_reason() {
        let r = repo!("cap");
        let big = "x".repeat(MAX_DIFF_BYTES + 10) + "\n";
        r.write("big.txt", &big);
        r.write("bin.dat", "head\u{0}tail");
        r.git(&["add", "."]);
        r.git(&["commit", "-qm", "init"]);
        r.write("big.txt", &(big + "y\n"));
        r.write("bin.dat", "head\u{0}TAIL");

        let d = file_diff(r.cwd(), "big.txt");
        assert!(d.diff.is_none() && d.error.is_some(), "1.5MB 초과는 접는다");
        let b = file_diff(r.cwd(), "bin.dat");
        assert!(b.diff.is_none() && b.error.is_some(), "바이너리는 접는다");
    }

    /// 수천 줄 파일 + 수백 곳 변경 = **접지 않고 정확히** 나와야 한다.
    /// (D = 1000 ≤ MAX_D 2000 — 캡은 그 위에서만 작동한다)
    #[test]
    fn a_big_file_with_hundreds_of_scattered_edits_stays_exact() {
        let r = repo!("bigdiff");
        let a: String = (0..8000).map(|i| format!("line {i}\n")).collect();
        r.write("big.rs", &a);
        r.git(&["add", "."]);
        r.git(&["commit", "-qm", "init"]);
        let b: String = (0..8000)
            .map(|i| if i % 16 == 0 { format!("line {i} CHANGED\n") } else { format!("line {i}\n") })
            .collect();
        r.write("big.rs", &b);
        let fd = file_diff(r.cwd(), "big.rs").diff.expect("이 규모는 정확한 diff가 나와야 한다");
        assert_eq!((fd.add, fd.del), (500, 500));
        assert_eq!(fd.lines.len(), 8500);
    }

    /// D 상한을 넘는 규모(전 줄 교체)는 **폴백**으로 내려앉는다 — 크래시도, 빈 화면도
    /// 아니고 "전부 삭제 + 전부 추가"라는 정직한 표시다.
    #[test]
    fn a_wholesale_rewrite_falls_back_without_crashing() {
        let r = repo!("rewrite");
        let a: String = (0..8000).map(|i| format!("old {i}\n")).collect();
        r.write("big.rs", &a);
        r.git(&["add", "."]);
        r.git(&["commit", "-qm", "init"]);
        let b: String = (0..8000).map(|i| format!("new {i}\n")).collect();
        r.write("big.rs", &b);
        let fd = file_diff(r.cwd(), "big.rs").diff.expect("폴백도 diff는 나온다");
        assert_eq!((fd.add, fd.del), (8000, 8000));
        assert_eq!(fd.lines.len(), 16000);
    }

    #[test]
    fn commit_detail_lists_the_changed_files() {
        let r = repo!("detail");
        r.write("a.txt", "1\n");
        r.write("b.txt", "2\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-qm", "subject line\n\nbody line one\nbody line two"]);
        let hash = r.git(&["rev-parse", "HEAD"]).stdout.trim().to_string();
        let d = commit_detail(r.cwd(), &hash).expect("detail");
        assert_eq!(d.subject, "subject line");
        assert!(d.body.contains("body line one"));
        assert_eq!(d.files.len(), 2);
        assert!(d.files.iter().all(|f| f.status == "A"));
        assert!(commit_detail(r.cwd(), "zzzz").is_none(), "해시 형식 검증");
    }

    #[test]
    fn commit_file_diff_gives_the_snapshot_and_the_parent_delta() {
        let r = repo!("snapshot");
        r.write("a.txt", "one\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-qm", "c1"]);
        r.write("a.txt", "one\ntwo\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-qm", "c2"]);
        let hash = r.git(&["rev-parse", "HEAD"]).stdout.trim().to_string();
        let d = commit_file_diff(r.cwd(), &hash, "a.txt");
        assert_eq!(d.content.as_deref(), Some("one\ntwo\n"));
        assert_eq!(d.diff.unwrap().add, 1);
    }

    #[test]
    fn commit_stages_only_the_chosen_files() {
        let r = repo!("commit");
        r.write("keep.txt", "k\n");
        r.write("skip.txt", "s\n");
        let res = commit(r.cwd(), &["keep.txt".to_string()], "  first  ", " body ");
        assert!(res.ok, "{:?}", res.error);
        let st = status(r.cwd());
        assert_eq!(st.files.len(), 1);
        assert_eq!(st.files[0].path, "skip.txt", "고르지 않은 파일은 그대로 남는다");
        let l = log(r.cwd(), 5, 0);
        assert_eq!(l.commits[0].subject, "first");
    }

    #[test]
    fn commit_refuses_empty_input_without_touching_the_index() {
        let r = repo!("commitguard");
        r.write("a.txt", "a\n");
        assert!(!commit(r.cwd(), &[], "s", "").ok);
        assert!(!commit(r.cwd(), &["a.txt".to_string()], "   ", "").ok);
        assert_eq!(status(r.cwd()).files[0].untracked, Some(true), "index가 안 더러워졌다");
    }

    /// ★ 사용자 보고 「파일 개수가 너무 많으면 커밋이 안 된다」 — 2,000개.
    ///
    /// 같은 목록을 **옛 방식(argv)으로도** 한 번 띄워 본다. Windows 명령줄 한계(32,767자)에
    /// 걸려 실패하는 그 호출이, stdin 방식에서는 스폰 **한 번**으로 통과한다는 것이
    /// 이 라운드가 고친 것의 전부다.
    #[test]
    fn a_two_thousand_file_commit_goes_through_stdin_in_one_spawn() {
        let r = repo!("commit-2000");
        r.write("seed.txt", "s\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-qm", "init"]);
        // 긴 경로 + 한글 + 공백 — 인자 합계가 32K를 확실히 넘게(그게 사고의 조건이다)
        let files: Vec<String> = (0..2000)
            .map(|i| format!("깊은 폴더/nested-{:02}/커밋 대상 파일-{:04}-long-name.txt", i % 40, i))
            .collect();
        for f in &files {
            r.write(f, "한 줄\n");
        }
        r.write("고르지 않은 파일.txt", "남아야 한다\n");
        let argv_len: usize = files.iter().map(|f| f.len() + 1).sum();
        assert!(argv_len > 32_767, "인자 합계 {argv_len} — 한계를 안 넘으면 재현이 아니다");

        // ① 옛길(argv)로 같은 add를 시도 — 이게 사용자가 밟은 실패다
        let mut old_args: Vec<&str> = vec!["add", "-A", "--"];
        old_args.extend(files.iter().map(String::as_str));
        let old = exec(&r.0, &old_args);
        assert!(!old.ok, "argv {argv_len}자가 통과했다 — 재현 조건이 무너졌다");

        // ② 새길(stdin) — 커밋 성공 + git 스폰은 손에 꼽는 수
        let t0 = std::time::Instant::now();
        let before = spawn_count();
        let res = commit(r.cwd(), &files, "대량 커밋", "본문 한 줄");
        let spawns = spawn_count() - before;
        let ms = t0.elapsed().as_millis();
        assert!(res.ok, "{:?}", res.error);
        assert_eq!(spawns, 3, "repo_root + add + commit = 3");
        eprintln!("[측정] 2,000파일 커밋: {ms}ms · git 스폰 {spawns}회 · argv였다면 {argv_len}자");

        let st = status(r.cwd());
        let left: Vec<&str> = st.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(left, ["고르지 않은 파일.txt"], "고르지 않은 파일까지 커밋됐다: {}", left.len());
        assert_eq!(log(r.cwd(), 1, 0).commits[0].subject, "대량 커밋");
    }

    /// ★ stdin으로 바꾸면서 **새로 생긴 폭탄**: `--pathspec-from-file`에 빈 목록을 주면
    /// git은 "경로 제한 없음"으로 읽어 `add -A`가 **저장소 전체**를 스테이징한다(실측).
    /// argv 시절엔 `git add -A -- ""`가 pathspec 오류로 죽어 우연히 막혀 있던 자리다.
    #[test]
    fn an_empty_path_list_never_reaches_git() {
        let r = repo!("commit-emptyspec");
        r.write("a.txt", "a\n");
        r.write("b.txt", "b\n");
        for files in [vec![], vec![String::new()], vec![String::new(), String::new()]] {
            let res = commit(r.cwd(), &files, "제목", "");
            assert!(!res.ok, "빈 목록이 git까지 갔다");
            let st = status(r.cwd());
            assert_eq!(st.files.len(), 2, "인덱스가 더러워졌다");
            assert!(st.files.iter().all(|f| f.untracked == Some(true)), "저장소 전체가 스테이징됐다");
        }
    }

    /// 커밋 메시지는 `commit -F -`(stdin)로 간다 — 긴 본문·개행·`#`·한글이 그대로 살아야 하고,
    /// `-m subj -m body`가 만들던 「제목·빈 줄·본문」 모양도 그대로여야 한다.
    #[test]
    fn a_long_multiline_body_survives_the_stdin_message() {
        let r = repo!("commit-body");
        r.write("a.txt", "a\n");
        let body: String = (0..400).map(|i| format!("본문 {i}번째 줄 — 길게 늘여 stdin 경로를 태운다\n")).collect();
        let body = format!("{body}# 주석처럼 보이는 줄은 살아야 한다\n\n마지막 줄");
        let res = commit(r.cwd(), &["a.txt".to_string()], "  제목 한 줄  ", &format!("  {body}  "));
        assert!(res.ok, "{:?}", res.error);
        let d = commit_detail(r.cwd(), &log(r.cwd(), 1, 0).commits[0].hash).expect("상세");
        assert_eq!(d.subject, "제목 한 줄");
        assert!(d.body.starts_with("본문 0번째 줄"), "본문 앞이 잘렸다: {}", &d.body[..40.min(d.body.len())]);
        assert!(d.body.contains("# 주석처럼 보이는 줄은 살아야 한다"), "`#` 줄이 사라졌다");
        assert!(d.body.ends_with("마지막 줄"), "본문 끝이 잘렸다");
    }

    /// 훅이 커밋을 거부하면 **스테이징이 통째로 되돌아가야** 한다 — 그 롤백도 경로를
    /// argv로 넘기던 자리라 대량에서 같이 죽었다(고치기 전엔 커밋 실패 + 인덱스 오염).
    #[test]
    fn a_hook_rejection_rolls_back_hundreds_of_staged_paths() {
        let r = repo!("commit-hook");
        r.write("seed.txt", "s\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-qm", "init"]);
        std::fs::write(r.0.join(".git/hooks/pre-commit"), "#!/bin/sh\nexit 1\n").unwrap();
        let files: Vec<String> = (0..600).map(|i| format!("훅 거부/파일-{i:04}-그럭저럭 긴 이름.txt")).collect();
        for f in &files {
            r.write(f, "x\n");
        }
        let res = commit(r.cwd(), &files, "거부될 커밋", "");
        assert!(!res.ok, "pre-commit 훅이 안 먹었다(환경에 sh가 없으면 이 테스트는 무의미)");
        // 되돌아갔나는 **인덱스에 직접** 묻는다. `status`는 미추적 폴더를 한 줄로 접어
        // 보고하므로(기존 테스트 주석과 같은 함정) 행 수로는 판정이 안 된다.
        let staged = r.git(&["diff", "--cached", "--name-only"]);
        assert!(staged.ok, "인덱스를 못 읽었다");
        assert_eq!(staged.stdout.lines().count(), 0, "스테이징이 {}개 남았다", staged.stdout.lines().count());
        assert!(status(r.cwd()).files.iter().all(|f| f.untracked == Some(true)), "되돌리기가 반쪽이다");
        assert_eq!(log(r.cwd(), 1, 0).commits[0].subject, "init", "거부됐는데 커밋이 생겼다");
    }

    /// AI 커밋 메시지의 diff 수집 — **파일이 몇 개든 스폰 1~2회**, 그리고 답은
    /// 파일당 호출(`file_diff`)과 같아야 한다. 수정·새 파일·삭제·안 바뀜·한글/공백 경로를
    /// 한 판에 섞어 두 길을 마주 세운다.
    #[test]
    fn bulk_diffs_answer_the_same_as_one_call_per_file_in_two_spawns() {
        let r = repo!("bulkdiff");
        r.write("mod.txt", "one\ntwo\nthree\n");
        r.write("gone.txt", "사라질 내용\n");
        r.write("한글 이름.txt", "가\n나\n");
        r.write("same.txt", "안 바뀐다\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-qm", "init"]);
        r.write("mod.txt", "one\nTWO\nthree\n");
        r.write("한글 이름.txt", "가\n다\n");
        std::fs::remove_file(r.0.join("gone.txt")).unwrap();
        r.write("새 파일.txt", "새 줄 1\n새 줄 2\n");

        let files: Vec<String> = ["mod.txt", "gone.txt", "한글 이름.txt", "same.txt", "새 파일.txt"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let before = spawn_count();
        let bulk = bulk_file_diffs(r.cwd(), &files);
        let spawns = spawn_count() - before;
        assert_eq!(bulk.len(), files.len());
        assert!(spawns <= 3, "파일 {}개에 스폰 {spawns}회 — 한 번에 받는 게 아니다", files.len());

        for (i, rel) in files.iter().enumerate() {
            let one = file_diff(r.cwd(), rel);
            let (b, o) = (&bulk[i], &one);
            assert_eq!(b.error.is_some(), o.error.is_some(), "{rel}: 오류 유무가 다르다");
            let (bd, od) = (b.diff.as_ref().expect(rel), o.diff.as_ref().expect(rel));
            assert_eq!((bd.add, bd.del), (od.add, od.del), "{rel}: 증감이 다르다");
            let changed = |d: &FileDiff| -> Vec<String> {
                d.lines.iter().filter(|l| l.t != "ctx" && l.t != "hunk").map(|l| format!("{}{}", l.t, l.text)).collect()
            };
            assert_eq!(changed(bd), changed(od), "{rel}: 변경 줄이 다르다");
        }
        // 안 바뀐 파일은 "변경 줄 0" — 헤더만 나가고 프롬프트가 거짓말하지 않는다
        let same = bulk[3].diff.as_ref().unwrap();
        assert_eq!((same.add, same.del, same.lines.len()), (0, 0, 0));
        // 새 파일은 전체 추가
        assert_eq!(bulk[4].diff.as_ref().unwrap().tag, "new");
    }

    /// 인자에 못 담는 규모(사용자 사고의 조건)에서도 **스폰은 그대로 한 번**이고 답이 같다 —
    /// 경로를 빼고 전 트리를 받아 고른 것만 추리는 갈래.
    #[test]
    fn bulk_diffs_stay_one_spawn_when_the_paths_no_longer_fit_in_argv() {
        let r = repo!("bulkdiff-wide");
        let files: Vec<String> = (0..900)
            .map(|i| format!("넓은 폴더/nested-{:02}/변경 파일-{:04}-long-name.txt", i % 30, i))
            .collect();
        for f in &files {
            r.write(f, "before\n");
        }
        // 고르지 **않은** 파일도 함께 바뀌어 있다 — 전 트리 diff에는 나오지만 답에는
        // 없어야 하고, 남의 덩이가 끼어들어 행이 밀려서도 안 된다.
        r.write("무관한 파일.txt", "before\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-qm", "init"]);
        for f in &files {
            r.write(f, "before\nafter\n");
        }
        r.write("무관한 파일.txt", "before\n남의 변경\n");
        r.write("무관한 새 파일.txt", "미추적\n");
        let argv_len: usize = files.iter().map(|f| f.len() + 1).sum();
        assert!(argv_len > ARGV_PATHSPEC_BUDGET, "인자 합계 {argv_len} — 전 트리 갈래를 안 탄다");
        let t0 = std::time::Instant::now();
        let before = spawn_count();
        let bulk = bulk_file_diffs(r.cwd(), &files);
        let spawns = spawn_count() - before;
        eprintln!("[측정] {}파일 bulk diff: {}ms · git 스폰 {spawns}회", files.len(), t0.elapsed().as_millis());
        assert_eq!(spawns, 2, "repo_root + diff = 2");
        assert_eq!(bulk.len(), files.len(), "고르지 않은 파일이 답에 섞였다");
        assert!(bulk.iter().all(|d| d.diff.as_ref().is_some_and(|x| (x.add, x.del) == (1, 0))), "전 트리 갈래의 답이 틀렸다");
        // 행이 밀리지 않았나 — 경로가 자기 자리에 그대로 있나
        for (i, d) in bulk.iter().enumerate() {
            assert_eq!(d.diff.as_ref().unwrap().path, files[i], "{i}번째 행이 밀렸다");
        }
    }

    /// 옛길이 실제로 얼마였나 — **기본 제외**(파일당 스폰 2회라 분 단위로 걸린다).
    /// 재현: `cargo test -p ccg-fs --lib -- --ignored --nocapture the_old_per_file_path`
    #[test]
    #[ignore = "느리다 — 이 라운드의 근거 수치(옛길 vs 새길)를 다시 잴 때만"]
    fn the_old_per_file_path_costs_two_spawns_per_file() {
        let r = repo!("bulkdiff-oldcost");
        let files: Vec<String> = (0..900)
            .map(|i| format!("넓은 폴더/nested-{:02}/변경 파일-{:04}-long-name.txt", i % 30, i))
            .collect();
        for f in &files {
            r.write(f, "before\n");
        }
        r.git(&["add", "."]);
        r.git(&["commit", "-qm", "init"]);
        for f in &files {
            r.write(f, "before\nafter\n");
        }
        let t0 = std::time::Instant::now();
        let s0 = spawn_count();
        let old: Vec<GitFileDiffResult> = files.iter().map(|f| file_diff(r.cwd(), f)).collect();
        let (old_ms, old_spawns) = (t0.elapsed().as_millis(), spawn_count() - s0);
        let t1 = std::time::Instant::now();
        let s1 = spawn_count();
        let new = bulk_file_diffs(r.cwd(), &files);
        let (new_ms, new_spawns) = (t1.elapsed().as_millis(), spawn_count() - s1);
        eprintln!("[측정] {}파일 — 옛길 {old_ms}ms/{old_spawns}스폰 · 새길 {new_ms}ms/{new_spawns}스폰", files.len());
        for i in 0..files.len() {
            let (a, b) = (old[i].diff.as_ref().unwrap(), new[i].diff.as_ref().unwrap());
            assert_eq!((a.add, a.del), (b.add, b.del), "{}: 답이 갈렸다", files[i]);
        }
        assert_eq!(old_spawns, files.len() as u64 * 2, "옛길은 파일당 2회였다");
        assert!(new_spawns <= 3);
    }

    /// ★ R1 확인 크리틱 구멍 ② — status가 한 줄로 접는 **미추적 폴더** 행(`새 폴더/`).
    ///
    /// 폴더는 `git diff`에도 `ls-files --others`(파일만 준다)에도 안 실린다. 그래서
    /// 「diff에 없다 + 디스크에 있다 = 안 바뀌었다」로 읽혀 **`+0 −0`**이 나갔다 —
    /// AI에게 "이 폴더는 안 바뀌었다"고 단언하는 거짓말이다. 옛길과 같은 답이어야 한다.
    #[test]
    fn an_untracked_folder_row_never_claims_it_is_unchanged() {
        let r = repo!("bulkdiff-folder");
        r.write("base.txt", "b\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-qm", "init"]);
        // status가 실제로 폴더 한 줄로 접는지부터 — 픽스처가 아니라 git의 행동이 근거다
        r.write("새 폴더/안쪽 1.txt", "가\n");
        r.write("새 폴더/안쪽 2.txt", "나\n");
        // 앱이 실제로 읽는 그 명령(`status --porcelain=v2 -z`)에서 폴더 한 줄이 나오는지
        let st = r.git(&["status", "--porcelain=v2", "--branch", "-z"]);
        assert!(
            st.stdout.split('\0').any(|t| t == "? 새 폴더/"),
            "git이 폴더로 안 접었다: {:?}",
            st.stdout
        );
        let rows = status(r.cwd());
        assert!(rows.files.iter().any(|f| f.path == "새 폴더/"), "status에 폴더 행이 없다");

        let rel = "새 폴더/".to_string();
        let bulk = bulk_file_diffs(r.cwd(), std::slice::from_ref(&rel));
        let old = file_diff(r.cwd(), &rel);
        assert!(old.diff.is_none() && old.error.is_some(), "옛길 전제가 깨졌다");
        assert!(
            bulk[0].diff.is_none(),
            "폴더 행을 diff로 그렸다: {:?}",
            bulk[0].diff.as_ref().map(|d| (d.tag, d.add, d.del))
        );
        assert_eq!(bulk[0].error, old.error, "옛길과 사유가 갈렸다");

        // 옆 파일들은 그대로 답이 나온다 — 폴더 한 줄이 배치를 오염시키지 않는다
        let mixed = vec!["새 폴더/".to_string(), "새 폴더/안쪽 1.txt".to_string(), "base.txt".to_string()];
        let m = bulk_file_diffs(r.cwd(), &mixed);
        assert!(m[0].error.is_some());
        assert_eq!(m[1].diff.as_ref().map(|d| (d.tag, d.add)), Some(("new", 1)));
        assert_eq!(m[2].diff.as_ref().map(|d| (d.add, d.del)), Some((0, 0)));
    }

    /// ★ R1 확인 크리틱 구멍 ①a — 첫 커밋 전(unborn HEAD)에서 **속도가 옛날로** 돌아갔다.
    /// 실측 300파일 = 902스폰·31.3초(파일당 3회). 답은 그대로 두고 스폰만 끊는다.
    #[test]
    fn an_unborn_head_answers_without_a_spawn_per_file() {
        let r = repo!("bulkdiff-unborn-cost");
        // 크리틱이 옛 코드로 잰 그 판과 같은 규모(300파일 = 902스폰·31.3초)
        let files: Vec<String> = (0..300).map(|i| format!("첫 폴더/새 파일-{i:03}.txt")).collect();
        for (i, f) in files.iter().enumerate() {
            r.write(f, &format!("가\n나 {i}\n"));
        }
        let t0 = std::time::Instant::now();
        let before = spawn_count();
        let bulk = bulk_file_diffs(r.cwd(), &files);
        let spawns = spawn_count() - before;
        eprintln!("[측정] unborn {}파일: {}ms · git 스폰 {spawns}회", files.len(), t0.elapsed().as_millis());
        // repo_root + diff(실패) + rev-parse = 3. 파일 수와 **무관**해야 한다.
        assert!(spawns <= 3, "unborn에서 파일 {}개에 스폰 {spawns}회", files.len());
        // 답 대조는 표본으로 — 옛길이 파일당 3스폰이라 300개 전부 돌리면 이 테스트 하나가
        // 20초를 먹는다(그 느림이 바로 여기서 고친 것이다). 10개 간격으로 30표본.
        for (i, f) in files.iter().enumerate().filter(|(i, _)| i % 10 == 0) {
            let one = file_diff(r.cwd(), f);
            let (b, o) = (bulk[i].diff.as_ref().expect(f), one.diff.as_ref().expect(f));
            assert_eq!((b.tag, b.add, b.del), (o.tag, o.add, o.del), "{f}: 답이 갈렸다");
            assert_eq!(b.lines.len(), o.lines.len(), "{f}: 줄 수가 갈렸다");
        }
        // 표본 밖도 답이 있고 자기 자리에 있다(행 밀림 방지)
        assert!(bulk.iter().enumerate().all(|(i, d)| d.diff.as_ref().is_some_and(|x| x.path == files[i] && x.tag == "new" && x.add == 2)));
        // 없는 경로·폴더도 옛길과 같은 사유 — unborn 갈래가 답을 헐겁게 만들지 않는다
        let odd = vec!["없는 파일.txt".to_string(), "첫 폴더/".to_string()];
        let b2 = bulk_file_diffs(r.cwd(), &odd);
        for (i, f) in odd.iter().enumerate() {
            assert_eq!(b2[i].error, file_diff(r.cwd(), f).error, "{f}: 사유가 갈렸다");
        }
    }

    /// ★ R1 확인 크리틱 구멍 ①b — 전 트리 diff가 32MB 캡을 넘으면 **배치 전체**가
    /// 파일당 호출로 내려앉았다(실측 600파일·45.2MB = 1,202스폰·32.4초).
    /// 이제 목록을 반으로 갈라 다시 부른다 — 스폰은 파일 수가 아니라 log로 는다.
    ///
    /// 느리다(30MB대를 쓰고 커밋한다) — 기본 제외. 재현:
    /// `cargo test -p ccg-fs --lib -- --ignored --nocapture an_oversize_whole_tree`
    #[test]
    #[ignore = "느리다 — 32MB 캡을 실제로 넘겨야 한다"]
    fn an_oversize_whole_tree_splits_instead_of_going_per_file() {
        let r = repo!("bulkdiff-oversize");
        // 파일당 90KB × 400 = 36MB. `-U0` 전면 교체라 diff는 그 두 배(72MB) → 캡 초과.
        let body_a = "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF\n".repeat(1_900);
        let body_b = "FEDCBA9876543210FEDCBA9876543210FEDCBA9876543210\n".repeat(1_900);
        let files: Vec<String> = (0..400).map(|i| format!("큰 폴더/덩치-{i:03}.txt")).collect();
        for f in &files {
            r.write(f, &body_a);
        }
        r.git(&["add", "."]);
        r.git(&["commit", "-qm", "init"]);
        for f in &files {
            r.write(f, &body_b);
        }
        // 전제: 경로는 argv에 담기지만(전 트리 갈래) 출력이 캡을 넘는다
        let argv_len: usize = files.iter().map(|f| f.len() + 1).sum();
        assert!(argv_len <= ARGV_PATHSPEC_BUDGET, "인자 합계 {argv_len} — 전제가 다르다");
        let probe = exec(&r.0, &["diff", "--no-color", "-U0", "HEAD"]);
        assert!(probe.over, "32MB를 안 넘겼다 — 이 테스트가 재는 자리가 아니다");

        let t0 = std::time::Instant::now();
        let before = spawn_count();
        let bulk = bulk_file_diffs(r.cwd(), &files);
        let spawns = spawn_count() - before;
        eprintln!("[측정] {}파일 캡 초과: {}ms · git 스폰 {spawns}회", files.len(), t0.elapsed().as_millis());
        assert!(spawns < 20, "{}파일에 스폰 {spawns}회 — 또 파일당으로 내려앉았다", files.len());
        assert_eq!(bulk.len(), files.len());
        for (i, f) in files.iter().enumerate() {
            let d = bulk[i].diff.as_ref().unwrap_or_else(|| panic!("{f}: 답을 잃었다"));
            assert_eq!((d.path.as_str(), d.add, d.del), (f.as_str(), 1_900, 1_900), "{f}: 답이 틀렸다");
        }
    }

    /// 커밋이 하나도 없는 저장소(unborn HEAD)에서는 `git diff HEAD`가 죽는다 —
    /// **그때 답을 잃지 않고** 파일당 호출로 내려앉는지. 바이너리도 사유가 그대로 나온다.
    #[test]
    fn bulk_diffs_fall_back_on_an_unborn_head_and_keep_binary_reasons() {
        let r = repo!("bulkdiff-unborn");
        r.write("첫 파일.txt", "a\nb\n");
        let files = vec!["첫 파일.txt".to_string()];
        let bulk = bulk_file_diffs(r.cwd(), &files);
        let d = bulk[0].diff.as_ref().expect("unborn에서 diff를 잃었다");
        assert_eq!((d.tag, d.add), ("new", 2));

        r.git(&["add", "."]);
        r.git(&["commit", "-qm", "init"]);
        r.write("bin.dat", "head\u{0}tail");
        r.git(&["add", "."]);
        r.git(&["commit", "-qm", "bin"]);
        r.write("bin.dat", "head\u{0}TAIL");
        let b = bulk_file_diffs(r.cwd(), &["bin.dat".to_string()]);
        assert!(b[0].diff.is_none() && b[0].error.is_some(), "바이너리를 diff로 그렸다");
    }

    #[test]
    fn branches_list_marks_the_current_one_and_switching_works() {
        let r = repo!("branch");
        r.write("a.txt", "a\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-qm", "init"]);
        assert!(create_branch(r.cwd(), "  feature/x  ").ok);
        let bs = branches(r.cwd());
        assert_eq!(bs.len(), 2);
        assert_eq!(bs.iter().find(|b| b.current).map(|b| b.name.as_str()), Some("feature/x"));
        assert!(bs.iter().all(|b| b.time > 0));
        assert!(!create_branch(r.cwd(), "bad..name").ok, "check-ref-format 거절");
        assert!(!create_branch(r.cwd(), "   ").ok);
        assert!(switch_branch(r.cwd(), "main").ok);
        assert_eq!(status(r.cwd()).branch, "main");
        assert!(!switch_branch(r.cwd(), "no-such-branch").ok);
    }

    #[test]
    fn discard_restores_a_tracked_file_from_head() {
        let r = repo!("discard");
        r.write("a.txt", "orig\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-qm", "init"]);
        r.write("a.txt", "broken\n");
        assert!(discard(r.cwd(), "a.txt", false).ok);
        assert_eq!(std::fs::read_to_string(r.0.join("a.txt")).unwrap(), "orig\n");
        assert!(status(r.cwd()).files.is_empty());
    }

    /// 커밋할 게 없을 때 — git stdout 첫 줄(`On branch main`)이 오류 문구로 새면 안 된다
    /// (크리틱 R1 §S8). 그리고 제목에 `\x1f`가 들어가도 칸이 밀리지 않아야 한다(§7 R-4).
    #[test]
    fn a_no_op_commit_says_so_and_a_us_in_the_subject_does_not_shift_fields() {
        let r = repo!("commit-noop");
        r.write("a.txt", "a\n");
        r.git(&["add", "."]);
        // 제목에 unit separator를 심은 커밋 — log/commit-detail 파싱의 함정
        r.git(&["commit", "-qm", "제목\u{1f}함정", "-m", "본문 첫 줄\n본문 둘째 줄"]);
        let res = commit(r.cwd(), &["a.txt".to_string()], "다시 커밋", "");
        assert!(!res.ok);
        let e = res.error.unwrap_or_default();
        assert!(!e.to_lowercase().starts_with("on branch"), "브랜치 이름이 오류로 샜다: {e}");
        assert!(e.contains("바뀐 내용이 없어요") || e.contains("nothing to commit"), "{e}");

        let head = log(r.cwd(), 5, 0).commits.into_iter().next().expect("커밋 하나");
        assert_eq!(head.subject, "제목\u{1f}함정", "제목이 구분자에서 잘렸다");
        assert!(!head.hash.is_empty() && head.time > 0, "앞 칸이 밀렸다");
        let d = commit_detail(r.cwd(), &head.hash).expect("상세");
        assert_eq!(d.subject, "제목\u{1f}함정");
        assert_eq!(d.body, "본문 첫 줄\n본문 둘째 줄", "본문 칸이 밀렸다");
        assert_eq!(d.author, "T");
    }

    /// 되돌리기의 반경 — **저장소 뿌리와 `.git`은 못 건드린다**(크리틱 R1 §S6).
    /// R1은 `discard(cwd, ".", untracked=true)`로 저장소 폴더 전체를 휴지통에 넣었다.
    #[test]
    fn discard_refuses_the_repo_root_and_the_git_dir() {
        let r = repo!("discard-root");
        r.write("a.txt", "orig\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-qm", "init"]);
        for (rel, untracked) in [(".", true), (".", false), ("", true), (".git", true), (".git/config", false)] {
            let res = discard(r.cwd(), rel, untracked);
            assert!(!res.ok, "{rel:?}(untracked={untracked})를 통과시켰다");
            assert!(r.0.join(".git").is_dir(), "{rel:?}에서 저장소가 사라졌다");
            assert!(r.0.join("a.txt").is_file(), "{rel:?}에서 파일이 사라졌다");
        }
    }

    /// 잠긴 **추적** 파일 되돌리기 — checkout이 실패한다고 "HEAD에 없던 새 파일"로 보고
    /// 휴지통에 보내면 안 된다. 인덱스도 그대로여야 한다(R1은 `rm --cached`만 성공해
    /// `D:`+`A:` 유령 두 행을 남겼다 — 크리틱 §S4).
    #[cfg(windows)]
    #[test]
    fn discard_on_a_locked_tracked_file_changes_nothing() {
        use std::os::windows::fs::OpenOptionsExt;
        let r = repo!("discard-locked");
        r.write("locked.txt", "HEAD 내용\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-qm", "init"]);
        r.write("locked.txt", "사용자가 고친 내용\n");
        // 다른 프로세스가 배타적으로 연 상태(빌드 락·엑셀·에디터)
        let guard = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(0)
            .open(r.0.join("locked.txt"))
            .expect("배타 열기 실패");
        let res = discard(r.cwd(), "locked.txt", false);
        assert!(!res.ok, "잠긴 파일을 되돌렸다고 보고했다");
        assert!(r.0.join("locked.txt").is_file(), "파일이 사라졌다");
        assert!(r.git(&["show", ":locked.txt"]).ok, "인덱스에서 빠졌다 = 유령 행");
        let rows: Vec<String> =
            status(r.cwd()).files.iter().map(|f| format!("{}:{}", f.status, f.path)).collect();
        assert_eq!(rows, ["M:locked.txt"], "상태가 두 행으로 갈라졌다: {rows:?}");
        drop(guard);
    }

    /// 새로 add된 파일이 잠겨 있으면 — 휴지통이 먼저다. 못 넣으면 인덱스도 그대로.
    #[cfg(windows)]
    #[test]
    fn discard_on_a_locked_new_file_keeps_the_index_intact() {
        use std::os::windows::fs::OpenOptionsExt;
        let r = repo!("discard-locked-new");
        r.write("base.txt", "b\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-qm", "init"]);
        r.write("fresh.txt", "새 파일\n");
        r.git(&["add", "fresh.txt"]);
        let guard = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(0)
            .open(r.0.join("fresh.txt"))
            .expect("배타 열기 실패");
        let res = discard(r.cwd(), "fresh.txt", false);
        assert!(!res.ok);
        assert!(r.0.join("fresh.txt").is_file());
        assert!(r.git(&["show", ":fresh.txt"]).ok, "휴지통이 실패했는데 인덱스만 비웠다");
        drop(guard);
    }

    /// 32MB stdout 캡에 걸린 HEAD blob은 **"새 파일 +1 −0"이 아니다**(크리틱 §S5).
    /// R1은 70만 줄을 잃은 파일을 "멀쩡한 초록 한 줄"로 그렸고, 그 카드 옆에 되돌리기가 있다.
    #[test]
    fn an_oversize_head_blob_folds_instead_of_claiming_a_new_file() {
        let r = repo!("bigblob");
        // MAX_OUTPUT(32MB)을 확실히 넘기되 압축이 잘 되는 본문(커밋을 싸게)
        let big = "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEFxx\n".repeat(700_000);
        r.write("huge.txt", &big);
        r.git(&["add", "."]);
        r.git(&["commit", "-qm", "big"]);
        // ① 사용자가 파일을 한 줄로 줄였다
        r.write("huge.txt", "남은 한 줄\n");
        let d = file_diff(r.cwd(), "huge.txt");
        assert!(d.diff.is_none(), "캡에 걸린 blob을 diff로 그렸다: {:?}", d.diff.map(|x| x.tag));
        assert!(d.error.is_some_and(|e| e.contains("너무 커") || e.contains("too large")), "사유가 없다");
        // ② 파일을 지웠다 — 여기서도 "새 파일"이 아니라 사유가 나와야 한다
        std::fs::remove_file(r.0.join("huge.txt")).unwrap();
        let d2 = file_diff(r.cwd(), "huge.txt");
        assert!(d2.diff.is_none() && d2.error.is_some());
    }

    #[test]
    fn push_without_a_remote_explains_itself() {
        let r = repo!("push");
        r.write("a.txt", "a\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-qm", "init"]);
        let res = push(r.cwd());
        assert!(!res.ok);
        assert!(res.error.unwrap().contains("remote"), "무엇을 해야 하는지 말해준다");
    }

    /// cwd 자신이 저장소면 그 하나만 — 2.6.2의 걷기는 저장소를 만나면 **멈춘다**
    /// (중첩 저장소는 그 저장소를 열면 보인다). 이 레포에서 `git-repo-list` 화면에
    /// 도달할 수 없는 이유가 이것이다(screen-inventory 실측 메모와 같은 결론).
    #[test]
    fn a_repo_cwd_reports_only_itself() {
        let r = repo!("selfrepo");
        r.write("a.txt", "a\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-qm", "init"]);
        std::fs::create_dir_all(r.0.join("Plugins/Nested")).unwrap();
        exec(&r.0.join("Plugins/Nested"), &["init", "-q"]);
        let found = repos(r.cwd());
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].rel, "", "cwd 자신 = 라벨 없는 줄");
        assert_eq!(std::path::Path::new(&found[0].root), r.0.as_path());
    }

    /// 저장소가 아닌 폴더에서는 아래를 얕게 걸어 저장소들을 찾는다(UE Plugins 꼴).
    #[test]
    fn a_plain_cwd_discovers_the_repos_below_it() {
        if !have_git() {
            return;
        }
        let base = scratch("discover");
        for sub in ["Plugins/Nested", "Apps/Web", "node_modules/pkg"] {
            let p = base.join(sub);
            std::fs::create_dir_all(&p).unwrap();
            exec(&p, &["init", "-q"]);
        }
        let found = repos(base.to_str().unwrap());
        let rels: Vec<&str> = found.iter().map(|x| x.rel.as_str()).collect();
        assert_eq!(rels, vec!["Apps/Web", "Plugins/Nested"], "경로순 + 포워드 슬래시");
        assert!(!rels.iter().any(|r| r.contains("node_modules")), "무거운 폴더는 안 걷는다");
        // 하위 저장소 안에서 물으면 그 저장소가 rel '' 로 나온다
        let inner = repos(base.join("Apps/Web").to_str().unwrap());
        assert_eq!(inner.len(), 1);
        assert_eq!(inner[0].rel, "");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn err_line_strips_the_fatal_prefix() {
        assert_eq!(err_line("fatal: not a git repository\n", ""), "not a git repository");
        assert_eq!(err_line("", "error: pathspec\n"), "pathspec");
        assert!(!err_line("", "").is_empty());
    }
}
