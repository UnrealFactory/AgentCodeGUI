//! 서버 바이너리/모듈을 **어디서 찾는가**.
//!
//! 2.6.2는 이 문제가 없었다 — Electron이 곧 Node라 `process.execPath`에
//! `ELECTRON_RUN_AS_NODE=1`을 얹으면 끝이었고, 모듈은 `app.getAppPath()/node_modules`에
//! 항상 있었다. 3.0(Tauri)에는 그 둘이 다 없다. 그래서 **해석 사슬을 명시**하고,
//! 실패하면 조용히 `unsupported`가 아니라 `error`로 드러나게 한다(진단 문자열 포함).
//!
//! [R1의 정직한 한계] 3.0은 아직 Node 런타임을 번들하지 않는다(`bundle.active=false`).
//! 지금은 개발/벤치 경로 = 레포의 `node_modules` + 시스템 `node`다. 배포 번들에
//! `resources/node.exe` + `resources/node_modules/`를 싣는 것은 **패키징 라운드의 일**이고,
//! 이 사슬은 그때 항목이 이미 우선순위 위쪽에 있으므로 코드가 바뀌지 않는다.

use std::path::{Path, PathBuf};

fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(Path::to_path_buf)
}

fn env_path(key: &str) -> Option<PathBuf> {
    let v = std::env::var(key).ok()?;
    if v.is_empty() {
        return None;
    }
    let p = PathBuf::from(v);
    p.exists().then_some(p)
}

/// Node 런타임. 없으면 `None` → `Launch::Node` 스펙은 기동 불가로 보고된다.
pub fn node_exe() -> Option<PathBuf> {
    // ① 명시 지정(벤치·포터블 배포)
    if let Some(p) = env_path("CCG_LSP_NODE") {
        return Some(p);
    }
    // ② exe 옆 사이드카(패키징 라운드가 여기에 싣는다)
    if let Some(d) = exe_dir() {
        for rel in [["node.exe"].as_slice(), ["resources", "node.exe"].as_slice()] {
            let p = rel.iter().fold(d.clone(), |a, s| a.join(s));
            if p.exists() {
                return Some(p);
            }
        }
    }
    // ③ PATH
    which("node.exe").or_else(|| which("node"))
}

/// `node_modules/<rel…>` — 개발(레포)·배포(리소스) 양쪽에서 찾는다.
pub fn shipped_module(rel: &[&str]) -> Option<PathBuf> {
    let join = |base: &Path| rel.iter().fold(base.join("node_modules"), |a, s| a.join(s));
    // ① 명시 지정(벤치) — node_modules를 담은 폴더
    if let Some(base) = env_path("CCG_LSP_MODULES") {
        let p = join(&base);
        if p.exists() {
            return Some(p);
        }
    }
    // ② exe 옆 resources/ · exe 폴더 자체 · 그 위로(개발: target/release → 레포 루트)
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(d) = exe_dir() {
        roots.push(d.join("resources"));
        let mut cur: Option<&Path> = Some(&d);
        while let Some(c) = cur {
            roots.push(c.to_path_buf());
            cur = c.parent();
        }
    }
    // ③ 현재 작업 폴더에서 위로(개발 실행)
    if let Ok(cwd) = std::env::current_dir() {
        let mut cur: Option<&Path> = Some(&cwd);
        while let Some(c) = cur {
            roots.push(c.to_path_buf());
            cur = c.parent();
        }
    }
    roots.into_iter().map(|r| join(&r)).find(|p| p.exists())
}

/// 내려받은 네이티브 서버 — **2.6.2 `install.ts`와 같은 자리**인 `<앱 홈>/lsp/<id>/` 아래를
/// 재귀로 뒤져 `name`을 찾는다.
///
/// 왜 재귀인가: Roslyn의 exe는 nupkg를 푼 `tools/<tfm>/<rid>/`에, clangd는
/// `clangd_<버전>/bin/`에 들어간다 — 둘 다 **버전이 경로에 박혀 있어** 고정 경로로는 못 찾는다
/// (2.6.2 `findFile`이 같은 이유로 재귀였다). 이 자리를 2.6.2와 같게 두는 값어치는 실제로
/// 크다: 2.6.2로 이미 받아 둔 159MB짜리 Roslyn을 3.0이 **그대로 쓴다**(다시 안 받는다).
///
/// R2까지는 `<앱 홈>/lsp/bin/<id>/<name>`이라는 3.0 고유 경로였고, 그 자리는 아무도 채우지
/// 않아 C#이 영원히 `need-install`이었다. 그 경로도 먼저 보긴 한다(내려받기 UI가 생기면 쓸 자리).
/// **찾은 결과는 메모한다** — `lsp:status`는 400ms마다 오고, 여기서 `Provision::Download`
/// 서버의 설치 여부를 판정한다. 메모가 없으면 폴링 한 번마다 159MB짜리 설치 폴더를 재귀로
/// 걷는다. 메모는 **양성만** 담고 매번 `exists()`로 되짚는다 — 삭제/재설치가 그대로 반영된다
/// (음성은 애초에 싸다: 폴더가 없으면 `read_dir`이 즉시 실패한다).
pub fn installed_bin(id: &str, name: &str) -> Option<PathBuf> {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static MEMO: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();
    let lsp = ccg_store::app_home().join("lsp");
    // 앱 홈까지 키에 넣는다 — 벤치·테스트가 CCG_HOME을 갈아 끼우면 다른 홈의 경로를
    // 돌려주면 안 된다(`exists()`가 대개 걸러 주지만 키로 막는 편이 정직하다).
    let key = format!("{}|{id}|{name}", lsp.to_string_lossy());
    let memo = MEMO.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(p) = memo.lock().unwrap().get(&key) {
        if p.exists() {
            return Some(p.clone());
        }
    }
    let direct = lsp.join("bin").join(id).join(name);
    let found = if direct.exists() { Some(direct) } else { find_file(&lsp.join(id), name, 0) };
    match found {
        Some(p) => {
            memo.lock().unwrap().insert(key, p.clone());
            Some(p)
        }
        None => {
            memo.lock().unwrap().remove(&key);
            None
        }
    }
}

/// 이름이 정확히 일치하는 첫 파일(깊이 8까지) — 2.6.2 `install.ts::findFile`.
fn find_file(dir: &Path, name: &str, depth: u32) -> Option<PathBuf> {
    if depth > 8 {
        return None;
    }
    let mut dirs: Vec<PathBuf> = Vec::new();
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let p = e.path();
        if p.is_dir() {
            dirs.push(p);
        } else if p.file_name().and_then(|s| s.to_str()) == Some(name) {
            return Some(p);
        }
    }
    // 파일을 먼저 다 본 뒤 내려간다 — 얕은 자리에 있으면 재귀 없이 끝난다
    dirs.sort();
    dirs.into_iter().find_map(|d| find_file(&d, name, depth + 1))
}

fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let p = dir.join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}
