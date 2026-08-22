// 콘솔 창 없이 뜨게 (릴리즈만 — dev는 로그를 봐야 한다)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod crash;
mod engine;
mod ipc;
mod webview_args;
mod win;

use std::fs::OpenOptions;

/// 단일 인스턴스 — **앱 홈 경로**를 키로 잡는다.
/// 격리 홈(CCG_HOME=.bench-home-tauri 등)끼리는 서로를 막지 않아야 벤치·dev가 사용자
/// 실앱과 나란히 돌 수 있다. 앱 홈 안의 잠금 파일을 공유 금지(dwShareMode=0)로 열어
/// 프로세스가 사는 동안 붙들고 있으면, 같은 홈을 쓰는 두 번째 인스턴스만 실패한다.
fn acquire_home_lock() -> Option<std::fs::File> {
    let home = ccg_store::app_home();
    let _ = std::fs::create_dir_all(&home);
    let path = home.join(".instance-lock");
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .share_mode(0) // 다른 프로세스의 어떤 열기도 거부
            .open(path)
            .ok()
    }
    #[cfg(not(windows))]
    {
        OpenOptions::new().write(true).create(true).truncate(true).open(path).ok()
    }
}

fn main() {
    // 락은 프로세스 수명 동안 살아 있어야 한다(드랍되면 핸들이 닫혀 잠금이 풀린다)
    let Some(_lock) = acquire_home_lock() else {
        // 같은 앱 홈으로 이미 떠 있다 — 조용히 물러난다.
        // (2.6.2는 이 자리에서 기존 창을 앞으로 가져온다. 3.0은 창 라우팅이 서는
        //  M2에서 같은 동작을 붙인다 — docs/m1-report.md 갭 목록.)
        return;
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // ── 로컬 이미지 스킴(M6) ─────────────────────────────────────────────
        // 렌더러는 자기 오리진에서 file://을 못 읽어(webSecurity), 첨부 이미지와 뷰어의
        // 이미지/SVG 보기가 2.6.2부터 이 전용 스킴으로 바이트를 받아 간다.
        // 서빙 판정은 전부 `ccg_fs::serve`에 있다(2.6.2 IMG_EXTS 표 그대로 + 64MB 캡).
        //
        // ★ 아직 렌더러가 이 URL을 만들지 못한다: `app/src/lib/images.ts imageSrc()`가
        //   `ccg-img://local/?p=…`를 돌려주는데, **WebView2는 비표준 스킴을 못 받는다**.
        //   wry는 그래서 커스텀 스킴을 `http://<scheme>.localhost/…`로 바꿔 거는데
        //   (wry-0.55 webview2/mod.rs `work_around_uri_prefix`), 렌더러가 만든 리터럴
        //   `ccg-img://`는 그 필터에 안 걸린다. 셸 쪽(여기)은 두 모양을 다 받게 해 뒀으니
        //   렌더러 한 줄만 바뀌면 붙는다 — 자세한 건 docs/m6-report-r1.md §미구현.
        .register_uri_scheme_protocol("ccg-img", |_ctx, request| {
            use tauri::http::{header, Response, StatusCode};
            match ccg_fs::serve::image_response(&request.uri().to_string()) {
                Some((mime, bytes)) => Response::builder()
                    .status(StatusCode::OK)
                    .header(header::CONTENT_TYPE, mime)
                    .header(header::CACHE_CONTROL, "no-cache")
                    // sandbox iframe·CORS 요청도 같은 답을 받게 (2.6.2 ccg-page와 같은 관례)
                    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                    .body(bytes)
                    .unwrap_or_else(|_| Response::new(Vec::new())),
                None => Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(Vec::new())
                    .unwrap_or_else(|_| Response::new(Vec::new())),
            }
        })
        .invoke_handler(tauri::generate_handler![ipc::ipc_call])
        .setup(|app| {
            win::create_main(app.handle())?;
            // 엔진 허브 — 창이 선 뒤에 띄운다(첫 브로드캐스트가 갈 곳이 있어야 한다).
            engine::boot(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("tauri 앱 빌드 실패")
        // 브라우저 프로세스가 죽어 **창을 전부 부수고 다시 만드는** 복구 구간(crash.rs)에는
        // 창 수가 잠깐 0이 된다. 기본 동작은 그때 앱을 끝내는 것이라, 복구가 창을 만들기
        // 전에 프로세스가 사라진다 — 유령 창 대신 "앱이 조용히 없어지는" 실패가 된다.
        // 복구 중일 때만 종료를 막는다(그 외에는 기본 동작 그대로).
        .run(|_app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = &event {
                if crash::is_recovering() {
                    api.prevent_exit();
                    crash::log("exit-prevented", serde_json::json!({ "why": "복구 중" }));
                } else {
                    // 정상 종료다. 여기서부터 브라우저 프로세스가 죽는 건 크래시가 아니다 —
                    // 감시자가 오인하면 **닫아도 다시 뜨는 앱**이 된다.
                    crash::begin_shutdown();
                    // ★D15 — 상태 flush. `chat:status`의 디스크 쓰기는 500ms 디바운스라
                    // (m-logic §5.8 규약 4) 마지막 전이가 안 내려간 채로 프로세스가 끝날 수
                    // 있다. 그러면 다음 부팅의 재장전 후보(hold·큐)가 **한 세대 낡는다**.
                    // 허브도 여기서 닫아 남은 claude.exe를 거둔다(job object가 2차 안전망).
                    engine::shutdown();
                }
            }
        });
}
