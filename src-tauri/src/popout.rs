//! 멀티 패널 **팝아웃 창** — 패널 하나를 별도 OS 창으로 (`#mapanel`).
//!
//! 원본: 2.6.2 `src/main/index.ts:660-743`(createPanelWindow) + `:1295-1320`(채널 7개).
//! 렌더러(`app/src/components/PanelWindow.tsx` · `MultiAgent.tsx:1523-1620`)는 이식이
//! 끝나 있었고 **Rust 쪽만 통째로 비어 있었다** — 일곱 채널이 전부 `{__unimplemented}`로
//! 떨어져 팝아웃 버튼을 눌러도 창이 안 뜬다(A/B `panel-window`가 도달 실패였던 이유).
//!
//! ## 2.6.2와 무엇이 같고 무엇이 다른가 — **소유권**
//!
//! 2.6.2의 팝아웃은 **사본 이전**이었다. 엔진은 `maEngines`가 `panelId`로 들고 있고
//! (`index.ts:358-367`), 창은 그 `panelId`의 `maEvent`를 함께 받는 미러 뷰다. 초안·큐·
//! 메타는 창으로 **옮겨 가고**(그리드는 유령이 된다) 닫힐 때 마지막 페르시스트가 되돌아온다.
//!
//! 3.0은 다르다. `panelId`는 **보드의 자리 번호**일 뿐이고, 실행은 `panel_id_to_chat()`
//! (`engine/mod.rs:206`)이 보드에서 읽어 낸 **chatId가 소유한다**. 즉 팝아웃 창이
//! `ma:run`을 보내도 그리드가 보내던 것과 **같은 `ChatRuntime`**에 붙는다 —
//! 엔진 재스폰도, resume id 재발급도 없다(ux-chat-unify §1.2 불변식 3·§3).
//! 그래서 이 모듈이 나르는 것은 **렌더러 로컬 상태뿐**이다: 초안·이미지·예약 큐·
//! 패널 메타·스레드 스냅샷(`PanelPopState`). "창은 자리, 대화는 채팅"의 그 자리.
//!
//! 이벤트 미러 팬아웃도 **공짜**다: `engine/hub.rs:401`이 `app.emit(MA_EVENT, …)`
//! (= 전 창 브로드캐스트)로 쏘므로 그리드와 팝아웃이 같은 이벤트를 각자 리듀스한다.
//! 2.6.2가 `sendMaEvent`에서 손으로 두 번 보내던 자리(`index.ts:368-374`)가 3.0에는
//! 아예 없다 — 그래서 이 라운드는 `engine/`을 한 줄도 만지지 않는다.
//!
//! ## 창당 비용
//! 창을 만드는 유일한 경로는 `super::shared_env`다(win.rs 헤더의 규약). 빠뜨리면
//! WebView2 환경이 통째로 복제돼 창 하나가 브라우저+GPU+유틸 프로세스를 데려온다.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Mutex;
use tauri::{webview::PageLoadEvent, AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use super::{chrome_mode, shared_env, MAIN};

/// 팝아웃 창 라벨 접두사. `session-`(추가 채팅)과 갈라 둔다 —
/// `session_chat_for_window`가 라벨로 추가 채팅을 찾으므로 이름이 겹치면 안 된다.
const PREFIX: &str = "panel-";
static SEQ: AtomicI64 = AtomicI64::new(0);

struct Rec {
    label: String,
    panel_id: String,
}

static PANELS: Mutex<Vec<Rec>> = Mutex::new(Vec::new());
/// 라벨 → 창을 열 때 받은 부트 페이로드(마운트 복원 1회분).
static BOOTS: Mutex<Option<HashMap<String, Value>>> = Mutex::new(None);
/// panelId → 그 창의 **마지막 페르시스트**. 닫힐 때 그리드로 돌아가는 값이다.
static FLUSHES: Mutex<Option<HashMap<String, Value>>> = Mutex::new(None);
/// panelId → 아직 아무도 회수하지 않은 복귀분. 그 세션 화면이 내려가 있는 동안 창이
/// 닫히면 `ma:panel-closed`를 받을 이가 없어 진행이 증발한다 — 사본을 남겨 두고
/// 다음 마운트의 `ma:panel-states`가 소비한다(2.6.2 `panelLeftovers`와 같은 규약).
static LEFTOVERS: Mutex<Option<HashMap<String, Value>>> = Mutex::new(None);
/// 크래시 재생성 대기분 — 창을 전부 부수기 직전에 담아 둔 부트 페이로드들.
static PENDING_RECREATE: Mutex<Vec<Value>> = Mutex::new(Vec::new());
/// **닫기 전 마지막 저장 유예를 이미 준 창**(라벨). `CloseRequested`를 한 번만 가로챈다 —
/// 안 그러면 유예 뒤 재시도한 `close()`가 또 가로채여 창이 영영 안 닫힌다.
static CLOSING: Mutex<Option<HashSet<String>>> = Mutex::new(None);
/// 지금까지 나간 "닫기 전 마지막 저장" 요청 수 — 하네스가 규약이 실제로 도는지 읽는다.
static FLUSH_REQS: AtomicI64 = AtomicI64::new(0);

/// 팝아웃 패널 창의 **제목 표시줄** 문구. 2.6.2 `src/main/index.ts:695`에서 글자 그대로.
///
/// ★HOSTI18N R1 — `win.rs`의 둘째 채팅 창 제목과 **같은 부류**다(확인 크리틱 R1 §4.2-3이
/// "`popout.rs:140`도 같다"고 짚었다). 같은 라운드에서 같은 처방으로 닫는다.
pub(crate) fn panel_window_title() -> String {
    ccg_fs::t("패널 — AgentCodeGUI", "Panel — AgentCodeGUI")
}

fn with_map<T>(m: &Mutex<Option<HashMap<String, Value>>>, f: impl FnOnce(&mut HashMap<String, Value>) -> T) -> T {
    let mut g = m.lock().unwrap_or_else(|e| e.into_inner());
    f(g.get_or_insert_with(HashMap::new))
}

fn panel_id_of(state: &Value) -> Option<String> {
    state
        .get("panelId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// 이 창이 보고 있는 패널(`ma:panel-hydrate`/`persist`가 주소로 쓴다).
pub fn panel_for_label(label: &str) -> Option<String> {
    PANELS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .find(|r| r.label == label)
        .map(|r| r.panel_id.clone())
}

fn label_for_panel(panel: &str) -> Option<String> {
    PANELS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .find(|r| r.panel_id == panel)
        .map(|r| r.label.clone())
}

/// 이 패널이 별도 창으로 나가 있나 — 토스트의 소유 창 판정(`notify.rs`)이 쓴다.
pub fn window_label_for(panel: &str) -> Option<String> {
    label_for_panel(panel)
}

// ── 열기 ────────────────────────────────────────────────────────────────────

/// `ma:panel-open` — 이 패널을 별도 OS 창으로. 이미 있으면 **앞으로 가져오기만** 한다
/// (부트 페이로드는 처음 것을 지킨다 — 그 창이 이미 라이브 상태를 쥐고 있다).
pub fn open(app: &AppHandle, state: &Value) -> Result<String, String> {
    let Some(panel_id) = panel_id_of(state) else {
        return Err("panelId 없음".into());
    };
    if let Some(label) = label_for_panel(&panel_id) {
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
            return Ok(label);
        }
        // 레코드는 있는데 창이 없다 = 파기 이벤트를 놓쳤다. 레코드를 걷고 새로 만든다.
        forget(&label);
    }

    let n = SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    let label = format!("{PREFIX}{n}");

    // 메인 창에서 살짝 어긋나게(계단식) — 겹쳐서 안 보이는 사고 방지(추가 채팅 창과 같은 규칙)
    let (mx, my) = app
        .get_webview_window(MAIN)
        .and_then(|w| w.outer_position().ok().zip(w.scale_factor().ok()))
        .map(|(p, s)| {
            let l = p.to_logical::<f64>(s);
            (l.x, l.y)
        })
        .unwrap_or((100.0, 100.0));
    let off = ((n - 1) % 6) as f64 * 26.0;

    let b = shared_env(
        WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html#mapanel".into())),
        &label,
    )
    .title(panel_window_title())
    .initialization_script(&super::boot_payload_script())
    .inner_size(1100.0, 820.0)
    .min_inner_size(560.0, 480.0)
    .position(mx + 60.0 + off, my + 60.0 + off)
    // 메인 창·추가 채팅 창과 같은 껍데기(b안): 프레임리스 + 그림자 + 투명 + 아크릴.
    .decorations(false)
    .shadow(true)
    .transparent(chrome_mode() != 'c')
    .visible(false)
    .on_page_load(|w, payload| {
        if payload.event() == PageLoadEvent::Finished {
            crate::crash::note_page_load(w.label());
            // 부팅 3연발은 프로세스당 1회라 나중에 태어난 창엔 오지 않는다 —
            // 추가 채팅 창과 같은 구멍이고 같은 방법으로 막는다(win.rs `open_session_window_for`).
            super::glass::note_document(w.label());
            let _ = w.show();
            let _ = w.set_focus();
        }
    });

    let b = if chrome_mode() != 'c' {
        use tauri::utils::config::WindowEffectsConfig;
        use tauri::window::Effect;
        b.effects(WindowEffectsConfig {
            effects: vec![Effect::Acrylic],
            state: None,
            radius: None,
            color: None,
        })
        .initialization_script(&super::glass::boot_script())
    } else {
        b
    };

    let win = b.build().map_err(|e| e.to_string())?;
    crate::win::apply_resource_icon(&win);

    // 계약: 모든 앱 크롬 창은 shared_env + 크래시 방어 + 유리 유지.
    crate::crash::arm(app, &win);
    if chrome_mode() != 'c' {
        super::glass::arm(app, &win);
    }

    PANELS.lock().unwrap_or_else(|e| e.into_inner()).push(Rec {
        label: label.clone(),
        panel_id: panel_id.clone(),
    });
    with_map(&BOOTS, |m| m.insert(label.clone(), state.clone()));
    // 첫 페르시스트 전에 닫혀도 초안·메타가 증발하지 않게, 부트 상태를 곧 복귀분으로 둔다.
    with_map(&FLUSHES, |m| m.insert(panel_id.clone(), state.clone()));

    let handle = app.clone();
    let l = label.clone();
    let pid = panel_id.clone();
    win.on_window_event(move |e| match e {
        WindowEvent::Resized(_) => {
            if let Some(w) = handle.get_webview_window(&l) {
                if let Ok(m) = w.is_maximized() {
                    let _ = handle.emit_to(l.as_str(), crate::ipc::ch::WIN_STATE, json!({ "maximized": m }));
                }
            }
        }
        // 이 창이 포커스를 되찾으면 그 창 몫의 알림은 무의미하다 — 토스트 자동 소멸.
        WindowEvent::Focused(true) => super::notify::clear_for_window(&handle, &l),
        // ★R2 — **닫기 전 마지막 저장 요청**(`chat:flush-req`와 같은 규약, ipc/windows.rs:22).
        WindowEvent::CloseRequested { api, .. } => {
            if flush_before_close(&handle, &l) {
                api.prevent_close();
            }
        }
        WindowEvent::Destroyed => on_destroyed(&handle, &l, &pid),
        _ => {}
    });
    Ok(label)
}

/// 닫기 유예 시간 — 렌더러가 마지막 상태를 `ma:panel-persist`로 올려 보낼 창.
/// 추가 채팅 창의 `chat:flush-req`와 같은 규약이고, 값은 그쪽 왕복 실측과 같은 자릿수다.
const FLUSH_GRACE_MS: u64 = 140;

/// **닫기 전에 한 번, 마지막 저장을 청한다.** `true`면 지금은 닫지 말라는 뜻이다.
///
/// ## 왜 필요한가
/// 창의 페르시스트는 600ms 디바운스다(`PanelWindow.tsx:140`). 그 안에 창이 닫히면
/// 마지막 초안·메타·스레드가 복귀분에 없다. 그리드가 라이브 구독으로 스레드는
/// 지키지만(`applyPanelFlush`의 길이 가드), **초안·이미지·예약 큐는 창이 유일한
/// 소유자**라 그대로 증발한다 — "창에 타이핑하다 닫으면 사라지는 글자"다.
///
/// ## 왜 이 모양인가
/// `ipc/windows.rs:22`의 `chat:flush-req`(★R4)가 추가 채팅 창에 이미 세워 둔 규약이다.
/// 팝아웃에는 그게 안 걸려 있었다(크리틱 M8 §3.1 후단). 대칭을 맞추되 **새 실패 모드를
/// 만들지 않는다**: 유예는 라벨당 한 번뿐이고(`CLOSING`), 응답을 기다리지 않으며
/// (`FLUSH_GRACE_MS` 고정 타이머), 그 뒤에는 `destroy()`로 **무조건** 닫는다.
/// 창이 응답을 못 해도 닫히지 않는 경로는 없다.
///
/// 렌더러 쪽 수신자는 이미 있다 — `PanelWindow.tsx:146-150`이 `beforeunload`에
/// 같은 페르시스트를 걸어 두었으므로, 여기서 그 이벤트를 **직접 쏴 주면** 그 핸들러가
/// 돈다. 새 채널·새 렌더러 코드가 필요 없다(이번 라운드는 `app/` 경계 밖이다).
fn flush_before_close(app: &AppHandle, label: &str) -> bool {
    // 종료·크래시 복구 중에는 가로채지 않는다 — 앱이 못 죽는 실패 모드가 그쪽이 더 나쁘다.
    if crate::crash::is_recovering() || super::tray::is_quitting() {
        return false;
    }
    let first = {
        let mut g = CLOSING.lock().unwrap_or_else(|e| e.into_inner());
        g.get_or_insert_with(HashSet::new).insert(label.to_string())
    };
    if !first {
        return false; // 이미 유예를 줬다 — 이번엔 진짜 닫는다
    }
    if let Some(w) = app.get_webview_window(label) {
        FLUSH_REQS.fetch_add(1, Ordering::Relaxed);
        // 계약면의 같은 사실을 채널로도 알린다(로그·미래의 렌더러 수신자용).
        let _ = app.emit_to(label, crate::ipc::windows::CHAT_FLUSH_REQ, json!({ "panelId": panel_for_label(label) }));
        // 그리고 **지금 있는 수신자**를 실제로 깨운다: PanelWindow의 beforeunload 플러시.
        let _ = w.eval("window.dispatchEvent(new Event('beforeunload'))");
    }
    let a = app.clone();
    let l = label.to_string();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(FLUSH_GRACE_MS));
        let a2 = a.clone();
        let l2 = l.clone();
        let _ = a.run_on_main_thread(move || {
            match a2.get_webview_window(&l2) {
                Some(w) => {
                    let _ = w.destroy();
                }
                // 그 사이 사라졌다 — `Destroyed`가 이미 정리했다.
                None => forget_closing(&l2),
            }
        });
    });
    true
}

fn forget_closing(label: &str) {
    if let Some(s) = CLOSING.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
        s.remove(label);
    }
}

/// 창이 죽었다 — 레지스트리 정리 + **그리드 복귀 통지**(fold-back).
fn on_destroyed(app: &AppHandle, label: &str, panel_id: &str) {
    forget(label);
    forget_closing(label);
    super::notify::clear_for_window(app, label);
    let flush = with_map(&FLUSHES, |m| m.remove(panel_id));

    // 종료 중·크래시 복구 중에는 통지하지 않는다 — 메인 창도 함께 내려간다(2.6.2 appQuitting).
    // 복구 경로는 `snapshot_for_recreate()`가 이미 부트 페이로드를 떠 갔으므로 값도 안 잃는다.
    if crate::crash::is_recovering() {
        return;
    }
    if let Some(f) = flush.clone() {
        with_map(&LEFTOVERS, |m| m.insert(panel_id.to_string(), f));
    }
    let _ = app.emit_to(
        MAIN,
        "ma:panel-closed",
        json!({ "panelId": panel_id, "flush": flush }),
    );
}

fn forget(label: &str) {
    PANELS.lock().unwrap_or_else(|e| e.into_inner()).retain(|r| r.label != label);
    with_map(&BOOTS, |m| m.remove(label));
}

// ── 채널 구현 ───────────────────────────────────────────────────────────────

/// `ma:panel-hydrate` — 이 창의 부트 페이로드. **마지막 페르시스트가 있으면 그쪽**이다:
/// 크래시 복구의 `reload_all()`은 창을 부수지 않고 문서만 다시 세우므로, 부트만 돌려주면
/// 재로드 직전까지의 초안·스레드가 통째로 한 세대 낡는다(2.6.2에는 이 경로가 아예 없었다).
pub fn hydrate(label: &str) -> Value {
    let Some(panel) = panel_for_label(label) else { return Value::Null };
    with_map(&FLUSHES, |m| m.get(&panel).cloned())
        .or_else(|| with_map(&BOOTS, |m| m.get(label).cloned()))
        .unwrap_or(Value::Null)
}

/// `ma:panel-persist` — 이 창의 상태를 복귀분으로 저장(600ms 디바운스는 렌더러 몫).
pub fn persist(label: &str, state: &Value) -> bool {
    // 주소는 **부른 창**이다. 페이로드의 panelId를 믿으면 창 하나가 남의 패널을 덮는다.
    let Some(panel) = panel_for_label(label) else { return false };
    with_map(&FLUSHES, |m| m.insert(panel, state.clone()));
    true
}

/// `ma:panel-focus` — 열린 팝아웃 창을 앞으로(그리드 유령 클릭).
pub fn focus(app: &AppHandle, panel: &str) {
    if let Some(w) = label_for_panel(panel).and_then(|l| app.get_webview_window(&l)) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// `ma:panel-close` — 창을 닫는다. 복귀 통지·정리는 `Destroyed`가 담당한다.
pub fn close(app: &AppHandle, panel: &str) {
    if let Some(w) = label_for_panel(panel).and_then(|l| app.get_webview_window(&l)) {
        let _ = w.close();
    }
}

/// `ma:panel-states` — 이 세션(보드)의 **열린 창 + 미회수 복귀분**. 조회가 곧 소비다
/// (두 번 적용되면 초안·스레드가 겹쳐 들어간다).
pub fn states(session: &str) -> Value {
    let prefix = format!("{session}::");
    let open: Vec<String> = PANELS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .filter(|r| r.panel_id.starts_with(&prefix))
        .map(|r| r.panel_id.clone())
        .collect();
    let leftovers = with_map(&LEFTOVERS, |m| {
        let keys: Vec<String> = m.keys().filter(|k| k.starts_with(&prefix)).cloned().collect();
        keys.iter().filter_map(|k| m.remove(k)).collect::<Vec<Value>>()
    });
    json!({ "open": open, "leftovers": leftovers })
}

/// `ma:panel-leftover-clear` — 라이브로 회수했다(중복 적용 차단).
pub fn clear_leftover(panel: &str) {
    with_map(&LEFTOVERS, |m| m.remove(panel));
}

// ── 크래시 복구 (crash.rs `recreate_windows`가 부른다) ──────────────────────

/// 창을 전부 부수기 **직전**에 부른다 — 지금 떠 있는 팝아웃들의 최신 상태를 떠 둔다.
pub fn snapshot_for_recreate() -> usize {
    let labels: Vec<(String, String)> = PANELS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .map(|r| (r.label.clone(), r.panel_id.clone()))
        .collect();
    let mut out = Vec::new();
    for (label, panel) in labels {
        if let Some(v) = with_map(&FLUSHES, |m| m.get(&panel).cloned())
            .or_else(|| with_map(&BOOTS, |m| m.get(&label).cloned()))
        {
            out.push(v);
        }
    }
    let n = out.len();
    *PENDING_RECREATE.lock().unwrap_or_else(|e| e.into_inner()) = out;
    n
}

/// 재생성 — 떠 둔 상태로 팝아웃 창을 다시 만든다(그리드의 유령도 그대로 유지된다).
pub fn recreate_pending(app: &AppHandle) -> usize {
    let pending = std::mem::take(&mut *PENDING_RECREATE.lock().unwrap_or_else(|e| e.into_inner()));
    let mut n = 0;
    for state in pending {
        if open(app, &state).is_ok() {
            n += 1;
        }
    }
    n
}

/// 창이 전부 부서졌다 — 레지스트리를 비운다(죽은 라벨이 남으면 `focus`가 허공을 짚는다).
/// 복귀분(FLUSHES/LEFTOVERS)은 **지우지 않는다** — 그게 재생성의 재료다.
pub fn clear_windows() {
    PANELS.lock().unwrap_or_else(|e| e.into_inner()).clear();
    with_map(&BOOTS, |m| m.clear());
}

/// 진단 — 하네스(`scripts/poc-winsurface.mjs`)가 읽는 회계.
pub fn debug_state() -> Value {
    let panels: Vec<Value> = PANELS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .map(|r| json!({ "label": r.label, "panelId": r.panel_id }))
        .collect();
    // 복귀분의 **스레드 길이**까지 싣는다 — "닫으면 그리드가 되받는 값"이 지금 몇 항목인지가
    // 하네스의 판정 재료다(첫 페르시스트 전에 닫으면 부트 상태가 복귀분이라는 규약의 관측면).
    let flushes = with_map(&FLUSHES, |m| {
        m.iter()
            .map(|(k, v)| {
                let n = v
                    .get("snapshot")
                    .and_then(|s| s.get("messages"))
                    .and_then(Value::as_array)
                    .map(|a| a.len())
                    .unwrap_or(0);
                json!({ "panelId": k, "messages": n })
            })
            .collect::<Vec<Value>>()
    });
    json!({
        "windows": panels,
        "flushes": flushes,
        "leftovers": with_map(&LEFTOVERS, |m| m.keys().cloned().collect::<Vec<String>>()),
        // ★R2 — 닫기 전 마지막 저장 요청이 실제로 나갔는가(`flush_before_close`).
        "flushReqs": FLUSH_REQS.load(Ordering::Relaxed),
    })
}
