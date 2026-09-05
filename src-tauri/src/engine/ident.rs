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
use serde_json::{json, Value};
use std::collections::BTreeSet;

/// 2.6.2 `engine.ts:38-44` 파리티 — 빈 cwd의 대체는 바탕화면.
///
/// ★3.0.8 — **실제 바탕화면**을 묻는다(`SHGetKnownFolderPath(FOLDERID_Desktop)`). 3.0.7까지는
/// `%USERPROFILE%\Desktop`을 글자로 조립했는데, OneDrive 「알려진 폴더 이동」·그룹 정책 리디렉션
/// 계정에서는 그 경로가 **없다**(바탕화면은 `…\OneDrive\Desktop`·`바탕 화면` 등). 그러면 폴더를
/// 안 고른(또는 정체성에 폴더가 비어 저장된) 채팅의 정규화가 `CwdMissing("C:\Users\<me>\Desktop")`로
/// 죽어, 사용자는 고른 적도 없는 폴더를 「찾을 수 없어요」로 듣는다(2026-09-04 제보). 후보를 차례로
/// 실재 확인한다 — 알려진 폴더 → `%USERPROFILE%\Desktop` → `%USERPROFILE%`(항상 있다). 기본값은
/// **있는 폴더**여야 한다 — 없는 경로를 기본값으로 내면 그 뒤의 모든 판정이 거짓 위에 선다.
fn desktop() -> String {
    let profile = std::env::var("USERPROFILE").ok().filter(|p| !p.is_empty());
    let mut candidates: Vec<String> = vec![];
    if let Some(k) = known_desktop() {
        candidates.push(k);
    }
    if let Some(p) = &profile {
        candidates.push(format!("{p}\\Desktop"));
        candidates.push(p.clone());
    }
    candidates
        .into_iter()
        .find(|p| std::path::Path::new(p).is_dir())
        .unwrap_or_else(|| ".".into())
}

/// 셸이 아는 바탕화면(리디렉션 반영). 실패·빈 값은 `None` — 위가 다음 후보로 넘어간다.
#[cfg(windows)]
fn known_desktop() -> Option<String> {
    use windows::Win32::UI::Shell::{SHGetKnownFolderPath, FOLDERID_Desktop, KNOWN_FOLDER_FLAG};
    // SAFETY: 반환 버퍼는 호출자가 `CoTaskMemFree`로 돌려준다(crash.rs의 PWSTR 처리와 같은 규약).
    unsafe {
        let p = SHGetKnownFolderPath(&FOLDERID_Desktop, KNOWN_FOLDER_FLAG(0), None).ok()?;
        if p.is_null() {
            return None;
        }
        let s = p.to_string().ok();
        windows::Win32::System::Com::CoTaskMemFree(Some(p.0 as *const _));
        s.filter(|s| !s.is_empty())
    }
}
#[cfg(not(windows))]
fn known_desktop() -> Option<String> {
    None
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

#[cfg(test)]
mod desktop_tests {
    /// ★3.0.8 — 빈 cwd의 대체는 **실재하는 폴더**여야 한다(OneDrive 리디렉션 계정에서
    /// `%USERPROFILE%Desktop`이 없어 CwdMissing으로 죽던 것 — 2026-09-04 제보).
    #[test]
    fn the_empty_cwd_stand_in_exists() {
        let d = super::desktop();
        assert!(std::path::Path::new(&d).is_dir(), "기본 폴더가 없다: {d}");
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
    let mut raw = serde_json::from_value::<RawIdentity>(id.clone()).ok()?;
    // ★3.0.4 — 디스크에 박힌 자리표시자 모델을 고친다. 3.0.3까지 CLI가 한도 에러 문장을
    // `model:"<synthetic>"` assistant 프레임으로 내면 폴백 감지가 그걸 **모델 전환**으로 읽어
    // 정체성을 `<synthetic>`으로 바꾸고 파일에 내렸다(`set_owned("identity")`). 그 채팅은
    // 재시작 뒤에도 매 스폰이 "There's an issue with the selected model (<synthetic>)"로
    // 죽는다. 감지 쪽은 `runtime.rs::is_placeholder_model`이 막고, 이미 오염된 파일은 여기서
    // 기본 모델로 되돌린다(다른 축 — 계정·폴더·모드 — 은 그대로 둔다).
    if ccg_engine::runtime::is_placeholder_model(&raw.engine.model) {
        raw.engine.model = raw_default(&raw.cwd).engine.model;
    }
    Some(raw)
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
            codex_tier: None,
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
        // ★2026-09-05 — 속도 티어(Fast = "priority"). 요청에 없거나 "default"면 **표준으로 되돌린다**
        // (계정 축과 같은 규약: Codex 요청은 이 축을 항상 지정한다 — 안 그러면 한 번 켠 Fast가 끄기 없이 남는다).
        p.engine.codex_tier = Some(
            req.get("codexTier")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|t| !t.is_empty() && !t.eq_ignore_ascii_case("default"))
                .map(str::to_string),
        );
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
    let mut v = serde_json::to_value(id).unwrap_or(Value::Null);
    // ★3.0.5 — 직렬화는 **접힌 cwd**(정체성 해시 안정용)라, 화면·저장에 그대로 나가면 작업
    // 폴더 이름이 소문자로 보인다. 표시용으로 **원래 대소문자**를 도로 싣는다(해시는 안 건드림).
    if let Some(o) = v.as_object_mut() {
        o.insert("cwd".into(), json!(id.cwd().as_str()));
        o.insert(
            "addDirs".into(),
            json!(id.add_dirs().iter().map(|p| p.as_str()).collect::<Vec<_>>()),
        );
    }
    v
}
