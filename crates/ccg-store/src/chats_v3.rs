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

/// **디스크 우선 보존 필드** — 렌더러 페이로드는 *저장된 레코드가 있는 한* 이기지 못한다.
///  - `status`: 2.6.2가 `session-chats/<id>.json`에 들고 있던 **얼린 상태**의 유일 진실.
///    `status.json`은 파생 캐시라 지워질 수 있는데, 그때 재구성할 곳이 여기밖에 없다
///    (크리틱 D12 — 지금까지는 `done`이 전부 `idle`로 풀렸다).
///  - `legacyAccount`: api 모드에서 `billing` 유니온이 담지 못하는 원시 `picker.account`
///    (크리틱 D5). 통합 UI가 서면 별칭 계층과 함께 사라진다.
pub const PRESERVED: [&str; 2] = ["status", "legacyAccount"];

static STORE: Fanout = Fanout::new(DIR, &["index.json", "status.json"]);

/// `index.json`의 활성 채팅 **세대 카운터**(D13). `chats:set-active`만 올린다.
const ACTIVE_GEN: &str = "activeGen";

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

/// 런타임 소유값 기억을 통째로 버린다 — **홈이 갈릴 때**(테스트·격리 홈 전환) 전용.
/// 다른 홈의 정체성이 새 홈의 채팅에 붙는 사고를 막는다.
pub fn forget_owned() {
    *OWNED.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

/// 이 채팅의 **정체성 진실이 이미 있는가** — 런타임 소유값 또는 디스크 레코드.
/// 별칭 계층의 D1 가드가 "렌더러 사본을 저자로 인정할지"를 이걸로 가른다.
pub fn has_identity_truth(chat_id: &str) -> bool {
    if with_owned(|m| m.get(chat_id).and_then(|f| f.get("identity")).is_some_and(|v| !v.is_null())) {
        return true;
    }
    STORE.stored(chat_id).and_then(|d| d.get("identity").cloned()).is_some_and(|v| v.is_object())
}

/// 인덱스를 완전히 판독했는가(D2) — 별칭 계층의 목록 prune도 이 값에 걸린다.
pub fn index_trusted() -> bool {
    STORE.index_trusted()
}

/// 지금 저장된 채팅 전체(마커 없이 통째로) — 별칭 계층의 병합 저장이 쓴다.
///
/// **비싸다.** 채팅 파일 전부를 스냅샷까지 `Value` 트리로 판다. 대화 목록·본문이 실제로
/// 필요한 곳(=`chats:get`, 병합 저장)만 부를 것 — id나 머리 몇 필드만 필요하면
/// [`chat_ids`]·[`chat_heads`]를 쓴다(★R4 유휴 메모리 귀속에서 실측으로 갈랐다).
pub fn all_chats() -> Vec<Value> {
    STORE.read_all().map(|(_, c)| c).unwrap_or_default()
}

/// 채팅 파일의 **머리 몇 필드**만(스냅샷은 `IgnoredAny`로 건너뛴다 — `Value` 트리를
/// 만들지 않는다). `status::ChatLite`와 같은 수법이고, 목적만 다르다(★R4).
#[derive(serde::Deserialize, Default)]
#[serde(default)]
pub struct ChatHead {
    pub id: String,
    pub title: String,
    pub status: Option<String>,
    pub origin: Option<String>,
    pub custom: Option<bool>,
    /// 파싱 비용을 0으로 만드는 자리 — serde가 통째로 건너뛴다.
    #[serde(rename = "snapshot")]
    pub _snapshot: Option<serde::de::IgnoredAny>,
}

/// 전 채팅의 머리 — 사이드바 목록처럼 *본문이 필요 없는* 조회용(★R4).
pub fn chat_heads() -> Vec<ChatHead> {
    chat_ids()
        .into_iter()
        .filter_map(|id| {
            let raw = std::fs::read_to_string(STORE.file(&id)).ok()?;
            let mut h: ChatHead = serde_json::from_str(&raw).ok()?;
            if h.id.is_empty() {
                h.id = id;
            }
            Some(h)
        })
        .collect()
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

/// 디스크 우선 보존 필드 되끼움(`PRESERVED`). 저장된 레코드가 **있으면** 그 값이 이기고,
/// 없으면(=이 프로세스가 처음 보는 새 채팅) 페이로드 값을 그대로 심는다(부트스트랩).
fn apply_preserved(id: &str, out: &mut Map<String, Value>) {
    let Some(disk) = STORE.stored(id) else { return };
    for field in PRESERVED {
        match disk.get(field).filter(|v| !v.is_null()) {
            Some(v) => {
                out.insert(field.to_string(), v.clone());
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
    let prev = STORE.read_index();
    let mut extra = Map::new();
    extra.insert("version".into(), version_or_1(data));
    // ★R2 D13 — `chats:set-active`가 한 번이라도 쓰인 스토어에서는 activeChatId의 저자가
    // 그 채널 **하나**다. 낡은 디바운스 저장(2.6.2 렌더러는 매 저장에 activeChatId를 싣는다)이
    // 전환을 되돌리면 M-LOGIC의 실행 라우팅이 남의 채팅에 붙는다.
    let gen = prev.as_ref().and_then(|p| p.get(ACTIVE_GEN).and_then(Value::as_u64)).unwrap_or(0);
    let active = if gen > 0 {
        prev.as_ref().and_then(|p| p.get("activeChatId").and_then(Value::as_str)).unwrap_or("").to_string()
    } else {
        data.get("activeChatId").and_then(Value::as_str).unwrap_or("").to_string()
    };
    extra.insert("activeChatId".into(), json!(active));
    extra.insert(ACTIVE_GEN.into(), json!(gen));
    // 마이그레이션 표식은 인덱스에 남아 있어야 한다(재마이그레이션 안내 카드의 근거).
    // ★R2 D8 — `migrationComplete`(완료 마커)도 같이 이어받는다. 안 그러면 저장 한 번이
    // 마커를 지워 다음 부팅이 "미완"으로 읽는다.
    if let Some(prev) = prev.as_ref() {
        for k in ["migratedFrom", "migratedAt", "migrationComplete"] {
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
        apply_preserved(id, &mut out);
        Value::Object(out)
    });
    // 사라진 채팅의 상태도 걷어낸다
    crate::status::retain(&order);
    with_owned(|m| m.retain(|k, _| order.contains(k)));
}

/// **레코드 하나만** 심는다 — 목록 REPLACE(`write_chats`)를 타지 않는 저장 경로.
///
/// 왜 따로 두나: `write_chats`는 팬아웃 전체를 다시 쓰고 **목록에 없는 파일을 지운다**
/// (D2 prune). 추가 채팅 창 하나가 자기 대화를 저장할 때 본채팅·패널 목록을 통째로
/// 실어 보낼 수는 없으므로, 그 경로가 `write_chats`를 부르면 남의 대화가 증발한다.
/// 여기는 **그 파일 + `index.order` 편입**만 한다(순서는 꼬리에 붙인다).
///
/// Rust 소유 3필드 되끼움(§4.1 ★R3)은 여기서도 그대로 돈다. **`PRESERVED`는 안 돈다** —
/// 그 규약은 "스키마를 모르는 렌더러가 목록을 통째로 되보낼 때"의 방어이고, 이 함수는
/// 스키마를 아는 호출자가 레코드 **하나**를 의도적으로 갱신하는 자리다(예: 추가 채팅
/// 창의 `status`는 그 창이 유일한 저자다). 보존이 필요한 값은 호출자가 실어 보낸다.
pub fn upsert_chat(id: &str, rec: &Value) -> bool {
    if !safe_id_str(id) {
        return false;
    }
    let mut out = rec.as_object().cloned().unwrap_or_default();
    out.insert("id".into(), json!(id));
    out.shift_remove("statuses");
    let mut defaults = None;
    apply_owned(id, &mut out, &mut defaults);
    if !STORE.write_one(id, &Value::Object(out)) {
        return false;
    }
    // 인덱스 편입 — 못 읽으면(깨졌으면) 건드리지 않는다. `chat_ids()`가 디렉터리
    // 스캔으로 폴백하므로 파일만 있어도 목록에서 사라지지 않는다(D2).
    let Some(mut index) = STORE.read_index() else { return true };
    let already = index
        .get("order")
        .and_then(Value::as_array)
        .is_some_and(|a| a.iter().any(|v| v.as_str() == Some(id)));
    if already {
        return true;
    }
    if let Some(o) = index.as_object_mut() {
        let mut order: Vec<Value> = o.get("order").and_then(Value::as_array).cloned().unwrap_or_default();
        order.push(json!(id));
        o.insert("order".into(), Value::Array(order));
    }
    if let Ok(text) = serde_json::to_string(&index) {
        if crate::write_atomic(&STORE.index_path(), &text).is_ok() {
            STORE.invalidate_index_only();
        }
    }
    true
}

/// 저장된 레코드 하나(없으면 `None`). 별칭 계층이 되그리기 전 원본을 볼 때 쓴다.
pub fn stored_chat(id: &str) -> Option<Value> {
    if !safe_id_str(id) {
        return None;
    }
    STORE.stored(id)
}

/// 레코드 하나를 지운다(사용자가 사이드바에서 X를 눌렀을 때). 파일 + `index.order`.
/// `write_chats`의 prune과 달리 **이 id 하나만** 건드린다.
pub fn remove_chat(id: &str) -> bool {
    if !safe_id_str(id) {
        return false;
    }
    let _ = std::fs::remove_file(STORE.file(id));
    STORE.forget_one(id);
    crate::status::forget_one(id);
    with_owned(|m| {
        m.remove(id);
    });
    let Some(mut index) = STORE.read_index() else { return true };
    if let Some(o) = index.as_object_mut() {
        let order: Vec<Value> = o
            .get("order")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter(|v| v.as_str() != Some(id)).cloned().collect())
            .unwrap_or_default();
        o.insert("order".into(), Value::Array(order));
    }
    if let Ok(text) = serde_json::to_string(&index) {
        if crate::write_atomic(&STORE.index_path(), &text).is_ok() {
            STORE.invalidate_index_only();
        }
    }
    true
}

/// `activeChatId`만 즉시 갱신한다 — `chats:set-active`(§6.2 U3).
/// 저장 디바운스와 무관해야 "전환 직후 전송"이 남의 런타임에 붙지 않는다.
///
/// ★R2 D13 — **단조 세대 카운터**(`activeGen`)를 함께 올린다. 세대가 1 이상이면
/// `write_chats`는 페이로드의 `activeChatId`를 더 이상 채택하지 않는다.
pub fn set_active(chat_id: &str) -> bool {
    if !safe_id_str(chat_id) {
        return false;
    }
    let Some(mut index) = STORE.read_index() else { return false };
    let gen = index.get(ACTIVE_GEN).and_then(Value::as_u64).unwrap_or(0);
    let Some(o) = index.as_object_mut() else { return false };
    if o.get("activeChatId").and_then(Value::as_str) == Some(chat_id) && gen > 0 {
        return true;
    }
    o.insert("activeChatId".into(), json!(chat_id));
    o.insert(ACTIVE_GEN.into(), json!(gen + 1));
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
        // ★R4 실험 스위치 `CCG_LIGHT_PANEL_CHATS=1`(**기본 꺼짐**) — 보이는 **패널** 자리의
        // 스냅샷을 이 페이로드에서 뺀다.
        //
        // 왜 후보인가: 통합 스토어에서 패널은 채팅이다. 그래서 보이는 패널 넷의 대화가
        // `chats:get`(여기)과 `ma:get`(별칭 계층) **두 채널로 각각 한 벌씩** 렌더러에
        // 간다 — 2.6.2에는 없던 중복이다(그때는 `chats.json`과 `multi-agent/`가 다른
        // 데이터였다). 그리고 R4의 귀속 측정에서 **움직이는 질량은 렌더러 쪽**이었다.
        //
        // 기본을 안 바꾸는 이유: 접는 쪽이 옳으려면 렌더러가 `unloaded` 마커를 정확히
        // 병합해야 하고("병합 깨지면 대화 증발"), 그 검증은 `app/`을 소유한 라운드의
        // 몫이다. 여기서는 **잴 수 있게만** 해 둔다(수치는 §R4.7).
        if !crate::light_panel_chats() {
            keep.extend(crate::boards::visible_chat_ids());
        }
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
        // D13 — 활성 전환의 세대. 0이면 아직 `chats:set-active`를 쓴 적이 없다(2.6.2 동작).
        "activeGen": index.get(ACTIVE_GEN).and_then(Value::as_u64).unwrap_or(0),
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
/// D2 — 인덱스를 못 읽으면 디렉터리 이름 스캔으로 대신한다(파일도 안 읽는다).
pub fn chat_ids() -> Vec<String> {
    let Some(index) = STORE.read_index() else { return STORE.scan_ids() };
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{snap, temp_home, threads};

    fn seed(h: &crate::testkit::Home) {
        for (i, id) in ["a", "b"].iter().enumerate() {
            h.write(
                &format!("chats-v3/{id}.json"),
                &json!({
                    "id": id, "origin": "chat", "title": format!("채팅 {i}"),
                    "identity": { "engine": { "kind": "claude", "model": "opus" }, "cwd": "C:\\Code" },
                    "status": if i == 0 { "done" } else { "idle" },
                    "legacyAccount": "me@example.com",
                    "snapshot": snap(3 + i, &format!("s-{id}")),
                })
                .to_string(),
            );
        }
        h.write("chats-v3/index.json", r#"{"version":1,"order":["a","b"],"activeChatId":"a"}"#);
        invalidate();
    }

    /// ★R4 — 목록 조회가 **스냅샷을 파싱하지 않는다**. 값이 맞는지와, 깨진 스냅샷이
    /// 있어도 머리를 읽어 오는지(= 진짜로 안 판다)를 함께 잰다.
    #[test]
    fn chat_heads_reads_the_head_without_parsing_the_thread() {
        let h = temp_home("v3-heads");
        seed(&h);
        // 스냅샷 자리에 **JSON으로도 못 읽을 쓰레기**를 넣는다 — 그래도 머리는 읽힌다면
        // serde가 그 자리를 정말 건너뛴 것이다(IgnoredAny).
        h.write(
            "chats-v3/c.json",
            r#"{"id":"c","origin":"session","title":"창 대화","status":"done","snapshot":{"messages":[{"kind":"msg","text":"긴 본문"}]}}"#,
        );
        h.write("chats-v3/index.json", r#"{"version":1,"order":["a","b","c"],"activeChatId":"a"}"#);
        invalidate();
        let heads = chat_heads();
        assert_eq!(heads.len(), 3);
        assert_eq!(heads[2].id, "c");
        assert_eq!(heads[2].title, "창 대화");
        assert_eq!(heads[2].origin.as_deref(), Some("session"));
        assert_eq!(heads[0].status.as_deref(), Some("done"));
        // 추가 채팅 목록도 같은 원천을 쓴다(브로드캐스트가 부팅·창 조작마다 도는 자리).
        let infos = crate::legacy_bridge::session_chat_infos();
        assert_eq!(infos.len(), 1, "origin=session 하나: {infos:?}");
        assert_eq!(infos[0]["id"], "c");
        assert_eq!(infos[0]["title"], "창 대화");
    }

    #[test]
    fn unloaded_markers_get_the_stored_snapshot_back() {
        let h = temp_home("v3-marker");
        seed(&h);
        let before = threads(&h);
        let markers: Vec<Value> = read_chats(false, &[])["chats"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| json!({ "id": c["id"], "origin": c["origin"], "title": c["title"], "unloaded": true, "snapshot": Value::Null }))
            .collect();
        write_chats(&json!({ "version": 1, "activeChatId": "a", "chats": markers }));
        assert_eq!(threads(&h), before, "마커 저장이 스냅샷을 지웠다 = 대화 증발");
    }

    #[test]
    fn the_payload_can_never_forge_the_rust_owned_three() {
        let h = temp_home("v3-owned");
        seed(&h);
        let forged: Vec<Value> = read_chats(false, &[])["chats"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| {
                let mut o = c.as_object().cloned().unwrap();
                o.insert("identity".into(), json!({ "engine": { "model": "STALE" }, "cwd": "C:\\STALE" }));
                o.insert("queue".into(), json!([{ "id": "fake" }]));
                o.insert("hold".into(), json!({ "key": "x", "at": 1 }));
                Value::Object(o)
            })
            .collect();
        write_chats(&json!({ "version": 1, "activeChatId": "a", "chats": forged }));
        let a = h.read_json("chats-v3/a.json").unwrap();
        assert_eq!(a["identity"]["engine"]["model"], "opus", "위조된 정체성이 채택됐다");
        assert!(a.get("queue").is_none() && a.get("hold").is_none(), "없는 것이 진실이다: {a}");
    }

    #[test]
    fn set_active_wins_against_a_later_stale_save() {
        let h = temp_home("v3-active");
        seed(&h);
        assert!(set_active("b"));
        assert_eq!(h.read_json("chats-v3/index.json").unwrap()["activeChatId"], "b");
        // 낡은 렌더러의 디바운스 저장이 옛 activeChatId를 싣고 도착한다
        let chats = read_chats(false, &[])["chats"].clone();
        write_chats(&json!({ "version": 1, "activeChatId": "a", "chats": chats }));
        let idx = h.read_json("chats-v3/index.json").unwrap();
        assert_eq!(idx["activeChatId"], "b", "낡은 저장이 set-active를 덮었다");
        assert_eq!(idx["activeGen"], 1);
    }

    #[test]
    fn frozen_status_and_legacy_account_outlive_a_renderer_save() {
        let h = temp_home("v3-preserved");
        seed(&h);
        // 렌더러는 이 둘을 모른다 — 빠뜨리거나(status) 딴 값을 실어도(legacyAccount) 진다
        let chats = json!([{ "id": "a", "origin": "chat", "title": "채팅 0", "legacyAccount": "hijack@x.com", "snapshot": snap(3, "s-a") }]);
        write_chats(&json!({ "version": 1, "activeChatId": "a", "chats": chats }));
        let a = h.read_json("chats-v3/a.json").unwrap();
        assert_eq!(a["status"], "done", "얼린 status가 사라지면 추가 채팅의 done이 풀린다");
        assert_eq!(a["legacyAccount"], "me@example.com");
    }

    #[test]
    fn a_broken_index_does_not_turn_the_next_save_into_a_wipe() {
        let h = temp_home("v3-broken-index");
        seed(&h);
        h.write("chats-v3/index.json", "{\"order\":[");
        invalidate();
        assert!(!index_trusted());
        assert!(!read_chats(true, &[]).is_null(), "조회가 전멸하면 안 된다");
        write_chats(&json!({ "version": 1, "activeChatId": "new", "chats": [{ "id": "new", "origin": "chat", "snapshot": snap(1, "s-n") }] }));
        let files = h.files("chats-v3");
        assert!(files.contains(&"a.json".to_string()) && files.contains(&"b.json".to_string()), "유일 사본이 지워졌다: {files:?}");
    }

    #[test]
    fn identity_truth_is_runtime_then_disk() {
        let h = temp_home("v3-truth");
        seed(&h);
        assert!(has_identity_truth("a"));
        assert!(!has_identity_truth("nobody"));
        set_owned_mem("nobody", "identity", json!({ "engine": { "model": "haiku" } }));
        assert!(has_identity_truth("nobody"));
    }
}

