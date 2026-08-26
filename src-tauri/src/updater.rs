//! 앱 자동 업데이트 — 2.6.2 `src/main/updater.ts`의 3.0 자리 (★R28j `N8`).
//!
//! ── 무엇이 없었나 ───────────────────────────────────────────────────────────
//! 최종 파리티 감사 R5 §9.0이 자기 exe로 재 둔 상태: 원시 `app:update-check` ·
//! `app:update-install` · `app:update-event` 셋 다 `{"__unimplemented":true}`(9/9),
//! 셸에 방출자·업데이터·`plugins` 설정이 **전부 0**. 화면(`AppUpdateGate.tsx`)은
//! 그대로 실려 **항상 마운트되지만**(`App.tsx:2670`) 값을 넣어 줄 통로가 없어 어떤
//! 경로로도 카드가 뜰 수 없었다 — 감사가 시드를 심으니 카드는 정상적으로 떴다
//! (ready 3/3 · downloading 3/3 대 bare 0/3). **화면은 멀쩡하고 배선만 없었다.**
//! 사용자 문장으로: 출하된 3.0 사용자는 앱 안에서 새 버전을 알 수도 받을 수도 없다.
//!
//! ── 그래서 이 파일이 하는 일 ────────────────────────────────────────────────
//! 화면이 이미 기대하는 모양(`UpdateStatus`)을 **셸이 채운다**. 2.6.2가 electron-updater의
//! 이벤트 6종을 상태 하나로 접었듯, 여기서는 `tauri-plugin-updater`의 조회/다운로드/설치
//! 세 단계를 같은 상태 하나로 접는다. `phase` 일곱 값과 `log`/`percent`/`error`의 의미는
//! **2.6.2와 글자 그대로 같다** — 그래야 이식된 카드가 한 글자도 안 바뀌고 산다.
//!
//! | 2.6.2 electron-updater 이벤트 | 3.0 이 파일의 자리 |
//! |---|---|
//! | `checking-for-update` | [`run_check`] 진입 — `phase:"checking"` · 로그 초기화 |
//! | `update-available` | `check().await == Ok(Some(_))` — `phase:"available"` + 버전 |
//! | `update-not-available` | `check().await == Ok(None)` — `phase:"none"` |
//! | `download-progress` | [`Update::download`]의 `on_chunk` — `phase:"downloading"` + % |
//! | `update-downloaded` | 다운로드 반환(=서명 검증 통과) — `phase:"downloaded"` |
//! | `error` | 위 어느 단계의 `Err` — `phase:"error"` + 사유 |
//!
//! ── 왜 공식 플러그인인가 ────────────────────────────────────────────────────
//! `src-tauri/Cargo.toml`의 dep 주석에 근거를 적어 뒀다. 요지: 이 축에서 손으로 다시 쓰면
//! **틀렸을 때 조용한 쪽**이 보안(minisign 서명 검증)이고 그 다음이 NSIS 기동 규약이다.
//! 우리가 드는 것은 상태기계뿐 — 그것이 2.6.2에서도 우리 몫이었다.
//!
//! ── ★같이 피한 함정: 「종료 시 자동 설치」 ──────────────────────────────────
//! 2.6.2 `updater.ts:59-65`가 주석으로 남긴 실제 사고다 — 종료 시 자동 설치는 화면 없이
//! NSIS가 "이전 버전 삭제 → 새 파일 복사"를 도는데, 그 사이에 PC가 꺼지면 **앱이 통째로
//! 사라진다**. 3.0에서 이 함정은 **구조적으로 없다**: `tauri-plugin-updater`에는
//! `autoInstallOnAppQuit`에 해당하는 것이 아예 없고, 설치는 [`install`]을 **누군가 부를
//! 때만** 일어난다. 그리고 이 파일은 그것을 `app:update-install`(=카드의 「업데이트」
//! 버튼) 한 곳에서만 부른다 — 종료 경로(`main.rs`의 `RunEvent::ExitRequested`)는
//! 이 모듈을 아예 모른다. 그 성질을 못으로도 박아 둔다(`install_is_never_wired_to_exit`).
//!
//! ── 2.6.2와 알면서 다른 것 두 가지 ─────────────────────────────────────────
//! ① **받아둔 설치본을 다음 실행으로 넘기지 않는다.** electron-updater는 pending 캐시에
//!    파일을 남겨 재사용했다. 여기서는 검증이 끝난 바이트를 **이 세션의 메모리에만** 든다.
//!    디스크에 남기면 다음 실행에서 그것을 **다시 검증할 길**을 우리가 새로 만들어야 하고
//!    (플러그인의 `verify_signature`는 비공개다 · 검증은 `download()` 안에서만 일어난다),
//!    검증 없이 재사용하는 순간 「받아둔 파일을 바꿔치기하면 임의 코드가 설치된다」가 된다.
//!    대가는 앱을 껐다 켜면 다시 받는 것뿐이다(설치본 한 장 · 수 MB).
//! ② **설치 진행 화면이 NSIS 자신의 것**이다. 2.6.2는 `/S`(무음)로 돌리고 그 빈 화면을
//!    PowerShell+WPF 스플래시로 메꿨다(`updater.ts:159-226` — detached 함정 · cmd 8191자
//!    한계까지 안고 있는 자리다). 플러그인 기본은 `passive`(`/P /R`)라 **NSIS가 자기
//!    진행 막대를 그리고 끝나면 앱을 다시 띄운다** — 화면이 비는 구간이 없으니 그 스플래시가
//!    필요 없고, 그 두 함정도 통째로 사라진다. 설치기 헤더/사이드바 이미지는 우리 것이다.

use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Update, UpdaterExt};

/// 주기 재확인 간격. 2.6.2 `RECHECK_MS`와 같은 값·같은 근거(그 파일 `:19-22`):
/// 켜둔 채로 며칠 쓰는 사용 패턴에서 그 사이 올라온 릴리즈도 알아채되, 확인 한 번이
/// 매니페스트 GET 하나뿐이라 30분이면 충분히 빠르고 배터리를 깨울 이유도 없다.
const RECHECK: Duration = Duration::from_secs(30 * 60);

/// 첫 조회를 이만큼 늦춘다. 2.6.2는 `app.whenReady` 직후 곧바로 걸었지만, 3.0의 부팅
/// 임계 경로는 밀리초 단위로 재고 있다(`ipc::boot_prewarm` 헤더의 ready 180ms 실측).
/// 새 버전 안내가 5초 늦어서 잃는 것은 없고, TLS 핸드셰이크·DNS가 창 만드는 구간과
/// 겹치지 않아 얻는 것은 있다.
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(5);

/// 업데이트 매니페스트 주소 **덮어쓰기**(선택). 비어 있으면 `tauri.conf.json`의
/// `plugins.updater.endpoints`가 쓰인다.
///
/// 있는 이유는 하나다 — **이 축을 실측할 수 있어야 한다**. 진짜 GitHub 릴리스를 만들지
/// 않고 로컬 정적 피드로 「조회 → 진행률 → 카드 → 설치」를 화면에서 확인하는 통로다
/// (스테이징 피드로 리허설할 때도 같은 문). 릴리즈 빌드에서 `https://`가 아닌 값을 주면
/// 플러그인 자신이 거절하고(`Error::InsecureTransportProtocol`) 그 사유가 그대로
/// `phase:"error"`로 화면에 올라온다 — 조용히 무시되지 않는다.
pub const FEED_ENV: &str = "CCG_UPDATE_FEED";

// ── 상태 ────────────────────────────────────────────────────────────────────

/// 계약면 `UpdateStatus`의 `phase`. 문자열은 `src/shared/protocol.ts:1074`가 원본이고
/// 화면(`AppUpdateGate.tsx:47`)이 이 중 넷에서만 카드를 띄운다.
mod phase {
    pub const IDLE: &str = "idle";
    pub const CHECKING: &str = "checking";
    pub const AVAILABLE: &str = "available";
    pub const DOWNLOADING: &str = "downloading";
    pub const DOWNLOADED: &str = "downloaded";
    pub const NONE: &str = "none";
    pub const ERROR: &str = "error";
}

struct St {
    phase: &'static str,
    version: Option<String>,
    percent: i64,
    log: Vec<String>,
    error: Option<String>,
    /// 받아둔(downloaded) 상태의 **조용한 재확인** 표식 — 2.6.2 `updater.ts:29`의 `probing`.
    /// 받아둔 뒤에 더 새 릴리즈가 올라왔는지만 본다. 같은 버전이 다시 잡히는 동안엔 상태를
    /// 일절 건드리지 않아('나중에'로 접은 카드는 phase가 downloaded로 **다시 구르는**
    /// 순간 되뜨므로 — `AppUpdateGate.tsx:36`), 침묵이 곧 카드 보호다.
    probing: bool,
    /// 5%마다 한 줄만 남기려는 눈금(`-1` = 이번 사이클에 아직 안 남겼다).
    last_step: i64,
    /// 조회/다운로드가 도는 중 — 방아쇠가 겹쳐 두 벌이 돌지 않게.
    busy: bool,
    /// 검증이 끝난 설치본 + 그것을 설치할 핸들. **이 세션에만** 산다(헤더 ①).
    pending: Option<(Box<Update>, Vec<u8>)>,
}

impl St {
    const fn new() -> Self {
        Self {
            phase: phase::IDLE,
            version: None,
            percent: 0,
            log: Vec::new(),
            error: None,
            probing: false,
            last_step: -1,
            busy: false,
            pending: None,
        }
    }

    /// 렌더러가 보는 모양 — 계약면 `UpdateStatus` 그대로(추가 필드 없음).
    fn snapshot(&self) -> Value {
        json!({
            "phase": self.phase,
            "version": self.version.clone().map(Value::String).unwrap_or(Value::Null),
            "percent": self.percent,
            "log": self.log,
            "error": self.error.clone().map(Value::String).unwrap_or(Value::Null),
        })
    }
}

static STATE: Mutex<St> = Mutex::new(St::new());

fn lock() -> std::sync::MutexGuard<'static, St> {
    STATE.lock().unwrap_or_else(|e| e.into_inner())
}

/// 상태를 고치고 **스냅샷을 방출한다**. 잠금은 방출 **전에** 놓는다 — 이벤트 팬아웃 도중
/// 다시 이 함수로 들어오는 길은 지금 없지만, 락을 든 채 남의 코드를 부르지 않는 것이 규약이다.
fn set(app: &AppHandle, f: impl FnOnce(&mut St)) {
    let snap = {
        let mut g = lock();
        f(&mut g);
        g.snapshot()
    };
    emit(app, snap);
}

/// 2.6.2 `send(IPC.updateEvent, e)`와 **같은 청중**: 메인 창 하나다
/// (`src/main/index.ts:281` `send`는 `mainWindow.webContents.send`). 카드를 그리는
/// `AppUpdateGate`는 `App.tsx`에만 있고 추가 채팅·팝아웃 창에는 없다.
fn emit(app: &AppHandle, snap: Value) {
    let _ = app.emit_to(crate::win::MAIN, crate::ipc::ch::UPDATE_EVENT, snap);
}

/// UI 언어가 영어인가. 원본은 ui-prefs의 `"ui.lang"` 한 키다 — 렌더러
/// (`app/src/lib/i18n.ts`)·트레이(`tray.rs` `en_ui`)와 **같은 키**를 읽는다.
/// (Rust 쪽에 i18n 런타임이 없어 문구는 두 벌 중 하나를 표시 시점에 고른다.)
fn en_ui() -> bool {
    ccg_store::prefs::read_ui_prefs().get("ui.lang").and_then(Value::as_str) == Some("en")
}

fn t(ko: &str, en: &str) -> String {
    if en_ui() { en.to_string() } else { ko.to_string() }
}

fn mb(bytes: u64) -> String {
    format!("{:.1}", bytes as f64 / 1_048_576.0)
}

// ── 순수 판정(못을 박을 수 있게 자유 함수로) ────────────────────────────────

/// 「조용한 재확인 중에 잡힌 이 버전이 **정말 더 새 것**인가」.
///
/// 2.6.2 `updater.ts:81`의 `compareVersionsDesc(info.version, state.version) >= 0`을
/// 뒤집은 것이다. 판정 알고리즘 자체는 새로 쓰지 않고 `ccg_engine::versions::cmp_desc`
/// (=2.6.2 `compareVersionsDesc`의 이식본)를 **그대로 쓴다** — 같은 질문에 두 코드가
/// 답하면 한쪽만 고쳐지는 순간 조용히 갈린다.
fn is_newer(found: &str, have: &str) -> bool {
    ccg_engine::versions::cmp_desc(found, have) == std::cmp::Ordering::Less
}

/// 진행률 → 「로그 한 줄을 남길 눈금」. 5%마다 한 줄이라 로그가 홍수가 되지 않는다
/// (2.6.2 `updater.ts:102`와 같은 잣대).
fn log_step(percent: i64) -> i64 {
    percent / 5
}

/// 바이트 → 0~100 정수 퍼센트. 총 길이를 모르면(`Content-Length` 없음) 0을 유지한다 —
/// 카드의 게이지가 아무 근거 없이 뛰는 것보다 낫다.
fn pct(done: u64, total: Option<u64>) -> i64 {
    match total {
        Some(t) if t > 0 => ((done as f64 / t as f64) * 100.0).round().clamp(0.0, 100.0) as i64,
        _ => 0,
    }
}

// ── 공개 문 세 개 (+ 부팅 배선) ─────────────────────────────────────────────

/// `app:update-status` — 마운트 때 카드가 읽는 시드. **구독 전에 지나간 이벤트를 놓치지
/// 않게** 상태의 원본은 셸이 든다(계약면 규약 · `renderer-divergence.md` §3.3).
pub fn status() -> Value {
    lock().snapshot()
}

/// 개발 실행에서는 업데이터가 **통째로 없다** — 2.6.2의 `app.isPackaged` 게이트와 같은
/// 성질이다(`updater.ts:57`·`:146`·`:230` 세 함수가 모두 일찍 반환한다).
///
/// 3.0에서 그 술어는 `tauri::is_dev()`이고, 그 정의가 정확히 이 레포의 규약이다 —
/// `tauri-2.11.5/src/lib.rs:308` `pub const fn is_dev() -> bool { !cfg!(feature = "custom-protocol") }`.
/// `custom-protocol`은 이 레포가 「프로덕션 빌드 표식」으로 쓰는 바로 그 피처다
/// (`src-tauri/Cargo.toml`의 `[features]` 주석). 그러니 `npm run tauri:dev`에서는
/// 조회도 방출도 없고 **가짜 오류 카드가 뜰 수 없다**.
fn disabled() -> bool {
    tauri::is_dev()
}

/// 부팅 배선 — `main.rs`의 `setup`에서 한 줄. 창이 선 뒤에 부른다(첫 방출이 갈 곳이 있게).
pub fn init(app: &AppHandle) {
    if disabled() {
        return;
    }
    let a = app.clone();
    let _ = std::thread::Builder::new().name("ccg-updater".into()).spawn(move || {
        std::thread::sleep(FIRST_CHECK_DELAY);
        check(&a);
        // 주기 재확인. 2.6.2 `updater.ts:135-141`과 같은 규칙 —
        // 확인 중/내려받는 중에만 쉬고, **받아둔 상태는 조용한 재확인으로 계속 본다**:
        // 같은 버전이면 상태를 일절 건드리지 않아 '나중에'로 접은 카드가 되뜨지 않고,
        // 그 사이 더 새 패치본이 올라왔으면 일반 흐름으로 복귀해 최신을 다시 받는다
        // (업데이트 버튼이 낡은 버전을 설치하는 일이 없게).
        loop {
            std::thread::sleep(RECHECK);
            {
                let mut g = lock();
                if g.busy || g.phase == phase::CHECKING || g.phase == phase::DOWNLOADING {
                    continue;
                }
                g.probing = g.phase == phase::DOWNLOADED;
            }
            check(&a);
        }
    });
}

/// `app:update-check` — 조회를 건다. 여러 번 불러도 안전하고, 개발 실행에서는 아무 일도
/// 일어나지 않는다(2.6.2 `checkForUpdates`와 같은 계약).
pub fn check(app: &AppHandle) {
    if disabled() {
        return;
    }
    {
        let mut g = lock();
        if g.busy {
            return; // 이미 도는 중 — 두 벌이 같은 상태를 밀면 게이지가 튄다
        }
        g.busy = true;
    }
    let a = app.clone();
    tauri::async_runtime::spawn(async move {
        run_check(&a).await;
        lock().busy = false;
    });
}

/// `app:update-install` — 받아둔 설치본을 적용한다(카드의 「업데이트」 버튼 · **여기가
/// 설치를 부르는 유일한 자리다**. 헤더의 「종료 시 자동 설치」 함정 참고).
pub fn install(app: &AppHandle) {
    if disabled() {
        return;
    }
    // 잠금은 여기서 끝난다 — let-else의 else 팔이 락을 든 채 돌지 않게 한 줄로 뗀다.
    let taken = lock().pending.take();
    let Some((update, bytes)) = taken else {
        // 받아둔 게 없다 = 누를 수 없는 버튼이 눌렸다(카드는 `downloaded`에서만 그린다).
        // 조용히 돌아가되 상태는 손대지 않는다 — 화면의 「적용하는 중…」은 다음 이벤트가 푼다.
        return;
    };
    let a = app.clone();
    // **메인 스레드에서** 설치한다. 두 가지 이유가 있다:
    //  ① `TrayIcon::drop`의 `DestroyWindow`는 창을 만든 스레드에서만 성공한다
    //     (`ipc/windows.rs:280`의 같은 실측) — 아래 `on_before_exit`가 그것을 놓는다.
    //  ② 플러그인의 Windows 경로는 `ShellExecuteW` 직후 `std::process::exit(0)`이다.
    //     tokio 워커에서 그걸 돌리면 그 순간 남의 IPC가 진행 중이든 말든 끝난다.
    let _ = app.run_on_main_thread(move || match update.install(&bytes) {
        // 여기 도달하지 않는다 — 성공 경로는 안에서 프로세스를 끝낸다.
        Ok(()) => {}
        // 추출(임시 파일 쓰기) 실패 등. **이 경우 `on_before_exit`는 아직 안 돌았다**
        // (플러그인은 추출 성공 뒤에 부른다) — 앱은 멀쩡히 살아 있고, 화면에 사유를 말한다.
        Err(e) => {
            let msg = e.to_string();
            // 받아둔 설치본은 그대로 유효하다 — 되돌려 놓아 다시 누를 수 있게.
            {
                let mut g = lock();
                g.pending = Some((update, bytes));
            }
            set(&a, |s| {
                s.phase = phase::ERROR;
                s.error = Some(msg.clone());
                s.log.push(t("설치를 시작하지 못했어요", "Could not start the installer"));
            });
        }
    });
}

// ── 몸통 ────────────────────────────────────────────────────────────────────

/// 조회 한 사이클. `busy`는 호출자가 든다.
async fn run_check(app: &AppHandle) {
    let probing = lock().probing;
    if !probing {
        // 확인 사이클마다 로그·이전 오류를 새로 시작 — 주기 재확인으로 로그가 무한히
        // 안 자라게(2.6.2 `updater.ts:72`).
        set(app, |s| {
            s.log.clear();
            s.last_step = -1;
            s.phase = phase::CHECKING;
            s.error = None;
            s.log.push(t("업데이트를 확인하는 중…", "Checking for updates…"));
        });
    }

    let updater = match build(app) {
        Ok(u) => u,
        Err(e) => return fail(app, e.to_string()),
    };
    let found = match updater.check().await {
        Ok(v) => v,
        Err(e) => return fail(app, e.to_string()),
    };

    let Some(update) = found else {
        // 최신이다.
        {
            let mut g = lock();
            if g.probing {
                g.probing = false; // 받아둔 상태 그대로 — 카드·설치본 불변(2.6.2 `:92`)
                return;
            }
        }
        return set(app, |s| {
            s.phase = phase::NONE;
            s.log.push(t("이미 최신 버전이에요", "Already up to date"));
        });
    };

    let ver = update.version.clone();
    // 조용한 재확인이면, **더 새 버전일 때만** 일반 흐름으로 복귀한다(2.6.2 `:77-85`).
    {
        let mut g = lock();
        if g.probing {
            let stay_silent = g.version.as_deref().is_some_and(|have| !is_newer(&ver, have));
            if stay_silent {
                g.probing = false;
                return;
            }
            g.probing = false;
            g.log.clear();
            g.last_step = -1;
        }
    }
    set(app, |s| {
        s.phase = phase::AVAILABLE;
        s.version = Some(ver.clone());
        s.percent = 0;
        s.log.push(t(
            &format!("새 버전 v{ver}을(를) 찾았어요 · 다운로드를 시작합니다"),
            &format!("Found new version v{ver} · starting download"),
        ));
    });

    // 2.6.2 `autoDownload = true` — 찾는 즉시 백그라운드로 받는다.
    download(app, update).await;
}

/// 다운로드 + 서명 검증. `Update::download`가 **반환하기 전에** minisign 검증을 하므로
/// 여기로 바이트가 돌아왔다는 것은 곧 「공개키로 확인된 설치본」이라는 뜻이다.
async fn download(app: &AppHandle, update: Update) {
    let a = app.clone();
    let mut done: u64 = 0;
    // 진행률은 **정수 퍼센트가 바뀔 때만** 방출한다. 청크는 수십 KB라 그냥 흘리면 한 번
    // 받는 데 수백 개의 IPC가 나가고, 화면이 얻는 것은 없다(게이지는 1% 단위다).
    let mut last_pct: i64 = -1;
    let bytes = update
        .download(
            |chunk, total| {
                done += chunk as u64;
                let p = pct(done, total);
                if p == last_pct {
                    return;
                }
                last_pct = p;
                let total_b = total.unwrap_or(0);
                let step = log_step(p);
                set(&a, |s| {
                    s.phase = phase::DOWNLOADING;
                    s.percent = p;
                    if step != s.last_step {
                        s.last_step = step;
                        s.log.push(if en_ui() {
                            format!("Downloading {p}% · {} / {} MB", mb(done), mb(total_b))
                        } else {
                            format!("다운로드 {p}% · {} / {} MB", mb(done), mb(total_b))
                        });
                    }
                });
            },
            || {},
        )
        .await;

    match bytes {
        Ok(b) => {
            let ver = update.version.clone();
            {
                let mut g = lock();
                g.pending = Some((Box::new(update), b));
            }
            set(app, |s| {
                s.phase = phase::DOWNLOADED;
                s.version = Some(ver);
                s.percent = 100;
                s.log.push(t(
                    "다운로드 완료 · 업데이트 버튼으로 적용할 수 있어요",
                    "Download complete · press Update to apply",
                ));
            });
        }
        Err(e) => fail(app, e.to_string()),
    }
}

/// 오류 한 곳. 조용한 재확인 중이면 **삼킨다** — 받아둔 설치본은 그대로 유효하고
/// 다음 주기에 다시 시도한다(2.6.2 `updater.ts:121-124`).
fn fail(app: &AppHandle, msg: String) {
    {
        let mut g = lock();
        if g.probing {
            g.probing = false;
            return;
        }
    }
    // 셸 로그에도 남긴다. 화면의 카드는 **업데이트가 진행되던 중**(version 있음)일 때만
    // 뜨므로(`AppUpdateGate.tsx:48` — 2.6.2와 같은 규칙: 오프라인이라고 매번 오류 카드를
    // 띄우지 않는다), 첫 조회 실패는 상태(`app:update-status`)와 이 줄에만 남는다.
    eprintln!("[updater] {msg}");
    set(app, |s| {
        s.phase = phase::ERROR;
        s.error = Some(msg);
        s.log.push(t("업데이트 중 오류가 발생했어요", "Something went wrong while updating"));
    });
}

/// 업데이터 한 벌. `endpoints`는 설정(`tauri.conf.json`)이 원본이고 [`FEED_ENV`]가 덮는다.
fn build(app: &AppHandle) -> tauri_plugin_updater::Result<tauri_plugin_updater::Updater> {
    let h = app.clone();
    let mut b = app.updater_builder().on_before_exit(move || {
        // **설치기를 띄우기 직전**, 프로세스가 `exit(0)`으로 끝나기 전의 마지막 한 뼘이다
        // (플러그인은 추출 성공 뒤 `ShellExecuteW` 바로 앞에서 이걸 부른다). `exit(0)`은
        // `RunEvent::ExitRequested`를 **건너뛰므로**, `main.rs`가 정상 종료에 하던 세 가지를
        // 여기서 같은 순서로 한다 — 안 하면 죽은 트레이 아이콘이 알림 영역에 남고
        // (`TrayIcon`은 refcount라 `NIM_DELETE`가 Drop에서만 나간다 · `tray.rs` `TRAY`),
        // 500ms 디바운스에 걸려 있던 마지막 상태 전이가 디스크에 안 내려간다.
        crate::crash::begin_shutdown();
        crate::win::tray::release_icon(&h);
        crate::engine::shutdown();
        h.cleanup_before_exit();
    });
    if let Some(feed) = std::env::var(FEED_ENV).ok().filter(|s| !s.trim().is_empty()) {
        b = b.endpoints(vec![feed.trim().parse()?])?;
    }
    b.build()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 스냅샷의 **모양**이 계약면 `UpdateStatus`와 같아야 한다 — 키 하나가 어긋나면
    /// 카드가 조용히 `undefined`를 읽는다(`percent`가 그러면 게이지 폭이 `NaN%`).
    #[test]
    fn snapshot_is_the_contract_shape() {
        let s = St::new();
        let v = s.snapshot();
        let o = v.as_object().expect("객체여야 한다");
        let mut keys: Vec<&str> = o.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["error", "log", "percent", "phase", "version"]);
        assert_eq!(v["phase"], "idle");
        assert!(v["version"].is_null());
        assert_eq!(v["percent"], 0);
        assert!(v["log"].as_array().unwrap().is_empty());
        assert!(v["error"].is_null());
    }

    /// 화면이 카드를 띄우는 네 값(`AppUpdateGate.tsx:47`)이 우리가 쓰는 문자열과
    /// **글자 그대로** 같아야 한다. 오타 하나면 카드는 영원히 안 뜬다.
    #[test]
    fn phase_names_match_the_renderer() {
        assert_eq!(
            [phase::IDLE, phase::CHECKING, phase::AVAILABLE, phase::DOWNLOADING, phase::DOWNLOADED, phase::NONE, phase::ERROR],
            ["idle", "checking", "available", "downloading", "downloaded", "none", "error"]
        );
    }

    /// 조용한 재확인의 침묵 규칙 — 같은(또는 낮은) 버전이면 카드를 안 건드리고,
    /// 더 새 버전이면 일반 흐름으로 복귀한다. 이게 뒤집히면 '나중에'로 접은 카드가
    /// 30분마다 되뜬다(2.6.2가 `probing`을 만든 이유).
    #[test]
    fn probing_stays_silent_unless_a_newer_one_appears() {
        assert!(!is_newer("3.0.0", "3.0.0"));
        assert!(!is_newer("2.9.9", "3.0.0"));
        assert!(is_newer("3.0.1", "3.0.0"));
        assert!(is_newer("3.1.0", "3.0.9"));
        // 자릿수가 다른 꼴도 2.6.2 `compareVersionsDesc`와 같은 답이어야 한다
        assert!(is_newer("3.0.0.1", "3.0.0"));
        assert!(!is_newer("3.0", "3.0.0"));
    }

    /// 게이지·로그 눈금.
    #[test]
    fn percent_and_log_steps() {
        assert_eq!(pct(0, Some(100)), 0);
        assert_eq!(pct(42, Some(100)), 42);
        assert_eq!(pct(100, Some(100)), 100);
        // 총 길이를 모르면 0 — 근거 없는 게이지를 그리지 않는다
        assert_eq!(pct(500, None), 0);
        assert_eq!(pct(500, Some(0)), 0);
        // 서버가 Content-Length를 짧게 불러도 100을 넘지 않는다
        assert_eq!(pct(300, Some(100)), 100);
        assert_eq!(log_step(0), 0);
        assert_eq!(log_step(4), 0);
        assert_eq!(log_step(5), 1);
        assert_eq!(log_step(99), 19);
        assert_eq!(log_step(100), 20);
    }

    /// ★2.6.2의 실제 사고를 되풀이하지 않는다는 **구조적** 못.
    ///
    /// 종료 시 자동 설치는 화면 없이 NSIS가 도는 경로라 그 사이에 PC가 꺼지면 앱이
    /// 통째로 사라진다(`updater.ts:59-65`). 3.0에서 설치를 부르는 자리는 [`install`]
    /// **하나**여야 하고, 종료 경로(`main.rs`의 `RunEvent::ExitRequested`)는 이 모듈을
    /// 아예 몰라야 한다. 소스를 읽어 그 성질을 확인한다 — 다음 라운드가 "종료할 때 겸사겸사
    /// 설치하자"를 한 줄 더하는 순간 이 못이 먼저 부러진다.
    #[test]
    fn install_is_never_wired_to_exit() {
        let me = include_str!("updater.rs");
        // 못 자신과 주석은 빼고 센다 — 안 그러면 이 못의 소스가 자기를 세어 늘 깨진다.
        let body = me.split("#[cfg(test)]").next().unwrap_or_default();
        let calls = body
            .lines()
            .filter(|l| {
                let t = l.trim_start();
                !t.starts_with("//") && t.contains(".install(")
            })
            .count();
        // 이 파일 안에서 설치기를 실제로 부르는 자리는 정확히 하나(=[`install`]의 몸통)
        assert_eq!(calls, 1, "설치 호출부가 하나가 아니다");
        let main_rs = include_str!("main.rs");
        // 종료 핸들러가 있는 파일이 업데이터의 설치 문을 알면 안 된다
        assert!(!main_rs.contains("updater::install"), "종료 경로가 설치를 부른다");
        // 그리고 실제로 종료 이벤트를 다루는 파일이 맞는지 확인(못이 엉뚱한 파일을 보지 않게)
        assert!(main_rs.contains("RunEvent::ExitRequested"), "종료 핸들러를 못 찾았다");
    }
}
