//! 시스템 **트레이** — X = 종료가 아니라 트레이로 숨기기.
//!
//! 원본: 2.6.2 `src/main/index.ts:745-890`(createTray·showTrayMenu·trayMenu*) +
//! `:930-955`(mainWindow.on('close') → hide).
//!
//! 백그라운드 상주(턴을 넘어 완주하는 워크플로·셸·에이전트)와 짝이다: 창을 닫아도 앱은
//! 트레이에 남아 하던 일을 계속 돈다. 아이콘 클릭(또는 메뉴 '열기')이 창을 되살리고,
//! 진짜 종료는 메뉴 '완전히 종료'뿐이다.
//!
//! ## 세 조각
//! 1. **아이콘** — `TrayIconBuilder`. PNG를 `include_bytes!`로 **exe에 박는다**:
//!    3.0은 `bundle.active=false`(설치본 없음)라 `resources/icon.ico` 같은 런타임 경로가
//!    없고, 레포 상대 경로는 벤치가 exe를 복사해 돌리는 순간 깨진다.
//! 2. **메뉴** — 2.6.2와 같은 **커스텀 팝업 창**(`tray.html`). 네이티브 Win32 트레이
//!    메뉴는 구형 서식(각진 검은 박스·큰 행 간격)이라 창=카드로 직접 그린다. 창을 못
//!    만들면 네이티브 `Menu`로 떨어진다 — 투박해도 기능은 지킨다.
//! 3. **X 정책** — `win.rs`의 메인 창 `CloseRequested`가 `hide_on_close()`를 묻는다.
//!    트레이가 없으면(생성 실패) **종전대로 진짜 닫기**다 — 숨긴 창을 되찾을 길이 없으니까.
//!
//! ## 단일 인스턴스 두 번째 실행 (M1 §7-3 이월)
//! 같은 앱 홈으로 두 번째 프로세스가 뜨면 `main.rs`의 홈 잠금이 실패한다. R1까지는
//! **조용히 물러났다** — 트레이에 숨어 있으면 사용자는 "아이콘을 눌렀는데 아무 일도
//! 안 일어나는" 앱을 보게 된다. 이제 물러나기 전에 `raise_existing()`으로
//! 등록 윈도우 메시지를 브로드캐스트하고, 먼저 뜬 인스턴스가 그걸 받아 창을 앞으로 올린다.
//! 메시지 이름에 **앱 홈 경로**를 넣으므로 격리 홈(dev·벤치)끼리는 서로를 안 건드린다.

use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    webview::PageLoadEvent,
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

use super::{shared_env, MAIN};

/// 트레이 메뉴(커스텀 팝업 창)의 계약면 채널 — protocol.ts:1151-1153.
pub const TRAYMENU_SHOW: &str = "traymenu:show";
pub const TRAYMENU_RESIZE: &str = "traymenu:resize";
pub const TRAYMENU_ACTION: &str = "traymenu:action";

pub const MENU_WIN: &str = "traymenu";
const MENU_W: f64 = 218.0;

/// 아이콘 원본. `bundle.active=false`라 런타임 경로가 없다 — exe에 박는다.
const ICON_PNG: &[u8] = include_bytes!("../../build/icon.png");

/// 트레이 핸들. **떨어뜨리면 아이콘이 사라진다**(TrayIcon은 Drop에서 알림 영역에서 뺀다).
static TRAY: OnceLock<TrayIcon> = OnceLock::new();
/// 진짜 종료 중 — 이때의 X는 숨기기가 아니다(2.6.2 `appQuitting`).
static QUITTING: AtomicBool = AtomicBool::new(false);
/// 커스텀 카드를 못 만들어 네이티브 메뉴로 내려갔다 — 그 뒤로는 우클릭에 카드를 다시
/// 시도하지 않는다(OS가 메뉴를 자동으로 띄우므로 둘이 겹친다).
static NATIVE_FALLBACK: AtomicBool = AtomicBool::new(false);
/// 우클릭 순간의 커서(논리 좌표). 높이 보고가 올 때쯤 커서는 이미 떠났을 수 있다.
static ANCHOR: Mutex<(f64, f64)> = Mutex::new((0.0, 0.0));
/// 메뉴 창이 **한 번이라도 포커스를 잡았나**. blur=닫기 규칙을 이 뒤로 미룬다.
///
/// 실측 함정: 창을 `visible(false)`로 만들면 tao가 **생성 직후 `Focused(false)`를 한 번
/// 쏜다.** 그걸 그대로 blur로 받으면 창이 태어나자마자 자기를 부순다 — 조용히, 오류도
/// 없이(R1에서 트레이 메뉴가 "안 뜬다"의 정체가 이것이었다).
static MENU_SHOWN: AtomicBool = AtomicBool::new(false);

pub fn is_quitting() -> bool {
    QUITTING.load(Ordering::SeqCst)
}

/// 트레이가 실제로 살아 있나 — X 정책의 전제.
pub fn present() -> bool {
    TRAY.get().is_some()
}

/// X(·Alt+F4)를 트레이로 숨기기로 바꿀까. 설정 `tray.closeToTray`(기본 on)를 존중한다.
/// 트레이가 없으면(생성 실패) 항상 false — 숨긴 창을 되찾을 길이 없다.
pub fn hide_on_close() -> bool {
    if is_quitting() || !present() {
        return false;
    }
    ccg_store::prefs::read_ui_prefs().get("tray.closeToTray").and_then(Value::as_bool) != Some(false)
}

/// 메인 창을 앞으로 — 트레이 클릭·메뉴 '열기'·두 번째 인스턴스가 전부 여기로 온다.
pub fn show_main(app: &AppHandle) {
    let Some(w) = app.get_webview_window(MAIN) else { return };
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
}

fn quit(app: &AppHandle) {
    QUITTING.store(true, Ordering::SeqCst);
    app.exit(0);
}

// ── 아이콘 ──────────────────────────────────────────────────────────────────

pub fn init(app: &AppHandle) {
    if TRAY.get().is_some() {
        return;
    }
    // `CCG_NO_TRAY=1` — 트레이 없는 팔(그때 X는 2.6.2의 "트레이 실패" 경로 = 진짜 닫기).
    if std::env::var("CCG_NO_TRAY").is_ok_and(|v| v != "0") {
        return;
    }
    let icon = match tauri::image::Image::from_bytes(ICON_PNG) {
        Ok(i) => i,
        Err(e) => {
            eprintln!("[tray] 아이콘 디코드 실패: {e}");
            return;
        }
    };
    let handle = app.clone();
    let built = TrayIconBuilder::with_id("ccg-tray")
        .icon(icon)
        .tooltip("AgentCodeGUI")
        // 좌클릭에 네이티브 메뉴를 자동으로 띄우지 않는다 — 커스텀 카드와 겹친다.
        .show_menu_on_left_click(false)
        .on_tray_icon_event(move |_tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
            | TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => show_main(&handle),
            TrayIconEvent::Click {
                button: MouseButton::Right,
                button_state: MouseButtonState::Up,
                position,
                ..
            } => show_menu(&handle, position.x, position.y),
            _ => {}
        })
        .build(app);
    match built {
        Ok(t) => {
            let _ = TRAY.set(t);
            // 네이티브 폴백 메뉴의 클릭 수신자 — 폴백이 안 걸리면 한 번도 안 불린다.
            app.on_menu_event(|app, ev| match ev.id().as_ref() {
                "ccg-tray-open" => show_main(app),
                "ccg-tray-quit" => quit(app),
                _ => {}
            });
        }
        // 트레이가 없으면 X는 종전대로 진짜 닫기 — `hide_on_close()`가 false를 준다.
        Err(e) => eprintln!("[tray] 트레이 생성 실패: {e}"),
    }
}

// ── 우클릭 메뉴 (커스텀 팝업 창) ────────────────────────────────────────────

fn items() -> Value {
    // 라벨은 **표시 시점**에 만든다. Rust 쪽에 i18n이 없으므로 저장된 UI 언어를 읽어
    // 두 벌 중 하나를 고른다(렌더러 `lib/i18n.ts`와 같은 키: ui-prefs `lang`).
    let en = ccg_store::prefs::read_ui_prefs().get("lang").and_then(Value::as_str) == Some("en");
    json!([
        { "id": "open", "label": if en { "Open AgentCodeGUI" } else { "AgentCodeGUI 열기" } },
        { "id": "quit", "label": if en { "Quit completely" } else { "완전히 종료" } },
    ])
}

/// 트레이 아이콘 우클릭 — 떠 있으면 토글 닫기(네이티브 메뉴의 재우클릭과 같은 감각).
/// `x`/`y`는 **물리** 좌표(TrayIconEvent.position)다.
pub fn show_menu(app: &AppHandle, x: f64, y: f64) {
    if NATIVE_FALLBACK.load(Ordering::SeqCst) {
        return; // OS가 붙은 네이티브 메뉴를 알아서 띄운다
    }
    if app.get_webview_window(MENU_WIN).is_some() {
        destroy_menu(app);
        return;
    }
    MENU_SHOWN.store(false, Ordering::SeqCst);
    let scale = app
        .get_webview_window(MAIN)
        .and_then(|w| w.scale_factor().ok())
        .unwrap_or(1.0);
    *ANCHOR.lock().unwrap_or_else(|e| e.into_inner()) = (x / scale, y / scale);

    let b = shared_env(
        WebviewWindowBuilder::new(app, MENU_WIN, WebviewUrl::App("tray.html".into())),
        MENU_WIN,
    )
    .title("메뉴 — AgentCodeGUI")
    .inner_size(MENU_W, 92.0)
    .visible(false)
    .decorations(false)
    .resizable(false)
    .minimizable(false)
    .maximizable(false)
    .skip_taskbar(true)
    .always_on_top(true)
    // **생성 시점에 포커스를 잡지 않는다.** 기본값(true)이면 아직 보이지도 않는 창에
    // tao가 포커스 전이를 한 벌 흘리고, 그 blur를 소멸 규칙이 받아 창이 태어나자마자
    // 자기를 부순다(R1 실측: "메뉴 창이 안 뜬다"의 정체). 포커스는 `menu_resize`가
    // 실제로 보여줄 때 잡는다.
    .focused(false)
    .background_color(tauri::utils::config::Color(0x15, 0x15, 0x15, 0xff))
    .on_page_load(|w, payload| {
        if payload.event() == PageLoadEvent::Finished {
            let _ = w.emit_to(MENU_WIN, TRAYMENU_SHOW, items());
            // 토스트와 같은 이유의 재송신 — 심의 `subscribe`는 Tauri `listen()`(비동기
            // 등록)이라 `load` 직후엔 아직 안 붙어 있을 수 있다(notify.rs 실측 참조).
            // 항목 목록은 REPLACE라 두 번 받아도 무해하다.
            let a = w.app_handle().clone();
            std::thread::spawn(move || {
                for ms in [180u64, 500] {
                    std::thread::sleep(std::time::Duration::from_millis(ms));
                    if a.get_webview_window(MENU_WIN).is_none() {
                        return;
                    }
                    let _ = a.emit_to(MENU_WIN, TRAYMENU_SHOW, items());
                }
            });
        }
    });

    let win = match b.build() {
        Ok(w) => w,
        Err(e) => {
            // 팝업 창을 못 만들면 네이티브 메뉴로 — 투박해도 기능은 지킨다.
            eprintln!("[tray] 메뉴 창 생성 실패: {e} — 네이티브 폴백");
            native_menu(app);
            return;
        }
    };
    let handle = app.clone();
    win.on_window_event(move |e| {
        // 실제로 보여준 뒤부터만 blur=닫기(네이티브 메뉴와 같은 소멸 규칙).
        // 표식은 `menu_resize`가 세운다 — 그 전의 포커스 전이는 창이 아직 안 보일 때의 잡음이다.
        if matches!(e, WindowEvent::Focused(false)) && MENU_SHOWN.load(Ordering::SeqCst) {
            destroy_menu(&handle);
        }
    });
}

/// `traymenu:resize` — 페이지가 콘텐츠 높이를 보고한다. 커서 기준으로(트레이는 화면
/// 아래이므로 **위쪽**) 위치를 확정하고 보여준다. show()가 포커스를 가져가는 게
/// blur 소멸 규칙의 발판이다.
pub fn menu_resize(app: &AppHandle, height: f64) {
    let Some(w) = app.get_webview_window(MENU_WIN) else { return };
    let (ax, ay) = *ANCHOR.lock().unwrap_or_else(|e| e.into_inner());
    let scale = w.scale_factor().unwrap_or(1.0);
    let m = app
        .monitor_from_point(ax * scale, ay * scale)
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());
    let (wx, wy, ww, wh) = match m {
        Some(m) => {
            let s = if m.scale_factor() > 0.0 { m.scale_factor() } else { scale };
            let a = m.work_area();
            (
                a.position.x as f64 / s,
                a.position.y as f64 / s,
                a.size.width as f64 / s,
                a.size.height as f64 / s,
            )
        }
        None => (0.0, 0.0, 1280.0, 720.0),
    };
    let h = height.round().max(40.0).min(wh - 16.0);
    let x = (ax - MENU_W / 2.0).max(wx + 8.0).min(wx + ww - MENU_W - 8.0);
    let mut y = ay - h - 10.0;
    if y < wy + 8.0 {
        y = (ay + 10.0).min(wy + wh - h - 8.0);
    }
    let _ = w.set_size(tauri::LogicalSize::new(MENU_W, h));
    let _ = w.set_position(tauri::LogicalPosition::new(x, y));
    let _ = w.show();
    let _ = w.set_focus();
    // 여기서부터 blur = 닫기다(위 `MENU_SHOWN` 주석 참고).
    MENU_SHOWN.store(true, Ordering::SeqCst);
}

/// `traymenu:action` — 클릭한 항목(`''` = Esc 닫기).
pub fn menu_action(app: &AppHandle, id: &str) {
    destroy_menu(app);
    match id {
        "open" => show_main(app),
        "quit" => quit(app),
        _ => {}
    }
}

pub fn destroy_menu(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MENU_WIN) {
        let _ = w.destroy();
    }
}

/// 커스텀 카드를 못 만들었을 때의 네이티브 폴백. 한 번 붙으면 OS가 우클릭에 알아서
/// 띄우므로 이후 카드 시도를 막는다(`NATIVE_FALLBACK`).
fn native_menu(app: &AppHandle) {
    use tauri::menu::{IsMenuItem, MenuBuilder, MenuItemBuilder};
    let Some(t) = TRAY.get() else { return };
    let en = ccg_store::prefs::read_ui_prefs().get("lang").and_then(Value::as_str) == Some("en");
    let Ok(open) = MenuItemBuilder::with_id("ccg-tray-open", if en { "Open AgentCodeGUI" } else { "AgentCodeGUI 열기" }).build(app)
    else {
        return;
    };
    let Ok(quit_i) = MenuItemBuilder::with_id("ccg-tray-quit", if en { "Quit completely" } else { "완전히 종료" }).build(app)
    else {
        return;
    };
    let items: [&dyn IsMenuItem<tauri::Wry>; 2] = [&open, &quit_i];
    let Ok(menu) = MenuBuilder::new(app).items(&items).build() else { return };
    if t.set_menu(Some(menu)).is_ok() {
        let _ = t.set_show_menu_on_left_click(false);
        NATIVE_FALLBACK.store(true, Ordering::SeqCst);
    }
}

// ── 두 번째 인스턴스 → 먼저 뜬 창을 앞으로 (M1 §7-3) ────────────────────────

/// 등록 윈도우 메시지 이름 — **앱 홈 경로**를 넣어 격리 홈끼리 안 섞이게 한다.
#[cfg(windows)]
fn raise_msg_name() -> Vec<u16> {
    let home = ccg_store::app_home().to_string_lossy().to_lowercase();
    let mut h: u64 = 1469598103934665603;
    for b in home.as_bytes() {
        h = (h ^ (*b as u64)).wrapping_mul(1099511628211);
    }
    let s = format!("CCG_RAISE_{h:016x}\0");
    s.encode_utf16().collect()
}

#[cfg(windows)]
fn raise_msg() -> u32 {
    use windows::core::PCWSTR;
    use windows::Win32::UI::WindowsAndMessaging::RegisterWindowMessageW;
    let name = raise_msg_name();
    unsafe { RegisterWindowMessageW(PCWSTR(name.as_ptr())) }
}

/// **두 번째 인스턴스가 부른다** — 먼저 뜬 같은 홈의 인스턴스에게 "창을 앞으로" 신호.
/// 등록 메시지(0xC000~0xFFFF)는 브로드캐스트가 UIPI를 통과한다. 이름에 홈 해시가 있으니
/// 남의 창은 이 값을 모르고, 알아도 우리 subclass만 처리한다.
#[cfg(windows)]
pub fn raise_existing() {
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{PostMessageW, HWND_BROADCAST};
    let msg = raise_msg();
    if msg == 0 {
        return;
    }
    // PostMessage는 큐에 넣고 즉시 돌아온다 — 우리가 바로 죽어도 메시지는 이미 갔다.
    unsafe {
        let _ = PostMessageW(Some(HWND_BROADCAST), msg, WPARAM(0), LPARAM(0));
    }
}

#[cfg(not(windows))]
pub fn raise_existing() {}

/// **첫 인스턴스가 부른다** — 메인 창에 subclass를 얹어 위 메시지를 듣는다.
/// glass.rs도 같은 hwnd에 subclass를 걸지만 ID가 달라 체인으로 공존한다.
#[cfg(windows)]
pub fn arm_raise_listener(app: &AppHandle, win: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};

    const SUBCLASS_ID: usize = 0x0CC6_2A15;
    static RAISE_APP: OnceLock<AppHandle> = OnceLock::new();
    static RAISE_MSG: OnceLock<u32> = OnceLock::new();

    unsafe extern "system" fn proc_(
        hwnd: HWND,
        msg: u32,
        w: WPARAM,
        l: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        if Some(&msg) == RAISE_MSG.get() {
            if let Some(app) = RAISE_APP.get() {
                let a = app.clone();
                // 창 조작은 메인 스레드에서 — 지금 여기가 그 스레드지만 wndproc 안에서
                // 창을 만지면 재진입이 생길 수 있어 큐로 넘긴다.
                let _ = app.run_on_main_thread(move || show_main(&a));
            }
            return LRESULT(0);
        }
        unsafe { DefSubclassProc(hwnd, msg, w, l) }
    }

    let _ = RAISE_APP.set(app.clone());
    let msg = raise_msg();
    if msg == 0 {
        return;
    }
    let _ = RAISE_MSG.set(msg);
    let Ok(raw) = win.hwnd() else { return };
    let hwnd = HWND(raw.0 as *mut core::ffi::c_void);
    unsafe {
        let _ = SetWindowSubclass(hwnd, Some(proc_), SUBCLASS_ID, 0);
    }
}

#[cfg(not(windows))]
pub fn arm_raise_listener(_app: &AppHandle, _win: &tauri::WebviewWindow) {}

/// 진단 — 하네스가 읽는 회계.
pub fn debug_state(app: &AppHandle) -> Value {
    json!({
        "tray": present(),
        "hideOnClose": hide_on_close(),
        "menuWindow": app.get_webview_window(MENU_WIN).is_some(),
        "quitting": is_quitting(),
    })
}
