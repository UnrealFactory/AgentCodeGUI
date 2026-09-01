//! SLUG R1 확인 크리틱 — **새 의미론 공격**(엔진 크레이트 · 격리 사본에서만 돈다).
//!
//! 빌더의 못은 「리졸버가 답한 것 하나가 나간다 · 스폰마다 부른다 · 실패는 정착한다 ·
//! 폴백은 실계정을 흉내 내지 않는다」 넷이다. 여기서는 그 넷이 **닿지 않는 자리**를 판다:
//!
//!  A1 busy 중(첫 턴이 도는 중) 예약분이 실패 계정이면 어떻게 되는가
//!  A2 실패가 연달아 세 번이면 — 사유가 매번 나가는가, 큐가 굳는가
//!  A3 리졸버는 **스폰마다** 불리는가(같은 이메일 반복 — 메모이제이션 회피 탐지)
//!  A4 M11 자동 전환 직후 스폰이 **새 계정**으로 리졸버를 부르는가 ·
//!     전환 대상의 리졸버가 실패하면 사유가 나가는가
//!  A5 1순위 override가 리졸버를 이기고 **이메일을 무시**한다(다계정에서 위험)
//!  A6 폴백 표식이 `_no-resolver` 층을 탈출할 수 있는가(경로 구분자 품은 이메일)
//!  A7 API 키 축은 계정 실패와 무관한가
//!
//! 이 파일은 제품을 수정하지 않는다 — 공개 API만 쓴다.
use ccg_engine::clock::{Millis, VirtualClock};
use ccg_engine::driver::{CliDriver, SpawnSpec};
use ccg_engine::event::Event;
use ccg_engine::identity::*;
use ccg_engine::limit::{AccountSwitcher, SwitchPick, SwitchRequest};
use ccg_engine::live::CloseCause;
use ccg_engine::queue::QueueInput;
use ccg_engine::runtime::{ChatRuntime, Cmd};
use ccg_engine::state::StateTag;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

// ── 계기 ────────────────────────────────────────────────────────────────────

/// 스폰 인자를 통째로 적어 두는 드라이버. 한도 에러를 대본으로 낼 수 있다.
#[derive(Default)]
struct SpyCli {
    alive: bool,
    specs: Vec<SpawnSpec>,
    pending: Vec<Value>,
    eof: Option<CloseCause>,
    /// 이 계정(=`CLAUDE_CONFIG_DIR` 꼬리)으로 뜨면 한도 에러를 낸다.
    limited: BTreeSet<String>,
    last_tail: String,
    /// 프롬프트를 받으면 곧바로 `result`를 낼까. `false`면 턴이 **열린 채로** 머문다
    /// (busy 중을 만드는 유일한 방법 — A1이 그 자리를 판다).
    auto_result: bool,
}
fn tail(spec: &SpawnSpec) -> String {
    spec.env_set
        .iter()
        .find(|(k, _)| k == "CLAUDE_CONFIG_DIR")
        .map(|(_, v)| v.rsplit(['\\', '/']).next().unwrap_or("").to_string())
        .unwrap_or_default()
}
impl CliDriver for SpyCli {
    fn spawn(&mut self, spec: &SpawnSpec) -> std::io::Result<()> {
        self.alive = true;
        self.last_tail = tail(spec);
        self.specs.push(spec.clone());
        self.pending
            .push(json!({"type":"system","subtype":"init","session_id":"S1","model":"haiku"}));
        Ok(())
    }
    fn send(&mut self, line: Value) {
        if line.get("type").and_then(Value::as_str) != Some("user") {
            return;
        }
        if !self.auto_result {
            return;
        }
        if self.limited.contains(&self.last_tail) {
            self.pending.push(json!({
                "type":"result","subtype":"error_during_execution","is_error":true,
                "result":"Claude AI usage limit reached|1755150000","session_id":"S1",
                "total_cost_usd":0,"duration_ms":1,"num_turns":1
            }));
        } else {
            self.pending.push(json!({
                "type":"result","subtype":"success","is_error":false,"result":"ok",
                "session_id":"S1","total_cost_usd":0,"duration_ms":1,"num_turns":1
            }));
        }
    }
    fn close_input(&mut self) {}
    fn kill(&mut self) {
        self.alive = false;
    }
    fn process_alive(&self) -> bool {
        self.alive
    }
    fn stream_eof(&mut self) -> Option<CloseCause> {
        self.eof.take()
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

fn rt(accounts: &[&str]) -> ChatRuntime<SpyCli> {
    let defaults = IdentityDefaults {
        known_accounts: accounts.iter().map(|s| s.to_string()).collect::<BTreeSet<_>>(),
        ..Default::default()
    };
    ChatRuntime::new(
        "c-crit",
        raw(accounts[0]),
        defaults,
        VirtualClock::new(),
        SpyCli::default(),
    )
    .expect("정규화")
}

/// 리졸버 계기 — 누가 몇 번 물었는지 전부 적는다. `deny`에 든 이메일은 사유로 거절.
#[derive(Default)]
struct Asked {
    log: Mutex<Vec<String>>,
}
fn resolver_for(
    asked: Arc<Asked>,
    deny: &[&str],
) -> ccg_engine::runtime::AccountResolver {
    let deny: BTreeSet<String> = deny.iter().map(|s| s.to_string()).collect();
    Arc::new(move |e: &str| {
        asked.log.lock().unwrap().push(e.to_string());
        if deny.contains(e) {
            Err(format!("<사유:{e}>"))
        } else {
            Ok(std::path::PathBuf::from(format!(r"C:\acct\{e}")))
        }
    })
}

fn notices(evs: &[Event]) -> Vec<String> {
    evs.iter()
        .filter_map(|e| match e {
            Event::Notice(t) => Some(t.clone()),
            _ => None,
        })
        .collect()
}

// ── A1 ──────────────────────────────────────────────────────────────────────
/// **busy 중 예약된 실패 계정.** 첫 턴이 도는 동안 다른 계정으로 예약하고, 그 계정의
/// 리졸버가 거절한다. 빌더의 못 ③은 **콜드 스타트**(스트림 없음)만 잡는다.
#[test]
fn a1_a_failing_account_queued_mid_turn_still_settles_with_a_reason() {
    let asked = Arc::new(Asked::default());
    let mut r = rt(&["a@x.test", "bad@x.test"])
        .with_home(std::path::PathBuf::from(r"C:\h"))
        .with_account_resolver(resolver_for(asked.clone(), &["bad@x.test"]));
    let _ = r.drain_events();

    r.dispatch(Cmd::Send { text: "첫 턴".into() });
    assert_eq!(r.state(), StateTag::Starting);
    r.tick(); // init 프레임 소화 — 이제 진짜 busy다
    assert!(r.busy(), "첫 턴이 돌고 있어야 이 공격이 성립한다: {:?}", r.state());

    let mut pick = RawIdentityPatch::default();
    pick.billing.account = Some("bad@x.test".into());
    r.dispatch(Cmd::Enqueue(QueueInput {
        text: "둘째 턴".into(),
        images: vec![],
        picker: Some(pick),
        origin: None,
    }));
    let _ = r.drain_events();

    // 첫 턴을 닫아 예약분을 드레인시킨다.
    r.driver().alive = false;
    r.driver().eof = Some(CloseCause::CliExit);
    for _ in 0..40 {
        r.tick();
    }

    let evs = r.drain_events();
    let ns = notices(&evs);
    println!("[A1] state={:?} q={} notices={ns:?}", r.state(), r.queue_len());
    println!("[A1] 물어본 계정 = {:?}", asked.log.lock().unwrap());
    assert!(
        ns.iter().any(|t| t.contains("bad@x.test") && t.contains("<사유:bad@x.test>")),
        "busy 중 예약분의 계정 실패도 사유가 나가야 한다: {ns:?}"
    );
    assert_eq!(r.state(), StateTag::Idle, "그 자리에서 정착해야 한다");
    assert_eq!(r.queue_len(), 0, "큐가 굳으면 채팅이 죽는다");
    // 두 번째 스폰은 없어야 한다(첫 턴 하나뿐).
    assert_eq!(r.driver_ref().specs.len(), 1, "실패 계정으로 프로세스를 띄웠다");
}

// ── A2 ──────────────────────────────────────────────────────────────────────
/// **연속 실패.** 못 여는 계정으로 세 번 보내면 사유가 세 번 나가고 매번 정착하는가
/// (한 번 나가고 조용해지면 사용자는 두 번째부터 아무 반응 없는 앱을 본다).
#[test]
fn a2_three_failures_in_a_row_each_speak_and_each_settle() {
    let asked = Arc::new(Asked::default());
    let mut r = rt(&["bad@x.test"])
        .with_home(std::path::PathBuf::from(r"C:\h"))
        .with_account_resolver(resolver_for(asked.clone(), &["bad@x.test"]));
    let mut said = 0;
    for i in 0..3 {
        let _ = r.drain_events();
        r.dispatch(Cmd::Send { text: format!("턴 {i}") });
        for _ in 0..5 {
            r.tick();
        }
        let ns = notices(&r.drain_events());
        println!("[A2] #{i} state={:?} notices={ns:?}", r.state());
        if ns.iter().any(|t| t.contains("<사유:bad@x.test>")) {
            said += 1;
        }
        assert_eq!(r.state(), StateTag::Idle, "#{i} 정착 안 함");
    }
    assert_eq!(said, 3, "사유가 매번 나가야 한다(침묵 no-op 금지)");
    assert!(r.driver_ref().specs.is_empty(), "한 번도 안 띄워야 한다");
    assert_eq!(asked.log.lock().unwrap().len(), 3, "스폰마다 물어야 한다");
}

// ── A3 ──────────────────────────────────────────────────────────────────────
/// **스폰마다 부른다 — 같은 이메일이라도.** 빌더의 못 ②는 계정이 *다를* 때만 잰다.
/// 이메일로 메모이즈하면 그 못은 초록인데 **재로그인 뒤 자격증명 물질화가 사라진다**
/// (리졸버의 부작용이 곧 물질화다).
#[test]
fn a3_the_resolver_is_asked_again_even_for_the_same_email() {
    let asked = Arc::new(Asked::default());
    let mut r = rt(&["a@x.test"])
        .with_home(std::path::PathBuf::from(r"C:\h"))
        .with_account_resolver(resolver_for(asked.clone(), &[]));
    for i in 0..3 {
        r.dispatch(Cmd::Send { text: format!("턴 {i}") });
        r.tick();
        r.driver().alive = false;
        r.driver().eof = Some(CloseCause::CliExit);
        for _ in 0..10 {
            r.tick();
        }
    }
    let log = asked.log.lock().unwrap().clone();
    println!("[A3] 물어본 횟수={} 스폰={} log={log:?}", log.len(), r.driver_ref().specs.len());
    assert_eq!(
        log.len(),
        r.driver_ref().specs.len(),
        "리졸버 호출 수 = 스폰 수여야 한다(캐시하면 물질화가 사라진다)"
    );
    assert!(log.len() >= 3, "세 턴이 돌았어야 한다: {log:?}");
}

// ── A4 ──────────────────────────────────────────────────────────────────────
struct OneShot {
    to: String,
    fail_to: bool,
    calls: Mutex<usize>,
}
impl AccountSwitcher for OneShot {
    fn pick(&self, req: &SwitchRequest) -> Option<SwitchPick> {
        *self.calls.lock().unwrap() += 1;
        if req.tried.contains(&self.to) {
            return None;
        }
        Some(SwitchPick { account: self.to.clone(), soonest_reset: None })
    }
}

/// **M11 자동 전환 직후.** 한도로 A가 막히면 엔진은 B로 갈아타고 재스폰한다.
/// 리졸버가 **B**로 불려야 한다 — A로 불리면 갈아탄 계정의 폴더가 아니라 옛 폴더가 나간다.
#[test]
fn a4_after_an_auto_switch_the_resolver_is_asked_for_the_new_account() {
    let asked = Arc::new(Asked::default());
    let sw = Arc::new(OneShot { to: "b@x.test".into(), fail_to: false, calls: Mutex::new(0) });
    let mut r = rt(&["a@x.test", "b@x.test"])
        .with_home(std::path::PathBuf::from(r"C:\h"))
        .with_account_resolver(resolver_for(asked.clone(), &[]))
        .with_account_switcher(sw.clone());
    r.driver().auto_result = true;
    r.driver().limited.insert("a@x.test".into()); // `CLAUDE_CONFIG_DIR` 꼬리 = 이메일
    let _ = r.drain_events();

    r.dispatch(Cmd::Send { text: "한도 맞는 턴".into() });
    for _ in 0..200 {
        r.tick();
    }
    let evs = r.drain_events();
    let banners: Vec<String> = evs
        .iter()
        .filter_map(|e| match e {
            Event::AccountSwitched { from, to, .. } => Some(format!("{from}→{to}")),
            _ => None,
        })
        .collect();
    let log = asked.log.lock().unwrap().clone();
    let tails: Vec<String> = r.driver_ref().specs.iter().map(tail).collect();
    println!("[A4] banners={banners:?} asked={log:?} tails={tails:?} state={:?}", r.state());
    assert!(!banners.is_empty(), "전환이 일어나야 이 공격이 성립한다");
    assert!(
        log.contains(&"b@x.test".to_string()),
        "갈아탄 뒤 리졸버가 새 계정으로 불려야 한다: {log:?}"
    );
    assert!(
        tails.iter().any(|t| t == "b@x.test"),
        "새 계정 폴더로 떠야 한다: {tails:?}"
    );
}

/// 같은 전환인데 **새 계정의 폴더를 못 여는** 경우 — 침묵하지 않는가.
#[test]
fn a4b_a_switch_target_whose_folder_fails_still_speaks() {
    let asked = Arc::new(Asked::default());
    let sw = Arc::new(OneShot { to: "b@x.test".into(), fail_to: true, calls: Mutex::new(0) });
    let mut r = rt(&["a@x.test", "b@x.test"])
        .with_home(std::path::PathBuf::from(r"C:\h"))
        .with_account_resolver(resolver_for(asked.clone(), &["b@x.test"]))
        .with_account_switcher(sw.clone());
    r.driver().auto_result = true;
    r.driver().limited.insert("a@x.test".into());
    let _ = r.drain_events();

    r.dispatch(Cmd::Send { text: "한도 맞는 턴".into() });
    for _ in 0..200 {
        r.tick();
    }
    let evs = r.drain_events();
    let ns = notices(&evs);
    println!(
        "[A4b] state={:?} q={} notices={ns:?} asked={:?}",
        r.state(),
        r.queue_len(),
        asked.log.lock().unwrap()
    );
    assert!(
        ns.iter().any(|t| t.contains("<사유:b@x.test>")),
        "갈아탄 계정의 폴더 실패도 사유가 나가야 한다: {ns:?}"
    );
    assert_ne!(r.state(), StateTag::Starting, "Starting에 매달리면 스피너가 안 걷힌다");
}

// ── A5 ──────────────────────────────────────────────────────────────────────
/// **1순위 override는 이메일을 안 본다.** 문서에 적힌 사실을 실측으로 못 박는다 —
/// 계정이 둘인 판에서 이 자리가 켜져 있으면 **두 계정이 같은 폴더로 나간다**.
#[test]
fn a5_the_override_beats_the_resolver_and_ignores_the_email() {
    let asked = Arc::new(Asked::default());
    let mut r = rt(&["a@x.test", "b@x.test"])
        .with_home(std::path::PathBuf::from(r"C:\h"))
        .with_account_resolver(resolver_for(asked.clone(), &[]))
        .with_account_dir_override(std::path::PathBuf::from(r"C:\forced"));
    r.dispatch(Cmd::Send { text: "1".into() });
    r.tick();
    r.driver().alive = false;
    r.driver().eof = Some(CloseCause::CliExit);
    for _ in 0..10 {
        r.tick();
    }
    let mut pick = RawIdentityPatch::default();
    pick.billing.account = Some("b@x.test".into());
    r.dispatch(Cmd::Enqueue(QueueInput {
        text: "2".into(),
        images: vec![],
        picker: Some(pick),
        origin: None,
    }));
    for _ in 0..20 {
        r.tick();
    }
    let tails: Vec<String> = r.driver_ref().specs.iter().map(tail).collect();
    println!("[A5] tails={tails:?} asked={:?}", asked.log.lock().unwrap());
    assert!(tails.iter().all(|t| t == "forced"), "override가 이겨야 한다: {tails:?}");
    assert!(
        asked.log.lock().unwrap().is_empty(),
        "override가 켜지면 리졸버는 아예 안 불린다(물질화도 없다)"
    );
}

// ── A6 ──────────────────────────────────────────────────────────────────────
/// **폴백 표식의 탈출.** 「`_no-resolver` 한 층 아래라 실계정과 겹칠 수 없다」가
/// **절대** 보장인가. 경로 구분자를 품은 이메일이면 층을 벗어난다.
#[test]
fn a6_the_fallback_marker_can_leave_its_layer() {
    let home = std::path::PathBuf::from(r"C:\h");
    let r = rt(&["a@x.test"]).with_home(home.clone());
    let acc_root = home.join("accounts");
    let mut escaped = vec![];
    for e in [
        "user@example.invalid",
        "a.b+tag@Example.invalid",
        r"a\..\..\evil@x.com",
        "a/../../evil@x.com",
    ] {
        let p = r.unresolved_account_dir(e);
        // 정규화 후에도 `_no-resolver` 아래인가.
        let norm: std::path::PathBuf = {
            let mut out = std::path::PathBuf::new();
            for c in p.components() {
                match c {
                    std::path::Component::ParentDir => {
                        out.pop();
                    }
                    std::path::Component::CurDir => {}
                    other => out.push(other.as_os_str()),
                }
            }
            out
        };
        let inside = norm.starts_with(acc_root.join("_no-resolver"));
        println!("[A6] {e:<28} → {} (층 안={inside})", norm.display());
        if !inside {
            escaped.push((e.to_string(), norm));
        }
    }
    println!("[A6] 탈출한 표식 = {escaped:?}");
    // 판정은 보고서가 한다 — 이 시험은 사실을 기록한다.
    assert!(
        escaped.iter().all(|(e, _)| e.contains('\\') || e.contains('/')),
        "경로 구분자 없는 이메일이 층을 벗어나면 그건 다른 결함이다"
    );
}

// ── A7 ──────────────────────────────────────────────────────────────────────
/// API 키 축은 계정 폴더를 안 쓴다 — 리졸버가 전부 거절해도 턴이 떠야 한다.
#[test]
fn a7_api_key_turns_are_untouched_by_account_failures() {
    let asked = Arc::new(Asked::default());
    let mut raw = raw("a@x.test");
    raw.billing.kind = BillingKind::ApiKey;
    raw.billing.account = None;
    let defaults = IdentityDefaults {
        known_accounts: ["a@x.test".to_string()].into_iter().collect(),
        api_key: Some("sk-test".into()),
        ..Default::default()
    };
    let mut r = ChatRuntime::new("c-api", raw, defaults, VirtualClock::new(), SpyCli::default())
        .expect("정규화")
        .with_home(std::path::PathBuf::from(r"C:\h"))
        .with_account_resolver(Arc::new(|_e: &str| Err("전부 거절".into())));
    let _ = &asked;
    r.dispatch(Cmd::Send { text: "api".into() });
    println!("[A7] state={:?} spawns={}", r.state(), r.driver_ref().specs.len());
    assert_eq!(r.driver_ref().specs.len(), 1, "API 키 턴이 계정 실패에 막히면 안 된다");
    assert!(
        r.driver_ref().specs[0]
            .env_set
            .iter()
            .all(|(k, _)| k != "CLAUDE_CONFIG_DIR"),
        "API 키 턴에는 계정 폴더가 없다"
    );
}
