//! 실홈 검증 — 사용자의 진짜 `~/.agentcodegui`가 재로그인 없이 넘어오는가.
//!
//! 규약:
//! - **원본은 읽기만** 한다. 파일을 임시 홈(`CCG_HOME`)으로 복사하고, 쓰기는 전부 사본에만.
//! - **네트워크 호출 없음**(크레이트에 전송 계층이 없다). 토큰 해지·usage 조회는 조립까지만.
//! - 2.6.2가 없는 머신에서는 조용히 통과한다(`return`) — CI가 아니라 **이 머신의 실측**이 목적.
//!
//! 실측 수치는 `docs/m5-report-r1.md`에 표로 남는다.

use crate::claude;
use crate::testkit::temp_home;
use serde_json::Value;

/// 실홈 `accounts.json`(v3)을 읽고 **그대로 되쓰면 바이트가 같은가.**
/// 같아야 3.0이 저장한 파일을 2.6.2가 그대로 읽는다(= 롤백 경로가 살아 있다).
#[test]
fn real_accounts_v3_round_trips_byte_for_byte() {
    let h = temp_home("real-v3");
    if !h.copy_real("accounts.json") {
        return;
    }
    let before = h.read("accounts.json").unwrap();
    let f = claude::read_store_file();
    assert_eq!(f.version, 3, "실홈은 v3여야 한다");
    assert!(!f.accounts.is_empty(), "계정이 0개로 읽히면 사용자는 재로그인 화면을 본다");
    assert!(f.default_email.is_some(), "기본 계정이 사라지면 미지정 채팅이 실행되지 않는다");

    claude::write_store_file(&f.accounts, f.default_email.as_deref());
    let after = h.read("accounts.json").unwrap();
    assert_eq!(after, before, "왕복이 바이트 동일하지 않으면 2.6.2로 되돌릴 수 없다");
}

/// 실홈 v2 백업(`accounts.json.bak-v2`)을 v3로 승격해도 **계정 블록은 한 바이트도 안 바뀐다.**
#[test]
fn real_v2_backup_promotes_to_v3_without_touching_the_records() {
    let h = temp_home("real-v2");
    if !h.copy_real("accounts.json.bak-v2") {
        return;
    }
    let raw = h.read("accounts.json.bak-v2").unwrap();
    std::fs::rename(h.path("accounts.json.bak-v2"), h.path("accounts.json")).unwrap();
    let f = claude::read_store_file();
    assert_eq!(f.version, 2);
    assert!(f.default_email.is_none(), "v2에는 defaultEmail이 없다");
    let n = f.accounts.len();
    assert!(n > 0);

    claude::write_store_file(&f.accounts, f.default_email.as_deref());
    let out = h.read("accounts.json").unwrap();
    assert!(out.starts_with("{\n  \"version\": 3,\n  \"defaultEmail\": "), "v3 승격 + 기본 계정 채움: {}", &out[..60.min(out.len())]);
    // 계정 배열은 원본과 **같은 바이트**로 남아야 한다(암호화 블롭 재작성 없음)
    let block = |s: &str| s[s.find("\"accounts\": [").expect("accounts 블록")..].trim_end().trim_end_matches('}').trim_end().to_string();
    assert_eq!(block(&out), block(&raw), "credEnc를 다시 암호화하면 토큰이 바뀐 것처럼 보인다");
    assert_eq!(claude::read_store_file().accounts.len(), n);
}

/// 실홈 계정의 `credEnc`(v10 = Local State의 OSCrypt 키로 AES-256-GCM)를 **실제로 푼다.**
/// 이게 안 되면 3.0은 계정 목록만 보여주고 실행에서 죽는다 = 재로그인.
#[test]
fn real_credentials_decrypt_and_carry_a_usable_token() {
    let h = temp_home("real-decrypt");
    if !h.copy_real("accounts.json") {
        return;
    }
    if !h.copy_oscrypt_key() {
        return; // 2.6.2 미설치 머신 — 풀 키가 없다
    }
    assert_eq!(ccg_store::safe_storage::write_scheme(), "v10", "설치본 키가 있으면 v10 스킴이어야 한다");

    let d = claude::diagnose();
    let total = d.len();
    let decrypted = d.iter().filter(|a| a.decrypted).count();
    let with_token = d.iter().filter(|a| a.snapshot_ok).count();
    // 지금 이 순간 만료 전인 액세스 토큰(= 한도 조회가 곧바로 되는 계정). 임시 홈에는
    // 계정 폴더가 없으므로 이 값은 **백업 스냅샷만** 본 결과다.
    let live = d.iter().filter(|a| claude::account_access_token(&a.email).is_some()).count();
    assert!(d.iter().all(|a| !a.dir_present), "격리 홈에는 계정 폴더가 없어야 한다(실홈을 안 봤다는 증거)");
    println!("[m5] 실홈 계정 {total}건 — 복호 {decrypted} / 스냅샷 온전 {with_token} / 백업 토큰 미만료 {live}");
    for a in &d {
        println!(
            "[m5]   {} sub={:?} default={} fp={:?} exp={} collides={:?}",
            crate::token_fingerprint(&a.email), // 이메일도 지문으로 — 로그에 계정이 노출되지 않게
            a.subscription_type,
            a.is_default,
            a.backup_fp,
            a.backup_expires_at,
            a.collides_with.as_ref().map(|e| crate::token_fingerprint(e))
        );
    }
    assert_eq!(decrypted, total, "한 건이라도 못 풀면 그 계정은 재로그인이다");
    assert_eq!(with_token, total, "토큰+신원이 다 있어야 CONFIG_DIR을 물질화할 수 있다");
    assert!(d.iter().all(|a| a.collides_with.is_none()), "스냅샷 오염(같은 토큰이 두 이메일)이 있으면 전환이 되돌아간다");

    // 지문이 계정마다 달라야 한다 = 서로 다른 토큰이다
    let mut fps: Vec<&String> = d.iter().filter_map(|a| a.backup_fp.as_ref()).collect();
    fps.sort();
    let uniq = fps.len();
    fps.dedup();
    assert_eq!(fps.len(), uniq, "토큰 지문이 겹치면 오염이다");
}

/// 되싱크(`sync_account_tokens`)는 스냅샷을 **다시 암호화**한다. 그 결과가 2.6.2가 읽는
/// 모양(`v10` = OSCrypt AES-256-GCM)이 아니면, 3.0으로 한 번 돌린 뒤 2.6.2로 되돌아갔을 때
/// 계정이 통째로 죽는다(★R2 D6에서 api-config로 한 번 밟은 함정과 같은 계열).
#[test]
fn re_encrypting_a_real_snapshot_stays_in_the_v10_scheme() {
    let h = temp_home("real-reencrypt");
    if !h.copy_real("accounts.json") || !h.copy_oscrypt_key() {
        return;
    }
    let f = claude::read_store_file();
    let Some(a) = f.accounts.first() else { return };
    let enc = claude::cred_enc_of(a).unwrap();
    let plain = ccg_store::safe_storage::decrypt(enc).expect("실홈 credEnc 복호");
    let again = ccg_store::safe_storage::encrypt(&plain).expect("재암호화");
    assert!(
        ccg_store::safe_storage::b64_decode(&again).unwrap().starts_with(b"v10"),
        "v10이 아니면 2.6.2 safeStorage가 'Ciphertext does not appear to be encrypted.'로 거부한다"
    );
    assert_eq!(ccg_store::safe_storage::decrypt(&again).as_deref(), Some(plain.as_str()));
    // 스냅샷 알맹이의 모양도 2.6.2가 기대하는 그대로여야 한다
    let snap = claude::Snapshot::parse(&plain);
    assert!(snap.creds().is_some() && snap.account().is_some());
    println!("[m5] 재암호화 스킴 {} — 실홈 credEnc {}B → {}B", ccg_store::safe_storage::write_scheme(), enc.len(), again.len());
}

/// 실홈 계정 **1건**을 격리 홈에 물질화해 구조를 검증한다. 실홈에는 아무것도 안 쓴다.
#[test]
fn real_account_materializes_into_an_isolated_config_dir() {
    let h = temp_home("real-materialize");
    if !h.copy_real("accounts.json") || !h.copy_oscrypt_key() {
        return;
    }
    let f = claude::read_store_file();
    let Some(email) = f.accounts.first().and_then(claude::email_of).map(str::to_string) else { return };

    let dir = claude::account_run_dir(&email).expect("실홈 스냅샷으로 물질화");
    // ① 격리: 만들어진 폴더도, 정션이 가리키는 공유 원본도 전부 임시 홈 안이어야 한다
    assert!(dir.starts_with(&h.dir), "실홈 밖에서 돌아야 한다: {dir:?}");
    // ② 토큰 — CLI가 이 파일 하나로 그 계정을 인식한다
    let creds = std::fs::read_to_string(dir.join(".credentials.json")).unwrap();
    let v: Value = serde_json::from_str(&creds).unwrap();
    assert!(v["claudeAiOauth"]["accessToken"].is_string(), "액세스 토큰 없이는 로그인 상태가 아니다");
    assert!(v["claudeAiOauth"]["refreshToken"].is_string());
    // ③ 신원 — 토큰만 넣으면 CLI가 토큰 주인으로 자가 교정한다("계정이 되돌아감")
    let cj: Value = serde_json::from_str(&std::fs::read_to_string(dir.join(".claude.json")).unwrap()).unwrap();
    assert_eq!(cj["oauthAccount"]["emailAddress"].as_str(), Some(email.as_str()));
    assert_eq!(cj["hasCompletedOnboarding"], serde_json::json!(true));
    // ④ 공유 정션 — **projects가 정션이어야 resume이 산다**
    for name in claude::SHARED_DIRS {
        let p = dir.join(name);
        assert!(crate::junction::is_link(&p), "{name}이 정션이 아니다 — 세션 기록이 계정별로 갈라진다");
        let t = crate::junction::target_of(&p).unwrap();
        let t = t.to_string_lossy().trim_start_matches(r"\\?\").to_string();
        assert!(t.starts_with(&h.dir.to_string_lossy().to_string()), "정션이 실홈을 가리키면 테스트가 사용자 데이터를 만진다: {t}");
    }
    println!("[m5] 물질화 검증 — 폴더 {:?}, 정션 {}개", dir.file_name().unwrap(), claude::SHARED_DIRS.len());

    // ⑤ 되싱크 가드 — 실행 뒤 폴더가 더 신선할 때만 백업이 따라온다
    let before = h.read("accounts.json").unwrap();
    assert!(!claude::sync_account_tokens(&email), "물질화 직후엔 폴더와 백업이 같아 되싱크할 게 없다");
    assert_eq!(h.read("accounts.json").unwrap(), before, "되싱크가 없으면 파일도 안 건드린다");
}

/// 물질화는 CLI가 쓰는 `.claude.json`에 **신원만 얹고 나머지는 보존**한다. serde가 그 파일을
/// 다시 쓸 때 모양이 흔들리면(숫자 표기·키 순서) CLI 상태가 매번 재작성돼 diff가 시끄러워지고,
/// 최악엔 CLI가 못 읽는다. 실홈의 6개 파일로 확인한다 — **읽기만** 한다.
#[test]
fn real_claude_json_files_reserialize_byte_for_byte() {
    let Some(real) = crate::testkit::real_home() else { return };
    let Ok(entries) = std::fs::read_dir(real.join("accounts")) else { return };
    let mut checked = 0;
    for e in entries.flatten() {
        let p = e.path().join(".claude.json");
        let Ok(raw) = std::fs::read_to_string(&p) else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&raw) else { panic!("{p:?}를 파싱조차 못 한다") };
        assert_eq!(crate::to_json_2space(&v), raw, "{p:?} 재직렬화가 2.6.2 출력과 어긋난다");
        checked += 1;
    }
    println!("[m5] 실홈 .claude.json {checked}개 재직렬화 바이트 동일");
    assert!(checked > 0);
}

/// 실홈 `codex-accounts.json`(v1) 왕복.
#[test]
fn real_codex_store_round_trips() {
    let h = temp_home("real-codex");
    if !h.copy_real("codex-accounts.json") {
        return;
    }
    let before = h.read("codex-accounts.json").unwrap();
    let f = crate::codex::read_store_file();
    assert_eq!(f.version, 1);
    crate::codex::write_store_file(&f.accounts, f.default_email.as_deref());
    assert_eq!(h.read("codex-accounts.json").unwrap(), before);
    println!("[m5] 실홈 codex 계정 {}건", f.accounts.len());
}

/// 실홈의 **물질화된 계정 폴더**(`~/.agentcodegui/accounts/<slug>`)를 읽기만 해서,
/// 슬러그 규칙과 정션 구조가 우리 구현과 일치하는지 확인한다.
#[test]
fn real_account_folders_match_our_slug_and_junction_rules() {
    let h = temp_home("real-folders");
    if !h.copy_real("accounts.json") {
        return;
    }
    let Some(real) = crate::testkit::real_home() else { return };
    let f = claude::read_store_file();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as f64;
    let (mut matched, mut junctions, mut live, mut fresher_than_backup) = (0, 0, 0, 0);
    for a in &f.accounts {
        let Some(email) = claude::email_of(a) else { continue };
        let dir = real.join("accounts").join(crate::account_slug(email));
        if !dir.is_dir() {
            continue;
        }
        matched += 1;
        let creds = std::fs::read_to_string(dir.join(".credentials.json")).ok();
        assert!(creds.is_some(), "2.6.2가 만든 폴더에 토큰이 있어야 한다");
        let exp = claude::creds_expires_at(creds.as_deref());
        if exp > now {
            live += 1;
        }
        // 폴더가 백업보다 신선하다 = 2.6.2가 CLI 리프레시를 아직 백업에 안 접었다
        // (3.0의 sync_account_tokens가 실행 뒤 접어 넣을 몫)
        let backup = claude::freshest_creds(email); // 임시 홈 기준이라 백업만 본다
        if exp > claude::creds_expires_at(backup.as_deref()) {
            fresher_than_backup += 1;
        }
        for name in claude::SHARED_DIRS {
            if crate::junction::is_link(&dir.join(name)) {
                junctions += 1;
            }
        }
    }
    // **슬러그 드리프트 판정은 폴더 쪽에서 한다.** "등록 계정 전부에 폴더가 있다"를 단정하면
    // 사용자가 계정을 추가만 하고 아직 안 쓴 순간 **선의의 실패**로 빨개진다(M5 R1 크리틱 §4-5).
    // 진짜 위험은 "그 계정의 폴더가 **다른 이름으로** 이미 있다"는 것 — 그러면 3.0이 새 폴더를
    // 파고 사용자는 재로그인한다. 그건 폴더의 신원(`.claude.json`)으로 정확히 잡힌다.
    let mut checked = 0;
    if let Ok(rd) = std::fs::read_dir(real.join("accounts")) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !e.path().is_dir() {
                continue;
            }
            let Some(cj) = crate::read_json_file(&e.path().join(".claude.json")) else { continue };
            let Some(email) = cj.get("oauthAccount").and_then(|o| o.get("emailAddress")).and_then(|v| v.as_str()) else { continue };
            checked += 1;
            assert_eq!(crate::account_slug(email), name, "폴더 신원과 우리 슬러그가 어긋난다 — 3.0이 새 폴더를 판다");
        }
    }
    println!(
        "[m5] 실홈 계정 폴더: 신원 대조 {checked}건 전부 슬러그 일치 · 등록 계정 중 폴더 있음 {matched}/{} — 살아 있는 정션 {junctions}개 / 폴더 토큰 미만료 {live} / 백업보다 신선 {fresher_than_backup}",
        f.accounts.len()
    );
    assert!(checked > 0 || matched == 0, "폴더가 있는데 한 건도 대조를 못 했다 — 신원 레이아웃이 바뀐 것");
    assert!(junctions > 0 || matched == 0, "정션이 하나도 없으면 resume 공유가 끊긴 상태다");
}
