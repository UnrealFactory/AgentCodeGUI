//! A session owns its journal and every referenced file object. The format marker
//! is published last, so interrupted legacy migration still reads the old journal.
use super::{files, invalid, journal, Config};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

const SESSION_FORMAT: &str = "agentcodegui-conversation-session";
pub(super) const JOURNAL_FILES: &[&str] = &[
    "config.json",
    "events.jsonl",
    "entries.jsonl",
    "entries.idx",
    "active.json",
    "files-manifest.jsonl",
    "name.json",
    "turns",
];

pub fn retire_global_viewer(root: &Path) -> io::Result<()> {
    let source = root.join("viewer");
    if !source.exists() {
        return Ok(());
    }
    plain_metadata(&source)?;
    let backup = root.join(".legacy");
    fs::create_dir_all(&backup)?;
    plain_metadata(&backup)?;
    let mut target = backup.join("viewer");
    let mut serial = 0u64;
    while target.exists() {
        serial += 1;
        target = backup.join(format!("viewer-{serial}"));
    }
    // Check resolved source and destination parent before moving the old cache.
    let canonical_root = fs::canonicalize(root)?;
    if !fs::canonicalize(&source)?.starts_with(&canonical_root)
        || !fs::canonicalize(&backup)?.starts_with(&canonical_root)
    {
        return Err(invalid("기존 사본 폴더가 보관 폴더 밖을 가리킵니다."));
    }
    fs::rename(source, target)
}

fn verify_object(path: &Path, expected: &str) -> io::Result<()> {
    let mut file = File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0; 128 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    if format!("{:x}", hash.finalize()) != expected {
        return Err(invalid(
            "가져온 파일 사본의 SHA-256 값이 일치하지 않습니다.",
        ));
    }
    Ok(())
}

pub fn session_dir(root: &Path, chat: &str) -> io::Result<PathBuf> {
    if !journal::valid_id(chat) {
        return Err(invalid("Invalid archive chat ID"));
    }
    Ok(root.join("chats").join(chat))
}
pub fn log_dir(root: &Path, chat: &str) -> io::Result<PathBuf> {
    let dir = session_dir(root, chat)?;
    if dir.join("Chat/format.json").exists() || !dir.join("events.jsonl").exists() {
        Ok(dir.join("Chat"))
    } else {
        Ok(dir)
    }
}
pub fn view_dir(root: &Path, chat: &str) -> io::Result<PathBuf> {
    Ok(session_dir(root, chat)?.join("View"))
}

pub fn title_override(dir: &Path) -> Option<String> {
    fs::read(dir.join("name.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|v| {
            v["title"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        })
}

pub fn rename_session(root: &Path, chat: &str, title: &str) -> io::Result<()> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > 200 || title.chars().any(char::is_control) {
        return Err(invalid("세션 이름은 줄바꿈 없이 1~200자로 입력해 주세요."));
    }
    let dir = log_dir(root, chat)?;
    if !dir.join("events.jsonl").exists() {
        return Err(invalid("보관된 세션이 없습니다."));
    }
    crate::write_atomic(&dir.join("name.json"), &json!({"title":title}).to_string())
}

/// Every recursive deletion is confined to validated, non-link session folders.
/// Old shared objects are retained because other v1 sessions may still use them.
pub fn deletion_targets(root: &Path, chat: &str) -> io::Result<Vec<PathBuf>> {
    let session = session_dir(root, chat)?;
    let canonical_root = fs::canonicalize(root)?;
    let mut targets = vec![session];
    let backup = root.join(".legacy/chats").join(chat);
    if backup.exists() {
        targets.push(backup);
    }
    for target in &targets {
        if !plain_metadata(target)?.is_dir() {
            return Err(invalid("세션 폴더가 올바르지 않습니다."));
        }
        let resolved = fs::canonicalize(target)?;
        let parent = fs::canonicalize(target.parent().unwrap())?;
        if !parent.starts_with(&canonical_root)
            || resolved.parent() != Some(parent.as_path())
            || !resolved.starts_with(&canonical_root)
            || resolved == canonical_root
        {
            return Err(invalid("세션 폴더가 보관 폴더 밖을 가리킵니다."));
        }
    }
    Ok(targets)
}

pub fn delete_session(root: &Path, chat: &str) -> io::Result<()> {
    let targets = deletion_targets(root, chat)?;
    // Remove the historical backup first. On failure the current session remains
    // visible and the user can retry; no other session or workspace is traversed.
    for target in targets.into_iter().rev() {
        fs::remove_dir_all(target)?;
    }
    Ok(())
}
pub(super) fn marker(dir: &Path) -> io::Result<Value> {
    let value: Value = serde_json::from_slice(&fs::read(dir.join("Chat/format.json"))?)?;
    if value["format"] != SESSION_FORMAT || value["version"] != 2 {
        return Err(invalid(
            "지원하지 않는 세션 폴더 형식입니다. Chat과 View가 들어 있는 폴더를 선택해 주세요.",
        ));
    }
    Ok(value)
}
fn collect_hashes(value: &Value, hashes: &mut BTreeSet<String>) -> io::Result<()> {
    match value {
        Value::Object(obj) => {
            if let Some(hash) = obj.get("hash").and_then(Value::as_str) {
                files::object_path(Path::new(""), hash)?;
                hashes.insert(hash.to_owned());
            }
            for value in obj.values() {
                collect_hashes(value, hashes)?;
            }
        }
        Value::Array(values) => {
            for value in values {
                collect_hashes(value, hashes)?;
            }
        }
        _ => {}
    }
    Ok(())
}
pub(super) fn referenced_hashes(dir: &Path) -> io::Result<BTreeSet<String>> {
    let mut hashes = BTreeSet::new();
    // Compact headers select file records without loading large command outputs.
    if dir.join("entries.jsonl").exists() {
        let mut data = File::open(dir.join("events.jsonl"))?;
        for line in BufReader::new(File::open(dir.join("entries.jsonl"))?).lines() {
            let entry: super::Entry = serde_json::from_str(&line?)?;
            if entry.source != "file"
                || !matches!(entry.kind.as_str(), "file-version" | "file-reference")
            {
                continue;
            }
            if entry.length > 1024 * 1024 {
                return Err(invalid("파일 보관 기록이 너무 큽니다."));
            }
            data.seek(SeekFrom::Start(entry.offset))?;
            let mut bytes = vec![0; entry.length as usize];
            data.read_exact(&mut bytes)?;
            collect_hashes(&serde_json::from_slice::<Value>(&bytes)?, &mut hashes)?;
        }
    }
    if dir.join("files-manifest.jsonl").exists() {
        for line in BufReader::new(File::open(dir.join("files-manifest.jsonl"))?).lines() {
            let line = line?;
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                collect_hashes(&value, &mut hashes)?;
            }
        }
    }
    Ok(hashes)
}
pub(super) fn plain_metadata(path: &Path) -> io::Result<fs::Metadata> {
    let meta = fs::symlink_metadata(path)?;
    if files::is_link(&meta) || (!meta.is_dir() && !meta.is_file()) {
        return Err(invalid(
            "세션 폴더에는 연결 파일이나 특수 파일을 포함할 수 없습니다.",
        ));
    }
    Ok(meta)
}
fn copy_tree(source: &Path, target: &Path) -> io::Result<()> {
    let meta = plain_metadata(source)?;
    if target.exists() {
        plain_metadata(target)?;
    }
    if meta.is_dir() {
        fs::create_dir_all(target)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_tree(&entry.path(), &target.join(entry.file_name()))?;
        }
    } else {
        fs::copy(source, target)?;
    }
    Ok(())
}

pub fn ensure(root: &Path, chat: &str) -> io::Result<()> {
    let dir = session_dir(root, chat)?;
    if dir.join("Chat/format.json").exists() {
        marker(&dir)?;
        return Ok(());
    }
    let legacy = dir.join("events.jsonl").exists();
    if legacy {
        journal::recover(&dir)?;
    }
    fs::create_dir_all(dir.join("Chat"))?;
    fs::create_dir_all(dir.join("View/objects"))?;
    if legacy {
        for name in JOURNAL_FILES {
            let source = dir.join(name);
            if source.exists() {
                copy_tree(&source, &dir.join("Chat").join(name))?;
            }
        }
        for hash in referenced_hashes(&dir)? {
            let source = files::object_path(root, &hash)?;
            let (copied_hash, _) = files::store_file(&dir.join("View"), &source).map_err(|e| {
                io::Error::other(format!("세션 파일 사본을 옮기지 못했습니다 ({hash}): {e}"))
            })?;
            if copied_hash != hash {
                return Err(invalid("기존 파일 사본의 SHA-256 값이 일치하지 않습니다."));
            }
        }
    }
    crate::write_atomic(
        &dir.join("Chat/format.json"),
        &json!({"format":SESSION_FORMAT,"version":2,"chatId":chat}).to_string(),
    )?;
    // Retain the original journal outside the portable session, after committing.
    // Both locations are fixed children of the archive and chat is validated.
    if legacy {
        let backup = root.join(".legacy/chats").join(chat);
        fs::create_dir_all(&backup)?;
        for name in JOURNAL_FILES {
            let source = dir.join(name);
            let destination = backup.join(name);
            if source.exists() && !destination.exists() {
                fs::rename(source, destination)?;
            }
        }
    }
    Ok(())
}

pub fn import(root: &Path, source: &Path) -> io::Result<Value> {
    let source = fs::canonicalize(source)?;
    fs::create_dir_all(root)?;
    if fs::canonicalize(root)?.starts_with(&source) {
        return Err(invalid("가져올 세션 폴더 밖의 저장 위치를 선택해 주세요."));
    }
    plain_metadata(&source)?;
    plain_metadata(&source.join("Chat"))?;
    plain_metadata(&source.join("View"))?;
    marker(&source)?;
    let staging = import_staging(root)?;
    copy_tree(&source.join("Chat"), &staging.path().join("Chat"))?;
    copy_tree(&source.join("View"), &staging.path().join("View"))?;
    publish_import(root, staging.path())
}

pub(super) fn import_staging(root: &Path) -> io::Result<tempfile::TempDir> {
    fs::create_dir_all(root.join("chats"))?;
    tempfile::Builder::new().prefix(".import-").tempdir_in(root.join("chats"))
}

/// Folder and ZIP imports use the same validation and are invisible until commit.
pub(super) fn publish_import(root: &Path, staging: &Path) -> io::Result<Value> {
    for name in ["Chat", "View"] {
        if !plain_metadata(&staging.join(name))?.is_dir() {
            return Err(invalid("세션에는 Chat과 View 폴더가 있어야 합니다."));
        }
    }
    let mut format = marker(staging)?;
    let original = format["chatId"]
        .as_str()
        .filter(|id| journal::valid_id(id))
        .ok_or_else(|| invalid("세션 식별자가 올바르지 않습니다."))?
        .to_string();
    fs::create_dir_all(root.join("chats"))?;
    let mut id = original.clone();
    let mut serial = 0u64;
    while session_dir(root, &id)?.exists() {
        serial += 1;
        id = format!(
            "{}-import-{}-{serial}",
            &original[..original.len().min(110)],
            super::now_ms()
        );
    }
    let destination = session_dir(root, &id)?;
    journal::recover(&staging.join("Chat"))?;
    for hash in referenced_hashes(&staging.join("Chat"))? {
        let path = files::object_path(&staging.join("View"), &hash)?;
        verify_object(&path, &hash).map_err(|e| {
            io::Error::other(format!(
                "세션 파일 사본을 확인하지 못했습니다 ({hash}): {e}"
            ))
        })?;
    }
    let config_path = staging.join("Chat/config.json");
    let mut config: Config = if config_path.exists() {
        serde_json::from_slice(&fs::read(&config_path)?)?
    } else {
        Config::default()
    };
    config.enabled = false;
    crate::write_atomic(&config_path, &serde_json::to_string(&config)?)?;
    format["chatId"] = json!(id);
    format["importedAt"] = json!(super::now_ms());
    crate::write_atomic(&staging.join("Chat/format.json"), &format.to_string())?;
    fs::rename(staging, &destination)?;
    Ok(json!({"chatId":id,"path":destination}))
}

pub fn imported_at(dir: &Path) -> u64 {
    fs::read(dir.join("format.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|v| v["importedAt"].as_u64())
        .unwrap_or(0)
}
