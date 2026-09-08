//! `/btw` 포크 질문 창 — `btw:open` (최종 파리티 감사 R1 §3.1 **T4**).
//!
//! ## 무엇이 비어 있었나
//!
//! Rust 핸들러가 **0개**였다(`engine/mod.rs:27`의 주석에만 이름이 있었다). 심이
//! `callVoid`를 안전값으로 삼키므로 `/btw`를 쳐도 **아무 일도 안 일어난다** — 컴포저는
//! 텍스트만 지우고 조용하다. 전 화면 A/B에서 `btw-dock`·`multi-panel-btw-dock`·
//! `session-window-btw` 세 화면이 도달 실패한 원인이 이 한 채널이다.
//!
//! ## 이 기능의 계약(2.6.2 `index.ts:1238`) — 넷 다 지킨다
//!
//! | 규약 | 여기서 |
//! |---|---|
//! | **forkSession 포크** | 레코드에 `btwSeed{fork,cwd}`를 심는다 → 창의 hydrate가 받아 첫 실행을 `resume+forkSession`으로 보낸다(`btw.ts btwRunResume`) |
//! | **own 생기면 재포크 금지** | 렌더러 몫이다(`btwRunResume`이 `own`을 먼저 본다). 시드는 **지우지 않는다** — 자기 세션이 생기면 어차피 무시되고, 폴더가 바뀌면 창 쪽 가드가 접는다 |
//! | **btwPrompt는 읽으면 소비** | 여기가 심고, `legacy_bridge::session_chat_hydrate`가 읽으면서 레코드에서 걷어낸다(이미 있던 규약) |
//! | **브로드캐스트는 전 창** | `win::broadcast_sessions`가 `session-wins:changed`(메인) + `chat:windows`(전 창)를 쏜다 — 팝아웃 창도 자기 panelId의 알약을 그린다 |
//!
//! `wrapBtwFork`(포크 첫 실행에만 붙는 곁다리 리마인더)는 **렌더러 몫**이다. 셸이 또
//! 붙이면 리마인더가 두 벌이 되고, 그러면 "포크 실행 1회만"이라는 규약이 깨진다.
//!
//! ## 왜 레코드를 **창보다 먼저** 심는가
//!
//! 2.6.2는 `sessionChats` Map(메모리)에 넣고 창을 열었다 — hydrate가 그 Map을 읽으므로
//! 순서가 보장됐다. 3.0에는 그 Map이 없다: **진실은 파일**(`chats-v3/<id>.json`)이고
//! hydrate도 파일을 읽는다. 그래서 파일을 먼저 쓴다. 순서를 뒤집으면 창이 먼저 뜬 뒤
//! hydrate가 시드 없는 레코드를 읽고, 첫 실행이 포크가 아니라 **새 대화**로 나간다 —
//! 원본 컨텍스트를 통째로 잃는다(이 기능이 없는 것과 같다).
//!
//! ## 2.6.2와 의도적으로 다른 한 가지: 디스크에 남는다
//!
//! 2.6.2 `writeSessionChats`는 `snapshot == null`인 레코드를 **디스크에 안 쓴다** —
//! 열었다 아무것도 안 묻고 닫은 btw 창은 앱을 끄면 사라졌다. 3.0은 메모리 레지스트리가
//! 없어 "안 쓰면 곧 없는 것"이므로 바로 쓴다. 결과 차이는 *한 방향뿐*이다: 질문 없이
//! 닫은 btw 창의 알약이 재시작 후에도 남는다. 반대 방향(대화가 있는데 사라진다)이
//! 아니므로 이쪽을 고른다 — 2.6.2 자신도 "창 X = 무조건 알약"을 규약으로 적어 뒀다
//! (`sessionChats.ts:96`, 삭제는 알약 ✕뿐).

use serde_json::{json, Map, Value};
use tauri::{AppHandle, WebviewWindow};

/// 참조 폴더 상한 — 2.6.2 `index.ts:1253` `.slice(0, 8)`과 같다.
const MAX_REF_DIRS: usize = 8;

/// `'BTW - <원본 제목>'`. 원본이 이미 btw 채팅이어도(포크의 포크) **접두는 한 번만**
/// 남긴다 — 2.6.2 `originTitle.replace(/^BTW\s*-\s*/i, '')`의 자리다. 접두가 겹쳐 쌓이면
/// 사이드바가 `BTW - BTW - BTW - …`가 된다.
fn btw_title(origin_title: &str) -> String {
    let t = origin_title.trim();
    if t.is_empty() {
        return String::new();
    }
    // `^BTW\s*-\s*` — 대소문자 무관. 정규식 크레이트를 들이지 않고 그대로 옮긴다.
    let rest = if t.len() >= 3 && t[..3].eq_ignore_ascii_case("BTW") {
        let after = t[3..].trim_start();
        match after.strip_prefix('-') {
            Some(r) => r.trim_start(),
            None => t,
        }
    } else {
        t
    };
    format!("BTW - {rest}")
}

fn str_field<'a>(p: &'a Value, k: &str) -> Option<&'a str> {
    p.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

/// `btw:open(req)` — 계약면은 `void`다(2.6.2도 반환값이 없다). 진행 보고는 목록
/// 브로드캐스트로 간다.
pub fn open(app: &AppHandle, window: &WebviewWindow, req: &Value) -> Value {
    if !req.is_object() {
        return Value::Null;
    }
    // 원본 채팅 id. 추가 채팅 창에서 부른 `/btw`는 자기 채팅 id를 모르므로 `''`를 보낸다
    // (`SessionWindow.tsx:538`) — 2.6.2가 `_e.sender`로 보완하던 자리를 **창 라벨**로
    // 보완한다. 그래도 없으면 `'unknown'`: 알약은 원본이 있어야 그려지므로 그 창은
    // 사이드바 '추가 채팅'으로만 되찾는다(2.6.2와 같은 착지).
    let origin = str_field(req, "origin")
        .map(str::to_string)
        .or_else(|| crate::engine::session_chat_for_window(window))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".into());

    let title = btw_title(req.get("originTitle").and_then(Value::as_str).unwrap_or(""));
    let cwd = req.get("cwd").and_then(Value::as_str).unwrap_or("").to_string();
    let ref_dirs: Vec<Value> = req
        .get("refDirs")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter(|v| v.as_str().is_some_and(|s| !s.is_empty()))
                .take(MAX_REF_DIRS)
                .cloned()
                .collect()
        })
        .unwrap_or_default();

    let id = crate::win::new_session_chat_id();

    // 저장 경로는 창이 제 대화를 저장할 때와 **같은 함수**를 탄다(`session_chat_persist`).
    // 여기서 레코드를 직접 조립해 `upsert_chat`하지 않는 이유: 그러면 `picker`·`cwd`를
    // 정체성(`identity`)으로 접는 번역이 이 파일에 한 벌 더 생기고, 그 두 벌은 반드시
    // 어긋난다. 페이로드 모양만 2.6.2 `SessionPersistPayload`에 맞춰 준다.
    let mut payload = Map::new();
    payload.insert("title".into(), json!(title));
    // 원본 제목을 받아 지은 이름은 `custom`으로 굳힌다 — 안 그러면 창의 **자동 제목
    // 보고**(첫 질문 요약)가 곧바로 덮어써 'BTW - …'가 한 턴 만에 사라진다.
    payload.insert("custom".into(), json!(!title.is_empty()));
    payload.insert("status".into(), json!("idle"));
    payload.insert("cwd".into(), json!(cwd));
    payload.insert("refDirs".into(), Value::Array(ref_dirs));
    payload.insert("picker".into(), req.get("picker").cloned().unwrap_or(Value::Null));
    payload.insert("snapshot".into(), Value::Null);
    payload.insert("btwOf".into(), json!(origin));
    if let Some(fork) = str_field(req, "fork") {
        // 시드의 `cwd`는 **그 세션이 만들어진 폴더**다(창에서 폴더를 바꾸면 포크를 접는
        // 가드의 기준). 안 실려 오면 요청의 cwd로 갈음한다 — 2.6.2와 같은 폴백.
        let seed_cwd = str_field(req, "forkCwd").unwrap_or(cwd.as_str());
        let engine = if req["picker"]["engine"] == "codex" { "codex" } else { "claude" };
        payload.insert("btwSeed".into(), json!({ "fork": fork, "cwd": seed_cwd, "engine": engine }));
    }
    if let Some(prompt) = str_field(req, "prompt") {
        payload.insert("btwPrompt".into(), json!(prompt));
    }

    if !ccg_store::legacy_bridge::session_chat_persist(&id, &Value::Object(payload)) {
        eprintln!("[btw] 레코드 저장 실패 — 창을 열지 않는다(시드 없는 창은 새 대화가 된다)");
        return Value::Null;
    }
    if let Err(e) = crate::win::open_session_window_for(app, Some(&id)) {
        eprintln!("[btw] 질문 창 생성 실패: {e}");
    }
    Value::Null
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 접두 규칙 — 붙이되 **겹쳐 쌓지 않는다**(포크의 포크).
    #[test]
    fn the_btw_prefix_is_added_once_and_never_stacks() {
        assert_eq!(btw_title("리팩터 라운드"), "BTW - 리팩터 라운드");
        assert_eq!(btw_title("BTW - 리팩터 라운드"), "BTW - 리팩터 라운드");
        assert_eq!(btw_title("btw-리팩터"), "BTW - 리팩터");
        assert_eq!(btw_title("BTW   -   여백"), "BTW - 여백");
        // 제목이 없으면 빈 문자열 = `custom:false` → 창의 자동 제목이 이긴다.
        assert_eq!(btw_title("   "), "");
        // 'btw'로 **시작만** 하는 단어는 접두가 아니다 — 원문을 지킨다.
        assert_eq!(btw_title("btwxyz 실험"), "BTW - btwxyz 실험");
    }

    /// 레코드가 심기고, 시드 넷이 그대로 hydrate로 나온다(읽으면 소비 포함).
    #[test]
    fn the_seed_survives_into_hydrate_and_the_prompt_is_consumed_once() {
        let _h = ccg_store::testhome::take("parity-btw-seed");
        let id = "sc-btwtest-1";
        let mut payload = Map::new();
        payload.insert("title".into(), json!("BTW - 원본"));
        payload.insert("custom".into(), json!(true));
        payload.insert("status".into(), json!("idle"));
        payload.insert("cwd".into(), json!("C:\\Code\\App"));
        payload.insert("refDirs".into(), json!([]));
        payload.insert("picker".into(), Value::Null);
        payload.insert("snapshot".into(), Value::Null);
        payload.insert("btwOf".into(), json!("chat-1"));
        payload.insert("btwSeed".into(), json!({ "fork": "ses-9", "cwd": "C:\\Code\\App" }));
        payload.insert("btwPrompt".into(), json!("이 함수 왜 이래?"));
        assert!(ccg_store::legacy_bridge::session_chat_persist(id, &Value::Object(payload)));

        let h = ccg_store::legacy_bridge::session_chat_hydrate(id);
        assert_eq!(h["btw"], json!(true), "btw 창 정체가 안 내려갔다 — 웰컴 화면이 일반 추가 채팅이 된다");
        assert_eq!(h["btwFork"], "ses-9", "포크 소스가 없다 = 첫 실행이 새 대화로 나간다");
        assert_eq!(h["btwForkCwd"], "C:\\Code\\App");
        assert_eq!(h["btwForkEngine"], "claude", "기존 엔진 표식 없는 시드는 Claude입니다");
        assert_eq!(h["btwPrompt"], "이 함수 왜 이래?");

        // ★읽으면 소비 — 두 번째 hydrate에는 질문이 없다(있으면 /clear 후 재열람 때
        //   옛 질문이 저절로 다시 전송된다).
        let again = ccg_store::legacy_bridge::session_chat_hydrate(id);
        assert!(again.get("btwPrompt").is_none(), "인라인 질문이 소비되지 않았다 = 자동 재전송");
        assert_eq!(again["btwFork"], "ses-9", "시드는 소비 대상이 아니다(창이 폴더 가드로 접는다)");
    }

    /// 목록에 `btwOf`가 실리고, 창이 없는 줄의 `shown`은 거짓이다(= 알약이 뜬다).
    #[test]
    fn a_closed_btw_chat_reports_its_origin_and_is_not_shown() {
        let _h = ccg_store::testhome::take("parity-btw-list");
        let id = "sc-btwtest-2";
        let mut payload = Map::new();
        payload.insert("title".into(), json!("BTW - 원본"));
        payload.insert("custom".into(), json!(true));
        payload.insert("status".into(), json!("idle"));
        payload.insert("cwd".into(), json!(""));
        payload.insert("snapshot".into(), Value::Null);
        payload.insert("btwOf".into(), json!("chat-7"));
        assert!(ccg_store::legacy_bridge::session_chat_persist(id, &Value::Object(payload)));

        let infos = ccg_store::legacy_bridge::session_chat_infos();
        let row = infos
            .iter()
            .find(|i| i.get("id").and_then(Value::as_str) == Some(id))
            .expect("영속된 btw 채팅이 목록에서 사라졌다");
        assert_eq!(row["btwOf"], "chat-7", "원본 간선이 없으면 알약이 어느 화면에도 안 붙는다");
        assert_eq!(row["shown"], json!(false), "창이 없는데 shown=true면 알약이 영원히 숨는다");
        assert_eq!(row["open"], json!(false));
    }

    /// 일반 추가 채팅에는 `btwOf` 키가 **아예 없다**(null이 아니라 부재).
    #[test]
    fn a_plain_extra_chat_carries_no_btw_edge() {
        let _h = ccg_store::testhome::take("parity-btw-plain");
        let id = "sc-plain-1";
        let mut payload = Map::new();
        payload.insert("title".into(), json!("보통 창"));
        payload.insert("status".into(), json!("idle"));
        payload.insert("cwd".into(), json!(""));
        payload.insert("snapshot".into(), Value::Null);
        assert!(ccg_store::legacy_bridge::session_chat_persist(id, &Value::Object(payload)));
        let infos = ccg_store::legacy_bridge::session_chat_infos();
        let row = infos
            .iter()
            .find(|i| i.get("id").and_then(Value::as_str) == Some(id))
            .expect("추가 채팅이 목록에 없다");
        assert!(row.get("btwOf").is_none(), "일반 채팅에 btwOf가 붙으면 남의 화면에 알약이 뜬다");
    }
}
