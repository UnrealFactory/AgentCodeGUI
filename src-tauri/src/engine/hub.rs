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
use ccg_engine::queue::QueueOp;
use ccg_engine::runtime::{ChatRuntime, Cmd};
use ccg_engine::state::StateTag;
use serde_json::{json, Map, Value};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, EventTarget};

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
    ArchiveError(String),
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
        /// ★M4 — `allow_always`였나. Claude 경로에서는 지금 1회 허용과 같게 동작하고
        /// (`updatedPermissions` 미배선), **Codex는 `acceptForSession`으로 갈린다**.
        always: bool,
        /// ★M4 — 질문 카드의 답을 **구조 그대로**(질문별 선택 라벨). Claude는 이걸
        /// 문장으로 접어 `deny.message`에 실어 되먹이지만(§4.4a 트릭), Codex의
        /// `item/tool/requestUserInput`은 `{qid: {answers}}`를 요구한다.
        answers: Option<Vec<Vec<String>>>,
    },
    IdentityGet,
    IdentitySet {
        patch: RawIdentityPatch,
        policy: ApplyPolicy,
        op: PendingOp,
        corr: Option<String>,
    },
    IdentityRevert(u32),
    /// **예약 넣기**(★R4) — `chat:queue-mutate {op:'enqueue', text, images, picker}`.
    /// 상태에 따라 *지금 보낼지 세울지*가 갈리므로 명령표의 `enqueue` 행을 탄다.
    Enqueue(ccg_engine::queue::QueueInput),
    /// 큐 조작 — `{op:'remove'|'reorder'|'clear'|'restore', id?|ids?|token?}`.
    QueueMutate(Value),
    ForceSettle(String),
    /// 백그라운드 작업 중지 — 상태기계에 `stop_task`를 보내고, **와이어에 `byUser` 표식**을
    /// 남긴다(정착 통지의 "직접 중지 / Claude가 중지 / 턴 종료 정리"를 가르는 근거).
    BgStop(String),
    /// **부팅 재장전**(§5.8 2단계). 큐·한도 대기표를 런타임에 세운다. `auto`는 스펙 ⑤ —
    /// 보이는 자리 + 열린 창만 자동 발사, 나머지는 `ready`만 켜고 사용자를 기다린다.
    Reload {
        queued: Vec<ccg_engine::queue::QueueInput>,
        hold: Option<ccg_engine::runtime::ReloadHold>,
        auto: bool,
    },
    /// 사용자가 "이어서"를 눌렀다 — `ready`인 대기표를 지금 소진한다.
    ResumeNow,
    /// ★M9 R2 — **이 채팅의 도구 환경을 다시 묻는다**(`chat:tooling-get`).
    ///
    /// R1의 값 출처는 스폰당 푸시 한 장뿐이었고 렌더러는 그것을 컴포넌트 state에만
    /// 담았다. 껍데기가 갈리면(「크게 보기」·팝아웃·그리드 복귀) 칩이 증발하는데,
    /// 셸의 `Wire::env`에는 값이 그대로 살아 있었다 — 없던 것은 **다시 물을 창구**다.
    ///
    /// 조회는 **런타임을 만들지 않는다**(`ensure` 앞에서 끝낸다). 슬롯이 없거나
    /// 아직 `system/init`을 못 봤으면 `Null`이다 — "없음"이 아니라 "아직 모름"이고,
    /// 화면은 그 둘을 다르게 그린다(빈 칩을 세우지 않는다).
    ToolingGet,
    /// ★3.0.5 — 보드 자리가 바뀌었다(드래그 재배치·접기·저장). 모든 슬롯의 lite를 다시 만들어
    /// `seat`(보이는 자리 번호)가 바뀐 채팅만 `chat:status`로 내보낸다. `ensure` 앞에서 끝난다 —
    /// 채팅 하나의 일이 아니라 `chat`은 비어 있다.
    SeatsChanged,
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
static HUB_THREAD: OnceLock<Mutex<Option<std::thread::JoinHandle<()>>>>=OnceLock::new();

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
    /// 이 슬롯의 와이어 런에 **묶인 엔진 `RunId`**(★R4).
    ///
    /// 엔진은 자기 판단으로 턴을 시작한다 — 예약 드레인(T16/T17/T27)과 한도 재개가 그렇다.
    /// R3까지 `wire.begin_run()`은 `Op::Run`(= 렌더러의 전송)에서만 불렸으므로, 그 턴들은
    /// **새 runId도 `analyzing` 상태도 사용자 말풍선도 없이** 답만 도착했다
    /// (M-UX R2.1 표 #4). 여기 값과 다른 RunId가 오면 "엔진이 스스로 시작했다"이다.
    engine_run: Option<u64>,
    /// `Op::Run`이 열어 둔 와이어 런 중 **아직 엔진 RunId와 짝이 안 지어진** 개수.
    ///
    /// bool이면 안 된다: 턴이 도는 중에 전송을 두 번 하면 둘 다 큐에 서고 나중에 차례로
    /// 드레인되는데, 그때 두 번째 드레인이 "엔진이 스스로 시작했다"로 읽혀 **사용자
    /// 말풍선이 두 벌** 그려진다(렌더러가 이미 자기 `begin`으로 그렸다).
    expect_runs: u32,
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
    /// 런타임 없이 거절한 전송의 런 id 일련번호(★R5 — [`Hub::reject_spawn`]).
    /// 슬롯의 `run_seq`와 축이 다르다: 그쪽은 슬롯이 있을 때만 센다.
    reject_seq: u64,
    /// ★M11 — 한도 소진 시 갈아탈 계정을 고르는 훅(설정 옵션, 기본 꺼짐).
    /// **모든 슬롯이 같은 인스턴스를 공유한다**: 후보 판정의 "지금 태우고 있는 계정"은
    /// 채팅 하나가 아니라 앱 전체의 사실이고, usage 스냅샷·HTTP 예산도 앱당 하나다.
    switcher: Arc<super::acct_switch::Switcher>,
    /// ★T3T4 R3 — **발화 직전 한도 재검증** 훅(`ccg_engine::limit::LimitProbe`).
    /// `switcher`와 같은 이유로 모든 슬롯이 한 인스턴스를 공유한다: usage 스냅샷과
    /// HTTP 예산은 채팅이 아니라 앱당 하나이고, 조회 루프가 두 벌이면 그 둘이
    /// 서로의 캐시를 무시하며 같은 계정의 토큰을 번갈아 회전시킨다.
    probe: Arc<super::limit_probe::Probe>,
}

#[derive(Default)]
struct RouteCache {
    active: Option<String>,
    panel: HashMap<String, Option<String>>,
    /// ★3.0.5 — 표시용 자리(`lite`의 `panelId`·`seat`). 펌프당 한 번만 보드를 본다.
    seats: HashMap<String, Option<super::Seat>>,
}

/// `chat:event` 봉투 — 참조로 직렬화한다(★3.0.3, `fanout` 참조).
#[derive(serde::Serialize, Clone, Copy)]
struct ChatEnvelope<'a> {
    #[serde(rename = "chatId")]
    chat_id: &'a str,
    event: &'a Value,
}

/// `ma:event` 봉투.
#[derive(serde::Serialize, Clone, Copy)]
struct PanelEnvelope<'a> {
    #[serde(rename = "panelId")]
    panel_id: &'a str,
    event: &'a Value,
}

/// `updatedAt`만 다른 lite는 같은 것으로 본다 — 매 틱 두 벌을 복제해 비교하던 자리(★3.0.3).
/// ★3.0.5 — 인접한 `assistant-stream`(같은 런·같은 메시지)의 `delta`를 이어 붙인다.
/// 다른 이벤트가 끼면 경계를 지킨다(사고·도구·상태 순서가 바뀌면 안 된다).
fn coalesce_stream(events: Vec<Value>) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::with_capacity(events.len());
    for ev in events {
        if ev.get("type").and_then(Value::as_str) == Some("assistant-stream") {
            if let Some(last) = out.last_mut() {
                if last.get("type").and_then(Value::as_str) == Some("assistant-stream")
                    && last.get("messageId") == ev.get("messageId")
                    && last.get("runId") == ev.get("runId")
                {
                    if let (Some(Value::String(a)), Some(Value::String(b))) = (last.get_mut("delta"), ev.get("delta")) {
                        a.push_str(b);
                        continue;
                    }
                }
            }
        }
        out.push(ev);
    }
    out
}

fn lite_same(a: &Value, b: &Value) -> bool {
    match (a.as_object(), b.as_object()) {
        (Some(a), Some(b)) => {
            let n = |m: &serde_json::Map<String, Value>| m.len() - usize::from(m.contains_key("updatedAt"));
            n(a) == n(b) && a.iter().filter(|(k, _)| k.as_str() != "updatedAt").all(|(k, v)| b.get(k) == Some(v))
        }
        _ => a == b,
    }
}

impl RouteCache {
    fn clear(&mut self) {
        self.active = None;
        self.seats.clear();
        self.panel.clear();
    }
}

/// `claude.exe` 경로 — 앱 홈의 활성 엔진 버전(2.6.2 `config.json.activeVersion`).
///
/// ★최종 파리티 T2 — 판정을 `engine/versions.rs`로 옮겼다(**규칙은 그대로**: 적힌
/// activeVersion + 실행 파일 존재 → 없으면 PATH). 계정 팔이 `claude auth login`을
/// 조립할 때 같은 실행 파일을 써야 하는데, 그 경로가 두 곳에 적혀 있으면 한쪽만
/// 고쳐지는 순간 "채팅은 도는데 로그인만 안 되는" 상태가 태어난다.
///
/// ★R28d EXTN R1 — **위 주석이 경고한 그 상태가 R28d R1에서 실제로 태어났다.**
/// 계정 팔은 `claude_exe()`(= PATH 훑기)로 갈아탔는데 이 줄만 맨 이름 `claude.exe`를
/// 그대로 넘겼고, `Command::new(맨 이름)`은 `PATH`보다 **실행 파일이 있는 폴더**를 먼저
/// 본다(`ccg_engine::codex::versions::search_dirs`의 실측). 그래서 「앱 exe 옆에만 claude가
/// 있는」 판에서 턴은 뜨는데 로그인은 「실행 파일을 찾지 못했어요」였고 **로그아웃이 토큰
/// 해지를 조용히 건너뛰었다**(EXTN 확인 크리틱 R1 §2.1). 이제 두 자리가 **같은 함수**를
/// 지난다 — 여기는 `claude_spawn_bin()`(해석된 실물 · 못 찾으면 옛 인자 그대로),
/// 계정·커밋 메시지는 `claude_exe()`, 그 둘은 `resolve_bin` 한 벌이다.
/// codex 축이 R28c에 이미 밟은 규약(`spawn_bin()`)과 같은 모양이다.
fn cli_path() -> std::path::PathBuf {
    super::versions::claude_spawn_bin()
}

impl Hub {
    /// 이 채팅의 런타임을 보장한다. 정체성은 **디스크의 물질화값**이 1순위,
    /// 없으면 전역값으로 물질화한다(m-logic §2.4 규약 2).
    /// ★3.0.8 — 런타임 보장 + **요청이 실어 온 정체성 축(`seed`)을 런타임을 만들기 전에 얹는다.**
    ///
    /// 3.0.7까지 `Op::Run`은 ① 디스크의 정체성으로 런타임을 만들고 ② 그다음 요청의 picker(폴더·모델…)를
    /// 패치로 넣었다. 그래서 디스크의 폴더가 비었거나(패널을 만들고 폴더를 안 고른 채 저장된 정체성)
    /// 사라졌으면 ①에서 `CwdMissing`으로 죽었고, 요청이 멀쩡한 폴더(`C:/Rookiss/ClaudeOffice`)를 싣고
    /// 왔어도 그 값은 **읽히지도 않았다** — 사용자는 고른 적 없는 「C:\Users\<me>\Desktop을 찾을 수
    /// 없어요」를 듣고, 렌더러의 지연 저장이 정체성을 되쓸 때까지 같은 문장을 되풀이했다(2026-09-04 제보:
    /// 네 번 튕기고 다섯 번째에 됐다). 이제 요청의 축을 먼저 얹고 정규화하므로 요청이 옳으면 첫 전송에
    /// 뜬다. 정체성 이벤트(`origin: default`)가 곧 디스크 되끼움이라 다음 기동도 같은 값에서 출발한다.
    ///
    /// `cmd`는 거부 판정의 명령 이름(`None` = 침묵 — 조회성 op은 사유를 말할 자리가 아니다). 스레드에
    /// 오류 말풍선(band)을 앉히는 것은 **전송(`Op::Run`)뿐**이다: 3.0.7까지는 /clear·부팅 재장전·
    /// picker 조회까지 전부 「작업 폴더를 찾을 수 없어요」 말풍선을 그렸다(제보 화면의 반복 오류 일부).
    fn ensure_for(
        &mut self,
        chat: &str,
        seed: Option<&RawIdentityPatch>,
        cmd: Option<&'static str>,
    ) -> Option<&mut Slot> {
        if !self.slots.contains_key(chat) {
            // ★최종 파리티 T2 — **여기서 다시 고른다.** 부팅 때 한 번 고르고 마는 것이
            // R28까지의 모양이었는데, 그러면 엔진 미설치 안내 카드(EngineGate)로 방금
            // 설치·활성화한 사용자가 **앱을 껐다 켤 때까지** PATH 폴백(대개 없음)으로
            // 돈다 = "설치했는데도 안 된다". 런타임을 새로 만들 때만 도는 자리라
            // 값은 작은 JSON 한 번이다.
            self.cli = cli_path();
            let mut raw = ident::raw_from_disk(chat).unwrap_or_else(|| ident::raw_default(""));
            if let Some(p) = seed {
                raw = raw.patched(p);
            }
            if super::environment::is_system(raw.engine.kind) {
                raw.billing.kind = ccg_engine::identity::BillingKind::System;
                raw.engine.codex_account = None;
                raw.output_style = None;
            } else if raw.billing.kind == ccg_engine::identity::BillingKind::System {
                raw.billing.kind = ccg_engine::identity::BillingKind::Subscription;
                raw.billing.account = None;
                raw.billing.drop_env_key = None;
            }
            let defaults = ident::defaults();
            let dump = std::env::var("CCG_ENGINE_LOG")
                .ok()
                .filter(|s| !s.is_empty())
                .map(std::path::PathBuf::from);
            // ★M4 — 드라이버 둘을 품고 **스폰 인자가 고른다**(`any.rs`). 채팅의 엔진은
            // 정체성 리프라 살아 있는 채팅에서 바뀔 수 있다(picker에서 Codex로 → T17).
            //
            // ★R28c CPATH — 값을 `spawn_bin()`에서 받는다. 한도 재검증(`codex_limit`)이
            // 「띄울 수 있다」고 판정할 때 본 것과 **같은 해석**이어야 한다: R28b까지
            // 이 줄은 맨 이름 `codex`를 그대로 넘겨 PATH에서 잘 떴는데, 한도 쪽만
            // `is_file()`로 「실행본 없음」이라 판정하고 눈감고 발사했다.
            let archive_chat = chat.to_string();
            let observer: ccg_engine::driver::ProtocolObserver = Arc::new(move |source, value| {
                ccg_store::archive::record(&archive_chat, source, value);
            });
            let codex = ccg_engine::codex::CodexDriver::new(
                super::codex_versions::spawn_bin(),
                self.job.clone(),
                dump.clone(),
            )
            .with_home_resolver(super::codex_versions::resolver())
            .with_context_resolver(super::codex_context::resolver())
            .with_observer(observer.clone());
            let any = super::any::AnyDriver::new(ClaudeDriver::new(self.job.clone(), dump).with_observer(observer), codex);
            let (tap_drv, tapped) = super::tap::TapDriver::new(any);
            let tap_drv = tap_drv.with_archive(chat);
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
                    self.reject_spawn(chat, &e, cmd);
                    return None;
                }
            };
            let rt = rt
                .with_cli_path(self.cli.clone())
                .with_home(ccg_store::app_home())
                // ★SLUG R1 — 계정 격리 `CLAUDE_CONFIG_DIR`을 **아는 쪽**이 답한다.
                // 이 줄이 없으면 구독 턴은 `accounts/_no-resolver`로 나간다(자격증명이
                // 없는 폴더 = 미로그인). 있으면 `ccg_auth::claude::account_run_dir`이
                // 실물 폴더를 내고 자격증명까지 물질화한다. Codex 축의
                // `with_home_resolver(codex_versions::resolver())`와 같은 자리다.
                .with_account_resolver(super::claude_account::resolver())
                // ★M11 — 한도 소진 시 노는 계정으로 갈아타기. 훅은 앱 전체가 하나를
                // 공유하고, 설정이 꺼져 있으면 언제나 `None`을 내 옛 경로(대기표)가 된다.
                .with_account_switcher(self.switcher.clone())
                // ★T3T4 R3 — **발화 직전 재검증.** 이 줄이 없으면 `check_hold`는
                // `NoProbe`(=「풀린 것으로 두고 진행」)로 돌고, 조회가 죽어 있는 동안
                // 자동 재개가 눈감고 CLI를 태운다(R28 확인 크리틱 R2의 최대 격차).
                // 렌더러 훅은 본채팅에서 `resumeOwner:"engine"`으로 꺼져 있으므로,
                // 그 표면의 안전장치는 **여기 하나뿐**이다.
                .with_limit_probe(self.probe.clone());
            self.slots.insert(
                chat.to_string(),
                Slot {
                    rt,
                    tap: tapped,
                    wire: Wire::default(),
                    terminal: lite::Terminal::None,
                    last_lite: Value::Null,
                    run_seq: 0,
                    engine_run: None,
                    expect_runs: 0,
                    pending_settled: vec![],
                },
            );
        }
        self.slots.get_mut(chat)
    }

    /// **스폰 불가 사유를 구독자가 있는 채널에 앉힌다**(★R5 — R14 확인 크리틱 F4 / M2).
    ///
    /// 무엇이 문제였나: `ChatRuntime::new`가 실패하면(`CwdMissing`·`AccountUnavailable`)
    /// 사유가 `chat:verdict`로만 나갔는데 **그 채널의 구독자는 0**이다(§4.3-M2). 런타임이
    /// 없으니 T3(20초 침묵 감시)도 없다. 크리틱이 채팅 폴더를 없는 경로로 바꾸고 한 줄
    /// 보낸 뒤 40초를 지켜본 결과가 이랬다:
    ///
    /// ```text
    ///  +3s  "징검다리 놓는 중 ·3초"   · errMsgs []     +25s  "안개를 걷어내는 중 ·25초" · errMsgs []
    /// +10s  "징검다리 놓는 중 ·10초"  · errMsgs []     +40s  "퍼즐 맞추는 중 ·40초"    · errMsgs []
    /// ```
    ///
    /// 사용자 말풍선은 그려졌고, 나레이션은 돌고, 중지 버튼은 살아 있고, **오류·안내 0건** —
    /// m-logic P8("영구 정지 + 침묵") 그 자체이고 3.0이 죽이겠다고 선언한 증상이다.
    /// 침묵 no-op 금지(D7)는 *"구독자 없는 채널에만 말하는 것"* 도 금지한다.
    ///
    /// 그래서 셋을 함께 낸다. 순서가 계약이다 —
    /// 렌더러의 세션 리듀서는 `begin` 직후 `curRunId = 'pending'`이라 **`analyzing`이 런을
    /// 채택하기 전에는 `error`/`status`를 전부 늦은 잔재로 버린다**(`session.ts:553`).
    ///
    /// | # | 이벤트 | 화면에서 하는 일 |
    /// |---|---|---|
    /// | ① | `status{analyzing}` | 이 런을 현재 실행으로 채택시킨다(아래 둘이 통과할 문) |
    /// | ② | `error{message}` | 오류 말풍선 — 사유를 **읽을 수 있는 문장**으로 |
    /// | ③ | `status{error}` | 턴 종결(컴포저·중지 버튼·나레이션 해제) |
    ///
    /// `chat:verdict`도 그대로 낸다 — 구독자가 붙는 날의 기계 판독용이고, 지금 지우면
    /// 계약면이 한 번 더 흔들린다.
    fn reject_spawn(&mut self, chat: &str, e: &ccg_engine::IdentityError, cmd: Option<&'static str>) {
        use ccg_engine::IdentityError as E;
        // ★3.0.8 — 조회성 op(`None`)은 침묵한다. 전송(`run`)만 스레드 말풍선(band)까지 낸다 —
        // 나머지(picker 변경·/clear·예약·카드 응답…)는 `chat:verdict`만 내고 문장은 렌더러가
        // 짓는다(`message` 없음 = `verdict.ts`가 저자). 그래야 /clear 한 번에 「작업 폴더를
        // 찾을 수 없어요」 오류 말풍선이 앉지 않는다.
        let Some(cmd) = cmd else { return };
        let band = cmd == "run";
        let why = match e {
            E::CwdMissing(p) => format!("작업 폴더를 찾을 수 없어요 — {p}"),
            E::AccountUnavailable(a) => {
                format!("실행 계정을 쓸 수 없어요 — {a} (로그아웃됐거나 계정 목록에서 사라졌습니다)")
            }
            E::ApiKeyMissing => "API 키가 없어요 — 설정에서 키를 넣어 주세요".into(),
            E::EngineSwitchNeedsModel => "엔진을 바꾸려면 모델을 함께 골라야 해요".into(),
        };
        let panel = self.panel_alias(chat);
        let mut verdict = json!({ "kind": "rejected", "reason": format!("{e:?}"), "cmd": cmd });
        if band {
            verdict["message"] = json!(why);
        }
        self.emit_all(
            crate::ipc::ch::CHAT_VERDICT,
            json!({ "chatId": chat, "panelId": panel, "verdict": verdict }),
        );
        if !band {
            return;
        }
        // 런타임이 없어 `wire`도 없다 — 런 id는 여기서 발급한다(짝이 없는 1회용).
        self.reject_seq += 1;
        let run = format!("x{}-{}", std::process::id(), self.reject_seq);
        let chat = chat.to_string();
        self.fanout(&chat, json!({ "type": "status", "runId": run, "status": "analyzing" }));
        self.fanout(
            &chat,
            json!({ "type": "error", "runId": run,
                    // ★HOSTI18N R2 — 강화한 훑기 못(§R2-4)이 새로 찾아낸 자리다.
                    // 채팅 기록에 그대로 앉는 문장이라 en 사용자가 한국어를 본다.
                    // `{why}`는 셸이 만든 사유라 그쪽도 같이 번역돼야 완성이다(이월 §R2-6).
                    "message": ccg_fs::t(
                        &format!("{why}. 고친 뒤 다시 보내면 이어집니다."),
                        &format!("{why}. Fix it and send again to continue."),
                    ) }),
        );
        self.fanout(&chat, json!({ "type": "status", "runId": run, "status": "error" }));
        // 사이드바·다른 창이 읽는 요약면에도 앉힌다(`chat:status`). 런타임이 없으니
        // `lite::build`를 못 쓴다 — 스토어의 빈 lite에 종결 상태만 얹는다.
        let mut row = ccg_store::status::empty_lite(&chat);
        if let Some(o) = row.as_object_mut() {
            o.insert("status".into(), json!("error"));
            o.insert("busy".into(), json!(false));
            o.insert(
                "updatedAt".into(),
                json!(std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0)),
            );
        }
        ccg_store::status::set(&chat, row);
        self.emit_all(crate::ipc::ch::CHAT_STATUS, super::status_array());
    }

    fn emit_all(&self, channel: &str, payload: Value) {
        let _ = self.app.emit(channel, payload);
    }

    /// 2.6.2 렌더러가 구독한 이름으로 이벤트를 보낸다 + 3.0 봉투(`chat:event`)를 함께.
    ///
    /// 창 라우팅(§6.1 "창 라우팅은 `chatId → label` 역인덱스"): 본채팅은 메인 창,
    /// 추가 채팅은 그 창, 멀티 패널은 `panelId` 봉투. 어느 것도 아니면 봉투만 나간다.
    fn fanout(&mut self, chat: &str, ev: Value) {
        ccg_store::archive::record(chat, "ui", &ev);
        // ★3.0.3 — 봉투는 참조로 직렬화한다. 토큰마다 `ev.clone()` 셋(봉투 둘 + 창별 하나)이
        // 허브 스레드 할당의 대부분이었다. Tauri의 emit은 직렬화만 하고 값을 붙들지 않는다.
        let _ = self.app.emit(crate::ipc::ch::CHAT_EVENT, ChatEnvelope { chat_id: chat, event: &ev });
        let active = match &self.route.active {
            Some(a) => a.clone(),
            None => {
                let a = super::active_chat_id();
                self.route.active = Some(a.clone());
                a
            }
        };
        if active == chat {
            let _ = self.app.emit_to(crate::win::MAIN, crate::ipc::ch::ENGINE_EVENT, &ev);
        }
        // 창 레지스트리는 메모리 `Mutex<Vec<_>>`라 디스크를 안 탄다 — 캐시 대상이 아니다.
        if let Some(label) = crate::win::session_label_for_chat(chat) {
            let _ = self.app.emit_to(label.as_str(), crate::ipc::ch::SESSION_EVENT, &ev);
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
            // ★3.0.5 — 패널 봉투는 **그 패널을 그리는 창**에만: 메인(그리드·유령 셀)과 그 패널의 팝아웃.
            // 3.0.4까지 `emit`(모든 창)이라 팝아웃 창마다 **다른 패널의 델타까지** 전부 JS로 평가하고
            // 버렸다(패널 P개 × 창 W개 — 팝아웃을 띄울수록 토큰당 비용이 늘었다). 팝아웃·메인의
            // 구독은 `{target: label}`이라 라벨 필터가 먹는다(`unified.ts`의 무표적 `listen`과 다르다).
            let popout = crate::win::popout::window_label_for(&panel);
            let keep = |t: &EventTarget| match t {
                EventTarget::AnyLabel { label }
                | EventTarget::Window { label }
                | EventTarget::Webview { label }
                | EventTarget::WebviewWindow { label } => {
                    label == crate::win::MAIN || popout.as_deref() == Some(label.as_str())
                }
                _ => true,
            };
            let _ = self.app.emit_filter(crate::ipc::ch::MA_EVENT, PanelEnvelope { panel_id: &panel, event: &ev }, keep);
        }
    }

    /// ★3.0.4 — `fanout`과 같은 봉투를 **한 창만 빼고** 보낸다.
    ///
    /// 렌더러가 연 턴의 사용자 말풍선(`user-echo`)이 쓴다. 보낸 창은 자기 `begin` 리듀서로
    /// 이미 그렸으니 빼고, 같은 대화를 그리는 **다른** 창 — 팝아웃 패널의 그리드 유령 셀 ·
    /// 자리 밖 수집기(App `bgSnapRef`) · 추가 채팅 창 — 은 받아야 한다. 3.0.3까지는
    /// `sync_engine_run`이 `expect_runs`로 에코를 통째로 삼켜 그 창들이 말풍선을 영영 못
    /// 받았고, 팝아웃 동안은 그리드 사본이 저장을 이기므로(MultiAgent `applyPanelFlush`의
    /// "스레드는 라이브가 이긴다") **어시스턴트 답만 있고 내 말은 없는 대화**가 디스크에
    /// 남았다(2026-09-03 보고: 재시작하면 AI 것은 다 있는데 내 것만 날아간다 — 실측
    /// `chats-v3/ma-…-2.json`: worked 33 · assistant 36 · user 6).
    fn fanout_except(&mut self, chat: &str, ev: Value, except: &str) {
        ccg_store::archive::record(chat, "ui", &ev);
        let keep = |t: &EventTarget| {
            !matches!(
                t,
                EventTarget::AnyLabel { label }
                    | EventTarget::Window { label }
                    | EventTarget::Webview { label }
                    | EventTarget::WebviewWindow { label }
                    if label == except
            )
        };
        let _ = self.app.emit_filter(crate::ipc::ch::CHAT_EVENT, ChatEnvelope { chat_id: chat, event: &ev }, keep);
        let active = match &self.route.active {
            Some(a) => a.clone(),
            None => {
                let a = super::active_chat_id();
                self.route.active = Some(a.clone());
                a
            }
        };
        if active == chat && except != crate::win::MAIN {
            let _ = self.app.emit_to(crate::win::MAIN, crate::ipc::ch::ENGINE_EVENT, &ev);
        }
        if let Some(label) = crate::win::session_label_for_chat(chat) {
            if label != except {
                let _ = self.app.emit_to(label.as_str(), crate::ipc::ch::SESSION_EVENT, &ev);
            }
        }
        if let Some(panel) = self.panel_alias(chat) {
            let _ = self.app.emit_filter(crate::ipc::ch::MA_EVENT, PanelEnvelope { panel_id: &panel, event: &ev }, keep);
        }
    }

    /// 이 대화가 보드 자리에 앉아 있으면 그 자리 별칭(panelId) — fanout(MA_EVENT)과 같은
    /// 번역·같은 캐시를 쓴다. `chat:verdict`가 이 값을 함께 실어야 렌더러가 자리 키로
    /// 판별할 수 있다 — 안 실으면 **보이는 패널**에서 한 행동의 거부 사유가 패널 착지
    /// (ActiveSession)와 토스트 가드(App) 둘 다에서 빗나가 구석 토스트로 샌다(2026-09-01
    /// 사용자 보고 — 렌더러의 자리 화면은 전부 panelId로 식별하고 chatId 배선이 없다).
    fn panel_alias(&mut self, chat: &str) -> Option<String> {
        match self.route.panel.get(chat) {
            Some(p) => p.clone(),
            None => {
                let p = super::panel_id_for_chat(chat);
                self.route.panel.insert(chat.to_string(), p.clone());
                p
            }
        }
    }

    fn handle(&mut self, job: Job) {
        // 명령은 스토어를 갈 수 있다(`chats:set-active`·`board:save`는 다른 스레드지만
        // 사용자 조작은 같은 순간에 온다) — 라우팅 캐시를 여기서 버린다(무효화 규약 2).
        self.route.clear();
        let Job { chat, op, reply } = job;
        match &op {
            Op::Run(req) => ccg_store::archive::record(&chat, "request", req),
            Op::Respond { kind, request_id, accept, payload, answer_text, always, answers } => {
                ccg_store::archive::record(&chat,"response",&json!({"type":"user-response","kind":format!("{kind:?}"),"requestId":request_id,"accept":accept,"payload":payload,"answerText":answer_text,"always":always,"answers":answers}));
            }
            Op::Cmd(cmd) => ccg_store::archive::record(&chat,"command",&json!({"type":cmd.name(),"command":format!("{cmd:?}")})),
            Op::Enqueue(input) if ccg_store::archive::enabled(&chat) => ccg_store::archive::record(&chat,"queue",&json!({"type":"enqueue","input":format!("{input:?}")})),
            Op::QueueMutate(value)=>ccg_store::archive::record(&chat,"queue",value),
            _ => {}
        }
        let answer = |v: Value| {
            if let Some(tx) = &reply {
                let _ = tx.send(v);
            }
        };
        match op {
            Op::ArchiveError(error)=>{
                let run=self.slots.get(&chat).map(|s|s.wire.run_id.clone()).unwrap_or_default();
                self.fanout(&chat,json!({"type":"error","runId":run,"message":ccg_fs::t(&format!("대화 기록을 준비하지 못했습니다: {error}"), &format!("Could not prepare conversation recording: {error}"))}));
                self.fanout(&chat,json!({"type":"status","runId":run,"status":"error"}));
                answer(Value::Null);return;
            }
            Op::Debug => {
                let rows: Vec<Value> = self
                    .slots
                    .iter()
                    .map(|(id, s)| {
                        json!({ "chatId": id, "state": format!("{:?}", s.rt.state()),
                                "queued": s.rt.queue_len(), "spawns": s.rt.spawns,
                                "exits": s.rt.exits, "session": s.rt.session_id(),
                                "pid": s.rt.driver_ref().pid(),
                                // ★M4 — 이 채팅이 **어느 엔진으로 떴나**(하네스의 판정 근거).
                                "engine": s.rt.driver_ref().engine(),
                                "identityEngine": match s.rt.identity().engine() {
                                    ccg_engine::identity::EngineAxis::Codex { .. } => "codex",
                                    _ => "claude",
                                },
                                // 부팅 재장전·스펙 ⑤가 실제로 걸렸는지 하네스가 읽는다.
                                "autoResume": s.rt.auto_resume(),
                                "nowMs": s.rt.now(),
                                // ★T3T4 R3 — `probes`·`autoPaused`는 **「왜 안 쐈나」의 답**이다.
                                // 계약면(`ChatStatusLite.hold`)에는 일부러 안 싣는다: 그쪽 모양은
                                // `ccg_store::status::truth_from_chat_file`과 한 글자도 안 갈려야
                                // 하고(규약 3 — 어긋나면 채팅 파일이 이겨 화면이 깜빡인다),
                                // 이 값들은 화면이 아니라 하네스·크리틱이 읽는 진단이다.
                                "hold": s.rt.hold().map(|h| json!({ "resetsAt": h.resets_at, "ready": h.ready,
                                                                    "dueAt": h.due_at(), "probes": h.probes,
                                                                    "attempts": h.attempts, "autoPaused": h.auto_paused })),
                                // ★R28f WFIRE — **에피소드 예산의 소비분**(`episode_fires`).
                                // 표 **밖**에 사는 값이라 위 `hold` 안에는 못 넣는다(표가 없어도 산다).
                                // 「왜 안 쐈나」의 두 번째 답이고, 재장전이 이 값을 물려받는지를
                                // 밖에서 확인할 수 있는 유일한 창이다(`scripts/poc-limit-engine.mjs` E11).
                                "episodeFires": s.rt.episode_fires(),
                                "queue": s.rt.queue_texts() })
                    })
                    .collect();
                // `flags`는 "이 주행이 정말 그 팔이었나"의 유일한 증거다(★R4).
                //
                // ★M11 `accountSwitch` — **왜 안 바뀌었나**의 답. 침묵 금지(D7)는 사용자
                // 문구만의 규약이 아니다: 하네스와 크리틱이 "토글은 켰는데 왜 그대로냐"를
                // 물을 자리가 없으면 이 기능은 검증 불가능해진다. `skipped`는 계정마다
                // 탈락 사유 낱말(`contaminated`·`no_headroom`·`usage_unknown`…)이다.
                let plan = self.switcher.last_plan();
                // ★M11 R2 — 예산 문의 **숫자**: 워커가 몇 번 돌았고 계정을 몇 건 물었나.
                // R1의 치명(부팅마다 전 계정 조회 → 토큰 회전)은 문서에만 문이 있고
                // 코드에는 없어서 생겼다. 이제 하네스가 0인지 확인할 수 있다.
                let (runs, fetches) = self.switcher.worker_stats();
                // ★T3T4 R3 — 재검증 훅의 회계. `asks`가 0이면 훅이 안 걸린 것이고,
                // `unavailable`이 오르는데 `blocked`/`clear`가 0이면 조회가 죽은 판이다.
                // ★CRIT R1 — `unknown`은 **판정하지 않았다**(물어볼 창구가 없는 Codex 실행).
                // 이 값이 오르는데 `blocked`가 0이라는 것이 "클로드 창으로 안 봤다"의 물증이다.
                let pr = self.probe.stats();
                answer(json!({ "chats": rows, "cli": self.cli.to_string_lossy(),
                               "limitProbe": { "asks": pr.asks, "fetches": pr.fetches,
                                               "blocked": pr.blocked, "clear": pr.clear,
                                               "unavailable": pr.unavailable, "unknown": pr.unknown },
                               "flags": crate::flags::active(),
                               "accountSwitch": {
                                   "on": self.switcher.enabled(),
                                   "busy": self.burning_accounts(),
                                   "worker": { "runs": runs, "fetches": fetches },
                                   "picked": plan.picked,
                                   "skipped": plan.skipped.iter()
                                       .map(|(e, w)| json!({ "email": e, "why": w }))
                                       .collect::<Vec<_>>(),
                               } }));
                return;
            }
            // ★M9 R2 — 도구 환경 재조회. `ensure` **앞**이라 런타임을 안 만든다:
            // 아직 한 번도 안 돈 패널이 마운트만으로 CLI를 띄우면 안 된다.
            Op::ToolingGet => {
                answer(
                    self.slots
                        .get(&chat)
                        .and_then(|s| s.wire.tooling())
                        .unwrap_or(Value::Null),
                );
                return;
            }
            // ★3.0.5 — 자리 재배치. 런타임을 만들지 않는다(있는 슬롯만 다시 센다).
            Op::SeatsChanged => {
                let chats: Vec<String> = self.slots.keys().cloned().collect();
                for c in chats {
                    self.refresh_lite(&c);
                }
                answer(Value::Null);
                return;
            }
            Op::Dispose => {
                if let Some(mut s) = self.slots.remove(&chat) {
                    s.rt.dispatch(Cmd::Dispose);
                    s.rt.app_quit();
                }
                // ★R28 ACCT R2(F1-b) — 런타임을 거뒀으면 **마지막 lite에서 계정을 뗀다.**
                // R1은 슬롯만 지웠고, `status`의 마지막 행에 `account`가 그대로 남아
                // 같은 세션 안에서도 「사용 중」 칩이 안 걷혔다(크리틱 F1 부수 사실).
                // 상태(`done`·`error`)는 남긴다 — 사이드바 점 색의 근거다.
                //
                // ★R28b ACCT R3(G1) — **여기는 「삭제」의 문이 아니다.** R2는 그렇게 썼고
                // 확인 크리틱 R2가 실 exe로 깼다: 삭제 경로는 행을 **먼저** 지우므로
                // 아래 `clear_runtime`이 `false`를 돌려주고 이 emit이 영원히 안 나간다.
                // 삭제의 통지는 `engine::dispose_removed_chats`가 진다. 여기 남은 몫은
                // **대화는 살아 있는데 런타임만 거두는** 자리다 — `ma:dispose`(자리 접기)가
                // 그렇고, 그때는 행이 남아 있으니 이 문이 실제로 열린다.
                if ccg_store::status::clear_runtime(&chat) {
                    self.emit_all(crate::ipc::ch::CHAT_STATUS, super::status_array());
                }
                answer(json!(true));
                return;
            }
            _ => {}
        }

        // ★3.0.8 — 요청이 실어 온 정체성 축을 런타임 생성 **전에** 얹고, 거부의 표면을 op별로 가른다
        // (`ensure_for` 참고). `Op::Run`의 아래 `IdentitySet` 패치는 그대로 두었다 — 슬롯이 이미
        // 있는 채팅(대부분)은 그 문이 정체성을 바꾸고, 방금 seed로 만든 런타임에서는 `Noop`이다.
        if let Op::Run(req) = &op {
            if let Err(message) = crate::bridge::validate_run(&chat, req).and_then(|_| super::environment::bind_chat(&chat, req)) {
                self.reject_seq += 1;
                let run = format!("env-{}-{}", std::process::id(), self.reject_seq);
                self.fanout(&chat, json!({ "type": "status", "runId": run, "status": "analyzing" }));
                self.fanout(&chat, json!({ "type": "error", "runId": run, "message": message }));
                self.fanout(&chat, json!({ "type": "status", "runId": run, "status": "error" }));
                answer(json!({ "ok": false }));
                return;
            }
        }
        let seed = match &op {
            Op::Run(req) => Some(ident::patch_from_run_request(req)),
            Op::IdentitySet { patch, .. } => Some(patch.clone()),
            _ => None,
        };
        let cmd: Option<&'static str> = match &op {
            Op::Run(_) => Some("run"),
            Op::Cmd(c) => Some(c.name()),
            Op::Respond { .. } => Some("respond"),
            Op::IdentitySet { .. } => Some("identity_set"),
            Op::IdentityRevert(_) => Some("identity_revert"),
            Op::Enqueue(_) => Some("enqueue"),
            Op::QueueMutate(_) => Some("queue.mutate"),
            Op::ForceSettle(_) => Some("force_settle"),
            Op::BgStop(_) => Some("bg_task.stop"),
            Op::ResumeNow => Some("resume"),
            // 조회·재장전·진단은 사유를 말할 자리가 아니다 — 전송이 그 요청의 폴더로 정확히 말한다.
            Op::IdentityGet | Op::Reload { .. } | Op::ToolingGet | Op::SeatsChanged | Op::Dispose | Op::Debug | Op::ArchiveError(_) => None,
        };
        let Some(slot) = self.ensure_for(&chat, seed.as_ref(), cmd) else {
            answer(Value::Null);
            return;
        };
        // Existing chats must see accounts added or removed since their runtime
        // was created. Refresh before commands which normalize a picker.
        if matches!(&op, Op::Run(_) | Op::IdentitySet { .. } | Op::IdentityRevert(_) | Op::Enqueue(_)) {
            slot.rt.refresh_defaults(ident::defaults());
        }

        match op {
            Op::Run(req) => {
                // ① 요청이 실어 온 picker → 정체성 패치. 저자는 여전히 하나(런타임)다.
                let patch = ident::patch_from_run_request(&req);
                if matches!(slot.rt.prepare_run_identity(patch), Verdict::Rejected(_)) {
                    // Do not send in the old account/folder after rejecting the
                    // requested settings. The runtime emits one blocking Run verdict.
                    answer(Value::Null);
                    return;
                }
                ccg_store::archive::record(&chat,"identity",&ident::identity_wire(slot.rt.identity()));
                // ★3.0.1 첫 주 보고 — 「/clear 했는데 지운 대화가 되살아난다 · Continue 루프」.
                //    렌더러가 세션을 버리면(clear·폴더 변경 → 스냅샷 초기화) 다음 Run에
                //    `resume`를 안 싣는다. 그런데 엔진은 옛 `thread.session_id`를 그대로 쥐고
                //    있어 다음 스폰이 그 세션을 `--resume` 한다 → 지운 대화가 이어지고,
                //    `StopAll`이 죽인 턴을 되살려 CLI가 "Continue from where you left off"를
                //    반복 주입한다. 세션 정체성의 원본은 **렌더러**다(어느 대화를 보는지는
                //    화면이 안다) — resume가 비었는데 엔진이 세션을 쥐고 있으면 그 뜻을 따라
                //    잊는다. `forkSession`은 언제나 resume를 함께 실으므로 여기 안 걸리고,
                //    picker 계정·모델 전환도 resume를 유지하므로(T17 재스폰) 영향이 없다.
                let wants_resume = req
                    .get("resume")
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.is_empty());
                if !wants_resume && slot.rt.session_id().is_some() {
                    slot.rt.forget_thread();
                }
                // ② 스레드 이어붙이기 — 재시작 후 첫 전송은 **저장된 sessionId**로 잇는다.
                //    이게 없으면 대화가 살아 있어도 CLI는 처음 보는 스레드로 답한다.
                if let Some(r) = req.get("resume").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                    if slot.rt.thread.session_id.is_none() {
                        slot.rt.thread.session_id = Some(r.to_string());
                        // ★3.0.5 — 재사용 비교는 접힌 키로 한다(`runtime.rs`). 렌더러가 준 원래
                        // 표기를 그대로 적으면 접힌 `want.cwd().key()`와 늘 어긋나 헛 재스폰이 난다.
                        slot.rt.thread.cwd_at_bind = req
                            .get("cwd")
                            .and_then(Value::as_str)
                            .map(|c| ccg_engine::identity::CanonPath::of(c).key().to_string());
                    }
                    if req.get("forkSession").and_then(Value::as_bool) == Some(true)
                        && !slot.rt.thread.fork_consumed
                    {
                        slot.rt.thread.want_fresh = true;
                    }
                }
                // ③ 판정을 **먼저** 받는다(★3.0.5). 3.0.4까지는 와이어 런을 먼저 열고(runId 발급 +
                //    `analyzing`) 그다음 보냈다. 도는 턴이 있어 예약(`Queued`)이 되면 세 가지가 어긋났다:
                //    ㉠ `begin_run`이 도는 턴의 와이어 상태(cur_msg·said_working·파일 기준선)를 갈아엎고,
                //    ㉡ 렌더러가 새 runId를 채택해 **앞 턴의 `Done`이 그 id로** 나가 화면이 유휴로 내려가며,
                //    ㉢ `expect_runs`가 남아 나중에 드레인된 그 턴의 런 개시를 `sync_engine_run`이 삼켰다 —
                //    렌더러는 유휴인데 엔진은 스트리밍이라 다음 전송이 또 `Queued`가 되는 **자기 유지
                //    연쇄**(「예약으로 넣었어요」가 계속 뜬다 — 2026-09-03 보고). 거절도 같은 누수였다
                //    (`expect_runs`만 +1 되고 런이 안 와서 다음 기계 턴의 개시를 삼켰다).
                //
                //    판정 방출은 **런타임 하나**가 한다(`Event::Verdict` → `on_engine_event`).
                //    R1은 여기서도 쐈고 `runtime.rs`의 `dispatch`가 무조건 또 쐈다 —
                //    전송 1회에 `send:accepted` 2건(크리틱 배선 R1 F6). 저자를 하나로 줄인다.
                let prompt = crate::bridge::prompt_for_run(&req);
                let verdict = slot.rt.dispatch(Cmd::Send { text: prompt });
                let waiting_for_limit = slot.rt.hold().is_some()
                    && matches!(slot.rt.state(), StateTag::Idle | StateTag::Resident | StateTag::Terminating | StateTag::Ended);
                let (run_id, first) = match verdict {
                    Verdict::Accepted | Verdict::Queued if waiting_for_limit => {
                        // A held message has no running turn. Clear the sender's
                        // optimistic spinner without reserving a future run id.
                        let run_id = slot.wire.run_id.clone();
                        (run_id.clone(), Some(json!({"type":"status","runId":run_id,"status":"idle","queued":true})))
                    }
                    Verdict::Accepted => {
                        // runId 발급 — 렌더러가 이벤트를 자기 실행에 붙이는 키. 뒤따르는 엔진 RunId
                        // 하나는 이 런의 것이다 — 그걸 "엔진이 스스로 시작한 턴"으로 오인하면
                        // 사용자 말풍선이 두 번 그려진다(`expect_runs`).
                        slot.run_seq += 1;
                        let run_id = format!("r{}-{}", std::process::id(), slot.run_seq);
                        let first = slot.wire.begin_run(&run_id);
                        slot.expect_runs = slot.expect_runs.saturating_add(1);
                        slot.terminal = lite::Terminal::None;
                        (run_id, Some(first))
                    }
                    Verdict::Queued => {
                        // 예약 — 와이어 런은 드레인 때 `sync_engine_run`이 연다(항목의 `echoed`가 참이라
                        // 그때 에코는 없다). 보낸 창은 자기 `begin`으로 PENDING 대기 중이다: **도는 런의
                        // `analyzing`을 되쏴** 그 런을 채택시킨다 — 앞 턴의 남은 프레임과 `Done`이 화면에
                        // 닿고, 같은 틱에 드레인의 새 런 개시(`analyzing`)가 뒤따라 busy가 다시 선다.
                        let run_id = slot.wire.run_id.clone();
                        let first = (!run_id.is_empty())
                            .then(|| json!({ "type": "status", "runId": run_id, "status": "analyzing" }));
                        (run_id, first)
                    }
                    // 거절 — 사유는 런타임의 `Verdict`가 그린다(렌더러가 말풍선·busy를 되감는다).
                    // 런도 기대(`expect_runs`)도 없다.
                    _ => (slot.wire.run_id.clone(), None),
                };
                let chat_id = chat.clone();
                if let Some(first) = first {
                    self.fanout(&chat_id, first);
                }
                // ★3.0.4 — 사용자 말풍선을 **보낸 창만 빼고** 나머지 창에 에코한다
                // (`fanout_except`). `echoText`는 화면에 그린 원문이다(멘션·첨부 안내가 붙은
                // `prompt`가 아니다 — 그걸 그리면 다른 창의 말풍선에 안내문이 딸려 온다).
                // `echoFrom`은 보낸 창의 라벨. 둘 중 하나라도 없는 옛 요청은 3.0.3처럼 침묵한다.
                // 슬래시 명령은 렌더러가 `echoText`를 안 실으므로(카드로 그린다) 여기 안 온다.
                // 거절은 에코하지 않는다 — 보낸 창도 곧 되감는 말풍선이다.
                let echo_text = req.get("echoText").and_then(Value::as_str).unwrap_or("").to_string();
                let echo_from = req.get("echoFrom").and_then(Value::as_str).unwrap_or("").to_string();
                if matches!(verdict, Verdict::Accepted | Verdict::Queued) && !echo_text.is_empty() && !echo_from.is_empty() {
                    let images = req.get("echoImages").cloned().unwrap_or(Value::Null);
                    let ev = json!({
                        "type": "user-echo", "runId": run_id.clone(), "text": echo_text,
                        "externalContext": req.get("externalContext").cloned().unwrap_or(Value::Null),
                        "images": images, "origin": "user",
                    });
                    self.fanout_except(&chat_id, ev, &echo_from);
                }
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
                always,
                answers,
            } => {
                if kind == AskKind::Question {
                    if let Some(questions) = slot.wire.async_questions.get(&request_id).cloned() {
                        if slot.wire.async_answering.contains(&request_id) {
                            answer(verdict_wire("respond", &Verdict::Accepted));
                            return;
                        }
                        let rows = answers.clone().unwrap_or_default();
                        let pairs: Vec<String> = questions.as_array().into_iter().flatten().enumerate()
                            .filter_map(|(i, q)| {
                                let picked = rows.get(i)?.iter().filter(|a| !a.trim().is_empty())
                                    .cloned().collect::<Vec<_>>().join(", ");
                                (!picked.is_empty()).then(|| format!("{}\n답변: {picked}", q["question"].as_str().unwrap_or("")))
                            }).collect();
                        let run = slot.wire.run_id.clone();
                        if pairs.is_empty() {
                            slot.wire.async_questions.remove(&request_id);
                            self.fanout(&chat, json!({ "type": "question-closed", "runId": run, "requestId": request_id }));
                            answer(verdict_wire("respond", &Verdict::Accepted));
                            return;
                        }
                        let text = format!("사용자가 질문에 답했습니다. 이 답을 반영해 이어서 진행하세요.\n\n{}", pairs.join("\n\n"));
                        let active = matches!(slot.rt.state(), StateTag::Streaming | StateTag::AwaitingUser);
                        let v = if active {
                            slot.wire.async_answering.insert(request_id.clone());
                            slot.wire.async_answers.insert(request_id.clone(), rows.clone());
                            slot.rt.dispatch(Cmd::AnswerAsyncQuestion { request_id: request_id.clone(), text })
                        } else if matches!(slot.rt.state(), StateTag::Idle | StateTag::Resident | StateTag::HeldResult) {
                            slot.rt.dispatch(Cmd::Send { text })
                        } else {
                            Verdict::Rejected("turn_unavailable")
                        };
                        let accepted = matches!(v, Verdict::Accepted | Verdict::Queued);
                        if !active || !accepted {
                            let events = slot.wire.translate(&json!({ "type": "system", "subtype": "ccg_codex",
                                "kind": "async_answer_result", "requestId": request_id,
                                "error": if accepted { Value::Null } else { json!(ccg_fs::t("작업 상태가 바뀌었어요. 잠시 후 다시 보내주세요.", "The task state changed. Please try sending again in a moment.")) } }));
                            // Idle replies start a normal turn; record the answer after acceptance.
                            for mut event in events {
                                if accepted && event["type"] == "question-closed" { event["answers"] = json!(rows); }
                                self.fanout(&chat, event);
                            }
                        }
                        answer(verdict_wire("respond", &v));
                        return;
                    }
                }
                // ★M4 — Codex 채팅이면 응답 본문에 **Codex 전용 자리 둘**을 얹는다.
                // Claude 채팅에는 절대 붙이지 않는다(그 본문은 `claude.exe`의
                // `canUseTool` 응답으로 그대로 나간다 — 모르는 키를 실어 보낼 이유가 없다).
                // 읽는 쪽은 `ccg-engine/src/codex/transcode.rs::answer_ask` 하나뿐이다.
                let is_codex = matches!(
                    slot.rt.identity().engine(),
                    ccg_engine::identity::EngineAxis::Codex { .. }
                );
                let payload = match (is_codex, payload) {
                    (true, Some(mut p)) => {
                        if let Some(o) = p.as_object_mut() {
                            if always {
                                o.insert("ccgAlways".into(), json!(true));
                            }
                            if let Some(a) = &answers {
                                o.insert("ccgAnswers".into(), json!(a));
                            }
                        }
                        Some(p)
                    }
                    (_, p) => p,
                };
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
            Op::Enqueue(input) => {
                let v = slot.rt.dispatch(Cmd::Enqueue(input));
                answer(verdict_wire("enqueue", &v));
            }
            Op::QueueMutate(spec) => {
                // 되돌리기(`restore`)만 전용 명령이 있다 — 나머지는 op을 값으로 실어 보낸다.
                // R3까지는 **어느 op이든 무동작**이었다(M-UX R2.1 표 #2).
                let v = match spec.get("op").and_then(Value::as_str) {
                    Some("restore") => slot.rt.dispatch(Cmd::QueueRestore {
                        token: spec.get("token").and_then(Value::as_str).unwrap_or("").to_string(),
                    }),
                    Some("remove") => slot.rt.dispatch(Cmd::QueueMutate(QueueOp::Remove {
                        id: spec.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
                    })),
                    Some("reorder") => slot.rt.dispatch(Cmd::QueueMutate(QueueOp::Reorder {
                        ids: spec
                            .get("ids")
                            .and_then(Value::as_array)
                            .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
                            .unwrap_or_default(),
                    })),
                    Some("clear") => slot.rt.dispatch(Cmd::QueueMutate(QueueOp::Clear)),
                    // 모르는 op — 접수만 하고 `Noop`을 돌려준다(렌더러가 앞서 나가도 안 죽는다).
                    _ => slot.rt.dispatch(Cmd::QueueMutate(QueueOp::Noop)),
                };
                answer(verdict_wire("queue.mutate", &v));
            }
            Op::ForceSettle(id) => {
                let v = slot.rt.dispatch(Cmd::ForceSettle { id });
                answer(verdict_wire("force_settle", &v));
            }
            Op::BgStop(id) => {
                slot.wire.note_user_bg_stop(&id);
                let v = slot.rt.dispatch(Cmd::BgStop { id });
                answer(verdict_wire("bg_task.stop", &v));
            }
            Op::Reload { queued, hold, auto } => {
                slot.rt.set_auto_resume(auto);
                slot.rt.reload_state(queued, hold);
                answer(json!({ "queued": slot.rt.queue_len(), "hold": slot.rt.hold().is_some(), "auto": auto }));
            }
            Op::ResumeNow => {
                let v = slot.rt.resume_now();
                answer(verdict_wire("hold.resume", &v));
            }
            Op::Debug | Op::Dispose | Op::ToolingGet | Op::SeatsChanged | Op::ArchiveError(_) => {
                unreachable!("위에서 처리")
            }
        }
    }

    /// ★M11 — **지금 CLI가 살아 있는 채팅들의 계정.** = "놀고 있지 않은 계정".
    ///
    /// `Idle`이 아니라는 것은 그 채팅에 프로세스가 붙어 있다는 뜻이고(스트리밍 중이든
    /// 상주 중이든), 그 채팅의 다음 턴은 그 계정을 태운다. 거기로 옮기면 두 대화가 한
    /// 5시간 창을 나눠 쓰다 **둘 다** 막힌다 — 자동 전환이 만들면 안 되는 상태다.
    fn burning_accounts(&self) -> std::collections::BTreeSet<String> {
        self.slots
            .values()
            .filter(|s| s.rt.state() != StateTag::Idle)
            .filter_map(|s| {
                let id = s.rt.identity();
                // ★Codex 축(2026-09-01) — Codex 채팅이 태우는 것은 OpenAI 계정이다.
                // "cx:" 접두로 우주를 가른다(같은 이메일이 두 provider에 있어도 서로
                // 안 가리게 — acct_switch::pick이 접두로 자기 축만 걸러 읽는다).
                if id.engine_kind() == ccg_engine::identity::EngineKind::Codex {
                    id.codex_account()
                        .map(str::to_string)
                        .or_else(super::acct_switch::default_codex_email)
                        .map(|e| format!("cx:{e}"))
                } else {
                    id.account().map(str::to_string)
                }
            })
            .collect()
    }

    /// 한 바퀴: 모든 런타임 tick → 프레임 번역 → 엔진 이벤트 → 상태 lite.
    fn pump(&mut self) {
        // 라우팅 캐시의 수명은 이 한 바퀴다(무효화 규약 1) — 최대 20ms 낡는다.
        self.route.clear();
        // ★M11 — **지금 태우고 있는 계정**을 전환 훅에 알린다. 노는 계정만 후보가 되는
        //   근거이고, 허브만이 이걸 안다(모든 슬롯을 소유하는 유일한 자리). tick 전에
        //   갱신해야 이 바퀴의 `check_hold`가 최신 값으로 판정한다.
        //   비용은 슬롯 수만큼의 문자열 clone이고, 슬롯은 열려 있는 대화의 수다.
        self.switcher.set_busy(self.burning_accounts());
        let chats: Vec<String> = self.slots.keys().cloned().collect();
        for chat in chats {
            let (frames, events, evs_state, moved) = {
                let Some(slot) = self.slots.get_mut(&chat) else { continue };
                // ★M11 R2(C2) — **슬롯 tick 사이에도 busy를 갱신한다.**
                //
                // 펌프 앞에서 한 번만 돌리면, 같은 바퀴에서 채팅1이 b로 옮겨 스폰해도
                // 채팅2가 보는 busy에는 b가 없다. 워커 스냅샷이 도착하는 순간 대기하던
                // N개 채팅이 **동시에** 열리므로 이건 좁은 레이스가 아니라 정상 경로다
                // (R1 크리틱 C2). 그래서 tick 전후로 이 슬롯의 (상태·계정)을 재고,
                // 바뀌었으면 그때만 다시 모은다 — 안 바뀌면 비용은 비교 한 번이다.
                let before = (slot.rt.state() != StateTag::Idle, slot.rt.identity().account().map(str::to_string));
                slot.rt.tick();
                let after = (slot.rt.state() != StateTag::Idle, slot.rt.identity().account().map(str::to_string));
                let moved = before != after;
                // stderr 한 줄도 상태기계의 프레임 최신성 근거가 아니다(F20) — 진단만.
                let errs = slot.rt.driver().drain_stderr();
                for l in errs {
                    ccg_store::archive::record(&chat, "stderr", &json!({"type":"stderr","text":l}));
                    slot.rt.on_stderr(&l);
                }
                let frames: Vec<Value> = slot.tap.borrow_mut().drain(..).collect();
                let mut out: Vec<Value> = vec![];
                // ★M9 — 이 채팅이 CLI에 실은 도구 정책(P1e `tools` 축)을 옮김기에 알린다.
                // 끈 MCP 서버·스킬은 `system/init`에서 **행째로 사라지므로**(실측), 이 값이
                // 없으면 "내가 껐다"와 "설정에 아예 없다"가 화면에서 같은 얼굴이 된다.
                // 값이 바뀔 때만 true → 그때만 스냅샷을 다시 낸다(매 tick REPLACE 방지).
                {
                    let tools = slot.rt.identity().tools();
                    let denied = tools.denied_mcp.clone();
                    // `SkillOverride`는 지금 `Disabled` 한 종류다 — 있으면 껐다는 뜻.
                    // 변종이 늘면 여기서 걸러야 하므로 `match`로 열어 둔다(빠뜨리면 컴파일 오류).
                    let off: std::collections::BTreeSet<String> = tools
                        .skill_overrides
                        .iter()
                        .filter(|(_, v)| matches!(v, ccg_engine::identity::SkillOverride::Disabled))
                        .map(|(k, _)| k.clone())
                        .collect();
                    if slot.wire.set_policy(&denied, &off) {
                        out.extend(slot.wire.tooling());
                    }
                }
                for f in &frames {
                    out.extend(slot.wire.translate(f));
                }
                let evs = slot.rt.drain_events();
                (frames.len(), out, evs, moved)
            };
            // 이 슬롯이 계정을 갈았거나 프로세스가 생겼다/죽었다 = 다음 슬롯의 `pick`이
            // 봐야 할 사실이 바뀌었다.
            if moved {
                self.switcher.set_busy(self.burning_accounts());
            }
            let _ = frames;
            // ① 내용(2.6.2 EngineEvent) — 렌더러가 그리는 것.
            //    ★3.0.5 — 한 틱(20ms)에 온 같은 메시지의 텍스트 조각은 하나로 합쳐 보낸다. 조각마다
            //    창별 직렬화 + JS 평가 + 리듀서 한 바퀴였다(감사 #6). 순서·경계는 그대로다 — 인접한
            //    같은 종류만 합친다.
            for ev in coalesce_stream(events) {
                self.fanout(&chat, ev);
            }
            // ② 상태·판정(3.0 브로드캐스트) + 2.6.2가 아는 몇 가지로의 번역.
            for e in evs_state {
                self.on_engine_event(&chat, e);
            }
            // ③ 엔진이 **스스로** 연 턴(예약 드레인 · 한도 재개)에 와이어 런을 열어 준다(★R4).
            //    ①·② 뒤에 두는 이유: `t1_spawn`은 `set_state("T1")`을 **보내기 전에** 하므로
            //    RunState 시점에는 아직 프롬프트가 안 나갔다. 여기가 두 경로(T1·T16)에서
            //    모두 "이미 보냈다"가 참인 유일한 지점이다.
            self.sync_engine_run(&chat);
            // ④ ChatStatusLite — 바뀐 것만.
            self.refresh_lite(&chat);
        }
    }

    fn on_engine_event(&mut self, chat: &str, e: Event) {
        if ccg_store::archive::enabled(chat){ccg_store::archive::record(chat,"runtime",&json!({"type":"runtime-event","text":format!("{e:?}")}));}
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
                ccg_store::archive::record(chat,"identity",&identity);
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
            // ★R4 — `chat:queue`는 이제 **첨부·정체성 스냅샷까지** 싣는다. R3의
            // `items: Vec<String>`(본문뿐)로는 렌더러가 자기 예약 목록을 이걸로 대체할 수
            // 없었다(M-UX R2.1 표 #3). `queue`(본문 배열)는 그대로 두고 `items`를 더한다 —
            // 얼려 둔 화면이 읽는 모양을 깨지 않으면서 새 화면이 쓸 값을 준다.
            Event::Queue { items, .. } => {
                let rows = self
                    .slots
                    .get(chat)
                    .map(|s| queue_rows(&s.rt))
                    .unwrap_or_else(|| Value::Array(vec![]));
                self.emit_all(
                    crate::ipc::ch::CHAT_QUEUE,
                    json!({ "chatId": chat, "queue": items, "items": rows }),
                );
                self.persist_queue(chat);
            }
            Event::Verdict { cmd, verdict } => {
                let panel = self.panel_alias(chat);
                self.emit_all(
                    crate::ipc::ch::CHAT_VERDICT,
                    json!({ "chatId": chat, "panelId": panel, "verdict": verdict_wire(cmd, &verdict) }),
                );
            }
            Event::Status { status, .. } => {
                let archive_run=self.slots.get(chat).map(|s|s.wire.run_id.clone()).unwrap_or_default();
                ccg_store::archive::record(chat,"lifecycle",&json!({"type":match status {TerminalStatus::Done=>"completed",TerminalStatus::Error=>"error",TerminalStatus::Aborted=>"aborted"},"runId":archive_run}));
                ccg_store::archive::checkpoint(chat);
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
            // ★M11 — **한도 소진 → 다른 계정으로 자동 전환** 배너.
            //
            // 채널을 늘리지 않는다: 문장은 이미 스레드에 줄을 붙이는 `notice`로 나가고
            // (구독자가 있는 유일한 자리다 — D7의 "구독자 없는 채널에만 말하기" 금지),
            // 되돌릴 재료는 **같은 봉투에 구조로** 실린다(`switch{}`). `notice`의 선택
            // 필드라 렌더러의 소진 가드를 건드리지 않고, 되돌리기 알약을 그리는 라운드가
            // 오면 그 필드만 읽으면 된다. 리비전 자체는 `chat:identity`가 이미 냈다
            // (`origin:"auto_account_switch"` · `changed:["billing.account"]`).
            Event::AccountSwitched {
                from,
                to,
                soonest_reset,
                revert_to,
            } => {
                let run = self.slots.get(chat).map(|s| s.wire.run_id.clone()).unwrap_or_default();
                // "언제 초기화되는지"는 **이 계정을 고른 이유**다(곧 버려질 잔량부터
                // 태운다). 모르면 그 절을 통째로 뺀다 — 지어내지 않는다(모델 폴백
                // 배너가 사유를 지어내지 않는 것과 같은 규약).
                let tail = soonest_reset.and_then(reset_phrase).unwrap_or_default();
                self.fanout(
                    chat,
                    json!({
                        "type": "notice", "runId": run,
                        "text": format!("사용 한도에 걸려 {to} 계정으로 바꿔 이어갑니다{tail}"),
                        "switch": {
                            "from": from, "to": to,
                            "soonestReset": soonest_reset,
                            "revertTo": revert_to,
                        },
                    }),
                );
            }
            Event::RespawnNotice { text, .. } => {
                let run = self.slots.get(chat).map(|s| s.wire.run_id.clone()).unwrap_or_default();
                self.fanout(chat, json!({ "type": "notice", "runId": run, "text": text }));
            }
            // ★3.0.5 — 중지가 예약을 버리면 **말한다**. 렌더러는 `chat:queue`를 안 듣고, 예약된
            // 전송의 말풍선은 스레드에 그대로 남아 있어 그 메시지가 조용히 사라진 것처럼 보였다
            // (「채팅이 씹힌다」 — 2026-09-03 보고: 도는 중에 보낸 말이 예약됐고, 중지가 그 예약을
            // 비웠다). 버리는 계약(중지 = 뒤에 줄 선 것까지 취소)은 그대로다 — 침묵만 없앤다.
            Event::QueueCleared { count, .. } if count > 0 => {
                let run = self.slots.get(chat).map(|s| s.wire.run_id.clone()).unwrap_or_default();
                let text = if count == 1 {
                    "중지해서 예약된 메시지 1건은 보내지 않았어요 — 필요하면 다시 보내 주세요.".to_string()
                } else {
                    format!("중지해서 예약된 메시지 {count}건은 보내지 않았어요 — 필요하면 다시 보내 주세요.")
                };
                self.fanout(chat, json!({ "type": "notice", "runId": run, "text": text }));
            }
            // 나머지(StateAssign·ProbeSent·EvidenceRearm·Settled·AskOpened/Closed·Spawn·
            // Exit·CloseInput·Compact·UnknownFrameDropped…)는 `chat:run-state`가 REPLACE로
            // 이미 싣거나 진단 전용이다 — 채널을 늘리지 않는다(§6.1 32채널).
            _ => {}
        }
    }

    /// **엔진이 스스로 연 턴**을 화면에 붙인다(★R4 — M-UX R2.1 표 #4).
    ///
    /// R3까지 `wire.begin_run()`은 `Op::Run`에서만 불렸다. 그래서 예약 드레인(T16/T17/T27)과
    /// 한도 재개로 시작된 턴은 **새 runId도 `analyzing`도 사용자 말풍선도 없이** 답만
    /// 도착했다. 결과가 둘이다:
    ///  ① 렌더러의 `busy`가 안 올라간다 → 얼려 둔 `useLimitResume`이 자기 대기표를
    ///     자동 해제하지 못하고 **같은 해제에 두 번째 재개를 쏜다**(재개 이중 소유).
    ///  ② "내가 보낸 적 없는 답"이 스레드에 뜬다.
    ///
    /// 그래서 여기서 와이어 런을 열고 에코를 낸다. `Op::Run`이 연 런은 `expect_run`으로
    /// 가려낸다 — 안 그러면 사용자가 보낸 턴의 말풍선이 두 벌 그려진다.
    fn sync_engine_run(&mut self, chat: &str) {
        let (first, echo) = {
            let Some(slot) = self.slots.get_mut(chat) else { return };
            let Some(cur) = slot.rt.run_id().map(|r| r.0) else { return };
            if slot.engine_run == Some(cur) {
                return;
            }
            slot.engine_run = Some(cur);
            let echo = slot.rt.take_echo();
            // ★R2 C4 — 억제는 **사람이 친 발화일 때만**이다.
            //
            // R1은 `expect_runs > 0`이면 에코를 통째로 버렸다. 그런데 재장전은 드레인이
            // 아니라 장전이라(`mod.rs` "재장전은 전송이 아니다") 재시작을 건넌 기계 예약은
            // **사용자의 다음 전송에 얹혀** 나가고, 그 런은 렌더러가 연 런이다. 결과가
            // 크리틱 A7이었다: 기계가 넣은 전문이 CLI에 들어갔는데 스레드에 남은 말풍선은
            // 사용자가 친 한 줄뿐 — 그 발화가 화면 어디에도 안 보였다.
            //
            // 렌더러가 그린 말풍선은 *사용자 발화*의 것이므로, 기계가 넣은 발화
            // (`LimitResume`·`ViewerAsk`·`NotifReplay`)는 억제 대상이 아니다. `expect_runs`도
            // 깎지 않는다 — 사용자의 그 전송은 아직 나가지 않았고, 뒤따르는 런이 그 짝이다.
            let machine = echo.as_ref().is_some_and(|e| e.origin != ccg_engine::queue::QueueOrigin::User);
            if slot.expect_runs > 0 && !machine {
                // 렌더러가 연 런이다 — 말풍선은 이미 그 화면이 그렸다.
                slot.expect_runs -= 1;
                return;
            }
            slot.run_seq += 1;
            let run_id = format!("r{}-{}", std::process::id(), slot.run_seq);
            let first = slot.wire.begin_run(&run_id);
            slot.terminal = lite::Terminal::None;
            (first, echo)
        };
        self.fanout(chat, first);
        if let Some(e) = echo {
            // ★3.0.5 — 말풍선이 이미 모든 창에 있는 발화(렌더러 전송이 예약됐다 드레인된 것 —
            // `QueuedMessage::echoed`)는 안 낸다. 내면 같은 문장이 두 번 그려진다.
            if e.echoed {
                return;
            }
            let run = self.slots.get(chat).map(|s| s.wire.run_id.clone()).unwrap_or_default();
            // 계약면에 없던 이벤트다(2.6.2 `EngineEvent`에는 사용자 에코가 없다 —
            // 렌더러가 자기 `begin` 리듀서로 말풍선을 만들었다). 얼려 둔 화면의
            // 리듀서는 모르는 `type`을 `default:`로 흘리므로 무해하고, 3.0 화면은
            // 이 값으로 예약이 나간 자리를 그린다.
            self.fanout(
                chat,
                json!({ "type": "user-echo", "runId": run, "text": e.text,
                        "images": e.images, "origin": e.origin.wire() }),
            );
        }
    }


    /// 큐·대기표를 **채팅 파일의 Rust 소유 필드**로 내린다(★R4).
    ///
    /// R3은 `reload_pending`으로 *읽기*만 배선했다 — 쓰는 쪽이 없어서 2.6.2가 마이그레이션
    /// 때 남긴 값만 되살아났고, **3.0에서 건 예약은 재시작에 증발**했다. `identity`가
    /// 이미 그렇게 내려가고 있으므로(§4.1 규약 2) 같은 문을 쓴다.
    ///
    /// `set_owned`는 디바운스 없이 그 자리에서 파일 하나를 쓴다. 큐가 바뀌는 순간은
    /// 사용자 조작·드레인뿐이라 유휴에는 한 번도 안 돈다.
    fn persist_queue(&self, chat: &str) {
        let Some(slot) = self.slots.get(chat) else { return };
        ccg_store::chats_v3::set_owned(chat, "queue", queue_rows(&slot.rt));
    }

    /// 대기표를 디스크로 — `resetsAt`은 **epoch 초**다(런타임 시계는 단조 ms).
    /// 두 축을 섞으면 다음 부팅의 재장전이 1970년으로 읽어 **부팅이 곧 전송**이 된다
    /// (`engine::remaining_ms`가 반대 방향으로 하는 변환의 짝).
    fn persist_hold(&self, chat: &str) {
        let Some(slot) = self.slots.get(chat) else { return };
        let v = match slot.rt.hold() {
            Some(h) => {
                let now_ms = slot.rt.now();
                let epoch_now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs_f64())
                    .unwrap_or(0.0);
                let resets_at = h
                    .resets_at
                    .map(|r| epoch_now + (r as f64 - now_ms as f64) / 1000.0);
                // ★R28f WFIRE — **상한도 함께 내린다.** R28e까지 여기 실리는 것은 시각과
                // `ready` 둘뿐이었고, 그래서 `reload_state`가 계수·예산을 0으로 놓는 것
                // 말고는 할 수 있는 일이 없었다 — 재시작 한 번이 「아무 구분자도 못 지우는
                // 예산」을 통째로 지웠다(확인 크리틱 R1 §4.1: 재장전 뒤 20시간 12발 재충전).
                //
                // ★R28g BANNER — **`auto_paused`도 내린다.** R28f는 "판정 결과는 안 적고
                // 부팅 뒤 `check_hold`가 이 두 값으로 다시 판정한다"고 적었는데, 그 문장이
                // 실측과 반대였다(확인 크리틱 R1 F1): `check_hold`의 첫 문이
                // `filter(|h| !h.ready)`라 **접힌 표는 재판정에 도달하지 못한다.** 그래서
                // 부팅 행이 `paused:false`로 서고, 12발을 태운 표에 대고 배너가 「한도가
                // 풀렸어요」라고 말했다(포획된 실앱 원문 `{"ready":true,"fires":12,"paused":false}`).
                //
                // 참이었던 상태는 잃지 않는 쪽이 정직하다. 재판정 쪽도 함께 고쳤지만
                // (`LimitHold::reloaded`) 그건 **부팅 뒤 첫 due**에나 도는 값이고, 화면은
                // 그전에 이미 이 파일을 읽어 첫 프레임을 그린다(`status::truth_from_chat_file`).
                json!({ "resetsAt": resets_at, "ready": h.ready, "paused": h.auto_paused,
                        "attempts": h.attempts, "fires": slot.rt.episode_fires() })
            }
            None => Value::Null,
        };
        ccg_store::chats_v3::set_owned(chat, "hold", v);
    }

    fn refresh_lite(&mut self, chat: &str) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        // ★3.0.5 — 자리(보드) 조회는 펌프당 한 번(라우팅 캐시와 같은 수명). 3.0.4까지
        // `lite::build`가 슬롯마다 틱마다 보드 전체를 깊이 복제했다(감사 #7).
        let seat = match self.route.seats.get(chat) {
            Some(s) => s.clone(),
            None => {
                let s = super::panel_seat_of(chat);
                self.route.seats.insert(chat.to_string(), s.clone());
                s
            }
        };
        let Some(slot) = self.slots.get_mut(chat) else { return };
        let mut next = lite::build(&slot.rt, slot.terminal, now, seat);
        // updatedAt만 다른 것은 "바뀐 것"이 아니다(매 틱 브로드캐스트 방지).
        if lite_same(&next, &slot.last_lite) {
            return;
        }
        if let Some(o) = next.as_object_mut() {
            o.insert("updatedAt".into(), json!(now));
        }
        // 대기표가 달라졌으면 채팅 파일에도 내린다 — 재시작 재장전의 **원천**이다(★R4).
        let hold_changed = slot.last_lite.get("hold") != next.get("hold");
        slot.last_lite = next.clone();
        ccg_store::status::set(chat, next);
        if hold_changed {
            self.persist_hold(chat);
        }
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

/// ★M11 — 리셋 시각(unix 초) → 배너 꼬리. **상대 시간**이라 타임존이 필요 없다
/// (`chrono`를 들이지 않는 이유이자, "몇 시에"보다 "얼마 뒤에"가 이 문장에서 더 쓸모
/// 있는 이유다 — 사용자가 알고 싶은 건 *언제까지 이 계정을 쓰나*다).
/// 이미 지난 값·미래가 아닌 값은 `None` = 문장에서 그 절이 통째로 빠진다.
fn reset_phrase(resets_at: u64) -> Option<String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    let left = resets_at.checked_sub(now).filter(|s| *s > 0)?;
    let mins = left / 60;
    Some(if mins < 60 {
        format!(" — 이 계정은 약 {}분 뒤 초기화돼요.", mins.max(1))
    } else {
        format!(" — 이 계정은 약 {}시간 뒤 초기화돼요.", mins / 60)
    })
}

fn origin_wire(o: &RevisionOrigin) -> String {
    match o {
        RevisionOrigin::Default => "default".into(),
        RevisionOrigin::User => "user".into(),
        RevisionOrigin::EngineFallback(_) => "engine_fallback".into(),
        RevisionOrigin::DeferredApply => "deferred_apply".into(),
        RevisionOrigin::Revert(_) => "revert".into(),
        RevisionOrigin::Restore => "restore".into(),
        // ★M11이 event.rs에 추가한 변종. 와이어 문자열은 그쪽 주석이 선언한 값 그대로다
        // (빌드가 멈춰 있어 여기서 채웠다 — 의미의 주인은 M11이다).
        RevisionOrigin::AutoAccountSwitch => "auto_account_switch".into(),
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

/// 큐 전문 → `chat:queue.items` / 채팅 파일의 `queue`(★R4).
///
/// **한 함수가 두 곳을 먹인다**: 화면이 그리는 목록과 디스크에 남는 목록이 갈리면
/// 재시작 뒤 "화면에 있던 예약이 사라진다/없던 게 생긴다"가 된다. `read_chat_queue`가
/// 읽는 키(`text`·`images`)를 그대로 쓴다.
fn queue_rows<D: CliDriver>(rt: &ChatRuntime<D>) -> Value {
    Value::Array(
        rt.queue_items()
            .map(|m| {
                json!({
                    "id": m.id,
                    "text": m.text,
                    "images": m.attachments,
                    "origin": m.origin.wire(),
                    "createdAt": m.created_at,
                    "identityRev": m.identity_rev,
                    // 예약 시점 picker의 **결과값**. 렌더러는 이걸로 "이 예약은 opus/plan로
                    // 나간다"를 그린다(요청 조립은 여전히 엔진이 한다).
                    "picker": {
                        "model": m.identity.model(),
                        "effort": serde_json::to_value(m.identity.effort()).unwrap_or(Value::Null),
                        "mode": serde_json::to_value(m.identity.mode()).unwrap_or(Value::Null),
                        "cwd": m.identity.cwd().as_str(),
                        "account": m.identity.account(),
                    },
                })
            })
            .collect(),
    )
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

    let thread=std::thread::Builder::new()
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
                reject_seq: 0,
                // ★M11 — 워커 스레드 하나를 여기서 띄운다(앱당 1개). 설정이 꺼져 있으면
                // 그 스레드는 영원히 `recv()`에서 잠들어 있다 = 비용 0.
                switcher: super::acct_switch::Switcher::start(),
                // ★T3T4 R3 — 한도 재검증 훅. 같은 모양(워커 1개 + 스냅샷)이고 같은 이유다:
                // 허브 스레드에서 HTTP를 기다리면 다른 대화의 스트리밍이 통째로 멈춘다.
                probe: super::limit_probe::Probe::start(),
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
            for (chat, mut s) in hub.slots.drain() {
                s.rt.app_quit();
                ccg_store::archive::record(&chat,"lifecycle",&json!({"type":"interrupted","reason":"application-exit"}));
            }
            ccg_store::archive::shutdown();
        })
        .ok();
    *HUB_THREAD.get_or_init(||Mutex::new(None)).lock().unwrap_or_else(|e|e.into_inner())=thread;
}

/// 앱 종료 — 허브를 닫고 상태를 디스크로 내린다(D15).
pub fn shutdown() {
    ccg_store::archive::request_shutdown();
    {
        let mut g = tx_slot().lock().unwrap_or_else(|e| e.into_inner());
        // Sender를 떨어뜨리면 허브 루프가 Disconnected로 빠져나오며 CLI를 거둔다.
        g.take();
    }
    // 500ms 디바운스가 남아 있을 수 있다 — 마지막 값을 지금 쓴다(§5.8 규약 4).
    ccg_store::status::flush();
    if let Some(thread)=HUB_THREAD.get().and_then(|s|s.lock().unwrap_or_else(|e|e.into_inner()).take()){let _=thread.join();}
}
