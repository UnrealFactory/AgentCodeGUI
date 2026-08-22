//! **실행 실적** 커버리지 게이트 (★R2 — 크리틱 R1 C1).
//!
//! R1의 게이트는 `Scen.covers` **선언**의 합집합을 셌다. 크리틱이 `s25_spawn_timeout`의
//! `#[test]` 한 줄만 지우고 레지스트리의 `S25`는 그대로 뒀더니 **T3를 밟는 테스트가 0개인데도
//! 60/60 만점 + 전체 초록**이었다(크리틱 §2.2). 설계 §3.7이 *"안 밟는 전이가 있으면 빌드 실패"*로
//! 막으려던 실패 모드가 게이트 자신 안에 있었다.
//!
//! 이제 입력이 둘 다 **실적**이다:
//!
//! | 층 | 입력 | 무엇을 막나 |
//! |---|---|---|
//! | **L1 런타임** | `Sim::finish()`가 남긴 `$CARGO_TARGET_TMPDIR/ccg-cov/<bin>/*.json` (실제로 밟은 전이·읽은 픽스처) | 선언은 남아 있는데 **아무도 실행하지 않는** 시나리오·전이 |
//! | **L2 정적** | `replay.rs`·`replay_standing.rs` 소스에서 **`#[test]` 안에 있는** `&S…` 참조 | 실행 순서와 무관하게 같은 반증을 **한 번 더** 잡는다 |
//!
//! L1의 전제는 이 바이너리가 **시나리오 바이너리보다 뒤에 돈다**는 것이다(cargo는 테스트 타깃을
//! 이름 순으로 돌린다 — `frame_coverage` < `identity_golden` < `live_smoke` < `replay` <
//! `replay_standing` < `zz_coverage_gate`. 그래서 이름이 `zz_`다). 순서가 바뀌어도 **거짓 초록은
//! 안 난다**: 실적에는 시나리오·하네스 소스 지문(`SRC_FP`)이 박혀 있어 소스가 바뀌면 지난 런의
//! 실적이 전부 무효가 되고, 바이너리는 시작할 때 자기 칸을 비운다. 그리고 L2는 순서와 무관하다.

mod harness;

use ccg_engine::state::all_transition_ids;
use harness::{Scen, ALL_SCENARIOS, ALL_SCENARIOS_EXTRA};
use std::collections::{BTreeMap, BTreeSet};

/// 지금 시나리오들이 **실제로 미는** 전이 수. 내려가면 실패(회귀), 올라가면 이 숫자를 올린다.
const COVERED_BASELINE: usize = 60;

// ─────────────────────────────────────────────────────────────────────────────
// 실적 읽기
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Default, Clone)]
struct Run {
    fired: BTreeSet<String>,
    kills: BTreeSet<String>,
    synth: BTreeSet<String>,
    bins: BTreeSet<String>,
}

fn registry() -> Vec<&'static Scen> {
    ALL_SCENARIOS
        .iter()
        .chain(ALL_SCENARIOS_EXTRA.iter())
        .cloned()
        .collect()
}

/// `ccg-cov/<bin>/*.json` 전부 → 시나리오 이름별 실적. **소스 지문이 다른 실적은 버린다.**
fn read_runtime_evidence() -> BTreeMap<String, Run> {
    let want = format!("{:016x}", harness::cov::SRC_FP);
    let mut out: BTreeMap<String, Run> = BTreeMap::new();
    let root = harness::cov::root();
    let Ok(bins) = std::fs::read_dir(&root) else {
        return out;
    };
    for bin in bins.flatten() {
        let Ok(files) = std::fs::read_dir(bin.path()) else {
            continue;
        };
        for f in files.flatten() {
            let Ok(txt) = std::fs::read_to_string(f.path()) else {
                continue;
            };
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) else {
                continue;
            };
            if v["src_fp"].as_str() != Some(want.as_str()) {
                continue; // 지난 소스의 실적 — 증거로 못 쓴다
            }
            let Some(name) = v["name"].as_str() else {
                continue;
            };
            let e = out.entry(name.to_string()).or_default();
            for (key, set) in [
                ("fired", &mut e.fired),
                ("kills", &mut e.kills),
                ("synth", &mut e.synth),
            ] {
                for x in v[key].as_array().into_iter().flatten() {
                    if let Some(s) = x.as_str() {
                        set.insert(s.to_string());
                    }
                }
            }
            if let Some(b) = v["bin"].as_str() {
                e.bins.insert(b.to_string());
            }
        }
    }
    out
}

// ── 순수 판정 함수 (반증 테스트가 직접 때린다) ────────────────────────────────

/// 레지스트리에는 있는데 **실적이 없는** 시나리오. 크리틱 §2.2의 반증이 여기서 죽는다.
fn scens_without_runtime_evidence<'a>(
    reg: &[&'a Scen],
    ran: &BTreeMap<String, Run>,
) -> Vec<&'a str> {
    reg.iter()
        .map(|s| s.name)
        .filter(|n| !ran.contains_key(*n))
        .collect()
}

/// 실적에는 있는데 레지스트리에 없는 이름(= 지운 시나리오의 유령 실적).
fn evidence_without_registration(reg: &[&Scen], ran: &BTreeMap<String, Run>) -> Vec<String> {
    let known: BTreeSet<&str> = reg.iter().map(|s| s.name).collect();
    ran.keys()
        .filter(|n| !known.contains(n.as_str()))
        .cloned()
        .collect()
}

/// 하네스 소스에서 `pub static S…: Scen = Scen { name: "…"` 를 뽑아 **식별자 → 이름** 표를 만든다.
fn scen_idents(harness_src: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut pending: Option<String> = None;
    for line in harness_src.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("pub static ") {
            if let Some((ident, tail)) = rest.split_once(':') {
                if tail.contains("Scen") {
                    pending = Some(ident.trim().to_string());
                    continue;
                }
            }
        }
        if let Some(ident) = pending.clone() {
            if let Some(rest) = t.strip_prefix("name: \"") {
                if let Some(end) = rest.rfind('"') {
                    out.insert(ident, rest[..end].to_string());
                    pending = None;
                }
            }
        }
    }
    out
}

/// 소스에서 **`#[test]`가 붙은 함수 본문 안에서만** 참조된 `&S…` 식별자를 모은다.
fn idents_referenced_inside_tests(src: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let (mut armed, mut depth, mut inside) = (false, 0i32, false);
    for line in src.lines() {
        let t = line.trim();
        if t == "#[test]" {
            armed = true;
            continue;
        }
        if !inside && armed && (t.starts_with("fn ") || t.starts_with("pub fn ")) {
            inside = true;
            depth = 0;
            armed = false;
        }
        if inside {
            collect_amp_idents(line, &mut out);
            depth += line.matches('{').count() as i32 - line.matches('}').count() as i32;
            if depth <= 0 && line.contains('}') {
                inside = false;
            }
        }
    }
    out
}

fn collect_amp_idents(line: &str, out: &mut BTreeSet<String>) {
    let b: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i + 1 < b.len() {
        if b[i] == '&' && b[i + 1] == 'S' {
            let mut j = i + 1;
            while j < b.len() && (b[j].is_ascii_alphanumeric() || b[j] == '_') {
                j += 1;
            }
            out.insert(b[i + 1..j].iter().collect());
            i = j;
        } else {
            i += 1;
        }
    }
}

/// 레지스트리에 있는데 **어떤 `#[test]`에서도 참조되지 않는** 시나리오 식별자.
fn scens_without_test_fn(
    idents: &BTreeMap<String, String>,
    registered_names: &BTreeSet<String>,
    used: &BTreeSet<String>,
) -> Vec<String> {
    idents
        .iter()
        .filter(|(_, name)| registered_names.contains(*name))
        .filter(|(ident, _)| !used.contains(*ident))
        .map(|(ident, name)| format!("{ident}({name})"))
        .collect()
}

// ─────────────────────────────────────────────────────────────────────────────
// L1 — 런타임 실적
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn every_registered_scen_actually_ran() {
    let reg = registry();
    let ran = read_runtime_evidence();
    assert!(
        !ran.is_empty(),
        "실적이 하나도 없다 — 시나리오 바이너리를 먼저 돌려야 한다\
         (`cargo test -p ccg-engine` 전체 1회). 실적 경로: {}",
        harness::cov::root().display()
    );
    let missing = scens_without_runtime_evidence(&reg, &ran);
    assert!(
        missing.is_empty(),
        "레지스트리에만 있고 **실행되지 않은** 시나리오: {missing:?}\n\
         (선언은 커버리지를 만들지 못한다 — 크리틱 R1 §2.2)"
    );
    let ghosts = evidence_without_registration(&reg, &ran);
    assert!(ghosts.is_empty(), "레지스트리에 없는 실적: {ghosts:?}");
}

#[test]
fn transition_coverage_is_counted_from_runtime_evidence() {
    let all: Vec<&str> = all_transition_ids();
    let ran = read_runtime_evidence();
    let fired: BTreeSet<String> = ran.values().flat_map(|r| r.fired.iter().cloned()).collect();
    let missing: Vec<&str> = all
        .iter()
        .filter(|t| !fired.contains(**t))
        .cloned()
        .collect();
    let covered = all.len() - missing.len();

    println!("\n─ 전이 커버리지(실행) ........ {covered}/{} 밟음", all.len());
    println!("─ 안 밟은 전이 ............... {missing:?}");

    let kills: BTreeSet<&str> = ran
        .values()
        .flat_map(|r| r.kills.iter().map(|s| s.as_str()))
        .collect();
    let pathologies = [
        "P1", "P1b", "P1c", "P1d", "P1e", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P8b", "P8c",
        "P9",
    ];
    let uncovered_p: Vec<&str> = pathologies
        .iter()
        .filter(|p| !kills.contains(**p))
        .cloned()
        .collect();
    println!(
        "─ 죽인 병리 커버리지 ......... {}/{} · 빈 병리 {uncovered_p:?}",
        pathologies.len() - uncovered_p.len(),
        pathologies.len()
    );

    let synth_dep = ran.values().filter(|r| !r.synth.is_empty()).count();
    let assumed_files: BTreeSet<&str> = registry()
        .iter()
        .flat_map(|s| s.synth.iter())
        .filter(|s| s.contains("assumed"))
        .map(|s| s.split('(').next().unwrap_or(s).trim())
        .collect();
    let assumed = ran
        .values()
        .filter(|r| r.synth.iter().any(|f| assumed_files.contains(f.as_str())))
        .count();
    println!(
        "─ 합성 픽스처 의존(실측) ..... {synth_dep} (그중 `assumed` 등급 {assumed})"
    );
    println!("─ 실행된 시나리오 ............ {}\n", ran.len());

    assert!(
        covered >= COVERED_BASELINE,
        "커버리지 후퇴: {covered} < 베이스라인 {COVERED_BASELINE} (빠진 것 {missing:?})"
    );
    assert!(
        missing.is_empty(),
        "설계 §3.7: 안 밟는 전이가 있으면 빌드 실패 — {missing:?}"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// L2 — 정적(실행 순서와 무관)
// ─────────────────────────────────────────────────────────────────────────────

const HARNESS_SRC: &str = include_str!("harness/mod.rs");
const REPLAY_SRC: &str = include_str!("replay.rs");
const STANDING_SRC: &str = include_str!("replay_standing.rs");

#[test]
fn every_registered_scen_has_a_test_fn() {
    let idents = scen_idents(HARNESS_SRC);
    let registered: BTreeSet<String> = registry().iter().map(|s| s.name.to_string()).collect();
    assert_eq!(
        idents.len(),
        registered.len(),
        "하네스 소스의 Scen 정의 수({})와 레지스트리 등록 수({})가 다르다 — \
         정의만 하고 ALL_SCENARIOS에 안 넣었거나 그 반대다",
        idents.len(),
        registered.len()
    );
    let mut used = idents_referenced_inside_tests(REPLAY_SRC);
    used.extend(idents_referenced_inside_tests(STANDING_SRC));
    let orphans = scens_without_test_fn(&idents, &registered, &used);
    assert!(
        orphans.is_empty(),
        "`#[test]`가 하나도 없는 시나리오: {orphans:?}\n\
         (`#[test]`만 떼고 레지스트리를 남기면 R1 게이트는 만점을 줬다 — 크리틱 §2.2)"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// 크리틱 §2.2 반증의 **재현** — 게이트가 그 조작을 잡는다는 것을 테스트로 잠근다
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn r1_refutation_is_now_caught_l1_runtime() {
    let reg = registry();
    // 크리틱이 한 짓 그대로: `S25`는 레지스트리에 남기고 그 테스트만 없앤다.
    let mut ran: BTreeMap<String, Run> = reg
        .iter()
        .map(|s| (s.name.to_string(), Run::default()))
        .collect();
    let s25 = reg
        .iter()
        .find(|s| s.name.starts_with("#25 "))
        .expect("#25 시나리오");
    ran.remove(s25.name);
    let missing = scens_without_runtime_evidence(&reg, &ran);
    assert_eq!(
        missing,
        vec![s25.name],
        "★ 실적이 없는 시나리오를 게이트가 못 잡으면 R1 구멍이 그대로다"
    );

    // 그리고 T3(= #25만 밟는 전이)는 실적 합집합에서 실제로 사라져야 한다.
    let real = read_runtime_evidence();
    let without_s25: BTreeSet<String> = real
        .iter()
        .filter(|(n, _)| n.as_str() != s25.name)
        .flat_map(|(_, r)| r.fired.iter().cloned())
        .collect();
    let all_fired: BTreeSet<String> = real.values().flat_map(|r| r.fired.iter().cloned()).collect();
    assert!(all_fired.contains("T3"), "#25가 T3를 밟고 있어야 한다");
    assert!(
        !without_s25.contains("T3"),
        "★ #25를 빼도 T3가 남으면 이 반증은 T3를 대표하지 못한다 — 다른 전이로 바꿔라"
    );
}

#[test]
fn r1_refutation_is_now_caught_l2_static() {
    let idents = scen_idents(HARNESS_SRC);
    let registered: BTreeSet<String> = registry().iter().map(|s| s.name.to_string()).collect();

    // 크리틱의 조작을 소스 텍스트에 그대로 가한다: `s25_spawn_timeout`의 `#[test]`만 제거.
    let needle = "#[test]\r\nfn s25_spawn_timeout()";
    let needle_lf = "#[test]\nfn s25_spawn_timeout()";
    let mutated = if STANDING_SRC.contains(needle) {
        STANDING_SRC.replace(needle, "fn s25_spawn_timeout()")
    } else {
        assert!(
            STANDING_SRC.contains(needle_lf),
            "s25_spawn_timeout 의 `#[test]` 바로 아래 줄 형태가 바뀌었다"
        );
        STANDING_SRC.replace(needle_lf, "fn s25_spawn_timeout()")
    };
    assert_ne!(mutated, STANDING_SRC, "뮤테이션이 적용되지 않았다");

    let mut used = idents_referenced_inside_tests(REPLAY_SRC);
    used.extend(idents_referenced_inside_tests(&mutated));
    let orphans = scens_without_test_fn(&idents, &registered, &used);
    assert_eq!(
        orphans.len(),
        1,
        "★ `#[test]` 제거를 정적 층이 잡아야 한다 — 잡힌 것: {orphans:?}"
    );
    assert!(orphans[0].starts_with("S25("), "잡힌 것: {orphans:?}");

    // 원본은 당연히 깨끗해야 한다(위 뮤테이션이 진짜 원인이라는 대조군).
    let mut clean = idents_referenced_inside_tests(REPLAY_SRC);
    clean.extend(idents_referenced_inside_tests(STANDING_SRC));
    assert!(scens_without_test_fn(&idents, &registered, &clean).is_empty());
}
