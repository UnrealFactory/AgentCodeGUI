//! 서버 하나의 **수명 상태 기계** — 유휴 회수 규칙 전부가 여기 있다.
//!
//! ## ★LSPIDLE R2 — 왜 파일이 새로 생겼나 (확인 크리틱 R1 §3 A급)
//!
//! R1은 규칙을 순수 함수 하나(`sweep_decision`)로 두고 **전이는 호출부**에 뒀다:
//!
//! ```text
//! if idle < ttl            { Keep }
//! if indexing && idle < CAP { Rewind }   // 호출부: Rewind => s.touch()
//! Reclaim
//! ```
//!
//! 크리틱이 실측으로 두 갈래를 갈랐고 **둘 다 맞다**:
//!
//! - **A-1 유예가 명분에 안 걸린다.** `Rewind`는 `ttl <= idle < CAP` 구간에서만 나는데
//!   `CAP = 30분`이고 **cs·cpp의 `idle_ttl_ms`가 정확히 30분**이다 → 구간이 **공집합**.
//!   유예를 만든 명분(clangd가 UE를 오래 인덱싱하는 동안 회수 → 재스폰 방아)이 정확히
//!   그 두 언어인데, 거기서 유예가 한 번도 안 났다.
//! - **A-2 상한이 실제 루프에서 안 뜬다.** 호출부의 `Rewind => s.touch()`가 `idle`을 **0으로
//!   되감으므로** `idle`은 다시 0부터 자란다 → `CAP`에 **닿을 수가 없다.** 「진행률 `end`를
//!   영영 안 보내는 서버가 영생한다」를 막겠다고 세운 상한이 그 상황에서 한 번도 안 뜬다.
//!
//! 근인은 값이 아니라 **의미론**이었다: 「유예」와 「그 유예의 상한」을 **같은 시계**(`idle_ms`)로
//! 쟀다. 그러면 한쪽을 되감는 순간 다른 쪽이 죽는다. 그래서 R2는 시계를 둘로 가른다.
//!
//! | 시계 | 무엇을 재나 | 누가 되감나 |
//! |---|---|---|
//! | `last_used_ms` | 마지막 **쿼리**(호버·정의·토큰·완성) 이후 | 사용자의 요청 · 유예가 끝나는 순간 한 번 |
//! | `last_work_ms` | 마지막으로 **일한다는 증거**(`$/progress` 등)를 본 이후 | **서버의 통지만**. 스윕은 절대 못 건드린다 |
//!
//! 상한이 「되감기와 무관한 절대 시계」가 되는 자리가 저 두 번째 줄이다.
//!
//! ## 규칙 (네 갈래)
//!
//! 1. **`Keep`** — TTL 전이다. 그대로 둔다.
//! 2. **`Rewind`** — TTL은 지났지만 **일하는 중**이다. 안 접는다.
//!    쿼리가 없다는 것과 노는 것은 다르다.
//! 3. **`Reclaim`** — TTL이 지났고 놀고 있다. 접는다.
//!    **일하는 중이라 해도** 진행 신호가 [`GRACE_STALL_MS`]만큼 멎었으면 여기로 온다
//!    (「일한다」가 말뿐인 서버가 유예로 영생하지 못하게 — A-2가 막으려던 그 자리).
//! 4. **`Settle`** — 유예 중이었는데 일이 **끝났다**. 접지 않고 **유휴 시계를 지금부터** 센다.
//!    일하는 동안은 서버를 쓸 수가 없었으므로 그 구간을 「안 쓴 시간」으로 세는 것이
//!    애초에 틀렸다. 이게 없으면 30분 인덱싱이 끝나는 **그 순간** 접힌다.
//!
//! ## ★판정과 전이를 한 함수에 묶은 이유
//!
//! 크리틱이 초록으로 통과시킨 돌연변이가 **`Sweep::Rewind => {}`**(호출부가 전이를 잊는다)였다.
//! R1 구조에서는 그게 잡히지 않는다 — 순수 함수에 합성 값을 먹이는 못은 「호출부가 전이를
//! 적용했는가」를 볼 수가 없기 때문이다.
//!
//! R2는 그 돌연변이를 **잡는** 대신 **쓸 수 없게** 만든다: [`Lifecycle::step`]이 판정을
//! 돌려주면서 전이까지 **스스로** 끝낸다. 호출부에는 잊을 수 있는 것이 남아 있지 않고
//! (`Reclaim`일 때 프로세스를 접는 일만 한다), 전이를 지우는 돌연변이는 이제 이 파일 안에
//! 있어야 하며 그 순간 아래 타임라인 못들이 붉어진다. 못을 하나 더 박는 것보다
//! **틀릴 수 있는 모양 자체를 없애는 편**이 낫다.

/// 스윕이 살아 있는 서버 하나에 내리는 판정.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Sweep {
    /// 아직 TTL 안 — 그대로 둔다.
    Keep,
    /// TTL은 지났지만 일하는 중 — 안 접는다(유예).
    Rewind,
    /// 유예 중이던 일이 끝났다 — 안 접고, 유휴 시계를 **지금부터** 다시 센다.
    Settle,
    /// 접는다.
    Reclaim,
}

/// 「일하는 중」이라고 말하면서 이만큼 **아무 진행 신호도 없으면** 그 말을 안 믿는다.
///
/// 값의 근거: 실제로 인덱싱하는 서버는 `$/progress`를 수 초 간격으로 쏟는다(clangd가
/// 그렇다). 5분 동안 한 톨도 없으면 그건 진행이 아니라 **멎은 것**이다.
///
/// R1의 `IDLE_GRACE_CAP_MS`(30분·`idle` 기준)를 대신한다. 그 값은 ① cs·cpp에서 TTL과 같아
/// 유예를 공집합으로 만들었고 ② 되감기 때문에 ts·py에서 영영 안 떴다(크리틱 A-1·A-2).
/// 이 값은 **되감기가 못 건드리는 시계**로 재므로 두 병이 같이 사라진다.
///
/// 그리고 이 눈금은 **진짜로 일하는 서버를 안 죽인다**: 30분이 걸리든 두 시간이 걸리든
/// 진행 신호가 흐르는 동안은 유예가 이어진다. R1의 절대 상한(30분)이었다면 UE 인덱싱을
/// 30분에 끊어 «막겠다던 그 방아»를 30분 늦춰 되살렸을 것이다.
pub const GRACE_STALL_MS: u64 = 5 * 60_000;

/// 서버 하나의 수명 시계들. **순수하다** — 프로세스도 진짜 시각도 안 만진다
/// (`now`는 늘 인자로 들어온다). 그래서 테스트가 타임라인을 통째로 돌릴 수 있다.
#[derive(Clone, Copy, Debug)]
pub struct Lifecycle {
    /// 마지막 쿼리 시각. TTL의 기준.
    last_used_ms: u64,
    /// 지금 유예가 시작된 시각(0 = 유예 중 아님). 진단·`Settle` 판정용.
    grace_since_ms: u64,
    /// 마지막으로 **일한다는 증거**를 본 시각. 스윕은 절대 안 건드린다(절대 시계).
    last_work_ms: u64,
}

impl Lifecycle {
    pub fn new(now: u64) -> Lifecycle {
        Lifecycle { last_used_ms: now, grace_since_ms: 0, last_work_ms: now }
    }

    /// 사용자의 실제 쿼리(호버·정의·토큰·완성). 상태 폴링은 **여기 안 온다**(C-1 ②).
    pub fn touch(&mut self, now: u64) {
        self.last_used_ms = now;
    }

    /// 서버가 **일하고 있다는 증거**를 보냈다(`$/progress` · 프로젝트 로드 완료 통지).
    /// 이 함수만이 멎음 시계를 되감을 수 있다.
    pub fn saw_work(&mut self, now: u64) {
        self.last_work_ms = now;
    }

    pub fn idle_ms(&self, now: u64) -> u64 {
        now.saturating_sub(self.last_used_ms)
    }

    /// 지금 유예 중인가(진단).
    pub fn in_grace(&self) -> bool {
        self.grace_since_ms != 0
    }

    /// 스윕 한 걸음 — **판정 + 전이**. 위 「규칙 (네 갈래)」 그대로다.
    pub fn step(&mut self, now: u64, ttl_ms: u64, indexing: bool) -> Sweep {
        if self.idle_ms(now) < ttl_ms {
            // 쿼리가 최근에 있었다 = 유예를 이어 갈 이유가 없다(스트릭 종료).
            self.grace_since_ms = 0;
            return Sweep::Keep;
        }
        if indexing {
            // ★상한: 「일한다」는 말이 **증거로 뒷받침되는 동안만** 믿는다.
            //   이 판정에 `idle`이 안 들어가는 것이 A-2의 고침이다.
            if now.saturating_sub(self.last_work_ms) >= GRACE_STALL_MS {
                return Sweep::Reclaim;
            }
            if self.grace_since_ms == 0 {
                self.grace_since_ms = now;
            }
            return Sweep::Rewind;
        }
        if self.grace_since_ms != 0 {
            // 일이 방금 끝났다 — 유휴 시계를 여기서 시작한다.
            self.grace_since_ms = 0;
            self.last_used_ms = now;
            return Sweep::Settle;
        }
        Sweep::Reclaim
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: u64 = 60_000;

    /// ★크리틱 A-1 — **유예가 모든 스펙에서 실제로 도달 가능한가.**
    ///
    /// R1에서는 `ttl == CAP == 30분`인 cs·cpp에서 `Rewind` 구간이 공집합이었다.
    /// 이 못은 스펙 값을 **그대로 읽어** 네 언어 전부에서 유예가 나는지 본다 —
    /// 합성 값이 아니라 배포되는 값으로.
    #[test]
    fn the_grace_is_reachable_for_every_shipped_spec() {
        for s in crate::spec::SPECS {
            let mut l = Lifecycle::new(0);
            // TTL을 막 넘긴 순간, 서버가 방금 진행 신호를 보냈다(= 진짜로 일하는 중)
            let now = s.idle_ttl_ms;
            l.saw_work(now);
            assert_eq!(
                l.step(now, s.idle_ttl_ms, true),
                Sweep::Rewind,
                "{}: TTL={}ms인데 유예가 안 난다 — 인덱싱 중 회수 → 재스폰 방아가 그대로 돈다 \
                 (크리틱 A-1이 cs·cpp에서 실측한 자리)",
                s.id,
                s.idle_ttl_ms
            );
            assert!(l.in_grace(), "{}: 유예 시작 시각이 안 남았다", s.id);
        }
    }

    /// ★크리틱 A-2 — **상한이 「실제 루프」에서 뜨는가.**
    ///
    /// 합성 `idle` 값을 먹이는 못은 이 결함을 못 봤다. 그래서 여기서는 **진짜 루프를 돌린다**:
    /// 60초마다 스윕이 오고, 서버는 계속 「일하는 중」이라 말하지만 진행 신호는 한 번도 안
    /// 보낸다. R1이라면 되감기 때문에 24시간을 돌려도 절대 안 접힌다.
    #[test]
    fn a_server_that_only_claims_to_work_is_reclaimed_by_the_stall_clock() {
        for s in crate::spec::SPECS {
            let mut l = Lifecycle::new(0);
            let mut now = 0u64;
            let mut verdict = None;
            // 24시간을 60초 간격으로 — R1은 여기서 None이었다
            for _ in 0..(24 * 60) {
                now += MIN;
                if l.step(now, s.idle_ttl_ms, true) == Sweep::Reclaim {
                    verdict = Some(now);
                    break;
                }
            }
            let at = verdict.unwrap_or_else(|| {
                panic!("{}: 「일하는 중」만 말하는 서버가 24시간 안에 안 접혔다 — 유예로 영생한다", s.id)
            });
            // TTL을 넘긴 뒤 멎음 눈금 안에 접혀야 한다(그 이상 끌면 상한이 헐거운 것이다)
            assert!(
                at <= s.idle_ttl_ms + GRACE_STALL_MS + MIN,
                "{}: {at}ms에 접혔다 — TTL({})+멎음({GRACE_STALL_MS})보다 한참 늦다",
                s.id,
                s.idle_ttl_ms
            );
        }
    }

    /// **진짜로 일하는 서버는 안 죽는다** — 상한이 「절대 시계」가 되면서 생길 수 있는
    /// 반대쪽 사고(오래 걸리는 인덱싱을 중간에 끊는다)를 막는 못.
    /// R1의 30분 절대 상한이었다면 이 타임라인은 30분에 끊겼다.
    #[test]
    fn a_genuinely_working_server_keeps_its_grace_for_hours() {
        let cpp = crate::spec::spec_by_id("cpp").unwrap();
        let mut l = Lifecycle::new(0);
        let mut now = 0u64;
        for _ in 0..(3 * 60) {
            now += MIN;
            l.saw_work(now); // clangd가 초 단위로 쏟는 `$/progress`
            assert_ne!(
                l.step(now, cpp.idle_ttl_ms, true),
                Sweep::Reclaim,
                "{now}ms에 접혔다 — 진행 신호가 흐르는데 끊었다(막겠다던 방아를 되살린 것이다)"
            );
        }
    }

    /// ★`Settle` — 유예 중이던 일이 끝나면 **그 순간 접히지 않고** 유휴 시계를 새로 센다.
    ///
    /// 이게 없으면 30분짜리 인덱싱이 끝나는 그 순간(사용자가 「분석 중 100%」를 보고 이제
    /// 쓰려는 바로 그때) 서버가 사라진다.
    #[test]
    fn finishing_the_work_restarts_the_idle_clock_instead_of_reclaiming() {
        let cpp = crate::spec::spec_by_id("cpp").unwrap();
        let ttl = cpp.idle_ttl_ms;
        let mut l = Lifecycle::new(0);
        let mut now = 0u64;
        // 40분 동안 인덱싱(TTL 30분을 넘긴다) — 유예로 살아남는다
        for _ in 0..40 {
            now += MIN;
            l.saw_work(now);
            l.step(now, ttl, true);
        }
        assert!(l.in_grace(), "40분 인덱싱 뒤에도 유예 중이어야 한다");
        // 인덱싱 끝 — 접히지 않고 유휴 시계가 리셋된다
        now += MIN;
        assert_eq!(l.step(now, ttl, false), Sweep::Settle, "★일이 끝나는 순간 접혔다");
        assert!(!l.in_grace());
        assert_eq!(l.idle_ms(now), 0, "유휴 시계가 안 리셋됐다");
        // 그 뒤로는 평범하게 TTL을 센다
        now += ttl - MIN;
        assert_eq!(l.step(now, ttl, false), Sweep::Keep, "리셋 직후 TTL 안인데 접으려 했다");
        now += MIN;
        assert_eq!(l.step(now, ttl, false), Sweep::Reclaim, "리셋 뒤 TTL이 지나면 접혀야 한다");
    }

    /// 평범한 갈래 — 일 안 하는 서버는 TTL에 정확히 접힌다(경계는 `>=`).
    #[test]
    fn an_idle_server_is_reclaimed_exactly_at_the_ttl() {
        let ttl = 10 * MIN;
        let mut l = Lifecycle::new(0);
        assert_eq!(l.step(ttl - 1, ttl, false), Sweep::Keep);
        assert_eq!(l.step(ttl, ttl, false), Sweep::Reclaim);
        // 쿼리가 오면 시계가 되감긴다
        let mut l = Lifecycle::new(0);
        l.touch(ttl - 1);
        assert_eq!(l.step(ttl, ttl, false), Sweep::Keep);
    }

    /// 쿼리가 오면 유예 스트릭이 끊긴다 — 다음 인덱싱은 새 유예를 받는다.
    #[test]
    fn a_query_ends_the_grace_streak() {
        let ttl = 10 * MIN;
        let mut l = Lifecycle::new(0);
        l.saw_work(ttl);
        assert_eq!(l.step(ttl, ttl, true), Sweep::Rewind);
        assert!(l.in_grace());
        l.touch(ttl + 1); // 사용자가 호버했다
        assert_eq!(l.step(ttl + 2, ttl, true), Sweep::Keep);
        assert!(!l.in_grace(), "쿼리가 왔는데 유예 스트릭이 안 끊겼다");
    }

    /// ★R1의 두 병이 **동시에** 사라졌는지 한 자리에서 본다(회귀 못).
    #[test]
    fn the_r1_pair_of_defects_cannot_come_back() {
        // A-1: 유예 구간이 TTL과 상한의 대소 관계에 **의존하지 않는다**.
        //      (R1은 `idle < CAP`이라 ttl >= CAP인 스펙에서 공집합이었다.)
        for ttl in [1 * MIN, 10 * MIN, 30 * MIN, 90 * MIN, GRACE_STALL_MS, GRACE_STALL_MS * 10] {
            let mut l = Lifecycle::new(0);
            l.saw_work(ttl);
            assert_eq!(l.step(ttl, ttl, true), Sweep::Rewind, "ttl={ttl}에서 유예가 공집합이다");
        }
        // A-2: 되감기(유예)가 **상한 시계를 못 건드린다**.
        //   TTL을 막 넘긴 순간에 마지막 진행 신호가 있었고, 그 뒤로는 서버가 「일하는 중」이라
        //   말만 한다. R1이라면 매 걸음의 `touch()`가 `idle`을 0으로 되감아 상한이 영영 안 떴다.
        let ttl = 10 * MIN;
        let mut l = Lifecycle::new(0);
        let mut now = ttl;
        l.saw_work(now);
        let mut rewinds = 0;
        loop {
            match l.step(now, ttl, true) {
                Sweep::Rewind => rewinds += 1,
                Sweep::Reclaim => break,
                other => panic!("예상 밖 판정 {other:?}"),
            }
            now += MIN;
            assert!(now < ttl + 60 * MIN, "상한이 안 뜬다 — A-2가 되살아났다");
        }
        assert!(rewinds > 0, "유예를 한 번도 안 받았다 — A-1 쪽이 깨졌다");
        // 멎음 시계는 **마지막 진행 신호**로부터 잰다 — 유예를 몇 번 받았든 무관하다.
        assert_eq!(now, ttl + GRACE_STALL_MS, "멎음 시계가 절대 시계가 아니다");
    }
}
