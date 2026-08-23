//! 재생 회귀 하네스 — 필수 8조합(`docs/design/m-logic-replay.md` §4).
//!
//! 라이브 CLI 없이 상태기계를 때린다: 실와이어 박제 + 스펙 합성 + 가상 시계 + 폴트 주입.
//! 시나리오마다 [`harness::Scen`]이 `close_policy`·`covers`·`kills`·`synth`를 **선언**하고,
//! 러너가 선언대로 밟았는지 검사한다(선언이 거짓말을 못 한다).

mod harness;

use ccg_engine::clock::{MIN, SEC};
use ccg_engine::event::{Event, Verdict};
use ccg_engine::identity::*;
use ccg_engine::live::{AskKind, CloseCause, LiveKind};
use ccg_engine::runtime::Cmd;
use ccg_engine::state::{ResidentWhy, StateTag};
use harness::*;
use serde_json::json;

fn patch_account(a: &str) -> RawIdentityPatch {
    RawIdentityPatch {
        billing: BillingPatch {
            account: Some(a.into()),
            ..Default::default()
        },
        ..Default::default()
    }
}
fn patch_model(m: &str) -> RawIdentityPatch {
    RawIdentityPatch {
        engine: EnginePatch {
            model: Some(m.into()),
            ..Default::default()
        },
        ..Default::default()
    }
}
fn patch_effort(e: EffortId) -> RawIdentityPatch {
    RawIdentityPatch {
        engine: EnginePatch {
            effort: Some(e),
            ..Default::default()
        },
        ..Default::default()
    }
}
fn set_now(p: RawIdentityPatch) -> Cmd {
    Cmd::IdentitySet {
        patch: p,
        policy: ApplyPolicy::Now,
        op: PendingOp::Merge,
    }
}
fn set_deferred(p: RawIdentityPatch) -> Cmd {
    Cmd::IdentitySet {
        patch: p,
        policy: ApplyPolicy::AfterTurn,
        op: PendingOp::Merge,
    }
}

/// 스폰 argv/env에서 계정 격리 폴더를 뽑는다(§8.6 `accountRunDir`).
fn spawn_account_dir(sim: &Sim, n: usize) -> String {
    sim.rt.driver_ref().spawn_specs[n]
        .env_set
        .iter()
        .find(|(k, _)| k == "CLAUDE_CONFIG_DIR")
        .map(|(_, v)| v.clone())
        .unwrap_or_default()
}

// ════════════════════════════════════════════════════════════════════════════
// #1 계정 변경 중 턴 시작 (P4)
// ════════════════════════════════════════════════════════════════════════════


#[test]
fn s01_account_change_midturn_coldstart() {
    let mut sim = Sim::new(&S1, raw("fable", EffortId::Medium, "a@x"));
    assert_eq!(sim.send("작업"), Verdict::Accepted);
    assert_eq!(sim.state(), StateTag::Starting);
    sim.feed(&handshake("smoke"));
    assert_eq!(sim.state(), StateTag::Streaming);
    // 실와이어의 델타·한도정보 프레임(F2·F19) + 같은 session_id의 init 재도착(F1)
    sim.feed(&[
        wire_find("approve", |v| v["event"]["delta"]["type"] == "text_delta"),
        wire_find("approve", |v| v["type"] == "rate_limit_event"),
    ]);
    sim.frame(f_init(&sim.rt.session_id().unwrap()));

    // 턴 중 계정 변경 → 예약(§3.6 명령표의 ⏳ 셀)
    assert_eq!(
        sim.cmd(set_deferred(patch_account("b@x"))),
        Verdict::Deferred("turn_end")
    );
    // 진행 중 턴은 **옛 계정**으로 돈다.
    assert!(spawn_account_dir(&sim, 0).ends_with("a_x"), "1턴은 a@x");

    sim.feed(&[f_assistant_text("네"), f_result_ok("DONE")]);

    // 라이브 항목이 없으므로 착지에서 close_input → Ended → Idle (2.6.2 파리티)
    assert_eq!(sim.state(), StateTag::Idle);
    assert_eq!(sim.rt.identity().account(), Some("b@x"), "착지에서 적용");

    // 브로드캐스트 2회: 예약 통지 + 착지(deferred_apply)
    assert_eq!(
        sim.count(|e| matches!(e, Event::IdentityPending { .. })),
        1
    );
    assert_eq!(
        sim.count(
            |e| matches!(e, Event::Identity { origin, .. } if *origin == ccg_engine::event::RevisionOrigin::DeferredApply)
        ),
        1
    );
    // 폴백이 없었으므로 드리프트도 없다.
    for e in sim.events() {
        if let Event::Identity { drifted, .. } = e {
            assert!(drifted.is_empty());
        }
    }
    // 2턴은 ColdStart — 재사용할 스트림이 없다.
    sim.send("다음");
    sim.feed(&handshake("smoke"));
    assert!(spawn_account_dir(&sim, 1).ends_with("b_x"), "2턴은 b@x");
    assert_eq!(sim.rt.spawns, 2);
    // ★ 정리된 백그라운드가 0개인데 "정리됐어요"는 거짓말이다 — 안내 문구 없음.
    assert_eq!(sim.count(|e| matches!(e, Event::RespawnNotice { .. })), 0);

    sim.feed(&[f_result_ok("DONE2")]);
    sim.finish();
}


#[test]
fn s01b_account_change_with_live_shell_respawns() {
    let mut sim = Sim::new(&S1B, raw("fable", EffortId::Medium, "a@x"));
    sim.send("작업");
    sim.feed(&handshake("smoke"));
    sim.frame(f_bg(&[("bash-1", "local_bash")]));
    assert_eq!(sim.live_ids(), vec!["bash-1"]);

    sim.cmd(set_deferred(patch_account("b@x")));
    sim.feed(&[f_assistant_text("네"), f_result_ok("DONE")]);

    // 원장에 셸이 남아 있으므로 Resident{LiveItems} — close_input 하지 않는다.
    assert_eq!(sim.state(), StateTag::Resident);
    assert_eq!(sim.why(), Some(ResidentWhy::LiveItems));
    assert!(!sim.rt.busy(), "Resident는 busy가 아니다");

    sim.send("다음");
    // 재사용 판정 = Respawn{IdentityChanged['billing.account']}
    let notice = sim
        .events()
        .into_iter()
        .find_map(|e| match e {
            Event::RespawnNotice {
                identity,
                kills,
                text,
                ..
            } => Some((identity, kills, text)),
            _ => None,
        })
        .expect("재스폰 안내 1회");
    assert_eq!(notice.0, vec![IdentityField::BillingAccount]);
    assert_eq!(notice.1, vec![(LiveKind::BgShell, 1)]);
    assert!(notice.2.contains("1개"), "문장에 개수가 들어간다: {}", notice.2);
    assert_eq!(
        sim.settle_reason("bash-1").as_deref(),
        Some("identity_changed:[billing.account]")
    );
    assert_eq!(sim.count(|e| matches!(e, Event::RespawnNotice { .. })), 1);

    sim.feed(&handshake("smoke"));
    sim.feed(&[f_result_ok("DONE2")]);
    sim.finish();
}

// ════════════════════════════════════════════════════════════════════════════
// #2 폴백 직후 계정 변경 (P3+P4) — L3·L4·N2 잠금
// ════════════════════════════════════════════════════════════════════════════


#[test]
fn s02_fallback_then_account_change() {
    let mut sim = Sim::new(&S2, raw("fable", EffortId::Medium, "a@x"));
    sim.send("작업");
    sim.feed(&handshake("smoke"));
    sim.frame(f_bg(&[("bash-1", "local_bash")]));

    // 경로 B' — 같은 to_model의 arm이 없다 → 리비전 1 + 배너 1
    sim.feed(&synth("refusal-fallback"));
    assert_eq!(sim.rt.identity().model(), "opus");
    assert_eq!(sim.banners().len(), 1);

    // 경로 C' — 같은 to_model의 arm이 있다 → **미러만**. R1이면 여기서 두 번째 배너.
    sim.frame(f_assistant_model("opus"));
    assert_eq!(sim.banners().len(), 1, "배너 핑퐁 금지(불변식 13)");

    sim.cmd(set_deferred(patch_account("b@x")));
    sim.feed(&[f_result_ok("DONE")]);

    // 리프가 안 겹치므로 충돌 없음 → 폴백 model이 **그냥 산다**.
    assert_eq!(sim.rt.identity().model(), "opus");
    assert_eq!(sim.rt.identity().account(), Some("b@x"));
    assert_eq!(sim.rt.revision(), 2, "0 Default → 1 EngineFallback → 2 DeferredApply");

    sim.send("다음");
    let ids = sim
        .events()
        .into_iter()
        .find_map(|e| match e {
            Event::RespawnNotice { identity, .. } => Some(identity),
            _ => None,
        })
        .unwrap();
    assert_eq!(
        ids,
        vec![IdentityField::EngineModel, IdentityField::BillingAccount],
        "두 리프 모두 사유에 실린다"
    );
    assert_eq!(
        sim.settle_reason("bash-1").as_deref(),
        Some("identity_changed:[engine.model,billing.account]")
    );
    sim.feed(&handshake("smoke"));
    sim.feed(&[f_result_ok("D2")]);

    // 되돌리기는 히스토리를 지우지 않는다 — 새 리비전이 생긴다.
    let before = sim.rt.revision();
    sim.cmd(Cmd::IdentityRevert { to: 0 });
    assert_eq!(sim.rt.revision(), before + 1);
    assert_eq!(sim.rt.identity().model(), "fable");
    sim.finish();
}


#[test]
fn s02b_drift_is_visible() {
    let mut sim = Sim::new(&S2B, raw("fable", EffortId::Medium, "a@x"));
    sim.send("작업");
    sim.feed(&handshake("smoke"));
    sim.frame(f_bg(&[("bash-1", "local_bash")]));

    sim.cmd(set_deferred(patch_account("b@x"))); // 접수가 폴백보다 **먼저**
    sim.feed(&synth("refusal-fallback"));
    sim.feed(&[f_result_ok("DONE")]);

    assert_eq!(sim.rt.identity().model(), "opus");
    assert_eq!(sim.rt.identity().account(), Some("b@x"));
    let drifted = sim
        .events()
        .into_iter()
        .find_map(|e| match e {
            Event::Identity { drifted, .. } if !drifted.is_empty() => Some(drifted),
            _ => None,
        })
        .expect("미리보기(fable)와 착지(opus)가 갈렸다");
    assert_eq!(drifted, vec![IdentityField::EngineModel]);
    sim.finish();
}


#[test]
fn s02c_effort_only_patch_does_not_swallow_fallback() {
    let mut sim = Sim::new(&S2C, raw("fable", EffortId::Medium, "a@x"));
    sim.send("작업");
    sim.feed(&handshake("smoke"));
    sim.frame(f_bg(&[("bash-1", "local_bash")]));

    sim.cmd(set_deferred(patch_effort(EffortId::High)));
    sim.feed(&synth("refusal-fallback"));
    sim.feed(&[f_result_ok("DONE")]);

    // ★ 이 한 줄이 N2 잠금 전체다. R2 설계였다면 model이 fable로 되돌아갔다.
    assert_eq!(sim.rt.identity().model(), "opus");
    assert_eq!(sim.rt.identity().effort(), EffortId::High);
    let ev = sim.events();
    let drifted = ev
        .iter()
        .find_map(|e| match e {
            Event::Identity { drifted, .. } if !drifted.is_empty() => Some(drifted.clone()),
            _ => None,
        })
        .expect("드리프트 토스트가 떠야 한다");
    assert_eq!(drifted, vec![IdentityField::EngineModel]);
    sim.finish();
}


#[test]
fn s02d_i_fallback_wins_when_patch_came_first() {
    let mut sim = Sim::new(&S2D, raw("fable", EffortId::Medium, "a@x"));
    sim.send("작업");
    sim.feed(&handshake("smoke"));
    sim.cmd(set_deferred(patch_model("sonnet"))); // S1
    sim.feed(&synth("refusal-fallback")); // S2 > S1 → 폴백이 이긴다
    sim.feed(&[f_result_ok("DONE")]);
    assert_eq!(sim.rt.identity().model(), "opus");
    let kept = sim
        .events()
        .into_iter()
        .find_map(|e| match e {
            Event::Identity {
                kept_by_fallback, ..
            } if !kept_by_fallback.is_empty() => Some(kept_by_fallback),
            _ => None,
        })
        .expect("keptByFallback가 실려야 한다");
    assert_eq!(kept, vec![IdentityField::EngineModel]);
    sim.finish();
}

#[test]
fn s02d_ii_patch_wins_when_it_came_after() {
    let mut sim = Sim::new(&S2D, raw("fable", EffortId::Medium, "a@x"));
    sim.send("작업");
    sim.feed(&handshake("smoke"));
    sim.feed(&synth("refusal-fallback")); // S1
    sim.cmd(set_deferred(patch_model("sonnet"))); // S2 > S1 → 패치가 이긴다
    sim.feed(&[f_result_ok("DONE")]);
    assert_eq!(sim.rt.identity().model(), "sonnet");
    let drifted = sim
        .events()
        .into_iter()
        .filter_map(|e| match e {
            Event::Identity { drifted, .. } if !drifted.is_empty() => Some(drifted),
            _ => None,
        })
        .next();
    assert!(drifted.is_none() || drifted == Some(vec![]));
    sim.finish();
}

// ════════════════════════════════════════════════════════════════════════════
// #3 busy 중 채팅 전환 (P7)
// ════════════════════════════════════════════════════════════════════════════


#[test]
fn s03_switch_chat_while_busy() {
    let mut a = Sim::new(&S3, raw("fable", EffortId::Medium, "a@x"));
    let mut b = Sim::new(&S3, raw("fable", EffortId::Medium, "a@x"));
    a.send("A작업");
    a.feed(&handshake("smoke"));
    assert!(a.rt.busy());

    // ★ 2.6.2는 여기서 침묵 no-op이었다(App.tsx:799).
    assert_eq!(a.cmd(Cmd::SwitchChat), Verdict::Accepted);
    assert_eq!(a.cmd(Cmd::NewChat), Verdict::Accepted);
    assert_eq!(b.send("B작업"), Verdict::Accepted);
    b.feed(&handshake("smoke"));

    // 인터리브 배달 — 서로 오염되지 않는다.
    a.feed(&[f_assistant_text("A중")]);
    b.feed(&[f_assistant_text("B중")]);
    b.feed(&[f_result_ok("B끝")]);
    assert!(a.rt.busy(), "B가 끝나도 A는 계속 돈다");
    assert!(!b.rt.busy());
    a.feed(&[f_result_ok("A끝")]);
    assert!(!a.rt.busy());
    a.finish();
    b.finish();
}

// ════════════════════════════════════════════════════════════════════════════
// #4 예약 큐 + 한도 소진 → 자동 이어서 (P5+P6, N3 잠금)
// ════════════════════════════════════════════════════════════════════════════


#[test]
fn s04_queue_plus_limit_hold_resume() {
    let mut sim = Sim::new(&S4, raw("fable", EffortId::Medium, "a@x"));
    sim.send("1"); // spawn#1
    sim.feed(&handshake("smoke"));
    assert_eq!(sim.enqueue("2"), Verdict::Queued);
    assert_eq!(sim.enqueue("3"), Verdict::Queued);
    sim.cmd(set_deferred(patch_model("opus")));

    // 한도 소진 — 2순위 근거(문구 분류)로 장전한다. 1순위 프레임은 아직 미관측(O14).
    sim.frame(f_result_err("Claude usage limit reached · resets at 5pm"));
    assert!(sim.rt.hold().is_some(), "hold 장전");
    // 원장은 비었고 drainable=false(hold가 막는다) → **여기서 닫는 게 맞다**(§3.4-a 3번)
    assert_eq!(sim.state(), StateTag::Idle);
    assert_eq!(sim.rt.queue_len(), 2, "hold 중 드레인 0건");
    assert_eq!(sim.rt.spawns, 1);

    // 한도 해제까지 민다. **딱 그 지점까지만** —
    // 더 밀면 응답 없는 새 스트림이 20s 타임아웃(T3)에 걸린다(그것도 정상 동작이다).
    //
    // ★R5 — 이 문구("… · resets at 5pm")에는 파싱 가능한 리셋 꼬리가 없다 = **시각 미상**.
    // R4까지는 장전이 미상을 `now + 5분`으로 덮어써 6.5분(390s)이 발화 시각이었는데,
    // 그 덮어쓰기가 R14 확인 크리틱 F2의 뿌리였다(5시간 한도에도 "약 5분 뒤"라고 적고
    // 30분에 4회 헛 재개). 이제 미상은 미상으로 두고 2.6.2 `PROBE_MS`(10분) 간격으로
    // 다시 본다 — 시나리오가 잠그는 성질(예약 큐 + 자동 이어서의 순서·이중 전송 없음)은
    // 그대로고, **언제**만 옮겨졌다.
    sim.advance_to(600 * SEC);
    // 재개 항목이 head에 삽입되고(정체성=**지금 값** opus), 계획이 1회 브로드캐스트된다.
    let plans: Vec<_> = sim
        .events()
        .into_iter()
        .filter_map(|e| match e {
            Event::Queue { plan, .. } if !plan.is_empty() => Some(plan),
            _ => None,
        })
        .collect();
    assert_eq!(plans.len(), 1, "드레인 계획 브로드캐스트 1회");
    assert_eq!(plans[0].len(), 2, "그룹 2개(opus 1건 + fable 2건)");
    assert_eq!(plans[0][0].count, 1);
    assert!(!plans[0][0].will_respawn, "Idle에서 시작하는 첫 그룹은 끊을 스트림이 없다");
    assert_eq!(plans[0][1].count, 2);

    // 재개 턴(spawn#2)
    assert_eq!(sim.state(), StateTag::Starting);
    sim.feed(&handshake("smoke"));
    sim.feed(&[f_result_ok("resumed")]);
    // 착지: 큐 2건 → close 보류 → 드레인 → 정체성 불일치(fable ≠ opus) → T17 재스폰(spawn#3)
    sim.feed(&handshake("smoke"));
    sim.feed(&[f_result_ok("2끝")]);
    // 착지: 큐 1건 → close 보류 → **T16 주입**(배칭이 성립하는 자리)
    sim.feed(&[f_result_ok("3끝")]);

    assert_eq!(sim.rt.spawns, 3, "★ 총 spawn 3 — §3.4-a가 없으면 4다");
    assert_eq!(
        sim.count(|e| matches!(e, Event::StateAssign { source: "T16", .. })),
        1,
        "★ T16 주입이 정확히 1회"
    );
    // Linger(0)은 브로드캐스트되지 않는다.
    assert_eq!(
        sim.count(
            |e| matches!(e, Event::RunState { resident_why: Some(ResidentWhy::Linger), .. })
        ),
        0
    );
    let texts = sim.rt.sent_user_texts();
    assert_eq!(
        texts,
        vec!["1", "이어서 진행해 주세요", "2", "3"],
        "순서 보존 + 이중 전송 없음"
    );
    sim.finish();
}


#[test]
fn s04b_account_change_invalidates_hold() {
    let mut sim = Sim::new(&S4B, raw("fable", EffortId::Medium, "a@x"));
    sim.send("1");
    sim.feed(&handshake("smoke"));
    sim.enqueue("2");
    sim.enqueue("3");
    sim.frame(f_result_err("usage limit reached"));
    assert!(sim.rt.hold().is_some());

    sim.cmd(set_now(patch_account("b@x")));
    // ★ 즉시 무효 — due 시각(몇 시간 뒤)을 기다리지 않는다.
    assert!(sim.rt.hold().is_none(), "계정이 바뀌면 대기표는 무효다");
    assert!(sim
        .events()
        .iter()
        .any(|e| matches!(e, Event::Notice(t) if t.contains("대기표를 취소"))));

    // 재개 항목은 삽입되지 않는다 — 큐 head "2"가 옛 계정 스냅샷(a@x)으로 나간다.
    sim.feed(&handshake("smoke"));
    assert!(
        spawn_account_dir(&sim, 1).ends_with("a_x"),
        "keep_snapshot 기본값 — 자동으로 안 바꾼다"
    );
    sim.feed(&[f_result_ok("2끝")]);
    sim.feed(&[f_result_ok("3끝")]);
    assert_eq!(sim.rt.spawns, 2, "총 spawn 2");
    sim.finish();
}


#[test]
fn s04c_interrupt_during_hold_cancels_auto_resume() {
    let mut sim = Sim::new(&S4C, raw("fable", EffortId::Medium, "a@x"));
    sim.send("1");
    sim.feed(&handshake("smoke"));
    sim.enqueue("2");
    sim.enqueue("3");
    // hold를 장전하되 스트림은 살려 둔다(중단 대상이 있어야 하므로 result 대신 rate_limit 프레임).
    sim.feed(&synth("rate-limit-blocked"));
    assert!(sim.rt.hold().is_some());

    assert_eq!(sim.cmd(Cmd::Interrupt), Verdict::Accepted);
    let cleared = sim
        .events()
        .into_iter()
        .find_map(|e| match e {
            Event::QueueCleared {
                count,
                hold_cancelled,
                undo_token,
            } => Some((count, hold_cancelled, undo_token)),
            _ => None,
        })
        .expect("queue_cleared 1회");
    assert_eq!(cleared.0, 2);
    assert!(cleared.1, "hold도 함께 취소 — 문장에 명시된다(N14)");
    assert!(!cleared.2.is_empty());

    sim.frame(f_result_aborted());

    // 되돌리기(토큰 유효 창 안) — 순서·hold 복원, **자동 전송은 없다**
    assert_eq!(
        sim.cmd(Cmd::QueueRestore {
            token: cleared.2.clone()
        }),
        Verdict::Accepted
    );
    assert_eq!(sim.rt.queue_len(), 2);
    assert!(sim.rt.hold().is_some(), "hold도 함께 복원된다");
    assert_eq!(sim.rt.sent_user_texts().len(), 1, "복원이 곧 전송이면 위험하다");

    // 되돌린 대기표를 사용자가 다시 끈다 = **자동 이어서 포기**.
    //
    // ★R2(크리틱 C3): R1은 여기서 `HoldCancel`이 드레인을 깨워 큐 head "2"가 **그 자리에서**
    // 나갔다(`texts == ["1","2"]`). `assert!(sent_after <= 3)`이 그 2건을 통과시켰고,
    // 60분 뒤 추가 전송이 0인 진짜 이유는 hold 의미론이 아니라 **바로 앞 `StopAll`이 큐를
    // 비웠기 때문**이었다 — 시나리오가 잠근다고 말하는 성질을 안 잠갔다.
    // 이제 `StopAll` **전에** 정확값으로 박는다: 게이트만 내려가고 큐는 그대로 남는다.
    assert_eq!(sim.cmd(Cmd::HoldCancel), Verdict::Accepted);
    assert!(sim.rt.hold().is_none(), "대기표는 꺼졌다");
    assert_eq!(
        sim.rt.sent_user_texts(),
        vec!["1"],
        "★ 자동 이어서를 끈 클릭이 전송을 유발하면 안 된다(§7.4 L1)"
    );
    assert_eq!(sim.rt.queue_len(), 2, "큐는 사용자가 다시 보낼 때까지 그대로 있다");

    sim.rt.dispatch(Cmd::StopAll);
    sim.advance_to(60 * MIN);
    // 몇 시간을 밀어도 혼자 나가지 않는다(=시나리오 이름이 약속한 것).
    let sent_after = sim.rt.sent_user_texts().len();
    assert_eq!(
        sent_after, 1,
        "★ 중지 뒤 큐가 혼자 나가면 L1의 최악 형태다: {:?}",
        sim.rt.sent_user_texts()
    );
    // ⚠ 설계 §7.4의 토큰 유효기간은 **5분**인데 hold는 몇 시간짜리다.
    //   즉 §4 #4c의 "advance(resets_at+90s) 뒤 restore"는 두 규칙이 동시에 참일 수 없다.
    //   여기서는 §7.4(5분 만료)를 계약으로 채택하고 만료를 **명시적으로 잠근다**.
    let late = sim.events().into_iter().rev().find_map(|e| match e {
        Event::QueueCleared { undo_token, .. } => Some(undo_token),
        _ => None,
    });
    assert_eq!(
        sim.cmd(Cmd::QueueRestore {
            token: late.unwrap()
        }),
        Verdict::Rejected("undo_expired")
    );
    sim.finish();
}

// ════════════════════════════════════════════════════════════════════════════
// #5 중단 직후 재개 — 픽스처와 SUT의 화해(close_policy 축)
// ════════════════════════════════════════════════════════════════════════════


#[test]
fn s05a_interrupt_then_reuse_same_process() {
    let all = wire("interrupt");
    let mut sim = Sim::new(&S5A, raw("fable", EffortId::Medium, "a@x"));
    sim.send("1턴");
    sim.feed(&all[0..3]); // 핸드셰이크
    sim.feed(&all[3..8]); // 델타 3개
    assert_eq!(sim.cmd(Cmd::Interrupt), Verdict::Accepted);
    assert_eq!(sim.state(), StateTag::Interrupting);
    sim.feed(&all[8..12]); // control_response(int-1) → user → result(aborted_streaming)
    assert_eq!(sim.state(), StateTag::Resident);
    assert_eq!(sim.why(), Some(ResidentWhy::KeepOpen));

    sim.send("2턴");
    assert_eq!(
        sim.count(|e| matches!(e, Event::StateAssign { source: "T16", .. })),
        1
    );
    sim.feed(&all[12..23]);
    sim.send("3턴");
    sim.feed(&all[23..33]);

    assert_eq!(sim.rt.spawns, 1, "재스폰 0 — 같은 프로세스");
    let sid = wire_find("interrupt", |v| v["subtype"] == "init")["session_id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        sim.rt.session_id().as_deref(),
        Some(sid.as_str()),
        "session_id 3턴 내내 불변"
    );
    // run_id 3개, 각각 종결 status 1회 (불변식 3이 자동 검사)
    assert_eq!(sim.count(|e| matches!(e, Event::Status { .. })), 3);
    // 중단 시점의 큐가 **비어 있었으므로** queue_cleared는 0회다.
    // (설계 §4 #5a는 1회라고 적었지만 그 픽스처엔 큐가 없다 — 0건을 "3건 취소했어요"라고
    //  말할 수는 없다. 큐가 있는 경우는 #6·#4c가 잠근다.)
    assert_eq!(sim.count(|e| matches!(e, Event::QueueCleared { .. })), 0);
    sim.finish();
}


#[test]
fn s05b_interrupt_then_cold_start_with_resume() {
    let all = wire("interrupt");
    let mut sim = Sim::new(&S5B, raw("fable", EffortId::Medium, "a@x"));
    sim.send("1턴");
    sim.feed(&all[0..8]);
    sim.cmd(Cmd::Interrupt);
    sim.feed(&all[8..12]);
    // 중단이 큐를 비웠으므로 drainable=false → on_idle이 닫는다.
    assert_eq!(sim.state(), StateTag::Idle);

    sim.send("2턴");
    assert_eq!(sim.rt.spawns, 2);
    let spec = &sim.rt.driver_ref().spawn_specs[1];
    assert!(
        spec.argv.iter().any(|a| a.starts_with("--resume=")),
        "두 번째 spawn argv에 --resume"
    );
    let sid = wire_find("interrupt", |v| v["subtype"] == "init")["session_id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(spec.resume.as_deref(), Some(sid.as_str()));
    sim.feed(&all[12..23]);
    sim.finish();
}

// ════════════════════════════════════════════════════════════════════════════
// #6 백그라운드 살아있는 상태의 중단 (위험 #2 · PoC 미검증 구간)
// ════════════════════════════════════════════════════════════════════════════


#[test]
fn s06_interrupt_with_live_background() {
    let mut sim = Sim::new(&S6, raw("fable", EffortId::Medium, "a@x"));
    sim.send("작업");
    sim.feed(&handshake("smoke"));
    sim.enqueue("나중 것");
    sim.feed(&synth("bg-shell"));
    assert_eq!(sim.live_ids().len(), 2);

    sim.cmd(Cmd::Interrupt);
    sim.frame(f_result_aborted());

    // 중단은 **턴만** 죽인다 — 셸 2개는 정착하지 않는다.
    assert_eq!(sim.live_ids().len(), 2);
    assert_eq!(sim.state(), StateTag::Resident);
    assert_eq!(sim.why(), Some(ResidentWhy::LiveItems));
    assert_eq!(sim.rt.queue_len(), 0, "★ R1 설계였다면 '나중 것'이 자동 전송됐다");
    assert_eq!(sim.count(|e| matches!(e, Event::QueueCleared { .. })), 1);

    sim.send("이어서");
    assert_eq!(sim.rt.spawns, 1, "정체성 동일 → T16 주입(재스폰 아님)");
    assert_eq!(sim.live_ids().len(), 2, "셸 생존");
    sim.frame(f_result_ok("끝"));
    sim.frame(f_bg(&[]));
    sim.finish();
}


#[test]
fn s06b_interrupt_then_identity_change_respawns() {
    let mut sim = Sim::new(&S6B, raw("fable", EffortId::Medium, "a@x"));
    sim.send("작업");
    sim.feed(&handshake("smoke"));
    sim.feed(&synth("bg-shell"));
    sim.cmd(Cmd::Interrupt);
    sim.frame(f_result_aborted());

    sim.cmd(set_now(patch_model("opus")));
    sim.send("다시");
    assert_eq!(sim.rt.spawns, 2);
    assert_eq!(
        sim.settle_reason("bash-1").as_deref(),
        Some("identity_changed:[engine.model]")
    );
    assert_eq!(sim.count(|e| matches!(e, Event::RespawnNotice { .. })), 1);
    sim.feed(&handshake("smoke"));
    sim.frame(f_result_ok("끝"));
    sim.finish();
}


/// 6c-i (dev 서버): ④ mtime이 Alive → 정착 0건, ⑥은 **호출되지 않는다**(싼 게 먼저).
#[test]
fn s06c_i_mtime_keeps_shell_alive() {
    let mut sim = Sim::new(&S6C, raw("fable", EffortId::Medium, "a@x"));
    sim.send("작업");
    sim.feed(&handshake("smoke"));
    sim.feed(&synth("bg-shell"));
    sim.rt.driver().mtime_fresh_ids.insert("bash-1".into());
    sim.rt.driver().mtime_fresh_ids.insert("bash-2".into());
    sim.cmd(Cmd::Interrupt);
    sim.frame(f_result_aborted());

    sim.advance_to(95 * SEC);
    assert_eq!(sim.settled().len(), 0, "정착 0건");
    assert_eq!(sim.live_ids().len(), 2);
    assert_eq!(sim.rt.driver().probe_count, 0, "⑥은 호출되지 않는다");
    assert_eq!(sim.rt.gating_blockers().len(), 2, "게이팅 유지");
    sim.rt.dispatch(Cmd::StopAll);
    sim.finish();
}

/// 6c-ii (출력 없는 정상 셸): ⑥이 Alive → 알약 유지. **R2였다면 90s에 게이팅을 잃었다**(N6).
#[test]
fn s06c_ii_active_probe_keeps_silent_shell() {
    let mut sim = Sim::new(&S6C, raw("fable", EffortId::Medium, "a@x"));
    sim.send("작업");
    sim.feed(&handshake("smoke"));
    sim.feed(&synth("bg-shell"));
    sim.rt.driver().responsive = true;
    sim.rt.driver().probe_tasks = vec!["bash-1".into(), "bash-2".into()];
    sim.cmd(Cmd::Interrupt);
    sim.frame(f_result_aborted());

    sim.advance_to(95 * SEC);
    assert_eq!(sim.settled().len(), 0, "정착 0건");
    assert_eq!(sim.rt.driver().probe_count, 1, "initialize 재전송 정확히 1회");
    assert_eq!(sim.live_ids().len(), 2);
    assert_eq!(sim.rt.gating_blockers().len(), 2, "게이팅 유지(2.6.2 파리티 복원)");
    sim.rt.dispatch(Cmd::StopAll);
    sim.finish();
}

/// 6c-iii (진짜 죽음): ⑥이 Dead → T21b 즉시 정착 + 빈 REPLACE가 T20으로 회수.
#[test]
fn s06c_iii_active_probe_dead_settles_and_reclaims() {
    let mut sim = Sim::new(&S6C, raw("fable", EffortId::Medium, "a@x"));
    sim.send("작업");
    sim.feed(&handshake("smoke"));
    sim.feed(&synth("bg-shell"));
    sim.rt.driver().responsive = true;
    sim.rt.driver().probe_tasks = vec![]; // 빈 REPLACE = Dead
    sim.cmd(Cmd::Interrupt);
    sim.frame(f_result_aborted());

    sim.advance_to(95 * SEC);
    let s = sim.settled();
    assert_eq!(s.len(), 2, "둘 다 정착");
    assert!(s.iter().all(|(_, r, _)| r == "watchdog:active"), "관측된 정착");
    assert!(
        s.iter().all(|(_, _, at)| *at <= 95 * SEC && *at >= 90 * SEC),
        "≈93s(±tick)에 정착: {s:?}"
    );
    // 관측이므로 confidence가 안 떨어지고, 빈 REPLACE가 F13 → T20으로 프로세스를 거둔다.
    assert_eq!(sim.state(), StateTag::Idle);
    assert_eq!(sim.count(|e| matches!(e, Event::CloseInput { .. })), 1);
    sim.finish();
}

// ════════════════════════════════════════════════════════════════════════════
// #7 워크플로 도는 중 CLI 강제 종료 (P8 유령)
// ════════════════════════════════════════════════════════════════════════════


#[test]
fn s07_workflow_cli_killed() {
    let mut sim = Sim::new(&S7, raw("fable", EffortId::Medium, "a@x"));
    sim.send("워크플로 돌려줘");
    sim.feed(&handshake("smoke"));
    sim.feed(&synth("workflow"));
    sim.frame(f_result_ok("시작했어요"));
    assert_eq!(sim.state(), StateTag::Resident);
    assert_eq!(sim.live_ids(), vec!["wf-1", "wf-2"]);
    assert!(!sim.rt.busy());

    // 폴트: CLI가 외부에서 강제 종료됨(프레임 없이 stdout EOF)
    sim.rt.stream_died(CloseCause::ExternalKill);

    assert_eq!(sim.state(), StateTag::Idle);
    assert!(sim.live_ids().is_empty(), "★ 원장이 비었다");
    assert_eq!(
        sim.settle_reason("wf-1").as_deref(),
        Some("stream_closed:externalkill")
    );
    assert_eq!(
        sim.settle_reason("wf-2").as_deref(),
        Some("stream_closed:externalkill")
    );
    assert!(sim.rt.gating_blockers().is_empty(), "어떤 조작도 막히지 않는다");
    assert_eq!(sim.cmd(Cmd::SwitchChat), Verdict::Accepted);
    assert_eq!(sim.cmd(Cmd::NewChat), Verdict::Accepted);
    sim.finish();
}


#[test]
fn s07b_hung_cli_settles_at_hard_limit() {
    let mut sim = Sim::new(&S7B, raw("fable", EffortId::Medium, "a@x"));
    sim.send("워크플로");
    sim.feed(&handshake("smoke"));
    sim.feed(&synth("workflow"));
    sim.frame(f_result_ok("시작"));
    sim.rt.driver().responsive = false; // 컨트롤 응답도 없다

    sim.advance_to(85 * SEC);
    assert_eq!(sim.rt.gating_blockers().len(), 2, "85s까진 게이팅 유지");

    sim.advance_to(95 * SEC);
    assert_eq!(sim.settled().len(), 0, "아직 정착 안 함");
    assert!(sim.rt.gating_blockers().is_empty(), "★ 게이팅 자격은 즉시 상실");
    assert_eq!(sim.cmd(Cmd::SwitchChat), Verdict::Accepted);
    assert!(!sim.rt.busy());

    sim.advance_to(31 * MIN);
    let s = sim.settled();
    assert_eq!(s.len(), 2);
    assert!(s.iter().all(|(_, r, _)| r == "watchdog:none"), "추정 정착");
    assert_eq!(sim.state(), StateTag::Resident);
    assert_eq!(sim.why(), Some(ResidentWhy::Unverified));
    // 불변식 12(추정 정착 직후 close_input 0건)는 러너가 자동 검사한다.
    assert!(sim.rt.hung_probes() > 0, "stream_hung_probes가 기록된다");
    sim.finish();
}


#[test]
fn s07b_prime_external_death_settles_in_93s() {
    let mut sim = Sim::new(&S7B2, raw("fable", EffortId::Medium, "a@x"));
    sim.send("워크플로");
    sim.feed(&handshake("smoke"));
    sim.feed(&synth("workflow"));
    sim.frame(f_result_ok("시작"));
    sim.rt.driver().responsive = true;
    sim.rt.driver().probe_tasks = vec![];

    sim.advance_to(95 * SEC);
    let s = sim.settled();
    assert_eq!(s.len(), 2);
    assert!(s.iter().all(|(_, r, _)| r == "watchdog:active"));
    // ★R2(크리틱 C5): 상한만 있으면 **조기 정착 회귀**(90s 리스가 30s로 줄어드는 것)를 못 잡는다.
    //   형제 `s06c_iii`는 처음부터 양쪽을 걸고 있었다 — 여기만 비대칭이었다.
    assert!(
        s.iter().all(|(_, _, at)| *at >= 90 * SEC && *at <= 95 * SEC),
        "★ 30분도 아니고 30초도 아니다 — 90~95s 창: {s:?}"
    );
    assert_eq!(sim.state(), StateTag::Idle, "T20이 프로세스를 정상 회수");
    assert_eq!(sim.count(|e| matches!(e, Event::CloseInput { .. })), 1);
    sim.finish();
}


#[test]
fn s07c_force_settle() {
    let mut sim = Sim::new(&S7C, raw("fable", EffortId::Medium, "a@x"));
    sim.send("워크플로");
    sim.feed(&handshake("smoke"));
    sim.feed(&synth("workflow"));
    sim.frame(f_result_ok("시작"));
    sim.rt.driver().responsive = false;

    sim.advance_to(10 * MIN);
    assert_eq!(
        sim.cmd(Cmd::ForceSettle {
            id: "wf-1".into()
        }),
        Verdict::Accepted
    );
    assert_eq!(sim.settle_reason("wf-1").as_deref(), Some("forced_by_user"));
    assert!(sim.live_ids().contains(&"wf-2".to_string()));

    sim.advance_to(31 * MIN);
    assert_eq!(sim.settle_reason("wf-2").as_deref(), Some("watchdog:none"));
    sim.finish();
}


#[test]
fn s07d_idle_reclaim_at_6h() {
    let mut sim = Sim::new(&S7D, raw("fable", EffortId::Medium, "a@x"));
    sim.send("워크플로");
    sim.feed(&handshake("smoke"));
    sim.feed(&synth("workflow"));
    sim.frame(f_result_ok("시작"));
    sim.rt.driver().responsive = false;

    sim.advance_to(6 * 60 * MIN + 5 * MIN);
    assert_eq!(sim.state(), StateTag::Idle);
    assert!(sim.live_ids().is_empty());
    assert_eq!(sim.rt.spawns, sim.rt.exits);
    sim.finish();
}


#[test]
fn s07e_mtime_prevents_false_positive() {
    let mut sim = Sim::new(&S7E, raw("fable", EffortId::Medium, "a@x"));
    sim.send("워크플로");
    sim.feed(&handshake("smoke"));
    sim.feed(&synth("workflow"));
    sim.frame(f_result_ok("시작"));
    sim.rt.driver().responsive = false;
    sim.rt.driver().mtime_fresh_ids.insert("wf-1".into());
    sim.rt.driver().mtime_fresh_ids.insert("wf-2".into());

    sim.advance_to(35 * MIN);
    assert_eq!(sim.settled().len(), 0, "35분 내내 정착하지 않는다");
    assert_eq!(sim.rt.gating_blockers().len(), 2, "게이팅도 유지");
    assert_eq!(sim.rt.driver().probe_count, 0, "④가 먼저 답하므로 ⑥은 0회");
    sim.rt.dispatch(Cmd::StopAll);
    sim.finish();
}

// ════════════════════════════════════════════════════════════════════════════
// #8 승인 카드 뜬 채 CLI 사망 (P8 + 대기자 누수)
// ════════════════════════════════════════════════════════════════════════════


#[test]
fn s08_ask_card_then_crash() {
    let all = wire("approve");
    let cut = all
        .iter()
        .position(|v| v["type"] == "control_request")
        .unwrap();
    let mut sim = Sim::new(&S8, raw("fable", EffortId::Medium, "a@x"));
    sim.send("파일 써줘");
    sim.feed(&all[0..=cut]);
    assert_eq!(sim.state(), StateTag::AwaitingUser);
    // 원장 = AskCard + 그 승인을 기다리는 RunningTool(Write) 2개.
    assert_eq!(sim.live_ids().len(), 2);
    assert_eq!(
        sim.rt.ledger().items().iter().filter(|i| i.ask.is_some()).count(),
        1
    );

    sim.rt.stream_died(CloseCause::Crash);
    assert_eq!(sim.state(), StateTag::Idle);
    assert!(sim.live_ids().is_empty(), "AskCard도 정착한다");
    assert_eq!(sim.count(|e| matches!(e, Event::Status { .. })), 1);
    assert!(!sim.rt.busy());

    // 지연된 control_response는 버려진다(§5.7 규약 2 — 우리 규약이다).
    sim.frame(json!({"type":"control_response","response":{
        "subtype":"success","request_id":"late-1","response":{}}}));
    assert_eq!(
        sim.count(|e| matches!(e, Event::UnmatchedControlResponse { .. })),
        1
    );
    sim.finish();
}


#[test]
fn s08b_app_quit_settles_with_cause() {
    let all = wire("approve");
    let cut = all
        .iter()
        .position(|v| v["type"] == "control_request")
        .unwrap();
    let mut sim = Sim::new(&S8B, raw("fable", EffortId::Medium, "a@x"));
    sim.send("파일 써줘");
    sim.feed(&all[0..=cut]);
    sim.inject_unknown();
    sim.rt.app_quit();
    let reasons: Vec<String> = sim.settled().into_iter().map(|(_, r, _)| r).collect();
    assert!(
        reasons.iter().all(|r| r == "stream_closed:appquit"),
        "2.6.2는 사유 없이 조용히 stopped로 내렸다: {reasons:?}"
    );
    sim.finish();
}


#[test]
fn s08c_duplicate_control_response_is_idempotent() {
    let mut sim = Sim::new(&S8C, raw("fable", EffortId::Medium, "a@x"));
    sim.send("파일 써줘");
    sim.feed(&handshake("smoke"));
    sim.frame(f_can_use_tool("req-1", "Write", "toolu_1"));
    assert_eq!(sim.state(), StateTag::AwaitingUser);

    assert_eq!(
        sim.cmd(Cmd::Respond {
            kind: AskKind::Permission,
            request_id: "req-1".into(),
            accept: true
        }),
        Verdict::Accepted
    );
    // 응답에 **toolUseID가 항상 실린다**(고아 경로가 이걸 키로 쓴다).
    let resp = sim.rt.driver().sent_responses();
    assert_eq!(resp.len(), 1);
    assert_eq!(resp[0]["response"]["response"]["toolUseID"], "toolu_1");

    // 두 번째 응답은 카드가 없으므로 조용히 거부된다(패닉·중복 이벤트 없음).
    assert_eq!(
        sim.cmd(Cmd::Respond {
            kind: AskKind::Permission,
            request_id: "req-1".into(),
            accept: true
        }),
        Verdict::Rejected("no_card")
    );
    assert_eq!(sim.rt.driver().sent_responses().len(), 1);
    sim.frame(f_result_ok("끝"));
    sim.finish();
}

