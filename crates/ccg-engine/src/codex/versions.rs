//! Codex CLI **버전 관리** — 2.6.2 `src/main/codex/versions.ts` 이식.
//!
//! 앱 홈에 버전별로 `npm install @openai/codex`를 깔고 그 실행본으로 돈다. 시스템 전역
//! `codex`는 건드리지 않는다(설치본이 없을 때만 PATH 폴백 — Claude와 다른 점은 "번들이
//! 없다"는 것 하나다).
//!
//! ```text
//!  ~/.agentcodegui/codex-engines/<version>/node_modules/@openai/codex/package.json  ← 설치 판정
//!  ~/.agentcodegui/codex-engines/<version>/node_modules/.bin/codex.cmd              ← 실행 파일
//!  ~/.agentcodegui/codex-config.json  { "activeVersion": "0.149.0" }                ← 활성 버전
//! ```
//!
//! ★T2 — **알맹이는 [`crate::versions`]로 옮겼다.** 목록·설치·제거·활성·정리는 Claude
//! 엔진과 규칙이 한 글자도 다르지 않아서(2.6.2도 같은 파일 두 벌이었다) 한 벌로 합쳤고,
//! 여기 남은 것은 codex 고유의 두 가지뿐이다: **경로 상수([`SPEC`])**와 **실행 바이너리
//! 고르기([`codex_bin`])**. 그 둘은 진짜로 다르다 — codex는 플랫폼 패키지 안에 네이티브
//! 실행본이 따로 들어 있다.
//!
//! (레지스트리를 `npm view`로 읽는 설계 결정은 [`crate::versions`] 헤더에 있다.)

use crate::versions::{Spec, CODEX as SPEC};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

pub use crate::versions::{cmp_desc, parse_packument, Available, Cleanup, VersionEntry};

pub const PACKAGE: &str = SPEC.package;

pub fn spec() -> Spec {
    SPEC
}

pub fn engines_dir(home: &Path) -> PathBuf {
    SPEC.engines_dir(home)
}
pub fn config_path(home: &Path) -> PathBuf {
    SPEC.config_path(home)
}
pub fn installed_version_at(home: &Path, version: &str) -> Option<String> {
    SPEC.installed_version_at(home, version)
}
pub fn list_installed(home: &Path) -> Vec<String> {
    SPEC.list_installed(home)
}
pub fn active_version(home: &Path) -> Option<String> {
    SPEC.active_version(home)
}
pub fn set_active(home: &Path, version: Option<&str>) -> Result<(), String> {
    SPEC.set_active(home, version)
}
pub fn list_available() -> Result<Available, String> {
    SPEC.list_available()
}
pub fn install(home: &Path, version: &str, on_line: impl FnMut(&str)) -> Result<(), String> {
    SPEC.install(home, version, on_line)
}
pub fn uninstall(home: &Path, version: &str) -> Result<(), String> {
    SPEC.uninstall(home, version)
}
pub fn cleanup_old(home: &Path) -> Cleanup {
    SPEC.cleanup_old(home)
}

/// 실행에 쓸 codex 바이너리 — 활성 설치본의 **네이티브 실행본**이 1순위.
///
/// ## 왜 `.bin/codex.cmd`가 아닌가 (실측으로 갈린 자리)
///
/// npm이 깔아 주는 `.bin/codex.cmd`는 **셸 shim**이다: `cmd → node → codex.exe` 세 겹.
/// 2.6.2는 Electron에서 `shell: true`로 그걸 그대로 띄웠지만, 3.0에서 같은 짓을 하면
/// 값이 셋 나빠진다 —
///  ① 인용 지옥: `cmd /C ""<경로>" app-server"`는 Rust/Node의 인자 이스케이프와 겹쳐
///     경로에 공백이 있으면 깨진다(M4에서 실제로 밟았다 — `poc-codex --only=handshake`가
///     `'"...codex.cmd"'은(는) 내부 또는 외부 명령이 아닙니다`로 죽었다),
///  ② 프로세스가 3개라 job object·pid 추적이 흐려지고,
///  ③ node.js 런타임이 하나 더 뜬다(메모리).
///
/// 설치본 안에는 플랫폼 패키지의 실물이 있다:
/// `node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe`.
/// 트리플 이름을 박아 두지 않고 **훑어서** 찾는다(새 트리플이 생겨도 산다).
///
/// 폴백 순서: 네이티브 → `.bin` shim → 전역 `codex`(PATH).
///
/// ★R28c CPATH — **마지막 값은 파일 경로가 아니다.** 맨 이름 `codex`는 "PATH에서 찾아라"는
/// 뜻이고, 그 판에서도 턴은 정상으로 뜬다. 그러니 이 함수의 값에 `is_file()`을 걸어
/// 「실행본이 있나」를 판정하면 **전역 설치 사용자에게만 거짓**이 된다 — 그 판정이 필요하면
/// [`resolve_bin`]을 써라(그 함수의 헤더에 실측이 있다).
pub fn codex_bin(home: &Path) -> PathBuf {
    if let Some(v) = active_version(home) {
        let root = engines_dir(home).join(&v).join("node_modules").join("@openai");
        if let Some(p) = native_exe(&root) {
            return p;
        }
        let shim = if cfg!(windows) { "codex.cmd" } else { "codex" };
        let p = engines_dir(home).join(&v).join("node_modules").join(".bin").join(shim);
        if p.exists() {
            return p;
        }
    }
    PathBuf::from("codex")
}

/// **띄울 수 있는가** — [`codex_bin`]이 고른 값을 [`super::driver::command_for`]와 **같은
/// 규칙으로** 해석한다. `Some(실물 경로)`면 그 값으로 프로세스가 뜬다, `None`이면 창구가 없다.
///
/// ## 왜 `is_file()`로는 안 되나 (★R28c CPATH — R28b CRIT 확인 크리틱 R1 §3의 실측)
///
/// [`codex_bin`]의 마지막 폴백은 **맨 이름 `codex`**다(= "PATH에서 찾아 써라"). 그래서
/// `codex_bin().is_file()`은 codex를 전역(`npm i -g @openai/codex`)으로 깔아 쓰는 사용자에게
/// **언제나 거짓**이다 — 그 판에서 턴은 멀쩡히 돌고(`command_for`가 `cmd /C`로 PATH를 뒤진다)
/// 한도 재검증만 「물어볼 창구가 없다」로 떨어졌다(= 눈감고 발사). 크리틱이 A/B로 잠갔다:
/// `CCG_CODEX_BIN=codex`면 `{unknown:1, unavailable:0}` · t=90초 **발사**, 실물 파일이면
/// `{unknown:0, unavailable:2}` · 미발사. 갈린 값은 `is_file()` 하나뿐이었다.
///
/// ## 해석 규칙은 **셸의 그것**이다
///
/// 구분자가 있으면(`is_bare_name` 거짓) 그 경로 하나를 stat한다. 맨 이름이면
/// [`search_dirs`]가 세운 순서대로 훑되 **디렉터리 하나에 후보 확장자를 다 대 보고**
/// 다음 디렉터리로 간다 — 커널/셸이 하는 순서 그대로다. 후보는 `PATHEXT` +
/// (**이름에 확장자가 이미 있으면**) 그 이름 그대로다([`scan_dirs`]에 실측).
/// Windows에서 확장자 **없는** 이름에 확장자 없는 파일을 대 보지 않는 것도 규약이다:
/// npm은 `codex`(sh 스크립트)와 `codex.cmd`를 같은 폴더에 깔고 `cmd /C codex`가 실행하는
/// 것은 **후자**다.
///
/// ## 결과는 캐시한다 (맨 이름일 때만)
///
/// ★R28d EXTN R1 — **캐시의 근거를 세 번째로 고쳐 적는다. 이번엔 호출 그래프를 떠서 셌다.**
/// R28c는 *"첫 소비자가 허브 스레드의 tick(활성이면 20ms)"* 이라 썼고 크리틱이 실측으로
/// 반박했다. R28d R1은 그것을 *"설정 ▸ Account의 게이지 조회(`accounts_usage()`)"* 로
/// 고쳤는데 **그 문장도 거짓**이었다(EXTN 확인 크리틱 R1 §4.4): `accounts_usage()`는
/// `ipc/parity/usage.rs`에 있고 그 파일에 `resolve_bin`·`codex_exe`·`claude_exe` 참조가
/// **0건**이며, 그것이 부르는 `ccg-auth`는 `ccg-engine`에 **의존조차 하지 않는다**.
///
/// 실제 호출자는 앱 전체에서 **넷**뿐이다 — `codex_exe` · `spawn_bin`(codex) ·
/// `claude_exe` · `claude_spawn_bin`. 계정 수만큼 도는 자리도, tick마다 도는 자리도 없다.
/// 그러니 이 캐시가 지우는 것은 「루프」가 아니라 **한 사건 안의 중복**이다:
///
/// | 한 사건 | 같은 이름을 해석하는 횟수 |
/// |---|---|
/// | codex 한도 재검증 1회 | **3** — `can_ask`(`engine/codex_limit.rs:121`) → `instrument`(`:138`) → `read_row`의 `spawn_bin()`(`:224`) |
/// | AI 커밋 메시지 1회 | **2** — 게이트(`ipc/parity/aimsg.rs:271`) → 스폰(`:361`) |
///
/// 한 번의 훑기는 이 컴퓨터에서 최악 **506 stat**(`PATH` 46칸 × `PATHEXT` 11개)이고
/// 캐시는 그 3회·2회를 1회로 만든다. 재검증 사다리(15초·30초…) 자체는 tick마다 돌지
/// 않는다 — `poc-limit-engine` E8「tick마다 조회하지 않는다 — asks:2」가 그 사실을 잠근다.
///
/// 반대로 **경로가 박힌 값은 캐시하지 않는다** — 방금 설치·활성화한 실행본을 다음 조회에
/// 알아봐야 하기 때문이다(허브가 런타임을 새로 만들 때마다 다시 고른다는 그 규약).
pub fn resolve_bin(bin: &Path) -> Option<PathBuf> {
    if !is_bare_name(bin) {
        return bin.is_file().then(|| bin.to_path_buf());
    }
    let path_env = std::env::var_os("PATH").unwrap_or_default();
    if let Some(hit) = cached(bin.as_os_str(), &path_env) {
        return hit;
    }
    let hit = scan_path(bin, &path_env);
    remember(bin.as_os_str().to_os_string(), path_env, hit.clone());
    hit
}

/// 맨 이름인가 = "셸이 PATH에서 찾아야 하는가". [`super::driver::command_for`]의
/// `needs_shell` 판정이 쓰는 것과 **같은 함수**여야 한다 — 규칙이 두 벌이 되면
/// 「띄울 수 있다」와 「실제로 띄운다」가 서로 다른 값을 보게 된다(이 라운드의 뿌리).
pub fn is_bare_name(bin: &Path) -> bool {
    let s = bin.to_string_lossy();
    !s.contains('\\') && !s.contains('/')
}

/// 한 바퀴. `path_env`를 **인자로** 받는 이유는 테스트가 프로세스 환경을 만지지 않고
/// 이 규칙을 그대로 밟을 수 있어야 해서다(`PATH`는 프로세스 전역이라 병렬 테스트에 독이다).
///
/// ## ★R28d EXTN — **이름에 확장자가 이미 붙어 있으면 그 이름 그대로가 첫 후보**다
///
/// R28c CPATH 확인 크리틱 R1 §4의 실측: [`path_exts`]가 `PATHEXT` 항목만 돌려주고
/// 후보를 **붙이기만** 하니, `codex.exe`로 물으면 `codex.exe.COM`·`codex.exe.EXE`…만
/// 뒤지고 정작 `codex.exe`는 한 번도 안 봤다. 크리틱이 승격 하네스 A팔의 철자 하나만
/// (`codex` → `codex.exe`) 바꿔 수정본 exe에 물렸더니 이 라운드가 지운 사고가 그대로
/// 되살아났다: `unknown:1 · fetches:0 · t=90초 발사 · 대기표 소멸`.
///
/// `cmd.exe`는 확장자가 붙은 이름을 **그 이름 그대로 먼저** 찾는다. 그러니 후보 목록의
/// 맨 앞에 「빈 확장자」를 넣는다 — 단 **[`Path::extension`]이 있을 때만**이다.
/// 확장자 없는 `codex`(npm이 같이 까는 sh 스크립트)까지 후보가 되면 R28c가 일부러 막은
/// 것을 되돌린다(`cmd /C codex`가 실행하는 것은 `codex.cmd`다).
///
/// 이 자리가 클로드 축의 전제이기도 하다: 클로드의 PATH 폴백 철자는 **`claude.exe`**라
/// (`src-tauri/src/engine/versions.rs`) 이 한 줄이 없으면 전역 PATH claude 사용자가
/// 로그인·로그아웃(토큰 해지)·AI 커밋 메시지에서 통째로 막힌다.
fn scan_dirs(name: &Path, dirs: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    let mut exts = path_exts();
    if cfg!(windows) && name.extension().is_some() {
        exts.insert(0, OsString::new());
    }
    for dir in dirs {
        if dir.as_os_str().is_empty() {
            continue;
        }
        let base = dir.join(name);
        for ext in &exts {
            let mut s = base.clone().into_os_string();
            s.push(ext);
            let cand = PathBuf::from(s);
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    None
}

/// 훑을 폴더의 **순서** — 이 목록이 곧 「어디까지가 창구인가」의 정의다.
///
/// ## ★R28d EXTN R1 — `PATH` **앞에** 실행 파일이 있는 폴더가 한 칸 있다 (Windows)
///
/// EXTN 확인 크리틱 R1 §2.1이 잰 구멍이다. 이 함수가 `PATH`만 훑던 동안 게이트와 스폰의
/// 답이 갈렸다 — 턴 스폰은 `engine/hub.rs`가 고른 값을
/// `crates/ccg-engine/src/driver.rs`의 `Command::new(&spec.cli)`로 넘기는데, Rust std의
/// `Command`는 `CreateProcess`와 같은 순서로 찾는다:
/// **자식 `PATH` → 실행 파일이 있는 폴더 → system32 → windows → 부모 `PATH`**
/// (`CWD`는 일부러 뺀다). 즉 「실행 파일 옆에만 `claude.exe`가 있는」 판에서
///
/// ```text
/// resolve_bin("claude.exe")          = None      ← 게이트: "없다"
/// Command::new("claude.exe").spawn() = ok        ← 스폰:   "있다"
/// ```
///
/// 가 되고, 그 판의 앱은 **그 CLI로 턴은 띄우면서** 계정 화면에서는 "실행 파일을 찾지
/// 못했어요"라 답한 뒤 **로그아웃에서 토큰 해지를 조용히 건너뛴다**(`ipc/accounts.rs`의
/// 해지 갈래가 `claude_exe()`에 매달려 있다). R28c의 거짓(항상 참 = 판정 안 함)을 지우면서
/// **반대 방향의 거짓**(PATH에 없으면 무조건 없다)이 들어왔던 자리다.
///
/// 그래서 이 한 칸을 `PATH` 앞에 넣는다. 그러면 「띄울 수 있는가」와 「실제로 띄운다」가
/// **같은 폴더 목록**을 본다. `hub.rs`도 이제 해석된 값(`claude_spawn_bin()`)으로 스폰하니
/// 두 자리가 같은 함수를 지난다. codex 축도 같은 값으로 산다 — `spawn_bin()`이 돌려준
/// 절대 경로는 `command_for`에서 `needs_shell`이 거짓이 되어 그대로 뜬다.
///
/// **Windows에서만이다.** POSIX의 `execvp`는 `PATH`만 본다 — 거기서 이 칸을 넣으면
/// 이번엔 반대 방향의 거짓(있다고 했는데 못 뜬다)이 생긴다.
///
/// ## ★R28d EXTN R2 — `CWD`는 **여기 안 넣는다. 대신 스폰 쪽에서 닫았다**
///
/// R1의 이 자리엔 *"`CWD` … 지금 소비자에게 도달 경로가 없다"* 고 적혀 있었다.
/// **거짓이었다**(EXTN 확인 크리틱 R2 §5). 도달 경로는 `super::driver::CodexDriver::spawn`의
/// `cmd.current_dir(&spec.cwd)` — **사용자가 연 프로젝트 폴더**다. 크리틱의 실측(부모 CWD는
/// 딴 데 두고 자식 작업 폴더만 그 폴더로):
///
/// ```text
/// resolve_bin("codex") = null                        ← 게이트: 창구 없음 → 한도 Unknown = 눈감고 발사
/// cmd /C ""codex" app-server" (childCwd=…\projtest)  → 뜬 파일 = …\projtest\codex.exe
/// ```
///
/// 그 칸을 이 목록에 **더하지 않은 것은 결정**이다. 더하면 「연 폴더에 떨어져 있는 실행본을
/// 엔진으로 띄운다」를 사실로 인정하는 것이고, 그건 남의 저장소를 열기만 해도 그 안의
/// `codex.exe`가 뜬다는 뜻이다(바이너리 심기). 그래서 반대로 **스폰이 그 폴더를 안 보게**
/// 했다 — [`super::driver::command_for`]가 맨 이름을 여기서 해석해 넘긴다(그 함수의 표).
///
/// 클로드 축이 이 구멍에 안 걸린 진짜 이유도 **방향이 아니라 여기 있다**: 클로드 스폰은
/// `Command::new`(`crate::driver::ClaudeDriver` · `ipc/parity/aimsg.rs`)이고 Rust의 `Command`는
/// **CWD를 아예 안 본다**(크리틱 탐침의 `cwd` 판 — 게이트 `null` · 스폰 실패로 두 답이 일치).
/// R1이 *"둘 다 「없다고 했는데 뜬다」 방향이라 해지 생략 방향은 아니다"* 라고 적은 문장은
/// **부호가 뒤집혀 있었다**: R1이 고친 해지 생략이 정확히 그 방향이었다(게이트 `None` →
/// `ipc/accounts.rs`의 `logout`이 해지 갈래를 건너뜀).
///
/// 그래서 아직 안 보는 칸은 `system32`·`windows` 둘뿐이고, 이 컴퓨터에서는 둘 다 `PATH`에
/// 있다(크리틱이 다시 셌다). 그쪽은 **위험한 방향**의 오차이므로 「방향이 달라 안전하다」가
/// 아니라 **「같은 방향인데 아직 안 닫았다」**로 적는다.
fn search_dirs(path_env: &OsStr) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if cfg!(windows) {
        if let Some(d) = exe_dir() {
            dirs.push(d);
        }
    }
    dirs.extend(std::env::split_paths(path_env));
    dirs
}

/// 이 프로세스의 실행 파일이 있는 폴더(설치본이면 `…\Programs\AgentCodeGUI`).
fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(Path::to_path_buf)
}

fn scan_path(name: &Path, path_env: &OsStr) -> Option<PathBuf> {
    scan_dirs(name, search_dirs(path_env))
}

/// 확장자 후보 — Windows는 `cmd`가 보는 그 변수(`PATHEXT`), 그 밖에서는 「없음」 하나.
/// 「이름 그대로」 후보를 여기 넣지 않는 이유는 [`scan_path`]에 있다(이름을 봐야 정해진다).
fn path_exts() -> Vec<OsString> {
    if !cfg!(windows) {
        return vec![OsString::new()];
    }
    let raw = std::env::var("PATHEXT").unwrap_or_default();
    let v: Vec<OsString> = raw
        .split(';')
        .map(str::trim)
        .filter(|s| s.starts_with('.'))
        .map(OsString::from)
        .collect();
    if v.is_empty() {
        return [".COM", ".EXE", ".BAT", ".CMD"].iter().map(OsString::from).collect();
    }
    v
}

/// 맨 이름 해석의 캐시 한 칸. `PATH`까지 키에 넣는다 — 환경이 바뀌면 **저절로 무효**가 되고,
/// 테스트가 PATH를 갈아도 앞 테스트의 답이 새지 않는다.
struct Resolved {
    name: OsString,
    path_env: OsString,
    at: Instant,
    hit: Option<PathBuf>,
}

/// 캐시가 낡을 수 있는 상한 = **방금 전역으로 깐 codex를 알아보는 데 걸리는 최대 시간**.
/// 길게 잡으면 "깔았는데도 안 된다"가 되고(최종 파리티 T2가 고친 그 불만), 짧게 잡으면
/// 허브 tick마다 PATH를 훑는다. 15초면 사람이 설치를 마치고 화면으로 돌아오는 시간 안이다.
const RESOLVE_TTL: Duration = Duration::from_secs(15);

fn resolve_cache() -> &'static Mutex<Vec<Resolved>> {
    static C: OnceLock<Mutex<Vec<Resolved>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(Vec::new()))
}

/// 바깥 `Option` = 캐시가 답했는가, 안쪽 = 해석 결과(찾음/못 찾음 **둘 다** 캐시한다).
fn cached(name: &OsStr, path_env: &OsStr) -> Option<Option<PathBuf>> {
    let g = resolve_cache().lock().unwrap_or_else(|e| e.into_inner());
    g.iter()
        .find(|r| r.name == name && r.path_env == path_env && r.at.elapsed() < RESOLVE_TTL)
        .map(|r| r.hit.clone())
}

fn remember(name: OsString, path_env: OsString, hit: Option<PathBuf>) {
    let mut g = resolve_cache().lock().unwrap_or_else(|e| e.into_inner());
    g.retain(|r| r.name != name || r.path_env != path_env);
    // 실제로 쓰이는 조합은 한둘이다(이름 하나 × PATH 하나). 상한은 무한 성장만 막는다.
    if g.len() >= 4 {
        g.remove(0);
    }
    g.push(Resolved { name, path_env, at: Instant::now(), hit });
}

/// `@openai/codex-<plat>/vendor/<triple>/bin/codex[.exe]` 훑기.
fn native_exe(openai_dir: &Path) -> Option<PathBuf> {
    let exe = if cfg!(windows) { "codex.exe" } else { "codex" };
    let rd = std::fs::read_dir(openai_dir).ok()?;
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        // `codex` 자신(런처 패키지)에는 vendor가 없다 — 플랫폼 패키지만 본다.
        if !name.starts_with("codex-") {
            continue;
        }
        let vendor = e.path().join("vendor");
        let Ok(triples) = std::fs::read_dir(&vendor) else { continue };
        for t in triples.flatten() {
            let cand = t.path().join("bin").join(exe);
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 경로 비교용 — Windows는 대소문자를 안 가리고, `PATHEXT`가 대문자다(`.CMD`).
    fn lower(p: &Path) -> String {
        p.to_string_lossy().to_ascii_lowercase()
    }

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("ccg-codex-ver-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn fake_install(home: &Path, v: &str) {
        let d = SPEC.package_dir(home, v);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("package.json"), format!("{{\"version\":\"{v}\"}}")).unwrap();
    }

    #[test]
    fn installed_list_is_newest_first_and_ignores_empty_folders() {
        let home = tmp("list");
        fake_install(&home, "0.149.0");
        fake_install(&home, "0.9.0");
        std::fs::create_dir_all(engines_dir(&home).join("0.200.0")).unwrap(); // 껍데기
        assert_eq!(list_installed(&home), vec!["0.149.0", "0.9.0"]);
        assert_eq!(active_version(&home), None);
        assert!(set_active(&home, Some("0.200.0")).is_err(), "설치 안 된 버전은 거절");
        set_active(&home, Some("0.9.0")).unwrap();
        assert_eq!(active_version(&home).as_deref(), Some("0.9.0"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn codex_bin_falls_back_to_path_when_nothing_is_installed() {
        let home = tmp("bin");
        assert_eq!(codex_bin(&home), PathBuf::from("codex"));
        // ★R28c CPATH — 그 폴백값은 **파일이 아니다**. 이 한 줄이 이 라운드가 고친 구멍의
        // 씨앗이다(`is_file()`로 「실행본 없음」을 판정하면 전역 설치 사용자만 거짓).
        assert!(!codex_bin(&home).is_file());
        assert!(is_bare_name(&codex_bin(&home)));
        let _ = std::fs::remove_dir_all(&home);
    }

    /// ★R28c CPATH — **맨 이름은 PATH에서 찾는다.** 프로세스 환경을 만지지 않고
    /// (`PATH`는 전역이라 병렬 테스트에 독이다) 규칙만 그대로 밟는다.
    #[test]
    fn a_bare_name_resolves_through_path_the_way_the_shell_does() {
        let dir = tmp("which");
        let other = tmp("which-empty");
        let ext = if cfg!(windows) { ".cmd" } else { "" };
        std::fs::write(dir.join(format!("codex{ext}")), "@echo off").unwrap();
        // PATH 앞칸은 비어 있고(빈 항목 · 없는 폴더), 답은 뒤칸에 있다.
        let path_env = std::env::join_paths([PathBuf::new(), other.clone(), dir.clone()]).unwrap();
        let hit = scan_path(Path::new("codex"), &path_env).expect("PATH에서 찾아야 한다");
        // 붙는 확장자는 `PATHEXT`의 **글자 그대로**다(이 컴퓨터의 값은 `.CMD`) — 파일
        // 이름과 대소문자가 달라도 같은 파일이다. 비교는 그래서 소문자로 한다.
        assert_eq!(lower(&hit), lower(&dir.join(format!("codex{ext}"))));
        // 없는 이름은 못 찾는다(= 「창구 없음」).
        assert_eq!(scan_path(Path::new("codex-nosuch"), &path_env), None);
        for p in [&dir, &other] {
            let _ = std::fs::remove_dir_all(p);
        }
    }

    /// ★R28d EXTN — **확장자가 이미 붙은 맨 이름**(`codex.exe` · `claude.exe`)을
    /// 그 이름 그대로 찾는가. R28c CPATH 확인 크리틱 R1 §4가 판 구멍이다: 후보가
    /// `codex.exe.COM`·`codex.exe.EXE`뿐이라 PATH 앞칸에 놓인 실물 `codex.exe`를 한 번도
    /// 안 봤고, 크리틱이 승격 하네스 A팔의 철자만 바꿔 `hole:true`를 되살렸다.
    ///
    /// 클로드 축이 이 한 줄에 매달려 있다 — PATH 폴백 철자가 `claude.exe`다.
    #[test]
    fn a_name_that_already_has_an_extension_is_tried_as_is() {
        let dir = tmp("extname");
        let exe = if cfg!(windows) { "codex.exe" } else { "codex" };
        std::fs::write(dir.join(exe), "x").unwrap();
        let path_env = std::env::join_paths([dir.clone()]).unwrap();
        assert_eq!(
            scan_path(Path::new(exe), &path_env).as_deref().map(lower),
            Some(lower(&dir.join(exe))),
            "PATH에 있는 {exe}를 그 이름 그대로 못 찾았다"
        );
        // 같은 컴퓨터의 클로드 철자도(전역 설치 사용자의 `~/.local/bin/claude.exe`).
        let claude = if cfg!(windows) { "claude.exe" } else { "claude" };
        std::fs::write(dir.join(claude), "x").unwrap();
        assert!(
            scan_path(Path::new(claude), &path_env).is_some(),
            "{claude}를 PATH에서 못 찾는다 = 로그인·로그아웃(토큰 해지)·커밋 메시지가 통째로 막힌다"
        );
        // 과잉 교정 금지 — 없는 이름은 여전히 못 찾는다(빈 확장자가 폴더를 집지도 않는다).
        std::fs::create_dir_all(dir.join("codex-dir.exe")).unwrap();
        assert_eq!(scan_path(Path::new("codex-nosuch.exe"), &path_env), None);
        assert_eq!(scan_path(Path::new("codex-dir.exe"), &path_env), None, "폴더를 실행본으로 봤다");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ★R28d EXTN R1 — **실행 파일이 있는 폴더가 `PATH`보다 앞이다**(Windows).
    /// EXTN 확인 크리틱 R1 §2.1이 판 구멍: 이 칸이 없으면 「실행 파일 옆에만 CLI가 있는」
    /// 판에서 게이트는 "없다", 스폰은 "있다"가 되고 **로그아웃이 토큰 해지를 건너뛴다**.
    #[test]
    fn the_folder_of_the_running_exe_is_searched_before_path() {
        let path_dir = tmp("order-path");
        let path_env = std::env::join_paths([path_dir.clone()]).unwrap();
        let dirs = search_dirs(&path_env);
        if cfg!(windows) {
            assert_eq!(dirs.first(), exe_dir().as_ref(), "PATH 앞칸이 실행 파일 폴더가 아니다");
            assert_eq!(dirs.len(), 2, "실행 파일 폴더 한 칸 + PATH 한 칸");
        } else {
            // POSIX의 `execvp`는 PATH만 본다 — 여기서 한 칸을 더하면 반대 방향의 거짓이 된다.
            assert_eq!(dirs, vec![path_dir.clone()]);
        }
        // 순서의 뜻: 같은 이름이 두 폴더에 있으면 **앞칸이 이긴다**(커널의 그 순서).
        let front = tmp("order-front");
        let name = if cfg!(windows) { "claude.exe" } else { "claude" };
        for d in [&front, &path_dir] {
            std::fs::write(d.join(name), "x").unwrap();
        }
        assert_eq!(
            scan_dirs(Path::new(name), vec![front.clone(), path_dir.clone()]).as_deref().map(lower),
            Some(lower(&front.join(name)))
        );
        for p in [&front, &path_dir] {
            let _ = std::fs::remove_dir_all(p);
        }
    }

    /// ★R28d EXTN R1 — **게이트와 스폰이 같은 답을 한다**(실제 `CreateProcess`로 잰다).
    ///
    /// 크리틱이 요구한 그 못이다. 실행 파일 옆에 CLI를 하나 두고(이 테스트 바이너리를
    /// 그대로 복사한다 — 진짜로 뜨는 실행본이어야 한다) `PATH`에서는 빼고 두 질문을
    /// 나란히 던진다. 이 칸이 없던 동안 답은 `None` 대 `ok`로 갈렸다.
    #[cfg(windows)]
    #[test]
    fn the_gate_and_a_real_spawn_agree_when_the_cli_sits_next_to_the_exe() {
        let me = std::env::current_exe().unwrap();
        let name = format!("ccg-extn-sibling-{}.exe", std::process::id());
        let sib = me.parent().unwrap().join(&name);
        std::fs::copy(&me, &sib).unwrap();
        // 「PATH에는 없다」 = 빈 폴더 한 칸.
        let empty = tmp("sibling-empty");
        let path_env = std::env::join_paths([empty.clone()]).unwrap();

        // ① 게이트 — 프로세스 환경은 안 만진다(PATH는 전역이라 병렬 테스트에 독이다).
        let gate = scan_path(Path::new(&name), &path_env);
        // ② 스폰 — 같은 이름·같은 PATH를 커널에 그대로 묻는다. 자식은 libtest라
        //    「0개 테스트」를 돌고 즉시 끝난다(재귀 없음).
        let spawn = std::process::Command::new(&name)
            .args(["--exact", "__ccg_no_such_test__"])
            .env("PATH", &path_env)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
        let spawned = match spawn {
            Ok(mut c) => {
                let _ = c.wait();
                true
            }
            Err(_) => false,
        };

        let _ = std::fs::remove_file(&sib);
        let _ = std::fs::remove_dir_all(&empty);

        assert!(spawned, "커널은 실행 파일 옆의 {name}을 띄운다(이 전제가 깨지면 이 못은 무의미하다)");
        assert_eq!(
            gate.as_deref().map(lower),
            Some(lower(&sib)),
            "★ 스폰은 되는데 게이트가 「없다」고 답했다 = 그 판의 로그아웃이 토큰 해지를 건너뛴다"
        );
    }

    /// Windows에서 **확장자 없는 파일은 후보가 아니다** — npm이 같은 폴더에 까는
    /// `codex`(sh 스크립트)를 `cmd /C codex`가 실행하지 않기 때문이다.
    #[cfg(windows)]
    #[test]
    fn on_windows_an_extensionless_file_is_not_a_command() {
        let dir = tmp("noext");
        std::fs::write(dir.join("codex"), "#!/bin/sh").unwrap();
        let path_env = std::env::join_paths([dir.clone()]).unwrap();
        assert_eq!(scan_path(Path::new("codex"), &path_env), None);
        // `.cmd`가 생기면 그때 답이 된다.
        std::fs::write(dir.join("codex.cmd"), "@echo off").unwrap();
        assert_eq!(
            scan_path(Path::new("codex"), &path_env).as_deref().map(lower),
            Some(lower(&dir.join("codex.cmd")))
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 경로가 박힌 값은 stat 하나로 끝나고 **캐시하지 않는다**(방금 설치한 실행본을
    /// 다음 tick에 알아봐야 한다). 반대로 맨 이름은 캐시가 답한다.
    #[test]
    fn a_path_shaped_value_is_answered_by_one_stat_and_is_never_cached() {
        let dir = tmp("resolve");
        let exe = dir.join("codex.exe");
        assert_eq!(resolve_bin(&exe), None, "없는 파일 = 창구 없음");
        std::fs::write(&exe, "x").unwrap();
        assert_eq!(resolve_bin(&exe), Some(exe.clone()), "★ 설치 직후를 못 알아봤다");
        std::fs::remove_file(&exe).unwrap();
        assert_eq!(resolve_bin(&exe), None, "★ 지운 실행본을 캐시가 살려냈다");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 캐시는 **PATH까지 키**다 — 환경이 바뀌면 저절로 무효고, 두 번째 조회는 훑지 않는다.
    #[test]
    fn the_bare_name_cache_is_keyed_by_the_path_it_was_answered_with() {
        let dir = tmp("cache");
        let name = format!("ccg-codex-cache-{}", std::process::id());
        let ext = if cfg!(windows) { ".cmd" } else { "" };
        std::fs::write(dir.join(format!("{name}{ext}")), "@echo off").unwrap();
        let empty = tmp("cache-empty");
        let with = std::env::join_paths([dir.clone()]).unwrap();
        let without = std::env::join_paths([empty.clone()]).unwrap();
        remember(OsString::from(&name), with.clone(), Some(dir.join(format!("{name}{ext}"))));
        assert_eq!(cached(OsStr::new(&name), &with), Some(Some(dir.join(format!("{name}{ext}")))));
        // 다른 PATH로 물으면 캐시는 **답하지 않는다**(= 새로 훑는다).
        assert_eq!(cached(OsStr::new(&name), &without), None);
        for p in [&dir, &empty] {
            let _ = std::fs::remove_dir_all(p);
        }
    }

    #[test]
    fn packument_parses_both_npm_view_and_registry_shapes() {
        // `npm view --json`(배열) — 실제 산출 모양
        let a = parse_packument(&json!({
            "dist-tags": { "latest": "0.149.0" },
            "versions": ["0.9.0", "0.149.0", "0.150.0", "0.151.0-alpha.1"],
            "time": { "0.149.0": "2026-08-01T00:00:00.000Z" }
        }));
        assert_eq!(a.latest.as_deref(), Some("0.149.0"));
        // 내림차순 · 프리릴리즈 제외
        assert_eq!(
            a.versions.iter().map(|v| v.version.as_str()).collect::<Vec<_>>(),
            vec!["0.150.0", "0.149.0", "0.9.0"]
        );
        assert!(a.versions[1].latest);
        assert_eq!(a.versions[1].date.as_deref(), Some("2026-08-01T00:00:00.000Z"));
        // latest보다 높은 0.150.0 = 프리뷰 (2.6.2와 **같은 판정 방향**)
        assert!(a.versions[0].preview);
        assert!(!a.versions[2].preview);

        // 레지스트리 원본(객체)도 같은 결과
        let b = parse_packument(&json!({
            "dist-tags": { "latest": "0.149.0" },
            "versions": { "0.9.0": {}, "0.149.0": {} },
            "time": {}
        }));
        assert_eq!(b.versions.len(), 2);
    }

    #[test]
    fn cleanup_keeps_only_the_newest_and_moves_the_active_flag() {
        let home = tmp("cleanup");
        fake_install(&home, "0.149.0");
        fake_install(&home, "0.148.0");
        set_active(&home, Some("0.148.0")).unwrap();
        let c = cleanup_old(&home);
        assert_eq!(c.kept.as_deref(), Some("0.149.0"));
        assert_eq!(c.removed, vec!["0.148.0"]);
        assert!(c.active_switched);
        assert_eq!(active_version(&home).as_deref(), Some("0.149.0"));
        let _ = std::fs::remove_dir_all(&home);
    }
}
