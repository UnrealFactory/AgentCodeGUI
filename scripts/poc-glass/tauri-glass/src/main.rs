#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
//! 유리(아크릴) PoC — "사이드바 유리가 갑자기 진한 회색으로 바뀐다"의 원인 확정 + 해결안 실증.
//!
//! 3.0 셸(src-tauri/src/win.rs)의 껍데기 규칙만 그대로 뽑았다:
//!   decorations(false) + shadow(true) + transparent(true) + Effect::Acrylic
//! Tauri의 Effect::Acrylic은 Win11 22621+ 에서 window-vibrancy가
//! `DwmSetWindowAttribute(DWMWA_SYSTEMBACKDROP_TYPE, DWMSBT_TRANSIENTWINDOW=3)`을 부르는 것과
//! 정확히 같다(window-vibrancy-0.6.0/src/windows.rs `apply_acrylic`). 즉 Electron의
//! `backgroundMaterial:'acrylic'`과 같은 기제 → 같은 버그를 그대로 물려받는다.
//!
//! 환경변수 레버 (전부 런타임):
//!   GLASS_MAT       acrylic(기본) | mica | tabbed | none      백드롭 타입 3/2/4/1
//!   GLASS_FIX       none(기본)
//!                   reapply    비활성 전환 50ms 뒤 백드롭 재적용 (2.6.2 keepAcrylicWhenBlurred 이식)
//!                   reapply0   지연 0ms 재적용 (지연이 필요한지 가르는 대조군)
//!                   toggle     비활성 시 1 → 원래값 토글 재적용
//!                   ncactivate WM_NCACTIVATE(wParam=FALSE)를 TRUE로 속인다 (DWM이 속는지)
//!                   swca       DWM 백드롭 대신 Win10식 SetWindowCompositionAttribute 아크릴
//!   GLASS_CSS       none(기본) | xfade      비활성 틴트 크로스페이드 (b안)
//!   GLASS_FALLBACK  none(기본) | designed   투명효과 꺼짐 감지 → 디자인된 단색 (d안)
//!   GLASS_X/Y/W/H   창 위치·크기
//!   GLASS_TAG       창 안에 찍는 라벨
use std::sync::atomic::{AtomicI32, AtomicIsize, Ordering};
use std::time::Duration;
use tauri::{Emitter, Listener, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_SYSTEMBACKDROP_TYPE};
use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallWindowProcW, SetWindowLongPtrW, GWLP_WNDPROC, WM_NCACTIVATE,
};

fn env_or(k: &str, d: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| d.into())
}
fn envn(k: &str, d: f64) -> f64 {
    std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d)
}

fn sbt_of(mat: &str) -> i32 {
    match mat {
        "mica" => 2,
        "tabbed" => 4,
        "none" => 1,
        _ => 3, // acrylic = DWMSBT_TRANSIENTWINDOW
    }
}

/// window-vibrancy가 하는 것과 같은 한 줄. **인프로세스**로 부르는 게 요점이다
/// (외부 프로세스에서 같은 값을 써 넣으면 비활성 상태의 유리는 살아나지 않는다 —
///  docs/design/glass-findings.md의 v3-toggle-probe 참조).
fn set_backdrop(hwnd: isize, v: i32) {
    unsafe {
        DwmSetWindowAttribute(
            hwnd as HWND,
            DWMWA_SYSTEMBACKDROP_TYPE as u32,
            &v as *const i32 as *const _,
            4,
        );
    }
}

/// Win10식 아크릴(ACCENT_ENABLE_ACRYLICBLURBEHIND). DWM 백드롭과 달리 창 활성 상태와
/// 무관하게 그려지는지 가르는 대조군.
#[repr(C)]
struct AccentPolicy {
    accent_state: u32,
    accent_flags: u32,
    gradient_color: u32,
    animation_id: u32,
}
#[repr(C)]
struct WinCompAttrData {
    attrib: u32,
    data: *mut std::ffi::c_void,
    size_of_data: usize,
}
fn apply_swca_acrylic(hwnd: isize, argb: u32) {
    unsafe {
        type Swca = unsafe extern "system" fn(HWND, *mut WinCompAttrData) -> i32;
        let user32 = windows_sys::Win32::System::LibraryLoader::GetModuleHandleA(c"user32.dll".as_ptr() as _);
        if user32.is_null() {
            return;
        }
        let p = windows_sys::Win32::System::LibraryLoader::GetProcAddress(
            user32,
            c"SetWindowCompositionAttribute".as_ptr() as _,
        );
        let Some(p) = p else { return };
        let f: Swca = std::mem::transmute(p);
        let mut policy = AccentPolicy {
            accent_state: 4, // ACCENT_ENABLE_ACRYLICBLURBEHIND
            accent_flags: 2, // draw all borders
            gradient_color: argb,
            animation_id: 0,
        };
        let mut data = WinCompAttrData {
            attrib: 19, // WCA_ACCENT_POLICY
            data: &mut policy as *mut _ as *mut _,
            size_of_data: std::mem::size_of::<AccentPolicy>(),
        };
        f(hwnd as HWND, &mut data);
    }
}

// ── WM_NCACTIVATE 위조 (fix=ncactivate) ──────────────────────────────────────
static OLD_PROC: AtomicIsize = AtomicIsize::new(0);
unsafe extern "system" fn lying_proc(h: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    let old = OLD_PROC.load(Ordering::Relaxed);
    let w = if msg == WM_NCACTIVATE { 1usize } else { w };
    CallWindowProcW(Some(std::mem::transmute(old)), h, msg, w, l)
}

/// 설정 › 개인 설정 › 색 › 투명 효과 (배터리 절약이 켜지면 OS가 실질적으로 같이 끈다)
fn transparency_enabled() -> bool {
    unsafe {
        let sub: Vec<u16> = "Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let name: Vec<u16> = "EnableTransparency".encode_utf16().chain(std::iter::once(0)).collect();
        let mut val: u32 = 1;
        let mut sz: u32 = 4;
        let rc = RegGetValueW(
            HKEY_CURRENT_USER,
            sub.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            &mut val as *mut u32 as *mut _,
            &mut sz,
        );
        if rc != 0 {
            return true;
        }
        val != 0
    }
}

/// 배터리 절약 모드. Win11은 이게 켜지면 EnableTransparency는 1로 둔 채
/// **효과만** 끈다 — 레지스트리만 보면 놓친다.
fn battery_saver() -> bool {
    unsafe {
        let mut s: SYSTEM_POWER_STATUS = std::mem::zeroed();
        if GetSystemPowerStatus(&mut s) == 0 {
            return false;
        }
        s.SystemStatusFlag == 1
    }
}

static SBT: AtomicI32 = AtomicI32::new(3);

fn main() {
    let mat = env_or("GLASS_MAT", "acrylic");
    let fix = env_or("GLASS_FIX", "none");
    let css = env_or("GLASS_CSS", "none");
    let fallback = env_or("GLASS_FALLBACK", "none");
    let tag = std::env::var("GLASS_TAG").unwrap_or_else(|_| format!("{mat}/{fix}/{css}/{fallback}"));
    let sbt = sbt_of(&mat);
    SBT.store(sbt, Ordering::Relaxed);

    tauri::Builder::default()
        .setup(move |app| {
            let w = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title(format!("tauri-glass {tag}"))
                .inner_size(envn("GLASS_W", 1040.0), envn("GLASS_H", 740.0))
                .position(envn("GLASS_X", 1460.0), envn("GLASS_Y", 600.0))
                // 3.0 셸의 채택안(b) 그대로
                .decorations(false)
                .shadow(true)
                .transparent(true)
                .visible(true)
                .build()?;

            let hwnd = w.hwnd()?.0 as isize;

            if fix == "swca" {
                // Win10식 아크릴. gradient_color는 AABBGGRR — 21,21,21 @ 70%
                apply_swca_acrylic(hwnd, 0xB3_15_15_15);
            } else if mat != "none-nodwm" {
                set_backdrop(hwnd, sbt);
            }

            if fix == "ncactivate" {
                unsafe {
                    let old = SetWindowLongPtrW(hwnd as HWND, GWLP_WNDPROC, lying_proc as isize);
                    OLD_PROC.store(old, Ordering::Relaxed);
                }
            }

            // 상태 팬아웃(프론트가 틴트를 고르는 데 쓴다) — PoC라 1초 폴링
            let ah = app.handle().clone();
            let tag2 = tag.clone();
            let css2 = css.clone();
            let fb2 = fallback.clone();
            let fix2 = fix.clone();
            let mat2 = mat.clone();
            std::thread::spawn(move || loop {
                let focused = ah
                    .get_webview_window("main")
                    .and_then(|w| w.is_focused().ok())
                    .unwrap_or(false);
                let _ = ah.emit(
                    "glass",
                    serde_json::json!({
                        "tag": tag2, "mat": mat2, "fix": fix2, "css": css2, "fallback": fb2,
                        "focused": focused,
                        "transparency": transparency_enabled(),
                        "batterySaver": battery_saver(),
                    }),
                );
                std::thread::sleep(Duration::from_millis(700));
            });

            // 프론트가 준비됐다고 알리면 즉시 한 번 더 (첫 페인트 전 이벤트 유실 방지)
            let ah2 = app.handle().clone();
            app.listen("glass:hello", move |_| {
                let _ = ah2.emit("glass:ping", ());
            });

            // ── 해결안 (a): 비활성 전환에서 백드롭 재적용 ─────────────────────
            let fix3 = fix.clone();
            w.on_window_event(move |e| {
                if let WindowEvent::Focused(false) = e {
                    let v = SBT.load(Ordering::Relaxed);
                    match fix3.as_str() {
                        "reapply" => {
                            std::thread::spawn(move || {
                                std::thread::sleep(Duration::from_millis(50));
                                set_backdrop(hwnd, v);
                            });
                        }
                        "reapply0" => set_backdrop(hwnd, v),
                        "toggle" => {
                            std::thread::spawn(move || {
                                std::thread::sleep(Duration::from_millis(50));
                                set_backdrop(hwnd, 1);
                                std::thread::sleep(Duration::from_millis(16));
                                set_backdrop(hwnd, v);
                            });
                        }
                        _ => {}
                    }
                }
            });
            println!("GLASS_READY pid={} hwnd={hwnd} tag={tag}", std::process::id());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("tauri-glass 실행 실패");
}
