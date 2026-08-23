//! 웹뷰 프로세스 사망 감지 → 복구. **출시 블로커였던 자리다.**
//!
//! ## 무엇이 문제였나 (R3 크리틱 §7.3 실측)
//! 창 3개(메인 + 추가 채팅 2)를 띄우고 렌더러를 죽였더니 **세 구성 전부**
//! OS 창 3개가 화면에 그대로 남고(유령 창) 앱이 다시 마운트되지 않았다.
//! 사용자가 이미 "고아 상태(유령 UI)"를 실물 버그로 제보한 프로젝트에서
//! 메모리와 무관하게 막아야 하는 구멍이다. 2.6.2에도 `render-process-gone`
//! 핸들러가 없으니 파리티 회귀는 아니지만, 3.0에서 새로 생긴 사정이 하나 있다 —
//! `--process-per-site`로 **모든 창이 렌더러 하나를 공유**하므로 렌더러가 한 번
//! 죽으면 창 세 개가 한꺼번에 유령이 된다(2.6.2는 창마다 렌더러라 하나만 죽는다).
//!
//! ## 감지 수단 (둘 다 실증 가능)
//! 1. **`ICoreWebView2::add_ProcessFailed`** — WebView2가 공식으로 노출하는 이벤트다.
//!    wry/tauri는 이걸 감싸주지 않지만, `WebviewWindow::with_webview()`가 주는
//!    `ICoreWebView2Controller`에서 직접 붙일 수 있다(webview2-com 0.38 = tauri가 쓰는 판).
//!    렌더러 사망(`RENDER_PROCESS_EXITED`)·브라우저 사망(`BROWSER_PROCESS_EXITED`)·
//!    GPU/유틸 사망이 종류별로 온다.
//! 2. **브라우저 프로세스 PID 감시** — `--single-process`에서는 브라우저 프로세스가
//!    통째로 사라진다. COM 채널이 끊기면 이벤트가 못 올 수 있어(실측: 실제로 안 온다)
//!    `BrowserProcessId()`로 받아 둔 PID를 800ms마다 `OpenProcess`로 확인한다.
//!    이건 Chromium의 협조가 전혀 필요 없는 경로다.
//!
//! ## 복구 정책
//! | 사건 | 브라우저 | 하는 일 |
//! |---|---|---|
//! | 렌더러/프레임 렌더러 사망 | 살아 있음 | **모든 창을 reload()** — 문서가 다시 서고 유령이 사라진다 |
//! | 브라우저 사망(= `--in-process-gpu`에서 GPU 드라이버 크래시 포함) | 죽음 | 창을 전부 destroy 후 **재생성**. 이때 GPU를 별도 프로세스로 되돌린다(탈출구 자동 적용) |
//! | 브라우저 사망 + `CCG_SINGLE_PROCESS=1` | 죽음 | 재생성 경로가 없다 → **유령 대신 창 정리 + 프로세스 종료**로 진다(아래 참조) |
//!
//! ## ★ R5 — 연쇄 크래시에서 사건이 증발하던 세 자리 (R4 크리틱 §1.3 A2a·A3)
//!
//! R4의 상태 기계는 **단발 크래시만** 살렸다. 크리틱이 두 방향으로 깨뜨렸고 둘 다
//! 재현됐다. 원인은 셋이고, 셋 다 "감지는 했는데 아무도 받지 않는다"는 같은 모양이다.
//!
//! 1. **디바운스 사각지대.** `DEBOUNCE_MS(4000) > RECOVERING 해제(2500)`라서 그 사이
//!    1.5초에 온 **진짜 새 크래시**가 디바운스 분기에서 조용히 반환됐다. 재크래시로
//!    세지도 않으니 `MAX_RECOVERIES` 루프 가드도 안 걸린다. 복구가 `reload()`인 이상
//!    콘텐츠발 결정성 크래시는 **몇 초 안에 같은 자리에서 또 죽는 게 기본 경로**다.
//!    → 디바운스는 "같은 사건의 중복 이벤트"만 흡수하도록 좁히고(`DEBOUNCE_MS ≤ SETTLE_MS`
//!      를 **컴파일 타임에 강제**한다), 그 밖의 사건은 **절대 버리지 않는다**:
//!      복구 진행 중이면 `PENDING_CAUSE`에 적어 두고 게이트가 열리는 즉시 다시 태운다
//!      (`deferred` → `deferred-retry`). 사각지대는 폭을 줄인 게 아니라 **없어졌다**.
//! 2. **감시자 자해.** 워치독이 `recover()`가 받았는지 보지도 않고 `BROWSER_PID`를 0으로
//!    지웠다. 디바운스에 버려지면 그 뒤로는 `pid == 0 → continue`라 **감시 스레드가
//!    영구 실명**한다. 브라우저가 죽었으니 `ProcessFailed`도 못 오고 = 남은 감지 수단 0.
//!    → `recover()`가 `bool`(수락 여부)을 돌려주고, PID는 **수락된 복구 안에서** 그것도
//!      `pid_alive()`로 사망을 재확인한 뒤에만 지운다. 거부되면 PID를 살려 두고 다음
//!      틱(800ms)에 다시 시도한다.
//! 3. **복구했다는 로그만 있고 확인이 없었다.** `reload()`가 실패해도 한 줄 남기고 끝이라
//!    그대로 영구 유령이다.
//!    → 렌더러가 **실제로 문서를 세웠는지**를 하트비트로 판정한다: splash.js가 `#root`
//!      마운트 순간 `win:mounted`를 쏘고(→ `note_mounted`), 창 빌더의
//!      `on_page_load(Finished)`가 `note_page_load`를 부른다. 복구 후 `VERIFY_MS` 안에
//!      마운트가 안 오면 `verify-failed`를 남기고 **창 재생성으로 승격**한다.
//!      (하트비트가 이 빌드에서 한 번도 온 적이 없으면 — 주입 실패 등 — page-load로
//!       갈음한다. 없는 신호를 기다리다 매번 재생성으로 승격하는 사고를 막는다.)
//!
//! 부수 효과로 두 가지가 더 닫혔다:
//! - **고아 다이얼로그**(크리틱 A5): 복구 직전에 우리 프로세스의 네이티브 대화상자를
//!   닫는다(`crate::ipc::close_orphan_dialogs`). 열려 있던 '폴더 선택'을 받을 렌더러가
//!   없어 사용자가 폴더를 골라도 아무 일도 안 일어나던 자리다.
//! - **헤드리스 좀비**: 복구가 끝났는데 창이 하나도 없으면(복구 중 `ExitRequested`가
//!   막힌 뒤 등) 프로세스만 남는다 = 화면에 없는 유령. 그때는 정리하고 진다.
//!
//! ## single-process의 한계 (문서화 대상)
//! `--single-process`는 렌더러가 브라우저 프로세스 **안**에 있어서 렌더러가 죽으면
//! 브라우저가 같이 죽는다(실측 3프로세스 → 1). 남는 건 Rust 호스트뿐이고 그 시점엔
//! 웹뷰를 되살릴 대상이 없다. 새 환경을 만들어 창을 다시 그리는 것도
//! **미지원 구성에서의 미검증 경로**라 기본 동작으로 삼지 않는다. 대신 유령 창을
//! 남기지 않고 정리 후 종료한다 — 사용자가 다시 실행하면 정상 상태로 돌아온다.
//! 이 옵트인이 기본값이 될 수 없는 이유가 하나 더 늘어난 것이다.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, WebviewWindow};

/// 복구가 진행 중 — 이 동안은 "창이 다 닫혔다"고 앱을 끝내면 안 된다(main.rs의 ExitRequested).
static RECOVERING: AtomicBool = AtomicBool::new(false);
/// 브라우저 프로세스 PID(0 = 아직 모름). 감시 스레드가 이걸 본다.
static BROWSER_PID: AtomicU32 = AtomicU32::new(0);
/// 복구 횟수 — 무한 루프(복구 → 즉시 재크래시) 방지.
static RECOVERIES: AtomicU32 = AtomicU32::new(0);
/// 마지막으로 **수락된** 복구의 시작 시각(epoch ms) — 디바운스의 기준점.
static LAST_AT: AtomicU64 = AtomicU64::new(0);
/// 감시 스레드는 한 번만.
static WATCHDOG: AtomicBool = AtomicBool::new(false);
/// 앱이 정상 종료 중 — 이때의 브라우저 사망은 크래시가 아니다(아래 `begin_shutdown`).
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

/// 복구 중에 도착해 **유예된** 사건(0 = 없음). 게이트가 열리는 즉시 다시 태운다.
/// 값은 `Cause::code()` — 큰 쪽(BrowserGone)이 이긴다(`fetch_max`).
static PENDING_CAUSE: AtomicU8 = AtomicU8::new(0);
/// 마지막으로 **문서가 섰다**는 신호가 온 시각(epoch ms). `on_page_load(Finished)`.
static ALIVE_AT: AtomicU64 = AtomicU64::new(0);
/// 마지막 **마운트 하트비트**(splash.js → `win:mounted`) 시각. 복구 검증의 1순위 신호.
/// 0이면 "이 빌드에서 한 번도 온 적 없음" = 신호를 믿지 않는다(page-load로 갈음).
static MOUNTED_AT: AtomicU64 = AtomicU64::new(0);

const MAX_RECOVERIES: u32 = 5;
/// **같은 사건의 중복 이벤트만** 흡수하는 폭(창 3개가 각자 ProcessFailed를 쏜다).
/// 복구가 이미 새 문서를 세운 뒤(`ALIVE_AT > LAST_AT`)라면 중복이 아니라 새 크래시이므로
/// 이 창 안이라도 받는다 — `is_duplicate()` 참조.
const DEBOUNCE_MS: u64 = 1200;
/// 복구 게이트(`RECOVERING`)를 최소 이만큼 닫아 둔다. 재생성 중 종료 차단 + 이벤트 폭풍 흡수.
const SETTLE_MS: u64 = 2500;
/// 복구가 실제로 붙었는지(마운트 하트비트) 기다리는 상한.
/// 실측 재마운트: reload 291~528ms · 창 재생성 1.33~1.43s — 5배 이상 여유.
const VERIFY_MS: u64 = 3000;
/// 이만큼 조용했으면 "연쇄 크래시"가 아니다 — 포기 카운터를 되돌린다.
/// (안 되돌리면 한 주에 한 번씩 여섯 번째 크래시가 앱을 끝낸다.)
const RECOVERY_RESET_MS: u64 = 300_000;

/// **R4 블로커의 재발 방지선.** 디바운스 창이 복구 게이트보다 넓으면 그 차이만큼
/// "디바운스에 버려지는데 아무도 재시도하지 않는" 사각지대가 생긴다(크리틱 R4 §1.3 A2a).
/// 상수를 만지는 다음 사람은 여기서 컴파일 에러로 막힌다.
const _: () = assert!(DEBOUNCE_MS <= SETTLE_MS);

pub fn is_recovering() -> bool {
    RECOVERING.load(Ordering::SeqCst)
}

/// **정상 종료 시작.** 앱이 끝날 때도 WebView2 브라우저 프로세스는 죽는다 —
/// 감시자가 그걸 크래시로 오인하면 **닫아도 다시 뜨는 앱**이 된다(창 재생성 +
/// `ExitRequested` 차단까지 겹친다). main.rs의 `RunEvent::ExitRequested`에서 부른다.
/// 창이 하나도 없을 때도 같은 이유로 복구하지 않는다(watchdog 안에서 확인).
pub fn begin_shutdown() {
    SHUTTING_DOWN.store(true, Ordering::SeqCst);
}

fn shutting_down() -> bool {
    SHUTTING_DOWN.load(Ordering::SeqCst)
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// 로그 직렬화 — 아래 주석 참조. 여러 스레드가 같은 파일에 붙인다.
static LOG_LOCK: Mutex<()> = Mutex::new(());

/// 복구 로그 — 앱 홈의 `crash-recovery.log`에 한 줄 JSON으로 붙인다.
/// 벤치(bench/crash.mjs)가 이 파일을 읽어 **복구 시간**을 재고, 사용자 진단에도 쓴다.
///
/// ⚠ 한 줄을 **한 번의 write로** 쓴다. `writeln!`은 본문과 개행을 따로 쓸 수 있어서,
/// 감시 스레드와 복구 스레드가 같은 순간에 찍으면 두 줄이 글자 단위로 섞여 **둘 다
/// JSON 파싱에 실패한다**(R5 실측: `watchdog-browser-gone`과 `recover-begin`이 서로를
/// 먹어 하네스 타임라인에 빈 항목 두 개로 찍혔다). 뮤텍스 + 단일 write_all로 막는다.
pub fn log(event: &str, detail: serde_json::Value) {
    let line = serde_json::json!({
        "at": now_ms(),
        "event": event,
        "pid": std::process::id(),
        "detail": detail,
    });
    let path = ccg_store::app_home().join("crash-recovery.log");
    let _ = std::fs::create_dir_all(path.parent().unwrap_or(&path));
    use std::io::Write;
    let buf = format!("{line}\n");
    let _guard = LOG_LOCK.lock();
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(buf.as_bytes());
    }
}

// ── 생존 하트비트 (복구 검증의 신호원) ───────────────────────────────────────
//
// "복구했다"고 로그만 찍고 확인은 안 하던 자리를 닫는다(R4 크리틱 §1.3-(3)).
// 두 신호 다 **재로드마다 다시 온다** — 셸이 창을 안 부수는 reload 경로에서도
// 문서는 새로 서므로 판정에 쓸 수 있다.

/// 문서 하나가 로드를 마쳤다 — `WebviewWindowBuilder::on_page_load(Finished)`.
/// 셸 쪽 신호라 렌더러 번들의 협조가 필요 없다(2순위).
pub fn note_page_load(label: &str) {
    ALIVE_AT.store(now_ms(), Ordering::SeqCst);
    log("page-load", serde_json::json!({ "label": label }));
}

/// **마운트 하트비트** — splash.js가 `#root`에 자식이 생긴 순간 쏜다(`win:mounted`).
/// "창은 있는데 문서가 안 섰다"(= 유령 창의 정의)를 가르는 유일한 신호다(1순위).
pub fn note_mounted(label: &str) {
    let t = now_ms();
    MOUNTED_AT.store(t, Ordering::SeqCst);
    ALIVE_AT.store(t, Ordering::SeqCst);
    log("mounted", serde_json::json!({ "label": label }));
}

// ── ProcessFailed 등록 ───────────────────────────────────────────────────────

/// **복구 끄기 스위치** — `CCG_CRASH_RECOVERY=0`.
/// R3의 "유령 창" 상태를 **같은 바이너리로** 재현하기 위한 대조군이다. 수정 전/후를
/// 서로 다른 exe로 비교하면 "다른 게 또 있었던 것 아니냐"를 못 배제한다.
fn recovery_enabled() -> bool {
    !std::env::var("CCG_CRASH_RECOVERY").is_ok_and(|v| v == "0")
}

#[cfg(windows)]
pub fn arm(app: &AppHandle, win: &WebviewWindow) {
    if !recovery_enabled() {
        log("disabled", serde_json::json!({ "label": win.label(), "why": "CCG_CRASH_RECOVERY=0" }));
        return;
    }
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2ProcessFailedEventArgs2, COREWEBVIEW2_PROCESS_FAILED_KIND,
        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
    };
    use webview2_com::ProcessFailedEventHandler;
    use windows::core::Interface;

    let label = win.label().to_string();
    let handle = app.clone();
    let res = win.with_webview(move |pw| unsafe {
        let controller = pw.controller();
        let Ok(core) = controller.CoreWebView2() else {
            log("arm-failed", serde_json::json!({ "label": label, "why": "CoreWebView2() 없음" }));
            return;
        };
        // 브라우저 PID — 감시 스레드가 볼 값. 창마다 같다(shared_env로 환경을 공유하므로).
        let mut bpid: u32 = 0;
        if core.BrowserProcessId(&mut bpid).is_ok() && bpid != 0 {
            BROWSER_PID.store(bpid, Ordering::SeqCst);
        }

        let h = handle.clone();
        let l = label.clone();
        let handler = ProcessFailedEventHandler::create(Box::new(move |_wv, args| {
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND(-1);
            let mut exit_code: i32 = -1;
            let mut desc = String::new();
            if let Some(a) = args.as_ref() {
                let _ = a.ProcessFailedKind(&mut kind);
                if let Ok(a2) = a.cast::<ICoreWebView2ProcessFailedEventArgs2>() {
                    let _ = a2.ExitCode(&mut exit_code);
                    let mut pd = windows::core::PWSTR::null();
                    if a2.ProcessDescription(&mut pd).is_ok() && !pd.is_null() {
                        desc = pd.to_string().unwrap_or_default();
                        windows::Win32::System::Com::CoTaskMemFree(Some(pd.0 as *const _));
                    }
                }
            }
            let terminal = kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED;
            let renderer = kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED
                || kind == COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED;
            log(
                "process-failed",
                serde_json::json!({
                    "label": l, "kind": kind.0, "exitCode": exit_code, "desc": desc,
                    "terminal": terminal, "renderer": renderer
                }),
            );
            // UNRESPONSIVE는 "아직 살아 있는데 느리다"이다 — 죽이지 않는다(기록만).
            if kind != COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE {
                recover(&h, if terminal { Cause::BrowserGone } else { Cause::RendererGone });
            }
            Ok(())
        }));
        let mut token: i64 = 0;
        match core.add_ProcessFailed(&handler, &mut token) {
            Ok(()) => log("armed", serde_json::json!({ "label": label, "browserPid": bpid })),
            Err(e) => log("arm-failed", serde_json::json!({ "label": label, "why": e.to_string() })),
        }
        // 핸들러는 COM이 붙들고 있으므로 여기서 떨어뜨려도 된다(토큰은 앱 수명 = 웹뷰 수명).
    });
    if let Err(e) = res {
        log("arm-failed", serde_json::json!({ "label": win.label(), "why": e.to_string() }));
    }
    start_watchdog(app);
}

#[cfg(not(windows))]
pub fn arm(_app: &AppHandle, _win: &WebviewWindow) {}

// ── 브라우저 PID 감시 (single-process의 유일한 감지 경로) ────────────────────

#[cfg(windows)]
fn pid_alive(pid: u32) -> bool {
    use windows::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return false;
        };
        if h.is_invalid() {
            return false;
        }
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(h, &mut code).is_ok();
        let _ = CloseHandle(h);
        ok && code == STILL_ACTIVE.0 as u32
    }
}

#[cfg(not(windows))]
fn pid_alive(_pid: u32) -> bool {
    true
}

fn start_watchdog(app: &AppHandle) {
    if WATCHDOG.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        // 같은 PID에 대한 반복 보고는 접는다 — 수락될 때까지 800ms마다 재시도하므로.
        let mut reported: u32 = 0;
        loop {
            std::thread::sleep(Duration::from_millis(800));
            let pid = BROWSER_PID.load(Ordering::SeqCst);
            if pid == 0 || is_recovering() || shutting_down() {
                continue;
            }
            // 창이 하나도 없으면 되살릴 것도 없다 = 종료 경로다.
            if app.webview_windows().is_empty() {
                continue;
            }
            if !pid_alive(pid) {
                // ★ PID는 여기서 지우지 않는다. R4는 `recover()`가 받았는지 보지도 않고
                //   먼저 0으로 지워서, 디바운스에 버려지면 **감시 스레드가 영구 실명**했다
                //   (pid == 0 → continue, 브라우저가 죽었으니 ProcessFailed도 안 온다).
                //   지우는 일은 수락된 복구 안에서 한다 — 거부되면 다음 틱에 또 시도한다.
                let accepted = recover(&app, Cause::BrowserGone);
                if reported != pid || accepted {
                    log(
                        "watchdog-browser-gone",
                        serde_json::json!({ "browserPid": pid, "accepted": accepted }),
                    );
                    reported = pid;
                }
            } else {
                reported = 0;
            }
        }
    });
}

// ── 복구 ─────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq)]
enum Cause {
    RendererGone,
    BrowserGone,
}

impl Cause {
    /// 유예 큐(`PENDING_CAUSE`)에 담기는 값. 큰 쪽이 이긴다 — 브라우저 사망은
    /// reload로 못 고치므로 렌더러 사망 유예를 덮어써야 한다.
    fn code(self) -> u8 {
        match self {
            Cause::RendererGone => 1,
            Cause::BrowserGone => 2,
        }
    }
    fn from_code(c: u8) -> Option<Self> {
        match c {
            1 => Some(Cause::RendererGone),
            2 => Some(Cause::BrowserGone),
            _ => None,
        }
    }
    fn name(self) -> &'static str {
        match self {
            Cause::RendererGone => "renderer-gone",
            Cause::BrowserGone => "browser-gone",
        }
    }
}

/// 재생성 시점에 되살려야 할 추가 채팅 창 수. 재생성 중에 SESSIONS가 비어 버리므로
/// 미리 세어 둔다.
static PENDING_SESSIONS: Mutex<usize> = Mutex::new(0);

/// **같은 크래시가 창 수만큼 쏘는 중복 이벤트인가.**
///
/// 시간만으로는 못 가른다 — R4가 그래서 진짜 재크래시를 중복으로 버렸다. 여기서는
/// "복구가 이미 새 문서를 세웠는가"를 같이 본다: `ALIVE_AT > LAST_AT`이면 우리가 만든
/// 문서가 죽은 것이므로 **새 사건**이다. (중복 이벤트는 구조상 항상 reload보다 먼저
/// 온다 — ProcessFailed 콜백도 reload 디스패치도 같은 메인 스레드라 콜백 소진이 먼저다.)
fn is_duplicate(now: u64, last: u64) -> bool {
    if last == 0 || now.saturating_sub(last) >= DEBOUNCE_MS {
        return false;
    }
    ALIVE_AT.load(Ordering::SeqCst) <= last
}

/// 복구를 **수락했는가**. 거부(false)에는 세 가지가 있고 뜻이 다르다:
///   - 종료 중 / 중복 이벤트 → 버린다(정상)
///   - 복구 진행 중 → **유예한다**(`PENDING_CAUSE`) — 게이트가 열리면 다시 태운다
fn recover(app: &AppHandle, cause: Cause) -> bool {
    if shutting_down() {
        return false;
    }
    let now = now_ms();
    let last = LAST_AT.load(Ordering::SeqCst);
    if is_duplicate(now, last) {
        return false; // 같은 사건 — 창마다 이벤트가 오므로 첫 것만 처리
    }
    if RECOVERING.swap(true, Ordering::SeqCst) {
        // 복구 중에 온 **새** 사건이다. R4는 여기서 사건이 통째로 사라졌다(= 유령).
        PENDING_CAUSE.fetch_max(cause.code(), Ordering::SeqCst);
        log("deferred", serde_json::json!({ "cause": cause.name() }));
        return false;
    }
    // 오래 조용했으면 연쇄가 아니다 — 포기 카운터를 되돌린다.
    if last != 0 && now.saturating_sub(last) > RECOVERY_RESET_MS {
        RECOVERIES.store(0, Ordering::SeqCst);
    }
    LAST_AT.store(now, Ordering::SeqCst);
    let n = RECOVERIES.fetch_add(1, Ordering::SeqCst) + 1;

    if n > MAX_RECOVERIES {
        log("give-up", serde_json::json!({ "recoveries": n }));
        teardown_and_exit(app);
        return true;
    }

    let app2 = app.clone();
    std::thread::spawn(move || {
        let t0 = now_ms();
        // 열려 있던 네이티브 대화상자는 받을 렌더러가 사라졌다 = 고아 UI(크리틱 A5).
        // 복구가 문서를 다시 세우기 **전에** 걷는다.
        let closed = crate::ipc::close_orphan_dialogs();
        if closed > 0 {
            log("dialogs-closed", serde_json::json!({ "n": closed }));
        }

        let mut mode = "reload-all";
        match cause {
            Cause::RendererGone => {
                // 브라우저가 살아 있다 = 문서만 다시 세우면 된다. 창은 그대로 두므로
                // 위치·크기·포커스가 유지되고 사용자 눈에는 "새로고침"으로 보인다.
                log("recover-begin", serde_json::json!({ "mode": mode, "n": n }));
                reload_all(&app2);
            }
            Cause::BrowserGone => {
                if crate::webview_args::single_process() {
                    // 미지원 구성 — 되살릴 대상이 없다. 유령 대신 정리하고 진다.
                    log("recover-begin", serde_json::json!({ "mode": "teardown(single-process)", "n": n }));
                    teardown_and_exit(&app2);
                    return;
                }
                // 브라우저가 **정말** 죽었을 때만 감시 PID를 비운다(재생성 경로의 arm()이
                // 새 PID를 채운다). 오탐이면 살려 둬야 감시가 계속 산다.
                let pid = BROWSER_PID.load(Ordering::SeqCst);
                if pid != 0 && !pid_alive(pid) {
                    BROWSER_PID.store(0, Ordering::SeqCst);
                }
                // `--in-process-gpu`면 브라우저 사망의 가장 흔한 원인이 GPU 드라이버다
                // (TDR 포함). 재생성할 때는 탈출구로 간다 — GPU를 다시 별도 프로세스로.
                let escaped = crate::webview_args::escape_in_process_gpu();
                mode = "recreate-windows";
                log("recover-begin", serde_json::json!({ "mode": mode, "n": n, "gpuEscape": escaped }));
                recreate_windows(&app2);
            }
        }

        // ── 복구가 **실제로 붙었는지** 확인한다 (R4: 로그만 찍고 확인이 없었다) ──
        let mut verified = wait_recovered(t0);
        if verified.is_none() && !app2.webview_windows().is_empty() && mode == "reload-all" {
            // 창은 있는데 문서가 안 섰다 = 유령 창의 정의. reload로 안 되면 재생성으로 승격.
            log("verify-failed", serde_json::json!({ "n": n, "after": mode, "escalate": "recreate-windows" }));
            mode = "recreate-after-reload";
            let t1 = now_ms();
            recreate_windows(&app2);
            verified = wait_recovered(t1);
        }
        if verified.is_none() {
            log("verify-failed", serde_json::json!({ "n": n, "after": mode, "escalate": Option::<&str>::None }));
        }

        // 게이트는 최소 SETTLE_MS 동안 닫아 둔다(중복 흡수 + 재생성 중 종료 차단).
        let held = now_ms().saturating_sub(t0);
        if held < SETTLE_MS {
            std::thread::sleep(Duration::from_millis(SETTLE_MS - held));
        }
        RECOVERING.store(false, Ordering::SeqCst);
        log(
            "recover-done",
            serde_json::json!({ "ms": now_ms().saturating_sub(t0), "n": n, "mode": mode, "verifiedMs": verified }),
        );

        // 복구 중에 온 사건은 버리지 않고 유예해 뒀다 — 게이트가 열렸으니 지금 태운다.
        let pending = PENDING_CAUSE.swap(0, Ordering::SeqCst);
        if let Some(c) = Cause::from_code(pending) {
            log("deferred-retry", serde_json::json!({ "cause": c.name() }));
            recover(&app2, c);
            return;
        }
        // 창이 하나도 없이 복구가 끝났다 = 화면에 없는 프로세스만 남은 상태(헤드리스 좀비).
        // 복구 중에 ExitRequested를 막았을 때 도달할 수 있다 — 유령이므로 정리하고 진다.
        if !shutting_down() && app2.webview_windows().is_empty() {
            log("no-windows-after-recover", serde_json::json!({ "n": n }));
            teardown_and_exit(&app2);
        }
    });
    true
}

/// 모든 창의 문서를 다시 세운다(창은 부수지 않는다).
fn reload_all(app: &AppHandle) {
    let a = app.clone();
    let _ = app.run_on_main_thread(move || {
        for (label, w) in a.webview_windows() {
            match w.reload() {
                Ok(()) => log("reloaded", serde_json::json!({ "label": label })),
                Err(e) => log("reload-failed", serde_json::json!({ "label": label, "why": e.to_string() })),
            }
        }
    });
}

/// 창을 전부 부수고 다시 만든다 — 브라우저 사망(웹뷰 환경이 통째로 죽은 경우)과
/// reload가 문서를 못 세운 경우의 마지막 수단.
fn recreate_windows(app: &AppHandle) {
    let sessions = crate::win::session_count();
    *PENDING_SESSIONS.lock().unwrap() = sessions;
    // ★M8 — 팝아웃 창도 같은 방어 대상이다. 창을 부수기 **전에** 각 창의 최신 상태
    // (마지막 페르시스트 ?? 부트)를 떠 둔다 — 안 그러면 브라우저 사망 한 번에 팝아웃의
    // 초안·스레드가 통째로 사라진다(그리드로 접히지도 않는다: 메인 창도 같이 죽으므로
    // `ma:panel-closed`를 받을 이가 없다).
    let popouts = crate::win::popout::snapshot_for_recreate();
    let a = app.clone();
    let _ = app.run_on_main_thread(move || {
        for (label, w) in a.webview_windows() {
            let _ = w.destroy();
            log("destroyed", serde_json::json!({ "label": label }));
        }
    });
    std::thread::sleep(Duration::from_millis(400));
    let a = app.clone();
    let _ = app.run_on_main_thread(move || {
        crate::win::reset_shown();
        crate::win::clear_sessions();
        match crate::win::create_main(&a) {
            Ok(_) => log("recreated", serde_json::json!({ "label": "main" })),
            Err(e) => log("recreate-failed", serde_json::json!({ "why": e.to_string() })),
        }
        let want = *PENDING_SESSIONS.lock().unwrap();
        for _ in 0..want {
            let _ = crate::win::open_session_window(&a);
        }
        if want > 0 {
            log("recreated-sessions", serde_json::json!({ "n": want }));
        }
        // 팝아웃 창 되세우기 — 떠 둔 상태로 다시 만든다(그리드의 유령 표시와도 맞는다:
        // 새 메인 창의 마운트가 `ma:panel-states`로 열린 창 목록을 다시 조회한다).
        if popouts > 0 {
            let n = crate::win::popout::recreate_pending(&a);
            log("recreated-popouts", serde_json::json!({ "want": popouts, "got": n }));
        }
    });
}

/// `since` 이후에 문서가 실제로 섰는가 — 섰으면 걸린 ms, 아니면 None.
///
/// 1순위는 마운트 하트비트(`win:mounted`)다. 그 신호가 이 실행에서 한 번도 온 적이
/// 없으면(주입 실패·구형 번들) **없는 신호를 기다리다 매번 재생성으로 승격**하는 사고가
/// 나므로 page-load로 갈음한다.
fn wait_recovered(since: u64) -> Option<u64> {
    let use_mount = MOUNTED_AT.load(Ordering::SeqCst) != 0;
    let deadline = now_ms() + VERIFY_MS;
    loop {
        let at = if use_mount { MOUNTED_AT.load(Ordering::SeqCst) } else { ALIVE_AT.load(Ordering::SeqCst) };
        if at > since {
            return Some(at.saturating_sub(since));
        }
        if now_ms() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// 유령 창을 남기지 않고 진다 — 창을 전부 부수고 프로세스를 끝낸다.
fn teardown_and_exit(app: &AppHandle) {
    log("teardown", serde_json::json!({}));
    let a = app.clone();
    let _ = app.run_on_main_thread(move || {
        for (_l, w) in a.webview_windows() {
            let _ = w.destroy();
        }
    });
    std::thread::spawn(|| {
        // run_on_main_thread가 처리될 시간을 주고, 그래도 안 죽으면 강제 종료.
        std::thread::sleep(Duration::from_millis(600));
        log("exit", serde_json::json!({}));
        std::process::exit(0);
    });
}
