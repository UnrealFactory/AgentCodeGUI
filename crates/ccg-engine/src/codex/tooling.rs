//! Codex's native inventory, shared by live threads and the pre-run inspector.
//! Never forward the effective config itself: MCP entries can contain credentials.
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub fn snapshot(
    cwd: &str,
    account: Option<&str>,
    api_mode: bool,
    config: &Value,
    skills: &Value,
    servers: &[Value],
    errors: &[String],
) -> Value {
    let mut mcp = BTreeMap::new();
    if let Some(entries) = config["config"]["mcp_servers"].as_object() {
        for (name, entry) in entries {
            let key = format!("mcp_servers.{}.enabled", json!(name));
            let prefix = format!("mcp_servers.{name}");
            let scope = if config["origins"].as_object().is_some_and(|origins| {
                origins.iter().any(|(k, v)| {
                    (k == &prefix || k.starts_with(&(prefix.clone() + ".")))
                        && v["name"]["type"] == "project"
                })
            }) {
                "local"
            } else {
                "global"
            };
            mcp.insert(name.clone(), json!({
                "name": name, "status": if entry["enabled"] == false { "off" } else { "configured" },
                "tools": [], "scope": scope, "configKey": key
            }));
        }
    }
    let mut plugins = BTreeMap::new();
    for server in servers {
        let Some(name) = server["name"].as_str() else {
            continue;
        };
        let tools: Vec<&str> = server["tools"]
            .as_object()
            .map(|m| m.keys().map(String::as_str).collect())
            .unwrap_or_default();
        let status = match server["runtimeStatus"].as_str() {
            Some("connected") => "connected",
            Some("starting") => "pending",
            Some("failed") => "failed",
            Some("cancelled" | "disabled") => "disabled",
            Some("authenticationRequired") => "needs-auth",
            _ if server["authStatus"] == "notLoggedIn" => "needs-auth",
            _ if !tools.is_empty() => "connected",
            _ => "configured",
        };
        let mut row = mcp
            .remove(name)
            .unwrap_or_else(|| json!({"name":name,"scope":"global"}));
        if row["status"] != "off" {
            row["status"] = json!(status);
        }
        row["tools"] = json!(tools);
        if let Some(id) = server["pluginId"].as_str() {
            plugins.insert(id.to_string(), json!({"name":id,"version":null}));
        }
        mcp.insert(name.to_string(), row);
    }
    let mut skill_rows = Vec::new();
    let mut warnings = errors.to_vec();
    if let Some(groups) = skills["data"].as_array() {
        for group in groups {
            if let Some(items) = group["skills"].as_array() {
                for skill in items {
                    let (Some(name), Some(path)) = (skill["name"].as_str(), skill["path"].as_str())
                    else {
                        continue;
                    };
                    let scope = match skill["scope"].as_str() {
                        Some("repo") => Some("project"),
                        Some("user") => Some("user"),
                        Some("plugin") => Some("plugin"),
                        _ => None,
                    };
                    skill_rows.push(json!({"name":name,"path":path,"description":skill["description"].as_str().unwrap_or(""),
                        "scope":scope,"off":skill["enabled"] == false}));
                }
            }
            if let Some(items) = group["errors"].as_array() {
                warnings.extend(
                    items
                        .iter()
                        .filter_map(|e| e["message"].as_str().map(str::to_string)),
                );
            }
        }
    }
    json!({"engine":"codex","cwd":cwd,"account":account,"apiMode":api_mode,
        "mcp":mcp.into_values().collect::<Vec<_>>(),"skills":skill_rows,
        "plugins":plugins.into_values().collect::<Vec<_>>(),"errors":warnings})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inventory_preserves_disabled_and_duplicate_skills_without_exposing_secrets() {
        let cfg = json!({"config":{"mcp_servers":{"private.server":{"enabled":false,"env":{"TOKEN":"secret"}}}}});
        let skills = json!({"data":[{"skills":[
            {"name":"review","path":"/a/SKILL.md","scope":"repo","enabled":false},
            {"name":"review","path":"/b/SKILL.md","scope":"user","enabled":true}
        ]}]});
        let servers = vec![
            json!({"name":"private.server","tools":{}}),
            json!({"name":"plugin","pluginId":"p@market","tools":{"read":{}},"runtimeStatus":"connected"}),
        ];
        let v = snapshot("/a", Some("a@b"), false, &cfg, &skills, &servers, &[]);
        assert_eq!(v["skills"].as_array().unwrap().len(), 2);
        assert_eq!(v["skills"][0]["scope"], "project");
        assert_eq!(v["mcp"][1]["status"], "off");
        assert_eq!(
            v["mcp"][1]["configKey"],
            "mcp_servers.\"private.server\".enabled"
        );
        assert!(!v.to_string().contains("secret"));
    }
}
