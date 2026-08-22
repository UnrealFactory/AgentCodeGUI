//! 디렉터리 정션(NTFS mount point) — 계정 폴더가 공유 원본(`~/.agentcodegui/shared`)을
//! 가리키는 유일한 수단이다.
//!
//! **주니어 함정(이 파일이 존재하는 이유):** "링크"라고 심볼릭 링크를 쓰면 안 된다.
//! `std::os::windows::fs::symlink_dir`(= `CreateSymbolicLinkW`)는 개발자 모드가 꺼진
//! 일반 사용자 계정에서 `ERROR_PRIVILEGE_NOT_HELD`로 실패한다. 그러면 `linkSharedState`가
//! 조용히 넘어가고 → CLI가 계정 폴더 안에 **진짜** `projects/`를 파고 → 세션 기록이
//! 계정별로 갈라져 **resume이 죽는다**(대화 맥락이 통째로 사라진 것처럼 보인다).
//! 2.6.2가 `fs.symlinkSync(target, path, 'junction')`을 쓴 이유가 이것이고(정션은 권한
//! 불필요), Rust std에는 대응물이 없어 여기서 `FSCTL_SET_REPARSE_POINT`를 직접 친다.
//!
//! 읽기/판정은 std로 충분하다: `symlink_metadata().file_type().is_symlink()`는 Windows에서
//! 심링크와 **마운트 포인트(정션)를 모두** true로 준다 — Node의 `lstat().isSymbolicLink()`와
//! 같은 판정이라 2.6.2가 만든 링크와 여기서 만든 링크를 구분 없이 다룰 수 있다.

use std::path::Path;

/// 정션 생성. 대상 폴더는 미리 있어야 하고(`ensure_shared_root`), `link`는 없어야 한다.
#[cfg(windows)]
pub fn create(link: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, GENERIC_WRITE};
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_NONE, OPEN_EXISTING,
    };
    use windows::Win32::System::IO::DeviceIoControl;

    const IO_REPARSE_TAG_MOUNT_POINT: u32 = 0xA000_0003;
    const FSCTL_SET_REPARSE_POINT: u32 = 0x0009_00A4;

    // 정션의 대상은 **절대 경로**여야 한다(상대 정션은 없다). `\??\` 네임스페이스 접두사는
    // mklink /J가 쓰는 것과 같은 모양이다.
    let target = std::fs::canonicalize(target)?;
    let target = target.to_string_lossy();
    // canonicalize가 붙이는 확장 길이 접두사(`\\?\`)를 벗긴다 — 남겨두면 탐색기·CLI가
    // 프린트 이름을 이상하게 보여준다.
    let print_name = target.strip_prefix(r"\\?\").unwrap_or(&target).to_string();
    let substitute = format!(r"\??\{print_name}");

    std::fs::create_dir(link)?;

    let subst: Vec<u16> = substitute.encode_utf16().collect();
    let print: Vec<u16> = print_name.encode_utf16().collect();
    let subst_len = (subst.len() * 2) as u16; // 바이트, NUL 제외
    let print_len = (print.len() * 2) as u16;

    // REPARSE_DATA_BUFFER(MountPointReparseBuffer):
    //   [0..4)  ReparseTag
    //   [4..6)  ReparseDataLength   = 8(경로 헤더) + subst+NUL + print+NUL
    //   [6..8)  Reserved
    //   [8..10) SubstituteNameOffset  [10..12) SubstituteNameLength
    //   [12..14) PrintNameOffset      [14..16) PrintNameLength
    //   [16..)  PathBuffer(subst, NUL, print, NUL)
    let data_len = 8u16 + subst_len + 2 + print_len + 2;
    let mut buf: Vec<u8> = Vec::with_capacity(8 + data_len as usize);
    buf.extend_from_slice(&IO_REPARSE_TAG_MOUNT_POINT.to_le_bytes());
    buf.extend_from_slice(&data_len.to_le_bytes());
    buf.extend_from_slice(&0u16.to_le_bytes()); // Reserved
    buf.extend_from_slice(&0u16.to_le_bytes()); // SubstituteNameOffset
    buf.extend_from_slice(&subst_len.to_le_bytes());
    buf.extend_from_slice(&(subst_len + 2).to_le_bytes()); // PrintNameOffset
    buf.extend_from_slice(&print_len.to_le_bytes());
    for u in subst.iter().chain(&[0u16]).chain(print.iter()).chain(&[0u16]) {
        buf.extend_from_slice(&u.to_le_bytes());
    }

    let wide: Vec<u16> = link.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let res = unsafe {
        let handle = CreateFileW(
            PCWSTR(wide.as_ptr()),
            GENERIC_WRITE.0,
            FILE_SHARE_NONE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            None,
        )
        .map_err(|e| std::io::Error::from_raw_os_error(e.code().0))?;
        let r = DeviceIoControl(
            handle,
            FSCTL_SET_REPARSE_POINT,
            Some(buf.as_ptr() as *const core::ffi::c_void),
            buf.len() as u32,
            None,
            0,
            None,
            None,
        );
        let _ = CloseHandle(handle);
        r
    };
    if let Err(e) = res {
        // 반쪽짜리(빈 폴더)를 남기지 않는다 — 남으면 다음 물질화가 "이미 있음"으로 보고
        // 넘어가 정션이 영영 안 생긴다(= resume이 조용히 죽는 경로).
        let _ = std::fs::remove_dir(link);
        return Err(std::io::Error::from_raw_os_error(e.code().0));
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn create(link: &Path, target: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

/// 링크인가(정션·심링크 공통). Node `lstatSync(p).isSymbolicLink()`와 같은 판정.
pub fn is_link(p: &Path) -> bool {
    std::fs::symlink_metadata(p).map(|m| m.file_type().is_symlink()).unwrap_or(false)
}

/// 링크가 가리키는 곳. std의 `read_link`는 마운트 포인트도 풀어 준다(`\??\` 제거 포함).
pub fn target_of(p: &Path) -> Option<std::path::PathBuf> {
    std::fs::read_link(p).ok()
}

/// 링크 끊기 — **원본은 절대 건드리지 않는다.** 디렉터리 정션은 `remove_dir`로 지운다
/// (`remove_dir_all`을 부르면 원본 내용까지 위험해질 수 있어 쓰지 않는다).
pub fn unlink(p: &Path) -> std::io::Result<()> {
    if !is_link(p) {
        return Ok(());
    }
    match std::fs::remove_dir(p) {
        Ok(()) => Ok(()),
        // 파일 심링크였다면 remove_file 쪽이 맞다
        Err(_) => std::fs::remove_file(p),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 정션이 ① 관리자 권한 없이 만들어지고 ② 링크로 판정되고 ③ 원본을 가리키고
    /// ④ 링크 너머로 쓴 파일이 원본에 보이고 ⑤ 끊어도 원본이 남는가.
    /// (④가 곧 "resume이 산다"의 기계적 정의다 — CLI가 projects/에 쓰면 shared에 쌓인다)
    #[test]
    fn junction_round_trips_without_elevation() {
        let h = crate::testkit::temp_home("junction");
        let target = h.path("shared/projects");
        std::fs::create_dir_all(&target).unwrap();
        let link = h.path("accounts/acc/projects");
        std::fs::create_dir_all(link.parent().unwrap()).unwrap();

        create(&link, &target).expect("정션 생성이 실패하면 resume 공유가 통째로 죽는다");
        assert!(is_link(&link), "정션은 lstat 기준 링크여야 한다(2.6.2 판정과 동일)");
        assert_eq!(
            target_of(&link).map(|p| p.to_string_lossy().trim_start_matches(r"\\?\").to_string()),
            std::fs::canonicalize(&target).ok().map(|p| p.to_string_lossy().trim_start_matches(r"\\?\").to_string())
        );

        std::fs::write(link.join("sess.jsonl"), "{}").unwrap();
        assert!(target.join("sess.jsonl").is_file(), "링크 너머 쓰기가 원본에 보여야 resume이 공유된다");

        unlink(&link).unwrap();
        assert!(!link.exists());
        assert!(target.join("sess.jsonl").is_file(), "링크를 끊어도 원본(세션 기록 전체)은 남아야 한다");
    }
}
