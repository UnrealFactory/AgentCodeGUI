//! ccg-store — 앱 홈(`~/.agentcodegui`)의 경로 결정과 JSON 스토어들.
//!
//! **설계 목표는 바이트 호환**이다: 3.0은 2.6.2 사용자의 홈을 그대로 읽고 쓴다.
//! 파일 이름·레이아웃·JSON 모양은 물론, "내용이 같으면 저장을 건너뛴다" 같은
//! 의미론까지 src/main/{chats,uiPrefs,profile,atomicWrite}.ts를 그대로 옮겼다.
//! (그 파일들이 원본 — 여기가 미러다.)

pub mod chats;
pub mod prefs;
pub mod window_state;

use std::io;
use std::path::{Path, PathBuf};

/// 사용자 홈. Node의 `os.homedir()`과 같은 규칙(Windows: USERPROFILE → HOMEDRIVE+HOMEPATH).
fn home_dir() -> PathBuf {
    if let Ok(p) = std::env::var("USERPROFILE") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    if let (Ok(d), Ok(p)) = (std::env::var("HOMEDRIVE"), std::env::var("HOMEPATH")) {
        if !d.is_empty() && !p.is_empty() {
            return PathBuf::from(format!("{d}{p}"));
        }
    }
    if let Ok(p) = std::env::var("HOME") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    PathBuf::from(".")
}

/// 앱 홈. `CCG_HOME`이 있으면 **무조건** 그 경로(상대 경로는 현재 작업 폴더 기준으로 절대화).
///
/// 2.6.2는 이 오버라이드를 dev(!isPackaged)에서만 존중했다 — 패키징본을 격리 홈으로
/// 띄울 수 없어 벤치가 사용자 실홈을 건드릴 위험이 있었다. 3.0은 릴리즈에서도 존중한다
/// (ARCHITECTURE-3.0 "개발·벤치는 항상 CCG_HOME 격리 — dev/release 불문").
pub fn app_home() -> PathBuf {
    match std::env::var("CCG_HOME") {
        Ok(v) if !v.is_empty() => absolutize(Path::new(&v)),
        _ => home_dir().join(".agentcodegui"),
    }
}

fn absolutize(p: &Path) -> PathBuf {
    if p.is_absolute() {
        return p.to_path_buf();
    }
    match std::env::current_dir() {
        Ok(cwd) => cwd.join(p),
        Err(_) => p.to_path_buf(),
    }
}

/// 쓰고-바꾸기(write-then-rename). 쓰는 도중 죽어도 반쪽짜리 JSON이 남지 않는다.
/// src/main/atomicWrite.ts와 같은 의미론 — 같은 볼륨의 rename은 Windows에서도 원자적이다.
pub fn write_atomic(file: &Path, data: &str) -> io::Result<()> {
    let tmp = {
        let mut s = file.as_os_str().to_os_string();
        s.push(".tmp");
        PathBuf::from(s)
    };
    std::fs::write(&tmp, data)?;
    // Windows의 rename은 대상이 있으면 실패한다(std는 ReplaceFile/MoveFileEx로 처리해
    // 덮어쓰기를 지원한다 — 아래 한 줄이 곧 MoveFileEx + REPLACE_EXISTING이다).
    std::fs::rename(&tmp, file)
}

/// 앱 홈을 만들고(있으면 no-op) 그 안의 파일에 원자 저장한다.
pub fn write_home_file(rel: &str, data: &str) -> io::Result<()> {
    let home = app_home();
    std::fs::create_dir_all(&home)?;
    write_atomic(&home.join(rel), data)
}

/// 앱 홈의 JSON 파일을 읽어 파싱한다. 없거나 깨졌으면 None(2.6.2의 try/catch와 같다).
pub fn read_home_json(rel: &str) -> Option<serde_json::Value> {
    let raw = std::fs::read_to_string(app_home().join(rel)).ok()?;
    serde_json::from_str(&raw).ok()
}
