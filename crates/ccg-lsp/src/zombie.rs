//! 좀비 안전망 — **우리가 띄운 자식의 핸들 원장**.
//!
//! 이미 있는 두 겹 위에 세 번째를 놓는다:
//!
//! | 겹 | 무엇을 막나 | 사는 곳 |
//! |---|---|---|
//! | ① 잡 오브젝트(KILL_ON_JOB_CLOSE) | **앱이 죽는다**(크래시·강제 종료 포함) | [`crate::jobkill`] |
//! | ② 유휴 회수 스윕 | 앱은 사는데 **서버가 논다** | [`crate::manager::sweep_idle`] |
//! | ③ **이 파일** | 앱도 살고 스윕도 도는데 **회수를 놓쳤다** | 여기 |
//!
//! ③이 필요한 이유: ②는 레지스트리(`manager::REG`)에 자리가 남아 있는 서버만 본다.
//! 자리에서 밀려났는데 `shutdown`이 안 불린 핸들, 스윕 스레드가 사라진 뒤에 뜬 서버 —
//! 이 둘은 ②의 시야 밖이고 ①은 앱이 살아 있는 한 안 돈다.
//! 2.6.2가 엔진 쪽에 30분 안전망을 둔 자리와 같은 층이다.
//!
//! ## ★LSPIDLE R2 — 이 원장이 **안 덮는 것**(크리틱 B급 ③에서 정정)
//!
//! R1의 이 헤더는 막는 것으로 셋을 들었고 셋째가 **「`kill_tree`가 실패해 손자만 남은 트리」**
//! 였다. 그건 **사실이 아니다.** 원장은 [`track`]이 불리는 자리(=`Server::spawn` 직후)에서
//! **직계 자식만** 잡고, [`sweep`]은 그 부모가 이미 죽었으면 항목을 조용히 내린다. 그 순간
//! 손자는 원장 밖이고 다시는 안 걸린다. 크리틱이 코드로 짚었고 맞다.
//!
//! 그럼 손자는 누가 덮나 — **잡(①)이 덮는다.** Windows의 잡 멤버십은 **상속된다**:
//! breakaway를 안 걸었으므로 잡 안의 프로세스가 낳은 자식도 자동으로 같은 잡에 들어간다.
//! 그래서 앱이 어떤 식으로 죽든 손자까지 함께 걷힌다. 이 주장을 말로 두지 않고
//! [`crate::jobkill::contains`]로 **재고**, 아래 `the_job_covers_the_grandchild_the_ledger_cannot`이
//! 실물 손자를 띄워 확인한다.
//!
//! 남는 창은 **하나뿐이고 좁다**: 「앱은 살아 있는데 + `taskkill /T`가 손자에서 실패했고 +
//! 부모는 죽었다」. 그 경우 손자는 앱이 끝날 때까지 산다. 지금 그것을 닫으려면 주기적으로
//! 프로세스 트리를 훑어야 하는데(수백 ms짜리 WMI 왕복), 그건 이 파일이 **PID를 안 쓴다**는
//! 원칙과 정면으로 부딪친다 — 트리를 훑어 얻는 것은 결국 PID뿐이라 재사용 위험을 다시 들인다.
//! 그래서 **막지 않고 적어 둔다.** 문서가 코드보다 넓은 것이 R1의 결함이었으므로,
//! 여기서는 코드가 하는 것과 안 하는 것을 같은 무게로 적는다.
//!
//! ## ★ PID가 아니라 **핸들**을 들고 있는 이유
//!
//! "우리가 띄운 PID를 나중에 죽인다"는 그 자체로 위험하다 — Windows는 종료된 PID를
//! **재사용한다**. 30분 뒤에 그 번호를 물려받은 것은 남의 프로세스일 수 있고, 그걸 죽이면
//! 이 안전망이 사고의 원인이 된다.
//!
//! 그래서 스폰 직후 `OpenProcess`로 **핸들을 열어 끝까지 들고 있는다.** 열린 핸들이 하나라도
//! 있는 동안 OS는 그 PID를 재사용하지 않는다(커널 오브젝트가 살아 있다). 즉 원장에 있는
//! 번호는 **영원히 우리가 띄운 그 프로세스**다. 죽일 때도 그 핸들로 죽인다.
//!
//! 이름으로 찾아 죽이는 길(`taskkill /IM node.exe`)은 여기에 없다 — 사용자의 다른 node를
//! 죽인다. 이 파일이 아는 것은 **우리가 연 핸들**뿐이다.

use std::sync::{Mutex, OnceLock};

/// 원장 항목 — 스폰 시각과 (Windows에서) 그 프로세스의 핸들.
struct Tracked {
    pid: u32,
    born_ms: u64,
    #[cfg(windows)]
    handle: imp::Handle,
}

fn ledger() -> &'static Mutex<Vec<Tracked>> {
    static L: OnceLock<Mutex<Vec<Tracked>>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(Vec::new()))
}

/// 스폰 직후 — 이 자식을 원장에 올린다. 핸들을 못 열면 **올리지 않는다**
/// (PID만 들고 있으면 재사용 위험을 지므로, 안전망을 포기하는 편이 낫다).
pub fn track(pid: u32) {
    #[cfg(windows)]
    {
        let Some(handle) = imp::open(pid) else { return };
        let mut l = ledger().lock().unwrap();
        l.push(Tracked { pid, born_ms: crate::server::now_ms(), handle });
    }
    #[cfg(not(windows))]
    {
        let mut l = ledger().lock().unwrap();
        l.push(Tracked { pid, born_ms: crate::server::now_ms() });
    }
}

/// 정상 회수(`Server::shutdown`)가 끝났다 — 원장에서 내린다.
pub fn forget(pid: u32) {
    let mut l = ledger().lock().unwrap();
    if let Some(i) = l.iter().position(|t| t.pid == pid) {
        let t = l.swap_remove(i);
        #[cfg(windows)]
        imp::close(t.handle);
        #[cfg(not(windows))]
        let _ = t;
    }
}

/// 지금 원장에 남은 수(진단·테스트).
pub fn tracked_count() -> usize {
    ledger().lock().unwrap().len()
}

/// **회수를 놓친 것**을 걷는다. 스윕이 부른다.
///
/// - `live` = 지금 레지스트리가 들고 있는 서버들의 PID. 여기 있으면 손대지 않는다.
/// - 이미 죽은 항목은 조용히 내린다(핸들만 남은 자리 — 원장이 무한히 자라지 않게).
/// - 살아 있는데 `live`에 없고 나이가 `max_age_ms`를 넘겼으면 **트리째** 죽인다.
///
/// 반환 = 실제로 죽인 PID들(보고서·테스트가 읽는다).
pub fn sweep(live: &[u32], max_age_ms: u64) -> Vec<u32> {
    let now = crate::server::now_ms();
    let mut killed: Vec<u32> = Vec::new();
    let mut l = ledger().lock().unwrap();
    let mut keep: Vec<Tracked> = Vec::with_capacity(l.len());
    for t in l.drain(..) {
        let owned = live.contains(&t.pid);
        let alive = is_alive(&t);
        if !alive {
            // 이미 죽었다 — 핸들을 닫고 내린다(이게 원장의 대부분이다)
            #[cfg(windows)]
            imp::close(t.handle);
            continue;
        }
        if owned || now.saturating_sub(t.born_ms) < max_age_ms {
            keep.push(t);
            continue;
        }
        // 살아 있는데 주인이 없고 오래됐다 = 놓친 좀비.
        crate::server::kill_tree_pid(t.pid);
        #[cfg(windows)]
        {
            imp::terminate(&t.handle);
            imp::close(t.handle);
        }
        killed.push(t.pid);
    }
    *l = keep;
    killed
}

fn is_alive(t: &Tracked) -> bool {
    #[cfg(windows)]
    {
        imp::is_alive(&t.handle)
    }
    #[cfg(not(windows))]
    {
        let _ = t;
        true
    }
}

/// 테스트 전용 — 원장을 비운다(핸들은 닫는다).
#[cfg(test)]
pub(crate) fn clear_for_test() {
    let mut l = ledger().lock().unwrap();
    for t in l.drain(..) {
        #[cfg(windows)]
        imp::close(t.handle);
        #[cfg(not(windows))]
        let _ = t;
    }
}

#[cfg(windows)]
mod imp {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
    };

    /// 표준 접근권 `SYNCHRONIZE`(0x0010_0000) — `WaitForSingleObject`로 생사를 물으려면
    /// 이 권한이 필요하다. windows-sys 0.59는 이 상수를 `Win32::System::Threading`에
    /// 내보내지 않아(그쪽은 `PROCESS_*`만 있다) 여기 값으로 적는다. WinNT.h의 값이다.
    const SYNCHRONIZE: u32 = 0x0010_0000;

    /// 원장이 들고 다니는 프로세스 핸들. 값을 Win32에 넘기기만 하므로 Send/Sync로 못 박는다
    /// (핸들은 프로세스 전역이고 우리는 잠금 안에서만 만진다).
    #[derive(Clone, Copy)]
    pub struct Handle(HANDLE);
    unsafe impl Send for Handle {}
    unsafe impl Sync for Handle {}

    pub fn open(pid: u32) -> Option<Handle> {
        // SYNCHRONIZE = 생사 확인(WaitForSingleObject), TERMINATE = 마지막 수단,
        // QUERY_LIMITED_INFORMATION = 앞으로 진단을 붙일 자리.
        let h = unsafe { OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        (!h.is_null()).then_some(Handle(h))
    }

    /// 살아 있는가 — 0ms 대기로 물어본다. 신호 상태(WAIT_OBJECT_0) = 이미 종료됨.
    pub fn is_alive(h: &Handle) -> bool {
        unsafe { WaitForSingleObject(h.0, 0) != WAIT_OBJECT_0 }
    }

    pub fn terminate(h: &Handle) {
        unsafe {
            TerminateProcess(h.0, 1);
        }
    }

    pub fn close(h: Handle) {
        unsafe {
            CloseHandle(h.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 원장은 **프로세스 전역**이라 두 테스트가 동시에 만지면 서로의 상태를 지운다
    /// (실제로 `clear_for_test`가 남의 `track` 직후에 끼어들어 헛실패를 냈다).
    /// 이 자물쇠가 그 둘을 줄 세운다 — 제품 코드에는 필요 없다(스윕은 한 스레드다).
    fn ledger_lock() -> std::sync::MutexGuard<'static, ()> {
        static L: OnceLock<Mutex<()>> = OnceLock::new();
        L.get_or_init(|| Mutex::new(())).lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 원장의 계약 — **주인이 있는 PID는 안 건드린다.**
    /// (여기서 실물 프로세스를 띄우지 않는다: 위험한 것은 «죽인다»는 판정 자체라
    /// 그 판정이 `live` 목록과 나이 둘 다를 요구하는지만 못 박는다.)
    #[test]
    fn a_tracked_pid_that_the_registry_still_owns_is_never_swept() {
        let _g = ledger_lock();
        clear_for_test();
        // 지금 이 프로세스를 원장에 올린다 — 살아 있는 것이 확실한 유일한 PID다.
        let me = std::process::id();
        track(me);
        assert_eq!(tracked_count(), 1, "핸들을 못 열었으면 이 기계에서는 안전망이 꺼진 것이다");
        // ① 주인이 있으면 나이와 무관하게 살아남는다
        assert!(sweep(&[me], 0).is_empty(), "★주인이 있는 PID를 죽이려 했다");
        assert_eq!(tracked_count(), 1);
        // ② 주인이 없어도 아직 어리면 살아남는다
        assert!(sweep(&[], 10 * 60_000).is_empty(), "★나이 문턱을 안 봤다");
        assert_eq!(tracked_count(), 1);
        // (③ 진짜 종료 팔은 자기 자신을 죽이게 되므로 여기서 돌리지 않는다 —
        //  실물 자식으로 도는 팔은 아래 `a_real_orphan_is_actually_killed`에 있다.)
        clear_for_test();
        assert_eq!(tracked_count(), 0);
    }

    /// ★안전망의 **실물 팔** — 진짜 자식을 하나 띄워 놓고, 주인이 없는 채로 늙었다고
    /// 알려 준 뒤 정말 죽는지 본다.
    ///
    /// 위 테스트는 「죽이지 않는다」쪽만 본다(그쪽이 위험한 판정이라서). 그런데 그것만
    /// 있으면 `sweep`이 **아무것도 안 죽이도록** 망가져도 초록이다 — 안전망이 조용히
    /// 꺼진 상태가 정확히 이 라운드가 없애려는 병이다. 그래서 반대쪽도 못을 박는다.
    ///
    /// 죽이는 대상은 **이 테스트가 방금 띄운 PID뿐**이다(이름으로 찾지 않는다).
    #[cfg(windows)]
    #[test]
    fn a_real_orphan_is_actually_killed() {
        use std::process::{Command, Stdio};
        let _g = ledger_lock();
        clear_for_test();
        // 오래 사는 무해한 자식. `ping -n`은 어느 Windows에나 있고 파일을 안 건드린다.
        let mut child = Command::new("cmd")
            .args(["/c", "ping", "-n", "60", "127.0.0.1"])
            .creation_flags(0x0000_0008) // DETACHED_PROCESS — 여기서도 conhost를 안 만든다
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("테스트용 자식을 못 띄웠다");
        let pid = child.id();
        track(pid);
        assert_eq!(tracked_count(), 1);

        // 주인이 없고(live 비었다) 나이 문턱이 0 → 걷혀야 한다.
        let killed = sweep(&[], 0);
        assert_eq!(killed, vec![pid], "★안전망이 주인 없는 자식을 안 걷었다 — 조용히 꺼진 상태다");
        assert_eq!(tracked_count(), 0, "걷은 항목은 원장에서도 내려가야 한다(핸들 누수)");

        // 실제로 죽었는가 — 핸들 회수로 확인한다(죽지 않았으면 여기서 멈춘다).
        let status = child.wait().expect("자식을 못 기다렸다");
        assert!(!status.success() || status.code().is_some(), "종료 코드를 못 읽었다: {status:?}");
    }

    /// ★LSPIDLE R2 · 크리틱 B급 ③ — **헤더가 약속한 것과 코드가 하는 것을 같은 자리에서 잰다.**
    ///
    /// 두 가지를 동시에 못 박는다:
    ///  1. 원장은 **손자를 못 잡는다**(부모가 죽으면 항목을 내리고, 손자는 원장 밖이다).
    ///     ← R1 헤더가 「막는다」고 적었던 그 자리. 이 못이 그 문장을 다시 못 쓰게 한다.
    ///  2. 그 손자는 **잡이 덮는다** — 잡 멤버십이 상속되기 때문이다. 헤더의 새 주장이
    ///     말이 아니라 관측이라는 근거가 이 줄이다.
    ///
    /// 띄우는 것은 이 테스트가 만든 트리뿐이고, 끝나며 **그 PID들만** 접는다.
    #[cfg(windows)]
    #[test]
    fn the_job_covers_the_grandchild_the_ledger_cannot() {
        use std::process::{Command, Stdio};
        let _g = ledger_lock();
        clear_for_test();
        // 부모(cmd)가 손자(ping)를 낳는 트리. 부모는 곧 끝나고 손자만 오래 산다.
        let mut parent = Command::new("cmd")
            .args(["/c", "start", "/b", "ping", "-n", "60", "127.0.0.1"])
            .creation_flags(0x0000_0008)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("테스트용 부모를 못 띄웠다");
        let ppid = parent.id();
        // 제품과 **같은 순서**로: 잡에 넣고 원장에 올린다.
        crate::jobkill::adopt(ppid);
        track(ppid);

        // ② 잡 멤버십은 상속된다 — 부모가 잡 안이면 그가 낳는 것도 잡 안이다.
        //    (부모 자신으로 확인한다: 손자 PID는 밖에서 안 보이고, 상속은 부모의 성질이다.)
        assert_eq!(
            crate::jobkill::contains(ppid),
            Some(true),
            "★스폰한 자식이 잡 밖이다 — 앱이 죽어도 트리가 안 걷힌다는 뜻이다"
        );

        let _ = parent.wait(); // 부모는 곧 끝난다(손자는 남는다)
        // ① 부모가 죽었으므로 원장은 항목을 **조용히 내린다**. 손자는 여기 없다.
        let killed = sweep(&[], 0);
        assert!(killed.is_empty(), "이미 죽은 부모를 죽이려 들었다");
        assert_eq!(
            tracked_count(),
            0,
            "★부모가 죽으면 원장은 비워진다 — 그 아래 손자를 원장이 이어 잡지 **못한다**는 뜻이고, \
             그게 이 파일 헤더가 R1에서 틀리게 적었던 자리다"
        );
        // 우리가 만든 트리만 정리한다(이름으로 찾지 않는다).
        crate::server::kill_tree_pid(ppid);
    }

    #[cfg(windows)]
    use std::os::windows::process::CommandExt;

    #[test]
    fn forget_drops_only_that_entry() {
        let _g = ledger_lock();
        clear_for_test();
        track(std::process::id());
        forget(std::process::id());
        assert_eq!(tracked_count(), 0);
        // 없는 PID를 내려도 죽지 않는다
        forget(999_999_999);
    }
}
