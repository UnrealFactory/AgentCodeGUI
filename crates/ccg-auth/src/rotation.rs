//! ★R28 ACCT R2(N2) — **토큰 회전 금지 구역.**
//!
//! §1의 선행 워밍은 M11 R2 C1이 부팅 프리웜을 들어낸 사고를 되풀이하지 않으려고
//! *"로컬 액세스 토큰이 살아 있는 계정만 조회한다"*는 문을 달았다. R1 보고서는 그걸
//! **「워밍이 토큰을 회전시키는 건 구조적으로 불가능」**이라고 적었는데, 확인 크리틱 R1
//! N2가 그 문장이 사실보다 세다는 것을 코드로 짚었다:
//!
//! ```text
//! net::fetch_account_usage → 401/403 → force_refresh(email, stale) → rotate(email)
//! ```
//!
//! 로컬 만료 시각만 보는 문은 *"시간상 살아 있는데 서버가 이미 죽였다"*를 못 거른다.
//! 그 판에서 워밍은 교환 POST를 쏘고, 성공하면 그 순간 옛 refresh 토큰이 서버에서 죽는다 —
//! **되돌릴 수 없는 부작용**이고, 앱을 켠 것 말고는 사용자가 한 일이 없다.
//!
//! 그래서 문장을 코드로 만든다. 회전으로 가는 문이 둘(`access_token`·`force_refresh`)이라
//! 호출부마다 인자를 늘리면 하나를 빠뜨리는 순간 성질이 조용히 사라진다 — 대신 **구역**을
//! 하나 판다. 이 구역 안에서는 어느 경로로 들어와도 회전이 거절된다
//! ([`crate::net::NetError::RotateForbidden`]).
//!
//! 스레드 로컬인 이유: 워밍 훑기는 자기 스레드에서 돈다. 프로세스 전역 플래그로 만들면
//! 그 시각 다른 스레드에서 도는 **사용자 조작**(계정 전환·Account 탭 직접 조회)까지 막힌다
//! — 그건 사용자가 기다리기로 한 회전이라 막을 이유가 없다.

use std::cell::Cell;
use std::sync::atomic::{AtomicU64, Ordering};

thread_local! {
    /// 중첩 깊이. 0보다 크면 이 스레드에서는 회전이 금지다.
    static DEPTH: Cell<u32> = const { Cell::new(0) };
}

/// 이 구역이 열린 누적 횟수 — **관측용**(테스트·진단). 배선이 실제로 이 문을 지나는지는
/// 밖에서 볼 방법이 이것뿐이다: 회전은 401 응답이 있어야 시작되는데, 하네스는
/// `CCG_NO_NET=1`이라 401까지 갈 수가 없다(첫 전송에서 거절된다).
static ENTERED: AtomicU64 = AtomicU64::new(0);

/// 지금 이 스레드에서 토큰 회전이 금지돼 있나.
pub fn forbidden() -> bool {
    DEPTH.with(|d| d.get() > 0)
}

/// `f`를 **회전 금지 구역 안에서** 돌린다. 중첩·패닉에도 깊이가 새지 않는다(Drop 가드).
pub fn forbid<T>(f: impl FnOnce() -> T) -> T {
    struct Guard;
    impl Drop for Guard {
        fn drop(&mut self) {
            DEPTH.with(|d| d.set(d.get().saturating_sub(1)));
        }
    }
    DEPTH.with(|d| d.set(d.get().saturating_add(1)));
    ENTERED.fetch_add(1, Ordering::Relaxed);
    let _g = Guard;
    f()
}

/// 누적 진입 횟수(관측용).
pub fn entered_count() -> u64 {
    ENTERED.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 구역의 세 성질: 중첩이 새지 않는다 · 패닉에도 닫힌다 · **다른 스레드는 자유롭다**.
    #[test]
    fn the_no_rotate_scope_nests_survives_panics_and_stays_on_its_thread() {
        assert!(!forbidden(), "기본값은 자유다 — 사용자 조작까지 막으면 안 된다");
        let seen = forbid(|| {
            let inner = forbid(forbidden);
            // 중첩에서 빠져나와도 바깥 구역은 살아 있다.
            (inner, forbidden())
        });
        assert_eq!(seen, (true, true));
        assert!(!forbidden(), "★ 구역을 나왔는데 금지가 남았다 = 이후 모든 회전이 죽는다");

        // 패닉으로 빠져나가도 깊이가 새면 안 된다(회전이 영영 안 나가는 판이 된다).
        let boom = std::panic::catch_unwind(|| forbid(|| panic!("의도된 패닉")));
        assert!(boom.is_err());
        assert!(!forbidden(), "★ 패닉이 금지 깊이를 남겼다");

        // 스레드 로컬 — 워밍이 도는 동안에도 사용자가 누른 조회는 회전할 수 있어야 한다.
        let other = forbid(|| std::thread::spawn(forbidden).join().expect("스레드"));
        assert!(!other, "★ 워밍 하나가 프로세스 전체의 회전을 막았다");

        let before = entered_count();
        forbid(|| ());
        assert_eq!(entered_count(), before + 1, "관측 카운터가 안 는다 = 배선을 밖에서 못 잰다");
    }
}
