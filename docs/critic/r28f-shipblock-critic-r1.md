# R28f SHIPBLOCK 확인 크리틱 R1 — 출하 차단 둘은 내 손에서도 닫혔다. 그런데 「취소」를 누르면 계정 탭이 5분간 얼어붙는다

판정 대상: `efdc08c` + `521221d`(R28f SHIPBLOCK R1 본체·잔손질).
규율대로 **빌더의 보고서·커밋 메시지·하네스를 근거로 쓰지 않았다** — 계기를 새로 쓰고(레포 밖
`C:\Temp\ccg-r28f-shipcrit\tools\*.mjs`), exe를 새로 굽고, 격리 홈에서 눌러 쟀다.
대조군은 **새 CARGO_TARGET_DIR**에서 따로 구웠다(재활용 금지 — R28d 실증).

---

## 1. 무엇으로 쟀나

| 자리 | 값 |
|---|---|
| 판정 대상 트리 | `git archive 521221d` → `C:\Temp\ccg-r28f-shipcrit\src` (미커밋 이웃 변경 **없음**) |
| 판정 대상 exe | `C:\Temp\ccg-r28f-shipcrit\target-r28f-ship-crit\release\agentcodegui.exe`<br>sha256 `8943d4b52e3077a3de5dbfa3b62312013b773b0de9405653e9a2f7449340a238` · `cargo build --release --features custom-protocol` |
| 대조군 트리/exe (R28f **전**) | `git archive 0ec5105`(=`efdc08c~1`) → `…\ctl` · `…\target-ctl-crit\…\agentcodegui.exe`<br>sha256 `e703eda10ad7c4e8e625e33fbb6dc09bc52a059cc5940adc916c0de7608f19e7` |
| **파괴 대조군**(요구 3용) | `521221d`에서 `ipc/accounts.rs`의 `CODEX_SET_DEFAULT_ACCOUNT` 팔 **한 개만 제거** → `…\target-sab-crit\…\agentcodegui.exe`<br>sha256 `d338c4f6bc5a3e45632a7356729c388c7a9dcaa9fc6768d5daaa83940cc76c62` |
| 2.6.2 대조군 | `node_modules/electron/dist/electron.exe` + `out/main/index.js` md5 `5d4356fd84ca42ee6411289ac7167f7c` (package.json 2.6.2) |
| 프런트 | 세 exe 모두 자기 트리에서 `npm run app:build` 후 임베드 — 판정 exe 안에 내 번들 이름 `index-Cdw2_OEf.js` 1회 확인(= devUrl 로드본이 아니다) |
| CCG_HOME | `C:\Temp\ccg-r28f-shipcrit\home-*` (실홈에서 **한 바이트도 복사 안 함**, 계정은 전부 `@crit.invalid` 합성) |
| CDP 포트 | 10570~10595 (SHIPBLOCK 10520 + 50 대역) |
| 가짜 CLI | 내가 쓴 `codex.cmd`(셰임 갈래)와 내가 컴파일한 `codex.exe`(네이티브 갈래) — PATH 맨 앞 |
| 안전 | 이름 기반 kill 0회(내 PID 트리만) · `CCG_NO_NET=1` 기본 · **2.6.2 주행은 `USERPROFILE`을 빈 임시 폴더로 갈아끼웠다**(그쪽 `src/main/codex/auth.ts:20`이 `os.homedir()`를 하드코딩해 실홈을 쓰므로) |

주: 주행 중 레포 HEAD가 `521221d` → `dc454e4` → `d461f21`로 움직였다(AUDIT·WFIRE 착지).
내 측정은 전부 `521221d` 아카이브에 고정돼 있다. 대조군과의 코드 차이는
`git diff 0ec5105 521221d -- app src-tauri crates src` = **SHIPBLOCK 파일 7개 + CASX2 테스트 1개**뿐이다.

---

## 2. 체크리스트 항목별 실측

### (1) N1 화면 재현 — 「맨 위로」

| | 대조군(R28f 전) | **판정 대상(R28f)** |
|---|---|---|
| 클릭 후 화면 OpenAI 목록 | **0행 (증발)** | `[crit-two, crit-one]` 2행 |
| 디스크 `codex-accounts.json` | `[one, two]` (**안 바뀜**) | `[two, one]` + `defaultEmail: crit-two` |
| 안내 문구 | 없음 | (성공이라 없음 — 실패 시는 (3)) |
| 콘솔 | `[shim] codex-auth:reorder-accounts — 백엔드 미구현` | 없음 |

「계정 추가」·「삭제」도 눌렀다(판정 대상): 새 행 **785ms**(다른 주행 266·1045ms)에 도착 + 디스크 3개,
`auth:login-url` 폴백 링크 1건 수신, 스텁 로그의 `CODEX_HOME =
<격리홈>\codex\login`(실홈으로 안 샌다). 삭제 → 화면·디스크 둘 다 2개로 복귀.
대조군은 같은 클릭에서 15.7초 동안 **스피너 0·새 행 0·디스크 변화 0·문구 0**.

`--nonet=0`(CLI를 실제로 띄우는 주행): 스텁 로그
`login|…\codex\login` → `app-server|…\accounts\<slug>` → `logout|…\accounts\<slug>`.
로그아웃 CLI가 **그 계정 폴더를 CODEX_HOME으로** 진짜 뜬다.

`--nocli=1`(PATH에서 codex 칸만 정확히 제거): 목록 2행 **유지**, 문구
`"codex 실행 파일을 찾지 못했어요"`. 「눌렀는데 아무 일도 안 일어난다」가 아니다.

### (2) N1 원시 호출 · 채널 전수

원시 `ipc_call`(내 화면에서 직접):

| 채널 | 대조군 | 판정 대상 |
|---|---|---|
| `codex-auth:login-cancel` | `__unimplemented` | `null` |
| `codex-auth:set-default-account` | `__unimplemented` | `array:2` |
| `codex-auth:reorder-accounts` | `__unimplemented` | `array:2` |
| `codex-auth:logout` | `__unimplemented` | `array:2` |
| `codex-auth:list-accounts` | `array:2` | `array:2` |

`docs/critic/tools/critic-r28e-channels.mjs`를 내가 두 트리에 돌렸다(계약면 216채널):

```
대조군(0ec5105)  impl 198 · missing 18
판정대상(521221d) impl 203 · missing 13     ← 줄어든 5는 정확히 codex-auth 다섯
```

남은 13: `talk:{run,cancel,permission-respond,question-respond,bg-task,event}` ·
`lsp:{pick-verse-server,set-verse-path,clear-verse-path}` ·
`app:{update-check,update-install,open-directory,update-event}`.

### (3) 구조적 처방 — **일부러 미구현으로 만든 채널**로 검증

앱 안에서 `window.__TAURI_INTERNALS__.invoke`를 갈아끼우는 방법은 **불가능**했다
(`writable:false, configurable:false` — 내 탐침 실측). 그래서 셸을 파괴한 exe를 따로 구웠다
(`CODEX_SET_DEFAULT_ACCOUNT` 팔 **하나만** 제거 = 그 채널만 진짜로 `__unimplemented`).

| | 대조군(옛 심 + 미구현) | **파괴 대조군(새 심 + 미구현)** |
|---|---|---|
| 「맨 위로」 클릭 후 목록 | **0행** | **2행 유지**(서버 순서로 복원) |
| 문구 | 없음 | `"순서를 바꾸지 못했어요 — 앱을 재시작한 뒤 다시 시도해 주세요"` |
| 콘솔 | `[shim] … 미구현` | `[shim] … 미구현` (같음) |
| 디스크 | 안 바뀜 | 안 바뀜 |

**빈 배열이 목록 setter에 앉지 않는다**는 요구는 실측으로 닫혔다.
`callList` 갈래(배열이 아닌 `{error}`)도 `--nocli=1` 주행에서 사유 문장이 그대로 화면에 떴다.

**「다른 목록 화면에도 걸려 있는가」 → 아니다.** 심의 strict 문은 계정 쓰기 8채널 전용이고,
나머지는 그대로 안전값이다. 아직 미구현인 채널을 화면 API로 불러 봤다(판정 대상 exe):

| 호출 | 결과 | 사용자에게 |
|---|---|---|
| `lsp.pickVerseServer()` | **resolve `null`** | 「Verse 서버 고르기」가 **아무 말 없이 아무 일도 안 한다** = N1과 같은 모양 |
| `app.checkForUpdate()` / `installUpdate()` | resolve(void) | 조용한 no-op |
| `lsp.setVersePath()` / `clearVersePath()` | resolve `{ok:false,error:"unimplemented"}` | 카드에 오류가 보인다(괜찮은 쪽) |

### (4) N2 두 앱 나란히 — 다섯 값

같은 픽스처(`crit-good`·`crit-plain`·`crit-boom`, 활성=`crit-good`), 같은 순서로 눌렀다.
`crit-boom`은 `text`가 객체라 자식 렌더에서 던진다.

| 상태 | **3.0(R28f)** | 3.0(전·대조군) | 2.6.2 |
|---|---|---|---|
| 폭탄 채팅 선택 직후 | eb 1 · **sb 3** · **win 1** · chat 0 · disk `crit-boom` | eb 1 · sb 0 · win 0 · chat 0 · disk `crit-boom` | eb 1 · sb 0 · win 0 · chat 0 · disk `crit-good` |
| 사이드바로 탈출 | **가능** → eb 0 · chat 1 | 불가(사이드바 없음) | 불가(사이드바 없음) |
| 「앱 새로고침」 직후(탈출 시도 **없이**) | eb 0 · sb 3 · win 1 · chat 1 · disk `crit-good` | **eb 1 · sb 0 · win 0 · chat 0 · disk `crit-boom`** | eb 0 · sb 3 · win 1 · chat 1 · disk `crit-good` |
| 프로세스 재시작 ×2 | eb 0 · 복구 | **영구 감옥**(2회 다 eb 1·sb 0·win 0) | eb 0 · 복구 |

즉 대조군은 새로고침·재시작 어느 쪽으로도 **영영 못 나온다**(감사 §N2 재현 성공).
판정 대상은 다섯 칸 전부 2.6.2 이상이다 — **2.6.2보다 열등한 칸은 없다**(선택 직후 sb 3 vs 0으로 오히려 낫다).
`localStorage` 표식은 새로고침에서 읽히자마자 `null`이 됐다(1회 소비 확인).

### (5) 다른 문

* **멀티 보드**(0번 패널이 던진다): 3.0 R28f `eb 1·sb 6·win 1` → 사이드바 탈출 성공 /
  3.0 전(대조군) **똑같이** `eb 1·sb 6·win 1` → 탈출 성공 / 2.6.2 `eb 1·sb 4·win 1` → 탈출 성공.
  세 판 다 원래 안 갇힌다 = 이 라운드가 고친 것이 아니고, 고칠 것도 없었다(빌더 주장과 일치).
* **설정 모달**: 설정을 연 채로 디스크를 읽으니 `ui-prefs.json`의 키는
  `["workspace.mode","explorer.swap","chat.zoom","sidebar.autohide","whatsnew.seenVersion","ui.lang"]`
  — 모달 상태가 어떤 pref에도 안 실린다 = 새로고침이 언제나 닫힌 채로 착지한다(부팅 루프 불가). 주장 확인.

### (6) N2가 무엇을 잃었는가

* **재시작 후 활성 복원**: 정상 채팅(`crit-plain`)을 고르고 재시작 → `crit-plain`으로 착지, 디스크도 같음. 산다.
* **창 간 활성 채팅 동기화(별칭 계층의 진실 소스)**: 부팅 격리가 고른 채팅도
  `landActiveChat` → `chats:set-active`를 그대로 지난다. 내가 잰 9개 상태 전부에서
  **디스크(셸)의 activeChatId == 화면이 착지한 채팅**이었다(탈출 직후·새로고침 뒤·재시작 뒤 포함).
  즉 격리가 셸 몰래 다른 채팅을 그리는 상태를 만들지 않는다.
* 즉시 영속(U3)은 그대로다 — 폭탄 채팅을 고른 순간 디스크가 `crit-boom`으로 바뀐다(3.0만 그렇다).

### (7) 무회귀

| 검사 | 결과 |
|---|---|
| `cargo test --workspace`(내 격리 트리·내 target) | **771 passed / 0 failed** — 크레이트별: agentcodegui(src-tauri) **152** · ccg-auth 141 · ccg-engine 228 · ccg-fs 101 · ccg-lsp 59 · ccg-store 90 |
| `npm run typecheck`(node·web) | 초록 |
| `npm run typecheck:app` | 초록 |
| `poc-account-switch`(내 exe · `--out=-shipcrit-all`) | **PASS 6/6** (pick·none·off·dirty·chain·toggle — toggle은 설정 ▸ Account 탭을 실제로 누른다) |
| 콜드 부팅 A/B(같은 픽스처 4회씩, 중앙값) | mount 350ms(전) → **357ms**, ready 544ms(전) → **517ms** — 회귀 없음 |

### (8) 장부 정직성

`docs/renderer-divergence.md` §6.5의 거짓 두 문장(*"3.0 화면은 안 부른다"* / *"reorderAccounts로
같은 결과를 **저장한다**"*)은 정정됐고, 정정문이 **왜 거짓이었는지**(두 채널 다 핸들러가 없었다)까지
적혀 있다. `set-default-account = move_account_to_top` 선택의 근거 셋도 적혀 있다.
그 선택은 내 디스크 실측으로도 무해하다 — `write_store_file(_, None)`이 `defaultEmail`을
**맨 위 계정으로 다시 쓰므로**(내 홈: `defaultEmail: crit-two` = accounts[0]) 같은 홈을 여는 2.6.2가
읽는 `defaultEmail`과 3.0의 「맨 위」가 갈리지 않는다.
§1 표의 md5 주장(`6f1115813f09eac2936de557eec34448`)도 내가 확인했다 — R28f 직전의
`app/src/components/ErrorBoundary.tsx`와 `src/renderer/…/ErrorBoundary.tsx`가 정말 바이트 동일이었다.
(사소: §1은 "선택 prop 둘 추가"라고만 적었는데 실제로는 `getDerivedStateFromProps`라는
라이프사이클이 하나 늘었다. §6.8에는 그 뜻이 적혀 있다.)

---

## 3. 남은 결함

### A. 〈중〉 codex 로그인 「취소」가 `.cmd` 셰임 경로에서 **화면을 안 푼다** — 최대 5분

빌더가 「미완 2·3」으로 남긴 자리를 내가 쟀다. 결과는 「손자 프로세스가 남을 수 있다」보다 나쁘다.

| 갈래 | 취소 후 스피너 | 계정 탭 버튼 | 손자 |
|---|---|---|---|
| 가짜 `codex.exe`(앱 관리 설치본) | **1009ms에 사라짐** | 전부 다시 활성 | 없음 |
| 가짜 `codex.cmd`(전역 npm 셰임) | **90초 관측 내내 spin=1** | 「계정 추가」·「삭제」 **전부 disabled**(Anthropic 축까지) | `PING.EXE`가 **앱 종료 뒤에도 생존** |
| 2.6.2(같은 셰임) | 90초 내내 spin=1 | 같음 | 같음 |

기전: `codex_command`가 `.cmd`를 `cmd /C`로 감싼다 → 취소는 `cmd.exe`만 죽인다 →
손자가 stdout/stderr 파이프를 **상속한 채 살아 있다** → `pump_login`의 완료 판정이
**파이프 EOF(`RecvTimeoutError::Disconnected`)** 하나뿐이라 깨어나지 못한다 →
`codex-auth:login` IPC가 `timeout_ms = 5분`까지 안 돌아온다 → 렌더러 `busy`가
`'codex-login'`에 묶인다(`disabled={busy != null}`이 두 축 버튼 전부에 걸려 있다).
2.6.2는 `child.on('close')`로 깨는데 그쪽도 stdio가 닫혀야 하므로 **같이 얼어붙는다 = 파리티**.
셸 자체는 안 막힌다(취소 뒤에도 `reorderAccounts`가 정상 resolve).

재현:
```
node C:\Temp\ccg-r28f-shipcrit\tools\cancel2.mjs --mode=cmd --port=10593   # 셰임 → 안 풀림
node C:\Temp\ccg-r28f-shipcrit\tools\cancel2.mjs --mode=exe --port=10594   # 네이티브 → 1009ms
```
(스텁 `codex.cmd`가 `ping -n 600`으로 90초 이상 끌게 만든 판. 산출물 `cancel2-{cmd,exe}.json`)

회귀는 아니다(2.6.2 동일). 다만 **이 라운드가 새로 쓴 코드**의 자리다 —
`codex_command`의 `cmd /C` 갈래와 `pump_login`의 EOF 완료 판정이 둘 다 R28f 산물이고,
「자식 종료를 별도로 기다린다」 한 줄이면 화면은 풀린다(손자 청소는 Job Object가 따로 필요).

### B. 〈하〉 부팅 격리 표식이 **하드 킬 몇 초 안에는 디스크에 못 내려간다**

| 폭탄 채팅이 활성인 채로… | 다음 부팅 |
|---|---|
| 렌더 예외 직후 ~5초에 강제 종료 | **다시 카드**(eb 1) — 3부팅 연속 재현 |
| 예외 뒤 30초 대기 후 강제 종료 | 탈출(eb 0, active=`crit-good`) |
| 창을 정상적으로 닫음 | 탈출(eb 0) |

표식이 `localStorage`(Chromium LevelDB, 지연 플러시)라 그렇다. **감옥은 아니다** —
어느 판에서든 `sb 3 · win 1`이라 사이드바로 나갈 수 있고, 그게 이 라운드 처방 ①이다.
재현: `node C:\Temp\ccg-r28f-shipcrit\tools\n2boot.mjs --port=10583` (대기 없음) vs `--hold=30000`.

### C. 〈하〉 구조 처방의 사거리 — 미구현 13채널은 아직 「침묵으로 번역」된다

특히 `lsp:pick-verse-server`는 심이 `null`로 resolve해 설정 ▸ LSP의 「Verse 서버 고르기」가
**아무 문구 없이 아무 일도 안 한다**(위 (3) 표). N1이 닫은 병과 문자 그대로 같은 모양이고,
같은 처방(`callStrict`/`callList`)이 그 자리엔 안 걸려 있다. 사용자 도달 빈도가 낮아 등급은 하.
재현: 앱에서 `window.api.lsp.pickVerseServer()` → `null`(reject 아님).

### D. 〈참고〉 `doCodexMoveTop`의 catch만 `failNote(e)`를 안 쓴다

셸이 실어 보낸 사유(`ShimUnavailableError.detail`)가 그 자리에서만 버려지고 고정 문구가 뜬다
(다른 다섯 자리는 detail을 그대로 보여 준다). 사용자에게 문구는 뜨므로 결함이라기보다 비대칭.

---

## 4. 내가 만진 것

* **레포 수정 0.** 소스·설정·하네스 어느 것도 안 고쳤다. 내 계기는 전부 레포 밖
  `C:\Temp\ccg-r28f-shipcrit\tools\`(`k.mjs`·`n1.mjs`·`n2.mjs`·`n2boot.mjs`·`probe.mjs`·`probe2.mjs`·
  `cancel2.mjs`·`cancel3.mjs`·`ab.mjs`)에 있고, 산출물도 그 아래 `*.json`이다.
* 파괴 대조군은 레포가 아니라 `C:\Temp\ccg-r28f-shipcrit\sab`(아카이브 사본)에서 한 팔을 뺐다.
* 레포에 **새로 생긴 파일 둘**은 `poc-account-switch`가 규약대로 남긴 것이다(기준 파일 보호를 위해
  `--out` 접미사를 줬다): `docs/critic/m11-r1-switch-shipcrit.json` ·
  `docs/critic/m11-r1-switch-shipcrit-all.json`. 커밋하지 않는다.
* 커밋하는 파일은 이 판정문 하나(`docs/critic/r28f-shipblock-critic-r1.md`).
* 사용자 실홈(`%USERPROFILE%\.agentcodegui`)은 읽지도 복사하지도 않았다. 이름 기반 kill 0회.

---

## 5. 판정

**출하 차단 2건은 진짜로 닫혔다.**
N1은 대조군에서 「목록 증발 + 문구 0」을 내 손으로 재현했고, 판정 대상에서 다섯 채널이 전부 살아
화면·디스크가 같이 움직이는 것을 봤다. 구조 처방은 **일부러 부순 셸**에서도 목적대로 동작했다
(빈 배열이 안 앉고 문구가 뜬다). N2는 대조군이 새로고침·재시작 어느 쪽으로도 못 나오는 **영구
감옥**이었고, 판정 대상은 다섯 칸 전부에서 2.6.2 이상이다.

체크리스트 8항목 중 **7항목이 초록**이다. 초록이 아닌 하나는 요구 3의 뒷절반 —
「이 가드가 다른 목록 화면에도 걸려 있는가」에 대한 답이 **아니오**이고(결함 C),
그와 별개로 이 라운드가 새로 쓴 로그인 경로에 결함 A가 남아 있다.

— 확인 크리틱 R1 (Claude Fable 5)
