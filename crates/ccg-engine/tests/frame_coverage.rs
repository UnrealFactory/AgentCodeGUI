//! **구조** 게이트 — `m-logic.md` §3.7 사영표(설계 표 그대로 32행: §8.4 28행 + 와이어 4행)
//! × 전이 60개 × 시나리오 선언.
//!
//! 여기 있는 것은 전부 **소스만 보면 판정되는 것**이다: 사영표가 닫혀 있는가, 선언이 표에 없는
//! id를 부르지 않는가. *"그 줄을 실제로 밟았는가"*는 소스로 알 수 없으므로
//! **`tests/zz_coverage_gate.rs`가 런타임 실적으로** 센다(★R2 — 크리틱 R1 C1).
//!
//! > R1 주석은 여기에 *"설계는 안 밟는 전이가 있으면 빌드 실패를 요구하는데 지금은 못 채운다 →
//! > 베이스라인만 박는다"*라고 적었다. 두 군데가 틀렸다: 그때 이미 `covered == 60 == all.len()`
//! > 이라 사실상 엄격 게이트였고(주석이 stale), 약한 건 베이스라인이 아니라 **입력이 선언이라는
//! > 점**이었다(크리틱 §2.2). 입력을 실적으로 바꾼 뒤 그 assert는 게이트 바이너리로 옮겼다.

mod harness;

use ccg_engine::state::{all_transition_ids, PROJECTION_8_4};
use std::collections::BTreeSet;

/// `m-logic.md` §1의 병리 번호 전집합.
pub const PATHOLOGIES: [&str; 15] = [
    "P1", "P1b", "P1c", "P1d", "P1e", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P8b", "P8c", "P9",
];

#[test]
fn projection_8_4_is_closed() {
    let known: BTreeSet<&str> = all_transition_ids().into_iter().collect();
    for (frame, ts) in PROJECTION_8_4 {
        assert!(!ts.is_empty(), "사영표 빈칸: {frame}");
        for t in *ts {
            assert!(known.contains(t), "{frame} → 표에 없는 전이 {t}");
        }
    }
    println!("─ 사영표 ..................... {}행", PROJECTION_8_4.len());
}

#[test]
fn declared_covers_reference_real_transitions() {
    let known: BTreeSet<&str> = all_transition_ids().into_iter().collect();
    for s in harness::ALL_SCENARIOS.iter().chain(harness::ALL_SCENARIOS_EXTRA) {
        for c in s.covers {
            assert!(known.contains(c), "[{}] 표에 없는 전이 선언: {c}", s.name);
        }
    }
}

/// `kills[]`는 런타임 대조 대상이 **아니다**(병리는 설계 주장이지 실행 흔적이 아니다).
/// 그래서 최소한 **없는 병리 번호를 부르는 것**만은 여기서 막는다 — R1은 이것도 없었다.
#[test]
fn declared_kills_reference_real_pathologies() {
    let known: BTreeSet<&str> = PATHOLOGIES.into_iter().collect();
    for s in harness::ALL_SCENARIOS.iter().chain(harness::ALL_SCENARIOS_EXTRA) {
        for k in s.kills {
            assert!(known.contains(k), "[{}] 없는 병리 선언: {k}", s.name);
        }
    }
}

/// 선언한 합성 픽스처 파일이 **실제로 존재하는가**(등급 표기 `(assumed)`는 떼고 본다).
/// 실제 로드와의 대조는 러너(`check_synth`)가 시나리오마다 한다.
#[test]
fn declared_synth_files_exist() {
    let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/synth");
    for s in harness::ALL_SCENARIOS.iter().chain(harness::ALL_SCENARIOS_EXTRA) {
        for f in s.synth {
            let base = f.split('(').next().unwrap_or(f).trim();
            let p = dir.join(format!("{base}.jsonl"));
            assert!(p.exists(), "[{}] 없는 합성 픽스처: {}", s.name, p.display());
        }
    }
}

#[test]
fn close_policy_distribution_is_reported() {
    let mut policies: std::collections::BTreeMap<&str, usize> = Default::default();
    for s in harness::ALL_SCENARIOS.iter().chain(harness::ALL_SCENARIOS_EXTRA) {
        *policies.entry(s.close_policy).or_default() += 1;
    }
    println!("─ close_policy 분포 .......... {policies:?}");
    println!(
        "─ 등록된 시나리오 ............ {}",
        harness::ALL_SCENARIOS.len() + harness::ALL_SCENARIOS_EXTRA.len()
    );
    assert!(policies.values().sum::<usize>() > 0);
}
