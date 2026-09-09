//! Append-only payloads + compact, rebuildable index. Payloads are never shortened.
//! Readers only see committed index rows; a torn final payload/index is recovered.
use super::{Captured, Config, Entry, Turn};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const INDEX_STRIDE: u64 = 16;
pub struct Journal {
    dir: PathBuf,
    data: File,
    index: File,
    headers: File,
    pending_data: Vec<u8>,
    pending_headers: Vec<u8>,
    pending_index: Vec<u8>,
    committed_data: u64,
    committed_headers: u64,
    committed_index: u64,
    data_pos: u64,
    header_pos: u64,
    sequence: u64,
    turn: Option<Turn>,
    identity: Value,
    run_turns: HashMap<String, String>,
    tool_activities: HashMap<String, super::timeline::Activity>,
    coverage_incomplete: bool,
    changed: bool,
    last_flush: Instant,
}

fn append_file(path: &Path) -> io::Result<File> {
    // FILE_APPEND_DATA handles cannot SetEndOfFile on Windows. The sole writer
    // owns a read/write handle positioned at EOF, also usable for tail recovery.
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)?;
    file.seek(SeekFrom::End(0))?;
    Ok(file)
}
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 160
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}
pub fn chat_dir(root: &Path, chat: &str) -> io::Result<PathBuf> {
    super::layout::log_dir(root, chat)
}

impl Journal {
    pub fn open(root: &Path, chat: &str) -> io::Result<Self> {
        super::layout::ensure(root, chat)?;
        let dir = chat_dir(root, chat)?;
        fs::create_dir_all(dir.join("turns"))?;
        let (sequence, data_pos, header_pos) = recover(&dir)?;
        // A running turn from a prior process is interrupted, never relabeled completed.
        let active = dir.join("active.json");
        if let Ok(bytes) = fs::read(&active) {
            if let Ok(mut turn) = serde_json::from_slice::<Turn>(&bytes) {
                if turn.ended_at.is_none() {
                    turn.status = "interrupted".into();
                    turn.ended_at = Some(turn.updated_at);
                    turn.duration_ms = turn.updated_at.saturating_sub(turn.started_at);
                    turn.incomplete = true;
                    save_turn(&dir, &turn)?;
                }
            }
        }
        Ok(Self {
            data: append_file(&dir.join("events.jsonl"))?,
            headers: append_file(&dir.join("entries.jsonl"))?,
            index: append_file(&dir.join("entries.idx"))?,
            pending_data: Vec::new(),
            pending_headers: Vec::new(),
            pending_index: Vec::new(),
            committed_data: data_pos,
            committed_headers: header_pos,
            committed_index: sequence * INDEX_STRIDE,
            dir,
            data_pos,
            header_pos,
            sequence,
            turn: None,
            identity: Value::Null,
            run_turns: HashMap::new(),
            tool_activities: HashMap::new(),
            coverage_incomplete: false,
            changed: false,
            last_flush: Instant::now(),
        })
    }

    pub fn sequence(&self) -> u64 {
        self.sequence
    }
    #[cfg(test)]
    pub(super) fn replace_index_handle(&mut self, file: File) -> File {
        std::mem::replace(&mut self.index, file)
    }
    pub fn append(&mut self, event: &Captured) -> io::Result<()> {
        let payload = if matches!(
            event.source.as_str(),
            "input" | "ui" | "identity" | "request" | "lifecycle"
        ) || (event.source == "protocol-in"
            && matches!(event.kind.as_str(), "result" | "turn/completed"))
        {
            serde_json::from_slice::<Value>(&event.payload).ok()
        } else {
            None
        };
        if event.source == "identity" {
            self.identity = payload.clone().unwrap_or(Value::Null);
        }
        if matches!(event.kind.as_str(), "capture-error" | "coverage-gap") {
            self.coverage_incomplete = true;
        }
        if event.source == "input" && event.kind == "user" {
            if self.turn.as_ref().is_some_and(|t| t.ended_at.is_none()) {
                // Steering is a message in the current turn, not an invented completed turn.
            } else {
                self.flush(false)?;
                let p = payload.as_ref().unwrap_or(&Value::Null);
                let text =
                    super::message_text(p.pointer("/message/content").unwrap_or(&Value::Null));
                let text = if text.is_empty() {
                    event.preview.clone()
                } else {
                    text
                };
                let id = format!("t{}-{}", event.at, self.sequence + 1);
                let parent = self.turn.as_ref().map(|t| t.id.clone()).or_else(|| {
                    fs::read(self.dir.join("active.json"))
                        .ok()
                        .and_then(|b| serde_json::from_slice::<Turn>(&b).ok())
                        .map(|t| t.id)
                });
                let cwd = self
                    .identity
                    .get("cwd")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let model = self
                    .identity
                    .pointer("/engine/model")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                self.turn = Some(Turn {
                    id,
                    parent_id: parent,
                    title: super::preview(&text, 100),
                    started_at: event.at,
                    updated_at: event.at,
                    ended_at: None,
                    duration_ms: 0,
                    waiting_ms: 0,
                    wait_started_at: None,
                    status: "running".into(),
                    model,
                    cwd,
                    identity: self.identity.clone(),
                    first_seq: self.sequence + 1,
                    last_seq: self.sequence + 1,
                    events: 0,
                    files: 0,
                    bytes: 0,
                    incomplete: self.coverage_incomplete,
                    starred: false,
                    usage: Value::Null,
                    engine_duration_ms: None,
                });
            }
        }
        // The engine can drain the next queued turn before the prior turn's UI
        // events are fanned out. Bind UI run IDs instead of attaching them to the
        // most recently sent prompt.
        let run = payload
            .as_ref()
            .and_then(|v| v.get("runId"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if event.source == "ui" && !run.is_empty() && !self.run_turns.contains_key(run) {
            if let Some(t) = &self.turn {
                self.run_turns.insert(run.into(), t.id.clone());
            }
        }
        let routed = self
            .run_turns
            .get(run)
            .cloned()
            .filter(|id| self.turn.as_ref().is_some_and(|t| &t.id != id));
        let mut current = None;
        if let Some(id) = routed {
            let path = self.dir.join("turns").join(format!("{id}.json"));
            if let Ok(bytes) = fs::read(path) {
                if let Ok(t) = serde_json::from_slice::<Turn>(&bytes) {
                    current = self.turn.take();
                    self.turn = Some(t);
                }
            }
        }
        self.sequence += 1;
        let seq = self.sequence;
        let mut activity = event.activity.clone();
        if let Some(a) = activity.as_mut() {
            if !a.tool_id.is_empty() {
                if a.phase == "start" {
                    if self.tool_activities.len() >= 1024 {
                        self.tool_activities.clear();
                    }
                    self.tool_activities.insert(a.tool_id.clone(), a.clone());
                } else if let Some(start) = self.tool_activities.remove(&a.tool_id) {
                    if a.name.is_empty() {
                        a.name = start.name;
                        a.operation = start.operation;
                        a.target = start.target;
                    }
                }
            }
        }
        let mut entry = Entry {
            seq,
            at: event.at,
            source: event.source.clone(),
            kind: event.kind.clone(),
            preview: event.preview.clone(),
            turn_id: self.turn.as_ref().map(|t| t.id.clone()),
            offset: self.data_pos,
            length: 0,
            payload_bytes: event.payload.len() as u64,
            activity,
            file_group: None,
        };
        // Store the complete payload in a JSONL envelope, suitable for independent recovery.
        let mut envelope = serde_json::to_vec(&json!({
            "version": 1, "seq": seq, "at": entry.at, "source": entry.source,
            "kind": entry.kind, "preview": entry.preview, "turnId": entry.turn_id,
        }))?;
        envelope.pop();
        envelope.extend_from_slice(b",\"payload\":");
        self.pending_data.extend_from_slice(&envelope);
        self.pending_data.extend_from_slice(&event.payload);
        self.pending_data.extend_from_slice(b"}\n");
        entry.length = (envelope.len() + event.payload.len() + 2) as u64;
        let mut header = serde_json::to_vec(&entry)?;
        header.push(b'\n');
        self.pending_headers.extend_from_slice(&header);
        self.pending_index
            .extend_from_slice(&self.header_pos.to_le_bytes());
        self.pending_index
            .extend_from_slice(&(header.len() as u64).to_le_bytes());
        self.data_pos += entry.length;
        self.header_pos += header.len() as u64;
        if let Some(t) = &mut self.turn {
            t.last_seq = seq;
            t.events += 1;
            t.bytes += entry.length;
            t.updated_at = entry.at;
            if t.ended_at.is_none() {
                t.duration_ms = entry.at.saturating_sub(t.started_at);
            }
            if entry.source == "file" && entry.kind == "file-version" {
                t.files += 1;
            }
            if entry.kind == "capture-error" || entry.kind == "coverage-gap" {
                t.incomplete = true;
            }
            if let Some(v) = payload.as_ref() {
                if entry.source == "ui" {
                    match entry.kind.as_str() {
                        "session" => {
                            if let Some(m) = v.get("model").and_then(Value::as_str) {
                                t.model = m.into();
                            }
                            if let Some(c) = v.get("cwd").and_then(Value::as_str) {
                                t.cwd = c.into();
                            }
                        }
                        "permission-request" | "question-request"
                            if v.get("nonBlocking") != Some(&Value::Bool(true)) =>
                        {
                            t.wait_started_at.get_or_insert(entry.at);
                        }
                        "question-closed" => end_wait(t, entry.at),
                        "result" => {
                            end_wait(t, entry.at);
                            t.status = if v.get("isError") == Some(&Value::Bool(true)) {
                                "error"
                            } else {
                                "completed"
                            }
                            .into();
                            t.ended_at = Some(entry.at);
                            t.duration_ms = entry.at.saturating_sub(t.started_at);
                            t.engine_duration_ms = v.get("durationMs").and_then(Value::as_u64);
                            t.usage = json!({"tokenUsage":v.get("tokenUsage"),"costUsd":v.get("costUsd"),"viaApi":v.get("viaApi")});
                        }
                        "model-fallback" => {
                            if let Some(m) = v.get("to").and_then(Value::as_str) {
                                t.model = m.into();
                            }
                        }
                        _ => {}
                    }
                }
                if entry.source == "lifecycle"
                    && matches!(entry.kind.as_str(), "aborted" | "error" | "interrupted")
                    && (entry.kind != "interrupted" || t.ended_at.is_none())
                {
                    end_wait(t, entry.at);
                    t.status = entry.kind.clone();
                    t.ended_at = Some(entry.at);
                    t.duration_ms = entry.at.saturating_sub(t.started_at);
                }
                if entry.source == "lifecycle"
                    && entry.kind == "recording-paused"
                    && t.ended_at.is_none()
                {
                    end_wait(t, entry.at);
                    t.status = "recording-paused".into();
                    t.ended_at = Some(entry.at);
                    t.incomplete = true;
                }
                if entry.source == "protocol-in"
                    && matches!(entry.kind.as_str(), "result" | "turn/completed")
                {
                    end_wait(t, entry.at);
                    let status = v.pointer("/params/turn/status").and_then(Value::as_str);
                    t.status = if matches!(status, Some("interrupted")) {
                        "aborted"
                    } else if v.get("is_error") == Some(&Value::Bool(true))
                        || matches!(status, Some("failed"))
                    {
                        "error"
                    } else {
                        "completed"
                    }
                    .into();
                    t.ended_at = Some(entry.at);
                    t.duration_ms = entry.at.saturating_sub(t.started_at);
                }
                if entry.source == "identity" {
                    t.identity = v.clone();
                    if let Some(model) = v.pointer("/engine/model").and_then(Value::as_str) {
                        t.model = model.into();
                    }
                }
                if entry.source == "input" && entry.kind == "control_response" {
                    end_wait(t, entry.at);
                }
            }
        }
        self.changed = true;
        if entry.kind == "result"
            || entry.source == "lifecycle"
            || self.pending_data.len() >= 256 * 1024
            || self.last_flush.elapsed() >= Duration::from_millis(250)
        {
            self.flush(false)?;
        }
        if let Some(previous) = current {
            self.flush(false)?;
            self.turn = Some(previous);
            self.changed = true;
        }
        Ok(())
    }

    pub fn flush(&mut self, durable: bool) -> io::Result<()> {
        if !self.changed && !durable {
            return Ok(());
        }
        // A failed write keeps the complete transaction in memory. Retry overwrites
        // from committed offsets, never appends after a half-written JSON record.
        self.data.seek(SeekFrom::Start(self.committed_data))?;
        self.data.write_all(&self.pending_data)?;
        self.headers.seek(SeekFrom::Start(self.committed_headers))?;
        self.headers.write_all(&self.pending_headers)?;
        if durable {
            self.data.sync_data()?;
            self.headers.sync_data()?;
        }
        // Publish index rows only after all referenced bytes are written.
        self.index.seek(SeekFrom::Start(self.committed_index))?;
        self.index.write_all(&self.pending_index)?;
        if durable {
            self.index.sync_data()?;
        }
        if let Some(turn) = &self.turn {
            save_turn(&self.dir, turn)?;
        }
        self.committed_data = self.data_pos;
        self.committed_headers = self.header_pos;
        self.committed_index = self.sequence * INDEX_STRIDE;
        self.pending_data.clear();
        self.pending_headers.clear();
        self.pending_index.clear();
        self.changed = false;
        self.last_flush = Instant::now();
        Ok(())
    }
}
fn end_wait(t: &mut Turn, at: u64) {
    if let Some(start) = t.wait_started_at.take() {
        t.waiting_ms += at.saturating_sub(start);
    }
}
fn save_turn(dir: &Path, turn: &Turn) -> io::Result<()> {
    let path = dir.join("turns").join(format!("{}.json", turn.id));
    // The favorite belongs to the viewer, not to the live writer.
    let mut v = serde_json::to_value(turn)?;
    if let Ok(old) = fs::read(&path) {
        if let Ok(old) = serde_json::from_slice::<Value>(&old) {
            v["starred"] = old.get("starred").cloned().unwrap_or(json!(false));
        }
    }
    let content = serde_json::to_string(&v)?;
    crate::write_atomic(&path, &content)?;
    crate::write_atomic(&dir.join("active.json"), &content)
}

// Recover only the tail after the last committed index row; no full-history boot scan.
pub fn recover(dir: &Path) -> io::Result<(u64, u64, u64)> {
    let data_path = dir.join("events.jsonl");
    let header_path = dir.join("entries.jsonl");
    let index_path = dir.join("entries.idx");
    let mut data = append_file(&data_path)?;
    let mut headers = append_file(&header_path)?;
    let mut index = append_file(&index_path)?;
    let count = index.metadata()?.len() / INDEX_STRIDE;
    index.set_len(count * INDEX_STRIDE)?;
    let mut seq = 0;
    let mut pos = 0;
    let mut hpos = 0;
    if count > 0 {
        if let Ok(entry) = read_entry(dir, count) {
            let (off, len) = index_row(&mut index, count)?;
            if entry.offset + entry.length <= data.metadata()?.len() {
                seq = count;
                pos = entry.offset + entry.length;
                hpos = off + len;
            }
        }
    }
    headers.set_len(hpos)?;
    index.set_len(seq * INDEX_STRIDE)?;
    headers.seek(SeekFrom::Start(hpos))?;
    index.seek(SeekFrom::Start(seq * INDEX_STRIDE))?;
    data.seek(SeekFrom::Start(pos))?;
    let mut reader = BufReader::new(data.try_clone()?);
    let mut line = Vec::new();
    loop {
        line.clear();
        let n = reader.read_until(b'\n', &mut line)?;
        if n == 0 {
            break;
        }
        if line.last() != Some(&b'\n') {
            break;
        }
        let Ok(v) = serde_json::from_slice::<Value>(&line) else {
            break;
        };
        if v.get("seq").and_then(Value::as_u64) != Some(seq + 1) {
            break;
        }
        seq += 1;
        let entry = Entry {
            seq,
            at: v["at"].as_u64().unwrap_or(0),
            source: v["source"].as_str().unwrap_or("").into(),
            kind: v["kind"].as_str().unwrap_or("").into(),
            preview: v["preview"].as_str().unwrap_or("").into(),
            turn_id: v["turnId"].as_str().map(str::to_string),
            offset: pos,
            length: n as u64,
            payload_bytes: serde_json::to_vec(&v["payload"])?.len() as u64,
            activity: super::timeline::describe(v["source"].as_str().unwrap_or(""), &v["payload"]),
            file_group: None,
        };
        let mut h = serde_json::to_vec(&entry)?;
        h.push(b'\n');
        headers.write_all(&h)?;
        index.write_all(&hpos.to_le_bytes())?;
        index.write_all(&(h.len() as u64).to_le_bytes())?;
        pos += n as u64;
        hpos += h.len() as u64;
    }
    data.set_len(pos)?;
    Ok((seq, pos, hpos))
}
fn index_row(file: &mut File, seq: u64) -> io::Result<(u64, u64)> {
    if seq == 0 || seq > file.metadata()?.len() / INDEX_STRIDE {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "Archive event not found",
        ));
    }
    file.seek(SeekFrom::Start((seq - 1) * INDEX_STRIDE))?;
    let mut b = [0u8; 16];
    file.read_exact(&mut b)?;
    Ok((
        u64::from_le_bytes(b[..8].try_into().unwrap()),
        u64::from_le_bytes(b[8..].try_into().unwrap()),
    ))
}
pub fn read_entry(dir: &Path, seq: u64) -> io::Result<Entry> {
    let mut index = File::open(dir.join("entries.idx"))?;
    let (offset, len) = index_row(&mut index, seq)?;
    if len > 128 * 1024 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid archive index row",
        ));
    }
    let mut file = File::open(dir.join("entries.jsonl"))?;
    file.seek(SeekFrom::Start(offset))?;
    let mut bytes = vec![0; len as usize];
    file.read_exact(&mut bytes)?;
    Ok(serde_json::from_slice(&bytes)?)
}
pub fn entry_count(dir: &Path) -> u64 {
    fs::metadata(dir.join("entries.idx"))
        .map(|m| m.len() / INDEX_STRIDE)
        .unwrap_or(0)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    #[serde(skip)]
    sort_at: u64,
    pub chat_id: String,
    pub title: String,
    pub cwd: String,
    pub started_at: u64,
    pub updated_at: u64,
    pub events: u64,
    pub bytes: u64,
    pub enabled: bool,
    pub last_model: String,
}

/// A logical chat is one archived session, regardless of turns, model changes,
/// recording pauses or process restarts. Summaries read only small metadata and
/// the first/last index rows; opening the library never scans message payloads.
pub fn session_page(root: &Path, offset: usize, query: &str) -> io::Result<Value> {
    let directory = root.join("chats");
    if !directory.exists() {
        return Ok(json!({"items":[],"total":0,"next":null,"root":root}));
    }
    let query = query.trim().to_lowercase();
    let mut sessions = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let id = entry.file_name().to_string_lossy().into_owned();
        if !valid_id(&id) || !entry.file_type()?.is_dir() {
            continue;
        }
        let dir = chat_dir(root, &id)?;
        let events = entry_count(&dir);
        if events == 0 {
            continue;
        }
        let config = fs::read(dir.join("config.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<Config>(&b).ok())
            .unwrap_or_default();
        let active = fs::read(dir.join("active.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<Turn>(&b).ok());
        let first = read_entry(&dir, 1)?;
        let last = read_entry(&dir, events)?;
        let summary = SessionSummary {
            sort_at: last.at.max(super::layout::imported_at(&dir)),
            chat_id: id,
            title: super::layout::title_override(&dir).unwrap_or_else(|| {
                if config.title.is_empty() {
                    active.as_ref().map(|t| t.title.clone()).unwrap_or_default()
                } else {
                    config.title
                }
            }),
            cwd: if config.cwd.is_empty() {
                active.as_ref().map(|t| t.cwd.clone()).unwrap_or_default()
            } else {
                config.cwd
            },
            started_at: first.at,
            updated_at: last.at,
            events,
            bytes: last.offset + last.length,
            enabled: config.enabled,
            last_model: active.map(|t| t.model).unwrap_or_default(),
        };
        if !query.is_empty()
            && !format!(
                "{} {} {} {}",
                summary.title, summary.cwd, summary.chat_id, summary.last_model
            )
            .to_lowercase()
            .contains(&query)
        {
            continue;
        }
        sessions.push(summary);
    }
    sessions.sort_by(|a, b| {
        b.sort_at
            .cmp(&a.sort_at)
            .then_with(|| a.chat_id.cmp(&b.chat_id))
    });
    let total = sessions.len();
    let next = offset.saturating_add(60).min(total);
    let items: Vec<_> = sessions.into_iter().skip(offset).take(60).collect();
    Ok(json!({"items":items,"total":total,"next":if next<total{Some(next)}else{None},"root":root}))
}

pub fn list_entries(
    dir: &Path,
    from: u64,
    limit: usize,
    source: &str,
    turn: &str,
    query: &str,
) -> io::Result<Value> {
    list_entries_range(dir, from, limit, source, turn, query, u64::MAX)
}

pub fn list_entries_range(
    dir: &Path,
    from: u64,
    limit: usize,
    source: &str,
    turn: &str,
    query: &str,
    to: u64,
) -> io::Result<Value> {
    let total = entry_count(dir);
    let end = total.min(to);
    let mut rows: Vec<Entry> = vec![];
    let mut cursor = from.max(1);
    let mut examined = 0;
    if total == 0 {
        return Ok(json!({"items":[],"total":0,"next":null}));
    }
    let mut index = File::open(dir.join("entries.idx"))?;
    let mut headers = File::open(dir.join("entries.jsonl"))?;
    let mut data = None;
    let mut tool_names = HashMap::new();
    let query = query.to_lowercase();
    // Bound work even for sparse filters. The caller follows next until null.
    while cursor <= end && rows.len() < limit.clamp(1, 100) && examined < 4000 {
        let (offset, len) = index_row(&mut index, cursor)?;
        if len > 128 * 1024 {
            return Err(invalid_index());
        }
        headers.seek(SeekFrom::Start(offset))?;
        let mut bytes = vec![0; len as usize];
        headers.read_exact(&mut bytes)?;
        let mut row: Entry = serde_json::from_slice(&bytes)?;
        cursor += 1;
        examined += 1;
        // Enrich legacy result headers before filtering so failed runs remain
        // visible without exposing ordinary completion records from old archives.
        if source == "timeline"
            && (row.source == "tool" || row.source == "ui" && row.kind == "result")
            && row.activity.is_none()
            && row.length <= 128 * 1024
        {
            let file = match data.as_mut() {
                Some(f) => f,
                None => data.insert(File::open(dir.join("events.jsonl"))?),
            };
            file.seek(SeekFrom::Start(row.offset))?;
            let mut bytes = vec![0; row.length as usize];
            file.read_exact(&mut bytes)?;
            if let Ok(v) = serde_json::from_slice::<Value>(&bytes) {
                row.activity = super::timeline::describe(&row.source, &v["payload"]);
            }
        }
        let matches = match source {
            "timeline" => super::timeline::visible(&row),
            "diagnostics" => super::timeline::capture_issue(&row),
            "conversation" => {
                (row.source == "input" && row.kind == "user")
                    || (row.source == "ui" && row.kind == "assistant-done")
            }
            "tools" => {
                row.source == "tool"
                    || (row.source == "ui"
                        && matches!(
                            row.kind.as_str(),
                            "permission-request" | "question-request" | "question-closed"
                        ))
                    || row.source == "response"
            }
            "files" => {
                row.source == "file"
                    && matches!(row.kind.as_str(), "file-version" | "file-reference")
            }
            "" | "all" => true,
            _ => source == row.source,
        };
        if !matches {
            continue;
        }
        if !turn.is_empty() && row.turn_id.as_deref() != Some(turn) {
            continue;
        }
        if !query.is_empty()
            && !row.preview.to_lowercase().contains(&query)
            && !row.kind.to_lowercase().contains(&query)
        {
            continue;
        }
        if source == "timeline" {
            if let Some(a) = row.activity.as_mut() {
                if a.phase == "start" && !a.tool_id.is_empty() {
                    tool_names.insert(a.tool_id.clone(), a.clone());
                } else if let Some(start) = tool_names.get(&a.tool_id) {
                    if a.name.is_empty() {
                        a.name = start.name.clone();
                        a.operation = start.operation.clone();
                        a.target = start.target.clone();
                    }
                }
            }
            if row.source == "file"
                && matches!(row.kind.as_str(), "file-version" | "file-reference")
            {
                if let Some(previous) = rows.last_mut() {
                    if let Some(group) = previous.file_group.as_mut() {
                        group.end_seq = row.seq;
                        group.count += 1;
                        continue;
                    }
                }
                row.file_group = Some(super::timeline::FileGroup {
                    end_seq: row.seq,
                    count: 1,
                });
            }
        }
        rows.push(row);
    }
    Ok(json!({"items":rows,"total":total,"next":if cursor<=end{Some(cursor)}else{None}}))
}
fn invalid_index() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "Invalid archive index")
}
pub fn payload_page(dir: &Path, seq: u64, offset: u64) -> io::Result<Value> {
    let entry = read_entry(dir, seq)?;
    // Read the serialized event in bounded pages. Big outputs are stored in full.
    let available = entry.length.saturating_sub(offset);
    let take = available.min(128 * 1024);
    let mut file = File::open(dir.join("events.jsonl"))?;
    file.seek(SeekFrom::Start(entry.offset + offset.min(entry.length)))?;
    let mut data = vec![0; take as usize];
    file.read_exact(&mut data)?;
    // Do not split a UTF-8 codepoint between pages.
    if available > take {
        while !data.is_empty() && std::str::from_utf8(&data).is_err() {
            data.pop();
        }
    }
    let next = offset + data.len() as u64;
    Ok(
        json!({"text":String::from_utf8_lossy(&data),"totalBytes":entry.length,"next":if next<entry.length{Some(next)}else{None}}),
    )
}
pub fn turns(dir: &Path) -> io::Result<Vec<Turn>> {
    let mut rows = vec![];
    if !dir.join("turns").exists() {
        return Ok(rows);
    }
    for item in fs::read_dir(dir.join("turns"))? {
        let path = item?.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let bytes = fs::read(path)?;
        if let Ok(t) = serde_json::from_slice::<Turn>(&bytes) {
            rows.push(t)
        }
    }
    rows.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    Ok(rows)
}
pub fn turn_page(dir: &Path, offset: usize) -> io::Result<Value> {
    if !dir.join("turns").exists() {
        return Ok(json!({"items":[],"total":0,"next":null}));
    }
    let mut paths: Vec<_> = fs::read_dir(dir.join("turns"))?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("json"))
        .collect();
    let sequence = |p: &PathBuf| {
        p.file_stem()
            .and_then(|s| s.to_str())
            .and_then(|s| s.rsplit('-').next())
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0)
    };
    paths.sort_by_key(|p| std::cmp::Reverse(sequence(p)));
    let total = paths.len();
    let mut rows = vec![];
    for path in paths.into_iter().skip(offset).take(60) {
        let t: Turn = serde_json::from_slice(&fs::read(path)?)?;
        rows.push(t);
    }
    Ok(
        json!({"items":rows,"total":total,"next":if offset.saturating_add(60)<total{Some(offset+60)}else{None}}),
    )
}
pub fn set_star(dir: &Path, id: &str, starred: bool) -> io::Result<()> {
    if !valid_id(id) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Invalid turn ID",
        ));
    }
    let path = dir.join("turns").join(format!("{id}.json"));
    let mut t: Value = serde_json::from_slice(&fs::read(&path)?)?;
    t["starred"] = json!(starred);
    crate::write_atomic(&path, &serde_json::to_string(&t)?)
}
