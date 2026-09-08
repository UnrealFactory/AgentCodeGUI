//! Real Roslyn + TypeScript regression (requires installed C# server and .NET 10).
//! cargo test -p ccg-lsp --test blazor_live -- --ignored --nocapture
use serde_json::Value;
use std::{fs, path::Path, process::Command, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};

struct StopServers;
impl Drop for StopServers {
    fn drop(&mut self) { ccg_lsp::dispose_all(); }
}

fn ready(root: &str, file: &str) {
    ccg_lsp::warm(root, file);
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let status = ccg_lsp::status(root, file);
        if status == "ready" { return; }
        assert!(!["error", "unsupported", "need-install"].contains(&status), "{file}: {status}");
        assert!(Instant::now() < deadline, "{file}: indexing timed out");
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn position(text: &str, needle: &str, inside: usize) -> (u32, u32) {
    let at = text.find(needle).expect(needle) + inside;
    let prefix = &text[..at];
    (prefix.bytes().filter(|b| *b == b'\n').count() as u32,
     prefix.rsplit('\n').next().unwrap_or("").encode_utf16().count() as u32)
}

fn hover(root: &str, file: &str, text: &str, needle: &str, inside: usize, buffer: bool) -> String {
    let (line, col) = position(text, needle, inside);
    ccg_lsp::hover_at(root, file, line, col, buffer.then_some(text)).expect("hover").to_string()
}

#[test]
#[ignore = "requires the installed Roslyn language server and .NET 10 SDK"]
fn razor_codebehind_components_and_javascript_share_real_project_analysis() {
    let _stop = StopServers;
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join(format!("ccg-blazor-live-{stamp}"));
    fs::create_dir_all(&dir).unwrap();
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/fixtures/blazor");
    for file in fs::read_dir(fixture).unwrap().flatten().filter(|e| e.path().is_file()) {
        fs::copy(file.path(), dir.join(file.file_name())).unwrap();
    }
    let mut restore = Command::new("dotnet");
    restore.args(["restore", "BlazorProbe.csproj", "--ignore-failed-sources", "--nologo"]).current_dir(&dir);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        restore.creation_flags(0x08000000);
    }
    let restored = restore.output().unwrap();
    assert!(restored.status.success(), "{}", String::from_utf8_lossy(&restored.stdout));
    let root = dir.to_str().unwrap();
    ready(root, "Counter.razor");
    let text = fs::read_to_string(dir.join("Counter.razor")).unwrap();
    let title = hover(root, "Counter.razor", &text, "@Title", 3, false);
    assert!(title.contains("Counter.Title") && title.contains("string"), "{title}");
    let (line, col) = position(&text, "@Title", 3);
    let definition = ccg_lsp::definition(root, "Counter.razor", line, col);
    assert!(definition.iter().any(|d| d.to_string().contains("Counter.razor.cs")), "{definition:?}");
    let component = hover(root, "Counter.razor", &text, "<Greeting", 3, false);
    assert!(component.contains("Greeting"), "{component}");
    let tokens = ccg_lsp::semantic_tokens(root, "Counter.razor").unwrap();
    let types = tokens["types"].as_array().unwrap();
    let data = tokens["data"].as_array().unwrap();
    assert!(!data.is_empty());
    assert!(types.iter().any(|t| t == "razorComponentElement"), "{types:?}");
    for token in data.chunks_exact(5) {
        assert!((token[3].as_u64().unwrap() as usize) < types.len(), "unregistered Razor token");
    }
    assert!(data.chunks_exact(5).any(|t| types[t[3].as_u64().unwrap() as usize] == "property"));
    assert!(data.chunks_exact(5).any(|t| types[t[3].as_u64().unwrap() as usize] == "razorComponentElement"));
    let cs = fs::read_to_string(dir.join("Counter.razor.cs")).unwrap();
    assert!(hover(root, "Counter.razor.cs", &cs, "Count {", 2, false).contains("Counter.Count"));
    let cs_tokens = ccg_lsp::semantic_tokens(root, "Counter.razor.cs").unwrap();
    assert!(cs_tokens["data"].as_array().unwrap().chunks_exact(5).all(|t| {
        let kind = cs_tokens["types"][t[3].as_u64().unwrap() as usize].as_str().unwrap();
        !kind.starts_with("razor") && !kind.starts_with("markup")
    }), "Razor registration must not reinterpret C# tokens");

    ready(root, "client.js");
    let js = fs::read_to_string(dir.join("client.js")).unwrap();
    assert!(hover(root, "client.js", &js, "increment(1)", 3, false).contains("number"));
    let (line, col) = position(&js, "increment(1)", 3);
    let defs = ccg_lsp::definition(root, "client.js", line, col);
    assert!(defs.iter().any(|d| d.to_string().contains("Counter.razor.js")), "{defs:?}");
    let js_tokens = ccg_lsp::semantic_tokens(root, "Counter.razor.js").unwrap();
    assert!(!js_tokens["data"].as_array().unwrap().is_empty(), "JavaScript semantic colors remain available");

    let edited = text.replace("<h1>@Title</h1>", "<h1>@Title.Length</h1>");
    let length = hover(root, "Counter.razor", &edited, "Title.Length", 8, true);
    assert!(length.contains("Length") && length.contains("int"), "{length}");
    let labels: Vec<&str> = types.iter().filter_map(Value::as_str).collect();
    println!("Blazor: codebehind hover/definition, component hover, {} tokens ({} kinds), JS imports and unsaved Razor edits passed.", data.len() / 5, labels.len());
}
