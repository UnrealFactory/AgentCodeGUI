//! ★M11 재생 — **한도 소진 시 초기화 임박순으로 노는 계정 자동 전환**(3.0.0 신기능 3).
//!
//! 여기는 **상태기계 층**이다: 후보를 *고르는* 판정식은 `ccg-auth::switch::plan`의
//! 단위 테스트가 잡고(오염 스킵·임박 정렬·여유 하한·Fable 창), 이 파일은 그 답을 받은
//! 엔진이 *무엇을 하는가*를 잡는다 — 대기표를 걷었는가, 리비전 origin이 맞는가,
//! 배너가 전환당 하나인가, 죽은 턴이 이어졌는가, 꺼져 있으면 정말 무동작인가.
//!
//! 합성은 둘이다: **합성 한도**(스폰마다 한도 에러를 내는 가짜 CLI — 계정별로 갈린다)와
//! **합성 usage**([`ScriptedSwitcher`] — 셸이 `usage-cache.json`으로 할 판정을 대본으로).
//! 실계정·네트워크는 이 파일 어디에도 없다.
use ccg_engine::clock::{Clock, Millis, VirtualClock, MIN, SEC};
use ccg_engine::driver::{CliDriver, SpawnSpec};
use ccg_engine::event::{Event, RevisionOrigin};
use ccg_engine::identity::*;
use ccg_engine::limit::{AccountSwitcher, SwitchPick, SwitchRequest};
use ccg_engine::runtime::{ChatRuntime, Cmd};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

/// 계정별로 답이 갈리는 가짜 CLI. `limited`에 든 계정으로 스폰되면 **한도 에러**,
/// 아니면 평범한 성공 result. 실제 상황과 같은 모양이다(같은 채팅, 계정만 다름).
#[derive(Default)]
struct AcctCli {
    alive: bool,
    pending: Vec<Value>,
    /// 스폰될 때마다 그때의 계정(=`CLAUDE_CONFIG_DIR` 꼬리)을 기록한다.
    spawned_as: Arc<Mutex<Vec<String>>>,
    /// 지금 막혀 있는 계정(슬러그). **주행 중 바뀐다** — 한도는 시간이 지나면 풀리고,
    /// "풀린 뒤 깨끗한 턴"이 에피소드를 닫는지가 재생 ⑤의 과녁이다.
    limited: Arc<Mutex<BTreeSet<String>>>,
    /// ★R2 — `(계정 슬러그, 나간 프롬프트)`. 재생 ⑩이 읽는다.
    sent_by: Arc<Mutex<Vec<(String, String)>>>,
    account: String,
}

/// `…/accounts/<slug>` 꼬리에서 계정 슬러그를 뽑는다(`a@x` → `a_x`).
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
        // **사용자 메시지에만 답한다.** 스폰마다 stdin으로 나가는 줄은 둘이다 —
        // `control_request{initialize}`(핸드셰이크)와 프롬프트(`type:"user"`).
        // 둘 다에 result를 물리면 턴 하나에 result가 둘이 되고, 한도 판에서는 그게
        // **두 번째 `arm_hold`** 로 나타나 "갈아탔는데 표가 또 섰다"는 없는 증상을
        // 재생한다(R1 부분 작업의 재생 ①이 딱 그 함정에 빠져 있었다).
        if line["type"] != "user" {
            return;
        }
        // ★R2 — **어느 계정으로 무슨 말이 나갔나.** 재생 ⑩(떠난 계정으로 나가는 나팔)의
        // 관측 축이다. `sent_user_texts()`는 계정을 모르므로 여기서 짝지어 적는다.
        self.sent_by.lock().unwrap().push((
            self.account.clone(),
            line["message"]["content"][0]["text"].as_str().unwrap_or("").to_string(),
        ));
        let blocked = self.limited.lock().unwrap().contains(&self.account);
        if std::env::var("M11_TRACE").is_ok() {
            println!("  >> send as {:?} limited={blocked}", self.account);
        }
        if blocked {
            self.pending.push(json!({
                "type":"result","subtype":"error_during_execution","is_error":true,
                "result":"Claude AI usage limit reached|1755150000"
            }));
        } else {
            self.pending.push(json!({
                "type":"result","subtype":"success","is_error":false,"result":"OK"
            }));
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

/// 셸의 전환 훅 대역 — **합성 usage**. `next`가 "지금 계정 → 갈아탈 계정"이고,
/// `off`면 설정이 꺼진 상태(항상 후보 없음)를 흉내 낸다.
#[derive(Default)]
struct ScriptedSwitcher {
    off: bool,
    next: BTreeMap<String, (String, Option<u64>)>,
    calls: Mutex<Vec<String>>,
}

impl AccountSwitcher for ScriptedSwitcher {
    fn pick(&self, req: &SwitchRequest) -> Option<SwitchPick> {
        let BillingAxis::Subscription { account, .. } = req.current else { return None };
        self.calls.lock().unwrap().push(account.clone());
        if self.off {
            return None;
        }
        let (to, reset) = self.next.get(account.as_str())?;
        // 셸의 `switch::plan`이 하는 일 중 **엔진이 강제하는 규약** 하나를 여기서도 지킨다:
        // 이 에피소드에서 이미 거쳐 온 계정은 후보가 아니다.
        if req.tried.contains(to) {
            return None;
        }
        Some(SwitchPick { account: to.clone(), soonest_reset: *reset })
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

struct Fx {
    rt: ChatRuntime<AcctCli>,
    clock: Arc<VirtualClock>,
    spawned: Arc<Mutex<Vec<String>>>,
    sw: Arc<ScriptedSwitcher>,
    limited: Arc<Mutex<BTreeSet<String>>>,
    sent_by: Arc<Mutex<Vec<(String, String)>>>,
}

impl Fx {
    /// "그 계정의 한도가 풀렸다" — 바깥 세계의 변화를 주행 중에 넣는다.
    fn unblock(&self, account: &str) {
        self.limited.lock().unwrap().remove(&account.replace('@', "_"));
    }
    fn banners(&self) -> Vec<String> {
        self.rt
            .events()
            .iter()
            .filter_map(|e| match e {
                Event::AccountSwitched { from, to, .. } => Some(format!("{from}→{to}")),
                _ => None,
            })
            .collect()
    }
}

fn fx(accounts: &[&str], limited: &[&str], sw: ScriptedSwitcher) -> Fx {
    let clock = VirtualClock::new();
    clock.advance_to(1_000 * SEC);
    // 문구 꼬리의 리셋(1755150000)이 "5시간 뒤"가 되게 벽시계를 놓는다.
    clock.set_epoch_base((1_755_150_000 - 5 * 3600) * 1_000 - 1_000 * SEC);
    let spawned: Arc<Mutex<Vec<String>>> = Default::default();
    let blocked: Arc<Mutex<BTreeSet<String>>> =
        Arc::new(Mutex::new(limited.iter().map(|a| a.replace('@', "_")).collect()));
    let sent_by: Arc<Mutex<Vec<(String, String)>>> = Default::default();
    let cli = AcctCli {
        spawned_as: spawned.clone(),
        limited: blocked.clone(),
        sent_by: sent_by.clone(),
        ..Default::default()
    };
    let defaults = IdentityDefaults {
        known_accounts: accounts.iter().map(|s| s.to_string()).collect(),
        ..Default::default()
    };
    let sw = Arc::new(sw);
    let rt = ChatRuntime::new("c-1", raw(accounts[0]), defaults, clock.clone(), cli)
        .expect("정규화")
        .with_account_switcher(sw.clone());
    Fx { rt, clock, spawned, sw, limited: blocked, sent_by }
}

fn pump(f: &mut Fx, secs: u64) {
    pump_by(f, secs, SEC)
}

/// 큰 걸음으로 민다 — 5시간 창의 리셋(대기표 만기)까지 가야 하는 시나리오용.
fn pump_by(f: &mut Fx, steps: u64, step: Millis) {
    for _ in 0..steps {
        f.clock.advance_by(step);
        f.rt.tick();
        if std::env::var("M11_TRACE").is_ok() {
            println!(
                "  t+{:>3} state={:?} acct={} hold={:?} tried={:?} q={} spawns={:?}",
                f.clock.now_ms() / 1000,
                f.rt.state(),
                account_of(&f.rt),
                f.rt.hold().map(|h| (h.ready, h.resets_at)),
                f.rt.switch_tried(),
                f.rt.queue_len(),
                f.spawned.lock().unwrap().len()
            );
        }
    }
}

fn scripted(pairs: &[(&str, &str, Option<u64>)]) -> ScriptedSwitcher {
    ScriptedSwitcher {
        off: false,
        next: pairs.iter().map(|(a, b, r)| (a.to_string(), (b.to_string(), *r))).collect(),
        calls: Mutex::new(vec![]),
    }
}

fn account_of(rt: &ChatRuntime<AcctCli>) -> String {
    rt.identity().account().unwrap_or("").to_string()
}

/// ① **후보 있음** — 한도에 걸리자마자 노는 계정으로 갈아타고 죽은 턴을 이어간다.
#[test]
fn a_limit_hit_switches_to_the_free_account_and_carries_the_turn() {
    let mut f = fx(&["a@x", "b@x"], &["a@x"], scripted(&[("a@x", "b@x", Some(1_755_150_000))]));
    f.rt.dispatch(Cmd::Send { text: "첫 턴".into() });
    pump(&mut f, 30);

    let spawns = f.spawned.lock().unwrap().clone();
    if std::env::var("M11_TRACE").is_ok() {
        for e in f.rt.events() {
            println!("  ev {e:?}");
        }
        println!("  sent={:?}", f.rt.sent_user_texts());
    }
    println!("[m11-①] account={} hold={:?} spawns={spawns:?}", account_of(&f.rt), f.rt.hold().map(|h| h.ready));
    assert_eq!(account_of(&f.rt), "b@x", "★ 계정이 갈렸어야 한다");
    assert!(f.rt.hold().is_none(), "★ 대기표는 남으면 안 된다(갈아탔으니 기다릴 이유가 없다)");
    assert_eq!(spawns, vec!["a_x", "b_x"], "★ 두 번째 스폰은 새 계정으로");

    // 배너는 **전환당 정확히 하나**(모델 폴백과 같은 불변식 13).
    let evs = f.rt.events();
    let banners: Vec<_> = evs
        .iter()
        .filter_map(|e| match e {
            Event::AccountSwitched { from, to, soonest_reset, revert_to } => {
                Some((from.clone(), to.clone(), *soonest_reset, *revert_to))
            }
            _ => None,
        })
        .collect();
    assert_eq!(banners.len(), 1, "배너가 하나가 아니다: {banners:?}");
    assert_eq!(banners[0].0, "a@x");
    assert_eq!(banners[0].1, "b@x");
    assert_eq!(banners[0].2, Some(1_755_150_000));

    // 리비전 origin이 곧 "내가 고른 값이 아니다" 표식이고, `revert_to`는 그 직전이다.
    let origins: Vec<_> = evs
        .iter()
        .filter_map(|e| match e {
            Event::Identity { origin, revision, changed, .. } => Some((origin.clone(), *revision, changed.clone())),
            _ => None,
        })
        .collect();
    let sw = origins.iter().find(|(o, _, _)| *o == RevisionOrigin::AutoAccountSwitch).expect("전환 리비전");
    assert_eq!(sw.2, vec![IdentityField::BillingAccount], "계정 리프 하나만 바뀌어야 한다");
    assert_eq!(banners[0].3, sw.1 - 1, "되돌리기 지점은 전환 직전 리비전");

    // 죽은 턴이 실제로 이어졌는가 — 나팔이 나갔고 새 계정에서 성공 result가 왔다.
    assert!(f.rt.sent_user_texts().iter().any(|t| t.contains("이어서 진행해 주세요")), "재개 나팔이 안 나갔다");
    assert!(f.rt.hold().is_none() && f.rt.queue_len() == 0);
}

/// ② **후보 없음** — 훅이 `None`이면 옛 경로 그대로(대기표가 서고 문장이 나간다).
#[test]
fn no_candidate_falls_back_to_the_plain_hold() {
    let mut f = fx(&["a@x"], &["a@x"], scripted(&[]));
    f.rt.dispatch(Cmd::Send { text: "첫 턴".into() });
    pump(&mut f, 30);

    let h = f.rt.hold().expect("★ 후보가 없으면 대기표가 서야 한다");
    println!("[m11-②] hold.resets_at={:?} ready={} account={}", h.resets_at, h.ready, account_of(&f.rt));
    assert_eq!(account_of(&f.rt), "a@x", "계정은 그대로");
    assert!(h.resets_at.is_some(), "에러 꼬리의 리셋 시각을 그대로 쓴다");
    assert!(f
        .rt
        .events()
        .iter()
        .any(|e| matches!(e, Event::Notice(t) if t.contains("사용 한도에 걸려 대기합니다"))));
    assert_eq!(f.spawned.lock().unwrap().len(), 1, "전환이 없으면 재스폰도 없다");
}

/// ③ **설정 꺼짐** — 훅은 붙어 있지만 꺼져 있다. ②와 **한 글자도 다르지 않아야** 한다.
#[test]
fn the_setting_being_off_is_indistinguishable_from_not_having_the_feature() {
    let off = ScriptedSwitcher {
        off: true,
        next: [("a@x".to_string(), ("b@x".to_string(), None))].into_iter().collect(),
        calls: Mutex::new(vec![]),
    };
    let mut f = fx(&["a@x", "b@x"], &["a@x"], off);
    f.rt.dispatch(Cmd::Send { text: "첫 턴".into() });
    pump(&mut f, 30);

    println!("[m11-③] account={} hold={:?} 훅호출={}", account_of(&f.rt), f.rt.hold().is_some(), f.sw.calls.lock().unwrap().len());
    assert_eq!(account_of(&f.rt), "a@x", "★ 꺼져 있으면 계정은 안 바뀐다");
    assert!(f.rt.hold().is_some(), "★ 꺼져 있으면 대기표 경로 그대로");
    assert_eq!(f.spawned.lock().unwrap().clone(), vec!["a_x"]);
    assert!(!f.rt.events().iter().any(|e| matches!(e, Event::AccountSwitched { .. })));
}

/// ④ **연속 소진 A→B→C** — 갈아탄 계정도 막히면 그다음으로. C에서 착지한다.
#[test]
fn consecutive_exhaustion_walks_a_to_b_to_c() {
    let mut f = fx(
        &["a@x", "b@x", "c@x"],
        &["a@x", "b@x"], // c만 살아 있다
        scripted(&[("a@x", "b@x", Some(1_755_150_000)), ("b@x", "c@x", Some(1_755_160_000)), ("c@x", "a@x", None)]),
    );
    f.rt.dispatch(Cmd::Send { text: "첫 턴".into() });
    pump(&mut f, 60);

    let spawns = f.spawned.lock().unwrap().clone();
    println!("[m11-④] spawns={spawns:?} account={} tried={:?}", account_of(&f.rt), f.rt.switch_tried());
    assert_eq!(spawns, vec!["a_x", "b_x", "c_x"], "★ A→B→C 한 번씩");
    assert_eq!(account_of(&f.rt), "c@x");
    assert!(f.rt.hold().is_none(), "★ C에서 답이 왔으니 표는 없다");
    assert_eq!(f.banners(), vec!["a@x→b@x", "b@x→c@x"], "★ 전환당 배너 하나");
    // 죽은 턴이 딱 한 번 이어졌는가 — 계정을 두 번 갈았다고 나팔이 두 번 나가면
    // 사용자는 같은 질문을 세 번 보낸 셈이 된다.
    let sent = f.rt.sent_user_texts();
    assert_eq!(sent.iter().filter(|t| t.contains("이어서 진행해 주세요")).count(), 2, "전환마다 나팔 1개: {sent:?}");
}

/// ④' **핑퐁 금지** — 계정이 셋 다 막히면 A로 **되돌아가지 않고** 대기표에 착지한다.
///
/// 대본은 `c@x → a@x`를 준다. 에피소드 제외 집합(`switch_tried`)이 없으면 여기서
/// A로 돌아가고, A는 아직 안 풀렸으니 A→B→C→A→… 가 영원히 돈다(R1 부분 작업의
/// 재생 ④는 실제로 안 끝났다 — `on_result`의 에피소드 정리가 표의 생사만 봤기 때문).
#[test]
fn a_full_house_lands_on_the_hold_and_never_loops_back_to_a() {
    let mut f = fx(
        &["a@x", "b@x", "c@x"],
        &["a@x", "b@x", "c@x"], // 셋 다 막혔다
        scripted(&[("a@x", "b@x", Some(1_755_150_000)), ("b@x", "c@x", Some(1_755_160_000)), ("c@x", "a@x", None)]),
    );
    f.rt.dispatch(Cmd::Send { text: "첫 턴".into() });
    pump(&mut f, 120);

    let spawns = f.spawned.lock().unwrap().clone();
    println!("[m11-④'] spawns={spawns:?} account={} tried={:?} hold={:?}", account_of(&f.rt), f.rt.switch_tried(), f.rt.hold().map(|h| h.ready));
    assert_eq!(spawns, vec!["a_x", "b_x", "c_x"], "★ 각 계정 정확히 한 번 — A로 안 돌아간다");
    assert_eq!(account_of(&f.rt), "c@x");
    assert_eq!(f.banners(), vec!["a@x→b@x", "b@x→c@x"], "★ 3번째 배너(c→a)는 없어야 한다");
    assert!(f.rt.hold().is_some(), "★ 후보가 바닥나면 옛 경로(대기표)로 착지한다");
    assert_eq!(
        f.rt.switch_tried().iter().cloned().collect::<Vec<_>>(),
        vec!["a@x", "b@x", "c@x"],
        "★ 에피소드가 살아 있다 = 셋 다 거쳐 왔다는 기억이 남아 있다"
    );
    assert!(f
        .rt
        .events()
        .iter()
        .any(|e| matches!(e, Event::Notice(t) if t.contains("사용 한도에 걸려 대기합니다"))));
}

/// ⑤ **에피소드 경계** — 한도 없이 착지한 턴이 거쳐 온 계정 목록을 비운다.
///
/// 안 비우면 "아침에 A→B로 갈아탔다"가 저녁 한도에서도 A를 후보에서 지운다.
#[test]
fn a_clean_turn_clears_the_episode_so_tomorrow_can_use_a_again() {
    // 둘 다 막혔다 → A→B로 갈아타고 B도 막힌다 = **에피소드가 살아 있는 상태**를 잡는다.
    // (한 계정만 막힌 판으로는 이 구간을 못 본다: 전환 직후의 깨끗한 턴이 같은 tick에
    //  에피소드를 닫아 버려 관측 창이 0이다.)
    let mut f = fx(&["a@x", "b@x"], &["a@x", "b@x"], scripted(&[("a@x", "b@x", None)]));
    f.rt.dispatch(Cmd::Send { text: "첫 턴".into() });
    pump(&mut f, 30);
    assert_eq!(account_of(&f.rt), "b@x");
    assert!(f.rt.hold().is_some(), "B도 막혔으니 후보가 없어 표가 선다");
    assert_eq!(
        f.rt.switch_tried().iter().cloned().collect::<Vec<_>>(),
        vec!["a@x", "b@x"],
        "전환 직후에는 에피소드가 살아 있다"
    );

    // 바깥 세계에서 한도가 풀렸다 → 리셋 시각이 지나 표가 스스로 소진되고 턴이 착지한다.
    f.unblock("b@x");
    pump_by(&mut f, 40, 10 * MIN); // 5시간 창을 넘긴다(에러 꼬리 = now + 5h)
    println!("[m11-⑤] tried={:?} hold={:?}", f.rt.switch_tried(), f.rt.hold().is_some());
    assert!(f.rt.hold().is_none(), "풀린 뒤 깨끗하게 착지했다");
    assert!(f.rt.switch_tried().is_empty(), "★ 깨끗한 턴이 에피소드를 닫아야 한다");
}

/// ⑥ **스펙 ⑤와의 관계** — 화면 밖 채팅(`auto_resume=false`)은 **혼자 계정을 갈지 않는다**.
///
/// 자동 전환도 자동 발사다. 여섯 개의 화면 밖 채팅이 앱을 켜자마자 남은 계정을
/// 나눠 태우기 시작하면 그건 사용자가 시킨 적 없는 소비다.
#[test]
fn an_offscreen_chat_does_not_switch_accounts_on_its_own() {
    let mut f = fx(&["a@x", "b@x"], &["a@x"], scripted(&[("a@x", "b@x", None)]));
    f.rt.set_auto_resume(false);
    f.rt.dispatch(Cmd::Send { text: "첫 턴".into() });
    pump(&mut f, 30);

    println!("[m11-⑥] account={} hold={:?}", account_of(&f.rt), f.rt.hold().map(|h| h.ready));
    assert_eq!(account_of(&f.rt), "a@x", "★ 화면 밖은 안 갈아탄다");
    assert!(f.rt.hold().is_some(), "대기표는 남아 사이드바가 '이어갈 수 있음'을 그린다");

    // 사용자가 [이어가기]를 누르면 auto_resume가 켜지고 — 그 턴이 또 막히면 그때 전환된다.
    f.rt.resume_now();
    pump(&mut f, 30);
    println!("[m11-⑥'] 누른 뒤 account={} spawns={:?}", account_of(&f.rt), f.spawned.lock().unwrap());
    assert_eq!(account_of(&f.rt), "b@x", "★ 사용자가 누른 뒤에는 전환이 열린다");
}

/// ⑧ **미뤄 둔 대기 문장** — 훅이 "조회 중"이면 대기 선언을 **한 tick 미룬다**.
///
/// R1 실물 주행에서 두 줄이 0.3초 간격으로 떴다:
///   「사용 한도에 걸려 대기합니다 — 풀리는 시각에 맞춰 이어서 보낼게요.」
///   「사용 한도에 걸려 soon@… 계정으로 바꿔 이어갑니다 …」
/// 앞 줄은 말하는 순간에도 거짓이 될 예정이었다(셸이 usage를 조회하는 중이었을 뿐).
///
/// 두 갈래를 함께 잡는다:
///  ⓐ 조회가 성사되면 대기 문장은 **끝내 안 나온다**(전환 배너 하나뿐).
///  ⓑ 조회가 "갈 데 없음"으로 판명되면 그때 대기 문장이 **정확히 한 번** 나온다.
#[test]
fn the_wait_sentence_waits_until_there_is_something_true_to_say() {
    #[derive(Default)]
    struct Slow {
        ready: std::sync::atomic::AtomicBool,
        /// 답이 정해진 뒤에도 후보가 있느냐 없느냐.
        has: bool,
    }
    impl AccountSwitcher for Slow {
        fn pending(&self) -> bool {
            !self.ready.load(std::sync::atomic::Ordering::SeqCst)
        }
        fn pick(&self, req: &SwitchRequest) -> Option<SwitchPick> {
            if self.pending() || !self.has || req.tried.contains("b@x") {
                return None;
            }
            Some(SwitchPick { account: "b@x".into(), soonest_reset: None })
        }
    }
    let waits = |rt: &ChatRuntime<AcctCli>| {
        rt.events()
            .iter()
            .filter(|e| matches!(e, Event::Notice(t) if t.contains("사용 한도에 걸려 대기합니다")))
            .count()
    };
    for has in [true, false] {
        let hook = Arc::new(Slow { ready: Default::default(), has });
        let clock = VirtualClock::new();
        clock.advance_to(1_000 * SEC);
        clock.set_epoch_base((1_755_150_000 - 5 * 3600) * 1_000 - 1_000 * SEC);
        let cli = AcctCli {
            spawned_as: Default::default(),
            limited: Arc::new(Mutex::new(BTreeSet::from(["a_x".to_string()]))),
            ..Default::default()
        };
        let defaults = IdentityDefaults {
            known_accounts: BTreeSet::from(["a@x".to_string(), "b@x".to_string()]),
            ..Default::default()
        };
        let mut rt = ChatRuntime::new("c-1", raw("a@x"), defaults, clock.clone(), cli)
            .expect("정규화")
            .with_account_switcher(hook.clone());
        rt.dispatch(Cmd::Send { text: "첫 턴".into() });
        for _ in 0..3 {
            clock.advance_by(SEC);
            rt.tick();
        }
        assert!(rt.hold().is_some(), "표는 서 있다(조회 중일 뿐)");
        assert_eq!(waits(&rt), 0, "★ 조회 중에는 대기 선언을 하지 않는다(has={has})");
        // 셸의 조회가 도착했다.
        hook.ready.store(true, std::sync::atomic::Ordering::SeqCst);
        for _ in 0..10 {
            clock.advance_by(SEC);
            rt.tick();
        }
        let n = waits(&rt);
        println!("[m11-⑧ has={has}] 대기문장={n} account={:?} 배너={}", rt.identity().account(),
                 rt.events().iter().filter(|e| matches!(e, Event::AccountSwitched { .. })).count());
        if has {
            assert_eq!(rt.identity().account(), Some("b@x"));
            assert_eq!(n, 0, "★ 갈아탔으면 대기 문장은 끝내 안 나온다");
        } else {
            assert_eq!(rt.identity().account(), Some("a@x"));
            assert_eq!(n, 1, "★ 갈 데가 없다고 판명되면 그때 정확히 한 번 말한다");
        }
    }
}

/// ⑨ **유예 상한** — 훅이 영영 "조회 중"으로 굳어도 사용자는 결국 문장을 듣는다.
/// (워커 사망 = 침묵은 D7 위반. 늦은 말이 침묵보다 낫다.)
#[test]
fn a_wedged_hook_still_gets_the_sentence_out_eventually() {
    struct Wedged;
    impl AccountSwitcher for Wedged {
        fn pending(&self) -> bool {
            true
        }
        fn pick(&self, _r: &SwitchRequest) -> Option<SwitchPick> {
            None
        }
    }
    let clock = VirtualClock::new();
    clock.advance_to(1_000 * SEC);
    clock.set_epoch_base((1_755_150_000 - 5 * 3600) * 1_000 - 1_000 * SEC);
    let cli = AcctCli {
        spawned_as: Default::default(),
        limited: Arc::new(Mutex::new(BTreeSet::from(["a_x".to_string()]))),
        ..Default::default()
    };
    let defaults = IdentityDefaults { known_accounts: BTreeSet::from(["a@x".to_string()]), ..Default::default() };
    let mut rt = ChatRuntime::new("c-1", raw("a@x"), defaults, clock.clone(), cli)
        .expect("정규화")
        .with_account_switcher(Arc::new(Wedged));
    rt.dispatch(Cmd::Send { text: "첫 턴".into() });
    let waits = |rt: &ChatRuntime<AcctCli>| {
        rt.events().iter().filter(|e| matches!(e, Event::Notice(t) if t.contains("사용 한도에 걸려 대기합니다"))).count()
    };
    for _ in 0..3 {
        clock.advance_by(SEC);
        rt.tick();
    }
    assert_eq!(waits(&rt), 0, "유예 안에서는 아직");
    for _ in 0..10 {
        clock.advance_by(SEC);
        rt.tick();
    }
    println!("[m11-⑨] 대기문장={} (유예 뒤)", waits(&rt));
    assert_eq!(waits(&rt), 1, "★ 유예가 끝나면 한 번은 말한다 — 그리고 딱 한 번만");
}

/// ⑦ **늦게 도착한 후보 + 대기 중 사용자 메시지** — 둘을 한 판에서 잡는다.
///
///  · 셸의 훅은 스냅샷만 읽고 즉시 답한다. 아직 조회 전이면 `None`이고, 워커의 갱신이
///    몇 초 뒤 도착하면 **`check_hold`가 매 tick 되묻고 있어서** 그때 성사된다
///    (`arm_hold` 한 번으로 끝나면 이 경로가 통째로 죽는다).
///  · 그리고 그 전환은 나팔을 **더 넣지 않는다** — 대기 중에 사용자가 걸어 둔 말이
///    이미 이 채팅의 재개다(재개 단일 소유 ★R4).
#[test]
fn a_late_candidate_switches_on_a_later_tick_and_the_typed_message_is_the_resume() {
    /// 워커의 갱신이 도착하기 **전/후**를 테스트가 손으로 가른다(호출 횟수 세기는
    /// tick 수에 묶여 깨지기 쉽다 — 게이트 하나로 결정적으로 만든다).
    #[derive(Default)]
    struct Late {
        ready: std::sync::atomic::AtomicBool,
        calls: std::sync::atomic::AtomicU32,
    }
    impl AccountSwitcher for Late {
        fn pick(&self, req: &SwitchRequest) -> Option<SwitchPick> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if !self.ready.load(std::sync::atomic::Ordering::SeqCst) || req.tried.contains("b@x") {
                return None; // "조회 아직" — 셸이 워커를 깨우고 None을 낸 그 자리
            }
            Some(SwitchPick { account: "b@x".into(), soonest_reset: Some(1_755_150_000) })
        }
    }
    let hook = Arc::new(Late::default());
    let clock = VirtualClock::new();
    clock.advance_to(1_000 * SEC);
    clock.set_epoch_base((1_755_150_000 - 5 * 3600) * 1_000 - 1_000 * SEC);
    let spawned: Arc<Mutex<Vec<String>>> = Default::default();
    let cli = AcctCli {
        spawned_as: spawned.clone(),
        limited: Arc::new(Mutex::new(BTreeSet::from(["a_x".to_string()]))),
        ..Default::default()
    };
    let defaults = IdentityDefaults {
        known_accounts: BTreeSet::from(["a@x".to_string(), "b@x".to_string()]),
        ..Default::default()
    };
    let mut rt = ChatRuntime::new("c-1", raw("a@x"), defaults, clock.clone(), cli)
        .expect("정규화")
        .with_account_switcher(hook.clone());
    rt.dispatch(Cmd::Send { text: "첫 턴".into() });
    for _ in 0..3 {
        clock.advance_by(SEC);
        rt.tick();
    }
    assert!(rt.hold().is_some(), "★ 후보 조회가 아직이면 표가 서 있어야 한다");
    assert_eq!(rt.identity().account(), Some("a@x"), "증거 없이는 안 옮긴다");
    assert!(hook.calls.load(std::sync::atomic::Ordering::SeqCst) >= 2, "매 tick 되묻고 있어야 한다");

    // 사용자가 대기 중에 다음 할 말을 **걸어 둔다**(게이트에 주차되는 그 경로 —
    // `Cmd::Send`는 사용자가 지금 보내겠다는 뜻이라 표를 무시하고 나간다).
    rt.dispatch(Cmd::Enqueue(ccg_engine::queue::QueueInput::text("대기 중에 걸어 둔 말")));
    // 그리고 워커의 usage 갱신이 도착한다.
    hook.ready.store(true, std::sync::atomic::Ordering::SeqCst);
    for _ in 0..20 {
        clock.advance_by(SEC);
        rt.tick();
    }
    let sent = rt.sent_user_texts();
    if std::env::var("M11_TRACE").is_ok() {
        for e in rt.events() {
            println!("  ev {e:?}");
        }
    }
    println!("[m11-⑦] account={:?} spawns={:?} sent={sent:?}", rt.identity().account(), spawned.lock().unwrap());
    assert_eq!(rt.identity().account(), Some("b@x"), "★ 늦게 온 후보로 나중 tick에 갈아탄다");
    assert_eq!(spawned.lock().unwrap().clone(), vec!["a_x", "b_x"]);
    assert!(sent.iter().any(|t| t == "대기 중에 걸어 둔 말"), "걸어 둔 말이 나갔어야 한다");
    assert!(
        !sent.iter().any(|t| t.contains("이어서 진행해 주세요")),
        "★ 나팔까지 넣으면 한 번의 전환에 두 턴이 나간다: {sent:?}"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// ★R2 — R1 크리틱이 뚫은 자리들의 재생. 세 판 전부 R1 코드에서 **red**다.
// ─────────────────────────────────────────────────────────────────────────────

/// ⑩ **재개 나팔은 떠난 계정으로 나가지 않는다** — R1 크리틱 "뮤테이션 ①a"(회귀 그물의 구멍).
///
/// 규약: `try_auto_switch`는 **발사하지 않는다**(나팔을 큐 head에 두고 나가면 tick의 끝이
/// 안전한 발사대다). 그 규약을 깨고 함수 끝에서 드레인하면, 이 함수가 `arm_hold` →
/// `on_result` 한복판에서 불릴 때 **옛 계정의 CLI가 아직 살아 있다**.
///
/// 크리틱이 그 뮤테이션을 심었을 때 재생 10판이 전부 초록이었다. 축이 없었기 때문이다 —
/// 스폰 목록(`spawned_as`)은 "누가 떴나"만 알지 "누구에게 말했나"는 모른다. 그래서 이
/// 판은 **계정별로 나간 프롬프트**를 센다: 한도로 죽은 a@x에게 두 번째 말을 걸면 red다.
#[test]
fn the_resume_nudge_never_goes_to_the_account_we_just_left() {
    let mut f = fx(&["a@x", "b@x"], &["a@x"], scripted(&[("a@x", "b@x", Some(1_755_150_000))]));
    f.rt.dispatch(Cmd::Send { text: "첫 턴".into() });
    pump(&mut f, 30);

    let sent = f.sent_by.lock().unwrap().clone();
    println!("[m11-⑩] 계정별 발화={sent:?}");
    assert_eq!(account_of(&f.rt), "b@x");
    let to_a: Vec<&String> = sent.iter().filter(|(acct, _)| acct == "a_x").map(|(_, t)| t).collect();
    assert_eq!(to_a, vec!["첫 턴"], "★ 한도로 죽은 계정에는 첫 질문 말고 아무것도 안 나간다");
    let to_b: Vec<&String> = sent.iter().filter(|(acct, _)| acct == "b_x").map(|(_, t)| t).collect();
    assert_eq!(to_b, vec!["이어서 진행해 주세요"], "★ 재개는 새 계정에서 정확히 한 번");
    assert_eq!(f.spawned.lock().unwrap().clone(), vec!["a_x", "b_x"]);

    // ★ 그리고 **순서**가 규약이다: 전환 배너 → 옛 스트림 종료 → 새 스폰.
    //
    // 크리틱이 심은 뮤테이션(전환 함수 **끝**에서 드레인)이 지금은 무해한 이유는
    // `drain_if_possible`이 `Idle|Resident`가 아니면 즉시 돌아가기 때문이다(턴이 아직
    // 살아 있는 `on_result` 한복판에서는 그 문이 닫혀 있다). 그 문이 언젠가 느슨해지면
    // 나팔이 **옛 계정 프로세스로** 나가는데, 그때 제일 먼저 깨지는 것이 이 순서다.
    let ev: Vec<String> = f.rt.events().iter().map(|e| format!("{e:?}")).collect();
    let at = |pat: &str| ev.iter().position(|s| s.starts_with(pat));
    let sw_i = at("AccountSwitched").expect("전환 배너");
    let exit_i = at("Exit").expect("옛 스트림 종료");
    let spawn2 = ev
        .iter()
        .enumerate()
        .filter(|(_, s)| s.starts_with("Spawn"))
        .map(|(i, _)| i)
        .nth(1)
        .expect("두 번째 스폰");
    println!("[m11-⑩] 순서 switched={sw_i} exit={exit_i} spawn2={spawn2}");
    assert!(sw_i < exit_i && exit_i < spawn2, "★ 전환이 그 자리에서 발사했다(옛 스트림이 살아 있는 채 새 스폰): {ev:?}");
}

/// ⑪ **스탬피드** — 같은 소진 계정에 묶여 대기하던 두 채팅이 **다른 계정으로** 갈린다
/// (R1 크리틱 C2 · 공격 A3).
///
/// 허브 규약상 `busy`("지금 CLI가 살아 있는 채팅의 계정")는 **스폰이 끝나야** 참이 되고,
/// 훅은 펌프 한 바퀴에 한 번 갱신된 값을 본다. 워커 스냅샷이 도착하는 순간 대기하던
/// 채팅들이 동시에 열리면 전부 같은 1등을 받는다 — 그리고 둘이 한 5시간 창을 나눠 쓰다
/// **둘 다** 막힌다(규칙 ①이 막으려던 그 상태다).
///
/// 여기서 훅은 **예약을 모르는** 스텁이다(구형·미배선 훅과 같은 모양). 그래도 갈려야
/// 한다 — 마지막 문은 엔진의 `limit::SwitchLedger`가 닫는다.
#[test]
fn two_chats_opening_at_once_do_not_pile_onto_the_same_candidate() {
    #[derive(Default)]
    struct PumpLagged {
        ready: std::sync::atomic::AtomicBool,
        /// 허브가 펌프 **앞에서 한 번** 채워 주는 값(= 최대 한 바퀴 낡았다).
        busy: Mutex<BTreeSet<String>>,
        free: Vec<String>,
        asked: Mutex<Vec<(String, String)>>,
    }
    impl AccountSwitcher for PumpLagged {
        fn pending(&self) -> bool {
            !self.ready.load(std::sync::atomic::Ordering::SeqCst)
        }
        fn pick(&self, req: &SwitchRequest) -> Option<SwitchPick> {
            if self.pending() {
                return None;
            }
            let BillingAxis::Subscription { account: cur, .. } = req.current else { return None };
            let busy = self.busy.lock().unwrap().clone();
            let to = self
                .free
                .iter()
                .find(|e| *e != cur && !req.tried.contains(*e) && !busy.contains(*e))?
                .clone();
            self.asked.lock().unwrap().push((req.chat_id.to_string(), to.clone()));
            Some(SwitchPick { account: to, soonest_reset: None })
        }
    }
    let hook = Arc::new(PumpLagged {
        ready: Default::default(),
        busy: Mutex::new(BTreeSet::new()),
        free: vec!["b@x".into(), "c@x".into()],
        asked: Mutex::new(vec![]),
    });
    let clock = VirtualClock::new();
    clock.advance_to(1_000 * SEC);
    clock.set_epoch_base((1_755_150_000 - 5 * 3600) * 1_000 - 1_000 * SEC);
    let limited = Arc::new(Mutex::new(BTreeSet::from(["a_x".to_string()])));
    let mk = |id: &str| {
        let cli = AcctCli {
            spawned_as: Default::default(),
            limited: limited.clone(),
            ..Default::default()
        };
        let defaults = IdentityDefaults {
            known_accounts: ["a@x", "b@x", "c@x"].iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        };
        ChatRuntime::new(id, raw("a@x"), defaults, clock.clone(), cli)
            .expect("정규화")
            .with_account_switcher(hook.clone())
    };
    let mut one = mk("chat-1");
    let mut two = mk("chat-2");
    one.dispatch(Cmd::Send { text: "1번 질문".into() });
    two.dispatch(Cmd::Send { text: "2번 질문".into() });
    // 허브 펌프 = busy 갱신 1회 + 슬롯 순서대로 tick.
    let pump2 = |one: &mut ChatRuntime<AcctCli>, two: &mut ChatRuntime<AcctCli>| {
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
        pump2(&mut one, &mut two);
    }
    assert!(one.hold().is_some() && two.hold().is_some(), "둘 다 표가 서 있어야 한다");
    // 워커 스냅샷 도착 — 대기하던 채팅이 **동시에** 열린다.
    hook.ready.store(true, std::sync::atomic::Ordering::SeqCst);
    for _ in 0..40 {
        pump2(&mut one, &mut two);
    }
    let (a1, a2) = (account_of(&one), account_of(&two));
    println!("[m11-⑪] chat-1={a1} chat-2={a2} 훅질문={:?}", hook.asked.lock().unwrap());
    assert_ne!(a1, a2, "★ 두 채팅이 같은 계정으로 갈아탔다 — 규칙 ①(노는 계정만)이 뚫렸다");
    assert_eq!((a1.as_str(), a2.as_str()), ("b@x", "c@x"), "임박순 1등은 먼저 연 채팅의 것");
    assert!(one.hold().is_none() && two.hold().is_none(), "둘 다 이어졌다");
}

/// ⑫ **유령 대기 문장** — 표가 죽으면 미뤄 둔 대기 선언도 같이 죽는다(R1 크리틱 C3 · A1·A2).
///
/// 표를 죽이는 세 경로를 전부 재생한다. 어느 쪽이든, 사용자가 방금 「취소했어요」를 읽은
/// **바로 뒤에** 「사용 한도에 걸려 대기합니다」가 붙으면 그 두 줄 중 하나는 거짓이다.
#[test]
fn a_dead_hold_never_announces_that_it_is_waiting() {
    #[derive(Default)]
    struct Slow {
        ready: std::sync::atomic::AtomicBool,
        to: Option<String>,
    }
    impl AccountSwitcher for Slow {
        fn pending(&self) -> bool {
            !self.ready.load(std::sync::atomic::Ordering::SeqCst)
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
    let waits = |rt: &ChatRuntime<AcctCli>| {
        rt.events()
            .iter()
            .filter(|e| matches!(e, Event::Notice(t) if t.contains("사용 한도에 걸려 대기합니다")))
            .count()
    };
    #[allow(clippy::type_complexity)]
    let ways: Vec<(&str, Box<dyn Fn(&mut ChatRuntime<AcctCli>)>)> = vec![
        (
            "§7.3 계정 변경",
            Box::new(|rt: &mut ChatRuntime<AcctCli>| {
                let mut patch = RawIdentityPatch::default();
                patch.billing.account = Some("b@x".into());
                rt.dispatch(Cmd::IdentitySet { patch, policy: ApplyPolicy::Now, op: PendingOp::Merge });
            }),
        ),
        (
            "자동 이어서 끄기",
            Box::new(|rt: &mut ChatRuntime<AcctCli>| {
                rt.dispatch(Cmd::HoldCancel);
            }),
        ),
        (
            "중단(Esc) — 큐와 표를 함께 걷는다",
            Box::new(|rt: &mut ChatRuntime<AcctCli>| {
                // 세 번째 문 — `clear_queue_with_undo`. §7.3이 interrupt/stop_all에
                // 대기표를 함께 끄게 한 그 자리다("중지했는데 몇 시간 뒤 혼자 이어서 보낸다").
                rt.dispatch(Cmd::QueueMutate(ccg_engine::queue::QueueOp::Clear));
            }),
        ),
    ];
    for (name, kill) in ways {
        let hook = Arc::new(Slow { ready: Default::default(), to: Some("b@x".into()) });
        let clock = VirtualClock::new();
        clock.advance_to(1_000 * SEC);
        clock.set_epoch_base((1_755_150_000 - 5 * 3600) * 1_000 - 1_000 * SEC);
        let cli = AcctCli {
            spawned_as: Default::default(),
            limited: Arc::new(Mutex::new(BTreeSet::from(["a_x".to_string()]))),
            ..Default::default()
        };
        let defaults = IdentityDefaults {
            known_accounts: BTreeSet::from(["a@x".to_string(), "b@x".to_string()]),
            ..Default::default()
        };
        let mut rt = ChatRuntime::new("c-1", raw("a@x"), defaults, clock.clone(), cli)
            .expect("정규화")
            .with_account_switcher(hook.clone());
        rt.dispatch(Cmd::Send { text: "첫 턴".into() });
        for _ in 0..3 {
            clock.advance_by(SEC);
            rt.tick();
        }
        assert!(rt.hold().is_some(), "[{name}] 표는 서 있다(조회 중일 뿐)");
        assert_eq!(waits(&rt), 0, "[{name}] 조회 중에는 대기 선언을 미룬다");

        kill(&mut rt);
        let died = rt.hold().is_none();
        // 워커의 답이 도착한다 — 이제 "말할 사실"이 정해졌는데, 그 사실은 *표가 없다*이다.
        hook.ready.store(true, std::sync::atomic::Ordering::SeqCst);
        for _ in 0..10 {
            clock.advance_by(SEC);
            rt.tick();
        }
        let n = waits(&rt);
        println!("[m11-⑫ {name}] 표죽음={died} 대기문장={n}");
        assert!(died, "[{name}] 이 경로는 표를 죽여야 한다(전제)");
        assert_eq!(n, 0, "★ [{name}] 표가 없는데 「사용 한도에 걸려 대기합니다」가 나왔다");
    }
}
