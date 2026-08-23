//! Codex CLI **버전 관리**의 Rust 몫 — 2.6.2 `src/main/codex/versions.ts` 이식.
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
//! ## 레지스트리 조회를 `npm view`로 하는 이유 (설계 결정)
//!
//! 2.6.2는 `fetch('https://registry.npmjs.org/@openai/codex')`를 썼다. 3.0 Rust에는
//! **HTTP 클라이언트 의존성이 없다** — 이 환경은 오프라인 빌드라 크레이트를 새로 못
//! 받는다(`ccg-engine/Cargo.toml` 헤더의 blake3 각주와 같은 제약). 선택지는 셋이었다:
//!
//! | 안 | 문제 |
//! |---|---|
//! | `reqwest`/`ureq` 추가 | 오프라인 빌드에서 **컴파일 자체가 안 된다** |
//! | `curl.exe`/PowerShell | Windows 전용 + 프록시·사내 인증서 설정을 우리가 다시 짜야 한다 |
//! | **`npm view --json`** | 설치에 이미 npm이 **필수**다(같은 도구·같은 레지스트리·같은 프록시 설정을 그대로 탄다) |
//!
//! 세 번째를 골랐다. npm이 없으면 설치도 못 하므로, 조회만 되고 설치가 안 되는 상태가
//! 생기지 않는다 — 실패 문구도 한 곳에서 같은 말을 한다.

use serde_json::{json, Value};
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::time::Duration;

pub const PACKAGE: &str = "@openai/codex";
const ENGINES_DIR: &str = "codex-engines";
const CONFIG_FILE: &str = "codex-config.json";
/// 2.6.2 `codexListAvailable`의 AbortController와 같은 상한.
const VIEW_TIMEOUT: Duration = Duration::from_secs(8);

pub fn engines_dir(home: &Path) -> PathBuf {
    home.join(ENGINES_DIR)
}
pub fn config_path(home: &Path) -> PathBuf {
    home.join(CONFIG_FILE)
}

fn package_dir(home: &Path, version: &str) -> PathBuf {
    let mut p = engines_dir(home).join(version).join("node_modules");
    for part in PACKAGE.split('/') {
        p = p.join(part);
    }
    p
}

/// 그 폴더가 **진짜 설치본**인가 = `package.json`의 version이 읽히는가.
pub fn installed_version_at(home: &Path, version: &str) -> Option<String> {
    let s = std::fs::read_to_string(package_dir(home, version).join("package.json")).ok()?;
    serde_json::from_str::<Value>(&s)
        .ok()?
        .get("version")?
        .as_str()
        .map(str::to_string)
}

/// 자릿수 비교 내림차순(2.6.2 `compareDesc`).
pub fn cmp_desc(a: &str, b: &str) -> std::cmp::Ordering {
    let n = |s: &str| -> Vec<i64> { s.split('.').map(|x| x.parse().unwrap_or(0)).collect() };
    let (pa, pb) = (n(a), n(b));
    for i in 0..pa.len().max(pb.len()) {
        let d = pb.get(i).copied().unwrap_or(0) - pa.get(i).copied().unwrap_or(0);
        if d != 0 {
            return d.cmp(&0);
        }
    }
    std::cmp::Ordering::Equal
}

pub fn list_installed(home: &Path) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    let Ok(rd) = std::fs::read_dir(engines_dir(home)) else { return out };
    for e in rd.flatten() {
        if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        if installed_version_at(home, &name).is_some() {
            out.push(name);
        }
    }
    out.sort_by(|a, b| cmp_desc(a, b));
    out
}

pub fn active_version(home: &Path) -> Option<String> {
    let s = std::fs::read_to_string(config_path(home)).ok()?;
    let v = serde_json::from_str::<Value>(&s).ok()?;
    let a = v.get("activeVersion")?.as_str()?.to_string();
    list_installed(home).contains(&a).then_some(a)
}

pub fn set_active(home: &Path, version: Option<&str>) -> Result<(), String> {
    if let Some(v) = version {
        if installed_version_at(home, v).is_none() {
            return Err(format!("버전 {v}이(가) 설치되어 있지 않습니다."));
        }
    }
    let _ = std::fs::create_dir_all(home);
    let body = json!({ "activeVersion": version });
    std::fs::write(
        config_path(home),
        serde_json::to_string_pretty(&body).unwrap_or_default(),
    )
    .map_err(|e| format!("codex-config.json 저장 실패: {e}"))
}

/// 실행에 쓸 codex 바이너리 — 활성 설치본의 **네이티브 실행본**이 1순위.
///
/// ## 왜 `.bin/codex.cmd`가 아닌가 (실측으로 갈린 자리)
///
/// npm이 깔아 주는 `.bin/codex.cmd`는 **셸 shim**이다: `cmd → node → codex.exe` 세 겹.
/// 2.6.2는 Electron에서 `shell: true`로 그걸 그대로 띄웠지만, 3.0에서 같은 짓을 하면
/// 값이 셋 나빠진다 —
///  ① 인용 지옥: `cmd /C ""<경로>" app-server"`는 Rust/Node의 인자 이스케이프와 겹쳐
///     경로에 공백이 있으면 깨진다(이 라운드에 실제로 밟았다 — `poc-codex --only=handshake`가
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

// ── 레지스트리 ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionEntry {
    pub version: String,
    pub date: Option<String>,
    pub latest: bool,
    /// `latest`보다 높은 버전 = 프리뷰 채널(자동 업데이트 대상 아님).
    pub preview: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Available {
    pub latest: Option<String>,
    pub versions: Vec<VersionEntry>,
}

impl Available {
    pub fn wire(&self) -> Value {
        json!({
            "latest": self.latest,
            "versions": self.versions.iter().map(|v| json!({
                "version": v.version, "date": v.date, "latest": v.latest, "preview": v.preview
            })).collect::<Vec<_>>(),
        })
    }
}

/// `npm view @openai/codex --json`의 산출 → 버전 목록. **순수**라 테스트가 픽스처를 먹인다.
pub fn parse_packument(v: &Value) -> Available {
    let latest = v["dist-tags"]["latest"].as_str().map(str::to_string);
    let time = &v["time"];
    // `npm view`는 versions를 배열로, 레지스트리 원본은 객체로 준다 — 둘 다 읽는다.
    let mut stable: Vec<String> = match &v["versions"] {
        Value::Array(a) => a.iter().filter_map(Value::as_str).map(str::to_string).collect(),
        Value::Object(m) => m.keys().cloned().collect(),
        Value::String(s) => vec![s.clone()],
        _ => vec![],
    };
    stable.retain(|s| !s.contains('-')); // 프리릴리즈 태그 제외(2.6.2와 같은 규칙)
    stable.sort_by(|a, b| cmp_desc(a, b));
    let versions = stable
        .into_iter()
        .map(|ver| {
            let date = time.get(&ver).and_then(Value::as_str).map(str::to_string);
            let is_latest = latest.as_deref() == Some(ver.as_str());
            let preview = latest
                .as_deref()
                .is_some_and(|l| cmp_desc(&ver, l) == std::cmp::Ordering::Less);
            VersionEntry { version: ver, date, latest: is_latest, preview }
        })
        .collect();
    Available { latest, versions }
}

fn npm_cmd() -> Command {
    if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg("npm");
        c
    } else {
        Command::new("npm")
    }
}

/// 레지스트리 조회. 8초 상한 — 넘으면 자식을 죽이고 실패 문구를 돌려준다.
pub fn list_available() -> Result<Available, String> {
    let mut c = npm_cmd();
    c.args(["view", PACKAGE, "--json"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    let mut child = c
        .spawn()
        .map_err(|e| format!("npm 실행 실패: {e}. npm(Node.js)이 설치돼 있고 PATH에 있는지 확인하세요."))?;
    let stdout = child.stdout.take().ok_or("npm stdout 없음")?;
    let (tx, rx) = channel::<String>();
    std::thread::spawn(move || {
        let mut s = String::new();
        let mut r = std::io::BufReader::new(stdout);
        let mut line = String::new();
        while r.read_line(&mut line).unwrap_or(0) > 0 {
            s.push_str(&line);
            line.clear();
        }
        let _ = tx.send(s);
    });
    let body = match rx.recv_timeout(VIEW_TIMEOUT) {
        Ok(s) => s,
        Err(RecvTimeoutError::Timeout) => {
            let _ = child.kill();
            return Err("레지스트리 조회가 8초 안에 끝나지 않았어요".into());
        }
        Err(RecvTimeoutError::Disconnected) => String::new(),
    };
    let _ = child.wait();
    let v: Value = serde_json::from_str(body.trim())
        .map_err(|_| "레지스트리 응답을 읽지 못했어요(npm view 출력이 JSON이 아닙니다)".to_string())?;
    if let Some(err) = v.get("error").and_then(|e| e.get("summary")).and_then(Value::as_str) {
        return Err(format!("레지스트리 오류: {err}"));
    }
    Ok(parse_packument(&v))
}

/// 설치 — `npm install @openai/codex@<v> --prefix <dir>`. 진행 줄을 콜백으로 흘린다
/// (2.6.2 `codexInstall`의 `onProgress`와 같은 계약: `{version, line}` · 마지막에 `done`).
pub fn install(home: &Path, version: &str, mut on_line: impl FnMut(&str)) -> Result<(), String> {
    let dir = engines_dir(home).join(version);
    std::fs::create_dir_all(&dir).map_err(|e| format!("폴더 생성 실패: {e}"))?;
    // 이 폴더를 독립 패키지로 만들어 상위 package.json을 오염시키지 않는다(2.6.2와 동일).
    let manifest = json!({ "name": format!("agent-code-gui-codex-{version}"), "version": "0.0.0", "private": true });
    std::fs::write(dir.join("package.json"), serde_json::to_string_pretty(&manifest).unwrap_or_default())
        .map_err(|e| format!("폴더 생성 실패: {e}"))?;

    let spec = format!("{PACKAGE}@{version}");
    on_line(&format!("$ npm install {spec}"));
    let mut c = npm_cmd();
    c.args([
        "install",
        &spec,
        "--prefix",
        &dir.to_string_lossy(),
        "--no-audit",
        "--no-fund",
        "--loglevel=http",
    ])
    .current_dir(&dir)
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    let mut child = c
        .spawn()
        .map_err(|e| format!("npm 실행 실패: {e}. npm(Node.js)이 설치돼 있고 PATH에 있는지 확인하세요."))?;
    let (tx, rx) = channel::<String>();
    for pipe in [
        child.stdout.take().map(|p| Box::new(p) as Box<dyn std::io::Read + Send>),
        child.stderr.take().map(|p| Box::new(p) as Box<dyn std::io::Read + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let r = std::io::BufReader::new(pipe);
            for l in r.lines().map_while(Result::ok) {
                if !l.trim().is_empty() && tx.send(l).is_err() {
                    return;
                }
            }
        });
    }
    drop(tx);
    while let Ok(l) = rx.recv() {
        on_line(&l);
    }
    let code = child.wait().map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
    if code == 0 && installed_version_at(home, version).is_some() {
        Ok(())
    } else {
        Err(format!("설치 실패 (npm 종료 코드 {code})"))
    }
}

/// 제거. Windows에서 큰 `node_modules`는 백신/인덱서가 순간 점유해 EPERM이 난다 —
/// 2.6.2가 `maxRetries: 5`로 견딘 자리다(기본 0이라 조용히 실패했다).
pub fn uninstall(home: &Path, version: &str) -> Result<(), String> {
    let dir = engines_dir(home).join(version);
    let mut last = None;
    for i in 0..5 {
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => {
                last = None;
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                last = None;
                break;
            }
            Err(e) => {
                last = Some(e);
                std::thread::sleep(Duration::from_millis(300 * (i + 1)));
            }
        }
    }
    if let Some(e) = last {
        return Err(format!("제거 실패: {e}"));
    }
    if active_version(home).is_none() {
        // 활성이 방금 사라졌으면 표식을 지운다(2.6.2 `codexUninstall`).
        let cur = std::fs::read_to_string(config_path(home))
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v.get("activeVersion").and_then(Value::as_str).map(str::to_string));
        if cur.as_deref() == Some(version) {
            let _ = set_active(home, None);
        }
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Cleanup {
    pub removed: Vec<String>,
    pub kept: Option<String>,
    pub freed_bytes: u64,
    pub active_switched: bool,
}

fn dir_size(p: &Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(p) else { return 0 };
    let mut total = 0;
    for e in rd.flatten() {
        let path = e.path();
        match e.file_type() {
            Ok(t) if t.is_dir() => total += dir_size(&path),
            Ok(t) if t.is_file() => total += e.metadata().map(|m| m.len()).unwrap_or(0),
            _ => {}
        }
    }
    total
}

/// 최신 하나만 남기고 정리(2.6.2 `codexCleanupOld`).
pub fn cleanup_old(home: &Path) -> Cleanup {
    let installed = list_installed(home);
    let kept = installed.first().cloned();
    let active_before = active_version(home);
    let mut c = Cleanup { kept: kept.clone(), ..Default::default() };
    for v in installed.iter().skip(1) {
        c.freed_bytes += dir_size(&engines_dir(home).join(v));
        if uninstall(home, v).is_ok() {
            c.removed.push(v.clone());
        }
    }
    if let Some(a) = active_before {
        if c.removed.contains(&a) {
            c.active_switched = true;
            let _ = set_active(home, kept.as_deref());
        }
    }
    c
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("ccg-codex-ver-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn fake_install(home: &Path, v: &str) {
        let d = package_dir(home, v);
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
