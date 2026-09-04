//! R14 크리틱 F2의 회귀 잠금 — **엔진이 유일한 재개 주체가 된 뒤**(배선 R4 §R4.4 ·
//! 렌더러 R3 ⑦) 한도 대기표의 두 갈래를 잰다.
//!
//! 크리틱 원본(워크트리 `%TEMP%/ccg-r14-wt/crates/ccg-engine/tests/r14_limit_loop.rs`)은
//! **결함을 문서화하는 방향**으로 단언이 걸려 있었다:
//!
//! ```text
//! ① the_engine_ignores_the_reset_epoch_in_the_error_text
//!      assert!(!used_tail)   ← "꼬리를 안 쓴다"가 통과 조건(발견의 근거)
//! ② a_still_blocked_resume_loops_every_six_and_a_half_minutes
//!      assert!(spawns1 <= spawns0)  → 붉음: "★ 재개 발화가 반복됐다 — 30분에 4회"
//! ```
//!
//! ①은 고치면 **깨져야 맞는** 단언이라 방향을 뒤집었고(꼬리를 쓴다), ②는 그대로 두었다
//! (붉음 → 수정 → 초록). 나머지는 이 라운드가 더한 잠금이다: 시각 미상 갈래의 상한,
//! F1×F2 조합, 사용자 손의 출구, 재검증 훅 계약.
use ccg_engine::clock::{Clock, Millis, VirtualClock, HOUR, MIN, SEC};
use ccg_engine::driver::{CliDriver, SpawnSpec};
use ccg_engine::identity::*;
use ccg_engine::limit::{LimitProbe, LimitVerdict, MAX_AUTO_ATTEMPTS, PROBE};
use ccg_engine::runtime::{ChatRuntime, Cmd};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

/// 문구 꼬리에 실려 오는 실전 리셋 시각(2.6.2 코퍼스 A절의 그 값).
const RESET: u64 = 1_755_150_000;

/// 스폰할 때마다 "한도 에러 result"를 즉시 돌려주는 CLI — 실제 한도 상황과 같다.
#[derive(Default)]
struct LimitedCli {
    alive: bool,
    spawns: usize,
    pending: Vec<Value>,
    err_text: String,
}
impl CliDriver for LimitedCli {
    fn spawn(&mut self, _spec: &SpawnSpec) -> std::io::Result<()> {
        self.spawns += 1;
        self.alive = true;
        self.pending.push(json!({"type":"system","subtype":"init","session_id":"S1","model":"haiku"}));
        Ok(())
    }
    fn send(&mut self, _line: Value) {
        // 프롬프트가 들어가면 CLI가 곧바로 한도 에러 result를 낸다.
        self.pending.push(json!({
            "type":"result","subtype":"error_during_execution","is_error":true,
            "result": self.err_text.clone()
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

fn rt(clock: Arc<VirtualClock>, err: &str) -> ChatRuntime<LimitedCli> {
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
    let mut cli = LimitedCli::default();
    cli.err_text = err.to_string();
    ChatRuntime::new("c-1", raw, defaults, clock, cli).expect("정규화")
}

/// 가상 t=1000s의 벽시계를 "리셋 `ahead`초 전"에 놓는다. 이게 없으면 재생은 1970년에
/// 살고, 2025년 epoch은 전부 "아주 먼 미래"로 접혀 무엇을 쟀는지 알 수 없다.
fn clock_at(ahead: u64) -> Arc<VirtualClock> {
    let clock = VirtualClock::new();
    clock.advance_to(1_000 * SEC);
    clock.set_epoch_base((RESET - ahead) * 1_000 - 1_000 * SEC);
    clock
}

fn pump(r: &mut ChatRuntime<LimitedCli>, clock: &Arc<VirtualClock>, until: Millis) {
    while clock.now_ms() < until {
        clock.advance_by(SEC);
        r.tick();
    }
}

/// ① 방향을 뒤집은 크리틱 테스트 — 에러 원문 꼬리(`…|1755150000`)를 **읽는다**.
#[test]
fn the_engine_reads_the_reset_epoch_in_the_error_text() {
    let clock = clock_at(5 * 3600); // 리셋은 지금부터 5시간 뒤
    let mut r = rt(clock.clone(), "Claude AI usage limit reached|1755150000");
    r.dispatch(Cmd::Send { text: "첫 턴".into() });
    pump(&mut r, &clock, 1_030 * SEC);

    let h = r.hold().expect("한도 대기표가 걸려야 한다");
    println!(
        "hold.resets_at = {:?} · due_at = {:?} · now = {}",
        h.resets_at,
        h.due_at(),
        clock.now_ms()
    );
    // 벽시계 t=1000s가 "리셋 5시간 전"이므로 리셋의 런타임 좌표는 정확히 이 값이다.
    // (장전이 1초 늦게 일어나도 **절대 시각**이라 흔들리지 않는 것이 이 변환의 요점이다.)
    let reset_here = 1_000 * SEC + 5 * HOUR;
    assert_eq!(
        h.resets_at,
        Some(reset_here),
        "★ 꼬리의 시각이 그대로 대기표에 앉아야 한다(옛 판은 '장전 + 5분'이었다)"
    );
    assert_eq!(h.due_at(), Some(reset_here + 90 * SEC), "재검증은 리셋 + 90초");
    assert_eq!(h.attempts, 0, "사용자 턴이 죽어서 처음 걸린 표");
}

/// ② 크리틱 테스트 원문 그대로 — 30분에 4회였던 헛 재개가 **0회**여야 한다.
#[test]
fn a_still_blocked_resume_loops_every_six_and_a_half_minutes() {
    let clock = clock_at(5 * 3600);
    let mut r = rt(clock.clone(), "Claude AI usage limit reached|1755150000");
    r.dispatch(Cmd::Send { text: "첫 턴".into() });
    pump(&mut r, &clock, 1_030 * SEC);
    assert!(r.hold().is_some());
    let spawns0 = r.driver_ref().spawns;

    // 한도는 아직 안 풀렸다(CLI가 계속 같은 에러를 낸다). 30분 흘린다.
    pump(&mut r, &clock, 1_030 * SEC + 30 * MIN);
    let spawns1 = r.driver_ref().spawns;
    let texts = r.sent_user_texts();
    println!(
        "30분 동안 spawns {spawns0} → {spawns1} · 보낸 사용자 텍스트 {}건: {:?}",
        texts.len(),
        texts
    );
    assert!(
        spawns1 <= spawns0,
        "★ 재개 발화가 반복됐다 — 30분에 {}회",
        spawns1 - spawns0
    );
    assert_eq!(texts, vec!["첫 턴"], "★ 「이어서 진행해 주세요」가 한 줄도 쌓이면 안 된다");
}

/// 시각 미상 갈래 — 배너형 문구에는 읽을 꼬리가 없다. 눈감고 쏘는 재개는 상한까지만
/// 나가고, 그 뒤로는 **몇 시간을 밀어도 늘지 않는다**.
#[test]
fn a_hold_without_a_reset_time_stops_blind_firing_at_the_cap() {
    let clock = clock_at(5 * 3600);
    let mut r = rt(clock.clone(), "5-hour limit reached");
    r.dispatch(Cmd::Send { text: "첫 턴".into() });
    pump(&mut r, &clock, 1_030 * SEC);
    let h = r.hold().expect("장전");
    assert_eq!(h.resets_at, None, "★ 미상은 미상으로 둔다(옛 판은 now+5분으로 덮어썼다)");
    assert_eq!(h.due_at(), Some(h.armed_at + PROBE), "2.6.2 PROBE_MS = 10분");
    let spawns0 = r.driver_ref().spawns;

    pump(&mut r, &clock, 1_030 * SEC + 5 * HOUR);
    let blind = r.driver_ref().spawns - spawns0;
    let h = r.hold().expect("표는 남는다");
    println!(
        "5시간 동안 눈감고 쏜 재개 {blind}회 · hold{{ready:{}, auto_paused:{}, attempts:{}}}",
        h.ready, h.auto_paused, h.attempts
    );
    assert_eq!(blind as u32, MAX_AUTO_ATTEMPTS, "★ 상한만큼만(옛 판은 5시간에 ~46회)");
    assert!(h.ready && h.auto_paused, "★ 자동은 멈추고 사용자에게 넘긴다");

    // 다시 5시간 — 0회. 상한은 시간이 지나도 풀리지 않는다.
    let before = r.driver_ref().spawns;
    pump(&mut r, &clock, 1_030 * SEC + 10 * HOUR);
    assert_eq!(r.driver_ref().spawns, before, "★ 멈춘 뒤에는 영원히 0회");
}

/// 상한에 걸려 멈춘 표의 **출구는 사용자**다 — 누르면 그 자리에서 한 번 나간다.
#[test]
fn the_user_can_still_press_resume_after_the_cap() {
    let clock = clock_at(5 * 3600);
    let mut r = rt(clock.clone(), "Weekly limit reached · resets Aug 20");
    r.dispatch(Cmd::Send { text: "첫 턴".into() });
    pump(&mut r, &clock, 1_030 * SEC + 5 * HOUR);
    assert!(r.hold().is_some_and(|h| h.auto_paused));
    let spawns0 = r.driver_ref().spawns;

    assert_eq!(r.resume_now(), ccg_engine::event::Verdict::Accepted);
    pump(&mut r, &clock, clock.now_ms() + 30 * SEC);
    assert_eq!(r.driver_ref().spawns, spawns0 + 1, "누른 만큼 정확히 한 번");
    assert!(
        r.sent_user_texts().contains(&"이어서 진행해 주세요".to_string()),
        "재개 프롬프트가 나간다: {:?}",
        r.sent_user_texts()
    );
}

/// **F1 × F2 조합** — 컨텍스트 초과는 리셋으로 풀리지 않는다. 장전 자체가 없어야 하고,
/// 그러면 30분이든 5시간이든 재전송이 0이다(옛 판은 영원히 6.5분마다 재전송했다).
#[test]
fn a_context_overflow_error_never_arms_a_hold() {
    for err in [
        "context limit reached: conversation too long",
        "output token limit exceeded",
        "rate limited; retry shortly",
    ] {
        let clock = clock_at(5 * 3600);
        let mut r = rt(clock.clone(), err);
        r.dispatch(Cmd::Send { text: "첫 턴".into() });
        pump(&mut r, &clock, 1_030 * SEC);
        assert!(r.hold().is_none(), "{err:?}에 대기표가 걸렸다");
        let spawns0 = r.driver_ref().spawns;
        pump(&mut r, &clock, 1_030 * SEC + 30 * MIN);
        assert_eq!(r.driver_ref().spawns, spawns0, "{err:?} — 30분 재전송 0회");
        assert_eq!(r.sent_user_texts(), vec!["첫 턴"], "{err:?}");
    }
}

// ── 재검증 훅 계약 ───────────────────────────────────────────────────────────

/// 몇 번 물었는지 세면서 대본대로 답하는 훅.
struct ScriptedProbe {
    asked: AtomicUsize,
    /// `asked`가 이 수에 닿기 전까지는 "아직 막혔다"고 답한다.
    blocked_until_call: usize,
    resets_at: Option<u64>,
}
impl LimitProbe for ScriptedProbe {
    fn blocked_until(&self, _a: &BillingAxis, _now_epoch_ms: u64) -> LimitVerdict {
        let n = self.asked.fetch_add(1, Ordering::SeqCst);
        if n < self.blocked_until_call {
            LimitVerdict::Blocked { resets_at: self.resets_at }
        } else {
            LimitVerdict::Clear
        }
    }
}

/// 2.6.2 `fire()` 규약: 발화 **직전** 신선 usage로 다시 묻고, 아직 막혔으면 **재장전만**
/// 한다(CLI를 안 띄운다). 풀렸다고 답한 그 회차에 딱 한 번 나간다.
#[test]
fn the_probe_rearms_instead_of_firing_while_still_blocked() {
    let clock = clock_at(5 * 3600);
    let probe = Arc::new(ScriptedProbe {
        asked: AtomicUsize::new(0),
        blocked_until_call: 2, // 두 번은 "아직", 세 번째에 "풀렸다"
        resets_at: None,
    });
    let mut r = rt(clock.clone(), "5-hour limit reached").with_limit_probe(probe.clone());
    r.dispatch(Cmd::Send { text: "첫 턴".into() });
    pump(&mut r, &clock, 1_030 * SEC);
    let spawns0 = r.driver_ref().spawns;

    // 프로브 두 번(=재장전 두 번)은 CLI를 안 띄운다.
    pump(&mut r, &clock, 1_030 * SEC + 25 * MIN);
    assert_eq!(probe.asked.load(Ordering::SeqCst), 2, "10분 간격으로 두 번 물었다");
    assert_eq!(r.driver_ref().spawns, spawns0, "★ 재장전은 전송이 아니다");
    assert!(r.hold().is_some_and(|h| !h.ready && h.attempts == 0), "헛 재개로 세지 않는다");

    // 세 번째 물음에서 풀렸다 → 그때 한 번 나간다.
    pump(&mut r, &clock, 1_030 * SEC + 40 * MIN);
    assert_eq!(r.driver_ref().spawns, spawns0 + 1, "★ 풀린 뒤 정확히 한 번");
}

// ── ★T3T4 R3 — 「못 물어봤다 ≠ 풀렸다」(R28 확인 크리틱 R2의 최대 격차) ────────

/// 언제나 "물어봤는데 못 얻었다"고 답하는 훅 = 셸의 `CCG_NO_NET` 판.
struct BlindProbe {
    asked: AtomicUsize,
}
impl LimitProbe for BlindProbe {
    fn blocked_until(&self, _a: &BillingAxis, _now: u64) -> LimitVerdict {
        self.asked.fetch_add(1, Ordering::SeqCst);
        LimitVerdict::Unavailable
    }
}

/// **크리틱의 통과 조건 그 자체**: 리셋 시각이 지난 대기표 + 조회 불가 = **전송 0**.
///
/// R2까지 이 판은 `LimitVerdict::Unknown`("풀린 것으로 두고 진행")으로 접혀 리셋 시각
/// 90초 뒤에 곧바로 CLI를 태웠다. 렌더러는 같은 사고를 이미 고쳤지만
/// (`limitResume.ts` `resumeVerdict`), 본채팅은 `resumeOwner:"engine"`이라 그 수정의
/// 바깥에 있었다 — 여기가 그 바깥을 안으로 들이는 자리다.
#[test]
fn a_probe_that_cannot_ask_never_fires_and_hands_the_turn_to_the_user() {
    let clock = clock_at(5 * 3600);
    let probe = Arc::new(BlindProbe { asked: AtomicUsize::new(0) });
    let mut r = rt(clock.clone(), "Claude AI usage limit reached|1755150000").with_limit_probe(probe.clone());
    r.dispatch(Cmd::Send { text: "첫 턴".into() });
    pump(&mut r, &clock, 1_030 * SEC);
    let spawns0 = r.driver_ref().spawns;
    assert!(r.hold().is_some_and(|h| h.probes == 0), "장전 직후는 「안 물어본」 표다");

    // ① 리셋 시각을 90초 지나도(=옛 판이 쐈던 그 순간) 아무것도 안 나간다.
    pump(&mut r, &clock, 1_030 * SEC + 5 * HOUR + 5 * MIN);
    let h = r.hold().expect("★ 표가 사라졌다 = 소진했다 = 전송했다");
    println!("[T3T4] 리셋 +5분 · probes={} ready={} spawns={}", h.probes, h.ready, r.driver_ref().spawns);
    assert_eq!(r.driver_ref().spawns, spawns0, "★★ 조회 불가인데 전송했다");
    assert!(!h.ready, "못 물어봤는데 「풀렸다」로 켰다");
    assert!(h.probes >= 2, "재확인이 안 돌았다: probes={}", h.probes);
    assert!(probe.asked.load(Ordering::SeqCst) >= 2, "훅을 다시 안 물었다");

    // ② 재확인 간격은 15초부터 배로 — 매 tick 조회를 때리지 않는다(465초에 6회가 상한).
    let asked = probe.asked.load(Ordering::SeqCst);
    assert!(asked <= 6, "5분 동안 {asked}번 물었다 = tick마다 조회한다");

    // ③ 계속 실패하면 **자동을 접고 사용자에게 넘긴다**(눈감고 쏘지 않는다).
    pump(&mut r, &clock, 1_030 * SEC + 5 * HOUR + 15 * MIN);
    let h = r.hold().expect("표는 남아 있어야 한다 — 버튼의 근거다");
    println!("[T3T4] 리셋 +15분 · probes={} ready={} auto_paused={}", h.probes, h.ready, h.auto_paused);
    assert_eq!(r.driver_ref().spawns, spawns0, "★★ 손을 들면서 한 발 쐈다");
    assert!(h.ready && h.auto_paused, "「눌러서 이어가기」 착지가 아니다");

    // ④ 사용자가 누르면 그때 정확히 한 번 나간다(출구가 막히면 그건 침묵이다).
    assert_eq!(r.resume_now(), ccg_engine::event::Verdict::Accepted);
    pump(&mut r, &clock, clock.now_ms() + 30 * SEC);
    assert_eq!(r.driver_ref().spawns, spawns0 + 1, "누른 만큼 정확히 한 번");
}

/// 조회가 **돌아오면** 그 답이 이긴다 — 실패는 유예지 영구 정지가 아니다.
#[test]
fn a_recovered_probe_resumes_on_the_first_answer_it_gets() {
    /// 앞 두 번은 조회 실패, 그 뒤로는 "풀렸다".
    struct FlakyProbe {
        asked: AtomicUsize,
    }
    impl LimitProbe for FlakyProbe {
        fn blocked_until(&self, _a: &BillingAxis, _now: u64) -> LimitVerdict {
            if self.asked.fetch_add(1, Ordering::SeqCst) < 2 {
                LimitVerdict::Unavailable
            } else {
                LimitVerdict::Clear
            }
        }
    }
    let clock = clock_at(5 * 3600);
    let probe = Arc::new(FlakyProbe { asked: AtomicUsize::new(0) });
    let mut r = rt(clock.clone(), "Claude AI usage limit reached|1755150000").with_limit_probe(probe.clone());
    r.dispatch(Cmd::Send { text: "첫 턴".into() });
    pump(&mut r, &clock, 1_030 * SEC);
    let spawns0 = r.driver_ref().spawns;

    // 리셋 직후 두 번은 못 물어봐서 유지, 세 번째(=45초 뒤)에 풀렸다고 답한다.
    pump(&mut r, &clock, 1_030 * SEC + 5 * HOUR + 2 * MIN);
    println!("[T3T4] 회복 · asked={} spawns={}", probe.asked.load(Ordering::SeqCst), r.driver_ref().spawns);
    // 이 픽스처의 CLI는 뜨는 족족 또 한도 에러를 내므로 재개 턴도 죽고 표가 다시 선다 —
    // 재는 것은 "쐈는가"이지 "몇 개 살아남았는가"가 아니다.
    assert!(r.driver_ref().spawns > spawns0, "★ 답이 오면 그 회차에 나간다");
    assert!(probe.asked.load(Ordering::SeqCst) >= 3, "실패 두 번 뒤 세 번째를 안 물었다");
}

/// 훅 **미배선**(`Unknown`)은 옛 계약 그대로다 — 재생 97개 시나리오가 서 있는 자리라
/// 이 라운드가 그 바닥을 흔들면 안 된다.
#[test]
fn an_unwired_probe_keeps_the_old_contract() {
    let clock = clock_at(5 * 3600);
    let mut r = rt(clock.clone(), "Claude AI usage limit reached|1755150000");
    r.dispatch(Cmd::Send { text: "첫 턴".into() });
    pump(&mut r, &clock, 1_030 * SEC);
    let spawns0 = r.driver_ref().spawns;
    pump(&mut r, &clock, 1_030 * SEC + 5 * HOUR + 5 * MIN);
    assert!(r.driver_ref().spawns > spawns0, "미배선 판은 리셋 시각에 그대로 쏜다");
    assert!(r.hold().is_some_and(|h| h.probes == 0), "미배선인데 재확인 계수가 올랐다");
    // 그리고 상한은 여전히 `attempts` 쪽이 지킨다(재생 시나리오가 서 있는 그 문).
    assert!(r.hold().is_some_and(|h| h.attempts <= MAX_AUTO_ATTEMPTS));
}

// ── ★CRIT R1 — 엔진 축 + 시각 미상 표의 출구(T3T4 확인 크리틱 R3 §3·§3.4) ──────

/// Codex 정체성의 런타임. 과금 축은 **여전히 클로드 계정**이다 — 회귀의 뿌리가 거기다
/// (`arm_hold`가 `identity.billing()`을 표에 싣고, 그것만으로는 어느 서비스의 한도인지 모른다).
fn rt_codex(clock: Arc<VirtualClock>, err: &str) -> ChatRuntime<LimitedCli> {
    let raw = RawIdentity {
        engine: RawEngine {
            kind: EngineKind::Codex,
            model: "gpt-5.6-codex".into(),
            effort: EffortId::Medium,
            codex_account: Some("cx@openai.com".into()),
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
    let mut cli = LimitedCli::default();
    cli.err_text = err.to_string();
    ChatRuntime::new("c-codex", raw, defaults, clock, cli).expect("정규화")
}

/// 훅이 **무엇을 물어봤는지** 그대로 적어 두는 훅.
struct AxisProbe {
    seen: std::sync::Mutex<Vec<(EngineKind, Option<String>, String)>>,
}
impl LimitProbe for AxisProbe {
    fn blocked_until(&self, _a: &BillingAxis, _now: u64) -> LimitVerdict {
        // 축을 아는 메서드가 먼저 불려야 한다. 여기로 떨어졌다면 그것이 곧 회귀다.
        self.seen.lock().unwrap().push((EngineKind::Claude, None, "<축 없음>".into()));
        LimitVerdict::Unknown
    }
    fn probe(&self, q: &ccg_engine::limit::ProbeQuery<'_>) -> LimitVerdict {
        self.seen
            .lock()
            .unwrap()
            .push((q.engine, q.codex_account.map(str::to_string), q.model.to_string()));
        LimitVerdict::Unknown
    }
}

/// ★ **재검증은 「어느 엔진의 한도인가」를 훅에 넘긴다.**
///
/// R3까지 엔진은 표가 든 과금 축(=클로드 계정)과 모델만 넘겼다. 그래서 셸의 훅은 Codex
/// 채팅을 **클로드 주간 창**으로 판정했고, 크리틱 실측에서 그 채팅이 50시간 잠겼다
/// (사용자가 직접 보낸 메시지까지 큐에 주차 — 최대 7일).
#[test]
fn the_probe_is_told_which_engine_the_limit_belongs_to() {
    let clock = clock_at(5 * 3600);
    let probe = Arc::new(AxisProbe { seen: std::sync::Mutex::new(vec![]) });
    let mut r = rt_codex(clock.clone(), "usage limit reached|1755150000").with_limit_probe(probe.clone());
    r.dispatch(Cmd::Send { text: "첫 턴".into() });
    pump(&mut r, &clock, 1_030 * SEC);
    let spawns0 = r.driver_ref().spawns;

    pump(&mut r, &clock, 1_030 * SEC + 5 * HOUR + 5 * MIN);
    let seen = probe.seen.lock().unwrap().clone();
    println!("[CRIT] 훅이 받은 질문 = {seen:?}");
    assert!(!seen.is_empty(), "재검증이 아예 안 돌았다");
    assert_eq!(seen[0].0, EngineKind::Codex, "★ Codex 채팅인데 훅에 그 사실이 안 갔다");
    assert_eq!(seen[0].1.as_deref(), Some("cx@openai.com"), "★ 물어볼 codex 계정이 안 갔다");
    assert_eq!(seen[0].2, "gpt-5.6-codex", "모델도 함께 간다(Fable 창 게이트의 재료)");
    // `Unknown`(= 판정하지 않음)은 옛 계약 그대로 발사다 — Codex 채팅이 잠기지 않는다.
    assert!(r.driver_ref().spawns > spawns0, "★ 판정할 수 없는 판에서 Codex 채팅이 잠겼다");
}

/// ★ **리셋 시각을 모르는 표에도 출구가 있다**(확인 크리틱 R3 §3.4).
///
/// R3의 조건은 `probes < MAX_BLIND_PROBES || !past`였고 `past`는 `resets_at`이 있을 때만
/// 참이 될 수 있었다. 즉 꼬리(`…|epoch`) 없는 문구로 걸린 표는 **영원히** 재확인만 하고,
/// 그동안 `hold_gate_open()`이 닫혀 있어 사용자가 직접 보낸 메시지도 큐에 선다.
/// 「기다릴 근거를 모른다」는 「영원히 기다려라」가 아니다.
#[test]
fn a_ticket_with_no_known_reset_time_still_reaches_the_users_hand() {
    let clock = clock_at(5 * 3600);
    let probe = Arc::new(BlindProbe { asked: AtomicUsize::new(0) });
    // 꼬리 없는 배너형 문구 — `resets_at`이 `None`인 표가 선다.
    let mut r = rt(clock.clone(), "Weekly limit reached").with_limit_probe(probe.clone());
    r.dispatch(Cmd::Send { text: "첫 턴".into() });
    pump(&mut r, &clock, 1_030 * SEC);
    let spawns0 = r.driver_ref().spawns;
    assert!(r.hold().is_some_and(|h| h.resets_at.is_none()), "전제: 시각 미상 표");

    // 첫 재확인은 10분 뒤(PROBE), 그 뒤로는 15·30·60·120·240초 사다리다.
    pump(&mut r, &clock, 1_030 * SEC + 30 * MIN);
    let h = r.hold().expect("표가 사라졌다 = 전송했다");
    println!("[CRIT] 30분 · probes={} ready={} auto_paused={} spawns={}", h.probes, h.ready, h.auto_paused, r.driver_ref().spawns);
    assert_eq!(r.driver_ref().spawns, spawns0, "★ 조회 불가인데 눈감고 쐈다");
    assert!(h.ready && h.auto_paused, "★ 시각 미상 표가 영영 사용자에게 안 넘어온다(§3.4)");

    // 그리고 그 손이 실제로 문을 연다 — 누르면 정확히 한 번 나간다.
    assert_eq!(r.resume_now(), ccg_engine::event::Verdict::Accepted);
    pump(&mut r, &clock, clock.now_ms() + 30 * SEC);
    assert_eq!(r.driver_ref().spawns, spawns0 + 1, "누른 만큼 정확히 한 번");
}
