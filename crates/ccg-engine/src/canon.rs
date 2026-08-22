//! 정준 직렬화 + 안정 해시.
//!
//! `RunIdentity::hash()`는 **프로세스 간·릴리즈 간**에 같아야 한다(저장된 큐 항목·리비전이
//! 그 값을 키로 들고 있다). 그래서 `#[derive(Hash)]`(DefaultHasher = 릴리즈마다 달라질 수 있음)를
//! 쓰지 않고 **정준 직렬화 → 암호 해시 앞 16바이트**로 만든다.
//!
//! 설계 §2.2는 `canonical CBOR → blake3`라고 적었다. 이 환경(오프라인 빌드)의 레지스트리
//! 캐시에 blake3도 CBOR 크레이트도 없어 **정준 JSON → sha256[..16]**으로 구현했다.
//! 요구 성질(결정적·키 순서 무관·릴리즈 간 안정)은 동일하고, 교체가 필요하면 이 파일만 고친다.
//! 골든 테스트(`identity_hash_is_stable_across_releases`)가 값을 고정한다.

use serde_json::Value;
use sha2::{Digest, Sha256};

/// 정준 JSON: 객체 키를 사전순 정렬 + 공백 없음 + 부동소수 없음(우리 값은 전부 문자열/불리언/배열/객체).
/// serde_json은 `preserve_order` 피처가 켜져 있어 **삽입 순서**를 지키므로, 정렬은 여기서 명시적으로 한다.
pub fn canon_json(v: &Value) -> String {
    let mut s = String::new();
    write_canon(v, &mut s);
    s
}

fn write_canon(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&n.to_string()),
        Value::String(s) => out.push_str(&Value::String(s.clone()).to_string()),
        Value::Array(a) => {
            out.push('[');
            for (i, e) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canon(e, out);
            }
            out.push(']');
        }
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String((*k).clone()).to_string());
                out.push(':');
                write_canon(&m[*k], out);
            }
            out.push('}');
        }
    }
}

/// 정준 직렬화 → sha256 → 앞 16바이트 hex(32자). 정체성 해시·마이그레이션 1차 비교 키.
pub fn stable_hash16(v: &Value) -> String {
    hex16(Sha256::digest(canon_json(v).as_bytes()).as_slice())
}

/// 비밀값 지문 8바이트 hex(16자) — API 키 원문은 절대 계약면에 오르지 않는다(§2.3).
pub fn fingerprint8(secret: &str) -> String {
    let d = Sha256::digest(secret.as_bytes());
    d[..8].iter().map(|b| format!("{b:02x}")).collect()
}

fn hex16(bytes: &[u8]) -> String {
    bytes[..16].iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn canon_is_key_order_independent() {
        let a = json!({ "b": 1, "a": { "y": [1, 2], "x": "s" } });
        let b = json!({ "a": { "x": "s", "y": [1, 2] }, "b": 1 });
        assert_eq!(canon_json(&a), canon_json(&b));
        assert_eq!(canon_json(&a), r#"{"a":{"x":"s","y":[1,2]},"b":1}"#);
        assert_eq!(stable_hash16(&a), stable_hash16(&b));
    }

    #[test]
    fn hash_is_16_bytes_hex() {
        assert_eq!(stable_hash16(&json!({})).len(), 32);
    }
}
