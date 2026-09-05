//! ★R28e WFIRE 확인 크리틱 **R2** — 내 손으로 만든 계기.
//!
//! 빌더의 `wcap_limit_streak.rs`도, 직전 크리틱의 `probe_wfire_crit.rs`도 안 쓴다.
//! 같은 손잡이를 물려받으면 재는 것이 아니라 되뇌는 것이다.
//!
//! **이 파일은 `MAX_EPISODE_FIRES`·`MIN_WORK`·`episode_fires()` 어느 것도 참조하지 않는다** —
//! 부모 커밋(61d818a^)에서도 그대로 컴파일돼야 같은 자로 대조군을 잴 수 있기 때문이다.
//!
//! 눈금은 `ChatRuntime::sent_user_texts()`(= `send_user` 단일 경로 = CLI 턴 1회)다.
//! 재스폰 수(`spawns`)는 도구가 미정착이라 상주로 남는 판에서 0을 낸다.
use ccg_engine::clock::{Clock, Millis, VirtualClock, HOUR, MIN, SEC};
use ccg_engine::driver::{CliDriver, SpawnSpec};
use ccg_engine::event::Event;
use ccg_engine::identity::*;
use ccg_engine::runtime::{ChatRuntime, Cmd};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::sync::Arc;

const RESET: u64 = 1_755_150_000;

/// 재개 턴이 죽기 전에 화면에 남기는 것.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Out {
    /// 아무것도 안 남긴다(진짜 헛발질).
    Nothing,
    /// 어시스턴트 텍스트 한 줄 — 크리틱 Q1.
    Text,
    /// 도구 하나를 열고 결과 없이 죽는다 — 크리틱 Q2.
    ToolOpen,
    /// **한도 문구 자체**를 어시스턴트 텍스트로 받는다 — 크리틱 Q3.
    LimitText,
}

struct Cli {
    alive: bool,
    turns: u64,
    pending: Vec<Value>,
    /// 턴마다 꼬리 epoch을 이만큼(초) 민다. 0 = 같은 벽.
    roll: u64,
    /// 꼬리(`|epoch`)를 다는가. false = 배너형(시각 미상 축).
    tail: bool,
    out: Out,
    /// 프롬프트가 나간 뒤 한도 result까지의 시간(ms). 0 = 즉사.
    life_ms: u64,
    held: Option<Value>,
    due: Option<Millis>,
}

impl Default for Cli {
    fn default() -> Self {
        Cli {
            alive: false,
            turns: 0,
            pending: vec![],
            roll: 0,
            tail: false,
            out: Out::Nothing,
            life_ms: 0,
            held: None,
            due: None,
        }
    }
}

fn assistant_text(s: &str) -> Value {
    json!({"type":"assistant","parent_tool_use_id":null,
        "message":{"role":"assistant","model":"haiku","content":[{"type":"text","text":s}]},
        "session_id":"S1","uuid":"U-txt"})
}

impl CliDriver for Cli {
    fn spawn(&mut self, _spec: &SpawnSpec) -> std::io::Result<()> {
        self.alive = true;
        self.pending
            .push(json!({"type":"system","subtype":"init","session_id":"S1","model":"haiku"}));
        Ok(())
    }
    fn send(&mut self, line: Value) {
        // 상주 CLI의 initialize 왕복 — 답을 안 하면 T3(START_TIMEOUT)가 스트림을 접는다.
        if line["type"] == "control_request" && line["request"]["subtype"] == "initialize" {
            let rid = line["request_id"].as_str().unwrap_or("").to_string();
            self.pending.push(json!({
                "type":"control_response",
                "response":{"subtype":"success","request_id":rid,"response":{}}
            }));
            return;
        }
        if line["type"] != "user" {
            return;
        }
        let wall = format!("Claude AI usage limit reached|{}", RESET + self.roll * self.turns);
        match self.out {
            Out::Nothing => {}
            Out::Text => self.pending.push(assistant_text("바꿔 뒀어")),
            Out::LimitText => self.pending.push(assistant_text(&wall)),
            Out::ToolOpen => {
                let id = format!("toolu-{}", self.turns);
                self.pending.push(json!({"type":"assistant","parent_tool_use_id":null,
                    "message":{"role":"assistant","model":"haiku",
                               "content":[{"type":"tool_use","id":id,"name":"Read","input":{}}]},
                    "session_id":"S1","uuid":"U-tool"}));
            }
        }
        let text = if self.tail { wall } else { "5-hour limit reached".to_string() };
        self.turns += 1;
        let err = json!({"type":"result","subtype":"error_during_execution","is_error":true,"result":text});
        if self.life_ms == 0 {
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
            let due = *self.due.get_or_insert(now + self.life_ms);
            if now >= due {
                if let Some(e) = self.held.take() {
                    self.pending.push(e);
                }
                self.due = None;
            }
        }
        std::mem::take(&mut self.pending)
    }
}

fn rt(clock: Arc<VirtualClock>, cli: Cli) -> ChatRuntime<Cli> {
    let raw = RawIdentity {
        engine: RawEngine {
            kind: EngineKind::Claude,
            model: "haiku".into(),
            effort: EffortId::Minimal,
            codex_account: None,
            codex_tier: None,
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

fn clock_at(ahead: u64) -> Arc<VirtualClock> {
    let c = VirtualClock::new();
    c.advance_to(1_000 * SEC);
    c.set_epoch_base((RESET - ahead) * 1_000 - 1_000 * SEC);
    c
}

#[derive(Debug)]
struct Shot {
    /// 첫 턴을 뺀 **자동 재개 발사 수**(CLI 턴 = `send_user` 호출).
    fires: usize,
    attempts: u32,
    auto_paused: bool,
    ready: bool,
    /// 마지막 착지 공지(사용자가 읽는 문장).
    notice: Option<String>,
}

/// 첫 턴을 태워 표를 세우고, `dur` 동안의 자동 재발사를 센다.
fn run(cli: Cli, dur: Millis) -> (ChatRuntime<Cli>, Arc<VirtualClock>, Shot) {
    let clock = clock_at(5 * 3600);
    let mut r = rt(clock.clone(), cli);
    r.dispatch(Cmd::Send { text: "첫 턴".into() });
    let armed_by = clock.now_ms() + 3 * HOUR;
    while clock.now_ms() < armed_by && r.hold().is_none() {
        clock.advance_by(SEC);
        r.tick();
    }
    assert!(r.hold().is_some(), "첫 턴이 한도로 죽어 표가 서야 한다");
    let base = r.sent_user_texts().len();
    let until = clock.now_ms() + dur;
    while clock.now_ms() < until {
        clock.advance_by(SEC);
        r.tick();
    }
    let shot = snap(&r, base);
    (r, clock, shot)
}

fn snap(r: &ChatRuntime<Cli>, base: usize) -> Shot {
    let notice = r
        .events()
        .iter()
        .rev()
        .find_map(|e| match e {
            Event::Notice(s) => Some(s.clone()),
            _ => None,
        });
    Shot {
        fires: r.sent_user_texts().len() - base,
        attempts: r.hold().map(|h| h.attempts).unwrap_or(0),
        auto_paused: r.hold().map(|h| h.auto_paused).unwrap_or(false),
        ready: r.hold().map(|h| h.ready).unwrap_or(false),
        notice,
    }
}

// ── ① 크리틱 체크리스트 1 — 시각 미상 축 12시간 세 대본 ──────────────────────

#[test]
fn q1_unknown_wall_one_line_of_text_then_instant_death_12h() {
    let (_r, _c, s) = run(
        Cli { tail: false, out: Out::Text, life_ms: 0, ..Default::default() },
        12 * HOUR,
    );
    println!("[R2·Q1 텍스트 한 줄+즉사] 12시간 {s:?}");
    assert!(s.fires <= 12, "★ 예산을 넘었다 — {}발", s.fires);
}

#[test]
fn q2_unknown_wall_tool_opened_then_instant_death_12h() {
    let (_r, _c, s) = run(
        Cli { tail: false, out: Out::ToolOpen, life_ms: 0, ..Default::default() },
        12 * HOUR,
    );
    println!("[R2·Q2 도구만 열고 즉사] 12시간 {s:?}");
    assert!(s.fires <= 12, "★ 예산을 넘었다 — {}발", s.fires);
}

#[test]
fn q3_unknown_wall_limit_phrase_as_assistant_text_12h() {
    let (_r, _c, s) = run(
        Cli { tail: false, out: Out::LimitText, life_ms: 0, ..Default::default() },
        12 * HOUR,
    );
    println!("[R2·Q3 한도 문구를 텍스트로] 12시간 {s:?}");
    assert!(s.fires <= 12, "★ 예산을 넘었다 — {}발", s.fires);
}

// ── ② 체크리스트 2 — 진짜 일한 밤샘 연속(창 전진 + 실작업) ───────────────────

#[test]
fn a_real_overnight_run_with_rolling_windows_is_not_cut() {
    let (_r, _c, s) = run(
        Cli {
            tail: true,
            roll: HOUR / 1_000, // 턴마다 벽이 한 시간 뒤로 = 창이 진짜로 넘어간다
            out: Out::Text,
            life_ms: 45 * MIN, // 창을 태우는 실작업
            ..Default::default()
        },
        12 * HOUR,
    );
    println!("[R2·밤샘 창전진+실작업] 12시간 {s:?}");
    assert!(!s.auto_paused, "★ 밤샘 주행이 잘렸다 — {s:?}");
    assert_eq!(s.attempts, 0, "★ 일한 재개가 헛발질로 세졌다");
    assert!(s.fires >= 6, "창이 열두 번 넘어가는 12시간인데 {}발뿐", s.fires);
}

/// 시각 미상 축이지만 **진짜로 오래 일한다**(창을 태우는 턴). 접히면 안 되는 쪽.
#[test]
fn a_long_working_resume_on_the_unknown_axis_is_not_cut_early() {
    let (_r, _c, s) = run(
        Cli { tail: false, out: Out::Text, life_ms: 50 * MIN, ..Default::default() },
        4 * HOUR,
    );
    println!("[R2·시각미상+50분 실작업] 4시간 {s:?}");
    assert!(!s.auto_paused, "★ 일한 재개가 4시간 만에 잘렸다 — {s:?}");
    assert_eq!(s.attempts, 0, "★ 일한 턴이 헛발질로 세졌다");
    assert!(s.fires > 2, "★ {}발에서 멎었다", s.fires);
}

// ── ③ 체크리스트 3 — 헛발질(출력 0)은 2발에서 접히고 버튼이 뜬다 ────────────

#[test]
fn an_empty_resume_still_folds_at_two_and_offers_the_button() {
    let (_r, _c, s) = run(
        Cli { tail: false, out: Out::Nothing, life_ms: 0, ..Default::default() },
        12 * HOUR,
    );
    println!("[R2·빈손] 12시간 {s:?}");
    assert_eq!(s.fires, 2, "★ 헛발질 상한이 2가 아니다");
    assert!(s.auto_paused && s.ready, "★ 버튼(ready+auto_paused)이 안 떴다");
}

// ── ④ 예산이 진짜 천장인가 — 산출을 흘리며 천천히 죽는 턴(24시간) ───────────

#[test]
fn a_slowly_dying_but_productive_loop_is_capped_by_the_budget() {
    let (_r, _c, s) = run(
        Cli { tail: false, out: Out::Text, life_ms: 10 * MIN, ..Default::default() },
        24 * HOUR,
    );
    println!("[R2·오래 일하며 계속 막힘] 24시간 {s:?}");
    assert!(s.fires <= 12, "★ 예산을 넘었다 — {}발", s.fires);
    assert!(s.auto_paused, "★ 예산을 다 쓰고도 안 접혔다 — {s:?}");
    assert_eq!(s.attempts, 0, "이 축은 attempts가 아니라 예산이 잡는 자리다");
}

/// 예산을 다 쓴 표를 사용자가 누르면 다시 쏘는가(막다른 방 금지).
#[test]
fn pressing_continue_after_the_budget_is_spent_fires_again() {
    let (mut r, clock, s) = run(
        Cli { tail: false, out: Out::Text, life_ms: 10 * MIN, ..Default::default() },
        24 * HOUR,
    );
    assert!(s.auto_paused, "선행 조건: 접혀 있어야 한다");
    let before = r.sent_user_texts().len();
    let v = r.resume_now();
    for _ in 0..600 {
        clock.advance_by(SEC);
        r.tick();
    }
    let after = r.sent_user_texts().len();
    println!("[R2·버튼] verdict={v:?} 발사 {before}→{after}");
    assert!(after > before, "★ 눌러도 안 나갔다 = 막다른 방");
}

// ── ⑤ 전조합 훑기 — 「둘 중 아무것도 안 무는 사각」이 있나 ────────────────────

#[test]
fn sweep_every_combination_stays_under_the_budget() {
    let lives = [0u64, 30 * SEC, 4 * MIN + 59 * SEC, 5 * MIN, 5 * MIN + SEC, 20 * MIN, 60 * MIN];
    let outs = [Out::Nothing, Out::Text, Out::ToolOpen, Out::LimitText];
    // (tail, roll) — 배너형 / 같은 벽 / 벽이 1분씩 민다 / 벽이 1시간씩 민다
    let walls: [(bool, u64); 4] = [(false, 0), (true, 0), (true, 60), (true, 3_600)];
    let mut worst = 0usize;
    let mut worst_desc = String::new();
    let mut rows = vec![];
    for &(tail, roll) in &walls {
        for &out in &outs {
            for &life in &lives {
                let (_r, _c, s) = run(
                    Cli { tail, roll, out, life_ms: life, ..Default::default() },
                    24 * HOUR,
                );
                if s.fires > worst {
                    worst = s.fires;
                    worst_desc = format!("tail={tail} roll={roll} out={out:?} life={life}ms → {s:?}");
                }
                rows.push(format!(
                    "tail={tail} roll={roll} out={out:?} life={life}ms → 발사 {} attempts {} paused {}",
                    s.fires, s.attempts, s.auto_paused
                ));
            }
        }
    }
    for r in &rows {
        println!("[R2·훑기] {r}");
    }
    println!("[R2·훑기] 24시간 최악 {worst}발 — {worst_desc}");
    assert!(worst <= 12, "★ 예산을 넘는 조합이 있다 — {worst_desc}");
}

// ── ⑥ 재시작이 예산을 지우나(엔진 축) ────────────────────────────────────────

#[test]
fn a_restart_in_the_middle_of_an_episode_hands_out_a_fresh_budget() {
    let (r, _c, s) = run(
        Cli { tail: false, out: Out::Text, life_ms: 10 * MIN, ..Default::default() },
        24 * HOUR,
    );
    assert!(s.auto_paused, "선행 조건: 예산 소진으로 접혀 있다");
    let h = r.hold().expect("표").clone();
    drop(r);
    // 같은 에피소드 한가운데서 앱을 껐다 켠다 — 셸의 재장전 경로 그대로.
    let clock = clock_at(5 * 3600);
    let mut r2 = rt(
        clock.clone(),
        Cli { tail: false, out: Out::Text, life_ms: 10 * MIN, ..Default::default() },
    );
    r2.reload_state(
        vec![],
        Some(ccg_engine::runtime::ReloadHold { in_ms: Some(60 * SEC), ready: h.ready, ..Default::default() }),
    );
    let base = r2.sent_user_texts().len();
    let until = clock.now_ms() + 24 * HOUR;
    while clock.now_ms() < until {
        clock.advance_by(SEC);
        r2.tick();
    }
    let s2 = snap(&r2, base);
    println!("[R2·재시작] 재장전 뒤 24시간 {s2:?}");
    // 판정이 아니라 **기록**이다 — 몇 발이 더 나가는지 수치로 남긴다.
    assert!(s2.fires <= 12, "재장전 뒤에도 예산은 산다(발사 {}발)", s2.fires);
}
