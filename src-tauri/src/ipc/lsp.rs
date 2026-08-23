//! LSP 채널 — 코드 인텔리전스(뷰어 색칠·호버·정의 이동·자동완성).
//!
//! 로직은 전부 `ccg-lsp`에 있다. 여기는 **페이로드 배열 → 크레이트 인자** 변환만 한다 —
//! 심(`app/src/api/shim.ts`)이 `call(channel, [{cwd, relPath, pos, text}])`로 보내는 모양이
//! 원본이고 이 파일은 그 거울이다.
//!
//! [블로킹] 이 채널들은 **전부 자식 프로세스 왕복**이다(호버 한 번이 수 ms~수십 ms,
//! 콜드 토큰은 초 단위). tokio 워커에서 돌면 그 시간 동안 다른 창의 IPC가 굶으므로
//! `fs`·`git`과 같이 `owns()`로 표시해 `spawn_blocking`으로 뺀다(`ipc/mod.rs` 참고).
//!
//! [안전값] 실패는 계약면 시그니처에 맞는 값으로 떨어진다 — `unsupported`·`null`·`[]`.
//! 아직 구현하지 않은 채널(Verse·설치 UI)은 `unimplemented()`를 돌려 심이 채널당 1회만
//! 경고하게 둔다. **어떤 화면도 크래시하지 않는다**가 계약이다.

use super::{arg, ch};
use serde_json::{json, Value};

// ── 부팅 프리웜 ──────────────────────────────────────────────────────────────
/// 지연 스폰의 방아쇠를 **렌더러 번들보다 앞으로** 당긴다.
///
/// 크리틱 §3.2: `ready` 격차 200ms 중 **+41ms는 방아쇠가 늦게 당겨져서**다. 2.6.2는
/// `window.api`가 preload(문서 시작)에 있고, 3.0은 번들이 실행된 **뒤**에 생긴다
/// (`app/src/api/shim.ts`). `lsp:status`/`lsp:prewarm`이 곧 방아쇠라, 그만큼 서버 시작이
/// 늦었다 — 서버가 느린 게 아니었다.
///
/// 셸은 창을 만들기 전에 이미 "마지막으로 쓰던 프로젝트"를 안다(활성 채팅의 cwd).
/// 그 자리에서 한 번 부르면 41ms가 통째로 사라진다. 렌더러의 `App.tsx:834` prewarm은
/// 그대로 둔다 — **멱등**이고(같은 자리를 잠그므로 프로세스는 한 벌) cwd가 바뀔 수 있다.
pub fn boot_prewarm() {
    std::thread::Builder::new()
        .name("ccg-lsp-boot".into())
        .spawn(|| {
            let Some(cwd) = last_project_cwd() else { return };
            ccg_lsp::prewarm(&cwd);
        })
        .ok();
}

/// 활성 채팅의 작업 폴더 — 렌더러가 `prewarm`에 넘기는 값(`manualCwd`)과 같은 원천.
/// 스토어 조회 API를 안 쓰고 파일 두 개만 읽는다(부팅 경로라 캐시를 데울 이유가 없다).
///
/// 통합 스토어를 먼저 보고 **옛 `chats/`로 떨어진다** — 통합 이관은 렌더러의 첫 조회 때
/// 도는데, 이 함수는 그보다 앞서 돌기 때문이다(업그레이드 첫 부팅·벤치 픽스처 홈).
fn last_project_cwd() -> Option<String> {
    let home = ccg_store::app_home();
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    if ccg_store::unified_store_enabled() {
        dirs.push(home.join(ccg_store::chats_v3::DIR));
    }
    dirs.push(home.join("chats"));
    dirs.into_iter().find_map(|d| active_chat_cwd(&d))
}

fn active_chat_cwd(dir: &std::path::Path) -> Option<String> {
    let read = |p: std::path::PathBuf| -> Option<Value> {
        serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()
    };
    let index = read(dir.join("index.json"))?;
    let id = index.get("activeChatId").and_then(Value::as_str).filter(|s| !s.is_empty())?;
    // 경로 조각이 되므로 id 모양을 검사한다(스토어와 같은 기준)
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-') {
        return None;
    }
    let chat = read(dir.join(format!("{id}.json")))?;
    let cwd = chat
        .get("manualCwd")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            chat.get("snapshot")
                .and_then(|s| s.get("session"))
                .and_then(|s| s.get("cwd"))
                .and_then(Value::as_str)
        })
        .filter(|s| !s.is_empty())?;
    std::path::Path::new(cwd).is_dir().then(|| cwd.to_string())
}

pub fn owns(channel: &str) -> bool {
    matches!(
        channel,
        ch::LSP_STATUS
            | ch::LSP_HOVER
            | ch::LSP_DEFINITION
            | ch::LSP_SEMANTIC_TOKENS
            | ch::LSP_CACHED_TOKENS
            | ch::LSP_COMPLETION
            | ch::LSP_COMPLETION_RESOLVE
            | ch::LSP_PREWARM
            | ch::LSP_WARM
            | ch::LSP_PROJECT_STATUS
            | ch::LSP_SERVERS
            | ch::LSP_VERSE_REGISTRY
            | ch::LSP_VERSE_DIGESTS
            | ch::LSP_VERSE_EXCLUDES
    )
}

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

/// 저장 안 된 편집 버퍼(있을 때만). 빈 문자열은 "안 넘어왔다"와 구분해 **버퍼로** 취급한다 —
/// 사용자가 파일을 통째로 지운 상태의 편집도 진실이기 때문이다.
fn buf(v: &Value) -> Option<&str> {
    v.get("text").and_then(Value::as_str)
}

/// `LspPos` — 둘 다 0-based, character는 UTF-16 코드 유닛.
fn pos(v: &Value) -> (u32, u32) {
    let p = v.get("pos").unwrap_or(&Value::Null);
    (
        p.get("line").and_then(Value::as_u64).unwrap_or(0) as u32,
        p.get("character").and_then(Value::as_u64).unwrap_or(0) as u32,
    )
}

pub fn dispatch(channel: &str, p: &Value) -> Option<Value> {
    let a = arg(p, 0);
    Some(match channel {
        // 상태 + **지연 기동의 방아쇠**. 렌더러가 400ms로 폴링한다.
        ch::LSP_STATUS => json!(ccg_lsp::status(s(a, "cwd"), s(a, "relPath"))),

        ch::LSP_PROJECT_STATUS => ccg_lsp::project_status(s(a, "cwd")),

        // `text`는 **저장 안 된 편집 버퍼**다(계약면의 네 번째 인자). 편집 모드(Ctrl+E)의
        // `CmEditor.tsx:471·552·574`가 실제로 `view.state.doc.toString()`을 넘긴다.
        // R1은 여기서 그걸 버려서 저장 전 호버·정의가 디스크 좌표를 읽고 **자신 있는
        // 오답**을 냈다(크리틱 C-2: 7줄 밀린 버퍼에서 적중 1/6). 2.6.2 manager.ts:1994와
        // 같은 분기를 크레이트가 하도록 `text`를 그대로 넘긴다.
        ch::LSP_HOVER => {
            let (l, c) = pos(a);
            ccg_lsp::hover_at(s(a, "cwd"), s(a, "relPath"), l, c, buf(a)).unwrap_or(Value::Null)
        }

        ch::LSP_DEFINITION => {
            let (l, c) = pos(a);
            json!(ccg_lsp::definition_at(s(a, "cwd"), s(a, "relPath"), l, c, buf(a)))
        }

        ch::LSP_SEMANTIC_TOKENS => {
            ccg_lsp::semantic_tokens(s(a, "cwd"), s(a, "relPath")).unwrap_or(Value::Null)
        }

        // 서버를 **띄우지 않고** 디스크 캐시만 본다 — 파일을 여는 순간의 즉시 색칠
        ch::LSP_CACHED_TOKENS => {
            ccg_lsp::cached_tokens(s(a, "cwd"), s(a, "relPath")).unwrap_or(Value::Null)
        }

        ch::LSP_COMPLETION => {
            let (l, c) = pos(a);
            let text = s(a, "text").to_string();
            ccg_lsp::completion(s(a, "cwd"), s(a, "relPath"), l, c, text).unwrap_or(Value::Null)
        }

        ch::LSP_COMPLETION_RESOLVE => {
            let gen = a.get("gen").and_then(Value::as_i64).unwrap_or(-1);
            let ri = a.get("ri").and_then(Value::as_u64).unwrap_or(0) as usize;
            ccg_lsp::resolve_completion(s(a, "cwd"), s(a, "relPath"), gen, ri).unwrap_or(Value::Null)
        }

        ch::LSP_PREWARM => {
            ccg_lsp::prewarm(s(a, "cwd"));
            Value::Null
        }

        ch::LSP_WARM => {
            ccg_lsp::warm(s(a, "cwd"), s(a, "relPath"));
            Value::Null
        }

        ch::LSP_SERVERS => json!(ccg_lsp::servers()),

        // Verse는 3.0 범위에서 제외(사용자 결정) — 렌더러가 부르긴 하므로 **안전값**을
        // 명시적으로 돌려준다(미구현 경고를 띄우지 않는다: 없는 게 정상이다).
        ch::LSP_VERSE_REGISTRY => Value::Null,
        ch::LSP_VERSE_DIGESTS | ch::LSP_VERSE_EXCLUDES => json!([]),

        // 설치 UI(`lsp:install`·`lsp:install-server`·`lsp:uninstall-server`)와 Verse 서버
        // 지정 채널은 **일부러 여기서 안 받는다** — 디스패처가 `{__unimplemented:true}`로
        // 떨어뜨리면 심이 채널당 1회 경고를 남긴다. "아직 없다"가 조용히 사라지지 않게.
        _ => return None,
    })
}
