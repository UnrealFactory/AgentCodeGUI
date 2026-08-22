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

/// ★R2(D14) — **손상된 ui-prefs에서 온전한 상위 쌍까지 건져 읽는다.**
///
/// 마이그레이션의 물질화(전 채팅의 `billing`·`outputStyle`)는 되돌리기 어려운 1회성
/// 결정이다. R1은 파싱 실패를 "없음"과 구별하지 않아, 꼬리가 잘린 홈에서 `api.mode:true`
/// 사용자의 **전 채팅이 `subscription`으로 굳었다**(크리틱 공격 14 = 조용한 값 뒤집기).
///
/// 규칙은 단순하다: 통째로 파싱되면 그대로, 안 되면 **마지막 온전한 상위 쌍**까지 자르고
/// 닫아서 다시 파싱한다. 값을 지어내지 않고(§5.2 "조용한 값 보정 금지") 무엇을 건졌는지
/// 호출자에게 돌려준다 → 마이그레이션 리포트의 `warnings`로 나간다.
///
/// 반환: `(prefs, 손상 표식)`. 표식이 `Some`이면 파일이 깨진 것이다.
pub fn read_ui_prefs_salvaged() -> (Value, Option<Value>) {
    let path = crate::app_home().join(UI_PREFS);
    let Ok(raw) = std::fs::read_to_string(&path) else { return (Value::Object(Map::new()), None) };
    if let Some(v @ Value::Object(_)) = crate::parse_json_source(&raw) {
        return (v, None);
    }
    match salvage_object(&raw) {
        Some(v) => {
            let keys: Vec<String> = v.as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default();
            (v, Some(json!({ "salvaged": true, "keys": keys, "bytes": raw.len() })))
        }
        None => (Value::Object(Map::new()), Some(json!({ "salvaged": false, "bytes": raw.len() }))),
    }
}

/// 잘린 JSON 객체에서 **마지막으로 온전히 끝난 상위 키/값 쌍**까지만 건진다.
/// 문자열·이스케이프를 인식하며 깊이 1에서 만난 콤마 위치를 기억했다가 거기서 닫는다.
fn salvage_object(raw: &str) -> Option<Value> {
    let bytes = raw.as_bytes();
    let mut depth = 0i32;
    let mut in_str = false;
    let mut esc = false;
    let mut cut: Option<usize> = None;
    let mut started = false;
    for (i, &c) in bytes.iter().enumerate() {
        if in_str {
            if esc {
                esc = false;
            } else if c == b'\\' {
                esc = true;
            } else if c == b'"' {
                in_str = false;
            }
            continue;
        }
        match c {
            b'"' => in_str = true,
            b'{' | b'[' => {
                if !started && c == b'{' {
                    started = true;
                }
                depth += 1;
            }
            b'}' | b']' => depth -= 1,
            b',' if depth == 1 => cut = Some(i),
            _ => {}
        }
    }
    if !started {
        return None;
    }
    let mut patched = String::with_capacity(raw.len() + 1);
    patched.push_str(&raw[..cut?]);
    patched.push('}');
    match crate::parse_json_source(&patched) {
        Some(v @ Value::Object(_)) => Some(v),
        _ => None,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn salvage_keeps_complete_pairs_and_invents_nothing() {
        let good = r#"{"workspace.mode":"multi","api.mode":true,"claude.outputStyle":"Explanatory"}"#;
        let v = salvage_object(&good[..good.len() - 3]).expect("꼬리 잘림은 건져야 한다");
        assert_eq!(v["api.mode"], true);
        assert_eq!(v["workspace.mode"], "multi");
        assert!(v.get("claude.outputStyle").is_none(), "반쪽 값을 지어내면 안 된다");
    }

    #[test]
    fn salvage_gives_up_when_not_even_one_pair_is_complete() {
        assert!(salvage_object(r#"{"api.mode": tru"#).is_none());
        assert!(salvage_object("{{{").is_none());
        assert!(salvage_object("[1,2,3]").is_none());
    }

    #[test]
    fn a_comma_inside_a_string_or_a_nested_object_is_not_a_cut_point() {
        let raw = r#"{"a":{"x":1,"y":2},"b":"콤마, 안에","c":3"#;
        let v = salvage_object(raw).unwrap();
        assert_eq!(v["a"]["y"], 2);
        assert_eq!(v["b"], "콤마, 안에");
        assert!(v.get("c").is_none());
    }
}
