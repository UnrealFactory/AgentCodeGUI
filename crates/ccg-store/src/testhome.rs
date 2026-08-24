//! ★M11 R4 — **`CCG_HOME`은 프로세스 전역이다.** 그 값을 만지는 테스트는 예외 없이
//! 여기를 지난다. 자물쇠가 [`app_home`](crate::app_home) 옆에 있는 이유가 그것이다 —
//! 보호 대상과 자물쇠가 다른 크레이트에 있으면 새 크레이트가 생길 때마다 사본이 는다.
//!
//! ## 무엇이 flaky였나 (실측 이력)
//!
//! - M11 R3 확인 크리틱 F5: `src-tauri`의 `acct_switch::tests`는 모듈 안 뮤텍스로
//!   직렬화했는데 `codex_versions::tests`가 그 자물쇠를 안 잡고 `set_var`/`remove_var`를
//!   했다. `remove_var` 창에서 [`app_home`](crate::app_home)이 **사용자 실홈**으로 떨어져
//!   그 순간의 쓰기가 실데이터를 향한다. 헤드라인 테스트가 1/15로 붉었다.
//! - M11 R4: `ccg-auth`의 통합 테스트 4벌이 각자 `set_var("CCG_HOME", …)`을 했다.
//!   한 바이너리 안에서 병렬로 도니 서로의 홈을 갈아끼워 **직렬 실행에서는 14/14 초록인
//!   테스트가 배치 실행에서 5개 붉게** 나왔다(리드 실측). 게이트가 실행 방식에 따라
//!   답이 갈리면 게이트가 아니다.
//!
//! ## 규약
//!
//! - 홈을 세우거나 지우는 테스트는 [`take`]로 증표를 받는다. 증표가 사는 동안 다른
//!   테스트는 [`take`] 안에서 줄을 선다.
//! - 증표를 놓으면 홈은 **원래 값으로 되돌아간다**(없었으면 지운다). `remove_var`를
//!   손으로 부르지 않는다 — 그게 실홈으로 떨어지는 창을 만든 원인이다.
//! - 증표는 `Path`처럼 쓸 수 있다(`Deref`·`AsRef<Path>`·`AsRef<OsStr>`). 옛 헬퍼가
//!   `PathBuf`를 돌려주던 자리를 **호출부 수정 없이** 넘겨받기 위한 것이다.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

fn lock() -> &'static Mutex<()> {
    static L: OnceLock<Mutex<()>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(()))
}

/// 격리 홈 증표. 살아 있는 동안 이 프로세스의 `CCG_HOME`은 [`TestHome::dir`]이다.
pub struct TestHome {
    pub dir: PathBuf,
    prev: Option<std::ffi::OsString>,
    _guard: MutexGuard<'static, ()>,
}

impl Drop for TestHome {
    fn drop(&mut self) {
        match self.prev.take() {
            Some(v) => std::env::set_var("CCG_HOME", v),
            None => std::env::remove_var("CCG_HOME"),
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl std::ops::Deref for TestHome {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.dir
    }
}
impl AsRef<Path> for TestHome {
    fn as_ref(&self) -> &Path {
        &self.dir
    }
}
impl AsRef<OsStr> for TestHome {
    fn as_ref(&self) -> &OsStr {
        self.dir.as_os_str()
    }
}

/// 격리 홈 하나 + 전역 자물쇠. 태그는 폴더 이름에만 쓴다.
pub fn take(tag: &str) -> TestHome {
    // 자물쇠가 독이 됐어도 계속한다 — 여기서 패닉하면 남의 실패가 내 실패가 된다.
    let guard = lock().lock().unwrap_or_else(|e| e.into_inner());
    let n = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("ccg-test-{tag}-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::create_dir_all(&dir);
    let prev = std::env::var_os("CCG_HOME");
    std::env::set_var("CCG_HOME", &dir);
    TestHome { dir, prev, _guard: guard }
}

#[cfg(test)]
mod tests {
    /// 스레드 여럿이 홈을 갈아끼워도 **항상 자기 임시 홈**이다(F5의 모양).
    #[test]
    fn the_home_never_falls_back_to_the_real_one_while_tests_swap_it() {
        let real = std::env::var_os("USERPROFILE")
            .map(|p| std::path::PathBuf::from(p).join(".agentcodegui"))
            .unwrap_or_default();
        let hands: Vec<_> = (0..8)
            .map(|i| {
                let real = real.clone();
                std::thread::spawn(move || {
                    for _ in 0..25 {
                        let h = super::take(&format!("mutex-{i}"));
                        let seen = crate::app_home();
                        assert_eq!(seen, h.dir, "★ 남의 remove_var 창에서 홈이 바뀌었다");
                        assert_ne!(seen, real, "★ 실홈으로 떨어졌다 — 이 창의 쓰기는 사용자 데이터다");
                    }
                })
            })
            .collect();
        for t in hands {
            t.join().unwrap();
        }
    }
}
