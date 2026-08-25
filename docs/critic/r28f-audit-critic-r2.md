# R28f AUDIT 확인 크리틱 R2 — 문은 진짜로 열렸고 처방은 진짜로 안 닿는다. 그런데 그 판을 가른다고 내건 세 칸 중 하나는 **켜질 수 없는 계기**다

판정자: R28f AUDIT 확인 크리틱 R2(새 컨텍스트) · 2026-08-25 · `feature/3.0.0-beta` @ `5f5562e`
대상: `docs/critic/final-parity-r4.md`(커밋 `711fd5f`) + `final-parity-r3.md` 상단 정정 헤더
판정 원칙: **감사 보고서·커밋 메시지를 근거로 쓰지 않았다.** exe를 새로 굽고, 계기를 새로 쓰고,
내 격리 홈에서 **32회** 주행해 수치로 판정했다. 감사의 도구(`docs/critic/tools/critic-r28f-*.mjs`)는
**한 줄도 실행하지 않았다** — 「무엇을 주장했나」를 읽기 위해서만 열었다.

---

## 0. 내가 무엇으로 쟀나 — 감사와 **다른 커밋 · 다른 exe · 다른 포트 · 다른 심은 값**

| 항목 | 값 |
|---|---|
| 판정 트리 | `git archive HEAD`(**`5f5562e`**) → `C:\Temp\ccg-r28f-auditcr2\wt` (`git worktree` 미등록 · 공유 `.git` 무변) |
| 의존성 | `node_modules` **정션만** (`npm ci`·`npm install` **0회**) |
| 프론트 | `npm run app:build` — vite **2.05s** · exit 0 |
| 셸 | `cargo build --release --features custom-protocol` · `CARGO_TARGET_DIR=C:\Temp\ccg-r28f-auditcr2\target` (**새 디렉터리** — 함정 11) · **2m34s** · 경고 **0** |
| 산출 exe | **6,582,272 B** · sha256 `c3893d083c2ac4f0b2cf529936b6c437daf5502917721ca2207591e711620e84` |
| (대조) 감사 exe | 6,545,408 B · `526c7027…` @ `1078718` — **다른 바이너리 · 다른 트리에서 같은 값이 났다** |
| 2.6.2 | `node_modules/electron/dist/electron.exe` + 커밋된 `out/`(읽기만) · `USERPROFILE`까지 격리 |
| 홈 | 주행마다 격리 — `C:\Temp\ccg-r28f-auditcr2\home-*`(**30개**) · `uprof-*`(14개) |
| CDP 포트 | **10580~10587**(배정: AUDIT 10530 + 크리틱 50) |
| 프록시 싱크 | `127.0.0.1:10588`(내가 띄운다 · **모든** CONNECT를 기록하고 502로 끊는다) |
| 계기 | 전부 자작 — `crit2.mjs`(limitpop 20주행) · `ctl2.mjs`(**팝오버 계기의 양성 대조**) · `explr2.mjs`(탐색기) |
| 심은 값 | **5h 61% · 주간 62% · Fable 63%** — 감사의 42/43/44와 **일부러 다르게**(값이 새면 출처가 즉시 보인다) |
| 프로세스 | 이름 기반 kill **0회** — 내가 스폰한 PID만(`taskkill /PID /T`). 종료 후 잔류 **0**(내 22 PID 전수 확인 · 살아 있는 `AgentCodeGUI.exe`는 전부 사용자 설치본 `AppData\Local\Programs\…`) |
| 자격증명 | 실홈 파일 **0바이트 접촉**. 픽스처(`bench/fixture.mjs`)를 **아예 안 썼다** — 홈을 내가 처음부터 만든다 |

### 0.1 주행 장부 (합 32회)

| 계기 | 3.0 | 2.6.2 |
|---|---|---|
| `crit2` limitpop (synth-seeded 3 · synth-bare 3 · noacct-seeded 2 · noacct-bare 2) | 10 | 10 |
| 스모크 | 1 | 1 |
| `ctl2` 양성 대조(팝오버 계기 판별력) | 2 | — |
| `explr`·`explr2` 탐색기 | 4 | 4 |

---

## 1. 한 문단 결론

**감사의 F1 수정은 내 손에서도 참이다.** 문은 진짜로 열렸고(계정 1 팔의 2차 `usage:get`이
**1,199~1,211 ms** 큐에 걸리고 3.0은 요청이 조립돼 내 싱크까지 온다), 그 상태에서
`seeded`/`bare`가 완전히 같다(20/20 전부 **4행 · 데이터 없음**). 같은 순간 같은 파일을
`auth:accounts-usage(cachedOnly)`가 읽어 **61/62/63**을 그린다. **디스크 `usage-cache.json`은
이 화면에 안 닿는다 — 다른 exe · 다른 심은 값 · 다른 계기로 재현됐다.** F2의 「표 밖 14건」도
내 독립 수집과 **정확히 일치**하고, 계약면 `216/198/18`(baseline) → `216/203/13`(HEAD)도
내 스캐너가 **목록까지 한 줄도 안 다르게** 냈다. 코드 수정 0 · 기준 결과 파일 무손상 · 삭제 0줄.

**그런데 이 라운드가 「판별력이 있다」며 내건 세 칸 중 한 칸은 켜질 수 없는 계기다.**
팝오버는 퍼센트를 **`100 − pct`(남음)** 로 그린다(`Chat.tsx:3640 limitRow`). 그래서 42/43/44를
심으면 화면에는 **58/57/56**이 뜬다 — 감사의 `sees42 = /42|43|44/.test(popText)`
(`critic-r28f-limitpop2.mjs:267`)는 **가설이 참이어도 절대 안 켜진다.** §2.4의
「닿으면 … 42/43/44가 보인다」도 그래서 틀렸다. **크리틱 R1이 실패시킨 그 결함(판별력 0인 계기)이
그것을 고치겠다는 라운드의 간판 표 안에 다시 들어 있다.** 남은 두 칸(`prows` 4↔5 · `hasNoData`)은
판별력이 있고 — 내가 **감사가 안 한 양성 대조**로 그걸 증명했다(`getUsage`를 스텁으로 갈면
같은 팝오버가 **5행**이 되고 Fable 행이 생긴다) — 그래서 **결론 자체는 안 흔들린다.**

**출하 판정은 감사와 같다 — 치명 2(N1·N2) · 출하 불가.**

---

## 2. 체크리스트 항목별 실측

| # | 항목 | 내 실측 | 판정 |
|---|---|---|---|
| 1 | 정정 셋(T3·N3·T1) 반영 · 새 근거 사실성 | 셋 다 R3에 실려 있고 R4 §6이 유지 · 근거 전수 재확인(§3) | ⚠ 셋은 ✅ · **F3의 새 근거가 HEAD에서 거짓**(§5-G2) |
| 2 | ①의 재측정이 돌았나 · `hasNoData` 흔들리나 · 「환경 의존」이 그 값에 근거하나 | **내 20주행이 감사의 20주행을 셀 단위로 재현**(§4) · `hasNoData` 20/20 `true`(무동요) · 분류 근거를 ①소스 ②이력 ③20주행으로 다시 적은 것은 정당 | ⚠ 실체 ✅ · **세 지표 중 하나가 사수**(§5-G1) |
| 3 | 숙제 (b) — 증거 파일의 **모든** 관측이 표에 | 내 독립 스캔이 표 밖 **14건을 정확히 같은 목록으로** 재현 · 계열 C = shots 6파일도 일치 · 숨긴 반대 관측 **0** | ✅ (전량 62건의 **본문 표는 없다** — §5-G3) |
| 4 | 숙제 (c) — `explorer-tree` 같은 시각·같은 트리 | R3 산출물 직독: 114/114 ×2 · 두 순서 · 간격 **1,367·1,376 ms** · 라벨 차집합 0 · **라운드 도중 루트 119→120** · 내 측정: 오늘 루트 **125**, 3.0 탐색기 **119행** | ✅ (R4는 재주행 안 했다고 **정직하게** 적었다) |
| 5 | 헤드라인 두 수가 §1·§5에 | R3 §1(85행)·§5(334·341·350행)·§8(452행) 전부 「통짜 73.6%(89/121) · 병합 99.2%(120/121)」 | ✅ |
| 6 | 범위 밖 오분류 · 기준 파일 무손상 | `git diff -- bench/shots bench/results docs/critic` **비어 있음** · `711fd5f` 삭제 **1줄**(자기 도구의 라벨 정정) · 기준 결과 파일 삭제 **0** · 하네스 32실패를 3.0 회귀로 안 셌다 · 2.6.2의 `CCG_HOME` 무시도 2.6.2 성질로 뒀다 | ✅ |
| 7 | 코드 수정 0 | `711fd5f` 17파일 — **전부 `docs/critic/`**. 워킹트리의 미커밋 코드 변경은 M10 소유(`talk.rs`·`scripts/*`) | ✅ |

`npm run typecheck:node` · `:web` · `typecheck:app` = **exit 0 · 0 · 0**(내가 레포에서 직접 실행).

---

## 3. 「닫혔다」를 내 손으로 다시 눌렀다

### 3.1 계약면 — 내 스캐너로 두 트리를 다시 셌다 (감사 도구 미사용)

`src/shared/protocol.ts`의 `IPC` 블록을 파싱해 216개 리터럴을 뽑고, `src-tauri/src/**/*.rs`
43파일을 주석/코드로 갈라 훑었다:

```
HEAD  5f5562e : total 216 · impl 203 · commentOnly 0 · missing 13
   missing = talk 6 · lsp 3 · app:{update-check,update-install,update-event,open-directory} 4
baseline 1078718 : total 216 · impl 198 · commentOnly 0 · missing 18
   좁혀진 5 = codex-auth:{login,logout,set-default-account,login-cancel,reorder-accounts}
```

**감사의 `216/198/18` · `216/203/13` · 좁혀진 5 — 목록까지 한 줄도 안 다르다.**
**N3(`app:open-directory`)는 HEAD에서도 `missing`**이다. 등급 「높음」 유지는 정당하다.

### 3.2 N3·F4의 근거 — 파일에서 직접

- `src-tauri/nsis/hooks.nsh` **:28** = `!define CCG3_DIRSHELL "Software\Classes\Directory\shell\${CCG3_KEY}"`
  (:26은 `CCG3_VERB`) · HKCU 쓰기는 **:39-41**(`Directory\shell`)·**:44-46**(`Background\shell`).
  R4의 정정(:26 → :28)과 인용 줄이 **정확히 맞다.**
- 방출자/구독자: 내 런타임 프로브 — `typeof window.api.app.onOpenDirectory === "function"` ·
  `window.api.app.openDirectory === undefined`. R4의 라벨 정정도 맞다.

### 3.3 §0.1의 「내가 잰 코드 경로는 baseline 이후 무변」 — 명령으로 확인

```
git diff --stat 1078718..d461f21 -- src-tauri/src/ipc/parity/usage.rs crates/ccg-auth/src/usage.rs \
    crates/ccg-auth/src/net.rs src/main/index.ts src/main/auth.ts out/main/index.js   → (비어 있음)
git diff --stat 1078718..HEAD     -- (같은 경로)                                       → (비어 있음)
```

Fable 행 조건식도 baseline `:4142` = HEAD `:4168` = 2.6.2 `:3322`로 **세 자리가 바이트 동일**하다.
→ **감사가 exe를 다시 안 구운 것은 이 라운드에서는 정당하다.** (나는 그래도 HEAD로 새로 구웠고,
같은 값이 났다.)

### 3.4 F2 — 표 밖 14건, 내 수집기가 **같은 목록**을 냈다

`docs/critic/final-parity-r{1,2,3}-*.json`을 키/파일명이 아니라 **한도 표면**으로 훑었다:

| 표면 | 내가 센 것 | 감사의 §3.2 |
|---|---|---|
| `auth.accountsUsage` (r1 tauri/electron · r2 tauri/tauri-nonet/electron) | **5** | #1~#5 ✅ |
| `final-parity-r1-blind.json#workbar-context-pop` | **1** | #6 ✅ |
| `final-parity-r3-rawprobe.json#usage.get(false)` | **1** | #7 ✅ |
| `codexAuth.accountsUsage` (apiprobe 5파일) | **5** | #8~12 ✅ |
| `apiConfig.listUsage` (r1 tauri/electron) | **2** | #13~14 ✅ |
| **합** | **14** | **14** |

계열 C(팝오버 `found`)도 확인했다 — `workbar-context-pop`이 든 `bench/shots/*/report.json`은
정확히 **6개**(`electron`·`electron-r28e`·`tauri`·`tauri-r28e`·`tauri-r28e2`·`tauri-r28ex`).
극성도 그들의 JSON을 내가 다시 세어 `3.0 값4/무13 · 2.6.2 값2/무10`으로 같다.
**숨긴 반대 관측은 0이다.** 크리틱 R1이 6이라 한 것이 실제 14라는 감사의 정정은 옳다.

---

## 4. ★F1 재측정 — 내 손으로 20주행. 셀 단위로 재현됐다

내 배치는 감사와 **같은 설계 · 다른 재료**다: 합성 계정 `critr2-synth@example.invalid`,
심은 디스크 캐시는 **61/62/63**, 3.0은 `HTTPS_PROXY`→내 싱크(10588), 2.6.2는 토큰 개행
(`fetch`가 소켓 **전에** undici 헤더 검증에서 죽는 것을 내 node에서 따로 확인 —
`TypeError: Headers.append: … invalid header value`).

| 앱 | 팔 | n | 계정 | 1차 `usage:get` | **2차 `usage:get`** | `CONNECT`(anthropic) | `prows` | `hasNoData` | `accountsUsage(cachedOnly)` |
|---|---|---|---|---|---|---|---|---|---|
| 3.0 | `synth-seeded` | 3 | 1 | 3·1·1 ms | **1,199·1,200·1,200 ms** | 4·4·4 | **4·4·4** | true×3 | **`61/62/63`** ×3 ← 양성 대조 |
| 3.0 | `synth-bare` | 3 | 1 | 2·2·2 ms | **1,200·1,202·1,200 ms** | 5·5·5 | 4×3 | true×3 | `null/null/null` ×3 |
| 3.0 | `noacct-seeded` | 2 | 0 | 1·1 ms | **1·1 ms** | **0** | 4·4 | true×2 | `[]` |
| 3.0 | `noacct-bare` | 2 | 0 | 1·1 ms | **0·1 ms** | **0** | 4·4 | true×2 | `[]` |
| 2.6.2 | `synth-seeded` | 3 | 1 | 1·1·1 ms | **1,209·1,208·1,201 ms** | — | 4×3 | true×3 | **`61/62/63`** ×3 |
| 2.6.2 | `synth-bare` | 3 | 1 | 0·1·0 ms | **1,206·1,203·1,211 ms** | — | 4×3 | true×3 | `null/null/null` ×3 |
| 2.6.2 | `noacct-*` | 4 | 0 | 0~1 ms | **0 ms** | — | 4×4 | true×4 | `[]` |

팝오버 실측 텍스트(20/20 동일): `현재 컨텍스트 0% / 5시간 한도 데이터 없음 — / 주간 한도
데이터 없음 — / 토큰 사용량` = **4행 · Fable 행 없음 · 61·62·63 어디에도 없음.**
심은 파일의 sha는 주행 전후 **20/20 동일**하고 `bare` 팔에서는 파일이 **생기지도 않았다.**

### 4.1 ★감사가 안 한 대조군 — **팝오버 계기 자체의 판별력**을 증명했다

감사의 양성 대조는 「심은 파일이 유효하다」(=`accountsUsage`가 읽는다)까지다. 그것만으로는
**팝오버 계기가 값이 와도 못 볼 가능성**이 안 닫힌다. 그래서 `getUsage`를 스텁으로 갈고
같은 팝오버를 다시 열었다(`ctl2.mjs` · 같은 exe · 같은 홈):

```
Object.defineProperty(window.api,'getUsage',{value: async()=>({fiveHour:{pct:61},weekly:{pct:62},weeklyFable:{pct:63},…})})
→ .wb-prow 5행:  「5시간 한도 … 39% 남음」 · 「Fable 주간 한도 … 37% 남음」 · 「주간 한도 … 38% 남음」
   hasNoData = false
```

**계기는 값이 오면 본다. 4행·데이터 없음은 계기 무능이 아니라 실측이다.**
→ **감사의 결론은 내 손에서 더 강한 대조군으로도 선다.**

---

## 5. 남은 결함

### G1 ⛔ **중간 · 「판별력 있다」고 내건 세 칸 중 하나는 켜질 수 없는 계기다** (체크리스트 2)

위 4.1의 부산물이 이것이다. 팝오버는 **남은 비율**을 그린다:

```
app/src/components/Chat.tsx:3640  function limitRow(...)
   const rem = w ? Math.max(0, 100 - Math.round(w.pct)) : null      ← 100 − pct
   end: <b>{rem}%</b> 남음
```

내 대조군이 실행으로 증명한다 — `pct 61/62/63`을 넣으면 화면에는 **39/38/37**이 뜬다.
그러므로 감사가 심은 **42/43/44**가 이 문에 닿았다면 화면에는 **58/57/56**이 떴을 것이다.
그런데 감사의 계기는

```
docs/critic/tools/critic-r28f-limitpop2.mjs:267
   rec.sees42 = /42|43|44/.test(String(rec.popText))
```

이고, 보고서 §2.4는 이것을 판별의 **한 칸**으로 싣고(「42/43/44 보임 ✗」) §2.4 본문은
*「닿으면 팝오버는 5행이고 42/43/44가 보인다」* 라고 **틀린 예측**을 적는다.
**이 지표는 가설이 참이어도 절대 안 켜진다** — 즉 판별력 0이고, 우연히 켜질 여지(토큰 수·
초기화 시각 문자열에 42가 섞이는 경우)만 있어 **거짓 양성 쪽으로만** 위험하다.
크리틱 R1이 이 라운드를 실패시킨 사유가 정확히 「판별력 0인 배치」였는데, 그 수정 라운드의
간판 표에 같은 종류의 칸이 다시 들어갔다.

- **결론은 안 흔들린다**: 남은 두 칸(`prows` 4↔5 · `hasNoData`)은 §4.1에서 내가 판별력을
  증명했고, 20/20이 4행·`true`다.
- 재현: `node C:\Temp\ccg-r28f-auditcr2\ctl2.mjs --port=10582` → `nRows: 5` ·
  `"5시간 한도1시간 0분 후 초기화39% 남음"`. 심은 값 61인데 화면은 39다.
- 처방: `sees42`를 **`sees(100-pct)`** 로 고치거나 지워라. 그리고 §2.4의 예측 문장을
  「닿으면 5행이 되고 **58/57/56**이 보인다」로 고쳐라. 표의 그 칸은 지금 **아무 정보가 없다.**

### G2 ⛔ **낮음~중간 · F3의 정정이 그 정정을 담은 트리에서 이미 거짓이다** (체크리스트 1)

R4 §4의 정정: *「§7.2 표의 `codex-auth:set-default-account` 행에서 「앉는 자리 = `setCxAccounts`」를
내린다. 3.0에는 그 호출부가 없다」*. 그리고 부록 A: *「**3.0에 호출부 없음** … **채널 미구현은 그대로**」*.

내가 커밋별로 셌다:

```
git show <c>:app/src/components/Settings.tsx | grep -c codexAuth.setDefaultAccount
  1078718 → 0    0ec5105 → 0    efdc08c → 1    521221d → 1    d461f21 → 1    711fd5f → 1    HEAD → 1
HEAD  app/src/components/Settings.tsx:555
      setCxAccounts(await window.api.codexAuth.setDefaultAccount(email))
```

**SHIPBLOCK의 `efdc08c`가 그 호출부를 만들었고, 그건 감사의 정정 커밋 `711fd5f`보다 먼저
착지했다.** 감사는 §4에서 「`1078718` 트리에서 확인」이라 범위를 적었지만,
① 정정 문장 자체(「3.0에는 그 호출부가 없다」)에는 그 범위가 안 붙어 있고,
② 부록 A의 「**채널 미구현은 그대로**」는 **HEAD에서 명백히 거짓**이며 — 같은 문서 §7이
   「좁혀진 5 = codex-auth 5채널(`ipc/accounts.rs:631-635`)」이라고 스스로 적는다.
**한 보고서 안에서 §4/부록A와 §7이 같은 채널을 두고 반대로 말한다.**

- 재현: 위 두 명령(15초).
- 처방: 부록 A의 그 줄에 **「baseline `1078718` 기준」**을 붙이고, HEAD 행을 따로 적어라 —
  「HEAD: 채널 구현됨(`accounts.rs:631-635`) · 호출부 `Settings.tsx:555`에 생김 · 동작 미확인」.

### G3 · 낮음 — 「전량 62건」은 **본문에 표가 없다**

숙제 (b)의 문장은 「모든 관측을 **표로** 실어라」였다. R4는 표 밖이던 **14건**만 표로 싣고
(§3.2), 나머지 48건은 §3.4의 **집계 숫자**와 `final-parity-r4-observations.json`에만 있다.
증거 JSON이 커밋돼 있으므로 실질은 닫혔다고 본다 — 다만 「전량을 표로」는 아직 아니다.
부수로, 내 스캔은 감사의 포함 규칙 **밖에** 한도 표면 관측이 6건 더 있다는 것도 확인했다
(`final-parity-r{1,2}-pixdiff*.json`의 `workbar-context-pop` 3 · `limit-hold-bar` 3).
그쪽은 **한도 수치가 아니라 픽셀 차이**라 규칙상 제외가 정당하다 — 규칙을 코드에 못 박은
이번 판의 미덕이다. 적어 두는 이유는 다음 라운드가 또 「전량」이라 부를 때를 위해서다.

### G4 · 낮음 — 「실 HTTP 0건」은 **3.0 쪽만 계측됐다**

3.0은 `HTTPS_PROXY` 싱크가 프로세스의 **모든** 나가는 요청을 잡으므로 그 주장이 로그가 된다.
2.6.2 쪽은 그런 계측이 없다 — 증거(`final-parity-r4-electron-nosocket.json`)는 **오염된 토큰이
든 usage `fetch` 한 경로**만 잰 합성 측정이고, 프로세스 전체가 아니다. 내 주행에서는
같은 2.6.2 바이너리가 격리 홈에서 **주행당 2~5건**의 `CONNECT registry.npmjs.org:443`을 냈다
(내 싱크가 잡아 502로 끊었다 · 3.0도 주행당 3~4건). 감사의 2.6.2 팔에는 그걸 막거나 기록할
장치가 **하나도 없다.**

- 위험도는 낮다 — 공개 레지스트리이고 자격증명이 안 실리며 토큰 회전과 무관하다.
- 그래도 헤드라인 「실 HTTP **0건**」은 2.6.2 팔에 대해서는 **미계측**이다.
  감사 자신의 §8-3 숙제(「나가는 요청 계측을 상설로 달아라」)가 가리키는 자리가 정확히 여기다.
- 재현: `node C:\Temp\ccg-r28f-auditcr2\crit2.mjs --arm=synth-seeded --kind=electron --runs=1 --sink=10588`
  → `proxyHits` 에 `CONNECT registry.npmjs.org:443`.

### G5 · 정보 — 「각 3회 이상」은 새 배치의 절반만 만족한다

R4의 새 배치는 `synth-*` 팔이 3회, `noacct-*` 팔이 **2회**다. `noacct`는 R3가 이미 3회씩 잰
배치의 대조군이라 실질 문제는 아니지만, 숙제 문장(「각 3회 이상」)을 글자대로 보면 절반이다.

### 범위 밖으로 남는 것(내 판정에도 격차 아님)

- N1·N2 — SHIPBLOCK 갈래 소관. 감사도 나도 안 건드렸다. 배선이 HEAD에 있다는 **정적 사실**은
  내 스캔이 확인했고(§3.1), **동작 확인은 그 갈래 크리틱의 일**이다.
- 「실 조회가 성공했을 때 두 앱이 같은가」 — 여전히 미판정. 감사가 §8에서 **먼저 적었다.**
- 숙제 (c)의 2.6.2 쪽 동시 측정 — 나는 못 냈다. 미포장 electron은 argv 폴더를 **일부러**
  안 받는다(`src/main/index.ts:216 if (!app.isPackaged) return null`)라 내 argv 경로로는
  2.6.2 탐색기가 안 열린다(3.0은 `ipc/parity/misc.rs:106`에 그 가드가 없어 열린다).
  그래서 이 항목은 R3 산출물 직독 + 크리틱 R1의 6주행 + 내 루트 관측으로 닫는다.

---

## 6. 종합

| 체크리스트 | 결과 |
|---|---|
| 1) 정정 셋 반영 · 근거 사실성 | ⚠ 셋 ✅ · **F3의 새 근거가 HEAD에서 거짓 · 자기 §7과 모순**(G2) |
| 2) 재측정 실재 · `hasNoData` 안정 · 분류 근거 | ⚠ 실체 ✅(내 20주행이 셀 단위 재현) · **세 지표 중 하나 사수**(G1) |
| 3) 숙제 (b) 전량 수록 | ✅ 14건 목록 **완전 일치** · 숨긴 반대 관측 **0** (본문 전량 표 없음 — G3) |
| 4) 숙제 (c) 같은 시각·같은 트리 | ✅ R3 산출물이 스스로 증명(114/114 ×2 · 1.4초 간격 · 라운드 도중 루트 119→120) |
| 5) 두 수 병기 | ✅ R3 §1·§5·§8 |
| 6) 범위 밖 오분류 · 기준 파일 무손상 | ✅ `git diff` 비어 있음 · 기준 결과 파일 삭제 0줄 |
| 7) 코드 수정 0 | ✅ 17파일 전부 `docs/critic/` |

**감사 자체의 판정: 실질은 통과, 그러나 두 칸을 고쳐야 한다.**
① 간판 표의 `42/43/44` 칸은 **켜질 수 없는 계기**다 — 지우거나 `100−pct`로 고쳐라(G1).
② F3의 정정과 부록 A는 **자기 트리에서 이미 거짓**이다 — 트리 범위를 붙이고 HEAD 행을 따로
   적어라(G2). **출하 판정은 감사와 같다 — 치명 2(N1 Codex 계정 축 · N2 에러 안전망 부팅 루프) ·
   출하 불가.** 이 라운드가 만든 새 치명은 **0**이다.

---

## 7. 내가 만진 것

- 레포: **이 파일 하나**(`docs/critic/r28f-audit-critic-r2.md`). 코드 수정 **0** ·
  기준 결과 파일 **0** · 남의 미커밋 변경 접촉 **0**.
- 레포 밖(재현용 · 정리 안 함): `C:\Temp\ccg-r28f-auditcr2\` —
  `wt`(아카이브 트리) · `target`(새 `CARGO_TARGET_DIR`) · `base`(1078718 계약면 대조) ·
  `crit2.mjs` · `ctl.mjs` · `ctl2.mjs` · `explr.mjs` · `explr2.mjs` ·
  `cr2-{tauri,electron}-{synth,noacct}-{seeded,bare}.json`(20주행) · `cr2-ctl2.json`(양성 대조) ·
  `cr2-explorer{,2}.json` · `smoke1.json` · `smoke-el.json` ·
  `cargo.log` · `appbuild.log` · `tc-{node,web,app}.log` · `home-*`(30개) · `uprof-*`(14개)
