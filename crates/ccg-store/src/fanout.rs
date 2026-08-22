//! 팬아웃 스토어 공통부 — `<dir>/index.json` + `<dir>/<id>.json`.
//!
//! chats.rs(2.6.2 미러)가 손으로 쓰던 규약을 그대로 일반화했다:
//!  - 항목별 파일 + 인덱스(버전·순서·활성)
//!  - **내용 문자열 비교로 바뀐 파일만 쓰기**(저장 비용이 항목 수에 비례하지 않게)
//!  - 목록에서 사라진 항목의 파일 prune
//!  - 원자 저장(`write_atomic`)
//!
//! **chats.rs / ma.rs는 이 모듈로 갈아끼우지 않는다.** 그 둘은 2.6.2 홈과 바이트 호환이
//! 계약이라 얼려 둔다(플래그 기본값 경로). 여기는 chats-v3 / boards 전용이다.

use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;

/// id 문자 집합 — uuid / `ma-<sid>-<i>` / `sc-<uuid>` / `chat-<n>-<base36>`.
/// 그 밖은 거부한다(경로 탈출 방지). 2.6.2 `safeId`와 같은 정규식.
pub fn safe_id_str(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

pub fn safe_id(v: &Value) -> Option<&str> {
    let s = v.as_str()?;
    if safe_id_str(s) {
        Some(s)
    } else {
        None
    }
}

/// `blob.version ?? 1` — null/부재 모두 1로(JS의 nullish 병합과 같게).
pub fn version_or_1(v: &Value) -> Value {
    match v.get("version") {
        Some(Value::Null) | None => json!(1),
        Some(other) => other.clone(),
    }
}

pub struct Fanout {
    dir: &'static str,
    /// id → 마지막으로 디스크에 쓴 JSON 문자열(= 다음 저장의 비교 기준)
    cache: Mutex<Option<HashMap<String, String>>>,
    /// 마지막으로 쓴 index.json — 안 바뀌었으면 파일을 건드리지 않는다
    index_cache: Mutex<Option<String>>,
    /// prune이 절대 건드리면 안 되는 파일 이름(인덱스·Rust 전용 사이드카)
    reserved: &'static [&'static str],
}

impl Fanout {
    pub const fn new(dir: &'static str, reserved: &'static [&'static str]) -> Self {
        Self { dir, cache: Mutex::new(None), index_cache: Mutex::new(None), reserved }
    }

    pub fn dir_path(&self) -> PathBuf {
        crate::app_home().join(self.dir)
    }
    pub fn index_path(&self) -> PathBuf {
        self.dir_path().join("index.json")
    }
    pub fn file(&self, id: &str) -> PathBuf {
        self.dir_path().join(format!("{id}.json"))
    }

    fn with_cache<R>(&self, f: impl FnOnce(&mut HashMap<String, String>) -> R) -> R {
        let mut guard = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        f(guard.get_or_insert_with(HashMap::new))
    }

    /// 캐시를 통째로 버린다 — 마이그레이션처럼 파일을 밖에서 갈아치운 뒤 부른다.
    /// (안 부르면 다음 저장이 "안 바뀌었다"로 오판해 새 파일을 안 쓴다)
    pub fn invalidate(&self) {
        *self.cache.lock().unwrap_or_else(|e| e.into_inner()) = None;
        *self.index_cache.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    /// 인덱스 캐시만 버린다 — 인덱스를 팬아웃 밖에서 고쳐 쓴 뒤(예: `chats:set-active`)
    /// 다음 저장이 "안 바뀌었다"로 판정해 옛 값을 남기지 않게.
    pub fn invalidate_index_only(&self) {
        *self.index_cache.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    pub fn read_index(&self) -> Option<Value> {
        std::fs::read_to_string(self.index_path())
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
    }

    /// 인덱스가 나열하는 순서대로 항목 파일을 읽어 온다(+캐시 재장전).
    /// 인덱스가 없으면 None — **비어 있어도 Some(빈 벡터)** 다(지운 항목의 부활 방지).
    pub fn read_all(&self) -> Option<(Value, Vec<Value>)> {
        let index = self.read_index()?;
        let empty = vec![];
        let order = index.get("order").and_then(Value::as_array).unwrap_or(&empty);
        let mut items: Vec<Value> = Vec::with_capacity(order.len());
        self.with_cache(|cache| {
            cache.clear();
            for id in order {
                let Some(id) = safe_id(id) else { continue };
                // 파일이 없거나 깨졌으면 그 항목만 건너뛴다(2.6.2와 같은 관용)
                let Ok(raw) = std::fs::read_to_string(self.file(id)) else { continue };
                let Ok(parsed) = serde_json::from_str::<Value>(&raw) else { continue };
                cache.insert(id.to_string(), raw);
                items.push(parsed);
            }
        });
        Some((index, items))
    }

    /// 항목 하나 — 캐시 우선, 없으면 디스크.
    pub fn read_one(&self, id: &str) -> Value {
        if !safe_id_str(id) {
            return Value::Null;
        }
        match self.stored(id) {
            Some(v) => v,
            None => Value::Null,
        }
    }

    /// 디스크(또는 캐시)에 지금 저장돼 있는 항목. 저장 시 되끼움의 원본.
    pub fn stored(&self, id: &str) -> Option<Value> {
        let cached = self.with_cache(|c| c.get(id).cloned());
        let raw = match cached {
            Some(r) => r,
            None => std::fs::read_to_string(self.file(id)).ok()?,
        };
        serde_json::from_str(&raw).ok()
    }

    /// 항목 하나를 (밖에서) 강제로 저장한다 — Rust 소유 필드 갱신 경로.
    pub fn write_one(&self, id: &str, item: &Value) -> bool {
        if !safe_id_str(id) || std::fs::create_dir_all(self.dir_path()).is_err() {
            return false;
        }
        let Ok(text) = serde_json::to_string(item) else { return false };
        let changed = self.with_cache(|c| c.get(id).map(|s| s != &text).unwrap_or(true));
        if !changed {
            return true;
        }
        if crate::write_atomic(&self.file(id), &text).is_ok() {
            self.with_cache(|c| c.insert(id.to_string(), text));
            true
        } else {
            false
        }
    }

    /// 블롭 하나를 항목별 파일로 저장한다. `transform`은 저장 직전 훅 —
    /// unloaded 마커 병합·Rust 소유 필드 되끼움이 거기서 일어난다.
    ///
    /// 반환값 = index.json에 실린 순서(호출자가 리포트/검증에 쓴다).
    pub fn write_all<F>(&self, items: &[Value], index_extra: &Map<String, Value>, transform: F) -> Vec<String>
    where
        F: Fn(&str, &Value) -> Value,
    {
        let mut order: Vec<String> = Vec::with_capacity(items.len());
        if std::fs::create_dir_all(self.dir_path()).is_err() {
            return order; // 최선 노력 — 쓰기 실패는 "이번 턴이 저장되지 않음"일 뿐
        }
        let mut present: HashSet<String> = HashSet::new();
        for item in items {
            let Some(id) = item.get("id").and_then(safe_id) else { continue };
            let id = id.to_string();
            present.insert(id.clone());
            order.push(id.clone());
            let merged = transform(&id, item);
            let Ok(text) = serde_json::to_string(&merged) else { continue };
            let changed = self.with_cache(|c| c.get(&id).map(|s| s != &text).unwrap_or(true));
            if changed && crate::write_atomic(&self.file(&id), &text).is_ok() {
                self.with_cache(|c| c.insert(id.clone(), text));
            }
        }
        // 목록에서 사라진 항목의 파일 정리
        if let Ok(entries) = std::fs::read_dir(self.dir_path()) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if !name.ends_with(".json") || self.reserved.contains(&name.as_str()) {
                    continue;
                }
                let id = name.trim_end_matches(".json").to_string();
                if !present.contains(&id) {
                    let _ = std::fs::remove_file(e.path());
                    self.with_cache(|c| c.remove(&id));
                }
            }
        }
        // index.json — 순서·활성 + 호출자가 얹는 필드(migratedFrom/At 등)
        let mut index = Map::new();
        index.insert("version".into(), index_extra.get("version").cloned().unwrap_or(json!(1)));
        index.insert("order".into(), json!(order));
        for (k, v) in index_extra {
            if k != "version" {
                index.insert(k.clone(), v.clone());
            }
        }
        if let Ok(text) = serde_json::to_string(&Value::Object(index)) {
            let unchanged = {
                let guard = self.index_cache.lock().unwrap_or_else(|e| e.into_inner());
                guard.as_deref() == Some(text.as_str())
            };
            if !unchanged && crate::write_atomic(&self.index_path(), &text).is_ok() {
                *self.index_cache.lock().unwrap_or_else(|e| e.into_inner()) = Some(text);
            }
        }
        order
    }
}
