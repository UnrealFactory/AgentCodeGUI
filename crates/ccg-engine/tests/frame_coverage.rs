//! 커버리지 게이트 — `m-logic.md` §3.7 사영표(24행+4) × 전이 60개 × 시나리오 `covers[]`.
//!
//! 두 집계가 **"표에는 있는데 테스트가 없는 줄"을 구조적으로 못 만들게** 한다:
//! ① 사영표의 모든 프레임이 존재하는 전이로 사영되는가
//! ② 전이 60개 중 시나리오가 실제로 밟은 것이 몇 개인가(그리고 **어느 것이 비었는가**)
//!
//! 설계는 "안 밟는 전이가 있으면 빌드 실패"를 요구한다. 지금은 그 조건을 **아직 못 채운다** —
//! 그래서 게이트를 좁히는 대신 **베이스라인을 박아** 후퇴만 실패로 만든다.
//! 남은 빈칸은 `docs/m3-report-r1.md`의 커버리지 표에 사유와 함께 적혀 있다.

mod harness;

use ccg_engine::state::{all_transition_ids, PROJECTION_8_4};
use std::collections::BTreeSet;

/// 지금 시나리오들이 실제로 미는 전이 수. **내려가면 실패**(회귀), 올라가면 이 숫자를 올린다.
const COVERED_BASELINE: usize = 60;

fn declared() -> BTreeSet<&'static str> {
    harness::ALL_SCENARIOS
        .iter()
        .chain(harness::ALL_SCENARIOS_EXTRA.iter())
        .flat_map(|s| s.covers.iter().cloned())
        .collect()
}

#[test]
fn projection_8_4_is_closed() {
    let known: BTreeSet<&str> = all_transition_ids().into_iter().collect();
    for (frame, ts) in PROJECTION_8_4 {
        assert!(!ts.is_empty(), "사영표 빈칸: {frame}");
        for t in *ts {
            assert!(known.contains(t), "{frame} → 표에 없는 전이 {t}");
        }
    }
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

#[test]
fn transition_coverage_report() {
    let all: Vec<&str> = all_transition_ids();
    let cov = declared();
    let missing: Vec<&str> = all.iter().filter(|t| !cov.contains(**t)).cloned().collect();
    let covered = all.len() - missing.len();

    println!("\n─ 프레임 커버리지 ............ 전이 {covered}/{} 밟음", all.len());
    println!("─ 안 밟은 전이 ............... {missing:?}");

    let mut kills: BTreeSet<&str> = BTreeSet::new();
    for s in harness::ALL_SCENARIOS.iter().chain(harness::ALL_SCENARIOS_EXTRA) {
        kills.extend(s.kills.iter().cloned());
    }
    let pathologies = [
        "P1", "P1b", "P1c", "P1d", "P1e", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P8b", "P8c",
        "P9",
    ];
    let uncovered_p: Vec<&str> = pathologies
        .iter()
        .filter(|p| !kills.contains(**p))
        .cloned()
        .collect();
    println!("─ 죽인 병리 커버리지 ......... {}/{} · 빈 병리 {uncovered_p:?}",
        pathologies.len() - uncovered_p.len(), pathologies.len());

    let mut policies: std::collections::BTreeMap<&str, usize> = Default::default();
    for s in harness::ALL_SCENARIOS.iter().chain(harness::ALL_SCENARIOS_EXTRA) {
        *policies.entry(s.close_policy).or_default() += 1;
    }
    println!("─ close_policy 분포 .......... {policies:?}");
    println!("─ 시나리오 수 ................ {}", harness::ALL_SCENARIOS.len() + harness::ALL_SCENARIOS_EXTRA.len());
    let synth_dep = harness::ALL_SCENARIOS
        .iter()
        .chain(harness::ALL_SCENARIOS_EXTRA.iter())
        .filter(|s| !s.synth.is_empty())
        .count();
    let assumed = harness::ALL_SCENARIOS
        .iter()
        .chain(harness::ALL_SCENARIOS_EXTRA.iter())
        .filter(|s| s.synth.iter().any(|x| x.contains("assumed")))
        .count();
    println!("─ 합성 의존 시나리오 ......... {synth_dep} (그중 `assumed` 등급 의존 {assumed})\n");

    assert!(
        covered >= COVERED_BASELINE,
        "커버리지 후퇴: {covered} < 베이스라인 {COVERED_BASELINE} (빠진 것 {missing:?})"
    );
}
