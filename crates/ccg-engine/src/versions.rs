//! 엔진 CLI **버전 관리**의 공용 알맹이 — 두 엔진이 같은 코드를 탄다.
//!
//! M4가 Codex 쪽(`codex/versions.rs`)을 먼저 옮겼고, 최종 파리티 감사 T2가 Claude 쪽
//! 다섯 채널(`engine:list-available`·`install`·`uninstall`·`set-active`·`cleanup`)이
//! **통째로 비어 있다**고 잡았다. 두 엔진의 관리 규칙은 2.6.2에서도 같은 파일 두 벌이었다
//! (`src/main/engine/versions.ts` ↔ `src/main/codex/versions.ts` — 문자열만 다르다).
//! 그래서 여기서 **한 벌로 합치고** 다른 것만 [`Spec`]에 담는다:
//!
//! ```text
//!                  package                              engines_dir      config_file
//!  CLAUDE  @anthropic-ai/claude-agent-sdk               engines          config.json
//!  CODEX   @openai/codex                                codex-engines    codex-config.json
//! ```
//!
//! 합쳐야 하는 이유는 DRY가 아니라 **어긋남**이다: 2.6.2에서 `maxRetries: 5`(Windows
//! EPERM 견디기)는 codex 쪽에만 있다가 뒤늦게 claude 쪽으로 옮겨 갔고, `preview` 배지
//! 판정도 한쪽만 고쳐진 적이 있다. 한 함수면 그런 편차가 태어날 자리가 없다.
//!
//! ## 레지스트리 조회를 `npm view`로 하는 이유 (M4의 결정 그대로)
//!
//! 2.6.2는 `fetch('https://registry.npmjs.org/<pkg>')`를 썼다. 3.0 Rust에는 HTTP
//! 클라이언트 의존성이 없고(오프라인 빌드) 설치에 npm이 **어차피 필수**라, 같은 도구·같은
//! 프록시·같은 사내 인증서 설정을 그대로 타는 `npm view --json`을 쓴다. npm이 없으면
//! 설치도 못 하므로 "조회만 되고 설치가 안 되는" 상태가 생기지 않는다.

use serde_json::{json, Value};
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::time::Duration;

/// 2.6.2 `codexListAvailable`/`listAvailable`의 AbortController와 같은 상한.
const VIEW_TIMEOUT: Duration = Duration::from_secs(8);

/// 엔진 하나의 관리 좌표. 앱 홈 아래 경로 두 개와 npm 패키지 이름이 전부다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Spec {
    /// npm 패키지 — 이 이름의 특정 버전을 앱 홈에 깔면 그것이 "설치된 엔진"이다.
    pub package: &'static str,
    /// 앱 홈 아래 설치 루트(`<home>/<engines_dir>/<version>/`).
    pub engines_dir: &'static str,
    /// 앱 홈 아래 활성 버전 표식(`{"activeVersion": "..."}`).
    pub config_file: &'static str,
    /// 설치 폴더를 독립 패키지로 만들 때 쓰는 이름 접두사(2.6.2와 **바이트 동일**해야
    /// 롤백한 2.6.2가 같은 폴더를 자기 것으로 읽는다).
    pub install_pkg_prefix: &'static str,
}

/// Claude Code 엔진 — 2.6.2 `src/main/engine/versions.ts`.
pub const CLAUDE: Spec = Spec {
    package: "@anthropic-ai/claude-agent-sdk",
    engines_dir: "engines",
    config_file: "config.json",
    install_pkg_prefix: "agent-code-gui-engine",
};

/// Codex 엔진 — 2.6.2 `src/main/codex/versions.ts`.
pub const CODEX: Spec = Spec {
    package: "@openai/codex",
    engines_dir: "codex-engines",
    config_file: "codex-config.json",
    install_pkg_prefix: "agent-code-gui-codex",
};

impl Spec {
    pub fn engines_dir(&self, home: &Path) -> PathBuf {
        home.join(self.engines_dir)
    }
    pub fn config_path(&self, home: &Path) -> PathBuf {
        home.join(self.config_file)
    }
    /// `<home>/<engines>/<version>/node_modules/<pkg…>`
    pub fn package_dir(&self, home: &Path, version: &str) -> PathBuf {
        let mut p = self.engines_dir(home).join(version).join("node_modules");
        for part in self.package.split('/') {
            p = p.join(part);
        }
        p
    }

    /// 그 폴더가 **진짜 설치본**인가 = `package.json`의 version이 읽히는가.
    /// (빈 폴더·중단된 npm install은 목록에 오르면 안 된다 — 골라도 실행이 안 된다.)
    pub fn installed_version_at(&self, home: &Path, version: &str) -> Option<String> {
        let s = std::fs::read_to_string(self.package_dir(home, version).join("package.json")).ok()?;
        serde_json::from_str::<Value>(&s).ok()?.get("version")?.as_str().map(str::to_string)
    }

    pub fn list_installed(&self, home: &Path) -> Vec<String> {
        let mut out: Vec<String> = vec![];
        let Ok(rd) = std::fs::read_dir(self.engines_dir(home)) else { return out };
        for e in rd.flatten() {
            if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            if self.installed_version_at(home, &name).is_some() {
                out.push(name);
            }
        }
        out.sort_by(|a, b| cmp_desc(a, b));
        out
    }

    /// 설정된 활성 버전 — **설치돼 있을 때만**. 2.6.2 `getState()`의
    /// "configured-but-missing → 조용히 번들 폴백"과 같은 판정이다.
    pub fn active_version(&self, home: &Path) -> Option<String> {
        let a = self.configured_version(home)?;
        self.list_installed(home).contains(&a).then_some(a)
    }

    /// 파일에 **적혀 있는** 값(설치 여부를 안 본다). 제거 후 표식 청소가 이걸 쓴다.
    pub fn configured_version(&self, home: &Path) -> Option<String> {
        let s = std::fs::read_to_string(self.config_path(home)).ok()?;
        let v = serde_json::from_str::<Value>(&s).ok()?;
        v.get("activeVersion")?.as_str().map(str::to_string)
    }

    pub fn set_active(&self, home: &Path, version: Option<&str>) -> Result<(), String> {
        if let Some(v) = version {
            if self.installed_version_at(home, v).is_none() {
                return Err(format!("버전 {v}이(가) 설치되어 있지 않습니다."));
            }
        }
        let _ = std::fs::create_dir_all(home);
        let body = json!({ "activeVersion": version });
        std::fs::write(self.config_path(home), serde_json::to_string_pretty(&body).unwrap_or_default())
            .map_err(|e| format!("{} 저장 실패: {e}", self.config_file))
    }

    /// 레지스트리 조회. 8초 상한 — 넘으면 자식을 죽이고 실패 문구를 돌려준다.
    pub fn list_available(&self) -> Result<Available, String> {
        let body = npm_view(self.package)?;
        let v: Value = serde_json::from_str(body.trim())
            .map_err(|_| "레지스트리 응답을 읽지 못했어요(npm view 출력이 JSON이 아닙니다)".to_string())?;
        if let Some(err) = v.get("error").and_then(|e| e.get("summary")).and_then(Value::as_str) {
            return Err(format!("레지스트리 오류: {err}"));
        }
        Ok(parse_packument(&v))
    }

    /// 설치 — `npm install <pkg>@<v> --prefix <dir>`. 진행 줄을 콜백으로 흘린다
    /// (2.6.2 `onProgress`와 같은 계약: `{version, line}` · 마지막에 `done`).
    pub fn install(&self, home: &Path, version: &str, mut on_line: impl FnMut(&str)) -> Result<(), String> {
        let dir = self.engines_dir(home).join(version);
        std::fs::create_dir_all(&dir).map_err(|e| format!("폴더 생성 실패: {e}"))?;
        // 이 폴더를 독립 패키지로 만들어 상위 package.json을 오염시키지 않는다(2.6.2와 동일).
        let manifest = json!({
            "name": format!("{}-{version}", self.install_pkg_prefix), "version": "0.0.0", "private": true
        });
        std::fs::write(dir.join("package.json"), serde_json::to_string_pretty(&manifest).unwrap_or_default())
            .map_err(|e| format!("폴더 생성 실패: {e}"))?;

        let spec = format!("{}@{version}", self.package);
        on_line(&format!("$ npm install {spec}"));
        let mut c = npm_cmd();
        c.args(["install", &spec, "--prefix", &dir.to_string_lossy(), "--no-audit", "--no-fund", "--loglevel=http"])
            .current_dir(&dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        hide_window(&mut c);
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
        match self.installed_version_at(home, version) {
            Some(installed) if code == 0 => {
                self.write_markers(home, version, &installed);
                Ok(())
            }
            _ => Err(format!("설치 실패 (npm 종료 코드 {code})")),
        }
    }

    /// 2.6.2 `writeMarkers` — 폴더만 봐도 뭐가 언제 깔렸는지 알 수 있게 하는 표식.
    /// best-effort다(실패해도 설치는 성공이다 — 판정은 `package.json`이 한다).
    fn write_markers(&self, home: &Path, version: &str, installed: &str) {
        let dir = self.engines_dir(home).join(version);
        let _ = std::fs::write(dir.join(".installed"), installed);
        let stamp = json!({ "package": self.package, "version": installed, "installedAt": iso_now() });
        let _ = std::fs::write(dir.join("manifest.json"), serde_json::to_string_pretty(&stamp).unwrap_or_default());
    }

    /// 제거. Windows에서 큰 `node_modules`는 백신/인덱서가 순간 점유해 EPERM이 난다 —
    /// 2.6.2가 `maxRetries: 5`로 견딘 자리다(기본 0이라 조용히 실패했다).
    pub fn uninstall(&self, home: &Path, version: &str) -> Result<(), String> {
        let dir = self.engines_dir(home).join(version);
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
        // 활성이 방금 사라졌으면 표식을 지운다(2.6.2 `uninstall`/`codexUninstall`).
        if self.active_version(home).is_none() && self.configured_version(home).as_deref() == Some(version) {
            let _ = self.set_active(home, None);
        }
        Ok(())
    }

    /// 최신 하나만 남기고 정리(2.6.2 `cleanupOld`/`codexCleanupOld`).
    /// 활성이 지워졌으면 남긴 최신으로 옮긴다 — 정리가 실행을 조용히 끊으면 안 된다.
    pub fn cleanup_old(&self, home: &Path) -> Cleanup {
        let installed = self.list_installed(home);
        let kept = installed.first().cloned();
        let active_before = self.active_version(home);
        let mut c = Cleanup { kept: kept.clone(), ..Default::default() };
        for v in installed.iter().skip(1) {
            c.freed_bytes += dir_size(&self.engines_dir(home).join(v));
            if self.uninstall(home, v).is_ok() {
                c.removed.push(v.clone());
            }
        }
        if let Some(a) = active_before {
            if c.removed.contains(&a) {
                c.active_switched = true;
                let _ = self.set_active(home, kept.as_deref());
            }
        }
        c
    }
}

/// 자릿수 비교 내림차순(2.6.2 `compareVersionsDesc`). 두 엔진 공통이라 자유 함수다.
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

/// `npm view <pkg> --json`의 산출 → 버전 목록. **순수**라 테스트가 픽스처를 먹인다.
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
            let preview = latest.as_deref().is_some_and(|l| cmp_desc(&ver, l) == std::cmp::Ordering::Less);
            VersionEntry { version: ver, date, latest: is_latest, preview }
        })
        .collect();
    Available { latest, versions }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Cleanup {
    pub removed: Vec<String>,
    pub kept: Option<String>,
    pub freed_bytes: u64,
    pub active_switched: bool,
}

// ── 도구 ─────────────────────────────────────────────────────────────────────

fn npm_cmd() -> Command {
    if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg("npm");
        c
    } else {
        Command::new("npm")
    }
}

fn hide_window(c: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    let _ = c;
}

/// `npm view <pkg> --json`의 stdout. 8초 안에 안 끝나면 자식을 죽인다.
fn npm_view(package: &str) -> Result<String, String> {
    let mut c = npm_cmd();
    c.args(["view", package, "--json"]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    hide_window(&mut c);
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
    Ok(body)
}

/// best-effort 재귀 폴더 크기 — 정리의 "얼마나 확보했는지" 숫자.
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

/// `new Date().toISOString()` — 표식 파일에만 쓴다(파싱하는 곳이 없다).
/// chrono 의존을 새로 받을 수 없는 오프라인 빌드라 직접 민다.
fn iso_now() -> String {
    let d = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let (secs, ms) = (d.as_secs() as i64, d.subsec_millis());
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // 1970-01-01 기준 민간력 역산(Howard Hinnant의 civil_from_days).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{h:02}:{mi:02}:{s:02}.{ms:03}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("ccg-ver-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn fake_install(spec: &Spec, home: &Path, v: &str) {
        let d = spec.package_dir(home, v);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("package.json"), format!("{{\"version\":\"{v}\"}}")).unwrap();
    }

    /// ★T2 — 두 엔진이 **서로의 폴더를 절대 안 본다**. 같은 코드를 타는 순간
    /// 이게 첫 번째 위험이다(경로 상수를 한쪽만 넘기면 목록이 섞인다).
    #[test]
    fn the_two_engines_never_see_each_others_installs() {
        let home = tmp("two-engines");
        fake_install(&CLAUDE, &home, "0.3.161");
        fake_install(&CODEX, &home, "0.149.0");
        assert_eq!(CLAUDE.list_installed(&home), vec!["0.3.161"]);
        assert_eq!(CODEX.list_installed(&home), vec!["0.149.0"]);
        // 2.6.2가 읽는 그 파일 이름 그대로여야 롤백 경로가 산다.
        CLAUDE.set_active(&home, Some("0.3.161")).unwrap();
        CODEX.set_active(&home, Some("0.149.0")).unwrap();
        assert!(home.join("config.json").is_file(), "claude = config.json");
        assert!(home.join("codex-config.json").is_file(), "codex = codex-config.json");
        assert_eq!(CLAUDE.active_version(&home).as_deref(), Some("0.3.161"));
        assert_eq!(CODEX.active_version(&home).as_deref(), Some("0.149.0"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn installed_list_is_newest_first_and_ignores_empty_folders() {
        let home = tmp("list");
        fake_install(&CLAUDE, &home, "0.3.161");
        fake_install(&CLAUDE, &home, "0.3.9");
        std::fs::create_dir_all(CLAUDE.engines_dir(&home).join("0.4.0")).unwrap(); // 껍데기
        assert_eq!(CLAUDE.list_installed(&home), vec!["0.3.161", "0.3.9"]);
        assert_eq!(CLAUDE.active_version(&home), None);
        assert!(CLAUDE.set_active(&home, Some("0.4.0")).is_err(), "설치 안 된 버전은 거절");
        CLAUDE.set_active(&home, Some("0.3.9")).unwrap();
        assert_eq!(CLAUDE.active_version(&home).as_deref(), Some("0.3.9"));
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 활성 버전을 지우면 표식도 같이 내려간다 — 안 그러면 `configured`는 살아 있고
    /// 실행 경로만 사라져 "설정엔 있는데 안 도는" 유령이 된다.
    #[test]
    fn uninstalling_the_active_version_clears_the_marker() {
        let home = tmp("uninstall-active");
        fake_install(&CLAUDE, &home, "0.3.161");
        CLAUDE.set_active(&home, Some("0.3.161")).unwrap();
        CLAUDE.uninstall(&home, "0.3.161").unwrap();
        assert_eq!(CLAUDE.configured_version(&home), None, "표식이 남으면 유령 활성이다");
        assert!(CLAUDE.uninstall(&home, "0.3.161").is_ok(), "없는 버전 제거는 성공이다(멱등)");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn cleanup_keeps_only_the_newest_and_moves_the_active_flag() {
        let home = tmp("cleanup");
        fake_install(&CLAUDE, &home, "0.3.161");
        fake_install(&CLAUDE, &home, "0.3.160");
        CLAUDE.set_active(&home, Some("0.3.160")).unwrap();
        let c = CLAUDE.cleanup_old(&home);
        assert_eq!(c.kept.as_deref(), Some("0.3.161"));
        assert_eq!(c.removed, vec!["0.3.160"]);
        assert!(c.active_switched);
        assert_eq!(CLAUDE.active_version(&home).as_deref(), Some("0.3.161"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn packument_parses_both_npm_view_and_registry_shapes() {
        // `npm view --json`(배열) — 실제 산출 모양
        let a = parse_packument(&json!({
            "dist-tags": { "latest": "0.3.161" },
            "versions": ["0.3.9", "0.3.161", "0.3.162", "0.4.0-alpha.1"],
            "time": { "0.3.161": "2026-08-01T00:00:00.000Z" }
        }));
        assert_eq!(a.latest.as_deref(), Some("0.3.161"));
        // 내림차순 · 프리릴리즈 제외
        assert_eq!(a.versions.iter().map(|v| v.version.as_str()).collect::<Vec<_>>(), vec!["0.3.162", "0.3.161", "0.3.9"]);
        assert!(a.versions[1].latest);
        assert_eq!(a.versions[1].date.as_deref(), Some("2026-08-01T00:00:00.000Z"));
        // latest보다 높은 0.3.162 = 프리뷰(2.6.2와 **같은 판정 방향**)
        assert!(a.versions[0].preview);
        assert!(!a.versions[2].preview);

        // 레지스트리 원본(객체)도 같은 결과
        let b = parse_packument(&json!({
            "dist-tags": { "latest": "0.3.161" }, "versions": { "0.3.9": {}, "0.3.161": {} }, "time": {}
        }));
        assert_eq!(b.versions.len(), 2);
    }

    /// 표식의 시각 문자열이 `Date.toISOString()` 모양인가(2.6.2가 그 자리에 적던 값).
    #[test]
    fn iso_now_looks_like_a_javascript_iso_string() {
        let s = iso_now();
        assert_eq!(s.len(), 24, "YYYY-MM-DDTHH:MM:SS.mmmZ: {s}");
        assert!(s.ends_with('Z') && s.as_bytes()[10] == b'T', "{s}");
        let y: i32 = s[..4].parse().unwrap();
        assert!((2025..2100).contains(&y), "연도 역산이 깨졌다: {s}");
    }
}
