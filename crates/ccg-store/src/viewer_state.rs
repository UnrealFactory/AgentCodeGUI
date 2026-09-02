//! 파일 뷰어 **독립 창**의 자리 기억 (viewer-window.json).
//!
//! 메인 창의 `window_state.rs`와 같은 규약(정수 좌표·원자 저장·최소 크기 클램프)에
//! **모드 한 칸**(`window`)이 더 있다: 사용자가 「별도 창으로」를 한 번 누르면 이후의
//! 모든 파일 열기가 그 창으로 가고(끈적한 모드), 「창 안으로」를 누를 때까지 유지된다.
//! 창의 위치·크기는 파일을 닫아도(창을 숨겨도)·앱을 껐다 켜도 그대로다 — "다음 파일을
//! 열 때도 거기 그 자리"가 이 파일의 존재 이유다(듀얼 모니터: 한쪽은 IDE, 한쪽은 뷰어).
//!
//! 파일 모양(키 순서까지 고정): `{"window":true,"x":..,"y":..,"width":..,"height":..,"maximized":false}`

use serde::{Deserialize, Serialize};

use crate::window_state::WinState;

const FILE: &str = "viewer-window.json";

/// 뷰어 창의 최소 크기 — 카드 뷰어의 최소(`resizableModal.tsx` MIN_W 520·MIN_H 300)보다
/// 살짝 크다: 헤더의 창 컨트롤 넷(창 안으로·최소·최대·닫기)까지 한 줄에 앉아야 한다.
pub const MIN_W: i64 = 560;
pub const MIN_H: i64 = 400;

/// 처음 열 때의 크기 — 카드 뷰어의 기본 폭(`styles.css` `.fv-modal` 1140px)과 같다.
pub const DEFAULT_W: i64 = 1140;
pub const DEFAULT_H: i64 = 820;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ViewerState {
    /// 끈적한 모드 — true면 파일 열기가 전부 독립 창으로 간다.
    pub window: bool,
    #[serde(flatten)]
    pub win: WinState,
}

impl Default for ViewerState {
    fn default() -> Self {
        Self {
            window: false,
            win: WinState { x: None, y: None, width: DEFAULT_W, height: DEFAULT_H, maximized: false },
        }
    }
}

fn num(v: &serde_json::Value, key: &str) -> Option<i64> {
    v.get(key).and_then(|n| n.as_f64()).map(|f| f.round() as i64)
}

/// 저장된 상태. 파일이 없거나 깨졌으면 기본값(카드 모드·기본 크기·위치 없음).
/// 크기만 깨졌으면 모드는 살리고 크기는 기본값으로 — 모드 한 비트를 잃는 것이 더 아프다.
pub fn load() -> ViewerState {
    let Some(v) = crate::read_home_json(FILE) else { return ViewerState::default() };
    let mut st = ViewerState::default();
    st.window = v.get("window").and_then(|b| b.as_bool()).unwrap_or(false);
    if let (Some(w), Some(h)) = (num(&v, "width"), num(&v, "height")) {
        st.win.width = w.max(MIN_W);
        st.win.height = h.max(MIN_H);
        st.win.x = num(&v, "x");
        st.win.y = num(&v, "y");
        st.win.maximized = v.get("maximized").and_then(|b| b.as_bool()).unwrap_or(false);
    }
    st
}

/// 압축 JSON으로 원자 저장.
pub fn save(s: &ViewerState) -> std::io::Result<()> {
    let text = serde_json::to_string(s).unwrap_or_default();
    crate::write_home_file(FILE, &text)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 저장한 그대로 돌아온다 — 모드·위치·크기·최대화 전부.
    #[test]
    fn round_trips_mode_and_bounds() {
        let _home = crate::testhome::take("viewer-state-rt");
        assert_eq!(load(), ViewerState::default(), "빈 홈은 기본값");
        let st = ViewerState {
            window: true,
            win: WinState { x: Some(-1920), y: Some(40), width: 1000, height: 700, maximized: true },
        };
        save(&st).unwrap();
        assert_eq!(load(), st);
        // 파일 모양이 고정 키 순서(정수 좌표)인가 — 사람이 열어 봐도 읽히는 파일이어야 한다.
        let raw = std::fs::read_to_string(crate::app_home().join(FILE)).unwrap();
        assert_eq!(raw, r#"{"window":true,"x":-1920,"y":40,"width":1000,"height":700,"maximized":true}"#);
    }

    /// 크기가 깨진 파일은 크기만 기본값으로 — 모드 비트는 지킨다. 최소 크기 아래는 끌어올린다.
    #[test]
    fn broken_size_keeps_mode_and_clamps() {
        let _home = crate::testhome::take("viewer-state-broken");
        crate::write_home_file(FILE, r#"{"window":true,"width":"wide"}"#).unwrap();
        let st = load();
        assert!(st.window);
        assert_eq!(st.win.width, DEFAULT_W);
        crate::write_home_file(FILE, r#"{"window":false,"x":1,"y":2,"width":10,"height":10}"#).unwrap();
        let st = load();
        assert!(!st.window);
        assert_eq!((st.win.width, st.win.height), (MIN_W, MIN_H));
        assert_eq!((st.win.x, st.win.y), (Some(1), Some(2)));
    }
}
