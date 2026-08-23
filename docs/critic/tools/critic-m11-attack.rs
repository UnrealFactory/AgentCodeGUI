//! ★M11 R1 크리틱 — 공격 재생. **빌더의 재생 10판이 안 잡는 자리**만 친다.
//!
//! 돌리는 법(핀 워크트리에 복사해서):
//! ```text
//! cp docs/critic/tools/critic-m11-attack.rs <wt>/crates/ccg-engine/tests/critic_m11_attack.rs
//! CARGO_TARGET_DIR=%TEMP%/… cargo test -p ccg-engine --test critic_m11_attack -- --nocapture
//! ```
//!
//! 과녁 셋:
//!  · A1 — `hold_notice_due`가 **표가 죽은 뒤에도 살아남아** 거짓 대기 문장을 뱉는가
//!    (사용자가 조회 중에 계정을 손수 바꾼 판).
//!  · A2 — 같은 것, 이번엔 `Cmd::HoldCancel`("자동 이어서 끄기")로 표를 죽인 판.
//!  · A3 — **스탬피드**: 같은 계정에서 대기 중인 채팅 둘이 한 펌프에서 같은 후보를
//!    고른다(허브의 `set_busy`는 펌프 **앞**에서 한 번만 돈다) → 규칙 ①("노는 계정만")
//!    이 뚫린다.
use ccg_engine::clock::{Millis, VirtualClock, SEC};
use ccg_engine::driver::{CliDriver, SpawnSpec};
use ccg_engine::event::Event;
use ccg_engine::identity::*;
use ccg_engine::limit::{AccountSwitcher, SwitchPick, SwitchRequest};
use ccg_engine::runtime::{ChatRuntime, Cmd};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

// ── 하네스(빌더 재생과 같은 모양) ───────────────────────────────────────────

#[derive(Default)]
struct AcctCli {
    alive: bool,
    pending: Vec<Value>,
    spawned_as: Arc<Mutex<Vec<String>>>,
    limited: Arc<Mutex<BTreeSet<String>>>,
    account: String,
}

fn slug_of(spec: &SpawnSpec) -> String {
    spec.env_set
        .iter()
        .find(|(k, _)| k == "CLAUDE_CONFIG_DIR")
        .map(|(_, v)| v.rsplit(['\\', '/']).next().unwrap_or("").to_string())
        .unwrap_or_default()
}

impl CliDriver for AcctCli {
    fn spawn(&mut self, spec: &SpawnSpec) -> std::io::Result<()> {
        self.alive = true;
        self.account = slug_of(spec);
        self.spawned_as.lock().unwrap().push(self.account.clone());
        self.pending
            .push(json!({"type":"system","subtype":"init","session_id":"S1","model":"haiku"}));
        Ok(())
    }
    fn send(&mut self, line: Value) {
        if line["type"] != "user" {
            return;
        }
        if self.limited.lock().unwrap().contains(&self.account) {
            self.pending.push(json!({
                "type":"result","subtype":"error_during_execution","is_error":true,
                "result":"Claude AI usage limit reached|1755150000"
            }));
        } else {
            self.pending
                .push(json!({"type":"result","subtype":"success","is_error":false,"result":"OK"}));
        }
    }
    fn close_input(&mut self) {
        self.alive = false;
    }
    fn kill(&mut self) {
        self.alive = false;
    }
    fn process_alive(&self) -> bool {
        self.alive
    }
    fn poll_frames(&mut self, _now: Millis) -> Vec<Value> {
        std::mem::take(&mut self.pending)
    }
}

fn raw(account: &str) -> RawIdentity {
    RawIdentity {
        engine: RawEngine {
            kind: EngineKind::Claude,
            model: "haiku".into(),
            effort: EffortId::Minimal,
            codex_account: None,
        },
        billing: RawBilling {
            kind: BillingKind::Subscription,
            account: Some(account.into()),
            drop_env_key: Some(false),
        },
        cwd: r"C:\ccg-fixture\work".into(),
        add_dirs: vec![],
        mode: ModeId::Normal,
        system_prompt: None,
        output_style: None,
        tools: RawTools::default(),
    }
}

fn defaults(accounts: &[&str]) -> IdentityDefaults {
    IdentityDefaults {
        known_accounts: accounts.iter().map(|s| s.to_string()).collect(),
        ..Default::default()
    }
}

fn clock_at_limit() -> Arc<VirtualClock> {
    let c = VirtualClock::new();
    c.advance_to(1_000 * SEC);
    c.set_epoch_base((1_755_150_000 - 5 * 3600) * 1_000 - 1_000 * SEC);
    c
}

fn waits(rt: &ChatRuntime<AcctCli>) -> usize {
    rt.events()
        .iter()
        .filter(|e| matches!(e, Event::Notice(t) if t.contains("사용 한도에 걸려 대기합니다")))
        .count()
}

fn notices(rt: &ChatRuntime<AcctCli>) -> Vec<String> {
    rt.events()
        .iter()
        .filter_map(|e| match e {
            Event::Notice(t) => Some(t.clone()),
            _ => None,
        })
        .collect()
}

/// 셸의 워커가 "아직 조회 중"인 상태를 손으로 쥔다(빌더 재생 ⑧의 `Slow`와 같은 모양).
#[derive(Default)]
struct Slow {
    ready: AtomicBool,
    to: Option<String>,
}
impl AccountSwitcher for Slow {
    fn pending(&self) -> bool {
        !self.ready.load(Ordering::SeqCst)
    }
    fn pick(&self, req: &SwitchRequest) -> Option<SwitchPick> {
        if self.pending() {
            return None;
        }
        let to = self.to.as_ref()?;
        if req.tried.contains(to) {
            return None;
        }
        Some(SwitchPick { account: to.clone(), soonest_reset: None })
    }
}

fn armed_and_pending(hook: Arc<Slow>) -> (ChatRuntime<AcctCli>, Arc<VirtualClock>) {
    let clock = clock_at_limit();
    let cli = AcctCli {
        spawned_as: Default::default(),
        limited: Arc::new(Mutex::new(BTreeSet::from(["a_x".to_string()]))),
        ..Default::default()
    };
    let mut rt = ChatRuntime::new("c-1", raw("a@x"), defaults(&["a@x", "b@x"]), clock.clone(), cli)
        .expect("정규화")
        .with_account_switcher(hook);
    rt.dispatch(Cmd::Send { text: "첫 턴".into() });
    for _ in 0..3 {
        clock.advance_by(SEC);
        rt.tick();
    }
    (rt, clock)
}

// ── A1 — 조회 중에 사용자가 계정을 바꾸면 대기 문장이 **거짓말로 뒤늦게** 나온다 ──
//
// 재현: 표가 서고 훅은 `pending`(대기 문장 보류) → 사용자가 손수 b@x로 바꾼다 →
// §7.3이 표를 걷고 「계정을 바꿔서 대기표를 취소했어요」를 말한다 → 워커의 답이 도착해
// `pending`이 풀리면 `check_hold`가 **없는 표**의 대기 문장을 뱉는다.
// (`hold_notice_due`를 내리는 자리는 전환 성사와 `emit_hold_notice` 둘뿐이다.)
#[test]
fn a1_a_cancelled_hold_still_announces_that_it_is_waiting() {
    let hook = Arc::new(Slow { ready: AtomicBool::new(false), to: Some("b@x".into()) });
    let (mut rt, clock) = armed_and_pending(hook.clone());
    assert!(rt.hold().is_some(), "표는 서 있다(조회 중일 뿐)");
    assert_eq!(waits(&rt), 0, "조회 중에는 대기 선언을 미룬다(빌더 수정 ④)");

    // 사용자가 **손수** 계정을 바꾼다(설정/피커) — 자동 전환이 아니다.
    let mut patch = RawIdentityPatch::default();
    patch.billing.account = Some("b@x".into());
    rt.dispatch(Cmd::IdentitySet {
        patch,
        policy: ApplyPolicy::Now,
        op: PendingOp::Merge,
    });
    assert!(rt.hold().is_none(), "§7.3 — 계정을 바꾸면 표는 즉시 무효");

    // 워커의 조회가 도착한다(= pending 해제). 이제 말할 사실이 정해졌다 — 그런데 그 사실은
    // "표가 없다"이다.
    hook.ready.store(true, Ordering::SeqCst);
    for _ in 0..5 {
        clock.advance_by(SEC);
        rt.tick();
    }
    let n = waits(&rt);
    println!("[A1] 대기문장={n} hold={:?}\n     notices={:?}", rt.hold().is_some(), notices(&rt));
    assert_eq!(n, 0, "★ 표가 없는데 「사용 한도에 걸려 대기합니다」가 나왔다 — 취소 문장 바로 뒤에");
}

// ── A2 — 같은 구멍, 이번엔 사용자가 「자동 이어서 끄기」를 눌렀다 ────────────
#[test]
fn a2_turning_off_auto_resume_during_the_lookup_also_gets_a_phantom_wait_line() {
    let hook = Arc::new(Slow { ready: AtomicBool::new(false), to: None });
    let (mut rt, clock) = armed_and_pending(hook.clone());
    assert_eq!(waits(&rt), 0);
    rt.dispatch(Cmd::HoldCancel);
    assert!(rt.hold().is_none(), "취소 = 포기. 표가 없다");

    hook.ready.store(true, Ordering::SeqCst);
    for _ in 0..5 {
        clock.advance_by(SEC);
        rt.tick();
    }
    println!("[A2] 대기문장={} notices={:?}", waits(&rt), notices(&rt));
    assert_eq!(waits(&rt), 0, "★ 사용자가 포기한 표를 두고 '기다립니다'라고 말한다");
}

// ── A3 — 스탬피드: 같은 계정에 묶여 대기하던 두 채팅이 **같은 펌프**에서 같은 후보로 ──
//
// 허브 규약(`hub.rs::pump`): `set_busy(burning_accounts())`는 펌프 **한 바퀴에 한 번**,
// 슬롯 tick **앞**에서 돈다. 그래서 같은 바퀴 안에서 채팅1이 b@x로 옮겨 스폰해도
// 채팅2의 `pick`이 보는 busy에는 b@x가 없다. 스냅샷 usage도 그대로다.
// → 둘 다 b@x로 간다 = 규칙 ①("노는 계정만")이 막으려던 바로 그 상태.
//
// 워커 스냅샷이 도착하는 순간 대기 중인 N개 채팅이 **동시에** 열리므로, 이건 좁은
// 레이스가 아니라 이 기능의 정상 경로다.
#[test]
fn a3_two_chats_waiting_on_the_same_dead_account_both_land_on_the_same_candidate() {
    /// 허브를 모사한 훅 — busy는 펌프 앞에서만 갱신된다.
    struct HubLike {
        ready: AtomicBool,
        busy: Mutex<BTreeSet<String>>,
        free: Vec<String>,
        picks: Mutex<Vec<(String, String)>>,
    }
    impl AccountSwitcher for HubLike {
        fn pending(&self) -> bool {
            !self.ready.load(Ordering::SeqCst)
        }
        fn pick(&self, req: &SwitchRequest) -> Option<SwitchPick> {
            if self.pending() {
                return None;
            }
            let BillingAxis::Subscription { account: cur, .. } = req.current else { return None };
            let busy = self.busy.lock().unwrap().clone();
            // `switch::plan`과 같은 순서: 현재 · 기시도 · busy를 제외한 첫 후보.
            let to = self
                .free
                .iter()
                .find(|e| *e != cur && !req.tried.contains(*e) && !busy.contains(*e))?
                .clone();
            self.picks.lock().unwrap().push((req.chat_id.to_string(), to.clone()));
            Some(SwitchPick { account: to, soonest_reset: None })
        }
    }
    let hook = Arc::new(HubLike {
        ready: AtomicBool::new(false),
        busy: Mutex::new(BTreeSet::new()),
        free: vec!["b@x".into(), "c@x".into()],
        picks: Mutex::new(vec![]),
    });
    let clock = clock_at_limit();
    let limited = Arc::new(Mutex::new(BTreeSet::from(["a_x".to_string()])));
    let mk = |id: &str| {
        let cli = AcctCli {
            spawned_as: Default::default(),
            limited: limited.clone(),
            ..Default::default()
        };
        ChatRuntime::new(id, raw("a@x"), defaults(&["a@x", "b@x", "c@x"]), clock.clone(), cli)
            .expect("정규화")
            .with_account_switcher(hook.clone())
    };
    let mut one = mk("chat-1");
    let mut two = mk("chat-2");
    one.dispatch(Cmd::Send { text: "1번 질문".into() });
    two.dispatch(Cmd::Send { text: "2번 질문".into() });

    // 허브 펌프 = busy 갱신 1회 + 슬롯 순서대로 tick.
    let pump = |one: &mut ChatRuntime<AcctCli>, two: &mut ChatRuntime<AcctCli>| {
        clock.advance_by(20);
        let mut busy = BTreeSet::new();
        for rt in [&*one, &*two] {
            if rt.state() != ccg_engine::state::StateTag::Idle {
                if let Some(a) = rt.identity().account() {
                    busy.insert(a.to_string());
                }
            }
        }
        *hook.busy.lock().unwrap() = busy;
        one.tick();
        two.tick();
    };
    for _ in 0..40 {
        pump(&mut one, &mut two);
    }
    // 둘 다 a@x에서 한도를 맞고 대기 중이다(워커 조회가 아직).
    assert!(one.hold().is_some() && two.hold().is_some(), "둘 다 표가 서 있어야 한다");

    // 워커 스냅샷 도착 — 대기하던 채팅이 **동시에** 열린다.
    hook.ready.store(true, Ordering::SeqCst);
    for _ in 0..40 {
        pump(&mut one, &mut two);
    }
    let (a1, a2) = (
        one.identity().account().unwrap_or("").to_string(),
        two.identity().account().unwrap_or("").to_string(),
    );
    println!("[A3] chat-1={a1} chat-2={a2} picks={:?}", hook.picks.lock().unwrap());
    assert_ne!(a1, a2, "★ 두 채팅이 같은 계정으로 갈아탔다 — 규칙 ①('노는 계정만')이 뚫렸다");
}
