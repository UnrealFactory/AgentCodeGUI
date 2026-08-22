//! 정션 공격 — 격리 홈(CCG_HOME)에서만 돈다.
use ccg_auth::junction;
use std::path::PathBuf;

fn p(rel: &str) -> PathBuf {
    ccg_auth::app_home().join(rel)
}

fn main() {
    let home = std::env::var("CCG_HOME").expect("CCG_HOME 필수");
    println!("home={home}");
    let _ = std::fs::remove_dir_all(ccg_auth::app_home());
    std::fs::create_dir_all(ccg_auth::app_home()).unwrap();

    // ── A. remove_dir_all이 정션을 타고 원본을 지우는가(unlink 없이) ──────────
    {
        let target = p("A/shared/projects");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("SESSIONS.jsonl"), "the whole session history").unwrap();
        let acct = p("A/accounts/slug");
        std::fs::create_dir_all(&acct).unwrap();
        junction::create(&acct.join("projects"), &target).unwrap();
        // delete_account_dir이 unlink를 못 했다고 가정하고 바로 재귀 삭제
        let r = std::fs::remove_dir_all(&acct);
        println!(
            "A remove_dir_all(unlink 없이) = {:?} | 계정폴더 남음={} | 원본파일 남음={} | 원본폴더 남음={}",
            r.as_ref().map(|_| "ok").map_err(|e| e.kind()),
            acct.exists(),
            target.join("SESSIONS.jsonl").is_file(),
            target.is_dir()
        );
    }

    // ── B. SHARED_DIRS에 없는 **중첩** 정션(CLI가 판 것) + delete_account_dir ─
    {
        let target = p("B/shared/projects");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("keep.jsonl"), "x").unwrap();
        let acct = p("B/accounts/slug/nested");
        std::fs::create_dir_all(&acct).unwrap();
        junction::create(&acct.join("deep-link"), &target).unwrap();
        let r = std::fs::remove_dir_all(p("B/accounts/slug"));
        println!(
            "B 중첩 정션 remove_dir_all = {:?} | 원본파일 남음={}",
            r.as_ref().map(|_| "ok").map_err(|e| e.kind()),
            target.join("keep.jsonl").is_file()
        );
    }

    // ── C. 조상을 가리키는 정션(순환) ────────────────────────────────────────
    {
        let acct = p("C/accounts/slug");
        std::fs::create_dir_all(&acct).unwrap();
        std::fs::write(p("C/accounts/marker.txt"), "outside").unwrap();
        // slug/loop -> C/accounts  (자기 조상)
        let r = junction::create(&acct.join("loop"), &p("C/accounts"));
        println!("C 순환 정션 생성 = {:?}", r.as_ref().map(|_| "ok").map_err(|e| e.kind()));
        let rm = std::fs::remove_dir_all(&acct);
        println!(
            "C remove_dir_all(순환) = {:?} | 조상 marker 남음={} | slug 남음={}",
            rm.as_ref().map(|_| "ok").map_err(|e| e.kind()),
            p("C/accounts/marker.txt").is_file(),
            acct.exists()
        );
    }

    // ── D. 이미 실폴더가 있으면 그대로 둔다(2.6.2 규칙) ──────────────────────
    {
        std::env::set_var("CCG_HOME", p("D").to_string_lossy().to_string());
        let dir = ccg_auth::claude::account_dir("a@x.com");
        std::fs::create_dir_all(dir.join("projects")).unwrap();
        std::fs::write(dir.join("projects").join("local.jsonl"), "계정 안에 이미 쌓인 기록").unwrap();
        ccg_auth::claude::link_shared_state(&dir);
        println!(
            "D 실폴더 보존: projects는 링크인가={} | 내용 남음={} | sessions는 정션인가={}",
            junction::is_link(&dir.join("projects")),
            dir.join("projects").join("local.jsonl").is_file(),
            junction::is_link(&dir.join("sessions"))
        );
        std::env::set_var("CCG_HOME", &home);
    }

    // ── E. 대상이 없을 때 / 링크 자리에 파일이 있을 때 ───────────────────────
    {
        let e1 = junction::create(&p("E/link1"), &p("E/nope"));
        println!("E1 대상 없음 = {:?} | 반쪽 폴더 남음={}", e1.as_ref().map(|_| "ok").map_err(|e| e.kind()), p("E/link1").exists());
        std::fs::create_dir_all(p("E/t")).unwrap();
        std::fs::create_dir_all(p("E")).unwrap();
        std::fs::write(p("E/link2"), "occupied").unwrap();
        let e2 = junction::create(&p("E/link2"), &p("E/t"));
        println!("E2 자리 점유(파일) = {:?} | 파일 온전={}", e2.as_ref().map(|_| "ok").map_err(|e| e.kind()), std::fs::read_to_string(p("E/link2")).unwrap_or_default() == "occupied");
    }

    // ── F. 정션 대상이 다른 정션일 때(체인 평탄화) ───────────────────────────
    {
        std::fs::create_dir_all(p("F/real")).unwrap();
        std::fs::create_dir_all(p("F")).unwrap();
        junction::create(&p("F/mid"), &p("F/real")).unwrap();
        junction::create(&p("F/leaf"), &p("F/mid")).unwrap();
        println!("F 체인: leaf -> {:?}", junction::target_of(&p("F/leaf")));
    }

    // ── G. unlink가 실폴더를 지우지는 않는가 ────────────────────────────────
    {
        std::fs::create_dir_all(p("G/realdir")).unwrap();
        std::fs::write(p("G/realdir/x.txt"), "y").unwrap();
        let r = junction::unlink(&p("G/realdir"));
        println!("G unlink(실폴더) = {:?} | 내용 남음={}", r.as_ref().map(|_| "ok").map_err(|e| e.kind()), p("G/realdir/x.txt").is_file());
    }
}
