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
/// ## ★ LSPDIST R2 — 사이드카를 실었고 배포본에서 PATH를 끊었다
///
/// R1은 모듈만 싣고 런타임은 **PATH**에 기댔다. 확인 크리틱 R1 §1.2가 그 대가를 실측했다:
/// PATH에서 node를 걷어낸 기계 모사에서 **두 언어 × 두 cwd 네 팔 전부 `error`**,
/// 그리고 `<설치 폴더>\node.exe` **한 파일**을 두면 두 언어가 즉시 `ready`.
/// 즉 빠진 것은 코드가 아니라 적재물이었다. R2가 그 파일을 싣는다
/// (`scripts/tauri-build.mjs`의 판 고정 + sha256 검증 스테이징 → `bundle.resources`).
///
/// 사슬은 이제 **전부 exe 경로의 함수**다 — 기계의 PATH 상태가 배포본의 코드 인텔리전스를
/// 못 흔든다(nvm이 판을 갈아 끼워도 우리 서버는 고정 판 위에서 돈다):
///
/// | 칸 | 자리 | 누가 채우나 |
/// |---|---|---|
/// | ① | `CCG_LSP_NODE` | 벤치·포터블·하네스 |
/// | ② | **exe 폴더 / exe 폴더의 `resources`** | **배포본** — 스테이징한 고정 판이 `$INSTDIR\node.exe`로 깔린다 |
/// | ③ | exe **조상**의 `src-tauri/lsp-runtime/node.exe` | 개발·벤치 — 같은 스테이징 산출물을 레포 안에서 그대로 문다 |
/// | ④ | PATH — **exe가 cargo 산출 폴더에 있을 때만** | 스테이징을 아직 안 돌린 `cargo run` 개발자 |
///
/// **④가 배포본에 절대 안 닿는 이유**: 판정을 `.cargo-lock`(cargo가 프로필 폴더에 두는
/// 잠금 파일)의 존재로 한다 — `tauri_utils::platform::resource_dir`가 「개발 중인가」를
/// 가르는 데 쓰는 바로 그 신호다. NSIS가 깐 `$INSTDIR`에는 그 파일이 없다. 그래서 이 칸은
/// **exe 경로의 함수**이지 환경의 함수가 아니고, 크리틱이 요구한 결정론을 안 깬다
/// (테스트 `path_fallback_is_unreachable_for_a_deployed_exe`).
///
/// [남은 위험 · 정직하게] 사이드카가 **없어진** 설치본(백신 격리 등)은 이제 PATH로 못
/// 살아난다 — 조용히 다른 판을 무는 대신 **소리 내어 죽는다**. 그 교환은 의도한 것이고,
/// 실패 문자열이 사이드카 경로를 지목한다(`crate::server::plan`).
pub fn node_exe() -> Option<PathBuf> {
    node_exe_from(env_path("CCG_LSP_NODE"), exe_dir())
}

/// [`node_exe`]의 순수 알맹이 — 테스트가 가짜 exe 폴더를 먹인다.
fn node_exe_from(explicit: Option<PathBuf>, exe_dir: Option<PathBuf>) -> Option<PathBuf> {
    // ① 명시 지정(벤치·포터블 배포)
    if let Some(p) = explicit {
        return Some(p);
    }
    let Some(d) = exe_dir else { return None };
    // ② exe 옆 사이드카 — **배포본이 여기다**
    for rel in [["node.exe"].as_slice(), ["resources", "node.exe"].as_slice()] {
        let p = rel.iter().fold(d.clone(), |a, s| a.join(s));
        if p.is_file() {
            return Some(p);
        }
    }
    // ③ 개발 — exe 조상의 스테이징 산출물(`npm run tauri:build`가 만든 그 파일)
    let mut cur: Option<&Path> = Some(&d);
    while let Some(c) = cur {
        let p = c.join("src-tauri").join(STAGED_RUNTIME_DIR).join("node.exe");
        if p.is_file() {
            return Some(p);
        }
        cur = c.parent();
    }
    // ④ PATH — **cargo 산출 폴더에서 뜬 exe일 때만**(배포본은 절대 여기 못 온다)
    if is_cargo_output_dir(&d) {
        return which("node.exe").or_else(|| which("node"));
    }
    None
}

/// 스테이징 자리 이름 — `scripts/tauri-build.mjs`와 `tauri.conf.json`이 쓰는 그 이름.
/// 세 곳이 같아야 개발(③)과 배포(②)가 같은 파일을 문다.
pub const STAGED_RUNTIME_DIR: &str = "lsp-runtime";

/// 이 폴더가 **cargo 산출 폴더**인가 — `target*/<profile>/`에 cargo가 남기는 `.cargo-lock`.
/// `tauri_utils::platform::resource_dir`의 `is_cargo_output_directory`와 같은 신호다.
fn is_cargo_output_dir(dir: &Path) -> bool {
    dir.join(".cargo-lock").exists()
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

    /// ★ LSPDIST R2 · 크리틱 C4 — **못을 한 층 위로.**
    ///
    /// R1의 사슬 대조는 순수 함수 `module_roots_from`만 물었다. 크리틱이 실측한 대로
    /// **한 층 위 `module_roots()`에 cwd를 되살리면 그 테스트는 초록**이었고, 하필 거기가
    /// 옛 결함(`09b9bc7`의 `shipped_module()` 본문)이 살던 자리다. 여기서는 공개 층이
    /// **순수 층에 아무것도 더하지 않는다**를 요구한다 — 어느 칸을 끼워 넣어도 두 값이 갈린다.
    ///
    /// (블랙박스 쪽 못은 `tests/cwd_is_never_consulted.rs`가 따로 박는다 — 그쪽은 진짜로
    /// 프로세스 cwd를 미끼 폴더로 바꿔 놓고 `shipped_module()`에 직접 묻는다.)
    #[test]
    fn the_public_layer_adds_nothing_to_the_pure_chain() {
        assert_eq!(
            module_roots(),
            module_roots_from(env_path("CCG_LSP_MODULES"), exe_dir()),
            "module_roots()가 순수 사슬에 칸을 더했다 — cwd가 되살아났는지부터 봐라"
        );
    }

    /// ★ R2 — 런타임 사슬도 **exe 경로의 함수**다. 배포 모사 exe 폴더에 사이드카를 두면
    /// 그것을 물고, 없으면 조상의 스테이징 산출물을 물고, 그것도 없으면 **PATH로 안 간다.**
    #[test]
    fn the_node_chain_prefers_the_sidecar_then_the_staged_dev_copy() {
        let root = scratch("node-chain");
        let inst = root.join("AgentCodeGUI3");
        std::fs::create_dir_all(&inst).unwrap();
        // ③ 개발 스테이징 산출물(조상에 있다)
        let staged = root.join("src-tauri").join(STAGED_RUNTIME_DIR).join("node.exe");
        put(&staged);
        assert_eq!(node_exe_from(None, Some(inst.clone())), Some(staged), "조상의 스테이징 산출물을 문다");
        // ② 사이드카가 생기면 그쪽이 이긴다(배포본)
        let side = inst.join("node.exe");
        put(&side);
        assert_eq!(node_exe_from(None, Some(inst.clone())), Some(side.clone()), "사이드카가 최우선");
        // ① 명시 지정이 그보다 앞
        let ex = root.join("elsewhere.exe");
        put(&ex);
        assert_eq!(node_exe_from(Some(ex.clone()), Some(inst)), Some(ex));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// ★ R2 · 결정론의 못 — **배포본 모양의 exe 폴더에서는 PATH 칸에 못 간다.**
    /// (`.cargo-lock`이 없으면 cargo 산출 폴더가 아니다 = NSIS가 깐 `$INSTDIR`.)
    #[test]
    fn path_fallback_is_unreachable_for_a_deployed_exe() {
        let root = scratch("no-path-fallback");
        let inst = root.join("AgentCodeGUI3");
        std::fs::create_dir_all(&inst).unwrap();
        assert!(!is_cargo_output_dir(&inst), "설치 폴더에는 .cargo-lock이 없다");
        assert_eq!(
            node_exe_from(None, Some(inst.clone())),
            None,
            "사이드카가 없는 배포본은 **소리 내어 죽어야** 한다 — PATH의 아무 node나 물면 안 된다"
        );
        // 같은 폴더가 cargo 산출 폴더면(개발) 그때만 PATH를 본다.
        put(&inst.join(".cargo-lock"));
        assert!(is_cargo_output_dir(&inst));
        // 이 기계에 node가 있으면 Some, 없으면 None — 어느 쪽이든 **위와 달라질 수 있는 칸**이
        // 열렸다는 것만 확인한다(PATH 유무는 기계의 사정이라 값으로 못 박지 않는다).
        let opened = node_exe_from(None, Some(inst.clone()));
        assert_eq!(opened.is_some(), which("node.exe").or_else(|| which("node")).is_some());
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
