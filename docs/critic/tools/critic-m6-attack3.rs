//! 3차 — 긴 경로 휴지통 행선지 · 휴지통 용량 정책 · SHFileOperation 반환값 관찰.
use ccg_fs::file;
use std::path::PathBuf;
use std::process::Command;

fn out(k: &str, v: serde_json::Value) {
    println!("@@{}\t{}", k, serde_json::to_string(&v).unwrap());
}
fn ps(c: &str) -> String {
    Command::new("powershell")
        .args(["-NoProfile", "-Command", c])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}
fn recycle_count() -> i64 {
    ps("@((New-Object -ComObject Shell.Application).NameSpace(10).Items()).Count").parse().unwrap_or(-1)
}

fn main() {
    let b: PathBuf = std::env::temp_dir().join("ccg-m6-atk3");
    let _ = std::fs::remove_dir_all(&b);
    std::fs::create_dir_all(&b).unwrap();

    // 휴지통 용량 정책 (볼륨별 MaxCapacity / NukeOnDelete)
    let pol = ps(r#"Get-ChildItem 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\BitBucket\Volume' -ErrorAction SilentlyContinue | ForEach-Object { $p=Get-ItemProperty $_.PSPath; "$($_.PSChildName) max=$($p.MaxCapacity)MB nuke=$($p.NukeOnDelete)" }"#);
    out("recycle_policy", serde_json::json!({ "volumes": pol.lines().collect::<Vec<_>>() }));

    // 긴 경로(>260)를 휴지통으로 — 진짜 휴지통인가?
    {
        let mut deep = b.join("long");
        std::fs::create_dir_all(&deep).unwrap();
        let seg = "d".repeat(40);
        for _ in 0..7 {
            deep = deep.join(&seg);
            if std::fs::create_dir(&deep).is_err() {
                break;
            }
        }
        let f = deep.join("긴이름파일.txt");
        let ok_write = std::fs::write(&f, "long\n").is_ok();
        let before = recycle_count();
        let r = file::delete_path("", f.to_str().unwrap());
        std::thread::sleep(std::time::Duration::from_millis(600));
        let after = recycle_count();
        out(
            "longpath_trash_rust",
            serde_json::json!({ "path_len": f.to_string_lossy().chars().count(), "wrote": ok_write,
                                "ok": r.ok, "err": r.error, "still": f.exists(),
                                "recycle_before": before, "recycle_after": after, "went_to_recycle_bin": after > before }),
        );
    }

    // 폴더 통째 휴지통 (discard의 미추적 폴더 행)
    {
        let d = b.join("newdir");
        std::fs::create_dir_all(d.join("nested")).unwrap();
        std::fs::write(d.join("a.txt"), "a").unwrap();
        std::fs::write(d.join("nested").join("b.txt"), "b").unwrap();
        let before = recycle_count();
        let r = file::delete_path("", d.to_str().unwrap());
        std::thread::sleep(std::time::Duration::from_millis(600));
        out(
            "dir_trash_rust",
            serde_json::json!({ "ok": r.ok, "gone": !d.exists(), "recycle_before": before, "recycle_after": recycle_count() }),
        );
    }

    let _ = Command::new("cmd").args(["/c", "rmdir", "/S", "/Q", b.to_str().unwrap()]).output();
    out("cleanup3", serde_json::json!({ "gone": !b.exists() }));
}
