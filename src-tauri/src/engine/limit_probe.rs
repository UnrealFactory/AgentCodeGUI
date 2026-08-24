//! ★T3T4 R3 셸 — **한도 재검증 훅**([`ccg_engine::limit::LimitProbe`])의 재료 수집기.
//!
//! ## 무엇이 비어 있었나 (R28 확인 크리틱 R2의 최대 격차)
//!
//! 2.6.2의 「한도 자동 이어서」에는 2단 재검증이 있다: 리셋 시각이 되면 **발화 직전에**
//! 신선 usage를 다시 물어보고, 아직 막혀 있으면 CLI를 안 띄우고 재장전한다
//! (`useLimitResume.ts` `fire()`). 3.0에서 그 기계는 두 벌이 됐고 —
//!
//! | 표면 | 재개 주체 | 재검증 |
//! |---|---|---|
//! | 추가 채팅 · 멀티 패널(비관리) | 렌더러 `useLimitResume` | `usage:get` 실측 |
//! | **본채팅** | 엔진 `check_hold` | ★ **없었다**(`NoProbe` = 「풀린 것으로 두고 진행」) |
//!
//! — 실앱의 본채팅은 `lite.rs`가 `resumeOwner:"engine"`을 늘 실어 보내므로 **아래쪽 줄만**
//! 돈다. 즉 R2가 렌더러에서 고친 「조회 실패 = 풀림」 오판이, 정작 사용자가 가장 많이
//! 쓰는 표면에는 한 글자도 안 걸려 있었다(크리틱 실측: 대기표를 심고 92초 관찰 →
//! 렌더러 사본은 접히고, 남은 것은 재검증 없는 엔진의 표).
//!
//! 이 파일이 그 자리를 채운다. 엔진은 훅 하나만 들고 있고(네트워크가 없다 — 재생
//! 하네스가 97개 시나리오를 0ms에 도는 이유가 그것이다) 재료는 여기서 모은다.
//!
//! ```text
//!   [허브 스레드]  rt.tick() → check_hold → probe.blocked_until_for()  ← **절대 막히면 안 된다**
//!         │                                     │
//!         │                          메모리 캐시만 엿보고 즉시 답한다
//!         │                                     │ 없으면 워커를 깨우고 Unavailable
//!         ▼                                     ▼
//!   [워커 스레드 1개]  ipc::parity::usage::usage_get(fresh) → 같은 캐시에 적재
//! ```
//!
//! ## 왜 워커가 따로 있나 (`acct_switch.rs`와 같은 이유)
//!
//! `blocked_until_for`는 허브 스레드에서 불린다. 그 스레드는 모든 채팅의 tick을 돌고
//! 20ms마다 프레임을 옮긴다. 거기서 `usage_get`을 부르면 만료 토큰의 **리프레시 교환
//! POST** + 전역 1.2초 게이트 + 429면 최대 30초를 **스레드째** 잔다 — 그동안 다른
//! 대화의 스트리밍이 통째로 멈춘다. 그래서 이 훅은 절대 I/O를 하지 않는다.
//!
//! ## 예산 규율 (실계정 HTTP)
//!
//! | 문 | 무엇 |
//! |---|---|
//! | ① 대기표가 있을 때만 | `check_hold`의 `due`가 참일 때만 불린다 = 한도에 걸린 채팅만 |
//! | ② 같은 캐시 | 워크바 게이지·설정 화면과 **한 벌**을 쓴다(`parity::usage`의 메모리 캐시) |
//! | ③ 엿보기 TTL | [`PEEK_TTL_MS`] 안쪽 값은 조회 없이 그대로 판정한다 |
//! | ④ 쿨다운 | 같은 계정은 [`FETCH_COOLDOWN`] 안에 두 번 안 묻는다 |
//! | ⑤ `CCG_NO_NET=1` | `ccg_auth::net`이 전 호출을 즉시 거절 — 하네스의 킬 스위치 |
//!
//! **부팅 프리웜은 없다.** 앱을 켜는 것만으로 계정 usage를 묻지 않는다(M11 R2 C1이
//! 걷어낸 그 동작이다 — 리프레시 토큰 회전은 되돌릴 수 없는 부작용이다).

use ccg_engine::identity::{BillingAxis, EngineKind};
use ccg_engine::limit::{LimitProbe, LimitVerdict, ProbeQuery};
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 엿보기가 값을 신선하다고 보는 창(ms).
///
/// `usage_get(fresh)`의 15초보다 넉넉한 이유: 재확인 간격이 15초(→30→60…)라
/// TTL을 15초로 맞추면 **매 재확인이 경계에 걸려** 적중과 실패가 진동한다. 45초면
/// 워커가 채운 값이 다음 두 번의 재확인까지 살아 있다.
const PEEK_TTL_MS: u64 = 45_000;

/// 같은 계정을 다시 묻기까지의 최소 간격(문 ④).
const FETCH_COOLDOWN: Duration = Duration::from_secs(10);

/// 이식본 `blockedResetsAt(u, fable, nowSec + 60)`의 그 **+60초**.
/// 1분 안에 풀릴 창은 풀린 셈으로 본다 — 경계에서 재장전이 진동하지 않게.
const EDGE_SEC: i64 = 60;

/// 같은 codex 계정에 app-server를 다시 띄우기까지의 최소 간격.
///
/// 클로드 쪽([`FETCH_COOLDOWN`])보다 긴 이유는 **한 번의 값이 프로세스 하나**이기
/// 때문이다(≈0.7초). 재확인 사다리(15·30·60·120·240초)와 [`PEEK_TTL_MS`] 45초를 함께
/// 보면, 이 값이면 대기 중인 Codex 채팅 하나가 분당 app-server를 두 번 넘게 띄우지 않는다.
const CODEX_FETCH_COOLDOWN: Duration = Duration::from_secs(20);

/// 진단 계수기 — `engine:debug`의 `limitProbe`로 나간다. 침묵 금지(D7)는 하네스에도
/// 적용된다: "왜 안 쐈나 / 왜 쐈나"에 답할 숫자가 없으면 이 기능은 검증 불가능해진다.
#[derive(Default, Clone, Copy)]
pub struct Stats {
    /// 엔진이 물어본 횟수.
    pub asks: u64,
    /// 그중 실제로 HTTP 조회를 건 횟수(워커 한 바퀴).
    pub fetches: u64,
    pub blocked: u64,
    pub clear: u64,
    pub unavailable: u64,
    /// ★CRIT R1 — **물어볼 창구가 없어 판정하지 않았다**(= 옛 계약으로 떨어뜨렸다).
    /// 지금은 Codex 실행인데 등록된 codex 계정·실행본이 없는 판이 여기다. 이 숫자가
    /// 오르는 동안 `blocked`가 0이라는 것이 "클로드 창으로 안 봤다"의 물증이다.
    pub unknown: u64,
}

/// 워커에게 시키는 일 — **어느 서비스의 한도를 채울 것인가**.
/// (계정 문자열 하나만 보내던 시절에는 이 구분이 없었고, 그게 §3 회귀의 모양이었다.)
enum Job {
    Claude(String),
    Codex(String),
}

pub struct Probe {
    wake: SyncSender<Job>,
    /// 계정별 마지막 조회 요청 시각(문 ④). 키는 **축 접두사 + 이메일**이다 — 같은 사람이
    /// 두 서비스에 같은 주소로 로그인하면 한쪽 쿨다운이 다른 쪽 조회를 삼킨다.
    asked_at: Mutex<BTreeMap<String, Instant>>,
    stats: Mutex<Stats>,
}

impl Probe {
    /// 워커 스레드를 띄우고 훅을 만든다. **앱 부팅마다 한 번**(허브가 소유).
    pub fn start() -> Arc<Probe> {
        // 깊이 4 — 한도에 동시에 걸린 채팅이 여럿일 수 있다. 꽉 차면 `try_send`가
        // 실패하고 그 tick은 그냥 `Unavailable`이다(허브 스레드는 **여기서도 안 막힌다**).
        let (tx, rx) = sync_channel::<Job>(4);
        let me = Arc::new(Probe {
            wake: tx,
            asked_at: Mutex::new(BTreeMap::new()),
            stats: Mutex::new(Stats::default()),
        });
        let worker = me.clone();
        let _ = std::thread::Builder::new()
            .name("ccg-limit-probe".into())
            .spawn(move || {
                while let Ok(job) = rx.recv() {
                    worker.stats.lock().unwrap_or_else(|e| e.into_inner()).fetches += 1;
                    match job {
                        // 값은 **공유 캐시**에 앉는다 — 다음 엿보기가 그걸 읽는다.
                        // 실패해도(=`unavailable`) 캐시에 안 앉으므로 다음 재확인이 또 묻는다.
                        Job::Claude(email) => {
                            let _ = crate::ipc::parity::usage::usage_get(true, Some(&email));
                        }
                        // ★CRIT R1 — Codex는 HTTP가 아니라 **프로세스**다(app-server JSON-RPC).
                        // 같은 워커에 태우는 이유도 같다: 허브 스레드는 0.7초도 못 막는다.
                        Job::Codex(email) => super::codex_limit::fill(&email),
                    }
                }
            });
        me
    }

    pub fn stats(&self) -> Stats {
        *self.stats.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 워커 깨우기 — 쿨다운(문 ④)에 걸리면 아무 일도 안 한다.
    fn kick(&self, email: &str, codex: bool) {
        let (key, cool) = if codex {
            (format!("codex:{email}"), CODEX_FETCH_COOLDOWN)
        } else {
            (format!("claude:{email}"), FETCH_COOLDOWN)
        };
        {
            let mut g = self.asked_at.lock().unwrap_or_else(|e| e.into_inner());
            if g.get(&key).is_some_and(|t| t.elapsed() < cool) {
                return;
            }
            g.insert(key, Instant::now());
        }
        // 실패 = 워커가 이미 밀려 있다. 그것도 정상 경로다.
        let job = if codex { Job::Codex(email.to_string()) } else { Job::Claude(email.to_string()) };
        let _ = self.wake.try_send(job);
    }

    fn tally(&self, v: LimitVerdict) -> LimitVerdict {
        let mut g = self.stats.lock().unwrap_or_else(|e| e.into_inner());
        g.asks += 1;
        match v {
            LimitVerdict::Blocked { .. } => g.blocked += 1,
            LimitVerdict::Clear => g.clear += 1,
            LimitVerdict::Unknown => g.unknown += 1,
            LimitVerdict::Unavailable => g.unavailable += 1,
        }
        v
    }

    /// ★CRIT R1 — **Codex 실행의 판정.** 클로드 계정의 창은 한 번도 안 본다.
    ///
    /// 착지 넷은 클로드 축과 같은 뜻이고 재료만 다르다(`account/rateLimits/read`):
    ///
    /// | 판 | 값 |
    /// |---|---|
    /// | API 키 실행 | `Clear` — 갈아탈 구독 창이 없다 |
    /// | 등록 codex 계정·실행본 없음 | **`Unknown`** — 물어볼 창구가 없다 = 옛 계약(발사) |
    /// | 스냅샷이 차갑거나 조회가 실패 | `Unavailable` — 대기표 유지 후 재확인 |
    /// | 창 목록이 있다 | `codexBlockedResetsAt`의 규칙으로 접는다 |
    fn codex_verdict(&self, q: &ProbeQuery<'_>) -> LimitVerdict {
        if matches!(q.billing, BillingAxis::ApiKey { .. }) {
            return self.tally(LimitVerdict::Clear);
        }
        // 물어볼 계정이 없다 = **창구가 없다**. 여기서 `Unavailable`을 주면 R3 회귀가
        // 모양만 바꿔 되살아난다 — 그 채팅은 465초 뒤에야 버튼을 얻는다.
        let Some(email) = super::codex_limit::account_for(q.codex_account) else {
            return self.tally(LimitVerdict::Unknown);
        };
        if super::codex_limit::instrument(&email).is_none() {
            return self.tally(LimitVerdict::Unknown);
        }
        let now_sec = (q.now_epoch_ms / 1000) as i64;
        match super::codex_limit::peek(&email, PEEK_TTL_MS) {
            Some(w) => {
                let v = fold_codex(&w, now_sec);
                if matches!(v, LimitVerdict::Unavailable) {
                    self.kick(&email, true);
                }
                self.tally(v)
            }
            None => {
                self.kick(&email, true);
                self.tally(LimitVerdict::Unavailable)
            }
        }
    }
}

/// 이식본 [`codexBlockedResetsAt`](app/src/lib/limitResume.ts) + `codexUsageUnavailable`의
/// Rust 짝. 창 라벨은 안 본다 — 플랜별 창 구성이 다르고, 소진이면 그게 곧 게이트다.
///
/// 목록이 **비어 있으면 「못 물어봤다」**다(이식본 `codexUsageUnavailable`의 그 줄):
/// 살아 있는 계정의 정상 응답에는 최소 창 하나가 실린다.
pub fn fold_codex(windows: &Value, now_sec: i64) -> LimitVerdict {
    let Some(ws) = windows.as_array().filter(|a| !a.is_empty()) else {
        return LimitVerdict::Unavailable;
    };
    let mut latest: Option<u64> = None;
    for w in ws {
        if w.get("usedPct").and_then(Value::as_i64).unwrap_or(0) < 100 {
            continue;
        }
        let Some(at) = w.get("resetsAt").and_then(Value::as_i64) else { continue };
        // 클로드 축과 같은 `+60초` 경계 — 1분 안에 풀릴 창은 풀린 셈이다.
        if at <= now_sec + EDGE_SEC {
            continue;
        }
        let at = at as u64;
        latest = Some(latest.map_or(at, |l: u64| l.max(at)));
    }
    match latest {
        Some(t) => LimitVerdict::Blocked { resets_at: Some(t) },
        None => LimitVerdict::Clear,
    }
}

/// `UsageInfo`(JSON) → 판정. **이식본 `blockedResetsAt` + `usageUnavailable`의 Rust 짝**이고,
/// 순수 함수라 테스트가 실물 값(`docs/critic/limit-blind-t3t4-*.json`)을 그대로 먹인다.
///
/// 규약 세 줄:
///  1. `unavailable` 표식이 있으면 **못 물어봤다**(창 넷이 `null`인 모양과 구분되는 그 키).
///  2. 창이 하나도 없어도 못 물어봤다 — 실계정 정상 응답에는 최소한 5시간·주간이 실린다.
///  3. 남은 것 중 `pct >= 100`이고 해제 시각이 **아직 안 온** 창의 **가장 늦은** 시각.
///     여러 창이 동시 소진이면 전부 풀려야 실행되기 때문이다.
///
/// Fable 주간 창은 **Fable 실행일 때만** 게이트다(다른 모델은 그 창 소진과 무관하게 돈다).
pub fn fold(u: &Value, model: &str, now_sec: i64) -> LimitVerdict {
    if u.get("unavailable").and_then(Value::as_bool) == Some(true) {
        return LimitVerdict::Unavailable;
    }
    let win = |k: &str| u.get(k).filter(|v| !v.is_null());
    if ["fiveHour", "weekly", "weeklyFable", "extraCredit"].iter().all(|k| win(k).is_none()) {
        return LimitVerdict::Unavailable;
    }
    let fable = model.eq_ignore_ascii_case("fable");
    let gates = ["fiveHour", "weekly", "weeklyFable"]
        .into_iter()
        .filter(|k| fable || *k != "weeklyFable")
        .filter_map(win);
    let mut latest: Option<u64> = None;
    for w in gates {
        let pct = w.get("pct").and_then(Value::as_i64).unwrap_or(0);
        let Some(at) = w.get("resetsAt").and_then(Value::as_i64) else { continue };
        // 이식본과 같은 세 조건: 소진 · 해제 시각 있음 · 그 시각이 아직 안 옴.
        if pct < 100 || at <= now_sec + EDGE_SEC {
            continue;
        }
        let at = at as u64;
        latest = Some(latest.map_or(at, |l: u64| l.max(at)));
    }
    match latest {
        Some(t) => LimitVerdict::Blocked { resets_at: Some(t) },
        None => LimitVerdict::Clear,
    }
}

impl LimitProbe for Probe {
    /// ★CRIT R1 — **엔진 축을 가르는 유일한 자리.**
    ///
    /// R3의 훅에는 이 갈래가 없어서 Codex 채팅이 클로드 주간 창으로 판정됐다
    /// (확인 크리틱 R3 §3 — 50시간 재장전 + 사용자 메시지 큐 주차, 최대 7일).
    /// 렌더러 짝은 `useLimitResume.fire()`의 `cur.engine === 'claude'` 한 줄이다.
    fn probe(&self, q: &ProbeQuery<'_>) -> LimitVerdict {
        match q.engine {
            EngineKind::Claude => self.blocked_until_for(q.billing, q.model, q.now_epoch_ms),
            EngineKind::Codex => self.codex_verdict(q),
        }
    }

    fn blocked_until(&self, account: &BillingAxis, now_epoch_ms: u64) -> LimitVerdict {
        self.blocked_until_for(account, "", now_epoch_ms)
    }

    fn blocked_until_for(&self, account: &BillingAxis, model: &str, now_epoch_ms: u64) -> LimitVerdict {
        // API 키 실행에는 구독 창이 없다 — 물어볼 한도가 **없는 것**이지 못 물어본 게 아니다.
        // (`useLimitResume`도 `apiMode`면 장전 자체를 안 한다.)
        let BillingAxis::Subscription { account, .. } = account else {
            return self.tally(LimitVerdict::Clear);
        };
        let email = account.as_str();
        if email.is_empty() {
            return self.tally(LimitVerdict::Unavailable);
        }
        let now_sec = (now_epoch_ms / 1000) as i64;
        match crate::ipc::parity::usage::peek_usage(email, PEEK_TTL_MS) {
            Some(u) => {
                let v = fold(&u, model, now_sec);
                // 캐시에 앉은 값이 「못 물어봤다」였으면 다시 묻는다(다음 재확인용).
                if matches!(v, LimitVerdict::Unavailable) {
                    self.kick(email, false);
                }
                self.tally(v)
            }
            None => {
                // 스냅샷이 차갑다 = **지금은 답할 근거가 없다.** 워커를 깨우고 이번
                // 회차는 「못 물어봤다」다 — 엔진이 15초 뒤 다시 물으면 그때는 값이 있다.
                self.kick(email, false);
                self.tally(LimitVerdict::Unavailable)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn w(pct: i64, at: i64) -> Value {
        json!({ "pct": pct, "resetsAt": at })
    }

    /// ★ 크리틱 실패1의 값 그대로 — 창 넷이 `null`이고 `unavailable` 표식이 붙은 값.
    /// 이걸 「막는 창 없음 = 풀렸다」로 읽는 것이 이 라운드가 죽이는 오판이다.
    #[test]
    fn the_unavailable_marker_is_not_a_clear_verdict() {
        let dead = json!({ "fiveHour": null, "weekly": null, "weeklyFable": null,
                           "extraCredit": null, "unavailable": true });
        assert_eq!(fold(&dead, "opus", 1_787_000_000), LimitVerdict::Unavailable);
        // 표식이 없어도 창이 하나도 없으면 근거가 0이다(옛 심·2.6.2 본체 경로).
        let bare = json!({ "fiveHour": null, "weekly": null, "weeklyFable": null, "extraCredit": null });
        assert_eq!(fold(&bare, "opus", 1_787_000_000), LimitVerdict::Unavailable);
    }

    /// 소진 창이 있으면 **가장 늦은** 해제 시각이 답이다(전부 풀려야 실행된다).
    #[test]
    fn the_latest_exhausted_window_wins() {
        let now = 1_787_000_000;
        let u = json!({ "fiveHour": w(100, now + 600), "weekly": w(100, now + 90_000),
                        "weeklyFable": null, "extraCredit": null });
        assert_eq!(fold(&u, "opus", now), LimitVerdict::Blocked { resets_at: Some((now + 90_000) as u64) });
        // 하나라도 안 찼으면 그 창은 게이트가 아니다.
        let u = json!({ "fiveHour": w(99, now + 600), "weekly": w(100, now + 90_000), "weeklyFable": null });
        assert_eq!(fold(&u, "opus", now), LimitVerdict::Blocked { resets_at: Some((now + 90_000) as u64) });
        let u = json!({ "fiveHour": w(99, now + 600), "weekly": w(3, now + 90_000), "weeklyFable": null });
        assert_eq!(fold(&u, "opus", now), LimitVerdict::Clear);
    }

    /// 해제 시각이 **이미 지났거나 1분 안**이면 막는 창이 아니다(이식본의 `nowSec + 60`).
    #[test]
    fn a_window_that_resets_within_a_minute_is_already_open() {
        let now = 1_787_000_000;
        for at in [now - 10, now, now + 30, now + 60] {
            let u = json!({ "fiveHour": w(100, at), "weekly": null, "weeklyFable": null });
            assert_eq!(fold(&u, "opus", now), LimitVerdict::Clear, "at={at}");
        }
        let u = json!({ "fiveHour": w(100, now + 61), "weekly": null, "weeklyFable": null });
        assert_eq!(fold(&u, "opus", now), LimitVerdict::Blocked { resets_at: Some((now + 61) as u64) });
    }

    /// 해제 시각을 모르는 소진 창은 **건너뛴다** — 이식본 `blockedResetsAt`의 `resetsAt == null`
    /// continue와 같은 자리다(모르는 시각으로 대기표를 세우면 영원히 안 풀린다).
    #[test]
    fn an_exhausted_window_without_a_reset_time_is_skipped() {
        let now = 1_787_000_000;
        let u = json!({ "fiveHour": { "pct": 100, "resetsAt": null }, "weekly": null, "weeklyFable": null });
        assert_eq!(fold(&u, "opus", now), LimitVerdict::Clear);
    }

    /// **Fable 주간 창은 Fable 실행만 게이트한다.** 이 줄이 없으면 Fable 주간이 찬 주에
    /// 다른 모델 채팅 전부가 며칠씩 안 풀리는 대기표를 든다.
    #[test]
    fn the_fable_weekly_window_gates_only_fable_runs() {
        let now = 1_787_000_000;
        let u = json!({ "fiveHour": w(10, now + 600), "weekly": w(20, now + 900),
                        "weeklyFable": w(100, now + 200_000) });
        assert_eq!(fold(&u, "opus", now), LimitVerdict::Clear, "★ 다른 모델까지 묶였다");
        assert_eq!(
            fold(&u, "fable", now),
            LimitVerdict::Blocked { resets_at: Some((now + 200_000) as u64) },
            "★ Fable 실행인데 안 막았다"
        );
    }

    /// API 키 실행에는 갈아탈 구독 창이 없다 — 「못 물어봤다」가 아니라 「해당 없음」이다.
    #[test]
    fn an_api_key_run_has_no_subscription_window_to_wait_for() {
        let p = Probe::start();
        let axis = BillingAxis::ApiKey { key_fp: "fp-1".to_string().into() };
        assert_eq!(p.blocked_until(&axis, 1_787_000_000_000), LimitVerdict::Clear);
        assert_eq!(p.stats().clear, 1);
    }

    /// 스냅샷이 차가우면 **즉시** 「못 물어봤다」로 답하고 워커를 깨운다(허브 스레드는 안 막힌다).
    #[test]
    fn a_cold_snapshot_answers_immediately_and_wakes_the_worker() {
        let _h = ccg_store::testhome::take("limit-probe-cold");
        let p = Probe::start();
        let axis = BillingAxis::Subscription {
            account: "nobody@probe.test".to_string().into(),
            drop_env_key: false,
        };
        let t0 = Instant::now();
        let v = p.blocked_until_for(&axis, "opus", 1_787_000_000_000);
        assert_eq!(v, LimitVerdict::Unavailable);
        assert!(t0.elapsed() < Duration::from_millis(50), "허브 스레드를 {:?} 막았다", t0.elapsed());
        assert_eq!(p.stats().asks, 1);
    }

    // ── ★CRIT R1 — 엔진 축 ──────────────────────────────────────────────────

    fn codex_q<'a>(billing: &'a BillingAxis, account: Option<&'a str>) -> ProbeQuery<'a> {
        ProbeQuery {
            billing,
            engine: EngineKind::Codex,
            codex_account: account,
            model: "gpt-5.6",
            now_epoch_ms: 1_787_000_000_000,
        }
    }

    /// ★ **이 라운드의 과녁.** 확인 크리틱 R3 §3의 판을 그대로 만든다: 클로드 주간 창이
    /// 100%(해제 50시간 뒤)로 캐시에 앉아 있고, 채팅은 Codex다.
    ///
    /// R3의 훅은 이 판에서 `Blocked{50시간 뒤}`를 돌려줬고 그 대기표가 사용자 메시지까지
    /// 큐에 주차시켰다. 이제 그 창은 **조회조차 되지 않는다** — 등록된 codex 계정이 없으니
    /// 판정하지 않고(`Unknown`) 옛 계약(발사)으로 떨어진다.
    #[test]
    fn a_codex_chat_is_never_judged_by_the_claude_weekly_window() {
        let _h = ccg_store::testhome::take("limit-probe-axis");
        let email = "axis@probe.test";
        // 클로드 축의 스냅샷을 **막힌 값**으로 채운다(캐시에 직접 앉힌다 = HTTP 0건).
        let now_sec = 1_787_000_000i64;
        crate::ipc::parity::usage::seed_peek_for_test(
            email,
            json!({ "fiveHour": { "pct": 0, "resetsAt": now_sec + 600 },
                    "weekly": { "pct": 100, "resetsAt": now_sec + 180_000 },
                    "weeklyFable": null, "extraCredit": null }),
        );
        let billing = BillingAxis::Subscription { account: email.to_string(), drop_env_key: false };

        // ① 대조 — 같은 계정, **클로드** 채팅이면 그 창이 그대로 게이트다(오판 소멸 유지).
        let p = Probe::start();
        let claude = ProbeQuery { engine: EngineKind::Claude, ..codex_q(&billing, None) };
        assert_eq!(
            p.probe(&claude),
            LimitVerdict::Blocked { resets_at: Some((now_sec + 180_000) as u64) },
            "클로드 채팅의 재검증까지 죽으면 R3이 닫은 자리가 다시 열린다"
        );
        assert_eq!(p.stats().blocked, 1);

        // ② ★ Codex 채팅 — 클로드 창을 **한 번도 안 본다**. 물어볼 창구가 없으니 판정 없음.
        let v = p.probe(&codex_q(&billing, Some("me@openai.com")));
        assert_eq!(v, LimitVerdict::Unknown, "★ Codex 채팅을 클로드 한도로 판정했다");
        assert_eq!(p.stats().blocked, 1, "★ Codex 물음이 `blocked`를 올렸다 = 클로드 창을 봤다");
        assert_eq!(p.stats().unknown, 1);

        // ③ 계정 미지정(=codex 기본 계정)도 같다 — 등록이 0이면 물어볼 곳이 없다.
        assert_eq!(p.probe(&codex_q(&billing, None)), LimitVerdict::Unknown);

        crate::ipc::parity::usage::seed_peek_for_test(email, Value::Null);
    }

    /// Codex 창 접기 — 이식본 `codexBlockedResetsAt` + `codexUsageUnavailable`과 같은 규칙.
    #[test]
    fn the_codex_windows_fold_like_the_renderer_does() {
        let now = 1_787_000_000i64;
        let cw = |pct: i64, at: Value| json!({ "usedPct": pct, "resetsAt": at });
        // 빈 목록 = 못 물어봤다(「막는 창 없음」이 아니다 — 그 오독이 R2의 최대 격차였다).
        assert_eq!(fold_codex(&json!([]), now), LimitVerdict::Unavailable);
        assert_eq!(fold_codex(&Value::Null, now), LimitVerdict::Unavailable);
        // 소진 창 둘이면 **가장 늦은** 해제 시각(전부 풀려야 실행된다).
        let ws = json!([cw(100, json!(now + 600)), cw(100, json!(now + 90_000))]);
        assert_eq!(fold_codex(&ws, now), LimitVerdict::Blocked { resets_at: Some((now + 90_000) as u64) });
        // 안 찬 창·시각 미상 창은 게이트가 아니다.
        assert_eq!(fold_codex(&json!([cw(99, json!(now + 600))]), now), LimitVerdict::Clear);
        assert_eq!(fold_codex(&json!([cw(100, Value::Null)]), now), LimitVerdict::Clear);
        // +60초 경계 — 1분 안에 풀릴 창은 풀린 셈이다(클로드 축과 같은 값).
        assert_eq!(fold_codex(&json!([cw(100, json!(now + 60))]), now), LimitVerdict::Clear);
        assert_eq!(
            fold_codex(&json!([cw(100, json!(now + 61))]), now),
            LimitVerdict::Blocked { resets_at: Some((now + 61) as u64) }
        );
    }

    /// Codex + API 키 실행에도 갈아탈 구독 창이 없다(클로드 축과 같은 답).
    #[test]
    fn a_codex_api_key_run_has_no_window_either() {
        let _h = ccg_store::testhome::take("limit-probe-codex-api");
        let p = Probe::start();
        let axis = BillingAxis::ApiKey { key_fp: "fp-2".to_string().into() };
        assert_eq!(p.probe(&codex_q(&axis, Some("me@openai.com"))), LimitVerdict::Clear);
        assert_eq!(p.stats().clear, 1);
    }
}
