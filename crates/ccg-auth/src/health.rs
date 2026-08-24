//! ★M11 R3(F2) — **계정 건강 장부**(`<home>/account-health.json`).
//!
//! R2에는 이 자리가 없었다. 토큰 회전이 실패해 [`crate::net::NetError::TokenLost`]가 나도
//! 남는 것은 `eprintln!` 한 줄뿐이었고, 그 계정은
//!
//! 1. 다음 tick에 **다시 후보**가 됐다(캐시에 지난 usage가 있으면 심지어 1등 — 확인 크리틱 T5),
//! 2. 워커 쿨다운 20초마다 **죽은 토큰으로 교환 POST**를 반복했다(상한 없음).
//!
//! 그래서 실패를 **값으로** 남긴다. 이 파일이 그 값의 거처다.
//!
//! ## 왜 디스크인가 (메모리가 아니라)
//!
//! - 사용자가 읽어야 하는 사실이다("이 계정은 재로그인이 필요할 수 있어요" — 설정 Account 탭).
//!   화면을 그리는 코드는 워커의 메모리를 못 본다.
//! - 앱을 껐다 켠다고 죽은 refresh 토큰이 살아나지 않는다. 부팅마다 다시 태워 볼 이유가 없다.
//!
//! ## 복구 경로 (이게 없으면 격리는 감옥이다)
//!
//! 표식에는 **그때 그 refresh 토큰의 지문**을 같이 적는다. 지문이 달라졌다 = 사용자가
//! 재로그인했다 = 우리가 아는 근거가 낡았다 → [`needs_login`]이 스스로 `false`가 되고
//! 표식은 지워진다. 조회가 한 번 성공해도([`clear`]) 지워진다.
//!
//! ## ★M11 R4 — R3의 복구 경로는 두 군데가 틀렸다
//!
//! | # | R3 | 무슨 일이 났나 | R4 |
//! |---|---|---|---|
//! | G2 | 지문을 못 뜨면 `tokenFp`를 안 적고, 해제 규칙은 `token_fp.is_some() && …` | 그 표식은 **어떤 재로그인으로도** 안 풀린다. 그리고 워커는 표식이 선 계정을 조회 **전에** 건너뛰므로 "조회 성공"으로 지워질 기회도 없다. 도달 경로는 자연스럽다 — 401을 받은 그 순간 그 계정이 스토어에 없으면 지문이 `None`이고, 로그아웃(=토큰 해지) 직후가 바로 그 판이다 | 지문 없는 표식은 **크리덴셜이 다시 읽히는 순간 무효**다. 근거가 "그때 크리덴셜을 못 읽었다"뿐이라, 읽히면 아는 게 없어진다 |
//! | G5 | 지문 = 크리덴셜 **원문 전체**의 sha256 | CLI가 턴 중에 액세스 토큰만 리프레시해도 지문이 달라져 격리가 스스로 풀린다. 401로 선 표식은 리프레시가 계속 성공하므로 *격리 → 해제 → 401 → 격리*를 돈다 | 지문은 **refresh 토큰**만 잡는다. 죽는 것도 재로그인으로 갈리는 것도 그 토큰이다 |
//!
//! 그리고 스토어에 아예 없는 계정의 표식은 뜻이 없다 — 읽는 김에 치운다.

use serde_json::{json, Map, Value};

pub const FILE: &str = "account-health.json";

#[derive(Debug, Clone, PartialEq)]
pub struct Record {
    /// 재로그인이 필요해 보인다 — 자동 전환 후보에서 뺀다.
    pub needs_login: bool,
    /// 사람이 읽는 사유(로그·리포트용). 토큰 원문은 절대 안 들어간다.
    pub reason: String,
    /// 표식을 남긴 시각(unix ms).
    pub at_ms: f64,
    /// 그때 그 계정 크리덴셜의 지문. 달라지면 표식은 무효다.
    pub token_fp: Option<String>,
}

fn parse(v: &Value) -> Option<Record> {
    let o = v.as_object()?;
    Some(Record {
        needs_login: o.get("needsLogin").and_then(Value::as_bool).unwrap_or(false),
        reason: o.get("reason").and_then(Value::as_str).unwrap_or_default().to_string(),
        at_ms: o.get("at").and_then(Value::as_f64).unwrap_or(0.0),
        token_fp: o.get("tokenFp").and_then(Value::as_str).map(str::to_string),
    })
}

fn wire(r: &Record) -> Value {
    let mut m = Map::new();
    m.insert("needsLogin".into(), json!(r.needs_login));
    m.insert("reason".into(), json!(r.reason));
    m.insert("at".into(), crate::js_number(r.at_ms));
    if let Some(fp) = &r.token_fp {
        m.insert("tokenFp".into(), json!(fp));
    }
    Value::Object(m)
}

/// 장부 전체(이메일 → 표식). 파일이 없거나 깨졌으면 빈 장부다.
pub fn read_all() -> std::collections::BTreeMap<String, Record> {
    let Some(Value::Object(m)) = ccg_store::read_home_json(FILE) else { return Default::default() };
    m.iter().filter_map(|(k, v)| Some((k.clone(), parse(v)?))).collect()
}

fn write_all(m: &std::collections::BTreeMap<String, Record>) {
    let mut root = Map::new();
    for (k, v) in m {
        root.insert(k.clone(), wire(v));
    }
    if let Err(e) = ccg_store::write_home_file(FILE, &crate::to_json_2space(&Value::Object(root))) {
        eprintln!("[auth] {FILE} 저장 실패: {e}");
    }
}

fn update(f: impl FnOnce(&mut std::collections::BTreeMap<String, Record>)) {
    let _g = ccg_store::flock::take(FILE);
    let mut m = read_all();
    let before = m.clone();
    f(&mut m);
    if m != before {
        write_all(&m);
    }
}

/// 지금 이 계정 **refresh 토큰**의 지문(표식의 유효 범위를 정하는 값).
///
/// ★R4(G5) — R3는 크리덴셜 원문 전체를 해시했다. 그 원문에는 액세스 토큰과 `expiresAt`이
/// 들어 있어 CLI가 턴 중에 리프레시만 해도 지문이 갈렸고, 그러면 죽은 refresh를 문 계정의
/// 격리가 스스로 풀렸다(크리틱 C5). 표식이 말하는 것은 "이 **refresh 토큰**으로는 안 된다"
/// 이므로, 유효 범위도 그 토큰이어야 한다.
fn fingerprint(email: &str) -> Option<String> {
    crate::claude::refresh_token(email).map(|r| crate::token_fingerprint(&r))
}

/// **재로그인이 필요해 보인다**고 적는다(토큰 회전 실패 · 401/403).
pub fn mark_needs_login(email: &str, reason: &str) {
    let fp = fingerprint(email);
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0);
    update(|m| {
        m.insert(email.to_string(), Record { needs_login: true, reason: reason.to_string(), at_ms: at, token_fp: fp });
    });
}

/// 표식을 지운다 — 조회 성공(= 그 계정은 멀쩡하다)과 로그아웃·재로그인에서 부른다.
pub fn clear(email: &str) {
    update(|m| {
        m.remove(email);
    });
}

/// 이 계정이 재로그인 대기 상태인가. **근거가 낡았으면 표식을 스스로 버린다**
/// (격리가 감옥이 되면 안 된다 — 해제 경로가 없는 격리는 그냥 계정 삭제다).
///
/// 해제 조건 셋. 어느 하나라도 서면 표식은 그 자리에서 지워진다:
/// 1. 그 계정이 **스토어에 없다** — 사용자가 지운 계정에 대한 우리 기억은 뜻이 없다.
/// 2. 지문이 있는데 **달라졌다** — 사용자가 재로그인해 refresh 토큰이 갈렸다.
/// 3. ★R4(G2) 지문이 **없는데 크리덴셜이 다시 읽힌다** — 표식의 근거가 "그때 크리덴셜을
///    못 읽었다"였으므로, 읽히는 순간 그 근거가 사라진다. (R3는 이 자리가 없어서 401
///    직후 로그아웃 → 재로그인이라는 **자연스러운 처방**이 영구 격리를 만들었다.)
///
/// 네 번째 경로는 이 함수 밖에 있다 — 조회가 한 번이라도 성공하면 [`clear`]다.
pub fn needs_login(email: &str) -> bool {
    let Some(r) = read_all().get(email).cloned() else { return false };
    if !r.needs_login {
        return false;
    }
    if !crate::claude::is_registered(email) {
        clear(email);
        return false;
    }
    match &r.token_fp {
        Some(_) if r.token_fp != fingerprint(email) => {
            clear(email);
            false
        }
        None if crate::claude::freshest_creds(email).is_some() => {
            eprintln!("[auth] {email} 격리 해제 — 지문 없이 선 표식인데 크리덴셜이 다시 읽힌다");
            clear(email);
            false
        }
        _ => true,
    }
}

/// 재로그인 대기 계정 전부(설정 화면·진단). [`needs_login`]과 같은 판정을 쓴다.
pub fn needs_login_emails() -> Vec<String> {
    read_all().keys().filter(|e| needs_login(e)).cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::temp_home;
    use serde_json::json;

    fn seed(email: &str, refresh: &str) {
        let creds = json!({ "claudeAiOauth": { "accessToken": format!("A-{email}"), "refreshToken": refresh, "expiresAt": 4_000_000_000_000f64 } }).to_string();
        let snap = json!({ "creds": creds, "account": { "emailAddress": email } });
        let enc = ccg_store::safe_storage::encrypt(&snap.to_string()).expect("safeStorage");
        let mut accounts: Vec<Value> = crate::claude::read_store_file().accounts.clone();
        accounts.retain(|a| crate::claude::email_of(a) != Some(email));
        accounts.push(json!({ "email": email, "credEnc": enc }));
        crate::claude::write_store_file(&accounts, Some(email)).expect("스토어 저장");
    }

    /// ★F2 — 표식은 남고, **재로그인하면 스스로 풀린다**.
    #[test]
    fn a_mark_survives_restarts_and_dissolves_on_re_login() {
        let h = temp_home("health");
        seed("dead@x", "r-dead");
        assert!(!needs_login("dead@x"), "기본은 건강이다");

        mark_needs_login("dead@x", "회전 실패");
        assert!(needs_login("dead@x"));
        assert_eq!(needs_login_emails(), vec!["dead@x".to_string()]);
        // 파일에 남는다 = 앱을 껐다 켜도 같은 답이다(디스크가 단일 소스).
        assert!(h.read(FILE).is_some_and(|s| s.contains("needsLogin")));

        // 같은 토큰으로 다시 물어도 여전히 아프다.
        assert!(needs_login("dead@x"));
        // 사용자가 재로그인했다 = 크리덴셜 지문이 바뀐다 → 표식은 무효.
        seed("dead@x", "r-fresh-after-login");
        assert!(!needs_login("dead@x"), "★ 재로그인해도 격리가 안 풀리면 그 계정은 영영 후보가 아니다");
        assert!(read_all().is_empty(), "무효 표식은 자기가 치운다");

        // 조회 성공 경로의 복구
        mark_needs_login("dead@x", "401");
        clear("dead@x");
        assert!(!needs_login("dead@x"));
        drop(h);
    }
}
