//! Codex 엔진의 **버전 · 격리 홈** 배선 (M4).
//!
//! 두 가지를 판다:
//!
//! | | 무엇 | 어디로 |
//! |---|---|---|
//! | ① | `codex-engine:*` 채널 5개(목록·설치·제거·활성·정리) | `ccg_engine::codex::versions` |
//! | ② | 실행 바이너리 · 계정별 격리 `CODEX_HOME` | `hub.rs`가 드라이버에 꽂는다 |
//!
//! `codex-engine:state`는 **여기서 다루지 않는다** — M1이 `ipc/app_meta.rs`에 이미
//! 구현했고(같은 파일이 Claude 쪽과 한 함수를 공유한다), 두 저자가 같은 채널에
//! 답하면 어느 쪽이 이겼는지 보이지 않는다. 채널 디스패치 순서상 여기가 먼저라
//! **일부러 비워 둔다**.
//!
//! ## 실홈 보호 규약
//!
//! `codex app-server`는 `CODEX_HOME`이 없으면 사용자 실홈 `~/.codex`를 쓴다. 앱은
//! 터미널 codex와 완전 격리가 규약이므로([`home_for`]), 해석에 실패해도 **실홈으로
//! 폴백하지 않는다** — 앱 홈 안의 빈 폴더를 준다. 그러면 codex가 "not logged in"으로
//! 거절하고, 그 문장이 결과 카드로 올라간다(침묵보다 낫다 · D7).

use ccg_engine::codex::{versions, CodexPlan};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

use super::super::ipc::arg;

/// 2.6.2 `IPC.codexEngine*`(`src/shared/protocol.ts:1108-1114`)의 이름 그대로.
mod ch {
    pub const LIST_AVAILABLE: &str = "codex-engine:list-available";
    pub const INSTALL: &str = "codex-engine:install";
    pub const UNINSTALL: &str = "codex-engine:uninstall";
    pub const SET_ACTIVE: &str = "codex-engine:set-active";
    pub const CLEANUP: &str = "codex-engine:cleanup";
    pub const INSTALL_PROGRESS: &str = "codex-engine:install-progress";
}

/// 이 모듈이 답하는 채널인가 — `versions::owns`와 같은 이유(블로킹 풀 배정)다.
///
/// ★T2 정정 — M4는 여기서 npm이 끝날 때까지 **async 워커를 막았고**(아래 `INSTALL`의
/// 그 경고), "블로킹 스레드로 넘기는 것은 `ipc/mod.rs`의 목록 한 줄이라 그쪽 소유"라며
/// 남은 조각으로 넘겼다. Claude 쪽을 붙이면서 그 한 줄을 같이 놓는다 — 같은 npm 왕복이
/// 엔진에 따라 굶기고 안 굶기는 것이 더 나쁜 비대칭이다.
pub fn owns(channel: &str) -> bool {
    matches!(channel, ch::LIST_AVAILABLE | ch::INSTALL | ch::UNINSTALL | ch::SET_ACTIVE | ch::CLEANUP)
}

pub fn dispatch(app: &AppHandle, channel: &str, p: &Value) -> Option<Value> {
    let home = ccg_store::app_home();
    Some(match channel {
        ch::LIST_AVAILABLE => match versions::list_available() {
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
            // 여기서 npm이 끝날 때까지 **막는다**(수십 초). 렌더러 계약이
            // `await install() → {ok}`라 비동기로 바꿀 수 없다(`Settings.tsx:968`).
            // ★T2 — 이제 그 막힘이 **전용 블로킹 풀**에서 일어난다(`owns` 참고).
            let r = versions::install(&home, &version, emit);
            let _ = app.emit(
                ch::INSTALL_PROGRESS,
                json!({ "version": version, "done": true, "ok": r.is_ok(),
                        "error": r.as_ref().err().cloned() }),
            );
            match r {
                Ok(()) => json!({ "ok": true }),
                Err(e) => json!({ "ok": false, "error": e }),
            }
        }
        ch::UNINSTALL => {
            let version = arg(p, 0).as_str().unwrap_or("").to_string();
            match versions::uninstall(&home, &version) {
                Ok(()) => json!({ "ok": true }),
                Err(e) => json!({ "ok": false, "error": e }),
            }
        }
        ch::SET_ACTIVE => {
            let v = arg(p, 0).as_str().filter(|s| !s.is_empty());
            match versions::set_active(&home, v) {
                Ok(()) => json!({ "ok": true }),
                Err(e) => json!({ "ok": false, "error": e }),
            }
        }
        ch::CLEANUP => {
            let c = versions::cleanup_old(&home);
            json!({ "removed": c.removed, "kept": c.kept,
                    "freedBytes": c.freed_bytes, "activeSwitched": c.active_switched })
        }
        _ => return None,
    })
}

/// 실행에 쓸 codex 바이너리.
///
/// `CCG_CODEX_BIN`은 **하네스 전용 우회로**다(`scripts/poc-codex.mjs`가 가짜
/// app-server를 꽂는다). 비어 있으면 앱 홈의 활성 설치본 → 전역 `codex` 순으로 떨어진다.
pub fn codex_bin() -> PathBuf {
    if let Ok(p) = std::env::var("CCG_CODEX_BIN") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    versions::codex_bin(&ccg_store::app_home())
}

/// ★R28c CPATH — **이 앱이 codex를 띄울 수 있는가**를 답하는 자리. 앱 전체에서 이것 하나다.
///
/// R28b까지 이 질문에 세 자리가 **서로 다른 기준**으로 답했고, 그것이 「전역 PATH codex
/// 사용자에게는 한도 재검증이 한 번도 안 돈다」는 구멍의 뿌리였다(확인 크리틱 R1 §3):
///
/// | 자리 | 무엇 | R28b까지의 기준 | 지금 |
/// |---|---|---|---|
/// | [`spawn_bin`] → `hub.rs` | 턴을 띄우는 `CodexDriver` | 검사 없음(스폰이 실패하면 실패) | 이 함수 |
/// | `ipc/parity/codex.rs` | 모델·계정 조회 왕복 | 검사 없음 | 이 함수 |
/// | `engine/codex_limit.rs` | 한도 재검증(`can_ask`·`instrument`) | **`codex_bin().is_file()`** | 이 함수 |
///
/// 세 번째만 거짓이 되는 인구가 있었다 — `codex_bin()`의 마지막 폴백이 **맨 이름**이라
/// 전역 설치(`npm i -g`) 판에서 `is_file()`이 언제나 거짓이었기 때문이다. 그래서 턴은 돌고
/// 한도만 `Unknown`(= 눈감고 발사)이었고, 설정 ▸ Account의 OpenAI 게이지도 비었다.
///
/// 해석 규칙(폴더 순서 · 확장자 후보)과 캐시 규약은 [`versions::resolve_bin`]에 있다.
/// ★R28d EXTN R1 — 여기 있던 *"(허브 tick이 부르는 자리다)"* 는 사실이 아니라 지웠다.
/// 이 함수에 되돌아오는 자리는 tick이 아니라 **한도 재확인 사다리**(15초·30초…)다
/// (`poc-limit-engine` E8 「tick마다 조회하지 않는다 — asks:2」).
pub fn codex_exe() -> Option<PathBuf> {
    versions::resolve_bin(&codex_bin())
}

/// 스폰에 쓸 값 — 해석된 실물 경로가 1순위다(맨 이름을 넘기면 `cmd`가 같은 훑기를 한 번 더
/// 한다). 못 찾으면 **옛 인자 그대로** 넘긴다: 그 판의 스폰 실패가 엔진 미설치 안내
/// 카드(EngineGate)까지 가는 경로이고, 인자를 비우면 그 카드에 닿는 사유가 바뀐다.
pub fn spawn_bin() -> PathBuf {
    let bin = codex_bin();
    versions::resolve_bin(&bin).unwrap_or(bin)
}

/// 계정 → 격리 `CODEX_HOME`(2.6.2 `codexAccountRunDir`/`codexApiKeyRunDir` 파리티).
/// 물질화(auth.json 쓰기 + `sessions`·`skills`·`plugins`·`cache` 정션)는 `ccg-auth`가 한다.
pub fn home_for(plan: &CodexPlan) -> Option<PathBuf> {
    if plan.api_mode {
        // API 키 모드 — 계정 로그인 대신 저장된 OPENAI_API_KEY로 과금하는 격리 홈.
        if let Some(k) = ccg_store::api_config::openai_api_key() {
            if let Ok(d) = ccg_auth::codex::api_key_run_dir(&k) {
                return Some(d);
            }
        }
        return Some(unregistered_home());
    }
    let email = plan
        .account
        .clone()
        .or_else(ccg_auth::codex::default_account_email);
    match email.and_then(|e| ccg_auth::codex::account_run_dir(&e).ok()) {
        Some(d) => Some(d),
        // 등록된 계정이 없다 → **실홈으로 새지 않게** 빈 폴더를 준다(모듈 헤더 규약).
        None => Some(unregistered_home()),
    }
}

fn unregistered_home() -> PathBuf {
    let d = ccg_auth::codex::codex_root().join("unregistered");
    let _ = std::fs::create_dir_all(&d);
    d
}

pub fn resolver() -> ccg_engine::codex::driver::HomeResolver {
    Arc::new(|plan: &CodexPlan| home_for(plan))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 실홈으로 새지 않는다 — 계정이 하나도 없어도 `CODEX_HOME`은 **앱 홈 안**이다.
    ///
    /// ★R3(F5) — `CCG_HOME`은 프로세스 전역이라 **공용 자물쇠**로 잡는다. R2까지 이
    /// 테스트는 자기 혼자 `set_var`/`remove_var`를 했고, 그 `remove_var` 창에서
    /// `acct_switch::tests`의 `app_home()`이 **사용자 실홈**으로 떨어졌다(확인 크리틱 F5 —
    /// 헤드라인 자물쇠가 1/15로 red). 증표를 놓으면 홈은 스스로 되돌아간다.
    #[test]
    fn an_unresolvable_account_never_falls_back_to_the_real_codex_home() {
        let home = crate::engine::testhome::take("m4-codexhome");
        let h = home_for(&CodexPlan { account: Some("ghost@openai.com".into()), ..Default::default() })
            .expect("항상 값이 있다");
        assert!(h.starts_with(&home.dir), "앱 홈 밖으로 나갔다: {}", h.display());
        assert!(!h.to_string_lossy().contains(".codex\\"), "사용자 실홈 금지");
    }
}
