# R28b GIT 확인 크리틱 — 커밋은 진짜로 살아났다. 그런데 「고른 파일만」이 실측으로 깨진다

라운드: R28b GIT 확인 크리틱 (새 컨텍스트·전면 재실측) · 2026-08-24 · `feature/3.0.0-beta`
판정 대상: `d05f113` `e47a3ee` `a209227` + 그 뒤 수정분 `4c97d62` `586a530` `06c2d65` `530ad23`
\+ **미커밋 워킹트리**(`crates/ccg-fs/src/git.rs` · `src-tauri/src/ipc/parity/aimsg.rs` = R2 크리틱 대응분)

**판정: 불합격(pass=false).** 숙제 체크리스트 5항목은 **전부 실측 통과**했다. 그러나
`ccg_fs::git::commit`이 자기 문서에 적어 둔 계약 「고른 파일만 커밋」이 실측으로 깨진다 —
**2개를 골랐는데 3개가 커밋됐다.**

---

## 0. 파일 이름에 관하여 (읽는 사람이 먼저 알아야 할 것)

숙제는 판정문을 `docs/critic/r28b-git-critic-r1.md`로 쓰라고 했다. **그 파일은 이미 있다**
(`43a1b36`, 22:19). 같은 갈래의 `r28b-git-critic-r2.md`도 있다(`f8a8ed8`, 23:19). 지금 워킹트리는
그 R2 크리틱에 대한 **수정분이 미커밋으로 얹힌** 상태다. r1.md에 덮어쓰면 커밋된 크리틱 하나가
지워지고, 「r1이 r2보다 최신인 장부」라는 자기모순이 남는다. 그래서 순번을 이어 **r3**으로 쓴다.
경계(`docs/critic/**`)는 그대로다. 앞선 두 판정문은 한 글자도 안 건드렸다.

## 1. 실측 방법 — 빌더의 테스트를 안 믿기 위해 별도 하네스를 만들었다

레포 **밖**(`%TEMP%/ccg-critgit`)에 `ccg-fs`를 path 의존으로 무는 독립 바이너리를 세우고,
`commit` / `bulk_file_diffs` / `file_diff`를 **직접** 불렀다. 레포 파일은 판정문 외에 안 건드렸다.

- 격리: `CARGO_TARGET_DIR=%TEMP%/ccg-critgit-target`(하네스) · `%TEMP%/ccg-critgit-ws`(워크스페이스
  테스트) · `CCG_HOME=%TEMP%/ccg-critgit-home` · A/B 태그 `critgitr1`(CDP 포트는 태그 해시).
- 이름 기반 kill **0회**. 사용자 실앱(2.6.2 5프로세스)과 옆 갈래가 띄워 둔 `agentcodegui`(pid 29692)
  전부 그대로 살려 뒀다.
- 스크래치 전부 확인 후 삭제(`bench/shots/tauri-critgitr1/`, temp 홈·작업 레포).

---

## 2. 체크리스트 5항목 — 전부 실측 통과

### ① 2,000파일 커밋 — 통과. 옛길이 죽는 것까지 같은 판에서 봤다

경로 2,000개, **argv 합계 120,020바이트**(한계 32,767의 3.7배). 같은 목록으로 옛 방식을 먼저 쏴 봤다.

```
[old] argv add(=2.6.2 src/main/git.ts:358과 같은 모양) → 스폰 실패
      os error 206 "파일 이름이나 확장명이 너무 깁니다"
[new] ccg_fs::git::commit → ok=true · git 스폰 3회 (repo_root + add + commit)
      커밋에 담긴 파일 2,000개 · 고르지 않은 NOT-PICKED.txt는 `??` 그대로
      메시지 왕복 = "대량 커밋 실측\n\n본문\n#해시로 시작하는 줄\n한글 본문\n"  ← `#` 줄·한글 무손실
```

**시간은 보고서보다 한 자리 크다. 다만 래퍼 탓이 아니다.**

| 판 | 값 |
|---|---|
| 빌더 테스트 `a_two_thousand_file_commit…` 재현 | **749ms** · 스폰 3 (보고서 831ms — 재현됨) |
| 내 하네스, 같은 트리를 이미 한 번 만진 뒤(warm) | **870ms** · 스폰 3 |
| 내 하네스, **막 만든 2,000파일을 처음 만지는 판**(cold) | **9,158 / 9,331 / 9,417ms** (3회) |
| 위 cold 판에서 raw `git add` 단독(래퍼 밖) | **9,500ms** |

마지막 줄이 결론이다 — cold 9.5초는 **git 몫**이지 stdin 전환 탓이 아니다. 그래도 보고서의
`831ms`는 사용자가 실제로 겪는 최악을 대표하지 않는다. 「최초 대량 커밋은 10초 가까이 걸릴 수 있다」가
장부에 없다.

### ② 유니코드·공백 경로 / 훅 거부 롤백 — 통과. 롤백은 기대보다 더 정확하다

```
[uni]  한글 폴더/한글 파일 이름.txt · space dir/with space.txt · 일본語/ファイル.md
       · emoji 😀/파일 #1.txt · dash-and space/quote'and(paren).txt
       → ok=true · 스폰 3 · 5개 모두 커밋 · NOT-PICKED-uni.txt는 `??` 그대로

[hook] pre-commit exit 1 · 600경로 → ok=false err="hook says no" · 스폰 4
       롤백 후 스테이징 = 1개 = ["PRE-STAGED.txt"]
```

마지막 줄이 중요하다. 600개는 통째로 걷혔고, **내가 미리 손으로 올려 둔 남의 스테이징 1개는
살아남았다** — `reset -- <고른 경로>`가 인덱스를 통째로 밀지 않는다는 것이 실측으로 확인된다.

빈 목록 폭탄도 실재를 확인했다.

```
[empty] commit(files=["",""]) → ok=false "커밋할 파일이 없어요" · 스테이징 0
[empty] raw git에 빈 stdin을 그대로 주면 → 스테이징 ["a.txt","b.txt"]  ← 저장소 전체
```

가드가 가상의 위험이 아니라 **실재하는 폭탄**을 막고 있다.

### ③ AI diff 수집 스폰 수 + 캡 — 통과

프롬프트에 실제로 닿는 줄(`serialize_diff`가 쓰는 `add`/`del`)만 옛길과 1:1로 맞췄다.

| 판 | 새길 | 옛길 | 불일치 |
|---|---|---|---|
| 101파일 (argv에 담기는 규모) | **2스폰 · 387ms** | 202스폰 · 14,256ms | **0** |
| 901파일 (argv 초과 → 전 트리 갈래) | **2스폰 · 524ms** | 1,802스폰 · 59,429ms (**113배**) | **0** |
| unborn HEAD 300파일 | **3스폰 · 1,241ms** · 300행 전부 본문 | — | — |

고르지 않은 수정 파일·미추적 파일이 답에 섞이는지도 봤다 — **누출 0**.

> 옛길의 `eq(ctx)` 줄은 새길에 없다(내 첫 대조에서 한글 파일 1건이 걸렸다). `serialize_diff`가
> `ctx`를 원래 안 싣기 때문에 **프롬프트 문자열은 안 갈린다**. 장부 §6.4가 이미 그렇게 적어 뒀다 —
> 확인했고, 사실이다.

**캡 두 겹(미커밋 R2 수정분) — 돈다.**

```
[budget] 큰 파일 5개(각 ~1MB) + 작은 소스 10개
         → 큰 5개만 dropped=File(본문 0줄, +12000 −12000은 정확)
         → 작은 소스 10개는 본문 80줄 **전부 생존**   ← R2 크리틱의 838자 사고가 막혔다
[batch]  150파일 × ~47KB → 87행까지 본문 유지(4,171,110바이트) · 88번째부터 63행 dropped=Batch
         증감(+250 −250)이 틀린 행 = 0
```

`aimsg.rs::build_diff_text`가 `File`→「본문 생략(파일이 너무 큼)」, `Batch`→「본문 생략(수집 예산)」으로
옮긴다. `BULK_FILE_TEXT_BUDGET`(64KB) > `AI_FILE_CAP`(24,000)이라 `File`을 「파일이 너무 큼」으로
옮기는 근거도 성립한다(64KB를 넘긴 파일은 옛길에서도 반드시 파일 캡에 걸린다).

**★ 다만 이 두 예산을 만지는 테스트가 한 개도 없다.** `BodyDropped`·`body_dropped`·
`BULK_FILE_TEXT_BUDGET`·`BULK_TEXT_BUDGET` — `crates/ccg-fs/src/git.rs`와
`src-tauri/src/ipc/parity/aimsg.rs`의 테스트 모듈 통틀어 **참조 0건**이다. 지금 도는 것은
내가 밖에서 확인했을 뿐이고, 레포 안에는 이 회귀를 잡을 그물이 없다 — **이미 한 번 조용히 새어
나갔던 바로 그 자리**인데도.

### ④ 테스트 무후퇴 + typecheck 3종 — 통과

```
cargo test -p ccg-fs        88 통과 · 0 실패 · 2 ignored
cargo test -p agentcodegui  139 통과 · 0 실패 · 0 ignored   (경고 0)
npm run typecheck (node+web)  exit 0
npm run typecheck:app         exit 0
```

(보고서의 「87 중 86 통과」·「133 통과」보다 늘었다 — 그 뒤 라운드와 옆 갈래 미커밋분이 더해진 결과다.
실패는 어느 쪽도 0이다.)

### ⑤ A/B 증거 19행 · 자기모순 없음 · 경고와 viewport 실동작 — 통과

| | tauri-m12r2 | electron-m12r2 |
|---|---|---|
| screens 행 | **19** | **19** |
| summary | 시도 19 · 성공 18 · 실패 1 · 94.7% | 동일 |
| 행 집계와 대조 | ok 18 = summary.ok 18 · 94.7 = 94.7 | 동일 |
| PNG 파일 | 18장 (없는 것은 실패행 하나뿐) | 18장 (동일) |
| **PNG IHDR vs report** | 19행 전부 `png`·`viewport`와 일치 (불일치 0) | 동일 |
| viewport 채움 | 19/19 | 19/19 |
| canvas | `[1320,880]` · settled · mismatch `[]` | `[1320,880]` · mismatch `[]` |

보고서가 「PNG 19장씩」이라고 적은 것은 **18장**이다(못 찍은 행이 하나 있으니 18이 맞다 — 보고서 쪽이 틀렸다).
보고서가 적은 3.0 스플래시 `[1440,900]`도 지금은 `[1320,880]`이다 — `586a530`이 그 뒤에 고쳤다.

**경고 가드는 실주행으로 유발해 확인했다**(스크래치 태그 `critgitr1`에 19행을 심고 단건 재주행).

```
① 19행 심음 + --only=settings-display (단건, --merge 없음)
   [ab] 경고 — 이전 리포트 19행을 1행으로 덮어쓴다. 단건 재주행이면 --merge를 붙여라
   (①번 경고는 정확히 침묵 — 1개 요청·1행이면 숫자가 맞다. 숙제 문구 그대로였다면 이 사고를 못 잡는다)

② 19행 심음 + --only=settings-display,no-such-screen --merge
   [ab] 경고 — --only 2개인데 이번 판이 남긴 건 1행 — 도달 못 한 화면이 통째로 빠졌다
   → 병합 후 rows 19 · summary 94.7% 복원 · mergedFrom 채워짐
```

단건 재주행이 남긴 행에도 `viewport [1320,880]` · `png [1320,880]`이 그대로 찍혔다 — G3는 문장이
아니라 코드다.

`settings-engine-confirm` 실패 사유도 확인했다. 실홈에 `engines/0.3.241` 하나 ·
`codex-engines/0.149.1` 하나뿐이라 `oldCount = installed.length - 1 = 0`이고, 「정리」 버튼은
`oldCount > 0`에서만 렌더된다. **두 앱이 같은 문구로 실패**하므로 파리티 차이가 아니다.
(다만 보고서가 짚은 `Settings.tsx:1280`은 오기다 — HEAD 기준 정의가 1208, 게이트가 **1398**이다.)

---

## 3. ★ 실측으로 찾은 결함 — 2개를 골랐는데 3개가 커밋된다

`ccg_fs::git::commit`의 문서 첫 줄은 **「고른 파일만 커밋 — add(그 경로만) 후 commit」**이다.
경로가 그대로 **pathspec**으로 나가는데, pathspec은 문자열이 아니라 **글롭**이다.

```
고른 것 2개:  app/posts/[id]/page.tsx
              app/posts/[...slug]/page.tsx

커밋된 것 3개: app/posts/[...slug]/page.tsx
              app/posts/[id]/page.tsx
              app/posts/i/page.tsx        ← 고르지 않았다. `[id]`가 문자클래스라 `i`에 걸렸다
```

raw git으로 원인을 못 박았다(래퍼 밖, 같은 git 2.53.0.windows.1).

```
printf 'app/posts/[id]/page.tsx\0' | git add -A --pathspec-from-file=- --pathspec-file-nul
  → staged: app/posts/[id]/page.tsx , app/posts/i/page.tsx      (2개)

printf ':(literal)app/posts/[id]/page.tsx\0' | git add -A --pathspec-from-file=- --pathspec-file-nul
  → staged: app/posts/[id]/page.tsx                              (1개)
```

**회귀는 아니다.** 2.6.2 `src/main/git.ts:358`도 `['add','-A','--',...files]`라 글롭 의미가 같다.
파리티는 유지된다. 그러나 이 라운드는 **그 줄을 다시 쓴 라운드**이고, `nul_pathspec()`이라는
**pathspec을 만드는 것이 유일한 일인 새 헬퍼**를 새로 만들면서 literal 매직을 안 붙였다.
새 테스트 9개도 이 자리를 안 지난다.

왜 심각한가:

- **조용하다.** 오류도, 경고도 없다. 사용자는 자기가 고른 2개를 커밋했다고 믿는다.
- **롤백도 같은 pathspec을 쓴다**(`reset --pathspec-from-file=-`). 훅이 거부하면 딸려 온 남의
  파일까지 인덱스에서 내려간다.
- **Windows에서 현실적인 유일한 매직 문자가 `[ ]`인데**, 그게 하필 Next.js App Router의 표준
  디렉터리 이름이다(`[id]` · `[slug]` · `[...slug]`). 사용자의 두 번째 프로젝트가 Next.js다
  (`C:\Code\RookissAI_WorkSpace`).
- `*`·`?`는 Windows 파일명에 못 쓰므로 이 결함의 창구는 좁다. 대신 **좁은 만큼 정확히 그 인구를 친다.**

**고치는 자리는 한 곳이다.** `nul_pathspec()`이 경로마다 `:(literal)` 접두를 붙이면 add·reset이
한꺼번에 낫는다. 세 가지 행 모양이 전부 살아남는 것도 확인했다.

```
:(literal)새 폴더/ · :(literal)삭제될.txt · :(literal)app/posts/[id]/page.tsx
  → A 새 폴더/안쪽 1.txt · A 새 폴더/안쪽 2.txt · D 삭제될.txt · A app/posts/[id]/page.tsx
    (app/posts/i/page.tsx 없음)
```

`git diff`의 argv 갈래(`bulk_file_diffs`의 ≤24,000자 쪽)도 같은 경로를 pathspec으로 넘긴다.
그쪽은 결과를 **정확한 경로 키로 되찾아 오기** 때문에 답이 오염되지는 않지만(실측: 누출 0),
같은 접두를 붙여 두는 편이 일관된다.

---

## 4. 잔가지 — 고쳐도 좋고 적어만 둬도 되는 것

| # | 무엇 | 근거 |
|---|---|---|
| J1 | 두 수집 예산에 테스트 0건 | `BodyDropped`·`body_dropped`·`BULK_*_BUDGET` 참조가 테스트 모듈에 없다 |
| J2 | 「2,000파일 커밋 831ms」가 최악을 대표 안 함 | 같은 판 cold 9,158~9,500ms (raw git 단독 9,500ms) |
| J3 | 보고서 「PNG 19장씩 재촬영」 | 실제 18장(실패행은 사진이 없다 — 18이 옳다) |
| J4 | 보고서 `Settings.tsx:1280` | HEAD 기준 정의 1208 · 게이트 1398 |
| J5 | 미커밋 R2 수정분이 §6.4 장부에 안 적혔다 | `renderer-divergence.md` §6.4 표에 「수집 예산」 행이 없다 |
| J6 | exe 재빌드 없음(빌더 자진 신고) | 2,000파일 커밋을 **실앱에서** 눌러 본 사람은 아직 없다 |

J6는 빌더가 이유를 정확히 댔다(옆 갈래 미커밋 Rust가 exe에 섞인다). 지금도 그 사정은 그대로다 —
워킹트리에 3갈래의 미커밋 Rust가 얹혀 있다. 다음 정식 빌드 뒤 숙제로 남는 것이 맞다.

---

## 5. 무접촉 확인

- 동결 구역 `src/` · `out/` · `dist/` — 읽기만 했다(`src/main/git.ts`는 옛 구현 대조용).
- `bench/screens.mjs` · `bench/lib.mjs` · `bench/shots/{tauri,electron}/report.json` ·
  `bench/results/*` · `docs/critic/*.json` · 앞선 판정문 `r28b-git-critic-r{1,2}.md` — 무접촉.
- 스크래치 `bench/shots/tauri-critgitr1/`은 확인 후 삭제(`git status`에 안 남음).
- 다른 갈래의 미커밋 변경 전부 무접촉. reset·checkout·stash **0회**.
- 이름 기반 kill **0회**.
