//! ccg-auth — 계정 도메인. **절대 조건은 "사용자가 재로그인하지 않는다"** 이다.
//!
//! 2.6.2(Electron)의 `src/main/auth.ts`(Anthropic 구독) + `src/main/codex/auth.ts`(OpenAI)를
//! 옮긴 것이고, 원본이 진실이다 — 여기는 미러다. 옮긴 규약을 한 줄로:
//!
//! ```text
//! ~/.agentcodegui/accounts.json        v3(=v2 계정 포맷) { version, defaultEmail?, accounts[] }
//!   accounts[].credEnc = base64( safeStorage( JSON({creds, account, userID?}) ) )
//!   creds              = .credentials.json 원문(claudeAiOauth: accessToken/refreshToken/expiresAt…)
//!   account            = .claude.json 의 oauthAccount(신원) — 토큰만 스왑하면 CLI가 자가 교정한다
//! ~/.agentcodegui/codex-accounts.json  v1 { version, defaultEmail?, accounts[] }
//!   accounts[].authEnc = base64( safeStorage( auth.json 원문 ) )
//! ```
//!
//! **바이트 호환**이 이 크레이트의 합격선이다. 저장한 파일을 2.6.2가 그대로 읽어야 하고
//! (롤백 경로), 반대로 지금 사용자의 홈을 3.0이 그대로 읽어야 한다(승계 경로). 그래서
//! 계정 레코드는 파싱해 재구성하지 않고 **원본 `Map`을 들고 다니며 아는 키만 갈아끼운다**
//! (`serde_json/preserve_order` + `IndexMap::insert`의 자리 보존). 모르는 키가 있어도 그대로
//! 살아 나간다.
//!
//! **암호화는 이 크레이트에 없다.** `ccg-store`의 `safe_storage`(R8에서 v10 쓰기까지 실측
//! 검증)를 호출한다 — 스킴이 두 벌이 되는 순간 한쪽만 고쳐져 사용자가 재로그인을 하게 된다.
//!
//! **네트워크도 이 크레이트에 없다.** HTTP 클라이언트 의존성 자체가 없어서 구조적으로
//! 못 나간다. 한도 조회·생사검증·토큰 리프레시·로그아웃(해지)은 전부 *조립*까지만 한다
//! (`usage`·`verify` 모듈의 [`HttpRequest`]/[`CommandSpec`]). 실호출은 배선 라운드의 몫이고,
//! 그 덕에 여기 테스트는 사용자 실계정을 건드릴 수 없다.
//!
//! **★M11 정정** — 실호출이 왔다. 다만 위 성질은 그대로 지킨다: 실행기는 `net` **피처
//! 안에만** 있고(`src/net.rs`) 기본 빌드·`cargo test -p ccg-auth`에는 컴파일조차 되지
//! 않는다. 켜는 곳은 `src-tauri` 하나이고, 켜도 `CCG_NO_NET=1`이 전 호출을 즉시 막는다.
//! 파괴적 경로(`claude auth logout` = 서버 토큰 해지)는 **여전히 조립까지만** 한다.

pub mod claude;
pub mod codex;
/// JS 강제변환·`Date.parse` 미러 — 2.6.2 파서가 기대고 있는 의미론(M5 R2).
pub mod js;
pub mod junction;
/// ★M11 — 실 HTTP 실행기. **`net` 피처에서만** 존재한다(아래 헤더의 "네트워크도 이
/// 크레이트에 없다"는 여전히 기본 빌드의 사실이다).
#[cfg(feature = "net")]
pub mod net;
/// ★M11 — 한도 소진 시 갈아탈 계정 고르기(순수 판정 · 네트워크 없음).
pub mod switch;
pub mod usage;
pub mod verify;

#[cfg(test)]
mod testkit;
#[cfg(test)]
mod real_home_tests;

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// 앱 홈 — `ccg-store`가 단일 소스(`CCG_HOME` 오버라이드 포함).
pub fn app_home() -> PathBuf {
    ccg_store::app_home()
}

/// 계정 도메인이 실패하는 방식. 2.6.2는 여기서 i18n 문자열을 던졌는데(`t(ko,en)`),
/// 크레이트는 문구를 모른다 — 배선 라운드가 이 판별식을 문장으로 옮긴다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthError {
    /// 등록 목록에 없는 이메일 — "설정 → Account에서 로그인해 주세요".
    NotRegistered(String),
    /// credEnc/authEnc를 못 풀었다(다른 Windows 사용자·다른 머신의 홈을 복사한 경우 등).
    Undecryptable(String),
    /// 풀리긴 했는데 스냅샷이 깨졌다(토큰 또는 신원 누락).
    CorruptSnapshot(String),
    /// 같은 토큰이 **다른 이메일로도** 저장돼 있다(값 = 그 다른 이메일). 이름표만 다르고
    /// 실토큰은 하나라, 그대로 두면 CLI가 토큰 주인으로 자가 교정해 계정이 되돌아간다.
    TokenCollision(String),
    /// 파일 시스템(폴더 생성·물질화) 실패.
    Io(String),
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AuthError::NotRegistered(e) => write!(f, "account not registered: {e}"),
            AuthError::Undecryptable(e) => write!(f, "account data could not be decrypted: {e}"),
            AuthError::CorruptSnapshot(e) => write!(f, "account snapshot is corrupt: {e}"),
            AuthError::TokenCollision(e) => write!(f, "token already stored under another account: {e}"),
            AuthError::Io(m) => write!(f, "io: {m}"),
        }
    }
}
impl std::error::Error for AuthError {}

/// 이메일 → 계정 폴더 이름. **2.6.2와 한 글자도 달라선 안 된다** — 슬러그가 달라지면
/// 이미 물질화된 폴더(살아 있는 토큰이 든)를 못 찾고 새 폴더를 만든다.
///
/// 원본(auth.ts / codex/auth.ts 동일):
/// ```js
/// const safe = email.toLowerCase().replace(/[^a-z0-9._-]+/g, '_')
/// let h = 0; for (i) h = (h * 31 + email.charCodeAt(i)) >>> 0
/// return `${safe}-${h.toString(36)}`
/// ```
/// 함정 둘: ① 치환은 **연속 구간을 `_` 하나로** 접는다(`+g`), ② 해시는 소문자화 **전**
/// 원본의 **UTF-16 코드 유닛**을 돈다(`charCodeAt`).
pub fn account_slug(email: &str) -> String {
    let lower = email.to_lowercase();
    let mut safe = String::with_capacity(lower.len());
    let mut in_run = false;
    for c in lower.chars() {
        let ok = c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '_' || c == '-';
        if ok {
            safe.push(c);
            in_run = false;
        } else if !in_run {
            safe.push('_');
            in_run = true;
        }
    }
    let mut h: u32 = 0;
    for u in email.encode_utf16() {
        h = h.wrapping_mul(31).wrapping_add(u as u32);
    }
    format!("{safe}-{}", to_base36(h))
}

fn to_base36(mut n: u32) -> String {
    const T: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".into();
    }
    let mut buf = Vec::new();
    while n > 0 {
        buf.push(T[(n % 36) as usize]);
        n /= 36;
    }
    buf.reverse();
    String::from_utf8(buf).unwrap_or_default()
}

/// 토큰 지문 — sha256 앞 12자(hex). 스냅샷 오염(다른 계정 항목에 같은 토큰) 진단의 판정 키.
/// `api_config.rs`의 env 키 지문과 같은 레시피라 리포트끼리 값을 견줄 수 있고,
/// **토큰 원문은 어디에도 남지 않는다**.
pub fn token_fingerprint(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    let d = h.finalize();
    d.iter().map(|b| format!("{b:02x}")).collect::<String>()[..12].to_string()
}

/// 2.6.2의 `readFileOrNull` — 없거나 못 읽으면 None(조용히).
pub fn read_file_or_null(p: &Path) -> Option<String> {
    std::fs::read_to_string(p).ok()
}

/// 2.6.2의 `readJson` — 없거나 깨졌으면 None.
pub fn read_json_file(p: &Path) -> Option<Map<String, Value>> {
    match serde_json::from_str::<Value>(&std::fs::read_to_string(p).ok()?) {
        Ok(Value::Object(m)) => Some(m),
        _ => None,
    }
}

/// `JSON.stringify(v, null, 2)`와 같은 바이트. serde_json의 pretty는 2칸 들여쓰기 +
/// `": "` 구분자 + 빈 배열 `[]`라 Node와 일치한다(테스트가 실제 홈 파일로 확인한다).
pub fn to_json_2space(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_else(|_| "{}".into())
}

/// 숫자를 **JS가 쓰는 모양으로** 넣는다. serde는 f64 `1.0`을 `1.0`으로 쓰지만 JS는 `1`로
/// 쓴다 — `expiresAt` 같은 epoch ms가 `1787410867317.0`으로 저장되면 정수를 기대하는
/// 파서(우리가 아닌 쪽)가 걸려 넘어질 수 있다. 정수면 정수로 굳힌다.
pub fn js_number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9.007_199_254_740_992e15 {
        Value::from(n as i64)
    } else {
        Value::from(n)
    }
}

/// 계정 폴더 안 파일 저장 — 쓰고-바꾸기. 2.6.2는 `writeFileSync`(비원자)라 도중에 죽으면
/// **잘린 `.credentials.json`** 이 남고 그건 곧 "로그아웃"이다. 실패 시 tmp를 지워
/// 평문 토큰 조각이 폴더에 눌러앉지 않게 한다.
pub fn write_file_atomic(path: &Path, data: &str) -> Result<(), AuthError> {
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d).map_err(|e| AuthError::Io(e.to_string()))?;
    }
    let tmp = {
        let mut s = path.as_os_str().to_os_string();
        s.push(".tmp");
        PathBuf::from(s)
    };
    let res = std::fs::write(&tmp, data).and_then(|_| std::fs::rename(&tmp, path));
    if res.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    res.map_err(|e| AuthError::Io(e.to_string()))
}

/// 조립만 하고 던지지 않는 HTTP 요청 — 한도 조회·토큰 리프레시·생사검증의 산출물.
/// (이 크레이트에는 전송 계층이 없다. 배선 라운드가 그대로 실어 보내면 2.6.2와 같은 호출이다.)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequest {
    pub method: &'static str,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    /// 2.6.2가 쓰던 AbortController 타임아웃(ms).
    pub timeout_ms: u64,
}

/// CLI에 넘겨도 되는 config 폴더 — **앱 홈 안에서 물질화된 것만** 담는 증표다.
///
/// 왜 타입이 필요한가: `claude auth status --json`은 **읽기 전용이 아니다.** 돌리고 나면
/// 그 폴더의 `.claude.json`에 `firstStartTime`·`migrationVersion`·`seenNotifications`·
/// `opusProMigrationComplete`가 붙고 `backups/`가 생긴다(M5 R1 크리틱 §2.1 실측).
/// 사용자 실홈(`~/.claude`·`~/.codex`)을 향해 돌리면 우리가 그 파일을 건드리는 것이고,
/// CLI가 토큰 리프레시 회전까지 하면 **백업 refresh 토큰이 죽어 재로그인**이 된다 —
/// 이 크레이트가 존재하는 이유 자체를 어기는 사고다.
///
/// 그래서 CLI 명령 조립기([`verify::status_command`] 등)는 `&Path`를 **안 받는다**.
/// 앱 홈 밖 경로로는 이 타입을 만들 수 없고, 만들 수 없으면 명령도 못 만든다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IsolatedConfigDir(PathBuf);

impl IsolatedConfigDir {
    /// 앱 홈(`CCG_HOME`/`~/.agentcodegui`) **안**이면 증표를 준다. 밖이면 `None`.
    /// `..`가 한 조각이라도 있으면 거부한다(정규화 없이 탈출하는 경로 차단).
    pub fn new(p: &Path) -> Option<IsolatedConfigDir> {
        if p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
            return None;
        }
        under_app_home(p).then(|| IsolatedConfigDir(p.to_path_buf()))
    }

    /// 구독 계정의 격리 `CLAUDE_CONFIG_DIR`(물질화까지 한다).
    pub fn for_claude_account(email: &str) -> Result<IsolatedConfigDir, AuthError> {
        let d = claude::account_run_dir(email)?;
        IsolatedConfigDir::new(&d).ok_or_else(|| AuthError::Io(format!("config dir escaped the app home: {}", d.display())))
    }

    /// 로그인 임시 폴더 — 이메일을 모르는 동안만 쓴다.
    pub fn for_claude_login() -> IsolatedConfigDir {
        IsolatedConfigDir(claude::login_dir())
    }

    pub fn for_codex_account(email: &str) -> Result<IsolatedConfigDir, AuthError> {
        let d = codex::account_run_dir(email)?;
        IsolatedConfigDir::new(&d).ok_or_else(|| AuthError::Io(format!("config dir escaped the app home: {}", d.display())))
    }

    pub fn for_codex_login() -> IsolatedConfigDir {
        IsolatedConfigDir(codex::login_dir())
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

/// 앱 홈 **안**인가(홈 자기 자신은 아니다). Windows는 대소문자·구분자를 눕혀서 본다.
fn under_app_home(p: &Path) -> bool {
    let home = app_home();
    #[cfg(windows)]
    {
        let norm = |x: &Path| x.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_lowercase();
        let (a, b) = (norm(p), norm(&home));
        !b.is_empty() && a.len() > b.len() && a.starts_with(&b) && a.as_bytes()[b.len()] == b'\\'
    }
    #[cfg(not(windows))]
    {
        p != home && p.starts_with(&home)
    }
}

/// 조립만 하고 스폰하지 않는 프로세스 — CLI 경유 경로(로그인·해지·codex app-server).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandSpec {
    pub program: String,
    pub args: Vec<String>,
    /// `process.env`에 **덧씌울** 항목만(전체 치환이 아니다).
    pub env: Vec<(String, String)>,
    pub timeout_ms: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 실홈(`~/.agentcodegui/accounts/`)에 실제로 만들어져 있는 폴더 이름들과 대조한다.
    /// 이 값이 어긋나면 3.0이 새 폴더를 파고, 사용자는 "왜 다시 로그인하라고 하지"가 된다.
    #[test]
    fn slug_matches_the_folders_that_already_exist_on_disk() {
        assert_eq!(account_slug("lmg56634@gmail.com"), "lmg56634_gmail.com-68e935");
        assert_eq!(account_slug("junelius@naver.com"), "junelius_naver.com-qha69s");
        assert_eq!(account_slug("lmg56632@gmail.com"), "lmg56632_gmail.com-1to4267");
        assert_eq!(account_slug("lmg56633@gmail.com"), "lmg56633_gmail.com-zy95mo");
        assert_eq!(account_slug("lmg56635@gmail.com"), "lmg56635_gmail.com-1bjneiq");
        assert_eq!(account_slug("lmg56631@gmail.com"), "lmg56631_gmail.com-ocuwqm");
    }

    /// 연속 치환(`+g`)과 대문자·비ASCII 갈래 — node로 뽑은 기대값.
    #[test]
    fn slug_folds_runs_and_hashes_the_original_utf16() {
        assert_eq!(account_slug("A.B+tag@Example.COM"), "a.b_tag_example.com-onyezl");
        assert_eq!(account_slug("한글@x.com"), "_x.com-188jyzz");
    }

    #[test]
    fn fingerprint_matches_the_2_6_2_recipe() {
        // node: createHash('sha256').update('abc').digest('hex').slice(0,12)
        assert_eq!(token_fingerprint("abc"), "ba7816bf8f01");
    }

    #[test]
    fn pretty_json_is_node_shaped() {
        let v = serde_json::json!({ "version": 3, "accounts": [], "defaultEmail": "a@b.c" });
        // JSON.stringify({version:3,accounts:[],defaultEmail:'a@b.c'}, null, 2)
        assert_eq!(to_json_2space(&v), "{\n  \"version\": 3,\n  \"accounts\": [],\n  \"defaultEmail\": \"a@b.c\"\n}");
    }
}
