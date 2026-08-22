//! **보드 스토어(boards/)** — 자리 배치. M-UX §4.1의 "`chats-v3/`의 복제".
//!
//! ```text
//! boards/
//!   index.json      { version, order[], activeBoardId }
//!   <boardId>.json  { id, title, custom, count, chrome, order, slots, updatedAt }
//! ```
//!
//! 2.6.2 `PersistedSession`(MultiAgent.tsx:139-158)의 후신이다. 다른 점 셋:
//!  - **패널 스냅샷을 담지 않는다.** 대화는 전부 `chats-v3/`에 있고 보드는 `slots[i] = chatId`만
//!    든다 → `ma.rs`의 unloaded 마커 병합(대화 증발의 두 번째 자리)이 **구조적으로 사라진다.**
//!  - `panelOrder` → `order`, `chrome`(`'ide' | 'grid'`) 추가(M9 전용 뷰의 확장점).
//!  - 파일이 작아(수백 바이트) light 조회가 필요 없다.

use serde_json::{json, Map, Value};

use crate::fanout::{safe_id, version_or_1, Fanout};

pub const DIR: &str = "boards";
pub const SLOT_COUNT: usize = 6;

static STORE: Fanout = Fanout::new(DIR, &["index.json"]);

pub fn dir_path() -> std::path::PathBuf {
    STORE.dir_path()
}
pub fn invalidate() {
    STORE.invalidate();
}

pub fn read_boards() -> Value {
    let Some((index, boards)) = STORE.read_all() else { return Value::Null };
    json!({
        "version": version_or_1(&index),
        "boards": boards,
        "activeBoardId": index.get("activeBoardId").and_then(Value::as_str).unwrap_or(""),
    })
}

pub fn read_board(id: &Value) -> Value {
    match safe_id(id) {
        Some(id) => STORE.read_one(id),
        None => Value::Null,
    }
}

pub fn write_boards(data: &Value) {
    let Some(boards) = data.get("boards").and_then(Value::as_array) else { return };
    let mut extra = Map::new();
    extra.insert("version".into(), version_or_1(data));
    extra.insert(
        "activeBoardId".into(),
        json!(data.get("activeBoardId").and_then(Value::as_str).unwrap_or("")),
    );
    STORE.write_all(boards, &extra, |_id, b| b.clone());
}

/// 활성 보드의 **보이는 자리**(order 앞 count개)에 얹힌 채팅들 — light 조회의 (a).
/// 접힌 자리(`order.slice(count)`)는 포함하지 않는다: 스냅샷을 안 실어도 상태 점·배지는
/// `status.json`이 그린다(§4.3의 표).
pub fn visible_chat_ids() -> Vec<String> {
    let Some(index) = STORE.read_index() else { return vec![] };
    let Some(active) = index.get("activeBoardId").and_then(Value::as_str) else { return vec![] };
    let Some(board) = STORE.stored(active) else { return vec![] };
    let count = board.get("count").and_then(Value::as_u64).unwrap_or(1).clamp(1, SLOT_COUNT as u64) as usize;
    let empty = vec![];
    let slots = board.get("slots").and_then(Value::as_array).unwrap_or(&empty);
    let order: Vec<usize> = board
        .get("order")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_u64).map(|v| v as usize).collect())
        .unwrap_or_else(|| (0..SLOT_COUNT).collect());
    let mut out = Vec::new();
    for slot in order.into_iter().take(count) {
        if let Some(Value::String(id)) = slots.get(slot) {
            if !id.is_empty() {
                out.push(id.clone());
            }
        }
    }
    out
}

/// 자리 순열 위생 — 0..5의 순열이 아니면 기본 순서(2.6.2 `sanitizePanelOrder` 파리티).
pub fn sanitize_order(v: Option<&Value>) -> Vec<usize> {
    let def: Vec<usize> = (0..SLOT_COUNT).collect();
    let Some(a) = v.and_then(Value::as_array) else { return def };
    let got: Vec<usize> = a.iter().filter_map(Value::as_u64).map(|x| x as usize).filter(|x| *x < SLOT_COUNT).collect();
    let mut seen = [false; SLOT_COUNT];
    for i in &got {
        seen[*i] = true;
    }
    if got.len() == SLOT_COUNT && seen.iter().all(|b| *b) {
        got
    } else {
        def
    }
}
