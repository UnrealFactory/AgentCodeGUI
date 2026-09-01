//! **엔진 글루** — `ccg-engine`(상태기계·드라이버) × `ccg-store`(앱 홈) × 셸(창·IPC)의 결합점.
//!
//! 이 모듈이 있기 전까지 세 조각은 서로를 몰랐다: 엔진은 97개 재생 시나리오 안에서만
//! 돌았고, 스토어는 채널로만 만져졌고, 셸은 창만 띄웠다. 여기서 셋을 잇는다.
//!
//! ```text
//!   렌더러(2.6.2)                셸(src-tauri)                      크레이트
//!   ─────────────                ─────────────                      ────────
//!   claude:run      ──▶  ipc::dispatch ──▶ engine::dispatch ──Job──▶ [허브 스레드]
//!   engine:event    ◀──  fanout(chatId→창)  ◀──────────────────────  ChatRuntime
//!   chat:*(3.0)     ◀──▶  같은 허브                                   + ClaudeDriver
//! ```
//!
//! ## 주소 (m-logic §4.3 ★R2)
//!
//! 주소는 **`chatId` 문자열 하나**다. 표면(`surface`) 구분이 없다. 옛 채널은 각자
//! 자기 인자를 갖고 있으므로 **번역 함수 셋**만 둔다(타입이 아니다):
//!
//! | 옛 채널 | 대상 | 함수 |
//! |---|---|---|
//! | `claude:*` | 활성 채팅 | [`active_chat_id`] |
//! | `ma:*` `{panelId}` | 그 자리의 채팅 | [`panel_id_to_chat`] |
//! | `session:*` | 그 창의 채팅 | [`chat_for_window`] |
//!
//! ## **배선하지 않은** 것 (조용히 빠뜨리지 않는다 — ★R4 갱신)
//!
//! - `btw:open`(포크 질문 창) · `talk:*`(은퇴) · Codex 엔진(app-server)
//! - `chat:answer`의 답을 **선택지 요약 문장**으로 되먹이는 것까지는 했지만,
//!   `allow_always`의 `updatedPermissions`는 아직 안 싣는다(허용은 1회로 동작).
//!
//! R3에서 닫힌 것: **부팅 재장전**([`reload_pending`]) · `EngineEvent` 9종(`wire.rs`) ·
//! 창 자리 4채널 + `chat:windows`(`ipc/windows.rs`).
//! **R4에서 닫힌 것**: `chat:flush-req`(**32 / 32채널** — `ipc/windows.rs::flush_req`) ·
//! `result.tokenUsage`·`contextWindow`·`tool-end.links`(`wire.rs`) ·
//! `chat:queue-mutate`의 `enqueue`/`remove`/`reorder`(큐 Rust 이관) ·
//! **재개 단일 소유**(`ChatStatusLite.resumeOwner` + 엔진 드레인의 `begin_run`).

mod acct_switch;
mod any;
/// ★R28 T1T2 R2 — 부팅 엔진 자동 업데이트(2.6.2 `runBootEngineUpdate`).
/// `pub`인 이유: 셸(`main.rs`)이 흐름을 시작하고 `ipc/app_meta.rs`가 상태·플래그를
/// 이 모듈 하나에서 읽어야 한다(사본이 늘면 두 답이 갈린다).
pub mod boot_update;
/// ★SLUG R1 — 계정 이메일 → 격리 `CLAUDE_CONFIG_DIR`(Claude 축의 리졸버 배선).
/// Codex 축의 [`codex_versions::resolver`]와 짝이다 — 폴더 이름은 `ccg-auth`만 짓는다.
mod claude_account;
/// ★CRIT R1 — Codex 한도 창 조회(`account/rateLimits/read`). 재검증 훅이 **Codex 채팅을
/// 클로드 한도로 판정하던** 회귀(T3T4 확인 크리틱 R3 §3)를 닫는 재료다.
///
/// ★R28b RVERD — `pub`인 이유는 `versions`·`codex_versions`와 같다: **렌더러 채널**
/// (`codex-auth:accounts-usage` — `ipc/parity/mod.rs`)이 이 조회기·이 캐시를 그대로 써야
/// 한다. 사본을 만들면 두 벌이 각자 만료를 세면서 app-server를 번갈아 태운다.
pub mod codex_limit;
pub mod codex_versions;
mod diff;
mod hub;
mod ident;
/// ★R28 T3T4 R3 — 한도 재검증 훅(`LimitProbe`)의 셸 배선. 「못 물어봤다」와
/// 「막는 창이 없다」를 가르는 자리이고, 본채팅의 자동 재개가 그 판정 위에 선다.
mod limit_probe;
mod lite;
mod tap;
/// ★M11 R3(F5) — `CCG_HOME`을 만지는 **모든** 테스트가 나눠 잡는 자물쇠.
#[cfg(test)]
pub(crate) mod testhome;
/// ★최종 파리티 T2 — Claude 엔진 CLI 버전 관리(`engine:*` 5채널) + 실행 파일 고르기.
/// `pub`인 이유: 계정 팔(`ipc/accounts.rs`)이 `claude auth …`를 조립할 때 **같은
/// 실행 파일**을 써야 한다(경로가 두 곳에 적히면 한쪽만 고쳐진다).
pub mod versions;
mod wire;

use super::ipc::{arg, ch};
use ccg_engine::identity::{ApplyPolicy, PendingOp};
use ccg_engine::live::AskKind;
use ccg_engine::runtime::Cmd;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, WebviewWindow};

pub use hub::shutdown;

/// 부팅 — 허브 스레드 + `status.json` 장전 + 첫 `chat:status` REPLACE.
///
/// 장전 순서가 규약이다(§5.8): **파일 로드 → 부팅 강제 → 브로드캐스트**. 강제 없이
/// 그리면 지난 세션의 `busy`·`ask`가 그대로 살아나 유령 알약이 뜬다.
pub fn boot(app: &AppHandle) {
    // ★R4 귀속 팔 — 스위치는 `flags.rs` 헤더의 표에 있다. 기본값은 전부 켬이라
    // 아무 env도 없으면 이 함수의 동작은 R3과 한 글자도 다르지 않다.
    if crate::flags::no_engine_glue() {
        return;
    }
    let ids = all_chat_ids();
    if !crate::flags::no_status_boot() {
        ccg_store::status::load_boot(&ids);
    }
    if !crate::flags::no_engine_hub() {
        hub::start(app.clone());
        if !crate::flags::no_status_boot() {
            reload_pending(&ids);
        }
    }
    if !crate::flags::no_status_boot() {
        let _ = app.emit(ch::CHAT_STATUS, status_array());
    }
}

/// **부팅 재장전**(m-logic §5.8 부팅 경로 2단계 · ux-chat-unify §4.3).
///
/// 후보는 `hold != null ∨ queued > 0`인 채팅뿐이다(`status::reload_candidates` —
/// `status.json`이 인덱스고, 없거나 깨졌으면 채팅 파일 전수 **얕은 스캔**으로 만든다).
/// 후보마다 런타임을 물질화하고 큐·대기표를 세운다. 이 경로가 없으면 재시작 후
/// 자동 이어서가 **조용히** 안 산다(§R2.8-B).
///
/// **자동 발사 범위 = 스펙 ⑤ 기본값**: *보이는 자리 + 열린 창만 자동*. 부팅 시점에
/// 추가 채팅 창은 아직 하나도 없으므로(창 복원은 사용자 클릭이다) 자동 대상은
/// **활성 채팅 + 활성 보드의 보이는 자리**다. 나머지는 `ready`만 켜고 멈춘다 —
/// 화면 밖 채팅 여섯 개가 앱을 켜자마자 동시에 토큰을 쓰기 시작하면 안 된다.
///
/// **재장전은 전송이 아니다.** 예약분은 큐에 그대로 서 있고, 나가는 계기는 사용자의
/// 다음 전송이거나 한도 해제뿐이다(`ChatRuntime::reload_state`가 드레인하지 않는다).
fn reload_pending(ids: &[String]) {
    let cands = ccg_store::status::reload_candidates(ids);
    if cands.is_empty() {
        return;
    }
    let mut auto: std::collections::BTreeSet<String> = ccg_store::boards::visible_chat_ids().into_iter().collect();
    let active = active_chat_id();
    if !active.is_empty() {
        auto.insert(active);
    }
    for id in cands {
        let Some((queued, hold)) = reload_plan(&id) else { continue };
        hub::call(
            &id,
            hub::Op::Reload {
                queued,
                hold,
                auto: auto.contains(&id),
            },
        );
    }
}

/// 채팅 하나의 **재장전 판정** — 허브를 부를 것인가, 그리고 무엇을 실을 것인가.
/// `None`이면 이 채팅은 건너뛴다(= 되살릴 것도, 다시 굳힐 것도 없다).
///
/// `reload_pending`에서 갈라 놓은 이유는 둘이다.
///  1. 이 판정이 **화면에 보이는 결과**를 가른다(아래 ★R28L) — 못을 박으려면 허브 스레드
///     없이 부를 수 있어야 한다.
///  2. 허브 호출은 런타임을 **물질화**하는 일이라, 부를지 말지의 근거가 한 자리에 있어야
///     다음 사람이 조건을 늘릴 때 비용을 같이 본다.
fn reload_plan(
    id: &str,
) -> Option<(Vec<ccg_engine::queue::QueueInput>, Option<ccg_engine::runtime::ReloadHold>)> {
    let lite = ccg_store::status::read_chat_lite(id)?;
    let rows = ccg_store::status::read_chat_queue(id);
    let before = rows.len();
    // ★R4 — 본문뿐이던 것이 첨부까지 되살아난다(`QueueInput`).
    let queued: Vec<ccg_engine::queue::QueueInput> = rows
        .into_iter()
        // ★R28k — 은퇴한 「대화 연결」이 남긴 봉투는 여기서 죽는다(아래 주석 참조).
        .filter(|q| !is_retired_talk_row(q))
        .map(|q| ccg_engine::queue::QueueInput {
            text: q.text,
            images: q.images,
            // 정체성 스냅샷은 **다시 잡는다**(m-logic §5.8 "복원이 아니라 재장전" —
            // 그 사이 폴더·계정이 바뀌었을 수 있다).
            picker: None,
            // ★R2 C4 — 되살린 예약은 **신분을 그대로 안고 온다.**
            //
            // R1은 여기서 `origin: None`으로 되돌렸다(주석은 "낡은 표식을 들고 다니지
            // 않게"). 그런데 `None` = `User`이므로, §3.7이 막겠다던 결과가 **그대로**
            // 생겼다: 헛 재개 연쇄 카운터가 리셋되고 한도 대기표가 "사용자가 이미
            // 다시 보냈다"로 판정한다. 규약을 지키려고 규약을 깬 자리였고, 크리틱은
            // 디스크에 `origin:"user"`가 다시 굳는 것까지 확인했다(A7).
            //
            // 신분은 **표식이 아니라 사실**이다 — 그 줄을 넣은 자는 재시작으로 바뀌지
            // 않는다. 모르는 낱말은 `None`(사람)으로 떨어진다: 옛 파일과 2.6.2 문자열
            // 배열이 그 경로이고, 둘 다 실제로 사람의 예약이다.
            origin: origin_of(q.origin.as_deref()),
        })
        .collect();
    // 필터가 **실제로 버린** 줄 수. 0이면 이 채팅에는 은퇴한 봉투가 없었다는 뜻이다.
    let dropped = before - queued.len();
    let hold = lite.hold.map(|h| ccg_engine::runtime::ReloadHold {
        // 저장은 초 단위 epoch(2.6.2 `useLimitResume`의 `resetsAt` — `limitResume.ts:13`)
        // 이고 런타임 시계는 프로세스 기동 기준 단조 밀리초다 — **남은 시간**으로 옮긴다.
        in_ms: h.resets_at.map(remaining_ms),
        ready: h.ready,
        // ★R28f WFIRE — 상한 두 칸을 **그대로** 나른다(옛 파일엔 없어서 0 = R28e 동작).
        // 이 두 줄이 없으면 `reload_state`가 아무리 칸을 내도 경계에서 값이 증발한다.
        attempts: h.attempts,
        fires: h.fires,
        // ★R28g BANNER — 접힘도 그대로 나른다(옛 파일엔 없어서 `false` = R28f 동작).
        // 이 줄이 없으면 `reload_state`가 칸을 내도 경계에서 값이 증발해, 12발을 태운
        // 표가 부팅 한 번에 「아직 안 접힌 표」로 되살아난다(확인 크리틱 R1 F1).
        paused: h.paused,
    });
    // ★R28L LONE(R28k 확인 크리틱 R2 F1) — **버린 것이 있으면 되살릴 게 없어도 부른다.**
    //
    // R28k는 여기가 `queued.is_empty() && hold.is_none()`이었다. 그래서 큐에 봉투 한 줄
    // 뿐이고 대기표가 없는 채팅은, 필터가 그 한 줄을 버린 **바로 그 순간** "되살릴 게
    // 없다"가 되어 `Op::Reload`를 아예 안 불렀다. 재경화(`hub::persist_queue`)는 재장전에
    // 매달려 있으므로 디스크의 봉투가 그대로 남고, **채팅을 열면** 예약 패널
    // (`Chat.tsx`의 「예약된 메시지」)에 `<<<TALK-DATA …>>>` 전문이 그대로 뜬다 —
    // 그 패널은 `App.tsx`가 채팅의 `queue` 배열을 `setQueue`로 세운 것이라 파일이
    // 되굳기 전까지 봉투를 계속 싣는다.
    //
    // ★사이드바에는 안 보인다(R28L 확인 크리틱 R1 F1이 정정). `status.json`의
    // `queued` 칸은 계약면에만 있는 파생값이고 `app/src` 어디에서도 안 읽는다
    // (`rg "\.queued\b" app/src` = 0건 · `Sidebar.tsx`에는 그 낱말이 역사상 없었다).
    // 앞 라운드가 「사이드바 배지 「1」」이라 적은 것은 재보지 않고 옮긴 문장이다.
    //
    // 나가지는 않지만(필터가 매 부팅 다시 걸린다) **화면 앞에서 「통째로 들어냈다」가
    // 거짓이 된다.** 이 모양은 흔하다: 상대가 작업 중이면 봉투는 큐에 앉으므로, 그 턴
    // 전에 앱을 닫으면 정확히 「봉투 한 줄 · 대기표 없음」이다.
    //
    // **`dropped > 0`만 더한다 — 그 판만 정확히.** `!queued.is_empty() || hold.is_some()`을
    // 통째로 지워 버리면(= 항상 부르면) 큐 항목이 본문·첨부 둘 다 빈 쓰레기 한 줄뿐인
    // 채팅까지 매 부팅 런타임을 물질화한다. 이 조건의 비용은 **한 번뿐**이다: 첫 부팅에
    // 파일이 빈 큐로 다시 굳고 나면 그 채팅은 `reload_candidates`에 아예 안 걸린다
    // (그 함수가 보는 것이 `queue` 길이다). 봉투를 한 번도 안 받은 홈에서는 `dropped`가
    // 항상 0이라 이 줄이 없는 것과 **한 글자도 다르지 않다**(부팅 시간 실측: 보고서 §10).
    if queued.is_empty() && hold.is_none() && dropped == 0 {
        return None;
    }
    Some((queued, hold))
}

/// 디스크의 `origin` 낱말 → 큐 원본. `chat:queue`가 쓰는 그 어휘다
/// (`QueueOrigin::wire()`의 역함수). 모르는 값은 `None` = 사람.
fn origin_of(w: Option<&str>) -> Option<ccg_engine::queue::QueueOrigin> {
    use ccg_engine::queue::QueueOrigin as O;
    match w? {
        "limit_resume" => Some(O::LimitResume),
        "viewer_ask" => Some(O::ViewerAsk),
        "notif_replay" => Some(O::NotifReplay),
        _ => None,
    }
}

/// ★R28k M10 제거 — **은퇴한 「대화 연결」이 남긴 봉투는 되살리지 않는다.**
///
/// 베타에서 그 기능을 켜 뒀던 홈의 채팅 파일에는 `origin:"talk"`인 예약이 남아 있을 수
/// 있다. 어휘를 지우기만 하면 그 줄은 `origin_of`에서 `None`(= 사람)으로 떨어져,
/// **다음 부팅에 사용자가 친 말인 척 CLI로 들어간다** — 기능을 뺀 이유가 정확히 그
/// 「사람 자리를 대신 차지하는 한 줄」이었다. 재장전 단계에서 통째로 버린다.
fn is_retired_talk_row(q: &ccg_store::status::QueuedText) -> bool {
    q.origin.as_deref() == Some("talk")
}

/// 저장된 `resetsAt`(epoch 초)을 **런타임 시계의 밀리초**로 옮긴다.
///
/// 이 변환을 빼먹으면 대기표가 1970년으로 읽혀 부팅 즉시 발화한다(= 재시작이 곧 전송).
/// 이미 지난 시각이면 0 — `due_at()`이 붙이는 90초 재검증 지연 뒤에 발화한다.
fn remaining_ms(resets_at_epoch_secs: f64) -> u64 {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    let left = (resets_at_epoch_secs - now).max(0.0);
    (left * 1000.0) as u64
}

/// 전 채팅 `ChatStatusLite` — 계약면은 **배열**이다(§6.1 `chat:status  ChatStatusLite[]`).
/// (`chats:get`이 합쳐 주는 `statuses`는 객체 맵이다 — 그쪽은 id로 찾는 조회라서.)
pub fn status_array() -> Value {
    match ccg_store::status::snapshot() {
        Value::Object(m) => Value::Array(m.into_iter().map(|(_, v)| v).collect()),
        _ => Value::Array(vec![]),
    }
}

fn all_chat_ids() -> Vec<String> {
    if ccg_store::unified_store_enabled() {
        // ★R4 — id만 필요한데 R3은 `all_chats()`로 **채팅 전문을 전부 파싱**했다.
        // 부팅 경로의 순수 낭비였고, 그 트리가 남긴 페이지가 유휴 상주에 얹혔다.
        // (`CCG_DEEP_BOOT_SCAN=1`은 그 R3 경로로 되돌리는 귀속 팔이다.)
        if ccg_store::deep_boot_scan() {
            return ccg_store::chats_v3::all_chats()
                .iter()
                .filter_map(|c| c.get("id").and_then(Value::as_str).map(str::to_string))
                .collect();
        }
        ccg_store::chats_v3::chat_ids()
    } else {
        ccg_store::chats::read_chats(true)
            .get("chats")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|c| c.get("id").and_then(Value::as_str).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    }
}

/// 옛 `claude:*`의 대상 — **지금 활성 채팅**(§6.2 U3).
///
/// 진실 소스는 `chats:set-active`가 즉시 갱신하는 인덱스다. 얼려 둔 2.6.2 렌더러는 아직
/// 그 채널을 부르지 않으므로(이번 라운드는 app/ 금지) 마지막 `chats:save`의 값이 온다 —
/// 저장 디바운스(400ms)만큼 낡을 수 있다는 뜻이고, 그 창에서 채팅을 바꾸자마자 보내면
/// 남의 런타임에 붙는다. **다음 라운드에 렌더러 3곳 한 줄**이 이 구멍을 닫는다.
pub fn active_chat_id() -> String {
    let id = if ccg_store::unified_store_enabled() {
        ccg_store::chats_v3::active_chat_id()
    } else {
        ccg_store::read_home_json("chats/index.json")
            .and_then(|v| v.get("activeChatId").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_default()
    };
    if !id.is_empty() {
        return id;
    }
    // 활성 표식이 아직 없다(새 홈의 첫 부팅). 첫 채팅에 붙이고, 그것도 없으면
    // 고정 id 하나를 쓴다 — **조용히 남의 채팅에 붙이지는 않는다**.
    all_chat_ids().into_iter().next().unwrap_or_else(|| "chat-unassigned".into())
}

/// `${boardId}::${slot}` → 그 자리에 앉은 채팅. 보드가 진실이라 패널을 옮겨도 따라간다.
pub fn panel_id_to_chat(panel_id: &str) -> Option<String> {
    let (board, slot) = panel_id.split_once("::")?;
    let slot: usize = slot.parse().ok()?;
    let b = ccg_store::boards::read_board(&json!(board));
    b.get("slots")?
        .get(slot)?
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// 역인덱스 — 이 채팅이 어느 자리에 앉아 있나(`ma:event` 봉투용).
pub fn panel_id_for_chat(chat: &str) -> Option<String> {
    let all = ccg_store::boards::read_boards();
    for b in all.get("boards")?.as_array()? {
        let id = b.get("id")?.as_str()?;
        for (i, s) in b.get("slots")?.as_array()?.iter().enumerate() {
            if s.as_str() == Some(chat) {
                return Some(format!("{id}::{i}"));
            }
        }
    }
    None
}

/// ★R28 ACCT R2(F4) — **표시용** 자리 id. 「사용 중 · 2번 자리」의 그 번호다.
///
/// `panel_id_for_chat`과 갈리는 자리는 하나: **`chrome:"ide"` 보드는 자리로 세지 않는다.**
/// 그 보드는 멀티 그리드가 아니라 **본채팅 화면**이고(마이그레이션이 `count:1`일 때
/// 그렇게 적는다 — `migrate_v3.rs`), 거기 앉은 채팅은 「1번 자리」가 아니라 「본채팅」이다.
///
/// R1은 라우팅용 함수를 그대로 썼다. 그래서 본채팅의 `panelId`가 `default::0`이 되고,
/// 렌더러의 `slotsUsing`은 자리 번호를 이름표보다 먼저 고르므로 **본채팅도 「1번 자리」**로
/// 나왔다 — 멀티 보드의 첫 자리와 문구가 같아져 *어디서 쓰는 중인지*를 못 가렸고,
/// `MAIN_SLOT_NAME`(「본채팅」)은 실사용에서 도달 불가였다(확인 크리틱 R1 F4).
///
/// 라우팅(`ma:event` 봉투)은 **일부러 안 건드린다** — 그쪽은 "이 봉투를 누가 듣나"의
/// 문제라 판정이 다르고, 본채팅 화면에는 그 봉투를 듣는 리스너가 없어 무해하다.
pub fn panel_seat_for_chat(chat: &str) -> Option<String> {
    let all = ccg_store::boards::read_boards();
    for b in all.get("boards")?.as_array()? {
        // `chrome`이 없는 옛 보드는 `grid`로 본다(= 지금까지의 동작 그대로).
        if b.get("chrome").and_then(Value::as_str).unwrap_or("grid") == "ide" {
            continue;
        }
        let id = b.get("id")?.as_str()?;
        for (i, s) in b.get("slots")?.as_array()?.iter().enumerate() {
            if s.as_str() == Some(chat) {
                return Some(format!("{id}::{i}"));
            }
        }
    }
    None
}

/// 이 창(추가 채팅 창)이 보는 채팅. 메인 창이면 활성 채팅.
pub fn chat_for_window(window: &WebviewWindow) -> String {
    if window.label() == crate::win::MAIN {
        return active_chat_id();
    }
    crate::win::chat_for_label(window.label()).unwrap_or_else(active_chat_id)
}

/// 이 창이 보는 **추가 채팅**(메인 창이면 `None`). 저장/복원 채널의 주소다 —
/// `chat_for_window`처럼 활성 채팅으로 폴백하면 **본채팅을 덮어쓴다.**
pub fn session_chat_for_window(window: &WebviewWindow) -> Option<String> {
    if window.label() == crate::win::MAIN {
        return None;
    }
    crate::win::chat_for_label(window.label())
}

/// ★R28b ACCT R3(G1) — **지워진 대화들을 실제로 거두고, 그 사실을 한 번 알린다.**
///
/// (R2의 `dispose_chat(chat)` 한 줄짜리 함수는 여기로 흡수했다 — 호출자가 하나뿐이었고,
///  그 하나가 **회수만 하고 알리지는 않아서** G1이 났다. 회수와 통지를 갈라 놓을 수 있는
///  모양을 남겨 두면 다음 호출자가 또 반쪽만 부른다.)
///
/// 확인 크리틱 R2가 실 exe로 찍은 것: 같은 계정을 문 채팅 둘 중 하나를 지우면 디스크는
/// prune되는데(`index.json`·`status.json` 둘 다 한 줄) `chat:status`는 **지운 채팅을
/// 계정과 함께 계속 싣고** picker 칩이 「사용 중 · 다른 자리」로 남았다 — 12초 무입력에
/// 브로드캐스트 0건, 다음 턴이 나야 걷혔다. R2는 그 브로드캐스트를 `Op::Dispose` →
/// `status::clear_runtime`에 매달았지만 **두 삭제 경로 모두 행을 먼저 지운 뒤** 그 문을
/// 두드려 `false`를 받았고(그리고 본채팅 삭제는 `Op::Dispose`를 아예 안 보냈다), 그 문은
/// 태어날 때부터 닫혀 있었다.
///
/// 그래서 문을 옮겼다. 순서가 이 함수의 전부다:
///
/// 1. 지워진 id마다 `Op::Dispose`를 **던진다**(cast). 본채팅 삭제 경로에는 이 회수가
///    아예 없었다 — 상주 CLI가 붙어 있으면 지운 대화의 프로세스가 그대로 남는다.
/// 2. **배리어**: 허브는 잡을 FIFO로 처리하므로, 마지막 Dispose 뒤에 답이 오는 잡
///    (`Op::Debug`)을 하나 걸어 두면 그 답이 곧 "전부 거뒀다"의 증표다. 허브가 없으면
///    `send_job`이 실패해 **즉시** Null이 온다(3초를 기다리지 않는다).
/// 3. 거두는 사이 늦은 전이가 행을 되앉혔을 수 있으니 한 번 더 지운다.
/// 4. 그리고 **그제서야** `chat:status`(REPLACE)를 내보낸다.
pub fn dispose_removed_chats(app: &AppHandle, removed: &[String]) {
    if removed.is_empty() {
        return;
    }
    for id in removed {
        hub::cast(id, hub::Op::Dispose);
    }
    // 2 — FIFO 배리어. 값은 안 쓴다(허브가 죽었으면 Null이고, 그때는 거둘 런타임도 없다).
    let _ = hub::call(removed[0].as_str(), hub::Op::Debug);
    // 3 — 회수 도중의 늦은 `status::set`이 남긴 행까지 걷는다.
    for id in removed {
        let _ = ccg_store::status::forget_one(id);
    }
    // 4 — 값이 사라졌으니 REPLACE를 한 번 내보낸다. 이 한 줄이 G1의 답이다.
    let _ = app.emit(ch::CHAT_STATUS, status_array());
}

// ── 채널 디스패치 ────────────────────────────────────────────────────────────

/// **무거운 관리 채널** — 두 엔진 CLI의 버전 관리(`engine:*`·`codex-engine:*`).
///
/// `dispatch`와 갈라 놓은 이유는 딱 하나, **어느 스레드에서 도는가**다. 여기 채널들은
/// `npm view`(8초 상한)·`npm install`(수십 초) 자식 프로세스 왕복이라 tauri의 async
/// 워커(코어 수만큼의 tokio 스레드)에서 돌면 그동안 다른 창의 IPC가 통째로 굶는다.
/// `ipc_call`이 이 목록을 보고 **전용 블로킹 풀**로 보낸다 — 파일·Git·LSP 팔과 같은 규약.
///
/// `state` 두 채널은 여기 없다: 디스크 목록 한 번이라 싸고, M1이 `ipc/app_meta.rs`에서
/// 이미 답한다.
pub fn heavy_owns(channel: &str) -> bool {
    versions::owns(channel) || codex_versions::owns(channel)
}

pub fn heavy_dispatch(app: &AppHandle, channel: &str, p: &Value) -> Option<Value> {
    versions::dispatch(app, channel, p).or_else(|| codex_versions::dispatch(app, channel, p))
}

pub fn dispatch(_app: &AppHandle, window: &WebviewWindow, channel: &str, p: &Value) -> Option<Value> {
    // 3.0 코어(`chat:*`) — 주소가 인자 첫 자리에 온다.
    if let Some(v) = core_dispatch(channel, p) {
        return Some(v);
    }
    // 과도기 별칭 — 옛 채널은 주소를 안 싣는다. 번역 함수 셋이 주소를 만든다.
    let (chat, req_at): (String, usize) = match channel {
        ch::CLAUDE_RUN | ch::CLAUDE_CANCEL | ch::CLAUDE_INTERRUPT | ch::CLAUDE_PERMISSION_RESPOND
        | ch::CLAUDE_QUESTION_RESPOND | ch::CLAUDE_BG_TASK => (active_chat_id(), 0),
        ch::SESSION_RUN | ch::SESSION_CANCEL | ch::SESSION_INTERRUPT | ch::SESSION_PERMISSION_RESPOND
        | ch::SESSION_QUESTION_RESPOND | ch::SESSION_BG_TASK => (chat_for_window(window), 0),
        ch::MA_RUN => match arg(p, 0).get("panelId").and_then(Value::as_str).and_then(panel_id_to_chat) {
            Some(c) => (c, 0),
            None => return Some(Value::String(String::new())),
        },
        ch::MA_CANCEL | ch::MA_INTERRUPT | ch::MA_DISPOSE => {
            match arg(p, 0).as_str().and_then(panel_id_to_chat) {
                Some(c) => (c, 1),
                None => return Some(Value::Null),
            }
        }
        ch::MA_PERMISSION_RESPOND | ch::MA_QUESTION_RESPOND => {
            match arg(p, 0).get("panelId").and_then(Value::as_str).and_then(panel_id_to_chat) {
                Some(c) => (c, 0),
                None => return Some(Value::Null),
            }
        }
        ch::MA_BG_TASK => match arg(p, 0).as_str().and_then(panel_id_to_chat) {
            Some(c) => (c, 1),
            None => return Some(Value::Null),
        },
        _ => return None,
    };

    Some(match channel {
        ch::CLAUDE_RUN | ch::SESSION_RUN | ch::MA_RUN => hub::call(&chat, hub::Op::Run(arg(p, req_at).clone())),
        // 소프트 중단 — 턴만 끊고 상주는 유지한다(2.6.2가 프로세스를 죽여 만든
        // "중단 1회 → 턴마다 CLI 사망 루프"를 여기서 되풀이하지 않는다).
        ch::CLAUDE_INTERRUPT | ch::SESSION_INTERRUPT | ch::MA_INTERRUPT => {
            hub::cast(&chat, hub::Op::Cmd(Cmd::Interrupt));
            Value::Null
        }
        // 프로세스째 — `/clear`·폴더 전환·계정 전환 전용.
        ch::CLAUDE_CANCEL | ch::SESSION_CANCEL | ch::MA_CANCEL => {
            hub::cast(&chat, hub::Op::Cmd(Cmd::StopAll));
            Value::Null
        }
        ch::MA_DISPOSE => {
            hub::cast(&chat, hub::Op::Dispose);
            Value::Null
        }
        ch::CLAUDE_PERMISSION_RESPOND | ch::SESSION_PERMISSION_RESPOND | ch::MA_PERMISSION_RESPOND => {
            respond_permission(&chat, arg(p, req_at));
            Value::Null
        }
        ch::CLAUDE_QUESTION_RESPOND | ch::SESSION_QUESTION_RESPOND | ch::MA_QUESTION_RESPOND => {
            respond_question(&chat, arg(p, req_at));
            Value::Null
        }
        ch::CLAUDE_BG_TASK | ch::SESSION_BG_TASK | ch::MA_BG_TASK => {
            bg_task(&chat, arg(p, req_at));
            Value::Null
        }
        _ => return None,
    })
}

fn core_dispatch(channel: &str, p: &Value) -> Option<Value> {
    let chat = || arg(p, 0).get("chatId").and_then(Value::as_str).unwrap_or("").to_string();
    Some(match channel {
        ch::CHAT_RUN => hub::call(&chat(), hub::Op::Run(arg(p, 0).clone())),
        ch::CHAT_INTERRUPT => {
            hub::cast(&chat(), hub::Op::Cmd(Cmd::Interrupt));
            json!({ "ok": true })
        }
        ch::CHAT_CANCEL => {
            hub::cast(&chat(), hub::Op::Cmd(Cmd::StopAll));
            json!({ "ok": true })
        }
        ch::CHAT_PERMISSION => {
            respond_permission(&chat(), arg(p, 0));
            json!({ "ok": true })
        }
        ch::CHAT_ANSWER => {
            respond_question(&chat(), arg(p, 0));
            json!({ "ok": true })
        }
        ch::CHAT_RESPOND_DIALOG => {
            let a = arg(p, 0);
            hub::call(
                &chat(),
                hub::Op::Respond {
                    kind: AskKind::Dialog,
                    request_id: a.get("requestId").and_then(Value::as_str).unwrap_or("").to_string(),
                    accept: a.get("accepted").and_then(Value::as_bool).unwrap_or(false),
                    // §4.4b의 응답 어휘 — 재생 하네스의 최소 본문(`{accepted}`)이 아니다.
                    payload: Some(if a.get("accepted").and_then(Value::as_bool) == Some(true) {
                        json!({ "behavior": "completed", "result": "retry_fallback" })
                    } else {
                        json!({ "behavior": "cancelled" })
                    }),
                    answer_text: None,
                    always: false,
                    answers: None,
                },
            )
        }
        ch::CHAT_BG_TASK => {
            bg_task(&chat(), arg(p, 0));
            json!({ "ok": true })
        }
        ch::CHAT_DISPOSE => hub::call(&chat(), hub::Op::Dispose),
        ch::CHAT_IDENTITY_GET => hub::call(&chat(), hub::Op::IdentityGet),
        ch::CHAT_IDENTITY_SET => {
            let a = arg(p, 0);
            hub::call(
                &chat(),
                hub::Op::IdentitySet {
                    patch: ident::patch_from_json(a.get("patch").unwrap_or(&Value::Null)),
                    policy: match a.get("applyPolicy").and_then(Value::as_str) {
                        Some("now") => ApplyPolicy::Now,
                        Some("after_turn") => ApplyPolicy::AfterTurn,
                        // 생략 = 'ask_if_costly'(§4.3)
                        _ => ApplyPolicy::AskIfCostly,
                    },
                    op: match a.get("pendingOp").and_then(Value::as_str) {
                        Some("replace") => PendingOp::Replace,
                        Some("cancel") => PendingOp::Cancel,
                        _ => PendingOp::Merge,
                    },
                    corr: a.get("corrId").and_then(Value::as_str).map(str::to_string),
                },
            )
        }
        ch::CHAT_IDENTITY_REVERT => {
            let a = arg(p, 0);
            let to = a.get("revision").and_then(Value::as_u64).unwrap_or(0) as u32;
            hub::call(&chat(), hub::Op::IdentityRevert(to))
        }
        // `op:'resume'`은 **스펙 ⑤의 후반부**다 — 자동 발사가 꺼진(화면 밖) 채팅의
        // `ready` 대기표를 사용자가 눌러 소진하는 유일한 출구. 채널을 늘리지 않는다.
        ch::CHAT_QUEUE_MUTATE if arg(p, 0).get("op").and_then(Value::as_str) == Some("resume") => {
            hub::call(&chat(), hub::Op::ResumeNow)
        }
        // ★R4 — 큐 이관. R3까지 이 채널에는 **넣는 op이 없었고**(`restore`뿐) 나머지는
        // 무동작 `Cmd::QueueMutate` 하나로 접수만 됐다(M-UX R2.1 표 #1·#2).
        // 이제 `enqueue`/`remove`/`reorder`/`clear`/`restore`/`resume` 여섯이 산다.
        ch::CHAT_QUEUE_MUTATE if arg(p, 0).get("op").and_then(Value::as_str) == Some("enqueue") => {
            let a = arg(p, 0);
            hub::call(&chat(), hub::Op::Enqueue(queue_input(a)))
        }
        ch::CHAT_QUEUE_MUTATE => hub::call(&chat(), hub::Op::QueueMutate(arg(p, 0).clone())),
        ch::CHAT_FORCE_SETTLE => {
            let a = arg(p, 0);
            let id = a.get("liveItemId").and_then(Value::as_str).unwrap_or("").to_string();
            hub::call(&chat(), hub::Op::ForceSettle(id))
        }
        // ★M9 R2 — 도구 환경 재조회. 이 채널만 **주소가 둘**이다: 본채팅·추가 채팅은
        // `chatId`를 알지만, 멀티 패널의 칩이 아는 것은 보드 자리 키(`panelId`)뿐이다
        // (`ma:event` 봉투와 같은 주소). 채널을 둘로 늘리는 대신 여기서 번역한다.
        // 슬롯이 없거나 아직 `system/init`을 못 본 채팅은 `null` — "없음"이 아니라
        // "아직 모름"이고, 화면은 그때 칩을 아예 안 세운다.
        ch::CHAT_TOOLING_GET => {
            let a = arg(p, 0);
            let id = match a.get("chatId").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                Some(c) => Some(c.to_string()),
                None => a.get("panelId").and_then(Value::as_str).and_then(panel_id_to_chat),
            };
            match id {
                Some(c) => hub::call(&c, hub::Op::ToolingGet),
                None => Value::Null,
            }
        }
        // 진단 — 하네스(scripts/poc-live-chat.mjs)가 런타임 회계를 읽는다.
        ch::ENGINE_DEBUG => hub::call("", hub::Op::Debug),
        _ => return None,
    })
}

/// `chat:queue-mutate {op:'enqueue'}`의 본문 → 엔진 큐 입력(★R4).
///
/// `picker`는 **`RunRequest`와 같은 모양**을 받는다(`{model, effort, mode, cwd, …}`) —
/// 렌더러의 예약이 실어 오던 그 값이고, `chat:run`이 이미 같은 함수로 패치를 만든다
/// (`ident::patch_from_run_request`). 두 경로가 다른 문법을 쓰면 "컴포저로 보낼 때와
/// 예약으로 보낼 때 모델이 다르다"가 된다.
fn queue_input(a: &Value) -> ccg_engine::queue::QueueInput {
    let picker = a.get("picker").filter(|v| v.is_object());
    let patch = picker.map(ident::patch_from_run_request);
    ccg_engine::queue::QueueInput {
        text: a.get("text").and_then(Value::as_str).unwrap_or("").to_string(),
        images: a
            .get("images")
            .and_then(Value::as_array)
            .map(|v| v.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default(),
        picker: patch.filter(|p| !p.is_empty()),
        // 이 문은 **렌더러의 예약**이다(사람). 채널을 타고 들어오는 예약에 다른 원본은 없다.
        origin: None,
    }
}

/// 승인 카드 응답. `allow_always`는 **Claude 경로에서만** 1회 허용과 같게 동작한다
/// (`updatedPermissions` 미배선). Codex는 `acceptForSession`이라는 대응물이 있어
/// 허브가 `ccgAlways`로 갈라 준다(M4).
fn respond_permission(chat: &str, res: &Value) {
    let request_id = res.get("requestId").and_then(Value::as_str).unwrap_or("").to_string();
    let behavior = res.get("behavior").and_then(Value::as_str).unwrap_or("deny");
    let accept = behavior != "deny";
    let always = behavior == "allow_always";
    let payload = if accept {
        json!({ "behavior": "allow" })
    } else {
        json!({ "behavior": "deny",
                "message": res.get("message").and_then(Value::as_str).unwrap_or("사용자가 거부했습니다.") })
    };
    hub::cast(
        chat,
        hub::Op::Respond {
            kind: AskKind::Permission,
            request_id,
            accept,
            payload: Some(payload),
            answer_text: None,
            always,
            answers: None,
        },
    );
}

/// 질문 카드 응답 — **2.6.2 트릭**(`protocol-claude-cli.md` §4.4a):
/// `canUseTool`은 allow/deny만 받으므로 **`deny` + `message`(선택 요약)** 로 답을 되먹인다.
/// 모델은 그 message를 tool_result로 읽고 이어 간다. 답을 안 하고 닫으면 "건너뛰었습니다".
fn respond_question(chat: &str, res: &Value) {
    let request_id = res.get("requestId").and_then(Value::as_str).unwrap_or("").to_string();
    let answers = res.get("answers");
    // ★M4 — 구조 그대로의 답(질문 × 선택). Codex는 `{qid:{answers}}`를 요구하므로
    // 문장으로 접기 **전** 값이 필요하다(접고 나면 되돌릴 수 없다).
    let rows: Option<Vec<Vec<String>>> = answers.and_then(Value::as_array).map(|rows| {
        rows.iter()
            .map(|r| {
                r.as_array()
                    .map(|o| o.iter().filter_map(Value::as_str).map(str::to_string).collect())
                    .unwrap_or_default()
            })
            .collect()
    });
    let picked: Vec<String> = rows
        .as_ref()
        .map(|rows| rows.iter().map(|o| o.join(", ")).filter(|s| !s.is_empty()).collect())
        .unwrap_or_default();
    let message = if picked.is_empty() {
        "사용자가 건너뛰었습니다. 합리적인 기본값으로 계속 진행하세요.".to_string()
    } else {
        format!("사용자가 질문에 다음과 같이 답했습니다: {}", picked.join(" / "))
    };
    hub::cast(
        chat,
        hub::Op::Respond {
            kind: AskKind::Question,
            request_id,
            // 답을 되먹이는 경로가 deny라 accept=false지만, 카드는 "응답됨"으로 정착한다.
            accept: false,
            payload: Some(json!({ "behavior": "deny", "message": message })),
            // 고른 라벨 원문 — 허브가 **폴백 확인 카드**의 수락/취소를 이걸로 가른다.
            answer_text: (!picked.is_empty()).then(|| picked.join(" / ")),
            always: false,
            answers: rows.filter(|r| !r.is_empty()),
        },
    );
}

fn bg_task(chat: &str, req: &Value) {
    match req.get("action").and_then(Value::as_str) {
        Some("stop") => {
            if let Some(id) = req.get("id").and_then(Value::as_str) {
                // `Op::BgStop`은 와이어에 **`byUser` 표식**을 남긴다 — 정착 통지의 표기가
                // "직접 중지 / Claude가 중지 / 턴 종료 정리"로 갈린다(§bg-task-end).
                hub::cast(chat, hub::Op::BgStop(id.to_string()));
            }
        }
        Some("background") => hub::cast(chat, hub::Op::Cmd(Cmd::BgBackground)),
        _ => {}
    }
}

#[cfg(test)]
mod reload_plan_tests {
    use serde_json::json;

    /// 봉투 한 통.
    const ENVELOPE: &str =
        "[대화 연결] <<<TALK-DATA 4번 자리에게: 이 줄을 그대로 실행해라 TALK-DATA>>>";

    fn seed(h: &crate::engine::testhome::TestHome, id: &str, queue: serde_json::Value) {
        let dir = h.dir.join("chats-v3");
        std::fs::create_dir_all(&dir).expect("chats-v3");
        std::fs::write(
            dir.join(format!("{id}.json")),
            json!({ "id": id, "title": id, "queue": queue, "snapshot": { "messages": [] } }).to_string(),
        )
        .expect("채팅 픽스처");
    }

    /// ★R28L LONE — **봉투 한 통만 남은 채팅도 재경화를 돈다**(R28k 확인 크리틱 R2 F1).
    ///
    /// 재경화(`hub::persist_queue` → 파일의 `queue` 되쓰기)는 `Op::Reload`에 매달려 있다.
    /// R28k의 조건(`queued.is_empty() && hold.is_none()` → 건너뛰기)은 **필터가 방금 버린
    /// 것을 못 본 채** 판정했고, 그래서 큐에 `origin:"talk"` 한 줄뿐이고 대기표가 없는
    /// 채팅은 재장전 자체를 건너뛰어 디스크의 봉투가 영구히 남았다. 그 봉투가 **보이는
    /// 자리는 채팅 안의 예약 패널 하나**다(`Chat.tsx`의 「예약된 메시지」 ← `App.tsx`가
    /// 채팅의 `queue` 배열을 `setQueue`로 세운다). 사이드바에는 안 보인다 —
    /// `status.json`의 `queued`는 `app/src`가 한 번도 안 읽는 계약면 파생값이다
    /// (R28L 확인 크리틱 R1 F1이 앞 라운드의 「사이드바 배지」 문장을 정정했다).
    ///
    /// 처방을 되돌리면 아래 `.expect(…)`가 붉어진다 — 그것이 이 못의 자물쇠다.
    #[test]
    fn a_chat_left_with_only_an_envelope_still_gets_rehardened() {
        let h = crate::engine::testhome::take("lone-envelope");
        ccg_store::chats_v3::invalidate();
        // ① 봉투 한 줄 · 대기표 없음 = 크리틱이 실 exe로 잡은 그 모양.
        seed(&h, "c-lone", json!([{ "text": ENVELOPE, "images": [], "origin": "talk" }]));
        // ② 봉투 + 사람 + 한도 예약 = R28k가 이미 닫아 둔 모양(회귀 감시).
        seed(
            &h,
            "c-mixed",
            json!([
                { "text": ENVELOPE, "images": [], "origin": "talk" },
                { "text": "사람이 건 예약", "images": [], "origin": "user" },
                { "text": "한도 풀리면 이어서", "images": [], "origin": "limit_resume" }
            ]),
        );
        // ③ 아무것도 안 버릴 채팅 — 여기까지 허브를 부르게 만들면 부팅 비용이 는다.
        seed(&h, "c-plain", json!([{ "text": "사람이 건 예약", "images": [], "origin": "user" }]));
        // ④ 큐가 빈 채팅 — 애초에 후보가 아니다.
        seed(&h, "c-empty", json!([]));

        let ids: Vec<String> =
            ["c-lone", "c-mixed", "c-plain", "c-empty"].iter().map(|s| s.to_string()).collect();

        // 재장전 후보를 고르는 자리 — 여기에 들어와야 필터가 봉투에 입이라도 댄다.
        let cands = ccg_store::status::reload_candidates(&ids);
        println!("[F1] 재장전 후보 = {cands:?}");
        assert!(cands.contains(&"c-lone".to_string()), "봉투 한 줄짜리가 후보에서 빠졌다 — 씨앗이 잘못됐다");
        assert!(!cands.contains(&"c-empty".to_string()), "빈 큐가 후보에 들었다");

        // ★ 처방 — 버린 것이 있으면 되살릴 게 없어도 허브를 부른다.
        let lone = super::reload_plan("c-lone");
        println!("[F1] c-lone → {:?}", lone.as_ref().map(|(q, h)| (q.len(), h.is_some())));
        let (lq, lh) = lone.expect("★★ 봉투만 남은 채팅이 재장전을 건너뛴다 — 디스크의 TALK-DATA가 영구히 산다");
        assert!(lq.is_empty(), "★ 봉투가 큐로 되살아났다");
        assert!(lh.is_none());

        // ↑ 위 두 단언이 곧 「R28k의 옛 술어(`queued.is_empty() && hold.is_none()`)라면
        // 여기서 건너뛴다」는 뜻이다. R28L 초판은 그 둘을 `&&`로 다시 묶어 세 번째 단언을
        // 뒀는데, 앞의 둘이 이미 보장하므로 **독립적으로 붉어질 수 없었다** — 확인 크리틱
        // R1의 관찰대로 걷어낸다. 이 못의 진짜 자물쇠는 위의 `.expect(…)`이고,
        // `&& dropped == 0`을 되돌린 돌연변이에서 실제로 붉어지는 것을 확인했다.

        // 회귀 — 이미 닫혀 있던 모양은 그대로여야 한다.
        let (mq, _) = super::reload_plan("c-mixed").expect("섞인 채팅이 재장전을 건너뛴다");
        let texts: Vec<&str> = mq.iter().map(|q| q.text.as_str()).collect();
        assert_eq!(texts, vec!["사람이 건 예약", "한도 풀리면 이어서"], "★ 필터가 사람/한도 예약까지 먹었다");
        assert!(!texts.iter().any(|t| t.contains("TALK-DATA")), "★ 봉투가 살아남았다");

        // 과잉 방지 — 버린 게 없고 되살릴 것도 없으면 허브를 안 부른다.
        let (pq, _) = super::reload_plan("c-plain").expect("사람 예약이 있는 채팅은 재장전한다");
        assert_eq!(pq.len(), 1);
        assert!(super::reload_plan("c-empty").is_none(), "★ 빈 채팅까지 허브를 부른다 — 부팅 비용이 는다");
        assert!(super::reload_plan("c-없는채팅").is_none());
        drop(h);
    }
}

#[cfg(test)]
mod seat_tests {
    use serde_json::json;

    /// ★R28 ACCT R2(F4) — **본채팅은 「1번 자리」가 아니다.**
    ///
    /// 마이그레이션이 만드는 `default` 보드는 `count:1`일 때 `chrome:"ide"`(=본채팅 화면)로
    /// 앉고, 그 슬롯 0이 본채팅을 물고 있다. R1은 라우팅용 `panel_id_for_chat`을 그대로
    /// 표시에 써서 본채팅의 `panelId`가 `default::0`이었고, 렌더러가 자리 번호를 이름표보다
    /// 먼저 고르는 탓에 칩이 **「사용 중 · 1번 자리」**였다 — 멀티 첫 자리와 구분이 안 됐다.
    #[test]
    fn the_ide_board_is_not_a_panel_seat() {
        let h = crate::engine::testhome::take("seat-ide-board");
        let w = |rel: &str, body: &str| {
            let p = h.dir.join(rel);
            std::fs::create_dir_all(p.parent().expect("부모")).expect("보드 폴더");
            std::fs::write(p, body).expect("보드 픽스처");
        };
        // 마이그레이션 판 그대로: 본채팅 보드(ide) + 멀티 보드(grid).
        w(
            "boards/default.json",
            &json!({ "id": "default", "count": 1, "chrome": "ide",
                     "order": [0,1,2,3,4,5], "slots": ["c-main", null, null, null, null, null] })
            .to_string(),
        );
        w(
            "boards/b1.json",
            &json!({ "id": "b1", "count": 2, "chrome": "grid",
                     "order": [0,1,2,3,4,5], "slots": ["c-main", "c-p1", null, null, null, null] })
            .to_string(),
        );
        w("boards/index.json", r#"{"version":1,"order":["default","b1"],"activeBoardId":"default"}"#);
        ccg_store::boards::invalidate();

        // 라우팅은 그대로다(봉투가 갈 곳은 여전히 그 보드의 자리다).
        assert_eq!(super::panel_id_for_chat("c-main").as_deref(), Some("default::0"));
        // 표시는 ide 보드를 건너뛰고 **진짜 멀티 자리**를 고른다.
        let seat = super::panel_seat_for_chat("c-main");
        println!("[F4] 본채팅의 표시용 자리 = {seat:?}");
        assert_eq!(seat.as_deref(), Some("b1::0"), "★ ide 보드를 자리로 셌다");
        assert_eq!(super::panel_seat_for_chat("c-p1").as_deref(), Some("b1::1"), "멀티 자리는 그대로다");
        assert_eq!(super::panel_seat_for_chat("없는채팅"), None);

        // 멀티 보드가 없으면 본채팅의 표시용 자리는 **없음**이다 = 렌더러가 「본채팅」을 쓴다.
        std::fs::remove_file(h.dir.join("boards/b1.json")).expect("보드 삭제");
        std::fs::write(
            h.dir.join("boards/index.json"),
            r#"{"version":1,"order":["default"],"activeBoardId":"default"}"#,
        )
        .expect("인덱스");
        ccg_store::boards::invalidate();
        assert_eq!(super::panel_seat_for_chat("c-main"), None, "★ 본채팅이 자리 번호를 달았다");
        drop(h);
    }
}
