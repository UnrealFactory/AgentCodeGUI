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
//! ## 정체성 소유권의 과도기 예외(명시)
//! §4.1은 "렌더러가 보낸 identity는 무시하고 Rust 값을 되끼운다"이다. 별칭 모드에는
//! `chat:identity-set`이 아직 없으므로 **별칭 계층이 유일한 정체성 저자**다 — 페이로드에
//! 옛 필드(`picker`·`manualCwd`·`cwd`)가 실려 있을 때만 번역해 세운다. 통합 모양
//! 페이로드(옛 필드 없음)에는 §4.1 규약이 그대로 적용된다(= 낡은 렌더러 사본이 폴백으로
//! 바뀐 정체성을 되돌리지 못한다).
//!
//! ## 지우기 안전
//! 옛 렌더러는 목록을 **셋**으로 나눠 든다(본채팅·멀티·추가 채팅). 통합 스토어는 하나다 →
//! `chats:save`가 자기 목록만 담아 오면 나머지가 prune 대상이 된다. 그래서 각 별칭 저장은
//! **자기 `origin` 칸 안에서만** 지운다(migrate_v3의 `ORIGIN_*` 참조).

use crate::migrate_v3::{ORIGIN_CHAT, ORIGIN_PANEL};
use crate::raw_identity::{to_raw_identity, Globals, Source};
use serde_json::{json, Map, Value};

const SLOT_COUNT: usize = crate::boards::SLOT_COUNT;

fn origin_of(chat: &Value) -> String {
    chat.get("origin").and_then(Value::as_str).unwrap_or(ORIGIN_CHAT).to_string()
}

/// 통합 레코드 + 옛 평평한 필드(상위집합).
fn with_legacy(chat: Value, source: Source) -> Value {
    let Some(mut o) = chat.as_object().cloned() else { return chat };
    let identity = o.get("identity").cloned().unwrap_or(Value::Null);
    if identity.is_object() {
        for (k, v) in crate::raw_identity::to_legacy(&identity, source) {
            o.insert(k, v);
        }
    }
    Value::Object(o)
}

/// 페이로드에 옛 필드가 실려 있으면 정체성으로 번역하고 그 필드를 걷어낸다.
fn absorb_legacy(chat: &Value, source: Source, g: &Globals) -> Value {
    let mut o = chat.as_object().cloned().unwrap_or_default();
    let has_legacy = o.contains_key("picker") || o.contains_key("manualCwd") || o.contains_key("cwd");
    if has_legacy {
        let raw = to_raw_identity(chat, source, g);
        if let Some(id) = o.get("id").and_then(Value::as_str) {
            // §4.1의 되끼움이 옛 값을 되살리지 않도록 **메모리 소유값**으로 세운다
            crate::chats_v3::set_owned_mem(id, "identity", raw.clone());
        }
        o.insert("identity".into(), raw);
        for k in ["picker", "manualCwd", "cwd", "refDirs", "api", "status", "panelStatuses"] {
            o.shift_remove(k);
        }
    }
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
        let mut v = absorb_legacy(c, Source::Chat, &g);
        if let Some(o) = v.as_object_mut() {
            o.entry("origin").or_insert(json!(ORIGIN_CHAT));
        }
        seen.push(id.to_string());
        updates.push(v);
    }
    // 자기 칸(origin=chat) 안에서만 지운다 — 남의 칸은 그대로 실어 보낸다
    let mut merged: Vec<Value> = Vec::new();
    let mut appended: std::collections::HashSet<String> = std::collections::HashSet::new();
    for existing in crate::chats_v3::all_chats() {
        let id = existing.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        if let Some(pos) = seen.iter().position(|x| *x == id) {
            merged.push(updates[pos].clone());
            appended.insert(id);
        } else if origin_of(&existing) != ORIGIN_CHAT {
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

// ── ma:get / ma:save / ma:load-session (보드 + 채팅 재조립) ──────────────────

fn panel_of(chat: &Value) -> Value {
    let v = with_legacy(chat.clone(), Source::Panel);
    let o = v.as_object().cloned().unwrap_or_default();
    json!({
        "title": o.get("title").cloned().unwrap_or(json!("")),
        "custom": o.get("custom").cloned().unwrap_or(json!(false)),
        "locked": o.get("locked").cloned().unwrap_or(json!(false)),
        "color": o.get("color").cloned().unwrap_or(json!("")),
        "cwd": o.get("cwd").cloned().unwrap_or(json!("")),
        "refDirs": o.get("refDirs").cloned().unwrap_or(json!([])),
        "picker": o.get("picker").cloned().unwrap_or(Value::Null),
        "api": o.get("api").cloned().unwrap_or(json!(false)),
        "snapshot": o.get("snapshot").cloned().unwrap_or(Value::Null),
    })
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
    json!({ "version": 2, "activeSessionId": active, "sessions": sessions })
}

pub fn ma_session(id: &str, light: bool) -> Value {
    let board = crate::boards::read_board(&json!(id));
    if !board.is_object() {
        return Value::Null;
    }
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
                let mut rec = absorb_legacy(p, Source::Panel, &g);
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
    let mut merged: Vec<Value> = Vec::new();
    let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();
    for existing in crate::chats_v3::all_chats() {
        let id = existing.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        if let Some(u) = upd.get(&id) {
            merged.push(u.clone());
            used.insert(id);
            continue;
        }
        if origin_of(&existing) != ORIGIN_PANEL || live_panels.contains(&id) {
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
