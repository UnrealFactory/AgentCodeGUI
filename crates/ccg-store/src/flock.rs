//! ★M11 R3 (F1) — **앱 홈 파일의 크로스-프로세스 잠금.**
//!
//! 왜 생겼나: `accounts.json`은 통짜 read-modify-write로 갱신된다(계정 목록·기본 계정·
//! `credEnc` 백업이 한 파일에 산다). M11 R2가 **사용자 조작과 무관한 배경 스레드**에서
//! 그 쓰기를 처음 만들었고, 같은 홈(`~/.agentcodegui`)을 쓰는 2.6.2 실앱이 옆에서 돌면
//! 한쪽 갱신이 사라진다 — R2 확인 크리틱 실측: 120판에 백업 클로버 1~6건,
//! **로그아웃한 계정이 credEnc째 되살아난 것 11건(9.2%)**.
//!
//! ## 두 겹
//!
//! | 겹 | 무엇 | 막는 것 |
//! |---|---|---|
//! | ① 프로세스 안 | 이름별 전역 뮤텍스 | 허브 스레드 vs 워커 스레드(3.0이 로그아웃을 이식하면 곧 실재한다) |
//! | ② 프로세스 밖 | 잠금 파일 + `LockFileEx`(배타·바이트 범위 전체) | 2.6.2 실앱 · 두 번째 3.0 인스턴스 · 하네스 자식 |
//!
//! ## 규약 셋
//!
//! 1. **잠그는 대상은 별도 `.lock` 파일**이다(데이터 파일 자체가 아니다). 원자 저장이
//!    `rename`이라 데이터 파일의 핸들은 쓰기 중에 바뀐다 — 그 위에 건 잠금은 의미가 없다.
//! 2. **잠금은 조언(advisory)이다.** 잠그지 않는 프로세스(=오늘의 2.6.2)는 그대로 쓴다.
//!    그 짝을 막는 것은 잠금이 아니라 `ccg-auth`의 **최신본 병합**이다(claude.rs 참고).
//! 3. **절대 영원히 안 막힌다.** 잠금을 못 잡아도 [`Lock`]은 값으로 돌아오고(획득 실패
//!    표식만 남는다), 호출자는 하던 일을 계속한다 — 잠금 하나 때문에 사용자의 저장이
//!    사라지는 쪽이 레이스보다 나쁘다.

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

/// 잠금을 기다리는 최대 시간. 이 시간을 넘기면 **없이 진행한다**(규약 3).
/// 실제 임계 구역은 파일 하나 읽고 쓰는 몇 ms라, 여기까지 오면 상대가 죽은 것이다.
pub const LOCK_WAIT: Duration = Duration::from_millis(4_000);
/// 재시도 간격 — `LOCKFILE_FAIL_IMMEDIATELY` 스핀의 쉬는 틈.
const RETRY_MS: u64 = 4;

/// 잠금 이름별 프로세스 내부 뮤텍스. 항목 수는 잠그는 파일 종류 수(= 1~2개)라 누수가 아니다.
fn in_process(name: &str) -> &'static Mutex<()> {
    static REG: OnceLock<Mutex<Vec<(String, &'static Mutex<()>)>>> = OnceLock::new();
    let reg = REG.get_or_init(|| Mutex::new(Vec::new()));
    let mut g = reg.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((_, m)) = g.iter().find(|(k, _)| k == name) {
        return m;
    }
    let m: &'static Mutex<()> = Box::leak(Box::new(Mutex::new(())));
    g.push((name.to_string(), m));
    m
}

/// 임계 구역 증표. 살아 있는 동안 같은 `rel`에 대한 다른 [`take`]는 (프로세스 안팎 모두)
/// 줄을 선다. `Drop`에서 푼다.
pub struct Lock {
    _proc: MutexGuard<'static, ()>,
    #[cfg(windows)]
    file: Option<std::fs::File>,
    /// 크로스-프로세스 잠금까지 잡았나. `false`면 프로세스 안 직렬화만 선 상태다
    /// (진단용 — 호출자는 어차피 계속 진행한다).
    cross: bool,
    path: PathBuf,
}

impl Lock {
    /// 파일 잠금까지 실제로 잡았나(진단·테스트).
    pub fn cross_process(&self) -> bool {
        self.cross
    }
    pub fn lock_path(&self) -> &std::path::Path {
        &self.path
    }
}

/// 앱 홈의 `<rel>`을 고치는 동안 잡는 잠금. 잠금 파일은 `<home>/<rel>.lock`이다.
///
/// **읽기에도 필요하다** — read-modify-write의 *read*가 임계 구역 밖이면 잠금은
/// 무의미하다(그게 R2가 뚫린 모양이다). 호출자는 read와 write를 같은 증표 아래 둔다.
pub fn take(rel: &str) -> Lock {
    let guard = in_process(rel).lock().unwrap_or_else(|e| e.into_inner());
    let home = crate::app_home();
    let _ = std::fs::create_dir_all(&home);
    let path = home.join(format!("{rel}.lock"));
    let (file, cross) = acquire(&path);
    Lock { _proc: guard, #[cfg(windows)] file, cross, path }
}

#[cfg(windows)]
fn acquire(path: &std::path::Path) -> (Option<std::fs::File>, bool) {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY};
    use windows::Win32::System::IO::OVERLAPPED;

    let Ok(f) = std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(path) else {
        return (None, false);
    };
    let h = HANDLE(f.as_raw_handle() as _);
    let started = Instant::now();
    loop {
        let mut ov = OVERLAPPED::default();
        // 파일 전체(0..u64::MAX)를 배타로 잡는다. 잠금 파일은 내용이 없으므로 범위는
        // 상징적이다 — 두 프로세스가 같은 범위를 겹치게 요청한다는 사실만 쓴다.
        let ok = unsafe {
            LockFileEx(h, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, None, u32::MAX, u32::MAX, &mut ov)
        };
        if ok.is_ok() {
            return (Some(f), true);
        }
        if started.elapsed() >= LOCK_WAIT {
            // 규약 3 — 잠금을 못 잡아도 진행한다. 상대가 죽은 채 핸들을 붙잡고 있을 수
            // 있고(커널이 거두지만 타이밍이 있다), 그때 앱이 저장을 포기하면 안 된다.
            eprintln!("[store] {path:?} 잠금 대기 초과 — 잠금 없이 진행한다");
            return (Some(f), false);
        }
        std::thread::sleep(Duration::from_millis(RETRY_MS));
    }
}

#[cfg(not(windows))]
fn acquire(path: &std::path::Path) -> (Option<std::fs::File>, bool) {
    // 이 앱은 Windows 전용이지만 크레이트는 다른 OS에서도 컴파일된다. 잠금 파일을
    // `create_new`로 만드는 고전 방식 — 오래된 잠금은 훔친다(주인이 죽은 것이다).
    let started = Instant::now();
    loop {
        match std::fs::OpenOptions::new().write(true).create_new(true).open(path) {
            Ok(_) => return (None, true),
            Err(_) => {
                let stale = std::fs::metadata(path)
                    .and_then(|m| m.modified())
                    .map(|t| t.elapsed().map(|d| d > LOCK_WAIT).unwrap_or(false))
                    .unwrap_or(false);
                if stale {
                    let _ = std::fs::remove_file(path);
                    continue;
                }
                if started.elapsed() >= LOCK_WAIT {
                    return (None, false);
                }
                std::thread::sleep(Duration::from_millis(RETRY_MS));
            }
        }
    }
}

impl Drop for Lock {
    fn drop(&mut self) {
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows::Win32::Foundation::HANDLE;
            use windows::Win32::Storage::FileSystem::UnlockFileEx;
            use windows::Win32::System::IO::OVERLAPPED;
            if self.cross {
                if let Some(f) = &self.file {
                    let mut ov = OVERLAPPED::default();
                    let _ = unsafe { UnlockFileEx(HANDLE(f.as_raw_handle() as _), None, u32::MAX, u32::MAX, &mut ov) };
                }
            }
            // 핸들은 여기서 닫힌다(닫으면 커널이 잠금도 확실히 거둔다).
        }
        #[cfg(not(windows))]
        if self.cross {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ★F1 — 두 스레드가 같은 이름을 잡으면 **겹치지 않는다**(프로세스 안 겹).
    #[test]
    fn two_threads_never_hold_the_same_name_at_once() {
        let h = crate::testkit::temp_home("flock");
        static LIVE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        static MAX: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        use std::sync::atomic::Ordering::SeqCst;
        LIVE.store(0, SeqCst);
        MAX.store(0, SeqCst);
        let hands: Vec<_> = (0..6)
            .map(|_| {
                std::thread::spawn(|| {
                    for _ in 0..20 {
                        let g = take("accounts.json");
                        let n = LIVE.fetch_add(1, SeqCst) + 1;
                        MAX.fetch_max(n, SeqCst);
                        std::thread::sleep(Duration::from_micros(50));
                        LIVE.fetch_sub(1, SeqCst);
                        drop(g);
                    }
                })
            })
            .collect();
        for t in hands {
            t.join().unwrap();
        }
        assert_eq!(MAX.load(SeqCst), 1, "★ 임계 구역에 둘이 동시에 들어갔다");
        drop(h);
    }

    /// 잠금 파일은 앱 홈 안에 생기고, 증표를 놓으면 다시 잡힌다(교착 없음).
    #[test]
    fn the_lock_file_lives_in_the_app_home_and_is_reusable() {
        let h = crate::testkit::temp_home("flock-path");
        {
            let g = take("accounts.json");
            assert_eq!(g.lock_path(), h.path("accounts.json.lock"));
            assert!(g.cross_process(), "윈도에서는 파일 잠금까지 잡혀야 한다");
        }
        let g2 = take("accounts.json");
        assert!(g2.cross_process(), "★ 앞 증표가 풀리지 않았다 — 다음 저장이 4초씩 밀린다");
        drop(g2);
        drop(h);
    }
}
