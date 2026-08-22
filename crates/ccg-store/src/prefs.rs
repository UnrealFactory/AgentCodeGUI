//! 렌더러 소유 UI 설정(ui-prefs.json)과 로컬 프로필(profile.json).
//! 원본: src/main/uiPrefs.ts · src/main/profile.ts (포맷·기본값 그대로).

use serde_json::{json, Map, Value};

const UI_PREFS: &str = "ui-prefs.json";
const PROFILE: &str = "profile.json";

/// 저장된 UI prefs 블롭. 없거나 못 읽으면 빈 객체(2.6.2와 같다).
pub fn read_ui_prefs() -> Value {
    match crate::read_home_json(UI_PREFS) {
        Some(v @ Value::Object(_)) => v,
        _ => Value::Object(Map::new()),
    }
}

/// 블롭 통째로 저장. 렌더러가 권위 사본을 들고 전체를 되보낸다(2.6.2 규약).
pub fn write_ui_prefs(prefs: &Value) -> std::io::Result<()> {
    let v = if prefs.is_object() { prefs.clone() } else { Value::Object(Map::new()) };
    // JSON.stringify(prefs, null, 2)와 같은 모양(2칸 들여쓰기)
    let text = serde_json::to_string_pretty(&v).unwrap_or_else(|_| "{}".into());
    crate::write_home_file(UI_PREFS, &text)
}

/// 저장된 프로필. 닉네임/색이 비어 있으면 "없음"으로 친다(2.6.2 readProfile과 동일).
pub fn read_profile() -> Option<Value> {
    let v = crate::read_home_json(PROFILE)?;
    let nickname = v.get("nickname").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let color = v.get("color").and_then(Value::as_str).unwrap_or("").to_string();
    if nickname.is_empty() || color.is_empty() {
        return None;
    }
    Some(json!({ "nickname": nickname, "color": color }))
}

pub fn write_profile(profile: &Value) -> std::io::Result<()> {
    let nickname = profile.get("nickname").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let color = profile.get("color").and_then(Value::as_str).unwrap_or("").to_string();
    let text = serde_json::to_string_pretty(&json!({ "nickname": nickname, "color": color }))
        .unwrap_or_else(|_| "{}".into());
    crate::write_home_file(PROFILE, &text)
}
