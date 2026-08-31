//! 첨부 파일 선택 — `dialog:pick-attachments` (최종 파리티 감사 R1 §3.2 **H1**).
//!
//! 컴포저의 「＋」 버튼이 **3표면에서 무반응**이었다(`App.tsx:774`·`MultiAgent.tsx:491`·
//! `SessionWindow.tsx:503`). 드래그·붙여넣기는 되므로(`attachment:save-data` 구현)
//! "첨부가 된다"고 착각하기 쉬운 자리인데, 파일 탐색기에서 고르는 길만 막혀 있었다.
//!
//! 2.6.2(`index.ts:1351`)와 같은 것: 다중 선택, 필터 3벌(전체/이미지/텍스트), 취소는
//! 빈 배열, **그리고 문구 넷의 ko/en**(SMALL3 R1 — `decisions-3.0.md` §3.4-B가 잡은
//! 회귀다. 초판이 `set_title`/`add_filter`에 한국어 리터럴을 그대로 박아 `ui.lang=en`
//! 에서도 네이티브 창의 제목·필터 이름만 한국어로 남았다. `ccg_fs::t`로 감쌌고 en
//! 문자열은 2.6.2 `index.ts:1355-1360`에서 글자 그대로 가져왔다). 다른 것 하나:
//! **부모 창**을 못 건다 — `tauri-plugin-dialog`의 `pick_files`에는
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

/// 대화상자 문구 넷 — `[제목, 필터1, 필터2, 필터3]`. **순서가 곧 아래 빌더 순서다.**
///
/// ★SMALL3 R1. 인라인이 아니라 함수로 뺀 이유는 하나다 — **못을 박을 자리**가 필요했다.
/// `pick_attachments`는 네이티브 창을 여는 블로킹 호출이라 테스트가 못 부른다. 문구만
/// 떼어 두면 언어 판정이 실제로 도는 것을 프로세스 밖에서 잴 수 있다(아래 `tests`).
///
/// en 문자열은 2.6.2 `src/main/index.ts:1355-1360`에서 **글자 그대로** 가져왔다.
fn labels() -> [String; 4] {
    [
        ccg_fs::t("첨부할 파일 선택", "Choose files to attach"),
        ccg_fs::t("첨부 가능한 파일", "Attachable files"),
        ccg_fs::t("이미지", "Images"),
        ccg_fs::t("텍스트·문서", "Text & documents"),
    ]
}

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
    let [title, f_all, f_img, f_txt] = labels();
    app.dialog()
        .file()
        .set_title(title)
        // 순서가 곧 대화상자의 기본 필터다 — 2.6.2와 같이 「첨부 가능한 파일」이 첫 줄.
        .add_filter(f_all, &all)
        .add_filter(f_img, &IMAGE)
        .add_filter(f_txt, &TEXT)
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

    // ── ★SMALL3 R1 — 문구 넷이 `ui.lang`을 따르는가 ────────────────────────
    //
    // **한 프로세스에서 두 언어를 볼 수 없다.** `ccg_fs::t`의 언어 판정(`is_en`)은
    // 2초 TTL의 **프로세스 전역 원자 캐시**라 첫 읽기로 굳는다. 스레드로 도는 테스트가
    // `CCG_HOME`을 번갈아 바꾸면 서로의 캐시를 밟아 순서에 따라 답이 갈린다.
    //
    // 그래서 부모는 격리 홈을 언어마다 하나씩 만들고 **자식 테스트 프로세스**를 띄운다
    // (`ccg-auth`의 T4가 쓰는 것과 같은 자기 재실행 수법). 자식은 홈 하나만 보고
    // `labels()`를 그대로 찍는다 — 즉 **호출부가 쓰는 바로 그 함수**를 잰다.
    //
    // 홈에는 `ui-prefs.json` 한 장만 놓는다(사용자 실홈은 읽지도 복사하지도 않는다).

    const CHILD_ENV: &str = "CCG_SMALL3_DIALOG_LANG_CHILD";
    const CHILD_TEST: &str = "ipc::parity::dialog::tests::child_prints_the_dialog_labels";
    const MARK: &str = "SMALL3-LABELS>";

    /// 자식 역할 — `CHILD_ENV`가 있을 때만 일한다. 평소 주행에서는 `#[ignore]`라 건너뛴다.
    #[test]
    #[ignore = "부모(the_dialog_labels_follow_ui_lang)가 격리 홈과 함께 직접 띄운다"]
    fn child_prints_the_dialog_labels() {
        if std::env::var(CHILD_ENV).is_err() {
            return;
        }
        // 탭은 이 문구 넷에 안 들어간다 — 구분자로 안전하다.
        println!("{MARK}{}", labels().join("\t"));
    }

    /// `ui.lang` 하나만 든 격리 홈에서 자식을 돌리고 라벨 넷을 받아 온다.
    /// `lang`이 `None`이면 `ui-prefs.json`을 아예 안 놓는다(= 갓 설치한 홈).
    fn labels_under(tag: &str, lang: Option<&str>) -> Vec<String> {
        let home = std::env::temp_dir().join(format!(
            "ccg-small3-dialog-{tag}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
        ));
        std::fs::create_dir_all(&home).expect("격리 홈을 못 만들었다");
        if let Some(l) = lang {
            std::fs::write(home.join("ui-prefs.json"), format!("{{\"ui.lang\":\"{l}\"}}"))
                .expect("ui-prefs.json을 못 썼다");
        }
        let out = std::process::Command::new(std::env::current_exe().expect("테스트 바이너리"))
            .args(["--exact", CHILD_TEST, "--nocapture", "--include-ignored"])
            .env(CHILD_ENV, "1")
            .env("CCG_HOME", &home)
            .output()
            .expect("자식 프로세스를 못 띄웠다");
        let _ = std::fs::remove_dir_all(&home);
        let text = String::from_utf8_lossy(&out.stdout).into_owned();
        let line = text
            .lines()
            .find_map(|l| l.strip_prefix(MARK))
            .unwrap_or_else(|| panic!("자식이 라벨을 안 찍었다 ({tag}):\n{text}"));
        line.split('\t').map(str::to_string).collect()
    }

    /// 못 — `ui.lang=en`이면 네 문구 전부 영어, 기본/`ko`면 전부 한국어.
    ///
    /// `decisions-3.0.md` §3.4-B가 잡은 회귀가 여기다: 초판은 리터럴을 그대로 박아
    /// **어느 언어에서도 한국어**였다. 이 못이 부러지면 그 회귀가 돌아온 것이다.
    #[test]
    fn the_dialog_labels_follow_ui_lang() {
        let ko = ["첨부할 파일 선택", "첨부 가능한 파일", "이미지", "텍스트·문서"];
        let en = ["Choose files to attach", "Attachable files", "Images", "Text & documents"];

        assert_eq!(labels_under("en", Some("en")), en, "★ui.lang=en인데 영어가 아니다");
        assert_eq!(labels_under("ko", Some("ko")), ko, "ui.lang=ko가 한국어가 아니다");
        // 무변 확인 — 언어를 한 번도 안 고른 홈은 예전과 같이 한국어다.
        assert_eq!(labels_under("default", None), ko, "기본(설정 없음)이 한국어가 아니다");
    }
}
