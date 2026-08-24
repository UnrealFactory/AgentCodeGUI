//! 테스트 전용 임시 홈 — **자물쇠는 [`ccg_store::testhome`] 것 하나뿐이다.**
//!
//! ★R28d(CASX) — R28c AG2 R3이 `ccg-store` 안의 자물쇠 둘을 하나로 합쳤는데, 이 파일이
//! **세 번째 사본**을 들고 있었다. 사본이 곧 결함이라는 것은 그 라운드가 실측으로 못
//! 박았다(자물쇠 둘 판에서 `cargo test -p ccg-store --lib`이 9/37 붉음 · 사용자 실홈에
//! 테스트가 쓴 파일 17건/540주행). 이 크레이트의 홈 자물쇠도 같은 성질이라 같은 자리로
//! 보낸다 — 규약은 [`ccg_store::testhome`] 모듈 주석이 단일 소스다.
//!
//! **실홈은 읽기/복사만 한다.** 실계정 파일을 여는 테스트도 원본 경로에는 절대 쓰지 않고,
//! 임시 홈으로 복사한 사본에만 쓴다(`copy_real`).

use std::path::PathBuf;

pub struct Home {
    pub dir: PathBuf,
    /// 증표를 놓으면 `CCG_HOME`이 **원래 값으로 되돌아가고** 폴더가 지워진다
    /// (`remove_var`를 손으로 부르지 않는다 — 그게 실홈으로 떨어지는 창을 만들었다).
    _guard: ccg_store::testhome::TestHome,
}

impl Home {
    pub fn path(&self, rel: &str) -> PathBuf {
        self.dir.join(rel)
    }
    pub fn write(&self, rel: &str, text: &str) {
        let p = self.path(rel);
        if let Some(d) = p.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        std::fs::write(p, text).expect("테스트 픽스처 쓰기");
    }
    pub fn read(&self, rel: &str) -> Option<String> {
        std::fs::read_to_string(self.path(rel)).ok()
    }

    /// 사용자 실홈의 파일을 임시 홈으로 **복사**한다(원본은 읽기만). 없으면 false.
    pub fn copy_real(&self, rel: &str) -> bool {
        let Some(src) = real_home().map(|h| h.join(rel)) else { return false };
        if !src.is_file() {
            return false;
        }
        let dst = self.path(rel);
        if let Some(d) = dst.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        std::fs::copy(&src, &dst).is_ok()
    }

    /// 설치본(2.6.2) userData의 `Local State`를 임시 홈에 넣는다 — 그래야 실홈의 credEnc(v10)를
    /// 복호할 수 있다. bench/fixture.mjs가 하는 것과 같은 준비다.
    pub fn copy_oscrypt_key(&self) -> bool {
        let Ok(appdata) = std::env::var("APPDATA") else { return false };
        let src = PathBuf::from(appdata).join("agent-code-gui").join("Local State");
        if !src.is_file() {
            return false;
        }
        let dst = self.path("userData/Local State");
        let _ = std::fs::create_dir_all(dst.parent().unwrap());
        std::fs::copy(&src, &dst).is_ok()
    }
}

/// 사용자 실홈(`~/.agentcodegui`) — **읽기 전용 원본**. `CCG_HOME`에 좌우되지 않게
/// 홈 디렉터리에서 직접 만든다(임시 홈이 걸린 상태에서 부르기 때문).
pub fn real_home() -> Option<PathBuf> {
    let p = std::env::var("USERPROFILE").ok().filter(|s| !s.is_empty()).map(PathBuf::from).or_else(|| {
        std::env::var("HOME").ok().filter(|s| !s.is_empty()).map(PathBuf::from)
    })?;
    let h = p.join(".agentcodegui");
    h.is_dir().then_some(h)
}

pub fn temp_home(tag: &str) -> Home {
    let guard = ccg_store::testhome::take(&format!("auth-{tag}"));
    let dir = guard.dir.clone();
    // ★R3 — 프로세스 전역 장부는 홈을 갈아끼울 때 반드시 비운다. 계정 이메일이
    // 테스트끼리 겹치므로(a@x·b@x…) 남겨 두면 앞 테스트의 백오프가 뒤 테스트를 물들인다.
    #[cfg(feature = "net")]
    crate::net::forget_backoff();
    Home { dir, _guard: guard }
}

#[cfg(test)]
mod tests {
    /// ★R28d(CASX) — **이 크레이트의 홈 자물쇠도 하나다.** `ccg-store`의 같은 이름 못과
    /// 같은 모양이다(그쪽 §자물쇠 하나 참고): 내 증표가 사는 동안 옆 스레드의
    /// [`ccg_store::testhome::take`]가 지나갈 수 있으면 자물쇠가 둘이라는 뜻이다.
    ///
    /// 실패 방향이 한쪽뿐인 못이다 — 옆 스레드가 안 깨어나면 **초록 쪽으로만** 틀린다.
    #[test]
    fn the_home_lock_is_shared_with_ccg_store() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        let mine = super::temp_home("one-lock");
        let dir = mine.dir.clone();
        let passed = Arc::new(AtomicBool::new(false));
        let rival = {
            let passed = Arc::clone(&passed);
            std::thread::spawn(move || {
                let _theirs = ccg_store::testhome::take("auth-one-lock-rival");
                passed.store(true, Ordering::SeqCst);
            })
        };
        std::thread::sleep(std::time::Duration::from_millis(150));
        assert!(!passed.load(Ordering::SeqCst), "★ 자물쇠가 둘이다 — 남이 내 증표 위로 지나갔다");
        assert_eq!(ccg_store::app_home(), dir, "★ 내 증표가 사는 동안 홈이 남의 것으로 바뀌었다");
        drop(mine);
        rival.join().expect("옆 스레드");
    }
}
