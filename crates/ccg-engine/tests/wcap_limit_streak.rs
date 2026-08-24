//! ★R28d WCAP — **상한이 「헛발질」과 「제대로 일한 재개」를 가른다.**
//!
//! RCAP 확인 크리틱 R1 §4.1의 최대 격차: `auto_resume_streak`은 한도로 죽은 착지마다
//! 올랐고, 그 턴이 30초 만에 같은 벽에 부딪혔는지 5시간을 꽉 채워 일하고 **다음 창에서**
//! 막혔는지를 아무도 안 봤다. 그래서 22시 한도 → 03시 재개(성공) → 08시 새 한도 → 13시
//! 재개(성공) → 18시 새 한도에서 자동이 접히고, 사용자는 아침에 「자동으로 이어서 보낸
//! turn이 계속 한도에 막혔어요」를 읽는다 — 그 턴들은 막힌 게 아니라 일했다.
//!
//! 이 파일이 잠그는 것은 **네 축**이고, 렌더러 짝은 `scripts/poc-limit-resume.mjs` J절이다
//! (같은 구분자·같은 우선순위를 훅 실구동으로 잰다):
//!
//! | # | 판 | 기대 |
//! |---|---|---|
//! | ① | 창이 진짜로 넘어간다(꼬리 epoch이 매번 뒤로) | 안 접힌다 · `attempts` 0 유지 |
//! | ② | 꼬리 없는 문구 + 그 턴이 일을 했다 | 안 접힌다(그 축은 ②가 든다) |
//! | ③ | 꼬리 없는 문구 + 빈손 = 진짜 헛발질 | **RCAP 그대로** 상한에서 접힌다 |
//! | ④ | 토큰 한 줄 + **같은 벽**(지난 epoch 되돌림) | 접힌다 — 시계가 일한 흔적을 이긴다 |
//!
//! ④가 이 라운드가 스스로 판 함정이다. 구분자를 OR로 두면 그 판에서 계수가 영영 0이 되고,
//! `due_at`이 `max(resets_at + 90s, armed_at + 15s)`라 **15초마다** 재발사가 돈다 =
//! RCAP이 막은 무한 주기의 부활. 그래서 시각을 둘 다 아는 판은 시계가 판정하고, 한쪽이라도
//! 미상인 판만 일한 흔적이 판정한다(`runtime.rs::arm_hold`의 `cleared`).
use ccg_engine::clock::{Clock, Millis, VirtualClock, HOUR, MIN, SEC};
use ccg_engine::driver::{CliDriver, SpawnSpec};
use ccg_engine::identity::*;
use ccg_engine::limit::MAX_AUTO_ATTEMPTS;
use ccg_engine::runtime::{ChatRuntime, Cmd};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::sync::Arc;

/// 문구 꼬리에 실려 오는 실전 리셋 시각(2.6.2 코퍼스 A절의 그 값 · `r14_limit_loop`와 동일).
const RESET: u64 = 1_755_150_000;

/// 프롬프트가 들어가면 한도 에러로 죽는 CLI. `r14_limit_loop`의 `LimitedCli`에 손잡이 둘을
/// 더한 것이다 — **꼬리를 미는가**(구분자 ①)와 **죽기 전에 일을 하는가**(구분자 ②).
#[derive(Default)]
struct WcapCli {
    alive: bool,
    spawns: usize,
    turns: u64,
    pending: Vec<Value>,
    /// 턴마다 꼬리 epoch을 이만큼 민다(초). 0 = **같은 벽**에 다시 부딪혔다.
    roll: u64,
    /// 꼬리가 아예 없는 배너형 문구(codex 한도 문구의 모양) — ①이 영영 침묵하는 축.
    banner: bool,
    /// result 에러 **앞에** 어시스턴트 출력을 흘린다 = 그 턴은 일을 했다.
    work: bool,
    /// 이번 스폰에서 이미 한도 에러를 냈다. 런타임은 한 턴에 stdin 줄을 여러 번 밀 수
    /// 있어서(초안에서 실제로 꼬리가 턴당 2시간씩 뛰었다) **스폰 하나에 한 번**으로 못 박는다.
    fired_this_spawn: bool,
}

impl CliDriver for WcapCli {
    fn spawn(&mut self, _spec: &SpawnSpec) -> std::io::Result<()> {
        self.spawns += 1;
        self.alive = true;
        self.fired_this_spawn = false;
        self.pending
            .push(json!({"type":"system","subtype":"init","session_id":"S1","model":"haiku"}));
        Ok(())
    }
    fn send(&mut self, _line: Value) {
        if self.fired_this_spawn {
            return;
        }
        self.fired_this_spawn = true;
        if self.work {
            // 메인 경로 어시스턴트 텍스트 = `mark_activity()` → `saw_turn_activity`.
            self.pending.push(json!({"type":"assistant","parent_tool_use_id":null,
                "message":{"role":"assistant","model":"haiku",
                           "content":[{"type":"text","text":"리팩터링을 끝냈어"}]},
                "session_id":"S1","uuid":"U-w"}));
        }
        let text = if self.banner {
            "5-hour limit reached ∙ resets 3pm".to_string()
        } else {
            format!("Claude AI usage limit reached|{}", RESET + self.roll * self.turns)
        };
        self.turns += 1;
        self.pending.push(json!({
            "type":"result","subtype":"error_during_execution","is_error":true,
            "result": text
        }));
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

fn rt(clock: Arc<VirtualClock>, cli: WcapCli) -> ChatRuntime<WcapCli> {
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

/// 가상 t=1000s의 벽시계를 "리셋 `ahead`초 전"에 놓는다(`r14_limit_loop`와 같은 자).
fn clock_at(ahead: u64) -> Arc<VirtualClock> {
    let clock = VirtualClock::new();
    clock.advance_to(1_000 * SEC);
    clock.set_epoch_base((RESET - ahead) * 1_000 - 1_000 * SEC);
    clock
}

fn pump(r: &mut ChatRuntime<WcapCli>, clock: &Arc<VirtualClock>, until: Millis) {
    while clock.now_ms() < until {
        clock.advance_by(SEC);
        r.tick();
    }
}

/// 첫 사용자 턴을 태워 대기표를 세우고, 그 뒤의 자동 재발사 수를 센다.
fn run(cli: WcapCli, until: Millis) -> (ChatRuntime<WcapCli>, Arc<VirtualClock>, usize) {
    let clock = clock_at(5 * 3600);
    let mut r = rt(clock.clone(), cli);
    r.dispatch(Cmd::Send { text: "첫 턴".into() });
    pump(&mut r, &clock, 1_030 * SEC);
    assert!(r.hold().is_some(), "첫 턴이 한도로 죽어 표가 서야 한다");
    let spawns0 = r.driver_ref().spawns;
    pump(&mut r, &clock, until);
    let blind = r.driver_ref().spawns - spawns0;
    (r, clock, blind)
}

/// ① **창이 진짜로 넘어간 재개는 헛발질이 아니다.** 꼬리가 매 턴 1시간씩 뒤로 가는 판 =
/// 밤샘 연속 주행(22시 → 03시 → 08시 → …)의 축약이다. R28c에서는 두 창째에 접혔다.
#[test]
fn a_resume_that_moved_into_a_new_window_is_not_counted_as_a_blind_shot() {
    let cli = WcapCli {
        roll: HOUR / 1_000, // 초 단위 — 턴마다 리셋이 1시간 뒤로
        ..Default::default()
    };
    // 첫 표는 5시간 뒤, 그다음부터 한 시간에 하나씩 — 11시간이면 창 일곱 개를 넘는다.
    let (r, _clock, blind) = run(cli, 1_000 * SEC + 11 * HOUR + 5 * MIN);
    let h = r.hold().expect("표는 서 있다");
    println!(
        "[WCAP①] 창 이동 재개 {blind}회 · hold{{ready:{}, auto_paused:{}, attempts:{}}}",
        h.ready, h.auto_paused, h.attempts
    );
    assert!(
        blind as u32 > MAX_AUTO_ATTEMPTS,
        "★ 창을 넘어간 재개가 상한에 걸렸다 — {blind}회에서 멎었다"
    );
    assert_eq!(blind, 7, "창 일곱 개 = 일곱 발(리셋 + 90초 예정표대로)");
    assert_eq!(h.attempts, 0, "★ 계수가 한 번도 안 올랐다");
    assert!(!h.auto_paused, "★ 자동이 접혔다 = 밤샘 주행이 잘렸다");
}

/// ② **꼬리가 없는 축은 「일한 흔적」이 든다.** codex 한도 문구에는 `…|epoch`가 없어
/// 구분자 ①이 영영 침묵한다. 같은 대본을 빈손으로 돌린 ③이 대조군이다.
#[test]
fn a_worked_turn_clears_the_streak_when_the_wall_time_is_unknown() {
    let cli = WcapCli {
        banner: true,
        work: true,
        ..Default::default()
    };
    // 시각 미상 대기의 간격은 `unknown_wait(attempts)` — 계수가 0으로 남으면 늘 10분이다.
    let (r, _clock, blind) = run(cli, 1_000 * SEC + 65 * MIN);
    let h = r.hold().expect("표는 서 있다");
    println!(
        "[WCAP②] 일한 재개 {blind}회 · hold{{ready:{}, auto_paused:{}, attempts:{}}}",
        h.ready, h.auto_paused, h.attempts
    );
    assert!(
        blind as u32 > MAX_AUTO_ATTEMPTS,
        "★ 일한 재개가 상한에 걸렸다 — {blind}회에서 멎었다"
    );
    assert_eq!(h.attempts, 0, "★ 일한 턴은 계수를 올리지 않는다");
    assert!(!h.auto_paused, "★ 자동이 접혔다");
}

/// ③ **RCAP 불변 — 진짜 헛발질은 그대로 상한에서 멎는다.** ②와 같은 대본에서 「일했다」만
/// 뺀 대조군이다. 이 축이 무뎌지면 5시간 창 하나에 수십 발이 나가던 판으로 되돌아간다.
#[test]
fn a_blind_resume_still_stops_at_the_cap() {
    let cli = WcapCli {
        banner: true,
        work: false,
        ..Default::default()
    };
    // ②보다 창을 넓게 잡는다 — 계수가 오르면 `unknown_wait`이 10 → 20 → 40분으로 벌어진다.
    let (r, _clock, blind) = run(cli, 1_000 * SEC + 5 * HOUR);
    let h = r.hold().expect("표는 서 있다");
    println!(
        "[WCAP③] 헛발질 {blind}회 · hold{{ready:{}, auto_paused:{}, attempts:{}}}",
        h.ready, h.auto_paused, h.attempts
    );
    assert_eq!(blind as u32, MAX_AUTO_ATTEMPTS, "★ 상한만큼만");
    assert!(h.ready && h.auto_paused, "★ 자동을 접고 사용자에게 넘긴다");
    assert_eq!(h.attempts, MAX_AUTO_ATTEMPTS, "계수가 표에 실려 있다");
}

/// ④ **시계가 일한 흔적을 이긴다** — 이 라운드가 스스로 판 함정의 회귀 잠금.
///
/// 매 턴 토큰 한 줄을 내고 **같은 벽**(이미 지난 epoch)에 다시 부딪히는 판이다. 구분자를
/// OR로 두면 계수가 영영 0이 되고, `due_at`이 `armed_at + 15s`로 접혀 15초마다 CLI를
/// 태운다 — RCAP이 막은 그 주기의 부활이다. 시각을 둘 다 아는 판에서는 ①의 답이 이미
/// 완전하므로(넘어갔다면 새 창의 리셋은 반드시 더 뒤다) ②를 안 본다.
#[test]
fn a_worked_turn_cannot_override_the_clock_when_both_walls_are_known() {
    let cli = WcapCli {
        roll: 0, // 같은 벽
        work: true,
        ..Default::default()
    };
    let (mut r, clock, blind) = run(cli, 1_000 * SEC + 6 * HOUR);
    let h = r.hold().expect("표는 서 있다");
    println!(
        "[WCAP④] 토큰 한 줄 + 같은 벽 {blind}회 · hold{{ready:{}, auto_paused:{}, attempts:{}}}",
        h.ready, h.auto_paused, h.attempts
    );
    assert_eq!(blind as u32, MAX_AUTO_ATTEMPTS, "★★ 상한이 무력화됐다 — {blind}회");
    assert!(h.ready && h.auto_paused, "★ 접힌 표(사용자의 버튼 차례)");

    // 그리고 접힌 뒤에는 몇 시간을 더 밀어도 0회다(RCAP의 그 성질 그대로).
    let before = r.driver_ref().spawns;
    pump(&mut r, &clock, 1_000 * SEC + 12 * HOUR);
    assert_eq!(r.driver_ref().spawns, before, "★ 멈춘 뒤에는 영원히 0회");
}
