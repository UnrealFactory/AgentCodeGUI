//! Codex 모델 목록 — `codex:models` (최종 파리티 감사 R1 §3.2 **H4**).
//!
//! ## 실제 손해는 감사가 적은 것보다 **작고**, 그래서 더 조용하다
//!
//! 감사는 *"picker에 모델이 없다"* 고 적었는데 실제로는 비지 않는다 —
//! `Chat.tsx:200`이 빈 목록을 받으면 `codexFallback()`(하드코딩 3종)으로 떨어진다.
//! 진짜 손해는 셋이다: ① 서버가 새 모델(예: 5.7)을 내도 **영영 안 보인다**
//! ② `isDefault`를 몰라 기본 표시가 없다 ③ `efforts`(모델별 지원 reasoning effort)를
//! 몰라 effort 사다리가 근거 없이 돈다.
//!
//! ## 왜 드라이버를 안 쓰고 여기서 직접 말을 거는가
//!
//! `CodexDriver`는 **턴 상태기계**(`codex/transcode.rs`)에 묶여 있다 — thread 생성·
//! 프롬프트·승인 왕복이 한 덩어리다. 모델 목록은 턴이 아니고 채팅에 붙지도 않는다.
//! 그걸 태우려면 가짜 턴을 하나 만들어야 하고, 그 가짜 턴은 상태·이벤트·계정 전환까지
//! 건드린다. 그래서 여기서는 **JSON-RPC 두 줄**(`initialize` → `model/list`)만 주고받고
//! 프로세스를 바로 닫는다. 2.6.2도 같은 두 줄이다(`codex/engine.ts:1450`).
//!
//! `CODEX_HOME`은 기본 계정의 격리 홈이다(`engine::codex_versions::home_for`) —
//! **사용자 실홈으로 새지 않는다**. 목록 조회도 인증이 필요해서 이 한 줄이 곧 계약이다.
//!
//! 캐시는 2.6.2와 같은 **5분**이다. 이 채널은 picker를 열 때마다 불릴 수 있는데,
//! 매번 프로세스를 띄우면 picker 한 번이 수백 ms짜리가 된다.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 2.6.2 `modelCache` 300_000ms.
const TTL: Duration = Duration::from_secs(300);
/// app-server가 두 왕복을 마칠 때까지의 상한. 넘으면 빈 목록 = 렌더러가 폴백을 쓴다.
const DEADLINE: Duration = Duration::from_secs(12);

fn cache() -> &'static Mutex<Option<(Instant, Value)>> {
    static C: std::sync::OnceLock<Mutex<Option<(Instant, Value)>>> = std::sync::OnceLock::new();
    C.get_or_init(|| Mutex::new(None))
}

/// `codex:models()` → `CodexModelInfo[]`.
///
/// 실패는 **던지지 않는다** — 빈 배열이면 렌더러가 `codexFallback()`으로 착지한다
/// (2.6.2도 `catch { return [] }`다). 갱신이 빈 목록이면 **이전 목록을 지킨다**:
/// 잠깐의 네트워크 실패로 picker에서 모델이 사라지는 쪽이 더 나쁘다.
pub fn models() -> Value {
    if let Some((at, v)) = cache().lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        if at.elapsed() < TTL {
            return v.clone();
        }
    }
    let fresh = query();
    let mut g = cache().lock().unwrap_or_else(|e| e.into_inner());
    match (fresh.as_array().map(Vec::len).unwrap_or(0), g.as_ref()) {
        (0, Some((_, prev))) => prev.clone(),
        (0, None) => json!([]),
        _ => {
            *g = Some((Instant::now(), fresh.clone()));
            fresh
        }
    }
}

/// 한 번의 왕복. 프로세스는 이 함수를 벗어나기 전에 반드시 죽는다(아래 `kill`).
fn query() -> Value {
    // 하네스·재생 주행의 킬 스위치(`ccg_auth::net`의 것과 **같은 스위치**를 본다 —
    // "네트워크를 끈 주행"이라는 사실이 두 이름을 갖지 않게).
    if ccg_auth::net::disabled() {
        return json!([]);
    }
    let bin = crate::engine::codex_versions::codex_bin();
    // 계정 격리 홈 — 인자가 아니라 계정 스토어의 산물이다(`home_for`의 규약).
    let home = crate::engine::codex_versions::home_for(&Default::default());

    let mut cmd = ccg_engine::codex::driver::command_for(&bin);
    if let Some(h) = &home {
        cmd.env("CODEX_HOME", h);
    }
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let Ok(mut child) = cmd.spawn() else { return json!([]) };

    let out = (|| -> Option<Value> {
        let mut stdin = child.stdin.take()?;
        let stdout = child.stdout.take()?;
        // 2.6.2 `ensureInitialized` — `experimentalApi`가 없으면 일부 메서드가 거절된다.
        let init = json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "clientInfo": { "name": "agentcodegui", "title": "AgentCodeGUI", "version": "3.0.0" },
                "capabilities": { "experimentalApi": true }
            }
        });
        let list = json!({ "jsonrpc": "2.0", "id": 2, "method": "model/list", "params": {} });
        // 둘을 **연달아** 보낸다. app-server는 id로 응답을 짝지으므로 순서가 어긋나도
        // 우리가 id 2만 골라 읽으면 된다 — 왕복 하나만큼 빨라진다.
        writeln!(stdin, "{init}").ok()?;
        writeln!(stdin, "{list}").ok()?;
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
            return Some(parse(v.get("result").unwrap_or(&Value::Null)));
        }
    })();

    // stdin drop만으로도 app-server는 정리 후 종료하지만, 응답이 안 온 경우(타임아웃)엔
    // 그 정리가 언제 끝날지 모른다 — 우리가 만든 프로세스는 우리가 거둔다.
    let _ = child.kill();
    let _ = child.wait();
    out.unwrap_or_else(|| json!([]))
}

/// `model/list` 결과 → 계약면 `CodexModelInfo[]`. 2.6.2 `engine.ts:1466`의 매핑 그대로.
fn parse(result: &Value) -> Value {
    let Some(data) = result.get("data").and_then(Value::as_array) else { return json!([]) };
    let out: Vec<Value> = data
        .iter()
        // `hidden`은 서버가 "고르게 하지 마라"고 표시한 것 — 그대로 존중한다.
        .filter(|m| m.get("hidden").and_then(Value::as_bool) != Some(true))
        .filter_map(|m| {
            let id = m.get("id").and_then(Value::as_str)?;
            let label = m
                .get("displayName")
                .or_else(|| m.get("model"))
                .and_then(Value::as_str)
                .unwrap_or(id);
            let efforts: Vec<Value> = m
                .get("supportedReasoningEfforts")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|e| e.get("reasoningEffort").and_then(Value::as_str))
                        .map(|s| json!(s))
                        .collect()
                })
                .unwrap_or_default();
            Some(json!({
                "id": id,
                "label": label,
                "desc": m.get("description").and_then(Value::as_str).unwrap_or(""),
                "efforts": efforts,
                "defaultEffort": m.get("defaultReasoningEffort").and_then(Value::as_str).unwrap_or("medium"),
                "isDefault": m.get("isDefault").and_then(Value::as_bool).unwrap_or(false),
            }))
        })
        .collect();
    Value::Array(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 와이어 → 계약면 매핑(2.6.2와 같은 자리에서 같은 값이 나오는가).
    #[test]
    fn the_wire_shape_maps_onto_the_contract_shape() {
        let wire = json!({ "data": [
            {
                "id": "gpt-5.6-terra", "displayName": "GPT-5.6-Terra", "description": "balanced",
                "supportedReasoningEfforts": [{ "reasoningEffort": "low" }, { "reasoningEffort": "high" }],
                "defaultReasoningEffort": "high", "isDefault": true
            },
            // `hidden`은 걸러진다.
            { "id": "gpt-old", "hidden": true },
            // displayName이 없으면 model, 그것도 없으면 id.
            { "id": "gpt-5.7", "model": "gpt-5.7-preview" }
        ]});
        let v = parse(&wire);
        let a = v.as_array().unwrap();
        assert_eq!(a.len(), 2, "hidden이 안 걸러졌다: {v}");
        assert_eq!(a[0]["label"], "GPT-5.6-Terra");
        assert_eq!(a[0]["efforts"], json!(["low", "high"]));
        assert_eq!(a[0]["defaultEffort"], "high");
        assert_eq!(a[0]["isDefault"], json!(true));
        // ★모르는 새 모델이 그대로 통과한다 — 폴백 하드코딩이 못 하는 유일한 일이다.
        assert_eq!(a[1]["id"], "gpt-5.7");
        assert_eq!(a[1]["label"], "gpt-5.7-preview");
        assert_eq!(a[1]["defaultEffort"], "medium", "기본값이 2.6.2와 달라졌다");
        assert_eq!(a[1]["isDefault"], json!(false));
        assert_eq!(a[1]["efforts"], json!([]));
    }

    /// 결과가 없거나 모양이 다르면 **빈 배열**이다(렌더러가 폴백으로 착지한다).
    #[test]
    fn a_broken_result_is_an_empty_list_not_a_panic() {
        assert_eq!(parse(&Value::Null), json!([]));
        assert_eq!(parse(&json!({ "data": "nope" })), json!([]));
        assert_eq!(parse(&json!({ "data": [{ "nope": 1 }] })), json!([]));
    }

    /// `CCG_NO_NET`(하네스·재생 주행)에서는 프로세스를 **한 번도 안 띄운다**.
    #[test]
    fn the_offline_arm_never_spawns_a_process() {
        let _h = ccg_store::testhome::take("parity-codex-nonet");
        std::env::set_var("CCG_NO_NET", "1");
        let v = query();
        std::env::remove_var("CCG_NO_NET");
        assert_eq!(v, json!([]));
    }
}
