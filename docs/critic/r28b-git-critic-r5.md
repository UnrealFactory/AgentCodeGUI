# R28b GIT 확인 크리틱 — 여섯 번째 자리는 진짜로 막혔다. 같은 함수 여섯 줄 **위**가 안 막혔다

라운드: R28b GIT 확인 크리틱(라운드 3 · 새 컨텍스트 · 전면 재실측) · 2026-08-25 · `feature/3.0.0-beta`
판정 대상: `1a4ae14` (`crates/ccg-fs/src/git.rs` · `docs/parity-fix-git-r1.md` — 2파일)

**판정: 불합격(pass=false).**

숙제 체크리스트 5항목은 **전부 실측 통과**했다. R4 크리틱이 죽여 놓은 대괄호 되돌리기도
**진짜로 살아났다** — 크레이트에서도, 이번 라운드가 처음 세운 **실앱(Tauri exe)에서도**
(`discard('app/posts/[id]/page.tsx')` ok · 170ms · 이웃 무사). 빌더가 남긴 리스크 #1
「실앱 실측이 없다」는 이 판정문이 닫았다.

그런데 **같은 함수 안에, 고친 줄에서 여섯 줄 위**에 같은 병의 일곱 번째 얼굴이 있다.

```rust
fn show_at(root: &Path, rev: &str, rel: &str) -> Blob {
    let spec = format!("{rev}:{rel}");
    if rel.starts_with('-') { return Blob::Absent; }   // ← git.rs:700. 여기.
    let exists = || exec(root, &["cat-file", "-e", spec.as_str()]).ok;   // R3가 고친 줄
```

`git`에게 **묻지도 않고** 「그 리비전에 없다」고 답한다. 그래서 이름이 `-`로 시작하는
**최상위 폴더 하나가 그 아래 전부를 오염시킨다**(`-old/` · `-archive/` · `-notes.txt`):
뷰어가 추적 중인 파일을 통째로 초록 새 파일로 그리고, 되돌리기는 **HEAD에 있는 파일을
휴지통에 넣고 「실패했다」고 말한다**(§S4가 고친 그 사고). 실앱에서도 재현했다.

막으려던 위험은 **애초에 없다.** `spec`은 `format!("{rev}:{rel}")`이고 `rev`는 `"HEAD"` ·
`valid_hash`를 통과한 해시 · `"<hash>^"`뿐이라 **`-`로 시작할 수가 없다.** raw git도 그렇게
답한다(§4).

---

## 0. 파일 이름에 관하여

숙제는 판정문을 `docs/critic/r28b-git-critic-r3.md`로 쓰라고 했다. **그 파일은 이미 커밋돼
있다**(`b369599`). 같은 갈래의 `r1`(`43a1b36`) · `r2`(`f8a8ed8`) · `r4`(`7d025cf`)도 있다.
덮어쓰면 커밋된 판정문이 지워지고 「r3가 r4보다 최신인 장부」라는 자기모순이 남는다.
그래서 순번을 이어 **r5**로 쓴다(R3 크리틱이 r3를, R4 크리틱이 r4를 고른 것과 같은 이유).
앞선 네 판정문은 한 글자도 안 건드렸다.

## 1. 실측 방법 — 빌더의 테스트도, 빌더의 하네스도 근거로 쓰지 않았다

세 층에서 따로 쟀다.

1. **레포 밖 독립 하네스**(`%TEMP%/ccg-gitcrit5`) — `ccg-fs`를 path 의존으로 무는 릴리스
   바이너리 5개(`gitcrit5` · `probe2`~`probe5`). `commit`/`discard`/`file_diff`/
   `bulk_file_diffs`/`commit_file_diff`/`status`/`spawn_count`를 **공개 API로 직접** 불렀다.
2. **실앱(Tauri exe)** — `--features custom-protocol`로 격리 `CARGO_TARGET_DIR`에 릴리스
   빌드(2m 17s), 격리 `CCG_HOME`으로 띄우고 CDP로 `window.api.git.*`를 직접 불렀다.
   **이 층은 이 갈래에서 처음이다.**
3. **raw git** — 우리 코드가 하는 말이 맞는지 매번 음성 대조.

- 격리: `CARGO_TARGET_DIR` = `%TEMP%/ccg-gitcrit5-target`(하네스) · `-wtarget`(크레이트
  테스트) · `-apptarget`(Tauri 릴리스). `CCG_HOME` = `%TEMP%/ccg-gitcrit5-home` · `-apphome`.
  CDP 포트 **9931**(electron) · **9932**(tauri). A/B 태그 `electron-gitcrit5`(측정 후 삭제).
- **이름 기반 kill 0회.** 사용자 실앱(`AgentCodeGUI.exe` 5프로세스, pid 6644 · 12924 ·
  23792 · 24836 · 26924)은 측정 전후 그대로다. 내가 띄운 것은 ab.mjs가 스폰한
  `electron.exe` 2회와 내 tauri exe 1회(pid 25260)뿐이고 전부 자기 PID로 걷었다.
- 기준 결과 파일 무접촉: `bench/shots/{tauri,electron}{,-m12r2}/report.json` ·
  `bench/results/*` · `docs/critic/*.json`은 **읽기만** 했다. 경고 유발은 새 태그
  `bench/shots/electron-gitcrit5/`에서 하고 측정 뒤 삭제(잔여 0 확인).
- git 2.53.0.windows.1 · cargo 1.96.1 · node v24.13.1.
- 측정 중 옆 갈래가 커밋했다(`5e1dae7` ACCT). 워킹트리에 내 변경은 0이다(`git diff HEAD` 빈).

---

## 2. 체크리스트 5항목 — 전부 실측 통과

### ① 2,000파일 커밋 — 통과. 시간은 장부의 정정판과 일치

**깊은 판**(6단 중첩 · 한글 · 공백 · 대괄호 · 파일마다 다른 내용):

```
argv 바이트 합계 207,296 = 한계 32,767의 6.3배
[옛길] argv add (2.6.2 src/main/git.ts:358과 같은 모양)
        → 스폰 실패  os error 206 "파일 이름이나 확장명이 너무 깁니다"
[새길] ccg_fs::git::commit → ok=true · git 스폰 3회 · 31,927ms
        추적 2001(seed + 2000) · 안 고른 NOT-PICKED.txt는 `??` 그대로
        show --stat → "2000 files changed, 4000 insertions(+)"
```

**얕은 판**(40폴더 · 2단 · 같은 내용, argv 50,390B): ok · 3스폰 · **697ms**.
장부(§1.4)의 690/781ms와 일치한다.

**실앱**(같은 2,000파일, Tauri exe · CDP 왕복 포함): `ok=true` · **33,158ms** · 추적 2004.
크레이트 수와 오차 안에서 같다 — **IPC·직렬화 몫이 아니라 git 몫**이라는 장부의 말이 맞다.

### ② 유니코드·공백 커밋 + 훅 거부 롤백 — 통과

```
고른 것 3개: "한글 폴더/공백 있는 이름.txt" · "emoji 🚀 dir/파일 (1).md" · "app/posts/[id]/page.tsx"
  → ok=true · 3스폰 · 164ms · 셋 다 추적 · 이웃 app/posts/i/는 `??` 그대로
훅 거부(pre-commit exit 1, stderr 있음)
  → ok=false · err="훅이 거부했다"
     status 훅 전/후 **바이트 동일** · `diff --cached --name-only` 빈 목록
이웃을 **미리 스테이징해 둔** 판에서 훅 거부
  → 훅 전 ["app/posts/i/page.tsx"] / 훅 후 ["app/posts/i/page.tsx"]  ← 롤백이 고른 것만 내린다
```

부수 관찰(격차 아님): 훅이 **아무 말 없이** `exit 1`이면 err이 「알 수 없는 오류」가 된다.
git 자신도 그때 아무 말을 안 해서라 폴백은 설계대로지만, 사용자에게는 사유가 없는 문장이다.

### ③ AI 메시지 diff 수집 — 통과

```
301파일 · 스폰 2회 · 133ms · 오류행 0 · add 합 301(정확)
파일별 캡(64KB): 200KB 파일 → body_dropped=File · add=200 del=1 정확 · 담긴 줄 0
                 옆 파일 s1은 dropped=None · 줄 2개 그대로
총량 캡(4MB):   63KB × 120파일 = 7.5MB → Batch 드랍 54행
                 들고 있는 본문 4,165,722B ≤ 예산 4,194,304 · add 합 7,560(정확)
```

소비자 쪽(`aimsg.rs::build_diff_text`)은 `File`/`Batch`를 각각 「본문 생략(파일이 너무 큼)」·
「본문 생략(수집 예산)」 문장으로 옮긴다 — 소스와 단위 테스트
(`a_body_dropped_by_the_collector_never_leaves_a_bare_header`, ④에서 통과) 양쪽으로 확인.
R2 크리틱이 잡은 「맨 헤더」는 재현되지 않는다.

### ④ 테스트 무후퇴 + 타입 3종 — 통과

```
cargo test -p ccg-fs        98 통과 · 0 실패 · 2 ignored     (git.rs #[test] 46 → 48)
  ignored 2개 직접 실행     2 통과 · 49.02s
     [측정] 400파일 캡 초과: 2,532ms · 9스폰
     [측정] 900파일 — 옛길 47,776ms/1,800스폰 · 새길 214ms/2스폰
cargo test -p agentcodegui  143 통과 · 0 실패 · 0 ignored
npm run typecheck (node·web) exit 0 · npm run typecheck:app exit 0
node --check bench/ab.mjs    통과
```

### ⑤ A/B 19행 · 자기모순 없음 · 경고와 viewport 실동작 — 통과

| | tauri-m12r2 | electron-m12r2 |
|---|---|---|
| 리포트 행 | 19 | 19 |
| summary | 19 / 18 / 1 / 94.7% | 동일 |
| 행 재계산 | 19 / 18 / 1 / 94.7% — **일치** | 동일 |
| 디스크 PNG | 18 | 18 |
| ok인데 PNG 없는 행 · 리포트에 없는 PNG | 0 · 0 | 0 · 0 |
| 행별 `viewport` | 19/19 | 19/19 |
| `viewport` ≠ `png` | 0 | 0 |
| 실패 행 | `settings-engine-confirm` | 동일 |

**경고 둘은 실주행으로 유발했다**(태그 `gitcrit5` · 포트 9931 · 격리 홈 · 19행을 심고 단건 재주행):

```
① --only=settings-display (--merge 없음)
   [ab] 경고 — 이전 리포트 19행을 1행으로 덮어쓴다. 단건 재주행이면 --merge를 붙여라
   남은 행: {"id":"settings-display","ok":true,"png":[1320,880],"viewport":[1320,880]}
② --only=settings-display,no-such-screen --merge
   [ab] 경고 — --only 2개인데 이번 판이 남긴 건 1행 — 도달 못 한 화면이 통째로 빠졌다
```

**보고서 §7.5의 오기 하나**(격차 아님, 장부 정정): 최종 파리티 세트의 공통 PNG는 114장,
크기가 다른 것은 toast 둘 — **여기까지는 맞다**. 그러나 「나머지 112장 두 앱 모두
1320×880」은 틀렸다. 실측 분포는 `1320×880` **110장** + `1100×820` 1장 + `560×720` 1장이다
(뒤 둘은 별도 창이고 **두 앱이 같은 크기**라 결론 「픽셀 비교에 쓸 수 있다」는 그대로 선다).

---

## 3. R3 수정 자체 — 진짜로 됐다 (raw git 음성 대조 + 실앱)

```
[raw]  git show     'HEAD:app/posts/[id]/page.tsx' → ok=true  · 0바이트     ← git은 여전히 거짓말
       git cat-file -e 같은 경로                    → ok=false             ← 오라클은 바르다
       glob이 실제로 **맞는** 판(HEAD에 app/posts/i/page.tsx 있음)에서도 show는 0바이트
       비-최초 커밋에서도 0바이트 · 'HEAD:app/posts/*'도 0바이트
       → 「재해석은 항상 0바이트」를 세 판에서 재현했다
[크레이트] status ["A app/posts/[id]/… untracked=None", "A …/i/…", "A …/plain/…"]
       discard [id]   → ok=true · err=None · 5스폰 · 파일 사라짐
       discard plain  → ok=true ·            5스폰 · 파일 사라짐   ← 스폰 증가 0 확인
       남은 인덱스 ["app/posts/i/page.tsx","seed.txt"]
       이웃 i 내용 "이웃의 저장 안 한 편집\n"  ← 한 글자도 안 움직였다
[실앱] discard('app/posts/[id]/page.tsx') → {"ok":true,"ms":170}
       파일 사라짐 · 이웃 i 내용 그대로 · posts 인덱스 ["…/i/page.tsx","…/plain/page.tsx"]
```

**과잉 발동 없음**(되묻기가 빈 파일을 뒤집으면 §S4가 되살아난다):

```
HEAD의 빈 파일 "빈.txt" · "app/[id]/빈.tsx"
  지우면  file_diff error=None · diff 있음 · head_content=Some("")
  discard ok=true · 파일 복원됨(휴지통 안 감)
되묻기 비용: 빈 blob file_diff 3스폰 대 보통 파일 2스폰   ← 문서가 적은 그대로
```

**대괄호가 안 건드리는 자리도 그대로**: `file_diff` 새 파일 tag `"new"`(대괄호·평범 둘 다) ·
`commit_file_diff` 도입 커밋 tag `"new"` · 다음 커밋 tag `"edit"` · 폴더 행 discard ok.

---

## 4. ★ 최대 격차 — `show_at`의 `-` 가드가 git에게 묻지 않고 「없다」고 답한다

### 4.1 그 가드가 막으려는 위험은 없다

```rust
let spec = format!("{rev}:{rel}");
// `--` 뒤로 밀 수 없는 형태(rev:path)라, rev/rel이 옵션처럼 보이지 않게 미리 막는다.
if rel.starts_with('-') { return Blob::Absent; }
```

`spec`은 `rev` **뒤에** `rel`을 붙인 문자열이다. `rev`는 이 크레이트 안에서 `"HEAD"` ·
`valid_hash()`를 통과한 16진 해시 · `"{hash}^"` 셋뿐이다 — **`spec`이 `-`로 시작할 방법이
없다.** raw git도 그렇게 답한다:

```
git show     'HEAD:-notes.txt'  → ok=true · 30바이트   ← 아무 문제 없이 받는다
git cat-file -e 'HEAD:-notes.txt' → ok=true
```

즉 이 줄은 **없는 위험을 막으면서 진짜 거짓말을 만든다.**

### 4.2 무엇이 죽나 — 뷰어가 추적 파일을 통째로 새 파일로 그린다

`-notes.txt`는 HEAD에 2줄로 커밋돼 있고 워킹트리에서 한 줄로 고쳤다.

```
[크레이트]
file_diff        -notes.txt   tag="new"  add=3 del=0   ← 전체가 초록 새 파일
file_diff    app/-inner.txt   tag="edit" add=1 del=1   ← 첫 조각이 아니면 정상(가드가 rel 전체만 본다)
file_diff            보통.txt  tag="edit" add=1 del=1   ← 대조군
bulk_file_diffs  -notes.txt   tag="edit" add=1 del=1   ← 대량 경로는 정답 = 같은 파일에 두 답이 있다
commit_file_diff -notes.txt   tag="new"  add=0 content=""   (그 커밋에 30바이트가 있다)
commit_file_diff     보통.txt  tag="new"  add=2 content=29B  ← 대조군
```

**최상위 폴더 하나가 그 아래 전부를 오염시킨다** — 파일 하나짜리 사고가 아니다:

```
-old/노트.txt        tag="new"  add=3 del=0
-archive/a/b.txt     tag="new"  add=3 del=0
보통/노트.txt         tag="edit" add=1 del=1
```

**실앱에서도 그대로다:**

```
window.api.git.fileDiff(repo,'-notes.txt') → {"tag":"new","add":1,"del":0}
window.api.git.fileDiff(repo,'seed.txt')   → {"tag":"edit"}
```

`status`는 그 행을 `M -notes.txt` · `M -old/노트.txt`로 정확히 준다. UI 경로가 실제로 여기 닿는다.

### 4.3 더 나쁜 쪽 — §S4 사고(휴지통)가 되살아난다

`discard`는 `Blob::Absent`를 「HEAD에 없던 새 파일」로 읽고 **휴지통에 넣는다**.
`.git/index.lock`을 놔둬(=다른 git 프로세스가 도는 흔한 상황) checkout만 실패시키면:

```
discard(보통/노트.txt) ok=false err="Unable to create '…/.git/index.lock': File exists."
                        파일 남아있나=true    ← 계약대로. 아무것도 안 지웠다
discard(-old/노트.txt) ok=false err=(같은 문구)
                        파일 남아있나=false   ← **휴지통으로 갔다**
```

같은 클릭, 같은 오류 문구, 한쪽만 파일이 사라진다. **사용자에게는 「실패했다」고 말해 놓고
HEAD에 있는 파일을 지운 것**이다. 잠금(공유 위반)으로 실패시킨 판에서는 휴지통도 같이 막혀
`ok=false`로 끝났지만(인덱스 무사), 그건 운이 좋았을 뿐이고 index.lock 판에서는 실제로 지워진다.

`discard` 문서가 자기 손으로 적은 문장이 이것이다:

> 그리고 checkout 실패를 무조건 "HEAD에 없던 새 파일"로 읽지 않는다 — HEAD에 **있는데**
> 잠겨서 실패한 파일까지 휴지통으로 보내던 자리다(§S4의 진짜 뿌리).

### 4.4 왜 이번 라운드의 격차인가

- 자리가 **같은 함수**다. R3이 고친 줄(`:704`)의 **바로 위 네 줄**(`:700`)이고, R3이 이번에
  새로 쓴 `show_at` 문서(`:671`~`:698`)가 그 가드를 지나 내려온다.
- 병이 **같다**. R1 크리틱이 `Blob`을 넷으로 쪼갠 이유가 「없다」와 「못 읽었다」를 안 가르면
  거짓말이 나간다는 것이고, R3 커밋 메시지는 자기가 고친 것을 「그 세 번째 얼굴」이라고 적었다.
  이건 **네 번째 얼굴**이다 — 이번엔 「못 읽었다」도 아니고 **「묻지 않았다」를 「없다」로** 답한다.
- 계약이 **또 깨진다**. §7.6이 새로 못 박은 문장은 「물을 것은 접두를 붙였나가 아니라 이 인자가
  pathspec인가 오브젝트 이름인가」다. 그 물음을 지나도 이 줄은 안 걸린다 — 물어야 할 것이
  하나 더 있다: **「git에게 물어보고 답했나」**.
- 회귀는 아니다(`48d4622` M6 R1부터 있었다). R4가 이 라운드를 불합격시킨 근거와 정확히 같은
  성격이다 — 회귀가 아니어도 **이 라운드가 「닫았다」고 적은 자리**다.

### 4.5 고치는 법(참고 — 이 판정문은 코드를 안 고친다)

가드를 지우면 된다. `spec`이 `-`로 시작할 수 없다는 것이 이미 타입/호출부로 보장돼 있다.
정 남기고 싶으면 **`Absent`를 돌리지 말고** `exists()`로 되물어 `Absent`/`Unreadable`을 갈라야
한다 — 「모르면 없다고 하지 않는다」가 `Blob`이 넷인 이유다. 그물은 두 줄이면 선다:
`-old/노트.txt`를 커밋해 두고 ① `file_diff`가 `tag=="edit"`인지 ② `index.lock`을 놔둔 채
`discard`가 파일을 남기는지.

---

## 5. 그 밖에 본 것 (격차 아님 · 기록)

- **33초 대량 커밋 동안 앱은 안 죽는다.** `ipc/git.rs::owns()`가 이 채널들을 블로킹 스레드로
  빼서, 커밋 직후 다른 IPC 왕복이 **83ms**로 답했다. `GitModal`의 `run()`은 `busy='commit'`으로
  스피너를 돌리고 버튼을 잠근다 — 보고서 §7.8의 「아무 말도 안 한다」는 조금 세다(스피너는
  있다). 없는 것은 **진행률·남은 시간·취소**다. 33초를 스피너만 보고 기다리는 것은 그대로다.
- `file_diff`에 **디렉터리** 경로를 주면 `git show HEAD:<dir>`의 트리 목록(`tree HEAD:app/i` …)을
  본문으로 읽어 `("edit", 0, 3)`을 돌린다. `status`가 추적 디렉터리 행을 만들지 않아 제품
  도달은 없다(미추적 폴더 행은 `Absent`로 떨어져 「내용을 읽을 수 없어요」가 된다). 이번
  라운드가 만든 것은 아니다.
- Windows에서는 `*`가 든 경로를 인덱스에 넣는 것 자체가 막힌다(`error: Invalid path`). 매직
  문자 인구가 `[ ]`뿐이라는 §1.5의 판단은 맞다.

---

## 6. 판정표

| 항목 | 결과 |
|---|---|
| 1. 2,000파일 커밋(argv 6.3배) | **통과** — 옛길 os error 206 · 새길 3스폰 31.9s(크레이트)/33.2s(실앱) · 고른 것만 |
| 2. 유니코드·공백 · 훅 거부 롤백 | **통과** — status 바이트 동일 · 스테이징 0 · 이웃의 기존 스테이징 보존 |
| 3. AI diff 수집 스폰·캡 | **통과** — 301파일 2스폰 133ms · File/Batch 드랍 정확 · 4,165,722 ≤ 4,194,304 |
| 4. ccg-fs 테스트 · 타입 3종 | **통과** — 98/0/2(+ignored 2 통과) · agentcodegui 143/0/0 · typecheck 3종 exit 0 |
| 5. report 19행 · 경고 · viewport | **통과** — 19/18/94.7% 일치 · PNG 18·18 · viewport 19/19 · 경고 둘 실유발 |
| R3 수정(대괄호 되돌리기) | **통과** — 크레이트·**실앱** 양쪽 · 스폰 증가 0 · 과잉 발동 없음 |
| **`show_at`의 `-` 가드** | **불합격** — 묻지 않고 「없다」 · 뷰어 거짓말 + 휴지통 데이터 유실(실앱 재현) |

**다음 라운드에 넘길 것 하나**: `crates/ccg-fs/src/git.rs:700`의
`if rel.starts_with('-') { return Blob::Absent; }`를 없애거나 `exists()`로 되묻게 고치고,
`-old/노트.txt` 그물 두 줄(`file_diff`가 `"edit"`인지 · `index.lock` 아래 `discard`가 파일을
남기는지)을 박을 것.
