//! 포커스 밖 알림 **토스트 창** (`toast.html`).
//!
//! 원본: 2.6.2 `src/main/notifyToast.ts`(203줄) — 규약을 그대로 옮긴다.
//!
//! 채팅 표면(메인 창·멀티 패널·추가 채팅 창)이 전이(턴 종료/승인 대기/질문)를 알리면,
//! **그 채팅이 사는 창이 포커스를 잃은 경우에만** 커서가 있는 모니터 우하단에 작은 창을
//! 띄운다. 창=카드: frameless + 불투명 검정 + **포커스 불가**.
//!
//! ## 수명 (2.6.2와 같다 — 타이머로 사라지지 않는다)
//! 자동 닫힘은 **없다**(사용자 결정, `notifyToast.ts:13`). 소멸 경로는 셋뿐이다:
//!   1. 그 창이 포커스를 되찾음 → 그 창 몫의 항목이 사라진다(`clear_for_window`)
//!   2. 카드 클릭(점프) → 라우팅 후 그 창 몫을 즉시 비운다
//!   3. ✕ → 전부 비운다
//! 목록이 비면 **창을 부순다** — 숨은 창이 앱 종료를 막는 부류의 사고를 구조적으로 없앤다.
//!
//! ## 포커스를 절대 안 뺏는다
//! Electron은 `focusable:false`로 했다. Tauri/tao에는 대응 빌더 옵션이 없어서
//! **`WS_EX_NOACTIVATE`를 직접 얹는다**(그게 Electron이 하는 일이기도 하다). 이걸 빼면
//! `show()`가 활성화를 가져가고, 그 순간 `Focused(true)`가 와서 자기가 자기를 지우거나
//! (더 나쁘게) 사용자가 게임/에디터에서 입력을 뺏긴다.
//!
//! ## 창당 비용
//! 여기도 `super::shared_env`를 반드시 거친다. 토스트는 React가 없는 초경량 페이지라
//! 문서 몫이 작고, 브라우저·GPU·유틸 프로세스는 메인 창과 공유한다.
//!
//! ## 크래시 방어 (계약의 **예외**이고, 그 이유)
//! `crash::arm`을 걸지 **않는다**. 토스트는 있으면 좋고 없으면 그만인 오버레이라
//! 복구 정책이 "다시 세운다"가 아니라 "치운다"이다. 대신 `win::reset_shown()`이
//! 복구 시작 시 이 창을 파기 대상에 넣는다.
//!
//! `note_page_load`도 여기서 부르지 않는다. **R1은 그 이유를 "토스트 로드가 메인 창의
//! 복구 검증을 통과시킨다"고 적었는데 그 경로는 성립하지 않는다**(크리틱 M8 §5.2):
//! `wait_recovered()`는 `MOUNTED_AT != 0`이면 마운트 하트비트만 보고, 마운트는
//! `splash.js`가 쏘며 그 스크립트는 `create_main`에만 주입되므로 이 빌드의 검증은
//! **언제나 mount 기준**이다. 진짜 오염 경로는 다른 쪽이다 — `is_duplicate()`가
//! `ALIVE_AT <= last`로 "같은 사건의 중복이냐"를 가르는데(`crash.rs:383-388`), 토스트
//! 로드가 `ALIVE_AT`을 올리면 **중복 이벤트가 새 크래시로 승격돼 복구가 두 번 돈다.**
//! 결정(안 부른다)은 그대로이고 사유만 사실로 고쳐 적는다.
//!
//! ## 스레드 규약 (★3.0.6 — 「응답 없음」 덤프의 원인)
//! **토스트 창을 만들고·부수고·스타일을 바꾸는 일은 전부 메인(UI) 스레드에서 한다**
//! (`push` → `run_on_main_thread`). 채널 입구(`notify:event` 등)는 tokio 워커라
//! 여기서 바로 창을 만지면 안 된다.
//!
//! 3.0.6까지는 워커가 `PUSH_LOCK`(std Mutex)을 쥔 채 `build()` → `hwnd()` →
//! `SetWindowLongPtrW`를 불렀다. 뒤의 둘은 **메인 스레드와의 동기 왕복**이다(tauri 게터는
//! 이벤트 루프에 메시지를 보내고 답을 기다리고, 다른 스레드가 소유한 창에 부른
//! `SetWindowLongPtrW`는 소유 스레드로 `WM_STYLECHANGING`을 **동기 SendMessage**한다).
//! 그 사이 메인 스레드가 `Focused(true)`(사용자가 창을 다시 클릭) → `clear_for_window`
//! → `push` → `PUSH_LOCK.lock()`에 들어오면 서로를 기다린다 — 워커는 메인이 메시지를
//! 꺼내 주길, 메인은 워커가 락을 놓길. 실측(hang-17248 미니덤프): 메인 스레드
//! `Mutex::lock_contended`, tokio 워커 `user32!SetWindowLongPtr`(GWL_EXSTYLE,
//! 새 값 0x08040198 = NOACTIVATE|TOOLWINDOW|TOPMOST… — 바로 `no_activate`), 나머지 전부 유휴.
//!
//! 규칙: **std 락을 쥔 채로 메인 스레드와 왕복하는 호출을 하지 않는다.** 여기서는 락을
//! 없애고 메인 스레드 직렬화로 바꿨다(같은 라벨 창 둘 사고도 그대로 막힌다 — 한 스레드에서
//! 순서대로 돌기 때문). `no_activate`는 창의 소유 스레드가 아니면 스스로 메인으로 넘긴다.

use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{webview::PageLoadEvent, AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use super::{shared_env, MAIN};

pub const TOAST: &str = "toast";
/// 렌더러 계약면(protocol.ts:1144-1149)의 이름. `ipc/mod.rs`의 `ch`가 아니라 여기 두는
/// 이유는 `ipc/windows.rs` 헤더와 같다 — 이 모듈이 유일한 소비자다.
pub const NOTIFY_EVENT: &str = "notify:event";
pub const NOTIFY_OPEN: &str = "notify:open";
pub const NOTIFY_CLOSE: &str = "notify:close";
pub const NOTIFY_RESIZE: &str = "notify:resize";
pub const NOTIFY_SHOW: &str = "notify:show";
pub const NOTIFY_JUMP: &str = "notify:jump";

const TOAST_W: f64 = 360.0;
const TOAST_MARGIN: f64 = 16.0;

struct Entry {
    key: String,
    /// 이 항목의 **소유 창** 라벨. 포커스 회복·창 파기가 이 값으로 걷어 간다.
    owner: String,
    payload: Value,
}

/// 삽입 순서 = 오래된 것부터. 표시는 뒤집어서 최신이 앞(2.6.2 `entriesNewestFirst`).
static PENDING: Mutex<Vec<Entry>> = Mutex::new(Vec::new());
static LOADED: AtomicBool = AtomicBool::new(false);
/// `push_on_main` 재진입 가드 — 메인 스레드 전용이라 경합은 없고 **재진입**만 있다:
/// `ensure()`의 `build()`가 WebView2 컨트롤러를 만드는 동안 wry가 중첩 메시지 펌프를
/// 돌리고, 그 안에서 `Focused`/`Destroyed` 이벤트가 `clear_for_window` → `push`로
/// 다시 들어올 수 있다. 그때 창을 또 만들면 같은 라벨의 고아 창이 된다(★R2 실측: 한 번에
/// 10건을 던지면 `count=10 window=true loaded=true`인데 카드는 0행). 바깥 회차가 끝난 뒤
/// `DIRTY`를 보고 한 번 더 돈다.
static BUSY: AtomicBool = AtomicBool::new(false);
static DIRTY: AtomicBool = AtomicBool::new(false);

fn enabled() -> bool {
    // 설정 › 알림 토글(`notify.toast`, 기본 on). 매번 읽는다 — 캐시하면 설정 변경이
    // 다음 부팅까지 안 먹는다(2.6.2는 `ui-prefs:save`에서 갱신했지만 그 채널은
    // `ipc/stores.rs` 소유라 이번 라운드 경계 밖이다. 읽기는 마이크로초짜리다).
    ccg_store::prefs::read_ui_prefs().get("notify.toast").and_then(Value::as_bool) != Some(false)
}

fn target_key(t: &Value) -> String {
    let surface = t.get("surface").and_then(Value::as_str).unwrap_or("single");
    let id = t.get("id").and_then(Value::as_str).unwrap_or("");
    match t.get("sub").and_then(Value::as_str) {
        Some(sub) if !sub.is_empty() => format!("{surface}:{id}:{sub}"),
        _ => format!("{surface}:{id}"),
    }
}

/// 이 대상이 **실제로 사는 창**. 멀티 패널이 팝아웃돼 있으면 그 창이다 — 이벤트는
/// 상태 소유자(메인 창)가 보내지만 표시 판정·소멸·점프는 전부 팝아웃 기준이어야 한다
/// (아니면 "팝아웃을 보고 있는데 토스트가 뜨거나, 안 보이는 팝아웃의 완료가 묻힌다").
fn owner_label(target: &Value, sender: &str) -> String {
    if target.get("surface").and_then(Value::as_str) == Some("multi") {
        if let (Some(id), Some(sub)) = (
            target.get("id").and_then(Value::as_str),
            target.get("sub").and_then(Value::as_str),
        ) {
            if let Some(l) = super::popout::window_label_for(&format!("{id}::{sub}")) {
                return l;
            }
        }
    }
    sender.to_string()
}

// ── 채널 ────────────────────────────────────────────────────────────────────

/// `notify:event` — 렌더러가 전이를 알린다. 표시 여부 판정은 **여기**서 한다.
pub fn event(app: &AppHandle, sender: &tauri::WebviewWindow, p: &Value) {
    if !enabled() {
        return;
    }
    // 추가 채팅 창의 이벤트는 셸이 대상 채팅 id를 채운다 — 렌더러는 자기 id를 모른다.
    let target = match crate::engine::session_chat_for_window(sender) {
        Some(chat) => json!({ "surface": "session", "id": chat }),
        None => p.get("target").cloned().unwrap_or_else(|| json!({ "surface": "single", "id": "" })),
    };
    let owner = owner_label(&target, sender.label());
    let focused = app
        .get_webview_window(&owner)
        .and_then(|w| w.is_focused().ok())
        .unwrap_or(false);
    if focused {
        return;
    }
    let key = target_key(&target);
    let mut payload = p.clone();
    if let Some(o) = payload.as_object_mut() {
        o.insert("target".into(), target);
        o.insert("key".into(), json!(key));
    }
    {
        let mut list = PENDING.lock().unwrap_or_else(|e| e.into_inner());
        list.retain(|e| e.key != key); // 재삽입으로 끝(최신)으로 보낸다 — 승인→완료 업서트
        list.push(Entry { key, owner, payload });
    }
    push(app);
}

/// `notify:resize` — 페이지가 렌더 후 콘텐츠 높이를 보고한다. **커서가 있는 모니터**의
/// 작업 영역 우하단에 앉히고 그때 보여준다(첫 표시에 깜빡임 없음).
pub fn resize(app: &AppHandle, height: f64) {
    let Some(w) = app.get_webview_window(TOAST) else { return };
    if PENDING.lock().unwrap_or_else(|e| e.into_inner()).is_empty() {
        return;
    }
    let scale = w.scale_factor().unwrap_or(1.0);
    // 작업 영역은 물리 픽셀이다 — 논리로 환산해야 DPI 200% 모니터에서 절반으로 안 눕는다.
    let (wx, wy, ww, wh) = work_area(app, scale);
    let h = height.round().max(48.0).min(wh - TOAST_MARGIN * 2.0);
    let _ = w.set_size(tauri::LogicalSize::new(TOAST_W, h));
    let _ = w.set_position(tauri::LogicalPosition::new(
        wx + ww - TOAST_W - TOAST_MARGIN,
        wy + wh - h - TOAST_MARGIN,
    ));
    if !w.is_visible().unwrap_or(false) {
        // WS_EX_NOACTIVATE가 얹혀 있으므로 show()는 포커스를 가져가지 않는다
        // (Electron showInactive와 같은 결과 — 아래 `no_activate`).
        let _ = w.show();
    }
}

/// 커서가 있는 모니터의 작업 영역(논리 좌표). 못 찾으면 주 모니터.
/// (트레이 안내 카드도 같은 규칙으로 앉는다 — `tray::notice_resize`)
pub fn work_area(app: &AppHandle, scale: f64) -> (f64, f64, f64, f64) {
    let m = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    match m {
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
    }
}

/// `notify:open` — 항목 클릭. 그 창을 **있던 자리 그대로** 앞으로 + 포커스.
pub fn open(app: &AppHandle, key: &str) {
    let hit = {
        let list = PENDING.lock().unwrap_or_else(|e| e.into_inner());
        list.iter().find(|e| e.key == key).map(|e| (e.owner.clone(), e.payload.clone()))
    };
    let Some((owner, payload)) = hit else { return };
    // 포커스 이벤트로도 지워지지만, 라우팅이 실패해도 남지 않게 즉시 비운다.
    clear_for_window(app, &owner);
    let target = payload.get("target").cloned().unwrap_or(Value::Null);

    if target.get("surface").and_then(Value::as_str) == Some("session") {
        if let Some(id) = target.get("id").and_then(Value::as_str) {
            // 열려 있으면 포커스, 닫힌 채팅이면 창을 되만든다(win.rs `session_focus`).
            crate::win::session_focus(app, id);
            return;
        }
    }
    // 팝아웃 패널이면 그 창으로 — 메인 창의 그리드 유령을 앞세우면 "클릭했는데 엉뚱한
    // 창이 온다"가 된다(2.6.2 실사용 보고). 클릭 시점 재조회라 그 사이 닫혔으면
    // 자연히 아래 메인 창 경로로 흐른다.
    if owner != MAIN {
        if let Some(w) = app.get_webview_window(&owner) {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
            return;
        }
    }
    let Some(w) = app.get_webview_window(MAIN) else { return };
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
    let _ = app.emit_to(MAIN, NOTIFY_JUMP, target);
}

/// `notify:close` — ✕. 전부 지우고 창을 부순다.
pub fn close_all(app: &AppHandle) {
    PENDING.lock().unwrap_or_else(|e| e.into_inner()).clear();
    push(app);
}

/// 그 창이 포커스를 되찾았다(또는 죽었다) — 그 창 몫의 알림은 무의미하다.
pub fn clear_for_window(app: &AppHandle, label: &str) {
    // 토스트 자신의 포커스로 자기를 지우지 않는다(WS_EX_NOACTIVATE라 오지도 않지만,
    // 클릭이 활성화를 유발하는 구성에서도 안전하게).
    if label == TOAST {
        return;
    }
    let dropped = {
        let mut list = PENDING.lock().unwrap_or_else(|e| e.into_inner());
        let before = list.len();
        list.retain(|e| e.owner != label);
        before != list.len()
    };
    if dropped {
        push(app);
    }
}

// ── 창 ──────────────────────────────────────────────────────────────────────

fn entries_newest_first() -> Vec<Value> {
    let list = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    list.iter().rev().map(|e| e.payload.clone()).collect()
}

/// 표시 목록을 페이지로 밀어넣는다(REPLACE). 비면 창을 부순다.
///
/// **항상 메인 스레드로 넘긴다**(모듈 헤더 「스레드 규약」). tauri의 `run_on_main_thread`는
/// 메인 스레드에서 부르면 바로 실행하고(`send_user_message`가 스레드 id를 본다), 워커에서
/// 부르면 이벤트 루프에 줄을 세운다 — 어느 쪽이든 창 조작은 한 스레드에서 순서대로 돈다.
/// 그래서 "창이 있나 → 없으면 만든다"를 락으로 묶을 필요가 없다.
fn push(app: &AppHandle) {
    let a = app.clone();
    let _ = app.run_on_main_thread(move || push_on_main(&a));
}

/// 메인 스레드에서만. 재진입은 `BUSY`/`DIRTY`로 한 회차 뒤로 미룬다(그 상수 주석).
fn push_on_main(app: &AppHandle) {
    if BUSY.swap(true, Ordering::SeqCst) {
        DIRTY.store(true, Ordering::SeqCst);
        return;
    }
    loop {
        DIRTY.store(false, Ordering::SeqCst);
        if PENDING.lock().unwrap_or_else(|e| e.into_inner()).is_empty() {
            destroy(app);
        } else {
            ensure(app);
            if LOADED.load(Ordering::SeqCst) && app.get_webview_window(TOAST).is_some() {
                let _ = app.emit_to(TOAST, NOTIFY_SHOW, entries_newest_first());
            }
        }
        if !DIRTY.load(Ordering::SeqCst) {
            break;
        }
    }
    BUSY.store(false, Ordering::SeqCst);
}

fn ensure(app: &AppHandle) {
    if app.get_webview_window(TOAST).is_some() {
        return;
    }
    LOADED.store(false, Ordering::SeqCst);
    let b = shared_env(
        WebviewWindowBuilder::new(app, TOAST, WebviewUrl::App("toast.html".into())),
        TOAST,
    )
    .title("알림 — AgentCodeGUI")
    .inner_size(TOAST_W, 120.0)
    .visible(false)
    .decorations(false)
    .resizable(false)
    .minimizable(false)
    .maximizable(false)
    .skip_taskbar(true)
    .always_on_top(true)
    .focused(false)
    // 불투명 검정 카드 — 유리보다 가독성이 좋다는 사용자 결정. 페이지 배경과 같은 색을
    // 창에도 깔아 로드 직전 프레임의 흰 번쩍임을 막는다(2.6.2 `backgroundColor:'#151515'`).
    .background_color(tauri::utils::config::Color(0x15, 0x15, 0x15, 0xff))
    .on_page_load(|w, payload| {
        if payload.event() == PageLoadEvent::Finished {
            LOADED.store(true, Ordering::SeqCst);
            // 크래시 복구의 검증 신호(`note_page_load`)는 **일부러 안 부른다** — 모듈 헤더 참조.
            let app = w.app_handle().clone();
            push(&app);
            // ★ 첫 REPLACE가 구독자보다 이르다 — `ipc/windows.rs`의 `chat:status`(F12)와
            //   같은 자리다. `load` 시점에 모듈 스크립트는 이미 돌았지만 심의 `subscribe`는
            //   Tauri `listen()`(비동기 등록)이라 아주 잠깐의 공백이 있다. 실측: **단건
            //   알림 하나만 보내면 빈 카드로 굳었다**(두 번째 알림이 와야 그려짐).
            //   REPLACE라 두 번 받아도 무해하므로 짧은 지연 재송신을 붙인다.
            let a2 = app.clone();
            std::thread::spawn(move || {
                for ms in [180u64, 500, 1200] {
                    std::thread::sleep(std::time::Duration::from_millis(ms));
                    if PENDING.lock().unwrap_or_else(|e| e.into_inner()).is_empty() {
                        return;
                    }
                    let Some(w) = a2.get_webview_window(TOAST) else { return };
                    let _ = a2.emit_to(TOAST, NOTIFY_SHOW, entries_newest_first());
                    // 안전망: 창은 `notify:resize`가 와야 보여진다. 페이지가 그걸 못
                    // 보내면(스크립트 오류 등) **보이지 않는 창이 앱에 남는다** — 알림을
                    // 못 보는 것보다 나쁜 상태다. 마지막 시도에서 기본 높이로 앉힌다.
                    if ms == 1200 && !w.is_visible().unwrap_or(false) {
                        let a3 = a2.clone();
                        let _ = a2.run_on_main_thread(move || resize(&a3, 120.0));
                    }
                }
            });
        }
    });

    let win = match b.build() {
        Ok(w) => w,
        Err(e) => {
            eprintln!("[notify] 토스트 창 생성 실패: {e}");
            return;
        }
    };
    no_activate(&win);
    // 밖에서 부서져도(크래시 복구의 `destroy_all`) 로드 표식이 남지 않게.
    win.on_window_event(|e| {
        if matches!(e, WindowEvent::Destroyed) {
            LOADED.store(false, Ordering::SeqCst);
        }
    });
}

fn destroy(app: &AppHandle) {
    LOADED.store(false, Ordering::SeqCst);
    if let Some(w) = app.get_webview_window(TOAST) {
        let _ = w.destroy();
    }
}

/// 크래시 복구가 창을 전부 부술 때 — 토스트는 다시 세우지 않고 치운다(모듈 헤더).
pub fn drop_toast() {
    PENDING.lock().unwrap_or_else(|e| e.into_inner()).clear();
    LOADED.store(false, Ordering::SeqCst);
}

/// **포커스를 못 받는 창으로 만든다** — Electron `focusable:false`의 실체.
/// 실패해도 치명이 아니다(그 경우 토스트가 뜰 때 활성화를 가져간다 — 기능은 산다).
/// 트레이 안내 카드(`tray::note_first_hide`)도 같은 성질이 필요해 함께 쓴다.
///
/// **창을 소유한 스레드(메인)에서만 실제로 부른다.** 다른 스레드의 창에 `SetWindowLongPtrW`를
/// 부르면 Windows가 소유 스레드로 `WM_STYLECHANGING/CHANGED`를 **동기 SendMessage**하므로,
/// 그 스레드가 우리 락을 기다리는 순간 데드락이다(모듈 헤더 「스레드 규약」 — 3.0.6 덤프의
/// 워커 스택이 정확히 이 줄이었다). 소유 스레드가 아니면 메인으로 넘기고 돌아온다.
#[cfg(windows)]
pub fn no_activate(win: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, GetWindowThreadProcessId, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE,
        WS_EX_TOOLWINDOW,
    };
    let Ok(raw) = win.hwnd() else { return };
    let hwnd = HWND(raw.0 as *mut core::ffi::c_void);
    let owner = unsafe { GetWindowThreadProcessId(hwnd, None) };
    if owner != 0 && owner != unsafe { GetCurrentThreadId() } {
        let w = win.clone();
        let _ = win.run_on_main_thread(move || no_activate(&w));
        return;
    }
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        // TOOLWINDOW = Alt+Tab 목록에서도 빠진다(skip_taskbar와 짝).
        SetWindowLongPtrW(
            hwnd,
            GWL_EXSTYLE,
            ex | (WS_EX_NOACTIVATE.0 as isize) | (WS_EX_TOOLWINDOW.0 as isize),
        );
    }
}

#[cfg(not(windows))]
pub fn no_activate(_win: &tauri::WebviewWindow) {}

/// 진단 — 하네스가 읽는 회계(항목 수·키·소유 창·창 존재).
pub fn debug_state(app: &AppHandle) -> Value {
    let list = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    json!({
        "enabled": enabled(),
        "count": list.len(),
        "items": list.iter().map(|e| json!({ "key": e.key, "owner": e.owner })).collect::<Vec<Value>>(),
        "window": app.get_webview_window(TOAST).is_some(),
        "loaded": LOADED.load(Ordering::SeqCst),
    })
}
