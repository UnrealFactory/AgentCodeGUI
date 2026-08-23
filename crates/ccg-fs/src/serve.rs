//! 로컬 파일 서빙 두 스킴 — 2.6.2 `src/main/index.ts`의 `protocol.handle(…)` 이식.
//!
//!  - `ccg-img` : 첨부 이미지 · 뷰어의 이미지/SVG 보기 (파일 **하나**, 경로 제한 없음)
//!  - `ccg-page`: 뷰어의 HTML 미리보기 문서 **와 그 상대경로 리소스** (등록된 루트 안만)
//!
//! 렌더러는 자기 오리진에서 `file://`을 못 읽는다(webSecurity). 그래서 두 표면 다
//! 전용 스킴으로 바이트를 받아 간다.
//!
//! ── 노출 범위 ────────────────────────────────────────────────────────────────
//! `ccg-img`에 경로 제한을 두지 않는 것은 2.6.2와 같다. 같은 렌더러가 `fs:read-file`로
//! 이미 임의 절대 경로를 읽을 수 있고(채팅의 bash 테일 미리보기가 그 경로로 돈다),
//! 이미지 확장자 파일만 image/* 로 내보내는 건 새 권한이 아니다. 여기서 범위를 좁히면
//! "참고 폴더의 스크린샷"처럼 프로젝트 밖 이미지를 여는 실사용이 깨진다.
//!
//! `ccg-page`는 반대다 — **뷰어가 등록한 루트 아래만** 서빙한다(`register_html_preview`).
//! 미리보기 문서는 sandbox iframe에서 **스크립트가 도는** 남의 코드라, 스킴이 임의
//! 로컬 파일의 창구가 되면 안 된다.

use std::path::{Component, Path, PathBuf};

/// 2.6.2 `IMG_EXTS` 그대로 — 이 표에 없는 확장자는 서빙하지 않는다(404).
const IMG_MIME: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("bmp", "image/bmp"),
    ("svg", "image/svg+xml"),
    ("avif", "image/avif"),
    ("ico", "image/x-icon"),
];

/// 한 응답의 상한. 2.6.2에는 없던 캡이다 — 렌더러가 URL 하나로 임의 크기 파일을 통째로
/// 프로세스 메모리에 올릴 수 있는 자리라, 화면에 띄울 수 있는 규모를 한참 넘는 지점에서
/// 끊는다(넘으면 404 → 뷰어는 "이미지를 표시할 수 없어요" 카드).
pub const MAX_IMAGE_BYTES: u64 = 64 * 1024 * 1024;

pub fn mime_for(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_string_lossy().to_lowercase();
    IMG_MIME.iter().find(|(e, _)| *e == ext).map(|(_, m)| *m)
}

/// 요청 URI에서 절대 경로를 뽑는다. 두 모양을 모두 받는다:
///   - `…?p=<urlencoded abs>`  ← 2.6.2가 쓰던 모양
///   - `…/<urlencoded abs>`    ← Tauri `convertFileSrc`가 만드는 모양
///
/// Windows에서 wry는 커스텀 스킴을 `http://<scheme>.localhost/…`로 바꿔 넘기므로
/// (WebView2가 비표준 스킴을 못 받는다) 여기 오는 URI의 스킴은 신경 쓰지 않는다.
pub fn path_from_uri(uri: &str) -> Option<String> {
    let after_scheme = uri.split_once("://").map(|(_, r)| r).unwrap_or(uri);
    let rest = after_scheme.split_once('/').map(|(_, r)| r).unwrap_or("");
    let (path_part, query) = match rest.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (rest, None),
    };
    if let Some(q) = query {
        for kv in q.split('&') {
            if let Some(v) = kv.strip_prefix("p=") {
                let d = percent_decode(v);
                if !d.is_empty() {
                    return Some(d);
                }
            }
        }
    }
    let d = percent_decode(path_part.trim_start_matches('/'));
    if d.is_empty() { None } else { Some(d) }
}

/// URL 퍼센트 디코딩(+ 는 공백이 아니다 — `encodeURIComponent` 결과만 받는다).
/// 디코드 결과가 UTF-8이 아니면 손실 변환한다(경로에 그런 바이트가 오면 어차피 못 연다).
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0usize;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hi = (b[i + 1] as char).to_digit(16);
            let lo = (b[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 이 오리진의 **JS가 바이트를 읽어도** 되나(CORS `Access-Control-Allow-Origin`).
///
/// ── 왜 `*`가 아닌가 (크리틱 R1 §S3) ────────────────────────────────────────
/// R1은 `ACAO: *`를 붙였다. `<img>`는 CORS를 안 타므로 **그 헤더는 그림 그리는 데
/// 필요가 없고**(실측: 렌더러의 전 사용처가 `<img src>` 하나다), 대신 청중을 바꾼다 —
/// sandbox iframe·SVG 문서·앞으로 올 `ccg-page` 미리보기처럼 **Tauri IPC가 없어
/// `fs:read-file`을 못 부르는 컨텍스트**가 디스크의 아무 `*.png`/`*.svg`를 `fetch`로
/// 읽게 된다(그 셋의 오리진은 `null`이라 이 표를 통과하지 못한다).
/// 2.6.2의 `ccg-img` 응답에는 이 헤더가 아예 없었다 — 거기서 `fetch`는 CORS로 막힌다.
///
/// 남기는 최소치는 **앱 자신의 오리진**뿐이다. 거기서는 이미 `fs:read-file`로 임의
/// 경로를 읽을 수 있으므로 새 권한이 아니고, 나중에 렌더러가 `fetch`로 이미지를
/// 받아야 할 때(캔버스 합성 등) 조용히 깨지지 않는다.
pub fn cors_allows(origin: &str) -> bool {
    // wry는 Windows에서 앱 문서를 `http://tauri.localhost`로 서빙한다(WebView2가
    // 비표준 스킴을 못 받아서). https 변종은 다른 플랫폼/설정 대비.
    if matches!(origin, "http://tauri.localhost" | "https://tauri.localhost") {
        return true;
    }
    // vite dev 서버(tauri.conf.json devUrl) — **디버그 빌드에서만**.
    // 릴리즈 exe는 번들 프론트엔드를 tauri.localhost로 서빙하므로 이 줄이 필요 없다.
    cfg!(debug_assertions)
        && matches!(origin, "http://localhost:5273" | "http://127.0.0.1:5273")
}

/// 서빙 결과 — `Some((mime, bytes))`면 200, `None`이면 404.
pub fn image_response(uri: &str) -> Option<(&'static str, Vec<u8>)> {
    let p = path_from_uri(uri)?;
    let path = Path::new(&p);
    let mime = mime_for(path)?;
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_IMAGE_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    Some((mime, bytes))
}

// ══════════════════════════════════════════════════════════════════════════════
// ccg-page — 뷰어의 HTML 미리보기
// ══════════════════════════════════════════════════════════════════════════════
//
// 2.6.2 `src/main/index.ts`의 `pageRoots` + `PAGE_MIME` + `PAGE_KEY_BRIDGE` +
// `protocol.handle('ccg-page')` 네 조각을 그대로 옮긴 것이다.
//
// URL 모양이 `ccg-img`와 다르다. **경로를 세그먼트별로** 인코딩해 슬래시를 살린다:
//   http://ccg-page.localhost/C%3A/Code/proj/index.html
// 이래야 문서 안의 상대 참조(`./style.css` · `../assets/x.png`)가 **URL 해석만으로**
// 같은 스킴의 이웃 경로가 된다(별도 매핑이 없다). `ccg-img`처럼 경로 전체를
// `encodeURIComponent` 하면 `%5C`가 섞인 **한 세그먼트**가 되어 `./style.css`가
// 루트로 튀어 오르고 서브리소스가 전멸한다.

/// 2.6.2 `PAGE_MIME` 그대로. 여기 없는 확장자는 `IMG_MIME`을 보고, 그것도 없으면
/// `application/octet-stream`(2.6.2 동일 — 404가 아니다. 문서가 참조하는 임의 자산이
/// 뜻밖의 확장자일 수 있고, 어차피 루트 화이트리스트가 범위를 잡는다).
const PAGE_MIME: &[(&str, &str)] = &[
    ("html", "text/html"),
    ("htm", "text/html"),
    ("css", "text/css"),
    ("js", "text/javascript"),
    ("mjs", "text/javascript"),
    ("json", "application/json"),
    ("txt", "text/plain"),
    ("xml", "application/xml"),
    ("woff", "font/woff"),
    ("woff2", "font/woff2"),
    ("ttf", "font/ttf"),
    ("otf", "font/otf"),
    ("wasm", "application/wasm"),
    ("mp4", "video/mp4"),
    ("webm", "video/webm"),
    ("mp3", "audio/mpeg"),
    ("wav", "audio/wav"),
    ("ogg", "audio/ogg"),
];

/// 한 응답의 상한. `ccg-img`와 같은 이유·같은 값이다(2.6.2에는 없던 캡).
pub const MAX_PAGE_BYTES: u64 = 64 * 1024 * 1024;

/// 살려 두는 서빙 루트 수. 2.6.2의 `pageRoots`는 **무한 누적**이라, 앱을 하루 켜 두고
/// 프로젝트를 여럿 오가면 예전 프로젝트 폴더가 계속 열려 있다. 미리보기는 한 번에
/// 한두 개라 최근 것만 남긴다(넘치면 가장 오래된 것부터 버린다).
pub const MAX_PAGE_ROOTS: usize = 8;

/// 미리보기 HTML 문서 끝에 덧붙이는 입력 브리지 — 2.6.2 `PAGE_KEY_BRIDGE` **한 글자도
/// 안 바꾼 사본**이다.
///
/// sandbox iframe이 포커스/호버를 가지면 부모(뷰어)가 keydown·우클릭 드래그를 못 받아
/// Ctrl+D(코드 전환)·Esc(닫기)·마우스 제스처가 죽는다. 그 입력만 `postMessage`로 부모에
/// 중계한다. 우클릭 포인터는 드래그 동안만 중계해 스팸이 없고, 획을 그렸으면 페이지
/// 자체 contextmenu도 한 발 삼킨다. 부모→페이지 방향으론 스크롤 명령(`ccgPageScroll`)을
/// 받아 ↑/↓ 제스처의 맨 위/아래를 맡는다.
/// `</html>` 뒤에 붙어도 파서가 스크립트를 body로 옮겨 실행하므로 삽입 위치를 찾을
/// 필요가 없다.
pub const PAGE_KEY_BRIDGE: &str = r#"
<script>(function(){
var post=function(m){try{window.parent.postMessage(m,"*")}catch(_){}};
window.addEventListener("keydown",function(e){
if(e.ctrlKey||e.metaKey){if(e.altKey||e.shiftKey)return;
if(e.code!=="KeyD"&&(e.key||"").toLowerCase()!=="d")return;
e.preventDefault();post({ccgPageKey:"d"});}
else if(e.key==="Escape"){post({ccgPageKey:"escape"});}
},true);
var rd=false,drew=false,sx=0,sy=0;
var rel=function(t,e){post({ccgPagePtr:{t:t,x:e.clientX,y:e.clientY}})};
window.addEventListener("pointerdown",function(e){
if(e.button!==2||e.pointerType!=="mouse")return;
rd=true;drew=false;sx=e.clientX;sy=e.clientY;rel("pd",e);
},true);
window.addEventListener("pointermove",function(e){
if(!rd)return;
if(!(e.buttons&2)){rd=false;rel("pc",e);return;}
if(Math.hypot(e.clientX-sx,e.clientY-sy)>14)drew=true;
rel("pm",e);
},true);
window.addEventListener("pointerup",function(e){
if(e.button!==2||!rd)return;rd=false;rel("pu",e);
},true);
window.addEventListener("pointercancel",function(e){
if(rd){rd=false;rel("pc",e);}
},true);
window.addEventListener("contextmenu",function(e){
if(drew){drew=false;e.preventDefault();e.stopImmediatePropagation();}
},true);
window.addEventListener("message",function(e){
var s=e.data&&e.data.ccgPageScroll;
if(s)window.scrollTo({top:s==="top"?0:document.documentElement.scrollHeight,behavior:"smooth"});
});
})()</script>
"#;

/// 등록된 서빙 루트 — **정규화(canonicalize)된 소문자 경로 + 구분자**로 담는다.
/// 최근 등록이 뒤에 온다(넘치면 앞에서 버린다).
fn page_roots() -> &'static std::sync::Mutex<Vec<String>> {
    static ROOTS: std::sync::OnceLock<std::sync::Mutex<Vec<String>>> = std::sync::OnceLock::new();
    ROOTS.get_or_init(|| std::sync::Mutex::new(Vec::new()))
}

/// `\\?\C:\x` → `c:\x`. 비교 전용 키다(I/O에는 정규화 경로 원본을 쓴다).
fn canon_key(p: &Path) -> String {
    let s = p.to_string_lossy();
    let s = s.strip_prefix(r"\\?\UNC\").map(|r| format!(r"\\{r}")).unwrap_or_else(|| {
        s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
    });
    s.to_lowercase()
}

/// 2.6.2와 같은 규칙으로 서빙 루트를 정한다: 문서가 프로젝트(cwd) 안이면 **프로젝트
/// 전체**(문서가 `../assets`를 참조해도 뜬다 — 어차피 뷰어·에이전트가 읽는 범위다),
/// 밖이면(참고 폴더 등) **그 문서의 폴더**로 좁힌다.
///
/// 반환은 렌더러가 iframe `src`에 그대로 꽂을 URL이다. 실패하면 빈 문자열 —
/// 심(`app/src/api/shim.ts`)의 안전값과 같은 모양이라 뷰어는 스피너에 머문다.
pub fn register_html_preview(cwd: &str, rel_path: &str) -> String {
    let rel = Path::new(rel_path);
    let abs = if rel.is_absolute() {
        PathBuf::from(rel_path)
    } else if cwd.is_empty() {
        return String::new();
    } else {
        Path::new(cwd).join(rel)
    };
    let abs = lexical_normalize(&abs);
    if abs.as_os_str().is_empty() {
        return String::new();
    }
    // 루트 고르기 — 문서가 cwd 아래인가(대소문자 무시 · 구분자 정규화 후 접두 비교)
    let doc_parent = abs.parent().map(Path::to_path_buf).unwrap_or_else(|| abs.clone());
    let root = if cwd.is_empty() {
        doc_parent
    } else {
        let croot = lexical_normalize(Path::new(cwd));
        let ck = with_sep(&canon_key(&croot));
        if canon_key(&abs).starts_with(&ck) { croot } else { doc_parent }
    };
    // 정규화(심볼릭 링크·정션까지 실물 경로로) — 요청 판정도 같은 좌표계에서 한다.
    let root_key = with_sep(&canon_key(&std::fs::canonicalize(&root).unwrap_or(root)));
    if let Ok(mut g) = page_roots().lock() {
        if let Some(i) = g.iter().position(|r| *r == root_key) {
            g.remove(i); // 최근 사용을 뒤로 (LRU)
        }
        g.push(root_key);
        let over = g.len().saturating_sub(MAX_PAGE_ROOTS);
        if over > 0 {
            g.drain(0..over);
        }
    }
    page_url(&abs)
}

/// 절대 경로 → `http://ccg-page.localhost/<세그먼트별 인코딩>`.
/// 2.6.2 `'ccg-page://local/' + abs.replace(/\\/g,'/').split('/').map(encodeURIComponent).join('/')`
/// 와 같은 문자열이고, 호스트만 wry 규약(`http://<scheme>.localhost/`)으로 바뀐다.
fn page_url(abs: &Path) -> String {
    let s = abs.to_string_lossy().replace('\\', "/");
    let mut out = String::from("http://ccg-page.localhost/");
    let mut first = true;
    for seg in s.split('/') {
        if !first {
            out.push('/');
        }
        first = false;
        out.push_str(&encode_uri_component(seg));
    }
    out
}

/// JS `encodeURIComponent`와 같은 비예약 문자 집합(`A-Za-z0-9 - _ . ! ~ * ' ( )`).
fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn with_sep(key: &str) -> String {
    if key.ends_with('\\') || key.ends_with('/') { key.to_string() } else { format!("{key}{}", std::path::MAIN_SEPARATOR) }
}

/// `..`/`.`를 **어휘적으로** 접는다(디스크를 안 만진다 — 없는 경로에도 쓸 수 있어야
/// 루트 등록이 파일 생성 순서를 안 탄다). 실물 판정은 `canonicalize`가 따로 한다.
fn lexical_normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// 요청 URI → 절대 경로. `ccg-img`의 `path_from_uri`와 **일부러 다르다**:
/// 쿼리(`?…`)·프래그먼트(`#…`)를 통째로 버린다. 미리보기 문서는 `./data.json?v=2` 같은
/// 참조를 마음대로 만들 수 있는데, `?p=`를 경로로 읽는 규칙이 살아 있으면 그 쿼리가
/// **경로를 갈아치우는 통로**가 된다(`ccg-img`의 `?p=`는 2.6.2 호환용이고 거긴 화이트
/// 리스트가 없어 애초에 노출이 같다 — 여기서는 화이트리스트를 우회당하면 안 된다).
fn page_path_from_uri(uri: &str) -> Option<String> {
    let after_scheme = uri.split_once("://").map(|(_, r)| r).unwrap_or(uri);
    let rest = after_scheme.split_once('/').map(|(_, r)| r).unwrap_or("");
    let rest = rest.split(['?', '#']).next().unwrap_or("");
    let d = percent_decode(rest.trim_start_matches('/'));
    if d.is_empty() { None } else { Some(d) }
}

/// 한 응답. `bytes`가 비어도 `head`면 정상 200이다.
pub struct PageDoc {
    pub mime: String,
    pub bytes: Vec<u8>,
    /// `Last-Modified` (RFC 1123). 뷰어의 변경 감시(HEAD 폴링)가 이 문자열의 변화만 본다.
    pub last_modified: String,
}

/// URI 하나 → 응답. `None`이면 404.
///
/// 등록된 루트 밖(`../..` 탈출 · 정션 우회 포함)은 404다 — 판정은 **`canonicalize` 뒤**의
/// 실물 경로로 한다(2.6.2는 `path.normalize`만 해서 링크로 밖을 볼 수 있었다).
pub fn page_response(uri: &str, head_only: bool) -> Option<PageDoc> {
    let p = page_path_from_uri(uri)?;
    let real = std::fs::canonicalize(&p).ok()?;
    let key = canon_key(&real);
    {
        let g = page_roots().lock().ok()?;
        if !g.iter().any(|r| key.starts_with(r.as_str())) {
            return None;
        }
    }
    let meta = std::fs::metadata(&real).ok()?;
    if !meta.is_file() || meta.len() > MAX_PAGE_BYTES {
        return None;
    }
    let ext = real.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let table = PAGE_MIME.iter().find(|(e, _)| *e == ext).map(|(_, m)| *m);
    let mut mime = table.or_else(|| IMG_MIME.iter().find(|(e, _)| *e == ext).map(|(_, m)| *m)).unwrap_or("application/octet-stream").to_string();
    // 2.6.2: /^text\/|json|xml$/.test(mime) → charset 부착
    if mime.starts_with("text/") || mime.contains("json") || mime.ends_with("xml") {
        mime.push_str("; charset=utf-8");
    }
    let last_modified = meta.modified().ok().map(http_date).unwrap_or_default();
    if head_only {
        return Some(PageDoc { mime, bytes: Vec::new(), last_modified });
    }
    let mut bytes = std::fs::read(&real).ok()?;
    // HTML 문서에만 입력 브리지를 덧붙인다(2.6.2와 같은 조건 — `PAGE_MIME[ext]==='text/html'`).
    if table == Some("text/html") {
        bytes.extend_from_slice(PAGE_KEY_BRIDGE.as_bytes());
    }
    Some(PageDoc { mime, bytes, last_modified })
}

/// `SystemTime` → RFC 1123(IMF-fixdate). JS `Date#toUTCString()`과 같은 문자열이다.
/// (std에 날짜 포맷이 없어서 직접 — 달력 변환은 Howard Hinnant의 `civil_from_days`)
fn http_date(t: std::time::SystemTime) -> String {
    const WD: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"]; // 1970-01-01 = 목
    const MO: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let secs = t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    let wd = WD[days.rem_euclid(7) as usize];
    format!("{wd}, {:02} {} {y} {:02}:{:02}:{:02} GMT", d, MO[(m - 1) as usize], rem / 3600, (rem % 3600) / 60, rem % 60)
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_both_url_shapes() {
        // 2.6.2 모양 (?p=)
        assert_eq!(
            path_from_uri("ccg-img://local/?p=C%3A%5CCode%5Ca%20b%5Cchat.png").as_deref(),
            Some(r"C:\Code\a b\chat.png")
        );
        // Tauri convertFileSrc 모양 (경로가 곧 URL 경로)
        assert_eq!(
            path_from_uri("http://ccg-img.localhost/C%3A%5CCode%5Cchat.png").as_deref(),
            Some(r"C:\Code\chat.png")
        );
        // 한글 경로
        assert_eq!(
            path_from_uri("http://ccg-img.localhost/C%3A%5C%ED%95%9C%EA%B8%80%5Ca.png").as_deref(),
            Some(r"C:\한글\a.png")
        );
        assert_eq!(path_from_uri("http://ccg-img.localhost/"), None);
    }

    #[test]
    fn only_image_extensions_are_served() {
        let d = std::env::temp_dir().join(format!("ccg-fs-serve-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let png = d.join("a.png");
        std::fs::write(&png, b"\x89PNG\r\n\x1a\n").unwrap();
        let txt = d.join("a.txt");
        std::fs::write(&txt, b"nope").unwrap();

        let uri = |p: &std::path::Path| format!("http://ccg-img.localhost/?p={}", enc(&p.to_string_lossy()));
        let (mime, bytes) = image_response(&uri(&png)).expect("png는 서빙된다");
        assert_eq!(mime, "image/png");
        assert_eq!(bytes.len(), 8);
        assert!(image_response(&uri(&txt)).is_none(), "이미지가 아닌 확장자는 404");
        assert!(image_response(&uri(&d)).is_none(), "폴더는 404");
        assert!(image_response(&uri(&d.join("missing.png"))).is_none(), "없는 파일은 404");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// `ACAO: *`는 회수됐다 — 앱 오리진만 통과한다(크리틱 §S3).
    /// sandbox iframe·SVG 문서의 오리진은 `null`이고, 그건 이 표에 없다.
    #[test]
    fn only_the_app_origin_may_read_the_bytes_with_js() {
        assert!(cors_allows("http://tauri.localhost"));
        assert!(cors_allows("https://tauri.localhost"));
        for deny in [
            "null",                      // sandbox iframe · SVG 문서 · data: 문서
            "http://ccg-img.localhost",  // 스킴 자신
            "https://evil.example",
            "file://",
            "http://tauri.localhost.evil.example", // 접두 매칭 함정
            "http://localhost:3000",
            "",
        ] {
            assert!(!cors_allows(deny), "{deny}를 통과시켰다");
        }
        // dev 서버는 디버그 빌드에서만 (릴리즈는 tauri.localhost로 서빙된다)
        assert_eq!(cors_allows("http://localhost:5273"), cfg!(debug_assertions));
    }

    #[test]
    fn mime_table_matches_the_262_list() {
        for (ext, want) in [("PNG", "image/png"), ("svg", "image/svg+xml"), ("ico", "image/x-icon")] {
            assert_eq!(mime_for(Path::new(&format!("x.{ext}"))), Some(want));
        }
        assert_eq!(mime_for(Path::new("x.tiff")), None);
        assert_eq!(mime_for(Path::new("noext")), None);
    }

    fn enc(s: &str) -> String {
        s.bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
                _ => format!("%{b:02X}"),
            })
            .collect()
    }

    // ── ccg-page ─────────────────────────────────────────────────────────────
    //
    // 루트 레지스트리가 프로세스 전역이라 이 그룹은 **한 테스트**로 묶는다
    // (`cargo test`는 스레드 병렬 — 갈라 놓으면 서로의 루트를 보고 결과가 흔들린다).

    #[test]
    fn page_scheme_serves_only_inside_the_registered_root() {
        let base = std::env::temp_dir().join(format!("ccg-fs-page-{}", std::process::id()));
        let proj = base.join("proj");
        let assets = proj.join("assets");
        let outside = base.join("secret");
        std::fs::create_dir_all(&assets).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(proj.join("index.html"), b"<!doctype html><p>hi</p>").unwrap();
        std::fs::write(assets.join("style.css"), b"p{color:red}").unwrap();
        std::fs::write(assets.join("logo.png"), b"\x89PNG\r\n\x1a\n").unwrap();
        std::fs::write(outside.join("secret.txt"), b"TOP SECRET").unwrap();

        // ── URL 발급: 세그먼트별 인코딩(슬래시가 살아야 상대 참조가 이웃이 된다) ──
        let url = register_html_preview(&proj.to_string_lossy(), "index.html");
        assert!(url.starts_with("http://ccg-page.localhost/"), "{url}");
        assert!(url.ends_with("/proj/index.html"), "세그먼트가 통째로 인코딩됐다: {url}");
        assert!(!url.contains("%5C") && !url.contains("%2F"), "구분자가 인코딩됐다: {url}");
        // 드라이브 문자의 ':'는 인코딩된다(2.6.2 encodeURIComponent와 같은 집합)
        assert!(url.contains("%3A"), "{url}");

        // ── 문서 본문 + 입력 브리지 ─────────────────────────────────────────
        let doc = page_response(&url, false).expect("문서는 서빙된다");
        assert_eq!(doc.mime, "text/html; charset=utf-8");
        let body = String::from_utf8_lossy(&doc.bytes).to_string();
        assert!(body.starts_with("<!doctype html>"));
        assert!(body.contains("ccgPageKey"), "HTML에 입력 브리지가 안 붙었다");
        assert!(body.contains("ccgPagePtr") && body.contains("ccgPageScroll"));
        assert!(!doc.last_modified.is_empty() && doc.last_modified.ends_with(" GMT"), "{}", doc.last_modified);

        // HEAD는 본문 없이 같은 헤더 (뷰어의 변경 감시 폴링)
        let head = page_response(&url, true).expect("HEAD도 200");
        assert!(head.bytes.is_empty());
        assert_eq!(head.last_modified, doc.last_modified);

        // ── 상대 참조가 URL 해석만으로 이웃이 된다 ──────────────────────────
        let css = url.replace("/index.html", "/assets/style.css");
        let got = page_response(&css, false).expect("같은 루트 안 CSS");
        assert_eq!(got.mime, "text/css; charset=utf-8");
        assert_eq!(got.bytes, b"p{color:red}");
        assert!(!String::from_utf8_lossy(&got.bytes).contains("ccgPageKey"), "HTML이 아닌데 브리지가 붙었다");
        // 이미지 표(IMG_MIME)를 재사용한다
        let png = url.replace("/index.html", "/assets/logo.png");
        assert_eq!(page_response(&png, false).expect("png").mime, "image/png");

        // ── 루트 밖은 404 ───────────────────────────────────────────────────
        let esc = url.replace("/index.html", "/../secret/secret.txt");
        assert!(page_response(&esc, false).is_none(), "`..` 탈출이 서빙됐다");
        assert!(
            page_response(&page_url(&outside.join("secret.txt")), false).is_none(),
            "루트 밖 절대 경로가 서빙됐다"
        );
        // 폴더 · 없는 파일
        assert!(page_response(&url.replace("/index.html", "/assets"), false).is_none());
        assert!(page_response(&url.replace("/index.html", "/nope.html"), false).is_none());

        // ── 쿼리는 경로가 아니다 (`?p=`로 화이트리스트를 우회할 수 없다) ────
        let hijack = format!("{}?p={}", css, enc(&outside.join("secret.txt").to_string_lossy()));
        let got = page_response(&hijack, false).expect("쿼리는 무시되고 CSS가 온다");
        assert_eq!(got.bytes, b"p{color:red}");
        assert!(page_path_from_uri(&format!("{url}#frag")).is_some());

        // ── 문서가 cwd 밖이면 루트는 그 문서의 폴더로 좁혀진다 (2.6.2 규칙) ──
        let u2 = register_html_preview(&proj.to_string_lossy(), &outside.join("page.html").to_string_lossy());
        std::fs::write(outside.join("page.html"), b"<html></html>").unwrap();
        assert!(page_response(&u2, false).is_some(), "문서 자신은 뜬다");
        // 그 폴더가 새 루트가 됐으므로 이웃 파일도 열린다(2.6.2 동일) — 프로젝트 루트는 여전히 산다
        assert!(page_response(&css, false).is_some(), "앞서 등록한 루트가 죽었다");

        // ── 루트 수 상한 ────────────────────────────────────────────────────
        for i in 0..MAX_PAGE_ROOTS + 2 {
            let d = base.join(format!("r{i}"));
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("a.html"), b"x").unwrap();
            register_html_preview(&d.to_string_lossy(), "a.html");
        }
        assert_eq!(page_roots().lock().unwrap().len(), MAX_PAGE_ROOTS);
        assert!(page_response(&css, false).is_none(), "밀려난 루트가 아직 열려 있다");

        let _ = std::fs::remove_dir_all(&base);
    }

    /// `Last-Modified`는 JS `Date#toUTCString()`과 같은 문자열이어야 한다.
    #[test]
    fn http_date_matches_js_to_utc_string() {
        let at = |s: u64| http_date(std::time::UNIX_EPOCH + std::time::Duration::from_secs(s));
        // node -e "console.log(new Date(0).toUTCString())" → Thu, 01 Jan 1970 00:00:00 GMT
        assert_eq!(at(0), "Thu, 01 Jan 1970 00:00:00 GMT");
        assert_eq!(at(1_445_412_480), "Wed, 21 Oct 2015 07:28:00 GMT");
        assert_eq!(at(951_782_400), "Tue, 29 Feb 2000 00:00:00 GMT"); // 400년 윤년
        assert_eq!(at(1_078_012_800), "Sun, 29 Feb 2004 00:00:00 GMT");
        assert_eq!(at(1_756_000_000), "Sun, 24 Aug 2025 01:46:40 GMT");
    }
}
