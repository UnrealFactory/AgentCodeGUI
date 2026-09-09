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
fn timeline_keeps_actions_and_outputs_in_order_and_groups_file_records() {
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
        [1, 4, 5, 9, 10, 12]
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
    assert_eq!(rows[2]["fileGroup"]["count"], 3);
    assert_eq!(rows[2]["fileGroup"]["endSeq"], 8);
    assert_eq!(rows[3]["activity"]["operation"], "read");
    assert_eq!(rows[3]["activity"]["phase"], "end");
    assert_eq!(rows[3]["activity"]["target"], "one.txt");
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
    r.flush().unwrap();
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
