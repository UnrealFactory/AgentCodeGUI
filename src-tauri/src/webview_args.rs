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
//! - `CCG_WEBVIEW_ARGS_BASE_ONLY`  : 채택 레버를 전부 빼고 wry 기본값만(대조군).
//! - `CCG_GPU_PROCESS=1`           : `--in-process-gpu`를 빼고 GPU를 다시 별도 프로세스로.
//! - `CCG_SINGLE_PROCESS=1`        : MS 미지원 단일 프로세스 모드(아래 `single_process`).
//! - `CCG_CRASH_RECOVERY=0`        : 크래시 복구를 끈다(crash.rs) — 유령 창 대조군용.
//!
//! ## R3에서 실측으로 **기각**한 것 (되살리기 전에 숫자부터 볼 것)
//! - `--use-angle=gl` : 유휴 Priv 320→214MB로 가장 크게 줄고 스크롤도 60fps였지만,
//!   WebGL renderer 문자열을 찍어 보니 **`Microsoft Basic Render Driver`** 였다 —
//!   NVIDIA D3D11에서 소프트웨어 래스터라이저로 조용히 내려앉은 것이고, 그래서 GPU
//!   프로세스의 Priv(드라이버 커밋)가 106→18MB로 사라진 것뿐이다. `--disable-gpu`와
//!   같은 값을 다른 이름으로 치른다. 텍스트 UI라 이 벤치에서는 FPS가 안 떨어졌을 뿐이다.
//! - `--use-angle=gl` + `--in-process-gpu` : 유휴 315/172MB로 목표를 크게 넘겼지만
//!   **프레임 생성이 멈춘다**(rAF가 오지 않고 CDP 입력이 응답 없음 — 두 번 재현).
//! - `--single-process` + `--use-angle=gl` : 같은 이유로 정지.
//!
//! ## `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` — **실측: 환경변수가 이긴다(덮어쓴다)**
//! R2는 "문서가 모호하다"고만 적었는데, R3에서 `bench/flags.mjs precedence`로 갈랐다.
//! 코드 인자에 `--remote-debugging-port=9411`, 환경변수에 `…=9412`를 동시에 주고 어느
//! 포트가 응답하는지 봤다 → **9412만 응답**(`codeArgAnswered:false, envVarAnswered:true`,
//! bench/results/webview-flags.json의 `precedence`).
//! 즉 **누군가 그 환경변수를 세팅하면 이 파일의 레버가 전부 조용히 사라진다.** 벤치가
//! CDP 포트를 그 변수로 넣던 R1 방식이 그래서 위험했고, 지금은 `CCG_CDP_PORT`로
//! **우리 조립기를 거쳐** 포트를 넣는다. (외부 도구가 그 변수를 쓰는 환경이라면 이
//! 레버들은 무효다 — 진단할 때 제일 먼저 볼 자리.)

use std::sync::atomic::{AtomicBool, Ordering};

/// wry 기본값 복제 — 빼면 미니 메뉴/PDF OOUI/SmartScreen이 되살아난다.
const FEATURES_OFF_WRY_DEFAULT: &[&str] = &["msWebOOUI", "msPdfOOUI", "msSmartScreenProtection"];

/// `--disable-features` 합류분 — **비었다.**
///
/// R2는 여기에 7개(SpareRendererForSitePerProcess·AudioServiceOutOfProcess·Translate·
/// OptimizationHints·OptimizationGuideModelDownloading·BackForwardCache·MediaRouter)를
/// 넣고 "기여도는 bench/results/webview-flags.json에 있다"고 적었는데 **그 파일이 없었다.**
/// R3에서 실제로 스윕을 돌린 결과(멀티 4패널 유휴, CDP off, 2회 중앙값):
///   SpareRendererForSitePerProcess  ws +28  priv +111  procs 7 (안 줄어듦)
///   AudioServiceOutOfProcess        ws −13  priv  +7   procs 7
///   위 5개 묶음(C1)                  ws  −9  priv +14   procs 7
/// 어느 것도 **프로세스를 하나도 줄이지 못했다.**
/// 근거 없는 스위치를 남기면 다음 사람이 되돌릴 수 없으므로 전부 걷었다.
///
/// ⚠ R3는 여기서 "프로세스가 안 줄었다 = WebView2가 그 스위치를 무시한다"를 도출했는데
/// **그 추론은 한 번 틀렸다**(아래 `FEATURES_ON_ADOPTED` 참조). 위 목록도 현행 Chromium
/// feature 이름과 대조하기 전까지는 "무효"가 아니라 "이 이름으로는 무효"다.
const FEATURES_OFF_ADOPTED: &[&str] = &[];

/// `--enable-features` 합류분.
///
/// ## `NetworkServiceInProcess2` — 네트워크 유틸리티 프로세스를 브라우저 안으로
///
/// R2가 넣은 `NetworkServiceInProcess`는 실측에서 `utility:NetworkService`를 그대로
/// 남겼고 R3는 "WebView2가 무시한다"고 적었다. **틀린 설명이다** — Chromium이 M96 무렵
/// 그 feature의 문자열 이름을 **`NetworkServiceInProcess2`** 로 바꿨고, 존재하지 않는
/// feature 이름은 경고 없이 조용히 무시된다. 올바른 이름을 주면 그 프로세스가 사라진다:
///   `ΔWS −30.5 / ΔPriv −5.7 / **Δprocs −1**` (BASE_ONLY 위 단독, 3회 중앙값)
///   주 게이트 5회 중앙값: 유휴 450.7/248.1/6프로세스 → **426.3/241.6/5프로세스**,
///   +창2 WS 500.9 → 471.8, 하드웨어 GPU 유지(NVIDIA D3D11), 드랍 0% 5/5.
///
/// ## 채택 경위 — R4 빌더는 보류했고, 리드가 채택했다 (판정 근거가 다르다)
///
/// R4 빌더의 보류 사유: 판정 세션에서 대조군조차 절대 게이트(중앙 ≥59fps)를 못 넘어
/// "절대 게이트를 평가할 수 없는 세션에서 기본값을 바꾸지 않는다"는 규약을 지켰다.
/// 리드 재판정(fpsab 4라운드×3시행, bench/results/fps-ab.json)도 같은 상황이었다
/// (대조군 중앙 simple 56 / load 58 — 사용자 상주 앱들로 이 기계의 조용한 세션은
/// 드물다). 그러나 **레버 유해성의 판정자는 절대 밴드가 아니라 짝지은 차다**:
///   짝지은 차 중앙 simple +0.05 / load −0.6fps (라운드 노이즈 ±1 안),
///   드랍 프레임 양 팔 동일(12시행 총 2 vs 유사), p95 동일 밴드.
/// 절대 게이트 자체는 같은 코드가 조용한 세션(R3 크리틱)에서 59~60fps·드랍 0을 이미
/// 보였다. 종합: 메모리 −24MB·프로세스 −1을 공짜로 얻고 부드러움 손실 증거는 없다.
/// **단, R4 크리틱은 자기 세션에서 절대 게이트를 재검증하고, 짝지은 차로 유해가
/// 재현되면 되돌려 보내라**(한 줄 revert). 긴급 탈출구(재빌드 불필요):
///   `CCG_WEBVIEW_DISABLE_FEATURES=NetworkServiceInProcess2` (disable가 enable을 이긴다)
///
/// 스위치판(`--single-process-network`)은 올바른 이름과 무관하게 무효였다.
const FEATURES_ON_ADOPTED: &[&str] = &["NetworkServiceInProcess2"];

/// feature 목록이 아닌 일반 스위치 — **실측으로 효과가 확인된 것만.**
///
/// | 스위치 | 무엇이 달라지나 (실측, bench/results/webview-flags.json · multi-*-arm-*.json) |
/// |---|---|
/// | `--process-per-site` | **창 하나 추가 비용 114.7MB/+2프로세스 → 14.8MB/+0프로세스.** 3.0이 Electron(110.7MB·+2)을 이기는 유일한 자리이자 이 조립기 전체에서 가장 큰 레버다. 단일 창 유휴에서는 기여가 0이라 R3 1차 스윕(창 1개)에서는 "무효 레버"로 보였다 — 무대가 틀렸던 것이다. |
/// | `--in-process-gpu` | GPU 프로세스를 브라우저 프로세스 안으로. 유휴 Priv 320.6→249.6MB, 프로세스 7→6, 스크롤 60fps·드랍 0% 유지, **하드웨어 GPU 유지**(WebGL renderer가 여전히 NVIDIA D3D11). |
///
/// `--renderer-process-limit=1`은 **걷었다**: 단독으로 재니 창당 93.4MB/+2프로세스로
/// wry 기본값과 차이가 없었다(WebView2는 이 상한을 보지 않는다). 창 비용을 잡는 건
/// `--process-per-site` 쪽이다.
const SWITCHES_ADOPTED: &[&str] = &["--process-per-site", "--in-process-gpu"];

/// `--in-process-gpu`의 값과 탈출구.
///
/// 값(실측): 콜드 스타트 첫 가시 창 218→271ms, #root 마운트 328→376ms. 대신 **첫 픽셀은
/// 374→294ms로 빨라진다**(합성기가 브라우저 프로세스 안에 있어 첫 프레임이 일찍 나온다).
/// 위험: GPU 드라이버가 죽으면 프로세스 격리가 없어 웹뷰가 통째로 죽는다(멀티 프로세스
/// 였다면 GPU 프로세스만 재시작된다).
/// 그래서 되돌릴 수 있게 둔다 — `CCG_GPU_PROCESS=1`이면 GPU를 다시 별도 프로세스로.
///
/// **R4: 그 위험에 자동 대응이 붙었다.** 브라우저 프로세스가 죽으면(= 이 구성에서 GPU
/// 드라이버 크래시·TDR이 보이는 모습) `crash.rs`가 창을 재생성하면서 아래
/// `escape_in_process_gpu()`를 켠다 — 다시 만드는 웹뷰는 GPU를 별도 프로세스로 되돌린
/// 인자로 뜨므로 같은 크래시가 무한 반복되지 않는다. 실측: 브라우저를 죽이면 1.4초 만에
/// 창 3개가 재생성되고 프로세스 구성이 6 → 7(gpu-process 부활)이 된다.
fn in_process_gpu_disabled() -> bool {
    std::env::var("CCG_GPU_PROCESS").is_ok_and(|v| v != "0") || GPU_ESCAPE.load(Ordering::SeqCst)
}

/// **자동 탈출구.** 브라우저 프로세스가 죽으면(=`--in-process-gpu`에서 GPU 드라이버
/// 크래시·TDR이 나면 이렇게 보인다) crash.rs가 창을 재생성하기 직전에 이걸 켠다.
/// 그러면 다시 만드는 웹뷰는 GPU를 별도 프로세스로 되돌린 인자로 뜬다 — 같은 크래시가
/// 무한히 반복되지 않는다. 반환값은 "이번에 처음 켰는가".
static GPU_ESCAPE: AtomicBool = AtomicBool::new(false);
pub fn escape_in_process_gpu() -> bool {
    !GPU_ESCAPE.swap(true, Ordering::SeqCst)
}

/// **MS 미지원 최대 절감 모드** — `CCG_SINGLE_PROCESS=1`일 때만.
///
/// 실측(멀티 4패널 유휴, CDP on): WS 358.8 / Priv 211.3 / **3프로세스**, 스크롤 60fps·
/// 드랍 0%, 하드웨어 GPU 유지, 추가 창도 정상(창당 33.4MB). 콜드 스타트도 가장 빠르다
/// (win 211 / paint 277 / root 326ms). 즉 **측정상으로는 모든 지표에서 이긴다.**
///
/// 그런데도 기본값이 아닌 이유: `--single-process`는 Chromium이 "디버깅 전용"이라 못박은
/// 스위치이고 WebView2는 명시적으로 미지원이다. WebView2는 **Evergreen(자동 갱신)** 이라
/// 다음 Edge 업데이트가 이 경로를 깨면 이미 배포된 앱이 전부 죽는다. 샌드박스와 렌더러
/// 크래시 격리도 함께 사라진다. 실측 수치는 남기되 기본값으로 삼지 않는다 —
/// 채택 여부는 이 트레이드를 아는 사람이 정할 일이다.
///
/// **R4 실측이 사유를 하나 더 늘렸다.** 렌더러를 죽이면 이 구성은 브라우저 프로세스까지
/// 같이 죽는다(3프로세스 → 1). 되살릴 대상이 없어 `crash.rs`는 **창 정리 후 종료**로
/// 진다 — 유령 창은 안 남지만 앱이 끝난다. 같은 크래시에서 다중 프로세스 팔은
/// **455~530ms 만에 창 3개가 전부 복구된다.** 즉 "메모리는 이기고 복구는 진다".
/// (bench/results/crash-recovery-single-pid.json vs crash-recovery-default-pid.json)
/// 크래시 복구가 이 값을 본다 — 단일 프로세스에서는 브라우저가 같이 죽어
/// 되살릴 대상이 없다(crash.rs 헤더).
pub fn single_process() -> bool {
    std::env::var("CCG_SINGLE_PROCESS").is_ok_and(|v| v != "0")
}

fn split_list(s: &str) -> impl Iterator<Item = &str> {
    s.split(',').map(str::trim).filter(|x| !x.is_empty())
}

/// 공백 분리 — **큰따옴표 안의 공백은 지킨다**.
/// `--js-flags="--optimize-for-size --max-semi-space-size=1"` 같은 "값 안에 공백이 있는"
/// 스위치를 실험 훅으로 넣으려면 이게 필요하다. 단순 `split_whitespace()`면 두 번째
/// 조각이 별개 스위치가 돼 Chromium이 조용히 무시한다(레버를 켰다고 착각하는 자리).
/// 따옴표는 벗기지 않는다 — Chromium 자신이 `--js-flags="a b"`를 그렇게 파싱한다.
fn split_args(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_q = false;
    for c in s.chars() {
        match c {
            '"' => {
                in_q = !in_q;
                cur.push(c);
            }
            c if c.is_whitespace() && !in_q => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
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
        switches.extend(
            SWITCHES_ADOPTED
                .iter()
                .filter(|s| !(**s == "--in-process-gpu" && in_process_gpu_disabled()))
                .map(|s| s.to_string()),
        );
        if single_process() {
            // --single-process는 GPU도 같이 인프로세스로 끌고 온다 — 중복 지정 금지.
            switches.retain(|s| s != "--in-process-gpu");
            switches.push("--single-process".into());
        }
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
        args.extend(split_args(&extra));
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
