//! 파일 채널 — 탐색기 트리·"@" 멘션 목록·코드 뷰어 읽기/쓰기·탐색기 파일 작업.
//!
//! 로직은 전부 `ccg-fs`에 있다(2.6.2 `src/main/files.ts` + `index.ts` fs 핸들러의 이식).
//! 여기는 **페이로드 배열 → 크레이트 인자** 변환만 한다 — 심(`app/src/api/shim.ts`)이
//! `call(channel, [args…])`로 보내는 모양이 원본이고, 이 파일은 그 모양의 거울이다.
//!
//! 반환은 계약면(protocol.ts)의 JSON 그대로. 실패해도 **절대 throw/panic 하지 않고**
//! 시그니처에 맞는 값(빈 목록·`{ok:false,error}`·`{content:null,error}`)을 돌려준다 —
//! "어떤 화면도 크래시하지 않는다"가 M1부터의 계약이다.

use super::{arg, ch};
use ccg_fs::dir::ListOpts;
use serde_json::{json, Value};

/// 이 모듈이 처리하는 채널인가 — `ipc_call`이 **블로킹 스레드로 뺄지** 결정할 때 쓴다.
/// (디렉터리 걷기·1.5MB 파일 읽기는 tokio 워커를 붙잡으면 안 되는 동기 I/O다)
pub fn owns(channel: &str) -> bool {
    matches!(
        channel,
        ch::FS_LIST_DIR
            | ch::FS_LIST_FILES
            | ch::FS_READ_FILE
            | ch::FS_WRITE_FILE
            | ch::FS_RENAME
            | ch::FS_DELETE
            | ch::FS_CREATE
            | ch::FS_MOVE
            | ch::SHELL_OPEN_PATH
            | ch::SHELL_REVEAL_PATH
            | ch::FS_HTML_PREVIEW_URL
            | ch::ATTACHMENT_SAVE_DATA
    )
}

/// 인자 객체의 문자열 필드. 없으면 빈 문자열 — 2.6.2의 `a.cwd || ''`와 같은 관대함이다
/// (렌더러가 아직 폴더를 안 고른 상태로 부르는 경로가 실제로 있다).
fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

fn strings(v: &Value, key: &str) -> Vec<String> {
    v.get(key)
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default()
}

/// `serde` 구조체 → `Value`. 직렬화가 실패할 수 있는 모양이 아니지만(전부 평범한
/// 스칼라/배열), 실패해도 null 대신 시그니처에 맞는 안전값으로 떨어지게 감싼다.
fn to_value<T: serde::Serialize>(v: T, on_err: Value) -> Value {
    serde_json::to_value(v).unwrap_or(on_err)
}

pub fn dispatch(channel: &str, p: &Value) -> Option<Value> {
    Some(match channel {
        // 폴더 하나 — 탐색기가 폴더를 펼칠 때마다(지연 로드) 부른다
        ch::FS_LIST_DIR => {
            let a = arg(p, 0);
            let opts = ListOpts {
                exclude: strings(a, "exclude"),
                hide_empty: a.get("hideEmpty").and_then(Value::as_bool).unwrap_or(false),
                exclude_dirs: strings(a, "excludeDirs"),
                exclude_files: strings(a, "excludeFiles"),
            };
            to_value(ccg_fs::dir::list_dir(s(a, "cwd"), s(a, "rel"), &opts), json!([]))
        }
        // 프로젝트 전체 파일(상대 경로) — "@" 멘션 팔레트 + 탐색기 검색
        ch::FS_LIST_FILES => {
            let cwd = arg(p, 0).as_str().unwrap_or("");
            json!(ccg_fs::dir::list_project_files(cwd))
        }
        ch::FS_READ_FILE => {
            let a = arg(p, 0);
            let rel = s(a, "relPath");
            to_value(
                ccg_fs::file::read_file(s(a, "cwd"), rel),
                json!({ "path": rel, "content": null, "truncated": false, "error": "read failed" }),
            )
        }
        ch::FS_WRITE_FILE => {
            let a = arg(p, 0);
            let content = a.get("content").and_then(Value::as_str).unwrap_or("");
            to_value(ccg_fs::file::write_file(s(a, "cwd"), s(a, "relPath"), content), failed())
        }
        ch::FS_RENAME => {
            let a = arg(p, 0);
            to_value(ccg_fs::file::rename_path(s(a, "cwd"), s(a, "relPath"), s(a, "newName")), failed())
        }
        ch::FS_DELETE => {
            let a = arg(p, 0);
            to_value(ccg_fs::file::delete_path(s(a, "cwd"), s(a, "relPath")), failed())
        }
        ch::FS_CREATE => {
            let a = arg(p, 0);
            let dir = a.get("dir").and_then(Value::as_bool).unwrap_or(false);
            to_value(ccg_fs::file::create_path(s(a, "cwd"), s(a, "relPath"), dir), failed())
        }
        ch::FS_MOVE => {
            let a = arg(p, 0);
            to_value(ccg_fs::file::move_path(s(a, "cwd"), s(a, "srcRel"), s(a, "destRel")), failed())
        }
        // 뷰어 HTML 미리보기 — 서빙 루트 등록 + URL 발급(M6 R3).
        // 반환은 문자열 하나: 실패해도 `''`라 심의 안전값과 같은 모양이다.
        ch::FS_HTML_PREVIEW_URL => {
            let a = arg(p, 0);
            json!(ccg_fs::serve::register_html_preview(s(a, "cwd"), s(a, "relPath")))
        }
        // 붙여넣기·브라우저 드래그 첨부(경로 없는 바이트) → 임시 파일 경로.
        // 와이어는 base64 문자열(`b64`)이다 — 심이 `Array.from(new Uint8Array(…))`로
        // 보내던 **숫자 배열**은 3MB 스크린샷 하나가 JSON 20MB가 되는 자리라
        // (바이트당 `255,` 4글자) base64로 바꿨다. 옛 모양도 계속 받는다.
        ch::ATTACHMENT_SAVE_DATA => {
            let a = arg(p, 0);
            let bytes = match a.get("b64").and_then(Value::as_str) {
                Some(b) => ccg_fs::attach::decode_b64(b),
                None => a
                    .get("bytes")
                    .and_then(Value::as_array)
                    .map(|xs| xs.iter().filter_map(Value::as_u64).map(|n| n as u8).collect())
                    .unwrap_or_default(),
            };
            json!(ccg_fs::attach::save_attachment_data(&bytes, s(a, "ext")))
        }
        // 셸 연동 — 반환값 없는 no-op 계약(심의 callVoid)
        ch::SHELL_OPEN_PATH => {
            let a = arg(p, 0);
            ccg_fs::file::open_path(s(a, "cwd"), s(a, "relPath"));
            Value::Null
        }
        ch::SHELL_REVEAL_PATH => {
            let a = arg(p, 0);
            ccg_fs::file::reveal_path(s(a, "cwd"), s(a, "relPath"));
            Value::Null
        }
        _ => return None,
    })
}

fn failed() -> Value {
    json!({ "ok": false, "error": "unavailable" })
}
