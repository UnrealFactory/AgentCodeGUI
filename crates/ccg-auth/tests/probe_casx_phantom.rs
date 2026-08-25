//! ★R28d(CASX R3) — **측정 프로브**(게이트가 아니다 · 셋 다 `#[ignore]`).
//!
//! 이 파일은 판정을 안 한다 — 수를 센다. 그 수가 이 라운드의 진단(「걸터탄 열기」)을 세운
//! 근거이고, 다음 크리틱이 그 근거를 **자기 손으로 다시 재는** 자리다:
//!
//! ```bash
//! cargo test -p ccg-auth --test probe_casx_phantom -- --ignored --nocapture --test-threads=1
//! ```
//!
//! 셋이 합쳐 약 150초라 기본 게이트에서는 뺀다(`#[ignore]`). 그래도 **지우지는 않는다** —
//! 이 갈래의 헤드라인 주장(「첫 판독이 `expect`면 묻은 쓰기는 없다」가 거짓)이 실측에만 서
//! 있어서, 실측을 지우면 다음 사람은 그 문장을 믿거나 말거나 해야 한다.
//!
//! 묻는 것 둘:
//! 1. (`phantom_probe`) 이웃의 `CREATE_ALWAYS`가 갈아끼우기 창에서 **새 inode(유령)** 를
//!    만들어 우리 `rename`이 그걸 통째로 묻는 판이 있는가.
//! 2. (`late_burial_probe`) 커밋 뒤 **첫 판독이 `expect` 그대로**라 지름길로 `Clean`을 낸
//!    다음에, 이웃의 쓰기가 **뒤늦게** 그 옛 inode에 떨어지는 판이 있는가.
//!    (= 우리가 이웃의 쓰기를 묻은 줄도 모르고 지나가는 자리)

#![cfg(windows)]

use std::collections::HashSet;
use std::io::Write;
use std::os::windows::fs::OpenOptionsExt;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

const SHARE_ALL: u32 = 1 | 2 | 4;

fn idx_of(f: &std::fs::File) -> Option<u64> {
    ccg_auth::replace::ident(f).map(|i| i.index)
}

fn tmp_of(dst: &std::path::Path) -> std::path::PathBuf {
    let mut s = dst.as_os_str().to_os_string();
    s.push(format!(".tmp-{}", std::process::id()));
    std::path::PathBuf::from(s)
}

#[test]
#[ignore = "측정 프로브 — 게이트가 아니다(약 50초). --ignored로 부른다"]
fn phantom_probe() {
    let home = ccg_store::testhome::take("casx-phantom");
    let dst = ccg_store::app_home().join("accounts.json");
    let tmp = tmp_of(&dst);
    std::fs::write(&dst, "{\"version\":3,\"accounts\":[]}").unwrap();
    let seed_idx = idx_of(&std::fs::File::open(&dst).unwrap()).unwrap();

    let ours: Arc<Mutex<HashSet<u64>>> = Arc::new(Mutex::new([seed_idx].into_iter().collect()));
    let stop = Arc::new(AtomicBool::new(false));
    let phantom = Arc::new(AtomicUsize::new(0));
    let peer_n = Arc::new(AtomicUsize::new(0));
    let peer_fail = Arc::new(AtomicUsize::new(0));
    let peer_enoent = Arc::new(AtomicUsize::new(0));

    let (o2, s2, p2, n2, f2, e2, d2) =
        (ours.clone(), stop.clone(), phantom.clone(), peer_n.clone(), peer_fail.clone(), peer_enoent.clone(), dst.clone());
    let peer = std::thread::spawn(move || {
        let body = "{\"version\":3,\"accounts\":[{\"email\":\"ghost@x\"}]}";
        while !s2.load(Ordering::Relaxed) {
            match std::fs::OpenOptions::new().write(true).create(true).truncate(true).share_mode(SHARE_ALL).open(&d2) {
                Ok(mut f) => {
                    let i = idx_of(&f);
                    let _ = f.write_all(body.as_bytes());
                    drop(f);
                    n2.fetch_add(1, Ordering::Relaxed);
                    if let Some(i) = i {
                        if !o2.lock().unwrap().contains(&i) {
                            p2.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                }
                Err(e) => {
                    if e.kind() == std::io::ErrorKind::NotFound {
                        e2.fetch_add(1, Ordering::Relaxed);
                    }
                    f2.fetch_add(1, Ordering::Relaxed);
                }
            }
        }
    });

    let mut swaps = 0usize;
    let mut buried_seen = 0usize;
    let mut clean_first = 0usize;
    let mut unreadable = 0usize;
    let mut name_not_ours = 0usize;
    let body = format!("{{\"version\":3,\"accounts\":[{{\"email\":\"mine@x\"}}],\"pad\":\"{}\"}}", "x".repeat(600));
    for _ in 0..3000 {
        let mut w = ccg_auth::replace::witness(&dst);
        let before = w.as_mut().and_then(ccg_auth::replace::read_witness);
        let p = ccg_auth::replace::stage(&dst, &body).unwrap();
        if let Ok(f) = std::fs::OpenOptions::new().read(true).share_mode(SHARE_ALL).open(&tmp) {
            if let Some(i) = idx_of(&f) {
                ours.lock().unwrap().insert(i);
            }
        }
        let carried = p.replace(&dst).unwrap();
        swaps += 1;
        if let Some(w) = w.as_mut() {
            match ccg_auth::replace::read_witness(w) {
                Some(a) if Some(&a) == before.as_ref() => clean_first += 1,
                Some(_) => buried_seen += 1,
                None => unreadable += 1,
            }
        }
        if let Ok(f) = std::fs::OpenOptions::new().read(true).share_mode(SHARE_ALL).open(&dst) {
            if let Some(i) = idx_of(&f) {
                if !ours.lock().unwrap().contains(&i) {
                    name_not_ours += 1;
                }
            }
        }
        drop(carried);
        std::thread::sleep(std::time::Duration::from_micros(200));
    }
    stop.store(true, Ordering::Relaxed);
    peer.join().unwrap();
    println!(
        "[probe] 갈아끼우기 {swaps} · 이웃 쓰기 {} (열기실패 {} · 그중 ENOENT {}) · ★유령 inode {} · 우리가 파낸 판 {buried_seen} · 첫판독 그대로 {clean_first} · 판독불가 {unreadable} · 이름이 남의 것 {name_not_ours}",
        peer_n.load(Ordering::Relaxed),
        peer_fail.load(Ordering::Relaxed),
        peer_enoent.load(Ordering::Relaxed),
        phantom.load(Ordering::Relaxed),
    );
    let _ = std::fs::remove_dir_all(&home);
}

/// ★ 늦게 오는 매장의 **정체**를 가른다 — 이웃의 열기가 우리 `rename`을 걸터탄 것인가
/// (straddle), 아니면 `rename`이 돌아온 뒤에 연 것이 옛 inode로 갔는가(이름 지연).
#[test]
#[ignore = "측정 프로브 — 게이트가 아니다(약 50초). --ignored로 부른다"]
fn late_burial_who_probe() {
    let home = ccg_store::testhome::take("casx-who");
    let dst = ccg_store::app_home().join("accounts.json");
    std::fs::write(&dst, "{\"version\":3,\"accounts\":[]}").unwrap();

    let stop = Arc::new(AtomicBool::new(false));
    // 이웃이 **열기 직전에** 올리는 번호. 본문에도 같은 번호를 적는다.
    let seq = Arc::new(AtomicUsize::new(0));
    let (s2, q2, d2) = (stop.clone(), seq.clone(), dst.clone());
    let peer = std::thread::spawn(move || {
        while !s2.load(Ordering::Relaxed) {
            let i = q2.fetch_add(1, Ordering::SeqCst) + 1;
            let body = format!("{{\"version\":3,\"seq\":{i},\"accounts\":[{{\"email\":\"ghost@x\"}}]}}");
            if let Ok(mut f) = std::fs::OpenOptions::new().write(true).create(true).truncate(true).share_mode(SHARE_ALL).open(&d2) {
                let _ = f.write_all(body.as_bytes());
            }
        }
    });

    let parse_seq = |s: &str| -> Option<usize> {
        let a = s.find("\"seq\":")? + 6;
        let b = s[a..].find(',')? + a;
        s[a..b].parse().ok()
    };

    let (mut clean_first, mut straddle, mut after_rename, mut unknown) = (0usize, 0usize, 0usize, 0usize);
    let mut samples: Vec<String> = vec![];
    let body = format!("{{\"version\":3,\"seq\":0,\"accounts\":[{{\"email\":\"mine@x\"}}],\"pad\":\"{}\"}}", "x".repeat(600));
    for _ in 0..2000 {
        let mut w = ccg_auth::replace::witness(&dst);
        let before = w.as_mut().and_then(ccg_auth::replace::read_witness);
        let p = ccg_auth::replace::stage(&dst, &body).unwrap();
        let carried = p.replace(&dst).unwrap();
        let seq_at_rename = seq.load(Ordering::SeqCst);
        let first = w.as_mut().and_then(ccg_auth::replace::read_witness);
        if first == before {
            clean_first += 1;
            std::thread::sleep(std::time::Duration::from_millis(20));
            let now = w.as_mut().and_then(ccg_auth::replace::read_witness);
            if now != before {
                let txt = now.unwrap_or_default();
                match parse_seq(&txt) {
                    Some(s) if s <= seq_at_rename => straddle += 1,
                    Some(s) => {
                        after_rename += 1;
                        if samples.len() < 5 {
                            samples.push(format!("늦은seq={s} · 갈아끼울때seq={seq_at_rename} · 차이={}", s - seq_at_rename));
                        }
                    }
                    None => {
                        unknown += 1;
                        if samples.len() < 5 {
                            samples.push(format!("<seq 못읽음: {}B> {}", txt.len(), txt.chars().take(60).collect::<String>()));
                        }
                    }
                }
            }
        }
        drop(carried);
        drop(w);
    }
    stop.store(true, Ordering::Relaxed);
    peer.join().unwrap();
    println!("[probe-who] 지름길 Clean {clean_first} — 늦은 매장: 걸터탐(열기≤rename) {straddle} · ★rename 뒤 열기 {after_rename} · 알수없음 {unknown}");
    for s in &samples {
        println!("[probe-who]   {s}");
    }
    let _ = std::fs::remove_dir_all(&home);
}

/// ★ 지름길(첫 판독이 `expect`면 즉시 Clean)이 놓치는 판을 잰다.
#[test]
#[ignore = "측정 프로브 — 게이트가 아니다(약 50초). --ignored로 부른다"]
fn late_burial_probe() {
    let home = ccg_store::testhome::take("casx-late");
    let dst = ccg_store::app_home().join("accounts.json");
    std::fs::write(&dst, "{\"version\":3,\"accounts\":[]}").unwrap();

    let stop = Arc::new(AtomicBool::new(false));
    let peer_n = Arc::new(AtomicUsize::new(0));
    let (s2, n2, d2) = (stop.clone(), peer_n.clone(), dst.clone());
    let peer = std::thread::spawn(move || {
        let mut i = 0usize;
        while !s2.load(Ordering::Relaxed) {
            i += 1;
            let body = format!("{{\"version\":3,\"accounts\":[{{\"email\":\"ghost{i}@x\"}}]}}");
            // 2.6.2의 `fs.writeFileSync` 그대로 — 열면서 자르고(CREATE_ALWAYS) 쓴다.
            if let Ok(mut f) = std::fs::OpenOptions::new().write(true).create(true).truncate(true).share_mode(SHARE_ALL).open(&d2) {
                let _ = f.write_all(body.as_bytes());
                n2.fetch_add(1, Ordering::Relaxed);
            }
        }
    });

    let mut swaps = 0usize;
    let (mut clean_first, mut buried_first, mut unreadable_first) = (0usize, 0usize, 0usize);
    // 지름길로 Clean을 낸 뒤 옛 inode가 **나중에** 갈리는 판 — 시각별로 센다.
    let mut late: [usize; 4] = [0; 4];
    let waits_us = [100u64, 400, 2_000, 20_000];
    let body = format!("{{\"version\":3,\"accounts\":[{{\"email\":\"mine@x\"}}],\"pad\":\"{}\"}}", "x".repeat(600));
    for _ in 0..3000 {
        let mut w = ccg_auth::replace::witness(&dst);
        let before = w.as_mut().and_then(ccg_auth::replace::read_witness);
        let p = ccg_auth::replace::stage(&dst, &body).unwrap();
        let carried = p.replace(&dst).unwrap();
        swaps += 1;
        let first = w.as_mut().and_then(ccg_auth::replace::read_witness);
        match &first {
            Some(a) if Some(a) == before.as_ref() => {
                clean_first += 1;
                // 제품은 여기서 즉시 `Clean`을 내고 잠금을 놓는다. 그 뒤를 본다.
                let mut hit = false;
                for (k, us) in waits_us.iter().enumerate() {
                    std::thread::sleep(std::time::Duration::from_micros(*us - if k == 0 { 0 } else { waits_us[k - 1] }));
                    let now = w.as_mut().and_then(ccg_auth::replace::read_witness);
                    if now != before && !hit {
                        late[k] += 1;
                        hit = true;
                    }
                }
            }
            Some(_) => buried_first += 1,
            None => unreadable_first += 1,
        }
        drop(carried);
        drop(w);
        std::thread::sleep(std::time::Duration::from_micros(200));
    }
    stop.store(true, Ordering::Relaxed);
    peer.join().unwrap();
    println!(
        "[probe-late] 갈아끼우기 {swaps} · 이웃 쓰기 {} — 첫판독: 그대로 {clean_first} / 갈림 {buried_first} / 판독불가 {unreadable_first}",
        peer_n.load(Ordering::Relaxed)
    );
    println!("[probe-late] ★지름길 Clean 뒤에 갈린 판(누적 시각별): 100µs={} · 400µs={} · 2ms={} · 20ms={}", late[0], late[1], late[2], late[3]);
    let _ = std::fs::remove_dir_all(&home);
}
