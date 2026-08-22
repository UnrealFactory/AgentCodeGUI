//! **파일 변경 미리보기** — `Write`/`Edit`/`MultiEdit` → `file-change` 이벤트의 재료.
//!
//! 2.6.2 `src/main/claude/diff.ts` + `src/shared/lineDiff.ts`의 이식이다. 규약을 그대로
//! 옮긴다(렌더러가 그 모양을 전제로 그린다 — `session.ts:677` `file-change` 리듀서):
//!
//!  - **전체 파일 diff**를 만든다. 조각이 아니라 파일 한 장을 보여 주고 바뀐 줄만
//!    표시하는 것이 뷰어(CmEditor 읽기 모드)의 계약이다.
//!  - **기준선은 런 첫 접촉의 디스크 내용**이다. 같은 파일을 여러 번 고치면 그 런의
//!    원본 대비 **누적** diff가 나온다.
//!  - `whole: true` — 렌더러가 이 경로의 이전 diff를 **대체**한다(누적이 이미 여기서 끝났다).
//!  - LF 정규화. CRLF가 라인 텍스트에 남으면 뷰어의 LF 문서와 전 줄 불일치가 되어
//!    파일 전체가 변경으로 칠해진다(2.6.2가 실제로 밟았던 버그).
//!
//! ## 크래시 규율 (메모리 「크래시 전면 수정 패스」 — diff DP OOM이 주범이었다)
//!
//! Myers O(ND)이고 **D·스텝 모두 하드 상한**이다. 상한을 넘으면 "전부 삭제 + 전부 추가"
//! 폴백으로 떨어진다 — 그 규모로 진짜 바뀐 파일의 정직한 표시다. 거대 파일은 읽기
//! 자체를 건너뛰고 요약 행 하나만 낸다(라인 배열이 IPC·스냅샷을 통째로 부풀린다).

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// 글자 수 상한 — 넘으면 미리보기를 접는다(2.6.2 `HUGE`).
const HUGE_CHARS: usize = 4_000_000;
/// UTF-8 최악(4바이트/자)으로도 위 상한을 확정적으로 넘는 바이트 크기.
const HUGE_BYTES_CERTAIN: u64 = 16_000_000;
const MAX_D: usize = 2000;
const STEP_BUDGET: usize = 64_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Op {
    Eq(usize, usize),
    Del(usize),
    Add(usize),
}

/// 두 줄 배열의 편집 스크립트. 공통 앞뒤를 먼저 잘라 국소 변경은 O(n)에 끝낸다.
fn line_ops(a: &[&str], b: &[&str]) -> Vec<Op> {
    let (n, m) = (a.len(), b.len());
    let cap = n.min(m);
    let mut p = 0;
    while p < cap && a[p] == b[p] {
        p += 1;
    }
    let mut s = 0;
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
        match myers(a, b, p, ma, mb, dmax) {
            Some(mid) => ops.extend(mid),
            None => {
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

/// 가운데 구간의 Myers 그리디 전진 + trace 역추적. D가 `dmax`를 넘으면 `None`.
fn myers(a: &[&str], b: &[&str], off: usize, n: usize, m: usize, dmax: usize) -> Option<Vec<Op>> {
    if dmax < 1 {
        return None;
    }
    let v_off = dmax as isize + 1;
    let mut v = vec![0isize; 2 * dmax + 3];
    let mut trace: Vec<Vec<isize>> = Vec::with_capacity(dmax + 1);
    let mut found: Option<usize> = None;
    'outer: for d in 0..=dmax {
        let di = d as isize;
        let mut k = -di;
        while k <= di {
            let idx = (v_off + k) as usize;
            let mut x = if k == -di || (k != di && v[idx - 1] < v[idx + 1]) {
                v[idx + 1]
            } else {
                v[idx - 1] + 1
            };
            let mut y = x - k;
            while (x as usize) < n && (y as usize) < m && a[off + x as usize] == b[off + y as usize] {
                x += 1;
                y += 1;
            }
            v[idx] = x;
            if x as usize >= n && y as usize >= m {
                trace.push(v[(v_off - di) as usize..=(v_off + di) as usize].to_vec());
                found = Some(d);
                break 'outer;
            }
            k += 2;
        }
        trace.push(v[(v_off - di) as usize..=(v_off + di) as usize].to_vec());
    }
    let big_d = found?;

    let mut rev: Vec<Op> = vec![];
    let mut x = n as isize;
    let mut y = m as isize;
    for d in (1..=big_d).rev() {
        let k = x - y;
        let vp = &trace[d - 1];
        let base = (d - 1) as isize;
        let at = |kk: isize| -> isize { vp[(kk + base) as usize] };
        let prev_k = if k == -(d as isize) || (k != d as isize && at(k - 1) < at(k + 1)) {
            k + 1
        } else {
            k - 1
        };
        let prev_x = at(prev_k);
        let prev_y = prev_x - prev_k;
        while x > prev_x && y > prev_y {
            x -= 1;
            y -= 1;
            rev.push(Op::Eq(off + x as usize, off + y as usize));
        }
        if prev_k == k + 1 {
            y -= 1;
            rev.push(Op::Add(off + y as usize));
        } else {
            x -= 1;
            rev.push(Op::Del(off + x as usize));
        }
    }
    while x > 0 && y > 0 {
        x -= 1;
        y -= 1;
        rev.push(Op::Eq(off + x as usize, off + y as usize));
    }
    rev.reverse();
    Some(group_runs(rev))
}

/// eq 사이의 변경 묶음마다 **del 전부 → add 전부**(🔴 위 → 🟢 아래 렌더 계약).
fn group_runs(ops: Vec<Op>) -> Vec<Op> {
    let mut out = Vec::with_capacity(ops.len());
    let mut dels: Vec<Op> = vec![];
    let mut adds: Vec<Op> = vec![];
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

fn split_lines(s: &str) -> Vec<&str> {
    let t = s.strip_suffix('\n').unwrap_or(s);
    if t.is_empty() {
        vec![]
    } else {
        t.split('\n').collect()
    }
}

pub struct LineDiff {
    pub lines: Vec<Value>,
    pub add: usize,
    pub del: usize,
}

pub fn compute_line_diff(old_text: &str, new_text: &str) -> LineDiff {
    let ao = norm_eol(old_text);
    let bo = norm_eol(new_text);
    let a = split_lines(&ao);
    let b = split_lines(&bo);
    let mut lines = Vec::with_capacity(a.len().max(b.len()));
    let (mut add, mut del) = (0usize, 0usize);
    for op in line_ops(&a, &b) {
        match op {
            Op::Eq(ai, _) => lines.push(json!({ "t": "ctx", "text": a[ai] })),
            Op::Del(ai) => {
                lines.push(json!({ "t": "del", "text": a[ai] }));
                del += 1;
            }
            Op::Add(bi) => {
                lines.push(json!({ "t": "add", "text": b[bi] }));
                add += 1;
            }
        }
    }
    LineDiff { lines, add, del }
}

fn new_file_diff(content: &str) -> LineDiff {
    let lf = norm_eol(content);
    let body = split_lines(&lf);
    let mut lines = vec![json!({ "t": "hunk", "text": format!("@@ 새 파일 +1,{} @@", body.len()) })];
    for l in &body {
        lines.push(json!({ "t": "add", "text": l }));
    }
    LineDiff { lines, add: body.len(), del: 0 }
}

pub fn norm_eol(s: &str) -> String {
    s.replace("\r\n", "\n")
}

/// `Edit` 도구와 **같은 방식**의 치환 — 리터럴 첫 일치(또는 전부). 정규식이 아니다.
fn apply_edit(text: &str, old: &str, new: &str, all: bool) -> String {
    if old.is_empty() {
        return text.to_string();
    }
    if all {
        return text.replace(old, new);
    }
    match text.find(old) {
        Some(i) => format!("{}{}{}", &text[..i], new, &text[i + old.len()..]),
        None => text.to_string(),
    }
}

/// 작업 폴더 기준 상대 경로(표시용). 밖이면 원래 경로 그대로 — 슬래시로 통일한다.
pub fn to_rel(cwd: &str, p: &str) -> String {
    if p.is_empty() {
        return String::new();
    }
    let path = Path::new(p);
    if path.is_absolute() && !cwd.is_empty() {
        if let Ok(rel) = path.strip_prefix(Path::new(cwd)) {
            let r = rel.to_string_lossy().replace('\\', "/");
            if !r.is_empty() {
                return r;
            }
        }
    }
    p.replace('\\', "/")
}

/// **보류된 파일 변경 1건.** 도구가 *성공한 뒤에야* 이벤트로 나간다 — 거부/실패한
/// 편집이 유령 diff를 남기지 않게(2.6.2 `handleToolResult`의 규약 그대로).
pub struct PendingChange {
    pub file: Value,
    pub diff: Value,
    pub whole: bool,
    /// 절대 경로 + "런에서 새로 태어난 파일인가". 2.6.2는 이 둘로 **살아 있는 LSP 서버에
    /// 디스크 변화를 통지**했다(`lspManager.notifyWatchedFiles`, `engine.ts:2118`).
    /// 3.0 셸에는 아직 LSP가 없어 소비자가 없다 — 값은 정확히 채워 두고, LSP가 붙는
    /// 라운드에 그 한 줄만 연결한다(조용히 빠뜨리지 않기 위해 필드로 남긴다).
    #[allow(dead_code)]
    pub abs: PathBuf,
    #[allow(dead_code)]
    pub is_new: bool,
}

/// 런 하나 동안의 파일 기준선 — 같은 파일의 두 번째 편집이 **런 원본 대비**로 나온다.
#[derive(Default)]
pub struct Baselines(HashMap<PathBuf, Option<String>>);

impl Baselines {
    pub fn clear(&mut self) {
        self.0.clear();
    }
}

fn read_disk(abs: &Path) -> Option<String> {
    std::fs::read_to_string(abs).ok()
}

fn stat_size(abs: &Path) -> u64 {
    std::fs::metadata(abs).map(|m| m.len()).unwrap_or(0)
}

/// `Write`/`Edit`/`MultiEdit`의 입력 → 보류 변경.
///
/// 디스크는 **도구가 실행되기 전**에 읽는다(우리가 프레임을 먼저 본다) — 그 값이
/// 이 도구의 `cur`이고, 런 첫 접촉이면 기준선이 된다.
pub fn build_pending(
    base: &mut Baselines,
    name: &str,
    input: &Value,
    cwd: &str,
) -> Option<PendingChange> {
    let fp = input.get("file_path").and_then(Value::as_str).unwrap_or("");
    if fp.is_empty() {
        return None;
    }
    let abs = if Path::new(fp).is_absolute() {
        PathBuf::from(fp)
    } else {
        Path::new(cwd).join(fp)
    };
    let rel = to_rel(cwd, fp);

    // stat 먼저 — 어차피 접힐 파일은 통째 읽기 자체를 생략한다(수십 MB 편집이
    // 프레임 루프를 읽기 시간만큼 막던 자리).
    let huge_on_disk = stat_size(&abs) >= HUGE_BYTES_CERTAIN;
    let cur: Option<String> = if huge_on_disk { None } else { read_disk(&abs).map(|s| norm_eol(&s)) };

    let next = match name {
        "Write" => norm_eol(input.get("content").and_then(Value::as_str).unwrap_or("")),
        "Edit" => apply_edit(
            cur.as_deref().unwrap_or(""),
            &norm_eol(input.get("old_string").and_then(Value::as_str).unwrap_or("")),
            &norm_eol(input.get("new_string").and_then(Value::as_str).unwrap_or("")),
            input.get("replace_all").and_then(Value::as_bool).unwrap_or(false),
        ),
        _ => {
            let mut t = cur.clone().unwrap_or_default();
            if let Some(edits) = input.get("edits").and_then(Value::as_array) {
                for e in edits {
                    t = apply_edit(
                        &t,
                        &norm_eol(e.get("old_string").and_then(Value::as_str).unwrap_or("")),
                        &norm_eol(e.get("new_string").and_then(Value::as_str).unwrap_or("")),
                        e.get("replace_all").and_then(Value::as_bool).unwrap_or(false),
                    );
                }
            }
            t
        }
    };

    // 거대 파일 — 라인 배열이 위험 그 자체다. 요약 행 하나로 접는다.
    if huge_on_disk || cur.as_ref().map(|c| c.chars().count()).unwrap_or(0) > HUGE_CHARS || next.chars().count() > HUGE_CHARS {
        base.0.remove(&abs);
        let tag = if cur.is_none() && !huge_on_disk { "new" } else { "edit" };
        let lines = vec![json!({ "t": "hunk", "text": "@@ 파일이 너무 커서 변경 미리보기를 생략했어요 @@" })];
        return Some(PendingChange {
            file: json!({ "path": rel, "add": 0, "del": 0, "tag": tag }),
            diff: json!({ "path": rel, "tag": tag, "add": 0, "del": 0, "lines": lines }),
            whole: true,
            abs,
            is_new: tag == "new",
        });
    }

    base.0.entry(abs.clone()).or_insert_with(|| cur.clone());
    let baseline = base.0.get(&abs).cloned().flatten();

    match baseline {
        None => {
            let d = new_file_diff(&next);
            Some(PendingChange {
                file: json!({ "path": rel, "add": d.add, "del": 0, "tag": "new" }),
                diff: json!({ "path": rel, "tag": "new", "add": d.add, "del": 0, "lines": d.lines }),
                whole: true,
                abs,
                // 런에서 태어난 파일의 **후속** 편집은 created를 다시 알리지 않는다.
                is_new: cur.is_none(),
            })
        }
        Some(b) => {
            let d = compute_line_diff(&b, &next);
            Some(PendingChange {
                file: json!({ "path": rel, "add": d.add, "del": d.del, "tag": "edit" }),
                diff: json!({ "path": rel, "tag": "edit", "add": d.add, "del": d.del, "lines": d.lines }),
                whole: true,
                abs,
                is_new: false,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(d: &LineDiff) -> Vec<String> {
        d.lines
            .iter()
            .map(|l| format!("{}:{}", l["t"].as_str().unwrap(), l["text"].as_str().unwrap()))
            .collect()
    }

    #[test]
    fn one_changed_line_in_a_long_file_is_one_add_and_one_del() {
        let a: String = (0..500).map(|i| format!("line {i}\n")).collect();
        let b = a.replace("line 250\n", "line 250 CHANGED\n");
        let d = compute_line_diff(&a, &b);
        assert_eq!((d.add, d.del), (1, 1), "국소 변경이 전체 초록으로 뭉개지면 안 된다");
        assert_eq!(d.lines.len(), 501);
    }

    #[test]
    fn deletions_come_before_additions_in_a_run() {
        let d = compute_line_diff("a\nb\nc\n", "a\nB\nc\n");
        assert_eq!(texts(&d), vec!["ctx:a", "del:b", "add:B", "ctx:c"]);
    }

    #[test]
    fn crlf_is_normalised_so_the_viewer_does_not_paint_everything() {
        let d = compute_line_diff("a\r\nb\r\n", "a\nb\n");
        assert_eq!((d.add, d.del), (0, 0), "개행 표기만 다른 것은 변경이 아니다");
    }

    #[test]
    fn a_write_to_a_missing_path_is_an_all_added_new_file() {
        let mut base = Baselines::default();
        let dir = std::env::temp_dir().join(format!("ccg-diff-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let p = dir.join("brand-new.txt");
        let _ = std::fs::remove_file(&p);
        let pc = build_pending(
            &mut base,
            "Write",
            &json!({ "file_path": p.to_string_lossy(), "content": "x\ny\n" }),
            &dir.to_string_lossy(),
        )
        .expect("보류 변경");
        assert_eq!(pc.file["tag"], "new");
        assert_eq!(pc.file["add"], 2);
        assert!(pc.is_new);
        assert_eq!(pc.diff["path"], "brand-new.txt", "표시는 작업 폴더 상대 경로다");
    }

    #[test]
    fn a_second_edit_diffs_against_the_runs_baseline_not_the_previous_step() {
        let dir = std::env::temp_dir().join(format!("ccg-diff2-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let p = dir.join("acc.txt");
        std::fs::write(&p, "a\nb\nc\n").unwrap();
        let mut base = Baselines::default();
        let one = build_pending(
            &mut base,
            "Edit",
            &json!({ "file_path": p.to_string_lossy(), "old_string": "a", "new_string": "A" }),
            &dir.to_string_lossy(),
        )
        .unwrap();
        assert_eq!(one.file["add"], 1);
        // 도구가 실제로 썼다고 치고 디스크를 갱신한다.
        std::fs::write(&p, "A\nb\nc\n").unwrap();
        let two = build_pending(
            &mut base,
            "Edit",
            &json!({ "file_path": p.to_string_lossy(), "old_string": "c", "new_string": "C" }),
            &dir.to_string_lossy(),
        )
        .unwrap();
        assert_eq!(two.file["add"], 2, "런 원본 대비 누적: a→A, c→C");
        assert_eq!(two.file["tag"], "edit");
        let _ = std::fs::remove_file(&p);
    }
}
