//! Immutable bytes, streamed to SHA-256 objects. Native change notifications avoid
//! project-wide polling; turn boundaries reconcile the directory inventory.
use super::file_policy::{self, Policy};
use super::{invalid, lock, now_ms, Captured, Status};
use notify::{EventKind, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

pub type Sink = Arc<dyn Fn(Captured) + Send + Sync>;

#[cfg(test)]
mod target_tests {
    use super::*;

    #[test]
    fn target_checks_preserve_unwatched_files_and_recover_after_lost_events() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("archive");
        let work = temp.path().join("workspace");
        fs::create_dir_all(work.join("generated")).unwrap();
        fs::write(work.join(".gitignore"), "generated/\n").unwrap();
        let watched = work.join("source.txt");
        let ignored = work.join("generated/output.txt");
        let external = temp.path().join("attachment.txt");
        for path in [&watched, &ignored, &external] { fs::write(path, "AAAA").unwrap(); }
        drop(super::super::journal::Journal::open(&root, "targets").unwrap());
        let signals = Arc::new(Signals {
            work: Mutex::new(Work::default()), wake: Condvar::new(),
            stopping: AtomicBool::new(false), finished: AtomicBool::new(false),
            watch_complete: AtomicBool::new(true),
        });
        let mut tracker = Tracker::open(root, "targets".into(), vec![work], Arc::new(|_| {}), Arc::new(Mutex::new(Status::default())), signals.clone()).unwrap();
        for path in [&watched, &ignored, &external] { tracker.capture(path, false, "tool-or-attachment").unwrap(); }
        tracker.save().unwrap();
        let manifest_len = tracker.manifest.get_ref().metadata().unwrap().len();
        tracker.capture(&watched, false, "inventory-target").unwrap();
        tracker.save().unwrap();
        assert_eq!(tracker.manifest.get_ref().metadata().unwrap().len(), manifest_len,
            "unchanged watched targets must not produce another snapshot/manifest row");
        let rewrite = |path: &Path, text: &str| {
            let mtime = fs::metadata(path).unwrap().modified().unwrap();
            fs::write(path, text).unwrap();
            OpenOptions::new().write(true).open(path).unwrap().set_times(fs::FileTimes::new().set_modified(mtime)).unwrap();
        };
        for path in [&watched, &ignored, &external] { rewrite(path, "BBBB"); }
        // Watch notifications force content reads; ignored/external targets do
        // not receive those notifications and must still be read at tool end.
        tracker.capture(&watched, false, "filesystem").unwrap();
        tracker.retry_targets();
        for path in [&watched, &ignored, &external] {
            let hash = tracker.versions[&map_key(path)].hash.as_ref().unwrap();
            assert_eq!(fs::read(object_path(&tracker.store_root, hash).unwrap()).unwrap(), b"BBBB");
        }
        rewrite(&watched, "CCCC");
        signals.watch_complete.store(false, Ordering::Release);
        tracker.retry_targets();
        let hash = tracker.versions[&map_key(&watched)].hash.as_ref().unwrap();
        assert_eq!(fs::read(object_path(&tracker.store_root, hash).unwrap()).unwrap(), b"CCCC",
            "a lost notification must restore full target checks even with unchanged metadata");
    }
}

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
pub(super) fn key(path: &Path) -> String {
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
pub(super) fn inside(path: &Path, root: &Path) -> bool {
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
    store_file_cancellable(root, path, None, None)
}
fn source_read<T>(result: io::Result<T>) -> io::Result<T> {
    result.map_err(|e| {
        if matches!(
            e.kind(),
            io::ErrorKind::PermissionDenied
                | io::ErrorKind::WouldBlock
                | io::ErrorKind::NotFound
                | io::ErrorKind::Interrupted
        ) || matches!(e.raw_os_error(), Some(32 | 33))
        {
            io::Error::new(io::ErrorKind::WouldBlock, e)
        } else {
            e
        }
    })
}
fn unstable_file() -> io::Error {
    io::Error::new(
        io::ErrorKind::WouldBlock,
        "파일이 저장 또는 교체되는 중이라 사본을 다시 확인합니다.",
    )
}
fn same_metadata(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    a.len() == b.len() && modified(a) == modified(b) && a.created().ok() == b.created().ok()
}
pub(super) fn same_open_file(a: &File, b: &File) -> io::Result<bool> {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        let identity = |file: &File| -> io::Result<(u32, u32, u32)> {
            let mut info = BY_HANDLE_FILE_INFORMATION::default();
            unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle() as _), &mut info) }
                .map_err(io::Error::other)?;
            Ok((
                info.dwVolumeSerialNumber,
                info.nFileIndexHigh,
                info.nFileIndexLow,
            ))
        };
        Ok(identity(a)? == identity(b)?)
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let (a, b) = (a.metadata()?, b.metadata()?);
        Ok(a.dev() == b.dev() && a.ino() == b.ino())
    }
    #[cfg(not(any(windows, unix)))]
    {
        Ok(same_metadata(&a.metadata()?, &b.metadata()?))
    }
}
fn cancelled(stop: Option<&AtomicBool>) -> io::Result<()> {
    if stop.is_some_and(|s| s.load(Ordering::Acquire)) {
        Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "파일 초기 보관을 중지했습니다.",
        ))
    } else {
        Ok(())
    }
}
fn store_file_cancellable(
    root: &Path,
    path: &Path,
    stop: Option<&AtomicBool>,
    expected: Option<&fs::Metadata>,
) -> io::Result<(String, u64)> {
    cancelled(stop)?;
    let temp_dir = root.join("pending");
    fs::create_dir_all(&temp_dir)?;
    let tmp = temp_dir.join(format!(
        "{}-{}-{}.tmp",
        std::process::id(),
        now_ms(),
        TEMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let outcome = (|| {
        let mut input = source_read(File::open(path))?;
        let before = source_read(input.metadata())?;
        if expected.is_some_and(|m| !same_metadata(m, &before)) {
            return Err(unstable_file());
        }
        let mut output = OpenOptions::new().create_new(true).write(true).open(&tmp)?;
        let mut hash = Sha256::new();
        let mut bytes = 0;
        let mut buffer = vec![0u8; 128 * 1024];
        loop {
            cancelled(stop)?;
            let n = source_read(input.read(&mut buffer))?;
            if n == 0 {
                break;
            }
            hash.update(&buffer[..n]);
            output.write_all(&buffer[..n])?;
            bytes += n as u64;
        }
        cancelled(stop)?;
        // Verify before publishing the object or appending a manifest version.
        // The reader keeps normal write/delete sharing, so it never locks out an editor.
        let after = source_read(input.metadata())?;
        let current_file = source_read(File::open(path))?;
        let current = source_read(current_file.metadata())?;
        if bytes != before.len()
            || !same_metadata(&before, &after)
            || !same_metadata(&before, &current)
            || !same_open_file(&input, &current_file)?
        {
            return Err(unstable_file());
        }
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
            output.sync_data()?;
            drop(output);
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
    stopping: AtomicBool,
    finished: AtomicBool,
    // Once native events are lost, keep conservative target checks for this run.
    watch_complete: AtomicBool,
}
impl Signals {
    fn touch(&self, path: PathBuf, why: &str) {
        let mut w = lock(&self.work);
        if w.paths.len() < 4096 {
            // A filesystem notice must not erase an explicit attachment request.
            let previous = w.paths.entry(path).or_insert_with(|| why.into());
            if why == "tool-or-attachment" {
                *previous = why.into();
            }
        } else {
            w.rescan = true;
            w.overflow = true;
            self.watch_complete.store(false, Ordering::Release);
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
            stopping: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            watch_complete: AtomicBool::new(true),
        });
        let s = signals.clone();
        let mut watch_policy = Policy::new(root.clone(), dirs.clone());
        let mut watcher=notify::recommended_watcher(move|result:notify::Result<notify::Event>|{
            match result {
                Ok(event)=>{if event.need_rescan(){s.watch_complete.store(false,Ordering::Release);let mut w=lock(&s.work);w.rescan=true;w.overflow=true;s.wake.notify_one();}
                    if matches!(event.kind,EventKind::Access(_)){return}
                    // Cached ignore matchers reject ignored build traffic before it
                    // fills the bounded queue or causes a false coverage-gap notice.
                    if event.paths.iter().any(|p|p.file_name().is_some_and(|n|n==".gitignore")){watch_policy.refresh();}
                    let directory=matches!(event.kind,EventKind::Create(notify::event::CreateKind::Folder)|EventKind::Remove(notify::event::RemoveKind::Folder));
                    let paths:Vec<_>=event.paths.into_iter().filter(|p|watch_policy.automatic(p,directory)).collect();if paths.is_empty(){return}
                    {let mut w=lock(&s.work);if w.notices.len()<4096{w.notices.push(json!({"type":"filesystem-event","kind":format!("{:?}",event.kind),"paths":paths,"observedAt":now_ms()}));}else{w.rescan=true;w.overflow=true;s.watch_complete.store(false,Ordering::Release);}}
                    for p in paths{s.touch(p,"filesystem");}
                }
                Err(_)=>{s.watch_complete.store(false,Ordering::Release);let mut w=lock(&s.work);w.rescan=true;w.overflow=true;s.wake.notify_one();}
            }
        }).map_err(|e|io::Error::other(e.to_string()))?;
        for dir in &dirs {
            watcher.watch(dir, RecursiveMode::Recursive).map_err(|e| {
                io::Error::other(format!("파일 변경 감시를 시작하지 못했습니다: {e}"))
            })?;
        }
        let signals2 = signals.clone();
        let cwd = dirs[0].clone();
        let thread = std::thread::Builder::new()
            .name("ccg-archive-files".into())
            .spawn(move || {
                let _watcher = watcher;
                let result = (|| -> io::Result<()> {
                // The journal is already usable while the old inventory and initial
                // file bytes load. The watcher was installed before starting this work.
                let mut tracker = Tracker::open(root, chat, dirs, sink.clone(), status.clone(), signals2.clone())?;
                let baseline = tracker.reconcile(true);
                tracker.save()?;
                baseline?;
                let mut initial = true;
                let mut barriers: Vec<std::sync::mpsc::Sender<()>> = Vec::new();
                loop {
                    if !signals2.stopping.load(Ordering::Acquire) {
                        tracker.retry_pending(false);
                        tracker.save()?;
                    }
                    if initial && !signals2.stopping.load(Ordering::Acquire) && !tracker.retries.values().any(|r| r.baseline) {
                        sink(Captured::new("lifecycle", &json!({"type":"baseline-complete","files":tracker.versions.len(),"roots":tracker.dirs})));
                        lock(&status).preparing = false;
                        initial = false;
                    }
                    if tracker.retries.is_empty() && !barriers.is_empty() {
                        tracker.save()?;
                        for barrier in barriers.drain(..) { let _ = barrier.send(()); }
                    }
                    let work = {
                        let mut w = lock(&signals2.work);
                        while w.paths.is_empty() && !w.rescan && !w.stop && !w.retry_targets {
                            if let Some(next) = tracker.retries.values().map(|r| r.next).min() {
                                let delay = next.saturating_duration_since(Instant::now());
                                if delay.is_zero() { break; }
                                w = signals2.wake.wait_timeout(w, delay).unwrap_or_else(|e| e.into_inner()).0;
                            } else {
                                w = signals2.wake.wait(w).unwrap_or_else(|e| e.into_inner());
                            }
                        }
                        std::mem::take(&mut *w)
                    };
                    barriers.extend(work.barriers);
                    if work.stop && initial {
                        tracker.retry_pending(true);
                        tracker.save()?;
                        sink(Captured::new("lifecycle", &json!({"type":"baseline-cancelled"})));
                        for barrier in barriers.drain(..) { let _ = barrier.send(()); }
                        break;
                    }
                    if work.overflow {
                        tracker.gap("파일 변경 알림이 밀려 전체 파일 목록을 다시 확인했습니다.");
                    }
                    if work.paths.keys().any(|p| p.file_name().is_some_and(|n| n == ".gitignore")) {
                        tracker.policy.refresh();
                    }
                    for mut notice in work.notices {
                        if let Some(paths) = notice["paths"].as_array_mut() {
                            paths.retain(|p| p.as_str().is_some_and(|p| tracker.automatic(Path::new(p), false)));
                            if paths.is_empty() { continue; }
                        }
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
                    if work.stop { tracker.retry_pending(true); }
                    if let Err(e) = tracker.save() {
                        tracker.failure(Path::new("manifest"), &e);
                    }
                    if tracker.retries.is_empty() || work.stop {
                        for barrier in barriers.drain(..) { let _ = barrier.send(()); }
                    }
                    if work.stop {
                        break;
                    }
                }
                Ok(())
                })();
                if let Err(e) = result {
                    if e.kind() == io::ErrorKind::Interrupted && signals2.stopping.load(Ordering::Acquire) {
                        sink(Captured::new("lifecycle", &json!({"type":"baseline-cancelled"})));
                    } else {
                        let text = if crate::prefs::read_ui_prefs().get("ui.lang").and_then(Value::as_str) == Some("en") {
                            format!("File archive preparation failed: {e}")
                        } else {
                            format!("파일 보관 준비 실패: {e}")
                        };
                        { let mut s = lock(&status); s.error = Some(text.clone()); s.coverage_errors += 1; }
                        sink(Captured::new("file", &json!({"type":"capture-error","error":text})));
                    }
                }
                lock(&status).preparing = false;
                let mut work = lock(&signals2.work);
                signals2.finished.store(true, Ordering::Release);
                for barrier in work.barriers.drain(..) { let _ = barrier.send(()); }
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
        if self.signals.finished.load(Ordering::Acquire) {
            let _ = tx.send(());
            return rx;
        }
        w.rescan = true;
        w.barriers.push(tx);
        self.signals.wake.notify_one();
        rx
    }
    pub fn stop(mut self) {
        self.signals.stopping.store(true, Ordering::Release);
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
    policy: Policy,
    signals: Arc<Signals>,
    retries: BTreeMap<PathBuf, RetryCapture>,
    failures: BTreeMap<PathBuf, String>,
}
const RETRY_DELAYS: [Duration; 5] = [
    Duration::from_millis(50),
    Duration::from_millis(150),
    Duration::from_millis(350),
    Duration::from_millis(750),
    Duration::from_millis(1500),
];
const MAX_RETRIES: usize = 4096;
struct RetryCapture {
    path: PathBuf,
    baseline: bool,
    why: String,
    attempts: usize,
    next: Instant,
    missing: bool,
}
impl Tracker {
    fn open(
        root: PathBuf,
        chat: String,
        dirs: Vec<PathBuf>,
        sink: Sink,
        status: Arc<Mutex<Status>>,
        signals: Arc<Signals>,
    ) -> io::Result<Self> {
        let manifest = super::journal::chat_dir(&root, &chat)?.join("files-manifest.jsonl");
        let mut manifest_file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&manifest)?;
        let mut reader = BufReader::new(manifest_file.try_clone()?);
        let mut versions = BTreeMap::new();
        let mut policy = Policy::new(root.clone(), dirs.clone());
        let mut line = Vec::new();
        let mut valid = 0u64;
        loop {
            cancelled(Some(&signals.stopping))?;
            line.clear();
            let n = reader.read_until(b'\n', &mut line)?;
            if n == 0 || line.last() != Some(&b'\n') {
                break;
            }
            let Ok((path, version)) = serde_json::from_slice::<(PathBuf, Option<Version>)>(&line)
            else {
                break;
            };
            // Historic objects and manifest rows remain on disk for export. Avoid
            // keeping hundreds of thousands of excluded build paths in memory.
            let in_workspace = dirs.iter().any(|dir| inside(&path, dir));
            if if in_workspace {
                policy.automatic(&path, false)
            } else {
                policy.explicit(&path)
            } {
                if let Some(v) = version {
                    versions.insert(path, v);
                } else {
                    versions.remove(&path);
                }
            }
            valid += n as u64;
        }
        // Cancellation must never truncate a partially read historical manifest.
        cancelled(Some(&signals.stopping))?;
        manifest_file.set_len(valid)?;
        manifest_file.seek(SeekFrom::Start(valid))?;
        Ok(Self {
            store_root: super::layout::view_dir(&root, &chat)?,
            policy,
            root,
            dirs,
            manifest: BufWriter::new(manifest_file),
            versions,
            sink,
            status,
            targets: BTreeSet::new(),
            signals,
            retries: BTreeMap::new(),
            failures: BTreeMap::new(),
        })
    }
    fn automatic(&mut self, path: &Path, is_dir: bool) -> bool {
        (self.targets.contains(path) && self.policy.explicit(path))
            || self.policy.automatic(path, is_dir)
    }
    fn failure(&mut self, path: &Path, e: &io::Error) {
        let id = map_key(path);
        let text = format!("{}: {e}", id.display());
        if self.failures.get(&id) == Some(&text) {
            return;
        }
        if self.failures.len() < MAX_RETRIES || self.failures.contains_key(&id) {
            self.failures.insert(id, text.clone());
        }
        {
            let mut s = lock(&self.status);
            s.coverage_errors += 1;
            if !s
                .error
                .as_ref()
                .is_some_and(|e| e.starts_with("기록 저장 실패:"))
            {
                s.error = Some(text.clone());
            }
        }
        (self.sink)(Captured::new(
            "file",
            &json!({"type":"capture-error","path":path,"error":text}),
        ));
    }
    fn recovered(&mut self, path: &Path) {
        if let Some(error) = self.failures.remove(&map_key(path)) {
            let mut status = lock(&self.status);
            if status.error.as_ref() == Some(&error) {
                status.error = self.failures.values().next_back().cloned();
            }
        }
    }
    fn gap(&self, message: &str) {
        lock(&self.status).coverage_errors += 1;
        (self.sink)(Captured::new(
            "file",
            &json!({"type":"coverage-gap","text":message}),
        ));
    }
    fn capture(&mut self, path: &Path, baseline: bool, why: &str) -> io::Result<()> {
        let id = map_key(path);
        if let Some(pending) = self.retries.get_mut(&id) {
            // A flood of notices must neither reset the retry budget nor force
            // repeated reads while a writer still owns the file.
            pending.baseline |= baseline;
            if why == "tool-or-attachment" {
                pending.why = why.into();
            }
            return Ok(());
        }
        let stopping = self.signals.stopping.load(Ordering::Acquire);
        let force = self.failures.contains_key(&id);
        match self.capture_once(path, baseline, why, stopping, force) {
            Ok(()) => {
                self.recovered(path);
                Ok(())
            }
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::NotFound
                ) && !stopping
                    && self.retries.len() < MAX_RETRIES =>
            {
                self.retries.insert(
                    id,
                    RetryCapture {
                        path: path.into(),
                        baseline,
                        why: why.into(),
                        attempts: 0,
                        next: Instant::now() + RETRY_DELAYS[0],
                        missing: e.kind() == io::ErrorKind::NotFound,
                    },
                );
                Ok(())
            }
            Err(e) => Err(e),
        }
    }
    fn retry_pending(&mut self, stopping: bool) {
        let due: Vec<_> = self
            .retries
            .iter()
            .filter(|(_, retry)| stopping || retry.next <= Instant::now())
            .map(|(id, _)| id.clone())
            .collect();
        for id in due {
            let Some(mut retry) = self.retries.remove(&id) else {
                continue;
            };
            // Cancelling the initial inventory does not wait through retry delays.
            if stopping && retry.baseline {
                continue;
            }
            retry.attempts += 1;
            let final_attempt =
                stopping || retry.attempts >= if retry.missing { 2 } else { RETRY_DELAYS.len() };
            match self.capture_once(&retry.path, retry.baseline, &retry.why, final_attempt, true) {
                Ok(()) => self.recovered(&retry.path),
                Err(e)
                    if !stopping
                        && ((e.kind() == io::ErrorKind::WouldBlock
                            && retry.attempts < RETRY_DELAYS.len())
                            || (e.kind() == io::ErrorKind::NotFound && retry.attempts < 2)) =>
                {
                    retry.missing = e.kind() == io::ErrorKind::NotFound;
                    retry.next = Instant::now() + RETRY_DELAYS[retry.attempts];
                    self.retries.insert(id, retry);
                }
                Err(e)
                    if e.kind() == io::ErrorKind::Interrupted
                        && self.signals.stopping.load(Ordering::Acquire) => {}
                Err(e) => self.failure(&retry.path, &e),
            }
        }
    }
    fn capture_once(
        &mut self,
        path: &Path,
        baseline: bool,
        why: &str,
        confirm_missing: bool,
        force: bool,
    ) -> io::Result<()> {
        if !self.policy.explicit(path) {
            return Ok(());
        }
        if why == "tool-or-attachment" {
            self.targets.insert(path.into());
        } else if !matches!(why, "baseline" | "inventory") && !self.automatic(path, path.is_dir()) {
            return Ok(());
        }
        let map_path = map_key(path);
        let meta = match fs::symlink_metadata(path) {
            Ok(m) => m,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                if !confirm_missing {
                    return Err(io::Error::new(
                        io::ErrorKind::NotFound,
                        "파일 교체 중인지 다시 확인합니다.",
                    ));
                }
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
                    return Err(io::Error::other(
                        "파일 내용을 확보하기 전에 경로가 사라졌습니다.",
                    ));
                }
                return Ok(());
            }
            Err(e) => return source_read(Err(e)),
        };
        if meta.is_dir() && !is_link(&meta) {
            return Ok(());
        }
        if !meta.is_file() && !is_link(&meta) {
            return Ok(());
        }
        let before = self.versions.get(&map_path).cloned();
        // Tool completion used to hash/copy every previously referenced file,
        // even if unchanged. Native notifications already force content checks
        // for automatically watched paths (including writes preserving mtime).
        // Ignored/external targets and degraded watchers still need full checks.
        let watched_target = why == "inventory-target"
            && self.signals.watch_complete.load(Ordering::Acquire)
            && self.policy.automatic(&map_path, false);
        if (matches!(why, "inventory" | "baseline" | "tool-or-attachment") || watched_target)
            && !force
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
            let (hash, bytes) = store_file_cancellable(
                &self.store_root,
                path,
                baseline.then_some(&self.signals.stopping),
                Some(&meta),
            )?;
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
        // Resuming an existing path may find a change before its asynchronous
        // baseline visit. Preserve that before/after edge even if the queued
        // native notification later finds identical bytes.
        if changed && (!baseline || before.is_some()) {
            (self.sink)(Captured::new(
                "file",
                &json!({"type":"file-version","path":path,"change":if before.is_some(){"modified"}else{"created"},"before":before,"after":after,"origin":why}),
            ));
        }
        Ok(())
    }
    fn reconcile(&mut self, baseline: bool) -> io::Result<()> {
        let mut seen = BTreeSet::new();
        self.policy.refresh();
        let mut failed = false;
        for dir in self.dirs.clone() {
            let root = self.root.clone();
            let dirs = self.dirs.clone();
            let mut builder = file_policy::builder(&dir);
            builder.filter_entry(move |entry| {
                !file_policy::automatic_excluded(
                    entry.path(),
                    &root,
                    &dirs,
                    entry.file_type().is_some_and(|t| t.is_dir()),
                )
            });
            for entry in builder.build() {
                cancelled(baseline.then_some(&self.signals.stopping))?;
                let entry = match entry {
                    Ok(e) => e,
                    Err(e) => {
                        self.failure(&dir, &io::Error::other(e.to_string()));
                        failed = true;
                        continue;
                    }
                };
                let path = entry.path();
                // File metadata/read races are handled by the same retry path as
                // change notifications; do not report them prematurely here.
                if entry.file_type().is_some_and(|t| t.is_dir())
                    && fs::symlink_metadata(path).is_ok_and(|m| !is_link(&m))
                {
                    continue;
                }
                seen.insert(map_key(path));
                if let Err(e) = self.capture(
                    path,
                    baseline,
                    if baseline { "baseline" } else { "inventory" },
                ) {
                    if e.kind() == io::ErrorKind::Interrupted {
                        return Err(e);
                    }
                    self.failure(path, &e);
                }
            }
        }
        // A filtered path is not a deletion. Only missing, still-in-scope paths
        // produce tombstones; historical snapshots remain exportable unchanged.
        let deleted: Vec<_> = self
            .versions
            .keys()
            .filter(|p| {
                self.dirs.iter().any(|d| inside(p, d))
                    && !seen.contains(*p)
                    && !failed
                    && !p.exists()
            })
            .cloned()
            .collect();
        for path in deleted {
            if self.automatic(&path, false) {
                self.capture(&path, baseline, "inventory")?;
            }
        }
        lock(&self.status).file_count = seen.len() as u64;
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
