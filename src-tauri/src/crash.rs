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
//! ## single-process의 한계 (문서화 대상)
//! `--single-process`는 렌더러가 브라우저 프로세스 **안**에 있어서 렌더러가 죽으면
//! 브라우저가 같이 죽는다(실측 3프로세스 → 1). 남는 건 Rust 호스트뿐이고 그 시점엔
//! 웹뷰를 되살릴 대상이 없다. 새 환경을 만들어 창을 다시 그리는 것도
//! **미지원 구성에서의 미검증 경로**라 기본 동작으로 삼지 않는다. 대신 유령 창을
//! 남기지 않고 정리 후 종료한다 — 사용자가 다시 실행하면 정상 상태로 돌아온다.
//! 이 옵트인이 기본값이 될 수 없는 이유가 하나 더 늘어난 것이다.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, WebviewWindow};

/// 복구가 진행 중 — 이 동안은 "창이 다 닫혔다"고 앱을 끝내면 안 된다(main.rs의 ExitRequested).
static RECOVERING: AtomicBool = AtomicBool::new(false);
/// 브라우저 프로세스 PID(0 = 아직 모름). 감시 스레드가 이걸 본다.
static BROWSER_PID: AtomicU32 = AtomicU32::new(0);
/// 복구 횟수 — 무한 루프(복구 → 즉시 재크래시) 방지.
static RECOVERIES: AtomicU32 = AtomicU32::new(0);
/// 마지막 복구 시각(epoch ms) — 디바운스.
static LAST_AT: AtomicU64 = AtomicU64::new(0);
/// 감시 스레드는 한 번만.
static WATCHDOG: AtomicBool = AtomicBool::new(false);
/// 앱이 정상 종료 중 — 이때의 브라우저 사망은 크래시가 아니다(아래 `begin_shutdown`).
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

const MAX_RECOVERIES: u32 = 5;
/// 이 안에 또 오면 같은 사건으로 본다(창 3개가 각자 이벤트를 쏘므로 필요).
const DEBOUNCE_MS: u64 = 4000;
/// 이만큼 조용했으면 "연쇄 크래시"가 아니다 — 포기 카운터를 되돌린다.
/// (안 되돌리면 한 주에 한 번씩 여섯 번째 크래시가 앱을 끝낸다.)
const RECOVERY_RESET_MS: u64 = 300_000;

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

/// 복구 로그 — 앱 홈의 `crash-recovery.log`에 한 줄 JSON으로 붙인다.
/// 벤치(bench/crash.mjs)가 이 파일을 읽어 **복구 시간**을 재고, 사용자 진단에도 쓴다.
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
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{line}");
    }
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
    std::thread::spawn(move || loop {
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
            log("watchdog-browser-gone", serde_json::json!({ "browserPid": pid }));
            BROWSER_PID.store(0, Ordering::SeqCst);
            recover(&app, Cause::BrowserGone);
        }
    });
}

// ── 복구 ─────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq)]
enum Cause {
    RendererGone,
    BrowserGone,
}

/// 재생성 시점에 되살려야 할 추가 채팅 창 수. 재생성 중에 SESSIONS가 비어 버리므로
/// 미리 세어 둔다.
static PENDING_SESSIONS: Mutex<usize> = Mutex::new(0);

fn recover(app: &AppHandle, cause: Cause) {
    if shutting_down() {
        return;
    }
    let now = now_ms();
    let last = LAST_AT.load(Ordering::SeqCst);
    if now.saturating_sub(last) < DEBOUNCE_MS {
        return; // 같은 사건 — 창마다 이벤트가 오므로 첫 것만 처리
    }
    if RECOVERING.swap(true, Ordering::SeqCst) {
        return;
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
        return;
    }

    let app2 = app.clone();
    std::thread::spawn(move || {
        let t0 = now_ms();
        match cause {
            Cause::RendererGone => {
                // 브라우저가 살아 있다 = 문서만 다시 세우면 된다. 창은 그대로 두므로
                // 위치·크기·포커스가 유지되고 사용자 눈에는 "새로고침"으로 보인다.
                log("recover-begin", serde_json::json!({ "mode": "reload-all", "n": n }));
                let a = app2.clone();
                let _ = app2.run_on_main_thread(move || {
                    for (label, w) in a.webview_windows() {
                        match w.reload() {
                            Ok(()) => log("reloaded", serde_json::json!({ "label": label })),
                            Err(e) => log("reload-failed", serde_json::json!({ "label": label, "why": e.to_string() })),
                        }
                    }
                });
            }
            Cause::BrowserGone => {
                if crate::webview_args::single_process() {
                    // 미지원 구성 — 되살릴 대상이 없다. 유령 대신 정리하고 진다.
                    log("recover-begin", serde_json::json!({ "mode": "teardown(single-process)", "n": n }));
                    teardown_and_exit(&app2);
                    return;
                }
                // `--in-process-gpu`면 브라우저 사망의 가장 흔한 원인이 GPU 드라이버다
                // (TDR 포함). 재생성할 때는 탈출구로 간다 — GPU를 다시 별도 프로세스로.
                let escaped = crate::webview_args::escape_in_process_gpu();
                log("recover-begin", serde_json::json!({ "mode": "recreate-windows", "n": n, "gpuEscape": escaped }));
                let sessions = crate::win::session_count();
                *PENDING_SESSIONS.lock().unwrap() = sessions;
                let a = app2.clone();
                let _ = app2.run_on_main_thread(move || {
                    for (label, w) in a.webview_windows() {
                        let _ = w.destroy();
                        log("destroyed", serde_json::json!({ "label": label }));
                    }
                });
                std::thread::sleep(Duration::from_millis(400));
                let a = app2.clone();
                let _ = app2.run_on_main_thread(move || {
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
                });
            }
        }
        // 복구가 실제로 붙을 시간을 준 뒤 게이트를 연다(재크래시 감지 재개).
        std::thread::sleep(Duration::from_millis(2500));
        RECOVERING.store(false, Ordering::SeqCst);
        log("recover-done", serde_json::json!({ "ms": now_ms().saturating_sub(t0), "n": n }));
    });
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
