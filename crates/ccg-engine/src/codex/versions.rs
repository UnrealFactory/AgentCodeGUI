//! Codex CLI **버전 관리** — 2.6.2 `src/main/codex/versions.ts` 이식.
//!
//! 앱 홈에 버전별로 `npm install @openai/codex`를 깔고 그 실행본으로 돈다. 시스템 전역
//! `codex`는 건드리지 않는다(설치본이 없을 때만 PATH 폴백 — Claude와 다른 점은 "번들이
//! 없다"는 것 하나다).
//!
//! ```text
//!  ~/.agentcodegui/codex-engines/<version>/node_modules/@openai/codex/package.json  ← 설치 판정
//!  ~/.agentcodegui/codex-engines/<version>/node_modules/.bin/codex.cmd              ← 실행 파일
//!  ~/.agentcodegui/codex-config.json  { "activeVersion": "0.149.0" }                ← 활성 버전
//! ```
//!
//! ★T2 — **알맹이는 [`crate::versions`]로 옮겼다.** 목록·설치·제거·활성·정리는 Claude
//! 엔진과 규칙이 한 글자도 다르지 않아서(2.6.2도 같은 파일 두 벌이었다) 한 벌로 합쳤고,
//! 여기 남은 것은 codex 고유의 두 가지뿐이다: **경로 상수([`SPEC`])**와 **실행 바이너리
//! 고르기([`codex_bin`])**. 그 둘은 진짜로 다르다 — codex는 플랫폼 패키지 안에 네이티브
//! 실행본이 따로 들어 있다.
//!
//! (레지스트리를 `npm view`로 읽는 설계 결정은 [`crate::versions`] 헤더에 있다.)

use crate::versions::{Spec, CODEX as SPEC};
use std::path::{Path, PathBuf};

pub use crate::versions::{cmp_desc, parse_packument, Available, Cleanup, VersionEntry};

pub const PACKAGE: &str = SPEC.package;

pub fn spec() -> Spec {
    SPEC
}

pub fn engines_dir(home: &Path) -> PathBuf {
    SPEC.engines_dir(home)
}
pub fn config_path(home: &Path) -> PathBuf {
    SPEC.config_path(home)
}
pub fn installed_version_at(home: &Path, version: &str) -> Option<String> {
    SPEC.installed_version_at(home, version)
}
pub fn list_installed(home: &Path) -> Vec<String> {
    SPEC.list_installed(home)
}
pub fn active_version(home: &Path) -> Option<String> {
    SPEC.active_version(home)
}
pub fn set_active(home: &Path, version: Option<&str>) -> Result<(), String> {
    SPEC.set_active(home, version)
}
pub fn list_available() -> Result<Available, String> {
    SPEC.list_available()
}
pub fn install(home: &Path, version: &str, on_line: impl FnMut(&str)) -> Result<(), String> {
    SPEC.install(home, version, on_line)
}
pub fn uninstall(home: &Path, version: &str) -> Result<(), String> {
    SPEC.uninstall(home, version)
}
pub fn cleanup_old(home: &Path) -> Cleanup {
    SPEC.cleanup_old(home)
}

/// 실행에 쓸 codex 바이너리 — 활성 설치본의 **네이티브 실행본**이 1순위.
///
/// ## 왜 `.bin/codex.cmd`가 아닌가 (실측으로 갈린 자리)
///
/// npm이 깔아 주는 `.bin/codex.cmd`는 **셸 shim**이다: `cmd → node → codex.exe` 세 겹.
/// 2.6.2는 Electron에서 `shell: true`로 그걸 그대로 띄웠지만, 3.0에서 같은 짓을 하면
/// 값이 셋 나빠진다 —
///  ① 인용 지옥: `cmd /C ""<경로>" app-server"`는 Rust/Node의 인자 이스케이프와 겹쳐
///     경로에 공백이 있으면 깨진다(M4에서 실제로 밟았다 — `poc-codex --only=handshake`가
///     `'"...codex.cmd"'은(는) 내부 또는 외부 명령이 아닙니다`로 죽었다),
///  ② 프로세스가 3개라 job object·pid 추적이 흐려지고,
///  ③ node.js 런타임이 하나 더 뜬다(메모리).
///
/// 설치본 안에는 플랫폼 패키지의 실물이 있다:
/// `node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe`.
/// 트리플 이름을 박아 두지 않고 **훑어서** 찾는다(새 트리플이 생겨도 산다).
///
/// 폴백 순서: 네이티브 → `.bin` shim → 전역 `codex`(PATH).
pub fn codex_bin(home: &Path) -> PathBuf {
    if let Some(v) = active_version(home) {
        let root = engines_dir(home).join(&v).join("node_modules").join("@openai");
        if let Some(p) = native_exe(&root) {
            return p;
        }
        let shim = if cfg!(windows) { "codex.cmd" } else { "codex" };
        let p = engines_dir(home).join(&v).join("node_modules").join(".bin").join(shim);
        if p.exists() {
            return p;
        }
    }
    PathBuf::from("codex")
}

/// `@openai/codex-<plat>/vendor/<triple>/bin/codex[.exe]` 훑기.
fn native_exe(openai_dir: &Path) -> Option<PathBuf> {
    let exe = if cfg!(windows) { "codex.exe" } else { "codex" };
    let rd = std::fs::read_dir(openai_dir).ok()?;
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        // `codex` 자신(런처 패키지)에는 vendor가 없다 — 플랫폼 패키지만 본다.
        if !name.starts_with("codex-") {
            continue;
        }
        let vendor = e.path().join("vendor");
        let Ok(triples) = std::fs::read_dir(&vendor) else { continue };
        for t in triples.flatten() {
            let cand = t.path().join("bin").join(exe);
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("ccg-codex-ver-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn fake_install(home: &Path, v: &str) {
        let d = SPEC.package_dir(home, v);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("package.json"), format!("{{\"version\":\"{v}\"}}")).unwrap();
    }

    #[test]
    fn installed_list_is_newest_first_and_ignores_empty_folders() {
        let home = tmp("list");
        fake_install(&home, "0.149.0");
        fake_install(&home, "0.9.0");
        std::fs::create_dir_all(engines_dir(&home).join("0.200.0")).unwrap(); // 껍데기
        assert_eq!(list_installed(&home), vec!["0.149.0", "0.9.0"]);
        assert_eq!(active_version(&home), None);
        assert!(set_active(&home, Some("0.200.0")).is_err(), "설치 안 된 버전은 거절");
        set_active(&home, Some("0.9.0")).unwrap();
        assert_eq!(active_version(&home).as_deref(), Some("0.9.0"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn codex_bin_falls_back_to_path_when_nothing_is_installed() {
        let home = tmp("bin");
        assert_eq!(codex_bin(&home), PathBuf::from("codex"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn packument_parses_both_npm_view_and_registry_shapes() {
        // `npm view --json`(배열) — 실제 산출 모양
        let a = parse_packument(&json!({
            "dist-tags": { "latest": "0.149.0" },
            "versions": ["0.9.0", "0.149.0", "0.150.0", "0.151.0-alpha.1"],
            "time": { "0.149.0": "2026-08-01T00:00:00.000Z" }
        }));
        assert_eq!(a.latest.as_deref(), Some("0.149.0"));
        // 내림차순 · 프리릴리즈 제외
        assert_eq!(
            a.versions.iter().map(|v| v.version.as_str()).collect::<Vec<_>>(),
            vec!["0.150.0", "0.149.0", "0.9.0"]
        );
        assert!(a.versions[1].latest);
        assert_eq!(a.versions[1].date.as_deref(), Some("2026-08-01T00:00:00.000Z"));
        // latest보다 높은 0.150.0 = 프리뷰 (2.6.2와 **같은 판정 방향**)
        assert!(a.versions[0].preview);
        assert!(!a.versions[2].preview);

        // 레지스트리 원본(객체)도 같은 결과
        let b = parse_packument(&json!({
            "dist-tags": { "latest": "0.149.0" },
            "versions": { "0.9.0": {}, "0.149.0": {} },
            "time": {}
        }));
        assert_eq!(b.versions.len(), 2);
    }

    #[test]
    fn cleanup_keeps_only_the_newest_and_moves_the_active_flag() {
        let home = tmp("cleanup");
        fake_install(&home, "0.149.0");
        fake_install(&home, "0.148.0");
        set_active(&home, Some("0.148.0")).unwrap();
        let c = cleanup_old(&home);
        assert_eq!(c.kept.as_deref(), Some("0.149.0"));
        assert_eq!(c.removed, vec!["0.148.0"]);
        assert!(c.active_switched);
        assert_eq!(active_version(&home).as_deref(), Some("0.149.0"));
        let _ = std::fs::remove_dir_all(&home);
    }
}
