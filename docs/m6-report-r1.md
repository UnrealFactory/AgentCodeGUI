# M6 R1 — 파일·Git·뷰어: IDE 크롬이 실제로 동작하는 세로 조각

렌더러 n1(전체 IDE 레이아웃)은 서 있었지만 fs/git 채널이 전부 `__unimplemented`라
탐색기·코드 뷰어·Git이 빈 껍데기였다(렌더러 크리틱이 "IDE 크롬 검증 불가"로 판정한 원인).
이 라운드는 그 채널 면을 2.6.2와 **같은 답을 내는** Rust로 세웠다.

- 새 크레이트 `crates/ccg-fs` — 탐색기 트리 · 파일 읽기/쓰기 · 파일 작업 · 시스템 git 래퍼 ·
  Myers 라인 diff · 이름 정렬(collation) · 로컬 이미지 서빙
- 라우트 `src-tauri/src/ipc/fs.rs` · `src-tauri/src/ipc/git.rs` (+ `ipc/mod.rs` 상수·디스패치)
- 스킴 `ccg-img` 등록 (`src-tauri/src/main.rs`)

원본은 2.6.2다: `src/main/files.ts`, `src/main/index.ts`의 fs 핸들러, `src/main/git.ts`,
`src/shared/lineDiff.ts` + `src/main/claude/diff.ts`. 상한·정렬·에러 문구까지 같은 값을 쓴다.

---

## 1. 채널 구현 수 — 24 / 26

`app/src/api/shim.ts`가 실제로 부르는 fs·shell·git 채널이 모집단이다
(`fs:dir-exists`·`dialog:pick-directory`는 M1에 이미 있었다 — 모집단 밖).

| 도메인 | 구현 | 채널 |
|---|---|---|
| fs (8) | ✅ | `fs:list-dir` `fs:list-files` `fs:read-file` `fs:write-file` `fs:rename` `fs:delete` `fs:create` `fs:move` |
| shell (2) | ✅ | `shell:open-path` `shell:reveal-path` |
| git (14) | ✅ | `git:repos` `git:status` `git:log` `git:file-diff` `git:commit-detail` `git:commit-file-diff` `git:commit` `git:push` `git:pull` `git:fetch` `git:discard` `git:branches` `git:switch-branch` `git:create-branch` |
| 남긴 것 (2) | ❌ | `fs:html-preview-url`(ccg-page — 과제에서 범위 밖) · `git:ai-message`(엔진 1턴 — 실행 계통) |

`lsp:*`는 손대지 않았다 — `lsp:status`는 심의 안전값 `'unsupported'` 그대로다(M7 경계).

**감사 방법**: 화면을 거치지 않고 채널을 하나씩 때려 `__unimplemented` 마커를 직접 센다
(`bench/m6.mjs` `channel-audit`). 실측 `probed=22 ok=20`, 미구현은 위 둘뿐.
(감사에서 뺀 4개: `shell:open-path`·`shell:reveal-path`는 실제로 OS 앱을 띄우고,
`git:push`·`git:pull`은 네트워크 왕복이다 — 구현 여부는 코드와 아래 실증으로 본다.)

---

## 2. IDE 크롬 세로 조각 실증 — A/B 14 검사 전부 동수

`bench/m6.mjs` (신설). **격리 홈** + **이 레포의 로컬 클론**(`%TEMP%\ccg-m6-repo`)을 작업
폴더로 잡고 두 앱을 같은 방법으로 몬다. 클론이라 히스토리·브랜치·원격이 진짜고, 쓰기
동작(커밋 컴포저·파일 작업)을 눌러도 실 레포가 안 다친다.

심어둔 상태: 수정 1 · 새 파일 1 · 삭제 1 · 추적 파일 60개 한 줄씩 · 8000줄 파일 500곳 변경 ·
1.5MB 초과 파일 1개 → **더티 65**.

```
                         2.6.2            3.0.0-beta.1
explorer-tree            rows 28          rows 28      (.github app bench crates docs progress scripts src)
explorer-git-strip       feature/3.0.0-beta ●65 ↑1     동일
viewer-code-read         cmLines 36       36           (디스크의 package.json 앞 6줄과 문자 단위 일치)
viewer-markdown          6543자           6543자
git-changes              변경 65          65           (README.md · M6-NEW.txt · LICENSE · M6-BIG.txt 확인)
git-history              c-line 100       100
git-commit-detail        2343자           2343자       (본문·작성자·시각·파일 목록)
big-diff-thousands       +500 −500 / 8500줄, 116ms     +500 −500 / 8500줄, 116ms
big-diff-cap-folds       "파일이 너무 커요 — diff 표시는 1.5MB까지만"  동일 문구
alive-after-big-diff     tree 28          28
channel-surface          listDir 30 / listFiles 773 / readChars 3606 / repo true /
                         changed 65 / repos 1 / branches 1 / log 5 + hasMore   ← 두 앱 전부 동일
file-ops-write-path      생성·쓰기·읽기 왕복·이름변경·중복 거절·이동·탈출 거절·삭제 전부 통과
local-image-scheme       1472×991 PNG 수신 (2.6.2: ccg-img:// · 3.0: http://ccg-img.localhost/)
lsp-status               ready            unsupported  ← 의도된 유일한 차이(M7)
```

캡처: `bench/shots/m6-tauri/*.png` · `bench/shots/m6-electron/*.png`
(01 트리 · 02 Git 스트립 · 03 코드 뷰어 · 04 마크다운 · 05 Git 변경 · 06 히스토리 ·
07 커밋 상세 · 08 큰 diff 후 생존). 두 벌을 나란히 놓고 봐도 트리·아이콘·스트립·배지가 같다.

### bench/ab.mjs 게이트 — `explorer-git-strip` 도달 실패 해소

이전 리포트(`bench/shots/tauri/report.json`)의 실패는
`waitFor timeout: .explorer .git-strip .br` 였다. **지금은 OK다.**
탐색기·뷰어·Git 31화면을 두 앱에 같은 셋으로 돌린 결과:

```
2.6.2/3.0 둘 다 OK: 28   2.6.2만 OK: 3   둘 다 실패: 0   (총 31)
```

3.0만 못 가는 3개는 **한 뿌리**다(아래 §5-A):
`viewer-image` · `viewer-svg-preview` · `viewer-html-preview`.

`git-repo-list`은 여전히 skip인데 이건 3.0의 결함이 아니다 — 2.6.2의 저장소 발견은
**cwd 자체가 저장소면 거기서 걷기를 멈춘다**(중첩 저장소는 그 저장소를 열면 보인다).
이 레포가 그 경우라 화면 자체가 도달 불가다. 그 규약을 그대로 이식했고 테스트로 못 박았다
(`git::tests::a_repo_cwd_reports_only_itself`).

---

## 3. diff 캡 — 2.6.2에서 프로세스를 죽였던 자리

2.6.2의 크래시 주범은 LCS DP의 무제한 할당(V8이 못 잡는 OOM abort = 0x80000003)이었다.
그 답이 Myers O(ND) + 하드 상한 3종이고, **한 글자도 안 바꾸고 옮겼다**:

| 상한 | 값 | 무슨 일이 일어나나 |
|---|---|---|
| `diff::MAX_D` | 2000 | 경로 복원 메모리가 (D+1)² i32 ≤ 16MB로 물리 확정 |
| `diff::STEP_BUDGET` | 64M | (N+M)·D 근사 예산 — 초대형 입력은 D 상한이 비례 축소 |
| `git::MAX_DIFF_BYTES` | 1.5MB/쪽 | 넘으면 diff를 접고 사유를 준다(바이너리는 NUL 감지) |

3.0이 하나 더했다: **`git::MAX_OUTPUT` 32MB** — Node `execFile`의 maxBuffer와 같은 자리다.
Rust `Command::output()`은 무제한이라, 이 캡이 없으면 거대 blob 하나(`git show`)가
프로세스 메모리를 그대로 먹는다. 넘으면 자식을 죽이고 실패로 돌려준다(반쪽 출력을 파싱해
거짓말하지 않는다).

실측 동작:

| 입력 | 결과 |
|---|---|
| 8000줄 파일, 500곳 변경 (D=1000) | **정확한 diff** +500 −500 / 8500줄 · 116ms · 크래시 없음 |
| 8000줄 파일, 전 줄 교체 (D=16000 > 2000) | **폴백** — 전부 삭제 + 전부 추가(8000/8000). 크래시도, 빈 화면도 아님 |
| 20000줄 파일, 서로 먼 두 곳 수정 | +2 −2 (예전 DP가 "전체 초록"으로 뭉개던 바로 그 모양) |
| 300000줄 파일, 한 줄 수정 | +1 −1 (스텝 예산 안에서 정확) |
| 1.5MB 초과 | diff 접음 — "파일이 너무 커요 — diff 표시는 1.5MB까지만" |
| NUL 포함(바이너리) | diff 접음 — "바이너리 파일 — diff를 표시할 수 없어요" |

캡 검사 **직후 앱이 살아 있는지**를 별도 검사로 확인한다(`alive-after-big-diff`) —
"에러는 반환됐는데 렌더러가 죽었다"를 놓치지 않으려고.

---

## 4. 이식하면서 실제로 어긋났던 것 — 이름 정렬(collation)

`localeCompare(undefined, { sensitivity: 'base' })`를 `to_lowercase().cmp()`로 옮기면
**한글 이름이 통째로 자리를 옮긴다.** 실측(Node 24, 이 머신 ko-KR):

```
localeCompare : _priv  .env  1a  가나  나가  문서  Ábc  abc  app  Bench  zz
소문자 코드포인트: .env  1a  _priv  abc  app  bench  zz  Ábc  가나  나가  문서
```

한국어가 1차 언어인 앱에서 **맨 위에 오던 한글 폴더가 맨 아래로 내려간다** — "같은 화면"이
아니다. `crates/ccg-fs/src/collate.rs`로 세 가지를 맞췄다(전부 실측 기대값을 테스트에 박음):

1. 문장부호가 숫자·글자보다 앞선다 + 그 안의 DUCET 순서 (`_` < `-` < `.` < `(` < `#` < `+` < `=` < `~`)
2. 한국어 로케일에서 한글 → 한자 → 라틴 (CLDR `ko`의 `[reorder Hang Hani]`).
   로케일은 `GetUserDefaultLocaleName`으로 읽는다 — 2.6.2의 `localeCompare(undefined,…)`와
   **같은 원천**이다(앱의 UI 언어 설정이 아니다). `CCG_LOCALE`로 강제할 수 있다.
3. base sensitivity = 대소문자·Latin-1 발음구별부호 무시 (`ð→d`·`ø→o`는 정확, `þ`는 안 접힘 — 전부 실측 확인)

**교차 검증**(임시 하네스로 Rust 정렬 결과와 Node `localeCompare`를 세트 단위 대조):

- 실제 프로젝트 이름 꼴(영문·한글·악센트 + 구분자 + 확장자) 30개 × **600세트 → 불일치 0**
- 무작위 문자 수프(스크립트·부호 난입) 24개 × 400세트 → 43.5% 불일치.
  전부 두 갈래다: **한글·한자 혼재 이름의 상호 순서**(ICU는 한자를 부수-획순으로 끼워 넣는다)와
  **2글자 확장 접기**(`æ→ae`, `ß→ss`를 한 글자 근사로 뒀다). 둘 다 실사용 파일명에서
  0/600으로 안 나오는 조합이라 근사로 남기고 여기 적어 둔다.

같은 비교기를 `git:status`의 파일 목록 정렬에도 쓴다(2.6.2도 거기서 `localeCompare`였다).

---

## 5. 미구현 / 남은 것

### A. 커스텀 스킴 3화면 — 렌더러 한 줄이 남았다 (셸 쪽은 끝)

`viewer-image` · `viewer-svg-preview` · `viewer-html-preview`가 3.0에서만 못 뜨는 **한 뿌리**:

- 렌더러 `app/src/lib/images.ts`의 `imageSrc()`가 `ccg-img://local/?p=<abs>`를 만든다.
- **WebView2는 비표준 스킴을 못 받는다.** wry는 그래서 커스텀 스킴을
  `http://<scheme>.localhost/…`로 바꿔 필터를 건다(`wry-0.55.1 webview2/mod.rs`
  `attach_custom_protocol_handler` → `work_around_uri_prefix`). 리터럴 `ccg-img://`는 그
  필터에 안 걸리고 그냥 로드 실패한다 → `<img onError>` → 뷰어가 "이미지를 표시할 수 없어요".

셸 쪽은 이번 라운드에 세웠다: `main.rs`가 `ccg-img`를 등록하고, `ccg_fs::serve`가
**두 URL 모양을 다 받는다**(`?p=…` / `/<encoded path>`). 실증으로 3.0에서
`http://ccg-img.localhost/<abs>`가 1472×991 PNG를 정상 반환한다(`local-image-scheme` 검사).

> 남은 한 줄(app/ 소유자):
> ```ts
> // app/src/lib/images.ts
> export function imageSrc(p: string): string {
>   return 'http://ccg-img.localhost/' + encodeURIComponent(p)   // Windows/WebView2
> }
> ```
> (Tauri `convertFileSrc(p, 'ccg-img')`와 같은 문자열이다 — `tauri-2.11.5/scripts/core.js` 확인.)

`ccg-page`(HTML 미리보기)는 과제에서 명시적으로 범위 밖이라 채널을 안전값으로 뒀다
(`fs:html-preview-url` → 심이 `''` → 뷰어가 스피너에 머문다. Ctrl+D로 코드 보기 탈출 가능).
계획은 같은 자리다:
1. `main.rs`에 `ccg-page` 스킴 등록 + `ccg_fs::serve`에 `page_response(uri, roots)` 추가
   (MIME 표 `PAGE_MIME` + 이미지 표 재사용, `Access-Control-Allow-Origin: *`).
2. `fs:html-preview-url` 채널이 서빙 루트를 등록하고 URL을 발급 —
   **루트 밖은 404**라는 2.6.2 범위 제한을 그대로(`pageRoots` 소문자 키 집합).
3. 2.6.2의 입력 브리지 스크립트(`PAGE_KEY_BRIDGE`)를 문서 끝에 덧붙이는 부분까지 이식해야
   sandbox iframe 안에서 Ctrl+D·Esc·우클릭 제스처가 산다.
4. 렌더러 `htmlPreviewUrl` 소비부는 URL 문자열만 받으므로 손댈 필요 없다(스킴만 바뀐다).

### B. `git:ai-message`

diff를 읽어 엔진 CLI를 1턴 돌린다 — 실행 계통(R3 소유)에 붙어야 한다. 지금은
`__unimplemented` → 심이 `{ok:false}`로 갈음하고, 카드는 사용자가 직접 쓴 메시지로 그대로
커밋된다(기능 상실이지 고장이 아니다). 프롬프트 조립·마커 파싱·예산(총 120k·파일당 24k)은
`src/main/git.ts:488-630`에 그대로 있다.

### C. 변경 통지(감시) — OS 워처는 **의도적으로** 두지 않았다

2.6.2도 탐색기용 파일 워처가 없다(`fs.watch`는 LSP 내부 전용). 트리는 렌더러가 다시 물어보는
순간 갱신되고, 이 크레이트의 모든 조회는 **캐시 없이 매번 디스크**다:

1. 턴 종료 → `refreshKey` 증가 → 루트 + 펼쳐진 폴더만 `fs:list-dir` 재조회
2. 탐색기 파일 작업 성공 → 그 자리에서 재조회
3. Git 스트립 → `ccg-git-changed` 창 이벤트 + `refreshKey`로 `git:status` 재조회

워처를 새로 넣으면 2.6.2와 갱신 시점이 달라진다(에이전트가 100파일을 만지는 턴에서 트리가
100번 흔들린다). 넣으려면 렌더러의 디바운스까지 같이 설계해야 하므로 이번 라운드 밖이다.

### D. 알려진 미세 차이

- `lsp:*` 전부 미지원(M7). `viewer-code-saved`·`viewer-save-error`·`viewer-hover-card`·
  `viewer-back-forward`는 LSP 칩/정의 점프를 assert 하므로 M7 전까지 도달 불가다.
- `git:file-diff`의 1.5MB 판정은 2.6.2가 UTF-16 길이, 여기는 **UTF-8 바이트**다.
  한글 위주 파일에서 임계가 약간 빨리 걸린다(같은 파일이 2.6.2 1.4MB → 3.0 1.6MB로 세어질 수 있다).
- 대소문자만 다른 두 이름의 tie-break가 2.6.2(안정 정렬)와 다르다. 한 폴더 안에서는 NTFS가
  공존을 막으므로 탐색기에서는 도달 불가, `git:status`에서만 이론상 보인다.
- `ccg-img` 서빙에 **64MB 캡**을 새로 뒀다(2.6.2에는 없었다). 화면에 띄울 수 있는 규모를 한참
  넘는 지점이고, 없으면 URL 하나로 임의 크기 파일이 통째로 메모리에 올라간다.

---

## 6. 테스트

`cargo test -p ccg-fs` — **61 통과**. git 테스트는 전부 **격리 레포**다: 매 테스트가
`%TEMP%`에 자기 `git init` 레포를 만들고 `user.name`/`email`도 그 레포 안에서만 설정한다
(`--global` 금지, 사용자 config 불가침). git이 없는 환경이면 조용히 skip 한다.

- `diff` 11 — 정확도 5 · 상한/폴백 3 · 편집 스크립트 불변식 · 새 파일 · CRLF 정규화
- `dir` 8 — 정렬·필터 3갈래·빈 폴더 프루닝·루트 탈출(상대/절대)·글롭·멘션 목록
- `file` 12 — 인코딩/바이너리/절단·절대경로·읽기전용 쓰기 실패·이름변경/생성/이동 가드
- `git` 22 — status(브랜치·미추적·수정·삭제·개명·detached·한글+공백 경로) · log 페이징 ·
  diff(워킹트리·새 파일·삭제·커밋 스냅샷) · **캡 2종** · commit(선택 파일만·빈 입력 거절) ·
  branch(목록·생성·전환·형식 거절) · discard · push(원격 없음) · 저장소 발견 2종
- `collate` 5 — 실측 localeCompare 5세트 · Latin-1 표 정렬 · 스크립트 계층 · 전순서(반사·대칭·이행)
- `serve` 3 — URL 두 모양 · 확장자 화이트리스트 · MIME 표

clippy 무경고(`cargo clippy -p ccg-fs --all-targets`).

---

## 7. 설계 메모 — 왜 이렇게 했나

**git은 라이브러리가 아니라 CLI다.** 2.6.2가 CLI라서 답이 같아야 하고(사용자의 credential
helper·hook·config·LFS가 그대로 먹는다), 번들 크기가 0이며, 이 앱을 쓰는 사람의 머신에는
git이 이미 있다. 파싱은 로케일·인용에 안 흔들리는 기계 출력만 쓴다
(`--porcelain=v2 -z`, `\x1f` 필드 구분, `--name-status -z`).

**fs·git 채널만 블로킹 스레드로 뺐다** (`ipc/mod.rs ipc_call`). 나머지 채널은 메모리 스토어를
만지는 마이크로초짜리라 async 워커에서 돌아도 된다. 이 둘은 다르다 — 디렉터리 걷기·1.5MB
파일 읽기는 수십 ms고, **git은 자식 프로세스**라 `push`/`pull`이 네트워크 왕복만큼(초 단위)
막힌다. tauri의 async 런타임은 코어 수만큼의 워커를 가진 tokio라, 여기서 블로킹하면 그 시간
동안 다른 창의 IPC(창 컨트롤·스토어 저장)가 통째로 굶는다. `spawn_blocking`은 전용 풀로 뺀다.

**stderr는 별도 스레드로 읽는다.** 두 파이프를 한 스레드에서 순서대로 읽으면 상대가 가득 차서
서로 막힌다(고전적 파이프 교착) — `git status`가 큰 레포에서 멈추는 모양이 된다.

**표시 언어 `t(ko,en)`는 2초 TTL 캐시다.** 원본은 `ui-prefs`의 `ui.lang`인데, 2.6.2에서
캐시를 갱신하던 `ui-prefs:save` 핸들러가 3.0에서는 다른 모듈(`ipc/stores.rs`) 소유라 훅을
걸 수 없다. `t()`는 실패 경로에서만 불리므로(성공 응답에는 문구가 없다) 비용이 사실상 0이고,
설정에서 언어를 바꾸면 다음 오류부터 따라온다.

---

## 8. 파일

| 경로 | 내용 |
|---|---|
| `crates/ccg-fs/src/lib.rs` | 크레이트 헤더(크래시 규율·변경 통지 규약) · `t()` · 경로 해석/루트 가드 |
| `crates/ccg-fs/src/dir.rs` | `list_dir` · `list_project_files` · 글롭 excluder · 빈 폴더 프루닝 |
| `crates/ccg-fs/src/file.rs` | 읽기(인코딩·바이너리·절단) · 쓰기 · 이름변경/삭제(휴지통)/생성/이동 · 열기/탐색기에서 보기 |
| `crates/ccg-fs/src/git.rs` | 실행 래퍼(캡·교착 회피) · status/log/diff/commit/branch/… · 저장소 발견 |
| `crates/ccg-fs/src/diff.rs` | Myers O(ND) + 상한 3종 · `compute_line_diff` · `new_file_diff` |
| `crates/ccg-fs/src/collate.rs` | `localeCompare(sensitivity:'base')` 근사 |
| `crates/ccg-fs/src/serve.rs` | `ccg-img` 서빙 판정(MIME 표 · URL 두 모양 · 64MB 캡) |
| `src-tauri/src/ipc/fs.rs` · `git.rs` | 페이로드 배열 → 크레이트 인자. 안전값 폴백 |
| `src-tauri/src/ipc/mod.rs` | 채널 상수 24개 + 블로킹 라우팅 |
| `src-tauri/src/main.rs` | `ccg-img` 스킴 등록 |
| `bench/m6.mjs` | 격리 홈 + 레포 클론 A/B 하네스(14~15 검사) |
| `bench/shots/m6-{tauri,electron}/` | 캡처 + `report.json` |
