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
//!
//! ## ★R28c CPATH — 위 표의 「실행본이 없다」를 **누가 판정하는가**
//!
//! R28b까지 이 파일이 그 판정을 혼자 했고([`can_ask`]·[`instrument`]의
//! `codex_bin().is_file()`), 그 기준이 턴(`hub.rs`)·계정 조회(`ipc/parity/codex.rs`)와
//! **달랐다**. `codex_bin()`의 마지막 폴백은 파일 경로가 아니라 **맨 이름 `codex`**(=
//! "PATH에서 찾아라")라서, 전역 설치(`npm i -g @openai/codex`) 사용자에게만 이 파일의
//! 답이 거짓이 됐다 — 턴은 돌고 한도만 `Unknown`(= 눈감고 발사), 게이지는 빈 창.
//! 확인 크리틱 R1이 A/B로 잠갔다(`CCG_CODEX_BIN=codex` → t=90초 발사).
//!
//! 지금은 세 자리가 [`crate::engine::codex_versions::codex_exe`] 하나를 본다. 「실행본이
//! 있나」를 여기서 **다시 정의하지 않는 것**이 이 라운드의 규약이다.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
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

// 조회가 초기화 이전 값을 나중에 덮어쓰지 않도록 계정별 왕복을 직렬화한다.
fn account_gate(email: &str) -> Arc<Mutex<()>> {
    static G: std::sync::OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = std::sync::OnceLock::new();
    G.get_or_init(|| Mutex::new(HashMap::new()))
        .lock().unwrap_or_else(|e| e.into_inner())
        .entry(email.to_string()).or_default().clone()
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
    json!({ "planType": Value::Null, "windows": [], "rateLimitResetCredits": Value::Null })
}

/// **물어볼 창구가 있는가** — 허브 스레드가 부르는 쪽. **읽기만 한다**(stat 1 + 작은 JSON 1).
///
/// [`instrument`]와 나눠 둔 이유가 이 함수의 전부다: 그쪽은 격리 `CODEX_HOME`을
/// **물질화한다**(auth.json 쓰기 + 정션 만들기). 허브 스레드는 모든 채팅의 tick을 도는
/// 자리라 거기서 쓰기를 하면 안 된다 — 그래서 판정에 필요한 사실("실행본이 있나 ·
/// 등록된 계정인가")만 여기서 보고, 물질화는 워커([`fill`])가 한다.
pub fn can_ask(email: &str) -> bool {
    // ★R28c CPATH — **여기 있던 `codex_bin().is_file()`이 이 라운드의 구멍이었다.**
    // 옛 주석은 "맨 이름이 돌아오면 이 앱에는 실행본이 없다 · 그 판에서는 codex 턴 자체가
    // 못 뜬다"였는데 **둘 다 거짓**이다: 맨 이름은 「PATH에서 찾아라」는 뜻이고
    // (`codex_versions::codex_bin`의 마지막 폴백), 스폰은 실제로 그것을 찾아 띄웠다
    // (R28c 당시엔 `command_for`의 `cmd /C`가, ★R28d EXTN R2부터는 `resolve_bin`이 —
    // 그 이관이 「연 폴더의 실행본」 구멍을 닫은 자리다). 그래서 전역 설치
    // (`npm i -g @openai/codex`) 사용자는 턴이 도는데 한도만 「창구 없음」 = `Unknown`
    // = **눈감고 발사**였다(크리틱 A/B: t=90초 발사).
    // 지금은 턴·계정 조회와 **같은 문**을 본다(`codex_exe`의 표).
    if crate::engine::codex_versions::codex_exe().is_none() {
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
    // ★R28c CPATH — [`can_ask`]와 **같은 문**이다(전역 PATH codex도 창구로 친다).
    // 이 줄이 `is_file()`이던 동안에는 `accounts_usage()`까지 같은 이유로 빈 게이지를 냈다.
    crate::engine::codex_versions::codex_exe()?;
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
    let gate = account_gate(email);
    let _guard = gate.lock().unwrap_or_else(|e| e.into_inner());
    fill_locked(email);
}

fn fill_locked(email: &str) -> Value {
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
        .insert(email.to_string(), (Instant::now(), row.clone()));
    row
}

fn usage_row(email: &str, row: &Value) -> Value {
    json!({ "email": email, "planType": row.get("planType").cloned().unwrap_or(Value::Null),
            "windows": windows_of(row), "rateLimitResetCredits": row.get("rateLimitResetCredits").cloned().unwrap_or(Value::Null) })
}

/// 사용자가 명시적으로 누른 1회 사용. 재시도 시 같은 키를 보내도록 IPC에서 키를 받는다.
/// 자동 사용·자동 재시도는 하지 않는다. 서버 응답 이후 한도는 반드시 다시 조회한다.
pub fn consume_reset_credit(email: &str, idempotency_key: &str) -> Value {
    if email.trim().is_empty() || idempotency_key.trim().is_empty() || idempotency_key.len() > 128 {
        return json!({ "outcome": "error", "error": "invalidRequest" });
    }
    if ccg_auth::net::disabled() {
        return json!({ "outcome": "error", "error": "unavailable" });
    }
    let gate = account_gate(email);
    let _guard = gate.lock().unwrap_or_else(|e| e.into_inner());
    let Some(home) = instrument(email) else {
        return json!({ "outcome": "error", "error": "accountUnavailable" });
    };
    let result = rpc(&home, "account/rateLimitResetCredit/consume", json!({ "idempotencyKey": idempotency_key }));
    let outcome = match result.as_ref().ok().and_then(|r| r.get("outcome")).and_then(Value::as_str) {
        Some(o @ ("reset" | "alreadyRedeemed" | "nothingToReset" | "noCredit")) => o,
        _ => {
            // 응답을 못 받아도 서버에서 사용됐을 수 있다. 기존 잔량 캐시는 무효화한다.
            cache().lock().unwrap_or_else(|e| e.into_inner()).remove(email);
            return json!({ "outcome": "error", "error": result.err().unwrap_or("unavailable") });
        }
    };
    let row = fill_locked(email);
    json!({ "outcome": outcome, "usage": usage_row(email, &row) })
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
            usage_row(&email, &row)
        })
        .collect();
    Value::Array(rows)
}

pub fn refresh_accounts_usage() -> Value {
    cache().lock().unwrap_or_else(|e| e.into_inner()).clear();
    accounts_usage()
}

/// BUG-0013 — 구독 변경 직후의 되싱크: **토큰을 새로 받은 뒤** 다시 묻는다.
///
/// 플랜·초기화권은 계정 폴더 `auth.json`의 토큰으로 서버에 묻는 값이다. Codex CLI는 그 토큰을
/// access_token 만료 5분 전·`last_refresh` 8일 경과·401 때만 스스로 갱신하므로(codex-rs
/// `login/src/auth/manager.rs`), 웹에서 구독을 바꿔도 여기 토큰은 옛 플랜을 문다(실측: 구독
/// 뒤 90분 동안 「Free · 초기화권 확인 불가」). OAuth refresh를 앱이 직접 하지 않는 이유:
/// refresh_token 회전을 실행 중인 codex 세션과 맞춰야 한다 — app-server의
/// `account/read {refreshToken:true}`는 codex 자신이 갱신·저장하므로 그 부담이 없다
/// (0.154.0 실측 응답 `{account:{type,email,planType}}`).
///
/// 순서: `account/read`(토큰 갱신) → 폴더의 새 auth.json을 스토어에 되싱크(`sync_account`,
/// 다음 물질화가 옛 토큰으로 되돌리지 않게) → 캐시 행 폐기 → [`fill_locked`](rateLimits/read
/// + `resync_plan`). 갱신에 실패해도 조회는 한다 — 옛 토큰으로도 답이 올 수 있고, 실패는 빈
/// 행(=「못 얻었다」)으로 나간다. `tokenRefreshed`는 폴더의 `last_refresh`가 실제로 전진했는가다.
/// 부르는 곳: 웹 구독 확인 완료(`subscriptions.rs` worker)와 초기화권 대화상자·플랜 줄의 새로고침.
pub fn refresh_account(email: &str) -> Value {
    let gate = account_gate(email);
    let _guard = gate.lock().unwrap_or_else(|e| e.into_inner());
    let refreshed = instrument(email).is_some_and(|home| {
        let auth_path = home.join("auth.json");
        let freshness = || ccg_auth::codex::auth_freshness(std::fs::read_to_string(&auth_path).ok().as_deref());
        let before = freshness();
        if rpc(&home, "account/read", json!({ "refreshToken": true })).is_err() {
            return false;
        }
        let after = freshness();
        ccg_auth::codex::sync_account(email);
        after > before
    });
    cache().lock().unwrap_or_else(|e| e.into_inner()).remove(email);
    let row = fill_locked(email);
    let mut out = usage_row(email, &row);
    out["tokenRefreshed"] = json!(refreshed);
    out
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
    rpc(home, "account/rateLimits/read", json!({})).ok().map(|r| parse(&r))
}

fn rpc(home: &Path, method: &str, params: Value) -> Result<Value, &'static str> {
    // 하네스·재생 주행의 킬 스위치. `parity::codex::query`와 **같은 스위치**를 본다.
    if ccg_auth::net::disabled() {
        return Err("unavailable");
    }
    // ★R28c CPATH — 스폰 인자도 같은 해석을 지난다(`instrument`가 이미 `Some`을 봤다).
    let bin = crate::engine::codex_versions::spawn_bin();
    let mut cmd = ccg_engine::codex::driver::command_for(&bin);
    cmd.env("CODEX_HOME", home);
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|_| "unavailable")?;

    let out = (|| -> Result<Value, &'static str> {
        let mut stdin = child.stdin.take().ok_or("unavailable")?;
        let stdout = child.stdout.take().ok_or("unavailable")?;
        let init = json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "clientInfo": { "name": "agentcodegui", "title": "AgentCodeGUI", "version": "3.0.0" },
                "capabilities": { "experimentalApi": true }
            }
        });
        let ask = json!({ "jsonrpc": "2.0", "id": 2, "method": method, "params": params });
        writeln!(stdin, "{init}").map_err(|_| "unavailable")?;
        stdin.flush().map_err(|_| "unavailable")?;

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
            let left = deadline.checked_duration_since(Instant::now()).ok_or("unavailable")?;
            let line = rx.recv_timeout(left).map_err(|_| "unavailable")?;
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            if v.get("id").and_then(Value::as_i64) == Some(1) {
                if v.get("error").is_some() { return Err("unavailable"); }
                writeln!(stdin, "{}", json!({ "method": "initialized" })).map_err(|_| "unavailable")?;
                writeln!(stdin, "{ask}").map_err(|_| "unavailable")?;
                stdin.flush().map_err(|_| "unavailable")?;
                continue;
            }
            if v.get("id").and_then(Value::as_i64) != Some(2) {
                continue;
            }
            // 오류 응답은 「못 얻었다」다 — 빈 목록(=풀렸다)으로 접으면 안 된다.
            if let Some(error) = v.get("error") {
                return Err(if error.get("code").and_then(Value::as_i64) == Some(-32601) { "unsupported" } else { "unavailable" });
            }
            return v.get("result").cloned().ok_or("unavailable");
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
    let rl = &result["rateLimits"];
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
    json!({ "planType": rl.get("planType").and_then(Value::as_str), "windows": out,
            "rateLimitResetCredits": parse_reset_credits(&result["rateLimitResetCredits"]) })
}

fn parse_reset_credits(value: &Value) -> Value {
    let Some(count) = value.get("availableCount").and_then(Value::as_u64).filter(|n| *n <= 9_007_199_254_740_991) else {
        return Value::Null;
    };
    let credits = value.get("credits").and_then(Value::as_array).map(|rows| rows.iter().filter_map(|r| {
        let id = r.get("id").and_then(Value::as_str).filter(|id| !id.is_empty())?;
        Some(json!({ "id": id, "resetType": r.get("resetType").and_then(Value::as_str).unwrap_or("unknown"),
            "status": r.get("status").and_then(Value::as_str).unwrap_or("unknown"),
            "grantedAt": r.get("grantedAt").and_then(Value::as_i64)?,
            "expiresAt": r.get("expiresAt").and_then(Value::as_i64),
            "title": r.get("title").and_then(Value::as_str), "description": r.get("description").and_then(Value::as_str) }))
    }).collect::<Vec<_>>());
    json!({ "availableCount": count, "credits": credits })
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

    /// ★R28c CPATH — 프로세스 전역 환경 한 칸을 잠깐 바꾸고 **반드시 되돌리는** 증표.
    /// `CCG_HOME`에 [`ccg_store::testhome`]가 있는 것과 같은 이유다(그쪽이 자물쇠를 쥐므로
    /// 이 증표는 **언제나 그 증표와 함께** 쓴다 — 혼자 쓰면 병렬 테스트가 서로의 환경을 본다).
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

    /// 「이 컴퓨터에 codex가 깔려 있는가」에 답이 흔들리지 않게 **없는 실행본**을 못 박는다.
    /// (★R28c CPATH 전에는 `is_file()`이 그 못이었다 — 전역 설치 판에서만 다르게 도는
    /// 테스트는 게이트가 아니다.)
    fn no_codex_here() -> EnvGuard {
        EnvGuard::set("CCG_CODEX_BIN", std::env::temp_dir().join("ccg-no-such-codex.exe"))
    }

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

    #[test]
    fn reset_balance_distinguishes_unknown_zero_and_partial_details() {
        let _h = ccg_store::testhome::take("codex-reset-balance");
        assert_eq!(parse(&json!({}))["rateLimitResetCredits"], Value::Null);
        assert_eq!(parse_reset_credits(&json!({ "availableCount": -1 })), Value::Null);
        assert_eq!(parse_reset_credits(&json!({ "availableCount": 0, "credits": [] })),
            json!({ "availableCount": 0, "credits": [] }));
        assert_eq!(parse_reset_credits(&json!({ "availableCount": 3 })),
            json!({ "availableCount": 3, "credits": Value::Null }));
        let details = json!({ "availableCount": 7, "credits": [{ "id": "reset-1", "resetType": "codexRateLimits",
            "status": "available", "grantedAt": 1781654400i64, "expiresAt": 1784246400i64,
            "title": "Referral reward", "description": "Usage reset" }] });
        // 한도 창 자체가 없어도 보유량은 보존하고 IPC 행에 실어 보낸다.
        let row = parse(&json!({ "rateLimitResetCredits": details }));
        assert_eq!(row["rateLimitResetCredits"], details);
        assert_eq!(usage_row("one@example.com", &row)["rateLimitResetCredits"]["availableCount"], 7);
    }

    #[test]
    fn reset_requests_require_an_explicit_account_key_and_online_access() {
        let h = ccg_store::testhome::take("codex-reset-guard");
        let _b = no_codex_here();
        assert_eq!(consume_reset_credit("", "test-key")["error"], "invalidRequest");
        assert_eq!(consume_reset_credit("one@example.com", "  ")["error"], "invalidRequest");
        let _offline = EnvGuard::set("CCG_NO_NET", "1");
        assert_eq!(consume_reset_credit("one@example.com", "test-key")["error"], "unavailable");
        assert!(!h.dir.join("codex/accounts").exists());
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
        // ★R28c CPATH — 「실행본이 없는 판」을 못 박는다. 이 못이 없으면 전역 PATH에
        // codex가 있는 컴퓨터에서 이 테스트가 **진짜 app-server를 띄운다**(12초 마감 × 계정 수).
        let _b = no_codex_here();
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

    /// BUG-0013 — 토큰 재발급 경로의 문. 창구가 없으면(실행본 없음·미등록) 갱신은 거짓이고
    /// 행은 빈 행(=「못 얻었다」)이다 — 실홈으로 새지도, 계정 폴더를 물질화하지도 않는다.
    #[test]
    fn refresh_account_without_an_instrument_reports_no_refresh_and_an_empty_row() {
        let h = ccg_store::testhome::take("codex-limit-refresh");
        let _b = no_codex_here();
        let v = refresh_account("ghost@openai.com");
        assert_eq!(v["email"], "ghost@openai.com");
        assert_eq!(v["tokenRefreshed"], false);
        assert_eq!(v["windows"], json!([]));
        assert_eq!(v["planType"], Value::Null);
        assert_eq!(v["rateLimitResetCredits"], Value::Null);
        assert!(!h.dir.join("codex").join("accounts").exists());
    }

    /// BUG-0013 — 재발급 경로의 **행복한 길**을 가짜 app-server로 끝까지 밟는다: `account/read`가
    /// 계정 폴더의 auth.json을 새 토큰(pro)으로 바꾸면 → 스토어(authEnc)가 따라오고 → 캐시를
    /// 버린 뒤 `rateLimits/read`가 새 플랜을 답하고 → 스토어 `plan`이 free→pro로 되싱크된다.
    /// 가짜는 `.cmd` → node 스크립트다(실행본 스폰 경로 `command_for`를 그대로 지난다).
    #[test]
    fn refresh_account_rotates_the_token_resyncs_the_store_and_reads_the_new_plan() {
        if std::process::Command::new("node").arg("--version").output().map(|o| !o.status.success()).unwrap_or(true) {
            eprintln!("skip: node not on PATH — the fake app-server needs it");
            return;
        }
        let h = ccg_store::testhome::take("codex-limit-refresh-happy");
        let id_token = |plan: &str| {
            let payload = json!({ "email": "p@openai.com", "https://api.openai.com/auth": { "chatgpt_plan_type": plan } }).to_string();
            let b64 = ccg_store::safe_storage::b64_encode(payload.as_bytes()).replace('+', "-").replace('/', "_").replace('=', "");
            format!("h.{b64}.s")
        };
        // 가짜 app-server — 프로세스 하나가 initialize + 요청 하나를 받는다(`rpc`의 규약).
        let fake = h.dir.join("fake-codex");
        std::fs::create_dir_all(&fake).unwrap();
        let script = r#"
import fs from 'node:fs'
import readline from 'node:readline'
const home = process.env.CODEX_HOME
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
readline.createInterface({ input: process.stdin }).on('line', (l) => {
  let v; try { v = JSON.parse(l) } catch { return }
  if (v.id == null) return
  if (v.method === 'initialize') return out({ id: v.id, result: {} })
  if (v.method === 'account/read') {
    if (v.params && v.params.refreshToken) {
      const p = home + '/auth.json'
      const a = JSON.parse(fs.readFileSync(p, 'utf8'))
      a.tokens.id_token = '__NEW_ID_TOKEN__'
      a.tokens.access_token = 'at-new'
      a.last_refresh = '2026-09-11T07:00:00.000Z'
      fs.writeFileSync(p, JSON.stringify(a))
    }
    return out({ id: v.id, result: { account: { type: 'chatgpt', email: 'p@openai.com', planType: 'pro' }, requiresOpenaiAuth: true } })
  }
  if (v.method === 'account/rateLimits/read') {
    return out({ id: v.id, result: {
      rateLimits: { planType: 'pro', primary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: 1789711224 }, secondary: null },
      rateLimitResetCredits: { availableCount: 0, credits: [] } } })
  }
  out({ id: v.id, error: { code: -32601, message: 'unsupported' } })
})
"#
        .replace("__NEW_ID_TOKEN__", &id_token("pro"));
        std::fs::write(fake.join("fake-app-server.mjs"), script).unwrap();
        let bin = if cfg!(windows) {
            let p = fake.join("codex.cmd");
            std::fs::write(&p, "@echo off\r\nnode \"%~dp0fake-app-server.mjs\"\r\n").unwrap();
            p
        } else {
            let p = fake.join("codex");
            std::fs::write(&p, "#!/bin/sh\nexec node \"$(dirname \"$0\")/fake-app-server.mjs\"\n").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
            p
        };
        let _b = EnvGuard::set("CCG_CODEX_BIN", &bin);

        // 로그인 당시 토큰은 free — 스토어 plan도 free로 편입된다(BUG-0013의 출발 상태).
        let seed = h.dir.join("seed-auth");
        std::fs::create_dir_all(&seed).unwrap();
        std::fs::write(
            seed.join("auth.json"),
            json!({ "tokens": { "id_token": id_token("free"), "access_token": "at" }, "last_refresh": "2026-09-11T06:00:00.000Z" }).to_string(),
        )
        .unwrap();
        assert_eq!(ccg_auth::codex::import_account_from_dir(&seed).as_deref(), Some("p@openai.com"));
        assert_eq!(ccg_auth::codex::read_store_file().accounts[0]["plan"], "free");

        let v = refresh_account("p@openai.com");
        assert_eq!(v["tokenRefreshed"], true, "{v}");
        assert_eq!(v["planType"], "pro");
        assert_eq!(v["windows"].as_array().map(Vec::len), Some(1));
        assert_eq!(v["rateLimitResetCredits"]["availableCount"], 0);
        // 스토어 plan이 되싱크됐다 — 목록(`codex-auth:list-accounts`)이 다음부터 pro를 낸다.
        assert_eq!(ccg_auth::codex::read_store_file().accounts[0]["plan"], "pro");
        // 스토어 authEnc도 새 토큰이다 — 폴더를 지우고 다시 물질화해도 07:00 토큰이 나온다.
        let dir = ccg_auth::codex::account_dir("p@openai.com");
        std::fs::remove_file(dir.join("auth.json")).unwrap();
        let dir = ccg_auth::codex::account_run_dir("p@openai.com").unwrap();
        let raw = std::fs::read_to_string(dir.join("auth.json")).unwrap();
        assert!(raw.contains("2026-09-11T07:00:00.000Z"), "{raw}");
        assert_eq!(ccg_auth::codex::parse_auth(Some(&raw)).and_then(|i| i.plan).as_deref(), Some("pro"));
        // 캐시에는 새 행이 앉아 있다 — 다음 목록 조회는 프로세스 없이 이 값을 낸다.
        assert_eq!(accounts_usage()[0]["planType"], "pro");
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
        let _b = no_codex_here();
        assert!(!can_ask("ghost@openai.com"));
        assert!(instrument("ghost@openai.com").is_none());
        assert!(
            !h.dir.join("codex").join("accounts").exists(),
            "★ 판정 한 번이 계정 폴더를 물질화했다 — 허브 스레드에서 도는 경로다"
        );
    }

    /// ★R28c CPATH — **전역 PATH의 codex도 창구다.** R28b 확인 크리틱 R1 §3이 A/B로 잰
    /// 그 판(`CCG_CODEX_BIN=codex` = `codex_bin()`의 폴백값)을 단위로 잠근다.
    ///
    /// 고치기 전에는 이 판에서 `can_ask`가 **거짓**이었고(=「물어볼 창구가 없다」=옛 계약),
    /// 그래서 codex 채팅이 한도를 한 번도 안 묻고 t=90초에 발사했다. 같은 이유로
    /// [`accounts_usage`]도 빈 창만 냈다(설정 ▸ Account의 OpenAI 게이지).
    #[test]
    fn a_codex_found_on_the_global_path_is_an_instrument_too() {
        let h = ccg_store::testhome::take("codex-limit-path");
        // PATH에 실물 하나(맨 이름으로만 닿는다) — 확장자는 셸이 보는 그것이다.
        let dir = h.dir.join("fakepath");
        std::fs::create_dir_all(&dir).unwrap();
        let ext = if cfg!(windows) { ".cmd" } else { "" };
        std::fs::write(dir.join(format!("codex{ext}")), "@echo off\n").unwrap();
        let _p = EnvGuard::set("PATH", std::env::join_paths([dir]).unwrap());
        let _b = EnvGuard::set("CCG_CODEX_BIN", "codex");

        // 등록 계정 하나(복호 가능한 authEnc — 스토어가 직접 만든다).
        let seed = h.dir.join("seed-auth");
        std::fs::create_dir_all(&seed).unwrap();
        let payload = json!({ "email": "p@openai.com",
                              "https://api.openai.com/auth": { "chatgpt_plan_type": "plus" } })
        .to_string();
        let b64 = ccg_store::safe_storage::b64_encode(payload.as_bytes())
            .replace('+', "-")
            .replace('/', "_")
            .replace('=', "");
        std::fs::write(
            seed.join("auth.json"),
            json!({ "tokens": { "id_token": format!("h.{b64}.s"), "access_token": "at" } }).to_string(),
        )
        .unwrap();
        assert_eq!(ccg_auth::codex::import_account_from_dir(&seed).as_deref(), Some("p@openai.com"));

        // ★ 이 두 줄이 R28b까지 거짓이었다.
        assert!(can_ask("p@openai.com"), "★ 전역 PATH codex를 창구로 안 봤다 = 눈감고 발사");
        assert!(instrument("p@openai.com").is_some(), "★ 게이지가 물어볼 홈을 못 얻었다");
        // 문 하나가 열렸다고 다 열리는 것은 아니다 — 등록되지 않은 계정은 여전히 아니다.
        assert!(!can_ask("ghost@openai.com"));
    }

    /// 그 판의 **대조군**: PATH에도 없으면 창구가 없다(= 옛 계약 그대로 `Unknown`).
    /// 이것이 초록이어야 위 테스트가 "전부 참으로 만들어 통과시킨 것"이 아니다.
    #[test]
    fn a_codex_that_is_nowhere_is_still_no_instrument() {
        let h = ccg_store::testhome::take("codex-limit-nopath");
        let empty = h.dir.join("emptypath");
        std::fs::create_dir_all(&empty).unwrap();
        let _p = EnvGuard::set("PATH", std::env::join_paths([empty]).unwrap());
        let _b = EnvGuard::set("CCG_CODEX_BIN", "codex");
        ccg_auth::codex::write_store_file(&[json!({ "email": "p@openai.com", "plan": "plus" })], None);
        assert!(!can_ask("p@openai.com"));
        assert!(instrument("p@openai.com").is_none());
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
