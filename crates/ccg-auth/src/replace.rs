//! ★R28d(CASX) — `accounts.json`을 **열어 둔 핸들 그대로** 갈아끼운다.
//!
//! ## 왜 `ccg_store::stage_atomic` + `std::fs::rename`이 아닌가
//!
//! 이유는 원자성이 아니라 **속도**다. 정확히는 *되살리기 창*의 속도다.
//!
//! M11 R4의 CAS는 갈아끼운 직후 [`witness`]로 옛 inode를 들여다봐 이웃의 통짜 쓰기를
//! 묻었는지 본다. 묻었으면 그 자리에서 되살리는데, 그 되살리기가 끝날 때까지 **로그아웃한
//! 계정이 `credEnc`째 파일에 앉아 있다.** 이웃(2.6.2)은 자기 `writeFileSync`가 돌아오고
//! 1ms 뒤에 그 파일을 다시 읽는다 — 되살리기가 그 안에 못 들어오면 사용자는 지운 계정을
//! 다시 본다. R28d 실측으로 그 되살리기는 **1.7~7.6ms**였고, 원가는 이랬다:
//!
//! | 조각 | 실측 |
//! |---|---|
//! | 임시 파일 쓰기(`stage`) | 140~183µs |
//! | **증인 열기+읽기(`open`이 대부분)** | **350~394µs** |
//! | 갈아끼우기 | 292~373µs |
//! | 창 안의 `eprintln!` 한 줄 | 0.8~7.6ms(부하에 따라) |
//!
//! 가장 비싼 두 줄을 없앤다. 로그는 커밋 뒤로 뺐고(`claude.rs`의 `revived`), **증인은
//! 새로 열지 않는다** — [`Pending::replace`]가 갈아끼운 핸들을 그대로 돌려주고 그게 곧
//! 다음 목적지라서다. 그러려면 `rename`을 *핸들로* 쳐야 하고, 그게
//! `SetFileInformationByHandle`이다(std의 `fs::rename`은 경로만 받는다).
//!
//! ## ★ 하지 않는 약속 — "갈아끼우는 동안 파일이 안 사라진다"
//!
//! 처음엔 이 모듈이 그 약속을 한다고 적었다. **틀렸고, 그 자리에서 재서 지웠다.**
//! 부하가 걸린 판에서 옆 스레드의 `read_to_string`이 갈아끼우기 도중 ENOENT를
//! 수천 번 받는다 — 그리고 그건 **옛 길도 똑같다**. 네 판을 같은 부하에서 번갈아 18주행씩:
//!
//! | 판 | ENOENT를 본 주행 | 합계 |
//! |---|---|---|
//! | 옛 길(std rename) + 증인 | 5 / 18 | 180,997 |
//! | 옛 길, 증인 없음 | 3 / 18 | 10,353 |
//! | 새 길(POSIX 단일 호출) + 증인 | 5 / 18 | 12,161 |
//! | 새 길, 증인 없음 | 2 / 18 | 7,025 |
//!
//! 즉 **이 창은 우리가 고른 API의 성질이 아니라 이 OS에서 "이름 바꿔 덮기"의 성질**이다
//! (선존 · R28d가 만든 것이 아니다). 대가는 작지 않다: 그 창에 읽은 2.6.2는 "계정 0개"로
//! 읽고 그 위의 쓰기 한 번이 목록을 통째로 지운다. 동결 트리라 그쪽은 못 고치고,
//! **우리 쪽 읽기는 [`crate::claude`]의 `cas_edit`이 막는다**(「없다」를 곧이곧대로
//! 안 믿는다). 남은 격차는 보고서에 적었다.
//!
//! 갈아끼우기가 실패하면 옛 길로 물러선다 — 이 파일 하나 때문에 저장을 포기하는 쪽이
//! 레이스보다 나쁘다(flock 규약 3과 같은 정신).

use std::io;
use std::path::{Path, PathBuf};

/// 임시 파일에 앉힌 다음 본문. [`Pending::replace`]까지는 아무도 못 본다.
pub struct Pending {
    file: Option<std::fs::File>,
    tmp: PathBuf,
    done: bool,
}

impl Drop for Pending {
    fn drop(&mut self) {
        if !self.done {
            // 커밋 못 한 스테이징(CAS 재시도·에러 경로)이 홈에 눌러앉지 않게.
            self.file.take();
            let _ = std::fs::remove_file(&self.tmp);
        }
    }
}

/// `<dst>.tmp-<pid>` — 이름에 PID가 들어가야 두 프로세스가 서로의 임시 파일을 안 밟는다
/// (`ccg_store::stage_atomic`과 같은 규약).
fn tmp_path(dst: &Path) -> PathBuf {
    let mut s = dst.as_os_str().to_os_string();
    s.push(format!(".tmp-{}", std::process::id()));
    PathBuf::from(s)
}

/// 임시 파일에 본문을 다 쓴다(**임계 구역 밖에서** 해도 되는 무거운 절반).
///
/// 핸들을 열어 둔 채 돌려주는 것이 요점이다 — [`Pending::replace`]가 그 핸들로
/// 갈아끼우므로 닫고 다시 여는 왕복이 없다. 그래서 `DELETE` 접근권을 같이 딴다.
pub fn stage(dst: &Path, body: &str) -> io::Result<Pending> {
    use std::io::Write;
    if let Some(d) = dst.parent() {
        // `create_dir_all`은 있어도 syscall이라, 되살리기 창(µs를 다툰다)에서는 아깝다.
        if !d.is_dir() {
            std::fs::create_dir_all(d)?;
        }
    }
    let tmp = tmp_path(dst);
    let mut f = open_tmp(&tmp)?;
    f.write_all(body.as_bytes())?;
    Ok(Pending { file: Some(f), tmp, done: false })
}

#[cfg(windows)]
fn open_tmp(tmp: &Path) -> io::Result<std::fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    // 이름을 바꾸려면 핸들에 DELETE 접근권이 있어야 한다. `access_mode`는 read/write
    // 플래그에서 유도되는 접근권을 **덮으므로** 여기서 다 적는다(그래도 `write(true)`는
    // 남긴다 — std가 생성 방식을 그 플래그로 고른다).
    const DELETE: u32 = 0x0001_0000;
    const GENERIC_READ: u32 = 0x8000_0000;
    const GENERIC_WRITE: u32 = 0x4000_0000;
    const SYNCHRONIZE: u32 = 0x0010_0000;
    std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        // 읽기까지 따 두는 이유는 [`Pending::replace`]가 이 핸들을 **다음 증인으로**
        // 돌려주기 때문이다(이름이 바뀌면 이 핸들이 곧 목적지다 — 여는 값 350µs를 아낀다).
        .access_mode(GENERIC_READ | GENERIC_WRITE | DELETE | SYNCHRONIZE)
        .share_mode(SHARE_ALL)
        .open(tmp)
}

/// 공유 모드는 **전부 연다**(READ | WRITE | DELETE). 우리 핸들 때문에 이웃의 쓰기가
/// 실패하면 그건 그것대로 조용한 유실이다(`ccg_store::witness`와 같은 판단).
#[cfg(windows)]
const SHARE_ALL: u32 = 1 | 2 | 4;

/// 갈아끼우기 **직전에** 잡는 증인. `rename`은 디렉터리 항목만 바꾸므로 이 핸들은 커밋
/// 뒤에도 계속 **옛 inode**를 본다 — 묻힌 이웃의 쓰기를 파내는 유일한 통로다
/// (`ccg_store::witness`와 같은 규약. 여기 사본이 있는 이유는 [`Pending::replace`]가
/// 돌려주는 핸들과 **같은 타입**이어야 증인을 물려받을 수 있어서다).
pub fn witness(path: &Path) -> Option<std::fs::File> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        std::fs::OpenOptions::new().read(true).share_mode(SHARE_ALL).open(path).ok()
    }
    #[cfg(not(windows))]
    {
        std::fs::File::open(path).ok()
    }
}

/// 이 **inode**의 지금 내용(경로가 아니다).
pub fn read_witness(f: &mut std::fs::File) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    f.seek(SeekFrom::Start(0)).ok()?;
    let mut s = String::new();
    f.read_to_string(&mut s).ok()?;
    Some(s)
}

#[cfg(not(windows))]
fn open_tmp(tmp: &Path) -> io::Result<std::fs::File> {
    std::fs::File::create(tmp)
}

/// 폴백 경고는 **한 번만** 찍는다 — 이 자리는 배경 회전이 초당 수백 번 지나는 길이라
/// 매번 찍으면 로그가 그것만으로 찬다(실측: 24주행에 17,486줄).
#[cfg(windows)]
fn warn_once(posix: &windows::core::Error, plain: &windows::core::Error) {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        eprintln!("[auth] ★ 단일호출 갈아끼우기가 안 된다(POSIX={posix:?} / 옛클래스={plain:?}) — std rename으로 물러선다. 이웃과 겹치는 창이 다시 넓어진다");
    });
}

impl Pending {
    /// 보이게 만든다 — **커널 호출 한 번**. 실패하면 std의 `rename`으로 물러선다.
    ///
    /// 돌려주는 핸들은 **이제 목적지가 된 그 파일**이다(이름만 바뀌었다). 호출자는 이걸
    /// 다음 라운드의 [`witness`]로 그대로 쓴다 — 되살리기 창에서 350µs짜리 `open`을
    /// 한 번 덜 내는 것이 그 창의 절반이다(실측: stage 140µs · witness 350µs · replace 292µs).
    /// 물러선 경로에서는 핸들을 못 돌려준다(`None` → 호출자가 새로 연다).
    pub fn replace(mut self, dst: &Path) -> io::Result<Option<std::fs::File>> {
        let r = self.replace_inner(dst);
        if r.is_ok() {
            self.done = true;
        }
        r.map(|()| self.file.take())
    }

    #[cfg(windows)]
    fn replace_inner(&mut self, dst: &Path) -> io::Result<()> {
        use std::os::windows::ffi::OsStrExt;
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::Storage::FileSystem::{SetFileInformationByHandle, FileRenameInfo, FileRenameInfoEx};

        let Some(f) = self.file.as_ref() else { return Err(io::Error::other("스테이징 핸들이 없다")) };
        // FILE_RENAME_INFO (x64 레이아웃):
        //   [0..4)   union { BOOLEAN ReplaceIfExists; DWORD Flags }
        //   [4..8)   패딩(HANDLE 정렬)
        //   [8..16)  HANDLE RootDirectory                              ← 0 = FileName이 절대경로
        //   [16..20) DWORD  FileNameLength                             ← **바이트 수**, NUL 제외
        //   [20..)   WCHAR  FileName[]
        let wide: Vec<u16> = dst.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let name_bytes = (wide.len() - 1) * 2;
        let mut buf = vec![0u8; 20 + wide.len() * 2];
        buf[16..20].copy_from_slice(&(name_bytes as u32).to_le_bytes());
        for (i, w) in wide.iter().enumerate() {
            buf[20 + i * 2..22 + i * 2].copy_from_slice(&w.to_le_bytes());
        }
        let h = HANDLE(f.as_raw_handle() as _);

        // ★ **`FileRenameInfoEx` + POSIX 의미론이라야 한다.** 옛 `FileRenameInfo`(클래스 3)는
        //   "목적지가 열려 있으면 실패"가 계약이라, 우리가 증인 핸들을 든 채 부르면 전량
        //   `ERROR_ACCESS_DENIED`로 떨어진다(실측: 17,486회 전부 폴백). POSIX 의미론은
        //   열려 있는 목적지도 **그 자리에서 이름만 떼어** 갈아끼운다 — 떼어진 옛 inode는
        //   핸들을 든 우리가 계속 읽을 수 있고, 그게 파묻힌 쓰기를 파내는 근거다.
        //   (Win10 1709+ · NTFS. 안 되는 판에서는 아래 두 단계로 물러선다.)
        const FILE_RENAME_FLAG_REPLACE_IF_EXISTS: u32 = 0x0000_0001;
        const FILE_RENAME_FLAG_POSIX_SEMANTICS: u32 = 0x0000_0002;
        buf[0..4].copy_from_slice(&(FILE_RENAME_FLAG_REPLACE_IF_EXISTS | FILE_RENAME_FLAG_POSIX_SEMANTICS).to_le_bytes());
        // SAFETY: `buf`는 위 레이아웃대로 채운 살아 있는 바이트열이고 길이를 같이 넘긴다.
        let posix = unsafe { SetFileInformationByHandle(h, FileRenameInfoEx, buf.as_ptr().cast(), buf.len() as u32) };
        if posix.is_ok() {
            return Ok(()); // 핸들은 살려 둔다 — 호출자가 **다음 증인**으로 쓴다
        }
        // 물러서기 ① — 옛 클래스(목적지가 안 열려 있으면 이쪽도 단일 호출이다).
        buf[0..4].copy_from_slice(&1u32.to_le_bytes()); // ReplaceIfExists = TRUE
        let plain = unsafe { SetFileInformationByHandle(h, FileRenameInfo, buf.as_ptr().cast(), buf.len() as u32) };
        if plain.is_ok() {
            return Ok(());
        }
        // 물러서기 ② — 옛 길. 창이 다시 열리지만 유실은 아니다(flock 규약 3과 같은 정신).
        warn_once(&posix.unwrap_err(), &plain.unwrap_err());
        self.file.take();
        std::fs::rename(&self.tmp, dst)
    }

    #[cfg(not(windows))]
    fn replace_inner(&mut self, dst: &Path) -> io::Result<()> {
        self.file.take();
        std::fs::rename(&self.tmp, dst)
    }
}

#[cfg(test)]
mod tests {
    /// 갈아끼우기가 **읽는 쪽에 무엇을 보이나** — 이 모듈이 무엇을 약속하고 무엇을
    /// 약속하지 않는지가 여기서 갈린다.
    ///
    /// - **약속한다**: 반쪽(torn) 0 · 마지막 내용은 우리가 쓴 것 · 임시 파일 잔여물 0.
    /// - **약속 못 한다**: ENOENT 0. 부하가 걸리면 옛 길도 새 길도 그 창을 연다
    ///   (모듈 주석의 4판 A/B). 그래서 **세지만 단정하지 않는다** — 단정하면 게이트가
    ///   우리가 못 고치는 OS 성질에 다섯에 한 번 빨개진다. 숫자는 남긴다.
    ///
    /// `CASX_OLD_SWAP=1` / `CASX_NO_WITNESS=1`로 대조군 세 판을 같은 하네스로 돌 수 있다.
    #[test]
    fn the_swap_shows_only_whole_files_to_a_reader() {
        let home = ccg_store::testhome::take("casx-replace");
        let dst = ccg_store::app_home().join("swap.json");
        std::fs::write(&dst, "{\"v\":0}").unwrap();

        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let s2 = stop.clone();
        let d2 = dst.clone();
        let reader = std::thread::spawn(move || {
            let (mut n, mut enoent, mut torn) = (0u64, 0u64, 0u64);
            while !s2.load(std::sync::atomic::Ordering::Relaxed) {
                n += 1;
                match std::fs::read_to_string(&d2) {
                    Ok(s) => {
                        if serde_json::from_str::<serde_json::Value>(&s).is_err() {
                            torn += 1;
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => enoent += 1,
                    Err(_) => {}
                }
            }
            (n, enoent, torn)
        });

        // `CASX_OLD_SWAP=1`이면 **옛 길**(std `rename`)로 같은 하네스를 돈다 — 이 못이
        // 재는 것이 "새 길이 옛 길보다 나은가"라서, 대조군을 같은 파일에 둔다.
        let old = std::env::var("CASX_OLD_SWAP").is_ok_and(|v| v == "1");
        let no_wit = std::env::var("CASX_NO_WITNESS").is_ok_and(|v| v == "1");
        let body = format!("{{\"v\":1,\"pad\":\"{}\"}}", "x".repeat(900));
        for _ in 0..3000 {
            // 제품과 같은 모양 — 목적지를 **연 채로**(증인) 갈아끼운다.
            let mut w = if no_wit { None } else { super::witness(&dst) };
            if old {
                let p = ccg_store::stage_atomic(&dst, &body).unwrap();
                let _ = w.as_mut().map(super::read_witness);
                p.commit().unwrap();
            } else {
                let p = super::stage(&dst, &body).unwrap();
                let _ = w.as_mut().map(super::read_witness);
                p.replace(&dst).unwrap();
            }
        }
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        let (n, enoent, torn) = reader.join().unwrap();
        println!("[casx-replace] 갈아끼우기 3000회 · 읽기 {n}회 → ENOENT {enoent} · 반쪽 {torn}");
        assert_eq!(std::fs::read_to_string(&dst).unwrap(), body, "마지막 내용");
        assert!(!super::tmp_path(&dst).exists(), "임시 파일이 남았다");
        let _ = std::fs::remove_dir_all(&home);
        assert_eq!(torn, 0, "★ 갈아끼우는 동안 반쪽이 읽혔다");
    }
}
