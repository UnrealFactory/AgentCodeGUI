//! Git 채널 — 탐색기 하단 상태 스트립 + Git 카드(변경/히스토리/브랜치).
//!
//! 로직은 `ccg-fs::git`(2.6.2 `src/main/git.ts`의 이식). 여기는 페이로드 배열 →
//! 크레이트 인자 변환뿐이다. 실패는 전부 **조용한 폴백**으로 내려간다
//! (`repo:false` / `[]` / `{ok:false,error}`) — 카드가 그 값을 그대로 보여준다.
//!
//! 미구현으로 남긴 것 하나: `git:ai-message`. diff를 읽어 엔진 CLI를 1턴 돌리는
//! 동작이라 실행 계통(R3 소유)에 붙어야 한다. 지금은 `__unimplemented`로 떨어져
//! 심이 `{ok:false}`로 갈음하고, 카드는 사용자가 직접 쓴 메시지로 그대로 커밋된다.

use super::{arg, ch};
use serde_json::{json, Value};

/// 이 모듈이 처리하는 채널인가 — `ipc_call`이 블로킹 스레드로 뺄지 결정할 때 쓴다.
/// **git은 자식 프로세스다**: `push`/`pull`은 네트워크 왕복이라 초 단위로 막힌다.
/// tokio 워커에서 그대로 돌리면 그 시간 동안 다른 IPC가 굶는다.
pub fn owns(channel: &str) -> bool {
    matches!(
        channel,
        ch::GIT_REPOS
            | ch::GIT_STATUS
            | ch::GIT_LOG
            | ch::GIT_FILE_DIFF
            | ch::GIT_COMMIT_DETAIL
            | ch::GIT_COMMIT_FILE_DIFF
            | ch::GIT_COMMIT
            | ch::GIT_PUSH
            | ch::GIT_PULL
            | ch::GIT_FETCH
            | ch::GIT_DISCARD
            | ch::GIT_BRANCHES
            | ch::GIT_SWITCH_BRANCH
            | ch::GIT_CREATE_BRANCH
    )
}

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

fn to_value<T: serde::Serialize>(v: T, on_err: Value) -> Value {
    serde_json::to_value(v).unwrap_or(on_err)
}

/// 2.6.2 `gitLog(cwd, limit = 200, skip = 0)`의 기본값.
const LOG_LIMIT: usize = 200;

pub fn dispatch(channel: &str, p: &Value) -> Option<Value> {
    Some(match channel {
        ch::GIT_REPOS => to_value(ccg_fs::git::repos(arg(p, 0).as_str().unwrap_or("")), json!([])),
        ch::GIT_STATUS => to_value(ccg_fs::git::status(arg(p, 0).as_str().unwrap_or("")), not_repo()),
        ch::GIT_LOG => {
            let a = arg(p, 0);
            let limit = a.get("limit").and_then(Value::as_u64).unwrap_or(LOG_LIMIT as u64) as usize;
            let skip = a.get("skip").and_then(Value::as_u64).unwrap_or(0) as usize;
            to_value(
                ccg_fs::git::log(s(a, "cwd"), limit, skip),
                json!({ "commits": [], "hasMore": false }),
            )
        }
        ch::GIT_FILE_DIFF => {
            let a = arg(p, 0);
            to_value(ccg_fs::git::file_diff(s(a, "cwd"), s(a, "rel")), no_diff())
        }
        ch::GIT_COMMIT_DETAIL => {
            let a = arg(p, 0);
            match ccg_fs::git::commit_detail(s(a, "cwd"), s(a, "hash")) {
                Some(d) => to_value(d, Value::Null),
                None => Value::Null,
            }
        }
        ch::GIT_COMMIT_FILE_DIFF => {
            let a = arg(p, 0);
            to_value(ccg_fs::git::commit_file_diff(s(a, "cwd"), s(a, "hash"), s(a, "rel")), no_diff())
        }
        ch::GIT_COMMIT => {
            let a = arg(p, 0);
            let files: Vec<String> = a
                .get("files")
                .and_then(Value::as_array)
                .map(|x| x.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_default();
            to_value(
                ccg_fs::git::commit(s(a, "cwd"), &files, s(a, "subject"), s(a, "body")),
                failed(),
            )
        }
        ch::GIT_PUSH => to_value(ccg_fs::git::push(arg(p, 0).as_str().unwrap_or("")), failed()),
        ch::GIT_PULL => to_value(ccg_fs::git::pull(arg(p, 0).as_str().unwrap_or("")), failed()),
        ch::GIT_FETCH => to_value(ccg_fs::git::fetch(arg(p, 0).as_str().unwrap_or("")), failed()),
        ch::GIT_DISCARD => {
            let a = arg(p, 0);
            let untracked = a.get("untracked").and_then(Value::as_bool).unwrap_or(false);
            to_value(ccg_fs::git::discard(s(a, "cwd"), s(a, "rel"), untracked), failed())
        }
        ch::GIT_BRANCHES => to_value(ccg_fs::git::branches(arg(p, 0).as_str().unwrap_or("")), json!([])),
        ch::GIT_SWITCH_BRANCH => {
            let a = arg(p, 0);
            to_value(ccg_fs::git::switch_branch(s(a, "cwd"), s(a, "name")), failed())
        }
        ch::GIT_CREATE_BRANCH => {
            let a = arg(p, 0);
            to_value(ccg_fs::git::create_branch(s(a, "cwd"), s(a, "name")), failed())
        }
        _ => return None,
    })
}

fn not_repo() -> Value {
    json!({
        "repo": false, "root": "", "branch": "", "detached": false,
        "ahead": 0, "behind": 0, "upstream": null, "hasRemote": false, "files": []
    })
}
fn no_diff() -> Value {
    json!({ "diff": null, "error": "unavailable" })
}
fn failed() -> Value {
    json!({ "ok": false, "error": "unavailable" })
}
