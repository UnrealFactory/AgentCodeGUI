//! **M4 크리틱 — 이식 결함 ②(`.cmd` shim 인용)의 뮤테이션 증명.**
//!
//! `crates/ccg-engine/tests/critic_m4_rawarg.rs`로 복사해 돌린다.
//!
//! 제품 테스트(`codex::driver::tests::a_cmd_shim_is_launched_through_cmd_exe`)는
//! `Command::get_args()`를 본다 — 그런데 `arg()`와 `raw_arg()`는 **논리 인자가 같고**
//! 차이는 `CreateProcess`에 넘길 커맨드라인을 만들 때만 난다. 그래서 그 단언은
//! `raw_arg`를 `arg`로 바꿔도 초록이다(뮤테이션 생존). 여기서는 **실제로 띄워** 가른다.

#![cfg(windows)]

use std::os::windows::process::CommandExt;
use std::process::Command;

fn shim_dir() -> std::path::PathBuf {
    // 경로에 **공백**이 있어야 재현된다(빌더가 밟은 자리와 같은 조건).
    let d = std::env::temp_dir().join(format!("ccg m4 crit {}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    let cmd = d.join("codex.cmd");
    std::fs::write(&cmd, "@echo off\r\necho SHIM-OK %1\r\n").unwrap();
    d
}

#[test]
fn raw_arg_launches_the_shim_but_arg_does_not() {
    let d = shim_dir();
    let s = d.join("codex.cmd").to_string_lossy().to_string();

    // ① 제품이 하는 것 — raw_arg (바깥 따옴표 한 겹)
    let mut c = Command::new("cmd");
    c.raw_arg("/C");
    c.raw_arg(format!("\"\"{s}\" app-server\""));
    let a = c.output().expect("spawn");
    let a_out = String::from_utf8_lossy(&a.stdout).to_string() + &String::from_utf8_lossy(&a.stderr);

    // ② 뮤테이션 — arg (Rust가 `\"`로 이스케이프한다)
    let mut c2 = Command::new("cmd");
    c2.arg("/C");
    c2.arg(format!("\"\"{s}\" app-server\""));
    let b = c2.output().expect("spawn");
    let b_out = String::from_utf8_lossy(&b.stdout).to_string() + &String::from_utf8_lossy(&b.stderr);

    println!("[raw_arg] status={:?} out={}", a.status.code(), a_out.trim());
    println!("[arg    ] status={:?} out={}", b.status.code(), b_out.trim());
    let _ = std::fs::remove_dir_all(&d);

    assert!(a_out.contains("SHIM-OK"), "raw_arg 경로가 shim을 못 띄웠다: {a_out}");
    assert!(
        !b_out.contains("SHIM-OK"),
        "arg 경로도 떴다 = 이 결함은 재현되지 않는다(뮤테이션이 무의미): {b_out}"
    );
}
