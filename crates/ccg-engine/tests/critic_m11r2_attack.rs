//! ★M11 **R2 확인 크리틱** — 스탬피드(C2)·유령 문장(C3)의 독립 재생.
//!
//! 돌리는 법(핀 워크트리에 복사해서):
//! ```text
//! cp docs/critic/tools/critic-m11r2-attack.rs <wt>/crates/ccg-engine/tests/critic_m11r2_attack.rs
//! CARGO_TARGET_DIR=%TEMP%/… cargo test -p ccg-engine --test critic_m11r2_attack -- --nocapture
//! ```
//!
//! 빌더의 재생 ⑪·⑫를 믿지 않고 **내 하네스로** 같은 성질을 묻는다. 훅은 전부
//! *예약 장부를 모르는 스텁*이다(구형 훅·미배선 훅과 같은 모양) — 마지막 문을 닫는 것이
//! 엔진의 `limit::SwitchLedger`라는 주장을 그 조건에서만 확인할 수 있기 때문이다.
//!
//! | # | 과녁 |
//! |---|---|
//! | B1 | 채팅 **셋**이 한 tick에 동시에 열려도 서로 다른 계정으로 갈리나 |
//! | B2 | 후보보다 채팅이 많으면 **초과분은 안 집는가**(같은 계정 이중 취득 금지) |
//! | B3 | 유령 대기 문장 — 표를 죽이는 **네 경로** 전부 |
//! | B4 | 장부 TTL(60s)이 지난 뒤에는 같은 계정을 다시 내주나(영구 잠김 아님) |
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

// ── 하네스 ──────────────────────────────────────────────────────────────────

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
        self.pending.push(json!({"type":"system","subtype":"init","session_id":"S1","model":"haiku"}));
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
            self.pending.push(json!({"type":"result","subtype":"success","is_error":false,"result":"OK"}));
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
        engine: RawEngine { kind: EngineKind::Claude, model: "haiku".into(), effort: EffortId::Minimal, codex_account: None , codex_tier: None },
        billing: RawBilling { kind: BillingKind::Subscription, account: Some(account.into()), drop_env_key: Some(false) },
        cwd: r"C:\ccg-fixture\work".into(),
        add_dirs: vec![],
        mode: ModeId::Normal,
        system_prompt: None,
        output_style: None,
        tools: RawTools::default(),
    }
}

fn defaults(accounts: &[&str]) -> IdentityDefaults {
    IdentityDefaults { known_accounts: accounts.iter().map(|s| s.to_string()).collect(), ..Default::default() }
}

fn clock_at_limit() -> Arc<VirtualClock> {
    let c = VirtualClock::new();
    c.advance_to(1_000 * SEC);
    c.set_epoch_base((1_755_150_000 - 5 * 3600) * 1_000 - 1_000 * SEC);
    c
}

fn account_of(rt: &ChatRuntime<AcctCli>) -> String {
    rt.identity().account().unwrap_or("").to_string()
}

fn waits(rt: &ChatRuntime<AcctCli>) -> usize {
    rt.events().iter().filter(|e| matches!(e, Event::Notice(t) if t.contains("사용 한도에 걸려 대기합니다"))).count()
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

/// **예약을 모르는** 훅 — 허브가 펌프 앞에서 한 번 채워 준 busy만 본다(= 최대 한 바퀴 낡음).
/// 셸의 `Switcher`가 하는 예약(집는 순간 busy로 보이기)은 여기 없다. 그 조건에서도
/// 갈려야 한다는 것이 R2의 주장이다(마지막 문 = 엔진 `SwitchLedger`).
struct PumpLagged {
    ready: AtomicBool,
    busy: Mutex<BTreeSet<String>>,
    free: Vec<String>,
    asked: Mutex<Vec<(String, String)>>,
}

impl AccountSwitcher for PumpLagged {
    fn pending(&self) -> bool {
        !self.ready.load(Ordering::SeqCst)
    }
    fn pick(&self, req: &SwitchRequest) -> Option<SwitchPick> {
        if self.pending() {
            return None;
        }
        let BillingAxis::Subscription { account: cur, .. } = req.current else { return None };
        let busy = self.busy.lock().unwrap().clone();
        let to = self.free.iter().find(|e| *e != cur && !req.tried.contains(*e) && !busy.contains(*e))?.clone();
        self.asked.lock().unwrap().push((req.chat_id.to_string(), to.clone()));
        Some(SwitchPick { account: to, soonest_reset: None })
    }
}

fn hook(free: &[&str]) -> Arc<PumpLagged> {
    Arc::new(PumpLagged {
        ready: AtomicBool::new(false),
        busy: Mutex::new(BTreeSet::new()),
        free: free.iter().map(|s| s.to_string()).collect(),
        asked: Mutex::new(vec![]),
    })
}

fn make(id: &str, hook: Arc<PumpLagged>, clock: Arc<VirtualClock>, limited: Arc<Mutex<BTreeSet<String>>>, known: &[&str]) -> ChatRuntime<AcctCli> {
    let cli = AcctCli { spawned_as: Default::default(), limited, ..Default::default() };
    ChatRuntime::new(id, raw("a@x"), defaults(known), clock, cli).expect("정규화").with_account_switcher(hook)
}

/// 허브 펌프 모사 — busy는 슬롯 tick **앞에서 한 번**만 갱신된다(허브 R1 규약).
fn pump_all(clock: &VirtualClock, hook: &PumpLagged, rts: &mut [&mut ChatRuntime<AcctCli>]) {
    clock.advance_by(20);
    let mut busy = BTreeSet::new();
    for rt in rts.iter() {
        if rt.state() != ccg_engine::state::StateTag::Idle {
            if let Some(a) = rt.identity().account() {
                busy.insert(a.to_string());
            }
        }
    }
    *hook.busy.lock().unwrap() = busy;
    for rt in rts.iter_mut() {
        rt.tick();
    }
}

// ── B1 — 채팅 **셋**이 동시에 열려도 셋 다 다른 계정 ────────────────────────
#[test]
fn b1_three_chats_opening_on_the_same_tick_split_three_ways() {
    let h = hook(&["b@x", "c@x", "d@x"]);
    let clock = clock_at_limit();
    let lim = Arc::new(Mutex::new(BTreeSet::from(["a_x".to_string()])));
    let known = ["a@x", "b@x", "c@x", "d@x"];
    let mut one = make("chat-1", h.clone(), clock.clone(), lim.clone(), &known);
    let mut two = make("chat-2", h.clone(), clock.clone(), lim.clone(), &known);
    let mut three = make("chat-3", h.clone(), clock.clone(), lim.clone(), &known);
    one.dispatch(Cmd::Send { text: "1".into() });
    two.dispatch(Cmd::Send { text: "2".into() });
    three.dispatch(Cmd::Send { text: "3".into() });
    for _ in 0..40 {
        pump_all(&clock, &h, &mut [&mut one, &mut two, &mut three]);
    }
    assert!(one.hold().is_some() && two.hold().is_some() && three.hold().is_some(), "셋 다 대기");
    h.ready.store(true, Ordering::SeqCst);
    for _ in 0..40 {
        pump_all(&clock, &h, &mut [&mut one, &mut two, &mut three]);
    }
    let got = [account_of(&one), account_of(&two), account_of(&three)];
    let uniq: BTreeSet<&String> = got.iter().collect();
    println!("[B1] 착지={got:?}  훅질문={:?}", h.asked.lock().unwrap());
    assert_eq!(uniq.len(), 3, "★ 두 채팅 이상이 같은 계정을 집었다 — 규칙 ①이 뚫렸다");
    assert!(!got.contains(&"a@x".to_string()), "소진 계정에 남은 채팅이 있다");
}

// ── B2 — 후보보다 채팅이 많으면 **초과분은 안 집는다** ──────────────────────
//
// 자유 계정 하나 + 대기 채팅 셋. 하나만 갈아타고 둘은 표를 든 채 남아야 한다.
// (같은 계정으로 둘이 가면 그게 스탬피드다.)
#[test]
fn b2_more_chats_than_candidates_means_the_extras_keep_waiting() {
    let h = hook(&["b@x"]);
    let clock = clock_at_limit();
    let lim = Arc::new(Mutex::new(BTreeSet::from(["a_x".to_string()])));
    let known = ["a@x", "b@x"];
    let mut rts: Vec<ChatRuntime<AcctCli>> =
        (1..=3).map(|i| make(&format!("chat-{i}"), h.clone(), clock.clone(), lim.clone(), &known)).collect();
    for (i, rt) in rts.iter_mut().enumerate() {
        rt.dispatch(Cmd::Send { text: format!("{i}") });
    }
    let mut refs: Vec<&mut ChatRuntime<AcctCli>> = rts.iter_mut().collect();
    for _ in 0..40 {
        pump_all(&clock, &h, &mut refs);
    }
    h.ready.store(true, Ordering::SeqCst);
    for _ in 0..60 {
        pump_all(&clock, &h, &mut refs);
    }
    let got: Vec<String> = refs.iter().map(|rt| account_of(rt)).collect();
    let moved = got.iter().filter(|a| *a == "b@x").count();
    println!("[B2] 착지={got:?}");
    assert_eq!(moved, 1, "★ 자유 계정이 하나뿐인데 {moved}개 채팅이 그 계정으로 갔다");
}

// ── B3 — 유령 대기 문장: 표를 죽이는 **네 경로** ────────────────────────────

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

#[test]
fn b3_a_dead_hold_never_announces_a_wait_on_any_of_the_four_paths() {
    // ① 사용자가 손수 계정을 바꾼다(§7.3 apply_identity).
    {
        let hk = Arc::new(Slow { ready: AtomicBool::new(false), to: Some("b@x".into()) });
        let (mut rt, clock) = armed_and_pending(hk.clone());
        assert!(rt.hold().is_some() && waits(&rt) == 0, "표는 서 있고 문장은 미뤄졌다");
        let mut patch = RawIdentityPatch::default();
        patch.billing.account = Some("b@x".into());
        rt.dispatch(Cmd::IdentitySet { patch, policy: ApplyPolicy::Now, op: PendingOp::Merge });
        assert!(rt.hold().is_none());
        hk.ready.store(true, Ordering::SeqCst);
        for _ in 0..8 {
            clock.advance_by(SEC);
            rt.tick();
        }
        println!("[B3-①] 계정 손수 변경: 대기문장={} notices={:?}", waits(&rt), notices(&rt));
        assert_eq!(waits(&rt), 0, "★ 취소 문장 바로 뒤에 '기다립니다'가 붙었다");
    }
    // ② 사용자가 「자동 이어서 끄기」를 눌렀다(Cmd::HoldCancel).
    {
        let hk = Arc::new(Slow { ready: AtomicBool::new(false), to: None });
        let (mut rt, clock) = armed_and_pending(hk.clone());
        rt.dispatch(Cmd::HoldCancel);
        assert!(rt.hold().is_none());
        hk.ready.store(true, Ordering::SeqCst);
        for _ in 0..8 {
            clock.advance_by(SEC);
            rt.tick();
        }
        println!("[B3-②] 자동 끄기: 대기문장={} notices={:?}", waits(&rt), notices(&rt));
        assert_eq!(waits(&rt), 0, "★ 사용자가 포기한 표를 두고 '기다립니다'라고 말한다");
    }
    // ③ 전환이 성사됐다(표가 전환으로 죽는 경로) — 갈아탄 뒤에 대기 선언이 붙으면 거짓말이다.
    {
        let hk = Arc::new(Slow { ready: AtomicBool::new(false), to: Some("b@x".into()) });
        let (mut rt, clock) = armed_and_pending(hk.clone());
        hk.ready.store(true, Ordering::SeqCst);
        for _ in 0..8 {
            clock.advance_by(SEC);
            rt.tick();
        }
        println!("[B3-③] 전환 성사: acct={} 대기문장={} notices={:?}", account_of(&rt), waits(&rt), notices(&rt));
        assert_eq!(account_of(&rt), "b@x", "전환은 성사됐다");
        assert_eq!(waits(&rt), 0, "★ 갈아탔는데 '한도라 대기합니다'가 나왔다");
    }
    // ④ **유예 상한**만 지나고 표는 살아 있다 — 이때는 반드시 **말해야** 한다(D7).
    {
        let hk = Arc::new(Slow { ready: AtomicBool::new(false), to: None });
        let (mut rt, clock) = armed_and_pending(hk.clone());
        for _ in 0..10 {
            clock.advance_by(SEC);
            rt.tick();
        }
        println!("[B3-④] 훅이 굳었다: hold={} 대기문장={}", rt.hold().is_some(), waits(&rt));
        assert!(rt.hold().is_some(), "표는 살아 있다");
        assert_eq!(waits(&rt), 1, "★ 훅이 굳으면 늦게라도 말해야 한다(침묵 금지)");
    }
}

// ── B4 — 장부는 **영구 잠금이 아니다**: TTL이 지나면 그 계정을 다시 내준다 ──
//
// 채팅1이 b@x를 집고 죽었다(창을 닫았다) 치자. 60초 뒤에는 채팅2가 b@x로 갈 수 있어야
// 한다 — 아니면 사고 한 번에 계정 하나가 영영 후보에서 빠진다.
#[test]
fn b4_a_reservation_expires_so_a_dead_chat_cannot_hoard_an_account() {
    let l = ccg_engine::limit::SwitchLedger::default();
    let t0 = 1_800_000_000_000u64;
    l.take("chat-1", "b@x", t0);
    assert!(l.taken_by_other("chat-2", "b@x", t0 + 1_000), "갓 집은 계정은 남에게 막혀 있다");
    assert!(!l.taken_by_other("chat-1", "b@x", t0 + 1_000), "자기 예약은 자기를 막지 않는다");
    let ttl = ccg_engine::limit::TAKEN_TTL_MS;
    println!("[B4] TTL={ttl}ms");
    assert!(!l.taken_by_other("chat-2", "b@x", t0 + ttl + 1), "★ TTL이 지나도 잠겨 있다 = 영구 배제");
}
