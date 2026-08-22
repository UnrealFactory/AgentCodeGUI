//! 채팅 스토어 — `chats/index.json` + `chats/<id>.json`.
//! 원본: src/main/chats.ts. **의미론을 한 줄도 흘리면 안 되는 파일**이다 —
//! 여기서 병합이 깨지면 사용자의 대화가 통째로 증발한다(2.6.2 메모리: poc-chats-merge).
//!
//! 규약(2.6.2 그대로):
//!  - 렌더러는 `{ version, chats, activeChatId }` 블롭 하나를 주고받는다. 이 모듈이
//!    채팅별 파일로 펼치고, **내용이 실제로 바뀐 파일만** 다시 쓴다(캐시 문자열 비교).
//!  - 부팅 조회(light)는 활성 채팅만 스냅샷을 싣고 나머지는 `unloaded` 마커로 보낸다.
//!    비활성 스냅샷은 렌더러가 받자마자 버리던 페이로드라 만들지 않는 게 순이익.
//!  - 렌더러가 마커를 되보내면(unloaded:true) 디스크의 스냅샷을 되끼워 저장한다.
//!    그냥 저장하면 대화가 지워진다.
//!  - 목록에서 사라진 채팅의 파일은 지운다(prune).

use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;

fn chats_dir() -> PathBuf {
    crate::app_home().join("chats")
}
fn index_path() -> PathBuf {
    chats_dir().join("index.json")
}
/// 옛 단일 파일 포맷 — 첫 조회 때 채팅별 파일로 이관하고 지운다.
fn legacy_blob() -> PathBuf {
    crate::app_home().join("chats.json")
}
fn chat_file(id: &str) -> PathBuf {
    chats_dir().join(format!("{id}.json"))
}

/// 채팅 id는 uuid / `chat-<n>-<base36>` 꼴 — 그 밖은 거부(경로 탈출 방지).
fn safe_id(v: &Value) -> Option<&str> {
    let s = v.as_str()?;
    if s.is_empty() || !s.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-') {
        return None;
    }
    Some(s)
}

/// `blob.version ?? 1` — null/부재 모두 1로(JS의 nullish 병합과 같게).
fn version_or_1(v: &Value) -> Value {
    match v.get("version") {
        Some(Value::Null) | None => json!(1),
        Some(other) => other.clone(),
    }
}

/// id → 마지막으로 디스크에 쓴 JSON 문자열. 저장이 바뀐 파일만 건드리게 하는 캐시.
static CACHE: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

fn with_cache<R>(f: impl FnOnce(&mut HashMap<String, String>) -> R) -> R {
    let mut guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    f(map)
}

/// 렌더러 블롭 모양으로 재조립. 저장본이 없으면 Null.
/// `light` = 부팅 경량 조회(활성 채팅만 스냅샷).
pub fn read_chats(light: bool) -> Value {
    // 1순위: index.json이 나열하는 채팅별 파일
    if let Some(index) = std::fs::read_to_string(index_path())
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
    {
        let empty = vec![];
        let order = index.get("order").and_then(Value::as_array).unwrap_or(&empty);
        let mut chats: Vec<Value> = Vec::new();
        with_cache(|cache| {
            cache.clear();
            for id in order {
                let Some(id) = safe_id(id) else { continue };
                // 파일이 없거나 깨졌으면 그 채팅만 건너뛴다(2.6.2와 같은 관용)
                let Ok(raw) = std::fs::read_to_string(chat_file(id)) else { continue };
                let Ok(parsed) = serde_json::from_str::<Value>(&raw) else { continue };
                cache.insert(id.to_string(), raw);
                chats.push(parsed);
            }
        });
        if !chats.is_empty() {
            let active_chat_id = index
                .get("activeChatId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if light {
                // 렌더러의 keep 판정(활성이거나 스냅샷이 비었으면 유지)과 정확히 같은 기준
                let act_idx = chats
                    .iter()
                    .position(|c| c.get("id").and_then(Value::as_str) == Some(active_chat_id.as_str()))
                    .unwrap_or(0);
                for (i, c) in chats.iter_mut().enumerate() {
                    if i == act_idx {
                        continue;
                    }
                    let has_msgs = c
                        .get("snapshot")
                        .and_then(|s| s.get("messages"))
                        .and_then(Value::as_array)
                        .is_some_and(|m| !m.is_empty());
                    if !has_msgs {
                        continue;
                    }
                    if let Some(obj) = c.as_object_mut() {
                        // { ...c, snapshot: null, unloaded: true } — 기존 키 자리는 유지되고
                        // 새 키(unloaded)만 뒤에 붙는 JS 스프레드와 같은 결과
                        obj.insert("snapshot".into(), Value::Null);
                        obj.insert("unloaded".into(), Value::Bool(true));
                    }
                }
            }
            let version = version_or_1(&index);
            return json!({ "version": version, "chats": chats, "activeChatId": active_chat_id });
        }
    }

    // 이관: 옛 단일 chats.json → 채팅별 파일로 펼친 뒤 원본 삭제
    if let Some(legacy) = std::fs::read_to_string(legacy_blob())
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
    {
        let has_chats = legacy
            .get("chats")
            .and_then(Value::as_array)
            .is_some_and(|a| !a.is_empty());
        if has_chats {
            write_chats(&legacy);
            let _ = std::fs::remove_file(legacy_blob());
            return legacy;
        }
    }

    Value::Null
}

/// 채팅 하나의 저장본 — 렌더러의 지연 로드(채팅 전환).
pub fn read_chat(id: &Value) -> Value {
    let Some(id) = safe_id(id) else { return Value::Null };
    let cached = with_cache(|c| c.get(id).cloned());
    let raw = match cached {
        Some(r) => r,
        None => match std::fs::read_to_string(chat_file(id)) {
            Ok(r) => r,
            Err(_) => return Value::Null,
        },
    };
    serde_json::from_str(&raw).unwrap_or(Value::Null)
}

/// unloaded 마커에 디스크의 스냅샷을 되끼운다. 파일도 캐시도 없으면(비정상)
/// `snapshot` 키 자체가 빠진다 — `{...chat, snapshot: undefined}`를 JSON.stringify한
/// 2.6.2와 같은 결과다.
fn with_stored_snapshot(id: &str, chat: &Value) -> Value {
    let stored = with_cache(|c| c.get(id).cloned())
        .or_else(|| std::fs::read_to_string(chat_file(id)).ok())
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|v| v.get("snapshot").cloned());

    let mut merged: Map<String, Value> = chat.as_object().cloned().unwrap_or_default();
    match stored {
        Some(s) => {
            merged.insert("snapshot".into(), s);
        }
        // undefined는 직렬화에서 사라진다 = 키를 지운다 (shift_remove로 나머지 순서 보존)
        None => {
            merged.shift_remove("snapshot");
        }
    }
    merged.shift_remove("unloaded");
    Value::Object(merged)
}

/// 블롭을 채팅별 파일로 저장. 바뀐 것만 쓰고, 사라진 것은 지운다.
pub fn write_chats(data: &Value) {
    let Some(chats) = data.get("chats").and_then(Value::as_array) else { return };
    if std::fs::create_dir_all(chats_dir()).is_err() {
        return; // 최선 노력 — 쓰기 실패는 "이번 턴이 저장되지 않음"일 뿐
    }
    let mut present: HashSet<String> = HashSet::new();
    let mut order: Vec<String> = Vec::new();
    for chat in chats {
        let Some(id) = chat.get("id").and_then(safe_id) else { continue };
        let id = id.to_string();
        present.insert(id.clone());
        order.push(id.clone());
        // 렌더러가 스냅샷을 내린 채팅은 메타만 온다 — 파일의 스냅샷을 지키고 메타만 덮는다
        let unloaded = chat.get("unloaded").and_then(Value::as_bool).unwrap_or(false);
        let merged = if unloaded { with_stored_snapshot(&id, chat) } else { chat.clone() };
        let Ok(json_text) = serde_json::to_string(&merged) else { continue };
        let changed = with_cache(|c| c.get(&id).map(|s| s != &json_text).unwrap_or(true));
        if changed && crate::write_atomic(&chat_file(&id), &json_text).is_ok() {
            with_cache(|c| c.insert(id.clone(), json_text));
        }
    }
    // 목록에서 사라진 채팅의 파일 정리
    if let Ok(entries) = std::fs::read_dir(chats_dir()) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.ends_with(".json") || name == "index.json" {
                continue;
            }
            let id = name.trim_end_matches(".json").to_string();
            if !present.contains(&id) {
                let _ = std::fs::remove_file(e.path());
                with_cache(|c| c.remove(&id));
            }
        }
    }
    let index = json!({
        "version": version_or_1(data),
        "order": order,
        "activeChatId": data.get("activeChatId").and_then(Value::as_str).unwrap_or("")
    });
    if let Ok(text) = serde_json::to_string(&index) {
        let _ = crate::write_atomic(&index_path(), &text);
    }
}
