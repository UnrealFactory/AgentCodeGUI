//! Claude 엔진(CLI) **버전 관리** 배선 — 최종 파리티 감사 **T2**.
//!
//! 감사 실측: `engine:list-available`·`install`·`uninstall`·`set-active`·`cleanup`의
//! Rust 핸들러가 **0개**였다(`engine:state`만 있었다). 결과 둘 —
//!
//! | 어디 | 무엇이 안 됐나 |
//! |---|---|
//! | 부팅 | `EngineGate.tsx:32`가 `listAvailable().latest`를 요구한다 → 심의 안전값 `null` → **미설치 안내 카드가 영영 안 뜬다**(A/B `engine-gate-prompt` 실패) |
//! | 설정 ▸ Engine | 버전 목록이 비고 설치·제거·활성·정리 버튼이 전부 무반응 |
//!
//! 첫 줄이 치명인 이유는 하나다: **CLI가 없는 컴퓨터에서 3.0은 아무 말도 하지 않는다.**
//! 채팅을 보내면 `claude.exe` 스폰이 실패하고, 그 실패 문장만으로는 "무엇을 깔아야
//! 하는지"를 사용자가 알 수 없다.
//!
//! 알맹이는 `ccg_engine::versions`(두 엔진 공용)에 있고 여기는 **채널 ↔ 값**과
//! **실행 바이너리 고르기**만 한다 — `codex_versions.rs`와 정확히 같은 모양이다.
//!
//! ## `engine:state`는 여기서 안 답한다
//! M1이 `ipc/app_meta.rs`에 이미 구현했고 두 저자가 같은 채널에 답하면 어느 쪽이 이겼는지
//! 보이지 않는다. codex 쪽이 같은 이유로 비워 둔 자리와 같은 규약이다.

use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};

use super::super::ipc::arg;
use ccg_engine::versions::CLAUDE as SPEC;

/// 2.6.2 `IPC.engine*`(`src/shared/protocol.ts:1216-1222`·`:1241`)의 이름 그대로.
mod ch {
    pub const LIST_AVAILABLE: &str = "engine:list-available";
    pub const INSTALL: &str = "engine:install";
    pub const UNINSTALL: &str = "engine:uninstall";
    pub const SET_ACTIVE: &str = "engine:set-active";
    pub const CLEANUP: &str = "engine:cleanup";
    pub const INSTALL_PROGRESS: &str = "engine:install-progress";
}

/// 이 모듈이 답하는 채널인가. `ipc_call`이 **블로킹 풀 배정**을 이걸로 정한다 —
/// `npm install`은 수십 초고 `npm view`는 8초 상한이라 async 워커에서 돌면 그동안
/// 다른 창의 IPC(창 컨트롤·스토어 저장)가 통째로 굶는다.
pub fn owns(channel: &str) -> bool {
    matches!(channel, ch::LIST_AVAILABLE | ch::INSTALL | ch::UNINSTALL | ch::SET_ACTIVE | ch::CLEANUP)
}

pub fn dispatch(app: &AppHandle, channel: &str, p: &Value) -> Option<Value> {
    let home = ccg_store::app_home();
    Some(match channel {
        ch::LIST_AVAILABLE => match SPEC.list_available() {
            Ok(a) => a.wire(),
            // 2.6.2는 예외를 던지고 렌더러가 catch해 문구를 띄웠다. 3.0 계약면은 값이라
            // `{error}`로 내린다 — 렌더러의 `failed()` 폴백이 같은 자리를 그린다.
            Err(e) => json!({ "latest": Value::Null, "versions": [], "error": e }),
        },
        ch::INSTALL => {
            let version = arg(p, 0).as_str().unwrap_or("").to_string();
            if version.is_empty() {
                return Some(json!({ "ok": false, "error": "버전이 비어 있어요" }));
            }
            let app2 = app.clone();
            let v2 = version.clone();
            let emit = move |line: &str| {
                let _ = app2.emit(ch::INSTALL_PROGRESS, json!({ "version": v2, "line": line }));
            };
            let r = SPEC.install(&home, &version, emit);
            // 마지막 `done` 프레임 — `EngineGate`/설정 카드가 이걸로 스피너를 내린다.
            let _ = app.emit(
                ch::INSTALL_PROGRESS,
                json!({ "version": version, "done": true, "ok": r.is_ok(), "error": r.as_ref().err().cloned() }),
            );
            match r {
                Ok(()) => json!({ "ok": true }),
                Err(e) => json!({ "ok": false, "error": e }),
            }
        }
        ch::UNINSTALL => {
            let version = arg(p, 0).as_str().unwrap_or("").to_string();
            match SPEC.uninstall(&home, &version) {
                Ok(()) => json!({ "ok": true }),
                Err(e) => json!({ "ok": false, "error": e }),
            }
        }
        ch::SET_ACTIVE => {
            let v = arg(p, 0).as_str().filter(|s| !s.is_empty());
            match SPEC.set_active(&home, v) {
                Ok(()) => json!({ "ok": true }),
                Err(e) => json!({ "ok": false, "error": e }),
            }
        }
        ch::CLEANUP => {
            let c = SPEC.cleanup_old(&home);
            json!({ "removed": c.removed, "kept": c.kept, "freedBytes": c.freed_bytes, "activeSwitched": c.active_switched })
        }
        _ => return None,
    })
}

/// 실행·계정 명령에 쓸 `claude` 실행 파일 — **앱 홈의 활성 설치본**이 1순위.
///
/// ## 판정이 `active_version`이 **아닌** 이유 (일부러 느슨하다)
///
/// `ccg_engine::versions`의 `active_version`은 `node_modules/<패키지>/package.json`까지
/// 확인한다(= 설정만 되고 안 깔린 버전을 거른다). 여기서는 **`config.json`에 적힌 값 +
/// 실행 파일 존재**만 본다. 이유는 하네스다: 가짜 CLI를 꽂는 스크립트들은
/// `engines/<v>/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe` 하나만
/// 심고 SDK 패키지는 안 깐다(`scripts/critic-m10-attack.mjs:124`). 엄격하게 바꾸면
/// 그 하네스가 전부 PATH 폴백으로 떨어져 조용히 다른 것을 재게 된다. R28 이전(`hub.rs`
/// `cli_path`)의 판정과 **한 글자도 다르지 않게** 유지한다.
///
/// `CCG_CLAUDE_BIN`은 하네스 전용 우회로다(`CCG_CODEX_BIN`과 대칭).
/// 폴백은 PATH의 `claude.exe` — 스폰 실패는 T3(엔진 층)가 사용자 문장으로 낸다.
pub fn claude_bin() -> PathBuf {
    if let Ok(p) = std::env::var("CCG_CLAUDE_BIN") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    let home = ccg_store::app_home();
    if let Some(v) = SPEC.configured_version(&home) {
        let p = SPEC.engines_dir(&home).join(&v).join("node_modules/@anthropic-ai/claude-agent-sdk-win32-x64").join(EXE);
        if p.exists() {
            return p;
        }
    }
    PathBuf::from(EXE)
}

#[cfg(windows)]
const EXE: &str = "claude.exe";
#[cfg(not(windows))]
const EXE: &str = "claude";

/// 설치본이 실제로 있나 — 계정 명령(로그인·로그아웃·status)이 "실행 파일을 못 찾았어요"를
/// 낼지 정하는 자리. PATH 폴백은 존재를 확인할 수 없으므로 **있다고 본다**(스폰이 판정한다).
pub fn claude_bin_exists() -> bool {
    let b = claude_bin();
    b == PathBuf::from(EXE) || b.exists()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 하네스가 심는 그 모양(플랫폼 패키지의 exe 하나 · SDK 패키지 없음)에서
    /// **활성 설치본이 잡혀야** 한다 — 엄격 판정으로 바뀌면 여기서 빨개진다.
    #[test]
    fn a_platform_only_install_still_resolves(){
        let home = crate::engine::testhome::take("t2-claudebin");
        std::env::remove_var("CCG_CLAUDE_BIN");
        assert_eq!(claude_bin(), PathBuf::from(EXE), "아무것도 없으면 PATH 폴백");
        let d = home.dir.join("engines/fake/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join(EXE), b"stub").unwrap();
        std::fs::write(home.dir.join("config.json"), br#"{"activeVersion":"fake"}"#).unwrap();
        assert_eq!(claude_bin(), d.join(EXE), "SDK 패키지가 없어도 잡힌다(하네스 규약)");
        assert!(claude_bin_exists());
    }
}
