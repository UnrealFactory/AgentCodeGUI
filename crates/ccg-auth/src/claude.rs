//! Anthropic 구독 계정 — `~/.agentcodegui/accounts.json`(v3, v2 읽기) + 계정별 격리
//! `CLAUDE_CONFIG_DIR`. 원본: `src/main/auth.ts`.
//!
//! 규약 셋(어기면 사용자가 재로그인한다):
//! 1. **활성 계정/전환 개념이 없다.** 채팅이 계정을 바인딩하고, 미지정이면 `defaultEmail`.
//!    전역 `~/.claude`는 읽지도 쓰지도 않는다(1회 가져오기 마이그레이션 제외).
//! 2. **살아 있는 토큰의 거처는 계정 폴더**고 스토어의 `credEnc`는 폴더 재생성용 백업이다.
//!    실행이 끝나면 [`sync_account_tokens`]가 폴더 → 백업으로 되쓴다. 되쓰기 가드
//!    (accessToken 존재 + expiresAt 전진)를 빼면 401을 맞아 껍데기로 덮인 크리덴셜이
//!    백업까지 죽인다(1.6.2 스냅샷 오염과 같은 계열).
//! 3. **세션 기록은 정션으로 공유**한다. 정션이 아니면 resume이 계정별로 갈라져 죽는다
//!    (`junction.rs` 참조).

use crate::ledger;
use crate::{account_slug, junction, read_file_or_null, read_json_file, token_fingerprint, AuthError};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

pub const STORE_FILE: &str = "accounts.json";
/// ★M11 R4(G3/C7) — **마지막으로 성공한 저장의 사본.** 본문이 깨져 읽히면 여기서 되살린다.
///
/// R3는 "손상 위에서 계정을 잃지 않는다"를 약속했는데 그 자물쇠는 `merge3` 안에만 있었다.
/// 목록을 바꾸는 제품 경로([`update_store`])는 깨진 파일을 **빈 목록**으로 읽고 그 위에
/// 로그인 하나를 얹어 나머지 계정을 지웠다(R3 크리틱 C7). 본문이 깨지면 복구할 재료가
/// 있어야 그 약속이 성립한다 — 그 재료가 이 파일이다.
pub const STORE_BACKUP_FILE: &str = "accounts.json.bak";
/// v3 = defaultEmail 추가 + 전역 `~/.claude` 의존 제거. **계정 레코드 포맷은 v2와 같다.**
pub const STORE_VERSION: u64 = 3;

/// 계정 폴더끼리 정션으로 공유하는 것들 — 세션 기록(resume) + 도구 환경.
pub const SHARED_DIRS: &[&str] = &[
    "projects",
    "sessions",
    "session-env",
    "todos",
    "tasks",
    "teams",
    "agents",
    "skills",
    "plugins",
    "commands",
    "file-history",
];
/// 파일이라 정션이 안 된다 — 물질화 때마다 shared에서 복사한다(수 KB).
pub const COPIED_FILES: &[&str] = &["settings.json", "settings.local.json", "CLAUDE.md"];

pub fn accounts_dir() -> PathBuf {
    crate::app_home().join("accounts")
}
pub fn shared_root() -> PathBuf {
    crate::app_home().join("shared")
}
/// 로그인 임시 폴더 — 로그인 전엔 이메일을 모르므로 여기로 붙고 완료 후 편입한다.
pub fn login_dir() -> PathBuf {
    crate::app_home().join("login")
}
pub fn account_dir(email: &str) -> PathBuf {
    accounts_dir().join(account_slug(email))
}
fn store_path() -> PathBuf {
    crate::app_home().join(STORE_FILE)
}
fn store_backup_path() -> PathBuf {
    crate::app_home().join(STORE_BACKUP_FILE)
}

// ── 스토어 파일 ─────────────────────────────────────────────────────────────

/// ★M11 R4(G3) — 이 목록이 **어디서 왔나**. R3까지 [`read_store_file`]은 "파일이 없다"·
/// "깨져서 못 읽는다"·"마지막 계정을 로그아웃해 정말 비었다"를 전부 **빈 스토어** 한 가지로
/// 뭉갰다. 그 셋은 완전히 다른 사실이다:
///
/// | 출처 | 빈 목록의 뜻 | 병합·복구가 해야 할 일 |
/// |---|---|---|
/// | [`Missing`](StoreOrigin::Missing) | 첫 실행(또는 누가 파일을 지웠다) | 우리가 아는 목록이 있으면 되살린다 |
/// | [`Parsed`](StoreOrigin::Parsed) | **사실이다** — 계정이 정말 0개다 | 그대로 존중한다(로그아웃 취소 금지) |
/// | [`Unreadable`](StoreOrigin::Unreadable) | **모른다** — 반쪽 JSON·쓰레기 | 덮어쓰지 않는다 |
/// | [`Recovered`](StoreOrigin::Recovered) | 본문이 깨져 [`STORE_BACKUP_FILE`]에서 읽었다 | 그 목록으로 본문을 되살린다 |
/// | [`Foreign`](StoreOrigin::Foreign) | version이 v2/v3가 아니다(v1 이하 = 신원 없음) | 2.6.2와 같이 폐기 |
///
/// 이 구별이 없으면 안전문이 **정상적인 마지막 로그아웃**에도 발동해 지운 계정을
/// `credEnc`째 되살린다(R3 크리틱 C3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum StoreOrigin {
    #[default]
    Missing,
    Parsed,
    Unreadable,
    Recovered,
    Foreign,
}

impl StoreOrigin {
    /// 이 목록을 **사실로 믿어도 되나**. `false`면 빈 목록은 "0개"가 아니라 "모름"이다.
    pub fn is_known(self) -> bool {
        matches!(self, StoreOrigin::Missing | StoreOrigin::Parsed | StoreOrigin::Recovered | StoreOrigin::Foreign)
    }
}

/// `accounts.json` 한 장. 계정 레코드는 **원본 `Value` 그대로** 들고 다닌다 —
/// 모르는 키가 있어도 되쓸 때 살아 나가야 2.6.2로 되돌릴 수 있다.
#[derive(Debug, Clone, Default)]
pub struct StoreFile {
    pub version: u64,
    pub default_email: Option<String>,
    pub accounts: Vec<Value>,
    /// ★R4(G3) — 위 [`StoreOrigin`] 참고. 기본값은 `Missing`(= 아무것도 안 읽은 상태).
    pub origin: StoreOrigin,
}

pub fn email_of(a: &Value) -> Option<&str> {
    a.get("email").and_then(Value::as_str)
}
pub fn cred_enc_of(a: &Value) -> Option<&str> {
    a.get("credEnc").and_then(Value::as_str)
}
pub fn subscription_of(a: &Value) -> Option<&str> {
    a.get("subscriptionType").and_then(Value::as_str)
}

/// v2도 읽는다(계정 포맷 동일) — 마이그레이션 전에 불려도 계정이 사라져 보이지 않게.
/// v1 이하는 신원이 없어 무효 → 빈 스토어.
///
/// 버전은 **JS 의미론으로** 읽는다(`3.0 === 3`). `as_u64()`는 `"version": 3.0`(부동소수
/// 표기)에서 `None`을 내고 그러면 계정 0건 = 재로그인 화면이 된다 — 스토어가 통째로
/// 사라지는 실패 모드치고 대가가 너무 싸다(M5 R1 크리틱 §4-4). 문자열 `"3"`은 양쪽 다
/// 폐기다(JS도 `'3' !== 3`).
pub fn read_store_file() -> StoreFile {
    let f = read_store_raw().1;
    // ★R3(F1)② — 이 읽기를 3-way 병합의 **기준점**으로 남긴다(아래 `merge3` 참고).
    record_base(&f);
    f
}

/// 기준점을 **안 남기는** 읽기. 조회만 하는 자리(목록 그리기·크리덴셜 꺼내기)는
/// read-modify-write의 시작이 아니라서, 그런 읽기가 base를 갈아치우면 진짜
/// read-modify-write의 병합이 엉뚱한 기준점을 쓴다.
fn read_store_quiet() -> StoreFile {
    read_store_raw().1
}

/// ★R28d(CASX R3) — **「지금은 모른다」를 「0개」로 읽지 않는** 조회용 읽기.
///
/// [`read_store_quiet`]는 단발이다. 잠금을 모르는 이웃(2.6.2 `writeFileSync`)이 쓰는
/// **도중에** 걸리면 그 한 번의 읽기는 반쪽(`Unreadable`)이거나 아예 없고(`Missing`),
/// 그 값의 `accounts`는 **빈 목록**이다. 그런데 이 크레이트에서 빈 목록의 뜻은
/// "계정이 0개다"이지 "모른다"가 아니다. 그래서 그 한 판에
///
/// | 부르는 자리 | 단발 읽기가 만드는 오답 |
/// |---|---|
/// | [`freshest_creds`] | 회전 재료를 **못 찾는다** → 그 순간 회전 불가(사용자에게는 "재로그인") |
/// | [`is_registered`] | 살아 있는 계정을 **「로그아웃됐다」**로 본다 → 회전이 폴더를 안 판다 · 격리 표식이 풀린다 |
/// | [`snapshot_of`] ★SLUG R2 | **채팅 턴이 죽는다** — `Err(NotRegistered)` → 「등록된 계정이 아니에요」 + 그 턴의 입력 소실. SLUG R1이 모든 턴을 [`account_run_dir`] 위에 올리면서 이 자리가 목록에 들어왔다 |
///
/// 이건 이 갈래가 이미 한 번 고친 것과 **같은 병**이다: 편집 경로([`cas_edit`])는
/// [`READ_RETRIES`]회 다시 읽고 [`recover_store`]로 복구까지 하는데 **조회 경로만
/// 약하게 읽어서**, 편집이 지키는 불변식을 조회가 무너뜨렸다. 그래서 조회도 같은
/// 강도로 읽는다 — 재시도, 그리고 [`vanished_but_we_know_better`]가 여는 그 문(같은 문,
/// 같은 열쇠)까지.
///
/// 실측(확인 크리틱 dde4b34의 부하 조건 · 4레인 + 워크스페이스 릴리스 빌드):
/// 대조군 40주행 중 1주행이 정확히 이 자리로 붉었다(`재료없음=1` · 배경 회전 699판 중 1판).
fn read_store_settled() -> StoreFile {
    let mut f = read_store_quiet();
    for _ in 0..READ_RETRIES {
        if f.origin.is_known() && !vanished_but_we_know_better(&f) {
            return f;
        }
        // 이웃이 쓰는 중이다("지나가는 반쪽"). 쓰기 경로와 같은 간격으로 다시 본다.
        std::thread::sleep(std::time::Duration::from_millis(READ_RETRY_MS));
        f = read_store_quiet();
    }
    if f.origin.is_known() && !vanished_but_we_know_better(&f) {
        return f;
    }
    // 여러 번 봐도 그대로다 = 지나가는 반쪽이 아니다. 마지막 성공본이 아는 것이 있으면
    // **그것이 답이다**(`recover_store`가 그 사실을 한 줄로 적는다 — 침묵 금지).
    recover_store(f.origin).unwrap_or(f)
}

/// 이 이메일이 스토어에 있나(조회 전용).
///
/// ★R28d(CASX R3) — [`read_store_settled`]로 읽는다. 이 함수의 `false`는 제품에서
/// **"사용자가 그 계정을 지웠다"**로 읽히고([`persist_refreshed_report`]의 폴더 가드 ·
/// [`crate::health::needs_login`]의 격리 해제), 그 판정을 이웃의 통짜 쓰기 한 번이
/// 뒤집으면 안 된다.
pub fn is_registered(email: &str) -> bool {
    read_store_settled().accounts.iter().any(|a| email_of(a) == Some(email))
}

/// 원문 한 벌 파싱. `None` = JSON 객체가 아니다(= 손상).
fn parse_store(raw: &str) -> Option<StoreFile> {
    let Ok(Value::Object(m)) = serde_json::from_str::<Value>(raw) else { return None };
    let v = m.get("version").and_then(Value::as_f64).unwrap_or(0.0);
    if v != STORE_VERSION as f64 && v != 2.0 {
        return Some(StoreFile { version: STORE_VERSION, origin: StoreOrigin::Foreign, ..Default::default() });
    }
    Some(StoreFile {
        version: v as u64,
        default_email: m.get("defaultEmail").and_then(Value::as_str).map(str::to_string),
        accounts: match m.get("accounts") {
            Some(Value::Array(a)) => a.clone(),
            _ => Vec::new(),
        },
        origin: StoreOrigin::Parsed,
    })
}

/// ★M11 R4(G1·G3) — 파일을 **한 번만** 읽어 `(원문, 해석)`을 같이 준다.
///
/// 원문이 따로 필요한 이유는 [`update_account_record`]의 CAS 때문이다: "내가 읽은 그
/// 바이트가 아직 그대로인가"를 쓰기 직전에 다시 물어야 하는데, 그 증표로 mtime·크기는
/// 못 쓴다 — Windows 시스템 시계 눈금이 ~15.6ms라 우리가 닫으려는 창(8~14ms)보다 굵다.
/// 그래서 내용 자체를 증표로 쓴다(계정 6개 = 수십 KB라 비교는 µs다).
///
/// **읽기는 복구하지 않는다.** 깨진 파일은 `accounts: []` + [`StoreOrigin::Unreadable`]로
/// 정직하게 준다(R3와 같은 값 + 출처 한 칸). 복구는 *쓰는 문*에서만 한다
/// ([`recover_store`]) — 조회 한 번에 낡은 사본이 슬며시 현재 목록 행세를 하면 안 된다.
fn read_store_raw() -> (Option<String>, StoreFile) {
    let Ok(raw) = std::fs::read_to_string(store_path()) else {
        return (None, StoreFile { version: STORE_VERSION, origin: StoreOrigin::Missing, ..Default::default() });
    };
    match parse_store(&raw) {
        Some(f) => (Some(raw), f),
        // 반쪽 JSON·쓰레기. 2.6.2의 `writeFileSync`는 원자적이지 않아 쓰는 도중에 죽으면
        // 이 모양이 남는다(우리 쪽은 rename이라 안 남는다).
        None => (Some(raw), StoreFile { version: STORE_VERSION, origin: StoreOrigin::Unreadable, ..Default::default() }),
    }
}

/// ★M11 R4(G3/C7) — 본문이 깨졌을 때 **쓰기 직전에** 꺼내는 마지막 성공본.
///
/// R3는 깨진 파일을 빈 목록으로 읽고 그 위에 사용자의 로그인을 얹었다 = 나머지 계정이
/// `credEnc`째 사라졌다(크리틱 C7). 여기서 되살릴 재료가 없으면 그 자리에서 쓰기를
/// 포기하는 것이 맞다 — 모르는 위에 덮어쓰는 것이 유실의 정체다.
///
/// ★R28d(CASX R2) — **로그가 사실을 말한다.** R1까지 이 줄은 무조건 "`accounts.json`이
/// 깨졌다"였는데, [`vanished_but_we_know_better`]가 여는 문의 대상은 대개 **깨진 파일이
/// 아니라 없는 파일**이다(갈아끼우기 창 · 사용자나 지원 절차의 수동 삭제). 파일이 없었을
/// 뿐인데 "깨졌다"고 적으면 다음 사람이 디스크 손상을 쫓는다(확인 크리틱 R1 §7).
fn recover_store(was: StoreOrigin) -> Option<StoreFile> {
    let mut b = read_file_or_null(&store_backup_path()).as_deref().and_then(parse_store)?;
    if b.origin != StoreOrigin::Parsed || b.accounts.is_empty() {
        return None;
    }
    // ★R28e(CASX2) — **복구본은 툼스톤을 존중한다.**
    //
    // 이 파일은 「마지막으로 성공한 저장」이라 그 뒤에 실행된 로그아웃을 **아직 담고 있을
    // 수 있다**(로그아웃이 `.bak`을 갱신하기 전에 본문이 깨지거나 사라진 판). 그 목록을
    // 그대로 되쓰면 사용자가 지운 계정이 `credEnc`째 돌아온다 — 이 갈래가 닫으려는 바로
    // 그 사고이고, R28d까지 이 문은 *"되살아난 계정은 사용자가 다시 지우면 된다"*로
    // 열려 있었다. 이제 **지문이 그대로인 행만** 걷어낸다: 지문이 다르면 그건 시체가
    // 아니라 그 뒤에 앉은 새 로그인이다(새 `credEnc`는 새 DPAPI 산출물이다).
    let (kept, buried) = ledger::without_buried(std::mem::take(&mut b.accounts));
    b.accounts = kept;
    if !buried.is_empty() {
        eprintln!(
            "[auth] ★ {STORE_BACKUP_FILE}: 복구본에 우리가 로그아웃한 계정 {}개가 아직 있었다 — 되살리지 않는다({})",
            buried.len(),
            buried.join(" · ")
        );
    }
    if b.accounts.is_empty() {
        return None; // 걷어내고 나니 되살릴 것이 없다 = 복구할 재료가 없는 것과 같다
    }
    let why = match was {
        StoreOrigin::Missing => "이 없다",
        _ => "이 깨졌다",
    };
    // ★R28d(CASX R3) — 장부에도 남긴다. 이 문으로 들어온 목록은 이웃이 방금 지운 계정을
    // 아직 담고 있을 수 있어서 「되살아남」의 출처가 되는데, 그 판은 **침묵이 아니다**
    // (바로 아랫줄이 사실을 말한다). 못이 침묵을 셀 때 이 수를 같이 봐야 한다.
    bury_stats::RECOVERED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    eprintln!("[auth] ★ {STORE_FILE}{why} — 마지막 성공본({STORE_BACKUP_FILE}, 계정 {}개)으로 되살린다", b.accounts.len());
    Some(StoreFile { origin: StoreOrigin::Recovered, ..b })
}

// ── ★M11 R3(F1) — accounts.json 임계 구역 ───────────────────────────────────
//
// R2까지 이 파일의 갱신은 **잠금 없는 통짜 read-modify-write**였고, 실패는 `let _`로
// 삼켜졌다. M11 R2가 배경 스레드(자동 전환 워커)에서 그 쓰기를 처음 만들면서 같은 홈을
// 쓰는 2.6.2 실앱과 겹치기 시작했다 — R2 확인 크리틱 실측 120판에 백업 클로버 1~6건,
// **로그아웃한 계정이 credEnc째 되살아난 것 11건**.
//
// 세 겹으로 닫는다.
//
// | 겹 | 무엇 | 막는 것 |
// |---|---|---|
// | ① 잠금 | [`ccg_store::flock`] — read와 write가 **같은 증표 아래** 있다 | 잠금을 아는 프로세스끼리(3.0 두 벌 · 워커 vs 허브 · 하네스 자식) |
// | ② 병합 | 쓰기 직전 디스크를 다시 읽어 **더 신선한 `credEnc`는 살린다** | 잠금을 모르는 프로세스(오늘의 2.6.2)가 낸 회전 결과 |
// | ③ 좁히기 | 배경 쓰기([`persist_refreshed`])는 **자기 계정 항목만** 고친다(목록·순서·기본 계정 불가침) | "로그아웃이 취소된다" — 목록은 폴더에 사본이 없어 잃으면 끝이다 |
//
// ── ★M11 R4(G1) — 네 번째 겹: **CAS(compare-and-swap)** ─────────────────────
//
// R3의 실증은 자식도 `ccg-auth`를 써 잠금을 잡는 판이었다. 진짜 이웃인 2.6.2는
// `fs.writeFileSync(STORE_PATH, JSON.stringify(...))` 한 줄이고(`auth.ts:124`) 잠금을
// **모른다** — 겹 ①은 그 상대에게 아무 효력이 없다. 실 2.6.2 코드로 다시 재면
// 로그아웃 취소가 남아 있었다(R3 확인 크리틱 §4: 2/150 · 이 라운드 재현 4/900).
//
// 2.6.2는 동결 트리라 잠금을 이식할 수 없다. 그래서 **우리 쪽에서만** 닫는다:
//
// | 무엇 | 어디서 |
// |---|---|
// | 읽기 + 클로저(safeStorage 복호·암호 = DPAPI 2회, 실측 8~14ms) | **잠금 밖** |
// | 임시 파일에 통짜 직렬화 + 쓰기 | **잠금 밖** |
// | "내가 읽은 바이트가 아직 그대로인가" 재확인 + `rename` | 잠금 안 (실측 **0.2~0.4ms**) |
//
// 갈렸으면 처음부터 다시 한다(상한 [`CAS_TRIES`]). 남는 창은 마지막 두 줄뿐이라
// R3의 8~14ms에서 **30~50배** 좁아진다. 창이 0이 되지는 않는다 — 잠금을 모르는 상대와
// 파일 하나를 나눠 쓰는 한 원리적으로 0은 없다. 줄이고, 재고, 적는다.

/// CAS 재시도 상한. 상한을 두는 이유는 하나 — 이웃이 쉬지 않고 쓰는 판에서 이 함수가
/// 영원히 안 돌아오면 그것대로 사용자의 저장이 사라진다(flock 규약 3과 같은 정신).
const CAS_TRIES: usize = 16;
/// 우리 `rename`이 묻은 이웃의 쓰기를 되살리는 연쇄의 상한(되살리기 자체도 또 묻힐 수 있다).
const BURY_TRIES: usize = 4;
/// ★R28d(CASX) — 갈아끼운 뒤 **옛 inode를 몇 번 더 보나**.
///
/// 첫 판독이 `expect`면 즉시 끝난다(= 묻은 쓰기 없음). 이웃의 `writeFileSync`는 **여는
/// 순간** 파일을 0바이트로 자르므로(`CREATE_ALWAYS`), 우리가 갈아끼우기 전에 연 이웃이
/// 있었다면 첫 판독이 반드시 `expect`와 다르다 — 그리고 갈아끼운 뒤엔 그 inode에 이름이
/// 없어 새로 열 수도 없다. 그래서 이 상한은 **이미 흔들린 판**, 즉 이웃이 지금 쓰는 중인
/// 판에서만 쓰인다: 그 통짜 쓰기가 끝나기를 기다리는 시간이다.
///
/// 옛 값 4×300µs(=1.2ms)는 짧았다. 실측한 이웃 통짜 쓰기는 0.3~16ms였고, 못 기다리면
/// **로그아웃이 묻힌 줄도 모르고** 지나간다(그 판의 되살아남은 다음 이웃 쓰기까지 =
/// 실측 85ms 지속). 40×500µs = 최대 19.5ms — 흔들린 판에서만 내는 값이라 평시 비용은 0이다.
///
/// ★R28d(CASX R2) — 이 상한은 **[`BURY_WATCH_BUDGET_MS`]와 함께** 읽어야 한다. 확인 크리틱
/// R1이 추적 1주행(커밋 1,078건)에서 잰 판독 분포는 `k=0` 1,078건 · **`k>0` 0건**이었다 —
/// 이 값을 4에서 40으로 늘린 것은 측정된 영역에서 효과 0이다. 그럼에도 남기는 이유는
/// 첫 판독이 흔들린 판(이웃이 쓰는 중)을 못 봐서가 아니라 **아직 못 봤기 때문**이고,
/// 대신 그 대가(잠금 보유 시간)를 아래 예산이 문다.
const BURY_WATCH: usize = 40;
const BURY_WATCH_US: u64 = 500;
/// ★R28d(CASX R2) — 파묻힘 감시의 **총 예산**(CAS 시도 1회당).
///
/// R1은 [`BURY_WATCH`]를 `BURY_TRIES`번의 되살리기 연쇄마다 **따로** 썼다. 그러면 최악
/// 잠금 보유가 `CAS_TRIES(16) × [READ_RETRIES … + BURY_TRIES(4) × 19.5ms]` ≈ **1.3초**가
/// 된다(옛 값 ≈83ms). 오늘은 이 문을 배경 워커만 쓰지만 [`update_store`] 주석이 적어 둔
/// 대로 `auth:*` 쓰기 채널이 붙는 순간 그 문은 **사용자 손**에 들어온다 — 로그아웃 한 번이
/// 1.3초 멎으면 그건 그것대로 사고다(확인 크리틱 R1 §7).
///
/// 그래서 감시를 **횟수가 아니라 시계**로 끊는다. 예산은 CAS 시도마다 새로 준다 —
/// 시도 전체가 하나의 예산을 나눠 쓰면 경합이 심한 판에서 뒤쪽 시도의 검출력이 0이 되고,
/// 그건 이 라운드가 지켜야 할 **로그아웃 승리 불변식**을 갉는다. 20ms는 실측한 이웃 통짜
/// 쓰기(0.3~16ms) 하나를 통째로 덮는다. 최악 = 16 × 20ms = 320ms(4배 개선).
const BURY_WATCH_BUDGET_MS: u64 = 20;
/// ★R28d(CASX) — "지금은 모른다"(반쪽 · 사라짐)에서 **다시 읽는 횟수**. 옛 값 4×2ms는
/// 실측한 사라짐 창(최대 ~12ms)보다 짧았다. 6×3ms = 최대 18ms 기다렸다가 복구로 간다.
const READ_RETRIES: usize = 6;
const READ_RETRY_MS: u64 = 3;

// ── ★R28d(CASX R3) — 커밋 **뒤에** 도착하는 매장 ─────────────────────────────
//
// R2까지 증인 검사는 이 문장 위에 서 있었다: *"이웃의 `writeFileSync`는 여는 순간 파일을
// 0바이트로 자르므로, 우리가 갈아끼우기 전에 연 이웃이 있었다면 첫 판독이 반드시 `expect`와
// 다르다."* **그 문장은 실측으로 거짓이다.**
//
// 이웃의 `CreateFile(CREATE_ALWAYS)`는 *이름을 푸는 것*과 *자르는 것* 사이가 벌어질 수 있다
// (경합·선점). 그 틈에 우리 `rename`과 **첫 판독까지** 들어가면 옛 inode는 아직 옛 내용
// 그대로고, 우리는 "묻은 것 없음 → Clean"으로 판정하고 자물쇠를 놓는다. 그리고 수십 µs~수 ms
// 뒤에 그들의 통짜 쓰기가 **이름 없는 그 inode**로 떨어진다 — 그 쓰기가 로그아웃이었으면
// 사용자의 로그아웃이 취소된 채로 남고, **우리 로그에는 한 줄도 안 남는다.**
//
// 확인 크리틱 R2가 잡은 헤드라인 실패(140주행 2붉음 · 그중 하나는 200ms 뒤에도 살아 있는
// 진짜 취소 · 진단 셋 전부 0줄)의 정체가 이것이다. R3가 프로브로 못 박은 값:
//
// | 판정 | 판 | 그중 **뒤늦게** 옛 inode가 갈린 판 |
// |---|---|---|
// | 첫 판독 = `expect` → 지름길 `Clean` | 1,010 | **321 (31.8%)** |
//
// 그리고 321판 **전부** 이웃의 열기 번호가 우리 `rename` 시점 이하였다(= 걸터탄 열기).
// 「이름이 잠깐 비어 이웃이 새 파일을 만든다」 가설(못 표의 ②)은 같은 프로브에서 **0/23,083**
// 으로 기각됐다(유령 inode 0 · 이웃 열기 실패 0).
//
// 그래서 커밋 뒤에도 옛 inode를 계속 본다. 두 가지를 지킨다:
//
// 1. **자물쇠 밖에서** 본다 — 이름 없는 inode를 읽는 것뿐이라 남과 경합하지 않는다.
//    임계 구역을 늘리면 로그아웃 한 번이 그만큼 멎는다(확인 크리틱 R1 §7의 그 대가).
// 2. **부르는 쪽을 안 세운다** — 감시는 전용 스레드가 한다. 배경 회전이 판마다 50ms씩
//    멎으면 이 못의 부하가 통째로 사라진다(못이 재는 것이 곧 그 부하다).
/// 지연 감시가 옛 inode를 보는 시간.
///
/// ★R28d(CASX R4) — R3의 값 50ms는 **외삽이었다.** 근거로 삼은 프로브(`late_burial_probe`)의
/// 관측이 20ms에서 끝나서 꼬리를 아예 안 쟀고, 그 사이 제품 로그(확인 크리틱 R3 §3-3, n=18)에
/// 51.9ms·107.6ms짜리 착지가 찍혔다 — 그 둘은 감시 틱이 늦게 돌아서 **우연히** 살았다.
/// 틱이 제때 돌았으면 둘 다 50ms에서 버려졌고, 버릴 때 흔적이 없었다.
///
/// 이제 꼬리를 끝까지 잰다(`late_burial_tail_probe` — 1초까지 · 제품과 같은 큐 모양).
/// 그 실측 분포에서 고른 값이고, 이 값이 무엇을 못 보는지는 [`bury_stats::watched_out`]이
/// 세서 못이 읽는다(= 예산을 넘겨 접은 판이 몇이었나).
/// 실측(`late_burial_tail_probe` · 갈아끼우기 3,000 · 이웃 쓰기 38,318 · 늦은 매장 359건):
///
/// | | 값 |
/// |---|---|
/// | 최소 · 중앙값 · p90 · p99 · **최대** | 171µs · 6.2ms · 9.4ms · 31.6ms · **411.7ms** |
/// | 그 값이 상한이면 **못 보는 판** | 20ms=5 · **50ms=2** · 100ms=1 · 200ms=1 · **500ms=0** |
///
/// 그래서 500ms다 — 이 표본에서 놓침이 0이 되는 첫 칸이다. 그 대가(핸들 보유·판독 I/O)는
/// [`LATE_WATCH_US`]가 문다: 앞 25ms만 촘촘하게 보고 나머지는 5ms 간격이라, 커밋 한 번당
/// 판독 수는 R3(50ms 전부 250µs = 200회)와 거의 같은 ~195회다.
const LATE_WATCH_MS: u64 = 500;
/// 판독 간격. 이름 없는 inode 읽기 한 번은 실측 3~9µs다.
///
/// ★R28d(CASX R4) — 예산이 길어진 만큼 **뒤로 갈수록 성기게** 본다([`LATE_WATCH_DENSE_MS`]).
/// 앞쪽이 촘촘해야 하는 이유는 되살리기가 늦으면 그만큼 로그아웃한 계정이 파일에 앉아
/// 있기 때문이고(실측 중앙값 3.8ms), 뒤쪽까지 촘촘하면 그 I/O가 곧 이웃과 부딪히는 비용이
/// 된다(확인 크리틱 R3 §3-4가 잰 그 대가).
const LATE_WATCH_US: u64 = 250;
/// 이 시각까지는 [`LATE_WATCH_US`] 간격으로, 그 뒤로는 [`LATE_WATCH_SPARSE_US`]로 본다.
const LATE_WATCH_DENSE_MS: u64 = 25;
const LATE_WATCH_SPARSE_US: u64 = 5_000;
/// 동시에 지켜보는 옛 inode 수의 상한(핸들이 새지 않게).
const LATE_WATCH_MAX: usize = 256;
/// ★R28d(CASX R4) — 파낸 되살리기를 그 자리에서 **못 앉혔을 때** 다시 보는 시간.
///
/// R3는 `!dst.is_file()`이면 재시도도 로그도 없이 **영구히** 접었다(확인 크리틱 R3 §3-2).
/// 그런데 그 창은 이 갈래가 스스로 실측해 표에 적어 둔 갈아끼우기 창이다
/// (ENOENT 6연속 · 7.2ms — [`crate::replace`] 모듈 주석). 지나가는 창에 파낸 로그아웃을
/// 버리면 그것이 곧 「사용자의 로그아웃이 취소된 채로 남는다」이다.
const REVIVE_RETRY_MS: u64 = 250;

// ── ★R28e(CASX2) — 「몇 개 지웠나」는 여기서 **사라졌다** ────────────────────
//
// R4에는 `REVIVE_MAX_REMOVALS = 1`이 있었다. 근거는 사실이었다(2.6.2 `removeAccount(email)`는
// 계정 하나를 지운다). 틀린 것은 **그 사실을 적용한 대상**이다 — R4는 `우리 목록 \ 그들 원문`을
// "그들이 지운 것"으로 읽었는데, 그 차집합은 그들의 스냅샷이 우리 로그인 **하나만큼만**
// 낡아도 둘이 된다. 그래서 진짜 로그아웃이 「오독한 통짜 쓰기」로 몰려 영구히 취소됐다
// (확인 크리틱 R4 §3-2 · 결정적 재현 2/2). 그 앞 라운드는 같은 배치에서 반대로 틀렸다
// (막 앉은 로그인까지 지웠다).
//
// 이제 [`ledger::attribute`]가 **그들의 스냅샷 세대를 짚어** 진짜 차집합을 낸다. 개수는
// 판정의 근거가 아니라 결과다 — 그들이 둘을 한 번에 지운 원문이 진짜라면 둘 다 살린다.

/// ★R28d(CASX R3) — **이 프로세스가 이웃의 쓰기를 묻은 사실**의 장부.
///
/// 못이 재야 하는 것은 "되살아남이 0인가" 하나가 아니다. 확인 크리틱 R2의 최대 격차는
/// **되살아났는데 아무도 모르는 판**이었다(붉은 주행에 진단 0줄). 그래서 "묻은 것을
/// 봤나"를 제품이 세고, 못이 그 수를 읽는다 — 침묵이면 못이 붉어진다.
pub mod bury_stats {
    use std::sync::atomic::{AtomicUsize, Ordering};

    pub(super) static IN_LOCK: AtomicUsize = AtomicUsize::new(0);
    pub(super) static IN_LOCK_REVIVED: AtomicUsize = AtomicUsize::new(0);
    pub(super) static LATE: AtomicUsize = AtomicUsize::new(0);
    pub(super) static LATE_KEPT: AtomicUsize = AtomicUsize::new(0);
    pub(super) static UNREAD: AtomicUsize = AtomicUsize::new(0);
    pub(super) static DROPPED: AtomicUsize = AtomicUsize::new(0);
    pub(super) static RECOVERED: AtomicUsize = AtomicUsize::new(0);
    pub(super) static GAVE_UP: AtomicUsize = AtomicUsize::new(0);
    pub(super) static REFUSED: AtomicUsize = AtomicUsize::new(0);
    pub(super) static MOVED_ON: AtomicUsize = AtomicUsize::new(0);
    pub(super) static UNSURE: AtomicUsize = AtomicUsize::new(0);
    pub(super) static WATCHED_OUT: AtomicUsize = AtomicUsize::new(0);

    /// 자물쇠 **안에서** 파낸 판.
    pub fn in_lock() -> usize {
        IN_LOCK.load(Ordering::Relaxed)
    }
    /// 그중 **실제로 행을 되살린** 판(그들이 지운 계정이 있었다).
    pub fn in_lock_revived() -> usize {
        IN_LOCK_REVIVED.load(Ordering::Relaxed)
    }
    /// 묻힌 **로그아웃**을 되살린 판의 총합 — 못이 "이 되살아남을 제품이 봤나"를 이걸로 잰다.
    pub fn repaired() -> usize {
        in_lock_revived() + late()
    }
    /// 커밋 뒤 **지연 감시**가 파내 되살린 판.
    pub fn late() -> usize {
        LATE.load(Ordering::Relaxed)
    }
    /// 지연 감시가 파냈는데 **되살릴 것이 없던** 판(그들이 지운 계정이 없다).
    pub fn late_kept() -> usize {
        LATE_KEPT.load(Ordering::Relaxed)
    }
    /// 묻은 줄은 아는데 원문을 끝내 못 읽은 판.
    pub fn unread() -> usize {
        UNREAD.load(Ordering::Relaxed)
    }
    /// 감시 자리가 모자라 **못 지켜본** 판.
    ///
    /// ★R28d(CASX R4) — 이 수는 [`seen`]에 **안 들어간다.** 여기 걸린 자리는 우리가 아예
    /// 안 본 자리라, 그 판에 매장이 있었는지조차 모른다 — 「봤다」에 넣으면 못이 재는
    /// 침묵이 그만큼 헐거워진다(확인 크리틱 R3의 요구는 *"포기하면 한 줄은 찍어라"*였고,
    /// 그 요구가 가리킨 자리는 **파낸 뒤에** 못 앉힌 판이다 = [`gave_up`]).
    pub fn dropped() -> usize {
        DROPPED.load(Ordering::Relaxed)
    }
    /// ★R28d(CASX R4) — 이웃의 로그아웃을 **파냈는데 끝내 못 앉힌** 판.
    ///
    /// R3에서 이 자리는 `!dst.is_file()` 한 줄이었고 재시도도 로그도 없었다(확인 크리틱
    /// R3 §3-2 · 결정적 재현 있음). 이제 [`REVIVE_RETRY_MS`]만큼 다시 보고, 그래도 못
    /// 앉히면 **한 건마다 한 줄을 찍는다** — 그래서 이 수는 [`seen`]에 들어간다.
    pub fn gave_up() -> usize {
        GAVE_UP.load(Ordering::Relaxed)
    }
    /// ★R28e(CASX2) — 파낸 원문을 **우리 장부의 어느 시점에도 못 맞춰** 한 건도 안 지운 판
    /// ([`super::ledger::Verdict::Blind`]). 한 건마다 한 줄을 찍는다.
    ///
    /// R4에서 이 수의 뜻은 *"지우기가 둘 이상이라 오독으로 봤다"*였다. 그 규칙이 진짜
    /// 로그아웃을 영구히 취소했고(확인 크리틱 R4 §3-2) 로그도 원인을 반대로 적었다.
    /// 이제 이 수는 **「모른다」의 수**다 — 알면 지우고, 모르면 안 지운다.
    pub fn refused() -> usize {
        REFUSED.load(Ordering::Relaxed)
    }
    /// ★R28e(CASX2) — 지울 후보였지만 **그 행의 신원이 그들 스냅샷보다 새것이라** 안 지운
    /// 판(= 그 이메일로 새 로그인이 들어왔다). 신원 세대가 실제로 일한 횟수다.
    ///
    /// R4에서 이 수는 「커밋한 바이트와 다르다」였고, 그래서 **우리 자신의 배경 회전**이
    /// 이 수를 올리며 사용자의 로그아웃을 영구히 취소했다(확인 크리틱 R4 §3-1).
    /// 이제 회전은 이 수를 못 올린다([`super::ledger::Intent::Refresh`]).
    pub fn moved_on() -> usize {
        MOVED_ON.load(Ordering::Relaxed)
    }
    /// ★R28f — **파일만으로 못 갈랐는데 지운 판**([`super::ledger::Verdict::Act::unsure`]).
    ///
    /// 확인 크리틱 R28e §3-1이 요구한 것은 두 가지였다 — *「그 행의 신원이 새로 섰다」와
    /// 「이웃이 회전했을 뿐이다」를 가를 근거를 세워라. 못 가른다면 **못 가른다는 사실을
    /// 로그가 말해야 하고**, 판정은 그 판을 어느 쪽으로 지게 할지 근거와 함께 골라라.*
    /// 파일에는 그 근거가 안 남는다(두 경우의 그들 원문 바이트가 같다). 그래서 이 수는
    /// **골랐다는 사실 자체의 장부**다: 0이 아니면 그만큼의 판을 「지우는 쪽」으로 골랐고,
    /// 그 판마다 한 줄이 사유와 함께 찍혔다([`super::unsure_tail`]).
    pub fn unsure() -> usize {
        UNSURE.load(Ordering::Relaxed)
    }
    /// ★R28d(CASX R4) — 감시 예산([`LATE_WATCH_MS`])까지 보고 **아무 변화 없이** 접은 판.
    ///
    /// 이 판들은 대개 진짜로 아무 일도 없었던 판이지만(평시의 절대다수), 그중 몇이
    /// 예산 밖에서 갈렸는지는 원리적으로 못 안다. 그래서 **분모를 남긴다** — 예산이
    /// 맞는지는 이 수와 [`late`]의 비, 그리고 `late_burial_tail_probe`의 꼬리 분포로 잰다.
    pub fn watched_out() -> usize {
        WATCHED_OUT.load(Ordering::Relaxed)
    }
    /// ★R28d(CASX R3) — 목록을 **마지막 성공본(`.bak`)으로 읽은** 판([`super::recover_store`]).
    ///
    /// 이것도 「되살아남」의 출처다. 이웃이 갈아끼우기 창에서 파일을 못 읽고 통짜로
    /// 되쓴 뒤 우리가 그 반쪽을 복구하면, 복구본에는 그들이 방금 지운 계정이 아직
    /// 들어 있을 수 있다. 그 판은 **침묵이 아니다** — [`super::recover_store`]가 한 줄을
    /// 찍는다. 못이 「제품이 봤나」를 셀 때 이 수를 같이 봐야 그 한 줄을 인정하는 것이다.
    pub fn recovered() -> usize {
        RECOVERED.load(Ordering::Relaxed)
    }
    /// 이웃의 쓰기를 묻은 것을 우리가 **본** 판의 총합(= 침묵이 아니었던 판).
    ///
    /// 규칙 하나로 정리된다: **한 줄이라도 찍힌 판만 여기 들어온다.** 그래서 [`dropped`]
    /// (아예 안 본 판)와 [`watched_out`](봤는데 아무 일도 없던 판)은 빠진다.
    pub fn seen() -> usize {
        in_lock() + late() + late_kept() + unread() + recovered() + gave_up() + refused()
    }
    /// 테스트가 주행 사이에 장부를 0으로 되돌린다(프로세스 전역이라 못끼리 물든다).
    pub fn reset() {
        for c in [&IN_LOCK, &IN_LOCK_REVIVED, &LATE, &LATE_KEPT, &UNREAD, &DROPPED, &RECOVERED, &GAVE_UP, &REFUSED, &MOVED_ON, &UNSURE, &WATCHED_OUT] {
            c.store(0, Ordering::Relaxed);
        }
    }
}

/// 커밋이 이름을 떼어 낸 **옛 inode** 한 자리. 이름이 없으므로 여기에 쓰는 것은
/// 갈아끼우기 전에 이 파일을 열어 둔 이웃뿐이다 — 그래서 내용이 갈리면 그것은
/// **우리가 묻은 그들의 쓰기**다(다른 해석이 없다).
struct Orphan {
    file: std::fs::File,
    /// 갈아끼우기 직전에 우리가 읽은 그 내용.
    was: String,
}

/// 되살리기가 지울 행 한 자리 — `(이메일, 판정 당시의 **신원 세대**)`.
///
/// ★R28e(CASX2) — R4까지 이 칸은 `(이메일, 우리가 커밋한 그 바이트)`였고, 앉히기 직전에
/// **바이트가 그대로인가**를 물었다. 그 물음이 「사용자의 재로그인」과 **「우리 자신의
/// 배경 회전」**을 못 갈랐다: 회전 한 바퀴가 그 행의 `credEnc`를 다시 쓰면 되살리기가
/// 취소되고, 로그는 *"그 뒤에 다시 로그인돼 있어 그대로 뒀다"*고 **정반대를 적었다**
/// (확인 크리틱 R4 §3-1 · 결정적 재현 4/4 · 회전만 뺀 대조군 4/4 초록).
///
/// 이제 묻는 것은 바이트가 아니라 [`crate::ledger`]가 든 **신원 세대**다. 회전은 그 값을
/// 안 올리고([`ledger::Intent::Refresh`]), 로그인은 올린다. 추론이 아니라 기록이다.
type Stamp = (String, u64);

/// 지연 감시 한 자리.
struct LateWatch {
    orphan: Orphan,
    /// 우리가 방금 커밋한 목록 — 그들이 지운 계정을 여기서 뺀다.
    ours: Vec<Value>,
    /// ★R28e(CASX2) — 이 커밋 **직전**의 장부 세대. 그들의 읽기는 우리 커밋보다 앞이므로
    /// 후보 세대의 상한이 된다([`ledger::attribute`]).
    at_gen: u64,
    /// 그때의 목적지. 홈이 갈리면(테스트) 남의 홈에 쓰지 않는다.
    dst: PathBuf,
    since: std::time::Instant,
    /// 다음 판독 시각(뒤로 갈수록 성기게 본다 — [`LATE_WATCH_DENSE_MS`]).
    next_at: std::time::Instant,
    /// 갈리긴 했는데 아직 못 읽었다(이웃이 쓰는 중).
    torn: bool,
    /// ★R28d(CASX R4) — **파냈는데 아직 못 앉힌** 되살리기(갈아끼우기 창에 걸렸다).
    /// 있으면 이 자리는 판독을 멈추고 앉히기만 다시 시도한다.
    owed: Option<Vec<Stamp>>,
    /// ★R28e(CASX2) — 후보였지만 **안 지운** 것과 그 사유. 로그가 이걸 그대로 적는다.
    held: Vec<(String, String)>,
    /// ★R28f — 지웠지만 **파일만으로는 못 가른** 것과 그 사유([`ledger::Verdict::Act::unsure`]).
    unsure: Vec<(String, String)>,
    /// 「어떤 근거로 그렇게 봤나」 한 줄([`ledger::Verdict::Act::why`]).
    why: String,
    /// `owed`가 생긴 시각([`REVIVE_RETRY_MS`]의 기준점) · 커밋에서 드러나기까지 걸린 µs.
    owed_since: Option<std::time::Instant>,
    found_us: u128,
}

static LATE_Q: std::sync::Mutex<Vec<LateWatch>> = std::sync::Mutex::new(Vec::new());
static LATE_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn late_q() -> std::sync::MutexGuard<'static, Vec<LateWatch>> {
    LATE_Q.lock().unwrap_or_else(|e| e.into_inner())
}

/// 커밋한 자리에서 부른다 — **자물쇠를 놓은 뒤에**. 하는 일은 큐에 한 자리 넣는 것뿐이라
/// (실측 1~2µs) 부르는 쪽은 안 선다.
fn late_watch(w: LateWatch) {
    use std::sync::atomic::Ordering;
    {
        let mut q = late_q();
        if q.len() >= LATE_WATCH_MAX {
            // 자리가 모자란다 = 이웃과 심하게 겹치는 판. 가장 오래된 것을 놓되 **조용히는
            // 아니다** — 그 자리가 곧 우리가 못 본 매장이다.
            //
            // ★R28d(CASX R4) — R3는 이 줄을 `Once`로 **딱 한 번만** 찍었다. 그러면 두
            // 번째부터는 장부만 오르고 로그는 침묵이라, 「매 건 한 줄」이라는 이 갈래의
            // 헤드라인이 여기서만 거짓이 된다. 그렇다고 매번 찍으면 이 자리는 배경 회전이
            // 초당 수백 번 지나는 길이라 로그가 그것만으로 찬다(`replace.rs`의 실측:
            // 24주행에 17,486줄). 그래서 **2의 거듭제곱마다** 누적 수와 함께 찍는다 —
            // 줄 수는 log에 갇히고 마지막 줄은 항상 총계를 말한다.
            let n = bury_stats::DROPPED.fetch_add(1, Ordering::Relaxed) + 1;
            if n.is_power_of_two() {
                eprintln!(
                    "[auth] ★ {STORE_FILE}: 갈아끼운 옛 사본을 지켜볼 자리가 {LATE_WATCH_MAX}개를 넘었다 — 누적 {n}개를 못 지켜봤다(묻힌 이웃 쓰기를 놓칠 수 있다)"
                );
            }
            q.remove(0);
        }
        q.push(w);
    }
    if !LATE_RUNNING.swap(true, Ordering::SeqCst) {
        let spawned = std::thread::Builder::new().name("ccg-cas-late".into()).spawn(late_watch_loop);
        if let Err(e) = spawned {
            LATE_RUNNING.store(false, Ordering::SeqCst);
            late_q().clear();
            eprintln!("[auth] ★ {STORE_FILE}: 지연 감시 스레드를 못 띄웠다({e}) — 묻힌 이웃 쓰기를 못 파낸다");
        }
    }
}

/// 감시 스레드. **일이 없으면 죽는다** — 상주 스레드를 하나 더 두지 않는다.
fn late_watch_loop() {
    use std::sync::atomic::Ordering;
    let mut batch: Vec<LateWatch> = Vec::new();
    loop {
        {
            let mut q = late_q();
            batch.append(&mut q);
            if batch.is_empty() {
                // 깃발은 **큐 잠금 안에서** 내린다 — 내리는 사이에 들어온 자리가 주인
                // 없이 남는 것을 막는다.
                LATE_RUNNING.store(false, Ordering::SeqCst);
                return;
            }
        }
        let now = std::time::Instant::now();
        batch.retain_mut(|w| !late_watch_tick(w, now));
        std::thread::sleep(std::time::Duration::from_micros(LATE_WATCH_US));
    }
}

/// 한 자리를 한 번 본다. `true` = 이 자리는 끝났다.
fn late_watch_tick(w: &mut LateWatch, now: std::time::Instant) -> bool {
    // ★R28d(CASX R4) — 파냈는데 못 앉힌 자리는 **판독을 그만두고** 앉히기만 다시 한다.
    // (옛 inode를 더 봐야 나올 것이 없다 — 우리는 이미 그들의 원문을 손에 들었다.)
    if w.owed.is_some() {
        return late_settle(w);
    }
    if now < w.next_at {
        return false;
    }
    let age = w.since.elapsed();
    w.next_at = now
        + std::time::Duration::from_micros(if age < std::time::Duration::from_millis(LATE_WATCH_DENSE_MS) {
            LATE_WATCH_US
        } else {
            LATE_WATCH_SPARSE_US
        });
    if let Some(cur) = crate::replace::read_witness(&mut w.orphan.file) {
        if cur != w.orphan.was {
            match parse_store(&cur).filter(|t| t.origin.is_known()) {
                Some(theirs) => return late_dug(w, &theirs),
                // 반쪽(자르는 중이거나 쓰는 중) — 예산 안에서는 계속 본다.
                None => w.torn = true,
            }
        }
    }
    if age < std::time::Duration::from_millis(LATE_WATCH_MS) {
        return false;
    }
    if w.torn {
        bury_stats::UNREAD.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        eprintln!(
            "[auth] ★ {STORE_FILE}: 이웃이 쓰던 중에 갈아끼웠는데 {}ms를 기다려도 그 원문을 못 읽었다 — 그 쓰기가 로그아웃이었다면 취소된 채로 남는다",
            age.as_millis()
        );
    } else {
        // 예산까지 보고 아무 변화도 없었다 = 대개 진짜로 아무 일도 없던 판이다. 그래도
        // **분모는 남긴다** — 예산이 꼬리를 덮는지는 이 수와 [`bury_stats::late`]의 비로만
        // 잴 수 있다(확인 크리틱 R3 §3-3의 요구).
        bury_stats::WATCHED_OUT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }
    true
}

thread_local! {
    /// 되살리기가 **또 감시를 낳지 않게** 한다(깊이 1). 되살리기 자체가 이웃과 겹치면
    /// 그건 다음 편집이 본다 — 사슬을 길게 만드는 쪽이 위험하다.
    static REVIVING: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// 파낸 원문으로 **그들이 지운 계정을 되살린다**(받는 것은 지우기뿐 — ABA 규칙은
/// [`cas_edit`]의 `Commit::Buried` 주석과 같다). `true` = 이 자리는 끝났다.
fn late_dug(w: &mut LateWatch, theirs: &StoreFile) -> bool {
    use std::sync::atomic::Ordering;
    let (remove, held, unsure, why) = match ledger::attribute(&w.ours, &theirs.accounts, w.at_gen) {
        // 그들이 지운 계정이 없다 = 되살릴 것도 없다(우리가 묻은 것은 그들의 편집이지
        // 로그아웃이 아니다). 세기는 한다 — 이 판도 "우리가 봤다"에 들어간다.
        ledger::Verdict::Nothing => {
            bury_stats::LATE_KEPT.fetch_add(1, Ordering::Relaxed);
            return true;
        }
        ledger::Verdict::Blind(why) => {
            bury_stats::REFUSED.fetch_add(1, Ordering::Relaxed);
            eprintln!("[auth] ★ {STORE_FILE}: {}", blind_line(theirs, &why));
            return true;
        }
        ledger::Verdict::Act { remove, held, unsure, why } => (remove, held, unsure, why),
    };
    // ★R28d(CASX R3) — 장부를 **되살리기보다 먼저** 올린다. 순서가 반대면 못이 이렇게 진다:
    // 되살리기가 디스크에 착지한 µs와 장부가 오르는 µs 사이에 못이 "되살아남이 걷혔다"를
    // 보고 곧바로 장부를 읽으면 **아직 0**이고, 그러면 「제품이 못 봤다(침묵)」로 잘못
    // 붉어진다. "봤다"는 파낸 순간의 사실이지 되살리기의 결과가 아니다.
    bury_stats::LATE.fetch_add(1, Ordering::Relaxed);
    // 보류는 **판정한 그 자리에서 한 번만** 센다(앉히기가 재시도로 여러 번 돌아도).
    bury_stats::MOVED_ON.fetch_add(held.len(), Ordering::Relaxed);
    bury_stats::UNSURE.fetch_add(unsure.len(), Ordering::Relaxed);
    w.found_us = w.since.elapsed().as_micros();
    w.owed = Some(remove);
    w.held = held;
    w.unsure = unsure;
    w.why = why;
    w.owed_since = Some(std::time::Instant::now());
    late_settle(w)
}

/// 파낸 되살리기를 **지금 디스크에** 앉힌다. `true` = 이 자리는 끝났다.
fn late_settle(w: &mut LateWatch) -> bool {
    use std::sync::atomic::Ordering;
    let Some(stamps) = w.owed.take() else { return true };
    let (n, us) = (stamps.len(), w.found_us);
    // ★R28e(CASX2) — 지울 것이 하나도 없는 판정도 **한 줄을 남기고** 끝낸다. 후보는
    //   있었는데 신원 세대가 그들 스냅샷보다 새것이라 전부 보류된 자리다(= R4가
    //   「그 뒤에 다시 로그인돼 있어 그대로 뒀다」고 단정하던 그 자리). 이제 사유를
    //   장부에서 그대로 옮겨 적는다 — 단정하지 않는다.
    if stamps.is_empty() {
        eprintln!(
            "[auth] ★ {STORE_FILE}: 우리 갈아끼우기가 이웃의 쓰기를 묻었다(커밋 {us}µs 뒤에 드러났다 · {}) — 지울 후보 {}개를 전부 보류했다: {}",
            w.why,
            w.held.len(),
            held_line(&w.held)
        );
        return true;
    }
    // 홈이 갈렸다(테스트 하네스가 `CCG_HOME`을 바꿨다). 남의 홈에는 한 글자도 안 쓰고,
    // 다시 볼 이유도 없다 — 우리 목적지는 이제 없는 홈이다.
    if store_path() != w.dst {
        bury_stats::GAVE_UP.fetch_add(1, Ordering::Relaxed);
        eprintln!("[auth] ★ {STORE_FILE}: 이웃의 로그아웃({n}개 · 커밋 {us}µs 뒤)을 파냈는데 그사이 홈이 바뀌었다 — 남의 홈에는 안 쓴다");
        return true;
    }
    // ★R28d(CASX R4) — **갈아끼우기 창은 「포기」가 아니라 「다시 본다」이다.**
    //
    // R3는 여기서 재시도도 로그도 없이 접었고(확인 크리틱 R3 §3-2 · 결정적 재현), 그 창은
    // 이 갈래가 스스로 실측한 7.2ms짜리 지나가는 창이다. 파낸 로그아웃을 지나가는 창에
    // 버리면 그게 곧 「사용자의 로그아웃이 취소된 채로 남는다」이다.
    if !w.dst.is_file() {
        let waited = w.owed_since.map(|t| t.elapsed()).unwrap_or_default();
        if waited < std::time::Duration::from_millis(REVIVE_RETRY_MS) {
            w.owed = Some(stamps);
            return false;
        }
        bury_stats::GAVE_UP.fetch_add(1, Ordering::Relaxed);
        eprintln!(
            "[auth] ★ {STORE_FILE}: 이웃의 로그아웃({n}개 · 커밋 {us}µs 뒤)을 파냈는데 {REVIVE_RETRY_MS}ms 동안 {STORE_FILE}이 자리에 없었다 — 그 로그아웃은 취소된 채로 남는다"
        );
        return true;
    }
    let dying: Vec<String> = stamps.iter().map(|(e, _)| e.clone()).collect();
    let r = REVIVING.with(|c| {
        c.set(true);
        // ★R28e(CASX2) — **신원 세대를 다시 확인한 뒤에만 지운다.** 여기 오기까지 실측
        //   최대 107ms(확인 크리틱 R3)가 흘렀고, 그 사이에 같은 이메일로 **새 로그인**이
        //   들어와 있을 수 있다. 자물쇠 안 경로는 `expect` CAS가 그 사고를 구조적으로
        //   막는데, 자물쇠 밖에는 그 묶음이 없었다 — 이 절이 그것이다.
        //
        //   R4는 이 자리를 **바이트 동일성**으로 물었고, 그래서 우리 자신의 배경 회전
        //   한 바퀴가 「재로그인」 행세를 해 사용자의 로그아웃을 영구히 취소했다
        //   (확인 크리틱 R4 §3-1). 이제 묻는 것은 [`ledger`]의 신원 세대다 — 회전은 그
        //   값을 안 올리고(선언된 [`ledger::Intent::Refresh`]), 로그인은 올린다.
        let r = cas_edit(|cur| {
            // ★R28f(확인 크리틱 R28e §3-2) — **지우기 직전의 행을 뜬다.** 툼스톤의 지문은
            //   그 행의 내용 해시라, 이메일만 넘기면 지문이 `0`이 되어
            //   [`ledger::without_buried`]가 영원히 못 맞춘다(= 복구본이 그 계정을
            //   `credEnc`째 되살린다). R28e는 세 자리 전부 `None`을 넘겼다.
            //   재시도로 이 클로저가 다시 돌 수 있으니 누적은 **클로저 안에서** 시작한다.
            let (mut removed, mut moved): (Vec<Value>, usize) = (Vec::new(), 0);
            cur.accounts.retain(|a| {
                let Some(e) = email_of(a) else { return true };
                let Some((_, born)) = stamps.iter().find(|(g, _)| g == e) else { return true };
                match ledger::origin_gen(e) {
                    Some(now) if now == *born => {
                        removed.push(a.clone());
                        false
                    }
                    // 신원이 갈렸다(= 그 사이에 새 로그인이 앉았다) 또는 장부가 그 행을
                    // 더는 모른다 — 둘 다 **안 지운다**(모듈의 우선순위: 모르면 안 지운다).
                    _ => {
                        moved += 1;
                        true
                    }
                }
            });
            Ok((removed, moved))
        });
        c.set(false);
        r
    });
    match r {
        Ok((rows, m)) => {
            let k = rows.len();
            if m > 0 {
                bury_stats::MOVED_ON.fetch_add(m, Ordering::Relaxed);
            }
            // ★R28e(CASX2) — 되살린 행마다 **툼스톤을 남긴다.** 이 로그아웃은 이웃이
            //   냈지만 실행한 것은 우리라, 그 사실이 재시작을 넘어 남아야 복구본이 그
            //   계정을 `credEnc`째 되살리지 않는다([`ledger::without_buried`]).
            // ★R28f — **그 행 자체를** 넘긴다(지문 없는 툼스톤은 아무것도 안 막았다).
            // ★R28g — 자물쇠 안 두 자리와 **같은 문**을 쓴다([`bury_all`] · 확인 크리틱 R28f §2-4).
            bury_all(&rows, "이웃(잠금 모르는 통짜 쓰기)의 로그아웃 — 우리가 묻은 것을 파내 다시 적용했다");
            eprintln!(
                "[auth] ★ {STORE_FILE}: 우리 갈아끼우기가 이웃의 로그아웃을 묻었다(후보 {n}개 [{}] · 커밋 {us}µs 뒤에 드러났다 · {}) — {k}개를 되살렸다{}{}{}",
                dying.join(","),
                w.why,
                if m > 0 { format!(" · {m}개는 앉히기 직전에 신원이 갈려 안 지웠다") } else { String::new() },
                if w.held.is_empty() { String::new() } else { format!(" · 보류 {}: {}", w.held.len(), held_line(&w.held)) },
                unsure_tail(&w.unsure)
            );
        }
        Err(e) => eprintln!("[auth] ★ {STORE_FILE}: 이웃의 로그아웃({n}개)을 묻었는데 되살리기가 실패했다({e}) — 그 로그아웃은 취소된 채로 남는다"),
    }
    true
}

/// 자물쇠 **안에서** 되살린 판의 사연 — 커밋 뒤에 한 줄로 나간다(창 안에서는 안 찍는다).
struct Revived {
    was: usize,
    now: usize,
    why: String,
    held: Vec<(String, String)>,
    /// ★R28f — 지웠지만 **파일만으로는 못 가른** 것과 그 사유([`ledger::Verdict::Act::unsure`]).
    unsure: Vec<(String, String)>,
}

/// 보류 사연을 한 줄로. **사유를 모르면 모른다고 적는다**(확인 크리틱 R4 §5-4).
fn held_line(held: &[(String, String)]) -> String {
    held.iter().map(|(e, why)| format!("{e}={why}")).collect::<Vec<_>>().join(" · ")
}

/// ★R28f — 되살리기가 실행한 로그아웃 한 벌의 **툼스톤**을 남긴다.
///
/// 넘기는 것이 이메일이 아니라 **행 자체**인 것이 이 함수의 존재 이유다. R28e는 되살리기
/// 세 자리 전부 `bury(e, …, None)`이었고, 그러면 지문이 `0`이라 [`ledger::without_buried`]가
/// (`t.fp == fp_of(a)`인 행만 걷어낸다) **영원히 안 맞는다** — 이 갈래의 헤드라인 대상인
/// 「이웃이 낸 로그아웃」만 복구본에서 `credEnc`째 되살아났다(확인 크리틱 R28e §3-2).
///
/// ★R28g(확인 크리틱 R28f §2-4) — 되살리기 자리는 **셋**이다: 자물쇠 안 두 자리
/// (`cas_edit`의 `Commit::Clean`·연쇄 소진)와 자물쇠 **밖** 한 자리([`late_settle`]).
/// R28f 보고서는 *"두 자리를 하나로 묶었다"*고 적었는데 묶인 것은 자물쇠 안 둘뿐이었고
/// 자물쇠 밖은 같은 루프를 손으로 들고 있었다. 이제 셋 다 이 문을 지난다 — 사본이 하나
/// 남아 있으면 다음 라운드가 그 자리만 고쳐 「지문 없는 툼스톤」이 되돌아온다.
fn bury_all(rows: &[Value], by: &str) {
    for row in rows {
        if let Some(e) = email_of(row) {
            ledger::bury(e, by, Some(row));
        }
    }
}

/// ★R28f — **「지웠는데 못 갈랐다」의 꼬리.** 확인 크리틱 R28e §3-1의 요구는
/// *"파일만으로 못 가른다면 못 가른다는 사실을 로그가 말해야 한다"*였다. 그래서 이 꼬리는
/// 지운 판에도 붙는다 — 지원 담당이 「단정했다」와 「골랐다」를 갈라 볼 수 있어야 한다.
///
/// (★R28g — 이 세 줄은 R28f에서 [`bury_all`]의 doc 위로 잘못 붙어 있었고 이 함수에는
/// doc이 한 줄도 없었다 — 확인 크리틱 R28f §2-4. 두 doc이 병합될 때 갈린 자리다.)
fn unsure_tail(unsure: &[(String, String)]) -> String {
    if unsure.is_empty() {
        return String::new();
    }
    format!(" · ★못 가른 판 {}(지우는 쪽으로 골랐다): {}", unsure.len(), held_line(unsure))
}

/// 「근거를 못 짚었다」의 한 줄.
///
/// ★R28e(CASX2) — R4의 이 자리는 *"「계정 0개」로 되쓴 착지"*라고 **원인을 단정했다.**
/// 그런데 같은 줄이 이웃 스냅샷이 낡았을 뿐인 판에도 찍혔고(확인 크리틱 R4 §3-2:
/// `그들 목록 1개`인데 「계정 0개」라고 적었다), 그러면 지원 담당이 엉뚱한 것을 쫓는다.
/// 이제 **관측한 것만** 적는다 — 그들 원문의 계정 수와, 우리가 왜 못 짚었는지.
fn blind_line(theirs: &StoreFile, why: &str) -> String {
    format!(
        "이웃의 통짜 쓰기를 묻었는데 그 원문을 우리 장부의 어느 시점에도 못 맞췄다(그들 목록 {}개) — {why}. 그들의 쓰기가 로그아웃이었다면 이번엔 못 살린다(사용자가 한 번 더 지우면 그때는 산다)",
        theirs.accounts.len()
    )
}

// ── ★R28d(CASX) — CAS 경합 추적기 ───────────────────────────────────────────
//
// 이 경로의 사고는 **µs 창**에서 난다. "무엇이 무엇을 이겼나"를 사후에 파일로는 못 읽는다
// (지는 쪽은 흔적을 안 남긴다). 그래서 `CCG_CAS_TRACE=1`일 때만 켜지는 한 줄 로그를 둔다 —
// 껐을 때 비용은 `OnceLock<bool>` 한 번 읽기다.
fn cas_trace_on() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("CCG_CAS_TRACE").is_ok_and(|v| v == "1"))
}
fn cas_us() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_micros()).unwrap_or(0)
}
/// 본문에서 계정 이메일만 뽑아 한 줄로 — 추적 로그에 토큰을 흘리지 않는다.
fn cas_emails(body: &str) -> String {
    match parse_store(body) {
        Some(f) => f.accounts.iter().filter_map(email_of).collect::<Vec<_>>().join(","),
        None => format!("<불가:{}B>", body.len()),
    }
}
macro_rules! cas_trace {
    ($($a:tt)*) => {
        if cas_trace_on() {
            eprintln!("[cas][{}] {}", cas_us(), format_args!($($a)*));
        }
    };
}

/// 이 파일을 고치는 동안 잡는 증표. **read-modify-write 전체**를 감싸야 의미가 있다.
pub fn store_lock() -> ccg_store::flock::Lock {
    ccg_store::flock::take(STORE_FILE)
}

/// 저장 성공 뒤 남기는 **마지막 성공본**(G3/C7의 복구 재료). 잠금 밖에서 부른다 —
/// 이 파일이 잠깐 낡아도 손해는 없고(본문이 멀쩡하면 아무도 안 본다) 임계 구역을
/// 늘리는 대가가 더 크다.
fn keep_backup(body: &str) {
    if let Err(e) = ccg_store::write_home_file(STORE_BACKUP_FILE, body) {
        eprintln!("[auth] {STORE_BACKUP_FILE} 저장 실패: {e}");
    }
}

/// 저장 — **항상 v3로 쓴다**(2.6.2 `writeStoreFile`과 같다. v2를 읽어 쓰면 승격된다).
/// 기본 계정이 목록에 없으면 첫 계정으로 물러난다 — "기본 없음" 상태를 만들지 않는다.
///
/// ★R3(F1) — **호출자의 스냅샷은 낡았을 수 있다**고 가정한다(`read_store_file()` 뒤에
/// 잠금 없이 부르는 것이 이 함수의 전형적인 사용법이고, 2.6.2도 같은 모양이다). 그래서
/// 잠금 안에서 디스크를 다시 읽어 **같은 이메일의 더 신선한 `credEnc`는 디스크 쪽을
/// 남긴다**(폴더 vs 백업을 고르는 [`freshest_creds`]와 같은 판정식). 멤버십·순서·기본
/// 계정은 호출자의 뜻 그대로다 — 로그아웃이 병합에 되살아나면 안 된다.
///
/// ★R3 — **실패를 돌려준다.** R2까지는 `let _`이라 디스크가 꽉 찼거나 잠긴 판에서도
/// `Ok`로 나갔다(C1이 닫으려던 그 침묵의 마지막 잔재 — 확인 크리틱 §5).
pub fn write_store_file(accounts: &[Value], default_email: Option<&str>) -> Result<(), AuthError> {
    // 기준점을 **먼저** 뺀다 — 아래 `read_store_file()`이 기준점을 덮어쓰기 때문이다.
    let base = take_base();
    let _g = store_lock();
    let disk = read_store_file();
    // ★R28e(CASX2) — 이 문도 [`cas_edit`]과 같은 규율로 장부를 남긴다(읽은 것 · 쓴 것).
    //   여기만 빼면 시드·마이그레이션이 만든 상태가 장부에 안 보이고, 그러면 이웃의
    //   스냅샷을 짚을 때 그 세대가 통째로 비어 「모른다」가 된다.
    // ★R28f — 이 한 벌은 **우리가 쓴 것이 아니라 읽은 것**이다([`ledger::Intent::Seen`]).
    ledger::note(&disk.accounts, &ledger::Intent::Seen);
    let (merged, def) = merge3(base.as_ref(), accounts, default_email, &disk);
    let r = write_store_locked(&merged, def.as_deref());
    if r.is_ok() {
        // 방금 쓴 것이 다음 쓰기의 기준점이다(같은 스레드가 연달아 저장하는 경로).
        set_base(&merged, def.as_deref());
        ledger::note(&merged, &INTENT.with(|c| c.borrow().clone()));
    }
    r
}

/// 파일에 나갈 바이트를 만든다(직렬화만 — 디스크는 안 만진다). CAS가 이 결과를
/// **잠금 밖에서** 임시 파일에 앉히고, 잠금 안에서는 `rename`만 한다.
fn render_store(accounts: &[Value], default_email: Option<&str>) -> String {
    let def: Option<String> = match default_email {
        Some(d) if accounts.iter().any(|a| email_of(a) == Some(d)) => Some(d.to_string()),
        _ => accounts.first().and_then(email_of).map(str::to_string),
    };
    let mut root = Map::new();
    root.insert("version".into(), json!(STORE_VERSION));
    // JSON.stringify는 undefined 키를 **생략**한다 — 계정이 0개면 defaultEmail 자체가 없다
    if let Some(d) = def {
        root.insert("defaultEmail".into(), json!(d));
    }
    root.insert("accounts".into(), Value::Array(accounts.to_vec()));
    crate::to_json_2space(&Value::Object(root))
}

/// 잠금을 **이미 잡은** 호출자용 — 병합 없이 그대로 쓴다(스냅샷을 증표 안에서 떴다는 뜻).
fn write_store_locked(accounts: &[Value], default_email: Option<&str>) -> Result<(), AuthError> {
    let body = render_store(accounts, default_email);
    ccg_store::write_home_file(STORE_FILE, &body).map_err(|e| AuthError::Io(format!("{STORE_FILE}: {e}")))?;
    keep_backup(&body);
    Ok(())
}

// ── ★R3(F1)② 3-way 병합 ────────────────────────────────────────────────────
//
// 통짜 쓰기의 진짜 문제는 "덮어쓴다"가 아니라 **호출자의 의도와 사고를 구별할 수 없다**는
// 것이다. `read_store_file()` → 고친다 → `write_store_file()`은 이 크레이트와 2.6.2가
// 공통으로 쓰는 모양이고, 그 읽기와 쓰기 사이에 남이 파일을 바꾸면 우리는 그 변경을
// **의도적으로 되돌린 것처럼** 쓴다(로그아웃 취소 · 회전 결과 클로버).
//
// 그래서 그 읽기를 **기준점(base)** 으로 기억한다. 그러면 쓰기 시점에 3-way 병합이 된다:
//
// | base | 호출자 | 디스크 | 판정 |
// |---|---|---|---|
// | X | X | Y | 호출자는 안 건드렸다 → **디스크(Y)** |
// | X | Z | Y | 호출자가 고쳤다 → **호출자(Z)** |
// | 없음 | 있음 | 없음 | 호출자가 **추가**했다 → 남긴다 |
// | 있음 | 없음 | 있음 | 호출자가 **지웠다**(로그아웃) → 지운다 |
// | 있음 | 있음 | 없음 | 남이 지웠다 → **지운다**(이게 "로그아웃 취소"를 막는 줄이다) |
// | 없음 | 없음 | 있음 | 남이 추가했다(다른 창의 로그인) → **남긴다** |
//
// 기준점이 없으면(읽지 않고 쓰는 호출자 — 시드·마이그레이션) 병합하지 않는다.
// 3-way의 base 없이 하는 병합은 추측이고, 추측으로 계정 목록을 고칠 자리가 아니다.

type Base = (std::path::PathBuf, Vec<Value>, Option<String>);

thread_local! {
    static BASE: std::cell::RefCell<Option<Base>> = const { std::cell::RefCell::new(None) };
}

// ── ★M11 R4(G4) — 기준점은 **스레드에 갇혀 있으면 안 된다** ─────────────────
//
// R3의 기준점은 `thread_local!` 하나였다. 그런데 이 앱이 실제로 쓰는 모양은 **허브가
// 읽고 워커가 쓰는** 것이라, 읽은 스레드와 쓰는 스레드가 다르면 base가 없고 base가
// 없으면 `merge3`은 첫 줄에서 `mine`을 그대로 돌려준다 = R2의 통짜 덮어쓰기다
// (R3 크리틱 C2 실측: 대조군 false / 실험군 **true** = 로그아웃 취소).
//
// 고치는 값은 "가장 최근에 이 프로세스가 본 디스크 상태"다. 우선순위는 그대로
// **내 스레드 것 먼저** — 같은 스레드에서 읽고 쓰는 판(설계가 상정한 모양)에서는
// R3와 한 글자도 다르지 않게 굴러야 한다. 내 스레드에 없을 때만 프로세스 공용으로
// 물러선다. 그 값은 *틀릴 수* 있지만(다른 스레드가 나보다 나중에 읽었을 수 있다)
// **없는 것보다는 항상 낫다**: base가 없으면 병합 자체가 사라지기 때문이다.
static SHARED_BASE: std::sync::Mutex<Option<Base>> = std::sync::Mutex::new(None);

fn put_base(b: Base) {
    BASE.with(|c| *c.borrow_mut() = Some(b.clone()));
    *SHARED_BASE.lock().unwrap_or_else(|e| e.into_inner()) = Some(b);
}

fn record_base(f: &StoreFile) {
    put_base((store_path(), f.accounts.clone(), f.default_email.clone()));
}

fn set_base(accounts: &[Value], default_email: Option<&str>) {
    put_base((store_path(), accounts.to_vec(), default_email.map(str::to_string)));
}

/// 기준점을 **꺼내 쓴다**(한 번 쓰면 소비). 홈이 그사이 바뀌었으면(테스트의 `CCG_HOME`
/// 교체) 남의 홈에서 뜬 기준점이므로 버린다.
fn take_base() -> Option<Base> {
    let mine = BASE.with(|b| b.borrow_mut().take());
    let shared = || SHARED_BASE.lock().unwrap_or_else(|e| e.into_inner()).take();
    mine.or_else(shared).filter(|(p, _, _)| *p == store_path())
}

fn find<'a>(list: &'a [Value], email: &str) -> Option<&'a Value> {
    list.iter().find(|a| email_of(a) == Some(email))
}

fn merge3(base: Option<&Base>, mine: &[Value], my_default: Option<&str>, disk: &StoreFile) -> (Vec<Value>, Option<String>) {
    let Some((_, base_accounts, base_default)) = base else {
        return (mine.to_vec(), my_default.map(str::to_string));
    };
    // ★ 안전문 — **디스크를 못 읽었는데 우리는 계정을 아는 판**에서는 병합하지 않는다.
    //
    // 그 값을 3-way의 한쪽으로 믿으면 위 표의 "남이 지웠다" 규칙이 **전 계정 삭제**로
    // 발동한다 — 병합이 사용자의 계정을 지우는 유일한 경로라 여기서 막는다. 이 판에서는
    // 우리가 든 목록이 곧 복구본이다.
    //
    // ★R4(G3) — R3는 이 문을 `disk.accounts.is_empty()`로 열었고, 그래서 **마지막 계정을
    // 로그아웃한 정상 상태**(멀쩡한 `{"version":3,"accounts":[]}`)에도 열렸다. 그건 복구가
    // 아니라 로그아웃 전체 취소이고 지운 계정이 `credEnc`째 돌아온다(크리틱 C3). 이제
    // 문의 조건은 "비었나"가 아니라 **"목록을 아나"**([`StoreOrigin::is_known`])다.
    if !disk.origin.is_known() && !base_accounts.is_empty() {
        eprintln!("[auth] {STORE_FILE}을 못 읽었다(손상) — 병합을 건너뛰고 우리 목록으로 복구한다");
        return (mine.to_vec(), my_default.map(str::to_string));
    }
    // 파일이 통째로 없어진 판(정상 로그아웃은 빈 목록을 **쓴다** — 파일을 지우지 않는다).
    if disk.origin == StoreOrigin::Missing && !base_accounts.is_empty() {
        eprintln!("[auth] {STORE_FILE}이 사라졌다 — 병합을 건너뛰고 우리 목록으로 복구한다");
        return (mine.to_vec(), my_default.map(str::to_string));
    }
    let mut out: Vec<Value> = Vec::with_capacity(mine.len().max(disk.accounts.len()));
    for a in mine {
        let Some(email) = email_of(a) else {
            out.push(a.clone());
            continue;
        };
        let b = find(base_accounts, email);
        let d = find(&disk.accounts, email);
        match (b, d) {
            // 남이 지웠다(로그아웃). 우리 스냅샷이 낡았을 뿐이라 되살리면 안 된다.
            (Some(_), None) => continue,
            // 우리가 안 건드렸으면 디스크가 이긴다(그쪽이 더 나중 값이다).
            (Some(bv), Some(dv)) if bv == a => out.push(dv.clone()),
            _ => out.push(a.clone()),
        }
    }
    // 우리가 본 적 없는 계정 = 다른 창/앱에서 방금 로그인했다. 지울 이유가 없다.
    for d in &disk.accounts {
        let Some(email) = email_of(d) else { continue };
        if find(base_accounts, email).is_none() && find(mine, email).is_none() {
            out.push(d.clone());
        }
    }
    // 기본 계정도 같은 규칙 — 우리가 안 바꿨으면 디스크 것.
    let def = if my_default.map(str::to_string) == *base_default {
        disk.default_email.clone()
    } else {
        my_default.map(str::to_string)
    };
    (out, def)
}

/// ★R3(F1)③ — **계정 하나의 레코드만** 고친다. 목록·순서·기본 계정은 디스크 것이 이긴다.
///
/// 배경 쓰기(자동 전환 워커의 토큰 회전)가 쓰는 유일한 문이다. 디스크를 다시 읽으므로
/// 호출자의 낡은 스냅샷이 **다른 창에서 방금 한 로그아웃을 되돌릴 수 없다**.
/// 그 계정이 이미 없으면 [`AuthError::NotRegistered`] — 조용히 되살리지 않는다.
///
/// ★R4(G1) — 잠금은 R3 그대로 **read-modify-write 전체**를 감싼다(잠금을 아는 이웃과는
/// 그게 가장 싸다 — 재시도가 0이다). 달라진 것은 그 안이다: R3는 잠금 안에서 읽은 값을
/// 그대로 믿고 8~14ms 뒤에 썼고(safeStorage 복호+암호 = DPAPI 2회), 잠금을 **모르는**
/// 2.6.2의 통짜 쓰기가 그 창에 그대로 떨어졌다. 이제 쓰기 직전에 **"내가 읽은 바이트가
/// 아직 그대로인가"를 다시 묻는다**(CAS). 갈렸으면 클로저부터 다시 돈다 — 그래서 클로저는
/// `FnMut`이고 **여러 번 불릴 수 있다**(부작용을 두면 안 된다).
pub fn update_account_record<T>(email: &str, mut f: impl FnMut(&mut Map<String, Value>) -> T) -> Result<T, AuthError> {
    cas_edit(|cur| {
        let Some(i) = cur.accounts.iter().position(|a| email_of(a) == Some(email)) else {
            return Err(AuthError::NotRegistered(email.to_string()));
        };
        let mut m = cur.accounts[i].as_object().cloned().unwrap_or_default();
        let out = f(&mut m);
        cur.accounts[i] = Value::Object(m);
        Ok(out)
    })
}

// ── ★T1 배선 — 목록을 바꾸는 조작도 같은 CAS를 탄다 ─────────────────────────
//
// R4까지 CAS는 [`update_account_record`](배경 토큰 회전) **한 문에만** 있었다. 목록을
// 바꾸는 조작(로그인 편입·로그아웃·기본 계정·정렬)은 [`update_store`]로 갔고 그쪽은
// 잠금 한 겹뿐이었다 — 잠금을 **모르는** 2.6.2에게 그 겹은 없는 것과 같다.
//
// R4까지 그게 견딜 만했던 이유는 하나다: **그 조작들을 부를 길이 3.0에 없었다**
// (`auth:*` 쓰기 채널 IPC 핸들러 0개 — 최종 파리티 감사 T1). 그 다섯 채널을 붙이는
// 순간 목록 편집이 사용자 손에 들어오고, 그러면 R4가 회전 경로에서 닫은 창이 **로그인·
// 로그아웃 경로에서 그대로 열린다**. 그래서 두 문을 하나로 합쳐 같은 CAS를 태운다.
//
// 회전 경로와 다른 자리가 딱 하나 있다 — **멤버십이 늘어난다**. 파묻힌 쓰기 되살리기가
// "이웃 목록에 없는 계정은 지운다"이므로, 그대로 두면 우리가 방금 만든 계정(로그인)이
// 이웃의 옛 스냅샷에 없다는 이유로 지워진다. `added`가 그 자리를 막는다.
/// ★R28d(CASX) — **「파일이 없다」를 곧이곧대로 믿지 않는다.**
///
/// 이 OS에서 "이름 바꿔 덮기"는 부하가 걸리면 목적지 이름을 **밀리초 단위로 지웠다 되돌린다**
/// (실측: 옆 스레드의 `read_to_string`이 ENOENT를 4.6ms 동안 5번 연속. 옛 길·새 길 둘 다 —
/// [`crate::replace`] 모듈 주석의 4판 A/B). 그 창에서 읽으면 [`StoreOrigin::Missing`]이고,
/// `Missing`은 "첫 실행 = 계정 0개"라는 **사실**로 취급된다([`StoreOrigin::is_known`]).
/// 그 위에서 편집이 돌면 계정 하나 추가하는 로그인이 **나머지를 전부 지운다** —
/// 2.6.2가 같은 창에서 당한 사고를 우리가 그대로 재현하는 것이다(실측: 그 이웃이
/// `{"accounts":[]}`를 쓴 판에서 `m11r4_store_cas`가 붉었다).
///
/// 그래서 "없다"에 **복구 재료가 있으면**(마지막 성공본이 계정을 알고 있으면) 그것은
/// 사실이 아니라 창이라고 본다 — 다시 읽고, 그래도 없으면 복구한다. 진짜 첫 실행에는
/// 복구본이 없으므로 이 문은 안 열린다(빈 스토어 → 첫 로그인 그대로).
///
/// ### ★R28d(CASX R2) — 이것은 [`merge3`]의 「같은 정책」이 **아니다**(정책 판단으로 명시)
///
/// R1은 이 문을 "[`merge3`]이 이미 하는 판단을 CAS 경로에도 세우는 것"이라고 적었는데,
/// 확인 크리틱 R1 §7이 짚은 대로 **근거가 다르고 그래서 사정거리가 더 넓다**:
///
/// | | 근거 | 사정거리 |
/// |---|---|---|
/// | [`merge3`]의 `Missing` 문 | **이 프로세스 메모리의 base**(`!base_accounts.is_empty()`) | 그 프로세스가 이미 계정을 아는 판에서만 열린다 |
/// | 여기 | **디스크의 [`STORE_BACKUP_FILE`]** | **재시작을 넘어 산다** |
///
/// 그래서 이 문은 사용자(또는 지원 절차)가 `accounts.json`을 **지우고 앱을 새로 띄우는**
/// 판까지 연다 — 다음 편집 한 번이 백업에서 전 계정을 `credEnc`째 되살린다.
/// 그 대가를 알고도 여는 이유는 비대칭이다: 되살아난 계정은 사용자가 다시 지우면 되지만,
/// 갈아끼우기 창에 얻어맞은 목록은 **살아 있는 토큰째** 조용히 사라지고 출구가 재로그인뿐이다
/// (실측: 그 창에서 이웃이 `{"accounts":[]}`를 쓴 판에서 `m11r4_store_cas`가 붉었다).
/// 최소한 로그는 사실을 말한다 — [`recover_store`]가 "깨졌다"와 "없다"를 갈라 적는다.
///
/// **"파일을 지워서 계정을 지운다"는 지원 절차가 되면 안 된다**는 뜻이기도 하다. 계정을
/// 지우는 문은 [`remove_account`] 하나다(행 + 폴더 + 건강 장부를 같이 지운다).
fn vanished_but_we_know_better(cur: &StoreFile) -> bool {
    cur.origin == StoreOrigin::Missing
        && read_file_or_null(&store_backup_path())
            .as_deref()
            .and_then(parse_store)
            .is_some_and(|b| b.origin == StoreOrigin::Parsed && !b.accounts.is_empty())
}

// ── ★R28e(CASX2) — **쓰기 경로가 자기 의도를 선언한다** ─────────────────────
//
// 딱 한 가지를 가르려고 있다: 「배경 회전이 `credEnc`만 갈았다」와 「사용자가 다시
// 로그인해 그 행의 신원이 새로 섰다」. 둘은 디스크에서 **똑같이 보인다**(행 바이트가
// 갈렸다) — R4가 그 둘을 바이트로 가르려다 로그아웃을 영구히 취소한 자리다
// (확인 크리틱 R4 §3-1). 파일을 보고 못 가르는 것은 **부르는 쪽이 말해야 한다.**
//
// 선언이 없으면(기본값 [`ledger::Intent::Plain`]) 보수적으로 「신원이 새로 섰다」로 친다 =
// 그 행은 안 지운다. 모르면 안 지우는 쪽으로 진다는 이 모듈의 우선순위 그대로다.
thread_local! {
    static INTENT: std::cell::RefCell<ledger::Intent> = const { std::cell::RefCell::new(ledger::Intent::Plain) };
}

/// 이 스코프의 쓰기가 무엇을 하려는 것인지 선언한다. 중첩되면 **안쪽이 이긴다**
/// (되살리기 연쇄가 바깥 회전의 선언을 물려받지 않게 — 그건 다른 쓰기다).
fn with_intent<T>(i: ledger::Intent, f: impl FnOnce() -> T) -> T {
    let prev = INTENT.with(|c| c.replace(i));
    let out = f();
    INTENT.with(|c| *c.borrow_mut() = prev);
    out
}

fn cas_edit<T>(mut edit: impl FnMut(&mut StoreFile) -> Result<T, AuthError>) -> Result<T, AuthError> {
    let intent = INTENT.with(|c| c.borrow().clone());
    let mut retries = 0usize;
    let mut torn = 0usize;
    for _ in 0..CAS_TRIES {
        // ── ① 준비 ─────────────────────────────────────────────────────────
        let _g = store_lock();
        let (before, mut cur) = read_store_raw();
        if !cur.origin.is_known() || vanished_but_we_know_better(&cur) {
            // 이웃이 통짜 쓰기를 하는 **도중**에 읽었을 수 있다(2.6.2의 writeFileSync는
            // 원자적이 아니다). "계정이 없다"가 아니라 "지금은 모른다"이므로 다시 읽는다.
            torn += 1;
            if torn < READ_RETRIES {
                retries += 1;
                std::thread::sleep(std::time::Duration::from_millis(READ_RETRY_MS));
                continue;
            }
            // 여러 번 다시 읽어도 그대로다 = 지나가는 반쪽이 아니라 **정말 깨진(또는 정말
            // 사라진) 파일**이다.
            let Some(rec) = recover_store(cur.origin) else {
                let what = if cur.origin == StoreOrigin::Missing { "사라졌고" } else { "손상됐고" };
                return Err(AuthError::Io(format!("{STORE_FILE}: 파일이 {what} 복구본도 없다 — 계정 목록을 덮어쓰지 않는다")));
            };
            cur = rec;
        } else {
            // 이 읽기가 3-way 병합의 기준점이다(R3(F1)② — `read_store_file`과 같은 자리).
            record_base(&cur);
        }
        // ★R28e(CASX2) — **잠금 안에서 본 디스크 상태를 장부에 적는다.**
        //
        //   이 한 줄이 「그들 스냅샷은 어느 세대였나」의 재료다. 이웃이 놓은 행(우리가
        //   안 만든 계정)은 여기서만 장부에 들어온다 — 쓰기만 적으면 이웃의 로그인이
        //   장부에 영영 안 보이고, 그러면 그들의 로그아웃도 못 짚는다.
        //   직전 세대와 내용이 같으면 새 세대를 안 만든다([`ledger::note`]).
        //
        // ★R28f(확인 크리틱 R28e §3-1) — 이 문은 **읽기**다([`ledger::Intent::Seen`]).
        //   R28e는 여기를 `Intent::Plain`으로 적었고, 그건 우리 쓰기와 **같은 칸**이다.
        //   그래서 이웃이 자기 손으로 간 `credEnc`를 우리가 *관측만* 해도 장부에는
        //   「우리가 그 행의 신원을 새로 세웠다」로 적혔고, 그 행이 지울 후보일 때
        //   판정은 언제나 「그들이 못 본 행이다」로 져서 **로그아웃이 영구히 취소됐다**
        //   (크리틱 실측 10/10 · 옛 코드 10/10 살림). 이제 읽기는 읽기라고 적는다.
        ledger::note(&cur.accounts, &ledger::Intent::Seen);
        // 복구본으로 읽었으면 **무조건 쓴다** — 그게 깨진 본문을 고치는 유일한 순간이다.
        let repair = cur.origin == StoreOrigin::Recovered;
        let seen = cur.accounts.clone();
        let seen_default = cur.default_email.clone();
        let seen_version = cur.version;
        // ★R28e(CASX2) — 후보 세대의 **상한**. 그들의 읽기는 우리 커밋보다 앞이므로
        //   이 세대 이하만 본다(안 그러면 이번 편집이 방금 더한 로그인을 「그들 스냅샷에
        //   있었다」고 오독한다).
        let at_gen = ledger::gen_now();

        let out = edit(&mut cur)?;

        // 내용이 같으면 저장을 건너뛴다(2.6.2와 같은 의미론) — 안 바뀐 저장은 mtime만 흔들고
        // 남의 원자 저장과 경쟁할 이유가 없다.
        if !repair && cur.accounts == seen && cur.default_email == seen_default && seen_version == STORE_VERSION {
            return Ok(out);
        }
        let mut accounts = std::mem::take(&mut cur.accounts);
        let def = cur.default_email.clone();
        let mut body = render_store(&accounts, def.as_deref());

        // ── ② 갈아끼우기 + 파묻힌 쓰기 되살리기 ────────────────────────────
        let mut expect = before;
        let mut stale = false;
        // 되살리기 사연 — **커밋 뒤에** 찍는다(아래 `Commit::Buried` 주석 참고).
        let mut revived: Option<Revived> = None;
        // 되살린 로그아웃의 툼스톤도 커밋 **뒤에** 남긴다(파일 쓰기라 창 안에 두면 안 된다).
        // ★R28f — 이메일이 아니라 **행 자체**를 든다. 툼스톤의 지문이 그 행의 내용 해시라,
        //   이메일만 넘기면 지문이 `0`이 되어 복구본 걸러내기가 영원히 못 맞춘다
        //   (확인 크리틱 R28e §3-2 — 디스크에 `"fp": "0"`이 실물로 남아 있었다).
        let mut buried_rows: Vec<Value> = Vec::new();
        // 안 받은 사연(근거를 못 짚었다)도 같은 규율로 커밋 뒤에 찍는다.
        let mut unattributed: Option<String> = None;
        // ★R28d(CASX) — 목적지 핸들을 되살리기 연쇄 **안에서만** 물려준다. 바깥
        // (CAS 재시도) 까지 들고 가면 잠금을 놓은 사이 남이 갈아끼운 옛 inode를 증인으로
        // 삼게 된다 — 그건 증인이 아니라 유령이다.
        let mut carry: Option<std::fs::File> = None;
        // ★R28d(CASX R2) — 파묻힘 감시 예산은 **CAS 시도마다 새로** 준다(연쇄 전체가 나눠
        // 쓴다). 시도 전체가 한 예산을 나누면 경합이 심한 판에서 뒤쪽 시도의 검출력이 0이
        // 되고, 그건 이 라운드가 지켜야 할 로그아웃 승리 불변식을 갉는다.
        let bury_deadline = std::time::Instant::now() + std::time::Duration::from_millis(BURY_WATCH_BUDGET_MS);
        cas_trace!("edit 준비 — 읽은목록=[{}] 쓸목록=[{}]", seen.iter().filter_map(email_of).collect::<Vec<_>>().join(","), cas_emails(&body));
        for _ in 0..BURY_TRIES {
            match commit_locked(&body, expect.as_deref(), &mut carry, bury_deadline)? {
                Commit::Stale => {
                    // 이웃이 그사이에 썼다. 우리 스냅샷은 이미 낡았다 — 여기서 쓰면 그
                    // 쓰기가 사라진다(= 로그아웃 취소). 클로저부터 다시 돈다.
                    retries += 1;
                    stale = true;
                    break;
                }
                Commit::Clean(orphan) => {
                    set_base(&accounts, def.as_deref());
                    // ★R28e(CASX2) — **디스크에 보인 그 목록을 장부에 적는다.** 여기가
                    //   신원 세대가 서는(또는 안 서는) 자리다 — 선언된 회전이면 안 선다.
                    ledger::note(&accounts, &intent);
                    keep_backup(&body);
                    bury_all(&buried_rows, "이웃(잠금 모르는 통짜 쓰기)의 로그아웃 — 자물쇠 안에서 파내 그 자리에서 되살렸다");
                    if let Some(r) = &revived {
                        eprintln!(
                            "[auth] ★ {STORE_FILE}: 이웃의 로그아웃을 묻었다(계정 {}개 → {}개 · {}) — 그 자리에서 되살렸다{}{}",
                            r.was,
                            r.now,
                            r.why,
                            if r.held.is_empty() { String::new() } else { format!(" · 보류 {}: {}", r.held.len(), held_line(&r.held)) },
                            unsure_tail(&r.unsure)
                        );
                    }
                    if let Some(line) = &unattributed {
                        eprintln!("[auth] ★ {STORE_FILE}: {line}");
                    }
                    if retries > 0 {
                        eprintln!("[auth] {STORE_FILE} 저장 — 이웃과 {retries}번 부딪혀 다시 읽고 썼다(CAS)");
                    }
                    // ★R28d(CASX R3) — **자물쇠를 먼저 놓고** 옛 inode를 넘긴다. 감시는
                    //   이름 없는 inode 읽기뿐이라 임계 구역에 있을 이유가 없다(있으면
                    //   그만큼 사용자의 로그아웃이 멎는다).
                    drop(_g);
                    if let Some(orphan) = orphan.filter(|_| !REVIVING.with(std::cell::Cell::get)) {
                        late_watch(LateWatch {
                            orphan,
                            ours: accounts,
                            at_gen,
                            dst: store_path(),
                            since: std::time::Instant::now(),
                            next_at: std::time::Instant::now(),
                            torn: false,
                            owed: None,
                            held: Vec::new(),
                            unsure: Vec::new(),
                            why: String::new(),
                            owed_since: None,
                            found_us: 0,
                        });
                    }
                    return Ok(out);
                }
                // ★R4(G1) — 우리 `rename`이 이웃의 통짜 쓰기를 **묻었다**(창이 µs로 줄었을
                //   뿐 0은 아니다). 묻힌 원문을 파냈으니 **즉시** 되쓴다. 여기서 safeStorage를
                //   다시 안 도는 것이 핵심이다 — 우리 레코드는 이미 손에 있어서 µs로 끝난다.
                //
                //   ★ 받는 것은 **지우기뿐이다.** 그들이 더한 계정은 안 받는다. 이유는 ABA다:
                //   `로그인 → 로그아웃`처럼 파일이 **같은 바이트로 돌아오는** 판에서는 우리가
                //   판 것이 이미 낡은 중간 상태일 수 있고, 그걸 되살리면 그게 곧 우리가
                //   막으려던 사고다(실측: 이 규칙 없이 in-process 해머 150판에 13건).
                //   비대칭은 의도적이다 — 잃은 로그인은 사용자가 다시 하면 보이지만,
                //   되살아난 계정은 **살아 있는 토큰째** 조용히 돌아온다.
                Commit::Buried(theirs) => {
                    // ★R28d(CASX R3) — **봤다**는 사실을 장부에 남긴다(못이 침묵을 잰다).
                    bury_stats::IN_LOCK.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let Some(t) = parse_store(&theirs).filter(|t| t.origin.is_known()) else {
                        eprintln!("[auth] ★ {STORE_FILE}: 이웃의 쓰기를 묻었는데 원문을 못 읽는다 — 우리 것으로 둔다");
                        break;
                    };
                    // ★R28e(CASX2) — 자물쇠 **안팎이 같은 규칙을 쓴다**([`ledger::attribute`]).
                    //   R3까지 이 자리는 자기만의 `keep` 계산을 들고 있었고, R4는 개수
                    //   휴리스틱을 공유했다. 이제 둘 다 **그들 스냅샷 세대를 짚는** 같은
                    //   판정을 지난다 — 안팎이 갈리면 그 격차가 곧 다음 라운드의 사고다.
                    let (gone, held, unsure, why) = match ledger::attribute(&accounts, &t.accounts, at_gen) {
                        ledger::Verdict::Nothing => break, // 그들이 지운 계정이 없다 = 되살릴 것도 없다
                        ledger::Verdict::Blind(w) => {
                            bury_stats::REFUSED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            // 되살리기 창 안이라 여기서 안 찍는다 — 커밋 뒤에 적는다(`unattributed`).
                            unattributed = Some(blind_line(&t, &w));
                            break;
                        }
                        ledger::Verdict::Act { remove, held, why, .. } if remove.is_empty() => {
                            // 후보는 있었는데 전부 「그들이 못 본 행」이다. 되살릴 것이 없고,
                            // **사연은 남는다**(커밋 뒤에 찍는다).
                            bury_stats::MOVED_ON.fetch_add(held.len(), std::sync::atomic::Ordering::Relaxed);
                            unattributed = Some(format!(
                                "이웃의 쓰기를 묻었는데({why}) 지울 후보 {}개가 전부 그들 스냅샷보다 새 신원이다 — 한 건도 안 지운다: {}",
                                held.len(),
                                held_line(&held)
                            ));
                            break;
                        }
                        ledger::Verdict::Act { remove, held, unsure, why } => (remove, held, unsure, why),
                    };
                    if !held.is_empty() {
                        bury_stats::MOVED_ON.fetch_add(held.len(), std::sync::atomic::Ordering::Relaxed);
                    }
                    bury_stats::UNSURE.fetch_add(unsure.len(), std::sync::atomic::Ordering::Relaxed);
                    // ★R28f — 지우는 행을 **뜬 채로** 나눈다(툼스톤의 지문 재료가 여기다).
                    let mut next: Vec<Value> = Vec::with_capacity(accounts.len());
                    for a in accounts.iter() {
                        if email_of(a).is_some_and(|e| gone.iter().any(|(g, _)| g == e)) {
                            buried_rows.push(a.clone());
                        } else {
                            next.push(a.clone());
                        }
                    }
                    // ★R28d(CASX) — **되살리기 창 안에서는 한 줄도 안 찍는다.** 여기서
                    //   찍던 한 줄이 실측으로 되살리기를 0.8~7.6ms 늦췄고, 그동안 로그아웃한
                    //   계정이 `credEnc`째 파일에 앉아 있었다(이웃이 자기 쓰기 1ms 뒤에
                    //   다시 읽으면 그걸 본다). 사연은 커밋한 **뒤에** 적는다(`revived`).
                    // ★R28d(CASX R3) — **행을 되살린** 판만 따로 센다. 못이 "이 되살아남을
                    // 제품이 봤나"를 이 수로 재기 때문이다(그들의 편집을 묻은 판과 그들의
                    // 로그아웃을 묻은 판은 무게가 다르다).
                    bury_stats::IN_LOCK_REVIVED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    revived = Some(Revived { was: accounts.len(), now: next.len(), why, held, unsure });
                    accounts = next;
                    expect = Some(body);
                    body = render_store(&accounts, def.as_deref());
                }
            }
        }
        if !stale {
            // 되살리기를 BURY_TRIES번 하고도 못 끝냈거나, 파낸 원문에 되살릴 것이 없었다.
            // 마지막 커밋은 이미 디스크에 있다(유실 아님) — 다음 회전이 이어 받는다.
            ledger::note(&accounts, &intent);
            bury_all(&buried_rows, "이웃(잠금 모르는 통짜 쓰기)의 로그아웃 — 자물쇠 안에서 파내 그 자리에서 되살렸다");
            if let Some(r) = &revived {
                eprintln!(
                    "[auth] ★ {STORE_FILE}: 이웃의 로그아웃({}개 → {}개 · {})을 되살리다 또 겹쳤다 — 여기서 접는다{}{}",
                    r.was,
                    r.now,
                    r.why,
                    if r.held.is_empty() { String::new() } else { format!(" · 보류 {}: {}", r.held.len(), held_line(&r.held)) },
                    unsure_tail(&r.unsure)
                );
            }
            if let Some(line) = &unattributed {
                eprintln!("[auth] ★ {STORE_FILE}: {line}");
            }
            keep_backup(&body);
            return Ok(out);
        }
    }
    Err(AuthError::Io(format!("{STORE_FILE}: 다른 프로세스와 {CAS_TRIES}번 부딪혀 저장을 접었다")))
}

/// ★R28i LOCKS ② — **「이웃이 우리 갈아끼우기에 걸터탔다」를 못이 세우는 리허설 창.**
///
/// 기본값 `0`이다 — 값이 없으면 이 함수는 `OnceLock` 한 번 읽기고 제품 거동은 글자 그대로
/// 안 바뀐다(같은 모양의 선례: [`cas_trace_on`] · `replace.rs`의 `CASX_OLD_SWAP`).
///
/// ## 왜 이런 손잡이가 필요한가
///
/// 자물쇠 **안** `Commit::Buried` 갈래는 이웃의 열기가 `[증인 읽기 → 갈아끼우기]`
/// 사이에 들어오고 그들의 쓰기가 **갈아끼우기 직후 첫 판독 전에** 떨어져야 선다. 그 창은
/// 실측 50~600µs고, 크리틱이 이웃 통짜 쓰기를 **12,700판** 던져 262판(2.06%)에서 세웠다
/// (75초짜리 프로브). 그 모양을 그대로 게이트에 넣으면 못이 아니라 복권이고, 넣지 않으면
/// 그 갈래는 **무방비**다 — 실제로 자물쇠 안 Blind 두 줄(카운터 + 진단 한 줄)을 통째로
/// 지운 돌연변이에서 `cargo test -p ccg-auth`가 125 통과 0 실패였다.
///
/// 그래서 **경합을 없애는 대신 순서를 잡아 준다**: 갈아끼우기 직후 여기서 쉬는 동안
/// 이웃(못 안의 스레드)이 「이름이 새 inode를 가리킨다」를 보고 옛 핸들에 통짜로 쓴다.
/// 그 뒤의 판독·판정·되살리기는 **제품 코드 그대로**다 — 늦추는 것은 잠금 보유 시간뿐이고
/// 분기는 한 줄도 안 바꾼다.
fn bury_rehearsal() {
    static MS: std::sync::OnceLock<u64> = std::sync::OnceLock::new();
    let ms = *MS.get_or_init(|| {
        std::env::var("CCG_CAS_BURY_REHEARSAL_MS")
            .ok()
            .and_then(|v| v.trim().parse::<u64>().ok())
            .filter(|v| *v <= 5_000) // 손이 미끄러져도 잠금이 초 단위로 멎지 않게
            .unwrap_or(0)
    });
    if ms > 0 {
        eprintln!("[auth] ★ 리허설 창 {ms}ms — 테스트 손잡이(CCG_CAS_BURY_REHEARSAL_MS)가 켜져 있다");
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }
}

/// [`commit_locked`]의 착지 세 갈래.
enum Commit {
    /// 커밋했고, **자물쇠 안에서 본 한** 묻은 쓰기는 없다.
    ///
    /// ★R28d(CASX R3) — "없다"가 아니라 "여기까지 봐서는 없다"이다. 이웃의 열기가 우리
    /// 갈아끼우기를 걸터타면 그들의 쓰기는 **수 ms 뒤에** 이름 없는 옛 inode로 떨어진다
    /// (실측 321/1,010). 그래서 그 옛 inode를 [`late_watch`]에 넘긴다 — `None`이면
    /// 넘길 것이 없다는 뜻이다(증인을 못 열었거나 파일이 없던 판).
    Clean(Option<Orphan>),
    /// 커밋했는데 `[확인, rename]` 창에 이웃이 통짜로 썼다 — 파낸 그 원문.
    Buried(String),
    /// 확인에서 갈렸다 — **커밋 안 했다**.
    Stale,
}

/// CAS 한 번. **호출자가 [`store_lock`]을 쥐고 있어야 한다**(안에서 또 잡으면 교착이다).
///
/// 잠금을 모르는 이웃에게 열려 있는 창은 여기 두 줄뿐이다 —
/// **증인 읽기(실측 17µs) → 갈아끼우기(실측 50~600µs)**. R3의 8~14ms에서 20~200배 좁다.
/// 커밋 뒤 옛 inode를 한 번 더 읽어 그 창에 떨어진 쓰기가 있었는지 본다(그 읽기는 창 밖이다).
///
/// ★R28d(CASX) — 갈아끼우기는 [`crate::replace`]다(std `rename` 아님).
///
/// ★R28d(CASX R2) — R1은 그 이유를 "std의 `rename`은 부하가 걸리면 지우고-옮기는 두
/// 걸음으로 떨어져 ① 읽는 이웃에게 ENOENT를 보이고 ② 쓰는 이웃을 제3의 inode로 보낸다"고
/// 적었는데 **그 진단은 A/B로 철회됐다**(옛 길에서 그 창이 더 컸다 = OS 성질·선존).
/// ①②는 지금도 **열려 있다** — 확인 크리틱 R1이 HEAD 20주행 중 2주행에서 이웃의 읽기
/// 실패를 그대로 관측했다(`m11r4_store_cas`의 `missed`). 이 모듈이 실제로 주는 것은
/// **되살리기 창의 속도**다: `replace`가 갈아끼운 핸들을 돌려주므로 아래 증인 검사와
/// 되살리기 연쇄가 `open`(실측 350µs)을 안 낸다.
///
/// `deadline`은 아래 파묻힘 감시의 **총 예산**이다 — [`cas_edit`]의 CAS 시도 한 번이
/// 되살리기 연쇄 전체와 나눠 쓴다(자세한 이유는 [`BURY_WATCH_BUDGET_MS`]).
fn commit_locked(body: &str, expect: Option<&str>, carry: &mut Option<std::fs::File>, deadline: std::time::Instant) -> Result<Commit, AuthError> {
    let dst = store_path();
    // 임시 파일 쓰기(실측 140µs)는 창 **밖**이다 — 갈아끼우기만 창 안이다.
    let staged = crate::replace::stage(&dst, body).map_err(|e| AuthError::Io(format!("{STORE_FILE}: {e}")))?;
    // ★R28d(CASX) — 증인은 **앞 라운드가 넘겨준 핸들**을 먼저 쓴다. 갈아끼우기가
    // 돌려준 핸들이 곧 지금의 목적지라, 되살리기 창에서 `open` 350µs(이 경로에서 가장
    // 비싼 한 줄)를 통째로 안 낸다.
    let mut w = match carry.take() {
        Some(f) => Some(f),
        None => crate::replace::witness(&dst),
    };
    let now = w.as_mut().and_then(crate::replace::read_witness);
    if now.as_deref() != expect {
        cas_trace!("증인 갈림 → Stale — 기대=[{}] 지금=[{}]", expect.map(cas_emails).unwrap_or("<없음>".into()), now.as_deref().map(cas_emails).unwrap_or("<없음>".into()));
        return Ok(Commit::Stale); // 커밋 안 한 임시 파일은 `Pending`이 치운다
    }
    cas_trace!("갈아끼우기 시작 — 본문=[{}]", cas_emails(body));
    *carry = staged.replace(&dst).map_err(|e| AuthError::Io(format!("{STORE_FILE}: {e}")))?;
    cas_trace!("갈아끼우기 끝");
    bury_rehearsal();
    let (Some(mut w), Some(prev)) = (w, expect) else {
        // 증인을 못 열었거나(경합) 애초에 파일이 없던 판 — 옛 inode가 없으니 볼 것도 없다.
        cas_trace!("증인 없음 → Clean(무검사)");
        return Ok(Commit::Clean(None));
    };
    // 옛 inode를 다시 본다. 이웃이 쓰는 **도중**이면 반쪽이 읽히므로 잠깐 기다렸다 다시
    // 본다 — 그들은 자기 파일이 이미 갈렸다는 걸 모르고 끝까지 쓴다.
    //
    // ★R28d(CASX) — **"그대로"는 첫 판독에서만 믿는다.** 이웃의 `writeFileSync`는 여는
    // 순간 파일을 0바이트로 자르므로(`CREATE_ALWAYS`), 우리 갈아끼우기 전에 연 이웃이
    // 있었다면 첫 판독이 반드시 `expect`와 다르다. 갈아끼운 뒤에는 그 inode에 이름이
    // 없어 새로 열 수도 없다. 그래서 첫 판독이 `expect`면 묻은 쓰기는 **없다**.
    // 반대로 한 번이라도 흔들렸으면 이웃이 쓰는 중이므로 [`BURY_WATCH`]만큼 기다린다 —
    // R28d 이전의 상한(4×300µs)은 부하 걸린 판의 통짜 쓰기를 놓쳤다.
    for k in 0..BURY_WATCH {
        match crate::replace::read_witness(&mut w) {
            Some(a) if a == prev => {
                cas_trace!("옛 inode 그대로(k={k}) → Clean(지연 감시로 넘긴다)");
                // ★R28d — 묻은 것이 없으면 목적지 핸들을 **여기서 놓는다.** 물려주는
                //   이유는 되살리기 창의 `open` 350µs 하나뿐이고, 되살릴 것이 없는 판에서
                //   계속 들고 있으면 다음 갈아끼우기가 「열려 있는 목적지」를 덮는 느린
                //   길로 간다(실측: 목적지를 연 채 갈아끼우면 이름이 사라져 보이는 창이
                //   두 배 — `replace.rs` 모듈 주석의 4판 A/B).
                *carry = None;
                // ★R28d(CASX R3) — 옛 inode는 **놓지 않는다.** 이 판정("그대로")이
                //   틀리는 비율이 실측 31.8%다(모듈 주석 표) — 이웃의 열기가 우리
                //   갈아끼우기를 걸터타면 그들의 쓰기는 몇 ms 뒤에 온다.
                return Ok(Commit::Clean(Some(Orphan { file: w, was: a })));
            }
            Some(a) if parse_store(&a).is_some_and(|p| p.origin.is_known()) => {
                cas_trace!("옛 inode 갈림(k={k}) → Buried=[{}]", cas_emails(&a));
                return Ok(Commit::Buried(a));
            }
            other => cas_trace!("옛 inode 판독 불가(k={k}) — {}", other.map(|s| format!("{}B", s.len())).unwrap_or("읽기실패".into())),
        }
        // ★R28d(CASX R2) — 상한은 **횟수와 시계 둘 다**다([`BURY_WATCH_BUDGET_MS`]).
        // 판독은 위에서 이미 한 번 했으므로, 예산이 0이어도 옛 4×300µs 시절보다
        // 검출력이 낮아지지는 않는다.
        if k + 1 >= BURY_WATCH || std::time::Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(std::time::Duration::from_micros(BURY_WATCH_US));
    }
    // ★R28d — 여기까지 왔다 = 옛 inode가 흔들린 채(반쪽·0바이트) 자물쇠 안 예산을 다 썼다.
    // 이웃이 쓰다 만 것이고, 그 쓰기가 로그아웃이었다면 **지금 우리 파일이 그것을 취소한
    // 상태**다.
    //
    // ★R28d(CASX R3) — R2는 여기서 "못 읽었다"를 찍고 끝냈다. 이제는 **자물쇠를 놓고
    // 계속 본다** — 그들이 쓰기를 마치면 그 원문으로 되살릴 수 있고, 그래도 못 읽으면
    // 그때 같은 줄을 [`late_watch_tick`]이 찍는다(둘 다 찍으면 같은 사고가 두 줄이 된다).
    cas_trace!("옛 inode 아직 흔들림 → Clean(지연 감시로 넘긴다)");
    Ok(Commit::Clean(Some(Orphan { file: w, was: prev.to_string() })))
}

/// 잠금 안에서 스토어 전체를 고친다(목록이 바뀌는 사용자 조작 — 로그인·로그아웃·정렬).
/// 클로저는 **증표 안에서 뜬** 스냅샷을 받으므로 병합이 필요 없다.
///
/// ★R4(G3/C7) — 다만 "증표 안에서 떴다"가 "읽었다"를 뜻하지는 않는다. 파일이 깨져 있으면
/// R3의 [`read_store_file`]은 **빈 목록**을 줬고, 그 위의 로그인 한 번이 나머지 계정을
/// 전부 지웠다(크리틱 C7). 이제 목록을 모르는 판에서는 [`STORE_BACKUP_FILE`]로 복구하고,
/// 그것마저 없으면 **쓰지 않고 실패로 착지한다** — 모르는 위에 덮어쓰는 것보다 낫다.
/// ★T1 — 이제 [`cas_edit`]에 위임한다(R4까지는 잠금 한 겹 + 통짜 되쓰기였다).
///
/// 클로저가 **여러 번 불릴 수 있다**(CAS 재시도)는 것이 유일한 계약 변화다 — 그래서
/// `FnOnce`가 아니라 `FnMut`이고, 부작용을 넣으면 안 된다. 재시도는 이웃이 우리 읽기와
/// 쓰기 사이에 끼어들었을 때만 일어난다.
pub fn update_store<T>(mut f: impl FnMut(&mut StoreFile) -> T) -> Result<T, AuthError> {
    cas_edit(|cur| Ok(f(cur)))
}

// ── safeStorage 래핑 (ccg-store가 단일 소스) ────────────────────────────────

fn enc_creds(raw: &str) -> Option<String> {
    if ccg_store::safe_storage::available() {
        ccg_store::safe_storage::encrypt(raw)
    } else {
        // 2.6.2 폴백과 같다 — 암호화를 못 쓰는 환경에서는 base64 평문
        Some(ccg_store::safe_storage::b64_encode(raw.as_bytes()))
    }
}

fn dec_creds(b64: &str) -> Option<String> {
    if ccg_store::safe_storage::available() {
        ccg_store::safe_storage::decrypt(b64)
    } else {
        String::from_utf8(ccg_store::safe_storage::b64_decode(b64)?).ok()
    }
}

// ── 스냅샷 ──────────────────────────────────────────────────────────────────

/// `{ creds, account, userID? }` — 복호화된 credEnc의 알맹이.
/// 되쓸 때 키 순서·모르는 키를 보존해야 해서 원본 `Map`을 그대로 든다.
#[derive(Debug, Clone, Default)]
pub struct Snapshot {
    pub raw: Map<String, Value>,
}

impl Snapshot {
    pub fn parse(s: &str) -> Snapshot {
        match serde_json::from_str::<Value>(s) {
            Ok(Value::Object(m)) => Snapshot { raw: m },
            // JS: JSON.parse 실패 → { creds: '', account: null }(아래 손상 판정에 걸린다)
            _ => Snapshot::default(),
        }
    }
    pub fn creds(&self) -> Option<&str> {
        self.raw.get("creds").and_then(Value::as_str).filter(|s| !s.is_empty())
    }
    pub fn account(&self) -> Option<&Value> {
        self.raw.get("account").filter(|v| !v.is_null())
    }
    pub fn user_id(&self) -> Option<&Value> {
        self.raw.get("userID")
    }
    /// `JSON.stringify({ ...snap, creds })` — 자리 보존 치환 + 공백 없는 직렬화.
    pub fn with_creds(&self, creds: &str) -> String {
        let mut m = self.raw.clone();
        m.insert("creds".into(), json!(creds));
        Value::Object(m).to_string()
    }
}

/// 크리덴셜의 신선도 키. accessToken이 없으면 0(껍데기), expiresAt이 숫자가 아니면 1.
/// 물질화(어느 쪽을 남길지)와 되싱크(백업을 갱신할지) 판정이 전부 이 값 비교다.
pub fn creds_expires_at(raw: Option<&str>) -> f64 {
    let Some(raw) = raw else { return 0.0 };
    let Ok(v) = serde_json::from_str::<Value>(raw) else { return 0.0 };
    let Some(o) = v.get("claudeAiOauth") else { return 0.0 };
    // JS의 falsy 검사 — 빈 문자열도 "없음"이다
    match o.get("accessToken").and_then(Value::as_str) {
        Some(t) if !t.is_empty() => {}
        _ => return 0.0,
    }
    o.get("expiresAt").and_then(Value::as_f64).unwrap_or(1.0)
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

// ── 목록·기본 계정 ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountInfo {
    pub email: String,
    pub subscription_type: Option<String>,
    pub is_default: bool,
}

// ── ★R28 ACCT §4 — 「기본 계정」은 상태가 아니라 **파생값**이다 ────────────────
//
// 사용자 요청(`docs/r28-followup.md` §4): *"계정의 「기본」 개념을 삭제하고, 항상 정렬
// 기준 맨 위 계정이 선택되게. 괜히 복잡하다."*
//
// 그래서 기본 = **목록 맨 위**다. `defaultEmail` 필드는 더 이상 읽지 않고, 남아 있으면
// 한 번 **맨 위로 옮긴 뒤 지운다**([`ensure_default_migrated`]) — 그 순간부터 사용자가
// 보던 기본 계정과 파생값이 같은 계정을 가리킨다. 2.6.2와의 **의도적 분기**이고
// `docs/renderer-divergence.md` §6에 기록돼 있다(파리티 재감사가 회귀로 잡지 않게).
//
// 왜 필드를 그냥 무시하지 않고 옮기나: 무시만 하면 `defaultEmail`이 3번째 계정을
// 가리키던 사용자의 새 채팅이 **말없이 1번째 계정으로 갈아탄다**(프롬프트 캐시가 식는
// 비용 + 남의 한도를 태우는 사고). 옮기면 파생값이 옛 기본과 같아져 동작이 보존된다.

/// 마이그레이션은 **프로세스당 한 번**만 시도한다(스토어를 쓰는 경로라 매 조회마다
/// 돌면 안 된다). 실패해도 다시 시도하지 않는다 — 그 판에서는 `defaultEmail`이 남고
/// 파생값이 이기지만, 목록 자체는 멀쩡하다.
static DEFAULT_MIGRATED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 옛 `defaultEmail`이 가리키던 계정을 **맨 위로 옮긴다**. 이미 맨 위면(=마이그레이션
/// 이 끝난 상태) 아무것도 쓰지 않는다 — 매 부팅 CAS 쓰기가 생기지 않는다.
///
/// **필드 자체는 파일에서 사라지지 않는다.** [`render_store`]가 `None`을 받으면 목록
/// 맨 위로 다시 채우기 때문이다(2.6.2가 같은 홈을 읽었을 때 기본 계정이 없다고 보면
/// 안 되므로 그 자리는 그대로 둔다). 달라진 것은 **우리가 그 값을 안 읽는다**는 것과,
/// 그래서 파일의 `defaultEmail`이 이제 언제나 「맨 위 계정」과 같아진다는 것이다.
///
/// 돌려주는 값은 "무언가 옮겼나"다 — 테스트·하네스가 왕복을 잰다.
pub fn migrate_default_to_top() -> bool {
    update_store(|f| {
        let Some(d) = f.default_email.take() else { return false };
        let Some(i) = f.accounts.iter().position(|a| email_of(a) == Some(d.as_str())) else { return false };
        if i == 0 {
            return false;
        }
        let rec = f.accounts.remove(i);
        f.accounts.insert(0, rec);
        true
    })
    .unwrap_or(false)
}

/// ★R28 ACCT R2(F3) — **부팅에서 한 번, 첫 목록 조회보다 먼저** 부르는 문.
///
/// R1은 이 함수가 사적이었고, 실제로 트리거하는 것은 `list_accounts`·`default_account_email`
/// 뿐이었다. 그런데 화면이 읽는 목록은 `ipc/system.rs`가 `accounts.json`을 **직접** 읽어
/// 만들고, 실행 정체성의 기본도 `engine/ident.rs::defaults()`가 직접 읽는다 — 둘 다 이
/// 함수를 안 지난다. 결과: 2.6.2 승계 판(`defaultEmail`이 3번째)에서 **첫 세션 내내**
/// 화면·새 채팅이 옛 순서의 1번째 계정을 썼다. §4가 막겠다던 바로 그 사고다
/// (확인 크리틱 R1 F3 — 재시작해야 3번째가 됐다).
///
/// **프로세스당 한 번**이라 부팅에서 불러 두면 그 뒤 모든 경로가 마이그레이션된 순서를
/// 본다. 여러 번 불러도 CAS 한 번 이상은 아무 일도 안 한다.
pub fn ensure_default_migrated() {
    use std::sync::atomic::Ordering;
    if DEFAULT_MIGRATED.swap(true, Ordering::SeqCst) {
        return;
    }
    // 읽기만으로 판별해 **옮길 게 없으면 쓰기 경로에 들어가지도 않는다**(대부분의 부팅).
    let f = read_store_quiet();
    let top = f.accounts.first().and_then(email_of);
    if f.default_email.as_deref().is_some_and(|d| Some(d) != top) {
        migrate_default_to_top();
    }
}

/// 미지정 채팅이 쓸 계정 — **목록 맨 위**(파생값), 0개면 None.
pub fn default_account_email() -> Option<String> {
    ensure_default_migrated();
    read_store_quiet().accounts.first().and_then(email_of).map(str::to_string)
}

/// 등록 계정 목록 — 스토어만 본다(CLI 스폰 없음).
/// `is_default`는 **인덱스 0**이다(파생값 — 저장된 상태가 아니다).
pub fn list_accounts() -> Vec<AccountInfo> {
    ensure_default_migrated();
    read_store_quiet()
        .accounts
        .iter()
        .enumerate()
        .filter_map(|(i, a)| {
            let email = email_of(a)?.to_string();
            Some(AccountInfo {
                is_default: i == 0,
                subscription_type: subscription_of(a).map(str::to_string),
                email,
            })
        })
        .collect()
}

/// BUG-0013(클로드 축) — 구독 변경(Pro→Max 등)을 스토어 `subscriptionType`에 되싱크한다.
/// 스토어 값은 로그인 때 `auth status`가 준 것이라 그 뒤의 변경을 모른다 — 서버 진실은
/// [`crate::net::fetch_account_subscription`]이 가져오고 여기는 **다를 때만** 쓴다.
/// 등록되지 않은 계정·저장 실패는 false.
pub fn resync_subscription(email: &str, subscription_type: &str) -> bool {
    let same = read_store_quiet()
        .accounts
        .iter()
        .find(|a| email_of(a) == Some(email))
        .map(|a| subscription_of(a) == Some(subscription_type));
    match same {
        Some(false) => update_account_record(email, |m| {
            m.insert("subscriptionType".into(), json!(subscription_type));
        })
        .is_ok(),
        _ => false,
    }
}

/// 「맨 위로 이동」 — 옛 `auth:set-default-account`와 **동치**로 정리된 자리(§4).
/// 이름을 남겨 둔 이유는 채널 하나가 아직 이 함수를 부르기 때문이다(`ipc/accounts.rs`).
/// 목록에 없는 이메일이면 아무것도 안 한다(2.6.2와 같은 조용한 무시).
pub fn set_default_account(email: &str) -> Vec<AccountInfo> {
    move_account_to_top(email)
}

/// 계정 하나를 목록 맨 위로. **레코드를 통째로 옮긴다**(이메일로 새로 만들지 않는다 —
/// `credEnc` 백업이 딸린 원본이라 재조립하면 토큰을 잃는다. `reorder_accounts` 참고).
pub fn move_account_to_top(email: &str) -> Vec<AccountInfo> {
    ensure_default_migrated();
    let _ = update_store(|f| {
        // 같은 이메일 레코드가 둘이면 **마지막**이 이긴다(reorder_accounts와 같은 규칙).
        let Some(i) = f.accounts.iter().rposition(|a| email_of(a) == Some(email)) else { return };
        if i == 0 {
            return;
        }
        let rec = f.accounts.remove(i);
        f.accounts.insert(0, rec);
        // ★ 순서를 바꾸면 옛 `defaultEmail`은 놓는다 — 안 놓으면 파일에 남은 그 값이
        //   **다음 부팅의 마이그레이션에서 사용자의 정렬을 되돌린다**(§4의 함정).
        f.default_email = None;
    });
    list_accounts()
}

/// 목록에서 제거 + 물질화된 폴더 정리. (서버 토큰 해지는 CLI 경로 — `verify::logout_command`)
///
/// ★R28e(CASX2) — 여기서 **툼스톤을 남긴다**(이메일 + 시각 + 주체). 이 갈래의 헤드라인은
/// *"사용자의 로그아웃은 취소되지 않는다"*인데, R28d까지 그 의도는 **파일 상태로만** 남았다:
/// 행이 없어진 것이 「사용자가 지웠다」인지 「누가 오독하고 통짜로 덮었다」인지 파일만 봐서는
/// 모른다. 툼스톤은 그 구별을 **재시작을 넘어** 남기고, 마지막 성공본에서 목록을 복구할 때
/// 그 계정이 `credEnc`째 돌아오는 것을 막는다([`ledger::without_buried`]).
pub fn remove_account(email: &str) -> Vec<AccountInfo> {
    // 지우기 **전에** 그 행을 뜬다 — 툼스톤이 드는 지문이 그 행의 것이라야
    // 「되살아난 시체」와 「그 뒤의 새 로그인」이 갈린다.
    let row = read_store_quiet().accounts.iter().find(|a| email_of(a) == Some(email)).cloned();
    let _ = update_store(|f| f.accounts.retain(|a| email_of(a) != Some(email)));
    ledger::bury(email, "이 앱의 로그아웃(사용자 조작)", row.as_ref());
    delete_account_dir(email);
    // ★R4(G2) — 로그아웃은 **그 계정에 대한 우리 기억을 버리는** 자리다. 건강 장부를
    // 남겨 두면 같은 이메일로 다시 로그인했을 때 새 계정이 태어나자마자 격리된다.
    crate::health::clear(email);
    list_accounts()
}

/// 순서 변경 — 주어진 순서에 없는 계정은 기존 순서대로 뒤에 남긴다(드래그 중 다른 창에서
/// 로그인해 목록이 어긋나도 유실 없음).
///
/// **레코드를 절대 잃지 않는다.** 2.6.2는 `next.includes(a)`가 **참조 비교**라 같은 이메일
/// 레코드가 둘이면 둘 다 남는데, 이메일로 걸러 버리면 두 번째 레코드의 `credEnc`(암호화 토큰
/// 백업)가 드래그 한 번에 사라진다(M5 R1 크리틱 §4-2). 그래서 이메일이 아니라 **인덱스**로
/// 잡는다 = 참조 비교와 같은 의미론.
///
/// 2.6.2와 의도적으로 다른 점 하나: 입력 `emails`에 같은 이메일이 두 번 오면 2.6.2는 같은
/// 레코드를 **두 벌로 복제해** 저장한다(`new Map` + `emails.map`). 여기서는 한 번만 놓는다 —
/// 복제는 없던 계정을 만드는 쪽이라 유실 금지 원칙과 방향이 반대다.
pub fn reorder_accounts(emails: &[String]) -> Vec<AccountInfo> {
    let _ = update_store(|f| {
        let mut order: Vec<usize> = Vec::with_capacity(f.accounts.len());
        for e in emails {
            // 2.6.2의 `new Map(accounts.map(a => [a.email, a]))` — 같은 이메일이 둘이면 **마지막**이 이긴다
            let Some(i) = f.accounts.iter().rposition(|a| email_of(a) == Some(e.as_str())) else { continue };
            if !order.contains(&i) {
                order.push(i);
            }
        }
        for i in 0..f.accounts.len() {
            if !order.contains(&i) {
                order.push(i);
            }
        }
        f.accounts = order.into_iter().map(|i| f.accounts[i].clone()).collect();
        // ★R28 ACCT §4 — 순서가 곧 기본이다. 옛 `defaultEmail`을 들고 있으면 다음 부팅의
        //   마이그레이션이 그 계정을 다시 맨 위로 올려 **사용자의 정렬을 되돌린다**.
        f.default_email = None;
    });
    list_accounts()
}

// ── 격리 CONFIG_DIR 물질화 ──────────────────────────────────────────────────

/// 공유 원본 보장 — 정션 대상이 항상 있어야 CLI가 계정 폴더 안에 실폴더를 파지 않는다.
pub fn ensure_shared_root() {
    for name in SHARED_DIRS {
        let _ = std::fs::create_dir_all(shared_root().join(name));
    }
}

/// 세션 기록·도구 환경 잇기. 실패는 그 항목만 격리 동작이라 조용히 넘어간다(2.6.2와 동일).
/// 이미 뭔가 있으면(링크든 실폴더든) 데이터 보존을 우선해 그대로 둔다.
pub fn link_shared_state(dir: &Path) {
    ensure_shared_root();
    let shared = shared_root();
    for name in SHARED_DIRS {
        let dst = dir.join(name);
        if std::fs::symlink_metadata(&dst).is_ok() {
            continue;
        }
        let _ = junction::create(&dst, &shared.join(name));
    }
    for name in COPIED_FILES {
        let src = shared.join(name);
        if src.is_file() {
            let _ = std::fs::copy(&src, dir.join(name));
        }
    }
}

/// 등록 계정의 복호화된 스냅샷 — **파일을 쓰지 않는다**(판정 전용).
/// 실패 이유를 그대로 구분해 준다: 미등록 / 복호 불가 / 알맹이 손상.
///
/// ★SLUG R2(확인 크리틱 R1 중대①) — [`read_store_settled`]로 읽는다.
///
/// R28d(CASX R3)가 격상한 조회는 [`freshest_creds`]와 [`is_registered`] 둘이었고 이
/// 함수는 그 목록에서 **빠져 있었다**. 그때는 그래도 됐다 — 이 함수는 채팅 턴에 안
/// 걸렸으니까. **SLUG R1이 그 전제를 바꿨다**: 이제 Claude 채팅의 *모든 턴*이
/// [`account_run_dir`] → 이 함수 위에 선다.
///
/// 그래서 단발 읽기의 대가가 달라졌다. 잠금을 모르는 이웃(2.6.2 `writeFileSync`)이 쓰는
/// 도중에 걸리면 `accounts`가 **빈 목록**이고, 이 크레이트에서 그 뜻은 「0개」이지
/// 「모른다」가 아니다. 그 한 판에서 **같은 순간에** 조회는 「등록돼 있다」(`.bak` 복구까지
/// 하며)인데 턴은 `Err(NotRegistered)`가 됐다 — 자격증명이 폴더에 멀쩡히 살아 있는데
/// 화면에는 「설정 ▸ Account에 등록된 계정이 아니에요」가 뜨고, 그 턴에 사용자가 친 글은
/// 사라진다(컴포저는 `run()` 직전에 비워진다). 게다가 조회가 `.bak`으로 복구해도 파일이
/// 고쳐지는 것은 아니라 **다음 턴도 같은 답**이었다.
///
/// SLUG R1 **이전** 코드는 그 판에서 살아남았다 — 옛 접두 스캔은 `accounts.json`을 아예
/// 안 읽었기 때문이다. 즉 R1은 「틀린 답을 조용히 내던 자리」를 고치면서 「살아남던
/// 손상」을 전면 장애로 바꿨다. 이 한 줄이 그 노출을 되돌린다: 조회와 턴이 **같은 강도로**
/// 읽으므로 두 답이 갈릴 수 없다.
pub fn snapshot_of(email: &str) -> Result<Snapshot, AuthError> {
    let f = read_store_settled();
    let target = f
        .accounts
        .iter()
        .find(|a| email_of(a) == Some(email))
        .ok_or_else(|| AuthError::NotRegistered(email.to_string()))?;
    let enc = cred_enc_of(target).ok_or_else(|| AuthError::CorruptSnapshot(email.to_string()))?;
    let raw = dec_creds(enc).ok_or_else(|| AuthError::Undecryptable(email.to_string()))?;
    let snap = Snapshot::parse(&raw);
    if snap.creds().is_none() || snap.account().is_none() {
        return Err(AuthError::CorruptSnapshot(email.to_string()));
    }
    Ok(snap)
}

/// 실행용 계정 폴더 — 등록 계정의 격리 `CLAUDE_CONFIG_DIR`(항상 절대 경로).
///
/// 폴더 쪽 토큰이 더 신선하면(직전 실행에서 CLI가 리프레시) 남기고, 백업이 더 신선하면
/// (재로그인 등) 백업으로 덮는다. 신원(`oauthAccount`·`userID`)은 `.claude.json`에 병합한다 —
/// 토큰만 넣으면 CLI가 토큰 주인으로 자가 교정해 "계정이 되돌아간다".
pub fn account_run_dir(email: &str) -> Result<PathBuf, AuthError> {
    let snap = snapshot_of(email)?;
    let (creds, account) = (snap.creds().unwrap_or_default().to_string(), snap.account().cloned().unwrap_or(Value::Null));
    let creds = creds.as_str();

    let dir = account_dir(email);
    std::fs::create_dir_all(&dir).map_err(|e| AuthError::Io(e.to_string()))?;

    let cred_path = dir.join(".credentials.json");
    if creds_expires_at(Some(creds)) >= creds_expires_at(read_file_or_null(&cred_path).as_deref()) {
        crate::write_file_atomic(&cred_path, creds)?;
    }

    let cj_path = dir.join(".claude.json");
    let mut cj = read_json_file(&cj_path).unwrap_or_default();
    cj.insert("oauthAccount".into(), account);
    // JS는 `snap.userID !== undefined` — 키가 있으면 값이 null이어도 넣는다
    if let Some(uid) = snap.user_id() {
        cj.insert("userID".into(), uid.clone());
    }
    if !cj.contains_key("hasCompletedOnboarding") {
        cj.insert("hasCompletedOnboarding".into(), json!(true));
    }
    crate::write_file_atomic(&cj_path, &crate::to_json_2space(&Value::Object(cj)))?;

    link_shared_state(&dir);
    Ok(dir)
}

/// 실행이 끝난 뒤 — 폴더에서 CLI가 리프레시한 토큰을 암호화 백업에 반영.
/// 가드 둘: 내용이 같으면 스킵, **신선도가 전진하지 않으면 스킵**(401 껍데기 방어).
/// 갱신했으면 true.
pub fn sync_account_tokens(email: &str) -> bool {
    let Some(dir_creds) = read_file_or_null(&account_dir(email).join(".credentials.json")) else { return false };
    // ★R3(F1) — 판정과 쓰기를 **같은 증표 안에서**. 밖에서 읽고 안에서 쓰면 그 사이에
    //   다른 프로세스가 넣은 회전 결과를 우리가 덮는다(확인 크리틱 §5의 그 모양).
    // ★R28e(CASX2) — CLI가 폴더에서 리프레시한 토큰을 백업에 옮기는 것도 **회전**이다
    //   (신원이 아니라 자격증명이 갈린다). 선언하지 않으면 장부가 이 쓰기를 재로그인으로
    //   읽고, 그러면 이 계정의 로그아웃을 되살리기가 영영 못 살린다.
    with_intent(ledger::Intent::Refresh(email.to_string()), || {
        update_account_record(email, |m| {
            let Some(raw) = m.get("credEnc").and_then(Value::as_str).and_then(dec_creds) else { return false };
            let snap = Snapshot::parse(&raw);
            if snap.raw.is_empty() {
                return false; // JS: JSON.parse 실패면 return
            }
            if Some(dir_creds.as_str()) == snap.creds() {
                return false; // 변화 없음
            }
            if creds_expires_at(Some(&dir_creds)) <= creds_expires_at(snap.creds()) {
                return false; // 껍데기/후퇴 토큰 가드
            }
            let Some(cred_enc) = enc_creds(&snap.with_creds(&dir_creds)) else { return false };
            m.insert("credEnc".into(), json!(cred_enc)); // 자리 보존 치환
            true
        })
    })
    .unwrap_or(false)
}

/// 계정 폴더 삭제 — **공유 정션을 먼저 끊는다.** 원본이 세션 기록 전체라 이중 방어다.
pub fn delete_account_dir(email: &str) {
    let dir = account_dir(email);
    if !dir.exists() {
        return;
    }
    for name in SHARED_DIRS {
        let _ = junction::unlink(&dir.join(name));
    }
    let _ = std::fs::remove_dir_all(&dir);
}

// ── 토큰 조회 ───────────────────────────────────────────────────────────────

/// 한도 조회용 액세스 토큰 — 폴더(살아 있는 쪽)와 백업 중 신선한 쪽.
/// 만료·부재·복호화 실패는 None(조회만 빠지고, 실행하면 CLI가 리프레시한다).
pub fn account_access_token(email: &str) -> Option<String> {
    let creds = freshest_creds(email)?;
    let o = serde_json::from_str::<Value>(&creds).ok()?;
    let o = o.get("claudeAiOauth")?;
    let token = o.get("accessToken").and_then(Value::as_str).filter(|s| !s.is_empty())?;
    if let Some(exp) = o.get("expiresAt").and_then(Value::as_f64) {
        if exp <= now_ms() {
            return None;
        }
    }
    Some(token.to_string())
}

/// 폴더 vs 백업 중 신선한 크리덴셜 원문. 리프레시(refreshToken 꺼내기)의 재료이기도 하다.
///
/// ★R28d(CASX R2) — **스토어에 행이 없어도 폴더는 본다.** R1까지 이 함수의 첫 줄은
/// `accounts.iter().find(...)?`였다. 그래서 스토어 행이 어떤 이유로든 사라지면 —
/// 잠금을 모르는 이웃이 갈아끼우기 창에서 「계정 0개」로 읽고 통짜로 되쓰거나
/// (`m11r4_store_cas`의 실측), 파일이 손으로 지워지거나 — **폴더에 멀쩡히 앉아 있는
/// 리프레시 토큰에 제품이 도달할 길이 없어졌다**. 그 계정은 그 뒤로 영원히 회전에
/// 실패하고 출구는 재로그인뿐이다(확인 크리틱 R1 §4 실측: HEAD 120주행 중 3주행,
/// 한 판은 배경 회전 1,143판 중 **마지막 880판이 연속 실패**).
///
/// 그런데 모듈 규약 2는 **"살아 있는 토큰의 거처는 계정 폴더고 `credEnc`는 폴더
/// 재생성용 백업"**이다. 완충이 있다는 말은 그 완충에 **손이 닿을 때** 하는 말이다.
///
/// ### 이것이 로그아웃을 되살리지 않는 이유 (판정의 근거)
///
/// **로그아웃은 행과 폴더를 같이 지운다.** 3.0은 [`remove_account`](= `retain` +
/// [`delete_account_dir`])이고 2.6.2도 `removeAccount` → `deleteAccountDir`이다
/// (`src/main/auth.ts:176-183`, 동결 트리). 그러므로
///
/// | 스토어 행 | 계정 폴더 | 무슨 일인가 | 이 함수의 답 |
/// |---|---|---|---|
/// | 있다 | 있다/없다 | 평시 | 신선한 쪽(R1까지와 **동일**) |
/// | **없다** | **없다** | 사용자가 로그아웃했다 | `None` — 되살릴 것이 없다 |
/// | **없다** | **있다** | 로그아웃이 **아니다**(행 유실·오독 쓰기·수동 편집) | 폴더 = 마지막 완충 |
///
/// 세 번째 줄이 이 라운드가 여는 문이다. 그리고 그 문이 "로그아웃 뒤에 폴더가 다시
/// 생기는" 뒷문으로 새지 않도록 [`persist_refreshed_report`]가 **없는 폴더를 새로 파는
/// 것을 미등록 계정에는 거절한다** — 둘은 한 쌍이다.
pub fn freshest_creds(email: &str) -> Option<String> {
    // ★R28d(CASX R3) — 단발이 아니라 [`read_store_settled`]다. 이웃이 쓰는 도중에 읽으면
    // 그 한 판의 목록은 "0개"가 아니라 "모름"인데, 여기서 그걸 0개로 읽으면 **회전 재료를
    // 못 찾는다**(= 그 순간 회전 불가). 폴더 사본이 아직 없는 계정(2.6.2에서 넘어온
    // `credEnc`만 있는 계정 · 로그인 직후)에서는 완충도 없어 그대로 실패한다.
    let f = read_store_settled();
    let backup = f
        .accounts
        .iter()
        .find(|a| email_of(a) == Some(email))
        .and_then(cred_enc_of)
        .and_then(dec_creds)
        .map(|raw| Snapshot::parse(&raw))
        .and_then(|s| s.creds().map(str::to_string));
    let dir_creds = read_file_or_null(&account_dir(email).join(".credentials.json"));
    match (dir_creds, backup) {
        // 둘 다 있으면 신선한 쪽 — R1까지의 판정 그대로다(동점은 백업이 이긴다).
        (Some(d), Some(b)) => Some(if creds_expires_at(Some(&d)) > creds_expires_at(Some(&b)) { d } else { b }),
        // 한쪽만 있으면 **그쪽이 답이다.** 만료 시각 비교로 있는 재료를 버리지 않는다 —
        // 껍데기(accessToken 없음)는 [`creds_expires_at`]이 0.0을 주므로, 옛 코드는
        // `0.0 > 0.0`이 거짓이라 refreshToken을 물고 있는 유일한 사본을 놓쳤다.
        (Some(d), None) => Some(d),
        (None, b) => b,
    }
}

/// 리프레시 토큰(회전 교환의 재료). 없으면 None = 재로그인만이 답이다.
pub fn refresh_token(email: &str) -> Option<String> {
    let creds = freshest_creds(email)?;
    let v = serde_json::from_str::<Value>(&creds).ok()?;
    v.get("claudeAiOauth")?
        .get("refreshToken")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// 리프레시 응답을 크리덴셜에 접어 넣은 새 원문 — 회전된 refresh 토큰을 잃지 않는다.
/// (2.6.2 `refreshAccountToken`의 nextRaw 조립부. 네트워크는 배선 라운드가 친다.)
pub fn apply_refresh(base_creds: &str, access_token: &str, refresh_token: Option<&str>, expires_in_s: f64, now_ms_: f64) -> Option<String> {
    let mut parsed = match serde_json::from_str::<Value>(base_creds) {
        Ok(Value::Object(m)) => m,
        _ => return None,
    };
    let mut oauth = match parsed.get("claudeAiOauth") {
        Some(Value::Object(m)) => m.clone(),
        _ => Map::new(),
    };
    let keep = oauth.get("refreshToken").cloned();
    oauth.insert("accessToken".into(), json!(access_token));
    match refresh_token {
        Some(r) => {
            oauth.insert("refreshToken".into(), json!(r));
        }
        None => {
            if let Some(k) = keep {
                oauth.insert("refreshToken".into(), k);
            }
        }
    }
    // JS는 `Date.now() + n*1000`을 정수로 쓴다 — serde의 f64 표기(`…317.0`)로 새면 안 된다
    oauth.insert("expiresAt".into(), crate::js_number(now_ms_ + expires_in_s * 1000.0));
    parsed.insert("claudeAiOauth".into(), Value::Object(oauth));
    Some(Value::Object(parsed).to_string())
}

/// ★R3(F7) — 되쓰기 **두 반쪽의 결과**. R2는 둘을 순차로 묶어 하나의 `Result`로 접었고,
/// 그래서 "폴더에는 멀쩡히 앉았는데 판정은 재로그인"이라는 오경보가 났다(확인 크리틱 T2).
///
/// 살아 있는 토큰의 거처는 **폴더**고 `credEnc`는 폴더 재생성용 백업이다(모듈 헤더 규약 2).
/// 그래서 한쪽만 남아도 회전 결과를 잃은 것이 아니다 — [`freshest_creds`]가 신선한 쪽을 고른다.
#[derive(Debug)]
pub struct PersistReport {
    /// 계정 폴더 `.credentials.json`(= CLI가 실제로 읽는 파일).
    pub folder: Result<(), AuthError>,
    /// 스토어의 `credEnc` 백업.
    pub backup: Result<(), AuthError>,
    /// 그 계정이 스토어에서 **사라졌다**(다른 창·다른 앱에서 로그아웃). 재로그인 안내가
    /// 아니라 "사용자가 지웠다"가 맞는 상태다.
    pub unregistered: bool,
}

impl PersistReport {
    /// 회전 결과가 **디스크 어딘가에는** 남았나.
    pub fn landed(&self) -> bool {
        self.folder.is_ok() || self.backup.is_ok()
    }
    pub fn both(&self) -> bool {
        self.folder.is_ok() && self.backup.is_ok()
    }
    /// 실패한 반쪽들의 사유(로그용).
    pub fn why(&self) -> String {
        let mut v = vec![];
        if let Err(e) = &self.folder {
            v.push(format!("폴더={e}"));
        }
        if let Err(e) = &self.backup {
            v.push(format!("백업={e}"));
        }
        v.join(" / ")
    }
}

/// ★R3(F3) — **회전된 refresh 토큰만** 접어 넣는다(액세스 토큰이 없는 200 응답).
///
/// 서버가 200을 준 순간 옛 refresh는 죽었다. 응답에 `access_token`이 없어도(필드명이
/// 바뀌었거나 부분 응답이거나) 새 refresh는 **반드시** 적어야 한다 — 안 적으면 그 계정의
/// 출구는 재로그인뿐이다. `expiresAt`은 건드리지 않는다: 액세스 토큰은 여전히 만료
/// 상태이고, 그 사실을 숨기면 다음 호출이 죽은 토큰으로 조회를 나간다.
pub fn apply_rotated_refresh(base_creds: &str, refresh_token: &str) -> Option<String> {
    let mut parsed = match serde_json::from_str::<Value>(base_creds) {
        Ok(Value::Object(m)) => m,
        _ => return None,
    };
    let mut oauth = match parsed.get("claudeAiOauth") {
        Some(Value::Object(m)) => m.clone(),
        _ => Map::new(),
    };
    oauth.insert("refreshToken".into(), json!(refresh_token));
    parsed.insert("claudeAiOauth".into(), Value::Object(oauth));
    Some(Value::Object(parsed).to_string())
}

/// 리프레시 결과를 **폴더와 백업 둘 다**에 즉시 되쓴다 — 어느 쪽에도 죽은 토큰을 남기지
/// 않는다(회전된 refresh 토큰 유실 = 재로그인).
///
/// ★R3 — 두 반쪽을 **독립으로** 시도한다. 앞이 실패했다고 뒤를 건너뛰면 살아남을 수 있던
/// 사본 하나를 스스로 버리는 것이다.
pub fn persist_refreshed_report(email: &str, next_creds: &str) -> PersistReport {
    let folder = (|| -> Result<(), AuthError> {
        let dir = account_dir(email);
        // ★R28d(CASX R2) — **없는 폴더를 새로 파는 것은 등록된 계정에만.**
        //
        // [`freshest_creds`]가 이제 스토어 행이 없어도 폴더를 보므로, 이 자리가 열려 있으면
        // 뒷문이 하나 생긴다: 사용자가 로그아웃한 **직후**([`remove_account`]가 행을 지우고
        // 폴더를 지운 뒤) 비행 중이던 회전이 착지하면 `create_dir_all`이 그 폴더를 다시 파고
        // 살아 있는 refresh 토큰을 평문으로 앉힌다. 그러면 로그아웃한 계정의 재료가
        // **다시 도달 가능**해진다 — 2.6.2 규약("로그아웃 = 해지 → 제거")이 무너지는 자리다.
        //
        // 반대로 **폴더가 이미 있는데 행만 없는** 판은 로그아웃이 아니다(로그아웃은 둘을 같이
        // 지운다). 그건 행 유실이고, 그때 폴더 쓰기를 거절하면 우리가 마지막 완충을 스스로
        // 낡게 만든다. 그래서 조건은 "행이 없다"가 아니라 **"행도 없고 폴더도 없다"**이다.
        if !dir.exists() && !is_registered(email) {
            return Err(AuthError::NotRegistered(email.to_string()));
        }
        std::fs::create_dir_all(&dir).map_err(|e| AuthError::Io(e.to_string()))?;
        crate::write_file_atomic(&dir.join(".credentials.json"), next_creds)
    })();
    // ★R3(F1)③ — 백업은 **자기 항목만** 고친다(잠금 안에서 디스크를 다시 읽는다).
    // ★R28e(CASX2) — 그리고 **회전이라고 선언한다.** 이 한 줄이 없으면 장부는 이 쓰기를
    //   「신원이 새로 섰다」로 읽고(보수적 기본값), 그러면 되살리기가 이 계정의 로그아웃을
    //   영원히 못 살린다. 있으면 R4 §3-1이 닫힌다 — 회전은 로그아웃 취소 사유가 아니다.
    let backup = with_intent(ledger::Intent::Refresh(email.to_string()), || {
        update_account_record(email, |m| {
            let Some(raw) = m.get("credEnc").and_then(Value::as_str).and_then(dec_creds) else {
                return Err(AuthError::Undecryptable(email.to_string()));
            };
            let snap = Snapshot::parse(&raw);
            if snap.raw.is_empty() {
                return Err(AuthError::CorruptSnapshot(email.to_string()));
            }
            let Some(cred_enc) = enc_creds(&snap.with_creds(next_creds)) else {
                return Err(AuthError::Undecryptable(email.to_string()));
            };
            m.insert("credEnc".into(), json!(cred_enc));
            Ok(())
        })
    });
    // ★R28d(CASX R3) — 「사라졌다」의 근거는 **백업 반쪽 하나뿐이다.**
    //
    // R2는 여기에 `|| matches!(folder, Err(NotRegistered))`를 붙였다. 이유("한쪽만 보면
    // 로그아웃된 계정을 저장 실패로 잘못 말한다")는 **검출력이 0**이었다 — 폴더 반쪽이
    // `NotRegistered`를 내는 조건은 `!dir.exists() && !is_registered(email)`이고,
    // `!is_registered`면 백업 반쪽도 같은 값을 낸다(폴더 ⊆ 백업).
    //
    // 대신 **반대 방향 오답**을 열었다. 두 반쪽의 읽기 강도가 달랐기 때문이다:
    //
    // | | 「행이 있나」를 무엇으로 보나 |
    // |---|---|
    // | 위 폴더 가드([`is_registered`]) | ~~자물쇠 밖 · 무재시도 · 무복구 단발 읽기~~ → **[`read_store_settled`]** |
    // | 백업 반쪽([`cas_edit`]) | 자물쇠 안 · [`READ_RETRIES`]회 · **`.bak` 복구**([`vanished_but_we_know_better`]) |
    //
    // 그래서 이 갈래가 **일부러 열어 둔** 그 문(파일이 사라졌고 `.bak`은 안다)에서 둘의 답이
    // 갈렸다. 확인 크리틱 R2 §7의 결정적 재현: `folder:Err(NotRegistered) · backup:Ok`인데
    // 그 뒤 `is_registered=true` · 목록 1개 — **살아 있는 계정을 "사용자가 로그아웃했다"고
    // 말했다.** 그 값은 `net.rs`에서 `NoToken`이 되고, `acct_switch::transient()`가 그것을
    // **계정 탓**으로 분류해 멀쩡한 계정이 자동 전환 후보에서 빠진다.
    //
    // 두 줄로 닫는다: (1) 「사라졌다」의 근거를 **자물쇠 안 반쪽 하나**로 좁히고,
    // (2) 폴더 가드의 읽기를 백업 반쪽과 **같은 강도**로 올린다([`read_store_settled`]).
    // 둘 중 하나만 하면 반대편이 남는다 — 강도만 올리면 「사라졌다」가 여전히 두 근거에
    // 매달리고, 근거만 좁히면 폴더 가드가 단발 읽기로 살아 있는 계정의 폴더를 거절한다.
    //
    // 아래 못이 그 자리를 지킨다: `a_backup_recovered_account_is_never_called_logged_out`.
    let unregistered = matches!(backup, Err(AuthError::NotRegistered(_)));
    PersistReport { folder, backup: backup.and_then(|r| r), unregistered }
}

/// 두 반쪽이 **모두** 성공해야 `Ok`(R2까지의 계약 그대로 — 기존 호출자용).
pub fn persist_refreshed(email: &str, next_creds: &str) -> Result<(), AuthError> {
    let r = persist_refreshed_report(email, next_creds);
    match (r.folder, r.backup) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(e), _) | (_, Err(e)) => Err(e),
    }
}

// ── 편입(로그인 완료·마이그레이션 공용) ────────────────────────────────────

/// 편입 가드. 2.6.2는 경로마다 다른 규칙을 썼다 — 둘 다 그대로 둔다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportGuard {
    /// 로그인 완료 경로 — 방금 그 계정으로 붙은 게 확실하니 무조건 편입(2.6.2 `authLogin`).
    None,
    /// 마이그레이션 경로 — **같은 토큰이 다른 이메일로 이미 저장돼 있으면 거부**한다
    /// (신원·토큰이 어긋난 혼합 상태 = 스냅샷 오염. 2.6.2 `migrateAccounts`의 `collided`).
    RejectTokenCollision,
}

/// config 폴더의 { 토큰 + 신원 }을 스토어에 편입한다(폴더 물질화까지).
pub fn import_account_from_dir(
    dir: &Path,
    email: &str,
    subscription_type: Option<&str>,
    guard: ImportGuard,
) -> Result<(), AuthError> {
    let creds = read_file_or_null(&dir.join(".credentials.json")).ok_or_else(|| AuthError::CorruptSnapshot(email.to_string()))?;
    if guard == ImportGuard::RejectTokenCollision {
        // 자기 제외 소유자 탐색 — "첫 일치"로 잡으면 스토어 순서에 따라 통과/거부가 갈린다
        if let Some(other) = token_collision(&creds, email) {
            return Err(AuthError::TokenCollision(other));
        }
    }
    let cj = read_json_file(&dir.join(".claude.json")).unwrap_or_default();
    // 신원이 없으면(비정상) 이메일로 합성 — account_run_dir가 신원을 요구한다
    let account = cj.get("oauthAccount").cloned().unwrap_or_else(|| json!({ "emailAddress": email }));
    let mut snap = Map::new();
    snap.insert("creds".into(), json!(creds));
    snap.insert("account".into(), account);
    if let Some(uid) = cj.get("userID").filter(|v| v.is_string()) {
        snap.insert("userID".into(), uid.clone());
    }
    let cred_enc = enc_creds(&Value::Object(snap).to_string()).ok_or_else(|| AuthError::Undecryptable(email.to_string()))?;

    let mut rec = Map::new();
    rec.insert("email".into(), json!(email));
    if let Some(s) = subscription_type {
        rec.insert("subscriptionType".into(), json!(s));
    }
    rec.insert("credEnc".into(), json!(cred_enc));
    // ★R3(F1) — 목록이 바뀌는 조작이라 잠금 안에서 읽고 쓴다. 첫 계정이면
    // `write_store_locked`의 폴백이 기본 계정으로 세운다.
    // ★R28e(CASX2) — **로그인이라고 선언한다.** 같은 이메일로 다시 로그인하면 그 행의
    //   신원이 새로 서고, 그때부터 이웃의 **옛** 스냅샷에서 나온 로그아웃은 이 행에
    //   적용되지 않는다(확인 크리틱 R3 §3-1이 잡은 그 사고를 여기서 막는다).
    with_intent(ledger::Intent::Login(email.to_string()), || {
        update_store(|f| {
            f.accounts.retain(|a| email_of(a) != Some(email));
            // `rec`를 **복제**해 넣는다 — CAS가 이 클로저를 다시 부를 수 있어서 통째로
            // 옮기면 두 번째 시도에 빈 레코드가 들어간다(`update_store`의 `FnMut` 계약).
            f.accounts.push(Value::Object(rec.clone()));
        })
    })?;
    // ★R4(G2) — 로그인은 격리를 푸는 **가장 자연스러운 처방**이다. 지문 비교에 맡기지
    // 않고 여기서 직접 지운다(지문을 못 뜬 표식은 비교로는 안 풀린다 — 크리틱 C6).
    crate::health::clear(email);
    let _ = account_run_dir(email); // 실패해도 다음 실행 때 다시 시도된다
    Ok(())
}

// ── 진단(스냅샷 오염) ───────────────────────────────────────────────────────

/// 이 토큰 원문을 물고 있는 계정 **전부**. 두 계정이 같은 값을 물고 있으면 이름표만 다르고
/// 실토큰은 하나 — 1.6.1에서 "전환이 되돌아감"의 진짜 원인이었다.
///
/// **목록이어야 한다.** 예전엔 `find_map`(첫 일치)으로 소유자 하나만 돌려줬는데, 그러면
/// 오염 쌍 중 `accounts.json`에서 **앞에 있는 쪽이 자기 자신을 찾아 통과**한다 — 순서는
/// 사용자가 설정 → Account에서 드래그로 바꾸는 값이라 게이트가 순서에 좌우됐다
/// (M5 R1 크리틱 §4-1). 판정은 [`token_collision`]이 한다.
///
/// 백업(credEnc)뿐 아니라 **계정 폴더의 `.credentials.json`도 본다** — 살아 있는 토큰의
/// 거처가 폴더라, 폴더끼리 같은 토큰이면 백업이 아직 안 갈렸어도 이미 오염이다.
pub fn token_owners(creds: &str) -> Vec<String> {
    let fp = token_fingerprint(creds);
    let same = |s: Option<&str>| s.map(token_fingerprint).as_deref() == Some(fp.as_str());
    read_store_file()
        .accounts
        .iter()
        .filter_map(|a| {
            let email = email_of(a)?;
            let backup = cred_enc_of(a).and_then(dec_creds).map(|raw| Snapshot::parse(&raw)).and_then(|s| s.creds().map(str::to_string));
            let dir = read_file_or_null(&account_dir(email).join(".credentials.json"));
            (same(backup.as_deref()) || same(dir.as_deref())).then(|| email.to_string())
        })
        .collect()
}

/// 이 토큰을 물고 있는 **다른** 계정(자기 자신 제외) — 오염 판정의 단일 소스.
/// `diagnose()`의 `collides_with`와 같은 로직이라 진단과 게이트가 절대 갈리지 않는다.
pub fn token_collision(creds: &str, email: &str) -> Option<String> {
    token_owners(creds).into_iter().find(|o| o != email)
}

/// 계정 1건의 진단 카드 — **토큰 원문은 한 줄도 나가지 않는다**(지문만).
#[derive(Debug, Clone, PartialEq)]
pub struct AccountDiagnosis {
    pub email: String,
    pub subscription_type: Option<String>,
    pub is_default: bool,
    /// credEnc를 풀었는가(= 이 Windows 사용자·이 홈에서 승계 가능한가).
    pub decrypted: bool,
    /// 풀린 스냅샷에 토큰과 신원이 다 있는가.
    pub snapshot_ok: bool,
    pub backup_fp: Option<String>,
    pub backup_expires_at: f64,
    pub dir_present: bool,
    pub dir_fp: Option<String>,
    pub dir_expires_at: f64,
    /// 살아 있는 공유 정션 이름들(비어 있으면 resume 공유가 끊긴 폴더다).
    pub junctions: Vec<String>,
    /// 같은 토큰을 물고 있는 **다른** 계정 = 스냅샷 오염.
    pub collides_with: Option<String>,
    /// 폴더 토큰이 백업보다 신선하다 = 되싱크가 밀려 있다.
    pub resync_pending: bool,
}

pub fn diagnose() -> Vec<AccountDiagnosis> {
    let f = read_store_file();
    let def = default_account_email();
    // 지문 → 이메일들(오염 판정용). 한 번만 푼다.
    let mut by_fp: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    for a in &f.accounts {
        if let (Some(e), Some(raw)) = (email_of(a), cred_enc_of(a).and_then(dec_creds)) {
            if let Some(c) = Snapshot::parse(&raw).creds() {
                by_fp.entry(token_fingerprint(c)).or_default().push(e.to_string());
            }
        }
    }
    f.accounts
        .iter()
        .filter_map(|a| {
            let email = email_of(a)?.to_string();
            let raw = cred_enc_of(a).and_then(dec_creds);
            let snap = raw.as_deref().map(Snapshot::parse);
            let backup_creds = snap.as_ref().and_then(|s| s.creds().map(str::to_string));
            let backup_fp = backup_creds.as_deref().map(token_fingerprint);
            let dir = account_dir(&email);
            let dir_creds = read_file_or_null(&dir.join(".credentials.json"));
            let junctions: Vec<String> = SHARED_DIRS
                .iter()
                .filter(|n| junction::is_link(&dir.join(n)))
                .map(|n| (*n).to_string())
                .collect();
            let collides_with = backup_fp
                .as_ref()
                .and_then(|fp| by_fp.get(fp))
                .and_then(|owners| owners.iter().find(|o| **o != email).cloned());
            let backup_expires_at = creds_expires_at(backup_creds.as_deref());
            let dir_expires_at = creds_expires_at(dir_creds.as_deref());
            Some(AccountDiagnosis {
                is_default: Some(&email) == def.as_ref(),
                subscription_type: subscription_of(a).map(str::to_string),
                decrypted: raw.is_some(),
                snapshot_ok: snap.as_ref().map(|s| s.creds().is_some() && s.account().is_some()).unwrap_or(false),
                backup_fp,
                backup_expires_at,
                dir_present: dir.is_dir(),
                dir_fp: dir_creds.as_deref().map(token_fingerprint),
                dir_expires_at,
                junctions,
                collides_with,
                resync_pending: dir_expires_at > backup_expires_at,
                email,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::temp_home;

    fn creds(access: &str, exp: f64) -> String {
        json!({ "claudeAiOauth": { "accessToken": access, "refreshToken": "r-".to_string() + access, "expiresAt": exp } }).to_string()
    }

    /// 스토어에 계정 하나를 심는다(진짜 safeStorage 스킴으로 — 복호 경로까지 태운다).
    fn seed(email: &str, sub: &str, access: &str, exp: f64) {
        let snap = json!({ "creds": creds(access, exp), "account": { "emailAddress": email }, "userID": "uid-1" });
        let enc = enc_creds(&snap.to_string()).expect("safeStorage 사용 가능해야 한다");
        let f = read_store_file();
        let mut accounts = f.accounts.clone();
        accounts.push(json!({ "email": email, "subscriptionType": sub, "credEnc": enc }));
        write_store_file(&accounts, f.default_email.as_deref()).expect("스토어 저장");
    }

    /// BUG-0013(클로드 축) — 구독 되싱크는 **다를 때만** 쓰고, 미등록 계정은 거절한다.
    #[test]
    fn resync_subscription_rewrites_only_a_changed_plan() {
        let _h = temp_home("claude-resync-sub");
        seed("a@b.c", "pro", "tok-a", 9.0e15);
        assert!(resync_subscription("a@b.c", "max"));
        assert_eq!(list_accounts()[0].subscription_type.as_deref(), Some("max"));
        assert!(!resync_subscription("a@b.c", "max"), "같은 값은 쓰지 않는다");
        assert!(!resync_subscription("ghost@b.c", "max"));
        assert_eq!(list_accounts().len(), 1);
    }

    // ── ★R28 ACCT §4 — 「기본 계정」 파생값 ────────────────────────────────────

    /// 「기본」은 **맨 위**다 — 저장된 `defaultEmail`이 3번째를 가리켜도 파생값은 1번째.
    /// (마이그레이션이 그 둘을 같은 계정으로 만들어 주는 것은 다음 테스트가 잰다.)
    #[test]
    fn the_default_account_is_the_top_of_the_list_not_a_stored_flag() {
        let h = temp_home("acct-default-derived");
        let rec = |e: &str| json!({ "email": e, "subscriptionType": "max", "credEnc": "XX" });
        h.write(
            "accounts.json",
            &json!({ "version": 3, "defaultEmail": "c@x", "accounts": [rec("a@x"), rec("b@x"), rec("c@x")] }).to_string(),
        );
        let list = list_accounts();
        println!("[§4] 목록 = {:?}", list.iter().map(|a| (&a.email, a.is_default)).collect::<Vec<_>>());
        // ★ 마이그레이션이 먼저 돌았을 수도 있고(첫 호출) 아닐 수도 있다(다른 테스트가
        //   프로세스 플래그를 이미 태움). 어느 쪽이든 **파생값의 규칙은 하나**다.
        assert!(list[0].is_default, "맨 위가 기본이 아니다");
        assert!(list[1..].iter().all(|a| !a.is_default), "기본은 하나뿐이어야 한다: {list:?}");
        assert_eq!(default_account_email().as_deref(), Some(list[0].email.as_str()));
        drop(h);
    }

    /// **마이그레이션 왕복** — 옛 `defaultEmail`이 맨 위로 올라오고, 그 뒤로는 no-op다.
    /// 이게 없으면 3번째를 기본으로 쓰던 사용자의 새 채팅이 말없이 1번째로 갈아탄다
    /// (프롬프트 캐시가 식고 남의 한도를 태운다 — §4가 옮기고 나서 폐기하는 이유).
    #[test]
    fn the_old_default_migrates_to_the_top_exactly_once() {
        let h = temp_home("acct-default-migrate");
        let rec = |e: &str| json!({ "email": e, "credEnc": "XX" });
        h.write(
            "accounts.json",
            &json!({ "version": 3, "defaultEmail": "c@x", "accounts": [rec("a@x"), rec("b@x"), rec("c@x")] }).to_string(),
        );
        assert!(migrate_default_to_top(), "옮길 것이 있었는데 안 옮겼다");
        let order: Vec<String> = read_store_quiet().accounts.iter().filter_map(email_of).map(str::to_string).collect();
        println!("[§4] 마이그레이션 후 순서 = {order:?} / 파일 = {}", h.read("accounts.json").unwrap());
        assert_eq!(order, ["c@x", "a@x", "b@x"], "★ 옛 기본이 맨 위로 오지 않으면 기본이 말없이 바뀐다");
        assert!(!migrate_default_to_top(), "두 번째 호출은 아무것도 안 해야 한다(부팅마다 쓰기 금지)");
        // 파일의 `defaultEmail`은 사라지지 않고 **맨 위와 같아진다**(2.6.2 승계용).
        assert_eq!(read_store_quiet().default_email.as_deref(), Some("c@x"));
        drop(h);
    }

    /// 「맨 위로」(= 옛 `set-default-account`)와 **정렬**이 서로를 되돌리지 않는가.
    /// 옛 `defaultEmail`을 그대로 들고 있으면 다음 부팅의 마이그레이션이 사용자의 정렬을
    /// 되감는다 — 그 함정을 여기서 잰다.
    #[test]
    fn moving_to_the_top_and_reordering_survive_a_restart() {
        let h = temp_home("acct-default-reorder");
        let rec = |e: &str| json!({ "email": e, "credEnc": "XX" });
        h.write(
            "accounts.json",
            &json!({ "version": 3, "defaultEmail": "a@x", "accounts": [rec("a@x"), rec("b@x"), rec("c@x")] }).to_string(),
        );
        // ① 「맨 위로」 = 기본 지정과 동치
        let list = set_default_account("b@x");
        assert_eq!(list[0].email, "b@x");
        assert!(list[0].is_default);
        // ② 재부팅(= 마이그레이션 재실행)에도 순서가 그대로여야 한다
        assert!(!migrate_default_to_top(), "★ 옛 defaultEmail이 남아 정렬을 되돌렸다");
        assert_eq!(default_account_email().as_deref(), Some("b@x"));
        // ③ 드래그 정렬도 같은 성질
        reorder_accounts(&["c@x".into(), "a@x".into(), "b@x".into()]);
        assert!(!migrate_default_to_top(), "★ 정렬 뒤에도 되돌림이 없어야 한다");
        let order: Vec<String> = list_accounts().into_iter().map(|a| a.email).collect();
        println!("[§4] 정렬 후 = {order:?}");
        assert_eq!(order, ["c@x", "a@x", "b@x"]);
        assert_eq!(default_account_email().as_deref(), Some("c@x"), "맨 위가 곧 기본");
        drop(h);
    }

    #[test]
    fn store_write_shape_matches_2_6_2() {
        let h = temp_home("store-shape");
        write_store_file(&[], None).expect("스토어 저장");
        // JSON.stringify({version:3, defaultEmail:undefined, accounts:[]}, null, 2)
        assert_eq!(h.read("accounts.json").unwrap(), "{\n  \"version\": 3,\n  \"accounts\": []\n}");
        let a = json!({ "email": "a@b.c", "subscriptionType": "max", "credEnc": "XX" });
        write_store_file(&[a], Some("nope@x.com")).expect("스토어 저장");
        let txt = h.read("accounts.json").unwrap();
        assert!(txt.contains("\"defaultEmail\": \"a@b.c\""), "기본 계정이 무효면 첫 계정으로 물러난다: {txt}");
    }

    #[test]
    fn v2_is_read_and_promoted_to_v3() {
        let h = temp_home("v2-promote");
        h.write(
            "accounts.json",
            &json!({ "version": 2, "accounts": [ { "email": "a@b.c", "subscriptionType": "max", "credEnc": "XX" } ] }).to_string(),
        );
        let f = read_store_file();
        assert_eq!(f.version, 2);
        assert_eq!(f.accounts.len(), 1, "v2도 읽어야 마이그레이션 전에 계정이 사라져 보이지 않는다");
        write_store_file(&f.accounts, f.default_email.as_deref()).expect("스토어 저장");
        let after = read_store_file();
        assert_eq!(after.version, 3);
        assert_eq!(after.default_email.as_deref(), Some("a@b.c"), "v3 승격이 기본 계정을 채운다");
    }

    #[test]
    fn v1_and_garbage_yield_an_empty_store() {
        let _h = temp_home("v1-drop");
        ccg_store::write_home_file("accounts.json", &json!({ "version": 1, "accounts": [ { "email": "x" } ] }).to_string()).unwrap();
        assert!(read_store_file().accounts.is_empty(), "v1은 신원이 없어 무효 — 폐기");
        ccg_store::write_home_file("accounts.json", "{ not json").unwrap();
        assert!(read_store_file().accounts.is_empty());
    }

    #[test]
    fn unknown_keys_survive_a_roundtrip() {
        let h = temp_home("unknown-keys");
        h.write(
            "accounts.json",
            "{\n  \"version\": 3,\n  \"defaultEmail\": \"a@b.c\",\n  \"accounts\": [\n    {\n      \"email\": \"a@b.c\",\n      \"futureField\": 7,\n      \"credEnc\": \"XX\"\n    }\n  ]\n}",
        );
        let before = h.read("accounts.json").unwrap();
        let f = read_store_file();
        write_store_file(&f.accounts, f.default_email.as_deref()).expect("스토어 저장");
        assert_eq!(h.read("accounts.json").unwrap(), before, "모르는 키·키 순서가 그대로 남아야 2.6.2로 되돌릴 수 있다");
    }

    /// ★R3(F1) — **잠금 없는 read-modify-write가 남의 갱신을 되돌리지 않는다.**
    ///
    /// 확인 크리틱 §5의 두 증상을 한 판에 재현한다: ① 남이 회전시킨 `credEnc`를 우리가
    /// 옛 값으로 덮는가(클로버) ② 남이 로그아웃한 계정을 우리가 되살리는가.
    /// "남"은 잠금을 잡는 다른 프로세스일 수도, 안 잡는 2.6.2일 수도 있다 — 여기서는
    /// **디스크를 직접 갈아** 잠금과 무관하게 판정한다.
    #[test]
    fn a_stale_snapshot_neither_clobbers_nor_resurrects() {
        let h = temp_home("merge3");
        seed("a@x.com", "max", "ta", 9e12);
        seed("gone@x.com", "max", "tg", 9e12);
        // 우리 스냅샷(기준점) — 여기까지가 이 스레드가 아는 세상이다.
        let mine = read_store_file();
        assert_eq!(mine.accounts.len(), 2);

        // 그사이 **다른 프로세스**가: a의 토큰을 회전시키고 · gone을 로그아웃하고 · new를 로그인했다.
        let disk = {
            let mut v = mine.accounts.clone();
            v.retain(|x| email_of(x) != Some("gone@x.com"));
            for x in v.iter_mut() {
                if email_of(x) == Some("a@x.com") {
                    x.as_object_mut().unwrap().insert("credEnc".into(), json!("ROTATED-BY-THEM"));
                }
            }
            v.push(json!({ "email": "new@x.com", "credEnc": "THEIRS" }));
            v
        };
        h.write(
            "accounts.json",
            &crate::to_json_2space(&json!({ "version": 3, "defaultEmail": "a@x.com", "accounts": disk })),
        );

        // 우리는 낡은 스냅샷으로 "b를 추가"만 한다(a·gone은 안 건드렸다).
        let mut next = mine.accounts.clone();
        next.push(json!({ "email": "b@x.com", "credEnc": "MINE" }));
        write_store_file(&next, mine.default_email.as_deref()).expect("스토어 저장");

        let after = read_store_file();
        let emails: Vec<&str> = after.accounts.iter().filter_map(email_of).collect();
        println!("[R3/F1] 병합 결과 = {emails:?}");
        assert!(!emails.contains(&"gone@x.com"), "★ 로그아웃한 계정이 되살아났다");
        assert!(emails.contains(&"b@x.com"), "우리 추가는 살아야 한다");
        assert!(emails.contains(&"new@x.com"), "★ 남이 방금 로그인한 계정을 우리가 지웠다");
        assert_eq!(
            after.accounts.iter().find(|x| email_of(x) == Some("a@x.com")).and_then(cred_enc_of),
            Some("ROTATED-BY-THEM"),
            "★ 남의 회전 결과를 우리 옛 값으로 덮었다(백업에 죽은 토큰만 남는다)"
        );

        // 반대로 **우리가 고친 값**은 디스크가 이기지 않는다(의도는 존중한다).
        let base = read_store_file();
        let mut ours = base.accounts.clone();
        for x in ours.iter_mut() {
            if email_of(x) == Some("a@x.com") {
                x.as_object_mut().unwrap().insert("credEnc".into(), json!("ROTATED-BY-US"));
            }
        }
        write_store_file(&ours, base.default_email.as_deref()).expect("스토어 저장");
        assert_eq!(
            read_store_file().accounts.iter().find(|x| email_of(x) == Some("a@x.com")).and_then(cred_enc_of),
            Some("ROTATED-BY-US")
        );
    }

    #[test]
    fn reorder_keeps_accounts_that_were_left_out() {
        let _h = temp_home("reorder");
        seed("a@x.com", "max", "ta", 9e12);
        seed("b@x.com", "max", "tb", 9e12);
        seed("c@x.com", "max", "tc", 9e12);
        let out = reorder_accounts(&["c@x.com".into(), "a@x.com".into()]);
        let emails: Vec<&str> = out.iter().map(|a| a.email.as_str()).collect();
        assert_eq!(emails, ["c@x.com", "a@x.com", "b@x.com"]);
    }

    /// **드래그 한 번에 credEnc가 사라지면 안 된다**(M5 R1 크리틱 §4-2).
    /// 스토어에 같은 이메일 레코드가 둘일 때, 이메일로 걸러 넣으면 두 번째 레코드의
    /// 암호화 토큰 백업이 통째로 날아간다. 2.6.2는 참조 비교라 둘 다 남긴다 — 같은 결과를
    /// 인덱스로 낸다(순서까지 2.6.2와 같다).
    #[test]
    fn reorder_never_drops_a_duplicate_email_record() {
        let _h = temp_home("reorder-dup");
        seed("dup@x.com", "max", "TOK-1", 9e12);
        seed("dup@x.com", "max", "TOK-2", 9e12);
        seed("ok@x.com", "max", "TOK-3", 9e12);
        assert_eq!(read_store_file().accounts.len(), 3);

        reorder_accounts(&["ok@x.com".into(), "dup@x.com".into()]);
        let after = read_store_file().accounts;
        assert_eq!(after.len(), 3, "레코드가 사라졌다 — 토큰 백업 유실");
        // 2.6.2: Map은 마지막 dup(TOK-2)을 골라 앞에 놓고, 남은 TOK-1은 참조 비교로 뒤에 붙는다
        let tok = |a: &Value| {
            let raw = dec_creds(cred_enc_of(a).unwrap()).unwrap();
            let c = Snapshot::parse(&raw).creds().unwrap().to_string();
            if c.contains("TOK-1") { "TOK-1" } else if c.contains("TOK-2") { "TOK-2" } else { "TOK-3" }
        };
        let got: Vec<(&str, &str)> = after.iter().map(|a| (email_of(a).unwrap(), tok(a))).collect();
        assert_eq!(got, [("ok@x.com", "TOK-3"), ("dup@x.com", "TOK-2"), ("dup@x.com", "TOK-1")]);

        // 입력에 같은 이메일이 두 번 와도 레코드를 **복제하지는** 않는다(2.6.2와의 의도적 차이)
        reorder_accounts(&["dup@x.com".into(), "dup@x.com".into()]);
        assert_eq!(read_store_file().accounts.len(), 3, "복제도 유실만큼 나쁘다");
    }

    /// `version: 3.0`(부동소수 표기) 하나로 스토어가 통째로 사라지면 안 된다 — JS는
    /// `3.0 === 3`이다(M5 R1 크리틱 §4-4). 문자열 `"3"`은 양쪽 다 폐기(JS도 `'3' !== 3`).
    #[test]
    fn version_is_compared_with_js_semantics() {
        let h = temp_home("version-tolerance");
        let rec = r#"{"email":"a@x.com","credEnc":"XX"}"#;
        for (v, want) in [("3", 1), ("3.0", 1), ("2", 1), ("2.0", 1), ("\"3\"", 0), ("4", 0), ("1", 0), ("3.5", 0)] {
            h.write("accounts.json", &format!("{{\"version\": {v}, \"accounts\": [{rec}]}}"));
            assert_eq!(read_store_file().accounts.len(), want, "version: {v}");
        }
        // 승격 경로도 그대로 — 3.0으로 읽어도 v3로 되쓴다
        h.write("accounts.json", &format!("{{\"version\": 2.0, \"accounts\": [{rec}]}}"));
        let f = read_store_file();
        assert_eq!(f.version, 2);
        write_store_file(&f.accounts, f.default_email.as_deref()).expect("스토어 저장");
        assert_eq!(read_store_file().version, 3);
    }

    /// 소유자 탐색이 **목록**이라 순서를 안 탄다(오염가드의 재료 — verify.rs가 판정한다).
    #[test]
    fn token_owners_lists_everyone_regardless_of_order() {
        let _h = temp_home("token-owners");
        seed("a@x.com", "max", "shared", 9e12);
        seed("b@x.com", "max", "shared", 9e12);
        seed("c@x.com", "max", "own", 9e12);
        let shared = creds("shared", 9e12);
        assert_eq!(token_owners(&shared), ["a@x.com", "b@x.com"]);
        assert_eq!(token_collision(&shared, "a@x.com").as_deref(), Some("b@x.com"));
        assert_eq!(token_collision(&shared, "b@x.com").as_deref(), Some("a@x.com"), "뒤에 있다고 통과하면 안 된다");
        reorder_accounts(&["b@x.com".into(), "a@x.com".into()]);
        assert_eq!(token_collision(&shared, "a@x.com").as_deref(), Some("b@x.com"));
        assert_eq!(token_collision(&shared, "b@x.com").as_deref(), Some("a@x.com"), "재정렬해도 같은 답이어야 한다");
        assert_eq!(token_collision(&creds("own", 9e12), "c@x.com"), None);
        assert_eq!(token_owners(&creds("nobody", 9e12)), Vec::<String>::new());
    }

    /// 편입 가드도 같은 판정을 쓴다 — 스토어 순서가 바뀌어도 오염 토큰은 못 들어온다.
    #[test]
    fn guarded_import_rejects_regardless_of_order() {
        let h = temp_home("import-order");
        seed("a@x.com", "max", "same", 9e12);
        seed("b@x.com", "max", "same", 9e12);
        let g = h.path("global");
        std::fs::create_dir_all(&g).unwrap();
        std::fs::write(g.join(".credentials.json"), creds("same", 9e12)).unwrap();
        for order in [["a@x.com", "b@x.com"], ["b@x.com", "a@x.com"]] {
            reorder_accounts(&order.iter().map(|s| s.to_string()).collect::<Vec<_>>());
            // 오염 쌍 중 한쪽 이름으로 다시 편입하려 해도 **다른 쪽**이 걸린다
            for e in order {
                let other = if e == "a@x.com" { "b@x.com" } else { "a@x.com" };
                assert_eq!(
                    import_account_from_dir(&g, e, None, ImportGuard::RejectTokenCollision).unwrap_err(),
                    AuthError::TokenCollision(other.into()),
                    "배치 {order:?} / {e}"
                );
            }
            assert_eq!(read_store_file().accounts.len(), 2);
        }
    }

    #[test]
    fn materialized_config_dir_has_tokens_identity_and_junctions() {
        let h = temp_home("materialize");
        seed("a@x.com", "max", "tok-a", 9e12);
        let dir = account_run_dir("a@x.com").expect("물질화");
        assert_eq!(dir, h.path("accounts/a_x.com-z9z23w"));

        // 토큰
        assert_eq!(std::fs::read_to_string(dir.join(".credentials.json")).unwrap(), creds("tok-a", 9e12));
        // 신원 — 이게 없으면 CLI가 토큰 주인으로 자가 교정한다
        let cj = read_json_file(&dir.join(".claude.json")).unwrap();
        assert_eq!(cj["oauthAccount"]["emailAddress"], json!("a@x.com"));
        assert_eq!(cj["userID"], json!("uid-1"));
        assert_eq!(cj["hasCompletedOnboarding"], json!(true));
        // 공유 — **정션이어야** resume이 산다
        for name in SHARED_DIRS {
            let p = dir.join(name);
            assert!(junction::is_link(&p), "{name}이 정션이 아니면 세션 기록이 계정별로 갈라진다");
            let t = junction::target_of(&p).unwrap();
            assert!(t.to_string_lossy().ends_with(&format!("shared\\{name}")), "{name} → {t:?}");
        }
        // 링크 너머 쓰기가 공유 원본에 보인다(= 계정을 바꿔도 같은 세션을 resume한다)
        std::fs::write(dir.join("projects").join("p.jsonl"), "{}").unwrap();
        assert!(h.path("shared/projects/p.jsonl").is_file());
    }

    #[test]
    fn materialization_keeps_the_fresher_token_and_never_regresses() {
        let _h = temp_home("freshness");
        seed("a@x.com", "max", "old", 1000.0);
        let dir = account_run_dir("a@x.com").unwrap();
        // CLI가 폴더에서 리프레시한 상황
        std::fs::write(dir.join(".credentials.json"), creds("new", 2000.0)).unwrap();
        account_run_dir("a@x.com").unwrap();
        assert!(
            std::fs::read_to_string(dir.join(".credentials.json")).unwrap().contains("\"new\""),
            "백업이 더 낡았는데 덮으면 방금 리프레시한 토큰이 죽는다"
        );
        // 되싱크 — 폴더가 신선하니 백업이 따라온다
        assert!(sync_account_tokens("a@x.com"));
        assert_eq!(freshest_creds("a@x.com").as_deref(), Some(creds("new", 2000.0).as_str()));
    }

    #[test]
    fn resync_refuses_shells_and_backwards_tokens() {
        let _h = temp_home("resync-guard");
        seed("a@x.com", "max", "good", 5000.0);
        let dir = account_run_dir("a@x.com").unwrap();
        // 401을 맞고 껍데기로 덮인 크리덴셜(accessToken 없음) — 백업을 오염시키면 안 된다
        std::fs::write(dir.join(".credentials.json"), r#"{"claudeAiOauth":{}}"#).unwrap();
        assert!(!sync_account_tokens("a@x.com"), "껍데기 토큰이 백업을 덮으면 계정이 죽는다");
        // 후퇴한 만료시각도 거부
        std::fs::write(dir.join(".credentials.json"), creds("older", 4000.0)).unwrap();
        assert!(!sync_account_tokens("a@x.com"));
        assert!(freshest_creds("a@x.com").unwrap().contains("\"good\""));
    }

    #[test]
    fn delete_unlinks_junctions_before_removing_the_folder() {
        let h = temp_home("delete");
        seed("a@x.com", "max", "tok", 9e12);
        let dir = account_run_dir("a@x.com").unwrap();
        std::fs::write(dir.join("projects").join("keep.jsonl"), "keep").unwrap();
        remove_account("a@x.com");
        assert!(!dir.exists());
        assert!(h.path("shared/projects/keep.jsonl").is_file(), "공유 원본(세션 기록 전체)이 정션을 타고 지워지면 안 된다");
    }

    #[test]
    fn token_collision_is_detected_and_blocks_a_guarded_import() {
        let h = temp_home("collision");
        seed("a@x.com", "max", "same", 9e12);
        // 겉보기 이메일만 다른 오염 항목
        let snap = json!({ "creds": creds("same", 9e12), "account": { "emailAddress": "b@x.com" } });
        let f = read_store_file();
        let mut accounts = f.accounts.clone();
        accounts.push(json!({ "email": "b@x.com", "credEnc": enc_creds(&snap.to_string()).unwrap() }));
        write_store_file(&accounts, f.default_email.as_deref()).expect("스토어 저장");

        let d = diagnose();
        assert_eq!(d[0].collides_with.as_deref(), Some("b@x.com"));
        assert_eq!(d[1].collides_with.as_deref(), Some("a@x.com"));
        assert_eq!(d[0].backup_fp, d[1].backup_fp, "같은 토큰이면 지문도 같다(진단 키)");

        // 마이그레이션 가드: 같은 토큰의 전역 로그인은 다른 이메일로 편입하지 않는다
        let g = h.path("global");
        std::fs::create_dir_all(&g).unwrap();
        std::fs::write(g.join(".credentials.json"), creds("same", 9e12)).unwrap();
        let err = import_account_from_dir(&g, "c@x.com", None, ImportGuard::RejectTokenCollision).unwrap_err();
        assert_eq!(err, AuthError::TokenCollision("a@x.com".into()));
        assert_eq!(read_store_file().accounts.len(), 2, "오염 항목이 늘어나면 안 된다");
    }

    #[test]
    fn import_registers_materializes_and_defaults() {
        let h = temp_home("import");
        let g = h.path("login");
        std::fs::create_dir_all(&g).unwrap();
        std::fs::write(g.join(".credentials.json"), creds("tok", 9e12)).unwrap();
        std::fs::write(
            g.join(".claude.json"),
            json!({ "oauthAccount": { "emailAddress": "a@x.com", "accountUuid": "u" }, "userID": "uid" }).to_string(),
        )
        .unwrap();
        import_account_from_dir(&g, "a@x.com", Some("max"), ImportGuard::None).unwrap();

        let list = list_accounts();
        assert_eq!(list.len(), 1);
        assert!(list[0].is_default, "첫 계정은 자동으로 기본 계정");
        assert_eq!(list[0].subscription_type.as_deref(), Some("max"));
        assert!(h.path("accounts/a_x.com-z9z23w/.credentials.json").is_file(), "편입이 곧 물질화");
        // 2.6.2 레코드 키 순서(email, subscriptionType, credEnc)
        let raw = h.read("accounts.json").unwrap();
        let i_email = raw.find("\"email\"").unwrap();
        let i_sub = raw.find("\"subscriptionType\"").unwrap();
        let i_enc = raw.find("\"credEnc\"").unwrap();
        assert!(i_email < i_sub && i_sub < i_enc, "키 순서가 2.6.2와 달라지면 바이트 호환이 깨진다");
    }

    #[test]
    fn access_token_is_none_once_it_expires() {
        let _h = temp_home("expiry");
        seed("a@x.com", "max", "tok", 1000.0); // 1970년 — 만료
        assert_eq!(account_access_token("a@x.com"), None);
        assert_eq!(refresh_token("a@x.com").as_deref(), Some("r-tok"), "만료돼도 리프레시 재료는 남는다");
    }

    #[test]
    fn apply_refresh_keeps_the_rotated_token_and_other_fields() {
        let base = json!({ "claudeAiOauth": { "accessToken": "old", "refreshToken": "r-old", "expiresAt": 1.0, "scopes": ["a"], "subscriptionType": "max" } })
            .to_string();
        let next = apply_refresh(&base, "new", Some("r-new"), 3600.0, 1_000_000.0).unwrap();
        let v: Value = serde_json::from_str(&next).unwrap();
        assert_eq!(v["claudeAiOauth"]["accessToken"], json!("new"));
        assert_eq!(v["claudeAiOauth"]["refreshToken"], json!("r-new"));
        assert_eq!(v["claudeAiOauth"]["expiresAt"], json!(4_600_000i64));
        assert!(next.contains("\"expiresAt\":4600000"), "epoch ms는 정수로 써야 한다(serde의 `.0`이 새면 안 된다): {next}");
        assert_eq!(v["claudeAiOauth"]["scopes"], json!(["a"]), "모르는 필드는 보존");
        // 회전이 없으면 기존 refresh 토큰 유지
        let same = apply_refresh(&base, "new", None, 60.0, 0.0).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&same).unwrap()["claudeAiOauth"]["refreshToken"], json!("r-old"));
    }

    #[test]
    fn errors_name_the_exact_failure() {
        let h = temp_home("errors");
        assert_eq!(account_run_dir("nobody@x.com"), Err(AuthError::NotRegistered("nobody@x.com".into())));
        // 다른 머신에서 복사된 홈 — credEnc가 안 풀린다
        write_store_file(&[json!({ "email": "a@x.com", "credEnc": "bm90LWEtcmVhbC1ibG9i" })], None).expect("스토어 저장");
        assert!(matches!(account_run_dir("a@x.com"), Err(AuthError::Undecryptable(_))));
        // 풀렸는데 알맹이가 비었다
        let enc = enc_creds(&json!({ "creds": "", "account": null }).to_string()).unwrap();
        write_store_file(&[json!({ "email": "a@x.com", "credEnc": enc })], None).expect("스토어 저장");
        assert!(matches!(account_run_dir("a@x.com"), Err(AuthError::CorruptSnapshot(_))));
        drop(h);
    }
}
