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
//!
//! ## ★R2 인덱스 불신 규약 (크리틱 D2 — "index 한 바이트가 전 대화를 지운다")
//! chats-v3는 세 스토어의 **유일 사본**이다. 그래서 `index.json`이 판독 불가일 때
//! 2.6.2식 "인덱스가 목록이다"를 그대로 쓰면 조회가 전멸하고, 뒤이은 저장 한 번의
//! prune이 남은 파일을 전부 지운다. 규약을 둘로 나눈다:
//!
//! 1. **읽기** — 인덱스가 안 읽히면 **디렉터리를 훑는다**(파일이 진실). 순서는 파일 이름.
//! 2. **prune** — 인덱스를 **완전히 판독했을 때만** 돈다(`index_trusted()`).
//!    목록을 못 믿는 상태에서 "목록에 없다"는 삭제 근거가 될 수 없다.

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

    /// 항목 하나의 캐시만 버린다 — 파일을 지웠을 때(같은 id가 다시 생기면 캐시가
    /// "안 바뀌었다"로 오판해 파일을 다시 안 쓴다).
    pub fn forget_one(&self, id: &str) {
        self.with_cache(|c| {
            c.remove(id);
        });
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

    /// 이 디렉터리에 실제로 있는 항목 파일 id(예약 이름·안전하지 않은 이름 제외, 이름순).
    pub fn scan_ids(&self) -> Vec<String> {
        let Ok(entries) = std::fs::read_dir(self.dir_path()) else { return vec![] };
        let mut ids: Vec<String> = entries
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                if !name.ends_with(".json") || self.reserved.contains(&name.as_str()) {
                    return None;
                }
                let id = name.trim_end_matches(".json").to_string();
                if safe_id_str(&id) && e.path().is_file() {
                    Some(id)
                } else {
                    None
                }
            })
            .collect();
        ids.sort();
        ids
    }

    /// **인덱스를 완전히 판독했는가** — prune을 돌려도 되는 유일한 조건(D2).
    /// 파일이 없어서 못 읽은 경우: 항목 파일도 없으면(=빈 스토어) 신뢰, 있으면 불신.
    pub fn index_trusted(&self) -> bool {
        match std::fs::read_to_string(self.index_path()) {
            Ok(raw) => serde_json::from_str::<Value>(&raw).is_ok(),
            Err(_) => self.scan_ids().is_empty(),
        }
    }

    /// 인덱스가 나열하는 순서대로 항목 파일을 읽어 온다(+캐시 재장전).
    ///
    /// **인덱스를 못 읽으면 디렉터리를 훑는다**(D2 — 파일이 진실). 그 경우 순서는 파일
    /// 이름순이고 `activeChatId` 등 인덱스에만 있던 값은 비어 있다. 인덱스도 없고 항목
    /// 파일도 없으면 None(스토어 자체가 없음 — 지운 항목의 부활 방지).
    pub fn read_all(&self) -> Option<(Value, Vec<Value>)> {
        let (index, order) = match self.read_index() {
            Some(index) => {
                let ids: Vec<String> = index
                    .get("order")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(safe_id).map(str::to_string).collect())
                    .unwrap_or_default();
                (index, ids)
            }
            None => {
                let ids = self.scan_ids();
                if ids.is_empty() && !self.dir_path().is_dir() {
                    return None;
                }
                (json!({ "version": 1, "order": ids.clone(), "rebuiltFromDir": true }), ids)
            }
        };
        let mut items: Vec<Value> = Vec::with_capacity(order.len());
        self.with_cache(|cache| {
            cache.clear();
            for id in &order {
                // 파일이 없거나 깨졌으면 그 항목만 건너뛴다(2.6.2와 같은 관용)
                let Ok(raw) = std::fs::read_to_string(self.file(id)) else { continue };
                let Ok(parsed) = serde_json::from_str::<Value>(&raw) else { continue };
                cache.insert(id.clone(), raw);
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
        // ★ prune 허용 여부는 **쓰기 전에** 본다(우리가 쓴 새 인덱스가 아니라 옛 인덱스 기준).
        let prune_ok = self.index_trusted();
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
        // 목록에서 사라진 항목의 파일 정리 — **인덱스를 신뢰할 수 있을 때만**(D2).
        // 인덱스가 깨진 상태에서는 "목록에 없다"가 곧 "지웠다"가 아니다. 대신 목록에서
        // 빠진 파일을 order 꼬리에 실어 인덱스를 복구한다(유일 사본을 지우지 않는다).
        if prune_ok {
            for id in self.scan_ids() {
                if !present.contains(&id) {
                    let _ = std::fs::remove_file(self.file(&id));
                    self.with_cache(|c| c.remove(&id));
                }
            }
        } else {
            for id in self.scan_ids() {
                if present.insert(id.clone()) {
                    order.push(id);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::temp_home;

    static T: Fanout = Fanout::new("t-store", &["index.json"]);

    fn seed(h: &crate::testkit::Home, ids: &[&str]) {
        for id in ids {
            h.write(&format!("t-store/{id}.json"), &json!({ "id": id, "n": 1 }).to_string());
        }
        h.write(
            "t-store/index.json",
            &json!({ "version": 1, "order": ids }).to_string(),
        );
        T.invalidate();
    }

    #[test]
    fn a_broken_index_falls_back_to_the_directory_instead_of_erasing_the_store() {
        let h = temp_home("fanout-broken");
        seed(&h, &["a", "b", "c"]);
        h.write("t-store/index.json", "{\"version\":1,\"order\":[\"a\"");
        T.invalidate();
        assert!(!T.index_trusted(), "깨진 인덱스는 신뢰 대상이 아니다");
        let (_, items) = T.read_all().expect("디렉터리로 되살아나야 한다");
        assert_eq!(items.len(), 3, "파일이 진실 — 인덱스가 깨져도 3건 다 읽힌다");
    }

    #[test]
    fn prune_never_runs_while_the_index_is_unreadable() {
        let h = temp_home("fanout-prune-gate");
        seed(&h, &["a", "b", "c"]);
        h.write("t-store/index.json", "쓰레기");
        T.invalidate();
        // 목록에 하나만 실어 저장 — 인덱스를 못 믿으니 나머지를 지우면 안 된다
        let order = T.write_all(&[json!({ "id": "a" })], &Map::new(), |_, v| v.clone());
        let files = h.files("t-store");
        assert!(files.contains(&"b.json".to_string()) && files.contains(&"c.json".to_string()), "유일 사본을 지웠다: {files:?}");
        assert_eq!(order.len(), 3, "빠진 파일을 order 꼬리에 실어 인덱스를 복구한다");
        assert!(T.index_trusted(), "복구된 인덱스는 다시 신뢰 대상");
    }

    #[test]
    fn prune_removes_exactly_what_a_trusted_list_dropped() {
        let h = temp_home("fanout-prune-ok");
        seed(&h, &["a", "b", "c"]);
        T.write_all(&[json!({ "id": "a" }), json!({ "id": "c" })], &Map::new(), |_, v| v.clone());
        assert_eq!(h.files("t-store"), vec!["a.json", "c.json", "index.json"]);
    }

    #[test]
    fn ids_outside_the_safe_charset_never_reach_the_filesystem() {
        let h = temp_home("fanout-escape");
        std::fs::create_dir_all(h.path("t-store")).unwrap();
        T.invalidate();
        T.write_all(&[json!({ "id": "..\\..\\evil" }), json!({ "id": "ok" })], &Map::new(), |_, v| v.clone());
        assert!(!h.dir.parent().unwrap().join("evil.json").exists());
        assert_eq!(h.files("t-store"), vec!["index.json", "ok.json"]);
    }
}
