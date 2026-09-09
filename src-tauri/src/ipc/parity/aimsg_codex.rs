//! A short-lived Codex session for auxiliary text tasks, outside the chat runtime.
use super::{RunErr, DEADLINE};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::Instant;

struct Client {
    child: Child,
    stdin: ChildStdin,
    rx: Receiver<String>,
    id: u64,
    deadline: Instant,
    #[cfg(windows)]
    _job: ccg_engine::job::Job,
}

impl Drop for Client {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn failed(e: impl std::fmt::Display) -> RunErr {
    RunErr::Failed(e.to_string())
}

impl Client {
    fn open(root: &str, home: &Path, system_auth: bool) -> Result<Self, RunErr> {
        let bin = crate::engine::codex_versions::codex_exe()
            .ok_or_else(|| failed("Codex is not installed"))?;
        let mut cmd = ccg_engine::codex::driver::command_for(&bin);
        cmd.current_dir(root)
            .env("CODEX_HOME", home)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        if !system_auth { cmd.env_remove("OPENAI_API_KEY").env_remove("CODEX_API_KEY"); }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        #[cfg(windows)]
        let job = ccg_engine::job::Job::create().map_err(failed)?;
        let mut child = cmd.spawn().map_err(failed)?;
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            if let Err(e) = job.assign_raw(child.as_raw_handle() as *mut std::ffi::c_void) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(failed(e));
            }
        }
        let stdin = child.stdin.take().expect("stdin piped");
        let stdout = child.stdout.take().expect("stdout piped");
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if tx.send(line).is_err() { break; }
            }
        });
        Ok(Self {
            child, stdin, rx, id: 0, deadline: Instant::now() + DEADLINE,
            #[cfg(windows)]
            _job: job,
        })
    }

    fn send(&mut self, value: Value) -> Result<(), RunErr> {
        writeln!(self.stdin, "{value}").map_err(failed)?;
        self.stdin.flush().map_err(failed)
    }

    fn request(&mut self, method: &str, params: Value) -> Result<u64, RunErr> {
        self.id += 1;
        self.send(json!({"id":self.id,"method":method,"params":params}))?;
        Ok(self.id)
    }

    fn recv(&self) -> Result<Value, RunErr> {
        loop {
            let left = self.deadline.checked_duration_since(Instant::now()).ok_or(RunErr::Timeout)?;
            let line = self.rx.recv_timeout(left).map_err(|e| match e {
                mpsc::RecvTimeoutError::Timeout => RunErr::Timeout,
                mpsc::RecvTimeoutError::Disconnected => failed(ccg_fs::t("응답을 마치기 전에 Codex가 종료됐어요", "Codex stopped before completing the response")),
            })?;
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            // No approval or tool interaction is part of a Git message request.
            if v.get("id").is_some() && v.get("method").is_some() {
                return Err(failed(ccg_fs::t("텍스트 생성 중 Codex가 도구나 승인을 요청했어요", "Codex requested a tool or approval while generating text")));
            }
            if let Some(e) = v.get("error").filter(|e| !e.is_null()) {
                return Err(failed(e["message"].as_str().unwrap_or("Codex request failed")));
            }
            return Ok(v);
        }
    }

    fn call(&mut self, method: &str, params: Value) -> Result<Value, RunErr> {
        let id = self.request(method, params)?;
        loop {
            let v = self.recv()?;
            if v["id"].as_u64() == Some(id) {
                return v.get("result").cloned().ok_or_else(|| failed("Missing Codex result"));
            }
        }
    }
}

fn thread_params(root: &str, model: &str, service_tier: Option<&str>, config: &Value, instructions: &str) -> Value {
    let mut overrides = json!({
        "features": {"shell_tool":false,"unified_exec":false,"apply_patch_freeform":false,"apps":false,"multi_agent":false},
        "web_search":"disabled",
        "suppress_unstable_features_warning":true,
    });
    // Disable configured integrations for this request without changing their saved settings.
    for section in ["mcp_servers", "plugins"] {
        if let Some(entries) = config[section].as_object() {
            let disabled: serde_json::Map<String, Value> = entries.keys()
                .map(|name| (name.clone(), json!({"enabled":false}))).collect();
            overrides[section] = Value::Object(disabled);
        }
    }
    let mut params = json!({
        "cwd":root,"model":model,"modelProvider":"openai",
        "ephemeral":true,"approvalPolicy":"never","sandbox":"read-only",
        "environments":[],"dynamicTools":[],"config":overrides,
        "baseInstructions":instructions,
        "developerInstructions":"Use only the material in the user prompt. Do not use tools or modify files."
    });
    if let Some(tier) = service_tier { params["serviceTier"] = json!(tier); }
    params
}

fn message_text(item: &Value) -> Option<&str> {
    if item["type"] != "agentMessage" || item["phase"] == "commentary" { return None; }
    item["text"].as_str().filter(|s| !s.trim().is_empty())
}

fn completed_text(turn: &Value, text: String) -> Result<String, RunErr> {
    if turn["status"] != "completed" {
        return Err(failed(turn["error"]["message"].as_str().unwrap_or("Codex did not complete the message")));
    }
    let text = turn["items"].as_array().and_then(|items| items.iter().rev().find_map(message_text))
        .map(str::to_string).unwrap_or(text);
    if text.trim().is_empty() { return Err(failed(ccg_fs::t("Codex 응답이 비어 있어요", "Codex returned an empty response"))); }
    Ok(text)
}

pub(super) fn run_once(root: &str, home: &Path, model: &str, effort: &str, service_tier: Option<&str>, prompt: &str, instructions: &str, system_auth: bool) -> Result<String, RunErr> {
    let mut c = Client::open(root, home, system_auth)?;
    c.call("initialize", json!({"clientInfo":{"name":"agentcodegui","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}}))?;
    c.send(json!({"method":"initialized","params":{}}))?;
    let config = c.call("config/read", json!({"cwd":root,"includeLayers":false}))?;
    let thread = c.call("thread/start", thread_params(root, model, service_tier, &config["config"], instructions))?;
    let thread_id = thread["thread"]["id"].as_str().filter(|s| !s.is_empty())
        .ok_or_else(|| failed("Codex did not create a thread"))?;
    // Read events immediately: some servers emit items before the turn/start reply.
    let mut turn = json!({"threadId":thread_id,"model":model,"effort":effort,
        "input":[{"type":"text","text":prompt,"text_elements":[]}]});
    if let Some(tier) = service_tier { turn["serviceTier"] = json!(tier); }
    c.request("turn/start", turn)?;
    let mut text = String::new();
    loop {
        let v = c.recv()?;
        let p = &v["params"];
        if p["threadId"].as_str().is_some_and(|id| id != thread_id) { continue; }
        match v["method"].as_str() {
            Some("item/completed") => {
                if let Some(got) = message_text(&p["item"]) { text = got.to_string(); }
            }
            Some("turn/completed") => return completed_text(&p["turn"], text),
            Some("error") if p["willRetry"] != true => {
                return Err(failed(p["error"]["message"].as_str().unwrap_or("Codex message generation failed")));
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_or_partial_turns_never_become_commit_messages() {
        assert!(completed_text(&json!({"status":"failed","error":{"message":"Rate limit"}}), "partial".into()).is_err());
        assert!(completed_text(&json!({"status":"interrupted"}), "partial".into()).is_err());
        assert!(completed_text(&json!({"status":"completed"}), String::new()).is_err());
        let turn = json!({"status":"completed","items":[
            {"type":"agentMessage","phase":"final_answer","text":"<commit>Subject</commit>"},
            {"type":"agentMessage","phase":"commentary","text":"Thinking"}
        ]});
        assert_eq!(completed_text(&turn, "partial".into()).unwrap(), "<commit>Subject</commit>");
    }

    #[test]
    fn auxiliary_thread_disables_integrations_and_preserves_requested_model() {
        let p = thread_params("C:/repo", "gpt-custom", Some("priority"), &json!({
            "mcp_servers":{"docs.example":{"command":"tool"}},"plugins":{"plugin@market":{"enabled":true}}
        }), "Translate the supplied text.");
        assert_eq!(p["model"], "gpt-custom");
        assert_eq!(p["serviceTier"], "priority");
        assert!(thread_params("C:/repo", "gpt-custom", None, &json!({}), "Translate.").get("serviceTier").is_none());
        assert_eq!(p["modelProvider"], "openai");
        assert_eq!(p["sandbox"], "read-only");
        assert_eq!(p["ephemeral"], true);
        assert_eq!(p["baseInstructions"], "Translate the supplied text.");
        assert_eq!(p["config"]["mcp_servers"]["docs.example"]["enabled"], false);
        assert_eq!(p["config"]["plugins"]["plugin@market"]["enabled"], false);
    }
}
