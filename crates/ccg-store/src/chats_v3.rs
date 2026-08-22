//! **통합 채팅 스토어(chats-v3)** — M-UX §4.1.
//!
//! ```text
//! ~/.agentcodegui/chats-v3/
//!   index.json     { version, order[], activeChatId, migratedFrom?, migratedAt? }  ← 렌더러 팬아웃
//!   status.json    { version, statuses{} }                                          ← Rust 전용(status.rs)
//!   <chatId>.json  { id, title, custom, locked, color, identity, queue?, hold?,
//!                    draft, draftImages, btwOf?, btwSeed?, btwPrompt?, empty?,
//!                    lastSeenAt?, updatedAt, snapshot }
//! ```
//!
//! **새 디렉터리인 이유**(§4.1): 2.6.2는 main도 렌더러도 `version`을 검사하지 않는다
//! (`chats.ts:79`·`:157`, `App.tsx:131`·`:620`). 같은 `chats/`를 쓰면 2.6.2로 되돌아갔을 때
//! 통합 스토어를 조용히 읽고 유실 필드로 되쓴다. 디렉터리를 가르면 그 경로가 원천 차단된다.
//!
//! **두 개의 되끼움 규약** — 여기가 3.0에서 대화가 증발할 수 있는 자리다:
//!  1. `unloaded` 마커 → 디스크의 `snapshot`을 되끼운다(2.6.2 `chats.ts:22-35` 그대로).
//!  2. ★R3 **Rust 소유 3필드**(`identity`·`queue`·`hold`) → 렌더러가 실어 보내도 **무시하고**
//!     Rust 값으로 되끼운다. 저장이 디바운스라, 턴 중 폴백으로 바뀐 정체성을 낡은 렌더러
//!     사본이 되돌리는 사고(P3의 형태만 바꾼 재발)를 구조적으로 막는다.
//!     예외 하나: **저장된 값이 아직 없는 새 채팅**은 페이로드 값으로 심는다(부트스트랩) —
//!     안 그러면 렌더러가 만든 채팅이 정체성 없이 태어난다.

use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::Mutex;

use crate::fanout::{safe_id, safe_id_str, version_or_1, Fanout};

pub const DIR: &str = "chats-v3";
/// Rust 소유 필드 — 저장 시 되끼우는 셋(§4.1 ★R3).
pub const RUST_OWNED: [&str; 3] = ["identity", "queue", "hold"];

static STORE: Fanout = Fanout::new(DIR, &["index.json", "status.json"]);

pub fn chat_file(id: &str) -> std::path::PathBuf {
    STORE.file(id)
}
pub fn dir_path() -> std::path::PathBuf {
    STORE.dir_path()
}
pub fn invalidate() {
    STORE.invalidate();
}

/// Rust가 지금 들고 있는 소유 필드 값(런타임 오버라이드). M-LOGIC의 `ChatRuntime`이
/// 여기에 쓰고, 저장이 여기서 되끼운다. 비어 있으면 디스크 값이 진실이다.
static OWNED: Mutex<Option<HashMap<String, Map<String, Value>>>> = Mutex::new(None);

fn with_owned<R>(f: impl FnOnce(&mut HashMap<String, Map<String, Value>>) -> R) -> R {
    let mut g = OWNED.lock().unwrap_or_else(|e| e.into_inner());
    f(g.get_or_insert_with(HashMap::new))
}

/// M-LOGIC → 스토어: 이 채팅의 Rust 소유 필드를 갱신한다(`identity`/`queue`/`hold`).
/// 값이 `null`이면 그 필드를 지운다.
pub fn set_owned(chat_id: &str, field: &str, value: Value) {
    if !safe_id_str(chat_id) || !RUST_OWNED.contains(&field) {
        return;
    }
    with_owned(|m| {
        m.entry(chat_id.to_string()).or_default().insert(field.to_string(), value);
    });
    // 디스크에도 즉시 반영 — 저장 디바운스를 기다리면 크래시 창이 생긴다
    if let Some(mut stored) = STORE.stored(chat_id) {
        if let Some(o) = stored.as_object_mut() {
            apply_owned(chat_id, o, &mut None);
        }
        STORE.write_one(chat_id, &stored);
    }
}

/// 메모리에만 소유 필드를 세운다(디스크 쓰기 없음) — 곧이어 `write_chats`가 접는다.
/// 과도기 별칭 계층이 "옛 렌더러가 보낸 picker → identity"를 반영할 때 쓴다:
/// 그 모드에서는 **별칭 계층이 정체성의 유일한 저자**다(`chat:identity-set`이 아직 없다).
pub fn set_owned_mem(chat_id: &str, field: &str, value: Value) {
    if !safe_id_str(chat_id) || !RUST_OWNED.contains(&field) {
        return;
    }
    with_owned(|m| {
        m.entry(chat_id.to_string()).or_default().insert(field.to_string(), value);
    });
}

/// 지금 저장된 채팅 전체(마커 없이 통째로) — 별칭 계층의 병합 저장이 쓴다.
pub fn all_chats() -> Vec<Value> {
    STORE.read_all().map(|(_, c)| c).unwrap_or_default()
}

/// 지금 활성 채팅 id(§6.2의 `activeChat()` 진실 소스).
pub fn active_chat_id() -> String {
    STORE
        .read_index()
        .and_then(|i| i.get("activeChatId").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_default()
}

/// 저장 직전 훅 — 페이로드의 Rust 소유 필드를 **디스크/런타임 값으로 덮는다**.
///
/// **페이로드 값은 어떤 경우에도 채택되지 않는다**(§4.1 ★R3):
///  - `queue`·`hold`: 진실이 없으면 **키를 지운다.** "없다"가 곧 진실이다 —
///    렌더러가 큐/대기표를 만들어 낼 수 있으면 되끼움 규약이 무의미해진다.
///  - `identity`: 진실이 없으면(=이 프로세스가 처음 보는 채팅) **전역값으로 물질화**한다
///    (m-logic §2.4 규약 2 · `origin: default`). 렌더러 사본을 믿지 않는다.
///    과도기 별칭 계층은 `set_owned_mem`으로 **먼저** 진실을 세우므로 이 갈래를 타지 않는다.
fn apply_owned(id: &str, out: &mut Map<String, Value>, defaults: &mut Option<Value>) {
    let runtime = with_owned(|m| m.get(id).cloned());
    let disk = STORE.stored(id);
    for field in RUST_OWNED {
        let truth = runtime
            .as_ref()
            .and_then(|r| r.get(field).cloned())
            .or_else(|| disk.as_ref().and_then(|d| d.get(field).cloned()))
            .filter(|v| !v.is_null());
        match truth {
            Some(v) => {
                out.insert(field.to_string(), v);
            }
            None if field == "identity" => {
                let d = defaults
                    .get_or_insert_with(|| crate::raw_identity::default_raw_identity(&crate::raw_identity::Globals::read()));
                out.insert(field.to_string(), d.clone());
            }
            None => {
                out.shift_remove(field);
            }
        }
    }
}

/// unloaded 마커에 디스크의 스냅샷을 되끼운다(2.6.2 `chats.rs:151-172`와 같은 의미론).
fn merge_marker(id: &str, chat: &Value) -> Map<String, Value> {
    let stored_snapshot = STORE.stored(id).and_then(|v| v.get("snapshot").cloned());
    let mut merged: Map<String, Value> = chat.as_object().cloned().unwrap_or_default();
    match stored_snapshot {
        Some(s) => {
            merged.insert("snapshot".into(), s);
        }
        // 파일도 캐시도 없다(비정상) — `{...chat, snapshot: undefined}`와 같은 결과
        None => {
            merged.shift_remove("snapshot");
        }
    }
    merged.shift_remove("unloaded");
    merged
}

/// 블롭 저장 — 팬아웃 + 두 되끼움. `statuses`는 페이로드에 **없다**(있어도 무시).
pub fn write_chats(data: &Value) {
    let Some(chats) = data.get("chats").and_then(Value::as_array) else { return };
    let mut extra = Map::new();
    extra.insert("version".into(), version_or_1(data));
    extra.insert(
        "activeChatId".into(),
        json!(data.get("activeChatId").and_then(Value::as_str).unwrap_or("")),
    );
    // 마이그레이션 표식은 인덱스에 남아 있어야 한다(재마이그레이션 안내 카드의 근거)
    if let Some(prev) = STORE.read_index() {
        for k in ["migratedFrom", "migratedAt"] {
            if let Some(v) = prev.get(k) {
                extra.insert(k.into(), v.clone());
            }
        }
    }
    // 전역값 물질화는 채팅마다 디스크를 읽지 않도록 저장 1회당 한 번만 만든다
    let defaults = Mutex::new(None::<Value>);
    let order = STORE.write_all(chats, &extra, |id, chat| {
        let unloaded = chat.get("unloaded").and_then(Value::as_bool).unwrap_or(false);
        let mut out = if unloaded { merge_marker(id, chat) } else { chat.as_object().cloned().unwrap_or_default() };
        out.shift_remove("statuses"); // 혹시 실려 와도 파일에 남기지 않는다(주인은 status.json)
        let mut d = defaults.lock().unwrap_or_else(|e| e.into_inner());
        apply_owned(id, &mut out, &mut d);
        Value::Object(out)
    });
    // 사라진 채팅의 상태도 걷어낸다
    crate::status::retain(&order);
    with_owned(|m| m.retain(|k, _| order.contains(k)));
}

/// `activeChatId`만 즉시 갱신한다 — `chats:set-active`(§6.2 U3).
/// 저장 디바운스와 무관해야 "전환 직후 전송"이 남의 런타임에 붙지 않는다.
pub fn set_active(chat_id: &str) -> bool {
    if !safe_id_str(chat_id) {
        return false;
    }
    let Some(mut index) = STORE.read_index() else { return false };
    let Some(o) = index.as_object_mut() else { return false };
    if o.get("activeChatId").and_then(Value::as_str) == Some(chat_id) {
        return true;
    }
    o.insert("activeChatId".into(), json!(chat_id));
    let Ok(text) = serde_json::to_string(&index) else { return false };
    let ok = crate::write_atomic(&STORE.index_path(), &text).is_ok();
    if ok {
        // 인덱스 캐시를 버려 다음 팬아웃 저장이 이 값을 덮지 않게 한다
        STORE.invalidate_index_only();
    }
    ok
}

/// 부팅/조회 — `{ version, chats, activeChatId, statuses }`.
///
/// **light 규칙(§4.3)** — 스냅샷을 싣는 채팅은 셋뿐이다:
///  (a) 활성 보드의 **보이는 자리**(count개)의 채팅
///  (b) **열린 창**의 채팅 (`open_chat_ids`)
///  (c) **스냅샷이 빈 채팅 전부** ← 2.6.2의 예외를 보존한다(`chats.rs:97-104`).
///      이 예외가 `App.tsx:783`의 "빈 채팅 재사용" 판정을 받친다. 지우면 "새 채팅을
///      눌렀는데 골라둔 모델·폴더가 사라진다"가 난다(크리틱 U12).
pub fn read_chats(light: bool, open_chat_ids: &[String]) -> Value {
    let Some((index, mut chats)) = STORE.read_all() else { return Value::Null };
    let active_chat_id = index.get("activeChatId").and_then(Value::as_str).unwrap_or("").to_string();

    let ids: Vec<String> = chats
        .iter()
        .filter_map(|c| c.get("id").and_then(Value::as_str).map(str::to_string))
        .collect();

    if light {
        let mut keep: std::collections::HashSet<String> = open_chat_ids.iter().cloned().collect();
        keep.extend(crate::boards::visible_chat_ids());
        if !active_chat_id.is_empty() {
            keep.insert(active_chat_id.clone());
        }
        for c in chats.iter_mut() {
            let id = c.get("id").and_then(Value::as_str).unwrap_or("").to_string();
            if keep.contains(&id) {
                continue;
            }
            let has_msgs = c
                .get("snapshot")
                .and_then(|s| s.get("messages"))
                .and_then(Value::as_array)
                .is_some_and(|m| !m.is_empty());
            if !has_msgs {
                continue; // (c) 빈 채팅은 마커로 접지 않는다
            }
            if let Some(obj) = c.as_object_mut() {
                obj.insert("snapshot".into(), Value::Null);
                obj.insert("unloaded".into(), Value::Bool(true));
            }
        }
    }

    let statuses = crate::status::load_boot(&ids);
    let mut smap = Map::new();
    for (k, v) in statuses {
        smap.insert(k, v);
    }
    json!({
        "version": version_or_1(&index),
        "chats": chats,
        "activeChatId": active_chat_id,
        "statuses": Value::Object(smap),
    })
}

/// 채팅 하나 — 지연 로드(자리에 얹히는 순간).
pub fn read_chat(id: &Value) -> Value {
    match safe_id(id) {
        Some(id) => STORE.read_one(id),
        None => Value::Null,
    }
}

/// 채팅 id 목록 — **index.json만** 읽는다(스레드 본문을 건드리지 않는다).
/// 부팅 경로(§4.3)가 이걸로 돌아야 "채팅 200개에 수십 ms"가 성립한다.
pub fn chat_ids() -> Vec<String> {
    let Some(index) = STORE.read_index() else { return vec![] };
    index
        .get("order")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(safe_id)
                .filter(|id| STORE.file(id).is_file())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// 부팅 상태 장전 — `status.json` + `<chatId>.json` 얕은 스캔(§4.3 규약 3·5).
pub fn boot_statuses() -> Value {
    let map = crate::status::load_boot(&chat_ids());
    Value::Object(map.into_iter().collect())
}

/// 재장전 후보 — hold/큐가 있는 채팅(§4.3 부팅 경로 1단계).
pub fn reload_candidates() -> Vec<String> {
    crate::status::reload_candidates(&chat_ids())
}

