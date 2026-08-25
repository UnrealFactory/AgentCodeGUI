//! 앱 메타 · 자동 업데이트 · 엔진 버전 상태. (ipc.rs에서 분리 — 동작 불변)

use super::{arg, ch};
use serde_json::{json, Value};

pub fn dispatch(channel: &str, p: &Value) -> Option<Value> {
    Some(match channel {
        // ── app meta ────────────────────────────────────────────────────────
        ch::APP_GET_VERSION => json!(env!("CARGO_PKG_VERSION")),
        // "AgentCodeGUI로 열기"(파일 탐색기 컨텍스트 메뉴)의 **콜드 런치 반쪽**.
        // 명령줄에 실려 온 폴더를 그대로 돌려준다(★파리티 R1 M2).
        // 짝인 **웜 런치 반쪽**(이미 떠 있는 앱에 폴더가 또 오는 경우)은 아래
        // [`open_dir`]에 있다 — R28i에서 닫혔다.
        ch::APP_GET_INITIAL_DIR => super::parity::misc::initial_dir(),
        // 앱 자동 업데이트(electron-updater 자리)는 아직 없다 — 정직하게 idle.
        // AppUpdateGate는 phase가 available/downloading/downloaded/error일 때만 뜬다.
        ch::UPDATE_GET_STATUS => json!({
            "phase": "idle", "version": Value::Null, "percent": 0, "log": [], "error": Value::Null
        }),

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

    /// **파일을 한 번 만진다**(`metadata`). 도달 불가 UNC 경로면 그 한 번이 21초라
    /// (main.rs `ccg-img` 헤더의 실측) 이 함수는 UI 스레드·async 워커에서 부르지 않는다.
    pub fn classify(raw: &str) -> Verdict {
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
            Ok(m) if m.is_dir() => Verdict::Ok(abs.to_string_lossy().to_string()),
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

    /// 인계를 **소비한다**(읽으면 지운다). 늦은 것은 버린다 — 위 `HANDOFF_TTL_MS` 참고.
    pub fn take_pending() -> Option<String> {
        let v = ccg_store::read_home_json(HANDOFF);
        // 파싱에 실패했더라도 지운다 — 못 읽는 잔해가 남아 매 기동을 갉을 이유가 없다.
        let _ = std::fs::remove_file(handoff_path());
        let v = v?;
        if now_ms() - v.get("at").and_then(Value::as_i64).unwrap_or(0) > HANDOFF_TTL_MS {
            return None;
        }
        let p = v.get("path")?.as_str()?.trim().to_string();
        if p.is_empty() {
            None
        } else {
            Some(p)
        }
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
                let _ = app.emit_to(
                    crate::win::MAIN,
                    super::ch::APP_OPEN_DIRECTORY_FAILED,
                    json!({ "path": raw, "reason": reason }),
                );
                json!({ "ok": false, "reason": reason, "path": raw })
            }
        }
    }

    /// **첫 인스턴스가 부른다** — 「창을 앞으로」 신호를 받은 직후(`win::tray`의 subclass).
    ///
    /// 자기 스레드로 뺀다: 판정이 `fs::metadata` 한 번이지만 그 한 번이 도달 불가 UNC
    /// 경로에서 21초고, 이 함수의 호출자는 **창 스레드**다. 거기서 자면 창이 통째로
    /// "응답 없음"이 된다(main.rs `ccg-img` 비동기 등록이 같은 실측 위에 있다).
    pub fn deliver_pending(app: &AppHandle) {
        let a = app.clone();
        let _ = std::thread::Builder::new().name("ccg-opendir".into()).spawn(move || {
            if let Some(raw) = take_pending() {
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
    }
}
