//! 테스트 전용 임시 홈. `ccg-store`의 testkit은 `#[cfg(test)]`라 크레이트 밖에서 못 쓴다 —
//! 같은 규약(프로세스 전역 `CCG_HOME`이라 직렬화 필수)으로 최소한만 둔다.
//!
//! **실홈은 읽기/복사만 한다.** 실계정 파일을 여는 테스트도 원본 경로에는 절대 쓰지 않고,
//! 임시 홈으로 복사한 사본에만 쓴다(`copy_real`).

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};

fn lock() -> &'static Mutex<()> {
    static L: OnceLock<Mutex<()>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(()))
}

pub struct Home {
    pub dir: PathBuf,
    _guard: MutexGuard<'static, ()>,
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

impl Drop for Home {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
        std::env::remove_var("CCG_HOME");
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
    let guard = lock().lock().unwrap_or_else(|e| e.into_inner());
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("ccg-auth-{tag}-{n}"));
    let _ = std::fs::create_dir_all(&dir);
    std::env::set_var("CCG_HOME", &dir);
    // ★R3 — 프로세스 전역 장부는 홈을 갈아끼울 때 반드시 비운다. 계정 이메일이
    // 테스트끼리 겹치므로(a@x·b@x…) 남겨 두면 앞 테스트의 백오프가 뒤 테스트를 물들인다.
    #[cfg(feature = "net")]
    crate::net::forget_backoff();
    Home { dir, _guard: guard }
}
