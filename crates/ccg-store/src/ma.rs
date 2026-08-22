//! 멀티채팅(multi-agent) 워크스페이스 스토어 — `multi-agent/index.json` + `<id>.json`.
//! 원본: src/main/maStore.ts. chats.rs와 같은 팬아웃 구조이고, **같은 함정**을 갖는다:
//! 비활성 세션은 렌더러가 패널 스냅샷을 메모리에 들지 않고 `unloaded` 마커만 되보낸다.
//! 그 마커를 그대로 저장하면 그 세션의 대화 전부가 증발한다 → 디스크 패널을 되끼운다.
//!
//! 이 파일이 3.0의 **주 게이트(멀티채팅)** 를 여는 열쇠다. 이게 없으면 멀티 그리드가
//! 아예 뜨지 않아 bench/multi.mjs가 측정 자체를 못 한다.

use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;

fn ma_dir() -> PathBuf {
    crate::app_home().join("multi-agent")
}
fn index_path() -> PathBuf {
    ma_dir().join("index.json")
}
/// 옛 단일 파일 포맷 — 첫 조회 때 세션별 파일로 이관하고 지운다.
fn legacy_blob() -> PathBuf {
    crate::app_home().join("multi-agent.json")
}
fn session_file(id: &str) -> PathBuf {
    ma_dir().join(format!("{id}.json"))
}

/// 세션 id는 uuid / `ms-<n>-<base36>` 꼴 — 그 밖은 거부(경로 탈출 방지).
fn safe_id(v: &Value) -> Option<&str> {
    let s = v.as_str()?;
    if s.is_empty() || !s.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-') {
        return None;
    }
    Some(s)
}

fn version_or_1(v: &Value) -> Value {
    match v.get("version") {
        Some(Value::Null) | None => json!(1),
        Some(other) => other.clone(),
    }
}

/// id → 마지막으로 디스크에 쓴 JSON. 바뀐 파일만 건드리게 하는 캐시.
static CACHE: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);
/// id → 마지막 마커 페이로드 JSON. 같은 마커가 또 오면 병합 자체를 건너뛴다.
static META: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);
/// 마지막으로 쓴 index.json — 안 바뀌었으면 파일을 건드리지 않는다.
static INDEX_CACHE: Mutex<Option<String>> = Mutex::new(None);

fn with_map<R>(m: &'static Mutex<Option<HashMap<String, String>>>, f: impl FnOnce(&mut HashMap<String, String>) -> R) -> R {
    let mut guard = m.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(HashMap::new))
}

/// 저장된 멀티 워크스페이스 블롭. 없으면 Null.
/// `light` = 부팅 경량 조회(활성 세션만 패널을 싣고 나머지는 마커).
pub fn read_multi(light: bool) -> Value {
    if let Some(index) = std::fs::read_to_string(index_path())
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
    {
        let empty = vec![];
        let order = index.get("order").and_then(Value::as_array).unwrap_or(&empty);
        let mut sessions: Vec<Value> = Vec::new();
        with_map(&CACHE, |cache| {
            cache.clear();
            with_map(&META, |m| m.clear());
            for id in order {
                let Some(id) = safe_id(id) else { continue };
                let Ok(raw) = std::fs::read_to_string(session_file(id)) else { continue };
                let Ok(parsed) = serde_json::from_str::<Value>(&raw) else { continue };
                cache.insert(id.to_string(), raw);
                sessions.push(parsed);
            }
        });
        // 인덱스가 있으면 비어 있어도 여기서 끝 — 레거시로 넘어가면 지운 세션이 부활한다
        if sessions.is_empty() {
            return Value::Null;
        }
        let active_session_id = index
            .get("activeSessionId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if light {
            let act_idx = sessions
                .iter()
                .position(|s| s.get("id").and_then(Value::as_str) == Some(active_session_id.as_str()))
                .unwrap_or(0);
            for (i, s) in sessions.iter_mut().enumerate() {
                if i == act_idx {
                    continue;
                }
                let statuses: Vec<Value> = s
                    .get("panels")
                    .and_then(Value::as_array)
                    .map(|ps| {
                        ps.iter()
                            .map(|p| {
                                json!(p
                                    .get("snapshot")
                                    .and_then(|sn| sn.get("status"))
                                    .and_then(Value::as_str)
                                    .unwrap_or("idle"))
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                let any_snapshot = s
                    .get("panels")
                    .and_then(Value::as_array)
                    .is_some_and(|ps| ps.iter().any(|p| p.get("snapshot").is_some_and(|v| !v.is_null())));
                if !any_snapshot {
                    continue;
                }
                if let Some(obj) = s.as_object_mut() {
                    obj.insert("panels".into(), json!([]));
                    obj.insert("panelStatuses".into(), Value::Array(statuses));
                    obj.insert("unloaded".into(), Value::Bool(true));
                }
            }
        }
        return json!({
            "version": version_or_1(&index),
            "activeSessionId": active_session_id,
            "sessions": sessions
        });
    }

    // 이관: 옛 단일 multi-agent.json → 세션별 파일로 펼친 뒤 원본 삭제
    if let Some(legacy) = std::fs::read_to_string(legacy_blob())
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
    {
        let has = legacy
            .get("sessions")
            .and_then(Value::as_array)
            .is_some_and(|a| !a.is_empty());
        if has {
            write_multi(&legacy);
            let _ = std::fs::remove_file(legacy_blob());
            return legacy;
        }
    }
    Value::Null
}

/// 세션 하나의 저장본 — 렌더러의 세션 전환(지연 로드).
pub fn read_session(id: &Value) -> Value {
    let Some(id) = safe_id(id) else { return Value::Null };
    let cached = with_map(&CACHE, |c| c.get(id).cloned());
    let raw = match cached {
        Some(r) => r,
        None => match std::fs::read_to_string(session_file(id)) {
            Ok(r) => r,
            Err(_) => return Value::Null,
        },
    };
    serde_json::from_str(&raw).unwrap_or(Value::Null)
}

/// unloaded 마커에 디스크의 패널을 되끼운다(maStore.withStoredPanels).
fn with_stored_panels(id: &str, marker: &Value) -> Value {
    let prev = with_map(&CACHE, |c| c.get(id).cloned())
        .or_else(|| std::fs::read_to_string(session_file(id)).ok())
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());

    let mut merged: Map<String, Value> = marker.as_object().cloned().unwrap_or_default();
    let count = prev
        .as_ref()
        .and_then(|p| p.get("count").cloned())
        .or_else(|| marker.get("count").cloned());
    match count {
        Some(c) => {
            merged.insert("count".into(), c);
        }
        None => {
            merged.shift_remove("count");
        }
    }
    let panels = prev.as_ref().and_then(|p| p.get("panels").cloned()).unwrap_or(json!([]));
    merged.insert("panels".into(), panels);
    merged.shift_remove("unloaded");
    merged.shift_remove("panelStatuses"); // 부팅 마커의 배지 요약 — 파일엔 안 남긴다
    Value::Object(merged)
}

/// 블롭을 세션별 파일로 저장. 바뀐 것만 쓰고, 사라진 것은 지운다.
pub fn write_multi(data: &Value) {
    let Some(sessions) = data.get("sessions").and_then(Value::as_array) else { return };
    if std::fs::create_dir_all(ma_dir()).is_err() {
        return;
    }
    let mut present: HashSet<String> = HashSet::new();
    let mut order: Vec<String> = Vec::new();
    for s in sessions {
        let Some(id) = s.get("id").and_then(safe_id) else { continue };
        let id = id.to_string();
        present.insert(id.clone());
        order.push(id.clone());
        let unloaded = s.get("unloaded").and_then(Value::as_bool).unwrap_or(false);
        if unloaded {
            // 마커가 지난번과 그대로면 파일도 그대로다 — 병합·직렬화 자체를 생략
            let mut marker = s.as_object().cloned().unwrap_or_default();
            marker.shift_remove("unloaded");
            let marker_json = serde_json::to_string(&Value::Object(marker)).unwrap_or_default();
            let same = with_map(&META, |m| m.get(&id).map(|v| v == &marker_json).unwrap_or(false))
                && with_map(&CACHE, |c| c.contains_key(&id));
            if same {
                continue;
            }
            let Ok(text) = serde_json::to_string(&with_stored_panels(&id, s)) else { continue };
            let changed = with_map(&CACHE, |c| c.get(&id).map(|v| v != &text).unwrap_or(true));
            if changed && crate::write_atomic(&session_file(&id), &text).is_ok() {
                with_map(&CACHE, |c| c.insert(id.clone(), text));
            }
            with_map(&META, |m| m.insert(id.clone(), marker_json));
        } else {
            let Ok(text) = serde_json::to_string(s) else { continue };
            let changed = with_map(&CACHE, |c| c.get(&id).map(|v| v != &text).unwrap_or(true));
            if changed && crate::write_atomic(&session_file(&id), &text).is_ok() {
                with_map(&CACHE, |c| c.insert(id.clone(), text));
            }
            // 전체 저장이 왔다 — 다음 마커는 병합을 다시 계산한다
            with_map(&META, |m| m.remove(&id));
        }
    }
    if let Ok(entries) = std::fs::read_dir(ma_dir()) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.ends_with(".json") || name == "index.json" {
                continue;
            }
            let id = name.trim_end_matches(".json").to_string();
            if !present.contains(&id) {
                let _ = std::fs::remove_file(e.path());
                with_map(&CACHE, |c| c.remove(&id));
                with_map(&META, |m| m.remove(&id));
            }
        }
    }
    let index = json!({
        "version": version_or_1(data),
        "activeSessionId": data.get("activeSessionId").and_then(Value::as_str).unwrap_or(""),
        "order": order
    });
    if let Ok(text) = serde_json::to_string(&index) {
        let unchanged = {
            let guard = INDEX_CACHE.lock().unwrap_or_else(|e| e.into_inner());
            guard.as_deref() == Some(text.as_str())
        };
        if !unchanged && crate::write_atomic(&index_path(), &text).is_ok() {
            *INDEX_CACHE.lock().unwrap_or_else(|e| e.into_inner()) = Some(text);
        }
    }
}
