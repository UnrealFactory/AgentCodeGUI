//! 탐색기 트리 + "@" 멘션 파일 목록 — `src/main/files.ts`의 이식.
//!
//! 두 조회 모두 **캐시 없음·매번 디스크**다(lib.rs의 변경 통지 규약). 대신 상한이
//! 촘촘하다: 멘션 목록 6000개, 빈-폴더 프루닝은 깊이 6 + 노드 예산 4000.

use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// `protocol.ts DirEntry` — 이름 + 폴더 여부. 그 외 메타는 렌더러가 안 쓴다.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct DirEntry {
    pub name: String,
    pub dir: bool,
}

// ── "@" 멘션 파일 목록 ──────────────────────────────────────────────────────

/// 걷지 않는 폴더 — 무겁거나 생성물이거나 VCS 내부. 멘션 팔레트를 뒤덮고 걷기를 느리게 한다.
const SKIP_DIRS: &[&str] = &[
    "node_modules", ".git", ".hg", ".svn", "dist", "out", "build", "coverage",
    ".next", ".nuxt", ".svelte-kit", ".turbo", ".cache", ".parcel-cache", ".vite",
    ".idea", ".vs", ".gradle", "bin", "obj", "target", "vendor", "__pycache__",
    ".venv", "venv", ".mypy_cache", ".pytest_cache", ".expo", "Pods", ".dart_tool",
];
/// 남겨두는 점-폴더 — 진짜 멘션할 만한 파일이 산다(워크플로·스킬·MCP 설정).
const KEEP_DOT_DIRS: &[&str] = &[".github", ".claude", ".vscode"];
/// 거대 레포가 걷기나 렌더러를 멈추지 못하게 하는 상한.
const MAX_FILES: usize = 6000;

/// `cwd`를 너비 우선으로 걸어 프로젝트 상대 POSIX 경로를 돌려준다.
/// 너비 우선이라 얕은 파일(사용자가 가장 자주 멘션하는 것)이 앞에 온다.
pub fn list_project_files(cwd: &str) -> Vec<String> {
    if cwd.is_empty() {
        return Vec::new();
    }
    let root = Path::new(cwd);
    let mut out: Vec<String> = Vec::new();
    let mut queue: std::collections::VecDeque<String> = std::collections::VecDeque::new();
    queue.push_back(String::new());
    while let Some(rel) = queue.pop_front() {
        if out.len() >= MAX_FILES {
            break;
        }
        let abs: PathBuf = if rel.is_empty() { root.to_path_buf() } else { root.join(&rel) };
        let Ok(entries) = std::fs::read_dir(&abs) else { continue }; // 못 읽는 폴더(권한·레이스)는 건너뛴다
        let mut dirs: Vec<String> = Vec::new();
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let child_rel = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                if SKIP_DIRS.contains(&name.as_str()) {
                    continue;
                }
                if name.starts_with('.') && !KEEP_DOT_DIRS.contains(&name.as_str()) {
                    continue;
                }
                dirs.push(child_rel);
            } else if e.file_type().map(|t| t.is_file()).unwrap_or(false) {
                out.push(child_rel);
                if out.len() >= MAX_FILES {
                    break;
                }
            }
        }
        // 이 폴더의 자식은 이미 대기 중인 것들 **뒤에** → 너비 우선
        for d in dirs {
            queue.push_back(d);
        }
    }
    out
}

// ── 이름 매처(VS Code files.exclude 스타일 글롭) ────────────────────────────

/// 항목의 **basename**으로 판정한다. UEFN 패턴(접미 글롭 + 맨이름 폴더)에 충분하고,
/// 맨이름은 "어느 깊이에서든 제외"로 다뤄 잡동사니 폴더가 전 깊이에서 사라진다.
pub struct Excluder {
    exact: HashSet<String>,
    globs: Vec<Glob>,
}

/// `*`(임의 길이)·`?`(한 글자)만 쓰는 아주 작은 글롭. 정규식 크레이트를 들이지 않는다
/// (2.6.2도 JS 정규식으로 이 두 문자만 변환했다 — 표현력이 같아야 결과가 같다).
struct Glob {
    parts: Vec<String>, // `*`로 쪼갠 리터럴 조각. `?`는 조각 안에서 한 글자 와일드.
    lead_star: bool,
    trail_star: bool,
}

fn matches_lit(hay: &[char], lit: &[char]) -> bool {
    hay.len() == lit.len() && hay.iter().zip(lit).all(|(h, l)| *l == '?' || h == l)
}

fn find_lit(hay: &[char], lit: &[char], from: usize) -> Option<usize> {
    if lit.is_empty() {
        return Some(from);
    }
    if hay.len() < lit.len() {
        return None;
    }
    (from..=hay.len() - lit.len()).find(|&i| matches_lit(&hay[i..i + lit.len()], lit))
}

impl Glob {
    fn is_match(&self, name_lower: &str) -> bool {
        let hay: Vec<char> = name_lower.chars().collect();
        let lits: Vec<Vec<char>> = self.parts.iter().map(|p| p.chars().collect()).collect();
        if lits.is_empty() {
            return true; // 패턴이 `*` 하나
        }
        if lits.len() == 1 && !self.lead_star && !self.trail_star {
            return matches_lit(&hay, &lits[0]);
        }
        let mut pos = 0usize;
        for (i, lit) in lits.iter().enumerate() {
            let first = i == 0;
            let last = i == lits.len() - 1;
            if first && !self.lead_star {
                if hay.len() < lit.len() || !matches_lit(&hay[..lit.len()], lit) {
                    return false;
                }
                pos = lit.len();
                continue;
            }
            if last && !self.trail_star {
                if hay.len() < pos + lit.len() {
                    return false;
                }
                return matches_lit(&hay[hay.len() - lit.len()..], lit);
            }
            match find_lit(&hay, lit, pos) {
                Some(i0) => pos = i0 + lit.len(),
                None => return false,
            }
        }
        true
    }
}

impl Excluder {
    /// 빈 패턴 목록이면 None — 호출부가 "필터 없음"을 그대로 구분한다.
    pub fn new(patterns: &[String]) -> Option<Excluder> {
        let mut exact: HashSet<String> = HashSet::new();
        let mut globs: Vec<Glob> = Vec::new();
        for raw in patterns {
            let mut p = raw.trim();
            if let Some(rest) = p.strip_prefix("**/") {
                p = rest;
            }
            if let Some(i) = p.rfind('/') {
                p = &p[i + 1..]; // basename만
            }
            if p.is_empty() {
                continue;
            }
            if p.contains('*') || p.contains('?') {
                let low = p.to_lowercase();
                let parts: Vec<String> = low.split('*').filter(|s| !s.is_empty()).map(str::to_string).collect();
                globs.push(Glob { parts, lead_star: low.starts_with('*'), trail_star: low.ends_with('*') });
            } else {
                exact.insert(p.to_lowercase());
            }
        }
        if exact.is_empty() && globs.is_empty() {
            return None;
        }
        Some(Excluder { exact, globs })
    }

    pub fn is_match(&self, name: &str) -> bool {
        let low = name.to_lowercase();
        if self.exact.contains(&low) {
            return true;
        }
        self.globs.iter().any(|g| g.is_match(&low))
    }
}

// ── 한 폴더 조회(탐색기의 폴더 펼치기마다 1회) ──────────────────────────────

/// 필터 세 갈래 — 2.6.2 `listDir`의 문서를 그대로 옮긴다.
/// - `exclude`: 파일 **과** 폴더 (Verse 위주로 보기 글롭). `hide_empty`와 함께 쓰면
///   이 글롭 때문에 빈 폴더가 된 곳도 사라진다(UEFN Verse Explorer).
/// - `exclude_dirs`: 폴더만 (빌드·생성물 폴더 숨김: bin/obj/Saved/…)
/// - `exclude_files`: 파일만 (숨김 파일 이름·패턴: Thumbs.db, `*.uasset`, …)
#[derive(Default)]
pub struct ListOpts {
    pub exclude: Vec<String>,
    pub hide_empty: bool,
    pub exclude_dirs: Vec<String>,
    pub exclude_files: Vec<String>,
}

/// 폴더 하나를 나열한다. `rel`은 cwd 기준('' = 프로젝트 루트).
/// 기본은 **필터 없음** — 탐색기는 node_modules 포함 진짜 트리를 보여준다.
/// 폴더 먼저, 그다음 파일. 각각 대소문자 무시 정렬.
pub fn list_dir(cwd: &str, rel: &str, opts: &ListOpts) -> Vec<DirEntry> {
    if cwd.is_empty() {
        return Vec::new();
    }
    let Ok(abs_cwd) = std::path::absolute(cwd) else { return Vec::new() };
    let root = crate::resolve_lexical(&abs_cwd, "");
    let abs = crate::resolve_lexical(&root, rel);
    // 조작된 "../"로 프로젝트 밖을 훑지 못하게
    if !crate::inside(&root, &abs) {
        return Vec::new();
    }
    let Ok(read) = std::fs::read_dir(&abs) else { return Vec::new() }; // 못 읽는 폴더 → 빈 폴더로 보인다

    let excl_all = Excluder::new(&opts.exclude);
    let excl_dir = Excluder::new(&opts.exclude_dirs);
    let excl_file = Excluder::new(&opts.exclude_files);
    // 한 항목의 판정 — 공용 목록이 늘 먼저, 그다음 종류별 목록
    let hidden = |name: &str, dir: bool| -> bool {
        excl_all.as_ref().is_some_and(|e| e.is_match(name))
            || if dir {
                excl_dir.as_ref().is_some_and(|e| e.is_match(name))
            } else {
                excl_file.as_ref().is_some_and(|e| e.is_match(name))
            }
    };

    let mut out: Vec<DirEntry> = read
        .flatten()
        .map(|e| DirEntry {
            name: e.file_name().to_string_lossy().to_string(),
            dir: e.file_type().map(|t| t.is_dir()).unwrap_or(false),
        })
        .collect();

    let filtering = excl_all.is_some() || excl_dir.is_some() || excl_file.is_some();
    if filtering {
        out.retain(|e| !hidden(&e.name, e.dir));
        if opts.hide_empty {
            let mut budget = 4000usize;
            out.retain(|e| {
                !e.dir || dir_has_visible_file(&abs.join(&e.name), &hidden, 6, &mut budget)
            });
        }
    }
    out.sort_by(|a, b| match (a.dir, b.dir) {
        (x, y) if x == y => crate::collate::name_cmp(&a.name, &b.name),
        (true, _) => std::cmp::Ordering::Less,
        _ => std::cmp::Ordering::Greater,
    });
    out
}

/// `abs`(폴더) 아래 어딘가에 제외되지 않은 **파일**이 하나라도 있나? 깊이 + 공유 노드
/// 예산으로 상한을 둔다. 예산이 바닥나면 "있다"로 본다 — 잘못 숨기는 것보다 보이는 게 낫다.
fn dir_has_visible_file(
    abs: &Path,
    hidden: &dyn Fn(&str, bool) -> bool,
    depth: i32,
    budget: &mut usize,
) -> bool {
    if depth < 0 || *budget == 0 {
        return true;
    }
    let Ok(read) = std::fs::read_dir(abs) else { return false };
    let mut subdirs: Vec<PathBuf> = Vec::new();
    for e in read.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if hidden(&name, is_dir) {
            continue;
        }
        if e.file_type().map(|t| t.is_file()).unwrap_or(false) {
            return true;
        }
        if is_dir {
            subdirs.push(abs.join(&name));
        }
        *budget = budget.saturating_sub(1);
        if *budget == 0 {
            return true;
        }
    }
    for d in subdirs {
        if dir_has_visible_file(&d, hidden, depth - 1, budget) {
            return true;
        }
        if *budget == 0 {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ccg-fs-dir-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn touch(p: &Path) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, "x").unwrap();
    }

    #[test]
    fn folders_come_first_then_files_each_case_insensitive() {
        let d = tmp("order");
        touch(&d.join("Beta.txt"));
        touch(&d.join("alpha.txt"));
        std::fs::create_dir_all(d.join("Zeta")).unwrap();
        std::fs::create_dir_all(d.join("apple")).unwrap();
        let got = list_dir(d.to_str().unwrap(), "", &ListOpts::default());
        let names: Vec<&str> = got.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["apple", "Zeta", "alpha.txt", "Beta.txt"]);
        assert!(got[0].dir && got[1].dir && !got[2].dir);
    }

    #[test]
    fn nothing_is_filtered_by_default_not_even_node_modules() {
        let d = tmp("nofilter");
        std::fs::create_dir_all(d.join("node_modules")).unwrap();
        touch(&d.join(".env"));
        let got = list_dir(d.to_str().unwrap(), "", &ListOpts::default());
        assert_eq!(got.len(), 2, "탐색기 기본은 진짜 트리다");
    }

    #[test]
    fn dir_only_and_file_only_lists_do_not_bleed_into_each_other() {
        let d = tmp("kinds");
        std::fs::create_dir_all(d.join("Saved")).unwrap();
        touch(&d.join("Saved.txt"));
        touch(&d.join("keep.rs"));
        let got = list_dir(
            d.to_str().unwrap(),
            "",
            &ListOpts { exclude_dirs: vec!["Saved".into()], ..Default::default() },
        );
        let names: Vec<&str> = got.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["keep.rs", "Saved.txt"], "폴더 숨김이 같은 이름 파일을 지우면 안 된다");
    }

    #[test]
    fn suffix_globs_match_by_basename_at_any_depth() {
        let e = Excluder::new(&["**/*.uasset".into(), "Collections".into()]).unwrap();
        assert!(e.is_match("Mesh.uasset"));
        assert!(e.is_match("MESH.UASSET"));
        assert!(!e.is_match("Mesh.uasset.bak"));
        assert!(e.is_match("collections"));
        assert!(!e.is_match("Collections2"));
    }

    #[test]
    fn glob_wildcards_in_the_middle_and_question_marks() {
        let e = Excluder::new(&["a*z".into(), "f?o".into(), "*.tmp".into()]).unwrap();
        assert!(e.is_match("abcz"));
        assert!(e.is_match("az"));
        assert!(!e.is_match("abc"));
        assert!(e.is_match("foo"));
        assert!(!e.is_match("fooo"));
        assert!(e.is_match("x.tmp"));
    }

    #[test]
    fn hide_empty_prunes_folders_left_empty_by_the_globs() {
        let d = tmp("hideempty");
        touch(&d.join("Assets").join("a.uasset"));
        touch(&d.join("Code").join("a.verse"));
        let got = list_dir(
            d.to_str().unwrap(),
            "",
            &ListOpts { exclude: vec!["*.uasset".into()], hide_empty: true, ..Default::default() },
        );
        let names: Vec<&str> = got.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["Code"]);
    }

    #[test]
    fn rel_cannot_escape_the_project_root() {
        let d = tmp("escape");
        touch(&d.join("inside.txt"));
        let cwd = d.to_str().unwrap();
        assert!(list_dir(cwd, "../..", &ListOpts::default()).is_empty());
        assert!(list_dir(cwd, "sub/../../..", &ListOpts::default()).is_empty(), "중간에 낀 ..도 접는다");
        // 상대 경로 자리에 절대 경로 — Path::join은 앞을 통째로 버린다(루트 가드가 유일 방어선)
        assert!(list_dir(cwd, std::env::temp_dir().to_str().unwrap(), &ListOpts::default()).is_empty());
        assert_eq!(list_dir(cwd, "", &ListOpts::default()).len(), 1);
    }

    #[test]
    fn mention_list_is_breadth_first_and_skips_generated_dirs() {
        let d = tmp("mention");
        touch(&d.join("top.ts"));
        touch(&d.join("src").join("deep.ts"));
        touch(&d.join("node_modules").join("junk.js"));
        touch(&d.join(".github").join("wf.yml"));
        touch(&d.join(".secret").join("x.txt"));
        let got = list_project_files(d.to_str().unwrap());
        assert!(got.contains(&"top.ts".to_string()));
        assert!(got.contains(&"src/deep.ts".to_string()));
        assert!(got.contains(&".github/wf.yml".to_string()), ".github는 남긴다");
        assert!(!got.iter().any(|p| p.contains("node_modules")));
        assert!(!got.iter().any(|p| p.contains(".secret")));
        assert_eq!(got[0], "top.ts", "얕은 파일이 앞에");
    }
}
