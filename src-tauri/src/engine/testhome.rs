//! ★M11 R3(F5) — **`CCG_HOME`은 프로세스 전역이다.** 이 크레이트의 테스트가 그 값을
//! 만질 때는 예외 없이 여기를 지난다.
//!
//! ## 무엇이 flaky였나
//!
//! R2의 `acct_switch::tests`는 자기 모듈 안 뮤텍스로 직렬화했는데,
//! `codex_versions::tests`는 그 자물쇠를 **안 잡고** `set_var`/`remove_var`를 했다.
//! 같은 바이너리에서 둘이 병렬로 돌면 `remove_var` 창 동안 [`ccg_store::app_home`]이
//! **사용자 실홈**으로 떨어지고, 그 순간 `Switcher::enabled()`의 `read_ui_prefs`와
//! 시드의 `write_store_file`이 실홈을 향한다. 확인 크리틱은 헤드라인 자물쇠
//! (`booting_with_the_toggle_on_queries_nothing`)가 1차 주행에서 red였고 격리 재현에서
//! **1/15**로 재현된다고 적었다(F5). 실홈 쓰기는 "사용자가 재로그인한다"와 같은 급이라
//! flaky 하나로 넘길 자리가 아니다.
//!
//! ## 규약
//!
//! - `CCG_HOME`을 세우거나 지우는 테스트는 [`take`]로 증표를 받는다. 증표가 살아 있는
//!   동안 다른 테스트는 그 함수 안에서 줄을 선다.
//! - 증표를 놓으면 홈은 **원래 값으로 되돌아간다**(없었으면 지운다). `remove_var`를
//!   손으로 부르지 않는다 — 그게 실홈으로 떨어지는 창을 만든 원인이다.

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};

fn lock() -> &'static Mutex<()> {
    static L: OnceLock<Mutex<()>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(()))
}

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

/// 격리 홈 하나 + 전역 자물쇠. 태그는 폴더 이름에만 쓴다.
pub fn take(tag: &str) -> TestHome {
    let guard = lock().lock().unwrap_or_else(|e| e.into_inner());
    let n = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("ccg-engine-test-{tag}-{n}"));
    let _ = std::fs::create_dir_all(&dir);
    let prev = std::env::var_os("CCG_HOME");
    std::env::set_var("CCG_HOME", &dir);
    TestHome { dir, prev, _guard: guard }
}

#[cfg(test)]
mod tests {
    /// ★F5 — 스레드 여럿이 홈을 갈아끼워도 **항상 자기 임시 홈**이다.
    ///
    /// R2에서 실패한 모양이 정확히 이것이다: 남이 `remove_var`를 부른 창에서
    /// `app_home()`이 사용자 실홈으로 떨어졌다. 증표를 잡은 동안 그 일이 없어야 한다.
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
                        let seen = ccg_store::app_home();
                        assert_eq!(seen, h.dir, "★ 남의 remove_var 창에서 홈이 바뀌었다");
                        assert_ne!(seen, real, "★ 실홈으로 떨어졌다 — 이 창에서의 쓰기는 사용자 데이터다");
                        drop(h);
                    }
                })
            })
            .collect();
        for t in hands {
            t.join().unwrap();
        }
        // 증표를 놓으면 그 임시 홈은 더 이상 앱 홈이 아니다(이전 값 복원).
        let dir = {
            let h = super::take("restore");
            h.dir.clone()
        };
        assert_ne!(ccg_store::app_home(), dir, "증표를 놓았는데 홈이 그대로다");
    }
}
