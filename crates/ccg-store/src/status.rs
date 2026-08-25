//! `chats-v3/status.json` — 전 채팅의 경량 상태(`ChatStatusLite`). **Rust 전용 파일.**
//!
//! 규약(M-UX §4.3 = m-logic §5.8, 크리틱 N5의 답 — 다섯 줄 그대로):
//!  1. **주인은 Rust 하나.** 렌더러는 읽기만 한다. `chats:save` 페이로드에 `statuses`가
//!     **없다** → 같은 파일 두 주인이 구조적으로 불가능(R2가 index.json에 넣어 만들 뻔한
//!     lost update가 파일 분리로 사라진다).
//!  2. **쓰기 시점**: 전이마다 메모리 갱신 + 브로드캐스트(즉시), 디스크는 **500ms 디바운스
//!     + 종료 flush**. 크래시 창은 최대 500ms — 그게 이 파일이 "캐시"인 이유다.
//!  3. **이중 진실 우선순위**: `hold`·`queued`의 진실은 `<chatId>.json`. 여기 값은 파생
//!     요약이고, 어긋나면 **`<chatId>.json`이 이긴다**.
//!  4. **부팅 강제**: `busy=false`·`ask='none'`·`bgActive=false`(유령 알약 방지 —
//!     `sessionChats.ts:28` 파리티). `queued`·`hold`는 **강제하지 않는다**(재장전 대상).
//!     ★강제는 **읽는 쪽**이다(R28c AG2 R2). 마이그레이션이 파일에 내려보내는 값은
//!     사실 그대로다 — 턴 도중에 죽은 채팅의 `working`도 그렇다. 그 값을 파일에 `idle`로
//!     굳히면, 규약 3·5가 *파일을 진실로 쓰는* 자리에서 사실이 통째로 사라진다
//!     (§5.2 "상태 맵 동일" 위반).
//!
//!     ★**그 사실의 수명은 「마이그레이션 프로세스」까지다**(R28c AG2 R3 — 확인 크리틱
//!     R2 §6이 실 exe로 잰 값). `ccg-migrate`가 단독으로 도는 동안은 마무리 [`flush`]까지
//!     참이지만, 앱 안에서는 **옆 채팅의 턴 한 번**이 `dirty`를 세우고 디바운스 [`flush`]가
//!     *메모리 맵 전체*(=여기 강제가 걸린 안전값)를 쓴다 → 얼어붙은 `working`은 그 한 번에
//!     `idle`로 덮인다. 화면 피해는 0이다(모든 읽기가 다시 얼린다) — 갈리는 것은 사이드카
//!     `<chatId>.json`과의 일치뿐이고, 그 일치를 재는 자는 무손실 하네스 하나다.
//!     영구히 참으로 만들려면 행마다 「아직 살지 않은 값」을 따로 들어야 한다(미채택 —
//!     비용이 이득보다 크다). 못: `the_frozen_fact_outlives_the_migration_but_not_the_first_turn`.
//!  5. **유일 진실이 아니다.** 없거나 깨졌으면 `chats-v3/*.json` 전수 **얕은 스캔**으로
//!     재구성한다(`snapshot`은 파싱하지 않는다 — serde의 IgnoredAny가 통째로 건너뛴다).
//!  6. **장전은 부팅에 한 번**(★R28c AG2 — 확인 크리틱 R3 G2). 규약 4의 강제도, 디스크
//!     값으로 메모리를 덮는 것도 **첫 장전에서만** 한다. 그 뒤의 `load_boot`(=`chats:get`)은
//!     **조회**다: 살아 있는 메모리가 이기고, 메모리가 모르는 채팅만 디스크에서 짓는다.
//!     읽기 채널 한 번이 살아 있는 런타임의 계정·승인 대기를 지우면 안 된다.
//!
//! `unread`는 **3.0.0에서 항상 0**이다(필드만 예약 — M-UX 열린 문제 ⑪). 마커 채팅에서
//! 재계산이 불가능해 이 파일이 유일 진실이어야 하는데, 그러려면 "읽음" 리셋 채널이
//! 하나 더 필요하다(32 → 33). 표시 여부가 미결이라 값을 굳혀 출하한다.

use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::Duration;

const FILE: &str = "status.json";
/// 디스크 쓰기 디바운스 — 규약 2.
const DEBOUNCE: Duration = Duration::from_millis(500);

/// ★R28 ACCT R2(F1) — **디스크에 실리면 안 되는 런타임 전용 키.**
///
/// `account`·`panelId`(§3의 「사용 중 · N번 자리」 칩)의 계약은 *"키가 있으면 살아 있는
/// 런타임"*이다. 그런데 R1은 그 계약을 **주석에만** 뒀다: `set()`이 `lite::build`의 결과를
/// 통째로 메모리 맵에 넣고 `flush()`가 그 맵을 그대로 썼기 때문에, 턴을 한 번이라도 돌린
/// 채팅은 `status.json`에 계정이 남았고 **재기동한 판(런타임 0개)에서도 칩이 켜졌다**
/// (확인 크리틱 R1 F1 — "늘 켜져 있는 경고는 없는 것보다 나쁘다").
///
/// 그래서 두 자리에서 **키째 지운다**: 쓸 때([`flush`])와 읽을 때([`load_boot`]).
/// 쓰기만 막으면 R1이 이미 써 둔 파일이 남아 그 홈은 영원히 유령 칩을 문다 — 읽기 쪽
/// 청소가 그 판의 답이고, 쓰기 쪽 청소가 재발 금지다.
const RUNTIME_ONLY_KEYS: [&str; 2] = ["account", "panelId"];

/// 런타임 전용 키를 걷어낸 사본(디스크 직렬화·부팅 장전 공용).
fn strip_runtime_only(v: &mut Value) {
    if let Some(o) = v.as_object_mut() {
        for k in RUNTIME_ONLY_KEYS {
            o.remove(k);
        }
    }
}

fn path() -> std::path::PathBuf {
    crate::app_home().join(super::chats_v3::DIR).join(FILE)
}

/// 채팅 파일의 **얕은 뷰** — `snapshot`·`messages`는 파싱하지 않는다.
/// serde는 모르는 필드를 `IgnoredAny`로 건너뛰므로 Value 트리를 만들지 않는다
/// (= 채팅 200개 얕은 스캔이 부팅 1회 수십 ms라는 규약 5의 근거).
#[derive(Deserialize, Default)]
#[serde(default)]
pub struct ChatLite {
    pub id: String,
    pub queue: Option<Vec<serde::de::IgnoredAny>>,
    pub hold: Option<HoldLite>,
    /// ★R2(D12) — 마이그레이션이 얼려 둔 상태. `status.json`이 없거나 깨졌을 때
    /// 재구성할 **유일한 진실**이다(2.6.2는 `session-chats/<id>.json`에 들고 있었다).
    pub status: Option<String>,
}

#[derive(Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct HoldLite {
    #[serde(rename = "resetsAt")]
    pub resets_at: Option<f64>,
    pub ready: bool,
    /// ★R28f WFIRE — **연속 헛발질 계수**(엔진 `LimitHold::attempts` · 렌더러
    /// `LimitHold.attempts`). 옛 파일에는 없다 → `serde(default)`로 0이고, 0은 R28e의
    /// 동작 그대로다(재장전이 무조건 0을 놓던 판).
    pub attempts: u32,
    /// ★R28f WFIRE — **이 에피소드가 태운 자동 재개의 총계**(엔진
    /// `ChatRuntime::episode_fires` · 렌더러 `LimitHold.fires`).
    ///
    /// 이 두 칸이 디스크에 없던 동안 「아무 구분자도 못 지우는 예산」이 **프로세스
    /// 경계 하나에 통째로 지워졌다**(R28e 확인 크리틱 R1 §4.1: 재장전 뒤 20시간 12발
    /// 재충전). 쓰는 쪽은 `hub::persist_hold`, 읽어 나르는 쪽은 `engine::reload_pending`
    /// → `ccg_engine::runtime::ReloadHold`다.
    pub fires: u32,
}

struct State {
    map: BTreeMap<String, Value>,
    dirty: bool,
    /// 이 홈에서 **부팅 장전을 이미 했는가**(규약 6). 두 번째부터의 [`load_boot`]은
    /// 장전이 아니라 **조회**다 — 아래 [`claim_boot`]·[`read_live`] 참고.
    loaded: bool,
}

fn state() -> &'static (Mutex<State>, Condvar) {
    static S: OnceLock<(Mutex<State>, Condvar)> = OnceLock::new();
    S.get_or_init(|| {
        (Mutex::new(State { map: BTreeMap::new(), dirty: false, loaded: false }), Condvar::new())
    })
}

/// ★R28c AG2(G2) — **이번 호출이 부팅 장전인가**(그리고 그 자리에서 표식을 세운다).
///
/// R2는 이 표식을 `static LOADED: OnceLock<()>`으로 세워 두고 **아무도 안 읽었다**
/// (확인 크리틱 R3 G2: `grep LOADED` = 정의 1줄 + 대입 1줄이 전부). 그래서 조회
/// (`chats:get` → `chats_v3::read_chats` → `load_boot`)마다 부팅 장전이 다시 돌아
/// 디스크 스냅샷이 **살아 있는 메모리 맵을 통째로 덮었다** — 그 길의 `strip_runtime_only`가
/// 살아 있는 런타임의 `account`·`panelId`를 걷어내 「사용 중」 칩이 조용히 꺼졌고
/// (그 채팅의 CLI는 PID를 달고 살아 있었다), 같은 덮어쓰기가 `ask`도 `"none"`으로
/// 되돌려 **타임아웃이 없는 승인 대기(AwaitingUser)**가 영영 안 돌아왔다.
/// 걷힌 행은 스스로 못 돌아온다 — 허브는 lite가 *바뀔 때만* `set`을 부르는데
/// 턴이 끝난 채팅의 lite는 다시 안 바뀐다(`hub.rs`의 `if same { return }`).
///
/// **표식을 `State`로 옮긴 이유**: 홈이 갈리면([`forget`]) 다음 장전은 *다시 부팅*이다.
/// `OnceLock`은 그 되돌림을 표현할 수 없다(프로세스에 한 번뿐이라 테스트도 한 홈만 산다).
///
/// 동시에 둘이 들어오면 **하나만** 참을 받는다 — 나머지는 조회로 간다. 두 번 장전해도
/// 결과는 같지만, 그 사이의 `set`을 덮을 수 있는 창을 굳이 열지 않는다.
fn claim_boot() -> bool {
    let (m, _) = state();
    let mut st = m.lock().unwrap_or_else(|e| e.into_inner());
    if st.loaded {
        return false;
    }
    st.loaded = true;
    true
}

/// 빈 `ChatStatusLite` — 채팅은 있는데 상태 기록이 없을 때의 값.
pub fn empty_lite(chat_id: &str) -> Value {
    json!({
        "chatId": chat_id,
        "status": "idle",
        "busy": false,
        "bgActive": false,
        "ask": "none",
        "hold": Value::Null,
        "queued": 0,
        "unread": 0,          // ★ 3.0.0에서는 항상 0 (필드 예약)
        // ★R4 — **재개의 주인이 누구인가**(m-logic P6 "행위자 하나").
        // `autoResume`은 이 채팅의 한도 해제를 Rust가 스스로 쏠지(스펙 ⑤ 보이는 자리),
        // `resumeOwner`는 *누가 관장하는가*다. 값이 `"engine"`인 동안 렌더러의
        // `useLimitResume`은 **자기 발화를 꺼야 한다** — 안 그러면 한 번의 해제에 두 턴이
        // 나간다(M-UX R2.9의 재현 축). 셸은 그 축을 Rust 쪽에서도 막지만(§7.3 나팔 억제),
        // 렌더러가 아예 안 쏘는 것이 규약이다.
        "autoResume": true,
        "resumeOwner": "engine",
        "updatedAt": 0,
    })
}

/// 부팅 **장전**(첫 호출) / **조회**(그 뒤) — 두 얼굴이 한 문 뒤에 있다.
///
/// 장전: 파일을 읽고 규약 4의 강제를 적용한 뒤, `<chatId>.json`의 진실로 `hold`·`queued`를
/// 되맞춘다(규약 3). 파일이 없거나 깨졌으면 얕은 스캔으로 재구성한다(규약 5).
///
/// ★R28c AG2(G2) — **조회(두 번째부터)는 메모리를 안 덮는다.** 이름은 `load_boot`으로
/// 두지만(호출자 셋의 계약면), 두 번째부터 하는 일은 [`read_live`]다: 살아 있는 맵이
/// 이기고, 메모리가 모르는 채팅만 디스크에서 짓는다. 왜 그래야 하는지는 [`claim_boot`].
pub fn load_boot(chat_ids: &[String]) -> BTreeMap<String, Value> {
    if !claim_boot() {
        return read_live(chat_ids);
    }
    boot_load(chat_ids)
}

/// 첫 장전 — 디스크가 메모리를 **채운다**(덮지는 않는다).
///
/// ★R28c AG2 R2(확인 크리틱 R1 지적 3) — R1은 여기서 `st.map = out.clone()`으로 **통째로
/// 덮었다**. [`claim_boot`]은 자물쇠를 놓고 나오므로 「표식을 세운 뒤 ~ 디스크를 다 읽기
/// 전」 사이에 허브가 앉힌 `set()`이 있으면 그 행이 사라진다 — 조회 쪽([`read_live`])에서는
/// 이미 막아 둔 창을 자기 가지에는 안 닫아 뒀다. 오늘의 부팅 순서에서는 도달 불가지만
/// (`load_boot`은 `hub::start` 앞), `CCG_NO_STATUS_BOOT=1`에서는 첫 `chats:get`이 이 가지를
/// 타므로 이론상 열린다. 둘의 규칙을 같게 둔다: **메모리가 이긴다.**
fn boot_load(chat_ids: &[String]) -> BTreeMap<String, Value> {
    // 디스크 읽기는 자물쇠 **밖에서** 한다(부팅에도 허브 틱을 멈춰 세우지 않는다).
    let stored = read_stored();
    let fresh: Vec<(String, Value)> =
        chat_ids.iter().map(|id| (id.clone(), row_from_disk(id, &stored))).collect();
    let (m, _) = state();
    let mut st = m.lock().unwrap_or_else(|e| e.into_inner());
    let mut out: BTreeMap<String, Value> = BTreeMap::new();
    for (id, row) in fresh {
        let row = st.map.entry(id.clone()).or_insert(row).clone();
        out.insert(id, row);
    }
    out
}

/// `status.json`의 `statuses` 맵(없거나 깨졌으면 빈 맵 — 규약 5가 그 뒤를 받는다).
fn read_stored() -> Map<String, Value> {
    let Some(raw) =
        std::fs::read_to_string(path()).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok())
    else {
        return Map::new();
    };
    raw.get("statuses").and_then(Value::as_object).cloned().unwrap_or_default()
}

/// 디스크가 아는 채팅 하나의 lite — **런타임이 없는 값**이다(규약 3·4·5 + F1 청소).
///
/// 이 함수가 만드는 행에는 `account`·`panelId`가 절대 없다. 살아 있는 런타임의 사실은
/// 메모리에만 있고([`set`]), 디스크는 *"이 채팅이 마지막에 어떤 상태였나"*만 안다.
fn row_from_disk(id: &str, stored: &Map<String, Value>) -> Value {
    // 규약 5 — status.json이 없거나 그 채팅을 모르면 `<chatId>.json`의 얕은 스캔으로
    // **재구성**한다. R1은 `empty_lite`(=idle)로만 채워, 파일 하나가 사라지면 얼려 둔
    // `done`이 전부 풀렸다(크리틱 E2).
    let mut lite = stored.get(id).cloned().filter(Value::is_object).unwrap_or_else(|| {
        let mut e = empty_lite(id);
        if let (Some(o), Some(s)) = (e.as_object_mut(), read_chat_lite(id).and_then(|l| l.status)) {
            o.insert("status".into(), json!(s));
        }
        e
    });
    // ★R28 ACCT R2(F1) — **디스크에는 살아 있는 런타임이 없다.** R1이 써 둔 파일에
    // `account`·`panelId`가 남아 있어도 여기서 걷어낸다(유령 「사용 중」 칩 방지).
    strip_runtime_only(&mut lite);
    force_boot_shape(id, &mut lite);
    // 규약 3 — `<chatId>.json`이 이긴다
    if let Some(o) = lite.as_object_mut() {
        let (queued, hold) = truth_from_chat_file(id);
        o.insert("queued".into(), json!(queued));
        o.insert("hold".into(), hold);
    }
    lite
}

/// 규약 4 — **부팅 강제**(유령 알약 방지). `queued`·`hold`는 건드리지 않는다(재장전 대상).
fn force_boot_shape(id: &str, lite: &mut Value) {
    let Some(o) = lite.as_object_mut() else { return };
    o.insert("chatId".into(), json!(id));
    o.insert("busy".into(), json!(false));
    o.insert("ask".into(), json!("none"));
    o.insert("bgActive".into(), json!(false));
    if matches!(o.get("status").and_then(Value::as_str), Some("working") | Some("analyzing")) {
        // 실행 중 상태로 복원하지 않는다(`sessionChats.ts:28` 파리티)
        o.insert("status".into(), json!("idle"));
    }
    o.insert("unread".into(), json!(0)); // ★ 3.0.0 고정
}

/// ★R28c AG2(G2) — 부팅 뒤의 조회(`chats:get`) — **메모리가 이긴다.**
///
/// 이 프로세스가 아는 행은 그대로 돌려준다(`account`·`panelId`·`ask`·`busy` 전부 —
/// 그 값들의 주인은 허브이지 디스크가 아니다). 메모리가 **모르는** 채팅만 디스크에서
/// 짓는데, 그런 채팅은 정의상 이 프로세스에서 한 번도 안 돈 채팅이라 부팅 강제가 맞다.
///
/// 지은 행은 메모리에도 앉힌다 — `chat:status`는 REPLACE라서 [`snapshot`]에 없는 채팅은
/// 다음 브로드캐스트에서 **통째로 사라진다**(장전이 맵을 통째로 채우던 시절의 부수 효과를
/// 여기서 이어받는다). 다만 `dirty`는 안 세운다: **조회는 디스크를 안 건드린다.**
fn read_live(chat_ids: &[String]) -> BTreeMap<String, Value> {
    let (m, _) = state();
    let (mut out, missing): (BTreeMap<String, Value>, Vec<String>) = {
        let st = m.lock().unwrap_or_else(|e| e.into_inner());
        let mut out = BTreeMap::new();
        let mut missing = Vec::new();
        for id in chat_ids {
            match st.map.get(id) {
                Some(v) => {
                    out.insert(id.clone(), v.clone());
                }
                None => missing.push(id.clone()),
            }
        }
        (out, missing)
    };
    if missing.is_empty() {
        return out;
    }
    // 디스크 읽기는 자물쇠 **밖에서** 한다(허브 틱이 그 사이 멈추면 안 된다).
    let stored = read_stored();
    let fresh: Vec<(String, Value)> =
        missing.into_iter().map(|id| { let row = row_from_disk(&id, &stored); (id, row) }).collect();
    {
        let mut st = m.lock().unwrap_or_else(|e| e.into_inner());
        for (id, row) in fresh {
            // 그 사이 허브가 앉힌 행이 있으면 **그쪽이 이긴다**(덮지 않는다 — 이게 G2다).
            let row = st.map.entry(id.clone()).or_insert(row).clone();
            out.insert(id, row);
        }
    }
    out
}

/// `<chatId>.json`을 **얕게** 읽어 `queued`·`hold` 요약을 만든다(규약 3·5).
fn truth_from_chat_file(id: &str) -> (usize, Value) {
    let Some(lite) = read_chat_lite(id) else { return (0, Value::Null) };
    let queued = lite.queue.as_ref().map(|q| q.len()).unwrap_or(0);
    let hold = match lite.hold {
        // ★R28f WFIRE — 키 집합은 `engine::lite::build`의 그것과 **같아야** 한다(규약 3).
        // 갈리면 부팅 행과 첫 허브 갱신이 매번 달라 배너가 한 번 깜빡인다.
        //
        // `paused`가 **상수 `false`**인 것은 값을 몰라서가 아니라 그게 사실이기 때문이다:
        // `auto_paused`는 「지금 자동을 접었다」는 판정 결과이고, 재장전은 그 결과를
        // 물려받지 않는다(`ReloadHold` 주석 · `reload_state`가 늘 `false`를 놓는다).
        // 그러니 이 행이 그리게 될 상태도 「아직 안 접힌 표」다.
        Some(h) => json!({ "resetAt": h.resets_at, "ready": h.ready, "fires": h.fires, "paused": false }),
        None => Value::Null,
    };
    (queued, hold)
}

/// 채팅 파일 하나의 얕은 뷰.
pub fn read_chat_lite(id: &str) -> Option<ChatLite> {
    let raw = std::fs::read_to_string(super::chats_v3::chat_file(id)).ok()?;
    serde_json::from_str::<ChatLite>(&raw).ok()
}

/// 재장전이 실제로 되살릴 **예약 본문**(§5.8 2단계 "queue 로드").
///
/// `read_chat_lite`는 개수만 세면 되므로 큐를 `IgnoredAny`로 건너뛴다 — 본문이 필요한
/// 쪽은 여기다. 항목은 2.6.2 문자열 배열이거나 `{text}` 객체 배열이다(두 판 다 있다).
/// 재장전에 필요한 것은 본문뿐이고, 정체성 스냅샷은 **다시 잡는다**(m-logic §5.8 —
/// "복원이 아니라 재장전": 그 사이 폴더·계정이 바뀌었을 수 있다).
pub fn read_chat_queue(id: &str) -> Vec<QueuedText> {
    let Ok(raw) = std::fs::read_to_string(super::chats_v3::chat_file(id)) else { return vec![] };
    let Ok(v) = serde_json::from_str::<Value>(&raw) else { return vec![] };
    v.get("queue")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|q| match q {
                    Value::String(s) => Some(QueuedText { text: s.clone(), images: vec![], origin: None }),
                    _ => {
                        let text = q
                            .get("text")
                            .or_else(|| q.get("prompt"))
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        // ★R4 — 첨부도 되살린다. R3까지는 본문만 읽어, 재시작 한 번에
                        // 예약의 이미지가 사라졌다(M-UX R2.1 #3의 재시작 판).
                        let images: Vec<String> = q
                            .get("images")
                            .or_else(|| q.get("attachments"))
                            .and_then(Value::as_array)
                            .map(|v| v.iter().filter_map(Value::as_str).map(str::to_string).collect())
                            .unwrap_or_default();
                        let origin = q.get("origin").and_then(Value::as_str).map(str::to_string);
                        Some(QueuedText { text, images, origin })
                    }
                })
                .filter(|q| !q.text.trim().is_empty() || !q.images.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// 디스크에 남은 예약 한 줄. 정체성 스냅샷은 **다시 잡는다**(재장전 규약)이므로
/// 여기 없다 — 되살릴 값은 본문과 첨부뿐이다.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct QueuedText {
    pub text: String,
    pub images: Vec<String>,
    /// ★M10 R2 C4 — **이 예약을 넣은 자**(`chat:queue`의 `origin` 그대로: `user` ·
    /// `talk` · `limit_resume` …). R1은 이 값을 안 읽었고, 재장전이 전부 사람 것으로
    /// 되돌려 세션 간 메시지가 **사람의 이름표를 달고** 되살아났다(크리틱 A7).
    pub origin: Option<String>,
}

/// **재장전 후보**(M-UX §4.3 / m-logic §5.8 부팅 경로 1단계) —
/// `hold != null ∨ queued > 0`인 채팅. M-LOGIC이 이 목록으로 `ChatRuntime::ensure`를 돈다.
/// 이 경로가 없으면 재시작 후 자동 이어서가 **조용히** 안 산다.
pub fn reload_candidates(chat_ids: &[String]) -> Vec<String> {
    chat_ids
        .iter()
        .filter(|id| {
            let (q, h) = truth_from_chat_file(id);
            q > 0 || !h.is_null()
        })
        .cloned()
        .collect()
}

/// 지금 메모리에 있는 전 채팅 상태(= `chats:get`이 합쳐 주는 값 · `chat:status` REPLACE).
pub fn snapshot() -> Value {
    let (m, _) = state();
    let st = m.lock().unwrap_or_else(|e| e.into_inner());
    let mut out = Map::new();
    for (k, v) in &st.map {
        out.insert(k.clone(), v.clone());
    }
    Value::Object(out)
}

/// 상태 전이 1건 — 메모리 갱신 + 디바운스 예약(규약 2). 브로드캐스트는 호출자(ipc) 몫.
pub fn set(chat_id: &str, lite: Value) {
    if !super::fanout::safe_id_str(chat_id) {
        return;
    }
    let mut lite = lite;
    if let Some(o) = lite.as_object_mut() {
        o.insert("chatId".into(), json!(chat_id));
        o.insert("unread".into(), json!(0)); // ★ 3.0.0 고정
    }
    let (m, cv) = state();
    {
        let mut st = m.lock().unwrap_or_else(|e| e.into_inner());
        st.map.insert(chat_id.to_string(), lite);
        st.dirty = true;
        // ★R28c AG2(G2) — **살아 있는 값이 한 줄이라도 앉으면 이 홈은 장전된 것으로 친다.**
        // `CCG_NO_STATUS_BOOT=1`(R4 귀속 팔)에서는 부팅 장전이 아예 안 돈다 — 그 판에서
        // 첫 `chats:get`이 「첫 호출 = 장전」 자격을 가져가면, 허브가 이미 앉힌 살아 있는
        // 행들을 디스크 스냅샷이 덮는다(= 이 결함의 플래그 판).
        st.loaded = true;
    }
    cv.notify_all();
    ensure_writer();
}

/// ★R28 ACCT R2(F1-b) — **런타임이 거둬진 채팅**의 마지막 lite에서 계정·자리를 뗀다.
///
/// 마지막 상태(`done`·`error`…)는 남겨야 사이드바 점 색이 유지되고, 계정만 떨어져야
/// 「사용 중」 칩이 걷힌다. `Op::Dispose`(대화 삭제·창 파기)와 상주 CLI 회수가 이 문을
/// 지난다 — 슬롯만 지우면 마지막 lite가 그대로 남아 **같은 세션 안에서도 칩이 안 걷혔다**.
///
/// 돌려주는 값은 "실제로 뗐나"다 — 호출자가 그때만 브로드캐스트하면 된다.
pub fn clear_runtime(chat_id: &str) -> bool {
    let (m, cv) = state();
    let changed = {
        let mut st = m.lock().unwrap_or_else(|e| e.into_inner());
        let Some(v) = st.map.get_mut(chat_id) else { return false };
        let before = v.clone();
        strip_runtime_only(v);
        let changed = *v != before;
        if changed {
            st.dirty = true;
        }
        changed
    };
    if changed {
        cv.notify_all();
        ensure_writer();
    }
    changed
}

/// 목록에서 사라진 채팅의 상태를 걷어낸다(채팅 삭제 · prune과 짝).
///
/// ★R28b ACCT R3(G1) — **지운 것을 돌려준다.** 값을 실제로 지우는 자리는 여기고,
/// `chat:status`는 REPLACE라서 여기서 아무 말도 안 하면 렌더러는 **마지막 페이로드를
/// 그대로 들고 있는다**: 지운 채팅이 계정을 문 채로 남아 picker에 「사용 중 · 다른 자리」가
/// 켜진다(확인 크리틱 R2 G1 실측 — 12초 무입력 브로드캐스트 0건, 다음 턴이 나야 걷혔다).
/// R2는 그 브로드캐스트를 `Op::Dispose` → [`clear_runtime`]에 매달았는데, 두 삭제 경로
/// 모두 **행을 먼저 지운 뒤** 그 문을 두드려 `false`를 받았다 — 태어날 때부터 닫힌 문이었다.
/// 그러니 주인을 바꾼다: **값을 지운 자가 무엇을 지웠는지 말하고**, 호출자가 그때 알린다.
#[must_use = "지운 채팅은 chat:status로 알려야 한다(안 그러면 picker에 유령 「사용 중」이 남는다)"]
pub fn retain(chat_ids: &[String]) -> Vec<String> {
    let keep: std::collections::HashSet<&str> = chat_ids.iter().map(String::as_str).collect();
    let (m, cv) = state();
    let removed: Vec<String> = {
        let mut st = m.lock().unwrap_or_else(|e| e.into_inner());
        let removed: Vec<String> =
            st.map.keys().filter(|k| !keep.contains(k.as_str())).cloned().collect();
        if !removed.is_empty() {
            st.map.retain(|k, _| keep.contains(k.as_str()));
            st.dirty = true;
        }
        removed
    };
    cv.notify_all();
    ensure_writer();
    removed
}

/// 채팅 **하나**의 상태만 걷어낸다(레코드 1건 삭제와 짝 — 목록 REPLACE가 아니다).
/// 돌려주는 값은 [`retain`]과 같은 계약이다 — "실제로 지웠나".
#[must_use = "지운 채팅은 chat:status로 알려야 한다(안 그러면 picker에 유령 「사용 중」이 남는다)"]
pub fn forget_one(chat_id: &str) -> bool {
    let (m, cv) = state();
    let removed = {
        let mut st = m.lock().unwrap_or_else(|e| e.into_inner());
        let removed = st.map.remove(chat_id).is_some();
        if removed {
            st.dirty = true;
        }
        removed
    };
    cv.notify_all();
    ensure_writer();
    removed
}

/// 지금 즉시 디스크에 쓴다(앱 종료 flush · 마이그레이션 마무리).
///
/// ★R28c AG2 R3 — **목적지는 자물쇠 안에서 정한다.** 앱에서는 홈이 안 바뀌니 티가 안
/// 나지만, 테스트에서는 이 함수를 500ms 뒤에 부르는 것이 [`ensure_writer`]의 배경
/// 스레드다: 「dirty를 읽고 → 맵을 복사하고 → 파일을 쓰기」 사이에 그 홈이 걷히면
/// (`testkit::Home`의 Drop) 그 쓰기는 **되돌아온 홈 = 사용자 실홈**을 향한다.
/// [`forget`]이 같은 자물쇠를 잡으므로, 경로를 여기서 뜨면 그 창이 닫힌다.
pub fn flush() {
    let (m, _) = state();
    let mut st = m.lock().unwrap_or_else(|e| e.into_inner());
    if !st.dirty {
        return;
    }
    st.dirty = false;
    let (map, dst) = (st.map.clone(), path()); // ★ 경로도 자물쇠 안에서 뜬다
    drop(st);
    write_map_to(&map, dst);
}

// ★R28d(CASX) — `write_map(&map)`(목적지를 **자기가** 뜨는 편의 래퍼)은 없앴다.
// 이 파일에 남은 쓰기 경로는 [`flush`]·[`seed`]·디바운스 스레드 셋뿐이고 **전부 목적지를
// 자물쇠 안에서 뜬다**([`write_map_to`]에 넘긴다). 래퍼가 남아 있으면 다음 사람이
// 그걸 집어 그 규약 밖으로 나간다 — R28c AG2 R3이 `flush()`에서 닫은 창이 `seed()`에서
// 그대로 열려 있던 이유가 정확히 그것이다.

/// ★R28 ACCT R2(F1) — 런타임 전용 키는 **파일로 내려가지 않는다.** 메모리 맵에는 남는다
/// (브로드캐스트가 그 값을 싣는 것이 §3의 기능이다) — 갈리는 것은 *수명*이다: 프로세스와
/// 함께 죽어야 하는 사실이다.
fn write_map_to(map: &BTreeMap<String, Value>, p: std::path::PathBuf) {
    let mut statuses = Map::new();
    for (k, v) in map {
        let mut row = v.clone();
        strip_runtime_only(&mut row);
        statuses.insert(k.clone(), row);
    }
    let text = serde_json::to_string(&json!({ "version": 1, "statuses": Value::Object(statuses) }))
        .unwrap_or_default();
    if text.is_empty() {
        return;
    }
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = crate::write_atomic(&p, &text);
}

/// 500ms 디바운스 쓰기 스레드 — 첫 `set()`에서만 뜬다.
fn ensure_writer() {
    static WRITER: OnceLock<()> = OnceLock::new();
    if WRITER.set(()).is_err() {
        return;
    }
    std::thread::Builder::new()
        .name("ccg-status".into())
        .spawn(|| {
            let (m, cv) = state();
            loop {
                {
                    let st = m.lock().unwrap_or_else(|e| e.into_inner());
                    let _woken = cv.wait_while(st, |s| !s.dirty).unwrap_or_else(|e| e.into_inner());
                }
                // 연속 전이를 한 번의 쓰기로 접는다
                std::thread::sleep(DEBOUNCE);
                flush();
            }
        })
        .ok();
}

/// 메모리 상태를 비운다 — **홈이 갈릴 때**(테스트·격리 홈 전환) 전용.
///
/// ★R28c AG2(G2) — 장전 표식도 같이 내린다: 홈이 갈렸으면 **다음 장전은 다시 부팅**이다
/// (새 홈의 `status.json`에 옛 판이 써 둔 유령 계정이 있을 수 있다 — F1).
pub fn forget() {
    let (m, _) = state();
    let mut st = m.lock().unwrap_or_else(|e| e.into_inner());
    st.map.clear();
    st.dirty = false;
    st.loaded = false;
}

/// 마이그레이션이 만든 초기 상태 맵을 통째로 심는다(그리고 즉시 쓴다).
///
/// **두 얼굴이다 — 파일은 사실, 메모리는 안전값**(규약 4의 「강제는 읽는 쪽」).
///
/// ★R28c AG2(G2) — 메모리에는 여기서 규약 4를 건다. 순서가 함정이기 때문이다:
/// `engine::boot`의 `load_boot`은 마이그레이션 **전에** 돌고(그 판의 `chats-v3`는 아직
/// 비어 있어 `load_boot(&[])`이다), 그 뒤 첫 `chats:get`은 이제 [`read_live`]라 메모리를
/// 그대로 돌려준다. 그러니 여기서 안 걷으면 2.6.2가 크래시 때 얼려 둔 `working`이
/// 업그레이드 첫 화면에 **유령 알약**으로 뜬다.
///
/// ★R28c AG2 R2(확인 크리틱 R1의 새 회귀) — 그런데 R1은 그 강제를 `flush()`로 **디스크까지**
/// 굳혔다. `status.json`의 `working`이 `idle`로 지워져 `<chatId>.json`(=`"working"`)과
/// 영구히 어긋났고, 하필 그것이 무손실 하네스가 재는 값이다
/// (`poc-chat-unify-migrate.mjs`: BEFORE=`rec.snapshot.status` ↔ AFTER=`status.json`).
/// 그 대상 인구는 **턴 도중에 죽은 채팅** — 규약 4가 존재하는 이유인 바로 그 집단이다.
/// 그래서 파일에는 [`write_map_to`]로 **마이그레이터가 준 값 그대로** 내려보낸다(§5.2
/// "상태 맵 동일" · `migrate_v3::status_of`의 "파일은 사실, 메모리는 안전값"). 다음 장전이
/// 그 파일을 읽을 때 [`row_from_disk`]가 다시 얼리므로 화면은 어느 쪽이든 안전값이다.
///
/// `dirty`를 내리는 것이 이 함수의 계약의 일부다 — 안 내리면 500ms 뒤 디바운스 쓰기(또는
/// `ccg-migrate`의 마무리 [`flush`])가 **메모리의 안전값으로 방금 쓴 사실을 덮는다**.
///
/// ★R28d(CASX) — **목적지도 자물쇠 안에서 뜬다**([`flush`]와 같은 이유). R28c AG2 R3이
/// `flush()`에서 닫은 창의 쌍둥이가 여기 남아 있었다: 자물쇠를 놓고 `path()`를 뜨면,
/// 그 사이에 홈이 걷힌 판(`testkit::Home`의 Drop)에서 이 쓰기가 **되돌아온 홈 =
/// 사용자 실홈**을 향한다. 지금 이 함수를 부르는 자리(마이그레이션)는 부팅에 한 번뿐이라
/// 잠재였지만, 같은 파일 안에 "자물쇠를 잡는 쓰기"와 "안 잡는 쓰기"가 섞여 있는 것 자체가
/// 다음 사람이 밟을 지뢰다.
pub fn seed(map: BTreeMap<String, Value>) {
    let (m, _) = state();
    let dst = {
        let mut st = m.lock().unwrap_or_else(|e| e.into_inner());
        st.map = map
            .iter()
            .map(|(id, v)| {
                let mut v = v.clone();
                force_boot_shape(id, &mut v);
                (id.clone(), v)
            })
            .collect();
        st.dirty = false;
        // 심은 값이 이 홈의 진실이다 — 그 뒤의 `load_boot`은 장전이 아니라 조회다(규약 6).
        st.loaded = true;
        path() // ★ 경로도 자물쇠 안에서 뜬다
    };
    write_map_to(&map, dst);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ★R28d(CASX R2) — **쓰기 문은 목적지를 자물쇠 안에서 뜬다.** 코드만 고치고 못을
    /// 안 박아서 되돌아가도 게이트가 안 울던 자리다(확인 크리틱 R1 §6: *"`status::seed()` —
    /// 코드는 닫혔고 못이 없다"*).
    ///
    /// ## 왜 이 성질이 사고인가 (R28c AG2 R3의 실측 이력)
    ///
    /// 자물쇠를 놓고 [`path`]를 뜨면 그 사이에 홈이 걷힐 수 있다. 걷는 쪽
    /// (`testkit::Home`의 Drop)은 **[`forget`]으로 이 자물쇠를 먼저 잡고** 그다음
    /// `CCG_HOME`을 원래 값으로 되돌린다. 그러니 자물쇠 밖에서 뜬 목적지는 **되돌아온 홈 =
    /// 사용자 실홈**을 가리킬 수 있고, 그 순간의 쓰기가 실데이터를 향한다.
    /// 자물쇠 안에서 뜨면 `forget`이 아직 못 들어왔다는 뜻이라 그 창이 구조적으로 닫힌다.
    ///
    /// ## 왜 소스를 읽는 못인가
    ///
    /// 이 성질의 위반은 **나노초 창**이라 행동으로 재면 못이 1/1000로 붉는 못이 된다 —
    /// 그건 게이트가 아니다. 그래서 성질을 **구조로** 잰다(선례: `ccg-engine`의
    /// `zz_coverage_gate`). 규칙 둘뿐이고 둘 다 우회하려면 규약을 눈에 보이게 깨야 한다.
    #[test]
    fn every_write_path_takes_its_destination_inside_the_lock() {
        const SRC: &str = include_str!("status.rs");
        // 못 자신이 소스를 읽으므로, 재는 대상은 **프로덕션 구역**뿐이다(테스트 코드 제외).
        let prod = SRC.split("#[cfg(test)]").next().expect("프로덕션 구역");

        let mut depth = 0i32;
        let mut lock_at: Option<i32> = None; // 자물쇠를 잡은 시점의 블록 깊이
        let mut naked: Vec<(usize, String)> = vec![]; // 자물쇠 **밖**에서 뜬 `path()`
        for (i, raw) in prod.lines().enumerate() {
            // 주석은 코드가 아니다(이 파일에는 `//`를 담은 문자열 리터럴이 없다).
            let code = raw.split("//").next().unwrap_or("");
            if code.contains(".lock()") {
                lock_at = Some(depth);
            }
            // ① 목적지를 **호출 자리에서** 뜨면 그건 자물쇠 밖이다 — 모양만으로 잡힌다.
            assert!(
                !(code.contains("write_map_to(") && code.contains("path()")),
                "status.rs:{}: 목적지를 `write_map_to` 호출 자리에서 뜬다 = 자물쇠 밖이다 — {}",
                i + 1,
                raw.trim()
            );
            if code.contains("path()") && !code.contains("fn path()") && lock_at.is_none() {
                naked.push((i + 1, raw.trim().to_string()));
            }
            if code.contains("drop(st)") {
                lock_at = None;
            }
            depth += code.matches('{').count() as i32 - code.matches('}').count() as i32;
            // 증표는 자기 블록이 닫히면 떨어진다(`d`는 증표를 잡은 시점의 깊이 = 그 블록 안).
            if lock_at.is_some_and(|d| depth < d) {
                lock_at = None;
            }
        }

        // ② 자물쇠 밖의 `path()`는 **읽기만** 허용된다. 쓰기 문 셋(`flush`·`seed`·디바운스)의
        //    목적지가 여기 끼는 순간 붉어진다.
        println!("[CASX R2] 자물쇠 밖 `path()` = {naked:?}");
        let offenders: Vec<&(usize, String)> = naked.iter().filter(|(_, l)| !l.contains("read_to_string(path())")).collect();
        assert!(
            offenders.is_empty(),
            "★ 자물쇠 밖에서 목적지를 뜨는 자리가 생겼다 — 홈이 걷히는 창에서 이 쓰기는 사용자 실홈을 향한다: {offenders:?}"
        );
        // 읽기 쪽이 통째로 사라지면(= 이 못이 아무것도 안 재게 되면) 그것도 알아야 한다.
        assert_eq!(naked.len(), 1, "읽기 경로의 `path()` 수가 달라졌다 — 이 못의 전제를 다시 보라: {naked:?}");
    }

    #[test]
    fn shallow_view_skips_the_snapshot() {
        // 스냅샷이 아무리 커도 파싱 대상은 queue/hold뿐이다
        let raw = json!({
            "id": "c1",
            "snapshot": { "messages": (0..200).map(|i| json!({ "id": i, "text": "x".repeat(64) })).collect::<Vec<_>>() },
            "queue": [ { "id": "q1" }, { "id": "q2" } ],
            "hold": { "key": "c1", "resetsAt": 1234.0, "ready": false }
        })
        .to_string();
        let lite: ChatLite = serde_json::from_str(&raw).unwrap();
        assert_eq!(lite.id, "c1");
        assert_eq!(lite.queue.unwrap().len(), 2);
        assert_eq!(lite.hold.unwrap().resets_at, Some(1234.0));
    }

    #[test]
    fn missing_optional_fields_are_none() {
        let lite: ChatLite = serde_json::from_str(r#"{"id":"c2","snapshot":null}"#).unwrap();
        assert!(lite.queue.is_none() && lite.hold.is_none());
    }

    #[test]
    fn queue_bodies_are_read_from_both_shapes() {
        let h = crate::testkit::temp_home("status-queue");
        h.write(
            "chats-v3/c9.json",
            &json!({ "id": "c9", "queue": ["문자열 항목", { "text": "객체 항목" }, { "text": "  " }] }).to_string(),
        );
        let rows = read_chat_queue("c9");
        assert_eq!(
            rows.iter().map(|q| q.text.as_str()).collect::<Vec<_>>(),
            vec!["문자열 항목", "객체 항목"]
        );
        assert!(read_chat_queue("없는채팅").is_empty());
    }

    #[test]
    fn queue_attachments_survive_a_restart() {
        // ★R4 — 본문만 읽던 R3에서는 재시작 한 번에 예약의 이미지가 사라졌다.
        let h = crate::testkit::temp_home("status-queue-img");
        h.write(
            "chats-v3/c10.json",
            &json!({ "id": "c10", "queue": [
                { "text": "이 그림 봐줘", "images": ["C:\\shot\\a.png"] },
                { "text": "", "images": ["C:\\shot\\b.png"] }
            ] })
            .to_string(),
        );
        let rows = read_chat_queue("c10");
        assert_eq!(rows.len(), 2, "본문이 비어도 첨부만 있으면 예약이다");
        assert_eq!(rows[0].images, vec!["C:\\shot\\a.png".to_string()]);
        assert_eq!(rows[1].text, "");
        let _ = h;
    }

    /// ★R28 ACCT R2(F1) — **「사용 중」은 디스크로 내려가지 않는다.**
    ///
    /// 확인 크리틱 R1 F1의 실측: 턴 1회 → 종료 → 재기동에서 `status.json`에 남은
    /// `account`가 그대로 살아나 **런타임이 하나도 없는 판**에서 칩이 켜졌다.
    /// 여기서 잠그는 것은 두 방향이다 — 쓸 때 빠지고, 읽을 때(옛 파일) 걷힌다.
    #[test]
    fn the_in_use_account_never_reaches_the_disk_and_never_comes_back() {
        let h = crate::testkit::temp_home("status-runtime-keys");
        forget();
        // ① 살아 있는 런타임의 lite — 계정·자리가 실린다(브로드캐스트는 이 값을 쓴다).
        set(
            "c-a",
            json!({ "chatId": "c-a", "status": "done", "busy": false, "bgActive": false,
                    "account": "one@ccg.test", "panelId": "b1::1", "ask": "none",
                    "hold": Value::Null, "queued": 0, "updatedAt": 7 }),
        );
        assert_eq!(snapshot()["c-a"]["account"], json!("one@ccg.test"), "메모리에는 남아야 §3이 산다");
        flush();
        let txt = std::fs::read_to_string(path()).expect("status.json");
        println!("[F1] flush 결과 = {txt}");
        assert!(!txt.contains("account"), "★ 계정이 디스크에 남았다: {txt}");
        assert!(!txt.contains("panelId"), "★ 자리가 디스크에 남았다: {txt}");
        assert!(txt.contains("\"status\":\"done\""), "종결 상태까지 지우면 안 된다");

        // ② R1이 써 둔 파일(두 키가 들어 있다)을 부팅에서 장전 — 걷혀야 한다.
        h.write(
            "chats-v3/status.json",
            &json!({ "version": 1, "statuses": { "c-a": {
                "chatId": "c-a", "status": "done", "busy": false,
                "account": "one@ccg.test", "panelId": "default::0" } } })
            .to_string(),
        );
        forget();
        let boot = load_boot(&["c-a".to_string()]);
        let row = boot.get("c-a").expect("행");
        println!("[F1] load_boot = {row}");
        assert!(row.get("account").is_none(), "★ 재기동 판에 유령 계정이 살아났다: {row}");
        assert!(row.get("panelId").is_none(), "★ 재기동 판에 유령 자리가 살아났다: {row}");
        assert_eq!(row["status"], json!("done"), "얼려 둔 종결 상태는 그대로다");
        let _ = h;
    }

    /// ★R28 ACCT R2(F1-b) — 런타임 회수는 **마지막 lite를 계정 없이 다시 앉힌다**.
    /// 슬롯만 지우면 같은 세션 안에서도 칩이 안 걷힌다(크리틱 F1 부수 사실).
    #[test]
    fn clearing_a_runtime_drops_the_account_but_keeps_the_status() {
        let _h = crate::testkit::temp_home("status-clear-runtime");
        forget();
        set(
            "c-b",
            json!({ "chatId": "c-b", "status": "done", "busy": false, "account": "two@ccg.test",
                    "panelId": "b1::2", "unread": 0 }),
        );
        assert!(clear_runtime("c-b"), "뗄 것이 있었는데 false를 돌려줬다");
        let row = snapshot()["c-b"].clone();
        println!("[F1-b] clear_runtime = {row}");
        assert!(row.get("account").is_none() && row.get("panelId").is_none(), "{row}");
        assert_eq!(row["status"], json!("done"), "마지막 상태까지 지우면 사이드바 점이 꺼진다");
        assert!(!clear_runtime("c-b"), "두 번째는 바뀐 게 없다");
        assert!(!clear_runtime("없는채팅"), "모르는 채팅에 참을 돌려주면 헛 브로드캐스트가 난다");
    }

    /// ★R28b ACCT R3(G1) — **값을 지운 자가 무엇을 지웠는지 말한다.**
    ///
    /// R2는 「사용 중」을 걷는 문을 [`clear_runtime`]에 달았다. 그런데 두 삭제 경로 모두
    /// 행을 **먼저** 지우고 그 문을 두드린다 — `clear_runtime`은 맵에 없는 키를 만나
    /// `false`를 돌려주고, 거기 매단 브로드캐스트는 영원히 안 나갔다(확인 크리틱 R2 G1).
    /// 그래서 여기 둘이 답한다: 지운 이름 / 지웠나. 호출자는 그때만 알리면 된다.
    #[test]
    fn removing_a_row_reports_what_it_removed() {
        let _h = crate::testkit::temp_home("status-remove-reports");
        forget();
        for id in ["c-a", "c-b", "c-c"] {
            set(id, json!({ "chatId": id, "status": "done", "account": "one@ccg.test" }));
        }
        // 목록 REPLACE — 둘이 사라진다.
        let mut gone = retain(&["c-b".to_string()]);
        gone.sort();
        println!("[G1] retain이 지웠다고 말한 것 = {gone:?}");
        assert_eq!(gone, vec!["c-a".to_string(), "c-c".to_string()]);
        assert!(retain(&["c-b".to_string()]).is_empty(), "지운 게 없는데 지웠다고 말했다");
        // 레코드 1건 삭제.
        assert!(forget_one("c-b"), "★ 지웠는데 안 지웠다고 말하면 브로드캐스트가 안 나간다");
        assert!(!forget_one("c-b"), "두 번째는 지울 게 없다");
        assert!(!forget_one("없는채팅"), "모르는 채팅에 참을 돌려주면 헛 브로드캐스트가 난다");
        assert_eq!(snapshot(), json!({}), "전부 걷혔어야 한다");
    }

    /// ★R28c AG2(G2) — **조회 한 번이 살아 있는 「사용 중」을 지우면 안 된다.**
    ///
    /// 확인 크리틱 R3의 실 exe 재현: 같은 계정을 문 자리가 둘인 판에서 `chats:get`을
    /// **한 번** 부르면(= `App.tsx`가 마운트마다 하는 그 한 줄) 셸의 상태 맵이 디스크
    /// 스냅샷으로 갈리고, 다음 REPLACE에 `account:null`이 실려 칩이 조용히 사라졌다 —
    /// 그때 그 채팅의 CLI는 PID를 달고 살아 있었다. 겸해 `ask`도 되돌아갔다: 승인 대기는
    /// 계약상 타임아웃이 없어(AwaitingUser) lite가 다시 안 바뀌므로 **영영** 안 돌아온다.
    ///
    /// 못은 조회 축이다 — 재시작 축(F1)·삭제 축(G1)은 이 결함을 **100% 통과한다**.
    #[test]
    fn a_read_never_wipes_a_live_account_or_a_pending_ask() {
        let h = crate::testkit::temp_home("status-query-axis");
        forget();
        // ① 지난 세션이 남긴 파일 → 부팅 장전(여기까지는 R2 그대로다).
        h.write(
            "chats-v3/status.json",
            &json!({ "version": 1, "statuses": {
                "c-a": { "chatId": "c-a", "status": "done", "busy": false, "ask": "none", "updatedAt": 3 },
                "c-b": { "chatId": "c-b", "status": "done", "busy": false, "ask": "none", "updatedAt": 3 } } })
            .to_string(),
        );
        let ids = vec!["c-a".to_string(), "c-b".to_string()];
        let boot = load_boot(&ids);
        assert!(boot["c-a"].get("account").is_none(), "부팅에는 살아 있는 런타임이 없다");

        // ② 두 채팅이 턴을 돌아 같은 계정을 문다. `c-a`는 승인 대기에서 멈춰 있다.
        set(
            "c-a",
            json!({ "chatId": "c-a", "status": "working", "busy": true, "bgActive": false,
                    "ask": "permission", "account": "one@ccg.test", "panelId": Value::Null, "updatedAt": 9 }),
        );
        set(
            "c-b",
            json!({ "chatId": "c-b", "status": "done", "busy": false, "bgActive": false,
                    "ask": "none", "account": "one@ccg.test", "panelId": "b1::1", "updatedAt": 9 }),
        );

        // ③ 조회 한 번 — 읽기 채널이다. 아무것도 안 바꿔야 한다.
        let got = load_boot(&ids);
        println!("[G2] chats:get 응답 = {:?}", got);
        for id in ["c-a", "c-b"] {
            assert_eq!(
                got[id]["account"],
                json!("one@ccg.test"),
                "★ 조회가 살아 있는 계정을 지웠다({id}): {}",
                got[id]
            );
        }
        assert_eq!(got["c-b"]["panelId"], json!("b1::1"), "★ 조회가 자리 번호를 지웠다");
        assert_eq!(got["c-a"]["ask"], json!("permission"), "★ 조회가 승인 대기를 「물어볼 게 없다」로 되돌렸다");
        assert_eq!(got["c-a"]["status"], json!("working"), "★ 조회가 도는 턴을 idle로 내렸다");
        assert_eq!(got["c-a"]["busy"], json!(true), "★ 조회가 busy를 꺼 전송 게이트를 열었다");

        // ④ 그리고 **다음 REPLACE**(=snapshot)도 그대로여야 한다 — 화면에서 보인 자리가 여기다.
        let snap = snapshot();
        assert_eq!(snap["c-a"]["account"], json!("one@ccg.test"), "★ 다음 REPLACE가 계정 없는 행을 싣는다: {snap}");
        assert_eq!(snap["c-a"]["ask"], json!("permission"), "★ 다음 REPLACE가 승인 대기를 지운다: {snap}");
        let _ = h;
    }

    /// ★R28c AG2(G2) — 조회는 **메모리가 모르는 채팅**의 행은 계속 지어야 한다.
    ///
    /// 장전이 맵을 통째로 채우던 시절의 부수 효과다: `chat:status`는 REPLACE라서
    /// [`snapshot`]에 없는 채팅은 다음 브로드캐스트에서 통째로 사라진다(사이드바 점이
    /// 꺼진다). 그러니 조회는 *덮지 않되 채우기는* 해야 하고, 채울 때도 옛 파일의
    /// 유령 계정은 안 싣는다(F1).
    #[test]
    fn a_read_still_builds_rows_for_chats_it_has_never_seen() {
        let h = crate::testkit::temp_home("status-query-newcomer");
        forget();
        let boot = load_boot(&["c-a".to_string()]);
        assert!(boot.contains_key("c-a"));
        set("c-a", json!({ "chatId": "c-a", "status": "done", "account": "one@ccg.test" }));
        // R1 판이 써 둔 파일 모양 — 유령 계정이 들어 있고, 얼린 상태는 `working`이다.
        h.write(
            "chats-v3/status.json",
            &json!({ "version": 1, "statuses": { "c-new": {
                "chatId": "c-new", "status": "working", "busy": true, "ask": "permission",
                "account": "ghost@ccg.test", "panelId": "default::0", "updatedAt": 4 } } })
            .to_string(),
        );
        let got = load_boot(&["c-a".to_string(), "c-new".to_string()]);
        println!("[G2] 처음 보는 채팅 = {}", got["c-new"]);
        assert_eq!(got["c-a"]["account"], json!("one@ccg.test"), "살아 있는 행은 그대로다");
        assert!(got.contains_key("c-new"), "★ 처음 보는 채팅의 행을 안 지으면 REPLACE에서 사라진다");
        assert!(got["c-new"].get("account").is_none(), "★ 디스크의 유령 계정이 조회로 들어왔다: {}", got["c-new"]);
        assert_eq!(got["c-new"]["status"], json!("idle"), "돌던 턴으로 되살리면 안 된다");
        assert_eq!(got["c-new"]["busy"], json!(false));
        assert_eq!(got["c-new"]["ask"], json!("none"));
        assert!(snapshot().get("c-new").is_some(), "★ 지은 행은 다음 REPLACE에도 실려야 한다");
        let _ = h;
    }

    /// ★R28c AG2(G2) — 마이그레이션이 심는 값은 **안전값**이다.
    ///
    /// 순서가 함정이다: `engine::boot`의 `load_boot`은 마이그레이션 **전에** 돌고
    /// (그 판의 `chats-v3`는 비어 있어 `load_boot(&[])`이다) 「첫 장전」 자격을 가져간다.
    /// 그 뒤 첫 `chats:get`은 이제 조회라 메모리를 그대로 돌려주므로, 심는 자리에서
    /// 규약 4를 안 걸면 2.6.2가 크래시 때 얼려 둔 `working`이 업그레이드 첫 화면에 뜬다.
    #[test]
    fn a_migration_seeds_safe_values_not_a_running_turn() {
        let h = crate::testkit::temp_home("status-seed-safe");
        forget();
        let _ = load_boot(&[]); // = 마이그레이션 전의 `engine::boot`(채팅이 아직 없다)
        seed(BTreeMap::from([(
            "m-1".to_string(),
            json!({ "chatId": "m-1", "status": "working", "busy": true, "ask": "permission",
                    "bgActive": true, "queued": 2, "hold": Value::Null, "updatedAt": 5 }),
        )]));
        let got = load_boot(&["m-1".to_string()]);
        println!("[G2] 마이그레이션 직후 첫 조회 = {}", got["m-1"]);
        assert_eq!(got["m-1"]["status"], json!("idle"), "★ 얼린 `working`이 유령 알약으로 떴다");
        assert_eq!(got["m-1"]["busy"], json!(false));
        assert_eq!(got["m-1"]["ask"], json!("none"));
        assert_eq!(got["m-1"]["bgActive"], json!(false));
        assert_eq!(got["m-1"]["queued"], json!(2), "재장전 대상(queued·hold)은 안 건드린다");
        let _ = h;
    }

    /// ★R28c AG2 R2 — 규약 4는 **화면을 얼린다. 파일의 사실은 안 지운다.**
    ///
    /// R1이 만든 회귀(확인 크리틱 R1 §6): `seed()`의 강제가 `flush()`로 디스크까지 굳어,
    /// 2.6.2가 크래시로 얼려 둔 `working`이 `status.json`에서 `idle`로 **지워졌다**
    /// (레코드 `<chatId>.json`은 `"working"` 그대로 — 사이드카와 영구히 어긋난다).
    /// 하필 그 필드가 무손실 하네스가 비교하는 값이다(`poc-chat-unify-migrate.mjs`:
    /// BEFORE=2.6.2 `rec.snapshot.status` ↔ AFTER=`status.json.statuses[id].status`).
    #[test]
    fn a_migration_freezes_the_screen_but_not_the_file() {
        let h = crate::testkit::temp_home("status-seed-disk");
        forget();
        let _ = load_boot(&[]); // 마이그레이션 **전**의 `engine::boot`
        seed(BTreeMap::from([
            (
                "c-run".to_string(),
                json!({ "chatId": "c-run", "status": "working", "busy": false, "ask": "none",
                        "bgActive": false, "queued": 2, "hold": Value::Null, "updatedAt": 5 }),
            ),
            (
                "c-done".to_string(),
                json!({ "chatId": "c-done", "status": "done", "busy": false, "ask": "none",
                        "bgActive": false, "queued": 0, "hold": Value::Null, "updatedAt": 6 }),
            ),
        ]));

        // ① 화면(=메모리)은 안전값 — 업그레이드 첫 화면에 유령 알약이 없다.
        let snap = snapshot();
        println!("[R2] seed 직후 메모리 = {snap}");
        assert_eq!(snap["c-run"]["status"], json!("idle"), "★ 얼린 `working`이 첫 화면에 떴다");
        assert_eq!(snap["c-run"]["queued"], json!(2), "재장전 대상은 안 건드린다");

        // ② 파일은 사실 — §5.2 「상태 맵 동일」. 여기가 R1이 깨뜨린 자리다.
        let disk: Value =
            serde_json::from_str(&std::fs::read_to_string(path()).expect("status.json")).unwrap();
        println!("[R2] seed 직후 디스크 = {}", disk["statuses"]);
        assert_eq!(
            disk["statuses"]["c-run"]["status"],
            json!("working"),
            "★ 디스크의 얼어붙은 사실이 지워졌다: {}",
            disk["statuses"]
        );
        assert_eq!(disk["statuses"]["c-done"]["status"], json!("done"));

        // ③ `ccg-migrate`의 마무리 `flush()`가 그 사실을 덮으면 안 된다(dirty는 내려가 있다).
        flush();
        let after: Value =
            serde_json::from_str(&std::fs::read_to_string(path()).expect("status.json")).unwrap();
        assert_eq!(
            after["statuses"]["c-run"]["status"],
            json!("working"),
            "★ 마무리 flush가 안전값으로 사실을 덮었다: {}",
            after["statuses"]
        );

        // ④ 그리고 다음 판의 장전은 그 파일을 다시 얼린다 — 어느 쪽이든 화면은 안전하다.
        forget();
        let boot = load_boot(&["c-run".to_string()]);
        assert_eq!(boot["c-run"]["status"], json!("idle"), "다음 부팅이 돌던 턴을 되살렸다");
        let _ = h;
    }

    /// ★R28c AG2 R3(확인 크리틱 R2 §6) — 규약 4가 파일에 남기는 사실의 **수명**을 못 박는다.
    ///
    /// 위 못(`a_migration_freezes_the_screen_but_not_the_file`)이 재는 것은 `ccg-migrate`가
    /// 단독으로 도는 창까지다. 크리틱이 실 exe로 잰 값은 그 뒤였다: 앱 안에서 **옆 채팅이
    /// 턴을 한 번** 돌면 `dirty`가 서고, 디바운스 [`flush`]는 *메모리 맵 전체*를 쓴다 —
    /// 그 맵의 `c-run`은 [`seed`]가 걸어 둔 안전값(`idle`)이라 파일의 `working`이 덮인다.
    ///
    /// 이 못은 그 사실을 **고정**한다(고치는 못이 아니다): 커밋 메시지·헤더가 「파일에는
    /// 마지막 사실이 남는다」를 조건 없이 적으면 다음 갈래가 그 문장을 믿고 판단한다.
    /// 언젠가 행마다 「아직 살지 않은 값」을 따로 들어 영구히 참으로 만들면, **이 못이
    /// 붉어져** 헤더도 같이 고치라고 말해 줄 것이다.
    #[test]
    fn the_frozen_fact_outlives_the_migration_but_not_the_first_turn() {
        let _h = crate::testkit::temp_home("status-seed-lifetime");
        forget();
        let _ = load_boot(&[]);
        let row = |st: &str| {
            json!({ "status": st, "busy": false, "ask": "none", "bgActive": false,
                    "queued": 0, "hold": Value::Null, "updatedAt": 5 })
        };
        seed(BTreeMap::from([("c-run".to_string(), row("working"))]));
        let disk = || -> Value {
            serde_json::from_str::<Value>(&std::fs::read_to_string(path()).expect("status.json"))
                .unwrap()["statuses"]
                .clone()
        };
        // ① 마이그레이션 프로세스 안 — 마무리 flush까지 사실이다.
        flush();
        assert_eq!(disk()["c-run"]["status"], json!("working"), "{}", disk());

        // ② 앱: 옆 채팅이 턴을 한 번 돈다. 그 한 번이 맵 전체를 쓴다.
        set("c-live", row("done"));
        flush();
        let after = disk();
        println!("[R3] 턴 1회 뒤 디스크 = {after}");
        assert_eq!(after["c-live"]["status"], json!("done"));
        assert_eq!(
            after["c-run"]["status"],
            json!("idle"),
            "★ 수명이 늘었다 — 좋은 소식이면 헤더 규약 4의 「마이그레이션 프로세스까지」도 같이 고쳐라: {after}"
        );

        // ③ 그래도 화면은 안전하다 — 읽는 쪽이 다시 얼리니 피해가 화면에 없다는 근거.
        forget();
        let boot = load_boot(&["c-run".to_string()]);
        assert_eq!(boot["c-run"]["status"], json!("idle"), "덮이든 아니든 화면은 안전값이다");
    }

    /// ★R28c AG2 R2(확인 크리틱 R1 지적 3) — **첫 장전도** 그 사이 앉은 행을 안 덮는다.
    ///
    /// [`claim_boot`]은 표식만 세우고 자물쇠를 놓는다. R1은 그 뒤 디스크를 읽어
    /// `st.map`을 **통째로** 덮었으므로, 그 창에 들어온 `set()`은 사라졌다(조회 쪽은 이미
    /// 막아 둔 창을 자기 가지에는 안 닫아 뒀다). 여기서 부르는 [`boot_load`]는
    /// `load_boot`의 첫 호출이 하는 일 그대로다 — 그 창의 순서를 손으로 세워 잰다.
    #[test]
    fn even_the_first_load_keeps_a_row_that_landed_while_it_read_the_disk() {
        let h = crate::testkit::temp_home("status-boot-merge");
        forget();
        h.write(
            "chats-v3/status.json",
            &json!({ "version": 1, "statuses": {
                "c-a": { "chatId": "c-a", "status": "working", "busy": true, "ask": "permission",
                         "account": "ghost@ccg.test", "updatedAt": 1 },
                "c-b": { "chatId": "c-b", "status": "done", "busy": false, "ask": "none", "updatedAt": 1 } } })
            .to_string(),
        );
        // 표식은 섰고(claim_boot) 디스크는 아직 다 안 읽은 그 순간 — 허브가 행 하나를 앉힌다.
        set(
            "c-a",
            json!({ "chatId": "c-a", "status": "working", "busy": true, "ask": "permission",
                    "account": "one@ccg.test", "panelId": Value::Null, "updatedAt": 9 }),
        );
        let got = boot_load(&["c-a".to_string(), "c-b".to_string()]);
        println!("[R2] 부팅 장전 = {got:?}");
        assert_eq!(got["c-a"]["account"], json!("one@ccg.test"), "★ 장전이 살아 있는 계정을 덮었다");
        assert_eq!(got["c-a"]["ask"], json!("permission"), "★ 장전이 승인 대기를 덮었다");
        assert_eq!(got["c-a"]["busy"], json!(true), "★ 장전이 busy를 꺼 전송 게이트를 열었다");
        // 메모리가 모르는 채팅은 그대로 디스크에서 짓는다(부팅 강제 + 유령 계정 청소).
        assert_eq!(got["c-b"]["status"], json!("done"));
        assert!(got["c-b"].get("account").is_none());
        assert_eq!(snapshot()["c-a"]["account"], json!("one@ccg.test"), "다음 REPLACE도 그대로다");
        let _ = h;
    }

    #[test]
    fn reload_candidates_are_only_the_chats_with_something_to_reload() {
        let h = crate::testkit::temp_home("status-cands");
        h.write("chats-v3/a.json", &json!({ "id": "a", "queue": ["하나"] }).to_string());
        h.write(
            "chats-v3/b.json",
            &json!({ "id": "b", "hold": { "resetsAt": 1_700_000_000.0, "ready": false } }).to_string(),
        );
        h.write("chats-v3/c.json", &json!({ "id": "c", "snapshot": { "messages": [] } }).to_string());
        let ids = ["a".to_string(), "b".to_string(), "c".to_string()];
        assert_eq!(reload_candidates(&ids), vec!["a".to_string(), "b".to_string()]);
    }
}
