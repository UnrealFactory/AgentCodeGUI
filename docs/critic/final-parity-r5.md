# 최종 파리티 감사 R5 — 「42/43/44 보임」은 가설이 참이어도 켜질 수 없는 칸이었다. 고쳐서 다시 재고, **출하 판정을 내 손으로 다시 쓴다**

판정자: 최종 파리티 감사 R5(정정 라운드 3 + **출하 재판정**) · 2026-08-25 · `feature/3.0.0-beta` @ `2071c36`
대상: 내가 쓴 `docs/critic/final-parity-r4.md`(커밋 `711fd5f`)
지시: `docs/critic/r28f-audit-critic-r2.md`(확인 크리틱 R2 · `a0ffd75`) — 감사 **실질 통과**, 두 칸(G1·G2) 정정
전 라운드 크리틱: `docs/critic/r28f-audit-critic-r1.md`(`dc454e4`)

> 이 라운드는 두 몸통이다.
> **① 계기 정정** — 「판별력이 있다」며 내건 세 칸 중 하나가 **극성이 거꾸로**였다. 인정하고 고치고 다시 쟀다.
> **② 출하 재판정** — R3·R4가 「치명 2 · 출하 불가」로 닫은 그 둘이 그 사이에 착지했다.
> 남의 보고서를 근거로 쓰지 않는다. **내 exe · 내 격리 홈 · 내 계기로 화면에서 다시 눌러 재현했다.**
> **코드는 한 줄도 안 고쳤다.**

---

## 0. 무엇으로 쟀나

| 항목 | 값 |
|---|---|
| 판정 트리 | `git archive HEAD`(**`2071c36`**) → `C:\Temp\ccg-r28g-audit\wt` (`git worktree` 미등록 · 공유 `.git` 무변 · 남의 미커밋 변경 0) |
| 의존성 | `node_modules` **정션만**(`npm ci`·`npm install` **0회** — 함정 3) |
| 프론트 | `npm run app:build` — vite **✓ 2.14s** · exit 0 |
| 셸 | `cargo build --release --features custom-protocol` · `CARGO_TARGET_DIR=C:\Temp\ccg-r28g-audit\target` (**새 디렉터리** — 함정 11) · **2m26s** · 경고 **0** |
| **판정 exe** | **6,596,096 B** · sha256 `a36ef577f3f19c00898e73f0a088ab0cebcc57af9c6adbae8ca5440f7072c7d8` |
| `custom-protocol` 증표 | 내가 방금 구운 vite 번들 이름이 exe 안에 있다 — `index-BqARnKoK.js` · `FileModal-BINIkZEe.js`(함정 2) |
| **파괴 대조군 exe**(SABD) | **6,595,584 B** · sha256 `928e0fbbcd3ecdd2f6828b28cf395da7d9dd6721b567ff05dd8c624afc1fae2b` · `CARGO_TARGET_DIR=…\target-sabd`(**또 새 디렉터리**) · 2m41s. `ipc/accounts.rs`의 `ch::CODEX_SET_DEFAULT_ACCOUNT` **팔 하나만** 제거 = 그 채널만 진짜 `__unimplemented` |
| 2.6.2 | `node_modules/electron/dist/electron.exe` + 레포 `out/`(**읽기만**) · `USERPROFILE`까지 격리 |
| 홈 | 주행마다 격리 — `C:\Temp\ccg-r28g-audit\home-*`(**39개**) · `uprof-*`(7개) |
| CDP 포트 | **10620~10627** · 프록시 싱크 **10629** (배정표 AUDIT3 = 10620~ 준수) |
| 계기(신규) | `docs/critic/tools/critic-r28g-{limitpop3,n1,n2,observations3}.mjs` (+ 기존 `critic-r28f-explorer-count.mjs`·`critic-r28e-channels.mjs` 재사용) |
| 주행 | **limitpop 33**(최종 파일 30 + 전자 스텁 팔 초판 3 · 스모크 2 별도) · **N1 10** · **N2 4시퀀스 = 16기동** · 탐색기 **4** · 게이트 **3** · 계약면 스캔 3트리 |
| 프로세스 | 이름 기반 kill **0회** — 내가 스폰한 PID만(`killTree`). 종료 후 내 target 디렉터리의 잔류 프로세스 **0**(PowerShell 전수 확인 · 살아 있는 것은 사용자 설치본 5개와 **다른 갈래**의 `target-r28h-m10`·`target-r28g-gate`) |
| 자격증명 | 실홈 `accounts/`·`codex-accounts.json` **무접촉**(픽스처가 복사한 것은 기동 **전에** 삭제). 심는 것은 100% 합성 `@example.invalid` |

### 0.1 실 HTTP 0을 어떻게 보장했나 (그리고 **어디가 미계측인가**)

| 팔 | 장치 | 증거 |
|---|---|---|
| 3.0 limitpop | `HTTPS_PROXY=http://127.0.0.1:10629` — 내 싱크가 `CONNECT`를 받아 **502로 끊는다** | 싱크 로그 **33건 전부 `CONNECT api.anthropic.com:443`** · 밖으로 0바이트 |
| 2.6.2 limitpop | 액세스 토큰에 개행 → `fetch`의 `Authorization`이 **소켓 전에** undici 헤더 검증에서 죽는다 | 계정 1 팔의 2차 `usage:get`이 1,200ms 큐에 걸리고 값은 안 온다(§2.4) |
| N1·N2 | `CCG_NO_NET=1` | codex CLI는 **내가 쓴 `.cmd` 셰임**만 띄운다(`CCG_CODEX_BIN`) · CLI 로그가 내 폴더에만 남는다 |

★**정직하게**: 확인 크리틱 R2의 **G4**(「2.6.2 팔의 실 HTTP 0은 미계측」)는 이 라운드에서도 **그대로 남는다.**
2.6.2 프로세스 전체의 나가는 소켓을 잡는 장치를 나는 이번에도 안 달았다. 위험은 낮지만(공개
레지스트리·자격증명 없음) 헤드라인으로 「0건」이라 쓰지 않는다 — **usage 경로만** 0이다.

### 0.2 ★측정 기준선 **이후에 착지한 커밋** — `c2f828d`(GATE R2)

이 판정문을 처음 커밋한 직후(`03b7423`) 옆 갈래가 `c2f828d`를 올렸고, 그것이 **내가 N1을 잰 바로 그 파일**
(`src-tauri/src/ipc/accounts.rs`)을 만졌다. 자기 증거와 어긋날 수 있는 사실이므로 **내가 먼저 적는다**:

```
git show --stat c2f828d      → docs/parity-fix-gate-r1.md · src-tauri/src/ipc/accounts.rs (+52/-9)
git diff --stat 2071c36..c2f828d -- src-tauri/src/ipc app/src ...
                             → src-tauri/src/ipc/accounts.rs 만 (+355/-58 · 대부분 #[cfg(test)] 픽스처)
바뀐 것: snapshot_children/retrying(스냅샷 실패 재시도) + 테스트 픽스처(PidWatch·named_children 등) + 새 테스트 셋
안 바뀐 것: codex 다섯 채널의 dispatch 팔 · codex_login/codex_logout/move_account_to_top · 심·렌더러 전부
계약면 재스캔(c2f828d 트리): total 216 · impl 206 · commentOnly 0 · missing 10   ← 내 §3.3과 **동일**
```

→ **§3(N1)의 수치는 `c2f828d`에도 그대로 유효하다.** §4(N2)는 그 커밋이 안 건드린 축이다.
그리고 이 커밋이 **§5의 게이트 플레이크를 닫았다** — 내가 새 트리·새 target에서 다시 쟀다(§5.1).

---

## 1. 한 문단 결론

**크리틱의 G1은 옳다.** 팝오버는 `100 − pct`(남음)를 그리므로(`app/src/components/Chat.tsx:3640` ·
2.6.2 `src/renderer/src/components/Chat.tsx:2823` — **같은 식**) 42/43/44를 심으면 화면에는 **58/57/56**이
떠야 하고, R4의 `sees42 = /42|43|44/`는 **가설이 참이어도 안 켜진다.** 계기를 `seesRemain`(=100−pct)으로
고치고 **각 팔 3회씩 30주행**을 다시 떴다. 그리고 이번엔 **스텁 대조군을 판별의 증거로 표에 같이 싣는다** —
`getUsage`를 pct 42/43/44 스텁으로 갈면 같은 팝오버가 **5행**이 되고 화면에 **58% / 56% / 57% 남음**이
뜬다(3/3). **그러니 「4행 · 데이터 없음」은 계기 무능이 아니라 실측이다.** R4의 결론은 안 흔들린다 —
문을 연 팔에서도 `seeded`와 `bare`가 완전히 같고(30/30 전부 4행), 같은 순간 같은 파일을
`auth:accounts-usage(cachedOnly)`가 읽어 **42/43/44**를 그린다. **G2**(부록 A의 트리 범위)도 고쳤다(§9-부록 A).

**출하 재판정 — 내 손으로 다시 눌렀고, 치명은 0이다.**
· **N1(Codex 계정 축)**: 원시 다섯 채널 전부 비-`__unimplemented` · 「맨 위로」 **21~23ms**에 정착하고
목록 **2행 유지** · 디스크가 `[two,one]`로 뒤집히고 `defaultEmail=two` · 「계정 추가」 새 행 **51~121ms**(1,013→1,526 B) ·
계약면 `missing` **18 → 13 → 10**(내 스캐너로 세 트리 직접). **파괴 대조군 exe**(그 채널만 미구현)에서는
목록이 **2행 그대로**이고 디스크가 안 바뀌며 화면이 **「순서를 바꾸지 못했어요 …」**를 세운다 — 구조 처방이
목적대로 돈다. codex CLI가 없는 팔에서는 「계정 추가」가 **「codex 실행 파일을 찾지 못했어요」**를 세우고
목록은 2행 그대로다.
· **N2(부팅 루프)**: **감옥이 아니다.** 카드가 뜬 12상태 전부에서 사이드바가 **3행 살아 있고**(2.6.2는 **0행**),
「앱 새로고침」·사이드바 클릭 둘 다 탈출한다. **다만 R28f SHIPBLOCK 크리틱과 두 칸이 다르다** —
창 크롬은 3.0에서도 **사라진다**(`win 0`, `WinControls`가 `Chat.tsx` 안 = 경계 **안**), 그리고 폭탄이 활성인 채
**강제 종료**하면 다음 부팅에서 카드가 **한 번 더 뜬다**(부팅 격리 표식이 그 세션에서 디스크로 안 내려간다 —
leveldb를 직접 열어 확인). 둘 다 **치명이 아니다**(전자는 2.6.2와 파리티, 후자는 한 클릭에 탈출).

**따라서 R3·R4가 걸어 둔 「치명 2 · 출하 불가」를 나는 해제한다 — 치명 0.**
남는 최고 등급은 **높음 1(N3 `app:open-directory`)**, 이 라운드가 새로 적는 **낮음 2**, **미판정 1**(블라인드),
그리고 **M10은 미결·사용자 대기**로 분리한다. **게이트 플레이크는 차단으로 안 셌고**(근거 §5), 판정문을
쓰는 사이에 GATE가 그것을 닫았다 — 내가 새 트리·새 target에서 다시 재니 **4/4 초록 · 161 passed**(§5.1).

---

## 2. ★① 계기 정정 — 「42/43/44 보임」은 켜질 수 없는 칸이었다

### 2.1 무엇이 틀렸나

```
app/src/components/Chat.tsx:3640          const rem = w ? Math.max(0, 100 - Math.round(w.pct)) : null
src/renderer/src/components/Chat.tsx:2823 (2.6.2 — 같은 줄, 같은 식)
git show 1078718:app/src/components/Chat.tsx | grep -n …  → :3614  (baseline도 같은 식 · 줄만 밀렸다)

docs/critic/tools/critic-r28f-limitpop2.mjs:267   rec.sees42 = /42|43|44/.test(String(rec.popText))
docs/critic/final-parity-r4.md §2.4 본문        「닿으면 팝오버는 5행이고 42/43/44가 보인다」  ← 틀린 예측
```

심은 pct가 42/43/44면 화면 숫자는 **58/57/56**이다. `sees42`는 **가설이 참인 세계에서도 false**다.
즉 판별력 0이고, 우연히 켜질 여지(토큰 수·초기화 시각 문자열에 42가 섞이는 경우)만 있어 **거짓 양성 쪽으로만**
위험하다. 크리틱 R1이 직전 라운드를 실패시킨 사유가 정확히 「판별력 0인 계기」였는데, 그것을 고치겠다는
라운드의 간판 표에 같은 종류가 다시 들어갔다. **인정한다.**

### 2.2 고친 계기

`docs/critic/tools/critic-r28g-limitpop3.mjs`:

```js
rec.seesRemain        = /(^|[^0-9])(58|57|56)%/.test(popText)   // ★고친 칸 = 100 − pct
rec.seesPlanted       = /(^|[^0-9])(42|43|44)%/.test(popText)   // 옛 극성(퍼센트 붙은 자리만)
rec.seesPlantedR4Regex= /42|43|44/.test(popText)                // R4가 실제로 쓴 정규식 — 대비용으로 나란히 남긴다
```

세 칸을 **같은 파일에 나란히** 남긴다. 다음 라운드가 「그 칸이 왜 못 켜졌나」를 보고서가 아니라 **증거 파일에서**
확인할 수 있어야 하기 때문이다.

### 2.3 ★스텁 대조군 — **계기 자체의 판별력**을 실행으로 증명한다

R4의 양성 대조는 「심은 파일이 유효하다」(=`accountsUsage`가 읽는다)까지였다. 그것만으로는 **팝오버 계기가
값이 와도 못 볼 가능성**이 안 닫힌다. 그래서 계정도 캐시도 없는 홈에서 `window.api.getUsage`를 **심은 값 그대로의
pct** 스텁으로 갈고, **제품 경로**(설정 모달을 열었다 닫으면 `App.tsx:585`가 `getUsage(true)`를 다시 쏜다)로
재조회를 태운 뒤 같은 팝오버를 다시 열었다:

| 팔 | n | `stubInstalled` | `prows` | `hasNoData` | 화면 행 (실측 텍스트) |
|---|---|---|---|---|---|
| **3.0 `stub`** | **3** | `ok` | **5** | **false** | `5시간 한도 1시간 0분 후 초기화 **58% 남음**` · `Fable 주간 한도 3일 0시간 후 초기화 **56% 남음**` · `주간 한도 3일 0시간 후 초기화 **57% 남음**` |
| 2.6.2 `stub` | 3 | **THROW** `Cannot redefine property: getUsage` → 프록시 폴백도 **THROW** `Cannot redefine property: api` | 4 | true | (스텁이 안 심겼다 — 아래) |

**3/3에서 심은 42/43/44가 화면에 58/56/57로 떴다.** 그러므로

* 계기는 **값이 오면 본다** — `prows`·`hasNoData`·`seesRemain` 세 칸 다 뒤집힌다.
* 그리고 **`seesPlantedR4Regex`는 이 판에서도 `false`다** — R4의 칸은 *가설이 참인 바로 그 화면에서도* 안 켜진다.
  이것이 「판별력 0」의 직접 증거다.

★**2.6.2 쪽은 스텁을 못 심었다.** `contextBridge`가 `window.api`를 얼려 놔서 속성 재정의도(`getUsage`),
객체 통째 교체도(`window.api`) 둘 다 `Cannot redefine property`로 막힌다(3/3 기록). **이 칸은 미계측으로 적는다.**
대신 두 가지가 남는다 — ① 2.6.2의 행 조립 식은 3.0과 **바이트 동일**(`:2823`), ② 같은 셀렉터
(`.wb-cell .wb-pop.r .wb-prow`)가 2.6.2에서도 **4행을 실제로 읽어 낸다**(15/15) — 즉 셀렉터는 눈이 멀지 않았다.
그래도 「2.6.2 팝오버 계기의 양성 대조」는 **다음 라운드 숙제**다(§10-2).

### 2.4 고친 계기로 다시 뜬 30주행 (각 팔 **3회** · 2 앱 × 4 배치 + 스텁)

| 앱 | 팔 | n | 계정 | `prows` | 데이터 없음 | **`seesRemain`(58/57/56)** | `seesPlantedR4Regex`(42/43/44) | 2차 `usage:get` | `CONNECT` | `accountsUsage(cachedOnly)` |
|---|---|---|---|---|---|---|---|---|---|---|
| 3.0 | `synth-seeded` | 3 | 1 | **4** | true | **✗** | ✗ | **1,200·1,200·1,201 ms** | **15** | **`42/43/44`** ← 양성 대조 |
| 3.0 | `synth-bare` | 3 | 1 | 4 | true | ✗ | ✗ | 1,201·1,200·1,201 ms | 18 | `null/null/null` |
| 3.0 | `noacct-seeded` | 3 | 0 | 4 | true | ✗ | ✗ | **0·1·1 ms** | **0** | `[]` |
| 3.0 | `noacct-bare` | 3 | 0 | 4 | true | ✗ | ✗ | **1·1·1 ms** | **0** | `[]` |
| **3.0** | **`stub`(대조군)** | **3** | 0 | **5** | **false** | **✓** | **✗** | — | 0 | — |
| 2.6.2 | `synth-seeded` | 3 | 1 | 4 | true | ✗ | ✗ | 1,210·1,210·1,204 ms | — | **`42/43/44`** ← 양성 대조 |
| 2.6.2 | `synth-bare` | 3 | 1 | 4 | true | ✗ | ✗ | 1,201·1,212·1,200 ms | — | `null/null/null` |
| 2.6.2 | `noacct-seeded` | 3 | 0 | 4 | true | ✗ | ✗ | **0·0·0 ms** | — | `[]` |
| 2.6.2 | `noacct-bare` | 3 | 0 | 4 | true | ✗ | ✗ | **0·0·0 ms** | — | `[]` |
| 2.6.2 | `stub`(대조군) | 3 | 0 | 4 | true | ✗(**미계측** — 스텁 실패) | ✗ | — | — | — |

팝오버 실측 텍스트(비-스텁 24/24 동일):

```
현재 컨텍스트 … 12% · 5시간 한도 데이터 없음 — · 주간 한도 데이터 없음 — · 토큰 사용량 …
   ↑ 4행. Fable 행 없음. 58·57·56 어디에도 없음.
스텁 대조군(3.0):
현재 컨텍스트 … · 5시간 한도 1시간 0분 후 초기화 58% 남음 · Fable 주간 한도 … 56% 남음 · 주간 한도 … 57% 남음 · 토큰 사용량 …
   ↑ 5행. Fable 행 생김.
```

**네 칸이 동시에 참이라 이 배치는 판별력이 있다:**

1. **문은 열렸다** — 계정 1 팔의 2차 호출이 1.2초 큐(`ccg_auth::usage::USAGE_GAP_MS` · `auth.ts:504`)에
   걸리고, 3.0은 요청이 실제로 조립돼 내 싱크까지 왔다(`CONNECT api.anthropic.com:443` 33건).
2. **심은 파일은 유효하다** — 같은 순간 같은 홈의 같은 파일을 `auth:accounts-usage(cachedOnly)`가 읽어
   **42/43/44**를 그린다(`bare` 팔에서는 같은 채널이 `null` 행 — 그게 대조). 심은 파일 233 B ·
   sha `5a3e8883d37619b1`이 주행 **전후 동일**하고, `bare` 팔에서는 파일이 **생기지도 않았다**.
3. **계기는 값이 오면 본다** — §2.3의 스텁 대조군(3/3 · 5행 · 58/56/57).
4. **그런데도 팝오버는 4행 · 데이터 없음이다.**

→ **디스크 `usage-cache.json`은 이 화면에 안 닿는다.** R4의 결론은 극성을 고친 계기 + 계기 대조군까지
붙여도 **그대로 선다.** 흔들린 것은 결론이 아니라 「무엇이 그 판을 갈랐는가」였고, 그 자리는 이제
`prows 4↔5` · `hasNoData` · **`seesRemain`** 셋이다.

### 2.5 내가 잰 코드 경로가 baseline 이후 안 움직였다는 확인 (명령으로)

```
git diff --stat 1078718..HEAD -- src-tauri/src/ipc/parity/usage.rs crates/ccg-auth/src/usage.rs \
                                 crates/ccg-auth/src/net.rs src/main/index.ts src/main/auth.ts
   → (비어 있음)
git show 1078718:app/src/components/Chat.tsx | grep -n "100 - Math.round(w.pct)"  → 3614
git show HEAD    :app/src/components/Chat.tsx | grep -n "100 - Math.round(w.pct)"  → 3640
git show HEAD    :src/renderer/src/components/Chat.tsx | grep -n …                 → 2823
```

세 자리가 같은 식이다. (이번에는 exe도 HEAD에서 새로 구웠다 — 같은 값이 났다.)

---

## 3. ★② 출하 재판정 (1) — **N1 · Codex 계정 축**

R3·R4가 치명으로 적은 근거는 「다섯 채널이 `{__unimplemented:true}`이고, 심이 안전값 `[]`로 갈음해
**계정 목록이 증발하는데 안내 문구가 0개**」였다. 그 뒤 `efdc08c`·`521221d`·`1e47a06`·`8dd4678`이 착지했다.
**내 exe로 화면에서 다시 눌렀다**(`critic-r28g-n1.mjs` · 합성 계정 둘 `r5-one/two@example.invalid`).

### 3.1 「맨 위로」 해피패스 — 3주행 전부 같은 값

| | run1 | run2 | run3 |
|---|---|---|---|
| 클릭 → 화면 정착 | **23 ms** | **23 ms** | **22 ms** |
| OpenAI 목록 | **2행 유지**(증발 0) | 2행 | 2행 |
| 배지 `기본 · 맨 위` | 새 0번(`r5-two`) | 〃 | 〃 |
| 디스크 `codex-accounts.json` | `[two, one]` · `defaultEmail=two` · **1,013 B**(클릭 전과 같은 크기, 순서만 뒤집힘) | 〃 | 〃 |
| 실패 문구 | 없음(성공) | 없음 | 없음 |

### 3.2 「계정 추가」 해피패스 — 가짜 codex CLI(`.cmd` 셰임)

셰임은 `%CODEX_HOME%\auth.json`에 합성 `id_token`(JWT · `email`+`chatgpt_plan_type`)을 떨구고 exit 0 한다.
`CCG_CODEX_BIN`으로 물린다(`engine/codex_versions.rs:codex_bin`).

| | run1 | run2 | run3 |
|---|---|---|---|
| 새 행 도착 | **121 ms** | **51 ms** | **52 ms** |
| 화면 행 | 2 → **3** | 2 → 3 | 2 → 3 |
| 디스크 | **1,013 → 1,526 B** | 〃 | 〃 |
| CLI 로그 | `[r5-fake-codex] login`(내 폴더에만 — 실홈으로 안 샌다) | 〃 | 〃 |

### 3.3 원시 다섯 채널 — 전부 비-`__unimplemented`

`window.__TAURI_INTERNALS__.invoke('ipc_call', …)` 원시 호출(3주행 동일):

| 채널 | 결과 | `__unimplemented` |
|---|---|---|
| `codex-auth:login-cancel` | `null` | 아니오 |
| `codex-auth:list-accounts` | `array:2` | 아니오 |
| `codex-auth:reorder-accounts` | `array:2` | 아니오 |
| `codex-auth:set-default-account` | `array:2`(첫 칸이 인자 이메일) | 아니오 |
| `codex-auth:login` | `array`(내 셰임이 즉시 끝나므로 원시로도 안전) | 아니오 |

계약면(내 스캐너 `critic-r28e-channels.mjs`를 **세 트리에** 직접 돌렸다):

```
1078718 (R3·R4 baseline) : total 216 · impl 198 · commentOnly 0 · missing 18
d461f21                  : total 216 · impl 203 · commentOnly 0 · missing 13
HEAD  2071c36            : total 216 · impl 206 · commentOnly 0 · missing 10
  18→13 = codex-auth 다섯      13→10 = lsp:{pick-verse-server,set-verse-path,clear-verse-path}
  남은 10 = talk 여섯(run·cancel·permission-respond·question-respond·bg-task·event) +
            app 넷(update-check·update-install·update-event·**open-directory**)
```

### 3.4 ★구조 처방 대조군 — **그 채널만 미구현으로 만든 exe**로

> 먼저 실패담 하나. 「셸 응답만 위조」로 만들려 했는데 **`window.__TAURI_INTERNALS__.invoke`는
> non-configurable**이다(`{configurable:false, writable:false}` · `Object.defineProperty` →
> `Cannot redefine property: invoke` — 3주행 기록). 게다가 단순 대입은 sloppy mode에서 **조용히 실패**해
> 「위약 대조군」이 된다(내가 처음에 그랬고, 실제로 제품 채널이 그대로 돌아 디스크 순서가 바뀌었다 —
> 확인 안 했으면 이 라운드가 또 판별력 0인 칸을 실을 뻔했다). 그래서 **exe를 따로 구웠다.**

`sabd` = HEAD 트리에서 `ch::CODEX_SET_DEFAULT_ACCOUNT` **팔 하나만** 제거 · 새 `CARGO_TARGET_DIR`.

| | 판정 exe | **`sabd`**(그 채널만 미구현) |
|---|---|---|
| 원시 `codex-auth:set-default-account` | `array:2` | **`{"__unimplemented":true}`** |
| 「맨 위로」 후 목록 | `[two, one]` **2행** | **2행 유지**(서버 순서 `[one, two]`로 복원) |
| 화면 문구 | 없음 | **「순서를 바꾸지 못했어요 — 앱을 재시작한 뒤 다시 시도해 주세요」** |
| 디스크 | `[two,one]` · 1,013 B | **안 바뀜**(`[one,two]` · 1,013 B) |
| 같은 exe의 「계정 추가」 | 정상 | **정상**(2→3행 · 109/102 ms) — 다른 채널은 안 다쳤다 |

2주행 동일. **「빈 배열이 목록 setter에 안 앉는다 + 실패가 화면에 보인다」가 내 손에서도 닫혔다.**

### 3.5 「띄울 codex가 없다」 — 침묵이 아니라 사유

`CCG_CODEX_BIN`을 없는 경로로 물린 팔(2주행):

```
원시 codex-auth:login → {"error":"codex 실행 파일을 찾지 못했어요"}
화면 「계정 추가」     → 목록 2 → 2행(증발 0) · 스피너 0틱 · 문구 **「codex 실행 파일을 찾지 못했어요」**
같은 주행의 「맨 위로」 → 22 ms 정상(다른 채널은 멀쩡)
```

### 3.6 N1 판정

**닫혔다.** 채널·화면·디스크·실패 경로 넷을 내 exe로 재현했고, 파괴 대조군이 「이 처방이 없으면 어떻게
되는가」를 같은 코드베이스에서 보여 준다. **치명에서 내린다.**

> 남는 것(범위 밖·정보): 실 OAuth 왕복은 이 라운드도 검증 안 했다. 내가 띄운 것은 100% 가짜 CLI다
> (함정 5 — 실계정 토큰 회전 금지). T1(로그인/로그아웃 왕복 미검증)은 **여전히 이월**이다.

---

## 4. ★② 출하 재판정 (2) — **N2 · 렌더 예외 부팅 루프**

픽스처: 채팅 셋(`r5-good` 활성 · `r5-plain` · `r5-boom`). `boom`은 assistant 메시지의 `text`가 **객체**라
자식 렌더에서 던진다. 상태마다 다섯을 잰다 — `eb`(`.eb-card`) · `sb`(`.sb-item`) · `win`(`.win-ctl`) ·
`chat`(`.workbar`) · 디스크 활성 채팅.

### 4.1 두 앱 나란히 (3.0 = 내 판정 exe · 2.6.2 = 같은 픽스처·`USERPROFILE` 격리)

| 상태 | **3.0** | 2.6.2 |
|---|---|---|
| 1. 부팅(활성=good) | eb 0 · **sb 3** · win 1 · chat 1 · disk `r5-good` | eb 0 · sb 3 · win 1 · chat 1 · disk `r5-good` |
| 2. 폭탄 선택 직후 | eb 1 · **sb 3** · **win 0** · chat 0 · disk **`r5-boom`** | eb 1 · **sb 0** · win 0 · chat 0 · disk `r5-good` |
| 3. 「앱 새로고침」 | **eb 0** · sb 3 · win 1 · chat 1 · disk `r5-good` · 표식 소비(`null`) | **eb 0** · sb 3 · win 1 · chat 1 |
| 4. 폭탄 재선택 | eb 1 · sb 3 · win 0 · disk `r5-boom` | eb 1 · **sb 0** |
| 5. **사이드바로 탈출** | **가능** → eb 0 · chat 1 · disk `r5-good` | **불가**(사이드바가 없다 — 계기가 행을 못 찾는다) |
| 6. 폭탄 활성 · 종료 직전 | eb 1 · sb 3 · win 0 · disk `r5-boom` | eb 1 · sb 0 · disk `r5-good` |
| 7. 폭탄 활성인 채 재시작 #1 | **eb 1**(카드 재현 · sb 3 — 한 클릭에 탈출) | eb 0(애초에 폭탄이 활성으로 안 남는다) |
| 8. 재시작 #2 | **eb 0** · disk `r5-good`(표식이 이번엔 살아 escape) | eb 0 |
| 9. 재시작 — 활성 복원 | eb 0 · 마지막에 고른 채팅으로 착지 | eb 0 |

3.0은 **3시퀀스**(hard 종료 · graceful 시도 · `pickplain=0`) 전부 같은 모양이었다.
그리고 내가 잰 **12상태 전부에서 디스크 `activeChatId` == 화면이 그린 채팅**이었다.

### 4.2 SHIPBLOCK 확인 크리틱 R2와 **다른 두 칸**

| 칸 | 그 크리틱 | **내 실측** | 왜 |
|---|---|---|---|
| 카드가 뜬 동안 창 크롬 | 3.0 **`win 1`** | **`win 0`** (3.0·2.6.2 **둘 다**) | `WinControls`는 `Chat.tsx:1802`(→ `ChatHeader`) 안이고, 그 자리는 `App.tsx:2365`의 **대화 경계 안**이다. 2.6.2도 같다(`Chat.tsx:1489`). 「크롬은 경계 밖」이라는 주석(`App.tsx:2334-2338`)은 **사이드바·탐색기에만** 참이다 |
| 폭탄 활성인 채 재시작 | 3.0 **`eb 0` ×2** | **재시작 #1 `eb 1`** · #2 `eb 0` | 부팅 격리 표식은 `localStorage`에 산다. **그 세션의 쓰기가 디스크로 안 내려간 판**이 있다 — 아래 |

**표식이 정말로 안 내려갔는지 기계로 확인했다.** 나는 상태 1에서 같은 저장소에 내 증표
(`r5.persist = seeded-<시각>`)를 심고, 상태 7에서 읽었다:

```
상태 2~6:  r5.persist = seeded-1787660685357   (같은 세션 안에서는 산다)
상태 7  :  r5.persist = null                    ← 재시작을 못 넘었다
leveldb 직독: <홈>\webview2\EBWebView\Default\Local Storage\leveldb\000003.log
   "r5.persist"          → 0건      (그 세션의 쓰기가 파일에 없다)
   "ccg.chatRenderCrash" → 2건      (그 뒤 세션들의 쓰기는 있다)
2.6.2도 같은 패턴  (상태 2~6 seeded / 상태 7 null)
```

즉 **「표식이 소비됐다」가 아니라 「그 세션의 localStorage가 디스크에 안 앉았다」**이고, 이는
**WebView2 프로파일을 처음 만든 세션 + 강제 종료** 조합에서 났다(재시작 #2에서는 직전 세션의 표식이
살아남아 escape가 **작동했다** — `eb 0` · disk `r5-good`). 2.6.2에서도 같은 현상이 관측되므로 앱 차이가
아니라 Chromium 계열의 커밋 지연이다. 내가 `graceful`(제품 경로 `win:close`)로도 시도했지만
**15초 안에 프로세스가 안 죽어** 결국 하드 종료로 떨어졌다(`shutdown = graceful-timeout->hard` ×3) —
그 자체가 별도 관측이다(§10-4).

### 4.3 N2 판정

**감옥이 아니다 — 치명에서 내린다.** 근거 셋:

1. 카드가 뜬 **모든** 상태에서 3.0의 사이드바가 살아 있다(`sb 3`, 12/12). 2.6.2는 `sb 0`이라 **사이드바
   탈출이 불가능**하다 — 이 축에서 3.0이 2.6.2보다 낫다.
2. 「앱 새로고침」이 3/3 시퀀스에서 탈출시킨다(표식 1회 소비 확인).
3. 재시작 경로에서 카드가 한 번 더 뜨는 판이 있지만, 그 화면에서도 **사이드바 한 클릭이면 나온다**.
   「나올 수 없다」가 성립하는 상태가 하나도 없다.

**새로 적는 결함 둘**(등급 낮음 · §9 표에 실린다):

* **N6 〈낮음〉 카드가 뜬 동안 창 컨트롤(최소화·최대화·닫기)이 사라진다.** `WinControls`가 대화 경계
  **안**에 있다. 앱이 프레임리스라 그 순간 창을 UI로 닫을 수 없다(Alt+F4·작업표시줄은 된다).
  **2.6.2도 같으므로 회귀가 아니다** — 파리티다. 다만 R28f SHIPBLOCK 크리틱 표의 `win 1`은 **틀렸다.**
* **N7 〈낮음〉 부팅 격리 표식이 「프로파일을 처음 만든 세션 + 강제 종료」를 못 넘는다.**
  그 판에서 다음 부팅이 같은 카드로 한 번 되돌아온다(그 다음부터는 산다). 사이드바 탈출이 있으므로
  감옥은 아니다. 닫으려면 표식을 `localStorage`가 아니라 **셸 쪽 파일**에 두면 된다(권고일 뿐 —
  이 라운드는 코드를 안 고친다).

---

## 5. 게이트 플레이크를 나는 **차단으로 안 셌다** — 그 근거

확인 크리틱 R2(`1ff6c8e`)가 남긴 것: 회귀 테스트 둘이 병렬 주행 6회 중 3회 붉음 · `cargo test --workspace` exit 101.
**GATE 갈래가 지금 고치고 있으므로 나는 안 고쳤다.** 대신 **내 트리·내 target에서 직접 3회** 돌려 사실만 확인했다:

```
cd C:\Temp\ccg-r28g-audit\wt · CARGO_TARGET_DIR=C:/Temp/ccg-r28g-audit/target-test (새 디렉터리)
cargo test -p agentcodegui --bin agentcodegui  ×3
  RUN 1 → FAILED  156 passed; 2 failed   exit 101
  RUN 2 → FAILED  156 passed; 2 failed   exit 101
  RUN 3 → ok      158 passed; 0 failed   exit 0
붉은 둘: ipc::accounts::tests::cancelling_a_wrapped_login_kills_the_program_inside_the_wrapper
        ipc::accounts::tests::cancelling_an_unwrapped_login_leaves_what_the_cli_launched_alone
실패 문구(둘 다): src-tauri\src\ipc\accounts.rs:939
        ★래퍼 안의 프로그램이 안 떴다 — 픽스처가 무의미하다(자식 [])
```

**차단이 아니라고 판단한 근거 셋:**

1. **붉은 것은 제품 단정이 아니라 픽스처 단정이다.** 패닉 자리(`:939`)가 「내가 띄우려던 자식이 안 떴다」를
   말하는 줄이다 — 취소가 안 풀렸다는 단정이 아니다.
2. **같은 처방이 지키는 제품 경로를 나는 이 라운드에서 화면으로 확인했다** — N1의 다섯 채널·해피패스·
   실패 경로가 전부 목적대로 돌았고(§3), 어떤 주행에서도 계정 목록이 증발하지 않았다.
3. **`--test-threads=1`·필터 주행에서는 초록이라고 그 크리틱이 적었고, 내 3회도 같은 방향**(2붉음/1초록,
   실패 개수도 2로 같다)이다. 즉 **부하 의존 플레이크**이며 코드 결함의 신호가 아니다.

**다만 출하 게이트로서는 결함이다** — 반이 붉은 게이트는 다음 라운드부터 아무도 안 믿는다.
그래서 **차단(치명)에는 안 넣되, 「높음: 출하 전 반드시 초록으로 만들 것」으로 §9 표에 남긴다.**
소유는 GATE 갈래다.

### 5.1 ★그 사이에 GATE가 닫았다 — 내가 새 트리에서 다시 쟀다

`c2f828d`(§0.2)가 `direct_children`의 스냅샷 실패를 **재시도**로 바꾸고 테스트 픽스처를 다시 썼다.
믿지 않고 다시 쟀다 — `git archive c2f828d` → `C:\Temp\ccg-r28g-audit\wt2` · **또 새** `CARGO_TARGET_DIR`
(`target-test2` — 함정 11대로 재활용 안 함 · 전체 debug 재컴파일):

```
cargo test -p agentcodegui --bin agentcodegui  ×4
  RUN 1 → ok  161 passed; 0 failed  exit 0        RUN 3 → ok  161 passed; 0 failed  exit 0
  RUN 2 → ok  161 passed; 0 failed  exit 0        RUN 4 → ok  161 passed; 0 failed  exit 0
(내 기준선 2071c36에서는 같은 명령이 3회 중 2회 붉었다 — 156 passed; 2 failed · exit 101)
```

**4/4 초록. 붉던 둘이 안 붉다.** 테스트 수 158 → **161**(GATE가 셋 더했다 · 함정 10대로 이 크레이트만 셌다).
→ §9.1의 `G-1`을 **닫힌 것으로** 고친다. 다만 `cargo test --workspace` 전수는 내가 안 돌렸고(§10),
「6회 중 3회」를 관측한 것은 SHIPBLOCK 크리틱의 표본이므로 **그쪽 재현은 GATE 갈래 크리틱의 몫**이다.

---

## 6. M10 — **미결 · 사용자 대기** (라이브 주행 시도 0)

`talk:*` 여섯 채널은 계약면 `missing` 10 중 여섯이고 **M10 소유**다. 측정 계정이 죽어
(`400 invalid_grant`) 라이브 실증이 멈춰 있다 — **사용자 재로그인 대기**.
나는 이 라운드에서 `C:\Temp\ccg-m10-live` 홈으로 **아무것도 안 돌렸고**, `talk:*`를 한 번도 안 불렀다
(함정 5). 출하 판정에서 M10은 **치명/높음/낮음 어느 칸에도 안 넣고 「미결」로 분리**한다 —
「대화 연결」은 2.6.2에 있고 3.0에 없는 축이지만, 그 축의 상태를 내가 실측하지 못했으므로
**등급을 매길 자격이 없다.**

---

## 7. 이월 숙제 (c) — `explorer-tree` **T=103 / E=105**를 같은 시각·같은 트리로

R4는 「재주행 안 했다」고 정직하게 적었다. 이번에 **내가 직접** 돌렸다
(`critic-r28f-explorer-count.mjs` · 두 앱을 **동시에** 띄우고 순서를 바꿔 2라운드):

| 라운드 | 기동 순서 | **T** | **E** | 두 측정 간격 | 루트(전→후) | `onlyInTauri` | `onlyInElectron` |
|---|---|---|---|---|---|---|---|
| 1 | tauri → electron | **125** | **125** | 1,369 ms | 131 → 131(무변) | **0** | **0** |
| 2 | electron → tauri | **125** | **125** | 1,364 ms | 131 → 131(무변) | **0** | **0** |

**같은 시각·같은 트리에서 두 앱의 행 수가 같다.** 라벨 차집합도 양방향 0이다.
→ R2의 **103 vs 105는 앱 차이가 아니라 측정 시각 차이(픽스처 노이즈)**라는 분류가 내 손에서도 선다.
(절대값이 103/105도 114도 아닌 **125**인 이유는 레포 루트가 그 사이에 계속 커졌기 때문이다 —
이 주행 시점 루트는 **131항목 · 그중 `target*` 72개**. 그래서 이 숙제는 절대값이 아니라 **동시성**으로만
닫힌다.) 증거: `docs/critic/final-parity-r5-explorer.json`.

---

## 8. 이월 숙제 (b) — 증거 파일의 **모든 관측**을 표로

**고른 이유(한 줄)**: 「두 앱 중 한쪽이라도 **한도 수치를 사용자에게 보여 주는 표면**의 값이 증거 파일에
기록된 자리」면 표면 이름·극성·유불리와 무관하게 전부 싣는다 — 규칙은 수집기 코드에 못 박혀 있다
(`critic-r28g-observations3.mjs` 헤더). R4와 **같은 규칙**이다(바꾸면 「전량」의 뜻이 라운드마다 달라진다).

```
전량 = 92건   (R4의 62건 + 이 라운드 30건)
  A 팝오버(press)              4     E 설정▸Account 클로드 한도       5
  B usage.get 채널              7     F Codex 한도 · API 과금          7
  C 팝오버(A/B found)           6     G 블라인드 판정                  1
  D 팝오버(R3 12주행)          12     H 팝오버(R4 20주행)             20
  I 팝오버(R5 30주행)          30
극성(A~D·H·I만 · **스텁 6건 제외** — 계기 대조군이라 값이 인위적이다):
  3.0 값 있음 4 / 데이터 없음 35     ·     2.6.2 값 있음 2 / 데이터 없음 32
```

R3가 「전량」이라 부른 범위 = A+B(apiprobe만)+C+D = **27** · R4가 「전량」이라 부른 범위 = A~H = **62**.
**이번에는 집계가 아니라 92행 전부를 본문 부록에 싣는다**(확인 크리틱 R2 **G3** 처방 — 「전량을 표로」).
→ **부록 B**. 원본 JSON: `docs/critic/final-parity-r5-observations.json`.

극성으로 승패를 못 매긴다는 결론은 30건을 더 실어도 그대로다. 새로 든 30건 중
**3.0 「값 있음」 3건은 전부 내가 스텁으로 만든 판**이라 극성에서 뺐다 — 안 빼면
「3.0이 값을 더 자주 보여 준다」로 **정확히 거꾸로** 읽힌다.

---

## 9. 출하 판정 — **내 실측으로 다시 쓴다**

| 사용자 기준 | 수치(전부 이 라운드 실측) | 판정 |
|---|---|---|
| 기존 기능을 화면 단위로 빠뜨리지 않았는가 | 계약면 **216 / impl 206 / commentOnly 0 / missing 10**(HEAD `2071c36`) · 남은 10 = `talk` 여섯(**M10 · 미결**) + `app` 넷 | **거의. 다만 아니다** — `app:open-directory`(N3) 하나가 화면 축에 남는다 |
| 블라인드에서 UI가 지지 않는가 | **미판정 — 근거 없음**(R3 §2.6부터 이월 · 관측을 92건으로 늘려도 그대로) | ⚠ 이월 |
| **치명 0인가** | **0** — N1·N2 둘 다 내 exe로 재현해 닫혔다(§3·§4) · 이 라운드가 찾은 새 치명 **0** | ✅ **출하 차단 해제** |

### 9.1 남은 결함 (등급과 소유)

| # | 결함 | 등급 | 근거 | 소유 |
|---|---|---|---|---|
| N3 | `app:open-directory` 미구현 — 방출자 런타임 `undefined`, 설치기는 HKCU에 우클릭 항목을 쓴다(`src-tauri/nsis/hooks.nsh:28` · 쓰기 :39-41·:44-46) | **높음** | HEAD 스캔에서도 `missing`(§3.3) | GATE |
| ~~G-1~~ | ~~회귀 게이트가 반은 붉다~~ → **닫혔다.** `c2f828d`(내 기준선 이후 착지) 뒤 같은 명령이 **4/4 초록 · 161 passed** (내 기준선에서는 3회 중 2회 붉음) | ~~높음~~ → **해소** | §5.1 | GATE(착지) |
| N6 | 에러 카드가 뜬 동안 창 컨트롤이 사라진다(경계 안) | 낮음 | §4.2 · 2.6.2도 같음(파리티) | — |
| N7 | 부팅 격리 표식이 「프로파일 첫 세션 + 강제 종료」를 못 넘는다 | 낮음 | §4.2(leveldb 직독) | — |
| N4·N5 | R3에서 낮음으로 분류된 둘 | 낮음 | 변화 없음 | — |
| — | 블라인드 판정 미수립 | 미판정 | §8 | AUDIT |
| — | **M10(대화 연결)** | **미결 · 사용자 대기** | §6 — 측정 계정 사망(`400 invalid_grant`) | M10 |

### 9.2 R4 대비 무엇이 바뀌었나

| R4의 문장 | R5 |
|---|---|
| 「치명 **2**(N1·N2) · **출하 불가**」 | **치명 0 · 차단 해제**(§3·§4 — 내 exe로 재현) |
| 「N1은 배선이 생겼다는 것까지만 내 확인이다. 동작·왕복은 안 봤다」 | **동작을 봤다** — 화면·디스크·실패 경로·파괴 대조군까지(§3) |
| 「N2는 SHIPBLOCK 크리틱 소관」 | **내가 다시 눌렀다** — 그리고 그 크리틱의 두 칸을 정정했다(§4.2) |
| 계약면 `missing 13`(HEAD 당시) | **10**(§3.3 — lsp 셋이 더 닫혔다) |

---

## 10. 남은 리스크 · 다음 라운드 숙제

1. **(신규) 2.6.2 팝오버 계기의 양성 대조가 없다.** `contextBridge`가 `window.api`를 얼려 스텁이 안 심긴다.
   다음 라운드는 **preload 우회가 아니라 메인 프로세스 쪽**(usage fetch를 가로채는 로컬 스텁 서버 등)으로
   같은 대조를 만들어야 한다. 지금은 「셀렉터가 4행을 실제로 읽는다」까지만 증명돼 있다.
2. **(이월 · G4) 2.6.2 팔의 실 HTTP는 프로세스 전체로는 미계측이다.** `usage` 경로만 0을 보장했다.
   3.0 쪽 `HTTPS_PROXY` 싱크에 대응하는 소켓 계측을 2.6.2에도 상설로 달아야 한다.
3. **(이월) 로그인/로그아웃 실 왕복 미검증(T1).** 이 라운드도 가짜 CLI로만 왕복했다.
4. **(신규) `win:close`가 15초 안에 프로세스를 안 끝냈다**(3/3). 트레이 상주인지 창만 숨는지 못 갈랐다 —
   하네스가 「종료」를 부를 때마다 하드 킬로 떨어지므로, 종료 경로를 재는 모든 측정이 이 영향을 받는다.
5. **(이월) 블라인드 칸을 다시 세워라** — 환경 의존 화면을 표본에서 빼고 잔존 상태를 맞춘 뒤.
6. **(이월) 환경 의존 화면 표식(`envDependent: true`)** 을 하네스 화면 정의에 넣어 성공률·`found` 비교에서 자동 제외.
7. **(미해소) `--merge`가 통짜 원수치를 제자리에서 덮는다**(`bench/ab.mjs:644-656`) — 2.6.2 통짜 대 통짜 비교 불가.
8. **N7 처방 후보**: 부팅 격리 표식을 `localStorage`가 아니라 셸 파일로. 코드는 안 고쳤다 — 권고만 적는다.

**이 라운드가 안 한 것(정직하게)**: 실계정으로는 아무것도 안 쟀다. 실 OAuth 왕복 0. M10 라이브 0.
2.6.2 팝오버 계기의 양성 대조 0. `cargo test --workspace` 전수 0(크레이트 하나만 3회).

---

## 부록 A — R4 보고서에서 **고쳐 읽어야 할 줄** (확인 크리틱 R2의 G1·G2)

| R4 위치 | 원문 | 정정 |
|---|---|---|
| §2.4 본문 | 「닿으면 팝오버는 **5행**(Fable 행이 생긴다)이고 **42/43/44가 보인다**」 | 「닿으면 팝오버는 **5행**이 되고 화면에는 **58/57/56**(=100−pct)이 보인다」 — 팝오버는 남은 비율을 그린다(`Chat.tsx:3640`) |
| §2.4 표 헤더 | 「**42/43/44 보임** ✗」 | **그 칸을 내린다.** 판별력 0이다(가설이 참인 세계에서도 false — R5 §2.3 스텁 대조군이 실행으로 증명). 대체 칸은 **`seesRemain`(58/57/56)** |
| §0.3 계기 | `critic-r28f-limitpop2.mjs`의 `sees42`(:267) | **극성이 거꾸로.** 후속 계기는 `critic-r28g-limitpop3.mjs`의 `seesRemain`. 옛 파일은 함정 6대로 **안 덮었다** |
| §4 F3 정정문 | 「**3.0에는 그 호출부가 없다**」 | **`1078718` 기준**으로만 참. `efdc08c`가 `Settings.tsx`에 호출부를 만들었고 HEAD는 `:555`에 있다 |
| 부록 A `codex-auth:set-default-account` 행 | 「3.0에 호출부 없음 … **채널 미구현은 그대로**」 | **baseline `1078718` 기준**. **HEAD: 채널 구현됨**(`ipc/accounts.rs`의 `CODEX_SET_DEFAULT_ACCOUNT` 팔) · 호출부 `Settings.tsx:555` · **동작도 확인됨**(R5 §3) |
| §7 출하 표 「치명 2 · 출하 불가」 | 유지였다 | **해제** — R5 §9(내 exe로 N1·N2 재현) |
| §3.4 「전량 62건」 | 집계만 실렸다 | **전량 92건 · 본문 표로**(R5 부록 B · G3 처방) |

## 부록 B — 한도 축 관측 **전량 92건**

포함 규칙은 §8 한 줄. 계열: A 팝오버(press) · B `usage.get` 채널 · C 팝오버(A/B `found`) ·
D 팝오버(R3 12주행) · E 설정▸Account 클로드 한도 · F Codex 한도·API 과금 · G 블라인드 판정 ·
H 팝오버(R4 20주행) · **I 팝오버(R5 30주행)**. 시각 오름차순.

| # | 계열 | 시각(UTC) | 앱 | 표면 | prows | 데이터 없음 | 출처 | 관측 |
|---|---|---|---|---|---|---|---|---|
| 1 | B | 2026-08-24 03:16:49 | tauri-3.0.0 | usage.get(채널) | — | true | docs/critic/final-parity-r1-apiprobe-tauri.json | nulls |
| 2 | E | 2026-08-24 03:16:49 | tauri-3.0.0 | 설정▸Account 한도(auth.accountsUsage) | — | — | docs/critic/final-parity-r1-apiprobe-tauri.json | 0행 :: [] |
| 3 | F | 2026-08-24 03:16:49 | tauri-3.0.0 | codexAuth.accountsUsage | — | — | docs/critic/final-parity-r1-apiprobe-tauri.json | 0행 :: [] |
| 4 | F | 2026-08-24 03:16:49 | tauri-3.0.0 | apiConfig.listUsage | — | — | docs/critic/final-parity-r1-apiprobe-tauri.json | 0행 :: [] |
| 5 | B | 2026-08-24 03:16:53 | electron-2.6.2 | usage.get(채널) | — | false | docs/critic/final-parity-r1-apiprobe-electron.json | 실값 (Fable행 有) |
| 6 | E | 2026-08-24 03:16:53 | electron-2.6.2 | 설정▸Account 한도(auth.accountsUsage) | — | — | docs/critic/final-parity-r1-apiprobe-electron.json | 최소 5행 :: [{"email":"lmg…@…","fiveHourPct":0,"weeklyPct":1 |
| 7 | F | 2026-08-24 03:16:53 | electron-2.6.2 | codexAuth.accountsUsage | — | — | docs/critic/final-parity-r1-apiprobe-electron.json | 0행 :: [] |
| 8 | F | 2026-08-24 03:16:53 | electron-2.6.2 | apiConfig.listUsage | — | — | docs/critic/final-parity-r1-apiprobe-electron.json | 0행 :: [] |
| 9 | C | 2026-08-24 03:21:47 | tauri-3.0.0 | 팝오버(A/B found) | 4 | true | bench/shots/tauri/report.json | ok=true · mergedFrom 2026-08-24T03:00:03.306Z |
| 10 | C | 2026-08-24 03:24:05 | electron-2.6.2 | 팝오버(A/B found) | 5 | false | bench/shots/electron/report.json | ok=true · mergedFrom 2026-08-24T03:07:25.088Z |
| 11 | G | 2026-08-24 03:36:32 | judge:2.6.2 | 블라인드 판정(workbar-context-pop) | — | — | docs/critic/final-parity-r1-blind.json | A는 5시간/주간 한도가 '데이터 없음', Fable 행 자체가 없음. B는 %·초기화 시각·게이지 |
| 12 | C | 2026-08-25 06:12:55 | electron-2.6.2 | 팝오버(A/B found) | 4 | true | bench/shots/electron-r28e/report.json | ok=true · mergedFrom 2026-08-25T05:55:18.128Z |
| 13 | C | 2026-08-25 06:16:50 | tauri-3.0.0 | 팝오버(A/B found) | 5 | false | bench/shots/tauri-r28e/report.json | ok=true · mergedFrom 2026-08-25T05:51:35.806Z |
| 14 | B | 2026-08-25 06:21:24 | tauri-3.0.0 | usage.get(채널) | — | false | docs/critic/final-parity-r2-apiprobe-tauri.json | 실값 (Fable행 有) |
| 15 | E | 2026-08-25 06:21:24 | tauri-3.0.0 | 설정▸Account 한도(auth.accountsUsage(cachedOnly)) | — | — | docs/critic/final-parity-r2-apiprobe-tauri.json | 6행 :: [{"e":"lmg"},{"e":"lmg"},{"e":"lmg"},{"e":"jun"},{"e":"lmg"} |
| 16 | F | 2026-08-25 06:21:24 | tauri-3.0.0 | codexAuth.accountsUsage | — | — | docs/critic/final-parity-r2-apiprobe-tauri.json | 0행 :: [] |
| 17 | B | 2026-08-25 06:22:08 | electron-2.6.2 | usage.get(채널) | — | true | docs/critic/final-parity-r2-apiprobe-electron.json | nulls |
| 18 | E | 2026-08-25 06:22:08 | electron-2.6.2 | 설정▸Account 한도(auth.accountsUsage(cachedOnly)) | — | — | docs/critic/final-parity-r2-apiprobe-electron.json | 수치 아님 :: "(2.6.2에서는 안 부른다 — cachedOnly 옵션이 없어 6계정 실조회 = 토큰 회전 위험)" |
| 19 | F | 2026-08-25 06:22:08 | electron-2.6.2 | codexAuth.accountsUsage | — | — | docs/critic/final-parity-r2-apiprobe-electron.json | 0행 :: [] |
| 20 | B | 2026-08-25 06:22:33 | tauri-3.0.0 | usage.get(채널) | — | true | docs/critic/final-parity-r2-apiprobe-tauri-nonet.json | nulls+unavailable |
| 21 | E | 2026-08-25 06:22:33 | tauri-3.0.0 | 설정▸Account 한도(auth.accountsUsage(cachedOnly)) | — | — | docs/critic/final-parity-r2-apiprobe-tauri-nonet.json | 최소 5행 :: ["{\"email\":\"lmg…@…\",\"fiveHourPct\":0,\"week |
| 22 | F | 2026-08-25 06:22:33 | tauri-3.0.0 | codexAuth.accountsUsage | — | — | docs/critic/final-parity-r2-apiprobe-tauri-nonet.json | 0행 :: [] |
| 23 | A | 2026-08-25 06:23:29 | tauri-3.0.0 | 팝오버(press) | 4 | true | docs/critic/final-parity-r2-press-tauri.json | 컨텍스트120K / 1M 토큰현재 컨텍스트이 대화가 차지하는 컨텍스트 창12%5시간 한도데이터 없음—주간 한도데이터 없음—토큰 사용량입력 0 · 출력 0 · 캐시 |
| 24 | A | 2026-08-25 06:24:45 | tauri-3.0.0 | 팝오버(press) | 5 | false | docs/critic/final-parity-r2-press-tauri-eb.json | 컨텍스트120K / 1M 토큰현재 컨텍스트이 대화가 차지하는 컨텍스트 창12%5시간 한도초기화 시간 미상100% 남음Fable 주간 한도1일 7시간 후 초기화67 |
| 25 | A | 2026-08-25 06:25:21 | electron-2.6.2 | 팝오버(press) | 4 | true | docs/critic/final-parity-r2-press-electron-eb.json | 컨텍스트120K / 1M 토큰현재 컨텍스트이 대화가 차지하는 컨텍스트 창12%5시간 한도데이터 없음—주간 한도데이터 없음—토큰 사용량입력 0 · 출력 0 · 캐시 |
| 26 | A | 2026-08-25 06:27:49 | electron-2.6.2 | 팝오버(press) | 4 | true | docs/critic/final-parity-r2-press-electron-limit2.json | 컨텍스트120K / 1M 토큰현재 컨텍스트이 대화가 차지하는 컨텍스트 창12%5시간 한도데이터 없음—주간 한도데이터 없음—토큰 사용량입력 0 · 출력 0 · 캐시 |
| 27 | C | 2026-08-25 06:29:42 | tauri-3.0.0 | 팝오버(A/B found) | 5 | false | bench/shots/tauri-r28e2/report.json | ok=true |
| 28 | C | 2026-08-25 06:35:59 | tauri-3.0.0 | 팝오버(A/B found) | 4 | true | bench/shots/tauri-r28ex/report.json | ok=true |
| 29 | D | 2026-08-25 07:45:46 | tauri-3.0.0 | 팝오버(R3 seeded) | 4 | true | docs/critic/final-parity-r3-limitpop-tauri-seeded.json#run1 | 계정 0개 · usage-cache 1682B · nulls+unavailable |
| 30 | D | 2026-08-25 07:45:50 | electron-2.6.2 | 팝오버(R3 seeded·USERPROFILE 격리) | 4 | true | docs/critic/final-parity-r3-limitpop-electron-seeded.json#run1 | 계정 0개 · usage-cache 1682B · nulls |
| 31 | D | 2026-08-25 07:46:02 | tauri-3.0.0 | 팝오버(R3 seeded) | 4 | true | docs/critic/final-parity-r3-limitpop-tauri-seeded.json#run2 | 계정 0개 · usage-cache 1682B · nulls+unavailable |
| 32 | D | 2026-08-25 07:46:06 | electron-2.6.2 | 팝오버(R3 seeded·USERPROFILE 격리) | 4 | true | docs/critic/final-parity-r3-limitpop-electron-seeded.json#run2 | 계정 0개 · usage-cache 1682B · nulls |
| 33 | D | 2026-08-25 07:46:18 | tauri-3.0.0 | 팝오버(R3 seeded) | 4 | true | docs/critic/final-parity-r3-limitpop-tauri-seeded.json#run3 | 계정 0개 · usage-cache 1682B · nulls+unavailable |
| 34 | D | 2026-08-25 07:46:23 | electron-2.6.2 | 팝오버(R3 seeded·USERPROFILE 격리) | 4 | true | docs/critic/final-parity-r3-limitpop-electron-seeded.json#run3 | 계정 0개 · usage-cache 1682B · nulls |
| 35 | D | 2026-08-25 07:46:53 | tauri-3.0.0 | 팝오버(R3 bare) | 4 | true | docs/critic/final-parity-r3-limitpop-tauri-bare.json#run1 | 계정 0개 · usage-cache 0B · nulls+unavailable |
| 36 | D | 2026-08-25 07:46:57 | electron-2.6.2 | 팝오버(R3 bare·USERPROFILE 격리) | 4 | true | docs/critic/final-parity-r3-limitpop-electron-bare.json#run1 | 계정 0개 · usage-cache 0B · nulls |
| 37 | D | 2026-08-25 07:47:10 | tauri-3.0.0 | 팝오버(R3 bare) | 4 | true | docs/critic/final-parity-r3-limitpop-tauri-bare.json#run2 | 계정 0개 · usage-cache 0B · nulls+unavailable |
| 38 | D | 2026-08-25 07:47:13 | electron-2.6.2 | 팝오버(R3 bare·USERPROFILE 격리) | 4 | true | docs/critic/final-parity-r3-limitpop-electron-bare.json#run2 | 계정 0개 · usage-cache 0B · nulls |
| 39 | D | 2026-08-25 07:47:26 | tauri-3.0.0 | 팝오버(R3 bare) | 4 | true | docs/critic/final-parity-r3-limitpop-tauri-bare.json#run3 | 계정 0개 · usage-cache 0B · nulls+unavailable |
| 40 | D | 2026-08-25 07:47:29 | electron-2.6.2 | 팝오버(R3 bare·USERPROFILE 격리) | 4 | true | docs/critic/final-parity-r3-limitpop-electron-bare.json#run3 | 계정 0개 · usage-cache 0B · nulls |
| 41 | B | 2026-08-25 07:51:41 | tauri-3.0.0 | usage.get(false)(채널) | — | true | docs/critic/final-parity-r3-rawprobe.json | nulls+unavailable |
| 42 | H | 2026-08-25 08:45:15 | tauri-3.0.0 | 팝오버(R4 synth-seeded) | 4 | true | docs/critic/final-parity-r4-limitpop-tauri-synth-seeded.json#run1 | 계정 1개 · 2차 usage:get 1201ms · CONNECT 5 · nulls+unavailable · sees42=false(극성 뒤집힘 — 켜질 수 없는 칸) |
| 43 | H | 2026-08-25 08:45:30 | tauri-3.0.0 | 팝오버(R4 synth-seeded) | 4 | true | docs/critic/final-parity-r4-limitpop-tauri-synth-seeded.json#run2 | 계정 1개 · 2차 usage:get 1201ms · CONNECT 5 · nulls+unavailable · sees42=false(극성 뒤집힘 — 켜질 수 없는 칸) |
| 44 | H | 2026-08-25 08:45:46 | tauri-3.0.0 | 팝오버(R4 synth-seeded) | 4 | true | docs/critic/final-parity-r4-limitpop-tauri-synth-seeded.json#run3 | 계정 1개 · 2차 usage:get 1200ms · CONNECT 5 · nulls+unavailable · sees42=false(극성 뒤집힘 — 켜질 수 없는 칸) |
| 45 | H | 2026-08-25 08:46:01 | tauri-3.0.0 | 팝오버(R4 synth-bare) | 4 | true | docs/critic/final-parity-r4-limitpop-tauri-synth-bare.json#run1 | 계정 1개 · 2차 usage:get 1200ms · CONNECT 6 · nulls+unavailable · sees42=false(극성 뒤집힘 — 켜질 수 없는 칸) |
| 46 | H | 2026-08-25 08:46:17 | tauri-3.0.0 | 팝오버(R4 synth-bare) | 4 | true | docs/critic/final-parity-r4-limitpop-tauri-synth-bare.json#run2 | 계정 1개 · 2차 usage:get 1199ms · CONNECT 6 · nulls+unavailable · sees42=false(극성 뒤집힘 — 켜질 수 없는 칸) |
| 47 | H | 2026-08-25 08:46:32 | tauri-3.0.0 | 팝오버(R4 synth-bare) | 4 | true | docs/critic/final-parity-r4-limitpop-tauri-synth-bare.json#run3 | 계정 1개 · 2차 usage:get 1200ms · CONNECT 6 · nulls+unavailable · sees42=false(극성 뒤집힘 — 켜질 수 없는 칸) |
| 48 | H | 2026-08-25 08:46:48 | tauri-3.0.0 | 팝오버(R4 noacct-seeded) | 4 | true | docs/critic/final-parity-r4-limitpop-tauri-noacct-seeded.json#run1 | 계정 0개 · 2차 usage:get 1ms · CONNECT 0 · nulls+unavailable · sees42=false(극성 뒤집힘 — 켜질 수 없는 칸) |
| 49 | H | 2026-08-25 08:47:02 | tauri-3.0.0 | 팝오버(R4 noacct-seeded) | 4 | true | docs/critic/final-parity-r4-limitpop-tauri-noacct-seeded.json#run2 | 계정 0개 · 2차 usage:get 1ms · CONNECT 0 · nulls+unavailable · sees42=false(극성 뒤집힘 — 켜질 수 없는 칸) |
| 50 | H | 2026-08-25 08:47:16 | tauri-3.0.0 | 팝오버(R4 noacct-bare) | 4 | true | docs/critic/final-parity-r4-limitpop-tauri-noacct-bare.json#run1 | 계정 0개 · 2차 usage:get 1ms · CONNECT 0 · nulls+unavailable · sees42=false(극성 뒤집힘 — 켜질 수 없는 칸) |
| 51 | H | 2026-08-25 08:47:30 | tauri-3.0.0 | 팝오버(R4 noacct-bare) | 4 | true | docs/critic/final-parity-r4-limitpop-tauri-noacct-bare.json#run2 | 계정 0개 · 2차 usage:get 1ms · CONNECT 0 · nulls+unavailable · sees42=false(극성 뒤집힘 — 켜질 수 없는 칸) |
| 52 | H | 2026-08-25 08:47:45 | electron-2.6.2 | 팝오버(R4 synth-seeded) | 4 | true | docs/critic/final-parity-r4-limitpop-electron-synth-seeded.json#run1 | 계정 1개 · 2차 usage:get 1204ms · CONNECT 0 · nulls · sees42=false(극성 뒤집힘 — 켜질 수 없는 칸) |
| 53 | H | 2026-08-25 08:48:00 | electron-2.6.2 | 팝오버(R4 synth-seeded) | 4 | true | docs/critic/final-parity-r4-limitpop-electron-synth-seeded.json#run2 | 계정 1개 · 2차 usage:get 1203ms · CONNECT 0 · nulls · sees42=false(극성 뒤집힘 — 켜질 수 없는 칸) |
| 54 | H | 2026-08-25 08:48:16 | electron-2.6.2 | 팝오버(R4 synth-seeded) | 4 | true | docs/critic/final-parity-r4-limitpop-electron-synth-seeded.json#run3 | 계정 1개 · 2차 usage:get 1213ms · CONNECT 0 · nulls · sees42=false(극성 뒤집힘 — 켜질 수 없는 칸) |
| 55 | H | 2026-08-25 08:48:32 | electron-2.6.2 | 팝오버(R4 synth-bare) | 4 | true | docs/critic/final-parity-r4-limitpop-electron-synth-bare.json#run1 | 계정 1개 · 2차 usage:get 1203ms · CONNECT 0 · nulls · sees42=false(극성 뒤집힘 — 켜질 수 없는 칸) |
| 56 | H | 2026-08-25 08:48:47 | electron-2.6.2 | 팝오버(R4 synth-bare) | 4 | true | docs/critic/final-parity-r4-limitpop-electron-synth-bare.json#run2 | 계정 1개 · 2차 usage:get 1214ms · CONNECT 0 · nulls · sees42=false(극성 뒤집힘 — 켜질 수 없는 칸) |
| 57 | H | 2026-08-25 08:49:03 | electron-2.6.2 | 팝오버(R4 synth-bare) | 4 | true | docs/critic/final-parity-r4-limitpop-electron-synth-bare.json#run3 | 계정 1개 · 2차 usage:get 1216ms · CONNECT 0 · nulls · sees42=false(극성 뒤집힘 — 켜질 수 없는 칸) |
| 58 | H | 2026-08-25 08:49:19 | electron-2.6.2 | 팝오버(R4 noacct-seeded) | 4 | true | docs/critic/final-parity-r4-limitpop-electron-noacct-seeded.json#run1 | 계정 0개 · 2차 usage:get 0ms · CONNECT 0 · nulls · sees42=false(극성 뒤집힘 — 켜질 수 없는 칸) |
| 59 | H | 2026-08-25 08:49:34 | electron-2.6.2 | 팝오버(R4 noacct-seeded) | 4 | true | docs/critic/final-parity-r4-limitpop-electron-noacct-seeded.json#run2 | 계정 0개 · 2차 usage:get 0ms · CONNECT 0 · nulls · sees42=false(극성 뒤집힘 — 켜질 수 없는 칸) |
| 60 | H | 2026-08-25 08:49:48 | electron-2.6.2 | 팝오버(R4 noacct-bare) | 4 | true | docs/critic/final-parity-r4-limitpop-electron-noacct-bare.json#run1 | 계정 0개 · 2차 usage:get 0ms · CONNECT 0 · nulls · sees42=false(극성 뒤집힘 — 켜질 수 없는 칸) |
| 61 | H | 2026-08-25 08:50:02 | electron-2.6.2 | 팝오버(R4 noacct-bare) | 4 | true | docs/critic/final-parity-r4-limitpop-electron-noacct-bare.json#run2 | 계정 0개 · 2차 usage:get 0ms · CONNECT 0 · nulls · sees42=false(극성 뒤집힘 — 켜질 수 없는 칸) |
| 62 | B | 2026-08-25 08:51:50 | tauri-3.0.0 | usage.get(false)(채널) | — | true | docs/critic/final-parity-r4-rawprobe.json | nulls+unavailable |
| 63 | I | 2026-08-25 11:58:11 | tauri-3.0.0 | 팝오버(R5 synth-seeded) | 4 | true | docs/critic/final-parity-r5-limitpop-tauri-synth-seeded.json#run1 | 계정 1개 · 2차 usage:get 1200ms · CONNECT 5 · nulls+unavailable · seesRemain=false · seesPlanted(R4 극성)=false |
| 64 | I | 2026-08-25 11:58:27 | tauri-3.0.0 | 팝오버(R5 synth-seeded) | 4 | true | docs/critic/final-parity-r5-limitpop-tauri-synth-seeded.json#run2 | 계정 1개 · 2차 usage:get 1200ms · CONNECT 5 · nulls+unavailable · seesRemain=false · seesPlanted(R4 극성)=false |
| 65 | I | 2026-08-25 11:58:42 | tauri-3.0.0 | 팝오버(R5 synth-seeded) | 4 | true | docs/critic/final-parity-r5-limitpop-tauri-synth-seeded.json#run3 | 계정 1개 · 2차 usage:get 1201ms · CONNECT 5 · nulls+unavailable · seesRemain=false · seesPlanted(R4 극성)=false |
| 66 | I | 2026-08-25 11:58:57 | tauri-3.0.0 | 팝오버(R5 synth-bare) | 4 | true | docs/critic/final-parity-r5-limitpop-tauri-synth-bare.json#run1 | 계정 1개 · 2차 usage:get 1201ms · CONNECT 6 · nulls+unavailable · seesRemain=false · seesPlanted(R4 극성)=false |
| 67 | I | 2026-08-25 11:59:13 | tauri-3.0.0 | 팝오버(R5 synth-bare) | 4 | true | docs/critic/final-parity-r5-limitpop-tauri-synth-bare.json#run2 | 계정 1개 · 2차 usage:get 1200ms · CONNECT 6 · nulls+unavailable · seesRemain=false · seesPlanted(R4 극성)=false |
| 68 | I | 2026-08-25 11:59:28 | tauri-3.0.0 | 팝오버(R5 synth-bare) | 4 | true | docs/critic/final-parity-r5-limitpop-tauri-synth-bare.json#run3 | 계정 1개 · 2차 usage:get 1201ms · CONNECT 6 · nulls+unavailable · seesRemain=false · seesPlanted(R4 극성)=false |
| 69 | I | 2026-08-25 11:59:44 | tauri-3.0.0 | 팝오버(R5 noacct-seeded) | 4 | true | docs/critic/final-parity-r5-limitpop-tauri-noacct-seeded.json#run1 | 계정 0개 · 2차 usage:get 0ms · CONNECT 0 · nulls+unavailable · seesRemain=false · seesPlanted(R4 극성)=false |
| 70 | I | 2026-08-25 11:59:58 | tauri-3.0.0 | 팝오버(R5 noacct-seeded) | 4 | true | docs/critic/final-parity-r5-limitpop-tauri-noacct-seeded.json#run2 | 계정 0개 · 2차 usage:get 1ms · CONNECT 0 · nulls+unavailable · seesRemain=false · seesPlanted(R4 극성)=false |
| 71 | I | 2026-08-25 12:00:12 | tauri-3.0.0 | 팝오버(R5 noacct-seeded) | 4 | true | docs/critic/final-parity-r5-limitpop-tauri-noacct-seeded.json#run3 | 계정 0개 · 2차 usage:get 1ms · CONNECT 0 · nulls+unavailable · seesRemain=false · seesPlanted(R4 극성)=false |
| 72 | I | 2026-08-25 12:00:26 | tauri-3.0.0 | 팝오버(R5 noacct-bare) | 4 | true | docs/critic/final-parity-r5-limitpop-tauri-noacct-bare.json#run1 | 계정 0개 · 2차 usage:get 1ms · CONNECT 0 · nulls+unavailable · seesRemain=false · seesPlanted(R4 극성)=false |
| 73 | I | 2026-08-25 12:00:40 | tauri-3.0.0 | 팝오버(R5 noacct-bare) | 4 | true | docs/critic/final-parity-r5-limitpop-tauri-noacct-bare.json#run2 | 계정 0개 · 2차 usage:get 1ms · CONNECT 0 · nulls+unavailable · seesRemain=false · seesPlanted(R4 극성)=false |
| 74 | I | 2026-08-25 12:00:55 | tauri-3.0.0 | 팝오버(R5 noacct-bare) | 4 | true | docs/critic/final-parity-r5-limitpop-tauri-noacct-bare.json#run3 | 계정 0개 · 2차 usage:get 1ms · CONNECT 0 · nulls+unavailable · seesRemain=false · seesPlanted(R4 극성)=false |
| 75 | I | 2026-08-25 12:01:09 | tauri-3.0.0 | 팝오버(R5 stub) | 5 | false | docs/critic/final-parity-r5-limitpop-tauri-stub.json#run1 | 계정 0개 · 스텁 ok/closed · seesRemain=true · seesPlanted(R4 극성)=false |
| 76 | I | 2026-08-25 12:01:26 | tauri-3.0.0 | 팝오버(R5 stub) | 5 | false | docs/critic/final-parity-r5-limitpop-tauri-stub.json#run2 | 계정 0개 · 스텁 ok/closed · seesRemain=true · seesPlanted(R4 극성)=false |
| 77 | I | 2026-08-25 12:01:43 | tauri-3.0.0 | 팝오버(R5 stub) | 5 | false | docs/critic/final-parity-r5-limitpop-tauri-stub.json#run3 | 계정 0개 · 스텁 ok/closed · seesRemain=true · seesPlanted(R4 극성)=false |
| 78 | I | 2026-08-25 12:02:00 | electron-2.6.2 | 팝오버(R5 synth-seeded) | 4 | true | docs/critic/final-parity-r5-limitpop-electron-synth-seeded.json#run1 | 계정 1개 · 2차 usage:get 1210ms · CONNECT 0 · nulls · seesRemain=false · seesPlanted(R4 극성)=false |
| 79 | I | 2026-08-25 12:02:17 | electron-2.6.2 | 팝오버(R5 synth-seeded) | 4 | true | docs/critic/final-parity-r5-limitpop-electron-synth-seeded.json#run2 | 계정 1개 · 2차 usage:get 1210ms · CONNECT 0 · nulls · seesRemain=false · seesPlanted(R4 극성)=false |
| 80 | I | 2026-08-25 12:02:33 | electron-2.6.2 | 팝오버(R5 synth-seeded) | 4 | true | docs/critic/final-parity-r5-limitpop-electron-synth-seeded.json#run3 | 계정 1개 · 2차 usage:get 1204ms · CONNECT 0 · nulls · seesRemain=false · seesPlanted(R4 극성)=false |
| 81 | I | 2026-08-25 12:02:49 | electron-2.6.2 | 팝오버(R5 synth-bare) | 4 | true | docs/critic/final-parity-r5-limitpop-electron-synth-bare.json#run1 | 계정 1개 · 2차 usage:get 1201ms · CONNECT 0 · nulls · seesRemain=false · seesPlanted(R4 극성)=false |
| 82 | I | 2026-08-25 12:03:04 | electron-2.6.2 | 팝오버(R5 synth-bare) | 4 | true | docs/critic/final-parity-r5-limitpop-electron-synth-bare.json#run2 | 계정 1개 · 2차 usage:get 1212ms · CONNECT 0 · nulls · seesRemain=false · seesPlanted(R4 극성)=false |
| 83 | I | 2026-08-25 12:03:20 | electron-2.6.2 | 팝오버(R5 synth-bare) | 4 | true | docs/critic/final-parity-r5-limitpop-electron-synth-bare.json#run3 | 계정 1개 · 2차 usage:get 1200ms · CONNECT 0 · nulls · seesRemain=false · seesPlanted(R4 극성)=false |
| 84 | I | 2026-08-25 12:03:36 | electron-2.6.2 | 팝오버(R5 noacct-seeded) | 4 | true | docs/critic/final-parity-r5-limitpop-electron-noacct-seeded.json#run1 | 계정 0개 · 2차 usage:get 0ms · CONNECT 0 · nulls · seesRemain=false · seesPlanted(R4 극성)=false |
| 85 | I | 2026-08-25 12:03:50 | electron-2.6.2 | 팝오버(R5 noacct-seeded) | 4 | true | docs/critic/final-parity-r5-limitpop-electron-noacct-seeded.json#run2 | 계정 0개 · 2차 usage:get 0ms · CONNECT 0 · nulls · seesRemain=false · seesPlanted(R4 극성)=false |
| 86 | I | 2026-08-25 12:04:05 | electron-2.6.2 | 팝오버(R5 noacct-seeded) | 4 | true | docs/critic/final-parity-r5-limitpop-electron-noacct-seeded.json#run3 | 계정 0개 · 2차 usage:get 0ms · CONNECT 0 · nulls · seesRemain=false · seesPlanted(R4 극성)=false |
| 87 | I | 2026-08-25 12:04:20 | electron-2.6.2 | 팝오버(R5 noacct-bare) | 4 | true | docs/critic/final-parity-r5-limitpop-electron-noacct-bare.json#run1 | 계정 0개 · 2차 usage:get 0ms · CONNECT 0 · nulls · seesRemain=false · seesPlanted(R4 극성)=false |
| 88 | I | 2026-08-25 12:04:35 | electron-2.6.2 | 팝오버(R5 noacct-bare) | 4 | true | docs/critic/final-parity-r5-limitpop-electron-noacct-bare.json#run2 | 계정 0개 · 2차 usage:get 0ms · CONNECT 0 · nulls · seesRemain=false · seesPlanted(R4 극성)=false |
| 89 | I | 2026-08-25 12:04:50 | electron-2.6.2 | 팝오버(R5 noacct-bare) | 4 | true | docs/critic/final-parity-r5-limitpop-electron-noacct-bare.json#run3 | 계정 0개 · 2차 usage:get 0ms · CONNECT 0 · nulls · seesRemain=false · seesPlanted(R4 극성)=false |
| 90 | I | 2026-08-25 12:07:05 | electron-2.6.2 | 팝오버(R5 stub) | 4 | true | docs/critic/final-parity-r5-limitpop-electron-stub.json#run1 | 계정 0개 · 스텁 THROW defineProperty=Cannot redefine property: getUsage proxy=Cannot redefine property: api/closed · seesRemain=false · seesPlanted(R4 극성)=false |
| 91 | I | 2026-08-25 12:07:23 | electron-2.6.2 | 팝오버(R5 stub) | 4 | true | docs/critic/final-parity-r5-limitpop-electron-stub.json#run2 | 계정 0개 · 스텁 THROW defineProperty=Cannot redefine property: getUsage proxy=Cannot redefine property: api/closed · seesRemain=false · seesPlanted(R4 극성)=false |
| 92 | I | 2026-08-25 12:07:40 | electron-2.6.2 | 팝오버(R5 stub) | 4 | true | docs/critic/final-parity-r5-limitpop-electron-stub.json#run3 | 계정 0개 · 스텁 THROW defineProperty=Cannot redefine property: getUsage proxy=Cannot redefine property: api/closed · seesRemain=false · seesPlanted(R4 극성)=false |

— 최종 파리티 감사 R5 (Claude Fable 5)
