//! 라인 diff — `src/shared/lineDiff.ts`(Myers 코어) + `src/main/claude/diff.ts`의 이식.
//!
//! **왜 Myers인가**(2.6.2 헤더의 실측 결론을 그대로 옮긴다): 예전 LCS DP는 메모리가
//! "변경 구간 가로×세로"라 큰 파일의 서로 먼 두 곳 수정(위 import + 아래 함수, +3줄)만으로
//! 셀 캡을 넘어 전부 삭제+전부 추가(=전체 초록)로 뭉개졌고, 캡을 풀면 V8이 잡을 수 없는
//! OOM abort로 **메인 프로세스째** 죽었다. Myers는 비용이 실제 변경량 D에 비례해 그 경우
//! D=3으로 즉시 정확한 답이 나오고, 아래 두 상한이 전부 하드 바운드라 그 크래시 가족이
//! 원천적으로 안 난다.
//!
//! Rust에도 그대로 필요한 이유: 릴리즈 프로파일이 `panic = "abort"`다. 여기서 할당이
//! 터지거나 인덱스가 빗나가면 2.6.2와 똑같이 창이 사라진다 — 상한은 장식이 아니다.

use serde::Serialize;

/// D 상한 — 경로 복원(trace) 메모리가 (D+1)² i32 ≤ 16MB로 물리적으로 확정된다.
const MAX_D: usize = 2000;
/// (N+M)·D 근사 스텝 예산. N+M이 크면 D 상한이 비례로 줄어 시간도 상한된다
/// (예: 가운데 구간 40만 줄이면 D≤160 — 그 이상 바뀌었으면 폴백).
const STEP_BUDGET: usize = 64_000_000;

/// 뷰어 계약(`protocol.ts DiffLine`) 그대로 — `t`는 add·del·ctx·hunk.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct DiffLine {
    pub t: &'static str,
    pub text: String,
}

/// `protocol.ts FileDiff`. `tag`는 new(새 파일 전체 추가)·edit.
#[derive(Serialize, Clone, Debug)]
pub struct FileDiff {
    pub path: String,
    pub tag: &'static str,
    pub add: usize,
    pub del: usize,
    pub lines: Vec<DiffLine>,
}

/// 편집 스크립트 한 조각. 인덱스는 원본 배열 기준이며 eq/del의 `ai`, eq/add의 `bi`가
/// 각각 0..n-1, 0..m-1을 순서대로 정확히 한 번씩 지난다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Op {
    Eq(usize, usize),
    Del(usize),
    Add(usize),
}

/// 두 줄 배열의 편집 스크립트. 수정된 줄 묶음은 항상 del 전부 → add 전부 순서
/// (🔴 옛것 위 → 🟢 새것 아래 렌더 계약).
pub fn diff_line_ops(a: &[&str], b: &[&str]) -> Vec<Op> {
    let n = a.len();
    let m = b.len();
    // 공통 앞뒤 줄을 먼저 잘라 국소 변경은 O(n)으로 끝낸다 — Myers는 잘린 가운데만 본다
    let cap = n.min(m);
    let mut p = 0usize;
    while p < cap && a[p] == b[p] {
        p += 1;
    }
    let mut s = 0usize;
    while s < cap - p && a[n - 1 - s] == b[m - 1 - s] {
        s += 1;
    }
    let ma = n - s - p;
    let mb = m - s - p;

    let mut ops: Vec<Op> = Vec::with_capacity(n.max(m));
    for i in 0..p {
        ops.push(Op::Eq(i, i));
    }
    if ma == 0 {
        for j in 0..mb {
            ops.push(Op::Add(p + j));
        }
    } else if mb == 0 {
        for i in 0..ma {
            ops.push(Op::Del(p + i));
        }
    } else {
        let dmax = MAX_D.min(STEP_BUDGET / (ma + mb));
        match myers_ops(a, b, p, ma, mb, dmax) {
            Some(mid) => ops.extend(mid),
            None => {
                // 상한 초과 폴백 — 그 규모로 진짜 바뀐 파일의 정직한 표시
                for i in 0..ma {
                    ops.push(Op::Del(p + i));
                }
                for j in 0..mb {
                    ops.push(Op::Add(p + j));
                }
            }
        }
    }
    for k in 0..s {
        ops.push(Op::Eq(n - s + k, m - s + k));
    }
    ops
}

/// 가운데(공통 앞뒤 제거 후) 구간의 Myers 그리디 전진 + trace 역추적.
/// `off` = 구간 시작의 원본 인덱스, `n`·`m` = 구간 길이. D가 `dmax`를 넘으면 None(폴백).
fn myers_ops(a: &[&str], b: &[&str], off: usize, n: usize, m: usize, dmax: usize) -> Option<Vec<Op>> {
    if dmax < 1 {
        return None;
    }
    // v[k] = 대각선 k(=x−y)에서 도달한 최장 x. 창 [-dmax..dmax]를 오프셋으로 편다.
    let v_off = (dmax + 1) as isize;
    let mut v = vec![0i32; 2 * dmax + 3];
    let at = |i: isize| -> usize { i as usize };
    // trace[d] = d 단계 종료 시점 v의 [-d..d] 창 사본 — 총 (D+1)² i32 ≤ 16MB(D=2000)
    let mut trace: Vec<Box<[i32]>> = Vec::new();
    let mut big_d: isize = -1;
    'outer: for d in 0..=dmax as isize {
        let mut k = -d;
        while k <= d {
            let mut x: i32 = if k == -d || (k != d && v[at(v_off + k - 1)] < v[at(v_off + k + 1)]) {
                v[at(v_off + k + 1)]
            } else {
                v[at(v_off + k - 1)] + 1
            };
            let mut y: i32 = x - k as i32;
            while (x as usize) < n && (y as usize) < m && a[off + x as usize] == b[off + y as usize] {
                x += 1;
                y += 1;
            }
            v[at(v_off + k)] = x;
            if x as usize >= n && y as usize >= m {
                trace.push(v[at(v_off - d)..at(v_off + d + 1)].to_vec().into_boxed_slice());
                big_d = d;
                break 'outer;
            }
            k += 2;
        }
        trace.push(v[at(v_off - d)..at(v_off + d + 1)].to_vec().into_boxed_slice());
    }
    if big_d < 0 {
        return None;
    }

    // 역추적 — 끝(n,m)에서 (0,0)까지. 이동 1회 = del(오른쪽) 또는 add(아래쪽) 1개.
    let mut rev: Vec<Op> = Vec::new();
    let mut x = n as isize;
    let mut y = m as isize;
    let mut d = big_d;
    while d > 0 {
        let k = x - y;
        let vp = &trace[(d - 1) as usize]; // 창 [-(d-1)..d-1], 인덱스 = k' + (d-1)
        // k == ±d에서 단락되므로 아래 두 인덱스는 항상 창 안이다(원본 JS와 같은 이유).
        let prev_k = if k == -d || (k != d && vp[(k - 1 + (d - 1)) as usize] < vp[(k + 1 + (d - 1)) as usize]) {
            k + 1
        } else {
            k - 1
        };
        let prev_x = vp[(prev_k + (d - 1)) as usize] as isize;
        let prev_y = prev_x - prev_k;
        while x > prev_x && y > prev_y {
            x -= 1;
            y -= 1;
            rev.push(Op::Eq(off + x as usize, off + y as usize));
        }
        if prev_k == k + 1 {
            y -= 1; // 아래 이동 = b[prev_y] 삽입
            rev.push(Op::Add(off + y as usize));
        } else {
            x -= 1; // 오른쪽 이동 = a[prev_x] 삭제
            rev.push(Op::Del(off + x as usize));
        }
        d -= 1;
    }
    while x > 0 && y > 0 {
        x -= 1;
        y -= 1;
        rev.push(Op::Eq(off + x as usize, off + y as usize));
    }
    rev.reverse();
    Some(group_runs(rev))
}

/// eq 사이의 변경 묶음마다 del 전부 → add 전부로 재배열(같은 편집 스크립트의 유효한
/// 재배열: del은 a열, add는 b열을 각자 소비한다).
fn group_runs(ops: Vec<Op>) -> Vec<Op> {
    let mut out: Vec<Op> = Vec::with_capacity(ops.len());
    let mut dels: Vec<Op> = Vec::new();
    let mut adds: Vec<Op> = Vec::new();
    for op in ops {
        match op {
            Op::Eq(..) => {
                out.append(&mut dels);
                out.append(&mut adds);
                out.push(op);
            }
            Op::Del(_) => dels.push(op),
            Op::Add(_) => adds.push(op),
        }
    }
    out.append(&mut dels);
    out.append(&mut adds);
    out
}

/// CRLF → LF 정규화 + 끝의 개행 하나 제거 후 줄 배열. diff는 표시용이고 렌더러(CM 문서)는
/// LF 기준이다 — '\r'이 라인 텍스트에 남으면 읽기 모드의 부모 복원(cmDiff oldLines)이
/// LF 문서와 전 줄 불일치가 되어 파일 전체가 변경으로 칠해진다.
fn to_lines(text: &str) -> Vec<&str> {
    // `\r\n` 없는 흔한 경우엔 복사를 안 하려고 borrow를 유지한다 → 호출부가 String을 준비.
    let t = text.strip_suffix('\n').unwrap_or(text);
    if t.is_empty() {
        Vec::new()
    } else {
        t.split('\n').collect()
    }
}

fn normalize(text: &str) -> String {
    if text.contains('\r') { text.replace("\r\n", "\n") } else { text.to_string() }
}

/// 전체 파일 라인 diff. 2.6.2 `computeLineDiff`와 같은 답을 돌려준다.
pub fn compute_line_diff(old_text: &str, new_text: &str) -> (Vec<DiffLine>, usize, usize) {
    let ao = normalize(old_text);
    let bo = normalize(new_text);
    let a = to_lines(&ao);
    let b = to_lines(&bo);

    let mut lines: Vec<DiffLine> = Vec::new();
    let mut add = 0usize;
    let mut del = 0usize;
    for op in diff_line_ops(&a, &b) {
        match op {
            Op::Eq(ai, _) => lines.push(DiffLine { t: "ctx", text: a[ai].to_string() }),
            Op::Del(ai) => {
                lines.push(DiffLine { t: "del", text: a[ai].to_string() });
                del += 1;
            }
            Op::Add(bi) => {
                lines.push(DiffLine { t: "add", text: b[bi].to_string() });
                add += 1;
            }
        }
    }
    (lines, add, del)
}

/// 새로 생긴 파일의 전부-추가 diff (2.6.2 `newFileDiff`).
pub fn new_file_diff(content: &str) -> (Vec<DiffLine>, usize) {
    let lf = normalize(content);
    let body = to_lines(&lf);
    let mut lines: Vec<DiffLine> = Vec::with_capacity(body.len() + 1);
    lines.push(DiffLine {
        t: "hunk",
        text: crate::t(
            &format!("@@ 새 파일 +1,{} @@", body.len()),
            &format!("@@ New file +1,{} @@", body.len()),
        ),
    });
    for text in &body {
        lines.push(DiffLine { t: "add", text: (*text).to_string() });
    }
    let n = body.len();
    (lines, n)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(lines: &[DiffLine]) -> String {
        lines.iter().map(|l| l.t.chars().next().unwrap()).collect()
    }

    #[test]
    fn identical_files_are_all_context() {
        let (lines, add, del) = compute_line_diff("a\nb\nc\n", "a\nb\nc\n");
        assert_eq!((add, del), (0, 0));
        assert_eq!(kinds(&lines), "ccc");
    }

    #[test]
    fn single_insert_is_one_add() {
        let (lines, add, del) = compute_line_diff("a\nc\n", "a\nb\nc\n");
        assert_eq!((add, del), (1, 0));
        assert_eq!(kinds(&lines), "cac");
    }

    #[test]
    fn single_delete_is_one_del() {
        let (lines, add, del) = compute_line_diff("a\nb\nc\n", "a\nc\n");
        assert_eq!((add, del), (0, 1));
        assert_eq!(kinds(&lines), "cdc");
    }

    #[test]
    fn changed_line_is_del_then_add() {
        // 렌더 계약: 같은 묶음에서 🔴 옛것이 먼저, 🟢 새것이 뒤
        let (lines, add, del) = compute_line_diff("a\nX\nc\n", "a\nY\nc\n");
        assert_eq!((add, del), (1, 1));
        assert_eq!(kinds(&lines), "cdac");
    }

    /// 예전 LCS DP가 통째로 뭉갰던 바로 그 모양 — 큰 파일 + 서로 먼 두 곳 수정.
    /// Myers는 D가 작아 정확히 그 줄만 나와야 한다.
    #[test]
    fn far_apart_edits_in_a_big_file_stay_precise() {
        let mut a: Vec<String> = (0..20_000).map(|i| format!("line {i}")).collect();
        let mut b = a.clone();
        b[3] = "line 3 CHANGED".into();
        b[19_000] = "line 19000 CHANGED".into();
        a.push(String::new());
        b.push(String::new());
        let (lines, add, del) = compute_line_diff(&a.join("\n"), &b.join("\n"));
        assert_eq!((add, del), (2, 2), "먼 두 곳 수정은 정확히 2/2여야 한다(전체 초록 금지)");
        assert_eq!(lines.iter().filter(|l| l.t == "ctx").count(), 19_998);
    }

    /// D 상한 초과 = 전부 삭제 + 전부 추가 폴백. 크래시 없이 끝나는 게 계약이다.
    #[test]
    fn beyond_the_d_cap_falls_back_instead_of_exploding() {
        let a: String = (0..6_000).map(|i| format!("a{i}\n")).collect();
        let b: String = (0..6_000).map(|i| format!("b{i}\n")).collect();
        let (lines, add, del) = compute_line_diff(&a, &b);
        assert_eq!((add, del), (6_000, 6_000));
        assert_eq!(lines.len(), 12_000);
        assert!(lines.iter().take(6_000).all(|l| l.t == "del"), "폴백은 del 전부 → add 전부");
    }

    /// 스텝 예산 — 아주 긴 파일에서 D 상한이 비례 축소돼도 답이 나오고 시간이 유한하다.
    #[test]
    fn huge_file_with_tiny_change_is_still_exact() {
        let a: Vec<String> = (0..300_000).map(|i| format!("l{i}")).collect();
        let mut b = a.clone();
        b[150_000] = "l150000!".into();
        let (_, add, del) = compute_line_diff(&a.join("\n"), &b.join("\n"));
        assert_eq!((add, del), (1, 1));
    }

    #[test]
    fn crlf_is_normalized_so_the_viewer_sees_lf_lines() {
        let (lines, add, del) = compute_line_diff("a\r\nb\r\n", "a\r\nb\r\n");
        assert_eq!((add, del), (0, 0));
        assert!(lines.iter().all(|l| !l.text.contains('\r')));
    }

    #[test]
    fn empty_to_content_is_all_add() {
        let (lines, add, del) = compute_line_diff("", "x\ny\n");
        assert_eq!((add, del), (2, 0));
        assert_eq!(kinds(&lines), "aa");
    }

    #[test]
    fn new_file_diff_has_a_hunk_header_then_all_adds() {
        let (lines, add) = new_file_diff("x\ny\n");
        assert_eq!(add, 2);
        assert_eq!(lines[0].t, "hunk");
        assert_eq!(kinds(&lines), "haa");
    }

    /// 편집 스크립트의 불변식: eq/del의 ai, eq/add의 bi가 각각 0..n-1, 0..m-1을
    /// 순서대로 정확히 한 번씩 지난다(뷰어의 부모 복원이 이걸 믿는다).
    #[test]
    fn ops_cover_both_sides_exactly_once_in_order() {
        let a: Vec<&str> = "the quick brown fox jumps over the lazy dog".split(' ').collect();
        let b: Vec<&str> = "the quick red fox leaps over a lazy dog today".split(' ').collect();
        let ops = diff_line_ops(&a, &b);
        let mut ai = 0usize;
        let mut bi = 0usize;
        for op in &ops {
            match *op {
                Op::Eq(x, y) => {
                    assert_eq!((x, y), (ai, bi));
                    ai += 1;
                    bi += 1;
                }
                Op::Del(x) => {
                    assert_eq!(x, ai);
                    ai += 1;
                }
                Op::Add(y) => {
                    assert_eq!(y, bi);
                    bi += 1;
                }
            }
        }
        assert_eq!((ai, bi), (a.len(), b.len()));
    }
}
