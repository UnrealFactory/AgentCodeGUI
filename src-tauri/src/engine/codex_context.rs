//! App-owned per-model context settings; the user's config.toml is never edited.
use ccg_engine::codex::{CodexPlan, ContextOverrides};
use ccg_fs::t;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, io, sync::{Arc, Mutex}};

const FILE: &str = "codex-context.json";
const ASTRA: &str = "gpt-6-astra";
static SAVE: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Tokens { pub context_window: u64, pub compact_token_limit: u64 }
impl Tokens {
    fn recommended() -> Self { Self { context_window: 512000, compact_token_limit: 430000 } }
    fn validate(&self) -> Result<(), String> {
        if self.context_window > 0 && self.context_window <= 2_147_483_647
            && self.compact_token_limit > 0 && self.compact_token_limit < self.context_window { Ok(()) }
        else { Err(t("양의 정수를 입력하고 압축 기준을 컨텍스트 크기보다 작게 설정하세요.", "Use positive integers with compaction below the context window.")) }
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Preset { #[default] Default, Recommended, Custom }
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    #[serde(default)] pub management: bool,
    #[serde(default)] pub preset: Preset,
    #[serde(default)] pub models: BTreeMap<String, Tokens>,
    pub fallback: Option<Tokens>,
}
impl Settings {
    fn validate(&self) -> Result<(), String> {
        for (id, value) in &self.models {
            if id.is_empty() || id.len() > 256 { return Err(t("모델 이름이 올바르지 않아요.", "The model name is invalid.")); }
            value.validate()?;
        }
        if let Some(value) = &self.fallback { value.validate()?; }
        match self.preset {
            Preset::Default if !self.models.is_empty() || self.fallback.is_some() => Err(t("기본값에서는 모델별 숫자를 지정할 수 없어요.", "The Default preset cannot include per-model overrides.")),
            Preset::Recommended if self.fallback.is_some() || self.models.len() != 1 || self.models.get(ASTRA) != Some(&Tokens::recommended()) => Err(t("추천값은 Astra 512000 / 430000, 다른 모델은 기본값이에요.", "Recommended uses 512000 / 430000 for Astra and defaults for other models.")),
            _ => Ok(()),
        }
    }
    fn overrides(&self, plan: &CodexPlan) -> ContextOverrides {
        let value = self.models.get(&plan.model).or(self.fallback.as_ref());
        ContextOverrides {
            management: if self.management && plan.api_mode { None } else { Some(self.management) },
            window: value.map(|v| v.context_window), compact: value.map(|v| v.compact_token_limit),
        }
    }
}

fn decode(value: Value) -> Result<Settings, String> {
    let settings = if value.get("scope").is_some() || value.get("contextWindow").is_some() {
        // Keep old saved behavior. Global overrides become a legacy fallback;
        // choosing any new preset clears it and uses explicit per-model values.
        let mut s = Settings { management: value["management"].as_bool().unwrap_or(false), ..Default::default() };
        if value["preset"] != "default" {
            if let (Some(w), Some(c)) = (value["contextWindow"].as_u64(), value["compactTokenLimit"].as_u64()) {
                let tokens = Tokens { context_window: w, compact_token_limit: c };
                let astra = value["scope"] == "astra" || (value["scope"].is_null() && value["preset"] == "recommended");
                s.preset = if astra && tokens == Tokens::recommended() { Preset::Recommended } else { Preset::Custom };
                if astra { s.models.insert(ASTRA.into(), tokens); } else { s.fallback = Some(tokens); }
            } else { return Err(t("이전 컨텍스트 설정의 숫자를 읽지 못했어요.", "Could not read the previous context settings.")); }
        }
        s
    } else { serde_json::from_value(value).map_err(|e| e.to_string())? };
    settings.validate()?;
    Ok(settings)
}
fn read() -> Result<Settings, String> {
    match std::fs::read(ccg_store::app_home().join(FILE)) {
        Ok(raw) => decode(serde_json::from_slice(&raw).map_err(|e| e.to_string())?),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Settings::default()),
        Err(e) => Err(e.to_string()),
    }
}
pub fn get() -> Value {
    match read() {
        Ok(settings) => json!({"settings":settings,"defaults":defaults()}),
        Err(error) => json!({"error":error}),
    }
}
pub fn save(value: &Value) -> Value {
    let result = (|| -> Result<Settings, String> {
        let _lock = SAVE.lock().unwrap_or_else(|e| e.into_inner());
        let patch = value.as_object().ok_or_else(|| t("설정 형식이 올바르지 않아요.", "The settings format is invalid."))?;
        let mut merged = serde_json::to_value(read()?).map_err(|e| e.to_string())?;
        for (key, value) in patch { merged[key] = value.clone(); }
        let settings: Settings = serde_json::from_value(merged).map_err(|e| e.to_string())?;
        settings.validate()?;
        ccg_store::write_home_file(FILE, &serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        Ok(settings)
    })();
    match result { Ok(settings) => json!({"settings":settings}), Err(error) => json!({"error":error}) }
}
pub fn resolver() -> ccg_engine::codex::driver::ContextResolver {
    Arc::new(|plan| read().map(|s| s.overrides(plan)).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("{}: {e}", t("Codex 컨텍스트 설정", "Codex context settings")))))
}

fn catalog() -> Option<Value> {
    let home = super::codex_versions::home_for(&Default::default())?;
    if let Ok(raw) = std::fs::read(home.join("models_cache.json")) {
        if let Ok(v) = serde_json::from_slice::<Value>(&raw) { if v["models"].is_array() { return Some(v); } }
    }
    // Fresh installs have no model cache. Ask the installed CLI for its bundled
    // catalog (no authentication/model turn); older CLIs may not support this.
    let bin = super::codex_versions::codex_exe()?;
    if cfg!(windows) && bin.extension().and_then(|e| e.to_str()) != Some("exe") { return None; }
    let mut command = std::process::Command::new(bin);
    command.args(["debug", "models", "--bundled"]).env("CODEX_HOME", home)
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x0800_0000); }
    let mut child = command.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || { use std::io::Read; let mut text = String::new(); let _ = stdout.read_to_string(&mut text); let _ = tx.send(text); });
    let text = rx.recv_timeout(std::time::Duration::from_secs(5)).ok();
    let _ = child.kill(); let _ = child.wait();
    serde_json::from_str(&text?).ok()
}
fn parse_defaults(catalog: &Value, config: &Value) -> BTreeMap<String, Tokens> {
    catalog["models"].as_array().into_iter().flatten().filter_map(|m| {
        let id = m["slug"].as_str()?;
        let window = config["model_context_window"].as_u64().or_else(|| m["context_window"].as_u64())?;
        // Codex 0.153.x's automatic threshold is 90% of the raw model window.
        // Native offline Responses probe: 244799 tokens -> no compaction;
        // 244800 -> compaction, with the bundled 272000-token Astra window.
        let compact = config["model_auto_compact_token_limit"].as_u64()
            .or_else(|| m["auto_compact_token_limit"].as_u64()).unwrap_or(window.saturating_mul(9) / 10);
        Some((id.to_string(), Tokens { context_window: window, compact_token_limit: compact }))
    }).collect()
}
fn defaults() -> BTreeMap<String, Tokens> {
    let config = crate::ipc::parity::codex_tooling::context_config().unwrap_or(Value::Null);
    catalog().map(|c| parse_defaults(&c, &config)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn per_model_presets_and_independent_management() {
        let _home = crate::engine::testhome::take("codex-context-models");
        let astra = CodexPlan { model: ASTRA.into(), ..Default::default() };
        let sol = CodexPlan { model:"gpt-5.6-sol".into(), ..Default::default() };
        let recommended = json!({"preset":"recommended","models":{ASTRA:{"contextWindow":512000,"compactTokenLimit":430000}},"fallback":null});
        assert!(save(&recommended).get("error").is_none());
        assert_eq!(resolver()(&astra).unwrap().window, Some(512000));
        assert_eq!(resolver()(&sol).unwrap().window, None);
        assert!(save(&json!({"management":true})).get("error").is_none());
        assert_eq!(read().unwrap().models[ASTRA].context_window, 512000);
        let bad = json!({"preset":"custom","models":{"gpt-5.6-sol":{"contextWindow":100,"compactTokenLimit":100}}});
        assert!(save(&bad).get("error").is_some());
        let custom = json!({"preset":"custom","models":{"gpt-5.6-sol":{"contextWindow":200000,"compactTokenLimit":160000}},"fallback":null});
        assert!(save(&custom).get("error").is_none());
        assert_eq!(resolver()(&sol).unwrap().window, Some(200000));
        assert_eq!(resolver()(&astra).unwrap().window, None);
        assert!(read().unwrap().management);
        assert!(save(&json!({"preset":"default","models":{},"fallback":null})).get("error").is_none());
        assert_eq!(resolver()(&sol).unwrap().window, None);
        assert_eq!(resolver()(&sol).unwrap().management, Some(true));
        assert!(save(&json!({"management":false})).get("error").is_none());
        assert_eq!(resolver()(&sol).unwrap().management, Some(false));
    }
    #[test]
    fn old_scope_settings_keep_their_previous_behavior() {
        for scope in ["all","astra"] {
            let s = decode(json!({"management":null,"preset":"recommended","scope":scope,"contextWindow":512000,"compactTokenLimit":430000})).unwrap();
            assert!(!s.management);
            let sol = CodexPlan { model:"gpt-5.6-sol".into(), ..Default::default() };
            assert_eq!(s.overrides(&sol).window, if scope == "all" {Some(512000)} else {None});
        }
    }
    #[test]
    fn default_numbers_follow_the_catalog_and_existing_config() {
        let c = json!({"models":[{"slug":ASTRA,"context_window":272000},{"slug":"future","context_window":372000}]});
        let d = parse_defaults(&c, &Value::Null);
        assert_eq!(d[ASTRA].compact_token_limit,244800);
        assert_eq!(d["future"].compact_token_limit,334800);
        let d = parse_defaults(&c,&json!({"model_context_window":400000,"model_auto_compact_token_limit":300000}));
        assert_eq!(d[ASTRA].context_window,400000);
        assert_eq!(d[ASTRA].compact_token_limit,300000);
    }
}
