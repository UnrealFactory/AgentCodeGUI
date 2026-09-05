//! Native Codex tooling queries run on the IPC blocking pool, without a model turn.
use ccg_engine::codex::{tooling::snapshot, CodexPlan};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

struct Client {
    child: Child,
    stdin: ChildStdin,
    rx: Receiver<String>,
    id: u64,
    deadline: Instant,
    // Closing the job also reaps stdio MCP children, including on timeout.
    #[cfg(windows)]
    _job: ccg_engine::job::Job,
}
impl Drop for Client {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Client {
    fn open(plan: &CodexPlan) -> Result<Self, String> {
        let bin = crate::engine::codex_versions::codex_exe().ok_or("Codex is not installed")?;
        let home =
            crate::engine::codex_versions::home_for(plan).ok_or("Codex home is unavailable")?;
        let mut cmd = ccg_engine::codex::driver::command_for(&bin);
        cmd.env("CODEX_HOME", home)
            .current_dir(&plan.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        #[cfg(windows)]
        let job = ccg_engine::job::Job::create().map_err(|e| e.to_string())?;
        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            if let Err(e) = job.assign_raw(child.as_raw_handle() as *mut std::ffi::c_void) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e.to_string());
            }
        }
        let stdin = child.stdin.take().expect("stdin piped");
        let stdout = child.stdout.take().expect("stdout piped");
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        let mut c = Self {
            child,
            stdin,
            rx,
            id: 0,
            deadline: Instant::now() + Duration::from_secs(20),
            #[cfg(windows)]
            _job: job,
        };
        c.call("initialize", json!({"clientInfo":{"name":"agentcodegui","version":"3.0.0"},"capabilities":{"experimentalApi":true}}))?;
        writeln!(
            c.stdin,
            "{}",
            json!({"jsonrpc":"2.0","method":"initialized","params":{}})
        )
        .map_err(|e| e.to_string())?;
        c.stdin.flush().map_err(|e| e.to_string())?;
        Ok(c)
    }
    fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.id += 1;
        writeln!(
            self.stdin,
            "{}",
            json!({"jsonrpc":"2.0","id":self.id,"method":method,"params":params})
        )
        .map_err(|e| e.to_string())?;
        self.stdin.flush().map_err(|e| e.to_string())?;
        loop {
            let left = self
                .deadline
                .checked_duration_since(Instant::now())
                .ok_or("Codex tooling query timed out")?;
            let line = self
                .rx
                .recv_timeout(left)
                .map_err(|e| format!("Codex tooling: {e}"))?;
            let Ok(v) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if v["id"].as_u64() != Some(self.id) {
                continue;
            }
            if let Some(e) = v.get("error") {
                return Err(format!(
                    "{method}: {}",
                    e["message"].as_str().unwrap_or("RPC failed")
                ));
            }
            return v
                .get("result")
                .cloned()
                .ok_or_else(|| format!("{method}: missing result"));
        }
    }
}

fn plan(args: &Value) -> Result<CodexPlan, String> {
    let cwd = args["cwd"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::current_dir().ok())
        .ok_or("Working folder is unavailable")?;
    if !cwd.is_absolute() || !cwd.is_dir() {
        return Err("Working folder does not exist".into());
    }
    Ok(CodexPlan {
        cwd: cwd.to_string_lossy().into_owned(),
        account: args["account"].as_str().map(str::to_string),
        api_mode: args["apiMode"].as_bool().unwrap_or(false),
        ..Default::default()
    })
}

fn read(c: &mut Client, p: &CodexPlan) -> Value {
    let mut errors = Vec::new();
    let config = c
        .call("config/read", json!({"cwd":p.cwd,"includeLayers":false}))
        .unwrap_or_else(|e| {
            errors.push(e);
            Value::Null
        });
    let skills = c
        .call("skills/list", json!({"cwds":[p.cwd],"forceReload":true}))
        .unwrap_or_else(|e| {
            errors.push(e);
            Value::Null
        });
    let mut servers = Vec::new();
    let mut cursor = Value::Null;
    let mut seen = std::collections::BTreeSet::new();
    loop {
        match c.call(
            "mcpServerStatus/list",
            json!({"cursor":cursor,"limit":100,"detail":"toolsAndAuthOnly"}),
        ) {
            Ok(v) => {
                if let Some(data) = v["data"].as_array() {
                    servers.extend(data.iter().cloned());
                }
                let Some(next) = v["nextCursor"].as_str() else {
                    break;
                };
                if !seen.insert(next.to_string()) {
                    errors.push("Codex returned a repeated MCP cursor".into());
                    break;
                }
                cursor = json!(next);
            }
            Err(e) => {
                errors.push(e);
                break;
            }
        }
    }
    snapshot(
        &p.cwd,
        p.account.as_deref(),
        p.api_mode,
        &config,
        &skills,
        &servers,
        &errors,
    )
}

pub fn dispatch(args: &Value, write: bool) -> Value {
    static WRITES: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _write_guard = write.then(|| WRITES.lock().unwrap_or_else(|e| e.into_inner()));
    let result = (|| -> Result<Value, String> {
        let p = plan(args)?;
        let mut c = Client::open(&p)?;
        if write {
            let enabled = args["enabled"].as_bool().ok_or("Missing enabled flag")?;
            // Validate selectors against Codex's inventory rather than accepting
            // arbitrary config keys or file paths from a renderer.
            let inventory = read(&mut c, &p);
            c.deadline = Instant::now() + Duration::from_secs(20);
            if args["kind"] == "skill" {
                let path = args["name"].as_str().ok_or("Missing skill path")?;
                if !inventory["skills"]
                    .as_array()
                    .is_some_and(|rows| rows.iter().any(|s| s["path"] == path))
                {
                    return Err("The skill is no longer available in this Codex account".into());
                }
                let result = c.call(
                    "skills/config/write",
                    json!({"path":path,"enabled":enabled}),
                )?;
                if result["effectiveEnabled"]
                    .as_bool()
                    .is_some_and(|v| v != enabled)
                {
                    return Err(
                        "Saved, but another Codex configuration overrides this skill setting"
                            .into(),
                    );
                }
            } else if args["kind"] == "mcp" {
                let name = args["name"].as_str().ok_or("Missing MCP server name")?;
                let key = inventory["mcp"]
                    .as_array()
                    .and_then(|rows| rows.iter().find(|s| s["name"] == name))
                    .and_then(|s| s["configKey"].as_str())
                    .ok_or("This MCP server is managed by its Codex plugin")?;
                let result = c.call(
                    "config/value/write",
                    json!({"keyPath":key,"value":enabled,"mergeStrategy":"replace"}),
                )?;
                if result["status"] == "okOverridden" {
                    return Err(result["overriddenMetadata"]["message"]
                        .as_str()
                        .unwrap_or(
                            "Saved, but another Codex configuration overrides this MCP setting",
                        )
                        .to_string());
                }
            } else {
                return Err("Unknown tooling kind".into());
            }
            return Ok(json!({"ok":true}));
        }
        Ok(read(&mut c, &p))
    })();
    result.unwrap_or_else(|error| json!({"error":error}))
}
