//! WebView2(Chromium) 스위치 조립 — 3.0의 메모리 레버가 전부 여기로 모인다.
//!
//! ## 왜 한 곳인가
//! `additional_browser_args`를 **지정하는 순간 wry의 기본 인자는 통째로 버려진다**
//! (wry-0.55.1 `webview2/mod.rs:294` — `pl_attrs.additional_browser_args.unwrap_or_else(default)`).
//! 그래서 wry가 넣어주던 `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`을
//! 여기서 **직접 복제**한다. 빼먹으면 우클릭 미니 메뉴가 되살아나고 SmartScreen이 붙는다.
//!
//! ## Chromium 스위치 병합 규칙 (밟기 쉬운 함정)
//! 같은 스위치가 두 번 오면 Chromium은 **마지막 것만** 본다. `--disable-features=A`와
//! `--disable-features=B`를 따로 주면 A가 조용히 사라진다. 그래서 feature 목록은
//! 문자열로 덧붙이지 않고 `Vec<&str>`로 모아 **마지막에 한 줄로** 만든다.
//!
//! ## 실험 훅 (레버를 하나씩 켜고 재기 위한 것 — 재빌드 없이)
//! - `CCG_WEBVIEW_ARGS`            : 전체 치환. 기본값을 완전히 무시한다(대조군용).
//! - `CCG_WEBVIEW_ARGS_EXTRA`      : 스위치 덧붙이기 (`--foo --bar=1`).
//! - `CCG_WEBVIEW_DISABLE_FEATURES`: `--disable-features` 목록에 **합류**(덮어쓰기 아님).
//! - `CCG_WEBVIEW_ENABLE_FEATURES` : `--enable-features` 목록에 합류.
//! - `CCG_CDP_PORT`                : `--remote-debugging-port=N` (벤치 전용).
//!
//! `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`(WebView2 로더가 읽는 공식 환경변수)를 쓰지
//! 않는 이유: 그 변수가 `AdditionalBrowserArguments`를 **덮어쓰는지 합치는지** 문서가
//! 모호하다. 덮어쓰기라면 벤치가 CDP 포트를 그 변수로 넣는 순간 제품이 박아둔 레버가
//! 전부 날아가고, 그러면 "레버를 켠 채로 쟀다"는 말이 거짓이 된다. 그래서 3.0의 벤치는
//! `CCG_CDP_PORT`로 **우리 조립기를 거쳐** 포트를 넣는다.
//! (어느 쪽이 이기는지는 `bench/flags.mjs precedence`가 실측해 결과 파일에 남긴다.)

/// wry 기본값 복제 — 빼면 미니 메뉴/PDF OOUI/SmartScreen이 되살아난다.
const FEATURES_OFF_WRY_DEFAULT: &[&str] = &["msWebOOUI", "msPdfOOUI", "msSmartScreenProtection"];

/// R2에서 실측으로 채택한 레버(`--disable-features` 합류분).
/// **하나씩 켜고 잰 기여도는 `bench/results/webview-flags.json`에 있다.**
const FEATURES_OFF_ADOPTED: &[&str] = &[
    // Edge/WebView2가 미리 띄워두는 예비 렌더러 프로세스. 우리는 창 하나에 문서 하나라
    // 예비 렌더러가 쓰일 일이 없는데 프로세스 하나를 통째로 차지한다.
    "SpareRendererForSitePerProcess",
    // 오디오를 별도 유틸리티 프로세스로 빼는 기능. 앱이 소리를 내지 않는다.
    "AudioServiceOutOfProcess",
    // 번역 UI·힌트·백그라운드 최적화 — 앱 셸에서 쓰이지 않는다.
    "Translate",
    "OptimizationHints",
    "OptimizationGuideModelDownloading",
    // 뒤로가기 캐시: SPA 한 장짜리 앱엔 의미가 없고 문서 스냅샷만 붙든다.
    "BackForwardCache",
    // 미디어 라우팅(캐스트) 탐색 — 백그라운드 네트워킹의 주범.
    "MediaRouter",
];

/// `--enable-features` 합류분(실측 채택분).
const FEATURES_ON_ADOPTED: &[&str] = &[
    // 네트워크 서비스를 별도 유틸리티 프로세스가 아니라 브라우저 프로세스 안에서 돌린다.
    // 프로세스 하나가 통째로 사라진다.
    "NetworkServiceInProcess",
];

/// feature 목록이 아닌 일반 스위치(실측 채택분).
const SWITCHES_ADOPTED: &[&str] = &[
    // 렌더러를 하나로 묶는다. 3.0의 메인 창은 문서 한 장이라 격리로 얻을 게 없다.
    "--renderer-process-limit=1",
    // 같은 사이트(tauri.localhost)의 문서는 프로세스를 공유. 위와 같은 이유.
    "--process-per-site",
    // 쓰지 않는 부팅 잡업: 확장·컴포넌트 업데이트·동기화·백그라운드 네트워킹.
    "--disable-extensions",
    "--disable-component-update",
    "--disable-sync",
    "--disable-background-networking",
    // 첫 실행 안내/기본 브라우저 체크 등 셸에 무의미한 UI 경로.
    "--no-first-run",
    "--no-default-browser-check",
    "--noerrdialogs",
];

fn split_list(s: &str) -> impl Iterator<Item = &str> {
    s.split(',').map(str::trim).filter(|x| !x.is_empty())
}

/// 최종 인자 문자열. 조립 순서 = 기본 → 채택 레버 → 실험 훅 → CDP.
pub fn browser_args() -> String {
    if let Ok(all) = std::env::var("CCG_WEBVIEW_ARGS") {
        // 전체 치환(대조군). 그래도 CDP는 붙여준다 — 안 그러면 벤치가 못 붙는다.
        return with_cdp(all);
    }

    let mut off: Vec<String> = Vec::new();
    let mut on: Vec<String> = Vec::new();
    let mut switches: Vec<String> = Vec::new();

    for f in FEATURES_OFF_WRY_DEFAULT {
        off.push((*f).into());
    }
    // CCG_WEBVIEW_ARGS_BASE_ONLY=1 → wry 기본값만. R2 레버의 총 기여도를 재는 대조군.
    let base_only = std::env::var("CCG_WEBVIEW_ARGS_BASE_ONLY").is_ok();
    if !base_only {
        off.extend(FEATURES_OFF_ADOPTED.iter().map(|s| s.to_string()));
        on.extend(FEATURES_ON_ADOPTED.iter().map(|s| s.to_string()));
        switches.extend(SWITCHES_ADOPTED.iter().map(|s| s.to_string()));
    }

    if let Ok(v) = std::env::var("CCG_WEBVIEW_DISABLE_FEATURES") {
        off.extend(split_list(&v).map(str::to_string));
    }
    if let Ok(v) = std::env::var("CCG_WEBVIEW_ENABLE_FEATURES") {
        on.extend(split_list(&v).map(str::to_string));
    }

    let mut args: Vec<String> = Vec::new();
    off.dedup();
    if !off.is_empty() {
        args.push(format!("--disable-features={}", off.join(",")));
    }
    on.dedup();
    if !on.is_empty() {
        args.push(format!("--enable-features={}", on.join(",")));
    }
    args.extend(switches);

    if let Ok(extra) = std::env::var("CCG_WEBVIEW_ARGS_EXTRA") {
        for tok in extra.split_whitespace() {
            args.push(tok.to_string());
        }
    }
    with_cdp(args.join(" "))
}

fn with_cdp(mut s: String) -> String {
    if let Ok(port) = std::env::var("CCG_CDP_PORT") {
        if !port.is_empty() {
            s.push_str(&format!(" --remote-debugging-port={port}"));
        }
    }
    s
}
