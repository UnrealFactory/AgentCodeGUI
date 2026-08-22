//! **과도기 별칭 다리** — 옛 3세트 블롭(`chats:*` / `ma:*`) ↔ 통합 스토어(chats-v3).
//!
//! M-UX §6.2. 얼려 둔 2.6.2 렌더러는 `picker`·`manualCwd`·`refDirs`·`api`가 평평하게 박힌
//! 레코드를 주고받는다. 통합 스토어는 그 값들을 `identity`(RawIdentity) 하나로 접었으므로,
//! **조회는 되그리고 저장은 번역한다.**
//!
//! 이 코드가 ipc가 아니라 스토어 크레이트에 있는 이유: 마이그레이션 하네스
//! (`scripts/poc-chat-unify-migrate.mjs` §5.3-3 별칭 왕복)가 앱을 띄우지 않고 **같은 코드**를
//! 돌려야 하기 때문이다. ipc 쪽에 두면 하네스가 자기만의 재조립을 흉내 내게 된다.
//!
//! ## 정체성 소유권의 과도기 예외 — ★R2 가드 (크리틱 D1 = P3 재발)
//! §4.1은 "렌더러가 보낸 identity는 무시하고 Rust 값을 되끼운다"이다. 별칭 모드에는
//! `chat:identity-set`이 아직 없으므로 별칭 계층이 정체성의 저자 노릇을 하는데, R1은
//! 거기에 **가드가 없었다**: 옛 렌더러는 스트리밍 토큰마다 디바운스 저장을 날리고
//! (`App.tsx:607-637`의 deps에 `state`가 있다) 그 페이로드의 `picker`는 **읽어간 시점의
//! 사본**이다. 턴 중 폴백이 `set_owned("identity")`를 하면 뒤이어 도착하는 그 저장이
//! 폴백 이전 값으로 되돌린다 — m-logic §1 P3가 죽었다고 선언한 병리 그대로다.
//!
//! 가드는 두 겹이다:
//!  1. **에코 판별** — `chats:get`/`ma:get`이 내보낸 옛 필드 묶음을 `PROJECTED`에 기억해
//!     두고, 돌아온 페이로드가 **그것과 같으면** 렌더러는 저자가 아니다(그냥 되돌려준 것)
//!     → 정체성을 손대지 않는다. 다르면 사람이 picker를 바꾼 것이므로 번역해 세운다.
//!  2. **출처 불명이면 런타임/디스크 우선** — `PROJECTED`에 기록이 없는데(다른 프로세스·
//!     재시작·CLI) 이미 정체성 진실이 있으면 **렌더러 사본을 믿지 않는다.**
//!
//! 어느 경우에도 페이로드의 `identity` 필드 자체는 채택하지 않는다(§4.1 ★R3 그대로).
//!
//! ## 지우기 안전
//! 옛 렌더러는 목록을 **셋**으로 나눠 든다(본채팅·멀티·추가 채팅). 통합 스토어는 하나다 →
//! `chats:save`가 자기 목록만 담아 오면 나머지가 prune 대상이 된다. 그래서 각 별칭 저장은
//! **자기 `origin` 칸 안에서만** 지운다(migrate_v3의 `ORIGIN_*` 참조).
//! ★R2(D9): `origin`의 기본값은 `chat`이 아니라 **`unknown`** 이다 — 모르는 칸은 아무도
//! 못 지우고 옛 목록에도 안 낀다(코어 `write_chats`가 만든 채팅이 낡은 저장에 삭제되던
//! 구멍을 닫는다).

use crate::migrate_v3::{ORIGIN_CHAT, ORIGIN_PANEL, ORIGIN_SESSION, ORIGIN_UNKNOWN};
use crate::raw_identity::{to_raw_identity, Globals, Source};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::Mutex;

const SLOT_COUNT: usize = crate::boards::SLOT_COUNT;

/// 옛 평평한 필드 — 별칭 계층이 되그리고/흡수하는 묶음.
const LEGACY_KEYS: [&str; 5] = ["picker", "manualCwd", "cwd", "refDirs", "api"];

/// chatId → **우리가 마지막으로 내보낸** 옛 필드 묶음의 정준 바이트(D1 에코 판별).
static PROJECTED: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

/// **우리가 이 채널로 내준 적 있는 보드 id**(C4). `ma:save`의 보드 삭제는 이 집합 안에서만
/// 일어난다 — 페이로드에 없는 보드가 "지운 것"인지 "애초에 안 실린 것"인지 가르는 유일한
/// 근거다. 내준 적 없는 보드를 지우면 **다른 화면의 패널 대화가 통째로 사라진다.**
static HANDED_BOARDS: Mutex<Option<std::collections::HashSet<String>>> = Mutex::new(None);

fn with_projected<R>(f: impl FnOnce(&mut HashMap<String, String>) -> R) -> R {
    let mut g = PROJECTED.lock().unwrap_or_else(|e| e.into_inner());
    f(g.get_or_insert_with(HashMap::new))
}

fn with_handed_boards<R>(f: impl FnOnce(&mut std::collections::HashSet<String>) -> R) -> R {
    let mut g = HANDED_BOARDS.lock().unwrap_or_else(|e| e.into_inner());
    f(g.get_or_insert_with(std::collections::HashSet::new))
}

/// 테스트/마이그레이션 후 초기화 — 홈이 갈리면 기억도 버려야 한다.
pub fn forget_projections() {
    *PROJECTED.lock().unwrap_or_else(|e| e.into_inner()) = None;
    *HANDED_BOARDS.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

/// 옛 필드 묶음만 뽑아 정준 직렬화(키 정렬) — 에코 비교의 유일한 키.
fn legacy_fingerprint(o: &Map<String, Value>) -> String {
    let mut m = Map::new();
    for k in LEGACY_KEYS {
        if let Some(v) = o.get(k) {
            m.insert(k.to_string(), v.clone());
        }
    }
    crate::raw_identity::canon_bytes(&Value::Object(m))
}

fn origin_of(chat: &Value) -> String {
    chat.get("origin").and_then(Value::as_str).unwrap_or(ORIGIN_UNKNOWN).to_string()
}

/// 통합 레코드 + 옛 평평한 필드(상위집합). 내보낸 모양을 `PROJECTED`에 기억한다.
fn with_legacy(chat: Value, source: Source) -> Value {
    let Some(mut o) = chat.as_object().cloned() else { return chat };
    let identity = o.get("identity").cloned().unwrap_or(Value::Null);
    if identity.is_object() {
        for (k, v) in crate::raw_identity::to_legacy(&identity, source) {
            o.insert(k, v);
        }
        // D5 — api 모드는 billing 유니온에 계정 칸이 없다. 보존해 둔 원시 값을 되그린다.
        if let Some(acc) = o.get("legacyAccount").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            let acc = acc.to_string();
            if let Some(p) = o.get_mut("picker").and_then(Value::as_object_mut) {
                p.entry("account".to_string()).or_insert(json!(acc));
            }
        }
    }
    if let Some(id) = o.get("id").and_then(Value::as_str) {
        let fp = legacy_fingerprint(&o);
        with_projected(|m| m.insert(id.to_string(), fp));
    }
    Value::Object(o)
}

/// 이 페이로드의 옛 필드를 **정체성의 저자로 인정할 것인가**(D1).
fn renderer_authored(id: &str, incoming: &str) -> bool {
    match with_projected(|m| m.get(id).cloned()) {
        // 우리가 준 그대로 → 에코. 저자가 아니다.
        Some(prev) => prev != incoming,
        // 출처 불명 — 진실이 이미 있으면 렌더러 사본을 믿지 않는다.
        None => !crate::chats_v3::has_identity_truth(id),
    }
}

/// 페이로드에 옛 필드가 실려 있으면 정체성으로 번역하고 그 필드를 걷어낸다.
/// `id`는 호출자가 안다(멀티 패널 페이로드에는 `id`가 없다 — 자리에서 계산한다).
fn absorb_legacy(chat: &Value, id: &str, source: Source, g: &Globals) -> Value {
    let mut o = chat.as_object().cloned().unwrap_or_default();
    let has_legacy = o.contains_key("picker") || o.contains_key("manualCwd") || o.contains_key("cwd");
    if has_legacy {
        if renderer_authored(id, &legacy_fingerprint(&o)) {
            let raw = to_raw_identity(chat, source, g);
            // D5 — 유니온이 못 담는 원시 계정은 레코드 칸에 보존한다
            if raw.get("billing").and_then(|b| b.get("kind")).and_then(Value::as_str) == Some("api_key") {
                if let Some(acc) = o.get("picker").and_then(|p| p.get("account")).and_then(Value::as_str).filter(|s| !s.is_empty())
                {
                    o.insert("legacyAccount".into(), json!(acc));
                }
            }
            // §4.1의 되끼움이 옛 값을 되살리지 않도록 **메모리 소유값**으로 세운다
            crate::chats_v3::set_owned_mem(id, "identity", raw);
        }
        for k in LEGACY_KEYS {
            o.shift_remove(k);
        }
        o.shift_remove("panelStatuses");
    }
    // 정체성은 어떤 경우에도 페이로드에서 오지 않는다 — `write_chats`가 진실을 되끼운다.
    o.shift_remove("identity");
    Value::Object(o)
}

// ── chats:get / chats:load / chats:save ─────────────────────────────────────

/// 지연 로드 한 건 — 옛 평평한 필드를 덧붙여 돌려준다.
pub fn chats_load(id: &str) -> Value {
    with_legacy(crate::chats_v3::read_chat(&json!(id)), Source::Chat)
}


pub fn chats_get(light: bool, open: &[String]) -> Value {
    let blob = crate::chats_v3::read_chats(light, open);
    let Some(mut o) = blob.as_object().cloned() else { return blob };
    // 별칭: 본채팅 목록만 보여 준다(멀티 패널·추가 채팅은 각자의 화면이 가져간다)
    let chats: Vec<Value> = o
        .get("chats")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter(|c| origin_of(c) == ORIGIN_CHAT)
                .map(|c| with_legacy(c.clone(), Source::Chat))
                .collect()
        })
        .unwrap_or_default();
    o.insert("chats".into(), json!(chats));
    Value::Object(o)
}

pub fn chats_save(data: &Value) {
    let Some(incoming) = data.get("chats").and_then(Value::as_array) else { return };
    let g = Globals::read();
    let mut updates: Vec<Value> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for c in incoming {
        let Some(id) = c.get("id").and_then(Value::as_str) else { continue };
        let mut v = absorb_legacy(c, id, Source::Chat, &g);
        if let Some(o) = v.as_object_mut() {
            o.entry("origin").or_insert(json!(ORIGIN_CHAT));
        }
        seen.push(id.to_string());
        updates.push(v);
    }
    // 자기 칸(origin=chat) 안에서만 지운다 — 남의 칸은 그대로 실어 보낸다.
    // D2 — 인덱스를 못 믿으면 **아무것도 안 지운다**(목록이 삭제 근거가 못 된다).
    let prunable = crate::chats_v3::index_trusted();
    let mut merged: Vec<Value> = Vec::new();
    let mut appended: std::collections::HashSet<String> = std::collections::HashSet::new();
    for existing in crate::chats_v3::all_chats() {
        let id = existing.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        if let Some(pos) = seen.iter().position(|x| *x == id) {
            merged.push(updates[pos].clone());
            appended.insert(id);
        } else if !prunable || origin_of(&existing) != ORIGIN_CHAT {
            merged.push(existing);
        }
        // origin=chat인데 페이로드에 없다 = 지운 채팅 → 빠진다(prune)
    }
    for (i, id) in seen.iter().enumerate() {
        if !appended.contains(id) {
            merged.push(updates[i].clone());
        }
    }
    let active = data
        .get("activeChatId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(crate::chats_v3::active_chat_id);
    crate::chats_v3::write_chats(&json!({ "version": 1, "chats": merged, "activeChatId": active }));
}

/// 영속된 **추가 채팅**(`origin = session`)의 목록 — 계약면 `SessionWindowInfo` 모양.
/// 2.6.2는 창을 닫아도 사이드바에 남겼다(`open:false`). 3.0의 `session-wins:list`가
/// 열린 창만 돌려주는 바람에 마이그레이션된 대화가 **화면에서 사라져 보였다**(크리틱 D7).
/// 여기서 파일 진실을 얹어 도달성을 되살린다 — 창 소유는 여전히 셸(win.rs)이다.
pub fn session_chat_infos() -> Vec<Value> {
    crate::chats_v3::all_chats()
        .into_iter()
        .filter(|c| origin_of(c) == ORIGIN_SESSION)
        .filter_map(|c| {
            let id = c.get("id").and_then(Value::as_str)?.to_string();
            Some(json!({
                "id": id,
                "title": c.get("title").and_then(Value::as_str).unwrap_or(""),
                "status": c.get("status").and_then(Value::as_str).unwrap_or("idle"),
                "open": false,
                "shown": true,
            }))
        })
        .collect()
}

// ── ma:get / ma:save / ma:load-session (보드 + 채팅 재조립) ──────────────────

fn panel_of(chat: &Value) -> Value {
    let v = with_legacy(chat.clone(), Source::Panel);
    let o = v.as_object().cloned().unwrap_or_default();
    // ★ `with_legacy`가 기억한 지문은 **여기서 실제로 내보내는 묶음**과 같아야 한다
    // (패널은 축소 레코드라 키가 빠질 수 있다) → 내보낼 모양으로 다시 기록한다.
    let mut out = Map::new();
    out.insert("title".into(), o.get("title").cloned().unwrap_or(json!("")));
    out.insert("custom".into(), o.get("custom").cloned().unwrap_or(json!(false)));
    out.insert("locked".into(), o.get("locked").cloned().unwrap_or(json!(false)));
    out.insert("color".into(), o.get("color").cloned().unwrap_or(json!("")));
    out.insert("cwd".into(), o.get("cwd").cloned().unwrap_or(json!("")));
    out.insert("refDirs".into(), o.get("refDirs").cloned().unwrap_or(json!([])));
    out.insert("picker".into(), o.get("picker").cloned().unwrap_or(Value::Null));
    out.insert("api".into(), o.get("api").cloned().unwrap_or(json!(false)));
    out.insert("snapshot".into(), o.get("snapshot").cloned().unwrap_or(Value::Null));
    if let Some(id) = o.get("id").and_then(Value::as_str) {
        let fp = legacy_fingerprint(&out);
        with_projected(|m| m.insert(id.to_string(), fp));
    }
    Value::Object(out)
}

fn empty_panel(g: &Globals) -> Value {
    let raw = to_raw_identity(&json!({}), Source::Panel, g);
    let mut o = Map::new();
    o.insert("title".into(), json!(""));
    o.insert("custom".into(), json!(false));
    o.insert("locked".into(), json!(false));
    o.insert("color".into(), json!(""));
    o.insert("snapshot".into(), Value::Null);
    for (k, v) in crate::raw_identity::to_legacy(&raw, Source::Panel) {
        o.insert(k, v);
    }
    Value::Object(o)
}

fn chat_index() -> std::collections::HashMap<String, Value> {
    crate::chats_v3::all_chats()
        .into_iter()
        .filter_map(|c| c.get("id").and_then(Value::as_str).map(|i| (i.to_string(), c.clone())))
        .collect()
}

fn session_from_board(board: &Value, chats: &std::collections::HashMap<String, Value>, g: &Globals, marker: bool) -> Value {
    let empty = vec![];
    let slots = board.get("slots").and_then(Value::as_array).unwrap_or(&empty);
    let mut panels: Vec<Value> = Vec::with_capacity(SLOT_COUNT);
    let mut statuses: Vec<Value> = Vec::with_capacity(SLOT_COUNT);
    for i in 0..SLOT_COUNT {
        let chat = slots.get(i).and_then(Value::as_str).and_then(|id| chats.get(id));
        statuses.push(json!(chat
            .and_then(|c| c.get("snapshot"))
            .and_then(|s| s.get("status"))
            .and_then(Value::as_str)
            .unwrap_or("idle")));
        panels.push(match chat {
            Some(c) => panel_of(c),
            None => empty_panel(g),
        });
    }
    let mut o = Map::new();
    o.insert("id".into(), board.get("id").cloned().unwrap_or(Value::Null));
    o.insert("title".into(), board.get("title").cloned().unwrap_or(json!("")));
    o.insert("custom".into(), board.get("custom").cloned().unwrap_or(json!(false)));
    o.insert("count".into(), board.get("count").cloned().unwrap_or(json!(1)));
    o.insert("panelOrder".into(), board.get("order").cloned().unwrap_or(json!([0, 1, 2, 3, 4, 5])));
    if let Some(u) = board.get("updatedAt") {
        o.insert("updatedAt".into(), u.clone());
    }
    if marker {
        // 부팅 경량화 — 비활성 세션은 패널 없이 상태 요약만(2.6.2 `readMulti(light)` 파리티)
        o.insert("panels".into(), json!([]));
        o.insert("panelStatuses".into(), Value::Array(statuses));
        o.insert("unloaded".into(), json!(true));
    } else {
        o.insert("panels".into(), Value::Array(panels));
    }
    Value::Object(o)
}

pub fn ma_get(light: bool) -> Value {
    let blob = crate::boards::read_boards();
    let Some(boards) = blob.get("boards").and_then(Value::as_array) else { return Value::Null };
    let active = blob.get("activeBoardId").and_then(Value::as_str).unwrap_or("").to_string();
    let g = Globals::read();
    let chats = chat_index();
    let sessions: Vec<Value> = boards
        .iter()
        .filter(|b| b.get("id").and_then(Value::as_str) != Some("default"))
        .map(|b| {
            let is_active = b.get("id").and_then(Value::as_str) == Some(active.as_str());
            session_from_board(b, &chats, &g, light && !is_active)
        })
        .collect();
    if sessions.is_empty() {
        return Value::Null;
    }
    // C4 — 지금 내주는 보드만 삭제 후보가 된다
    with_handed_boards(|h| {
        for s in &sessions {
            if let Some(id) = s.get("id").and_then(Value::as_str) {
                h.insert(id.to_string());
            }
        }
    });
    json!({ "version": 2, "activeSessionId": active, "sessions": sessions })
}

pub fn ma_session(id: &str, light: bool) -> Value {
    let board = crate::boards::read_board(&json!(id));
    if !board.is_object() {
        return Value::Null;
    }
    with_handed_boards(|h| h.insert(id.to_string()));
    session_from_board(&board, &chat_index(), &Globals::read(), light)
}

fn panel_has_content(p: &Value) -> bool {
    let title = p.get("title").and_then(Value::as_str).unwrap_or("");
    let msgs = p
        .get("snapshot")
        .and_then(|s| s.get("messages"))
        .and_then(Value::as_array)
        .map(|a| a.len())
        .unwrap_or(0);
    !title.is_empty() || msgs > 0
}

pub fn ma_save(data: &Value) {
    let Some(sessions) = data.get("sessions").and_then(Value::as_array) else { return };
    let g = Globals::read();
    let mut boards: Vec<Value> = Vec::new();
    let mut updates: Vec<Value> = Vec::new();
    let mut touched_boards: Vec<String> = Vec::new();
    let existing_boards: std::collections::HashMap<String, Value> = crate::boards::read_boards()
        .get("boards")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|b| b.get("id").and_then(Value::as_str).map(|i| (i.to_string(), b.clone())))
                .collect()
        })
        .unwrap_or_default();

    for s in sessions {
        let Some(sid) = s.get("id").and_then(Value::as_str) else { continue };
        touched_boards.push(sid.to_string());
        let unloaded = s.get("unloaded").and_then(Value::as_bool).unwrap_or(false);
        let prev = existing_boards.get(sid);
        let mut slots: Vec<Value> = prev
            .and_then(|b| b.get("slots"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_else(|| vec![Value::Null; SLOT_COUNT]);
        slots.resize(SLOT_COUNT, Value::Null);
        if !unloaded {
            // 마커 세션은 패널을 안 싣는다 — 저장된 채팅을 그대로 둔다(대화 증발 방지)
            let empty = vec![];
            let panels = s.get("panels").and_then(Value::as_array).unwrap_or(&empty);
            for (i, p) in panels.iter().take(SLOT_COUNT).enumerate() {
                if !panel_has_content(p) {
                    slots[i] = Value::Null;
                    continue;
                }
                let chat_id = format!("ma-{sid}-{i}");
                let mut rec = absorb_legacy(p, &chat_id, Source::Panel, &g);
                if let Some(o) = rec.as_object_mut() {
                    o.insert("id".into(), json!(chat_id));
                    o.insert("origin".into(), json!(ORIGIN_PANEL));
                }
                slots[i] = json!(chat_id);
                updates.push(rec);
            }
        }
        let mut b = Map::new();
        b.insert("id".into(), json!(sid));
        b.insert("title".into(), s.get("title").cloned().unwrap_or(json!("")));
        b.insert("custom".into(), s.get("custom").cloned().unwrap_or(json!(false)));
        b.insert(
            "count".into(),
            s.get("count").cloned().or_else(|| prev.and_then(|x| x.get("count").cloned())).unwrap_or(json!(1)),
        );
        b.insert("chrome".into(), prev.and_then(|x| x.get("chrome").cloned()).unwrap_or(json!("grid")));
        b.insert(
            "order".into(),
            json!(crate::boards::sanitize_order(
                s.get("panelOrder").or_else(|| prev.and_then(|x| x.get("order")))
            )),
        );
        b.insert("slots".into(), Value::Array(slots));
        if let Some(u) = s.get("updatedAt") {
            b.insert("updatedAt".into(), u.clone());
        }
        boards.push(Value::Object(b));
    }

    // C4 — 페이로드에 없는 보드: **우리가 내준 적 있으면** 지운 것(2.6.2 파리티),
    // 내준 적 없으면 그냥 안 실린 것이므로 그대로 살린다. 이 판별이 없으면 일부 세션만
    // 담긴 `ma:save` 한 번에 다른 보드의 패널 대화가 통째로 사라진다.
    let handed = HANDED_BOARDS.lock().unwrap_or_else(|e| e.into_inner()).clone().unwrap_or_default();
    let mut keys: Vec<&String> = existing_boards.keys().collect();
    keys.sort();
    for id in keys {
        if id == "default" || touched_boards.iter().any(|t| t == id) || handed.contains(id) {
            continue;
        }
        if let Some(b) = existing_boards.get(id) {
            boards.push(b.clone());
        }
    }
    // 기본 보드는 멀티 목록에 없다 — 그대로 살려 둔다
    if let Some(def) = existing_boards.get("default") {
        boards.insert(0, def.clone());
    }
    let active_board = data
        .get("activeSessionId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_default();
    crate::boards::write_boards(&json!({
        "version": 1,
        "boards": boards,
        "activeBoardId": active_board,
    }));

    // 채팅 병합 저장 — origin=panel 칸 안에서만 지운다(사라진 보드/빈 슬롯의 패널)
    let live_panels: std::collections::HashSet<String> = boards
        .iter()
        .flat_map(|b| b.get("slots").and_then(Value::as_array).cloned().unwrap_or_default())
        .filter_map(|v| v.as_str().map(str::to_string))
        .collect();
    let upd: std::collections::HashMap<String, Value> = updates
        .into_iter()
        .filter_map(|u| u.get("id").and_then(Value::as_str).map(|i| (i.to_string(), u.clone())))
        .collect();
    let prunable = crate::chats_v3::index_trusted();
    let mut merged: Vec<Value> = Vec::new();
    let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();
    for existing in crate::chats_v3::all_chats() {
        let id = existing.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        if let Some(u) = upd.get(&id) {
            merged.push(u.clone());
            used.insert(id);
            continue;
        }
        if !prunable || origin_of(&existing) != ORIGIN_PANEL || live_panels.contains(&id) {
            merged.push(existing);
        }
        // origin=panel인데 살아 있는 슬롯이 아니다 → prune
    }
    for (id, u) in upd {
        if !used.contains(&id) {
            merged.push(u);
        }
    }
    crate::chats_v3::write_chats(&json!({
        "version": 1,
        "chats": merged,
        "activeChatId": crate::chats_v3::active_chat_id(),
    }));
}

#[cfg(test)]
#[path = "legacy_bridge_tests.rs"]
mod tests;
