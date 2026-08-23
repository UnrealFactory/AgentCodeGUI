//! R14 크리틱 F1의 회귀 잠금 — `limit::is_limit_error`(3.0 Rust)와 2.6.2
//! `classifyLimitError`의 **판정 일치**를 2.6.2 PoC 코퍼스
//! (`scripts/poc-limit-resume.mjs` A절)로 잰다.
//!
//! 코퍼스의 저자는 2.6.2 쪽이고, 이 테스트는 그 골든을 그대로 인용만 한다.
//! **크리틱이 워크트리에 두고 간 파일을 그대로 들여왔다** — 붉은 채로 들여와서
//! (`FALSE-POSITIVE` 3건) 고친 뒤 초록이 된 것이 이 파일의 존재 이유다.
//!
//! ```text
//! 들여올 때: HITS 9 / MISSES 9 / 불일치 3
//!   FALSE-POSITIVE "context limit reached: conversation too long"
//!   FALSE-POSITIVE "output token limit exceeded"
//!   FALSE-POSITIVE "rate limited; retry shortly"
//! ```
use ccg_engine::frames::is_limit_error;
use ccg_engine::limit::classify_limit_error;

const HITS: &[&str] = &[
    "Claude AI usage limit reached|1755150000",
    "Claude AI usage limit reached",
    "You've reached your usage limit.",
    "You've hit your usage limit. Upgrade to continue.",
    "5-hour limit reached ∙ resets 3pm",
    "Weekly limit reached · resets Aug 20",
    "five-hour limit reached, resets 15:00",
    "Session limit reached|1799999999",
    "you have reached your weekly limit",
];
const MISSES: &[&str] = &[
    "Invalid API key · Please run /login",
    "Command failed with exit code 1",
    "context limit reached: conversation too long",
    "output token limit exceeded",
    "prompt is too long: maximum context length exceeded",
    "API Error: 529 overloaded_error",
    "rate limited; retry shortly",
    "오류: 실행 중 프로세스가 종료되었습니다",
    "",
];

#[test]
fn parity_with_262_classify_limit_error() {
    let mut bad = vec![];
    // 판정표 — `-- --nocapture`로 18줄이 그대로 나온다(보고서가 인용하는 그 표).
    println!("{:<6} {:<6} {:<12} 문구", "기대", "실측", "리셋꼬리");
    for s in HITS {
        let got = classify_limit_error(s);
        println!(
            "{:<6} {:<6} {:<12} {s:?}",
            "hit",
            if got.hit { "hit" } else { "MISS" },
            got.resets_at.map(|v| v.to_string()).unwrap_or_else(|| "-".into())
        );
        if !got.hit {
            bad.push(format!("FALSE-NEGATIVE {s:?}"));
        }
    }
    for s in MISSES {
        let got = classify_limit_error(s);
        println!(
            "{:<6} {:<6} {:<12} {s:?}",
            "miss",
            if got.hit { "HIT" } else { "miss" },
            got.resets_at.map(|v| v.to_string()).unwrap_or_else(|| "-".into())
        );
        if got.hit {
            bad.push(format!("FALSE-POSITIVE {s:?}"));
        }
    }
    println!("HITS {} / MISSES {} / 불일치 {}", HITS.len(), MISSES.len(), bad.len());
    for b in &bad {
        println!("  {b}");
    }
    assert!(bad.is_empty(), "2.6.2 코퍼스와 {}건 갈림", bad.len());
}

/// 코퍼스의 나머지 반쪽 — 2.6.2 `parseEpoch`가 읽어 내던 **리셋 꼬리**.
/// `hit`만 옮기고 시각을 버린 것이 F2(6.5분 헛 재개)의 절반이었다.
#[test]
fn the_reset_tail_comes_back_with_the_hit() {
    // (문구, 기대 epoch) — 앞 둘은 poc A절의 HITS 표에 적힌 값 그대로다.
    let cases: &[(&str, Option<u64>)] = &[
        ("Claude AI usage limit reached|1755150000", Some(1_755_150_000)),
        ("Session limit reached|1799999999", Some(1_799_999_999)),
        ("Claude AI usage limit reached", None),
        ("5-hour limit reached ∙ resets 3pm", None),
        // 10자리가 아니면 안 읽는다(2.6.2 `/\|(\d{10})(?:\D|$)/`)
        ("usage limit reached|175515000", None),
        ("usage limit reached|17551500001", None),
    ];
    for (s, want) in cases {
        let got = classify_limit_error(s);
        assert!(got.hit, "{s:?}는 hit이어야 한다");
        assert_eq!(got.resets_at, *want, "{s:?}의 리셋 꼬리");
    }
    // miss면 시각도 안 딸려 나온다(2.6.2: `resetsAt: hit ? parseEpoch(s) : null`)
    let m = classify_limit_error("output token limit exceeded|1755150000");
    assert!(!m.hit && m.resets_at.is_none(), "차단벽에 걸린 문구는 시각도 없다");
}

/// F1이 잡은 오탐 3종이 **왜** 오탐인지 — 이 셋은 리셋으로 풀리지 않는다.
/// 재전송하면 같은 에러가 또 나고, 그게 영원히 돈다(F1×F2 조합).
#[test]
fn the_three_false_positives_stay_dead() {
    for s in [
        "context limit reached: conversation too long",
        "output token limit exceeded",
        "rate limited; retry shortly",
    ] {
        assert!(!is_limit_error(s), "{s:?}는 한도가 아니다");
    }
    // 한국어 짝도 같은 차단벽 뒤에 있다(옛 판의 맨 `한도` 부분일치가 삼키던 부류).
    for s in ["컨텍스트 한도 초과", "출력 토큰 한도에 도달", "입력 길이 한도"] {
        assert!(!is_limit_error(s), "{s:?}는 한도가 아니다");
    }
}
