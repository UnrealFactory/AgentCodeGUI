# 후속 GIT R1 — 커밋이 죽던 자리는 명령줄 32,767자, AI diff는 파일당 프로세스 두 개

라운드: R28 후속 GIT R1 (+ **수정 R1** · **수정 R2** · **수정 R3**) · 2026-08-24~25 · `feature/3.0.0-beta`
근거 문서: `docs/r28-followup.md` §2(사용자 직접 요청) · M12 R2 확인 크리틱 G1~G3
커밋: `d05f113`(§1·§2) · `e47a3ee`(§3) · `a209227`(문서) ·
**수정 R1** — §2.5·§2.6(구멍 둘 + 새 거짓말) · §3.4(A/B 캔버스) ·
**수정 R2** — §1.5(고른 경로가 글롭이었다) · §1.6(4MB 예산 + 그물) ·
**수정 R3** — §1.7(접두가 못 닿는 여섯 번째 자리) · §1.4(장부의 시간이 대푯값이 아니었다)

> **수정 R3이 고친 것** (R28b GIT 확인 크리틱 R4 판정: 숙제 5항목 **전부** 실측 통과하고
> R3가 실패시킨 대괄호 다섯 자리도 raw git 음성 대조까지 통과 — 그런데 **이 라운드가
> 스스로 못 박은 계약**(§7.6 「`:(literal)`은 모든 경로의 규약」)이 실측으로 거짓이라
> 불합격. 판정문 `docs/critic/r28b-git-critic-r4.md`)
> - **§1.7** ★ 치명. `discard`가 부르는 `show_at`의 `git show HEAD:<경로>`는 pathspec이
>   아니라 오브젝트 이름이라 접두를 못 단다. 그런데 git이 그 인자를 **글롭으로 재해석해
>   exit 0 + 0바이트**를 줘서, `show_at`이 `Absent` 대신 `Text("")`를 돌리고 **스테이징(`A`)된
>   대괄호 경로의 되돌리기가 영구히 실패**했다. 수정 R2가 그 위(`:1454` checkout)와
>   아래(`:1466` rm --cached)를 고치면서 **그 사이 `:1460`**을 지나쳤다. `git show`의 exit
>   code를 존재 판정으로 쓰지 않고 `cat-file -e`로 되묻어 막았다(스폰 증가 0).
> - **§1.4** 장부의 「2,000파일 커밋 831/760ms」가 **얕고 같은 내용**의 테스트 판이었다.
>   같은 코드로 현실적인 깊은 트리를 재면 **33초**다 — 그 몫은 전부 git이고 래퍼 몫은 0.
>   두 수를 나란히 적고, 「고친 것은 불가능→가능이지 느림→빠름이 아니다」를 못 박았다.
> - 문장 정정: §7.6의 「모든 경로」 → 「**pathspec 자리**의 규약, `rev:path`는 별도 수단」 ·
>   §1.5의 「쓰는 곳은 **넷**」 → **다섯**(바로 아래 표가 다섯 행이었다).

> **수정 R2가 고친 것** (R28b GIT 확인 크리틱 R3 판정: 숙제 5항목 전부 실측 통과 —
> 그런데 `commit`이 자기 문서에 적은 계약 「고른 파일만 커밋」이 깨져 불합격.
> 판정문 `docs/critic/r28b-git-critic-r3.md`)
> - **§1.5** ★ 치명. 고른 경로가 그대로 pathspec(=글롭)으로 나가, `app/posts/[id]/page.tsx`
>   2개만 골랐는데 이웃 `app/posts/i/page.tsx`까지 **3개**가 커밋됐다. `:(literal)` 접두
>   하나로 add·롤백 reset·argv diff를 한꺼번에 고쳤고, 크리틱이 짚지 않은 **`discard`**
>   (되돌리기)까지 같이 막았다 — 거기서는 이웃의 **저장 안 한 편집이 사라진다**.
> - **§1.6** 확인 크리틱 R2가 잡은 4MB 예산 사고의 수정분(커밋도 기록도 안 돼 있던 것)을
>   이 커밋에 같이 싣고, **테스트 0건이던** `BodyDropped`·두 예산에 그물 4개를 걸었다.
> - 보고서 오기 둘 정정: PNG 「37장」→ **36장**(§6) · `Settings.tsx:1280` → **:1208/:1398**(§3.1).

> **수정 R1이 고친 것** (R28b GIT R1 확인 크리틱 판정: 5개 중 4개 통과, 5번 실패)
> - **§3.4** ★ 실패 항목. 이 문서가 「본 패스 18행 두 앱 모두 `[1320,880]`」이라고 적었는데
>   같은 커밋의 `report.json`은 3.0 `[1440,900]` · 2.6.2 `[1320,880]`이었다. 문장이 아니라
>   **원인**(하네스가 3.0에만 먹는 레버로 크기를 강제)을 고치고 19화면을 다시 찍었다.
> - **§2.5** 「파일이 몇 개든 스폰 1~2회」가 조건부였다(unborn·32MB 초과에서 배치 전체가
>   파일당 호출로 내려앉음). 두 자리 다 스폰을 끊었다.
> - **§2.6** 미추적 **폴더** 행이 `+0 −0`("안 바뀌었다")으로 나가던 거짓말.

## 0. 한 문단

사용자 보고 두 건 — 「파일 개수가 많으면 커밋이 안 된다」와 「AI 메시지가 느리다」 — 은
**같은 뿌리**였다: 경로가 명령줄 인자로 나갔다. 2,000개를 고르면 argv가 128,000자가 되어
Windows `CreateProcess`(한계 32,767)에서 **스폰 자체가 실패**하고, AI 메시지는 파일마다
프로세스를 두 개씩 띄워 900파일에 **43.8초**를 썼다. 경로와 메시지를 stdin으로 옮기고
diff를 한 번에 받게 해서 **831ms/3스폰**과 **195ms/2스폰**으로 착지했다. 덤으로,
stdin으로 옮기며 새로 생기는 폭탄(빈 목록 = 저장소 전체 스테이징)을 실측으로 확인하고 막았다.
그리고 M12 R2의 19행 증거가 1행으로 덮여 있던 것을 다시 채우고, 다시 그러지 못하게 막았다.

**수정 라운드 1**은 그 뒤에 남은 것을 걷었다. 「한 번에 받는다」가 두 자리에서 **조건부**
였고(첫 커밋 전·전 트리 32MB 초과 — 배치 전체가 옛 속도로), 미추적 폴더 행 하나가
「안 바뀌었다」고 거짓말했고, 무엇보다 **19화면 A/B 사진들이 서로 다른 캔버스로 찍혀
있었다** — 리포트는 그 사실을 값으로 적고 있었는데 이 문서가 반대로 적어 덮었다.
셋 다 문장이 아니라 코드에서 고치고, 하네스가 다음에는 **스스로 말하게** 만들었다.

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

> **★ 그 831ms는 「2,000파일 커밋」의 대푯값이 아니다** (수정 R3 정정 — 확인 크리틱 R3·R4가
> 두 번 지적). 위 수는 테스트가 만드는 판, 즉 **폴더 40개·2단 깊이·2,000파일이 전부 같은
> 내용**(`한 줄\n`)에서 나온다. 사용자의 실제 대량 커밋은 깊고 내용이 전부 다르다. 같은
> 코드로 두 판을 나란히 재면(레포 밖 독립 하네스, 2회씩):
>
> | 판 | 시간 | 스폰 | argv였다면 |
> |---|---|---|---|
> | 얕음(40폴더·2단·같은 내용) = 위 장부의 판 | **690 / 781ms** | 3 | 86,000B |
> | 깊음(6단·서로 다른 내용) = 현실의 판 | **32,849 / 32,668ms** | 3 | 322,000B(한계의 9.8배) |
>
> **그 33초에서 래퍼 몫은 0이다.** 같은 트리를 raw git 3단계로 갈라 재면
> `rev-parse 13ms + add 9,029ms + commit 23,441ms = 32,483ms`로, 우리 래퍼(32,668ms)와
> 오차 안에서 같다. `:(literal)` 접두 비용도 0이다(크리틱 R4가 접두 유무만 바꿔 4판 측정:
> flat 377 대 377 · deep 579 대 550ms).
>
> 즉 **고친 것은 「불가능 → 가능」이지 「느림 → 빠름」이 아니다.** 옛길은 이 판에서
> 스폰조차 못 했다(`os error 206`). 새길은 되지만 **최초 대량 커밋은 십수~수십 초가
> 걸린다 — 전부 git의 인덱스·오브젝트 쓰기 몫**이다. Git 카드에는 그동안 진행 표시가
> 없어 「멎었다」로 보인다. 다음 라운드가 이어받을 것(§7.8).

### 1.5 고른 경로가 **글롭**이었다 — 이웃이 조용히 딸려 왔다 (수정 R2)

> R28b GIT R3 확인 크리틱의 치명 판정. 「고른 파일만 커밋」은 이 함수가 자기 문서에 적은
> 계약인데, 실측으로 깨졌다.

경로를 그대로 pathspec으로 넘기면 git은 그것을 **패턴**으로 읽는다.

```
고른 것 2개   app/posts/[id]/page.tsx · app/posts/[...slug]/page.tsx
커밋된 것 3개 + app/posts/i/page.tsx           ← `[id]`가 문자클래스라 한 글자 `i`에 맞았다
              오류도, 경고도 없다
```

**창구는 좁지만 정확히 그 인구를 친다.** `*`·`?`는 Windows 파일명에 못 쓰므로 현실적인
매직 문자는 `[ ]` 하나뿐인데, 그게 하필 **Next.js App Router의 표준 디렉터리 이름**이다
(`[id]` · `[slug]` · `[...slug]`). 사용자의 두 번째 프로젝트가 Next.js다.

R1은 이 줄을 **다시 쓰면서**(argv → stdin) pathspec 생성이 유일한 일인 새 헬퍼
`nul_pathspec()`을 만들었는데 literal 매직을 안 붙였고, 새 테스트 9개도 이 자리를 안 지났다.
2.6.2 `src/main/git.ts:358`도 같은 모양이라 **회귀는 아니다**(파리티 유지) — 그러나 이 라운드가
손댄 줄이다.

**고친 자리 — `:(literal)` 접두 하나(`LITERAL` 상수), pathspec 자리 다섯.**

| 자리 | 무엇이 위험했나 |
|---|---|
| `commit`의 add (`nul_pathspec`) | 고르지 않은 이웃이 **같이 커밋된다** |
| 훅 거부 롤백 reset (같은 바이트) | **남의 스테이징**을 대신 걷는다 |
| `discard`의 `checkout HEAD --` | ★ 고르지 않은 이웃의 **저장 안 한 편집이 사라진다** |
| `discard`의 `rm --cached --ignore-unmatch` | 이웃이 **말없이** 인덱스에서 내려간다 |
| 대량 diff의 argv 갈래(`diff_once`) | 답 오염은 없었지만(키가 정확) 이웃 diff를 공짜로 만들어 수집 예산을 갉는다 |

> **여섯 번째 자리는 접두로 못 막는다** — `show_at`의 `git show <rev>:<경로>`. 수정 R2는
> 이 표를 「넷」이라고 세면서 다섯 행을 적었고(오기), 그보다 나쁘게 **§7.6에 「모든 경로의
> 규약」이라고 못 박아** 접두가 닿지 않는 여섯 번째를 가렸다. 수정 R3이 그 자리를 다른
> 수단으로 막고 문장을 고쳤다 — §1.6.

`discard`는 크리틱이 지목하지 않은 자리인데, **이 갈래에서 가장 파괴적**이라 같이 고쳤다.
raw git으로 못 박았다:

```
git checkout HEAD -- "app/posts/[id]/page.tsx"
  → app/posts/i/page.tsx 의 저장 안 한 편집이 사라짐            (내용이 HEAD로 돌아감)
git checkout HEAD -- ":(literal)app/posts/[id]/page.tsx"
  → i/page.tsx 편집 그대로 · [id]/page.tsx만 되돌아감
```

**같이 옮긴 두 가지**

- **argv 예산이 접두 10바이트를 센다**(`fits_argv`). 짧은 경로 수천 개면 그 10바이트가
  경로보다 크다 — 「경로 길이만」으로 세면 예산 24,000을 지키고도 실제 명령줄이 32,767을
  넘어, 이 라운드가 고친 그 스폰 실패로 되돌아간다. 테스트 `the_argv_budget_counts_the_magic_prefix`가
  경로만 세면 예산 안(18,000)이고 접두까지 세면 밖(38,000)인 목록으로 그 자리를 잡는다.
- **`err_line`이 접두를 걷는다.** `:(literal)`은 우리가 git에게 하는 말이지 사용자의 말이
  아니다 — `pathspec ':(literal)없는 파일.txt' did not match…`가 그대로 새면 사용자는 자기가
  안 친 글자를 오류에서 읽는다.

**실측(재현 → 고침 → 그물이 무는지)**

```
raw git   printf 'app/posts/[id]/page.tsx\0' | git add -A --pathspec-from-file=- --pathspec-file-nul
            → 3개 스테이징 ([id] · d · i)           ← `[id]` = 한 글자 `i` 또는 `d`
          같은 줄에 `:(literal)`만 붙이면            → 1개
접두를 달아도 세 행 모양 전부 정상   폴더 행(안쪽 2개 A) · 삭제 행(D) · 대괄호 행(A, 이웃 없음)
  ↑ raw git이 아니라 **우리 `commit()`으로** 한 판에 섞어 다시 확인했다
    (`the_literal_prefix_keeps_folder_rows_and_deletions_working` — 접두가 깨뜨릴 수
     있었던 것이 정확히 이 둘이다: 폴더 행의 접두 매칭과, 디스크에 없는 삭제 행)

새 테스트 4개를 접두를 지운 코드(`LITERAL = ""`)로 돌려 **전부 실패하는 것**까지 확인:
  a_bracket_path_never_drags_its_neighbours_into_the_commit
      고른 2개 → 추적 5개(seed + 고른 2 + 이웃 i·d)  ← 크리틱이 본 그 사고
  discarding_a_bracket_path_leaves_its_neighbour_alone
      이웃 내용 "원본\n이웃의 저장 안 한 편집\n" → "원본\n"
  the_argv_diff_path_asks_only_for_the_bracket_file
      diff 키 ["app/posts/i/page.tsx", "app/posts/[id]/page.tsx"] → 1개여야 한다
  the_argv_budget_counts_the_magic_prefix
      "접두를 안 세고 argv에 담았다"
```

### 1.6 4MB 수집 예산이 프롬프트의 95%를 말없이 지웠다 (수정 R2 — 확인 크리틱 R2)

이 라운드에 **같이 실린** 앞선 수정분이다(코드는 있었는데 커밋도 기록도 안 돼 있었다).

`BULK_TEXT_BUDGET`(4MB)는 **배치 전역** 카운터였다. `git diff`가 경로 순으로 뱉는 앞쪽 큰
파일이 예산을 다 먹으면 **뒤 파일 전부가 헤더만** 나갔고, 아무 표시도 없었다.

```
재생성 큰 파일 5개(각 ~1MB) + 소스 10개  →  프롬프트 838자 (옛길 15,838자)
총량 캡 120,000에는 닿지도 않은 채 소스 10개 본문 전부 증발 · 표시 0
```

옛 주석은 「호출부의 예산은 12만 자라 프롬프트에 닿는 글자는 이 상한에 영향받지 않는다」고
단언했는데 거짓이었다. 지금은 **두 겹**이다.

| 겹 | 값 | 하는 일 |
|---|---|---|
| `BULK_FILE_TEXT_BUDGET` | 64KB | 파일마다 먼저 잘라 **한 파일이 남의 몫을 못 먹게**(넘긴 몫은 배치 예산에 돌려준다) |
| `BULK_TEXT_BUDGET` | 4MB | 그래도 바닥나면 **말하고** 버린다 |

버릴 때는 `GitFileDiffResult::body_dropped`에 사유(`File`/`Batch`)를 실어 보내고,
호출부(`aimsg.rs::build_diff_text`)가 그것을 문장으로 옮긴다 —
`### <경로> (+N −M) — 본문 생략(<사유>): 규모만 참고`. 캡 셋(파일 24,000자·총량 120,000자·
수집 예산)이 **전부 같은 모양**으로 착지한다. 64KB를 24,000자보다 넉넉히 위에 둔 이유:
거기 걸린 파일은 파일당 호출(옛길)로 받아도 **반드시** 파일 캡에 걸리므로 두 길의 프롬프트
문자열이 갈리지 않는다.

**그런데 그 코드에 그물이 없었다.** `BodyDropped`·`body_dropped`·두 예산 상수를 **두 크레이트
통틀어 만지는 테스트가 0건**이었다(R3 확인 크리틱 지적). 이미 한 번 조용히 새어 나간 자리다.

```
one_fat_file_folds_itself_and_says_so_while_the_next_file_keeps_its_body
   큰 파일 65줄×1,000B → dropped=File · (add,del) 정확 · 뒤 작은 소스 본문 3줄 전부 생존
the_batch_budget_folds_out_loud_and_the_counts_stay_exact
   80행 × 60,000B = 4.8MB → 11행 dropped=Batch · 본문 보유 4,140,000B(≤ 4MB 예산)
   80행 전부 (add,del) 정확 · **본문은 전부 있거나 전부 없다**(반쪽 0행)
a_fat_file_carries_its_reason_out_through_the_public_api   (진짜 git)
   body_dropped=File이 결과에 실림 · 헤더 (+100 −1) 정확 · 같은 배치 작은 소스 본문 생존
a_body_dropped_by_the_collector_never_leaves_a_bare_header  (aimsg.rs)
   File→「본문 생략(파일이 너무 큼)」 · Batch→「본문 생략(수집 예산)」 · 영어 판도 같은 자리
```

---

### 1.7 여섯 번째 자리 — `git show <rev>:<경로>`는 **실패를 성공으로 답한다** (수정 R3 — 확인 크리틱 R4)

> 확인 크리틱 R4의 치명 판정. 수정 R2가 §7.6에 「`:(literal)`은 이 크레이트가 git에 넘기는
> **모든 경로**의 규약」이라고 적었는데, **실측으로 거짓**이었다. 접두는 pathspec 문법이라
> `rev:path`(오브젝트 이름) 자리에는 못 붙는다. `discard()`가 부르는 `show_at()`이 바로 그
> 자리이고, 수정 R2는 그 위(`checkout`)와 아래(`rm --cached`) **여섯 줄 사이**를 지나쳤다.

**git 2.53.0.windows.1이 실제로 하는 말**(빌더가 직접 재현):

```
git show     'HEAD:app/posts/[id]/page.tsx'    → exit 0   · stdout 0바이트   ← 거짓말
git show     'HEAD:app/posts/plain/page.tsx'   → exit 128 "exists on disk, but not in 'HEAD'"
git cat-file -e 'HEAD:app/posts/[id]/page.tsx' → exit 128                    ← 바르게 답한다
```

경로에 pathspec 매직(`[`)이 있고 그 경로가 리비전에 **없으면** git은 인자를 글롭으로
재해석하고 아무것도 안 맞으면 조용히 성공한다. 그래서 `show_at`이 `Blob::Absent` 대신
`Blob::Text("")`를 돌리고, `discard`의 「HEAD에 없던 새 파일」 갈래가 **안 열린다**.

**무엇이 죽었나** — 수정 전, 앱 API 실측:

```
setup  app/posts/[id]/page.tsx · app/posts/plain/page.tsx 둘 다 새 파일 · 둘 다 git add(A)
       status가 주는 행: status="A", untracked=None → GitModal.tsx:358이 !!f.untracked=false로 부른다

discard app/posts/plain/page.tsx → ok=true  · 휴지통                    정상
discard app/posts/[id]/page.tsx  → ok=false
   err "pathspec 'app/posts/[id]/page.tsx' did not match any file(s) known to git"
   파일 그대로 · 인덱스 그대로 · 몇 번을 눌러도 같다                    영구 실패
```

같은 클릭에 옆 파일은 되는데 이것만 안 되니 **사용자에게는 무작위 고장으로 보인다**.
회귀는 아니다(접두 전에도 같은 자리로 떨어졌다) — 그러나 이 자리를 「닫았다」고 적은 것이
수정 R2다. 데이터가 사라지진 않는다(`file_diff`·`commit_file_diff`는 「없음」과 「빈 문자열」을
한 갈래로 다뤄 영향이 없다). **되돌리기 기능 하나가 그 이름 모양에서만 죽는다** — 그리고
그 이름 모양이 이 갈래가 근거로 든 바로 그 인구(`[id]`·`[slug]`·`[...slug]`)다.

**고친 방법 — 접두가 아니라 exit code 해석 쪽에서 막는다.** `show_at`의 성공 판정을
`git show`에만 맡기지 않고, **stdout이 비었을 때만** `cat-file -e`로 되묻는다.

```rust
let exists = || exec(root, &["cat-file", "-e", spec.as_str()]).ok;
let r = exec(root, &["show", spec.as_str()]);
if r.ok {
    // 0바이트 성공은 「빈 파일이 있다」와 「글롭으로 재해석돼 아무것도 안 맞았다」가
    // 겹치는 유일한 자리다. 여기서만 되묻는다.
    if r.stdout.is_empty() && !exists() { return Blob::Absent; }
    return Blob::Text(r.stdout);
}
```

- **매직 문자를 우리가 다시 세지 않는다.** git의 글롭 판정 문자 집합은 우리 소관이 아니고,
  이 재해석은 **항상 0바이트**로 나타난다(실측: 글롭이 실제로 맞는 경로가 있어도 그렇다 —
  둘 다 커밋된 뒤 `git show 'HEAD:app/posts/*/page.tsx'`는 여전히 0바이트).
- **스폰이 안 는다.** `discard`는 이미 실패 갈래에서 `cat-file -e`를 부르고 있었고, 이제
  같은 클로저를 나눠 쓴다. 실측: 대괄호 경로 `discard` 5스폰 · 평범한 경로 `discard` **5스폰**
  (`repo_root`+`checkout`+`show`+`cat-file -e`+`rm --cached`). 값을 치르는 유일한 경우는
  「리비전에 진짜로 있는 빈 파일」이고 그때만 하나 는다.
- **과잉 발동 방지가 더 위험한 쪽이다.** 되묻기가 빈 파일을 `Absent`로 뒤집으면 `discard`가
  **HEAD에 있는 파일을 휴지통으로** 보낸다(R1 크리틱 §S4가 고친 바로 그 사고). 그물을 따로 깔았다.

**실측 (수정 후, 레포 밖 독립 하네스 — `ccg-fs`를 path 의존으로 무는 릴리스 바이너리)**

```
raw  git show 'HEAD:app/posts/[id]/page.tsx'  → ok=true bytes=0   (git은 여전히 거짓말한다)
raw  git cat-file -e 같은 경로                 → ok=false          (오라클은 바르다)
status ["A app/posts/[id]/page.tsx untracked=None", "A app/posts/i/…", "A app/posts/plain/…"]

discard app/posts/[id]/page.tsx  → ok=true · err=None · 스폰 5 · 파일 사라짐
discard app/posts/plain/page.tsx → ok=true ·            스폰 5 · 파일 사라짐
남은 인덱스 ["app/posts/i/page.tsx", "seed.txt"]
이웃 app/posts/i/page.tsx = "이웃의 저장 안 한 편집\n"      ← 한 글자도 안 움직였다

[과잉 발동 안 함] HEAD에 있는 빈 파일 "빈.txt" · "app/[id]/빈.tsx"
  지우고 file_diff → error=None · diff 있음      (「내용을 읽을 수 없어요」가 아니다)
  discard          → ok=true · 파일 복원됨        (휴지통으로 안 갔다)
```

**그물 둘**(`cargo test -p ccg-fs` 96 → **98**):

```
a_staged_bracket_path_is_discardable_even_when_git_show_says_exit_zero
   A 스테이징된 대괄호 새 파일 discard ok · 파일·인덱스 정리 · 이웃 무접촉
   (인덱스 확인은 `git show :<경로>`로 하면 안 된다 — 그 자리도 같은 글롭 재해석에 걸린다.
    `ls-files --` + 접두로 물었다. 이 테스트를 처음 쓸 때 실제로 걸렸다.)
a_genuinely_empty_blob_still_reads_as_present
   HEAD에 있는 빈 파일(평범·대괄호 둘 다)은 여전히 Text("") · 삭제 diff가 나온다
```

**그물이 무는지 확인했다** — 되묻기 한 줄을 `if false &&`로 꺼서 돌렸다:

```
a_staged_bracket_path_… FAILED  "HEAD에 없는 대괄호 경로를 「빈 파일이 있다」로 읽었다"
  단언을 풀고 더 내려보내면 크리틱이 잰 문구가 그대로 나온다:
  "스테이징된 대괄호 새 파일 되돌리기가 실패했다:
     Some(\"pathspec 'app/posts/[id]/page.tsx' did not match any file(s) known to git\")"
a_genuinely_empty_blob_… 은 그대로 통과 (이 그물은 되묻기가 아니라 과잉을 잡는다)
```

**문장도 고쳤다.** `LITERAL` 상수 문서에서 「모든 경로」를 지우고 「**pathspec 자리**는
예외 없이, `rev:path`는 접두로 못 막으니 `show_at`이 exit code 해석 쪽에서 따로 막는다」로
바꿨다. §1.5 표의 「넷」도 「다섯」으로 고쳤고, §7.6도 다시 썼다(아래).

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

### 2.5 「몇 개든 1~2회」는 조건부였다 — 확인 크리틱이 판 구멍 둘 (R1 정정)

크리틱이 두 자리를 실측했다. **답은 맞았고 속도만 옛날로 돌아갔다** — 정확히 위 문단이
말한 「테스트로는 안 잡히는」 성질의 회귀다. 배치 **전체**가 파일당 호출로 내려앉았다.

| 자리 | R1 (크리틱 실측) | 이 라운드 |
|---|---|---|
| unborn HEAD 300파일 | **902스폰 · 31,272ms** | **3스폰 · 107ms** (292배) |
| 전 트리 32MB 초과 | 600파일·45.2MB = **1,202스폰 · 32,355ms** | 400파일·72MB = **9스폰 · 1,743ms** |

- **unborn HEAD**(첫 커밋 전) — `git diff HEAD`가 죽는 건 갈라도 마찬가지다. 그런데 그건
  「옛 쪽이 통째로 비어 있다」는 뜻이라 **git을 더 부를 것이 없다**: 디스크에서 읽어
  전부 새 파일로 답한다. `rev-parse --verify --quiet HEAD` 한 번으로 그 상태를 확인하고
  들어간다(그래서 3스폰: `repo_root` + 실패한 diff + rev-parse).
- **32MB 캡 초과** — 목록을 **반으로 갈라** 다시 부른다. 스폰이 파일 수가 아니라 `log`로
  는다. 파일 **하나**가 혼자 캡을 넘으면 더 못 가르므로 그 덩이만 옛길이 사유를 낸다.

새 테스트 둘이 이 두 수치를 실행으로 남긴다
(`an_unborn_head_answers_without_a_spawn_per_file`,
`an_oversize_whole_tree_splits_instead_of_going_per_file` — 뒤쪽은 32MB를 실제로 써야 해서
`#[ignore]`). 앞의 것은 300파일 답을 30표본으로 옛길과 1:1 대조하고, 나머지 270행도
자기 자리에 답이 있는지 본다.

### 2.6 새 거짓말 하나 — 미추적 **폴더** 행 (R1 정정)

status는 미추적 폴더를 한 줄로 접어 `새 폴더/`로 준다. 그 행이 그대로 diff 수집에 온다.

```
R1      {tag:"edit", add:0, del:0}        ← "이 폴더는 안 바뀌었다"고 AI에게 단언
옛길    {error:"내용을 읽을 수 없어요"}
```

폴더는 `git diff`에도 `ls-files --others`(파일만 준다)에도 **절대 안 실린다**. 그런데
새 길은 「diff에 없다 + `exists()`가 참 = 추적 중인데 안 바뀌었다」로 읽었다. `exists()`를
`is_file()`로 바꿔 옛길로 보낸다. `an_untracked_folder_row_never_claims_it_is_unchanged`가
**git이 실제로 폴더 한 줄로 접는지부터** 확인하고(픽스처가 아니라 git의 행동이 근거다)
옛길과 사유가 같은지 본다. 고치기 전 코드로 돌려 `("edit", 0, 0)`이 나오는 것도 확인했다.

### 2.7 의도적 분기 (기록: `docs/renderer-divergence.md` §6.4)

- diff 엔진이 자체 LCS → `git diff -U0`로 바뀌어 **줄 귀속이 드물게 다를 수 있다**.
- 1.5MB 초과 파일은 본문을 통째로 접던 것이 **변경 줄은 그대로** 나온다(더 낫다).
- **뷰어는 안 갈렸다** — 뷰어 계약(전체 파일·ctx 포함)은 `file_diff` 그대로다.
- **되돌아가는 단위**를 §6.4에 표로 다시 적었다. R1은 전부 「그 파일만」이라고 적었는데
  unborn·캡 초과는 **배치 전체**였다 — 그 문장이 §2.5의 구멍을 덮고 있었다.

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
(`app/src/components/Settings.tsx:1208` `oldCount` 정의 · `:1398` 렌더 게이트 —
**수정 R2 정정**: R1이 적은 `:1280`은 오기였다). 픽스처는 실홈의 `engines`·`codex-engines`를
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

그리고 그 값이 곧바로 사고를 하나 잡아냈다 — §3.4.

### 3.4 G3가 잡아낸 것 — 19화면 A/B가 **서로 다른 캔버스**로 찍혀 있었다 (R1 정정)

> **R1은 여기서 자기 데이터의 반대를 적었다.** 이 자리에 「본 패스 18행 두 앱 모두
> `[1320, 880]`」이라고 썼는데, 같은 커밋의 `report.json`과 PNG 픽셀은 3.0 17행이
> `[1440, 900]`, 2.6.2 17행이 `[1320, 880]`이었다. 확인 크리틱이 실패시킨 항목이다.

**원인**은 하네스의 `fixWindowSize`(`Browser.setWindowBounds`로 1440×900 강제)가
**3.0에만 먹는 한쪽짜리 레버**라는 것이다. 리포트가 스스로 그 사실을 적고 있었다
(`windowSized: tauri true · electron false`). 강제가 한쪽에만 먹으니 3.0은 1440×900으로
끌려가고 2.6.2는 자기 기본값 1320×880에 남아, **같은 화면 두 장이 다른 캔버스**가 됐다.
`ab.mjs`의 M12 R2 주석은 이미 그 처방까지 적어 뒀는데(「강제하지 말고 앱이 자기 크기를
적용할 때까지 기다렸다 찍어라」) 본 패스에는 안 옮겨져 있었다.

**고친 것** — 강제를 **전부 뺐다**(`fixWindowSize` 삭제 → `settleWindowSize`).
캔버스는 앱이 자기 크기를 적용해 안정될 때까지 기다렸다 **재서 기록한다**.
`report.viewport = VIEW`(강제하려던 값)도 `report.canvas`(잰 값)로 바꿨다 — 리포트가
자기 사진과 다른 숫자를 적을 수 있던 자리를 없앤다.

**재실측**(19화면 × 2앱 통짜 재주행, PNG 픽셀까지 대조):

```
3.0    canvas [1320,880] · 19행 · 18/19 (94.7%) · canvasMismatch []
2.6.2  canvas [1320,880] · 19행 · 18/19 (94.7%) · canvasMismatch []

두 앱 캔버스 + PNG 픽셀이 완전히 같은 행   18 / 19
유일한 차이 boot-splash-native            3.0 [1320,880] in-window-overlay
                                          2.6.2 [300,240] separate-window   ← 의도된 구조 차이
viewport: null                            0행 (38행 전부)
```

3.0의 **진짜** 기본 창은 1320×880이다 — M12 R2가 문장으로 적어 둔 「같은 기본 창 크기」가
이제야 값으로 맞는다. R1에서 3.0의 별도 창 화면(`limit-hold-bar`)만 1320×880이었던 것이
바로 그 증거였다(그 창은 강제 대상이 아니었다).

**재발 방지 — 하네스가 스스로 말한다.** 실행이 끝나면 같은 태그의 반대편 리포트를 열어
화면별 `viewport`를 맞춰 보고, 어긋나면 stderr로 경고하고 `canvasMismatch`에 남긴다.
실주행으로 유발해 확인했다(반대편 리포트에 1440×900을 심고 재주행):

```
[ab] 경고 — 두 앱 캔버스가 다른 화면 1개: settings-language [1320,880]≠[1440,900]
[ab]        이 사진들은 픽셀 비교의 근거가 못 된다(캔버스가 다르면 레이아웃이 달라진다).
```

**그리고 사진이 자기 크기를 들고 오게 했다.** 이번 라운드에서 「리포트가 적은 숫자」와
「PNG의 실제 픽셀」을 맞춰 본 것은 하네스 밖의 일회성 코드였다 — R1이 틀린 이유가 바로
**그 대조를 사람이 해야 했다**는 것이다. 이제 `shoot()`이 PNG 헤더(IHDR)의 가로·세로를
돌려주고 행마다 `png`로 남긴다. `viewport`와 어긋나면 stderr 경고 + `pngViewportOff`.

이게 중요한 이유가 하나 더 있다: **PNG는 커밋되지 않는다**(`.gitignore:42` `bench/shots/**` —
`report.json`만 강제로 추적한다). 그러니 다음 라운드가 손에 쥐는 증거는 리포트뿐이고,
사진의 크기가 리포트 안에 없으면 「사진과 다른 말」은 영영 검증할 수 없다.

```
38행 전부 report.png == 디스크 PNG 실제 픽셀 == row.viewport      (어긋난 행 0)
성공 행 36장 PNG 존재 · 실패 행(settings-engine-confirm) 양쪽 다 PNG 없음
```

**같이 고친 세 가지**
- **실패 행 옆의 옛 PNG를 치운다.** R1의 `settings-engine-confirm.png` 두 장은 두 시간 전
  실행분(1320×880)이 그대로 남아, 실패한 행 옆에서 성공한 사진처럼 보였다. 이제 못 찍은
  행은 옛 PNG를 지우고 `stalePngRemoved`를 남긴다(실주행으로 확인 — 심어 둔 PNG가 사라졌다).
- **행 순서를 항상 `screens.mjs` 정의 순서로.** 예전엔 병합할 때만 정렬해서, 통짜 실행본과
  병합본의 행이 서로 밀려 있었다. 두 리포트를 나란히 놓는 것이 파리티 감사가 하는 일이다.
- ①번 경고(`--only` 개수 대 행 수)가 `--merge`에서 **항상** 울던 것을 고쳤다 —
  병합 후 총계가 아니라 **이번 판이 실제로 남긴 행 수**를 본다(늘 우는 경고는 안 읽힌다).

---

## 4. 검증 요약

```
cargo test -p ccg-fs       100개 중 98 통과 · 0 실패 · 2 ignored(느린 근거 측정)  (88 → 96 → 98)
   ignored 2개 직접 실행    2 통과 (39.0s — 옛길 파일당 2스폰·32MB 초과 분할)
cargo test -p agentcodegui  143 통과 · 0 실패 · 0 ignored (수정 R3 재확인 — 트리가 깨끗해진 뒤)
cargo check -p ccg-fs                                     경고 0
npm run typecheck (node·web) · npm run typecheck:app     3종 초록 (exit 0)
node --check bench/ab.mjs                                 통과
A/B 19화면 × 2앱                                          각 19행 · 18/19 · 94.7%
                                                          두 앱 캔버스 동일(§3.4), canvasMismatch []
                                                          PNG 18장 × 2앱(실패 행 하나는 못 찍는다)
```

새 테스트 9개(7 실행 + 2 ignored): 2,000파일 커밋 · 빈 목록 차단 · 긴 본문 stdin ·
훅 거부 롤백 600경로 · bulk vs 파일당 답 대조 · 전 트리 갈래 900파일 ·
**미추적 폴더 행** · **unborn 300파일 스폰** · **32MB 초과 분할**(ignored).

**수정 R2가 더한 테스트 9개** — ccg-fs 8: 대괄호 커밋+롤백 · **세 행 모양**(폴더 행·삭제 행·대괄호 행) ·
대괄호 되돌리기 · argv diff 대괄호 · argv 예산이 접두를 셈 · 파일별 예산 · 배치 예산 ·
예산 사유의 공개 API 왕복.
agentcodegui 1: 접힌 본문이 문장이 되는지(`build_diff_text`).
앞의 넷은 접두를 지운 코드(`LITERAL = ""`)로 돌려 **전부 실패하는 것**을 확인했다 —
그물이 무는지 안 본 그물은 그물이 아니다.

**수정 R3이 더한 테스트 2개**(ccg-fs) — `rev:path` 글롭 방어와 그 **과잉 발동** 방지(§1.7).
이 둘도 그물이 무는지 확인했다: 되묻기 한 줄을 `if false &&`로 꺼면 앞 테스트가
「HEAD에 없는 대괄호 경로를 「빈 파일이 있다」로 읽었다」로 빨개지고, 단언을 풀고 더
내려보내면 크리틱이 잰 실패 문구가 그대로 나온다.

`cargo test -p agentcodegui`는 수정 R1까지 **일부러 안 돌렸다**(워킹트리에 다른 갈래의
미커밋 Rust가 얹혀 있어 그 결과가 이 갈래의 증거가 못 된다). 수정 R2가 처음 돌렸을 때는
**143 중 이 갈래 몫은 1개**라고 유보했는데, 그 뒤 옆 갈래들이 커밋을 끝내 트리가 깨끗해졌고
수정 R3이 다시 돌려 같은 143/0/0을 확인했다 — **유보는 이제 필요 없다**(확인 크리틱 R4도
같은 수를 독립으로 쟀다). 그때 워킹트리에 있던 변경은 **이 갈래의 `git.rs` 하나뿐**이었다
(`git status`로 확인). 그 뒤 옆 갈래들이 다시 작업을 시작했으므로, 이 수를 다시 확인하려면
트리 상태를 함께 봐야 한다.

재실측(수정 R3, 같은 테스트):

```
2,000파일 커밋   760ms · git 스폰 3회 (argv였다면 128,000자)
                 ↑ 테스트가 만드는 얕고 같은 내용의 판이다. 현실의 깊은 판은 **33초**이고
                   그 몫은 전부 git이다 — 왜 이 수를 그대로 두고 옆에 적는지는 §1.4 참조.
900파일 bulk     204ms · git 스폰 2회
unborn 300파일   281ms · git 스폰 3회
배치 예산        80행 중 11행 접힘 · 본문 보유 4,140,000B (≤ 4MB)
대괄호 되돌리기  A 스테이징 · [id] ok=true 5스폰 / plain ok=true 5스폰 (스폰 증가 0)
```

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
  **수정 R1**: `diff_once`/`diff_into`(반 가르기)·`unborn_file_diff`·`is_file()` 정정·테스트 3.
  **수정 R2**: `LITERAL`/`literal_spec`/`fits_argv` 신설 → `nul_pathspec`·`diff_once`·
  `discard`(checkout·rm --cached)·`err_line`(접두 제거)·수집 예산 두 겹(`BodyDropped`)·테스트 8.
  **수정 R3**: `show_at`의 0바이트 성공을 `cat-file -e`로 되묻기(접두가 못 닿는 여섯 번째
  자리 — `rev:path`)·`LITERAL`/`show_at`/`discard` 문서 정정·테스트 2.
- `src-tauri/src/ipc/parity/aimsg.rs` — diff 수집 3줄(**경계 밖**: 숙제가 지목한
  ai-message 경로가 이 파일로 옮겨져 있었다. 이 파일의 다른 hunk는 안 건드렸다).
  **수정 R1**: 주석만(「몇 개든 1~2회」가 조건부였다).
  **수정 R2**: `build_diff_text` 분리(캡 셋이 전부 문장으로 착지) + 테스트 1.
- `bench/ab.mjs` — G2 경고 2줄·G3 viewport·`shotWhen`이 캔버스를 같이 돌려준다.
  **수정 R1**: `fixWindowSize` 삭제 → `settleWindowSize`·`report.canvas`·반대편 캔버스 대조
  경고·실패 행 옛 PNG 정리·행 순서 항상 정렬·①번 경고의 `--merge` 오경보 제거.
- `bench/shots/{tauri,electron}-m12r2/report.json` — 19행 재채움(G1).
  **수정 R1**: 두 앱 통짜 재주행(캔버스 강제 없이) — PNG **36장**(앱마다 18장)도 같이
  새로 찍혔다. **수정 R2 정정**: R1이 적은 「37장」은 오기다. 못 찍는 행은 두 앱 모두
  `settings-engine-confirm` 하나뿐이라 19행 − 1 = 18장 × 2앱이 맞다(디스크 실측 18·18).
- `docs/renderer-divergence.md` — §6.4 추가(끝에 덧붙임, 남의 절 무접촉).
  **수정 R1**: §6.4의 「되돌아가는 단위」 표 정정.
- `docs/parity-fix-git-r1.md` — 이 문서.

안 만진 것: 동결 구역 `src/`·`out/`·`dist/` · `bench/screens.mjs`·`bench/lib.mjs` ·
`bench/shots/{tauri,electron}/report.json`·`bench/results/*`·`docs/critic/*.json` ·
다른 갈래의 미커밋 변경(`app/**`·`crates/ccg-auth`·`crates/ccg-engine`·`src-tauri/src/engine/**`
·`ipc/accounts.rs`·`ipc/parity/{usage,mod}.rs`·`src/shared/*`).

---

## 7. 다음 라운드가 이어받을 것

1. **실앱 실측이 남았다.** 수정 R3은 크레이트 테스트에 더해 **레포 밖 독립 하네스**
   (`ccg-fs`를 path 의존으로 무는 릴리스 바이너리)로 `commit`·`discard`·`file_diff`·`status`를
   공개 API로 직접 불러 쟀지만, 그래도 **Tauri exe를 세워 Git 카드에서 눌러 본 확인은
   아직 없다**(병렬 규율상 공용 `target/` 재빌드를 피했다). 다음 정식 빌드 뒤에 특히
   ① 대괄호 경로 되돌리기 ② 대량 커밋 중 카드가 멎어 보이는 시간 ③ AI 메시지 카드를
   실제로 확인해야 한다.
2. `settings-engine-confirm`은 **환경 의존 화면**이다. 하네스가 「설치 버전이 1개라
   행이 없다」를 skip 사유로 구분해 주면 이 실패가 매번 파리티 실패처럼 보이지 않는다
   (`bench/screens.mjs`는 이번 경계 밖이라 손대지 않았다).
3. `bulk_file_diffs`는 지금 AI 메시지 한 곳만 쓴다. Git 카드가 여러 파일 diff를
   미리 받는 자리(선택 파일 전체 미리보기)가 생기면 같은 함수를 쓰면 된다.
4. **캔버스 대조는 「같은 태그의 반대편 리포트」가 있을 때만 돈다.** 한 앱만 돌리면
   비교할 상대가 없어 조용하다(그때는 `canvasComparedWith`가 리포트에 안 남는다).
   A/B는 늘 두 앱을 같은 태그로 돌리는 규약이라 실무에선 걸리지만, 규약이 깨질 여지는
   남아 있다 — 다음 라운드가 「반대편이 없으면 그것도 경고」로 조일지 판단하면 된다.
5. **최종 파리티 세트(`bench/shots/{tauri,electron}/`)는 확인해 봤고 — 사진은 멀쩡하다.**
   같은 병에 걸렸는지 의심해서 PNG를 직접 쟀다(읽기만 했다. 기준 결과 파일이라 규약 §6):

   ```
   공통 114장 중 크기가 다른 것 2장 — toast-aggregate(360×172 vs 344×164)·
                                      toast-single(360×109 vs 344×103)  ← 토스트 창 자체 크기
   나머지 112장 두 앱 모두 1320×880
   ```

   즉 **그 세트는 픽셀 비교에 쓸 수 있다**. 다만 그 `report.json`은 아직 옛 모양이라
   `viewport: {1440,900}`(강제하려던 값)를 위에 적고 행별 `viewport`는 **전부 없다**
   (`windowSized: tauri true · electron false`도 그대로다) — 숫자만 보면 사진과 반대로
   읽힌다. 다음에 그 세트를 통짜로 다시 찍으면 리포트가 사진과 같은 말을 하게 된다.
   토스트 두 장의 16px 차이는 이 라운드 밖의 실제 차이라 그대로 남긴다.
6. **`:(literal)`은 pathspec 자리의 규약이다 — 「모든 경로」가 아니다**(수정 R2 →
   수정 R3 정정). 앞으로 **pathspec**을 새로 쓰는 자리는 예외 없이 `literal_spec()`을 지나야
   한다 — 이번 사고가 난 이유가 정확히 「pathspec을 만드는 새 헬퍼를 만들면서 그 규약이
   없었다」이기 때문이다. 지금 다섯 자리다(§1.5 표).

   **그러나 `rev:path` 자리는 접두 규약으로는 못 막는다.** 수정 R2가 여기 「모든 경로」라고
   적었고 그 문장이 실측으로 거짓이라 확인 크리틱 R4가 이 라운드를 불합격시켰다 — `discard`가
   부르는 `show_at`의 `git show HEAD:<경로>`가 규약 밖이었고, 대괄호 경로의 되돌리기가
   영구히 죽어 있었다(§1.7). `:(literal)`은 pathspec **문법**이라 오브젝트 이름에 붙이면
   진짜로 그런 이름을 찾는다. 그 자리의 글롭 방어는 **exit code 해석**으로 한다(`git show`의
   exit 0을 존재 증명으로 쓰지 말고 `cat-file -e`로 되묻기 — `show_at` 문서에 실측과 함께
   적어 뒀다). **새 git 호출을 쓸 때 물을 것은 「접두를 붙였나」가 아니라 「이 인자가
   pathspec인가 오브젝트 이름인가」다.**

   `git status`가 주는 경로는 늘 루트 상대·슬래시라 접두가 안전하지만, 만약 앞으로 절대
   경로를 넘기는 호출부가 생기면 pathspec 의미가 달라진다(그건 접두와 무관한 별개 계약이다).
7. **2.6.2도 같은 글롭 구멍이 있다**(`src/main/git.ts:358`). 동결 구역이라 안 고쳤다 —
   파리티는 「3.0이 더 정확한」 쪽으로 갈렸고, `docs/renderer-divergence.md`에 적을 만한
   분기다. 3.0이 기준이 되는 시점에는 이 문단이 근거가 된다.
   `show_at`의 `rev:path` 구멍(§1.7)도 2.6.2에 같은 모양으로 있는지는 안 쟀다 — 그쪽은
   `git show`를 다른 자리에서 부른다. 동결 구역이라 이번에도 안 건드렸다.
8. **대량 커밋에 진행 표시가 없다.** §1.4 실측대로 현실적인 2,000파일 트리는 **33초**가
   걸리고 그 몫은 전부 git이다(래퍼 몫 0 · 접두 비용 0). 지금 Git 카드는 그동안 아무 말도
   안 하므로 사용자에게는 「멎었다」로 보인다 — 실제로 이 갈래를 연 사용자 보고가
   「파일 개수가 많으면 커밋이 **안 된다**」였다. 스폰을 줄이는 최적화는 이미 바닥이니
   (3스폰) 다음 라운드가 할 일은 **속도가 아니라 말**이다: 커밋 버튼을 누른 뒤 진행/취소
   불가 상태를 렌더러에 알리는 채널. 계약면(`protocol.ts`)과 `app/` 렌더러를 건드려야 해서
   이번 경계 밖이다.
9. **`show_at`의 되묻기는 「0바이트일 때만」이다.** git이 언젠가 `rev:path`의 글롭 재해석을
   고치면 이 우회는 공짜가 될 뿐 깨지지 않는다(테스트 단언은 결과만 본다 — 버전 업그레이드로
   빨개지지 않게 일부러 그렇게 썼다). 반대로 git이 **0바이트가 아닌** 거짓 성공을 주기
   시작하면 이 우회는 못 막는다. 지금 git 2.53.0에서는 재해석이 항상 0바이트다(실측).
