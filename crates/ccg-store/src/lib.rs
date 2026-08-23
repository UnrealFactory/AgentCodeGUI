//! ccg-store — 앱 홈(`~/.agentcodegui`)의 경로 결정과 JSON 스토어들.
//!
//! **설계 목표는 바이트 호환**이다: 3.0은 2.6.2 사용자의 홈을 그대로 읽고 쓴다.
//! 파일 이름·레이아웃·JSON 모양은 물론, "내용이 같으면 저장을 건너뛴다" 같은
//! 의미론까지 src/main/{chats,uiPrefs,profile,atomicWrite}.ts를 그대로 옮겼다.
//! (그 파일들이 원본 — 여기가 미러다.)

// ── 2.6.2 포맷(얼림 — 통합 스토어 플래그가 꺼진 기본 경로) ──────────────────
pub mod chats;
pub mod ma;
pub mod prefs;
pub mod talk;
pub mod window_state;

// ── 3.0 통합 스토어(chats-v3) — CCG_UNIFIED_STORE=1 에서만 배선된다 ──────────
pub mod boards;
pub mod chats_v3;
pub mod fanout;
pub mod legacy_bridge;
pub mod migrate_v3;
pub mod raw_identity;
pub mod status;

// ── 그 외 도메인 ────────────────────────────────────────────────────────────
pub mod api_config;
pub mod api_usage;
pub mod safe_storage;

/// 통합 스토어 — **기본 켜짐**. 끄는 탈출구는 `CCG_UNIFIED_STORE=0`.
///
/// R8까지는 기본 꺼짐이었다(옵트인). 전환의 전제로 크리틱이 세운 게이트 7칸 중 6칸은
/// R8 확인 크리틱이 독립 재현으로 닫았고, 마지막 한 칸(`session-wins:changed`가 영속
/// 추가 채팅을 UI에서 지운다 — R8-1)을 이 라운드가 닫았다(`src-tauri/src/win.rs`
/// `broadcast_sessions`가 `list`와 같은 원천을 싣는다).
///
/// **탈출구를 남기는 이유**: 마이그레이션은 옛 3디렉터리를 지우지 않는다. 통합 경로에서
/// 무엇이 잘못되면 `CCG_UNIFIED_STORE=0`으로 띄우는 것만으로 2.6.2 포맷 그대로 돌아간다
/// (되돌릴 곳이 있는 상태를 계속 유지한다). 값 판정은 **"0/false만 끔"** — 오타
/// (`CCG_UNIFIED_STORE=yes`)로 조용히 꺼져 사용자가 옛 스토어에 새 대화를 쌓는 사고를
/// 막는다.
pub fn unified_store_enabled() -> bool {
    !matches!(std::env::var("CCG_UNIFIED_STORE").as_deref(), Ok("0") | Ok("false"))
}

/// ★R4 귀속 팔 — 부팅 경로를 **R3의 깊은 파싱으로 되돌린다**(`CCG_DEEP_BOOT_SCAN=1`).
///
/// R3의 부팅은 id·제목 네 필드가 필요할 때도 `all_chats()`를 불러 **채팅 전문(스냅샷
/// 포함)을 전부 `Value` 트리로 팠다**. R4는 그 두 자리를 얕은 스캔으로 바꿨는데
/// (`chats_v3::chat_ids` / `chat_heads`), *바꿨다*는 주장에는 짝지은 측정이 필요하다.
/// 이 스위치가 그 짝을 만든다 — 켜면 R3 코드 경로를 그대로 돈다.
///
/// 판정 규약은 위와 같다(빈 값·`0`·`false`는 끔). 기본은 **꺼짐 = R4 동작**이다.
pub fn deep_boot_scan() -> bool {
    !matches!(
        std::env::var("CCG_DEEP_BOOT_SCAN").as_deref(),
        Err(_) | Ok("") | Ok("0") | Ok("false")
    )
}

/// ★R4 실험 스위치 — `chats:get`의 라이트 페이로드에서 **보이는 패널 자리의 스냅샷도** 뺀다.
///
/// **기본 꺼짐.** 켜면 그 대화는 `unloaded` 마커로 나가고, 화면의 내용물은 `ma:get`이
/// 대는 한 벌만 남는다(통합 스토어에서 패널 = 채팅이라 지금은 두 채널로 두 벌 간다).
/// 켜도 되는지는 렌더러의 마커 병합이 판정한다 — `chats_v3::read_chats` 주석 참고.
pub fn light_panel_chats() -> bool {
    !matches!(
        std::env::var("CCG_LIGHT_PANEL_CHATS").as_deref(),
        Err(_) | Ok("") | Ok("0") | Ok("false")
    )
}

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

/// 원본 JSON 파싱 — **serde 기본 재귀 한도(128)를 그대로 쓴다.**
///
/// 2.6.2(JS)는 1000단 중첩도 읽으므로 한도를 푸는 것도 실측해 봤다(`disable_recursion_limit`).
/// 결과는 **스택 오버플로로 마이그레이션 프로세스가 죽는 것**이었다 — 마이그레이션이
/// 안 끝나면 앱이 못 뜨고, 그 시점의 홈은 아무 데도 못 간다. 크래시 0이 병적 중첩의
/// 보존보다 우선이다. 그런 파일은 **조용히 사라지지 않는다**: `unreadable_source` 경고 +
/// `quarantine/`에 원본 보관 + 옛 디렉터리 그대로(복구 경로 셋).
pub fn parse_json_source(raw: &str) -> Option<serde_json::Value> {
    serde_json::from_str(raw).ok()
}

/// 테스트 전용 — `CCG_HOME`을 임시 폴더로 돌리고 프로세스 전역 캐시를 비운다.
/// (스토어 캐시가 `static`이라 홈을 갈아끼우면 반드시 무효화해야 한다)
#[cfg(test)]
pub mod testkit {
    use std::path::PathBuf;
    use std::sync::{Mutex, MutexGuard, OnceLock};

    fn lock() -> &'static Mutex<()> {
        static L: OnceLock<Mutex<()>> = OnceLock::new();
        L.get_or_init(|| Mutex::new(()))
    }

    pub struct Home {
        pub dir: PathBuf,
        _guard: MutexGuard<'static, ()>,
    }

    impl Home {
        pub fn path(&self, rel: &str) -> PathBuf {
            self.dir.join(rel)
        }
        pub fn write(&self, rel: &str, text: &str) {
            let p = self.path(rel);
            if let Some(d) = p.parent() {
                let _ = std::fs::create_dir_all(d);
            }
            std::fs::write(p, text).expect("테스트 픽스처 쓰기");
        }
        pub fn read_json(&self, rel: &str) -> Option<serde_json::Value> {
            serde_json::from_str(&std::fs::read_to_string(self.path(rel)).ok()?).ok()
        }
        pub fn files(&self, rel: &str) -> Vec<String> {
            let mut v: Vec<String> = std::fs::read_dir(self.path(rel))
                .map(|it| it.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect())
                .unwrap_or_default();
            v.sort();
            v
        }
    }

    impl Drop for Home {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
            std::env::remove_var("CCG_HOME");
        }
    }

    /// 스냅샷 한 벌 — 메시지 n개(대화 소실 판정의 최소 단위).
    pub fn snap(n: usize, sid: &str) -> serde_json::Value {
        serde_json::json!({
            "status": "idle",
            "messages": (0..n).map(|i| serde_json::json!({ "id": format!("m{i}"), "role": "user", "text": format!("줄 {i}") })).collect::<Vec<_>>(),
            "session": { "sessionId": sid, "model": "opus", "cwd": "C:\\Code" },
            "streaming": false,
        })
    }

    /// 2.6.2 3스토어 픽스처 — 본채팅 2 / 세션 2(패널 2+1) / 추가 채팅 1.
    /// 크리틱 하네스의 합성 홈과 같은 모양이라 실패 지점을 옮겨 읽을 수 있다.
    pub fn seed_262(h: &Home) {
        h.write("ui-prefs.json", r#"{"workspace.mode":"multi","api.mode":false,"claude.outputStyle":"Concise"}"#);
        for (i, id) in ["c-1", "c-2"].iter().enumerate() {
            h.write(
                &format!("chats/{id}.json"),
                &serde_json::json!({
                    "id": id, "title": format!("채팅 {i}"), "custom": false, "snapshot": snap(4 + i, &format!("s-{id}")),
                    "manualCwd": "C:\\Code", "refDirs": [], "picker": { "model": "opus", "effort": "high", "mode": "auto", "account": format!("u{i}@x.com") },
                    "updatedAt": 1000 + i
                })
                .to_string(),
            );
        }
        h.write("chats/index.json", r#"{"version":1,"order":["c-1","c-2"],"activeChatId":"c-1"}"#);
        h.write(
            "multi-agent/sess-A.json",
            &serde_json::json!({
                "id": "sess-A", "title": "A", "custom": false, "count": 2, "panelOrder": [0,1,2,3,4,5],
                "panels": [
                    { "title": "P0", "cwd": "C:\\Code", "refDirs": [], "picker": { "model": "opus", "effort": "high", "mode": "auto" }, "api": false, "snapshot": snap(5, "s-p0") },
                    { "title": "P1", "cwd": "C:\\Code", "refDirs": [], "picker": { "model": "sonnet", "effort": "low", "mode": "plan" }, "api": false, "snapshot": snap(3, "s-p1") }
                ]
            })
            .to_string(),
        );
        h.write(
            "multi-agent/sess-B.json",
            &serde_json::json!({
                "id": "sess-B", "title": "B", "custom": false, "count": 1, "panelOrder": [0,1,2,3,4,5],
                "panels": [ { "title": "Q0", "cwd": "C:\\Code", "refDirs": [], "picker": {}, "snapshot": snap(7, "s-q0") } ]
            })
            .to_string(),
        );
        h.write("multi-agent/index.json", r#"{"version":2,"order":["sess-A","sess-B"],"activeSessionId":"sess-A"}"#);
        h.write(
            "session-chats/w-1.json",
            &serde_json::json!({ "id": "w-1", "title": "추가 0", "status": "done", "cwd": "C:\\Code", "picker": {}, "snapshot": snap(2, "s-w1"), "updatedAt": 5 })
                .to_string(),
        );
        h.write("session-chats/index.json", r#"{"version":1,"order":["w-1"]}"#);
    }

    /// 채팅 파일의 스레드 지문 — "대화가 그대로인가"의 판정 키.
    pub fn threads(h: &Home) -> std::collections::BTreeMap<String, String> {
        let mut out = std::collections::BTreeMap::new();
        for name in h.files("chats-v3") {
            if !name.ends_with(".json") || name == "index.json" || name == "status.json" {
                continue;
            }
            let Some(rec) = h.read_json(&format!("chats-v3/{name}")) else { continue };
            let msgs = rec.get("snapshot").and_then(|s| s.get("messages")).cloned().unwrap_or(serde_json::Value::Null);
            out.insert(name.trim_end_matches(".json").to_string(), crate::raw_identity::canon_bytes(&msgs));
        }
        out
    }

    pub fn temp_home(tag: &str) -> Home {
        let guard = lock().lock().unwrap_or_else(|e| e.into_inner());
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("ccg-store-test-{tag}-{n}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("임시 홈 생성");
        std::env::set_var("CCG_HOME", &dir);
        crate::chats_v3::invalidate();
        crate::chats_v3::forget_owned();
        crate::boards::invalidate();
        crate::legacy_bridge::forget_projections();
        crate::status::forget();
        Home { dir, _guard: guard }
    }
}
