//! ★ LSPDIST R2 · 확인 크리틱 R1 **C4** — cwd 못을 결함이 살던 층에 박는다.
//!
//! R1은 사슬을 순수 함수(`module_roots_from`)로 뽑고 그것을 통째로 대조했다. 좋은 못이지만
//! **한 층만** 문다. 크리틱이 격리 사본에서 실측한 돌연변이:
//!
//! | 돌연변이 | R1 테스트 |
//! |---|---|
//! | `module_roots_from` 안에 cwd 사슬 부활 | red ✅ |
//! | **`module_roots()`에 cwd 사슬 부활** | **초록** ✖ |
//!
//! 두 번째가 옛 코드(`09b9bc7`)에서 결함이 **실제로 살던 자리**다(`shipped_module()` 본문).
//! 그래서 여기서는 층을 고르지 않는다 — **진짜로 프로세스 cwd를 미끼 폴더로 바꿔 놓고**
//! 공개 진입점 `shipped_module()`에 묻는다. 어느 층에 cwd가 되살아나든 이 파일이 붉어진다.
//!
//! ## 왜 통합 테스트(별도 바이너리)인가
//! `set_current_dir`는 **프로세스 전역**이다. `--lib` 테스트는 한 프로세스에서 여러 스레드로
//! 도니까 거기에 cwd를 바꾸는 테스트를 두면 옆 테스트의 상대 경로가 조용히 흔들린다.
//! 통합 테스트는 자기만의 프로세스라 그 위험이 0이다. 이 파일에 테스트를 **하나만** 두는
//! 것도 같은 이유다 — 파일 안에서도 병렬이 없어야 한다.

use std::path::PathBuf;

/// 미끼: cwd 조상에만 있는 `node_modules`. 옛 코드는 이걸 물었다.
#[test]
fn shipped_module_never_looks_at_the_process_cwd() {
    // 레포와 겹치지 않는 유일한 이름 — 혹시 exe 조상 사슬에 같은 이름이 있으면
    // 이 테스트가 이유 없이 통과해 버린다(위양성 방지).
    const FAKE: &str = "ccg-lspdist-r2-bait-pkg";

    let bait = std::env::temp_dir().join(format!("ccg-lspdist-r2-bait-{}", std::process::id()));
    let deep = bait.join("project").join("src");
    let module = bait.join("node_modules").join(FAKE).join("index.js");
    std::fs::create_dir_all(&deep).unwrap();
    std::fs::create_dir_all(module.parent().unwrap()).unwrap();
    std::fs::write(&module, b"// bait").unwrap();

    // 벤치 레버가 셸에 남아 있으면 팔 자체가 무의미해진다.
    std::env::remove_var("CCG_LSP_MODULES");

    let prev = std::env::current_dir().ok();
    // cwd를 **미끼 안쪽 깊은 곳**으로 — 옛 사슬은 여기서 위로 걸어 `bait/node_modules`를 물었다.
    std::env::set_current_dir(&deep).unwrap();
    let got: Option<PathBuf> = ccg_lsp::launch::shipped_module(&[FAKE, "index.js"]);
    if let Some(p) = prev {
        let _ = std::env::set_current_dir(p);
    }
    let _ = std::fs::remove_dir_all(&bait);

    assert_eq!(
        got, None,
        "프로세스 cwd 조상의 node_modules를 물었다 — cwd 사슬이 어느 층에선가 되살아났다. \
         `crates/ccg-lsp/src/launch.rs` 머리말의 「LSPDIST R1」을 읽어라. \
         이 칸이 §1.4-b의 0.627/0.839 띠를 만들었다."
    );

    // 대조군 — 같은 자리를 **명시 지정**으로 주면 찾아야 한다. 안 그러면 위 `None`이
    // 「cwd를 안 본다」가 아니라 「애초에 아무것도 못 찾는다」의 결과일 수 있다.
    let bait2 = std::env::temp_dir().join(format!("ccg-lspdist-r2-lever-{}", std::process::id()));
    let m2 = bait2.join("node_modules").join(FAKE).join("index.js");
    std::fs::create_dir_all(m2.parent().unwrap()).unwrap();
    std::fs::write(&m2, b"// lever").unwrap();
    std::env::set_var("CCG_LSP_MODULES", &bait2);
    let lever = ccg_lsp::launch::shipped_module(&[FAKE, "index.js"]);
    std::env::remove_var("CCG_LSP_MODULES");
    let _ = std::fs::remove_dir_all(&bait2);
    assert_eq!(lever, Some(m2), "CCG_LSP_MODULES 레버가 죽었다면 위 None은 증명이 아니다");
}
