// 콘솔 창 없이 뜨게 (릴리즈만 — dev는 로그를 봐야 한다)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod crash;
mod engine;
/// 서브시스템 무력화 스위치 — 유휴 메모리 귀속용 A/B 팔 가르개(★R4, `flags.rs` 헤더).
mod flags;
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

// ── ccg-img 서빙 ────────────────────────────────────────────────────────────

/// 이미지 서빙 워커 수. 2.6.2의 `fs.promises.readFile`이 돌던 **libuv 기본
/// 스레드풀과 같은 폭**이다 — 느린 경로 하나가 큐를 막는 성질까지 같은 자리에 둔다.
/// (`spawn` 1개/요청으로 하면 악의적 페이지가 스레드를 무한히 만든다)
const IMG_WORKERS: usize = 4;

type ImgJob = Box<dyn FnOnce() + Send + 'static>;

/// 서빙 작업을 워커 풀에 넘긴다 — **UI 스레드에서 디스크를 만지지 않는다**(§S2).
fn img_serve(job: impl FnOnce() + Send + 'static) {
    use std::sync::{mpsc, Arc, Mutex, OnceLock};
    static POOL: OnceLock<Mutex<mpsc::Sender<ImgJob>>> = OnceLock::new();
    let tx = POOL.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<ImgJob>();
        let rx = Arc::new(Mutex::new(rx));
        for i in 0..IMG_WORKERS {
            let rx = rx.clone();
            let _ = std::thread::Builder::new().name(format!("ccg-img-{i}")).spawn(move || loop {
                // 락은 recv가 끝나면 바로 놓는다 — 일하는 동안은 다른 워커가 받는다
                let job = {
                    let g = rx.lock().unwrap_or_else(|e| e.into_inner());
                    g.recv()
                };
                match job {
                    Ok(j) => j(),
                    Err(_) => break, // 발신자 소멸 = 종료
                }
            });
        }
        Mutex::new(tx)
    });
    let job: ImgJob = Box::new(job);
    let sent = {
        let g = tx.lock().unwrap_or_else(|e| e.into_inner());
        g.send(job)
    };
    // 풀이 통째로 죽은 경우(정상 경로에는 없다) — 요청을 영영 매달아 두느니
    // 여기서 처리한다. 느려질지언정 뷰어가 스피너로 굳지는 않는다.
    if let Err(std::sync::mpsc::SendError(job)) = sent {
        job();
    }
}

/// URI 하나 → HTTP 응답. 워커 스레드에서만 불린다.
fn img_response(uri: &str, origin: Option<&str>) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{header, Response, StatusCode};
    let not_found = || {
        Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Vec::new())
            .unwrap_or_else(|_| Response::new(Vec::new()))
    };
    // ★R4 — 귀속 팔(`CCG_NO_FS`). 스킴 자체는 남기고 **서빙만** 끊는다:
    // 등록을 조건부로 하면 wry가 만드는 스킴 핸들러 테이블이 팔마다 달라져
    // 비교 대상이 흔들린다(재는 것은 `ccg-fs`가 상주로 쓰는 몫이다).
    if crate::flags::no_fs() {
        return not_found();
    }
    // ── CORS는 **앱 오리진에만** 연다 (§S3) ──────────────────────────────────
    // `Origin`이 붙었다 = 스크립트가 부른 요청(fetch/XHR)이다. `<img>`·CSS 배경 같은
    // no-cors 로드는 이 헤더를 안 보내므로 그림 그리기는 아무 영향이 없다.
    // 허용 목록 밖이면 **바이트를 아예 안 내보낸다** — 브라우저의 CORS 강제에 기대지
    // 않는 이유는, 그 강제가 WebView2 버전마다 다르면 조용히 구멍이 열리기 때문이다
    // (실측으로는 지금 WebView2도 막는다: sandbox iframe → TypeError: Failed to fetch).
    let allowed = origin.map(|o| (o, ccg_fs::serve::cors_allows(o)));
    if let Some((_, false)) = allowed {
        return Response::builder()
            .status(StatusCode::FORBIDDEN)
            .body(Vec::new())
            .unwrap_or_else(|_| Response::new(Vec::new()));
    }
    let Some((mime, bytes)) = ccg_fs::serve::image_response(uri) else { return not_found() };
    let mut b = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, "no-cache");
    if let Some((o, true)) = allowed {
        b = b.header(header::ACCESS_CONTROL_ALLOW_ORIGIN, o).header(header::VARY, "Origin");
    }
    b.body(bytes).unwrap_or_else(|_| Response::new(Vec::new()))
}

/// HTML 미리보기 문서 + 그 상대경로 리소스(`ccg-page`). 워커 스레드에서만 불린다.
///
/// `ccg-img`와 다른 두 가지:
///  1. **경로 화이트리스트** — 뷰어가 `fs:html-preview-url`로 등록한 루트 밖은 404다
///     (판정은 `ccg_fs::serve::page_response`, `canonicalize` 뒤의 실물 경로로).
///  2. **HEAD** — 뷰어의 변경 감시가 1.5초마다 이 경로를 때린다(`Last-Modified` 지문만
///     본다). 본문을 안 읽으므로 큰 문서도 부담이 없다.
fn page_response(uri: &str, method: &tauri::http::Method, origin: Option<&str>) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{header, Method, Response, StatusCode};
    // 실패 응답에도 **허용 오리진에는** ACAO를 붙인다. 안 붙이면 뷰어의 HEAD 폴링이
    // "404"가 아니라 CORS 오류(TypeError)를 받아 「파일이 사라졌다」와 「스킴이
    // 고장났다」가 같은 모양이 된다. 허용 밖 오리진에는 그대로 아무것도 안 준다.
    let cors = origin.filter(|o| ccg_fs::serve::cors_allows(o)).map(str::to_string);
    let empty = |code: StatusCode| {
        let mut b = Response::builder().status(code);
        if let Some(o) = cors.as_deref() {
            b = b.header(header::ACCESS_CONTROL_ALLOW_ORIGIN, o).header(header::VARY, "Origin");
        }
        b.body(Vec::new()).unwrap_or_else(|_| Response::new(Vec::new()))
    };
    if crate::flags::no_fs() {
        return empty(StatusCode::NOT_FOUND);
    }
    // ── CORS는 `ccg-img`와 **같은 문법**으로 앱 오리진에만 (M6 R2 §S3) ────────
    // 2.6.2는 여기에 `ACAO: *`를 달았다. 그 청중은 **미리보기 문서 자신**이다 —
    // sandbox iframe이라 오리진이 `null`이고, 그 문서는 우리가 렌더하는 **남의
    // 스크립트**다. 열어 두면 그 스크립트가 등록된 루트(=프로젝트 폴더) 아래 아무
    // 파일이나 `fetch`로 읽어 밖으로 보낼 수 있다. 그림·스타일·스크립트·비디오 로드는
    // 전부 no-cors라 헤더가 필요 없으므로 **보이는 렌더는 그대로**고, 잃는 것은
    // 문서 안의 `fetch()/XHR`과 CORS 모드 서브리소스(로컬 @font-face)뿐이다.
    // 앱 오리진은 남긴다 — 뷰어의 HEAD 폴링이 그 길로 온다.
    if origin.is_some() && cors.is_none() {
        return empty(StatusCode::FORBIDDEN);
    }
    let head_only = method == Method::HEAD;
    let Some(doc) = ccg_fs::serve::page_response(uri, head_only) else { return empty(StatusCode::NOT_FOUND) };
    let mut b = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, doc.mime)
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::LAST_MODIFIED, doc.last_modified);
    if let Some(o) = cors.as_deref() {
        b = b.header(header::ACCESS_CONTROL_ALLOW_ORIGIN, o).header(header::VARY, "Origin");
    }
    b.body(doc.bytes).unwrap_or_else(|_| Response::new(Vec::new()))
}

fn main() {
    // 락은 프로세스 수명 동안 살아 있어야 한다(드랍되면 핸들이 닫혀 잠금이 풀린다)
    let Some(_lock) = acquire_home_lock() else {
        // 같은 앱 홈으로 이미 떠 있다 — **물러나기 전에 그쪽 창을 앞으로 올린다**
        // (M1 §7-3 이월). 트레이에 숨어 있을 때 exe를 다시 실행하면 R1까지는 아무 일도
        // 안 일어났다. 등록 윈도우 메시지 브로드캐스트라 격리 홈끼리는 안 섞인다.
        //
        // ★R28i N3 — **폴더 인자를 여기서 버리지 않는다.** 「AgentCodeGUI3으로 열기」는
        // 설치기가 이미 HKCU에 쓴 메뉴이고(`nsis/hooks.nsh`), 3.0은 X를 눌러도 트레이로
        // 숨는 것이 기본이라 「이미 떠 있다」가 정상 상태다. R28h까지 그 메뉴를 누르면
        // 창만 앞으로 오고 폴더는 **오류도 안내도 없이** 사라졌다(최종 파리티 R5 §9.1 N3).
        // 순서가 규약이다: 인계 파일이 **먼저**, 브로드캐스트가 나중 — 그 반대면 먼저 뜬
        // 인스턴스가 아직 없는 파일을 읽는다.
        ipc::app_meta::open_dir::stash_from_args();
        win::tray::raise_existing();
        return;
    };
    // 잠금을 딴 쪽 = 첫 인스턴스다. 자기 명령줄 폴더는 `app:get-initial-dir`가 처리하므로
    // 인계를 받을 일이 없다 — 먼젓번 주행이 남긴 잔해가 있으면 여기서 턴다.
    ipc::app_meta::open_dir::clear_pending();

    // ★R28 ACCT R2(F3) — **계정 순서 마이그레이션을 첫 조회보다 먼저 확정한다.**
    //
    // §4는 「기본 계정 = 정렬 맨 위」이고, 옛 `defaultEmail`은 한 번 맨 위로 옮긴 뒤 안
    // 읽는다. R1은 그 이관을 `ccg_auth::claude::list_accounts()`가 지날 때만 돌렸는데,
    // 화면이 읽는 목록(`ipc/system.rs`)과 실행 정체성의 기본(`engine/ident.rs`)은
    // `accounts.json`을 **직접** 읽어 그 함수를 안 지난다. 그래서 2.6.2 승계 판
    // (`defaultEmail`이 3번째 계정)의 **첫 세션**이 통째로 옛 순서의 1번째 계정으로 돌았다
    // — §4가 막겠다고 적은 바로 그 사고다(확인 크리틱 R1 F3: 재시작해야 맞았다).
    //
    // 여기가 「먼저」의 유일하게 확실한 자리다: 창도 IPC도 아직 없다. 파일 읽기 두 번이고
    // 옮길 게 없으면 쓰기 경로에 들어가지도 않는다(대부분의 부팅).
    ccg_auth::claude::ensure_default_migrated();
    ccg_auth::codex::ensure_default_migrated();

    // 코드 인텔리전스 지연 스폰의 방아쇠 — **창보다도 먼저** 당긴다(M7 크리틱 §3.2).
    // 마지막으로 쓰던 프로젝트의 언어 서버는 렌더러가 뜨기 전에 시작해도 되는 일이고,
    // 실측으로 그 앞 구간(WebView2 환경 생성 + 창 만들기)이 수백 ms다. 전부 백그라운드
    // 스레드라 이 줄은 즉시 돌아온다.
    ipc::boot_prewarm();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // ── 로컬 이미지 스킴(M6) ─────────────────────────────────────────────
        // 렌더러는 자기 오리진에서 file://을 못 읽어(webSecurity), 첨부 이미지와 뷰어의
        // 이미지/SVG 보기가 2.6.2부터 이 전용 스킴으로 바이트를 받아 간다.
        // 서빙 판정은 전부 `ccg_fs::serve`에 있다(2.6.2 IMG_EXTS 표 그대로 + 64MB 캡).
        //
        // ★ **비동기** 등록이다(R2). 동기 `register_uri_scheme_protocol`은 핸들러를
        //   UI 스레드에서 돌리는데, 안에서 `std::fs::metadata` → `std::fs::read`를 그냥
        //   돈다. 도달 불가 UNC 경로 한 장(`\\10.255.255.1\share\a.png`)이면 그 호출이
        //   **21초** 걸리고 그동안 창이 통째로 "응답 없음"이 된다(크리틱 R1 §S2 실측:
        //   IsHungAppWindow=True). 2.6.2는 `protocol.handle(async … fs.promises)`라
        //   libuv 스레드풀에서 돌아 메인 프로세스를 안 잡는다. 아래 워커 풀이 그 자리다.
        .register_asynchronous_uri_scheme_protocol("ccg-img", |_ctx, request, responder| {
            let uri = request.uri().to_string();
            // CORS 판정에 쓸 요청 오리진(없으면 `<img>` 같은 no-CORS 로드 — 헤더 불필요)
            let origin = request
                .headers()
                .get(tauri::http::header::ORIGIN)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            img_serve(move || responder.respond(img_response(&uri, origin.as_deref())));
        })
        // ── HTML 미리보기 스킴(M6 R3) ────────────────────────────────────────
        // 뷰어가 .html을 열면 기본이 **렌더된 페이지**다(Ctrl+D로 코드 보기). 문서와 그
        // 상대경로 리소스를 이 스킴이 디스크에서 서빙하고, sandbox iframe(opaque origin)이
        // 페이지 스크립트를 앱에서 격리한다. 2.6.2 `protocol.handle('ccg-page')` 이식.
        //
        // 워커 풀은 `ccg-img`와 **공유한다** — 2.6.2도 두 핸들러가 같은 libuv 스레드풀에서
        // 돌았다(`fs.promises`). 느린 경로 하나가 큐를 막는 성질까지 같은 자리에 둔다.
        //
        // CSP는 손댈 게 없다: 2.6.2는 앱 CSP를 `onHeadersReceived`로 **주입**했기 때문에
        // `ccg-page:` 응답만 골라 빼고(문서라서 `script-src 'self'`가 인라인 스크립트를
        // 죽인다) `frame-src`·`connect-src`에 스킴을 더해야 했다. 3.0은 앱 CSP 자체가
        // 없다(`tauri.conf.json` `security.csp: null`) — 주입 경로가 없으니 그 함정도 없다.
        // 격리는 sandbox iframe이 맡는다(2.6.2와 같은 규약).
        .register_asynchronous_uri_scheme_protocol("ccg-page", |_ctx, request, responder| {
            let uri = request.uri().to_string();
            let method = request.method().clone();
            let origin = request
                .headers()
                .get(tauri::http::header::ORIGIN)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            img_serve(move || responder.respond(page_response(&uri, &method, origin.as_deref())));
        })
        .invoke_handler(tauri::generate_handler![ipc::ipc_call])
        .setup(|app| {
            win::create_main(app.handle())?;
            // 엔진 허브 — 창이 선 뒤에 띄운다(첫 브로드캐스트가 갈 곳이 있어야 한다).
            engine::boot(app.handle());
            // ★R28 T1T2 R2 — 부팅 엔진 자동 업데이트(2.6.2 `index.ts:2046`). 자기 스레드에서
            // 돌고, 할 일이 없으면 아무 카드도 안 뜬다. 이것이 없는 동안 3.0은 **엔진도
            // CLI도 없는 새 컴퓨터에서 아무 말도 하지 않았다**(확인 크리틱 §4.2).
            engine::boot_update::spawn(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("tauri 앱 빌드 실패")
        // 브라우저 프로세스가 죽어 **창을 전부 부수고 다시 만드는** 복구 구간(crash.rs)에는
        // 창 수가 잠깐 0이 된다. 기본 동작은 그때 앱을 끝내는 것이라, 복구가 창을 만들기
        // 전에 프로세스가 사라진다 — 유령 창 대신 "앱이 조용히 없어지는" 실패가 된다.
        // 복구 중일 때만 종료를 막는다(그 외에는 기본 동작 그대로).
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = &event {
                if crash::is_recovering() {
                    api.prevent_exit();
                    crash::log("exit-prevented", serde_json::json!({ "why": "복구 중" }));
                } else {
                    // 정상 종료다. 여기서부터 브라우저 프로세스가 죽는 건 크래시가 아니다 —
                    // 감시자가 오인하면 **닫아도 다시 뜨는 앱**이 된다.
                    crash::begin_shutdown();
                    // ★M8-R2 — **트레이 아이콘을 놓아 준다.** TrayIcon은 refcount라
                    // `NIM_DELETE`가 Drop에서만 나가는데 static은 절대 drop되지 않는다
                    // (tray.rs `TRAY` 주석 · 크리틱 M8 §3.3). 안 놓으면 죽은 아이콘이
                    // 알림 영역에 남아 호버해야 사라진다 — 2.6.2 `index.ts:2174
                    // tray?.destroy()`가 고쳐 둔 자리다. **이 핸들러가 이벤트 루프
                    // 스레드**라 `Rc`를 놓기에도 여기가 맞다.
                    win::tray::release_icon(app);
                    // ★D15 — 상태 flush. `chat:status`의 디스크 쓰기는 500ms 디바운스라
                    // (m-logic §5.8 규약 4) 마지막 전이가 안 내려간 채로 프로세스가 끝날 수
                    // 있다. 그러면 다음 부팅의 재장전 후보(hold·큐)가 **한 세대 낡는다**.
                    // 허브도 여기서 닫아 남은 claude.exe를 거둔다(job object가 2차 안전망).
                    engine::shutdown();
                }
            }
        });
}
