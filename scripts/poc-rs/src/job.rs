//! Windows job object — JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
//!
//! docs/ARCHITECTURE-3.0.md "M3 위험 3": Electron이 주던 job 보호가 Tauri엔 없다.
//! 앱이 죽으면 337MB claude.exe + 손자(bash/dotnet/dev 서버)가 통째로 잔존한다.
//! job 핸들을 앱 전역에 하나 두고 모든 자식을 넣으면 "앱 프로세스 소멸 = 전 자식
//! 소멸"이 커널 보장으로 성립하는지 — 이 모듈이 그걸 실증한다.

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// 살아 있는 동안 자식들을 묶어 두는 job. 이 값이 drop 되거나 프로세스가
    /// 사라지면(= 마지막 핸들이 닫히면) 커널이 job 안의 전 프로세스를 종료한다.
    pub struct Job(pub *mut c_void);

    // 핸들은 스레드 간 이동 가능
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
                let ok = SetInformationJobObject(
                    h,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(Job(h))
            }
        }

        /// spawn 직후, 첫 write 전에 부른다.
        pub fn assign(&self, process_handle: *mut c_void) -> std::io::Result<()> {
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
    pub fn assign(&self, _h: *mut std::ffi::c_void) -> std::io::Result<()> {
        Ok(())
    }
}
