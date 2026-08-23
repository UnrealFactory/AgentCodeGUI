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
//! | 무거운 서버는 유휴 회수를 길게 | [`ServerSpec::idle_ttl_ms`] |
//! | 토큰 캐시 포맷이 바뀌면 옛 캐시를 버려야 | [`ServerSpec::cache_version`] |
//!
//! **검증 기준**(다음 라운드): C#·C++를 붙이는 diff가 이 파일의 `SPECS` 배열에 항목을
//! 하나씩 더하는 것으로 끝나야 한다. 엔진 파일이 열리면 그 설계는 실패한 것이다.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

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
    /// 네이티브 실행 파일 — 앱 홈의 `lsp/bin/<id>/`에서 찾는다.
    /// `extra_args`는 **루트별** 인자(clangd의 `--compile-commands-dir=<앱 홈 DB>`).
    #[allow(dead_code)] // R2(C#/C++)에서 배선 — 스펙 필드는 지금 확정해 둔다
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
    #[allow(dead_code)] // R2에서 배선
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
    #[allow(dead_code)] // R2에서 배선
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
    /// 외부 전제(설정에 표시) — 예: ".NET SDK 10+ 필요"
    pub requires: Option<&'static str>,

    /// 확장자(점 없이, 소문자) → LSP `languageId`.
    pub exts: &'static [(&'static str, &'static str)],

    pub launch: Launch,
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
#[allow(dead_code)] // R2 스펙들이 쓴다(TS는 자기 옵션이 있다)
fn no_init_options(_root: &Path) -> Option<Value> {
    None
}
fn no_workspace_folders(_root: &Path) -> Option<Vec<(String, String)>> {
    None
}
/// 서버가 설정을 물어와도 줄 게 없다(tsserver-ls) — 항목마다 `null`이 간다.
fn no_configuration(_root: &Path, _section: &str) -> Option<Value> {
    None
}
#[allow(dead_code)] // R2(clangd)에서 쓴다
fn no_extra_args(_root: &Path) -> Vec<String> {
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

/// 알려진 서버 전부. **언어 추가 = 여기 한 항목.**
///
/// R1이 끝까지 미는 것은 `ts` 하나다. R2에서 붙을 항목은 이 배열에 이런 모양으로 들어간다
/// (필드가 이미 다 있다는 게 이 라운드의 검증 대상이다):
///
/// **pyright — 크리틱 §5.1의 종이 시험을 그대로 값으로 옮긴 것.** R1에서 이 스펙이
/// 성립하지 못한 이유는 `workspace/configuration`뿐이었고(C-5), 그 축이 `configuration`
/// 필드로 들어와 이제 **정말 값만 다르다**:
///
/// ```ignore
/// fn py_configuration(root: &Path, section: &str) -> Option<Value> {
///     match section {
///         // 인터프리터·venv는 이 경로로만 들어간다(initializationOptions로는 안 먹는다)
///         "python" => Some(json!({ "pythonPath": venv_python(root)?, "venvPath": root.to_string_lossy() })),
///         "python.analysis" => Some(json!({ "typeCheckingMode": "basic", "diagnosticMode": "openFilesOnly" })),
///         _ => None,
///     }
/// }
/// ServerSpec {
///     id: "py", label: "Pyright", langs: "Python", exts_display: ".py .pyi",
///     kind: Provision::Bundled, requires: None,
///     exts: &[("py", "python"), ("pyi", "python")],
///     launch: Launch::Node { module: &["pyright", "langserver.index.js"], args: &["--stdio"] },
///     root: RootRule::ProjectCwd,
///     init_options: no_init_options,
///     configuration: py_configuration,          // ← C-5가 요구한 그 자리(rpc.rs 무수정)
///     workspace_folders: no_workspace_folders,
///     after_initialized: None, awaits_project_init: false,
///     declare_watched_files: false, reprime: Reprime::None,
///     watch_exts: &["py", "pyi"],
///     idle_ttl_ms: 10 * 60_000, cache_version: 1,
/// }
/// ```
///
/// ```ignore
/// ServerSpec {
///     id: "cs", label: "C#", kind: Provision::Download,
///     requires: Some(".NET SDK 10+ 필요"),
///     exts: &[("cs", "csharp"), ("csx", "csharp")],
///     launch: Launch::Exe { bin: "Microsoft.CodeAnalysis.LanguageServer.exe",
///                           args: &["--stdio", "--logLevel=Information"], extra_args: roslyn_log_dir },
///     root: RootRule::ReferencingSolution { project_ext: "csproj",
///                                           solution_exts: &["sln", "slnx"], ttl_ms: 30_000 },
///     after_initialized: Some(roslyn_open_solution),
///     awaits_project_init: true,
///     configuration: roslyn_configuration,                // ← 옵션 묶음(csharp|*)을 이 경로로 문다
///     declare_watched_files: false,                       // ← 선언하면 폴백 워처가 꺼진다
///     // 조용 간격만 값이다. 나머지 네 규약(didOpen 뒤 1.5초·재대기 루프·프라임 중
///     // 무효화·히트 0 쿼리·단일 비행)은 엔진이 스펙과 무관하게 지킨다(server.rs).
///     reprime: Reprime::WorkspaceSymbol { quiet_gap_ms: 3_000 },
///     watch_exts: &["cs", "csx", "csproj", "sln", "slnx", "props", "targets"],
///     idle_ttl_ms: 30 * 60_000,
///     ..
/// }
/// ```
pub static SPECS: &[ServerSpec] = &[ServerSpec {
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
    launch: Launch::Node {
        module: &["typescript-language-server", "lib", "cli.mjs"],
        args: &["--stdio"],
    },
    root: RootRule::ProjectCwd,
    init_options: ts_init_options,
    // tsserver-ls도 `workspace/configuration`을 물어 온다 — 줄 값이 없을 뿐이다.
    // (엔진은 그래도 items 수만큼 null을 돌려준다 — rpc.rs 참고)
    configuration: no_configuration,
    workspace_folders: no_workspace_folders,
    after_initialized: None,
    awaits_project_init: false,
    // tsserver는 워처 선언에 민감하지 않지만, **켤 이유도 없다** — 우리가 통지해 줄 수 있는
    // 변화(앱을 거친 쓰기)는 문서 동기화로 이미 반영되고, 외부 변화는 tsserver가 스스로 본다.
    declare_watched_files: false,
    reprime: Reprime::None,
    watch_exts: &["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"],
    idle_ttl_ms: 10 * 60_000,
    cache_version: 1,
}];

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
        // R2에서 구현(2.6.2 `csRootFor`의 이식) — 지금은 cwd로 안전하게 떨어진다.
        RootRule::ReferencingSolution { .. } => cwd.to_path_buf(),
    }
}
