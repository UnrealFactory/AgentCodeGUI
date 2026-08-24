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

/// ★R28 ACCT R2(F1) — **디스크에 실리면 안 되는 런타임 전용 키.**
///
/// `account`·`panelId`(§3의 「사용 중 · N번 자리」 칩)의 계약은 *"키가 있으면 살아 있는
/// 런타임"*이다. 그런데 R1은 그 계약을 **주석에만** 뒀다: `set()`이 `lite::build`의 결과를
/// 통째로 메모리 맵에 넣고 `flush()`가 그 맵을 그대로 썼기 때문에, 턴을 한 번이라도 돌린
/// 채팅은 `status.json`에 계정이 남았고 **재기동한 판(런타임 0개)에서도 칩이 켜졌다**
/// (확인 크리틱 R1 F1 — "늘 켜져 있는 경고는 없는 것보다 나쁘다").
///
/// 그래서 두 자리에서 **키째 지운다**: 쓸 때([`flush`])와 읽을 때([`load_boot`]).
/// 쓰기만 막으면 R1이 이미 써 둔 파일이 남아 그 홈은 영원히 유령 칩을 문다 — 읽기 쪽
/// 청소가 그 판의 답이고, 쓰기 쪽 청소가 재발 금지다.
const RUNTIME_ONLY_KEYS: [&str; 2] = ["account", "panelId"];

/// 런타임 전용 키를 걷어낸 사본(디스크 직렬화·부팅 장전 공용).
fn strip_runtime_only(v: &mut Value) {
    if let Some(o) = v.as_object_mut() {
        for k in RUNTIME_ONLY_KEYS {
            o.remove(k);
        }
    }
}

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
        // ★R4 — **재개의 주인이 누구인가**(m-logic P6 "행위자 하나").
        // `autoResume`은 이 채팅의 한도 해제를 Rust가 스스로 쏠지(스펙 ⑤ 보이는 자리),
        // `resumeOwner`는 *누가 관장하는가*다. 값이 `"engine"`인 동안 렌더러의
        // `useLimitResume`은 **자기 발화를 꺼야 한다** — 안 그러면 한 번의 해제에 두 턴이
        // 나간다(M-UX R2.9의 재현 축). 셸은 그 축을 Rust 쪽에서도 막지만(§7.3 나팔 억제),
        // 렌더러가 아예 안 쏘는 것이 규약이다.
        "autoResume": true,
        "resumeOwner": "engine",
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
        // ★R28 ACCT R2(F1) — **부팅에는 살아 있는 런타임이 없다.** R1이 써 둔 파일에
        // `account`·`panelId`가 남아 있어도 여기서 걷어낸다(유령 「사용 중」 칩 방지).
        strip_runtime_only(&mut lite);
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

/// 재장전이 실제로 되살릴 **예약 본문**(§5.8 2단계 "queue 로드").
///
/// `read_chat_lite`는 개수만 세면 되므로 큐를 `IgnoredAny`로 건너뛴다 — 본문이 필요한
/// 쪽은 여기다. 항목은 2.6.2 문자열 배열이거나 `{text}` 객체 배열이다(두 판 다 있다).
/// 재장전에 필요한 것은 본문뿐이고, 정체성 스냅샷은 **다시 잡는다**(m-logic §5.8 —
/// "복원이 아니라 재장전": 그 사이 폴더·계정이 바뀌었을 수 있다).
pub fn read_chat_queue(id: &str) -> Vec<QueuedText> {
    let Ok(raw) = std::fs::read_to_string(super::chats_v3::chat_file(id)) else { return vec![] };
    let Ok(v) = serde_json::from_str::<Value>(&raw) else { return vec![] };
    v.get("queue")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|q| match q {
                    Value::String(s) => Some(QueuedText { text: s.clone(), images: vec![], origin: None }),
                    _ => {
                        let text = q
                            .get("text")
                            .or_else(|| q.get("prompt"))
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        // ★R4 — 첨부도 되살린다. R3까지는 본문만 읽어, 재시작 한 번에
                        // 예약의 이미지가 사라졌다(M-UX R2.1 #3의 재시작 판).
                        let images: Vec<String> = q
                            .get("images")
                            .or_else(|| q.get("attachments"))
                            .and_then(Value::as_array)
                            .map(|v| v.iter().filter_map(Value::as_str).map(str::to_string).collect())
                            .unwrap_or_default();
                        let origin = q.get("origin").and_then(Value::as_str).map(str::to_string);
                        Some(QueuedText { text, images, origin })
                    }
                })
                .filter(|q| !q.text.trim().is_empty() || !q.images.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// 디스크에 남은 예약 한 줄. 정체성 스냅샷은 **다시 잡는다**(재장전 규약)이므로
/// 여기 없다 — 되살릴 값은 본문과 첨부뿐이다.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct QueuedText {
    pub text: String,
    pub images: Vec<String>,
    /// ★M10 R2 C4 — **이 예약을 넣은 자**(`chat:queue`의 `origin` 그대로: `user` ·
    /// `talk` · `limit_resume` …). R1은 이 값을 안 읽었고, 재장전이 전부 사람 것으로
    /// 되돌려 세션 간 메시지가 **사람의 이름표를 달고** 되살아났다(크리틱 A7).
    pub origin: Option<String>,
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

/// ★R28 ACCT R2(F1-b) — **런타임이 거둬진 채팅**의 마지막 lite에서 계정·자리를 뗀다.
///
/// 마지막 상태(`done`·`error`…)는 남겨야 사이드바 점 색이 유지되고, 계정만 떨어져야
/// 「사용 중」 칩이 걷힌다. `Op::Dispose`(대화 삭제·창 파기)와 상주 CLI 회수가 이 문을
/// 지난다 — 슬롯만 지우면 마지막 lite가 그대로 남아 **같은 세션 안에서도 칩이 안 걷혔다**.
///
/// 돌려주는 값은 "실제로 뗐나"다 — 호출자가 그때만 브로드캐스트하면 된다.
pub fn clear_runtime(chat_id: &str) -> bool {
    let (m, cv) = state();
    let changed = {
        let mut st = m.lock().unwrap_or_else(|e| e.into_inner());
        let Some(v) = st.map.get_mut(chat_id) else { return false };
        let before = v.clone();
        strip_runtime_only(v);
        let changed = *v != before;
        if changed {
            st.dirty = true;
        }
        changed
    };
    if changed {
        cv.notify_all();
        ensure_writer();
    }
    changed
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

/// 채팅 **하나**의 상태만 걷어낸다(레코드 1건 삭제와 짝 — 목록 REPLACE가 아니다).
pub fn forget_one(chat_id: &str) {
    let (m, cv) = state();
    {
        let mut st = m.lock().unwrap_or_else(|e| e.into_inner());
        if st.map.remove(chat_id).is_some() {
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
            // ★R28 ACCT R2(F1) — 런타임 전용 키는 **파일로 내려가지 않는다.**
            // 메모리 맵에는 남는다(브로드캐스트가 그 값을 싣는 것이 §3의 기능이다) —
            // 갈리는 것은 *수명*이다: 프로세스와 함께 죽어야 하는 사실이다.
            let mut row = v.clone();
            strip_runtime_only(&mut row);
            statuses.insert(k.clone(), row);
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

    #[test]
    fn queue_bodies_are_read_from_both_shapes() {
        let h = crate::testkit::temp_home("status-queue");
        h.write(
            "chats-v3/c9.json",
            &json!({ "id": "c9", "queue": ["문자열 항목", { "text": "객체 항목" }, { "text": "  " }] }).to_string(),
        );
        let rows = read_chat_queue("c9");
        assert_eq!(
            rows.iter().map(|q| q.text.as_str()).collect::<Vec<_>>(),
            vec!["문자열 항목", "객체 항목"]
        );
        assert!(read_chat_queue("없는채팅").is_empty());
    }

    #[test]
    fn queue_attachments_survive_a_restart() {
        // ★R4 — 본문만 읽던 R3에서는 재시작 한 번에 예약의 이미지가 사라졌다.
        let h = crate::testkit::temp_home("status-queue-img");
        h.write(
            "chats-v3/c10.json",
            &json!({ "id": "c10", "queue": [
                { "text": "이 그림 봐줘", "images": ["C:\\shot\\a.png"] },
                { "text": "", "images": ["C:\\shot\\b.png"] }
            ] })
            .to_string(),
        );
        let rows = read_chat_queue("c10");
        assert_eq!(rows.len(), 2, "본문이 비어도 첨부만 있으면 예약이다");
        assert_eq!(rows[0].images, vec!["C:\\shot\\a.png".to_string()]);
        assert_eq!(rows[1].text, "");
        let _ = h;
    }

    /// ★R28 ACCT R2(F1) — **「사용 중」은 디스크로 내려가지 않는다.**
    ///
    /// 확인 크리틱 R1 F1의 실측: 턴 1회 → 종료 → 재기동에서 `status.json`에 남은
    /// `account`가 그대로 살아나 **런타임이 하나도 없는 판**에서 칩이 켜졌다.
    /// 여기서 잠그는 것은 두 방향이다 — 쓸 때 빠지고, 읽을 때(옛 파일) 걷힌다.
    #[test]
    fn the_in_use_account_never_reaches_the_disk_and_never_comes_back() {
        let h = crate::testkit::temp_home("status-runtime-keys");
        forget();
        // ① 살아 있는 런타임의 lite — 계정·자리가 실린다(브로드캐스트는 이 값을 쓴다).
        set(
            "c-a",
            json!({ "chatId": "c-a", "status": "done", "busy": false, "bgActive": false,
                    "account": "one@ccg.test", "panelId": "b1::1", "ask": "none",
                    "hold": Value::Null, "queued": 0, "updatedAt": 7 }),
        );
        assert_eq!(snapshot()["c-a"]["account"], json!("one@ccg.test"), "메모리에는 남아야 §3이 산다");
        flush();
        let txt = std::fs::read_to_string(path()).expect("status.json");
        println!("[F1] flush 결과 = {txt}");
        assert!(!txt.contains("account"), "★ 계정이 디스크에 남았다: {txt}");
        assert!(!txt.contains("panelId"), "★ 자리가 디스크에 남았다: {txt}");
        assert!(txt.contains("\"status\":\"done\""), "종결 상태까지 지우면 안 된다");

        // ② R1이 써 둔 파일(두 키가 들어 있다)을 부팅에서 장전 — 걷혀야 한다.
        h.write(
            "chats-v3/status.json",
            &json!({ "version": 1, "statuses": { "c-a": {
                "chatId": "c-a", "status": "done", "busy": false,
                "account": "one@ccg.test", "panelId": "default::0" } } })
            .to_string(),
        );
        forget();
        let boot = load_boot(&["c-a".to_string()]);
        let row = boot.get("c-a").expect("행");
        println!("[F1] load_boot = {row}");
        assert!(row.get("account").is_none(), "★ 재기동 판에 유령 계정이 살아났다: {row}");
        assert!(row.get("panelId").is_none(), "★ 재기동 판에 유령 자리가 살아났다: {row}");
        assert_eq!(row["status"], json!("done"), "얼려 둔 종결 상태는 그대로다");
        let _ = h;
    }

    /// ★R28 ACCT R2(F1-b) — 런타임 회수는 **마지막 lite를 계정 없이 다시 앉힌다**.
    /// 슬롯만 지우면 같은 세션 안에서도 칩이 안 걷힌다(크리틱 F1 부수 사실).
    #[test]
    fn clearing_a_runtime_drops_the_account_but_keeps_the_status() {
        let _h = crate::testkit::temp_home("status-clear-runtime");
        forget();
        set(
            "c-b",
            json!({ "chatId": "c-b", "status": "done", "busy": false, "account": "two@ccg.test",
                    "panelId": "b1::2", "unread": 0 }),
        );
        assert!(clear_runtime("c-b"), "뗄 것이 있었는데 false를 돌려줬다");
        let row = snapshot()["c-b"].clone();
        println!("[F1-b] clear_runtime = {row}");
        assert!(row.get("account").is_none() && row.get("panelId").is_none(), "{row}");
        assert_eq!(row["status"], json!("done"), "마지막 상태까지 지우면 사이드바 점이 꺼진다");
        assert!(!clear_runtime("c-b"), "두 번째는 바뀐 게 없다");
        assert!(!clear_runtime("없는채팅"), "모르는 채팅에 참을 돌려주면 헛 브로드캐스트가 난다");
    }

    #[test]
    fn reload_candidates_are_only_the_chats_with_something_to_reload() {
        let h = crate::testkit::temp_home("status-cands");
        h.write("chats-v3/a.json", &json!({ "id": "a", "queue": ["하나"] }).to_string());
        h.write(
            "chats-v3/b.json",
            &json!({ "id": "b", "hold": { "resetsAt": 1_700_000_000.0, "ready": false } }).to_string(),
        );
        h.write("chats-v3/c.json", &json!({ "id": "c", "snapshot": { "messages": [] } }).to_string());
        let ids = ["a".to_string(), "b".to_string(), "c".to_string()];
        assert_eq!(reload_candidates(&ids), vec!["a".to_string(), "b".to_string()]);
    }
}
