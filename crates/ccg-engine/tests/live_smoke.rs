//! 라이브 스모크 — **실 `claude.exe` 1~2턴**. `#[ignore]` + `CCG_LIVE=1` 이중 잠금.
//!
//! ```bash
//! CCG_LIVE=1 cargo test -p ccg-engine --offline --test live_smoke -- --ignored --nocapture
//! ```
//!
//! 규칙(사용자 실앱이 떠 있다):
//! - **이름 기반 kill 절대 금지.** 이 테스트가 죽이는 것은 자기가 스폰한 자식 하나뿐이고,
//!   그마저 job object(KILL_ON_JOB_CLOSE)가 손자까지 보증한다.
//! - **사용자 실홈은 읽기/복사만.** 자격증명은 `%TEMP%\ccg-engine-live\config`로 **복사**해
//!   쓴다 — CLI의 토큰 갱신 쓰기가 실홈에 닿지 않는다.
//! - 프레임은 전부 `%TEMP%\ccg-engine-live\<name>.jsonl`에 덤프한다(크리틱이 되짚을 재료).

use ccg_engine::clock::SystemClock;
use ccg_engine::driver::ClaudeDriver;
use ccg_engine::event::Event;
use ccg_engine::identity::*;
use ccg_engine::job::Job;
use ccg_engine::live::AskKind;
use ccg_engine::runtime::{ChatRuntime, Cmd};
use ccg_engine::state::StateTag;
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

fn home() -> PathBuf {
    // 3.0 실홈(.agentcodegui3) 우선 — 없으면 2.6.2 홈(개발 기계의 실자격증명 소재지)
    let base = PathBuf::from(std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap());
    let h3 = base.join(".agentcodegui3");
    if h3.is_dir() { h3 } else { base.join(".agentcodegui") }
}

fn cli_path() -> PathBuf {
    let ver = std::fs::read_to_string(home().join("config.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v["activeVersion"].as_str().map(String::from))
        .unwrap_or_else(|| "0.3.239".into());
    home()
        .join("engines")
        .join(ver)
        .join("node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe")
}

fn out_dir() -> PathBuf {
    let d = std::env::temp_dir().join("ccg-engine-live");
    std::fs::create_dir_all(&d).ok();
    d
}

/// 기본 계정의 자격증명을 **복사**한 격리 CLAUDE_CONFIG_DIR.
fn isolated_config_dir() -> PathBuf {
    let accounts: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(home().join("accounts.json")).unwrap())
            .unwrap();
    let email = accounts["defaultEmail"].as_str().unwrap();
    let prefix = email.replace('@', "_").replace('+', "-");
    let src = std::fs::read_dir(home().join("accounts"))
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .find(|p| {
            p.file_name()
                .map(|n| n.to_string_lossy().starts_with(&prefix))
                .unwrap_or(false)
        })
        .expect("기본 계정 폴더");
    let dst = out_dir().join("config");
    std::fs::create_dir_all(&dst).unwrap();
    for f in [".credentials.json", ".claude.json"] {
        let s = src.join(f);
        if s.exists() {
            std::fs::copy(&s, dst.join(f)).unwrap();
        }
    }
    dst
}

fn identity(cwd: &str) -> (RawIdentity, IdentityDefaults) {
    let accounts: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(home().join("accounts.json")).unwrap())
            .unwrap();
    let email = accounts["defaultEmail"].as_str().unwrap().to_string();
    let raw = RawIdentity {
        engine: RawEngine {
            kind: EngineKind::Claude,
            // 값싼 조합(§ m3-poc와 동일): haiku + thinking disabled.
            model: "haiku".into(),
            effort: EffortId::Minimal,
            codex_account: None,
        },
        billing: RawBilling {
            kind: BillingKind::Subscription,
            account: Some(email.clone()),
            drop_env_key: Some(false),
        },
        cwd: cwd.to_string(),
        add_dirs: vec![],
        mode: ModeId::Normal,
        system_prompt: None,
        output_style: None,
        tools: RawTools::default(),
    };
    let defaults = IdentityDefaults {
        default_cwd: cwd.to_string(),
        default_account: Some(email.clone()),
        known_accounts: BTreeSet::from([email]),
        api_key: None,
        env_api_key_present: false,
        env_key_answer: None,
        // 라이브 스모크는 Claude 계정만 쓴다(Codex 실계정은 0건 — M5 실측).
        default_codex_account: None,
        known_codex_accounts: BTreeSet::new(),
        cwd_probe: CwdProbe::Fs,
    };
    (raw, defaults)
}

fn pump(rt: &mut ChatRuntime<ClaudeDriver>, secs: u64, until: impl Fn(&ChatRuntime<ClaudeDriver>) -> bool) -> bool {
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(secs) {
        rt.tick();
        if until(rt) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    false
}

fn guard() -> bool {
    if std::env::var("CCG_LIVE").as_deref() != Ok("1") {
        eprintln!("CCG_LIVE=1 이 아니므로 건너뜀(실 계정·실 과금 경로)");
        return false;
    }
    true
}

/// L-1: init → 턴 → result. 프레임 덤프 + 프로세스 회계.
#[test]
#[ignore]
fn live_one_turn() {
    if !guard() {
        return;
    }
    let work = out_dir().join("work");
    std::fs::create_dir_all(&work).unwrap();
    let cfg = isolated_config_dir();
    let (raw, mut defaults) = identity(&work.to_string_lossy());
    defaults.cwd_probe = CwdProbe::Fs;

    let job = Arc::new(Job::create().expect("job object"));
    let dump = out_dir().join("live-1turn.jsonl");
    std::fs::write(&dump, "").ok();
    let driver = ClaudeDriver::new(Some(job.clone()), Some(dump.clone()));
    let mut rt = ChatRuntime::new("live", raw, defaults, Arc::new(SystemClock::default()), driver)
        .unwrap()
        .with_cli_path(cli_path())
        .with_account_dir_override(cfg);

    rt.dispatch(Cmd::Send {
        text: "Reply with exactly one word: SMOKE".into(),
    });
    let ok = pump(&mut rt, 90, |rt| rt.state() == StateTag::Idle);
    let evs = rt.events();
    let pid = rt.driver().pid();
    println!("--- pid={pid:?} state={:?} spawns={} exits={}", rt.state(), rt.spawns, rt.exits);
    for e in &evs {
        match e {
            Event::StateAssign { source, from, to } => println!("  SA {source} {from:?}->{to:?}"),
            Event::Status { run_id, status } => println!("  STATUS {run_id} {status:?}"),
            Event::Notice(t) => println!("  NOTICE {t}"),
            _ => {}
        }
    }
    println!("--- 프레임 덤프: {}", dump.display());
    let frames = std::fs::read_to_string(&dump).unwrap_or_default();
    let n = frames.lines().filter(|l| !l.trim().is_empty()).count();
    println!("--- 프레임 {n}개, session={:?}", rt.session_id());
    assert!(ok, "90초 안에 턴이 끝나야 한다");
    assert!(n >= 3, "init + status + result 최소 3프레임");
    assert!(rt.session_id().is_some(), "session_id 바인드");
    assert_eq!(rt.spawns, rt.exits, "프로세스 누수 없음");
    assert!(frames.contains("\"subtype\":\"init\""));
}

/// L-2: 승인 왕복 1회 — `can_use_tool` → `control_response{toolUseID}` → 파일 생성 확인.
#[test]
#[ignore]
fn live_permission_round_trip() {
    if !guard() {
        return;
    }
    let work = out_dir().join("work");
    std::fs::create_dir_all(&work).unwrap();
    let target = work.join("live-approve.txt");
    std::fs::remove_file(&target).ok();
    let cfg = isolated_config_dir();
    let (raw, defaults) = identity(&work.to_string_lossy());

    let job = Arc::new(Job::create().expect("job object"));
    let dump = out_dir().join("live-approve.jsonl");
    std::fs::write(&dump, "").ok();
    let driver = ClaudeDriver::new(Some(job), Some(dump.clone()));
    let mut rt = ChatRuntime::new("live2", raw, defaults, Arc::new(SystemClock::default()), driver)
        .unwrap()
        .with_cli_path(cli_path())
        .with_account_dir_override(cfg);

    rt.dispatch(Cmd::Send {
        text: "Use the Write tool to create live-approve.txt with the exact content OK. Then reply DONE.".into(),
    });
    let got_card = pump(&mut rt, 90, |rt| rt.state() == StateTag::AwaitingUser);
    assert!(got_card, "승인 카드가 떠야 한다");

    let ask = rt
        .ledger()
        .items()
        .iter()
        .find_map(|i| i.ask.clone())
        .expect("AskCard");
    println!("--- ask kind={:?} request_id={} tool_use_id={:?}", ask.ask_kind, ask.request_id, ask.tool_use_id);
    assert_eq!(ask.ask_kind, AskKind::Permission);
    assert!(ask.tool_use_id.is_some(), "응답에 실을 toolUseID를 원장이 들고 있다");

    let t0 = Instant::now();
    rt.dispatch(Cmd::Respond {
        kind: AskKind::Permission,
        request_id: ask.request_id.clone(),
        accept: true,
    });
    let done = pump(&mut rt, 90, |rt| rt.state() == StateTag::Idle);
    println!("--- 승인 후 턴 종료까지 {}ms", t0.elapsed().as_millis());
    assert!(done, "승인 뒤 턴이 끝나야 한다");
    assert!(target.exists(), "파일이 실제로 생성됐다: {}", target.display());
    assert_eq!(rt.spawns, rt.exits);
    println!("--- 프레임 덤프: {}", dump.display());
}
