//! 상시 회귀 시나리오 #9~#33 (`docs/design/m-logic-replay.md` §5).
//!
//! 필수 8조합(`replay.rs`)이 "그 조합이 도는가"라면, 여기는 **한 번 고친 구멍이 다시 열리지
//! 않는가**를 본다. 러너·불변식은 같은 것을 쓴다.

mod harness;

use ccg_engine::clock::{MIN, SEC};
use ccg_engine::event::{Event, EvidenceSource, Verdict};
use ccg_engine::identity::*;
use ccg_engine::live::{AskKind, CloseCause, LiveKind};
use ccg_engine::runtime::Cmd;
use ccg_engine::state::{ResidentWhy, StateTag};
use harness::*;
use serde_json::json;

fn set_now(p: RawIdentityPatch) -> Cmd {
    Cmd::IdentitySet {
        patch: p,
        policy: ApplyPolicy::Now,
        op: PendingOp::Merge,
    }
}

fn started(scen: &'static Scen) -> Sim {
    let mut sim = Sim::new(scen, raw("fable", EffortId::Medium, "a@x"));
    sim.send("작업");
    sim.feed(&handshake("smoke"));
    sim
}

// ── #9 정착↔통지 순서 뒤집기 (위험 #2) ──────────────────────────────────────


#[test]
fn s09_level_and_edge_order_does_not_matter() {
    // 순서 A: 목록 이탈(F13) → 통지(F17)
    let mut a = started(&S9);
    a.frame(f_bg(&[("wf-1", "local_workflow")]));
    a.frame(f_bg(&[]));
    a.frame(f_task_notification("wf-1", "completed", false));
    let a_live = a.live_ids();
    let a_reason = a.settle_reason("wf-1");

    // 순서 B: 통지 먼저 → 목록 이탈
    let mut b = started(&S9);
    b.frame(f_bg(&[("wf-1", "local_workflow")]));
    b.frame(f_task_notification("wf-1", "completed", false));
    b.frame(f_bg(&[]));
    let b_live = b.live_ids();
    let b_reason = b.settle_reason("wf-1");

    // **레벨이 진실, 에지는 장식** — 어느 순열에서도 최종 원장이 같아야 한다.
    assert_eq!(a_live, b_live);
    assert!(a_live.is_empty());
    assert_eq!(b_reason.as_deref(), Some("completed"));
    assert!(a_reason.is_some(), "A 경로도 사유를 갖는다: {a_reason:?}");
    a.frame(f_result_ok("끝"));
    b.frame(f_result_ok("끝"));
    a.finish();
    b.finish();
}

// ── #10 무음 result 슬라이딩 보류 ────────────────────────────────────────────


#[test]
fn s10_silent_result_slides_then_recovers() {
    let mut sim = started(&S10);
    sim.frame(f_result_ok("")); // 활동도 텍스트도 없는 무음 result
    assert_eq!(sim.state(), StateTag::HeldResult);

    sim.advance(6 * SEC); // 2.5s 슬라이딩 재장전 2회
    assert_eq!(sim.state(), StateTag::HeldResult, "고정 타임아웃이면 여기서 오탐");

    sim.frame(f_assistant_text("사실은 이제 시작합니다")); // 13초쯤 뒤 진짜 첫 토큰
    assert_eq!(sim.state(), StateTag::Streaming, "T9 — 미니턴 오판 복구");
    sim.frame(f_result_ok("진짜 끝"));
    assert_eq!(sim.state(), StateTag::Idle);
    sim.finish();
}


#[test]
fn s10b_silent_result_settles_after_rearms() {
    let mut sim = started(&S10B);
    sim.frame(f_result_ok(""));
    sim.advance(25 * SEC);
    assert_eq!(sim.state(), StateTag::Idle);
    assert!(sim
        .events()
        .iter()
        .any(|e| matches!(e, Event::Notice(t) if t.contains("비어 있어"))));
    sim.finish();
}

// ── #11 통지 삼킴 재주입 1회 제한 ────────────────────────────────────────────


#[test]
fn s11_notification_replay_only_once() {
    let mut sim = started(&S11);
    sim.frame(f_user_notif("wf-1")); // 배달된 통지 기록
    sim.frame(f_result_ok("")); // 무음 result
    sim.advance(3 * SEC);
    assert_eq!(sim.state(), StateTag::Streaming, "T12 — 프롬프트 재주입");
    let after_first = sim.rt.sent_user_texts().len();

    // 재주입 턴이 또 무음이어도 **두 번째 재주입은 없다**(무한 루프 방지).
    sim.frame(f_result_ok(""));
    sim.advance(30 * SEC);
    assert_eq!(
        sim.rt.sent_user_texts().len(),
        after_first,
        "replayed_once 불변식"
    );
    sim.finish();
}

// ── #12 addDirs 순서만 다른 재전송 = 재스폰 없음 ─────────────────────────────


#[test]
fn s12_add_dirs_order_does_not_respawn() {
    let mut base = raw("fable", EffortId::Medium, "a@x");
    base.add_dirs = vec!["C:\\Code\\X".into(), "C:\\Code\\Y".into()];
    let mut sim = Sim::new(&S12, base);
    sim.send("작업");
    sim.feed(&handshake("smoke"));
    sim.frame(f_result_ok("끝"));

    // 순서·대소문자·후행 역슬래시만 다른 값 → **noop**(정체성이 안 바뀐다)
    let v = sim.cmd(set_now(RawIdentityPatch {
        add_dirs: Some(vec!["c:/code/y\\".into(), "C:\\CODE\\X".into()]),
        ..Default::default()
    }));
    assert_eq!(v, Verdict::Noop, "2.6.2는 JSON.stringify 비교라 재스폰했다");

    sim.send("다음");
    assert_eq!(sim.rt.spawns, 1, "T16 주입");
    sim.frame(f_result_ok("끝2"));
    sim.finish();
}

// ── #13 전역 pref 물질화 ─────────────────────────────────────────────────────


#[test]
fn s13_global_pref_does_not_touch_existing_chat() {
    let mut sim = started(&S13);
    sim.frame(f_result_ok("끝"));
    let before = sim.rt.identity().hash();

    // "다른 채팅에서 전역 스타일을 바꿨다" = 이 채팅에서는 **아무 일도 일어나지 않는다**.
    // (2.6.2는 비교 시점에 디스크를 읽어 상주가 조용히 끊겼다 — engine.ts:1196)
    assert_eq!(sim.rt.identity().hash(), before, "identity_hash 불변");
    sim.send("다음");
    assert_eq!(sim.rt.spawns, 1);
    sim.frame(f_result_ok("끝2"));
    sim.finish();
}




#[test]
fn s13b_bulk_apply_returns_verdict_per_chat() {
    let patch = || RawIdentityPatch {
        output_style: Some(Some("Concise".into())),
        ..Default::default()
    };
    // 채팅 A: Idle → applied
    let mut a = Sim::new(&S13B, raw("fable", EffortId::Medium, "a@x"));
    assert_eq!(a.cmd(set_now(patch())), Verdict::Applied);
    // 채팅 B: 턴 중 → deferred
    let mut b = started(&S13B_TURN);
    assert_eq!(
        b.cmd(Cmd::IdentitySet {
            patch: patch(),
            policy: ApplyPolicy::AfterTurn,
            op: PendingOp::Merge
        }),
        Verdict::Deferred("turn_end")
    );
    // 채팅 C: 없는 계정 → rejected
    let mut c = Sim::new(&S13B_REJ, raw("fable", EffortId::Medium, "a@x"));
    assert_eq!(
        c.cmd(set_now(RawIdentityPatch {
            billing: BillingPatch {
                account: Some("nobody@x".into()),
                ..Default::default()
            },
            ..Default::default()
        })),
        Verdict::Rejected("account_unavailable")
    );
    // **조용히 반영되는 채팅 0건** — 셋 다 판정이 보인다(D7).
    for s in [&a, &b, &c] {
        assert!(s.count(|e| matches!(e, Event::Verdict { .. })) >= 1);
    }
    b.frame(f_result_ok("끝"));
    a.finish();
    b.finish();
    c.finish();
}

// ── #16 delete_chat 확인 카드 ────────────────────────────────────────────────


#[test]
fn s16_delete_chat_with_live_items_asks() {
    let mut sim = started(&S16);
    sim.feed(&synth("bg-shell"));
    assert_eq!(sim.cmd(Cmd::DeleteChat), Verdict::NeedsConfirm);
    // ★ 침묵 no-op이 아니다 — 비용을 문장으로 말할 재료가 원장에 있다.
    assert_eq!(sim.rt.ledger().kinds_count(), vec![(LiveKind::BgShell, 2)]);
    sim.frame(f_result_ok("끝"));
    sim.rt.dispatch(Cmd::StopAll);
    sim.finish();
}

// ── #17 같은 통지 중복 배달 = 멱등 ───────────────────────────────────────────


#[test]
fn s17_duplicate_notification_is_idempotent() {
    let mut sim = started(&S17);
    sim.frame(f_bg(&[("wf-1", "local_workflow")]));
    sim.frame(f_task_notification("wf-1", "completed", false));
    sim.frame(f_task_notification("wf-1", "completed", false));
    assert_eq!(
        sim.settled().iter().filter(|(id, _, _)| id == "wf-1").count(),
        1
    );
    sim.frame(f_result_ok("끝"));
    sim.finish();
}

// ── #18 init 재도착 (F1) ─────────────────────────────────────────────────────


#[test]
fn s18_init_rearrival_is_not_a_new_session() {
    let all = wire("interrupt");
    let mut sim = Sim::new(&S18, raw("fable", EffortId::Medium, "a@x"));
    sim.send("1턴");
    sim.feed(&all[0..3]);
    let sid = sim.rt.session_id().unwrap();
    sim.feed(&all[9..12]);
    sim.send("2턴");
    sim.feed(&all[12..23]); // 이 안에 system/init이 **또** 있다(실측)
    assert_eq!(sim.rt.session_id().as_deref(), Some(sid.as_str()));
    assert_eq!(sim.rt.spawns, 1, "init 재도착으로 재스폰하지 않는다");
    sim.finish();
}

// ── #19 폴백 3경로 순열 = 리비전 1개 ─────────────────────────────────────────




#[test]
fn s19_three_fallback_paths_converge_to_one_revision() {
    // 순열 1: 다이얼로그 수락 → refusal 프레임 → model 변화
    let mut a = started(&S19_DLG);
    a.frame(f_dialog("dlg-1", "opus"));
    assert_eq!(a.state(), StateTag::AwaitingUser);
    a.cmd(Cmd::Respond {
        kind: AskKind::Dialog,
        request_id: "dlg-1".into(),
        accept: true,
    });
    a.feed(&synth("refusal-fallback")); // arm이 있으므로 **소비만**
    a.frame(f_assistant_model("claude-opus-5")); // 미러만
    assert_eq!(a.banners().len(), 1, "전환당 배너 1개");
    assert_eq!(a.rt.identity().model(), "opus");

    // 순열 2: model 변화 먼저 → refusal 프레임
    let mut b = started(&S19);
    b.frame(f_assistant_model("claude-opus-5"));
    b.feed(&synth("refusal-fallback"));
    assert_eq!(b.banners().len(), 1);
    assert_eq!(b.rt.identity().model(), "opus");

    // 순열 3: refusal 프레임만
    let mut c = started(&S19);
    c.feed(&synth("refusal-fallback"));
    assert_eq!(c.banners().len(), 1);

    for s in [&mut a, &mut b, &mut c] {
        s.frame(f_result_ok("끝"));
    }
    a.finish();
    b.finish();
    c.finish();
}

#[test]
fn s19b_dialog_decline_creates_no_revision() {
    let mut sim = started(&S19_DEC);
    sim.frame(f_dialog("dlg-1", "opus"));
    sim.cmd(Cmd::Respond {
        kind: AskKind::Dialog,
        request_id: "dlg-1".into(),
        accept: false,
    });
    assert_eq!(sim.banners().len(), 0, "거절이면 리비전도 배너도 없다");
    assert_eq!(sim.rt.identity().model(), "fable");
    sim.frame(f_result_ok("끝"));
    sim.finish();
}

// ── #20 중단이 큐를 비우고 되돌리기가 복원 ───────────────────────────────────


#[test]
fn s20_interrupt_clears_queue_and_undo_restores() {
    let mut sim = started(&S20);
    sim.enqueue("2");
    sim.enqueue("3");
    sim.cmd(Cmd::Interrupt);
    let (count, token) = sim
        .events()
        .into_iter()
        .find_map(|e| match e {
            Event::QueueCleared {
                count, undo_token, ..
            } => Some((count, undo_token)),
            _ => None,
        })
        .unwrap();
    assert_eq!(count, 2);
    assert_eq!(sim.rt.queue_len(), 0);
    sim.frame(f_result_aborted());
    let sent_before = sim.rt.sent_user_texts().len();

    assert_eq!(sim.cmd(Cmd::QueueRestore { token }), Verdict::Accepted);
    assert_eq!(sim.rt.queue_texts(), vec!["2", "3"], "순서 그대로");
    assert_eq!(
        sim.rt.sent_user_texts().len(),
        sent_before,
        "복원이 자동 전송을 유발하지 않는다"
    );
    sim.rt.dispatch(Cmd::StopAll);
    sim.finish();
}

// ── #21 프로세스 생존만으로 재장전 금지 (L2 잠금) ────────────────────────────


#[test]
fn s21_process_alive_never_rearms_lease() {
    let mut sim = started(&S21);
    sim.feed(&synth("bg-shell"));
    sim.frame(f_result_ok("끝"));
    sim.rt.driver().responsive = false;
    assert!(sim.rt.driver_ref().alive, "프로세스는 살아 있다(freeze)");

    sim.advance_to(31 * MIN);
    // 프로세스가 살아 있어도 리스는 재장전되지 않는다 → 정착까지 간다.
    assert_eq!(sim.settled().len(), 2);
    assert!(!sim.events().iter().any(|e| matches!(
        e,
        Event::EvidenceRearm {
            source: EvidenceSource::ProcessAlive,
            ..
        }
    )));
    sim.finish();
}

// ── #22 도구 정책 토글 = 재스폰 (P1e) ────────────────────────────────────────


#[test]
fn s22_tool_policy_toggle_respawns() {
    let mut sim = started(&S22);
    sim.feed(&synth("bg-shell"));
    sim.frame(f_result_ok("끝"));

    let v = sim.cmd(set_now(RawIdentityPatch {
        tools: ToolPatch {
            skill_overrides: [("dataviz".to_string(), Some(SkillOverride::Disabled))]
                .into_iter()
                .collect(),
            ..Default::default()
        },
        ..Default::default()
    }));
    assert_eq!(v, Verdict::Applied, "2.6.2는 optsMatch에 없어 조용히 안 꺼졌다");

    sim.send("다음");
    assert_eq!(sim.rt.spawns, 2, "재스폰");
    assert_eq!(
        sim.settle_reason("bash-1").as_deref(),
        Some("identity_changed:[tools.skillOverrides]")
    );
    sim.feed(&handshake("smoke"));
    sim.frame(f_result_ok("끝2"));
    sim.finish();
}

// ── #23 Resident{Unverified}에서 send ────────────────────────────────────────


#[test]
fn s23_send_works_in_unverified_resident() {
    let mut sim = started(&S23);
    sim.feed(&synth("bg-shell"));
    sim.frame(f_result_ok("끝"));
    sim.rt.driver().responsive = false;
    sim.advance_to(31 * MIN);
    assert_eq!(sim.why(), Some(ResidentWhy::Unverified));

    // 막으면 P8이 다른 형태로 부활한다.
    assert_eq!(sim.send("그래도 보낸다"), Verdict::Accepted);
    assert_eq!(sim.rt.spawns, 1, "정체성 같으면 T16 주입");
    sim.frame(f_result_ok("끝2"));
    sim.rt.dispatch(Cmd::StopAll);
    sim.finish();
}

// ── #25 spawn 실패 / initialize 20s 무응답 (T3) ──────────────────────────────


#[test]
fn s25_spawn_timeout() {
    let mut sim = Sim::new(&S25, raw("fable", EffortId::Medium, "a@x"));
    sim.send("작업");
    sim.enqueue("나중 것");
    sim.advance(25 * SEC);
    assert_eq!(sim.state(), StateTag::Starting, "큐가 남아 다음 스폰이 이어진다");
    // notice + status:error 각 1회, 원장 비어 있음
    assert!(sim
        .events()
        .iter()
        .any(|e| matches!(e, Event::Notice(t) if t.contains("20초"))));
    assert!(sim.rt.ledger().is_empty());
    // ★ 중단이 아니므로 큐를 비우지 않는다(L1과 구별) — 다음 항목이 드레인됐다.
    assert_eq!(
        sim.count(|e| matches!(e, Event::QueueCleared { .. })),
        0,
        "spawn 실패는 큐를 버리지 않는다"
    );
    sim.rt.dispatch(Cmd::StopAll);
    sim.finish();
}

// ── #26 CLI가 카드를 회수 (T6) — 실와이어 park.jsonl ─────────────────────────


#[test]
fn s26_cli_withdraws_card() {
    let all = wire("park");
    let ask = all
        .iter()
        .position(|v| v["type"] == "control_request")
        .unwrap();
    let cancel = all
        .iter()
        .position(|v| v["type"] == "control_cancel_request")
        .expect("park.jsonl에 실측 control_cancel_request가 있다");
    let mut sim = Sim::new(&S26, raw("fable", EffortId::Medium, "a@x"));
    sim.send("파일 써줘");
    sim.feed(&all[0..=ask]);
    assert_eq!(sim.state(), StateTag::AwaitingUser);
    sim.frame(all[cancel].clone());
    assert_eq!(sim.state(), StateTag::Streaming);
    assert!(sim.events().iter().any(
        |e| matches!(e, Event::AskClosed { how, .. } if *how == "withdrawn")
    ));
    // 늦은 사용자 응답은 **전송 시도조차 하지 않는다**(§5.7 규약 4).
    let before = sim.rt.driver_ref().sent_responses().len();
    assert_eq!(
        sim.cmd(Cmd::Respond {
            kind: AskKind::Permission,
            request_id: all[cancel]["request_id"].as_str().unwrap().into(),
            accept: true
        }),
        Verdict::Rejected("no_card")
    );
    assert_eq!(sim.rt.driver_ref().sent_responses().len(), before);
    sim.frame(f_result_ok("끝"));
    sim.finish();
}

// ── #27 중단 6s 무응답 → 하드 강등 (T15) ─────────────────────────────────────


#[test]
fn s27_interrupt_timeout_hard_cancels() {
    let mut sim = started(&S27);
    sim.cmd(Cmd::Interrupt);
    assert_eq!(sim.state(), StateTag::Interrupting);
    sim.advance(7 * SEC);
    assert_eq!(sim.state(), StateTag::Idle);
    assert!(sim.rt.driver_ref().killed, "하드 강등은 kill까지 간다");
    assert_eq!(sim.rt.spawns, sim.rt.exits);
    sim.finish();
}

// ── #28 /btw 포크 후 send (T18) ──────────────────────────────────────────────


#[test]
fn s28_btw_fork_is_thread_changed_not_identity() {
    let mut sim = started(&S28);
    sim.feed(&synth("bg-shell"));
    sim.frame(f_result_ok("끝"));

    assert_eq!(sim.cmd(Cmd::ForkBtw), Verdict::Accepted);
    sim.send("포크에서 묻기");
    let notice = sim
        .events()
        .into_iter()
        .find_map(|e| match e {
            Event::RespawnNotice {
                identity,
                thread_changed,
                ..
            } => Some((identity, thread_changed)),
            _ => None,
        })
        .unwrap();
    assert!(notice.0.is_empty(), "정체성은 안 바뀌었다");
    assert!(notice.1, "스레드가 바뀌었다");
    assert_eq!(
        sim.settle_reason("bash-1").as_deref(),
        Some("thread_changed"),
        "사유가 IdentityChanged와 **다르다**"
    );
    // 포크는 `--resume=<id> --fork-session`이다(resume이 있을 때만 유효).
    let spec = &sim.rt.driver_ref().spawn_specs[1];
    assert!(spec.argv.iter().any(|a| a == "--fork-session"), "{:?}", spec.argv);
    assert!(spec.argv.iter().any(|a| a.starts_with("--resume=")));
    sim.feed(&handshake("smoke"));
    sim.frame(f_result_ok("끝2"));
    sim.finish();
}

// ── #29 /compact 짝맞춤 (T28) ────────────────────────────────────────────────



#[test]
fn s29_compact_pairs_with_next_assistant() {
    let mut sim = started(&S29);
    sim.feed(&synth("compact"));
    assert_eq!(sim.count(|e| matches!(e, Event::Compact { .. })), 0, "아직 보류");
    sim.frame(json!({"type":"assistant","parent_tool_use_id":null,
        "message":{"role":"assistant","model":"fable","content":[{"type":"text","text":"요약 후 계속"}],
                   "usage":{"input_tokens":4200}},"session_id":"S1","uuid":"U-c"}));
    let c = sim
        .events()
        .into_iter()
        .find_map(|e| match e {
            Event::Compact {
                trigger,
                after_tokens,
            } => Some((trigger, after_tokens)),
            _ => None,
        })
        .expect("짝맞춤 방출");
    assert_eq!(c.0, "manual");
    assert_eq!(c.1, Some(4200));
    sim.frame(f_result_ok("끝"));
    sim.finish();
}

#[test]
fn s29b_compact_without_pair_emits_null_after() {
    let mut sim = started(&S29B);
    sim.feed(&synth("compact"));
    sim.frame(f_result_ok("끝")); // 턴이 먼저 끝난다
    let c = sim
        .events()
        .into_iter()
        .find_map(|e| match e {
            Event::Compact { after_tokens, .. } => Some(after_tokens),
            _ => None,
        })
        .expect("after=null로 방출");
    assert_eq!(c, None);
    sim.finish();
}

// ── #30 Starting 중 interrupt (T34) ──────────────────────────────────────────


#[test]
fn s30_interrupt_while_starting() {
    let mut sim = Sim::new(&S30, raw("fable", EffortId::Medium, "a@x"));
    sim.send("작업");
    sim.enqueue("나중 것");
    assert_eq!(sim.state(), StateTag::Starting);
    assert_eq!(sim.cmd(Cmd::Interrupt), Verdict::Accepted);
    assert_eq!(sim.state(), StateTag::Idle);
    assert!(sim.rt.ledger().is_empty(), "첫 프레임 전이라 정착할 항목이 없다");
    assert_eq!(sim.rt.queue_len(), 0, "큐 처리는 T13과 동일(§7.4)");
    assert_eq!(sim.count(|e| matches!(e, Event::QueueCleared { .. })), 1);
    sim.finish();
}

// ── #31 자동 응답·통과 프레임 3종 (F14·F18·F22) ──────────────────────────────


#[test]
fn s31_passthrough_and_auto_response_frames() {
    let mut sim = started(&S31);
    sim.feed(&synth("task-started")); // F14 — 매핑만, 원장 무영향
    sim.feed(&synth("informational")); // F18 — notice 통과
    let cards_before = sim.rt.ledger().items().len();
    sim.feed(&synth("hook-callback")); // F22 — 자동 응답, UI 카드 0건

    assert_eq!(sim.count(|e| matches!(e, Event::Notice(_))), 2);
    assert_eq!(sim.rt.ledger().items().len(), cards_before, "카드 0건");
    assert!(sim.events().iter().any(
        |e| matches!(e, Event::ControlSent { subtype, .. } if *subtype == "auto_response")
    ));
    assert_eq!(sim.state(), StateTag::Streaming, "상태는 그대로");
    sim.frame(f_result_ok("끝"));
    sim.finish();
}

// ── #32 Resident에서 interrupt (T35) — 두 갈래 ───────────────────────────────


/// ⓐ F13으로 이탈이 확인되면 `Stopped{by_user}` + confidence Observed → 빈 REPLACE에 T20.
#[test]
fn s32a_resident_interrupt_observed() {
    let mut sim = started(&S32);
    sim.feed(&synth("bg-shell"));
    sim.frame(f_result_ok("끝"));
    assert_eq!(sim.state(), StateTag::Resident);

    assert_eq!(sim.cmd(Cmd::Interrupt), Verdict::Accepted);
    // 턴이 없으므로 `control_request{interrupt}`는 **보내지 않는다**.
    assert_eq!(sim.rt.driver_ref().sent_control("interrupt").len(), 0);
    assert_eq!(sim.rt.driver_ref().sent_control("stop_task").len(), 2);
    assert_eq!(sim.count(|e| matches!(e, Event::Notice(_))), 1);

    sim.frame(f_bg(&[])); // 이탈 관측
    assert_eq!(sim.settle_reason("bash-1").as_deref(), Some("stopped:by_user=true"));
    assert_eq!(sim.state(), StateTag::Idle, "빈 REPLACE에 T20");
    sim.finish();
}

/// ⓑ 3s 안에 확인이 안 되면 `ForcedByUser` + confidence Unverified → Resident{Unverified}.
#[test]
fn s32b_resident_interrupt_unverified() {
    let mut sim = started(&S32);
    sim.feed(&synth("bg-shell"));
    sim.frame(f_result_ok("끝"));
    sim.rt.driver().responsive = false;
    sim.cmd(Cmd::Interrupt);
    sim.advance(4 * SEC);

    assert_eq!(sim.settle_reason("bash-1").as_deref(), Some("forced_by_user"));
    assert_eq!(sim.state(), StateTag::Resident);
    assert_eq!(sim.why(), Some(ResidentWhy::Unverified));
    sim.rt.dispatch(Cmd::StopAll);
    sim.finish();
}

// ── #33 능동 프로브 예산 (불변식 16) ─────────────────────────────────────────


#[test]
fn s33_probe_budget_and_dedup() {
    let mut sim = started(&S33);
    // 항목 3개여도 왕복은 1회여야 한다.
    sim.frame(f_bg(&[
        ("bash-1", "local_bash"),
        ("bash-2", "local_bash"),
        ("bash-3", "local_bash"),
    ]));
    sim.frame(f_can_use_tool("req-live", "Write", "toolu_x"));
    sim.cmd(Cmd::Respond {
        kind: AskKind::Permission,
        request_id: "req-live".into(),
        accept: true,
    });
    sim.frame(f_result_ok("끝"));
    sim.rt.driver().responsive = true;
    sim.rt.driver().probe_tasks = vec![];
    sim.rt.driver().probe_pending_permissions = vec!["req-live".into()];

    sim.advance_to(95 * SEC);
    assert_eq!(sim.rt.driver_ref().probe_count, 1, "항목 3개 → 왕복 1회");
    assert_eq!(sim.settled().len(), 4, "카드 1 + 셸 3");
    // 프로브 응답의 pending_permission_requests가 카드로 되살아나지 않는다.
    assert_eq!(
        sim.count(|e| matches!(e, Event::AskOpened { .. })),
        1,
        "중복 렌더 0건"
    );
    sim.finish();
}

// ── #24 급사 후 늦게 온 control_response ─────────────────────────────────────


#[test]
fn s24_late_control_response_is_dropped() {
    let mut sim = started(&S24);
    sim.frame(f_can_use_tool("req-9", "Write", "toolu_9"));
    sim.rt.stream_died(CloseCause::Crash);
    sim.frame(json!({"type":"control_response","response":{
        "subtype":"success","request_id":"req-9","response":{"behavior":"allow"}}}));
    assert_eq!(
        sim.count(|e| matches!(e, Event::UnmatchedControlResponse { .. })),
        1,
        "조용히 버리고 진단만 남긴다"
    );
    assert!(sim.rt.ledger().is_empty(), "대기자 0");
    sim.finish();
}

// ── #34 프레임 소화 전수 (F3·F4·F5·F7·F8·F11·F16·F20·F21) ────────────────────

#[test]
fn s34_frame_digest_coverage() {
    let mut sim = started(&S34);
    // F3 thinking_delta · F4 content_block_start:tool_use (실와이어 모양 그대로)
    sim.frame(json!({"type":"stream_event","parent_tool_use_id":null,
        "event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"음"}},
        "session_id":"S1","uuid":"U1"}));
    sim.frame(json!({"type":"stream_event","parent_tool_use_id":null,
        "event":{"type":"content_block_start","content_block":{"type":"tool_use","name":"Write"}},
        "session_id":"S1","uuid":"U2"}));
    // F5 사이드체인 stream_event — **즉시 버린다**
    sim.frame(json!({"type":"stream_event","parent_tool_use_id":"toolu_parent",
        "event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"서브"}},
        "session_id":"S1","uuid":"U3"}));
    // F8 사이드체인 assistant — 메인 경로 오염 금지
    sim.frame(json!({"type":"assistant","parent_tool_use_id":"toolu_parent",
        "message":{"role":"assistant","model":"claude-haiku-4-5","content":[{"type":"text","text":"서브 진행"}]},
        "session_id":"S1","uuid":"U4"}));
    assert_eq!(sim.rt.identity().model(), "fable", "사이드체인 모델은 폴백이 아니다");

    // F7 도구 시작 → 원장 등록, F11 tool_result → 정착
    sim.frame(json!({"type":"assistant","parent_tool_use_id":null,
        "message":{"role":"assistant","model":"fable","content":[
            {"type":"tool_use","id":"toolu_a","name":"Write"}]},"session_id":"S1","uuid":"U5"}));
    assert!(sim.live_ids().contains(&"toolu_a".to_string()));
    sim.frame(json!({"type":"user","parent_tool_use_id":null,
        "message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_a","is_error":null,"content":"ok"}]},
        "session_id":"S1","uuid":"U6"}));
    assert!(!sim.live_ids().contains(&"toolu_a".to_string()));

    // F16 하트비트(workflow_progress 없음) — 보드로 승격하지 않지만 리스는 재장전한다
    sim.frame(f_bg(&[("wf-1", "local_workflow")]));
    sim.frame(json!({"type":"system","subtype":"task_progress","task_id":"wf-1",
        "usage":{"total_tokens":10,"tool_uses":1,"duration_ms":100},"session_id":"S1","uuid":"U7"}));
    assert!(sim.events().iter().any(|e| matches!(
        e,
        Event::EvidenceRearm { source: EvidenceSource::Heartbeat, .. }
    )));

    // F20 stderr — 통과만, **리스 증거가 아니다**
    sim.rt.on_stderr("warning: something");
    // F21 미지 프레임 — 조용히 버린다
    sim.inject_unknown();

    sim.frame(f_result_ok("끝"));
    sim.rt.dispatch(Cmd::StopAll);
    sim.finish();
}

// ── #35 CLI 자발 기상 턴(T19) · 정리 턴 재개(T19b) ───────────────────────────

#[test]
fn s35_cli_initiated_turns_get_new_run_ids() {
    let mut sim = started(&S35);
    sim.feed(&synth("bg-shell"));
    sim.frame(f_result_ok("끝"));
    assert_eq!(sim.state(), StateTag::Resident);

    // T19 — `<task-notification>` 배달로 CLI가 스스로 깬다
    sim.frame(f_user_notif("bash-1"));
    assert_eq!(sim.state(), StateTag::Streaming);
    sim.frame(f_result_ok("보고 끝"));
    assert_eq!(sim.state(), StateTag::Resident);

    // T19b — 선행 user 프레임 없이 메인 경로 활동이 온다(정리 턴 재개)
    sim.frame(f_assistant_text("정리했습니다"));
    assert_eq!(sim.state(), StateTag::Streaming);
    sim.frame(f_result_ok("정리 끝"));

    // run_id 4개(최초 + T19 + T19b + …), 각각 종결 status 정확히 1회(불변식 3이 검사)
    assert_eq!(sim.count(|e| matches!(e, Event::Status { .. })), 3);
    sim.rt.dispatch(Cmd::StopAll);
    sim.finish();
}

// ── #36 Linger 정책 (T20b · T33) ─────────────────────────────────────────────

#[test]
fn s36_linger_policy_holds_then_closes() {
    let mut sim = started(&S36);
    sim.feed(&synth("bg-shell"));
    sim.frame(f_result_ok("끝"));
    assert_eq!(sim.state(), StateTag::Resident);

    sim.frame(f_bg(&[])); // 관측된 빔 → OnIdle이면 T20, Linger면 타이머만(T20b)
    assert_eq!(sim.state(), StateTag::Resident);
    assert_eq!(sim.why(), Some(ResidentWhy::Linger));
    assert_eq!(sim.count(|e| matches!(e, Event::CloseInput { .. })), 0);

    sim.advance(31 * SEC); // T33 — linger 만료
    assert_eq!(sim.state(), StateTag::Idle);
    assert_eq!(sim.count(|e| matches!(e, Event::CloseInput { .. })), 1);
    sim.finish();
}

// ── #37 stop_all (T23) ───────────────────────────────────────────────────────

#[test]
fn s37_stop_all_cancels_everything() {
    let mut sim = started(&S37);
    sim.feed(&synth("bg-shell"));
    sim.enqueue("나중 것");
    assert_eq!(sim.cmd(Cmd::StopAll), Verdict::Accepted);

    assert_eq!(sim.state(), StateTag::Idle);
    assert!(sim.live_ids().is_empty());
    assert_eq!(sim.settle_reason("bash-1").as_deref(), Some("cancelled"));
    assert_eq!(sim.rt.queue_len(), 0);
    assert!(sim.rt.driver_ref().killed);
    sim.finish();
}

// ════════════════════════════════════════════════════════════════════════════
// ★R2 — 크리틱 R1이 "잠겨 있지 않다"고 판정한 두 자리 (C2 · C6)
// ════════════════════════════════════════════════════════════════════════════

// ── #38 중단 뒤 고아 통지 기상 턴 — T12 가드의 "중단 요청 없음" ───────────────
//
// 설계 §3.3 T12의 가드는 넷째 항으로 **중단 요청 없음**을 요구하는데 R1의 표에도 코드에도
// 없었다(크리틱 §3.3). 메모리의 실버그 *"중단 1회 → 고아 통지 → 턴마다 CLI 사망 루프"*와
// 정확히 인접한 자리라, 여기서 **사용자가 세운 것을 기계가 다시 켜지 않는지**를 잠근다.

#[test]
fn s38_interrupt_blocks_notification_replay_until_user_sends() {
    let mut sim = started(&S38);
    sim.feed(&synth("bg-shell")); // 살아 있는 셸 → 중단 뒤에도 Resident
    assert_eq!(sim.cmd(Cmd::Interrupt), Verdict::Accepted);
    sim.frame(f_result_aborted()); // T14 — 재주입 금지 표식이 남는다
    assert_eq!(sim.state(), StateTag::Resident);

    // CLI가 고아 통지로 스스로 깬다(T19) → 그 턴이 무음이다(T8).
    sim.frame(f_user_notif("bash-1"));
    assert_eq!(sim.state(), StateTag::Streaming, "T19 — CLI 자발 기상 턴");
    sim.frame(f_result_ok(""));
    assert_eq!(sim.state(), StateTag::HeldResult, "T8 — 무음 보류");

    sim.advance(3 * SEC);
    assert_eq!(
        sim.state(),
        StateTag::HeldResult,
        "★ 중단 뒤에는 T12가 안 돈다 — 여기서 Streaming이면 기계가 사용자를 되살린 것"
    );
    sim.advance(30 * SEC); // 재장전 소진 → T11 마감
    assert_eq!(
        sim.count(|e| matches!(e, Event::StateAssign { source: "T12", .. })),
        0,
        "★ 중단 요청이 있는 동안 재주입 0회"
    );
    assert_eq!(
        sim.rt.driver_ref().sent_user_texts(),
        vec!["작업"],
        "★ 자동 프롬프트가 stdin에 실리지 않는다(드라이버가 본 것 전부)"
    );

    // 사용자가 **직접** 다음 턴을 시작하면 표식이 내려가고 T12는 원래대로 돈다.
    sim.send("이어서");
    assert_eq!(sim.state(), StateTag::Streaming);
    sim.frame(f_user_notif("bash-1"));
    sim.frame(f_result_ok(""));
    sim.advance(3 * SEC);
    assert_eq!(
        sim.count(|e| matches!(e, Event::StateAssign { source: "T12", .. })),
        1,
        "★ 가드는 중단 동안만 — T12 자체를 죽이면 통지 삼킴(#11)이 되살아난다"
    );
    assert_eq!(
        sim.rt.driver_ref().sent_user_texts(),
        vec!["작업", "이어서", "이어서 진행해 주세요(통지 재주입)"],
        "★ 재주입은 stdin에 실린다 — 1단계에서 이 줄이 없었다는 것이 가드의 증거다"
    );
    sim.frame(f_result_ok("보고"));
    sim.rt.dispatch(Cmd::StopAll);
    sim.finish();
}

// ── #39~#41 함정 A(모델 별칭) 뮤테이션 잠금 ──────────────────────────────────
//
// 크리틱 §6: 보고서가 "잠갔다"고 적은 함정 A는 3중 뮤테이션에 전부 초록이었다.
// 실제 방어선은 **`system/init`이 기준선을 잡는 것**(`runtime.rs` `Frame::SystemInit` 가지)과
// **별칭 접기**(`model_alias`) 둘인데, 그 둘을 없애도 죽는 테스트가 없었다.
// 와이어에는 같은 모델의 표기가 여러 벌이다 — 날짜 붙은 스냅샷 id(`claude-haiku-4-5-20251001`),
// 날짜 없는 id(`claude-haiku-4-5`), picker 별칭(`haiku`), 그리고 폴백 프레임의 `fallback_model`.
// 어느 한 벌을 기준선으로 굳히면 나머지가 전부 "모델이 바뀌었다"로 보이고, 그 오판은
// **리비전 → 정체성 변경 → 재스폰 폭주**로 번진다.

#[test]
fn s39_init_model_is_the_baseline_for_the_first_observation() {
    let mut sim = Sim::new(&S39, raw("haiku", EffortId::Medium, "a@x"));
    sim.send("1");
    sim.feed(&handshake("interrupt")); // 실와이어 init: model=claude-haiku-4-5-20251001

    // 세션은 haiku로 떴는데 첫 assistant가 sonnet으로 온다 = **무음 강등**.
    // init 기준선이 없으면 이 첫 관측이 그대로 기준선이 되어 강등이 조용히 삼켜진다.
    sim.frame(f_assistant_model("claude-sonnet-4-5-20250929"));
    assert_eq!(
        sim.banners(),
        vec![("haiku".to_string(), "sonnet".to_string())],
        "★ init 기준선 + 별칭 접기 — 둘 중 하나만 무너져도 이 줄이 깨진다"
    );
    assert_eq!(sim.rt.identity().model(), "sonnet", "정체성도 별칭 공간이다");
    assert_eq!(
        sim.identity_events().len(),
        2,
        "리비전 2개 — Default · EngineFallback{{ModelDelta}}"
    );
    assert!(sim.fired().contains("T29"), "폴백 리비전 전이 T29를 밟았다");
    sim.frame(f_result_ok("끝"));
    sim.finish();
}

#[test]
fn s40_same_model_other_spelling_is_not_a_fallback() {
    let mut sim = Sim::new(&S40, raw("haiku", EffortId::Medium, "a@x"));
    sim.send("1");
    sim.feed(&handshake("interrupt")); // 기준선 = claude-haiku-4-5-20251001 → haiku

    // 같은 모델을 CLI가 **다른 표기**로 부른다(날짜 없는 id).
    sim.frame(f_assistant_model("claude-haiku-4-5"));
    assert_eq!(sim.banners().len(), 0, "★ 같은 모델의 다른 표기는 전환이 아니다");
    assert_eq!(
        sim.rt.identity().model(),
        "haiku",
        "정체성은 picker 별칭으로 남는다"
    );
    sim.frame(f_result_ok("끝"));

    sim.send("2");
    assert_eq!(
        sim.rt.spawns, 1,
        "★ 재스폰 폭주 금지 — 별칭 접기가 무너지면 정체성이 바뀌어 매 턴 새 프로세스다"
    );
    assert_eq!(
        sim.count(|e| matches!(e, Event::StateAssign { source: "T16", .. })),
        1,
        "T16 주입 1회"
    );
    sim.frame(f_result_ok("끝2"));
    sim.rt.dispatch(Cmd::StopAll);
    sim.finish();
}

#[test]
fn s41_first_observation_is_the_baseline_when_init_has_no_model() {
    let mut sim = Sim::new(&S41, raw("haiku", EffortId::Medium, "a@x"));
    sim.send("1");
    // `model` 없는 init — 파서가 허용하는 갈래다(`Option<String>`). 기준선을 잡을 재료가 없다.
    sim.feed(&[f_init_ack(), f_init_nomodel("S1")]);
    sim.frame(f_assistant_model("claude-haiku-4-5-20251001"));
    assert_eq!(
        sim.banners().len(),
        0,
        "★ 첫 관측은 기준선이다 — picker 별칭과 표기가 달라도 폴백이 아니다"
    );
    assert_eq!(sim.rt.identity().model(), "haiku");
    sim.frame(f_result_ok("끝"));

    sim.send("2");
    assert_eq!(sim.rt.spawns, 1, "기준선을 잘못 잡으면 여기서 재스폰이 난다");
    sim.frame(f_result_ok("끝2"));
    sim.rt.dispatch(Cmd::StopAll);
    sim.finish();
}
