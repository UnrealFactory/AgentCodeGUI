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
//! 3. 그와 별개로 **주기 검증**(`VERIFY` = 700ms)이 백드롭 값과 전역 효과 상태를 확인한다.
//!    메시지를 놓쳐도 늦어도 그 주기 안에 복구된다(실측 평균 346.6ms — R1 크리틱 §1.1).
//! 4. 렌더러에 `ui-glass:state`를 쏜다 → 심(app/src/api/glassFallback.ts)이 `<html>`에
//!    `ccg-glass-off`를 걸거나 뗀다. styles.css는 한 글자도 안 고친다.
//!
//! ## R2 — 기본값 반전: **"살아 있음을 증명해야 투명"**
//!
//! R1까지는 *꺼짐을 증명해야* 폴백이 켜졌다. 그 구조에서는 증명하지 못하는 실패
//! (§"값은 3인데 안 그린다")와 **통지가 닿지 않는 문서**가 전부 최악(글자 뒤 벽지)에 남는다.
//! R1 크리틱이 실증한 통지 구멍이 그 증거다 — 폴백은 **부팅 순간에 존재하던 문서에만**
//! 걸렸다(`location.reload()` 후·나중에 연 추가 채팅 창·크래시 복구 재생성 창 = `events:0`).
//! 원인은 구조였다: `emit_state`가 **전이할 때만** 쏘고, 그 공백을 메우는 부팅 3연발이
//! **프로세스당 1회**였다(`boot_i`). 그래서 R2는 두 가지를 함께 바꿨다.
//!
//! - **도달(모든 문서).** `boot_script()`가 만드는 document-start 스크립트를 win.rs가
//!   모든 창에 심는다. `initialization_script`는 **그 웹뷰의 페이지 로드마다 다시 돌므로**
//!   재로드·새 창·크래시 복구 재생성이 공짜로 덮인다. 거기에 `note_document()`가
//!   문서마다 재발신(+`RESEND_MS` 동안 매 틱 재발신)을 얹어 구독 등록 지연까지 메운다.
//! - **기본값.** 그 스크립트는 **먼저 무조건 폴백을 걸고**, 스냅샷이 "살아 있음"을 증명한
//!   때에만 **같은 태스크 안에서** 걷는다. 증명이 없으면(스크립트 실패·스냅샷 없음·판정 불가)
//!   결과는 "의도된 불투명"이지 "글자 뒤 벽지"가 아니다. 증명이 같은 태스크에 있으므로
//!   정상 경로에서 화면에 올라가는 불투명 프레임은 **0장**이다(깜빡임 없음).
//!
//! ## 채널을 ipc.rs에 등록하지 않는 이유
//!
//! `ui-glass:state`는 **셸 → 렌더러 단방향 브로드캐스트**다. `dispatch()` 항목이 필요 없고
//! (렌더러가 부르는 게 아니다), 그래서 M2가 분할 중인 ipc.rs를 건드리지 않는다.
//! 기존 `ui-glass:changed`(사용자의 '벽지 비침' 슬라이더 0~100)와는 **다른 채널**이다 —
//! 이름이 비슷하니 헷갈리지 말 것. 저건 사용자 취향, 이건 OS 상태다.
//!
//! **풀(pull) 경로가 없는 대신** 부팅 페이로드(win.rs `boot_payload_script`)에 같은 채널
//! 키로 스냅샷을 싣는다 — 렌더러가 물어보지 않아도 문서마다 값이 이미 와 있다.
//!
//! ## 진단 (§"부팅 값에 얼어 있다" 대응)
//!
//! - 발신 payload는 `reasserts`·`drifts`·`lastDrift`·`assertFails`를 **발신 시점 값으로**
//!   담고, `drifts`가 늘면 그 자체가 발신 사유가 된다(전이가 없어도). 그래서
//!   `window.__ccgGlass.state`가 부팅 숫자에 얼지 않는다.
//! - 드리프트 사건은 앱 홈 `glass.log`에 한 줄 JSON으로 남는다(crash.rs 로그 규약과 같은 모양).
//!   IPC 없이, 재발 순간의 트리거를 특정하려는 ui-glass.md §5 관측기와 같은 목적이다.

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
    /// 백드롭을 써 넣었는데 **되읽기가 3이 아니다** — 살아 있음이 증명되지 않았다.
    pub const NOT_VERIFIED: &str = "not-verified";
    /// 아직 아무 판정도 없다 — 기본값 반전(R2)의 착지점. 증명 전에는 언제나 불투명이다.
    pub const UNPROVEN: &str = "unproven";
}

// ── 렌더러 폴백 CSS (문서 생성 시점에 심는 정본) ─────────────────────────────
//
// **app/src/api/glassFallback.ts와 같은 값이어야 한다.** 두 벌인 이유는 시점이 다르기
// 때문이다: 이 CSS는 **문서가 만들어지는 그 순간**(document-start)에 있어야 하고
// (렌더러 번들은 그보다 한참 뒤다 — 그 사이에 이미 첫 픽셀이 올라간다), 번들 쪽에도
// 정본이 있어야 셸 주입이 실패한 경우에도 폴백이 산다.
// 두 벌이 조용히 갈라지는 것은 렌더러가 막는다 — `ensureStyle()`이 심어진 스타일에
// 팔레트 두 값이 들어 있는지 검사하고, 없으면 자기 값으로 덮어쓴다(drift 가드).

/// `<html>`에 거는 클래스. glassFallback.ts `CLASS`와 같아야 한다.
pub const FALLBACK_CLASS: &str = "ccg-glass-off";
/// 주입 `<style>`의 id. glassFallback.ts `STYLE_ID`와 같아야 한다.
pub const FALLBACK_STYLE_ID: &str = "ccg-glass-fallback";

const FALLBACK_CSS: &str = r#"
/* 유리 폴백 — 셸이 문서 생성 시점에 심는다 (src-tauri/src/glass.rs boot_script) */
html.ccg-glass-off{
  background: var(--desktop, #101010) !important;
}
html.ccg-glass-off body{
  --panel: #1d1d1d !important;
  --chat-bg: #141414 !important;
  background-image:
    radial-gradient(1180px 640px at 10% -10%, rgba(255,255,255,.042), rgba(255,255,255,0) 62%),
    linear-gradient(180deg, rgba(255,255,255,.013), rgba(255,255,255,0) 34%) !important;
}
html.ccg-glass-off{
  --panel: #1d1d1d !important;
  --chat-bg: #141414 !important;
}
"#;

/// document-start 부트스트랩. `__CCG_GLASS_SNAP__` / `__CCG_GLASS_CSS__`를 치환해 쓴다.
/// `format!`을 안 쓰는 이유: CSS·JS에 중괄호가 가득해 전부 이스케이프해야 한다.
const BOOT_JS: &str = r#";(function () {
  if (window.__ccgGlassBoot) return
  var SNAP = __CCG_GLASS_SNAP__
  var CSS = __CCG_GLASS_CSS__
  var CLASS = '__CCG_GLASS_CLASS__'
  var ID = '__CCG_GLASS_STYLE_ID__'
  window.__ccgGlassBoot = SNAP
  /* R2 기본값 반전 — "살아 있음을 증명해야 투명".
     스냅샷이 ok:true를 증명하지 못하면(없음·false·형태가 다름) 폴백에 착지한다.
     증명이 있으면 **같은 태스크 안에서** 걷으므로 화면에 올라가는 불투명 프레임은 0장이다. */
  var alive = !!(SNAP && SNAP.ok === true)
  /* 스냅샷은 **창을 만든 순간**의 값이라, 같은 웹뷰를 다시 세우는 재로드에서는 낡아 있다
     — 그리고 그 재로드가 크래시 복구의 1순위 경로다(crash.rs `reload_all`). 직전 문서가
     남긴 마지막 판정을 sessionStorage에서 받아 **둘을 AND** 한다. AND인 이유는 어느 쪽이
     더 새 것인지 문서 쪽에서 확실히 알 수 없기 때문이다 — AND는 어느 경우에도 "증명된
     것보다 더 투명해지지 않는" 방향이라 R2의 규칙과 같은 편이다. 잘못 불투명해진 경우는
     셸의 문서 통지(note_document)가 곧바로 되돌린다. */
  try {
    var prev = JSON.parse(sessionStorage.getItem('ccg.glass.last') || 'null')
    if (prev && typeof prev.ok === 'boolean') {
      alive = alive && prev.ok
      if (SNAP) SNAP.prev = prev
    }
  } catch (e) {
    /* 저장소가 막혀 있으면 스냅샷만으로 간다 */
  }
  /* **판정 결과를 남긴다.** 렌더러 번들(glassFallback.ts)이 나중에 같은 스냅샷을 다시
     읽는데, 거기서 raw `ok`만 보면 위의 AND를 되돌려 버린다(실측으로 밟은 함정:
     문서가 6ms에 폴백으로 섰다가 45ms에 스냅샷만 보고 투명으로 돌아갔다). */
  if (SNAP) SNAP.resolvedOk = alive
  function now() { try { return Math.round(performance.now() * 100) / 100 } catch (e) { return -1 } }
  function apply() {
    var de = document.documentElement
    if (!de) return false
    de.classList.add(CLASS)
    /* 진단 — 이 문서에서 폴백이 걸려 있던 시간. tOff가 없으면 폴백으로 착지한 것이고,
       tOff - tOn 이 같은 태스크 안(≈0ms)이면 화면에 올라간 불투명 프레임이 0장이다. */
    if (SNAP) SNAP.tOn = now()
    try {
      if (!document.getElementById(ID)) {
        var s = document.createElement('style')
        s.id = ID
        s.textContent = CSS
        ;(document.head || de).appendChild(s)
      }
    } catch (e) {
      /* 스타일을 못 심었으면 클래스만 남는다 — 렌더러 번들이 같은 id로 다시 심는다 */
    }
    if (alive) {
      de.classList.remove(CLASS)
      if (SNAP) SNAP.tOff = now()
    }
    return true
  }
  if (!apply()) {
    /* 아직 빈 문서다(documentElement 없음). 생기는 즉시 = 첫 픽셀보다 먼저 건다. */
    try {
      var mo = new MutationObserver(function () { if (apply()) mo.disconnect() })
      mo.observe(document, { childList: true, subtree: true })
    } catch (e) {
      var t = setInterval(function () { if (apply()) clearInterval(t) }, 1)
    }
  }
})();"#;

/// 창마다 심는 document-start 스크립트(win.rs `initialization_script`).
/// 페이지 로드마다 다시 도므로 **재로드·나중에 연 창·크래시 복구 재생성**이 함께 덮인다.
pub fn boot_script() -> String {
    let snap = serde_json::to_string(&boot_state()).unwrap_or_else(|_| "null".into());
    let css = serde_json::to_string(FALLBACK_CSS).unwrap_or_else(|_| "\"\"".into());
    BOOT_JS
        .replace("__CCG_GLASS_SNAP__", &snap)
        .replace("__CCG_GLASS_CSS__", &css)
        .replace("__CCG_GLASS_CLASS__", FALLBACK_CLASS)
        .replace("__CCG_GLASS_STYLE_ID__", FALLBACK_STYLE_ID)
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    pub fn arm(_app: &tauri::AppHandle, _win: &tauri::WebviewWindow) {}
    pub fn clear() {}
    pub fn note_document(_label: &str) {}
    pub fn health() -> Value {
        json!({ "ok": true, "platform": "non-windows" })
    }
    pub fn boot_state() -> Value {
        json!({ "ok": true, "reason": "", "platform": "non-windows" })
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
    /// 마지막으로 렌더러에 알린 상태(true = 유리 살아 있음).
    ///
    /// **초기값이 false인 것이 R2 기본값 반전의 자리다.** true로 두면 "유리가 죽었다"는
    /// 첫 판정이 전이로 보이지 않아 발신이 생략될 수 있다 — 증명 전에는 꺼진 것으로 센다.
    static LAST_OK: AtomicBool = AtomicBool::new(false);
    /// 마지막으로 발신에 담은 드리프트 수. 이 값이 뒤처지면 전이가 없어도 다시 쏜다
    /// (진단이 부팅 값에 어는 것을 막는 자리 — R1 크리틱 §3.3).
    static LAST_EMITTED_DRIFTS: AtomicU64 = AtomicU64::new(0);
    static REASSERTS: AtomicU64 = AtomicU64::new(0);
    static DRIFTS: AtomicU64 = AtomicU64::new(0);
    static LAST_DRIFT_VALUE: AtomicI64 = AtomicI64::new(-1);
    static ASSERT_FAILS: AtomicU64 = AtomicU64::new(0);
    static EMITS: AtomicU64 = AtomicU64::new(0);

    /// 감시 스레드가 낸 마지막 판정(비싼 검사 포함). 문서 통지·부팅 스냅샷이 이 값을 읽는다 —
    /// 그 두 경로는 UI 스레드라 WinRT를 새로 켜지 않는 것이 옳다.
    static PROBED: AtomicBool = AtomicBool::new(false);
    static CUR_OK: AtomicBool = AtomicBool::new(false);
    static CUR_WHY: Mutex<&'static str> = Mutex::new(super::reason::UNPROVEN);
    /// 문서가 새로 섰다 → 이 시각(단조 ms)까지는 매 틱 강제 재발신한다.
    /// `listen()`은 비동기 등록이라 문서 직후에 공백이 있고, 그 공백에 딱 한 번 쏘면
    /// 그 문서는 영영 못 받는다(R1이 실증한 events:0의 다른 얼굴).
    static RESEND_UNTIL: AtomicI64 = AtomicI64::new(0);
    const RESEND_MS: i64 = 6_000;
    /// 문서당 재발신 열차. 프로세스당 1회인 부팅 3연발과 **같은 이유**이고(구독은 비동기
    /// 등록이라 문서마다 공백이 생긴다) 같은 모양을 문서마다 준다. 감시 스레드의 700ms
    /// 틱에만 맡기면 구독이 붙은 직후의 공백이 최대 700ms 남는다 — 폴백으로 착지한 문서가
    /// 그만큼 더 불투명하게 서 있는다(실측으로 밟은 자리).
    const DOC_BURST_MS: [u64; 7] = [0, 150, 350, 700, 1200, 2000, 3000];
    /// 마지막 정상 검증 시각(단조 ms) — 드리프트를 "언제부터 떠 있었을 수 있나"의 상한으로 쓴다.
    static LAST_VERIFY_AT: AtomicI64 = AtomicI64::new(0);
    /// glass.log 드리프트 줄 접기(1초에 한 줄) — 적대 루프에서 934줄이 되지 않게.
    static DRIFT_LOG_AT: AtomicI64 = AtomicI64::new(-100_000);
    static DRIFT_LOG_HELD: AtomicU64 = AtomicU64::new(0);

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

    // ── 시각 · 로그 ─────────────────────────────────────────────────────────

    /// 프로세스 기준 단조 ms. 시스템 시계 변경(시간대·NTP)에 안 흔들려야 간격 계산이 산다.
    fn mono_ms() -> i64 {
        static T0: OnceLock<std::time::Instant> = OnceLock::new();
        T0.get_or_init(std::time::Instant::now).elapsed().as_millis() as i64
    }

    fn epoch_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    static LOG_LOCK: Mutex<()> = Mutex::new(());
    /// 상한 — 적대적 입력(밖에서 25ms마다 걷어차기)에서도 파일이 커지지 않게.
    const LOG_CAP: u64 = 256 * 1024;

    /// 사건을 앱 홈 `glass.log`에 한 줄 JSON으로. crash.rs의 로그 규약과 같은 모양이고
    /// **IPC를 쓰지 않는다** — 사용자가 증상을 다시 겪었을 때 보내올 수 있는 유일한 물증이다.
    fn log_line(event: &str, detail: Value) {
        let line = json!({
            "at": epoch_ms(),
            "mono": mono_ms(),
            "event": event,
            "pid": std::process::id(),
            "detail": detail,
        });
        let path = ccg_store::app_home().join("glass.log");
        let _ = std::fs::create_dir_all(path.parent().unwrap_or(&path));
        use std::io::Write;
        let buf = format!("{line}\n");
        let _guard = LOG_LOCK.lock();
        if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > LOG_CAP {
            // 굴리지 않고 잘라 다시 쓴다 — 진단에 필요한 것은 **최근** 사건이다.
            let _ = std::fs::write(&path, b"" as &[u8]);
        }
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = f.write_all(buf.as_bytes());
        }
    }

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

    /// 부팅 스냅샷 전용 **싼 판정**. WinRT(`UISettings`) 활성화는 첫 호출이 밀리초 단위라
    /// 창 생성(=콜드 스타트 임계 경로)에서는 부르지 않는다. 레지스트리 읽기·원격 세션
    /// 검사·테스트 레버만 본다(전부 마이크로초).
    ///
    /// 배터리 절약처럼 레지스트리에 안 잡히는 사유는 **감시 스레드의 첫 판정**(창을 만든
    /// 직후 즉시 돈다)이 곧바로 덮는다. 메인 창은 그 시점에 아직 스플래시 뒤라 사용자에게
    /// 전환이 보이지 않고, 추가 채팅 창은 이미 `PROBED`가 서 있어 이 경로를 안 탄다.
    fn glass_possible_cheap() -> (bool, &'static str) {
        if std::env::var("CCG_GLASS_FORCE_OFF").is_ok_and(|v| v != "0") {
            return (false, super::reason::EFFECTS_OFF);
        }
        if remote_session() {
            return (false, super::reason::REMOTE_SESSION);
        }
        match reg_transparency() {
            Some(false) => (false, super::reason::EFFECTS_OFF),
            _ => (true, ""),
        }
    }

    fn set_cur(ok: bool, why: &'static str) {
        CUR_OK.store(ok, Ordering::Relaxed);
        if let Ok(mut g) = CUR_WHY.lock() {
            *g = if ok { "" } else { why };
        }
        PROBED.store(true, Ordering::Release);
    }

    fn cur() -> (bool, &'static str) {
        let why = CUR_WHY.lock().map(|g| *g).unwrap_or(super::reason::UNPROVEN);
        (CUR_OK.load(Ordering::Relaxed), why)
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

    /// 한 번의 검증 패스 결과.
    struct Pass {
        /// 한 창이라도 `DwmSetWindowAttribute`가 실패했나
        failed: bool,
        /// 값을 써 넣고 **되읽었는데 3이 아닌** 창이 있나 = 살아 있음이 증명되지 않았다
        unverified: bool,
        /// 이 패스에서 잡힌 드리프트 (hwnd, 걷어차인 값, 재기록 뒤 되읽은 값)
        drifted: Vec<(i64, i32, i64)>,
    }

    /// 살아 있는 감시 대상 전부에 단언. 죽은 창은 목록에서 걷는다.
    fn assert_all() -> Pass {
        let mut list = WINDOWS.lock().unwrap();
        let mut out = Pass { failed: false, unverified: false, drifted: Vec::new() };
        list.retain(|&h| {
            let hwnd = HWND(h as *mut core::ffi::c_void);
            if !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
                return false;
            }
            // 드리프트 기록 — 우리가 아닌 누군가가 값을 바꿨다면 그건 알아야 할 사건이다.
            let before = read_backdrop(hwnd);
            let drifted = before.is_some_and(|c| c != DWMSBT_TRANSIENTWINDOW.0);
            if let Some(c) = before {
                if drifted {
                    DRIFTS.fetch_add(1, Ordering::Relaxed);
                    LAST_DRIFT_VALUE.store(c as i64, Ordering::Relaxed);
                }
            }
            if !assert_backdrop(hwnd) {
                out.failed = true;
            }
            // 되읽기 — "썼다"와 "값이 섰다"는 다른 사실이다. R2의 기본값 반전은
            // **이 되읽기가 3일 때만** 투명을 허락한다(증명 없이는 불투명).
            let after = read_backdrop(hwnd);
            if after != Some(DWMSBT_TRANSIENTWINDOW.0) {
                out.unverified = true;
            }
            if drifted {
                out.drifted.push((h as i64, before.unwrap_or(-1), after.map(|v| v as i64).unwrap_or(-1)));
            }
            true
        });
        out
    }

    // ── 렌더러 통지 ─────────────────────────────────────────────────────────

    fn state_json(ok: bool, why: &str) -> Value {
        json!({
            "ok": ok,
            "reason": if ok { "" } else { why },
            "reasserts": REASSERTS.load(Ordering::Relaxed),
            "drifts": DRIFTS.load(Ordering::Relaxed),
            "lastDrift": LAST_DRIFT_VALUE.load(Ordering::Relaxed),
            "assertFails": ASSERT_FAILS.load(Ordering::Relaxed),
            "windows": WINDOWS.lock().map(|l| l.len()).unwrap_or(0),
            "seq": EMITS.load(Ordering::Relaxed) + 1,
            "mono": mono_ms(),
        })
    }

    /// 렌더러로 상태 발신. 세 가지 중 하나면 쏜다:
    ///  1. `ok`가 전이했다 — 원래의 유일한 사유,
    ///  2. `drifts`가 늘었다 — 값이 안 변해도 **진단은 변했다**(§3.3: 부팅 값에 어는 자리),
    ///  3. `force` — 문서가 새로 섰거나(`note_document`) 그 직후 재발신 창 안이다.
    ///
    /// **`WINDOWS` 락을 쥔 채로 부르면 안 된다**(`state_json`이 같은 락을 잡는다).
    fn emit_state(ok: bool, why: &str, force: bool) {
        let d = DRIFTS.load(Ordering::Relaxed);
        let changed = LAST_OK.load(Ordering::Relaxed) != ok;
        let drift_changed = LAST_EMITTED_DRIFTS.load(Ordering::Relaxed) != d;
        if !force && !changed && !drift_changed {
            return;
        }
        LAST_OK.store(ok, Ordering::Relaxed);
        LAST_EMITTED_DRIFTS.store(d, Ordering::Relaxed);
        let payload = state_json(ok, why);
        if changed {
            log_line("state", payload.clone());
        }
        EMITS.fetch_add(1, Ordering::Relaxed);
        let Some(app) = APP.get() else { return };
        let _ = app.emit(UI_GLASS_STATE, payload);
    }

    /// 문서가 하나 섰다(win.rs `on_page_load(Finished)` — 재로드마다 다시 온다).
    ///
    /// 부팅 3연발은 **프로세스당 1회**라(`boot_i`) 이게 없으면 재로드·나중에 연 창·크래시
    /// 복구 재생성 창은 통지를 영영 못 받는다(R1 크리틱 §3.1 실증 `events:0`).
    /// document-start 스냅샷이 이미 화면을 맞춰 두지만, 그 뒤로 상태가 바뀌었을 수 있으므로
    /// **지금 값**을 한 번 쏘고 `RESEND_MS` 동안 매 틱 다시 쏜다(구독 등록 지연 흡수).
    pub fn note_document(_label: &str) {
        RESEND_UNTIL.store(mono_ms() + RESEND_MS, Ordering::Relaxed);
        // 감시 스레드를 깨워 재검증 + 재발신 창을 즉시 돌게 한다.
        wake("document");
        if !PROBED.load(Ordering::Acquire) {
            return;
        }
        // 이 스레드는 창 소유(UI) 스레드다 — 여기서 자면 안 된다. 열차는 따로 태운다.
        std::thread::spawn(|| {
            let mut prev = 0u64;
            for at in DOC_BURST_MS {
                // 절댓값 시각이다(누적 아님) — 델타로 자야 표가 읽는 대로 찍힌다.
                if at > prev {
                    std::thread::sleep(Duration::from_millis(at - prev));
                    prev = at;
                }
                let (ok, why) = cur();
                emit_state(ok, why, true);
            }
        });
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
            // **이건 프로세스당 1회다.** 문서당 보장은 `note_document()`가 맡는다(R2).
            let boot = [250u64, 1000, 3000];
            let mut boot_i = 0usize;
            let mut next_boot = std::time::Instant::now() + Duration::from_millis(boot[0]);
            // 비싼 검사의 마지막 결과 — 사건이 오거나 PROBE_EVERY가 지날 때만 새로 잰다
            let mut last_probe = std::time::Instant::now();

            // **첫 판정을 루프 전에 낸다.** 기본값 반전(R2) 뒤에는 판정이 늦는 만큼
            // 문서가 불투명으로 서 있는 시간이 길어진다 — 첫 창의 판정이 여기서 난다.
            // (부팅 스냅샷은 싼 판정만 썼다. 여기가 그것을 WinRT 진실 소스로 덮는 자리다.)
            let (mut possible, mut why_off) = {
                let (p, w) = glass_possible();
                let pass = assert_all();
                let ok = p && !pass.failed && !pass.unverified;
                set_cur(
                    ok,
                    if !p {
                        w
                    } else if pass.failed {
                        super::reason::ASSERT_FAILED
                    } else {
                        super::reason::NOT_VERIFIED
                    },
                );
                LAST_VERIFY_AT.store(mono_ms(), Ordering::Relaxed);
                let (_, why) = cur();
                emit_state(ok, why, true);
                log_line("watchdog-start", health());
                (p, w)
            };

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

                let mut drifted: Vec<(i64, i32, i64)> = Vec::new();
                if why.is_some() {
                    // 사건 직후 — 세 박자로 나눠 단언한다(한 번은 늘 너무 이르다).
                    // OS가 상태를 다 바꾸기 전에 쓴 값은 그냥 흘러가므로 한 번으로는 못 잡는다.
                    for ms in AFTER_EVENT_MS {
                        std::thread::sleep(Duration::from_millis(ms));
                        drifted.extend(assert_all().drifted);
                    }
                }

                let pass = assert_all();
                drifted.extend(pass.drifted);

                // 드리프트 사건 로그 — 재발 순간의 트리거를 특정하려는 §5 관측기와 같은 목적.
                // 적대적 입력(밖에서 25ms마다 걷어차기)에서 934줄이 되지 않게 1초에 한 줄로
                // 접고, 접힌 수를 다음 줄에 싣는다.
                if !drifted.is_empty() {
                    let now = mono_ms();
                    let gap = now - LAST_VERIFY_AT.load(Ordering::Relaxed);
                    let n = drifted.len() as u64;
                    let suppressed = DRIFT_LOG_HELD.fetch_add(n, Ordering::Relaxed) + n;
                    if now - DRIFT_LOG_AT.load(Ordering::Relaxed) >= 1000 {
                        DRIFT_LOG_AT.store(now, Ordering::Relaxed);
                        DRIFT_LOG_HELD.store(0, Ordering::Relaxed);
                        log_line(
                            "drift",
                            json!({
                                "wake": why.unwrap_or("poll"),
                                // 직전 정상 검증 이후 경과 = 이 드리프트가 화면에 떠 있었을 수 있는 상한
                                "sinceVerifyMs": gap,
                                "inThisPass": n,
                                "coalesced": suppressed,
                                "drifts": DRIFTS.load(Ordering::Relaxed),
                                // (hwnd, 걷어차인 값, 재기록 뒤 되읽은 값)
                                "events": drifted,
                                "advancedEffects": advanced_effects_enabled(),
                                "remoteSession": remote_session(),
                            }),
                        );
                    }
                }
                LAST_VERIFY_AT.store(mono_ms(), Ordering::Relaxed);

                // 전역 효과 판정은 **사건이 왔을 때 + 주기적으로만**. 매 700ms마다 WinRT
                // 객체를 만들 이유가 없다(값이 사람 손으로만 바뀐다).
                let now = std::time::Instant::now();
                if why.is_some() || now.duration_since(last_probe) >= PROBE_EVERY {
                    let (p, w) = glass_possible();
                    possible = p;
                    why_off = w;
                    last_probe = now;
                }

                // **살아 있음의 증명 = 셋 다 참.** 하나라도 아니면 불투명이 답이다(R2).
                let ok = possible && !pass.failed && !pass.unverified;
                let reason = if !possible {
                    why_off
                } else if pass.failed {
                    super::reason::ASSERT_FAILED
                } else {
                    super::reason::NOT_VERIFIED
                };
                set_cur(ok, reason);

                let force = if boot_i < boot.len() && std::time::Instant::now() >= next_boot {
                    boot_i += 1;
                    if boot_i < boot.len() {
                        next_boot = std::time::Instant::now() + Duration::from_millis(boot[boot_i]);
                    }
                    true
                } else {
                    // 새 문서 직후의 재발신 창 — 구독이 늦게 붙어도 4초 안에 수렴한다.
                    mono_ms() < RESEND_UNTIL.load(Ordering::Relaxed)
                };
                emit_state(ok, reason, force);

                // 감시할 창이 하나도 안 남으면 스레드를 끝낸다(앱 종료 경로)
                //
                // **락을 쥔 채로 STARTED를 내린다.** 안 그러면 그 틈에 들어온 `arm()`이
                // push는 하고 `spawn_watchdog()`은 이미 true를 보고 건너뛴다 —
                // 창은 등록됐는데 감시자가 없는 상태가 된다(R1 크리틱 §3.4).
                // 크래시 복구는 `destroy → 400ms → create_main`이라 보통 2초 유예 안에
                // 들어오지만, 부하가 걸린 복구는 그 밖으로 나간다.
                let list = WINDOWS.lock().unwrap();
                if list.is_empty() && APP.get().is_some() {
                    // 창 재생성(크래시 복구)에 대비해 바로 끝내지 않고 한 박자 더 본다
                    drop(list);
                    std::thread::sleep(Duration::from_secs(2));
                    let list = WINDOWS.lock().unwrap();
                    if list.is_empty() {
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

        // 즉시 한 번 — tauri의 effects()가 이미 걸어 두었어도 멱등이다.
        // **되읽기까지 한다**: "썼다"와 "값이 섰다"는 다른 사실이고, R2의 기본값 반전은
        // 후자만 증명으로 센다. 실패하면 감시 스레드가 다음 패스(≤700ms)에 ok=false를 쏜다.
        let verified = assert_backdrop(hwnd) && read_backdrop(hwnd) == Some(DWMSBT_TRANSIENTWINDOW.0);
        if !verified {
            log_line(
                "arm-unverified",
                json!({ "hwnd": hwnd.0 as i64, "readBack": read_backdrop(hwnd) }),
            );
        }

        unsafe {
            let _: BOOL = SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, 0);
            // 잠금/해제·사용자 전환을 이 창이 받도록. 실패해도(정책·권한) 나머지는 그대로 산다.
            let _ = WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION);
        }

        // **push와 spawn을 같은 락 구간에 둔다.** 감시 스레드의 종료 판정도 목록 락을 쥐고
        // 하므로, 두 결정이 직렬화돼 "등록은 됐는데 감시자가 없는 창"이 생기지 않는다
        // (R1 크리틱 §3.4). 스폰된 스레드는 이 락이 풀릴 때까지 잠깐 기다릴 뿐이다.
        let mut list = WINDOWS.lock().unwrap();
        list.push(hwnd.0 as isize);
        spawn_watchdog();
        drop(list);
    }

    /// `cheap = true`면 WinRT(`UISettings`) 활성화를 건너뛴다 — 콜드 스타트 임계 경로에서
    /// 창을 만드는 중일 때만 쓴다. 그때 `advancedEffects`는 `null`이고 `probe`가 `"cheap"`이다.
    fn health_detail(cheap: bool) -> Value {
        let (len, backdrops) = {
            let list = WINDOWS.lock().unwrap();
            let b: Vec<i64> = list
                .iter()
                .map(|&h| {
                    read_backdrop(HWND(h as *mut core::ffi::c_void))
                        .map(|v| v as i64)
                        .unwrap_or(-1)
                })
                .collect();
            (list.len(), b)
        };
        let (possible, why) = if cheap { glass_possible_cheap() } else { glass_possible() };
        json!({
            "ok": possible,
            "reason": if possible { "" } else { why },
            "probe": if cheap { "cheap" } else { "full" },
            "windows": len,
            "backdrops": backdrops,
            "reasserts": REASSERTS.load(Ordering::Relaxed),
            "drifts": DRIFTS.load(Ordering::Relaxed),
            "lastDrift": LAST_DRIFT_VALUE.load(Ordering::Relaxed),
            "assertFails": ASSERT_FAILS.load(Ordering::Relaxed),
            "emits": EMITS.load(Ordering::Relaxed),
            "advancedEffects": if cheap { None } else { advanced_effects_enabled() },
            "regTransparency": reg_transparency(),
            "remoteSession": remote_session(),
        })
    }

    /// 진단용 스냅샷 — 창 감시 수·재단언/드리프트 카운터·현재 OS 판정.
    ///
    /// 호출자: `boot_state()`(창마다 부팅 페이로드에 실린다) · `log_line("watchdog-start")`.
    /// R1까지는 호출자가 0이라 "쓰지도 않는 진단"이었다(크리틱 §3.3).
    pub fn health() -> Value {
        health_detail(false)
    }

    /// **문서 생성 시점 스냅샷** — win.rs `boot_payload_script`가 창마다 실어 보내고,
    /// `boot_script()`가 같은 값을 document-start 판정에 쓴다.
    ///
    /// `ok`는 **"살아 있음의 증명"**이다(R2 기본값 반전). 참이 되려면:
    ///  1. 이 OS에서 아크릴이 가능하다, 그리고
    ///  2. 이미 감시 중인 창이 있다면 **그 창들이 전부 백드롭 3을 되돌려준다.**
    ///
    /// 이 프로세스의 **첫 창**에는 2번의 대상이 없다(되읽을 창이 아직 없다). 그 공백은
    /// `arm()` 직후 감시 스레드의 첫 판정이 덮고, 메인 창은 그 시점에 아직 스플래시 뒤다.
    /// 판정이 아직 없으면 싼 경로(레지스트리·원격 세션)로 내려간다 — WinRT 활성화를
    /// 콜드 스타트 임계 경로에 올리지 않기 위해서다.
    pub fn boot_state() -> Value {
        let probed = PROBED.load(Ordering::Acquire);
        let health = health_detail(!probed);
        // 감시 스레드의 판정이 이미 있으면 그것이 정본이다(WinRT + 되읽기까지 반영).
        let (mut ok, mut why) = if probed {
            let (o, w) = cur();
            (o, w.to_string())
        } else {
            (
                health["ok"].as_bool().unwrap_or(false),
                health["reason"].as_str().unwrap_or(super::reason::UNPROVEN).to_string(),
            )
        };
        if let Some(bds) = health.get("backdrops").and_then(|v| v.as_array()) {
            let want = DWMSBT_TRANSIENTWINDOW.0 as i64;
            if !bds.is_empty() && !bds.iter().all(|v| v.as_i64() == Some(want)) {
                ok = false;
                why = super::reason::NOT_VERIFIED.to_string();
            }
        }
        json!({
            "ok": ok,
            "reason": if ok { String::new() } else { why },
            "boot": true,
            "reasserts": REASSERTS.load(Ordering::Relaxed),
            "drifts": DRIFTS.load(Ordering::Relaxed),
            "mono": mono_ms(),
            "health": health,
        })
    }

    /// 크래시 복구가 창을 전부 부수고 다시 만들 때 — 목록을 비운다(win.rs `reset_shown` 짝).
    pub fn clear() {
        WINDOWS.lock().unwrap().clear();
    }
}

pub use imp::*;
