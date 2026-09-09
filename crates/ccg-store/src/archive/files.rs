//! Immutable bytes, streamed to SHA-256 objects. Native change notifications avoid
//! project-wide polling; turn boundaries reconcile the directory inventory.
use super::{invalid, lock, now_ms, Captured, Status};
use notify::{EventKind, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};

pub type Sink = Arc<dyn Fn(Captured) + Send + Sync>;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Version {
    hash: Option<String>,
    bytes: u64,
    modified: u128,
    link: Option<String>,
}
fn modified(m: &fs::Metadata) -> u128 {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}
pub(super) fn is_link(m: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if m.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    m.file_type().is_symlink()
}
fn key(path: &Path) -> String {
    let s = path.to_string_lossy().replace('\\', "/");
    let s = if let Some(p) = s.strip_prefix("//?/UNC/") {
        format!("//{p}")
    } else {
        s.strip_prefix("//?/").unwrap_or(&s).to_string()
    };
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}
fn inside(path: &Path, root: &Path) -> bool {
    let p = key(path);
    let r = key(root).trim_end_matches('/').to_string();
    p == r || p.starts_with(&(r + "/"))
}
fn map_key(path: &Path) -> PathBuf {
    let parent = path.parent().and_then(|p| fs::canonicalize(p).ok());
    PathBuf::from(key(&parent
        .and_then(|p| path.file_name().map(|f| p.join(f)))
        .unwrap_or_else(|| path.to_path_buf())))
}
pub(super) fn object_path(root: &Path, hash: &str) -> io::Result<PathBuf> {
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(invalid("Invalid archive object ID"));
    }
    Ok(root.join("objects").join(&hash[..2]).join(hash))
}
static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);
pub fn store_file(root: &Path, path: &Path) -> io::Result<(String, u64)> {
    let temp_dir = root.join("pending");
    fs::create_dir_all(&temp_dir)?;
    let tmp = temp_dir.join(format!(
        "{}-{}-{}.tmp",
        std::process::id(),
        now_ms(),
        TEMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let outcome = (|| {
        let mut input = File::open(path)?;
        let mut output = OpenOptions::new().create_new(true).write(true).open(&tmp)?;
        let mut hash = Sha256::new();
        let mut bytes = 0;
        let mut buffer = vec![0u8; 128 * 1024];
        loop {
            let n = input.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            hash.update(&buffer[..n]);
            output.write_all(&buffer[..n])?;
            bytes += n as u64;
        }
        output.sync_data()?;
        drop(output);
        let digest = format!("{:x}", hash.finalize());
        let destination = object_path(root, &digest)?;
        fs::create_dir_all(destination.parent().unwrap())?;
        if destination.exists() {
            if fs::metadata(&destination)?.len() != bytes {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Archive object size mismatch",
                ));
            }
        } else {
            fs::rename(&tmp, &destination)?;
        }
        Ok((digest, bytes))
    })();
    // Only our create_new temporary file is removed, never workspace files.
    let _ = fs::remove_file(&tmp);
    outcome
}
#[derive(Default)]
struct Work {
    paths: BTreeMap<PathBuf, String>,
    rescan: bool,
    stop: bool,
    overflow: bool,
    notices: Vec<Value>,
    barriers: Vec<std::sync::mpsc::Sender<()>>,
    retry_targets: bool,
}
struct Signals {
    work: Mutex<Work>,
    wake: Condvar,
}
impl Signals {
    fn touch(&self, path: PathBuf, why: &str) {
        let mut w = lock(&self.work);
        if w.paths.len() < 4096 {
            w.paths.insert(path, why.into());
        } else {
            w.rescan = true;
            w.overflow = true;
        }
        self.wake.notify_one();
    }
}
pub struct Monitor {
    signals: Arc<Signals>,
    thread: Option<std::thread::JoinHandle<()>>,
    cwd: PathBuf,
}
impl Monitor {
    pub fn start(
        root: PathBuf,
        chat: String,
        roots: Vec<String>,
        sink: Sink,
        status: Arc<Mutex<Status>>,
    ) -> io::Result<Self> {
        let mut dirs: Vec<PathBuf> = vec![];
        for r in roots {
            let path = fs::canonicalize(&r)?;
            if !path.is_dir() {
                return Err(invalid("기록할 작업 폴더가 없습니다."));
            }
            if inside(&path, &root) {
                return Err(invalid(
                    "기록 저장소 자체를 작업 폴더로 기록할 수 없습니다.",
                ));
            }
            if !dirs.iter().any(|p| inside(&path, p)) {
                dirs.push(path);
            }
        }
        if dirs.is_empty() {
            return Err(invalid("기록할 작업 폴더가 없습니다."));
        }
        let signals = Arc::new(Signals {
            work: Mutex::new(Work::default()),
            wake: Condvar::new(),
        });
        let s = signals.clone();
        let watch_root = root.clone();
        let mut watcher=notify::recommended_watcher(move|result:notify::Result<notify::Event>|{
            match result {
                Ok(event)=>{if matches!(event.kind,EventKind::Access(_)){return}
                    let paths:Vec<_>=event.paths.into_iter().filter(|p|!inside(p,&watch_root)).collect();if paths.is_empty(){return}
                    {let mut w=lock(&s.work);if w.notices.len()<4096{w.notices.push(json!({"type":"filesystem-event","kind":format!("{:?}",event.kind),"paths":paths,"observedAt":now_ms()}));}else{w.rescan=true;w.overflow=true;}}
                    for p in paths{s.touch(p,"filesystem");}
                }
                Err(_)=>{let mut w=lock(&s.work);w.rescan=true;w.overflow=true;s.wake.notify_one();}
            }
        }).map_err(|e|io::Error::other(e.to_string()))?;
        for dir in &dirs {
            watcher.watch(dir, RecursiveMode::Recursive).map_err(|e| {
                io::Error::other(format!("파일 변경 감시를 시작하지 못했습니다: {e}"))
            })?;
        }
        let manifest = super::journal::chat_dir(&root, &chat)?.join("files-manifest.jsonl");
        let mut versions: BTreeMap<PathBuf, Version> = BTreeMap::new();
        let mut manifest_file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&manifest)?;
        let mut reader = BufReader::new(manifest_file.try_clone()?);
        let mut line = Vec::new();
        let mut valid = 0u64;
        loop {
            line.clear();
            let n = reader.read_until(b'\n', &mut line)?;
            if n == 0 {
                break;
            }
            if line.last() != Some(&b'\n') {
                break;
            }
            let Ok((path, version)) = serde_json::from_slice::<(PathBuf, Option<Version>)>(&line)
            else {
                break;
            };
            if let Some(v) = version {
                versions.insert(path, v);
            } else {
                versions.remove(&path);
            }
            valid += n as u64;
        }
        manifest_file.set_len(valid)?;
        manifest_file.seek(SeekFrom::Start(valid))?;
        let mut tracker = Tracker {
            root: root.clone(),
            store_root: super::layout::view_dir(&root, &chat)?,
            dirs: dirs.clone(),
            manifest: BufWriter::new(manifest_file),
            versions,
            sink: sink.clone(),
            status: status.clone(),
            targets: BTreeSet::new(),
        };
        // Baseline is complete before the toggle returns enabled. No file I/O on the GUI thread.
        tracker.reconcile(true)?;
        tracker.save()?;
        sink(Captured::new(
            "lifecycle",
            &json!({"type":"baseline-complete","files":tracker.versions.len(),"roots":dirs}),
        ));
        let signals2 = signals.clone();
        let cwd = dirs[0].clone();
        let thread = std::thread::Builder::new()
            .name("ccg-archive-files".into())
            .spawn(move || {
                let _watcher = watcher;
                loop {
                    let work = {
                        let mut w = lock(&signals2.work);
                        while w.paths.is_empty() && !w.rescan && !w.stop && !w.retry_targets {
                            w = signals2.wake.wait(w).unwrap_or_else(|e| e.into_inner());
                        }
                        std::mem::take(&mut *w)
                    };
                    if work.overflow {
                        tracker.gap("파일 변경 알림이 밀려 전체 파일 목록을 다시 확인했습니다.");
                    }
                    for notice in work.notices {
                        (tracker.sink)(Captured::new("file", &notice));
                    }
                    for (path, why) in work.paths {
                        if let Err(e) = tracker.capture(&path, false, &why) {
                            tracker.failure(&path, &e);
                        }
                    }
                    if work.rescan || work.stop {
                        if let Err(e) = tracker.reconcile(false) {
                            tracker.failure(Path::new("workspace"), &e);
                        }
                    } else if work.retry_targets {
                        tracker.retry_targets();
                    }
                    if let Err(e) = tracker.save() {
                        tracker.failure(Path::new("manifest"), &e);
                    }
                    for barrier in work.barriers {
                        let _ = barrier.send(());
                    }
                    if work.stop {
                        break;
                    }
                }
            })?;
        Ok(Self {
            signals,
            thread: Some(thread),
            cwd,
        })
    }
    pub fn observe(&self, source: &str, v: &Value) {
        if matches!(source, "request" | "input" | "ui" | "protocol-in") {
            // Explicit files outside the working directory (attachments/tool outputs)
            // are captured as well. No global drive scan or symlink traversal.
            let mut paths = vec![];
            collect_paths(v, None, &mut paths);
            for value in paths {
                if value.starts_with("http:")
                    || value.starts_with("https:")
                    || value.starts_with("data:")
                {
                    continue;
                }
                let p = PathBuf::from(&value);
                let p = if p.is_absolute() { p } else { self.cwd.join(p) };
                self.signals.touch(p, "tool-or-attachment");
            }
        }
        if source == "ui" && v["type"] == "result" {
            self.checkpoint();
        } else if source == "ui" && v["type"] == "tool-end" {
            let mut w = lock(&self.signals.work);
            w.retry_targets = true;
            self.signals.wake.notify_one();
        }
    }
    pub fn checkpoint(&self) {
        let mut w = lock(&self.signals.work);
        w.rescan = true;
        self.signals.wake.notify_one();
    }
    pub fn checkpoint_request(&self) -> std::sync::mpsc::Receiver<()> {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut w = lock(&self.signals.work);
        w.rescan = true;
        w.barriers.push(tx);
        self.signals.wake.notify_one();
        rx
    }
    pub fn stop(mut self) {
        let mut w = lock(&self.signals.work);
        w.stop = true;
        self.signals.wake.notify_one();
        drop(w);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}
fn collect_paths(value: &Value, key_name: Option<&str>, out: &mut Vec<String>) {
    match value {
        Value::Object(obj) => {
            for (k, v) in obj {
                collect_paths(v, Some(k), out)
            }
        }
        Value::Array(a) => {
            for v in a {
                collect_paths(v, key_name, out)
            }
        }
        Value::String(s)
            if matches!(
                key_name,
                Some(
                    "file_path"
                        | "filePath"
                        | "outputFile"
                        | "output_file"
                        | "echoImages"
                        | "images"
                        | "imagePath"
                        | "localImagePath"
                        | "relPath"
                        | "path"
                )
            ) && !s.is_empty() =>
        {
            out.push(s.clone())
        }
        _ => {}
    }
}
struct Tracker {
    store_root: PathBuf,
    root: PathBuf,
    dirs: Vec<PathBuf>,
    manifest: BufWriter<File>,
    versions: BTreeMap<PathBuf, Version>,
    sink: Sink,
    status: Arc<Mutex<Status>>,
    targets: BTreeSet<PathBuf>,
}
impl Tracker {
    fn failure(&self, path: &Path, e: &io::Error) {
        let text = format!("{}: {e}", path.display());
        {
            let mut s = lock(&self.status);
            s.coverage_errors += 1;
            s.error = Some(text.clone());
        }
        (self.sink)(Captured::new(
            "file",
            &json!({"type":"capture-error","path":path,"error":text}),
        ));
    }
    fn gap(&self, message: &str) {
        lock(&self.status).coverage_errors += 1;
        (self.sink)(Captured::new(
            "file",
            &json!({"type":"coverage-gap","text":message}),
        ));
    }
    fn capture(&mut self, path: &Path, baseline: bool, why: &str) -> io::Result<()> {
        if inside(path, &self.root) {
            return Ok(());
        }
        let map_path = map_key(path);
        if why == "tool-or-attachment" && !self.dirs.iter().any(|d| inside(path, d)) {
            self.targets.insert(path.into());
        }
        let meta = match fs::symlink_metadata(path) {
            Ok(m) => m,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                if let Some(before) = self.versions.remove(&map_path) {
                    self.targets.retain(|p| map_key(p) != map_path);
                    serde_json::to_writer(
                        &mut self.manifest,
                        &(&map_path, Option::<Version>::None),
                    )?;
                    self.manifest.write_all(b"\n")?;
                    (self.sink)(Captured::new(
                        "file",
                        &json!({"type":"file-version","path":path,"change":"deleted","before":before,"after":null,"origin":why}),
                    ));
                } else if matches!(why, "inventory-target" | "filesystem")
                    && !self.versions.keys().any(|p| inside(p, path))
                {
                    self.gap(&format!(
                        "파일 내용을 확보하기 전에 경로가 사라졌습니다: {}",
                        path.display()
                    ));
                }
                return Ok(());
            }
            Err(e) => return Err(e),
        };
        if meta.is_dir() && !is_link(&meta) {
            return Ok(());
        }
        if !meta.is_file() && !is_link(&meta) {
            return Ok(());
        }
        let before = self.versions.get(&map_path).cloned();
        // Notifications force a content check even when a program preserves mtime.
        if matches!(why, "inventory" | "baseline" | "tool-or-attachment")
            && before.as_ref().is_some_and(|b| {
                b.bytes == meta.len()
                    && b.modified == modified(&meta)
                    && b.hash
                        .as_ref()
                        .is_some_and(|h| object_path(&self.store_root, h).is_ok_and(|p| p.exists()))
            })
        {
            if why == "tool-or-attachment" {
                (self.sink)(Captured::new(
                    "file",
                    &json!({"type":"file-reference","path":path,"change":"referenced","before":null,"after":before,"origin":why}),
                ));
            }
            return Ok(());
        }
        let after = if is_link(&meta) {
            Version {
                hash: None,
                bytes: 0,
                modified: modified(&meta),
                link: Some(fs::read_link(path)?.to_string_lossy().into_owned()),
            }
        } else {
            let (hash, bytes) = store_file(&self.store_root, path)?;
            let finish = fs::metadata(path).ok();
            if finish.as_ref().is_some_and(|finish| {
                finish.len() != meta.len() || modified(finish) != modified(&meta)
            }) {
                self.gap(&format!(
                    "파일 보관 중 내용이 바뀌어 다음 변경 알림에서 재확인합니다: {}",
                    path.display()
                ));
            }
            Version {
                hash: Some(hash),
                bytes,
                modified: modified(&meta),
                link: None,
            }
        };
        let changed = before
            .as_ref()
            .is_none_or(|b| b.hash != after.hash || b.link != after.link);
        serde_json::to_writer(&mut self.manifest, &(&map_path, &after))?;
        self.manifest.write_all(b"\n")?;
        self.versions.insert(map_path, after.clone());
        {
            let mut s = lock(&self.status);
            s.file_count = self.versions.len() as u64;
            if changed {
                s.file_bytes = s.file_bytes.saturating_add(after.bytes);
            }
        }
        if !baseline && changed {
            (self.sink)(Captured::new(
                "file",
                &json!({"type":"file-version","path":path,"change":if before.is_some(){"modified"}else{"created"},"before":before,"after":after,"origin":why}),
            ));
        }
        Ok(())
    }
    fn reconcile(&mut self, baseline: bool) -> io::Result<()> {
        let mut seen = BTreeSet::new();
        let mut stack = self.dirs.clone();
        let mut failed_roots = vec![];
        while let Some(dir) = stack.pop() {
            if inside(&dir, &self.root) {
                continue;
            }
            let entries = match fs::read_dir(&dir) {
                Ok(e) => e,
                Err(e) => {
                    self.failure(&dir, &e);
                    failed_roots.push(dir);
                    continue;
                }
            };
            for e in entries {
                match e {
                    Ok(entry) => {
                        let path = entry.path();
                        if inside(&path, &self.root) {
                            continue;
                        }
                        match fs::symlink_metadata(&path) {
                            Ok(meta) if meta.is_dir() && !is_link(&meta) => stack.push(path),
                            Ok(_) => {
                                seen.insert(map_key(&path));
                                if let Err(e) = self.capture(
                                    &path,
                                    baseline,
                                    if baseline { "baseline" } else { "inventory" },
                                ) {
                                    self.failure(&path, &e);
                                }
                            }
                            Err(e) => self.failure(&path, &e),
                        }
                    }
                    Err(e) => self.failure(&dir, &e),
                }
            }
        }
        let deleted: Vec<_> = self
            .versions
            .keys()
            .filter(|p| {
                self.dirs.iter().any(|d| inside(p, d))
                    && !seen.contains(*p)
                    && !failed_roots.iter().any(|d| inside(p, d))
            })
            .cloned()
            .collect();
        for path in deleted {
            self.capture(&path, baseline, "inventory")?;
        }
        if !baseline {
            self.retry_targets();
        }
        Ok(())
    }
    fn retry_targets(&mut self) {
        let targets: Vec<_> = self.targets.iter().cloned().collect();
        for path in targets {
            if let Err(e) = self.capture(&path, false, "inventory-target") {
                self.failure(&path, &e);
            }
        }
    }
    fn save(&mut self) -> io::Result<()> {
        self.manifest.flush()
    }
}

pub fn object_page(root: &Path, chat: &str, hash: &str, offset: u64) -> io::Result<Value> {
    let path = object_path(&super::layout::view_dir(root, chat)?, hash)?;
    let mut file = File::open(path)?;
    let total = file.metadata()?.len();
    file.seek(SeekFrom::Start(offset.min(total)))?;
    let mut bytes = vec![0; (total.saturating_sub(offset)).min(128 * 1024) as usize];
    file.read_exact(&mut bytes)?;
    let binary = bytes.contains(&0)
        || std::str::from_utf8(&bytes)
            .err()
            .is_some_and(|e| e.error_len().is_some());
    if !binary && offset + (bytes.len() as u64) < total {
        while !bytes.is_empty() && std::str::from_utf8(&bytes).is_err() {
            bytes.pop();
        }
    }
    let next = offset + bytes.len() as u64;
    Ok(
        json!({"hash":hash,"totalBytes":total,"binary":binary,"text":if binary{None}else{Some(String::from_utf8_lossy(&bytes))},"next":if next<total{Some(next)}else{None}}),
    )
}
pub fn materialize(root: &Path, chat: &str, hash: &str, name: &str) -> io::Result<PathBuf> {
    let view = super::layout::view_dir(root, chat)?;
    let source = object_path(&view, hash)?;
    // A viewer copy is expendable; the immutable object is never opened for editing.
    let filename = Path::new(name)
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("saved-file");
    let folder = view.join("files").join(hash);
    fs::create_dir_all(&folder)?;
    let dest = folder.join(filename);
    fs::copy(source, &dest)?;
    Ok(dest)
}
