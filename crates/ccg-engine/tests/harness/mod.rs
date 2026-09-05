//! 재생 하네스 — `docs/design/m-logic-replay.md` §3.
//!
//! 프로세스 없음 · 가상 시계 · 실와이어 박제 + 스펙 합성 → **$0 · 결정적 · 수 ms**.
//!
//! **설계와의 차이 하나(정직하게)**: 설계 §3.1은 시나리오를 TOML로 적게 했다. 여기서는
//! **Rust DSL**로 적는다 — 이 환경의 오프라인 레지스트리 캐시에 `toml` 파서 의존 트리가
//! 없어서 파서를 새로 쓰는 비용이 시나리오를 늘리는 비용보다 컸다. 대신 TOML이 주려던 것
//! 셋(`close_policy` 선언 · `covers` 집계 · `kills` 집계)은 [`Scen`]에 그대로 남겼고,
//! **선언한 `covers`를 실제로 밟았는지 러너가 검사**한다(선언이 거짓말을 못 한다).
//!
//! ## ★R2 — 선언이 아니라 **실행**을 남긴다 (크리틱 R1 C1·C4)
//!
//! R1의 커버리지 게이트는 `covers` **선언**의 합집합을 셌다. 그래서 `#[test]` 한 줄만 지우면
//! 그 전이를 밟는 테스트가 0개가 돼도 게이트는 만점을 외쳤다(크리틱 §2.2가 실증).
//! 이제 [`Sim::finish`]가 **런타임 실적**(실제로 밟은 전이 · 실제로 읽은 합성 픽스처 파일)을
//! `$CARGO_TARGET_TMPDIR/ccg-cov/<바이너리>/`에 남기고, 게이트 바이너리
//! (`tests/zz_coverage_gate.rs`)가 그 실적만 읽는다. 선언은 이제 **실적과 대조되는 쪽**이다.
//!
//! `synth[]`의 의미도 못박는다: **합성 픽스처 파일 의존**이다(인라인 `f_*` 헬퍼는 스펙 §5의
//! 모양을 코드로 적은 것이라 파일 등급 표기가 없다). [`synth`] 로더가 실제 로드를 기록하고
//! `finish()`가 선언과 **정확히** 대조한다 — R1에서 `S4`↔`S4C`의 `assumed` 귀속이 뒤집혀
//! 있었는데 아무도 몰랐던 이유가 이 대조가 없어서였다(크리틱 §2.3).

#![allow(dead_code)]

use ccg_engine::clock::{Clock, Millis, VirtualClock, SEC};
use ccg_engine::driver::{CliDriver, SpawnSpec};
use ccg_engine::event::{Event, EvidenceSource, TerminalStatus};
use ccg_engine::identity::*;
use ccg_engine::live::{CloseCause, LiveItem, ProbeSource, SettleReason};
use ccg_engine::runtime::{ChatRuntime, Cmd, TICK};
use ccg_engine::state::{ResidentWhy, StateTag, StreamClosePolicy};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::Arc;

// ─────────────────────────────────────────────────────────────────────────────
// 시나리오 선언 (TOML의 머리부에 해당)
// ─────────────────────────────────────────────────────────────────────────────

pub struct Scen {
    pub name: &'static str,
    /// `m-logic.md` §1의 병리 번호 — 리포트가 집계한다.
    pub kills: &'static [&'static str],
    /// 이 시나리오가 밟는 전이 id. **러너가 실제로 밟았는지 검사한다.**
    pub covers: &'static [&'static str],
    pub close_policy: &'static str,
    /// 이 시나리오가 읽는 **합성 픽스처 파일**(`tests/fixtures/synth/<name>.jsonl`).
    /// `assumed` 등급은 `"이름(assumed)"`로 표시한다. **러너가 실제 로드와 정확히 대조한다** —
    /// 선언에 없는 파일을 읽어도, 선언만 하고 안 읽어도 그 자리에서 실패한다(★R2).
    pub synth: &'static [&'static str],
}

// ─────────────────────────────────────────────────────────────────────────────
// 실행 실적 기록 (★R2 — 게이트가 선언이 아니라 실행을 세게 하는 배관)
// ─────────────────────────────────────────────────────────────────────────────

pub mod cov {
    use std::collections::BTreeSet;
    use std::path::PathBuf;
    use std::sync::{Mutex, Once};

    /// 시나리오·하네스 소스의 지문. **모든 테스트 바이너리가 같은 값을 컴파일 시점에 굽는다.**
    /// 소스가 한 글자라도 바뀌면 지난 런의 실적은 자동으로 무효가 된다 —
    /// "지난번엔 밟았으니까"로 게이트가 초록이 되는 구멍을 막는다.
    pub const SRC_FP: u64 = fnv3(
        include_str!("mod.rs"),
        include_str!("../replay.rs"),
        include_str!("../replay_standing.rs"),
    );

    const fn fnv1a(mut h: u64, s: &str) -> u64 {
        let b = s.as_bytes();
        let mut i = 0;
        while i < b.len() {
            h ^= b[i] as u64;
            h = h.wrapping_mul(0x1000_0000_01b3);
            i += 1;
        }
        h
    }
    pub const fn fnv3(a: &str, b: &str, c: &str) -> u64 {
        fnv1a(fnv1a(fnv1a(0xcbf2_9ce4_8422_2325, a), b), c)
    }
    pub fn fnv(s: &str) -> u64 {
        fnv1a(0xcbf2_9ce4_8422_2325, s)
    }

    pub fn root() -> PathBuf {
        PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("ccg-cov")
    }

    /// `replay-<hash>.exe` → `replay`. 바이너리마다 제 칸을 쓴다(교차 오염 없음).
    pub fn bin_tag() -> String {
        let exe = std::env::current_exe().unwrap_or_default();
        let stem = exe
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "unknown".into());
        match stem.rsplit_once('-') {
            Some((head, tail)) if tail.len() >= 8 && tail.chars().all(|c| c.is_ascii_hexdigit()) => {
                head.to_string()
            }
            _ => stem,
        }
    }

    pub fn dir() -> PathBuf {
        root().join(bin_tag())
    }

    static WIPE: Once = Once::new();
    static WRITE_LOCK: Mutex<()> = Mutex::new(());

    /// 프로세스 시작 시 **자기 칸만** 비운다. 그래서 이 바이너리의 실적은 언제나
    /// "가장 최근 런에 실제로 돈 것"과 정확히 같다 — `#[test]`를 지우면 그 줄이 사라진다.
    fn wipe_once() {
        WIPE.call_once(|| {
            let d = dir();
            let _ = std::fs::remove_dir_all(&d);
            let _ = std::fs::create_dir_all(&d);
        });
    }

    /// 시나리오 1건의 실적. 같은 `Scen`을 두 테스트가 공유하면 **합집합**으로 누적한다.
    pub fn record(
        name: &str,
        fired: &BTreeSet<String>,
        kills: &[&str],
        synth_used: &BTreeSet<String>,
    ) {
        wipe_once();
        let _g = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let path = dir().join(format!("{:016x}.json", fnv(name)));
        let (mut f, mut s) = (BTreeSet::new(), BTreeSet::new());
        if let Ok(txt) = std::fs::read_to_string(&path) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
                if v["src_fp"].as_str() == Some(&format!("{SRC_FP:016x}")) {
                    for x in v["fired"].as_array().into_iter().flatten() {
                        f.insert(x.as_str().unwrap_or_default().to_string());
                    }
                    for x in v["synth"].as_array().into_iter().flatten() {
                        s.insert(x.as_str().unwrap_or_default().to_string());
                    }
                }
            }
        }
        f.extend(fired.iter().cloned());
        s.extend(synth_used.iter().cloned());
        let doc = serde_json::json!({
            "name": name,
            "src_fp": format!("{SRC_FP:016x}"),
            "bin": bin_tag(),
            "fired": f,
            "kills": kills,
            "synth": s,
        });
        let _ = std::fs::write(&path, serde_json::to_vec_pretty(&doc).unwrap_or_default());
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// FakeCli
// ─────────────────────────────────────────────────────────────────────────────

pub struct FakeCli {
    clock: Arc<VirtualClock>,
    pub spawns: usize,
    pub sent: Vec<Value>,
    pub closed: bool,
    pub killed: bool,
    pub alive: bool,
    /// `freeze` 중에도 **컨트롤 채널만은 살아 있는지** — 7b와 7b′를 가르는 유일한 축.
    pub responsive: bool,
    /// 능동 `initialize` 재전송에 CLI가 돌려줄 REPLACE 목록.
    pub probe_tasks: Vec<String>,
    /// 프로브 응답에 얹을 곁가지(중복 렌더 방지 검증용).
    pub probe_pending_permissions: Vec<String>,
    /// ④ mtime 프로브가 Alive를 낼 항목.
    pub mtime_fresh_ids: BTreeSet<String>,
    scheduled: Vec<(Millis, Value)>,
    pub probe_count: usize,
    pub last_spec: Option<SpawnSpec>,
    pub spawn_specs: Vec<SpawnSpec>,
}

/// 능동 프로브 응답 지연(실측 아님 — 3s 타임아웃 안쪽 값으로 잡았다).
pub const PROBE_REPLY_DELAY: Millis = 2500;

impl FakeCli {
    pub fn new(clock: Arc<VirtualClock>) -> FakeCli {
        FakeCli {
            clock,
            spawns: 0,
            sent: vec![],
            closed: false,
            killed: false,
            alive: false,
            responsive: true,
            probe_tasks: vec![],
            probe_pending_permissions: vec![],
            mtime_fresh_ids: BTreeSet::new(),
            scheduled: vec![],
            probe_count: 0,
            last_spec: None,
            spawn_specs: vec![],
        }
    }
    pub fn sent_user_texts(&self) -> Vec<String> {
        self.sent
            .iter()
            .filter(|v| v["type"] == "user")
            .filter_map(|v| {
                v["message"]["content"][0]["text"]
                    .as_str()
                    .map(|s| s.to_string())
            })
            .collect()
    }
    pub fn sent_control(&self, subtype: &str) -> Vec<Value> {
        self.sent
            .iter()
            .filter(|v| v["type"] == "control_request" && v["request"]["subtype"] == subtype)
            .cloned()
            .collect()
    }
    pub fn sent_responses(&self) -> Vec<Value> {
        self.sent
            .iter()
            .filter(|v| v["type"] == "control_response")
            .cloned()
            .collect()
    }
}

impl CliDriver for FakeCli {
    fn spawn(&mut self, spec: &SpawnSpec) -> std::io::Result<()> {
        self.spawns += 1;
        self.alive = true;
        self.closed = false;
        self.last_spec = Some(spec.clone());
        self.spawn_specs.push(spec.clone());
        Ok(())
    }
    fn send(&mut self, line: Value) {
        let now = self.clock.now_ms();
        // 능동 프로브(⑥): responsive면 성공 응답 + 현재 REPLACE 스냅샷을 밀어 준다.
        if line["type"] == "control_request" && line["request"]["subtype"] == "initialize" {
            let rid = line["request_id"].as_str().unwrap_or("").to_string();
            if rid.starts_with("probe-") {
                self.probe_count += 1;
                if self.responsive {
                    let mut resp = json!({
                        "type": "control_response",
                        "response": { "subtype": "success", "request_id": rid, "response": {} }
                    });
                    if !self.probe_pending_permissions.is_empty() {
                        resp["response"]["response"]["pending_permission_requests"] = json!(self
                            .probe_pending_permissions
                            .iter()
                            .map(|r| json!({ "request_id": r }))
                            .collect::<Vec<_>>());
                    }
                    self.scheduled.push((now + PROBE_REPLY_DELAY, resp));
                    self.scheduled.push((
                        now + PROBE_REPLY_DELAY,
                        json!({
                            "type": "system", "subtype": "background_tasks_changed",
                            "tasks": self.probe_tasks.iter().map(|t| json!({
                                "task_id": t, "task_type": "local_bash", "description": t
                            })).collect::<Vec<_>>(),
                            "session_id": "S1", "uuid": "U-probe"
                        }),
                    ));
                }
            }
        }
        self.sent.push(line);
    }
    fn close_input(&mut self) {
        self.closed = true;
        self.alive = false; // stdin EOF → CLI가 정리 종료한다(실측)
    }
    fn kill(&mut self) {
        self.killed = true;
        self.alive = false;
    }
    fn process_alive(&self) -> bool {
        self.alive
    }
    fn poll_frames(&mut self, now: Millis) -> Vec<Value> {
        let mut out = vec![];
        let mut keep = vec![];
        for (at, v) in self.scheduled.drain(..) {
            if at <= now {
                out.push(v)
            } else {
                keep.push((at, v))
            }
        }
        self.scheduled = keep;
        out
    }
    fn mtime_fresh(&self, item: &LiveItem, _now: Millis) -> bool {
        self.mtime_fresh_ids.contains(&item.id)
    }
    fn spawn_count(&self) -> usize {
        self.spawns
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 픽스처
// ─────────────────────────────────────────────────────────────────────────────

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

/// `//` 주석 줄은 건너뛴다(합성 파일의 근거 줄).
pub fn load_frames(rel: &str) -> Vec<Value> {
    let p = fixtures_dir().join(rel);
    let s = std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
    s.lines()
        .filter(|l| !l.trim().is_empty() && !l.trim_start().starts_with("//"))
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .collect()
}

pub fn wire(name: &str) -> Vec<Value> {
    load_frames(&format!("wire/{name}.jsonl"))
}
/// 실와이어에서 조건에 맞는 **첫 프레임**을 뽑는다(합성으로 대체하지 않는다).
pub fn wire_find(name: &str, pred: impl Fn(&Value) -> bool) -> Value {
    wire(name)
        .into_iter()
        .find(|v| pred(v))
        .unwrap_or_else(|| panic!("wire/{name}.jsonl에 해당 프레임 없음"))
}
std::thread_local! {
    /// 이 테스트(=스레드)가 실제로 읽은 합성 픽스처 파일. `Sim::new`가 비우고
    /// `Sim::finish`가 선언과 대조한다.
    static SYNTH_USED: std::cell::RefCell<BTreeSet<String>> =
        std::cell::RefCell::new(BTreeSet::new());
}

/// 합성 픽스처 파일 로더. **읽은 사실이 기록된다**(선언 대조용 — ★R2).
pub fn synth(name: &str) -> Vec<Value> {
    SYNTH_USED.with(|s| s.borrow_mut().insert(name.to_string()));
    load_frames(&format!("synth/{name}.jsonl"))
}

/// 실와이어의 **핸드셰이크 3프레임**(control_response(init) · system/init · status).
pub fn handshake(name: &str) -> Vec<Value> {
    wire(name).into_iter().take(3).collect()
}
/// 실와이어의 마지막 `result`.
pub fn last_result(name: &str) -> Value {
    wire(name)
        .into_iter()
        .filter(|v| v["type"] == "result")
        .next_back()
        .expect("result 프레임 없음")
}
pub fn frames_until_result(name: &str) -> Vec<Value> {
    let all = wire(name);
    let idx = all.iter().position(|v| v["type"] == "result").unwrap();
    all.into_iter().take(idx).collect()
}

// ── 인라인 합성 프레임 (스펙 §5의 모양 그대로) ────────────────────────────────

pub fn f_result_ok(text: &str) -> Value {
    json!({"type":"result","subtype":"success","is_error":false,"terminal_reason":"completed",
           "result":text,"num_turns":1,"total_cost_usd":0.001,"session_id":"S1","uuid":"U-r"})
}
pub fn f_result_err(text: &str) -> Value {
    json!({"type":"result","subtype":"error_during_execution","is_error":true,
           "terminal_reason":"error","result":text,"error":text,"session_id":"S1","uuid":"U-re"})
}
pub fn f_result_aborted() -> Value {
    json!({"type":"result","subtype":"error_during_execution","is_error":true,
           "terminal_reason":"aborted_streaming","result":null,"session_id":"S1","uuid":"U-ra"})
}
pub fn f_assistant_text(text: &str) -> Value {
    json!({"type":"assistant","parent_tool_use_id":null,
           "message":{"role":"assistant","model":"fable","content":[{"type":"text","text":text}]},
           "session_id":"S1","uuid":"U-a"})
}
pub fn f_assistant_model(model: &str) -> Value {
    json!({"type":"assistant","parent_tool_use_id":null,
           "message":{"role":"assistant","model":model,"content":[{"type":"text","text":"…"}]},
           "session_id":"S1","uuid":"U-am"})
}
pub fn f_bg(tasks: &[(&str, &str)]) -> Value {
    json!({"type":"system","subtype":"background_tasks_changed",
           "tasks": tasks.iter().map(|(id, ty)| json!({"task_id":id,"task_type":ty,"description":id}))
                        .collect::<Vec<_>>(),
           "session_id":"S1","uuid":"U-bg"})
}
pub fn f_task_notification(task_id: &str, status: &str, by_user: bool) -> Value {
    json!({"type":"system","subtype":"task_notification","task_id":task_id,
           "status":status,"by_user":by_user,"session_id":"S1","uuid":"U-tn"})
}
pub fn f_user_notif(task_id: &str) -> Value {
    json!({"type":"user","parent_tool_use_id":null,
           "message":{"role":"user","content":[{"type":"text",
             "text":format!("<task-notification task_id=\"{task_id}\">끝났습니다</task-notification>")}]},
           "session_id":"S1","uuid":"U-un"})
}
pub fn f_can_use_tool(request_id: &str, tool: &str, tool_use_id: &str) -> Value {
    json!({"type":"control_request","request_id":request_id,
           "request":{"subtype":"can_use_tool","tool_name":tool,"display_name":tool,
                      "input":{},"description":tool,"tool_use_id":tool_use_id}})
}
pub fn f_dialog(request_id: &str, to_model: &str) -> Value {
    // 합성 규약: 폴백 다이얼로그의 대상 모델을 `tool_use_id` 자리에 싣는다.
    json!({"type":"control_request","request_id":request_id,
           "request":{"subtype":"request_user_dialog","dialog_kind":"refusal_fallback_prompt",
                      "tool_use_id":to_model,"description":"모델을 바꿔 계속할까요?"}})
}
pub fn f_cancel(request_id: &str) -> Value {
    json!({"type":"control_cancel_request","request_id":request_id})
}
pub fn f_init(session: &str) -> Value {
    json!({"type":"system","subtype":"init","session_id":session,"model":"claude-fable-5",
           "cwd":"C:\\ccg-fixture\\work","tools":[],"permissionMode":"default","uuid":"U-i"})
}
/// `model` 없는 `system/init`. **파서가 허용하는 갈래**(`Frame::SystemInit.model: Option`)라
/// 의미론을 못박아야 한다 — 실와이어에서 관측된 모양은 아니다(등급: parser_branch).
pub fn f_init_nomodel(session: &str) -> Value {
    json!({"type":"system","subtype":"init","session_id":session,
           "cwd":"C:\\ccg-fixture\\work","tools":[],"permissionMode":"default","uuid":"U-i0"})
}
pub fn f_init_ack() -> Value {
    json!({"type":"control_response","response":{"subtype":"success","request_id":"init-1","response":{}}})
}

// ─────────────────────────────────────────────────────────────────────────────
// Sim
// ─────────────────────────────────────────────────────────────────────────────

pub fn defaults() -> IdentityDefaults {
    IdentityDefaults {
        default_cwd: "C:\\ccg-fixture\\desktop".into(),
        default_account: Some("a@x".into()),
        known_accounts: BTreeSet::from(["a@x".to_string(), "b@x".to_string()]),
        api_key: Some("sk-fixture".into()),
        env_api_key_present: false,
        env_key_answer: None,
        // ★M4/O4 — Codex 계정 축. 재생 시나리오는 전부 Claude라 값이 쓰이지 않지만,
        // 픽스처에 계정을 하나 둬야 Codex 정체성이 "미지정 → 기본"으로 접히는 것을
        // 같은 하네스에서 잴 수 있다(`tests/codex_replay.rs`).
        default_codex_account: Some("cx@x".into()),
        known_codex_accounts: BTreeSet::from(["cx@x".to_string()]),
        cwd_probe: CwdProbe::AssumeExists,
    }
}

pub fn raw(model: &str, effort: EffortId, account: &str) -> RawIdentity {
    RawIdentity {
        engine: RawEngine {
            kind: EngineKind::Claude,
            model: model.into(),
            effort,
            codex_account: None,
            codex_tier: None,
        },
        billing: RawBilling {
            kind: BillingKind::Subscription,
            account: Some(account.into()),
            drop_env_key: Some(false),
        },
        cwd: "C:\\ccg-fixture\\work".into(),
        add_dirs: vec![],
        mode: ModeId::Normal,
        system_prompt: None,
        output_style: None,
        tools: RawTools::default(),
    }
}

pub struct Sim {
    pub rt: ChatRuntime<FakeCli>,
    pub clock: Arc<VirtualClock>,
    pub scen: &'static Scen,
    unknown_injected: bool,
}

impl Sim {
    pub fn new(scen: &'static Scen, id: RawIdentity) -> Sim {
        SYNTH_USED.with(|s| s.borrow_mut().clear());
        let clock = VirtualClock::new();
        let driver = FakeCli::new(clock.clone());
        let policy = match scen.close_policy {
            "keep_open" => StreamClosePolicy::KeepOpen,
            "on_idle" => StreamClosePolicy::OnIdle,
            other => StreamClosePolicy::Linger(
                other.trim_start_matches("linger_ms=").parse::<u64>().unwrap_or(0),
            ),
        };
        let rt = ChatRuntime::new("chat-1", id, defaults(), clock.clone(), driver)
            .expect("정규화 성공")
            .with_close_policy(policy);
        Sim {
            rt,
            clock,
            scen,
            unknown_injected: false,
        }
    }

    pub fn now(&self) -> Millis {
        self.clock.now_ms()
    }

    /// 시계를 민다. 매 스텝은 **min(다음 타이머 만료, 워치독 tick 5s, 목표)** —
    /// 실앱이 개별 타이머 + 5s 워치독 루프를 함께 돌리는 것과 같은 결이다.
    /// (5s 고정 스텝만 쓰면 2.5s 슬라이딩 보류가 삼켜져 없는 동작을 재생하게 된다.)
    pub fn advance_to(&mut self, target: Millis) {
        loop {
            let now = self.now();
            if now >= target {
                break;
            }
            let next = self
                .rt
                .next_deadline()
                .filter(|d| *d > now)
                .unwrap_or(u64::MAX)
                .min(now + TICK)
                .min(target);
            self.clock.advance_to(next);
            self.rt.tick();
        }
    }
    pub fn advance(&mut self, by: Millis) {
        self.advance_to(self.now() + by);
    }

    pub fn feed(&mut self, frames: &[Value]) {
        for f in frames {
            self.rt.on_frame(f);
        }
    }
    pub fn frame(&mut self, v: Value) {
        self.rt.on_frame(&v);
    }
    /// 불변식 10 — 시나리오마다 미지 프레임 1개를 흘려 넣는다(죽지 않아야 한다).
    /// **러너가 자동으로 넣는 것**이라 `synth[]` 선언 대조 대상이 아니다(로더를 우회한다).
    pub fn inject_unknown(&mut self) {
        self.unknown_injected = true;
        self.frame(load_frames("synth/unknown-frame.jsonl")[0].clone());
    }

    pub fn send(&mut self, text: &str) -> ccg_engine::event::Verdict {
        self.rt.dispatch(Cmd::Send { text: text.into() })
    }
    pub fn enqueue(&mut self, text: &str) -> ccg_engine::event::Verdict {
        self.rt.dispatch(Cmd::Enqueue(text.into()))
    }
    pub fn cmd(&mut self, c: Cmd) -> ccg_engine::event::Verdict {
        self.rt.dispatch(c)
    }

    pub fn events(&self) -> Vec<Event> {
        self.rt.events()
    }
    pub fn state(&self) -> StateTag {
        self.rt.state()
    }
    pub fn why(&self) -> Option<ResidentWhy> {
        self.rt.resident_why()
    }
    pub fn live_ids(&self) -> Vec<String> {
        self.rt
            .ledger()
            .items()
            .iter()
            .map(|i| i.id.clone())
            .collect()
    }
    pub fn settled(&self) -> Vec<(String, String, Millis)> {
        self.events()
            .into_iter()
            .filter_map(|e| match e {
                Event::Settled {
                    id, reason, at_ms, ..
                } => Some((id, reason.wire(), at_ms)),
                _ => None,
            })
            .collect()
    }
    pub fn settle_reason(&self, id: &str) -> Option<String> {
        self.settled()
            .into_iter()
            .find(|(i, _, _)| i == id)
            .map(|(_, r, _)| r)
    }
    pub fn count<F: Fn(&Event) -> bool>(&self, f: F) -> usize {
        self.events().iter().filter(|e| f(e)).count()
    }
    pub fn banners(&self) -> Vec<(String, String)> {
        self.events()
            .into_iter()
            .filter_map(|e| match e {
                Event::FallbackBanner {
                    from_model,
                    to_model,
                    ..
                } => Some((from_model, to_model)),
                _ => None,
            })
            .collect()
    }
    pub fn identity_events(&self) -> Vec<Event> {
        self.events()
            .into_iter()
            .filter(|e| matches!(e, Event::Identity { .. }))
            .collect()
    }
    pub fn state_track(&self) -> Vec<StateTag> {
        self.events()
            .into_iter()
            .filter_map(|e| match e {
                Event::StateAssign { to, .. } => Some(to),
                _ => None,
            })
            .collect()
    }
    pub fn fired(&self) -> BTreeSet<String> {
        self.rt.fired()
    }
    /// 시나리오 종료 — 암묵 `app_quit`(불변식 9의 teardown) 후 공통 불변식을 전수 검사하고,
    /// **런타임 실적을 게이트가 읽을 자리에 남긴다**(★R2 — 게이트는 선언을 안 본다).
    pub fn finish(mut self) {
        if !self.unknown_injected {
            self.inject_unknown();
        }
        self.rt.app_quit();
        check_invariants(&self);
        check_covers(&self);
        let used = check_synth(&self);
        cov::record(self.scen.name, &self.fired(), self.scen.kills, &used);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 공통 불변식 (§3.4) — 시나리오가 안 적어도 러너가 검사한다
// ─────────────────────────────────────────────────────────────────────────────

pub fn check_invariants(sim: &Sim) {
    let name = sim.scen.name;
    let ev = sim.events();

    // 1. 원장 비었음
    assert!(
        sim.rt.ledger().is_empty(),
        "[{name}] 불변식1: 원장이 안 비었다 — {:?}",
        sim.live_ids()
    );
    // 2. busy 해제
    assert!(!sim.rt.busy(), "[{name}] 불변식2: busy가 안 풀렸다");
    // 3. 종결 status: run_id마다 정확히 1회
    let mut per_run: BTreeMap<String, usize> = BTreeMap::new();
    for e in &ev {
        if let Event::Status { run_id, .. } = e {
            *per_run.entry(run_id.to_string()).or_default() += 1;
        }
    }
    for (r, c) in &per_run {
        assert_eq!(*c, 1, "[{name}] 불변식3: {r}의 종결 status가 {c}회");
    }
    // 4. 대기자 0 (열린 AskCard 없음)
    assert!(
        !sim.rt.ledger().items().iter().any(|i| i.ask.is_some()),
        "[{name}] 불변식4: 미해제 AskCard"
    );
    // 6. 게이팅 자격: liveness != observed 인 항목은 블로커가 될 수 없다
    for id in sim.rt.gating_blockers() {
        let l = sim.rt.ledger();
        let it = l.items().iter().find(|i| i.id == id).unwrap();
        assert_eq!(
            it.liveness,
            ccg_engine::live::Liveness::Observed,
            "[{name}] 불변식6"
        );
    }
    // 7. 이중 전송 없음 — 같은 프롬프트가 두 번 stdin에 실리지 않는다
    let texts = sim.rt_driver_texts();
    let mut uniq = texts.clone();
    uniq.sort();
    uniq.dedup();
    assert_eq!(
        texts.len(),
        uniq.len(),
        "[{name}] 불변식7: 같은 프롬프트가 두 번 전송됨 {texts:?}"
    );
    // 8. 정체성 리비전 단조 증가
    let mut last = -1i64;
    for e in &ev {
        if let Event::Identity { revision, .. } = e {
            assert!(
                (*revision as i64) > last,
                "[{name}] 불변식8: 리비전 단조성 깨짐 {revision} ≤ {last}"
            );
            last = *revision as i64;
        }
    }
    // 9. 프로세스 누수 없음 (teardown 후)
    assert_eq!(
        sim.rt.spawns, sim.rt.exits,
        "[{name}] 불변식9: spawn {} != exit {}",
        sim.rt.spawns, sim.rt.exits
    );
    // 10. 미지 프레임에 죽지 않음
    assert!(
        ev.iter().any(|e| matches!(e, Event::UnknownFrameDropped)),
        "[{name}] 불변식10: 미지 프레임 주입 기록 없음"
    );
    // 11. 워치독은 프로세스 생존으로 재장전되지 않는다
    assert!(
        !ev.iter().any(|e| matches!(
            e,
            Event::EvidenceRearm {
                source: EvidenceSource::ProcessAlive,
                ..
            }
        )),
        "[{name}] 불변식11: process_alive가 리스를 재장전했다"
    );
    // 12. 추정 정착(Watchdog{None})은 close_input을 유발하지 않는다
    check_no_close_after_guess(&ev, name);
    // 13. 폴백 리비전은 전환당 1개 (같은 to_model이 한 턴 안에 2개면 위반)
    check_banner_once_per_turn(&ev, name);
    // 15. 워치독 루프는 Resident 밖에서 state를 대입하지 않는다
    for e in &ev {
        if let Event::StateAssign { source, from, .. } = e {
            if *source == "watchdog_loop" {
                assert_eq!(
                    *from,
                    StateTag::Resident,
                    "[{name}] 불변식15: watchdog_loop가 {from:?}에서 대입했다"
                );
            }
        }
    }
    // 16. 능동 프로브 예산 — 30s 미만 간격 0건
    let probes: Vec<Millis> = ev
        .iter()
        .filter_map(|e| match e {
            Event::ProbeSent { at_ms, .. } => Some(*at_ms),
            _ => None,
        })
        .collect();
    for w in probes.windows(2) {
        assert!(
            w[1] - w[0] >= 30 * SEC,
            "[{name}] 불변식16: 프로브 간격 {}ms",
            w[1] - w[0]
        );
    }
}

/// 불변식 12. `Watchdog{probe:Active}`(관측된 정착)는 **대상이 아니다** — 그 뒤의 빈 REPLACE가
/// F13 → T20으로 프로세스를 거두는 게 정상이다.
fn check_no_close_after_guess(ev: &[Event], name: &str) {
    let mut armed = false;
    for e in ev {
        match e {
            Event::Settled {
                reason:
                    SettleReason::Watchdog {
                        probe: ProbeSource::None,
                    },
                ..
            } => armed = true,
            // 다른 사유로 종료가 시작되면 해제(T32 유휴회수·T23·T22·재스폰 등)
            Event::StateAssign { source, .. }
                if matches!(
                    *source,
                    "T32" | "T23" | "T24" | "T22" | "T17" | "T18" | "T34" | "T15" | "T3"
                ) =>
            {
                armed = false
            }
            Event::CloseInput { .. } if armed => {
                panic!("[{name}] 불변식12: 추정 정착 직후 close_input이 호출됐다")
            }
            _ => {}
        }
    }
}

fn check_banner_once_per_turn(ev: &[Event], name: &str) {
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for e in ev {
        match e {
            Event::FallbackBanner { to_model, .. } => {
                assert!(
                    seen.insert(to_model.clone()),
                    "[{name}] 불변식13: {to_model}로 가는 배너가 한 턴에 2개"
                );
            }
            Event::Status { .. } => seen.clear(), // 턴 경계
            _ => {}
        }
    }
}

/// 선언한 `synth[]`가 **실제로 읽은 합성 픽스처 파일과 같은지** 검사한다(★R2 — 크리틱 C4).
///
/// 양방향이다: 선언에만 있는 것(과대선언 — `S4`의 `assumed` 오귀속이 이 형태였다)도,
/// 읽었는데 선언에 없는 것(`S4C`가 이 형태였다)도 실패다. 반환값은 게이트에 남길 실적.
pub fn check_synth(sim: &Sim) -> BTreeSet<String> {
    let used: BTreeSet<String> = SYNTH_USED.with(|s| s.borrow().clone());
    let declared: BTreeSet<String> = sim
        .scen
        .synth
        .iter()
        .map(|s| s.split('(').next().unwrap_or(s).trim().to_string())
        .collect();
    assert_eq!(
        declared,
        used,
        "[{}] synth 선언 ≠ 실제 로드 — 선언만 함 {:?} · 안 적고 읽음 {:?}",
        sim.scen.name,
        declared.difference(&used).collect::<Vec<_>>(),
        used.difference(&declared).collect::<Vec<_>>()
    );
    used
}

/// 선언한 `covers`를 **실제로 밟았는지** 검사한다 — 선언이 거짓말을 못 하게.
pub fn check_covers(sim: &Sim) {
    let fired = sim.fired();
    let missing: Vec<&str> = sim
        .scen
        .covers
        .iter()
        .filter(|c| !fired.contains(**c))
        .cloned()
        .collect();
    assert!(
        missing.is_empty(),
        "[{}] covers 선언은 했는데 안 밟은 전이: {missing:?}\n밟은 것: {:?}",
        sim.scen.name,
        fired
    );
}

impl Sim {
    fn rt_driver_texts(&self) -> Vec<String> {
        self.rt.sent_user_texts()
    }
}

pub fn cnt_status(sim: &Sim, kind: TerminalStatus) -> usize {
    sim.count(|e| matches!(e, Event::Status { status, .. } if *status == kind))
}

pub fn spawns_of(sim: &Sim) -> usize {
    sim.rt.spawns
}

pub fn cause_of_exit(sim: &Sim) -> Vec<CloseCause> {
    sim.events()
        .into_iter()
        .filter_map(|e| match e {
            Event::Exit { cause, .. } => Some(cause),
            _ => None,
        })
        .collect()
}

// ─────────────────────────────────────────────────────────────────────────────
// 시나리오 레지스트리 — 커버리지 게이트(tests/frame_coverage.rs)가 읽는 단일 표.
// 선언이 여기 모여 있어야 "표에는 있는데 테스트가 없는 줄"을 기계가 셀 수 있다.
// ─────────────────────────────────────────────────────────────────────────────

pub static S1: Scen = Scen {
    name: "#1 계정 변경 중 턴 시작 — 라이브 항목 없음",
    kills: &["P4", "P2"],
    covers: &["T1", "T2", "T7", "T25", "T26", "F1", "F2", "F6", "F19"],
    close_policy: "on_idle",
    synth: &[],
};

pub static S1B: Scen = Scen {
    name: "#1b 계정 변경 + 라이브 셸 1개 → Respawn",
    kills: &["P4", "P1c"],
    covers: &["T1", "T2", "T7", "T17", "F13"],
    close_policy: "on_idle",
    synth: &[],
};

pub static S2: Scen = Scen {
    name: "#2 폴백 직후 계정 변경 — 리비전 3개·배너 1개",
    kills: &["P3", "P4"],
    covers: &["T1", "T2", "T7", "T17", "T29", "F10", "F13"],
    close_policy: "on_idle",
    synth: &["refusal-fallback"],
};

pub static S2B: Scen = Scen {
    name: "#2b 드리프트 가시화 — 계정 패치가 폴백보다 먼저",
    kills: &["P3"],
    covers: &["T29", "T7", "F13"],
    close_policy: "on_idle",
    synth: &["refusal-fallback"],
};

pub static S2C: Scen = Scen {
    name: "#2c effort만 바꾼다 (N2 전용 잠금)",
    kills: &["P3"],
    covers: &["T29", "T7"],
    close_policy: "on_idle",
    synth: &["refusal-fallback"],
};

pub static S2D: Scen = Scen {
    name: "#2d 같은 리프 충돌의 결정론",
    kills: &["P3"],
    covers: &["T29", "T7"],
    close_policy: "on_idle",
    synth: &["refusal-fallback"],
};

pub static S3: Scen = Scen {
    name: "#3 busy 중 채팅 전환 — 두 런타임이 독립",
    kills: &["P7"],
    covers: &["T1", "T2", "T7"],
    close_policy: "on_idle",
    synth: &[],
};

pub static S4: Scen = Scen {
    name: "#4 예약 큐 + 한도 소진 → 자동 이어서 (§3.4-a 회귀 잠금)",
    kills: &["P5", "P6"],
    covers: &["T1", "T2", "T7", "T16", "T17", "T27", "T30", "T25", "T26"],
    close_policy: "on_idle",
    synth: &[],
};

pub static S4B: Scen = Scen {
    name: "#4b hold 중 계정 변경 → 대기표 무효화",
    kills: &["P6"],
    covers: &["T1", "T2", "T30", "T27", "T16"],
    close_policy: "on_idle",
    synth: &[],
};

pub static S4C: Scen = Scen {
    name: "#4c hold 중 interrupt — 몇 시간 뒤 혼자 보내지 않는다",
    kills: &["P6"],
    covers: &["T1", "T2", "T30", "T13", "T14"],
    close_policy: "on_idle",
    synth: &["rate-limit-blocked(assumed)"],
};

pub static S5A: Scen = Scen {
    name: "#5a 중단 후 같은 프로세스로 2·3턴 (keep_open — 픽스처 채집 조건)",
    kills: &["P9"],
    covers: &["T1", "T2", "T13", "T14", "T16", "F1", "F19"],
    close_policy: "keep_open",
    synth: &[],
};

pub static S5B: Scen = Scen {
    name: "#5b 같은 중단, 출하 기본값(on_idle) → ColdStart + --resume",
    kills: &["P9"],
    covers: &["T1", "T2", "T13", "T14", "T25", "T26"],
    close_policy: "on_idle",
    synth: &[],
};

pub static S6: Scen = Scen {
    name: "#6 bg 살아있는 중단 — 셸은 안 죽고 큐만 비워진다",
    kills: &["P8", "P9"],
    covers: &["T1", "T2", "T13", "T14", "T16", "F13"],
    close_policy: "on_idle",
    synth: &["bg-shell"],
};

pub static S6B: Scen = Scen {
    name: "#6b 중단 후 모델 변경 → 재스폰(셸 정착)",
    kills: &["P8"],
    covers: &["T13", "T14", "T17", "T31", "F13"],
    close_policy: "on_idle",
    synth: &["bg-shell"],
};

pub static S6C: Scen = Scen {
    name: "#6c 조용한 셸 — 프로브 3갈래",
    kills: &["P8"],
    covers: &["T13", "T14", "F13"],
    close_policy: "on_idle",
    synth: &["bg-shell"],
};

pub static S7: Scen = Scen {
    name: "#7 워크플로 중 CLI 강제 종료 — 유령이 UI를 잠그지 않는다",
    kills: &["P8", "P8b", "P9"],
    covers: &["T1", "T2", "T7", "T22", "T25", "T26", "F13", "F15"],
    close_policy: "on_idle",
    synth: &["workflow"],
};

pub static S7B: Scen = Scen {
    name: "#7b 행(hang)한 CLI — 프로브 타임아웃 → 30분 추정 정착",
    kills: &["P8"],
    covers: &["T1", "T2", "T7", "T21", "F13", "F15"],
    close_policy: "on_idle",
    synth: &["workflow"],
};

pub static S7B2: Scen = Scen {
    name: "#7b′ 외부에서 죽은 워크플로 + 멀쩡한 CLI — ~93초 정착 + T20 회수",
    kills: &["P8"],
    covers: &["T1", "T2", "T7", "T21b", "T20", "F13", "F15"],
    close_policy: "on_idle",
    synth: &["workflow"],
};

pub static S7C: Scen = Scen {
    name: "#7c 강제 해제 — 우클릭 한 번으로 치운다",
    kills: &["P8"],
    covers: &["T1", "T2", "T7", "F13", "F15"],
    close_policy: "on_idle",
    synth: &["workflow"],
};

pub static S7D: Scen = Scen {
    name: "#7d 6시간 유휴 회수 — 행한 CLI의 마지막 탈출구",
    kills: &["P8"],
    covers: &["T1", "T2", "T7", "T21", "T32", "F13", "F15"],
    close_policy: "on_idle",
    synth: &["workflow"],
};

pub static S7E: Scen = Scen {
    name: "#7e 진짜 도는 dev 서버를 죽이지 않는다(거짓 양성 방지)",
    kills: &["P8"],
    covers: &["T1", "T2", "T7", "F13", "F15"],
    close_policy: "on_idle",
    synth: &["workflow"],
};

pub static S8: Scen = Scen {
    name: "#8 승인 카드 뜬 채 CLI 사망",
    kills: &["P8", "P8b"],
    covers: &["T1", "T2", "T4", "T22", "T25", "T26"],
    close_policy: "on_idle",
    synth: &[],
};

pub static S8B: Scen = Scen {
    name: "#8b 앱 종료 — 사유가 보인다",
    kills: &["P8c"],
    covers: &["T1", "T2", "T4", "T24", "T25", "T26"],
    close_policy: "on_idle",
    synth: &[],
};

pub static S8C: Scen = Scen {
    name: "#8c 같은 request_id의 control_response 2회 — 멱등",
    kills: &["P8b"],
    covers: &["T1", "T2", "T4", "T5"],
    close_policy: "on_idle",
    synth: &[],
};

pub static S9: Scen = Scen {
    name: "#9 레벨(REPLACE)↔에지(notification) 순서 뒤집기",
    kills: &["P8b"],
    covers: &["F13", "F17"],
    close_policy: "keep_open",
    synth: &[],
};

pub static S10: Scen = Scen {
    name: "#10 무음 result → 슬라이딩 보류 → 진짜 첫 토큰",
    kills: &["P8"],
    covers: &["T8", "T10", "T9", "T7"],
    close_policy: "on_idle",
    synth: &[],
};

pub static S10B: Scen = Scen {
    name: "#10b 무음이 끝까지 이어지면 ~22s에 마감",
    kills: &["P8"],
    covers: &["T8", "T10", "T11"],
    close_policy: "on_idle",
    synth: &[],
};

pub static S11: Scen = Scen {
    name: "#11 통지 재주입은 턴당 1회뿐",
    kills: &["P8"],
    covers: &["T8", "T12", "F12"],
    close_policy: "on_idle",
    synth: &[],
};

pub static S12: Scen = Scen {
    name: "#12 addDirs 순서만 다르면 재스폰 없음(P1b)",
    kills: &["P1", "P1b"],
    covers: &["T16", "T7"],
    close_policy: "keep_open",
    synth: &[],
};

pub static S13: Scen = Scen {
    name: "#13 전역 outputStyle 변경이 상주를 끊지 않는다(§2.4 물질화)",
    kills: &["P1d"],
    covers: &["T16", "T7"],
    close_policy: "keep_open",
    synth: &[],
};

pub static S13B: Scen = Scen {
    name: "#13b-A 일괄 적용: Idle 채팅 → applied",
    kills: &["P1d"],
    covers: &["T31"],
    close_policy: "keep_open",
    synth: &[],
};

pub static S13B_TURN: Scen = Scen {
    name: "#13b-B 일괄 적용: 턴 중 채팅 → deferred",
    kills: &["P1d"],
    covers: &["T7"],
    close_policy: "keep_open",
    synth: &[],
};

pub static S13B_REJ: Scen = Scen {
    name: "#13b-C 일괄 적용: 계정 없음 → rejected",
    kills: &["P1d"],
    covers: &[],
    close_policy: "keep_open",
    synth: &[],
};

pub static S16: Scen = Scen {
    name: "#16 라이브 항목 있는 채팅 삭제 = 확인 카드",
    kills: &["P7"],
    covers: &["F13"],
    close_policy: "keep_open",
    synth: &["bg-shell"],
};

pub static S17: Scen = Scen {
    name: "#17 같은 task_notification 두 번 = 정착 이벤트 1회",
    kills: &["P8b"],
    covers: &["F13", "F17"],
    close_policy: "keep_open",
    synth: &[],
};

pub static S18: Scen = Scen {
    name: "#18 init이 턴마다 재도착해도 새 세션이 아니다",
    kills: &["P9"],
    covers: &["F1", "T16"],
    close_policy: "keep_open",
    synth: &[],
};

pub static S19: Scen = Scen {
    name: "#19 폴백 3경로 순열 — 어느 순서에서도 리비전·배너 1개",
    kills: &["P3"],
    covers: &["T29"],
    close_policy: "on_idle",
    synth: &["refusal-fallback"],
};

pub static S19_DLG: Scen = Scen {
    name: "#19-1 다이얼로그 수락 경로(A)",
    kills: &["P3"],
    covers: &["T4", "T5", "T29", "F10"],
    close_policy: "on_idle",
    synth: &["refusal-fallback"],
};

pub static S19_DEC: Scen = Scen {
    name: "#19-2 다이얼로그 거절 경로(A')",
    kills: &["P3"],
    covers: &["T4", "T5"],
    close_policy: "on_idle",
    synth: &[],
};

pub static S20: Scen = Scen {
    name: "#20 중단 → 큐 비움 + 되돌리기 복원",
    kills: &["P5"],
    covers: &["T13", "T14"],
    close_policy: "keep_open",
    synth: &[],
};

pub static S21: Scen = Scen {
    name: "#21 워치독은 프로세스 생존으로 재장전되지 않는다",
    kills: &["P8"],
    covers: &["T21", "F13"],
    close_policy: "on_idle",
    synth: &["bg-shell"],
};

pub static S22: Scen = Scen {
    name: "#22 skillOverrides·deniedMcp 토글 = 재스폰",
    kills: &["P1e"],
    covers: &["T17", "T31", "F13"],
    close_policy: "keep_open",
    synth: &["bg-shell"],
};

pub static S23: Scen = Scen {
    name: "#23 원장 confidence가 send를 막지 않는다",
    kills: &["P8"],
    covers: &["T21", "T16", "F13"],
    close_policy: "keep_open",
    synth: &["bg-shell"],
};

pub static S25: Scen = Scen {
    name: "#25 initialize 20s 무응답 → T3",
    kills: &["P8"],
    covers: &["T1", "T3"],
    close_policy: "on_idle",
    synth: &[],
};

pub static S26: Scen = Scen {
    name: "#26 control_cancel_request로 카드 회수(T6) — 실와이어",
    kills: &["P8b"],
    covers: &["T4", "T6"],
    close_policy: "on_idle",
    synth: &[],
};

pub static S27: Scen = Scen {
    name: "#27 중단 6s 무응답 → T15 하드 강등",
    kills: &["P9"],
    covers: &["T13", "T15"],
    close_policy: "on_idle",
    synth: &[],
};

pub static S28: Scen = Scen {
    name: "#28 /btw 포크 후 send = ThreadChanged(정체성은 동일)",
    kills: &["P1c"],
    covers: &["T18", "T7"],
    close_policy: "keep_open",
    synth: &["bg-shell"],
};

pub static S29: Scen = Scen {
    name: "#29 compact_boundary는 다음 assistant usage와 짝지어 방출",
    kills: &[],
    covers: &["T28", "F9"],
    close_policy: "on_idle",
    synth: &["compact"],
};

pub static S29B: Scen = Scen {
    name: "#29b 짝을 못 찾은 compact는 after=null",
    kills: &[],
    covers: &["T28", "T7"],
    close_policy: "on_idle",
    synth: &["compact"],
};

pub static S30: Scen = Scen {
    name: "#30 Starting 중 interrupt = spawn 취소(T34)",
    kills: &["P7"],
    covers: &["T1", "T34"],
    close_policy: "on_idle",
    synth: &[],
};

pub static S31: Scen = Scen {
    name: "#31 task_started · notification · hook_callback",
    kills: &[],
    covers: &["F14", "F18", "F22"],
    close_policy: "on_idle",
    synth: &["task-started", "informational", "hook-callback"],
};

pub static S32: Scen = Scen {
    name: "#32 Resident interrupt(T35) — 관측/추정 두 갈래",
    kills: &["P7", "P8"],
    covers: &["T35", "F13"],
    close_policy: "on_idle",
    synth: &["bg-shell"],
};

pub static S33: Scen = Scen {
    name: "#33 프로브 30s 간격 · tick당 1회 · 중복 카드 0건",
    kills: &["P8"],
    covers: &["T21b", "T20", "F13"],
    close_policy: "on_idle",
    synth: &[],
};

pub static S24: Scen = Scen {
    name: "#24 스트림 급사 후 늦게 온 control_response",
    kills: &["P8b"],
    covers: &["T4", "T22"],
    close_policy: "on_idle",
    synth: &[],
};

pub static ALL_SCENARIOS: &[&Scen] = &[&S1, &S1B, &S2, &S2B, &S2C, &S2D, &S3, &S4, &S4B, &S4C, &S5A, &S5B, &S6, &S6B, &S6C, &S7, &S7B, &S7B2, &S7C, &S7D, &S7E, &S8, &S8B, &S8C, &S9, &S10, &S10B, &S11, &S12, &S13, &S13B, &S13B_TURN, &S13B_REJ, &S16, &S17, &S18, &S19, &S19_DLG, &S19_DEC, &S20, &S21, &S22, &S23, &S25, &S26, &S27, &S28, &S29, &S29B, &S30, &S31, &S32, &S33, &S24];

// ── ★R3 신설분 이후: 프레임 소화·상주 기상·정책 커버용 시나리오 ────────────────

pub static S34: Scen = Scen {
    name: "#34 프레임 소화 전수 — 사이드체인·도구·하트비트·stderr·미지 프레임",
    kills: &["P8b"],
    covers: &["F3", "F4", "F5", "F7", "F8", "F11", "F16", "F20", "F21", "F13"],
    close_policy: "keep_open",
    synth: &[],
};

pub static S35: Scen = Scen {
    name: "#35 CLI 자발 기상 턴(T19) · 정리 턴 재개(T19b) — 새 run_id",
    kills: &["P9"],
    covers: &["T19", "T19b", "F12", "F13"],
    close_policy: "keep_open",
    synth: &["bg-shell"],
};

pub static S36: Scen = Scen {
    name: "#36 Linger 정책 — 원장이 비어도 ms 동안 stdin 유지(T20b·T33)",
    kills: &[],
    covers: &["T20b", "T33", "F13"],
    close_policy: "linger_ms=30000",
    synth: &["bg-shell"],
};

pub static S37: Scen = Scen {
    name: "#37 stop_all — 하드 취소(T23)",
    kills: &["P7", "P8"],
    covers: &["T23", "F13"],
    close_policy: "keep_open",
    synth: &["bg-shell"],
};

// ── ★R2(크리틱 R1 대응) 신설분: 함정 A 뮤테이션 잠금 + T12 중단 가드 ────────────

pub static S38: Scen = Scen {
    name: "#38 중단 뒤 고아 통지 기상 턴 — T12가 프롬프트를 다시 밀어 넣지 않는다",
    kills: &["P8", "P9"],
    covers: &["T1", "T2", "T13", "T14", "T19", "T8", "T10", "T11", "T12", "T16", "F12", "F13"],
    close_policy: "keep_open",
    synth: &["bg-shell"],
};

pub static S39: Scen = Scen {
    name: "#39 세션 시작 모델이 기준선 — 첫 assistant의 무음 강등이 폴백으로 보인다",
    kills: &["P3"],
    covers: &["T1", "T2", "F10", "T29", "T7", "T25", "T26"],
    close_policy: "on_idle",
    synth: &[],
};

pub static S40: Scen = Scen {
    name: "#40 같은 모델의 다른 표기는 폴백이 아니다 — 재스폰 폭주 금지(함정 A)",
    kills: &["P1", "P3"],
    covers: &["T1", "T2", "F10", "T7", "T16"],
    close_policy: "keep_open",
    synth: &[],
};

pub static S41: Scen = Scen {
    name: "#41 init이 모델을 안 실으면 첫 관측이 기준선(별칭 불일치도 폴백 아님)",
    kills: &["P3"],
    covers: &["T1", "T2", "F10", "T7", "T16"],
    close_policy: "keep_open",
    synth: &[],
};

pub static ALL_SCENARIOS_EXTRA: &[&Scen] =
    &[&S34, &S35, &S36, &S37, &S38, &S39, &S40, &S41];
