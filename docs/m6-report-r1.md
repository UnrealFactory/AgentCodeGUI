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

---

# §R2 — 크리틱 판정에 대한 답 (`docs/critic/m6-r1.md`)

크리틱 판정은 **조건부 확인**이었다: 이식의 본체는 재현됐고 수치는 전부 맞았지만,
**파괴 경로 한 곳에서 2.6.2와 의미가 갈렸고 그 방향이 사용자 데이터 소실**이었다.
이 라운드는 그 자리를 포함해 크리틱이 매긴 S1~S9 + §7 관찰 중 고칠 수 있는 것을 전부 밟았다.
아래 수치는 **전부 이 라운드에서 다시 잰 실측**이고, 재현 도구는 크리틱이 남긴
`docs/critic/tools/critic-m6-*`를 **그대로** 썼다(고친 사람이 저울까지 새로 만들지 않는다).

## R2.0 한 줄 표

| # | 크리틱 지적 | 상태 | 증거 |
|---|---|---|---|
| **S1** 치명 | 휴지통 없는 볼륨에서 조용히 영구 삭제 + `ok:true` | **고침** | subst `X:` → `ok=false`·**파일 생존**·휴지통 176→176 (2.6.2와 같은 답) |
| **S2** 치명 | 동기 스킴 핸들러가 UI를 21초 얼림 | **고침** | UNC 블랙홀 요청 중 `IsHungAppWindow` 0회 · `SendMessageTimeout` **6ms 유지** |
| **S3** 높음 | `ccg-img`에 `ACAO: *` (JS가 임의 이미지 바이트를 읽음) | **고침** | sandbox iframe(오리진 `null`) → `TypeError: Failed to fetch` + 서버가 403 |
| **S4** 높음 | 잠긴 파일 되돌리기 = 인덱스만 지우고 유령 두 행 | **고침** | `still_in_index:true` · `status_after:["M:locked.txt"]` (R1: `["D:","A:"]`) |
| **S5** 중간 | 32MB 캡을 "새 파일 +1 −0"으로 그림 | **고침** | 35MB blob → `"파일이 너무 커요 — diff 표시는 1.5MB까지만"` |
| **S6** 중간 | `discard(".")`가 저장소 폴더 통째로 | **고침** | `discard_root_self: ok=false · repo_still_there=true` |
| **S7** 중간 | 정렬 잔여 클래스 2개(전각 라틴·가나 상호) | **고침** | 클래스 대조 **0/3 · 0/2**, "hard" 풀 세트 불일치 192→**98** |
| **S8** 낮음 | `(os error N)`·`On branch main`이 사용자 문구로 샘 | **고침** | `"지정된 경로를 찾을 수 없습니다."` · `"바뀐 내용이 없어요"` |
| **S9** 낮음 | `git:status`가 2.6.2보다 1.5~2배 느림 | **고침** | 12회 중앙값 **tauri 46ms / electron 47ms** (R1: 61·80·132 vs 44·66) |
| §6 격차 | 파괴 경로에 화면 증거 0 — "휴지통 +1" 저울이 없음 | **추가** | `bench/m6.mjs` 새 검사 `delete-goes-to-recycle-bin`(A/B 둘 다 `delta:1`) |
| §7 R-3 | stderr 256KB 초과 시 EPIPE/교착 | **고침** | 캡을 넘어도 파이프를 끝까지 **비운다**(보관만 256KB) |
| §7 R-4 | `%s`에 `\x1f`가 들어가면 칸이 밀림 | **고침** | 제목에 US를 심은 커밋으로 테스트(제목·본문·작성자 전부 무손상) |
| §7 R-1·R-2·R-5·R-6 | 고정 픽스처 · CDP 캐스케이드 · 정션 · 볼륨 종류 | **안 고침** | R2.8 여백에 이유를 적었다 |

게이트: `cargo test -p ccg-fs` **73 passed / 0 failed**(R1 61 → +12) ·
`cargo clippy -p ccg-fs --all-targets` ccg-fs 경고 0 · `cargo clippy -p agentcodegui` 경고 0 ·
`bench/m6.mjs both` **electron 15/15 · tauri 16/16**(값 전 항목 동수).

## R2.1 S1 — 삭제 페일세이프: `IFileOperation` + `FOFX_RECYCLEONDELETE` + 진행 싱크

`FOF_ALLOWUNDO`는 "**가능하면** 휴지통"이다. 휴지통이 없는 볼륨에서는 그냥 지우고 `rc=0`을
돌려준다. Electron `shell.trashItem`이 같은 자리에서 실패하는 이유는 플래그가 아니라
**진행 싱크**다 — `platform_util_win.cc`의 `DeleteFileProgressSink::PreDeleteItem`이
`TSF_DELETE_RECYCLE_IF_POSSIBLE`이 안 켜져 있으면 `E_ABORT`를 돌려 작업을 끊는다.
`crates/ccg-fs/src/file.rs`의 `trash`를 그 구조로 갈아 끼웠다(`RecycleOnlySink`).

`subst X:`(휴지통 없는 볼륨)에서 **두 앱을 같은 조건으로** 재측정:

```
                           op_ok   file_gone   휴지통 항목
3.0 R1 (SHFileOperationW)  true    true        162 → 162   ← 영구 삭제 + 성공 보고
3.0 R2 (IFileOperation)    FALSE   FALSE       176 → 176   ← 거부, 파일 생존
2.6.2  (shell.trashItem)   false   false       110 → 110   ← 같은 답
대조군 C:                  세 경우 모두 true · 휴지통 +1     ← 여기선 원래도 같았다
```

잃지 않은 것도 못으로 박았다(휴지통 API를 바꾸면 깨지기 쉬운 자리):

```
긴 경로 346자   ok=true · 휴지통 +1   (2.6.2 345자도 +1)
폴더 통째      ok=true · 휴지통 +1   (미추적 폴더 되돌리기의 반경)
없는 경로      ok=false             (성공으로 위장하지 않는다)
네이티브 창    0개                  (FOF_NO_UI — 인라인 오류 규약 유지)
```

## R2.2 §6 격차 — `bench/m6.mjs`에 "휴지통 +1" 저울을 넣었다

크리틱이 지목한 대로, R1의 `file-ops-write-path`는 `deletePath`를 부르고 **없어졌는지만**
봤다. 삭제의 계약은 "없어졌다"가 아니라 "휴지통에 들어갔다"다. 새 검사
`delete-goes-to-recycle-bin`은 두 저울을 같이 본다 — ① 휴지통 **항목 수 +1**,
② `$Recycle.Bin`의 `$I` 메타에서 **바로 그 파일**을 찾는다. A/B 결과:

```
electron 2.6.2   {"before":112,"after":113,"delta":1,"foundInBin":true,"cleaned":true}
tauri    3.0     {"before":114,"after":115,"delta":1,"foundInBin":true,"cleaned":true}
```

②는 뒷정리도 겸한다(`cleaned:true`) — 하네스가 사용자 휴지통에 시험 잔해를 남기지 않는다.
같은 규약을 크레이트 테스트에도 넣었다(`SHQueryRecycleBin` 항목 수 + `$I` 되지우기):
`delete_lands_in_the_recycle_bin_not_the_void` ·
`a_path_past_max_path_still_reaches_the_recycle_bin` ·
`deleting_a_folder_takes_the_whole_subtree_to_the_bin`.

## R2.3 S2 — 스킴 핸들러를 비동기로

`register_uri_scheme_protocol` → `register_asynchronous_uri_scheme_protocol`.
핸들러는 URI만 받아 **워커 풀**에 넘기고 즉시 돌아온다(`main.rs` `img_serve`).
워커 4개는 2.6.2의 `fs.promises.readFile`이 돌던 **libuv 기본 스레드풀과 같은 폭**이다 —
느린 경로 하나가 큐를 막는 성질까지 같은 자리에 둔다(요청마다 스레드를 만들면 악의적
페이지가 스레드를 무한히 만든다).

크리틱과 같은 도구(`critic-m6-live.mjs`: 도달 불가 UNC `\\10.255.255.1\share\a.png` 한 장을
`<img>`로 걸고 `SendMessageTimeout(WM_NULL, 2s)` + `IsHungAppWindow`):

```
                 요청 전            요청 중(1.2s)        요청 중(2.4s)
3.0 R1          True|6ms|False     FALSE|2016ms|False   FALSE|2013ms|TRUE
3.0 R2          True|6ms|False     True|6ms|False       True|6ms|False    ← 정지 0
2.6.2           True|7ms|False     True|6ms|False       True|6ms|False
```

이 회귀는 R1 시점엔 "아직 안 터진다"였는데, 그 사이 M-UX R3이 `imageSrc()`를
`http://ccg-img.localhost/…`로 붙여 **지금은 실제로 닿는 경로**가 됐다. 크리틱이 예고한
그대로다.

곁가지 확인: 크리틱 §2.3이 "2.6.2만 OK"로 센 3화면 중 **둘이 3.0에서도 통과**한다
(`node bench/ab.mjs tauri --only=viewer-image,viewer-svg-preview,viewer-html-preview`
→ `viewer-image` OK 3197ms · `viewer-svg-preview` OK 2445ms · `viewer-html-preview` 실패).
남은 하나는 `ccg-page`(=`fs:html-preview-url` 미구현)라 이번 경계 밖이다. 화면 셋은
M-UX 소관이라 **기준 파일 `bench/shots/tauri/report.json`은 `git checkout`으로 되돌렸다**
— 위 수치는 콘솔 출력이다.

> 남는 성질(2.6.2와 같음): 크레이트 직접 호출 `serve::image_response`는 여전히 21초 걸린다
> (도달 불가 UNC의 `std::fs::metadata`가 그렇다). 바뀐 것은 **그 21초를 누가 기다리느냐**다 —
> UI 스레드가 아니라 워커 하나다.

## R2.4 S3 — CORS 회수: `*` → 앱 오리진 하나

`ACAO: *`를 지우고 `ccg_fs::serve::cors_allows`(테스트 있음)가 허락한 오리진만 되돌려준다.
표에 있는 것은 `http(s)://tauri.localhost`뿐이고, vite dev 서버(`localhost:5273`)는
**디버그 빌드에서만**이다. 그리고 브라우저의 CORS 강제에 기대지 않는다 — `Origin`이 붙은
요청(=스크립트가 부른 fetch/XHR)이 표 밖이면 **바이트를 아예 안 내보낸다(403)**.
`<img>`·CSS 배경 같은 no-cors 로드는 `Origin`을 안 보내므로 그림 그리기는 영향이 없다.

실측(살아 있는 앱, 같은 `secret.json.png`):

```
                                    R1        R2
앱 오리진 fetch(tauri.localhost)     200 읽힘   200 읽힘   ← 의도(이 오리진은 fs:read-file도 쓴다)
sandbox iframe fetch(오리진 null)    200 읽힘   TypeError: Failed to fetch   ← 닫혔다
```

`null` 오리진이 바로 크리틱이 말한 "청중"이다(sandbox iframe · SVG 문서 · 앞으로 올
`ccg-page` 미리보기 — Tauri IPC가 없어 `fs:read-file`을 못 부르는 컨텍스트).
서빙 판정표 자체(확장자 화이트리스트 · 64MB 캡 · 경로 제한 없음)는 2.6.2 그대로 두었다 —
크리틱이 "탈출은 오해다"라고 확인한 부분이다.

## R2.5 S4·S6 — 되돌리기의 반경

`git::discard`에 가드 세 겹을 넣었다.

1. **뿌리·`.git` 거절.** `abs_of`는 `resolve_lexical(root, ".") == root`를 통과시켜서
   R1의 `discard(cwd, ".", untracked=true)`가 저장소를 통째로 휴지통에 넣었다.
   → `discard_root_self: {"ok":false,"err":"잘못된 경로","repo_still_there":true}`
   (R1: `ok:true` · `repo_still_there:false`). `.git` 아래도 같은 문구로 막는다.
2. **checkout 실패를 "새 파일"로 읽지 않는다.** R1은 `git checkout HEAD -- rel`이 실패하면
   무조건 "HEAD에 없던 파일"로 보고 `rm --cached` → 휴지통으로 갔다. 실패 이유는 그것만이
   아니다(잠김·권한). 이제 `git cat-file -e HEAD:rel`로 **git에 직접 물어** HEAD에 있으면
   아무것도 지우지 않고 진짜 사유를 돌려준다.
3. **인덱스는 파일이 실제로 휴지통에 들어간 뒤에만 만진다.** 순서를 뒤집었다.

잠긴 추적 파일에 되돌리기(크리틱 `critic-m6-attack2.rs` 그대로):

```
R1  discard_ok=false "파일을 휴지통으로 보내지 못했어요"
    still_in_index=FALSE   status_after=["D:locked.txt","A:locked.txt"]   ← 유령 두 행
R2  discard_ok=false "unable to unlink old 'locked.txt': Invalid argument"
    still_in_index=TRUE    status_after=["M:locked.txt"]                  ← 아무것도 안 바뀌었다
```

문구가 바뀐 것도 의도다 — 휴지통은 시도조차 안 했으므로 "휴지통으로 보내지 못했어요"는
거짓말이었다. 새로 add된 파일이 잠긴 경우도 같은 규약이다(테스트
`discard_on_a_locked_new_file_keeps_the_index_intact`).

**정상 반경은 그대로다**(크리틱이 "전부 옳았다"고 적은 목록을 회귀로 다시 확인):

```
추적 파일 되돌리기  워크트리 "orig" · 인덱스도 "orig"       ✅
다른 파일 스테이징  "other-staged" 그대로                   ✅
새로 add된 파일     인덱스에서 빠지고 파일은 휴지통           ✅
미추적 폴더         하위까지 통째로 휴지통(2.6.2와 같음)      ✅
../ · 절대경로      "잘못된 경로" · 바깥 파일 생존            ✅
index.lock          실패하고 아무것도 안 지움                 ✅
```

> 미추적 **폴더 한 행 = 서브트리 통째**는 2.6.2와 같은 의미라 그대로 뒀다(`shell.trashItem(dir)`).
> 확인 카드 문구는 렌더러(`app/`) 소관이라 이 라운드 경계 밖이다 — R2.8에 남긴다.

## R2.6 S5 — 32MB 캡이 "새 파일"로 둔갑하지 않는다

`show_at`이 `Option<String>`이라 **"HEAD에 없다"와 "못 읽었다"가 같은 값**이었다.
`Blob { Text · Absent · TooBig · Unreadable }`로 갈랐다. 성공 경로는 한 글자도 안 바뀐다 —
`git show`가 성공하면 그대로 `Text`고, 갈래는 **실패했을 때만** 판정한다
(`exec`의 새 `over` 플래그 → `TooBig`, 아니면 `cat-file -e`로 존재 여부).

35MB blob이 HEAD에 있고 사용자가 파일을 한 줄로 줄인 상태:

```
R1  { error: null, tag: "new", add: 1, del: 0, lines: 2 }        ← 70만 줄 손실이 "초록 한 줄"
R2  { error: "파일이 너무 커요 — diff 표시는 1.5MB까지만" }         ← 되돌리기 옆에 사유가 뜬다
파일을 아예 지운 경우도 같은 사유(R1은 "내용을 읽을 수 없어요" + head_content 없음)
```

같은 갈래를 `commit_file_diff`에도 적용했다. 32MB 캡 자체는 그대로다 — 리포트 §3의
"반쪽 출력을 파싱해 거짓말하지 않는다"가 이제 `file_diff`까지 사실이다.

## R2.7 S7 — 정렬 잔여 클래스 둘

`weight()` 앞단에 폭·가나 접기를 넣었다(`fold_width_and_kana`). ICU가 **폭과 가나 종류를
3차 가중치로만** 보기 때문이다.

- 전각 ASCII `U+FF01..U+FF5E` → ASCII(`-0xFEE0`), `U+3000` → 공백
- 가타카나 `U+30A1..U+30F6` → 히라가나(`-0x60`), 반복 기호 `U+30FD..FE`도 같이

크리틱의 교차검증기를 **그대로** 다시 돌린 결과:

```
클래스별 쌍 대조 (critic-m6-collate2.mjs)
  전각 라틴   R1 2/3 mismatch  →  R2 **0/3**
  가나 상호   R1 1/2 mismatch  →  R2 **0/2**
  한자↔한글   R1 1/3           →  R2 1/3   (남김 — 아래)
  나머지 9클래스 전부 0

세트 단위 (critic-m6-collate.mjs, 같은 시드)
  실제 머신 이름 600세트   1 (0.2%)  → 1 (0.2%)   그 1건은 문서화된 `App`/`app` tie-break
  realish-30  600세트     23 (3.8%) → 23 (3.8%)  전부 같은 대소문자 tie-break
  hard-but-real 600세트   192 (32%) → **98 (16.3%)**
  random-soup  400세트    90        → 90         (세트 판정이 이진이라 한자 클래스가 가린다)
```

전체 목록 한 방 정렬에서 `ＦＵＬＬ幅.txt`는 이제 **ICU와 같은 자리(24번)**에 앉는다
(R1은 목록 끝으로 다섯 칸 밀렸다). `カタカナ.txt`도 `ひらがな.txt` 앞으로 왔다.

남긴 것 두 클래스, 이유를 정확히 적는다:

- **한자↔한글** — ICU의 `ko` 데이터는 한자를 **한국어 독음**으로 정렬한다(`字`는 "자" 자리,
  `漢`은 "한" 자리). R1 리포트가 "부수-획순"이라 적은 건 틀렸다. 맞추려면 한자 5천여 자의
  독음 표를 바이너리에 넣어야 하고(릴리즈는 `opt-level="s"`), 지금의 계층 근사
  (한글 전체 → 한자 전체)는 실사용 이름에서 대체로 같은 답을 낸다.
- **2글자 확장(`æ→ae`·`ß→ss`)** — 한 글자 근사로 남긴다. 전체 목록에서
  `æther.txt`/`Ångström.csv`의 앞뒤 하나가 어긋난다(이웃까지는 맞다).

## R2.8 남은 것 · 안 한 것 (정직한 여백)

- **확인 카드 문구/스코프**(미추적 폴더 되돌리기가 서브트리 통째라는 걸 사용자에게 알리는 일)는
  `app/`이라 이번 경계 밖이다. 채널 쪽 방어(뿌리·`.git` 거절)만 넣었다.
- **§7 R-1 고정 픽스처** — `bench/m6.mjs`는 여전히 살아 있는 실 레포를 클론한다.
  이번 실행의 `listFiles 813` · `커밋 상세 245자`도 그 시점 HEAD 값이라 **회귀 기준선이
  아니다**(A/B 동수만 의미가 있다). 픽스처 레포를 박는 건 하네스 설계 변경이라 다음 라운드로.
- **§7 R-2 CDP 캐스케이드**(`ab.mjs`의 `viewer-loading` 뒤) — 하네스 성질이고 두 앱 공통.
- **§7 R-5 정션이 `dir:false`** — 2.6.2부터의 동작이라 손대면 A/B가 깨진다.
- **§7 R-6 볼륨 종류** — `subst`만 실측했다. 네트워크·이동식·`NukeOnDelete=1`은 문서상
  같은 클래스고, 이제는 **셸이 판단**한다(우리가 플래그로 흉내내지 않는다) — 그 셋에서도
  `TSF_DELETE_RECYCLE_IF_POSSIBLE`이 안 켜지면 같은 자리에서 멈춘다.
- **`serve::image_response`의 21초** 자체는 그대로다(R2.3 각주).
- **2.6.2와 남은 의미 차이 1건**: 앱 오리진의 `fetch`가 `ccg-img` 바이트를 읽을 수 있다
  (2.6.2는 `file://` 오리진이라 못 읽었다). 그 오리진은 `fs:read-file`로 이미 임의 경로를
  읽으므로 새 권한이 아니고, `<img>`만 쓰는 지금은 실질 차이가 0이다. 완전한 동수를 원하면
  `cors_allows`를 빈 표로 만들면 된다(한 줄).
- **오류 문구 2건이 2.6.2와 다르다(의도)**: 없는 드라이브 쓰기는 3.0이
  `"지정된 경로를 찾을 수 없습니다."`(2.6.2 `ENOENT: … open 'Z:\nope\nope.txt'`),
  바뀐 게 없는데 커밋은 3.0이 `"바뀐 내용이 없어요"`(2.6.2 `"On branch main"`).
  둘 다 크리틱이 §S8에서 "사용자 문구에 있을 물건이 아니다"라고 적은 자리다.

## R2.9 이 라운드가 만진 파일

| 경로 | 무엇 |
|---|---|
| `crates/ccg-fs/src/file.rs` | `trash` → `IFileOperation`+`FOFX_RECYCLEONDELETE`+`RecycleOnlySink` · `io_msg`의 `(os error N)` 제거 · 휴지통 저울 테스트 4 |
| `crates/ccg-fs/src/git.rs` | `discard` 가드 3겹 · `show_at`→`Blob` 4갈래 · `status` 두 git 동시 실행 · stderr 완전 배출 · `log`/`commit_detail` 칸 밀림 차단 · "바뀐 내용이 없어요" · 테스트 5 |
| `crates/ccg-fs/src/serve.rs` | `cors_allows` 판정표 + 테스트 |
| `crates/ccg-fs/src/collate.rs` | `fold_width_and_kana`(전각·가나) + 테스트 2 |
| `crates/ccg-fs/Cargo.toml` | `Win32_System_Com` · `windows-core`(`#[implement]`가 절대 경로를 쓴다) |
| `src-tauri/src/main.rs` | 비동기 스킴 등록 + `img_serve` 워커 풀 4 + `img_response`(CORS 판정·403) |
| `bench/m6.mjs` | `delete-goes-to-recycle-bin` 검사 + 휴지통 저울/뒷정리 헬퍼 |

## R2.10 재현 방법

```bash
CARGO_TARGET_DIR=%TEMP%/m6r2 cargo test -p ccg-fs               # 73 green
CARGO_TARGET_DIR=%TEMP%/m6r2 cargo clippy -p ccg-fs --all-targets
cargo build --release --features custom-protocol -p agentcodegui
node bench/m6.mjs both                                          # 15/15 · 16/16

# 크리틱 도구 (examples/·bench/로 복사해 돌린다 — 레포에는 안 남긴다)
cp docs/critic/tools/critic-m6-attack*.rs crates/ccg-fs/examples/
cp docs/critic/tools/critic-m6-{live,live2,collate,collate2}.mjs bench/
subst X: %TEMP%\m6r2-subst        # 휴지통 없는 볼륨. 끝나면 subst X: /D
cargo run --release -p ccg-fs --example critic_attack2          # S1·S4·S5
node bench/critic-m6-live.mjs both                              # S2 정지 · S3 CORS
node docs/critic/tools/critic-m6-collate2.mjs <critic_collate.exe>  # S7
```
