//! ★M11 — **한도 소진 시 노는 계정 자동 전환**의 판정식. 순수 함수 하나뿐이다.
//!
//! 사용자 문구: *"초기화 임박순으로 노는 계정을 자동 전환해 이어가기."*
//! 그 문장을 코드로 옮기면 규칙이 셋이다.
//!
//! | # | 규칙 | 왜 |
//! |---|---|---|
//! | ① | **노는 계정만** 후보 | 지금 다른 채팅이 태우고 있는 계정으로 옮기면 두 채팅이 한 창을 나눠 쓰다 둘 다 막힌다 |
//! | ② | **여유가 있어야** 후보 | 99% 계정으로 옮기면 스폰 한 번 태우고 같은 자리로 돌아온다(전환이 곧 낭비) |
//! | ③ | 그중 **초기화가 임박한 순서** | 곧 리셋될 창의 잔량은 **버려질 잔량**이다. 먼저 태우는 쪽이 총량에서 이득이고, 10분 뒤면 그 계정은 다시 가득 찬다 |
//!
//! 판정은 여기서 **전부** 끝난다(네트워크 없음 · 파일 없음). 조회·물질화는 셸이 하고,
//! 셸이 모아 온 값을 [`SwitchInput`]으로 넘기면 [`plan`]이 순위와 **탈락 사유**를 돌려준다.
//! 사유를 값으로 돌려주는 이유는 D7(침묵 금지)이다 — "왜 안 바뀌었나"에 답이 없으면
//! 사용자는 기능이 꺼진 줄 안다.
//!
//! **캐시 신선도의 함정**: `usage-cache.json`의 퍼센트는 조회 시점 값이다. 그 창의
//! `resetsAt`이 이미 지났으면 그 퍼센트는 **지난 창의 것**이라 지금과 무관하다 —
//! 100%로 굳은 낡은 값 하나가 멀쩡한 계정을 영원히 후보에서 지운다. 그래서
//! [`window_state`]는 지난 창을 `Rolled`(=모름)로 접는다.

use crate::usage::AccountUsage;
use crate::verify::PreflightVerdict;
use std::collections::{BTreeMap, BTreeSet};

/// 이 퍼센트 이상이면 그 창은 **다 쓴 것**으로 본다. API는 `utilization`을 0~100으로 주고
/// CLI는 100에서 막는다.
pub const EXHAUSTED_PCT: i64 = 100;

/// 후보가 되려면 **적어도 이만큼**은 남아 있어야 한다(퍼센트 포인트).
///
/// 왜 0이 아닌가: 전환 1회의 비용은 CLI 재스폰 + 정체성 리비전 + 배너 한 줄이다.
/// 99% 계정으로 옮기면 그 비용을 치르고 한 턴 만에 같은 자리로 돌아온다 — 그게
/// A→B→A 핑퐁의 씨앗이다(에피소드 제외 집합이 막긴 하지만, 애초에 안 고르는 게 낫다).
pub const MIN_HEADROOM_PCT: i64 = 5;

/// 창 하나의 지금 상태.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowState {
    /// 쓸 수 있다 — 남은 퍼센트 포인트.
    Free { left: i64, resets_at: Option<i64>, used: bool },
    /// 다 썼다(그리고 그 창은 아직 안 지났다).
    Exhausted { resets_at: Option<i64> },
    /// 값이 없거나, 있어도 **이미 지난 창의 값**이라 지금을 말하지 않는다.
    Rolled,
}

/// 퍼센트 + 리셋 시각 → [`WindowState`]. `now`는 unix 초.
pub fn window_state(pct: Option<i64>, resets_at: Option<i64>, now: i64) -> WindowState {
    // 리셋을 이미 지났다 = 이 값은 **지난 창**의 것이다(캐시가 낡은 그 경로).
    if resets_at.is_some_and(|r| r <= now) {
        return WindowState::Rolled;
    }
    let Some(p) = pct else { return WindowState::Rolled };
    let p = p.clamp(0, 100);
    if p >= EXHAUSTED_PCT {
        WindowState::Exhausted { resets_at }
    } else {
        WindowState::Free { left: 100 - p, resets_at, used: p > 0 }
    }
}

/// 계정 하나를 판정한 결과.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub email: String,
    /// **다음에 버려질 잔량의 시각**(unix 초) — *쓴 적이 있는* 창 중 가장 이른 리셋.
    /// 한 번도 안 쓴 계정은 버릴 잔량이 없으므로 `None`이고, 정렬에서 **뒤로** 간다.
    pub soonest_reset: Option<i64>,
    /// 가장 빡빡한 창의 남은 퍼센트 포인트(0~100). 클수록 여유롭다.
    pub headroom: i64,
    /// 스토어(=사용자가 드래그로 정한) 순서. 마지막 동점 처리 기준.
    pub order: usize,
}

/// 후보에서 빠진 이유. **화면 문구가 아니라 진단 어휘**다(리포트·`engine:debug`가 읽는다).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipWhy {
    /// 지금 이 채팅이 쓰고 있는 그 계정.
    Current,
    /// 다른 채팅이 지금 태우고 있다 = 놀고 있지 않다.
    Busy,
    /// 이 한도 에피소드에서 이미 옮겨가 봤다(A→B→A 금지).
    AlreadyTried,
    /// 한도 조회 결과가 아직 없다 — 증거 없이는 안 옮긴다(다음 틱에 다시 본다).
    UsageUnknown,
    /// 이 계정도 막혀 있다.
    Exhausted,
    /// 남았지만 [`MIN_HEADROOM_PCT`] 미만이다.
    NoHeadroom,
    /// **오염** — 같은 토큰이 다른 이메일로도 저장돼 있다(적용하면 계정이 되돌아간다).
    Contaminated,
    /// 재로그인 외에 길이 없다.
    NeedsLogin,
    /// 스토어·스냅샷이 깨졌다.
    Broken,
    /// 오염가드를 아직 안 돌렸다 — 셸이 preflight를 안 넣었다는 뜻이라 **버그 신호**다.
    NotChecked,
}

impl SkipWhy {
    pub fn wire(self) -> &'static str {
        match self {
            SkipWhy::Current => "current",
            SkipWhy::Busy => "busy",
            SkipWhy::AlreadyTried => "already_tried",
            SkipWhy::UsageUnknown => "usage_unknown",
            SkipWhy::Exhausted => "exhausted",
            SkipWhy::NoHeadroom => "no_headroom",
            SkipWhy::Contaminated => "contaminated",
            SkipWhy::NeedsLogin => "needs_login",
            SkipWhy::Broken => "broken",
            SkipWhy::NotChecked => "not_checked",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skipped {
    pub email: String,
    pub why: SkipWhy,
}

/// 셸이 모아 오는 판정 재료. 전부 빌린 값이라 이 구조체는 아무것도 소유하지 않는다.
#[derive(Debug, Clone, Copy)]
pub struct SwitchInput<'a> {
    /// unix **초**.
    pub now_epoch_secs: i64,
    /// 등록 계정 — `accounts.json`의 저장 순서 그대로(= 사용자가 정한 표시 순서).
    pub order: &'a [String],
    /// 지금 이 채팅이 쓰는 계정.
    pub current: &'a str,
    /// 이 실행이 Fable 창을 소비하는가. 아니면 Fable 창이 100%여도 상관없다
    /// (2.6.2 `blockedResetsAt`이 Fable 창을 Fable 실행만 게이트하는 규약과 같다).
    pub needs_fable: bool,
    /// 지금 **다른 채팅이 태우고 있는** 계정.
    pub busy: &'a BTreeSet<String>,
    /// 이 한도 에피소드에서 이미 거쳐 온 계정.
    pub tried: &'a BTreeSet<String>,
    pub usage: &'a BTreeMap<String, AccountUsage>,
    /// 오염가드 결과 — **없으면 후보가 아니다**([`SkipWhy::NotChecked`]).
    pub preflight: &'a BTreeMap<String, PreflightVerdict>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SwitchPlan {
    /// 순위대로 정렬된 후보. 첫 항목이 곧 [`SwitchPlan::pick`]이다.
    pub ranked: Vec<Candidate>,
    pub skipped: Vec<Skipped>,
}

impl SwitchPlan {
    pub fn pick(&self) -> Option<&Candidate> {
        self.ranked.first()
    }
}

/// 오염가드 판정 → 탈락 사유. `Probe`/`NeedsRefresh`는 통과다
/// (`NeedsRefresh` = 액세스 토큰만 만료 · 리프레시 재료가 있다 → 스폰하면 CLI가 갱신한다).
fn preflight_skip(v: Option<&PreflightVerdict>) -> Option<SkipWhy> {
    match v {
        Some(PreflightVerdict::Probe) | Some(PreflightVerdict::NeedsRefresh) => None,
        Some(PreflightVerdict::Contaminated(_)) => Some(SkipWhy::Contaminated),
        Some(PreflightVerdict::NeedsLogin) => Some(SkipWhy::NeedsLogin),
        Some(PreflightVerdict::Failed(_)) => Some(SkipWhy::Broken),
        None => Some(SkipWhy::NotChecked),
    }
}

/// 계정 목록 → 순위 + 탈락 사유. **이 함수가 M11의 판정 전부**다.
pub fn plan(inp: &SwitchInput) -> SwitchPlan {
    let mut out = SwitchPlan::default();
    for (i, email) in inp.order.iter().enumerate() {
        let skip = |w: SkipWhy| Skipped { email: email.clone(), why: w };
        if email == inp.current {
            out.skipped.push(skip(SkipWhy::Current));
            continue;
        }
        if inp.tried.contains(email) {
            out.skipped.push(skip(SkipWhy::AlreadyTried));
            continue;
        }
        if inp.busy.contains(email) {
            out.skipped.push(skip(SkipWhy::Busy));
            continue;
        }
        // 오염가드가 **한도 판정보다 먼저**다(verify::preflight 헤더와 같은 순서):
        // 오염 항목은 살아 있는 토큰을 물고 있어 한도 조회도 통과해 버린다.
        if let Some(w) = preflight_skip(inp.preflight.get(email)) {
            out.skipped.push(skip(w));
            continue;
        }
        let Some(u) = inp.usage.get(email) else {
            out.skipped.push(skip(SkipWhy::UsageUnknown));
            continue;
        };
        let now = inp.now_epoch_secs;
        let mut wins = vec![
            window_state(u.five_hour_pct, u.five_hour_resets_at, now),
            window_state(u.weekly_pct, u.weekly_resets_at, now),
        ];
        if inp.needs_fable {
            wins.push(window_state(u.fable_pct, u.fable_resets_at, now));
        }
        if wins.iter().any(|w| matches!(w, WindowState::Exhausted { .. })) {
            out.skipped.push(skip(SkipWhy::Exhausted));
            continue;
        }
        // 아는 창이 하나도 없다 = 조회는 됐는데 이 플랜에 창이 없다(= 제한 없음).
        // 그건 **여유 100%**로 읽는다(2.6.2도 없는 창을 게이트로 쓰지 않는다).
        let headroom = wins
            .iter()
            .filter_map(|w| match w {
                WindowState::Free { left, .. } => Some(*left),
                _ => None,
            })
            .min()
            .unwrap_or(100);
        if headroom < MIN_HEADROOM_PCT {
            out.skipped.push(skip(SkipWhy::NoHeadroom));
            continue;
        }
        // ③ **버려질 잔량의 시각** — 쓴 적 있는 창 중 가장 이른 리셋.
        let soonest_reset = wins
            .iter()
            .filter_map(|w| match w {
                WindowState::Free { resets_at, used: true, .. } => *resets_at,
                _ => None,
            })
            .min();
        out.ranked.push(Candidate { email: email.clone(), soonest_reset, headroom, order: i });
    }
    // 임박 → 여유 → 사용자 순서. `None`(버릴 잔량 없음)은 뒤로.
    out.ranked.sort_by(|a, b| {
        let key = |c: &Candidate| (c.soonest_reset.is_none(), c.soonest_reset.unwrap_or(i64::MAX));
        key(a)
            .cmp(&key(b))
            .then(b.headroom.cmp(&a.headroom))
            .then(a.order.cmp(&b.order))
    });
    out
}

/// 모델 별칭·와이어 id → **Fable 창을 소비하는가**. `usage.rs::find_fable_limit`과 같은
/// 판정 낱말(`fable`)을 쓴다 — 두 곳이 갈리면 Fable 채팅이 Fable 만석 계정으로 옮겨간다.
pub fn model_needs_fable(model: &str) -> bool {
    model.to_lowercase().contains("fable")
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000;

    fn u(email: &str, five: (Option<i64>, Option<i64>), week: (Option<i64>, Option<i64>)) -> AccountUsage {
        AccountUsage {
            email: email.into(),
            five_hour_pct: five.0,
            five_hour_resets_at: five.1,
            weekly_pct: week.0,
            weekly_resets_at: week.1,
            fable_pct: None,
            fable_resets_at: None,
        }
    }

    struct Fx {
        order: Vec<String>,
        usage: BTreeMap<String, AccountUsage>,
        preflight: BTreeMap<String, PreflightVerdict>,
        busy: BTreeSet<String>,
        tried: BTreeSet<String>,
    }
    impl Fx {
        fn new(emails: &[&str]) -> Fx {
            Fx {
                order: emails.iter().map(|s| s.to_string()).collect(),
                usage: BTreeMap::new(),
                preflight: emails.iter().map(|e| (e.to_string(), PreflightVerdict::Probe)).collect(),
                busy: BTreeSet::new(),
                tried: BTreeSet::new(),
            }
        }
        fn plan(&self, current: &str) -> SwitchPlan {
            plan(&SwitchInput {
                now_epoch_secs: NOW,
                order: &self.order,
                current,
                needs_fable: false,
                busy: &self.busy,
                tried: &self.tried,
                usage: &self.usage,
                preflight: &self.preflight,
            })
        }
        fn why(&self, p: &SwitchPlan, email: &str) -> Option<SkipWhy> {
            p.skipped.iter().find(|s| s.email == email).map(|s| s.why)
        }
    }

    /// ★ 핵심 규칙 — **초기화가 임박한 계정이 먼저**다.
    #[test]
    fn the_soonest_reset_wins() {
        let mut f = Fx::new(&["a@x", "b@x", "c@x"]);
        // b는 3시간 뒤 리셋, c는 30분 뒤 리셋 → c가 먼저(곧 버려질 잔량부터 태운다)
        f.usage.insert("b@x".into(), u("b@x", (Some(40), Some(NOW + 3 * 3600)), (Some(10), Some(NOW + 6 * 86400))));
        f.usage.insert("c@x".into(), u("c@x", (Some(60), Some(NOW + 1800)), (Some(20), Some(NOW + 6 * 86400))));
        let p = f.plan("a@x");
        assert_eq!(p.pick().map(|c| c.email.as_str()), Some("c@x"));
        assert_eq!(p.ranked.iter().map(|c| c.email.as_str()).collect::<Vec<_>>(), ["c@x", "b@x"]);
        assert_eq!(f.why(&p, "a@x"), Some(SkipWhy::Current));
    }

    /// 한 번도 안 쓴 계정은 **버릴 잔량이 없다** → 임박 계정 뒤로.
    #[test]
    fn a_never_used_account_ranks_last() {
        let mut f = Fx::new(&["a@x", "fresh@x", "soon@x"]);
        f.usage.insert("fresh@x".into(), u("fresh@x", (Some(0), None), (Some(0), None)));
        f.usage.insert("soon@x".into(), u("soon@x", (Some(70), Some(NOW + 600)), (Some(5), Some(NOW + 86400))));
        let p = f.plan("a@x");
        assert_eq!(p.ranked.iter().map(|c| c.email.as_str()).collect::<Vec<_>>(), ["soon@x", "fresh@x"]);
        assert_eq!(p.pick().unwrap().headroom, 30);
    }

    #[test]
    fn exhausted_busy_tried_and_thin_accounts_are_skipped() {
        let mut f = Fx::new(&["a@x", "full@x", "busy@x", "tried@x", "thin@x", "ok@x"]);
        f.usage.insert("full@x".into(), u("full@x", (Some(100), Some(NOW + 600)), (Some(9), None)));
        f.usage.insert("busy@x".into(), u("busy@x", (Some(1), Some(NOW + 600)), (Some(9), None)));
        f.usage.insert("tried@x".into(), u("tried@x", (Some(1), Some(NOW + 600)), (Some(9), None)));
        f.usage.insert("thin@x".into(), u("thin@x", (Some(97), Some(NOW + 600)), (Some(9), None)));
        f.usage.insert("ok@x".into(), u("ok@x", (Some(50), Some(NOW + 900)), (Some(9), None)));
        f.busy.insert("busy@x".into());
        f.tried.insert("tried@x".into());
        let p = f.plan("a@x");
        assert_eq!(p.pick().map(|c| c.email.as_str()), Some("ok@x"));
        assert_eq!(f.why(&p, "full@x"), Some(SkipWhy::Exhausted));
        assert_eq!(f.why(&p, "busy@x"), Some(SkipWhy::Busy));
        assert_eq!(f.why(&p, "tried@x"), Some(SkipWhy::AlreadyTried));
        assert_eq!(f.why(&p, "thin@x"), Some(SkipWhy::NoHeadroom));
    }

    /// 오염 계정은 **살아 있는 토큰**을 물고 있어 한도로는 안 걸러진다 — 오염가드가 먼저다.
    #[test]
    fn a_contaminated_account_is_skipped_even_though_its_usage_looks_free() {
        let mut f = Fx::new(&["a@x", "dirty@x", "ok@x"]);
        f.usage.insert("dirty@x".into(), u("dirty@x", (Some(0), Some(NOW + 60)), (Some(0), None)));
        f.usage.insert("ok@x".into(), u("ok@x", (Some(10), Some(NOW + 7200)), (Some(0), None)));
        f.preflight.insert("dirty@x".into(), PreflightVerdict::Contaminated("a@x".into()));
        let p = f.plan("a@x");
        // 임박 순서로는 dirty가 1등이지만(60초 뒤 리셋) 오염이라 못 쓴다.
        assert_eq!(p.pick().map(|c| c.email.as_str()), Some("ok@x"));
        assert_eq!(f.why(&p, "dirty@x"), Some(SkipWhy::Contaminated));
    }

    #[test]
    fn preflight_gaps_and_missing_usage_are_not_candidates() {
        let mut f = Fx::new(&["a@x", "nousage@x", "unchecked@x", "relogin@x"]);
        f.usage.insert("unchecked@x".into(), u("unchecked@x", (Some(0), None), (Some(0), None)));
        f.usage.insert("relogin@x".into(), u("relogin@x", (Some(0), None), (Some(0), None)));
        f.preflight.remove("unchecked@x");
        f.preflight.insert("relogin@x".into(), PreflightVerdict::NeedsLogin);
        let p = f.plan("a@x");
        assert!(p.pick().is_none(), "증거 없는 계정으로는 안 옮긴다");
        assert_eq!(f.why(&p, "nousage@x"), Some(SkipWhy::UsageUnknown));
        assert_eq!(f.why(&p, "unchecked@x"), Some(SkipWhy::NotChecked));
        assert_eq!(f.why(&p, "relogin@x"), Some(SkipWhy::NeedsLogin));
    }

    /// ★ 캐시 신선도 — **리셋을 지난 100%** 는 지난 창의 값이라 지금을 막지 않는다.
    #[test]
    fn a_stale_hundred_percent_past_its_reset_does_not_disqualify() {
        assert_eq!(window_state(Some(100), Some(NOW - 1), NOW), WindowState::Rolled);
        assert_eq!(window_state(Some(100), Some(NOW + 1), NOW), WindowState::Exhausted { resets_at: Some(NOW + 1) });
        let mut f = Fx::new(&["a@x", "stale@x"]);
        f.usage.insert("stale@x".into(), u("stale@x", (Some(100), Some(NOW - 600)), (Some(30), Some(NOW + 86400))));
        let p = f.plan("a@x");
        assert_eq!(p.pick().map(|c| c.email.as_str()), Some("stale@x"));
        // 5시간 창은 모름이라 여유 판정은 주간 창만 남는다(70).
        assert_eq!(p.pick().unwrap().headroom, 70);
    }

    /// Fable 창은 **Fable 실행만** 게이트한다.
    #[test]
    fn the_fable_window_only_gates_fable_runs() {
        let mut f = Fx::new(&["a@x", "b@x"]);
        let mut acct = u("b@x", (Some(10), Some(NOW + 600)), (Some(10), Some(NOW + 86400)));
        acct.fable_pct = Some(100);
        acct.fable_resets_at = Some(NOW + 86400);
        f.usage.insert("b@x".into(), acct);
        let base = SwitchInput {
            now_epoch_secs: NOW,
            order: &f.order,
            current: "a@x",
            needs_fable: false,
            busy: &f.busy,
            tried: &f.tried,
            usage: &f.usage,
            preflight: &f.preflight,
        };
        assert_eq!(plan(&base).pick().map(|c| c.email.clone()), Some("b@x".into()));
        let fable = SwitchInput { needs_fable: true, ..base };
        assert!(plan(&fable).pick().is_none(), "Fable 실행은 Fable 만석 계정으로 못 간다");
        assert!(model_needs_fable("claude-fable-5") && !model_needs_fable("haiku"));
    }

    /// 동점(같은 리셋 시각)이면 **여유가 큰 쪽**, 그다음 사용자가 정한 순서.
    #[test]
    fn ties_break_on_headroom_then_store_order() {
        let mut f = Fx::new(&["a@x", "b@x", "c@x", "d@x"]);
        let r = NOW + 1200;
        f.usage.insert("b@x".into(), u("b@x", (Some(80), Some(r)), (Some(0), None)));
        f.usage.insert("c@x".into(), u("c@x", (Some(20), Some(r)), (Some(0), None)));
        f.usage.insert("d@x".into(), u("d@x", (Some(20), Some(r)), (Some(0), None)));
        let p = f.plan("a@x");
        assert_eq!(p.ranked.iter().map(|c| c.email.as_str()).collect::<Vec<_>>(), ["c@x", "d@x", "b@x"]);
    }

    /// 계정이 하나뿐이면 후보가 없다 — 기존 대기표 경로 그대로다.
    #[test]
    fn a_single_account_yields_no_candidate() {
        let f = Fx::new(&["a@x"]);
        let p = f.plan("a@x");
        assert!(p.pick().is_none());
        assert_eq!(p.skipped.len(), 1);
    }
}
