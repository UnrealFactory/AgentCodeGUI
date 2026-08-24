# 후속 GIT R1 — 커밋이 죽던 자리는 명령줄 32,767자, AI diff는 파일당 프로세스 두 개

라운드: R28 후속 GIT R1 · 2026-08-24 · `feature/3.0.0-beta`
근거 문서: `docs/r28-followup.md` §2(사용자 직접 요청) · M12 R2 확인 크리틱 G1~G3
커밋: `d05f113`(§1·§2) · `e47a3ee`(§3) · 이 문서

## 0. 한 문단

사용자 보고 두 건 — 「파일 개수가 많으면 커밋이 안 된다」와 「AI 메시지가 느리다」 — 은
**같은 뿌리**였다: 경로가 명령줄 인자로 나갔다. 2,000개를 고르면 argv가 128,000자가 되어
Windows `CreateProcess`(한계 32,767)에서 **스폰 자체가 실패**하고, AI 메시지는 파일마다
프로세스를 두 개씩 띄워 900파일에 **43.8초**를 썼다. 경로와 메시지를 stdin으로 옮기고
diff를 한 번에 받게 해서 **831ms/3스폰**과 **195ms/2스폰**으로 착지했다. 덤으로,
stdin으로 옮기며 새로 생기는 폭탄(빈 목록 = 저장소 전체 스테이징)을 실측으로 확인하고 막았다.
그리고 M12 R2의 19행 증거가 1행으로 덮여 있던 것을 다시 채우고, 다시 그러지 못하게 막았다.

---

## 1. 대량 커밋 — argv → stdin (`crates/ccg-fs/src/git.rs`)

### 1.1 재현

2.6.2(`src/main/git.ts` `gitCommit`)도 3.0 R1도 같은 모양이었다:

```
git add -A -- <파일1> <파일2> … <파일2000>      ← 인자 합계 128,000자
git reset --  <파일1> … <파일2000>              ← 실패 롤백도 같은 모양
```

테스트가 **옛길을 직접 한 번 띄워 실패를 확인한 뒤** 새길을 잰다
(`a_two_thousand_file_commit_goes_through_stdin_in_one_spawn`) — "한계에 걸린다"를
논증이 아니라 실행으로 남긴다. 경로에는 한글·공백·긴 이름을 섞었다.

### 1.2 고친 것

| 자리 | 전 | 후 |
|---|---|---|
| add | `add -A -- …files` | `add -A --pathspec-from-file=- --pathspec-file-nul` |
| 롤백 reset | `reset -- …files` | `reset --pathspec-from-file=- --pathspec-file-nul` |
| 메시지 | `-m 제목 -m 본문` | `commit -F -` (제목·빈 줄·본문을 그대로 stdin) |

`exec()`가 `stdin(Stdio::null())` 고정이라 `exec_stdin()`을 만들었다. **쓰기는 별도
스레드다** — 2,000경로는 파이프 버퍼(64KB) 언저리라, 한 스레드에서 다 쓰고 읽으러 가면
git이 stdout을 못 비워 서로 막힌다. 쓰기 실패(EPIPE)는 무시한다: git이 인자 오류로 먼저
죽으면 사유는 stderr에 있다.

기존 오류 매핑은 **한 글자도 안 바꿨다**(identity 미설정 · `nothing to commit`의 한/영 ·
`On branch main`이 오류 문구로 새지 않게 한 §S8 처방). 기존 커밋 테스트 4종 무회귀.

### 1.3 stdin으로 옮기며 **새로 생긴 폭탄** (실측)

```
$ printf '' | git add -A --pathspec-from-file=- --pathspec-file-nul ; git status --porcelain
M  a.txt      ← 고르지도 않은 파일이
A  c.txt      ← 통째로 스테이징됐다
```

빈 목록을 주면 git은 "경로 제한 없음"으로 읽는다. argv 시절엔 `add -A -- ""`가
pathspec 오류로 **죽어서** 우연히 막혀 있던 자리다. 그래서 빈 경로를 걸러내고, 하나도
안 남으면 git을 부르지 않는다(`an_empty_path_list_never_reaches_git` — `[]`·`[""]`·
`["",""]` 셋 다 인덱스 무접촉을 확인).

### 1.4 실측

```
2,000파일 커밋(한글·공백·긴 경로)   831ms · git 스폰 3회 (repo_root + add + commit)
                                     옛길이었다면 argv 128,000자 → add 단계에서 실패
고르지 않은 파일                     그대로 남는다(status 1행)
훅 거부(pre-commit exit 1) 600경로   커밋 없음 + 스테이징 0 (인덱스에 직접 확인)
긴 본문 400줄 + `#` 줄 + 한글        제목/본문 왕복 무손실
```

---

## 2. AI 커밋 메시지의 diff 수집 — 파일당 2스폰 → 전체 1~2스폰

`git:ai-message`는 T3T4 R3에서 `src-tauri/src/ipc/parity/aimsg.rs`로 착지했고,
diff 수집이 **파일마다 `file_diff`**(= `rev-parse` + `show` = 스폰 2회)였다.

### 2.1 명세와 다른 점 하나 — `git diff`에는 `--pathspec-from-file`이 **없다**

숙제 문구는 「`git diff -- <stdin pathspec>` 한 번」이었는데, 실측하면 그 옵션이 없다:

```
$ printf 'a.txt\0' | git diff -U0 --pathspec-from-file=- --pathspec-file-nul HEAD
usage: git diff [<options>] [<commit>] [--] [<path>...]        ← rc=129
(add·reset·commit·restore·rm·stash에만 있다 — git 2.53.0.windows.1)
```

그래서 **의도(스폰 한 번)를 지키되 수단을 바꿨다.** 두 갈래 다 스폰은 한 번이다:

- 경로 합계 ≤ 24,000자 → `git diff … HEAD -- <경로들>` (딱 고른 파일만)
- 그보다 크면(= 사용자가 말한 "파일이 너무 많을 때") → **경로 없이 전 트리** diff 한 번을
  받아 고른 파일만 추린다. argv는 어느 쪽에서도 안 넘친다.

### 2.2 파싱에서 실제로 밟은 함정

```
$ git diff -U0 HEAD                       (기본 quotePath)
diff --git "a/\355\225\234\352\270\200 \354\235\264\353\246\204.txt" …   ← 한글이 escape
$ git -c core.quotePath=false diff -U0 HEAD
--- a/sp ace.txt<TAB>                     ← 공백 경로는 git이 **뒤에 탭**을 붙여 구분
+++ b/한글 이름.txt<TAB>
```

`core.quotePath=false` + 「끝의 탭 하나만 걷기」로 한글·공백 경로가 그대로 살아난다.
제어문자가 든 경로는 그래도 C 인용으로 오는데, 그건 **그 파일만** 옛길로 돌린다.
`diff --git a/X b/X` 헤더는 좌우가 같은 경로라는 사실로 가운데를 찾는다(`--no-renames`).

### 2.3 답이 갈리지 않는지 — 두 길을 마주 세웠다

`bulk_diffs_answer_the_same_as_one_call_per_file_in_two_spawns`가 수정·삭제·새 파일·
안 바뀜·한글/공백 경로를 한 판에 섞어 놓고 **파일별 증감과 변경 줄 텍스트를 옛길과
1:1로 비교**한다. 900파일 판(`the_old_per_file_path_costs_two_spawns_per_file`,
`#[ignore]` — 분 단위라 기본 제외)도 900개 전부의 증감이 같은지 확인한다.

### 2.4 실측

```
900파일 · 같은 레포 · 같은 프로세스 · 답 동일
  옛길(파일당 file_diff)   43,808ms · git 스폰 1,800회
  새길(bulk_file_diffs)       195ms · git 스폰     2회      → 225배
전 트리 갈래(경로 합계 > 24K)에서 고르지 않은 파일이 답에 섞이지 않고 행도 안 밀린다
```

계수기 `ccg_fs::git::spawn_count()`(스레드별)를 릴리스에도 남겼다 — 「파일당 스폰 하나」
회귀는 **답이 맞아서** 테스트로는 안 잡히고 느려지기만 한다. 그게 이 사고의 성질이었다.

### 2.5 의도적 분기 (기록: `docs/renderer-divergence.md` §6.4)

- diff 엔진이 자체 LCS → `git diff -U0`로 바뀌어 **줄 귀속이 드물게 다를 수 있다**.
- 1.5MB 초과 파일은 본문을 통째로 접던 것이 **변경 줄은 그대로** 나온다(더 낫다).
- **뷰어는 안 갈렸다** — 뷰어 계약(전체 파일·ctx 포함)은 `file_diff` 그대로다.

---

## 3. M12 R2 증거 숙제 (G1~G3)

### 3.1 G1 — 19행을 다시 채웠다

`node bench/ab.mjs {tauri,electron} --tag=m12r2 --only=<19화면>` (각각 한 번에).
exe는 **직접 빌드하지 않고** `target/release/agentcodegui.exe`(18:09 빌드)를 썼다 —
지금 빌드하면 옆 갈래의 미커밋 Rust가 exe에 섞인다(병렬 규율). `tauri.localhost` 스모크로
dev 빌드가 아님을 확인하고 돌렸다.

```
3.0   19행 · 18/19 (94.7%)      2.6.2  19행 · 18/19 (94.7%)
```

**19/19가 아닌 이유는 앱이 아니라 환경이다.** `settings-engine-confirm`은 「이전 버전
정리」 버튼을 누르는 화면인데 그 행은 `oldCount > 0`(설치된 엔진 2개 이상)일 때만 그려진다
(`app/src/components/Settings.tsx:1280`). 픽스처는 실홈의 `engines`·`codex-engines`를
**정션으로 읽기 전용 공유**하고, 지금 둘 다 버전이 하나뿐이다(`engines/0.3.241` ·
`codex-engines/0.149.1` — codex 쪽 옛 버전이 오늘 19:05에 사라졌다).
그래서 **두 앱이 같은 자리에서 같은 문구로** 실패한다 = 파리티 차이가 아니다.
실홈에 가짜 버전을 만들어 통과시키지 않았다 — 픽스처의 계약이 읽기 전용이다.

### 3.2 G2 — 리포트가 조용히 줄어들면 stderr가 말한다

숙제 문구는 "`--only` 개수와 `summary.attempted`가 어긋나면 경고"였고 그대로 넣었다.
다만 **그 검사만으로는 이번 사고를 못 잡는다** — 1개를 요청해 1행이 남으면 숫자는 맞다.
사고의 실제 모양은 「`--merge` 없이 **더 짧은** 리포트로 덮어쓰기」라 그 한 줄을 같이 넣었다.

실측(스크래치 태그에 19행 리포트를 심고 1화면 재주행 — 확인 후 그 폴더는 지웠다):

```
[ab] 경고 — --only 2개인데 리포트는 1행(시도 1·skip 0)
[ab] 경고 — 이전 리포트 19행을 1행으로 덮어쓴다. 단건 재주행이면 --merge를 붙여라
```

### 3.3 G3 — `viewport`를 본 패스로

`row.viewport`가 부팅 패스에만 있어 본 패스 17행이 `null`이었다. 이제 **캡처를 실제로 한
창**(독립 창 화면이면 그쪽)에서 reset 전에 읽는다. 스플래시 두 갈래도 같이 채웠는데,
거기서 한 번 밟았다: 2.6.2 스플래시는 기동과 동시에 닫히는 별도 창이라 촬영 뒤에 읽으면
이미 죽어 `null`이 된다(첫 시도 실측). **찍은 직후 같은 연결에서** 읽게 고쳤다.

```
본 패스 18행    두 앱 모두 [1320, 880]   (M12 R2가 밝힌 "같은 기본 창 크기"가 값으로 남는다)
boot-splash     2.6.2 [300,240] separate-window · 3.0 [1440,900] in-window-overlay
```

M12 R2가 문장으로 적어 둔 「구조가 다르다」가 이제 리포트의 값이다. `viewport:null` 0행.

---

## 4. 검증 요약

```
cargo test -p ccg-fs        87개 중 86 통과 · 0 실패 · 1 ignored(느린 근거 측정)   (81 → 87)
cargo test -p agentcodegui  133 통과 · 0 실패 (무회귀)
cargo check -p agentcodegui --features custom-protocol   경고 0
npm run typecheck (node·web) · npm run typecheck:app     3종 초록
node --check bench/ab.mjs                                 통과
A/B 19화면 × 2앱                                          각 19행 · 18/19 · 94.7%
```

새 테스트 6개(5 실행 + 1 ignored): 2,000파일 커밋 · 빈 목록 차단 · 긴 본문 stdin ·
훅 거부 롤백 600경로 · bulk vs 파일당 답 대조 · 전 트리 갈래 900파일.

---

## 5. 안 한 것과 이유

1. **`ipc/git.rs`는 안 고쳤다.** 숙제가 지목한 ai-message 경로는 T3T4 R3에서
   `ipc/parity/aimsg.rs`로 갔다(그 파일 헤더가 그렇게 적어 뒀다). `ipc/git.rs`는
   `ccg_fs::git`의 얇은 변환기라 이번 변경으로 바뀔 줄이 없다.
2. **커밋 전후 status 재조회 합치기**는 `push`의 `rev-parse` 한 번 제거까지만 했다.
   나머지(커밋 성공 뒤 렌더러가 다시 `git:status`를 부르는 왕복)는 계약면
   (`protocol.ts`)과 `app/` 렌더러를 건드려야 하는데, 이번 라운드에서 그 둘은 다른
   갈래가 쓰는 공유 파일이라 경계 밖이다. 커밋 자체가 3스폰이라 이득도 작다.
3. **exe 재빌드 없음.** §3.1과 같은 이유(병렬 규율). 이 라운드의 Rust 변경은
   `cargo test`·`cargo check`로만 검증했고, A/B는 기존 exe로 돌렸다.
4. **`settings-engine-confirm`을 통과시키지 않았다.** 실홈 엔진 폴더에 가짜 버전을
   만들면 통과하지만 그건 사용자의 실홈을 만지는 짓이고, 하네스가 픽스처와 맺은 계약
   (읽기 전용 정션)을 깬다.

---

## 6. 만진 파일

- `crates/ccg-fs/src/git.rs` — `exec_stdin`/`exec_in`·`spawn_count`·`commit` stdin화·
  `bulk_file_diffs`+파서·`status_at`·테스트 6.
- `src-tauri/src/ipc/parity/aimsg.rs` — diff 수집 3줄(**경계 밖**: 숙제가 지목한
  ai-message 경로가 이 파일로 옮겨져 있었다. 이 파일의 다른 hunk는 안 건드렸다).
- `bench/ab.mjs` — G2 경고 2줄·G3 viewport·`shotWhen`이 캔버스를 같이 돌려준다.
- `bench/shots/{tauri,electron}-m12r2/report.json` — 19행 재채움(G1).
- `docs/renderer-divergence.md` — §6.4 추가(끝에 덧붙임, 남의 절 무접촉).
- `docs/parity-fix-git-r1.md` — 이 문서.

안 만진 것: 동결 구역 `src/`·`out/`·`dist/` · `bench/screens.mjs`·`bench/lib.mjs` ·
`bench/shots/{tauri,electron}/report.json`·`bench/results/*`·`docs/critic/*.json` ·
다른 갈래의 미커밋 변경(`app/**`·`crates/ccg-auth`·`crates/ccg-engine`·`src-tauri/src/engine/**`
·`ipc/accounts.rs`·`ipc/parity/{usage,mod}.rs`·`src/shared/*`).

---

## 7. 다음 라운드가 이어받을 것

1. **실앱 실측이 남았다.** 2,000파일 커밋은 크레이트 테스트로만 쟀다. 다음 정식 빌드
   뒤에 Git 카드에서 실제로 눌러 보는 확인이 필요하다(특히 AI 메시지 카드).
2. `settings-engine-confirm`은 **환경 의존 화면**이다. 하네스가 「설치 버전이 1개라
   행이 없다」를 skip 사유로 구분해 주면 이 실패가 매번 파리티 실패처럼 보이지 않는다
   (`bench/screens.mjs`는 이번 경계 밖이라 손대지 않았다).
3. `bulk_file_diffs`는 지금 AI 메시지 한 곳만 쓴다. Git 카드가 여러 파일 diff를
   미리 받는 자리(선택 파일 전체 미리보기)가 생기면 같은 함수를 쓰면 된다.
