//! 잡채널 셋 — `shortcut:close` · `ui:open-api-settings` · `app:get-initial-dir`
//! (최종 파리티 감사 R1 §3.3 **M1·M3·M2**).
//!
//! 셋 다 코드는 짧은데 없으면 화면이 **조용히 죽는다**는 점이 같다.

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

// ── M1. Ctrl+W (`shortcut:close`) ───────────────────────────────────────────
//
// 2.6.2는 `before-input-event`로 Ctrl/⌘+W를 **삼키고**(Electron 기본 메뉴의 '창 닫기'
// 가속기라 그냥 두면 창이 닫힌다) 렌더러엔 알려 열린 뷰어만 닫게 했다(`index.ts:987`).
//
// Tauri에는 그 자리가 없다 — 웹뷰 안의 키 입력은 셸에 오지 않는다(tao의 `WindowEvent`는
// 창 이벤트지 문서 이벤트가 아니다). 그래서 **셸이 소유하는 주입 스크립트**로 잡는다
// (`win.rs`의 splash·glass 스크립트와 같은 지위). 렌더러 이식본은 한 글자도 안 고친다:
// 그쪽은 지금도 `onCloseShortcut`을 구독할 뿐이고(`Chat.tsx:419`·`FileModal.tsx:2998`),
// 그 채널의 **방출자가 없었을 뿐**이다.
//
// `capture: true`인 이유: 렌더러의 다른 키 핸들러가 먼저 먹고 `stopPropagation` 하는
// 경우에도 이 한 줄은 봐야 한다. `preventDefault`는 WebView2가 이 조합을 자체 처리하는
// 판(웹뷰 종류·정책에 따라 다르다)에서의 보험이다.

/// 전 창에 주입되는 Ctrl+W 포획기. **채널 이름은 아래 상수와 같아야 한다.**
pub const CLOSE_SHORTCUT_JS: &str = r#"
(() => {
  const send = () => {
    try {
      window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: 'shortcut:close', payload: [] });
    } catch { /* 아직 브리지 전 — 다음 눌림에 잡힌다 */ }
  };
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    if ((e.key || '').toLowerCase() !== 'w') return;
    e.preventDefault();
    send();
  }, true);
})();
"#;

/// 렌더러 → 셸(눌렸다) **그리고** 셸 → 렌더러(닫아라). 2.6.2도 이름이 하나다.
const SHORTCUT_CLOSE: &str = "shortcut:close";
/// 세션 창 → 셸: 메인 창을 앞으로 + 설정 ▸ API 열기.
const OPEN_API_SETTINGS: &str = "ui:open-api-settings";
/// 셸 → 메인 창: 위 요청 전달(설정 모달을 연다).
const API_SETTINGS_REQUESTED: &str = "ui:api-settings-requested";

pub fn owns(channel: &str) -> bool {
    matches!(channel, SHORTCUT_CLOSE | OPEN_API_SETTINGS)
}

pub fn dispatch(app: &AppHandle, window: &WebviewWindow, channel: &str) -> Value {
    match channel {
        // **부른 창에만** 되쏜다. 브로드캐스트하면 다른 창에 열려 있던 뷰어가 남의
        // 키 입력으로 닫힌다 — 2.6.2도 누른 창(메인)에만 보냈다.
        SHORTCUT_CLOSE => {
            let _ = app.emit_to(window.label(), SHORTCUT_CLOSE, Value::Null);
            Value::Null
        }
        // M3. 추가 채팅 창의 과금 picker에서 "키 없이 API"를 고르면 설정 모달이 있는
        // 메인 창을 앞으로 가져와 API 탭을 대신 연다(2.6.2 `index.ts:1402`).
        // 메인 창이 트레이로 숨어 있을 수 있으므로 `show()`가 `unminimize()`와 함께 온다.
        OPEN_API_SETTINGS => {
            if let Some(w) = app.get_webview_window(crate::win::MAIN) {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
                let _ = app.emit_to(crate::win::MAIN, API_SETTINGS_REQUESTED, Value::Null);
            }
            Value::Null
        }
        _ => super::super::unimplemented(),
    }
}

// ── M2. `app:get-initial-dir` ───────────────────────────────────────────────

/// 명령줄로 넘어온 **폴더**(파일 탐색기의 「AgentCodeGUI로 열기」가 그렇게 부른다).
///
/// 2.6.2 `openedDirFromArgv`의 자리다. 한 번 읽으면 소비하는 쪽이 그쪽 규약이지만
/// (`pendingOpenDir`), 여기서는 argv가 프로세스 수명 내내 불변이라 그냥 계산한다 —
/// 렌더러도 부팅 1회만 묻는다(`shim.ts` `app.getInitialDir`).
///
/// **짝인 `app:open-directory`(이미 떠 있는 앱에 폴더가 또 오는 경우)는 이 라운드에
/// 안 만든다.** 그 이벤트의 유일한 발원지는 단일 인스턴스 잠금의 second-instance인데,
/// 3.0에 그 플러그인을 넣는 순간 **격리 홈으로 동시에 여러 벌 띄우는 하네스가 전부
/// 죽는다**(지금 세 갈래가 그렇게 돈다). 설치기가 컨텍스트 메뉴를 등록하는 라운드에
/// 함께 결정할 일이다(`app_meta.rs:11`의 원래 판단과 같다).
pub fn initial_dir() -> Value {
    for a in std::env::args().skip(1) {
        if a.starts_with('-') {
            continue; // 스위치는 폴더가 아니다
        }
        let p = std::path::Path::new(&a);
        if p.is_dir() {
            return json!(p.to_string_lossy().to_string());
        }
    }
    Value::Null
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 주입 스크립트가 **실제로 쓰는 채널 이름**이 상수와 같은가.
    /// (문자열이 어긋나면 Ctrl+W가 조용히 미구현으로 떨어진다 — 화면에는 아무 표시도 없다.)
    #[test]
    fn the_injected_script_calls_the_channel_this_module_owns() {
        assert!(
            CLOSE_SHORTCUT_JS.contains(&format!("'{SHORTCUT_CLOSE}'")),
            "주입 스크립트의 채널 이름이 상수와 갈렸다"
        );
        assert!(owns(SHORTCUT_CLOSE));
        // Alt+Ctrl+W는 제외한다(2.6.2 `!input.alt`) — 다른 조합을 뺏지 않는다.
        assert!(CLOSE_SHORTCUT_JS.contains("e.altKey"));
        assert!(CLOSE_SHORTCUT_JS.contains("true)"), "capture 단계로 안 걸면 남이 먼저 먹는다");
    }

    /// argv에 폴더가 없으면 `null`이다(스위치·없는 경로에 속지 않는다).
    #[test]
    fn a_switch_or_a_missing_path_is_not_an_initial_dir() {
        // 이 프로세스의 argv는 테스트 러너의 것이라 폴더가 없다 = null이 정답.
        let v = initial_dir();
        assert!(
            v.is_null() || v.as_str().is_some_and(|s| std::path::Path::new(s).is_dir()),
            "폴더가 아닌 값이 초기 폴더로 나왔다: {v}"
        );
    }
}
