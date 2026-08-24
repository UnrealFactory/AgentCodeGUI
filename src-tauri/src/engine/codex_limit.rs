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
//!
//! ## ★R28b RVERD — 같은 조회기가 **렌더러의 채널**도 먹인다
//!
//! CRIT R1까지 이 파일의 소비자는 엔진의 재검증 훅 하나였고, 렌더러가 부르는
//! `codex-auth:accounts-usage`는 Rust에 **아예 없었다**(`ipc_call` → `{__unimplemented}`
//! → 심이 `[]`로 갈음). 그래서 codex 채팅의 렌더러 재검증(`useLimitResume.fire()`)은
//! 언제나 「못 물어봤다」였고(`codexUsageUnavailable([]) === true`), 설정 ▸ Account의
//! OpenAI 게이지도 늘 비어 있었다(확인 크리틱 R1 §4.1 라이브 실측).
//!
//! [`accounts_usage`]가 그 채널이다. **조회기를 새로 만들지 않는다** — 같은 캐시·같은
//! 왕복을 쓴다. 두 벌이 되면 그 둘이 각자 만료를 세면서 app-server를 번갈아 태운다
//! (클로드 축에서 이미 겪은 사고 — `ipc/parity/mod.rs` `pub mod usage` 주석).

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// app-server가 두 왕복을 마칠 때까지의 상한. 2.6.2 `codexRpcOnce`의 12초와 같다.
const DEADLINE: Duration = Duration::from_secs(12);

/// 렌더러 채널이 값을 신선하다고 보는 창 — 2.6.2 `CX_USAGE_TTL`(2분)과 같다.
/// (엔진 훅은 자기 창을 따로 쥔다 — `limit_probe::PEEK_TTL_MS` 45초. 한 캐시를 두 TTL로
/// 읽는 것이 규약이다: 판정은 45초짜리 신선도를 원하고, 게이지는 프로세스를 아낀다.)
const ROW_TTL: Duration = Duration::from_secs(120);

/// **실패값**(빈 창 목록)이 신선한 창. 성공값보다 훨씬 짧아야 한다 — 실패를 2분 붙들면
/// 사용자가 설정을 열었다 닫아도, 재검증이 15초 사다리로 다시 물어도 **같은 실패**만
/// 돌아온다. 20초는 [`super::limit_probe`]의 codex 쿨다운과 같은 값이다(프로세스 하나가
/// ≈0.7초다 — 그보다 자주 태우면 한도 조회가 앱을 느리게 만든다).
const FAIL_TTL: Duration = Duration::from_secs(20);

/// 캐시 한 칸 = **행 하나**(`{planType, windows}`). CRIT R1까지는 창 목록만 들었는데,
/// 렌더러 계약면(`CodexAccountUsage`)이 `planType`까지 요구하므로 행째 든다.
fn cache() -> &'static Mutex<HashMap<String, (Instant, Value)>> {
    static C: std::sync::OnceLock<Mutex<HashMap<String, (Instant, Value)>>> = std::sync::OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 논블로킹 엿보기 — 허브 스레드의 문(`parity::usage::peek_usage`와 같은 규약).
/// 돌려주는 것은 **창 목록**이다(판정이 읽는 것이 그것뿐이다 — `fold_codex`).
pub fn peek(email: &str, ttl_ms: u64) -> Option<Value> {
    let g = cache().lock().unwrap_or_else(|e| e.into_inner());
    let (at, v) = g.get(email)?;
    (at.elapsed() < Duration::from_millis(ttl_ms)).then(|| windows_of(v))
}

/// 행에서 창 목록만. 모양이 깨진 값이면 빈 목록(= 「못 물어봤다」)이다.
fn windows_of(row: &Value) -> Value {
    row.get("windows").cloned().unwrap_or_else(|| json!([]))
}

/// 창이 하나도 없는 행 = **물어봤는데 못 얻었다**(모듈 헤더의 그 표).
fn is_fail(row: &Value) -> bool {
    windows_of(row).as_array().is_none_or(Vec::is_empty)
}

fn empty_row() -> Value {
    json!({ "planType": Value::Null, "windows": [] })
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
    let row = instrument(email).and_then(|home| read_row(&home)).unwrap_or_else(empty_row);
    // 구독 변경(Free→Plus 등)을 스토어에 되싱크 — 2.6.2 `codexAccountsUsage`가 하던 일이고,
    // `rateLimits/read`의 `planType`이 id_token의 `plan`보다 신선하다(`ccg_auth` 주석).
    // 값이 같으면 아무것도 안 쓴다(`resync_plan`이 먼저 비교한다).
    if let Some(p) = row.get("planType").and_then(Value::as_str) {
        ccg_auth::codex::resync_plan(email, p);
    }
    cache()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(email.to_string(), (Instant::now(), row));
}

/// ★R28b RVERD — `codex-auth:accounts-usage()` → 계약면 `CodexAccountUsage[]`.
///
/// 2.6.2 `codexAccountsUsage`(`codex/auth.ts:471`)와 **등록 순서 그대로**, 계정마다 한 행.
/// 조회는 [`fill`]이 하고 여기는 **캐시 규율**만 본다:
///
/// | 캐시 상태 | 행동 |
/// |---|---|
/// | 성공값이 [`ROW_TTL`](2분) 안 | 그대로 쓴다(프로세스 0개) |
/// | 실패값이 [`FAIL_TTL`](20초) 안 | 그대로 쓴다 — 실패를 붙드는 게 아니라 **재시도 간격**이다 |
/// | 그 밖 | [`fill`] 한 번(app-server ≈0.7초) |
///
/// **계정 여럿을 직렬로 돈다**(2.6.2는 `Promise.all`이었다). 이 채널은 블로킹 풀에서
/// 돌고(`ipc/parity/mod.rs` 헤더), 한 행이 프로세스 하나다 — 계정 다섯을 한꺼번에 태우면
/// 그 순간 app-server 다섯이 뜬다. TTL이 있어 첫 조회 뒤에는 어차피 0개다.
pub fn accounts_usage() -> Value {
    // 목록 순서 규약은 `ipc/system.rs`의 두 목록과 같다(★R28 ACCT §4 — 맨 위가 기본).
    ccg_auth::codex::ensure_default_migrated();
    let rows: Vec<Value> = ccg_auth::codex::read_store_file()
        .accounts
        .iter()
        .filter_map(|a| ccg_auth::codex::email_of(a).map(str::to_string))
        .map(|email| {
            let row = fresh_row(&email).unwrap_or_else(|| {
                fill(&email);
                // 방금 앉힌 값(실패면 빈 행)을 그대로 읽는다 — TTL을 다시 재지 않는다.
                cache()
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .get(&email)
                    .map(|(_, v)| v.clone())
                    .unwrap_or_else(empty_row)
            });
            json!({ "email": email, "planType": row.get("planType").cloned().unwrap_or(Value::Null),
                    "windows": windows_of(&row) })
        })
        .collect();
    Value::Array(rows)
}

/// 캐시가 아직 쓸 만한가 — 성공값과 실패값의 창이 다르다(위 두 상수).
fn fresh_row(email: &str) -> Option<Value> {
    let g = cache().lock().unwrap_or_else(|e| e.into_inner());
    let (at, v) = g.get(email)?;
    let ttl = if is_fail(v) { FAIL_TTL } else { ROW_TTL };
    (at.elapsed() < ttl).then(|| v.clone())
}

/// 격리 `CODEX_HOME` 하나에 대고 `account/rateLimits/read` 한 번. 실패는 `None`.
///
/// 홈을 **인자로 받는 이유**: 계정 스토어(DPAPI 복호화)를 안 거치고도 테스트가 이 경로를
/// 그대로 밟을 수 있어야 한다(가짜 app-server + 아무 폴더).
pub fn read_row(home: &Path) -> Option<Value> {
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

/// `account/rateLimits/read` 결과 → `{planType, windows:[{label, usedPct, resetsAt}]}`.
/// 2.6.2 `codexAccountsUsage`의 매핑 그대로(primary·secondary 둘, 퍼센트는 0..100 반올림).
///
/// `label`은 **판정이 안 읽는다**([`super::limit_probe::fold_codex`]는 라벨을 무시한다 —
/// 플랜별 창 구성이 다르다). 렌더러의 게이지·요약 줄이 읽는다(`Settings.tsx` `CodexLimits`·
/// `Chat.tsx` `cxUsageLine`). 그래서 판정용 값과 표시용 값을 **한 번에** 만든다.
pub fn parse(result: &Value) -> Value {
    let Some(rl) = result.get("rateLimits") else { return empty_row() };
    let mut out: Vec<Value> = vec![];
    for k in ["primary", "secondary"] {
        let Some(w) = rl.get(k).filter(|v| !v.is_null()) else { continue };
        let Some(pct) = w.get("usedPercent").and_then(Value::as_f64) else { continue };
        // 2.6.2는 `windowDurationMins`가 숫자일 때만 창으로 친다(라벨을 그걸로 만든다).
        let Some(mins) = w.get("windowDurationMins").and_then(Value::as_f64) else { continue };
        out.push(json!({
            "label": window_label(mins),
            "usedPct": pct.round().clamp(0.0, 100.0) as i64,
            "resetsAt": w.get("resetsAt").and_then(Value::as_i64),
        }));
    }
    json!({ "planType": rl.get("planType").and_then(Value::as_str), "windows": out })
}

/// 창 길이(분) → 표시 라벨. 2.6.2 `windowLabel`(`codex/auth.ts:454`)의 규약 그대로다 —
/// **렌더러가 라벨 텍스트로 주간 창을 판별**하므로(`cxUsageLine`의 `'주간'|'Weekly'`)
/// 여기서 한 글자만 달라져도 「주간 소진」 줄이 조용히 사라진다.
fn window_label(mins: f64) -> String {
    if mins <= 0.0 {
        return ccg_fs::t("한도", "Limit");
    }
    if mins <= 1440.0 {
        let h = (mins / 60.0).round().max(1.0) as i64;
        return ccg_fs::t(&format!("{h}시간"), &format!("{h}h"));
    }
    let d = (mins / 1440.0).round() as i64;
    if d == 7 {
        return ccg_fs::t("주간", "Weekly");
    }
    ccg_fs::t(&format!("{d}일"), &format!("{d}d"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 와이어 → 행. 판정이 읽는 두 필드(`usedPct`·`resetsAt`)와 렌더러가 읽는 둘
    /// (`label`·`planType`)이 **한 번에** 나와야 한다.
    #[test]
    fn the_rate_limit_wire_maps_onto_the_two_fields_the_verdict_reads() {
        let _h = ccg_store::testhome::take("codex-limit-parse");
        let wire = json!({ "rateLimits": {
            "planType": "plus",
            "primary": { "usedPercent": 100.0, "windowDurationMins": 300, "resetsAt": 1_787_752_800i64 },
            "secondary": { "usedPercent": 12.4, "windowDurationMins": 10080, "resetsAt": null }
        }});
        let v = parse(&wire);
        assert_eq!(v["planType"], "plus");
        assert_eq!(v["windows"], json!([
            { "label": "5시간", "usedPct": 100, "resetsAt": 1_787_752_800i64 },
            { "label": "주간", "usedPct": 12, "resetsAt": Value::Null },
        ]));
    }

    /// ★R28b RVERD — 라벨 규약. 렌더러(`Chat.tsx cxUsageLine`)는 **문자열 「주간」/「Weekly」**로
    /// 주간 창을 찾는다 — 여기서 한 글자만 달라지면 「주간 소진 · 리셋」 줄이 조용히 사라진다.
    #[test]
    fn the_window_labels_are_the_strings_the_renderer_matches_on() {
        let _h = ccg_store::testhome::take("codex-limit-label");
        assert_eq!(window_label(300.0), "5시간");
        assert_eq!(window_label(60.0), "1시간");
        assert_eq!(window_label(10080.0), "주간");
        assert_eq!(window_label(43200.0), "30일");
        // 0·음수는 창 길이가 아니다(2.6.2의 `mins <= 0` 갈래).
        assert_eq!(window_label(0.0), "한도");
        // 1시간 미만도 최소 1시간으로 접는다(라벨이 「0시간」이 되지 않게).
        assert_eq!(window_label(20.0), "1시간");
    }

    /// 창 길이를 모르는 항목은 **창이 아니다**(2.6.2의 `typeof windowDurationMins === 'number'`),
    /// 결과가 통째로 없으면 빈 행이다(패닉 금지).
    #[test]
    fn a_window_without_a_duration_is_not_a_window() {
        let _h = ccg_store::testhome::take("codex-limit-nowin");
        let empty = empty_row();
        assert_eq!(parse(&Value::Null), empty);
        assert_eq!(parse(&json!({ "rateLimits": {} })), empty);
        assert_eq!(parse(&json!({ "rateLimits": { "primary": { "usedPercent": 99.0 } } })), empty);
        // 퍼센트가 없으면 판정 재료가 아니다.
        assert_eq!(parse(&json!({ "rateLimits": { "primary": { "windowDurationMins": 300 } } })), empty);
        // 창이 0개인 행은 **「못 물어봤다」**다(`fold_codex`가 `Unavailable`로 접는 그 모양).
        assert!(is_fail(&empty));
        assert!(!is_fail(&parse(&json!({ "rateLimits": {
            "primary": { "usedPercent": 1.0, "windowDurationMins": 300 } } }))));
    }

    /// ★R28b RVERD — **등록된 codex 계정이 0이면 빈 배열**이고, 계정이 있으면 등록 순서
    /// 그대로 한 계정에 한 행이다. 실행본이 없는 판이라 조회는 실패하고, 그 실패는
    /// 「창 0개」로 나간다 — 「한도 0」이 아니다(렌더러 `codexUsageUnavailable`이 읽는 그 모양).
    #[test]
    fn the_channel_answers_with_one_row_per_registered_account() {
        let h = ccg_store::testhome::take("codex-limit-rows");
        assert_eq!(accounts_usage(), json!([]));
        ccg_auth::codex::write_store_file(
            &[json!({ "email": "a@openai.com", "plan": "plus" }), json!({ "email": "b@openai.com" })],
            None,
        );
        let rows = accounts_usage();
        assert_eq!(rows.as_array().map(Vec::len), Some(2), "{rows}");
        assert_eq!(rows[0]["email"], "a@openai.com");
        assert_eq!(rows[1]["email"], "b@openai.com");
        assert_eq!(rows[0]["windows"], json!([]));
        assert_eq!(rows[0]["planType"], Value::Null);
        // 실홈으로 새지 않았다 — 계정 폴더를 물질화하지도 않았다(`instrument`의 규약).
        assert!(!h.dir.join("codex").join("accounts").exists());
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
        let v = read_row(&h.dir);
        std::env::remove_var("CCG_NO_NET");
        assert_eq!(v, None);
    }
}
