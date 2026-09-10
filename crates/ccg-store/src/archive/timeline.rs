//! Small activity labels for the conversation reader. Full originals stay in the journal.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub operation: String,
    pub name: String,
    pub target: String,
    pub phase: String,
    pub tool_id: String,
    pub error: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileGroup {
    pub end_seq: u64,
    pub count: u64,
}
fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn short(v: &Value) -> String {
    super::preview(text(v), 320)
}

pub fn describe(source: &str, v: &Value) -> Option<Activity> {
    if source == "ui" && text(&v["type"]) == "result" {
        return Some(Activity {
            operation: "finish".into(),
            phase: "end".into(),
            error: v["isError"] == true,
            ..Default::default()
        });
    }
    if source != "tool" {
        return None;
    }
    let item = &v["item"];
    let kind = text(&v["type"]);
    let name = if item.is_object() {
        text(&item["type"])
    } else {
        text(&v["name"])
    };
    let input = &v["input"];
    let action = item["commandActions"]
        .as_array()
        .and_then(|a| a.first())
        .unwrap_or(&Value::Null);
    let operation = match name.to_ascii_lowercase().as_str() {
        "read" => "read",
        "write" => "write",
        "edit" | "multiedit" | "apply_patch" | "filechange" | "codex_file_change" => "edit",
        "glob" | "grep" | "websearch" | "webfetch" => "search",
        "bash" | "commandexecution" => match text(&action["type"]) {
            "read" => "read",
            "search" | "listFiles" => "search",
            _ => "command",
        },
        "task" | "agent" | "collabagenttoolcall" | "subagentactivity" => "agent",
        "imagegeneration" => "image",
        _ => "tool",
    };
    let target = [
        &input["file_path"],
        &input["path"],
        &action["path"],
        &input["description"],
        &input["command"],
        &action["command"],
        &item["command"],
        &item["changes"][0]["path"],
        &input["pattern"],
        &input["query"],
        &input["url"],
        &item["query"],
        &item["tool"],
    ]
    .into_iter()
    .find(|p| !text(p).is_empty())
    .map(short)
    .unwrap_or_default();
    let end = kind == "tool_result" || kind == "item/completed";
    let id = if item.is_object() {
        &item["id"]
    } else if end {
        &v["tool_use_id"]
    } else {
        &v["id"]
    };
    Some(Activity {
        operation: operation.into(),
        name: super::preview(name, 100),
        target,
        phase: if end { "end" } else { "start" }.into(),
        tool_id: short(id),
        error: v["is_error"] == true
            || matches!(
                text(&item["status"]),
                "failed" | "declined" | "cancelled" | "canceled"
            )
            || item["exitCode"].as_i64().is_some_and(|c| c != 0),
    })
}

pub fn capture_issue(e: &super::Entry) -> bool {
    matches!(e.kind.as_str(), "capture-error" | "coverage-gap")
}

pub fn visible(e: &super::Entry) -> bool {
    if capture_issue(e) {
        return false;
    }
    match e.source.as_str() {
        "input" => matches!(e.kind.as_str(), "user" | "control_response"),
        "tool" | "response" => true,
        // Automatic workspace snapshots stay in the archive, outside the
        // conversation reader. Explicit tool actions still describe file work.
        "file" => false,
        // Completion bookkeeping is kept in the journal, not in the conversation.
        // A failed result can be the only explanation for a run ending early.
        "ui" if e.kind == "result" => e.activity.as_ref().is_some_and(|a| a.error),
        "ui" => !matches!(
            e.kind.as_str(),
            "assistant-stream"
                | "user-echo"
                | "tool-start"
                | "tool-end"
                | "terminal"
                | "status"
                | "context"
                | "session"
                | "tooling"
                | "bg-tasks"
                | "usage"
                | "thinking-clear"
                | "question-closed"
                | "subagent-metadata"
                | "model-fallback"
                | "api-retry"
                | "compact"
                | "notice"
                | "workflow"
        ),
        "lifecycle" => matches!(e.kind.as_str(), "aborted" | "error" | "interrupted"),
        _ => false,
    }
}
