//! Windows job object — `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
//!
//! **왜 크레이트 최초 커밋에 있는가**: Electron이 주던 job 보호가 Tauri엔 없다.
//! `docs/critic/m3-poc.md` §4가 4행 대조로 실증했다 —
//! job 없이 **턴 중** 앱이 죽으면 337MB `claude.exe`와 손자(bash/dotnet/dev 서버)가 **100% 잔존**한다.
//! (유휴에서 claude.exe가 죽는 건 job 덕이 아니라 stdin EOF로 스스로 정리 종료하는 우연이다.)
//!
//! 규약 둘:
//! 1. job 핸들은 **앱 전역에 하나**. 모든 CLI 자식을 여기 넣는다.
//! 2. 편입은 **spawn 직후, 첫 write 전에**. 그 사이에 자식이 손자를 만들면 놓친다.

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// 살아 있는 동안 자식들을 묶어 두는 job. 마지막 핸들이 닫히면(= 앱 프로세스 소멸)
    /// 커널이 job 안의 전 프로세스를 종료한다.
    pub struct Job(*mut c_void);

    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn create() -> std::io::Result<Job> {
            unsafe {
                let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if h.is_null() {
                    return Err(std::io::Error::last_os_error());
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    h,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ) == 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(Job(h))
            }
        }

        /// spawn 직후, 첫 write 전에 부른다.
        pub fn assign_raw(&self, process_handle: *mut c_void) -> std::io::Result<()> {
            unsafe {
                if AssignProcessToJobObject(self.0, process_handle) == 0 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            Ok(())
        }
    }
}

#[cfg(windows)]
pub use imp::Job;

#[cfg(not(windows))]
pub struct Job;

#[cfg(not(windows))]
impl Job {
    pub fn create() -> std::io::Result<Job> {
        Ok(Job)
    }
    pub fn assign_raw(&self, _h: *mut std::ffi::c_void) -> std::io::Result<()> {
        Ok(())
    }
}
