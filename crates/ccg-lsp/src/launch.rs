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

/// 내려받은 네이티브 서버 — `<앱 홈>/lsp/bin/<id>/<name>` (2.6.2 `install.ts`와 같은 자리).
#[allow(dead_code)] // R2(C#/C++)에서 배선
pub fn installed_bin(id: &str, name: &str) -> Option<PathBuf> {
    let p = ccg_store::app_home().join("lsp").join("bin").join(id).join(name);
    p.exists().then_some(p)
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
