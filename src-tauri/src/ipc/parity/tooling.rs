//! MCP 서버 · 스킬 목록과 on/off — `mcp:list`·`mcp:set-enabled`·`skill:list`·
//! `skill:set-enabled` (최종 파리티 감사 R1 §3.2 **H2**).
//!
//! 감사 실측: `.mcp.json`(서버 1개) + `.claude/skills/bench-skill`을 심은 스크래치
//! 프로젝트에서 **2.6.2 = 1건/1건, 3.0 = 0건/0건**. 설정 ▸ MCP/Skill은 늘 「없습니다」였고
//! 토글은 아무것도 저장하지 않았다.
//!
//! 원본은 동결 구역의 `src/main/mcp.ts`·`src/main/skills.ts`다. 그 두 파일이 하는 일은
//! **디스크 스캔 + 앱 홈의 끔 목록**뿐이라 그대로 옮겼다 — 규약 셋이 중요하다:
//!
//! 1. **끔 목록은 앱 홈에 산다**(`mcp.json`·`skills.json`). 사용자의 `~/.claude.json`·
//!    `~/.claude/skills`는 **절대 고쳐 쓰지 않는다** — 앱에서 토글했다고 클로드 코드
//!    자체의 설정이 바뀌면 CLI를 직접 쓸 때까지 영향을 준다.
//! 2. **조상 폴더까지 훑는다**(`.mcp.json`·`.claude/skills`). 엔진이 그렇게 읽기 때문이다 —
//!    레포 하위 폴더를 열어도 루트의 설정이 보여야 목록이 실제 실행과 일치한다.
//!    이름이 겹치면 **가까운 쪽이 이긴다**.
//! 3. 정렬은 이름 사전순, 동률이면 출처 순위(user → project → local / global → local).
//!
//! ## M9의 채팅별 칩과는 **별개로 산다**
//!
//! `chat:tooling-get`(M9)은 실행 중인 CLI가 `system/init`으로 말해 준 것을 보여 준다 —
//! "지금 이 턴에 실제로 붙은 것". 이쪽은 **설정 화면**이라 실행 없이 디스크만 본다.
//! 둘이 다른 값을 낼 수 있는 게 정상이다(연결 실패한 서버는 저쪽에만 상태가 뜬다).

use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

// ── 끔 목록 (앱 홈) ─────────────────────────────────────────────────────────

fn disabled_set(file: &str) -> BTreeSet<String> {
    ccg_store::read_home_json(file)
        .and_then(|v| v.get("disabled").and_then(Value::as_array).cloned())
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default()
}

/// 2.6.2와 같은 모양·같은 정렬(`JSON.stringify({disabled: [...].sort()}, null, 2)`).
/// 들여쓰기 2칸까지 맞추는 이유: 사용자가 이 파일을 손으로 여는 일이 있고, 두 앱을
/// 오가며 쓰는 동안 diff가 통째로 뒤집히지 않게.
fn write_disabled(file: &str, set: &BTreeSet<String>) {
    let list: Vec<Value> = set.iter().map(|s| json!(s)).collect();
    let text = serde_json::to_string_pretty(&json!({ "disabled": list })).unwrap_or_default();
    let _ = ccg_store::write_home_file(file, &text);
}

fn set_enabled(file: &str, name: &str, enabled: bool) -> Value {
    if name.is_empty() {
        return Value::Null;
    }
    let mut set = disabled_set(file);
    if enabled {
        set.remove(name);
    } else {
        set.insert(name.to_string());
    }
    write_disabled(file, &set);
    Value::Null
}

// ── 폴더 사슬 ───────────────────────────────────────────────────────────────

/// `cwd`와 그 **모든 조상**(가까운 순). 2.6.2 `src/main/paths.ts ancestorDirs`의 자리.
fn ancestor_dirs(cwd: &str) -> Vec<PathBuf> {
    let mut out = vec![];
    let mut p: Option<&Path> = Some(Path::new(cwd));
    while let Some(d) = p {
        if d.as_os_str().is_empty() {
            break;
        }
        out.push(d.to_path_buf());
        p = d.parent();
    }
    out
}

/// 경로 비교용 정규화(구분자·대소문자·꼬리 슬래시) — 2.6.2 `norm`과 같은 규칙.
fn norm(p: &str) -> String {
    let mut s = p.replace('\\', "/").to_lowercase();
    while s.len() > 1 && s.ends_with('/') {
        s.pop();
    }
    s
}

fn read_json_file(p: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()
}

fn home_dir() -> PathBuf {
    // 2.6.2는 `os.homedir()`를 본다 — **앱 홈(CCG_HOME)이 아니다.** 클로드 코드가 자기
    // 설정을 두는 자리라서다. 격리 홈으로 띄운 하네스에서도 같은 값을 봐야 실측이 성립한다.
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_default()
}

// ── MCP ─────────────────────────────────────────────────────────────────────

const MCP_DISABLED: &str = "mcp.json";

/// 서버 설정 → (전송 방식, 한 줄 요약). 2.6.2 `describe`.
fn describe(cfg: &Value) -> (&'static str, String) {
    if let Some(c) = cfg.as_object() {
        if let Some(cmd) = c.get("command").and_then(Value::as_str) {
            let args = c
                .get("args")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" "))
                .unwrap_or_default();
            return ("stdio", format!("{cmd} {args}").trim().to_string());
        }
        if let Some(url) = c.get("url").and_then(Value::as_str) {
            let t = if c.get("type").and_then(Value::as_str) == Some("sse") { "sse" } else { "http" };
            return (t, url.to_string());
        }
    }
    ("unknown", String::new())
}

fn collect_mcp(servers: Option<&Value>, origin: &str, disabled: &BTreeSet<String>, out: &mut Vec<Value>) {
    let Some(map) = servers.and_then(Value::as_object) else { return };
    for (name, cfg) in map {
        let (transport, detail) = describe(cfg);
        out.push(json!({
            "name": name,
            // 2.6.2: user만 '전역', project·local은 둘 다 'local' 칸에 그린다.
            "scope": if origin == "user" { "global" } else { "local" },
            "origin": origin,
            "transport": transport,
            "detail": detail,
            "enabled": !disabled.contains(name),
        }));
    }
}

/// `~/.claude.json`의 `projects[dir]`에서 이 폴더(또는 조상)의 항목을 찾는다.
/// **서버가 실제로 있는** 가장 가까운 항목이 이긴다 — 2.6.2 `findProjectEntry`.
fn find_project_entry<'a>(projects: Option<&'a Value>, cwd: &str) -> Option<&'a Value> {
    let map = projects?.as_object()?;
    for dir in ancestor_dirs(cwd) {
        let key = norm(&dir.to_string_lossy());
        for (k, v) in map {
            if norm(k) != key {
                continue;
            }
            let n = v
                .get("mcpServers")
                .and_then(Value::as_object)
                .map(|m| m.len())
                .unwrap_or(0);
            if n > 0 {
                return Some(v);
            }
        }
    }
    None
}

fn origin_rank(o: &str) -> u8 {
    match o {
        "user" => 0,
        "project" => 1,
        _ => 2,
    }
}

pub fn mcp_list(cwd: &str) -> Value {
    let disabled = disabled_set(MCP_DISABLED);
    let mut out: Vec<Value> = vec![];

    let user_cfg = read_json_file(&home_dir().join(".claude.json"));
    if let Some(cfg) = &user_cfg {
        collect_mcp(cfg.get("mcpServers"), "user", &disabled, &mut out);
        if let Some(entry) = find_project_entry(cfg.get("projects"), cwd) {
            collect_mcp(entry.get("mcpServers"), "local", &disabled, &mut out);
        }
    }

    if !cwd.trim().is_empty() {
        // `.mcp.json`은 cwd와 **모든 조상**에서 읽는다(엔진이 그렇게 읽는다).
        // 이름이 겹치면 가까운 쪽이 이긴다 = 이미 본 이름은 건너뛴다.
        let mut seen: BTreeSet<String> = BTreeSet::new();
        for dir in ancestor_dirs(cwd) {
            let Some(proj) = read_json_file(&dir.join(".mcp.json")) else { continue };
            let Some(map) = proj.get("mcpServers").and_then(Value::as_object) else { continue };
            let mut fresh = serde_json::Map::new();
            for (name, cfg) in map {
                if seen.insert(name.clone()) {
                    fresh.insert(name.clone(), cfg.clone());
                }
            }
            collect_mcp(Some(&Value::Object(fresh)), "project", &disabled, &mut out);
        }
    }

    out.sort_by(|a, b| {
        let (na, nb) = (a["name"].as_str().unwrap_or(""), b["name"].as_str().unwrap_or(""));
        na.cmp(nb).then_with(|| {
            origin_rank(a["origin"].as_str().unwrap_or("")).cmp(&origin_rank(b["origin"].as_str().unwrap_or("")))
        })
    });
    Value::Array(out)
}

pub fn mcp_set_enabled(name: &str, enabled: bool) -> Value {
    set_enabled(MCP_DISABLED, name, enabled)
}

// ── Skills ──────────────────────────────────────────────────────────────────

const SKILL_DISABLED: &str = "skills.json";

/// `SKILL.md` 머리의 `---` 프론트매터에서 `name`·`description`만. YAML 파서를 들이지
/// 않는 이유는 2.6.2와 같다 — 필요한 게 둘뿐이다. **첫 등장이 이긴다.**
fn parse_frontmatter(text: &str) -> (Option<String>, Option<String>) {
    let body = text.strip_prefix('\u{feff}').unwrap_or(text);
    if !body.starts_with("---") {
        return (None, None);
    }
    let after = &body[3..];
    let after = after.strip_prefix('\r').unwrap_or(after);
    let Some(after) = after.strip_prefix('\n') else { return (None, None) };
    // 닫는 `---`는 **줄 처음**에 있어야 한다(본문 안의 `---`가 아니라).
    let mut end = None;
    let mut at = 0usize;
    for line in after.split_inclusive('\n') {
        if line.trim_end_matches(['\r', '\n']) == "---" {
            end = Some(at);
            break;
        }
        at += line.len();
    }
    let Some(end) = end else { return (None, None) };
    let (mut name, mut desc) = (None, None);
    for line in after[..end].split('\n') {
        let line = line.trim_end_matches('\r');
        let Some((k, v)) = line.split_once(':') else { continue };
        let k = k.trim();
        if k.is_empty() || !k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
            continue;
        }
        let mut v = v.trim().to_string();
        // 따옴표 한 겹만 벗긴다(2.6.2와 같음).
        if v.len() >= 2
            && ((v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\'')))
        {
            v = v[1..v.len() - 1].to_string();
        }
        match k {
            "name" if name.is_none() => name = Some(v),
            "description" if desc.is_none() => desc = Some(v),
            _ => {}
        }
    }
    (name, desc)
}

/// 한 스코프의 폴더 — `SKILL.md`를 가진 하위 폴더 하나가 스킬 하나다.
fn discover(dir: &Path, scope: &str, disabled: &BTreeSet<String>) -> Vec<Value> {
    let Ok(rd) = std::fs::read_dir(dir) else { return vec![] };
    let mut out = vec![];
    for e in rd.flatten() {
        if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let file = e.path().join("SKILL.md");
        let Ok(raw) = std::fs::read_to_string(&file) else { continue };
        let (fm_name, fm_desc) = parse_frontmatter(&raw);
        let folder = e.file_name().to_string_lossy().to_string();
        // 프론트매터 이름이 있으면 그것, 없으면 폴더 이름.
        let name = fm_name
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or(folder);
        out.push(json!({
            "name": name,
            "description": fm_desc.map(|d| d.trim().to_string()).unwrap_or_default(),
            "scope": scope,
            "path": file.to_string_lossy().to_string(),
            "enabled": !disabled.contains(&name),
        }));
    }
    // 2.6.2는 `readdirSync` 순서(플랫폼 정렬)에 기댔다. 여기서 이름순으로 못 박아 둔다 —
    // 최종 정렬이 어차피 이름순이고, 그 전 단계가 불안정하면 `seen` 우선순위가 흔들린다.
    out.sort_by(|a, b| a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")));
    out
}

pub fn skill_list(cwd: &str) -> Value {
    let disabled = disabled_set(SKILL_DISABLED);
    let global_dir = home_dir().join(".claude").join("skills");
    let mut out = discover(&global_dir, "global", &disabled);

    if !cwd.trim().is_empty() {
        let global_key = norm(&global_dir.to_string_lossy());
        let mut seen: BTreeSet<String> = BTreeSet::new();
        for dir in ancestor_dirs(cwd) {
            let sd = dir.join(".claude").join("skills");
            // `~/.claude/skills` 자신은 이미 global로 실렸다 — 두 번 세지 않는다.
            if norm(&sd.to_string_lossy()) == global_key {
                continue;
            }
            for s in discover(&sd, "local", &disabled) {
                let name = s["name"].as_str().unwrap_or("").to_string();
                if seen.insert(name) {
                    out.push(s);
                }
            }
        }
    }

    out.sort_by(|a, b| {
        let (na, nb) = (a["name"].as_str().unwrap_or(""), b["name"].as_str().unwrap_or(""));
        na.cmp(nb).then_with(|| {
            let rank = |v: &Value| u8::from(v["scope"].as_str().unwrap_or("") != "global");
            rank(a).cmp(&rank(b))
        })
    });
    Value::Array(out)
}

pub fn skill_set_enabled(name: &str, enabled: bool) -> Value {
    set_enabled(SKILL_DISABLED, name, enabled)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(p: &Path, s: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, s).unwrap();
    }

    /// 조상 폴더의 `.mcp.json`이 보이고, **가까운 쪽이 이긴다**.
    /// (레포 루트에 서버를 등록하고 하위 폴더를 여는 것이 실사용의 기본형이다.)
    #[test]
    fn project_servers_are_read_from_every_ancestor_and_the_nearest_wins() {
        let h = ccg_store::testhome::take("parity-mcp-anc");
        let root = h.dir.join("proj");
        let sub = root.join("src").join("deep");
        std::fs::create_dir_all(&sub).unwrap();
        write(
            &root.join(".mcp.json"),
            r#"{"mcpServers":{"shared":{"command":"node","args":["a.js"]},"only-root":{"url":"https://x/y"}}}"#,
        );
        write(
            &root.join("src").join(".mcp.json"),
            r#"{"mcpServers":{"shared":{"command":"deno","args":["b.ts"]}}}"#,
        );
        let v = mcp_list(&sub.to_string_lossy());
        let a = v.as_array().unwrap();
        assert_eq!(a.len(), 2, "조상 사슬을 안 훑었다: {v}");
        let shared = a.iter().find(|s| s["name"] == "shared").unwrap();
        assert_eq!(shared["detail"], "deno b.ts", "먼 쪽이 이겼다 — 실행이 보는 것과 목록이 갈린다");
        assert_eq!(shared["transport"], "stdio");
        let root_only = a.iter().find(|s| s["name"] == "only-root").unwrap();
        assert_eq!(root_only["transport"], "http");
        assert_eq!(root_only["detail"], "https://x/y");
        assert_eq!(root_only["enabled"], json!(true));
    }

    /// 토글은 **앱 홈**에 남고 목록에 즉시 반영된다(사용자 `~/.claude.json`은 불가침).
    #[test]
    fn toggling_writes_to_the_app_home_and_shows_up_in_the_list() {
        let h = ccg_store::testhome::take("parity-mcp-toggle");
        let root = h.dir.join("p2");
        std::fs::create_dir_all(&root).unwrap();
        write(&root.join(".mcp.json"), r#"{"mcpServers":{"srv":{"command":"node"}}}"#);
        mcp_set_enabled("srv", false);
        let v = mcp_list(&root.to_string_lossy());
        assert_eq!(v[0]["enabled"], json!(false), "끈 서버가 켜진 채로 나온다");
        let saved = ccg_store::read_home_json("mcp.json").expect("끔 목록이 앱 홈에 안 남았다");
        assert_eq!(saved["disabled"], json!(["srv"]));
        mcp_set_enabled("srv", true);
        assert_eq!(mcp_list(&root.to_string_lossy())[0]["enabled"], json!(true));
        assert_eq!(
            ccg_store::read_home_json("mcp.json").unwrap()["disabled"],
            json!([]),
            "되켠 뒤에도 끔 목록에 남아 있다"
        );
    }

    /// 스킬 = `SKILL.md`를 가진 하위 폴더. 이름은 프론트매터 우선, 없으면 폴더 이름.
    #[test]
    fn a_skill_is_a_folder_with_a_skill_md_and_frontmatter_names_it() {
        let h = ccg_store::testhome::take("parity-skill-scan");
        let root = h.dir.join("p3");
        let sk = root.join(".claude").join("skills");
        write(
            &sk.join("named").join("SKILL.md"),
            "---\nname: 진짜이름\ndescription: \"따옴표 벗김\"\n---\n본문",
        );
        write(&sk.join("bare").join("SKILL.md"), "프론트매터 없음");
        // SKILL.md 없는 폴더는 스킬이 아니다.
        std::fs::create_dir_all(sk.join("notaskill")).unwrap();
        let v = skill_list(&root.to_string_lossy());
        let a = v.as_array().unwrap();
        assert_eq!(a.len(), 2, "스킬 판정이 어긋났다: {v}");
        let bare = a.iter().find(|s| s["name"] == "bare").unwrap();
        assert_eq!(bare["description"], "");
        assert_eq!(bare["scope"], "local");
        let named = a.iter().find(|s| s["name"] == "진짜이름").unwrap();
        assert_eq!(named["description"], "따옴표 벗김");
        assert!(named["path"].as_str().unwrap().ends_with("SKILL.md"));
    }

    /// 프론트매터 파서 회귀 — 본문 안의 `---`에 속지 않고, 첫 등장이 이긴다.
    #[test]
    fn the_frontmatter_reader_stops_at_the_closing_fence() {
        let (n, d) = parse_frontmatter("---\nname: a\nname: b\ndescription: d1\n---\nname: c\n---\n");
        assert_eq!(n.as_deref(), Some("a"), "첫 등장이 이겨야 한다");
        assert_eq!(d.as_deref(), Some("d1"));
        assert_eq!(parse_frontmatter("no fence").0, None);
        // BOM이 있어도 읽힌다(2.6.2가 명시적으로 벗기는 자리).
        assert_eq!(parse_frontmatter("\u{feff}---\nname: bom\n---\n").0.as_deref(), Some("bom"));
    }

    /// 끈 스킬은 `enabled:false`로 **남는다**(목록에서 사라지지 않는다 — 되켤 수 있어야 한다).
    #[test]
    fn a_disabled_skill_stays_in_the_list() {
        let h = ccg_store::testhome::take("parity-skill-toggle");
        let root = h.dir.join("p4");
        write(&root.join(".claude").join("skills").join("s1").join("SKILL.md"), "---\nname: s1\n---\n");
        skill_set_enabled("s1", false);
        let v = skill_list(&root.to_string_lossy());
        assert_eq!(v.as_array().unwrap().len(), 1, "끈 스킬이 목록에서 사라졌다");
        assert_eq!(v[0]["enabled"], json!(false));
        assert_eq!(ccg_store::read_home_json("skills.json").unwrap()["disabled"], json!(["s1"]));
    }
}
