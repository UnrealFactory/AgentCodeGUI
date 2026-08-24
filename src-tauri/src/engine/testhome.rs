//! ★M11 R3(F5) → **최종 파리티 T2 정정** — `CCG_HOME`은 프로세스 전역이고, 그 자물쇠는
//! **프로세스에 하나여야 한다**. 이 파일은 이제 [`ccg_store::testhome`]의 얇은 재수출이다.
//!
//! ## 왜 합쳤나 (실측)
//!
//! R3는 여기 자기 뮤텍스를 뒀고 M11 R4가 `ccg-store`에 같은 것을 하나 더 뒀다. 그때는
//! 두 자물쇠가 **다른 테스트 바이너리**에 있어서 문제가 없었다. 최종 파리티 라운드가
//! `ipc/parity/*`(한도·btw·MCP/스킬) 테스트를 같은 `agentcodegui` 바이너리에 넣으면서
//! 사정이 바뀌었다 — 그쪽은 `ccg_store::testhome`을, `engine::*`는 이쪽을 잡으니
//! **같은 바이너리 안에서 두 무리가 서로를 안 보고** `CCG_HOME`을 갈아끼웠다.
//!
//! 실측(이 라운드, `cargo test` 3회 연속):
//! ```text
//!   FAILED. 86 passed; 1 failed     engine::acct_switch::…::the_first_question_is_what_wakes_the_worker
//!   FAILED. 85 passed; 2 failed       └ "accounts.json: 지정된 경로를 찾을 수 없습니다 (os error 3)"
//!   FAILED. 86 passed; 1 failed          = 남이 드롭한 임시 홈을 가리킨 채로 썼다
//!   ok.     87 passed; 0 failed     ← --test-threads=1
//! ```
//! 게이트가 실행 방식에 따라 답이 갈리면 게이트가 아니다(R4가 같은 문장으로 합친 이유).
//! 자물쇠를 보호 대상([`ccg_store::app_home`]) 옆에 두면 크레이트가 늘어도 사본이 안 는다.

pub use ccg_store::testhome::{take, TestHome};

#[cfg(test)]
mod tests {
    /// 두 무리가 **같은** 자물쇠를 잡는가 — 이 파일이 다시 갈라지면 여기서 붉어진다.
    /// (`ccg_store` 쪽 증표를 잡은 채 이쪽 [`take`]가 들어오면 줄을 서야 한다.)
    #[test]
    fn engine_side_and_store_side_share_one_lock() {
        let a = ccg_store::testhome::take("t2-shared-lock");
        let seen = ccg_store::app_home();
        assert_eq!(seen, a.dir, "증표를 잡았는데 홈이 남의 것이다");
        let hand = std::thread::spawn(|| {
            let b = super::take("t2-shared-lock-2");
            assert_eq!(ccg_store::app_home(), b.dir);
        });
        // 자물쇠가 하나면 위 스레드는 `a`를 놓을 때까지 못 들어온다 — 그동안 홈은 우리 것이다.
        for _ in 0..200 {
            assert_eq!(ccg_store::app_home(), a.dir, "★ 자물쇠가 둘로 갈렸다");
            std::thread::yield_now();
        }
        drop(a);
        hand.join().unwrap();
    }
}
