//! `ServerSpec` — **언어 하나 = 이 구조체 한 항목.**
//!
//! 2.6.2(`src/main/lsp/manager.ts`)는 언어별 특례가 매니저 본문에 흩어져 있었다:
//! Roslyn 전용 `afterInitialized`·`awaitsProjectInit`·`watchCsSolution`·`primeFullSemantics`,
//! clangd 전용 compile-DB 경로, Verse 전용 워크스페이스 stale 검사… 3107줄 중 언어 특례가
//! 절반이고, 언어를 하나 더 붙이면 그 절반이 또 자란다.
//!
//! 3.0은 **엔진에 언어 이름을 쓰지 않는다.** 엔진(`server.rs`/`manager.rs`)이 아는 것은
//! 이 스펙의 필드뿐이고, 2.6.2가 피 흘려 얻은 함정들은 전부 **스펙의 값**으로 표현된다:
//!
//! | 2.6.2에서 밟은 함정 | 3.0 스펙 필드 |
//! |---|---|
//! | Roslyn: `didChangeWatchedFiles`를 선언하면 서버 폴백 워처가 꺼진다 | [`ServerSpec::declare_watched_files`] |
//! | Roslyn: range 없는 `didChange`에 프로세스째 죽는다 | 엔진이 **서버가 선언한 `syncKind`를 항상 존중**(불변식) |
//! | Roslyn: `didOpen` 중복에 프로세스째 죽는다 | 엔진 불변식 — 문서 맵 잠금을 stat/read 내내 쥔다([`crate::server`]) |
//! | Roslyn: 프라임은 스냅샷 → 변화 뒤 재프라임, 3초 조용 간격 | [`Reprime::WorkspaceSymbol { quiet_gap_ms }`] — 규약 다섯 개는 엔진이 지킨다([`crate::server`]) |
//! | pyright/Roslyn: 인터프리터·옵션을 `workspace/configuration`으로 물어 온다 | [`ServerSpec::configuration`] — `rpc.rs`는 arity만 지키고 값은 여기서 온다(R2 · 크리틱 C-5) |
//! | C#: 루트는 그 csproj를 **참조하는** sln | [`RootRule::ReferencingSolution`] |
//! | clangd/UE: compile DB·인덱스는 앱 홈 | [`Launch::Exe { extra_args }`] — 스펙이 앱 홈 경로를 만들어 넘긴다 |
//! | clangd/UE: 그 compile DB를 **만들어야** 한다(UBT) · 만들어지면 재기동 | [`ServerSpec::prepare_root`] (R4) |
//! | 프리웜의 주력 언어 감지 | [`ServerSpec::detect_markers`] (R4 — R3까지 `lib.rs` 하드코딩) |
//! | 무거운 서버는 유휴 회수를 길게 | [`ServerSpec::idle_ttl_ms`] |
//! | 토큰 캐시 포맷이 바뀌면 옛 캐시를 버려야 | [`ServerSpec::cache_version`] |
//!
//! **검증 기준**(다음 라운드): C#·C++를 붙이는 diff가 이 파일의 `SPECS` 배열에 항목을
//! 하나씩 더하는 것으로 끝나야 한다. 엔진 파일이 열리면 그 설계는 실패한 것이다.
//! (R4 실측: C++는 `SPECS` 한 항목으로 **안 섰다** — 확장점이 하나 더 필요했다.
//! 무엇이 왜 필요했는지는 [`ServerSpec::prepare_root`]의 주석과 `docs/m7-report-r1.md` §R4.)

use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

// ── 제공 방식 ────────────────────────────────────────────────────────────────
/// 서버 바이너리가 어디서 오는가 — 설정 ▸ 코드 분석 목록의 `kind`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Provision {
    /// 앱에 같이 실린다(node_modules) — 항상 쓸 수 있다.
    Bundled,
    /// 사용자가 요청하면 내려받는다(C#/Roslyn, C++/clangd).
    Download,
    /// 사용자가 직접 바이너리를 대야 한다(Verse: Epic의 verse-lsp.exe — 3.0 범위 밖).
    External,
}

// ── 실행 명령 ────────────────────────────────────────────────────────────────
/// 서버를 어떻게 띄우는가.
#[derive(Clone)]
pub enum Launch {
    /// 순수 JS 서버 — Node 런타임 + 모듈 스크립트.
    /// `module`은 `node_modules` 기준 상대 경로 조각들(`["typescript-language-server","lib","cli.mjs"]`).
    Node {
        module: &'static [&'static str],
        args: &'static [&'static str],
    },
    /// 네이티브 실행 파일 — 앱 홈의 `lsp/<id>/`에서 찾는다([`crate::launch::installed_bin`]).
    /// `extra_args`는 **루트별** 인자(clangd의 `--compile-commands-dir=<앱 홈 DB>`,
    /// Roslyn의 `--extensionLogDirectory=<앱 홈 로그>`).
    Exe {
        bin: &'static str,
        args: &'static [&'static str],
        extra_args: fn(&Path) -> Vec<String>,
    },
}

// ── 루트 판별 ────────────────────────────────────────────────────────────────
/// 파일 하나가 **어느 서버 인스턴스**에 속하는가. 서버는 (스펙 id, 루트)마다 하나다.
#[derive(Clone, Copy)]
pub enum RootRule {
    /// 열린 프로젝트 폴더 그대로(TS·Python).
    ProjectCwd,
    /// 그 파일의 프로젝트 파일(`markers`)을 **참조하는** 솔루션 폴더 → 없으면 가장 가까운
    /// 프로젝트 파일 폴더. C#(Roslyn)이 이것 없이는 UE 모노레포에서 무관한 거대 sln을 문다.
    /// (2.6.2 `csRootFor` — 참조 검사까지 포함. `ttl_ms`는 탐색 결과 메모 수명.)
    ///
    /// **후보가 여럿이면 "참조 프로젝트 수가 가장 많은" 솔루션**을 고른다(동률이면 안쪽).
    /// 2.6.2 실측: 도구가 csproj 폴더에 떨궈 둔 단일 프로젝트 sln이 진짜 솔루션을 가리면
    /// 프라임이 형제 프로젝트를 못 덮어 크로스 프로젝트 심볼이 무색으로 남는다.
    ReferencingSolution {
        project_ext: &'static str,
        solution_exts: &'static [&'static str],
        ttl_ms: u64,
    },
    /// 위로 걸어 올라가 `markers` 중 하나가 있는 첫 폴더(없으면 cwd).
    #[allow(dead_code)] // R2에서 배선
    NearestMarker { markers: &'static [&'static str] },
}

// ── 재프라임 정책 ────────────────────────────────────────────────────────────
/// 프로젝트에 변화가 생겼을 때 "이미 뜬 서버의 분류가 낡는" 문제를 어떻게 되살리는가.
#[derive(Clone, Copy)]
pub enum Reprime {
    /// 필요 없다 — 서버가 문서 동기화만으로 스스로 갱신한다(tsserver·pyright).
    None,
    /// 전 솔루션 시맨틱 프라임(`workspace/symbol` 1회). Roslyn의 frozen 토큰 모델은
    /// 누가 풀 컴파일을 요구하지 않으면 크로스 프로젝트 심볼을 영영 미해석으로 둔다.
    ///
    /// `quiet_gap_ms`: **마지막 파일 변화 통지로부터 이만큼 조용해진 뒤에** 프라임한다.
    /// 2.6.2 실측 — Roslyn 폴백 워처의 새 파일 편입이 0.8~1.6초 걸리는데 그 전에 프라임하면
    /// "새 파일이 빠진 컴파일"이 프라임 완료로 확정돼 영영 무색이 된다(= 헛프라임).
    WorkspaceSymbol { quiet_gap_ms: u64 },
}

// ── 스펙 ─────────────────────────────────────────────────────────────────────
pub struct ServerSpec {
    pub id: &'static str,
    pub label: &'static str,
    /// 설정 목록의 "TypeScript · JavaScript"
    pub langs: &'static str,
    /// 설정 목록의 ".ts .tsx .js …"
    pub exts_display: &'static str,
    pub kind: Provision,
    /// 외부 전제(설정에 표시) — `(한국어, English)`.
    ///
    /// R3까지 한국어 한 줄이었고, 그게 크리틱이 짚은 §R3-9 ⑤였다: Rust 문자열이라
    /// 렌더러의 `t()`를 못 타 **영어 UI에서도 한국어가 나왔다**. 계약면에 두 벌을 실어
    /// (`requires`/`requiresEn`) 표시 쪽이 고르게 한다.
    pub requires: Option<(&'static str, &'static str)>,

    /// 확장자(점 없이, 소문자) → LSP `languageId`.
    pub exts: &'static [(&'static str, &'static str)],

    /// 프리웜의 **주력 언어 감지** — 이 폴더 바로 아래에 이 중 하나가 있으면 이 서버가
    /// 그 프로젝트의 주력이다. 이름 그대로(`package.json`) 또는 `*.확장자`(`*.sln`).
    /// 빈 배열 = 프리웜 대상 아님(파일을 열면 그때 지연 스폰된다).
    ///
    /// R3까지 이 표는 `lib.rs::detect_project_spec`에 하드코딩돼 있었고(§R3-9 ④),
    /// "네 언어는 공짜지만 다섯 번째는 그 파일을 연다"가 남은 빚이었다. 우선순위는
    /// [`SPECS`]의 **순서**다 — 위에 있는 스펙이 먼저 주장한다.
    pub detect_markers: &'static [&'static str],

    pub launch: Launch,

    /// [`Launch::Node`] 서버가 **실행 스크립트 말고 또** 배포본에 실려야 하는 `node_modules`
    /// 최상위 패키지들. `module[0]`은 [`bundled_packages`]가 자동으로 넣으므로 여기 안 적는다.
    ///
    /// ★ LSPDIST R1이 판 확장점. 왜 필요했나 — TS가 실제로 쓰는 패키지는 **둘**이다:
    /// 실행은 `typescript-language-server`가 하고, 그게 스폰할 tsserver는
    /// [`ts_init_options`]가 `typescript` 패키지에서 못박아 넘긴다. `Launch::Node`만 보고
    /// 번들을 만들면 `typescript`가 빠지고, 그러면 서버는 **뜨는데** tsserver를 못 찾아
    /// 색이 반만 나온다(진단이 제일 어려운 종류의 고장이다).
    ///
    /// 이 값이 곧 `src-tauri/tauri.conf.json`의 `bundle.resources`와 맞물리는 계약이고,
    /// 어긋나면 [`tests::every_bundled_node_package_is_in_the_installer_manifest`]가 잡는다 —
    /// `Provision::Download`가 `install.rs::download_for`와 짝을 이루는 것과 같은 규율이다.
    pub extra_modules: &'static [&'static str],

    pub root: RootRule,

    /// `initialize`의 `initializationOptions` — 루트를 받아 만든다(없으면 `None`).
    pub init_options: fn(&Path) -> Option<Value>,

    /// 서버가 `workspace/configuration`으로 물어오는 **섹션의 값**(루트 기준).
    /// `None`이면 그 항목에 `null`이 간다 — 2.6.2 `items.map(() => null)`과 같은 답이다.
    ///
    /// 이 필드가 있는 이유(크리틱 C-5): pyright는 인터프리터·venv를(`python`,
    /// `python.analysis`), Roslyn은 옵션 묶음을 **이 경로로만** 받는다. 값을 스펙에 두지
    /// 않으면 언어를 붙일 때마다 `rpc.rs`가 열린다(= 이 설계의 실패 조건).
    pub configuration: fn(&Path, &str) -> Option<Value>,

    /// `initialize`에 실을 워크스페이스 폴더들(`(uri, name)`). `None`이면 루트 하나.
    /// 다중 루트를 돌려주면 `rootUri`는 null로 보낸다(LSP 다중 루트 규약).
    pub workspace_folders: fn(&Path) -> Option<Vec<(String, String)>>,

    /// **서버가 읽을 입력을 준비한다** — 스폰 전후로 오래 걸리는 준비 작업이 있는 서버.
    /// 엔진은 루트당 **한 번**, **백그라운드 스레드에서** 부른다(분 단위여도 된다).
    /// `true`를 돌려주면 "입력이 새로 생겼다" → 엔진이 그 루트의 서버를 **쿨다운 없이**
    /// 접는다(다음 요청이 새 인자로 재스폰한다).
    ///
    /// 왜 값(`extra_args`)만으로 안 되는가 — R4가 clangd에서 배운 것:
    /// clangd는 `compile_commands.json`이 **있어야** 앱 홈을 가리키는 인자를 받을 수 있는데,
    /// UE 프로젝트에서 그 파일은 우리가 UnrealBuildTool로 **만들어야** 존재한다(수 초~수 분).
    /// 스폰 경로에서 동기로 만들 수는 없고(첫 호버가 몇 분 멈춘다), 만들고 나면 이미 뜬
    /// clangd는 "DB 없음"으로 떠 있으므로 접어야 한다. 즉 **값이 아니라 행동**이다 —
    /// R3의 `membership_files`/`reload_project`(재통지)로도 안 되는데, 여기서 필요한 것은
    /// 재통지가 아니라 **다른 인자로의 재기동**이기 때문이다. 2.6.2는 같은 일을 매니저
    /// 본문의 `maybeUeDb(cwd)` + `restart('cpp', cwd)`(`def.id === 'cpp'` 하드코딩)로 했다.
    pub prepare_root: Option<fn(&Path) -> bool>,

    /// `initialized` 직후 서버에 "무엇을 열지" 알려야 하는가(Roslyn `solution/open`).
    /// `Some(f)`이고 `f`가 `false`를 돌려주면 = 열 것이 없다 → 프로젝트 로드 게이트를 즉시 내린다.
    pub after_initialized: Option<fn(&crate::rpc::Rpc, &Path) -> bool>,

    /// `initialize` 응답 뒤에도 인덱싱이 이어지고 `workspace/projectInitializationComplete`로
    /// 끝을 알리는 서버(Roslyn). true면 그 통지 전까지 status를 `starting`으로 잡는다 —
    /// 뷰어가 **부분 토큰**을 잡아 그대로 굳는 사고를 막는다.
    pub awaits_project_init: bool,

    /// **선언 금지 스위치.** `false`면 `initialize` capabilities에서 `didChangeWatchedFiles`를
    /// 아예 빼서 서버가 자기 폴백 워처를 계속 돌게 한다(Roslyn 실측: 선언하는 순간 서버가
    /// 워칭을 클라이언트에 통째로 위임하는데, 우리는 외부 빌드 산출물까지 못 챙긴다).
    pub declare_watched_files: bool,

    pub reprime: Reprime,

    /// 이 루트의 **멤버십 파일** — "어떤 프로젝트/파일이 이 서버에 속하는가"를 정하는 파일들
    /// (Roslyn: 로드한 `.sln`/`.slnx`, 솔루션이 없으면 루트의 `.csproj`들). 빈 목록 = 감시 없음.
    ///
    /// 엔진은 이 목록의 mtime/size를 [`crate::server::MEMBERSHIP_POLL`] 주기로 보고, 갈리면
    /// [`ServerSpec::reload_project`]를 부른다. 엔진이 아는 것은 "파일이 갈렸다"뿐이고,
    /// **무엇을 다시 보낼지는 스펙이 정한다**(2.6.2 `watchCsSolution`이 매니저 본문에 있던 자리).
    pub membership_files: fn(&Path) -> Vec<PathBuf>,

    /// 멤버십이 갈렸다 — 서버에 다시 알린다(Roslyn: `solution/open`·`project/open` 재통지).
    /// 반환 `true`면 엔진이 재프라임을 예약한다.
    ///
    /// 왜 재시작이 아니라 재통지인가(2.6.2 실측): Roslyn은 솔루션 멤버십을 로드 때 한 번만
    /// 읽는다. 외부 도구가 프로젝트를 더하며 `.slnx`를 재생성하면 떠 있는 서버는 새 프로젝트의
    /// 모든 `.cs`를 떠돌이(misc)로 취급해 **무색**이 된다. 같은 경로로 다시 `solution/open`을
    /// 보내면 수 초 안에 새 멤버십이 로드되고 이미 열려 있던 misc 문서까지 그 자리에서 회복된다
    /// — 재시작(수 분짜리 재인덱싱)이 필요 없다.
    pub reload_project: Option<fn(&crate::rpc::Rpc, &Path) -> bool>,

    /// 이 서버의 담당 프로젝트에서 "변화로 쳐야 할" 확장자(재프라임 트리거). 빈 배열 = 없음.
    pub watch_exts: &'static [&'static str],

    /// 유휴 회수 TTL — 마지막 사용에서 이만큼 지나면 프로세스째 접는다.
    /// bundled 10분 / 무거운 서버(Roslyn 솔루션 인덱싱·clangd 인덱스) 30분(2.6.2 규약).
    pub idle_ttl_ms: u64,

    /// 토큰 디스크 캐시의 세대. 이 서버의 토큰 해석 방식이 바뀌면 올려 옛 캐시를 버린다.
    /// (전역 세대는 [`crate::semcache::CACHE_VERSION`] — 둘이 함께 키에 들어간다)
    pub cache_version: u32,
}

impl ServerSpec {
    /// 이 파일 확장자를 이 서버가 맡는가 → 맡으면 LSP `languageId`.
    pub fn language_id(&self, ext: &str) -> Option<&'static str> {
        let e = ext.to_ascii_lowercase();
        self.exts.iter().find(|(k, _)| *k == e).map(|(_, v)| *v)
    }

    /// 이 확장자의 변화를 이 서버에 흘려야 하는가 — 뷰어가 여는 확장자(`exts`)에
    /// **더해** 프로젝트 파일(`watch_exts`: C#의 `csproj`/`sln`/`props`…)까지 센다.
    /// (2.6.2 `notifyWatchedFiles`의 `def.exts || CS_EXTRA` 자리 — 그쪽은 C# 하드코딩이었다)
    pub fn watches_ext(&self, ext: &str) -> bool {
        let e = ext.to_ascii_lowercase();
        self.exts.iter().any(|(k, _)| *k == e) || self.watch_exts.iter().any(|k| *k == e)
    }
}

// ── 기본 훅(스펙이 아무것도 안 할 때) ────────────────────────────────────────
fn no_init_options(_root: &Path) -> Option<Value> {
    None
}
fn no_workspace_folders(_root: &Path) -> Option<Vec<(String, String)>> {
    None
}
/// 서버가 설정을 물어와도 줄 게 없다(tsserver-ls·Roslyn) — 항목마다 `null`이 간다.
/// 그게 2.6.2 `items.map(() => null)`과 같은 답이고, 서버는 자기 기본값을 쓴다.
fn no_configuration(_root: &Path, _section: &str) -> Option<Value> {
    None
}
#[allow(dead_code)] // R3(clangd)에서 쓴다
fn no_extra_args(_root: &Path) -> Vec<String> {
    Vec::new()
}
/// 멤버십이 파일로 정의되지 않는 서버(tsserver·pyright) — 감시할 것이 없다.
fn no_membership_files(_root: &Path) -> Vec<PathBuf> {
    Vec::new()
}

// ── TypeScript / JavaScript (R1의 끝까지 가는 하나) ──────────────────────────
fn ts_init_options(_root: &Path) -> Option<Value> {
    // 번들된 tsserver를 못박는다 — 해석이 열린 프로젝트에 의존하지 않게(2.6.2와 같은 값).
    let tsserver = crate::launch::shipped_module(&["typescript", "lib", "tsserver.js"]);
    let mut ts = json!({
        // syntax 전용 보조 tsserver를 안 띄운다(세트당 ~130MB). 뷰어 부하에선 체감이 없다.
        "useSyntaxServer": "never"
    });
    if let Some(p) = tsserver {
        ts["path"] = json!(p.to_string_lossy());
    }
    Some(json!({
        // ATA(@types 자동 다운로드) 끔 — typingsInstaller 프로세스가 아예 안 뜬다(세트당 ~125MB)
        "disableAutomaticTypingAcquisition": true,
        // tsserver V8 힙 상한(VSCode 기본값) — 초대형 프로젝트 폭주 가드
        "maxTsServerMemory": 3072,
        "tsserver": ts
    }))
}

// ── Python / pyright ─────────────────────────────────────────────────────────
/// pyright가 `workspace/configuration`으로 물어오는 세 섹션(`python` · `python.analysis` ·
/// `pyright`)의 값. **이 경로 말고는 인터프리터를 알려 줄 방법이 없다** —
/// pyright는 `initializationOptions`로 인터프리터를 받지 않는다(R3 실측).
///
/// 값을 안 주면 pyright는 PATH에서 `python`을 찾는데, Windows에서 그 자리는 보통
/// **Microsoft Store 앱 실행 별칭**(121바이트짜리 리파스 포인트)이라 실패한다 —
/// 실측으로 pyright가 stderr에 `Python`만 세 번 뱉고 인터프리터 없이 뜬다.
/// 그러면 표준 라이브러리는 번들 typeshed로 풀리지만 `site-packages`(설치한 패키지)는
/// 통째로 미해석이 된다.
fn py_configuration(root: &Path, section: &str) -> Option<Value> {
    match section {
        "python" => {
            let py = venv_python(root)?;
            let mut o = json!({ "pythonPath": py.to_string_lossy() });
            // venv면 그 폴더도 알려 준다(pyright가 형제 venv를 더 찾게)
            if let Some(venv) = py.parent().and_then(Path::parent) {
                if venv.starts_with(root) {
                    o["venvPath"] = json!(root.to_string_lossy());
                    o["defaultInterpreterPath"] = json!(py.to_string_lossy());
                }
            }
            Some(o)
        }
        // 뷰어는 진단을 그리지 않는다 — 열린 파일만 검사해 유휴 CPU를 아낀다(2.6.2와 같은 체감).
        "python.analysis" => Some(json!({
            "diagnosticMode": "openFilesOnly",
            "useLibraryCodeForTypes": true,
            "autoSearchPaths": true
        })),
        _ => None,
    }
}

/// 이 프로젝트에 쓸 Python 인터프리터. venv 우선 → PATH → 사용자 설치 폴더.
/// **Store 앱 실행 별칭은 거른다** — 실행하면 스토어 페이지를 여는 1KB 미만 스텁이다.
fn venv_python(root: &Path) -> Option<PathBuf> {
    for venv in [".venv", "venv", "env"] {
        for rel in [["Scripts", "python.exe"].as_slice(), ["bin", "python"].as_slice()] {
            let p = rel.iter().fold(root.join(venv), |a, s| a.join(s));
            if real_python(&p) {
                return Some(p);
            }
        }
    }
    if let Some(p) = env_python() {
        return Some(p);
    }
    // 사용자 설치(`%LOCALAPPDATA%\Programs\Python\Python3xx\python.exe`) — 가장 높은 판을 고른다
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from)?.join("Programs").join("Python");
    let mut best: Option<PathBuf> = None;
    for e in std::fs::read_dir(&base).ok()?.flatten() {
        let p = e.path().join("python.exe");
        if real_python(&p) && best.as_ref().map(|b| p > *b).unwrap_or(true) {
            best = Some(p);
        }
    }
    best
}

fn env_python() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for name in ["python.exe", "python3.exe", "python"] {
            let p = dir.join(name);
            if real_python(&p) {
                return Some(p);
            }
        }
    }
    None
}

/// 진짜 인터프리터인가 — Store 별칭(`%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe`,
/// 실측 121바이트)을 크기로 거른다. 실행해 보지 않는다(부팅 경로에서 프로세스를 안 띄운다).
fn real_python(p: &Path) -> bool {
    std::fs::metadata(p).map(|m| m.is_file() && m.len() > 4096).unwrap_or(false)
}

// ── C# / Roslyn ──────────────────────────────────────────────────────────────
/// Roslyn은 확장 로그를 **폴더로** 받는다(`--extensionLogDirectory`). 사용자 소스 폴더에
/// 로그를 흘리지 않게 앱 홈에 둔다 — 2.6.2 `ROSLYN_LOG`와 같은 자리.
fn cs_extra_args(_root: &Path) -> Vec<String> {
    let dir = ccg_store::app_home().join("lsp").join("roslyn-log");
    let _ = std::fs::create_dir_all(&dir);
    vec![format!("--extensionLogDirectory={}", dir.to_string_lossy())]
}

/// `initialized` 직후 — **Roslyn은 솔루션/프로젝트를 스스로 찾지 않는다.**
/// 열어 주지 않으면 모든 문서가 misc가 되고 프로젝트 심볼이 전멸한다.
///
/// 순서: ① [`root_for`]가 참조 확인까지 마친 솔루션 → ② 루트의 `.slnx`/`.sln`
/// (프리웜은 `root_for`를 안 거친다 — 그 경로로 뜬 서버는 스태시가 비어 있다) →
/// ③ 루트의 `.csproj`들(`project/open` 단독 로드).
fn cs_open_solution(rpc: &crate::rpc::Rpc, root: &Path) -> bool {
    let chosen = stashed_solution(root).or_else(|| first_solution_in(root, CS_SOLUTION_EXTS));
    if let Some(sln) = chosen {
        // 실제로 연 솔루션을 스태시에 채운다 — 멤버십 감시(`cs_membership_files`)가 이걸 본다.
        // 안 채우면 프리웜 경로로 뜬 서버만 재생성을 못 보고 새 프로젝트가 영영 무색이 된다.
        stash_solution(root, &sln);
        rpc.notify("solution/open", json!({ "solution": crate::server::path_to_uri(&sln) }));
        return true;
    }
    let projects = project_uris(root, CS_PROJECT_EXT);
    if !projects.is_empty() {
        rpc.notify("project/open", json!({ "projects": projects }));
        return true;
    }
    false
}

/// 멤버십을 정의하는 파일 — 로드한 솔루션(있으면) 하나, 없으면 루트의 `.csproj` 전부.
/// 솔루션 재생성(삭제→생성)도 같은 경로에 다시 생기므로 경로 목록이면 충분하다.
fn cs_membership_files(root: &Path) -> Vec<PathBuf> {
    if let Some(sln) = stashed_solution(root).or_else(|| first_solution_in(root, CS_SOLUTION_EXTS)) {
        return vec![sln];
    }
    files_with_ext(root, CS_PROJECT_EXT)
}

/// 멤버십이 갈렸다 — 같은 경로로 다시 연다(`cs_open_solution`과 같은 통지).
fn cs_reload_project(rpc: &crate::rpc::Rpc, root: &Path) -> bool {
    // 스태시를 비워 "지금 디스크에 있는" 솔루션을 다시 고르게 한다 —
    // 외부 도구가 `.sln`을 `.slnx`로 갈아치우는 경우가 실제로 있다.
    forget_solution(root);
    cs_open_solution(rpc, root)
}

const CS_PROJECT_EXT: &str = "csproj";
/// `.slnx`(신형 XML)를 먼저 본다 — 둘 다 있으면 신형이 진실이다(2.6.2와 같은 우선순위).
const CS_SOLUTION_EXTS: &[&str] = &["slnx", "sln"];

// ── C/C++ / clangd ───────────────────────────────────────────────────────────
/// clangd가 서는 폴더의 표식 — 이게 있는 폴더가 그 파일의 **컴파일 루트**다.
/// (없으면 [`RootRule::NearestMarker`]가 cwd로 떨어진다 = 2.6.2와 같은 동작)
const CPP_MARKERS: &[&str] = &["compile_commands.json", "CMakeLists.txt", ".clangd", "compile_flags.txt"];

/// **compile DB가 준비된 뒤에만** 인자를 붙인다 — 없는 폴더를 가리키면 clangd가 소스
/// 트리에서 CDB를 찾는 폴백까지 잃는다(그리고 그때 `.cache/clangd`가 소스 옆에 쌓인다).
/// 준비는 [`ServerSpec::prepare_root`](`cpp_prepare`)가 하고, 여기서는 결과만 읽는다.
fn cpp_extra_args(root: &Path) -> Vec<String> {
    match crate::cppdb::db_file(root) {
        // 이 한 줄이 "사용자 폴더에 흔적을 안 남긴다"의 전부다 — clangd의 디스크 인덱스는
        // **CDB 폴더 기준**으로 쌓이므로, CDB를 앱 홈에 두면 인덱스도 따라온다.
        Some(f) => vec![format!("--compile-commands-dir={}", f.parent().unwrap_or(root).to_string_lossy())],
        None => Vec::new(),
    }
}

/// UE면 UBT로 만들고, 아니면 프로젝트의 CDB를 앱 홈으로 미러한다. 새로 생겼으면 `true`.
fn cpp_prepare(root: &Path) -> bool {
    crate::cppdb::prepare(root)
}

/// 멤버십 파일 = 이 루트가 읽는 **원본 CDB**(UE는 우리가 만든 것, 아니면 프로젝트 안의 것).
/// 재생성되면 폴러가 잡아 [`cpp_reload_db`]가 clangd에 알린다.
fn cpp_membership_files(root: &Path) -> Vec<PathBuf> {
    crate::cppdb::source_cdb(root).into_iter().collect()
}

/// CDB가 갈렸다 — 앱 홈 사본을 맞추고 clangd에 그 파일의 변화를 알린다.
/// **재시작이 아니라 통지인 이유**: clangd는 CDB 경로를 인자로 이미 알고 있어서, 파일이
/// 갈린 것만 알면 그 자리에서 다시 읽고 열린 문서를 재파싱한다(재기동 = 인덱스 재구축).
/// 인자 자체가 바뀌어야 하는 경우(= DB가 **처음** 생긴 경우)는 `prepare_root`가 맡는다.
fn cpp_reload_db(rpc: &crate::rpc::Rpc, root: &Path) -> bool {
    crate::cppdb::prepare(root);
    let Some(db) = crate::cppdb::db_file(root) else { return false };
    rpc.notify(
        "workspace/didChangeWatchedFiles",
        json!({ "changes": [{ "uri": crate::server::path_to_uri(&db), "type": 2 }] }),
    );
    true
}

// ── 루트 탐색 공용 ───────────────────────────────────────────────────────────
/// `root_for`가 고른 솔루션을 `after_initialized`(인자가 root뿐)에 전달하는 스태시.
/// 2.6.2 `csSolutionByRoot`와 같은 자리 — 언어 이름이 아니라 **루트**로 키를 잡는다.
fn solution_stash() -> &'static Mutex<HashMap<String, PathBuf>> {
    static S: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}
fn stash_key(root: &Path) -> String {
    root.to_string_lossy().to_ascii_lowercase()
}
fn stash_solution(root: &Path, sln: &Path) {
    solution_stash().lock().unwrap().insert(stash_key(root), sln.to_path_buf());
}
fn stashed_solution(root: &Path) -> Option<PathBuf> {
    let p = solution_stash().lock().unwrap().get(&stash_key(root)).cloned()?;
    p.exists().then_some(p)
}
fn forget_solution(root: &Path) {
    solution_stash().lock().unwrap().remove(&stash_key(root));
}

/// 폴더 바로 아래의 `*.<ext>` 파일들(정렬 — 결정적 순서).
fn files_with_ext(dir: &Path, ext: &str) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|s| s.to_str()).map(|e| e.eq_ignore_ascii_case(ext)).unwrap_or(false))
        .collect();
    out.sort();
    out
}

fn project_uris(root: &Path, ext: &str) -> Vec<String> {
    files_with_ext(root, ext).iter().map(|p| crate::server::path_to_uri(p)).collect()
}

/// 루트 바로 아래의 첫 솔루션 파일 — `exts` 순서가 곧 우선순위(`slnx` 먼저).
fn first_solution_in(root: &Path, exts: &[&str]) -> Option<PathBuf> {
    exts.iter().find_map(|e| files_with_ext(root, e).into_iter().next())
}

/// 위로 걸어 올라가 `*.<ext>`가 있는 첫 폴더(`cwd` 경계까지, 최대 16단). 2.6.2 `nearestCsProjectRoot`.
fn nearest_dir_with_ext(abs: &Path, cwd: &Path, ext: &str) -> Option<PathBuf> {
    let stop = cwd.to_string_lossy().to_ascii_lowercase();
    let mut dir = abs.parent()?.to_path_buf();
    for _ in 0..16 {
        if !files_with_ext(&dir, ext).is_empty() {
            return Some(dir);
        }
        if dir.to_string_lossy().to_ascii_lowercase() == stop {
            break;
        }
        let Some(parent) = dir.parent() else { break };
        if parent == dir {
            break;
        }
        dir = parent.to_path_buf();
    }
    None
}

/// `dir` 안의 솔루션 중 `projects`(소문자 절대경로) 하나라도 **참조하는** 첫 파일 +
/// 그 솔루션이 참조하는 전체 프로젝트 수. 2.6.2 `slnReferencing`의 이식.
///
/// `.slnx`는 `Path="…csproj"`, `.sln`은 `"…\X.csproj"` — 어느 형식이든 **따옴표 안의
/// `.csproj` 경로**라서 정규식 없이 같은 방법으로 잡힌다.
fn solution_referencing(dir: &Path, exts: &[&str], projects: &HashSet<String>) -> Option<(PathBuf, usize)> {
    for ext in exts {
        for sln in files_with_ext(dir, ext) {
            let Ok(txt) = std::fs::read_to_string(&sln) else { continue };
            let mut count = 0usize;
            let mut matched = false;
            for quoted in txt.split('"').skip(1).step_by(2) {
                if !quoted.to_ascii_lowercase().ends_with(".csproj") {
                    continue;
                }
                count += 1;
                let abs = crate::normalize(&dir.join(quoted.replace('/', "\\")));
                if projects.contains(&abs.to_string_lossy().to_ascii_lowercase()) {
                    matched = true;
                }
            }
            if matched {
                return Some((sln, count));
            }
        }
    }
    None
}

/// 탐색 결과 메모 — `status`가 400ms마다 부르는 경로라 디스크 워크를 매번 하지 않는다.
fn root_memo() -> &'static Mutex<HashMap<String, (u64, PathBuf)>> {
    static M: OnceLock<Mutex<HashMap<String, (u64, PathBuf)>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// [`RootRule::ReferencingSolution`]의 본문 — 2.6.2 `csRootFor`의 이식(UE 특례 제외).
fn referencing_solution_root(
    abs: &Path,
    cwd: &Path,
    project_ext: &str,
    solution_exts: &'static [&'static str],
    ttl_ms: u64,
) -> PathBuf {
    // **먼저 표기를 접는다**(`C:/x` · `C:\x\` · `C:\x\.\y`). 이 함수는 경로를 문자열로
    // 대조하는 자리가 셋(조상 워크의 cwd 경계 · 메모 키 · 솔루션의 참조 확인)이라,
    // 섞인 구분자 하나가 "참조하는 솔루션을 못 찾는다"로 곧장 번진다(C-3와 같은 계열).
    let abs = crate::normalize(abs);
    let cwd = crate::normalize(cwd);
    let (abs, cwd) = (abs.as_path(), cwd.as_path());
    // 프로젝트 파일 조상이 없는 낱파일 — cwd로 떨어진다(misc 문서. 기본 색은 나온다)
    let Some(proj_dir) = nearest_dir_with_ext(abs, cwd, project_ext) else {
        return cwd.to_path_buf();
    };
    let key = format!("{}|{}", stash_key(&proj_dir), stash_key(cwd));
    if let Some((at, root)) = root_memo().lock().unwrap().get(&key) {
        if now_ms().saturating_sub(*at) < ttl_ms {
            return root.clone();
        }
    }
    let projects: HashSet<String> = files_with_ext(&proj_dir, project_ext)
        .iter()
        .map(|p| p.to_string_lossy().to_ascii_lowercase())
        .collect();
    // 후보 수집: 프로젝트 폴더 → cwd 경계까지 조상 워크. **참조 프로젝트 수 최대**를 고른다
    // (동률이면 안쪽 — 아래 비교가 `>`이고 루프가 안쪽부터 돈다).
    let mut best: Option<(PathBuf, PathBuf, usize)> = None;
    if !projects.is_empty() {
        let stop = stash_key(cwd);
        let mut dir = proj_dir.clone();
        for _ in 0..16 {
            if let Some((sln, n)) = solution_referencing(&dir, solution_exts, &projects) {
                if best.as_ref().map(|b| n > b.2).unwrap_or(true) {
                    best = Some((dir.clone(), sln, n));
                }
            }
            if stash_key(&dir) == stop {
                break;
            }
            let Some(parent) = dir.parent() else { break };
            if parent == dir {
                break;
            }
            dir = parent.to_path_buf();
        }
    }
    let root = match &best {
        Some((r, sln, _)) => {
            stash_solution(r, sln);
            r.clone()
        }
        // 참조 솔루션이 없다 — 프로젝트 폴더 단독 로드
        None => {
            forget_solution(&proj_dir);
            proj_dir
        }
    };
    let mut m = root_memo().lock().unwrap();
    if m.len() > 256 {
        m.clear();
    }
    m.insert(key, (now_ms(), root.clone()));
    root
}

/// 알려진 서버 전부. **언어 추가 = 여기 한 항목.**
///
/// R3에서 py·cs가 붙었다. 실제로 든 비용 — 엔진 3파일(`server.rs`/`manager.rs`/`rpc.rs`)의
/// **주석·테스트를 뺀 코드 줄** 기준. `manager.rs`·`rpc.rs`는 **0줄**이다.
///
/// | 언어 | `SPECS` | 스펙 훅 함수 | `server.rs` |
/// |---|---|---|---|
/// | **py** (pyright) | 1항목 | `py_configuration`(+인터프리터 탐색) | **+1** — `initialize`에 `workspace.configuration` 선언 |
/// | **cs** (Roslyn) | 1항목 | `cs_open_solution`·`cs_membership_files`·`cs_reload_project`·`cs_extra_args` | **+75** — 멤버십 감시(폴러 23 · 통지 짝 12 · 순수 헬퍼 38 · 상수/호출 2) |
///
/// py의 +1줄이 왜 필요했나(R2의 주장이 반쯤 틀렸던 자리): `configuration` 필드는 R2가
/// 만들었지만 **엔진이 `capabilities.workspace.configuration`을 선언하지 않아** 어떤 서버도
/// 그 경로로 묻지 않았다 — pyright는 실측으로 **한 번도 묻지 않았고**(2.6.2도 같다),
/// 필드는 죽은 채로 있었다. 선언 한 줄은 언어 이름이 없는 **LSP 클라이언트 능력**이라
/// 다음 언어에서 다시 열리지 않는다.
///
/// cs의 +75줄은 **새 확장점 하나**(`membership_files` + `reload_project`)의 값이다. 2.6.2는
/// 같은 일을 매니저 본문의 C# 전용 메서드 세 개(`watchCsSolution`·`watchCsProjectOpen`·
/// `watchCsProjects`, 합계 ~150줄)로 했고 거기엔 `csproj`·`sln`이 하드코딩돼 있었다.
/// 여기 75줄에는 **언어 이름이 한 번도 안 나온다** — C++(R4)가 `compile_commands.json`을
/// 멤버십 파일로 대면 이 줄은 다시 안 열린다. 그게 검증 대상이다.
///
/// **R4 판정: 그 75줄은 다시 안 열렸다(약속대로). 대신 새 확장점이 하나 더 필요했다.**
///
/// | 언어 | `SPECS` | 스펙 훅 함수 | `server.rs` | `manager.rs` | `rpc.rs` |
/// |---|---|---|---|---|---|
/// | **cpp** (clangd) | 1항목 | `cpp_extra_args`·`cpp_prepare`·`cpp_membership_files`·`cpp_reload_db` | **0** | **+21** | **0** |
///
/// `manager.rs`의 21줄은 [`ServerSpec::prepare_root`]의 호출부다(루트당 1회 백그라운드 실행
/// + 그 자리 접기). 거기에도 언어 이름은 없다. 왜 값으로 표현할 수 없었는지는 그 필드의
/// 주석에 적었다 — 한 줄로 줄이면 **"인자를 만들려면 먼저 파일을 만들어야 하고, 그 파일이
/// 생기면 이미 뜬 프로세스는 틀린 인자로 떠 있다"** 이다.
pub static SPECS: &[ServerSpec] = &[
ServerSpec {
    id: "ts",
    label: "TypeScript",
    langs: "TypeScript · JavaScript",
    exts_display: ".ts .tsx .mts .cts .js .jsx .mjs .cjs",
    kind: Provision::Bundled,
    requires: None,
    exts: &[
        ("ts", "typescript"),
        ("mts", "typescript"),
        ("cts", "typescript"),
        ("tsx", "typescriptreact"),
        ("js", "javascript"),
        ("mjs", "javascript"),
        ("cjs", "javascript"),
        ("jsx", "javascriptreact"),
    ],
    detect_markers: &["package.json", "tsconfig.json", "jsconfig.json"],
    launch: Launch::Node {
        module: &["typescript-language-server", "lib", "cli.mjs"],
        args: &["--stdio"],
    },
    // tsserver는 `typescript` 패키지에서 온다(`ts_init_options`가 경로를 못박는다) —
    // 실행 스크립트와 **다른 패키지**라 번들 목록에 따로 실어야 한다.
    extra_modules: &["typescript"],
    root: RootRule::ProjectCwd,
    init_options: ts_init_options,
    prepare_root: None,
    // tsserver-ls는 `workspace/configuration`을 **묻지 않는다**(R3 실측 — 능력을 선언해도
    // 안 묻는다). 줄 값도 없다.
    configuration: no_configuration,
    workspace_folders: no_workspace_folders,
    after_initialized: None,
    awaits_project_init: false,
    // tsserver는 워처 선언에 민감하지 않지만, **켤 이유도 없다** — 우리가 통지해 줄 수 있는
    // 변화(앱을 거친 쓰기)는 문서 동기화로 이미 반영되고, 외부 변화는 tsserver가 스스로 본다.
    declare_watched_files: false,
    reprime: Reprime::None,
    membership_files: no_membership_files,
    reload_project: None,
    watch_exts: &["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"],
    idle_ttl_ms: 10 * 60_000,
    cache_version: 1,
},
// ── Python (pyright) — "값만 다른 두 번째 언어"의 실증 ────────────────────────
ServerSpec {
    id: "py",
    label: "Pyright",
    langs: "Python",
    exts_display: ".py .pyw .pyi",
    kind: Provision::Bundled,
    requires: None,
    exts: &[("py", "python"), ("pyw", "python"), ("pyi", "python")],
    detect_markers: &["pyproject.toml", "requirements.txt", "setup.py"],
    launch: Launch::Node { module: &["pyright", "langserver.index.js"], args: &["--stdio"] },
    // pyright는 자기 완결이다 — 번들 JS(`dist/`)와 `typeshed-fallback/`이 같은 패키지 안에 있다.
    extra_modules: &[],
    root: RootRule::ProjectCwd,
    init_options: no_init_options,
    prepare_root: None,
    // 인터프리터·venv는 **이 경로로만** 들어간다(R3 실측: initializationOptions로는 안 먹는다).
    configuration: py_configuration,
    workspace_folders: no_workspace_folders,
    after_initialized: None,
    awaits_project_init: false,
    declare_watched_files: false,
    // pyright는 문서 동기화만으로 스스로 갱신한다(프라임 개념이 없다).
    reprime: Reprime::None,
    membership_files: no_membership_files,
    reload_project: None,
    watch_exts: &["py", "pyw", "pyi"],
    idle_ttl_ms: 10 * 60_000,
    cache_version: 1,
},
// ── C# (Roslyn) — 2.6.2가 피 흘려 얻은 함정이 전부 값이 되는 자리 ─────────────
ServerSpec {
    id: "cs",
    label: "C#",
    langs: "C#",
    exts_display: ".cs .csx",
    kind: Provision::Download,
    requires: Some((".NET SDK 10+ 필요", ".NET SDK 10+ required")),
    exts: &[("cs", "csharp"), ("csx", "csharp")],
    detect_markers: &["*.sln", "*.slnx", "*.csproj"],
    launch: Launch::Exe {
        bin: "Microsoft.CodeAnalysis.LanguageServer.exe",
        args: &["--stdio", "--logLevel=Information"],
        extra_args: cs_extra_args,
    },
    // `Launch::Exe` — 앱 홈에 내려받는 서버라 `node_modules`와 무관하다.
    extra_modules: &[],
    // 보는 파일이 csproj 하나여도 그 csproj를 **참조하는** 솔루션이 있으면 솔루션째 연다 —
    // 크로스 프로젝트 분석이 살고, 프로젝트를 오가도 서버가 하나만 뜬다.
    root: RootRule::ReferencingSolution {
        project_ext: CS_PROJECT_EXT,
        solution_exts: CS_SOLUTION_EXTS,
        ttl_ms: 30_000,
    },
    init_options: no_init_options,
    prepare_root: None,
    // Roslyn은 **능력 선언과 무관하게** `workspace/configuration`을 보낸다(R3 실측: razor·
    // html 섹션 4개). 줄 값은 없다 — null이면 서버 기본값이고, 그게 2.6.2와 같은 답이다.
    configuration: no_configuration,
    workspace_folders: no_workspace_folders,
    // Roslyn은 솔루션을 스스로 찾지 않는다 — 열어 주지 않으면 전 문서가 misc가 된다.
    after_initialized: Some(cs_open_solution),
    // initialize 응답 뒤에도 인덱싱이 이어진다(실측 3.1초) — 그 전엔 status를 starting으로.
    awaits_project_init: true,
    // **선언하면 Roslyn이 자기 폴백 워처를 끈다**(2.6.2 실측). 우리는 외부 빌드 산출물까지
    // 못 챙기므로 선언하지 않는다 — 남는 구멍(멤버십 재생성)은 아래 두 필드가 메운다.
    declare_watched_files: false,
    // frozen 토큰 모델 — 누가 풀 컴파일을 요구하지 않으면 크로스 프로젝트 심볼이 영영 미해석.
    reprime: Reprime::WorkspaceSymbol { quiet_gap_ms: 3_000 },
    membership_files: cs_membership_files,
    reload_project: Some(cs_reload_project),
    watch_exts: &["cs", "csx", "csproj", "sln", "slnx", "props", "targets"],
    // 솔루션 인덱싱이 비싼 서버 — 회수를 길게(2.6.2 IDLE_TTL_HEAVY).
    idle_ttl_ms: 30 * 60_000,
    cache_version: 1,
},
// ── C/C++ (clangd) — R3이 만든 확장점의 두 번째 사용자 ────────────────────────
ServerSpec {
    id: "cpp",
    label: "C/C++",
    langs: "C · C++",
    exts_display: ".c .h .cpp .cc .cxx .hpp .hxx .hh .inl",
    kind: Provision::Download,
    // clangd는 자기 완결 바이너리다(런타임 전제 없음). UE compile DB 생성에는
    // UnrealBuildTool이 필요하지만 **없어도 색·호버는 뜬다**(플래그 없는 폴백) — 그래서
    // 여기 적으면 거짓말이 된다.
    requires: None,
    // `.h`의 기본은 C++ — 세상에 그쪽이 압도적으로 많고, clangd는 어차피 컴파일 플래그와
    // 내용으로 다시 판단한다(2.6.2와 같은 표 + `.inl`).
    exts: &[
        ("c", "c"),
        ("h", "cpp"),
        ("cpp", "cpp"),
        ("cc", "cpp"),
        ("cxx", "cpp"),
        ("hpp", "cpp"),
        ("hxx", "cpp"),
        ("hh", "cpp"),
        ("inl", "cpp"),
    ],
    detect_markers: &["CMakeLists.txt", "compile_commands.json", "*.uproject"],
    launch: Launch::Exe {
        bin: "clangd.exe",
        // `--background-index`가 크로스 파일 정의 이동의 전제다(안 켜면 열어 본 파일만 안다).
        // 인덱스가 어디에 쌓이는지는 `--compile-commands-dir`가 정한다 → `cpp_extra_args`.
        args: &["--background-index", "--header-insertion=never"],
        extra_args: cpp_extra_args,
    },
    extra_modules: &[],
    // 컴파일 루트는 CDB/CMake가 있는 폴더다(없으면 cwd — 2.6.2와 같은 자리).
    root: RootRule::NearestMarker { markers: CPP_MARKERS },
    init_options: no_init_options,
    // ★ R4가 새로 판 확장점. 값(`extra_args`)은 "DB가 있으면 이 인자"까지만 말할 수 있고,
    //   "그 DB를 지금 만들어라"는 못 말한다 — 그게 이 필드다.
    prepare_root: Some(cpp_prepare),
    configuration: no_configuration,
    workspace_folders: no_workspace_folders,
    after_initialized: None,
    // clangd의 `initialize`는 즉시 답한다 — 인덱싱은 그 뒤에 `$/progress`로 흐른다.
    // `starting`으로 잡아 두면 배지가 영영 안 내려간다(진행률은 project_state가 그린다).
    awaits_project_init: false,
    // 우리가 알려 줄 수 있는 변화(앱을 거친 쓰기)는 문서 동기화로 반영되고, 외부 변화는
    // clangd가 스스로 본다. Roslyn과 같은 이유로 켤 값이 없다.
    declare_watched_files: false,
    // clangd에는 "전 프로젝트 프라임"이라는 개념이 없다 — 백그라운드 인덱스가 그 일을 한다.
    reprime: Reprime::None,
    membership_files: cpp_membership_files,
    reload_project: Some(cpp_reload_db),
    watch_exts: &["c", "h", "cpp", "cc", "cxx", "hpp", "hxx", "hh", "inl"],
    // 인덱스 재구축이 비싼 서버 — 회수를 길게(2.6.2 IDLE_TTL_HEAVY, cs와 같은 값).
    idle_ttl_ms: 30 * 60_000,
    cache_version: 1,
}];

/// 배포본에 실어야 할 `node_modules` 최상위 패키지 전부 — **[`SPECS`]에서 파생된다.**
///
/// 수기 목록을 따로 두지 않는 이유: 그 목록이 곧 두 번째 진실이 되고, 언어를 하나 붙일 때
/// 한쪽만 고쳐지면 **설치기에는 없고 코드에는 있는** 서버가 태어난다 — 그게 §1.6-A2로
/// 올라온 사고의 모양 그대로다(코드는 `Provision::Bundled`라 「항상 쓸 수 있다」고 말하는데
/// 배포본에는 파일이 없었다).
///
/// 나가는 곳 둘: `src-tauri/tauri.conf.json`의 `bundle.resources`(사람이 적는다)와
/// 그 둘을 대조하는 [`tests::every_bundled_node_package_is_in_the_installer_manifest`].
pub fn bundled_packages() -> Vec<&'static str> {
    let mut v: Vec<&'static str> = Vec::new();
    let mut add = |p: &'static str| {
        if !v.contains(&p) {
            v.push(p);
        }
    };
    for s in SPECS {
        if let Launch::Node { module, .. } = &s.launch {
            if let Some(first) = module.first() {
                add(first);
            }
        }
        for p in s.extra_modules {
            add(p);
        }
    }
    v.sort_unstable();
    v
}

/// 이 폴더의 **주력 언어** — 프리웜이 부른다(2.6.2 `detectProjectServer`).
/// 판정 재료는 폴더 바로 아래의 파일 이름 목록뿐이고, 표는 각 스펙의
/// [`ServerSpec::detect_markers`]에 있다. 우선순위 = [`SPECS`] 순서.
///
/// R3까지 이 표가 `lib.rs`에 하드코딩돼 있어 "다섯 번째 언어는 그 파일을 연다"였다(§R3-9 ④).
pub fn detect_project_spec(names: &[String]) -> Option<&'static ServerSpec> {
    SPECS.iter().find(|s| {
        s.detect_markers.iter().any(|m| match m.strip_prefix('*') {
            Some(suffix) => names.iter().any(|n| n.ends_with(suffix)),
            None => names.iter().any(|n| n == m),
        })
    })
}

/// 확장자를 맡는 스펙(없으면 `None`).
pub fn spec_for_ext(ext: &str) -> Option<&'static ServerSpec> {
    let e = ext.to_ascii_lowercase();
    SPECS.iter().find(|s| s.exts.iter().any(|(k, _)| *k == e))
}

/// 파일 경로를 맡는 스펙.
pub fn spec_for_path(abs: &Path) -> Option<&'static ServerSpec> {
    let ext = abs.extension()?.to_str()?;
    spec_for_ext(ext)
}

pub fn spec_by_id(id: &str) -> Option<&'static ServerSpec> {
    SPECS.iter().find(|s| s.id == id)
}

/// 스펙의 루트 규칙을 적용해 이 파일의 서버 루트를 정한다.
pub fn root_for(spec: &ServerSpec, abs: &Path, cwd: &Path) -> PathBuf {
    match spec.root {
        RootRule::ProjectCwd => cwd.to_path_buf(),
        RootRule::NearestMarker { markers } => {
            let mut dir = abs.parent();
            while let Some(d) = dir {
                if markers.iter().any(|m| d.join(m).exists()) {
                    return d.to_path_buf();
                }
                if d == cwd {
                    break;
                }
                dir = d.parent();
            }
            cwd.to_path_buf()
        }
        RootRule::ReferencingSolution { project_ext, solution_exts, ttl_ms } => {
            referencing_solution_root(abs, cwd, project_ext, solution_exts, ttl_ms)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ccg-lsp-spec-{name}"));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn put(p: &Path, body: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }

    /// R4의 게이트 — **네 언어**가 자기 확장자를 정확히 문다(겹치는 확장자가 없다).
    #[test]
    fn four_languages_claim_their_extensions() {
        for (e, id) in [
            ("ts", "ts"),
            ("TSX", "ts"),
            ("py", "py"),
            ("PYI", "py"),
            ("cs", "cs"),
            ("csx", "cs"),
            ("cpp", "cpp"),
            ("H", "cpp"),
            ("c", "cpp"),
            ("inl", "cpp"),
        ] {
            assert_eq!(spec_for_ext(e).map(|s| s.id), Some(id), "{e}");
        }
        for e in ["md", "verse", "rs"] {
            assert!(spec_for_ext(e).is_none(), "{e} — 3.0 범위 밖이어야 한다");
        }
        // 두 스펙이 같은 확장자를 주장하면 `spec_for_ext`가 조용히 앞엣것만 쓴다
        let mut seen: HashSet<&str> = HashSet::new();
        for s in SPECS {
            for (e, _) in s.exts {
                assert!(seen.insert(e), "{e}를 두 스펙이 주장한다");
            }
            assert!(s.cache_version >= 1, "{}: cache_version은 1부터다", s.id);
        }
    }

    /// ★ LSPDIST R1의 게이트 — **`Provision::Bundled`가 거짓말이 아닌가.**
    ///
    /// 스펙의 `kind`는 "앱에 같이 실린다 — 항상 쓸 수 있다"고 말한다. 그 말이 참이려면
    /// 설치기가 그 패키지를 실제로 실어야 하고, 그 목록은 `tauri.conf.json` 한 곳에만 있다.
    /// R28j까지 이 대조가 없어서, 코드는 `Bundled`인데 설치 폴더에는 파일이 없는 상태로
    /// **베타가 나갔다**(§1.6-A2). `install.rs::every_download_spec_has_a_source`가
    /// `Provision::Download`에 걸어 둔 것과 같은 규율을 `Bundled`에도 건다.
    #[test]
    fn every_bundled_node_package_is_in_the_installer_manifest() {
        let conf = concat!(env!("CARGO_MANIFEST_DIR"), "/../../src-tauri/tauri.conf.json");
        let body = std::fs::read_to_string(conf).expect("tauri.conf.json을 못 읽었다");
        let v: Value = serde_json::from_str(&body).expect("tauri.conf.json이 JSON이 아니다");
        let res = v["bundle"]["resources"].as_object().expect("bundle.resources가 없다 — 배포본에 모듈이 안 실린다");
        let dests: Vec<&str> = res.values().filter_map(Value::as_str).collect();
        let want = bundled_packages();
        assert!(!want.is_empty(), "Launch::Node 스펙이 하나도 없다면 이 테스트를 지워라");
        for pkg in &want {
            let prefix = format!("node_modules/{pkg}/");
            assert!(
                dests.iter().any(|d| d.starts_with(&prefix) || *d == prefix.trim_end_matches('/')),
                "{pkg}: tauri.conf.json의 bundle.resources에 없다. 배포본에서 이 서버는 안 뜬다 \
                 — 언어를 붙였으면 매니페스트도 한 줄 더해라"
            );
        }
        // 반대 방향도 본다: SPECS에서 사라진 패키지를 설치기가 계속 나르면 수십 MB가 유령으로 남는다.
        for d in &dests {
            let Some(rest) = d.strip_prefix("node_modules/") else { continue };
            let pkg = rest.split('/').next().unwrap_or("");
            assert!(want.contains(&pkg), "{pkg}: SPECS에 없는데 설치기가 나른다(유령 적재)");
        }
    }

    /// 파생 목록이 **양쪽 출처를 다 본다** — `Launch::Node`의 `module[0]`과 `extra_modules`.
    /// `typescript`가 빠지면 서버는 뜨는데 tsserver를 못 찾아 색이 반만 나온다.
    #[test]
    fn bundled_packages_covers_both_the_launcher_and_its_extras() {
        let v = bundled_packages();
        assert_eq!(v, vec!["pyright", "typescript", "typescript-language-server"], "{v:?}");
        for s in SPECS {
            match &s.launch {
                Launch::Node { module, .. } => assert!(v.contains(&module[0]), "{}: 실행 스크립트가 안 실린다", s.id),
                // 내려받는 서버는 번들 목록에 낄 자리가 없다(앱 홈에 설치된다).
                Launch::Exe { .. } => assert!(s.extra_modules.is_empty(), "{}: Exe 스펙에 번들 모듈이 붙었다", s.id),
            }
        }
    }

    /// 프리웜 감지 표가 **스펙 안에** 있다(§R3-9 ④) — 네 언어가 자기 표식을 문다.
    #[test]
    fn detect_markers_pick_the_project_language() {
        let names = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        for (files, id) in [
            (vec!["package.json", "readme.md"], Some("ts")),
            (vec!["pyproject.toml"], Some("py")),
            (vec!["bench.slnx"], Some("cs")),
            (vec!["mygame.uproject", "source"], Some("cpp")),
            (vec!["cmakelists.txt"], None), // 대소문자 그대로 비교한다(호출부가 소문자로 준다)
            (vec!["CMakeLists.txt"], Some("cpp")),
            (vec!["readme.md"], None),
        ] {
            assert_eq!(detect_project_spec(&names(&files)).map(|s| s.id), id, "{files:?}");
        }
        // 우선순위 = SPECS 순서. TS 프로젝트 안에 CMakeLists가 있어도 주력은 TS다.
        assert_eq!(
            detect_project_spec(&names(&["CMakeLists.txt", "package.json"])).map(|s| s.id),
            Some("ts")
        );
    }

    /// clangd 인자는 **DB가 준비된 뒤에만** 붙는다 — 없는 폴더를 가리키면 clangd가
    /// 소스 트리 폴백까지 잃는다(그러면 `.cache/clangd`가 사용자 폴더에 쌓인다).
    /// 그리고 그 DB 자리는 **프로젝트 밖**이어야 한다(인덱스가 CDB 폴더 옆에 쌓이므로).
    ///
    /// (실제 파일을 안 만든다 — 단위 테스트가 사용자 앱 홈에 쓰면 안 된다.
    ///  "DB가 있으면 인자가 붙는가"는 벤치가 실물 clangd로 확인한다.)
    #[test]
    fn cpp_points_clangd_outside_the_project_folder() {
        let w = scratch("cppargs");
        assert!(cpp_extra_args(&w).is_empty(), "DB가 없는데 인자가 붙었다");
        let dir = crate::cppdb::db_dir(&w);
        assert!(!dir.starts_with(&w), "compile DB가 프로젝트 안이면 인덱스도 거기 쌓인다: {dir:?}");
        assert!(dir.to_string_lossy().contains("cpp-db"), "{dir:?}");
    }

    /// C++ 루트는 **CDB/CMake가 있는 폴더** — 없으면 cwd(2.6.2와 같은 자리).
    #[test]
    fn cpp_root_is_the_nearest_compile_root() {
        let w = scratch("cpproot");
        put(&w.join("sub/proj/CMakeLists.txt"), "");
        put(&w.join("sub/proj/src/a.cpp"), "int main(){}");
        let spec = spec_by_id("cpp").unwrap();
        assert_eq!(root_for(spec, &w.join("sub/proj/src/a.cpp"), &w), w.join("sub/proj"));
        // 표식이 하나도 없으면 cwd로 떨어진다
        put(&w.join("loose/b.cpp"), "int main(){}");
        assert_eq!(root_for(spec, &w.join("loose/b.cpp"), &w), w);
    }

    /// 프로젝트 파일(csproj)은 **뷰어 확장자가 아니지만** 변화는 흘려야 한다.
    #[test]
    fn cs_watches_project_files_but_does_not_open_them() {
        let cs = spec_by_id("cs").unwrap();
        assert!(cs.language_id("csproj").is_none(), "csproj를 뷰어가 열지는 않는다");
        for e in ["csproj", "sln", "slnx", "props", "targets", "cs"] {
            assert!(cs.watches_ext(e), "{e} 변화를 놓치면 재프라임이 안 걸린다");
        }
    }

    /// **참조 프로젝트 수가 가장 많은 솔루션**을 고른다 — 도구가 떨궈 둔 단일 프로젝트 sln이
    /// 진짜 솔루션을 가리면 크로스 프로젝트 심볼이 무색으로 남는다(2.6.2 실측).
    #[test]
    fn referencing_solution_prefers_the_biggest_referencing_solution() {
        let w = scratch("bigsln");
        put(&w.join("src/App/App.csproj"), "<Project/>");
        put(&w.join("src/Core/Core.csproj"), "<Project/>");
        put(&w.join("src/App/Big.cs"), "class X {}");
        // 도구가 App 폴더에 떨궈 둔 단일 프로젝트 sln(안쪽·프로젝트 1개)
        put(&w.join("src/App/App.slnx"), "<Solution><Project Path=\"App.csproj\" /></Solution>");
        // 진짜 솔루션(바깥·프로젝트 2개)
        put(
            &w.join("Bench.slnx"),
            "<Solution><Project Path=\"src/Core/Core.csproj\" /><Project Path=\"src/App/App.csproj\" /></Solution>",
        );
        let spec = spec_by_id("cs").unwrap();
        let root = root_for(spec, &w.join("src/App/Big.cs"), &w);
        assert_eq!(root, w, "안쪽 단일 프로젝트 sln이 진짜 솔루션을 가렸다");
        assert_eq!(stashed_solution(&w), Some(w.join("Bench.slnx")));
    }

    /// `.slnx`와 `.sln`이 둘 다 있으면 신형 `.slnx`가 진실이다(2.6.2와 같은 우선순위).
    #[test]
    fn slnx_wins_over_sln() {
        let w = scratch("slnxwins");
        put(&w.join("App/App.csproj"), "<Project/>");
        put(&w.join("App/A.cs"), "class X {}");
        put(&w.join("Old.sln"), "Project(\"{X}\") = \"App\", \"App\\App.csproj\", \"{Y}\"");
        put(&w.join("New.slnx"), "<Solution><Project Path=\"App/App.csproj\" /></Solution>");
        let spec = spec_by_id("cs").unwrap();
        assert_eq!(root_for(spec, &w.join("App/A.cs"), &w), w);
        assert_eq!(stashed_solution(&w), Some(w.join("New.slnx")));
        // 멤버십 감시는 **로드한 그 파일**을 본다
        assert_eq!(cs_membership_files(&w), vec![w.join("New.slnx")]);
    }

    /// 참조 확인이 핵심이다 — 무관한 거대 sln은 물지 않는다(UE 모노레포의 그 사고).
    #[test]
    fn unrelated_solution_is_not_adopted() {
        let w = scratch("unrelated");
        put(&w.join("mine/Mine.csproj"), "<Project/>");
        put(&w.join("mine/A.cs"), "class X {}");
        put(&w.join("Engine.slnx"), "<Solution><Project Path=\"other/Other.csproj\" /></Solution>");
        let spec = spec_by_id("cs").unwrap();
        // 참조하지 않으므로 솔루션을 안 문다 → csproj 폴더 단독 로드
        assert_eq!(root_for(spec, &w.join("mine/A.cs"), &w), w.join("mine"));
        assert_eq!(stashed_solution(&w.join("mine")), None);
        // 단독 로드 루트의 멤버십 파일 = 그 폴더의 csproj들
        assert_eq!(cs_membership_files(&w.join("mine")), vec![w.join("mine/Mine.csproj")]);
    }

    /// csproj 조상이 아예 없는 낱파일 — cwd로 떨어진다(misc 문서. 크래시하지 않는다).
    #[test]
    fn orphan_file_falls_back_to_cwd() {
        let w = scratch("orphan");
        put(&w.join("loose/A.cs"), "class X {}");
        let spec = spec_by_id("cs").unwrap();
        assert_eq!(root_for(spec, &w.join("loose/A.cs"), &w), w);
    }

    /// pyright 설정은 **인터프리터를 찾았을 때만** `python` 섹션을 채운다.
    /// 못 찾으면 `null` — 그게 2.6.2와 같은 답이고, 서버가 스스로 찾는다.
    #[test]
    fn py_configuration_answers_only_known_sections() {
        let w = scratch("pycfg");
        let a = py_configuration(&w, "python.analysis").unwrap();
        assert_eq!(a["diagnosticMode"], "openFilesOnly");
        assert!(py_configuration(&w, "python.nonsense").is_none());
        // 인터프리터가 있는 기계에서는 pythonPath가 실재 파일이어야 한다
        if let Some(p) = py_configuration(&w, "python") {
            let exe = PathBuf::from(p["pythonPath"].as_str().unwrap());
            assert!(exe.is_file(), "{exe:?}");
            assert!(real_python(&exe), "Store 앱 실행 별칭을 인터프리터로 내주면 안 된다");
        }
    }

    /// venv가 있으면 **그것이 이긴다**(PATH·사용자 설치보다 우선).
    #[test]
    fn venv_python_beats_the_path() {
        let w = scratch("venv");
        let venv = w.join(".venv/Scripts/python.exe");
        put(&venv, &"x".repeat(5000)); // 4KB 넘는 '진짜' 파일
        assert_eq!(venv_python(&w), Some(venv));
    }

    /// Store 앱 실행 별칭(실측 121바이트)은 인터프리터가 아니다.
    #[test]
    fn store_alias_is_not_an_interpreter() {
        let w = scratch("stub");
        let stub = w.join(".venv/Scripts/python.exe");
        put(&stub, "stub"); // 4바이트
        assert_ne!(venv_python(&w), Some(stub));
    }
}
