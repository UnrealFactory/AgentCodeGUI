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
/// **④가 배포본에 절대 안 닿는 이유**(★R3 정정 · 크리틱 R2-L2): 판정은 두 조건의 **AND**다 —
/// ⓐ 폴더 이름이 `target…`인 조상이 한두 칸 위에 있고 ⓑ 그 폴더에 `.cargo-lock`이 있다.
///
/// > R2는 ⓑ만 걸고 *"`tauri_utils::platform::resource_dir`가 「개발 중인가」를 가르는 바로 그
/// > 신호"*라고 적었는데 **두 군데가 틀렸다**. 첫째, 상류는 `target` 폴더명 조건을 **AND로 더**
/// > 건다(*"This ensures the check is safer so it doesn't affect apps in production"*). 둘째,
/// > **Windows에서는 `cfg!(target_os = "windows")`가 먼저 단락되어 상류가 `.cargo-lock`을 아예
/// > 안 본다** — 그러니 그 인용은 이 플랫폼에서 성립하지 않는 서술이었다.
/// > 크리틱 실측(G6): `$INSTDIR`에 **0바이트** `.cargo-lock`을 심으면 PATH 칸이 열렸다.
/// > 상류의 조건을 마저 가져와 그 문을 닫는다(단, 이 레포는 `target-lspdist`처럼 접미사가
/// > 붙은 타깃 폴더를 쓰므로 `starts_with("target")`으로 본다).
///
/// [남은 위험 · 정직하게] 사이드카가 **없어진** 설치본(백신 격리 등)은 이제 PATH로 못
/// 살아난다 — 조용히 다른 판을 무는 대신 **소리 내어 죽는다**. 그 교환은 의도한 것이고,
/// 그때 하는 말은 [`node_search_hint`]가 만든다(★R3 — R2까지 그 말이 틀렸다).
pub fn node_exe() -> Option<PathBuf> {
    node_exe_from(env_path("CCG_LSP_NODE"), exe_dir())
}

/// 런타임 후보들 — **사슬의 단일 출처.** `(칸 이름, 경로)`를 우선순위대로 낸다.
///
/// ★R3(크리틱 R2-C1)이 이 함수를 판 이유: R2는 사슬을 `node_exe_from`에 두고 진단 문자열은
/// `server.rs`에 **따로** 적었다. 그래서 사슬이 바뀌어도 문자열은 안 바뀌었고, 배포본이
/// 죽을 때 *"CCG_LSP_NODE · exe 옆 node.exe · **PATH** 순으로 찾는다"*라고 말했다 —
/// 그 상황에서 PATH는 **안 보는데도**. 이제 탐색과 진단이 **같은 목록**을 읽는다.
/// 둘이 갈라질 수 있는 구조를 없애는 것이 고침의 본체다(문구 수정이 아니라).
fn node_candidates(exe_dir: &Path) -> Vec<(&'static str, PathBuf)> {
    let mut v: Vec<(&'static str, PathBuf)> = Vec::new();
    // ② exe 옆 사이드카 — **배포본이 여기다**
    v.push(("② 설치 폴더 사이드카", exe_dir.join("node.exe")));
    v.push(("② resources 사이드카", exe_dir.join("resources").join("node.exe")));
    // ③ 개발 — exe 조상의 스테이징 산출물(`npm run tauri:build`가 만든 그 파일)
    let mut cur: Option<&Path> = Some(exe_dir);
    while let Some(c) = cur {
        v.push(("③ 개발 스테이징", c.join("src-tauri").join(STAGED_RUNTIME_DIR).join("node.exe")));
        cur = c.parent();
    }
    v
}

/// [`node_exe`]의 순수 알맹이 — 테스트가 가짜 exe 폴더를 먹인다.
fn node_exe_from(explicit: Option<PathBuf>, exe_dir: Option<PathBuf>) -> Option<PathBuf> {
    // ① 명시 지정(벤치·포터블 배포)
    if let Some(p) = explicit {
        return Some(p);
    }
    let d = exe_dir?;
    if let Some((_, p)) = node_candidates(&d).into_iter().find(|(_, p)| p.is_file()) {
        return Some(p);
    }
    // ④ PATH — **cargo 산출 폴더에서 뜬 exe일 때만**(배포본은 절대 여기 못 온다)
    if is_cargo_output_dir(&d) {
        return which("node.exe").or_else(|| which("node"));
    }
    None
}

/// 런타임을 못 찾았을 때 화면·로그에 실을 진단 — **실제로 뒤진 자리를 그대로 싣는다.**
///
/// ★R3 · 크리틱 R2-C1. R2가 「조용히 틀린 판을 무는 것보다 소리 내어 죽는 편이 낫다」를 사서
/// PATH를 끊었는데, **죽을 때 하는 말이 틀렸으면 그 거래에서 산 것을 절반 잃는다.**
/// R1이 모듈 쪽에 [`module_search_hint`]로 고친 병을 런타임 쪽에 대칭으로 놓는다.
///
/// **ko/en 한 문자열인 이유**: 이건 Rust가 만드는 문자열이라 렌더러의 `t()`를 못 탄다
/// (스펙의 `requires`/`requiresEn`이 두 벌을 실어 나르는 것과 같은 사정 — §R3-9 ⑤).
/// 계약면을 갈라 두 벌로 나르는 길은 `ipc/lsp.rs`를 여는데 그 파일은 지금 다른 갈래(HOSTI18N)의
/// 것이라, **한 문자열에 두 언어를 담고** 경로는 언어와 무관하게 그대로 싣는다.
/// 나중에 호스트 i18n이 서면 이 함수가 낼 값을 쪼개면 된다(경로 목록은 그대로 쓰인다).
pub fn node_search_hint() -> String {
    let Some(d) = exe_dir() else {
        return "실행 파일 경로를 못 읽었다 / cannot resolve current exe path".to_string();
    };
    let env_set = std::env::var("CCG_LSP_NODE").ok().filter(|s| !s.is_empty());
    let gate = cargo_gate(&d);
    let mut lines: Vec<String> = Vec::new();
    lines.push(match &env_set {
        Some(v) => format!("① CCG_LSP_NODE={v} (그 자리에 파일이 없다 / not a file)"),
        None => "① CCG_LSP_NODE 미설정 / unset".to_string(),
    });
    // ③은 exe 조상마다 한 줄이라 드라이브 뿌리까지 일곱 줄이 되기도 한다. 사용자가 읽는
    // 문장이므로 **두 줄까지만 적고 나머지는 개수로** 말한다 — 자리를 숨기는 게 아니라
    // 「몇 칸을 더 봤는지」를 정확히 밝힌다(진단의 값은 ②와 ④에 있다).
    let cands = node_candidates(&d);
    let mut staged_shown = 0usize;
    let mut staged_hidden = 0usize;
    for (slot, p) in &cands {
        if slot.starts_with('③') {
            staged_shown += 1;
            if staged_shown > 2 {
                staged_hidden += 1;
                continue;
            }
        }
        lines.push(format!("{slot}: {} (없음 / missing)", p.to_string_lossy()));
    }
    if staged_hidden > 0 {
        lines.push(format!("③ 개발 스테이징: 조상 {staged_hidden}칸 더 봤지만 없다 / {staged_hidden} more ancestors"));
    }
    // ★마감(확인 크리틱 R3 **R3-L1**) — ④ 줄과 머리 문장이 **닫힌 이유를 갈라 말한다.**
    //
    // R3까지는 게이트가 닫히기만 하면 무조건 「배포본이라」였고 머리 문장은 「다시 설치해
    // 주세요」였다. 그런데 게이트가 닫히는 이유는 **둘**이다 — `.cargo-lock`이 없거나(진짜
    // 배포본), 있는데 폴더 이름이 `target…`이 아니거나(말단을 바꾼 `CARGO_TARGET_DIR`).
    // 뒤엣것은 **개발 판**인데 거기에 대고 재설치를 권하면, R2-C1이 고친 병
    // (**검증하지 않은 이유를 단정한다**)의 축소판을 그대로 다시 저지르는 것이다.
    let deployed = matches!(gate, CargoGate::NoLock);
    lines.push(
        match gate {
            CargoGate::Open => "④ PATH: cargo 산출 폴더라 봤지만 node를 못 찾았다 / searched PATH (cargo output dir)",
            CargoGate::NoLock => "④ PATH: 보지 않는다 — 배포본이다(`.cargo-lock` 없음) / not consulted: deployed build",
            // 이 줄이 R3-L1이 연 자리다. 「배포본이라」고 단정하지 않고 **본 것**만 말한다.
            CargoGate::NotTargetDir => {
                "④ PATH: 보지 않는다 — `.cargo-lock`은 있지만 폴더 이름이 `target…`이 아니다(개발 판일 수 있다) \
                 / not consulted: has .cargo-lock but folder is not named target…"
            }
        }
        .to_string(),
    );
    // 머리 문장도 같이 갈린다 — 개발자에게 「다시 설치」는 헛수고고, 그 자리의 진짜 처방은
    // 스테이징이나 `CCG_LSP_NODE`다.
    let head = if deployed {
        "설치된 Node 런타임을 못 찾았어요. 설치가 손상됐을 수 있으니 앱을 다시 설치해 주세요 \
         (PATH에 node를 깔아도 낫지 않아요). / The bundled Node runtime is missing — reinstall the app; \
         installing Node on PATH will not help."
    } else {
        "Node 런타임을 못 찾았어요. 개발 배치로 보입니다 — `node scripts/tauri-build.mjs stage`로 \
         런타임을 받거나 `CCG_LSP_NODE`로 직접 지정해 주세요. / Node runtime not found. This looks like a \
         dev layout — run `node scripts/tauri-build.mjs stage`, or point `CCG_LSP_NODE` at a node binary."
    };
    format!("{head} 찾아본 자리 / looked in:\n  - {}", lines.join("\n  - "))
}

/// 스테이징 자리 이름 — `scripts/tauri-build.mjs`와 `tauri.conf.json`이 쓰는 그 이름.
/// 세 곳이 같아야 개발(③)과 배포(②)가 같은 파일을 문다.
pub const STAGED_RUNTIME_DIR: &str = "lsp-runtime";

/// ★LSPIDLE R1 — **모듈 스테이징 자리.** 런타임(`lsp-runtime`)의 짝이다.
///
/// R2까지 `bundle.resources`는 레포의 `../node_modules/…`를 **그대로** 가리켰고, 그래서
/// 설치기는 그 폴더를 통째로 날랐다 — 안 쓰는 14.1MB까지(§`docs/parity-fix-lspdist-r1.md` §6:
/// `_tsc.js` 6.2MB · 로케일 13벌 4.5MB · 소스맵 4.1MB). R1은 그걸 알고도 남겼다.
/// 사유가 「파일 목록을 손으로 관리하는 비용」이었는데, 그 비용을 **거르는 규칙**으로
/// 바꾸면(=지우는 목록이 아니라 안 싣는 패턴) 판이 올라도 목록이 안 썩는다.
///
/// 이제 사슬은 레포 → **거른 사본** → 설치기다. 매니페스트는 여전히 「거울」이지만
/// 비추는 대상이 거른 사본이고, 그 대조는 `spec.rs`의 매니페스트 못이 한다.
pub const STAGED_MODULES_DIR: &str = "lsp-modules";

// ── ★LSPIDLE R1 — 손자 프로세스의 conhost 끊기 ───────────────────────────────

/// node 자식들이 **콘솔을 만들지 않게** 하는 프리로드 조각. 내용은 여기 문자열이 원본이고,
/// 첫 기동 때 앱 홈에 떨군다(번들에 파일을 더하지 않는다 — 매니페스트 계약을 안 건드린다).
///
/// ## 왜 필요한가 — 플래그만으로는 절반만 닫힌다
///
/// [`crate::server`]의 `DETACHED_PROCESS`는 **우리가 띄우는 프로세스**의 콘솔을 없앤다.
/// 그런데 TypeScript 서버는 두 겹이다: 우리가 띄우는 것은 `typescript-language-server`이고,
/// 그것이 자기 손으로 `tsserver`를 `child_process.fork`한다. node의 기본값이
/// `windowsHide:true`(=`CREATE_NO_WINDOW`)라 **그 손자가 콘솔을 새로 만든다** — 실측:
/// 플래그만 바꾸면 conhost가 사라지는 게 아니라 부모에서 손자로 **옮겨간다**(둘 다 1개).
///
/// 우리는 그 fork 호출을 못 고친다. 그래서 그 프로세스의 node에게 **기본값을 바꿔 준다**:
/// `NODE_OPTIONS=--require <이 파일>`은 node 트리 전체에 상속되므로, tsls가 tsserver를,
/// tsserver가 typingsInstaller를 띄울 때도 같이 적용된다.
/// libuv에서 `detached: true` → `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`이라
/// 결과가 우리 플래그와 같아진다. 실측(`scripts/poc-lspidle-reclaim.mjs`):
/// 정상 상태 자손이 **3(node·node·conhost) → 2(node·node)**.
///
/// ## 안전 규약 — 없으면 **안 건다**
///
/// `--require`가 가리키는 파일이 없으면 node는 `MODULE_NOT_FOUND`로 **기동 자체가 실패한다**.
/// 즉 이 조각이 유실되면 그 대가가 「conhost가 하나 늘어난다」가 아니라 「코드 인텔리전스가
/// 통째로 죽는다」다. 그래서 [`node_preload`]는 **파일을 쓰고 실재를 확인한 뒤에만** 경로를
/// 돌려주고, 실패하면 `None` → 호출부는 `NODE_OPTIONS`를 아예 안 건다(서버는 그대로 뜨고
/// conhost만 하나 남는다). 잃는 것이 큰 쪽으로 기울지 않게 만든 기본값이다.
///
/// 조각 자체도 **아무것도 던지지 않는다**: 감싸는 대상이 함수가 아니면 그냥 넘어가고,
/// win32가 아니면 손대지 않는다.
const NO_CONSOLE_PRELOAD: &str = r#"// AgentCodeGUI — LSP 자식 프로세스가 콘솔(conhost)을 만들지 않게 한다.
// 이 파일은 앱이 만든다(crates/ccg-lsp/src/launch.rs::NO_CONSOLE_PRELOAD). 직접 고치지 마라 —
// 다음 기동에 덮어쓴다. 실패해도 서버가 죽지 않도록 어떤 경우에도 throw하지 않는다.
'use strict'
try {
  if (process.platform === 'win32') {
    const cp = require('child_process')
    // libuv: detached → DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP → 콘솔을 안 만든다.
    // 트리 종료(taskkill /T)와 잡 오브젝트는 ppid를 보므로 그대로 동작한다.
    const wrap = (name) => {
      const orig = cp[name]
      if (typeof orig !== 'function') return
      cp[name] = function (...a) {
        const i = a.length - 1
        const isOpts = i >= 1 && a[i] && typeof a[i] === 'object' && !Array.isArray(a[i]) && typeof a[i] !== 'function'
        if (isOpts) a[i] = Object.assign({}, a[i], { detached: true })
        else a.push({ detached: true })
        return orig.apply(this, a)
      }
    }
    wrap('spawn')
    wrap('fork')
    wrap('execFile')
  }
} catch {
  /* 콘솔이 하나 더 뜰 뿐이다 — 서버를 죽이지 않는다 */
}
"#;

/// 프리로드 조각의 자리(앱 홈). 없거나 내용이 다르면 쓰고, **실재를 확인한 뒤** 돌려준다.
/// 못 쓰면 `None` — 호출부는 그때 `NODE_OPTIONS`를 안 건다(위 「안전 규약」).
pub fn node_preload() -> Option<PathBuf> {
    let dir = ccg_store::app_home().join("lsp");
    let p = dir.join("no-console-spawn.cjs");
    let ok = std::fs::read_to_string(&p).map(|s| s == NO_CONSOLE_PRELOAD).unwrap_or(false);
    if !ok {
        std::fs::create_dir_all(&dir).ok()?;
        std::fs::write(&p, NO_CONSOLE_PRELOAD).ok()?;
    }
    p.is_file().then_some(p)
}

/// `NODE_OPTIONS`에 실을 값 — 기존 값이 있으면 **앞에 두고 이어 붙인다**(사용자가 건 옵션을
/// 지우지 않는다). 경로는 슬래시로 적는다: node의 `NODE_OPTIONS` 파서는 역슬래시를
/// 이스케이프로 볼 여지가 있어, 사용자 이름에 든 `\U` 같은 조각에서 조용히 깨질 수 있다.
pub fn node_options_with_preload(existing: Option<String>) -> Option<String> {
    let p = node_preload()?;
    let arg = format!("--require \"{}\"", p.to_string_lossy().replace('\\', "/"));
    Some(match existing.filter(|s| !s.trim().is_empty()) {
        Some(prev) => format!("{prev} {arg}"),
        None => arg,
    })
}

/// 이 폴더가 **cargo 산출 폴더**인가 — ⓐ 한두 칸 위 조상 폴더 이름이 `target…`이고
/// ⓑ 여기에 cargo가 남기는 `.cargo-lock`이 있다. **AND다**(★R3 · 크리틱 R2-L2).
///
/// `tauri_utils::platform`(2.9.3)이 거는 조건을 그대로 옮겼다:
/// `(parts[len-2] == "target") || (parts[len-3] == "target")` **&&** `is_cargo_output_directory(..)`.
/// R2는 뒤 절반만 가져왔고, 그래서 `$INSTDIR`에 빈 `.cargo-lock` 하나를 심는 것만으로
/// PATH 칸이 열렸다(크리틱 G6 실측). 이 레포는 `target-lspdist`·`target-lead`처럼 접미사가
/// 붙은 타깃 폴더를 여럿 쓰므로 이름 비교는 `starts_with("target")`이다.
///
/// 배치별 판정:
/// `…\target-lspdist\release`(개발) ✔ · `…\target\x86_64-pc-windows-msvc\release` ✔ ·
/// `%LOCALAPPDATA%\AgentCodeGUI3`(배포) ✘ — `.cargo-lock`을 심어도 ✘.
fn is_cargo_output_dir(dir: &Path) -> bool {
    matches!(cargo_gate(dir), CargoGate::Open)
}

/// 게이트의 **판정과 그 이유** — ★마감(크리틱 R3-L1).
///
/// `bool` 하나로는 「왜 닫혔는가」를 못 말한다. 그런데 진단 문장이 바로 그것을 말해야 한다
/// ([`node_search_hint`]) — 닫힌 이유가 「`.cargo-lock` 없음」이면 배포본이고,
/// 「폴더 이름」이면 개발 판일 수 있어서 **처방이 정반대**다(재설치 ↔ 스테이징).
/// R2-C1이 고친 병이 「검증하지 않은 이유를 단정한다」였으므로, 이유를 값으로 들고 다닌다.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum CargoGate {
    /// cargo 산출 폴더가 맞다 — ④ PATH 칸이 열린다.
    Open,
    /// `.cargo-lock`이 없다 = NSIS가 깐 배포본.
    NoLock,
    /// `.cargo-lock`은 있는데 조상 폴더 이름이 `target…`이 아니다.
    /// 말단을 바꾼 `CARGO_TARGET_DIR`(예: `…/build/release`)이 여기 온다 — **개발 판일 수 있다.**
    NotTargetDir,
}

fn cargo_gate(dir: &Path) -> CargoGate {
    if !dir.join(".cargo-lock").exists() {
        return CargoGate::NoLock;
    }
    let parts: Vec<&str> = dir.components().filter_map(|c| c.as_os_str().to_str()).collect();
    let n = parts.len();
    let target_at = |i: usize| parts.get(i).is_some_and(|s| s.starts_with("target"));
    if (n >= 2 && target_at(n - 2)) || (n >= 3 && target_at(n - 3)) {
        CargoGate::Open
    } else {
        CargoGate::NotTargetDir
    }
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
    /// ★R3(크리틱 R2-L2) — `.cargo-lock`을 **심어도** 안 열린다. 그게 G6 실측이 연 문이다.
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
        // ★R3 — 공격자/사고가 `$INSTDIR`에 빈 `.cargo-lock`을 떨궈도 문은 안 열린다.
        // (R2는 여기서 열렸다 — 크리틱 G6가 미끼 node를 물게 만들었다.)
        put(&inst.join(".cargo-lock"));
        assert!(!is_cargo_output_dir(&inst), "조상 폴더 이름이 target…이 아니면 cargo 산출 폴더가 아니다");
        assert_eq!(node_exe_from(None, Some(inst.clone())), None, "★R3: .cargo-lock을 심어도 PATH 칸은 안 열린다");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// ★R3 — 개발 배치에서는 **여전히** 열린다(고친 게이트가 개발을 죽이지 않았다는 확인).
    /// 이 레포는 `target-lspdist`처럼 접미사 붙은 타깃 폴더를 쓰므로 그것도 포함해야 한다.
    #[test]
    fn the_cargo_gate_still_opens_for_real_dev_layouts() {
        let root = scratch("cargo-gate-dev");
        for rel in [
            ["target", "release"].as_slice(),
            ["target-lspdist", "release"].as_slice(),
            ["target", "x86_64-pc-windows-msvc", "release"].as_slice(),
        ] {
            let d = rel.iter().fold(root.clone(), |a, s| a.join(s));
            std::fs::create_dir_all(&d).unwrap();
            assert!(!is_cargo_output_dir(&d), "{}: .cargo-lock이 없으면 아직 아니다", d.display());
            put(&d.join(".cargo-lock"));
            assert!(is_cargo_output_dir(&d), "{}: 개발 배치인데 게이트가 안 열렸다", d.display());
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    /// ★R3 · 크리틱 R2-C1 — **죽을 때 하는 말이 사슬과 같은가.**
    ///
    /// R2의 문자열은 손으로 적은 것이라 사슬이 바뀌어도 안 바뀌었다(그래서 PATH를 끊은 뒤에도
    /// "PATH 순으로 찾는다"고 말했다). 이제 둘이 같은 목록을 읽으므로, 그 목록에 있는 자리가
    /// 진단에도 **반드시** 나와야 한다.
    #[test]
    fn the_runtime_hint_names_every_slot_it_actually_searched() {
        let h = node_search_hint();
        let d = exe_dir().unwrap();
        // ② 사이드카 두 자리와 ③ 첫 칸이 **경로 문자열 그대로** 들어 있어야 한다.
        for (_, p) in node_candidates(&d).into_iter().take(3) {
            assert!(h.contains(&*p.to_string_lossy()), "진단이 실제로 뒤진 자리를 안 싣는다: {}\n{h}", p.display());
        }
        assert!(h.contains("① CCG_LSP_NODE"), "{h}");
        assert!(h.contains("④ PATH"), "{h}");
        // 한국어와 영어가 같이 실린다(Rust 문자열은 렌더러의 t()를 못 탄다 — 함수 주석 참고).
        assert!(h.contains("다시 설치") && h.contains("reinstall"), "ko/en 두 벌이 아니다: {h}");
        // ★그리고 「node를 PATH에 깔면 낫는다」는 **오해를 막는 문장**이 있어야 한다.
        assert!(h.contains("낫지 않아요") && h.contains("will not help"), "헛수고 안내가 빠졌다: {h}");
    }

    /// ★마감 · 크리틱 R3-L1 — **게이트가 닫힌 이유를 가른다.**
    ///
    /// `bool` 하나였을 때는 「닫혔다 = 배포본이다」로 읽혀서, 말단이 `target`으로 시작하지
    /// 않는 `CARGO_TARGET_DIR`(예: `…/build/release`)로 짓는 개발자에게 **「앱을 다시 설치해
    /// 주세요」**라는 헛수고를 권했다. R2-C1이 고친 병(검증하지 않은 이유를 단정한다)의
    /// 축소판이다. 이제 이유가 값이라 문장이 갈린다.
    #[test]
    fn the_cargo_gate_reports_why_it_closed() {
        let root = scratch("gate-why");
        // ⓐ 배포본 — `.cargo-lock`이 없다
        let inst = root.join("AgentCodeGUI3");
        std::fs::create_dir_all(&inst).unwrap();
        assert_eq!(cargo_gate(&inst), CargoGate::NoLock);
        // ⓑ 개발인데 타깃 폴더 이름이 `target…`이 아니다(말단을 바꾼 CARGO_TARGET_DIR)
        let odd = root.join("build").join("release");
        std::fs::create_dir_all(&odd).unwrap();
        put(&odd.join(".cargo-lock"));
        assert_eq!(cargo_gate(&odd), CargoGate::NotTargetDir, "이 팔이 R3-L1이 연 자리다");
        // ⓒ 문서화된 개발 배치
        let ok = root.join("target-lspdist").join("release");
        std::fs::create_dir_all(&ok).unwrap();
        put(&ok.join(".cargo-lock"));
        assert_eq!(cargo_gate(&ok), CargoGate::Open);
        // 세 이유가 **서로 다른 문장**을 만든다 — 안 그러면 가른 값어치가 없다.
        assert!(is_cargo_output_dir(&ok) && !is_cargo_output_dir(&odd) && !is_cargo_output_dir(&inst));
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
