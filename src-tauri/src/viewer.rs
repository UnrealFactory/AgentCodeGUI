//! 파일 뷰어 **독립 창** — 코드 뷰어 카드를 별도 OS 창으로 (`#viewer`, `viewer:*`).
//!
//! ## 왜 창인가
//! 카드 뷰어(`FileModal`)는 메인 창 **안**의 오버레이라 창 밖으로 못 나간다. 사용자의
//! 요구는 "상단바를 잡아 옮기고, 다음 파일을 열 때도 거기 그 자리"이고 그 자리가
//! **다른 모니터**일 수 있다(한쪽은 IDE, 한쪽은 코드). 그러려면 OS 창이어야 한다 —
//! 추가 채팅 창·패널 팝아웃 창과 같은 결론이고, 같은 껍데기(`shared_env`·프레임리스·
//! 아크릴)로 만든다. 드래그는 `chrome.ts`가 재현하는 `-webkit-app-region:drag`라
//! Aero Snap·모서리 스냅·더블클릭 최대화가 전부 OS 것이다.
//!
//! ## 소유권 — "창은 자리, 파일은 페이로드"
//! 이 창은 대화를 갖지 않는다. 어느 창(메인·추가 채팅·팝아웃)이든 파일을 열 때
//! `viewer:open`에 **그 파일 하나에 필요한 것만**(경로·cwd·그 파일의 diff·Git 스냅샷
//! 오버라이드·질문 가능 여부)을 실어 보내고, 이 창은 그것을 그린다. 질문 패널의 전송
//! (`viewer:ask-selection`)과 「창 안으로」(`viewer:dock`)는 **마지막으로 파일을 보낸
//! 창**(ORIGIN)으로 되돌아간다 — 그 창의 채팅이 질문을 받고, 그 창의 카드가 파일을 되받는다.
//!
//! ## 끈적한 모드
//! 「별도 창으로」를 한 번 누르면 `viewer-window.json`의 `window`가 서고, 이후 모든
//! 파일 열기가 이 창으로 온다. 파일을 닫으면(Esc·Ctrl+W·X·Alt+F4) 창은 **부수지 않고
//! 숨긴다** — 다음 파일이 같은 자리에 창 생성 비용 없이 뜬다. 모드가 꺼지는 건
//! 「창 안으로」뿐이다(X는 파일 닫기이지 모드 해제가 아니다 — 듀얼 모니터에서 파일을
//! 닫을 때마다 모드가 풀리면 그게 더 불편하다).
//!
//! ## 빈 창이 먼저 번쩍이지 않게
//! 창을 만들거나 다시 보일 때 **렌더러가 파일을 그린 뒤**(`viewer:shown`)에 `show()`
//! 한다. 숨겨진 창은 페인트를 안 하지만 DOM 커밋은 그대로 돌므로, 보이는 순간 첫
//! 프레임이 이미 그 파일이다. 렌더러가 신호를 못 보내는 최악(청크 로드 실패 등)에는
//! 안전망 타이머가 창을 띄운다 — 창이 영영 안 보이는 경로는 없다.
//!
//! ## 창당 비용
//! 창을 만드는 유일한 경로는 `super::shared_env`다(win.rs 헤더의 규약). 숨긴 창이
//! 남기는 것은 그 문서의 DOM/힙뿐이다 — `--process-per-site`로 렌더러를 공유하므로
//! 프로세스가 하나 더 생기지 않는다(실측은 `scripts/poc-viewer-window.mjs`).

use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{webview::PageLoadEvent, AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use ccg_store::viewer_state::{self, ViewerState};

use super::{chrome_mode, shared_env, MAIN};
use crate::ipc::windows::{VIEWER_ASK, VIEWER_DOCKED, VIEWER_MODE, VIEWER_OPEN};

/// 창 라벨. 하나뿐이다 — 뷰어는 "파일 하나를 보는 자리"라 창이 여럿일 이유가 없고,
/// 둘 이상이면 "다음 파일은 어느 창으로"라는 질문이 생긴다.
pub const LABEL: &str = "viewer";

/// 디스크 상태의 프로세스 내 사본(첫 조회 때 읽는다). 저장은 `update()`를 통해서만.
static STATE: Mutex<Option<ViewerState>> = Mutex::new(None);
/// 마지막 `viewer:open` 페이로드 — 창의 마운트/재로드 복원분(`viewer:hydrate`).
/// 파일을 닫으면(`hide`) 비운다: 재로드 뒤에 닫았던 파일이 되살아나면 안 된다.
static BOOT: Mutex<Option<Value>> = Mutex::new(None);
/// 마지막으로 파일을 보낸 창의 라벨 — 질문 전송·「창 안으로」의 되돌아갈 주소.
static ORIGIN: Mutex<Option<String>> = Mutex::new(None);
/// 창 레지스트리(라벨 하나라 비트 하나). `get_webview_window`가 죽은 창을 잠깐 돌려주는
/// 창(Destroyed 직전)을 걸러 주는 용도이기도 하다.
static EXISTS: AtomicBool = AtomicBool::new(false);
/// 렌더러의 `viewer:shown`을 기다리는 중인가.
static PENDING_SHOW: AtomicBool = AtomicBool::new(false);
/// 안전망 타이머의 세대 — 늦게 깬 타이머가 다음 열기의 창을 엉뚱하게 띄우지 않게.
static SHOW_SEQ: AtomicI64 = AtomicI64::new(0);
/// 창을 만들 때 저장본이 최대화였나 — 첫 `show()`에서 한 번 적용하고 버린다.
/// (숨김 창에 `.maximized(true)`를 걸면 만들면서 잠깐 보이는 사고가 있다.)
static RESTORE_MAX: AtomicBool = AtomicBool::new(false);
/// 위치·크기 저장 디바운스 — 메인 창과 같은 400ms.
const SAVE_DEBOUNCE: Duration = Duration::from_millis(400);
static SAVE_TX: OnceLock<Sender<()>> = OnceLock::new();
/// 안전망 — 창을 새로 만들 때(청크 로드·파일 읽기 포함)와 숨긴 창을 다시 보일 때.
const COLD_SHOW_FALLBACK: Duration = Duration::from_millis(1500);
const WARM_SHOW_FALLBACK: Duration = Duration::from_millis(600);
/// 하네스가 읽는 회계 — 안전망이 실제로 창을 띄운 횟수(0이어야 정상 경로).
static FALLBACK_SHOWS: AtomicI64 = AtomicI64::new(0);

fn state() -> ViewerState {
    let mut g = STATE.lock().unwrap_or_else(|e| e.into_inner());
    g.get_or_insert_with(viewer_state::load).clone()
}

fn update(f: impl FnOnce(&mut ViewerState)) -> ViewerState {
    let mut g = STATE.lock().unwrap_or_else(|e| e.into_inner());
    let st = g.get_or_insert_with(viewer_state::load);
    f(st);
    let snap = st.clone();
    drop(g);
    let _ = viewer_state::save(&snap);
    snap
}

/// 창의 **제목 표시줄** 문구(작업 표시줄에도 뜬다) — 다른 창들과 같은 `t()` 규약.
pub(crate) fn viewer_window_title() -> String {
    ccg_fs::t("파일 뷰어 — AgentCodeGUI", "File viewer — AgentCodeGUI")
}

// ── 모드 ────────────────────────────────────────────────────────────────────

/// `viewer:state` — 렌더러가 "파일을 어디로 열지" 동기 판정에 쓰는 값. 부팅 페이로드에도
/// 실린다(`win.rs boot_payload_script`) — 첫 클릭 전에 왕복이 없다.
pub fn state_json() -> Value {
    json!({ "window": state().window })
}

/// `viewer:set-mode` — 끈적한 모드 전환. **전 창 브로드캐스트**(`emit`)로 알린다:
/// 어느 창이 바꿨든 모든 창의 다음 파일 클릭이 같은 답을 내야 한다.
pub fn set_mode(app: &AppHandle, on: bool) {
    if state().window == on {
        return;
    }
    update(|s| s.window = on);
    let _ = app.emit(VIEWER_MODE, json!({ "window": on }));
}

// ── 열기 / 표시 ─────────────────────────────────────────────────────────────

fn window_of(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    if !EXISTS.load(Ordering::Relaxed) {
        return None;
    }
    app.get_webview_window(LABEL)
}

/// `viewer:open` — 파일 하나를 이 창으로. 창이 없으면 만들고, 숨겨져 있으면 그린 뒤
/// 보이고, 보이는 중이면 내용만 바꾼다. `false`면 "창을 못 세웠다"이고 호출 창은
/// 카드 뷰어로 물러난다(모드는 그대로 — 다음 시도에 또 창을 노린다).
pub fn open(app: &AppHandle, origin: &str, payload: &Value) -> bool {
    let has_path = payload.get("path").and_then(Value::as_str).is_some_and(|s| !s.is_empty());
    if !has_path {
        return false;
    }
    *BOOT.lock().unwrap_or_else(|e| e.into_inner()) = Some(payload.clone());
    // 뷰어 창 자신이 부른 열기(있다면)는 주소를 바꾸지 않는다 — 되돌아갈 곳은 여전히 원래 창.
    if origin != LABEL {
        *ORIGIN.lock().unwrap_or_else(|e| e.into_inner()) = Some(origin.to_string());
    }

    if let Some(w) = window_of(app) {
        let _ = app.emit_to(LABEL, VIEWER_OPEN, payload.clone());
        if w.is_visible().unwrap_or(false) {
            // 이미 보이는 창 — 내용은 방금 보냈고, 앞으로만 가져온다(최소화돼 있으면 되살린다).
            let _ = w.unminimize();
            let _ = w.set_focus();
        } else {
            arm_show(app, WARM_SHOW_FALLBACK);
        }
        return true;
    }
    match create(app, origin) {
        Ok(()) => true,
        Err(e) => {
            eprintln!("[win] 뷰어 창 생성 실패: {e}");
            false
        }
    }
}

/// `viewer:hydrate` — 창의 마운트/재로드 복원분. 닫은 뒤(`hide`)라면 `null`.
pub fn hydrate() -> Value {
    BOOT.lock().unwrap_or_else(|e| e.into_inner()).clone().unwrap_or(Value::Null)
}

/// `viewer:shown` — 렌더러가 파일을 그렸다. 기다리던 중이면 지금 보인다(아니면 no-op).
pub fn shown(app: &AppHandle) {
    if PENDING_SHOW.swap(false, Ordering::SeqCst) {
        SHOW_SEQ.fetch_add(1, Ordering::Relaxed); // 대기 중이던 안전망 무효화
        do_show(app);
    }
}

fn do_show(app: &AppHandle) {
    let Some(w) = window_of(app) else { return };
    let _ = w.show();
    if RESTORE_MAX.swap(false, Ordering::Relaxed) {
        let _ = w.maximize();
    }
    let _ = w.unminimize();
    let _ = w.set_focus();
}

/// 렌더러의 신호를 기다리되, 안전망 타이머를 함께 건다.
fn arm_show(app: &AppHandle, fallback: Duration) {
    PENDING_SHOW.store(true, Ordering::SeqCst);
    let seq = SHOW_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    let a = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(fallback);
        let a2 = a.clone();
        let _ = a.run_on_main_thread(move || {
            if SHOW_SEQ.load(Ordering::Relaxed) != seq {
                return; // 그 사이 정상 신호가 왔거나 다음 열기가 시작됐다
            }
            if PENDING_SHOW.swap(false, Ordering::SeqCst) {
                FALLBACK_SHOWS.fetch_add(1, Ordering::Relaxed);
                do_show(&a2);
            }
        });
    });
}

/// `viewer:hide` — 파일을 닫았다. 창은 숨긴다(부수지 않는다 — 다음 파일이 같은 자리에
/// 창 생성 비용 없이 뜬다). 자리를 먼저 저장해 두어 그 뒤 앱이 어떻게 죽어도 남는다.
pub fn hide(app: &AppHandle) {
    PENDING_SHOW.store(false, Ordering::SeqCst);
    SHOW_SEQ.fetch_add(1, Ordering::Relaxed);
    *BOOT.lock().unwrap_or_else(|e| e.into_inner()) = None;
    if let Some(w) = window_of(app) {
        save_now(app);
        let _ = w.hide();
    }
}

fn origin_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    let origin = ORIGIN.lock().unwrap_or_else(|e| e.into_inner()).clone();
    origin
        .and_then(|l| app.get_webview_window(&l))
        .or_else(|| app.get_webview_window(MAIN))
}

fn raise(w: &tauri::WebviewWindow) {
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
}

/// `viewer:dock` — 「창 안으로」. 모드를 끄고 창을 숨긴 뒤, 지금 보던 파일을 원래 창의
/// 카드 뷰어로 되돌려 준다(원래 창이 없으면 메인 창).
pub fn dock(app: &AppHandle, payload: &Value) {
    set_mode(app, false);
    hide(app);
    if let Some(w) = origin_window(app) {
        let _ = app.emit_to(w.label(), VIEWER_DOCKED, payload.clone());
        raise(&w);
    }
}

/// `viewer:ask-selection` — 뷰어 창의 질문 패널에서 보낸 질문을 원래 창의 채팅으로.
/// 그 창을 앞으로 가져온다 — 질문이 어디로 갔는지 사용자가 바로 본다.
pub fn ask_selection(app: &AppHandle, payload: &Value) {
    if let Some(w) = origin_window(app) {
        let _ = app.emit_to(w.label(), VIEWER_ASK, payload.clone());
        raise(&w);
    }
}

// ── 창 생성 ─────────────────────────────────────────────────────────────────

fn create(app: &AppHandle, origin: &str) -> tauri::Result<()> {
    let st = state();

    let mut b = shared_env(
        WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html#viewer".into())),
        LABEL,
    )
    .title(viewer_window_title())
    .initialization_script(&super::boot_payload_script())
    // Ctrl+W는 이 창에서도 "파일 닫기"다(카드 뷰어와 같은 규칙 — 추가 채팅 창의 주석 참고).
    .initialization_script(crate::ipc::parity::misc::CLOSE_SHORTCUT_JS)
    .inner_size(st.win.width as f64, st.win.height as f64)
    .min_inner_size(viewer_state::MIN_W as f64, viewer_state::MIN_H as f64)
    // 다른 앱 창들과 같은 껍데기(b안): 프레임리스 + 그림자 + 투명 + 아크릴.
    .decorations(false)
    .shadow(true)
    .transparent(chrome_mode() != 'c')
    .visible(false)
    .on_page_load(|w, payload| {
        if payload.event() == PageLoadEvent::Finished {
            crate::crash::note_page_load(w.label());
            // 나중에 태어난 창은 부팅 3연발을 못 받는다 — 추가 채팅·팝아웃 창과 같은 구멍, 같은 처방.
            super::glass::note_document(w.label());
            // 창 표시는 렌더러가 파일을 그린 뒤(`viewer:shown`) — 여기서는 안전망만 건다.
            arm_show(w.app_handle(), COLD_SHOW_FALLBACK);
        }
    });

    // 자리: 저장된 자리가 지금 모니터 어딘가에 걸쳐 있으면 거기(듀얼 모니터의 그 자리),
    // 아니면(모니터가 빠졌거나 처음) 부른 창에서 살짝 어긋나게 — 겹쳐서 안 보이는 사고 방지.
    if super::on_screen(app, &st.win) {
        b = b.position(st.win.x.unwrap_or(0) as f64, st.win.y.unwrap_or(0) as f64);
    } else {
        let (ox, oy) = app
            .get_webview_window(origin)
            .or_else(|| app.get_webview_window(MAIN))
            .and_then(|w| w.outer_position().ok().zip(w.scale_factor().ok()))
            .map(|(p, s)| {
                let l = p.to_logical::<f64>(s);
                (l.x, l.y)
            })
            .unwrap_or((120.0, 120.0));
        b = b.position(ox + 60.0, oy + 60.0);
    }

    if chrome_mode() != 'c' {
        use tauri::utils::config::WindowEffectsConfig;
        use tauri::window::Effect;
        b = b
            .effects(WindowEffectsConfig {
                effects: vec![Effect::Acrylic],
                state: None,
                radius: None,
                color: None,
            })
            .initialization_script(&super::glass::boot_script());
    }

    let win = b.build()?;
    super::apply_resource_icon(&win);
    // 계약: 모든 앱 크롬 창은 shared_env + 크래시 방어 + 유리 유지.
    crate::crash::arm(app, &win);
    if chrome_mode() != 'c' {
        super::glass::arm(app, &win);
    }
    EXISTS.store(true, Ordering::SeqCst);
    RESTORE_MAX.store(st.win.maximized, Ordering::Relaxed);

    let handle = app.clone();
    win.on_window_event(move |e| match e {
        WindowEvent::Resized(_) => {
            // 최대화 토글은 Resized로 온다 — 헤더의 최대화/복원 아이콘이 따라오게 통지
            if let Some(w) = handle.get_webview_window(LABEL) {
                if let Ok(m) = w.is_maximized() {
                    let _ = handle.emit_to(LABEL, crate::ipc::ch::WIN_STATE, json!({ "maximized": m }));
                }
            }
            schedule_save(&handle);
        }
        WindowEvent::Moved(_) => schedule_save(&handle),
        // 이 창이 포커스를 되찾으면 그 창 몫의 알림 토스트는 무의미하다(notify.rs 수명 규약).
        WindowEvent::Focused(true) => super::notify::clear_for_window(&handle, LABEL),
        // X·Alt+F4 = **파일 닫기**. 렌더러의 닫기 경로(미저장 편집 확인 카드 포함)를 그대로
        // 태우려고 Ctrl+W와 같은 신호를 보낸다 — 렌더러가 닫기로 결정하면 `viewer:hide`가 온다.
        // 종료·크래시 복구 중에는 가로채지 않는다(창이 못 죽는 실패 모드가 그쪽이 더 나쁘다).
        WindowEvent::CloseRequested { api, .. } => {
            if !(crate::crash::is_recovering() || super::tray::is_quitting()) {
                api.prevent_close();
                let _ = handle.emit_to(LABEL, crate::ipc::parity::misc::SHORTCUT_CLOSE, Value::Null);
            } else {
                save_now(&handle);
            }
        }
        WindowEvent::Destroyed => {
            EXISTS.store(false, Ordering::SeqCst);
            PENDING_SHOW.store(false, Ordering::SeqCst);
            super::notify::clear_for_window(&handle, LABEL);
        }
        _ => {}
    });
    Ok(())
}

// ── 자리 저장 ───────────────────────────────────────────────────────────────

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

/// 지금 창 자리를 viewer-window.json으로. 최대화 중이면 창 모드 크기는 마지막 값을 지킨다.
fn save_now(app: &AppHandle) {
    let Some(w) = window_of(app) else { return };
    let maximized = w.is_maximized().unwrap_or(false);
    let minimized = w.is_minimized().unwrap_or(false);
    let bounds = if maximized || minimized {
        None // 최소화 창의 좌표는 (-32000,-32000) — 그걸 저장하면 다음 창이 화면 밖에 뜬다
    } else {
        w.outer_position().ok().zip(w.inner_size().ok()).zip(w.scale_factor().ok())
    };
    update(|s| {
        if let Some(((pos, size), scale)) = bounds {
            let p = pos.to_logical::<f64>(scale);
            let sz = size.to_logical::<f64>(scale);
            s.win.x = Some(p.x.round() as i64);
            s.win.y = Some(p.y.round() as i64);
            s.win.width = (sz.width.round() as i64).max(viewer_state::MIN_W);
            s.win.height = (sz.height.round() as i64).max(viewer_state::MIN_H);
        }
        if !minimized {
            s.win.maximized = maximized;
        }
    });
}

// ── 크래시 복구 / 진단 ──────────────────────────────────────────────────────

/// 창이 전부 부서졌다(crash.rs `recreate_windows`) — 레지스트리를 비운다. 되세우지는
/// 않는다: 뷰어는 파일 하나를 보는 자리라 다음 클릭이 곧 복구다. 모드·자리는 디스크에 있다.
pub fn clear_windows() {
    EXISTS.store(false, Ordering::SeqCst);
    PENDING_SHOW.store(false, Ordering::SeqCst);
}

/// 진단 — 하네스(`scripts/poc-viewer-window.mjs`)가 읽는 회계.
pub fn debug_state(app: &AppHandle) -> Value {
    let st = state();
    let win = window_of(app).map(|w| {
        let scale = w.scale_factor().unwrap_or(1.0);
        let pos = w.outer_position().ok().map(|p| p.to_logical::<f64>(scale));
        let size = w.inner_size().ok().map(|s| s.to_logical::<f64>(scale));
        json!({
            "visible": w.is_visible().unwrap_or(false),
            "minimized": w.is_minimized().unwrap_or(false),
            "maximized": w.is_maximized().unwrap_or(false),
            "x": pos.map(|p| p.x.round()),
            "y": pos.map(|p| p.y.round()),
            "width": size.map(|s| s.width.round()),
            "height": size.map(|s| s.height.round()),
        })
    });
    json!({
        "exists": win.is_some(),
        "win": win,
        "mode": st.window,
        "saved": { "x": st.win.x, "y": st.win.y, "width": st.win.width, "height": st.win.height, "maximized": st.win.maximized },
        "origin": ORIGIN.lock().unwrap_or_else(|e| e.into_inner()).clone(),
        "bootPath": BOOT.lock().unwrap_or_else(|e| e.into_inner()).as_ref().and_then(|b| b.get("path").cloned()),
        "pendingShow": PENDING_SHOW.load(Ordering::Relaxed),
        "fallbackShows": FALLBACK_SHOWS.load(Ordering::Relaxed),
    })
}
