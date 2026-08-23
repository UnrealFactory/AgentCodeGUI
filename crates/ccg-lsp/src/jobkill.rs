//! **앱이 죽으면 언어 서버도 죽는다** — Windows 잡 오브젝트(KILL_ON_JOB_CLOSE).
//!
//! 왜 종료 훅이 아니라 잡인가:
//!  - `node.exe`는 부모가 죽어도 **살아남는다**(Windows에는 프로세스 그룹 종료가 없다).
//!    그 아래 `tsserver`는 손자라 `child.kill()`로는 닿지도 않는다.
//!  - 2.6.2는 앱 종료 훅에서 `taskkill /T /F`를 돌렸다 — **정상 종료 경로에서만** 동작한다.
//!    렌더러 크래시로 앱이 내려가거나 작업 관리자로 강제 종료되면 서버 세트(node+tsserver,
//!    수백 MB)가 그대로 남는다.
//!  - 잡에 넣어 두면 **마지막 핸들이 닫히는 순간**(=우리 프로세스가 어떤 식으로든 사라지는
//!    순간) OS가 잡 안의 프로세스를 전부 종료한다. 훅도, 협조도 필요 없다.
//!
//! 잡 핸들은 일부러 **끝까지 안 닫는다**(프로세스 수명 = 잡 수명).

#[cfg(windows)]
mod imp {
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    struct Job(HANDLE);
    // HANDLE은 그냥 포인터라 Send/Sync가 아니지만, 우리는 값을 읽어 Win32에 넘기기만 한다.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    static JOB: OnceLock<Option<Job>> = OnceLock::new();

    fn job() -> Option<HANDLE> {
        JOB.get_or_init(|| unsafe {
            let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if h.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                h,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                CloseHandle(h);
                return None;
            }
            Some(Job(h))
        })
        .as_ref()
        .map(|j| j.0)
    }

    /// 스폰 직후의 자식을 잡에 넣는다. 실패해도 조용히 넘어간다 — 회수 경로(유휴 스윕·
    /// `dispose_all`)가 여전히 있고, 잡은 **크래시 경로의 안전망**이지 유일한 수단이 아니다.
    pub fn adopt(pid: u32) -> bool {
        let Some(j) = job() else { return false };
        unsafe {
            let h = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if h.is_null() {
                return false;
            }
            let ok = AssignProcessToJobObject(j, h) != 0;
            CloseHandle(h);
            ok
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn adopt(_pid: u32) -> bool {
        false
    }
}

pub use imp::adopt;
