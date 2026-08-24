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

/// 이 이메일이 스토어에 있나(조회 전용).
pub fn is_registered(email: &str) -> bool {
    read_store_quiet().accounts.iter().any(|a| email_of(a) == Some(email))
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
fn recover_store() -> Option<StoreFile> {
    let b = read_file_or_null(&store_backup_path()).as_deref().and_then(parse_store)?;
    if b.origin != StoreOrigin::Parsed || b.accounts.is_empty() {
        return None;
    }
    eprintln!("[auth] ★ {STORE_FILE}이 깨졌다 — 마지막 성공본({STORE_BACKUP_FILE}, 계정 {}개)으로 되살린다", b.accounts.len());
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
    let (merged, def) = merge3(base.as_ref(), accounts, default_email, &disk);
    let r = write_store_locked(&merged, def.as_deref());
    if r.is_ok() {
        // 방금 쓴 것이 다음 쓰기의 기준점이다(같은 스레드가 연달아 저장하는 경로).
        set_base(&merged, def.as_deref());
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
    let mut retries = 0usize;
    let mut torn = 0usize;
    for _ in 0..CAS_TRIES {
        // ── ① 준비 ─────────────────────────────────────────────────────────
        let _g = store_lock();
        let (before, mut cur) = read_store_raw();
        if !cur.origin.is_known() {
            // 이웃이 통짜 쓰기를 하는 **도중**에 읽었을 수 있다(2.6.2의 writeFileSync는
            // 원자적이 아니다). "계정이 없다"가 아니라 "지금은 모른다"이므로 다시 읽는다.
            torn += 1;
            if torn < 4 {
                retries += 1;
                std::thread::sleep(std::time::Duration::from_millis(2));
                continue;
            }
            // 네 번을 다시 읽어도 깨져 있다 = 지나가는 반쪽이 아니라 **정말 깨진 파일**이다.
            let Some(rec) = recover_store() else {
                return Err(AuthError::Io(format!("{STORE_FILE}: 파일이 손상됐고 복구본도 없다")));
            };
            cur = rec;
        }
        let Some(i) = cur.accounts.iter().position(|a| email_of(a) == Some(email)) else {
            return Err(AuthError::NotRegistered(email.to_string()));
        };
        let mut accounts = cur.accounts.clone();
        let mut m = accounts[i].as_object().cloned().unwrap_or_default();
        let out = f(&mut m);
        accounts[i] = Value::Object(m);
        // 내용이 같으면 저장을 건너뛴다(2.6.2와 같은 의미론) — 안 바뀐 저장은 mtime만 흔들고
        // 남의 원자 저장과 경쟁할 이유가 없다.
        if accounts == cur.accounts {
            return Ok(out);
        }
        let mine = accounts[i].clone();
        let base_record = cur.accounts[i].clone();
        let mut body = render_store(&accounts, cur.default_email.as_deref());

        // ── ② 갈아끼우기 + 파묻힌 쓰기 되살리기 ────────────────────────────
        let mut expect = before;
        let mut def = cur.default_email.clone();
        let mut stale = false;
        for _ in 0..BURY_TRIES {
            match commit_locked(&body, expect.as_deref())? {
                Commit::Stale => {
                    // 이웃이 그사이에 썼다. 우리 스냅샷은 이미 낡았다 — 여기서 쓰면 그
                    // 쓰기가 사라진다(= 로그아웃 취소). 클로저부터 다시 돈다.
                    retries += 1;
                    stale = true;
                    break;
                }
                Commit::Clean => {
                    set_base(&accounts, def.as_deref());
                    keep_backup(&body);
                    if retries > 0 {
                        eprintln!("[auth] {STORE_FILE} 저장 — 이웃과 {retries}번 부딪혀 다시 읽고 썼다(CAS)");
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
                    let Some(t) = parse_store(&theirs).filter(|t| t.origin.is_known()) else {
                        eprintln!("[auth] ★ {STORE_FILE}: 이웃의 쓰기를 묻었는데 원문을 못 읽는다 — 우리 것으로 둔다");
                        break;
                    };
                    let keep: std::collections::BTreeSet<&str> = t.accounts.iter().filter_map(email_of).collect();
                    let next: Vec<Value> =
                        accounts.iter().filter(|a| email_of(a).is_none_or(|e| keep.contains(e))).cloned().collect();
                    if next.len() == accounts.len() {
                        break; // 그들이 지운 계정이 없다 = 되살릴 것도 없다
                    }
                    eprintln!(
                        "[auth] ★ {STORE_FILE}: 이웃의 로그아웃을 묻었다(계정 {}개 → {}개) — 즉시 되살린다",
                        accounts.len(),
                        next.len()
                    );
                    accounts = next;
                    expect = Some(body);
                    body = render_store(&accounts, def.as_deref());
                }
            }
        }
        if !stale {
            // 되살리기를 BURY_TRIES번 하고도 못 끝냈다 = 이웃이 쉬지 않고 쓰는 판이다.
            // 마지막 커밋은 이미 디스크에 있다(유실 아님) — 다음 회전이 이어 받는다.
            eprintln!("[auth] {STORE_FILE}: 이웃과 계속 겹친다 — 이번 되살리기는 여기서 접는다");
            keep_backup(&body);
            return Ok(out);
        }
    }
    Err(AuthError::Io(format!("{STORE_FILE}: 다른 프로세스와 {CAS_TRIES}번 부딪혀 저장을 접었다")))
}

/// [`commit_locked`]의 착지 세 갈래.
enum Commit {
    /// 커밋했고, 우리 `rename`이 묻은 쓰기는 없다.
    Clean,
    /// 커밋했는데 `[확인, rename]` 창에 이웃이 통짜로 썼다 — 파낸 그 원문.
    Buried(String),
    /// 확인에서 갈렸다 — **커밋 안 했다**.
    Stale,
}

/// CAS 한 번. **호출자가 [`store_lock`]을 쥐고 있어야 한다**(안에서 또 잡으면 교착이다).
///
/// 잠금을 모르는 이웃에게 열려 있는 창은 여기 두 줄뿐이다 —
/// **증인 읽기(실측 17µs) → `rename`(실측 184µs)**. R3의 8~14ms에서 40~70배 좁다.
/// 커밋 뒤 옛 inode를 한 번 더 읽어 그 창에 떨어진 쓰기가 있었는지 본다(그 읽기는 창 밖이다).
fn commit_locked(body: &str, expect: Option<&str>) -> Result<Commit, AuthError> {
    // 직렬화 + 임시 파일 쓰기(실측 179µs)는 창 **밖**이다 — rename만 창 안이다.
    let staged = ccg_store::stage_home_file(STORE_FILE, body).map_err(|e| AuthError::Io(format!("{STORE_FILE}: {e}")))?;
    let mut w = ccg_store::witness(&store_path());
    let now = w.as_mut().and_then(ccg_store::Witness::read);
    if now.as_deref() != expect {
        return Ok(Commit::Stale); // 커밋 안 한 임시 파일은 `Staged`가 치운다
    }
    staged.commit().map_err(|e| AuthError::Io(format!("{STORE_FILE}: {e}")))?;
    let Some(w) = w.as_mut() else { return Ok(Commit::Clean) };
    // 옛 inode를 다시 본다. 이웃이 쓰는 **도중**이면 반쪽이 읽히므로 잠깐 기다렸다 다시
    // 본다 — 그들은 자기 파일이 이미 갈렸다는 걸 모르고 끝까지 쓴다.
    for k in 0..4 {
        match w.read() {
            Some(a) if Some(a.as_str()) == expect => return Ok(Commit::Clean),
            Some(a) if parse_store(&a).is_some_and(|p| p.origin.is_known()) => return Ok(Commit::Buried(a)),
            _ => {}
        }
        if k < 3 {
            std::thread::sleep(std::time::Duration::from_micros(300));
        }
    }
    Ok(Commit::Clean)
}

/// 잠금 안에서 스토어 전체를 고친다(목록이 바뀌는 사용자 조작 — 로그인·로그아웃·정렬).
/// 클로저는 **증표 안에서 뜬** 스냅샷을 받으므로 병합이 필요 없다.
///
/// ★R4(G3/C7) — 다만 "증표 안에서 떴다"가 "읽었다"를 뜻하지는 않는다. 파일이 깨져 있으면
/// R3의 [`read_store_file`]은 **빈 목록**을 줬고, 그 위의 로그인 한 번이 나머지 계정을
/// 전부 지웠다(크리틱 C7). 이제 목록을 모르는 판에서는 [`STORE_BACKUP_FILE`]로 복구하고,
/// 그것마저 없으면 **쓰지 않고 실패로 착지한다** — 모르는 위에 덮어쓰는 것보다 낫다.
pub fn update_store<T>(f: impl FnOnce(&mut StoreFile) -> T) -> Result<T, AuthError> {
    let _g = store_lock();
    let mut cur = read_store_file();
    if !cur.origin.is_known() {
        let Some(rec) = recover_store() else {
            return Err(AuthError::Io(format!("{STORE_FILE}: 파일이 손상됐고 복구본도 없다 — 계정 목록을 덮어쓰지 않는다")));
        };
        cur = rec;
    }
    // 복구본으로 읽었으면 **무조건 쓴다** — 그게 깨진 본문을 고치는 유일한 순간이다.
    let repair = cur.origin == StoreOrigin::Recovered;
    let before = (cur.accounts.clone(), cur.default_email.clone(), cur.version);
    let out = f(&mut cur);
    if repair || (&cur.accounts, &cur.default_email) != (&before.0, &before.1) || before.2 != STORE_VERSION {
        write_store_locked(&cur.accounts, cur.default_email.as_deref())?;
        set_base(&cur.accounts, cur.default_email.as_deref());
    }
    Ok(out)
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

/// 미지정 채팅이 쓸 계정 — `defaultEmail`, 무효/부재면 첫 계정, 0개면 None.
pub fn default_account_email() -> Option<String> {
    let f = read_store_quiet();
    if let Some(d) = &f.default_email {
        if f.accounts.iter().any(|a| email_of(a) == Some(d.as_str())) {
            return Some(d.clone());
        }
    }
    f.accounts.first().and_then(email_of).map(str::to_string)
}

/// 등록 계정 목록 — 스토어만 본다(CLI 스폰 없음).
pub fn list_accounts() -> Vec<AccountInfo> {
    let def = default_account_email();
    read_store_quiet()
        .accounts
        .iter()
        .filter_map(|a| {
            let email = email_of(a)?.to_string();
            Some(AccountInfo {
                is_default: Some(&email) == def.as_ref(),
                subscription_type: subscription_of(a).map(str::to_string),
                email,
            })
        })
        .collect()
}

pub fn set_default_account(email: &str) -> Vec<AccountInfo> {
    let _ = update_store(|f| {
        if f.accounts.iter().any(|a| email_of(a) == Some(email)) {
            f.default_email = Some(email.to_string());
        }
    });
    list_accounts()
}

/// 목록에서 제거 + 물질화된 폴더 정리. (서버 토큰 해지는 CLI 경로 — `verify::logout_command`)
pub fn remove_account(email: &str) -> Vec<AccountInfo> {
    let _ = update_store(|f| f.accounts.retain(|a| email_of(a) != Some(email)));
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
pub fn snapshot_of(email: &str) -> Result<Snapshot, AuthError> {
    let f = read_store_quiet();
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
pub fn freshest_creds(email: &str) -> Option<String> {
    let f = read_store_quiet();
    let target = f.accounts.iter().find(|a| email_of(a) == Some(email))?;
    let backup = cred_enc_of(target).and_then(dec_creds).map(|raw| Snapshot::parse(&raw)).and_then(|s| s.creds().map(str::to_string));
    let dir_creds = read_file_or_null(&account_dir(email).join(".credentials.json"));
    if creds_expires_at(dir_creds.as_deref()) > creds_expires_at(backup.as_deref()) {
        dir_creds
    } else {
        backup
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
        std::fs::create_dir_all(&dir).map_err(|e| AuthError::Io(e.to_string()))?;
        crate::write_file_atomic(&dir.join(".credentials.json"), next_creds)
    })();
    // ★R3(F1)③ — 백업은 **자기 항목만** 고친다(잠금 안에서 디스크를 다시 읽는다).
    let backup = update_account_record(email, |m| {
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
    });
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
    update_store(|f| {
        f.accounts.retain(|a| email_of(a) != Some(email));
        f.accounts.push(Value::Object(rec));
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
