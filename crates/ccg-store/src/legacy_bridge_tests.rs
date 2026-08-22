//! 별칭 계층의 **대화 증발 자리**를 잠그는 테스트(★R2 D16).
//!
//! 크리틱 R1은 이 모듈에 `cargo test`가 **0개**라고 지적했다 — 마커 병합·소유 되끼움·
//! prune 칸막이가 전부 손으로 돌리는 JS 하네스에만 있었다. 크리틱 공격 A·B1·B2·C1~C5를
//! 그대로 `#[test]`로 옮긴다(홈은 임시 폴더 + `CCG_HOME`).

use super::*;
use crate::testkit::{seed_262, snap, temp_home, threads, Home};

fn migrated(tag: &str) -> Home {
    let h = temp_home(tag);
    seed_262(&h);
    let r = crate::migrate_v3::migrate(false);
    assert_eq!(r["ok"], true, "픽스처 마이그레이션 실패: {r}");
    crate::chats_v3::invalidate();
    crate::boards::invalidate();
    forget_projections();
    h
}

fn ids_of(blob: &Value) -> Vec<String> {
    blob.get("chats")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|c| c.get("id").and_then(Value::as_str).map(str::to_string)).collect())
        .unwrap_or_default()
}

// ── D1 (P3 재발) ────────────────────────────────────────────────────────────
#[test]
fn a_stale_renderer_copy_cannot_revert_the_runtime_identity() {
    let h = migrated("bridge-p3");
    // 렌더러가 목록을 읽어 둔다(폴백 **이전** 사본)
    let stale = chats_get(false, &[]);
    let victim = ids_of(&stale).into_iter().next().unwrap();
    // 턴 중 폴백 — M-LOGIC이 정체성을 갈아 끼운다
    let runtime = json!({
        "engine": { "kind": "claude", "model": "sonnet", "effort": "low", "codexAccount": Value::Null },
        "billing": { "kind": "subscription", "account": "fallback@x.com", "dropEnvKey": false },
        "cwd": "C:\\Code", "addDirs": [], "mode": "auto", "systemPrompt": Value::Null,
        "outputStyle": "Concise", "tools": { "skillOverrides": {}, "deniedMcp": [] }
    });
    crate::chats_v3::set_owned(&victim, "identity", runtime.clone());
    // …그리고 디바운스가 끝난 낡은 사본이 도착한다
    chats_save(&stale);
    let disk = h.read_json(&format!("chats-v3/{victim}.json")).unwrap();
    assert_eq!(disk["identity"], runtime, "낡은 렌더러 사본이 런타임 정체성을 되돌렸다(P3)");
}

#[test]
fn a_real_picker_edit_still_lands() {
    let h = migrated("bridge-edit");
    let mut blob = chats_get(false, &[]);
    let victim = ids_of(&blob).into_iter().next().unwrap();
    // 사람이 모델을 바꿨다 — 에코가 아니므로 번역해 세워야 한다
    for c in blob["chats"].as_array_mut().unwrap() {
        if c["id"] == json!(victim.clone()) {
            c["picker"]["model"] = json!("haiku");
        }
    }
    chats_save(&blob);
    let disk = h.read_json(&format!("chats-v3/{victim}.json")).unwrap();
    assert_eq!(disk["identity"]["engine"]["model"], "haiku", "진짜 편집이 무시됐다");
}

#[test]
fn an_echoed_payload_leaves_the_identity_untouched() {
    let h = migrated("bridge-echo");
    let blob = chats_get(false, &[]);
    let victim = ids_of(&blob).into_iter().next().unwrap();
    let before = h.read_json(&format!("chats-v3/{victim}.json")).unwrap()["identity"].clone();
    chats_save(&blob);
    chats_save(&blob);
    assert_eq!(h.read_json(&format!("chats-v3/{victim}.json")).unwrap()["identity"], before);
}

// ── C1·C2 prune 칸막이 ─────────────────────────────────────────────────────
#[test]
fn saving_the_main_chat_list_never_touches_panels_or_extra_chats() {
    let h = migrated("bridge-partition");
    let before = threads(&h);
    let blob = chats_get(false, &[]);
    assert!(ids_of(&blob).iter().all(|i| !i.starts_with("ma-")), "패널이 본채팅 목록에 샜다");
    chats_save(&blob);
    assert_eq!(threads(&h), before, "남의 칸이 지워졌다");
}

#[test]
fn dropping_one_chat_from_the_payload_prunes_exactly_that_one() {
    let h = migrated("bridge-prune1");
    let before = threads(&h);
    let mut blob = chats_get(false, &[]);
    let drop = ids_of(&blob).into_iter().next().unwrap();
    let kept: Vec<Value> =
        blob["chats"].as_array().unwrap().iter().filter(|c| c["id"] != json!(drop.clone())).cloned().collect();
    blob["chats"] = json!(kept);
    chats_save(&blob);
    let after = threads(&h);
    let lost: Vec<&String> = before.keys().filter(|k| !after.contains_key(*k)).collect();
    assert_eq!(lost, vec![&drop], "prune 범위가 틀렸다");
}

// ── D9 origin=unknown ──────────────────────────────────────────────────────
#[test]
fn records_without_an_origin_are_invisible_and_undeletable() {
    let h = migrated("bridge-unknown");
    // M-LOGIC(코어 write_chats)이 만든 채팅처럼 origin이 없다
    h.write(
        "chats-v3/rust-made.json",
        &json!({ "id": "rust-made", "title": "코어가 만든 채팅", "snapshot": snap(9, "s-rust") }).to_string(),
    );
    let mut idx = h.read_json("chats-v3/index.json").unwrap();
    idx["order"].as_array_mut().unwrap().push(json!("rust-made"));
    h.write("chats-v3/index.json", &idx.to_string());
    crate::chats_v3::invalidate();

    let blob = chats_get(false, &[]);
    assert!(!ids_of(&blob).contains(&"rust-made".to_string()), "origin 없는 레코드가 본채팅 목록으로 샜다");
    chats_save(&blob);
    assert!(h.path("chats-v3/rust-made.json").is_file(), "origin 없는 레코드가 낡은 저장 한 번에 삭제됐다");
}

// ── C4 보드 칸막이 ─────────────────────────────────────────────────────────
#[test]
fn a_partial_ma_save_keeps_boards_it_was_never_handed() {
    let h = migrated("bridge-masubset");
    let before = threads(&h);
    // 이 프로세스는 sess-B를 내준 적이 없다(다른 창·재시작) → 지울 근거가 없다
    let one = json!({ "version": 2, "activeSessionId": "sess-A", "sessions": [ma_session("sess-A", false)] });
    ma_save(&one);
    assert_eq!(threads(&h), before, "안 내준 보드의 패널 대화를 지웠다");
    let boards = crate::boards::read_boards();
    let ids: Vec<&str> = boards["boards"].as_array().unwrap().iter().filter_map(|b| b["id"].as_str()).collect();
    assert!(ids.contains(&"sess-B"), "보드 자체가 사라졌다: {ids:?}");
}

#[test]
fn deleting_a_session_the_renderer_actually_holds_still_works() {
    let h = migrated("bridge-madelete");
    let full = ma_get(false); // ← 여기서 두 보드를 내준다 = 삭제 후보가 된다
    let kept: Vec<Value> =
        full["sessions"].as_array().unwrap().iter().filter(|s| s["id"] != json!("sess-B")).cloned().collect();
    ma_save(&json!({ "version": 2, "activeSessionId": "sess-A", "sessions": kept }));
    let boards = crate::boards::read_boards();
    let ids: Vec<&str> = boards["boards"].as_array().unwrap().iter().filter_map(|b| b["id"].as_str()).collect();
    assert!(!ids.contains(&"sess-B"), "렌더러가 지운 세션이 안 지워졌다");
    assert!(!h.path("chats-v3/ma-sess-B-0.json").is_file(), "지운 세션의 패널 채팅이 남았다");
}

#[test]
fn a_marker_session_save_keeps_every_panel() {
    let h = migrated("bridge-mamarker");
    let before = threads(&h);
    ma_save(&ma_get(true)); // light = 비활성 세션이 마커
    assert_eq!(threads(&h), before, "마커 세션 저장이 패널 대화를 지웠다");
}

#[test]
fn the_alias_round_trip_is_idempotent() {
    let h = migrated("bridge-idem");
    let mut prev = String::new();
    for i in 0..3 {
        chats_save(&chats_get(false, &[]));
        ma_save(&ma_get(false));
        let now = crate::raw_identity::canon_bytes(&json!({
            "chats": crate::chats_v3::read_chats(false, &[]),
            "boards": crate::boards::read_boards(),
        }));
        if i > 0 {
            assert_eq!(now, prev, "별칭 왕복 {i}회차에 스토어가 바뀌었다");
        }
        prev = now;
    }
    assert!(!threads(&h).is_empty());
}

// ── D7 도달성 ──────────────────────────────────────────────────────────────
#[test]
fn migrated_extra_chats_are_reachable_through_the_window_list() {
    let _h = migrated("bridge-reach");
    let infos = session_chat_infos();
    let ids: Vec<&str> = infos.iter().filter_map(|i| i["id"].as_str()).collect();
    assert_eq!(ids, vec!["w-1"], "마이그레이션된 추가 채팅이 어디에도 안 보인다");
    assert_eq!(infos[0]["status"], "done", "얼린 상태가 목록에 안 실렸다");
    assert_eq!(infos[0]["open"], false);
}

// ── D5 계정 보존 왕복 ──────────────────────────────────────────────────────
#[test]
fn the_api_mode_account_survives_a_full_alias_round_trip() {
    let h = temp_home("bridge-apiacct");
    seed_262(&h);
    h.write("ui-prefs.json", r#"{"workspace.mode":"multi","api.mode":true}"#);
    assert_eq!(crate::migrate_v3::migrate(false)["ok"], true);
    crate::chats_v3::invalidate();
    crate::boards::invalidate();
    forget_projections();
    let rec = h.read_json("chats-v3/c-1.json").unwrap();
    assert_eq!(rec["identity"]["billing"]["kind"], "api_key");
    assert_eq!(rec["legacyAccount"], "u0@x.com", "api 모드에서 채팅별 계정이 사라졌다");
    // 되그리기 — 2.6.2 렌더러는 picker.account로 본다
    let blob = chats_get(false, &[]);
    let c = blob["chats"].as_array().unwrap().iter().find(|c| c["id"] == json!("c-1")).unwrap().clone();
    assert_eq!(c["picker"]["account"], "u0@x.com");
    chats_save(&blob);
    assert_eq!(h.read_json("chats-v3/c-1.json").unwrap()["legacyAccount"], "u0@x.com");
}
