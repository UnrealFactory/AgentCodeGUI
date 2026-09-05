//! **엔진 층 세로 조각** — 실 프로세스 · 실 파이프 · 실 상태기계, 가짜 app-server.
//!
//! `codex_replay.rs`가 옮김기(순수)를 재생한다면 여기는 **제품 경로 전체**를 한 번 돌린다:
//!
//! ```text
//!  ChatRuntime.dispatch(Send)  →  T1 스폰(ccg-fakecodex.exe)  →  initialize/thread/turn
//!    →  stdout JSONL  →  CodexDriver 옮김  →  60전이 상태기계  →  Event::Status{Done}
//! ```
//!
//! 실 `codex app-server`를 쓰지 않는 이유는 하나뿐이다: **로그인된 OpenAI 계정이 0건**
//! (M5 실측). 핸드셰이크 이후 첫 턴이 인증에서 죽으므로 이 경로를 라이브로 밟을 수 없다.
//! 실 바이너리로 **어디까지 갔는지**는 `scripts/poc-codex.mjs --only=handshake`가 잰다.
//!
//! 스텁이 없으면(기본 빌드) 이 테스트는 **건너뛴다** — 만드는 법을 출력한다:
//! `cargo build -p ccg-engine --features fakecli --bin ccg-fakecodex`

use ccg_engine::clock::SystemClock;
use ccg_engine::codex::CodexDriver;
use ccg_engine::event::{Event, TerminalStatus};
use ccg_engine::identity::*;
use ccg_engine::runtime::{ChatRuntime, Cmd};
use ccg_engine::state::StateTag;
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// 대본 경로는 **프로세스 전역 env**로 스텁에 전달된다(`CCG_FAKECODEX_SCRIPT`) —
/// cargo가 테스트를 병렬로 돌리면 서로의 대본을 덮는다(실제로 밟았다: 다른 테스트의
/// threadId가 흘러 들어왔다). 이 파일의 테스트는 직렬로 돈다.
static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn stub() -> Option<PathBuf> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("target");
    for p in ["debug", "release"] {
        let c = root.join(p).join(if cfg!(windows) { "ccg-fakecodex.exe" } else { "ccg-fakecodex" });
        if c.exists() {
            return Some(c);
        }
    }
    None
}

fn temp(name: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("ccg-m4-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).unwrap();
    p
}

fn raw_mode(cwd: &str, mode: ModeId) -> RawIdentity {
    RawIdentity {
        engine: RawEngine {
            kind: EngineKind::Codex,
            model: "gpt-5.6-terra".into(),
            effort: EffortId::Medium,
            codex_account: None,
            codex_tier: None,
        },
        billing: RawBilling {
            kind: BillingKind::Subscription,
            account: Some("a@x".into()),
            drop_env_key: Some(false),
        },
        cwd: cwd.into(),
        add_dirs: vec![],
        mode,
        system_prompt: None,
        output_style: None,
        tools: RawTools::default(),
    }
}

fn defaults() -> IdentityDefaults {
    IdentityDefaults {
        known_accounts: BTreeSet::from(["a@x".to_string()]),
        default_codex_account: Some("me@openai.com".into()),
        known_codex_accounts: BTreeSet::from(["me@openai.com".to_string()]),
        cwd_probe: CwdProbe::Fs,
        ..Default::default()
    }
}

fn pump(
    rt: &mut ChatRuntime<CodexDriver>,
    secs: u64,
    until: impl Fn(&ChatRuntime<CodexDriver>) -> bool,
) -> bool {
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(secs) {
        rt.tick();
        if until(rt) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(15));
    }
    false
}

fn script(lines: &[&str], home: &std::path::Path) -> PathBuf {
    let p = home.join("script.jsonl");
    std::fs::write(&p, lines.join("\n") + "\n").unwrap();
    p
}

fn runtime(bin: PathBuf, cwd: &std::path::Path, script: &std::path::Path) -> ChatRuntime<CodexDriver> {
    runtime_mode(bin, cwd, script, ModeId::Auto)
}

fn runtime_mode(
    bin: PathBuf,
    cwd: &std::path::Path,
    script: &std::path::Path,
    mode: ModeId,
) -> ChatRuntime<CodexDriver> {
    std::env::set_var("CCG_FAKECODEX_SCRIPT", script);
    let d = CodexDriver::new(bin, None, None);
    ChatRuntime::new(
        "c-codex",
        raw_mode(&cwd.to_string_lossy(), mode),
        defaults(),
        Arc::new(SystemClock::default()),
        d,
    )
    .expect("정규화")
}

/// 부팅 → 전송 → 핸드셰이크 → 스트리밍 → 완료. **상태기계가 Codex를 모르고 도는 것**이 요지다.
#[test]
fn a_codex_turn_runs_end_to_end_through_the_real_state_machine() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let Some(bin) = stub() else {
        println!("[m4] ccg-fakecodex가 없어 건너뜀 — cargo build -p ccg-engine --features fakecli --bin ccg-fakecodex");
        return;
    };
    let home = temp("live");
    let sp = script(
        &[
            r#"{"await":"initialize","result":{"userAgent":"fake/0.0"}}"#,
            r#"{"await":"thread/start","result":{"thread":{"id":"th-live"}}}"#,
            r#"{"await":"turn/start","result":{"turn":{"id":"tu-live"}}}"#,
            r#"{"emit":{"jsonrpc":"2.0","method":"turn/started","params":{"threadId":"th-live","turn":{"id":"tu-live"}}}}"#,
            r#"{"afterMs":20,"emit":{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"threadId":"th-live","itemId":"m1","delta":"안"}}}"#,
            r#"{"emit":{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"threadId":"th-live","itemId":"m1","delta":"녕"}}}"#,
            r#"{"emit":{"jsonrpc":"2.0","method":"item/completed","params":{"threadId":"th-live","item":{"id":"m1","type":"agentMessage","text":"안녕하세요"}}}}"#,
            r#"{"afterMs":20,"emit":{"jsonrpc":"2.0","method":"thread/tokenUsage/updated","params":{"threadId":"th-live","tokenUsage":{"last":{"inputTokens":10,"outputTokens":3,"totalTokens":13},"total":{"inputTokens":10,"outputTokens":3,"totalTokens":13},"modelContextWindow":272000}}}}"#,
            r#"{"emit":{"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"th-live","turn":{"id":"tu-live","status":"completed","durationMs":42}}}}"#,
        ],
        &home,
    );
    let mut rt = runtime(bin, &home, &sp);

    rt.dispatch(Cmd::Send { text: "안녕".into() });
    assert_eq!(rt.state(), StateTag::Starting, "T1 — 스폰 직후");

    let streaming = pump(&mut rt, 20, |rt| rt.state() == StateTag::Streaming);
    assert!(streaming, "T2에 도달하지 못했다(핸드셰이크 두 조각)");
    assert_eq!(rt.session_id().as_deref(), Some("th-live"), "threadId = session_id(resume 키)");

    let done = pump(&mut rt, 20, |rt| {
        rt.events()
            .iter()
            .any(|e| matches!(e, Event::Status { status: TerminalStatus::Done, .. }))
    });
    let evs = rt.events();
    assert!(done, "종결 status가 안 왔다 — {:?}", evs.last());
    assert_eq!(rt.spawns, 1, "턴 하나에 프로세스 하나");

    // 스트림이 스스로 닫히고(§3.4 OnIdle → close_input → EOF) Idle로 착지한다.
    let idle = pump(&mut rt, 20, |rt| rt.state() == StateTag::Idle);
    assert!(idle, "종료 후 Idle로 안 갔다 — {:?}", rt.state());
    rt.app_quit();
    let _ = std::fs::remove_dir_all(&home);
}

/// 승인 카드 왕복 — 서버 요청 → `AwaitingUser` → 응답 → 서버가 우리 decision을 **바이트로** 받는다.
#[test]
fn an_approval_card_round_trips_to_the_server() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let Some(bin) = stub() else {
        println!("[m4] ccg-fakecodex가 없어 건너뜀");
        return;
    };
    let home = temp("approve");
    let inlog = home.join("in.jsonl");
    std::env::set_var("CCG_FAKECODEX_IN", &inlog);
    let sp = script(
        &[
            r#"{"await":"initialize","result":{}}"#,
            r#"{"await":"thread/start","result":{"thread":{"id":"th-a"}}}"#,
            r#"{"await":"turn/start","result":{"turn":{"id":"tu-a"}}}"#,
            r#"{"emit":{"jsonrpc":"2.0","id":900,"method":"item/commandExecution/requestApproval","params":{"threadId":"th-a","command":"cargo build","reason":"빌드"}}}"#,
            r#"{"awaitResponse":900}"#,
            // 승인 뒤 실제로 명령이 돌았다 = 턴에 활동이 있다. 활동도 답변 텍스트도 없는
            // 턴은 **무음 보류(T8→T10 22초)** 로 가는 것이 상태기계의 규약이라
            // (엔진과 무관한 공통 규칙) 여기서 그 경로를 타면 재는 것이 달라진다.
            r#"{"emit":{"jsonrpc":"2.0","method":"item/started","params":{"threadId":"th-a","item":{"id":"i1","type":"commandExecution","command":"cargo build"}}}}"#,
            r#"{"emit":{"jsonrpc":"2.0","method":"item/completed","params":{"threadId":"th-a","item":{"id":"i1","type":"commandExecution","exitCode":0,"aggregatedOutput":"ok"}}}}"#,
            r#"{"emit":{"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"th-a","turn":{"id":"tu-a","status":"completed"}}}}"#,
        ],
        &home,
    );
    // 승인이 오는 판은 `normal`(untrusted)이다 — auto는 애초에 안 묻는다.
    let mut rt = runtime_mode(bin, &home, &sp, ModeId::Normal);
    rt.dispatch(Cmd::Send { text: "빌드해 줘".into() });

    let asked = pump(&mut rt, 20, |rt| rt.state() == StateTag::AwaitingUser);
    assert!(asked, "승인 카드가 안 떴다");
    let rid = rt
        .ledger()
        .items()
        .iter()
        .find_map(|i| i.ask.as_ref().map(|a| a.request_id.clone()))
        .expect("원장에 카드가 있다");

    rt.dispatch(Cmd::Respond {
        kind: ccg_engine::live::AskKind::Permission,
        request_id: rid,
        accept: true,
    });
    let done = pump(&mut rt, 20, |rt| {
        rt.events()
            .iter()
            .any(|e| matches!(e, Event::Status { status: TerminalStatus::Done, .. }))
    });
    if !done {
        println!("[진단] state={:?}", rt.state());
        println!("[진단] in.jsonl=\n{}", std::fs::read_to_string(&inlog).unwrap_or_default());
        println!("[진단] events={:?}", rt.events());
    }
    assert!(done, "승인 뒤 턴이 안 끝났다");
    rt.app_quit();

    // 서버가 실제로 받은 바이트 — decision이 나갔는가.
    let got = std::fs::read_to_string(&inlog).unwrap_or_default();
    assert!(
        got.lines().any(|l| l.contains("\"decision\":\"accept\"") && l.contains("900")),
        "app-server가 decision을 못 받았다:\n{got}"
    );
    std::env::remove_var("CCG_FAKECODEX_IN");
    let _ = std::fs::remove_dir_all(&home);
}

/// 핸드셰이크가 실패해도 **침묵하지 않는다**(D7).
///
/// 재는 것은 "얼마나 빨리 정착하는가"다: 로그인 안 된 홈으로 뜨면 `thread/start`가
/// 거절되는데, 그때 아무 프레임도 안 만들면 채팅은 **T3(20초)** 까지 나레이션만 돌다가
/// 죽는다(m-logic P8). 옮김기가 그 자리에서 `result{is_error}`를 만들어 턴을 끝낸다.
///
/// 종결 `status`가 `Done`인 것은 **Claude와 같은 어휘**다 — 오류는 `result` 프레임의
/// `is_error`/문장으로 흐르고(셸 `wire.rs`가 빨간 결과 카드로 그린다), `Status::Error`는
/// 스트림이 깨진 경우(크래시·강제 종료)에만 쓴다(`runtime.rs:1461`).
#[test]
fn a_failed_handshake_settles_fast_instead_of_waiting_out_t3() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let Some(bin) = stub() else {
        println!("[m4] ccg-fakecodex가 없어 건너뜀");
        return;
    };
    let home = temp("fail");
    let sp = script(
        &[
            r#"{"await":"initialize","result":{}}"#,
            r#"{"await":"thread/start","error":"not logged in: run `codex login`"}"#,
        ],
        &home,
    );
    let mut rt = runtime(bin, &home, &sp);
    let t0 = Instant::now();
    rt.dispatch(Cmd::Send { text: "안녕".into() });
    let landed = pump(&mut rt, 18, |rt| {
        rt.events().iter().any(|e| matches!(e, Event::Status { .. }))
    });
    let took = t0.elapsed();
    assert!(landed, "실패가 화면에 도달하지 않았다(P8 — 영구 정지 + 침묵)");
    assert!(
        took < Duration::from_secs(10),
        "T3(20초)를 기다렸다 — 오류는 이미 확정된 사실인데 침묵한 셈이다: {took:?}"
    );
    println!("[m4] 핸드셰이크 실패 정착 {}ms", took.as_millis());
    rt.app_quit();
    let _ = std::fs::remove_dir_all(&home);
}
