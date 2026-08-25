# R28f AUDIT 확인 크리틱 R1 — 정정 넷은 내 손에서도 전부 사실이다. 그런데 이 라운드의 간판 실험은 아무것도 가르지 못한다

판정자: R28f AUDIT 확인 크리틱 R1(새 컨텍스트) · 2026-08-25 · `feature/3.0.0-beta` @ `0ec5105`
대상: `docs/critic/final-parity-r3.md`(커밋 `6d72eff` · 잔손질 `0ec5105`) + `final-parity-r2.md`의 정정 헤더
판정 원칙: **감사 보고서·커밋 메시지를 근거로 쓰지 않았다.** exe를 새로 굽고, 계기를 새로 쓰고,
내 격리 홈에서 32회 주행해 수치로 판정했다. 감사의 도구(`docs/critic/tools/critic-r28f-*.mjs`)는
**한 줄도 실행하지 않았다** — 그 파일들은 「무엇을 주장했나」를 읽기 위해서만 열었다.

---

## 0. 내가 무엇으로 쟀나 — 감사와 **다른 커밋 · 다른 exe · 다른 포트**

| 항목 | 값 |
|---|---|
| 판정 트리 | `git archive HEAD`(**`0ec5105`**) → `C:\Temp\ccg-r28f-auditcrit\wt` (`git worktree` 미등록 · 공유 `.git` 무변) |
| 의존성 | `node_modules` **정션만** (`npm ci`·`npm install` **0회**) |
| 프론트 | `npm run app:build` — vite **4.29s** |
| 셸 | `cargo build --release --features custom-protocol` · `CARGO_TARGET_DIR=C:\Temp\ccg-r28f-auditcrit\target` (**새 디렉터리** — 함정 11) · **3m37s** · 경고 **0** |
| 산출 exe | **6,564,352 B** · sha256 `19d195d1191083b64207e434531cedacbb9dd3c930ec2b7748d1f74af3eb6e21` |
| (대조) 감사 exe | 6,545,408 B · `526c7027…` @ `1078718` — **다른 바이너리에서 같은 값이 났다** |
| 2.6.2 | `node_modules/electron/dist/electron.exe` + 커밋된 `out/`(읽기만) |
| 홈 | 주행마다 격리 — `C:\Temp\ccg-r28f-auditcrit\home-*` (28개) |
| CDP 포트 | **10580~10587**(배정: AUDIT 10530 + 크리틱 50) |
| 계기 | `C:\Temp\ccg-r28f-auditcrit\crit-harness.mjs`(자작 · 픽스처부터 새로) · `crit-obs.mjs`(관측 수집기 · 자작) |
| 프로세스 | 이름 기반 kill **0회** — 내가 스폰한 PID만(`killTree`) |

### 0.1 안전 규약 — 감사보다 **한 칸 더** 좁게 갔다

내 픽스처는 `bench/fixture.mjs`를 **안 쓴다**. 그쪽은 실홈 `accounts.json`·`codex-accounts.json`·
`api-config.json`을 홈에 복사한 **뒤** 감사가 지우는 구조인데, 나는 애초에 **복사하지 않는다**.
주행마다 `credsPresent: []`를 기록으로 남겼다(32/32 전부 빈 배열).

- 심은 것: `usage-cache.json`(퍼센트만 · 토큰 없음) — seeded 팔에서만.
- 합성한 것: `codex-accounts.json` = `crit-a@example.invalid`·`crit-b@example.invalid`(토큰 없음).
- **실 HTTP 0건**은 우연이 아니라 구조다: 계정이 0이면 3.0은
  `src-tauri/src/ipc/parity/usage.rs:183`에서, 2.6.2는 `src/main/index.ts:1028`에서
  **네트워크 앞에서 되돌아간다**. 기록된 `auth.listAccounts()`는 전 주행 **0**.
- `USERPROFILE` 회전은 **2.6.2에만** 걸었다. 3.0에 걸면 WebView2가 CDP를 안 연다(함정 7) —
  내 첫 tauri `homecheck` 2회가 정확히 그것으로 죽었고(`no cdp target on 10585`), 회전을 빼자 살았다.

### 0.2 주행 장부 (합 32회)

| 계기 | 3.0 | 2.6.2 |
|---|---|---|
| `probe`(원시 채널 18 + 심 12) | 1 | — |
| `limitpop`(seeded 3 · bare 3) | 6 | 6 |
| `explorer`(레포 2라운드 ×2 + 통제 2라운드) | 6 | 6 |
| `homecheck`(합성 codex 계정) | 3(중 2회는 함정 7로 실패) | 2 |
| `apitree`(런타임 표면 전수) | 1 | 1 |

---

## 1. 한 문단 결론

**감사의 정정 넷은 전부 사실이다.** ①의 철회(「역전·3.0 승」)는 정당하고, ②(N3 → 높음)의 근거
둘은 내 손에서 그대로 재현됐으며, ③(T1 왕복 미검증)과 ④(통짜 73.6% 병기)도 문서에 실려 있다.
**코드 수정 0 · 기준 결과 파일 삭제 0줄 · 계약면 216/198/18 목록까지 내 독립 스캔과 완전 일치.**
숙제 (c)는 **내가 더 강하게 닫았다** — 통제 실험에서 트리에 폴더 2개를 더하자 두 앱의 행 수가
나란히 40→42로 움직였다. §2.5의 「2.6.2는 `CCG_HOME`을 무시한다」도 합성 계정 A/B로 **확정**했다.

**그런데 이 라운드가 간판으로 내건 실험은 아무것도 가르지 못한다.** `limit-pop` 12주행은
전부 **계정 0**이고, 계정이 0이면 `usage_get`은 캐시를 **보기도 전에** 되돌아간다
(`ipc/parity/usage.rs:183`). 즉 `seeded`와 `bare`의 차이가 0인 것은 「그 처방이 이 화면에
안 닿는다」의 증거가 아니라 **「이 실험은 어떤 가설도 못 가른다」의 증거**다. 결론 자체(디스크
캐시는 이 문에 안 닿는다)는 소스로 옳지만, 숙제 (a)를 닫은 것은 재측정이 아니라 **소스 독해와
27건 이력**이다. 보고서는 계정 0을 표에 적어 두고도 그 함의는 안 적었다.

**출하 판정에는 영향이 없다 — 치명 2(N1·N2) · 출하 불가. 감사와 같다.**

---

## 2. 체크리스트 항목별 실측

| # | 항목 | 내 실측 | 판정 |
|---|---|---|---|
| 1 | 정정 셋 반영 · 새 근거 사실성 | §3 — 근거 6개 전부 소스에서 확인, 인용 오차 2건(§5-F3·F4) | ✅ (나사 2개) |
| 2 | ①의 재측정이 돌았나 · `hasNoData` 흔들리나 · 「환경 의존」이 그 값에 근거하나 | 12주행 재현(내 손에서도 4/true 고정) · **분류는 그 값이 아니라 27건 이력에 근거** · 실험 판별력 0 | ⛔ 셋째 절 실패(§5-F1) |
| 3 | 숙제 (b) — 증거 파일의 **모든** 관측이 표에 | 감사 3계열 = **27건, 내 독립 수집과 정확히 일치**. 같은 파일의 **동축 관측 6건은 표 밖**(§5-F2) | ⛔ 「전량」은 3계열 한정 (숨긴 반대 관측은 0) |
| 4 | 숙제 (c) — `explorer-tree` 같은 시각·같은 트리 | 레포: T=119/E=119 · T=119/E=119 → 118/118(루트 125→124) · 통제: 40/40 → **42/42** · 라벨 차집합 0 | ✅ **확정** |
| 5 | 헤드라인 두 수가 §1·§5에 | R3 §1(77행)·§5(342행)·§8 표 전부 「통짜 73.6%(89/121) · 병합 99.2%(120/121)」 | ✅ |
| 6 | 범위 밖 오분류 · 기준 파일 무손상 | `git diff -- bench/shots bench/results docs/critic` **비어 있음** · 두 커밋 삭제 **0줄**(자기 파일 3줄 제외) · Verse 3·업데이트 3 회귀 미계상 · 103/105 미계상 | ✅ |
| 7 | 코드 수정 0 | `6d72eff` 14파일 · `0ec5105` 1파일 — **전부 `docs/critic/`** | ✅ |

---

## 3. 「닫혔다」를 내 손으로 다시 눌렀다

### 3.1 원시 채널 프로브 — 감사의 23건과 **값까지 일치**(다른 exe에서)

```
raw:app:open-directory("C:\Code")     → {"__unimplemented":true}      ← N3
raw:app:get-initial-dir               → null                          ← 콜드 경로는 산다
raw:codex-auth:{login,logout,login-cancel,reorder-accounts,set-default-account}
                                      → {"__unimplemented":true} ×5   ← N1
raw:auth:login-cancel → null · raw:auth:reorder-accounts → [] · raw:auth:list-accounts → []   ← T1
raw:btw:open → null · raw:shortcut:close → null · raw:ui:open-api-settings → null   ← T4·M1·M3
raw:engine:list-available → {latest:"0.3.245", 277개}   raw:engine:state → bundled:"unknown"  ← T2·M6
shim:git.aiMessage(비-git) → {"ok":false,"error":"Git 저장소가 아니에요"}                      ← M5
shim:codexAuth.{reorderAccounts([]),login(),logout(),setDefaultAccount()} → **[] 를 resolve**  ← 숙제 (d)
typeof window.api.app.onOpenDirectory = "function"   /   app.openDirectory = undefined
```

`__unimplemented`가 **reject가 아니라 resolve**로 호출부에 도착한다는 (d)의 기전은
내 손에서도 4채널 전부 재현됐다. 그 값이 앉는 자리도 확인했다 —
`app/src/components/Settings.tsx:507`·`:518`·`:537`이 `setCxAccounts(await …)`다.

### 3.2 계약면 216 — 내 스캐너로 다시 셌다

`src/shared/protocol.ts`의 `IPC` 항목을 뽑고, `src-tauri/src/**/*.rs` 43파일을 주석/코드로 갈라
리터럴을 찾았다(감사 도구 미사용):

```
total 216 · impl 198 · commentOnly 0 · missing 18
missing = talk:{run,cancel,permission-respond,question-respond,bg-task,event}(6)
        + codex-auth:{login,logout,set-default-account,login-cancel,reorder-accounts}(5)
        + lsp:{pick-verse-server,set-verse-path,clear-verse-path}(3)
        + app:{update-check,update-install,update-event,open-directory}(4)
```

**감사의 `final-parity-r3-channels.json`과 목록이 한 줄도 안 다르다.**
「talk 6은 두 앱 다 죽었다」도 사실이다 — 2.6.2 렌더러의 `window.api.talk` 호출부는
`src/renderer/src/App.tsx:532`·`:594` 두 줄뿐이고 3.0도 같은 두 줄만 부른다(`app/src/App.tsx:665`·`:731`).

### 3.3 표면은 정적 선언이 아니라 **런타임 객체**로 셌다

두 앱을 각각 띄워 `window.api`를 재귀로 걸어 함수 잎을 뽑았다:

```
3.0    184잎        2.6.2  183잎
3.0에만 있는 것: multi.toolingGet (1)      2.6.2에만 있는 것: **0**
```

즉 「심 누락 0」은 타입 선언이 아니라 **실제 객체**에서도 참이다.

### 3.4 통짜 73.6%의 32실패 — 원인 귀속이 맞는지 파일로 확인했다

`bench/shots/tauri-r28e2/report.json`(병합 없음 · ok 89/121):

| 오류 문자열 | 건수 |
|---|---|
| `type: no input .fxs input` | 23 |
| `click: no element .explorer .git-strip[0]` | 7 |
| `revealInTree: scratch 행이 안 보임 (bench)` | 1 |
| `clickText: no .set-inner button containing 정리` | 1 (= `settings-engine-confirm`, 환경 대칭 실패) |

연쇄의 첫 칸은 `explorer-blank` **바로 다음**이다(66행 ok → 67행 FAIL). 그리고
`bench/screens.mjs:1323`의 `explorer-blank` reset이 `selectChat('벤치 긴 스레드')` =
부분 문자열 `clickText`(`:119-122`)다 — 3.0에만 있는 「BTW - …창」 행이 먼저 걸린다.
**31 + 1 = 32.** 감사의 귀속(하네스 결함 · 3.0 회귀 아님)은 파일이 뒷받침한다.

---

## 4. 새 근거를 하나씩 눌러 봤다

### 4.1 N3 승격 근거 둘 — 둘 다 사실

| 감사의 근거 | 내 확인 |
|---|---|
| 설치기가 HKCU에 우클릭 항목을 쓴다 | `src-tauri/nsis/hooks.nsh:39-46`이 `NSIS_HOOK_POSTINSTALL`에서 `Directory\shell\AgentCodeGUI3`와 `…\Background\shell\…`에 `%V` 명령을 쓴다. 커밋 `60022e0` 실재(M12 R2) |
| 3.0은 X가 트레이 숨김이 **기본** | `win.rs:325 CloseRequested → tray::hide_on_close()` · `tray.rs:139-143`이 `read_ui_prefs()["tray.closeToTray"] != Some(false)` — 미설정이면 **참** |
| 그러면 폴더가 조용히 사라진다 | `main.rs:171-177` — 홈 락 실패 시 `raise_existing()` **후 `return`**. 폴더 인자를 넘기는 코드가 없다 |
| 2.6.2는 그 경로에서 폴더를 넘긴다 | `src/main/index.ts:201-202`(X = 트레이) · `:1907-1916`(`second-instance` → `send(IPC.openDirectory, dir)`) |
| 방출자가 0 | 내 채널 스캔에서 `app:open-directory`가 Rust 리터럴 **0회** · 렌더러는 `onOpenDirectory`를 구독 중(런타임 `"function"`) |

### 4.2 「`prows` 4↔5 = `weeklyFable` 한 칸」 — 조건식이 두 앱 **바이트 동일**

`app/src/components/Chat.tsx:4142` ↔ `src/renderer/src/components/Chat.tsx:3322`가 같은 줄이다
(`...(usage.weeklyFable ? [limitRow(…)] : [])`). 내 팝오버 실측 텍스트가 그대로 증명한다 —
`현재 컨텍스트 / 5시간 한도 데이터 없음 / 주간 한도 데이터 없음 / 토큰 사용량` = **4행, Fable 행 없음**.

### 4.3 「디스크 캐시는 이 문에 안 닿는다」 — 소스로 참

`usage:get`은 3.0이 `ipc/parity/usage.rs:103 cache()`(프로세스 `HashMap`)·`:129 stale()`,
2.6.2가 `index.ts:1006 usageCache`(`Map`)·`:1050` 폴백. **양쪽 다 메모리뿐이다.**
디스크 `usage-cache.json`을 읽는 자리는 `src/main/auth.ts:514`(계정별 목록)와
`crates/ccg-auth/src/usage.rs:39/258`뿐이다. 감사의 구조 논증은 옳다.

### 4.4 ★§2.5 「2.6.2는 `CCG_HOME`을 무시한다」 — **합성 계정 A/B로 확정**

감사는 실홈 계정 6개가 그려지는 것을 보고 이 결론에 닿았다(사고 1회). 나는 실계정을 한 번도
안 건드리고 같은 결론을 냈다 — 합성 `codex-accounts.json`(평문 · 토큰 없음)을 한쪽에만 심는다:

| 앱 | 심은 곳 | `codexAuth.listAccounts()` |
|---|---|---|
| 2.6.2 | `CCG_HOME` | **`[]`** — 안 읽는다 |
| 2.6.2 | `USERPROFILE\.agentcodegui` | **`["crit-a@example.invalid","crit-b@example.invalid"]`** |
| 3.0(대조) | `CCG_HOME` | **`["crit-a@example.invalid","crit-b@example.invalid"]`** |

빌드 산출물에서도 같은 말이 나온다 — `out/main/index.js:1032`·`:12972`·`:13155`가
`path.join(os.homedir(), ".agentcodegui")`로 **하드코딩**이고, `CCG_HOME`을 보는 자리는
`:32`(엔진 버전 · dev 한정)뿐이다. **확정. 그리고 이건 2.6.2 쪽 성질이지 3.0의 회귀가 아니다.**

### 4.5 숙제 (c) — 내 손에서 더 세게 닫혔다

| 주행 | 트리 | 순서 | 3.0 | 2.6.2 | 두 eval 간격 | 루트 전→후 |
|---|---|---|---|---|---|---|
| 1 | 레포 | tauri→electron | **119** | **119** | 1,655 ms | 125 → 125 |
| 2 | 레포 | electron→tauri | **119** | **119** | 1,668 ms | 125 → 125 |
| 3 | 레포(재주행) | tauri→electron | **119** | **119** | 2,682 ms | **125 → 124** |
| 4 | 레포(재주행) | electron→tauri | **118** | **118** | 1,665 ms | 124 → 124 |
| 5 | 내 스크래치(40항목) | tauri→electron | **40** | **40** | 1,667 ms | 40 → 40 |
| 6 | 같은 스크래치 **+폴더 2개** | electron→tauri | **42** | **42** | 1,670 ms | 42 → 42 |

행 라벨 차집합은 6주행 전부 **양쪽 0건**. 주행 3에서는 **내가 재는 도중 루트가 125→124로 줄었고**
바로 다음 라운드의 두 앱이 나란히 118로 내려갔다. 그리고 파일이 남긴 이력 자체가 같은 말을 한다:

```
explorer-tree found —  tauri 50 / electron 51 (08-24)  ·  tauri-r28e 103 / electron-r28e 105 (05:5xZ)
                       tauri-r28e2 109 (06:29Z)        ·  tauri-r28ex 108 (06:35Z)
```

**같은 앱이 38분 만에 103 → 109가 됐다.** 103 vs 105는 앱 차이가 아니다 — 감사의 판정은 옳고,
인벤토리에 안 올린 것도 옳다.

### 4.6 「기준 결과 파일 무손상」·「코드 0」

```
git diff -- bench/shots bench/results docs/critic     → (비어 있음)
git show --numstat 6d72eff  → 14파일 · 삽입 4,385 · 삭제 **0**  (전부 docs/critic/)
git show --numstat 0ec5105  → 1파일  · +9 / −3        (자기 파일 final-parity-r3.md)
npm run typecheck:node · :web · typecheck:app (내 아카이브 트리) → **exit 0 · 0 · 0**
```

`--merge`가 통짜 원수치를 제자리에서 덮는다는 §5의 단서도 사실이다 —
`bench/ab.mjs:644-656`이 같은 경로의 `report.json`을 읽어 합친 뒤 **같은 경로에 다시 쓴다**.

---

## 5. 남은 결함

### F1 ⛔ **중간 · 이 라운드의 간판 실험은 판별력이 0이다** (체크리스트 2 실패)

`limit-pop` 12주행(seeded 3 · bare 3 × 두 앱)은 **전 주행 계정 0**이다. 계정이 0이면:

```
src-tauri/src/ipc/parity/usage.rs:176-183
  let email = … .or_else(ccg_auth::claude::default_account_email);
  let Some(email) = email else { return unavailable_usage() };   ← 캐시·네트워크 **앞에서** 끝난다
src/main/index.ts:1027-1028
  const tk = await usageTokenFor(account); if (!tk) return empty;  ← 같음
```

즉 `seeded`와 `bare`가 같은 값을 내는 것은 **처방의 무효를 보인 것이 아니라, 어떤 가설도
검증할 수 없는 배치였다는 뜻**이다. 디스크 캐시를 실제로 읽는 코드 경로(`stale()`·`usageCache`)를
**한 번도 지나지 않았다.** 내가 같은 배치로 12주행을 다시 떠서 4/4 팔 전부 감사와 같은 값을
얻었다 — 그리고 그 일치가 아무 정보도 주지 않는다는 것이 이 항목의 요지다.

| 팔 | 3.0(내 3회) | 2.6.2(내 3회 · `USERPROFILE` 격리) |
|---|---|---|
| `seeded`(1,683 B) | `prows=4` `hasNoData=true` `acct=0` ×3 | `prows=4` `hasNoData=true` `acct=0` ×3 |
| `bare` | 같음 ×3 | 같음 ×3 |
| `usage:get` | `{…nulls, unavailable:true}` ×6 | `{…nulls}` ×6 |

**결론 자체는 안 흔들린다**(§4.3의 소스 논증이 독립적으로 성립한다). 흔들리는 것은
**「무엇이 그 결론을 지탱하는가」**다. 보고서 §2.3은 「캐시를 심고 각 3회 이상 다시 쟀다 →
두 앱이 완전히 같다」로 읽히는데, 그 「같음」은 계정이 없어서 생긴 것이다. 계정 0은 §0.1·§2.3
표에 숫자로 적혀 있지만 **그 함의는 한 줄도 안 적혀 있다.**

- 재현: 위 12주행(내 산출 `C:\Temp\ccg-r28f-auditcrit\crit-limitpop-{tauri,electron}-{seeded,bare}.json`).
- 처방: (a) 이 실험은 **판별력이 없다**고 보고서에 한 줄 적고, 숙제 (a)의 닫힘 근거를
  「소스(메모리 캐시 전용) + 27건 이력」으로 **명시**하라. (b) 진짜로 가르려면 합성 자격증명이
  필요하고 그건 함정 5 안에서는 불가하다 — **못 잰다고 적는 것**이 이 라운드가 할 수 있는 최선이다.

### F2 ⛔ **낮음 · 「관측 전량 27건」의 '전량'은 3계열 한정** (체크리스트 3 실패)

내 수집기(`crit-obs.mjs` · 감사 도구 미사용)로 세니 감사가 훑은 세 계열
(press `limit-pop` · apiprobe `usage.get` · A/B `workbar-context-pop`)은 **정확히 27건**이고
라운드별 극성도 그대로다(R1 3.0 0/2 · 2.6.2 2/0 / R2 3.0 4/2 · 2.6.2 0/4 — #9 킬스위치 제외 규약 적용 시).
**여기까지는 완전 일치다.** 그런데 같은 증거 파일 안에 표에 없는 **동축 관측 6건**이 더 있다:

| # | 파일 | 관측 | 극성 |
|---|---|---|---|
| a | `final-parity-r1-apiprobe-tauri.json#auth.accountsUsage` | `[]` (0행) | 3.0 불리 |
| b | `final-parity-r1-apiprobe-electron.json#auth.accountsUsage` | 6행 실값 | 2.6.2 유리 |
| c | `final-parity-r2-apiprobe-tauri.json#auth.accountsUsage(cachedOnly)` | **6행** | 3.0 유리 |
| d | `final-parity-r2-apiprobe-tauri-nonet.json#…(cachedOnly)` | 6행 | 3.0 유리 |
| e | `final-parity-r2-apiprobe-electron.json#…(cachedOnly)` | 「안 부른다」 | — |
| f | `final-parity-r1-blind.json` `workbar-context-pop` | 블라인드 승자 **2.6.2**(R1 tally 5승/13무/**1패**) | 3.0 불리 |

**숨긴 반대 관측은 0이다** — 빠진 6건 중 넷은 3.0에 불리하거나 중립이라 감사에게 유리한 누락이
아니다. 다만 정확히 이 표의 취지(「고르지 말고 전량을 실어라」)에 걸리는 자리가 하나 있다:
보고서 §2.6이 T3 「닫힘」의 근거로 인용하는 **「`accounts-usage(cachedOnly)`가 네트워크 0회로
6행」이 바로 위 (c) — 표에 없는 관측**인데 각주는 표의 `#7`(=`usage.get` 행)을 가리킨다.

- 재현: `node C:\Temp\ccg-r28f-auditcrit\crit-obs.mjs C:\Code\AgentCodeGUI` →
  `감사 3계열(A~D) 관측 수 = 27 | 내가 추가로 찾은 관측(E,F) = 6`.
- 처방: 수집기에 `auth.accountsUsage*`와 `final-parity-r1-blind.json`을 더하거나, 표 제목을
  「한도 축 **세 계열** 관측 전량」으로 좁혀라. 그리고 §2.6의 각주를 (c)로 고쳐라.

### F3 · 낮음 — §7.2 표의 한 칸이 3.0에 없는 호출부를 가리킨다

`codex-auth:set-default-account` 행의 「앉는 자리 = `setCxAccounts`」는 3.0에 해당하지 않는다.
`app/src/components/Settings.tsx` 전체에서 `codexAuth.setDefaultAccount` 호출은 **0회**다
(같은 파일 `:495`는 클로드 축 `auth.setDefaultAccount`). 그 자리는 3.0에서 `reorderAccounts`로
돌아간다(`:524-525` 주석 · `:537`). 2.6.2 쪽은 진짜로 부른다
(`src/renderer/src/components/Settings.tsx:429` → `setCxAccounts`). 나머지 네 행
(login · logout · reorder · `app:open-directory`)은 내 실측과 일치한다.

### F4 · 낮음 — 인용 줄 번호 두 개

- `nsis/hooks.nsh:26`으로 적은 `!define CCG3_DIRSHELL "…\shell\AgentCodeGUI3"`은 실제로 **:28**이고
  값은 `Software\Classes\Directory\shell\${CCG3_KEY}`다(:26은 `CCG3_VERB`). 실체는 사실.
- `final-parity-r3-rawprobe.json`의 키 `"shim:app.openDirectory 구독자"`는 실제로
  `onOpenDirectory`다 — 런타임에서 `window.api.app.openDirectory`는 **undefined**다.
  본문(§3)은 옳게 적었으므로 증거 파일의 라벨만 어긋난다.

### 범위 밖으로 남는 것(내 판정에도 격차 아님)

- N1·N2 — SHIPBLOCK 갈래가 수정 중. 감사는 안 건드렸고 나도 안 건드렸다. 내 baseline exe에서
  둘 다 **그대로 산다**(N1은 §3.1로 재현).
- 2.6.2의 `CCG_HOME` 무시(§4.4) — 2.6.2 쪽 성질. 3.0 회귀 아님. 다만 R1·R2의 계정·한도 A/B가
  **비대칭 비교였다**는 감사의 자기 고발은 정확하고, 그 재측정은 다음 라운드 몫이다.

---

## 6. 종합

| 체크리스트 | 결과 |
|---|---|
| 1) 정정 셋 반영 · 근거 사실성 | ✅ 반영됨 · 근거 6/6 사실 (인용 나사 F3·F4) |
| 2) 재측정 실재 · `hasNoData` 안정 · 분류 근거 | ⚠ 앞 둘 ✅(내 12주행 재현) · **셋째 ⛔**(F1 — 판별력 0) |
| 3) 숙제 (b) 전량 수록 | ⚠ 3계열 27건은 **완전 일치** · **동축 6건 표 밖**(F2) · 숨긴 반대 관측 **0** |
| 4) 숙제 (c) 같은 시각·같은 트리 | ✅ **확정** — 6주행 T=E · 통제에서 40→42 동반 이동 |
| 5) 두 수 병기 | ✅ §1·§5·§8 |
| 6) 범위 밖 오분류 · 기준 파일 무손상 | ✅ `git diff` 비어 있음 · 삭제 0줄 |
| 7) 코드 수정 0 | ✅ 두 커밋 전부 `docs/critic/` |

**감사 자체의 판정: 통과. 단 두 칸을 고쳐야 한다** — ① 숙제 (a)를 닫은 것은 재측정이 아니라
소스 독해라고 적고(F1), ② 「전량」의 범위를 정직하게 좁히거나 넓혀라(F2).
**출하 판정은 감사와 같다 — 치명 2(N1 Codex 계정 축 · N2 에러 안전망 부팅 루프). 출하 불가.**

---

## 7. 내가 만진 것

- 레포: **이 파일 하나**(`docs/critic/r28f-audit-critic-r1.md`). 코드 수정 **0** · 기준 결과 파일 **0**.
- 레포 밖(재현용 · 정리 안 함): `C:\Temp\ccg-r28f-auditcrit\` —
  `wt`(아카이브 트리) · `target`(새 CARGO_TARGET_DIR) · `crit-harness.mjs` · `crit-obs.mjs` ·
  `crit-probe.json` · `crit-limitpop-{tauri,electron}-{seeded,bare}.json` ·
  `crit-explorer.json`(레포 재주행) · `crit-explorer-control.json`(통제) ·
  `crit-homecheck-{electron,tauri}-{ccghome,userprofile}.json` · `crit-apitree-{tauri,electron}.json` ·
  `crit-obs.json` · `channels.txt` · `cargo.log` · `tc-{node,web,app}.log` · `home-*`(28개) · `uprof-*`
