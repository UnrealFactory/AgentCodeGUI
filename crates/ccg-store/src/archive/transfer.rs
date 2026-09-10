//! Portable ZIP sessions. Stream bytes, reject unsafe entries, and publish only
//! after the journal and all referenced objects have passed the folder importer.
use super::{files, invalid, layout};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

// Apply the same limits to writing and reading so every exported ZIP can return.
// Check declared sizes before extraction and enforce them again while streaming.
const MAX_ENTRIES: usize = 200_000;
const MAX_BYTES: u64 = 64 * 1024 * 1024 * 1024;

fn zip_error(error: zip::result::ZipError) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("세션 ZIP을 처리하지 못했습니다: {error}"),
    )
}

fn check_size(total: &mut u64, bytes: u64) -> io::Result<()> {
    *total = total
        .checked_add(bytes)
        .filter(|n| *n <= MAX_BYTES)
        .ok_or_else(|| invalid("세션 ZIP의 압축 해제 후 크기는 64 GiB를 넘을 수 없습니다."))?;
    Ok(())
}

/// Reject traversal and Windows aliases even when an archive is read on Unix.
fn safe_path(name: &str) -> io::Result<PathBuf> {
    let name = name.strip_suffix('/').unwrap_or(name);
    if name.is_empty() || name.contains('\\') {
        return Err(invalid("ZIP에 올바르지 않은 파일 경로가 있습니다."));
    }
    let mut path = PathBuf::new();
    for (depth, part) in name.split('/').enumerate() {
        let stem = part
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        let reserved = matches!(
            stem.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
        ) || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'));
        if depth >= 32
            || part.is_empty()
            || matches!(part, "." | "..")
            || part.ends_with(['.', ' '])
            || reserved
            || part
                .chars()
                .any(|c| c.is_control() || "<>:\"|?*".contains(c))
        {
            return Err(invalid("ZIP에 올바르지 않은 파일 경로가 있습니다."));
        }
        path.push(part);
    }
    Ok(path)
}

struct ExportEntry {
    path: PathBuf,
    name: String,
    bytes: u64,
    hash: Option<String>,
}

fn add_tree(
    session: &Path,
    start: &Path,
    entries: &mut Vec<ExportEntry>,
    total: &mut u64,
) -> io::Result<()> {
    let mut pending = vec![start.to_path_buf()];
    while let Some(path) = pending.pop() {
        let meta = layout::plain_metadata(&path)?;
        if meta.is_dir() {
            for entry in fs::read_dir(&path)? {
                pending.push(entry?.path());
            }
        } else {
            if entries.len() + 2 >= MAX_ENTRIES {
                return Err(invalid(
                    "세션 ZIP에는 최대 200,000개 항목을 넣을 수 있습니다.",
                ));
            }
            check_size(total, meta.len())?;
            let name = path
                .strip_prefix(session)
                .map_err(|_| invalid("잘못된 세션 경로입니다."))?
                .to_string_lossy()
                .replace('\\', "/");
            safe_path(&name)?;
            entries.push(ExportEntry {
                path,
                name,
                bytes: meta.len(),
                hash: None,
            });
        }
    }
    Ok(())
}

pub fn export_zip(root: &Path, chat: &str, destination: &Path) -> io::Result<Value> {
    if !destination.is_absolute()
        || !destination
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("zip"))
    {
        return Err(invalid("내보낼 ZIP 파일의 저장 위치를 선택해 주세요."));
    }
    let parent = destination
        .parent()
        .ok_or_else(|| invalid("잘못된 저장 위치입니다."))?;
    if fs::canonicalize(parent)?.starts_with(fs::canonicalize(root)?) {
        return Err(invalid("기록 보관 폴더 밖에 ZIP 파일을 저장해 주세요."));
    }
    if destination.try_exists()? {
        layout::plain_metadata(destination)?;
    }
    let session = layout::session_dir(root, chat)?;
    layout::plain_metadata(&session)?;
    if !fs::canonicalize(&session)?.starts_with(fs::canonicalize(root)?) {
        return Err(invalid("세션 폴더가 보관 폴더 밖을 가리킵니다."));
    }
    layout::plain_metadata(&session.join("Chat"))?;
    layout::plain_metadata(&session.join("View"))?;
    layout::plain_metadata(&session.join("View/objects"))?;
    layout::marker(&session)?;
    let mut entries = Vec::new();
    let mut total = 0;
    for name in std::iter::once(&"format.json").chain(layout::JOURNAL_FILES.iter()) {
        let source = session.join("Chat").join(name);
        if source.try_exists()? {
            add_tree(&session, &source, &mut entries, &mut total)?;
        }
    }
    // Viewer copies and unfinished temporary files are not needed to transfer a
    // session. Include every historical and baseline object referenced by Chat.
    for hash in layout::referenced_hashes(&session.join("Chat"))? {
        if entries.len() + 2 >= MAX_ENTRIES {
            return Err(invalid(
                "세션 ZIP에는 최대 200,000개 항목을 넣을 수 있습니다.",
            ));
        }
        let source = files::object_path(&session.join("View"), &hash)?;
        layout::plain_metadata(source.parent().unwrap())?;
        let meta = layout::plain_metadata(&source)?;
        if !meta.is_file() {
            return Err(invalid("보관된 파일 사본이 올바르지 않습니다."));
        }
        check_size(&mut total, meta.len())?;
        entries.push(ExportEntry {
            path: source,
            name: format!("View/objects/{}/{hash}", &hash[..2]),
            bytes: meta.len(),
            hash: Some(hash),
        });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    let mut names = BTreeSet::new();
    for entry in &entries {
        if !names.insert(entry.name.to_lowercase()) {
            return Err(invalid(
                "세션에 대소문자만 다른 파일 경로가 있어 ZIP으로 내보낼 수 없습니다.",
            ));
        }
    }
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    let mut writer = ZipWriter::new(temporary.as_file_mut());
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    writer.add_directory("Chat/", options).map_err(zip_error)?;
    writer
        .add_directory("View/objects/", options)
        .map_err(zip_error)?;
    let mut buffer = vec![0; 128 * 1024];
    for entry in &entries {
        writer
            .start_file(
                &entry.name,
                options.large_file(entry.bytes >= u32::MAX as u64),
            )
            .map_err(zip_error)?;
        let mut file = File::open(&entry.path)?;
        let mut digest = Sha256::new();
        let mut written = 0u64;
        loop {
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            written += count as u64;
            if written > entry.bytes {
                return Err(invalid(
                    "내보내는 중 세션 내용이 바뀌었습니다. 다시 시도해 주세요.",
                ));
            }
            if entry.hash.is_some() {
                digest.update(&buffer[..count]);
            }
            writer.write_all(&buffer[..count])?;
        }
        if written != entry.bytes {
            return Err(invalid(
                "내보내는 중 세션 내용이 바뀌었습니다. 다시 시도해 주세요.",
            ));
        }
        if let Some(hash) = &entry.hash {
            if format!("{:x}", digest.finalize()) != *hash {
                return Err(invalid(
                    "보관된 파일 사본이 손상되어 세션을 내보낼 수 없습니다.",
                ));
            }
        }
    }
    writer.finish().map_err(zip_error)?.sync_all()?;
    let bytes = temporary.as_file().metadata()?.len();
    // The native save dialog confirms an existing filename. Preserve that file
    // until the replacement ZIP has been written, checked and synced completely.
    temporary.persist(destination).map_err(|e| e.error)?;
    Ok(json!({"path":destination,"bytes":bytes}))
}

pub fn import_zip(root: &Path, source: &Path) -> io::Result<Value> {
    let mut archive = ZipArchive::new(File::open(source)?).map_err(zip_error)?;
    if archive.len() > MAX_ENTRIES {
        return Err(invalid(
            "세션 ZIP에는 최대 200,000개 항목을 넣을 수 있습니다.",
        ));
    }
    let mut paths = Vec::with_capacity(archive.len());
    let mut seen = BTreeSet::new();
    let mut roots = Vec::new();
    let mut total = 0;
    for index in 0..archive.len() {
        let file = archive.by_index_raw(index).map_err(zip_error)?;
        let path = safe_path(file.name())?;
        let kind = file.unix_mode().unwrap_or_default() & 0o170000;
        if file.encrypted() || file.is_symlink() || !matches!(kind, 0 | 0o040000 | 0o100000) {
            return Err(invalid(
                "암호화되거나 연결 파일·특수 파일이 포함된 ZIP은 가져올 수 없습니다.",
            ));
        }
        if !seen.insert(path.to_string_lossy().to_lowercase()) {
            return Err(invalid("ZIP에 중복된 파일 경로가 있습니다."));
        }
        check_size(&mut total, file.size())?;
        if path.ends_with("Chat/format.json") && !file.is_dir() {
            roots.push(path.parent().unwrap().parent().unwrap().to_path_buf());
        }
        paths.push(path);
    }
    if roots.len() != 1 {
        return Err(invalid(
            "대화 기록소에서 내보낸 세션 ZIP 파일을 선택해 주세요.",
        ));
    }
    let prefix = &roots[0];
    let staging = layout::import_staging(root)?;
    for (index, path) in paths.iter().enumerate() {
        let mut file = archive.by_index(index).map_err(zip_error)?;
        // Windows' Compress to ZIP may wrap Chat and View in one session folder.
        if file.is_dir() && prefix.starts_with(path) {
            continue;
        }
        let relative = path
            .strip_prefix(prefix)
            .map_err(|_| invalid("ZIP에 다른 세션의 파일이 섞여 있습니다."))?;
        if !relative.starts_with("Chat") && !relative.starts_with("View") {
            return Err(invalid(
                "세션 ZIP에는 Chat과 View 폴더만 포함할 수 있습니다.",
            ));
        }
        let destination = staging.path().join(relative);
        if file.is_dir() {
            fs::create_dir_all(&destination)?;
        } else {
            fs::create_dir_all(destination.parent().unwrap())?;
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&destination)?;
            let expected = file.size();
            let count = io::copy(
                &mut file.by_ref().take(expected.saturating_add(1)),
                &mut output,
            )?;
            if count != expected {
                return Err(invalid("ZIP에 기록된 파일 크기가 실제 내용과 다릅니다."));
            }
            output.sync_all()?;
        }
    }
    layout::plain_metadata(&staging.path().join("Chat"))?;
    layout::plain_metadata(&staging.path().join("View"))?;
    layout::publish_import(root, staging.path())
}
