//! OpenAI(Codex) 계정 — `~/.agentcodegui/codex-accounts.json`(v1) + 계정별 격리 `CODEX_HOME`.
//! 원본: `src/main/codex/auth.ts`. Anthropic 쪽과 **같은 문법**이고 다른 점만 셋이다:
//!
//! - 토큰 파일이 `auth.json` 한 장이고, 신원(이메일·플랜)은 그 안 `tokens.id_token`(JWT)에서
//!   꺼낸다(별도 신원 파일 없음).
//! - 신선도 키가 `expiresAt`(숫자)이 아니라 `last_refresh`(ISO 문자열)다.
//! - 정션으로 공유하는 건 `sessions`·`skills`·`plugins`·`cache`뿐이다. `history.jsonl`·sqlite
//!   같은 루트 **파일** 상태는 정션이 안 되고, 계정 스코프 상태라 갈라지는 게 오히려 맞다.
//!
//! 플랜 표기는 스토어 값이 최우선이다 — `id_token`은 리프레시 전까지 옛 플랜을 물고 있고
//! (실측: 구독 직후에도 free), `account/rateLimits/read`의 `planType`이 진실을 되싱크한다.

use crate::{account_slug, junction, read_file_or_null, AuthError};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

pub const STORE_FILE: &str = "codex-accounts.json";
pub const STORE_VERSION: u64 = 1;
pub const SHARED_DIRS: &[&str] = &["sessions", "skills", "plugins", "cache"];
pub const COPIED_FILES: &[&str] = &["config.toml"];

pub fn codex_root() -> PathBuf {
    crate::app_home().join("codex")
}
pub fn accounts_dir() -> PathBuf {
    codex_root().join("accounts")
}
pub fn shared_root() -> PathBuf {
    codex_root().join("shared")
}
pub fn login_dir() -> PathBuf {
    codex_root().join("login")
}
pub fn account_dir(email: &str) -> PathBuf {
    accounts_dir().join(account_slug(email))
}
fn store_path() -> PathBuf {
    crate::app_home().join(STORE_FILE)
}

// ── 스토어 파일 ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default)]
pub struct StoreFile {
    pub version: u64,
    pub default_email: Option<String>,
    pub accounts: Vec<Value>,
}

pub fn email_of(a: &Value) -> Option<&str> {
    a.get("email").and_then(Value::as_str)
}
pub fn auth_enc_of(a: &Value) -> Option<&str> {
    a.get("authEnc").and_then(Value::as_str)
}
pub fn plan_of(a: &Value) -> Option<&str> {
    a.get("plan").and_then(Value::as_str)
}

/// v1만 읽는다(2.6.2와 동일 — 다른 버전은 빈 스토어).
/// 버전 비교는 `claude::read_store_file`과 같이 **JS 의미론**이다(`1.0 === 1`) — 부동소수
/// 표기 하나로 계정이 통째로 사라지면 안 된다.
pub fn read_store_file() -> StoreFile {
    let Some(m) = crate::read_json_file(&store_path()) else {
        return StoreFile { version: STORE_VERSION, ..Default::default() };
    };
    if m.get("version").and_then(Value::as_f64) != Some(STORE_VERSION as f64) {
        return StoreFile { version: STORE_VERSION, ..Default::default() };
    }
    StoreFile {
        version: STORE_VERSION,
        default_email: m.get("defaultEmail").and_then(Value::as_str).map(str::to_string),
        accounts: match m.get("accounts") {
            Some(Value::Array(a)) => a.clone(),
            _ => Vec::new(),
        },
    }
}

pub fn write_store_file(accounts: &[Value], default_email: Option<&str>) {
    let def: Option<String> = match default_email {
        Some(d) if accounts.iter().any(|a| email_of(a) == Some(d)) => Some(d.to_string()),
        _ => accounts.first().and_then(email_of).map(str::to_string),
    };
    let mut root = Map::new();
    root.insert("version".into(), json!(STORE_VERSION));
    if let Some(d) = def {
        root.insert("defaultEmail".into(), json!(d));
    }
    root.insert("accounts".into(), Value::Array(accounts.to_vec()));
    let _ = ccg_store::write_home_file(STORE_FILE, &crate::to_json_2space(&Value::Object(root)));
}

fn enc(raw: &str) -> Option<String> {
    if ccg_store::safe_storage::available() {
        ccg_store::safe_storage::encrypt(raw)
    } else {
        Some(ccg_store::safe_storage::b64_encode(raw.as_bytes()))
    }
}
fn dec(b64: &str) -> Option<String> {
    if ccg_store::safe_storage::available() {
        ccg_store::safe_storage::decrypt(b64)
    } else {
        String::from_utf8(ccg_store::safe_storage::b64_decode(b64)?).ok()
    }
}

// ── auth.json 해석 ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CodexIdentity {
    pub email: Option<String>,
    pub plan: Option<String>,
}

/// `auth.json` 원문 → 이메일·플랜. `id_token`(JWT)의 페이로드를 **표시용으로만** 디코드한다
/// (서명 검증 없음 — 우리 디스크에서 방금 읽은 값이고, 신뢰 판정에 쓰지 않는다).
/// API 키 인증(`OPENAI_API_KEY`만 있는 auth.json)은 이메일이 없어 계정 목록 대상이 아니다.
pub fn parse_auth(raw: Option<&str>) -> Option<CodexIdentity> {
    let raw = raw?;
    let j: Value = serde_json::from_str(raw).ok()?;
    if let Some(id) = j.get("tokens").and_then(|t| t.get("id_token")).and_then(Value::as_str) {
        let seg = id.split('.').nth(1)?;
        let payload: Value = serde_json::from_slice(&b64url_decode(seg)?).ok()?;
        let auth = payload.get("https://api.openai.com/auth");
        return Some(CodexIdentity {
            email: payload.get("email").and_then(Value::as_str).map(str::to_string),
            plan: auth.and_then(|a| a.get("chatgpt_plan_type")).and_then(Value::as_str).map(str::to_string),
        });
    }
    if j.get("OPENAI_API_KEY").and_then(Value::as_str).is_some_and(|s| !s.is_empty()) {
        return Some(CodexIdentity::default());
    }
    None
}

/// base64url → 바이트. 표준 알파벳 디코더(ccg-store)는 그대로 쓰고 문자만 바꾼다.
fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    let std: String = s.chars().map(|c| match c {
        '-' => '+',
        '_' => '/',
        c => c,
    }).collect();
    ccg_store::safe_storage::b64_decode(&std)
}

/// 토큰 신선도 — `last_refresh`(ISO). 못 읽으면 0, 필드가 없거나 파싱 불가면 1
/// (JS: `Date.parse`가 NaN → 1. 최소값이라 "있긴 한 토큰"이 "없는 토큰"을 이긴다).
pub fn auth_freshness(raw: Option<&str>) -> f64 {
    let Some(raw) = raw else { return 0.0 };
    let Ok(v) = serde_json::from_str::<Value>(raw) else { return 0.0 };
    match v.get("last_refresh").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        Some(s) => parse_iso8601_ms(s).unwrap_or(1.0),
        None => 1.0,
    }
}

/// RFC3339/ISO-8601 → epoch ms. `Date.parse`의 대역 — codex가 쓰는 모양
/// (`2026-08-10T12:34:56.789Z`, 오프셋 표기 포함)만 정확히 풀면 되고, 실패는 호출부가
/// JS의 NaN 갈래와 같게 다룬다. 값 자체가 아니라 **대소 비교**에만 쓰인다.
pub fn parse_iso8601_ms(s: &str) -> Option<f64> {
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || (b[10] != b'T' && b[10] != b't' && b[10] != b' ') {
        return None;
    }
    let num = |r: std::ops::Range<usize>| s.get(r).and_then(|x| x.parse::<i64>().ok());
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, sec) = (num(11..13)?, num(14..16)?, num(17..19)?);
    let mut ms = 0i64;
    let mut i = 19;
    if b.get(i) == Some(&b'.') {
        let start = i + 1;
        let mut end = start;
        while end < b.len() && b[end].is_ascii_digit() {
            end += 1;
        }
        // 밀리초 세 자리까지만(더 있으면 버린다 — Date.parse와 같다)
        let frac = &s[start..end];
        let three: String = frac.chars().chain("000".chars()).take(3).collect();
        ms = three.parse::<i64>().ok()?;
        i = end;
    }
    let mut offset_min = 0i64;
    match b.get(i) {
        None | Some(b'Z') | Some(b'z') => {}
        Some(&c @ (b'+' | b'-')) => {
            let sign = if c == b'-' { -1 } else { 1 };
            let oh = num(i + 1..i + 3)?;
            let om = if b.get(i + 3) == Some(&b':') { num(i + 4..i + 6)? } else { num(i + 3..i + 5).unwrap_or(0) };
            offset_min = sign * (oh * 60 + om);
        }
        _ => return None,
    }
    let days = days_from_civil(y, mo, d);
    let total = days * 86_400 + h * 3_600 + mi * 60 + sec - offset_min * 60;
    Some(total as f64 * 1000.0 + ms as f64)
}

/// Howard Hinnant의 days_from_civil — 1970-01-01 기준 일수.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

// ── 목록·기본 계정 ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexAccountInfo {
    pub email: String,
    pub plan: Option<String>,
    pub is_default: bool,
}

// ── ★R28 ACCT §4 — 기본 계정은 **맨 위**다(Anthropic 쪽과 같은 규약) ──────────
// 설계·근거는 `claude.rs`의 같은 절에 있다. 여기도 `defaultEmail`을 **안 읽고**,
// 남아 있으면 한 번 맨 위로 옮긴 뒤 파생값에 맡긴다.

static DEFAULT_MIGRATED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 옛 `defaultEmail` 계정을 맨 위로. 이미 맨 위면 아무것도 안 쓴다.
pub fn migrate_default_to_top() -> bool {
    let f = read_store_file();
    let Some(d) = f.default_email.as_deref() else { return false };
    let Some(i) = f.accounts.iter().position(|a| email_of(a) == Some(d)) else { return false };
    if i == 0 {
        return false;
    }
    let mut next = f.accounts.clone();
    let rec = next.remove(i);
    next.insert(0, rec);
    // `write_store_file(_, None)`은 `defaultEmail`을 **맨 위 계정으로 다시 채운다** —
    // 2.6.2가 같은 홈을 읽어도 기본 계정이 사라지지 않게(claude.rs와 같은 이유).
    write_store_file(&next, None);
    true
}

/// ★R28 ACCT R2(F3) — Codex 축의 같은 문. 근거는 `claude.rs`의 같은 함수에 있다
/// (부팅에서 한 번, 첫 목록 조회보다 먼저 — `ipc/system.rs`의 두 목록이 파일을 직접 읽는다).
pub fn ensure_default_migrated() {
    use std::sync::atomic::Ordering;
    if DEFAULT_MIGRATED.swap(true, Ordering::SeqCst) {
        return;
    }
    migrate_default_to_top();
}

/// 미지정 채팅이 쓸 Codex 계정 — **목록 맨 위**(파생값).
pub fn default_account_email() -> Option<String> {
    ensure_default_migrated();
    read_store_file().accounts.first().and_then(email_of).map(str::to_string)
}

/// `is_default`는 **인덱스 0**(파생값).
pub fn list_accounts() -> Vec<CodexAccountInfo> {
    ensure_default_migrated();
    read_store_file()
        .accounts
        .iter()
        .enumerate()
        .filter_map(|(i, a)| {
            let email = email_of(a)?.to_string();
            // 스토어 plan 우선, 없으면 신선한 auth.json의 id_token에서 폴백
            let plan = plan_of(a).map(str::to_string).or_else(|| {
                let dir_auth = read_file_or_null(&account_dir(&email).join("auth.json"));
                let backup = auth_enc_of(a).and_then(dec);
                let best = if auth_freshness(dir_auth.as_deref()) >= auth_freshness(backup.as_deref()) {
                    dir_auth.or(backup)
                } else {
                    backup
                };
                parse_auth(best.as_deref()).and_then(|i| i.plan)
            });
            Some(CodexAccountInfo { is_default: i == 0, plan, email })
        })
        .collect()
}

/// 「맨 위로 이동」 — 옛 `codex-auth:set-default-account`와 **동치**(§4).
pub fn set_default_account(email: &str) -> Vec<CodexAccountInfo> {
    move_account_to_top(email)
}

/// 계정 하나를 맨 위로(레코드째 옮긴다 — `authEnc`가 딸린 원본이라 재조립 금지).
pub fn move_account_to_top(email: &str) -> Vec<CodexAccountInfo> {
    ensure_default_migrated();
    let f = read_store_file();
    if let Some(i) = f.accounts.iter().rposition(|a| email_of(a) == Some(email)) {
        if i > 0 {
            let mut next = f.accounts.clone();
            let rec = next.remove(i);
            next.insert(0, rec);
            write_store_file(&next, None);
        }
    }
    list_accounts()
}

/// 순서 변경 — `claude::reorder_accounts`와 같은 규약이다(인덱스로 잡아 **레코드를 안 잃는다**.
/// 이메일로 거르면 같은 이메일 레코드가 둘일 때 두 번째 `authEnc`가 드래그 한 번에 사라진다).
pub fn reorder_accounts(emails: &[String]) -> Vec<CodexAccountInfo> {
    let f = read_store_file();
    let mut order: Vec<usize> = Vec::with_capacity(f.accounts.len());
    for e in emails {
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
    let next: Vec<Value> = order.into_iter().map(|i| f.accounts[i].clone()).collect();
    // ★R28 ACCT §4 — `None` = 「맨 위가 기본」. 옛 값을 들고 있으면 다음 부팅의
    //   마이그레이션이 사용자의 정렬을 되돌린다(claude.rs와 같은 함정).
    write_store_file(&next, None);
    list_accounts()
}

/// 등록 제거 + 폴더 정리. (`codex logout`은 CLI 경로 — `verify::codex_logout_command`)
pub fn remove_account(email: &str) -> Vec<CodexAccountInfo> {
    let f = read_store_file();
    let kept: Vec<Value> = f.accounts.iter().filter(|a| email_of(a) != Some(email)).cloned().collect();
    write_store_file(&kept, None); // 기본은 파생 — 맨 위가 이어받는다(§4)
    delete_account_dir(email);
    list_accounts()
}

// ── 격리 CODEX_HOME 물질화 ──────────────────────────────────────────────────

pub fn ensure_shared_root() {
    for name in SHARED_DIRS {
        let _ = std::fs::create_dir_all(shared_root().join(name));
    }
}

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

/// 실행용 `CODEX_HOME` — 등록 계정의 격리 폴더. 폴더 쪽 auth가 더 신선하면 남기고,
/// 백업이 더 신선하면(재로그인) 백업으로 덮는다.
pub fn account_run_dir(email: &str) -> Result<PathBuf, AuthError> {
    let f = read_store_file();
    let target = f
        .accounts
        .iter()
        .find(|a| email_of(a) == Some(email))
        .ok_or_else(|| AuthError::NotRegistered(email.to_string()))?;
    let enc_s = auth_enc_of(target).ok_or_else(|| AuthError::CorruptSnapshot(email.to_string()))?;
    let raw = dec(enc_s).ok_or_else(|| AuthError::Undecryptable(email.to_string()))?;
    let dir = account_dir(email);
    std::fs::create_dir_all(&dir).map_err(|e| AuthError::Io(e.to_string()))?;
    let auth_path = dir.join("auth.json");
    if auth_freshness(Some(&raw)) >= auth_freshness(read_file_or_null(&auth_path).as_deref()) {
        crate::write_file_atomic(&auth_path, &raw)?;
    }
    link_shared_state(&dir);
    Ok(dir)
}

/// API 키 실행용 `CODEX_HOME` — 계정 로그인 대신 저장된 `OPENAI_API_KEY`로 과금하는 홈.
/// `sessions` 정션을 계정 폴더들과 공유하므로 구독 ↔ API를 오가도 resume이 이어진다.
pub fn api_key_run_dir(key: &str) -> Result<PathBuf, AuthError> {
    let dir = codex_root().join("api-key");
    std::fs::create_dir_all(&dir).map_err(|e| AuthError::Io(e.to_string()))?;
    crate::write_file_atomic(&dir.join("auth.json"), &json!({ "OPENAI_API_KEY": key }).to_string())?;
    link_shared_state(&dir);
    Ok(dir)
}

/// 실행 뒤 되싱크 — 폴더의 리프레시된 auth.json을 백업에 반영(전진 가드).
/// 플랜은 여기서 건드리지 않는다 — `rateLimits/read`의 planType이 진실이다.
pub fn sync_account(email: &str) -> bool {
    let f = read_store_file();
    let Some(target) = f.accounts.iter().find(|a| email_of(a) == Some(email)) else { return false };
    let Some(dir_auth) = read_file_or_null(&account_dir(email).join("auth.json")) else { return false };
    let Some(raw) = auth_enc_of(target).and_then(dec) else { return false };
    if dir_auth == raw {
        return false;
    }
    if auth_freshness(Some(&dir_auth)) <= auth_freshness(Some(&raw)) {
        return false;
    }
    let Some(auth_enc) = enc(&dir_auth) else { return false };
    let next: Vec<Value> = f
        .accounts
        .iter()
        .map(|a| {
            if email_of(a) == Some(email) {
                let mut m = a.as_object().cloned().unwrap_or_default();
                m.insert("authEnc".into(), json!(auth_enc));
                Value::Object(m)
            } else {
                a.clone()
            }
        })
        .collect();
    write_store_file(&next, f.default_email.as_deref());
    true
}

/// 구독 변경(Free→Plus 등)을 스토어 plan에 되싱크 — 목록 표시가 다음 조회부터 맞게.
pub fn resync_plan(email: &str, plan_type: &str) -> bool {
    let f = read_store_file();
    let Some(target) = f.accounts.iter().find(|a| email_of(a) == Some(email)) else { return false };
    if plan_of(target) == Some(plan_type) {
        return false;
    }
    let next: Vec<Value> = f
        .accounts
        .iter()
        .map(|a| {
            if email_of(a) == Some(email) {
                let mut m = a.as_object().cloned().unwrap_or_default();
                m.insert("plan".into(), json!(plan_type));
                Value::Object(m)
            } else {
                a.clone()
            }
        })
        .collect();
    write_store_file(&next, f.default_email.as_deref());
    true
}

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

/// 폴더의 auth.json을 스토어에 편입 + 폴더 물질화(로그인 완료·마이그레이션 공용).
/// 편입된 이메일을 돌려준다 — API 키 인증(이메일 없음)이면 None.
pub fn import_account_from_dir(dir: &Path) -> Option<String> {
    let raw = read_file_or_null(&dir.join("auth.json"))?;
    let meta = parse_auth(Some(&raw))?;
    let email = meta.email?;
    let auth_enc = enc(&raw)?;
    let f = read_store_file();
    let mut accounts: Vec<Value> = f.accounts.iter().filter(|a| email_of(a) != Some(email.as_str())).cloned().collect();
    let mut rec = Map::new();
    rec.insert("email".into(), json!(email));
    if let Some(p) = &meta.plan {
        rec.insert("plan".into(), json!(p));
    }
    rec.insert("authEnc".into(), json!(auth_enc));
    accounts.push(Value::Object(rec));
    write_store_file(&accounts, f.default_email.as_deref());
    let _ = account_run_dir(&email);
    Some(email)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::temp_home;

    /// 서명 없는 JWT 흉내 — 페이로드 세그먼트만 진짜면 parse_auth가 읽는다.
    fn id_token(email: &str, plan: &str) -> String {
        let payload = json!({ "email": email, "https://api.openai.com/auth": { "chatgpt_plan_type": plan } }).to_string();
        let b64 = ccg_store::safe_storage::b64_encode(payload.as_bytes())
            .replace('+', "-")
            .replace('/', "_")
            .replace('=', "");
        format!("h.{b64}.s")
    }
    fn auth_json(email: &str, plan: &str, last_refresh: &str) -> String {
        json!({ "tokens": { "id_token": id_token(email, plan), "access_token": "at" }, "last_refresh": last_refresh }).to_string()
    }
    fn seed(email: &str, plan: &str, last_refresh: &str) {
        let raw = auth_json(email, plan, last_refresh);
        let f = read_store_file();
        let mut accounts = f.accounts.clone();
        accounts.push(json!({ "email": email, "plan": plan, "authEnc": enc(&raw).unwrap() }));
        write_store_file(&accounts, f.default_email.as_deref());
    }

    #[test]
    fn store_write_shape_matches_2_6_2() {
        let h = temp_home("cx-shape");
        write_store_file(&[], None);
        assert_eq!(h.read("codex-accounts.json").unwrap(), "{\n  \"version\": 1,\n  \"accounts\": []\n}");
    }

    #[test]
    fn jwt_identity_is_decoded_for_display() {
        let raw = auth_json("me@openai.com", "pro", "2026-08-10T12:00:00Z");
        assert_eq!(
            parse_auth(Some(&raw)),
            Some(CodexIdentity { email: Some("me@openai.com".into()), plan: Some("pro".into()) })
        );
        // API 키 인증은 이메일이 없다 — 계정 목록 대상이 아니다
        assert_eq!(parse_auth(Some(r#"{"OPENAI_API_KEY":"sk-x"}"#)), Some(CodexIdentity::default()));
        assert_eq!(parse_auth(Some("{}")), None);
        assert_eq!(parse_auth(Some("nope")), None);
    }

    #[test]
    fn iso_freshness_orders_like_date_parse() {
        // node: Date.parse('2026-08-10T12:34:56.789Z') === 1786451696789
        assert_eq!(parse_iso8601_ms("2026-08-10T12:34:56.789Z"), Some(1_786_365_296_789.0));
        // node: Date.parse('2026-08-10T21:34:56+09:00') === 1786451696000
        assert_eq!(parse_iso8601_ms("2026-08-10T21:34:56+09:00"), Some(1_786_365_296_000.0));
        assert_eq!(parse_iso8601_ms("1970-01-01T00:00:00Z"), Some(0.0));
        assert_eq!(parse_iso8601_ms("nope"), None);
        // 없는 파일 0 < 못 읽는 시각 1 < 실제 시각
        assert_eq!(auth_freshness(None), 0.0);
        assert_eq!(auth_freshness(Some("{}")), 1.0);
        assert_eq!(auth_freshness(Some("not json")), 0.0);
        assert!(auth_freshness(Some(&auth_json("a@b.c", "plus", "2026-08-10T12:00:00Z"))) > 1.0);
    }

    #[test]
    fn materialize_links_sessions_and_respects_freshness() {
        let h = temp_home("cx-materialize");
        seed("me@openai.com", "plus", "2026-01-01T00:00:00Z");
        let dir = account_run_dir("me@openai.com").unwrap();
        assert_eq!(dir, h.path("codex/accounts/me_openai.com-1xx2bsd"));
        for name in SHARED_DIRS {
            assert!(junction::is_link(&dir.join(name)), "{name} 정션이 없으면 codex resume이 계정별로 갈라진다");
        }
        // CLI가 폴더에서 리프레시 → 물질화가 덮지 않는다
        std::fs::write(dir.join("auth.json"), auth_json("me@openai.com", "plus", "2026-06-01T00:00:00Z")).unwrap();
        account_run_dir("me@openai.com").unwrap();
        assert!(std::fs::read_to_string(dir.join("auth.json")).unwrap().contains("2026-06-01"));
        assert!(sync_account("me@openai.com"), "폴더가 더 신선하면 백업이 따라온다");
        assert!(!sync_account("me@openai.com"), "두 번째는 변화 없음");
        // 후퇴 가드
        std::fs::write(dir.join("auth.json"), auth_json("me@openai.com", "plus", "2025-01-01T00:00:00Z")).unwrap();
        assert!(!sync_account("me@openai.com"));
    }

    #[test]
    fn api_key_home_shares_sessions_with_accounts() {
        let h = temp_home("cx-apikey");
        let dir = api_key_run_dir("sk-test").unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("auth.json")).unwrap(), r#"{"OPENAI_API_KEY":"sk-test"}"#);
        std::fs::write(dir.join("sessions").join("s.jsonl"), "{}").unwrap();
        assert!(h.path("codex/shared/sessions/s.jsonl").is_file(), "API 모드와 구독 모드가 같은 스레드를 이어야 한다");
    }

    #[test]
    fn import_and_plan_resync() {
        let h = temp_home("cx-import");
        let g = h.path("codex/login");
        std::fs::create_dir_all(&g).unwrap();
        std::fs::write(g.join("auth.json"), auth_json("me@openai.com", "free", "2026-01-01T00:00:00Z")).unwrap();
        assert_eq!(import_account_from_dir(&g).as_deref(), Some("me@openai.com"));
        assert_eq!(list_accounts()[0].plan.as_deref(), Some("free"));
        // rateLimits/read가 진실을 알려주면 스토어가 따라간다(id_token은 옛 플랜을 문다)
        assert!(resync_plan("me@openai.com", "pro"));
        assert_eq!(list_accounts()[0].plan.as_deref(), Some("pro"));
        assert!(!resync_plan("me@openai.com", "pro"));
    }
}
