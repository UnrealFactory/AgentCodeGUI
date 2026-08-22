//! 허브 — **`ChatRuntime`을 소유하는 단 하나의 스레드**와 그 펌프.
//!
//! ## 왜 스레드 하나인가 (선택이 아니라 타입의 요구)
//!
//! `ChatRuntime`은 내부에 `Rc<RefCell<LiveLedger>>` / `Rc<RefCell<EventSink>>`를 들고 있다
//! (`ccg-engine/src/runtime.rs:211`). 즉 **`!Send`**다 — 스레드를 넘길 수 없고, `Mutex`로
//! 감싼다고 넘어가지도 않는다. 그래서 구조가 강제된다:
//!
//! ```text
//!  IPC 스레드(N개)  ──Job──▶  [허브 스레드 1개]  ──emit──▶  창들
//!                   ◀─Value─   런타임 소유 · 틱 · 프레임 탭
//! ```
//!
//! ## 락 규율 (데드락 방지 — 이 파일의 계약)
//!
//! 1. **런타임에는 락이 없다.** 소유자가 하나뿐이라 필요가 없다. 다른 스레드가
//!    런타임을 만지는 경로 자체가 존재하지 않는다(타입이 막는다).
//! 2. **허브는 IPC를 기다리지 않는다.** 응답은 `Sender<Value>`로 **던지고 잊는다**.
//!    수신자가 이미 포기했으면 `send`가 실패하고, 허브는 그걸 무시한다.
//! 3. **IPC는 허브를 무한정 기다리지 않는다.** `recv_timeout([REPLY_TIMEOUT])` —
//!    허브가 프레임 폭주로 늦어도 UI 스레드가 물리지 않는다(안전값 반환).
//! 4. **스토어 락은 잎(leaf)이다.** `ccg_store::{status,chats_v3,boards}`의 내부
//!    `Mutex`는 **허브 스레드에서만** 잡히고, 스토어 코드는 허브로 되돌아오지 않는다
//!    (콜백·이벤트 없음). 그래서 `허브 → 스토어` 한 방향뿐이고 순환이 없다.
//!    ※ 예외 하나: `ipc/unified.rs`의 조회 채널도 스토어 락을 잡는다. 그쪽은 IPC
//!    스레드지만 **허브 락을 잡지 않으므로**(2·3에 의해) 두 락이 교차 대기하지 않는다.
//! 5. **`app.emit*`은 허브에서 부른다.** Tauri의 emit은 동기 콜백을 되부르지 않는다
//!    (렌더러로 직렬화해 보낼 뿐) — 그래서 허브 안에서 안전하다. 반대로 emit 안에서
//!    IPC 핸들러가 도는 일은 없다.
//! 6. **프레임 수신 스레드는 런타임을 모른다.** `ClaudeDriver`가 stdout마다 리더
//!    스레드를 띄우지만(`driver.rs:330`) 그 스레드는 `mpsc::Sender<Value>`에만 쓴다.
//!    스토어에도, 원장에도 닿지 않는다 — "프레임 스레드에서 스토어 쓰기 락"이라는
//!    데드락 후보는 **구조적으로 없다**.
//!
//! ## 승인 무응답 = 영구 정지
//!
//! `AwaitingUser`에는 타임아웃이 **없다**. 그게 그 상태의 정의다(m-logic §3.2).
//! 이 파일 어디에도 승인 카드를 자동으로 닫는 타이머가 없어야 한다 — 있으면 사용자가
//! 자리를 비운 사이 도구가 저절로 실행되거나 거부된다.

use super::{ident, lite, wire::Wire};
use ccg_engine::clock::SystemClock;
use ccg_engine::driver::{ClaudeDriver, CliDriver};
use ccg_engine::event::{Event, RevisionOrigin, TerminalStatus, Verdict};
use ccg_engine::identity::{ApplyPolicy, PendingOp, RawIdentityPatch, RunIdentity};
use ccg_engine::live::{AskKind, CloseCause};
use ccg_engine::runtime::{ChatRuntime, Cmd};
use ccg_engine::state::StateTag;
use serde_json::{json, Map, Value};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// IPC가 허브 응답을 기다리는 상한. 넘으면 안전값을 돌려준다(§ 락 규율 3).
const REPLY_TIMEOUT: Duration = Duration::from_secs(3);
/// 스트림이 살아 있을 때의 틱 간격. 프레임 지연의 상한이다.
const TICK_ACTIVE: Duration = Duration::from_millis(20);
/// 런타임은 있지만 스트림이 없을 때(상주/유휴) — 타이머만 돌면 된다.
const TICK_IDLE: Duration = Duration::from_millis(250);
/// 런타임이 하나도 없을 때 — 사실상 잠든다(부팅 직후 · 벤치의 유휴 측정 구간).
const TICK_SLEEP: Duration = Duration::from_millis(2000);

// ── 잡 ───────────────────────────────────────────────────────────────────────

pub enum Op {
    /// 옛 `claude:run` / `ma:run` / `session:run` — 정체성 패치 + 전송.
    Run(Value),
    Cmd(Cmd),
    /// 카드 응답. `payload`가 있으면 그 본문 그대로 나간다(2.6.2 파리티 — §4.4a).
    Respond {
        kind: AskKind,
        request_id: String,
        accept: bool,
        payload: Option<Value>,
        /// 질문 카드에서 사용자가 **고른 라벨**(원문). 폴백 확인 다이얼로그를 질문
        /// 카드로 그렸을 때 수락/취소를 가르는 유일한 근거다(§4.4b).
        answer_text: Option<String>,
    },
    IdentityGet,
    IdentitySet {
        patch: RawIdentityPatch,
        policy: ApplyPolicy,
        op: PendingOp,
        corr: Option<String>,
    },
    IdentityRevert(u32),
    /// 큐 조작 — `{op:'remove'|'clear'|'restore', id?|token?}`.
    QueueMutate(Value),
    ForceSettle(String),
    Dispose,
    /// 진단 — 런타임 수·상태(하네스가 읽는다).
    /// (전 채팅 상태 스냅샷은 허브를 거치지 않는다 — `chats:get`이 `status.json`에서
    ///  합쳐 주고, 그게 렌더러가 마운트 직후 따라잡는 경로다.)
    Debug,
}

pub struct Job {
    pub chat: String,
    pub op: Op,
    pub reply: Option<Sender<Value>>,
}

static TX: OnceLock<Mutex<Option<Sender<Job>>>> = OnceLock::new();

fn tx_slot() -> &'static Mutex<Option<Sender<Job>>> {
    TX.get_or_init(|| Mutex::new(None))
}

fn send_job(job: Job) -> bool {
    let g = tx_slot().lock().unwrap_or_else(|e| e.into_inner());
    match g.as_ref() {
        Some(tx) => tx.send(job).is_ok(),
        None => false,
    }
}

/// 응답이 필요한 호출. 허브가 죽었거나 늦으면 `Value::Null`.
pub fn call(chat: &str, op: Op) -> Value {
    let (tx, rx) = channel::<Value>();
    if !send_job(Job {
        chat: chat.to_string(),
        op,
        reply: Some(tx),
    }) {
        return Value::Null;
    }
    rx.recv_timeout(REPLY_TIMEOUT).unwrap_or(Value::Null)
}

/// 응답이 필요 없는 호출(전송·중단·응답 등).
pub fn cast(chat: &str, op: Op) {
    let _ = send_job(Job {
        chat: chat.to_string(),
        op,
        reply: None,
    });
}

// ── 채팅 슬롯 ────────────────────────────────────────────────────────────────

struct Slot {
    rt: ChatRuntime<super::tap::TapDriver>,
    /// 이번 틱에 지나간 원시 프레임(→ `wire`가 2.6.2 이벤트로 번역).
    tap: Rc<RefCell<Vec<Value>>>,
    wire: Wire,
    terminal: lite::Terminal,
    last_lite: Value,
    run_seq: u64,
    /// 아직 `chat:run-state`에 실리지 않은 정착 목록. `Event::Settled`는 항목마다
    /// 따로 오고 `Event::RunState`는 그 뒤에 온다 — 계약면(§5.6)의 `settled[]`를
    /// 채우려면 사이에 모아 둬야 한다. R1은 이 배열이 **항상 비어 있었다**.
    pending_settled: Vec<Value>,
}

struct Hub {
    app: AppHandle,
    slots: HashMap<String, Slot>,
    job: Option<Arc<ccg_engine::job::Job>>,
    cli: std::path::PathBuf,
    /// **팬아웃 라우팅 캐시**(크리틱 배선 R1 F8).
    ///
    /// R1의 `fanout()`은 이벤트 하나마다 디스크를 두 번 읽었다 — `active_chat_id()`가
    /// `chats-v3/index.json`을, `panel_id_for_chat()`이 **보드 파일 전수**를 읽고
    /// 캐시를 `clear()` 후 재삽입했다. 한 턴의 델타가 수십 개라 스트리밍 구간 내내
    /// 파일 I/O 2종 + HashMap 재구축이 돌았다.
    ///
    /// **무효화 규약** — 이 캐시는 *펌프 한 바퀴* 동안만 유효하다:
    ///  1. `pump()` 진입마다 통째로 버린다(= 최대 수명 20ms).
    ///  2. `handle()`이 잡을 처리하면 버린다 — `chats:set-active`·`board:save`가
    ///     **다른 스레드**에서 스토어를 갈아도, 그 뒤 첫 이벤트는 새 값을 읽는다.
    ///  3. 값 자체는 스토어가 진실이다. 여기 없으면 항상 스토어에 묻는다.
    route: RouteCache,
}

#[derive(Default)]
struct RouteCache {
    active: Option<String>,
    panel: HashMap<String, Option<String>>,
}

impl RouteCache {
    fn clear(&mut self) {
        self.active = None;
        self.panel.clear();
    }
}

/// `claude.exe` 경로 — 앱 홈의 활성 엔진 버전(2.6.2 `config.json.activeVersion`).
fn cli_path() -> std::path::PathBuf {
    let home = ccg_store::app_home();
    let ver = ccg_store::read_home_json("config.json")
        .and_then(|v| v.get("activeVersion").and_then(Value::as_str).map(str::to_string));
    if let Some(v) = ver {
        let p = home
            .join("engines")
            .join(&v)
            .join("node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe");
        if p.exists() {
            return p;
        }
    }
    // 설치된 엔진이 없으면 PATH에 맡긴다 — 스폰 실패는 T3가 사용자에게 보이는 문장으로 낸다.
    std::path::PathBuf::from("claude.exe")
}

impl Hub {
    /// 이 채팅의 런타임을 보장한다. 정체성은 **디스크의 물질화값**이 1순위,
    /// 없으면 전역값으로 물질화한다(m-logic §2.4 규약 2).
    fn ensure(&mut self, chat: &str) -> Option<&mut Slot> {
        if !self.slots.contains_key(chat) {
            let raw = ident::raw_from_disk(chat).unwrap_or_else(|| ident::raw_default(""));
            let defaults = ident::defaults();
            let dump = std::env::var("CCG_ENGINE_LOG")
                .ok()
                .filter(|s| !s.is_empty())
                .map(std::path::PathBuf::from);
            let (tap_drv, tapped) = super::tap::TapDriver::new(ClaudeDriver::new(self.job.clone(), dump));
            let rt = match ChatRuntime::new(
                chat.to_string(),
                raw,
                defaults,
                Arc::new(SystemClock::default()),
                tap_drv,
            ) {
                Ok(rt) => rt,
                Err(e) => {
                    // 정규화 실패(폴더 없음·계정 없음)는 **거부 사유**로 화면에 낸다.
                    // 런타임을 못 만들었으므로 채팅은 여전히 정체성 미해결 상태다.
                    self.emit_all(
                        crate::ipc::ch::CHAT_VERDICT,
                        json!({ "chatId": chat, "verdict": { "kind": "rejected",
                                "reason": format!("{e:?}"), "cmd": "ensure" } }),
                    );
                    return None;
                }
            };
            let rt = rt.with_cli_path(self.cli.clone()).with_home(ccg_store::app_home());
            self.slots.insert(
                chat.to_string(),
                Slot {
                    rt,
                    tap: tapped,
                    wire: Wire::default(),
                    terminal: lite::Terminal::None,
                    last_lite: Value::Null,
                    run_seq: 0,
                    pending_settled: vec![],
                },
            );
        }
        self.slots.get_mut(chat)
    }

    fn emit_all(&self, channel: &str, payload: Value) {
        let _ = self.app.emit(channel, payload);
    }

    /// 2.6.2 렌더러가 구독한 이름으로 이벤트를 보낸다 + 3.0 봉투(`chat:event`)를 함께.
    ///
    /// 창 라우팅(§6.1 "창 라우팅은 `chatId → label` 역인덱스"): 본채팅은 메인 창,
    /// 추가 채팅은 그 창, 멀티 패널은 `panelId` 봉투. 어느 것도 아니면 봉투만 나간다.
    fn fanout(&mut self, chat: &str, ev: Value) {
        let _ = self.app.emit(
            crate::ipc::ch::CHAT_EVENT,
            json!({ "chatId": chat, "event": ev.clone() }),
        );
        let active = match &self.route.active {
            Some(a) => a.clone(),
            None => {
                let a = super::active_chat_id();
                self.route.active = Some(a.clone());
                a
            }
        };
        if active == chat {
            let _ = self
                .app
                .emit_to(crate::win::MAIN, crate::ipc::ch::ENGINE_EVENT, ev.clone());
        }
        // 창 레지스트리는 메모리 `Mutex<Vec<_>>`라 디스크를 안 탄다 — 캐시 대상이 아니다.
        if let Some(label) = crate::win::session_label_for_chat(chat) {
            let _ = self.app.emit_to(label.as_str(), crate::ipc::ch::SESSION_EVENT, ev.clone());
        }
        let panel = match self.route.panel.get(chat) {
            Some(p) => p.clone(),
            None => {
                let p = super::panel_id_for_chat(chat);
                self.route.panel.insert(chat.to_string(), p.clone());
                p
            }
        };
        if let Some(panel) = panel {
            let _ = self
                .app
                .emit(crate::ipc::ch::MA_EVENT, json!({ "panelId": panel, "event": ev }));
        }
    }

    fn handle(&mut self, job: Job) {
        // 명령은 스토어를 갈 수 있다(`chats:set-active`·`board:save`는 다른 스레드지만
        // 사용자 조작은 같은 순간에 온다) — 라우팅 캐시를 여기서 버린다(무효화 규약 2).
        self.route.clear();
        let Job { chat, op, reply } = job;
        let answer = |v: Value| {
            if let Some(tx) = &reply {
                let _ = tx.send(v);
            }
        };
        match op {
            Op::Debug => {
                let rows: Vec<Value> = self
                    .slots
                    .iter()
                    .map(|(id, s)| {
                        json!({ "chatId": id, "state": format!("{:?}", s.rt.state()),
                                "queued": s.rt.queue_len(), "spawns": s.rt.spawns,
                                "exits": s.rt.exits, "session": s.rt.session_id(),
                                "pid": s.rt.driver_ref().pid() })
                    })
                    .collect();
                answer(json!({ "chats": rows, "cli": self.cli.to_string_lossy() }));
                return;
            }
            Op::Dispose => {
                if let Some(mut s) = self.slots.remove(&chat) {
                    s.rt.dispatch(Cmd::Dispose);
                    s.rt.app_quit();
                }
                answer(json!(true));
                return;
            }
            _ => {}
        }

        let Some(slot) = self.ensure(&chat) else {
            answer(Value::Null);
            return;
        };

        match op {
            Op::Run(req) => {
                // ① 요청이 실어 온 picker → 정체성 패치. 저자는 여전히 하나(런타임)다.
                let patch = ident::patch_from_run_request(&req);
                if !patch.is_empty() {
                    slot.rt.dispatch(Cmd::IdentitySet {
                        patch,
                        // 턴 중이면 상태기계가 알아서 예약(deferred)으로 접수한다(§4.2).
                        policy: ApplyPolicy::Now,
                        op: PendingOp::Merge,
                    });
                }
                // ② 스레드 이어붙이기 — 재시작 후 첫 전송은 **저장된 sessionId**로 잇는다.
                //    이게 없으면 대화가 살아 있어도 CLI는 처음 보는 스레드로 답한다.
                if let Some(r) = req.get("resume").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                    if slot.rt.thread.session_id.is_none() {
                        slot.rt.thread.session_id = Some(r.to_string());
                        slot.rt.thread.cwd_at_bind = req.get("cwd").and_then(Value::as_str).map(str::to_string);
                    }
                    if req.get("forkSession").and_then(Value::as_bool) == Some(true)
                        && !slot.rt.thread.fork_consumed
                    {
                        slot.rt.thread.want_fresh = true;
                    }
                }
                // ③ runId 발급 — 렌더러가 이벤트를 자기 실행에 붙이는 키.
                slot.run_seq += 1;
                let run_id = format!("r{}-{}", std::process::id(), slot.run_seq);
                let first = slot.wire.begin_run(&run_id);
                slot.terminal = lite::Terminal::None;
                let prompt = req.get("prompt").and_then(Value::as_str).unwrap_or("").to_string();
                // 판정 방출은 **런타임 하나**가 한다(`Event::Verdict` → `on_engine_event`).
                // R1은 여기서도 쐈고 `runtime.rs`의 `dispatch`가 무조건 또 쐈다 —
                // 전송 1회에 `send:accepted` 2건(크리틱 배선 R1 F6). 구독자가 붙는 순간
                // 거부 사유가 두 번 뜬다. 저자를 하나로 줄인다.
                let _ = slot.rt.dispatch(Cmd::Send { text: prompt });
                let chat_id = chat.clone();
                self.fanout(&chat_id, first);
                answer(json!(run_id));
            }
            Op::Cmd(cmd) => {
                let name = cmd.name();
                let v = slot.rt.dispatch(cmd);
                // 판정 방출은 런타임 하나 — 여기서는 **호출자에게 돌려주기만** 한다(F6).
                answer(verdict_wire(name, &v));
            }
            Op::Respond {
                kind,
                request_id,
                accept,
                payload,
                answer_text,
            } => {
                // ★ 폴백 확인 다이얼로그는 2.6.2 렌더러에 카드가 없어 **질문 카드**로
                //   그렸다(wire.rs). 그러면 답이 질문 채널로 돌아온다 — 원장은 그것을
                //   `Dialog`로 알고 있으므로 종류가 어긋나 `wrong_card_kind`로 튕긴다.
                //   어긋남을 푸는 것은 원장을 볼 수 있는 **셸**의 몫이다(§4.4b 응답 어휘도
                //   질문과 다르다: `{behavior:'completed'|'cancelled'}`).
                let real = slot.rt.ask_kind_of(&request_id);
                let mut cancelled_from: Option<String> = None;
                let (kind, accept, payload) = if kind == AskKind::Question
                    && real == Some(AskKind::Dialog)
                {
                    let accept = match (slot.wire.dialog(&request_id), answer_text.as_deref()) {
                        (Some(d), Some(t)) => t.contains(&d.accept_label),
                        // 답 없이 닫았다 = 취소(§4.4b — `cancelled`가 진짜 정착이다).
                        _ => false,
                    };
                    let card = slot.wire.take_dialog(&request_id);
                    if !accept {
                        cancelled_from = card.map(|c| c.from_model);
                    }
                    let body = if accept {
                        json!({ "behavior": "completed", "result": "retry_fallback" })
                    } else {
                        json!({ "behavior": "cancelled" })
                    };
                    (AskKind::Dialog, accept, Some(body))
                } else {
                    (kind, accept, payload)
                };
                if let Some(p) = payload {
                    slot.rt.stage_respond_payload(&request_id, p);
                }
                let v = slot.rt.dispatch(Cmd::Respond {
                    kind,
                    request_id,
                    accept,
                });
                let run = slot.wire.run_id.clone();
                // 수락은 엔진이 `FallbackBanner`로 말한다(§6.2 경로 A). 취소는
                // 아무도 말하지 않으므로 여기서 한 줄 남긴다 — 침묵 금지(D7).
                if let Some(from) = cancelled_from {
                    let chat_id = chat.clone();
                    self.fanout(
                        &chat_id,
                        json!({ "type": "notice", "runId": run,
                                "text": format!("폴백을 취소했어요 — {from} 이(가) 거부한 채로 턴을 마칩니다.") }),
                    );
                }
                answer(verdict_wire("respond", &v));
            }
            Op::IdentityGet => {
                answer(identity_state(&slot.rt));
            }
            Op::IdentitySet {
                patch,
                policy,
                op,
                corr,
            } => {
                let before = slot.rt.revision();
                let v = slot.rt.dispatch(Cmd::IdentitySet { patch, policy, op });
                let mut w = verdict_wire("identity_set", &v);
                if let Some(o) = w.as_object_mut() {
                    o.insert("identity".into(), ident::identity_wire(slot.rt.identity()));
                    o.insert("revision".into(), json!(slot.rt.revision()));
                    o.insert("changed".into(), json!(slot.rt.revision() != before));
                    if let Some(c) = corr {
                        o.insert("corrId".into(), json!(c));
                    }
                }
                answer(w);
            }
            Op::IdentityRevert(to) => {
                let v = slot.rt.dispatch(Cmd::IdentityRevert { to });
                let mut w = verdict_wire("identity_revert", &v);
                if let Some(o) = w.as_object_mut() {
                    o.insert("identity".into(), ident::identity_wire(slot.rt.identity()));
                    o.insert("revision".into(), json!(slot.rt.revision()));
                }
                answer(w);
            }
            Op::QueueMutate(spec) => {
                // 되돌리기(`restore`)만 전용 명령이 있다 — 나머지는 큐 변형 1건으로 접수한다.
                let v = match spec.get("op").and_then(Value::as_str) {
                    Some("restore") => slot.rt.dispatch(Cmd::QueueRestore {
                        token: spec.get("token").and_then(Value::as_str).unwrap_or("").to_string(),
                    }),
                    _ => slot.rt.dispatch(Cmd::QueueMutate),
                };
                answer(verdict_wire("queue.mutate", &v));
            }
            Op::ForceSettle(id) => {
                let v = slot.rt.dispatch(Cmd::ForceSettle { id });
                answer(verdict_wire("force_settle", &v));
            }
            Op::Debug | Op::Dispose => unreachable!("위에서 처리"),
        }
    }

    /// 한 바퀴: 모든 런타임 tick → 프레임 번역 → 엔진 이벤트 → 상태 lite.
    fn pump(&mut self) {
        // 라우팅 캐시의 수명은 이 한 바퀴다(무효화 규약 1) — 최대 20ms 낡는다.
        self.route.clear();
        let chats: Vec<String> = self.slots.keys().cloned().collect();
        for chat in chats {
            let (frames, events, evs_state) = {
                let Some(slot) = self.slots.get_mut(&chat) else { continue };
                slot.rt.tick();
                // stderr 한 줄도 상태기계의 프레임 최신성 근거가 아니다(F20) — 진단만.
                let errs = slot.rt.driver().drain_stderr();
                for l in errs {
                    slot.rt.on_stderr(&l);
                }
                let frames: Vec<Value> = slot.tap.borrow_mut().drain(..).collect();
                let mut out: Vec<Value> = vec![];
                for f in &frames {
                    out.extend(slot.wire.translate(f));
                }
                let evs = slot.rt.drain_events();
                (frames.len(), out, evs)
            };
            let _ = frames;
            // ① 내용(2.6.2 EngineEvent) — 렌더러가 그리는 것.
            for ev in events {
                self.fanout(&chat, ev);
            }
            // ② 상태·판정(3.0 브로드캐스트) + 2.6.2가 아는 몇 가지로의 번역.
            for e in evs_state {
                self.on_engine_event(&chat, e);
            }
            // ③ ChatStatusLite — 바뀐 것만.
            self.refresh_lite(&chat);
        }
    }

    fn on_engine_event(&mut self, chat: &str, e: Event) {
        match e {
            Event::RunState {
                state,
                resident_why,
                run_id,
                live,
                ledger_confidence,
                settled,
            } => {
                // §5.6 `settled[]`는 **사유를 UI가 문장으로 만드는 재료**다. 엔진은
                // 항목마다 `Event::Settled`를 따로 내고 REPLACE는 그 뒤에 오므로,
                // 사이에 모아 둔 것을 여기서 합친다(R1은 이 배열이 항상 비어 있었다).
                let mut rows: Vec<Value> = settled
                    .iter()
                    .map(|s| json!({ "id": s.id, "kind": s.kind, "reason": s.reason.wire() }))
                    .collect();
                if let Some(slot) = self.slots.get_mut(chat) {
                    rows.append(&mut slot.pending_settled);
                }
                let payload = json!({
                    "chatId": chat,
                    "state": state_wire(state),
                    "residentWhy": resident_why.map(|w| serde_json::to_value(w).unwrap_or(Value::Null)),
                    "runId": run_id.map(|r| r.0),
                    "live": live.iter().map(live_wire).collect::<Vec<_>>(),
                    "ledgerConfidence": serde_json::to_value(ledger_confidence).unwrap_or(Value::Null),
                    "settled": rows,
                });
                self.emit_all(crate::ipc::ch::CHAT_RUN_STATE, payload);
            }
            Event::Settled { id, kind, reason, .. } => {
                if let Some(slot) = self.slots.get_mut(chat) {
                    slot.pending_settled.push(
                        json!({ "id": id.to_string(), "kind": kind, "reason": reason.wire() }),
                    );
                }
            }
            // ★ T22 착지 — 여기가 "카드 해제 · busy 해제 · 사유 안내"가 화면으로 나가는
            //   유일한 자리다(m-logic §5.2·§5.6). 사용자 의사로 닫힌 경로와 재스폰은
            //   각자 자기 안내가 이미 있으므로 **말을 두 번 하지 않는다**.
            Event::Exit { cause, .. } => {
                let unexpected = matches!(
                    cause,
                    CloseCause::CliExit
                        | CloseCause::Crash
                        | CloseCause::ExternalKill
                        | CloseCause::HardCancel
                        | CloseCause::SpawnFailed
                        | CloseCause::IdleReclaim
                );
                if !unexpected {
                    return;
                }
                let evs = {
                    let Some(slot) = self.slots.get_mut(chat) else { return };
                    let n = slot.pending_settled.len();
                    let wire = format!("{cause:?}");
                    slot.wire.stream_closed(&to_snake(&wire), n)
                };
                for ev in evs {
                    self.fanout(chat, ev);
                }
                // 종결 표시값도 여기서 확정한다 — 완료도 오류도 아닌 "끊김"이다.
                if let Some(slot) = self.slots.get_mut(chat) {
                    slot.terminal = lite::Terminal::Error;
                }
            }
            Event::Identity {
                origin,
                revision,
                changed,
                drifted,
                kept_by_fallback,
                ..
            } => {
                let identity = self
                    .slots
                    .get(chat)
                    .map(|s| ident::identity_wire(s.rt.identity()))
                    .unwrap_or(Value::Null);
                self.emit_all(
                    crate::ipc::ch::CHAT_IDENTITY,
                    json!({
                        "chatId": chat,
                        "identity": identity,
                        "pending": Value::Null,
                        "revision": revision,
                        "origin": origin_wire(&origin),
                        "changed": changed,
                        "driftedFields": drifted,
                        "keptByFallback": kept_by_fallback,
                    }),
                );
                // 정체성은 Rust 소유 필드다 — 디스크의 되끼움 값도 같이 세운다(§4.1 규약 2).
                if let Some(s) = self.slots.get(chat) {
                    let raw = serde_json::to_value(s.rt.identity().to_raw()).unwrap_or(Value::Null);
                    ccg_store::chats_v3::set_owned(chat, "identity", raw);
                }
            }
            Event::Queue { items, .. } => {
                self.emit_all(
                    crate::ipc::ch::CHAT_QUEUE,
                    json!({ "chatId": chat, "queue": items }),
                );
            }
            Event::Verdict { cmd, verdict } => {
                self.emit_all(
                    crate::ipc::ch::CHAT_VERDICT,
                    json!({ "chatId": chat, "verdict": verdict_wire(cmd, &verdict) }),
                );
            }
            Event::Status { status, .. } => {
                // 2.6.2 렌더러의 상태 칩. runId는 와이어가 들고 있는 문자열을 쓴다.
                // `Aborted`는 2.6.2 어휘에 없다 — 와이어로는 `done`(중단 마커는 렌더러의
                // 로컬 리듀서가 이미 붙였다), **영속값은 `Terminal::Aborted`**로 가른다.
                let (run, s) = (
                    self.slots.get(chat).map(|s| s.wire.run_id.clone()).unwrap_or_default(),
                    match status {
                        TerminalStatus::Done | TerminalStatus::Aborted => "done",
                        TerminalStatus::Error => "error",
                    },
                );
                if let Some(slot) = self.slots.get_mut(chat) {
                    slot.terminal = match status {
                        TerminalStatus::Done => lite::Terminal::Done,
                        TerminalStatus::Aborted => lite::Terminal::Aborted,
                        TerminalStatus::Error => lite::Terminal::Error,
                    };
                }
                self.fanout(chat, json!({ "type": "status", "runId": run, "status": s }));
            }
            Event::Notice(text) => {
                let run = self.slots.get(chat).map(|s| s.wire.run_id.clone()).unwrap_or_default();
                self.fanout(chat, json!({ "type": "notice", "runId": run, "text": text }));
            }
            Event::FallbackBanner {
                from_model,
                to_model,
                via,
                revert_to,
            } => {
                let run = self.slots.get(chat).map(|s| s.wire.run_id.clone()).unwrap_or_default();
                self.fanout(
                    chat,
                    json!({
                        "type": "model-fallback", "runId": run,
                        "fromModel": from_model, "toModel": to_model,
                        "text": format!("{from_model} 이(가) 응답을 거부해 {to_model} 로 전환했어요"),
                        "retractMessageId": Value::Null,
                        "via": format!("{via:?}"), "revertTo": revert_to,
                    }),
                );
            }
            Event::RespawnNotice { text, .. } => {
                let run = self.slots.get(chat).map(|s| s.wire.run_id.clone()).unwrap_or_default();
                self.fanout(chat, json!({ "type": "notice", "runId": run, "text": text }));
            }
            // 나머지(StateAssign·ProbeSent·EvidenceRearm·Settled·AskOpened/Closed·Spawn·
            // Exit·CloseInput·Compact·UnknownFrameDropped…)는 `chat:run-state`가 REPLACE로
            // 이미 싣거나 진단 전용이다 — 채널을 늘리지 않는다(§6.1 32채널).
            _ => {}
        }
    }

    fn refresh_lite(&mut self, chat: &str) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let Some(slot) = self.slots.get_mut(chat) else { return };
        let mut next = lite::build(&slot.rt, slot.terminal, now);
        // updatedAt만 다른 것은 "바뀐 것"이 아니다(매 틱 브로드캐스트 방지).
        let same = {
            let mut a = next.clone();
            let mut b = slot.last_lite.clone();
            for v in [&mut a, &mut b] {
                if let Some(o) = v.as_object_mut() {
                    o.remove("updatedAt");
                }
            }
            a == b
        };
        if same {
            return;
        }
        if let Some(o) = next.as_object_mut() {
            o.insert("updatedAt".into(), json!(now));
        }
        slot.last_lite = next.clone();
        ccg_store::status::set(chat, next);
        let all = super::status_array();
        self.emit_all(crate::ipc::ch::CHAT_STATUS, all);
    }

    /// 다음 틱까지의 대기. **`Resident`는 유휴다.**
    ///
    /// R1은 두 갈래가 **모두** `TICK_ACTIVE`로 떨어졌다(첫 조건의 `!= Resident`를 둘째
    /// 분기가 되돌렸다) — 상주 경로가 배선되는 순간 허브가 50Hz로 상시 회전한다
    /// (크리틱 배선 R1 F10). `Resident`는 턴이 없고 타이머만 도는 상태라 250ms면 된다:
    /// 그 상태의 가장 짧은 아크는 `Linger`(밀리초 단위 정밀도 불필요)이고, 프레임이
    /// 오면 CLI가 스스로 깨우는 게 아니라 우리가 폴링하므로 **프레임 지연 상한**만
    /// 250ms가 된다. 상주 중에는 렌더링할 스트림이 없으므로 그 지연은 보이지 않는다.
    fn wait(&self) -> Duration {
        if self.slots.is_empty() {
            return TICK_SLEEP;
        }
        let has_stream = self
            .slots
            .values()
            .any(|s| !matches!(s.rt.state(), StateTag::Idle | StateTag::Resident));
        if has_stream {
            TICK_ACTIVE
        } else {
            TICK_IDLE
        }
    }
}

// ── 와이어 변환 헬퍼 ─────────────────────────────────────────────────────────

fn state_wire(s: StateTag) -> &'static str {
    match s {
        StateTag::Idle => "idle",
        StateTag::Starting => "starting",
        StateTag::Streaming => "streaming",
        StateTag::AwaitingUser => "awaiting_user",
        StateTag::HeldResult => "held_result",
        StateTag::Interrupting => "interrupting",
        StateTag::Resident => "resident",
        // `Ended`는 계약면에 없다 — T26이 같은 tick에 idle로 내보내므로 과도값이다.
        StateTag::Terminating | StateTag::Ended => "terminating",
    }
}

/// `ExternalKill` → `external_kill`. `CloseCause`의 와이어 표기는 `SettleReason::wire()`가
/// 이미 소문자로 쓰므로(`stream_closed:externalkill`) 여기서는 사람이 읽을 키로 쪼갠다.
fn to_snake(camel: &str) -> String {
    let mut out = String::with_capacity(camel.len() + 4);
    for (i, c) in camel.chars().enumerate() {
        if c.is_uppercase() {
            if i > 0 {
                out.push('_');
            }
            out.extend(c.to_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

fn origin_wire(o: &RevisionOrigin) -> String {
    match o {
        RevisionOrigin::Default => "default".into(),
        RevisionOrigin::User => "user".into(),
        RevisionOrigin::EngineFallback(_) => "engine_fallback".into(),
        RevisionOrigin::DeferredApply => "deferred_apply".into(),
        RevisionOrigin::Revert(_) => "revert".into(),
        RevisionOrigin::Restore => "restore".into(),
    }
}

fn live_wire(w: &ccg_engine::event::LiveWire) -> Value {
    let mut m = Map::new();
    m.insert("id".into(), json!(w.id));
    m.insert("kind".into(), serde_json::to_value(w.kind).unwrap_or(Value::Null));
    m.insert("label".into(), json!(w.label));
    m.insert("liveness".into(), serde_json::to_value(w.liveness).unwrap_or(Value::Null));
    m.insert("gating".into(), serde_json::to_value(w.gating).unwrap_or(Value::Null));
    m.insert("bornRunId".into(), json!(w.born_run.0));
    if let Some(a) = &w.ask {
        m.insert(
            "ask".into(),
            json!({
                "askKind": serde_json::to_value(a.ask_kind).unwrap_or(Value::Null),
                "requestId": a.request_id,
                "toolUseId": a.tool_use_id,
                "dialogKind": a.dialog_kind,
            }),
        );
    }
    Value::Object(m)
}

fn verdict_wire(cmd: &str, v: &Verdict) -> Value {
    let (kind, reason) = match v {
        Verdict::Accepted => ("accepted", None),
        Verdict::Queued => ("queued", None),
        Verdict::Deferred(at) => ("deferred", Some(*at)),
        Verdict::NeedsConfirm => ("needs_confirm", None),
        Verdict::Rejected(r) => ("rejected", Some(*r)),
        Verdict::Noop => ("noop", None),
        Verdict::Applied => ("applied", None),
    };
    json!({ "cmd": cmd, "kind": kind, "reason": reason })
}

fn identity_state<D: CliDriver>(rt: &ChatRuntime<D>) -> Value {
    json!({
        "chatId": rt.chat_id,
        "identity": ident::identity_wire(rt.identity()),
        "raw": serde_json::to_value(rt.identity_raw()).unwrap_or(Value::Null),
        "pending": rt.pending_preview().map(|p: &RunIdentity| ident::identity_wire(p)),
        "revision": rt.revision(),
        "unresolved": rt.unresolved.map(|r| serde_json::to_value(r).unwrap_or(Value::Null)),
        "state": state_wire(rt.state()),
        "queued": rt.queue_len(),
    })
}

// ── 기동 / 종료 ──────────────────────────────────────────────────────────────

/// 허브 스레드를 띄운다(프로세스당 1회). 실패하면 엔진 채널은 전부 안전값으로 떨어진다.
pub fn start(app: AppHandle) {
    let mut g = tx_slot().lock().unwrap_or_else(|e| e.into_inner());
    if g.is_some() {
        return;
    }
    let (tx, rx) = channel::<Job>();
    *g = Some(tx);
    drop(g);

    std::thread::Builder::new()
        .name("ccg-engine-hub".into())
        .spawn(move || {
            // job object(KILL_ON_JOB_CLOSE) — 앱이 죽으면 커널이 claude.exe와 손자까지
            // 거둔다. 만들지 못해도 계속 간다(좀비 위험은 로그로만 남긴다).
            let job = match ccg_engine::job::Job::create() {
                Ok(j) => Some(Arc::new(j)),
                Err(e) => {
                    eprintln!("[engine] job object 생성 실패 — 좀비 차단 없음: {e}");
                    None
                }
            };
            let mut hub = Hub {
                app,
                slots: HashMap::new(),
                job,
                cli: cli_path(),
                route: RouteCache::default(),
            };
            loop {
                let wait = hub.wait();
                match rx.recv_timeout(wait) {
                    Ok(job) => {
                        hub.handle(job);
                        // 몰려 온 잡은 한 번에 소화한다(틱 사이의 지연을 만들지 않는다).
                        while let Ok(next) = rx.try_recv() {
                            hub.handle(next);
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                }
                hub.pump();
            }
            // 채널이 닫혔다 = 앱 종료. 남은 CLI를 거둔다.
            for (_, mut s) in hub.slots.drain() {
                s.rt.app_quit();
            }
        })
        .ok();
}

/// 앱 종료 — 허브를 닫고 상태를 디스크로 내린다(D15).
pub fn shutdown() {
    {
        let mut g = tx_slot().lock().unwrap_or_else(|e| e.into_inner());
        // Sender를 떨어뜨리면 허브 루프가 Disconnected로 빠져나오며 CLI를 거둔다.
        g.take();
    }
    // 500ms 디바운스가 남아 있을 수 있다 — 마지막 값을 지금 쓴다(§5.8 규약 4).
    ccg_store::status::flush();
}
