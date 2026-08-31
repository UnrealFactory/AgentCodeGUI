//! 내려받는 언어 서버(C#/C++)의 설치 — **2.6.2 `src/main/lsp/install.ts`의 최소 이식.**
//!
//! 왜 최소인가: R3의 주제는 "언어 하나 = 스펙 한 항목"이고 설치는 그 축과 다른 도메인이다.
//! 그래도 없으면 안 되는 이유가 하나 있다 — **2.6.2를 안 쓰던 사용자에게는 C#이 영원히
//! `need-install`** 이고, 그 화면에는 누를 버튼이 없다. 그래서 "누르면 실제로 받아진다"까지만
//! 만든다.
//!
//! 2.6.2와 같게 지킨 것:
//!  - 설치 자리 `<앱 홈>/lsp/<id>/` (그래서 2.6.2로 이미 받아 둔 159MB를 3.0이 그냥 쓴다)
//!  - 압축 해제는 **System32의 bsdtar**(`tar.exe`) 절대 경로 — PATH 앞쪽의 GNU tar는
//!    드라이브 문자 콜론에 질식한다(`Cannot connect to C`). 실패하면 PowerShell로 폴백.
//!  - 삭제 전에 **그 폴더에서 뜬 프로세스를 먼저 죽인다** — 앱이 강제 종료됐을 때 남은
//!    고아가 DLL을 붙들고 있어 삭제가 EPERM으로 실패한다.
//!
//! 2.6.2와 다른 것(정직하게):
//!  - **진행률 스트리밍이 없다.** 2.6.2는 `lsp:install-progress`를 흘렸는데, 3.0에서 그걸
//!    쏘려면 크레이트가 창(AppHandle)을 알아야 한다 — 이 라운드의 경계 밖이다.
//!    설치 카드는 "준비 중…"에서 완료/실패로 한 번에 넘어간다.
//!  - HTTP는 의존성 없이 **`curl.exe`**(Win10+ 기본 탑재)로 한다. 없으면 PowerShell.

use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

fn lsp_dir() -> PathBuf {
    ccg_store::app_home().join("lsp")
}

fn inflight() -> &'static Mutex<HashSet<String>> {
    static S: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashSet::new()))
}

/// 지금 내려받는 중인가 — `lsp:status`가 `installing`을 돌려주는 근거.
pub fn is_installing(id: &str) -> bool {
    inflight().lock().unwrap().contains(id)
}

#[cfg(windows)]
fn hidden(mut c: Command) -> Command {
    use std::os::windows::process::CommandExt;
    c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    c
}
#[cfg(not(windows))]
fn hidden(c: Command) -> Command {
    c
}

fn run(cmd: &str, args: &[String]) -> Result<String, String> {
    let mut c = Command::new(cmd);
    c.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let out = hidden(c).output().map_err(|e| format!("{cmd} 실행 실패: {e}"))?;
    if !out.status.success() {
        let tail = String::from_utf8_lossy(&out.stderr);
        return Err(format!("{cmd} 종료 코드 {:?} · {}", out.status.code(), tail.trim().chars().take(200).collect::<String>()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn system32(name: &str) -> Option<PathBuf> {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    let p = Path::new(&root).join("System32").join(name);
    p.exists().then_some(p)
}

/// URL 하나를 통째로 문자열로(작은 JSON 응답 전용).
fn fetch_text(url: &str) -> Result<String, String> {
    if let Some(curl) = system32("curl.exe") {
        return run(
            &curl.to_string_lossy(),
            &["-sSL".into(), "-A".into(), "AgentCodeGUI".into(), url.into()],
        );
    }
    run(
        "powershell",
        &[
            "-NoProfile".into(),
            "-NonInteractive".into(),
            "-Command".into(),
            format!("(Invoke-WebRequest -UseBasicParsing -Uri '{url}' -UserAgent 'AgentCodeGUI').Content"),
        ],
    )
}

/// 진행률 콜백 — `(0~100 또는 None, 사람이 읽는 한 줄)`. 계약면 `LspInstallProgress`의 원천.
pub type Progress<'a> = &'a (dyn Fn(Option<f64>, &str) + Sync);

fn noop_progress(_pct: Option<f64>, _line: &str) {}

/// 리다이렉트 끝의 `Content-Length` — 없으면 `None`(진행률이 불확정이 된다).
fn content_length(url: &str) -> Option<u64> {
    let curl = system32("curl.exe")?;
    let out = run(
        &curl.to_string_lossy(),
        &["-sSLI".into(), "-A".into(), "AgentCodeGUI".into(), url.into()],
    )
    .ok()?;
    // 헤더가 리다이렉트 수만큼 이어져 온다 — **마지막** 것이 실제 본문 길이다
    out.lines().rev().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        if !k.trim().eq_ignore_ascii_case("content-length") {
            return None;
        }
        v.trim().parse::<u64>().ok().filter(|n| *n > 0)
    })
}

/// 내려받기 + **진행률**. 2.6.2는 `fetch`의 스트림에서 바이트를 셌는데(§R3-8이 못 옮긴 것),
/// 여기는 의존성 없이 curl을 자식으로 띄우고 **목적지 파일 크기를 폴링**한다 —
/// 같은 눈금(받은 바이트/전체)이고 파서가 없어 curl 출력 포맷에 안 물린다.
fn fetch_file_progress(url: &str, dest: &Path, on: Progress) -> Result<(), String> {
    let d = dest.to_string_lossy().to_string();
    let Some(curl) = system32("curl.exe") else { return fetch_file(url, dest) };
    let total = content_length(url);
    on(Some(0.0), "내려받는 중…");
    let mut child = hidden(Command::new(curl.to_string_lossy().to_string()))
        .args(["-sSL", "-A", "AgentCodeGUI", "-o", &d, url])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("curl 실행 실패: {e}"))?;
    loop {
        match child.try_wait() {
            Ok(Some(st)) => {
                if !st.success() {
                    return Err(format!("내려받기 실패 (curl {:?})", st.code()));
                }
                on(Some(100.0), "내려받기 완료");
                return Ok(());
            }
            Ok(None) => {}
            Err(e) => return Err(format!("curl 상태 확인 실패: {e}")),
        }
        let got = std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
        let mb = got as f64 / (1024.0 * 1024.0);
        match total {
            Some(t) => on(
                Some(((got as f64 / t as f64) * 100.0).clamp(0.0, 99.0)),
                &format!("내려받는 중… {mb:.1}MB / {:.1}MB", t as f64 / (1024.0 * 1024.0)),
            ),
            None => on(None, &format!("내려받는 중… {mb:.1}MB")),
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
    }
}

fn fetch_file(url: &str, dest: &Path) -> Result<(), String> {
    let d = dest.to_string_lossy().to_string();
    if let Some(curl) = system32("curl.exe") {
        run(
            &curl.to_string_lossy(),
            &["-sSL".into(), "-A".into(), "AgentCodeGUI".into(), "-o".into(), d, url.into()],
        )?;
        return Ok(());
    }
    run(
        "powershell",
        &[
            "-NoProfile".into(),
            "-NonInteractive".into(),
            "-Command".into(),
            format!("Invoke-WebRequest -UseBasicParsing -Uri '{url}' -OutFile '{d}' -UserAgent 'AgentCodeGUI'"),
        ],
    )
    .map(|_| ())
}

fn extract(zip: &Path, dest: &Path) -> Result<(), String> {
    let (z, d) = (zip.to_string_lossy().to_string(), dest.to_string_lossy().to_string());
    // System32의 bsdtar를 **절대 경로**로 — PATH 앞쪽의 GNU tar는 `C:`를 호스트로 읽는다
    if let Some(tar) = system32("tar.exe") {
        if run(&tar.to_string_lossy(), &["-xf".into(), z.clone(), "-C".into(), d.clone()]).is_ok() {
            return Ok(());
        }
    }
    run(
        "powershell",
        &[
            "-NoProfile".into(),
            "-NonInteractive".into(),
            "-Command".into(),
            format!("Expand-Archive -Force -LiteralPath '{z}' -DestinationPath '{d}'"),
        ],
    )
    .map(|_| ())
}

/// 이 설치 폴더에서 뜬 프로세스를 전부 죽인다(**우리 자신은 제외**).
/// 명령줄로 매칭하므로 우리 서버만 닿는다 — 앱이 강제 종료돼 남은 고아까지 포함해서.
fn kill_holders(dir: &Path) {
    let d = dir.to_string_lossy().replace('\'', "''");
    let _ = run(
        "powershell",
        &[
            "-NoProfile".into(),
            "-NonInteractive".into(),
            "-Command".into(),
            format!(
                "Get-CimInstance Win32_Process | Where-Object {{ $_.ProcessId -ne $PID -and $_.CommandLine -like '*{d}*' }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }}"
            ),
        ],
    );
}

/// 내려받을 서버 하나의 주소 해석 + 설치 뒤 확인할 실행 파일 이름.
struct Download {
    /// 아카이브 URL(네트워크 조회 포함)
    url: fn() -> Result<String, String>,
    /// 풀고 나서 이 이름이 폴더 어딘가에 있어야 성공
    bin: &'static str,
}

fn download_for(id: &str) -> Option<Download> {
    match id {
        // Roslyn LSP — nuget flat-container의 최신 버전(오름차순 목록의 마지막)
        "cs" => Some(Download { url: roslyn_url, bin: "Microsoft.CodeAnalysis.LanguageServer.exe" }),
        // clangd — GitHub 릴리스의 `clangd-windows-<버전>.zip`(자산 이름에 버전이 박혀 있다)
        "cpp" => Some(Download { url: clangd_url, bin: "clangd.exe" }),
        _ => None,
    }
}

fn roslyn_url() -> Result<String, String> {
    const PKG: &str = "roslyn-language-server.win-x64";
    let body = fetch_text(&format!("https://api.nuget.org/v3-flatcontainer/{PKG}/index.json"))?;
    let j: Value = serde_json::from_str(&body).map_err(|e| format!("NuGet 응답 파싱 실패: {e}"))?;
    let v = j
        .get("versions")
        .and_then(Value::as_array)
        .and_then(|a| a.last())
        .and_then(Value::as_str)
        .ok_or("roslyn-language-server 버전을 찾을 수 없어요")?;
    Ok(format!("https://api.nuget.org/v3-flatcontainer/{PKG}/{v}/{PKG}.{v}.nupkg"))
}

/// clangd의 자산 이름에는 버전이 박혀 있다(`clangd-windows-19.1.2.zip`) — API로 묻는다.
/// zip은 `clangd_<버전>/bin/clangd.exe`로 풀린다(재귀 탐색이 그걸 찾는다).
fn clangd_url() -> Result<String, String> {
    let body = fetch_text("https://api.github.com/repos/clangd/clangd/releases/latest")?;
    let j: Value = serde_json::from_str(&body).map_err(|e| format!("GitHub 응답 파싱 실패: {e}"))?;
    let name_ok = |n: &str| {
        n.starts_with("clangd-windows-")
            && n.ends_with(".zip")
            && n["clangd-windows-".len()..n.len() - 4].chars().all(|c| c.is_ascii_digit() || c == '.')
    };
    j.get("assets")
        .and_then(Value::as_array)
        .and_then(|a| {
            a.iter()
                .find(|x| x.get("name").and_then(Value::as_str).map(name_ok).unwrap_or(false))
                .and_then(|x| x.get("browser_download_url"))
                .and_then(Value::as_str)
        })
        .map(str::to_string)
        .ok_or_else(|| "clangd Windows 빌드를 찾을 수 없어요".to_string())
}

/// 설치 — 성공하면 `Ok(())`. 이미 있으면 그대로 성공이다(2.6.2와 같은 멱등성).
pub fn install(id: &str) -> Result<(), String> {
    install_with(id, &noop_progress)
}

/// 진행률을 흘리며 설치한다 — `ipc/lsp.rs`가 그 콜백을 `lsp:install-progress`로 쏜다(§R3-9 ②).
pub fn install_with(id: &str, on: Progress) -> Result<(), String> {
    let Some(spec) = download_for(id) else { return Err(format!("알 수 없는 서버: {id}")) };
    if crate::launch::installed_bin(id, spec.bin).is_some() {
        return Ok(());
    }
    {
        let mut f = inflight().lock().unwrap();
        if !f.insert(id.to_string()) {
            return Ok(()); // 이미 받는 중 — 두 번 받지 않는다
        }
    }
    let r = do_install(id, &spec, on);
    inflight().lock().unwrap().remove(id);
    r
}

fn do_install(id: &str, spec: &Download, on: Progress) -> Result<(), String> {
    let dir = lsp_dir().join(id);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("설치 폴더를 못 만들었어요: {e}"))?;
    on(None, "내려받을 주소를 찾는 중…");
    let url = (spec.url)()?;
    let zip = dir.join("_download.zip");
    fetch_file_progress(&url, &zip, on)?;
    on(None, "압축을 푸는 중…");
    extract(&zip, &dir)?;
    let _ = std::fs::remove_file(&zip);
    if crate::launch::installed_bin(id, spec.bin).is_none() {
        let _ = std::fs::remove_dir_all(&dir);
        return Err("설치 후 실행 파일을 찾을 수 없어요".into());
    }
    Ok(())
}

/// 삭제 — 그 폴더에서 도는 프로세스를 먼저 죽이고 지운다.
pub fn uninstall(id: &str) -> Result<(), String> {
    if download_for(id).is_none() {
        return Err(format!("알 수 없는 서버: {id}"));
    }
    let dir = lsp_dir().join(id);
    kill_holders(&dir);
    std::thread::sleep(std::time::Duration::from_millis(300)); // OS가 핸들을 놓게
    for i in 0..8 {
        if std::fs::remove_dir_all(&dir).is_ok() || !dir.exists() {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(250 * (i + 1)));
    }
    // ★마감(HOSTI18N 이월분) — 사용자가 설정 ▸ 코드 분석에서 「제거」를 눌렀을 때 보는 문구다.
    // **en은 2.6.2 원문 그대로**다(`src/main/lsp/install.ts:195`의 `t(...)` 둘째 인자를 바이트
    // 그대로 옮겼다) — 이 자리는 3.0 전용이 아니라 **대응 원문이 있는 쌍**이라 지어낼 필요가
    // 없었다. 동결 구역이 답을 갖고 있으면 그쪽이 언제나 옳다.
    Err(ccg_fs::t(
        "파일이 아직 사용 중이에요. 잠시 후 다시 시도하거나 앱을 재시작해 주세요.",
        "Files are still in use. Try again in a moment or restart the app.",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_servers_can_be_installed() {
        assert!(download_for("cs").is_some());
        assert!(download_for("cpp").is_some(), "R4에서 clangd가 붙었다");
        assert!(download_for("ts").is_none(), "번들 서버는 내려받는 대상이 아니다");
        assert!(download_for("py").is_none());
        assert!(install("nope").is_err());
        assert!(uninstall("nope").is_err());
    }

    /// `Provision::Download`인 스펙은 **전부** 내려받기 표에 있어야 한다 —
    /// 없으면 설정 화면에 "설치" 버튼이 뜨는데 눌러도 "알 수 없는 서버"로 끝난다
    /// (R3까지 cpp가 정확히 그 상태였다).
    #[test]
    fn every_download_spec_has_a_source() {
        for s in crate::spec::SPECS {
            if s.kind == crate::spec::Provision::Download {
                let d = download_for(s.id);
                assert!(d.is_some(), "{}: 내려받을 주소가 없다", s.id);
                // 설치 뒤 찾을 실행 파일 이름이 스펙의 것과 같아야 한다(아니면 영원히 need-install)
                if let crate::spec::Launch::Exe { bin, .. } = s.launch {
                    assert_eq!(d.unwrap().bin, bin, "{}: 스펙과 설치가 다른 exe를 본다", s.id);
                }
            }
        }
    }

    /// 네트워크를 타지 않고도 지켜야 하는 것 — 진행 표시의 근거가 실제로 켜지고 꺼지는가.
    #[test]
    fn inflight_flag_tracks_only_the_running_id() {
        assert!(!is_installing("cs"));
        inflight().lock().unwrap().insert("cs".into());
        assert!(is_installing("cs") && !is_installing("cpp"));
        inflight().lock().unwrap().remove("cs");
        assert!(!is_installing("cs"));
    }
}
