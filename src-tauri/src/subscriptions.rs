//! 계정별 웹 구독 조회. 브라우저는 한 번에 하나만 띄우며 결과에는 날짜·상태만 남깁니다.
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{atomic::{AtomicBool, Ordering}, mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const SCRIPT: &str = include_str!("subscription-browser.mjs");
const TTL: u64 = 6 * 3600;
const RETRY_GAP: u64 = 15 * 60;
const EVENT: &str = "subscriptions:updated";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Data {
    kind: Kind,
    date: Option<String>,
    checked_at: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum Kind { Renews, Cancels, Ended, Paused, Trial, Scheduled, Active, None, Unknown, PaymentDue }

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct Record {
    connected: bool,
    identity: String,
    browser: String,
    data: Option<Data>,
    error: Option<String>,
    attempted_at: u64,
}
#[derive(Clone, PartialEq, Eq, Hash)]
struct Key { provider: String, email: String }
#[derive(Clone)]
struct Job { key: Key, interactive: bool }
struct Active { key: Key, phase: String, cancel: Arc<AtomicBool> }
#[derive(Default)]
struct Queue { jobs: VecDeque<Job>, active: Option<Active>, running: bool, errors: HashMap<Key, String> }
static QUEUE: OnceLock<Mutex<Queue>> = OnceLock::new();
static STOPPING: AtomicBool = AtomicBool::new(false);
fn queue() -> &'static Mutex<Queue> { QUEUE.get_or_init(|| Mutex::new(Queue::default())) }
fn now() -> u64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs() }
fn relative(key: &Key) -> String { format!("web-subscriptions/{}/{}", key.provider, ccg_auth::account_slug(&key.email)) }
fn root(key: &Key) -> PathBuf { ccg_store::app_home().join(relative(key)) }
fn read(key: &Key) -> Record {
    ccg_store::read_home_json(&format!("{}/status.json", relative(key)))
        .and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default()
}
fn save(key: &Key, value: &Record) -> Result<(), String> {
    std::fs::create_dir_all(root(key)).map_err(|_| "saveFailed")?;
    ccg_store::write_home_file(&format!("{}/status.json", relative(key)), &serde_json::to_string(value).unwrap())
        .map_err(|_| "saveFailed".into())
}
fn keys() -> Vec<Key> {
    let mut out = Vec::new();
    for (provider, file, versions) in [("claude", "accounts.json", &[2, 3][..]), ("codex", "codex-accounts.json", &[1][..])] {
        let Some(v) = ccg_store::read_home_json(file) else { continue };
        if !versions.contains(&v.get("version").and_then(Value::as_u64).unwrap_or(0)) { continue }
        if let Some(accounts) = v.get("accounts").and_then(Value::as_array) {
            for a in accounts {
                if let Some(email) = a.get("email").and_then(Value::as_str) { out.push(Key { provider: provider.into(), email: email.into() }) }
            }
        }
    }
    out
}
fn registered(key: &Key) -> bool { keys().contains(key) }
fn identity(key: &Key) -> Option<String> {
    if !registered(key) { return None }
    if key.provider == "claude" {
        let path = ccg_auth::claude::account_dir(&key.email).join(".claude.json");
        let v: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
        let a = v.get("oauthAccount")?;
        if a.get("emailAddress")?.as_str()? != key.email { return None }
        return a.get("organizationUuid")?.as_str().map(str::to_owned);
    }
    let raw = std::fs::read_to_string(ccg_auth::codex::account_dir(&key.email).join("auth.json")).ok()?;
    if ccg_auth::codex::parse_auth(Some(&raw))?.email.as_deref() != Some(&key.email) { return None }
    let v: Value = serde_json::from_str(&raw).ok()?;
    let token = v.get("tokens")?.get("id_token")?.as_str()?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(token.split('.').nth(1)?).ok()?;
    let p: Value = serde_json::from_slice(&bytes).ok()?;
    p.get("https://api.openai.com/auth")?.get("chatgpt_account_id")?.as_str().map(str::to_owned)
}
fn view(key: &Key) -> Value {
    let mut r = read(key);
    if !r.identity.is_empty() && identity(key).is_some_and(|id| id != r.identity) {
        r.connected = false; r.data = None; r.error = Some("identityMissing".into());
    }
    let q = queue().lock().unwrap();
    let phase = q.active.as_ref().filter(|a| a.key == *key).map(|a| a.phase.as_str())
        .unwrap_or_else(|| if q.jobs.iter().any(|j| j.key == *key) { "queued" } else { "idle" });
    json!({ "provider": key.provider, "email": key.email, "connected": r.connected, "data": r.data, "error": q.errors.get(key).cloned().or(r.error), "phase": phase })
}
fn notify(app: &AppHandle) { let _ = app.emit(EVENT, ()); }
fn due(r: &Record, time: u64) -> bool {
    r.connected && !matches!(r.error.as_deref(), Some("needsLogin" | "wrongAccount" | "identityMissing" | "browserMissing"))
        && time.saturating_sub(r.attempted_at) >= RETRY_GAP
        && r.data.as_ref().is_none_or(|d| time.saturating_sub(d.checked_at) >= TTL || d.date.as_deref()
            .and_then(ccg_auth::js::date_parse).is_some_and(|ms| ms > d.checked_at as f64 * 1000.0 && ms <= time as f64 * 1000.0))
}
fn enqueue(app: &AppHandle, key: Key, interactive: bool, force: bool) {
    if STOPPING.load(Ordering::Relaxed) || !registered(&key) { return }
    let record = read(&key);
    if !interactive && (!record.connected || (!force && !due(&record, now()))) { return }
    let mut q = queue().lock().unwrap();
    if q.active.as_ref().is_some_and(|a| a.key == key) { return }
    if let Some(i) = q.jobs.iter().position(|j| j.key == key) {
        if !interactive { return }
        q.jobs.remove(i);
    }
    let job = Job { key, interactive };
    q.errors.remove(&job.key);
    if interactive { q.jobs.push_front(job) } else { q.jobs.push_back(job) }
    if !q.running {
        q.running = true;
        let app = app.clone();
        std::thread::spawn(move || worker(app));
    }
    drop(q);
    notify(app);
}
fn browser(saved: &str) -> Option<(String, PathBuf)> {
    for name in ["chrome", "edge"] {
        if !saved.is_empty() && saved != name { continue }
        let tail = if name == "chrome" { "Google/Chrome/Application/chrome.exe" } else { "Microsoft/Edge/Application/msedge.exe" };
        for variable in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
            if let Some(base) = std::env::var_os(variable) {
                let p = PathBuf::from(base).join(tail);
                if p.is_file() { return Some((name.into(), p)) }
            }
        }
    }
    None
}
fn worker(app: AppHandle) {
    loop {
        let cancel = Arc::new(AtomicBool::new(false));
        let job = {
            let mut q = queue().lock().unwrap();
            let Some(job) = q.jobs.pop_front().filter(|_| !STOPPING.load(Ordering::Relaxed)) else { q.running = false; return };
            q.active = Some(Active { key: job.key.clone(), phase: if job.interactive { "connecting" } else { "refreshing" }.into(), cancel: cancel.clone() });
            job
        };
        notify(&app);
        let mut r = read(&job.key);
        let expected = identity(&job.key);
        if expected.as_ref().is_some_and(|id| !r.identity.is_empty() && *id != r.identity) { r = Record::default(); }
        r.attempted_at = now();
        let outcome = match expected {
            Some(id) => { r.identity = id; run_browser(&app, &job, &mut r, &cancel) }
            None => Err("identityMissing".into()),
        };
        match outcome { Ok(data) => { r.connected = true; r.data = Some(data); r.error = None }, Err(error) => { r.error = Some(error) } }
        if registered(&job.key) && identity(&job.key).as_deref() == Some(r.identity.as_str()) {
            if save(&job.key, &r).is_err() { queue().lock().unwrap().errors.insert(job.key.clone(), "saveFailed".into()); }
        } else if registered(&job.key) && r.identity.is_empty() { let _ = save(&job.key, &r); }
        else if !registered(&job.key) { let _ = remove_profile(&job.key); }
        // BUG-0013 — 웹은 새 구독을 바로 보지만 앱의 플랜·초기화권은 옛 CLI 토큰을 따른다.
        // 확인이 성공한 Codex 계정은 토큰을 새로 받고 한도를 다시 물은 뒤 렌더러에 알린다.
        if r.error.is_none() && registered(&job.key) {
            if job.key.provider == "codex" {
                let _ = crate::engine::codex_limit::refresh_account(&job.key.email);
                let _ = app.emit("codex-auth:account-refreshed", job.key.email.clone());
            } else if let Ok(Some(sub)) = ccg_auth::net::fetch_account_subscription(&job.key.email) {
                // 클로드 토큰은 불투명이라 재발급이 필요 없다(한도는 늘 서버 값). 로그인 때 굳은
                // 스토어의 구독 종류(플랜 라벨)만 프로필의 현재값으로 되싱크한다.
                ccg_auth::claude::resync_subscription(&job.key.email, &sub);
                let _ = app.emit("auth:account-refreshed", job.key.email.clone());
            }
        }
        queue().lock().unwrap().active = None;
        notify(&app);
    }
}
fn run_browser(app: &AppHandle, job: &Job, r: &mut Record, cancel: &AtomicBool) -> Result<Data, String> {
    if cancel.load(Ordering::Relaxed) || STOPPING.load(Ordering::Relaxed) { return Err("cancelled".into()) }
    if std::env::var("CCG_NO_NET").is_ok_and(|v| !v.is_empty() && v != "0") { return Err("offline".into()) }
    let node = ccg_lsp::launch::node_exe().ok_or("runtimeMissing")?;
    let (name, executable) = browser(&r.browser).ok_or("browserMissing")?;
    r.browser = name;
    let script = ccg_store::app_home().join("web-subscriptions/browser.mjs");
    std::fs::create_dir_all(script.parent().ok_or("saveFailed")?).map_err(|_| "saveFailed")?;
    if std::fs::read_to_string(&script).ok().as_deref() != Some(SCRIPT) {
        ccg_store::write_home_file("web-subscriptions/browser.mjs", SCRIPT).map_err(|_| "saveFailed")?;
    }
    let mut command = Command::new(node);
    command.arg(&script).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x0800_0000); }
    let mut child = command.spawn().map_err(|_| "runtimeMissing")?;
    ccg_lsp::jobkill::adopt(child.id());
    let _process_scope = ccg_lsp::jobkill::scoped(child.id());
    let mut input = child.stdin.take().ok_or("unavailable")?;
    let output = child.stdout.take().ok_or("unavailable")?;
    let config = json!({ "provider": job.key.provider, "identity": r.identity, "profile": root(&job.key).join("profile"), "browser": executable, "interactive": job.interactive });
    if writeln!(input, "{config}").is_err() { let _ = child.kill(); let _ = child.wait(); return Err("unavailable".into()) }
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(output).lines().map_while(Result::ok) {
            if line.len() > 16_384 { break }
            if let Ok(value) = serde_json::from_str::<Value>(&line) { if tx.send(value).is_err() { break } }
        }
    });
    let start = Instant::now();
    let mut cancellation_sent = false;
    let mut cancellation_at = None;
    let mut browser_pid = None;
    let result = loop {
        if cancel.load(Ordering::Relaxed) || STOPPING.load(Ordering::Relaxed) || start.elapsed().as_secs() > if job.interactive { 310 } else { 55 } {
            if !cancellation_sent { let _ = writeln!(input, "cancel"); cancellation_sent = true; cancellation_at = Some(Instant::now()); }
        }
        if cancellation_at.is_some_and(|at| at.elapsed() > Duration::from_secs(6)) { break Err("cancelled".into()) }
        if !job.interactive { if let Some(pid) = browser_pid { hide_browser(pid); } }
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(v) if v.get("browserPid").and_then(Value::as_u64).is_some() => {
                browser_pid = v["browserPid"].as_u64().and_then(|id| u32::try_from(id).ok());
            }
            Ok(v) if v.get("state").and_then(Value::as_str) == Some("wrongAccount") => {
                if let Some(a) = queue().lock().unwrap().active.as_mut() { a.phase = "wrongAccount".into(); }
                notify(app);
            }
            Ok(v) => {
                if cancellation_sent { break Err("cancelled".into()) }
                if let Some(data) = v.get("data").and_then(|d| serde_json::from_value::<Data>(d.clone()).ok()) {
                    if data.date.as_deref().is_some_and(|s| ccg_auth::js::date_parse(s).is_none()) { break Err("unavailable".into()) }
                    break Ok(Data { checked_at: now(), ..data });
                }
                let code = v.get("error").and_then(Value::as_str).unwrap_or("unavailable");
                break Err(match code { "needsLogin" | "wrongAccount" | "cancelled" | "closed" | "browserMissing" | "identityMissing" => code, _ => "unavailable" }.into());
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break Err("unavailable".into()),
            Err(mpsc::RecvTimeoutError::Timeout) => {},
        }
    };
    drop(input);
    let end = Instant::now();
    while child.try_wait().ok().flatten().is_none() && end.elapsed() < Duration::from_secs(6) { std::thread::sleep(Duration::from_millis(50)); }
    let _ = child.kill();
    let _ = child.wait();
    result
}
#[cfg(windows)]
fn hide_browser(pid: u32) {
    use windows::Win32::UI::WindowsAndMessaging::{FindWindowExW, GetWindowThreadProcessId, IsWindowVisible, ShowWindow, SW_HIDE};
    if ccg_lsp::jobkill::contains(pid) != Some(true) { return }
    unsafe {
        let mut previous = None;
        while let Ok(window) = FindWindowExW(None, previous, windows::core::w!("Chrome_WidgetWin_1"), None) {
            previous = Some(window);
            let mut owner = 0;
            GetWindowThreadProcessId(window, Some(&mut owner));
            if owner == pid && IsWindowVisible(window).as_bool() { let _ = ShowWindow(window, SW_HIDE); }
        }
    }
}
#[cfg(not(windows))]
fn hide_browser(_pid: u32) {}
fn remove_profile(key: &Key) -> Result<(), String> {
    let p = root(key);
    if !p.exists() { return Ok(()) }
    let base = ccg_store::app_home().join("web-subscriptions").canonicalize().map_err(|_| "saveFailed")?;
    let target = p.canonicalize().map_err(|_| "saveFailed")?;
    if target == base || !target.starts_with(&base) { return Err("saveFailed".into()) }
    std::fs::remove_dir_all(target).map_err(|_| "saveFailed".into())
}
pub fn forget(provider: &str, email: &str) {
    let key = Key { provider: provider.into(), email: email.into() };
    let mut q = queue().lock().unwrap();
    q.jobs.retain(|j| j.key != key);
    q.errors.remove(&key);
    if let Some(active) = q.active.as_ref().filter(|a| a.key == key) { active.cancel.store(true, Ordering::Relaxed); }
    else { let _ = remove_profile(&key); }
}
pub fn shutdown() {
    STOPPING.store(true, Ordering::Relaxed);
    let mut q = queue().lock().unwrap();
    q.jobs.clear();
    if let Some(a) = &q.active { a.cancel.store(true, Ordering::Relaxed); }
}
pub fn dispatch(app: &AppHandle, channel: &str, p: &Value) -> Option<Value> {
    if !channel.starts_with("subscriptions:") { return None }
    let arg = p.get(0).cloned().unwrap_or(Value::Null);
    if channel == "subscriptions:list" {
        let all = keys();
        if arg.get("refresh").and_then(Value::as_bool) == Some(true) { for key in &all { enqueue(app, key.clone(), false, false); } }
        return Some(json!(all.iter().map(view).collect::<Vec<_>>()));
    }
    let key = Key { provider: arg.get("provider").and_then(Value::as_str).unwrap_or("").into(), email: arg.get("email").and_then(Value::as_str).unwrap_or("").into() };
    if !registered(&key) { return Some(json!({ "error": "notRegistered" })) }
    match channel {
        "subscriptions:connect" => enqueue(app, key.clone(), true, true),
        "subscriptions:refresh" => enqueue(app, key.clone(), false, true),
        "subscriptions:cancel" => {
            let mut q = queue().lock().unwrap();
            q.jobs.retain(|j| j.key != key);
            if let Some(a) = q.active.as_ref().filter(|a| a.key == key) { a.cancel.store(true, Ordering::Relaxed); }
        }
        "subscriptions:disconnect" => {
            let mut q = queue().lock().unwrap();
            q.jobs.retain(|j| j.key != key);
            if q.active.as_ref().is_some_and(|a| a.key == key) { return Some(json!({ "error": "busy" })) }
            if let Err(error) = remove_profile(&key) { return Some(json!({ "error": error })) }
            q.errors.remove(&key);
        }
        _ => return None,
    }
    notify(app);
    Some(view(&key))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn automatic_refresh_respects_ttl_backoff_and_sign_in() {
        let mut r = Record { connected: true, data: Some(Data { kind: Kind::Renews, date: None, checked_at: 1000 }), attempted_at: 1000, ..Default::default() };
        assert!(!due(&r, 1001));
        assert!(due(&r, 1000 + TTL));
        r.attempted_at = 1000 + TTL;
        assert!(!due(&r, r.attempted_at + 1));
        r.error = Some("needsLogin".into());
        assert!(!due(&r, 1000 + TTL * 2));
        r.connected = false; r.error = None;
        assert!(!due(&r, 1000 + TTL * 2));
    }
}
