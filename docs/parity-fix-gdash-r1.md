# 후속 GDASH R1 — 「묻지 않았다」를 「없다」로 답하던 한 줄

라운드: R28c 후속 GDASH R1 · 2026-08-25 · `feature/3.0.0-beta`
근거 문서: `docs/critic/r28b-git-critic-r5.md` §4(최대 격차 · 「다음 라운드에 넘길 것 하나」)
경계: `crates/ccg-fs/src/git.rs`(+테스트) · `scripts/poc-dash-path.mjs`(새 하네스) · 이 문서
커밋: `4c5feb4`(수정 + 그물 2 + 하네스) · 이 문서

> 이 라운드는 **한 줄을 지운다.** 그 한 줄이 세 화면(뷰어 diff · 커밋 시점 보기 ·
> 되돌리기)에서 동시에 거짓말을 하고 있었고, 그중 하나는 **데이터를 지웠다.**

## 0. 한 문단

`show_at`에 `if rel.starts_with('-') { return Blob::Absent; }` 한 줄이 있었다. 옵션 주입을
막는다는 뜻이었는데, **막으려던 위험이 애초에 없었다** — git에 나가는 인자는 `rel`이 아니라
`spec = format!("{rev}:{rel}")`이고 `rev`는 `"HEAD"` · `valid_hash()`를 통과한 16진 해시 ·
`"{hash}^"` 셋뿐이라 `spec`이 `-`로 시작할 방법이 없다. 대신 그 줄은 **git에게 묻지도 않고
「그 리비전에 없다」고 답했다.** 그래서 이름이 `-`로 시작하는 최상위 파일·폴더 하나가 그
아래 전부를 오염시켰다: 뷰어는 추적 중인 파일을 통째로 초록 새 파일로 그렸고(`bulk` 경로와
**같은 파일에 서로 다른 답**), `commit_file_diff`는 내용 있는 파일을 빈 파일로 줬으며,
무엇보다 **되돌리기가 「실패했다」고 말하면서 HEAD에 있는 파일을 휴지통에 넣었다.**
가드를 지우고(진짜 불변식인 `spec` 쪽에만 남기고) 그물 두 개를 박았다. 크레이트와
**실앱(Tauri exe)** 양쪽에서 재현→수정을 실측했다.

---

## 1. 무엇이 틀렸나

### 1.1 그 줄

```rust
fn show_at(root: &Path, rev: &str, rel: &str) -> Blob {
    let spec = format!("{rev}:{rel}");
    // `--` 뒤로 밀 수 없는 형태(rev:path)라, rev/rel이 옵션처럼 보이지 않게 미리 막는다.
    if rel.starts_with('-') {          // ← git.rs:700 (수정 전)
        return Blob::Absent;
    }
    let exists = || exec(root, &["cat-file", "-e", spec.as_str()]).ok;
    …
```

주석이 `rev/rel`을 말하는데 코드는 `rel`만 본다. 그리고 정작 git에 나가는 것은 둘을 붙인
`spec`이다. 세 문장이 서로 다른 것을 가리키고 있었다.

`Blob`이 넷(`Text`/`Absent`/`TooBig`/`Unreadable`)인 이유는 R1 크리틱이 못 박은 한 문장이다 —
**「없다」와 「못 읽었다」를 안 가르면 거짓말이 나간다.** 이 줄은 그 병의 일곱 번째 얼굴이고,
이번엔 「못 읽었다」도 아니고 **「묻지 않았다」를 「없다」로** 답했다.

### 1.2 막으려던 위험은 없다 — raw git 음성 대조

`git 2.53.0.windows.1`, 격리 픽스처(`%TEMP%/ccg-gdash-raw`, 사용자 레포 무접촉):

```
git ls-files                                  -archive/a/b.txt · -notes.txt · -old/노트.txt · plain/노트.txt · seed.txt
git show     'HEAD:-notes.txt'      → exit 0 · "a\nb\n"        ← 아무 문제 없이 받는다
git cat-file -e 'HEAD:-notes.txt'   → exit 0
git show     'HEAD:-old/노트.txt'    → exit 0 · "x\ny\n"
git cat-file -e 'HEAD:-old/노트.txt' → exit 0
git show     'HEAD:-no-such.txt'    → exit 128 "path '-no-such.txt' does not exist in 'HEAD'"
git cat-file -e 'HEAD:-no-such.txt' → exit 128
```

`rev:path`는 `rev`가 먼저라 **문자열 자체가 `-`로 시작하지 않는다.** git은 그걸 옵션으로
읽을 이유가 없고, 실제로 안 읽는다. 없는 파일은 `show`·`cat-file` 둘 다 정직하게 128을 준다
(대괄호 글롭 재해석과 달리 **0바이트 거짓말이 없다** — `-`는 pathspec 매직이 아니다).

### 1.3 무엇이 죽었나 — 크레이트 실측(수정 전)

`cargo test -p ccg-fs`에 이번 라운드가 새로 박은 그물 둘을 **가드가 살아 있는 상태로** 먼저
돌렸다. 둘 다 정확히 사고 지점에서 터졌다:

```
test git::tests::a_dash_leading_path_is_asked_about_instead_of_declared_missing ... FAILED
  panicked at git.rs:2294: -notes.txt: 추적 중인 파일을 「새 파일」로 그렸다
    left: "new"  right: "edit"

test git::tests::discarding_a_dash_leading_path_keeps_the_file_when_checkout_is_locked_out ... FAILED
  panicked at git.rs:2354: 「실패했다」고 말해 놓고 HEAD에 있는 `-` 파일을 휴지통에 넣었다
```

두 번째가 더 나쁜 쪽이다. `.git/index.lock`이 놓인 판(=다른 git 프로세스가 도는 흔한 상황)에서
`checkout`만 실패시키면, `discard`는 `show_at`이 준 `Absent`를 「HEAD에 없던 새 파일」로 읽고
휴지통 갈래를 연다. 같은 클릭·같은 오류 문구인데 **한쪽만 파일이 사라진다.**

```
discard(보통/노트.txt) ok=false err="Unable to create '…/.git/index.lock': File exists."  파일 남음
discard(-old/노트.txt) ok=false err=(같은 문구)                                          파일 사라짐
```

`discard`가 자기 문서에 적어 둔 문장이 바로 이것이었다 — *"checkout 실패를 무조건 「HEAD에
없던 새 파일」로 읽지 않는다 — HEAD에 **있는데** 잠겨서 실패한 파일까지 휴지통으로 보내던
자리다(§S4의 진짜 뿌리)."* 그 계약이 `-` 경로에서만 조용히 깨져 있었다.

---

## 2. 무엇을 고쳤나

`crates/ccg-fs/src/git.rs:720`

```rust
fn show_at(root: &Path, rev: &str, rel: &str) -> Blob {
    let spec = format!("{rev}:{rel}");
    if spec.starts_with('-') {
        return Blob::Unreadable;
    }
    …
```

두 가지가 바뀌었다.

1. **보는 대상이 `rel` → `spec`.** 진짜 불변식이 거기 있다. 지금 호출부(위 세 rev)로는 절대
   안 걸리는 죽은 가지고, 그 사실을 테스트가 직접 단언한다(`valid_hash("-eadbeef")`는 false ·
   세 rev 모양 전부 `format!("{rev}:-notes.txt")`가 `-`로 안 시작).
2. **돌려주는 값이 `Absent` → `Unreadable`.** 혹시 나중에 `rev`가 바깥에서 오게 되더라도
   「모르면 없다고 하지 않는다」를 지킨다. `Unreadable`은 diff를 「내용을 읽을 수 없어요」로
   접고, **`discard`의 휴지통 갈래를 열지 않는다** — 실패해도 데이터가 안 사라지는 쪽으로
   기운다.

크리틱이 제시한 「최소한 `exists()`로 되물어 `Absent`/`Unreadable`을 가르라」는 대안은 안
골랐다. 그 되묻기 자체가 같은 `spec`을 git에 넘기므로 가드는 아무것도 못 막으면서 스폰만
하나 늘고, 추적 중인 `-notes.txt`가 `Unreadable`이 되어 **뷰어는 여전히 diff를 못 그린다.**
가드를 지우는 쪽이 크리틱의 첫 번째 선택지고 실제로 더 정확하다.

`--end-of-options`(git ≥ 2.24)로 인자 해석을 원천 차단하는 길도 재 봤다 —
`git show --end-of-options 'HEAD:-notes.txt'` 통과 · `git show --end-of-options '--help'`는
`exit 128 "option '--help' must come before non-option arguments"`로 막힌다 · 대괄호 0바이트
재해석은 그대로. **안 넣었다.** 얻는 것이 이미 없는 위험에 대한 방어뿐인데, git < 2.24를 쓰는
사용자에게서 `file_diff`를 통째로 죽이는 새 실패 모드를 산다.

---

## 3. 그물 — 새 테스트 둘 (git.rs #[test] 48 → 50)

### 3.1 `a_dash_leading_path_is_asked_about_instead_of_declared_missing`

한 파일만 보면 우회가 다시 들어와도 「전부 new」로 자기들끼리 아귀가 맞아 통과한다. 그래서
**세 답을 마주 세운다.** 픽스처: `-notes.txt`(최상위 `-` 파일) · `-old/노트.txt` ·
`-archive/a/b.txt`(최상위 `-` 폴더 안쪽) + 대조군 `보통/노트.txt`.

| 확인 | 단언 |
|---|---|
| 픽스처 무결 | `ls-files -z`에 `-` 경로 셋이 **실제로 추적**돼 있다 |
| raw git 근거 | `git show HEAD:-notes.txt`가 exit 0 + 내용 — 가드가 막을 게 없다는 증거 |
| ① UI 도달 | `status`가 `-` 경로 행을 그대로 준다(여기 안 닿으면 나머지가 공허하다) |
| ② 두 길 일치 | `file_diff` = `bulk_file_diffs` — `tag`·`add`·`del` 셋 다. 넷 모두 `("edit",1,1)` |
| ②' 스폰 | `-` 경로와 평범한 경로의 `file_diff` 스폰 수가 같다 |
| ③ 커밋 시점 | `commit_file_diff`의 `content`가 `"원본\n둘째 줄\n"`, 도입 커밋 `("new", 2)` |
| ④ 삭제 행 | 지운 `-old/노트.txt`의 `head_content`가 HEAD 내용 그대로 |
| ⑤ 과잉 교정 금지 | HEAD에 **진짜로 없는** `-새 파일.txt`는 여전히 `Absent` · `tag="new"` |
| ⑥ 불변식 | `valid_hash("-eadbeef")`=false · 세 rev 모양 전부 `spec`이 `-`로 안 시작 |

⑤가 없으면 반대쪽으로 넘어간다 — `Absent`가 안 나오면 `discard`의 「새 파일」 갈래가 안 열려
스테이징된 새 파일의 되돌리기가 영구히 실패한다(R4 크리틱이 잡았던 그 사고).

### 3.2 `discarding_a_dash_leading_path_keeps_the_file_when_checkout_is_locked_out`

`.git/index.lock` 파일 하나로 잠금을 만든다(**프로세스를 안 띄운다**). 단언 뒤 즉시 지운다 —
남기면 `Drop` 청소와 뒤 테스트가 같이 이상해진다.

```
잠긴 판:  discard(보통/노트.txt)  ok=false · 파일 남음   ← 계약대로(대조군)
          discard(-old/노트.txt)  ok=false · 파일 남음   ← 고친 것
풀린 뒤:  둘 다 ok=true · 내용이 "원본\n"으로 되돌아감   ← 되돌리기를 죽이지 않았다는 대조
```

---

## 4. 실측 — 수정 뒤

### 4.1 크레이트

```
cargo test -p ccg-fs        100 통과 · 0 실패 · 2 ignored      (크리틱 R5 기준 98 → +2)
cargo test -p agentcodegui  145 통과 · 0 실패 · 0 ignored      (무후퇴 — 145는 옆 갈래가 +2 한 뒤 값)
cargo clippy -p ccg-fs --all-targets   ccg-fs 경고 1건(기존 SPAWNS thread_local) — 새 경고 0
npm run typecheck (node·web) exit 0 · npm run typecheck:app exit 0
```

스폰 비용(테스트가 직접 찍는 값):

```
[측정] file_diff 스폰 — `-` 경로 2회 · 평범한 경로 2회
```

수정 전 `-` 경로는 **1회**였다. 가드가 git을 안 부르고 답했기 때문이다 — 줄어든 그 한 번이
바로 거짓말의 값이었다. 이제 `-` 경로는 평범한 경로와 **정확히 같은 값을 치른다**(늘지도
않는다: `repo_root` 1 + `show` 1).

### 4.2 실앱(Tauri exe) — `scripts/poc-dash-path.mjs`

크레이트 테스트는 함수를 직접 부른다. 크리틱 R5가 불합격을 낸 층은 그 위 둘이라
(`ipc/git.rs` → `window.api.git.*`) 같은 층에서 다시 쟀다. 격리 `CCG_HOME`,
격리 `CARGO_TARGET_DIR=target-gdash`, CDP 포트 9941, 픽스처는 `%TEMP%`에 새로 만든 레포,
**이름 기반 kill 0회**(내가 스폰한 PID만 `killTree`).

**같은 하네스·같은 픽스처·같은 exe 경로로 A/B를 냈다.** 대조군은 커밋 `4c5feb4` 뒤에 그
네 줄만 되돌려 다시 지은 릴리스 exe다(빌드 3m 31s / 2m 26s). 「크리틱이 잰 옛 수」를 인용한
게 아니라 **이 라운드가 직접 재현했다.**

| `window.api.git.*` | 대조군(가드 살아 있음) | 수정 뒤 |
|---|---|---|
| `status` | `["M -notes.txt","M -old/노트.txt","M 보통/노트.txt"]` | 동일 — UI가 실제로 이 행에 닿는다 |
| `fileDiff('-notes.txt')` | **`{"tag":"new","add":2,"del":0}`** ← 전체 초록 | `{"tag":"edit","add":1,"del":1}` |
| `fileDiff('-old/노트.txt')` | **`{"tag":"new","add":2,"del":0}`** | `{"tag":"edit","add":1,"del":1}` |
| `fileDiff('보통/노트.txt')` | `{"tag":"edit","add":1,"del":1}` (대조군) | 동일 |
| `commitFileDiff` 내용 | `-` 둘 다 **0자** · `보통` 8자 | 셋 다 **8자** |
| `index.lock` 판 `discard('보통/노트.txt')` | `ok=false` · 파일 **남음** | 동일 |
| `index.lock` 판 `discard('-old/노트.txt')` | `ok=false` · 파일 **사라짐** ★ | `ok=false` · 파일 **남음** |
| 하네스 판정 | `ok=false` (allEdit·allContent·lockedDiscardKeptFiles 전부 false) | `ok=true` (셋 다 true) |

★ 이 한 칸이 사고다. 두 행의 오류 문구는 **글자 하나까지 같다**
(`Unable to create '…/.git/index.lock': File exists.`). 사용자가 보는 것도 같다. 그런데
대조군에서는 `-`로 시작하는 쪽만 휴지통으로 갔다.

실행 환경: `CCG_HOME`=`%TEMP%/ccg-gdash-home-<pid>-<ms>`(측정 후 삭제) ·
`CARGO_TARGET_DIR`=`C:/Code/AgentCodeGUI/target-gdash` · CDP 포트 9941(수정)·9942(대조) ·
픽스처 레포 `%TEMP%/ccg-gdash-fix-<pid>-<ms>` · exe 6,469,632B.
**이름 기반 kill 0회** — 내가 스폰한 PID만 `killTree`로 걷었고 사용자의 실앱은 안 만졌다.
기준 결과 파일(`bench/results/*` · `bench/shots/*/report.json` · `docs/critic/*.json`)은
읽지도 쓰지도 않았다. 하네스 출력은 gitignore된 `bench/scratch/`에만 남긴다.

(부수: 대조군 실행이 사고를 그대로 재현했으므로 픽스처의 `-old/노트.txt` 17바이트 한 개가
실제로 Windows 휴지통에 들어갔다. 사용자 파일이 아니라 `%TEMP%` 픽스처다.)

---

## 5. 남은 것 · 안 건드린 것

- **`ipc/git.rs`는 순수 통과 계층**이다(`file_diff(cwd, rel)` · `discard(cwd, rel, untracked)` —
  경로 변형 없음). 그래서 크레이트 수정이 곧 실앱 수정이고, §4.2가 그것을 값으로 확인한다.
- 크리틱 R5 §5의 「격차 아님」 셋은 이 라운드 경계 밖이라 그대로 뒀다: 33초 대량 커밋의
  진행률·취소 부재, `file_diff`에 **디렉터리** 경로를 주면 트리 목록을 본문으로 읽는 것
  (`status`가 추적 디렉터리 행을 안 만들어 제품 도달 없음), 훅이 아무 말 없이 `exit 1`일 때
  「알 수 없는 오류」가 되는 것.
- `src-tauri/src/ipc/parity/misc.rs:91`에도 `a.starts_with('-')`가 있다. 그쪽은 **argv 스위치를
  건너뛰는** 자리(`initial_dir`)라 성격이 다르고 정당하다.

  > **[정정 — R28d EXTN · 2026-08-25]** 여기 원래 *"다만 이름이 `-`로 시작하는 폴더를
  > 「AgentCodeGUI로 열기」로 열면 못 연다"* 고 적혀 있었다. **사실이 아니다.**
  > `initial_dir()`가 보는 것은 argv 원소 **문자열 전체**고, 탐색기 컨텍스트 메뉴는
  > `"%1"` = **절대 경로**를 준다(`C:\…`로 시작하니 `starts_with('-')`가 false다).
  > 실측(R28c GDASH 확인 크리틱 R1 §3.1 · R28d가 자기 릴리스 exe로 재확인):
  >
  > ```text
  > argv = "…\-열어볼폴더" (절대)   → getInitialDirectory() = 그 경로   ← 열린다
  > argv = "-열어볼폴더"    (상대)   → null                              ← 이때만 못 연다
  > ```
  >
  > 못 여는 것은 셸에서 `AgentCodeGUI3.exe -열어볼폴더`처럼 **상대 경로로 직접 부를 때**뿐이고
  > 그건 「AgentCodeGUI로 열기」가 아니다. **코드는 정당하고 문장이 틀렸다.**
  > (같은 문장이 커밋 `a95173c`의 메시지에도 있다. 커밋 메시지는 고칠 수 없으니
  > 그 정정은 `docs/parity-fix-extn-r1.md` §장부에 남긴다.)
