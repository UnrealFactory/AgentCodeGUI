//! **2.6.2 3스토어 → chats-v3 마이그레이션** (M-UX §4.2).
//!
//! `chats/` + `multi-agent/` + `session-chats/`(+ `chat-talk.json`) → `chats-v3/` + `boards/`.
//!
//! 안전 규칙 셋:
//!  1. **옛 디렉터리를 지우지 않는다.** 2.6.2로 되돌아가면 마이그레이션 시점 상태로 그대로
//!     산다(§4.1). 되돌리기 경로가 둘이 되도록 `backup-2.6.2-<stamp>/`에 통째 복사도 남긴다.
//!  2. **임시 디렉터리에 완성한 뒤 마지막에 rename**(§5.3-6). 중간에 죽어도 옛 3디렉터리는
//!     온전하고 반쪽짜리 `chats-v3/`가 남지 않는다.
//!  3. **값을 조용히 고치지 않는다.** 정규화가 실패할 값(지운 폴더·로그아웃 계정·키 없음)도
//!     그대로 옮긴다 — 앱에서 그 채팅의 첫 send가 같은 사유로 정직하게 거부된다(m-logic §4.2).
//!     조용한 값 보정이 가장 위험한 마이그레이션 버그다.
//!
//! id 규칙(결정론 — 재실행해도 같은 id = 멱등):
//!  - 일반 채팅: **id 유지**
//!  - 멀티 패널: `ma-<sessionId>-<slot>`
//!  - 추가 채팅: id 유지, 충돌 시 `sc-<id>`
//!  - 채팅 모드(chat-talk): id 유지, 충돌 시 `talk-<id>`

use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use crate::raw_identity::{to_raw_identity, Globals, Source};

const OLD_DIRS: [&str; 3] = ["chats", "multi-agent", "session-chats"];
const TALK_FILE: &str = "chat-talk.json";

fn read_json(p: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()
}

fn stamp() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// 인덱스가 나열하는 순서대로 항목 파일을 읽는다(스토어 캐시를 타지 않는 생 읽기).
fn read_fanout(home: &Path, dir: &str) -> (Value, Vec<(String, Value)>) {
    let d = home.join(dir);
    let index = read_json(&d.join("index.json")).unwrap_or(Value::Null);
    let empty = vec![];
    let order = index.get("order").and_then(Value::as_array).unwrap_or(&empty);
    let mut out = Vec::new();
    for id in order {
        let Some(id) = id.as_str() else { continue };
        if !crate::fanout::safe_id_str(id) {
            continue;
        }
        let Some(v) = read_json(&d.join(format!("{id}.json"))) else { continue };
        out.push((id.to_string(), v));
    }
    (index, out)
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").to_string()
}
fn b(v: &Value, k: &str) -> bool {
    v.get(k).and_then(Value::as_bool).unwrap_or(false)
}
fn msg_count(rec: &Value) -> usize {
    rec.get("snapshot")
        .and_then(|s| s.get("messages"))
        .and_then(Value::as_array)
        .map(|a| a.len())
        .unwrap_or(0)
}

/// "내용 있는 패널" — 제목이 있거나 대화가 있다. 2.6.2가 채팅에 쓰던 판정
/// (`App.tsx:566` `!!c.title || messages.length`)을 그대로 옮겼다. 내용 없는 패널은
/// 채팅을 만들지 않고 `slots[i] = null`이 된다(§4.2).
fn panel_has_content(p: &Value) -> bool {
    p.is_object() && (!s(p, "title").is_empty() || msg_count(p) > 0)
}

/// 저장 시점 상태를 얼린다 — 실행 중 상태로 복원하지 않는다(`sessionChats.ts:28` 파리티).
/// **마이그레이터는 원본 값을 그대로 옮긴다**(§5.2 "상태 맵 동일"). 얼리기는 부팅 장전
/// (`status::load_boot` 규약 4)이 한다 — 파일은 사실, 메모리는 안전값.
fn status_of(rec: &Value, from_snapshot: bool) -> String {
    let v = if from_snapshot {
        rec.get("snapshot").and_then(|s| s.get("status")).and_then(Value::as_str)
    } else {
        rec.get("status").and_then(Value::as_str)
    };
    v.unwrap_or("idle").to_string()
}

/// 하나의 대상 채팅 레코드를 만든다.
struct Built {
    id: String,
    chat: Value,
    status: String,
}

fn opt_copy(src: &Value, dst: &mut Map<String, Value>, keys: &[&str]) {
    for k in keys {
        if let Some(v) = src.get(*k) {
            if !v.is_null() {
                dst.insert((*k).to_string(), v.clone());
            }
        }
    }
}

/// 과도기 표식 — 이 채팅이 **어느 옛 스토어에서 왔는가**.
/// §4.1 필드 목록에 없는 **추가 필드**이고, 이유는 하나다: 얼려 둔 2.6.2 렌더러가 목록을
/// 셋(본채팅 사이드바 · 멀티 그리드 · 추가 채팅)으로 나눠 들고 있어서, 별칭 계층이
/// `chats:save`로 온 목록을 저장할 때 **어디까지 지워도 되는지**를 알아야 하기 때문이다.
/// 없으면 본채팅 저장 한 번이 멀티 패널·추가 채팅의 대화를 통째로 prune한다.
/// 통합 UI가 서면 이 필드는 별칭 계층과 함께 사라진다.
pub const ORIGIN_CHAT: &str = "chat";
pub const ORIGIN_PANEL: &str = "panel";
pub const ORIGIN_SESSION: &str = "session";

fn origin_of(source: Source) -> &'static str {
    match source {
        // 2.6.2도 chat-talk을 **본채팅 목록으로** 편입한다(App.tsx:558) → 같은 칸
        Source::Chat | Source::Talk => ORIGIN_CHAT,
        Source::Panel => ORIGIN_PANEL,
        Source::SessionChat => ORIGIN_SESSION,
    }
}

fn build_chat(id: &str, rec: &Value, source: Source, g: &Globals) -> Built {
    let mut o = Map::new();
    o.insert("id".into(), json!(id));
    o.insert("origin".into(), json!(origin_of(source)));
    o.insert("title".into(), json!(s(rec, "title")));
    o.insert("custom".into(), json!(b(rec, "custom")));
    // ★ 없던 필드 → 기본값 주입(§4.2 — R1이 "그대로"라 적은 것은 오류)
    o.insert("locked".into(), json!(b(rec, "locked")));
    o.insert("color".into(), json!(s(rec, "color")));
    o.insert("identity".into(), to_raw_identity(rec, source, g));
    // 초안 — 멀티 패널은 **공집합**이다(MultiAgent.tsx:127-137, 애초에 영속 안 됨)
    if source != Source::Panel {
        opt_copy(rec, &mut o, &["draft", "draftImages"]);
    }
    opt_copy(rec, &mut o, &["btwSeed", "btwPrompt", "empty", "updatedAt"]);
    o.insert("snapshot".into(), rec.get("snapshot").cloned().unwrap_or(Value::Null));
    let status = status_of(rec, source != Source::SessionChat);
    Built { id: id.to_string(), chat: Value::Object(o), status }
}

/// `btwOf` 재작성(§4.2) — 매핑표만으로는 안 된다.
/// 멀티에서 만든 btw의 `btwOf`는 **panelId 형식** `${sessionId}::${slot}`이다.
fn rewrite_btw_of(v: &str, id_map: &HashMap<String, String>) -> Option<String> {
    if let Some((sid, slot)) = v.rsplit_once("::") {
        if slot.len() == 1 && slot.chars().all(|c| c.is_ascii_digit()) {
            let cand = format!("ma-{sid}-{slot}");
            return if id_map.values().any(|x| x == &cand) { Some(cand) } else { None };
        }
    }
    id_map.get(v).cloned()
}

/// 이미 마이그레이션됐는가.
pub fn is_migrated() -> bool {
    crate::read_home_json(&format!("{}/index.json", crate::chats_v3::DIR))
        .and_then(|v| v.get("migratedAt").cloned())
        .is_some()
}

/// 부팅 훅 — 아직 안 됐으면 1회 돌린다(플래그가 켜진 경로에서만 불린다).
pub fn ensure_migrated() -> Value {
    if is_migrated() {
        return json!({ "skipped": true, "reason": "already-migrated" });
    }
    migrate(true)
}

/// 본체. `backup=true`면 원본 3디렉터리 + chat-talk.json을 통째 복사한다.
pub fn migrate(backup: bool) -> Value {
    let home = crate::app_home();
    let t0 = std::time::Instant::now();
    let g = Globals::read();
    let prefs = crate::prefs::read_ui_prefs();
    let now = stamp();

    // ── 1. 원본 읽기 ────────────────────────────────────────────────────────
    let (chats_index, chats) = read_fanout(&home, "chats");
    let (ma_index, sessions) = read_fanout(&home, "multi-agent");
    let (sc_index, session_chats) = read_fanout(&home, "session-chats");
    let talk = read_json(&home.join(TALK_FILE)).unwrap_or(Value::Null);

    let mut built: Vec<Built> = Vec::new();
    let mut id_map: HashMap<String, String> = HashMap::new(); // 옛 주소 → 새 id
    let mut taken: HashSet<String> = HashSet::new();
    let mut warnings: Vec<Value> = Vec::new();

    // ── 2. 일반 채팅 (id 유지) ──────────────────────────────────────────────
    for (id, rec) in &chats {
        built.push(build_chat(id, rec, Source::Chat, &g));
        id_map.insert(id.clone(), id.clone());
        taken.insert(id.clone());
    }

    // ── 3. 멀티 패널 → 채팅 + 보드 ─────────────────────────────────────────
    let mut boards: Vec<Value> = Vec::new();
    let mut ma_panel_count = 0usize;
    for (sid, sess) in &sessions {
        let empty = vec![];
        let panels = sess.get("panels").and_then(Value::as_array).unwrap_or(&empty);
        let mut slots: Vec<Value> = vec![Value::Null; crate::boards::SLOT_COUNT];
        for (i, p) in panels.iter().enumerate() {
            if i >= crate::boards::SLOT_COUNT || !panel_has_content(p) {
                continue;
            }
            let new_id = format!("ma-{sid}-{i}");
            built.push(build_chat(&new_id, p, Source::Panel, &g));
            id_map.insert(format!("{sid}::{i}"), new_id.clone());
            taken.insert(new_id.clone());
            slots[i] = json!(new_id);
            ma_panel_count += 1;
        }
        let count = sess.get("count").and_then(Value::as_u64).unwrap_or(1).clamp(1, crate::boards::SLOT_COUNT as u64);
        let mut bo = Map::new();
        bo.insert("id".into(), json!(sid));
        bo.insert("title".into(), json!(s(sess, "title")));
        bo.insert("custom".into(), json!(b(sess, "custom")));
        bo.insert("count".into(), json!(count));
        bo.insert("chrome".into(), json!("grid"));
        bo.insert("order".into(), json!(crate::boards::sanitize_order(sess.get("panelOrder"))));
        bo.insert("slots".into(), json!(slots));
        if let Some(u) = sess.get("updatedAt") {
            bo.insert("updatedAt".into(), u.clone());
        }
        boards.push(Value::Object(bo));
    }

    // ── 4. 추가 채팅 (충돌 시 sc- 접두사) ──────────────────────────────────
    for (id, rec) in &session_chats {
        let new_id = if taken.contains(id) { format!("sc-{id}") } else { id.clone() };
        if new_id != *id {
            warnings.push(json!({ "kind": "id_collision", "old": id, "new": new_id }));
        }
        built.push(build_chat(&new_id, rec, Source::SessionChat, &g));
        id_map.insert(id.clone(), new_id.clone());
        taken.insert(new_id);
    }

    // ── 5. chat-talk.json 1회 편입 (2.6.2 App.tsx:558-566과 같은 채택 규칙) ──
    let mut talk_absorbed = 0usize;
    let empty = vec![];
    for rec in talk.get("chats").and_then(Value::as_array).unwrap_or(&empty) {
        let id = s(rec, "id");
        if id.is_empty() || !crate::fanout::safe_id_str(&id) {
            continue;
        }
        // 제목도 대화도 없는 것은 편입하지 않는다(2.6.2와 같은 필터)
        if s(rec, "title").is_empty() && msg_count(rec) == 0 {
            continue;
        }
        let new_id = if taken.contains(&id) { format!("talk-{id}") } else { id.clone() };
        built.push(build_chat(&new_id, rec, Source::Talk, &g));
        id_map.insert(id.clone(), new_id.clone());
        taken.insert(new_id);
        talk_absorbed += 1;
    }

    // ── 6. btwOf 재작성 ────────────────────────────────────────────────────
    let mut btw_rewritten = 0usize;
    let mut btw_dropped = 0usize;
    let sc_btw: Vec<(String, String)> = session_chats
        .iter()
        .filter_map(|(id, rec)| {
            let v = rec.get("btwOf").and_then(Value::as_str)?;
            Some((id.clone(), v.to_string()))
        })
        .collect();
    for (old_id, btw_of) in sc_btw {
        let Some(new_id) = id_map.get(&old_id).cloned() else { continue };
        let target = rewrite_btw_of(&btw_of, &id_map);
        let Some(item) = built.iter_mut().find(|x| x.id == new_id) else { continue };
        match target {
            Some(t) => {
                if let Some(o) = item.chat.as_object_mut() {
                    o.insert("btwOf".into(), json!(t));
                }
                btw_rewritten += 1;
            }
            None => {
                // 원본이 이미 삭제됨 — drop하고 기록한다(§4.2: "고아 0건"은 *재작성 실패*가
                // 0이라는 뜻이지 *원본이 없던 것*까지 살린다는 뜻이 아니다)
                btw_dropped += 1;
                warnings.push(json!({ "kind": "btw_orphan", "chat": new_id, "btwOf": btw_of }));
            }
        }
    }

    // ── 7. 한도 대기표 이관 (ui-prefs.limitResume.hold — 단일, key=activeChatId) ──
    let mut hold_moved = 0usize;
    if let Some(hold) = sanitize_hold(prefs.get("limitResume.hold"), now as f64) {
        let key = hold.get("key").and_then(Value::as_str).unwrap_or("").to_string();
        match id_map.get(&key).and_then(|nid| built.iter_mut().find(|x| x.id == *nid)) {
            Some(item) => {
                if let Some(o) = item.chat.as_object_mut() {
                    o.insert("hold".into(), hold);
                }
                hold_moved = 1;
            }
            None => warnings.push(json!({ "kind": "hold_orphan", "key": key })),
        }
    }

    // ── 8. 순서·활성 (§4.2: 일반 → 멀티 패널 → 추가 채팅, 그 뒤 talk) ──────
    let order: Vec<String> = built.iter().map(|x| x.id.clone()).collect();
    let active_chat_id = chats_index.get("activeChatId").and_then(Value::as_str).unwrap_or("").to_string();
    let active_chat_id = if id_map.contains_key(&active_chat_id) { active_chat_id } else { String::new() };

    // ── 9. 기본 보드 ───────────────────────────────────────────────────────
    let ws_multi = prefs.get("workspace.mode").and_then(Value::as_str) == Some("multi");
    let active_session_id = ma_index.get("activeSessionId").and_then(Value::as_str).unwrap_or("").to_string();
    let last_count = sessions
        .iter()
        .find(|(sid, _)| *sid == active_session_id)
        .or_else(|| sessions.last())
        .and_then(|(_, s)| s.get("count").and_then(Value::as_u64))
        .unwrap_or(1)
        .clamp(1, crate::boards::SLOT_COUNT as u64);
    let def_count = if ws_multi { last_count } else { 1 };
    let mut def_slots: Vec<Value> = vec![Value::Null; crate::boards::SLOT_COUNT];
    if !active_chat_id.is_empty() {
        def_slots[0] = json!(active_chat_id);
    }
    let default_board = json!({
        "id": "default",
        "title": "",
        "custom": false,
        "count": def_count,
        "chrome": if def_count == 1 { "ide" } else { "grid" },
        "order": (0..crate::boards::SLOT_COUNT).collect::<Vec<_>>(),
        "slots": def_slots,
    });
    let mut board_order: Vec<String> = vec!["default".into()];
    board_order.extend(sessions.iter().map(|(sid, _)| sid.clone()));
    let mut all_boards = vec![default_board];
    all_boards.extend(boards);
    // 활성 보드 — 멀티를 보고 있었으면 그 세션, 아니면 기본 보드
    let active_board_id = if ws_multi && board_order.iter().any(|b| *b == active_session_id) {
        active_session_id.clone()
    } else {
        "default".to_string()
    };

    // ── 10. 스테이징 → 커밋 ────────────────────────────────────────────────
    let backup_dir = if backup { Some(make_backup(&home, now)) } else { None };

    // 지난 실행이 **중간에 죽어** 남긴 스테이징을 먼저 쓸어낸다.
    // (PoC의 중간 kill에서 실측: 커밋 전에 죽으면 `chats-v3.tmp-<stamp>`가 홈에 남는다)
    sweep_leftovers(&home);

    let staged_chats = home.join(format!("{}.tmp-{now}", crate::chats_v3::DIR));
    let staged_boards = home.join(format!("{}.tmp-{now}", crate::boards::DIR));
    let _ = std::fs::remove_dir_all(&staged_chats);
    let _ = std::fs::remove_dir_all(&staged_boards);
    if std::fs::create_dir_all(&staged_chats).is_err() || std::fs::create_dir_all(&staged_boards).is_err() {
        return json!({ "ok": false, "error": "스테이징 디렉터리 생성 실패" });
    }

    // 재실행(재마이그레이션)에서 3.0이 만든 채팅은 보존한다 — 소스가 만든 id는 소스가 이긴다
    let mut carried: Vec<String> = Vec::new();
    if let Some(prev) = crate::read_home_json(&format!("{}/index.json", crate::chats_v3::DIR)) {
        let pe = vec![];
        for id in prev.get("order").and_then(Value::as_array).unwrap_or(&pe) {
            let Some(id) = id.as_str() else { continue };
            if taken.contains(id) {
                continue;
            }
            let src = home.join(crate::chats_v3::DIR).join(format!("{id}.json"));
            if std::fs::copy(&src, staged_chats.join(format!("{id}.json"))).is_ok() {
                carried.push(id.to_string());
            }
        }
    }

    let mut statuses: BTreeMap<String, Value> = BTreeMap::new();
    let mut msg_total = 0usize;
    for item in &built {
        msg_total += msg_count(&item.chat);
        let text = serde_json::to_string(&item.chat).unwrap_or_default();
        if std::fs::write(staged_chats.join(format!("{}.json", item.id)), &text).is_err() {
            return json!({ "ok": false, "error": format!("채팅 파일 쓰기 실패: {}", item.id) });
        }
        let mut lite = crate::status::empty_lite(&item.id);
        if let Some(o) = lite.as_object_mut() {
            o.insert("status".into(), json!(item.status));
            o.insert("queued".into(), json!(0)); // 2.6.2는 예약 큐를 영속하지 않는다
            o.insert(
                "hold".into(),
                match item.chat.get("hold") {
                    Some(h) if h.is_object() => json!({ "resetAt": h.get("resetsAt").cloned().unwrap_or(Value::Null), "ready": false }),
                    _ => Value::Null,
                },
            );
            o.insert("updatedAt".into(), item.chat.get("updatedAt").cloned().unwrap_or(json!(0)));
        }
        statuses.insert(item.id.clone(), lite);
    }
    let mut full_order = order.clone();
    full_order.extend(carried.iter().cloned());

    let index = json!({
        "version": 1,
        "order": full_order,
        "activeChatId": active_chat_id,
        "migratedFrom": "2.6.2",
        "migratedAt": now as f64,
    });
    let _ = std::fs::write(staged_chats.join("index.json"), serde_json::to_string(&index).unwrap_or_default());
    let _ = std::fs::write(
        staged_chats.join("status.json"),
        serde_json::to_string(&json!({ "version": 1, "statuses": statuses.clone().into_iter().collect::<Map<_, _>>() }))
            .unwrap_or_default(),
    );

    for bd in &all_boards {
        let id = s(bd, "id");
        let _ = std::fs::write(staged_boards.join(format!("{id}.json")), serde_json::to_string(bd).unwrap_or_default());
    }
    let _ = std::fs::write(
        staged_boards.join("index.json"),
        serde_json::to_string(&json!({ "version": 1, "order": board_order, "activeBoardId": active_board_id }))
            .unwrap_or_default(),
    );

    let commit_chats = commit_dir(&staged_chats, &home.join(crate::chats_v3::DIR), now);
    let commit_boards = commit_dir(&staged_boards, &home.join(crate::boards::DIR), now);
    crate::chats_v3::invalidate();
    crate::boards::invalidate();
    crate::status::seed(statuses);

    // chat-talk.json은 편입분이 있을 때만 비운다(2.6.2 `if (migrated.length)` 파리티)
    if talk_absorbed > 0 {
        let _ = crate::write_home_file(TALK_FILE, &json!({ "version": 1, "chats": [], "activeChatId": "" }).to_string());
    }

    json!({
        "ok": commit_chats && commit_boards,
        "migratedAt": now as f64,
        "elapsedMs": t0.elapsed().as_millis() as f64,
        "backupDir": backup_dir.map(|p| p.to_string_lossy().to_string()),
        "counts": {
            "chats": chats.len(),
            "maSessions": sessions.len(),
            "maPanels": ma_panel_count,
            "sessionChats": session_chats.len(),
            "talkAbsorbed": talk_absorbed,
            "carried": carried.len(),
            "total": built.len(),
            "messages": msg_total,
            "boards": all_boards.len(),
        },
        "idMap": id_map.iter().map(|(k, v)| (k.clone(), json!(v))).collect::<Map<String, Value>>(),
        "order": order,
        "activeChatId": active_chat_id,
        "boardOrder": board_order,
        "activeBoardId": active_board_id,
        "activeSessionId": active_session_id,
        "btw": { "rewritten": btw_rewritten, "dropped": btw_dropped },
        "holdMoved": hold_moved,
        "sourceIndexOrders": {
            "chats": chats_index.get("order").cloned().unwrap_or(json!([])),
            "multiAgent": ma_index.get("order").cloned().unwrap_or(json!([])),
            "sessionChats": sc_index.get("order").cloned().unwrap_or(json!([])),
        },
        "warnings": warnings,
    })
}

/// `sanitizeHold`(렌더러 `lib/limitResume.ts:98-112`)와 같은 위생 — 24시간 만료 + 형태.
/// `ready`는 저장하지 않는다(복원 후 발화 재검증이 다시 판정한다).
fn sanitize_hold(v: Option<&Value>, now_ms: f64) -> Option<Value> {
    let v = v?;
    if !v.is_object() {
        return None;
    }
    let key = v.get("key").and_then(Value::as_str).filter(|s| !s.is_empty())?;
    let at = v.get("at").and_then(Value::as_f64)?;
    if !(now_ms - at < 24.0 * 3600_000.0) {
        return None;
    }
    let mut o = Map::new();
    o.insert("key".into(), json!(key));
    o.insert(
        "engine".into(),
        json!(if v.get("engine").and_then(Value::as_str) == Some("codex") { "codex" } else { "claude" }),
    );
    if let Some(a) = v.get("account").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        o.insert("account".into(), json!(a));
    }
    o.insert("resetsAt".into(), v.get("resetsAt").filter(|x| x.is_number()).cloned().unwrap_or(Value::Null));
    o.insert("fable".into(), json!(v.get("fable").and_then(Value::as_bool).unwrap_or(false)));
    o.insert(
        "lastPrompt".into(),
        json!(v.get("lastPrompt").and_then(Value::as_str).unwrap_or("")),
    );
    o.insert("at".into(), json!(at));
    Some(Value::Object(o))
}

/// 죽은 스테이징(`chats-v3.tmp-*` · `boards.tmp-*` · `*.old-*`) 청소.
/// 커밋은 rename 한 번이므로 이 이름들이 남아 있다는 것은 "지난 실행이 커밋 전에 죽었다"는
/// 뜻이고, 제자리 데이터는 손대지 않은 상태다 → 지워도 잃을 게 없다.
fn sweep_leftovers(home: &Path) {
    let Ok(entries) = std::fs::read_dir(home) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let is_staging = (name.starts_with(&format!("{}.", crate::chats_v3::DIR))
            || name.starts_with(&format!("{}.", crate::boards::DIR)))
            && (name.contains(".tmp-") || name.contains(".old-"));
        if is_staging && e.path().is_dir() {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

/// 원본 3디렉터리 + chat-talk.json 통째 복사 — 롤백 경로 둘 중 하나(§4.2).
fn make_backup(home: &Path, now: u128) -> PathBuf {
    let dst = home.join(format!("backup-2.6.2-{now}"));
    let _ = std::fs::create_dir_all(&dst);
    for d in OLD_DIRS {
        let src = home.join(d);
        if src.is_dir() {
            let _ = copy_dir(&src, &dst.join(d));
        }
    }
    let talk = home.join(TALK_FILE);
    if talk.is_file() {
        let _ = std::fs::copy(&talk, dst.join(TALK_FILE));
    }
    dst
}

fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for e in std::fs::read_dir(src)? {
        let e = e?;
        let p = e.path();
        let to = dst.join(e.file_name());
        if p.is_dir() {
            copy_dir(&p, &to)?;
        } else {
            std::fs::copy(&p, &to)?;
        }
    }
    Ok(())
}

/// 스테이징 디렉터리를 제자리로 — 있으면 옛 것을 옆으로 밀고 rename, 성공하면 삭제.
/// (중간에 죽어도 `.old-<stamp>`가 남아 손으로 복구할 수 있고, 옛 3디렉터리는 무사하다)
fn commit_dir(tmp: &Path, dst: &Path, now: u128) -> bool {
    let old = dst.with_file_name(format!("{}.old-{now}", dst.file_name().unwrap_or_default().to_string_lossy()));
    if dst.exists() && std::fs::rename(dst, &old).is_err() {
        return false;
    }
    if std::fs::rename(tmp, dst).is_err() {
        // 되돌린다 — 실패해도 스테이징은 남으므로 데이터가 사라지지 않는다
        let _ = std::fs::rename(&old, dst);
        return false;
    }
    let _ = std::fs::remove_dir_all(&old);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn btw_panel_form_is_rewritten_to_the_deterministic_panel_id() {
        let mut m = HashMap::new();
        m.insert("sess1::2".to_string(), "ma-sess1-2".to_string());
        m.insert("abc".to_string(), "sc-abc".to_string());
        assert_eq!(rewrite_btw_of("sess1::2", &m).as_deref(), Some("ma-sess1-2"));
        assert_eq!(rewrite_btw_of("abc", &m).as_deref(), Some("sc-abc"));
        assert_eq!(rewrite_btw_of("gone", &m), None); // 원본이 이미 삭제됨 → drop
    }

    #[test]
    fn hold_expires_after_24h_and_drops_ready() {
        let now = 1_000_000_000.0f64;
        let fresh = json!({ "key": "c1", "at": now - 1000.0, "resetsAt": 42, "ready": true });
        let h = sanitize_hold(Some(&fresh), now).unwrap();
        assert_eq!(h["key"], "c1");
        assert!(h.get("ready").is_none()); // ready는 영속하지 않는다
        let stale = json!({ "key": "c1", "at": now - 25.0 * 3600_000.0 });
        assert!(sanitize_hold(Some(&stale), now).is_none());
    }

    #[test]
    fn panel_content_predicate_matches_2_6_2s_chat_rule() {
        assert!(!panel_has_content(&json!({ "title": "", "snapshot": { "messages": [] } })));
        assert!(panel_has_content(&json!({ "title": "x", "snapshot": null })));
        assert!(panel_has_content(&json!({ "title": "", "snapshot": { "messages": [1] } })));
    }
}
