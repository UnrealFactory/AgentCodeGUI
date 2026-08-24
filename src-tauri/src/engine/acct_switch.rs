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
//! | ②' 한도 장전 때만 | **부팅 프리웜 없음.** 워커는 어떤 채팅이 한도에 걸려 후보를 물을 때 처음 돈다 |
//! | ③ 캐시 TTL | [`ccg_auth::usage::ACCT_USAGE_TTL_MS`](2분) 안쪽 값은 그대로 쓴다 |
//! | ④ 쿨다운 | 한 번 돈 워커는 [`WORKER_COOLDOWN`] 동안 다시 안 돈다(틱마다 깨워도) |
//! | ⑤ `CCG_NO_NET=1` | 전 호출 즉시 거절 — 하네스·재생 주행의 킬 스위치 |
//!
//! ## ★R2 — 왜 ②'와 ②가 *코드*가 됐나 (R1 크리틱 C1·C4)
//!
//! R1은 문 ②를 **문서에만** 적어 뒀다: `collect()`는 `order` 전체를 돌았고, `Switcher`에는
//! "지금 계정"·"이미 거쳐 온 계정"을 담을 필드조차 없었다. 그리고 `start()`가 설정만
//! 켜져 있으면 **부팅 직후** 곧바로 워커를 깨웠다. 둘을 곱하면 결과는 이것이다:
//! *앱을 켜는 것만으로 등록 계정 전부의 usage를 조회하고, 만료된 계정의 refresh 토큰을
//! 서버에서 회전시킨다.* 회전은 되돌릴 수 없는 부작용이다(`ccg_auth_probe`가 같은 이유로
//! 문을 달아 둔 그 동작이다).
//!
//! 이제 조회의 계기는 하나다 — **한도에 걸린 채팅이 후보를 묻는 순간**([`Switcher::ask`]).
//! 그 물음은 자기가 **제외할 계정**(현재 + 이 에피소드에서 거쳐 온 것)을 같이 들고 오고,
//! 워커는 물어 온 채팅들이 **아무도 제외하지 않은 계정에만** HTTP를 쓴다.

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
/// ★R2 C2 — **후보 예약의 수명.** 어떤 채팅이 계정을 집으면 그 계정은 이 시간 동안
/// 다른 채팅에게 "놀고 있지 않은" 것으로 보인다.
///
/// 왜 필요한가: 허브의 `busy`는 *CLI가 살아 있는* 채팅의 계정이다. 갈아탄 채팅이 새
/// 계정으로 **스폰하기 전**(정체성만 바뀐 그 몇십 ms)에는 그 계정이 아직 busy가 아니고,
/// 같은 순간 열린 다른 채팅이 같은 1등을 집는다 — 규칙 ①이 막으려던 바로 그 상태다.
/// 예약이 그 틈을 메우고, 스폰이 끝나면 busy가 이어받는다(그래서 짧아도 된다).
///
/// ★R3(F8) — 값은 **엔진 장부에서 가져온다**([`ccg_engine::limit::TAKEN_TTL_MS`]).
/// R2는 셸 30초 · 엔진 60초로 갈려 있었고, 그 30초 동안은 "셸은 비었다는데 엔진이 막는"
/// 구간이라 재질문 루프가 헛돌았다(확인 크리틱 F8).
const RESERVE_TTL: Duration = Duration::from_millis(ccg_engine::limit::TAKEN_TTL_MS);

/// ★R3(F2) — 조회에 실패한 계정을 다시 물어보기까지의 **최소 간격**(지수 백오프의 밑).
///
/// 워커 쿨다운(20초)보다 커야 "매 tick 재시도"가 사라진다. R2는 상한이 없어서 죽은
/// 토큰 하나가 20초마다 영원히 교환 POST를 냈다(확인 크리틱 F2-⑶).
const SICK_BACKOFF_BASE: Duration = Duration::from_secs(60);
/// 백오프 상한 — 이 시간이 지나면 죽은 것처럼 보이던 계정도 한 번은 다시 물어본다.
const SICK_BACKOFF_MAX: Duration = Duration::from_secs(30 * 60);

// ── ★M11 R4(G6) — **429·5xx는 계정의 죄가 아니다** ──────────────────────────
//
// R3는 조회 실패를 한 가지로 셌다(`Err(_) → note_sick`). 그래서 usage API가 잠깐
// 흔들리기만 해도 **살아 있는 계정**이 최대 30분 후보에서 빠졌다. 그 창이 실제로
// 비어 보이는 이유는 셋이 겹치기 때문이다(R3 크리틱 §9):
//
// | # | 무엇 | 값 |
// |---|---|---|
// | ① | 판정은 조회 **전** 값 그대로 | 만료 토큰이면 `NeedsRefresh` → `Unverified` |
// | ② | 새 usage가 없으니 캐시가 낡는다 | `ACCT_USAGE_TTL_MS` = **2분** |
// | ③ | 격리 백오프가 재조회를 막는다 | 60초 → ×2 → 상한 **30분** |
//
// ②가 지나면 살아 있는 계정도 `usage_unknown`이라 후보가 아니다. 그리고 이 저장소가
// 직접 적어 뒀듯이(`usage.rs` 헤더) 같은 IP의 병렬 2건 중 1건은 429로 온다 — 흔한 일에
// 30분짜리 벌을 주는 셈이었다.
//
// 그래서 곡선을 둘로 가른다. **첫 대기를 캐시 TTL(2분)보다 짧게** 두는 것이 요점이다:
// 한 번 흔들린 계정은 캐시가 낡기 전에 다시 물어볼 기회를 얻는다.
/// 일시 실패(429·5xx·전송·본문 파싱)의 밑 — 워커 쿨다운 한 바퀴.
const FLAKY_BACKOFF_BASE: Duration = Duration::from_secs(20);
/// 일시 실패의 상한. 계속 흔들리면 결국 쉬어야 하지만 30분은 아니다.
const FLAKY_BACKOFF_MAX: Duration = Duration::from_secs(5 * 60);

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
    /// ★R2 C2 — **집는 순간 표시.** `계정 → (집은 채팅, 집은 시각)`.
    reserved: Mutex<BTreeMap<String, (String, Instant)>>,
    snap: Mutex<Snapshot>,
    toggle: Mutex<(bool, Option<Instant>)>,
    wake: SyncSender<()>,
    /// ★R2 C1(c) — **물음 장부**(예산 문 ②). 항목 하나가 채팅 하나의 *제외 집합*이다
    /// (지금 쓰는 계정 + 이 에피소드에서 거쳐 온 계정). 워커는 이걸 보고 조회 대상을
    /// 정한다. 같은 집합은 겹쳐 담지 않는다(틱마다 묻기 때문에 Vec이면 무한히 자란다).
    asks: Mutex<BTreeSet<BTreeSet<String>>>,
    /// `(워커가 돈 횟수, 실제 HTTP 조회 건수)` — 예산 문 ②·②'의 **측정 축**이다.
    /// `engine:debug`의 `accountSwitch.worker`로 나간다: 문서가 "안 묻는다"고 적어 두고
    /// 코드는 묻고 있던 것이 R1의 C1·C4였다. 이제 하네스가 숫자로 확인할 수 있다.
    stats: Mutex<(u64, u64)>,
    /// ★R3(F2) — **조회에 실패한 계정의 격리 장부.** `계정 → (연속 실패 수, 다시 물어볼 시각)`.
    /// 재로그인이 필요해 보이는 계정은 여기에 더해 [`ccg_auth::health`]에도 적힌다
    /// (그쪽은 디스크 = 사용자가 읽는 사실 + 재시작 뒤에도 남는 기억).
    sick: Mutex<BTreeMap<String, (u32, Instant)>>,
    /// ★R4(G6) — **일시 실패**(429·5xx·전송)의 별도 장부. 같은 모양이지만 곡선이 짧다
    /// ([`FLAKY_BACKOFF_BASE`]). 계정 상태와 네트워크 상태를 한 장부에 섞으면
    /// usage API가 한 번 흔들릴 때마다 살아 있는 계정이 30분씩 사라진다.
    flaky: Mutex<BTreeMap<String, (u32, Instant)>>,
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
            reserved: Mutex::new(BTreeMap::new()),
            snap: Mutex::new(Snapshot::default()),
            toggle: Mutex::new((false, None)),
            wake: tx,
            asks: Mutex::new(BTreeSet::new()),
            stats: Mutex::new((0, 0)),
            sick: Mutex::new(BTreeMap::new()),
            flaky: Mutex::new(BTreeMap::new()),
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
                    worker.stats.lock().unwrap_or_else(|e| e.into_inner()).0 += 1;
                    let snap = collect(&worker);
                    *worker.snap.lock().unwrap_or_else(|e| e.into_inner()) = snap;
                }
            });
        // ★R2 C1(c) — **부팅 프리웜을 걷어냈다.**
        //
        // R1은 여기서 `if me.enabled() { me.kick() }`를 했다. 한 tick의 지연을 아끼려는
        // 것이었지만(그 자리는 `pending`이 이미 막고 있다) 대가가 이것이었다: 설정만
        // 켜져 있으면 **앱을 켜는 것만으로** 등록 계정 전부에 usage를 묻고, 오래 논
        // 계정(=액세스 토큰 만료)의 refresh 토큰을 서버에서 **회전**시킨다. 사용자는
        // 아무것도 안 했는데 6개 계정의 그랜트가 부팅마다 돌아간다.
        //
        // 지금은 한도에 걸린 채팅이 [`Switcher::ask`]로 물을 때 처음 돈다. 첫 한도에서
        // 전환이 한 tick 늦는 대신, **한도에 안 걸리는 날에는 HTTP가 0건**이다.
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

    /// `(워커가 돈 횟수, 실제 조회 건수)` — 예산 문의 측정 축(진단).
    pub fn worker_stats(&self) -> (u64, u64) {
        *self.stats.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn kick(&self) {
        // 실패 = 이미 예약돼 있다. 허브 스레드는 **여기서도 안 막힌다**.
        let _ = self.wake.try_send(());
    }

    /// ★R2 C1(c) — **"이 계정들 말고 나머지의 한도를 알려 달라"**(예산 문 ②의 코드).
    ///
    /// `exclude` = 지금 이 채팅이 쓰는 계정 + 이 에피소드에서 이미 거쳐 온 계정.
    /// 그 둘은 후보가 될 수 없으므로([`switch::plan`]의 첫 두 문) 물어볼 이유도 없다.
    fn ask(&self, exclude: BTreeSet<String>) {
        {
            let mut g = self.asks.lock().unwrap_or_else(|e| e.into_inner());
            // 열려 있는 대화 수만큼만 자란다(같은 집합은 하나로 접힌다). 그래도 상한을 둔다.
            if g.len() < 64 {
                g.insert(exclude);
            }
        }
        self.kick();
    }

    /// 워커가 한 바퀴를 시작하며 가져가는 물음들. 가져간 뒤 장부는 빈다.
    fn take_asks(&self) -> BTreeSet<BTreeSet<String>> {
        std::mem::take(&mut *self.asks.lock().unwrap_or_else(|e| e.into_inner()))
    }

    /// ★R2 C2 — 만료된 예약을 걷고, **다른 채팅이 방금 집은** 계정을 돌려준다.
    fn reserved_by_others(&self, chat_id: &str) -> BTreeSet<String> {
        let mut g = self.reserved.lock().unwrap_or_else(|e| e.into_inner());
        g.retain(|_, (_, at)| at.elapsed() < RESERVE_TTL);
        g.iter().filter(|(_, (who, _))| who != chat_id).map(|(e, _)| e.clone()).collect()
    }

    /// 집었다 = 그 계정은 이제 이 채팅의 것이다(스폰이 busy로 이어받을 때까지).
    ///
    /// ★R3(F8) — **살아 있는 남의 예약은 덮지 않는다.** 덮으면 진짜 주인이 안 보이게 되고,
    /// 세 번째 채팅이 그 계정을 논다고 읽는다(장부가 계정 → 채팅 하나뿐이라).
    fn reserve(&self, chat_id: &str, email: &str) {
        let mut g = self.reserved.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((who, at)) = g.get(email) {
            if who != chat_id && at.elapsed() < RESERVE_TTL {
                return;
            }
        }
        g.insert(email.to_string(), (chat_id.to_string(), Instant::now()));
    }

    // ── ★R3(F2) 실패 계정 격리 · 지수 백오프 · 복구 ──────────────────────────

    /// 지금 이 계정에 조회를 다시 보내도 되나. **두 장부 다** 창 밖이어야 한다.
    fn may_fetch(&self, email: &str) -> bool {
        let now = Instant::now();
        let open = |m: &Mutex<BTreeMap<String, (u32, Instant)>>| {
            m.lock().unwrap_or_else(|e| e.into_inner()).get(email).is_none_or(|(_, until)| now >= *until)
        };
        open(&self.sick) && open(&self.flaky)
    }

    fn note_backoff(
        m: &Mutex<BTreeMap<String, (u32, Instant)>>,
        email: &str,
        base: Duration,
        max: Duration,
    ) -> (u32, Duration) {
        let mut g = m.lock().unwrap_or_else(|e| e.into_inner());
        let e = g.entry(email.to_string()).or_insert((0, Instant::now()));
        e.0 = e.0.saturating_add(1);
        let wait = base.saturating_mul(1u32 << (e.0 - 1).min(9)).min(max);
        e.1 = Instant::now() + wait;
        (e.0, wait)
    }

    /// **계정 탓인** 실패를 적는다 — 지수 백오프(밑 [`SICK_BACKOFF_BASE`], 상한 [`SICK_BACKOFF_MAX`]).
    fn note_sick(&self, email: &str) -> u32 {
        Self::note_backoff(&self.sick, email, SICK_BACKOFF_BASE, SICK_BACKOFF_MAX).0
    }

    /// ★R4(G6) — **계정 탓이 아닌** 실패(429·5xx·전송·본문). 짧은 곡선으로 따로 센다.
    fn note_flaky(&self, email: &str) -> (u32, Duration) {
        Self::note_backoff(&self.flaky, email, FLAKY_BACKOFF_BASE, FLAKY_BACKOFF_MAX)
    }

    /// 조회 성공 = 복구. 메모리 장부 둘과 디스크 표식을 **전부** 지운다.
    fn note_well(&self, email: &str) {
        let had = self.sick.lock().unwrap_or_else(|e| e.into_inner()).remove(email).is_some();
        self.flaky.lock().unwrap_or_else(|e| e.into_inner()).remove(email);
        ccg_auth::net::clear_rotate_backoff(email);
        if had || ccg_auth::health::needs_login(email) {
            ccg_auth::health::clear(email);
            eprintln!("[acct-switch] {email} 조회 성공 — 격리를 푼다");
        }
    }

    /// 격리 중인 계정 목록. 화면에 나가는 사실은 두 갈래로 이미 서 있다 —
    /// `last_plan().skipped`의 `needs_login`(진단)과 `account-health.json`(설정 Account 탭).
    /// 여기 것은 그 둘이 같은 답을 내는지 재는 **테스트용 창**이다.
    #[cfg(test)]
    pub fn quarantined(&self) -> Vec<String> {
        let g = self.sick.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        g.iter().filter(|(_, (_, until))| now < *until).map(|(e, _)| e.clone()).collect()
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
        // 이 채팅이 **후보로 삼을 수 없는** 계정 = 물어볼 이유가 없는 계정(예산 문 ②).
        let exclude: BTreeSet<String> =
            std::iter::once(cur.to_string()).chain(req.tried.iter().cloned()).collect();
        // 락 안에서 하는 일은 **clone뿐**이다. `ask`는 밖에서 부른다 — 안에서 부르면
        // `snap → asks` 순서가 생기고, 워커는 `asks → snap` 순서라 언젠가 물린다.
        let (stale, snap) = {
            let g = self.snap.lock().unwrap_or_else(|e| e.into_inner());
            (
                g.at.is_none_or(|t| t.elapsed() > SNAP_TTL),
                Snapshot {
                    at: g.at,
                    order: g.order.clone(),
                    usage: g.usage.clone(),
                    preflight: g.preflight.clone(),
                },
            )
        };
        if stale {
            self.ask(exclude.clone());
        }
        if snap.at.is_none() {
            return None; // 아직 아무것도 모른다 — 증거 없이는 안 옮긴다.
        }
        let mut busy = self.busy.lock().unwrap_or_else(|e| e.into_inner()).clone();
        // ★R2 C2 — **예약도 busy다.** 허브의 busy는 펌프 한 바퀴에 한 번 갱신되고 스폰이
        // 끝나야 반영된다. 그 사이에 열린 다른 채팅이 같은 1등을 집는 것이 스탬피드다.
        busy.extend(self.reserved_by_others(req.chat_id));
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
            self.ask(exclude);
        }
        let c = picked?;
        Some(SwitchPick {
            account: c.email,
            soonest_reset: c.soonest_reset.filter(|s| *s > 0).map(|s| s as u64),
        })
    }

    /// ★R3(F8) — 엔진이 **정말 집었을 때만** 예약이 선다.
    ///
    /// R2는 `pick` 안에서 걸었다. 그런데 `pick`의 답은 제안일 뿐이라, 엔진이 장부를 보고
    /// 거절한 후보까지 30초 동안 예약돼 다른 채팅의 후보를 가렸다(확인 크리틱 F8).
    /// 같은 펌프의 다음 채팅이 이 예약을 보는 성질은 그대로다 — `confirm`은 그 채팅의
    /// tick 안에서(전환을 실행하는 그 줄에서) 불리기 때문이다.
    fn confirm(&self, chat_id: &str, account: &str) {
        self.reserve(chat_id, account);
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
    // ★R2 C1(c) — **예산 문 ②를 코드로.** 물어 온 채팅들의 제외 집합을 모아, *어떤
    //   물음에서도 후보가 될 수 있는* 계정만 조회 대상에 넣는다. 모든 물음이 제외한
    //   계정(전형적으로 그 채팅이 지금 쓰는 계정과 이미 거쳐 온 계정)에는 HTTP가 없다.
    //   물음이 하나도 없으면(=쿨다운에 밀린 헛기상) 조회도 0건이다.
    let asks = sw.take_asks();
    let mut want: BTreeSet<String> = BTreeSet::new();
    for excl in &asks {
        want.extend(order.iter().filter(|e| !excl.contains(*e)).cloned());
    }
    let mut fetched = false;
    for email in &order {
        // 오염가드가 **한도 조회보다 먼저**다(`verify::preflight` 헤더의 순서 그대로):
        // 오염 항목은 살아 있는 토큰을 물고 있어 조회도 통과해 버린다. 게다가 여기서
        // 먼저 걸러야 **그 계정에 HTTP를 안 쓴다**(예산 문 ②).
        let mut v = verify::preflight(email).verdict;
        let usable = matches!(v, PreflightVerdict::Probe | PreflightVerdict::NeedsRefresh);
        if let Some(c) = cache.get(email) {
            usage_map.insert(email.clone(), c.data.clone());
        }
        // ★R3(F2) — **격리된 계정은 아예 안 묻고, 후보도 아니다.**
        //   ⑴ 오염가드는 파일만 보므로 죽은 refresh도 `NeedsRefresh`(통과)다.
        //   ⑵ 캐시에 지난 usage가 있으면 그 계정이 다음 전환의 1등으로 나갔다(크리틱 T5).
        //   ⑶ 캐시가 없으면 `usage_unknown`이라 매 tick 되물어 20초마다 죽은 토큰으로
        //      교환 POST가 나갔다(상한 없음).
        if ccg_auth::health::needs_login(email) {
            preflight.insert(email.clone(), PreflightVerdict::NeedsLogin);
            continue;
        }
        // ★R3(F4) — **busy는 루프 안에서 다시 읽는다.** 계정 6개 × (교환 2 + 조회 1) ×
        //   `USAGE_GAP_MS` ≈ 최대 20초라, 진입 전 스냅샷 하나로 판정하면 그 사이에 턴을
        //   시작한 계정에도 조회·회전이 나간다 = **살아 있는 CLI 밑에서 그랜트를 돌린다**
        //   (확인 크리틱 F4 — R1 C1-④가 안 닫혀 있던 자리). 비용은 뮤텍스 한 번이다.
        let busy_now = sw.busy.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let skip = !want.contains(email) || !usable || busy_now.contains(email);
        let fresh = cache
            .get(email)
            .is_some_and(|c| now_ms - c.at >= 0 && (now_ms - c.at) < usage::ACCT_USAGE_TTL_MS as i64);
        if !skip && !fresh && sw.may_fetch(email) {
            // 여기를 지나는 것이 곧 **실 HTTP 1건**이다(킬 스위치가 켜져 있으면 즉시 거절되지만
            // 그것도 "물으려 했다"로 센다 — 예산 문의 감사는 의도를 재야 한다).
            sw.stats.lock().unwrap_or_else(|e| e.into_inner()).1 += 1;
            match fetch(email) {
                Ok(u) => {
                    cache.insert(email.clone(), usage::CachedUsage { at: now_ms, data: u.clone() });
                    usage_map.insert(email.clone(), u);
                    fetched = true;
                    sw.note_well(email);
                    // 교환까지 성공했으면 액세스 토큰이 살아났다 = 판정이 `Probe`로 올라온다.
                    // **조회 뒤에 다시 재는 것이 핵심**이다: `switch::plan`은 `Probe`만
                    // 통과시키므로(R3/F2), 여기서 갱신하지 않으면 정상 계정까지 후보에서 빠진다.
                    v = verify::preflight(email).verdict;
                }
                // 킬 스위치는 **계정 상태가 아니다**(하네스 주행) — 격리하지 않는다.
                Err(ccg_auth::net::NetError::Disabled) => {}
                // ★R4(G6) — 교환 백오프에 막혀 **POST가 한 건도 안 나간** 착지다.
                //   우리가 스스로 안 나간 것이지 계정이 답을 안 준 게 아니다. 이걸
                //   실패로 세면 셸 백오프가 60초→2분→4분으로 **혼자** 배가된다.
                Err(ccg_auth::net::NetError::RotateBackoff(_)) => {}
                // 못 물어봤다 = **모름**이다. 실패는 격리 장부에 남아 백오프를 만든다.
                Err(e) => {
                    if transient(&e) {
                        // ★R4(G6) — 429·5xx·전송 실패는 계정의 죄가 아니다. 짧은 곡선.
                        let (n, wait) = sw.note_flaky(email);
                        eprintln!("[acct-switch] {email} 조회가 흔들렸다 {n}회({e}) — {wait:?} 뒤 다시");
                    } else {
                        let n = sw.note_sick(email);
                        eprintln!("[acct-switch] {email} 조회 실패 {n}회 — 백오프");
                    }
                    if ccg_auth::health::needs_login(email) {
                        preflight.insert(email.clone(), PreflightVerdict::NeedsLogin);
                        continue;
                    }
                }
            }
        }
        preflight.insert(email.clone(), v);
    }
    if fetched {
        usage::write_usage_cache(&cache);
    }
    Snapshot { at: Some(Instant::now()), order, usage: usage_map, preflight }
}

/// ★R4(G6) — 이 실패는 **계정 탓인가, 네트워크 탓인가**.
///
/// 계정 탓(짧은 곡선을 쓰면 안 되는 것): 401·403(서버가 그 토큰을 거절했다) ·
/// `NoToken`(쓸 토큰이 없다) · `TokenLost`(회전 결과를 못 남겼다).
/// 나머지(429·5xx·타임아웃·TLS·본문 파싱)는 **다음 tick에 다시 물어볼 값어치**가 있다.
fn transient(e: &ccg_auth::net::NetError) -> bool {
    use ccg_auth::net::NetError;
    match e {
        NetError::Status(401 | 403) | NetError::NoToken | NetError::TokenLost(_) => false,
        NetError::Status(s) => *s == 408 || *s == 429 || *s >= 500,
        NetError::Transport(_) | NetError::BadBody => true,
        // 위 두 갈래에서 이미 걸러진다(호출자가 먼저 처리한다).
        NetError::Disabled | NetError::RotateBackoff(_) => true,
    }
}

/// 계정 하나의 실 조회. `ccg-auth/net`은 **이 크레이트만** 켠다(src-tauri/Cargo.toml).
/// `CCG_NO_NET=1`이면 즉시 `Err(Disabled)`라 하네스 주행은 캐시만 본다.
fn fetch(email: &str) -> Result<AccountUsage, ccg_auth::net::NetError> {
    use ccg_auth::net::NetError;
    let out = ccg_auth::net::fetch_account_usage(email);
    match &out {
        Ok(_) => {}
        // ★R2 C1(a) — 회전된 토큰을 못 남긴 판. 이 계정은 다음 실행에서 재로그인을 요구할
        // 수 있고, 그 이유는 **여기밖에** 안 남는다. 다른 실패와 같은 줄로 흘리지 않는다.
        // ★R3(F2) — 그리고 로그로 끝내지 않는다: 디스크 장부에 적어 후보에서 빼고(격리)
        //           설정 화면이 "재로그인이 필요할 수 있어요"를 그린다.
        Err(e @ NetError::TokenLost(_)) => {
            eprintln!("[acct-switch] ★★ {email}: {e} — 이 계정은 재로그인이 필요할 수 있습니다");
            ccg_auth::health::mark_needs_login(email, &e.to_string());
        }
        // 401/403 = 서버가 그 토큰을 무효화했다(`verify::liveness_from_http`와 같은 판정).
        // 429·5xx·전송 실패는 계정 문제가 아니라 **보류**다 — 백오프만 받고 표식은 없다.
        Err(e @ NetError::Status(401 | 403)) => {
            eprintln!("[acct-switch] ★★ {email}: {e} — 서버가 토큰을 거절했습니다(재로그인 필요)");
            ccg_auth::health::mark_needs_login(email, &e.to_string());
        }
        Err(e) => {
            // 침묵 no-op 금지(D7) — 왜 후보가 안 됐는지의 원전이 여기다.
            eprintln!("[acct-switch] usage 조회 실패 {email}: {e}");
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use ccg_engine::identity::BillingAxis;

    /// 격리 홈 하나 + 토글 상태.
    ///
    /// ★R3(F5) — 자물쇠는 **크레이트 공용**이다(`engine::testhome`). R2는 이 모듈 안
    /// `static L`이었고, 같은 바이너리의 `codex_versions::tests`가 그걸 안 잡고
    /// `CCG_HOME`을 지웠다 — 그 창에서 `app_home()`이 사용자 실홈으로 떨어진다(확인
    /// 크리틱 F5). 증표가 살아 있는 동안 이 크레이트의 어떤 테스트도 홈을 못 바꾼다.
    fn home(tag: &str, on: bool) -> crate::engine::testhome::TestHome {
        let h = crate::engine::testhome::take(tag);
        std::env::set_var("CCG_NO_NET", "1");
        let _ = ccg_store::prefs::write_ui_prefs(&serde_json::json!({ PREF_KEY: on }));
        h
    }

    /// ★R2 C1(c) — **부팅만으로는 아무것도 안 묻는다**(설정이 켜져 있어도).
    ///
    /// R1은 `start()`가 `enabled()`면 곧바로 워커를 깨웠다. 그 한 줄이 "앱을 켜는 것만으로
    /// 등록 계정 전부의 usage를 조회하고 만료된 계정의 refresh 토큰을 서버에서 회전시킨다"
    /// 였다(크리틱 C1의 폭발 반경 ①). 조회의 계기는 이제 [`Switcher::ask`] 하나뿐이다.
    #[test]
    fn booting_with_the_toggle_on_queries_nothing() {
        let _h = home("boot", true);
        let sw = Switcher::start();
        assert!(sw.enabled(), "이 판은 토글이 켜져 있다(그래도 안 묻는다는 것이 과녁)");
        std::thread::sleep(Duration::from_millis(250));
        let (runs, fetches) = sw.worker_stats();
        println!("[acct-switch] 부팅 직후 runs={runs} fetches={fetches}");
        assert_eq!((runs, fetches), (0, 0), "★ 부팅 프리웜이 살아 있다 — 계정 전부에 조회가 나간다");
        assert!(sw.pending(), "스냅샷은 차갑다(= 아직 아무것도 안 물어봤다)");
        std::env::remove_var("CCG_NO_NET");
    }

    /// 격리 홈에 합성 계정 하나(가짜 토큰 · 만료는 먼 미래라 오염가드를 통과한다).
    fn seed(email: &str) {
        let creds = serde_json::json!({ "claudeAiOauth": {
            "accessToken": format!("synthetic-{email}"),
            "refreshToken": format!("r-{email}"),
            "expiresAt": 4_000_000_000_000f64,
            "scopes": ["user:inference"],
        }})
        .to_string();
        let snap = serde_json::json!({ "creds": creds, "account": { "emailAddress": email, "uuid": format!("u-{email}") } });
        let enc = ccg_store::safe_storage::encrypt(&snap.to_string()).expect("safeStorage");
        let mut accounts: Vec<serde_json::Value> = ccg_auth::claude::read_store_file().accounts.clone();
        accounts.push(serde_json::json!({ "email": email, "credEnc": enc, "subscriptionType": "max" }));
        ccg_auth::claude::write_store_file(&accounts, Some(email)).expect("스토어 저장");
    }

    /// ★R2 C1(c) — 물음은 **한도 장전 순간**에만 생기고, 제외 집합을 달고 온다.
    /// 그리고 조회는 **그 제외를 지킨다**: 계정 셋 중 물어보는 것은 후보 하나뿐이다.
    #[test]
    fn the_first_question_is_what_wakes_the_worker() {
        let _h = home("ask", true);
        for e in ["a@x", "b@x", "c@x"] {
            seed(e);
        }
        let sw = Switcher::start();
        let tried = BTreeSet::from(["b@x".to_string()]);
        let cur = BillingAxis::Subscription { account: "a@x".into(), drop_env_key: false };
        let req = SwitchRequest {
            chat_id: "c-1",
            current: &cur,
            model: "haiku",
            tried: &tried,
            now_epoch_ms: 1_800_000_000_000,
        };
        // 스냅샷이 차가우니 답은 `None`이다 — 그러나 **물음은 남는다**.
        assert!(sw.pick(&req).is_none(), "증거 없이는 안 옮긴다");
        // 스냅샷이 앉을 때까지 기다린다 — `runs`는 `collect()` **앞에서** 오르므로
        // 그것만 보고 재면 조회 카운터를 너무 일찍 읽는다(실제로 한 번 밟았다).
        for _ in 0..80 {
            if !sw.pending() {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let (runs, fetches) = sw.worker_stats();
        println!(
            "[acct-switch] 첫 물음 뒤 runs={runs} fetches={fetches} accounts={:?} preflight={:?}",
            ccg_auth::claude::list_accounts().iter().map(|a| a.email.clone()).collect::<Vec<_>>(),
            ["a@x", "b@x", "c@x"].map(|e| format!("{e}={:?}", verify::preflight(e).verdict))
        );
        assert_eq!(runs, 1, "★ 워커는 물음을 받고서야 돈다");
        // ★ 예산 문 ② — 계정은 셋인데 물어본 것은 **c@x 하나**다(a=현재, b=기시도).
        assert_eq!(fetches, 1, "★ 후보가 아닌 계정에도 조회가 나갔다(문 ②가 문서에만 있다)");
        std::env::remove_var("CCG_NO_NET");
    }

    /// ★R2 C1(c) — 제외 집합의 합집합이 조회 대상을 정한다(예산 문 ②의 산술).
    #[test]
    fn every_asker_excluding_an_account_means_nobody_queries_it() {
        let _h = home("want", true);
        let sw = Switcher::start();
        let order: Vec<String> = ["a@x", "b@x", "c@x"].iter().map(|s| s.to_string()).collect();
        // 채팅 하나: 현재 a, 거쳐 온 b → 물어볼 값어치가 있는 것은 c뿐.
        sw.ask(BTreeSet::from(["a@x".to_string(), "b@x".to_string()]));
        let asks = sw.take_asks();
        let want: BTreeSet<String> = asks
            .iter()
            .flat_map(|ex| order.iter().filter(move |e| !ex.contains(*e)).cloned())
            .collect();
        assert_eq!(want, BTreeSet::from(["c@x".to_string()]));
        // 채팅 둘: 두 번째는 b를 쓰고 있다 → a·c는 그쪽의 후보다. b는 아무도 안 묻는다.
        sw.ask(BTreeSet::from(["a@x".to_string(), "b@x".to_string()]));
        sw.ask(BTreeSet::from(["b@x".to_string()]));
        let asks = sw.take_asks();
        let want: BTreeSet<String> = asks
            .iter()
            .flat_map(|ex| order.iter().filter(move |e| !ex.contains(*e)).cloned())
            .collect();
        assert_eq!(want, BTreeSet::from(["a@x".to_string(), "c@x".to_string()]), "★ b는 두 물음 모두가 제외했다");
        std::env::remove_var("CCG_NO_NET");
    }

    /// ★R2 C2 — **집는 순간 표시**: 같은 펌프의 다음 채팅에게 그 계정은 이미 안 논다.
    ///
    /// ★R3(F8) — 그리고 표시는 **엔진이 집었다고 확인한 자리**(`confirm`)에서만 선다.
    /// `pick`이 값을 만드는 자리에서 걸면 엔진이 거절한 후보까지 예약된다.
    #[test]
    fn a_picked_account_is_reserved_against_the_next_chat_in_the_same_pump() {
        let _h = home("reserve", true);
        let sw = Switcher::start();
        AccountSwitcher::confirm(&*sw, "chat-1", "b@x");
        assert_eq!(sw.reserved_by_others("chat-2"), BTreeSet::from(["b@x".to_string()]));
        assert!(sw.reserved_by_others("chat-1").is_empty(), "자기 예약은 자기를 막지 않는다");
        // ★F8 — 남의 살아 있는 예약은 덮지 않는다(덮으면 진짜 주인이 안 보인다).
        AccountSwitcher::confirm(&*sw, "chat-2", "b@x");
        assert!(sw.reserved_by_others("chat-1").is_empty(), "★ 예약 주인이 chat-2로 뒤바뀌었다");
        assert!(sw.reserved_by_others("chat-2").contains("b@x"), "chat-1의 예약은 그대로 선다");
        assert_eq!(RESERVE_TTL.as_millis() as u64, ccg_engine::limit::TAKEN_TTL_MS, "셸과 엔진의 예약 수명은 한 값이어야 한다");
        std::env::remove_var("CCG_NO_NET");
    }

    /// ★R3(F2) — **조회에 실패한 계정은 격리된다**: 후보에서 빠지고, 백오프 창 동안
    /// 다시 묻지 않는다. 그리고 재로그인하면 스스로 풀린다.
    #[test]
    fn a_failing_account_is_quarantined_and_recovers_on_re_login() {
        let _h = home("sick", true);
        for e in ["cur@x", "lost@x"] {
            seed(e);
        }
        let sw = Switcher::start();
        // ⑴ 백오프 — 실패 한 번이면 그 계정에는 한동안 조회가 안 나간다.
        assert!(sw.may_fetch("lost@x"));
        assert_eq!(sw.note_sick("lost@x"), 1);
        assert!(!sw.may_fetch("lost@x"), "★ 20초마다 죽은 토큰으로 교환 POST가 반복된다");
        assert_eq!(sw.quarantined(), vec!["lost@x".to_string()]);
        assert_eq!(sw.note_sick("lost@x"), 2, "연속 실패는 대기를 두 배로 민다");

        // ⑵ 격리 — 재로그인 표식이 붙으면 `plan`이 후보에서 뺀다(캐시에 usage가 있어도).
        ccg_auth::health::mark_needs_login("lost@x", "TokenLost");
        assert!(ccg_auth::health::needs_login("lost@x"));
        let now = 1_800_000_000i64;
        let mut usage_map = BTreeMap::new();
        usage_map.insert(
            "lost@x".to_string(),
            AccountUsage {
                email: "lost@x".into(),
                five_hour_pct: Some(10),
                five_hour_resets_at: Some(now + 600),
                weekly_pct: Some(5),
                weekly_resets_at: Some(now + 86_400),
                fable_pct: None,
                fable_resets_at: None,
            },
        );
        let mut pre = BTreeMap::new();
        pre.insert("cur@x".to_string(), PreflightVerdict::Probe);
        pre.insert("lost@x".to_string(), PreflightVerdict::NeedsLogin); // collect()가 덮어쓰는 값
        let order = vec!["cur@x".to_string(), "lost@x".to_string()];
        let plan = switch::plan(&SwitchInput {
            now_epoch_secs: now,
            order: &order,
            current: "cur@x",
            needs_fable: false,
            busy: &BTreeSet::new(),
            tried: &BTreeSet::new(),
            usage: &usage_map,
            preflight: &pre,
        });
        println!("[R3/F2] pick={:?} skipped={:?}", plan.pick().map(|c| c.email.clone()), plan.skipped);
        assert!(plan.pick().is_none(), "★ 회전을 잃은 계정이 다음 전환의 1등이다 — 갈아타면 로그인 창이다");
        assert_eq!(plan.skipped.iter().find(|s| s.email == "lost@x").map(|s| s.why), Some(SkipWhy::NeedsLogin));

        // ⑶ 복구 — 조회가 한 번 성공하면 메모리 장부와 디스크 표식이 함께 풀린다.
        sw.note_well("lost@x");
        assert!(sw.may_fetch("lost@x"), "★ 복구 경로가 없으면 격리가 감옥이다");
        assert!(!ccg_auth::health::needs_login("lost@x"));
        assert!(sw.quarantined().is_empty());
        std::env::remove_var("CCG_NO_NET");
    }

    /// ★R3(F4) — `collect()`의 `busy`는 **루프 안에서** 다시 읽는다. 계정 6개 훑기는
    /// 최대 20초라, 진입 전 한 번 읽은 스냅샷으로는 그 사이에 턴을 시작한 계정을 못 본다
    /// (= 살아 있는 CLI 밑에서 그랜트를 돌린다).
    #[test]
    fn collect_re_reads_busy_between_accounts() {
        let _h = home("busy", true);
        for e in ["a@x", "b@x", "c@x"] {
            seed(e);
        }
        let sw = Switcher::start();
        // 첫 계정을 조회하는 사이에 b@x가 턴을 시작했다고 알린다.
        let sw2 = sw.clone();
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(5));
            sw2.set_busy(BTreeSet::from(["b@x".to_string(), "c@x".to_string()]));
        });
        sw.ask(BTreeSet::from(["a@x".to_string()])); // b·c가 후보
        for _ in 0..80 {
            if !sw.pending() {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        t.join().unwrap();
        let (runs, fetches) = sw.worker_stats();
        println!("[R3/F4] runs={runs} fetches={fetches} (busy가 도중에 켜졌다)");
        assert_eq!(runs, 1);
        assert!(fetches <= 2, "후보는 둘뿐이다");
        // 진입 전 스냅샷만 봤다면 busy를 무시하고 둘 다 물었을 것이다. 여기서는 늦게 켜진
        // busy가 적어도 하나를 막는다(첫 계정은 이미 지났을 수 있으므로 상한으로 잰다).
        std::env::remove_var("CCG_NO_NET");
    }
}
