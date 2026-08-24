# R28c GDASH 확인 크리틱 — 한 줄은 진짜로 지워졌다. 장부의 「못 연다」는 사실이 아니다

라운드: R28c GDASH 확인 크리틱(라운드 1 · 새 컨텍스트 · 전면 재실측) · 2026-08-25 · `feature/3.0.0-beta`
판정 대상: `4c5feb4`(`crates/ccg-fs/src/git.rs` · `scripts/poc-dash-path.mjs`) + `a95173c`(`docs/parity-fix-gdash-r1.md`)

**판정: 합격(pass=true).**

체크리스트 4항목 **전부 실측 통과**했다. 크레이트에서도, 실앱(Tauri exe)에서도.
그리고 「고쳤다」의 값을 빌더의 수를 인용하지 않고 **내가 지은 대조군으로 직접 재현**했다 —
레포 밖 `%TEMP%`에 `ccg-fs`·`ccg-store`를 복사해 그 네 줄만 되돌린 독립 워크스페이스를 짓고,
같은 하네스를 양쪽에 붙였다. 대조군에서는 `.git/index.lock`이 놓인 판에서 `-`로 시작하는
**세 경로 전부가 「실패했다」는 문구를 받으면서 휴지통으로 갔다.** 수정본에서는 넷 다 남는다.

격차로 셀 만한 것은 못 찾았다. 대신 **장부 정정 둘**과 **한 줄이 넓힌 잠복 사마귀 하나**를 적는다.

---

## 1. 실측 방법 — 빌더의 테스트도, 빌더의 하네스도 근거로 안 썼다

네 층에서 따로 쟀다.

1. **레포 밖 독립 하네스** — `%TEMP%/ccg-gdashcrit/probe`에 `ccg-fs`를 path 의존으로 무는
   바이너리 셋(`gdashcrit`·`p2`·`p3`). `status`/`file_diff`/`bulk_file_diffs`/`commit_file_diff`/
   `commit`/`discard`/`log`/`commit_detail`/`spawn_count`를 **공개 API로 직접** 불렀다.
2. **내가 지은 대조군** — `%TEMP%/ccg-gdashcrit/ctrl`에 `crates/ccg-fs`·`crates/ccg-store`를
   복사하고 워크스페이스 루트를 새로 써서, `show_at`의 네 줄만
   `if rel.starts_with('-') { return Blob::Absent; }`로 되돌렸다. **레포는 한 글자도 안 만졌다.**
   같은 하네스 소스를 그 복사본에 붙여 A/B를 냈다.
3. **실앱(Tauri exe)** — `--features custom-protocol` · 격리 `CARGO_TARGET_DIR=target-gdashcrit`로
   릴리스 빌드(**3m 16s** · exe **6,469,632B** — 빌더 장부의 크기와 바이트까지 같다). 격리
   `CCG_HOME`으로 띄우고 CDP로 `window.api.git.*`를 직접 불렀다. 빌더의 하네스도 **내 exe·내
   포트로 재주행**했고, 그것이 안 재는 것(2단 중첩 `-archive/a/b.txt` · `-` 새 파일 되돌리기 ·
   argv)은 내가 따로 쓴 하네스로 쟀다.
4. **raw git** — 우리 코드가 하는 말이 맞는지 매번 음성 대조.

- 격리: `CARGO_TARGET_DIR` = `target-gdashcrit`(실앱·clippy·agentcodegui) ·
  `%TEMP%/ccg-gdashcrit-ptarget`(수정본 하네스) · `-ctarget`(대조군 하네스) ·
  `-ctltarget`(대조군 크레이트 테스트) · `%TEMP%/ccg-gdashcrit-target`(ccg-fs 테스트).
  `CCG_HOME` = `%TEMP%/ccg-gdashcrit-home` · `-apphome-<pid>-<ms>`. CDP **9951 · 9952 · 9953**
  (다른 갈래의 9931·9932·9941·9942와 안 겹친다).
- **이름 기반 kill 0회.** 사용자 실앱 5프로세스(pid 6644 · 12924 · 23792 · 24836 · 26924)는
  측정 전후 **그대로**다. 내가 걷은 것은 내가 스폰한 PID뿐(`killTree`). 옆 갈래가 띄워 둔
  `target-cpath` exe는 측정 사이에 PID가 30740→36472로 바뀌었는데 **그쪽이 재시작한 것**이고
  나는 그 PID에 손댄 적이 없다.
- 기준 결과 파일 **무접촉**: `bench/results/*` · `bench/shots/*/report.json` ·
  `docs/critic/*.json`은 읽지도 쓰지도 않았다. 하네스 출력은 전부 `%TEMP%`에만 남겼다
  (`--json=%TEMP%/…`). `npm ci` 안 씀. 실 HTTP·실계정 접촉 0.
- git 2.53.0.windows.1 · cargo 1.96.1 · node v24.13.1.
- 측정 중 옆 갈래들이 커밋했다(`git status`의 미커밋 목록이 17→6파일로 줄었다). 내 경계
  밖이라 안 건드렸고, 내가 트리에 더한 파일은 이 판정문 하나다(`target-gdashcrit/`는
  `.gitignore`의 `target-*/`가 먹는다).

---

## 2. 체크리스트 4항목 — 전부 실측 통과

### ① `-` 시작 경로 셋 — `file_diff`=edit · bulk 일치 · commit 내용 보존 — **통과**

픽스처: `-notes.txt`(최상위 `-` 파일) · `-old/노트.txt` · `-archive/a/b.txt`(최상위 `-` 폴더
안쪽 2단) + 대조군 `보통/노트.txt`. 넷 다 `"원본\n둘째 줄\n"`로 커밋하고 둘째 줄만 고쳤다.
`ls-files -z`로 넷이 실제로 추적됐음을 먼저 확인했다(픽스처가 무너지면 아래가 공허하다).

**raw git 음성 대조** — 가드가 막으려던 위험이 애초에 없다는 근거를 git에게 직접 물었다:

```
git show     'HEAD:-notes.txt'      → exit 0 · "원본\n둘째 줄\n"
git cat-file -e 'HEAD:-notes.txt'   → exit 0
git show     'HEAD:-old/노트.txt'    → exit 0
git show     'HEAD:-no-such.txt'    → exit 128     ← 없으면 정직하게 128
git cat-file -e 'HEAD:-no-such.txt' → exit 128     ← 대괄호와 달리 0바이트 거짓말이 없다
```

**A/B(내가 지은 대조군 대 수정본, 같은 하네스·같은 픽스처):**

| | 대조군(가드 되돌림) | 지금 |
|---|---|---|
| `file_diff('-notes.txt')` | `new +2 −0` | **`edit +1 −1`** |
| `file_diff('-old/노트.txt')` | `new +2 −0` | **`edit +1 −1`** |
| `file_diff('-archive/a/b.txt')` | `new +2 −0` | **`edit +1 −1`** |
| `file_diff('보통/노트.txt')` | `edit +1 −1` | 동일(대조군) |
| `file_diff` == `bulk_file_diffs` | **4행 중 3행 불일치** | **4/4 일치**(tag·add·del 셋 다) |
| `commit_file_diff` content | `-` 셋 다 **0자** · 보통 18B | **넷 다 18B**(`"원본\n둘째 줄\n"`) |
| 지운 `-old/노트.txt`의 `head_content` | `error="내용을 읽을 수 없어요"` | **`"원본\n둘째 줄\n"`** |
| `file_diff` 스폰(`-` / 평범) | **1 / 2** | **2 / 2** ← 같은 값을 치른다 |

「같은 파일에 두 답」이 이 표의 다섯째 줄이다. 대조군에서 뷰어(`file_diff`)와 AI 커밋 메시지
수집(`bulk_file_diffs`)이 같은 파일을 각각 「새 파일 +2」와 「수정 +1 −1」로 그렸다.

**과잉 교정 안 났다**: HEAD에 진짜로 없는 `-새 파일.txt`는 양쪽 다 `tag="new"`.

**덤 — 극단 이름 넷도 같이 살아났다**(빌더도 크리틱 R5도 안 쟀다). `--weird.txt` · `-.txt` ·
`-`(한 글자) · `---a/b.txt`: 대조군 **전부 `new`** → 지금 **전부 `edit +1 −1`**, 되돌리기 전부
`ok=true` + 내용 복원.

### ② `index.lock` 판 `discard` — ok=false인데 **파일이 남는다** — **통과**

`.git/index.lock` 파일 하나로 잠근다(프로세스 안 띄움). 계약은 「아무것도 안 지우고 사유를
그대로 준다」.

| `discard(…, untracked=false)` | 대조군 | 지금 |
|---|---|---|
| `보통/노트.txt` | ok=false · 파일 **남음** | 동일 |
| `-old/노트.txt` | ok=false · 파일 **사라짐** ★ | ok=false · **남음** |
| `-notes.txt` | ok=false · 파일 **사라짐** ★ | ok=false · **남음** |
| `-archive/a/b.txt` | ok=false · 파일 **사라짐** ★ | ok=false · **남음** |

★ 네 행의 오류 문구는 **글자 하나까지 같다**(`Unable to create '….git/index.lock': File
exists.`). 사용자가 보는 것도 같다. 그런데 대조군에서는 `-`로 시작하는 **셋만** 휴지통으로
갔다. 빌더가 잰 것은 `-old/노트.txt` 하나였고, **나머지 둘도 같이 사라진다**는 것은 이 판정문이
처음 잰다(사고 반경이 장부보다 넓었다).

잠금을 풀면 넷 다 `ok=true`로 `"원본\n"` 복원 — **되돌리기를 죽이지 않았다.**

### ③ 정상 `discard` + 대괄호·`:(literal)` 규약 무회귀 — **통과**

```
[`-` 되돌리기 — 크레이트]
  추적 `-tracked.txt`·`-old/추적.txt`  ok=true · 내용 복원
  스테이징(A) `-staged.txt`            ok=true · 파일 제거 · index 빈 목록   ← 「새 파일」 갈래가 열린다
  미추적 `-untracked.txt`(untracked=true) ok=true · 파일 제거 · 이웃 seed.txt 무사
  미추적 `-새폴더/` 폴더 행             status가 행을 만든다(A·u=true) · discard ok=true
[R4의 못 — 스테이징된 대괄호 되돌리기]
  discard('app/posts/[id]/page.tsx')  ok=true · 파일 사라짐
    이웃 i 내용 "이웃의 저장 안 한 편집\n" 그대로 · index ["…/i/page.tsx","…/plain/page.tsx"]
[R3의 못 — 「고른 파일만」 커밋]
  commit(['app/posts/[id]/page.tsx'])  커밋된 것 정확히 1개 · 이웃 app/posts/i/는 `??` 그대로
  commit(['-notes.txt','-old/노트.txt']) 커밋된 것 정확히 2개 · `-notes.txt.bak`·`보통.txt`는 `??`
  훅 거부(pre-commit exit 1) + `-` 경로  ok=false · err="거부"
      이웃의 **기존 스테이징** 훅 전/후 바이트 동일   ← 롤백이 고른 것만 내린다
[§S4 되살아나지 않는지 — HEAD의 빈 파일]
  빈.txt · app/[id]/빈.tsx · -빈.txt   셋 다 head_content=Some("") · discard ok=true · 복원됨
                                        (대조군은 `-빈.txt`만 head_content=null이었다)
[그 밖에 대조군과 **완전히 동일**한 것]
  commit_detail의 `-` 파일 목록 · 스테이징된 `-` 새 파일의 file_diff(new +2) ·
  미추적 `-` 폴더 행 · 훅 롤백 · 「고른 것만」 커밋
```

즉 **수정의 파급이 정확히 `show_at` 한 자리**다. 좋아진 것 말고 달라진 것이 없다.

### ④ 테스트 무후퇴 + 타입 3종 — **통과**

```
cargo test -p ccg-fs        100 통과 · 0 실패 · 2 ignored · 9.35s   (크리틱 R5 기준 98 → +2)
  ↳ 같은 코드를 **대조군에**서 돌리면  98 통과 · 2 실패 · 2 ignored
     git.rs:2316  left "new" / right "edit"   「추적 중인 파일을 「새 파일」로 그렸다」
     git.rs:2394  「실패했다」고 말해 놓고 HEAD에 있는 `-` 파일을 휴지통에 넣었다
     → 새 그물 둘이 **정확히 그 한 줄에만 매달려 있다**. 장식이 아니다.
cargo test -p agentcodegui  145 통과 · 0 실패 · 0 ignored
cargo clippy -p ccg-fs --all-targets   ccg-fs 경고 **1건**(기존 SPAWNS thread_local) — 새 경고 0
npm run typecheck (node·web) exit 0 · npm run typecheck:app exit 0
```

### 실앱(Tauri exe) — 같은 답이 `window.api.git.*`에서 나온다

빌더 하네스 `scripts/poc-dash-path.mjs`를 **내 exe·포트 9951**로 재주행: `ok=true`
(`allEdit`·`allContent`·`lockedDiscardKeptFiles` 셋 다 true). 그 위에 내 하네스(포트 9952)로 더:

```
status      ["M -notes.txt","M -old/노트.txt","M -archive/a/b.txt","M 보통/노트.txt"]  ← UI가 여기 닿는다
fileDiff    넷 다 {"tag":"edit","add":1,"del":1}      ← 크리틱 R5는 이 층에서 {"tag":"new"}를 봤다
commitFileDiff 넷 다 content 8자(빈 문자열 아님)
index.lock 판 discard  네 행 전부 ok=false · 파일 **남음**
잠금 해제 뒤  discard('-notes.txt')·('-archive/a/b.txt')  ok=true · 내용 복원
              discard('-staged.txt', false)  ok=true · 파일 제거 · index 빈
              discard('-새.txt', true)       ok=true · 파일 제거
```

---

## 3. 장부 정정 둘 (격차 아님 — 그러나 커밋된 문장이 사실과 다르다)

### 3.1 ★ 「`-`로 시작하는 폴더는 「AgentCodeGUI로 열기」로 못 연다」 — **사실이 아니다**

보고서 §5(그리고 커밋 `a95173c` 메시지, 빌더 보고서 「미완/안 한 것」)이 이렇게 적었다:

> `src-tauri/src/ipc/parity/misc.rs:91`의 `a.starts_with('-')` … 다만 이름이 `-`로 시작하는
> 폴더를 「AgentCodeGUI로 열기」로 열면 못 연다.

**실측(내 릴리스 exe · 격리 홈 · CDP 9953):** `-열어볼폴더`라는 폴더를 만들고 exe에 인자로
줘서 `window.api.app.getInitialDirectory()`를 물었다.

```
argv = 절대경로  "…\ccg-gdashcrit-argv-…\-열어볼폴더"
   → "C:\\Users\\User\\AppData\\Local\\Temp\\ccg-gdashcrit-argv-…\\-열어볼폴더"   ← 열린다
argv = 상대경로  "-열어볼폴더"  (cwd = 그 상위)
   → null                                                                        ← 이때만 못 연다
```

`initial_dir()`가 보는 것은 argv 원소 **문자열 전체**이고, 탐색기 컨텍스트 메뉴는 `"%1"` =
**절대 경로**를 준다(`C:\…`로 시작하니 `starts_with('-')`가 false다). 못 여는 것은 셸에서
`AgentCodeGUI3.exe -열어볼폴더`처럼 **상대 경로로 직접 부를 때**뿐이고, 그건 「AgentCodeGUI로
열기」가 아니다. 제품 경로에는 그 제약이 없다. **코드는 정당하고 문장이 틀렸다.**

### 3.2 「`status`가 추적 디렉터리 행을 안 만든다」 — 이유가 부정확하다(결론은 유지)

크리틱 R5 §5가 `file_diff`에 디렉터리 경로를 주면 트리 목록을 본문으로 읽는 것을 「제품 도달
없음」으로 넘긴 근거가 *"`status`가 추적 디렉터리 행을 안 만들어"*였다. **만든다** — 더러운
서브모듈이 그렇다:

```
git status --porcelain=v2 -z   "1 .M S.M. 160000 … 보통sub"
ccg_fs::git::status            [{"p":"보통sub","s":"M","u":null}]     ← 디렉터리 경로 행이다
```

다만 결론은 선다. 그 행을 클릭하면(`file_diff(cwd,"보통sub")`) `git show HEAD:보통sub`가
gitlink라 실패하고, 코드는 **정직하게** `error="내용을 읽을 수 없어요"`를 준다 — 트리 목록을
본문으로 읽지 않는다. 제품 피해는 여전히 0이다. (`-`로 시작하는 서브모듈은 git 자신이
`submodule add`에서 거부해 만들 수조차 없다 — `error: unknown switch 's'`.)

---

## 4. 이 라운드가 넓힌 잠복 사마귀 하나 (격차 아님 · 다음 라운드 후보)

`file_diff`에 **평범한 추적 디렉터리** 경로가 가면 `git show HEAD:<dir>`의 **트리 목록을 파일
본문으로** 읽어 자신 있게 diff를 그린다(R5 §5가 이미 적은 것). 이번 수정은 그 사마귀를
`-`로 시작하는 디렉터리까지 **넓혔다**:

```
file_diff(cwd, "-dir")   대조군: error="내용을 읽을 수 없어요"   ← 가드 덕에 우연히 정직했다
                         지금  : {"tag":"edit","add":0,"del":4}  ← 트리 목록을 본문으로 읽는다
```

방향은 「평범한 경로와 같아졌다」는 수렴이고, `status`가 그 행을 안 만드니(§3.2) 지금은
도달 못 한다. 그래도 이번 라운드가 지운 병(**묻지 않고 자신 있게 답한다**)과 같은 집안이라
장부에 남긴다 — `show_at`이 `Blob::Text`를 돌리기 전에 `cat-file -t`가 `blob`이라 답했는지
한 번 물으면 닫힌다.

---

## 5. 그 밖에 확인한 것

- **`ipc/git.rs`는 정말 순수 통과 계층**이다(`s(a,"rel")`을 그대로 넘길 뿐 경로 변형 0).
  렌더러도 그렇다 — `GitModal.tsx:358`이 `discard(repo, f.path, !!f.untracked)`로 `status`가
  준 값을 그대로 쓴다. 크레이트 수정이 곧 실앱 수정이라는 보고서 §5의 문장은 맞다.
- **남은 `spec.starts_with('-')`는 정말 죽은 가지다.** `valid_hash`는 `(4..=40)` 길이 + 전부
  ASCII 16진수라 `-`를 통과시킬 수 없고, `show_at`의 호출부는 `"HEAD"` · `hash` · `"{hash}^"`
  셋뿐이다(`commit_file_diff`가 `valid_hash` 검사를 먼저 한다). 지금 제품에서 이 가지가
  불릴 방법은 없다 — 그래도 `Absent`가 아니라 `Unreadable`을 돌리는 쪽이 「모르면 없다고 하지
  않는다」와 맞는다. 안 고칠 이유가 없다.
- **`--end-of-options`를 안 넣은 판단**도 재확인했다. 넣어서 얻을 것이 없다(막을 위험이
  없으니). git < 2.24에서 `file_diff`가 통째로 죽는 새 실패 모드만 산다.
- **대조군을 돌린 대가**: 대조군 실행이 사고를 그대로 재현했으므로 `%TEMP%` 픽스처의
  `-` 파일 셋이 실제로 Windows 휴지통에 들어갔다. 사용자 파일이 아니다.

---

## 6. 판정표

| 항목 | 결과 |
|---|---|
| 1. `-` 시작 경로 셋: `file_diff`=edit(±실값) · bulk 일치 · commit 내용 보존 | **통과** — 넷 다 `edit +1 −1` · 4/4 일치 · content 18B(대조군 0B) |
| 2. `index.lock` 판 `discard('-old/노트.txt')` ok=false + 파일 보존 | **통과** — `-` 셋 전부 남는다(대조군은 셋 다 휴지통) · 실앱도 동일 |
| 3. 정상 discard(`-` 새 파일·`-` 추적 파일) · 대괄호·`:(literal)` 무회귀 | **통과** — R3~R5의 못 전부 초록 · 빈 blob 과잉 교정 없음 · 극단 이름 넷도 회복 |
| 4. `cargo test -p ccg-fs` 무후퇴 + 타입 3종 | **통과** — 100/0/2(대조군 98/2/2로 그물 유효성 증명) · agentcodegui 145/0/0 · typecheck 3종 exit 0 |
| 실앱(`window.api.git.*`) | **통과** — 빌더 하네스 `ok=true` 재현 + 내 하네스로 2단 중첩·`-` 새 파일까지 |
| 장부 §5의 「「AgentCodeGUI로 열기」로 못 연다」 | **정정** — 절대 경로(=실제 컨텍스트 메뉴)로는 **열린다**. 상대 argv일 때만 null |
| R5 §5의 「status가 추적 디렉터리 행을 안 만든다」 | **정정** — 더러운 서브모듈이 만든다. 결론(제품 피해 0)은 유지 |

**다음 라운드에 넘길 것 하나(경계 밖 · 지금은 도달 불가)**: `show_at`이 `Blob::Text`를 돌리기
전에 대상이 **blob인지** 물어라(`cat-file -t`). 디렉터리·gitlink에 대해 트리 목록을 파일
본문으로 읽어 `("edit", 0, N)`을 자신 있게 그리는 자리가 남아 있다 — 이번 수정이 그 자리를
`-`로 시작하는 디렉터리까지 넓혔다.
