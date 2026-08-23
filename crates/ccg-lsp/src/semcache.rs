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

fn dir() -> PathBuf {
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

fn key_for(cache_version: u32, server_id: &str, abs: &str, content: &str) -> String {
    let head = format!("v{CACHE_VERSION}\0{server_id}\0{}\0", abs.to_lowercase());
    // 스펙별 세대는 serverId 뒤에 붙이지 않는다 — 2.6.2와 키가 어긋나면 캐시 공유가 깨진다.
    // 스펙 세대를 올리고 싶으면 spec.cache_version을 CACHE_VERSION과 함께 쓰는 별도 접두를
    // 붙이는 대신 serverId를 바꾸는 게 맞다(예: "ts2"). 지금은 두 값이 모두 1이라 동치.
    debug_assert_eq!(cache_version, CACHE_VERSION);
    sha1_hex(&[head.as_bytes(), content.as_bytes()])
}

fn file_for(cwd: &str, key: &str) -> PathBuf {
    bucket_dir(cwd).join(&key[..2]).join(format!("{key}.json"))
}

/// 캐시된 토큰 — 없거나 깨졌으면 `None`. **서버를 띄우지 않는다.**
pub fn get(cwd: &str, cache_version: u32, server_id: &str, abs: &str, content: &str) -> Option<SemanticTokens> {
    let f = file_for(cwd, &key_for(cache_version, server_id, abs, content));
    let raw = fs::read_to_string(f).ok()?;
    serde_json::from_str::<SemanticTokens>(&raw).ok()
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
    let _ = fs::write(&f, json);
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
}
