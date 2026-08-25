# R28g AUDIT3 확인 크리틱 R2 — 빠졌던 세 통로는 등급을 달고 표로 돌아왔고 내 손에서도 같은 값이 난다. 그런데 「R4는 이 축을 언급조차 안 했다」는 R4 자신의 §7이 반대로 말한다

판정자: R28g AUDIT3 확인 크리틱 R2 · 2026-08-25 · `feature/3.0.0-beta` @ `5f3f617`
대상: 수정 라운드 1 커밋 **`5f3f617`**(8파일 · 전부 `docs/critic/**`) — `final-parity-r5.md` §9.0·§9·§9.1·§1·§10·부록 A · `final-parity-r4.md`:162-169
규율: **빌더의 보고서·커밋 메시지를 근거로 쓰지 않았다.** 내 트리에서 빌드하고, **내 계기를 새로 쓰고**,
내 격리 홈에서 주행해 수치로 판정했다. 감사의 `critic-r28g-update*.mjs`도, 확인 크리틱 R1의
`crit-*.mjs`도 **한 줄도 안 물려받았다**(§0.3). **나는 레포 코드를 한 글자도 안 고쳤다 — 이 판정문 한 파일만 쓴다.**

---

## 0. 무엇으로 쟀나

### 0.1 측정 재료 (전부 내 것)

| 항목 | 값 |
|---|---|
| 판정 트리 | `git archive HEAD`(**`5f3f617`**) → `C:\Temp\ccg-r28g-a3cr2\wt` (`git worktree` 미등록 · 공유 `.git` 무변 · 남의 미커밋 변경 0) |
| 의존성 | `node_modules` **정션만**(412항목 · `npm ci`·`npm install` **0회** — 함정 3) |
| 프론트 | `npm run app:build` — vite **✓ 2.05s** · exit 0 · 번들 `index-BPsSgm_L.js` · `shim-B9H2j9wM.js` · `FileModal-Cz_dR_N7.js` |
| 셸 | `cargo build --release --features custom-protocol` · `CARGO_TARGET_DIR=C:\Temp\ccg-r28g-a3cr2\target`(**새 디렉터리** — 함정 11) · **2m08s** · **경고 0**(빌드 로그 `warning` 0건) · exit 0 |
| **내 판정 exe** | **6,600,704 B** · sha256 `732016437bfa13b2aefff198181a84d065b72eac2646618deaa9c5cebe0d6084` |
| `custom-protocol` 증표 | 방금 구운 내 번들 세 개가 exe 바이트 안에 **FOUND** · R5 초판 번들 `index-BqARnKoK.js`는 **없다**(= 다른 빌드) |
| 게이트 target | `C:\Temp\ccg-r28g-a3cr2\target-test` (**또 새 디렉터리** · debug 전체 재컴파일) |
| 격리 홈 | `C:\Temp\ccg-r28g-a3cr2\home-*` **23개**. **실홈을 한 바이트도 안 읽었다** — 내 홈 빌더는 6파일만 쓰고 `%USERPROFILE%\.agentcodegui`의 `accounts*.json`·`Local State`·`engines`를 **복사도 정션도 안 한다** |
| CDP 포트 | **10680~10688** (배정표 AUDIT3 `10620~` + 크리틱 `+50` = `10670~` 대역 안 · R1이 쓴 10670~10674와 안 겹치게 +10) |
| 프로세스 | 이름 기반 kill **0회** — 내가 스폰한 PID만(`taskkill /PID <pid> /T /F`). 주행 뒤 `Win32_Process` 전수: 살아 있는 `agentcodegui`는 **사용자 설치본 5개뿐**, 내 target·감사 target의 잔류 **0** |
| 네트워크 | 전 주행 `CCG_NO_NET=1` · 합성 계정은 `@example.invalid` · OAuth 왕복 **0** · 토큰 회전 유발 **0** |
| typecheck | `typecheck:node`·`typecheck:web` **exit 0** · `typecheck:app` **exit 0** |

### 0.2 내 계기 (신규 · 레포 밖 `C:\Temp\ccg-r28g-a3cr2\tools\`)

| 파일 | 무엇을 |
|---|---|
| `cr2-channels.mjs` | 계약면 독립 스캐너. `protocol.ts`의 `IPC`를 **중괄호 매칭 + 줄 파싱**으로 읽고(TS AST 미사용), Rust를 **문자열/주석 인식 토크나이저**로 훑어 **코드 안 문자열 리터럴만** 모은다. `pub mod ch { … }` 블록은 잘라내 **상수 정의 자체를 구현으로 안 센다**(블록 밖 사용만 구현) |
| `cr2-cdp.mjs` | 최소 CDP 클라이언트(Node 24 전역 `WebSocket`) · 내 홈 빌더 · `launch`/`killTree`/`waitPortFree` |
| `cr2-run.mjs` | 주행 팔 여덟: `pop`·`popstub`(한도 팝오버) · `n1`(맨 위로) · `n2`(렌더 예외 부팅) · `updbare`/`updready`/`upddl`(업데이트 카드) · `chan`(원시 채널) |

### 0.3 남의 하네스를 안 물려받았다는 증표

* **스텁 주입 방식이 다르다.** 감사는 `Page.addScriptToEvaluateOnNewDocument`로 `window.api` **setter 덫**을 놓는다.
  나는 3.0 심이 `shim.ts` 끝줄에서 `window.api = api`로 **평범한 객체를 대입**한다는 것을 소스에서 확인하고,
  한도 축은 **마운트 뒤 그냥 `window.api.getUsage = …`** 로 갈았다(얼어 있지 않다 — 2.6.2의 `contextBridge`와 다른 점).
* **홈이 다르다.** `bench/fixture.mjs`(470메시지·실홈 복사)를 안 썼다. 내 홈은 3메시지 픽스처 + 폭탄 채팅.
* **판별 칸·셀렉터·정착 조건·포트 대기·유효 표식 전부 내가 새로 썼다.** 계약면 스캐너도 알고리즘이 다르다(위 표).
* 다만 「CDP로 붙어 클릭하고 DOM을 읽는다」는 **배관**이고, 그 배관은 앱이 강제한다.

### 0.4 ★내 계기도 한 번 거짓말할 뻔했다 (실패담 · 안 적으면 다음 라운드가 밟는다)

N1 초판에서 「OpenAI 절을 못 찾았다(`no-sec`)」가 **3주행 연속**으로 났다. 그 상태의 표는
「행 0 · 디스크 무변 · 실패 문구 없음」이라 **「맨 위로가 아무 일도 안 한다」를 거짓으로 확증할 뻔했다.**
원인은 제품이 아니라 내 셀렉터였다 — `.set-sec`는 CSS `text-transform`으로 대문자화돼 `innerText`가
**`"OPENAI"`**로 온다(내가 쓴 조건은 `=== 'OpenAI'`). `/openai/i`로 고치고 다시 3주행 돌렸다.
그 판을 「제품 결함」으로 적지 않은 이유는 **같은 주행의 원시 `codex-auth:list-accounts`가 계정 둘을
정상으로 돌려줬기 때문**이다(계기가 눈이 먼 것이지 채널이 죽은 게 아니다). 초판 산출물은 레포에 안 남겼다.

---

## 1. 한 문단 결론

**크리틱 R1의 C-1은 진짜로 닫혔다.** §9 첫 줄은 「하나」에서 「**둘**(N3 · N8) + `talk` 여섯은 M10 미결」로
바뀌었고, §9.1에 `N8` 행이 **등급(높음)과 「범위 밖이라 회귀 집계 제외」라는 사유를 한 행에** 달고 올라왔으며,
§1의 「높음 1」도 「높음 2」로 따라 움직였다. C-2(낮음)도 `final-parity-r4.md`:162-169 **그 자리**에
인용 블록 + 표 헤더 표식으로 박혔다. **그리고 그 새 절(§9.0)이 내건 수치는 내 exe·내 계기·내 홈에서 전부 재현된다** —
원시 `app:update-{check,event,install}`는 셋 다 `{"__unimplemented":true}`이고(`install`은 나도 눌렀다 ·
호출 3초 뒤 앱 생존), 시드만 갈아 끼우면 카드가 **뜬다**(`ready` 3/3 · `downloading` 3/3 게이지까지 · 같은 계기의
`bare`는 **0/3**), 「업데이트」를 누르면 **「적용하는 중…」에서 영구 정지**하고 앱은 산다(3/3).
계약면은 **내 독립 스캐너로도 216 / 206 / missing 10**이고 목록이 **한 글자도 안 다르다**.
고친 한도 계기도 내 손에서 켜진다 — pct 42/43/44를 심으면 화면에 **58/56/57% 남음**이 뜨고(3/3),
**바로 그 화면에서 R4의 `/42|43|44/`는 false**다. 출하 차단 둘(N1·N2)도 내가 눌러 같은 값을 봤다.
게이트는 내 새 target에서 **4회 전부 161 passed · 0 failed**. **체크리스트 일곱 전부 초록 — 합격.**

**다만 새로 쓴 계보 표 한 칸이 사실과 다르다.** §9.0.1은 이 축의 계보를 「R1 높음 → R2 범위 밖 →
**R3·R4 언급 없음** → R5 초판 누락」으로 적었는데, **`final-parity-r4.md`:358은 이 셋을 이름으로 적어 놓았고**
(「남은 13 = talk 6 · lsp 3 · **app:{update-check,update-install,update-event} 3** · app:open-directory 1」)
같은 §7의 출하 표는 「높음 **1**(N3)」로 닫는다. **즉 「스캔은 셋을 세는데 판정 표는 하나만 올린다」는
이번 라운드의 그 어긋남이 R4에서 이미 한 번 났다.** 「사람이 표를 손으로 옮겨 적다 난 사고」(§10-10)로는
설명이 한 라운드 모자란다. 등급은 **낮음**(판정 수치는 안 흔들린다) — 아래 C-1.

---

## 2. 체크리스트 1·2 — 계기가 고쳐졌는가 · 각 팔 3회가 실제로 돌았는가

### 2.1 ★내 스텁 대조군 (내 exe · 내 계기 · 각 3회)

`window.api.getUsage`를 pct **42/43/44** 스텁으로 갈고 **제품 경로**(`.sb-foot`로 설정 열기 → `.smh-close`로
닫기 → `App.tsx:585`의 `getUsage(true)`)로 재조회를 태운 뒤 워크바 오른쪽 칩(`ctx`)의 팝오버를 열었다.

| 팔 | n | `prows` | 데이터 없음 | **`seesRemain`(58/57/56%)** | `seesPlanted`(42/43/44%) | **R4의 `/42\|43\|44/`** | 스텁 |
|---|---|---|---|---|---|---|---|
| 3.0 `bare` | **3** | **4** | true | ✗ 0/3 | ✗ | ✗ | — |
| **3.0 `stub`** | **3** | **5** | **false** | **✓ 3/3** | ✗ 0/3 | **✗ 0/3** | `ok` 3/3 |

내가 읽은 실제 행(run1~3 동일):

```
5시간 한도       1시간 0분 후 초기화   58% 남음
Fable 주간 한도  3일 0시간 후 초기화   56% 남음
주간 한도        3일 0시간 후 초기화   57% 남음
```

**심은 42/43/44가 화면에 58/56/57로 떴다. 그리고 그 화면에서 R4의 정규식은 false다.**
= 「고친 칸은 켜지고 옛 칸은 가설이 참이어도 못 켜진다」가 **내 손에서도 실행으로** 확인됐다(§2.3 그대로).

### 2.2 §2.4의 틀린 예측 문장 — **그 자리에** 정정됐다 (C-2 종결)

`final-parity-r4.md`:162-167에 인용 블록(「※ 이 문장은 틀렸다 — R5 §2.3 정정 … 화면에 뜨는 숫자는 58/57/56」),
**:169** 표 헤더 셀에 「42/43/44 보임<br>**(※판별력 0 · R5 §2.3)**」. **파일 중간부터 읽어도 틀린 예측을 그대로 안 읽는다.**
→ R1의 C-2는 닫혔다.

### 2.3 각 팔 3회가 파일에 실제로 있는가 (증거 직독 · 내가 파싱)

| 증거 파일 | n | 내가 읽은 칸 |
|---|---|---|
| `final-parity-r5-limitpop-{tauri,electron}-{synth,noacct}-{seeded,bare}.json` (8) | 각 **3** | `prows 4 / hasNoData true / seesRemain false / R4정규식 false` |
| `…-limitpop-tauri-stub.json` | **3** | **`5 / false / true / false`** ← 판별력 증거 · 내 §2.1과 **문자 그대로 같다** |
| `…-limitpop-electron-stub.json` | **3** | `4 / true / false / false` + `stubInstalled: THROW Cannot redefine property` = **미계측을 미계측으로 적었다** |
| `…-update-{bare,ready,downloading}.json` | 각 **3** | 아래 §4.2 |
| `…-update-262.json` | **2** | 2.6.2 핸들러 응답 |

**합 30(한도) + 11(업데이트) 주행이 파일에 있다.** 판별력 증거(스텁 대조군)는 §2.3·§2.4·§9.0.4 **세 표에** 실려 있다.

> ★내가 처음에 틀렸던 것 하나: 「9주행 raw에 `app:update-install`이 없다」고 셌는데, 그 칸은
> `raw`가 아니라 **레코드 최상위 `rawInstall`**에 있다. 다시 세니 **9/9에서 `{"__unimplemented":true}` ·
> `aliveAfterInstall: true`**다. 보고서의 「9/9」는 **사실이다.**

---

## 3. 체크리스트 3 — 출하 재판정이 **내가 눌러도** 같은 값인가

### 3.1 N1 「맨 위로」 — 내 exe · 내 합성 계정 둘 · 3회

합성 스토어 `{version:1, defaultEmail:"cr2-one@example.invalid", accounts:[one(plus), two(pro)]}` ·
설정 ▸ Account ▸ OpenAI 두 번째 행의 **「맨 위로」를 화면에서 눌렀다.**

| | run1 | run2 | run3 |
|---|---|---|---|
| 클릭 → 화면 정착(0번이 `cr2-two` + 「기본 · 맨 위」) | **10 ms** | **13 ms** | **19 ms** |
| OpenAI 목록 | **2행 유지**(증발 0) | 2행 | 2행 |
| 클릭 전 행 | `cr2-one … 기본 · 맨 위 / cr2-two … 맨 위로` | 〃 | 〃 |
| 클릭 후 행 | `cr2-two … 기본 · 맨 위 / cr2-one … 맨 위로` | 〃 | 〃 |
| **디스크** | **`[two, one]` · `defaultEmail=cr2-two`** | 〃 | 〃 |
| 실패 문구 | 없음 | 없음 | 없음 |
| 원시 `codex-auth:list-accounts` | `array:2`(비-`__unimplemented`) | 〃 | 〃 |

→ 감사의 21~23ms·`[two,one]`·`def=two`·2행 유지가 **내 손에서도 같은 방향으로 재현된다**(절대값 차이는 픽스처 크기).

### 3.2 N2 렌더 예외 부팅 — 3회 (내 픽스처: `text`가 객체인 폭탄 채팅)

| 상태 | run1 | run2 | run3 |
|---|---|---|---|
| 1 부팅(활성=멀쩡) | `eb0 sb3 win1 chat1` | 〃 | 〃 |
| 2 폭탄 선택 | **`eb1` · `sb3` · `win0` · `chat0`** | 〃 | 〃 |
| 3 사이드바 한 클릭으로 탈출 | **`eb0` · `sb3` · `win1` · `chat1`** | 〃 | 〃 |

* **감옥이 아니다** — 카드가 뜬 상태에서 사이드바 3행이 살아 있고 **한 클릭에 나온다**(3/3).
* **`win 0`도 재현된다** — 카드가 뜨는 순간 창 컨트롤이 사라진다(감사 §4.2의 정정이 옳다 · 낮음 `N6`).

**→ 출하 차단으로 걸려 있던 둘은 내 exe·내 홈에서도 풀린다.**

---

## 4. 체크리스트 4 — `missing 10`의 목록 · 그중에 출하 차단이 있는가

### 4.1 목록은 맞다 (내 독립 스캐너)

```
node cr2-channels.mjs --tree=C:\Temp\ccg-r28g-a3cr2\wt
  → total 216 · impl 206 · missing 10
missing = app:open-directory · app:update-check · app:update-event · app:update-install
          talk:bg-task · talk:cancel · talk:event · talk:permission-respond
          talk:question-respond · talk:run
```

감사의 `216 / 206 / 10`과 **총계도 목록도 완전히 같다.**
(차이 한 칸: 내 스캐너는 `app:open-directory`가 **주석에는 있다**고 따로 표시한다 —
`ipc/app_meta.rs:12` · `ipc/parity/misc.rs:84`. 감사 스캐너는 따옴표째 찾아 `commentOnly 0`으로 센다.
**판정(미구현)은 같다.**)

### 4.2 런타임 보정 — 내 exe에서 직접 눌렀다 (`chan` 팔 · `install` 포함)

| 원시 `ipc_call` | 내 결과 | 뜻 |
|---|---|---|
| `app:get-version`(양성 대조) | `"3.0.0-beta.1"` | 구현 |
| `app:update-status`(양성 대조) | `{"phase":"idle","version":null,"percent":0,"log":[],"error":null}` | 구현 — **하드코딩 idle** |
| `auth:list-accounts` · `codex-auth:list-accounts` | `[]` · `[]` | 구현 |
| **`app:update-check`** | **`{"__unimplemented":true}`** | 미구현 |
| **`app:update-event`** | **`{"__unimplemented":true}`** | 미구현(카드에 값을 넣어 줄 방출자 0) |
| **`app:update-install`** | **`{"__unimplemented":true}`** · **3초 뒤 앱 생존** | 미구현 |
| `app:open-directory` | **`{"__unimplemented":true}`** | 미구현(N3) |
| `ccg:no-such-channel-cr2`(음성 대조) | `{"__unimplemented":true}` | 없는 채널의 모양 |

> R1은 `app:update-install`을 「구현돼 있으면 앱이 꺼진다」며 안 눌렀다. 감사가 눌렀고,
> **나도 모든 측정 뒤에 눌렀다.** 같은 값·같은 생존이다. 그 칸은 이제 두 손에서 비어 있지 않다.

### 4.3 ★화면 축 스텁 대조군 — 내 계기로 다시 (3팔 × 3)

`AppUpdateGate`가 마운트 때 읽는 시드(`app.getUpdateStatus`)**만** 갈아 끼우고, **bare 팔도 똑같이 reload**한다.
내 유효 표식은 `window.__CR2_STUB`(주입 스크립트가 리로드된 문서에서만 값을 쓴다 — 빈 문서 함정 차단).

| 팔(심은 `phase`) | n | `.upd` | `button.go` | `button.later` | `.upbar` | 화면 문구 |
|---|---|---|---|---|---|---|
| **`bare`**(셸의 진짜 값 idle) | **3** | **0** | 0 | 0 | 0 | — (**카드 없음**) |
| **`ready`**(`downloaded`) | **3** | **1** | **1** | 1 | 0 | 「새 버전이 나왔어요 3.0.0-beta.1 → **9.9.9-cr2-stub** · 바로 적용돼요 · 나중에 · 업데이트」 |
| **`downloading`**(37%) | **3** | **1** | 0 | 1 | **1** | 「… · **받는 중 — 37%**」 |

**6/6 대 0/3.** 화면은 살아 있고 **방출자만 0**이다 — 감사의 §9.0.4가 내 계기에서도 그대로 선다.
(내가 심은 퍼센트는 **37**이다 — 감사의 42가 아니라. 같은 판이 다른 숫자로도 켜진다는 확인.)

「업데이트」 클릭(제품 경로 · `ready` 3/3): **`바로 적용돼요` → `적용하는 중…`으로 바뀌고 거기서 멈춘다.**
버튼 줄이 접히고(go 1→0 · later 1→0) 앱은 산다. `AppUpdateGate.tsx:107 setApplying(true)` · `:108 installUpdate()` —
보고서의 줄 번호도 맞다.

### 4.4 정적 확증 — 내가 다시 grep했다

| 감사의 주장 | 내 확인 |
|---|---|
| `ch::`에 앱 업데이트 계열 상수는 `UPDATE_GET_STATUS`(`:69`) 하나뿐 | ✔ `ipc/mod.rs:69` · `UPDATE_CHECK`·`UPDATE_INSTALL`·`UPDATE_EVENT` 상수 **없음** |
| `src-tauri` 전수에서 `app:update-event` 방출 0건 | ✔ `grep -rn "app:update-event\|UPDATE_EVENT" src-tauri crates` → **0** |
| `tauri.conf.json`에 **`plugins` 키 자체가 없다** | ✔ `grep -n plugins src-tauri/tauri.conf.json` → 0건 |
| `AppUpdateGate`는 `App.tsx:2651`에서 **항상 마운트** | ✔ `:2651 <AppUpdateGate />` · 조건 없음 |
| 2.6.2는 `index.ts:1898`(status)·`:1899`(check)·`:1900`(install) · `:2145` 방출 · `publish=github` | ✔ 네 자리 전부 그 줄에 있다 |
| 2.6.2도 개발 실행이면 `updater.ts:57·146·230`에서 일찍 반환 | ✔ 세 줄 다 `if (!app.isPackaged) return` |
| **`app:update-check`는 두 앱 어느 렌더러도 안 부른다** | ✔ `.checkForUpdate()` **호출부 0**(정의만 — 3.0 `shim.ts:560` · 2.6.2 `preload/index.ts:280`) |

### 4.5 남은 10 중 출하 차단이 있는가 — 내 판단

* **치명 0에 동의한다.** 열 채널 중 어느 것도 크래시·데이터 손실을 만들지 않는다(내 주행에서 앱은 전부 살아 있었다).
* **N8은 높음이 맞다.** 「출하된 3.0.0 사용자는 앱 안에서 새 버전을 알 수도 받을 수도 없다」는 문장이 내 실측과 일치한다.
* **차단이 아니라는 판정에는 조건을 붙인다(정보).** 2.6.2 쪽 `build.publish=github` + `electron-updater`가 살아 있으므로
  **2.6.2 사용자가 3.0으로 자동 갱신돼 넘어오면 그 뒤로는 갱신 통로가 없다**(되돌아갈 문도 앱 안에 없다).
  「첫 설치·수동 재설치는 산다」는 맞지만, **한 방향 문**이라는 성질은 표에 없다. 등급을 바꿀 근거는 아니고,
  출하 결정문에 한 줄 값하는 사실이라 여기 적는다.
* `talk` 여섯은 **M10 · 미결**(§5.2).

---

## 5. 체크리스트 5 — 게이트와 M10을 어떻게 취급했나

### 5.1 게이트 — 내 새 target에서 4회 전부 초록

```
git archive HEAD(5f3f617) → wt · CARGO_TARGET_DIR=C:\Temp\ccg-r28g-a3cr2\target-test (새 디렉터리 · 함정 11)
cargo test -p agentcodegui --bin agentcodegui   ×4
  RUN 1 → ok  161 passed; 0 failed  exit 0      RUN 3 → ok  161 passed; 0 failed  exit 0
  RUN 2 → ok  161 passed; 0 failed  exit 0      RUN 4 → ok  161 passed; 0 failed  exit 0
(함정 10대로 이 크레이트만 셌다 — 남의 미추적 계기 `probe_wfire_crit.rs`·`probe_wfr2.rs`는 `crates/ccg-engine`이라 이 수에 안 들어간다)
```

* 감사는 이 축을 **처음에 「닫혔다」로 밀어 넣지 않았다** — 기준선에서 2붉음을 그대로 적고(§5), 옆 갈래가
  고친 **뒤에** 새 트리·새 target에서 다시 재고 나서야 `G-1`을 해소로 고쳤다(§5.1). **취급이 옳다.**
* 그 해소가 HEAD에서도 유지된다는 것을 **내가 확인했다.**

### 5.2 M10 — 등급 없이 분리했다 (옳다)

`talk:*` 여섯은 치명/높음/낮음 **어디에도 없고** 「미결 · 사용자 대기」로만 §9.1에 있다.
사유도 적혀 있다(측정 계정 사망 · 등급을 매길 자격이 없다). 내 확인:

* `docs/critic/final-parity-r5-*.json` **전수 grep** → `ccg-m10-live` **0건** = 그 홈으로 아무것도 안 돌렸다는 진술과 증거가 어긋나지 않는다.
* 나도 `talk:*`를 **한 번도 안 불렀다**(엔진 기동 위험 · 남의 갈래 소유).

→ **둘 다 「닫혔다」로 밀어 넣지 않았다. 합격.**

---

## 6. 체크리스트 6·7 — 범위 · 무손상 · 코드 수정 0

| 확인 | 명령 | 결과 |
|---|---|---|
| 기준 결과 파일 무손상 | `git diff --stat -- bench/shots docs/critic bench/results` | **비어 있음** |
| 커밋의 삭제 줄 | `git show 5f3f617 --numstat` | 8파일 **+1,176 / −4** · 삭제 4줄은 전부 **자기 보고서의 산문/표 헤더**(§1 두 줄 · §9 표 한 줄 · r4 표 헤더 한 줄)이고 **데이터 파일 삭제 0** |
| 코드 수정 0 | `git show 5f3f617 --name-only` | **8파일 전부 `docs/critic/**`** — `src-tauri/`·`crates/`·`app/`·`src/`·`bench/` **0파일** |
| 남의 칸 접촉 | 같은 목록 | `final-parity-*.md` · `docs/critic/tools/**` · `final-parity-r5-update-*.json` = **AUDIT3 소유 범위 안** |
| 감사 exe 실재 | `sha256sum C:\Temp\ccg-r28g-audit\target-upd\release\agentcodegui.exe` | **`d33c3c0f…` · 6,600,704 B — 보고서 숫자와 바이트까지 일치** |
| 초판 산출물을 레포에 안 남겼다 | `C:\Temp\ccg-r28g-audit\upd-v1-flaky\` 실재 · `git status` | ✔ 레포에 없다 |
| 범위 밖 오탐 | `N8` 취급 | **회귀 집계에서 제외**하고 표에는 등급+사유로 남겼다 — 지시(「자동 업데이트 구현은 회귀로 잡지 말 것」)와 어긋나지 않는다 |
| 새 증거 파일이 실홈을 안 봤나 | `grep "C:\\Users\\User" docs/critic/final-parity-r5-update-*.json` | **0건**(홈은 전부 `C:\Temp\ccg-r28g-audit\home-upd-*`) |

→ **체크리스트 6·7 초록. 감사자는 이 라운드에도 코드를 안 만졌다.**

---

## 7. 판정표

| # | 체크리스트 | 내 실측 | 판정 |
|---|---|---|---|
| 1 | 계기가 고쳐졌는가 · §2.4 정정 | 내 스텁 3/3 → `prows 5` · 「58/56/57% 남음」 · `seesRemain=true` · **R4 정규식 3/3 false** / r4.md:162-169 **그 자리** 정정 확인 | ✅ |
| 2 | 각 팔 3회 재측정 · 판별력 증거 | 한도 10파일 × n=3 = **30** · 업데이트 3팔 × 3 = **9**(+262 2) · 스텁 대조군이 §2.3·§2.4·§9.0.4 **세 표에** 있음 | ✅ |
| 3 | 출하 재판정이 **내가 눌러도** 같은가 | N1 3/3(10~19 ms · 2행 유지 · 디스크 `[two,one]`·`def=two`) · N2 3/3(`eb1 sb3 win0` → 한 클릭 탈출) | ✅ |
| 4 | `missing 10` 목록 · 출하 차단 | **내 독립 스캐너 216/206/10 · 목록 동일** · 런타임 8채널 보정(`install` 포함) · 스텁 대조군 6/6 대 0/3 · **차단 0** | ✅ |
| 5 | 게이트·M10 취급 | 게이트 **4/4 초록 161** · M10은 등급 없이 미결 분리 · 증거 파일에 `ccg-m10-live` 0건 | ✅ |
| 6 | 범위 밖 오탐 · 기준 파일 무손상 | `git diff` 비어 있음 · 데이터 삭제 0 · N8은 회귀 집계 제외 | ✅ |
| 7 | 코드 수정 0 | 8파일 전부 `docs/critic/**` | ✅ |

**결과: 합격(7/7).** 아래 C-1·C-2는 판정 수치를 흔들지 않는 문서 정확도 결함이다.

---

## 8. 남은 결함

### C-1 〈낮음〉 새 계보 표의 「R3·R4 언급 없음」이 R4 자신의 §7과 어긋난다 — 그리고 **같은 어긋남이 R4에서 이미 났다**

* **어디**: `docs/critic/final-parity-r5.md` §9.0.1 계보 표 3행 — 「R3 · R4 | 언급 없음(그 두 라운드의 몸통이 아니었다)」.
* **사실**: `docs/critic/final-parity-r4.md`:358이 이 셋을 **이름으로** 적는다 —
  「남은 13 = `talk` 6 · `lsp` 3 · **`app:{update-check,update-install,update-event}` 3** · **`app:open-directory` 1**」.
  그런데 **같은 §7의 출하 표는 「높음 1(N3)」로 닫는다.** 즉 **「스캔은 셋을 세는데 판정 표는 하나만 올린다」가
  R5 초판의 실수가 아니라 R4에서 이미 한 번 난 패턴**이다.
* **왜 중요한가**: §10-10이 이 사고의 원인을 「사람이 표를 손으로 옮겨 적다」로 적고 기계 대조를 숙제로 남겼는데,
  **두 라운드 연속으로 같은 자리에서 났다면** 그것은 옮겨 적기 사고가 아니라 **「스캔 절과 판정 절의 소유가 갈려 있다」**는
  구조 문제에 가깝다. 처방의 우선순위가 달라진다.
* **재현(30초)**:
  1. `sed -n '340,360p' docs/critic/final-parity-r4.md` → §7 표의 「높음 **1**(N3)」과 그 아래 코드블록의 「남은 13 … update-check·update-install·update-event」를 나란히 본다.
  2. `sed -n '493,500p' docs/critic/final-parity-r5.md` → 계보 표의 「R3 · R4 | 언급 없음」.
* **처방(권고 · 나는 문서를 안 고친다)**: 그 칸을 「R4 §7 — **스캔에는 셋 다 있고 판정 표에는 없음**(같은 어긋남의 첫 발생)」으로
  고치고, §10-10의 원인 문장을 「전사 실수」에서 「스캔↔판정 표의 소유 분리」로 바꾼다.

### C-2 〈정보〉 「남은 10이 전부 표에 있다(6+1+3)」은 **채널 이름으로는 4/10**이다

* §9의 판정 칸이 「남은 10이 전부 아래 표에 있다(6 + 1 + 3)」이라고 적는데, §9.1 표 본문에 **이름으로 나오는 채널은
  `app:` 넷뿐**이다. `talk` 여섯은 **「M10(대화 연결)」 한 행**으로 묶여 있고 그 행에는 채널명이 없다(§3.3에는 있다).
* **재현**: 아래를 그대로 돌린다(§10-10이 숙제로 남긴 그 기계 대조를 지금 돌려 본 것이다).
  ```js
  const md = fs.readFileSync('docs/critic/final-parity-r5.md','utf8').split(/\r?\n/)
  const s = md.findIndex(l=>l.startsWith('### 9.1')), e = md.findIndex((l,i)=>i>s&&l.startsWith('### 9.2'))
  const blk = md.slice(s,e).join('\n')
  // → app:* 넷 IN TABLE · talk:* 여섯 ABSENT
  ```
* **처방**: 「M10」 행에 여섯 채널명을 괄호로 달거나, 숙제 10의 대조기에 **그룹 별칭**(`M10 → talk:*`)을 넣는다.
  안 그러면 그 대조기는 **자기 보고서를 첫 실행에서 붉게 만든다.**

### C-3 〈정보〉 이 크리틱이 **안 잰 것**(정직하게)

* **2.6.2를 한 번도 안 띄웠다.** §9.0.6의 「핸들러가 답한다」는 **정적 확증(§4.4)까지만** 내가 확인했고
  런타임 대조는 감사의 2주행을 그대로 뒀다. 감사 스스로 「음성 대조 못 세움 · 단독 근거 아님」이라 적어 둔 칸이다.
* **실 업데이트 왕복 0.** 패키징 빌드도, 릴리스 피드 접속도 안 했다(감사의 숙제 9와 같은 한계).
* `talk:*` 여섯은 **일부러 안 불렀다**(엔진 기동 · M10 소유).
* `cargo test --workspace` 전수 0 · 실 OAuth 왕복 0 · 블라인드 축 0 · 탐색기 동시측정 재주행 0.
* 감사의 N7(강제 종료 뒤 카드 재현)은 이번에도 **내 조건이 안 만들어져 미재현**(반박 아님).

---

## 9. 내가 만진 것

| 대상 | 무엇 |
|---|---|
| `C:\Code\AgentCodeGUI\docs\critic\r28g-audit3-critic-r2.md` | **이 판정문 하나**(신규) |
| 레포 코드(`src-tauri/`·`crates/`·`app/`·`src/`·`bench/`·`out/`·`dist/`) | **0파일 · 0줄** |
| 남의 미커밋 변경(`docs/m10-report-r7.md` 등) | **접촉 0** — `reset`·`checkout`·`stash`·`restore` **0회** |
| 남의 미추적 계기(`crates/ccg-engine/tests/probe_wfire_crit.rs`·`probe_wfr2.rs`) | 커밋 안 함 · 테스트 수 집계에서 제외(내 161은 `-p agentcodegui --bin agentcodegui`) |
| 기준 결과 파일(`bench/**` · `docs/critic/*.json`) | **덮어쓰기 0** — 내 산출물은 전부 레포 밖 |
| 실홈(`%USERPROFILE%\.agentcodegui`) | **읽기·복사·수정 0** · 계정 로그아웃·토큰 회전 **0** |
| 프로세스 | 이름 기반 kill 0 · 내가 스폰한 PID만 · 잔류 0(살아 있는 것은 사용자 설치본 5개) |

레포 밖 재현 재료: `C:\Temp\ccg-r28g-a3cr2\` — `wt`(아카이브 트리) · `target`(판정 exe) · `target-test`(게이트) ·
`tools\cr2-{channels,cdp,run,dbg}.mjs` · `home-*`(23) · `cr2-{pop,popstub,n1,n2,updbare,updready,upddl,chan,channels}.json`.

— R28g AUDIT3 확인 크리틱 R2 (Claude Fable 5)
