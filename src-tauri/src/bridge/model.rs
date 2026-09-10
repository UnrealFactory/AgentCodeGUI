//! External tool data. Unknown domain kinds and extension fields round-trip.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::sync::OnceLock;

pub const VERSION: u32 = 1;
pub const MAX_BODY: usize = 512 * 1024;
pub const MAX_DOCUMENT: usize = 256 * 1024;
pub const MAX_CAPTURE: usize = 96 * 1024;
pub const MAX_CLIENTS: usize = 32;
pub const ONLINE_MS: u64 = 15_000;

pub fn icons() -> &'static Value {
    static ICONS: OnceLock<Value> = OnceLock::new();
    ICONS.get_or_init(|| serde_json::from_str(include_str!("../../../src/shared/external-tool-icons.json")).expect("bundled icon catalog"))
}
pub fn normalized_icon(icon: &str) -> String {
    if icons().as_array().is_some_and(|list| list.iter().any(|i| i["id"] == icon)) { icon.into() } else { "tool".into() }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: String,
    pub name: String,
    /// Stable identity of this tool instance/workspace, chosen by the adapter.
    pub instance_id: String,
    #[serde(default)] pub version: String,
    #[serde(default)] pub icon: String,
    #[serde(flatten)] pub extensions: BTreeMap<String, Value>,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Document {
    #[serde(default)] pub items: Vec<ContextItem>,
    /// Current tool state (open documents, diagnostics, jobs, application data…).
    #[serde(default)] pub state: Value,
    #[serde(flatten)] pub extensions: BTreeMap<String, Value>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ContextItem {
    pub id: String,
    pub kind: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub text: Option<String>,
    #[serde(default)] pub data: Value,
    #[serde(flatten)] pub extensions: BTreeMap<String, Value>,
}
pub fn short(s: &str, max: usize) -> bool { !s.trim().is_empty() && s.len() <= max }
impl Manifest {
    pub fn validate(&self) -> Result<(), String> {
        if !short(&self.id, 128) || !short(&self.name, 160) || !short(&self.instance_id, 160)
            || self.version.len() > 80 || self.icon.len() > 128 {
            return Err("A bounded id, name and instanceId are required.".into());
        }
        if serde_json::to_vec(self).map_err(|e| e.to_string())?.len() > 16 * 1024 { return Err("Manifest exceeds 16 KiB.".into()); }
        Ok(())
    }
    pub fn identity(&self) -> String { serde_json::to_string(&(&self.id, &self.instance_id)).unwrap_or_default() }
}
impl Document {
    pub fn validate(&self) -> Result<(), String> {
        let mut seen = HashSet::new();
        if self.items.len() > 32 || self.items.iter().any(|i| !short(&i.id, 128) || !short(&i.kind, 128)
            || !short(&i.title, 240) || !seen.insert(&i.id)) {
            return Err("Use at most 32 context items with unique IDs and bounded kind/title.".into());
        }
        if serde_json::to_vec(self).map_err(|e| e.to_string())?.len() > MAX_DOCUMENT {
            return Err("Document exceeds 256 KiB. Send the selected portion or a summary.".into());
        }
        Ok(())
    }
}
/// A queued snapshot must keep its original session and data, never newer data.
pub fn validate_capture(chat: &str, capture: &Value) -> Result<(), String> {
    if capture["protocolVersion"] != VERSION || capture["chatId"].as_str() != Some(chat) || capture["capturedAt"].as_u64().is_none() {
        return Err("External context snapshot belongs to a different session or protocol.".into());
    }
    let sources = capture["sources"].as_array().ok_or("External context sources must be an array.")?;
    if sources.len() > MAX_CLIENTS || serde_json::to_vec(capture).map_err(|e| e.to_string())?.len() > MAX_CAPTURE {
        return Err("External context exceeds 96 KiB. Select a smaller portion or disable an unused tool.".into());
    }
    let mut ids = HashSet::new();
    for source in sources {
        let id = source["clientId"].as_str().filter(|s| short(s, 128)).ok_or("Invalid context source ID.")?;
        if !ids.insert(id) || !source["name"].as_str().is_some_and(|s| short(s, 160))
            || !source["toolId"].as_str().is_some_and(|s| short(s, 128)) || source["revision"].as_u64().is_none() {
            return Err("Invalid context source metadata.".into());
        }
        let document: Document = serde_json::from_value(serde_json::json!({"items":source["items"],"state":source["state"]})).map_err(|e| e.to_string())?;
        document.validate()?;
    }
    Ok(())
}
