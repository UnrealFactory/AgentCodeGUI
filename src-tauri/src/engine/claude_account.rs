//! ★SLUG R1 — **계정 이메일 → 격리 `CLAUDE_CONFIG_DIR`**. Claude 축의 리졸버 배선.
//!
//! Codex 축에는 이 고리가 처음부터 있었다(`codex_versions::resolver()` →
//! `ccg_engine::codex::driver::HomeResolver`). Claude 축에만 없어서, 엔진이 **폴더 이름을
//! 스스로 추측**했다 — `@`→`_`·`+`→`-` 두 치환으로 슬러그를 만들고 `accounts/`를 접두로
//! 훑었다. 실물 이름을 만드는 것은 [`ccg_auth::account_slug`]인데, 그 규칙은
//!
//!   소문자화 → `[a-z0-9._-]` 밖은 `_`(연속 접힘) → **항상 `-<base36(u32 해시)>` 접미**
//!
//! 라서 접미사를 모르는 추측은 **정상 이메일에서도 전부 빗나갔다**. 그리고 빗나가면 옛
//! 코드는 존재하지 않는 경로를 **조용히** 돌려줬고, 그 경로가 그대로 CLI에 나가 CLI가
//! 거기에 빈 폴더를 파고 "Not logged in"으로 죽었다. 그 빈 폴더는 다음 실행부터 정확
//! 일치로 먼저 잡혀 **영구화**됐다(자가영속 오염).
//!
//! 그래서 이름 짓는 일은 **아는 쪽**(`ccg-auth`)에만 둔다. 이 모듈은 그 함수를 엔진에
//! 꽂는 어댑터 한 겹이고, 두 가지를 더 한다:
//!
//!  1. [`ccg_auth::claude::account_run_dir`]는 폴더를 **물질화**한다(`.credentials.json` ·
//!     `.claude.json` 병합 · 공용 상태 정션). 옛 경로는 이 함수를 **한 번도 안 불렀다**.
//!  2. 실패는 **사유가 있는 실패**로 넘긴다([`why`]). 엔진은 그것을 받아 그 턴을 오류로
//!     정착시킨다 — 없는 경로를 대신 내보내지 않는다(M-LOGIC: 침묵 no-op 금지).

use std::sync::Arc;

/// `AuthError` → 사용자가 읽을 한 줄. 영어 `Display`는 진단용이라 그대로 쓰지 않는다.
/// 문장은 **다음 행동**을 담는다(설정 어디로 가야 하는가).
fn why(e: &ccg_auth::AuthError) -> String {
    use ccg_auth::AuthError as E;
    match e {
        E::NotRegistered(_) => "설정 ▸ Account에 등록된 계정이 아니에요(로그인이 필요해요)".into(),
        E::Undecryptable(_) => {
            "저장된 자격증명을 풀지 못했어요 — 다른 사용자·다른 PC의 홈을 옮겨 온 경우예요(다시 로그인해 주세요)".into()
        }
        E::CorruptSnapshot(_) => "저장된 계정 정보가 깨졌어요(다시 로그인해 주세요)".into(),
        E::TokenCollision(other) => {
            format!("같은 토큰이 {other} 계정으로도 저장돼 있어요(한쪽을 로그아웃해 주세요)")
        }
        E::Io(m) => format!("계정 폴더를 준비하지 못했어요 ({m})"),
    }
}

/// 엔진에 꽂을 리졸버. `hub.rs`가 `ChatRuntime` 빌더 사슬에서 한 번 부른다.
pub fn resolver() -> ccg_engine::runtime::AccountResolver {
    Arc::new(|email: &str| ccg_auth::claude::account_run_dir(email).map_err(|e| why(&e)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 사유가 **문장으로** 나온다 — 엔진이 이 값을 그대로 화면에 싣는다.
    /// (등록 계정이 없는 격리 홈에서 도는 판정이라 실홈을 건드리지 않는다.)
    #[test]
    fn unregistered_account_returns_a_reason_not_a_path() {
        // ★R3(F5) 규약 — `CCG_HOME`을 만지는 테스트는 **공용 자물쇠**를 잡는다.
        let _home = super::super::testhome::take("slug-r1-resolver");

        let r = resolver();
        let out = r("nobody@example.invalid");
        assert!(out.is_err(), "미등록 계정에 경로를 내주면 안 된다: {out:?}");
        let msg = out.unwrap_err();
        assert!(
            msg.contains("Account"),
            "사유가 다음 행동을 담아야 한다: {msg}"
        );
    }

    /// 리졸버가 내는 폴더 이름은 **`ccg-auth`의 슬러그**다 — 엔진이 옛날에 조립하던
    /// 이름(`@`→`_`·`+`→`-`)이 아니다. 해시 접미가 붙는다는 사실이 여기서 못 박힌다.
    #[test]
    fn folder_name_comes_from_ccg_auth_not_from_a_guess() {
        for email in [
            "user@example.invalid",
            "A.B+tag@Example.invalid",
            "o'brien@ex.invalid",
            "한글@ex.invalid",
        ] {
            let real = ccg_auth::account_slug(email);
            let guess = old_guess(email);
            assert!(
                real.rsplit_once('-').is_some_and(|(_, h)| !h.is_empty()
                    && h.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())),
                "실물 이름은 언제나 `-<base36>` 접미로 끝난다: {real}"
            );
            assert_ne!(real, guess, "추측과 실물이 같을 수 없다: {email}");
        }
    }

    // ── (a)~(d) 회귀 못 ─────────────────────────────────────────────────────
    //
    // 옛 엔진(`Runtime::account_dir`)이 하던 일을 **그대로** 여기 남겨 두고(`old_guess`
    // + `old_scan`), 같은 픽스처에 리졸버와 나란히 세운다. 네 갈래 전부에서 옛 코드가
    // 무엇을 집었는지 · 지금 무엇을 집는지가 한 테이블에 남는다.

    /// 옛 엔진의 슬러그 조립 — 치환 두 개가 전부였다.
    fn old_guess(email: &str) -> String {
        email.replace('@', "_").replace('+', "-")
    }

    /// 옛 엔진의 접두 스캔. `read_dir` 순서에 답이 매달려 있었으므로, 여기서는
    /// **가능한 답 전부**를 돌려준다 — "복권"이라는 사실 자체를 못 박는다.
    fn old_scan(root: &std::path::Path, email: &str) -> Vec<String> {
        let slug = old_guess(email);
        let mut hits = vec![];
        if let Ok(rd) = std::fs::read_dir(root) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().to_string();
                if n == slug || n.starts_with(&format!("{slug}-")) {
                    hits.push(n);
                }
            }
        }
        hits
    }

    /// 합성 계정을 격리 홈에 심는다(`ccg-auth-probe seed`가 하는 것과 같은 모양 —
    /// 가짜 토큰 · 먼 미래 만료). **실계정도 네트워크도 안 쓴다.**
    fn seed(emails: &[&str]) {
        let accounts: Vec<serde_json::Value> = emails
            .iter()
            .map(|e| {
                let creds = serde_json::json!({ "claudeAiOauth": {
                    "accessToken": format!("synthetic-{e}"),
                    "refreshToken": format!("synthetic-refresh-{e}"),
                    "expiresAt": 4_000_000_000_000f64,
                    "scopes": ["user:inference"],
                }})
                .to_string();
                let snap = serde_json::json!({
                    "creds": creds,
                    "account": { "emailAddress": e, "uuid": format!("u-{e}") },
                });
                let enc = ccg_store::safe_storage::encrypt(&snap.to_string())
                    .expect("safeStorage 암호화 불가 — 합성 계정을 못 심는다");
                serde_json::json!({ "email": e, "credEnc": enc, "subscriptionType": "max" })
            })
            .collect();
        ccg_auth::claude::write_store_file(&accounts, emails.first().copied()).expect("스토어 쓰기");
    }

    fn litter(root: &std::path::Path, names: &[&str]) {
        for n in names {
            std::fs::create_dir_all(root.join(n)).unwrap();
        }
    }

    /// **(a) 자가영속 오염** — 실패 주행이 만든 빈 폴더가 실물 폴더 옆에 있어도,
    /// 리졸버는 실물을 집는다. 옛 스캔은 그 빈 폴더를 **정확 일치**로 먼저 집었고,
    /// 그래서 한 번 빗나가면 영원히 빗나갔다.
    #[test]
    fn a_poisoned_empty_folder_no_longer_wins_over_the_real_one() {
        let home = super::super::testhome::take("slug-r1-sticky");
        let email = "user@example.invalid";
        seed(&[email]);
        let root = home.dir.join("accounts");
        let real = ccg_auth::account_slug(email); // user_example.invalid-1sqbe9q
        // 옛 주행이 남긴 빈 폴더 + 진짜 폴더가 나란히 있다.
        litter(&root, &[&old_guess(email), &real]);

        let old = old_scan(&root, email);
        assert!(
            old.contains(&old_guess(email)) && old.len() == 2,
            "옛 스캔에는 후보가 둘이었고 오염 폴더가 **정확 일치**로 이겼다: {old:?}"
        );

        let got = resolver()(email).expect("등록 계정이다");
        assert_eq!(got, root.join(&real), "실물 폴더를 집어야 한다");
        assert!(
            got.join(".credentials.json").is_file(),
            "리졸버는 자격증명까지 **물질화**한다 — 옛 경로는 이 함수를 한 번도 안 불렀다"
        );
    }

    /// **(b) 자격증명 크로스오버** — 허용 밖 문자만 다른 두 계정은 `safe`가 같고
    /// 해시만 다르다. 옛 스캔은 해시를 안 봐서 `read_dir` 순서로 **남의 폴더**를 집을
    /// 수 있었다. 리졸버는 해시까지 같이 만들므로 섞일 수가 없다.
    #[test]
    fn b_two_accounts_that_share_a_safe_name_can_no_longer_cross_over() {
        let home = super::super::testhome::take("slug-r1-crossover");
        let (mine, theirs) = ("a_b@example.invalid", "a!b@example.invalid");
        seed(&[mine, theirs]);
        let root = home.dir.join("accounts");
        let (m, t) = (ccg_auth::account_slug(mine), ccg_auth::account_slug(theirs));
        assert_eq!(
            m.rsplit_once('-').unwrap().0,
            t.rsplit_once('-').unwrap().0,
            "두 계정의 safe 이름이 같다는 것이 이 시나리오의 전제다"
        );
        litter(&root, &[&m, &t]);

        assert_eq!(
            old_scan(&root, mine).len(),
            2,
            "옛 스캔은 두 폴더를 **구별하지 못했다**(순서 복권)"
        );

        assert_eq!(resolver()(mine).unwrap(), root.join(&m));
        assert_eq!(resolver()(theirs).unwrap(), root.join(&t));
    }

    /// **(c) 접두 그림자** — `eve@ex.invalid`를 찾는데 `eve@ex.invalid-corp.test`의
    /// 폴더가 `eve_ex.invalid-` 접두에 걸린다. 순서 무보장이라 남의 폴더가 이길 수 있었다.
    ///
    /// 픽스처를 **적대적으로** 골랐다: 두 폴더 이름은
    /// `eve_ex.invalid-corp.test-12ig38x` 와 `eve_ex.invalid-m1yb3c` 이고,
    /// `-` 뒤 첫 글자가 `c` < `m` 이라 이웃이 **먼저** 열거된다(NTFS는 이름순). 즉 이
    /// 판에서 옛 스캔은 "이길 수도 있다"가 아니라 **실제로 남의 폴더를 집는다**.
    /// (`bob@…`으로 잡으면 해시가 `3o2bl3`이라 우연히 실물이 먼저 와서 결함이 숨는다 —
    /// 그것이 "복권"이라는 말의 뜻이다.)
    #[test]
    fn c_a_longer_neighbour_no_longer_shadows_the_short_one() {
        let home = super::super::testhome::take("slug-r1-shadow");
        let (short, long) = ("eve@ex.invalid", "eve@ex.invalid-corp.test");
        seed(&[short, long]);
        let root = home.dir.join("accounts");
        let (s, l) = (ccg_auth::account_slug(short), ccg_auth::account_slug(long));
        litter(&root, &[&s, &l]);

        let old = old_scan(&root, short);
        assert!(old.contains(&l), "옛 스캔은 이웃의 폴더를 후보로 봤다: {old:?}");
        assert_eq!(
            old.first(),
            Some(&l),
            "이 픽스처에서는 이웃이 먼저 열거된다 — 옛 코드는 남의 폴더를 집었다: {old:?}"
        );

        assert_eq!(resolver()(short).unwrap(), root.join(&s));
        assert_eq!(resolver()(long).unwrap(), root.join(&l));
    }

    /// **(d) 대문자 · `+` 주소** — 옛 조립은 소문자화를 안 하고 `+`를 `-`로 바꿨다.
    /// 확정 미스였고, 미스는 (a)로 굳었다.
    #[test]
    fn d_uppercase_and_plus_addressing_resolve_exactly() {
        let home = super::super::testhome::take("slug-r1-plus");
        let email = "A.B+tag@Example.invalid";
        seed(&[email]);
        let root = home.dir.join("accounts");
        let real = ccg_auth::account_slug(email); // a.b_tag_example.invalid-hjlo1j
        litter(&root, &[&real]);

        assert_eq!(old_guess(email), "A.B-tag_Example.invalid");
        assert!(
            old_scan(&root, email).is_empty(),
            "옛 조립은 실물을 **한 번도** 못 맞혔다"
        );

        assert_eq!(resolver()(email).unwrap(), root.join(&real));
    }

    /// 스캔이 `file_type`을 안 봤다는 덤 — 같은 이름의 **파일**도 계정 폴더로 집혔다.
    /// 리졸버는 폴더를 **만들어서** 답하므로 파일이 답이 될 여지가 없다.
    #[test]
    fn a_file_named_like_a_slug_is_not_an_account_folder() {
        let home = super::super::testhome::take("slug-r1-file");
        let email = "user@example.invalid";
        seed(&[email]);
        let root = home.dir.join("accounts");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join(old_guess(email)), b"not a folder").unwrap();

        assert_eq!(
            old_scan(&root, email),
            vec![old_guess(email)],
            "옛 스캔은 파일도 집었다"
        );

        let got = resolver()(email).unwrap();
        assert!(got.is_dir(), "폴더여야 한다: {got:?}");
        assert_eq!(got, root.join(ccg_auth::account_slug(email)));
    }
}
