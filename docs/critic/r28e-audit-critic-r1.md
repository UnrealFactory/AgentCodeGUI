# R28e AUDIT 확인 크리틱 R1 — 열여섯 중 열넷은 내 손에서도 닫혔다. 그런데 「역전」이라고 적은 한 칸은 감사 자신의 증거가 반대로 말한다

판정자: R28e AUDIT 확인 크리틱 R1(새 컨텍스트) · 2026-08-25 · `feature/3.0.0-beta` @ `9aa75b5`
대상: `docs/critic/final-parity-r2.md`(커밋 `953b847` · 잔손질 `e9ddb57`)
판정 원칙: 감사 보고서·커밋 메시지를 **근거로 쓰지 않았다**. 열여섯 항목 중 열둘 + 신규 격차 다섯을
**내가 다시 구운 exe**로 다시 눌렀다.

---

## 0. 내가 무엇으로 쟀나 — 감사와 **다른** exe, **다른** 홈, **다른** 포트

| 항목 | 값 |
|---|---|
| 판정 트리 | `git archive HEAD`(`9aa75b5`) → `C:\Temp\ccg-critr28e\wt` (`git worktree` 미등록 · 공유 `.git` 무변) |
| 의존성 | `node_modules` 정션만 (`npm ci`·`npm install` **0회**) |
| 프론트 | `npm run app:build` (vite 2.16s) |
| 셸 | `cargo build --release --features custom-protocol` · `CARGO_TARGET_DIR=C:\Temp\ccg-critr28e\target` (**새 디렉터리** — 함정 11 회피) · 2m53s · 경고 0 |
| 산출 exe | `C:\Temp\ccg-critr28e\target\release\agentcodegui.exe` · 6,545,408 B · sha256 `efb56c57e4d5387b…` |
| 2.6.2 | `node_modules/electron/dist/electron.exe` + 커밋된 `out/`(읽기만) |
| 홈 | 주행마다 격리(`C:\Temp\ccg-critr28e\home{,-cx,-eb,-eb-e,-btw,-btw2,-misc,-od,-od-e}`) |
| CDP 포트 | 10441~10449 (다른 갈래와 무충돌) |
| 프로세스 | 이름 기반 kill **0회** — 내가 스폰한 PID만 |

감사의 exe는 `0bbd1826…`(6,507,008 B @ `72a142d`), 내 exe는 `efb56c57…`(6,545,408 B @ `9aa75b5`)다.
**다른 커밋 · 다른 바이너리에서 같은 결론이 났다** — 그 사이에 착지한 `61d818a`(WFIRE) ·
`b6c559b`·`9aa75b5`(CASX2)가 이 라운드의 판정을 흔들지 않는다는 뜻이기도 하다.

### 안전 규약 — 감사보다 **더** 좁게 갔다

픽스처 홈에 실홈 `accounts.json`·`codex-accounts.json`을 **복사하지 않았다**(감사는
`bench/fixture.mjs`를 그대로 써서 복사한다). `engines`·`codex-engines` 정션과
`config.json` 복사만 했다. 그래서 로그인·로그아웃·설치·정리·업데이트는 **한 번도 안 불렀고**,
실 HTTP는 **0건**이다(리프레시 토큰 회전 경로를 아예 안 열었다). Codex 계정 축은
**합성 계정 2개**(`crit-a@example.invalid`·`crit-b@example.invalid`, 토큰 없음)를 격리 홈에
심어서 봤다.

### 증거 (전부 이 라운드 산출 · 레포 밖)

`C:\Temp\ccg-critr28e\` — `probe-raw.json` · `probe-codex.json` · `probe-eb.json` ·
`probe-eb-electron.json` · `probe-btw.json` · `probe-btw2.json` · `probe-misc.json` ·
`probe-od-tauri.json` · `probe-od-electron.json` · `channels-crit.json` · `probe.mjs`(도구) ·
`cargo.log`

---

## 1. 한 문단 결론

**감사의 결론은 선다. 치명 2(N1·N2)는 내 손에서도 재현됐고, 「닫혔다」의 대부분도 진짜다.**
채널 전수 대조는 **216 / impl 198 / commentOnly 0 / missing 18**로 감사의 숫자와 **완전히 같은
목록까지 일치**했고, 기준 결과 파일은 한 바이트도 안 덮였다(감사 커밋 `953b847` = 20파일 ·
15,671 삽입 · **0 삭제**). 하네스 숙제 반영본으로 돌았다는 주장도 사실이다.

**다만 감사가 자기 등급을 두 칸 잘못 매겼다.** ① T3을 「닫힘 + **역전**」이라 적고 §5의
「블라인드에서 UI가 지지 않는가」를 그 값으로 채웠는데, **감사 자신의 증거 파일이 그 반대를
기록하고 있다.** ② N3(`app:open-directory`)의 「중간」은 낮다 — 우클릭 항목이 이미 설치기에
붙어 있고 3.0은 X를 눌러도 트레이로 상주하므로 「이미 떠 있는 앱」이 **정상 상태**다.

**출하 판정은 감사와 같다: 치명 2 · 출하 불가.**

---

## 2. 「닫혔다」 재현 — 무작위 이상으로 **열둘**을 직접 눌렀다

전부 내 exe · 내 격리 홈. `raw:`는 `__TAURI_INTERNALS__.invoke('ipc_call', …)` 원시 호출이다
(심의 안전값을 **안 거친다** — `{__unimplemented:true}`가 그대로 보인다).

| # | 감사의 주장 | 내 실측 | 판정 |
|---|---|---|---|
| **T1** | 클로드 축 7채널 산다 | `raw:auth:login-cancel` → `null` · `raw:auth:reorder-accounts` → `[]` · `raw:auth:list-accounts` → `[]` — **셋 다 `__unimplemented` 아님** | ✅ 단, §3.3 |
| **T2** | `listAvailable().latest = "0.3.245"` | `raw:engine:list-available` → `{latest:"0.3.245", versions:277개}` · 심 경유도 동일 | ✅ |
| **T3** | `usage:get` 실값 · `CCG_NO_NET`에서 `unavailable` 표식 | 계정 0인 홈에서 `usage.get(false)` → `{…nulls, unavailable:true}` — **표식은 진짜로 붙는다**. 소스도 확인: `usage_get`의 실패 폴백 `stale()`은 **메모리 캐시만** 읽는다(`ipc/parity/usage.rs:129`) = 실값이 디스크 캐시 도용이 아니라는 감사의 논증은 맞다 | ✅(닫힘) / ⛔(역전 — §3.1) |
| **T4** | `btw:open` 3표면 OK | `raw:btw:open` → `null`(정상) · CDP 타깃에 `index.html#session` **새로 생김** · 사이드바에 `"BTW - 크릿 긴 스레드"` 행 추가 | ✅ |
| **H1** | 컴포저 ＋ → 네이티브 대화상자 | `dialog:pick-attachments` 발사 → **내 PID 트리에 새 가시 창** 1개(제목 = 첨부 선택 대화상자) → WM_CLOSE로 원복, 창 목록 복귀 | ✅ |
| **H2** | MCP·Skill 실목록 | 스크래치(`.mcp.json` + `.claude/skills/crit-skill`)에서 `mcp:list` → `[{name:"crit-echo", scope:"local", transport:"stdio", enabled:true}]` · `skill:list` → `[{name:"crit-skill", description:"크리틱 확인용", …}]` | ✅ |
| **H4** | codex 모델 목록 | `codex:models` → `gpt-5.6-sol` 외 실목록(효력 등급 포함) | ✅ |
| **H5** | 닫기 flush 두 이름 + 1500ms | `win.rs:485 CloseRequested → begin_close_flush → ipc/windows.rs:51 flush_req`가 `chat:flush-req` **와** `session-wins:flush-request` 둘 다 `emit_to` · `FLUSH_GRACE 1500ms` 뒤 `destroy()` | ✅(소스) |
| **M1** | `shortcut:close` | `raw:shortcut:close` → `null`(미구현 아님) | ✅ |
| **M3** | `ui:open-api-settings` | `raw:ui:open-api-settings` → `null` | ✅ |
| **M5** | `git:ai-message` 두 앱 동일 | 비-git 폴더로 호출 → `{ok:false, error:"Git 저장소가 아니에요"}` (엔진 스폰 없이 조기 반환) | ✅ |
| **M6** | `bundled="unknown"`는 의도 | `engine:state` → `{bundled:"unknown", active:"0.3.245", installed:["0.3.245"]}` | ✅ |

### 2.1 계약면 216채널 — 도구를 내 트리에서 다시 돌렸다

```
node docs/critic/tools/critic-r28e-channels.mjs --tree=C:/Temp/ccg-critr28e/wt
→ total 216 · impl 198 · commentOnly 0 · missing 18      (감사와 동일)
missing = talk:{run,cancel,permission-respond,question-respond,bg-task,event}(6)
        + codex-auth:{login,logout,set-default-account,login-cancel,reorder-accounts}(5)
        + lsp:{pick-verse-server,set-verse-path,clear-verse-path}(3)
        + app:{update-check,update-install,update-event}(3) + app:open-directory(1)
```

`critic-r28e-surface.mjs`도 재현됐다 — `WindowApi` 184잎 중 `app/src/api/shim.ts` 누락 **0**.

**「두 앱 다 죽은 표면 6」도 사실이다.** 2.6.2 렌더러에서 `window.api.talk`의 호출부는
`src/renderer/src/App.tsx:532`·`:594`의 `getState`/`saveState` **두 줄뿐**이고, 그 둘은 3.0에
구현돼 있다(3.0도 `app/src/App.tsx:665`·`:731`에서 같은 두 줄만 부른다).

**「범위 밖」 처리도 옳다**(체크리스트 4). Verse 3채널·업데이트 3채널을 회귀로 잡지 않았고,
`settings-code-lsp`의 `found` 4 vs 5도 Verse 하나 차이임을 apiprobe가 증명한다
(`lsp.servers` T=`[ts,py,cs,cpp]` vs E=`[ts,py,cs,cpp,verse]`).

### 2.2 기준 결과 파일 — 안 덮였다 (체크리스트 5)

```
git show --stat 953b847  → 20 files changed, 15671 insertions(+), 0 deletions(-)
git diff HEAD -- bench/shots docs/critic bench/results  → (비어 있음)
git log -1 -- bench/shots/tauri/report.json  → fe1328b (R1, 2026-08-24)
```

`bench/shots/{tauri,electron}/report.json` · `docs/critic/final-parity-r1-*` 전부 **무손상**.
신규는 전부 `-r28e`·`-r2` 태그로 갈렸다.

### 2.3 A/B 재주행이 **숙제 반영본**으로 돌았는가 (체크리스트 3)

돌았다. `581a27c`(M12 R2)가 `bench/screens.mjs`에 심은 `openSettings`의 **선택 탭 검증**이
현재 트리에 그대로 있다(`screens.mjs:319-320` — `.set-nav .set-ni.on`의 텍스트가 요청 라벨과
같은지 보고 아니면 던진다). R1이 Talk·Language 탭을 찍고 통과하던 **거짓 통과 2건**은 이
검증이 있는 한 구조적으로 못 생긴다.

리포트 수치도 파일과 일치한다:

```
tauri-r28e     summary {defined:156, attempted:121, ok:120, failed:1,  skipped:35, successRatePct:99.2}
electron-r28e  summary {defined:156, attempted:121, ok:119, failed:2,  skipped:35, successRatePct:98.3}
유일 실패 T: settings-engine-confirm / E: btw-dock + settings-engine-confirm
skip 35건 — 두 앱 **완전 동일**(id·사유 문자열까지 일치, 한쪽에만 있는 skip 0건)
```

`settings-engine-confirm`의 「환경 대칭 실패」 설명도 맞다 — 내 홈에서 `engine:state`가
`installed:["0.3.245"]` **1개**를 돌려줬다(→ `oldCount = 0` → 「정리」 행이 안 그려진다).

### 2.4 §3.4의 「하네스 결함」 — 내 손에서도 그대로 재현됐다

`btw:open` 뒤 사이드바 0번 행이 `"BTW - 크릿 긴 스레드"`가 되고, `__txt`와 **같은 부분 문자열
매칭**으로 `'크릿 긴 스레드'`를 누르면 그 창 행이 먼저 걸린다:

```
substrClick      → "BTW - 크릿 긴 스레드창"   ← 창 행. 채팅은 안 바뀐다
startsWithClick  → "크릿 긴 스레드1지금"       ← 제대로 걸린다
```

즉 통짜 주행의 31화면 연쇄 실패를 3.0 회귀로 집계하지 않은 것은 **옳은 판정**이고,
숙제 §6.1-1·2(부분 일치 금지 · `selectChat`도 확인)는 정당하다.

---

## 3. 감사가 틀린 것 — 세 칸

### 3.1 ⛔ **T3 「역전 · 3.0 승」은 감사 자신의 증거와 모순된다** (등급 과장)

보고서 §2.1은 이렇게 적는다 — *「`limit-pop` press · **같은 픽스처 · 같은 시각대**」*:

```
3.0    prows=5  hasNoData=false
2.6.2  prows=4  hasNoData=true   (2회 재측정 동일)
```

그런데 **같은 홈**(`%TEMP%\ccg-r28e-press-tauri`)에서 **75초 먼저** 돈 3.0 주행이 정반대를
기록해 두었다 — 그것도 보고서가 N1의 근거로 **직접 인용하는 바로 그 파일**이다:

```
docs/critic/final-parity-r2-press-tauri.json  (06:23:29Z)
  "limit-pop": { "prows": 4, "hasNoData": true,
                 "popText": "… 5시간 한도 데이터 없음 — · 주간 한도 데이터 없음 — …" }
docs/critic/final-parity-r2-press-tauri-eb.json (06:24:45Z, 같은 홈)
  "limit-pop": { "prows": 5, "hasNoData": false }
```

보고서는 뒤엣것만 싣고 앞엣것을 **한 줄도 언급하지 않는다.**

더 나쁜 것은 **R1 기준선의 극성이 반대**라는 사실이다. 실행 순서도 같았다(둘 다 tauri 먼저):

| 라운드 | `workbar-context-pop` found | |
|---|---|---|
| R1 (`bench/shots/tauri` 03:00Z / `electron` 03:07Z) | **T=4** | **E=5** |
| R2 (`tauri-r28e` 05:51Z / `electron-r28e` 05:55Z) | **T=5** | **E=4** |

이 지표는 앱의 성질이 아니라 **그 홈의 usage 캐시 온도와 토큰 갱신 성패**를 잰다. 보고서
자신도 각주로 *「2.6.2가 이 환경에서 왜 null인지는 범위 밖 — 격리 홈에서의 토큰 갱신 실패로
보인다」* 라고 적어 놓고, 같은 값을 §5의 **「블라인드에서 UI가 지지 않는가 → 지지 않는다」**
칸에 그대로 쓴다. 환경 실패로 진단한 값을 승패로 환산하면 안 된다.

**무엇이 남고 무엇이 무너지는가**
- 남는다: `usage:get`이 실값을 준다 · `auth:accounts-usage(cachedOnly)`가 네트워크 0회로 6행을 준다 ·
  `CCG_NO_NET=1`에서 `unavailable:true`가 붙는다. 나도 계정 0 홈에서 `unavailable:true`를 확인했다.
  **T3의 「닫힘」은 유효하다.**
- 무너진다: 「**역전**」 · 「이 화면은 이제 **3.0 승**」 · §5의 블라인드 칸.
  근거는 재현되지 않는 1회 관측이고, 반대 관측이 같은 라운드·같은 홈에 있다.

**처방**: 두 앱 모두 `usage-cache.json`을 **심은 뒤** 같은 대기 시간으로 각 3회 이상 재고,
`hasNoData`가 흔들리면 이 화면을 「환경 의존」으로 분류하라(§6.1-6의 `settings-engine-confirm`
처방과 같은 잣대다). 출하 판정에는 영향이 없다.

### 3.2 ⚠ **N3의 「중간」은 낮다 — 「높음」이 맞다** (등급 축소)

격차 자체는 진짜다. 내 실측:

```
raw:app:open-directory("C:\Code")  → {"__unimplemented": true}
3.0 실행 중 + 두 번째 실행(폴더 인자) 9초 대기 → 활성 채팅 cwd "C:\Code\AgentCodeGUI" **그대로**
                                                  chat-head도 그대로 (folderArrived=false)
소스: src-tauri/src/main.rs:169-177 — win::tray::raise_existing() 후 return (폴더를 버린다)
      3.0 렌더러는 app/src/App.tsx:1744에서 onOpenDirectory를 **구독하고 있다** — 방출자가 0이다
```

등급을 올려야 하는 이유 둘:
1. **배포 경로에 이미 붙었다.** `src-tauri/nsis/hooks.nsh:26`이 `HKCU\…\Directory\shell\AgentCodeGUI3`에
   「AgentCodeGUI3으로 열기」를 쓴다(커밋 `60022e0`). 설치한 사용자에게 **이미 보이는 메뉴**다.
2. **「이미 떠 있는 앱」이 예외가 아니라 정상 상태다.** 3.0은 X를 눌러도 종료가 아니라 트레이로
   숨는 것이 기본이다(`win.rs:325 hide_on_close`). 즉 사용자의 통상 상태에서 그 메뉴를 누르면
   **창만 앞으로 오고 폴더는 조용히 사라진다.** 오류도 안내도 없다.

「콜드 실행은 된다」는 완화가 되기 어렵다 — 콜드 실행은 앱을 꺼 둔 사람만 만나는 경로다.

### 3.3 ⚠ **T1의 「클로드 축 닫힘」은 왕복 미검증이다** (표기 정직성)

R1이 T1에 치명을 매긴 이유는 「새 사용자는 3.0에서 **로그인할 방법이 없다**」였다. 이번
라운드가 실측한 것은 ① 채널이 `__unimplemented`가 아니다 ② no-op 재정렬이 6행을 돌려준다
③ 화면에 버튼이 그려진다 — **셋 다 로그인 왕복이 아니다.** 보고서 §0이 스스로
*「로그인·로그아웃은 한 번도 안 불렀다」* 고 적는다. `login-cancel`이 `{ok:true}`인 것은
「도는 로그인이 없을 때 취소가 no-op으로 돈다」는 뜻일 뿐이다.

안전 규약상 **안 부른 것은 옳다.** 문제는 그것을 「닫힘」이라고 쓴 것이다 —
「채널·화면 확인 · **왕복 미검증**」으로 표기하고 다음 라운드 숙제로 남겼어야 한다.
(Codex 축에는 같은 잣대를 더 엄하게 적용해 치명을 매겼으니 잣대가 비대칭이기도 하다.
다만 Codex는 핸들러가 **0개**라 결론 자체는 옳다.)

### 3.4 ⚠ 헤드라인 99.2%에 단서가 없다

99.2%는 **병합본**의 수치다. 같은 라운드의 통짜 주행은 **2/2 모두 73.6%**였고(§3.4가 원인을
정확히 짚었고 나도 재현했다), 그 원인은 3.0이 T4를 고쳐 생긴 행이 하네스의 느슨한 매칭을
밟은 것이다. §3.4 본문은 정직한데 §1 결론과 §5 표는 단서 없이 `120/121`만 싣는다.
다음 라운드 표에는 「통짜 73.6% · 병합 99.2%(원인: 하네스 §6.1-1)」로 두 수를 같이 실어라.

---

## 4. 신규 격차 재현 — N1·N2는 진짜고, 등급도 맞다 (체크리스트 2)

### N1 ⛔ 치명 — **재현됐고, 감사가 적은 것보다 조금 더 나쁘다**

합성 codex 계정 2개를 격리 홈에 심고 **화면에서 눌렀다**(`probe-codex.json`):

```
설정 ▸ Account ▸ OpenAI 행 2개  [crit-a@example.invalid, crit-b@example.invalid]
  → crit-b의 「맨 위로」 클릭
  → 3초 뒤 OpenAI 행 = []            ← 목록이 통째로 사라진다
  → codexAuth.listAccounts()        = [crit-a(isDefault), crit-b]  ← 저장은 **안 됐다**
  → 화면의 안내 문구                 = (없음 — 실패 알림이 하나도 안 뜬다)
  → 「계정 추가」 클릭 후 4.5초        = 스피너 0 · 새 행 0 · 새 창 0
원시 호출: raw:codex-auth:{login-cancel,reorder-accounts,set-default-account} = {__unimplemented:true}
Rust 전수: "codex-auth:login"·"logout"·"login-cancel"·"reorder-accounts" 문자열 **0회**
심 구조:   shim.ts call()은 미구현이면 **throw 하지 않고 fallback을 준다**(`shim.ts:101-104`)
           → codexAuth.reorderAccounts → [] → setCxAccounts([])
```

감사가 안 적은 한 줄: **`catch`가 안 걸리므로 「순서를 바꾸지 못했어요」 안내조차 안 뜬다.**
`Settings.tsx:537`의 `catch`는 reject일 때만 도는데 심은 resolve한다 — 사용자에게는
「눌렀더니 OpenAI 계정이 전부 없어졌다」만 남는다. 등급 **치명 유지**.

실홈 `codex-accounts.json`도 `accounts: []`가 맞다(내가 개수만 읽었다) — 즉 이 사용자는
3.0에서 Codex 구독 엔진을 **한 번도 시작할 수 없다.**

**장부 정정 요구도 사실이다.** `docs/renderer-divergence.md` §6.5의 *「reorderAccounts로 같은
결과를 저장한다」* 와 `app/src/components/Settings.tsx:524-525`의 *「결과는 같고(맨 위 = 기본),
실제로 저장된다」* 는 **거짓**이다 — 위 실측이 저장 안 됨을 보인다.

### N2 ⛔ 치명 — **내 픽스처로 두 앱을 나란히 눌러 재현**

```
                      선택 직후                      「앱 새로고침」 클릭 뒤
3.0    eb 1 · sb 0 · win 0        →   eb 1 · sb 0 · win 0 · chat 0   activeChatId="fix-boom"   갇힘
2.6.2  eb 1 · sb 0 · win 0        →   eb 0 · sb 3 · win 1 · chat 1   activeChatId="fix-long…"  복구
```

기전도 확인했다: `ErrorBoundary.tsx`는 두 앱 **md5 동일**(`6f1115813f09eac2936de557eec34448`)이고
배치도 대칭(앱 루트 + 멀티)이다. 갈리는 곳은 스토어다 — 3.0은 채팅을 고르는 순간
`setActiveChat(id)`로 `chats:set-active`를 **즉시 영속**하고(`app/src/App.tsx:899-900` →
`ccg-store/chats_v3.rs:390 set_active`), 2.6.2는 로컬 state만 바꾸고 디바운스 저장에 맡긴다
(`src/renderer/src/App.tsx:754`). 예외가 저장 전에 터지면 2.6.2는 옛 활성 채팅으로 돌아오고,
3.0은 같은 카드로 되돌아온다. 화면에 사이드바도 창 크롬도 없으므로 **다른 대화로 갈 수단이 없다.**
등급 **치명 유지**.

### N3 중간 → **높음**(§3.2) · N4·N5 낮음 — 재현됨

- **N4**: 상수는 양쪽 다 360이다(`src-tauri/src/notify.rs:57` · `src/main/notifyToast.ts:31`).
  리포트의 `canvasMismatch`도 감사가 적은 그대로다 — `toast-single [360,109]≠[344,103]` ·
  `toast-aggregate [360,172]≠[344,164]`. 프레임 폭을 안 뺀 것으로 보인다는 진단에 동의.
- **N5**: `app/src/components/MultiAgent.tsx:70 [1,2,3,4,5,6]` vs
  `app/src/components/NewChatModal.tsx:7 [2,3,4,5,6]`. 한 가지만 정정 — 2.6.2 다이얼은
  `src/renderer/src/components/MultiAgent.tsx:63`에서 **[2..6]**이다. 즉 「1」은 3.0이 새로
  더한 값이고, 「2.6.2 대비 회귀는 아니다」는 모달에만 해당한다. 등급(낮음)은 그대로 타당.

### 내가 따로 본 것 — 감사가 안 짚은 두 줄(둘 다 낮음/무해)

- 두 리포트의 `found` 차이는 넷뿐이고 셋은 설명된다(`sidebar` T=2/E=3 = 의도된 섹션 수 차이 ·
  `settings-code-lsp` 4/5 = Verse · `workbar-context-pop` 5/4 = §3.1). 남은
  `explorer-tree` **T=103 / E=105**는 감사가 언급하지 않았다 — 두 주행 사이(05:51→05:55)에
  옆 갈래들이 `target-*` 디렉터리를 만들고 있었으므로 픽스처 노이즈일 가능성이 높지만,
  다음 라운드에서 **같은 시각·같은 트리 상태**로 한 번 확인해 두는 편이 낫다.
- `skip` 35건은 두 앱의 **id와 사유 문자열까지 동일**했다(비대칭 0). 감사의 「두 앱 동일 skip」은 사실.

---

## 5. 종합 판정

| 체크리스트 | 결과 |
|---|---|
| 1) 「닫혔다」 무작위 5건 이상 직접 재현 | **12건 재현 — 전부 사실** (T1·T2·T3닫힘·T4·H1·H2·H4·H5·M1·M3·M5·M6) |
| 2) 신규 격차가 진짜인가 · 등급이 맞는가 | N1·N2 **재현 · 치명 타당**. N3 **등급 축소**(중간→높음). N4·N5 재현 |
| 3) A/B가 숙제 반영본으로 · 거짓 통과 교정 | **사실** — `581a27c`의 탭 검증이 트리에 있고, 리포트 수치가 파일과 일치 |
| 4) 범위 밖을 회귀로 잘못 잡았나 | **아니다** — Verse 3 · 업데이트 3을 정확히 갈랐다 |
| 5) 기준 결과 파일 무손상 | **무손상** — 감사 커밋은 삽입 15,671 · **삭제 0**, `git diff` 비어 있음 |

**감사 자체의 판정: 통과. 단, 보고서 세 칸을 정정해야 한다.**
- T3의 「역전」과 §5 블라인드 칸 → **근거 불충분**으로 내려라(§3.1).
- N3 중간 → **높음**(§3.2).
- T1 「닫힘」 → 「채널 확인 · **왕복 미검증**」(§3.3).

**출하 판정은 그대로다 — 치명 2(N1 Codex 계정 축 · N2 에러 안전망 부팅 루프). 출하 불가.**

---

## 6. 다음 라운드 숙제 (감사 §6에 더한다)

1. `limit-pop`/`workbar-context-pop`은 **환경 의존 화면**으로 분류하라. 두 앱에 캐시를 심고
   같은 대기로 각 3회 이상 재서, 흔들리면 승패를 매기지 말 것(§3.1).
2. **감사 보고서는 자기 증거 파일과 어긋나면 그 사실을 먼저 적어야 한다.** 이번엔 같은
   JSON 안의 반대 관측이 인용되지 않았다 — 다음 라운드는 증거 파일의 **모든 관측**을 표로
   싣고, 고른 이유를 한 줄로 적어라.
3. N1의 처방에 **실패 통지**를 포함하라. 채널을 배선하는 것과 별개로, 심의 안전값이
   `setCxAccounts`에 그대로 앉는 구조는 **다른 미구현 채널에서도 같은 사고**를 낸다
   (`call()`이 resolve하므로 `catch`가 영원히 안 돈다). 목록 setter 앞에 「빈 배열이면 갈아끼우지
   않는다」 가드를 두거나, `__unimplemented`를 심에서 **구분 가능한 결과**로 올려라.
4. `explorer-tree` 103 vs 105를 같은 시각·같은 트리로 한 번 확인하라(§4 끝).
