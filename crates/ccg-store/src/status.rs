//! `chats-v3/status.json` — 전 채팅의 경량 상태(`ChatStatusLite`). **Rust 전용 파일.**
//!
//! 규약(M-UX §4.3 = m-logic §5.8, 크리틱 N5의 답 — 다섯 줄 그대로):
//!  1. **주인은 Rust 하나.** 렌더러는 읽기만 한다. `chats:save` 페이로드에 `statuses`가
//!     **없다** → 같은 파일 두 주인이 구조적으로 불가능(R2가 index.json에 넣어 만들 뻔한
//!     lost update가 파일 분리로 사라진다).
//!  2. **쓰기 시점**: 전이마다 메모리 갱신 + 브로드캐스트(즉시), 디스크는 **500ms 디바운스
//!     + 종료 flush**. 크래시 창은 최대 500ms — 그게 이 파일이 "캐시"인 이유다.
//!  3. **이중 진실 우선순위**: `hold`·`queued`의 진실은 `<chatId>.json`. 여기 값은 파생
//!     요약이고, 어긋나면 **`<chatId>.json`이 이긴다**.
//!  4. **부팅 강제**: `busy=false`·`ask='none'`·`bgActive=false`(유령 알약 방지 —
//!     `sessionChats.ts:28` 파리티). `queued`·`hold`는 **강제하지 않는다**(재장전 대상).
//!  5. **유일 진실이 아니다.** 없거나 깨졌으면 `chats-v3/*.json` 전수 **얕은 스캔**으로
//!     재구성한다(`snapshot`은 파싱하지 않는다 — serde의 IgnoredAny가 통째로 건너뛴다).
//!
//! `unread`는 **3.0.0에서 항상 0**이다(필드만 예약 — M-UX 열린 문제 ⑪). 마커 채팅에서
//! 재계산이 불가능해 이 파일이 유일 진실이어야 하는데, 그러려면 "읽음" 리셋 채널이
//! 하나 더 필요하다(32 → 33). 표시 여부가 미결이라 값을 굳혀 출하한다.

use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::Duration;

const FILE: &str = "status.json";
/// 디스크 쓰기 디바운스 — 규약 2.
const DEBOUNCE: Duration = Duration::from_millis(500);

fn path() -> std::path::PathBuf {
    crate::app_home().join(super::chats_v3::DIR).join(FILE)
}

/// 채팅 파일의 **얕은 뷰** — `snapshot`·`messages`는 파싱하지 않는다.
/// serde는 모르는 필드를 `IgnoredAny`로 건너뛰므로 Value 트리를 만들지 않는다
/// (= 채팅 200개 얕은 스캔이 부팅 1회 수십 ms라는 규약 5의 근거).
#[derive(Deserialize, Default)]
#[serde(default)]
pub struct ChatLite {
    pub id: String,
    pub queue: Option<Vec<serde::de::IgnoredAny>>,
    pub hold: Option<HoldLite>,
    /// ★R2(D12) — 마이그레이션이 얼려 둔 상태. `status.json`이 없거나 깨졌을 때
    /// 재구성할 **유일한 진실**이다(2.6.2는 `session-chats/<id>.json`에 들고 있었다).
    pub status: Option<String>,
}

#[derive(Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct HoldLite {
    #[serde(rename = "resetsAt")]
    pub resets_at: Option<f64>,
    pub ready: bool,
}

struct State {
    map: BTreeMap<String, Value>,
    dirty: bool,
}

fn state() -> &'static (Mutex<State>, Condvar) {
    static S: OnceLock<(Mutex<State>, Condvar)> = OnceLock::new();
    S.get_or_init(|| (Mutex::new(State { map: BTreeMap::new(), dirty: false }), Condvar::new()))
}

/// 이 프로세스에서 status를 한 번이라도 장전했는가(부팅 강제는 1회만).
static LOADED: OnceLock<()> = OnceLock::new();

/// 빈 `ChatStatusLite` — 채팅은 있는데 상태 기록이 없을 때의 값.
pub fn empty_lite(chat_id: &str) -> Value {
    json!({
        "chatId": chat_id,
        "status": "idle",
        "busy": false,
        "bgActive": false,
        "ask": "none",
        "hold": Value::Null,
        "queued": 0,
        "unread": 0,          // ★ 3.0.0에서는 항상 0 (필드 예약)
        "updatedAt": 0,
    })
}

/// 부팅 장전 — 파일을 읽고 규약 4의 강제를 적용한 뒤, `<chatId>.json`의 진실로
/// `hold`·`queued`를 되맞춘다(규약 3). 파일이 없거나 깨졌으면 얕은 스캔으로 재구성한다.
pub fn load_boot(chat_ids: &[String]) -> BTreeMap<String, Value> {
    let raw = std::fs::read_to_string(path()).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok());
    let stored = raw
        .as_ref()
        .and_then(|v| v.get("statuses"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let mut out: BTreeMap<String, Value> = BTreeMap::new();
    for id in chat_ids {
        // 규약 5 — status.json이 없거나 그 채팅을 모르면 `<chatId>.json`의 얕은 스캔으로
        // **재구성**한다. R1은 `empty_lite`(=idle)로만 채워, 파일 하나가 사라지면 얼려 둔
        // `done`이 전부 풀렸다(크리틱 E2).
        let mut lite = stored.get(id).cloned().filter(Value::is_object).unwrap_or_else(|| {
            let mut e = empty_lite(id);
            if let (Some(o), Some(s)) = (e.as_object_mut(), read_chat_lite(id).and_then(|l| l.status)) {
                o.insert("status".into(), json!(s));
            }
            e
        });
        if let Some(o) = lite.as_object_mut() {
            o.insert("chatId".into(), json!(id));
            // 규약 4 — 부팅 강제(유령 알약 방지). queued·hold는 건드리지 않는다.
            o.insert("busy".into(), json!(false));
            o.insert("ask".into(), json!("none"));
            o.insert("bgActive".into(), json!(false));
            if o.get("status").and_then(Value::as_str) == Some("working")
                || o.get("status").and_then(Value::as_str) == Some("analyzing")
            {
                // 실행 중 상태로 복원하지 않는다(`sessionChats.ts:28` 파리티)
                o.insert("status".into(), json!("idle"));
            }
            o.insert("unread".into(), json!(0)); // ★ 3.0.0 고정
        }
        // 규약 3 — `<chatId>.json`이 이긴다
        if let Some(lite_obj) = lite.as_object_mut() {
            let (queued, hold) = truth_from_chat_file(id);
            lite_obj.insert("queued".into(), json!(queued));
            lite_obj.insert("hold".into(), hold);
        }
        out.insert(id.clone(), lite);
    }
    let _ = LOADED.set(());
    {
        let (m, _) = state();
        let mut st = m.lock().unwrap_or_else(|e| e.into_inner());
        st.map = out.clone();
    }
    out
}

/// `<chatId>.json`을 **얕게** 읽어 `queued`·`hold` 요약을 만든다(규약 3·5).
fn truth_from_chat_file(id: &str) -> (usize, Value) {
    let Some(lite) = read_chat_lite(id) else { return (0, Value::Null) };
    let queued = lite.queue.as_ref().map(|q| q.len()).unwrap_or(0);
    let hold = match lite.hold {
        Some(h) => json!({ "resetAt": h.resets_at, "ready": h.ready }),
        None => Value::Null,
    };
    (queued, hold)
}

/// 채팅 파일 하나의 얕은 뷰.
pub fn read_chat_lite(id: &str) -> Option<ChatLite> {
    let raw = std::fs::read_to_string(super::chats_v3::chat_file(id)).ok()?;
    serde_json::from_str::<ChatLite>(&raw).ok()
}

/// **재장전 후보**(M-UX §4.3 / m-logic §5.8 부팅 경로 1단계) —
/// `hold != null ∨ queued > 0`인 채팅. M-LOGIC이 이 목록으로 `ChatRuntime::ensure`를 돈다.
/// 이 경로가 없으면 재시작 후 자동 이어서가 **조용히** 안 산다.
pub fn reload_candidates(chat_ids: &[String]) -> Vec<String> {
    chat_ids
        .iter()
        .filter(|id| {
            let (q, h) = truth_from_chat_file(id);
            q > 0 || !h.is_null()
        })
        .cloned()
        .collect()
}

/// 지금 메모리에 있는 전 채팅 상태(= `chats:get`이 합쳐 주는 값 · `chat:status` REPLACE).
pub fn snapshot() -> Value {
    let (m, _) = state();
    let st = m.lock().unwrap_or_else(|e| e.into_inner());
    let mut out = Map::new();
    for (k, v) in &st.map {
        out.insert(k.clone(), v.clone());
    }
    Value::Object(out)
}

/// 상태 전이 1건 — 메모리 갱신 + 디바운스 예약(규약 2). 브로드캐스트는 호출자(ipc) 몫.
pub fn set(chat_id: &str, lite: Value) {
    if !super::fanout::safe_id_str(chat_id) {
        return;
    }
    let mut lite = lite;
    if let Some(o) = lite.as_object_mut() {
        o.insert("chatId".into(), json!(chat_id));
        o.insert("unread".into(), json!(0)); // ★ 3.0.0 고정
    }
    let (m, cv) = state();
    {
        let mut st = m.lock().unwrap_or_else(|e| e.into_inner());
        st.map.insert(chat_id.to_string(), lite);
        st.dirty = true;
    }
    cv.notify_all();
    ensure_writer();
}

/// 목록에서 사라진 채팅의 상태를 걷어낸다(채팅 삭제 · prune과 짝).
pub fn retain(chat_ids: &[String]) {
    let keep: std::collections::HashSet<&str> = chat_ids.iter().map(String::as_str).collect();
    let (m, cv) = state();
    {
        let mut st = m.lock().unwrap_or_else(|e| e.into_inner());
        let before = st.map.len();
        st.map.retain(|k, _| keep.contains(k.as_str()));
        if st.map.len() != before {
            st.dirty = true;
        }
    }
    cv.notify_all();
    ensure_writer();
}

/// 지금 즉시 디스크에 쓴다(앱 종료 flush · 마이그레이션 마무리).
pub fn flush() {
    let (m, _) = state();
    let text = {
        let mut st = m.lock().unwrap_or_else(|e| e.into_inner());
        if !st.dirty {
            return;
        }
        st.dirty = false;
        let mut statuses = Map::new();
        for (k, v) in &st.map {
            statuses.insert(k.clone(), v.clone());
        }
        serde_json::to_string(&json!({ "version": 1, "statuses": Value::Object(statuses) })).unwrap_or_default()
    };
    if text.is_empty() {
        return;
    }
    let p = path();
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = crate::write_atomic(&p, &text);
}

/// 500ms 디바운스 쓰기 스레드 — 첫 `set()`에서만 뜬다.
fn ensure_writer() {
    static WRITER: OnceLock<()> = OnceLock::new();
    if WRITER.set(()).is_err() {
        return;
    }
    std::thread::Builder::new()
        .name("ccg-status".into())
        .spawn(|| {
            let (m, cv) = state();
            loop {
                {
                    let st = m.lock().unwrap_or_else(|e| e.into_inner());
                    let _woken = cv.wait_while(st, |s| !s.dirty).unwrap_or_else(|e| e.into_inner());
                }
                // 연속 전이를 한 번의 쓰기로 접는다
                std::thread::sleep(DEBOUNCE);
                flush();
            }
        })
        .ok();
}

/// 메모리 상태를 비운다 — **홈이 갈릴 때**(테스트·격리 홈 전환) 전용.
pub fn forget() {
    let (m, _) = state();
    let mut st = m.lock().unwrap_or_else(|e| e.into_inner());
    st.map.clear();
    st.dirty = false;
}

/// 마이그레이션이 만든 초기 상태 맵을 통째로 심는다(그리고 즉시 쓴다).
pub fn seed(map: BTreeMap<String, Value>) {
    let (m, _) = state();
    {
        let mut st = m.lock().unwrap_or_else(|e| e.into_inner());
        st.map = map;
        st.dirty = true;
    }
    flush();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shallow_view_skips_the_snapshot() {
        // 스냅샷이 아무리 커도 파싱 대상은 queue/hold뿐이다
        let raw = json!({
            "id": "c1",
            "snapshot": { "messages": (0..200).map(|i| json!({ "id": i, "text": "x".repeat(64) })).collect::<Vec<_>>() },
            "queue": [ { "id": "q1" }, { "id": "q2" } ],
            "hold": { "key": "c1", "resetsAt": 1234.0, "ready": false }
        })
        .to_string();
        let lite: ChatLite = serde_json::from_str(&raw).unwrap();
        assert_eq!(lite.id, "c1");
        assert_eq!(lite.queue.unwrap().len(), 2);
        assert_eq!(lite.hold.unwrap().resets_at, Some(1234.0));
    }

    #[test]
    fn missing_optional_fields_are_none() {
        let lite: ChatLite = serde_json::from_str(r#"{"id":"c2","snapshot":null}"#).unwrap();
        assert!(lite.queue.is_none() && lite.hold.is_none());
    }
}
