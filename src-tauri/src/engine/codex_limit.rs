//! ★CRIT R1 — **Codex 한도 창 조회**(`account/rateLimits/read`).
//!
//! ## 왜 이 파일이 생겼나 (T3T4 확인 크리틱 R3 §3)
//!
//! R3이 본채팅에 발화 재검증을 달았는데, 그 훅이 **엔진을 안 갈랐다**. 대기표가 들고
//! 있는 계정은 `identity.billing()` = **클로드 구독 계정**이고 Codex 채팅의 표도 같은
//! 필드를 든다. 그래서 클로드 주간 창이 100%인 계정 하나가 **Codex 채팅을 50시간 잠갔다**
//! (크리틱 실측: `probe.blocked=1` · 사용자가 직접 보낸 메시지까지 `queued:1 · spawns:0`).
//!
//! 렌더러 이식본은 이 축을 원래부터 갈랐다 — `useLimitResume.fire()`가 Codex면
//! `codexAuth.accountsUsage()` + `codexBlockedResetsAt(acct.windows, …)`를 본다.
//! 이 파일이 **그 조회의 Rust 짝**이다(2.6.2 `codexAccountsUsage` — `codex/auth.ts:471`).
//!
//! ## 재료가 HTTP가 아니라 프로세스다
//!
//! OpenAI 쪽에는 `GET /api/oauth/usage` 같은 것이 없다. 2.6.2도 `codex app-server`를
//! 띄워 JSON-RPC로 `account/rateLimits/read`를 묻는다(≈0.7초). 그래서
//! [`crate::engine::limit_probe`]의 **워커 스레드**에서만 부른다 — 허브 스레드에서 부르면
//! 모든 대화의 스트리밍이 그 0.7초 동안 멈춘다.
//!
//! ## 「못 물어봤다」와 「물어볼 창구가 없다」를 가른다
//!
//! | 판 | 값 | 왜 |
//! |---|---|---|
//! | 등록된 codex 계정이 없다 · 실행본이 없다 | `None`(= 훅 미배선) | 물어볼 곳이 **없다**. 옛 계약(발사)으로 떨어뜨린다 — 그게 R3 이전의 동작이고, 안 그러면 Codex 채팅이 또 잠긴다 |
//! | 계정·실행본은 있는데 RPC가 실패했다 | 빈 창 목록 | **물어봤는데 못 얻었다** = 클로드 축의 `unavailable`과 같은 뜻(대기표 유지 후 재확인) |
//!
//! 캐시는 [`crate::ipc::parity::usage`]의 그것과 같은 모양(메모리·계정별)이다. 디스크
//! 캐시를 안 쓰는 이유: 이 값의 유일한 소비자가 재검증 훅이고, 창 목록은 프로세스 하나를
//! 태워 얻는 값이라 앱을 끄면 어차피 다시 물어야 한다.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// app-server가 두 왕복을 마칠 때까지의 상한. 2.6.2 `codexRpcOnce`의 12초와 같다.
const DEADLINE: Duration = Duration::from_secs(12);

fn cache() -> &'static Mutex<HashMap<String, (Instant, Value)>> {
    static C: std::sync::OnceLock<Mutex<HashMap<String, (Instant, Value)>>> = std::sync::OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 논블로킹 엿보기 — 허브 스레드의 문(`parity::usage::peek_usage`와 같은 규약).
pub fn peek(email: &str, ttl_ms: u64) -> Option<Value> {
    let g = cache().lock().unwrap_or_else(|e| e.into_inner());
    let (at, v) = g.get(email)?;
    (at.elapsed() < Duration::from_millis(ttl_ms)).then(|| v.clone())
}

/// **물어볼 창구가 있는가** — 허브 스레드가 부르는 쪽. **읽기만 한다**(stat 1 + 작은 JSON 1).
///
/// [`instrument`]와 나눠 둔 이유가 이 함수의 전부다: 그쪽은 격리 `CODEX_HOME`을
/// **물질화한다**(auth.json 쓰기 + 정션 만들기). 허브 스레드는 모든 채팅의 tick을 도는
/// 자리라 거기서 쓰기를 하면 안 된다 — 그래서 판정에 필요한 사실("실행본이 있나 ·
/// 등록된 계정인가")만 여기서 보고, 물질화는 워커([`fill`])가 한다.
pub fn can_ask(email: &str) -> bool {
    // 활성 설치본이 없으면 `codex_bin`은 맨 이름(`codex`)을 돌려준다 = 이 앱에는 실행본이
    // 없다. 그 판에서는 codex 턴 자체가 못 뜨므로 한도를 물을 이유도 없다.
    if !crate::engine::codex_versions::codex_bin().is_file() {
        return false;
    }
    ccg_auth::codex::read_store_file()
        .accounts
        .iter()
        .any(|a| ccg_auth::codex::email_of(a) == Some(email))
}

/// 조회에 쓸 격리 `CODEX_HOME`. **워커 전용**(물질화한다 — 위 [`can_ask`] 참고).
///
/// 실홈(`~/.codex`)으로는 절대 안 떨어진다 — `account_run_dir`가 등록 계정에만 답한다
/// (`codex_versions::home_for`의 `unregistered` 폴백을 **일부러 안 쓴다**: 빈 홈에 대고
/// 물으면 "not logged in"이 오고 그건 「한도 정보 없음」과 구분이 안 된다).
pub fn instrument(email: &str) -> Option<PathBuf> {
    if !crate::engine::codex_versions::codex_bin().is_file() {
        return None;
    }
    ccg_auth::codex::account_run_dir(email).ok()
}

/// 이 실행이 물어볼 codex 계정 — 정체성이 지정한 계정, 없으면 codex 기본 계정.
pub fn account_for(codex_account: Option<&str>) -> Option<String> {
    codex_account
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(ccg_auth::codex::default_account_email)
}

/// 워커 한 바퀴 — 조회해서 캐시에 앉힌다. **실패해도 앉힌다**(빈 창 목록 = 「못 얻었다」):
/// 안 앉히면 다음 엿보기가 또 차가워서 판정이 영원히 「스냅샷 없음」에 머문다.
pub fn fill(email: &str) {
    let windows = instrument(email).and_then(|home| read_windows(&home)).unwrap_or_else(|| json!([]));
    cache()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(email.to_string(), (Instant::now(), windows));
}

/// 격리 `CODEX_HOME` 하나에 대고 `account/rateLimits/read` 한 번. 실패는 `None`.
///
/// 홈을 **인자로 받는 이유**: 계정 스토어(DPAPI 복호화)를 안 거치고도 테스트가 이 경로를
/// 그대로 밟을 수 있어야 한다(가짜 app-server + 아무 폴더).
pub fn read_windows(home: &Path) -> Option<Value> {
    // 하네스·재생 주행의 킬 스위치. `parity::codex::query`와 **같은 스위치**를 본다.
    if ccg_auth::net::disabled() {
        return None;
    }
    let bin = crate::engine::codex_versions::codex_bin();
    let mut cmd = ccg_engine::codex::driver::command_for(&bin);
    cmd.env("CODEX_HOME", home);
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().ok()?;

    let out = (|| -> Option<Value> {
        let mut stdin = child.stdin.take()?;
        let stdout = child.stdout.take()?;
        let init = json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "clientInfo": { "name": "agentcodegui", "title": "AgentCodeGUI", "version": "3.0.0" },
                "capabilities": { "experimentalApi": true }
            }
        });
        let ask = json!({ "jsonrpc": "2.0", "id": 2, "method": "account/rateLimits/read", "params": {} });
        writeln!(stdin, "{init}").ok()?;
        writeln!(stdin, "{ask}").ok()?;
        stdin.flush().ok()?;

        let deadline = Instant::now() + DEADLINE;
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        std::thread::spawn(move || {
            for l in BufReader::new(stdout).lines().map_while(Result::ok) {
                if tx.send(l).is_err() {
                    return;
                }
            }
        });
        loop {
            let left = deadline.checked_duration_since(Instant::now())?;
            let line = rx.recv_timeout(left).ok()?;
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            if v.get("id").and_then(Value::as_i64) != Some(2) {
                continue;
            }
            // 오류 응답은 「못 얻었다」다 — 빈 목록(=풀렸다)으로 접으면 안 된다.
            if v.get("error").is_some() {
                return None;
            }
            return Some(parse(v.get("result").unwrap_or(&Value::Null)));
        }
    })();

    // 우리가 만든 프로세스는 우리가 거둔다(타임아웃이면 정리가 언제 끝날지 모른다).
    let _ = child.kill();
    let _ = child.wait();
    out
}

/// `account/rateLimits/read` 결과 → `[{usedPct, resetsAt}]`.
/// 2.6.2 `codexAccountsUsage`의 매핑 그대로(primary·secondary 둘, 퍼센트는 0..100 반올림).
pub fn parse(result: &Value) -> Value {
    let Some(rl) = result.get("rateLimits") else { return json!([]) };
    let mut out: Vec<Value> = vec![];
    for k in ["primary", "secondary"] {
        let Some(w) = rl.get(k).filter(|v| !v.is_null()) else { continue };
        let Some(pct) = w.get("usedPercent").and_then(Value::as_f64) else { continue };
        // 2.6.2는 `windowDurationMins`가 숫자일 때만 창으로 친다(라벨을 그걸로 만든다).
        if w.get("windowDurationMins").and_then(Value::as_f64).is_none() {
            continue;
        }
        out.push(json!({
            "usedPct": pct.round().clamp(0.0, 100.0) as i64,
            "resetsAt": w.get("resetsAt").and_then(Value::as_i64),
        }));
    }
    Value::Array(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 와이어 → 창 목록. 2.6.2가 만드는 값과 **같은 두 필드**여야 한다
    /// (`codexBlockedResetsAt`이 읽는 것이 정확히 그 둘이다).
    #[test]
    fn the_rate_limit_wire_maps_onto_the_two_fields_the_verdict_reads() {
        let wire = json!({ "rateLimits": {
            "planType": "plus",
            "primary": { "usedPercent": 100.0, "windowDurationMins": 300, "resetsAt": 1_787_752_800i64 },
            "secondary": { "usedPercent": 12.4, "windowDurationMins": 10080, "resetsAt": null }
        }});
        let v = parse(&wire);
        assert_eq!(v, json!([
            { "usedPct": 100, "resetsAt": 1_787_752_800i64 },
            { "usedPct": 12, "resetsAt": Value::Null },
        ]));
    }

    /// 창 길이를 모르는 항목은 **창이 아니다**(2.6.2의 `typeof windowDurationMins === 'number'`),
    /// 결과가 통째로 없으면 빈 목록이다(패닉 금지).
    #[test]
    fn a_window_without_a_duration_is_not_a_window() {
        assert_eq!(parse(&Value::Null), json!([]));
        assert_eq!(parse(&json!({ "rateLimits": {} })), json!([]));
        assert_eq!(parse(&json!({ "rateLimits": { "primary": { "usedPercent": 99.0 } } })), json!([]));
        // 퍼센트가 없으면 판정 재료가 아니다.
        assert_eq!(parse(&json!({ "rateLimits": { "primary": { "windowDurationMins": 300 } } })), json!([]));
    }

    /// 물어볼 계정 고르기 — 정체성 값이 먼저, 빈 문자열은 미지정과 같다.
    #[test]
    fn the_identity_account_wins_and_blank_means_unspecified() {
        let _h = ccg_store::testhome::take("codex-limit-acct");
        assert_eq!(account_for(Some("me@openai.com")).as_deref(), Some("me@openai.com"));
        // 등록 계정이 하나도 없는 홈에서는 미지정이 곧 「창구 없음」이다.
        assert_eq!(account_for(Some("   ")), None);
        assert_eq!(account_for(None), None);
    }

    /// 등록되지 않은 계정에는 **창구가 없다** — 실홈으로 떨어지지도 않는다.
    /// 그리고 허브 스레드가 보는 쪽은 **쓰기를 하지 않는다**(계정 폴더가 안 생긴다).
    #[test]
    fn an_unregistered_account_has_no_instrument_and_never_reaches_the_real_home() {
        let h = ccg_store::testhome::take("codex-limit-instr");
        assert!(!can_ask("ghost@openai.com"));
        assert!(instrument("ghost@openai.com").is_none());
        assert!(
            !h.dir.join("codex").join("accounts").exists(),
            "★ 판정 한 번이 계정 폴더를 물질화했다 — 허브 스레드에서 도는 경로다"
        );
    }

    /// `CCG_NO_NET`(하네스·재생)에서는 프로세스를 **한 번도 안 띄운다**.
    #[test]
    fn the_offline_arm_never_spawns_a_process() {
        let h = ccg_store::testhome::take("codex-limit-nonet");
        std::env::set_var("CCG_NO_NET", "1");
        let v = read_windows(&h.dir);
        std::env::remove_var("CCG_NO_NET");
        assert_eq!(v, None);
    }
}
