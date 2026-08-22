//! 창 위치·크기·최대화 기억 (window-state.json).
//! 원본: src/main/index.ts의 loadWindowState/saveWindowState — 같은 파일, 같은 키 순서,
//! 같은 클램프(최소 940×600 = 메인 창 minWidth/minHeight), 같은 기본값(1320×880).
//!
//! 좌표는 **정수**로 다룬다: Electron의 bounds가 정수라 2.6.2가 저장한 파일이
//! `{"x":628,...}` 꼴이다. f64로 담으면 `628.0`으로 되쓰여 포맷 호환이 깨진다.

use serde::{Deserialize, Serialize};

const FILE: &str = "window-state.json";

pub const MIN_W: i64 = 940;
pub const MIN_H: i64 = 600;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WinState {
    // 키 순서도 2.6.2가 쓰던 그대로 (x,y,width,height,maximized)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<i64>,
    pub width: i64,
    pub height: i64,
    pub maximized: bool,
}

impl Default for WinState {
    fn default() -> Self {
        Self { x: None, y: None, width: 1320, height: 880, maximized: false }
    }
}

fn num(v: &serde_json::Value, key: &str) -> Option<i64> {
    v.get(key).and_then(|n| n.as_f64()).map(|f| f.round() as i64)
}

/// 저장된 상태. width/height가 숫자가 아니면(=저장본 없음/깨짐) 기본값.
pub fn load() -> WinState {
    let Some(v) = crate::read_home_json(FILE) else { return WinState::default() };
    let (Some(w), Some(h)) = (num(&v, "width"), num(&v, "height")) else {
        return WinState::default();
    };
    WinState {
        x: num(&v, "x"),
        y: num(&v, "y"),
        width: w.max(MIN_W),
        height: h.max(MIN_H),
        maximized: v.get("maximized").and_then(|b| b.as_bool()).unwrap_or(false),
    }
}

/// 압축 JSON(=JSON.stringify(state))으로 원자 저장.
pub fn save(s: &WinState) -> std::io::Result<()> {
    let text = serde_json::to_string(s).unwrap_or_default();
    crate::write_home_file(FILE, &text)
}
