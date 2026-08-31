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

use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{
    webview::PageLoadEvent, AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

// 유리(아크릴) 유지 모듈. `main.rs`에 `mod glass;`를 얹지 않고 여기서 매다는 이유:
// main.rs는 M2(ipc 분할)와 M-CRASH가 함께 만지는 파일이라 한 줄 추가도 충돌을 만든다.
// 이 모듈은 win.rs가 만든 창에만 붙으므로 소유 관계상으로도 여기가 맞는 자리다.
#[path = "glass.rs"]
pub mod glass;

// M8 창 표면 3종. glass.rs와 같은 이유로 여기에 매단다(main.rs는 다른 라운드가 소유).
// 셋 다 **창을 만드는 유일한 경로가 `shared_env`**라는 규약 아래 있다 — 그래서
// win.rs의 자식 모듈이고, 그래서 이 파일 밖에서는 창 생성 헬퍼가 안 보인다.
/// 멀티 패널 팝아웃 창(`#mapanel`) — `ma:panel-*`.
#[path = "popout.rs"]
pub mod popout;
/// 포커스 밖 알림 토스트 창(`toast.html`) — `notify:*`.
#[path = "notify.rs"]
pub mod notify;
/// 시스템 트레이 + 우클릭 메뉴 창(`tray.html`) — `traymenu:*`.
#[path = "tray.rs"]
pub mod tray;

pub const MAIN: &str = "main";

/// 셸이 주입하는 부팅 스플래시. 왜 별도 창이 아닌지는 splash.js 헤더에.
const SPLASH_JS: &str = include_str!("splash.js");

/// **부팅 페이로드 선주입** — #root 마운트 전에 도는 IPC 왕복을 0으로 만든다.
///
/// 렌더러의 진입점(app/src/main.tsx)은 `loadPrefs()`가 **resolve된 뒤에야** createRoot를
/// 부른다(저장된 줌·유리·언어가 첫 페인트부터 맞아야 하므로 2.6.2부터의 규약이다).
/// 즉 `ui-prefs:get` 왕복 하나가 rootMs의 임계 경로에 통째로 들어가 있다. 창을 만들 때
/// 이미 디스크에서 읽어 오는 값이니, 문서 생성 시점에 `window.__CCG_BOOT`로 넣어 주면
/// 심(shim.ts)이 그걸 먹고 왕복이 사라진다. 값은 **창이 만들어진 그 순간의 디스크 내용**
/// 이라 첫 조회 결과와 같고, 심은 채널당 **한 번만** 쓰고 버린다(이후 조회는 정상 IPC).
///
/// 여기 넣는 것은 **작고 부팅 임계 경로에 있는 것만**이다. chats/ma 같은 큰 블롭을 넣으면
/// document-start에 수백 KB짜리 JS 리터럴을 파싱하게 돼 첫 페인트가 오히려 늦는다
/// (그리고 그 둘은 마운트 이후에 조회되므로 rootMs에 애초에 영향이 없다).
fn boot_payload_script() -> String {
    let payload = json!({
        crate::ipc::ch::UI_PREFS_GET: ccg_store::prefs::read_ui_prefs(),
        crate::ipc::ch::PROFILE_GET: ccg_store::prefs::read_profile(),
        crate::ipc::ch::APP_GET_VERSION: env!("CARGO_PKG_VERSION"),
        // 유리 상태 스냅샷. 셸의 부팅 3연발은 **프로세스당 1회**라 나중에 태어난 창과
        // 크래시 복구 재로드에는 오지 않는다(R1 크리틱 실증: events=0). 이 스크립트는
        // 페이지 로드마다 다시 도므로 여기 실으면 그 두 구멍이 함께 닫힌다.
        // 소비자는 app/src/api/glassFallback.ts — `call()`이 없는 채널이라 shim의
        // takeBoot와 충돌하지 않는다(그쪽은 채널당 1회 소비, 이쪽은 읽기만).
        glass::UI_GLASS_STATE: glass::boot_state(),
    });
    // JSON은 그대로 JS 리터럴로 유효하다(U+2028/2029도 ES2019+에서 문자열 안에 허용).
    format!("window.__CCG_BOOT={payload};")
}

/// 추가 채팅 창 라벨 접두사. 창 하나 = 채팅 하나(2.6.2 sessionWins와 같은 1:1).
const SESSION_PREFIX: &str = "session-";
static SESSION_SEQ: AtomicI64 = AtomicI64::new(0);

/// 추가 채팅 창 레지스트리(라벨 → 표시 메타). 2.6.2의 sessionWins Map 자리.
/// `id`는 **영속 채팅 id**다 — 창은 그 채팅을 열어 보는 뷰일 뿐이다.
#[derive(Clone)]
pub struct SessionRec {
    pub id: String,
    pub label: String,
    pub title: String,
    pub status: String,
    /// `/btw` 질문 채팅이면 **원본 채팅 id**(파리티 R1 T4). 창을 만들 때 레코드에서 한 번
    /// 읽어 든다 — 목록 브로드캐스트는 턴마다 도는데(`session_report`) 그때마다 채팅
    /// 파일을 다시 파면 상태 보고 한 번이 디스크 왕복이 된다.
    pub btw_of: Option<String>,
    /// 마지막으로 관측한 최소화 상태. `shown`(=알약을 숨길지)의 원천이고, `Resized`가
    /// 이 값과 달라졌을 때만 목록을 다시 쏘게 하는 **디바운스 키**이기도 하다 —
    /// 드래그 리사이즈는 초당 수십 번 오는데 그때마다 REPLACE를 쏠 이유가 없다.
    pub minimized: bool,
}
static SESSIONS: Mutex<Vec<SessionRec>> = Mutex::new(Vec::new());

/// 추가 채팅의 **재시작 생존 id**.
///
/// R1은 `format!("s-{}-{}", std::process::id(), n)`이었다 — 앱을 다시 켤 때마다 값이
/// 바뀌므로 저장 채널이 생겨도 그 창의 대화를 **다시 찾을 수 없다**(크리틱 배선 R1
/// §5-S4 후단: *"저장 채널이 생겨도 id 규약을 먼저 고쳐야 한다"*). 프로세스와 무관한
/// 값(밀리초 + 프로세스 내 일련번호)으로 바꾼다. 접두사는 2.6.2 추가 채팅과 같은 칸을
/// 쓰므로 `sc-`다(파일명이 되므로 `safe_id_str` 문자만).
fn mint_session_chat_id(n: i64) -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("sc-{ms}-{n}")
}

/// 창보다 **먼저** 채팅 id가 필요한 경로용(파리티 R1 T4 `btw:open`).
///
/// `/btw`는 레코드를 먼저 심고(원본·시드·인라인 질문) 그 id로 창을 연다 — 창이 뜬 다음에
/// 심으면 그 창의 `hydrate`가 시드보다 이를 수 있고, 그러면 첫 실행이 포크가 아니라
/// **새 대화**로 나간다(원본 컨텍스트 상실 = 이 기능이 없는 것과 같다).
/// 일련번호는 창 라벨과 같은 카운터를 쓴다 — 값 하나를 건너뛸 뿐이고 라벨은 여전히 유일하다.
pub fn new_session_chat_id() -> String {
    mint_session_chat_id(SESSION_SEQ.fetch_add(1, Ordering::Relaxed) + 1)
}

/// 창을 보여주는 일은 여러 경로(첫 페인트·페이지 로드 완료·안전망 타이머)에서 오므로
/// 한 번만 실행되게 막는다. 두 번 show()해도 무해하지만 set_focus가 겹치면 깜빡인다.
static SHOWN: AtomicBool = AtomicBool::new(false);

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

/// **창 하나에 110MB가 붙지 않게 하는 자리.**
///
/// WebView2는 `CreateCoreWebView2EnvironmentWithOptions(사용자 데이터 폴더, 옵션)`이
/// **같으면 브라우저 프로세스를 공유**하고, 다르면 통째로 하나 더 띄운다. wry는 웹뷰마다
/// 환경을 새로 만들므로(wry-0.55.1 `webview2/mod.rs:133` — `pl_attrs.environment`가
/// None이면 `create_environment`) 두 인자가 **글자 하나까지 같아야** 공유가 성립한다.
/// 그래서 모든 창은 반드시 이 함수를 거친다 — 새 창을 만들 때 이 두 줄을 빠뜨리면
/// 창마다 브라우저+GPU+유틸 프로세스가 통째로 복제된다(그게 2.6.2의 창당 110.7MB 자리).
///
/// `CCG_WIN_ISOLATED_ENV=1` = 대조군: 창마다 다른 사용자 데이터 폴더를 준다. 공유 환경의
/// 기여도를 재기 위한 스위치이고, 기본값은 당연히 공유다.
fn shared_env<'a, R: tauri::Runtime, M: Manager<R>>(
    b: WebviewWindowBuilder<'a, R, M>,
    label: &str,
) -> WebviewWindowBuilder<'a, R, M> {
    let isolated = std::env::var("CCG_WIN_ISOLATED_ENV").is_ok_and(|v| v != "0");
    let dir = if isolated && label != MAIN {
        ccg_store::app_home().join(format!("webview2-{label}"))
    } else {
        // WebView2 사용자 데이터 폴더를 **앱 홈 안으로** 끌어온다.
        // 기본값은 %LOCALAPPDATA%\<identifier> 라 CCG_HOME 격리를 벗어난다. 그러면
        //  (1) 격리 홈으로 띄운 벤치·dev가 사용자 실앱과 캐시를 공유하고,
        //  (2) 벤치가 홈을 지워도 Tauri만 HTTP/코드 캐시가 따뜻하게 남아 콜드 스타트가
        //      Electron 대비 유리하게 찍힌다(측정 편향). 둘 다 없앤다.
        ccg_store::app_home().join("webview2")
    };
    // Chromium 스위치는 전부 webview_args.rs가 조립한다(레버 하나씩 켜고 재기 위해).
    // 주의: 이걸 지정하면 wry 기본 인자가 통째로 버려진다 — 그래서 거기서 복제한다.
    b.additional_browser_args(&crate::webview_args::browser_args())
        .data_directory(dir)
        // 네이티브 drag-drop을 켜면 HTML5 drop이 웹뷰에 아예 안 온다 — 렌더러의
        // 첨부 드롭·탐색기 드래그가 전부 죽는다. 경로가 필요한 자리는 심이
        // saveAttachmentData(바이트) 폴백으로 간다.
        .disable_drag_drop_handler()
}

pub fn create_main(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let st = ccg_store::window_state::load();
    *NORMAL.lock().unwrap() = Some(st.clone());
    LAST_MAX.store(st.maximized, Ordering::Relaxed);

    let mode = chrome_mode();
    let mut b = shared_env(
        WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into())),
        MAIN,
    )
        .title("AgentCodeGUI3")
        .initialization_script(&boot_payload_script())
        .initialization_script(SPLASH_JS)
        // ★파리티 R1 M1 — Ctrl+W 포획기(`ipc/parity/misc.rs`). 웹뷰 안의 키는 셸에 오지
        // 않으므로 문서 쪽에 귀를 하나 심는다. 렌더러 이식본은 이 채널을 이미 구독하고
        // 있고(`Chat.tsx:419`·`FileModal.tsx:2998`) **방출자만 없었다**.
        .initialization_script(crate::ipc::parity::misc::CLOSE_SHORTCUT_JS)
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
        // 유리 폴백 부트스트랩 — **문서가 만들어지는 그 순간** 기본값(불투명)을 심는다.
        // `initialization_script`는 페이지 로드마다 다시 도므로 재로드·크래시 복구
        // 재생성까지 함께 덮인다(R1 크리틱 §3.1 D1). mode 'c'는 아크릴을 아예 안 걸므로
        // 폴백 개념 자체가 없다 — 대조군의 픽셀을 바꾸지 않기 위해 그때는 안 심는다.
        b = b.initialization_script(&glass::boot_script());
    }

    // 보여주는 시점 = 스플래시 오버레이가 DOM에 있고 **렌더 차단 CSS가 다 와서 다음
    // 프레임이 곧 그 스플래시인 순간**(splash.js → win:first-paint).
    //
    // R2는 "rAF 두 번 뒤"라고 적어 두었지만 **그 경로는 한 번도 발화하지 않았다**:
    // 창이 숨겨져 있는 동안 WebView2는 프레임을 만들지 않아 rAF가 오지 않는다(닭-달걀).
    // 그래서 실제로는 아래 Finished(=load 이벤트) 안전망이 창을 띄우고 있었고, load는
    // **원격 웹폰트 CSS 두 개를 기다린다** — 실측 DCL 61~66ms vs load 109~119ms.
    // 창 표시가 네트워크에 50ms 묶여 있었다는 뜻이고, 오프라인이면 더 늦었다.
    //
    // Finished는 그대로 안전망으로 남긴다 — 스플래시 주입이 실패해도 창은 뜬다.
    b = b.on_page_load(|w, payload| {
        if payload.event() == PageLoadEvent::Finished {
            // 크래시 복구의 2순위 검증 신호 — 재로드마다 다시 온다(crash.rs `note_page_load`).
            crate::crash::note_page_load(w.label());
            // 유리 상태를 **이 문서에** 다시 알린다. document-start 스냅샷이 이미 화면을
            // 맞춰 두었지만, 그 사이에 상태가 바뀌었을 수 있고 구독은 비동기 등록이다.
            glass::note_document(w.label());
            show_once(&w);
        }
    });

    let win = b.build()?;

    // 렌더러/브라우저 사망 감지 — 유령 창을 남기지 않기 위한 자리(crash.rs).
    crate::crash::arm(app, &win);

    // 유리 유지 — 백드롭 재단언 + 소실 시 렌더러 폴백 통지(glass.rs).
    // `.effects(Acrylic)`은 **창을 만들 때 한 번** 걸릴 뿐이라, 그 뒤 OS가 합성을
    // 갈아엎으면(테마 변경·모니터 탈착·세션 복귀·절전 복귀) 아무도 되돌려 주지 않는다.
    if mode != 'c' {
        glass::arm(app, &win);
    }

    // 두 번째 안전망: 스플래시도 로드 완료도 오지 않는 최악(렌더러 크래시)에 대비.
    // 3.5초는 R1 실측 rootMs(336ms)의 10배 — 정상 경로에서는 절대 걸리지 않는다.
    {
        let handle = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(3500));
            if let Some(w) = handle.get_webview_window(MAIN) {
                show_once(&w);
            }
        });
    }

    if let Ok(s) = win.scale_factor() {
        SCALE_MILLI.store((s * 1000.0).round() as i64, Ordering::Relaxed);
    }

    // 시스템 트레이 — X = 트레이로 숨기기의 전제. 창이 선 뒤에 올린다(아이콘 클릭이
    // 곧 `show_main`이므로 되살릴 창이 이미 있어야 한다). 두 번째 호출은 no-op이라
    // 크래시 재생성 경로에서 아이콘이 겹치지 않는다.
    tray::init(app);
    // 같은 앱 홈으로 두 번째 인스턴스가 뜨면 "창을 앞으로" 신호를 이 창이 받는다(M1 §7-3).
    tray::arm_raise_listener(app, &win);

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
        // 메인 창이 포커스를 되찾았다 — 그 창 몫의 알림 토스트는 무의미하다.
        WindowEvent::Focused(true) => notify::clear_for_window(&handle, MAIN),
        // X(·Alt+F4) = **종료가 아니라 트레이로 숨기기**. 창만 숨기고 앱(진행 중 턴·
        // 워크플로·셸·추가 채팅)은 그대로 산다. 진짜 종료는 트레이 메뉴 '완전히 종료'.
        // 트레이 생성이 실패했거나 설정이 꺼져 있으면 종전대로 진짜 닫기 —
        // 숨긴 창을 되찾을 길이 없는데 숨기면 그게 유령이다.
        WindowEvent::CloseRequested { api, .. } => {
            save_now(&handle);
            if tray::hide_on_close() {
                api.prevent_close();
                if let Some(w) = handle.get_webview_window(MAIN) {
                    let _ = w.hide();
                }
                // ★R2 — **처음 숨는 순간이 유일한 안내 자리다**(tray.rs 헤더 4).
                // R1에는 X가 종료가 아니게 된 것을 알리는 수단이 하나도 없었고, Win11은
                // 트레이 아이콘을 기본으로 셰브런 뒤에 숨긴다 — 사용자는 "껐구나" 하는데
                // 프로세스는 살아서 턴·워크플로·셸을 계속 돈다(크리틱 M8 §4: 무게 「상」).
                // 두 번째부터는 안 뜬다(ui-prefs `tray.noticeShown`).
                tray::note_first_hide(&handle);
            }
        }
        _ => {}
    });

    Ok(win)
}

// ── 추가 채팅 창 (2.6.2 createSessionWindow) ─────────────────────────────────
//
// 요구는 "**OS 창**이어야 한다"이다 — 듀얼 모니터로 끌고 갈 수 있어야 하니 한 웹뷰 안의
// 탭/뷰로 접을 수 없다. 대신 **웹 런타임을 통째로 복제하지 않는 것**이 3.0의 답이다:
// 같은 WebView2 환경(shared_env) + `--process-per-site`로 같은 사이트 문서가 렌더러를
// 공유하게 두면, 창이 늘어도 새로 생기는 건 창 하나와 그 문서의 DOM/힙뿐이다.
// 기여도는 bench/results/webview-flags.json(window-cost 절)에 남긴다.
pub fn open_session_window(app: &AppHandle) -> tauri::Result<()> {
    open_session_window_for(app, None).map(|_| ())
}

/// 둘째 채팅 창의 **제목 표시줄** 문구. 2.6.2 `src/main/index.ts:553-554`에서 글자 그대로.
///
/// ★HOSTI18N R1 — 초판은 한국어 리터럴 둘을 `t()` 없이 걸어서, `ui.lang=en` 사용자의
/// 둘째 채팅 창은 **제목 표시줄만 한국어**였다(확인 크리틱 R1 §4.2-3). 작업 표시줄에도
/// 그 문구가 뜨므로 en 사용자에게는 앱 밖에서까지 보이는 자리다.
///
/// **알아 둘 성질**: 제목은 창을 만들 때 한 번 정해진다 — 이미 열린 창은 언어를 바꿔도
/// 그대로다. 2.6.2도 같다(생성 시 `t()`). 파리티가 어긋난 게 아니라 **둘 다 같은 성질**이라
/// 그대로 뒀다.
pub(crate) fn session_window_title(is_btw: bool) -> String {
    if is_btw {
        ccg_fs::t("btw 질문 — AgentCodeGUI", "btw question — AgentCodeGUI")
    } else {
        ccg_fs::t("추가 채팅 — AgentCodeGUI", "Extra chat — AgentCodeGUI")
    }
}

/// 창 하나를 띄운다. `chat`이 있으면 **그 영속 채팅을 여는 창**이고(사이드바에서
/// 닫힌 추가 채팅을 클릭한 경로), 없으면 새 채팅 id를 발급한다.
/// 반환값은 만들어진 **창 라벨**(`win:chat-open`이 자리 정보를 돌려줘야 한다).
pub fn open_session_window_for(app: &AppHandle, chat: Option<&str>) -> tauri::Result<String> {
    let n = SESSION_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    let label = format!("{SESSION_PREFIX}{n}");
    let id = match chat {
        Some(c) => c.to_string(),
        None => mint_session_chat_id(n),
    };

    // 새 창은 메인 창에서 살짝 어긋나게(계단식) — 겹쳐서 안 보이는 사고 방지
    let (mx, my) = app
        .get_webview_window(MAIN)
        .and_then(|w| w.outer_position().ok().zip(w.scale_factor().ok()))
        .map(|(p, s)| {
            let l = p.to_logical::<f64>(s);
            (l.x, l.y)
        })
        .unwrap_or((120.0, 120.0));
    let off = ((n - 1) % 6) as f64 * 28.0;

    // `/btw` 질문 창은 **작업 표시줄에서 구분되게** 제목만 다르다(2.6.2 `index.ts:551`).
    // 껍데기·크기·저장 경로는 추가 채팅과 글자 하나까지 같다 — 다른 것은 이 한 줄과,
    // 레코드에 심긴 시드(`btwOf`/`btwSeed`/`btwPrompt`)뿐이다.
    let btw_of = chat
        .and_then(ccg_store::chats_v3::stored_chat)
        .and_then(|c| c.get("btwOf").and_then(Value::as_str).map(str::to_string))
        .filter(|s| !s.is_empty());
    let win = shared_env(
        WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html#session".into())),
        &label,
    )
    .title(session_window_title(btw_of.is_some()))
    // 추가 채팅 창도 같은 번들·같은 loadPrefs 경로를 탄다 — 왕복을 똑같이 없앤다.
    .initialization_script(&boot_payload_script())
    // 추가 채팅 창에도 뷰어(FileModal)가 뜬다 — Ctrl+W는 그 창에서도 살아야 한다.
    .initialization_script(crate::ipc::parity::misc::CLOSE_SHORTCUT_JS)
    .inner_size(560.0, 720.0)
    .min_inner_size(360.0, 440.0)
    .position(mx + 80.0 + off, my + 80.0 + off)
    // 메인 창과 같은 껍데기 규칙(b안): 프레임리스 + 그림자 + 투명 + 아크릴.
    // 커스텀 타이틀바가 하나뿐이어야 하므로 decorations는 끈다.
    .decorations(false)
    .shadow(true)
    .transparent(chrome_mode() != 'c')
    .visible(false)
    .on_page_load(|w, payload| {
        if payload.event() == PageLoadEvent::Finished {
            crate::crash::note_page_load(w.label());
            // 추가 채팅 창은 R1에서 폴백을 **영영 못 받던** 자리다(부팅 3연발이 이미
            // 지나간 뒤에 태어난다). document-start 스냅샷 + 이 통지가 그 구멍이다.
            glass::note_document(w.label());
            let _ = w.show();
            let _ = w.set_focus();
        }
    });

    let win = if chrome_mode() != 'c' {
        use tauri::utils::config::WindowEffectsConfig;
        use tauri::window::Effect;
        win.effects(WindowEffectsConfig {
            effects: vec![Effect::Acrylic],
            state: None,
            radius: None,
            color: None,
        })
        .initialization_script(&glass::boot_script())
    } else {
        win
    }
    .build()?;

    // 추가 채팅 창도 같은 복구 경로를 탄다 — `--process-per-site`로 렌더러를 공유하므로
    // 렌더러가 한 번 죽으면 이 창들도 같이 유령이 된다.
    crate::crash::arm(app, &win);

    // 추가 채팅 창도 같은 껍데기(투명+아크릴)라 같은 방식으로 유리를 잃는다.
    if chrome_mode() != 'c' {
        glass::arm(app, &win);
    }

    SESSIONS.lock().unwrap().push(SessionRec {
        id,
        label: label.clone(),
        title: String::new(),
        status: "idle".into(),
        btw_of,
        minimized: false,
    });

    // 최대화 토글 통지는 창마다 자기 것만 받아야 한다(메인 창 타이틀바가 같이 뒤집히면 안 됨)
    let handle = app.clone();
    let l = label.clone();
    win.on_window_event(move |e| match e {
        WindowEvent::Resized(_) => {
            if let Some(w) = handle.get_webview_window(&l) {
                if let Ok(m) = w.is_maximized() {
                    let _ = handle.emit_to(l.as_str(), crate::ipc::ch::WIN_STATE, json!({ "maximized": m }));
                }
                // ★T4 — 최소화/복원은 tao에 전용 이벤트가 없다. Windows에서는 최소화가
                // `Resized`로 온다(크기 0). btw 알약은 "창이 내려가 있을 때만" 뜨므로
                // (`Chat.tsx:4885` `wins.filter(w => !w.shown)`) 이 전이를 놓치면 창을
                // 최소화해 놓고 알약을 찾을 수 없다 = 그 창으로 돌아갈 길이 사라진다.
                // **값이 바뀐 순간에만** 다시 쏜다 — 드래그 리사이즈는 초당 수십 번이다.
                let now = w.is_minimized().unwrap_or(false);
                let changed = {
                    let mut list = SESSIONS.lock().unwrap();
                    match list.iter_mut().find(|s| s.label == l) {
                        Some(rec) if rec.minimized != now => {
                            rec.minimized = now;
                            true
                        }
                        _ => false,
                    }
                };
                if changed {
                    broadcast_sessions(&handle);
                }
            }
        }
        // 이 창이 포커스를 되찾으면 그 창 몫의 알림 토스트는 무의미하다(notify.rs 수명 규약).
        WindowEvent::Focused(true) => notify::clear_for_window(&handle, &l),
        // ★파리티 R1 H5 — **여기가 비어 있었다.** 추가 채팅 창에는 `Destroyed`만 있었고
        // 닫기를 가로채는 자리가 없다 = 사용자가 X를 누르면 그 순간 문서가 죽는다.
        // 렌더러의 저장은 600ms 디바운스라, 마지막 편집(초안·스크롤·방금 온 응답)이
        // 창과 함께 사라질 수 있다. 팝아웃 창은 `popout.rs:255`가 합성 `beforeunload`로
        // 덮었는데 이 창만 안 덮여 있었다.
        WindowEvent::CloseRequested { api, .. } => {
            if begin_close_flush(&handle, &l) {
                api.prevent_close();
            }
        }
        WindowEvent::Destroyed => {
            FLUSH_WAIT.lock().unwrap().retain(|x| x != &l);
            SESSIONS.lock().unwrap().retain(|s| s.label != l);
            notify::clear_for_window(&handle, &l);
            broadcast_sessions(&handle);
        }
        _ => {}
    });
    broadcast_sessions(app);
    Ok(label)
}

// ── 닫기 전 마지막 저장 악수 (★파리티 R1 H5) ────────────────────────────────
//
// 2.6.2 `flushAndDestroy`/`finishFlush`(`index.ts:499-514`)의 자리다. 순서는 같다:
//   닫기 가로채기 → 그 창에 "지금 저장해" → 저장이 도착하면(또는 1.5초) 파기.
// 다른 것은 **숨기지 않는다**는 점 하나다. 2.6.2는 창을 숨겨 백그라운드 턴을 계속
// 돌렸지만, 3.0은 실행이 창이 아니라 **채팅에 붙어 있으므로**(`engine/hub`) 창을 없애도
// 턴은 계속 돈다 — 숨은 창을 들고 있을 이유가 없다(창 하나가 곧 메모리 25.1MB다).
//
// 상태를 `SessionRec`이 아니라 **라벨 집합**으로 따로 두는 이유: `chat_window_close`는
// 레지스트리에서 먼저 빼고 닫는 규약이라(과도 REPLACE 방지) 레코드에 매달면 그 경로에서
// 표식이 함께 사라진다.
static FLUSH_WAIT: Mutex<Vec<String>> = Mutex::new(Vec::new());
/// 렌더러가 답하지 않아도 창은 닫혀야 한다 — 2.6.2와 같은 1.5초.
const FLUSH_GRACE: Duration = Duration::from_millis(1500);

/// 닫기를 한 번 붙잡을까? `true`면 호출자가 `prevent_close()`를 한다.
///
/// 두 번째 닫기(=안전망 타이머나 저장 도착이 부른 `destroy`)에는 `false`를 돌려준다 —
/// 안 그러면 창이 영원히 안 닫힌다.
fn begin_close_flush(app: &AppHandle, label: &str) -> bool {
    let Some(chat) = chat_for_label(label) else {
        return false; // 이미 레지스트리에서 빠진 창(닫기 경로가 스스로 부른 close)
    };
    {
        let mut g = FLUSH_WAIT.lock().unwrap();
        if g.iter().any(|x| x == label) {
            return false;
        }
        g.push(label.to_string());
    }
    crate::ipc::windows::flush_req(app, &chat);
    let h = app.clone();
    let l = label.to_string();
    std::thread::spawn(move || {
        std::thread::sleep(FLUSH_GRACE);
        finish_close_flush(&h, &l);
    });
    true
}

/// 저장이 도착했거나 유예가 끝났다 — 창을 진짜로 없앤다.
///
/// `close()`가 아니라 `destroy()`다: `close()`는 `CloseRequested`를 다시 내므로
/// 위 가드가 없으면 무한 왕복이 된다(가드가 있어도 이벤트 한 번이 헛돈다).
pub fn finish_close_flush(app: &AppHandle, label: &str) {
    {
        let mut g = FLUSH_WAIT.lock().unwrap();
        let n = g.len();
        g.retain(|x| x != label);
        if g.len() == n {
            return; // 기다리던 창이 아니다(평범한 저장)
        }
    }
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.destroy();
    }
}

/// 추가 채팅 목록(계약면 SessionWindowInfo[]). 대화 영속은 M2 — 지금은 **열린 창**만이
/// 목록이다(닫으면 사라진다). 2.6.2는 닫아도 사이드바에 남고 클릭하면 창을 되만든다.
pub fn session_list() -> Value {
    let list = SESSIONS.lock().unwrap();
    Value::Array(
        list.iter()
            .map(|s| {
                let mut o = serde_json::Map::new();
                o.insert("id".into(), json!(s.id));
                o.insert("title".into(), json!(s.title));
                o.insert("status".into(), json!(s.status));
                o.insert("open".into(), json!(true));
                // `shown` = 창이 지금 눈에 보이는가. 2.6.2는 `isVisible() && !isMinimized()`
                // 였는데(`index.ts:467`) 3.0의 추가 채팅 창은 **숨김 상주가 없다**(닫기 =
                // 파기) → 남는 축은 최소화 하나다. btw 알약은 이 값이 거짓일 때만 뜬다.
                o.insert("shown".into(), json!(!s.minimized));
                // `/btw` 원본 채팅 id — 그 채팅 화면의 알약 도크가 이 값으로 자기 것만
                // 골라 그린다(`App.tsx:1995` `w.btwOf === activeChatId`). 없으면 **키째
                // 뺀다**: 계약면이 `btwOf?`(선택)이고, `null`이 실리면 일반 추가 채팅이
                // "원본 없는 btw"로 보인다.
                if let Some(b) = &s.btw_of {
                    o.insert("btwOf".into(), json!(b));
                }
                Value::Object(o)
            })
            .collect(),
    )
}

/// 추가 채팅 목록 브로드캐스트 — **`session-wins:list`와 같은 원천을 싣는다**(★R8-1).
///
/// 렌더러는 이 페이로드를 REPLACE로 먹는다(`App.tsx:219-220` `onChanged(setSessionWins)`).
/// 그래서 여기서 열린 창만 실으면, 창을 하나 열거나 닫는 순간 **영속된 추가 채팅이
/// 사이드바에서 사라진다** — 2.6.2에서 보이던 대화가 클릭 한 번에 증발하는 것과 구분되지
/// 않는다(크리틱 R8 §2.5, `CCG_UNIFIED_STORE` 기본값 전환의 전제). 통합 스토어가 켜져
/// 있으면 별칭 계층의 병합 함수를 그대로 쓰고, 꺼져 있으면 옛 동작(열린 창만) 그대로다.
pub fn broadcast_sessions(app: &AppHandle) {
    let payload = if ccg_store::unified_store_enabled() {
        crate::ipc::unified::session_wins_list()
    } else {
        session_list()
    };
    // ★확인 크리틱 R1 실패2 — **전 창에** 낸다(`emit_to(MAIN)`이 아니다).
    //
    // 2.6.2 `broadcastSessionWins`는 `BrowserWindow.getAllWindows()`를 돌며 주석까지
    // 달아 뒀다: *"메인 창뿐 아니라 전 창에 — 멀티 패널 팝아웃 창도 자기 panelId의 btw
    // 알약을 그리므로 목록 변화를 같이 받아야 한다."* 3.0은 메인에만 쐈는데, 심의
    // 구독이 대상 필터를 무력화하는 버그(`listen()`의 기본 대상 `Any`) 덕분에 **우연히**
    // 전 창에 닿고 있었다. 그 버그를 고치면 이 줄이 곧 팝아웃 창의 btw 알약을 죽인다.
    let _ = app.emit(crate::ipc::ch::SESSION_WINS_CHANGED, payload);
    // 3.0 계약면의 같은 사실 — `chat:windows`(WindowSlotInfo[] REPLACE, §6.1).
    // **둘 다 낸다**: 2.6.2 렌더러는 `session-wins:changed`만 알고, 3.0 화면은
    // `chat:windows`만 안다. 두 페이로드의 원천은 하나이므로 어긋날 수 없다.
    let _ = app.emit(crate::ipc::windows::CHAT_WINDOWS, window_slots(app));
}

/// 창 자리 목록 — `win:chat-list` / `chat:windows`의 페이로드(`WindowSlotInfo[]`).
///
/// `session_list()`와 다른 점: 이쪽은 **열려 있는 OS 창만**이고 창 라벨과 포커스를
/// 싣는다(자리 = 뷰). 영속됐지만 창이 없는 추가 채팅은 여기 없다 — 그건 사이드바의
/// 채팅 목록이 그리고, 클릭하면 `win:chat-focus`가 창을 되만든다.
pub fn window_slots(app: &AppHandle) -> Value {
    let list = SESSIONS.lock().unwrap().clone();
    Value::Array(
        list.iter()
            .map(|s| {
                let focused = app
                    .get_webview_window(&s.label)
                    .and_then(|w| w.is_focused().ok())
                    .unwrap_or(false);
                json!({ "label": s.label, "chatId": s.id, "title": s.title, "focused": focused })
            })
            .collect(),
    )
}

/// `win:chat-close` — **창만 닫는다. 대화는 남는다.**
///
/// `session_close`(2.6.2 사이드바 X)와 의미가 정반대라 함수를 나눈다: 그쪽 계약은
/// *"채팅 삭제 — 열린 창이 있으면 저장 없이 닫는다"*(protocol.ts)이고, 이쪽은 통합
/// 모델의 *"자리는 뷰, 대화는 접힐 뿐 사라지지 않는다"*이다. 한 함수로 합치면
/// 둘 중 하나가 반드시 대화를 잃는다.
pub fn chat_window_close(app: &AppHandle, chat: &str) -> bool {
    // ★R4 — 32/32. 창을 닫기 **전에** 그 창에 마지막 저장을 요청한다(§6.1 `chat:flush-req`).
    // 지금은 렌더러가 자기 디바운스로 저장하므로 없어도 대개 살아남지만, "대개"는
    // 계약이 아니다 — 디바운스가 안 내려간 마지막 편집이 창과 함께 사라진다.
    crate::ipc::windows::flush_req(app, chat);
    let label = {
        let mut list = SESSIONS.lock().unwrap();
        let label = list.iter().find(|s| s.id == chat).map(|s| s.label.clone());
        // R2.3과 같은 순서 규약: 레지스트리에서 **먼저** 뺀 뒤 브로드캐스트한다
        // (`w.close()`는 비동기라 그 전에 쏘면 이미 지운 항목이 실린 REPLACE가 나간다).
        list.retain(|s| s.id != chat);
        label
    };
    let found = label.is_some();
    if let Some(w) = label.and_then(|l| app.get_webview_window(&l)) {
        let _ = w.close();
    }
    broadcast_sessions(app);
    found
}

/// 사이드바에서 이름을 바꿨다 — 열린 창의 표시 이름도 그 값으로 고정한다
/// (이후 그 창의 자동 제목 보고는 `custom` 때문에 레코드를 못 덮는다).
pub fn session_rename(app: &AppHandle, id: &str, title: &str) {
    {
        let mut list = SESSIONS.lock().unwrap();
        if let Some(rec) = list.iter_mut().find(|s| s.id == id) {
            rec.title = title.to_string();
        }
    }
    broadcast_sessions(app);
}

/// 창 라벨 → 그 창의 추가 채팅 레코드. `session:report` 같은 "자기 자신" 채널용.
pub fn session_report(app: &AppHandle, label: &str, title: Option<&str>, status: Option<&str>) {
    {
        let mut list = SESSIONS.lock().unwrap();
        if let Some(rec) = list.iter_mut().find(|s| s.label == label) {
            // 사용자가 사이드바에서 붙인 이름은 창의 **자동** 제목이 못 이긴다
            // (`session-wins:rename`이 레코드에 `custom:true`를 세운다).
            let renamed = ccg_store::unified_store_enabled()
                && ccg_store::chats_v3::stored_chat(&rec.id)
                    .and_then(|c| c.get("custom").and_then(Value::as_bool))
                    .unwrap_or(false);
            if let Some(t) = title {
                if !t.is_empty() && !renamed {
                    rec.title = t.to_string();
                }
            }
            if let Some(st) = status {
                rec.status = st.to_string();
            }
        } else {
            return;
        }
    }
    broadcast_sessions(app);
}

/// 창 라벨 → 그 창이 보는 채팅 id. 엔진 글루의 주소 번역(`session:*` → chatId)이 쓴다.
/// 지금은 창 하나 = 채팅 하나(2.6.2 sessionWins와 같은 1:1)라 레코드의 id가 곧 채팅이다.
pub fn chat_for_label(label: &str) -> Option<String> {
    SESSIONS.lock().unwrap().iter().find(|s| s.label == label).map(|s| s.id.clone())
}

/// 역인덱스 — 이 채팅을 보고 있는 창의 라벨(§6.1 "chatId → label 역인덱스").
/// 이벤트 팬아웃이 **그 창에만** 보내려고 쓴다.
pub fn session_label_for_chat(chat: &str) -> Option<String> {
    SESSIONS.lock().unwrap().iter().find(|s| s.id == chat).map(|s| s.label.clone())
}

/// 사이드바 클릭 — 창이 있으면 앞으로, **닫힌 채팅이면 창을 다시 만들어 복원**한다.
///
/// R1은 앞 절반만 있었다(§4.4-E "영속된 추가 채팅을 클릭해서 창을 되만드는 경로가
/// 없다"). 이제 저장 채널이 있으므로 되만든 창이 `session-wins:hydrate`로 대화를
/// 되살린다 — 창 자리 채널(`win:chat-*`)을 새로 열지 않고 `session-wins:focus`
/// **한 채널의 의미를 2.6.2와 같게** 채우는 쪽을 골랐다(채널 수 불변).
pub fn session_focus(app: &AppHandle, id: &str) {
    let label = SESSIONS.lock().unwrap().iter().find(|s| s.id == id).map(|s| s.label.clone());
    if let Some(w) = label.and_then(|l| app.get_webview_window(&l)) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    // 창이 없다 — 영속된 추가 채팅이면 되만든다. **아무 id나 열어 주지는 않는다.**
    if ccg_store::unified_store_enabled() && ccg_store::legacy_bridge::is_session_chat(id) {
        if let Err(e) = open_session_window_for(app, Some(id)) {
            eprintln!("[win] 추가 채팅 창 복원 실패: {e}");
        }
    }
}

/// 이 채팅을 보는 창이 지금 떠 있나 — `win:chat-open`의 "이미 있으면 새로 만들지 않는다".
pub fn has_window_for(chat: &str) -> bool {
    SESSIONS.lock().unwrap().iter().any(|s| s.id == chat)
}

/// 사이드바 X — **대화 삭제**다(protocol.ts: *"(id) 채팅 삭제 — 열린 창이 있으면
/// 저장 없이 닫는다"*). 창만 닫고 레코드를 남기면 사용자가 지운 대화가 되살아난다.
pub fn session_close(app: &AppHandle, id: &str) {
    // ★ 레지스트리에서 **먼저** 뺀다. `w.close()`는 비동기라 `Destroyed`가 언제 올지
    //   모르는데, 그 전에 브로드캐스트하면 **이미 지운 항목이 실린 REPLACE**가 한 번
    //   나간다(R8-1이 고친 것과 같은 종류의 과도 상태). 뒤늦게 오는 `Destroyed`의
    //   retain은 no-op이 되고 브로드캐스트만 한 번 더 나간다 — REPLACE라 무해하다.
    let label = {
        let mut list = SESSIONS.lock().unwrap();
        let label = list.iter().find(|s| s.id == id).map(|s| s.label.clone());
        list.retain(|s| s.id != id);
        label
    };
    if let Some(w) = label.and_then(|l| app.get_webview_window(&l)) {
        let _ = w.close();
    }
    if ccg_store::unified_store_enabled() && ccg_store::legacy_bridge::is_session_chat(id) {
        ccg_store::chats_v3::remove_chat(id);
        // 그 채팅의 런타임도 거둔다(엔진이 살아 있으면 좀비 CLI가 남는다) + `chat:status`.
        //
        // ★R28b ACCT R3(G1) — R2는 `dispose_chat`(cast)만 불렀고, 브로드캐스트를
        // `Op::Dispose` 안의 `status::clear_runtime`에 매달았다. 그런데 바로 위
        // `remove_chat`이 `status::forget_one`으로 행을 **먼저** 지우므로
        // `clear_runtime`은 맵에 없는 키를 만나 `false`를 돌려주고, 그 브로드캐스트는
        // 영원히 안 나갔다 — 지운 대화의 「사용 중」 칩이 세션 내내 남았다.
        crate::engine::dispose_removed_chats(app, &[id.to_string()]);
    }
    broadcast_sessions(app);
}

/// 창 표시 — 어느 경로로 오든 한 번만.
pub fn show_once(w: &WebviewWindow) {
    if SHOWN.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = w.show();
    let _ = w.set_focus();
}

// ── 크래시 복구가 쓰는 상태 리셋 (crash.rs) ──────────────────────────────────
//
// 브라우저 프로세스가 죽어 창을 **재생성**할 때는 셸의 "한 번만" 상태를 되돌려야 한다.
// SHOWN을 안 지우면 새 메인 창이 영원히 안 보이고(= 또 다른 유령), SESSIONS를 안 지우면
// 죽은 창의 레코드가 목록에 남는다.
pub fn reset_shown() {
    SHOWN.store(false, Ordering::SeqCst);
    // 유리 감시 목록도 비운다 — 부서진 창의 hwnd가 남아 있으면 감시 스레드가 죽은
    // 핸들에 DWM 호출을 계속 던진다(IsWindow가 걸러 주지만, 재생성 창이 붙기 전까지
    // "감시 중인 창 0"으로 스레드가 스스로 끝나는 경로와 겹쳐 헷갈린다).
    glass::clear();
    // ★M8 — 새 창 종류도 같은 규약을 탄다. 팝아웃은 **레지스트리만** 비운다(복귀분은
    // 재생성의 재료라 남긴다). 토스트/트레이 메뉴는 오버레이라 다시 세우지 않고 치운다 —
    // 부서진 창의 라벨이 남으면 `notify::push`가 없는 창에 emit_to를 계속 던진다.
    popout::clear_windows();
    notify::drop_toast();
}

pub fn clear_sessions() {
    SESSIONS.lock().unwrap().clear();
    SESSION_SEQ.store(0, Ordering::Relaxed);
}

pub fn session_count() -> usize {
    SESSIONS.lock().unwrap().len()
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
