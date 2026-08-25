# R28g AUDIT3 확인 크리틱 R1 — 계기는 진짜로 켜졌고 출하 차단 둘은 내 손에서도 풀린다. 그런데 「화면 축에 하나 남았다」는 내 스캐너로 세면 둘이다

판정자: R28g AUDIT3 확인 크리틱 R1 · 2026-08-25 · `feature/3.0.0-beta` @ `bb59c35`
대상: `docs/critic/final-parity-r5.md`(커밋 `03b7423` + 잔손질 `a323b45`) · 감사가 새로 쓴 계기 넷
규율: 빌더의 보고서·커밋 메시지를 근거로 쓰지 않았다. **내 트리에서 빌드하고, 내 계기를 새로 쓰고,
내 격리 홈에서 주행해 수치로 판정했다.** 감사의 `critic-r28g-*.mjs`는 **한 줄도 안 물려받았다**(§0.3).
**나는 레포 코드를 한 글자도 안 고쳤다 — 이 판정문 한 파일만 쓴다.**

---

## 0. 무엇으로 쟀나

### 0.1 측정 재료 (전부 내 것)

| 항목 | 값 |
|---|---|
| 판정 트리 | `git archive HEAD`(**`bb59c35`**) → `C:\Temp\ccg-r28g-audit3-crit\wt` (`git worktree` 미등록 · 공유 `.git` 무변 · 남의 미커밋 변경 0) |
| 의존성 | `node_modules` **정션만** (`npm ci`·`npm install` **0회** — 함정 3) |
| 프론트 | `npm run app:build` — vite **✓ 2.16s** · exit 0 · 내 번들 `index-BPsSgm_L.js`·`FileModal-Cz_dR_N7.js` |
| 셸 | `cargo build --release --features custom-protocol` · `CARGO_TARGET_DIR=C:\Temp\ccg-r28g-audit3-crit\target` (**새 디렉터리** — 함정 11) · **2m34s** · **경고 0** · exit 0 |
| **내 판정 exe** | **6,600,704 B** · sha256 `5a4a29c2dba646174200bb6931b9164d0cf69b32653b0c1fd360fa3171b93f64` |
| `custom-protocol` 증표 | 방금 구운 내 vite 번들 이름 두 개가 exe 바이트 안에 있다(`index-BPsSgm_L.js` FOUND · `FileModal-Cz_dR_N7.js` FOUND · 감사의 `index-BqARnKoK.js`는 **없다** = 서로 다른 빌드다) |
| 게이트 테스트 target | `C:\Temp\ccg-r28g-audit3-crit\target-test` (**또 새 디렉터리** · debug 전체 재컴파일) |
| 대조군 exe(참조) | 감사가 구운 SABD `C:\Temp\ccg-r28g-audit\target-sabd\release\agentcodegui.exe` — **내 하네스로** 다시 눌렀다(§3.2) |
| 격리 홈 | `C:\Temp\ccg-r28g-audit3-crit\home-*` **13개**. **실홈을 한 바이트도 안 읽었다** — 내 홈 빌더는 `%USERPROFILE%\.agentcodegui`의 `accounts*.json`·`Local State`·`engines`를 **복사도 정션도 안 한다**(감사의 `makeFixtureHome`은 복사한다 — 그래서 안 썼다) |
| CDP 포트 | **10670 / 10671 / 10672 / 10673 / 10674** (배정표 AUDIT3 10620~ + 크리틱 +50 준수) |
| 프로세스 | 이름 기반 kill **0회** — 내가 스폰한 PID만(`killTree(pid)`). 주행 뒤 `Win32_Process` 전수: 내 target 경로의 잔류 **0**(살아 있는 것은 사용자 설치본 5개 + 다른 갈래 target 2개) |
| 네트워크 | 전 주행 `CCG_NO_NET=1` · 합성 계정은 `@example.invalid` · OAuth 왕복 **0회** · 토큰 회전 유발 **0** |
| typecheck | `typecheck:node` **exit 0** · `typecheck:web` **exit 0** · `typecheck:app` **exit 0** |

### 0.2 내 계기 (신규 · 레포 밖)

레포를 안 더럽히려고 전부 `C:\Temp\ccg-r28g-audit3-crit\tools\`에 뒀다.

| 파일 | 무엇을 |
|---|---|
| `crit-channels.mjs` | 계약면 독립 스캐너. `protocol.ts`의 `IPC`를 **중괄호 매칭**으로 잘라 읽고, `ipc/mod.rs`의 `pub mod ch`에서 상수표를 만든 뒤, **주석을 직접 제거한** Rust 전 소스와 대조한다. `ch` 정의 블록은 스스로를 impl로 세지 않게 잘라낸다 |
| `crit-run.mjs` | UI 주행. 내 홈 빌더 · 내 스폰 · 내 셀렉터. 팔 넷: `pop`(계기 극성) · `n1`(Codex 계정 축) · `n2`(렌더 예외 부팅) · `chan`(스캐너의 런타임 보정) |

### 0.3 감사의 하네스를 안 물려받았다는 증표

* 홈: 감사는 `bench/fixture.mjs makeFixtureHome`(실홈 `accounts.json`·`Local State` 복사 후 삭제) — 나는 **직접 쓴 6파일짜리 홈**(복사 0).
* 픽스처: 감사는 470메시지 벤치 스레드 — 나는 2메시지 채팅 + 폭탄 채팅 3개.
* 계정: 감사는 `authEnc`(base64 JWT)까지 심는다 — 나는 `codex.rs:list_accounts`가 `plan`을 스토어에서 먼저 읽는다는 것을 **소스에서 확인**하고 `{email, plan}`만 심었다(복호 경로를 안 탄다).
* 스텁 주입 방식·재조회 방아쇠·팝오버 개폐 helper·정착 폴링 전부 내가 새로 썼다.
* 다만 CDP 미니 클라이언트(`bench/lib.mjs`의 `Cdp`/`cdpTargets`/`killTree`)는 **배관**이라 재사용했다. 판정 로직은 한 줄도 안 들어 있다.

---

## 1. 한 문단 결론

**감사가 인정한 계기 결함은 진짜로 고쳐졌다.** 내가 새로 쓴 계기로 `getUsage`를 pct 42/43/44 스텁으로
갈고 제품 경로(설정 열었다 닫기)로 재조회를 태우니 **3/3에서 팝오버가 5행이 되고 화면에 「58% 남음 ·
56% 남음 · 57% 남음」이 떴다.** 같은 화면에서 R4가 쓴 정규식 `/42|43|44/`는 **false**다 — 「가설이 참인
세계에서도 안 켜진다」가 내 손에서도 실행으로 증명됐다. **출하 차단 둘도 내 exe·내 격리 홈에서 화면을
눌러 재현했다** — 「맨 위로」는 27~29ms에 정착하고 목록 2행이 유지되며 디스크가 `[two,one]`으로
뒤집힌다(3/3), 렌더 예외 카드가 뜬 상태에서도 사이드바 3행이 살아 한 클릭에 탈출한다(3/3).
파괴 대조군까지 **내 하네스로** 다시 눌러 「그 채널만 미구현이면 목록 유지 + 실패 문구」를 확인했다(2/2).
계약면 `216 / impl 206 / missing 10`은 **내 스캐너가 목록까지 똑같이** 냈고, 런타임 보정에서도 맞았다.
게이트는 내가 **6회 병렬**로 돌려도 161 전부 초록이라 감사보다 더 세게 닫힌다.

**그런데 출하 판정 표의 첫 줄이 자기 스캔과 어긋난다.** §9는 남은 10을 적어 놓고 「**`app:open-directory`
하나**가 화면 축에 남는다」로 닫았고 §9.1의 결함 표에도 그 하나만 올렸다. 남은 10에는
`app:update-check`·`app:update-install`·`app:update-event`, 즉 **앱 자동 업데이트 통로 전부**가 같이
들어 있다. 2.6.2는 셋을 다 구현하고 그 화면(`AppUpdateGate`)을 띄운다. 3.0은 **같은 화면을 그대로
싣고도 그 화면을 띄울 유일한 통로가 미구현**이라 카드가 영영 안 뜬다. 등급도 사유도 없이 빠졌다.
**→ 불합격(체크리스트 4).** 나머지 여섯 항목은 내 실측에서 전부 초록이다.

---

## 2. 체크리스트 1·2 — 계기가 고쳐졌는가 · 각 팔 3회가 돌았는가

### 2.1 ★내 스텁 대조군 (내 exe · 내 계기 · 3회)

`window.api.getUsage`를 `{fiveHour:{pct:42}, weekly:{pct:43}, weeklyFable:{pct:44}}` 스텁으로 갈고,
**제품 경로**(`.sb-foot`로 설정 열기 → `.smh-close`로 닫기 → `App.tsx:585` `getUsage(true)`)로
재조회를 태운 뒤 워크바 컨텍스트 팝오버를 다시 열었다.

| 팔 | n | `prows` | 데이터 없음 | **`seesRemain`(58/57/56)** | `seesPlanted`(42/43/44%) | **R4의 `/42\|43\|44/`** | 스텁 주입 |
|---|---|---|---|---|---|---|---|
| 3.0 `bare` | **3** | **4** | true | ✗ | ✗ | ✗ | — |
| **3.0 `stub`** | **3** | **5** | **false** | **✓ 3/3** | ✗ | **✗ 3/3** | `ok:defineProperty` 3/3 |

내가 읽은 실제 행(run1~3 동일):

```
5시간 한도 59분 후 초기화 58% 남음
Fable 주간 한도 2일 23시간 후 초기화 56% 남음
주간 한도 2일 23시간 후 초기화 57% 남음
```

**심은 42/43/44가 화면에 58/56/57로 떴다.** 그리고 **바로 그 화면에서 R4의 정규식은 false**다.
= 「고친 칸은 켜지고 옛 칸은 못 켜진다」가 내 손에서 실행으로 확인됐다. §2.3의 감사 주장 그대로다.

### 2.2 감사의 30주행이 실제로 있는가 (증거 파일 직독)

| 파일(10개) | n | `prows/hasNoData/seesRemain/R4정규식` |
|---|---|---|
| `…-tauri-{synth,noacct}-{seeded,bare}.json` (4) | 각 **3** | `4/true/false/false` 전부 |
| `…-electron-{synth,noacct}-{seeded,bare}.json` (4) | 각 **3** | `4/true/false/false` 전부 |
| `…-tauri-stub.json` | **3** | **`5/false/true/false`** ← 판별력 증거 |
| `…-electron-stub.json` | **3** | `4/true/false/false`(스텁 실패 — 미계측으로 적혀 있다) |

**각 팔 3회 · 합 30주행이 파일에 있다.** 스텁 대조군은 §2.3 표와 §2.4 표에 **둘 다** 실려 있다.
그리고 `tauri-stub` 3행은 내가 방금 잰 값과 **문자 그대로 같다**(`5 / false / true / false`).

### 2.3 §2.4의 틀린 예측 문장 정정 — 됐다(다만 자리는 안 옮겼다)

`final-parity-r4.md:1`에 정정 헤더가 새로 붙었고 §2.4·부록 A·§7을 **이름으로 지목**해 정정한다.
R5 부록 A는 고쳐 읽을 문장을 원문/정정 대비표로 싣는다. → **정정됐다.**
다만 `final-parity-r4.md:160`의 「…42/43/44가 보인다」와 `:162`의 표 헤더 「42/43/44 보임」은
**그 자리에 표식 없이 그대로**다. 파일 중간부터 읽는 사람은 틀린 예측을 그대로 읽는다(§5 · 낮음).

---

## 3. 체크리스트 3 — 출하 재판정이 **내가 눌러도** 같은 값인가

### 3.1 N1 「맨 위로」 — 내 exe · 내 합성 계정 둘 · 3회

합성 스토어 `{version:1, defaultEmail:one, accounts:[one(plus), two(pro)]}` (237 B) ·
설정 ▸ Account ▸ OpenAI에서 두 번째 행의 「맨 위로」를 **화면에서** 눌렀다.

| | run1 | run2 | run3 |
|---|---|---|---|
| 클릭 → 화면 정착 | **28 ms** | **27 ms** | **29 ms** |
| OpenAI 목록 | **2행 유지**(증발 0) | 2행 | 2행 |
| 새 0번 · 배지 `기본 · 맨 위` | `crit-two` | 〃 | 〃 |
| 디스크 순서 | **`[two, one]`** | 〃 | 〃 |
| 디스크 `defaultEmail` | **`crit-two`** | 〃 | 〃 |
| 디스크 크기 | 237 → **237 B**(순서만 뒤집힘) | 〃 | 〃 |
| 실패 문구 | 없음 | 없음 | 없음 |
| 원시 `codex-auth:list-accounts` | `array:2` (비-`__unimplemented`) | 〃 | 〃 |
| 원시 `codex-auth:login-cancel` | `null` (비-`__unimplemented`) | 〃 | 〃 |

→ 감사의 21~23ms·`[two,one]`·`defaultEmail=two`·2행 유지가 **내 손에서도 같은 방향으로 재현된다**
(절대값 차이는 픽스처 크기 차이 — 감사는 470메시지 스레드, 나는 2메시지).

### 3.2 ★파괴 대조군을 **내 하네스로** 다시 눌렀다 (2/2)

감사가 구운 SABD exe(`CODEX_SET_DEFAULT_ACCOUNT` 팔 하나만 제거 · sha256 `928e0fbb…` — 파일이
실제로 그 해시로 존재함을 확인)를 **내 하네스**에 물렸다:

| | 내 판정 exe | SABD |
|---|---|---|
| 원시 `codex-auth:list-accounts` | `array:2` | `array:2`(다른 채널은 멀쩡) |
| 「맨 위로」 후 화면 | `[two, one]` · **2행** | **`[one, two]` 2행 유지**(증발 0) |
| 화면 문구 | 없음 | **「순서를 바꾸지 못했어요 — 앱을 재시작한 뒤 다시 시도해 주세요」** |
| 디스크 | `[two,one]` · `defaultEmail=two` | **무변** `[one,two]` · `defaultEmail=one` |
| 정착 | 27~29ms | **정착 없음**(`settleMs=null`) |

**「빈 배열이 목록 setter에 안 앉는다 + 실패가 화면에 보인다」가 내 계기에서도 갈린다.**
= 감사의 §3.4는 위약 대조군이 아니다.

### 3.3 N2 렌더 예외 부팅 — 3회 (내 픽스처: `text`가 객체인 폭탄 채팅)

| 상태 | run1 | run2 | run3 |
|---|---|---|---|
| 1 부팅(활성=멀쩡) | `eb0 sb3 win1 chat1` · disk `crit-good` | 〃 | 〃 |
| 2 폭탄 선택 | **`eb1` · `sb3` · `win0` · `chat0`** | 〃 | 〃 |
| 3 사이드바로 탈출 | **`eb0` · `sb3` · `win1` · `chat1`** | 〃 | 〃 |
| 4 재시작 | `eb0 sb3 win1 chat1` · disk `crit-good` | 〃 | 〃 |

* **감옥이 아니다** — 카드가 뜬 상태에서 사이드바 3행이 살아 있고 한 클릭에 나온다(3/3). 감사의 판정과 같다.
* **`win 0`도 내 손에서 재현된다** — 카드가 뜨는 순간 창 컨트롤이 사라진다. 감사가 R28f SHIPBLOCK
  크리틱 표의 `win 1`을 틀렸다고 고친 것은 **옳다**.
* **재현 못 한 것 하나(반박 아님)**: 감사의 N7(「재시작 #1에 카드가 한 번 더」)은 내 3회에서 안 났다.
  내 주행에서는 폭탄 선택 뒤에도 디스크 `activeChatId`가 계속 `crit-good`이라(저장 디바운스가 내
  스냅샷 시점보다 늦다) **폭탄이 활성인 채로 죽는 판 자체가 안 만들어졌다.** 감사의 관측을
  부정하지 않는다 — 내 표본이 그 조건을 못 만들었을 뿐이다.

---

## 4. 체크리스트 4 — `missing 10`의 목록 · 그중에 출하 차단이 있는가

### 4.1 목록은 맞다 (내 스캐너 · 독립 구현)

```
node crit-channels.mjs --tree=C:\Temp\ccg-r28g-audit3-crit\wt
  → total 216 · impl 206 · missing 10
missing = app:open-directory · app:update-check · app:update-event · app:update-install
          talk:bg-task · talk:cancel · talk:event · talk:permission-respond
          talk:question-respond · talk:run
```

감사의 `216 / 206 / 10`과 **총계도 목록도 완전히 같다.** 런타임 보정(`chan` 팔 · 내 exe):

| 원시 `ipc_call` | 결과 | 스캐너 판정 |
|---|---|---|
| `app:get-version` | `"3.0.0-beta.1"` | impl ✓ |
| `auth:list-accounts` | `[]` | impl ✓ |
| `app:update-status` | `{"phase":"idle",…}` | impl ✓ |
| **`app:update-check`** | **`{"__unimplemented":true}`** | missing ✓ |
| **`app:update-event`** | **`{"__unimplemented":true}`** | missing ✓ |
| **`app:open-directory`** | **`{"__unimplemented":true}`** | missing ✓ |
| `ccg:no-such-channel-crit`(음성 대조) | `{"__unimplemented":true}` | — |

(`talk:*` 여섯과 `app:update-install`은 **일부러 안 눌렀다** — 전자는 M10 소유이고 엔진을 띄울 수
있으며, 후자는 구현돼 있다면 앱을 종료시킨다. 정적 결론만 인용한다.)

### 4.2 ★그런데 남은 10의 **등급 매김이 비었다** — 이 라운드의 불합격 사유

§9 첫 줄: 「남은 10 = `talk` 여섯(M10·미결) + `app` 넷」 → 판정 「거의. 다만 아니다 —
**`app:open-directory`(N3) 하나**가 화면 축에 남는다」. §9.1 결함 표에도 `app` 넷 중 **하나만** 있다.

나머지 셋 = **앱 자동 업데이트 통로 전부**다. 코드로 확인한 사실:

```
2.6.2  src/main/index.ts:1899  ipcMain.handle(IPC.updateCheck,  … checkForUpdates())
       src/main/index.ts:1900  ipcMain.handle(IPC.updateInstall, … quitAndInstall())
       src/main/index.ts:2145  initAutoUpdater((e) => send(IPC.updateEvent, e))
       src/main/updater.ts     (electron-updater 본체)
       src/renderer/src/components/AppUpdateGate.tsx  ← 화면이 있다

3.0    app/src/components/AppUpdateGate.tsx           ← **같은 화면을 그대로 싣는다**
         :29  getUpdateStatus()  → 셸이 하드코딩 idle을 준다
         :30  onUpdateEvent(setStatus) → 이 채널이 **미구현**이라 영영 안 온다
         :108 installUpdate()   → 채널 미구현
       src-tauri/src/ipc/app_meta.rs:20  "앱 자동 업데이트(electron-updater 자리)는 아직 없다 — 정직하게 idle"
       src-tauri/tauri.conf.json          plugins {} · updater 없음 (대체 통로도 없다)
```

`AppUpdateGate`는 `phase`가 `available|downloading|downloaded|error`일 때만 뜨는데 그 값을 넣어 줄
방출자가 0이므로 **카드는 어떤 경로로도 뜰 수 없다.** 즉 3.0은 **화면을 싣고도 그 화면이 죽어 있는**
상태이고, 이것은 §9 첫 줄의 판정 기준(「기존 기능을 **화면 단위**로 빠뜨리지 않았는가」)에 정확히
걸리는 칸이다. **그런데 등급도, 「결함이 아니다」라는 사유도 없다.**

* **출하 차단인가**: 크래시·데이터 손실이 아니므로 나는 **치명으로는 안 센다.**
  다만 **N3와 같은 등급(높음)**이 마땅하다 — N3보다 오히려 넓다. N3는 「이미 떠 있을 때 우클릭 열기」
  한 동작이고, 이쪽은 **출하된 사용자가 앱 안에서 새 버전을 알 수도 받을 수도 없다**(3.0.0으로
  나가면 다음 버전은 수동 재설치뿐).
* **판정에 미치는 영향**: 「치명 0」은 안 흔들린다. **흔들리는 것은 §9 첫 줄의 문장과 §9.1 표의
  완결성**이다. 출하 재판정을 간판으로 건 라운드에서 남은 결함 목록이 자기 스캔과 어긋나면,
  그 표를 읽고 출하를 결정하는 사람이 **없는 안전을 산다.**

---

## 5. 체크리스트 5 — 게이트 플레이크와 M10을 어떻게 취급했나

### 5.1 게이트 — 감사보다 **더 세게** 닫힌다 (내 실측)

`git archive HEAD`(`bb59c35`) 트리 · **새** `CARGO_TARGET_DIR=…\target-test`(함정 11):

```
직렬 3회  cargo test -p agentcodegui --bin agentcodegui
  RUN 1 → ok  161 passed; 0 failed  exit 0
  RUN 2 → ok  161 passed; 0 failed  exit 0
  RUN 3 → ok  161 passed; 0 failed  exit 0

★병렬 6회 (같은 테스트 바이너리를 동시에 6개 — 원래 플레이크의 조건이 「부하 의존」이었다)
  6/6 → ok  161 passed; 0 failed   전부 exit 0
```

* 감사는 「기준선 `2071c36`에서 3회 중 2붉음 → `c2f828d` 뒤 4/4 초록」을 **직렬로만** 쟀다.
  나는 **원래의 부하 조건(병렬)** 으로 6회 더 돌려 초록을 봤다. → `G-1` 해소는 옳고, 근거가 더 두껍다.
* 취급도 옳다 — 감사는 처음에 이것을 **치명에 안 넣고 「높음 · 출하 전 초록 필수」**로 남겼고,
  옆 갈래가 닫은 **뒤에** 새 트리·새 target에서 다시 재고 나서야 해소로 고쳤다.
  **「닫혔다」로 밀어 넣지 않았다.**
* 나도 감사도 `cargo test --workspace` 전수는 안 돌렸다(함정 10대로 이 크레이트만 셌다 — 161).

### 5.2 M10 — 등급 없이 분리했다 (옳다)

감사는 `talk:*` 여섯을 **치명/높음/낮음 어디에도 안 넣고** 「미결 · 사용자 대기」로 분리했고,
「그 축을 실측하지 못했으므로 등급을 매길 자격이 없다」고 사유를 적었다. `C:\Temp\ccg-m10-live`
홈으로 아무것도 안 돌렸다는 진술과 이 라운드의 증거 파일 목록이 어긋나지 않는다(그 홈을 쓰는
산출물이 없다). → **둘 다 「닫혔다」로 밀어 넣지 않았다. 합격.**
(참고로 2.6.2는 `src/main/index.ts:1128-1129`에서 `talk:run`·`talk:cancel`을 실제로 구현한다 —
이 축이 2.6.2에 있고 3.0에 없다는 감사의 전제는 사실이다.)

---

## 6. 체크리스트 6·7 — 범위·무손상·코드 수정 0

| 확인 | 명령 | 결과 |
|---|---|---|
| 기준 결과 파일 무손상 | `git diff --stat -- bench docs/critic bench/results` | **비어 있음** |
| 커밋의 삭제 줄 | `git show 03b7423 --numstat` | 26파일 **+9,293 / −0** |
| 〃 | `git show a323b45 --numstat` | 1파일 +37 / −2 (**자기 파일 `final-parity-r5.md` 안**) |
| 코드 수정 0 | 두 커밋 `--name-only` | **전부 `docs/critic/**`** — `src-tauri/`·`crates/`·`app/`·`src/` **0파일** |
| 남의 칸 접촉 | 두 커밋 파일 목록 | `final-parity-*.md`·`docs/critic/tools/**`·`final-parity-r5-*.json` = **AUDIT3 소유 범위 안** |
| 감사 exe 실재 | `sha256sum` | `a36ef577…` 6,596,096 B ✓ · SABD `928e0fbb…` 6,595,584 B ✓ (**보고서 숫자와 바이트까지 일치**) |
| 관측 「전량 92건」 | 부록 B 표 파싱 | **92행** · 계열 분포 `A4 B7 C6 D12 E5 F7 G1 H20 I30` = §8 집계와 일치 · `final-parity-r5-observations.json`도 **92건** |
| 탐색기 동시측정 | `final-parity-r5-explorer.json` | 2라운드(기동 순서 교대) · **T 125 / E 125** · 루트 131 · 차집합 0 — 파일이 실재하고 본문과 일치 |
| 범위 밖 오탐 | N6·N7 | **없다** — 둘 다 「2.6.2도 같다 = 회귀 아님」을 스스로 적고 낮음으로 뒀다. `win 0`은 내 실측과 일치 |

→ **체크리스트 6·7 전부 초록.** 감사자는 코드를 안 만졌다.

---

## 7. 판정표

| # | 체크리스트 | 내 실측 | 판정 |
|---|---|---|---|
| 1 | 계기가 고쳐졌는가 · §2.4 정정 | 내 스텁 3/3 → `prows 5` · 「58/56/57% 남음」 · `seesRemain=true` · R4 정규식 `false` / R4 헤더 정정 있음 | ✅ |
| 2 | 각 팔 3회 재측정 · 판별력 증거 | 증거 파일 10개 × n=3 = 30 · 스텁 대조군이 §2.3·§2.4 표에 있음 | ✅ |
| 3 | 출하 재판정이 감사 자신의 실측인가 · 내가 눌러도 같은가 | N1 3/3(27~29ms · 2행 · `[two,one]` · `def=two`) · SABD 대조군 2/2 · N2 3/3(`eb1 sb3` → 탈출) | ✅ |
| 4 | `missing 10` 목록 · 남은 10의 출하 영향 | 목록은 **내 스캐너·런타임 보정 둘 다 일치**. **그러나 `app:update-{check,install,event}`가 등급 없이 빠졌다 — §9 첫 줄이 자기 스캔과 어긋난다** | ❌ |
| 5 | 게이트·M10 취급 | 게이트: 직렬 3/3 + **병렬 6/6** 초록(161) · M10: 등급 없이 미결 분리 | ✅ |
| 6 | 범위 밖 오탐 · 기준 파일 무손상 | `git diff` 비어 있음 · 삭제 0줄 · 오탐 0 | ✅ |
| 7 | 코드 수정 0 | 두 커밋 전부 `docs/critic/**` | ✅ |

**결과: 불합격(1항목).** 나머지 여섯은 내 계기·내 exe·내 홈에서 전부 초록이다.

---

## 8. 남은 결함

### C-1 〈높음〉 출하 판정 표가 앱 자동 업데이트 축을 **등급 없이** 빠뜨렸다

* **어디**: `docs/critic/final-parity-r5.md` §9 첫 줄(「`app:open-directory`(N3) **하나**가 화면 축에
  남는다」) · §9.1 결함 표(`app` 넷 중 하나만 등재).
* **사실**: 같은 문서 §3.3의 `missing 10`에 `app:update-check` · `app:update-install` ·
  `app:update-event`가 들어 있다. 3.0은 `AppUpdateGate` 화면을 싣고도 그 화면을 띄울 방출자가
  0이라 카드가 뜰 수 없고, 「업데이트」 버튼도 미구현 채널을 부른다. 2.6.2는 셋 다 구현한다.
* **재현(내가 한 그대로 · 3분)**:
  1. `node C:\Temp\ccg-r28g-audit3-crit\tools\crit-channels.mjs --tree=<HEAD 트리>`
     → `missing` 목록에 `app:update-check`·`app:update-install`·`app:update-event`가 있다.
  2. 격리 홈으로 3.0을 띄우고 CDP에서
     `__TAURI_INTERNALS__.invoke('ipc_call',{channel:'app:update-check',payload:[]})`
     → **`{"__unimplemented":true}`** (`app:update-event`도 같다. 대조: `app:update-status`는
     `{"phase":"idle",…}`, `app:get-version`은 `"3.0.0-beta.1"`).
  3. `grep -n "IPC.updateCheck\|IPC.updateInstall\|IPC.updateEvent" src/main/index.ts`
     → `:1899` · `:1900` · `:2145` (2.6.2는 있다).
* **처방(권고 · 나는 코드를 안 고친다)**: §9.1 표에 「앱 자동 업데이트 통로 부재(3채널)」를 **높음**으로
  한 줄 올리고, §9 첫 줄의 「하나가 남는다」를 「둘이 남는다(+ M10 축은 미결)」로 고친다.
  결함을 없애라는 게 아니라 **판정문이 자기 스캔과 같은 말을 하게** 하라는 것이다.

### C-2 〈낮음〉 R4의 틀린 예측이 **그 자리에는** 아직 남아 있다

* `docs/critic/final-parity-r4.md:160` 「닿으면 팝오버는 5행이고 **42/43/44가 보인다**」 ·
  `:162` 표 헤더 「42/43/44 보임」. 정정은 `:1` 헤더와 R5 부록 A에만 있다.
* 재현: 그 파일을 160행부터 읽는다. 정정 표식이 없다.
* 처방: 그 두 줄 옆에 한 줄 표식(「※ R5 §2.3 — 이 칸은 판별력 0. 정정: 58/57/56」).

### C-3 〈정보〉 이 크리틱이 **안 잰 것**(정직하게)

* 2.6.2 쪽은 한 번도 안 띄웠다 — 팝오버 파리티·`contextBridge` 스텁 문제는 감사의 진술을 그대로 뒀다.
* 탐색기 동시측정(T/E 125)은 **증거 파일 실재·본문 일치**까지만 확인했고 재주행은 안 했다.
* `talk:*` 여섯과 `app:update-install`은 원시 호출을 **일부러 안 했다**(엔진 기동·앱 종료 위험).
* `cargo test --workspace` 전수 0 · 실 OAuth 왕복 0 · M10 라이브 0.
* 감사의 N7(재시작 #1 카드 재현)은 내 3회에서 조건이 안 만들어져 **미재현**(반박 아님 · §3.3).

---

## 9. 내가 만진 것

| 대상 | 무엇 |
|---|---|
| `C:\Code\AgentCodeGUI\docs\critic\r28g-audit3-critic-r1.md` | **이 판정문 하나** (신규) |
| 레포 코드(`src-tauri/`·`crates/`·`app/`·`src/`·`bench/`·`out/`·`dist/`) | **0파일 · 0줄** |
| 남의 미커밋 변경(`crates/ccg-engine/src/runtime.rs`·`src-tauri/src/engine/{hub,talk}.rs`) | **접촉 0** — `reset`·`checkout`·`stash`·`restore` 0회 |
| 남의 미추적 계기(`crates/ccg-engine/tests/probe_wfire_crit.rs`·`probe_wfr2.rs`) | 커밋 안 함 · 테스트 수 집계에서 제외(내 161은 `-p agentcodegui --bin agentcodegui`) |
| 기준 결과 파일(`bench/**`·`docs/critic/*.json`) | **덮어쓰기 0** — 내 산출물은 전부 레포 밖(`C:\Temp\ccg-r28g-audit3-crit\`) |
| 실홈(`%USERPROFILE%\.agentcodegui`) | **읽기·복사·수정 0** — 내 홈 빌더가 실홈을 참조하지 않는다 |
| 프로세스 | 이름 기반 kill 0 · 내가 스폰한 PID만 · 잔류 0 |

레포 밖 재현 재료: `C:\Temp\ccg-r28g-audit3-crit\` — `wt`(아카이브 트리) · `target`(판정 exe) ·
`target-test`(게이트) · `tools\crit-{channels,run}.mjs` · `home-*`(13) ·
`crit-{pop,n1,n1-sabd,n2,chan}.json` · `chan-head.json` · `par-*.log`.

— R28g AUDIT3 확인 크리틱 R1 (Claude Fable 5)
