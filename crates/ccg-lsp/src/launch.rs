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
//!
//! ## ★ LSPDIST R1 — 그 「패키징 라운드」가 여기다. cwd 사슬을 잘라냈다
//!
//! 위 문단이 예고한 대로 모듈은 번들에 실렸다(`tauri.conf.json`의 `bundle.resources`).
//! **코드가 바뀐 자리는 하나뿐**이고, 그건 사슬의 우선순위가 아니라 **사슬의 마지막 칸**이다:
//!
//! R28j 수정 R1 §1.4-b와 확인 크리틱 R2 F1이 실측으로 못 박은 결함 — `shipped_module()`이
//! exe 폴더 사슬 **∪ 프로세스 cwd 사슬**을 훑는 바람에, **같은 exe·같은 설치 자리**인데
//! 시작 메뉴로 켜면(cwd = 설치 폴더) TS·Python LSP가 안 뜨고, 앱이 스스로 등록한 폴더
//! 우클릭으로 켜면(cwd = 프로젝트) 떴다. 유휴 WS가 **0.627 ↔ 0.839**로 갈린 그 띠다.
//!
//! **cwd 사슬은 폴백으로 강등하지 않고 삭제했다.** 근거 셋:
//!
//! 1. **결정론.** 폴백으로 남기면 「번들이 없는 빌드」에서 두 팔이 여전히 갈린다 —
//!    띠를 없애는 유일한 조치가 삭제다. 이제 결과는 **exe 경로의 함수**다(cwd 무관).
//! 2. **그 경로가 물던 것이 애초에 틀렸다.** cwd는 대개 사용자가 연 프로젝트고, 거기서
//!    찾은 `node_modules/typescript`는 **그 프로젝트의 TS 버전**이다. 우리는 언어 서버로
//!    쓸 tsserver를 일부러 못박아 왔다([`crate::spec`]의 `ts_init_options`: *"번들된
//!    tsserver를 못박는다 — 해석이 열린 프로젝트에 의존하지 않게"*). cwd 사슬은 그 불변식을
//!    바로 옆에서 깨고 있었다. 2.6.2도 `app.getAppPath()/node_modules`, 즉 **앱의 것**만 썼다.
//! 3. **개발 실행은 안 잃는다.** 개발/벤치의 exe는 `<레포>/target*/…/`라 **exe 조상 사슬**이
//!    레포의 `node_modules`를 그대로 문다(cwd가 아니라 exe 위치가 근거였다).
//!
//! 남는 비결정 요소는 **exe 조상 사슬**뿐인데, 이건 「어디에 설치했는가」의 함수라 한 설치본
//! 안에서는 절대 안 흔들리고, 배포본에서는 사슬 첫 칸(= exe 폴더 = 번들 자리)이 항상 먼저
//! 맞는다. 개발 실행을 살리는 값이 그 사슬이라 남긴다.

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
///
/// **이 사슬에도 cwd는 없다** — 세 칸 다 「환경변수 · exe 위치 · PATH」라 프로세스를 어디서
/// 켰는지와 무관하다. 그래서 LSPDIST R1이 고친 것은 모듈 쪽 하나뿐이다.
///
/// [남은 구멍 · 정직하게] ②를 채우는 사람이 아직 없다 = 배포본은 **PATH의 node**에 기댄다.
/// 2.6.2는 Electron이 곧 Node라 전제가 0이었으므로 이건 파리티 후퇴가 맞다. 닫는 값은
/// 쟀다(`docs/parity-fix-lspdist-r1.md` §4): 고정 판 node.exe를 실으면 설치기 +21.8MB ·
/// 설치 폴더 +87.2MB. 이번 라운드가 안 실은 이유는 크기가 아니라 **재현성**이다 —
/// 빌더 PC의 `node.exe`를 집어넣으면 설치기가 빌드한 사람의 node 판에 따라 달라진다.
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

/// `node_modules`를 담고 있을 수 있는 폴더들 — **우선순위 순서**. 순수 함수라 테스트가
/// 가짜 exe 폴더를 먹여 사슬 전체를 통째로 대조할 수 있다(= cwd가 안 들어갔다는 증명).
///
/// | 칸 | 자리 | 누가 채우나 |
/// |---|---|---|
/// | ① | `explicit`(`CCG_LSP_MODULES`) | 벤치·포터블 배포. `env_path`가 `exists()`를 요구한다 |
/// | ② | **exe 폴더** | **배포본**. Tauri는 Windows에서 `bundle.resources`를 exe 폴더에 그대로 푼다(`tauri_utils::platform::resource_dir`: *"Windows also includes the resources in the executable folder"*) → `$INSTDIR\node_modules\…` |
/// | ③ | `exe 폴더/resources` | 비-Windows 번들 배치·수동 포터블 배치 |
/// | ④ | exe 폴더의 **조상들** | 개발·벤치(`<레포>/target*/release/` → `<레포>/node_modules`) |
///
/// **여기 없는 것: 프로세스 cwd.** 파일 머리말의 「LSPDIST R1」 참고 — 그 칸이 같은 exe·같은
/// 설치 자리에서 결과를 갈랐다.
fn module_roots_from(explicit: Option<PathBuf>, exe_dir: Option<PathBuf>) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    roots.extend(explicit);
    if let Some(d) = exe_dir {
        roots.push(d.clone()); // ② 배포본이 여기다 — 조상 사슬보다 **먼저** 본다
        roots.push(d.join("resources")); // ③
        let mut cur = d.parent(); // ④
        while let Some(c) = cur {
            roots.push(c.to_path_buf());
            cur = c.parent();
        }
    }
    roots
}

/// 실제 프로세스 상태로 만든 [`module_roots_from`].
fn module_roots() -> Vec<PathBuf> {
    module_roots_from(env_path("CCG_LSP_MODULES"), exe_dir())
}

fn find_module(roots: &[PathBuf], rel: &[&str]) -> Option<PathBuf> {
    roots
        .iter()
        .map(|base| rel.iter().fold(base.join("node_modules"), |a, s| a.join(s)))
        .find(|p| p.exists())
}

/// `node_modules/<rel…>` — 개발(레포)·배포(번들) 양쪽에서 찾는다. **cwd는 안 본다.**
pub fn shipped_module(rel: &[&str]) -> Option<PathBuf> {
    find_module(&module_roots(), rel)
}

/// 못 찾았을 때 화면·로그에 실을 진단 한 줄 — **어디를 봤는지**를 그대로 적는다.
///
/// §1.6-A2가 「제품 결함이지 측정 결함이 아니다」로 올라오기까지 오래 걸린 이유가 이거다:
/// 실패가 "번들 모듈을 못 찾음"까지만 말하고 **어느 자리를 봤는지**를 안 말했다. 그러면
/// 사용자도 다음 라운드의 나도 재현부터 다시 만들어야 한다.
pub fn module_search_hint() -> String {
    let roots = module_roots();
    let head: Vec<String> = roots.iter().take(4).map(|p| p.to_string_lossy().to_string()).collect();
    format!("찾아본 자리 {}곳: {}{}", roots.len(), head.join(" · "), if roots.len() > head.len() { " · …" } else { "" })
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

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ccg-lspdist-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn put(p: &Path) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, b"// fixture").unwrap();
    }

    /// ★ LSPDIST R1의 본체 — **사슬에 cwd가 없다.**
    ///
    /// 「없다」를 부정형으로 확인하면(`!roots.contains(cwd)`) 다음 사람이 칸을 하나 더
    /// 끼워 넣어도 안 걸린다. 그래서 **사슬 전체를 통째로 대조**한다 — 무엇이든 더해지면
    /// 이 테스트가 먼저 깨지고, 그때 이 파일 머리말을 읽게 된다.
    #[test]
    fn the_search_chain_is_exactly_exe_shaped_and_has_no_cwd() {
        let exe_dir = PathBuf::from(r"C:\Users\U\AppData\Local\AgentCodeGUI3");
        let got = module_roots_from(None, Some(exe_dir.clone()));
        assert_eq!(
            got,
            vec![
                exe_dir.clone(),                                  // ② 배포본(=$INSTDIR)
                exe_dir.join("resources"),                        // ③ 포터블/비-Windows
                PathBuf::from(r"C:\Users\U\AppData\Local"),       // ④ 조상들…
                PathBuf::from(r"C:\Users\U\AppData"),
                PathBuf::from(r"C:\Users\U"),
                PathBuf::from(r"C:\Users"),
                PathBuf::from(r"C:\"),
            ],
            "사슬이 바뀌었다. cwd를 되살렸다면 §1.4-b의 0.627/0.839 띠도 같이 살아난다"
        );
        // 명시 지정은 **맨 앞**이다(벤치가 이걸로 판을 갈아 끼운다).
        let ex = PathBuf::from(r"D:\repo");
        assert_eq!(module_roots_from(Some(ex.clone()), Some(exe_dir)).first(), Some(&ex));
    }

    /// 배포 모사 — 조상 어디에도 `node_modules`가 없고 exe 폴더에만 번들이 있는 자리.
    /// 이게 실패하면 시작 메뉴로 켠 배포본에서 TS·Python이 안 뜬다(= §1.6-A2 그대로).
    #[test]
    fn a_deployed_layout_resolves_from_the_exe_folder_alone() {
        let inst = scratch("deployed");
        put(&inst.join("node_modules").join("typescript").join("lib").join("tsserver.js"));
        put(&inst.join("node_modules").join("pyright").join("langserver.index.js"));
        let roots = module_roots_from(None, Some(inst.clone()));
        assert_eq!(
            find_module(&roots, &["typescript", "lib", "tsserver.js"]),
            Some(inst.join("node_modules").join("typescript").join("lib").join("tsserver.js"))
        );
        assert!(find_module(&roots, &["pyright", "langserver.index.js"]).is_some());
        // 안 실린 것은 그대로 없다 — 「못 찾음」이 조용히 다른 판을 물어오면 안 된다.
        assert_eq!(find_module(&roots, &["nope", "x.js"]), None);
        let _ = std::fs::remove_dir_all(&inst);
    }

    /// 개발 실행 — exe가 `<레포>/target*/release/`면 **조상 사슬**이 레포를 문다.
    /// (cwd를 지웠어도 개발이 안 깨진다는 근거가 이 테스트다.)
    #[test]
    fn a_dev_build_still_reaches_the_repo_node_modules_through_ancestors() {
        let repo = scratch("dev-repo");
        put(&repo.join("node_modules").join("typescript").join("lib").join("tsserver.js"));
        let exe_dir = repo.join("target-lspdist").join("release");
        std::fs::create_dir_all(&exe_dir).unwrap();
        let roots = module_roots_from(None, Some(exe_dir));
        assert_eq!(
            find_module(&roots, &["typescript", "lib", "tsserver.js"]),
            Some(repo.join("node_modules").join("typescript").join("lib").join("tsserver.js"))
        );
        let _ = std::fs::remove_dir_all(&repo);
    }

    /// 배포 자리에 번들이 실려 있으면 **조상에 무엇이 있어도** 번들이 이긴다.
    /// (설치 폴더를 하필 프로젝트 안에 잡은 포터블 사용자가 남의 TS 판을 물면 안 된다.)
    #[test]
    fn the_bundle_next_to_the_exe_wins_over_any_ancestor() {
        let root = scratch("bundle-wins");
        let inst = root.join("some-project").join("tools").join("AgentCodeGUI3");
        put(&root.join("some-project").join("node_modules").join("typescript").join("lib").join("tsserver.js"));
        put(&inst.join("node_modules").join("typescript").join("lib").join("tsserver.js"));
        let roots = module_roots_from(None, Some(inst.clone()));
        assert_eq!(
            find_module(&roots, &["typescript", "lib", "tsserver.js"]),
            Some(inst.join("node_modules").join("typescript").join("lib").join("tsserver.js"))
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 진단 문자열이 **실제로 자리를 말한다** — §1.6-A2가 늦게 발견된 이유가 이 침묵이었다.
    #[test]
    fn the_failure_hint_names_the_places_we_looked() {
        let h = module_search_hint();
        assert!(h.contains("찾아본 자리"), "{h}");
        assert!(h.contains(std::path::MAIN_SEPARATOR), "경로가 하나도 안 실렸다: {h}");
    }
}
