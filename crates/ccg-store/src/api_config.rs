//! `api-config.json` — API 키 과금 설정(키·예산·누적 사용액·env 키 확인 답).
//! 원본: src/main/apiConfig.ts. **키 원문은 이 모듈 밖(특히 렌더러)으로 나가지 않는다** —
//! 상태 조회는 존재 여부 + 끝 4자리뿐이고, 원문은 엔진(M3)이 스폰 직전 `api_key()`로 읽어
//! 하위 CLI의 env로만 주입한다.
//!
//! 저장 스킴은 2.6.2와 같다(`safe_storage` 참조) — 기존 사용자가 **키를 다시 넣지 않는다.**

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

const FILE: &str = "api-config.json";

fn read_config() -> Map<String, Value> {
    match crate::read_home_json(FILE) {
        Some(Value::Object(m)) => m,
        _ => Map::new(),
    }
}

fn write_config(cfg: &Map<String, Value>) {
    // 2.6.2와 같은 모양(2칸 들여쓰기) — 사람이 열어 보는 파일이다
    let text = serde_json::to_string_pretty(&Value::Object(cfg.clone())).unwrap_or_else(|_| "{}".into());
    let _ = crate::write_home_file(FILE, &text);
}

fn str_of(cfg: &Map<String, Value>, k: &str) -> Option<String> {
    cfg.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string)
}

/// 렌더러용 스냅샷(`ApiConfigStatus`) — 키 원문 대신 존재 여부 + 끝 4자리.
pub fn status() -> Value {
    let cfg = read_config();
    let has_key = str_of(&cfg, "key").is_some();
    let has_openai = str_of(&cfg, "openaiKey").is_some();
    json!({
        "hasKey": has_key,
        "keyTail": if has_key { cfg.get("keyTail").cloned().unwrap_or(Value::Null) } else { Value::Null },
        "budgetUsd": cfg.get("budgetUsd").filter(|v| v.is_number()).cloned().unwrap_or(Value::Null),
        "spentUsd": cfg.get("spentUsd").and_then(Value::as_f64).unwrap_or(0.0),
        "hasOpenaiKey": has_openai,
        "openaiKeyTail": if has_openai { cfg.get("openaiKeyTail").cloned().unwrap_or(Value::Null) } else { Value::Null },
    })
}

/// 키 저장 한 벌 — Anthropic(`key`)과 OpenAI(`openaiKey`)가 같은 절차를 쓴다.
fn set_key_inner(cfg: &mut Map<String, Value>, keys: (&str, &str, &str), trimmed: &str) {
    let (k, enc_k, tail_k) = keys;
    match crate::safe_storage::encrypt(trimmed) {
        Some(v) => {
            cfg.insert(k.into(), json!(v));
            cfg.insert(enc_k.into(), json!(true));
        }
        // 암호화를 못 쓰는 환경 — 평문(enc:false). 상태에 그대로 드러나므로 UI가 경고할 수 있다
        None => {
            cfg.insert(k.into(), json!(trimmed));
            cfg.insert(enc_k.into(), json!(false));
        }
    }
    let tail: String = trimmed.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
    cfg.insert(tail_k.into(), json!(tail));
}

fn get_key_inner(cfg: &Map<String, Value>, k: &str, enc_k: &str) -> Option<String> {
    let v = str_of(cfg, k)?;
    if !cfg.get(enc_k).and_then(Value::as_bool).unwrap_or(false) {
        return Some(v);
    }
    // 다른 OS 계정/머신에서 복사된 파일 등 — 복호화 불가면 키 없음으로 취급
    crate::safe_storage::decrypt(&v)
}

pub fn set_api_key(key: &str) {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return;
    }
    let mut cfg = read_config();
    set_key_inner(&mut cfg, ("key", "enc", "keyTail"), trimmed);
    write_config(&cfg);
}

pub fn clear_api_key() {
    let mut cfg = read_config();
    for k in ["key", "enc", "keyTail"] {
        cfg.shift_remove(k);
    }
    write_config(&cfg);
}

/// 저장된 API 키 원문(없거나 복호 실패 시 None). 엔진의 env 주입 전용.
pub fn api_key() -> Option<String> {
    get_key_inner(&read_config(), "key", "enc")
}

pub fn set_openai_api_key(key: &str) {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return;
    }
    let mut cfg = read_config();
    set_key_inner(&mut cfg, ("openaiKey", "openaiEnc", "openaiKeyTail"), trimmed);
    write_config(&cfg);
}

pub fn clear_openai_api_key() {
    let mut cfg = read_config();
    for k in ["openaiKey", "openaiEnc", "openaiKeyTail"] {
        cfg.shift_remove(k);
    }
    write_config(&cfg);
}

pub fn openai_api_key() -> Option<String> {
    get_key_inner(&read_config(), "openaiKey", "openaiEnc")
}

/// 전역 `ANTHROPIC_API_KEY` 확인 카드의 답 — **키 지문(sha256 앞 12자)별**로 저장된다.
/// 키가 바뀌면 지문이 달라져 자연히 다시 묻는다(키 원문은 저장하지 않는다).
fn env_key_fp(key: &str) -> String {
    let mut h = Sha256::new();
    h.update(key.as_bytes());
    let d = h.finalize();
    d.iter().map(|b| format!("{b:02x}")).collect::<String>()[..12].to_string()
}

/// `'api'`(이 키로 과금 계속) | `'sub'`(키를 걷어내고 구독) | None(아직 안 물었다).
pub fn env_key_choice(key: &str) -> Option<String> {
    read_config()
        .get("envKeyChoices")
        .and_then(|v| v.get(env_key_fp(key)))
        .and_then(Value::as_str)
        .filter(|v| *v == "api" || *v == "sub")
        .map(str::to_string)
}

pub fn set_env_key_choice(key: &str, choice: &str) {
    if choice != "api" && choice != "sub" {
        return;
    }
    let mut cfg = read_config();
    let mut m = cfg.get("envKeyChoices").and_then(Value::as_object).cloned().unwrap_or_default();
    m.insert(env_key_fp(key), json!(choice));
    cfg.insert("envKeyChoices".into(), Value::Object(m));
    write_config(&cfg);
}

pub fn set_budget(usd: Option<f64>) {
    let mut cfg = read_config();
    let v = usd.filter(|u| u.is_finite() && *u > 0.0);
    cfg.insert("budgetUsd".into(), v.map(|u| json!(u)).unwrap_or(Value::Null));
    write_config(&cfg);
}

/// API 모드 실행이 끝날 때마다 그 실행의 `total_cost_usd`를 누적한다(Anthropic 전용).
pub fn add_spend(usd: f64) {
    if !(usd.is_finite() && usd > 0.0) {
        return;
    }
    let mut cfg = read_config();
    let cur = cfg.get("spentUsd").and_then(Value::as_f64).unwrap_or(0.0);
    cfg.insert("spentUsd".into(), json!(cur + usd));
    write_config(&cfg);
}

pub fn reset_budget() {
    let mut cfg = read_config();
    cfg.insert("budgetUsd".into(), Value::Null);
    cfg.insert("spentUsd".into(), json!(0.0));
    write_config(&cfg);
}

#[cfg(test)]
mod tests {
    #[test]
    fn env_key_fingerprint_matches_the_2_6_2_recipe() {
        // node: createHash('sha256').update('abc').digest('hex').slice(0,12)
        assert_eq!(super::env_key_fp("abc"), "ba7816bf8f01");
    }
}
