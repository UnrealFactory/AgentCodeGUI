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

/// **이 앱이 claude를 띄울 수 있는가** — `Some(실물 경로)`면 그 값으로 프로세스가 뜬다.
/// codex 축의 [`crate::engine::codex_versions::codex_exe`]와 **같은 함수·같은 규칙**이다.
///
/// ## 왜 `exists()`로는 안 됐나 (★R28d EXTN)
///
/// R28c까지 이 자리는 `claude_bin_exists()`였고 판정이 이랬다 —
/// `b == PathBuf::from(EXE) || b.exists()`. 즉 **PATH 폴백이면 무조건 참**이라, 이 컴퓨터에
/// claude가 한 벌도 없어도 로그인 버튼은 "있다"고 답하고 스폰이 실패한 뒤에야 사유가 나왔다.
/// 반대 방향의 거짓은 없었지만, 그건 판정을 **아예 안 했기** 때문이다.
///
/// 이제 셸과 같은 규칙으로 PATH를 훑어 **사실**을 답한다
/// ([`ccg_engine::codex::versions::resolve_bin`] — 두 엔진이 규칙을 한 벌로 쓴다. 규칙이
/// 두 벌이 되면 「띄울 수 있다」와 「실제로 띄운다」가 서로 다른 값을 보게 된다).
///
/// **순서가 목숨이었다.** 클로드의 PATH 폴백 철자는 `claude.exe`(확장자가 붙어 있다)인데,
/// R28c의 `resolve_bin`은 후보에 `claude.exe.COM`·`claude.exe.EXE`…만 대 보고 정작
/// `claude.exe`를 안 봤다(CPATH 확인 크리틱 R1 §4). 그 상태로 이 교체를 했으면 전역 PATH
/// claude 사용자(이 컴퓨터: `C:\Users\User\.local\bin\claude.exe`)가 **로그인·로그아웃(=토큰
/// 해지)·AI 커밋 메시지에서 전부 막혔다.** 그래서 `scan_path`를 먼저 고쳤다.
///
/// ## 「PATH만 보면 된다」도 거짓이었다 (★R28d EXTN R1)
///
/// R1은 이 함수를 `resolve_bin`으로 바꾸면서 그것이 **`PATH`만** 훑는다는 사실을 안 봤다.
/// 턴 스폰은 `Command::new(맨 이름)`이고 그건 `PATH`보다 **실행 파일이 있는 폴더**를 먼저
/// 본다 — 그래서 「앱 exe 옆에만 claude가 있는」 판에서 이 함수는 `None`(로그인 실패 문구 ·
/// **로그아웃의 토큰 해지 생략**)인데 같은 이름의 스폰은 성공했다(EXTN 확인 크리틱 R1 §2.1).
/// 이제 `resolve_bin`의 폴더 목록에 그 한 칸이 들어갔고(`search_dirs`), 반대편인
/// `engine/hub.rs`의 턴 스폰도 [`claude_spawn_bin`]을 지난다 — 두 자리가 **한 함수**다.
pub fn claude_exe() -> Option<PathBuf> {
    ccg_engine::codex::versions::resolve_bin(&claude_bin())
}

/// 스폰에 쓸 값 — 해석된 실물 경로가 1순위다(맨 이름을 넘기면 OS가 같은 훑기를 한 번 더
/// 한다). 못 찾으면 **옛 인자 그대로** 넘긴다: 그 판의 스폰 실패가 사용자 문장까지 가는
/// 경로이고, 인자를 비우면 그 문장에 닿는 사유가 바뀐다. codex의 `spawn_bin()`과 같은 규약.
pub fn claude_spawn_bin() -> PathBuf {
    let bin = claude_bin();
    ccg_engine::codex::versions::resolve_bin(&bin).unwrap_or(bin)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 프로세스 전역 환경 한 칸을 잠깐 바꾸고 **반드시 되돌리는** 증표
    /// (`engine/codex_limit.rs`의 것과 같은 모양). 언제나 `testhome::take`와 함께 쓴다 —
    /// 그쪽이 자물쇠를 쥔다.
    struct EnvGuard {
        key: &'static str,
        prev: Option<std::ffi::OsString>,
    }
    impl EnvGuard {
        fn set(key: &'static str, v: impl AsRef<std::ffi::OsStr>) -> EnvGuard {
            let prev = std::env::var_os(key);
            std::env::set_var(key, v);
            EnvGuard { key, prev }
        }
    }
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match self.prev.take() {
                Some(v) => std::env::set_var(self.key, v),
                None => std::env::remove_var(self.key),
            }
        }
    }

    /// 「이 컴퓨터에 claude가 없다」를 만드는 PATH — claude로 **해석되는 칸만** 걷어낸다.
    /// 통째로 비우면 같은 프로세스의 다른 테스트가 `git`·`npm`을 못 띄운다.
    fn path_without_claude() -> std::ffi::OsString {
        let exts: Vec<String> = if cfg!(windows) {
            std::env::var("PATHEXT")
                .unwrap_or_default()
                .split(';')
                .map(|s| s.trim().to_string())
                .filter(|s| s.starts_with('.'))
                .chain(std::iter::once(String::new()))
                .collect()
        } else {
            vec![String::new()]
        };
        let keep: Vec<PathBuf> = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .filter(|d| !exts.iter().any(|e| d.join(format!("{EXE}{e}")).is_file()))
            .collect();
        std::env::join_paths(keep).unwrap()
    }

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
        assert_eq!(claude_exe().as_deref(), Some(d.join(EXE).as_path()), "경로가 박힌 값은 stat 하나로 끝난다");
        assert_eq!(claude_spawn_bin(), d.join(EXE));
    }

    /// ★R28d EXTN — **PATH 폴백을 셸의 규칙으로 해석한다.** 이 테스트가 두 가지를 잠근다:
    ///
    /// 1. `claude.exe`는 **확장자가 이미 붙은 맨 이름**이다. `scan_path`가 그 이름 그대로를
    ///    후보로 안 넣던 R28c 상태로 이 배선을 했으면 전역 PATH claude 사용자가
    ///    로그인·로그아웃(토큰 해지)·AI 커밋 메시지에서 전부 막혔다.
    /// 2. 반대로 **진짜 없으면 없다고 답한다** — R28c까지는 PATH 폴백이면 무조건 참이라
    ///    이 방향의 판정 자체가 없었다.
    #[test]
    fn the_path_fallback_is_resolved_the_way_the_shell_does_it() {
        let home = crate::engine::testhome::take("extn-claude-path");
        let _b = EnvGuard::set("CCG_CLAUDE_BIN", ""); // 하네스 우회로 없음 = 진짜 폴백 사슬
        assert_eq!(claude_bin(), PathBuf::from(EXE), "폴백은 맨 이름이다(= 파일 경로가 아니다)");

        // ① PATH 앞칸에 실물이 있으면 **그 실물 경로**를 답한다.
        let shim = home.dir.join("pathshim");
        std::fs::create_dir_all(&shim).unwrap();
        std::fs::write(shim.join(EXE), b"stub").unwrap();
        {
            let front = std::env::join_paths([shim.clone()]).unwrap();
            let _p = EnvGuard::set("PATH", &front);
            assert_eq!(claude_exe(), Some(shim.join(EXE)), "PATH의 {EXE}를 못 찾았다");
            assert_eq!(claude_spawn_bin(), shim.join(EXE), "스폰도 해석된 실물로 간다");
        }

        // ② claude로 해석되는 칸을 걷어내면 **없다고 답한다**(= NO_BIN이 사실이 된다).
        {
            let _p = EnvGuard::set("PATH", path_without_claude());
            assert_eq!(claude_exe(), None, "PATH에 claude가 없는데 「있다」고 답했다");
            assert_eq!(claude_spawn_bin(), PathBuf::from(EXE), "못 찾으면 **옛 인자 그대로** 넘긴다");
        }
    }
}
