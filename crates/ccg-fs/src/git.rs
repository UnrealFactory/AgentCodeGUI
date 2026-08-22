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

use crate::diff::{compute_line_diff, new_file_diff, FileDiff};
use serde::Serialize;
use std::io::Read;
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
}

/// `git -C <root> <args>`. 콘솔 창을 띄우지 않고, stdout은 `MAX_OUTPUT`에서 끊고
/// 자식을 죽인다(끊긴 실행은 `ok:false` — 반쪽 출력을 파싱해 거짓말하지 않는다).
fn exec(root: &Path, args: &[&str]) -> Out {
    use std::process::{Command, Stdio};
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(root).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
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
        return Out { ok: false, stdout: String::new(), stderr: String::new() };
    };
    // stderr는 별도 스레드로 — 두 파이프를 한 스레드에서 순서대로 읽으면 상대가 가득
    // 차서 서로 막힌다(고전적 파이프 교착).
    let err_pipe = child.stderr.take();
    let err_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(p) = err_pipe {
            let _ = p.take(MAX_STDERR as u64).read_to_end(&mut buf);
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
    let ok = !over && status.map(|s| s.success()).unwrap_or(false);
    Out {
        ok,
        stdout: String::from_utf8_lossy(&out_buf).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
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
    let st = exec(&root, &["status", "--porcelain=v2", "--branch", "-z"]);
    if !st.ok {
        return not_repo();
    }
    let remotes = exec(&root, &["remote"]);
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
            let f: Vec<&str> = line.split(FS).collect();
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

fn show_at(root: &Path, rev: &str, rel: &str) -> Option<String> {
    let spec = format!("{rev}:{rel}");
    // `--` 뒤로 밀 수 없는 형태(rev:path)라, rev/rel이 옵션처럼 보이지 않게 미리 막는다.
    if rel.starts_with('-') {
        return None;
    }
    let r = exec(root, &["show", spec.as_str()]);
    if r.ok { Some(r.stdout) } else { None }
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
    // 삭제된 파일이면 None. 디스크 읽기는 뷰어와 같은 손실 UTF-8 규칙.
    let cur: Option<String> = std::fs::read(&abs).ok().map(|b| String::from_utf8_lossy(&b).into_owned());
    if cur.is_none() && base.is_none() {
        return GitFileDiffResult {
            error: Some(crate::t("내용을 읽을 수 없어요", "Could not read the contents")),
            ..Default::default()
        };
    }
    let mut d = build_file_diff(rel, base.as_deref(), Some(cur.as_deref().unwrap_or("")));
    // 디스크에서 지워진 파일 — 뷰어가 읽을 게 없으니 HEAD 스냅샷을 같이 준다
    if cur.is_none() {
        if let Some(b) = base {
            if !looks_binary(&b) && b.len() <= MAX_DIFF_BYTES {
                d.head_content = Some(b);
            }
        }
    }
    d
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
    let fmt = format!("--pretty=format:%H{FS}%h{FS}%an{FS}%at{FS}%s{FS}%b");
    let meta = exec(&root, &["log", "-1", fmt.as_str(), hash]);
    if !meta.ok {
        return None;
    }
    // -z: 상태와 경로가 NUL로 번갈아 온다 (R/C는 status·old·new 3연속)
    let names = exec(&root, &["show", "--name-status", "--format=", "-z", hash]);
    let f: Vec<&str> = meta.stdout.split(FS).collect();
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
        body: g(5).trim().to_string(),
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
    let mut d = build_file_diff(rel, base.as_deref(), Some(cur.as_deref().unwrap_or("")));
    d.content = Some(cur.unwrap_or_default());
    d
}

// ── 쓰기 동작 — 전부 {ok, error} 한 모양 ────────────────────────────────────

/// 고른 파일만 커밋 — add(그 경로만) 후 commit. 스테이징 용어는 UI에 없다.
pub fn commit(cwd: &str, files: &[String], subject: &str, body: &str) -> GitResult {
    let Some(root) = repo_root(cwd) else { return GitResult::err(e_not_repo()) };
    if files.is_empty() {
        return GitResult::err(crate::t("커밋할 파일이 없어요", "No files to commit"));
    }
    if subject.trim().is_empty() {
        return GitResult::err(crate::t("커밋 메시지를 입력해 주세요", "Enter a commit message"));
    }
    let mut add_args: Vec<&str> = vec!["add", "-A", "--"];
    add_args.extend(files.iter().map(String::as_str));
    let add = exec(&root, &add_args);
    if !add.ok {
        return GitResult::err(err_line(&add.stderr, &add.stdout));
    }
    let subj = subject.trim();
    let bod = body.trim();
    let mut args: Vec<&str> = vec!["commit", "-m", subj];
    if !bod.is_empty() {
        args.push("-m");
        args.push(bod);
    }
    let r = exec(&root, &args);
    if r.ok {
        return GitResult::ok();
    }
    // 커밋이 거부되면(훅·identity 미설정 등) 방금 올린 스테이징을 되돌려 상태를 원래대로
    let mut reset_args: Vec<&str> = vec!["reset", "--"];
    reset_args.extend(files.iter().map(String::as_str));
    let _ = exec(&root, &reset_args);
    let e = format!("{}{}", r.stderr, r.stdout);
    let low = e.to_lowercase();
    if low.contains("user.name") || low.contains("user.email") {
        return GitResult::err(crate::t(
            "git 사용자 정보가 없어요 — 터미널에서 git config --global user.name / user.email을 설정해 주세요",
            "Git identity is not set — run git config --global user.name / user.email in a terminal",
        ));
    }
    GitResult::err(err_line(&r.stderr, &r.stdout))
}

pub fn push(cwd: &str) -> GitResult {
    let Some(root) = repo_root(cwd) else { return GitResult::err(e_not_repo()) };
    let st = status(root.to_string_lossy().as_ref());
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
pub fn discard(cwd: &str, rel: &str, untracked: bool) -> GitResult {
    let Some(root) = repo_root(cwd) else { return GitResult::err(e_not_repo()) };
    let Some(abs) = abs_of(&root, rel) else {
        return GitResult::err(crate::t("잘못된 경로", "Invalid path"));
    };
    let trash_fail =
        || crate::t("파일을 휴지통으로 보내지 못했어요", "Could not move the file to the recycle bin");
    if untracked {
        return match crate::file::delete_path("", abs.to_string_lossy().as_ref()) {
            r if r.ok => GitResult::ok(),
            _ => GitResult::err(trash_fail()),
        };
    }
    // index에 올라가 있어도(A 포함) 한 번에 HEAD 상태로 — 스테이징·워크트리 모두 복원
    let r = exec(&root, &["checkout", "HEAD", "--", rel]);
    if r.ok {
        return GitResult::ok();
    }
    // HEAD에 없던(새로 add된) 파일 — 스테이징 해제 후 휴지통
    let rm = exec(&root, &["rm", "--cached", "-f", "--ignore-unmatch", "--", rel]);
    if rm.ok {
        return match crate::file::delete_path("", abs.to_string_lossy().as_ref()) {
            x if x.ok => GitResult::ok(),
            _ => GitResult::err(trash_fail()),
        };
    }
    GitResult::err(err_line(&r.stderr, ""))
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
