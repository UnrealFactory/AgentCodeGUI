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
    crate::parse_json_source(&std::fs::read_to_string(p).ok()?)
}

/// 파싱 불가 원본을 **격리 보관**한다 — 마이그레이션이 못 읽었어도 사용자는 파일을
/// 잃지 않는다(옛 디렉터리도 남지만, 여기 모아 두면 "무엇이 문제였나"가 한자리에 보인다).
fn quarantine(home: &Path, stamp: u128, dir: &str, name: &str) -> bool {
    let dst = home.join("quarantine").join(format!("{stamp}")).join(dir);
    if std::fs::create_dir_all(&dst).is_err() {
        return false;
    }
    std::fs::copy(home.join(dir).join(name), dst.join(name)).is_ok()
}

fn stamp() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// 원본 팬아웃 읽기 — **인덱스 + 디렉터리 합집합**(★R2 D4).
///
/// R1은 `index.order`만 돌고 `read_json` 실패는 조용히 `continue`였다. 그래서
/// ① 잘린/인코딩 깨진/깊은 중첩 파일 ② 인덱스에 없는 파일 ③ 인덱스 자체가 깨진 경우가
/// 전부 **경고 한 줄 없이** 사라졌다(공격 1·2·3·8·10). 규약을 바꾼다:
///
///  - 인덱스를 못 읽으면 **디렉터리를 훑는다**(파일이 진실) + `unreadable_index` 경고
///  - 인덱스에 없는 파일도 **뒤에 붙여 옮긴다** + `not_in_index` 경고
///  - 그래도 못 읽은 파일은 `unreadable_source` 경고 + `quarantine/`에 원본 보관
///  - 인덱스가 가리키는데 없는 파일은 `missing_source_file` 경고
///
/// 즉 "조용한 드랍"이 구조적으로 불가능해진다 — 보존하거나, 경고를 남기거나 둘 중 하나다.
fn read_fanout(home: &Path, dir: &str, stamp: u128, warnings: &mut Vec<Value>) -> (Value, Vec<(String, Value)>) {
    let d = home.join(dir);
    if !d.is_dir() {
        return (Value::Null, Vec::new());
    }
    let index_path = d.join("index.json");
    let index_raw = std::fs::read_to_string(&index_path).ok();
    let index = index_raw.as_deref().and_then(crate::parse_json_source);
    if index_raw.is_some() && index.is_none() {
        warnings.push(json!({ "kind": "unreadable_index", "dir": dir }));
        quarantine(home, stamp, dir, "index.json");
    }
    let index = index.unwrap_or(Value::Null);

    let mut order: Vec<String> = index
        .get("order")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).filter(|s| crate::fanout::safe_id_str(s)).map(str::to_string).collect())
        .unwrap_or_default();

    // 디렉터리 전수 스캔 — 인덱스가 모르는 파일을 꼬리에 붙인다(이름순, 결정론)
    let mut on_disk: Vec<String> = std::fs::read_dir(&d)
        .map(|it| {
            it.flatten()
                .filter_map(|e| {
                    let n = e.file_name().to_string_lossy().to_string();
                    if !n.ends_with(".json") || n == "index.json" {
                        return None;
                    }
                    let id = n.trim_end_matches(".json").to_string();
                    if crate::fanout::safe_id_str(&id) && e.path().is_file() {
                        Some(id)
                    } else {
                        None
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    on_disk.sort();
    let listed: HashSet<String> = order.iter().cloned().collect();
    for id in &on_disk {
        if !listed.contains(id) {
            warnings.push(json!({ "kind": "not_in_index", "dir": dir, "id": id }));
            order.push(id.clone());
        }
    }

    let present: HashSet<String> = on_disk.into_iter().collect();
    let mut out = Vec::new();
    for id in order {
        if !present.contains(&id) {
            warnings.push(json!({ "kind": "missing_source_file", "dir": dir, "id": id }));
            continue;
        }
        match read_json(&d.join(format!("{id}.json"))) {
            Some(v) => out.push((id, v)),
            None => {
                let kept = quarantine(home, stamp, dir, &format!("{id}.json"));
                warnings.push(json!({ "kind": "unreadable_source", "dir": dir, "id": id, "quarantined": kept }));
            }
        }
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
/// ★R2(D9) — 칸을 모르는 레코드. **아무도 못 지우고 어느 옛 목록에도 안 낀다.**
/// 코어 `chats_v3::write_chats`가 만든 채팅(= M-LOGIC이 만든 채팅)이 여기 앉는다:
/// 기본값이 `chat`이던 R1에서는 그 채팅이 낡은 렌더러 저장 한 번에 삭제됐다.
pub const ORIGIN_UNKNOWN: &str = "unknown";

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
    let identity = to_raw_identity(rec, source, g);
    // ★R2 D5 — api 모드에서는 `billing` 태그드 유니온에 계정 칸이 없다. 그대로 두면
    // **채팅별 계정 오버라이드가 전부 사라진다**(2.6.2에서 실제로 쓰이는 기능이다).
    // 정체성 축이 아니라 **레코드의 보존 칸**에 원시 값을 남긴다(별칭 계층과 함께 소멸).
    if identity.get("billing").and_then(|b| b.get("kind")).and_then(Value::as_str) == Some("api_key") {
        let acc = rec.get("picker").and_then(|p| p.get("account")).and_then(Value::as_str).unwrap_or("");
        if !acc.is_empty() {
            o.insert("legacyAccount".into(), json!(acc));
        }
    }
    o.insert("identity".into(), identity);
    // 초안 — 멀티 패널은 **공집합**이다(MultiAgent.tsx:127-137, 애초에 영속 안 됨)
    if source != Source::Panel {
        opt_copy(rec, &mut o, &["draft", "draftImages"]);
    }
    opt_copy(rec, &mut o, &["btwSeed", "btwPrompt", "empty", "updatedAt"]);
    o.insert("snapshot".into(), rec.get("snapshot").cloned().unwrap_or(Value::Null));
    let status = status_of(rec, source != Source::SessionChat);
    // ★R2 D12 — 얼린 상태를 **레코드에도** 남긴다. `status.json`은 파생 캐시(§4.3 규약 5)라
    // 지워질 수 있는데, 그때 재구성할 곳이 여기밖에 없다. 2.6.2는 이 값을
    // `session-chats/<id>.json`에 들고 있었다 = 없으면 회귀다(`done` → 전부 `idle`).
    o.insert("status".into(), json!(status));
    Built { id: id.to_string(), chat: Value::Object(o), status }
}

/// 이미 쓰인 id면 `-b`, `-c`… 를 붙여 비운다(결정론 — 같은 입력이면 같은 결과).
fn uniquify(base: String, taken: &HashSet<String>, warnings: &mut Vec<Value>, kind: &str) -> String {
    if !taken.contains(&base) {
        return base;
    }
    for suffix in 'b'..='z' {
        let cand = format!("{base}-{suffix}");
        if !taken.contains(&cand) {
            warnings.push(json!({ "kind": "id_collision", "old": base, "new": cand, "source": kind }));
            return cand;
        }
    }
    base
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
///
/// ★R2 D8 — 커밋은 rename **둘**(`chats-v3`, `boards`)이다. 그 사이에서 죽거나 두 번째가
/// 실패하면 `chats-v3`만 제자리에 앉는데, R1은 `migratedAt`만 보고 "완료"로 읽어
/// **보드 없는 영구 상태**(멀티가 전부 마커)로 굳었다. 둘 다 서야 완료다.
pub fn is_migrated() -> bool {
    let marked = crate::read_home_json(&format!("{}/index.json", crate::chats_v3::DIR))
        .and_then(|v| v.get("migratedAt").cloned())
        .is_some();
    marked && crate::app_home().join(crate::boards::DIR).join("index.json").is_file()
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
    let now = stamp();
    let mut warnings: Vec<Value> = Vec::new();

    // ★R2 D14 — 깨진 전역 pref가 **틀린 값**으로 굳는 것을 막는다. 물질화는 되돌리기
    // 어려운 1회성 결정이라(전 채팅의 billing·outputStyle) 조용히 기본값으로 넘어가면
    // `api.mode:true` 사용자가 전부 `subscription`이 된다. 온전한 상위 쌍까지 건져 쓰고
    // 무엇을 건졌는지 경고로 남긴다.
    let (prefs, prefs_damage) = crate::prefs::read_ui_prefs_salvaged();
    if let Some(d) = prefs_damage {
        warnings.push(json!({ "kind": "globals_unreadable", "file": "ui-prefs.json", "salvage": d }));
    }
    let g = Globals::from_prefs(&prefs);

    // ── 1. 원본 읽기 ────────────────────────────────────────────────────────
    let (chats_index, chats) = read_fanout(&home, "chats", now, &mut warnings);
    let (ma_index, sessions) = read_fanout(&home, "multi-agent", now, &mut warnings);
    let (sc_index, session_chats) = read_fanout(&home, "session-chats", now, &mut warnings);
    let talk_raw = std::fs::read_to_string(home.join(TALK_FILE)).ok();
    let talk = match talk_raw.as_deref().map(|r| (r, crate::parse_json_source(r))) {
        Some((_, Some(v))) => v,
        Some((_, None)) => {
            warnings.push(json!({ "kind": "unreadable_source", "dir": ".", "id": TALK_FILE, "quarantined": quarantine(&home, now, ".", TALK_FILE) }));
            Value::Null
        }
        None => Value::Null,
    };

    let mut built: Vec<Built> = Vec::new();
    let mut id_map: HashMap<String, String> = HashMap::new(); // 옛 주소 → 새 id
    let mut taken: HashSet<String> = HashSet::new();

    // ★R2 D10 — 옛 주소가 겹치면 **먼저 온 것이 이긴다**. R1은 `insert`라 뒤에 오는
    // 추가 채팅/talk가 매핑을 덮어써 `hold.key`·`btwOf`가 남의 채팅으로 갔다.
    macro_rules! map_id {
        ($old:expr, $new:expr) => {{
            let old: String = $old;
            let new: String = $new;
            match id_map.entry(old.clone()) {
                std::collections::hash_map::Entry::Occupied(e) => {
                    warnings.push(json!({ "kind": "graph_ambiguous", "old": old, "kept": e.get(), "ignored": new }));
                }
                std::collections::hash_map::Entry::Vacant(e) => {
                    e.insert(new);
                }
            }
        }};
    }

    // ── 2. 일반 채팅 (id 유지) ──────────────────────────────────────────────
    for (id, rec) in &chats {
        built.push(build_chat(id, rec, Source::Chat, &g));
        map_id!(id.clone(), id.clone());
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
            // ★R2 D11 — 결정론 id가 이미 쓰였으면(일반 채팅 id가 `ma-<sid>-<i>` 모양)
            // 파일이 덮이고 `index.order`에 중복 id가 남았다. 한 줄로 닫는다.
            let new_id = uniquify(format!("ma-{sid}-{i}"), &taken, &mut warnings, "panel");
            built.push(build_chat(&new_id, p, Source::Panel, &g));
            map_id!(format!("{sid}::{i}"), new_id.clone());
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
        let new_id = if taken.contains(id) {
            warnings.push(json!({ "kind": "id_collision", "old": id, "new": format!("sc-{id}") }));
            uniquify(format!("sc-{id}"), &taken, &mut warnings, "session")
        } else {
            id.clone()
        };
        built.push(build_chat(&new_id, rec, Source::SessionChat, &g));
        map_id!(id.clone(), new_id.clone());
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
        let new_id = if taken.contains(&id) {
            warnings.push(json!({ "kind": "id_collision", "old": id, "new": format!("talk-{id}") }));
            uniquify(format!("talk-{id}"), &taken, &mut warnings, "talk")
        } else {
            id.clone()
        };
        built.push(build_chat(&new_id, rec, Source::Talk, &g));
        map_id!(id.clone(), new_id.clone());
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

    // ── 재마이그레이션 보존 규칙 (★R2 D3 — "안내 카드"가 데이터 파괴 버튼이 되지 않게) ──
    //
    // `chats-v3`가 이미 서 있으면(=마이그레이션 완료 마커) 그건 **3.0이 그 뒤로 계속 쓴
    // 살림**이다. 소스(2.6.2 시점에서 얼어 있는 옛 디렉터리)로 덮으면 그 사이에 쌓인
    // 제목·메시지가 통째로 되감긴다. 그래서 **이미 있는 레코드는 소스가 절대 덮지 않는다** —
    // 재마이그레이션은 "2.6.2에서 *새로* 만든 대화만 데려오는" 연산이다.
    let v3_dir = home.join(crate::chats_v3::DIR);
    let already_migrated = crate::read_home_json(&format!("{}/index.json", crate::chats_v3::DIR))
        .and_then(|v| v.get("migratedAt").cloned())
        .is_some();
    let existing_v3: HashSet<String> = if already_migrated {
        std::fs::read_dir(&v3_dir)
            .map(|it| {
                it.flatten()
                    .filter_map(|e| {
                        let n = e.file_name().to_string_lossy().to_string();
                        if !n.ends_with(".json") || n == "index.json" || n == "status.json" {
                            return None;
                        }
                        Some(n.trim_end_matches(".json").to_string())
                    })
                    .collect()
            })
            .unwrap_or_default()
    } else {
        HashSet::new()
    };

    // 재실행(재마이그레이션)에서 3.0이 만든 채팅은 보존한다 — 소스가 만든 id는 소스가 이긴다
    let mut carried: Vec<String> = Vec::new();
    if let Some(prev) = crate::read_home_json(&format!("{}/index.json", crate::chats_v3::DIR)) {
        let pe = vec![];
        for id in prev.get("order").and_then(Value::as_array).unwrap_or(&pe) {
            let Some(id) = id.as_str() else { continue };
            if taken.contains(id) {
                continue;
            }
            let src = v3_dir.join(format!("{id}.json"));
            if std::fs::copy(&src, staged_chats.join(format!("{id}.json"))).is_ok() {
                carried.push(id.to_string());
            }
        }
    }

    let mut statuses: BTreeMap<String, Value> = BTreeMap::new();
    let mut msg_total = 0usize;
    let mut kept_v3 = 0usize;
    for item in &built {
        // D3 — 이미 chats-v3에 있는 레코드는 **그대로 옮긴다**(소스로 덮지 않는다)
        if existing_v3.contains(&item.id)
            && std::fs::copy(v3_dir.join(format!("{}.json", item.id)), staged_chats.join(format!("{}.json", item.id))).is_ok()
        {
            kept_v3 += 1;
            warnings.push(json!({ "kind": "kept_v3_record", "id": item.id }));
            let kept = read_json(&staged_chats.join(format!("{}.json", item.id))).unwrap_or(Value::Null);
            msg_total += msg_count(&kept);
            let mut lite = crate::status::empty_lite(&item.id);
            if let Some(o) = lite.as_object_mut() {
                o.insert("status".into(), kept.get("status").cloned().unwrap_or(json!(item.status)));
                o.insert("queued".into(), json!(kept.get("queue").and_then(Value::as_array).map(|a| a.len()).unwrap_or(0)));
                o.insert(
                    "hold".into(),
                    match kept.get("hold") {
                        Some(h) if h.is_object() => json!({ "resetAt": h.get("resetsAt").cloned().unwrap_or(Value::Null), "ready": false }),
                        _ => Value::Null,
                    },
                );
                o.insert("updatedAt".into(), kept.get("updatedAt").cloned().unwrap_or(json!(0)));
            }
            statuses.insert(item.id.clone(), lite);
            continue;
        }
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

    // 재마이그레이션이면 이전 인덱스의 활성 선택·세대(D13)를 그대로 이어받는다
    let prev_index = crate::read_home_json(&format!("{}/index.json", crate::chats_v3::DIR));
    let active_gen = prev_index.as_ref().and_then(|p| p.get("activeGen").and_then(Value::as_u64)).unwrap_or(0);
    let active_chat_id = match prev_index.as_ref().and_then(|p| p.get("activeChatId").and_then(Value::as_str)) {
        Some(prev) if active_gen > 0 && !prev.is_empty() => prev.to_string(),
        _ => active_chat_id,
    };
    let index = json!({
        "version": 1,
        "order": full_order,
        "activeChatId": active_chat_id,
        "activeGen": active_gen,
        "migratedFrom": "2.6.2",
        "migratedAt": now as f64,
        // ★R2 D8 — 완료 마커. `is_migrated()`는 이 표식 **+ boards/index.json**을 함께 본다.
        "migrationComplete": true,
    });
    let _ = std::fs::write(staged_chats.join("index.json"), serde_json::to_string(&index).unwrap_or_default());
    let _ = std::fs::write(
        staged_chats.join("status.json"),
        serde_json::to_string(&json!({ "version": 1, "statuses": statuses.clone().into_iter().collect::<Map<_, _>>() }))
            .unwrap_or_default(),
    );

    // D3는 보드에도 그대로 적용된다 — 재마이그레이션이 3.0에서 바꾼 **자리 배치**를
    // 2.6.2 시점으로 되감으면 안 된다(패널이 다른 채팅을 가리키면 대화가 남의 자리로 간다).
    //
    // ★M10 R2 §5 — 크리틱이 두 상태를 갈라 실측해서 이 블록의 구조적 결함을 잡았다.
    //
    //   S1  마커 없는 홈 + 3.0 `boards/b-mine.json`  → **덮였다**(파일 소멸, 경고조차 없음)
    //   S2  마커 있는 홈 + `boards/index.json`만 소실 → **안 살아남았다**(`kept_v3_board` 반증)
    //
    // S2가 진짜 발견이다. `is_migrated()`는 `migratedAt` ∧ `boards/index.json`을 보므로
    // **재마이그레이션이 도는 유일한 조건이 그 인덱스의 부재**인데, 3.0 보드를 넘기는
    // 목록을 만드는 원천이 바로 그 없는 인덱스였다 — carry-forward가 필요한 유일한
    // 상황에서 carry-forward의 입력이 없다. 그래서 원천을 **디렉터리 스캔**으로 바꾼다.
    //
    // S1은 마커를 안 본다. 마커가 없다는 것은 "이 홈은 아직 2.6.2다"라는 뜻이지
    // "`boards/`의 파일은 쓰레기다"라는 뜻이 아니고, 커밋이 디렉터리 통째 스왑이라
    // 목록에 없는 파일은 백업 없이 사라진다. 사용자가 3.0에서 만든 보드는 **어느 상태
    // 에서든** 데려온다. 다만 같은 id가 소스에도 있으면(예: `default`) 소스가 이긴다 —
    // 방금 마이그레이션한 새 채팅이 자리에 앉아야 하기 때문이다. 그 경우에만
    // `clobbered_v3_board`를 남긴다(그리고 `.old-*` 한 세대가 실제 복구 경로다).
    let boards_dir = home.join(crate::boards::DIR);
    let v3_board_ids = scan_board_ids(&boards_dir);
    let mut kept_boards = 0usize;
    for bd in &all_boards {
        let id = s(bd, "id");
        if v3_board_ids.contains(&id) {
            if already_migrated
                && std::fs::copy(boards_dir.join(format!("{id}.json")), staged_boards.join(format!("{id}.json"))).is_ok()
            {
                kept_boards += 1;
                warnings.push(json!({ "kind": "kept_v3_board", "id": id }));
                continue;
            }
            if !already_migrated {
                // 소스가 이긴다 — 그러나 **말은 한다**. R1은 여기서 경고조차 없었다.
                warnings.push(json!({ "kind": "clobbered_v3_board", "id": id, "recoverAt": format!("{}.old-{now}", crate::boards::DIR) }));
            }
        }
        let _ = std::fs::write(staged_boards.join(format!("{id}.json")), serde_json::to_string(bd).unwrap_or_default());
    }
    // 3.0에서 만든 보드(소스에 없는 id)도 그대로 옮긴다 — 목록의 원천은 **파일**이다.
    let mut board_order = board_order;
    let prev_boards_index = crate::read_home_json(&format!("{}/index.json", crate::boards::DIR));
    {
        // 인덱스가 있으면 그 순서를 먼저 쓰고(사용자가 정한 순서), 인덱스에 없는 파일은
        // 이름순으로 뒤에 붙인다. 인덱스는 **순서의 힌트**일 뿐 목록의 원천이 아니다.
        let pe = vec![];
        let hinted: Vec<String> = prev_boards_index
            .as_ref()
            .and_then(|p| p.get("order").and_then(Value::as_array))
            .unwrap_or(&pe)
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect();
        let rest = v3_board_ids.iter().filter(|id| !hinted.contains(id)).cloned().collect::<Vec<_>>();
        for id in hinted.into_iter().chain(rest) {
            if board_order.iter().any(|b| *b == id) || !v3_board_ids.contains(&id) {
                continue;
            }
            if std::fs::copy(boards_dir.join(format!("{id}.json")), staged_boards.join(format!("{id}.json"))).is_ok() {
                board_order.push(id.to_string());
                warnings.push(json!({ "kind": "carried_v3_board", "id": id }));
            }
        }
    }
    let active_board_id = match prev_boards_index.as_ref().and_then(|p| p.get("activeBoardId").and_then(Value::as_str)) {
        Some(prev) if already_migrated && board_order.iter().any(|b| b == prev) => prev.to_string(),
        _ => active_board_id,
    };
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
            // D3 — 소스가 덮지 않고 3.0 사본을 그대로 옮긴 레코드 수(재마이그레이션에서만 >0)
            "keptV3": kept_v3,
            "keptV3Boards": kept_boards,
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
    let name = dst.file_name().unwrap_or_default().to_string_lossy().to_string();
    let old = dst.with_file_name(format!("{name}.old-{now}"));
    // ★M10 R2 §5-2 — **지난 세대를 먼저 치우고, 이번 세대는 남긴다.**
    //
    // R1은 성공 직후 `.old-*`를 즉시 지웠다. 커밋이 디렉터리 통째 스왑이라 스테이징
    // 목록에 없던 파일은 백업 없이 사라졌고, 크리틱의 S1·S2가 정확히 그 모양이었다
    // (사용자가 3.0에서 만든 보드 전부 소실 + 자리 배치 되감김). 한 세대만 남기면
    // 두 상태 다 손으로 복구할 수 있고, 무한히 쌓이지도 않는다.
    prune_old_generations(dst, &name);
    if dst.exists() && std::fs::rename(dst, &old).is_err() {
        return false;
    }
    if std::fs::rename(tmp, dst).is_err() {
        // 되돌린다 — 실패해도 스테이징은 남으므로 데이터가 사라지지 않는다
        let _ = std::fs::rename(&old, dst);
        return false;
    }
    true
}

/// `<name>.old-*` 형제들을 지운다(이번 커밋이 만들 세대는 아직 없다 = 정확히 1세대 유지).
fn prune_old_generations(dst: &Path, name: &str) {
    let Some(parent) = dst.parent() else { return };
    let prefix = format!("{name}.old-");
    let Ok(it) = std::fs::read_dir(parent) else { return };
    for e in it.flatten() {
        let n = e.file_name().to_string_lossy().to_string();
        if n.starts_with(&prefix) {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

/// `boards/`에 **실제로 있는 보드 파일**의 id 목록(정렬).
///
/// 인덱스를 안 읽는 것이 요점이다 — 재마이그레이션이 도는 유일한 조건이 그 인덱스의
/// 부재이므로(§5), 인덱스를 신뢰하면 필요한 순간에 목록이 비어 있다.
fn scan_board_ids(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir)
        .map(|it| {
            it.flatten()
                .filter_map(|e| {
                    let n = e.file_name().to_string_lossy().to_string();
                    if !n.ends_with(".json") || n == "index.json" || !e.path().is_file() {
                        return None;
                    }
                    // 파일이 실제로 보드인가(id가 있는 객체) — 쓰레기를 자리 목록에 못 올린다.
                    let v = read_json(&e.path())?;
                    v.get("id").and_then(Value::as_str).is_some().then(|| n.trim_end_matches(".json").to_string())
                })
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
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

    // ── ★R2 ────────────────────────────────────────────────────────────────
    use crate::testkit::{seed_262, snap, temp_home};

    fn warn_kinds(r: &Value) -> Vec<String> {
        r["warnings"]
            .as_array()
            .map(|a| a.iter().filter_map(|w| w["kind"].as_str().map(str::to_string)).collect())
            .unwrap_or_default()
    }

    #[test]
    fn remigration_never_overwrites_a_record_that_3_0_kept_writing() {
        let h = temp_home("mig-remig");
        seed_262(&h);
        assert_eq!(migrate(false)["ok"], true);
        // 3.0에서 그 채팅을 계속 썼다 — 제목이 바뀌고 메시지가 늘었다
        let mut rec = h.read_json("chats-v3/c-1.json").unwrap();
        rec["title"] = json!("3.0에서 바꾼 제목");
        rec["snapshot"]["messages"].as_array_mut().unwrap().push(json!({ "id": "new", "role": "user", "text": "3.0" }));
        let want = rec.clone();
        h.write("chats-v3/c-1.json", &rec.to_string());
        crate::chats_v3::invalidate();

        // 사용자가 "다시 가져올까요?" 카드를 눌렀다
        let again = migrate(false);
        assert_eq!(again["ok"], true);
        assert_eq!(h.read_json("chats-v3/c-1.json").unwrap(), want, "재마이그레이션이 3.0의 변경을 2.6.2 시점으로 덮었다");
        assert!(again["counts"]["keptV3"].as_u64().unwrap() > 0);
        assert!(warn_kinds(&again).contains(&"kept_v3_record".to_string()));
    }

    #[test]
    fn remigration_still_brings_in_a_chat_created_in_2_6_2_afterwards() {
        let h = temp_home("mig-remig-new");
        seed_262(&h);
        assert_eq!(migrate(false)["ok"], true);
        // 그 뒤 2.6.2로 되돌아가 새 대화를 하나 만들었다
        h.write(
            "chats/c-late.json",
            &json!({ "id": "c-late", "title": "2.6.2에서 나중에", "picker": {}, "manualCwd": "", "snapshot": snap(2, "s-late") }).to_string(),
        );
        h.write("chats/index.json", r#"{"version":1,"order":["c-1","c-2","c-late"],"activeChatId":"c-1"}"#);
        crate::chats_v3::invalidate();
        assert_eq!(migrate(false)["ok"], true);
        assert!(h.path("chats-v3/c-late.json").is_file(), "재마이그레이션이 새 대화를 안 데려왔다");
    }

    #[test]
    fn a_torn_commit_is_not_read_as_complete() {
        let h = temp_home("mig-torn");
        seed_262(&h);
        assert_eq!(migrate(false)["ok"], true);
        assert!(is_migrated());
        std::fs::remove_dir_all(h.path("boards")).unwrap(); // rename 둘 사이에서 죽은 것과 같은 상태
        assert!(!is_migrated(), "보드가 없는데 '완료'로 읽었다 = 다시는 마이그레이션 안 한다");
        assert_eq!(ensure_migrated()["ok"], true, "재시도가 보드를 되세워야 한다");
        assert!(h.path("boards/index.json").is_file());
    }

    #[test]
    fn unreadable_sources_are_reported_and_quarantined_not_dropped_in_silence() {
        let h = temp_home("mig-unreadable");
        seed_262(&h);
        h.write("chats/c-2.json", "{\"id\":\"c-2\",\"snap"); // 잘린 원본
        let r = migrate(false);
        assert_eq!(r["ok"], true);
        let kinds = warn_kinds(&r);
        assert!(kinds.contains(&"unreadable_source".to_string()), "조용히 버렸다: {kinds:?}");
        let stamp = r["migratedAt"].as_f64().unwrap() as u128;
        assert!(h.path(&format!("quarantine/{stamp}/chats/c-2.json")).is_file(), "격리 보관이 없다");
    }

    #[test]
    fn files_the_index_forgot_are_migrated_with_a_warning() {
        let h = temp_home("mig-orphan");
        seed_262(&h);
        h.write(
            "chats/c-orphan.json",
            &json!({ "id": "c-orphan", "title": "인덱스가 모르는 대화", "picker": {}, "manualCwd": "", "snapshot": snap(6, "s-orph") }).to_string(),
        );
        let r = migrate(false);
        assert!(h.path("chats-v3/c-orphan.json").is_file(), "인덱스 밖 파일이 조용히 사라졌다");
        assert!(warn_kinds(&r).contains(&"not_in_index".to_string()));
    }

    #[test]
    fn a_broken_source_index_does_not_lose_the_whole_directory() {
        let h = temp_home("mig-brokenidx");
        seed_262(&h);
        h.write("chats/index.json", "{\"order\":[\"c-1\"");
        let r = migrate(false);
        assert_eq!(r["counts"]["chats"], 2, "인덱스가 깨지자 본채팅이 통째로 미이관됐다");
        assert!(warn_kinds(&r).contains(&"unreadable_index".to_string()));
    }

    #[test]
    fn duplicate_ids_keep_the_first_mapping_so_hold_and_btw_stay_put() {
        let h = temp_home("mig-dup");
        seed_262(&h);
        h.write(
            "ui-prefs.json",
            &json!({ "workspace.mode": "multi", "limitResume.hold": { "key": "c-1", "engine": "claude", "resetsAt": 2_000_000_000_000i64, "at": stamp() as f64, "lastPrompt": "이어서" } })
                .to_string(),
        );
        // 추가 채팅이 본채팅과 같은 id를 들고 있다
        h.write(
            "session-chats/c-1.json",
            &json!({ "id": "c-1", "title": "중복 id 추가 채팅", "status": "done", "cwd": "", "snapshot": snap(2, "s-dup") }).to_string(),
        );
        h.write(
            "session-chats/w-2.json",
            &json!({ "id": "w-2", "title": "btw 자식", "status": "done", "cwd": "", "snapshot": snap(2, "s-w2"), "btwOf": "c-1" }).to_string(),
        );
        h.write("session-chats/index.json", r#"{"version":1,"order":["c-1","w-1","w-2"]}"#);
        let r = migrate(false);
        assert_eq!(r["ok"], true);
        assert!(h.path("chats-v3/sc-c-1.json").is_file(), "중복 id 추가 채팅이 사라졌다");
        assert!(h.read_json("chats-v3/c-1.json").unwrap().get("hold").is_some(), "hold가 남의 채팅으로 갔다");
        assert_eq!(h.read_json("chats-v3/w-2.json").unwrap()["btwOf"], "c-1", "btw 간선이 오배선됐다");
        assert!(warn_kinds(&r).contains(&"graph_ambiguous".to_string()));
    }

    #[test]
    fn a_chat_id_shaped_like_a_panel_id_does_not_overwrite_the_panel() {
        let h = temp_home("mig-panelid");
        seed_262(&h);
        h.write(
            "chats/ma-sess-A-0.json",
            &json!({ "id": "ma-sess-A-0", "title": "패널 id를 쓴 본채팅", "picker": {}, "manualCwd": "", "snapshot": snap(11, "s-clash") }).to_string(),
        );
        h.write("chats/index.json", r#"{"version":1,"order":["c-1","c-2","ma-sess-A-0"],"activeChatId":"c-1"}"#);
        let r = migrate(false);
        assert_eq!(r["ok"], true);
        assert_eq!(h.read_json("chats-v3/ma-sess-A-0.json").unwrap()["title"], "패널 id를 쓴 본채팅");
        assert_eq!(h.read_json("chats-v3/ma-sess-A-0-b.json").unwrap()["title"], "P0", "패널이 덮였다");
        let order: Vec<String> =
            h.read_json("chats-v3/index.json").unwrap()["order"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
        let uniq: HashSet<&String> = order.iter().collect();
        assert_eq!(order.len(), uniq.len(), "index.order에 중복 id가 남았다: {order:?}");
    }

    #[test]
    fn a_damaged_global_pref_is_salvaged_instead_of_flipping_every_chat() {
        let h = temp_home("mig-prefs");
        seed_262(&h);
        let good = r#"{"workspace.mode":"multi","api.mode":true,"claude.outputStyle":"Explanatory"}"#;
        h.write("ui-prefs.json", &good[..good.len() - 3]); // 꼬리만 잘린 JSON
        let r = migrate(false);
        assert_eq!(h.read_json("chats-v3/c-1.json").unwrap()["identity"]["billing"]["kind"], "api_key", "손상 pref가 전 채팅을 구독으로 뒤집었다");
        assert!(warn_kinds(&r).contains(&"globals_unreadable".to_string()));
    }

    #[test]
    fn the_frozen_status_lands_in_the_record_not_only_in_the_cache() {
        let h = temp_home("mig-status");
        seed_262(&h);
        assert_eq!(migrate(false)["ok"], true);
        assert_eq!(h.read_json("chats-v3/w-1.json").unwrap()["status"], "done");
        // 파생 캐시를 지워도 재구성된다(§4.3 규약 5)
        std::fs::remove_file(h.path("chats-v3/status.json")).unwrap();
        crate::status::forget();
        crate::chats_v3::invalidate();
        let st = crate::chats_v3::boot_statuses();
        assert_eq!(st["w-1"]["status"], "done", "status.json이 없으면 얼린 done이 풀린다");
    }

    // ── ★M10 R2 §5 — boards/ 덮어쓰기 두 상태 ───────────────────────────────

    /// 사용자가 3.0에서 `board:save`로 만든 그 모양.
    fn plant_board(h: &crate::testkit::Home, id: &str, title: &str, with_index: bool) {
        if with_index {
            h.write(&format!("{}/index.json", crate::boards::DIR), &json!({ "version": 1, "order": [id], "activeBoardId": id }).to_string());
        }
        h.write(
            &format!("{}/{id}.json", crate::boards::DIR),
            &json!({ "id": id, "title": title, "custom": true, "count": 2, "chrome": "grid",
                     "order": [0,1,2,3,4,5], "slots": ["c-1", "c-2", null, null, null, null], "updatedAt": 7 })
                .to_string(),
        );
        crate::boards::invalidate();
    }

    fn board_ids(h: &crate::testkit::Home) -> Vec<String> {
        h.read_json(&format!("{}/index.json", crate::boards::DIR))
            .and_then(|v| v["order"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()))
            .unwrap_or_default()
    }

    /// **S1** — 마커 없는 홈(=아직 2.6.2)인데 3.0 `boards/`가 있다. R1은 통째로 덮었고
    /// 경고조차 없었다(크리틱 §5). 마커가 없다는 것은 "이 홈은 아직 2.6.2다"라는 뜻이지
    /// "boards/의 파일은 쓰레기다"라는 뜻이 아니다.
    #[test]
    fn a_3_0_board_survives_a_first_migration_of_an_unmarked_home() {
        let h = temp_home("mig-board-s1");
        seed_262(&h);
        plant_board(&h, "b-mine", "내가 만든 보드", true);
        let r = migrate(false);
        assert_eq!(r["ok"], true);
        assert!(h.path("boards/b-mine.json").is_file(), "3.0 보드 파일이 사라졌다");
        assert!(board_ids(&h).contains(&"b-mine".to_string()), "자리 목록에서 사라졌다: {:?}", board_ids(&h));
        assert_eq!(h.read_json("boards/b-mine.json").unwrap()["title"], "내가 만든 보드");
        assert!(warn_kinds(&r).contains(&"carried_v3_board".to_string()));
        // 소스가 만드는 `default`는 여전히 새로 선다 — 방금 옮긴 채팅이 자리에 앉아야 한다.
        assert!(h.path("boards/default.json").is_file());
    }

    /// **S1-충돌** — 3.0 보드의 id가 소스에도 있으면(예: `default`) 소스가 이긴다.
    /// 그때는 **말은 한다**: R1은 여기서 경고조차 없어 사용자가 소실을 알 길이 없었다.
    #[test]
    fn a_clobbered_v3_board_is_named_and_recoverable() {
        let h = temp_home("mig-board-clobber");
        seed_262(&h);
        plant_board(&h, "default", "내 기본 보드", true);
        let r = migrate(false);
        assert_eq!(r["ok"], true);
        let kinds = warn_kinds(&r);
        assert!(kinds.contains(&"clobbered_v3_board".to_string()), "덮으면서 아무 말도 안 했다: {kinds:?}");
        // 그리고 **한 세대가 남는다** — 손으로 되살릴 수 있다.
        let olds: Vec<String> = std::fs::read_dir(&h.dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with("boards.old-"))
            .collect();
        assert_eq!(olds.len(), 1, "백업 세대가 {olds:?}");
        let back: Value =
            serde_json::from_str(&std::fs::read_to_string(h.dir.join(&olds[0]).join("default.json")).unwrap()).unwrap();
        assert_eq!(back["title"], "내 기본 보드", "백업에 원본이 없다");
    }

    /// **S2** — 이미 마이그레이션된 홈에서 `boards/index.json`만 사라진 찢긴 커밋.
    ///
    /// 이게 진짜 발견이었다: `is_migrated()`가 그 인덱스를 보므로 **재마이그레이션이 도는
    /// 유일한 조건이 인덱스의 부재**인데, 3.0 보드를 넘기는 목록의 원천이 바로 그 없는
    /// 인덱스였다. carry-forward가 필요한 유일한 상황에서 입력이 없다.
    #[test]
    fn a_torn_boards_index_does_not_take_the_3_0_boards_with_it() {
        let h = temp_home("mig-board-s2");
        seed_262(&h);
        assert_eq!(migrate(false)["ok"], true);
        // 3.0에서 보드를 하나 만들었다(인덱스에도 올렸다).
        plant_board(&h, "b-mine", "내가 만든 보드", false);
        let mut idx = h.read_json("boards/index.json").unwrap();
        idx["order"].as_array_mut().unwrap().push(json!("b-mine"));
        h.write("boards/index.json", &idx.to_string());
        crate::boards::invalidate();
        assert!(is_migrated(), "전제: 이 홈은 이미 마이그레이션됐다");

        // 찢긴 커밋 — 인덱스만 사라진다(파일은 남는다).
        std::fs::remove_file(h.path("boards/index.json")).unwrap();
        crate::boards::invalidate();
        assert!(!is_migrated(), "전제: 인덱스가 없으면 재마이그레이션이 돈다");

        let r = migrate(false);
        assert_eq!(r["ok"], true);
        assert!(h.path("boards/b-mine.json").is_file(), "3.0에서 만든 보드가 소실됐다");
        assert!(board_ids(&h).contains(&"b-mine".to_string()), "자리 목록: {:?}", board_ids(&h));
        assert_eq!(h.read_json("boards/b-mine.json").unwrap()["slots"][0], "c-1", "자리 배치가 되감겼다");
    }

    /// 백업은 **한 세대**다 — 무한히 쌓이면 홈이 부푼다.
    #[test]
    fn old_generations_never_pile_up() {
        let h = temp_home("mig-board-gen");
        seed_262(&h);
        for _ in 0..3 {
            assert_eq!(migrate(false)["ok"], true);
        }
        for dir in ["chats-v3", "boards"] {
            let n = std::fs::read_dir(&h.dir)
                .unwrap()
                .flatten()
                .filter(|e| e.file_name().to_string_lossy().starts_with(&format!("{dir}.old-")))
                .count();
            assert_eq!(n, 1, "{dir}의 백업 세대가 {n}개");
        }
    }
}
