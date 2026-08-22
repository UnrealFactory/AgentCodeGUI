//! 창 껍데기 — 3.0의 최대 리스크 지점.
//!
//! 2.6.2(Electron)의 메인 창은 `frame:false` + `backgroundMaterial:'acrylic'`이다.
//! 프레임리스인데도 **네이티브 리사이즈·Aero Snap·최대화가 전부 살아 있고**(창에
//! WS_THICKFRAME이 남아서), DWM이 아크릴 재질을 그린다. 3.0은 그 조합을 Tauri에서
//! 재현해야 한다. 후보 셋을 CCG_CHROME 환경변수로 갈아 끼우며 실증한 결과는
//! docs/m1-report.md에 있다 — 기본값은 채택안(b).
//!
//!  a) decorations(true)  : OS 캡션을 그대로 두고 웹 콘텐츠를 그 아래에. 스냅·리사이즈는
//!                          당연히 살지만 2.6.2의 커스텀 타이틀바와 이중으로 겹친다.
//!  b) decorations(false) + shadow(true) + transparent + Acrylic  ← 채택
//!                          tao가 undecorated 창에 WS_THICKFRAME·히트테스트를 유지해
//!                          엣지 리사이즈/스냅이 살고, DwmExtendFrameIntoClientArea가
//!                          그림자·라운드를 준다. 드래그는 심의 -webkit-app-region
//!                          재현(app/src/api/chrome.ts) → startDragging(HTCAPTION).
//!  c) b에서 아크릴만 뺀 것 : 재질이 스냅/리사이즈에 영향을 주는지 가르는 대조군.

use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{
    webview::PageLoadEvent, AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

pub const MAIN: &str = "main";

/// 저장 디바운스(2.6.2와 같은 400ms)
const SAVE_DEBOUNCE: Duration = Duration::from_millis(400);

static SAVE_TX: OnceLock<Sender<()>> = OnceLock::new();
static LAST_MAX: AtomicBool = AtomicBool::new(false);
/// 최대화 중에도 "창 모드 크기"를 기억한다(Electron getNormalBounds와 같은 뜻).
static NORMAL: Mutex<Option<ccg_store::window_state::WinState>> = Mutex::new(None);
static SCALE_MILLI: AtomicI64 = AtomicI64::new(1000);

fn chrome_mode() -> char {
    std::env::var("CCG_CHROME")
        .ok()
        .and_then(|s| s.chars().next())
        .unwrap_or('b')
}

/// 저장된 위치가 지금 붙어 있는 모니터들과 겹치는가 (2.6.2 isOnScreen).
fn on_screen(app: &AppHandle, s: &ccg_store::window_state::WinState) -> bool {
    let (Some(x), Some(y)) = (s.x, s.y) else { return false };
    let Ok(monitors) = app.available_monitors() else { return false };
    monitors.iter().any(|m| {
        let scale = m.scale_factor();
        let pos = m.position().to_logical::<f64>(scale);
        let size = m.size().to_logical::<f64>(scale);
        (x as f64) < pos.x + size.width
            && (x + s.width) as f64 > pos.x
            && (y as f64) < pos.y + size.height
            && (y + s.height) as f64 > pos.y
    })
}

pub fn create_main(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let st = ccg_store::window_state::load();
    *NORMAL.lock().unwrap() = Some(st.clone());
    LAST_MAX.store(st.maximized, Ordering::Relaxed);

    let mode = chrome_mode();
    let mut b = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title("AgentCodeGUI3")
        .inner_size(st.width as f64, st.height as f64)
        .min_inner_size(
            ccg_store::window_state::MIN_W as f64,
            ccg_store::window_state::MIN_H as f64,
        )
        // 준비되면 보여준다(아래 on_page_load) — 빈 창이 먼저 번쩍이지 않게.
        .visible(false)
        .decorations(mode == 'a')
        // undecorated 창의 그림자·라운드(DwmExtendFrameIntoClientArea)
        .shadow(true)
        // 웹뷰 배경을 투명하게 두어야 DWM 재질이 비친다. 렌더러 CSS는 body를
        // rgba(21,21,21,.70)로 깔아 그 위에 틴트를 얹는 구조다(styles.css 주석).
        .transparent(mode != 'c')
        // 네이티브 drag-drop을 켜면 HTML5 drop이 웹뷰에 아예 안 온다 — 렌더러의
        // 첨부 드롭·탐색기 드래그가 전부 죽는다. 경로가 필요한 자리는 심이
        // saveAttachmentData(바이트) 폴백으로 간다.
        .disable_drag_drop_handler()
        .maximized(st.maximized);

    if on_screen(app, &st) {
        b = b.position(st.x.unwrap_or(0) as f64, st.y.unwrap_or(0) as f64);
    }
    if mode != 'c' {
        use tauri::utils::config::WindowEffectsConfig;
        use tauri::window::Effect;
        b = b.effects(WindowEffectsConfig {
            effects: vec![Effect::Acrylic],
            state: None,
            radius: None,
            color: None,
        });
    }

    // 보여주는 시점 = 페이지 로드 **완료**. Electron의 ready-to-show("그릴 준비가 됐다")와
    // 같은 의미의 자리다. Started에서 보여주면 창이 200ms 먼저 뜨지만 빈 유리창이 번쩍이고,
    // 벤치의 '첫 가시 창'도 실제보다 좋게 찍힌다(같은 잣대가 아니게 된다).
    b = b.on_page_load(|w, payload| {
        if payload.event() == PageLoadEvent::Finished {
            let _ = w.show();
            let _ = w.set_focus();
        }
    });

    let win = b.build()?;

    if let Ok(s) = win.scale_factor() {
        SCALE_MILLI.store((s * 1000.0).round() as i64, Ordering::Relaxed);
    }

    let handle = app.clone();
    win.on_window_event(move |e| match e {
        WindowEvent::Resized(_) | WindowEvent::Moved(_) => {
            // 최대화 토글은 Resized로 온다 — 커스텀 타이틀바 아이콘이 따라오게 즉시 통지
            if let Some(w) = handle.get_webview_window(MAIN) {
                if let Ok(m) = w.is_maximized() {
                    if LAST_MAX.swap(m, Ordering::Relaxed) != m {
                        let _ = handle.emit_to(MAIN, crate::ipc::ch::WIN_STATE, json!({ "maximized": m }));
                    }
                }
            }
            schedule_save(&handle);
        }
        WindowEvent::CloseRequested { .. } => save_now(&handle),
        _ => {}
    });

    Ok(win)
}

fn schedule_save(app: &AppHandle) {
    let tx = SAVE_TX.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<()>();
        let app = app.clone();
        std::thread::spawn(move || {
            while rx.recv().is_ok() {
                // 연달아 오는 resize/move를 한 번으로 접는다
                while rx.recv_timeout(SAVE_DEBOUNCE).is_ok() {}
                save_now(&app);
            }
        });
        tx
    });
    let _ = tx.send(());
}

/// 지금 창 상태를 window-state.json으로. 최대화 중이면 창 모드 크기는 마지막 값을 지킨다.
fn save_now(app: &AppHandle) {
    let Some(w) = app.get_webview_window(MAIN) else { return };
    let maximized = w.is_maximized().unwrap_or(false);
    let scale = SCALE_MILLI.load(Ordering::Relaxed) as f64 / 1000.0;
    let mut guard = NORMAL.lock().unwrap();
    let mut st = guard.clone().unwrap_or_default();
    if !maximized {
        if let (Ok(pos), Ok(size)) = (w.outer_position(), w.inner_size()) {
            let p = pos.to_logical::<f64>(scale);
            let s = size.to_logical::<f64>(scale);
            st.x = Some(p.x.round() as i64);
            st.y = Some(p.y.round() as i64);
            st.width = (s.width.round() as i64).max(ccg_store::window_state::MIN_W);
            st.height = (s.height.round() as i64).max(ccg_store::window_state::MIN_H);
        }
    }
    st.maximized = maximized;
    *guard = Some(st.clone());
    drop(guard);
    let _ = ccg_store::window_state::save(&st);
}

// ── 창 컨트롤 (계약면 win:*) ─────────────────────────────────────────────────
pub fn minimize(w: &WebviewWindow) {
    let _ = w.minimize();
}
pub fn toggle_maximize(w: &WebviewWindow) -> bool {
    let maximized = w.is_maximized().unwrap_or(false);
    let _ = if maximized { w.unmaximize() } else { w.maximize() };
    !maximized
}
pub fn close(w: &WebviewWindow) {
    let _ = w.close();
}
pub fn is_maximized(w: &WebviewWindow) -> bool {
    w.is_maximized().unwrap_or(false)
}

/// 창을 만들 때 쓰는 논리 좌표 헬퍼 (M2의 세션/패널 창이 재사용한다)
#[allow(dead_code)]
pub fn logical(x: f64, y: f64) -> (LogicalPosition<f64>, LogicalSize<f64>) {
    (LogicalPosition::new(x, y), LogicalSize::new(x, y))
}
