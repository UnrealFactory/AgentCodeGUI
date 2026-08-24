//! 정체성 조립 — 앱 홈(스토어) + 옛 `RunRequest` → `RawIdentity` / `IdentityDefaults`.
//!
//! 두 방향이 있다:
//!  - **디스크에서**: `chats-v3/<id>.json`의 `identity`(마이그레이션이 물질화해 둔 값)를
//!    그대로 읽어 `RawIdentity`로 판다. 이게 3.0의 정상 경로다.
//!  - **옛 렌더러에서**: `claude:run`은 `picker`를 통째로 실어 온다(§6.2 과도기). 그 값을
//!    **패치**로 바꿔 `chat:identity-set`과 같은 문으로 흘린다 — 정체성의 저자를 하나로
//!    두기 위해서다(P2 "picker가 3벌"의 답).
//!
//! `IdentityDefaults`는 **앱 홈의 사실**이다(로그인 계정·전역 키·바탕화면). 채팅마다 다르지
//! 않으므로 한 번 읽어 캐시하고, 계정/키가 바뀌는 채널에서 무효화한다.

use ccg_engine::identity::*;
use serde_json::Value;
use std::collections::BTreeSet;

/// 2.6.2 `engine.ts:38-44` 파리티 — 빈 cwd의 대체는 바탕화면.
fn desktop() -> String {
    std::env::var("USERPROFILE")
        .map(|p| format!("{p}\\Desktop"))
        .unwrap_or_else(|_| ".".into())
}

/// 앱 홈의 사실 묶음. **읽기만** 한다.
pub fn defaults() -> IdentityDefaults {
    // ★R28 ACCT R2(F3) — 파생 기본(맨 위)을 읽기 **전에** 옛 `defaultEmail` 이관을 확정한다.
    // 이 함수도 `accounts.json`을 직접 읽어 `ccg_auth`의 문을 안 지난다. 안 부르면
    // 업그레이드 첫 세션의 **실행 정체성**이 옛 배열의 0번을 기본으로 쓴다(크리틱 F3).
    ccg_auth::claude::ensure_default_migrated();
    ccg_auth::codex::ensure_default_migrated();
    let accounts = ccg_store::read_home_json("accounts.json").unwrap_or(Value::Null);
    // ★R28 ACCT §4 — 기본 계정은 **목록 맨 위**(파생값)다. `defaultEmail`은 더 이상 읽지
    // 않는다: 그 필드를 읽는 자리가 하나라도 남으면 「설정에서 맨 위로 올렸는데 새 채팅은
    // 여전히 옛 계정으로 뜬다」가 된다(파급 전수의 그 자리).
    // 순서 목록은 `known`(BTreeSet)이 아니라 **원문 배열**에서 뜬다 — Set은 정렬돼 있어
    // "맨 위"를 알 수 없다.
    let default_account = accounts
        .get("accounts")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .and_then(|x| x.get("email"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let known: BTreeSet<String> = accounts
        .get("accounts")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| x.get("email").and_then(Value::as_str))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let env_key = std::env::var("ANTHROPIC_API_KEY").ok().filter(|k| !k.is_empty());
    // 전역 키가 있을 때 "구독으로 돌린다"고 답해 뒀는가(§2.3). 답이 없으면 None —
    // 정규화가 안전값(구독)을 쓴다.
    let env_key_answer = env_key
        .as_deref()
        .and_then(ccg_store::api_config::env_key_choice)
        .map(|c| c == "sub");
    // ★M4/O4 — Codex 계정 축(`codex-accounts.json`). Anthropic과 **다른 스토어**다.
    let cx = ccg_store::read_home_json("codex-accounts.json").unwrap_or(Value::Null);
    let known_codex: BTreeSet<String> = cx
        .get("accounts")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| x.get("email").and_then(Value::as_str))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    // ★R28 ACCT §4 — Codex 축도 같은 규약(맨 위 = 기본).
    let default_codex = cx
        .get("accounts")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .and_then(|x| x.get("email"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|e| known_codex.contains(e));
    IdentityDefaults {
        default_cwd: desktop(),
        default_account,
        known_accounts: known,
        default_codex_account: default_codex,
        known_codex_accounts: known_codex,
        // 저장된 API 키 **원문** — 지문 계산과 스폰 env 주입에만 쓰이고 계약면에 안 오른다.
        api_key: ccg_store::api_config::api_key(),
        env_api_key_present: env_key.is_some(),
        env_key_answer,
        cwd_probe: CwdProbe::Fs,
    }
}

/// 채팅 파일의 `identity`(마이그레이션 물질화값) → `RawIdentity`.
/// 없거나 깨졌으면 `None` — 호출부가 옛 렌더러 값으로 물질화한다.
pub fn raw_from_disk(chat_id: &str) -> Option<RawIdentity> {
    let rec = ccg_store::legacy_bridge::chats_load(chat_id);
    let id = rec.get("identity")?;
    if !id.is_object() {
        return None;
    }
    serde_json::from_value::<RawIdentity>(id.clone()).ok()
}

/// 전역값으로 물질화한 최소 정체성(§2.4) — 이 프로세스가 처음 보는 채팅의 출발점.
pub fn raw_default(cwd: &str) -> RawIdentity {
    let g = ccg_store::raw_identity::Globals::read();
    let v = ccg_store::raw_identity::to_raw_identity(
        &serde_json::json!({ "manualCwd": cwd }),
        ccg_store::raw_identity::Source::Chat,
        &g,
    );
    serde_json::from_value::<RawIdentity>(v).unwrap_or_else(|_| RawIdentity {
        engine: RawEngine {
            kind: EngineKind::Claude,
            model: "opus".into(),
            effort: EffortId::Xhigh,
            codex_account: None,
        },
        billing: RawBilling {
            kind: BillingKind::Subscription,
            account: None,
            drop_env_key: Some(false),
        },
        cwd: cwd.to_string(),
        add_dirs: vec![],
        mode: ModeId::Auto,
        system_prompt: None,
        output_style: None,
        tools: RawTools::default(),
    })
}

fn mode_of(s: &str) -> Option<ModeId> {
    Some(match s {
        "normal" => ModeId::Normal,
        "plan" => ModeId::Plan,
        "acceptEdits" => ModeId::AcceptEdits,
        "auto" => ModeId::Auto,
        "bypass" => ModeId::Bypass,
        _ => return None,
    })
}

fn effort_of(s: &str) -> Option<EffortId> {
    Some(match s {
        "minimal" => EffortId::Minimal,
        "low" => EffortId::Low,
        "medium" => EffortId::Medium,
        "high" => EffortId::High,
        "xhigh" => EffortId::Xhigh,
        "max" => EffortId::Max,
        _ => return None,
    })
}

/// 옛 `RunRequest`(2.6.2) → **리프 단위 패치**.
///
/// 실행 요청이 정체성을 실어 오는 것은 2.6.2의 모양이다(picker가 요청마다 붙는다).
/// 3.0에서는 그게 곧 `chat:identity-set`이므로, 여기서 패치로 바꿔 **같은 문**으로 넣는다.
/// 지정되지 않은 축은 건드리지 않는다 — 그래야 "요청 하나가 채팅의 정체성을 통째로
/// 덮어쓰는" 2.6.2의 사고(P1·P2)가 재발하지 않는다.
pub fn patch_from_run_request(req: &Value) -> RawIdentityPatch {
    let mut p = RawIdentityPatch::default();
    let codex = req.get("engine").and_then(Value::as_str) == Some("codex");
    if codex {
        p.engine.kind = Some(EngineKind::Codex);
        // ★M4 — 엔진 전환 패치는 **모델을 반드시 함께** 줘야 한다(§4.2 — 모델 id 공간이
        // 갈린다. 안 주면 `runtime.rs:1035`가 `engine_switch_needs_model`로 튕긴다).
        // 2.6.2도 같은 자리에서 같은 폴백을 썼다(`codex/engine.ts:1564`).
        p.engine.model = Some(
            req.get("codexModel")
                .and_then(Value::as_str)
                .filter(|m| !m.is_empty())
                .unwrap_or("gpt-5.6-terra")
                .to_string(),
        );
        p.engine.codex_account = Some(req.get("codexAccount").and_then(Value::as_str).map(str::to_string));
    } else if let Some(m) = req.get("model").and_then(Value::as_str) {
        p.engine.kind = Some(EngineKind::Claude);
        p.engine.model = Some(m.to_string());
    }
    if let Some(e) = req.get("effort").and_then(Value::as_str).and_then(effort_of) {
        p.engine.effort = Some(e);
    }
    if let Some(m) = req.get("mode").and_then(Value::as_str).and_then(mode_of) {
        p.mode = Some(m);
    }
    if let Some(c) = req.get("cwd").and_then(Value::as_str) {
        if !c.is_empty() {
            p.cwd = Some(c.to_string());
        }
    }
    if let Some(d) = req.get("addDirs").and_then(Value::as_array) {
        p.add_dirs = Some(d.iter().filter_map(Value::as_str).map(str::to_string).collect());
    }
    // systemPrompt: 빈 문자열은 "없음"이다(2.6.2가 그렇게 보낸다).
    match req.get("systemPrompt").and_then(Value::as_str) {
        Some(s) if !s.trim().is_empty() => p.system_prompt = Some(Some(s.to_string())),
        Some(_) => p.system_prompt = Some(None),
        None => {}
    }
    // 과금 축 — `useApi`가 곧 `billing.kind`다(계정은 구독일 때만 의미가 있다).
    if req.get("useApi").and_then(Value::as_bool) == Some(true) {
        p.billing.kind = Some(BillingKind::ApiKey);
    } else if req.get("useApi").is_some() || req.get("account").is_some() {
        p.billing.kind = Some(BillingKind::Subscription);
        if let Some(a) = req.get("account").and_then(Value::as_str) {
            if !a.is_empty() {
                p.billing.account = Some(a.to_string());
            }
        }
    }
    p
}

/// `chat:identity-set`의 JSON 패치 → 타입 패치. 모르는 키는 조용히 무시한다
/// (렌더러가 앞서 나가도 셸이 죽지 않는다 — 계약면 규약).
pub fn patch_from_json(v: &Value) -> RawIdentityPatch {
    serde_json::from_value::<RawIdentityPatch>(v.clone()).unwrap_or_default()
}

/// 정규화값 → 계약면 `RunIdentity`(JSON). picker가 읽는 유일한 진실.
pub fn identity_wire(id: &RunIdentity) -> Value {
    serde_json::to_value(id).unwrap_or(Value::Null)
}
