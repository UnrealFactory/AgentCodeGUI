use ccg_fs::diff::compute_line_diff;
use std::time::Instant;
fn mk(n: usize, f: &dyn Fn(usize) -> String) -> String { (0..n).map(f).collect::<Vec<_>>().join("\n") + "\n" }
fn main() {
    // 20000줄, 서로 먼 두 곳 수정
    let a = mk(20000, &|i| format!("line {i}"));
    let b = mk(20000, &|i| if i == 100 || i == 19000 { format!("line {i} X") } else { format!("line {i}") });
    let t = Instant::now(); let (l, ad, de) = compute_line_diff(&a, &b);
    println!("@@two_far_edits\t{{\"add\":{ad},\"del\":{de},\"lines\":{},\"ms\":{}}}", l.len(), t.elapsed().as_millis());
    // 300000줄, 한 줄 수정
    let a = mk(300000, &|i| format!("line {i}"));
    let b = mk(300000, &|i| if i == 150000 { "CHANGED".into() } else { format!("line {i}") });
    let t = Instant::now(); let (l, ad, de) = compute_line_diff(&a, &b);
    println!("@@huge_one_edit\t{{\"add\":{ad},\"del\":{de},\"lines\":{},\"ms\":{}}}", l.len(), t.elapsed().as_millis());
    // D > MAX_D 폴백
    let a = mk(8000, &|i| format!("line {i}"));
    let b = mk(8000, &|i| format!("OTHER {i}"));
    let t = Instant::now(); let (l, ad, de) = compute_line_diff(&a, &b);
    println!("@@full_rewrite\t{{\"add\":{ad},\"del\":{de},\"lines\":{},\"ms\":{}}}", l.len(), t.elapsed().as_millis());
    // 스텝 예산 자리 — 100k줄 절반 교체
    let a = mk(100000, &|i| format!("line {i}"));
    let b = mk(100000, &|i| if i % 2 == 0 { format!("line {i} Z") } else { format!("line {i}") });
    let t = Instant::now(); let (l, ad, de) = compute_line_diff(&a, &b);
    println!("@@budget_half\t{{\"add\":{ad},\"del\":{de},\"lines\":{},\"ms\":{}}}", l.len(), t.elapsed().as_millis());
}
