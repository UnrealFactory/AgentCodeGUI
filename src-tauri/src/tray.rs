//! 시스템 **트레이** — X = 종료가 아니라 트레이로 숨기기.
//!
//! 원본: 2.6.2 `src/main/index.ts:745-890`(createTray·showTrayMenu·trayMenu*) +
//! `:930-955`(mainWindow.on('close') → hide).
//!
//! 백그라운드 상주(턴을 넘어 완주하는 워크플로·셸·에이전트)와 짝이다: 창을 닫아도 앱은
//! 트레이에 남아 하던 일을 계속 돈다. 아이콘 클릭(또는 메뉴 '열기')이 창을 되살리고,
//! 진짜 종료는 메뉴 '완전히 종료'뿐이다.
//!
//! ## 네 조각
//! 1. **아이콘** — `TrayIconBuilder`. PNG를 `include_bytes!`로 **exe에 박는다**:
//!    3.0은 `bundle.active=false`(설치본 없음)라 `resources/icon.ico` 같은 런타임 경로가
//!    없고, 레포 상대 경로는 벤치가 exe를 복사해 돌리는 순간 깨진다.
//! 2. **메뉴** — 2.6.2와 같은 **커스텀 팝업 창**(`tray.html`). 네이티브 Win32 트레이
//!    메뉴는 구형 서식(각진 검은 박스·큰 행 간격)이라 창=카드로 직접 그린다. 창을 못
//!    만들면 네이티브 `Menu`로 떨어진다 — 투박해도 기능은 지킨다.
//! 3. **X 정책** — `win.rs`의 메인 창 `CloseRequested`가 `hide_on_close()`를 묻는다.
//!    트레이가 없으면(생성 실패) **종전대로 진짜 닫기**다 — 숨긴 창을 되찾을 길이 없으니까.
//! 4. **첫 숨김 안내**(★R2) — 아래.
//!
//! ## 첫 숨김 안내 카드 (`note_first_hide` · 크리틱 M8 §4)
//!
//! R1에는 "X가 종료가 아니게 된 것"을 알리는 수단이 **하나도 없었다**. 크리틱이 잰
//! 실제 경험은 이렇다: X → 창이 사라짐 → 안내 없음 → 작업 표시줄에도 없음 → Win11
//! 기본값이라 알림 영역 아이콘도 셰브런 뒤 → "껐구나". 그런데 프로세스는 살아서
//! 진행 중 턴·워크플로·셸을 계속 돌린다. 그래서 무게가 「중」이 아니라 **「상」**이다.
//!
//! 2.6.2는 `tray.displayBalloon`이었다(`index.ts:941-951`). Tauri/tray-icon 0.24에는
//! 대응 API가 없다(`NIF_INFO` 코드가 없고 필요한 hwnd/uID가 비공개 필드다 — 크리틱 §4.2-C).
//! 그래서 **이미 있는 카드 창을 재활용한다**: 트레이 메뉴와 같은 `tray.html`
//! (셸이 준 행을 그리는 게 전부인 페이지)을 **별도 라벨**로 하나 더 띄우고,
//! 토스트와 같은 `WS_EX_NOACTIVATE`로 포커스를 안 뺏게 한다.
//!
//! - 왜 토스트 창(`toast.html`)이 아닌가: 크리틱 권장안은 그쪽이지만, 그 페이지는
//!   `kindLabel()`이 **채팅 알림 4종의 문구를 하드코딩**한다(`app/src/toast.ts:11-16`).
//!   시스템 안내를 넣으려면 `NotifyKind`에 `info`를 더해야 하는데 이번 라운드는
//!   `app/` 경계 밖이다(M-UI가 그 파일들을 읽는 중). `tray.html`은 문구가 **전부 셸에서
//!   온다** — 같은 값(불투명 카드·항상 위·클릭 라우팅)을 한 글자도 안 고치고 얻는다.
//! - 수명: 클릭 · 본창 복귀(`show_main`) · 트레이 메뉴 열기(`show_menu`) 중 먼저 오는 것.
//!   "사용자가 창을 되찾는 순간 스스로 사라진다"가 정확히 맞는 수명이다.
//! - 한 번만: `ui-prefs`의 `tray.noticeShown`. 안내는 처음 한 번이면 족하다.
//!
//! ## 단일 인스턴스 두 번째 실행 (M1 §7-3 이월)
//! 같은 앱 홈으로 두 번째 프로세스가 뜨면 `main.rs`의 홈 잠금이 실패한다. R1까지는
//! **조용히 물러났다** — 트레이에 숨어 있으면 사용자는 "아이콘을 눌렀는데 아무 일도
//! 안 일어나는" 앱을 보게 된다. 이제 물러나기 전에 `raise_existing()`으로
//! 등록 윈도우 메시지를 브로드캐스트하고, 먼저 뜬 인스턴스가 그걸 받아 창을 앞으로 올린다.
//! 메시지 이름에 **앱 홈 경로**를 넣으므로 격리 홈(dev·벤치)끼리는 서로를 안 건드린다.
//!
//! ★R28i N3 — 그 신호에는 **폴더가 같이 온다**. 봉투(`WPARAM`/`LPARAM`)에는 경로가 안
//! 실리므로 두 번째 인스턴스가 앱 홈에 인계 파일을 쓰고(`ipc::app_meta::open_dir`),
//! 이쪽은 창을 세운 **뒤에** 그것을 소비한다. 「AgentCodeGUI3으로 열기」가 트레이에
//! 숨어 있는 앱에도 통하는 자리가 여기다.

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
/// 첫 숨김 안내 카드. 메뉴와 **같은 페이지·다른 라벨**이다(모듈 헤더 4).
pub const NOTICE_WIN: &str = "traynotice";
const NOTICE_W: f64 = 336.0;
/// 안내를 한 번만 띄우기 위한 ui-prefs 키.
const NOTICE_PREF: &str = "tray.noticeShown";
/// 안내 카드가 아무 조작 없이 화면에 남는 시간(2.6.2 풍선의 자동 소멸 자리).
const NOTICE_LIFE_MS: u64 = 15_000;

/// 아이콘 원본. 런타임 경로에 기대지 않고 exe에 박는다.
/// ★ M12 R2 — `icon.png`(2.6.2 마크)가 아니라 **3.0 파생 마크**(`icon3.png`, teal 「3」 배지)다.
/// 두 앱을 나란히 띄우면 알림 영역에 같은 그림 두 개가 뜬다(M12 R1 §5.3).
const ICON_PNG: &[u8] = include_bytes!("../../build/icon3.png");
/// tauri 레지스트리 안의 아이콘 id — `release_icon`이 그 사본을 되찾을 주소다.
const TRAY_ID: &str = "ccg-tray";

/// 트레이 핸들.
///
/// **`OnceLock`이면 안 된다.** `TrayIcon`은 refcount다(tray-icon 0.24 `lib.rs:340-347`:
/// *"This type is reference-counted and the icon is removed when the last instance is
/// dropped"*) — 알림 영역에서 빼는 `NIM_DELETE`는 **Drop에서만** 나간다. 그런데 Rust는
/// `static`을 절대 drop하지 않고, tauri의 `cleanup_before_exit()`가 비우는 것은
/// `manager.tray.icons`(자기 사본)뿐이다. 그래서 R1은 '완전히 종료' 뒤에도 **죽은
/// 아이콘이 알림 영역에 남았다**(사용자가 그 위를 지나가야 사라진다). 2.6.2는 이 자리를
/// 알고 `index.ts:2174 tray?.destroy()`로 고쳐 뒀다 — 3.0이 되돌린 것이다(크리틱 M8 §3.3).
/// 종료 직전에 꺼낼 수 있게 `Mutex<Option<_>>`으로 든다(`release_icon`).
static TRAY: Mutex<Option<TrayIcon>> = Mutex::new(None);
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
/// 카드 창(메뉴·안내)의 "있나 → 만든다"를 한 줄로 세우는 자물쇠 — `show_menu` 주석.
static SHOW_LOCK: Mutex<()> = Mutex::new(());

pub fn is_quitting() -> bool {
    QUITTING.load(Ordering::SeqCst)
}

/// 트레이가 실제로 살아 있나 — X 정책의 전제.
pub fn present() -> bool {
    TRAY.lock().unwrap_or_else(|e| e.into_inner()).is_some()
}

/// **종료 직전에 아이콘을 놓아 준다** — 이걸 안 하면 죽은 아이콘이 알림 영역에 남는다.
///
/// 참조가 **둘**이라 둘 다 놓아야 Drop이 돈다(실측으로 확인했다 — 우리 static만 비웠을
/// 때는 `present()`가 false로 떨어져도 tray-icon의 히든 창 `tray_icon_app`이 그대로
/// 살아 있었다 = `NIM_DELETE`가 안 나갔다):
///   ① 우리 `TRAY` static — R1은 `OnceLock`이라 애초에 뺄 방법이 없었다.
///   ② tauri가 `manager.tray.icons`에 쥔 사본 — `remove_tray_by_id`로 뺀다.
///      (tauri는 `cleanup_before_exit()`에서 이 맵을 비우지만 그건 `RunEvent::Exit`
///       시점이고, 우리 static이 살아 있는 한 그때도 마지막 참조가 아니다.)
///
/// **메인 스레드에서 부르는 게 원칙**이다: `TrayIcon::drop`이 `NIM_DELETE` 다음에
/// `DestroyWindow(자기 히든 창)`를 부르는데 그 호출은 창을 만든 스레드에서만 성공한다.
/// `RunEvent::ExitRequested` 핸들러가 그 스레드다. 두 번 불러도 무해하다(둘 다 take).
pub fn release_icon(app: &AppHandle) {
    drop(TRAY.lock().unwrap_or_else(|e| e.into_inner()).take());
    drop(app.remove_tray_by_id(TRAY_ID));
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
    // 창을 되찾았다 = 첫 숨김 안내의 할 일이 끝났다(모듈 헤더 4의 수명).
    dismiss_notice(app);
    let Some(w) = app.get_webview_window(MAIN) else { return };
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
}

fn quit(app: &AppHandle) {
    QUITTING.store(true, Ordering::SeqCst);
    // 아이콘을 **여기서 놓지 않는다.** `menu_action`은 `ipc_call`(async 커맨드)에서
    // 오므로 tokio 워커 스레드다. `TrayIcon::drop`은 `Shell_NotifyIcon(NIM_DELETE)`에
    // 이어 `DestroyWindow(자기 히든 창)`를 부르는데, 그 호출은 **창을 만든 스레드에서만**
    // 성공한다(tray-icon 0.24 `platform_impl/windows/mod.rs:305-318`). 놓는 자리는
    // `app.exit(0)`이 태우는 `RunEvent::ExitRequested` — 거기가 이벤트 루프 스레드다.
    app.exit(0);
}

// ── 아이콘 ──────────────────────────────────────────────────────────────────

pub fn init(app: &AppHandle) {
    if present() {
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
    let built = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        // ★ M12 R2 — 2.6.2의 툴팁도 "AgentCodeGUI"다. 같은 글자면 알림 영역에서 어느 쪽을
        // 누르는지 알 수 없다(M12 R1 §5.3의 숙제). 제품명(mainBinaryName)과 같이 맞춘다.
        .tooltip("AgentCodeGUI3")
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
            *TRAY.lock().unwrap_or_else(|e| e.into_inner()) = Some(t);
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

/// UI 언어가 영어인가 — 원본은 **ui-prefs의 `"ui.lang"`** 한 키다.
///
/// R1은 `"lang"`을 읽었다. 그 키는 3.0의 어디에도 없다(렌더러 `app/src/lib/i18n.ts:17`
/// `LANG_PREF = 'ui.lang'` · `ipc/stores.rs:94`·`:109` · `crates/ccg-fs/src/lib.rs:60`,
/// 2.6.2 `src/main/lang.ts` 헤더도 *"값은 ui-prefs('ui.lang')가 원본"*). 그래서 UI를
/// en으로 둬도 **트레이 메뉴만 영원히 한국어**였다(크리틱 M8 §3.4 실측). 한 글자짜리
/// 결함이라 한 함수로 묶어 둔다 — 다음에 라벨이 늘어도 키가 두 벌이 되지 않게.
fn en_ui() -> bool {
    ccg_store::prefs::read_ui_prefs().get("ui.lang").and_then(Value::as_str) == Some("en")
}

fn items() -> Value {
    // 라벨은 **표시 시점**에 만든다. Rust 쪽에 i18n이 없으므로 저장된 UI 언어를 읽어
    // 두 벌 중 하나를 고른다(렌더러 `lib/i18n.ts`와 같은 키).
    let en = en_ui();
    json!([
        { "id": "open", "label": if en { "Open AgentCodeGUI" } else { "AgentCodeGUI 열기" } },
        { "id": "quit", "label": if en { "Quit completely" } else { "완전히 종료" } },
    ])
}

/// 트레이 아이콘 우클릭 — 떠 있으면 토글 닫기(네이티브 메뉴의 재우클릭과 같은 감각).
/// `x`/`y`는 **물리** 좌표(TrayIconEvent.position)다.
pub fn show_menu(app: &AppHandle, x: f64, y: f64) {
    // "떠 있나 → 없으면 만든다"를 한 줄로 세운다 — 쪼개지면 같은 라벨로 창이 둘 만들어져
    // 하나가 고아가 된다(notify.rs `PUSH_LOCK` 주석의 실측 사고와 같은 종류).
    // 이 함수는 트레이 우클릭(메인 스레드)과 진단 채널(tokio 워커) 양쪽에서 온다.
    let _serial = SHOW_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // 안내 카드와 메뉴가 **동시에 뜨지 않게** 한다. 같은 페이지를 쓰므로 겹치면
    // 화면에 같은 카드가 둘이고, 사용자가 트레이 메뉴에 도달한 순간 안내의 할 일도 끝난다.
    dismiss_notice(app);
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
            //
            // ★R2 — **예산을 토스트와 맞춘다**(180/500 두 번 → 180/500/1200 세 번 +
            //   마지막 시도 폴백). 크리틱 M8 §3.6이 남긴 관측: 36회 실측에서 행이 실제로
            //   뜬 시각이 123~202ms였다 = `page-load` 직후의 첫 emit은 **대개 놓치고**
            //   180ms 재송신이 살리고 있다. 여유가 500ms까지 두 번뿐인 구조는 부하가
            //   걸리면 얇고(그 회차에 항목 0개가 한 번 관측됐다), 트레이 메뉴는
            //   '완전히 종료'의 **유일한 경로**라 빈 카드의 대가가 토스트보다 크다.
            spawn_menu_resend(w.app_handle().clone());
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

/// 항목 REPLACE 재송신 — **토스트와 같은 예산**(`notify.rs:288-302`).
///
/// 세 번(180/500/1200ms) 다시 쏘고, 마지막 시도까지도 창이 안 보이면 기본 높이로
/// 앉힌다. 뒤쪽 폴백이 없으면 페이지가 `traymenu:resize`를 못 보낸 회차에
/// **보이지 않는 창이 앱에 남는다** — 사용자에게는 "우클릭했는데 아무 일도 없다"이고,
/// 그게 곧 '완전히 종료'로 가는 유일한 문이 막힌 상태다.
fn spawn_menu_resend(a: AppHandle) {
    std::thread::spawn(move || {
        for ms in [180u64, 500, 1200] {
            std::thread::sleep(std::time::Duration::from_millis(ms));
            let Some(w) = a.get_webview_window(MENU_WIN) else { return };
            let _ = a.emit_to(MENU_WIN, TRAYMENU_SHOW, items());
            if ms == 1200 && !w.is_visible().unwrap_or(false) {
                let a2 = a.clone();
                let _ = a.run_on_main_thread(move || menu_resize(&a2, 92.0));
            }
        }
    });
}

// ── 첫 숨김 안내 카드 (모듈 헤더 4 · 크리틱 M8 §4) ──────────────────────────

/// 안내 문구. 트레이 메뉴와 **같은 페이지**를 쓰므로 행 두 개가 곧 카드다.
/// 첫 행이 안내이자 복원 버튼이고(클릭 = 창 복원), 둘째 행이 "완전히 종료는 여기"다.
fn notice_items() -> Value {
    let en = en_ui();
    json!([
        {
            "id": "open",
            "label": if en {
                "AgentCodeGUI is still running in the tray — click to reopen"
            } else {
                "앱이 트레이에서 계속 실행돼요 — 눌러서 다시 열기"
            }
        },
        {
            "id": "quit",
            "label": if en { "Quit completely" } else { "완전히 종료" },
        },
    ])
}

/// **처음 트레이로 숨을 때 한 번만** — "X는 종료가 아니다"를 알리는 유일한 자리.
/// `win.rs`의 `CloseRequested`가 `hide()` 직후에 부른다.
pub fn note_first_hide(app: &AppHandle) {
    let mut p = ccg_store::prefs::read_ui_prefs();
    if p.get(NOTICE_PREF).and_then(Value::as_bool) == Some(true) {
        return;
    }
    // 표식을 **먼저** 남긴다. 카드 생성이 실패해도 매번 다시 시도하지 않게(안내가 안 뜬
    // 것보다, 뜰 때마다 실패해 로그만 쌓이는 쪽이 나쁘다).
    if let Some(o) = p.as_object_mut() {
        o.insert(NOTICE_PREF.into(), json!(true));
    }
    let _ = ccg_store::prefs::write_ui_prefs(&p);
    show_notice(app);
}

fn show_notice(app: &AppHandle) {
    if app.get_webview_window(NOTICE_WIN).is_some() {
        return;
    }
    let b = shared_env(
        WebviewWindowBuilder::new(app, NOTICE_WIN, WebviewUrl::App("tray.html".into())),
        NOTICE_WIN,
    )
    .title("안내 — AgentCodeGUI")
    .inner_size(NOTICE_W, 96.0)
    .visible(false)
    .decorations(false)
    .resizable(false)
    .minimizable(false)
    .maximizable(false)
    .skip_taskbar(true)
    .always_on_top(true)
    .focused(false)
    .background_color(tauri::utils::config::Color(0x15, 0x15, 0x15, 0xff))
    .on_page_load(|w, payload| {
        if payload.event() == PageLoadEvent::Finished {
            let _ = w.emit_to(NOTICE_WIN, TRAYMENU_SHOW, notice_items());
            let a = w.app_handle().clone();
            std::thread::spawn(move || {
                for ms in [180u64, 500, 1200] {
                    std::thread::sleep(std::time::Duration::from_millis(ms));
                    let Some(w) = a.get_webview_window(NOTICE_WIN) else { return };
                    let _ = a.emit_to(NOTICE_WIN, TRAYMENU_SHOW, notice_items());
                    if ms == 1200 && !w.is_visible().unwrap_or(false) {
                        let a2 = a.clone();
                        let _ = a.run_on_main_thread(move || notice_resize(&a2, 96.0));
                    }
                }
            });
        }
    });
    match b.build() {
        // 안내 카드는 **포커스를 안 뺏는다**(토스트와 같은 `WS_EX_NOACTIVATE`).
        // 방금 창을 닫은 사용자에게서 입력 포커스를 도로 가져가는 것은 안내가 아니라 방해다.
        // 그래서 메뉴 창과 달리 blur=닫기 규칙도 걸지 않는다 — 애초에 포커스가 안 온다.
        Ok(w) => super::notify::no_activate(&w),
        Err(e) => {
            eprintln!("[tray] 첫 숨김 안내 카드 생성 실패: {e}");
            return;
        }
    }
    // 풍선의 수명 — 2.6.2 `displayBalloon`도 OS가 몇 초 뒤 걷었다. 카드에는 ✕이 없고
    // (tray.html은 행만 그린다) 포커스가 없어 Esc도 못 받으므로, 아무것도 안 눌린 회차에
    // **항상 위 카드가 화면에 영영 남지 않게** 여기서 걷는다. 클릭·본창 복귀·메뉴 열기가
    // 그보다 먼저 오면 그쪽이 걷는다.
    let a = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(NOTICE_LIFE_MS));
        let a2 = a.clone();
        let _ = a.run_on_main_thread(move || dismiss_notice(&a2));
    });
}

/// 안내 카드의 높이 보고 — 트레이가 있는 쪽, 즉 작업 영역 **우하단**에 앉힌다
/// (토스트와 같은 자리 계산: `notify::work_area`).
pub fn notice_resize(app: &AppHandle, height: f64) {
    let Some(w) = app.get_webview_window(NOTICE_WIN) else { return };
    let scale = w.scale_factor().unwrap_or(1.0);
    let (wx, wy, ww, wh) = super::notify::work_area(app, scale);
    let h = height.round().max(40.0).min(wh - 32.0);
    let _ = w.set_size(tauri::LogicalSize::new(NOTICE_W, h));
    let _ = w.set_position(tauri::LogicalPosition::new(
        wx + ww - NOTICE_W - 16.0,
        wy + wh - h - 16.0,
    ));
    if !w.is_visible().unwrap_or(false) {
        // NOACTIVATE라 show()가 활성화를 가져가지 않는다.
        let _ = w.show();
    }
}

/// 안내 카드의 클릭(`''` = Esc). 카드를 걷고 그 뜻대로 한다.
pub fn notice_action(app: &AppHandle, id: &str) {
    dismiss_notice(app);
    match id {
        "open" => show_main(app), // show_main도 dismiss를 부르지만 destroy는 멱등이다
        "quit" => quit(app),
        _ => {}
    }
}

pub fn dismiss_notice(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(NOTICE_WIN) {
        let _ = w.destroy();
    }
}

/// 커스텀 카드를 못 만들었을 때의 네이티브 폴백. 한 번 붙으면 OS가 우클릭에 알아서
/// 띄우므로 이후 카드 시도를 막는다(`NATIVE_FALLBACK`).
fn native_menu(app: &AppHandle) {
    use tauri::menu::{IsMenuItem, MenuBuilder, MenuItemBuilder};
    let guard = TRAY.lock().unwrap_or_else(|e| e.into_inner());
    let Some(t) = guard.as_ref() else { return };
    let en = en_ui();
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
                let _ = app.run_on_main_thread(move || {
                    show_main(&a);
                    // ★R28i N3 — 두 번째 인스턴스가 남긴 폴더 인계를 소비해 렌더러로 흘린다.
                    // **raise 뒤**에 오는 것이 규약이다: 트레이에 숨어 있던 창이 먼저 서야
                    // 폴더 확인 카드·안내 카드가 보이는 화면에 앉는다. 판정은 자기 스레드에서
                    // 돈다(`deliver_pending` 주석 — UNC 21초 함정).
                    crate::ipc::app_meta::open_dir::deliver_pending(&a);
                });
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
        // ★R2 — 첫 숨김 안내: 지금 카드가 떠 있나 / 이 홈에서 이미 보여 줬나.
        "noticeWindow": app.get_webview_window(NOTICE_WIN).is_some(),
        "noticeShown": ccg_store::prefs::read_ui_prefs().get(NOTICE_PREF).and_then(Value::as_bool) == Some(true),
        "closeToTray": ccg_store::prefs::read_ui_prefs().get("tray.closeToTray").and_then(Value::as_bool) != Some(false),
    })
}
