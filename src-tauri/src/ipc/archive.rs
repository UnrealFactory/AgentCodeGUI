//! Native pickers for portable sessions. Archive I/O stays in ccg-store and all
//! of these calls run in ipc_call's blocking pool, with the requesting parent.
use super::{arg, system::DialogGuard};
use serde_json::{json, Value};
use tauri::{AppHandle, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

fn export_name(title: &str) -> String {
    let name: String = title
        .chars()
        .take(100)
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let name = name.trim_matches([' ', '.']);
    if name.is_empty() {
        "session.zip".into()
    } else {
        format!("session-{name}.zip")
    }
}

pub fn dispatch(
    app: &AppHandle,
    window: &WebviewWindow,
    channel: &str,
    p: &Value,
) -> Option<Value> {
    if !matches!(channel, "archive:pick-import" | "archive:pick-export") {
        return None;
    }
    let options = arg(p, 0);
    let _guard = DialogGuard::new();
    let builder = app.dialog().file().set_parent(window);
    let selected = if channel == "archive:pick-export" {
        builder
            .set_title(ccg_fs::t("세션 내보내기", "Export session"))
            .add_filter(ccg_fs::t("세션 ZIP 파일", "Session ZIP file"), &["zip"])
            .set_file_name(export_name(options["title"].as_str().unwrap_or_default()))
            .blocking_save_file()
    } else if options["kind"] == "folder" {
        builder
            .set_title(ccg_fs::t(
                "가져올 세션 폴더 선택",
                "Choose a session folder to import",
            ))
            .blocking_pick_folder()
    } else {
        builder
            .set_title(ccg_fs::t(
                "가져올 세션 ZIP 선택",
                "Choose a session ZIP to import",
            ))
            .add_filter(ccg_fs::t("세션 ZIP 파일", "Session ZIP file"), &["zip"])
            .blocking_pick_file()
    };
    Some(match selected {
        Some(path) => match path.into_path() {
            Ok(path) => json!({"path":path.to_string_lossy()}),
            Err(error) => json!({"ok":false,"error":error.to_string()}),
        },
        None => json!({"path":null}),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_names_are_portable_and_keep_unicode_titles() {
        assert_eq!(export_name("대화 기록 🧪"), "session-대화 기록 🧪.zip");
        assert_eq!(
            export_name("../folder\\name:part\n"),
            "session-_folder_name_part_.zip"
        );
        assert_eq!(export_name(" . "), "session.zip");
        assert_eq!(export_name("CON"), "session-CON.zip");
    }
}
