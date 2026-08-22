//! ccg-fs — 탐색기·코드 뷰어·Git 카드가 서는 데 필요한 파일/Git 도메인.
//!
//! **원본은 2.6.2다**: `src/main/files.ts`(트리·@ 멘션 목록), `src/main/index.ts`의 fs
//! 핸들러(읽기·쓰기·이름변경·삭제·이동·생성), `src/main/git.ts`(시스템 git CLI 래퍼),
//! `src/shared/lineDiff.ts` + `src/main/claude/diff.ts`(Myers 라인 diff). 여기는 그
//! 의미론을 Rust로 옮긴 미러이고, 상한·정렬·에러 문구까지 같은 값을 쓴다 — 렌더러
//! 33k LOC가 2.6.2와 같은 답을 받아야 화면이 같아지기 때문이다.
//!
//! ── 크래시 규율(이식 대상 1순위) ────────────────────────────────────────────
//! 2.6.2에서 메인 프로세스를 통째로 죽인 사고가 diff였다(LCS DP가 변경 구간
//! 가로×세로만큼 할당 → V8이 못 잡는 OOM abort = 0x80000003). 그 답이 Myers
//! O(ND) + **하드 상한 3종**이고, 이 크레이트는 그 상한을 한 글자도 안 바꾼다:
//!   - `diff::MAX_D` 2000       — 경로 복원 메모리 (D+1)² i32 ≤ 16MB로 물리 확정
//!   - `diff::STEP_BUDGET` 64M  — (N+M)·D 근사 스텝 예산. 초대형 입력은 D 상한이 비례 축소
//!   - `git::MAX_DIFF_BYTES` 1.5MB/쪽 · 바이너리(NUL) 감지 — 넘으면 diff 자체를 접는다
//!
//! 여기에 3.0이 하나 더한 것: `git::MAX_OUTPUT` — git stdout을 32MB에서 끊고 자식을
//! 죽인다(Node `execFile`의 maxBuffer 32MB와 같은 자리. Rust `output()`은 무제한이라
//! 이 캡이 없으면 거대 blob 하나가 프로세스 메모리를 그대로 먹는다).
//!
//! ── 변경 통지(감시) 규약 ────────────────────────────────────────────────────
//! **OS 워처는 두지 않는다** — 2.6.2도 탐색기용 파일 워처가 없다(`fs.watch`는 LSP
//! 내부 전용). 트리는 렌더러가 다시 물어보는 순간 갱신된다:
//!   1) 턴 종료 → `refreshKey` 증가 → 루트 + 펼쳐진 폴더만 `fs:list-dir` 재조회
//!   2) 탐색기 파일 작업(이름변경·삭제·생성·이동) 성공 → 그 자리에서 재조회
//!   3) Git 스트립 → `ccg-git-changed` 창 이벤트 + `refreshKey`로 `git:status` 재조회
//!
//! 즉 통지는 **폴 기반(요청 시점 최신)** 이고, 이 크레이트의 모든 조회는 캐시 없이
//! 매번 디스크를 읽는다(캐시가 있으면 위 세 경로가 낡은 값을 보게 된다).

pub mod collate;
pub mod diff;
pub mod dir;
pub mod file;
pub mod git;
pub mod serve;

/// 표시 언어 — 2.6.2 `src/main/lang.ts`의 `t(ko, en)`과 같은 문법.
///
/// 원본은 ui-prefs의 `ui.lang`이다. 2.6.2는 `ui-prefs:save` 핸들러가 캐시를 갱신했는데
/// 3.0의 그 핸들러는 다른 모듈(`ipc/stores.rs`) 소유라 훅을 걸 수 없다 → **짧은 TTL
/// 캐시**로 대신한다. `t()`는 실패 경로에서만 불리므로(성공 응답에는 문구가 없다)
/// 2초에 한 번 작은 JSON을 읽는 비용은 사실상 0이고, 설정에서 언어를 바꾸면 다음
/// 오류부터 바로 따라온다.
pub fn t(ko: &str, en: &str) -> String {
    if is_en() { en.to_string() } else { ko.to_string() }
}

fn is_en() -> bool {
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static CACHED: AtomicBool = AtomicBool::new(false);
    static AT_MS: AtomicU64 = AtomicU64::new(0);
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let at = AT_MS.load(Ordering::Relaxed);
    if at != 0 && now.saturating_sub(at) < 2000 {
        return CACHED.load(Ordering::Relaxed);
    }
    let en = ccg_store::prefs::read_ui_prefs()
        .get("ui.lang")
        .and_then(serde_json::Value::as_str)
        == Some("en");
    CACHED.store(en, Ordering::Relaxed);
    AT_MS.store(now.max(1), Ordering::Relaxed);
    en
}

// ── 경로 해석 — 2.6.2 핸들러들이 공유하던 한 줄을 한 곳으로 ────────────────────

use std::path::{Path, PathBuf};

/// `relPath`가 절대면 그대로, 아니면 `cwd` 기준. 2.6.2의
/// `path.isAbsolute(a.relPath) ? a.relPath : path.join(a.cwd || '', a.relPath)` 그대로다.
/// (채팅의 bash 테일 미리보기가 절대 경로를 그대로 넘긴다 — Chat.tsx:3012)
pub fn resolve_rel(cwd: &str, rel: &str) -> PathBuf {
    let p = Path::new(rel);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        Path::new(cwd).join(rel)
    }
}

/// `root` 밖으로 못 나가게 — 조작된 `../`로 아무 데나 훑는 걸 막는다.
/// 2.6.2 `git.ts absOf` · `files.ts listDir`의 루트 가드와 같은 판정.
pub fn inside(root: &Path, abs: &Path) -> bool {
    abs == root || abs.starts_with(root)
}

/// Node `path.resolve`와 같은 **어휘적** 정규화 — 디스크를 안 만지고 `.`/`..`를 접는다.
///
/// `std::path::absolute`에 맡기지 않는 이유: Windows(GetFullPathNameW)는 `..`를 접는데
/// **Unix는 안 접는다**(문서화된 차이). 그러면 `rel="../.."`이 `root/../..` 그대로 남아
/// `starts_with(root)`가 참이 되어 루트 가드가 통째로 뚫린다. 판정이 플랫폼마다 다르면
/// 안 되는 자리라 직접 접는다.
pub fn resolve_lexical(base: &Path, rel: &str) -> PathBuf {
    use std::path::Component;
    let joined = if rel.is_empty() { base.to_path_buf() } else { base.join(rel) };
    let mut out = PathBuf::new();
    for c in joined.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                // 루트/프리픽스는 못 넘어간다(`C:\..` = `C:\`) — GetFullPathNameW와 같다
                if matches!(out.components().next_back(), Some(Component::Normal(_))) {
                    out.pop();
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}
