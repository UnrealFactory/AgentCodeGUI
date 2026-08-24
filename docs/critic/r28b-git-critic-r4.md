# R28b GIT 확인 크리틱 — 대괄호는 다섯 자리에서 막혔다. 같은 함수 여섯 줄 아래에서 안 막혔다

라운드: R28b GIT 확인 크리틱(라운드 2 · 새 컨텍스트·전면 재실측) · 2026-08-25 · `feature/3.0.0-beta`
판정 대상: `fe18f76` (`crates/ccg-fs/src/git.rs` · `src-tauri/src/ipc/parity/aimsg.rs` ·
`docs/parity-fix-git-r1.md` — 3파일)

**판정: 불합격(pass=false).** 숙제 체크리스트 5항목은 **전부 실측 통과**했고, R3 크리틱이
실패시켰던 대괄호 사고는 **커밋 add·롤백 reset·되돌리기 checkout·rm --cached·대량 diff
다섯 자리에서 진짜로 막혔다**(raw git 음성 대조까지 직접 재현했다). 그런데 이 라운드가
스스로 세운 계약이 깨진다.

> §7.6 「`:(literal)`은 이제 이 크레이트가 git에 넘기는 **모든 경로**의 규약이다」

`discard()` 안에서, 방금 고친 `checkout HEAD --` 줄(`git.rs:1454`)에서 **여섯 줄 아래**
(`:1460`)에 있는 `show_at(&root, "HEAD", rel)`은 그 규약을 안 지난다. 그래서 **`app/posts/[id]/page.tsx`가
스테이징(`A`)돼 있으면 되돌리기가 아무것도 안 하고 raw git 영어 문구를 뱉는다.** 옆에 있는
`app/posts/plain/page.tsx`는 같은 클릭에 정상 동작한다 — 사용자에게는 무작위로 보인다.

---

## 0. 파일 이름에 관하여

숙제는 판정문을 `docs/critic/r28b-git-critic-r2.md`로 쓰라고 했다. **그 파일은 이미 커밋돼
있다**(`f8a8ed8`). 같은 갈래의 `r1.md`(`43a1b36`)·`r3.md`(`b369599`)도 있다. 덮어쓰면 커밋된
판정문 하나가 지워지고 「r2가 r3보다 최신인 장부」라는 자기모순이 남는다. 그래서 순번을 이어
**r4**로 쓴다(R3 크리틱이 r3를 고른 것과 같은 이유). 앞선 세 판정문은 한 글자도 안 건드렸다.

## 1. 실측 방법 — 빌더의 테스트를 근거로 쓰지 않았다

레포 **밖**(`%TEMP%/ccg-gitcrit4`)에 `ccg-fs`를 path 의존으로 무는 독립 릴리스 바이너리를
세우고 `commit` / `discard` / `file_diff` / `bulk_file_diffs` / `commit_file_diff` /
`status` / `spawn_count`를 **직접** 불렀다. 빌더 테스트는 「빌더가 적은 수가 맞나」를 볼 때만
따로 돌렸다.

- 격리: `CARGO_TARGET_DIR=%TEMP%/ccg-gitcrit4-target` · `CCG_HOME=%TEMP%/ccg-gitcrit4-home` ·
  스크래치 레포 `%TEMP%/ccg-gitcrit4-scratch|t1b|t8` · A/B 태그 `gitcrit4` · CDP 포트 `9911`.
- **이름 기반 kill 0회.** 사용자 실앱(`AgentCodeGUI.exe` 5프로세스, pid 6644·12924·23792·
  24836·26924)은 측정 전후 그대로 살아 있다. 내가 띄운 것은 ab.mjs가 스폰한 `electron.exe`
  2회뿐이고 하네스가 자기 PID로 걷었다.
- 기준 결과 파일 무접촉: `bench/shots/{tauri,electron}{,-m12r2}/report.json` · `bench/results/*` ·
  `docs/critic/*.json`은 **읽기만** 했다. 경고 유발은 새 태그 `bench/shots/electron-gitcrit4/`에
  했고 측정 후 삭제(잔여 0 확인).
- git 2.53.0.windows.1 · cargo 1.96.1 · node v24.13.1.
- 측정 중 옆 갈래 둘이 커밋했다(`d1fd1f7` RVERD · `6891372` ACCT). 워킹트리가 깨끗해진 뒤
  크레이트 테스트를 **다시** 돌려 수를 재확인했다(아래 ④).

---

## 2. 체크리스트 5항목 — 전부 실측 통과

### ① 2,000파일 커밋 — 기능은 통과. **시간은 보고서의 21배**

경로 2,000개(한글·공백·6단 중첩), **argv 합계 192,000바이트 = 한계 32,767의 5.9배**.
같은 판에서 옛 방식을 먼저 쏴 봤다.

```
[옛길] argv add(2.6.2 src/main/git.ts:358과 같은 모양)
        → 스폰 실패  os error 206 "파일 이름이나 확장명이 너무 깁니다"  · 스테이징 0행
[새길] ccg_fs::git::commit → ok=true · git 스폰 3회(repo_root + add + commit)
        추적 2001(seed + 2000) · 안 고른 NOT-PICKED.txt는 `??` 그대로
        메시지 왕복 "대량 커밋 크리틱\n\n본문\n#해시 줄\n한글 본문\n"   ← `#` 줄·한글 무손실
```

시간은 3회 재서 **16,059 / 16,656 / 16,550 ms**. 어디서 오는지 갈라 봤다.

| 판 | 값 |
|---|---|
| raw git 3단계(래퍼 밖, 같은 파일 2,000개) | rev-parse 13ms · **add 9,035ms** · **commit 7,157ms** = 16,205ms |
| 같은 판을 `ccg_fs::git::commit`으로 | **15,879ms** · 스폰 3 |
| 같은 트리를 다시 만져 두 번째 커밋(warm) | 17,023ms · 스폰 3 |
| 빌더 테스트 `a_two_thousand_file_commit…` 재현 | **1,407ms** · 스폰 3 (보고서 831/760ms와 같은 판) |

**래퍼 몫은 0이다**(15,879 ≤ 16,205). 16초는 git 몫이다. 빌더의 760/831ms가 낮은 이유도
분명하다 — 그 테스트는 폴더 40개·2단 깊이에 **2,000파일이 전부 같은 내용**(`한 줄\n`)이다.
내 판은 폴더 400개·6단 깊이에 내용이 전부 다르다. 둘 다 「2,000파일」이지만 사용자가 겪는
쪽은 뒤쪽이다.

**`:(literal)` 접두가 느리게 만든 건 아니다** — raw git으로 접두 유무만 바꿔 4판 잰다:

```
flat(폴더 40)  bare-cold 377ms(2000행) · literal-cold 377ms(2000행) · bare-warm 369 · literal-warm 363
deep(폴더 400) bare-cold 579ms         · literal-cold 550ms         · bare-warm 582 · literal-warm 605
```

접두 비용 0. 하지만 **「2,000파일 커밋 760ms」는 여전히 장부에 남을 수를 잘못 대표한다**
(§5-G2).

### ② 유니코드·공백 경로 + 훅 거부 롤백 — 통과

```
고른 5경로  한글 폴더/한글 파일 이름.txt · spaces in name/日本語 ファイル.md
            emoji 🚀 dir/naïve café.txt · 깊은/중첩/경로/파일#해시.txt
commit ok=true · 스폰 3 · 추적 5행(seed 포함) · 안 고른 "안 고른 한글.txt"는 `??` 그대로

pre-commit exit 1 → ok=false · err "훅이 거부한다"(git 문구 그대로가 아니라 훅 stderr 한 줄)
  롤백 전 스테이징 ["남의 스테이징.txt"] → 후 ["남의 스테이징.txt"]   ← 남의 것을 안 걷었다
  커밋 수 2 유지(init + 유니코드 커밋)
없는 파일 커밋 err "pathspec '없는 파일.txt' did not match any files"  → `:(literal)` 누출 0
없는 파일 되돌리기 err "삭제할 수 없어요"                              → 누출 0
```

### ③ AI diff 수집 — 파일 수와 무관하게 2스폰. 캡 둘 다 동작

```
n=   1 · bulk 2스폰   43ms · 본문 1/1   · 옛길 2스폰    · 답 일치
n=  10 · bulk 2스폰   45ms · 본문 10/10 · 옛길 20스폰   · 답 일치
n=  60 · bulk 2스폰   92ms · 본문 60/60 · 옛길 120스폰  · 답 일치
n= 300 · bulk 2스폰  116ms · 본문 300   · 옛길 600스폰  · 답 일치
n= 900 · bulk 2스폰  212ms · 본문 900   · 옛길 1800스폰 · 답 일치
   (빌더 ignored 테스트도 직접 실행: 900파일 옛길 41,365ms/1,800스폰 대 새길 251ms/2스폰)
```

**R2 크리틱이 잡은 4MB 사고의 재현판**(앞쪽 큰 파일 5개 × 1,000줄 × 1,000B + 뒤쪽 소스 10개):

```
스폰 2회
aaa-생성물-0..4.lock   +1000 -1 · 본문 0줄 · bodyDropped="file"   ← 말하고 접혔다
zzz-src/소스-00..09.rs +2   -0 · 본문 2줄 · bodyDropped=null
뒤 소스 10개 중 본문 살아남은 수 = 10        ← R2 사고 때는 0이었다
```

배치 예산도 재현: `80행 중 11행 접힘 · 본문 보유 4,140,000B(≤ 4MB) · 증감 오차 0`.
argv 예산 경계도 행동으로 확인 — 접두 포함 25,200B(n=1200)부터 전 트리 갈래로 넘어가고,
n=3000(63,000B)까지 **2스폰·정답 100%**를 유지한다(스폰 실패 0).

### ④ cargo test 무후퇴 + typecheck 3종 — 통과

```
cargo test -p ccg-fs        96 통과 · 0 실패 · 2 ignored     (직전 크리틱 88 → 96, 새 그물 8)
  ignored 2개 직접 실행     2 통과   (위 §③의 41초 줄이 여기서 나온다)
cargo test -p agentcodegui  143 통과 · 0 실패 · 0 ignored
  ↑ 옆 갈래가 커밋을 끝내 워킹트리가 깨끗해진 뒤 **다시** 돌려 같은 수를 확인했다.
    빌더가 「143 중 이 갈래 몫은 1개」라고 유보한 부분은 이제 유보가 필요 없다.
  aimsg만 필터: 8 통과 — a_body_dropped_by_the_collector_never_leaves_a_bare_header 포함
cargo check -p ccg-fs       경고 0
npm run typecheck (node·web) exit 0 · npm run typecheck:app exit 0 · node --check bench/ab.mjs 통과
```

### ⑤ A/B 19행 · 자기모순 없음 · 경고와 viewport 실동작 — 통과

| | tauri-m12r2 | electron-m12r2 |
|---|---|---|
| 리포트 행 | 19 | 19 |
| summary | attempted 19 · ok 18 · failed 1 · 94.7% | 동일 |
| 행 재계산 | 19 / 18 / 1 / 94.7% — **일치** | 동일 |
| 디스크 PNG | **18장** | **18장** |
| ok인데 PNG 없는 행 | 0 | 0 |
| 리포트에 없는 PNG | 0 | 0 |
| 행별 `viewport` | 19/19 | 19/19 |
| 실패 행 | `settings-engine-confirm` (clickText: no .set-inner button containing 정리) | 동일 |

보고서의 오기 정정 둘도 **소스로 확인**: PNG 「37장」→ **36장**(18+18, 디스크 실측) ·
`Settings.tsx:1208`이 `oldCount` 정의, `:1398`이 `{oldCount > 0 && (` 렌더 게이트 — 둘 다 맞다.

**경고 가드는 실주행으로 유발했다**(스크래치 태그 `gitcrit4`·포트 9911·격리 홈, 19행을 심고
단건 재주행):

```
① --only=settings-display (단건, --merge 없음)
   [ab] 경고 — 이전 리포트 19행을 1행으로 덮어쓴다. 단건 재주행이면 --merge를 붙여라
   남은 행: {"id":"settings-display", "ok":true, "png":[1320,880], "viewport":[1320,880]}
            ↑ viewport와 png가 **같은 행에 같이** 찍혔다(G3는 문장이 아니다)
② --only=settings-display,no-such-screen --merge
   [ab] 경고 — --only 2개인데 이번 판이 남긴 건 1행 — 도달 못 한 화면이 통째로 빠졌다
   --merge가 19행을 지켰다(요약 19/18/94.7%)
```

---

## 3. 대괄호 수정은 **진짜로** 됐다 — raw git으로 음성 대조까지 했다

빌더의 새 테스트를 믿지 않고, 앱 API와 raw git 양쪽으로 다시 세웠다.

```
[커밋]  고른 것 2개 app/posts/[id]/page.tsx · app/posts/[...slug]/page.tsx
        이웃 3개   app/posts/{i,d,s}/page.tsx 를 나란히 두고 commit()
        → 추적 3행 ["app/posts/[...slug]/page.tsx", "app/posts/[id]/page.tsx", "seed.txt"]  PASS

[되돌리기] discard("app/posts/[id]/page.tsx", untracked=false)
        [id] "원본\n되돌릴 줄\n" → "원본\n"                                   (되돌아감)
        i    "원본\n이웃의 저장 안 한 편집\n" → 그대로                         (안 쓸림)
        d    "원본\n또 다른 이웃 편집\n"     → 그대로                          PASS

[raw git 음성 대조 — 접두가 진짜 일하는지]
   git checkout HEAD -- "app/posts/[id]/page.tsx"            → i의 편집이 사라짐 (orig|)
   git checkout HEAD -- ":(literal)app/posts/[id]/page.tsx"  → i 그대로 · [id]만 되돌아감

[대량 diff] diff_once의 argv 갈래가 이웃 키를 안 물어 온다 · bulk와 옛길의 (add,del) 일치

[접두가 깨뜨릴 수 있었던 것] 한 커밋에 세 모양을 섞어 commit()
   status 행 [("D","삭제될.txt"), ("A","새 폴더/"), ("A","app/")]
   커밋 내용  A app/posts/[id]/page.tsx · D 삭제될.txt
              A 새 폴더/안쪽 1.txt · A 새 폴더/안쪽 2.txt · A 새 폴더/더 깊이/안쪽 3.txt
              ↑ 폴더 행의 접두 매칭이 **재귀로** 살아 있다(2단 아래까지) · 이웃 app/posts/i/는 `??` 그대로

[매직처럼 보이는 이름] "(literal)이상한.txt" · "!느낌표.txt" · "#해시로 시작.txt"
   "-대시로 시작.txt" · "app/[a-z]/page.tsx"  5개 동시 커밋 ok · 이웃 app/q/page.tsx 미포함
```

이 부분은 **합격**이다. R3 크리틱이 실패시킨 자리는 닫혔다.

---

## 4. ★ 치명 — `discard`의 세 번째 pathspec 소비자가 규약 밖에 있다

### 4.1 무슨 일이 나나

```
setup   app/posts/[id]/page.tsx  · app/posts/plain/page.tsx   둘 다 새 파일, 둘 다 `git add` 된 상태(A)
        (Git 카드의 status 행: status="A", untracked=None → GitModal이 !!f.untracked = false로 부른다)

되돌리기 app/posts/plain/page.tsx → ok=true  · 파일 사라짐(휴지통)      ← 정상
        app/posts/[id]/page.tsx  → ok=false
          err "pathspec 'app/posts/[id]/page.tsx' did not match any file(s) known to git"
          파일 그대로 · 인덱스 그대로 · 몇 번을 눌러도 같다             ← 영구 실패
        남은 status: ["A  app/posts/[id]/page.tsx"]
```

### 4.2 왜 — `git show <rev>:<대괄호 경로>`는 **실패를 성공으로 답한다**

`discard`는 `checkout HEAD --`가 실패하면 「HEAD에 없는 새 파일인가」를 `show_at()`에 묻고,
`Blob::Absent`일 때만 휴지통 + `rm --cached`로 간다. 그 `show_at`이 만드는 것은 pathspec이
아니라 `HEAD:<rel>`이라 `:(literal)`을 못 붙이는데, **git이 그 인자를 글롭 pathspec으로
재해석해 exit 0을 준다**:

```
git show 'HEAD:app/[id]/new.tsx'          → exit 0 · stdout 0바이트     (HEAD에 없는데도)
git show 'HEAD:app/[zz]/nope.tsx'         → exit 0 · stdout 0바이트     (아예 없는 경로)
git show 'HEAD:app/i/new.tsx'             → exit 128 "path … exists on disk, but not in 'HEAD'"
git cat-file -e 'HEAD:app/[id]/new.tsx'   → exit 128 (같은 질문에 바르게 답한다)
```

`r.ok`가 참이니 `show_at`은 `Blob::Text("")`를 돌린다 → `matches!(…, Blob::Absent)`가 거짓 →
`discard`는 아무것도 안 하고 checkout의 오류 줄을 그대로 뱉는다. **HEAD에 없다는 사실이
「HEAD에 빈 파일이 있다」로 뒤바뀐 것**이고, 그건 R1 크리틱 §S5가 `Blob`을 넷으로 쪼갠 이유
바로 그 병(「없다」와 「못 읽었다」를 안 가르면 거짓말이 나간다)의 세 번째 얼굴이다.

### 4.3 이 라운드의 책임 — 회귀는 아니지만, **이 라운드가 닫았다고 적은 계약이다**

- 회귀 아님: 접두 전에도 `checkout HEAD -- app/[id]/new.tsx`는 실패했고 같은 자리로 떨어졌다.
  (다만 이웃이 HEAD에 있으면 옛 코드는 **이웃을 되돌리고 ok=true**를 줬다 — 지금이 더 안전하다.)
- 그러나 `fe18f76`은 `discard` 본문 **두 줄**(`git.rs:1454` checkout · `:1466` rm --cached)을
  고치면서 **그 사이 `:1460`**의 `show_at(&root, "HEAD", rel)`을 지나쳤다. 여섯 줄 간격이다.
- 그리고 보고서 §7.6이 **「이 크레이트가 git에 넘기는 모든 경로의 규약」**이라고 못 박았다.
  실측으로 거짓이다. 다음 감사가 그 문장을 믿으면 이 자리를 안 본다.
- 커밋 메시지의 「쓰는 곳은 다섯」도 **여섯 번째가 있다**는 사실을 안 적었다.

### 4.4 파장(측정한 것만)

| 자리 | 대괄호 경로에서 | 평범한 경로 |
|---|---|---|
| `discard` (`A` 스테이징된 새 파일) | **ok=false · 아무 일도 안 남 · raw 영어 문구** | 정상 |
| `discard` (미추적 `??`) | 정상(휴지통 — `untracked=true`라 `show_at`을 안 지난다) | 정상 |
| `discard` (수정·삭제된 추적 파일) | 정상(`checkout`이 성공해 `show_at`까지 안 간다) | 정상 |
| `file_diff` 새 파일 | tag `"new"` — **영향 없음** (`build_file_diff`가 「없음」과 「빈 문자열」을 한 갈래로 다룬다) | 동일 |
| `commit_file_diff` 도입 커밋 | tag `"new"` — 영향 없음 | 동일 |
| 삭제 파일 `head_content` | 43바이트 정상(HEAD에 있으니 `show`가 제대로 푼다) | 동일 |

즉 **데이터가 사라지진 않는다.** 대신 되돌리기라는 기능 하나가 특정 이름 모양에서 조용히
죽는다 — 그리고 그 이름 모양은 이 라운드가 「사용자의 두 번째 프로젝트가 Next.js다」라고
스스로 근거로 든 바로 그 인구(`[id]`·`[slug]`·`[...slug]`)다.

`A` 상태가 실제로 생기는가: `commit()`은 훅 거부 시 되돌리지만, 터미널이나 에이전트가
`git add`를 하면 그대로 남는다(이 레포에서 매일 일어나는 일이다). `status`는 그 행을
`status="A", untracked=None`으로 주고 `GitModal.tsx:358`이 `!!f.untracked`=false로 부른다 —
경로가 확인된다.

### 4.5 재현(그대로 붙여 쓰면 된다)

```bash
git init -q -b main repo && cd repo && git config user.name C && git config user.email c@x.invalid
printf 's\n' > seed.txt && git add seed.txt && git commit -qm init
mkdir -p "app/posts/[id]" "app/posts/plain"
printf 'new\n' > "app/posts/[id]/page.tsx"; printf 'new\n' > "app/posts/plain/page.tsx"
git add -A
# 여기서 Git 카드의 되돌리기 = ccg_fs::git::discard(cwd, rel, false)
#   plain → ok / [id] → "pathspec … did not match any file(s) known to git"
git show 'HEAD:app/posts/[id]/page.tsx'; echo "exit=$?"   # → exit 0, 출력 0바이트  ★ 여기가 원인
```

### 4.6 고치는 법 (한 줄짜리 후보 — 판단은 빌더 몫)

`show_at`의 성공 판정을 `git show`에 맡기지 말 것. `git cat-file`은 같은 질문에 바르게
답한다(위 실측). 예: `show` 전에 `cat-file -e <rev>:<rel>`로 존재를 먼저 가르거나
(`discard`는 이미 실패 갈래에서 `cat-file -e`를 부르고 있다 — 순서만 바꾸면 스폰이 안 는다),
`git show`를 `git cat-file blob`으로 바꾸는 것. 어느 쪽이든 `rev:path`에는 `:(literal)`을
못 쓰므로 **「접두 규약」 문장으로는 못 막는 자리**라는 사실이 §7.6에 같이 적혀야 한다.

---

## 5. 그 밖에 남은 것

- **G2(반복). 「2,000파일 커밋 760ms」가 장부의 유일한 수다.** R3 크리틱이 cold 9.1~9.4초를
  보고했는데 §1.4는 여전히 `831ms`, §4는 `760ms`뿐이다. 내 실측은 **16.0~16.7초**이고 그중
  래퍼 몫은 0이다(§2-①). 사용자는 그동안 Git 카드가 멎은 것을 본다 — 진행 표시도 없다.
  「최초 대량 커밋은 십수 초가 걸릴 수 있다(=git 몫)」가 한 줄 들어가야 한다.
- **문서 오기.** §1.5가 「`:(literal)` … **쓰는 곳은 넷**」이라고 쓰고 바로 아래 표에 **다섯 행**을
  적는다(커밋 메시지는 「다섯」으로 맞다). §4.3의 여섯 번째까지 세면 표 자체가 다시 틀린다.
- **대소문자는 접두 탓이 아니다(확인 후 기각).** 디스크가 `Src/File.ts`인데 `src/file.ts`로
  고르면 커밋이 「바뀐 내용이 없어요」로 떨어진다. 접두 때문인가 싶어 raw git으로 갈라 봤더니
  `core.ignorecase=true`에서도 **접두 없는 pathspec이 똑같이 0행**이었다 — git pathspec 매칭
  자체가 대소문자를 가리는 것이지 `:(literal)`이 만든 성질이 아니다. 파리티 영향 없음.
- 미이행으로 남은 것(빌더도 인정): **실앱(정식 빌드) 실측**. 이번 라운드도 크레이트/하네스
  수준에서만 쟀다. 옆 갈래 미커밋 Rust는 이제 전부 커밋됐으니(§1) 다음 라운드는 exe를
  세워 Git 카드에서 직접 눌러 볼 수 있다.

## 6. 위생

- 이름 기반 kill **0회**. 사용자 실앱 5프로세스 그대로.
- 격리 `CARGO_TARGET_DIR` · `CCG_HOME` · 태그 `gitcrit4` · 포트 9911 — 다른 갈래와 안 겹친다.
- 스크래치 전부 삭제 확인: `bench/shots/electron-gitcrit4/` 없음 ·
  `%TEMP%/ccg-screens-electron-gitcrit4` 없음.
- 이 판정문 외에 레포 파일을 한 글자도 안 고쳤다(`git status`로 확인).

## 7. 판정

| 항목 | 결과 |
|---|---|
| 1. 2,000파일 커밋(긴 경로·argv >32K) | **통과**(기능) — 3스폰·2001추적·메시지 무손실 / 시간 16.0~16.7초 |
| 2. 유니코드·공백 커밋 · 훅 거부 롤백 | **통과** — 남의 스테이징 무접촉·접두 누출 0 |
| 3. AI diff 수집 스폰 1~2회 + 캡 | **통과** — n=1~900 전부 2스폰·답 일치·캡 둘 다 말하고 접힘 |
| 4. ccg-fs 무후퇴 + typecheck 3종 | **통과** — 96/0/2 · 143/0 · 경고 0 · 3종 exit 0 |
| 5. report 19행·자기모순·경고·viewport | **통과** — 19/18/94.7% 일치 · PNG 18·18 · 경고 둘 실유발 |
| **계약 「모든 경로에 `:(literal)`」** | **실패** — `discard`의 `show_at`이 규약 밖. `A` 대괄호 파일 되돌리기가 죽는다 |

**pass=false.** 다섯 항목이 초록인데 불합격을 내는 이유는 R3 때와 같다 — 이 라운드가
**스스로 세운 계약**이 실측으로 깨지고, 깨진 자리가 하필 이 라운드가 고친 함수 안이기 때문이다.
