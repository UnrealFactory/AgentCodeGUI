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

        ch::LSP_HOVER => {
            let (l, c) = pos(a);
            ccg_lsp::hover(s(a, "cwd"), s(a, "relPath"), l, c).unwrap_or(Value::Null)
        }

        ch::LSP_DEFINITION => {
            let (l, c) = pos(a);
            json!(ccg_lsp::definition(s(a, "cwd"), s(a, "relPath"), l, c))
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
