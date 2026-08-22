//! 로컬 이미지 서빙(`ccg-img`) — 2.6.2 `src/main/index.ts`의 `protocol.handle('ccg-img')` 이식.
//!
//! 렌더러는 자기 오리진에서 `file://`을 못 읽는다(webSecurity). 그래서 첨부 이미지와
//! 뷰어의 이미지/SVG 보기는 전용 스킴으로 바이트를 받아 간다. 서빙 대상은 **확장자가
//! 이미지인 실제 파일** 하나뿐이고, 그 밖(디렉터리·비이미지·없는 경로)은 404다.
//!
//! ── 노출 범위 ────────────────────────────────────────────────────────────────
//! 경로 제한을 두지 않는 것은 2.6.2와 같다. 같은 렌더러가 `fs:read-file`로 이미 임의
//! 절대 경로를 읽을 수 있고(채팅의 bash 테일 미리보기가 그 경로로 돈다), 이미지 확장자
//! 파일만 image/* 로 내보내는 건 새 권한이 아니다. 여기서 범위를 좁히면 "참고 폴더의
//! 스크린샷"처럼 프로젝트 밖 이미지를 여는 실사용이 깨진다.

use std::path::Path;

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
}
