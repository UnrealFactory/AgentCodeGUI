//! 유리(아크릴) 유지 — DWM 백드롭 **재단언**과 소실 통지.
//!
//! ## 왜 필요한가 (사용자 실물 버그)
//!
//! 창은 `decorations(false) + transparent(true) + Effect::Acrylic`으로 뜬다(win.rs b안).
//! 사이드바에는 **자체 배경이 없다** — body의 `--panel`(rgba(21,21,21,.70)) 틴트가
//! DWM이 그린 아크릴 위에 얹혀 있을 뿐이다(styles.css :root 주석). 그래서 DWM이
//! 아크릴을 안 그리는 순간 사이드바는 통째로 다른 것이 된다.
//!
//! 실측(scripts/poc-glass/repro.ps1 — 원색 3띠 판 위에서 창을 옮기며 사이드바 픽셀):
//!
//! | 창 | 백드롭 | magenta 띠 | cyan 띠 | white 띠 | 스윙 | 판정 |
//! |---|---|---|---|---|---|---|
//! | 2.6.2 셸(electron-lab, `backgroundMaterial:'acrylic'`) | ACRYLIC(3) | 85,15,62 | 15,60,69 | 58,58,58 | **70** | 유리 살아 있음 |
//! | 〃 | NONE(1) | 15,15,15 | 15,15,15 | 15,15,15 | **0** | **평탄 단색** = 사용자 증상 |
//! | 〃 | AUTO(0) | 15,15,15 | 15,15,15 | 15,15,15 | 0 | NONE과 같음 |
//! | 3.0 셸(`transparent(true)`) | ACRYLIC(3) | 36,15,29 | 15,29,31 | 21,21,21 | 21 | 유리 살아 있음 |
//! | 〃 | NONE(1) | 38,15,30 | 15,34,38 | 18,18,18 | **23** | **벽지가 생으로 비침** |
//!
//! 두 셸의 **실패 모양이 다르다**는 게 3.0의 핵심이다:
//!  - Electron은 재질이 죽으면 불투명 판(15,15,15)이 드러난다 — "진한 회색 사이드바".
//!  - 3.0은 `transparent(true)`라 재질이 죽으면 **벽지가 블러 없이 그대로 비친다**.
//!    글자 뒤로 아이콘·사진이 지나가 가독성이 무너진다(더 나쁜 실패).
//! 그래서 3.0은 (1) 재질을 되살리고, (2) 못 살리면 **불투명 폴백을 렌더러에 켜야** 한다.
//!
//! ## 무엇을 신호로 쓰는가 (그리고 무엇을 안 쓰는가)
//!
//! - `DWMWA_SYSTEMBACKDROP_TYPE`(38) 되읽기는 **"지금 그리고 있나"가 아니다** — 우리가
//!   써 넣은 값을 돌려줄 뿐이다. OS 투명 효과를 꺼도 3(ACRYLIC)이 그대로 나온다
//!   (docs/critic/glass-lab-electron.json 09~11번 상태). 그래서 이 값은 **누가 우리 뒤에서
//!   백드롭을 갈아 끼웠는지**(드리프트)를 잡는 용도로만 쓴다.
//! - `DwmGetColorizationColor`의 `pfOpaqueBlend`는 **이 컴퓨터에서 거짓말을 한다** —
//!   투명 효과가 켜져 있는데 `TRUE`(=불투명 블렌드)를 돌려준다(Win11 26200 실측).
//!   신호로 쓰지 않는다.
//! - **진실 소스 = WinRT `UISettings.AdvancedEffectsEnabled`.** 설정 앱의 "투명 효과"뿐
//!   아니라 배터리 절약·원격 세션까지 반영하는 단일 값이다(MS 권장 경로).
//!   못 만들면(구버전·WinRT 없음) 레지스트리 `EnableTransparency`로 내려간다.
//!
//! ## 무엇을 하는가
//!
//! 1. 창마다 `DWMSBT_TRANSIENTWINDOW`를 **재단언**한다 — 처음 한 번이 아니라,
//!    OS가 합성을 갈아엎을 만한 사건마다 다시.
//! 2. 사건은 창 서브클래스로 잡는다: `WM_SETTINGCHANGE`(테마·투명 효과) ·
//!    `WM_THEMECHANGED` · `WM_DWMCOMPOSITIONCHANGED` · `WM_DISPLAYCHANGE`(모니터 추가/제거) ·
//!    `WM_DPICHANGED` · `WM_WTSSESSION_CHANGE`(잠금/해제·사용자 전환) ·
//!    `WM_POWERBROADCAST`(절전 복귀) · `WM_ACTIVATE`(비활성 — 2.6.2 keepAcrylicWhenBlurred 자리).
//! 3. 그와 별개로 **주기 검증**(2초)이 백드롭 값과 전역 효과 상태를 확인한다.
//!    메시지를 놓쳐도 늦어도 2초 안에 복구된다.
//! 4. 전역 효과가 꺼져 있어 **되살릴 수 없을 때**만 렌더러에 `ui-glass:state`를 쏜다 →
//!    심(app/src/api/glassFallback.ts)이 `<html>`에 `ccg-glass-off`를 걸고 **의도된
//!    불투명 다크 배경**으로 갈아탄다. styles.css는 한 글자도 안 고친다.
//!
//! ## 채널을 ipc.rs에 등록하지 않는 이유
//!
//! `ui-glass:state`는 **셸 → 렌더러 단방향 브로드캐스트**다. `dispatch()` 항목이 필요 없고
//! (렌더러가 부르는 게 아니다), 그래서 M2가 분할 중인 ipc.rs를 건드리지 않는다.
//! 기존 `ui-glass:changed`(사용자의 '벽지 비침' 슬라이더 0~100)와는 **다른 채널**이다 —
//! 이름이 비슷하니 헷갈리지 말 것. 저건 사용자 취향, 이건 OS 상태다.

#![allow(dead_code)]

use serde_json::{json, Value};

/// 셸 → 렌더러 브로드캐스트. `ipc::ch::UI_GLASS_CHANGED`(슬라이더)와 **다른 채널**이다.
pub const UI_GLASS_STATE: &str = "ui-glass:state";

/// 유리가 꺼진 사유 — 렌더러는 문구를 만들지 않지만(폴백은 조용해야 한다) 진단에 남는다.
pub mod reason {
    /// OS 투명 효과가 꺼져 있다(설정 앱 · 배터리 절약 · 원격 세션)
    pub const EFFECTS_OFF: &str = "effects-off";
    /// 원격 데스크톱 세션 — DWM 재질이 원천적으로 안 온다
    pub const REMOTE_SESSION: &str = "remote-session";
    /// DwmSetWindowAttribute가 실패했다(재단언 불가)
    pub const ASSERT_FAILED: &str = "assert-failed";
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    pub fn arm(_app: &tauri::AppHandle, _win: &tauri::WebviewWindow) {}
    pub fn health() -> Value {
        json!({ "ok": true, "platform": "non-windows" })
    }
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
    use std::sync::{Condvar, Mutex, OnceLock};
    use std::time::Duration;
    use tauri::{AppHandle, Emitter, WebviewWindow};
    use windows::core::{BOOL, PCWSTR};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::Graphics::Dwm::{
        DwmGetWindowAttribute, DwmSetWindowAttribute, DWMSBT_TRANSIENTWINDOW, DWMWA_SYSTEMBACKDROP_TYPE,
        DWM_SYSTEMBACKDROP_TYPE,
    };
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
    use windows::Win32::System::RemoteDesktop::{
        WTSRegisterSessionNotification, WTSUnRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION,
    };
    use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, IsWindow, SM_REMOTESESSION};

    // ── 감시 대상 창 ────────────────────────────────────────────────────────
    // isize로 담는 이유: HWND는 Send가 아니다(스레드 경계를 못 넘는다). 값 자체는 그냥
    // 커널 핸들 숫자라, 감시 스레드에서 다시 HWND로 싸서 쓴다. 창이 죽었을 수 있으므로
    // 매번 IsWindow로 거른다 — 그게 dangling을 막는 유일한 검사다.
    static WINDOWS: Mutex<Vec<isize>> = Mutex::new(Vec::new());
    static APP: OnceLock<AppHandle> = OnceLock::new();

    /// 감시 스레드 깨우기 — 서브클래스 프로시저(UI 스레드)는 이 플래그만 세우고 즉시 돌아간다.
    /// UI 스레드에서 DWM 호출을 하지 않는 이유: WM_SETTINGCHANGE가 오는 그 순간에는 OS가
    /// 아직 상태를 다 바꾸지 않았을 수 있어 **너무 이른 재단언은 그냥 흘러간다**.
    /// 깨어난 감시 스레드가 60ms · 400ms · 1200ms 세 번에 나눠 단언한다.
    static WAKE: (Mutex<Option<&'static str>>, Condvar) = (Mutex::new(None), Condvar::new());

    static STARTED: AtomicBool = AtomicBool::new(false);
    /// 마지막으로 렌더러에 알린 상태(true = 유리 살아 있음). 변할 때만 쏜다.
    static LAST_OK: AtomicBool = AtomicBool::new(true);
    static REASSERTS: AtomicU64 = AtomicU64::new(0);
    static DRIFTS: AtomicU64 = AtomicU64::new(0);
    static LAST_DRIFT_VALUE: AtomicI64 = AtomicI64::new(-1);
    static ASSERT_FAILS: AtomicU64 = AtomicU64::new(0);

    const SUBCLASS_ID: usize = 0x67_6C_73_73; // 'glss'

    // 서브클래스가 노리는 메시지들 (windows 크레이트가 상수를 안 주는 것은 직접 적는다)
    const WM_ACTIVATE: u32 = 0x0006;
    const WM_SETTINGCHANGE: u32 = 0x001A;
    const WM_DISPLAYCHANGE: u32 = 0x007E;
    const WM_POWERBROADCAST: u32 = 0x0218;
    const WM_WTSSESSION_CHANGE: u32 = 0x02B1;
    const WM_DPICHANGED: u32 = 0x02E0;
    const WM_THEMECHANGED: u32 = 0x031A;
    const WM_DWMCOMPOSITIONCHANGED: u32 = 0x031E;
    const WM_DWMCOLORIZATIONCOLORCHANGED: u32 = 0x0320;
    const WM_NCDESTROY: u32 = 0x0082;
    const WA_INACTIVE: usize = 0;

    /// 검증 주기 — **싼 검사**(DWM 속성 읽기/쓰기)의 간격. 메시지를 하나도 못 받아도
    /// 이 간격 안에는 반드시 제자리로 돌아온다.
    ///
    /// 실측(scripts/poc-glass/glass.ps1 -Action knock): 2초로 뒀을 때 밖에서 백드롭을
    /// 걷어차면 복구까지 평균 1166ms(최대 1599ms)가 걸렸다 — 눈에 보이는 번쩍임이다.
    /// 700ms로 내리면 평균이 그 절반 이하가 된다. 비용은 창당 `DwmGetWindowAttribute` +
    /// `DwmSetWindowAttribute` 한 쌍(둘 다 로컬 호출)이라 무시할 만하다.
    const VERIFY: Duration = Duration::from_millis(700);
    /// **비싼 검사**(WinRT `UISettings` 활성화 + 레지스트리)의 간격. 전역 투명 효과는
    /// 사람이 바꾸는 값이라 초 단위로 볼 이유가 없고, 진짜로 바뀌면 `WM_SETTINGCHANGE`가
    /// 먼저 와서 즉시 깨운다. 그래서 폴링은 "메시지를 놓쳤을 때의 안전망"으로만 둔다.
    const PROBE_EVERY: Duration = Duration::from_secs(4);
    /// 사건 뒤 재단언 시각들 — DWM이 합성을 다시 세우는 데 걸리는 시간이 일정하지 않아
    /// 한 번만 쏘면 놓친다(2.6.2가 blur 뒤 50ms 하나로 잡았던 자리를 셋으로 늘린 것).
    const AFTER_EVENT_MS: [u64; 3] = [60, 400, 1200];

    // ── 전역 효과 상태 ──────────────────────────────────────────────────────

    /// WinRT 진실 소스. 스레드 아파트가 서야 하므로 감시 스레드에서만 부른다.
    fn advanced_effects_enabled() -> Option<bool> {
        use windows::UI::ViewManagement::UISettings;
        UISettings::new().ok()?.AdvancedEffectsEnabled().ok()
    }

    /// 폴백 — 설정 앱이 쓰는 레지스트리 값. 배터리 절약은 **반영하지 않는다**(그래서 2순위).
    fn reg_transparency() -> Option<bool> {
        let sub: Vec<u16> = "Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize\0"
            .encode_utf16()
            .collect();
        let name: Vec<u16> = "EnableTransparency\0".encode_utf16().collect();
        let mut val: u32 = 0;
        let mut cb: u32 = 4;
        let err = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                PCWSTR(sub.as_ptr()),
                PCWSTR(name.as_ptr()),
                RRF_RT_REG_DWORD,
                None,
                Some(&mut val as *mut u32 as *mut core::ffi::c_void),
                Some(&mut cb),
            )
        };
        if err.is_ok() {
            Some(val != 0)
        } else {
            None
        }
    }

    fn remote_session() -> bool {
        unsafe { GetSystemMetrics(SM_REMOTESESSION) != 0 }
    }

    /// 지금 이 OS에서 아크릴이 **그려질 수 있는가**. 못 그리면 렌더러가 폴백으로 간다.
    /// 세 신호 중 하나라도 "안 된다"면 안 되는 것으로 본다(거짓 안심보다 거짓 폴백이 낫다 —
    /// 폴백은 그냥 불투명 다크 배경이라 잘못 켜져도 못생기지 않는다).
    fn glass_possible() -> (bool, &'static str) {
        // 테스트 레버 — 폴백 화면을 **OS 전역 설정을 건드리지 않고** 켜 본다.
        // 사용자 데스크톱의 투명 효과를 끄는 건 금지 규약이라, 그것 말고는 폴백 경로를
        // 실행해 볼 방법이 없다(원격 세션을 만들 수도 없다).
        //   CCG_GLASS_FORCE_OFF=1 ./agentcodegui.exe   → 유리 폴백이 켜진 화면
        // 기본값에서는 아무 일도 하지 않는다(변수가 없으면 그냥 통과).
        if std::env::var("CCG_GLASS_FORCE_OFF").is_ok_and(|v| v != "0") {
            return (false, super::reason::EFFECTS_OFF);
        }
        if remote_session() {
            return (false, super::reason::REMOTE_SESSION);
        }
        match advanced_effects_enabled().or_else(reg_transparency) {
            Some(false) => (false, super::reason::EFFECTS_OFF),
            // 둘 다 못 읽으면 "된다"고 본다 — 폴백을 상시로 켜는 사고를 막는다.
            _ => (true, ""),
        }
    }

    // ── 백드롭 단언 ─────────────────────────────────────────────────────────

    fn read_backdrop(hwnd: HWND) -> Option<i32> {
        let mut v: i32 = 0;
        let ok = unsafe {
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_SYSTEMBACKDROP_TYPE,
                &mut v as *mut i32 as *mut core::ffi::c_void,
                4,
            )
        };
        ok.ok().map(|_| v)
    }

    /// `DWMSBT_TRANSIENTWINDOW`를 써 넣는다. 이미 3이어도 다시 쓴다 — **값이 3인데 안 그리는**
    /// 상태(합성이 갈아엎힌 뒤)가 실재하고, 그때 되살리는 유일한 방법이 재기록이기 때문이다.
    fn assert_backdrop(hwnd: HWND) -> bool {
        let v: DWM_SYSTEMBACKDROP_TYPE = DWMSBT_TRANSIENTWINDOW;
        let r = unsafe {
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_SYSTEMBACKDROP_TYPE,
                &v as *const DWM_SYSTEMBACKDROP_TYPE as *const core::ffi::c_void,
                4,
            )
        };
        match r {
            Ok(()) => {
                REASSERTS.fetch_add(1, Ordering::Relaxed);
                true
            }
            Err(_) => {
                ASSERT_FAILS.fetch_add(1, Ordering::Relaxed);
                false
            }
        }
    }

    /// 살아 있는 감시 대상 전부에 단언. 죽은 창은 목록에서 걷는다.
    /// 반환 = 한 창이라도 단언에 실패했나.
    fn assert_all() -> bool {
        let mut list = WINDOWS.lock().unwrap();
        let mut failed = false;
        list.retain(|&h| {
            let hwnd = HWND(h as *mut core::ffi::c_void);
            if !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
                return false;
            }
            // 드리프트 기록 — 우리가 아닌 누군가가 값을 바꿨다면 그건 알아야 할 사건이다.
            if let Some(cur) = read_backdrop(hwnd) {
                if cur != DWMSBT_TRANSIENTWINDOW.0 {
                    DRIFTS.fetch_add(1, Ordering::Relaxed);
                    LAST_DRIFT_VALUE.store(cur as i64, Ordering::Relaxed);
                }
            }
            if !assert_backdrop(hwnd) {
                failed = true;
            }
            true
        });
        failed
    }

    // ── 렌더러 통지 ─────────────────────────────────────────────────────────

    fn emit_state(ok: bool, why: &str, force: bool) {
        if !force && LAST_OK.swap(ok, Ordering::Relaxed) == ok {
            return;
        }
        LAST_OK.store(ok, Ordering::Relaxed);
        let Some(app) = APP.get() else { return };
        let _ = app.emit(
            UI_GLASS_STATE,
            json!({
                "ok": ok,
                "reason": if ok { "" } else { why },
                "reasserts": REASSERTS.load(Ordering::Relaxed),
                "drifts": DRIFTS.load(Ordering::Relaxed),
            }),
        );
    }

    // ── 창 서브클래스 ───────────────────────────────────────────────────────

    fn wake(why: &'static str) {
        let (lock, cv) = &WAKE;
        if let Ok(mut g) = lock.lock() {
            *g = Some(why);
            cv.notify_all();
        }
    }

    unsafe extern "system" fn subclass_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        match msg {
            // 테마/투명 효과/색 — 전역 효과가 바뀌는 대표 경로
            WM_SETTINGCHANGE | WM_THEMECHANGED | WM_DWMCOLORIZATIONCOLORCHANGED => wake("setting-change"),
            // DWM 합성이 통째로 다시 섰다(드라이버 리셋·explorer 재시작 등)
            WM_DWMCOMPOSITIONCHANGED => wake("dwm-composition"),
            // 모니터 추가/제거·해상도 변경 — 이 컴퓨터에서 실제로 모니터 수가 2→1로 바뀐 이력이 있다
            WM_DISPLAYCHANGE | WM_DPICHANGED => wake("display-change"),
            // 잠금/해제·사용자 전환 — 세션이 돌아올 때 재질이 안 돌아오는 사례
            WM_WTSSESSION_CHANGE => wake("session-change"),
            // 절전/최대 절전 복귀
            WM_POWERBROADCAST => wake("power"),
            // 비활성 전환 — 2.6.2 keepAcrylicWhenBlurred가 잡던 자리
            WM_ACTIVATE if (wparam.0 & 0xFFFF) == WA_INACTIVE => wake("blur"),
            WM_NCDESTROY => {
                // 서브클래스를 남겨 두면 파괴 뒤 프로시저가 불릴 수 있다
                let _ = unsafe { WTSUnRegisterSessionNotification(hwnd) };
                let _ = unsafe { RemoveWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID) };
                if let Ok(mut l) = WINDOWS.lock() {
                    let h = hwnd.0 as isize;
                    l.retain(|&x| x != h);
                }
            }
            _ => {}
        }
        unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
    }

    // ── 감시 스레드 ─────────────────────────────────────────────────────────

    fn spawn_watchdog() {
        if STARTED.swap(true, Ordering::SeqCst) {
            return;
        }
        std::thread::spawn(move || {
            // WinRT(UISettings) 활성화에 아파트가 필요하다. 이 스레드는 UI가 아니므로 MTA.
            // 이미 초기화돼 있으면 S_FALSE가 오고 그래도 문제없다.
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            }

            // 부팅 직후 세 번은 무조건 상태를 쏜다 — 렌더러 리스너가 붙기 전에 한 번 쏘고
            // 끝나면 첫 화면이 틀린 채로 남는다(구독은 비동기라 공백이 있다).
            let boot = [250u64, 1000, 3000];
            let mut boot_i = 0usize;
            let mut next_boot = std::time::Instant::now() + Duration::from_millis(boot[0]);
            // 비싼 검사의 마지막 결과 — 사건이 오거나 PROBE_EVERY가 지날 때만 새로 잰다
            let mut last_probe = std::time::Instant::now() - PROBE_EVERY;
            let mut possible = true;
            let mut why_off = "";

            loop {
                // 사건 대기 — 없으면 VERIFY 간격으로 스스로 깬다.
                //
                // **이미 들어와 있는 사건을 먼저 본다**: `notify_all`이 이 스레드가 대기
                // 중이 아닐 때(직전 사건의 60/400/1200ms 슬립 중이거나 단언 중) 오면
                // 조건변수 신호는 그냥 사라진다 — 플래그만 남는다. 조건 검사 없이 바로
                // wait_timeout에 들어가면 그 사건이 VERIFY(700ms)만큼 늦게 처리된다.
                // 실측으로 잡은 자리다: 넛지 경로 8회 중 1회가 73ms가 아니라 693ms였다.
                let why = {
                    let (lock, cv) = &WAKE;
                    let mut g = lock.lock().unwrap();
                    if g.is_none() {
                        let (g2, _t) = cv.wait_timeout(g, VERIFY).unwrap();
                        g = g2;
                    }
                    g.take()
                };

                if why.is_some() {
                    // 사건 직후 — 세 박자로 나눠 단언한다(한 번은 늘 너무 이르다).
                    // OS가 상태를 다 바꾸기 전에 쓴 값은 그냥 흘러가므로 한 번으로는 못 잡는다.
                    for ms in AFTER_EVENT_MS {
                        std::thread::sleep(Duration::from_millis(ms));
                        assert_all();
                    }
                }

                let failed = assert_all();

                // 전역 효과 판정은 **사건이 왔을 때 + 주기적으로만**. 매 700ms마다 WinRT
                // 객체를 만들 이유가 없다(값이 사람 손으로만 바뀐다).
                let now = std::time::Instant::now();
                if why.is_some() || now.duration_since(last_probe) >= PROBE_EVERY {
                    let (p, w) = glass_possible();
                    possible = p;
                    why_off = w;
                    last_probe = now;
                }

                let ok = possible && !failed;
                let reason = if !possible {
                    why_off
                } else {
                    super::reason::ASSERT_FAILED
                };

                let force = if boot_i < boot.len() && std::time::Instant::now() >= next_boot {
                    boot_i += 1;
                    if boot_i < boot.len() {
                        next_boot = std::time::Instant::now() + Duration::from_millis(boot[boot_i]);
                    }
                    true
                } else {
                    false
                };
                emit_state(ok, reason, force);

                // 감시할 창이 하나도 안 남으면 스레드를 끝낸다(앱 종료 경로)
                if WINDOWS.lock().unwrap().is_empty() && APP.get().is_some() {
                    // 창 재생성(크래시 복구)에 대비해 바로 끝내지 않고 한 박자 더 본다
                    std::thread::sleep(Duration::from_secs(2));
                    if WINDOWS.lock().unwrap().is_empty() {
                        STARTED.store(false, Ordering::SeqCst);
                        return;
                    }
                }
            }
        });
    }

    // ── 진입점 ──────────────────────────────────────────────────────────────

    /// 창 하나를 유리 감시에 올린다. **창을 만든 스레드에서** 불러야 한다
    /// (SetWindowSubclass는 창 소유 스레드 전용).
    pub fn arm(app: &AppHandle, win: &WebviewWindow) {
        let _ = APP.set(app.clone());
        let Ok(raw) = win.hwnd() else { return };
        let hwnd = HWND(raw.0 as *mut core::ffi::c_void);

        // 즉시 한 번 — tauri의 effects()가 이미 걸어 두었어도 멱등이다
        assert_backdrop(hwnd);

        unsafe {
            let _: BOOL = SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, 0);
            // 잠금/해제·사용자 전환을 이 창이 받도록. 실패해도(정책·권한) 나머지는 그대로 산다.
            let _ = WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION);
        }

        WINDOWS.lock().unwrap().push(hwnd.0 as isize);
        spawn_watchdog();
    }

    /// 진단용 스냅샷 — 창 감시 수·재단언/드리프트 카운터·현재 OS 판정.
    /// (지금은 로그·PoC 전용. IPC 노출은 M2의 채널 분할이 끝난 뒤에 얹는다.)
    pub fn health() -> Value {
        let list = WINDOWS.lock().unwrap();
        let backdrops: Vec<i64> = list
            .iter()
            .map(|&h| {
                read_backdrop(HWND(h as *mut core::ffi::c_void))
                    .map(|v| v as i64)
                    .unwrap_or(-1)
            })
            .collect();
        let (possible, why) = glass_possible();
        json!({
            "ok": possible,
            "reason": if possible { "" } else { why },
            "windows": list.len(),
            "backdrops": backdrops,
            "reasserts": REASSERTS.load(Ordering::Relaxed),
            "drifts": DRIFTS.load(Ordering::Relaxed),
            "lastDrift": LAST_DRIFT_VALUE.load(Ordering::Relaxed),
            "assertFails": ASSERT_FAILS.load(Ordering::Relaxed),
            "advancedEffects": advanced_effects_enabled(),
            "regTransparency": reg_transparency(),
            "remoteSession": remote_session(),
        })
    }

    /// 크래시 복구가 창을 전부 부수고 다시 만들 때 — 목록을 비운다(win.rs `reset_shown` 짝).
    pub fn clear() {
        WINDOWS.lock().unwrap().clear();
    }
}

pub use imp::*;
