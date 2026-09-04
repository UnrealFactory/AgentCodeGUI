//! ★R28e WFIRE 확인 크리틱 R1 — **크리틱의 독립 계기.** 빌더의 `wcap_limit_streak.rs`를
//! 안 쓴다(같은 손잡이·같은 가정을 물려받으면 재는 것이 아니라 되뇌는 것이다).
//!
//! 부모 커밋(R28d)에서도 **그대로 컴파일**되게 썼다 — `MAX_EPISODE_FIRES`·`MIN_WORK`·
//! `episode_fires()` 어느 것도 참조하지 않는다. 그래야 같은 계기로 대조군을 잰다.

use ccg_engine::clock::{Clock, Millis, VirtualClock, HOUR, MIN, SEC};
use ccg_engine::driver::{CliDriver, SpawnSpec};
use ccg_engine::identity::*;
use ccg_engine::runtime::{ChatRuntime, Cmd};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::sync::Arc;

const RESET: u64 = 1_755_150_000;

#[derive(Default, Clone)]
struct Knobs {
    /// 꼬리 없는 배너형 한도 문구(= 리셋 시각 미상 축).
    banner: bool,
    /// 턴마다 꼬리를 이만큼(초) 민다. 0 = 같은 벽.
    roll: u64,
    /// 죽기 전에 어시스턴트 텍스트 한 줄.
    text: bool,
    /// 죽기 전에 도구 하나(결과 없음).
    tool: bool,
    /// 한도 문구 자체를 어시스턴트 텍스트로.
    limit_as_text: bool,
    /// 턴 수명(ms). 0 = 받은 자리에서 즉사.
    work_ms: u64,
}

struct P {
    k: Knobs,
    alive: bool,
    turns: u64,
    pending: Vec<Value>,
    held: Option<Value>,
    due: Option<Millis>,
}

impl P {
    fn new(k: Knobs) -> Self {
        Self { k, alive: false, turns: 0, pending: vec![], held: None, due: None }
    }
}

impl CliDriver for P {
    fn spawn(&mut self, _s: &SpawnSpec) -> std::io::Result<()> {
        self.alive = true;
        self.pending
            .push(json!({"type":"system","subtype":"init","session_id":"S1","model":"haiku"}));
        Ok(())
    }
    fn send(&mut self, line: Value) {
        if line["type"] == "control_request" && line["request"]["subtype"] == "initialize" {
            let rid = line["request_id"].as_str().unwrap_or("").to_string();
            self.pending.push(json!({"type":"control_response",
                "response":{"subtype":"success","request_id":rid,"response":{}}}));
            return;
        }
        if line["type"] != "user" {
            return;
        }
        let wall = if self.k.banner {
            "5-hour limit reached".to_string()
        } else {
            format!("Claude AI usage limit reached|{}", RESET + self.k.roll * self.turns)
        };
        if self.k.text {
            self.pending.push(json!({"type":"assistant","parent_tool_use_id":null,
                "message":{"role":"assistant","model":"haiku",
                    "content":[{"type":"text","text":"고쳤어. 다음 파일로 넘어갈게"}]},
                "session_id":"S1","uuid":"U-a"}));
        }
        if self.k.limit_as_text {
            self.pending.push(json!({"type":"assistant","parent_tool_use_id":null,
                "message":{"role":"assistant","model":"haiku",
                    "content":[{"type":"text","text":wall.clone()}]},
                "session_id":"S1","uuid":"U-l"}));
        }
        if self.k.tool {
            self.pending.push(json!({"type":"assistant","parent_tool_use_id":null,
                "message":{"role":"assistant","model":"haiku",
                    "content":[{"type":"tool_use","id":"toolu-9","name":"Read","input":{}}]},
                "session_id":"S1","uuid":"U-t"}));
        }
        self.turns += 1;
        let err = json!({"type":"result","subtype":"error_during_execution","is_error":true,
            "result": wall});
        if self.k.work_ms == 0 {
            self.pending.push(err);
        } else {
            self.held = Some(err);
            self.due = None;
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
    fn poll_frames(&mut self, now: Millis) -> Vec<Value> {
        if self.held.is_some() {
            let d = *self.due.get_or_insert(now + self.k.work_ms);
            if now >= d {
                if let Some(e) = self.held.take() {
                    self.pending.push(e);
                }
                self.due = None;
            }
        }
        std::mem::take(&mut self.pending)
    }
}

fn rt(clock: Arc<VirtualClock>, cli: P) -> ChatRuntime<P> {
    let raw = RawIdentity {
        engine: RawEngine {
            kind: EngineKind::Claude,
            model: "haiku".into(),
            effort: EffortId::Minimal,
            codex_account: None,
        },
        billing: RawBilling {
            kind: BillingKind::Subscription,
            account: Some("a@x".into()),
            drop_env_key: Some(false),
        },
        cwd: r"C:\ccg-fixture\work".into(),
        add_dirs: vec![],
        mode: ModeId::Normal,
        system_prompt: None,
        output_style: None,
        tools: RawTools::default(),
    };
    let defaults = IdentityDefaults {
        known_accounts: BTreeSet::from(["a@x".to_string()]),
        ..Default::default()
    };
    ChatRuntime::new("c-1", raw, defaults, clock, cli).expect("정규화")
}

struct Out {
    fires: usize,
    attempts: u32,
    ready: bool,
    paused: bool,
    notice: Option<String>,
}

/// 첫 턴을 태워 표를 세우고, 그 뒤 `hours` 시간 동안 stdin으로 나간 **사용자 프롬프트 줄**을 센다.
fn drive(k: Knobs, hours: u64) -> (Out, ChatRuntime<P>, Arc<VirtualClock>) {
    let clock = VirtualClock::new();
    clock.advance_to(1_000 * SEC);
    clock.set_epoch_base((RESET - 5 * 3600) * 1_000 - 1_000 * SEC);
    let mut r = rt(clock.clone(), P::new(k));
    r.dispatch(Cmd::Send { text: "첫 턴".into() });
    let by = clock.now_ms() + 12 * HOUR;
    while clock.now_ms() < by && r.hold().is_none() {
        clock.advance_by(SEC);
        r.tick();
    }
    assert!(r.hold().is_some(), "첫 턴이 한도로 죽어 표가 서야 한다");
    let base = r.driver_ref().turns;
    let mut notice = None;
    let until = 1_000 * SEC + hours * HOUR;
    while clock.now_ms() < until {
        clock.advance_by(SEC);
        r.tick();
        for e in r.drain_events() {
            if let ccg_engine::event::Event::Notice(s) = e {
                if s.contains("자동 재개를 멈췄") {
                    notice.get_or_insert(s);
                }
            }
        }
    }
    let out = Out {
        fires: (r.driver_ref().turns - base) as usize,
        attempts: r.hold().map_or(0, |h| h.attempts),
        ready: r.hold().is_some_and(|h| h.ready),
        paused: r.hold().is_some_and(|h| h.auto_paused),
        notice,
    };
    (out, r, clock)
}

/// 체크리스트 ①: 시각 미상 축 12시간 대본 셋 — 자동 발사 총량이 예산 이하인가.
#[test]
fn crit1_twelve_hours_unknown_wall_three_scripts() {
    let cases: Vec<(&str, Knobs)> = vec![
        (
            "Q2 텍스트 한 줄",
            Knobs { banner: true, text: true, ..Default::default() },
        ),
        (
            "Q3 도구만 열고 즉사",
            Knobs { banner: true, tool: true, ..Default::default() },
        ),
        (
            "Q1 한도 문구를 텍스트로",
            Knobs { banner: true, limit_as_text: true, ..Default::default() },
        ),
    ];
    for (label, k) in cases {
        let (o, _r, _c) = drive(k, 12);
        println!(
            "[CRIT1 {label}] 12시간 발사 {} · attempts {} · ready {} · paused {} · 공지 {:?}",
            o.fires, o.attempts, o.ready, o.paused, o.notice
        );
        assert!(o.fires <= 12, "★ 예산 초과 — {}발", o.fires);
        assert!(o.paused, "★ 안 접혔다");
    }
}

/// 체크리스트 ②: 진짜 일한 밤샘 연속(창 전진 + 실작업)은 안 잘리는가.
#[test]
fn crit2_real_overnight_is_not_cut() {
    // 창이 매 턴 1시간 뒤로 + 그 턴이 45분을 산다 = 진짜 일한 연속.
    let k = Knobs { roll: HOUR / 1_000, text: true, work_ms: 45 * MIN, ..Default::default() };
    let (o, _r, _c) = drive(k, 12);
    println!(
        "[CRIT2 창전진+실작업] 12시간 발사 {} · attempts {} · paused {}",
        o.fires, o.attempts, o.paused
    );
    assert!(o.fires > 2, "★ 밤샘 주행이 상한에 걸렸다 — {}발", o.fires);
    assert!(!o.paused, "★ 자동이 접혔다 = 밤샘 주행이 잘렸다");
    assert_eq!(o.attempts, 0, "★ 계수가 올랐다");
}

/// 체크리스트 ②-b: **얼마나 오래 버티나** — 예산 12발이 실제로 몇 시간인가.
#[test]
fn crit2b_how_long_does_the_budget_last_on_a_real_run() {
    // 5시간 창 · 4시간 30분 작업 = 실전 밤샘의 눈금.
    let k = Knobs { roll: 5 * 3600, text: true, work_ms: 4 * HOUR + 30 * MIN, ..Default::default() };
    let (o, _r, _c) = drive(k, 120);
    println!(
        "[CRIT2b 실전 눈금] 120시간 발사 {} · attempts {} · paused {} · 공지 {:?}",
        o.fires, o.attempts, o.paused, o.notice
    );
}

/// 체크리스트 ③: 헛발질(출력 0)은 2발에서 접히고 `ready`(버튼)가 뜨는가.
#[test]
fn crit3_blank_resume_still_folds_at_two() {
    let (o, _r, _c) = drive(Knobs { banner: true, ..Default::default() }, 12);
    println!(
        "[CRIT3 빈손] 12시간 발사 {} · attempts {} · ready {} · paused {} · 공지 {:?}",
        o.fires, o.attempts, o.ready, o.paused, o.notice
    );
    assert_eq!(o.fires, 2, "★ 2발이 아니다");
    assert!(o.ready && o.paused, "★ 이어가기 버튼이 안 뜬다");
}

/// 예산 소진 뒤 사용자가 누르면 다시 도는가(막다른 방 아님).
#[test]
fn crit_budget_exhaustion_has_an_exit() {
    let k = Knobs { banner: true, text: true, work_ms: 20 * MIN, ..Default::default() };
    let (o, mut r, clock) = drive(k, 20);
    println!("[CRIT출구] 20시간 발사 {} · attempts {} · paused {}", o.fires, o.attempts, o.paused);
    assert!(o.paused, "먼저 접혀 있어야 한다");
    let before = r.driver_ref().turns;
    assert_eq!(r.resume_now(), ccg_engine::event::Verdict::Accepted);
    let until = clock.now_ms() + 2 * HOUR;
    while clock.now_ms() < until {
        clock.advance_by(SEC);
        r.tick();
    }
    let after = r.driver_ref().turns - before;
    println!("[CRIT출구] 누른 뒤 2시간 {after}발");
    assert!(after >= 2, "★ 버튼이 한 번 쓰고 버리는 것이 됐다");
}

/// 재시작(재장전)이 예산을 지우는가 — 빌더가 「미완」으로 신고한 자리의 실측.
#[test]
fn crit_restart_wipes_the_budget() {
    let k = Knobs { banner: true, text: true, work_ms: 20 * MIN, ..Default::default() };
    let (o, mut r, clock) = drive(k, 20);
    assert!(o.paused, "먼저 예산을 다 써서 접혀 있어야 한다");
    println!("[CRIT재시작] 재장전 전: 발사 {} · paused {}", o.fires, o.paused);
    // 셸의 부팅 재장전이 하는 그대로: 디스크의 resets_at → 남은 시간, ready 그대로.
    r.reload_state(vec![], Some(ccg_engine::runtime::ReloadHold { in_ms: Some(60 * SEC), ready: false, ..Default::default() }));
    let before = r.driver_ref().turns;
    let until = clock.now_ms() + 20 * HOUR;
    while clock.now_ms() < until {
        clock.advance_by(SEC);
        r.tick();
    }
    let after = r.driver_ref().turns - before;
    let h = r.hold().expect("표");
    println!(
        "[CRIT재시작] 재장전 뒤 20시간 발사 {after} · attempts {} · paused {}",
        h.attempts, h.auto_paused
    );
}

/// 체크리스트 ①의 **전면 훑기** — 어떤 조합에서도 24시간 자동 발사가 예산(12) 이하인가.
/// 「둘 중 하나도 안 무는」 사각이 있으면 여기서 튄다.
#[test]
fn crit_sweep_no_combination_exceeds_the_budget() {
    let lifetimes: [(&str, u64); 8] = [
        ("즉사", 0),
        ("1분", MIN),
        ("4분", 4 * MIN),
        ("4분55초", 4 * MIN + 55 * SEC),
        ("5분(문턱)", 5 * MIN),
        ("10분", 10 * MIN),
        ("1시간", HOUR),
        ("4시간30분", 4 * HOUR + 30 * MIN),
    ];
    // roll=60초 = 「벽이 늘 1분 뒤」인 최악의 판(due_at = resets_at+90s라 주기가 짧다).
    let rolls: [(&str, u64); 4] = [("같은 벽", 0), ("1분씩", 60), ("1시간씩", 3600), ("5시간씩", 5 * 3600)];
    let mut worst = 0usize;
    let mut worst_label = String::new();
    for banner in [true, false] {
        for (rl, roll) in rolls {
            if banner && roll != 0 {
                continue; // 배너형에는 읽을 꼬리가 없다 — roll이 무의미
            }
            for (ll, work_ms) in lifetimes {
                for text in [true, false] {
                    let k = Knobs { banner, roll, text, work_ms, ..Default::default() };
                    let (o, _r, _c) = drive(k, 24);
                    if o.fires > worst {
                        worst = o.fires;
                        worst_label = format!("banner={banner} roll={rl} 수명={ll} 산출={text}");
                    }
                    assert!(
                        o.fires <= 12,
                        "★★ 예산을 넘겼다 — banner={banner} roll={rl} 수명={ll} 산출={text} → {}발",
                        o.fires
                    );
                }
            }
        }
    }
    println!("[CRIT훑기] 24시간 최악 {worst}발 ({worst_label}) · 전 조합 예산 이하");
}

/// **빌더가 「미완 1」로 신고한 자리의 값을 매긴다** — 프로세스가 새로 뜨면(앱 재시작)
/// `episode_fires`는 0이고 `ReloadHold`에는 그 칸이 없다. 얼마나 더 나가나?
#[test]
fn crit_a_fresh_process_recharges_the_whole_budget() {
    // 「산출을 흘리며 천천히 죽는」 축 = 예산만이 천장인 대본.
    let k = Knobs { banner: true, text: true, work_ms: 20 * MIN, ..Default::default() };
    let (o1, _r, _c) = drive(k.clone(), 20);
    assert_eq!(o1.fires, 12, "먼저 예산을 다 쓴다");
    assert!(o1.paused);

    // 앱 재시작 = **새 프로세스**. 셸의 `reload_pending`이 디스크의 hold를 다시 건다.
    let clock = VirtualClock::new();
    clock.advance_to(1_000 * SEC);
    clock.set_epoch_base((RESET - 5 * 3600) * 1_000 - 1_000 * SEC);
    let mut r2 = rt(clock.clone(), P::new(k));
    r2.set_auto_resume(true);
    r2.reload_state(vec![], Some(ccg_engine::runtime::ReloadHold { in_ms: Some(60 * SEC), ready: false, ..Default::default() }));
    let base = r2.driver_ref().turns;
    let until = 1_000 * SEC + 20 * HOUR;
    while clock.now_ms() < until {
        clock.advance_by(SEC);
        r2.tick();
    }
    let again = (r2.driver_ref().turns - base) as usize;
    println!(
        "[CRIT재충전] 재시작 뒤 20시간 발사 {again} · paused {} — 재시작 한 번당 예산이 통째로 되살아난다",
        r2.hold().is_some_and(|h| h.auto_paused)
    );
}
