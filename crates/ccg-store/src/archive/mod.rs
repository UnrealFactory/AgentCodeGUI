//! Local opt-in archive. No rendering state owns recording; closed/hidden views do
//! not affect capture. Payloads are append-only; file bytes are content addressed.
mod files;
pub mod journal;
mod layout;
#[cfg(test)]
mod tests;
mod timeline;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn preview(s: &str, limit: usize) -> String {
    s.chars()
        .take(limit)
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .collect()
}
pub fn message_text(v: &Value) -> String {
    if let Some(s) = v.as_str() {
        return s.to_string();
    }
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}
pub fn invalid(s: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, s)
}
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub seq: u64,
    pub at: u64,
    pub source: String,
    pub kind: String,
    pub preview: String,
    pub turn_id: Option<String>,
    pub offset: u64,
    pub length: u64,
    pub payload_bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity: Option<timeline::Activity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_group: Option<timeline::FileGroup>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub id: String,
    pub parent_id: Option<String>,
    pub title: String,
    pub started_at: u64,
    pub updated_at: u64,
    pub ended_at: Option<u64>,
    pub duration_ms: u64,
    pub waiting_ms: u64,
    pub wait_started_at: Option<u64>,
    pub status: String,
    pub model: String,
    pub cwd: String,
    pub identity: Value,
    pub first_seq: u64,
    pub last_seq: u64,
    pub events: u64,
    pub files: u64,
    pub bytes: u64,
    pub incomplete: bool,
    pub starred: bool,
    pub usage: Value,
    pub engine_duration_ms: Option<u64>,
}
#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub enabled: bool,
    pub cwd: String,
    #[serde(default)]
    pub roots: Vec<String>,
    #[serde(default)]
    pub title: String,
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub enabled: bool,
    pub preparing: bool,
    pub pending_bytes: u64,
    pub written_bytes: u64,
    pub events: u64,
    pub file_count: u64,
    pub file_bytes: u64,
    pub last_saved_at: u64,
    pub error: Option<String>,
    pub coverage_errors: u64,
}

pub struct Captured {
    pub at: u64,
    pub source: String,
    pub kind: String,
    pub preview: String,
    pub payload: Vec<u8>,
    pub activity: Option<timeline::Activity>,
}
impl Captured {
    pub fn new(source: &str, v: &Value) -> Self {
        let kind = v
            .get("type")
            .or_else(|| v.get("method"))
            .and_then(Value::as_str)
            .unwrap_or("event");
        let p = v
            .get("text")
            .or_else(|| v.get("delta"))
            .or_else(|| v.get("prompt"))
            .or_else(|| v.pointer("/message/content"))
            .or_else(|| v.pointer("/tool/name"))
            .or_else(|| v.pointer("/tool/target"))
            .or_else(|| v.get("path"))
            .or_else(|| v.pointer("/line/text"))
            .or_else(|| v.get("result"))
            .and_then(Value::as_str)
            .unwrap_or(kind);
        let text = message_text(v.pointer("/message/content").unwrap_or(&Value::Null));
        Self {
            at: now_ms(),
            source: source.into(),
            kind: kind.into(),
            preview: preview(if !text.is_empty() { &text } else { p }, 320),
            payload: serde_json::to_vec(v).unwrap_or_else(|_| b"null".to_vec()),
            activity: timeline::describe(source, v),
        }
    }
}
enum Job {
    Event(Captured),
    Flush(std::sync::mpsc::Sender<Result<(), String>>),
    Star(String, bool, std::sync::mpsc::Sender<Result<(), String>>),
    Stop,
}
struct Pending {
    jobs: VecDeque<Job>,
    bytes: usize,
    closed: bool,
}
struct Queue {
    pending: Mutex<Pending>,
    available: Condvar,
    room: Condvar,
    stopping: AtomicBool,
}
const QUEUE_BYTES: usize = 16 * 1024 * 1024;
impl Queue {
    fn new() -> Self {
        Self {
            pending: Mutex::new(Pending {
                jobs: VecDeque::new(),
                bytes: 0,
                closed: false,
            }),
            available: Condvar::new(),
            room: Condvar::new(),
            stopping: AtomicBool::new(false),
        }
    }
    fn push(&self, job: Job) -> bool {
        if matches!(&job, Job::Stop) {
            self.stopping.store(true, Ordering::Release);
            self.available.notify_all();
        }
        let bytes = match &job {
            Job::Event(e) => e.payload.len(),
            _ => 0,
        };
        let mut p = lock(&self.pending);
        // Bounded backpressure instead of dropping records or growing unbounded.
        // One oversize engine frame is allowed when the queue is otherwise empty.
        while !p.closed && p.bytes > 0 && p.bytes.saturating_add(bytes) > QUEUE_BYTES {
            p = self.room.wait(p).unwrap_or_else(|e| e.into_inner());
        }
        if p.closed {
            return false;
        }
        p.bytes += bytes;
        p.jobs.push_back(job);
        self.available.notify_one();
        true
    }
    fn pop(&self) -> Option<Job> {
        let mut p = lock(&self.pending);
        if p.jobs.is_empty() && !p.closed {
            p = self
                .available
                .wait_timeout(p, Duration::from_millis(250))
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
        let job = p.jobs.pop_front();
        if let Some(Job::Event(e)) = &job {
            p.bytes -= e.payload.len();
            self.room.notify_all();
        }
        job
    }
    fn close(&self) {
        let mut p = lock(&self.pending);
        p.closed = true;
        self.room.notify_all();
        self.available.notify_all();
    }
}

pub struct Recorder {
    retired: AtomicBool,
    pub root: PathBuf,
    pub chat: String,
    pub config: RwLock<Config>,
    pub enabled: AtomicBool,
    pub status: Arc<Mutex<Status>>,
    queue: Arc<Queue>,
    files: Mutex<Option<files::Monitor>>,
    configure_lock: Mutex<()>,
    last_model: Mutex<String>,
    worker: Mutex<Option<std::thread::JoinHandle<()>>>,
}
impl Recorder {
    pub fn new(root: PathBuf, chat: String, config: Config) -> io::Result<Arc<Self>> {
        let journal = journal::Journal::open(&root, &chat)?;
        let status = Arc::new(Mutex::new(Status::default()));
        let queue = Arc::new(Queue::new());
        let q = queue.clone();
        let st = status.clone();
        let journal_dir = journal::chat_dir(&root, &chat)?;
        let worker = std::thread::Builder::new()
            .name("ccg-archive-journal".into())
            .spawn(move || {
                let mut journal = journal;
                let mut blocked = false;
                let mut retry_event = None;
                loop {
                    if blocked {
                        match journal.flush(true) {
                            Ok(()) => {
                                blocked = false;
                                let mut s = lock(&st);
                                s.last_saved_at = now_ms();
                                if s.error
                                    .as_ref()
                                    .is_some_and(|e| e.starts_with("기록 저장 실패:"))
                                {
                                    s.error = None;
                                }
                            }
                            Err(e) => {
                                lock(&st).error = Some(format!("기록 저장 실패: {e}"));
                                if q.stopping.load(Ordering::Acquire) {
                                    q.close();
                                    break;
                                }
                                std::thread::sleep(Duration::from_millis(300));
                                continue;
                            }
                        }
                    }
                    match retry_event.take().map(Job::Event).or_else(|| q.pop()) {
                        Some(Job::Event(ev)) => {
                            let bytes = ev.payload.len() as u64;
                            let before = journal.sequence();
                            match journal.append(&ev) {
                                Ok(()) => {
                                    let mut s = lock(&st);
                                    s.events += 1;
                                    s.written_bytes += bytes;
                                }
                                Err(e) => {
                                    lock(&st).error = Some(format!("기록 저장 실패: {e}"));
                                    blocked = true;
                                    if journal.sequence() == before {
                                        retry_event = Some(ev);
                                    }
                                }
                            }
                        }
                        Some(Job::Flush(reply)) => {
                            let result = journal.flush(true).map_err(|e| e.to_string());
                            if let Err(e) = &result {
                                lock(&st).error = Some(format!("기록 저장 실패: {e}"));
                                blocked = true;
                            } else {
                                lock(&st).last_saved_at = now_ms();
                            }
                            let _ = reply.send(result);
                        }
                        Some(Job::Star(id, starred, reply)) => {
                            let result = journal
                                .flush(true)
                                .and_then(|_| journal::set_star(&journal_dir, &id, starred))
                                .map_err(|e| e.to_string());
                            let _ = reply.send(result);
                        }
                        Some(Job::Stop) => {
                            if let Err(e) = journal.flush(true) {
                                lock(&st).error = Some(e.to_string());
                            }
                            q.close();
                            break;
                        }
                        None => {
                            if let Err(e) = journal.flush(false) {
                                lock(&st).error = Some(format!("기록 저장 실패: {e}"));
                                blocked = true;
                            } else {
                                lock(&st).last_saved_at = now_ms();
                            }
                        }
                    }
                }
            })?;
        Ok(Arc::new(Self {
            retired: AtomicBool::new(false),
            root,
            chat,
            config: RwLock::new(config),
            enabled: AtomicBool::new(false),
            status,
            queue,
            files: Mutex::new(None),
            configure_lock: Mutex::new(()),
            last_model: Mutex::new(String::new()),
            worker: Mutex::new(Some(worker)),
        }))
    }
    pub fn record(&self, source: &str, v: &Value) {
        if !self.enabled.load(Ordering::Relaxed) {
            return;
        }
        if let Some(m) = lock(&self.files).as_ref() {
            m.observe(source, v);
        }
        let reported = if source == "identity" {
            v.pointer("/engine/model").and_then(Value::as_str)
        } else if source == "ui" && v["type"] == "session" {
            v.get("model").and_then(Value::as_str)
        } else if source == "protocol-in" {
            v.pointer("/message/model").and_then(Value::as_str)
        } else {
            None
        };
        if let Some(model) = reported {
            *lock(&self.last_model) = model.into();
        }
        if source == "ui" && v["type"] == "assistant-done" {
            let mut saved = v.clone();
            saved["_archiveModel"] = json!(*lock(&self.last_model));
            self.enqueue(Captured::new(source, &saved));
        } else {
            self.enqueue(Captured::new(source, v));
        }
        if source == "protocol-in" {
            if let Some(blocks) = v.pointer("/message/content").and_then(Value::as_array) {
                for block in blocks {
                    if matches!(block["type"].as_str(), Some("tool_use" | "tool_result")) {
                        self.enqueue(Captured::new("tool", block));
                    }
                }
            }
            if let Some(item) = v.pointer("/params/item") {
                if matches!(
                    item["type"].as_str(),
                    Some(
                        "commandExecution"
                            | "fileChange"
                            | "mcpToolCall"
                            | "dynamicToolCall"
                            | "webSearch"
                            | "imageGeneration"
                            | "collabAgentToolCall"
                            | "subAgentActivity"
                    )
                ) {
                    self.enqueue(Captured::new(
                        "tool",
                        &json!({"type":v["method"],"item":item}),
                    ));
                }
            }
        }
    }
    pub fn enqueue(&self, event: Captured) {
        if !self.queue.push(Job::Event(event)) {
            lock(&self.status).error = Some("기록 저장 스레드가 종료되었습니다.".into());
        }
    }
    pub fn configure(self: &Arc<Self>, mut config: Config) -> io::Result<()> {
        let _serial = lock(&self.configure_lock);
        if self.retired.load(Ordering::Acquire) {
            return Err(invalid(
                "삭제된 보관 세션입니다. 기록을 다시 켜려면 새로 시도해 주세요.",
            ));
        }
        if !config.enabled {
            self.queue.stopping.store(true, Ordering::Release);
        }
        if config.enabled && config.roots.is_empty() {
            config.roots.push(config.cwd.clone());
        }
        if config.enabled
            && self.enabled.load(Ordering::Acquire)
            && *self.config.read().unwrap_or_else(|e| e.into_inner()) == config
        {
            return Ok(());
        }
        self.enabled.store(false, Ordering::Release);
        if let Some(old) = lock(&self.files).take() {
            old.stop();
        }
        if config.enabled {
            if config.cwd.trim().is_empty() {
                return Err(invalid("기록할 작업 폴더를 먼저 선택해 주세요."));
            }
            if config.roots.is_empty() {
                config.roots.push(config.cwd.clone());
            }
            {
                let mut s = lock(&self.status);
                s.preparing = true;
                s.enabled = false;
                s.error = None;
            }
            let weak = Arc::downgrade(self);
            let sink: files::Sink = Arc::new(move |e| {
                if let Some(r) = weak.upgrade() {
                    r.enqueue(e);
                }
            });
            match files::Monitor::start(
                self.root.clone(),
                self.chat.clone(),
                config.roots.clone(),
                sink,
                self.status.clone(),
            ) {
                Ok(m) => {
                    *lock(&self.files) = Some(m);
                    self.enabled.store(true, Ordering::Release);
                }
                Err(e) => {
                    let mut s = lock(&self.status);
                    s.preparing = false;
                    s.error = Some(e.to_string());
                    return Err(e);
                }
            }
        }
        *self.config.write().unwrap_or_else(|e| e.into_inner()) = config.clone();
        {
            let mut s = lock(&self.status);
            s.enabled = config.enabled;
            s.preparing = false;
        }
        self.enqueue(Captured::new("lifecycle",&json!({"type":if config.enabled{"recording-enabled"}else{"recording-paused"},"config":config})));
        self.flush()?;
        crate::write_atomic(
            &journal::chat_dir(&self.root, &self.chat)?.join("config.json"),
            &serde_json::to_string(&config)?,
        )
    }
    pub fn status(&self) -> Value {
        let mut s = lock(&self.status).clone();
        s.pending_bytes = lock(&self.queue.pending).bytes as u64;
        s.written_bytes = journal::chat_dir(&self.root, &self.chat)
            .and_then(|dir| std::fs::metadata(dir.join("events.jsonl")))
            .map(|m| m.len())
            .unwrap_or(s.written_bytes);
        json!({"chatId":self.chat,"root":self.root,"config":*self.config.read().unwrap_or_else(|e|e.into_inner()),"status":s})
    }
    pub fn flush(&self) -> io::Result<()> {
        let (tx, rx) = std::sync::mpsc::channel();
        if !self.queue.push(Job::Flush(tx)) {
            return Err(invalid("Archive writer is closed"));
        }
        rx.recv_timeout(Duration::from_secs(30))
            .map_err(|_| invalid("기록 저장 응답이 지연되고 있습니다."))?
            .map_err(|s| io::Error::other(s))
    }
    pub fn checkpoint(&self) {
        if let Some(m) = lock(&self.files).as_ref() {
            m.checkpoint();
        }
    }
    pub fn star(&self, id: String, starred: bool) -> io::Result<()> {
        let (tx, rx) = std::sync::mpsc::channel();
        if !self.queue.push(Job::Star(id, starred, tx)) {
            return Err(invalid("Archive writer is closed"));
        }
        rx.recv_timeout(Duration::from_secs(30))
            .map_err(|_| invalid("기록 저장 응답이 지연되고 있습니다."))?
            .map_err(io::Error::other)
    }
    pub fn flush_all(&self) -> io::Result<()> {
        let receiver = { lock(&self.files).as_ref().map(|m| m.checkpoint_request()) };
        if let Some(rx) = receiver {
            rx.recv_timeout(Duration::from_secs(30)).map_err(|_| {
                invalid("파일 보관을 계속 진행 중입니다. 잠시 뒤 다시 확인해 주세요.")
            })?;
        }
        self.flush()
    }
    pub fn shutdown(&self) {
        self.enabled.store(false, Ordering::Release);
        if let Some(m) = lock(&self.files).take() {
            m.stop();
        }
        let _ = self.queue.push(Job::Stop);
        if let Some(worker) = lock(&self.worker).take() {
            let _ = worker.join();
        }
    }
}

pub struct Archive {
    pub root: PathBuf,
    recorders: RwLock<HashMap<String, Arc<Recorder>>>,
    repaired: Mutex<HashSet<String>>,
}
impl Archive {
    pub fn new(root: PathBuf) -> io::Result<Self> {
        std::fs::create_dir_all(&root)?;
        let canonical = std::fs::canonicalize(&root)?;
        #[cfg(windows)]
        let root = {
            let s = canonical.to_string_lossy();
            PathBuf::from(if let Some(p) = s.strip_prefix("\\\\?\\UNC\\") {
                format!("\\\\{p}")
            } else {
                s.strip_prefix("\\\\?\\").unwrap_or(&s).to_string()
            })
        };
        #[cfg(not(windows))]
        let root = canonical;
        let marker = root.join("format.json");
        if marker.exists() {
            let v: Value = serde_json::from_slice(&std::fs::read(&marker)?)?;
            if v["format"] != "agentcodegui-conversation-archive"
                || !matches!(v["version"].as_u64(), Some(1 | 2))
            {
                return Err(invalid("지원하지 않는 기록 폴더 형식입니다."));
            }
        }
        {
            crate::write_atomic(
                &marker,
                "{\"format\":\"agentcodegui-conversation-archive\",\"version\":2}",
            )?;
        }
        layout::retire_global_viewer(&root)?;
        Ok(Self {
            root,
            recorders: RwLock::new(HashMap::new()),
            repaired: Mutex::new(HashSet::new()),
        })
    }
    pub fn recorder(&self, chat: &str) -> io::Result<Arc<Recorder>> {
        if let Some(r) = self.find(chat) {
            if !lock(&r.queue.pending).closed {
                return Ok(r);
            }
        }
        let dir = journal::chat_dir(&self.root, chat)?;
        let config = std::fs::read(dir.join("config.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let mut map = self.recorders.write().unwrap_or_else(|e| e.into_inner());
        if let Some(r) = map.get(chat) {
            if !lock(&r.queue.pending).closed {
                return Ok(r.clone());
            }
        }
        if let Some(stopped) = map.remove(chat) {
            stopped.shutdown();
        }
        let r = Recorder::new(self.root.clone(), chat.into(), config)?;
        map.insert(chat.into(), r.clone());
        Ok(r)
    }
    pub fn find(&self, chat: &str) -> Option<Arc<Recorder>> {
        self.recorders
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(chat)
            .cloned()
    }
    pub fn saved_config(&self, chat: &str) -> io::Result<Config> {
        let path = journal::chat_dir(&self.root, chat)?.join("config.json");
        match std::fs::read(path) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Config::default()),
            Err(e) => Err(e),
        }
    }
    pub fn prepare_view(&self, chat: &str) -> io::Result<()> {
        let map = self.recorders.write().unwrap_or_else(|e| e.into_inner());
        if !map.contains_key(chat)
            && !lock(&self.repaired).contains(chat)
            && journal::chat_dir(&self.root, chat)?.exists()
        {
            // Recovery is lazy and exclusive of a live writer. Viewing an old chat
            // must not start a file watcher or keep its contents in memory.
            let _journal = journal::Journal::open(&self.root, chat)?;
            lock(&self.repaired).insert(chat.into());
        }
        Ok(())
    }
    pub fn rename_session(&self, chat: &str, title: &str) -> io::Result<()> {
        // Separate display metadata keeps a renamed archive title independent of
        // later recording configuration and preserves the original conversation.
        self.prepare_view(chat)?;
        let _map = self.recorders.write().unwrap_or_else(|e| e.into_inner());
        layout::rename_session(&self.root, chat, title)
    }
    pub fn delete_session(&self, chat: &str) -> io::Result<()> {
        let mut map = self.recorders.write().unwrap_or_else(|e| e.into_inner());
        layout::deletion_targets(&self.root, chat)?;
        let recorder = map.get(chat).cloned();
        let _configure = recorder.as_ref().map(|r| lock(&r.configure_lock));
        let mut config = if let Some(r) = &recorder {
            r.config.read().unwrap_or_else(|e| e.into_inner()).clone()
        } else {
            self.saved_config(chat)?
        };
        config.enabled = false;
        let dir = journal::chat_dir(&self.root, chat)?;
        if dir.exists() {
            crate::write_atomic(&dir.join("config.json"), &serde_json::to_string(&config)?)?;
        }
        if let Some(r) = &recorder {
            r.retired.store(true, Ordering::Release);
            *r.config.write().unwrap_or_else(|e| e.into_inner()) = config;
            r.shutdown();
        }
        map.remove(chat);
        lock(&self.repaired).remove(chat);
        layout::delete_session(&self.root, chat)
    }
    pub fn shutdown(&self) {
        let rs: Vec<_> = self
            .recorders
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .cloned()
            .collect();
        for r in rs {
            r.shutdown();
        }
    }
}
static GLOBAL: OnceLock<RwLock<Arc<Archive>>> = OnceLock::new();
static MANAGEMENT: Mutex<()> = Mutex::new(());
fn loaded() -> Option<Arc<Archive>> {
    GLOBAL
        .get()
        .map(|a| a.read().unwrap_or_else(|e| e.into_inner()).clone())
}
pub fn global() -> io::Result<Arc<Archive>> {
    if let Some(a) = loaded() {
        return Ok(a);
    }
    let settings = crate::read_home_json("archive-settings.json").unwrap_or(Value::Null);
    let root = settings
        .get("root")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::app_home().join("conversation-archive"));
    let archive = Arc::new(Archive::new(root)?);
    let _ = GLOBAL.set(RwLock::new(archive.clone()));
    Ok(loaded().unwrap_or(archive))
}
/// Hot path: no filesystem access, startup work, or payload clone when disabled.
pub fn record(chat: &str, source: &str, v: &Value) {
    if let Some(a) = loaded() {
        if let Some(r) = a.find(chat) {
            r.record(source, v);
        }
    }
}
pub fn enabled(chat: &str) -> bool {
    loaded()
        .and_then(|a| a.find(chat))
        .is_some_and(|r| r.enabled.load(Ordering::Relaxed))
}
pub fn checkpoint(chat: &str) {
    if let Some(a) = loaded() {
        if let Some(r) = a.find(chat) {
            r.checkpoint();
        }
    }
}
pub fn bootstrap() {
    // Historic chats stay on disk. Their recording preference is activated lazily
    // before the next request, rather than starting hundreds of watchers at boot.
    let _ = global();
}
pub fn shutdown() {
    if let Some(a) = loaded() {
        a.shutdown();
    }
}
/// Release backpressure on shutdown if storage has failed. Healthy writers still
/// drain every queued event before their ordered Stop command.
pub fn request_shutdown() {
    if let Some(a) = loaded() {
        for r in a
            .recorders
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .values()
        {
            r.queue.stopping.store(true, Ordering::Release);
        }
    }
}

/// Runs on the IPC blocking pool before a user request reaches the engine hub.
/// Rebind file capture when a chat changes working/reference directories.
pub fn prepare_run(chat: &str, request: &Value) -> io::Result<()> {
    // Serialize restoration with deletion/root changes, including the gap between
    // reading an enabled preference and constructing its recorder.
    let _management = lock(&MANAGEMENT);
    let Some(a) = loaded() else { return Ok(()) };
    let r = if let Some(r) = a.find(chat) {
        r
    } else {
        if !a.saved_config(chat)?.enabled {
            return Ok(());
        }
        a.recorder(chat)?
    };
    let mut c = r.config.read().unwrap_or_else(|e| e.into_inner()).clone();
    if !c.enabled && !lock(&r.status).preparing {
        return Ok(());
    }
    // A restored recorder starts disabled until its baseline is ready. configure
    // serializes with the background restore and skips an already prepared config.
    if let Some(cwd) = request
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        if c.cwd.replace('\\', "/").to_lowercase() != cwd.replace('\\', "/").to_lowercase() {
            c.cwd = cwd.into();
            c.roots = vec![cwd.into()];
        }
    }
    if let Some(dirs) = request
        .get("addDirs")
        .or_else(|| request.get("refDirs"))
        .and_then(Value::as_array)
    {
        c.roots = std::iter::once(c.cwd.clone())
            .chain(dirs.iter().filter_map(Value::as_str).map(str::to_string))
            .collect();
    }
    c.enabled = true;
    r.configure(c)
}

pub fn dispatch(channel: &str, p: &Value) -> Option<Value> {
    if !channel.starts_with("archive:") {
        return None;
    }
    Some(match dispatch_inner(channel, p) {
        Ok(v) => v,
        Err(e) => json!({"ok":false,"error":e.to_string()}),
    })
}
fn dispatch_inner(channel: &str, p: &Value) -> io::Result<Value> {
    let _management = if matches!(
        channel,
        "archive:configure"
            | "archive:set-root"
            | "archive:import"
            | "archive:rename"
            | "archive:delete"
    ) {
        Some(lock(&MANAGEMENT))
    } else {
        None
    };
    let a = global()?;
    let arg = p.as_array().and_then(|a| a.first()).unwrap_or(p);
    let chat = arg.get("chatId").and_then(Value::as_str).unwrap_or("");
    let get_num = |key: &str, default: u64| arg.get(key).and_then(Value::as_u64).unwrap_or(default);
    let get_str = |key: &str| arg.get(key).and_then(Value::as_str).unwrap_or("");
    if matches!(channel, "archive:rename" | "archive:delete")
        && std::fs::canonicalize(get_str("root"))? != std::fs::canonicalize(&a.root)?
    {
        return Err(invalid(
            "보관 위치가 바뀌었습니다. 새로고침한 뒤 다시 시도해 주세요.",
        ));
    }
    if matches!(
        channel,
        "archive:entries"
            | "archive:payload"
            | "archive:turns"
            | "archive:object"
            | "archive:materialize"
            | "archive:session-folder"
            | "archive:star"
    ) {
        a.prepare_view(chat)?;
    }
    match channel {
        "archive:rename" => {
            a.rename_session(chat, get_str("title"))?;
            Ok(json!({"ok":true}))
        }
        "archive:delete" => {
            a.delete_session(chat)?;
            Ok(json!({"ok":true}))
        }
        "archive:import" => layout::import(&a.root, &PathBuf::from(get_str("path"))),
        "archive:session-folder" => {
            let dir = layout::session_dir(&a.root, chat)?;
            if !dir.join("Chat/format.json").exists() {
                return Err(invalid("보관된 세션이 없습니다."));
            }
            if let Some(r) = a.find(chat) {
                r.flush_all()?;
            }
            Ok(json!({"path":dir}))
        }
        "archive:sessions" => {
            journal::session_page(&a.root, get_num("offset", 0) as usize, get_str("query"))
        }
        "archive:set-root" => {
            if a.recorders
                .read()
                .unwrap_or_else(|e| e.into_inner())
                .values()
                .any(|r| r.enabled.load(Ordering::Acquire) || lock(&r.status).preparing)
            {
                return Err(invalid(
                    "저장 위치를 바꾸려면 켜져 있는 대화 기록을 먼저 꺼 주세요.",
                ));
            }
            let root = PathBuf::from(get_str("path"));
            if !root.is_absolute() {
                return Err(invalid("절대 경로의 저장 폴더를 선택해 주세요."));
            }
            let next = Arc::new(Archive::new(root.clone())?);
            crate::write_home_file(
                "archive-settings.json",
                &serde_json::to_string(&json!({"root":root}))?,
            )?;
            a.shutdown();
            if let Some(slot) = GLOBAL.get() {
                *slot.write().unwrap_or_else(|e| e.into_inner()) = next.clone();
            }
            Ok(json!({"root":root,"previousRoot":a.root}))
        }
        "archive:status" => {
            if let Some(r) = a.find(chat) {
                Ok(r.status())
            } else {
                let config = a.saved_config(chat)?;
                let status = Status {
                    enabled: config.enabled,
                    written_bytes: std::fs::metadata(
                        journal::chat_dir(&a.root, chat)?.join("events.jsonl"),
                    )
                    .map(|m| m.len())
                    .unwrap_or(0),
                    ..Default::default()
                };
                Ok(json!({"chatId":chat,"root":a.root,"config":config,"status":status}))
            }
        }
        "archive:configure" => {
            let config: Config =
                serde_json::from_value(arg.get("config").cloned().unwrap_or(Value::Null))?;
            let r = a.recorder(chat)?;
            r.configure(config)?;
            let status = r.status();
            if !r.enabled.load(Ordering::Acquire) {
                r.shutdown();
                a.recorders
                    .write()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(chat);
            }
            Ok(status)
        }
        "archive:flush" => {
            if let Some(r) = a.find(chat) {
                r.flush_all()?;
            }
            Ok(json!({"ok":true}))
        }
        "archive:entries" => journal::list_entries_range(
            &journal::chat_dir(&a.root, chat)?,
            get_num("from", 1),
            get_num("limit", 60) as usize,
            get_str("source"),
            get_str("turnId"),
            get_str("query"),
            get_num("to", u64::MAX),
        ),
        "archive:payload" => journal::payload_page(
            &journal::chat_dir(&a.root, chat)?,
            get_num("seq", 0),
            get_num("offset", 0),
        ),
        "archive:turns" => journal::turn_page(
            &journal::chat_dir(&a.root, chat)?,
            get_num("offset", 0) as usize,
        ),
        "archive:star" => {
            if let Some(r) = a.find(chat) {
                r.star(
                    get_str("turnId").into(),
                    arg.get("starred") == Some(&Value::Bool(true)),
                )?;
            } else {
                journal::set_star(
                    &journal::chat_dir(&a.root, chat)?,
                    get_str("turnId"),
                    arg.get("starred") == Some(&Value::Bool(true)),
                )?;
            }
            Ok(json!({"ok":true}))
        }
        "archive:object" => {
            files::object_page(&a.root, chat, get_str("hash"), get_num("offset", 0))
        }
        "archive:materialize" => {
            Ok(json!({"path":files::materialize(&a.root,chat,get_str("hash"),get_str("name"))?}))
        }
        "archive:chats" => {
            let mut rows = vec![];
            if let Ok(entries) = std::fs::read_dir(a.root.join("chats")) {
                for entry in entries.flatten() {
                    let id = entry.file_name().to_string_lossy().into_owned();
                    if !journal::valid_id(&id) {
                        continue;
                    }
                    let dir = journal::chat_dir(&a.root, &id)?;
                    let config = std::fs::read(dir.join("config.json"))
                        .ok()
                        .and_then(|b| serde_json::from_slice::<Config>(&b).ok())
                        .unwrap_or_default();
                    let title = layout::title_override(&dir).unwrap_or_else(|| {
                        if config.title.is_empty() {
                            std::fs::read(dir.join("active.json"))
                                .ok()
                                .and_then(|b| serde_json::from_slice::<Turn>(&b).ok())
                                .map(|t| t.title)
                                .unwrap_or_default()
                        } else {
                            config.title
                        }
                    });
                    rows.push(json!({"chatId":id,"title":title,"cwd":config.cwd,"events":journal::entry_count(&dir)}));
                }
            }
            Ok(json!({"items":rows,"root":a.root}))
        }
        _ => Err(invalid("Unknown archive command")),
    }
}
