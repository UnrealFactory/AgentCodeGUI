//! `RawIdentity` — 채팅 파일에 저장되는 **완전 지정** 원시 정체성(m-logic §2.2).
//!
//! 이 모듈이 소유하는 것은 **매핑 함수 하나**다(M-UX §4.2 — "매핑 함수 `toRawIdentity`가
//! 하나로 판다"). 정규화(`normalize()`)·해시·패치 병합은 **M-LOGIC 소관**(ccg-engine)이고
//! 여기엔 없다. 마이그레이션 비교의 **1차 키**가 이 객체의 정준 직렬화다(O12 수정판).
//!
//! ★ 물질화(m-logic §2.4 · M-UX §4.2 N4/X7): 전역 pref(`api.mode`·`claude.outputStyle`·
//!   MCP/Skill 토글)는 **상속되지 않는다.** 마이그레이션·채팅 생성 시점의 전역값을 읽어
//!   여기에 굳힌다. 그 뒤 전역을 바꿔도 기존 채팅은 한 글자도 안 바뀐다.
//!
//! ★ 평평한 `.model`/`.effort`/`.account` 접근은 **이 파일 안에만** 존재한다(M-UX X5).

use serde_json::{json, Map, Value};

/// 2.6.2 레코드가 어느 스토어에서 왔는가 — picker 기본값이 화면마다 달랐다.
/// (App.tsx:76 `auto` / MultiAgent.tsx:86 `bypass` / SessionWindow.tsx:66 `high`+`auto`)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// `chats/<id>.json` — 본채팅
    Chat,
    /// `multi-agent/<sid>.json.panels[i]` — 멀티 패널
    Panel,
    /// `session-chats/<id>.json` — 추가 채팅(창)
    SessionChat,
    /// `chat-talk.json` — 은퇴한 1.x 채팅 모드(폴더 없음)
    Talk,
}

impl Source {
    /// 그 화면의 `DEFAULT_PICKER` — 저장본에 필드가 없을 때 2.6.2가 실제로 쓰던 값.
    /// "저장본에 없던 필드"를 임의 기본값으로 채우면 마이그레이션이 조용히 정체성을
    /// 바꾼다 → 화면별 기본값을 그대로 옮긴다.
    fn default_picker(self) -> (&'static str, &'static str, &'static str) {
        match self {
            // model, effort, mode
            Source::Chat | Source::Talk => ("opus", "xhigh", "auto"),
            Source::Panel => ("opus", "xhigh", "bypass"),
            Source::SessionChat => ("opus", "high", "auto"),
        }
    }
}

const MODEL_IDS: [&str; 4] = ["fable", "opus", "sonnet", "haiku"];
const EFFORT_IDS: [&str; 6] = ["max", "xhigh", "high", "medium", "low", "minimal"];
const MODE_IDS: [&str; 5] = ["normal", "plan", "acceptEdits", "auto", "bypass"];
/// CLI 내장 출력 스타일 4종 — 그 외 값은 미지정(`null`)이다(`claude/engine.ts:56-60`).
const OUTPUT_STYLES: [&str; 4] = ["Concise", "Explanatory", "Learning", "Proactive"];

/// 마이그레이션·채팅 생성 시점에 굳힐 **전역값 묶음**. 읽는 자리는 하나(`read()`)뿐이다.
#[derive(Debug, Clone, Default)]
pub struct Globals {
    /// `ui-prefs.json['api.mode']` — 전역 API 과금 토글(App.tsx:180)
    pub api_mode: bool,
    /// `ui-prefs.json['claude.outputStyle']` — 내장 4종일 때만 유효
    pub output_style: Option<String>,
    /// `skills.json.disabled` — 이름별 `'disabled'`
    pub disabled_skills: Vec<String>,
    /// `mcp.json.disabled` — 차단된 서버 이름
    pub denied_mcp: Vec<String>,
    /// 전역 `ANTHROPIC_API_KEY`가 있을 때 그 키 지문에 저장된 답(`api-config.json.envKeyChoices`).
    /// 환경변수가 없으면 `false` 고정, 있는데 답이 없으면 안전값 `true`(구독) — m-logic §2.3.
    pub drop_env_key: bool,
}

impl Globals {
    /// 앱 홈의 전역 파일들에서 한 번에 읽는다.
    /// ui-prefs가 깨져 있으면 **온전한 상위 쌍까지 건져 쓴다**(D14 — 조용한 값 뒤집기 방지).
    pub fn read() -> Self {
        Self::from_prefs(&crate::prefs::read_ui_prefs_salvaged().0)
    }

    /// 이미 읽어 둔 ui-prefs 블롭에서 만든다(마이그레이션이 손상 표식을 함께 쓰려고 분리).
    pub fn from_prefs(prefs: &Value) -> Self {
        let api_mode = prefs.get("api.mode").and_then(Value::as_bool).unwrap_or(false);
        let output_style = prefs
            .get("claude.outputStyle")
            .and_then(Value::as_str)
            .filter(|v| OUTPUT_STYLES.contains(v))
            .map(str::to_string);
        let mut disabled_skills = read_disabled_list("skills.json");
        disabled_skills.sort();
        disabled_skills.dedup();
        let mut denied_mcp = read_disabled_list("mcp.json");
        denied_mcp.sort();
        denied_mcp.dedup();
        Self { api_mode, output_style, disabled_skills, denied_mcp, drop_env_key: env_drop_key() }
    }
}

fn read_disabled_list(file: &str) -> Vec<String> {
    crate::read_home_json(file)
        .and_then(|v| v.get("disabled").cloned())
        .and_then(|v| v.as_array().cloned())
        .map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

/// 전역 `ANTHROPIC_API_KEY` + 그 지문에 저장된 사용자 답 → `dropEnvKey`.
fn env_drop_key() -> bool {
    let Ok(key) = std::env::var("ANTHROPIC_API_KEY") else { return false };
    if key.is_empty() {
        return false;
    }
    match crate::api_config::env_key_choice(&key) {
        Some(c) => c == "sub",
        None => true, // 미응답 → 안전값(구독으로 돌린다 = env 키를 걷어낸다)
    }
}

fn pick<'a>(picker: &'a Value, key: &str) -> Option<&'a str> {
    picker.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// **2.6.2 레코드 → `RawIdentity`.** M-UX §4.2 매핑표의 유일한 구현.
///
/// | 2.6.2 | RawIdentity |
/// |---|---|
/// | `manualCwd`(본채팅) / `cwd`(패널·추가 채팅) | `cwd` |
/// | `refDirs` | `addDirs` |
/// | `picker.engine` | `engine.kind` |
/// | `picker.model` / `picker.codexModel` | `engine.model` |
/// | `picker.effort` | `engine.effort` |
/// | `picker.codexAccount` | `engine.codexAccount` |
/// | `picker.codexTier` | `engine.codexTier` (Codex·값 있을 때만 — 없으면 키도 없다) |
/// | `picker.account` + `api.mode`(또는 패널 `api`) | `billing` |
/// | `picker.mode` | `mode` |
/// | 전역 `claude.outputStyle` | `outputStyle` (물질화) |
/// | 전역 MCP/Skill | `tools` (물질화) |
///
/// `systemPrompt`는 2.6.2에 채팅별 필드가 없다 → 항상 `null`.
pub fn to_raw_identity(rec: &Value, source: Source, g: &Globals) -> Value {
    let picker = rec.get("picker").cloned().unwrap_or(Value::Null);
    let (d_model, d_effort, d_mode) = source.default_picker();

    let is_codex = pick(&picker, "engine") == Some("codex");
    let model = if is_codex {
        // Codex 모델 id 공간은 열려 있다(app-server가 목록을 준다) → 화이트리스트 없음.
        pick(&picker, "codexModel").unwrap_or("").to_string()
    } else {
        pick(&picker, "model").filter(|m| MODEL_IDS.contains(m)).unwrap_or(d_model).to_string()
    };
    let effort = pick(&picker, "effort").filter(|e| EFFORT_IDS.contains(e)).unwrap_or(d_effort).to_string();
    let mode = pick(&picker, "mode").filter(|m| MODE_IDS.contains(m)).unwrap_or(d_mode).to_string();

    let mut engine = Map::new();
    engine.insert("kind".into(), json!(if is_codex { "codex" } else { "claude" }));
    engine.insert("model".into(), json!(model));
    engine.insert("effort".into(), json!(effort));
    engine.insert(
        "codexAccount".into(),
        match pick(&picker, "codexAccount") {
            Some(a) if is_codex => json!(a),
            _ => Value::Null,
        },
    );
    // ★2026-09-05 — 속도 티어. 값이 있을 때만 키를 둔다(옛 레코드·Claude의 원시값이 그대로라
    // 마이그레이션 무손실 비교가 안 흔들린다). `"default"`는 표준 = 없음.
    if let Some(t) = pick(&picker, "codexTier").filter(|t| is_codex && !t.is_empty() && *t != "default") {
        engine.insert("codexTier".into(), json!(t));
    }

    // 과금 — 멀티 패널은 패널별 `api`가 이기고, 나머지는 그 시점 전역값(§4.2 표)
    let api = match source {
        Source::Panel => rec.get("api").and_then(Value::as_bool).unwrap_or(g.api_mode),
        _ => g.api_mode,
    };
    let mut billing = Map::new();
    if api {
        // ApiKey 변형엔 계정 개념이 없다. `keyFp`는 **원시 정체성에 없다** —
        // 정규화가 저장된 키에서 계산한다(키 원문이 계약면에 오르지 않는다).
        billing.insert("kind".into(), json!("api_key"));
    } else {
        billing.insert("kind".into(), json!("subscription"));
        billing.insert(
            "account".into(),
            match pick(&picker, "account") {
                Some(a) => json!(a),
                None => Value::Null, // null = 기본 계정(정규화가 실 이메일로 채운다)
            },
        );
        billing.insert("dropEnvKey".into(), json!(g.drop_env_key));
    }

    let mut skill_overrides = Map::new();
    for name in &g.disabled_skills {
        skill_overrides.insert(name.clone(), json!("disabled"));
    }

    let cwd = match source {
        Source::Chat => rec.get("manualCwd").and_then(Value::as_str).unwrap_or(""),
        Source::Talk => "", // 순수 대화엔 폴더가 없었다(App.tsx:571 파리티)
        _ => rec.get("cwd").and_then(Value::as_str).unwrap_or(""),
    };
    let add_dirs: Vec<String> = rec
        .get("refDirs")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|s| s.as_str()).filter(|s| !s.is_empty()).take(8).map(str::to_string).collect())
        .unwrap_or_default();

    json!({
        "engine": Value::Object(engine),
        "billing": Value::Object(billing),
        "cwd": cwd,
        "addDirs": add_dirs,
        "mode": mode,
        "systemPrompt": Value::Null,
        "outputStyle": match &g.output_style { Some(s) => json!(s), None => Value::Null },
        "tools": { "skillOverrides": Value::Object(skill_overrides), "deniedMcp": g.denied_mcp.clone() },
    })
}

/// **역투영 — `RawIdentity` → 2.6.2 레코드의 평평한 필드들.**
/// 과도기 별칭 계층 전용(§6.2 "옛 블롭 모양 재조립"). 얼려 둔 2.6.2 렌더러는 `picker`·
/// `manualCwd`·`refDirs`·`api`를 읽으므로, 통합 스토어를 그 모양으로 되그려 준다.
///
/// **알려진 손실 하나**: `engine.kind === 'codex'`면 2.6.2 `picker.model`(클로드 모델)이
/// 정체성 축에 없다 → 기본값 `opus`로 채운다. 실행에는 영향이 없지만(코덱스 실행은
/// `codexModel`을 쓴다) "코덱스에서 클로드로 되돌리면 모델이 opus로 보인다"가 남는다.
pub fn to_legacy(identity: &Value, source: Source) -> Map<String, Value> {
    let engine = identity.get("engine").cloned().unwrap_or(Value::Null);
    let billing = identity.get("billing").cloned().unwrap_or(Value::Null);
    let is_codex = engine.get("kind").and_then(Value::as_str) == Some("codex");
    let (d_model, d_effort, d_mode) = source.default_picker();

    let mut picker = Map::new();
    picker.insert(
        "model".into(),
        json!(if is_codex { d_model } else { engine.get("model").and_then(Value::as_str).unwrap_or(d_model) }),
    );
    picker.insert("effort".into(), json!(engine.get("effort").and_then(Value::as_str).unwrap_or(d_effort)));
    picker.insert("mode".into(), json!(identity.get("mode").and_then(Value::as_str).unwrap_or(d_mode)));
    if is_codex {
        picker.insert("engine".into(), json!("codex"));
        picker.insert("codexModel".into(), json!(engine.get("model").and_then(Value::as_str).unwrap_or("")));
        if let Some(a) = engine.get("codexAccount").and_then(Value::as_str) {
            picker.insert("codexAccount".into(), json!(a));
        }
        if let Some(t) = engine.get("codexTier").and_then(Value::as_str).filter(|t| !t.is_empty()) {
            picker.insert("codexTier".into(), json!(t));
        }
    }
    let api = billing.get("kind").and_then(Value::as_str) == Some("api_key");
    if !api {
        if let Some(a) = billing.get("account").and_then(Value::as_str) {
            picker.insert("account".into(), json!(a));
        }
    }

    let mut out = Map::new();
    let cwd = identity.get("cwd").and_then(Value::as_str).unwrap_or("");
    out.insert(if source == Source::Chat { "manualCwd".into() } else { "cwd".into() }, json!(cwd));
    out.insert("refDirs".into(), identity.get("addDirs").cloned().unwrap_or(json!([])));
    out.insert("picker".into(), Value::Object(picker));
    if source == Source::Panel {
        out.insert("api".into(), json!(api));
    }
    out
}

/// 새 채팅의 기본 정체성 — 전역값을 굳힌다(m-logic §2.4 규약 2, `origin: 'default'`).
pub fn default_raw_identity(g: &Globals) -> Value {
    to_raw_identity(&json!({}), Source::Chat, g)
}

/// 정준 직렬화 — **마이그레이션 1차 비교 키**(O12 수정판)의 바이트.
/// 키 정렬 + null 유지. blake3는 M-LOGIC(ccg-engine) 소관이라 여기선 **바이트 자체**를
/// 돌려준다(PoC가 바이트를 그대로 비교한다 — 해시보다 강하고 어긋난 리프를 짚어준다).
pub fn canon_bytes(v: &Value) -> String {
    let mut out = String::new();
    canon_into(v, &mut out);
    out
}

fn canon_into(v: &Value, out: &mut String) {
    match v {
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(k).unwrap_or_default());
                out.push(':');
                canon_into(&m[*k], out);
            }
            out.push('}');
        }
        Value::Array(a) => {
            out.push('[');
            for (i, e) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                canon_into(e, out);
            }
            out.push(']');
        }
        other => out.push_str(&serde_json::to_string(other).unwrap_or_default()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn g() -> Globals {
        Globals {
            api_mode: false,
            output_style: Some("Concise".into()),
            disabled_skills: vec!["b".into(), "a".into()],
            denied_mcp: vec!["z".into()],
            drop_env_key: false,
        }
    }

    #[test]
    fn chat_record_maps_every_axis() {
        let rec = json!({
            "manualCwd": "C:\\Code\\x",
            "refDirs": ["C:\\Code\\y"],
            "picker": { "model": "fable", "effort": "max", "mode": "plan", "account": "a@b.c" }
        });
        let raw = to_raw_identity(&rec, Source::Chat, &g());
        assert_eq!(raw["engine"]["kind"], "claude");
        assert_eq!(raw["engine"]["model"], "fable");
        assert_eq!(raw["engine"]["effort"], "max");
        assert_eq!(raw["engine"]["codexAccount"], Value::Null);
        assert_eq!(raw["billing"]["kind"], "subscription");
        assert_eq!(raw["billing"]["account"], "a@b.c");
        assert_eq!(raw["billing"]["dropEnvKey"], false);
        assert_eq!(raw["cwd"], "C:\\Code\\x");
        assert_eq!(raw["addDirs"][0], "C:\\Code\\y");
        assert_eq!(raw["mode"], "plan");
        assert_eq!(raw["systemPrompt"], Value::Null);
        assert_eq!(raw["outputStyle"], "Concise");
        assert_eq!(raw["tools"]["deniedMcp"][0], "z");
    }

    #[test]
    fn missing_picker_falls_back_to_that_screens_default() {
        let raw = to_raw_identity(&json!({}), Source::Panel, &g());
        assert_eq!(raw["engine"]["model"], "opus");
        assert_eq!(raw["engine"]["effort"], "xhigh");
        assert_eq!(raw["mode"], "bypass"); // 멀티 패널의 DEFAULT_PICKER
        let raw = to_raw_identity(&json!({}), Source::SessionChat, &g());
        assert_eq!(raw["engine"]["effort"], "high"); // 추가 채팅의 DEFAULT_PICKER
        assert_eq!(raw["mode"], "auto");
    }

    #[test]
    fn panel_api_flag_beats_the_global_toggle() {
        let mut gg = g();
        gg.api_mode = false;
        let raw = to_raw_identity(&json!({ "api": true }), Source::Panel, &gg);
        assert_eq!(raw["billing"]["kind"], "api_key");
        // api_key 변형엔 계정이 없다 — 타입으로 표현된다
        assert!(raw["billing"].get("account").is_none());
        // 본채팅은 전역값을 굳힌다
        gg.api_mode = true;
        let raw = to_raw_identity(&json!({}), Source::Chat, &gg);
        assert_eq!(raw["billing"]["kind"], "api_key");
    }

    #[test]
    fn codex_axis_lives_inside_the_codex_variant() {
        let rec = json!({ "picker": { "engine": "codex", "codexModel": "gpt-5.6-sol", "codexAccount": "o@p.q", "model": "opus" } });
        let raw = to_raw_identity(&rec, Source::Chat, &g());
        assert_eq!(raw["engine"]["kind"], "codex");
        assert_eq!(raw["engine"]["model"], "gpt-5.6-sol"); // claude model이 새어 들어오지 않는다
        assert_eq!(raw["engine"]["codexAccount"], "o@p.q");
        // ★2026-09-05 — 티어를 안 골랐으면 키 자체가 없다(옛 원시값과 동일).
        assert!(raw["engine"].get("codexTier").is_none(), "티어 미지정인데 키가 생겼다: {raw}");
    }

    /// ★2026-09-05 — 속도 티어(Fast)는 picker ↔ engine을 왕복하고, 표준(`default`)은 키를 남기지 않는다.
    #[test]
    fn codex_speed_tier_round_trips_and_default_leaves_no_key() {
        let rec = json!({ "picker": { "engine": "codex", "codexModel": "gpt-6-astra", "codexTier": "priority" } });
        let raw = to_raw_identity(&rec, Source::Chat, &g());
        assert_eq!(raw["engine"]["codexTier"], "priority");
        let back = to_legacy(&raw, Source::Chat);
        assert_eq!(back["picker"]["codexTier"], "priority", "되접기에서 티어가 사라졌다: {back:?}");

        let std = to_raw_identity(&json!({ "picker": { "engine": "codex", "codexModel": "gpt-6-astra", "codexTier": "default" } }), Source::Chat, &g());
        assert!(std["engine"].get("codexTier").is_none(), "표준(default)인데 키가 남았다: {std}");
        let claude = to_raw_identity(&json!({ "picker": { "engine": "claude", "model": "opus", "codexTier": "priority" } }), Source::Chat, &g());
        assert!(claude["engine"].get("codexTier").is_none(), "Claude 정체성에 Codex 티어가 새어 들어왔다: {claude}");
    }

    #[test]
    fn canon_sorts_keys_but_keeps_array_order() {
        let a = json!({ "b": 1, "a": [2, 1] });
        let b = json!({ "a": [2, 1], "b": 1 });
        assert_eq!(canon_bytes(&a), canon_bytes(&b));
        assert_eq!(canon_bytes(&a), r#"{"a":[2,1],"b":1}"#);
        assert_ne!(canon_bytes(&json!([1, 2])), canon_bytes(&json!([2, 1])));
    }
}
