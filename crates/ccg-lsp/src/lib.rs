//! ccg-lsp — 코드 인텔리전스(뷰어의 색칠·호버·정의 이동·자동완성).
//!
//! **확장점은 하나뿐이다: [`spec::ServerSpec`] 한 항목 = 언어 하나.**
//! 엔진(`server.rs`/`manager.rs`)에는 언어 이름이 나오지 않는다 — 2.6.2가 3107줄짜리
//! 매니저 본문에 Roslyn/clangd/Verse 특례를 흩뿌려 두었던 자리를, 스펙의 **데이터**로 옮겼다.
//! 어떤 함정이 어떤 필드가 됐는지는 `spec.rs` 머리의 표에 있다.
//!
//! 이 파일은 IPC가 그대로 직렬화해 보낼 수 있는 **계약면 모양의 JSON**만 돌려준다
//! (`src/shared/protocol.ts`의 `Lsp*` 타입들이 원본이고 여기가 미러다).
//! 실패는 전부 안전값(`unsupported`·`null`·빈 목록)으로 떨어진다 — **어떤 화면도
//! 크래시하지 않는다**가 3.0의 계약이다.

pub mod cppdb;
pub mod install;
pub mod jobkill;
pub mod launch;
pub mod manager;
pub mod rpc;
pub mod semcache;
pub mod server;
pub mod sha1;
pub mod sha256;
pub mod spec;
pub mod zombie;

use semcache::SemanticTokens;
use serde_json::{json, Value};
use server::{Server, Status};
use spec::{Provision, ServerSpec};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

/// 기능 요청이 서버의 `ready`를 기다리는 최대 시간. 넘으면 안전값으로 떨어진다 —
/// 렌더러는 status 폴링으로 ready를 따로 보고 있으므로 여기서 오래 매달릴 이유가 없다.
const READY_WAIT: Duration = Duration::from_millis(1500);

/// 파일 경로 해석 — 상대 경로는 cwd 기준. cwd도 rel도 비면 `None`.
fn resolve(cwd: &str, rel: &str) -> Option<PathBuf> {
    if rel.is_empty() {
        return None;
    }
    let p = Path::new(rel);
    let abs = if p.is_absolute() { p.to_path_buf() } else { Path::new(cwd).join(p) };
    Some(normalize(&abs))
}

/// `.`/`..`를 접는다(존재하지 않는 경로도 처리해야 해서 canonicalize를 못 쓴다).
/// 서버 레지스트리 키는 이보다 강한 [`manager::canon_root`]를 쓴다(C-3).
pub(crate) fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn spec_and_root(cwd: &str, rel: &str) -> Option<(&'static ServerSpec, PathBuf, PathBuf)> {
    let abs = resolve(cwd, rel)?;
    let spec = spec::spec_for_path(&abs)?;
    let root = manager::root_of(spec, &abs, Path::new(cwd));
    Some((spec, abs, root))
}

/// ready까지 기다린 서버(아니면 `None`) — 기능 호출의 공통 앞단.
fn ready_server(cwd: &str, rel: &str) -> Option<(Arc<Server>, PathBuf)> {
    let (spec, abs, root) = spec_and_root(cwd, rel)?;
    let s = manager::ensure(spec, &root).ok()?;
    if !s.wait_ready(READY_WAIT) {
        return None;
    }
    s.touch();
    Some((s, abs))
}

// ── lsp:status ───────────────────────────────────────────────────────────────
/// 파일 하나의 코드 인텔리전스 상태 — **그리고 지연 기동의 방아쇠**.
/// 렌더러는 `starting`/`installing` 동안 400ms로 폴링하고 `ready`에서 기능을 켠다.
///
/// 이 경로는 **아무것도 기다리지 않는다**: 스폰은 백그라운드로 걸고 곧바로 `starting`을
/// 돌려준다(크리틱 §3.2 — R1은 첫 status가 `CreateProcess`를 물어 +38ms였다).
/// 유휴 타이머도 여기서 되감지 않는다(C-1 ②).
pub fn status(cwd: &str, rel: &str) -> &'static str {
    let Some((spec, abs, root)) = spec_and_root(cwd, rel) else {
        return "unsupported";
    };
    // 내려받는 서버(C#/C++)가 아직 없으면 'need-install' — **'unsupported'가 아니다.**
    // 이 구분이 없으면 사용자는 "이 앱은 C#을 모른다"로 읽는다(2.6.2의 계약).
    if spec.kind == Provision::Download && server::launchable(spec, &root).is_err() {
        return if installing(spec.id) { "installing" } else { "need-install" };
    }
    // 사용자가 직접 바이너리를 대야 하는 서버(Verse) — 아직 안 댔으면 색칠만 남는다
    if spec.kind == Provision::External && server::launchable(spec, &root).is_err() {
        return "unsupported";
    }
    match manager::start(spec, &root) {
        manager::Slot::Failed(_) => "error",
        manager::Slot::Starting => "starting",
        manager::Slot::Live(s) => {
            // 상태를 물은 김에 문서를 데운다 — 뷰어가 곧 토큰을 물어볼 그 문서다.
            // `awaits_project_init` 서버는 프로젝트 로드 전에 열면 misc 워크스페이스에
            // 묶여 심볼이 안 풀리므로, 게이트가 내려간 뒤에만 연다(2.6.2와 같은 규약).
            // `warm_doc`인 이유: 편집 중이면 라이브 버퍼가 서버의 진실이고, 폴링이
            // 그걸 디스크 내용으로 되엎으면 안 된다(C-2 후단).
            if s.raw_status() == Status::Ready && s.status() == Status::Ready {
                let s2 = s.clone();
                std::thread::spawn(move || {
                    let _ = s2.warm_doc(&abs);
                });
            }
            match s.status() {
                Status::Starting => "starting",
                Status::Ready => "ready",
                Status::Error => "error",
            }
        }
    }
}

/// 내려받기가 진행 중인가 — 뷰어 칩이 `need-install`과 `installing`을 가르는 근거.
fn installing(id: &str) -> bool {
    install::is_installing(id)
}

// ── lsp:install-server · lsp:uninstall-server ────────────────────────────────
/// 설치/삭제 — 계약면(`{ ok, error? }`) 모양으로 돌려준다. **블로킹**이다(수백 MB 내려받기).
pub fn install_server(id: &str) -> Value {
    install_server_with(id, &|_pct, _line| {})
}

/// 진행률을 흘리며 설치한다 — 셸(`ipc/lsp.rs`)이 콜백을 `lsp:install-progress`로 쏜다.
/// (§R3-9 ② — R3은 "완료/실패로 한 번에 넘어간다"였다.)
pub fn install_server_with(id: &str, on: install::Progress) -> Value {
    match install::install_with(id, on) {
        Ok(()) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

/// 설정 목록에 보일 이름(진행 카드의 `label`) — 모르는 id면 그대로 돌려준다.
pub fn server_label(id: &str) -> String {
    spec::spec_by_id(id).map(|s| s.label.to_string()).unwrap_or_else(|| id.to_string())
}

pub fn uninstall_server(id: &str) -> Value {
    match install::uninstall(id) {
        Ok(()) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

/// 뷰어의 "이 언어 서버를 설치할까요?" 버튼 — 파일 경로로 어느 서버인지 정한다.
pub fn install_for_file(cwd: &str, rel: &str) -> Value {
    let Some(id) = server_id_for_file(cwd, rel) else {
        // ★HOSTI18N R2 — 셸(`ipc/lsp.rs`)의 **쌍둥이 문구**와 같이 닫는다. 그쪽은 R1이
        // 이미 감쌌고 제품 경로도 그쪽이지만(셸이 `server_id_for_file`을 직접 부른다),
        // 이 함수도 공개 API라 다른 호출자가 생기면 그대로 한국어가 나간다.
        //
        // en은 셸과 **같은 문자열**을 쓴다 — 2.6.2에 대응 원문이 없는 **3.0 전용**이라
        // 옮겨 올 곳이 없고, 같은 뜻에 두 en을 두면 화면마다 문구가 갈린다.
        return json!({ "ok": false, "error": ccg_fs::t("이 파일 형식을 맡는 서버가 없어요", "No language server handles this file type") });
    };
    install_server(&id)
}

/// 이 파일을 맡는 서버 id(없으면 `None`) — 셸이 진행률을 그 id로 쏘려고 먼저 묻는다.
pub fn server_id_for_file(cwd: &str, rel: &str) -> Option<String> {
    Some(spec::spec_for_path(&resolve(cwd, rel)?)?.id.to_string())
}

// ── lsp:project-status ───────────────────────────────────────────────────────
pub fn project_status(cwd: &str) -> Value {
    if cwd.is_empty() {
        return json!({ "state": "idle", "percent": Value::Null });
    }
    let (state, pct) = manager::project_state(&normalize(Path::new(cwd)));
    json!({ "state": state, "percent": pct })
}

// ── lsp:hover ────────────────────────────────────────────────────────────────
/// 디스크 기준 호버(편집 버퍼 없음).
pub fn hover(cwd: &str, rel: &str, line: u32, character: u32) -> Option<Value> {
    hover_at(cwd, rel, line, character, None)
}

/// 호버 — `text`는 **저장 안 된 편집 버퍼**다(계약면 `lsp.hover(cwd, rel, pos, text?)`의
/// 네 번째 인자). 편집 모드(Ctrl+E)의 `CmEditor.tsx:471`이 실제로 이걸 넘긴다.
///
/// R1은 디스패처가 이 인자를 버려서, 저장 전 편집 중 호버가 **디스크 좌표**를 읽고
/// 자신 있는 오답을 냈다(크리틱 C-2: 버퍼 적중 1/6). 2.6.2 manager.ts:1994와 같은 분기다.
pub fn hover_at(cwd: &str, rel: &str, line: u32, character: u32, text: Option<&str>) -> Option<Value> {
    let (s, abs) = ready_server(cwd, rel)?;
    let md = s.hover(&abs, line, character, text)?;
    Some(json!({ "contents": md }))
}

// ── lsp:definition ───────────────────────────────────────────────────────────
/// 디스크 기준 정의 이동(편집 버퍼 없음).
pub fn definition(cwd: &str, rel: &str, line: u32, character: u32) -> Vec<Value> {
    definition_at(cwd, rel, line, character, None)
}

/// 정의 이동 — `text`는 저장 안 된 편집 버퍼(C-2, `hover_at`과 같은 규약).
pub fn definition_at(cwd: &str, rel: &str, line: u32, character: u32, text: Option<&str>) -> Vec<Value> {
    let Some((s, abs)) = ready_server(cwd, rel) else { return Vec::new() };
    s.definition(&abs, line, character, text)
        .into_iter()
        .map(|(p, l, c)| json!({ "path": p.to_string_lossy(), "line": l, "character": c }))
        .collect()
}

// ── lsp:semantic-tokens ──────────────────────────────────────────────────────
/// 같은 토큰을 거듭 디스크에 쓰지 않게 하는 지문 메모(뷰어의 안정화 폴링은 같은 결과를
/// 최소 두 번 받아 온다). 상한 512.
static SEM_WRITES: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

pub fn semantic_tokens(cwd: &str, rel: &str) -> Option<Value> {
    let (spec, abs, root) = spec_and_root(cwd, rel)?;
    let s = manager::ensure(spec, &root).ok()?;
    if !s.wait_ready(READY_WAIT) {
        return Some(json!({ "data": [], "types": [], "mods": [] }));
    }
    s.touch();
    let tokens = s.semantic_tokens(&abs)?;
    if !tokens.data.is_empty() {
        // 서버에 동기화된 그 본문으로 캐시 키를 만든다 — 디스크 재읽기는 didOpen 뒤 파일이
        // 바뀌면 "새 내용 키에 옛 토큰"을 넣는 미스매치 여지가 있다(2.6.2 주석의 그 함정).
        if let Some(text) = s.doc_text(&server::path_to_uri(&abs)) {
            let memo_key = format!("{}|{}", spec.id, abs.to_string_lossy());
            let sig = format!("{}:{:x}:{}", tokens.data.len(), fingerprint(&tokens.data), text.len());
            let w = SEM_WRITES.get_or_init(|| Mutex::new(HashMap::new()));
            let mut m = w.lock().unwrap();
            if m.get(&memo_key) != Some(&sig) {
                if m.len() > 512 {
                    m.clear();
                }
                m.insert(memo_key, sig);
                let (cwd, id, ver) = (cwd.to_string(), spec.id, spec.cache_version);
                let abs_s = abs.to_string_lossy().to_string();
                let t = tokens.clone();
                // 디스크 쓰기는 요청 경로에서 뺀다 — 토큰 응답이 그만큼 늦어질 이유가 없다
                std::thread::spawn(move || semcache::put(&cwd, ver, id, &abs_s, &text, &t));
            }
        }
    }
    Some(to_value(&tokens))
}

fn fingerprint(data: &[u32]) -> u32 {
    data.iter().fold(0u32, |h, d| h.wrapping_mul(31).wrapping_add(*d))
}

fn to_value(t: &SemanticTokens) -> Value {
    json!({ "data": t.data, "types": t.types, "mods": t.mods })
}

// ── lsp:cached-tokens ────────────────────────────────────────────────────────
/// 디스크 캐시의 토큰 — **서버를 띄우지 않는다.** 파일을 여는 순간의 "0ms 색칠".
pub fn cached_tokens(cwd: &str, rel: &str) -> Option<Value> {
    let abs = resolve(cwd, rel)?;
    let spec = spec::spec_for_path(&abs)?;
    let content = std::fs::read_to_string(&abs).ok()?;
    let t = semcache::get(cwd, spec.cache_version, spec.id, &abs.to_string_lossy(), &content)?;
    Some(to_value(&t))
}

// ── lsp:completion ───────────────────────────────────────────────────────────
pub fn completion(cwd: &str, rel: &str, line: u32, character: u32, text: String) -> Option<Value> {
    let (s, abs) = ready_server(cwd, rel)?;
    let (raw, incomplete, gen) = s.completion(&abs, line, character, text)?;
    let items: Vec<Value> = raw.iter().enumerate().filter_map(|(i, it)| map_item(it, i)).collect();
    if items.is_empty() {
        return None;
    }
    Some(json!({ "items": items, "isIncomplete": incomplete, "gen": gen }))
}

/// 서버의 CompletionItem → 렌더러가 CM 옵션으로 만드는 납작한 모양(`LspCompletionItem`).
fn map_item(it: &Value, i: usize) -> Option<Value> {
    let label = it.get("label").and_then(Value::as_str)?;
    let doc = match it.get("documentation") {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Object(o)) => o.get("value").and_then(Value::as_str).map(str::to_string),
        _ => None,
    };
    let insert = it
        .get("textEdit")
        .and_then(|t| t.get("newText"))
        .and_then(Value::as_str)
        .or_else(|| it.get("insertText").and_then(Value::as_str))
        .unwrap_or(label);
    let mut o = json!({ "label": label, "insertText": insert, "ri": i });
    if let Some(k) = it.get("kind").and_then(Value::as_i64) {
        o["kind"] = json!(k);
    }
    if let Some(d) = it.get("detail").and_then(Value::as_str) {
        o["detail"] = json!(d);
    }
    if let Some(d) = doc.filter(|s| !s.is_empty()) {
        o["documentation"] = json!(d);
    }
    if it.get("insertTextFormat").and_then(Value::as_i64) == Some(2) {
        o["snippet"] = json!(true);
    }
    for k in ["sortText", "filterText"] {
        if let Some(v) = it.get(k).and_then(Value::as_str) {
            o[k] = json!(v);
        }
    }
    Some(o)
}

// ── lsp:completion-resolve ───────────────────────────────────────────────────
pub fn resolve_completion(cwd: &str, rel: &str, gen: i64, ri: usize) -> Option<Value> {
    let (spec, _abs, root) = spec_and_root(cwd, rel)?;
    let s = manager::ensure(spec, &root).ok()?;
    s.touch();
    let r = s.resolve_completion(gen, ri)?;
    let doc = match r.get("documentation") {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Object(o)) => o.get("value").and_then(Value::as_str).map(str::to_string),
        _ => None,
    };
    let detail = r.get("detail").and_then(Value::as_str).map(str::to_string);
    if doc.is_none() && detail.is_none() {
        return None;
    }
    let mut o = json!({});
    if let Some(d) = detail {
        o["detail"] = json!(d);
    }
    if let Some(d) = doc {
        o["documentation"] = json!(d);
    }
    Some(o)
}

// ── lsp:prewarm ──────────────────────────────────────────────────────────────
/// 프로젝트를 열 때 — 그 프로젝트의 주력 서버를 **기동 직전까지** 준비한다.
///
/// ## ★LSPIDLE R1 — 여기서 프로세스를 띄우지 않는다
///
/// R1까지 이 함수의 마지막 줄은 `manager::start(spec, &root)`였다. 그 한 줄 때문에
/// **코드 뷰어를 한 번도 열지 않아도** 언어 서버가 떠서 앱이 사는 내내 상주했다
/// (gates 태그 실측: 헬퍼 3개 · WS 115.5MB · Private 101.6MB · 유휴 프로세스 8 대 7).
/// 유휴 회수(10/30분)는 그 뒤에도 멀쩡히 돌고 있었지만, **회수는 열람한 적 있는 서버를
/// 접을 뿐 애초에 안 뜨게 하지는 못한다.** 「안 쓰는 기능이 메모리를 문다」의 본체는
/// 회수가 아니라 이 방아쇠였다.
///
/// 지금은 [`spec::Prewarm`]이 그 결정을 들고 있고, 네 언어 전부 `Prepare`다 — 하는 일은
/// 디스크·경로·캐시 준비뿐이고 기동은 **그 언어의 파일을 열 때** 일어난다
/// (`lsp:status`가 지연 스폰의 방아쇠, `lsp:warm`이 문서 예열).
///
/// **첫 열람이 그만큼 늦어지지 않는가** — 두 가지가 받친다. ① 색은 서버를 안 기다린다:
/// `lsp:cached-tokens`가 토큰 디스크 캐시에서 바로 칠한다(서버를 띄우지 않는 경로다).
/// ② 기동 자체의 앞부분(준비 훅·루트 해석·런타임/모듈 경로 사슬)은 여기서 이미 치렀다.
/// 남는 것은 `CreateProcess` + 서버 초기화뿐이고, 그 값은 `bench/lsp.mjs`의
/// 프리웜·첫 색칠 눈금으로 잰다(수치는 `docs/parity-fix-lspidle-r1.md`).
pub fn prewarm(cwd: &str) {
    if cwd.is_empty() {
        return;
    }
    let cwd_path = normalize(Path::new(cwd));
    // 원본 폴더가 사라진 프로젝트의 캐시를 회수(디스크 I/O — 백그라운드로)
    std::thread::spawn(semcache::gc_dead_buckets);
    let Some(spec) = detect_project_spec(&cwd_path) else { return };
    // ★ §R3-9 ④ — 프리웜도 **`root_for`를 거친다.** R3까지는 cwd에 그냥 띄웠고, 솔루션이
    //   하위 폴더에 있는 C# 프로젝트(그리고 CMake 하위 프로젝트)에서는 프리웜이 cwd에 한 벌,
    //   실제 파일 열기가 진짜 루트에 또 한 벌을 띄웠다(2.6.2도 같은 구조 — 유휴 회수가
    //   걷지만 30분간 한 벌이 논다). 루트 규칙에 먹일 "이 프로젝트의 파일 하나"는
    //   얕은 스캔으로 찾는다(없으면 cwd 그대로 — 그게 R3까지의 동작이다).
    let root = match first_source_file(&cwd_path, spec) {
        Some(f) => manager::root_of(spec, &f, &cwd_path),
        None => cwd_path,
    };
    match spec.prewarm {
        // 기동 없이 준비만 — 이 라운드의 본체. 못 띄우는 상태여도 그냥 준비한다
        // (`launchable` 판정은 열람 시 `status`가 `need-install`로 정직하게 말할 몫이다).
        spec::Prewarm::Prepare => manager::prepare(spec, &root),
        // R1까지의 동작. 지금 이 팔로 오는 스펙은 없다(`Prewarm::Eager` 주석 참고).
        spec::Prewarm::Eager => {
            if server::launchable(spec, &root).is_err() {
                return;
            }
            // `start`는 스폰을 백그라운드로 걸고 곧바로 돌아온다 — 여기서 스레드를 또 만들 이유가
            // 없고, 첫 `status`와 겹쳐도 자리가 하나라 **프로세스는 한 벌만** 뜬다(C-4).
            let _ = manager::start(spec, &root);
        }
    }
}

/// 이 폴더의 주력 언어를 값싼 파일 신호로 추정. 표는 각 스펙의
/// [`spec::ServerSpec::detect_markers`]에 있다(R3까지 이 파일에 하드코딩 — §R3-9 ④).
/// 못 찾으면 `None` — 프리웜을 안 할 뿐, 파일을 열면 그때 지연 스폰된다.
fn detect_project_spec(root: &Path) -> Option<&'static ServerSpec> {
    let names: Vec<String> = std::fs::read_dir(root)
        .ok()?
        .flatten()
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .collect();
    spec::detect_project_spec(&names)
}

/// 이 스펙이 맡는 소스 파일 하나 — **루트 규칙에 먹일 표본**이다(프리웜 전용).
/// 넓이 우선으로 3단까지, 항목 예산 안에서만 본다. 못 찾으면 `None`.
/// 예산을 두는 이유: 부팅 경로라 거대 모노레포에서 트리를 걷다 멈추면 안 된다.
fn first_source_file(root: &Path, spec: &ServerSpec) -> Option<PathBuf> {
    const SKIP: &[&str] =
        &["node_modules", ".git", "target", "bin", "obj", "intermediate", "binaries", "saved", "build", ".venv"];
    let mut budget = 600usize;
    let mut level = vec![root.to_path_buf()];
    for _ in 0..3 {
        let mut next: Vec<PathBuf> = Vec::new();
        for dir in level {
            let Ok(rd) = std::fs::read_dir(&dir) else { continue };
            for e in rd.flatten() {
                if budget == 0 {
                    return None;
                }
                budget -= 1;
                let p = e.path();
                let name = e.file_name().to_string_lossy().to_ascii_lowercase();
                if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    if !name.starts_with('.') && !SKIP.contains(&name.as_str()) {
                        next.push(p);
                    }
                } else if p.extension().and_then(|s| s.to_str()).and_then(|x| spec.language_id(x)).is_some() {
                    return Some(p);
                }
            }
        }
        if next.is_empty() {
            return None;
        }
        level = next;
    }
    None
}

// ── lsp:warm ─────────────────────────────────────────────────────────────────
/// 특정 파일을 미리 열어 둔다 — 타이핑 전에 색인되게.
pub fn warm(cwd: &str, rel: &str) {
    let Some((spec, abs, root)) = spec_and_root(cwd, rel) else { return };
    std::thread::spawn(move || {
        if let Ok(s) = manager::ensure(spec, &root) {
            if s.wait_ready(Duration::from_secs(30)) {
                s.touch();
                // 이미 열려 있으면 그대로 둔다(편집 버퍼를 디스크로 되엎지 않게)
                let _ = s.warm_doc(&abs);
            }
        }
    });
}

// ── lsp:servers (설정 ▸ 코드 분석) ───────────────────────────────────────────
pub fn servers() -> Vec<Value> {
    spec::SPECS
        .iter()
        .map(|s| {
            let state = match s.kind {
                Provision::Bundled => "bundled",
                Provision::Download | Provision::External => {
                    if server::launchable(s, Path::new(".")).is_ok() {
                        "installed"
                    } else {
                        "none"
                    }
                }
            };
            let mut o = json!({
                "id": s.id, "label": s.label, "langs": s.langs, "exts": s.exts_display,
                "kind": match s.kind { Provision::Bundled => "bundled", Provision::Download => "download", Provision::External => "external" },
                "state": state
            });
            // 계약면은 `requires?: string`(2.6.2) + `requiresEn?: string`(3.0 추가, 선택).
            // 옛 렌더러는 `requires`만 읽고, 3.0 설정 화면이 UI 언어에 따라 고른다(§R3-9 ⑤).
            if let Some((ko, en)) = s.requires {
                o["requires"] = json!(ko);
                o["requiresEn"] = json!(en);
            }
            o
        })
        .collect()
}

// ── 파일 변화 통지 ───────────────────────────────────────────────────────────
/// 앱을 거친 쓰기(뷰어 저장·에이전트 편집·탐색기 작업)를 **서버들에 흘리고**, 그 다음에
/// 렌더러를 깨운다. 반환 = 브로드캐스트할 `{paths, exts}`(통지된 게 없으면 `None`).
///
/// R1은 이 함수가 **브로드캐스트 페이로드 조립뿐**이었다(크리틱 C-7). 2.6.2
/// `notifyWatchedFiles`(manager.ts:2337)는 같은 자리에서 네 가지를 한다 —
/// ① `workspace/didChangeWatchedFiles` 통지 ② **열린 문서의 디스크 재동기화**
/// ③ 삭제 문서 `didClose` ④ 재프라임 예약. 그 넷은 [`server::Server::files_changed`]에 있고
/// 여기서는 팬아웃([`manager::notify_files_changed`])과 페이로드만 맡는다.
///
/// 변화의 종류(created/changed/deleted)는 호출부가 안 주므로 **존재 여부로 가른다** —
/// 없으면 삭제, 있으면 변경(LSP `FileChangeType` 3/2). created(1)와 changed(2)를 가르는
/// 서버는 우리가 아는 범위에 없다.
pub fn files_changed(paths: &[String]) -> Option<Value> {
    let abs: Vec<PathBuf> = paths.iter().map(|p| normalize(Path::new(p))).collect();
    // ①~④ — 관심 있는 서버들에 실제로 흘린다
    let notified = manager::notify_files_changed(&abs);
    let exts = broadcast_exts(&notified);
    if exts.is_empty() {
        return None;
    }
    let out: Vec<String> = notified.iter().map(|p| p.to_string_lossy().to_string()).collect();
    Some(json!({ "paths": out, "exts": exts }))
}

/// 통지된 경로들 → **다시 물어야 할 뷰어의 확장자**.
/// 프로젝트 파일(csproj/sln…)만 바뀐 경우에도 그 스펙이 맡는 소스 확장자를 실어야 .cs
/// 뷰어가 다시 칠한다 — 2.6.2가 `CS_EXTRA`로 하드코딩하던 자리를 스펙이 판단한다.
fn broadcast_exts(notified: &[PathBuf]) -> Vec<String> {
    let mut exts: Vec<String> = Vec::new();
    for p in notified {
        let Some(e) = p.extension().and_then(|s| s.to_str()) else { continue };
        let e = e.to_ascii_lowercase();
        for s in spec::SPECS.iter().filter(|s| s.watches_ext(&e)) {
            for (k, _) in s.exts {
                if !exts.iter().any(|x| x == k) {
                    exts.push((*k).to_string());
                }
            }
        }
    }
    exts
}

/// 이 파일의 서버가 **유효한 프라임을 들고 있는가**(진단·프로브 전용).
/// `Some(false)` = 재프라임이 예약돼 있다 = 멤버십/입력 변화가 관측됐다는 뜻.
/// 서버가 없거나 프라임 개념이 없는 언어면 `None`.
pub fn primed(cwd: &str, rel: &str) -> Option<bool> {
    let (spec, _abs, root) = spec_and_root(cwd, rel)?;
    if matches!(spec.reprime, spec::Reprime::None) {
        return None;
    }
    Some(manager::ensure(spec, &root).ok()?.primed())
}

/// 앱 종료 — 언어 서버를 전부 접는다.
pub fn dispose_all() {
    manager::dispose_all();
}

// ── 수명 진단(★LSPIDLE R1) ──────────────────────────────────────────────────
/// 지금 서버 수명이 어떤 상태인가 — **벤치·PoC가 읽는 눈금**이자 사람이 읽는 진단.
///
/// 프로세스 목록을 세는 것만으로는 「회수됐다」와 「애초에 안 떴다」를 못 가른다. 둘은
/// 겉보기가 같지만(헬퍼 0) 뜻이 정반대라, 이 라운드의 주장을 그 구분 없이 실측했다고
/// 말할 수 없다. 그래서 앱 안의 판정을 그대로 내보낸다.
///
/// - `live` — 지금 말이 통하는 서버 수
/// - `reclaimed` — 유휴로 접혀 비어 있는 자리 수(= 「회수됨」)
/// - `revivals` — 회수 뒤 다시 살아난 횟수(= 「투명 재기동」이 실제로 돈 횟수)
/// - `tracked` — 좀비 원장이 핸들을 들고 있는 자식 수(정상이면 `live`와 같다)
pub fn lifecycle() -> Value {
    let (reclaimed, revivals) = manager::reclaim_stats();
    json!({
        "live": manager::live_count(),
        "pids": manager::live_pids(),
        "reclaimed": reclaimed,
        "revivals": revivals,
        "tracked": zombie::tracked_count(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_extension_is_unsupported() {
        assert_eq!(status("C:\\x", "readme.md"), "unsupported");
        assert_eq!(status("C:\\x", ""), "unsupported");
    }

    #[test]
    fn resolve_joins_and_folds() {
        assert_eq!(resolve("C:\\a", "b\\..\\c.ts").unwrap(), PathBuf::from("C:\\a\\c.ts"));
        assert_eq!(resolve("C:\\a", "C:\\z\\c.ts").unwrap(), PathBuf::from("C:\\z\\c.ts"));
    }

    #[test]
    fn ts_spec_claims_the_right_extensions() {
        for e in ["ts", "TSX", "mjs", "cjs", "jsx"] {
            assert_eq!(spec::spec_for_ext(e).map(|s| s.id), Some("ts"), "{e}");
        }
        // R3에서 py·cs, R4에서 cpp가 붙었다(확장자 소유는 spec.rs 테스트가 언어별로 본다).
        for e in ["md", "verse", "rs"] {
            assert!(spec::spec_for_ext(e).is_none(), "{e} — 3.0 범위 밖이어야 한다");
        }
    }

    /// 프리웜이 루트 규칙에 먹일 표본 파일을 찾는다(§R3-9 ④). 못 찾아도 죽지 않는다.
    #[test]
    fn first_source_file_finds_a_sample_within_budget() {
        let w = std::env::temp_dir().join("ccg-lsp-firstsrc");
        let _ = std::fs::remove_dir_all(&w);
        std::fs::create_dir_all(w.join("src/App")).unwrap();
        std::fs::create_dir_all(w.join("node_modules/x")).unwrap();
        std::fs::write(w.join("node_modules/x/nope.cs"), "").unwrap();
        std::fs::write(w.join("src/App/Big.cs"), "class X {}").unwrap();
        let cs = spec::spec_by_id("cs").unwrap();
        assert_eq!(first_source_file(&w, cs), Some(w.join("src/App/Big.cs")), "node_modules를 걸러야 한다");
        let py = spec::spec_by_id("py").unwrap();
        assert_eq!(first_source_file(&w, py), None);
    }

    /// ★LSPIDLE R1 — **프리웜은 프로세스를 안 만든다.**
    ///
    /// 스펙 쪽 못(`every_shipped_spec_is_on_demand`)은 «값이 Prepare인가»를 보고, 이 못은
    /// «그 값이 실제로 지켜지는가»를 본다. 둘이 다른 이유: R1의 결함은 값이 아니라
    /// `prewarm()`의 마지막 줄이었고, 그 줄은 스펙을 보지도 않았다.
    ///
    /// 진짜 TS 프로젝트 모양(package.json)을 만들어 감지가 **걸리게** 한 뒤 부른다 —
    /// 감지가 안 걸려서 조용한 것은 이 테스트가 원하는 초록이 아니다.
    #[test]
    fn prewarm_prepares_without_spawning_a_single_process() {
        let w = std::env::temp_dir().join(format!("ccg-lsp-prewarm-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&w);
        std::fs::create_dir_all(w.join("src")).unwrap();
        std::fs::write(w.join("package.json"), "{}").unwrap();
        std::fs::write(w.join("src/a.ts"), "export const a = 1\n").unwrap();
        // 감지가 실제로 TS를 문다(안 물면 아래 0이 공짜로 나온다 — 그건 증명이 아니다)
        assert_eq!(detect_project_spec(&w).map(|s| s.id), Some("ts"), "픽스처가 TS 프로젝트로 안 읽힌다");

        let before = manager::live_count();
        prewarm(&w.to_string_lossy());
        // 스폰은 백그라운드 스레드라 «즉시 0»만으로는 부족하다 — 뜰 시간을 주고도 0이어야 한다.
        std::thread::sleep(Duration::from_millis(700));
        assert_eq!(
            manager::live_count(),
            before,
            "★프리웜이 서버를 띄웠다 — 코드 뷰어를 한 번도 안 열어도 헬퍼가 상주한다는 뜻이다"
        );
        assert_eq!(lifecycle()["live"], json!(before));
        let _ = std::fs::remove_dir_all(&w);
    }

    #[test]
    fn map_item_flattens_documentation_shapes() {
        let a = map_item(&json!({ "label": "x", "documentation": "d" }), 0).unwrap();
        assert_eq!(a["documentation"], "d");
        let b = map_item(&json!({ "label": "x", "documentation": { "kind": "markdown", "value": "m" } }), 3).unwrap();
        assert_eq!(b["documentation"], "m");
        assert_eq!(b["ri"], 3);
        // textEdit이 있으면 insertText보다 우선
        let c = map_item(&json!({ "label": "x", "insertText": "i", "textEdit": { "newText": "t" } }), 0).unwrap();
        assert_eq!(c["insertText"], "t");
        // label 없는 항목은 버린다
        assert!(map_item(&json!({ "kind": 3 }), 0).is_none());
    }

    /// 2.6.2와 같은 규약: **서버가 하나도 없으면 뷰어를 깨우지 않는다**
    /// ("갱신할 토큰도 없다" — manager.ts:2395). 이 테스트에는 뜬 서버가 없다.
    #[test]
    fn files_changed_is_silent_without_a_live_server() {
        assert!(files_changed(&["C:\\a\\x.md".into()]).is_none());
        assert!(files_changed(&["C:\\a\\x.ts".into()]).is_none());
    }

    #[test]
    fn broadcast_exts_maps_known_languages_only() {
        assert!(broadcast_exts(&[PathBuf::from("C:\\a\\y.md")]).is_empty());
        let v = broadcast_exts(&[PathBuf::from("C:\\a\\x.ts"), PathBuf::from("C:\\a\\y.md")]);
        // ts 스펙이 맡는 뷰어 확장자 전부 — .ts가 바뀌면 열린 .tsx도 다시 물어야 한다
        assert!(v.contains(&"ts".to_string()) && v.contains(&"tsx".to_string()), "{v:?}");
        assert!(!v.contains(&"md".to_string()));
    }

    #[test]
    fn servers_list_matches_settings_contract() {
        let list = servers();
        assert!(!list.is_empty());
        let ts = list.iter().find(|s| s["id"] == "ts").unwrap();
        assert_eq!(ts["kind"], "bundled");
        assert_eq!(ts["state"], "bundled");
        assert!(ts["langs"].as_str().unwrap().contains("TypeScript"));
    }
}
