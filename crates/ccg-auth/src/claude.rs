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

// ── 스토어 파일 ─────────────────────────────────────────────────────────────

/// `accounts.json` 한 장. 계정 레코드는 **원본 `Value` 그대로** 들고 다닌다 —
/// 모르는 키가 있어도 되쓸 때 살아 나가야 2.6.2로 되돌릴 수 있다.
#[derive(Debug, Clone, Default)]
pub struct StoreFile {
    pub version: u64,
    pub default_email: Option<String>,
    pub accounts: Vec<Value>,
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
pub fn read_store_file() -> StoreFile {
    let Some(m) = read_json_file(&store_path()) else {
        return StoreFile { version: STORE_VERSION, ..Default::default() };
    };
    let version = m.get("version").and_then(Value::as_u64).unwrap_or(0);
    if version != STORE_VERSION && version != 2 {
        return StoreFile { version: STORE_VERSION, ..Default::default() };
    }
    StoreFile {
        version,
        default_email: m.get("defaultEmail").and_then(Value::as_str).map(str::to_string),
        accounts: match m.get("accounts") {
            Some(Value::Array(a)) => a.clone(),
            _ => Vec::new(),
        },
    }
}

/// 저장 — **항상 v3로 쓴다**(2.6.2 `writeStoreFile`과 같다. v2를 읽어 쓰면 승격된다).
/// 기본 계정이 목록에 없으면 첫 계정으로 물러난다 — "기본 없음" 상태를 만들지 않는다.
pub fn write_store_file(accounts: &[Value], default_email: Option<&str>) {
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
    let _ = ccg_store::write_home_file(STORE_FILE, &crate::to_json_2space(&Value::Object(root)));
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
    let f = read_store_file();
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
    read_store_file()
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
    let f = read_store_file();
    if f.accounts.iter().any(|a| email_of(a) == Some(email)) {
        write_store_file(&f.accounts, Some(email));
    }
    list_accounts()
}

/// 목록에서 제거 + 물질화된 폴더 정리. (서버 토큰 해지는 CLI 경로 — `verify::logout_command`)
pub fn remove_account(email: &str) -> Vec<AccountInfo> {
    let f = read_store_file();
    let kept: Vec<Value> = f.accounts.iter().filter(|a| email_of(a) != Some(email)).cloned().collect();
    write_store_file(&kept, f.default_email.as_deref());
    delete_account_dir(email);
    list_accounts()
}

/// 순서 변경 — 주어진 순서에 없는 계정은 기존 순서대로 뒤에 남긴다(드래그 중 다른 창에서
/// 로그인해 목록이 어긋나도 유실 없음).
pub fn reorder_accounts(emails: &[String]) -> Vec<AccountInfo> {
    let f = read_store_file();
    let mut next: Vec<Value> = Vec::with_capacity(f.accounts.len());
    for e in emails {
        if let Some(a) = f.accounts.iter().find(|a| email_of(a) == Some(e.as_str())) {
            if !next.iter().any(|n| email_of(n) == Some(e.as_str())) {
                next.push(a.clone());
            }
        }
    }
    for a in &f.accounts {
        let dup = match email_of(a) {
            Some(e) => next.iter().any(|n| email_of(n) == Some(e)),
            None => false,
        };
        if !dup {
            next.push(a.clone());
        }
    }
    write_store_file(&next, f.default_email.as_deref());
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
    let f = read_store_file();
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
    let f = read_store_file();
    let Some(target) = f.accounts.iter().find(|a| email_of(a) == Some(email)) else { return false };
    let Some(dir_creds) = read_file_or_null(&account_dir(email).join(".credentials.json")) else { return false };
    let Some(enc) = cred_enc_of(target) else { return false };
    let Some(raw) = dec_creds(enc) else { return false };
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
    let next: Vec<Value> = f
        .accounts
        .iter()
        .map(|a| {
            if email_of(a) == Some(email) {
                let mut m = a.as_object().cloned().unwrap_or_default();
                m.insert("credEnc".into(), json!(cred_enc)); // 자리 보존 치환
                Value::Object(m)
            } else {
                a.clone()
            }
        })
        .collect();
    write_store_file(&next, f.default_email.as_deref());
    true
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
    let f = read_store_file();
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

/// 리프레시 결과를 **폴더와 백업 둘 다**에 즉시 되쓴다 — 어느 쪽에도 죽은 토큰을 남기지
/// 않는다(회전된 refresh 토큰 유실 = 재로그인).
pub fn persist_refreshed(email: &str, next_creds: &str) -> Result<(), AuthError> {
    let dir = account_dir(email);
    std::fs::create_dir_all(&dir).map_err(|e| AuthError::Io(e.to_string()))?;
    crate::write_file_atomic(&dir.join(".credentials.json"), next_creds)?;
    let f = read_store_file();
    let Some(target) = f.accounts.iter().find(|a| email_of(a) == Some(email)) else {
        return Err(AuthError::NotRegistered(email.to_string()));
    };
    let Some(raw) = cred_enc_of(target).and_then(dec_creds) else {
        return Err(AuthError::Undecryptable(email.to_string()));
    };
    let snap = Snapshot::parse(&raw);
    if snap.raw.is_empty() {
        return Err(AuthError::CorruptSnapshot(email.to_string()));
    }
    let Some(cred_enc) = enc_creds(&snap.with_creds(next_creds)) else {
        return Err(AuthError::Undecryptable(email.to_string()));
    };
    let next: Vec<Value> = f
        .accounts
        .iter()
        .map(|a| {
            if email_of(a) == Some(email) {
                let mut m = a.as_object().cloned().unwrap_or_default();
                m.insert("credEnc".into(), json!(cred_enc));
                Value::Object(m)
            } else {
                a.clone()
            }
        })
        .collect();
    write_store_file(&next, f.default_email.as_deref());
    Ok(())
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
        if let Some(other) = token_owner(&creds) {
            if other != email {
                return Err(AuthError::TokenCollision(other));
            }
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

    let f = read_store_file();
    let mut accounts: Vec<Value> = f.accounts.iter().filter(|a| email_of(a) != Some(email)).cloned().collect();
    let mut rec = Map::new();
    rec.insert("email".into(), json!(email));
    if let Some(s) = subscription_type {
        rec.insert("subscriptionType".into(), json!(s));
    }
    rec.insert("credEnc".into(), json!(cred_enc));
    accounts.push(Value::Object(rec));
    // 첫 계정이면 write_store_file의 폴백이 기본 계정으로 세운다
    write_store_file(&accounts, f.default_email.as_deref());
    let _ = account_run_dir(email); // 실패해도 다음 실행 때 다시 시도된다
    Ok(())
}

// ── 진단(스냅샷 오염) ───────────────────────────────────────────────────────

/// 이 토큰 원문이 이미 저장돼 있는 계정의 이메일. 두 계정이 같은 값을 물고 있으면
/// **이름표만 다르고 실토큰은 하나** — 1.6.1에서 "전환이 되돌아감"의 진짜 원인이었다.
pub fn token_owner(creds: &str) -> Option<String> {
    read_store_file().accounts.iter().find_map(|a| {
        let raw = cred_enc_of(a).and_then(dec_creds)?;
        (Snapshot::parse(&raw).creds()? == creds).then(|| email_of(a).unwrap_or_default().to_string())
    })
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
        write_store_file(&accounts, f.default_email.as_deref());
    }

    #[test]
    fn store_write_shape_matches_2_6_2() {
        let h = temp_home("store-shape");
        write_store_file(&[], None);
        // JSON.stringify({version:3, defaultEmail:undefined, accounts:[]}, null, 2)
        assert_eq!(h.read("accounts.json").unwrap(), "{\n  \"version\": 3,\n  \"accounts\": []\n}");
        let a = json!({ "email": "a@b.c", "subscriptionType": "max", "credEnc": "XX" });
        write_store_file(&[a], Some("nope@x.com"));
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
        write_store_file(&f.accounts, f.default_email.as_deref());
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
        write_store_file(&f.accounts, f.default_email.as_deref());
        assert_eq!(h.read("accounts.json").unwrap(), before, "모르는 키·키 순서가 그대로 남아야 2.6.2로 되돌릴 수 있다");
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
        write_store_file(&accounts, f.default_email.as_deref());

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
        write_store_file(&[json!({ "email": "a@x.com", "credEnc": "bm90LWEtcmVhbC1ibG9i" })], None);
        assert!(matches!(account_run_dir("a@x.com"), Err(AuthError::Undecryptable(_))));
        // 풀렸는데 알맹이가 비었다
        let enc = enc_creds(&json!({ "creds": "", "account": null }).to_string()).unwrap();
        write_store_file(&[json!({ "email": "a@x.com", "credEnc": enc })], None);
        assert!(matches!(account_run_dir("a@x.com"), Err(AuthError::CorruptSnapshot(_))));
        drop(h);
    }
}
