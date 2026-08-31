//! 시맨틱 토큰 디스크 캐시 — "켤 때마다 0에서 다시 분석"을 없애는 조각.
//!
//! 2.6.2 `src/main/lsp/semcache.ts`의 이식이고, **레이아웃·키·해시가 전부 같다** —
//! 즉 2.6.2로 쌓아 둔 캐시를 3.0이 그대로 적중시킨다(업그레이드 첫 실행부터 즉시 색칠).
//!
//! ```text
//! <앱 홈>/lsp/semcache/
//!   <프로젝트 basename>-<cwd sha1 16자>/   ← 프로젝트 버킷
//!     .root                                 ← 원본 cwd(죽은 프로젝트 GC용)
//!     7e/7efc….json                         ← 파일 키(앞 2글자 샤딩)
//! ```
//!
//! 파일 키 = `sha1("v<CACHE_VERSION>\0<serverId>\0<abs소문자>\0" + 내용)`.
//! 내용이 바뀌면 키가 바뀌어 자동 미스 — 무효화 로직이 따로 없다는 게 이 설계의 요점이다.

use crate::sha1::sha1_hex;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// 토큰 직렬화 형태가 바뀌면 올려 옛 캐시를 버린다. **2.6.2와 같은 값이어야 캐시를 공유한다.**
pub const CACHE_VERSION: u32 = 1;
/// 디스크에 남기는 최대 파일 수(전 프로젝트 합산) — 넘으면 오래된 것부터 20%를 정리.
const MAX_FILES: usize = 4000;
const MISC_BUCKET: &str = "_misc";

/// 렌더러 계약면(`LspSemanticTokens`)과 같은 모양 — 그대로 직렬화해 캐시에 넣는다.
#[derive(Clone, Serialize, Deserialize, Debug, Default)]
pub struct SemanticTokens {
    /// 절대 좌표 5튜플 — line, character, length, typeIndex, modifierBits
    pub data: Vec<u32>,
    pub types: Vec<String>,
    pub mods: Vec<String>,
}

/// 테스트가 캐시 뿌리를 갈아 끼우는 문. **환경 변수를 안 쓴다** — `set_var`는 스레드가
/// 도는 테스트 바이너리에서 안전하지 않고, 실수하면 단위 테스트가 사용자 앱 홈에 쓴다.
#[cfg(test)]
static TEST_DIR: std::sync::OnceLock<std::sync::Mutex<Option<PathBuf>>> = std::sync::OnceLock::new();

fn dir() -> PathBuf {
    #[cfg(test)]
    if let Some(p) = TEST_DIR.get_or_init(Default::default).lock().unwrap().clone() {
        return p;
    }
    ccg_store::app_home().join("lsp").join("semcache")
}

fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

fn bucket_dir(cwd: &str) -> PathBuf {
    if cwd.is_empty() {
        return dir().join(MISC_BUCKET);
    }
    let root = normalize(cwd);
    let hash = &sha1_hex(&[root.to_lowercase().as_bytes()])[..16];
    let base = Path::new(&root)
        .file_name()
        .and_then(|s| s.to_str())
        .map(sanitize)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "root".into());
    dir().join(format!("{base}-{hash}"))
}

/// Node의 `path.resolve()`와 같은 정규화(구분자 통일 + `.`/`..` 접기). 절대 경로 전제.
fn normalize(p: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut prefix = String::new();
    let s = p.replace('/', "\\");
    let mut rest = s.as_str();
    if s.len() >= 2 && s.as_bytes()[1] == b':' {
        prefix = s[..2].to_string();
        rest = &s[2..];
    }
    for part in rest.split('\\') {
        match part {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            other => out.push(other.to_string()),
        }
    }
    format!("{prefix}\\{}", out.join("\\"))
}

/// 파일 키 — `sha1("v<전역세대>\0<serverId[세대]>\0<abs소문자>\0" + 내용)`.
///
/// **스펙 세대(`cache_version`)가 1이면 2.6.2와 바이트가 같다.** 2보다 크면 serverId 자리에
/// 세대를 붙여(`ts` → `ts2`) 그 서버의 옛 캐시만 통째로 버린다 — 전역 `CACHE_VERSION`을
/// 올리면 **모든** 언어의 캐시와 2.6.2 호환이 함께 깨지기 때문이다.
///
/// R1은 이 인자를 `debug_assert_eq!`로만 봤다 — 릴리스에선 조용히 무시, 디버그에선 패닉.
/// 즉 "세대 레버"라고 적어 둔 필드가 실제로는 **아무것도 안 하는 함정**이었다(크리틱 C-7).
fn key_for(cache_version: u32, server_id: &str, abs: &str, content: &str) -> String {
    let id = if cache_version <= 1 { server_id.to_string() } else { format!("{server_id}{cache_version}") };
    let head = format!("v{CACHE_VERSION}\0{id}\0{}\0", abs.to_lowercase());
    sha1_hex(&[head.as_bytes(), content.as_bytes()])
}

fn file_for(cwd: &str, key: &str) -> PathBuf {
    bucket_dir(cwd).join(&key[..2]).join(format!("{key}.json"))
}

/// 캐시된 토큰 — 없거나 깨졌으면 `None`. **서버를 띄우지 않는다.**
///
/// 깨진 파일은 **그 자리에서 지운다**(§R3-9 ⑥). 키가 내용 해시라 같은 파일을 다시 열면
/// 같은 키로 오고, 안 지우면 그 문서는 앱을 지울 때까지 영원히 캐시 미스다(0ms 색칠 상실).
/// 깨질 수 있는 이유: 쓰는 도중의 강제 종료·디스크 꽉 참·바이러스 검사기의 절단.
pub fn get(cwd: &str, cache_version: u32, server_id: &str, abs: &str, content: &str) -> Option<SemanticTokens> {
    let f = file_for(cwd, &key_for(cache_version, server_id, abs, content));
    let raw = fs::read_to_string(&f).ok()?;
    match serde_json::from_str::<SemanticTokens>(&raw) {
        Ok(t) => Some(t),
        Err(_) => {
            let _ = fs::remove_file(&f);
            None
        }
    }
}

/// 라이브 토큰을 캐시에 기록(베스트에포트 — 실패해도 무시).
pub fn put(cwd: &str, cache_version: u32, server_id: &str, abs: &str, content: &str, tokens: &SemanticTokens) {
    let f = file_for(cwd, &key_for(cache_version, server_id, abs, content));
    let Some(parent) = f.parent() else { return };
    if fs::create_dir_all(parent).is_err() {
        return;
    }
    ensure_root_marker(cwd);
    let Ok(json) = serde_json::to_vec(tokens) else { return };
    // **쓰고-바꾸기**(§R3-9 ⑥). 직접 `fs::write`를 하면 30,000토큰짜리 파일을 쓰는 도중
    // 앱이 죽었을 때 반쪽 JSON이 남고, 그 문서는 이후 영원히 캐시 미스가 된다.
    // 같은 볼륨의 rename은 Windows에서도 원자적이다(`ccg_store::write_atomic`과 같은 의미론).
    // 임시 이름에 pid를 넣어 두 프로세스(격리 홈 벤치·본앱)가 같은 자리를 안 밟게 한다.
    let tmp = f.with_extension(format!("{}.tmp", std::process::id()));
    if fs::write(&tmp, json).is_ok() && fs::rename(&tmp, &f).is_err() {
        let _ = fs::remove_file(&tmp);
    }
    // 가끔만 정리 — 매 쓰기마다 전체 스캔하지 않게(2.6.2는 3% 확률. 여기는 결정적으로
    // "파일 크기의 하위 비트"를 써서 같은 빈도를 흉내낸다 — 난수 의존을 없애 테스트 가능).
    if tokens.data.len() % 32 == 0 {
        prune();
    }
}

fn ensure_root_marker(cwd: &str) {
    if cwd.is_empty() {
        return;
    }
    let p = bucket_dir(cwd).join(".root");
    if !p.exists() {
        let _ = fs::write(p, normalize(cwd));
    }
}

/// 원본 폴더가 사라진 프로젝트 버킷을 통째로 지운다(프로젝트를 열 때 1회).
pub fn gc_dead_buckets() {
    let Ok(rd) = fs::read_dir(dir()) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_dir() || p.file_name().and_then(|s| s.to_str()) == Some(MISC_BUCKET) {
            continue;
        }
        // 마커 없는(옛/외부) 버킷은 건드리지 않는다
        let Ok(root) = fs::read_to_string(p.join(".root")) else { continue };
        if !Path::new(root.trim()).exists() {
            let _ = fs::remove_dir_all(&p);
        }
    }
}

/// 전체 파일 수가 상한을 넘으면 mtime 오래된 것부터 20%를 지운다.
fn prune() {
    let mut files: Vec<(PathBuf, std::time::SystemTime)> = Vec::new();
    let Ok(buckets) = fs::read_dir(dir()) else { return };
    for b in buckets.flatten() {
        let Ok(shards) = fs::read_dir(b.path()) else { continue };
        for s in shards.flatten() {
            if !s.path().is_dir() {
                continue;
            }
            let Ok(names) = fs::read_dir(s.path()) else { continue };
            for n in names.flatten() {
                if let Ok(md) = n.metadata() {
                    if md.is_file() {
                        files.push((n.path(), md.modified().unwrap_or(std::time::UNIX_EPOCH)));
                    }
                }
            }
        }
    }
    if files.len() <= MAX_FILES {
        return;
    }
    files.sort_by_key(|(_, t)| *t);
    let drop = files.len() / 5 + 1;
    for (p, _) in files.into_iter().take(drop) {
        let _ = fs::remove_file(p);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_like_node_path_resolve() {
        assert_eq!(normalize("C:\\a\\b\\..\\c"), "C:\\a\\c");
        assert_eq!(normalize("C:/a/./b/"), "C:\\a\\b");
    }

    #[test]
    fn bucket_name_is_basename_plus_16_hex() {
        let b = bucket_dir("C:\\Code\\AgentCodeGUI");
        let name = b.file_name().unwrap().to_str().unwrap();
        assert!(name.starts_with("AgentCodeGUI-"), "{name}");
        assert_eq!(name.len(), "AgentCodeGUI-".len() + 16, "{name}");
    }

    #[test]
    fn key_changes_with_content_and_path() {
        let a = key_for(1, "ts", "C:\\x.ts", "hello");
        let b = key_for(1, "ts", "C:\\x.ts", "hello!");
        let c = key_for(1, "ts", "C:\\y.ts", "hello");
        assert_ne!(a, b);
        assert_ne!(a, c);
        assert_eq!(a.len(), 40);
    }

    /// 2.6.2가 만드는 키와 **같은 값**인가 — semcache.ts의 keyFor를 그대로 옮긴 계산.
    /// (`v1\0ts\0c:\x.ts\0` + 내용을 sha1)
    #[test]
    fn key_matches_262_formula() {
        let expect = crate::sha1::sha1_hex(&[b"v1\0ts\0c:\\x.ts\0", b"hello"]);
        assert_eq!(key_for(1, "ts", "C:\\X.ts", "hello"), expect);
    }

    /// 쓰기는 **원자적**이고, 깨진 파일은 읽는 쪽이 지운다(§R3-9 ⑥).
    /// 안 지우면 그 문서는 앱을 지울 때까지 영원히 캐시 미스다 — 키가 내용 해시라
    /// 같은 파일을 다시 열면 늘 같은(깨진) 파일로 온다.
    #[test]
    fn write_is_atomic_and_a_corrupt_entry_heals_itself() {
        let base = std::env::temp_dir().join("ccg-lsp-semcache-test");
        let _ = fs::remove_dir_all(&base);
        *TEST_DIR.get_or_init(Default::default).lock().unwrap() = Some(base.clone());
        // ★LSPIDLE R2 — cwd는 **실재하는 폴더**여야 한다.
        //
        // 옛 값은 `C:\proj`(없는 폴더)였고, 그래서 같은 프로세스의 다른 테스트가 부른
        // `gc_dead_buckets`(「원본 폴더가 사라진 프로젝트의 캐시를 회수」)가 이 버킷을
        // **죽은 것으로 보고 지웠다** — 이 테스트가 방금 쓴 파일이 그 사이에 사라져
        // 드물게 붉어졌다(R1의 `prewarm` 못이 백그라운드로 gc를 돌리면서 드러났다).
        // 폴더를 실재하게 만들면 gc의 판정 자체가 이 버킷을 안 건드린다.
        let proj = std::env::temp_dir().join("ccg-lsp-semcache-proj");
        fs::create_dir_all(&proj).unwrap();
        let cwd_s = proj.to_string_lossy().to_string();
        let abs_s = proj.join("a.ts").to_string_lossy().to_string();
        let (cwd, abs, body) = (cwd_s.as_str(), abs_s.as_str(), "const x = 1");
        let t = SemanticTokens { data: vec![0, 1, 2, 3, 4], types: vec!["variable".into()], mods: vec![] };
        put(cwd, 1, "ts", abs, body, &t);
        assert_eq!(get(cwd, 1, "ts", abs, body).map(|v| v.data), Some(t.data.clone()));
        // 임시 파일이 남지 않는다(남으면 prune이 세고, 손상 파일로 오해될 수 있다)
        let f = file_for(cwd, &key_for(1, "ts", abs, body));
        let shard = f.parent().unwrap();
        let leftovers: Vec<_> = fs::read_dir(shard)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
        // 반쯤 쓰인 파일을 흉내 낸다 → 읽기가 None이고 **그 파일이 사라진다**
        fs::write(&f, "{\"data\":[0,1,2").unwrap();
        assert!(get(cwd, 1, "ts", abs, body).is_none());
        assert!(!f.exists(), "손상 파일을 안 지우면 영원히 캐시 미스다");
        // 세대를 올리면 미스(같은 내용이어도) — 다른 파일 이름이다
        put(cwd, 1, "ts", abs, body, &t);
        assert!(get(cwd, 2, "ts", abs, body).is_none());
        *TEST_DIR.get_or_init(Default::default).lock().unwrap() = None;
        let _ = fs::remove_dir_all(&base);
    }

    /// 스펙 세대를 올리면 **그 서버의** 캐시만 미스가 된다(2.6.2 호환은 세대 1에서 유지).
    /// R1은 이 인자가 릴리스에서 무시되고 디버그에서 패닉했다(크리틱 C-7).
    #[test]
    fn spec_cache_version_is_a_real_generation_lever() {
        let v1 = key_for(1, "ts", "C:\\x.ts", "hello");
        let v2 = key_for(2, "ts", "C:\\x.ts", "hello");
        assert_ne!(v1, v2, "세대를 올려도 키가 같으면 옛 캐시를 못 버린다");
        // 다른 서버의 캐시는 안 건드린다
        assert_eq!(key_for(1, "py", "C:\\x.py", "hello"), key_for(1, "py", "C:\\x.py", "hello"));
        assert_ne!(key_for(2, "ts", "C:\\x.ts", "hello"), key_for(2, "py", "C:\\x.ts", "hello"));
    }
}
