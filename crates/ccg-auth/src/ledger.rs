//! ★R28e(CASX2) — `accounts.json`에 대한 **우리 쓰기·읽기의 장부**, 그리고 로그아웃 툼스톤.
//!
//! # 왜 이 파일이 생겼나 — 네 라운드가 같은 자리에서 미끄러진 이유
//!
//! R28d(CASX)의 되살리기는 「우리 갈아끼우기가 묻은 이웃(2.6.2)의 통짜 쓰기를 파내
//! 그들의 로그아웃을 다시 적용한다」이다. 그 판정의 근거가 라운드마다 **추론**이었다:
//!
//! | 라운드 | 근거 | 깨진 자리(확인 크리틱) |
//! |---|---|---|
//! | R2/R3 | 이메일만 보고 지운다 | 커밋 뒤에 앉은 **재로그인**을 지웠다(R3 §3-1) |
//! | R4 | 지울 행이 **커밋한 바이트 그대로**일 때만 지운다 | 우리 **배경 회전**이 그 행을 다시 쓰면 「재로그인」으로 오독 → 로그아웃 영구 취소(R4 §3-1) |
//! | R4 | 지우기가 **둘 이상이면** 오독한 통짜 쓰기다 | 이웃 스냅샷이 우리 로그인 **하나만큼** 낡아도 걸린다 → 진짜 로그아웃 영구 취소(R4 §3-2) |
//!
//! 둘 다 같은 병이다. **바이트도 개수도 「그들 스냅샷에 그 계정이 있었나」를 대신 못 센다.**
//! 그래서 이 라운드는 패치를 하나 더 얹는 대신 근거를 바꾼다 — 추론을 걷어내고
//! **우리가 실제로 본/쓴 상태의 기록**과 **의도의 영속 기록(툼스톤)**을 근거로 세운다.
//!
//! # 이 장부가 드는 것
//!
//! 1. **세대 링**(`ring`) — 우리가 잠금 안에서 **읽은** 목록과 **쓴** 목록 한 벌씩을,
//!    `(이메일, 행 지문)`의 집합으로 [`RING`]개까지 시간순으로 든다. 지문은 행 내용의
//!    해시다(토큰 원문은 안 든다).
//! 2. **신원 세대**(`origin`) — 이메일마다 *그 행의 신원이 선 세대*. 회전(credEnc만 갱신)은
//!    이 값을 **안 올린다**. 올리는 것은 「행이 새로 나타났다」와 「회전이라고 선언하지 않은
//!    내용 변경」뿐이다. 이 한 칸이 R4 §3-1(회전 ↔ 재로그인 혼동)을 닫는다.
//! 3. **툼스톤**(`accounts.logout.json`) — 우리가 실행하거나 되살린 로그아웃의 영속 기록
//!    (이메일 · 시각 · 주체 · 그때 행의 지문). 프로세스 재시작을 넘어 산다.
//!
//! # 판정 규칙 — [`attribute`]
//!
//! 파낸 이웃 원문 `theirs`가 주어지면, **그들의 스냅샷이 우리 장부의 어느 세대였나**를
//! 먼저 짚는다(그들이 그대로 남긴 행들이 우리가 쓴 바로 그 지문이라서 짚을 수 있다).
//! 그 세대를 짚으면 「그들이 지운 계정」은 추론이 아니라 **차집합**이 된다.
//!
//! 짚는 자리가 여럿이면 **가장 적게 지우는 쪽**을 고른다. 하나도 못 짚으면 **한 건도
//! 안 지운다.**
//!
//! ## ★ 우선순위(코드가 이 순서로 진다)
//!
//! > **되살릴지 말지 확신이 없으면 되살리지 않는다.**
//! >
//! > 로그아웃된 계정이 `credEnc`째 부활하는 쪽이, 행 하나가 사라져 사용자가 다시
//! > 추가하는 쪽보다 훨씬 나쁘다. 부활한 계정은 **살아 있는 토큰**을 들고 조용히
//! > 돌아오고, 사라진 행은 사용자 눈에 보이며 다시 로그인하면 끝이다.
//!
//! 그래서 이 모듈의 모든 「모르겠다」는 **안 지움**이 아니라 — 잠깐, 방향을 정확히 적는다.
//! 이 모듈이 판정하는 것은 *「그들의 로그아웃을 다시 적용할까」*이고, 적용은 **행을
//! 지우는 것**이다. 위 우선순위를 이 판정에 옮기면 이렇게 된다:
//!
//! | 모르는 것 | 답 |
//! |---|---|
//! | 그들 스냅샷이 어느 세대인지 모른다 | **아무것도 안 지운다**(= 그들의 로그아웃은 이번엔 못 살린다) |
//! | 그 행의 신원이 그들 스냅샷보다 새것인지 모른다 | **그 행은 안 지운다** |
//! | 후보 세대가 서로 다른 계정을 가리킨다 | **아무것도 안 지운다** |
//!
//! 세 줄 다 「지우지 않는다」로 진다. 그 대가는 **그들의 로그아웃을 한 번 놓치는 것**이고
//! (사용자에게는 「지운 계정이 아직 목록에 있다」 → 한 번 더 지우면 끝난다), 반대쪽으로
//! 틀렸을 때의 대가는 **사용자가 방금 로그인한 계정이 `credEnc`째 사라지는 것**이다.
//! 후자에 출구가 없다 — 그래서 이 방향이다.
//!
//! # 이 장부가 **하지 않는** 약속
//!
//! - **영속이 아니다**(툼스톤만 빼고). 세대 링은 프로세스 메모리다. 재시작하면 빈 장부로
//!   시작하고, 그 상태에서 파낸 원문은 **못 짚는다** → 안 지운다. 되살리기 창은 실측
//!   500ms짜리라(`claude::LATE_WATCH_MS`) 한 프로세스 안에서 열리고 닫히지만, 재시작
//!   직후 첫 커밋이 이웃 쓰기를 묻으면 그 한 건은 못 살린다. 보고서에 실측으로 적었다.
//! - **이웃의 회전을 못 짚는다.** 2.6.2가 자기 손으로 `credEnc`를 갈면(`auth.ts:485`)
//!   그 행의 지문은 우리 장부에 없다 → 앵커가 안 된다. 다른 행이 앵커가 되면 판정은
//!   그대로 서고, 앵커가 하나도 없으면 안 지운다.

use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::Mutex;

/// 행 하나의 지문(내용 해시). **토큰 원문은 안 든다** — 장부가 로그로 새면 안 되는 값을
/// 나르지 않게.
pub type Fp = u64;

/// 링에 드는 세대 수. 되살리기 창(실측 500ms)에 이웃의 `읽기→쓰기` 간격(2.6.2
/// `readStoreFile → deleteAccountDir → writeStoreFile`, 실측 ms 단위)을 더한 만큼만
/// 있으면 된다. 헤드라인 못의 배경 회전은 3ms마다 도니 512세대 ≈ 1.5초다.
const RING: usize = 512;

/// 로그아웃 툼스톤 파일 — **의도의 영속 기록**.
pub const TOMB_FILE: &str = "accounts.logout.json";
/// 툼스톤 상한(이메일당 마지막 하나만 남기고 오래된 것부터 버린다).
const TOMB_MAX: usize = 64;

// ── 세대 링 ─────────────────────────────────────────────────────────────────

/// 우리가 본/쓴 목록 한 벌.
#[derive(Debug)]
struct Snap {
    gen: u64,
    /// `(이메일, 행 지문)` — **이메일 순으로 정렬**해서 든다. 순서 변경만으로 새 세대가
    /// 생기지 않게(순서는 이 판정과 무관하다).
    rows: Vec<(String, Fp)>,
}

/// 이 이메일의 **신원이 선 자리**. 회전은 이 값을 안 올린다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Origin {
    pub gen: u64,
    pub by: By,
}

/// 신원이 선 **사유**. 판정에는 안 쓰고 **로그 한 줄이 사실을 말하게** 하는 데 쓴다
/// (확인 크리틱 R4 §5-4: *"관측한 것만 적어라"*).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum By {
    /// 장부의 첫 칸에 이미 있던 계정(= 이 프로세스가 보기 전부터 있었다).
    BeforeUs,
    /// 우리 로그인·편입이 놓았다([`Intent::Login`]).
    Us,
    /// 우리가 안 놓았는데 목록에 나타났다(= 이웃이 놓았다).
    Appeared,
    /// 이미 있던 행의 내용이 갈렸는데 **회전이라고 선언되지 않았다** — 보수적으로
    /// 「신원이 새로 섰다」로 친다.
    Rewrite,
}

impl By {
    pub fn label(self) -> &'static str {
        match self {
            By::BeforeUs => "장부가 서기 전부터 있던 행",
            By::Us => "우리 쪽 로그인",
            By::Appeared => "이웃이 놓은 행",
            By::Rewrite => "회전이라고 선언되지 않은 내용 변경",
        }
    }
}

/// 이 쓰기가 **무엇을 하려는 것인가**. 호출하는 쓰기 경로가 선언한다.
///
/// 딱 한 가지를 가른다: **[`Intent::Refresh`]로 선언된 내용 변경은 신원을 안 올린다.**
/// 나머지는 전부 보수적으로 「신원이 새로 섰다」로 친다(모르면 안 지우는 쪽으로 진다).
#[derive(Debug, Clone)]
pub enum Intent {
    /// 배경 토큰 회전 — `credEnc`만 갈았다. **신원은 그대로다.**
    Refresh(String),
    /// 로그인·편입 — 이 이메일의 신원이 새로 섰다.
    Login(String),
    /// 그 밖의 전부(순서·기본 계정·마이그레이션·되살리기·읽기 관측).
    Plain,
}

struct Led {
    /// 이 장부가 선 홈. 갈리면(테스트의 `CCG_HOME` 교체) 통째로 버린다 — 남의 홈에서
    /// 뜬 세대로 판정하면 그건 장부가 아니라 유령이다.
    home: PathBuf,
    next: u64,
    ring: VecDeque<Snap>,
    /// 링이 한 번이라도 밀렸나(= 그보다 앞선 상태는 이제 모른다).
    evicted: bool,
    origin: BTreeMap<String, Origin>,
    /// 툼스톤 캐시 — 디스크에서 한 번 읽고 이후 write-through.
    tombs: Option<Vec<Tomb>>,
}

static LED: Mutex<Option<Led>> = Mutex::new(None);

fn with<T>(f: impl FnOnce(&mut Led) -> T) -> T {
    let mut g = LED.lock().unwrap_or_else(|e| e.into_inner());
    let home = crate::app_home();
    let fresh = !matches!(&*g, Some(l) if l.home == home);
    if fresh {
        *g = Some(Led { home, next: 1, ring: VecDeque::new(), evicted: false, origin: BTreeMap::new(), tombs: None });
    }
    f(g.as_mut().expect("방금 채웠다"))
}

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

/// 행 하나의 지문. `serde_json::Map`은 기본 빌드에서 `BTreeMap`이라 순회 순서가
/// **키 정렬 순서로 고정**된다 — 같은 내용이면 같은 지문이다.
fn hash_value<H: Hasher>(v: &Value, h: &mut H) {
    match v {
        Value::Null => 0u8.hash(h),
        Value::Bool(b) => {
            1u8.hash(h);
            b.hash(h);
        }
        Value::Number(n) => {
            2u8.hash(h);
            n.to_string().hash(h);
        }
        Value::String(s) => {
            3u8.hash(h);
            s.hash(h);
        }
        Value::Array(a) => {
            4u8.hash(h);
            a.len().hash(h);
            for x in a {
                hash_value(x, h);
            }
        }
        Value::Object(m) => {
            5u8.hash(h);
            m.len().hash(h);
            for (k, x) in m {
                k.hash(h);
                hash_value(x, h);
            }
        }
    }
}

pub fn fp_of(row: &Value) -> Fp {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    hash_value(row, &mut h);
    h.finish()
}

fn rows_of(accounts: &[Value]) -> Vec<(String, Fp)> {
    let mut v: Vec<(String, Fp)> = accounts
        .iter()
        .filter_map(|a| a.get("email").and_then(Value::as_str).map(|e| (e.to_string(), fp_of(a))))
        .collect();
    v.sort();
    v
}

/// 지금 장부의 마지막 세대. [`attribute`]가 「그들 스냅샷은 이 세대 이하다」의 상한으로 쓴다.
pub fn gen_now() -> u64 {
    with(|l| l.ring.back().map(|s| s.gen).unwrap_or(0))
}

/// 이 이메일의 **지금 신원 세대**. 되살리기가 앉히기 직전에 다시 물어
/// 「그 사이에 신원이 갈렸나」를 본다(R4의 바이트 증표 자리를 대신한다).
pub fn origin_gen(email: &str) -> Option<u64> {
    with(|l| l.origin.get(email).map(|o| o.gen))
}

/// 목록 한 벌을 장부에 적는다 — **잠금 안에서 읽은 것**과 **잠금 안에서 쓴 것** 둘 다
/// 이 문을 지난다. 직전 세대와 내용이 같으면 새 세대를 안 만든다(회전이 초당 수백 번
/// 지나는 길이라 그래야 링이 의미 있는 상태만 든다).
pub fn note(accounts: &[Value], intent: &Intent) {
    let rows = rows_of(accounts);
    with(|l| {
        let prev: Option<Vec<(String, Fp)>> = l.ring.back().map(|s| s.rows.clone());
        if prev.as_ref().is_some_and(|p| *p == rows) {
            return;
        }
        let gen = l.next;
        l.next += 1;
        let first = prev.is_none();
        for (e, fp) in &rows {
            let was = prev.as_ref().and_then(|p| p.iter().find(|(pe, _)| pe == e).map(|(_, f)| *f));
            let (born, by) = match was {
                None if first => (true, By::BeforeUs),
                None if matches!(intent, Intent::Login(x) if x == e) => (true, By::Us),
                None => (true, By::Appeared),
                // ★ 내용이 갈렸다. **회전이라고 선언된 것만** 신원을 유지한다 —
                //   R4는 여기를 「바이트가 같은가」로 물었고, 그래서 우리 회전 한 바퀴가
                //   재로그인 행세를 했다(확인 크리틱 R4 §3-1의 결정적 재현).
                Some(pf) if pf != *fp && !matches!(intent, Intent::Refresh(x) if x == e) => {
                    (true, if matches!(intent, Intent::Login(x) if x == e) { By::Us } else { By::Rewrite })
                }
                Some(_) => (false, By::Rewrite),
            };
            if born {
                l.origin.insert(e.clone(), Origin { gen, by });
                // 그 이메일로 새 신원이 섰다 = 옛 툼스톤은 더 이상 이 행을 말하지 않는다.
                // (지문이 같으면 그건 새 신원이 아니라 **되살아난 시체**다 — 안 지운다.)
                clear_tomb_if_other_fp(l, e, *fp);
            }
        }
        if let Some(p) = prev {
            for (pe, _) in p.iter() {
                if !rows.iter().any(|(e, _)| e == pe) {
                    l.origin.remove(pe);
                }
            }
        }
        l.ring.push_back(Snap { gen, rows });
        if l.ring.len() > RING {
            l.ring.pop_front();
            l.evicted = true;
        }
    });
}

// ── 판정 ────────────────────────────────────────────────────────────────────

/// [`attribute`]의 답.
#[derive(Debug)]
pub enum Verdict {
    /// 그들의 쓰기는 우리 목록에서 아무것도 안 지웠다(= 되살릴 것이 없다).
    Nothing,
    /// **근거를 못 짚었다** — 한 건도 안 지운다. 문자열은 로그에 그대로 나가는 사유다.
    Blind(String),
    /// 지울 것 + 안 지운 후보와 그 사유 + 근거 요약.
    Act {
        /// `(이메일, 판정 당시의 신원 세대)` — 앉히기 직전에 세대를 다시 확인한다.
        remove: Vec<(String, u64)>,
        /// 후보였지만 안 지운 것 `(이메일, 사유)`.
        held: Vec<(String, String)>,
        /// 「어떤 근거로 그렇게 봤나」 한 줄.
        why: String,
    },
}

/// 파낸 이웃 원문 `theirs`를 우리 목록 `ours`에 견줘 **그들이 지운 계정**을 짚는다.
///
/// `at_gen` = 우리가 그들의 쓰기를 묻은 커밋 **직전**의 장부 세대. 그들의 읽기는 그
/// 커밋보다 앞이므로 후보는 이 세대 이하만 본다.
///
/// 자세한 규칙과 우선순위는 모듈 주석 참고. 요약하면 세 걸음이다:
/// **① 앵커로 그들 스냅샷을 짚는다 → ② 후보 중 가장 적게 지우는 것을 고른다 →
/// ③ 지울 행마다 「그 신원이 그들 스냅샷보다 앞선가」를 묻는다.**
pub fn attribute(ours: &[Value], theirs: &[Value], at_gen: u64) -> Verdict {
    let their_rows = rows_of(theirs);
    let their_emails: BTreeSet<String> = their_rows.iter().map(|(e, _)| e.clone()).collect();
    let mut gone: Vec<String> = Vec::new();
    for a in ours {
        if let Some(e) = a.get("email").and_then(Value::as_str) {
            if !their_emails.contains(e) && !gone.iter().any(|g| g == e) {
                gone.push(e.to_string());
            }
        }
    }
    if gone.is_empty() {
        return Verdict::Nothing;
    }
    with(|l| {
        let span = match (l.ring.front(), l.ring.back()) {
            (Some(a), Some(b)) => format!("{}~{}", a.gen, b.gen),
            _ => "없음".into(),
        };
        // ── ① 앵커 — 그들이 **그대로 남긴 행** 중 우리가 쓴 그 지문인 것 ────────────
        let anchors: Vec<(String, Fp)> = their_rows.iter().filter(|r| l.ring.iter().any(|s| s.rows.contains(r))).cloned().collect();
        if anchors.is_empty() {
            return Verdict::Blind(format!(
                "그들 원문의 계정 {}개 중 우리 장부가 아는 행이 하나도 없다(장부 세대 {span}) — 그 원문이 우리 어느 시점 목록에서 나온 것인지 못 짚는다",
                their_rows.len()
            ));
        }
        // ── ② 후보 세대 — 앵커를 전부 담고, 그들이 남긴 이메일을 전부 담은 세대 ──────
        let mut plausible: Vec<(u64, BTreeSet<String>)> = Vec::new();
        for s in l.ring.iter().filter(|s| s.gen <= at_gen) {
            if !anchors.iter().all(|a| s.rows.contains(a)) {
                continue;
            }
            if !their_emails.iter().all(|e| s.rows.iter().any(|(re, _)| re == e)) {
                continue;
            }
            let removed: BTreeSet<String> = s.rows.iter().map(|(e, _)| e.clone()).filter(|e| !their_emails.contains(e)).collect();
            if removed.is_empty() {
                continue; // 이 세대가 그들 스냅샷이었다면 그들은 아무것도 안 지운 것이다
            }
            plausible.push((s.gen, removed));
        }
        if plausible.is_empty() {
            return Verdict::Nothing;
        }
        // ★ 여럿이면 **가장 적게 지우는 쪽**. 이것이 모듈 주석의 우선순위를 코드로 옮긴
        //   자리다 — 후보가 갈리면 그들에게 더 적은 지우기를 귀속시킨다.
        let m = plausible.iter().map(|(_, r)| r.len()).min().unwrap_or(0);
        let mins: Vec<&(u64, BTreeSet<String>)> = plausible.iter().filter(|(_, r)| r.len() == m).collect();
        let mut pick = mins[0].1.clone();
        for (_, r) in mins.iter().skip(1) {
            pick.retain(|e| r.contains(e));
        }
        if pick.len() != m {
            return Verdict::Blind(format!(
                "그들 원문에 맞는 우리 상태가 {}개인데 서로 다른 계정을 가리킨다(가장 적은 지우기 {m}개 · 장부 세대 {span}) — 어느 쪽인지 못 고른다",
                mins.len()
            ));
        }
        let min_gen = mins.iter().map(|(g, _)| *g).min().unwrap_or(0);
        if l.evicted && l.ring.front().is_some_and(|s| s.gen == min_gen) {
            return Verdict::Blind(format!(
                "그들 원문이 가리키는 세대({min_gen})가 장부에 남은 가장 오래된 칸이다(장부 세대 {span}) — 그보다 앞선 상태는 이미 버려서 못 짚는다"
            ));
        }
        // ── ③ 행마다 「그 신원이 그들 스냅샷보다 앞선가」 ──────────────────────────
        let (mut remove, mut held) = (Vec::new(), Vec::new());
        for e in gone.iter() {
            if !pick.contains(e) {
                // 우리 목록엔 있고 그들 원문엔 없는데, **그들 스냅샷에도 없던** 행이다
                // (= 그들이 지운 것이 아니라 그 읽기 뒤에 앉은 행). 확인 크리틱 R4 §3-2가
                // 잡은 자리가 정확히 여기다 — R4는 이런 행을 「지우기 2건」으로 세어
                // 판정 전체를 거절했고, 그래서 **진짜 로그아웃**이 같이 죽었다.
                held.push((e.clone(), format!("그들 스냅샷(장부 세대 {min_gen})에 없던 행이다 — 그들이 지운 것이 아니다")));
                continue;
            }
            match l.origin.get(e) {
                None => held.push((e.clone(), "우리 장부에 그 계정의 신원이 언제 섰는지 기록이 없다".to_string())),
                Some(o) if o.gen > min_gen => held.push((
                    e.clone(),
                    format!("그 행의 신원은 세대 {}에서 섰고({}) 그들 스냅샷은 세대 {min_gen}이다 — 그들이 못 본 행이다", o.gen, o.by.label()),
                )),
                Some(o) => remove.push((e.clone(), o.gen)),
            }
        }
        if remove.is_empty() && held.is_empty() {
            return Verdict::Nothing;
        }
        Verdict::Act {
            remove,
            held,
            why: format!("그들 스냅샷 = 장부 세대 {min_gen}(맞는 세대 {}개 · 앵커 {}행 · 장부 {span})", mins.len(), anchors.len()),
        }
    })
}

// ── 로그아웃 툼스톤 — 의도의 영속 기록 ──────────────────────────────────────

/// 로그아웃 한 건의 영속 기록. **이메일 + 시각 + 주체**, 그리고 그때 그 행의 지문.
///
/// 지문을 같이 드는 이유는 하나다: 나중에 같은 이메일이 돌아왔을 때 **되살아난 시체**와
/// **사용자의 새 로그인**을 갈라야 하는데, 새 로그인은 `credEnc`가 새 DPAPI 산출물이라
/// 지문이 반드시 다르다. 지문이 **같으면** 그건 우리가 이미 지운 그 행이다.
#[derive(Debug, Clone)]
pub struct Tomb {
    pub email: String,
    pub at_ms: f64,
    pub by: String,
    pub fp: Fp,
}

fn tomb_path() -> PathBuf {
    crate::app_home().join(TOMB_FILE)
}

fn load_tombs() -> Vec<Tomb> {
    let Some(raw) = crate::read_file_or_null(&tomb_path()) else { return Vec::new() };
    let Ok(v) = serde_json::from_str::<Value>(&raw) else { return Vec::new() };
    let Some(arr) = v.get("tombstones").and_then(Value::as_array) else { return Vec::new() };
    arr.iter()
        .filter_map(|t| {
            Some(Tomb {
                email: t.get("email")?.as_str()?.to_string(),
                at_ms: t.get("at").and_then(Value::as_f64).unwrap_or(0.0),
                by: t.get("by").and_then(Value::as_str).unwrap_or("모름").to_string(),
                // 지문은 u64라 JSON 숫자로 나가면 f64에서 정밀도를 잃는다 — 문자열로 든다.
                fp: t.get("fp").and_then(Value::as_str).and_then(|s| s.parse().ok()).unwrap_or(0),
            })
        })
        .collect()
}

fn save_tombs(list: &[Tomb]) {
    let arr: Vec<Value> = list
        .iter()
        .map(|t| serde_json::json!({ "email": t.email, "at": t.at_ms, "by": t.by, "fp": t.fp.to_string() }))
        .collect();
    let body = crate::to_json_2space(&serde_json::json!({ "tombstones": arr }));
    if let Err(e) = ccg_store::write_home_file(TOMB_FILE, &body) {
        eprintln!("[auth] {TOMB_FILE} 저장 실패: {e} — 로그아웃 기록이 재시작을 못 넘는다");
    }
}

fn tombs_mut(l: &mut Led) -> &mut Vec<Tomb> {
    if l.tombs.is_none() {
        l.tombs = Some(load_tombs());
    }
    l.tombs.as_mut().expect("방금 채웠다")
}

fn clear_tomb_if_other_fp(l: &mut Led, email: &str, fp: Fp) {
    let list = tombs_mut(l);
    let before = list.len();
    list.retain(|t| t.email != email || t.fp == fp);
    if list.len() != before {
        let snapshot = list.clone();
        save_tombs(&snapshot);
    }
}

/// 로그아웃을 **영속 기록으로 남긴다.** 부르는 자리는 둘뿐이다 —
/// [`crate::claude::remove_account`](사용자가 이 앱에서 지웠다)와
/// 되살리기(이웃의 로그아웃을 파내 다시 적용했다).
pub fn bury(email: &str, by: &str, row: Option<&Value>) {
    let fp = row.map(fp_of).unwrap_or(0);
    with(|l| {
        let list = tombs_mut(l);
        list.retain(|t| t.email != email);
        list.push(Tomb { email: email.to_string(), at_ms: now_ms(), by: by.to_string(), fp });
        while list.len() > TOMB_MAX {
            list.remove(0);
        }
        let snapshot = list.clone();
        save_tombs(&snapshot);
    });
}

/// **툼스톤을 존중하는 걸러내기** — 마지막 성공본(`.bak`)에서 목록을 복구할 때 부른다.
///
/// 복구본은 「마지막으로 성공한 저장」이라 우리가 그 뒤에 실행한 로그아웃을 **아직 담고
/// 있을 수 있다.** 그 목록을 그대로 되쓰면 사용자가 지운 계정이 `credEnc`째 돌아온다 —
/// 이 갈래가 닫으려는 바로 그 사고다. 그래서 **지문이 그대로인 행만** 걷어낸다:
/// 지문이 다르면 그건 시체가 아니라 그 뒤에 앉은 새 로그인이다.
///
/// 돌려주는 것은 `(걸러낸 목록, 걸러낸 사연들)`.
pub fn without_buried(accounts: Vec<Value>) -> (Vec<Value>, Vec<String>) {
    with(|l| {
        if tombs_mut(l).is_empty() {
            return (accounts, Vec::new());
        }
        let tombs = tombs_mut(l).clone();
        let mut why = Vec::new();
        let kept = accounts
            .into_iter()
            .filter(|a| {
                let Some(e) = a.get("email").and_then(Value::as_str) else { return true };
                let fp = fp_of(a);
                match tombs.iter().find(|t| t.email == e && t.fp == fp) {
                    Some(t) => {
                        why.push(format!("{e}(로그아웃 기록: {} · 주체 {})", stamp(t.at_ms), t.by));
                        false
                    }
                    None => true,
                }
            })
            .collect();
        (kept, why)
    })
}

/// 로그에 쓰는 사람 읽을 시각(로컬 시각까지는 안 간다 — 크레이트가 시간대를 안 든다).
fn stamp(at_ms: f64) -> String {
    if at_ms <= 0.0 {
        return "시각 모름".into();
    }
    let secs = (at_ms / 1000.0) as u64;
    format!("epoch+{secs}s")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn acct(email: &str, cred: &str) -> Value {
        json!({ "email": email, "credEnc": cred, "subscriptionType": "max" })
    }

    /// ★ 이 라운드의 핵심 — **우리 회전은 신원을 안 올린다.**
    ///
    /// 확인 크리틱 R4 §3-1의 결정적 재현이 여기 있다: 로그아웃 대상 계정의 `credEnc`를
    /// 배경 회전이 한 바퀴 갈면, R4의 바이트 증표는 그것을 「재로그인」으로 읽고 그
    /// 로그아웃을 **영구히 취소했다.** 세대 장부는 회전과 재로그인을 **선언으로** 가른다.
    #[test]
    fn a_rotation_does_not_move_a_row_identity_but_a_re_login_does() {
        let home = ccg_store::testhome::take("ledger-origin");
        note(&[acct("mine@x", "c1"), acct("ghost@x", "g1")], &Intent::Plain);
        let born = origin_gen("ghost@x").expect("신원 세대");
        // 배경 회전 한 바퀴 — credEnc가 갈린다.
        note(&[acct("mine@x", "c1"), acct("ghost@x", "g2")], &Intent::Refresh("ghost@x".into()));
        assert_eq!(origin_gen("ghost@x"), Some(born), "★ 회전이 신원 세대를 올렸다 — R4 §3-1이 그 자리다");
        // 재로그인 — 같은 이메일에 새 credEnc가 **선언과 함께** 앉는다.
        note(&[acct("mine@x", "c1"), acct("ghost@x", "gNEW")], &Intent::Login("ghost@x".into()));
        assert!(origin_gen("ghost@x").expect("신원 세대") > born, "★ 재로그인이 신원 세대를 안 올렸다");
        // 선언 없는 내용 변경도 보수적으로 신원이 선 것으로 친다.
        let after = origin_gen("ghost@x").expect("신원 세대");
        note(&[acct("mine@x", "c1"), acct("ghost@x", "g4")], &Intent::Plain);
        assert!(origin_gen("ghost@x").expect("신원 세대") > after, "★ 모르는 내용 변경을 신원 유지로 봤다(보수적이지 않다)");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// ★ 확인 크리틱 R4 §3-2 — **이웃 스냅샷이 우리 로그인 하나만큼 낡은 판.**
    ///
    /// R4는 「지우기가 둘 이상이면 오독」이라는 개수 규칙으로 이 판을 통째로 거절했고
    /// (진짜 로그아웃 영구 취소), 그 앞 라운드는 반대로 새 로그인까지 지웠다. 장부는
    /// **그들 스냅샷 세대를 짚어** 둘을 가른다.
    #[test]
    fn a_stale_neighbour_snapshot_loses_only_the_account_it_actually_dropped() {
        let home = ccg_store::testhome::take("ledger-stale");
        note(&[acct("mine@x", "c1"), acct("bye@x", "b1")], &Intent::Plain); // 세대 1
        note(&[acct("mine@x", "c1"), acct("bye@x", "b1"), acct("new@x", "n1")], &Intent::Login("new@x".into())); // 세대 2
        let at = gen_now();
        // 이웃은 세대 1을 읽고 bye@x를 지운 목록을 썼다.
        let theirs = vec![acct("mine@x", "c1")];
        let ours = vec![acct("mine@x", "c1"), acct("bye@x", "b1"), acct("new@x", "n1")];
        match attribute(&ours, &theirs, at) {
            Verdict::Act { remove, held, why } => {
                println!("[ledger-stale] {why} · 지움={remove:?} · 보류={held:?}");
                assert_eq!(remove.iter().map(|(e, _)| e.as_str()).collect::<Vec<_>>(), ["bye@x"], "★ 진짜 로그아웃을 못 살렸거나 새 로그인까지 지웠다");
                assert_eq!(held.len(), 1, "★ 새 로그인을 보류한 사연이 안 남았다");
                assert!(held[0].0 == "new@x");
            }
            v => panic!("★ 판정이 Act가 아니다: {v:?}"),
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 이웃의 **오독 통짜 쓰기**(`{"accounts":[]}`)는 짚을 앵커가 없다 → 한 건도 안 지운다.
    #[test]
    fn a_body_we_cannot_date_removes_nothing() {
        let home = ccg_store::testhome::take("ledger-blind");
        note(&[acct("a@x", "a1")], &Intent::Plain);
        note(&[acct("a@x", "a1"), acct("b@x", "b1")], &Intent::Login("b@x".into()));
        let at = gen_now();
        let ours = vec![acct("a@x", "a1"), acct("b@x", "b1")];
        match attribute(&ours, &[], at) {
            Verdict::Blind(why) => println!("[ledger-blind] {why}"),
            v => panic!("★ 계정 0개짜리 원문을 근거로 삼았다: {v:?}"),
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 툼스톤은 **디스크에 남고**, 복구본에서 시체만 걷어낸다(새 로그인은 안 건드린다).
    #[test]
    fn a_tombstone_outlives_the_process_and_only_catches_the_corpse() {
        let home = ccg_store::testhome::take("ledger-tomb");
        let dead = acct("bye@x", "b1");
        bury("bye@x", "이 앱의 로그아웃", Some(&dead));
        assert!(tomb_path().is_file(), "★ 툼스톤이 디스크에 안 남았다");
        let (kept, why) = without_buried(vec![acct("mine@x", "c1"), dead.clone()]);
        println!("[ledger-tomb] 걸러냄={why:?}");
        assert_eq!(kept.len(), 1, "★ 복구본의 시체를 그대로 되살렸다");
        assert_eq!(why.len(), 1, "★ 걸러낸 사연이 안 남았다(침묵)");
        // 같은 이메일의 **새 로그인**은 지문이 달라 안 걸린다.
        let (kept2, why2) = without_buried(vec![acct("bye@x", "bNEW")]);
        assert_eq!(kept2.len(), 1, "★ 새 로그인을 시체로 오인했다");
        assert!(why2.is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }
}
