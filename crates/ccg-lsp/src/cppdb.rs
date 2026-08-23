//! clangd의 **컴파일 DB와 디스크 인덱스를 앱 홈에** 둔다 — 사용자 소스 트리는 안 건드린다.
//!
//! clangd는 `compile_commands.json`(각 .cpp의 인클루드 경로·매크로·플래그)이 있어야
//! 엔진/라이브러리 심볼을 해석하고, 그 **CDB 폴더 옆에** 디스크 인덱스(`.cache/clangd`,
//! 큰 프로젝트에서 수백 MB)를 쌓는다. 그래서 CDB를 어디에 두느냐가 곧 "사용자 폴더가
//! 더러워지는가"다. 2.6.2가 얻은 규약(그리고 3.0이 넓힌 것):
//!
//! | | 2.6.2 | 3.0 (여기) |
//! |---|---|---|
//! | UE 프로젝트(`.uproject`) | UBT `GenerateClangDatabase` → `<앱 홈>/lsp/ue-db/<이름>-<해시8>` | **같은 자리·같은 해시** — 2.6.2가 만들어 둔 DB를 그대로 쓴다 |
//! | 그 밖의 C/C++ | 손 안 댐(clangd가 소스 트리에서 찾고 `.cache/clangd`도 거기 쌓임) | 원본 CDB를 `<앱 홈>/lsp/cpp-db/<이름>-<해시8>`로 **미러** → 인덱스도 앱 홈에 |
//!
//! 해시는 2.6.2 `ueDbDir`과 **바이트 호환**이다: `sha1(소문자 절대경로)[..8]`.
//! (실측: `C:\Code\ElmwoodOnline` → `683b8183` — 실홈에 이미 그 이름으로 있다.)
//!
//! 이 파일에는 **엔진이 부르는 진입점이 하나뿐**이다([`prepare`]) — 스펙의
//! [`crate::spec::ServerSpec::prepare_root`]가 그것을 가리킨다. 엔진은 "준비해라, 새로
//! 생겼으면 말해라"만 알고 UE도 clangd도 모른다.

use crate::sha1::sha1_hex;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

/// UBT가 한 번도 안 빌드된 프로젝트에서 UHT 코드 생성까지 도는 경우가 있다(2.6.2와 같은 10분).
const UBT_TIMEOUT_SECS: u64 = 600;
/// 조상 워크 상한(2.6.2 `ueRoot` 16단).
const WALK_UP: usize = 16;

pub const CDB_NAME: &str = "compile_commands.json";

/// 테스트가 앱 홈을 갈아 끼우는 문 — 단위 테스트가 사용자 홈에 쓰면 안 된다
/// (`semcache`와 같은 규약: 환경 변수를 안 쓴다. `set_var`는 스레드가 도는 테스트에서 위험하다).
#[cfg(test)]
static TEST_HOME: std::sync::OnceLock<std::sync::Mutex<Option<PathBuf>>> = std::sync::OnceLock::new();

fn lsp_home() -> PathBuf {
    #[cfg(test)]
    if let Some(p) = TEST_HOME.get_or_init(Default::default).lock().unwrap().clone() {
        return p.join("lsp");
    }
    ccg_store::app_home().join("lsp")
}

/// `extra_args`가 **마지막으로 본** CDB 시각 = 지금 뜨는/떠 있는 clangd가 아는 DB.
/// [`prepare`]가 "재기동이 필요한가"를 이 값과 비교해 정한다.
fn last_seen() -> &'static std::sync::Mutex<std::collections::HashMap<String, u64>> {
    static M: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, u64>>> =
        std::sync::OnceLock::new();
    M.get_or_init(Default::default)
}

fn root_key(root: &Path) -> String {
    crate::normalize(root).to_string_lossy().to_ascii_lowercase()
}

fn mtime_ms(p: &Path) -> u64 {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `dir`에서 위로 올라가며 `.uproject`가 있는 첫 폴더 — 없으면 `None`.
/// 하위 폴더(`Plugins/…/Source`)를 열어도 프로젝트 루트를 찾아 **항상 같은 ue-db로**
/// 라우팅되게 한다(2.6.2 `ueRoot` — 안 그러면 clangd가 트리를 오염시킨다).
///
/// **폴더별로 메모한다**(2.6.2 `ueDirMemo`와 같은 이유, 그리고 R4가 실측으로 다시 배운 것):
/// 이 함수는 `lsp:status`가 400ms마다 밟는 경로에 있고, 조상 워크는 **부모 폴더를 통째로
/// 읽는다**. 이 기계의 `%TEMP%`에는 항목이 **49,370개** 있었고, 거기 아래에서 연 프로젝트는
/// 폴링 한 번마다 그걸 두 번씩 읽었다 — 첫 `ready`가 2.6.2의 262ms 대 578ms로 벌어진
/// 원인이 정확히 이것이다(메모를 넣고 다시 재면 아래 표).
pub fn ue_root(dir: &Path) -> Option<PathBuf> {
    static MEMO: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, Option<PathBuf>>>> =
        std::sync::OnceLock::new();
    let start = crate::normalize(dir);
    let key = start.to_string_lossy().to_ascii_lowercase();
    let memo = MEMO.get_or_init(Default::default);
    if let Some(v) = memo.lock().unwrap().get(&key) {
        return v.clone();
    }
    let mut d = start;
    let mut found = None;
    for _ in 0..WALK_UP {
        if let Ok(rd) = std::fs::read_dir(&d) {
            if rd.flatten().any(|e| has_ext(&e.path(), "uproject")) {
                found = Some(d);
                break;
            }
        }
        let Some(parent) = d.parent().map(Path::to_path_buf) else { break };
        if parent == d {
            break;
        }
        d = parent;
    }
    let mut m = memo.lock().unwrap();
    if m.len() > 512 {
        m.clear();
    }
    m.insert(key, found.clone());
    found
}

fn has_ext(p: &Path, ext: &str) -> bool {
    p.extension().and_then(|s| s.to_str()).map(|e| e.eq_ignore_ascii_case(ext)).unwrap_or(false)
}

/// 이 루트의 CDB·인덱스를 둘 앱 홈 폴더. UE면 2.6.2와 **같은 자리**(`ue-db`), 아니면 `cpp-db`.
/// 폴더 이름 = `<basename>-<sha1(소문자 절대경로)[..8]>` — 프로젝트끼리 안 섞인다.
pub fn db_dir(root: &Path) -> PathBuf {
    let (bucket, base) = match ue_root(root) {
        Some(ur) => ("ue-db", ur),
        None => ("cpp-db", crate::normalize(root)),
    };
    lsp_home().join(bucket).join(db_folder_name(&base))
}

/// 2.6.2 `ueDbDir`의 폴더 이름 규칙(그 값이 곧 캐시 호환의 열쇠다).
pub fn db_folder_name(abs: &Path) -> String {
    let s = abs.to_string_lossy();
    let hash = sha1_hex(&[s.to_lowercase().as_bytes()]);
    let base = abs
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|n| !n.is_empty())
        .unwrap_or("root");
    format!("{base}-{}", &hash[..8])
}

/// clangd에 실제로 물릴 CDB 파일(있을 때만) — 스펙의 `extra_args`가 이걸 본다.
///
/// **싼 준비(원본 CDB 미러)는 여기서 한다.** 그래야 첫 스폰이 처음부터 옳은 인자로 뜨고
/// 쓸데없는 재기동이 안 생긴다(R4 실측: 미러를 백그라운드로만 하면 첫 clangd가 인자 없이
/// 떴다가 곧바로 접히고 다시 떠서, 첫 `ready`가 그만큼 늦는다). 비싼 준비(UBT 생성)는
/// [`prepare`]가 백그라운드에서 맡는다 — 여기서 하면 400ms 폴링이 수 분 멈춘다.
pub fn db_file(root: &Path) -> Option<PathBuf> {
    mirror_project_cdb(root);
    let p = db_dir(root).join(CDB_NAME);
    let t = mtime_ms(&p);
    last_seen().lock().unwrap().insert(root_key(root), t);
    (t != 0).then_some(p)
}

/// 이 루트의 **원본** CDB — 멤버십 감시가 보는 파일.
/// UE면 우리가 만든 그 파일이고(= db_file), 아니면 프로젝트 안에 있는 것.
pub fn source_cdb(root: &Path) -> Option<PathBuf> {
    if ue_root(root).is_some() {
        let p = db_dir(root).join(CDB_NAME);
        return p.is_file().then_some(p);
    }
    project_cdb(root)
}

/// 프로젝트 트리 안의 `compile_commands.json` — 흔한 자리만 본다(전 트리를 걷지 않는다).
/// CMake는 빌드 폴더에 떨구고(`build/`·`out/build/<preset>/`), 손으로 만든 것은 루트에 둔다.
fn project_cdb(root: &Path) -> Option<PathBuf> {
    let direct = [
        root.join(CDB_NAME),
        root.join("build").join(CDB_NAME),
        root.join(".build").join(CDB_NAME),
        root.join("cmake-build-debug").join(CDB_NAME),
        root.join("cmake-build-release").join(CDB_NAME),
    ];
    if let Some(p) = direct.into_iter().find(|p| p.is_file()) {
        return Some(p);
    }
    // `out/build/<preset>/compile_commands.json` (VS의 CMake 기본) — 한 단만 내려간다
    let mut best: Option<(PathBuf, u64)> = None;
    for parent in [root.join("out").join("build"), root.join("build")] {
        let Ok(rd) = std::fs::read_dir(&parent) else { continue };
        for e in rd.flatten() {
            let p = e.path().join(CDB_NAME);
            if !p.is_file() {
                continue;
            }
            let t = mtime_ms(&p);
            if best.as_ref().map(|b| t > b.1).unwrap_or(true) {
                best = Some((p, t));
            }
        }
    }
    best.map(|(p, _)| p)
}

// ── 스펙이 부르는 진입점 ─────────────────────────────────────────────────────
/// 이 루트의 CDB를 **앱 홈에 준비**한다. 반환 `true` = 파일이 새로 생기거나 갈렸다
/// (= 지금 떠 있는 clangd는 낡은 인자로 떴다 → 엔진이 그 서버를 접는다).
///
/// 오래 걸릴 수 있다(UBT는 수 초~수 분). 엔진은 이 함수를 **백그라운드 스레드에서 루트당
/// 한 번** 부른다([`crate::manager`]).
pub fn prepare(root: &Path) -> bool {
    match ue_root(root) {
        Some(ur) => generate_ue(&ur),
        None => mirror_project_cdb(root),
    }
    // "재기동이 필요한가" = **지금 서버가 물고 간 DB와 다른가**. 준비 전후의 mtime을 비교하면
    // `db_file`(스폰 스레드)의 미러와 경쟁해 헛재기동이 난다 — 어느 쪽이 먼저 돌든 답이
    // 같아야 하므로, 기준을 시간이 아니라 **인자를 만든 쪽이 본 값**으로 잡는다.
    // `None`(아직 아무도 인자를 안 만들었다) = 곧 뜰 서버가 새 DB를 그대로 물고 간다 → 재기동 불필요.
    let now = mtime_ms(&db_dir(root).join(CDB_NAME));
    matches!(last_seen().lock().unwrap().get(&root_key(root)), Some(&seen) if seen != now)
}

/// 일반 C++ 프로젝트의 CDB를 앱 홈으로 미러(UE는 우리가 그 자리에 직접 만들므로 대상 아님).
fn mirror_project_cdb(root: &Path) {
    if ue_root(root).is_some() {
        return;
    }
    let Some(src) = project_cdb(root) else { return };
    mirror(&src, &db_dir(root).join(CDB_NAME));
}

/// 원본 CDB를 앱 홈으로 복사한다(원본이 더 새로울 때만).
/// **경로가 전부 절대라 복사본이 그대로 유효하다** — CDB의 `directory`/`file`/`command`는
/// 생성기(CMake·UBT)가 절대 경로로 쓴다. 그래서 clangd가 앱 홈의 사본을 읽어도 소스를 찾고,
/// 인덱스(`.cache/clangd`)는 그 사본 옆(=앱 홈)에 쌓인다.
fn mirror(src: &Path, dst: &Path) {
    if mtime_ms(src) <= mtime_ms(dst) {
        return;
    }
    let Some(parent) = dst.parent() else { return };
    if std::fs::create_dir_all(parent).is_err() {
        return;
    }
    // 임시 파일 → rename. 반쯤 쓰인 CDB를 clangd가 읽으면 그 프로젝트가 통째로 무색이 된다.
    let tmp = dst.with_extension("json.tmp");
    if std::fs::copy(src, &tmp).is_ok() {
        let _ = std::fs::rename(&tmp, dst);
    }
    let _ = std::fs::remove_file(&tmp);
}

// ── UE: UnrealBuildTool GenerateClangDatabase (2.6.2 `ue.ts`의 이식) ──────────
/// 이미 신선하면 아무것도 안 한다. 갱신 기준(2.6.2와 같다): DB가 없거나, 구조 파일
/// (`.uproject`/`.uplugin`/`*.Build.cs`/`*.Target.cs`)이 DB보다 새로울 때.
/// **새 .cpp 추가만으로는 재생성하지 않는다** — clangd가 DB에 없는 파일의 플래그를 같은
/// 모듈의 이웃에서 추론한다.
fn generate_ue(root: &Path) {
    if !cfg!(windows) {
        return;
    }
    let Some(uproject) = first_with_ext(root, "uproject") else { return };
    let dir = lsp_home().join("ue-db").join(db_folder_name(root));
    let db = dir.join(CDB_NAME);
    let db_at = mtime_ms(&db);
    if db_at != 0 && db_at >= newest_structure_mtime(root, &uproject) {
        return; // fresh
    }
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let Some(target) = editor_target(root) else {
        log(&format!("에디터 타깃(.Target.cs)을 못 찾음: {}", root.display()));
        return;
    };
    let Some(engine) = engine_root(&engine_association(&uproject), root) else {
        log(&format!("엔진 설치를 못 찾음: {}", uproject.display()));
        return;
    };
    let Some(ubt) = [
        engine.join("Engine/Binaries/DotNET/UnrealBuildTool/UnrealBuildTool.exe"), // UE5
        engine.join("Engine/Binaries/DotNET/UnrealBuildTool.exe"),                 // UE4
    ]
    .into_iter()
    .find(|p| p.is_file()) else {
        log(&format!("UnrealBuildTool.exe 없음: {}", engine.display()));
        return;
    };
    let base: Vec<String> = vec![
        "-mode=GenerateClangDatabase".into(),
        format!("-project={}", uproject.display()),
        target,
        "Win64".into(),
        "Development".into(),
        format!("-OutputDir={}", dir.display()),
    ];
    // ''(기본 = Clang, 있으면 최상) → MSVC 폴백. Windows에 LLVM 툴체인이 없는 게 보통이라
    // 기본 그대로는 "Clang x64 must be installed"로 즉사한다. clangd는 cl.exe 명령줄도
    // 해석하므로(clang-cl 드라이버 모드) MSVC DB로도 충분하다. 실패는 툴체인 탐지 단계에서
    // 1초 안에 끝나 폴백 비용이 거의 없다. 모르는 enum 값은 인자 파싱에서 바로 실패한다.
    for compiler in ["", "VisualStudio2026", "VisualStudio2022"] {
        let mut args = base.clone();
        if !compiler.is_empty() {
            args.push(format!("-Compiler={compiler}"));
        }
        if run_logged(&ubt, &args) {
            return;
        }
    }
}

fn first_with_ext(dir: &Path, ext: &str) -> Option<PathBuf> {
    let mut v: Vec<PathBuf> =
        std::fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).filter(|p| has_ext(p, ext)).collect();
    v.sort();
    v.into_iter().next()
}

/// 구조 파일 중 가장 최근 수정 시각 — DB 신선도 기준(2.6.2 `newestStructureMtime`).
fn newest_structure_mtime(root: &Path, uproject: &Path) -> u64 {
    let mut newest = mtime_ms(uproject);
    for sub in ["Source", "Plugins"] {
        scan_structure(&root.join(sub), 0, &mut newest);
    }
    newest
}

fn scan_structure(dir: &Path, depth: u32, newest: &mut u64) {
    if depth > 6 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_ascii_lowercase();
        if p.is_dir() {
            // 빌드 산출물·콘텐츠는 구조와 무관 — 큰 프로젝트에서 스캔을 가볍게 유지한다
            if matches!(
                name.as_str(),
                "intermediate" | "binaries" | "saved" | "content" | "deriveddatacache" | ".git"
            ) {
                continue;
            }
            scan_structure(&p, depth + 1, newest);
        } else if name.ends_with(".build.cs") || name.ends_with(".target.cs") || name.ends_with(".uplugin") {
            let t = mtime_ms(&p);
            if t > *newest {
                *newest = t;
            }
        }
    }
}

/// `Source/*.Target.cs` → 에디터 타깃 이름(Editor 우선, 없으면 첫 타깃).
fn editor_target(root: &Path) -> Option<String> {
    let mut targets: Vec<String> = std::fs::read_dir(root.join("Source"))
        .ok()?
        .flatten()
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .filter(|n| n.to_ascii_lowercase().ends_with(".target.cs"))
        .collect();
    targets.sort();
    let pick = targets
        .iter()
        .find(|n| n.to_ascii_lowercase().ends_with("editor.target.cs"))
        .or_else(|| targets.first())?;
    Some(pick[..pick.len() - ".target.cs".len()].to_string())
}

fn engine_association(uproject: &Path) -> String {
    let Ok(txt) = std::fs::read_to_string(uproject) else { return String::new() };
    serde_json::from_str::<serde_json::Value>(&txt)
        .ok()
        .and_then(|j| j.get("EngineAssociation").and_then(|v| v.as_str()).map(str::to_string))
        .unwrap_or_default()
}

/// `.uproject`의 EngineAssociation → 엔진 설치 경로(2.6.2 `engineRoot`).
/// "5.8" 같은 버전은 런처 레지스트리 → 런처 설치 목록 → Program Files 추측 순서로 찾고
/// (레지스트리에 키가 없는 버전이 흔하다 — 이 기계도 5.8 키가 없었다), GUID는 소스 빌드
/// 레지스트리, 빈 값(엔진 옆에 둔 프로젝트)은 상위 폴더에서 `Engine/`을 찾는다.
fn engine_root(assoc: &str, root: &Path) -> Option<PathBuf> {
    let numeric = !assoc.is_empty()
        && assoc.split('.').count() == 2
        && assoc.split('.').all(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()));
    if numeric {
        if let Some(p) = reg_query(
            &format!("HKLM\\SOFTWARE\\EpicGames\\Unreal Engine\\{assoc}"),
            "InstalledDirectory",
        ) {
            if p.is_dir() {
                return Some(p);
            }
        }
        if let Some(p) = launcher_engine(assoc) {
            return Some(p);
        }
        let guess = PathBuf::from("C:\\Program Files\\Epic Games").join(format!("UE_{assoc}"));
        if guess.is_dir() {
            return Some(guess);
        }
    } else if !assoc.is_empty() {
        if let Some(p) = reg_query("HKCU\\Software\\Epic Games\\Unreal Engine\\Builds", assoc) {
            if p.is_dir() {
                return Some(p);
            }
        }
    }
    let mut d = crate::normalize(root);
    for _ in 0..6 {
        let parent = d.parent()?.to_path_buf();
        if parent == d {
            break;
        }
        d = parent;
        if d.join("Engine").join("Build").join("BatchFiles").is_dir() {
            return Some(d);
        }
    }
    None
}

/// 에픽 런처의 설치 목록 — "5.8"을 AppName `UE_5.8`로 찾는다.
fn launcher_engine(assoc: &str) -> Option<PathBuf> {
    let dat = PathBuf::from(std::env::var("ProgramData").unwrap_or_else(|_| "C:\\ProgramData".into()))
        .join("Epic")
        .join("UnrealEngineLauncher")
        .join("LauncherInstalled.dat");
    let j: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dat).ok()?).ok()?;
    let want = format!("UE_{assoc}");
    let loc = j
        .get("InstallationList")?
        .as_array()?
        .iter()
        .find(|e| e.get("AppName").and_then(|v| v.as_str()) == Some(want.as_str()))?
        .get("InstallLocation")?
        .as_str()?;
    let p = PathBuf::from(loc);
    p.is_dir().then_some(p)
}

fn reg_query(key: &str, value: &str) -> Option<PathBuf> {
    let out = hidden(Command::new("reg"))
        .args(["query", key, "/v", value])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    // "    InstalledDirectory    REG_SZ    C:\Program Files\..." 모양의 줄
    let line = text
        .lines()
        .find(|l| l.trim().to_ascii_lowercase().starts_with(&value.to_ascii_lowercase()))?;
    let v = line.split("REG_SZ").nth(1)?.trim();
    (!v.is_empty()).then(|| PathBuf::from(v))
}

#[cfg(windows)]
fn hidden(mut c: Command) -> Command {
    use std::os::windows::process::CommandExt;
    c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    c
}
#[cfg(not(windows))]
fn hidden(c: Command) -> Command {
    c
}

/// UBT 한 번 — 성공/실패와 출력 꼬리를 로그에 남긴다(실패가 침묵하지 않게).
fn run_logged(ubt: &Path, args: &[String]) -> bool {
    let mut child = match hidden(Command::new(ubt))
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            log(&format!("$ {} {}\n→ 실행 실패: {e}", ubt.display(), args.join(" ")));
            return false;
        }
    };
    // stdout/stderr는 **반드시 읽는다** — 안 읽으면 파이프가 차서 UBT가 멈춘다.
    let mut out = child.stdout.take();
    let mut err = child.stderr.take();
    let tail = std::thread::spawn(move || {
        use std::io::Read;
        let mut s = String::new();
        if let Some(o) = out.as_mut() {
            let _ = o.read_to_string(&mut s);
        }
        if let Some(e) = err.as_mut() {
            let _ = e.read_to_string(&mut s);
        }
        s
    });
    let deadline = SystemTime::now() + std::time::Duration::from_secs(UBT_TIMEOUT_SECS);
    let code = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st.code().unwrap_or(-1),
            Ok(None) => {}
            Err(_) => break -1,
        }
        if SystemTime::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            log(&format!("$ {} {}\n→ 시간 초과({UBT_TIMEOUT_SECS}s), 중단", ubt.display(), args.join(" ")));
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    };
    let text = tail.join().unwrap_or_default();
    let cut = text.len().saturating_sub(4096);
    log(&format!("$ {} {}\n{}\n→ exit {code}", ubt.display(), args.join(" "), &text[cut..]));
    code == 0
}

/// 2.6.2와 같은 자리(`<앱 홈>/lsp/ue-clangdb.log`) · 같은 단순 로테이션(256KB).
fn log(text: &str) {
    let f = lsp_home().join("ue-clangdb.log");
    let Some(parent) = f.parent() else { return };
    let _ = std::fs::create_dir_all(parent);
    if std::fs::metadata(&f).map(|m| m.len() > 256 * 1024).unwrap_or(false) {
        let _ = std::fs::remove_file(&f);
    }
    use std::io::Write;
    if let Ok(mut h) = std::fs::OpenOptions::new().create(true).append(true).open(&f) {
        let _ = writeln!(h, "[{}] {text}\n", stamp());
    }
}

fn stamp() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    format!("epoch+{secs}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ccg-lsp-cppdb-{name}"));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn put(p: &Path, body: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }

    /// **2.6.2와 바이트 호환** — 이 값이 달라지면 사용자가 이미 만들어 둔 UE DB를 3.0이
    /// 못 찾고 UBT를 처음부터 다시 돌린다(수 분). 실홈의 실제 폴더 이름으로 못 박는다.
    #[test]
    fn db_folder_name_matches_262_ue_db() {
        assert_eq!(db_folder_name(Path::new("C:\\Code\\ElmwoodOnline")), "ElmwoodOnline-683b8183");
        assert_eq!(db_folder_name(Path::new("C:\\Code\\UE6Study")), "UE6Study-de63668c");
        // 대소문자는 해시에 안 들어간다(경로 표기가 흔들려도 같은 폴더)
        assert_eq!(
            db_folder_name(Path::new("c:\\code\\ue6study")).split('-').next_back(),
            Some("de63668c")
        );
    }

    /// `.uproject` 조상을 하위 폴더에서도 찾는다 — 못 찾으면 clangd가 소스 트리를 오염시킨다.
    #[test]
    fn ue_root_walks_up_to_the_uproject() {
        let w = scratch("ueroot");
        put(&w.join("Game.uproject"), "{}");
        put(&w.join("Source/Game/Private/A.cpp"), "int main(){}");
        assert_eq!(ue_root(&w.join("Source/Game/Private")), Some(crate::normalize(&w)));
        assert_eq!(ue_root(&w), Some(crate::normalize(&w)));
        // UE가 아닌 트리는 None → cpp-db 쪽으로 간다
        let plain = scratch("plain");
        assert_eq!(ue_root(&plain), None);
        assert!(db_dir(&plain).to_string_lossy().contains("cpp-db"));
    }

    /// UE 루트의 DB 폴더는 **2.6.2가 쓰는 자리**(`lsp/ue-db/...`)여야 한다.
    #[test]
    fn ue_project_uses_the_262_bucket() {
        let w = scratch("uebucket");
        put(&w.join("Game.uproject"), "{}");
        let d = db_dir(&w.join("Source"));
        assert!(d.to_string_lossy().contains("ue-db"), "{d:?}");
        assert!(d.ends_with(db_folder_name(&crate::normalize(&w))), "{d:?}");
    }

    /// 일반 C++ 프로젝트: 원본 CDB를 앱 홈으로 미러하고, **원본이 더 새로울 때만** 다시 쓴다
    /// (매번 쓰면 멤버십 폴러가 자기 복사에 반응해 무한 재통지를 돈다).
    #[test]
    fn mirror_copies_once_and_only_when_newer() {
        let w = scratch("mirror");
        let src = w.join(CDB_NAME);
        put(&src, "[]");
        let dst = w.join("out").join(CDB_NAME);
        mirror(&src, &dst);
        assert_eq!(std::fs::read_to_string(&dst).unwrap(), "[]");
        let first = mtime_ms(&dst);
        // 원본이 그대로면 안 건드린다
        mirror(&src, &dst);
        assert_eq!(mtime_ms(&dst), first);
        // 임시 파일을 남기지 않는다
        assert!(!dst.with_extension("json.tmp").exists());
    }

    /// CMake의 흔한 자리들을 찾는다(루트·build·out/build/<preset>).
    #[test]
    fn project_cdb_finds_the_usual_places() {
        let w = scratch("findcdb");
        assert_eq!(project_cdb(&w), None);
        put(&w.join("out/build/x64-debug").join(CDB_NAME), "[]");
        assert_eq!(project_cdb(&w), Some(w.join("out/build/x64-debug").join(CDB_NAME)));
        // 루트에 있으면 그쪽이 이긴다(손으로 둔 것이 진실)
        put(&w.join(CDB_NAME), "[]");
        assert_eq!(project_cdb(&w), Some(w.join(CDB_NAME)));
    }

    /// **헛재기동을 안 한다.** 첫 스폰이 인자를 만드는 순간(`db_file`) 미러가 이미 끝나므로,
    /// 곧이어 도는 `prepare`는 "바뀐 것 없음"이어야 한다 — 아니면 방금 뜬 clangd가 그대로
    /// 접히고 다시 뜬다(R4 첫 주행에서 실제로 그랬다).
    #[test]
    fn prepare_does_not_ask_for_a_restart_that_is_not_needed() {
        let w = scratch("nokick");
        let home = scratch("nokick-home");
        *TEST_HOME.get_or_init(Default::default).lock().unwrap() = Some(home.clone());
        put(&w.join(CDB_NAME), "[]");
        // ① 인자를 만드는 쪽이 먼저 — 미러가 여기서 끝나고, 인자에 앱 홈이 실린다
        let f = db_file(&w).expect("미러가 안 됐다");
        assert!(f.starts_with(&home), "{f:?}");
        assert!(!f.starts_with(&w), "compile DB가 프로젝트 안이면 인덱스도 거기 쌓인다");
        // ② 뒤따르는 준비는 재기동을 요구하지 않는다
        assert!(!prepare(&w), "헛재기동");
        // ③ 원본이 갈리면(외부 빌드) 그때는 요구한다
        std::thread::sleep(std::time::Duration::from_millis(20));
        put(&w.join(CDB_NAME), "[{}]");
        assert!(prepare(&w), "CDB가 갈렸는데 재기동을 안 건다");
        // ④ 재기동 뒤 새 인자를 만들면 다시 조용해진다
        db_file(&w);
        assert!(!prepare(&w));
        *TEST_HOME.get_or_init(Default::default).lock().unwrap() = None;
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 에디터 타깃 고르기 — Editor가 있으면 그것, 없으면 첫 타깃.
    #[test]
    fn editor_target_prefers_the_editor_one() {
        let w = scratch("target");
        put(&w.join("Source/Game.Target.cs"), "x");
        assert_eq!(editor_target(&w).as_deref(), Some("Game"));
        put(&w.join("Source/GameEditor.Target.cs"), "x");
        assert_eq!(editor_target(&w).as_deref(), Some("GameEditor"));
    }
}
