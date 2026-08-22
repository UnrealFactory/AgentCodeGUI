//! 골든 테스트 — `docs/design/m-logic.md` §2.3.
//!
//! 이 파일이 깨지면 네 가지를 **같이** 해야 한다:
//! (1) §2.3 정규화 규칙표에 행 추가 (2) 정규화 구현 (3) `RawIdentityPatch`에 리프 추가
//! (4) `m-logic-replay.md` 시나리오 추가.

use ccg_engine::identity::*;
use std::collections::{BTreeMap, BTreeSet};

fn defaults() -> IdentityDefaults {
    IdentityDefaults {
        default_cwd: "C:\\ccg-fixture\\desktop".into(),
        default_account: Some("fixture@example.com".into()),
        known_accounts: BTreeSet::new(),
        api_key: Some("sk-ant-fixture-key".into()),
        env_api_key_present: false,
        env_key_answer: None,
        cwd_probe: CwdProbe::AssumeExists,
    }
}

fn fixture_raw() -> RawIdentity {
    RawIdentity {
        engine: RawEngine {
            kind: EngineKind::Claude,
            model: "fable".into(),
            effort: EffortId::Medium,
            codex_account: None,
        },
        billing: RawBilling {
            kind: BillingKind::Subscription,
            account: Some("fixture@example.com".into()),
            drop_env_key: Some(false),
        },
        cwd: "C:\\ccg-fixture\\work".into(),
        add_dirs: vec![],
        mode: ModeId::Normal,
        system_prompt: None,
        output_style: None,
        tools: RawTools::default(),
    }
}

fn fixture() -> RunIdentity {
    RunIdentity::normalize(fixture_raw(), &defaults()).unwrap()
}

/// 축 8개 동결. 축을 늘리면 여기서 깨진다.
#[test]
fn identity_axis_set_is_frozen() {
    let v = serde_json::to_value(fixture()).unwrap();
    let keys: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
    assert_eq!(
        keys,
        [
            "engine",
            "billing",
            "cwd",
            "addDirs",
            "mode",
            "systemPrompt",
            "outputStyle",
            "tools"
        ]
    );
    // ★ 설계 §2.3의 Rust 코드조각은 이 목록을 snake_case(`add_dirs`…)로 적었지만,
    //   같은 문서 §2.5의 TS 계약면(`RunIdentity`)과 리프 경로(`addDirs`)는 camelCase다.
    //   렌더러가 읽는 쪽(계약면)에 맞췄다 — 두 표기가 동시에 참일 수 없어 하나를 골랐다.
}

/// 리프 15개 동결 + 패치가 실을 수 있는 리프 동결.
#[test]
fn identity_leaf_set_is_frozen() {
    let paths: Vec<&str> = IdentityField::ALL.iter().map(|f| f.path()).collect();
    assert_eq!(
        paths,
        [
            "engine.kind",
            "engine.model",
            "engine.effort",
            "engine.codexAccount",
            "billing.kind",
            "billing.account",
            "billing.dropEnvKey",
            "billing.keyFp",
            "cwd",
            "addDirs",
            "mode",
            "systemPrompt",
            "outputStyle",
            "tools.skillOverrides",
            "tools.deniedMcp",
        ]
    );
    // 패치는 **파생 리프(billing.keyFp)를 뺀 전부**를 실을 수 있어야 한다.
    // 하나라도 빠지면 "그 필드만 바꾸는 명령"이 옆 필드를 덮는다(N2 재발 방지).
    let patchable: Vec<&str> = paths
        .iter()
        .cloned()
        .filter(|p| *p != "billing.keyFp")
        .collect();
    assert_eq!(RawIdentityPatch::leaf_paths(), patchable);
    assert_eq!(paths.len(), 15);
}

/// 저장된 큐/리비전의 해시가 릴리즈 간에 살아야 한다.
#[test]
fn identity_hash_is_stable_across_releases() {
    assert_eq!(fixture().hash(), "3dcd74c21ca4569e95109e9d38719852");
}

/// `normalize(to_raw(x)) == x` — O12 수정판 2단 비교의 전제.
#[test]
fn raw_roundtrip_is_stable() {
    let id = fixture();
    assert_eq!(RunIdentity::normalize(id.to_raw(), &defaults()).unwrap(), id);

    // API 키 경로도 왕복한다(지문은 원시값에 없고 정규화가 계산한다).
    let mut raw = fixture_raw();
    raw.billing = RawBilling {
        kind: BillingKind::ApiKey,
        account: None,
        drop_env_key: None,
    };
    let api = RunIdentity::normalize(raw, &defaults()).unwrap();
    assert_eq!(
        RunIdentity::normalize(api.to_raw(), &defaults()).unwrap(),
        api
    );
}

/// P1b 잠금 — `addDirs`의 순서·중복·대소문자·후행 `\`가 재스폰을 만들면 안 된다.
#[test]
fn add_dirs_order_and_case_do_not_change_identity() {
    let mut a = fixture_raw();
    a.add_dirs = vec!["C:\\Code\\X".into(), "C:\\Code\\Y\\".into()];
    let mut b = fixture_raw();
    b.add_dirs = vec![
        "c:/code/y".into(),
        "C:\\Code\\X".into(),
        "C:\\Code\\X".into(),
    ];
    let ia = RunIdentity::normalize(a, &defaults()).unwrap();
    let ib = RunIdentity::normalize(b, &defaults()).unwrap();
    assert_eq!(ia.hash(), ib.hash());
    assert!(ia.diff(&ib).is_empty());
}

/// P1e 잠금 — 키를 갈면 정체성이 달라져야 한다("옛 키로 계속 과금"이 재스폰으로 드러난다).
#[test]
fn api_key_fingerprint_is_part_of_identity() {
    let mut raw = fixture_raw();
    raw.billing = RawBilling {
        kind: BillingKind::ApiKey,
        account: None,
        drop_env_key: None,
    };
    let d1 = defaults();
    let mut d2 = defaults();
    d2.api_key = Some("sk-ant-OTHER".into());
    let a = RunIdentity::normalize(raw.clone(), &d1).unwrap();
    let b = RunIdentity::normalize(raw, &d2).unwrap();
    assert_ne!(a.hash(), b.hash());
    assert_eq!(a.diff(&b), vec![IdentityField::BillingKeyFp]);
}

/// P1e 잠금 — 스킬/MCP 토글도 정체성이다(2.6.2는 `optsMatch`에 없어 "껐는데 안 꺼짐"이 났다).
#[test]
fn tool_policy_is_part_of_identity() {
    let mut raw = fixture_raw();
    raw.tools.skill_overrides = BTreeMap::from([("dataviz".to_string(), SkillOverride::Disabled)]);
    let a = RunIdentity::normalize(raw.clone(), &defaults()).unwrap();
    assert_eq!(
        fixture().diff(&a),
        vec![IdentityField::ToolsSkillOverrides]
    );
    let mut raw2 = fixture_raw();
    raw2.tools.denied_mcp = vec!["srv".into()];
    let b = RunIdentity::normalize(raw2, &defaults()).unwrap();
    assert_eq!(fixture().diff(&b), vec![IdentityField::ToolsDeniedMcp]);
}

/// 정규화 실패 3종 — 값을 조용히 고치지 않고 사유를 낸다(§4.2).
#[test]
fn normalize_failures_are_typed() {
    let mut d = defaults();
    d.cwd_probe = CwdProbe::Only(BTreeSet::from(["c:\\ccg-fixture\\work".to_string()]));
    let mut raw = fixture_raw();
    raw.cwd = "C:\\nope".into();
    assert_eq!(
        RunIdentity::normalize(raw, &d).unwrap_err().reason(),
        IdentityRejectReason::CwdMissing
    );

    let mut d2 = defaults();
    d2.known_accounts = BTreeSet::from(["a@x".to_string()]);
    assert_eq!(
        RunIdentity::normalize(fixture_raw(), &d2).unwrap_err().reason(),
        IdentityRejectReason::AccountUnavailable
    );

    let mut d3 = defaults();
    d3.api_key = None;
    let mut raw3 = fixture_raw();
    raw3.billing.kind = BillingKind::ApiKey;
    assert_eq!(
        RunIdentity::normalize(raw3, &d3).unwrap_err().reason(),
        IdentityRejectReason::ApiKeyMissing
    );
}

/// §4.2-b 규약 2 — 리프 충돌 판정(접수 seq vs `arm.at_seq`)의 **결정론**.
#[test]
fn leaf_conflict_is_decided_by_receipt_order() {
    let base = fixture();
    let mk = |leaf_seq: u64, patch: RawIdentityPatch| Staged {
        touched_at: RawIdentity::touched(&patch)
            .into_iter()
            .map(|f| (f, leaf_seq))
            .collect(),
        patch,
        base_revision: 0,
        preview: base.clone(),
        policy: ApplyPolicy::AfterTurn,
    };
    let model_patch = RawIdentityPatch {
        engine: EnginePatch {
            model: Some("sonnet".into()),
            ..Default::default()
        },
        ..Default::default()
    };
    let arm = FallbackArm {
        to_model: "opus".into(),
        via: FallbackVia::RefusalFrame,
        at_seq: 10,
    };

    // 2d-i: 패치(5) → 폴백(10)  ⇒ **폴백이 이긴다**(사용자는 폴백 이전 세계를 보고 골랐다)
    let (p, kept) = resolve_fallback_conflicts(&mk(5, model_patch.clone()), &[arm.clone()]);
    assert!(p.engine.model.is_none());
    assert_eq!(kept, vec![IdentityField::EngineModel]);

    // 2d-ii: 폴백(10) → 패치(20) ⇒ **패치가 이긴다**
    let (p, kept) = resolve_fallback_conflicts(&mk(20, model_patch), &[arm.clone()]);
    assert_eq!(p.engine.model.as_deref(), Some("sonnet"));
    assert!(kept.is_empty());

    // 2c: effort만 바꾼 패치는 폴백 model과 **리프가 겹치지 않는다** → 충돌 자체가 없다(N2 잠금)
    let effort_patch = RawIdentityPatch {
        engine: EnginePatch {
            effort: Some(EffortId::High),
            ..Default::default()
        },
        ..Default::default()
    };
    let (p, kept) = resolve_fallback_conflicts(&mk(5, effort_patch), &[arm]);
    assert_eq!(p.engine.effort, Some(EffortId::High));
    assert!(p.engine.model.is_none(), "패치에 model이 실려 있으면 폴백을 삼킨다");
    assert!(kept.is_empty());
}

/// 패치 병합은 **리프 단위 last-write-wins**다(전체 교체가 아니다).
#[test]
fn patch_merge_is_per_leaf() {
    let mut a = RawIdentityPatch {
        billing: BillingPatch {
            account: Some("b@x".into()),
            ..Default::default()
        },
        ..Default::default()
    };
    a.merge_leaves_from(RawIdentityPatch {
        engine: EnginePatch {
            effort: Some(EffortId::High),
            ..Default::default()
        },
        ..Default::default()
    });
    // 둘 다 산다 — 전체 교체였다면 두 번째가 첫 번째를 조용히 삼킨다.
    assert_eq!(a.billing.account.as_deref(), Some("b@x"));
    assert_eq!(a.engine.effort, Some(EffortId::High));
    assert_eq!(
        RawIdentity::touched(&a),
        vec![IdentityField::EngineEffort, IdentityField::BillingAccount]
    );
}

/// 저장 포맷은 **M-UX 매핑 함수**(`ccg-store::raw_identity`)가 쓰는 JSON과 같은 모양이어야 한다.
#[test]
fn raw_identity_json_matches_store_mapper_shape() {
    let v = serde_json::to_value(fixture_raw()).unwrap();
    let keys: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
    assert_eq!(
        keys,
        [
            "engine",
            "billing",
            "cwd",
            "addDirs",
            "mode",
            "systemPrompt",
            "outputStyle",
            "tools"
        ]
    );
    assert_eq!(v["engine"]["kind"], "claude");
    assert_eq!(v["billing"]["dropEnvKey"], false);
    assert_eq!(v["tools"]["skillOverrides"], serde_json::json!({}));
    assert_eq!(v["tools"]["deniedMcp"], serde_json::json!([]));
    // 매핑 함수가 실제로 내는 문자열을 그대로 되읽을 수 있어야 한다.
    let from_store = serde_json::json!({
        "engine": { "kind": "claude", "model": "opus", "effort": "xhigh", "codexAccount": null },
        "billing": { "kind": "subscription", "account": "a@b.c", "dropEnvKey": false },
        "cwd": "", "addDirs": [], "mode": "auto",
        "systemPrompt": null, "outputStyle": null,
        "tools": { "skillOverrides": {}, "deniedMcp": [] }
    });
    let parsed: RawIdentity = serde_json::from_value(from_store).unwrap();
    assert_eq!(parsed.mode, ModeId::Auto);
    assert_eq!(parsed.engine.effort, EffortId::Xhigh);
}
