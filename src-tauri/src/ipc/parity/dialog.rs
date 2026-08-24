//! 첨부 파일 선택 — `dialog:pick-attachments` (최종 파리티 감사 R1 §3.2 **H1**).
//!
//! 컴포저의 「＋」 버튼이 **3표면에서 무반응**이었다(`App.tsx:774`·`MultiAgent.tsx:491`·
//! `SessionWindow.tsx:503`). 드래그·붙여넣기는 되므로(`attachment:save-data` 구현)
//! "첨부가 된다"고 착각하기 쉬운 자리인데, 파일 탐색기에서 고르는 길만 막혀 있었다.
//!
//! 2.6.2(`index.ts:1351`)와 같은 것: 다중 선택, 필터 3벌(전체/이미지/텍스트), 취소는
//! 빈 배열. 다른 것 하나: **부모 창**을 못 건다 — `tauri-plugin-dialog`의 `pick_files`에는
//! 부모 지정이 없다(rfd `set_parent`가 노출되지 않는다). 모달이 아니라 그냥 다른 창이
//! 되는데, 대신 크래시 복구가 고아 대화상자를 거두는 그물이 이미 있다
//! (`ipc/system.rs close_orphan_dialogs` — 그쪽 `DIALOGS_OPEN` 계수기를 함께 쓴다).

use serde_json::{json, Value};
use tauri::AppHandle;

/// 이미지 — `src/shared/attachments.ts:5` `ATTACH_IMAGE_EXTS`의 미러.
const IMAGE: [&str; 9] = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico"];
/// 텍스트·문서 — 같은 파일 `:8` `ATTACH_TEXT_EXTS`의 미러(순서까지 그대로).
const TEXT: [&str; 56] = [
    // 문서
    "txt", "md", "markdown", "html", "htm",
    // 데이터·설정
    "json", "jsonc", "json5", "csv", "tsv", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf",
    "properties", "log",
    // 코드
    "js", "mjs", "cjs", "jsx", "ts", "tsx", "css", "scss", "less", "c", "h", "cc", "cpp", "cxx",
    "hpp", "hh", "cs", "java", "kt", "rs", "go", "swift", "php", "rb", "lua", "py", "sql", "sh",
    "bash", "bat", "cmd", "ps1",
    // 언리얼·기타
    "verse", "uproject", "uplugin", "patch", "diff",
];

/// `dialog:pick-attachments()` → `string[]`(취소는 `[]`).
///
/// **블로킹이다** — 사용자가 대화상자를 닫을 때까지 돌아오지 않는다. 그래서 이 채널은
/// `parity::owns`를 통해 `spawn_blocking` 팔로 간다(모듈 헤더). tokio 워커에서 이걸
/// 기다리면 그동안 다른 창의 창 컨트롤·저장이 통째로 굶는다.
pub fn pick_attachments(app: &AppHandle) -> Value {
    use tauri_plugin_dialog::DialogExt;
    let all: Vec<&str> = IMAGE.iter().chain(TEXT.iter()).copied().collect();
    let (tx, rx) = std::sync::mpsc::channel();
    let guard = super::super::system::DialogGuard::new();
    app.dialog()
        .file()
        .set_title("첨부할 파일 선택")
        // 순서가 곧 대화상자의 기본 필터다 — 2.6.2와 같이 「첨부 가능한 파일」이 첫 줄.
        .add_filter("첨부 가능한 파일", &all)
        .add_filter("이미지", &IMAGE)
        .add_filter("텍스트·문서", &TEXT)
        .pick_files(move |p| {
            let _ = tx.send(p);
        });
    let r = rx.recv();
    drop(guard);
    let paths = match r {
        Ok(Some(list)) => list
            .into_iter()
            .filter_map(|p| p.into_path().ok())
            .map(|pb| json!(pb.to_string_lossy().to_string()))
            .collect::<Vec<Value>>(),
        // 취소·채널 단절 — 계약면은 `[]`다(`null`이면 렌더러가 `.length`에서 죽는다).
        _ => vec![],
    };
    Value::Array(paths)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 확장자 목록이 2.6.2 `src/shared/attachments.ts`와 **글자까지 같은가**.
    /// 이 목록이 갈리면 "드롭은 되는데 고르면 안 보이는 파일"이 생긴다 — 사용자가
    /// 앱 버그로 읽는 종류의 어긋남이라 소스를 직접 읽어 대조한다.
    #[test]
    fn the_filters_mirror_the_frozen_shared_list() {
        let src = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/shared/attachments.ts"),
        )
        .expect("동결된 2.6.2 목록을 못 읽었다");
        // `export const X = [...]` 안의 따옴표 문자열만 순서대로 뽑는다.
        let pick = |name: &str| -> Vec<String> {
            let head = src.find(&format!("export const {name} = [")).expect("목록이 없다");
            let body = &src[head..];
            let end = body.find(']').expect("목록이 안 닫혔다");
            body[..end]
                .split('\'')
                .skip(1)
                .step_by(2)
                .map(str::to_string)
                .collect()
        };
        assert_eq!(pick("ATTACH_IMAGE_EXTS"), IMAGE.to_vec(), "이미지 확장자가 어긋났다");
        assert_eq!(pick("ATTACH_TEXT_EXTS"), TEXT.to_vec(), "텍스트 확장자가 어긋났다");
    }
}
