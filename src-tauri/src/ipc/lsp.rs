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
use tauri::{AppHandle, Emitter};

// ── 앱을 거친 파일 변화 → 언어 서버 통지 + 열린 뷰어 깨우기 ──────────────────
/// 셸의 핸들 — 브로드캐스트(`lsp:files-changed`·`lsp:install-progress`)에 필요하다.
/// `ipc_call`이 첫 파일/Git/LSP 호출에서 채운다(창을 만들기 전에는 브로드캐스트할 곳도 없다).
static APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

/// 이 채널이 **파일을 바꾸는가** — 바꾼다면 바뀐 절대 경로들(아니면 빈 목록).
/// 호출은 블로킹 작업 **앞**에서 하고(인자를 읽는 것뿐이라 마이크로초), 통지는 뒤에서 한다.
pub fn changed_paths(channel: &str, p: &Value) -> Vec<String> {
    let a = arg(p, 0);
    let abs = |rel: &str| -> Option<String> {
        let (cwd, rel) = (s(a, "cwd"), rel);
        if cwd.is_empty() || rel.is_empty() {
            return None;
        }
        Some(std::path::Path::new(cwd).join(rel).to_string_lossy().to_string())
    };
    match channel {
        ch::FS_WRITE_FILE | ch::FS_DELETE | ch::FS_CREATE => abs(s(a, "relPath")).into_iter().collect(),
        // 이름 바꾸기는 **둘 다** 통지한다 — 옛 경로는 삭제(didClose), 새 경로는 생성이다
        ch::FS_RENAME => {
            let old = s(a, "relPath");
            let name = s(a, "newName");
            let new_rel = std::path::Path::new(old)
                .parent()
                .map(|d| d.join(name).to_string_lossy().to_string())
                .unwrap_or_else(|| name.to_string());
            [abs(old), abs(&new_rel)].into_iter().flatten().collect()
        }
        ch::FS_MOVE => [abs(s(a, "srcRel")), abs(s(a, "destRel"))].into_iter().flatten().collect(),
        _ => Vec::new(),
    }
}

/// 블로킹 작업이 끝난 뒤 — 바뀐 파일을 **서버들에 흘리고** 모든 창의 뷰어를 깨운다.
///
/// §R3-9 ①이 남긴 자리다. 크레이트 쪽(`files_changed`)은 R2부터 실체가 있었고 R3에서
/// 멤버십 재통지까지 붙었는데 **부르는 곳이 없었다** — 그래서 서버는 회복돼도 이미 칠해진
/// 토큰이 그 문서를 다시 열 때까지 낡은 채로 남았다. 2.6.2는 `notifyWatchedFiles` →
/// `onFilesChanged` → 전 창 `webContents.send`였고(index.ts:1761), 여기가 그 거울이다.
///
/// **전용 스레드에서 돈다**: 안에서 하는 일이 서버 왕복(디스크 재동기화·`didClose`·재프라임
/// 예약)이라 async 워커에서 돌면 그동안 다른 창의 IPC가 굶는다.
pub fn after_fs_change(app: &AppHandle, paths: Vec<String>, result: &Value) {
    let _ = APP.set(app.clone());
    // 실패한 쓰기(권한 거부·이름 충돌)는 통지하지 않는다 — 디스크가 안 바뀌었는데 서버에
    // 재동기화를 시키면 헛일이고, 열린 뷰어도 괜히 깨운다(2.6.2도 성공 뒤에만 흘린다).
    if paths.is_empty() || result.get("ok").and_then(Value::as_bool) == Some(false) {
        return;
    }
    let app = app.clone();
    std::thread::Builder::new()
        .name("ccg-lsp-changed".into())
        .spawn(move || {
            // 서버가 하나도 없으면 `None` — 갱신할 토큰도 없으니 창을 깨우지 않는다(2.6.2 규약)
            if let Some(v) = ccg_lsp::files_changed(&paths) {
                let _ = app.emit(ch::LSP_FILES_CHANGED, v);
            }
        })
        .ok();
}

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

// ── 설치 채널 이름 ───────────────────────────────────────────────────────────
// `ch::` 상수로 안 올리고 여기 리터럴로 둔다: `ipc/mod.rs`는 이번 라운드에 세 빌더가
// 함께 만지는 공유 파일이고, 이 세 이름은 LSP 도메인 밖으로 안 나간다.
// 원본은 `src/shared/protocol.ts`의 `IPC.lspInstall*`이다(이 파일은 그 거울).
const LSP_INSTALL: &str = "lsp:install";
const LSP_INSTALL_SERVER: &str = "lsp:install-server";
const LSP_UNINSTALL_SERVER: &str = "lsp:uninstall-server";
const LSP_INSTALL_PROGRESS: &str = "lsp:install-progress";
// ★R28f SHIPBLOCK R2 — Verse **지정** 셋도 같은 이유로 여기 리터럴이다(공유
// `ipc/mod.rs`를 이번 라운드에 안 건드린다). 원본은 `src/shared/protocol.ts`의
// `IPC.lspPickVerseServer`·`lspSetVersePath`·`lspClearVersePath`.
const LSP_PICK_VERSE_SERVER: &str = "lsp:pick-verse-server";
const LSP_SET_VERSE_PATH: &str = "lsp:set-verse-path";
const LSP_CLEAR_VERSE_PATH: &str = "lsp:clear-verse-path";

/// Verse 서버 **지정**(고르기·경로 설정)이 3.0에 없다는 것을 사람이 읽는 문장으로.
/// 조회 셋(`verse-registry`·`digests`·`excludes`)은 「없는 게 정상」이라 그냥 빈 값이지만
/// (아래 dispatch), **사용자가 누른 버튼**은 아무 말 없이 끝나면 안 된다 —
/// ★R28f SHIPBLOCK R2 · 확인 크리틱 「요구 3의 뒷절반」.
const VERSE_OUT_OF_SCOPE: &str = "Verse 서버 지정은 3.0에서 아직 제공하지 않아요";

/// 내려받는 동안 진행률을 흘린다(계약면 `LspInstallProgress`) — §R3-9 ②.
///
/// R3은 "크레이트가 창(AppHandle)을 몰라서 못 쏜다"였다. 이제 [`APP`]에 핸들이 있으므로
/// 크레이트의 콜백을 그대로 이벤트로 옮긴다. 크레이트는 여전히 창을 모른다 —
/// 아는 것은 `(퍼센트, 한 줄)`뿐이고, 그걸 채널에 태우는 것은 셸의 몫이다.
fn install_streaming(id: &str) -> Value {
    let label = ccg_lsp::server_label(id);
    let send = |percent: Option<f64>, line: &str, done: bool, ok: bool, error: Option<&str>| {
        let Some(app) = APP.get() else { return };
        let mut p = json!({ "server": id, "label": label, "percent": percent, "line": line });
        if done {
            p["done"] = json!(true);
            p["ok"] = json!(ok);
            if let Some(e) = error {
                p["error"] = json!(e);
            }
        }
        let _ = app.emit(LSP_INSTALL_PROGRESS, p);
    };
    let r = ccg_lsp::install_server_with(id, &|percent, line| send(percent, line, false, false, None));
    let ok = r.get("ok").and_then(Value::as_bool).unwrap_or(false);
    let err = r.get("error").and_then(Value::as_str);
    send(if ok { Some(100.0) } else { None }, if ok { "준비 완료" } else { "실패" }, true, ok, err);
    r
}

pub fn owns(channel: &str) -> bool {
    // 내려받기는 수백 MB짜리 네트워크 왕복이다 — **반드시** 블로킹 풀로 빠져야 한다
    // (async 워커에서 돌면 그동안 다른 창의 IPC가 통째로 굶는다).
    if matches!(channel, LSP_INSTALL | LSP_INSTALL_SERVER | LSP_UNINSTALL_SERVER) {
        return true;
    }
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
            // ★R28f SHIPBLOCK R2 — 「범위 밖」도 **여기서** 답한다(아래 VERSE_OUT_OF_SCOPE).
            | LSP_PICK_VERSE_SERVER
            | LSP_SET_VERSE_PATH
            | LSP_CLEAR_VERSE_PATH
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

        // ── 내려받는 서버(C#·C++) 설치·삭제 ─────────────────────────────────
        // 심의 계약면은 `{ ok, error? }`다(`app/src/api/shim.ts`의 `failed()` 기본값)이고,
        // 그 위로 `lsp:install-progress`가 흐른다(R4에 붙었다 — §R3-9 ②).
        LSP_INSTALL_SERVER => install_streaming(a.as_str().unwrap_or_default()),
        LSP_UNINSTALL_SERVER => ccg_lsp::uninstall_server(a.as_str().unwrap_or_default()),
        // 뷰어의 "설치할까요?" — 파일 경로로 어느 서버인지 정한다
        LSP_INSTALL => match ccg_lsp::server_id_for_file(s(a, "cwd"), s(a, "relPath")) {
            Some(id) => install_streaming(&id),
            None => json!({ "ok": false, "error": "이 파일 형식을 맡는 서버가 없어요" }),
        },

        // Verse는 3.0 범위에서 제외(사용자 결정) — 렌더러가 부르긴 하므로 **안전값**을
        // 명시적으로 돌려준다(미구현 경고를 띄우지 않는다: 없는 게 정상이다).
        ch::LSP_VERSE_REGISTRY => Value::Null,
        ch::LSP_VERSE_DIGESTS | ch::LSP_VERSE_EXCLUDES => json!([]),

        // ★R28f SHIPBLOCK R2 — Verse 서버 지정 셋을 **여기서 받는다**(R1까지는 일부러
        // 안 받아 디스패처가 `{__unimplemented:true}`로 떨어뜨렸다).
        //
        // 왜 바꿨나: 그 안전값이 화면에서 **침묵으로 번역**됐다. `pick`의 안전값 `null`은
        // 「사용자가 파일 대화상자를 취소했다」와 구분이 안 되므로 호출부가 그냥 `return`
        // 한다 — 「Verse 서버 고르기」를 눌러도 아무 일도 안 일어나고 아무 말도 없다.
        // 그게 이 라운드가 닫은 N1과 **글자 그대로 같은 모양**이고, 확인 크리틱이
        // 「요구 3의 뒷절반」으로 남긴 자리다. 채널당 1회 `console.warn`은 사용자가 아니다.
        //
        // Verse가 3.0 범위 밖이라는 결정은 그대로다(사용자 결정) — 바뀌는 것은 **그 사실을
        // 화면이 말하는가**뿐이다. 그래서 구현이 아니라 **사유**를 돌려준다.
        LSP_PICK_VERSE_SERVER => json!({ "error": VERSE_OUT_OF_SCOPE }),
        LSP_SET_VERSE_PATH => json!({ "ok": false, "error": VERSE_OUT_OF_SCOPE }),
        // 「지우기」는 지울 것이 없으면 **이미 목표 상태**다 — 실패가 아니다(위 둘과 달리
        // 사용자가 원한 결과가 그대로 성립한다). 여기서 거짓 실패를 세우면 화면이 안 지워진
        // 경로를 지웠다고 말하는 것보다 더 헷갈린다.
        LSP_CLEAR_VERSE_PATH => json!({ "ok": true }),

        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ★R28f SHIPBLOCK R2 — 「사용자가 누른 버튼」은 미구현이어도 **사유를 돌려준다**.
    ///
    /// 조회 셋은 빈 값이 정상이고(없는 게 정상), 지정 셋은 아니다: 심의 안전값이 `pick`의
    /// `null`을 「사용자가 대화상자를 취소했다」로 번역해 버튼이 무반응이 됐다
    /// (확인 크리틱 「요구 3의 뒷절반」). 이 테스트가 지키는 것은 **두 무리의 경계**다.
    #[test]
    fn the_verse_buttons_answer_with_a_reason_while_the_lookups_stay_quiet() {
        for c in [LSP_PICK_VERSE_SERVER, LSP_SET_VERSE_PATH, LSP_CLEAR_VERSE_PATH] {
            assert!(owns(c), "{c} — 디스패처까지 흘러가면 다시 __unimplemented다");
        }
        let pick = dispatch_pure(LSP_PICK_VERSE_SERVER).expect("답이 있다");
        assert_eq!(pick["error"], json!(VERSE_OUT_OF_SCOPE));
        assert!(!pick.is_string() && !pick.is_null(), "★문자열/null이면 심이 「취소」로 읽는다");

        let set = dispatch_pure(LSP_SET_VERSE_PATH).expect("답이 있다");
        assert_eq!(set["ok"], json!(false));
        assert_eq!(set["error"], json!(VERSE_OUT_OF_SCOPE));

        // 지울 것이 없으면 이미 목표 상태다 — 거짓 실패를 세우지 않는다.
        assert_eq!(dispatch_pure(LSP_CLEAR_VERSE_PATH).expect("답이 있다")["ok"], json!(true));

        // 조회 셋은 그대로 조용하다(사유 문구가 목록 자리에 앉으면 안 된다).
        assert_eq!(dispatch_pure(ch::LSP_VERSE_REGISTRY), Some(Value::Null));
        assert_eq!(dispatch_pure(ch::LSP_VERSE_DIGESTS), Some(json!([])));
        assert_eq!(dispatch_pure(ch::LSP_VERSE_EXCLUDES), Some(json!([])));
    }

    /// 인자·언어 서버를 하나도 안 건드리는 채널만 이 문으로 부른다(위 테스트 전용).
    fn dispatch_pure(channel: &str) -> Option<Value> {
        dispatch(channel, &json!([]))
    }
}
