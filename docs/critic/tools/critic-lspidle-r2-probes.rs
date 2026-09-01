// 확인 크리틱 LSPIDLE **R2** — 수명 규칙 프로브 ⑤⑥ (커밋 d01203b 판정)
//
// ★격리 사본에만 심는다. 제품 코드가 아니다.
//
// 적용법:
//   1) git archive d01203b 를 격리 트리에 푼다(예: C:/Temp/critic2-lspidle)
//   2) 이 파일의 본문(아래 `── 잘라 붙이는 곳 ─` 아래)을
//      crates/ccg-lsp/src/lifecycle.rs 의 `mod tests { ... }` **안** 끝에 붙인다
//   3) CARGO_TARGET_DIR=C:/Temp/ccg-t-critic2 \
//        cargo test -p ccg-lsp critic_ -- --nocapture --test-threads=1
//
// 전임 크리틱이 ①~④를 세웠고 ①(Settle 수확)이 붉었다. ⑤는 그 붉음의 **현실성**을 재고
// (위상을 전부 돌린다 → 0/P, 즉 최적 위상 없이는 불사가 아니다), ⑥은 반대쪽을 잰다
// (5분짜리 멎음 눈금이 **진짜로 일하는 서버**를 끊는 자리 → 붉다).
//
// 결과: docs/critic/evidence/r2-lifecycle-probes.json
//
// ── 잘라 붙이는 곳 ──────────────────────────────────────────────────────────
    // ══ 확인 크리틱 R2 (인계 완성분) — 전임의 ①이 붉은 뒤 남은 두 물음 ═════════════
    //
    // 전임이 ①~④를 세웠고 ①(Settle 수확)이 붉었다. 그 공격은 「TTL을 넘긴 바로 그
    // 스윕」에 맞춰 일하는 척하는 **최적 위상**을 골랐다. 실제 서버는 위상을 못 고른다.
    // 그래서 ⑤가 위상을 전부 돌려 「현실성」을 수치로 만들고, ⑥이 반대쪽 —
    // 5분짜리 멎음 눈금이 **진짜로 일하는 서버**를 끊는 자리 — 를 잰다.

    /// ★크리틱 R2-⑤ — **주기적으로 잠깐씩 일하는 서버는 얼마나 자주 불사가 되는가.**
    ///
    /// 모형: 서버가 `P`분마다 `D`분짜리 인덱싱 에피소드를 돈다(그 동안 `$/progress`가
    /// 흐르므로 `indexing=true`이고 `saw_work`도 매분 온다). 사용자는 **한 번도 안 쓴다**.
    /// 에피소드 시작 위상을 `0..P`로 전부 돌려 24시간 안에 회수되는지 센다.
    ///
    /// 위상 의존성이 요점이다 — 전임 ①은 위상을 최적으로 고른 공격이었다. 실제 서버가
    /// 그 위상을 잡을 확률이 곧 이 결함의 현실성이다.
    #[test]
    fn critic_r2_how_often_does_periodic_churn_make_a_server_immortal() {
        let mut bad: Vec<String> = Vec::new();
        for s in crate::spec::SPECS {
            for (d_min, p_min) in
                [(1u64, 5u64), (1, 10), (2, 10), (1, 15), (2, 15), (1, 30), (5, 30), (2, 60), (10, 60)]
            {
                let mut immortal = 0u64;
                for phase in 0..p_min {
                    let mut l = Lifecycle::new(0);
                    let mut now = 0u64;
                    let mut alive = true;
                    while now < 24 * 60 * MIN {
                        now += MIN; // 스윕 격자 60초
                        let m = now / MIN;
                        let indexing = ((m + p_min - phase) % p_min) < d_min;
                        if indexing {
                            l.saw_work(now);
                        }
                        if l.step(now, s.idle_ttl_ms, indexing) == Sweep::Reclaim {
                            alive = false;
                            break;
                        }
                    }
                    if alive {
                        immortal += 1;
                    }
                }
                let work_per_day = (24 * 60 / p_min) * d_min;
                eprintln!(
                    "[critic-r2b] {} ttl={}분 · {}분 일/{}분 주기(하루 일 {}분) → 24h 불사 위상 {}/{}",
                    s.id,
                    s.idle_ttl_ms / MIN,
                    d_min,
                    p_min,
                    work_per_day,
                    immortal,
                    p_min
                );
                if immortal > 0 {
                    bad.push(format!("{}:{}분/{}분주기={}／{}", s.id, d_min, p_min, immortal, p_min));
                }
            }
        }
        assert!(
            bad.is_empty(),
            "★쿼리가 24시간 동안 한 번도 없었는데 회수가 안 된 조합(위상 수/전체): {bad:?}"
        );
    }

    /// ★크리틱 R2-⑥ — **40분짜리 인덱싱이 진행 통지 간격 때문에 중간에 끊기는가.**
    ///
    /// 유예를 만든 명분이 「clangd가 UE를 40분 인덱싱하는 동안 회수 → 재스폰 방아」였다.
    /// 새 상한은 「5분간 진행 신호 없음」이므로 통지가 그보다 드문 구현은 **일하는 중에**
    /// 끊긴다. 배포되는 네 스펙 전부에 대해 간격을 훑어 그 경계를 잰다.
    ///
    /// `GRACE_STALL_MS`(5분)는 이 라운드가 **재지 않고 고른** 값이고, 실물 Roslyn·clangd의
    /// 진행 통지 간격은 이 기계에서 잴 수 없다(SDK 없음 — 빌더가 이월한 칸).
    #[test]
    fn critic_r2_a_forty_minute_index_is_cut_when_progress_is_sparse() {
        let mut cut: Vec<String> = Vec::new();
        for s in crate::spec::SPECS {
            for gap in [1u64, 2, 4, 5, 6, 10] {
                let mut l = Lifecycle::new(0);
                let mut now = 0u64;
                let mut at = None;
                while now < 40 * MIN {
                    now += MIN;
                    if now % (gap * MIN) == 0 {
                        l.saw_work(now);
                    }
                    if l.step(now, s.idle_ttl_ms, true) == Sweep::Reclaim {
                        at = Some(now / MIN);
                        break;
                    }
                }
                eprintln!(
                    "[critic-r2b] {} · 40분 인덱싱 · 진행 통지 {}분 간격 → 일하는 중 회수 {:?}분",
                    s.id, gap, at
                );
                if let Some(m) = at {
                    cut.push(format!("{}@{}분간격→{}분", s.id, gap, m));
                }
            }
        }
        assert!(cut.is_empty(), "★40분 인덱싱이 중간에 끊긴 조합: {cut:?}");
    }
