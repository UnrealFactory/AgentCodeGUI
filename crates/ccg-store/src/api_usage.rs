//! `api-usage.jsonl` — API 모드 실행 원장(설정 → API 통계의 원본).
//! 원본: src/main/apiUsage.ts. 규칙 셋을 그대로 옮겼다:
//!  - 실행 1건 = 한 줄 append
//!  - 읽기는 최근 `MAX_RECORDS`건, **손상된 줄은 건너뛴다**(`ts`가 숫자인 것만 채택)
//!  - 8MB를 넘으면 **뒤쪽 절반만 남긴다**(append-only가 영영 자라는 것 차단).
//!    잘린 첫 줄은 읽기의 손상 줄 스킵이 걸러 준다.

use serde_json::Value;
use std::io::Write;

const FILE: &str = "api-usage.jsonl";
const MAX_RECORDS: usize = 20_000;
const ROTATE_BYTES: u64 = 8 * 1024 * 1024;

fn path() -> std::path::PathBuf {
    crate::app_home().join(FILE)
}

pub fn record(rec: &Value) {
    let home = crate::app_home();
    if std::fs::create_dir_all(&home).is_err() {
        return;
    }
    let p = path();
    if std::fs::metadata(&p).map(|m| m.len() > ROTATE_BYTES).unwrap_or(false) {
        if let Ok(all) = std::fs::read_to_string(&p) {
            let keep = (ROTATE_BYTES / 2) as usize;
            let start = all.len().saturating_sub(keep);
            // 문자 경계로 자른다(UTF-8 중간에서 자르면 파일이 깨진다)
            let start = (start..all.len()).find(|i| all.is_char_boundary(*i)).unwrap_or(all.len());
            let tail = &all[start..];
            let tail = match tail.find('\n') {
                Some(i) => &tail[i + 1..],
                None => tail,
            };
            let _ = crate::write_atomic(&p, tail);
        }
    }
    let Ok(line) = serde_json::to_string(rec) else { return };
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let _ = writeln!(f, "{line}");
    }
}

/// 원장 전체(최근 `MAX_RECORDS`건).
pub fn list() -> Value {
    let Ok(text) = std::fs::read_to_string(path()) else { return Value::Array(vec![]) };
    let mut out: Vec<Value> = Vec::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if v.get("ts").is_some_and(Value::is_number) {
            out.push(v);
        }
    }
    if out.len() > MAX_RECORDS {
        out.drain(..out.len() - MAX_RECORDS);
    }
    Value::Array(out)
}
