//! ★R28d WCAP — **상한이 「헛발질」과 「제대로 일한 재개」를 가른다.**
//!
//! RCAP 확인 크리틱 R1 §4.1의 최대 격차: `auto_resume_streak`은 한도로 죽은 착지마다
//! 올랐고, 그 턴이 30초 만에 같은 벽에 부딪혔는지 5시간을 꽉 채워 일하고 **다음 창에서**
//! 막혔는지를 아무도 안 봤다. 그래서 22시 한도 → 03시 재개(성공) → 08시 새 한도 → 13시
//! 재개(성공) → 18시 새 한도에서 자동이 접히고, 사용자는 아침에 「자동으로 이어서 보낸
//! turn이 계속 한도에 막혔어요」를 읽는다 — 그 턴들은 막힌 게 아니라 일했다.
//!
//! 렌더러 짝은 `scripts/poc-limit-resume.mjs` J·L절이다(같은 구분자·같은 우선순위·같은
//! 예산을 훅 실구동으로 잰다):
//!
//! | # | 판 | 기대 |
//! |---|---|---|
//! | ① | 창이 진짜로 넘어간다(꼬리 epoch이 매번 뒤로) | 안 접힌다 · `attempts` 0 유지 |
//! | ② | 꼬리 없는 문구 + 그 턴이 **오래** 일을 했다 | 안 접힌다(그 축은 ②가 든다) |
//! | ③ | 꼬리 없는 문구 + 빈손 = 진짜 헛발질 | **RCAP 그대로** 상한에서 접힌다 |
//! | ④ | 토큰 한 줄 + **같은 벽**(지난 epoch 되돌림) | 접힌다 — 시계가 일한 흔적을 이긴다 |
//! | ⑤ | **화면에 아무것도 안 남기는 프레임 한 장**(R2) | 접힌다 — 그건 「일했다」가 아니다 |
//! | ⑥ | 화면에 글자·도구가 남는 프레임(R2) | 안 접힌다 — 좁히다가 여기까지 자르면 안 된다 |
//! | ⑦ | **도구가 턴 경계를 넘는다**(R3) | 접힌다 — 그 도구 그룹은 렌더러에서 이 턴 것이 아니다 |
//! | ⑧ | 반쪽만 아는 벽 + `ping`(R4) | 접힌다 — ②가 드는 축은 배너형만이 아니다 |
//! | ⑨ | 반쪽만 아는 벽 + 진짜 산출(R4) | 안 접힌다(⑧의 반대편) |
//! | ⑩ | **산출을 내되 즉사한다**(★R28e) | 접힌다 — R28d에서 12시간 **71발**이던 자리 |
//! | ⑪ | 같은 대본 + **수명 ≥ `MIN_WORK`**(★R28e) | 안 접힌다(⑩의 반대편 · 문턱 아래는 접힌다) |
//! | ⑫ | 오래 일하며 계속 막힌다(★R28e) | **`MAX_EPISODE_FIRES`발**에서 접힌다 — 예산이 천장 |
//! | ⑬ | 예산을 다 쓴 뒤 사용자가 누른다(★R28e) | 다시 쏜다 — 막다른 방이 아니다 |
//! | ⑭ | 예산을 다 쓴 표로 **앱을 껐다 켠다**(★R28f) | 0발 — 재시작은 예산을 재충전하지 않는다 |
//! | ⑮ | 5시간 창 · 4.5시간 작업을 **끝까지**(★R28f) | **60시간**에 접힌다 = 불변식의 유효 범위 |
//! | ⑯ | 상한까지 쏜 표로 앱을 껐다 켠다(★R28f) | 0발 — 크리틱이 잰 「+2발」이 닫힌다 |
//!
//! ⑭⑯이 **R28f에서 새로 박은 못**이고 **대조군을 못 안에 품는다**(R28e 확인 크리틱 R1 §4.1).
//! 같은 바이너리·같은 대본·같은 재장전 경로에서 `ReloadHold`의 새 칸을 0으로 두면 R28e의
//! 동작(12발·2발 재충전)이 그대로 재현된다 — 즉 두 못은 「고쳐졌나」와 「그 칸이 정말
//! 원인이었나」를 함께 잰다. ⑮는 고치는 못이 아니라 **문장을 정확히 하는 못**이다:
//! 「밤샘은 안 잘린다」의 참인 판은 「**약 60시간까지는** 안 잘린다」이고, 그 범위의 반대쪽
//! 끝(하룻밤 7발)은 ①이 이미 잠그고 있다.
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
//!
//! ⑦이 **R3에서 새로 박은 못**이다(WCAP 확인 크리틱 R2 §3.3). R2는 「무엇을 산출로 세는가」만
//! 맞추고 **「어느 턴의 것으로 세는가」**를 안 맞췄다: 엔진의 `saw_turn_output`은 *프레임이
//! 도착한 엔진 턴*에 적히는데 렌더러의 `turnDidWork`는 *마지막 사용자 말풍선 뒤 구간*에서
//! 읽는다. 앞 턴에서 열린 도구의 결과가 재개 턴에 뒤늦게 오면(상주 CLI에 재개를 **주입**하는
//! 이 엔진에서는 실재하는 다리다) 두 축이 반대편에 서서 같은 71 대 2가 되살아났다.
//!
//! **계기 눈금도 R3에서 고쳤다.** R2까지 `run()`은 재발사를 `driver.spawns`(재스폰 수)로 셌다.
//! 그런데 도구가 미정착이면 스트림이 `Resident`로 남아 재개가 **주입**으로 나가고
//! (`drain_if_possible`이 `Idle` **또는 `Resident`**에서 돈다) 스폰은 한 번도 안 오른다 —
//! 크리틱 R2 §4.1 실측: 재스폰 0인데 **CLI턴 72**. 그래서 이제 **stdin으로 나간 사용자 프롬프트
//! 줄**(= CLI 턴 1회)을 센다. 재스폰 경로에서는 두 눈금이 같은 값이라 ①②③④⑤⑥의 숫자는 안 바뀐다.
use ccg_engine::clock::{Clock, Millis, VirtualClock, HOUR, MIN, SEC};
use ccg_engine::driver::{CliDriver, SpawnSpec};
use ccg_engine::identity::*;
use ccg_engine::limit::MAX_AUTO_ATTEMPTS;
use ccg_engine::runtime::{ChatRuntime, Cmd, ReloadHold};
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
    /// ★R4 — **첫 표만 꼬리가 있고 그다음부터 없다**(WCAP 확인 크리틱 R1 §2.2의 P4).
    /// `arm_hold`의 `match (resets_at, self.auto_resume_at)`는 **한쪽만 미상이어도** 같은
    /// `_ => worked` 가지로 떨어진다 — 즉 ②가 드는 축은 `banner` 판만이 아니다. 실전에서
    /// 이 모양은 흔하다: 클로드 문구 중 `…|epoch` 꼬리가 붙는 것은 일부고
    /// (`banner_limit_reached`·`your_limit`·한국어 계열엔 없다) 같은 계정이 턴마다 다른
    /// 문구를 받는다.
    mixed_wall: bool,
    /// result 에러 **앞에** 어시스턴트 출력을 흘린다 = 그 턴은 일을 했다.
    work: bool,
    /// ★R2 — result 에러 앞에 흘리는 **임의의 프레임들**. 구분자 ②의 *문턱*을 재는
    /// 손잡이다(`work`는 「확실히 일했다」쪽 한 점만 짚는다).
    pre: Vec<Value>,
    /// ★R3 — **도구가 턴 경계를 넘는다**(크리틱 R2 §3.3의 P12 대본). 첫 턴은 결과 없이
    /// 죽는 `tool_use` 하나를 흘리고, 그 뒤의 **재개 턴들은 앞 턴 도구의 `tool_result`만**
    /// 흘린다. `pre`로는 못 만든다 — `pre`는 턴마다 같은 프레임을 낸다.
    cross_turn_tool: bool,
    /// ★R28e WFIRE — **그 턴이 사는 시간**(ms). 산출은 프롬프트를 받자마자 흘리고, 한도
    /// result는 이만큼 뒤에 흘린다. `0` = R28d까지의 모양(받은 그 자리에서 즉사).
    ///
    /// 이 손잡이가 새로 생긴 이유(WCAP 확인 크리틱 R2 §5.1): R4까지 구분자 ②는 「무엇을
    /// 냈나」만 봤고, 그래서 *한 줄 내고 즉사하는 턴*이 *창을 꽉 채워 일한 턴*과 같은 답을
    /// 받았다 — 시각 미상 축에서 12시간 71발. 이제 ②는 수명(`MIN_WORK`)과 함께 보므로,
    /// 「일한 재개」를 재는 못(②⑥⑨)은 **진짜로 시간이 걸리는 턴**이어야 한다.
    work_ms: u64,
    /// `work_ms`가 0이 아닐 때 미뤄 둔 한도 result와 그 만기(첫 `poll_frames`에서 잡는다).
    held_err: Option<Value>,
    err_due: Option<Millis>,
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
        // ★R28e WFIRE — **`initialize`에 답한다.** R28d까지 이 CLI는 답하지 않았고, 그래도
        // 못이 섰던 이유는 턴이 *같은 tick에 즉사*했기 때문이다: `init_ack`가 없으면 상태가
        // `Starting`에 머물고 20초 뒤 `START_TIMEOUT`(T3)이 스트림을 접는다 —
        // 「엔진이 20초 안에 응답하지 않았어요」 + `SpawnFailed`. 수명 손잡이(`work_ms`)를
        // 켜는 순간 그 문이 열려서, 한도 result가 도착할 때는 스트림도 턴도 이미 없었다
        // (실측: `arm_hold`에서 `stream=false state=Idle` → 구분자 ②가 영영 거짓).
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
        if self.cross_turn_tool {
            if self.turns == 0 {
                // 턴0 — 도구를 열어 놓은 채 한도로 죽는다(결과가 안 온다).
                self.pending.push(json!({"type":"assistant","parent_tool_use_id":null,
                    "message":{"role":"assistant","model":"haiku",
                               "content":[{"type":"tool_use","id":"toolu-0","name":"Read","input":{}}]},
                    "session_id":"S1","uuid":"U-t0"}));
            } else {
                // 재개 턴 — **앞 턴** 도구의 결과만. 렌더러에서 이 결과는 새 항목을 안
                // 만들고(있는 도구를 제자리에서 패치만) 그 도구 그룹은 재개 사용자
                // 말풍선 **앞**에 남는다 = `turnDidWork` 거짓.
                self.pending.push(json!({"type":"user","parent_tool_use_id":null,
                    "message":{"role":"user",
                               "content":[{"type":"tool_result","tool_use_id":"toolu-0","content":"ok"}]},
                    "session_id":"S1","uuid":"U-tn"}));
            }
        }
        // ★R4 — `mixed_wall`이면 **첫 표만** 꼬리를 달고 그 뒤로는 배너형이다(P4 축).
        let text = if self.banner || (self.mixed_wall && self.turns > 0) {
            "5-hour limit reached ∙ resets 3pm".to_string()
        } else {
            format!("Claude AI usage limit reached|{}", RESET + self.roll * self.turns)
        };
        self.turns += 1;
        let err = json!({
            "type":"result","subtype":"error_during_execution","is_error":true,
            "result": text
        });
        // ★R28e WFIRE — 수명이 0이면 R28d 그대로 즉사, 아니면 `poll_frames`가 만기에 흘린다.
        if self.work_ms == 0 {
            self.pending.push(err);
        } else {
            self.held_err = Some(err);
            self.err_due = None;
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
        // ★R28e WFIRE — 미뤄 둔 한도 result의 만기는 **첫 폴에서** 잡는다(`send`는 시계를
        // 못 본다). 그래서 턴 수명 = 프롬프트가 나간 뒤 첫 tick부터 `work_ms`다.
        if self.held_err.is_some() {
            let due = *self.err_due.get_or_insert(now + self.work_ms);
            if now >= due {
                if let Some(err) = self.held_err.take() {
                    self.pending.push(err);
                }
                self.err_due = None;
            }
        }
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
///
/// ★R3 — 눈금은 **stdin으로 나간 사용자 프롬프트 줄**(`WcapCli::turns`)이다. R2까지 쓰던
/// `driver.spawns`는 **재스폰만** 세므로, 도구가 미정착이라 스트림이 `Resident`로 남은 판에서는
/// 재개가 71번 나가도 0을 돌려준다(크리틱 R2 §4.1: 재스폰 0 · CLI턴 72). 재스폰 경로에서는
/// 두 눈금이 같은 값이라 기존 못들의 숫자는 안 바뀐다.
fn run(cli: WcapCli, until: Millis) -> (ChatRuntime<WcapCli>, Arc<VirtualClock>, usize) {
    let clock = clock_at(5 * 3600);
    let mut r = rt(clock.clone(), cli);
    r.dispatch(Cmd::Send { text: "첫 턴".into() });
    // ★R28e WFIRE — 수명 손잡이(`work_ms`)는 **모든** send에 걸리므로 첫 턴도 그만큼 산다.
    // 그래서 고정 30초가 아니라 **표가 설 때까지** 민다(상한 2시간 — 안 서면 그대로 실패).
    let armed_by = clock.now_ms() + 2 * HOUR;
    while clock.now_ms() < armed_by && r.hold().is_none() {
        clock.advance_by(SEC);
        r.tick();
    }
    assert!(r.hold().is_some(), "첫 턴이 한도로 죽어 표가 서야 한다");
    let turns0 = r.driver_ref().turns;
    pump(&mut r, &clock, until);
    let blind = (r.driver_ref().turns - turns0) as usize;
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
///
/// ★R28e WFIRE — 「일했다」의 정의에 **수명**이 붙었다(크리틱 R2 §5.1). R28d의 이 못은
/// *어시스턴트 텍스트 한 줄을 내고 그 자리에서 즉사하는* 턴이었는데, 그 모양이 바로
/// 크리틱이 12시간 71발로 잰 병증(Q2)이다 — 이제 그것은 아래 ⑩이 「접힌다」로 잠근다.
/// 이 못이 지키려던 것(**진짜 일한 재개는 안 잘린다**)은 턴을 실제로 살려서(`work_ms`)
/// 그대로 남는다.
#[test]
fn a_worked_turn_clears_the_streak_when_the_wall_time_is_unknown() {
    let cli = WcapCli {
        banner: true,
        work: true,
        work_ms: 50 * MIN, // 창을 태우는 턴 = 분·시간 단위(문전박대는 초 단위다)
        ..Default::default()
    };
    // 시각 미상 대기의 간격은 `unknown_wait(attempts)` — 계수가 0으로 남으면 늘 10분이다.
    // 한 바퀴 = 50분 작업 + 10분 대기 = 60분.
    let (r, _clock, blind) = run(cli, 1_000 * SEC + 4 * HOUR);
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
    let before = r.driver_ref().turns;
    pump(&mut r, &clock, 1_000 * SEC + 12 * HOUR);
    assert_eq!(r.driver_ref().turns, before, "★ 멈춘 뒤에는 영원히 0회");
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
        // ★R4 — 닫는 쪽도 같은 `_ => {}` 가지다(WCAP 확인 크리틱 R1 §2.2의 P3).
        ("content_block_stop", vec![json!({"type":"stream_event","event":{"type":"content_block_stop","index":0}})]),
        ("빈 text_delta", vec![delta(json!({"type":"text_delta","text":"   "}))]),
        ("빈 assistant 텍스트", vec![json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":""}]}})]),
        // ★R3 — **짝 없는 도구 결과.** R2는 이 줄을 ⑥(안 접힘)에 두었는데 그건 렌더러와
        // 반대다: 원장에 없는 `tool_use_id`의 결과는 렌더러 `tool-end`에서 붙일 행을 못 찾고
        // 스레드를 **그대로** 돌려준다(무동작) → `turnDidWork` 거짓 → 2발에서 접힌다.
        // 크리틱 R2 §3.2 대조표의 유일한 불일치 줄이었다.
        (
            "짝 없는 도구 결과",
            vec![json!({"type":"user","message":{"role":"user",
                "content":[{"type":"tool_result","tool_use_id":"toolu-9","content":"ok"}]}})],
        ),
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
        // 도구 축은 **쌍으로** 온다 — 그리고 그 쌍이 **같은 턴 안에** 있어야 렌더러의
        // 도구 그룹이 이 턴 것이 된다(⑦이 그 반대편을 잠근다).
        //
        // ★R3 정정 — R2는 여기 「결과 없이 죽은 `tool_use`만 흘리면 그 스트림이 상주가 되어
        // 애초에 한도 재발사 경로에 들어가지 않는다」고 적었는데 **틀렸다**. 안 들어가는 것은
        // *재스폰*뿐이고, 상주 스트림은 프로세스를 재사용해 재개를 **주입**한다
        // (`drain_if_possible`이 `Resident`에서도 돈다 — 크리틱 R2 §4.1 실측: 재스폰 0 ·
        // CLI턴 72). 그 오독이 R2 계기 눈금(`spawns`)의 근거였고, 지금은 프롬프트 줄을 센다.
        (
            "같은 턴의 도구 호출+결과",
            vec![
                json!({"type":"assistant","message":{"role":"assistant","model":"haiku",
                    "content":[{"type":"tool_use","id":"toolu-1","name":"Read","input":{}}]}}),
                json!({"type":"user","message":{"role":"user",
                    "content":[{"type":"tool_result","tool_use_id":"toolu-1","content":"ok"}]}}),
            ],
        ),
        // 결과 없이 죽는 도구 호출 **단독**. 렌더러에서는 이 턴이 연 도구 그룹이 비어 있지
        // 않으므로 「일했다」이고, 엔진도 `Frame::Assistant`에서 그렇게 읽어야 한다.
        // (R2는 상주 판을 잴 눈금이 없어 이 줄을 못 세웠다 — R3의 프롬프트 계수가 세운다.)
        (
            "결과 없이 죽는 도구 호출",
            vec![json!({"type":"assistant","message":{"role":"assistant","model":"haiku",
                "content":[{"type":"tool_use","id":"toolu-2","name":"Read","input":{}}]}})],
        ),
    ];
    for (label, pre) in cases {
        // ★R28e WFIRE — ②와 같은 이유로 이 못들도 **진짜로 시간이 걸리는 턴**이어야 한다.
        // 산출은 프롬프트 직후에 흘리고 한도 result만 50분 뒤에 온다(= 창을 태운 턴의 모양).
        let cli = WcapCli { banner: true, pre, work_ms: 50 * MIN, ..Default::default() };
        let (r, _clock, blind) = run(cli, 1_000 * SEC + 4 * HOUR);
        let h = r.hold().expect("표는 서 있다");
        println!(
            "[WCAP⑥ {label}] 4시간 {blind}회 · attempts {} · auto_paused {}",
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

/// ⑦ ★R28d WCAP **R3** — **도구가 턴 경계를 넘으면 그 결과는 이 턴의 산출이 아니다.**
///
/// WCAP 확인 크리틱 R2 §3.3의 P12 대본 그대로다:
///
/// ```text
/// 턴0  사용자 프롬프트 → assistant{tool_use "toolu-0"} → result 한도 에러  (결과 없이 죽는다)
/// 턴n  재개 프롬프트   → user{tool_result "toolu-0"}   → result 한도 에러  (앞 턴 도구의 결과만)
/// ```
///
/// R2 코드에서 이 판은 **12시간에 71발 · attempts 0 · 안 접힘**이었고, 같은 스트림이
/// 렌더러 스토어에 만드는 스레드는 `turnDidWork = false`라 **2발에서 접힌다**. 렌더러가
/// 거짓인 이유는 구조적이다 — `tool-end`는 **있는 도구를 제자리에서 패치만** 하고 항목을
/// 새로 붙이지 않으므로(`app/src/store/session.ts`) 그 도구 그룹은 재개의 사용자 말풍선
/// **앞**에 남고, 뒤에서부터 훑는 `turnDidWork`가 사용자 말풍선에서 멎는다.
///
/// 이 판은 상주 스트림이라 **재스폰이 0**이다. R2의 `spawns` 눈금으로는 71발이 0으로
/// 보였다(크리틱 R2 §4.1) — 그래서 이 못은 `run()`의 프롬프트 계수와 짝으로만 산다.
#[test]
fn a_tool_result_that_crosses_the_turn_boundary_does_not_clear_the_streak() {
    let cli = WcapCli {
        banner: true, // 시각 미상 = ②가 유일 판정자인 축
        cross_turn_tool: true,
        ..Default::default()
    };
    let (r, _clock, blind) = run(cli, 1_000 * SEC + 12 * HOUR);
    let h = r.hold().expect("표는 서 있다");
    println!(
        "[WCAP⑦] 앞 턴 도구의 결과 {blind}회 · attempts {} · ready {} · auto_paused {}",
        h.attempts, h.ready, h.auto_paused
    );
    assert_eq!(
        blind as u32, MAX_AUTO_ATTEMPTS,
        "★★ 턴 경계를 넘은 도구 결과가 상한을 지웠다 — 12시간에 {blind}회(렌더러는 2발)"
    );
    assert!(h.ready && h.auto_paused, "★ 자동을 접고 사용자에게 넘겨야 한다");
    assert_eq!(h.attempts, MAX_AUTO_ATTEMPTS, "계수가 표에 실려 있다");
}

/// ⑧ ★R28d WCAP **R4** — **②가 드는 축은 「꼬리가 아예 없는 판」만이 아니다.**
///
/// WCAP 확인 크리틱 R1 §2.2의 **P4**(mixed) 대본이다. `arm_hold`의
/// `match (resets_at, self.auto_resume_at)`는 **한쪽만 미상이어도** 같은 `_ => worked`
/// 가지로 떨어진다 — 즉 첫 표는 꼬리가 있었고 그다음 문구부터 없어지는 판(같은 계정이
/// 턴마다 다른 문구를 받는 실전 모양: `…|epoch` 꼬리는 클로드 문구 **일부**에만 붙는다)도
/// 그 가지다. R1 규칙(`saw_turn_activity`)에서는 이 축이 `ping` 한 장에 **12시간 42발**
/// 이었다(⑤의 71발보다 작은 이유는 첫 대기가 꼬리대로 5시간을 진짜 기다리기 때문이다).
///
/// ⑤와 같은 것을 재는 못이 아니다: ⑤는 「무엇이 산출인가」를, 이 못은 「**어느 판에서**
/// ②가 유일 판정자가 되는가」를 잰다. R1의 자기 신고가 「codex 배너형 + 토큰 한 줄」로
/// 축소돼 있던 자리이기도 하다(크리틱 §4).
#[test]
fn a_half_known_wall_axis_also_stops_at_the_cap() {
    let ping = json!({"type":"stream_event","event":{"type":"ping"}});
    let cli = WcapCli {
        mixed_wall: true, // 첫 표만 꼬리 있음 → 그다음부터 배너형
        pre: vec![ping],  // 화면에 아무것도 안 남기는 프레임 한 장
        ..Default::default()
    };
    let (r, _clock, blind) = run(cli, 1_000 * SEC + 12 * HOUR);
    let h = r.hold().expect("표는 서 있다");
    println!(
        "[WCAP⑧] 반쪽만 아는 벽 + ping {blind}회 · attempts {} · ready {} · auto_paused {}",
        h.attempts, h.ready, h.auto_paused
    );
    assert_eq!(
        blind as u32, MAX_AUTO_ATTEMPTS,
        "★★ 반쪽만 아는 축에서 상한이 지워졌다 — 12시간에 {blind}회(R1 규칙에서 42회)"
    );
    assert!(h.ready && h.auto_paused, "★ 자동을 접고 사용자에게 넘겨야 한다");
    assert_eq!(h.attempts, MAX_AUTO_ATTEMPTS, "계수가 표에 실려 있다");
}

/// ⑨ ★R28d WCAP **R4** — **반쪽만 아는 축에서도 「일한 재개」는 안 잘린다**(⑧의 반대편).
///
/// ⑧과 같은 대본에서 프레임 한 장만 **진짜 산출**로 바꾼다. 여기서 접히면 좁히기가
/// 과했다는 뜻이고, 겨눈 격차(밤샘 주행)가 이 축에서 되살아난다.
#[test]
fn a_half_known_wall_axis_still_clears_on_real_output() {
    let cli = WcapCli {
        mixed_wall: true,
        work: true,        // 어시스턴트 텍스트 한 줄 = 화면에 남는 산출
        work_ms: 50 * MIN, // ★R28e WFIRE — 그리고 **그 턴은 실제로 오래 산다**
        ..Default::default()
    };
    let (r, _clock, blind) = run(cli, 1_000 * SEC + 12 * HOUR);
    let h = r.hold().expect("표는 서 있다");
    println!(
        "[WCAP⑨] 반쪽만 아는 벽 + 진짜 산출 {blind}회 · attempts {} · auto_paused {}",
        h.attempts, h.auto_paused
    );
    assert!(blind as u32 > MAX_AUTO_ATTEMPTS, "★ 일한 재개가 상한에 걸렸다 — {blind}회에서 멎었다");
    assert_eq!(h.attempts, 0, "★ 일한 턴은 계수를 올리지 않는다");
    assert!(!h.auto_paused, "★ 자동이 접혔다");
}

// ── ★R28e WFIRE — 상한의 단위를 바꾼다: 「연속 빈손」 → 「에피소드 예산 + 턴 수명」 ─────
//
// WCAP 확인 크리틱 R2 §5.1의 남은 격차: 구분자 ②가 「화면에 남는 산출 한 줄」이라,
// 리셋 시각을 모르는 축에서는 재개 턴이 **텍스트 한 줄만 내도** `attempts`가 영영 0이 되어
// RCAP의 「자동은 최대 2발」이 통째로 사라졌다. 실측 — 12시간 **71발** · `attempts` 0 ·
// 안 접힘(어시스턴트 텍스트 한 줄 / 도구 하나 열고 결과 없이 죽음 / 한도 문구 자체를
// 텍스트로 받은 턴 전부). 계수가 0이라 지수 백오프(10→20→40분)도 죽어 10분 간격이 밤새 유지된다.
//
// 장치 둘을 **함께** 세운다. 하나만으로는 서로의 사각을 못 덮는다:
//  * **턴 수명**(`MIN_WORK`) — 「30초 만에 같은 벽」과 「창을 꽉 채워 일함」을 가른다.
//    ⑩이 그 자리를 잠그고 ⑪가 반대편(과잉 절단)을 잠근다.
//  * **에피소드 총 발사 예산**(`MAX_EPISODE_FIRES`) — 산출을 흘리며 **천천히** 죽는 턴은
//    수명 문턱을 넘으므로 ①·②로는 절대 안 멎는다. 그 천장이 ⑫이고, 출구가 ⑬다.
//
// 지켜야 할 반대편은 위 ①(창 이동)과 ②⑥⑨(일한 재개)이고, 그 못들은 이 라운드에서
// **접힘/계수 판정이 한 글자도 안 바뀌었다**(발사 수만 수명만큼 성겨졌다).

/// 그 턴이 **산출을 내되 즉사하는** 대본(= 크리틱 §5.1의 Q1·Q2·Q3). 12시간을 돌린다.
fn twelve_hours_instant_output(pre: Vec<Value>, work: bool) -> (usize, u32, bool, bool, u32) {
    let cli = WcapCli { banner: true, work, pre, ..Default::default() };
    let (r, _clock, blind) = run(cli, 1_000 * SEC + 12 * HOUR);
    let h = r.hold().expect("표는 서 있다");
    (blind, h.attempts, h.ready, h.auto_paused, r.episode_fires())
}

/// ⑩ ★R28e WFIRE — **한 줄 내고 즉사하는 턴은 「일했다」가 아니다.**
///
/// 크리틱 §5.1의 표 세 줄(Q1·Q2·Q3)을 그대로 겨눈다. R28d에서는 셋 다 **12시간 71발 ·
/// `attempts` 0 · 안 접힘**이었다. 구분자 ②가 「무엇을 냈나」만 보고 「얼마나 살았나」를
/// 안 봤기 때문이다 — R28d WCAP이 원래 쓰려던 문장(*"30초 만에 같은 벽에 부딪혔는지
/// 5시간을 꽉 채워 일하고 다음 창에서 막혔는지"*)은 **시각을 아는 축에서만** 지켜졌다.
#[test]
fn output_from_a_turn_that_died_at_the_doorstep_does_not_clear_the_streak() {
    let limit_line = |t: &str| {
        json!({"type":"assistant","message":{"role":"assistant","model":"haiku",
            "content":[{"type":"text","text":t}]}})
    };
    let cases: Vec<(&str, Vec<Value>, bool)> = vec![
        // Q2 — 토큰 한 줄(크리틱 표의 첫 줄).
        ("어시스턴트 텍스트 한 줄", vec![], true),
        // Q3 — 도구를 열고 결과 없이 죽는다(⑥의 그 줄과 **같은 프레임**, 수명만 0이다).
        (
            "도구 하나 열고 즉사",
            vec![json!({"type":"assistant","message":{"role":"assistant","model":"haiku",
                "content":[{"type":"tool_use","id":"toolu-2","name":"Read","input":{}}]}})],
            false,
        ),
        // Q1 — **한도 통보문 자체가 화면에 남는 글자**로 온다. 「일했다」가 사용자에게
        //      거짓이 되는 자리다(그 턴이 남긴 유일한 글자가 「한도에 걸렸다」이다).
        ("한도 문구를 어시스턴트 텍스트로", vec![limit_line("5-hour limit reached ∙ resets 3pm")], false),
    ];
    for (label, pre, work) in cases {
        let (blind, attempts, ready, paused, fires) = twelve_hours_instant_output(pre, work);
        println!("[WFIRE⑩ {label}] 12시간 {blind}회 · attempts {attempts} · ready {ready} · auto_paused {paused} · 예산소비 {fires}");
        assert_eq!(
            blind as u32, MAX_AUTO_ATTEMPTS,
            "★★ 「{label}」이 상한을 지웠다 — 12시간에 {blind}회(R28d 실측 71회)"
        );
        assert!(ready && paused, "★ 「{label}」: 자동을 접고 사용자에게 넘겨야 한다");
        assert_eq!(attempts, MAX_AUTO_ATTEMPTS, "「{label}」: 계수가 표에 실려 있다");
    }
}

/// ⑪ ★R28e WFIRE — **반대 방향의 못: 수명 문턱은 「창을 태운 턴」을 안 자른다.**
///
/// ⑩과 **한 글자도 다르지 않은 대본**에 수명만 준다. 여기서 접히면 좁히기가 과했다는
/// 뜻이고, 겨눈 격차(밤샘 주행)가 이 축에서 되살아난다. 경계값(`MIN_WORK` 정각)도 같이
/// 짚는다 — 문턱은 `>=`이므로 정각은 **일한 것**이다.
#[test]
fn a_turn_that_lived_long_enough_still_clears_the_streak() {
    // 창(`until`)은 **예산이 아니라 수명 문턱**을 재도록 잡는다 — 한 바퀴가 `work_ms + 10분`
    // 이므로 발사 수가 `MAX_EPISODE_FIRES`에 닿으면 ⑫을 다시 재는 못이 된다.
    for (label, work_ms, until) in [
        ("MIN_WORK 정각", ccg_engine::limit::MIN_WORK, 2 * HOUR),
        ("넉넉히 50분", 50 * MIN, 4 * HOUR),
    ] {
        let cli = WcapCli { banner: true, work: true, work_ms, ..Default::default() };
        let (r, _clock, blind) = run(cli, 1_000 * SEC + until);
        let h = r.hold().expect("표는 서 있다");
        println!(
            "[WFIRE⑪ {label}] {}시간 {blind}회 · attempts {} · auto_paused {} · 예산소비 {}",
            until / HOUR,
            h.attempts,
            h.auto_paused,
            r.episode_fires()
        );
        assert!(blind as u32 > MAX_AUTO_ATTEMPTS, "★ 「{label}」이 상한에 걸렸다 — {blind}회에서 멎었다");
        assert_eq!(h.attempts, 0, "★ 「{label}」: 충분히 산 턴은 계수를 올리지 않는다");
        assert!(!h.auto_paused, "★ 「{label}」: 자동이 접혔다");
    }
    // 문턱 **아래**는 헛발질이다 — 경계가 실제로 그 자리에 서 있다는 증거.
    //
    // 1초가 아니라 1분을 뺀다: 엔진이 재는 수명은 *발사(`consume_hold`)부터 한도 착지까지*
    // 인데 이 CLI의 `work_ms`는 *첫 폴부터*라, 드레인·스폰 몇 tick만큼 실제 수명이 더 길다
    // (실측: `MIN_WORK - 1초` 대본이 문턱을 **넘어** 12발까지 갔다). 못이 재려는 것은
    // 문턱의 1초 정밀도가 아니라 「짧게 살면 헛발질」이므로 여유를 둔다.
    let cli = WcapCli { banner: true, work: true, work_ms: ccg_engine::limit::MIN_WORK - 60 * SEC, ..Default::default() };
    let (r, _clock, blind) = run(cli, 1_000 * SEC + 4 * HOUR);
    let h = r.hold().expect("표는 서 있다");
    println!("[WFIRE⑪ MIN_WORK-1분] 4시간 {blind}회 · attempts {} · auto_paused {}", h.attempts, h.auto_paused);
    assert_eq!(blind as u32, MAX_AUTO_ATTEMPTS, "★★ 문턱 아래인데 안 접혔다 — {blind}회");
    assert!(h.ready && h.auto_paused, "★ 문턱 아래는 사용자의 버튼 차례");
}

/// ⑫ ★R28e WFIRE — **에피소드 예산이 천장이다: 산출로도, 창 이동으로도 못 지운다.**
///
/// ⑪가 통과시키는 그 대본(수명 ≥ `MIN_WORK` · 매번 산출)을 **그냥 오래** 돌린다.
/// 구분자 ①·②만 있던 판에서는 이 대본이 영원히 안 멎는다(`attempts`가 늘 0이므로
/// 「자동은 최대 2발」이 존재하지 않는다). 예산은 그 무엇도 못 지우므로 정확히
/// `MAX_EPISODE_FIRES`발에서 멎고, 그 뒤로는 며칠을 밀어도 0발이다.
#[test]
fn the_episode_budget_is_a_ceiling_that_output_cannot_erase() {
    let cli = WcapCli { banner: true, work: true, work_ms: 20 * MIN, ..Default::default() };
    // 한 바퀴 = 20분 작업 + 10분 대기 = 30분 → 예산 12발은 6시간이면 다 쓴다(넉넉히 20시간).
    let (mut r, clock, blind) = run(cli, 1_000 * SEC + 20 * HOUR);
    let h = r.hold().expect("표는 서 있다");
    println!(
        "[WFIRE⑫] 20시간 {blind}회 · attempts {} · ready {} · auto_paused {} · 예산소비 {}",
        h.attempts,
        h.ready,
        h.auto_paused,
        r.episode_fires()
    );
    assert_eq!(
        blind as u32, ccg_engine::limit::MAX_EPISODE_FIRES,
        "★★ 예산이 천장이 아니다 — 20시간에 {blind}회"
    );
    assert_eq!(h.attempts, 0, "★ 접은 것은 **연속 계수가 아니라 예산**이다(계수는 끝까지 0)");
    assert!(h.ready && h.auto_paused, "★ 자동을 접고 사용자에게 넘긴다");
    assert_eq!(r.episode_fires(), ccg_engine::limit::MAX_EPISODE_FIRES, "예산이 정확히 소진됐다");

    // 그리고 멈춘 뒤에는 이틀을 더 밀어도 0회다(RCAP의 그 성질 그대로).
    let before = r.driver_ref().turns;
    pump(&mut r, &clock, 1_000 * SEC + 68 * HOUR);
    assert_eq!(r.driver_ref().turns, before, "★ 멈춘 뒤에는 영원히 0회");
}

/// ⑬ ★R28e WFIRE — **막다른 방이 아니다: 사람이 누르면 예산이 통째로 되살아난다.**
///
/// RCAP이 세운 계약 그대로다 — 자동 상한이 세는 것은 **엔진이 쏜 턴**뿐이고, 사용자가
/// 누른 이어가기는 몇 번이든 사용자의 판단이다(`consume_hold(auto=false)`).
/// 예산에 이 출구가 없으면 이 갈래는 상한이 아니라 **기능 정지**가 된다.
#[test]
fn pressing_resume_reopens_the_episode_budget() {
    let cli = WcapCli { banner: true, work: true, work_ms: 20 * MIN, ..Default::default() };
    let (mut r, clock, blind) = run(cli, 1_000 * SEC + 20 * HOUR);
    assert_eq!(blind as u32, ccg_engine::limit::MAX_EPISODE_FIRES, "먼저 예산을 다 쓴다");
    assert!(r.hold().is_some_and(|h| h.ready && h.auto_paused), "접힌 표가 서 있다");

    // 사용자가 [이어가기]를 누른다 — 그 자리에서 한 발 나가고 예산·계수가 0으로 돌아간다.
    let before = r.driver_ref().turns;
    assert_eq!(r.resume_now(), ccg_engine::event::Verdict::Accepted, "★ 접힌 표의 유일한 출구");
    assert_eq!(r.episode_fires(), 0, "★★ 누른 재개는 예산을 세지 않는다");
    pump(&mut r, &clock, 1_000 * SEC + 21 * HOUR);
    let after = r.driver_ref().turns - before;
    println!("[WFIRE⑬] 누른 뒤 1시간 {after}회 · 예산소비 {}", r.episode_fires());
    assert!(after >= 2, "★ 눌렀는데도 멎어 있다 — 버튼이 한 번 쓰고 버리는 것이 됐다({after}회)");
    assert!(
        r.hold().is_some_and(|h| !h.auto_paused),
        "★ 누른 직후의 표가 다시 접혀 있다 — 막다른 방"
    );
}

/// ⑭ ★R28f WFIRE — **예산은 프로세스 재시작을 넘는다.**
///
/// R28e 확인 크리틱 R1 §4.1이 잰 최대 격차: `ReloadHold`에 `attempts`도 `fires`도 없어서
/// [`ChatRuntime::reload_state`]가 둘 다 0을 놓았다. 「아무 구분자도 못 지우는 총계」라고
/// 적어 둔 값이 **프로세스 경계 하나에** 통째로 지워진다면 그건 예산이 아니라 *재시작
/// 버튼 하나짜리 무제한*이다(크리틱 실측: 재장전 뒤 20시간 **12발 재충전**).
///
/// **대조군이 이 못 안에 있다.** 같은 바이너리·같은 대본·같은 재장전 경로에서
/// `fires` 한 칸만 0으로 두면(= R28e의 동작) 12발이 그대로 재충전된다. 즉 아래 두
/// `assert`는 「고쳐졌나」와 「그 칸이 정말 원인이었나」를 함께 잰다.
#[test]
fn the_episode_budget_survives_a_restart() {
    // ① 예산을 다 쓴 상태를 만든다(⑫와 한 글자도 다르지 않은 대본).
    let cli = WcapCli { banner: true, work: true, work_ms: 20 * MIN, ..Default::default() };
    let (r0, _c0, blind0) = run(cli, 1_000 * SEC + 20 * HOUR);
    assert_eq!(blind0 as u32, ccg_engine::limit::MAX_EPISODE_FIRES, "먼저 예산을 다 쓴다");
    let saved = r0.hold().cloned().expect("접힌 표가 서 있다");
    let saved_fires = r0.episode_fires();
    assert!(saved.auto_paused, "그 표는 접혀 있다");

    // ② 앱을 껐다 켠다 — 셸이 디스크(`hub::persist_hold` → `status::HoldLite`)에서 읽어
    //    온 두 칸을 그대로 실어 재장전한다. 새 런타임 · 새 시계 = 새 프로세스.
    let fresh = |fires: u32| {
        let clock = clock_at(5 * 3600);
        let cli = WcapCli { banner: true, work: true, work_ms: 20 * MIN, ..Default::default() };
        let mut r = rt(clock.clone(), cli);
        r.reload_state(
            vec![],
            Some(ReloadHold { in_ms: Some(60 * SEC), ready: false, attempts: saved.attempts, fires }),
        );
        pump(&mut r, &clock, 1_000 * SEC + 20 * HOUR);
        (r.driver_ref().turns as usize, r.episode_fires(), r.hold().is_some_and(|h| h.auto_paused))
    };

    let (kept, kept_fires, kept_paused) = fresh(saved_fires);
    let (lost, lost_fires, _) = fresh(0); // ← R28e의 동작(그 칸이 없던 판)
    println!(
        "[WFIRE⑭] 재장전 뒤 20시간 — 예산 물려받음 {kept}발(잔여예산 {kept_fires} · 접힘 {kept_paused})  vs  0으로 재장전 {lost}발(잔여예산 {lost_fires})"
    );
    assert_eq!(kept, 0, "★★ 재시작이 예산을 재충전했다 — 20시간에 {kept}발");
    assert!(kept_paused, "★ 재장전 직후의 판정도 「예산 소진」이어야 한다(버튼이 유일한 출구)");
    assert_eq!(
        lost as u32,
        ccg_engine::limit::MAX_EPISODE_FIRES,
        "★ 대조군이 재충전을 재현하지 못했다 — 이 못은 아무것도 안 재고 있다"
    );
}

/// ⑮ ★R28f WFIRE — **「밤샘은 안 잘린다」의 유효 범위는 약 60시간이다.**
///
/// R28e 확인 크리틱 R1 §4.2: 실전 눈금(5시간 창 · 4시간 30분 작업) 120시간 대본이
/// **12발에서 접힌다**. 그러니 불변식의 참인 문장은 「안 잘린다」가 아니라
/// **「약 60시간까지는 안 잘린다」**이고, 문서·주석이 그렇게 적어야 한다
/// ([`ccg_engine::limit::MAX_EPISODE_FIRES`]).
///
/// 이 못이 지키는 것은 **범위의 양 끝**이다: 하룻밤은 한 발도 안 깎이고(①이 7발로 잠근다)
/// 이틀 반 근처에서 접히되 막다른 방이 아니다(⑬의 버튼).
#[test]
fn the_night_run_invariant_is_good_for_about_sixty_hours() {
    let cli = WcapCli {
        banner: true,
        work: true,
        work_ms: 4 * HOUR + 30 * MIN, // 5시간 창을 거의 꽉 채워 일하는 턴
        ..Default::default()
    };
    let clock = clock_at(5 * 3600);
    let mut r = rt(clock.clone(), cli);
    r.dispatch(Cmd::Send { text: "첫 턴".into() });
    // 80시간 안에 접혀야 한다(60시간 언저리를 기대한다 — 안 접히면 그대로 실패).
    let cap = clock.now_ms() + 80 * HOUR;
    while clock.now_ms() < cap && !r.hold().is_some_and(|h| h.auto_paused) {
        clock.advance_by(SEC);
        r.tick();
    }
    let folded_h = (clock.now_ms() - 1_000 * SEC) / HOUR;
    let h = r.hold().expect("표는 서 있다");
    println!(
        "[WFIRE⑮] 5시간 창 · 4.5시간 작업 — {folded_h}시간에 접힘 · 발사 {} · attempts {} · auto_paused {}",
        r.driver_ref().turns - 1,
        h.attempts,
        h.auto_paused
    );
    assert!(h.auto_paused, "★ 80시간을 밀어도 안 접혔다 — 예산이 천장이 아니다");
    assert_eq!(h.attempts, 0, "★ 접은 것은 연속 계수가 아니라 예산이다(그 턴들은 일했다)");
    assert!(
        (48..=72).contains(&folded_h),
        "★★ 유효 범위가 「약 60시간」이 아니다 — {folded_h}시간에 접혔다(문서 문장을 고쳐야 한다)"
    );
}

/// ⑯ ★R28f WFIRE — **연속 헛발질 계수도 재시작을 넘는다**(⑭의 다른 축).
///
/// 예산이 「천천히 죽는 축」의 천장이라면 [`MAX_AUTO_ATTEMPTS`]는 「즉사 축」의 천장이다.
/// R28e 확인 크리틱 R1 §4.1이 **재시작 1회의 실손해를 +2발**로 잰 자리가 정확히 여기다 —
/// 그 값은 R28d의 `ReloadHold`가 이미 `attempts: 0`으로 놓고 있었으므로 회귀는 아니었지만,
/// 렌더러(`sanitizeHold`)가 R28c부터 이 값을 살려 복원하고 있었으니 **두 축의 규칙이
/// 갈린 자리**였다. 이제 같다.
#[test]
fn the_blind_shot_cap_also_survives_a_restart() {
    // 문전박대 축 — 산출도 수명도 없다(⑩·③의 그 대본).
    let cli = WcapCli { banner: true, ..Default::default() };
    let (r0, _c0, blind0) = run(cli, 1_000 * SEC + 12 * HOUR);
    assert_eq!(blind0 as u32, MAX_AUTO_ATTEMPTS, "먼저 상한까지 쏜다");
    let saved = r0.hold().cloned().expect("접힌 표가 서 있다");
    assert_eq!(saved.attempts, MAX_AUTO_ATTEMPTS, "계수가 상한이다");

    let fresh = |attempts: u32, fires: u32| {
        let clock = clock_at(5 * 3600);
        let mut r = rt(clock.clone(), WcapCli { banner: true, ..Default::default() });
        r.reload_state(vec![], Some(ReloadHold { in_ms: Some(60 * SEC), ready: false, attempts, fires }));
        pump(&mut r, &clock, 1_000 * SEC + 12 * HOUR);
        r.driver_ref().turns as usize
    };
    let kept = fresh(saved.attempts, r0.episode_fires());
    let lost = fresh(0, 0); // ← R28e의 동작
    println!("[WFIRE⑯] 재장전 뒤 12시간 — 계수 물려받음 {kept}발  vs  0으로 재장전 {lost}발(= 크리틱이 잰 +2발)");
    assert_eq!(kept, 0, "★★ 재시작이 「눈감고 두 발」을 공짜로 만들었다");
    assert_eq!(lost as u32, MAX_AUTO_ATTEMPTS, "★ 대조군이 +2발을 재현하지 못했다");
}
