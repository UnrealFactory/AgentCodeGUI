//! 붙여넣기·브라우저 드래그 첨부 저장 — 2.6.2 `src/main/index.ts`의
//! `ipcMain.handle(IPC.saveAttachmentData, …)` + `attachmentsDir()` 이식.
//!
//! OS 탐색기에서 끌어 온 파일은 디스크에 **자기 경로가 있다**(`pathForFile`). 하지만
//! 클립보드에서 붙여넣은 스크린샷과 브라우저에서 끌어 온 이미지는 경로가 없고 바이트만
//! 있다. 컴포저의 첨부 트레이·라이트박스·엔진 전달은 전부 **경로**로 도는 구조라
//! (`app/src/lib/images.ts` `filesToAttachmentPaths`), 그 바이트를 앱 홈 아래 임시 파일로
//! 떨어뜨려 경로를 만들어 준다.
//!
//! 폴더는 2.6.2와 같은 자리다: `<앱 홈>/attachments`
//! (= 기본 `~/.agentcodegui/attachments`, `CCG_HOME`이면 그 아래 — 벤치·dev 격리 홈이
//! 사용자 실홈에 파일을 흘리지 않는다).

use std::path::PathBuf;

/// 저장 허용 확장자 — `src/shared/attachments.ts`의 `ATTACH_IMAGE_EXTS` +
/// `ATTACH_TEXT_EXTS`와 **같은 목록**이다(2.6.2 `ATTACH_SAVE_EXTS`). 목록 밖이면
/// 2.6.2와 같이 `.png`로 떨어뜨린다(거절이 아니다 — 확장자를 못 알아낸 붙여넣기가
/// 실사용의 다수라 여기서 막으면 스크린샷 붙여넣기가 통째로 죽는다).
const SAVE_EXTS: &[&str] = &[
    // 이미지
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico",
    // 문서
    "txt", "md", "markdown", "html", "htm",
    // 데이터·설정
    "json", "jsonc", "json5", "csv", "tsv", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "properties", "log",
    // 코드
    "js", "mjs", "cjs", "jsx", "ts", "tsx", "css", "scss", "less", "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "cs",
    "java", "kt", "rs", "go", "swift", "php", "rb", "lua", "py", "sql", "sh", "bash", "bat", "cmd", "ps1",
    // 언리얼·기타
    "verse", "uproject", "uplugin", "patch", "diff",
];

/// 한 첨부의 상한. 2.6.2에는 없던 캡이다 — 렌더러가 IPC 한 번으로 임의 크기 바이트를
/// 프로세스 메모리에 올린 뒤 디스크에 쓰는 자리라, 첨부로 쓸 규모를 한참 넘는 지점에서
/// 끊는다(넘으면 빈 문자열 → 호출부가 그 파일만 조용히 건너뛴다).
pub const MAX_ATTACH_BYTES: usize = 64 * 1024 * 1024;

/// 2.6.2와 같은 정규화:
/// `('.' + ext.replace(/^\.+/, '').toLowerCase()).replace(/[^.a-z0-9]/g, '')`
/// → 허용 목록에 있으면 그대로, 없으면 `png`.
fn safe_ext(ext: &str) -> &'static str {
    let cleaned: String = ext
        .trim_start_matches('.')
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        .collect();
    SAVE_EXTS.iter().copied().find(|e| *e == cleaned).unwrap_or("png")
}

/// `<앱 홈>/attachments` — 없으면 만든다.
pub fn attachments_dir() -> PathBuf {
    let dir = ccg_store::app_home().join("attachments");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// 바이트를 임시 파일로 떨어뜨리고 **절대 경로**를 돌려준다. 실패하면 빈 문자열
/// (심이 그걸 보고 throw → `filesToAttachmentPaths`가 그 파일 하나만 건너뛴다).
pub fn save_attachment_data(bytes: &[u8], ext: &str) -> String {
    save_into(&attachments_dir(), bytes, ext)
}

/// 폴더를 밖에서 받는 갈래 — 테스트가 **사용자 실홈을 안 건드리게** 하려고 갈랐다
/// (`CCG_HOME`을 테스트에서 바꾸면 같은 프로세스의 다른 테스트가 그 값을 본다).
fn save_into(dir: &std::path::Path, bytes: &[u8], ext: &str) -> String {
    if bytes.len() > MAX_ATTACH_BYTES {
        return String::new();
    }
    let ext = safe_ext(ext);
    // 2.6.2는 `paste-${randomUUID()}`. std에 난수가 없어 같은 성질(충돌 없는 유일 이름)을
    // 시각·PID·프로세스 카운터·해시 시드로 만든다. 그래도 이름이 겹치면 다시 뽑는다.
    for _ in 0..8 {
        let p = dir.join(format!("paste-{}.{ext}", unique_stem()));
        if p.exists() {
            continue;
        }
        // create_new: 같은 이름을 두 창이 동시에 집었을 때 하나가 진다(덮어쓰기 없음)
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&p) {
            Ok(mut f) => {
                use std::io::Write;
                if f.write_all(bytes).is_err() || f.flush().is_err() {
                    let _ = std::fs::remove_file(&p);
                    return String::new();
                }
                return p.to_string_lossy().into_owned();
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return String::new(),
        }
    }
    String::new()
}

/// base64 → 바이트. 와이어(렌더러 심)가 보내는 모양을 그대로 받는다.
///
/// 표준 알파벳 + `=` 패딩. 알파벳 밖 문자(줄바꿈 등)는 건너뛴다 — 잘린/망가진 입력은
/// 거기까지의 바이트만 낸다(빈 결과가 되면 호출부가 그 첨부를 건너뛴다). 의존 크레이트를
/// 하나 늘리는 것보다 20줄이 싸다.
pub fn decode_b64(s: &str) -> Vec<u8> {
    let val = |c: u8| -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    };
    let mut out = Vec::with_capacity(s.len() / 4 * 3 + 3);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in s.bytes() {
        let Some(v) = val(c) else { continue };
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    out
}

/// 32자리 hex. `RandomState`(OS 시드)·나노초·PID·프로세스 내 카운터를 섞는다.
fn unique_stem() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let n = N.fetch_add(1, Ordering::Relaxed);
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let mix = |salt: u64| {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(t ^ salt);
        h.write_u64(n);
        h.write_u32(std::process::id());
        h.finish()
    };
    format!("{:016x}{:016x}", mix(0), mix(0x9e37_79b9_7f4a_7c15))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_is_normalized_like_262() {
        assert_eq!(safe_ext("png"), "png");
        assert_eq!(safe_ext(".JPG"), "jpg");
        assert_eq!(safe_ext("...Webp"), "webp");
        assert_eq!(safe_ext("sv g"), "svg"); // 허용 문자 밖은 탈락
        assert_eq!(safe_ext("md"), "md");
        assert_eq!(safe_ext("ps1"), "ps1");
        // 목록 밖 · 경로 주입 시도 · 빈 값 → 전부 png
        assert_eq!(safe_ext("exe"), "png");
        assert_eq!(safe_ext("../../evil"), "png");
        assert_eq!(safe_ext("png/../../../a"), "png"); // 슬래시·점이 사라져 "pnga"
        assert_eq!(safe_ext(""), "png");
        assert_eq!(safe_ext("png\0"), "png");
    }

    #[test]
    fn bytes_land_in_the_folder_and_names_never_collide() {
        let dir = std::env::temp_dir().join(format!("ccg-attach-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let p = save_into(&dir, b"\x89PNG\r\n\x1a\n", "PNG");
        assert!(!p.is_empty(), "저장이 실패했다");
        let p = PathBuf::from(&p);
        assert_eq!(std::fs::read(&p).unwrap(), b"\x89PNG\r\n\x1a\n");
        assert_eq!(p.parent().unwrap(), dir);
        assert!(p.file_name().unwrap().to_string_lossy().starts_with("paste-"));
        assert_eq!(p.extension().unwrap(), "png");

        // 같은 호출을 반복해도 서로 안 덮어쓴다
        let mut names = std::collections::HashSet::new();
        for _ in 0..200 {
            names.insert(save_into(&dir, b"x", "txt"));
        }
        assert_eq!(names.len(), 200, "이름이 겹쳤다");
        assert!(names.iter().all(|n| n.ends_with(".txt")));

        // 상한 초과는 빈 문자열(파일도 안 남는다)
        let before = std::fs::read_dir(&dir).unwrap().count();
        assert_eq!(save_into(&dir, &vec![0u8; MAX_ATTACH_BYTES + 1], "png"), "");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), before);

        // 폴더가 없으면 실패해도 조용하다(빈 문자열 — 호출부가 그 첨부만 건너뛴다)
        assert_eq!(save_into(&dir.join("nope").join("deeper"), b"x", "png"), "");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn base64_round_trips_the_wire_shape() {
        // node -e "console.log(Buffer.from('…').toString('base64'))"
        assert_eq!(decode_b64("aGVsbG8="), b"hello");
        assert_eq!(decode_b64("aGVsbG8h"), b"hello!");
        assert_eq!(decode_b64("YQ=="), b"a");
        assert_eq!(decode_b64(""), b"");
        // 1x1 투명 PNG(벤치 드롭이 쓰는 바로 그 바이트) — 시그니처가 살아야 한다
        let png = decode_b64(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        );
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(png.len(), 70);
        // 줄바꿈·공백이 섞여도 같은 바이트
        assert_eq!(decode_b64("aGVs\nbG8="), b"hello");
        // 8비트 전 범위
        let all: Vec<u8> = (0u8..=255).collect();
        assert_eq!(decode_b64(&encode_b64(&all)), all);
    }

    /// 테스트 전용 인코더(디코더의 거울) — 프로덕션 경로에는 인코딩이 없다(렌더러 몫).
    fn encode_b64(b: &[u8]) -> String {
        const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for c in b.chunks(3) {
            let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
            out.push(A[(n >> 18) as usize & 63] as char);
            out.push(A[(n >> 12) as usize & 63] as char);
            out.push(if c.len() > 1 { A[(n >> 6) as usize & 63] as char } else { '=' });
            out.push(if c.len() > 2 { A[n as usize & 63] as char } else { '=' });
        }
        out
    }

    /// 앱 홈 아래여야 한다 — 실홈을 만들지 않으려고 `CCG_HOME`을 준 자식 프로세스가
    /// 아니라 **경로 계산만** 본다(`attachments_dir`은 폴더를 만들므로 부르지 않는다).
    #[test]
    fn the_folder_is_under_the_app_home() {
        let home = ccg_store::app_home();
        assert!(home.ends_with(".agentcodegui3") || std::env::var("CCG_HOME").is_ok());
        assert_eq!(home.join("attachments").file_name().unwrap(), "attachments");
    }
}
