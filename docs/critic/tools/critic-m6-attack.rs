//! M6 R1 크리틱 공격 하네스 — ccg-fs를 직접 때린다(화면 없이 계약면만).
//! 실행: CARGO_TARGET_DIR=%TEMP%/ccg-m6-t2 cargo run -p ccg-fs --example critic_attack
//! 모든 산출물은 %TEMP%/ccg-m6-atk 안에서만 만들고 지운다.

use ccg_fs::{dir, file, git, serve};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

fn out(k: &str, v: serde_json::Value) {
    println!("@@{}\t{}", k, serde_json::to_string(&v).unwrap());
}

fn base() -> PathBuf {
    let d = std::env::temp_dir().join("ccg-m6-atk");
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn g(cwd: &Path, args: &[&str]) -> (bool, String, String) {
    let o = Command::new("git").arg("-C").arg(cwd).args(args).output();
    match o {
        Ok(o) => (
            o.status.success(),
            String::from_utf8_lossy(&o.stdout).into_owned(),
            String::from_utf8_lossy(&o.stderr).into_owned(),
        ),
        Err(e) => (false, String::new(), e.to_string()),
    }
}

fn init_repo(p: &Path) {
    std::fs::create_dir_all(p).unwrap();
    g(p, &["init", "-q", "-b", "main"]);
    g(p, &["config", "user.name", "Critic"]);
    g(p, &["config", "user.email", "critic@example.com"]);
    g(p, &["config", "commit.gpgsign", "false"]);
}

fn main() {
    let b = base();

    // ══ 1. 거대 디렉터리 — list_dir 시간 + 정렬 비용 ═══════════════════════════
    {
        let big = b.join("bigdir");
        std::fs::create_dir_all(&big).unwrap();
        for i in 0..50_000 {
            std::fs::write(big.join(format!("f{i:06}_한글{}.txt", i % 97)), b"x").unwrap();
        }
        let t = Instant::now();
        let v = dir::list_dir(big.to_str().unwrap(), "", &dir::ListOpts::default());
        let ms = t.elapsed().as_millis();
        out("bigdir_list", serde_json::json!({ "entries": v.len(), "ms": ms, "first": v.first().map(|e| e.name.clone()) }));
    }

    // ══ 2. 정션 순환 — list_project_files / list_dir / hide_empty 프루닝 ══════
    {
        let cyc = b.join("cycle");
        std::fs::create_dir_all(cyc.join("a")).unwrap();
        std::fs::write(cyc.join("a").join("real.txt"), b"x").unwrap();
        // a/loop -> cycle  (자기 조상으로 되돌아가는 정션)
        let st = Command::new("cmd")
            .args(["/c", "mklink", "/J", cyc.join("a").join("loop").to_str().unwrap(), cyc.to_str().unwrap()])
            .output();
        let made = st.map(|o| o.status.success()).unwrap_or(false);
        let t = Instant::now();
        let files = dir::list_project_files(cyc.to_str().unwrap());
        let ms1 = t.elapsed().as_millis();
        let listed = dir::list_dir(cyc.join("a").to_str().unwrap(), "", &dir::ListOpts::default());
        let t = Instant::now();
        let pruned = dir::list_dir(
            cyc.to_str().unwrap(),
            "",
            &dir::ListOpts { exclude: vec!["*.none".into()], hide_empty: true, ..Default::default() },
        );
        let ms2 = t.elapsed().as_millis();
        out(
            "junction_cycle",
            serde_json::json!({
                "junction_made": made,
                "mention_files": files.len(), "mention_ms": ms1, "sample": files.iter().take(6).collect::<Vec<_>>(),
                "list_a": listed.iter().map(|e| format!("{}{}", e.name, if e.dir {"/"} else {""})).collect::<Vec<_>>(),
                "hide_empty_rows": pruned.len(), "hide_empty_ms": ms2
            }),
        );
    }

    // ══ 3. 권한 없는 폴더 ════════════════════════════════════════════════════
    {
        let den = b.join("denied");
        std::fs::create_dir_all(den.join("sub")).unwrap();
        std::fs::write(den.join("sub").join("secret.txt"), b"x").unwrap();
        let who = std::env::var("USERNAME").unwrap_or_default();
        let r = Command::new("icacls")
            .args([den.join("sub").to_str().unwrap(), "/deny", &format!("{who}:(OI)(CI)(RX)")])
            .output();
        let denied = r.map(|o| o.status.success()).unwrap_or(false);
        let rows = dir::list_dir(den.to_str().unwrap(), "", &dir::ListOpts::default());
        let inner = dir::list_dir(den.to_str().unwrap(), "sub", &dir::ListOpts::default());
        let rd = file::read_file(den.to_str().unwrap(), "sub/secret.txt");
        let wr = file::write_file(den.to_str().unwrap(), "sub/secret.txt", "z");
        out(
            "no_permission",
            serde_json::json!({
                "denied_applied": denied,
                "parent_rows": rows.iter().map(|e| e.name.clone()).collect::<Vec<_>>(),
                "inner_rows": inner.len(),
                "read_err": rd.error, "write_ok": wr.ok, "write_err": wr.error
            }),
        );
        let _ = Command::new("icacls").args([den.join("sub").to_str().unwrap(), "/remove:d", &who]).output();
    }

    // ══ 4. 한글·이모지·긴 경로(>260) ═════════════════════════════════════════
    {
        let u = b.join("uni");
        std::fs::create_dir_all(&u).unwrap();
        let names = ["한글 파일.txt", "😀emoji✨.txt", "ＦＵＬＬ幅.txt", "café.txt", "a b  c.txt"];
        let mut made = vec![];
        for n in names {
            made.push((n, std::fs::write(u.join(n), "내용\n").is_ok()));
        }
        let rows = dir::list_dir(u.to_str().unwrap(), "", &dir::ListOpts::default());
        let rd = file::read_file(u.to_str().unwrap(), "한글 파일.txt");
        let rn = file::rename_path(u.to_str().unwrap(), "😀emoji✨.txt", "🎉바뀜.txt");
        let mention = dir::list_project_files(u.to_str().unwrap());

        // 긴 경로: 총 길이 > 260
        let mut deep = b.join("long");
        std::fs::create_dir_all(&deep).unwrap();
        let seg = "d".repeat(40);
        let mut mk_ok = true;
        for _ in 0..7 {
            deep = deep.join(&seg);
            if std::fs::create_dir(&deep).is_err() {
                mk_ok = false;
                break;
            }
        }
        let longfile = deep.join("긴이름파일.txt");
        let wlen = longfile.to_string_lossy().chars().count();
        let wrote = std::fs::write(&longfile, "long\n").is_ok();
        let lrd = file::read_file("", longfile.to_str().unwrap());
        let lrows = dir::list_dir(deep.to_str().unwrap(), "", &dir::ListOpts::default());
        let ldel = file::delete_path("", longfile.to_str().unwrap()); // 휴지통(SHFileOperationW) 상한 시험
        let still = longfile.exists();
        out(
            "unicode_and_longpath",
            serde_json::json!({
                "created": made,
                "rows": rows.iter().map(|e| e.name.clone()).collect::<Vec<_>>(),
                "read_ok": rd.content.is_some(), "rename_emoji_ok": rn.ok, "rename_err": rn.error,
                "mention": mention,
                "deep_mkdir_ok": mk_ok, "path_len": wlen, "long_write_ok": wrote,
                "long_read_ok": lrd.content.is_some(), "long_read_err": lrd.error,
                "long_listdir_rows": lrows.len(),
                "long_trash_ok": ldel.ok, "long_trash_err": ldel.error, "long_file_still_there": still
            }),
        );
    }

    // ══ 5. 동시 쓰기 경합 — rename 도중 read ══════════════════════════════════
    {
        let rc = b.join("race");
        std::fs::create_dir_all(&rc).unwrap();
        let p = rc.join("hot.txt");
        std::fs::write(&p, "A".repeat(200_000)).unwrap();
        let rc2 = rc.clone();
        let h = std::thread::spawn(move || {
            let mut renames = 0;
            let a = rc2.join("hot.txt");
            let bb = rc2.join("hot2.txt");
            for i in 0..400 {
                let (from, to) = if i % 2 == 0 { (&a, &bb) } else { (&bb, &a) };
                if std::fs::rename(from, to).is_ok() {
                    renames += 1;
                }
                std::thread::sleep(std::time::Duration::from_micros(200));
            }
            let _ = std::fs::rename(&bb, &a);
            renames
        });
        let mut ok = 0;
        let mut errs: std::collections::BTreeMap<String, u32> = Default::default();
        let mut short = 0;
        for _ in 0..400 {
            let r = file::read_file(rc.to_str().unwrap(), "hot.txt");
            match (r.content, r.error) {
                (Some(c), _) => {
                    ok += 1;
                    if c.len() != 200_000 {
                        short += 1;
                    }
                }
                (None, Some(e)) => *errs.entry(e).or_default() += 1,
                _ => {}
            }
            std::thread::sleep(std::time::Duration::from_micros(150));
        }
        let renames = h.join().unwrap_or(0);
        out("race_rename_read", serde_json::json!({ "renames": renames, "reads_ok": ok, "short_reads": short, "errors": errs }));
    }

    // ══ 6. git — detached / 빈 레포 / 서브모듈 / index.lock ═══════════════════
    {
        // 6a 빈 레포(커밋 0)
        let e = b.join("empty");
        init_repo(&e);
        let st = git::status(e.to_str().unwrap());
        let lg = git::log(e.to_str().unwrap(), 5, 0);
        let br = git::branches(e.to_str().unwrap());
        std::fs::write(e.join("new.txt"), "x\n").unwrap();
        let cm = git::commit(e.to_str().unwrap(), &["new.txt".into()], "첫 커밋 한글 제목 🎉", "본문\n둘째 줄");
        let subj = g(&e, &["log", "-1", "--pretty=%s"]).1.trim().to_string();
        let body = g(&e, &["log", "-1", "--pretty=%b"]).1.trim().to_string();
        // 커밋 실패 경로(빈 파일 목록)에서 reset이 무엇을 하나
        out(
            "git_empty_repo",
            serde_json::json!({
                "status_repo": st.repo, "branch": st.branch, "detached": st.detached, "files": st.files.len(),
                "log_commits": lg.commits.len(), "branches": br.len(),
                "commit_ok": cm.ok, "commit_err": cm.error, "subject_on_disk": subj, "body_on_disk": body
            }),
        );

        // 6b detached HEAD
        let d = b.join("detach");
        init_repo(&d);
        std::fs::write(d.join("a.txt"), "1\n").unwrap();
        g(&d, &["add", "-A"]);
        g(&d, &["commit", "-qm", "c1"]);
        std::fs::write(d.join("a.txt"), "2\n").unwrap();
        g(&d, &["add", "-A"]);
        g(&d, &["commit", "-qm", "c2"]);
        let h1 = g(&d, &["rev-parse", "HEAD~1"]).1.trim().to_string();
        g(&d, &["checkout", "-q", &h1]);
        let st = git::status(d.to_str().unwrap());
        let lg = git::log(d.to_str().unwrap(), 5, 0);
        out(
            "git_detached",
            serde_json::json!({ "branch": st.branch, "detached": st.detached, "ahead": st.ahead, "behind": st.behind,
                                "log": lg.commits.len(), "unpushed": lg.commits.iter().filter(|c| c.unpushed).count() }),
        );

        // 6c 서브모듈
        let sup = b.join("super");
        let sub = b.join("subsrc");
        init_repo(&sub);
        std::fs::write(sub.join("s.txt"), "sub\n").unwrap();
        g(&sub, &["add", "-A"]);
        g(&sub, &["commit", "-qm", "sub c1"]);
        init_repo(&sup);
        std::fs::write(sup.join("top.txt"), "top\n").unwrap();
        g(&sup, &["add", "-A"]);
        g(&sup, &["commit", "-qm", "top c1"]);
        let (aok, _, aerr) = g(&sup, &["-c", "protocol.file.allow=always", "submodule", "--quiet", "add", sub.to_str().unwrap(), "mod"]);
        g(&sup, &["commit", "-qm", "add submodule"]);
        std::fs::write(sup.join("mod").join("s.txt"), "sub changed\n").unwrap();
        let st = git::status(sup.to_str().unwrap());
        let repos = git::repos(sup.to_str().unwrap());
        let inner = git::status(sup.join("mod").to_str().unwrap());
        let fd = git::file_diff(sup.to_str().unwrap(), "mod");
        out(
            "git_submodule",
            serde_json::json!({
                "add_ok": aok, "add_err": aerr.lines().next().unwrap_or(""),
                "super_files": st.files.iter().map(|f| format!("{}:{}", f.status, f.path)).collect::<Vec<_>>(),
                "repos": repos.iter().map(|r| r.rel.clone()).collect::<Vec<_>>(),
                "inner_root_is_mod": inner.root.replace('\\',"/").ends_with("/mod"),
                "diff_on_submodule_err": fd.error, "diff_present": fd.diff.is_some()
            }),
        );

        // 6d index.lock
        let l = b.join("locked");
        init_repo(&l);
        std::fs::write(l.join("a.txt"), "1\n").unwrap();
        g(&l, &["add", "-A"]);
        g(&l, &["commit", "-qm", "c1"]);
        std::fs::write(l.join("a.txt"), "2\n").unwrap();
        std::fs::write(l.join("untracked.txt"), "u\n").unwrap();
        std::fs::write(l.join(".git").join("index.lock"), "").unwrap();
        let t = Instant::now();
        let st = git::status(l.to_str().unwrap());
        let sms = t.elapsed().as_millis();
        let cm = git::commit(l.to_str().unwrap(), &["a.txt".into()], "잠금 중 커밋", "");
        let ds = git::discard(l.to_str().unwrap(), "a.txt", false);
        let content_after = std::fs::read_to_string(l.join("a.txt")).unwrap_or_default();
        let _ = std::fs::remove_file(l.join(".git").join("index.lock"));
        out(
            "git_index_lock",
            serde_json::json!({
                "status_ok": st.repo, "status_files": st.files.len(), "status_ms": sms,
                "commit_ok": cm.ok, "commit_err": cm.error,
                "discard_ok": ds.ok, "discard_err": ds.error, "file_after_discard": content_after
            }),
        );
    }

    // ══ 7. discard 파괴 반경 ══════════════════════════════════════════════════
    {
        let r = b.join("discard");
        init_repo(&r);
        std::fs::create_dir_all(r.join("keep")).unwrap();
        std::fs::write(r.join("tracked.txt"), "orig\n").unwrap();
        std::fs::write(r.join("other.txt"), "other-orig\n").unwrap();
        std::fs::write(r.join("keep").join("deep.txt"), "deep-orig\n").unwrap();
        g(&r, &["add", "-A"]);
        g(&r, &["commit", "-qm", "c1"]);

        // ① 추적 파일: 워크트리 수정 + 인덱스에 다른 내용 스테이징
        std::fs::write(r.join("tracked.txt"), "staged\n").unwrap();
        g(&r, &["add", "tracked.txt"]);
        std::fs::write(r.join("tracked.txt"), "worktree\n").unwrap();
        // ② 다른 파일에 사용자가 따로 올려둔 스테이징(건드리면 안 됨)
        std::fs::write(r.join("other.txt"), "other-staged\n").unwrap();
        g(&r, &["add", "other.txt"]);
        // ③ 미추적 파일 + 미추적 폴더
        std::fs::write(r.join("untracked.txt"), "u\n").unwrap();
        std::fs::create_dir_all(r.join("newdir").join("nested")).unwrap();
        std::fs::write(r.join("newdir").join("a.txt"), "a\n").unwrap();
        std::fs::write(r.join("newdir").join("nested").join("b.txt"), "b\n").unwrap();
        // ④ 새로 add된(HEAD에 없는) 파일
        std::fs::write(r.join("added.txt"), "added\n").unwrap();
        g(&r, &["add", "added.txt"]);

        let before = git::status(r.to_str().unwrap());
        let d1 = git::discard(r.to_str().unwrap(), "tracked.txt", false);
        let after_tracked = std::fs::read_to_string(r.join("tracked.txt")).unwrap_or_default();
        let idx_tracked = g(&r, &["show", ":tracked.txt"]).1;
        let idx_other = g(&r, &["show", ":other.txt"]).1;
        let d2 = git::discard(r.to_str().unwrap(), "untracked.txt", true);
        let d3 = git::discard(r.to_str().unwrap(), "added.txt", false);
        let added_gone = !r.join("added.txt").exists();
        let idx_added = g(&r, &["show", ":added.txt"]).0;
        // 미추적 폴더 통째로
        let d4 = git::discard(r.to_str().unwrap(), "newdir", true);
        let newdir_gone = !r.join("newdir").exists();
        // 경계: rel이 루트 자신 / .. 탈출
        let outside = b.join("MUST-SURVIVE.txt");
        std::fs::write(&outside, "survive\n").unwrap();
        let d5 = git::discard(r.to_str().unwrap(), "../MUST-SURVIVE.txt", true);
        let d6 = git::discard(r.to_str().unwrap(), outside.to_str().unwrap(), true);
        let outside_alive = outside.exists();
        let after = git::status(r.to_str().unwrap());
        out(
            "discard_radius",
            serde_json::json!({
                "before_files": before.files.iter().map(|f| format!("{}:{}", f.status, f.path)).collect::<Vec<_>>(),
                "d1_tracked_ok": d1.ok, "worktree_after": after_tracked, "index_tracked_after": idx_tracked,
                "index_other_untouched": idx_other,
                "d2_untracked_ok": d2.ok, "untracked_gone": !r.join("untracked.txt").exists(),
                "d3_added_ok": d3.ok, "added_file_gone": added_gone, "added_still_in_index": idx_added,
                "d4_dir_ok": d4.ok, "newdir_gone": newdir_gone,
                "d5_dotdot_ok": d5.ok, "d5_err": d5.error, "d6_abs_ok": d6.ok, "d6_err": d6.error,
                "outside_file_alive": outside_alive,
                "after_files": after.files.iter().map(|f| format!("{}:{}", f.status, f.path)).collect::<Vec<_>>()
            }),
        );

        // 루트 자신을 지우라고 하면? (렌더러가 보낼 일은 없지만 반경 자체를 잰다)
        let r2 = b.join("discard-root");
        init_repo(&r2);
        std::fs::write(r2.join("x.txt"), "x\n").unwrap();
        g(&r2, &["add", "-A"]);
        g(&r2, &["commit", "-qm", "c1"]);
        let dr = git::discard(r2.to_str().unwrap(), ".", true);
        out("discard_root_self", serde_json::json!({ "ok": dr.ok, "err": dr.error, "repo_still_there": r2.exists() }));
    }

    // ══ 8. 휴지통 의미론 — 진짜 휴지통인가 (subst 드라이브에서 확인) ══════════
    {
        let tr = b.join("trash");
        std::fs::create_dir_all(&tr).unwrap();
        let f = tr.join("recycle-me.txt");
        std::fs::write(&f, "bin\n").unwrap();
        let before = recycle_count();
        let r = file::delete_path("", f.to_str().unwrap());
        std::thread::sleep(std::time::Duration::from_millis(400));
        let after = recycle_count();
        out(
            "trash_normal_volume",
            serde_json::json!({ "ok": r.ok, "gone": !f.exists(), "recycle_before": before, "recycle_after": after }),
        );
    }

    // ══ 9. ccg-img 서빙 판정 ═════════════════════════════════════════════════
    {
        let s = b.join("serve");
        std::fs::create_dir_all(&s).unwrap();
        std::fs::write(s.join("ok.png"), b"\x89PNG\r\n\x1a\n").unwrap();
        std::fs::write(s.join("secret.json"), b"{\"token\":\"SUPERSECRET\"}").unwrap();
        // 확장자만 png인 텍스트/JSON
        std::fs::write(s.join("secret.json.png"), b"{\"token\":\"SUPERSECRET\"}").unwrap();
        // SVG (스크립트를 품을 수 있다)
        std::fs::write(s.join("x.svg"), b"<svg xmlns='http://www.w3.org/2000/svg'><script>fetch('/steal')</script></svg>").unwrap();
        let enc = |p: &Path| {
            p.to_string_lossy()
                .bytes()
                .map(|b| match b {
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
                    _ => format!("%{b:02X}"),
                })
                .collect::<String>()
        };
        let probe = |uri: String| match serve::image_response(&uri) {
            Some((m, bytes)) => serde_json::json!({ "served": true, "mime": m, "len": bytes.len() }),
            None => serde_json::json!({ "served": false }),
        };
        let home = std::env::var("USERPROFILE").unwrap_or_default();
        let mut cases = serde_json::Map::new();
        cases.insert("png".into(), probe(format!("http://ccg-img.localhost/{}", enc(&s.join("ok.png")))));
        cases.insert("json".into(), probe(format!("http://ccg-img.localhost/{}", enc(&s.join("secret.json")))));
        cases.insert("json_named_png".into(), probe(format!("http://ccg-img.localhost/{}", enc(&s.join("secret.json.png")))));
        cases.insert("svg_with_script".into(), probe(format!("http://ccg-img.localhost/{}", enc(&s.join("x.svg")))));
        cases.insert(
            "traversal_dotdot".into(),
            probe(format!("http://ccg-img.localhost/{}", enc(&s.join("..").join("..").join("ok.png")))),
        );
        cases.insert(
            "real_home_accounts_json".into(),
            probe(format!("http://ccg-img.localhost/{}", enc(Path::new(&home).join(".agentcodegui").join("accounts.json").as_path()))),
        );
        // ADS(대체 데이터 스트림)로 비이미지 본문을 png 이름 뒤에 붙일 수 있나
        let ads = format!("{}:s.png", s.join("secret.json").to_string_lossy());
        let ads_written = std::fs::write(&ads, b"ADSPAYLOAD").is_ok();
        cases.insert("ads_stream".into(), probe(format!("http://ccg-img.localhost/{}", enc(Path::new(&ads)))));
        cases.insert("ads_written".into(), serde_json::json!(ads_written));
        // 디렉터리·없는 파일
        cases.insert("dir".into(), probe(format!("http://ccg-img.localhost/{}", enc(&s))));
        // 64MB 캡 (63MB / 65MB)
        let small = s.join("just-under.png");
        let bigp = s.join("over.png");
        std::fs::write(&small, vec![0u8; 63 * 1024 * 1024]).unwrap();
        std::fs::write(&bigp, vec![0u8; 65 * 1024 * 1024]).unwrap();
        let t = Instant::now();
        let u = probe(format!("http://ccg-img.localhost/{}", enc(&small)));
        let ms63 = t.elapsed().as_millis();
        cases.insert("under_64mb".into(), u);
        cases.insert("under_64mb_ms".into(), serde_json::json!(ms63));
        cases.insert("over_64mb".into(), probe(format!("http://ccg-img.localhost/{}", enc(&bigp))));
        out("ccg_img", serde_json::Value::Object(cases));
        let _ = std::fs::remove_file(&small);
        let _ = std::fs::remove_file(&bigp);
    }

    // ══ 10. git stdout 32MB 캡 ═══════════════════════════════════════════════
    {
        let r = b.join("bigblob");
        init_repo(&r);
        let line = "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEFxx\n"; // 50B
        let big: String = line.repeat(700_000); // ~35MB
        std::fs::write(r.join("huge.txt"), &big).unwrap();
        std::fs::write(r.join("small.txt"), "a\nb\nc\n").unwrap();
        g(&r, &["add", "-A"]);
        g(&r, &["commit", "-qm", "big blob"]);
        // 워킹트리를 작게 만든다 — HEAD blob만 35MB
        std::fs::write(r.join("huge.txt"), "tiny\n").unwrap();
        let t = Instant::now();
        let d = git::file_diff(r.to_str().unwrap(), "huge.txt");
        let ms = t.elapsed().as_millis();
        // 캡 직후 생존
        let after = git::status(r.to_str().unwrap());
        let sd = git::file_diff(r.to_str().unwrap(), "small.txt");
        out(
            "git_stdout_cap",
            serde_json::json!({
                "blob_bytes": big.len(), "ms": ms,
                "err": d.error, "diff_tag": d.diff.as_ref().map(|x| x.tag),
                "diff_add": d.diff.as_ref().map(|x| x.add), "diff_del": d.diff.as_ref().map(|x| x.del),
                "alive_status_files": after.files.len(), "alive_small_diff": sd.diff.is_some()
            }),
        );
    }

    // ══ 11. diff 캡 3+1종 (직접) ═════════════════════════════════════════════
    {
        let r = b.join("diffcaps");
        init_repo(&r);
        let mk = |n: usize, f: &dyn Fn(usize) -> String| -> String {
            (0..n).map(|i| f(i)).collect::<Vec<_>>().join("\n") + "\n"
        };
        let base8k = mk(8000, &|i| format!("line {i}"));
        std::fs::write(r.join("a.txt"), &base8k).unwrap();
        std::fs::write(r.join("b.txt"), &base8k).unwrap();
        std::fs::write(r.join("big.txt"), "x".repeat(1_600_000)).unwrap();
        std::fs::write(r.join("bin.dat"), {
            let mut v = b"PNGDATA".to_vec();
            v.push(0);
            v.extend_from_slice(&[1u8; 400]);
            v
        })
        .unwrap();
        g(&r, &["add", "-A"]);
        g(&r, &["commit", "-qm", "base"]);
        std::fs::write(r.join("a.txt"), mk(8000, &|i| if i % 16 == 0 { format!("line {i} CHANGED") } else { format!("line {i}") })).unwrap();
        std::fs::write(r.join("b.txt"), mk(8000, &|i| format!("TOTALLY OTHER {i}"))).unwrap();
        std::fs::write(r.join("big.txt"), "y".repeat(1_600_000)).unwrap();
        std::fs::write(r.join("bin.dat"), {
            let mut v = b"PNGDATA".to_vec();
            v.push(0);
            v.extend_from_slice(&[2u8; 400]);
            v
        })
        .unwrap();
        let mut m = serde_json::Map::new();
        for (id, rel) in [("scattered_8000", "a.txt"), ("full_rewrite", "b.txt"), ("over_1_5mb", "big.txt"), ("binary", "bin.dat")] {
            let t = Instant::now();
            let d = git::file_diff(r.to_str().unwrap(), rel);
            m.insert(
                id.into(),
                serde_json::json!({
                    "ms": t.elapsed().as_millis(), "err": d.error,
                    "add": d.diff.as_ref().map(|x| x.add), "del": d.diff.as_ref().map(|x| x.del),
                    "lines": d.diff.as_ref().map(|x| x.lines.len()), "tag": d.diff.as_ref().map(|x| x.tag)
                }),
            );
        }
        let alive = dir::list_dir(r.to_str().unwrap(), "", &dir::ListOpts::default()).len();
        m.insert("alive_rows_after".into(), serde_json::json!(alive));
        out("diff_caps", serde_json::Value::Object(m));
    }

    // ══ 12. 실제 대형 레포 걷기 시간 (읽기 전용, 이 머신의 진짜 폴더) ═════════
    {
        let mut m = serde_json::Map::new();
        for p in ["C:/Code/AgentCodeGUI", "C:/Code/AgentCodeGUI/node_modules"] {
            if !Path::new(p).exists() {
                continue;
            }
            let t = Instant::now();
            let rows = dir::list_dir(p, "", &dir::ListOpts::default());
            let ms1 = t.elapsed().as_millis();
            let t = Instant::now();
            let files = dir::list_project_files(p);
            let ms2 = t.elapsed().as_millis();
            m.insert(p.into(), serde_json::json!({ "list_dir_rows": rows.len(), "list_dir_ms": ms1,
                                                   "mention_files": files.len(), "mention_ms": ms2 }));
        }
        out("real_repo_walk", serde_json::Value::Object(m));
    }

    // 정리 — bigdir·65MB 파일 등은 지운다(긴 경로는 남을 수 있어 별도 처리)
    let _ = Command::new("cmd").args(["/c", "rmdir", "/S", "/Q", b.to_str().unwrap()]).output();
    out("cleanup", serde_json::json!({ "base_gone": !b.exists() }));
}

/// 휴지통 항목 수 — 진짜 휴지통에 들어갔는지 확인용.
fn recycle_count() -> i64 {
    let o = Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "@((New-Object -ComObject Shell.Application).NameSpace(10).Items()).Count",
        ])
        .output();
    o.ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<i64>().ok())
        .unwrap_or(-1)
}
