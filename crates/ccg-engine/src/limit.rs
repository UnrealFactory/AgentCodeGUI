//! 한도 판정 — 2.6.2 `src/renderer/src/lib/limitResume.ts`의 Rust 이식.
//!
//! **왜 모듈 하나로 뺐나**: R14 확인 크리틱 F1이 잡은 것은 "이식했다"고 적힌 주석 옆에
//! 원본에 없는 가지(`rate limit`·맨 `한도`)가 자라고 원본에 있던 **차단벽**
//! (`/context|token|output|length/`)이 빠져 있던 것이다. 원본과 한 줄씩 마주 볼 수 있는
//! 자리를 만들어 두면 다음 사람이 가지를 더할 때 무엇을 깨는지 보인다.
//!
//! 원본이 주석에 남긴 판단이 이식의 계약이다:
//! *"오탐으로 남의 에러를 조용히 재전송하는 쪽이 놓침(사용자가 직접 재전송)보다 훨씬 나쁘다."*
//!
//! 골든: `scripts/poc-limit-resume.mjs` A절(HITS 9 · MISSES 9) —
//! `tests/r14_limit_parity.rs`가 같은 코퍼스를 이 함수에 그대로 먹인다.

use crate::clock::{Millis, HOUR, MIN, SEC};
use crate::identity::BillingAxis;

// ── 2.6.2 상수(limitResume.ts:85-87) ────────────────────────────────────────

/// 리셋 시각 미상일 때의 재확인 간격 — 2.6.2 `PROBE_MS`.
///
/// 2.6.2에서 이 간격의 비용은 **usage 조회 1회**였다(공짜에 가깝다). 3.0 엔진에는 아직
/// 그 조회가 없어서(=[`LimitProbe`] 미배선) 같은 간격이 **CLI 턴 1회**를 태운다 —
/// 그래서 [`MAX_AUTO_ATTEMPTS`]와 지수 백오프가 함께 붙는다.
pub const PROBE: Millis = 10 * MIN;

/// 리셋 시각 뒤 여유 — 2.6.2 `RESET_GRACE_MS`. 서버 쪽 창 전환 반영 지연을 흡수한다
/// (일찍 쏘면 또 막혀 에러만 쌓인다).
pub const GRACE: Millis = 90 * SEC;

/// 발화 지연 하한 — 2.6.2 `resumeDelayMs`의 `Math.max(15_000, …)`.
pub const MIN_DELAY: Millis = 15 * SEC;

// ── 3.0 로컬 안전장치(2.6.2에 없다 — 재검증 훅이 미배선인 동안의 대역) ──────

/// **눈감고 쏘는 재개**의 상한. 이 횟수를 넘기면 자동을 멈추고 `ready`만 켠 채 사용자에게
/// 넘긴다(스펙 ⑤의 "눌러서 이어가기"와 같은 착지점).
///
/// 왜 필요한가(R14 F2): 재개 턴이 **같은 한도 에러로 또 죽으면** 그것이 곧 "아직 안
/// 풀렸다"는 신선한 증거다. 그런데도 계속 쏘면 5시간 창 하나에 CLI를 ~46회 띄우고
/// 스레드에 「이어서 진행해 주세요」와 오류 말풍선을 한 쌍씩 쌓는다.
pub const MAX_AUTO_ATTEMPTS: u32 = 2;

/// 시각 미상 대기의 지수 백오프 상한.
pub const BACKOFF_CAP: Millis = 60 * MIN;

/// 파싱된 리셋 시각을 믿어 주는 최대 거리. 사용자의 시계가 어긋나 있거나 문구가 오염되면
/// 대기표가 몇 년 뒤에 앉아 **영원히 안 풀리는 표**가 된다 — 주간 창(7일)까지만 믿는다.
pub const MAX_WAIT: Millis = 7 * 24 * HOUR;

/// 시각 미상일 때의 대기 — `PROBE`에서 시작해 헛 재개마다 2배, [`BACKOFF_CAP`]에서 멈춘다.
pub fn unknown_wait(attempts: u32) -> Millis {
    PROBE.saturating_mul(1u64 << attempts.min(16)).min(BACKOFF_CAP)
}

// ── 문구 판정 ───────────────────────────────────────────────────────────────

/// 2.6.2 `LimitHit`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct LimitHit {
    pub hit: bool,
    /// 에러 원문 꼬리(`…|1755150000`)에서 읽은 **unix 초**. 런타임 시계(단조 ms)와는
    /// 다른 축이라 [`crate::runtime::ChatRuntime`]이 [`crate::clock::Clock::now_epoch_ms`]로
    /// 옮긴 뒤에 쓴다.
    pub resets_at: Option<u64>,
}

/// 2.6.2 `parseEpoch` — `/\|(\d{10})(?:\D|$)/` 뒤 `v > 1e9 && v < 1e10`.
///
/// 정규식이 없는 판이라 손으로 푼다: `|` 바로 뒤가 **정확히 10자리**여야 하고(11자리째가
/// 숫자면 그 자리는 실패), 값은 10자리 범위 안이어야 한다.
fn parse_epoch(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    for (i, c) in b.iter().enumerate() {
        if *c != b'|' {
            continue;
        }
        let d = &b[i + 1..];
        if d.len() < 10 || !d[..10].iter().all(u8::is_ascii_digit) {
            continue;
        }
        // `(?:\D|$)` — 11자리째가 숫자면 이 자리는 매치가 아니다(`\d{10}`은 고정 횟수).
        if d.get(10).is_some_and(u8::is_ascii_digit) {
            continue;
        }
        let v: u64 = std::str::from_utf8(&d[..10]).ok()?.parse().ok()?;
        // 2.6.2: `v > 1e9 && v < 1e10` (10자리라 상한은 항상 참)
        if v > 1_000_000_000 {
            return Some(v);
        }
    }
    None
}

/// `/(?:\d+[ -]hour|five[ -]hour|weekly|session|daily) limit reached/i`
fn banner_limit_reached(t: &str) -> bool {
    for (i, _) in t.match_indices("limit reached") {
        let Some(head) = t[..i].strip_suffix(' ') else { continue };
        if head.ends_with("weekly") || head.ends_with("session") || head.ends_with("daily") {
            return true;
        }
        let Some(h) = head.strip_suffix("hour") else { continue };
        let Some(h) = h.strip_suffix(' ').or_else(|| h.strip_suffix('-')) else { continue };
        if h.ends_with("five") || h.as_bytes().last().is_some_and(u8::is_ascii_digit) {
            return true;
        }
    }
    false
}

/// `/(?:hit|reached) your [^.\n]{0,24}limit/i`
fn your_limit(t: &str) -> bool {
    for kw in ["hit your ", "reached your "] {
        let mut from = 0usize;
        while let Some(rel) = t[from..].find(kw) {
            let start = from + rel + kw.len();
            let rest = &t[start..];
            let mut used = 0usize; // `[^.\n]{0,24}`가 먹은 글자 수
            let mut at = 0usize; // rest 안의 바이트 위치
            loop {
                if rest[at..].starts_with("limit") {
                    return true;
                }
                if used == 24 {
                    break;
                }
                match rest[at..].chars().next() {
                    Some(c) if c != '.' && c != '\n' => {
                        at += c.len_utf8();
                        used += 1;
                    }
                    _ => break,
                }
            }
            from = start;
        }
    }
    false
}

/// `/limit reached\|\d{9,}/i`
fn limit_reached_with_tail(t: &str) -> bool {
    t.match_indices("limit reached|").any(|(i, m)| {
        t.as_bytes()[i + m.len()..]
            .iter()
            .take_while(|c| c.is_ascii_digit())
            .count()
            >= 9
    })
}

/// 턴을 죽인 에러 문구가 **"구독 사용 한도 소진"** 인지 판별한다
/// (2.6.2 `classifyLimitError` — `limitResume.ts:38`의 전 분기 이식).
///
/// 분기 순서가 곧 계약이다:
///
/// | # | 원본 | 여기 |
/// |---|---|---|
/// | 0 | `if (!s) return miss` | 빈 문자열 |
/// | 1 | `/usage limit/i` → **확정 hit** | [`Self`] 첫 분기 |
/// | 2 | `/context\|token\|output\|length/i` → **확정 miss** | ★ **오탐 차단벽** — R14 F1이 잡은 그 빠진 줄 |
/// | 3 | 배너형 `(\d+\|five)[ -]hour\|weekly\|session\|daily limit reached` | [`banner_limit_reached`] |
/// | 4 | `(hit\|reached) your …limit` | [`your_limit`] |
/// | 5 | `limit reached\|\d{9,}` | [`limit_reached_with_tail`] |
///
/// **2.6.2에 없어서 뺀 것**(R14 F1의 오탐 3종 중 둘): `rate limit` — 원본 주석이
/// *"일시 과부하는 CLI가 자체 재시도하므로 잡지 않는다"*고 명시한 부류다. 그리고 맨
/// `한도` 부분일치 — `컨텍스트 한도`·`출력 토큰 한도`까지 삼켰다. 한국어 문구는 2번
/// 차단벽의 한국어 짝을 통과한 뒤 **`사용 한도`(=`usage limit`의 직역)만** 받는다.
pub fn classify_limit_error(text: &str) -> LimitHit {
    let miss = LimitHit { hit: false, resets_at: None };
    if text.is_empty() {
        return miss;
    }
    let t = text.to_lowercase();
    // ① 명시적 "usage limit" — 다른 단어가 섞여 있어도 확정(claude/codex 공통 문구)
    if t.contains("usage limit") {
        return LimitHit { hit: true, resets_at: parse_epoch(text) };
    }
    // ② 컨텍스트·토큰·출력 한도 계열은 전부 비한도 — 아래 관대한 패턴의 오탐 차단벽
    if ["context", "token", "output", "length"].iter().any(|k| t.contains(k))
        || ["컨텍스트", "토큰", "출력", "길이"].iter().any(|k| t.contains(k))
    {
        return miss;
    }
    // ①' 한국어 짝 — 차단벽 **뒤에** 둔다(`컨텍스트 한도`가 여기 닿지 않게)
    let hit = t.contains("사용 한도")
        || banner_limit_reached(&t)
        || your_limit(&t)
        || limit_reached_with_tail(&t);
    LimitHit { hit, resets_at: if hit { parse_epoch(text) } else { None } }
}

/// [`classify_limit_error`]의 불리언 얼굴. 크리틱 하네스(`r14_limit_parity`)가 부르는 이름이다.
pub fn is_limit_error(text: &str) -> bool {
    classify_limit_error(text).hit
}

// ── 발화 재검증 훅 ──────────────────────────────────────────────────────────

/// 신선 usage 재검증의 결과 — 2.6.2 `useLimitResume.fire()`가 `blockedResetsAt`으로 얻던 값.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LimitVerdict {
    /// 아직 막혀 있다. `resets_at`은 **막는 창 중 가장 늦은 해제 시각**(unix 초),
    /// 모르면 `None`(2.6.2 `blockedResetsAt`이 `resetsAt` 없는 창을 거르는 것과 같은 자리).
    Blocked { resets_at: Option<u64> },
    /// 풀렸다 — 발화해도 된다.
    Clear,
    /// 조회 실패 · 훅 미배선. 2.6.2 `fire()`의 `catch`와 같이 **풀린 것으로 두고 진행**하되,
    /// 그 관대함의 대가는 [`MAX_AUTO_ATTEMPTS`]가 치른다.
    Unknown,
}

/// **발화 직전 신선 usage 재검증** — 2.6.2 `useLimitResume.fire()`의 훅 자리.
///
/// > *"장전 시점 판단을 믿지 않고 신선 usage로 재검증한다. 아직 막혀 있으면 그 해제
/// >  시각으로 재장전, 풀렸으면 ready 표시만."* (`useLimitResume.ts:118-145`)
///
/// 엔진에는 네트워크가 없다(시계와 같은 이유로 주입한다). 실제 조회는 셸이 `ccg-auth`의
/// `usage::usage_request` + `usage::parse_usage_info`로 하고, 그 결과를 `blockedResetsAt`
/// 규칙(소진 창 중 가장 늦은 시각 · Fable 창은 Fable 실행만 게이트)으로 접어 이 값으로
/// 돌려준다. **아직 그 HTTP 실행기가 없다** — 그동안은 훅이 비어 있고(=`Unknown`과 같다)
/// [`MAX_AUTO_ATTEMPTS`]·[`unknown_wait`]이 스팸을 막는다.
pub trait LimitProbe: Send + Sync {
    fn blocked_until(&self, account: &BillingAxis, now_epoch_ms: u64) -> LimitVerdict;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_epoch_wants_exactly_ten_digits() {
        assert_eq!(parse_epoch("Claude AI usage limit reached|1755150000"), Some(1_755_150_000));
        assert_eq!(parse_epoch("x|1799999999 tail"), Some(1_799_999_999));
        // 11자리 — `\d{10}` 뒤가 숫자라 매치가 아니다
        assert_eq!(parse_epoch("x|17551500001"), None);
        // 9자리 · 파이프 없음 · 1e9 이하
        assert_eq!(parse_epoch("x|175515000"), None);
        assert_eq!(parse_epoch("1755150000"), None);
        assert_eq!(parse_epoch("x|1000000000"), None);
    }

    #[test]
    fn unknown_wait_backs_off_and_caps() {
        assert_eq!(unknown_wait(0), PROBE);
        assert_eq!(unknown_wait(1), 2 * PROBE);
        assert_eq!(unknown_wait(2), 4 * PROBE);
        assert_eq!(unknown_wait(9), BACKOFF_CAP);
    }

    /// 한국어 가지는 **차단벽 뒤**에 있다 — 이게 R14 F1이 잡은 맨 `한도` 부분일치의 교훈이다.
    #[test]
    fn korean_context_limits_are_not_usage_limits() {
        assert!(!is_limit_error("컨텍스트 한도를 초과했습니다"));
        assert!(!is_limit_error("출력 토큰 한도 초과"));
        assert!(!is_limit_error("입력 길이 한도"));
        assert!(is_limit_error("사용 한도에 도달했어요"));
    }
}
