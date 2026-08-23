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
use std::sync::Arc;

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

// ── ★M11 자동 계정 전환 훅 ──────────────────────────────────────────────────

/// **한도 소진 시 노는 계정으로 갈아타기**(3.0.0 신기능 3 — 설정 옵션, 기본 꺼짐).
///
/// 훅으로 두는 이유는 [`LimitProbe`]와 같다: 후보 판정에는 계정 스토어(복호화)·
/// `usage-cache.json`·오염가드·네트워크가 필요한데 **엔진에는 그 어느 것도 없다**.
/// 판정식 자체는 `ccg-auth::switch::plan`(순수 함수)에 있고, 셸이 재료를 모아 그
/// 함수를 부른 결과를 이 훅으로 돌려준다. 그래서 재생 하네스는 대본으로 이 훅을
/// 흉내 내 **전 조합**(후보 있음/없음/오염 스킵/연속 소진/설정 꺼짐)을 돌릴 수 있다.
///
/// 안 꽂으면 언제나 `None`이고, 그때 동작은 이 기능이 없던 판과 **한 글자도 다르지 않다**
/// (대기표 → 재검증 → 이어서). 설정이 꺼져 있을 때 셸이 내는 값도 `None`이다.
pub trait AccountSwitcher: Send + Sync {
    fn pick(&self, req: &SwitchRequest) -> Option<SwitchPick>;

    /// **아직 모른다**(= 셸이 조회를 걸었고 곧 답이 온다)인가.
    ///
    /// [`Self::pick`]의 `None`에는 두 뜻이 섞여 있다: *"갈 데가 없다"* 와 *"아직 안
    /// 물어봤다"*. 화면에서는 그 둘이 다른 문장이다 — 전자는 "풀릴 때까지 기다립니다"이고
    /// 후자에 그 문장을 쓰면 **1초 뒤 계정을 갈아타면서 방금 한 말을 뒤집는다**(R1 실물
    /// 주행에서 실제로 두 줄이 연달아 떴다). 그래서 대기 문장을 한 tick 미룰지 여부만
    /// 이 값으로 가른다. 기본 `false` = 미배선 훅은 옛 동작 그대로.
    fn pending(&self) -> bool {
        false
    }
}

/// 훅에 넘기는 질문. **엔진이 아는 것만** 담는다 — 계정 목록·한도·오염은 셸의 몫이다.
#[derive(Debug, Clone, Copy)]
pub struct SwitchRequest<'a> {
    pub chat_id: &'a str,
    /// 지금 이 채팅의 과금 축. 구독이 아니면 셸은 `None`을 돌려줘야 한다
    /// (API 키 실행에는 갈아탈 "계정"이 없다).
    pub current: &'a BillingAxis,
    /// 지금 정체성의 모델 — Fable 창을 소비하는지 가르는 재료.
    pub model: &'a str,
    /// 이 한도 에피소드에서 **이미 거쳐 온** 계정(A→B→A 핑퐁 금지).
    pub tried: &'a std::collections::BTreeSet<String>,
    pub now_epoch_ms: u64,
}

// ── ★M11 R2(C2) 후보 예약 장부 ──────────────────────────────────────────────

/// 예약의 수명(ms). 갈아탄 채팅이 새 계정으로 **스폰을 끝내면** 그때부터는 셸의
/// `busy`가 같은 사실을 말한다 — 그 사이를 메우는 시간이라 길 필요가 없다.
pub const TAKEN_TTL_MS: u64 = 60_000;

/// **방금 어느 채팅이 어느 계정을 집었나.** [`AccountSwitcher`] 훅 하나를 나눠 쓰는
/// 채팅들이 공유한다([`ledger_for`]).
///
/// ## 왜 엔진에 있나 (R1 크리틱 C2 — 스탬피드)
///
/// 셸의 `busy`("지금 CLI가 살아 있는 채팅의 계정")는 **스폰이 끝나야** 참이 된다.
/// 그런데 전환은 정체성만 바꾸고 스폰은 다음 tick이다. 워커의 한도 스냅샷이 도착하는
/// 순간 대기하던 채팅 N개가 **동시에** 열리면, 전원이 같은 순위표를 보고 같은 1등을
/// 집는다 — 그리고 둘이 한 5시간 창을 나눠 쓰다 **둘 다** 막힌다(규칙 ①이 막으려던
/// 바로 그 상태다).
///
/// *"방금 누가 무엇을 집었다"* 를 아는 자리는 **전환을 실행하는 코드**뿐이다. 그래서
/// 장부가 여기 있다: 훅이 예약을 알든 모르든(셸의 `Switcher`는 알고, 스텁·구형 훅은
/// 모른다) 엔진이 같은 계정을 두 번 내주지 않는다.
#[derive(Default)]
pub struct SwitchLedger {
    taken: std::sync::Mutex<std::collections::BTreeMap<String, (String, u64)>>,
}

impl SwitchLedger {
    /// 집었다 — `now_epoch_ms`부터 [`TAKEN_TTL_MS`] 동안 다른 채팅에게는 "안 노는 계정"이다.
    pub fn take(&self, chat_id: &str, account: &str, now_epoch_ms: u64) {
        let mut g = self.taken.lock().unwrap_or_else(|e| e.into_inner());
        g.retain(|_, (_, at)| now_epoch_ms.saturating_sub(*at) < TAKEN_TTL_MS);
        g.insert(account.to_string(), (chat_id.to_string(), now_epoch_ms));
    }

    /// **다른** 채팅이 방금 집었나. 자기가 집은 것은 막지 않는다(재시도가 자기 예약에
    /// 걸리면 그 채팅은 영영 못 옮긴다).
    pub fn taken_by_other(&self, chat_id: &str, account: &str, now_epoch_ms: u64) -> bool {
        let g = self.taken.lock().unwrap_or_else(|e| e.into_inner());
        g.get(account)
            .is_some_and(|(who, at)| who != chat_id && now_epoch_ms.saturating_sub(*at) < TAKEN_TTL_MS)
    }
}

/// 훅 → 장부. **같은 `Arc`를 나눠 가진 채팅들만** 같은 장부를 본다.
///
/// 전역 하나가 아니라 훅마다인 이유: 재생 하네스는 테스트마다 훅을 새로 만든다.
/// 전역이면 병렬로 도는 다른 재생의 예약이 이 재생의 후보를 지운다(계정 이름이 같다).
/// 죽은 훅은 매번 걷어낸다 — 그래서 주소가 재사용돼도 남의 장부를 물려받지 않는다
/// (`strong_count() == 0`인 항목을 **비교 전에** 지운다).
pub fn ledger_for(hook: &Arc<dyn AccountSwitcher>) -> Arc<SwitchLedger> {
    type Reg = Vec<(std::sync::Weak<dyn AccountSwitcher>, Arc<SwitchLedger>)>;
    static REG: std::sync::Mutex<Reg> = std::sync::Mutex::new(Vec::new());
    let key = Arc::as_ptr(hook) as *const ();
    let mut g = REG.lock().unwrap_or_else(|e| e.into_inner());
    g.retain(|(w, _)| w.strong_count() > 0);
    if let Some((_, l)) = g.iter().find(|(w, _)| w.as_ptr() as *const () == key) {
        return l.clone();
    }
    let l = Arc::new(SwitchLedger::default());
    g.push((Arc::downgrade(hook), l.clone()));
    l
}

/// 훅의 답 — "이 계정으로 갈아타라".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SwitchPick {
    pub account: crate::identity::AccountEmail,
    /// 그 계정에서 **가장 먼저 초기화될 창**(unix 초). 배너 문장의 재료이자
    /// "왜 이 계정인가"의 근거다. 모르면 `None`.
    pub soonest_reset: Option<u64>,
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
