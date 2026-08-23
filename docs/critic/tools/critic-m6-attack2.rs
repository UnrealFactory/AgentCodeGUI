//! M6 크리틱 2차 — 휴지통 의미론 · UNC 블랙홀 · 잠긴 파일 discard · 32MB blob 거짓말.
use ccg_fs::{file, git, serve};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

fn out(k: &str, v: serde_json::Value) {
    println!("@@{}\t{}", k, serde_json::to_string(&v).unwrap());
}

fn g(cwd: &Path, args: &[&str]) -> (bool, String, String) {
    match Command::new("git").arg("-C").arg(cwd).args(args).output() {
        Ok(o) => (o.status.success(), String::from_utf8_lossy(&o.stdout).into_owned(), String::from_utf8_lossy(&o.stderr).into_owned()),
        Err(e) => (false, String::new(), e.to_string()),
    }
}
fn init_repo(p: &Path) {
    std::fs::create_dir_all(p).unwrap();
    g(p, &["init", "-q", "-b", "main"]);
    g(p, &["config", "user.name", "Critic"]);
    g(p, &["config", "user.email", "critic@example.com"]);
}

fn recycle_count() -> i64 {
    Command::new("powershell")
        .args(["-NoProfile", "-Command", "@((New-Object -ComObject Shell.Application).NameSpace(10).Items()).Count"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<i64>().ok())
        .unwrap_or(-1)
}

fn main() {
    let b: PathBuf = std::env::temp_dir().join("ccg-m6-atk2");
    let _ = std::fs::remove_dir_all(&b);
    std::fs::create_dir_all(&b).unwrap();

    // ══ 1. subst 드라이브(휴지통 없음)에서 delete_path가 무엇을 하나 ══════════
    // Windows 문서: subst/네트워크/이동식 볼륨에는 휴지통이 없다. SHFileOperationW는
    // FOF_ALLOWUNDO여도 그 경우 **영구 삭제**한다(FOF_WANTNUKEWARNING이 없으면 조용히).
    {
        let x = Path::new("X:\\");
        let mut cases = serde_json::Map::new();
        if x.exists() {
            let f = x.join("nuke-me.txt");
            std::fs::write(&f, "이 파일이 휴지통에 가야 한다\n").unwrap();
            let before = recycle_count();
            let r = file::delete_path("", f.to_str().unwrap());
            std::thread::sleep(std::time::Duration::from_millis(500));
            let after = recycle_count();
            cases.insert("subst".into(), serde_json::json!({
                "op_ok": r.ok, "op_err": r.error,
                "file_gone": !f.exists(),
                "recycle_before": before, "recycle_after": after,
                "went_to_recycle_bin": after > before
            }));
        } else {
            cases.insert("subst".into(), serde_json::json!({ "skipped": "X: 없음" }));
        }
        // 대조군: 보통 볼륨(C:)
        let f2 = b.join("normal.txt");
        std::fs::write(&f2, "normal\n").unwrap();
        let before = recycle_count();
        let r2 = file::delete_path("", f2.to_str().unwrap());
        std::thread::sleep(std::time::Duration::from_millis(500));
        let after = recycle_count();
        cases.insert("normal_c".into(), serde_json::json!({
            "op_ok": r2.ok, "file_gone": !f2.exists(),
            "recycle_before": before, "recycle_after": after, "went_to_recycle_bin": after > before
        }));
        out("trash_semantics_rust", serde_json::Value::Object(cases));
    }

    // ══ 2. ccg-img — 존재하지 않는 호스트의 UNC 경로(동기 핸들러가 UI 스레드를 먹나) ══
    {
        let t = Instant::now();
        let r = serve::image_response("http://ccg-img.localhost/%5C%5C10.255.255.1%5Cshare%5Ca.png");
        let ms = t.elapsed().as_millis();
        let t2 = Instant::now();
        let r2 = serve::image_response("http://ccg-img.localhost/%5C%5Cno-such-host-ccg%5Cs%5Ca.png");
        let ms2 = t2.elapsed().as_millis();
        out("ccg_img_unc_blackhole", serde_json::json!({
            "blackhole_ip_ms": ms, "served": r.is_some(),
            "bad_name_ms": ms2, "served2": r2.is_some()
        }));
    }

    // ══ 3. 잠긴/읽기전용 추적 파일에 discard — checkout 실패 → rm --cached 성공 → 삭제? ══
    {
        let r = b.join("locked-discard");
        init_repo(&r);
        std::fs::write(r.join("locked.txt"), "HEAD 내용\n").unwrap();
        g(&r, &["add", "-A"]);
        g(&r, &["commit", "-qm", "c1"]);
        std::fs::write(r.join("locked.txt"), "사용자가 고친 내용\n").unwrap();

        // 다른 프로세스가 배타적으로 연 상태를 흉내 (공유 없음)
        #[cfg(windows)]
        let _guard = {
            use std::os::windows::fs::OpenOptionsExt;
            std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .share_mode(0) // FILE_SHARE_NONE — git이 못 연다
                .open(r.join("locked.txt"))
                .ok()
        };
        let co = g(&r, &["checkout", "HEAD", "--", "locked.txt"]);
        let d = git::discard(r.to_str().unwrap(), "locked.txt", false);
        let exists = r.join("locked.txt").exists();
        let in_index = g(&r, &["show", ":locked.txt"]).0;
        let st = git::status(r.to_str().unwrap());
        out("discard_on_locked_file", serde_json::json!({
            "raw_checkout_ok": co.0, "raw_checkout_err": co.2.lines().next().unwrap_or(""),
            "discard_ok": d.ok, "discard_err": d.error,
            "file_still_exists": exists, "still_in_index": in_index,
            "status_after": st.files.iter().map(|f| format!("{}:{}", f.status, f.path)).collect::<Vec<_>>()
        }));
    }

    // ══ 4. 32MB stdout 캡 — HEAD blob만 거대할 때 diff가 무슨 말을 하나 ═══════
    {
        let r = b.join("bigblob2");
        init_repo(&r);
        let big: String = "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEFxx\n".repeat(700_000); // ~35MB
        std::fs::write(r.join("huge.txt"), &big).unwrap();
        g(&r, &["add", "-A"]);
        g(&r, &["commit", "-qm", "big"]);
        // ① 워킹트리를 아주 작게 (사용자가 파일을 비웠다)
        std::fs::write(r.join("huge.txt"), "남은 한 줄\n").unwrap();
        let d1 = git::file_diff(r.to_str().unwrap(), "huge.txt");
        // ② 파일을 지웠다 — head_content(되돌리기 전에 뭘 잃는지)가 나오나
        std::fs::remove_file(r.join("huge.txt")).unwrap();
        let d2 = git::file_diff(r.to_str().unwrap(), "huge.txt");
        out("bigblob_diff_truth", serde_json::json!({
            "shrunk_err": d1.error, "shrunk_tag": d1.diff.as_ref().map(|x| x.tag),
            "shrunk_add": d1.diff.as_ref().map(|x| x.add), "shrunk_del": d1.diff.as_ref().map(|x| x.del),
            "deleted_err": d2.error, "deleted_tag": d2.diff.as_ref().map(|x| x.tag),
            "deleted_add": d2.diff.as_ref().map(|x| x.add), "deleted_del": d2.diff.as_ref().map(|x| x.del),
            "deleted_head_content": d2.head_content.is_some()
        }));
    }

    // ══ 5. 정션이 탐색기에서 폴더로 보이나 (Node dirent와의 대조는 JS 쪽) ══════
    {
        let j = b.join("junc");
        std::fs::create_dir_all(j.join("target")).unwrap();
        std::fs::write(j.join("target").join("in.txt"), "x").unwrap();
        let _ = Command::new("cmd")
            .args(["/c", "mklink", "/J", j.join("link").to_str().unwrap(), j.join("target").to_str().unwrap()])
            .output();
        let rows = ccg_fs::dir::list_dir(j.to_str().unwrap(), "", &ccg_fs::dir::ListOpts::default());
        let into = ccg_fs::dir::list_dir(j.to_str().unwrap(), "link", &ccg_fs::dir::ListOpts::default());
        let ment = ccg_fs::dir::list_project_files(j.to_str().unwrap());
        out("junction_as_folder", serde_json::json!({
            "rows": rows.iter().map(|e| serde_json::json!({"name": e.name, "dir": e.dir})).collect::<Vec<_>>(),
            "expand_link_rows": into.iter().map(|e| e.name.clone()).collect::<Vec<_>>(),
            "mention": ment
        }));
    }

    let _ = Command::new("cmd").args(["/c", "rmdir", "/S", "/Q", b.to_str().unwrap()]).output();
    out("cleanup2", serde_json::json!({ "gone": !b.exists() }));
}
