//! ★M11 셸 — **한도 소진 시 노는 계정 자동 전환**의 재료 수집기.
//!
//! 엔진에는 계정도 한도도 오염가드도 없다(있어서도 안 된다 — 재생 하네스가 97개
//! 시나리오를 0ms에 도는 이유가 그것이다). 그래서 엔진은 훅 하나만 들고 있고
//! ([`ccg_engine::limit::AccountSwitcher`]) 재료는 여기서 모은다.
//!
//! ```text
//!   [허브 스레드]  rt.tick() → check_hold → switcher.pick(req)   ← **절대 막히면 안 된다**
//!         │                                     │
//!         │                              스냅샷만 읽고 즉시 답한다
//!         │                                     │ 없으면 워커를 깨우고 None
//!         ▼                                     ▼
//!   [워커 스레드 1개]  preflight(로컬 파일) + usage(캐시 → 필요하면 HTTP) → 스냅샷
//! ```
//!
//! ## 왜 워커가 따로 있나 (성능이 아니라 **정확성**의 문제)
//!
//! `pick`은 허브 스레드에서 불린다. 그 스레드는 **모든 채팅의 tick**을 돌고, 20ms마다
//! 프레임을 옮긴다. 거기서 계정 6개의 usage를 동기 조회하면(각 1.2초 간격 직렬화 —
//! `usage.rs`의 레이트리밋 규약) 7초 동안 **다른 대화의 스트리밍이 통째로 멈춘다**.
//! 그래서 `pick`은 절대 I/O를 하지 않는다. 첫 tick은 `None`을 내고 워커를 깨우며,
//! 몇 초 뒤 스냅샷이 도착하면 `check_hold`가 매 tick 되묻고 있으므로 그때 성사된다
//! (사용자 체감: "한도 문구가 뜨고 잠시 뒤 다른 계정으로 이어짐").
//!
//! ## 예산 규율 (실계정 HTTP)
//!
//! | 문 | 무엇 |
//! |---|---|
//! | ① 설정 토글 | 기본 **꺼짐**. 꺼져 있으면 워커를 깨우지도 않는다 = HTTP 0건 |
//! | ② 후보만 조회 | 지금 계정·이미 거쳐 온 계정·오염/재로그인 계정은 **묻지 않는다** |
//! | ③ 캐시 TTL | [`ccg_auth::usage::ACCT_USAGE_TTL_MS`](2분) 안쪽 값은 그대로 쓴다 |
//! | ④ 쿨다운 | 한 번 돈 워커는 [`WORKER_COOLDOWN`] 동안 다시 안 돈다(틱마다 깨워도) |
//! | ⑤ `CCG_NO_NET=1` | 전 호출 즉시 거절 — 하네스·재생 주행의 킬 스위치 |

use ccg_auth::switch::{self, SkipWhy, SwitchInput};
use ccg_auth::usage::{self, AccountUsage};
use ccg_auth::verify::{self, PreflightVerdict};
use ccg_engine::limit::{AccountSwitcher, SwitchPick, SwitchRequest};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// ui-prefs 키 — 렌더러의 `getPref/setPref`와 **같은 문자열**이어야 한다.
/// (`limitResume.on`이 "한도 풀리면 자동으로 이어서"이고, 이쪽은 "안 기다리고 갈아타기".)
pub const PREF_KEY: &str = "limitSwitch.on";

/// 토글을 디스크에서 다시 읽는 간격. `pick`은 tick마다 불리므로 매번 파일을 열 수 없다.
const TOGGLE_TTL: Duration = Duration::from_secs(3);
/// 워커 한 바퀴의 최소 간격(문 ④). 표가 서 있는 동안 tick은 초당 수 회 깨우려 든다.
const WORKER_COOLDOWN: Duration = Duration::from_secs(20);
/// 스냅샷이 이보다 낡으면 워커를 다시 깨운다(그래도 **있는 값으로는 판정한다** —
/// 낡았다고 안 옮기면, 조회가 실패하는 판에서 기능이 영영 안 켜진다).
const SNAP_TTL: Duration = Duration::from_secs(120);

/// 워커가 채우고 `pick`이 읽는 판정 재료. 락 안에서 하는 일은 **clone뿐**이다.
#[derive(Default)]
struct Snapshot {
    at: Option<Instant>,
    /// `accounts.json` 저장 순서(= 사용자가 드래그로 정한 표시 순서).
    order: Vec<String>,
    usage: BTreeMap<String, AccountUsage>,
    preflight: BTreeMap<String, PreflightVerdict>,
}

/// 마지막 판정의 탈락 사유 — `engine:debug`/리포트가 읽는 진단 값이다.
/// 침묵 금지(D7): "왜 안 바뀌었나"에 답이 없으면 사용자는 기능이 꺼진 줄 안다.
#[derive(Default, Clone)]
pub struct LastPlan {
    pub picked: Option<String>,
    pub skipped: Vec<(String, &'static str)>,
}

pub struct Switcher {
    /// 지금 **다른 채팅이 태우고 있는** 계정. 허브가 펌프마다 갱신한다
    /// ([`Switcher::set_busy`]) — 놀지 않는 계정으로 옮기면 둘이 한 창을 나눠 쓴다.
    busy: Mutex<BTreeSet<String>>,
    snap: Mutex<Snapshot>,
    toggle: Mutex<(bool, Option<Instant>)>,
    wake: SyncSender<()>,
    last: Mutex<LastPlan>,
}

impl Switcher {
    /// 워커 스레드를 띄우고 훅을 만든다. **앱 부팅마다 한 번**(허브가 소유).
    pub fn start() -> Arc<Switcher> {
        // 깊이 1 — 깨우기는 "한 번 돌아라"는 신호지 큐가 아니다. 꽉 차 있으면
        // 이미 예약돼 있다는 뜻이라 `try_send`의 실패가 곧 정상 경로다.
        let (tx, rx) = sync_channel::<()>(1);
        let me = Arc::new(Switcher {
            busy: Mutex::new(BTreeSet::new()),
            snap: Mutex::new(Snapshot::default()),
            toggle: Mutex::new((false, None)),
            wake: tx,
            last: Mutex::new(LastPlan::default()),
        });
        let worker = me.clone();
        // 이름 있는 스레드 — 덤프·프로파일에서 "이 7초는 누구인가"에 답한다.
        let _ = std::thread::Builder::new()
            .name("ccg-acct-switch".into())
            .spawn(move || {
                let mut last_run: Option<Instant> = None;
                while rx.recv().is_ok() {
                    if last_run.is_some_and(|t| t.elapsed() < WORKER_COOLDOWN) {
                        continue;
                    }
                    last_run = Some(Instant::now());
                    let snap = collect(&worker);
                    *worker.snap.lock().unwrap_or_else(|e| e.into_inner()) = snap;
                }
            });
        // **미리 데운다**(설정이 켜져 있을 때만). 안 데우면 그 앱의 *첫* 한도에서
        // 스냅샷이 차가워 전환이 한 tick 늦고, 사용자는 대기 문장과 전환 문장을
        // 연달아 읽는다(위 `pending`이 그 자리를 막지만, 애초에 안 만드는 게 낫다).
        // 꺼져 있으면 아무것도 안 한다 = 계정 폴더도 안 읽는다.
        if me.enabled() {
            me.kick();
        }
        me
    }

    /// 설정 토글. 렌더러가 `ui-prefs.json`에 쓰고 여기서 읽는다 — 채널을 늘리지 않는다
    /// (엔진 설정 하나를 위해 IPC 채널 33번째를 만들 이유가 없다).
    pub fn enabled(&self) -> bool {
        let mut g = self.toggle.lock().unwrap_or_else(|e| e.into_inner());
        if g.1.is_some_and(|t| t.elapsed() < TOGGLE_TTL) {
            return g.0;
        }
        let on = ccg_store::prefs::read_ui_prefs()
            .get(PREF_KEY)
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false); // ★ 기본 꺼짐
        *g = (on, Some(Instant::now()));
        on
    }

    /// 허브가 펌프마다 알려 주는 "지금 태우고 있는 계정" 집합.
    pub fn set_busy(&self, b: BTreeSet<String>) {
        *self.busy.lock().unwrap_or_else(|e| e.into_inner()) = b;
    }

    /// 마지막 판정의 탈락 사유(진단).
    pub fn last_plan(&self) -> LastPlan {
        self.last.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn kick(&self) {
        // 실패 = 이미 예약돼 있다. 허브 스레드는 **여기서도 안 막힌다**.
        let _ = self.wake.try_send(());
    }
}

impl Switcher {
    /// 스냅샷이 아직 없다 = `pick`의 `None`이 "갈 데가 없다"가 아니라 "아직 안 물어봤다"다.
    /// 엔진은 이 값으로 대기 문장을 한 tick 미룬다([`AccountSwitcher::pending`]).
    fn snapshot_cold(&self) -> bool {
        self.snap.lock().unwrap_or_else(|e| e.into_inner()).at.is_none()
    }
}

impl AccountSwitcher for Switcher {
    /// 꺼져 있으면 **절대** `pending`이 아니다 — 꺼진 기능이 문장을 미루면 그건 그냥 침묵이다.
    fn pending(&self) -> bool {
        self.enabled() && self.snapshot_cold()
    }

    fn pick(&self, req: &SwitchRequest) -> Option<SwitchPick> {
        if !self.enabled() {
            return None; // ★ 꺼짐 = 무동작. 워커도 안 깨운다 = HTTP 0건.
        }
        let ccg_engine::identity::BillingAxis::Subscription { account: cur, .. } = req.current else {
            return None; // API 키 실행에는 갈아탈 "계정"이 없다.
        };
        let snap = {
            let g = self.snap.lock().unwrap_or_else(|e| e.into_inner());
            if g.at.is_none_or(|t| t.elapsed() > SNAP_TTL) {
                self.kick();
            }
            if g.at.is_none() {
                return None; // 아직 아무것도 모른다 — 증거 없이는 안 옮긴다.
            }
            Snapshot {
                at: g.at,
                order: g.order.clone(),
                usage: g.usage.clone(),
                preflight: g.preflight.clone(),
            }
        };
        let busy = self.busy.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let plan = switch::plan(&SwitchInput {
            now_epoch_secs: (req.now_epoch_ms / 1000) as i64,
            order: &snap.order,
            current: cur.as_str(),
            needs_fable: switch::model_needs_fable(req.model),
            busy: &busy,
            tried: req.tried,
            usage: &snap.usage,
            preflight: &snap.preflight,
        });
        let picked = plan.pick().cloned();
        *self.last.lock().unwrap_or_else(|e| e.into_inner()) = LastPlan {
            picked: picked.as_ref().map(|c| c.email.clone()),
            skipped: plan.skipped.iter().map(|s| (s.email.clone(), s.why.wire())).collect(),
        };
        // 후보가 없다 = 지금 아는 것으로는 갈 데가 없다. 다음 tick을 위해 갱신을 건다
        // (`usage_unknown` 하나만으로도 몇 초 뒤 성사될 수 있다).
        if picked.is_none() && plan.skipped.iter().any(|s| s.why == SkipWhy::UsageUnknown) {
            self.kick();
        }
        let c = picked?;
        Some(SwitchPick {
            account: c.email,
            soonest_reset: c.soonest_reset.filter(|s| *s > 0).map(|s| s as u64),
        })
    }
}

/// 워커 한 바퀴 — **여기서만** 파일·네트워크를 만진다.
fn collect(sw: &Switcher) -> Snapshot {
    let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let accounts = ccg_auth::claude::list_accounts();
    let order: Vec<String> = accounts.iter().map(|a| a.email.clone()).collect();
    let mut preflight = BTreeMap::new();
    let mut cache = usage::read_usage_cache();
    let mut usage_map = BTreeMap::new();
    let busy = sw.busy.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let mut fetched = false;
    for email in &order {
        // 오염가드가 **한도 조회보다 먼저**다(`verify::preflight` 헤더의 순서 그대로):
        // 오염 항목은 살아 있는 토큰을 물고 있어 조회도 통과해 버린다. 게다가 여기서
        // 먼저 걸러야 **그 계정에 HTTP를 안 쓴다**(예산 문 ②).
        let v = verify::preflight(email).verdict;
        let usable = matches!(v, PreflightVerdict::Probe | PreflightVerdict::NeedsRefresh);
        preflight.insert(email.clone(), v);
        if let Some(c) = cache.get(email) {
            usage_map.insert(email.clone(), c.data.clone());
        }
        if !usable || busy.contains(email) {
            continue;
        }
        let fresh = cache
            .get(email)
            .is_some_and(|c| now_ms - c.at >= 0 && (now_ms - c.at) < usage::ACCT_USAGE_TTL_MS as i64);
        if fresh {
            continue;
        }
        match fetch(email) {
            Some(u) => {
                cache.insert(email.clone(), usage::CachedUsage { at: now_ms, data: u.clone() });
                usage_map.insert(email.clone(), u);
                fetched = true;
            }
            // 못 물어봤다 = **모름**이다. 캐시의 낡은 값이 있으면 그걸 쓰고
            // (`window_state`가 지난 창을 `Rolled`로 접는다), 없으면 후보가 아니다.
            None => {}
        }
    }
    if fetched {
        usage::write_usage_cache(&cache);
    }
    Snapshot { at: Some(Instant::now()), order, usage: usage_map, preflight }
}

/// 계정 하나의 실 조회. `ccg-auth/net`은 **이 크레이트만** 켠다(src-tauri/Cargo.toml).
/// `CCG_NO_NET=1`이면 즉시 `Err(Disabled)`라 하네스 주행은 캐시만 본다.
fn fetch(email: &str) -> Option<AccountUsage> {
    match ccg_auth::net::fetch_account_usage(email) {
        Ok(u) => Some(u),
        Err(e) => {
            // 침묵 no-op 금지(D7) — 왜 후보가 안 됐는지의 원전이 여기다.
            eprintln!("[acct-switch] usage 조회 실패 {email}: {e}");
            None
        }
    }
}
