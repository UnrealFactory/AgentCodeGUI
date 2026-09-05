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
    let _ = chats_save(&stale);
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
    let _ = chats_save(&blob);
    let disk = h.read_json(&format!("chats-v3/{victim}.json")).unwrap();
    assert_eq!(disk["identity"]["engine"]["model"], "haiku", "진짜 편집이 무시됐다");
}

/// ★R28 ACCT R2(F2) — **되돌리기가 정체성에 닿는다.**
///
/// 확인 크리틱 R1 F2의 실 exe 실측: 계정 전환(one→two) 뒤 「되돌리기」를 누르면 화면은
/// one으로 돌아오는데 `chats-v3/<id>.json`의 `identity.billing.account`는 two로 남았고,
/// 재시작하면 chip이 two이며 실제 턴도 two로 돌았다.
///
/// 기제는 에코 가드의 **구조적 비대칭**이었다: 되돌린 값 = 마지막 투영값이라 지문이
/// 같아져 「에코」로 분류됐다. 전환은 통과하고 되돌리기만 막힌다.
#[test]
fn undoing_an_account_switch_reaches_the_identity_not_just_the_screen() {
    let h = migrated("bridge-undo");
    let blob = chats_get(false, &[]);
    let victim = ids_of(&blob).into_iter().next().unwrap();
    let account_of = |b: &Value| -> String {
        b.get("chats")
            .and_then(Value::as_array)
            .and_then(|a| a.iter().find(|c| c["id"] == json!(victim.clone())))
            .and_then(|c| c["picker"]["account"].as_str())
            .unwrap_or("")
            .to_string()
    };
    let origin = account_of(&blob);
    let save_with = |account: &str| {
        let mut b = blob.clone();
        for c in b["chats"].as_array_mut().unwrap() {
            if c["id"] == json!(victim.clone()) {
                c["picker"]["account"] = json!(account);
            }
        }
        let _ = chats_save(&b);
    };
    // ① 전환 — one → two. (지문이 다르니 R1에서도 통과하던 팔)
    save_with("two@ccg.test");
    let disk = h.read_json(&format!("chats-v3/{victim}.json")).unwrap();
    assert_eq!(disk["identity"]["billing"]["account"], "two@ccg.test", "전환 자체가 안 실렸다");
    // ② 되돌리기 — **사이에 `chats:get`을 끼우지 않는다**(크리틱이 실측한 그 순서다.
    //    조회가 한 번 끼면 투영 지문이 갱신돼 R1에서도 우연히 먹었다).
    save_with(&origin);
    let disk = h.read_json(&format!("chats-v3/{victim}.json")).unwrap();
    println!("[F2] 되돌린 뒤 디스크 identity = {}", disk["identity"]);
    assert_eq!(
        disk["identity"]["billing"]["account"],
        json!(origin),
        "★ 되돌리기가 화면만 되돌렸다 — 재시작하면 실수한 계정으로 실행된다"
    );
}

#[test]
fn an_echoed_payload_leaves_the_identity_untouched() {
    let h = migrated("bridge-echo");
    let blob = chats_get(false, &[]);
    let victim = ids_of(&blob).into_iter().next().unwrap();
    let before = h.read_json(&format!("chats-v3/{victim}.json")).unwrap()["identity"].clone();
    let _ = chats_save(&blob);
    let _ = chats_save(&blob);
    assert_eq!(h.read_json(&format!("chats-v3/{victim}.json")).unwrap()["identity"], before);
}

// ── C1·C2 prune 칸막이 ─────────────────────────────────────────────────────
#[test]
fn saving_the_main_chat_list_never_touches_panels_or_extra_chats() {
    let h = migrated("bridge-partition");
    let before = threads(&h);
    let blob = chats_get(false, &[]);
    assert!(ids_of(&blob).iter().all(|i| !i.starts_with("ma-")), "패널이 본채팅 목록에 샜다");
    let _ = chats_save(&blob);
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
    let _ = chats_save(&blob);
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
    let _ = chats_save(&blob);
    assert!(h.path("chats-v3/rust-made.json").is_file(), "origin 없는 레코드가 낡은 저장 한 번에 삭제됐다");
}

// ── C4 보드 칸막이 ─────────────────────────────────────────────────────────
#[test]
fn clearing_a_panel_keeps_its_chat_address_and_does_not_dispose_a_new_run() {
    let h = migrated("bridge-clear-run");
    let mut cleared = ma_get(false);
    let board = cleared["sessions"].as_array_mut().unwrap().iter_mut().find(|s| s["id"] == "sess-A").unwrap();
    let chat = crate::boards::read_board(&json!("sess-A"))["slots"][0].as_str().unwrap().to_string();
    board["panels"][0]["title"] = json!("");
    board["panels"][0]["snapshot"] = json!({ "messages": [], "session": null });

    // Clear's debounced save can arrive after the next Run has already started.
    // The IPC caller disposes every id returned by ma_save, without a terminal event.
    let removed = ma_save(&cleared);
    assert!(!removed.contains(&chat), "Clear's delayed save would kill the next run: {removed:?}");
    assert_eq!(
        crate::boards::read_board(&json!("sess-A"))["slots"][0], chat,
        "clearing messages must not detach the event destination"
    );
    let disk = h.read_json(&format!("chats-v3/{chat}.json")).unwrap();
    assert_eq!(disk["snapshot"]["messages"], json!([]));
    assert!(disk["snapshot"]["session"].is_null());

    let board = cleared["sessions"].as_array_mut().unwrap().iter_mut().find(|s| s["id"] == "sess-A").unwrap();
    board["panels"][0]["title"] = json!("first message after Clear");
    board["panels"][0]["snapshot"] = snap(1, "new-session");
    assert!(ma_save(&cleared).is_empty());
    assert_eq!(crate::boards::read_board(&json!("sess-A"))["slots"][0], chat);
    assert_eq!(h.read_json(&format!("chats-v3/{chat}.json")).unwrap()["snapshot"], snap(1, "new-session"));
}

#[test]
fn saving_unused_empty_panels_does_not_create_chats() {
    let h = migrated("bridge-empty-seats");
    let mut blob = ma_get(false);
    let board = blob["sessions"].as_array_mut().unwrap().iter_mut().find(|s| s["id"] == "sess-A").unwrap();
    board["panels"][5] = json!({ "title": "", "snapshot": { "messages": [] } });
    assert!(ma_save(&blob).is_empty());
    assert!(crate::boards::read_board(&json!("sess-A"))["slots"][5].is_null());
    assert!(!h.path("chats-v3/ma-sess-A-5.json").exists());
}

#[test]
fn a_partial_ma_save_keeps_boards_it_was_never_handed() {
    let h = migrated("bridge-masubset");
    let before = threads(&h);
    // 이 프로세스는 sess-B를 내준 적이 없다(다른 창·재시작) → 지울 근거가 없다
    let one = json!({ "version": 2, "activeSessionId": "sess-A", "sessions": [ma_session("sess-A", false)] });
    let _ = ma_save(&one);
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
    let _ = ma_save(&json!({ "version": 2, "activeSessionId": "sess-A", "sessions": kept }));
    let boards = crate::boards::read_boards();
    let ids: Vec<&str> = boards["boards"].as_array().unwrap().iter().filter_map(|b| b["id"].as_str()).collect();
    assert!(!ids.contains(&"sess-B"), "렌더러가 지운 세션이 안 지워졌다");
    assert!(!h.path("chats-v3/ma-sess-B-0.json").is_file(), "지운 세션의 패널 채팅이 남았다");
}

#[test]
fn a_marker_session_save_keeps_every_panel() {
    let h = migrated("bridge-mamarker");
    let before = threads(&h);
    let _ = ma_save(&ma_get(true)); // light = 비활성 세션이 마커
    assert_eq!(threads(&h), before, "마커 세션 저장이 패널 대화를 지웠다");
}

#[test]
fn the_alias_round_trip_is_idempotent() {
    let h = migrated("bridge-idem");
    let mut prev = String::new();
    for i in 0..3 {
        let _ = chats_save(&chats_get(false, &[]));
        let _ = ma_save(&ma_get(false));
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
    let _ = chats_save(&blob);
    assert_eq!(h.read_json("chats-v3/c-1.json").unwrap()["legacyAccount"], "u0@x.com");
}

// ── S4 (크리틱 배선 R1 §5) — 추가 채팅 창의 대화가 저장·복원되는가 ────────────
//
// R1은 이 셋(`persist`/`hydrate`/`rename`)이 셸에 상수조차 없어 `__unimplemented`로
// 떨어졌다. 그 라운드가 `session:*`을 배선해 그 창에서 **실제로 대화가 돌기 시작한**
// 뒤였으므로, "Ctrl+Shift+N → 대화 → 창 닫기 = 증발"이 새로 열린 유실 경로였다.

#[test]
fn a_session_window_conversation_survives_persist_and_hydrate() {
    let h = migrated("bridge-s4");
    assert!(is_session_chat("w-1"), "마이그레이션된 추가 채팅이 session 칸에 있다");
    let before = threads(&h);
    // 창은 마운트에서 먼저 hydrate한다 — 그때 우리가 내보낸 옛 필드 묶음이
    // `PROJECTED`에 기억되고, 그게 D1(에코 vs 저자) 판별의 기준이 된다.
    let mount = session_chat_hydrate("w-1");
    assert_eq!(mount["snapshot"]["messages"].as_array().unwrap().len(), 2);

    let ok = session_chat_persist(
        "w-1",
        &json!({
            "title": "창이 붙인 제목", "status": "done",
            "cwd": "C:\\Code\\other", "refDirs": ["C:\\ref"],
            "picker": { "model": "haiku", "effort": "minimal", "mode": "normal" },
            "snapshot": snap(9, "s-w1"), "draft": "쓰다 만 글", "draftImages": [],
            "empty": false, "updatedAt": 42
        }),
    );
    assert!(ok, "persist가 실패했다");

    let rec = h.read_json("chats-v3/w-1.json").unwrap();
    assert_eq!(rec["origin"], "session", "칸이 바뀌면 목록에서 사라진다");
    assert_eq!(rec["snapshot"]["messages"].as_array().unwrap().len(), 9);
    assert_eq!(rec["identity"]["engine"]["model"], "haiku", "picker가 정체성으로 흡수됐다");
    assert_eq!(rec["identity"]["cwd"], "C:\\Code\\other");
    assert_eq!(rec["status"], "done", "얼린 상태의 저자는 이 창이다");
    assert!(rec.get("picker").is_none(), "옛 평평한 필드는 레코드에 안 남는다");

    let hy = session_chat_hydrate("w-1");
    assert_eq!(hy["snapshot"]["messages"].as_array().unwrap().len(), 9);
    assert_eq!(hy["cwd"], "C:\\Code\\other", "본채팅이 아니므로 manualCwd가 아니라 cwd다");
    assert_eq!(hy["picker"]["model"], "haiku");
    assert_eq!(hy["draft"], "쓰다 만 글");
    assert_eq!(hy["refDirs"], json!(["C:\\ref"]));

    // 남의 칸은 이 채널로 못 만진다 — 본채팅 c-1은 origin=chat이다.
    assert!(!session_chat_persist("c-1", &json!({ "snapshot": snap(1, "x") })));
    assert!(session_chat_hydrate("c-1").is_null());
    assert_eq!(
        threads(&h).get("c-1"),
        before.get("c-1"),
        "추가 채팅 저장이 본채팅 스레드를 건드렸다"
    );
}

#[test]
fn persisting_one_session_window_does_not_prune_the_others() {
    // `write_chats`(목록 REPLACE)를 타면 여기서 남의 대화가 통째로 지워진다.
    let h = migrated("bridge-s4-prune");
    let before = threads(&h);
    assert!(before.len() >= 4, "픽스처가 본채팅·패널·추가채팅을 갖고 있다: {before:?}");
    session_chat_persist("w-1", &json!({ "status": "idle", "snapshot": snap(3, "s-w1") }));
    let after = threads(&h);
    for (k, v) in &before {
        if k == "w-1" || k == "index" || k == "status" {
            continue;
        }
        assert_eq!(after.get(k), Some(v), "{k} 의 대화가 갈렸다");
    }
}

#[test]
fn rename_wins_over_the_windows_auto_title() {
    let h = migrated("bridge-s4-rename");
    assert!(session_chat_rename("w-1", "내가 고른 이름"));
    session_chat_persist("w-1", &json!({ "title": "창이 딴 제목", "status": "idle", "snapshot": snap(2, "s-w1") }));
    let rec = h.read_json("chats-v3/w-1.json").unwrap();
    assert_eq!(rec["title"], "내가 고른 이름");
    assert_eq!(rec["custom"], true);
    // 사이드바 목록에도 그 이름이 나간다
    let info = session_chat_infos().into_iter().find(|c| c["id"] == json!("w-1")).unwrap();
    assert_eq!(info["title"], "내가 고른 이름");
    assert!(!session_chat_rename("c-1", "훔치기"), "본채팅은 이 채널로 못 고친다");
}

#[test]
fn a_brand_new_session_chat_lands_in_the_index() {
    // 앱이 새로 만든 추가 채팅(마이그레이션 산물이 아님) — 파일 + index.order 둘 다.
    let h = migrated("bridge-s4-new");
    assert!(session_chat_persist(
        "sc-1700000000000-1",
        &json!({ "title": "새 창", "status": "idle", "cwd": "C:\\Code",
                 "picker": {}, "snapshot": snap(2, "s-new") })
    ));
    let idx = h.read_json("chats-v3/index.json").unwrap();
    let order: Vec<String> = idx["order"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
    assert!(order.contains(&"sc-1700000000000-1".to_string()), "인덱스에 안 들어갔다: {order:?}");
    let ids: Vec<String> = session_chat_infos().iter().map(|c| c["id"].as_str().unwrap().to_string()).collect();
    assert!(ids.contains(&"sc-1700000000000-1".to_string()), "목록에 안 뜬다: {ids:?}");
    // 그 뒤의 본채팅 저장 한 번이 이 레코드를 지우면 안 된다(origin 칸막이).
    let blob = chats_get(false, &[]);
    let _ = chats_save(&blob);
    assert!(h.read_json("chats-v3/sc-1700000000000-1.json").is_some(), "본채팅 저장이 추가 채팅을 prune했다");
}

// ── ★3.0.8 다이얼 오버레이(promo) 왕복 ─────────────────────────────────────
// 보드 다이얼을 줄이며 끌어올린 자리(`app/src/lib/panelLayout.ts`)는 표시 순서(`order`)와 함께 살아야
// 늘릴 때 되돌릴 수 있다. 렌더러는 걷은 오버레이를 `null`로 실어 보내므로 **키가 없을 때만** 지난 값을 쓴다.
#[test]
fn the_dial_overlay_survives_the_board_round_trip_and_null_clears_it() {
    let _h = migrated("bridge-promo");
    let find = |id: &str| -> Value {
        ma_get(false)["sessions"].as_array().unwrap().iter().find(|x| x["id"] == json!(id)).cloned().unwrap()
    };
    let mut s = ma_session("sess-A", false);
    s["promo"] = json!({ "slot": 4, "base": [0, 1, 2, 3, 4, 5] });
    let _ = ma_save(&json!({ "version": 2, "activeSessionId": "sess-A", "sessions": [s] }));
    assert_eq!(find("sess-A")["promo"], json!({ "slot": 4, "base": [0, 1, 2, 3, 4, 5] }), "오버레이가 왕복에서 사라졌다");
    // 키가 없으면(옛 렌더러·마커) 지난 값 유지
    let mut s2 = ma_session("sess-A", false);
    s2.as_object_mut().unwrap().remove("promo");
    let _ = ma_save(&json!({ "version": 2, "activeSessionId": "sess-A", "sessions": [s2] }));
    assert_eq!(find("sess-A")["promo"]["slot"], json!(4), "키 없는 저장이 오버레이를 지웠다");
    // null = 걷음 — 지난 값이 되살아나면 안 된다(늘렸는데 옛 승격이 되돌아오는 사고)
    let mut s3 = ma_session("sess-A", false);
    s3["promo"] = Value::Null;
    let _ = ma_save(&json!({ "version": 2, "activeSessionId": "sess-A", "sessions": [s3] }));
    assert!(find("sess-A").get("promo").is_none(), "걷은 오버레이가 되살아났다");
    // 위생 — 순열이 아니거나 슬롯이 범위 밖이면 없는 것
    assert!(sanitize_promo(Some(&json!({ "slot": 1, "base": [0, 0, 2, 3, 4, 5] }))).is_none());
    assert!(sanitize_promo(Some(&json!({ "slot": 6, "base": [0, 1, 2, 3, 4, 5] }))).is_none());
    assert!(sanitize_promo(Some(&json!({ "slot": 2, "base": [5, 4, 3, 2, 1, 0] }))).is_some());
}
