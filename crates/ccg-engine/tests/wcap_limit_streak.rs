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
//! | ⑤ | **화면에 아무것도 안 남기는 프레임 한 장**(R2) | 접힌다 — 그건 「일했다」가 아니다 |
//! | ⑥ | 화면에 글자·도구가 남는 프레임(R2) | 안 접힌다 — 좁히다가 여기까지 자르면 안 된다 |
//!
//! ④가 이 라운드가 스스로 판 함정이다. 구분자를 OR로 두면 그 판에서 계수가 영영 0이 되고,
//! `due_at`이 `max(resets_at + 90s, armed_at + 15s)`라 **15초마다** 재발사가 돈다 =
//! RCAP이 막은 무한 주기의 부활. 그래서 시각을 둘 다 아는 판은 시계가 판정하고, 한쪽이라도
//! 미상인 판만 일한 흔적이 판정한다(`runtime.rs::arm_hold`의 `cleared`).
//!
//! ⑤⑥이 **R2에서 새로 박은 못**이다(WCAP 확인 크리틱 R1 §3.2). R1의 ②는 엔진에서
//! `saw_turn_activity`를 읽었고 그 값은 `Frame::StreamEvent` 맨 끝줄에서 **조건 없이**
//! 섰다 — `ping` 한 장이면 「일했다」가 됐다. 렌더러 짝(`turnDidWork`)은 화면에 **남은**
//! 어시스턴트 텍스트·**비어 있지 않은** 도구 그룹만 세므로 같은 12시간 대본에 **엔진 71발 /
//! 렌더러 2발**이 나왔다. 문턱을 좁혀 양쪽을 한 벌로 만든 것이 R2이고, 이 두 못이 그
//! 71 대 2를 잠근다(⑤ = 크리틱 P4 표의 네 줄, ⑥ = 반대 방향의 과잉 절단 방지).
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
    /// ★R2 — result 에러 앞에 흘리는 **임의의 프레임들**. 구분자 ②의 *문턱*을 재는
    /// 손잡이다(`work`는 「확실히 일했다」쪽 한 점만 짚는다).
    pre: Vec<Value>,
}

impl CliDriver for WcapCli {
    fn spawn(&mut self, _spec: &SpawnSpec) -> std::io::Result<()> {
        self.spawns += 1;
        self.alive = true;
        self.pending
            .push(json!({"type":"system","subtype":"init","session_id":"S1","model":"haiku"}));
        Ok(())
    }
    fn send(&mut self, line: Value) {
        // **사용자 프롬프트 줄에만 반응한다.** 런타임은 한 턴에 stdin 줄을 여러 번 밀고
        // (`initialize`·`control_response`·프로브), 그것까지 세면 꼬리가 턴당 두 배로 뛴다.
        //
        // ★R2 — R1은 이 자리를 "스폰 하나에 한 번"으로 막았는데, 그러면 **프로세스를
        // 재사용하는 재개**(도구가 돌던 채로 상주가 된 스트림)에 영영 답을 안 준다.
        // 실제로 ⑥의 「도구 호출」 판이 그 자리에서 blind=0 · state=Streaming으로 굳었다.
        // 줄의 종류로 가르면 두 요구가 같이 산다.
        if line["type"] != "user" {
            return;
        }
        if self.work {
            // 메인 경로 어시스턴트 텍스트 = `mark_activity()` → `saw_turn_activity`.
            self.pending.push(json!({"type":"assistant","parent_tool_use_id":null,
                "message":{"role":"assistant","model":"haiku",
                           "content":[{"type":"text","text":"리팩터링을 끝냈어"}]},
                "session_id":"S1","uuid":"U-w"}));
        }
        for f in &self.pre {
            self.pending.push(f.clone());
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

/// 시각 미상 축(=codex 대기표의 기본 축)에서 12시간을 돌린다. 계수가 0으로 남으면
/// `unknown_wait(0)` = 10분이라 **71발**이 나가고, 상한이 살아 있으면 2발에서 멎는다.
fn twelve_hours_unknown_wall(pre: Vec<Value>) -> (usize, u32, bool, bool) {
    let cli = WcapCli { banner: true, pre, ..Default::default() };
    let (r, _clock, blind) = run(cli, 1_000 * SEC + 12 * HOUR);
    let h = r.hold().expect("표는 서 있다");
    (blind, h.attempts, h.ready, h.auto_paused)
}

/// ⑤ ★R28d WCAP **R2** — **화면에 아무것도 안 남기는 프레임 한 장은 「일했다」가 아니다.**
///
/// WCAP 확인 크리틱 R1 §3.2의 P4 표 그대로다. R1의 ②는 `saw_turn_activity`를 읽었고 그
/// 값은 `Frame::StreamEvent` 맨 끝줄에서 조건 없이 섰다 — `match`의 `_ => {}`로 빠진
/// 프레임도 그 줄에 닿는다. 그래서 아래 네 줄이 전부 **12시간에 71발 · attempts 0 ·
/// 안 접힘**이었다. 같은 판의 렌더러는 `[사용자, 오류]` 두 말풍선뿐이라 2발에서 접힌다
/// (`thinking`은 result가 오면 스토어가 걷는다). 71 대 2 = 파리티가 깨진 자리이자,
/// codex 축에서 RCAP의 「자동은 최대 2발」이 통째로 사라지던 자리다.
#[test]
fn a_frame_that_leaves_nothing_on_screen_does_not_clear_the_streak() {
    let delta = |d: Value| json!({"type":"stream_event","event":{"type":"content_block_delta","delta":d}});
    let cases: Vec<(&str, Vec<Value>)> = vec![
        ("프레임 없음", vec![]),
        ("message_start", vec![json!({"type":"stream_event","event":{"type":"message_start"}})]),
        ("thinking_delta", vec![delta(json!({"type":"thinking_delta","thinking":"어디부터 볼까"}))]),
        ("ping", vec![json!({"type":"stream_event","event":{"type":"ping"}})]),
        // 문턱의 나머지 반쪽 — **빈** 글자·**빈** 블록은 렌더러에서 `.trim()`에 걸린다.
        ("content_block_start", vec![json!({"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"text"}}})]),
        ("빈 text_delta", vec![delta(json!({"type":"text_delta","text":"   "}))]),
        ("빈 assistant 텍스트", vec![json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":""}]}})]),
    ];
    for (label, pre) in cases {
        let (blind, attempts, ready, paused) = twelve_hours_unknown_wall(pre);
        println!("[WCAP⑤ {label}] 12시간 {blind}회 · attempts {attempts} · ready {ready} · auto_paused {paused}");
        assert_eq!(
            blind as u32, MAX_AUTO_ATTEMPTS,
            "★★ 「{label}」 한 장이 상한을 지웠다 — 12시간에 {blind}회"
        );
        assert!(ready && paused, "★ 「{label}」: 자동을 접고 사용자에게 넘겨야 한다");
        assert_eq!(attempts, MAX_AUTO_ATTEMPTS, "「{label}」: 계수가 표에 실려 있다");
    }
}

/// ⑥ ★R28d WCAP **R2** — **반대 방향의 못.** 좁히다가 여기까지 자르면 파리티가 거꾸로
/// 깨지고(렌더러는 「일했다」인데 엔진만 접는다) 밤샘 주행이 다시 창 두 개에서 잘린다.
/// 렌더러 `turnDidWork`가 참이 되는 세 모양을 그대로 짚는다: 스트리밍 텍스트가 남은 턴 ·
/// 완성 어시스턴트 텍스트 · 도구 호출(= 비어 있지 않은 도구 그룹).
#[test]
fn output_that_stays_on_screen_still_clears_the_streak() {
    let cases: Vec<(&str, Vec<Value>)> = vec![
        (
            "text_delta(스트리밍)",
            vec![json!({"type":"stream_event","event":{"type":"content_block_delta",
                "delta":{"type":"text_delta","text":"리팩터링을 시작할게"}}})],
        ),
        (
            "assistant 텍스트",
            vec![json!({"type":"assistant","message":{"role":"assistant","model":"haiku",
                "content":[{"type":"text","text":"끝냈어"}]}})],
        ),
        // 도구 축은 **쌍으로** 온다. 결과 없이 죽은 `tool_use`만 흘리면 그 스트림은
        // 도구가 도는 채로 상주가 되어(실측: `state=Resident` · 재스폰 0) 애초에 한도
        // 재발사 경로에 들어가지 않는다 — 그래서 쌍이 이 축의 정직한 대본이다.
        (
            "도구 호출+결과",
            vec![
                json!({"type":"assistant","message":{"role":"assistant","model":"haiku",
                    "content":[{"type":"tool_use","id":"toolu-1","name":"Read","input":{}}]}}),
                json!({"type":"user","message":{"role":"user",
                    "content":[{"type":"tool_result","tool_use_id":"toolu-1","content":"ok"}]}}),
            ],
        ),
        (
            "도구 결과만",
            vec![json!({"type":"user","message":{"role":"user",
                "content":[{"type":"tool_result","tool_use_id":"toolu-9","content":"ok"}]}})],
        ),
    ];
    for (label, pre) in cases {
        let cli = WcapCli { banner: true, pre, ..Default::default() };
        let (r, _clock, blind) = run(cli, 1_000 * SEC + 65 * MIN);
        let h = r.hold().expect("표는 서 있다");
        println!(
            "[WCAP⑥ {label}] 65분 {blind}회 · attempts {} · auto_paused {}",
            h.attempts, h.auto_paused
        );
        assert!(
            blind as u32 > MAX_AUTO_ATTEMPTS,
            "★ 「{label}」이 상한에 걸렸다 — {blind}회에서 멎었다"
        );
        assert_eq!(h.attempts, 0, "★ 「{label}」: 일한 턴은 계수를 올리지 않는다");
        assert!(!h.auto_paused, "★ 「{label}」: 자동이 접혔다");
    }
}
