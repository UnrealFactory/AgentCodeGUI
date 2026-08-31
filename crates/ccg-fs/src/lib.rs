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

pub mod attach;
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
/// 캐시**로 대신한다. 2초에 한 번 작은 JSON을 읽는 비용은 사실상 0이고, 설정에서
/// 언어를 바꾸면 그 다음 문구부터 바로 따라온다.
///
/// ★SMALL3 R1 정정: 초판 주석은 "`t()`는 실패 경로에서만 불린다"고 적었는데 더는
/// 사실이 아니다 — 첨부 대화상자(`ipc/parity/dialog.rs`)가 **성공 경로**에서 문구 넷을
/// 이걸로 만든다. 회계는 그대로다(창을 여는 순간 넷이 같은 2초 창 안에 들어가므로
/// 디스크 읽기는 많아야 1회). 다만 **캐시가 프로세스 전역**이라는 성질은 남아서,
/// 두 언어를 한 프로세스에서 재려는 테스트는 반드시 프로세스를 갈라야 한다
/// (`dialog.rs`의 `the_dialog_labels_follow_ui_lang`이 그래서 자식을 띄운다).
/// **회계 말고 순서**에 관한 성질은 아래 `lang_pack`의 주석에 따로 적었다(SMALL3 R2 D4).
pub fn t(ko: &str, en: &str) -> String {
    if is_en() { en.to_string() } else { ko.to_string() }
}

/// 캐시 수명. 2.6.2에는 없던 값이다(그쪽은 저장 핸들러가 캐시를 직접 갱신했다).
const LANG_TTL_MS: u64 = 2000;

/// 신선도(ms)와 값(1비트)을 **한 워드**에 담는다.
///
/// ★SMALL3 R2(확인 크리틱 D4). 초판은 `AtomicBool` + `AtomicU64` **둘**이었고 넷 다
/// `Relaxed`였다 — 한 스레드가 쓴 새 시각을 다른 스레드가 먼저 보고 **옛 값**을 읽는
/// 순서가 막혀 있지 않았다(찢어진 관측). 피해는 "최대 2초 동안 한 번 틀린 언어"로
/// 작지만, R1이 이 함수를 실패 경로에서 **사용자가 보는 성공 경로**로 끌어올려
/// 도달성이 커졌다. 값이 싸므로 근거를 적는 대신 **닫았다**.
///
/// 하나로 합치면 `Release`/`Acquire`도 펜스도 필요 없다 — 단일 원자의 로드/스토어는
/// 그 자체가 쪼개지지 않으므로 **신선도와 값이 언제나 같은 세대**로 관측된다.
/// (여전히 두 스레드가 동시에 갱신하면 마지막 쓰기가 이긴다. 그건 결함이 아니다 —
/// 둘 다 같은 파일을 읽었고 답이 같다.)
///
/// 밀리초는 상위 63비트로 민다: `2^63 ms ≈ 2.9억 년`이라 `as_millis() as u64`가
/// 이 자리를 넘칠 일은 없다. `at_ms == 0`은 **아직 한 번도 안 읽음**의 표식이라
/// 비워 둔다(그래서 저장할 때 `now.max(1)`을 쓴다).
const fn lang_pack(at_ms: u64, en: bool) -> u64 {
    (at_ms << 1) | (en as u64)
}
const fn lang_unpack(cell: u64) -> (u64, bool) {
    (cell >> 1, cell & 1 == 1)
}

/// 캐시가 아직 쓸 만한가.
///
/// ★SMALL3 R3(확인 크리틱 R2의 R2-D3). 이 판정은 `is_en()` 안에 인라인으로 있었고,
/// 그래서 **`LANG_TTL_MS` 값 자체에는 못이 없었다** — 크리틱이 2000을 60000으로 바꿔
/// 봤더니 `cargo test -p ccg-fs`가 102/0/2로 **전부 통과**했다. 사용자 체감은 "설정에서
/// 언어를 바꿔도 1분 동안 옛 언어"인데 아무도 안 붉어졌다는 뜻이다.
/// 순수 함수로 떼어 내면 시계도 전역 캐시도 없이 경계값을 잴 수 있다(아래 못).
///
/// `at_ms == 0`은 **한 번도 안 읽음**의 표식이라 언제나 낡은 것으로 본다.
const fn lang_fresh(at_ms: u64, now_ms: u64) -> bool {
    at_ms != 0 && now_ms.saturating_sub(at_ms) < LANG_TTL_MS
}

fn is_en() -> bool {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static CELL: AtomicU64 = AtomicU64::new(0);
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let (at, cached) = lang_unpack(CELL.load(Ordering::Relaxed));
    if lang_fresh(at, now) {
        return cached;
    }
    let en = ccg_store::prefs::read_ui_prefs()
        .get("ui.lang")
        .and_then(serde_json::Value::as_str)
        == Some("en");
    CELL.store(lang_pack(now.max(1), en), Ordering::Relaxed);
    en
}

#[cfg(test)]
mod lang_cache_tests {
    use super::{lang_pack, lang_unpack};

    /// 못 — 신선도와 값이 **한 워드로 같이** 다닌다(왕복이 손실 없음).
    /// 이게 깨지면 D4가 돌아온 것이다(둘을 다시 갈랐거나 시프트를 잘못 잡았거나).
    #[test]
    fn the_freshness_and_the_value_travel_as_one_word() {
        for at in [1u64, 2, 1_999, 2_000, 1_767_000_000_000, u64::MAX >> 1] {
            for en in [false, true] {
                assert_eq!(lang_unpack(lang_pack(at, en)), (at, en), "왕복이 깨졌다 at={at} en={en}");
            }
        }
        // 갓 부팅한 셀은 "아직 안 읽음"이어야 한다 — `at == 0`이 그 표식이다.
        assert_eq!(lang_unpack(0), (0, false), "빈 셀이 캐시 적중으로 읽히면 안 된다");
    }

    /// 못 — **TTL 값 자체**를 잰다(★R3 · 크리틱 R2-D3).
    ///
    /// 왕복 못은 인코딩만 봤지 `LANG_TTL_MS`를 안 봤다. 여기서 경계를 못 박는다:
    /// 이 값을 늘리면(크리틱이 시험한 2000→60000) **`at + 2_000` 줄에서 붉어진다.**
    #[test]
    fn the_language_cache_holds_for_two_seconds_and_not_a_tick_longer() {
        use super::lang_fresh;
        let at = 1_767_000_000_000u64; // 아무 실제 시각

        assert!(!lang_fresh(0, at), "빈 셀(at=0)은 절대 신선하지 않다");
        assert!(lang_fresh(at, at), "같은 순간은 신선하다");
        assert!(lang_fresh(at, at + 1_999), "1.999초는 아직 신선하다");
        assert!(!lang_fresh(at, at + 2_000), "★2.000초에 만료된다 — TTL을 늘리면 여기가 붉어진다");
        assert!(!lang_fresh(at, at + 60_000), "1분이면 당연히 만료");

        // 시계가 뒤로 간 경우(NTP 보정·수동 변경)의 거동을 **적어 둔다**: `saturating_sub`이
        // 0으로 누르므로 캐시는 신선한 것으로 읽힌다. 시계가 정상 진행하면 곧 만료되므로
        // 최악이 "옛 언어를 조금 더 본다"이고, 그건 TTL 설계가 이미 받아들인 값이다.
        assert!(lang_fresh(at, at - 5_000), "과거 now는 0으로 눌려 신선으로 읽힌다(의도)");
    }
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
