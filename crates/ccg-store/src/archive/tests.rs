use super::*;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::atomic::AtomicU64;
use std::time::Instant;

struct Fixture(PathBuf);
static FIXTURE_SEQ: AtomicU64 = AtomicU64::new(0);
impl Fixture {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "ccg-archive-test-{}-{}-{}",
            std::process::id(),
            now_ms(),
            FIXTURE_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&p).unwrap();
        Self(p)
    }
    fn workspace(&self) -> PathBuf {
        let p = self.0.join("workspace");
        fs::create_dir_all(&p).unwrap();
        p
    }
    fn archive(&self) -> PathBuf {
        let p = self.0.join("archive");
        fs::create_dir_all(&p).unwrap();
        p
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let (Ok(p), Ok(temp)) = (
            fs::canonicalize(&self.0),
            fs::canonicalize(std::env::temp_dir()),
        ) {
            assert!(
                p.starts_with(temp)
                    && p.file_name()
                        .unwrap()
                        .to_string_lossy()
                        .starts_with("ccg-archive-test-")
            );
            let _ = fs::remove_dir_all(p);
        }
    }
}
fn user(text: &str) -> Value {
    json!({"type":"user","message":{"role":"user","content":[{"type":"text","text":text}]}})
}
fn event(source: &str, value: Value, at: u64) -> Captured {
    let mut e = Captured::new(source, &value);
    e.at = at;
    e
}
fn full_payload(dir: &Path, seq: u64) -> Value {
    let mut text = String::new();
    let mut offset = 0;
    loop {
        let p = journal::payload_page(dir, seq, offset).unwrap();
        text.push_str(p["text"].as_str().unwrap());
        if let Some(n) = p["next"].as_u64() {
            assert!(n > offset);
            offset = n
        } else {
            break;
        }
    }
    serde_json::from_str(&text).unwrap()
}

fn portable_zip_fixture(f: &Fixture) -> (Archive, Vec<(String, Vec<u8>)>) {
    let root = f.archive();
    let mut j = journal::Journal::open(&root, "zip-session").unwrap();
    let source = f.workspace().join("코드 🧪.txt");
    let view = layout::view_dir(&root, "zip-session").unwrap();
    let mut objects = Vec::new();
    for bytes in [b"before\r\n".to_vec(), "after 🧪\n".as_bytes().to_vec(), vec![0, 137, 255, 42]] {
        fs::write(&source, &bytes).unwrap();
        objects.push((files::store_file(&view, &source).unwrap().0, bytes));
    }
    j.append(&Captured::new("input", &user("모든 요청과 응답을 옮겨줘"))).unwrap();
    j.append(&Captured::new("tool", &json!({"type":"tool_result","content":"Unicode output 🧪\n".repeat(20_000)}))).unwrap();
    j.append(&Captured::new("file", &json!({"type":"file-version","path":source,"change":"modified","before":{"hash":objects[0].0},"after":{"hash":objects[1].0}}))).unwrap();
    j.append(&Captured::new("file", &json!({"type":"file-version","path":source,"change":"deleted","before":{"hash":objects[1].0},"after":null}))).unwrap();
    j.flush(true).unwrap();
    drop(j);
    let chat = journal::chat_dir(&root, "zip-session").unwrap();
    // The binary baseline is referenced only in the manifest, not the timeline.
    fs::write(chat.join("files-manifest.jsonl"), format!("{}\n", json!([source,{"hash":objects[2].0,"bytes":4,"modified":0,"link":null}]))).unwrap();
    fs::write(chat.join("config.json"), json!({"enabled":false,"cwd":f.workspace(),"roots":[],"title":"Original title"}).to_string()).unwrap();
    layout::rename_session(&root, "zip-session", "공유 세션 🧪").unwrap();
    (Archive::new(root).unwrap(), objects)
}

fn zip_contents(path: &Path) -> Vec<(String, Vec<u8>)> {
    use std::io::Read;
    let mut zip = zip::ZipArchive::new(fs::File::open(path).unwrap()).unwrap();
    (0..zip.len()).map(|i| {
        let mut file = zip.by_index(i).unwrap();
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).unwrap();
        (file.name().to_owned(), bytes)
    }).collect()
}

fn write_zip(path: &Path, entries: &[(String, Vec<u8>)]) {
    let mut writer = zip::ZipWriter::new(fs::File::create(path).unwrap());
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for (name, bytes) in entries {
        if name.ends_with('/') {
            writer.add_directory(name, options).unwrap();
        } else {
            writer.start_file(name, options).unwrap();
            writer.write_all(bytes).unwrap();
        }
    }
    writer.finish().unwrap();
}

#[test]
fn session_zip_round_trip_preserves_history_binary_baseline_name_and_duplicates() {
    let f = Fixture::new();
    let (a, objects) = portable_zip_fixture(&f);
    let chat = journal::chat_dir(&a.root, "zip-session").unwrap();
    let before = fs::read(chat.join("events.jsonl")).unwrap();
    let viewer_copy = files::materialize(&a.root, "zip-session", &objects[0].0, "cached.txt").unwrap();
    fs::write(viewer_copy, "Disposable viewer edit").unwrap();
    fs::create_dir_all(layout::view_dir(&a.root, "zip-session").unwrap().join("pending")).unwrap();
    fs::write(layout::view_dir(&a.root, "zip-session").unwrap().join("pending/unfinished.tmp"), "not a saved version").unwrap();
    let destination = f.0.join("공유 세션.zip");
    let exported = a.export_session("zip-session", &destination).unwrap();
    assert_eq!(exported["bytes"].as_u64(), Some(fs::metadata(&destination).unwrap().len()));
    assert!(zip_contents(&destination).iter().all(|(name, _)| !name.starts_with("View/files/") && !name.starts_with("View/pending/")));
    fs::rename(&a.root, f.0.join("unavailable-archive")).unwrap();
    fs::rename(f.workspace(), f.0.join("unavailable-workspace")).unwrap();
    let imported_root = f.0.join("imported");
    let imported = transfer::import_zip(&imported_root, &destination).unwrap();
    assert_eq!(imported["chatId"], "zip-session");
    let imported_chat = journal::chat_dir(&imported_root, "zip-session").unwrap();
    assert_eq!(fs::read(imported_chat.join("events.jsonl")).unwrap(), before);
    assert_eq!(journal::session_page(&imported_root, 0, "").unwrap()["items"][0]["title"], "공유 세션 🧪");
    assert!(!Archive::new(imported_root.clone()).unwrap().saved_config("zip-session").unwrap().enabled);
    for (hash, bytes) in objects {
        let path = files::materialize(&imported_root, "zip-session", &hash, "restored.bin").unwrap();
        assert_eq!(fs::read(path).unwrap(), bytes);
    }
    let duplicate = transfer::import_zip(&imported_root, &destination).unwrap();
    assert_ne!(duplicate["chatId"], imported["chatId"]);
    assert_eq!(journal::session_page(&imported_root, 0, "").unwrap()["total"], 2);
    assert_eq!(fs::read(imported_chat.join("events.jsonl")).unwrap(), before);
}

#[test]
fn session_zip_accepts_a_single_enclosing_folder() {
    let f = Fixture::new();
    let (a, _) = portable_zip_fixture(&f);
    let destination = f.0.join("plain.zip");
    a.export_session("zip-session", &destination).unwrap();
    let mut contents = vec![("공유 세션/".to_string(), Vec::new())];
    contents.extend(zip_contents(&destination).into_iter().map(|(name, bytes)| (format!("공유 세션/{name}"), bytes)));
    let wrapped = f.0.join("wrapped.zip");
    write_zip(&wrapped, &contents);
    let root = f.0.join("wrapped-import");
    assert_eq!(transfer::import_zip(&root, &wrapped).unwrap()["chatId"], "zip-session");
}

#[test]
fn session_zip_rejects_recording_and_protects_existing_export_on_failure() {
    let f = Fixture::new();
    let root = f.archive();
    let a = Archive::new(root.clone()).unwrap();
    let r = a.recorder("live").unwrap();
    let mut config = Config { enabled: true, cwd: f.workspace().to_string_lossy().into(), roots: vec![], title: "Live".into() };
    r.configure(config.clone()).unwrap();
    r.record("input", &user("Do not stop recording just to export"));
    let destination = f.0.join("existing.zip");
    fs::write(&destination, "existing file").unwrap();
    assert!(a.export_session("live", &destination).is_err());
    assert!(r.enabled.load(Ordering::Acquire));
    assert_eq!(fs::read(&destination).unwrap(), b"existing file");
    config.enabled = false;
    r.configure(config).unwrap();
    a.export_session("live", &destination).unwrap();
    assert!(zip_contents(&destination).iter().any(|(name, bytes)| name == "Chat/events.jsonl" && !bytes.is_empty()));
    assert!(a.export_session("live", &root.join("unsafe.zip")).is_err());
    assert!(!root.join("unsafe.zip").exists());
    a.shutdown();
}

#[test]
fn session_zip_export_checks_object_hash_before_replacing_a_file() {
    let f = Fixture::new();
    let (a, objects) = portable_zip_fixture(&f);
    let destination = f.0.join("existing.zip");
    fs::write(&destination, "keep existing file").unwrap();
    let object = files::object_path(&layout::view_dir(&a.root, "zip-session").unwrap(), &objects[0].0).unwrap();
    fs::write(object, "damaged bytes").unwrap();
    assert!(a.export_session("zip-session", &destination).is_err());
    assert_eq!(fs::read(&destination).unwrap(), b"keep existing file");
}

#[test]
fn session_zip_rejects_missing_or_corrupt_objects_without_publishing_or_leaving_staging() {
    let f = Fixture::new();
    let (a, _) = portable_zip_fixture(&f);
    let destination = f.0.join("source.zip");
    a.export_session("zip-session", &destination).unwrap();
    let contents = zip_contents(&destination);
    let object = contents.iter().position(|(name, _)| name.starts_with("View/objects/") && !name.ends_with('/')).unwrap();
    for remove in [false, true] {
        let mut broken = contents.clone();
        if remove { broken.remove(object); } else { broken[object].1[0] ^= 1; }
        let zip = f.0.join(format!("bad-{remove}.zip"));
        write_zip(&zip, &broken);
        let target = f.0.join(format!("bad-import-{remove}"));
        assert!(transfer::import_zip(&target, &zip).is_err());
        assert_eq!(journal::session_page(&target, 0, "").unwrap()["total"], 0);
        assert_eq!(fs::read_dir(target.join("chats")).unwrap().count(), 0);
    }
    let mut wrong_layout: Vec<_> = contents.into_iter().filter(|(name, _)| !name.starts_with("View/")).collect();
    wrong_layout.push(("View".into(), b"not a directory".to_vec()));
    let zip = f.0.join("wrong-layout.zip");
    write_zip(&zip, &wrong_layout);
    let target = f.0.join("wrong-layout-import");
    assert!(transfer::import_zip(&target, &zip).is_err());
    assert_eq!(fs::read_dir(target.join("chats")).unwrap().count(), 0);
}

#[test]
fn session_zip_rejects_unsafe_paths_duplicate_aliases_and_symlinks() {
    let f = Fixture::new();
    let (a, _) = portable_zip_fixture(&f);
    let destination = f.0.join("source.zip");
    a.export_session("zip-session", &destination).unwrap();
    let contents = zip_contents(&destination);
    let sentinel = f.0.join("untouched.txt");
    fs::write(&sentinel, "must remain").unwrap();
    for (i, name) in ["../../untouched.txt", "/absolute.txt", "C:/absolute.txt", "Chat/../escape.txt", "Chat\\escape.txt", "Chat/events.jsonl:extra", "Chat/NUL", "Chat/entries.idx.", "chat/FORMAT.JSON"].iter().enumerate() {
        let mut malicious = contents.clone();
        malicious.push((name.to_string(), b"unexpected".to_vec()));
        let zip = f.0.join(format!("unsafe-{i}.zip"));
        write_zip(&zip, &malicious);
        let target = f.0.join(format!("unsafe-import-{i}"));
        assert!(transfer::import_zip(&target, &zip).is_err(), "accepted {name}");
        assert_eq!(journal::session_page(&target, 0, "").unwrap()["total"], 0);
        assert_eq!(fs::read(&sentinel).unwrap(), b"must remain");
    }
    let zip = f.0.join("symlink.zip");
    let mut writer = zip::ZipWriter::new(fs::File::create(&zip).unwrap());
    writer.add_symlink("Chat/link", "../../untouched.txt", zip::write::SimpleFileOptions::default()).unwrap();
    writer.finish().unwrap();
    assert!(transfer::import_zip(&f.0.join("symlink-import"), &zip).is_err());
    assert_eq!(fs::read(&sentinel).unwrap(), b"must remain");
}

#[test]
fn legacy_migration_keeps_every_version_and_import_needs_only_the_session() {
    let f = Fixture::new();
    let root = f.archive();
    fs::create_dir_all(root.join("viewer/old")).unwrap();
    fs::write(root.join("viewer/old/code.ts"), "old viewer copy").unwrap();
    Archive::new(root.clone()).unwrap();
    assert!(!root.join("viewer").exists());
    assert_eq!(
        fs::read_to_string(root.join(".legacy/viewer/old/code.ts")).unwrap(),
        "old viewer copy"
    );
    let workspace = f.workspace();
    let source = workspace.join("code.ts");
    let bytes = ["before\r\n", "after 🧪\n", "baseline only\n"];
    let mut hashes = Vec::new();
    for value in bytes {
        fs::write(&source, value).unwrap();
        hashes.push(files::store_file(&root, &source).unwrap().0);
    }
    let mut j = journal::Journal::open(&root, "legacy").unwrap();
    j.append(&Captured::new(
        "input",
        &user("Preserve the entire session"),
    ))
    .unwrap();
    j.append(&Captured::new(
        "tool",
        &json!({"type":"tool_result","content":"output 🧪".repeat(30000)}),
    ))
    .unwrap();
    j.append(&Captured::new("file", &json!({"type":"file-version","path":source,"change":"modified","before":{"hash":hashes[0]},"after":{"hash":hashes[1]}}))).unwrap();
    j.append(&Captured::new("file", &json!({"type":"file-version","path":source,"change":"deleted","before":{"hash":hashes[1]},"after":null}))).unwrap();
    j.flush(true).unwrap();
    drop(j);
    let session = layout::session_dir(&root, "legacy").unwrap();
    let chat = session.join("Chat");
    fs::write(
        chat.join("files-manifest.jsonl"),
        format!(
            "{}\n",
            json!([source,{"hash":hashes[2],"bytes":14,"modified":0,"link":null}])
        ),
    )
    .unwrap();
    fs::write(
        chat.join("config.json"),
        json!({"enabled":true,"cwd":workspace,"roots":[workspace],"title":"Legacy portable"})
            .to_string(),
    )
    .unwrap();
    let original_log = fs::read(chat.join("events.jsonl")).unwrap();
    // Build a real v1 fixture, moving only fixed children inside this fixture.
    for entry in fs::read_dir(&chat).unwrap() {
        let entry = entry.unwrap();
        if entry.file_name() != "format.json" {
            fs::rename(entry.path(), session.join(entry.file_name())).unwrap();
        }
    }
    fs::remove_file(chat.join("format.json")).unwrap();
    assert_eq!(journal::chat_dir(&root, "legacy").unwrap(), session);
    layout::ensure(&root, "legacy").unwrap();
    assert_eq!(fs::read(chat.join("events.jsonl")).unwrap(), original_log);
    assert_eq!(
        fs::read(root.join(".legacy/chats/legacy/events.jsonl")).unwrap(),
        original_log
    );
    assert!(!session.join("events.jsonl").exists());
    for (i, hash) in hashes.iter().enumerate() {
        assert_eq!(
            files::object_page(&root, "legacy", hash, 0).unwrap()["text"],
            bytes[i]
        );
    }
    let imported_root = f.0.join("imported");
    let imported = layout::import(&imported_root, &session).unwrap();
    assert_eq!(imported["chatId"], "legacy");
    // All original absolute paths disappear after import.
    fs::rename(&root, f.0.join("unavailable-archive")).unwrap();
    fs::rename(&workspace, f.0.join("unavailable-workspace")).unwrap();
    let imported_chat = journal::chat_dir(&imported_root, "legacy").unwrap();
    assert_eq!(
        fs::read(imported_chat.join("events.jsonl")).unwrap(),
        original_log
    );
    assert_eq!(journal::entry_count(&imported_chat), 4);
    for (i, hash) in hashes.iter().enumerate() {
        assert_eq!(
            files::object_page(&imported_root, "legacy", hash, 0).unwrap()["text"],
            bytes[i]
        );
    }
    let copy = files::materialize(&imported_root, "legacy", &hashes[1], "code.ts").unwrap();
    assert!(copy.starts_with(imported_root.join("chats/legacy/View/files")));
    assert_eq!(fs::read_to_string(copy).unwrap(), bytes[1]);
    let config: Config =
        serde_json::from_slice(&fs::read(imported_chat.join("config.json")).unwrap()).unwrap();
    assert!(!config.enabled);
    let duplicate = layout::import(&imported_root, &imported_root.join("chats/legacy")).unwrap();
    assert_ne!(duplicate["chatId"], "legacy");
    assert_eq!(
        journal::session_page(&imported_root, 0, "").unwrap()["total"],
        2
    );
    assert_eq!(
        fs::read(imported_chat.join("events.jsonl")).unwrap(),
        original_log
    );
}

#[test]
fn session_import_rejects_missing_corrupt_and_linked_objects_without_publishing() {
    let f = Fixture::new();
    let root = f.archive();
    let source = f.workspace().join("code.txt");
    fs::write(&source, "saved code").unwrap();
    let mut j = journal::Journal::open(&root, "source").unwrap();
    let view = layout::view_dir(&root, "source").unwrap();
    let (hash, _) = files::store_file(&view, &source).unwrap();
    j.append(&Captured::new(
        "file",
        &json!({"type":"file-version","after":{"hash":hash}}),
    ))
    .unwrap();
    j.flush(true).unwrap();
    drop(j);
    let session = layout::session_dir(&root, "source").unwrap();
    let object = files::object_path(&view, &hash).unwrap();
    fs::write(&object, "corrupted!").unwrap();
    let target = f.0.join("corrupt-import");
    assert!(layout::import(&target, &session).is_err());
    assert_eq!(journal::session_page(&target, 0, "").unwrap()["total"], 0);
    fs::remove_file(&object).unwrap();
    let target = f.0.join("missing-import");
    assert!(layout::import(&target, &session).is_err());
    assert_eq!(journal::session_page(&target, 0, "").unwrap()["total"], 0);
    files::store_file(&view, &source).unwrap();
    // Directory junctions do not need Windows developer-mode symlink privileges.
    #[cfg(windows)]
    {
        let link = session.join("View/external-link");
        let status = std::process::Command::new("powershell")
            .env("ARCHIVE_TEST_LINK", &link)
            .env("ARCHIVE_TEST_TARGET", f.workspace())
            .args(["-NoProfile", "-Command", "New-Item -ItemType Junction -Path $env:ARCHIVE_TEST_LINK -Target $env:ARCHIVE_TEST_TARGET -ErrorAction Stop | Out-Null"])
            .status().unwrap();
        assert!(status.success());
        let target = f.0.join("linked-import");
        assert!(layout::import(&target, &session).is_err());
        assert_eq!(journal::session_page(&target, 0, "").unwrap()["total"], 0);
        fs::remove_dir(link).unwrap();
    }
    assert!(layout::session_dir(&root, "../escape").is_err());
}

#[test]
fn archive_names_survive_configuration_restart_and_session_import() {
    let f = Fixture::new();
    let root = f.archive();
    let workspace = f.workspace();
    let a = Archive::new(root.clone()).unwrap();
    let r = a.recorder("named").unwrap();
    let mut config = Config {
        enabled: true,
        cwd: workspace.to_string_lossy().into(),
        roots: vec![],
        title: "Automatic original title".into(),
    };
    r.configure(config.clone()).unwrap();
    r.record("input", &user("Original prompt stays unchanged"));
    r.flush_all().unwrap();
    let log = journal::chat_dir(&root, "named")
        .unwrap()
        .join("events.jsonl");
    let original = fs::read(&log).unwrap();
    a.rename_session("named", "  내가 정한 이름 🧪  ").unwrap();
    assert_eq!(fs::read(&log).unwrap(), original);
    for invalid in ["", "\n", "two\nlines", &"x".repeat(201)] {
        assert!(a.rename_session("named", invalid).is_err());
    }
    config.enabled = false;
    r.configure(config).unwrap();
    a.shutdown();
    let reopened = Archive::new(root.clone()).unwrap();
    let page = journal::session_page(&root, 0, "내가 정한").unwrap();
    assert_eq!(page["items"][0]["title"], "내가 정한 이름 🧪");
    assert!(!reopened.saved_config("named").unwrap().enabled);
    let imported_root = f.0.join("imported-name");
    layout::import(
        &imported_root,
        &layout::session_dir(&root, "named").unwrap(),
    )
    .unwrap();
    assert_eq!(
        journal::session_page(&imported_root, 0, "").unwrap()["items"][0]["title"],
        "내가 정한 이름 🧪"
    );
}

#[test]
fn deleting_a_recording_session_stops_capture_and_preserves_other_sessions_and_workspace() {
    let f = Fixture::new();
    let root = f.archive();
    let workspace = f.workspace();
    let source = workspace.join("keep.txt");
    fs::write(&source, "Actual workspace file").unwrap();
    let a = Archive::new(root.clone()).unwrap();
    let r = a.recorder("remove-me").unwrap();
    let config = Config {
        enabled: true,
        cwd: workspace.to_string_lossy().into(),
        roots: vec![],
        title: "Remove me".into(),
    };
    r.configure(config.clone()).unwrap();
    r.record("input", &user("Delete this archive only"));
    r.flush_all().unwrap();
    let mut keep = journal::Journal::open(&root, "keep-me").unwrap();
    keep.append(&Captured::new("input", &user("Keep this session")))
        .unwrap();
    keep.flush(true).unwrap();
    drop(keep);
    let other_dir = journal::chat_dir(&root, "keep-me").unwrap();
    let other = fs::read(other_dir.join("events.jsonl")).unwrap();
    let backup = root.join(".legacy/chats/remove-me");
    fs::create_dir_all(&backup).unwrap();
    fs::write(backup.join("events.jsonl"), "Legacy backup").unwrap();
    let (shared_hash, _) = files::store_file(&root, &source).unwrap();
    a.delete_session("remove-me").unwrap();
    assert!(!layout::session_dir(&root, "remove-me").unwrap().exists());
    assert!(!backup.exists());
    assert!(a.find("remove-me").is_none());
    assert!(!a.saved_config("remove-me").unwrap().enabled);
    assert!(
        r.configure(config).is_err(),
        "A stale recorder must never recreate deleted data"
    );
    r.record("input", &user("Must not be archived"));
    a.prepare_view("remove-me").unwrap();
    assert!(!layout::session_dir(&root, "remove-me").unwrap().exists());
    assert_eq!(
        fs::read_to_string(&source).unwrap(),
        "Actual workspace file"
    );
    assert_eq!(fs::read(other_dir.join("events.jsonl")).unwrap(), other);
    assert!(files::object_path(&root, &shared_hash).unwrap().exists());
    assert!(a.delete_session("../workspace").is_err());
    assert!(a.delete_session("missing").is_err());
    assert_eq!(journal::session_page(&root, 0, "").unwrap()["total"], 1);
}

#[cfg(windows)]
#[test]
fn archive_deletion_never_follows_directory_junctions() {
    let f = Fixture::new();
    let root = f.archive();
    let workspace = f.workspace();
    let source = workspace.join("untouched.txt");
    fs::write(&source, "Untouched").unwrap();
    let a = Archive::new(root.clone()).unwrap();
    fs::create_dir_all(root.join("chats")).unwrap();
    let junction = |link: &Path| {
        let status = std::process::Command::new("powershell")
            .env("ARCHIVE_TEST_LINK", link).env("ARCHIVE_TEST_TARGET", &workspace)
            .args(["-NoProfile", "-Command", "New-Item -ItemType Junction -Path $env:ARCHIVE_TEST_LINK -Target $env:ARCHIVE_TEST_TARGET -ErrorAction Stop | Out-Null"])
            .status().unwrap();
        assert!(status.success());
    };
    let linked = root.join("chats/linked");
    junction(&linked);
    assert!(a.delete_session("linked").is_err());
    assert_eq!(fs::read_to_string(&source).unwrap(), "Untouched");
    fs::remove_dir(linked).unwrap();
    drop(journal::Journal::open(&root, "nested").unwrap());
    junction(&root.join("chats/nested/View/linked"));
    a.delete_session("nested").unwrap();
    assert_eq!(fs::read_to_string(&source).unwrap(), "Untouched");
    assert!(!root.join("chats/nested").exists());
}
fn until(mut f: impl FnMut() -> bool) {
    let t = Instant::now();
    while !f() {
        assert!(
            t.elapsed() < Duration::from_secs(10),
            "archive condition timed out"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn library_groups_all_turns_and_restarts_into_one_logical_session() {
    let f = Fixture::new();
    let root = f.archive();
    let save_exchange = |chat: &str, text: &str, at: u64| {
        let mut journal = journal::Journal::open(&root, chat).unwrap();
        journal.append(&event("input", user(text), at)).unwrap();
        journal
            .append(&event(
                "ui",
                json!({"type":"assistant-done","text":format!("Reply to {text}")}),
                at + 1,
            ))
            .unwrap();
        journal
            .append(&event(
                "ui",
                json!({"type":"result","isError":false}),
                at + 2,
            ))
            .unwrap();
        journal.flush(true).unwrap();
    };
    // Reopen the original v1 journal for each exchange, as after pause/restart.
    save_exchange("session-a", "First message", 100);
    save_exchange("session-b", "Separate session", 200);
    save_exchange("session-a", "Second message after restart", 300);
    let page = journal::session_page(&root, 0, "").unwrap();
    assert_eq!(page["total"], 2);
    let a = &page["items"][0];
    assert_eq!(a["chatId"], "session-a");
    assert_eq!(a["startedAt"], 100);
    assert_eq!(a["updatedAt"], 302);
    assert_eq!(a["events"], 6);
    let dir = journal::chat_dir(&root, "session-a").unwrap();
    assert_eq!(journal::turn_page(&dir, 0).unwrap()["total"], 2);
    let conversation = journal::list_entries(&dir, 1, 60, "conversation", "", "").unwrap();
    let texts: Vec<_> = conversation["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| full_payload(&dir, e["seq"].as_u64().unwrap()))
        .map(|e| {
            if e["source"] == "input" {
                message_text(&e["payload"]["message"]["content"])
            } else {
                e["payload"]["text"].as_str().unwrap().into()
            }
        })
        .collect();
    assert_eq!(
        texts,
        vec![
            "First message",
            "Reply to First message",
            "Second message after restart",
            "Reply to Second message after restart"
        ]
    );
}

#[test]
fn library_pages_sessions_and_searches_beyond_the_first_page() {
    let f = Fixture::new();
    let root = f.archive();
    for i in 0..65 {
        let id = format!("session-{i:03}");
        let mut j = journal::Journal::open(&root, &id).unwrap();
        j.append(&event("input", user(&format!("Archive {i:03}")), 100 + i))
            .unwrap();
        j.flush(true).unwrap();
    }
    // Empty status/config folders do not become saved sessions.
    fs::create_dir_all(root.join("chats/empty-session")).unwrap();
    let first = journal::session_page(&root, 0, "").unwrap();
    assert_eq!(first["total"], 65);
    assert_eq!(first["items"].as_array().unwrap().len(), 60);
    assert_eq!(first["items"][0]["chatId"], "session-064");
    assert_eq!(first["next"], 60);
    let next = journal::session_page(&root, 60, "").unwrap();
    assert_eq!(next["items"].as_array().unwrap().len(), 5);
    assert!(next["next"].is_null());
    let found = journal::session_page(&root, 0, "archive 000").unwrap();
    assert_eq!(found["total"], 1);
    assert_eq!(found["items"][0]["chatId"], "session-000");
}

#[test]
fn timeline_keeps_actions_and_outputs_while_file_snapshots_stay_separate() {
    let f = Fixture::new();
    let root = f.archive();
    let dir = journal::chat_dir(&root, "timeline").unwrap();
    let mut j = journal::Journal::open(&root, "timeline").unwrap();
    let events = [
        ("input", user("Read and update a file")),
        (
            "protocol-in",
            json!({"type":"item/agentMessage/delta","delta":"stream"}),
        ),
        ("ui", json!({"type":"assistant-stream","text":"stream"})),
        (
            "tool",
            json!({"type":"tool_use","id":"read-1","name":"Read","input":{"file_path":"one.txt"}}),
        ),
        (
            "file",
            json!({"type":"file-version","path":"one.txt","change":"created","origin":"tool-or-attachment"}),
        ),
        ("file", json!({"type":"file-reference","path":"one.txt"})),
        (
            "file",
            json!({"type":"coverage-gap","text":"File changed during capture"}),
        ),
        (
            "file",
            json!({"type":"file-version","path":"one.txt","change":"modified"}),
        ),
        (
            "tool",
            json!({"type":"tool_result","tool_use_id":"read-1","content":"x".repeat(500_000)}),
        ),
        ("ui", json!({"type":"assistant-done","text":"Done"})),
        ("ui", json!({"type":"result","isError":false})),
        (
            "file",
            json!({"type":"file-version","path":"other.txt","change":"modified"}),
        ),
        ("lifecycle", json!({"type":"recording-enabled"})),
        ("lifecycle", json!({"type":"recording-paused"})),
        ("ui", json!({"type":"thinking-clear"})),
        ("ui", json!({"type":"question-closed"})),
        ("ui", json!({"type":"model-fallback"})),
        ("ui", json!({"type":"api-retry"})),
    ];
    for (i, (source, value)) in events.into_iter().enumerate() {
        let mut e = event(source, value, i as u64 + 1);
        if e.kind == "result" {
            e.activity = None; // Existing archives also hide successful completion.
        }
        j.append(&e).unwrap();
    }
    j.flush(true).unwrap();
    let p = journal::list_entries(&dir, 1, 60, "timeline", "", "").unwrap();
    let rows = p["items"].as_array().unwrap();
    assert_eq!(
        rows.iter()
            .map(|e| e["seq"].as_u64().unwrap())
            .collect::<Vec<_>>(),
        [1, 4, 9, 10]
    );
    assert_eq!(journal::entry_count(&dir), 18);
    assert_eq!(full_payload(&dir, 11)["payload"]["isError"], false);
    assert_eq!(
        full_payload(&dir, 13)["payload"]["type"],
        "recording-enabled"
    );
    assert_eq!(
        full_payload(&dir, 14)["payload"]["type"],
        "recording-paused"
    );
    assert_eq!(rows[1]["activity"]["operation"], "read");
    assert!(rows.iter().all(|row| row["source"] != "file"));
    assert_eq!(rows[2]["activity"]["operation"], "read");
    assert_eq!(rows[2]["activity"]["phase"], "end");
    assert_eq!(rows[2]["activity"]["target"], "one.txt");
    let files = journal::list_entries_range(&dir, 5, 60, "files", "", "", 8).unwrap();
    assert_eq!(files["items"].as_array().unwrap().len(), 3);
    assert!(files["next"].is_null());
    assert_eq!(
        full_payload(&dir, 9)["payload"]["content"]
            .as_str()
            .unwrap()
            .len(),
        500_000
    );
}

#[test]
fn timeline_describes_codex_read_errors_and_preserves_review_events() {
    let read = Captured::new(
        "tool",
        &json!({"type":"item/completed","item":{"id":"exec-1","type":"commandExecution","status":"failed","command":"cat one.txt","commandActions":[{"type":"read","path":"one.txt"}],"exitCode":1}}),
    );
    let a = read.activity.unwrap();
    assert_eq!(a.operation, "read");
    assert_eq!(a.target, "one.txt");
    assert!(a.error);
    let f = Fixture::new();
    let root = f.archive();
    let mut j = journal::Journal::open(&root, "review").unwrap();
    for (source, v) in [
        ("ui", json!({"type":"permission-request"})),
        ("response", json!({"allow":true})),
        ("ui", json!({"type":"question-request"})),
        ("file", json!({"type":"capture-error","error":"unreadable"})),
        ("ui", json!({"type":"tool-start"})),
        ("ui", json!({"type":"terminal"})),
        ("runtime", json!({"type":"runtime-event"})),
        (
            "ui",
            json!({"type":"result","isError":true,"text":"Execution failed"}),
        ),
        (
            "file",
            json!({"type":"coverage-gap","text":"File changed during capture"}),
        ),
        (
            "protocol-in",
            json!({"type":"coverage-gap","text":"Rejected engine frame"}),
        ),
        ("ui", json!({"type":"error","message":"Command failed"})),
    ] {
        let mut e = Captured::new(source, &v);
        e.activity = None; // Legacy result headers still expose execution failures.
        j.append(&e).unwrap();
    }
    j.flush(true).unwrap();
    let page = journal::list_entries(
        &journal::chat_dir(&root, "review").unwrap(),
        1,
        60,
        "timeline",
        "",
        "",
    )
    .unwrap();
    assert_eq!(page["items"].as_array().unwrap().len(), 5);
    assert_eq!(page["items"][3]["activity"]["error"], true);
    assert_eq!(page["items"][4]["kind"], "error");
    let dir = journal::chat_dir(&root, "review").unwrap();
    let diagnostics = journal::list_entries(&dir, 1, 60, "diagnostics", "", "").unwrap();
    assert_eq!(
        diagnostics["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["seq"].as_u64().unwrap())
            .collect::<Vec<_>>(),
        [4, 9, 10]
    );
    assert_eq!(full_payload(&dir, 4)["payload"]["error"], "unreadable");
    assert!(
        journal::list_entries(&dir, 1, 60, "files", "", "").unwrap()["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn complete_unicode_tool_payload_survives_paged_reads() {
    let f = Fixture::new();
    let root = f.archive();
    let dir = journal::chat_dir(&root, "chat-a").unwrap();
    let mut j = journal::Journal::open(&root, "chat-a").unwrap();
    j.append(&event(
        "identity",
        json!({"engine":{"model":"actual-model","effort":"high"},"cwd":"project"}),
        10,
    ))
    .unwrap();
    j.append(&event("input", user("전체 내용을 저장해줘 🧪"), 20))
        .unwrap();
    let output = "원문 🧪 line\r\n".repeat(50_000);
    j.append(&event(
        "tool",
        json!({"type":"tool_result","tool_use_id":"t1","content":output}),
        30,
    ))
    .unwrap();
    j.append(&event(
        "ui",
        json!({"type":"assistant-done","runId":"r1","text":"완료"}),
        40,
    ))
    .unwrap();
    j.append(&event(
        "ui",
        json!({"type":"result","runId":"r1","isError":false,"durationMs":20}),
        50,
    ))
    .unwrap();
    j.flush(true).unwrap();
    assert_eq!(full_payload(&dir, 3)["payload"]["content"], output);
    let turns = journal::turns(&dir).unwrap();
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0].title, "전체 내용을 저장해줘 🧪");
    assert_eq!(turns[0].model, "actual-model");
    assert_eq!(turns[0].duration_ms, 30);
    let messages = journal::list_entries(&dir, 1, 60, "conversation", "", "").unwrap();
    assert_eq!(messages["items"].as_array().unwrap().len(), 2);
}
#[test]
fn queue_drain_does_not_move_previous_reply_to_new_turn() {
    let f = Fixture::new();
    let root = f.archive();
    let dir = journal::chat_dir(&root, "q").unwrap();
    let mut j = journal::Journal::open(&root, "q").unwrap();
    for e in [
        event("input", user("first"), 10),
        event(
            "ui",
            json!({"type":"status","status":"analyzing","runId":"r1"}),
            11,
        ),
        event("protocol-in", json!({"type":"result","is_error":false}), 20),
        event("input", user("second"), 21),
        event(
            "ui",
            json!({"type":"assistant-done","text":"first answer","runId":"r1"}),
            22,
        ),
        event(
            "ui",
            json!({"type":"result","isError":false,"runId":"r1"}),
            23,
        ),
        event(
            "ui",
            json!({"type":"status","status":"analyzing","runId":"r2"}),
            24,
        ),
    ] {
        j.append(&e).unwrap();
    }
    j.flush(true).unwrap();
    let turns = journal::turns(&dir).unwrap();
    assert_eq!(turns.len(), 2);
    let first = turns.iter().find(|t| t.title == "first").unwrap();
    let second = turns.iter().find(|t| t.title == "second").unwrap();
    assert_eq!(second.status, "running");
    assert_eq!(full_payload(&dir, 5)["turnId"], first.id);
    assert_eq!(full_payload(&dir, 7)["turnId"], second.id);
}
#[test]
fn torn_tail_recovers_without_dropping_committed_history() {
    let f = Fixture::new();
    let root = f.archive();
    let dir = journal::chat_dir(&root, "recovery").unwrap();
    {
        let mut j = journal::Journal::open(&root, "recovery").unwrap();
        j.append(&event("input", user("keep me"), 1)).unwrap();
        j.append(&event(
            "ui",
            json!({"type":"assistant-stream","delta":"partial"}),
            5,
        ))
        .unwrap();
        j.flush(true).unwrap();
    }
    OpenOptions::new()
        .append(true)
        .open(dir.join("events.jsonl"))
        .unwrap()
        .write_all(b"{\"seq\":3,\"payload\":")
        .unwrap();
    OpenOptions::new()
        .append(true)
        .open(dir.join("entries.idx"))
        .unwrap()
        .write_all(&[1, 2, 3, 4])
        .unwrap();
    let mut j = journal::Journal::open(&root, "recovery").unwrap();
    assert_eq!(journal::entry_count(&dir), 2);
    assert_eq!(journal::turns(&dir).unwrap()[0].status, "interrupted");
    j.append(&event("input", user("continue"), 20)).unwrap();
    j.flush(true).unwrap();
    assert_eq!(journal::entry_count(&dir), 3);
    assert_eq!(full_payload(&dir, 1)["payload"], user("keep me"));
}
#[test]
fn snapshots_preserve_binary_modified_deleted_and_external_attachment() {
    let f = Fixture::new();
    let root = f.archive();
    let workspace = f.workspace();
    let src = workspace.join("source.txt");
    fs::write(&src, "before\r\n").unwrap();
    let ignored = workspace.join(".gitignored");
    fs::create_dir(&ignored).unwrap();
    fs::write(ignored.join("generated.bin"), [0, 1, 2, 255]).unwrap();
    let a = Archive::new(root.clone()).unwrap();
    let r = a.recorder("files").unwrap();
    r.configure(Config {
        enabled: true,
        cwd: workspace.to_string_lossy().into_owned(),
        roots: vec![],
        title: "files".into(),
    })
    .unwrap();
    r.record("input", &user("change files"));
    r.flush_all().unwrap(); // Wait for the initial file copy before changing its bytes.
    fs::write(&src, "after 🧪\n").unwrap();
    r.checkpoint();
    let dir = journal::chat_dir(&root, "files").unwrap();
    until(|| {
        r.flush().unwrap();
        let p = journal::list_entries(&dir, 1, 100, "files", "", "").unwrap();
        p["items"].as_array().unwrap().iter().any(|e| {
            full_payload(&dir, e["seq"].as_u64().unwrap())["payload"]["change"] == "modified"
        })
    });
    fs::remove_file(&src).unwrap();
    let attachment = f.0.join("attachment.png");
    let bytes = [0, 137, 80, 78, 71, 255, 33];
    fs::write(&attachment, bytes).unwrap();
    r.record("request", &json!({"echoImages":[attachment]}));
    r.checkpoint();
    until(|| {
        r.flush().unwrap();
        let p = journal::list_entries(&dir, 1, 100, "files", "", "").unwrap();
        p["items"].as_array().unwrap().iter().any(|e| {
            full_payload(&dir, e["seq"].as_u64().unwrap())["payload"]["change"] == "deleted"
        }) && p["items"].as_array().unwrap().iter().any(|e| {
            full_payload(&dir, e["seq"].as_u64().unwrap())["payload"]["path"]
                .as_str()
                .unwrap_or("")
                .ends_with("attachment.png")
        })
    });
    a.shutdown();
    let events = journal::list_entries(&dir, 1, 100, "files", "", "").unwrap();
    let payloads: Vec<_> = events["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| full_payload(&dir, e["seq"].as_u64().unwrap())["payload"].clone())
        .collect();
    let modified = payloads.iter().find(|p| p["change"] == "modified").unwrap();
    assert_eq!(
        files::object_page(
            &root,
            "files",
            modified["before"]["hash"].as_str().unwrap(),
            0
        )
        .unwrap()["text"],
        "before\r\n"
    );
    assert_eq!(
        files::object_page(
            &root,
            "files",
            modified["after"]["hash"].as_str().unwrap(),
            0
        )
        .unwrap()["text"],
        "after 🧪\n"
    );
    let att = payloads
        .iter()
        .find(|p| p["path"].as_str().unwrap_or("").ends_with("attachment.png"))
        .unwrap();
    let copy = files::materialize(
        &root,
        "files",
        att["after"]["hash"].as_str().unwrap(),
        "attachment.png",
    )
    .unwrap();
    assert_eq!(fs::read(copy).unwrap(), bytes);
}
#[test]
fn disabled_recording_has_no_event_growth_and_toggle_keeps_history() {
    let f = Fixture::new();
    let root = f.archive();
    let workspace = f.workspace();
    let a = Archive::new(root.clone()).unwrap();
    let r = a.recorder("off").unwrap();
    let value = json!({"type":"assistant-stream","delta":"x".repeat(10000)});
    for _ in 0..1000 {
        r.record("ui", &value)
    }
    r.flush().unwrap();
    assert_eq!(
        journal::entry_count(&journal::chat_dir(&root, "off").unwrap()),
        0
    );
    r.configure(Config {
        enabled: true,
        cwd: workspace.to_string_lossy().into_owned(),
        ..Default::default()
    })
    .unwrap();
    r.record("input", &user("saved"));
    r.configure(Config {
        enabled: false,
        ..Default::default()
    })
    .unwrap();
    let count = journal::entry_count(&journal::chat_dir(&root, "off").unwrap());
    for _ in 0..1000 {
        r.record("ui", &value)
    }
    r.flush().unwrap();
    assert_eq!(
        journal::entry_count(&journal::chat_dir(&root, "off").unwrap()),
        count
    );
    a.shutdown();
}
#[test]
fn own_archive_inside_workspace_is_not_recursively_captured() {
    let f = Fixture::new();
    let workspace = f.workspace();
    let root = workspace.join("archive");
    fs::create_dir_all(&root).unwrap();
    fs::write(workspace.join("one.txt"), "one").unwrap();
    let a = Archive::new(root.clone()).unwrap();
    let r = a.recorder("self").unwrap();
    r.configure(Config {
        enabled: true,
        cwd: workspace.to_string_lossy().into_owned(),
        ..Default::default()
    })
    .unwrap();
    r.flush_all().unwrap();
    assert_eq!(r.status()["status"]["fileCount"], 1);
    r.record("input", &user("self exclusion"));
    r.flush().unwrap();
    a.shutdown();
    let count = journal::entry_count(&journal::chat_dir(&root, "self").unwrap());
    assert!(count < 15, "archive observed itself: {count}");
}
#[test]
fn invalid_ids_and_missing_files_are_errors_not_arbitrary_reads() {
    let f = Fixture::new();
    let a = Archive::new(f.archive()).unwrap();
    assert!(a.recorder("../escape").is_err());
    assert!(files::object_page(&a.root, "invalid", "../../x", 0).is_err());
    assert!(files::object_page(&a.root, "invalid", &"a".repeat(64), 0).is_err());
    a.shutdown();
}

#[test]
fn recording_and_stop_do_not_wait_for_a_large_initial_file_copy() {
    let f = Fixture::new();
    let root = f.archive();
    let work = f.workspace();
    // A sparse source makes copying take time without building a large fixture
    // in memory. Stop should interrupt the copy at a streaming chunk boundary.
    fs::File::create(work.join("large.bin")).unwrap().set_len(512 * 1024 * 1024).unwrap();
    let a = Archive::new(root.clone()).unwrap();
    let r = a.recorder("async-start").unwrap();
    let mut config = Config { enabled: true, cwd: work.to_string_lossy().into(), ..Default::default() };
    let start = Instant::now();
    r.configure(config.clone()).unwrap();
    assert!(start.elapsed() < Duration::from_secs(2), "start waited for file bytes");
    assert_eq!(r.status()["status"]["enabled"], true);
    assert_eq!(r.status()["status"]["preparing"], true);
    let pending = layout::view_dir(&root, "async-start").unwrap().join("pending");
    until(|| fs::read_dir(&pending).is_ok_and(|mut entries| entries.next().is_some()));
    r.record("input", &user("record me during file preparation"));
    r.record("ui", &json!({"type":"assistant-done","text":"also record the response"}));
    r.flush().unwrap();
    let chat = journal::chat_dir(&root, "async-start").unwrap();
    assert!(fs::read_to_string(chat.join("events.jsonl")).unwrap().contains("record me during file preparation"));
    let stop = Instant::now();
    config.enabled = false;
    r.configure(config).unwrap();
    assert!(stop.elapsed() < Duration::from_secs(2), "stop waited for the rest of the baseline");
    assert_eq!(r.status()["status"]["preparing"], false);
    assert_eq!(r.status()["status"]["enabled"], false);
    assert_eq!(r.status()["status"]["coverageErrors"], 0);
    assert_eq!(fs::read_dir(&pending).unwrap().count(), 0, "cancelled partial copy was left behind");
    assert!(fs::read_to_string(chat.join("events.jsonl")).unwrap().contains("baseline-cancelled"));
    a.shutdown();
}

#[test]
fn capture_policy_matches_nested_ignores_and_preserves_explicit_files_and_lockfiles() {
    let f = Fixture::new();
    let work = f.workspace();
    let root = f.archive();
    fs::create_dir_all(work.join("src/nested")).unwrap();
    fs::write(work.join(".gitignore"), "generated/\n*.tmp\n!keep.tmp\n").unwrap();
    fs::write(work.join("src/.gitignore"), "nested/*.txt\n!nested/keep.txt\n").unwrap();
    let mut p = file_policy::Policy::new(root, vec![work.clone()]);
    assert!(!p.automatic(&work.join("generated/hidden.txt"), false));
    assert!(!p.automatic(&work.join("src/nested/drop.txt"), false));
    assert!(p.automatic(&work.join("src/nested/keep.txt"), false));
    assert!(p.automatic(&work.join("keep.tmp"), false));
    assert!(!p.automatic(&work.join("drop.tmp"), false));
    assert!(p.automatic(&work.join("Cargo.lock"), false));
    assert!(p.automatic(&work.join("LOCK"), false));
    assert!(p.explicit(&work.join("generated/hidden.txt")));
    assert!(p.explicit(&work.join("node_modules/package/result.txt")));
    assert!(!p.automatic(&work.join("node_modules/package/result.txt"), false));
    assert!(!p.explicit(&work.join(".poc-home-review/webview2/EBWebView/LOCK")));
    fs::write(work.join(".gitignore"), "").unwrap();
    p.refresh();
    assert!(p.automatic(&work.join("drop.tmp"), false));
}

#[test]
fn cancelling_manifest_restore_preserves_all_historical_rows() {
    let f = Fixture::new();
    let root = f.archive();
    let work = f.workspace();
    let a = Archive::new(root.clone()).unwrap();
    let r = a.recorder("restore-cancel").unwrap();
    let manifest = journal::chat_dir(&root, "restore-cancel").unwrap().join("files-manifest.jsonl");
    let row = format!("{}\n", json!([work.join("target/debug/old.bin"), {"hash":"a".repeat(64),"bytes":4,"modified":1,"link":null}]));
    let history = row.repeat(150_000);
    fs::write(&manifest, &history).unwrap();
    r.configure(Config { enabled: true, cwd: work.to_string_lossy().into(), ..Default::default() }).unwrap();
    assert_eq!(r.status()["status"]["preparing"], true);
    r.record("input", &user("resume during manifest loading"));
    r.configure(Config::default()).unwrap();
    assert_eq!(fs::read_to_string(&manifest).unwrap(), history);
    a.shutdown();
}

#[test]
fn resuming_file_capture_keeps_the_before_after_edge_found_by_the_baseline() {
    let f = Fixture::new();
    let root = f.archive();
    let work = f.workspace();
    let source = work.join("resume.txt");
    fs::write(&source, "previously saved").unwrap();
    let a = Archive::new(root.clone()).unwrap();
    let r = a.recorder("resume-edge").unwrap();
    let config = Config { enabled: true, cwd: work.to_string_lossy().into(), ..Default::default() };
    r.configure(config.clone()).unwrap();
    r.flush_all().unwrap();
    r.configure(Config::default()).unwrap();
    fs::write(&source, "changed before the baseline revisited it").unwrap();
    r.configure(config).unwrap();
    r.flush_all().unwrap();
    let chat = journal::chat_dir(&root, "resume-edge").unwrap();
    let rows = journal::list_entries(&chat, 1, 100, "files", "", "").unwrap();
    let change = rows["items"].as_array().unwrap().iter()
        .map(|e| full_payload(&chat, e["seq"].as_u64().unwrap())["payload"].clone())
        .find(|p| p["change"] == "modified").expect("baseline must preserve the version edge");
    assert_eq!(files::object_page(&root,"resume-edge",change["before"]["hash"].as_str().unwrap(),0).unwrap()["text"], "previously saved");
    assert_eq!(files::object_page(&root,"resume-edge",change["after"]["hash"].as_str().unwrap(),0).unwrap()["text"], "changed before the baseline revisited it");
    a.shutdown();
}

#[cfg(windows)]
#[test]
fn a_locked_project_source_still_reports_a_real_capture_failure() {
    use std::os::windows::fs::OpenOptionsExt;
    let f = Fixture::new();
    let work = f.workspace();
    let source = work.join("important.txt");
    fs::write(&source, "must not silently ignore this").unwrap();
    let _exclusive = OpenOptions::new().read(true).share_mode(0).open(&source).unwrap();
    let a = Archive::new(f.archive()).unwrap();
    let r = a.recorder("locked-source").unwrap();
    r.configure(Config { enabled: true, cwd: work.to_string_lossy().into(), ..Default::default() }).unwrap();
    r.record("input", &user("messages remain recordable"));
    r.flush_all().unwrap();
    assert!(r.status()["status"]["coverageErrors"].as_u64().unwrap() > 0);
    assert!(r.status()["status"]["error"].as_str().unwrap().contains("important.txt"));
    assert!(fs::read_to_string(journal::chat_dir(&a.root, "locked-source").unwrap().join("events.jsonl")).unwrap().contains("messages remain recordable"));
    a.shutdown();
}

#[test]
fn inventory_and_notifications_skip_ignored_files_but_explicit_outputs_are_saved() {
    let f = Fixture::new();
    let work = f.workspace();
    let root = f.archive();
    fs::write(work.join(".gitignore"), "generated/\n").unwrap();
    for name in ["src/code.txt", "Cargo.lock", "generated/output.bin", "node_modules/pkg/cache", "target/debug/app", ".poc-home-test/webview2/EBWebView/Default/Extension State/LOCK"] {
        let path = work.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, name).unwrap();
    }
    #[cfg(windows)]
    let _locked_profile = {
        use std::os::windows::fs::OpenOptionsExt;
        OpenOptions::new().read(true).share_mode(0).open(work.join(".poc-home-test/webview2/EBWebView/Default/Extension State/LOCK")).unwrap()
    };
    let a = Archive::new(root.clone()).unwrap();
    let r = a.recorder("policy").unwrap();
    r.configure(Config { enabled: true, cwd: work.to_string_lossy().into(), ..Default::default() }).unwrap();
    r.flush_all().unwrap();
    let chat = journal::chat_dir(&root, "policy").unwrap();
    let initial = fs::read_to_string(chat.join("files-manifest.jsonl")).unwrap();
    assert!(initial.contains("code.txt") && initial.contains("cargo.lock"));
    assert!(!initial.contains("node_modules") && !initial.contains("target") && !initial.contains("generated") && !initial.contains("webview"));
    fs::write(work.join("generated/output.bin"), "explicit result").unwrap();
    fs::write(work.join("node_modules/pkg/cache"), "ignored notification").unwrap();
    r.flush_all().unwrap();
    assert!(!fs::read_to_string(chat.join("files-manifest.jsonl")).unwrap().contains("generated"));
    r.record("request", &json!({"path":work.join("generated/output.bin")}));
    r.flush_all().unwrap();
    assert!(fs::read_to_string(chat.join("files-manifest.jsonl")).unwrap().contains("generated"));
    assert_eq!(r.status()["status"]["coverageErrors"], 0);
    assert!(r.status()["status"]["error"].is_null());
    a.shutdown();
}

#[cfg(windows)]
fn transient_lock_recovers_without_another_write(byte_range: bool) {
    use std::os::windows::fs::OpenOptionsExt;
    let f = Fixture::new();
    let root = f.archive();
    let work = f.workspace();
    let source = work.join("locked.txt");
    fs::write(&source, "read after unlock").unwrap();
    fs::write(work.join("free.txt"), "other files must proceed").unwrap();
    let held = OpenOptions::new().read(true).write(true).share_mode(if byte_range { 7 } else { 0 }).open(&source).unwrap();
    if byte_range {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::Storage::FileSystem::{LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY};
        let mut overlap = windows::Win32::System::IO::OVERLAPPED::default();
        unsafe { LockFileEx(HANDLE(held.as_raw_handle() as _), LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, None, 1, 0, &mut overlap) }.unwrap();
    }
    let a = Archive::new(root.clone()).unwrap();
    let r = a.recorder("transient-lock").unwrap();
    r.configure(Config { enabled:true, cwd:work.to_string_lossy().into(), ..Default::default() }).unwrap();
    r.record("input", &user("messages continue while the file is locked"));
    r.flush().unwrap();
    let chat = journal::chat_dir(&root, "transient-lock").unwrap();
    let manifest = chat.join("files-manifest.jsonl");
    until(|| fs::read_to_string(&manifest).is_ok_and(|s|s.contains("free.txt")));
    assert!(!fs::read_to_string(&manifest).unwrap().contains("locked.txt"));
    assert!(fs::read_to_string(chat.join("events.jsonl")).unwrap().contains("messages continue"));
    assert_eq!(r.status()["status"]["coverageErrors"],0);
    std::thread::sleep(Duration::from_millis(120));
    drop(held); // No new write, tool-end, or checkpoint to wake the retry worker.
    until(|| fs::read_to_string(&manifest).is_ok_and(|s|s.contains("locked.txt")) && r.status()["status"]["preparing"]==false);
    assert_eq!(r.status()["status"]["coverageErrors"],0);
    assert!(r.status()["status"]["error"].is_null());
    a.shutdown();
}

#[cfg(windows)]
#[test]
fn sharing_violation_is_retried_while_other_files_and_messages_proceed() {
    transient_lock_recovers_without_another_write(false);
}

#[cfg(windows)]
#[test]
fn byte_range_lock_is_retried_without_another_filesystem_event() {
    transient_lock_recovers_without_another_write(true);
}

#[cfg(windows)]
#[test]
fn persistent_lock_is_reported_once_and_recovery_rechecks_preserved_mtime() {
    use std::os::windows::fs::OpenOptionsExt;
    let f = Fixture::new();
    let work = f.workspace();
    let source = work.join("same.txt");
    fs::write(&source,"AAAA").unwrap();
    let original_time = fs::metadata(&source).unwrap().modified().unwrap();
    let a = Archive::new(f.archive()).unwrap();
    let r = a.recorder("persistent-lock").unwrap();
    r.configure(Config { enabled:true, cwd:work.to_string_lossy().into(), ..Default::default() }).unwrap();
    r.flush_all().unwrap();
    let mut held = OpenOptions::new().read(true).write(true).share_mode(0).open(&source).unwrap();
    held.write_all(b"BBBB").unwrap();
    held.set_times(std::fs::FileTimes::new().set_modified(original_time)).unwrap();
    until(|| r.status()["status"]["coverageErrors"].as_u64().unwrap()>0);
    assert_eq!(r.status()["status"]["coverageErrors"],1);
    r.flush_all().unwrap();
    assert_eq!(r.status()["status"]["coverageErrors"],1,"do not repeat the same unresolved error");
    drop(held);
    r.flush_all().unwrap();
    assert!(r.status()["status"]["error"].is_null(),"recovery clears the current file error");
    assert_eq!(r.status()["status"]["coverageErrors"],1,"historical error count is preserved");
    let chat=journal::chat_dir(&a.root,"persistent-lock").unwrap();
    let rows=journal::list_entries(&chat,1,100,"files","","").unwrap();
    let change=rows["items"].as_array().unwrap().iter().map(|e|full_payload(&chat,e["seq"].as_u64().unwrap())["payload"].clone())
        .find(|p|p["change"]=="modified").expect("failed reads must bypass unchanged mtime optimization");
    assert_eq!(files::object_page(&a.root,"persistent-lock",change["after"]["hash"].as_str().unwrap(),0).unwrap()["text"],"BBBB");
    a.shutdown();
}

#[cfg(windows)]
#[test]
fn stopping_during_retry_wait_does_not_wait_for_the_backoff_budget() {
    use std::os::windows::fs::OpenOptionsExt;
    let f=Fixture::new();
    let work=f.workspace();
    let source=work.join("locked.txt");
    fs::write(&source,"held through stop").unwrap();
    fs::write(work.join("free.txt"),"ready").unwrap();
    let _held=OpenOptions::new().read(true).share_mode(0).open(source).unwrap();
    let a=Archive::new(f.archive()).unwrap();
    let r=a.recorder("retry-stop").unwrap();
    r.configure(Config { enabled:true,cwd:work.to_string_lossy().into(),..Default::default() }).unwrap();
    let manifest=journal::chat_dir(&a.root,"retry-stop").unwrap().join("files-manifest.jsonl");
    until(||fs::read_to_string(&manifest).is_ok_and(|s|s.contains("free.txt")));
    std::thread::sleep(Duration::from_millis(100));
    let start=Instant::now();
    r.configure(Config::default()).unwrap();
    assert!(start.elapsed()<Duration::from_millis(500));
    assert_eq!(r.status()["status"]["preparing"],false);
    assert_eq!(r.status()["status"]["enabled"],false);
    a.shutdown();
}

#[test]
fn copying_a_changing_file_does_not_publish_an_unstable_object() {
    let f=Fixture::new();
    let source=f.workspace().join("changing.bin");
    fs::File::create(&source).unwrap().set_len(256*1024*1024).unwrap();
    let root=f.archive();
    let thread_root=root.clone();
    let thread_source=source.clone();
    let copy=std::thread::spawn(move||files::store_file(&thread_root,&thread_source));
    // Windows may not expose the new length of an open output through directory
    // metadata yet. Creation occurs after the input's initial metadata was read.
    until(||fs::read_dir(root.join("pending")).is_ok_and(|mut items|items.next().is_some()));
    OpenOptions::new().write(true).open(&source).unwrap().set_len(1).unwrap();
    assert_eq!(copy.join().unwrap().unwrap_err().kind(),std::io::ErrorKind::WouldBlock);
    assert!(!root.join("objects").exists(),"unstable bytes must not be published");
    assert_eq!(fs::read_dir(root.join("pending")).unwrap().count(),0);
}

#[test]
fn replacing_a_file_is_distinguished_from_the_original_open_handle() {
    let f=Fixture::new();
    let source=f.workspace().join("source.txt");
    fs::write(&source,"same bytes").unwrap();
    let before=fs::File::open(&source).unwrap();
    let unchanged=fs::File::open(&source).unwrap();
    assert!(files::same_open_file(&before,&unchanged).unwrap());
    fs::rename(&source,f.0.join("previous.txt")).unwrap();
    fs::write(&source,"same bytes").unwrap();
    let replacement=fs::File::open(&source).unwrap();
    assert!(!files::same_open_file(&before,&replacement).unwrap());
}

#[test]
fn temporary_absence_during_replace_keeps_the_before_after_edge() {
    let f=Fixture::new();
    let work=f.workspace();
    let source=work.join("replace.txt");
    fs::write(&source,"before replacement").unwrap();
    let a=Archive::new(f.archive()).unwrap();
    let r=a.recorder("atomic-replace").unwrap();
    r.configure(Config { enabled:true,cwd:work.to_string_lossy().into(),..Default::default() }).unwrap();
    r.flush_all().unwrap();
    fs::rename(&source,f.0.join("old.txt")).unwrap();
    let replacement=source.clone();
    let writer=std::thread::spawn(move||{std::thread::sleep(Duration::from_millis(80));fs::write(replacement,"after replacement").unwrap()});
    r.flush_all().unwrap();
    writer.join().unwrap();
    r.flush_all().unwrap();
    let chat=journal::chat_dir(&a.root,"atomic-replace").unwrap();
    let rows=journal::list_entries(&chat,1,100,"files","","").unwrap();
    let changes:Vec<_>=rows["items"].as_array().unwrap().iter().map(|e|full_payload(&chat,e["seq"].as_u64().unwrap())["payload"].clone()).collect();
    assert!(!changes.iter().any(|p|p["change"]=="deleted"),"a short replace gap is not a completed deletion");
    assert!(changes.iter().any(|p|p["change"]=="modified"));
    assert_eq!(r.status()["status"]["coverageErrors"],0);
    a.shutdown();
}
#[test]
fn perf_batch_preserves_all_events_with_bounded_queue_and_paged_index() {
    let f = Fixture::new();
    let root = f.archive();
    let workspace = f.workspace();
    let a = Archive::new(root.clone()).unwrap();
    let r = a.recorder("perf").unwrap();
    let value = json!({"type":"assistant-stream","messageId":"m","delta":"abcdefghij".repeat(64)});
    let start = Instant::now();
    for _ in 0..10_000 {
        r.record("ui", &value)
    }
    let off = start.elapsed();
    r.configure(Config {
        enabled: true,
        cwd: workspace.to_string_lossy().into_owned(),
        ..Default::default()
    })
    .unwrap();
    r.record("input", &user("benchmark"));
    r.flush_all().unwrap();
    let dir = journal::chat_dir(&root, "perf").unwrap();
    let before = journal::entry_count(&dir);
    let start = Instant::now();
    for _ in 0..10_000 {
        r.record("ui", &value)
    }
    r.flush().unwrap();
    let on = start.elapsed();
    assert_eq!(journal::entry_count(&dir) - before, 10_000);
    assert!(lock(&r.queue.pending).bytes <= QUEUE_BYTES);
    let query = Instant::now();
    let page = journal::list_entries(&dir, before + 9900, 60, "ui", "", "").unwrap();
    let read = query.elapsed();
    assert_eq!(page["items"].as_array().unwrap().len(), 60);
    eprintln!(
        "ARCHIVE_PERF events=10000 off_us={} on_flush_ms={} late_page_ms={} payload_bytes={}",
        off.as_micros(),
        on.as_millis(),
        read.as_millis(),
        r.status()["status"]["writtenBytes"]
    );
    a.shutdown();
}

#[test]
fn tool_created_file_outside_workspace_is_retried_after_tool_completion() {
    let f = Fixture::new();
    let root = f.archive();
    let work = f.workspace();
    let output = f.0.join("desktop-result.html");
    let a = Archive::new(root.clone()).unwrap();
    let r = a.recorder("outside").unwrap();
    r.configure(Config {
        enabled: true,
        cwd: work.to_string_lossy().into_owned(),
        ..Default::default()
    })
    .unwrap();
    r.record("input", &user("write outside the workspace"));
    r.record("protocol-in",&json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"write1","name":"Write","input":{"file_path":output,"content":"saved outside"}}]}}));
    r.flush().unwrap();
    std::thread::sleep(Duration::from_millis(80));
    fs::write(&output, "saved outside").unwrap();
    r.record(
        "ui",
        &json!({"type":"tool-end","id":"write1","status":"done"}),
    );
    r.flush_all().unwrap();
    let dir = journal::chat_dir(&root, "outside").unwrap();
    let rows = journal::list_entries(&dir, 1, 100, "files", "", "").unwrap();
    let record = rows["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| full_payload(&dir, e["seq"].as_u64().unwrap())["payload"].clone())
        .find(|p| {
            p["path"]
                .as_str()
                .unwrap_or("")
                .ends_with("desktop-result.html")
        })
        .expect("outside output is captured after creation");
    assert_eq!(
        files::object_page(
            &root,
            "outside",
            record["after"]["hash"].as_str().unwrap(),
            0
        )
        .unwrap()["text"],
        "saved outside"
    );
    assert_eq!(r.status()["status"]["coverageErrors"], 0);
    a.shutdown();
}

#[test]
fn filesystem_events_detect_same_size_writes_with_preserved_mtime() {
    let f = Fixture::new();
    let root = f.archive();
    let work = f.workspace();
    let source = work.join("same.txt");
    fs::write(&source, "AAAA").unwrap();
    let mtime = fs::metadata(&source).unwrap().modified().unwrap();
    let a = Archive::new(root.clone()).unwrap();
    let r = a.recorder("mtime").unwrap();
    r.configure(Config {
        enabled: true,
        cwd: work.to_string_lossy().into_owned(),
        ..Default::default()
    })
    .unwrap();
    r.record("input", &user("same mtime"));
    r.flush_all().unwrap();
    fs::write(&source, "BBBB").unwrap();
    OpenOptions::new()
        .write(true)
        .open(&source)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(mtime))
        .unwrap();
    let dir = journal::chat_dir(&root, "mtime").unwrap();
    until(|| {
        r.flush().unwrap();
        let rows = journal::list_entries(&dir, 1, 100, "files", "", "").unwrap();
        rows["items"].as_array().unwrap().iter().any(|e| {
            let p = full_payload(&dir, e["seq"].as_u64().unwrap());
            p["payload"]["after"]["hash"].as_str().is_some_and(|h| {
                files::object_page(&root, "mtime", h, 0).unwrap()["text"] == "BBBB"
            })
        })
    });
    a.shutdown();
}

#[test]
fn viewing_a_previous_run_does_not_start_watchers_or_relabel_completed_turns() {
    let f = Fixture::new();
    let root = f.archive();
    let work = f.workspace();
    let a = Archive::new(root.clone()).unwrap();
    let r = a.recorder("history").unwrap();
    r.configure(Config {
        enabled: true,
        cwd: work.to_string_lossy().into_owned(),
        ..Default::default()
    })
    .unwrap();
    r.record("input", &user("completed run"));
    r.record("ui", &json!({"type":"result","isError":false}));
    r.record(
        "lifecycle",
        &json!({"type":"interrupted","reason":"application-exit"}),
    );
    a.shutdown();
    let restarted = Archive::new(root.clone()).unwrap();
    assert!(restarted.saved_config("history").unwrap().enabled);
    restarted.prepare_view("history").unwrap();
    assert!(restarted.find("history").is_none());
    assert_eq!(
        journal::turns(&journal::chat_dir(&root, "history").unwrap()).unwrap()[0].status,
        "completed"
    );
    restarted.shutdown();
}

#[test]
fn failed_commit_keeps_full_payload_for_retry_without_publishing_a_partial_index() {
    let f = Fixture::new();
    let root = f.archive();
    let dir = journal::chat_dir(&root, "retry").unwrap();
    let mut j = journal::Journal::open(&root, "retry").unwrap();
    j.append(&event("input", user("preserve on failure"), 10))
        .unwrap();
    j.flush(true).unwrap();
    let writable = j.replace_index_handle(std::fs::File::open(dir.join("entries.idx")).unwrap());
    let body = "must survive failed write 🧪\n".repeat(20_000);
    assert!(j
        .append(&event(
            "ui",
            json!({"type":"result","text":body,"isError":false}),
            20
        ))
        .is_err());
    assert_eq!(
        journal::entry_count(&dir),
        1,
        "uncommitted payloads are not advertised to the viewer"
    );
    j.replace_index_handle(writable);
    j.flush(true).unwrap();
    assert_eq!(journal::entry_count(&dir), 2);
    assert_eq!(full_payload(&dir, 2)["payload"]["text"], body);
    j.append(&event("stderr", json!({"type":"stderr","text":"next"}), 30))
        .unwrap();
    j.flush(true).unwrap();
    assert_eq!(journal::entry_count(&dir), 3);
    assert_eq!(full_payload(&dir, 3)["seq"], 3);
}
