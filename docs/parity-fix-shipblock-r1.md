# R28f SHIPBLOCK R1 — 출하 차단 둘을 닫는다

대상: 최종 파리티 감사(`docs/critic/final-parity-r2.md` §N1·§N2)와 그 확인 크리틱
(`docs/critic/r28e-audit-critic-r1.md` §4)이 **독립적으로 재현**한 치명 둘.

- **N1** — Codex 계정 축을 통째로 못 쓴다(다섯 채널이 Rust에 없다 + 심의 안전값이 목록을 지운다).
- **N2** — 렌더 예외 하나가 앱을 못 열리게 가둔다(사이드바도 창 크롬도 없는 카드 한 장).

두 결론 먼저:

| | R28f 전(감사 실측) | R28f 후(이 라운드 실측) |
|---|---|---|
| `codexAuth.reorderAccounts(현재 순서)` | `{isArray:true, **n:0**}` → 화면 목록 증발 | `{isArray:true, **n:2**, emails:[b,a]}` |
| `codex-auth:{login,logout,login-cancel,reorder,set-default}` Rust grep | **0회** | 5/5 배선 + 블로킹 풀 |
| 「계정 추가」 4.5초 뒤 | 스피너 0 · 새 행 0 · 새 창 0 | **1.2초에 새 행 1**(스텁 CLI 왕복 · 디스크까지) |
| 예외 채팅 선택 직후 | `eb 1 · sb 0 · win 0` | `eb 1 · **sb 3** · win 1` |
| 「앱 새로고침」 뒤 | `eb 1 · sb 0 · win 0 · chat 0` (갇힘) | `eb 0 · sb 3 · win 1 · chat 1` (복구) |

---

## 1. 안전 규약 — 무엇을 하지 않았나

- 사용자 실홈(`%USERPROFILE%\.agentcodegui`)의 `accounts.json`·`codex-accounts.json`을
  **읽지도 복사하지도** 않았다. `bench/fixture.mjs`의 `makeFixtureHome`은 그 둘을 복사하므로
  (`fixture.mjs:64`) 이 라운드의 하네스는 **자기 픽스처를 처음부터 만든다**
  (`scripts/poc-shipblock.mjs`). 계정은 전부 합성(`r28f-*@example.invalid`)이다.
- **실 OAuth 왕복은 하지 않았다.** 로그인 채널은 가짜 `codex.cmd` 스텁으로 왕복했다
  (PATH 맨 앞에 스텁 폴더를 끼워 진짜 codex가 절대 안 잡히게 하고, 스텁이
  `%CODEX_HOME%\auth.json`을 쓴다). 브라우저는 한 번도 안 열렸다.
  → **실 ChatGPT OAuth 왕복은 「미검증」이다**(아래 §5).
- 2.6.2 대조군에서는 **Codex 계정 칸을 한 번도 안 눌렀다.** 그쪽
  `src/main/codex/auth.ts:20`은 `APP_HOME = os.homedir()/.agentcodegui`를 **하드코딩**해
  `CCG_HOME`을 무시한다 — 격리 홈에서 돌려도 순서 변경·삭제가 **사용자 실홈의
  `codex-accounts.json`을 쓴다**. 설정 탭도 안 열었다(`codex-auth:accounts-usage`가
  실계정 토큰을 리프레시할 수 있다). 그 축의 2.6.2 대조는 감사 R2 §N1이 이미 적었다.
- 이름 기반 kill 없음 — 내가 spawn한 PID 트리만(`killTree`).
- 이웃 갈래가 워킹트리를 고치는 중이라(`crates/ccg-engine/src/runtime.rs` ↔
  `src-tauri/src/engine/mod.rs`가 한동안 안 맞았다) 빌드·측정은 **격리 트리**에서 했다:
  `git archive HEAD` → `C:\Temp\ccg-r28f-ship\src` + 내 파일만 덮어쓰기.
  남의 미커밋 변경은 `reset`·`checkout`·`stash` 하지 않았다.

---

## 2. N1 — Codex 계정 축

### 2.1 무엇이 없었나

감사의 전수 grep 그대로였다: `codex-auth:login`·`logout`·`login-cancel`·
`reorder-accounts`·`set-default-account` 문자열이 Rust 소스에 **0회**.
도메인은 M5부터 다 있었다(`ccg_auth::codex`의 `import_account_from_dir`·`remove_account`·
`reorder_accounts`·`move_account_to_top`) — 없던 것은 **배선**이었다.

### 2.2 무엇을 했나

`src-tauri/src/ipc/accounts.rs`에 다섯을 붙였다. Anthropic 축과 **같은 파일·같은 규약**이다:

| 채널 | 하는 일 | 2.6.2 대응 |
|---|---|---|
| `codex-auth:login` | `codex login`(격리 `CODEX_HOME` = `<홈>/codex/login`) → 끝나면 그 폴더의 `auth.json`을 편입 → 임시 폴더 삭제 → **새 목록** 반환 | `src/main/codex/auth.ts:334` |
| `codex-auth:login-cancel` | 진행 중인 **그 자식만** kill | `:320` |
| `codex-auth:logout` | 계정 폴더를 `CODEX_HOME`으로 `codex logout` → 등록 제거 + 폴더 정리 → 새 목록 | `:281` |
| `codex-auth:set-default-account` | **「맨 위로 이동」**(= `move_account_to_top`) → 새 목록 | `:154`(기본 필드를 썼다) |
| `codex-auth:reorder-accounts` | 순서 저장(인덱스로 잡아 레코드를 안 잃는다) → 새 목록 | `:161` |

세 규약은 Anthropic 축에서 글자 그대로 가져왔다.

1. **실홈 불가침을 타입이 강제한다** — `CODEX_HOME`은 예외 없이
   `ccg_auth::IsolatedConfigDir`로 조립한다(앱 홈 밖 경로로는 **만들어지지 않는다**).
2. **목록을 바꾸는 쓰기는 도메인 함수 하나만 지난다** — 이 파일에 `write_store_file`
   직접 호출이 없다.
3. **자식은 우리가 스폰한 것만 죽인다** — 이름 기반 kill 없음.

세 번째를 지키려고 R28 T1T2 R2가 세운 「번호는 스폰 전에 올린다 · 마무리는 자기 번호일
때만 핸들을 놓는다」 규칙을 **타입으로** 뽑았다(`LoginSlot`). 축마다 인스턴스 하나다 —
슬롯이 한 벌이면 codex 로그인 취소가 **진행 중인 claude 로그인을 죽인다**. 출력 펌프
(`pump_login`)도 한 벌로 합쳤다: 복사했다면 「청크 단위로 읽는다」(개행 없이 멈추는 CLI)
같은 실측 규약이 두 벌이 되고, 다음 라운드에 한쪽만 고쳐진다.

`codex_command` 하나가 새로 필요했다 — `.exe`·`.com`이 아닌 확장자는 `cmd /C`를 경유한다
(codex는 전역 npm 설치에서 `codex.cmd` 셰임으로 앉는다. 2.6.2가 `shell:true`를 쓰던 이유).
판정 규칙은 `ccg_engine::codex::driver`의 `needs_shell`과 같은 것을 옮겨 적었다 —
그 함수는 인자가 `app-server` **고정**이라 로그인·로그아웃에 못 쓰고, 그 크레이트는 이
라운드의 경계 밖이다(WFIRE 소유).

### 2.3 「기본 계정」 채널을 어떻게 처리했나 — **재정렬로 흡수**

요구 (2)의 선택. 근거 셋(장부 §6.5에 같은 내용을 적었다):

1. 같은 홈을 여는 **2.6.2 렌더러(동결)** 가 아직 이 채널을 부른다. 거기서 「기본으로」를
   누르면 3.0에서도 같은 결과(그 계정이 맨 위 = 기본)가 나와야 한다.
2. Anthropic 축이 이미 이 선택을 했다(`auth:set-default-account` = 맨 위로). 두 축이 같은
   이름의 채널에서 다르게 굴면 장부가 두 벌이 된다.
3. no-op은 **성공처럼 보이는 실패**다 — 렌더러는 새 목록을 받아 그대로 그리므로 아무 표시
   없이 순서만 안 바뀐다. 이 라운드가 닫는 병과 정확히 같은 모양이다.

**장부·주석 정정.** `docs/renderer-divergence.md` §6.5의 *"3.0 화면은 안 부른다
(`reorderAccounts`로 같은 결과를 저장한다)"* 와 `Settings.tsx`의 *"결과는 같고, 실제로
저장된다"* 는 **둘 다 거짓이었다**(재정렬 채널에도 핸들러가 없었다). 장부에 그 사실과
정정을 적었고, 3.0 화면의 「맨 위로」는 이제 Anthropic 축과 같은 채널
(`codexAuth.setDefaultAccount`)을 부른다. 꾹-드래그·정렬 버튼은 그대로 `reorderAccounts`다
(순서 전체를 옮기는 조작이라 채널도 그쪽이 맞다).

### 2.4 ★구조적 처방 — 심의 안전값이 목록 setter에 앉던 자리

요구 (3). 사고의 기전은 채널 다섯이 아니라 **번역**이었다:

```
codexAuth.reorderAccounts(현재 순서) → {__unimplemented:true} → 심이 [] 로 갈음
  → setCxAccounts([]) → 화면의 OpenAI 계정이 통째로 사라진다
  → 호출부의 catch는 reject일 때만 도니 영원히 안 돈다(안내 문구 0개)
```

`app/src/api/shim.ts`에 문을 하나 더 뒀다 — **`callStrict`**: 미구현·IPC 실패를
`ShimUnavailableError`(어느 채널인지 들고 있다)로 **reject**한다. 조회는 그대로 `call`이다
(그 문을 조회까지 넓히면 목록 하나가 없다고 설정 화면이 통째로 죽는다 = M1이 `call`을
만든 이유). 「빈 배열이면 갈아끼우지 않는다」 가드를 안 고른 이유: **마지막 계정을 삭제하면
`[]`가 정당한 결과**라 그 가드는 진짜 빈 목록을 못 그리게 만든다. 실패를 실패로 올리면
가드가 필요 없다.

호출부 짝(`app/src/components/Settings.tsx`): 계정 쓰기의 `catch`가 **예외 없이**
`setNote(...)`를 세운다 — 추가·삭제·맨 위로·꾹드래그·정렬 버튼 전부(R1까지는 대부분
`/* ignore */`였고, 심이 안 던졌으니 티가 안 났다).

**실측**(`scripts/poc-shim-strict.mjs` — `invoke`를 스텁으로 갈아끼워 `{__unimplemented}`만
돌려주는 판):

| | 조회 4종(`listAccounts`·`accountsUsage`·`auth.login`) | 쓰기 8종(`auth`·`codexAuth`) |
|---|---|---|
| HEAD(옛 심) | resolve `array:0` | **resolve `array:0`** ← 실패가 빈 목록으로 번역된다 |
| R28f | resolve `array:0` (회귀 없음) | **reject `ShimUnavailableError` + channel** |

IPC 자체가 던지는 판(`ipc dead`)도 같은 결론이다: 쓰기는 reject, 조회는 안전값.

### 2.5 화면에서 눌러 잰 것 (`scripts/poc-shipblock.mjs` · tauri)

```
[codex-channels] raw: cancel=null · setDefault=array:2 · reorder=array:2   (__unimplemented 0회)
                 reorderReturns: {ok:true, isArray:true, n:2, emails:[a,b]}
[codex-move-top] 화면 「맨 위로」 클릭 → 행 2개 유지 · 화면 [b,a] · 디스크 [b,a]   ← 실제로 저장된다
[codex-login]    「계정 추가」 클릭 → 1215ms 뒤 화면 3행 · 디스크 3개
                 loginUrls: ["https://auth.openai.com/r28f-stub-login"]     ← 폴백 링크 방출 확인
                 stubLog:   ["login C:\\Temp\\...\\home-tauri-single-r2\\codex\\login"]  ← 격리 CODEX_HOME
[codex-delete]   합성 계정만 삭제 → 화면·디스크 둘 다 2개로
```

- `stubLog`의 `CODEX_HOME`이 **앱 홈 아래 `codex/login`**이다 = 실홈으로 새지 않았다.
- 로그인이 1.2초에 끝나 「로그인 진행 중…」 카드는 측정 시점에 이미 사라졌다
  (`busySpinner:0`·`loginCard:0`). 감사가 잰 「4.5초 = 스피너 0·새 행 0」과 다른 사실이다 —
  그때는 **아무 일도 안 일어났고**, 지금은 **끝나 있었다**(새 행 1 + 디스크 반영).
- 결과 파일: `docs/critic/shipblock-r2-tauri-single.json`.

---

## 3. N2 — 렌더 예외에서 나올 수 있는가

### 3.1 왜 즉시 영속을 안 미뤘나

두 가지 이유다.

1. **계약이다.** `chats:set-active`는 M-UX §6.2 U3의 자리다 — 별칭 계층(`claude:*` →
   `chat:*`)은 인자에 `chatId`가 없어 「그 순간의 활성 채팅」으로 실행을 라우팅한다.
   미루면 "전환 직후 전송"이 남의 `ChatRuntime`(정체성·큐·라이브 원장·계정 CONFIG_DIR)에
   붙는다. `chats_v3`의 `activeGen` 단조 카운터(R2 D13)도 그 계약 위에 서 있다.
2. **미뤄도 이 감옥은 안 풀린다.** 「앱 새로고침」은 `window.location.reload()` = **웹뷰만**
   다시 그린다. 셸(Rust) 프로세스는 살아 있고 활성 채팅의 진실이 그 메모리에 남아 있어
   부팅 페이로드가 같은 채팅을 되돌려준다. 2.6.2가 복구되는 것은 그쪽이 **다른 프로세스
   모델**(렌더러가 진실을 들고 디바운스 저장)이기 때문이지 "미뤄서"가 아니다.

그래서 **탈출구 둘**을 골랐다(장부 §6.8).

| # | 무엇 | 무엇을 잃나 |
|---|---|---|
| ① 본채팅 워크스페이스가 **자기 경계**를 갖는다 | 예외가 거기서 잡히면 왼쪽 칼럼과 창 크롬은 경계 **밖**이라 그대로 산다 | 앱 루트 경계는 **그대로 남는다**(사이드바·모달의 예외는 여전히 그쪽) — 경계를 옮긴 게 아니라 하나 더 놓았다 |
| ② 부팅 격리(1회 소비) | 렌더를 넘어뜨린 채팅 id를 적어 두고, 다음 부팅이 그 채팅을 활성으로 잡으려 하면 다른 대화로 착지 | 그 한 번의 부팅에서 「마지막에 보던 대화」가 아니라 옆 대화로 열린다. 영구 블랙리스트가 아니다 — 표식은 읽는 즉시 지워지고 사이드바에도 그대로 있다 |

`ErrorBoundary`에 붙은 prop은 둘 뿐이다: `resetKey`(값이 바뀌면 경계가 스스로 풀린다 —
사이드바에서 다른 대화를 고른 그 클릭 하나로 나온다. 「다시 시도」를 또 누르게 하지 않는다)와
`onError`(호스트가 "무엇이 터졌나"를 안다 = ②의 유일한 재료).
**이 파일은 여기까지 두 앱이 바이트 동일이었다** — 감사 §N2가 그 사실을 근거로 삼았으므로
장부 §1 표에 정정을 적었다.

### 3.2 두 앱을 나란히 눌러 다시 잰 표

`scripts/poc-shipblock.mjs` — 같은 픽스처(3채팅: 긴 스레드·빈 채팅·예외 채팅)·같은 순서·
같은 조작(탐색기 닫기 → 예외 채팅 선택 → 카드의 「앱 새로고침」 **실제 클릭** → 재접속).

```
                       선택 직후                  사이드바로 탈출     「앱 새로고침」 뒤
 3.0 (R28f)   eb 1 · sb 3 · win 1 · chat 0   eb 0 · chat 1   eb 0 · sb 3 · win 1 · chat 1
 2.6.2        eb 1 · sb 0 · win 0 · chat 0   (항목 없음)      eb 0 · sb 3 · win 1 · chat 1
 3.0 (R28f 전 — 감사 R2)  eb 1 · sb 0 · win 0            —      eb 1 · sb 0 · win 0 · chat 0
```

- 디스크의 `activeChatId`: 3.0은 선택 직후 `fix-boom`(즉시 영속은 그대로 산다) →
  새로고침 뒤 `fix-long-thread`(격리가 착지를 옮겼다). 2.6.2는 내내 `fix-long-thread`.
- `stuck`(eb>0 && sb==0) — 3.0 **false**, 2.6.2 false.
- **선택 직후만 보면 3.0이 2.6.2보다 낫다**(sb 3 vs 0): 2.6.2는 그 순간 크롬이 통째로
  사라지고 새로고침 말고는 길이 없다. 3.0은 사이드바가 남는다.
- 결과 파일: `docs/critic/shipblock-r2-tauri-single.json` ·
  `docs/critic/shipblock-r2-electron-single.json`.

### 3.3 「다른 문」 — 설정·멀티 보드도 같은 감옥인가

- **멀티 보드**: `--boot=multi`(0번 패널이 렌더 예외를 던지는 보드로 부팅) 실측 —
  3.0 `eb 1 · sb 6 · win 1`, 2.6.2 `eb 1 · sb 4 · win 1`, **둘 다 사이드바로 탈출 성공**.
  멀티는 원래 안 갇힌다(자기 경계가 이미 있었다 — 그래서 본채팅에 같은 처방을 놓았다).
  결과 파일: `docs/critic/shipblock-r2-{tauri,electron}-multi.json`.
- **설정 모달**: `settingsOpen`은 `useState(false)`이고 어떤 pref에도 안 실린다
  (`App.tsx:325` · 그 파일의 `setPref` 호출 목록에 없다). 새로고침은 언제나 **닫힌 채로**
  착지하므로 부팅 루프가 성립하지 않는다. 그리고 설정에서 난 예외는 앱 루트 경계가
  받으므로 크롬이 사라지는데, 그 상태의 탈출구가 바로 「앱 새로고침」이다.

---

## 4. 초록 상태

| 검사 | 결과 |
|---|---|
| `npm run typecheck` (node·web) | 초록 |
| `npm run typecheck:app` | 초록 |
| `cargo test --bins` (`agentcodegui` 크레이트, 격리 트리) | **152 passed · 0 failed** |
| `scripts/poc-shim-strict.mjs` | `readsAllResolve:true · writesAllReject:true` (HEAD 대조군은 `writesAllReject:false`) |

`agentcodegui` 크레이트에 이 라운드가 더한 테스트 둘 · 고친 테스트 둘:
`the_write_channels_of_both_axes_are_all_claimed`(다섯 채널이 블로킹 풀 소유인지) ·
`arg_readers_are_total` · `cancelling_with_no_login_in_flight_is_a_no_op`(두 슬롯이 **따로** 취소된다) ·
`a_finishing_login_never_takes_the_next_ones_handle`(축이 서로의 시도를 무효화하지 않는다).

---

## 5. 미완 · 정직하게 남기는 것

1. **실 ChatGPT OAuth 왕복은 미검증이다.** 스텁 `codex.cmd`로 잰 것은 ①스폰 ②격리
   `CODEX_HOME` ③URL 방출 ④`auth.json` 편입 ⑤목록·디스크 반영 ⑥삭제 왕복이다.
   진짜 `codex login`의 출력 모양이 스텁과 다를 수 있는 자리는 하나 — URL 추출
   (`verify::extract_login_url`은 https만 잡는다. codex가 먼저 뱉는
   `http://localhost:1455.`를 거르는 그 규칙은 2.6.2가 실측으로 세웠고 3.0이 같은 함수를
   쓴다). 사용자 실계정으로 로그인을 시도하지 않는다는 규약을 지켰다.
2. **로그인 취소(`codex-auth:login-cancel`)의 「진짜 kill」은 채널 응답까지만 쟀다**
   (raw 호출이 `null`). 스텁이 1초 안에 끝나 취소를 걸 창이 없었다. 규칙 자체
   (자기 자식만·번호 소유권)는 유닛 테스트가 잰다.
3. **`cmd /C` 경유 로그인의 취소는 손자 프로세스를 남길 수 있다** — `cmd.exe`를 죽여도
   그 아래 codex는 남는다. 2.6.2도 같다(`shell:true`). 앱이 관리하는 설치본은 네이티브
   `.exe`라 이 갈래를 안 탄다(전역 npm 셰임 사용자만 해당). 이번 라운드에서 안 고쳤다 —
   고치려면 Job Object가 필요하고 그건 이 조각의 경계 밖이다.
4. **부팅 격리는 `localStorage`에 산다.** 저장소가 막힌 환경(사생활 모드 등)에서는 표식이
   안 써지고, 그러면 탈출구 ①(자리 단위 경계)만 남는다 — 그래도 갇히지는 않는다.
5. **빌드·측정은 격리 트리에서 했다.** 이웃 갈래(WFIRE)가 `ccg_engine::runtime::ReloadHold`에
   칸 둘(`attempts`·`fires`)을 더하는 중이라 공용 워킹트리가 **때에 따라 컴파일되지 않는다**
   (`src-tauri/src/engine/mod.rs:163`이 앞서 갔다 되돌아갔다 한다 — 그 셋 다 내 경계 밖이다).
   그래서 exe 빌드·테스트·화면 실측은 `git archive HEAD` + **내 파일만** 얹은
   `C:\Temp\ccg-r28f-ship\src`에서 했다.
   공용 트리 확인은 커밋 직전 두 번:
   `cargo check --features custom-protocol` **초록**(이웃 트리가 맞아떨어진 창) ·
   `cargo test --bins`는 **이웃의 미커밋 코드에서** 실패
   (`ReloadHold has no field named attempts` — `src-tauri/src/engine/mod.rs:163`, 내 파일 아님).
   즉 **내 변경이 이웃의 최종 형태와 함께 컴파일되는지는 그쪽이 착지한 뒤에 다시 봐야 한다.**
