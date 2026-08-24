//! **서브시스템 무력화 스위치** — 유휴 메모리를 *귀속*하기 위한 팔 가르개(★R4).
//!
//! ## 왜 있나
//!
//! R3의 주 게이트는 유휴 Priv **254.7MB**로 게이트(≤253)를 넘었는데, 그 델타를 어느
//! 라운드에도 귀속할 수 없었다(§R3.7): 같은 바이너리에 네 라운드의 변경이 함께 들어
//! 있었고 **팔을 가를 수단이 없었다**. R2가 자기 델타를 주장할 때 쓴 방법(같은 바이너리
//! 인터리브 A/B)은 `CCG_UNIFIED_STORE`라는 스위치가 있었기 때문에 성립한 것이다.
//!
//! 그래서 서브시스템마다 스위치를 하나씩 판다. 규칙 셋:
//!
//! 1. **기본값은 전부 켬**이다. 스위치를 안 주면 제품 동작이 한 글자도 안 바뀐다.
//! 2. 판정은 `ccg_store::unified_store_enabled()`와 **같은 규약** — 값이 `0`/`false`/빈
//!    문자열이면 "안 껐다"로 읽는다. 오타(`=yes`)로 조용히 꺼지는 사고를 막는다.
//! 3. 프로세스 수명 동안 **한 번만** 읽는다(`OnceLock`). 측정 도중 값이 바뀌면 두 팔이
//!    한 주행 안에서 섞인다.
//!
//! ## 스위치 목록
//!
//! | 이름 | 끄는 것 | 왜 후보인가 |
//! |---|---|---|
//! | `CCG_NO_ENGINE_GLUE` | `engine::boot`/`dispatch`/`shutdown` 전체 | R2·R3이 새로 얹은 코드가 전부 여기 산다(허브 스레드·상태 장전·재장전·와이어) |
//! | `CCG_NO_ENGINE_HUB` | 허브 **스레드**만(상태 장전·브로드캐스트는 유지) | 스레드 하나의 스택·job object의 몫을 가른다 |
//! | `CCG_NO_STATUS_BOOT` | `status::load_boot` + 재장전 + 첫 `chat:status` | 채팅 파일 전수 얕은 스캔 + 상태 맵이 상주로 남는 몫 |
//! | `CCG_NO_FS` | `ccg-img` 스킴 등록 + `fs:*`/`git:*` 채널 | M6가 새로 링크한 `ccg-fs` 크레이트의 상주 몫 |
//! | `CCG_NO_STATUS_TICK` | `chat:status`·`chat:windows` 재송신(마운트 따라잡기) | 렌더러가 그 REPLACE를 받아 들고 있는 몫(렌더러 힙 쪽 귀속) |
//! | `CCG_NO_BOOT_ENGINE_UPDATE` | 부팅 엔진 자동 업데이트(`engine/boot_update.rs`) | 이 흐름은 **npm 왕복 + 수백 MB 설치**다. 격리 홈으로 앱을 띄우는 하네스가 전부 그걸 시작하면 측정이 그것부터 재게 된다 |
//!
//! `CCG_UNIFIED_STORE=0`(통합 스토어 끔)은 이미 있고 `bench/lib.mjs armName()`이 팔
//! 이름에 반영한다. 위 스위치들도 같은 곳에 등록했다 — **팔마다 자기 결과 파일에 써야**
//! 두 번째 팔이 첫 팔을 지우지 않는다(R2.5가 닫은 결함).

use std::sync::OnceLock;

fn off(name: &'static str) -> bool {
    match std::env::var(name) {
        Ok(v) => !matches!(v.as_str(), "" | "0" | "false"),
        Err(_) => false,
    }
}

macro_rules! switch {
    ($fn_name:ident, $env:literal) => {
        pub fn $fn_name() -> bool {
            static V: OnceLock<bool> = OnceLock::new();
            *V.get_or_init(|| off($env))
        }
    };
}

switch!(no_engine_glue, "CCG_NO_ENGINE_GLUE");
switch!(no_engine_hub, "CCG_NO_ENGINE_HUB");
switch!(no_status_boot, "CCG_NO_STATUS_BOOT");
switch!(no_fs, "CCG_NO_FS");
switch!(no_status_tick, "CCG_NO_STATUS_TICK");
switch!(no_boot_engine_update, "CCG_NO_BOOT_ENGINE_UPDATE");

/// 지금 켜져 있는 무력화 스위치 목록 — 진단 채널(`engine:debug`)이 싣는다.
/// 측정 산출물에 "이 주행이 정말 그 팔이었나"를 남기는 유일한 자리다.
pub fn active() -> Vec<&'static str> {
    let mut out = vec![];
    for (on, name) in [
        (no_engine_glue(), "CCG_NO_ENGINE_GLUE"),
        (no_engine_hub(), "CCG_NO_ENGINE_HUB"),
        (no_status_boot(), "CCG_NO_STATUS_BOOT"),
        (no_fs(), "CCG_NO_FS"),
        (no_status_tick(), "CCG_NO_STATUS_TICK"),
        (no_boot_engine_update(), "CCG_NO_BOOT_ENGINE_UPDATE"),
        // 스토어가 직접 읽는 팔(부팅 경로를 R3의 깊은 파싱으로 되돌린다) — 목록에는
        // 같이 실어야 산출물만 보고 그 주행의 팔을 재구성할 수 있다.
        (ccg_store::deep_boot_scan(), "CCG_DEEP_BOOT_SCAN"),
        (ccg_store::light_panel_chats(), "CCG_LIGHT_PANEL_CHATS"),
    ] {
        if on {
            out.push(name);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    /// 판정 규약은 `unified_store_enabled()`와 같다 — **"0/false/빈 값만 끔 아님"**.
    /// (env는 프로세스 전역이라 `OnceLock` 래퍼가 아니라 원 함수를 잰다.)
    #[test]
    fn only_a_real_value_turns_a_switch_on() {
        std::env::set_var("CCG_TEST_SWITCH", "1");
        assert!(super::off("CCG_TEST_SWITCH"));
        for v in ["0", "false", ""] {
            std::env::set_var("CCG_TEST_SWITCH", v);
            assert!(!super::off("CCG_TEST_SWITCH"), "{v} 는 끔이 아니다");
        }
        std::env::remove_var("CCG_TEST_SWITCH");
        assert!(!super::off("CCG_TEST_SWITCH"));
    }
}
