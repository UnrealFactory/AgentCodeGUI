//! 앱 메타 · 자동 업데이트 · 엔진 버전 상태. (ipc.rs에서 분리 — 동작 불변)

use super::{arg, ch};
use serde_json::{json, Value};
use tauri::AppHandle;

pub fn dispatch(app: &AppHandle, channel: &str, p: &Value) -> Option<Value> {
    Some(match channel {
        // ── app meta ────────────────────────────────────────────────────────
        ch::APP_GET_VERSION => json!(env!("CARGO_PKG_VERSION")),
        // (`app:get-initial-dir`는 여기 없다 — 판정이 파일을 만지고 실패 카드를 쏘려면
        //  `AppHandle`이 필요해 `ipc_call`의 블로킹 팔에서 `open_dir::initial_dir`이 받는다.
        //  콜드·웜 두 반쪽이 **같은 잣대**를 쓰게 하는 자리다. 아래 [`open_dir`] 참고.)

        // ── ★R28j N8. 앱 자동 업데이트 3채널 (몸통은 `crate::updater`) ─────────
        // R28i까지 이 자리는 하드코딩 `idle` 하나였다 — 「electron-updater 자리는 아직
        // 없다, 정직하게 idle」. 정직했지만 사용자가 얻는 것은 없었다: 앱 안에서 새 버전을
        // **알 수도 받을 수도 없었다**(최종 파리티 R5 §9.1 `N8` · 높음).
        //
        // 셋 다 **개발 실행에서는 no-op**이다(2.6.2 `app.isPackaged` 게이트와 같은 성질).
        // 그래서 `npm run tauri:dev` 중에 가짜 오류 카드가 뜨지 않는다.
        ch::UPDATE_GET_STATUS => crate::updater::status(),
        ch::UPDATE_CHECK => {
            crate::updater::check(app);
            Value::Null
        }
        ch::UPDATE_INSTALL => {
            crate::updater::install(app);
            Value::Null
        }

        // ── engine ─────────────────────────────────────────────────────────
        // 두 엔진 CLI 공통 자동 업데이트 플래그. 인자 있으면 설정, 항상 현재 값 반환.
        // 판정은 부팅 게이트와 **같은 함수**가 한다 — 화면의 토글과 실제로 도는 흐름이
        // 다른 사본을 읽으면 "켜 놨는데 안 돈다"가 조용히 생긴다.
        ch::ENGINE_AUTO_UPDATE => {
            if let Some(enabled) = arg(p, 0).as_bool() {
                let _ = ccg_store::write_home_file(
                    "engine-auto-update.json",
                    &json!({ "enabled": enabled }).to_string(),
                );
            }
            json!(crate::engine::boot_update::auto_update())
        }
        // ★R28 T1T2 R2 — R1까지 이 자리는 하드코딩 `{active:false}`였고 `engine:update-event`
        // 방출자는 0이었다. 그래서 `EngineGate`는 "자동 업데이트가 할 테니 비켜"라며
        // 물러나고 그 자동 업데이트는 존재하지 않았다(확인 크리틱 §4.2). 이제 진짜
        // 부팅 흐름의 스냅샷이다.
        ch::ENGINE_UPDATE_STATUS => crate::engine::boot_update::status(),
        ch::ENGINE_STATE => engine_state(&ccg_engine::versions::CLAUDE),
        ch::CODEX_ENGINE_STATE => engine_state(&ccg_engine::versions::CODEX),

        _ => return None,
    })
}

/// 앱 홈에 버전별로 깔린 엔진 CLI의 실제 설치 상태. `bundled`는 3.0에 없다 —
/// 2.6.2는 앱에 SDK를 번들해 폴백으로 썼지만, 3.0은 Rust가 CLI를 직접 몬다(M3).
///
/// ★R28 T1T2 R2 — R1까지 여기 `installed`/`active` 판정과 `cmp_desc`의 **사본**이
/// 있었다(확인 크리틱 §4.3: "세 번째 벌"). 판정 자체는 같았지만, 같은 질문에 두 코드가
/// 답하면 한쪽만 고쳐지는 순간 조용히 갈린다 — `ccg_engine::versions` 한 벌로 모은다.
fn engine_state(spec: &ccg_engine::versions::Spec) -> Value {
    let home = ccg_store::app_home();
    json!({
        "package": spec.package,
        "bundled": "unknown",
        "active": spec.active_version(&home),
        "installed": spec.list_installed(&home),
    })
}

// ── ★R28i N3. 「AgentCodeGUI3으로 열기」 — **웜 런치 반쪽**(`app:open-directory`) ──
//
// 설치기는 이미 HKCU에 우클릭 항목을 쓴다(`src-tauri/nsis/hooks.nsh:39-46` —
// `Directory\shell` + `Directory\Background\shell`, 명령은 `"<exe>" "%V"`).
// 그런데 3.0은 X를 눌러도 **트레이로 숨는 것이 기본**이라(`win.rs` `hide_on_close`)
// 「이미 떠 있다」가 예외가 아니라 정상 상태고, R28h까지 그 상태에서 그 메뉴를 누르면
// `main.rs`의 단일 인스턴스 관문이 `raise_existing()`만 부르고 **폴더 인자를 버렸다**.
// 창만 앞으로 오고 폴더는 조용히 사라졌다 — 오류도 안내도 없이(최종 파리티 R5 §9.1 N3).
pub mod open_dir {
    use serde_json::{json, Value};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;
    use tauri::{AppHandle, Emitter};

    /// 두 번째 인스턴스 → 첫 인스턴스 **인계 파일**. 앱 홈 아래라 격리 홈(dev·벤치)끼리
    /// 안 섞인다 — `raise_existing()`의 등록 메시지 이름이 홈 해시인 것과 같은 규약이다.
    ///
    /// 왜 파일인가: 신호는 `PostMessageW(HWND_BROADCAST, …)`인데 그 봉투에는 `WPARAM`·
    /// `LPARAM`(정수 둘)뿐이라 **경로가 안 실린다**. 포인터를 실으면 남의 주소 공간이고,
    /// `WM_COPYDATA`는 브로드캐스트가 안 된다(대상 HWND를 알아야 하는데 우리는 모른다).
    const HANDOFF: &str = ".pending-open-dir";

    /// 인계가 유효한 시간. 정상 경로는 「쓰고 → 곧바로 브로드캐스트」라 수십 ms다.
    /// 이보다 오래된 것은 *썼는데 못 받은* 잔해(첫 인스턴스가 그 사이에 죽은 경우)이고,
    /// 그걸 그대로 두면 **한참 뒤의 평범한 재실행**이 엉뚱한 폴더를 연다.
    const HANDOFF_TTL_MS: i64 = 15_000;

    /// 경로 한 줄의 판정. 실패도 **이름을 가진다** — 화면이 사유를 말해야 하기 때문이다.
    #[derive(Debug, PartialEq, Eq)]
    pub enum Verdict {
        /// 열 수 있는 폴더(절대 경로로 다듬은 값)
        Ok(String),
        /// 인자가 없거나 비었다
        Empty,
        /// 있긴 한데 폴더가 아니다(파일·장치)
        NotADir,
        /// 열 권한이 없다
        Denied,
        /// 아무것도 없다
        NotFound,
    }

    impl Verdict {
        /// 렌더러에 보내는 사유 코드(화면 문구는 `App.tsx`가 고른다 — i18n이 거기 있다).
        pub fn reason(&self) -> &'static str {
            match self {
                Verdict::Ok(_) => "ok",
                Verdict::Empty => "empty",
                Verdict::NotADir => "not-a-dir",
                Verdict::Denied => "denied",
                Verdict::NotFound => "not-found",
            }
        }
    }

    fn now_ms() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

    fn handoff_path() -> std::path::PathBuf {
        ccg_store::app_home().join(HANDOFF)
    }

    /// 「이 폴더를 **정말** 열 수 있는가」의 잣대 — 탐색기가 하려는 그 일(목록 열기)을
    /// 한 번 해 본다. 값은 안 읽는다(`FindFirstFileW` 한 번).
    ///
    /// ★R28i 확인 크리틱 R1 **D1** — R1까지 판정은 `metadata` 한 번이었고, 그게 이
    /// 라운드의 최대 격차였다. Windows에서는 **부모를 읽을 수만 있으면 deny ACL이 걸린
    /// 폴더에도 `metadata`가 성공한다**(속성이 부모의 디렉터리 엔트리에서 온다). 그래서
    /// [`Verdict::Denied`]는 사실상 도달 불가였고 대신 `Ok`로 떨어져 **못 읽는 폴더가
    /// 작업 폴더가 됐다** — 화면은 사유를 말하지 않고 파일 트리는 "비어 있음"이라고
    /// **사실이 아닌 것**을 적었다("빈 폴더구나"로 읽힌다).
    ///
    /// 실측(`icacls <dir> /inheritance:r /grant:r SYSTEM:(OI)(CI)F` 건 폴더 · rustc 프로브):
    ///
    /// ```text
    ///            metadata      read_dir
    ///  못 읽는   Ok(is_dir)    Err PermissionDenied (os error 5)   ← 여기만 갈린다
    ///  빈 폴더   Ok(is_dir)    Ok · 첫 항목 None
    ///  보통      Ok(is_dir)    Ok · 첫 항목 Some
    ///  C:\       Ok(is_dir)    Ok
    /// ```
    ///
    /// 빈 폴더가 `Ok`인 것이 이 잣대의 핵심이다 — "안이 비었다"와 "안을 못 본다"를
    /// 가른다. 도달 불가 UNC는 위 `metadata`에서 이미 걸러져 여기까지 오지 않으므로
    /// 이 한 줄이 UNC 21초에 더하는 시간은 0이다.
    fn enumerable(dir: &std::path::Path) -> std::io::Result<()> {
        std::fs::read_dir(dir).map(|_| ())
    }

    /// **파일을 한 번 만진다**(`metadata` + 폴더면 [`enumerable`]). 도달 불가 UNC 경로면
    /// 그 한 번이 21초라(main.rs `ccg-img` 헤더의 실측) 이 함수는 UI 스레드·async
    /// 워커에서 부르지 않는다.
    pub fn classify(raw: &str) -> Verdict {
        classify_with(raw, enumerable)
    }

    /// [`classify`]의 몸통 — 「목록을 열 수 있나」를 주입할 수 있어야 못을 박는다.
    /// ACL은 테스트 환경마다 다르게 걸리지만 **배선**은 언제나 같아야 한다.
    fn classify_with(raw: &str, enumerable: impl Fn(&std::path::Path) -> std::io::Result<()>) -> Verdict {
        let raw = raw.trim();
        if raw.is_empty() {
            return Verdict::Empty;
        }
        let p = std::path::Path::new(raw);
        // 2.6.2 `openedDirFromArgv`의 `path.resolve(a)` 자리. 탐색기 컨텍스트 메뉴는 늘
        // 절대 경로(`%V`)를 주므로 정상 경로에서는 **아무것도 바뀌지 않는다**.
        let abs = if p.is_absolute() {
            p.to_path_buf()
        } else {
            std::env::current_dir().map(|c| c.join(p)).unwrap_or_else(|_| p.to_path_buf())
        };
        match std::fs::metadata(&abs) {
            Ok(m) if m.is_dir() => match enumerable(&abs) {
                Ok(()) => Verdict::Ok(abs.to_string_lossy().to_string()),
                // 그 찰나에 사라졌다면 사용자가 보는 사실은 「없다」다(경쟁)
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Verdict::NotFound,
                // 목록을 못 여는 이유는 실질적으로 하나다(액세스 거부). 다른 사유여도
                // 사용자가 보는 사실은 같다 — **이 폴더는 못 연다**. 조용히 여는 것보다
                // 사유를 말하고 안 여는 쪽이 옳다.
                Err(_) => Verdict::Denied,
            },
            // **부모로 올리지 않는다.** 사용자가 안 고른 자리에 조용히 착지하는 것이고,
            // 콜드 런치(`parity::misc::initial_dir`)는 파일을 그냥 무시하므로 두 경로의
            // 착지가 갈린다 — 대신 화면이 "폴더가 아니다"라고 말한다.
            Ok(_) => Verdict::NotADir,
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => Verdict::Denied,
            Err(_) => Verdict::NotFound,
        }
    }

    /// 명령줄에서 「열어 달라」는 인자를 고른다.
    ///
    /// 고르는 잣대는 콜드 런치(`ipc/parity/misc.rs` `initial_dir`)와 **같다**: 스위치
    /// (`-`로 시작)는 건너뛰고 **처음으로 폴더인 인자**가 이긴다. 다른 점은 하나 —
    /// 유효한 게 하나도 없으면 **첫 비-스위치 인자를 그대로 돌려준다**. 콜드는 조용히
    /// `null`이면 되지만 여기는 사용자에게 사유를 말해야 하고, 그러려면 무엇이 왔는지가
    /// 남아 있어야 한다.
    pub fn arg_candidate() -> Option<String> {
        pick_candidate(std::env::args().skip(1))
    }

    /// [`arg_candidate`]의 순수 함수 몸통 — 인자를 손으로 먹일 수 있어야 못을 박는다
    /// (`std::env::args()`는 프로세스 전역이라 테스트가 못 흔든다).
    pub fn pick_candidate<I: IntoIterator<Item = String>>(args: I) -> Option<String> {
        let mut first_non_switch: Option<String> = None;
        for a in args {
            if a.starts_with('-') {
                continue; // 스위치는 폴더가 아니다
            }
            if std::path::Path::new(&a).is_dir() {
                return Some(a);
            }
            if first_non_switch.is_none() {
                first_non_switch = Some(a);
            }
        }
        first_non_switch
    }

    /// **두 번째 인스턴스가 부른다** — 물러나기 **전에** 인계 파일을 남긴다.
    /// 순서가 규약이다: 파일이 먼저, 브로드캐스트가 나중(그 반대면 첫 인스턴스가
    /// 아직 없는 파일을 읽는다).
    pub fn stash_from_args() -> bool {
        let Some(raw) = arg_candidate() else { return false };
        ccg_store::write_home_file(HANDOFF, &json!({ "path": raw, "at": now_ms() }).to_string()).is_ok()
    }

    /// **두 번째 인스턴스의 착지 전부** — 인계를 남기고, 그 **성패를 그대로** 봉투 비트로
    /// 실어 보낸다. 반환 = 실제로 보낸 `wparam`(진단·테스트용).
    ///
    /// ★확인 크리틱 R2 **D1** — 이 함수가 없을 때 `main.rs`는
    /// `let handed = stash_from_args(); raise_existing(handed);` 두 줄이었고, 크리틱이
    /// 그 둘째 줄을 `raise_existing(true)`로 바꾼 사본에서 **174/174이 초록**이었다.
    /// 인자를 받지 않는 한 줄로 내려 **상수를 박을 자리를 없앤다** — 못으로 잡는 것보다
    /// 애초에 못 틀리게 만드는 쪽이 낫다. 남은 왕복(비트 ↔ 판정)은
    /// [`crate::win::tray::raise_wparam`]·[`crate::win::tray::should_deliver`]에 못이 박혀 있다.
    pub fn stash_and_raise() -> usize {
        let w = crate::win::tray::raise_wparam(stash_from_args());
        crate::win::tray::raise_existing(w);
        w
    }

    /// **렌더러가 듣고 있는가.** `app:get-initial-dir`가 도착한 순간 켜진다.
    ///
    /// 그 호출이 신호인 이유: 렌더러는 하이드레이션이 끝난 뒤에 그것을 묻고
    /// (`App.tsx` — `if (!hydrated) return`), 구독 둘(`onOpenDirectory`·
    /// `onOpenDirectoryFailed`)은 **마운트 이펙트**라 같은 브리지로 그보다 **먼저**
    /// 등록 요청을 보냈다. 브리지가 FIFO라 이 신호가 켜졌으면 방출은 반드시 닿는다.
    static RENDERER_READY: AtomicBool = AtomicBool::new(false);

    /// 인계는 **한 번만** 걷힌다 — raise 수신부와 [`initial_dir`]이 같은 파일에 동시에
    /// 손을 뻗을 수 있다(부팅 창). 읽기+지우기가 한 덩어리여야 둘 다 같은 경로를 열지 않는다.
    static HANDOFF_GATE: Mutex<()> = Mutex::new(());

    fn renderer_ready() -> bool {
        RENDERER_READY.load(Ordering::SeqCst)
    }

    /// 인계를 **소비한다**(읽으면 지운다). 늦은 것은 버린다 — 위 `HANDOFF_TTL_MS` 참고.
    pub fn take_pending() -> Option<String> {
        let _gate = HANDOFF_GATE.lock().unwrap_or_else(|e| e.into_inner());
        let v = ccg_store::read_home_json(HANDOFF);
        // 파싱에 실패했더라도 지운다 — 못 읽는 잔해가 남아 매 기동을 갉을 이유가 없다.
        let _ = std::fs::remove_file(handoff_path());
        let v = v?;
        if now_ms() - v.get("at").and_then(Value::as_i64).unwrap_or(0) > HANDOFF_TTL_MS {
            return None;
        }
        // ★확인 크리틱 R1 **D4** — 공백만 있는 경로도 **들고 온다**. R1은 여기서
        // `trim()` 후 빈 것을 `None`으로 떨어뜨렸고, 그래서 `exe "   "`가 카드도 없이
        // 사라졌다(`Verdict::Empty`가 인계 경로에서 도달 불가였다). 사유를 말하려고 첫
        // 비-스위치 인자를 들고 온다는 `pick_candidate`의 설계 의도가 바로 그 칸에서
        // 무효가 됐던 셈이다. **판정은 `classify` 한 곳에서만** 한다.
        Some(v.get("path")?.as_str()?.to_string())
    }

    /// raise 수신부가 쓰는 문 — **듣는 사람이 있을 때만** 걷는다.
    ///
    /// ★확인 크리틱 R1 **D2** — R1은 raise 신호를 받자마자 무조건 소비했다. 기동 후
    /// 0.3~0.8초 창에서는 렌더러가 아직 `listen()` 전이라 방출이 통째로 버려졌고, 폴더는
    /// N3이 없애려던 그 모양 그대로 **조용히 사라졌다**(+327ms 실측: 인계는 소비됐는데
    /// 착지는 안 함). 안 듣고 있으면 **안 걷는다** — 남겨 두면 [`initial_dir`]이 걷는다.
    /// 그것도 못 걷으면 TTL이 스스로 만료시킨다.
    pub fn pending_for_delivery(ready: bool) -> Option<String> {
        if !ready {
            return None;
        }
        take_pending()
    }

    /// raise 수신 스레드가 **실제로 부르는** 문 — 인자를 안 받는다.
    ///
    /// ★확인 크리틱 R2 **D1** — `deliver_pending` 안이
    /// `pending_for_delivery(renderer_ready())`였을 때, 크리틱이 그 인자를 `true`로
    /// 바꾼 사본에서 **174/174이 초록**이었다(= 부팅 창의 침묵 D2(a)가 통째로 재개통되는데
    /// 게이트는 조용하다). `stash_and_raise`와 같은 처방이다: 호출부에서 상수를 박을
    /// 자리를 없애고, 판정은 못이 박힌 [`pending_for_delivery`] 한 곳에만 둔다.
    pub(super) fn pending_now() -> Option<String> {
        pending_for_delivery(renderer_ready())
    }

    /// 콜드 부팅이 부른다 — 남아 있던 **잔해만** 턴다(자기 명령줄 폴더는
    /// `app:get-initial-dir`가 처리하므로 첫 인스턴스는 인계를 받을 일이 없다).
    ///
    /// **무조건 지우지 않는 이유**: 좁지만 실재하는 경쟁이 하나 있다 — A가 잠금을 딴 직후
    /// B가 잠금에 실패해 인계를 남기는 창. 거기서 「무조건 삭제」면 B가 들고 온 폴더가
    /// 조용히 사라진다(이 라운드가 없애려는 바로 그 모양이다). 늦은 것만 지우면 신선한
    /// 인계는 살아남아 raise 수신부가 소비하거나, 아무도 안 받으면 TTL로 스스로 사라진다.
    pub fn clear_stale() {
        let Some(v) = ccg_store::read_home_json(HANDOFF) else {
            // 없거나 못 읽는다 — 못 읽는 잔해는 지운다(없으면 no-op)
            let _ = std::fs::remove_file(handoff_path());
            return;
        };
        if now_ms() - v.get("at").and_then(Value::as_i64).unwrap_or(0) > HANDOFF_TTL_MS {
            let _ = std::fs::remove_file(handoff_path());
        }
    }

    /// 판정 → 렌더러 방출. **두 경로가 이 함수 하나로 모인다**: 두 번째 인스턴스의
    /// 인계와 `app:open-directory` 원시 호출.
    ///
    /// 성공 페이로드는 2.6.2와 **글자 그대로 같다**(`send(IPC.openDirectory, dir)` —
    /// 문자열 하나). 실패는 2.6.2에 아예 없던 통지라 계약면 밖의 3.0 전용 채널로 간다.
    pub fn request(app: &AppHandle, raw: &str) -> Value {
        match classify(raw) {
            Verdict::Ok(dir) => {
                let _ = app.emit_to(crate::win::MAIN, super::ch::APP_OPEN_DIRECTORY, json!(dir));
                json!({ "ok": true, "dir": dir })
            }
            v => {
                let reason = v.reason();
                emit_failed(app, raw, reason);
                json!({ "ok": false, "reason": reason, "path": raw })
            }
        }
    }

    /// 실패 통지 한 곳 — 계약면(`src/shared/protocol.ts`)에 없는 3.0 전용 셸 채널이다.
    fn emit_failed(app: &AppHandle, path: &str, reason: &str) {
        let _ = app.emit_to(
            crate::win::MAIN,
            super::ch::APP_OPEN_DIRECTORY_FAILED,
            json!({ "path": path, "reason": reason }),
        );
    }

    /// **렌더러가 부팅을 마치고 처음 묻는 자리** — `app:get-initial-dir`.
    /// 돌려준 값은 `App.tsx`가 `openProjectDir()`에 그대로 먹인다(웜 방출과 **같은 함수**).
    ///
    /// 세 가지를 한 자리에서 한다.
    ///
    /// ① **듣기 시작했다는 신호**(`RENDERER_READY`) — 이 아래 전부가 여기 걸려 있다.
    ///
    /// ② **콜드 런치의 인자에도 사유를 말한다**(확인 크리틱 R1 D3 · R1까지 조용했다).
    ///    「어느 인자가 폴더인가」의 잣대는 2.6.2 `openedDirFromArgv` 자리
    ///    (`parity::misc::initial_dir`)를 **그대로 쓴다** — 두 반쪽이 같은 인자를 고르게.
    ///    여기서 더하는 것은 정직함뿐이다: 그 답을 [`classify`]로 한 번 더 걸러
    ///    **못 읽는 폴더를 콜드에서도 안 연다**(D1은 웜만이 아니라 콜드에도 있었다).
    ///    부팅 중 방출이 `listen()`을 앞지를 걱정이 없는 이유는 이게 **방출이 아니라
    ///    응답**이기 때문이다 — 렌더러가 물었으니 이미 듣고 있다.
    ///
    /// ③ **부팅 창에 도착해 아직 안 걷힌 인계**를 걷는다(D2). raise 브로드캐스트가
    ///    리스너보다 빨랐거나(+30ms: 신호 자체가 유실), 리스너는 받았지만 렌더러가 아직
    ///    안 듣고 있어 [`pending_for_delivery`]가 남겨 둔 것(+327ms). 늦게라도 착지한다.
    pub fn initial_dir(app: &AppHandle) -> Value {
        RENDERER_READY.store(true, Ordering::SeqCst);

        let mut answer = Value::Null;
        let cold = match crate::ipc::parity::misc::initial_dir() {
            Value::String(s) => Some(s),
            // 폴더인 인자가 하나도 없었다 — 사유를 말하려면 무엇이 왔는지가 남아야 한다
            _ => arg_candidate(),
        };
        if let Some(raw) = cold {
            answer = landing(app, &raw);
        }
        if let Some(raw) = take_pending() {
            // 인계가 이겼다면 **나중 지시가 이긴다**(사용자가 방금 우클릭한 폴더).
            // 실패면 카드만 뜨고 콜드의 착지는 그대로 둔다.
            let late = landing(app, &raw);
            if !late.is_null() {
                answer = late;
            }
        }
        answer
    }

    /// 「이 경로로 착지할 것인가」 — 착지하면 경로를, 아니면 카드를 띄우고 `null`.
    /// **성공을 방출하지 않는 것이 중요하다**: 이 값은 `app:get-initial-dir`의 응답으로
    /// 가고, 방출까지 하면 렌더러가 같은 폴더를 두 번 열어 확인 카드가 두 번 뜬다.
    fn landing(app: &AppHandle, raw: &str) -> Value {
        match classify(raw) {
            Verdict::Ok(dir) => json!(dir),
            v => {
                emit_failed(app, raw, v.reason());
                Value::Null
            }
        }
    }

    /// **첫 인스턴스가 부른다** — 「창을 앞으로」 신호를 받은 직후(`win::tray`의 subclass).
    ///
    /// 자기 스레드로 뺀다: 판정이 `fs::metadata` 한 번이지만 그 한 번이 도달 불가 UNC
    /// 경로에서 21초고, 이 함수의 호출자는 **창 스레드**다. 거기서 자면 창이 통째로
    /// "응답 없음"이 된다(main.rs `ccg-img` 비동기 등록이 같은 실측 위에 있다).
    /// 이 함수를 부르는 것은 **폴더를 들고 온 두 번째 인스턴스의 신호**뿐이다
    /// (`WPARAM=1`). 인자 없는 재실행의 raise는 `WPARAM=0`이라 여기 오지 않는다 —
    /// 확인 크리틱 R1 D2의 「인계 잔해가 인자 없는 재실행을 납치한다」가 닫히는 자리다.
    pub fn deliver_pending(app: &AppHandle) {
        let a = app.clone();
        let _ = std::thread::Builder::new().name("ccg-opendir".into()).spawn(move || {
            if let Some(raw) = pending_now() {
                let _ = request(&a, &raw);
            }
        });
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn dir_wins_and_file_is_named() {
            let h = ccg_store::testhome::take("opendir-classify");
            let dir = h.dir.join("proj");
            std::fs::create_dir_all(&dir).unwrap();
            let file = h.dir.join("proj").join("a.txt");
            std::fs::write(&file, "x").unwrap();

            assert_eq!(classify(&dir.to_string_lossy()), Verdict::Ok(dir.to_string_lossy().to_string()));
            assert_eq!(classify(&file.to_string_lossy()), Verdict::NotADir);
            assert_eq!(classify(&h.dir.join("nope").to_string_lossy()), Verdict::NotFound);
            assert_eq!(classify(""), Verdict::Empty);
            assert_eq!(classify("   "), Verdict::Empty);
            // 사유 코드는 렌더러 문구의 키다 — 이름이 바뀌면 카드가 조용히 기본 문구로 떨어진다
            assert_eq!(Verdict::NotADir.reason(), "not-a-dir");
            assert_eq!(Verdict::Denied.reason(), "denied");
            assert_eq!(Verdict::NotFound.reason(), "not-found");
        }

        /// ★확인 크리틱 R1 **D1** — 못 읽는 폴더는 **안 연다**.
        ///
        /// R1의 못(`dir_wins_and_file_is_named`)은 `Denied`를 **문자열 이름표로만**
        /// 확인해서 이 칸을 못 잡았다. ACL은 테스트 환경마다 다르게 걸리므로 여기서는
        /// 「목록을 못 열더라」를 주입해 **배선**에 못을 박는다(진짜 ACL은 아래 별도 못).
        #[test]
        fn a_dir_we_cannot_list_is_denied_not_opened() {
            let h = ccg_store::testhome::take("opendir-denied");
            let dir = h.dir.join("locked");
            std::fs::create_dir_all(&dir).unwrap();
            let s = dir.to_string_lossy().to_string();

            // 폴더인 것은 맞다 — `metadata`만으로는 R1과 똑같이 `Ok`로 떨어진다
            assert!(std::fs::metadata(&dir).unwrap().is_dir());
            assert_eq!(classify_with(&s, |_| Ok(())), Verdict::Ok(s.clone()));

            // 목록이 안 열리면 **작업 폴더가 되지 않는다**
            let denied = |_: &std::path::Path| {
                Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "액세스 거부"))
            };
            assert_eq!(classify_with(&s, denied), Verdict::Denied);
            // 그 사이에 사라졌으면 사용자가 보는 사실은 「없다」다
            let gone = |_: &std::path::Path| Err(std::io::Error::from(std::io::ErrorKind::NotFound));
            assert_eq!(classify_with(&s, gone), Verdict::NotFound);

            // **빈 폴더는 그대로 열린다** — "안이 비었다"와 "안을 못 본다"를 가르는 잣대다
            let empty = h.dir.join("empty");
            std::fs::create_dir_all(&empty).unwrap();
            let e = empty.to_string_lossy().to_string();
            assert_eq!(classify(&e), Verdict::Ok(e));
        }

        /// 같은 못을 **진짜 ACL**로 한 번 더. `icacls`가 안 먹는 환경(정책·권한)에서는
        /// 조용히 건너뛴다 — 대신 위 주입 못이 배선을 지킨다.
        #[cfg(windows)]
        #[test]
        fn a_real_deny_acl_folder_is_denied() {
            let h = ccg_store::testhome::take("opendir-acl");
            let dir = h.dir.join("Denied");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("secret.txt"), "x").unwrap();
            let s = dir.to_string_lossy().to_string();

            let out = std::process::Command::new("icacls")
                .args([&s, "/inheritance:r", "/grant:r", "SYSTEM:(OI)(CI)F"])
                .output();
            let applied = out.is_ok() && std::fs::read_dir(&dir).is_err();
            if applied {
                // ★이 줄이 R1의 병이다 — Windows는 **못 읽는 폴더에도 `metadata`를 준다**
                assert!(std::fs::metadata(&dir).map(|m| m.is_dir()).unwrap_or(false));
                assert_eq!(classify(&s), Verdict::Denied, "deny ACL 폴더가 열렸다");
            }
            // 상속을 되돌려 임시 홈이 지워질 수 있게 한다(안 그러면 잔해가 쌓인다)
            let _ = std::process::Command::new("icacls").args([&s, "/inheritance:e"]).output();
            let _ = std::fs::remove_dir_all(&dir);
        }

        /// 고르는 잣대가 콜드 런치(`parity::misc::initial_dir`)와 어긋나면 두 경로의
        /// 착지가 갈린다 — 스위치는 건너뛰고, **처음으로 폴더인 인자**가 이긴다.
        #[test]
        fn candidate_matches_the_cold_rule_and_keeps_the_bad_one() {
            let h = ccg_store::testhome::take("opendir-argv");
            let d1 = h.dir.join("one");
            let d2 = h.dir.join("two");
            std::fs::create_dir_all(&d1).unwrap();
            std::fs::create_dir_all(&d2).unwrap();
            let (s1, s2) = (d1.to_string_lossy().to_string(), d2.to_string_lossy().to_string());

            // 스위치는 건너뛴다 + 폴더 둘이면 앞의 것
            let got = pick_candidate(vec!["--flag".into(), s1.clone(), s2.clone()]);
            assert_eq!(got.as_deref(), Some(s1.as_str()));
            // 폴더가 뒤에 있어도 폴더가 이긴다(앞의 비-폴더는 후보일 뿐)
            let got = pick_candidate(vec!["없는경로".into(), s2.clone()]);
            assert_eq!(got.as_deref(), Some(s2.as_str()));
            // 유효한 게 하나도 없으면 **버리지 않고** 첫 비-스위치를 들고 온다(사유를 말하려고)
            assert_eq!(pick_candidate(vec!["-x".into(), "없는경로".into()]).as_deref(), Some("없는경로"));
            assert_eq!(pick_candidate(Vec::<String>::new()), None);
            assert_eq!(pick_candidate(vec!["--only-switches".into()]), None);
        }

        #[test]
        fn handoff_is_consumed_once() {
            let h = ccg_store::testhome::take("opendir-handoff");
            ccg_store::write_home_file(HANDOFF, &json!({ "path": "C:\\Code", "at": now_ms() }).to_string()).unwrap();
            assert_eq!(take_pending().as_deref(), Some("C:\\Code"));
            // 두 번째 호출은 없다 — 소비했으니 평범한 재실행이 엉뚱한 폴더를 열지 않는다
            assert_eq!(take_pending(), None);
            assert!(!h.dir.join(HANDOFF).exists());
        }

        #[test]
        fn stale_handoff_is_dropped() {
            let _h = ccg_store::testhome::take("opendir-stale");
            let old = now_ms() - HANDOFF_TTL_MS - 1;
            ccg_store::write_home_file(HANDOFF, &json!({ "path": "C:\\Code", "at": old }).to_string()).unwrap();
            assert_eq!(take_pending(), None);
        }

        /// 콜드 부팅의 청소는 **잔해만** 턴다 — 신선한 인계(잠금 경쟁에서 방금 남긴 것)를
        /// 지우면 그게 곧 「폴더가 조용히 사라졌다」다.
        #[test]
        fn clear_stale_drops_the_old_one_and_keeps_a_fresh_one() {
            let h = ccg_store::testhome::take("opendir-clear");
            ccg_store::write_home_file(HANDOFF, &json!({ "path": "C:\\Code", "at": now_ms() - HANDOFF_TTL_MS - 1 }).to_string())
                .unwrap();
            clear_stale();
            assert!(!h.dir.join(HANDOFF).exists());

            ccg_store::write_home_file(HANDOFF, &json!({ "path": "C:\\Code", "at": now_ms() }).to_string()).unwrap();
            clear_stale();
            assert!(h.dir.join(HANDOFF).exists());
            assert_eq!(take_pending().as_deref(), Some("C:\\Code"));
        }

        #[test]
        fn broken_handoff_does_not_linger() {
            let h = ccg_store::testhome::take("opendir-broken");
            ccg_store::write_home_file(HANDOFF, "{ not json").unwrap();
            assert_eq!(take_pending(), None);
            assert!(!h.dir.join(HANDOFF).exists());
        }

        /// ★확인 크리틱 R1 **D2** — 아무도 안 듣고 있으면 **걷지 않는다**.
        ///
        /// R1은 raise 신호를 받자마자 소비했고, 기동 직후 창에서는 렌더러가 아직
        /// `listen()` 전이라 방출이 통째로 버려졌다 — 폴더는 다시 조용히 사라졌다.
        /// 안 걷으면 나중에 `initial_dir`이 걷는다: 그 두 번째 손이 이 못의 마지막 줄이다.
        #[test]
        fn a_handoff_is_not_taken_before_anyone_is_listening() {
            let h = ccg_store::testhome::take("opendir-ready");
            ccg_store::write_home_file(HANDOFF, &json!({ "path": "C:\\Code", "at": now_ms() }).to_string()).unwrap();

            // 안 듣고 있다 — 파일은 **그대로 남는다**
            assert_eq!(pending_for_delivery(false), None);
            assert!(h.dir.join(HANDOFF).exists(), "안 듣는데 인계를 걷어 버렸다");

            // 듣기 시작하면 그때 걷힌다(= 늦게라도 착지한다)
            assert_eq!(pending_for_delivery(true).as_deref(), Some("C:\\Code"));
            assert!(!h.dir.join(HANDOFF).exists());
        }

        /// ★확인 크리틱 R2 **D1** — 위 못은 `pending_for_delivery`를 **직접** 불렀다.
        /// 그래서 `deliver_pending`이 그 인자를 `true`로 박아 버려도(= 부팅 창의 침묵
        /// 재개통) 174/174이 초록이었다. 이 못은 **배선이 실제로 부르는 문**([`pending_now`])을
        /// 지난다 — 그 안에서 `renderer_ready()`를 안 보면 여기서 붉어진다.
        ///
        /// 단위 테스트 프로세스에서 `RENDERER_READY`는 `false`다: 그 값을 켜는 자리는
        /// `initial_dir(app)` 하나뿐이고 그건 `AppHandle`을 요구해 여기서 못 부른다.
        /// 그러니 「신선한 인계가 디스크에 있는데도 `pending_now()`가 `None`」이 이 못의
        /// 단정이고, 인자를 `true`로 박은 변이는 `Some`을 돌려주며 즉시 붉어진다.
        #[test]
        fn the_wire_that_delivery_actually_calls_still_waits_for_a_listener() {
            let h = ccg_store::testhome::take("opendir-pending-now");
            ccg_store::write_home_file(HANDOFF, &json!({ "path": "C:\\Code", "at": now_ms() }).to_string()).unwrap();

            assert_eq!(
                pending_now(),
                None,
                "★ 배선이 렌더러를 안 보고 인계를 걷었다 — 부팅 창의 폴더가 다시 조용히 사라진다"
            );
            assert!(h.dir.join(HANDOFF).exists(), "★ 안 걷었다면서 파일을 지웠다");
        }

        /// ★확인 크리틱 R2 **D1** — 봉투 한 비트의 **왕복**.
        ///
        /// 송신부(`raise_wparam`)와 수신부(`should_deliver`)가 어긋나면 둘 중 하나다:
        /// 폴더를 들고 왔는데 안 걷거나(N3이 없애려던 「조용히 사라진다」), 인자 없는
        /// 재실행이 남의 인계 잔해를 걷는다(R1 D2의 `hijacked=true`). 그래서 한쪽 값이
        /// 아니라 **왕복**을 잰다.
        #[test]
        fn the_handoff_bit_survives_the_round_trip() {
            use crate::win::tray::{raise_wparam, should_deliver};

            // 인계를 남긴 재실행 → 걷는다
            assert!(should_deliver(raise_wparam(true)), "★ 폴더를 들고 왔는데 안 걷는다");
            // 인자 없는 재실행 → 안 걷는다(잔해 납치 방지)
            assert!(!should_deliver(raise_wparam(false)), "★ 인자 없는 재실행이 인계를 걷는다");
            // 두 봉투는 실제로 **다른 값**이어야 한다 — 같으면 위 둘 중 하나가 거짓이 된다
            assert_ne!(raise_wparam(true), raise_wparam(false));
            // 우리가 안 지은 봉투(다른 앱·옛 버전의 브로드캐스트)도 걷지 않는다
            assert!(!should_deliver(0), "★ 빈 봉투가 인계를 걷는다");
            assert!(!should_deliver(2), "★ 모르는 봉투가 인계를 걷는다");
        }

        /// ★확인 크리틱 R1 **D4** — 공백만 있는 인계도 **사유를 갖는다**.
        /// R1은 `take_pending`이 여기서 `None`을 돌려줘 카드도 없이 사라졌다.
        #[test]
        fn a_blank_handoff_still_has_a_reason() {
            let _h = ccg_store::testhome::take("opendir-blank");
            ccg_store::write_home_file(HANDOFF, &json!({ "path": "   ", "at": now_ms() }).to_string()).unwrap();
            assert_eq!(take_pending().as_deref(), Some("   "), "공백 인계가 조용히 버려졌다");
            assert_eq!(classify("   "), Verdict::Empty);
            assert_eq!(Verdict::Empty.reason(), "empty");
        }
    }
}
