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

/// 대화상자 문구 넷 — **자리마다 이름이 있다.**
///
/// ★SMALL3 R3(확인 크리틱 R2의 EPAIR). R2까지 이것은 `[String; 4]`였고, 그래서
/// 구조분해 한 줄의 **순서만** 뒤바꾸면(`let [f_all, title, …] = labels();`) 제목과 첫
/// 필터가 서로 자리를 바꾼 채 **레포의 자동 검사가 전부 초록**이었다 — 못 셋도 하네스도.
/// 리터럴이 는 것도, 한국어가 는 것도, 변수 이름이 바뀐 것도 아니어서 **볼 것이 없었다**.
/// 게다가 악의가 필요 없다: 구조분해 줄을 만지는 평범한 리팩터가 그대로 내는 사고다.
///
/// 처방은 못을 하나 더 박는 게 아니라 **버그를 표현 불가능하게** 만드는 것이다.
/// 이름을 붙이면 「위치」라는 개념 자체가 사라진다 — 필드는 순서로 섞이지 않는다.
///
/// ★SMALL3 R1(원래의 이유, 그대로 유효): 인라인이 아니라 함수로 뺀 것은 **못을 박을
/// 자리**가 필요했기 때문이다. `pick_attachments`는 네이티브 창을 여는 블로킹 호출이라
/// 테스트가 못 부른다. 문구만 떼어 두면 언어 판정이 실제로 도는 것을 프로세스 밖에서
/// 잴 수 있다(아래 `tests`).
struct DialogLabels {
    /// 창 제목.
    title: String,
    /// **첫** 필터 — 이미지+텍스트 전부. 첫 줄인 것이 2.6.2와의 규약이다.
    filter_all: String,
    /// 둘째 필터 — 이미지만.
    filter_images: String,
    /// 셋째 필터 — 텍스트·문서만.
    filter_docs: String,
}

/// en 문자열은 2.6.2 `src/main/index.ts:1355-1360`에서 **글자 그대로** 가져왔다.
fn labels() -> DialogLabels {
    DialogLabels {
        title: ccg_fs::t("첨부할 파일 선택", "Choose files to attach"),
        filter_all: ccg_fs::t("첨부 가능한 파일", "Attachable files"),
        filter_images: ccg_fs::t("이미지", "Images"),
        filter_docs: ccg_fs::t("텍스트·문서", "Text & documents"),
    }
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
    let l = labels();
    app.dialog()
        .file()
        .set_title(l.title)
        // 순서가 곧 대화상자의 기본 필터다 — 2.6.2와 같이 「첨부 가능한 파일」이 첫 줄.
        .add_filter(l.filter_all, &all)
        .add_filter(l.filter_images, &IMAGE)
        .add_filter(l.filter_docs, &TEXT)
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
    ///
    /// ★R3: **필드 이름표를 달아** 찍는다. R2까지는 배열을 `join`해 위치로 넘겼는데,
    /// 그러면 이 못 자체가 「위치 대응」을 하나 더 만드는 셈이라 EPAIR과 같은 부류의
    /// 어긋남을 스스로 들여올 수 있었다. 이름으로 넘기면 순서에 기대지 않는다.
    #[test]
    #[ignore = "부모(the_dialog_labels_follow_ui_lang)가 격리 홈과 함께 직접 띄운다"]
    fn child_prints_the_dialog_labels() {
        if std::env::var(CHILD_ENV).is_err() {
            return;
        }
        let l = labels();
        // 탭도 `=`도 이 문구 넷에 안 들어간다 — 구분자로 안전하다.
        println!(
            "{MARK}title={}\tfilter_all={}\tfilter_images={}\tfilter_docs={}",
            l.title, l.filter_all, l.filter_images, l.filter_docs
        );
    }

    /// `ui.lang` 하나만 든 격리 홈에서 자식을 돌리고 `필드=문구` 넷을 받아 온다.
    /// `lang`이 `None`이면 `ui-prefs.json`을 아예 안 놓는다(= 갓 설치한 홈).
    fn labels_under(tag: &str, lang: Option<&str>) -> Vec<(String, String)> {
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
        line.split('\t')
            .map(|kv| {
                let (k, v) = kv.split_once('=').unwrap_or_else(|| panic!("이름표가 없다 ({tag}): {kv}"));
                (k.to_string(), v.to_string())
            })
            .collect()
    }

    /// `필드=문구` 넷을 소스 순서와 무관하게 비교하기 위한 기대값.
    fn expected(words: [&str; 4]) -> Vec<(String, String)> {
        ["title", "filter_all", "filter_images", "filter_docs"]
            .iter()
            .zip(words)
            .map(|(f, w)| (f.to_string(), w.to_string()))
            .collect()
    }

    /// 못 — `ui.lang=en`이면 네 문구 전부 영어, 기본/`ko`면 전부 한국어.
    ///
    /// `decisions-3.0.md` §3.4-B가 잡은 회귀가 여기다: 초판은 리터럴을 그대로 박아
    /// **어느 언어에서도 한국어**였다. 이 못이 부러지면 그 회귀가 돌아온 것이다.
    ///
    /// ★R3: 비교가 **필드 이름 기준**이라 자리 뒤바꿈도 여기서 걸린다
    /// (예: `title`에 「첨부 가능한 파일」이 오면 첫 쌍부터 어긋난다).
    #[test]
    fn the_dialog_labels_follow_ui_lang() {
        let ko = expected(["첨부할 파일 선택", "첨부 가능한 파일", "이미지", "텍스트·문서"]);
        let en = expected(["Choose files to attach", "Attachable files", "Images", "Text & documents"]);

        assert_eq!(labels_under("en", Some("en")), en, "★ui.lang=en인데 영어가 아니다");
        assert_eq!(labels_under("ko", Some("ko")), ko, "ui.lang=ko가 한국어가 아니다");
        // 무변 확인 — 언어를 한 번도 안 고른 홈은 예전과 같이 한국어다.
        assert_eq!(labels_under("default", None), ko, "기본(설정 없음)이 한국어가 아니다");
    }

    // ── ★SMALL3 R2 — **호출부까지** 문다 (확인 크리틱 R1의 D2) ──────────────
    //
    // R1의 못은 위 하나뿐이었고 `labels()`만 쟀다. 크리틱의 M2 돌연변이가 그 사정거리를
    // 뚫었다 — `labels()`를 **온전히 둔 채** 빌더만 한국어 리터럴로 되돌리면
    // (`let [_t, _a, _i, _x] = labels();`로 미사용 경고까지 피하면서) §3.4-B의 회귀가
    // 제품에 그대로 살아 있는데 `cargo test`는 **초록**이었다. 그 자리를 여기서 막는다.
    //
    // **왜 타입이 아니라 소스 대조인가.** `set_title`/`add_filter`는 `impl Into<String>`을
    // 받는다 — 문자열 리터럴이 언제나 들어맞으므로 배선을 타입으로는 못 막는다.
    // 소스를 읽는 못은 이 크레이트의 선례이기도 하다(바로 위
    // `the_filters_mirror_the_frozen_shared_list`가 동결 목록을 소스로 읽어 대조한다).
    //
    // ★M2가 가르쳐 준 것: "`labels()`를 부르는가"만 보면 **안 된다**(M2도 부른다).
    // 봐야 하는 것은 **빌더가 그 반환값 말고는 아무 말도 못 하게 돼 있는가**이다.

    /// 이 파일의 **제품 구역** 소스 — `#[cfg(test)]` 앞까지에서 주석 줄을 걷은 것.
    /// (주석과 테스트에는 한국어 문구가 정당하게 들어 있다 — 그 둘을 세면 안 된다.)
    fn production_source() -> String {
        let src = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/ipc/parity/dialog.rs"),
        )
        .expect("자기 소스를 못 읽었다");
        let head = &src[..src.find("#[cfg(test)]").expect("tests 경계를 못 찾았다")];
        head.lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// `labels()` 본문(`fn labels()` ~ 0열 `}`)을 잘라 준다.
    fn labels_body(prod: &str) -> (usize, usize) {
        let start = prod.find("fn labels()").expect("labels()가 사라졌다");
        let end = prod[start..].find("\n}").expect("labels()가 안 닫혔다") + start;
        (start, end)
    }

    /// 못 — **빌더는 `labels()`가 준 값 말고는 아무 말도 못 한다.**
    ///
    /// 크리틱 M2를 붉게 만드는 자리다. 셋을 같이 본다:
    ///   1. 호출부가 `labels()`를 부른다(있어야 할 최소).
    ///   2. 빌더 구간(`app.dialog()` ~ `.pick_files(`)에 **문자열 리터럴이 0개**다.
    ///      변수 이름에 기대지 않는 검사라 이름을 바꾸는 리팩터에는 안 걸리고,
    ///      한국어든 영어든 **리터럴을 되박는 순간** 걸린다.
    ///   3. 한국어 문구 넷이 `labels()` **밖**에는 단 한 번도 안 나온다.
    ///      문구의 출처가 하나임을 강제한다 — 2가 놓치는 우회로(예: 빌더 밖에서
    ///      `let title = "첨부할 파일 선택";`)까지 덮는다.
    #[test]
    fn the_builder_can_only_say_what_labels_gave_it() {
        let prod = production_source();

        let call_at = prod.find("pub fn pick_attachments").expect("호출부가 사라졌다");
        let call = &prod[call_at..];
        let b_at = call.find("app.dialog()").expect("빌더가 사라졌다");
        let b_end = call.find(".pick_files(").expect("pick_files가 사라졌다");
        assert!(b_at < b_end, "빌더 구간이 뒤집혔다");

        // 1 — 호출부가 labels()를 먹는다.
        assert!(
            call[..b_at].contains("labels()"),
            "★호출부가 labels()를 안 부른다 — 문구가 다른 데서 온다"
        );

        // 2 — 빌더 구간에 리터럴 0.
        let builder = &call[b_at..b_end];
        assert!(
            !builder.contains('"'),
            "★빌더 구간에 문자열 리터럴이 있다(= t()를 우회했다). 크리틱 M2가 이 자리다:\n{builder}"
        );

        // 2' — ★R3: **값이 제 짝에 갔는가.** 크리틱 R2의 EPAIR이 이 자리다.
        //
        // 구조체로 바꾼 것만으로 「구조분해 순서 뒤바꿈」은 표현 불가능해졌지만,
        // 필드를 **명시적으로 잘못 지목하는 것**(`.set_title(l.filter_all)`)은 여전히
        // 쓸 수 있다. 이제는 이름이 눈에 보이므로 조용하지는 않은데, 조용하지 않은 것과
        // 잡히는 것은 다르다 — 그래서 짝을 글자로 고정한다.
        //
        // 덤으로 크리틱의 E3·E6(빌더 밖 `const`에 이스케이프·`concat!`로 한국어를 숨기고
        // `.set_title(SNEAK)`)도 여기서 죽는다. 빌더가 쓸 수 있는 표현이 **이 넷뿐**이라
        // 다른 무엇을 넣든 짝이 어긋난다. (필드 이름을 바꾸는 리팩터는 이 못을 붉힌다.
        // 의도한 값이다 — 짝을 옮기는 변경은 사람이 한 번 봐야 한다.)
        for pair in [
            ".set_title(l.title)",
            ".add_filter(l.filter_all, &all)",
            ".add_filter(l.filter_images, &IMAGE)",
            ".add_filter(l.filter_docs, &TEXT)",
        ] {
            assert!(
                builder.contains(pair),
                "★빌더가 `{pair}`를 안 쓴다 — 값이 제 짝에 안 갔다(크리틱 EPAIR):\n{builder}"
            );
        }

        // 3 — 한국어 문구는 labels() 안에만 산다.
        let (l_at, l_end) = labels_body(&prod);
        let outside = format!("{}{}", &prod[..l_at], &prod[l_end..]);
        for ko in ["첨부할 파일 선택", "첨부 가능한 파일", "이미지", "텍스트·문서"] {
            assert!(
                !outside.contains(ko),
                "★한국어 문구 `{ko}`가 labels() 밖에 있다 — 문구의 출처가 둘이 됐다"
            );
        }
    }

    /// 못 — `labels()`의 (ko, en) 넷이 **2.6.2 원문 그대로**인가.
    ///
    /// 런타임 못(`the_dialog_labels_follow_ui_lang`)은 en 기대값을 자기 안에 적어 두므로,
    /// 누가 en 문구와 그 기대값을 **같이** 바꾸면 조용히 통과한다. 여기서는 기대값을
    /// 동결 구역(`src/main/index.ts`)에서 읽어 온다 — 우리 쪽만 고쳐서는 못 넘는다.
    /// (크리틱 M3 = `Text & documents` → `Text and documents` 표류가 이 자리다.)
    ///
    /// ★R3: 대조가 **필드 이름 기준**이다(R2까지는 소스 등장 순서였다). 구조체 리터럴은
    /// 필드로 짝지으므로 **초기화 줄의 순서를 바꿔도 제품은 멀쩡한데**, 순서로 대조하면
    /// 그 무해한 변경이 못을 붉힌다(거짓 양성). 이름으로 대조하면 잡을 것만 잡는다 —
    /// 예컨대 `title:`에 「이미지」를 넣는 **진짜** 어긋남은 그대로 걸린다.
    #[test]
    fn the_labels_still_mirror_the_frozen_262_wording() {
        let prod = production_source();
        let (l_at, l_end) = labels_body(&prod);
        // 3.0 — `필드: ccg_fs::t("ko", "en")` 넷을 **이름과 함께** 뽑는다.
        let ours: Vec<(String, (String, String))> = prod[l_at..l_end]
            .lines()
            .filter_map(|line| {
                let (lhs, rhs) = line.split_once(": ccg_fs::t(")?;
                let q: Vec<&str> = rhs.split('"').collect();
                Some((lhs.trim().to_string(), (q[1].to_string(), q[3].to_string())))
            })
            .collect();

        // 2.6.2 — `pickAttachments` 핸들러 안의 `t('ko', 'en')` 넷.
        let ts = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/main/index.ts"),
        )
        .expect("동결된 2.6.2 원문을 못 읽었다");
        let from = ts.find("IPC.pickAttachments").expect("2.6.2 핸들러가 없다");
        let to = ts[from..].find("return r.canceled").expect("핸들러가 안 닫혔다") + from;
        let theirs: Vec<(String, String)> = ts[from..to]
            .split("t('")
            .skip(1)
            .map(|seg| {
                let q: Vec<&str> = seg.split('\'').collect();
                (q[0].to_string(), q[2].to_string())
            })
            .collect();

        assert_eq!(ours.len(), 4, "labels()의 t() 콜사이트가 넷이 아니다: {ours:?}");
        assert_eq!(theirs.len(), 4, "2.6.2 쪽이 넷이 아니다: {theirs:?}");

        // 필드 ↔ 2.6.2 자리의 대응표. **이 표가 규약이다** — 2.6.2는 순서만 갖고
        // (제목 · 전체 · 이미지 · 텍스트) 우리는 이름을 갖는다. 여기서 둘을 잇는다.
        for (i, field) in ["title", "filter_all", "filter_images", "filter_docs"].iter().enumerate() {
            let got = ours
                .iter()
                .find(|(k, _)| k == field)
                .unwrap_or_else(|| panic!("★`{field}` 필드가 labels()에 없다: {ours:?}"));
            assert_eq!(
                got.1, theirs[i],
                "★`{field}`의 문구가 2.6.2 {i}번째와 다르다(표류했거나 자리가 섞였다)"
            );
        }
    }
}
