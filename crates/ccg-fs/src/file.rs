//! 파일 읽기/쓰기 + 탐색기 파일 작업 — `src/main/index.ts`의 fs 핸들러 이식.
//!
//! ── 인코딩 규약(2.6.2와 같은 답을 내야 하는 자리) ──────────────────────────
//! 디스크는 **바이트**로 읽고, 앞 8000바이트에 NUL이 있으면 바이너리로 보고 미리보기를
//! 접는다. 아니면 UTF-8로 **손실 변환**한다(Node `Buffer.toString('utf8')` = 깨진
//! 시퀀스를 U+FFFD로 — Rust `String::from_utf8_lossy`가 같은 규칙). BOM은 벗기지
//! 않는다(2.6.2도 안 벗긴다 — 벗기면 저장 때 BOM이 사라져 파일이 조용히 바뀐다).
//! 상한 1.5MB를 넘으면 앞부분만 주고 `truncated:true` — 멀티바이트 문자가 잘리면
//! 마지막 글자가 U+FFFD가 되는 것까지 2.6.2와 같다.
//!
//! 쓰기는 원자 저장을 **안 한다**. 2.6.2가 그렇고(`fs.writeFile` 한 방), 여기서 임시
//! 파일+rename으로 바꾸면 편집 중인 파일의 inode/타임스탬프 취급이 달라져 외부 워처·
//! 빌드 도구가 다르게 반응한다. 줄바꿈(CRLF)은 렌더러(CmEditor)가 이미 복원해서 보낸다.

use serde::Serialize;
use std::path::Path;

/// 뷰어가 읽을 수 있는 최대 크기. 넘으면 앞 1.5MB만 준다(`truncated`).
const MAX_READ: u64 = 1536 * 1024;
/// 바이너리 판정에 들여다보는 머리 바이트 수.
const SNIFF: usize = 8000;

/// `protocol.ts FileReadResult`.
#[derive(Serialize, Debug)]
pub struct FileReadResult {
    pub path: String,
    pub content: Option<String>,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `protocol.ts FileWriteResult` / `GitResult`와 같은 `{ok, error?}` 모양.
#[derive(Serialize, Debug)]
pub struct OpResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl OpResult {
    pub fn ok() -> OpResult {
        OpResult { ok: true, error: None }
    }
    pub fn err(msg: String) -> OpResult {
        OpResult { ok: false, error: Some(msg) }
    }
}

fn looks_binary(buf: &[u8]) -> bool {
    buf.iter().take(SNIFF).any(|b| *b == 0)
}

/// 뷰어 카드용 텍스트 읽기. 상한을 걸어 거대 파일이 UI를 멈추지 못하게 하고,
/// 바이너리는 안내 문구로 돌려준다(쓰레기 글자 대신).
pub fn read_file(cwd: &str, rel: &str) -> FileReadResult {
    let abs = crate::resolve_rel(cwd, rel);
    let fail = |msg: String| FileReadResult {
        path: rel.to_string(),
        content: None,
        truncated: false,
        error: Some(msg),
    };
    let Ok(meta) = std::fs::metadata(&abs) else {
        return fail(crate::t("파일을 열 수 없어요", "Could not open the file"));
    };
    if !meta.is_file() {
        return fail(crate::t("파일이 아니에요", "Not a file"));
    }
    let not_previewable =
        || crate::t("미리보기를 지원하지 않는 파일이에요", "This file type cannot be previewed");
    if meta.len() > MAX_READ {
        use std::io::Read;
        let Ok(mut f) = std::fs::File::open(&abs) else {
            return fail(crate::t("파일을 열 수 없어요", "Could not open the file"));
        };
        let mut buf = vec![0u8; MAX_READ as usize];
        let mut filled = 0usize;
        // read()는 요청보다 적게 줄 수 있다 — 2.6.2의 fd.read(buf, 0, MAX, 0)과 같은
        // 양을 확보하려면 채워질 때까지 돈다.
        while filled < buf.len() {
            match f.read(&mut buf[filled..]) {
                Ok(0) => break,
                Ok(n) => filled += n,
                Err(_) => return fail(crate::t("파일을 열 수 없어요", "Could not open the file")),
            }
        }
        buf.truncate(filled);
        if looks_binary(&buf) {
            return fail(not_previewable());
        }
        return FileReadResult {
            path: rel.to_string(),
            content: Some(String::from_utf8_lossy(&buf).into_owned()),
            truncated: true,
            error: None,
        };
    }
    let Ok(buf) = std::fs::read(&abs) else {
        return fail(crate::t("파일을 열 수 없어요", "Could not open the file"));
    };
    if looks_binary(&buf) {
        return fail(not_previewable());
    }
    FileReadResult {
        path: rel.to_string(),
        content: Some(String::from_utf8_lossy(&buf).into_owned()),
        truncated: false,
        error: None,
    }
}

/// 편집기(Ctrl+S)에서 온 전체 덮어쓰기. 경로 해석은 `read_file`과 같은 규칙이다.
pub fn write_file(cwd: &str, rel: &str, content: &str) -> OpResult {
    let abs = crate::resolve_rel(cwd, rel);
    match std::fs::write(&abs, content.as_bytes()) {
        Ok(()) => OpResult::ok(),
        Err(e) => OpResult::err(io_msg(&e, crate::t("파일을 저장할 수 없어요", "Could not save the file"))),
    }
}

fn io_msg(e: &std::io::Error, fallback: String) -> String {
    let s = e.to_string();
    if s.is_empty() { fallback } else { s }
}

// ── 탐색기 파일 작업 ────────────────────────────────────────────────────────

/// 자기 부모 폴더 안에서 이름만 바꾼다. 경로 구분자·중복 이름은 거절.
pub fn rename_path(cwd: &str, rel: &str, new_name: &str) -> OpResult {
    let abs = crate::resolve_rel(cwd, rel);
    let name = new_name.trim();
    if name.is_empty() || name.contains('/') || name.contains('\\') || name == "." || name == ".." {
        return OpResult::err(crate::t("올바른 이름이 아니에요", "That name is not valid"));
    }
    let Some(parent) = abs.parent() else {
        return OpResult::err(crate::t("올바른 이름이 아니에요", "That name is not valid"));
    };
    let dest = parent.join(name);
    if dest == abs {
        return OpResult::ok(); // 그대로
    }
    if dest.exists() {
        return OpResult::err(crate::t("같은 이름이 이미 있어요", "Something with that name already exists"));
    }
    match std::fs::rename(&abs, &dest) {
        Ok(()) => OpResult::ok(),
        Err(e) => OpResult::err(io_msg(&e, crate::t("이름을 바꿀 수 없어요", "Could not rename it"))),
    }
}

/// OS 휴지통으로 — `rm`이 아니라 복구 가능한 삭제(2.6.2 `shell.trashItem`).
pub fn delete_path(cwd: &str, rel: &str) -> OpResult {
    let abs = crate::resolve_rel(cwd, rel);
    if !abs.exists() {
        return OpResult::err(crate::t("삭제할 수 없어요", "Could not delete it"));
    }
    match trash(&abs) {
        Ok(()) => OpResult::ok(),
        Err(msg) => OpResult::err(msg),
    }
}

/// 드래그 앤 드롭 이동. 루트 안에 머물고, 폴더를 자기 안(또는 자손)으로는 못 옮기며,
/// 대상에 같은 이름이 있으면 덮어쓰지 않는다.
pub fn move_path(cwd: &str, src_rel: &str, dest_rel: &str) -> OpResult {
    let Ok(abs_cwd) = std::path::absolute(cwd) else {
        return OpResult::err(crate::t("경로가 프로젝트 밖이에요", "That path is outside the project"));
    };
    let root = crate::resolve_lexical(&abs_cwd, "");
    let src = crate::resolve_lexical(&root, src_rel);
    let dest = crate::resolve_lexical(&root, dest_rel);
    if !crate::inside(&root, &src) || !crate::inside(&root, &dest) {
        return OpResult::err(crate::t("경로가 프로젝트 밖이에요", "That path is outside the project"));
    }
    if src == dest {
        return OpResult::ok();
    }
    if dest.starts_with(&src) {
        return OpResult::err(crate::t("폴더를 자기 안으로 옮길 수 없어요", "A folder cannot be moved into itself"));
    }
    if dest.exists() {
        return OpResult::err(crate::t(
            "대상에 같은 이름이 이미 있어요",
            "Something with that name already exists at the destination",
        ));
    }
    match std::fs::rename(&src, &dest) {
        Ok(()) => OpResult::ok(),
        Err(e) => OpResult::err(io_msg(&e, crate::t("옮길 수 없어요", "Could not move it"))),
    }
}

/// 빈 파일 또는 폴더 만들기. 같은 이름이 있으면 실패.
pub fn create_path(cwd: &str, rel: &str, dir: bool) -> OpResult {
    let abs = crate::resolve_rel(cwd, rel);
    if abs.exists() {
        return OpResult::err(crate::t("같은 이름이 이미 있어요", "Something with that name already exists"));
    }
    let made = if dir {
        std::fs::create_dir_all(&abs)
    } else {
        let parent_ok = match abs.parent() {
            Some(p) => std::fs::create_dir_all(p),
            None => Ok(()),
        };
        parent_ok.and_then(|()| {
            // create_new = O_EXCL — 그 사이에 생겼으면 실패한다(2.6.2의 flag 'wx')
            std::fs::OpenOptions::new().write(true).create_new(true).open(&abs).map(|_| ())
        })
    };
    match made {
        Ok(()) => OpResult::ok(),
        Err(e) => OpResult::err(io_msg(&e, crate::t("만들 수 없어요", "Could not create it"))),
    }
}

// ── OS 셸 연동 ──────────────────────────────────────────────────────────────

/// 기본 앱으로 열기(`shell.openPath`).
pub fn open_path(cwd: &str, rel: &str) {
    let abs = crate::resolve_rel(cwd, rel);
    shell_open(&abs);
}

/// 파일 탐색기에서 그 항목을 **선택된 채로** 보여준다(`shell.showItemInFolder`).
pub fn reveal_path(cwd: &str, rel: &str) {
    let abs = crate::resolve_rel(cwd, rel);
    shell_reveal(&abs);
}

#[cfg(windows)]
fn wide(s: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    s.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn shell_open(abs: &Path) {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let file = wide(abs);
    let op: Vec<u16> = "open\0".encode_utf16().collect();
    unsafe {
        ShellExecuteW(
            None,
            PCWSTR(op.as_ptr()),
            PCWSTR(file.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        );
    }
}

/// `explorer.exe /select,"<abs>"` — SHOpenFolderAndSelectItems의 COM 왕복 없이 같은
/// 결과를 내는 표준 수단이다. `raw_arg`로 쉼표 뒤 인용까지 우리가 만든다(Rust의 기본
/// 인자 escape는 `/select,C:\a b\c`를 통째로 감싸 explorer가 경로를 못 알아본다).
#[cfg(windows)]
fn shell_reveal(abs: &Path) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = std::process::Command::new("explorer.exe")
        .raw_arg(format!("/select,\"{}\"", abs.display()))
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
}

/// Windows 휴지통 — `SHFileOperationW` + `FOF_ALLOWUNDO`. UI·확인창은 전부 끈다
/// (앱이 이미 자기 확인 카드를 띄웠고, 네이티브 대화상자는 창을 물어버린다).
#[cfg(windows)]
fn trash(abs: &Path) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::{
        SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FO_DELETE,
        SHFILEOPSTRUCTW,
    };
    // pFrom은 **이중 NUL 종료** 목록이다(목록 하나 = 경로 + NUL + NUL)
    let mut from: Vec<u16> = wide(abs);
    from.push(0);
    let flags = (FOF_ALLOWUNDO.0 | FOF_NOCONFIRMATION.0 | FOF_SILENT.0 | FOF_NOERRORUI.0) as u16;
    let mut op = SHFILEOPSTRUCTW {
        wFunc: FO_DELETE,
        pFrom: PCWSTR(from.as_ptr()),
        fFlags: flags,
        ..Default::default()
    };
    let rc = unsafe { SHFileOperationW(&mut op) };
    if rc == 0 && !op.fAnyOperationsAborted.as_bool() {
        Ok(())
    } else {
        Err(crate::t("파일을 휴지통으로 보내지 못했어요", "Could not move the file to the recycle bin"))
    }
}

#[cfg(not(windows))]
fn shell_open(_abs: &Path) {}
#[cfg(not(windows))]
fn shell_reveal(_abs: &Path) {}
/// 비-Windows에는 휴지통 대응물이 없다(이 앱은 Windows 전용). 지우지 않고 실패로 돌려
/// **조용한 데이터 삭제**를 만들지 않는다.
#[cfg(not(windows))]
fn trash(_abs: &Path) -> Result<(), String> {
    Err(crate::t("파일을 휴지통으로 보내지 못했어요", "Could not move the file to the recycle bin"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ccg-fs-file-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn reads_utf8_text_including_hangul() {
        let d = tmp("read");
        std::fs::write(d.join("a.txt"), "안녕\nworld\n").unwrap();
        let r = read_file(d.to_str().unwrap(), "a.txt");
        assert_eq!(r.content.as_deref(), Some("안녕\nworld\n"));
        assert!(!r.truncated && r.error.is_none());
        assert_eq!(r.path, "a.txt", "요청한 상대 경로를 그대로 되돌려준다");
    }

    #[test]
    fn absolute_paths_are_taken_as_is() {
        let d = tmp("abs");
        let p = d.join("t.log");
        std::fs::write(&p, "tail").unwrap();
        // 채팅의 bash 테일 미리보기가 cwd='' + 절대경로로 부른다(Chat.tsx:3012)
        let r = read_file("", p.to_str().unwrap());
        assert_eq!(r.content.as_deref(), Some("tail"));
    }

    #[test]
    fn binary_files_are_refused_not_garbled() {
        let d = tmp("bin");
        std::fs::write(d.join("x.bin"), [0x89, 0x50, 0x00, 0x01, 0x02]).unwrap();
        let r = read_file(d.to_str().unwrap(), "x.bin");
        assert!(r.content.is_none() && r.error.is_some());
    }

    #[test]
    fn a_null_after_the_sniff_window_is_not_treated_as_binary() {
        let d = tmp("sniff");
        let mut v = vec![b'a'; SNIFF + 10];
        v[SNIFF + 5] = 0;
        std::fs::write(d.join("late.txt"), &v).unwrap();
        assert!(read_file(d.to_str().unwrap(), "late.txt").content.is_some());
    }

    #[test]
    fn oversize_files_come_back_truncated_at_the_cap() {
        let d = tmp("big");
        let big = "x".repeat(MAX_READ as usize + 5000);
        std::fs::write(d.join("big.txt"), &big).unwrap();
        let r = read_file(d.to_str().unwrap(), "big.txt");
        assert!(r.truncated);
        assert_eq!(r.content.as_deref().map(str::len), Some(MAX_READ as usize));
    }

    #[test]
    fn missing_and_directory_targets_return_an_error_not_a_panic() {
        let d = tmp("miss");
        assert!(read_file(d.to_str().unwrap(), "nope.txt").error.is_some());
        assert!(read_file(d.to_str().unwrap(), ".").error.is_some());
    }

    #[test]
    fn write_then_read_roundtrips_and_keeps_crlf_the_editor_sent() {
        let d = tmp("write");
        assert!(write_file(d.to_str().unwrap(), "w.txt", "a\r\nb\r\n").ok);
        let raw = std::fs::read(d.join("w.txt")).unwrap();
        assert_eq!(raw, b"a\r\nb\r\n", "줄바꿈은 렌더러가 정한다 — 여기서 바꾸지 않는다");
    }

    #[test]
    fn rename_rejects_separators_and_duplicates() {
        let d = tmp("rename");
        std::fs::write(d.join("a.txt"), "x").unwrap();
        std::fs::write(d.join("b.txt"), "y").unwrap();
        let cwd = d.to_str().unwrap();
        assert!(!rename_path(cwd, "a.txt", "sub/c.txt").ok);
        assert!(!rename_path(cwd, "a.txt", "..").ok);
        assert!(!rename_path(cwd, "a.txt", "b.txt").ok, "덮어쓰기 금지");
        assert!(rename_path(cwd, "a.txt", "  c.txt  ").ok, "앞뒤 공백은 다듬는다");
        assert!(d.join("c.txt").is_file());
        assert!(rename_path(cwd, "c.txt", "c.txt").ok, "같은 이름 = no-op 성공");
    }

    #[test]
    fn create_makes_parents_for_files_and_refuses_duplicates() {
        let d = tmp("create");
        let cwd = d.to_str().unwrap();
        assert!(create_path(cwd, "deep/nested/new.txt", false).ok);
        assert!(d.join("deep/nested/new.txt").is_file());
        assert!(!create_path(cwd, "deep/nested/new.txt", false).ok);
        assert!(create_path(cwd, "folder", true).ok);
        assert!(d.join("folder").is_dir());
    }

    /// 읽기 전용 파일에 Ctrl+S — 크래시가 아니라 사유 있는 실패여야 한다(뷰어의 저장 실패 카드).
    #[test]
    fn writing_a_read_only_file_fails_with_a_reason() {
        let d = tmp("readonly");
        let p = d.join("ro.txt");
        std::fs::write(&p, "locked\n").unwrap();
        let mut perm = std::fs::metadata(&p).unwrap().permissions();
        perm.set_readonly(true);
        std::fs::set_permissions(&p, perm).unwrap();
        let r = write_file(d.to_str().unwrap(), "ro.txt", "new");
        assert!(!r.ok);
        assert!(r.error.is_some_and(|e| !e.is_empty()));
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "locked\n", "내용이 안 바뀌었다");
        let mut perm = std::fs::metadata(&p).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        perm.set_readonly(false);
        let _ = std::fs::set_permissions(&p, perm);
    }

    /// 상대 경로 자리에 **절대 경로**를 넣어 프로젝트 밖으로 나가려는 시도.
    /// `Path::join`은 절대 인자를 만나면 앞을 통째로 버리므로 루트 가드가 유일한 방어선이다.
    #[test]
    fn an_absolute_dest_cannot_smuggle_a_move_out_of_the_project() {
        let d = tmp("smuggle");
        let cwd = d.to_str().unwrap();
        std::fs::write(d.join("f.txt"), "x").unwrap();
        let outside = std::env::temp_dir().join("ccg-fs-should-not-exist.txt");
        let _ = std::fs::remove_file(&outside);
        let r = move_path(cwd, "f.txt", outside.to_str().unwrap());
        assert!(!r.ok, "절대 경로 대상은 거절해야 한다");
        assert!(!outside.exists());
        assert!(d.join("f.txt").is_file());
    }

    #[test]
    fn move_refuses_escapes_self_nesting_and_clobbering() {
        let d = tmp("move");
        let cwd = d.to_str().unwrap();
        std::fs::create_dir_all(d.join("src/inner")).unwrap();
        std::fs::write(d.join("src/f.txt"), "x").unwrap();
        std::fs::write(d.join("taken.txt"), "y").unwrap();
        assert!(!move_path(cwd, "src", "src/inner/src").ok, "자기 안으로 이동 금지");
        assert!(!move_path(cwd, "src/f.txt", "../out.txt").ok, "프로젝트 밖 금지");
        assert!(!move_path(cwd, "src/f.txt", "taken.txt").ok, "덮어쓰기 금지");
        assert!(move_path(cwd, "src/f.txt", "moved.txt").ok);
        assert!(d.join("moved.txt").is_file());
    }
}
