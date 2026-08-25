> **정정 — `docs/critic/final-parity-r5.md`를 먼저 읽어라.** ① §2.4의 판별 칸 「42/43/44 보임」은 **가설이 참이어도 켜질 수 없는 계기**였다(팝오버는 `100−pct`를 그린다 — R5 §2, 부록 A). ② §4·부록 A의 「codex-auth:set-default-account 채널 미구현」은 **baseline `1078718` 기준**이고 HEAD에서는 구현·동작 확인됐다. ③ **§7의 「치명 2 · 출하 불가」는 R5에서 해제됐다 — 치명 0**(N1·N2를 R5가 자기 exe로 재현).

# 최종 파리티 감사 R4 — 「못 잰다」가 최선이 아니었다. 문을 열고 다시 재니, 그 처방은 정말로 이 화면에 안 닿는다

판정자: 최종 파리티 감사 R4(정정 라운드 2) · 2026-08-25 · `feature/3.0.0-beta`
대상: 내가 쓴 `docs/critic/final-parity-r3.md`(커밋 `6d72eff` · 잔손질 `0ec5105`)
지시: `docs/critic/r28f-audit-critic-r1.md`(확인 크리틱 R1 — 감사 **통과**, 두 칸 정정 + 나사 둘)

> 이 라운드도 **새 격차를 찾는 라운드가 아니다.** 크리틱이 실패시킨 칸(F1·F2)을 고치고,
> 그 실측을 **내 손으로 다시 떠서** 초록을 확인한다. **코드는 한 줄도 안 고쳤다.**

---

## 0. 무엇으로 쟀나

| 항목 | 값 |
|---|---|
| 판정 exe | `C:\Temp\ccg-r28f-audit\target\release\agentcodegui.exe` · **6,545,408 B** · sha256 `526c70273a7819c14c0a25283a40bf6eb82e7d660be7727a9f92178d776ba850` (R3가 `1078718` 순수 트리에서 구운 그 바이너리) |
| 2.6.2 | `node_modules/electron/dist/electron.exe`(**42.3.2** · node 24.15.0 · undici 7.24.4) + 커밋된 `out/`(읽기만) |
| 계기(신규) | `docs/critic/tools/critic-r28f-limitpop2.mjs` · `critic-r28f-observations2.mjs` (+ `critic-r28f-rawprobe.mjs` 라벨 정정) |
| 홈 | 주행마다 격리 — `C:\Temp\ccg-r28f-audit\home-lp2-*`(디렉터리 **20개** · 스모크 2회는 같은 이름을 다시 만들어 덮었다) · 2.6.2는 `USERPROFILE`까지 격리(`uprof-lp2`) |
| CDP 포트 | 10530(3.0) · 10531(2.6.2) · 10534(rawprobe) — 배정표(AUDIT 10530~) 준수 |
| 프록시 싱크 | `127.0.0.1:10539`(이 도구가 띄운다 · CONNECT를 502로 끊는다) |
| 주행 | **24회** — `limitpop2` 20 · 스모크 2 · `rawprobe` 1 · electron 소켓 계측 1 |
| 프로세스 | 이름 기반 kill **0회** — 내가 스폰한 PID만(`killTree`) |

### 0.1 왜 exe를 다시 안 구웠나 — 그리고 그게 왜 「낡은 값」이 아닌가

이 라운드가 판정하는 문장은 **R3가 `1078718` 트리에서 낸 수치**다. 같은 문장을 다른
바이너리로 재면 두 변수가 한꺼번에 움직인다. 그래서 exe는 그대로 쓰되, **내가 재는 코드
경로가 baseline 이후 안 움직였다는 것을 명령으로 확인**했다:

```
git diff --stat 1078718..HEAD -- src-tauri/src/ipc/parity/usage.rs crates/ccg-auth/src/usage.rs \
                                 crates/ccg-auth/src/net.rs src/main/index.ts src/main/auth.ts out/main/index.js
   → (비어 있음)
git diff       1078718..HEAD -- app/src/components/Chat.tsx   → @@ 3327 / @@ 3378 (LimitHoldBar) 두 훅뿐
git diff       1078718..HEAD -- app/src/App.tsx               → usage·limit·workbar 문자열이 든 줄 변경 0
```

즉 `usage:get`의 문(3.0 Rust · 2.6.2 메인)과 팝오버 행 조립부는 baseline과 **HEAD가 같은
코드**다(`Chat.tsx`의 Fable 행 조건식은 baseline `:4142` → HEAD `:4168`로 **줄만** 밀렸고
문자열은 2.6.2 `src/renderer/src/components/Chat.tsx:3322`와 바이트 동일). 이 라운드의 결론은 HEAD에도 그대로 선다. (그 사이에 들어온 변경은
SHIPBLOCK의 계정 축 배선과 WFIRE의 `LimitHoldBar` — **둘 다 이 문 밖이다.** → §7)

### 0.2 안전 규약 — 실계정 0 · 실 HTTP 0, 이번엔 **기계가 보장한다**

R3는 「계정을 안 심었으니 조회가 안 나간다」로 회전 위험을 없앴다. 이 라운드는 **일부러
계정을 심는다**(그래야 문이 열린다). 그래서 안전을 다른 두 장치로 옮겼다:

| 무엇 | 어떻게 | 증거 |
|---|---|---|
| 실계정 자격증명 | 픽스처가 복사한 `accounts.json`·`codex-accounts.json`·`accounts/`를 **앱 기동 전에** 삭제. 심는 것은 100% 합성(`audit-synth@example.invalid` · 토큰도 가짜) | 주행 기록 `accountsRemovedFromFixture` · `acctEmails=["audit-synth@example.invalid"]` (20/20) |
| 3.0의 나가는 요청 | `HTTPS_PROXY=http://127.0.0.1:10539` — ureq는 **명시 프록시를 읽는다**(`net.rs:129 env_proxy`). 싱크는 `CONNECT`를 받고 **502로 끊는다**(터널을 안 연다) | 싱크 로그 **33건 전부 `CONNECT api.anthropic.com:443`** · 밖으로 0바이트 |
| 2.6.2의 나가는 요청 | 합성 액세스 토큰에 개행을 넣는다 → `fetch`의 `Authorization: 'Bearer ' + token`이 **소켓 전에** undici 헤더 검증에서 죽는다 | 같은 electron 바이너리 메인 프로세스에서 `net.Socket.prototype.connect`를 감싸 계측: **`socketsOpened: 0`** · `TypeError: Headers.append: … is an invalid header value.` · 20ms (`final-parity-r4-electron-nosocket.json`) |

**두 장치 다 「안 나갔을 것이다」가 아니라 「안 나갔다」를 기록으로 남긴다.** 그리고 심은
가짜 토큰은 두 앱 모두 **로컬에서** 받아들인다(만료 +30일) — 리프레시 교환 경로가 열리지
않으므로 함정 5가 말하는 회전은 애초에 시작되지 않는다.

### 0.3 증거 파일 (전부 이 라운드 산출 · 기존 파일 무손상)

| 파일 | 무엇 |
|---|---|
| `docs/critic/final-parity-r4-limitpop-{tauri,electron}-{synth,noacct}-{seeded,bare}.json` | **20주행** 2×2×2 배치 |
| `docs/critic/final-parity-r4-observations.json` | 한도 축 관측 **전량 62건**(포함 규칙을 코드로 못 박은 판) |
| `docs/critic/final-parity-r4-rawprobe.json` | baseline exe 원시 채널 재프로브(라벨 정정 + 방출자 프로브 추가) |
| `docs/critic/final-parity-r4-electron-nosocket.json` | 2.6.2 팔이 소켓을 **0개** 연다는 계측 |
| `docs/critic/final-parity-r4-channels-head.json` | 계약면을 **HEAD**에서 다시 센 값(§7) |

---

## 1. 한 문단 결론

**크리틱의 F1은 옳다. 인정하고, 그 실험을 판별력 있게 다시 만들었다.** R3의 12주행은 전
주행 계정 0이라 두 앱 모두 캐시를 **보기도 전에** 되돌아갔고 — 나는 그것을 이제 소스가
아니라 **실행으로** 보인다(계정 0 팔: 2차 `usage:get` **0~1ms** · `CONNECT` **0건** ·
`accountsUsage` **0행**). 크리틱이 처방으로 단 괄호(*「함정 5 안에서는 합성 자격증명이
불가하므로 못 잰다가 최선」*)는 **틀렸다.** 합성 계정은 함정 5 안에서 가능하고(크리틱
자신도 codex 축에서 그렇게 했다), 실 HTTP를 0으로 묶은 채 문을 열 수 있다. **문을 열고
20주행을 다시 뜬 결과, 결론은 바뀌지 않았다** — 계정이 있고 조회가 실패하는 상태에서도
디스크 `usage-cache.json`은 팝오버에 **닿지 않는다**(seeded/bare 전부 4행·데이터 없음).
같은 파일이 **같은 순간** 설정 ▸ Account 채널에서는 42%로 그려진다(양성 대조).

**F2도 옳고, 크리틱이 센 것보다 컸다.** 「전량 27건」의 밖에 있던 관측은 6건이 아니라
**14건**이다(크리틱의 6 + 내가 더 찾은 8 = `usage.get` 1 · `codexAuth.accountsUsage` 5 ·
`apiConfig.listUsage` 2). 포함 규칙을 코드에 못 박고 다시 세니 **62건**이다. §2.6의 각주도
고친다(#7 → 네트워크를 끈 주행 관측).

**F3·F4도 사실이다**(§4·§5). **출하 판정은 안 움직인다 — 치명 2 · 출하 불가**, 그 둘은
SHIPBLOCK 갈래 소관이다(§7).

---

## 2. ★F1 — 간판 실험은 판별력이 0이었다. 인정하고, **문을 열어** 다시 쟀다

### 2.1 R3가 뭐라고 썼나

> §2.3 「숙제 (a)의 처방 그대로 — 캐시를 심고 **각 3회 이상** 다시 쟀다 … **두 앱이 완전히
> 같다**. 12/12 주행에서 `hasNoData`가 안 흔들렸다.」

그 표에는 `계정 0`이 **숫자로 적혀 있다.** 그런데 그게 무슨 뜻인지는 한 줄도 안 적혀 있다.
뜻은 이렇다 — **그 12주행은 어떤 가설도 못 가른다.**

### 2.2 왜 못 가르나 (소스) — 그리고 그것을 **실행으로** 확인했다

```
3.0    src-tauri/src/ipc/parity/usage.rs:176-183
         let email = account… .or_else(ccg_auth::claude::default_account_email);
         let Some(email) = email else { return unavailable_usage() };   ← 캐시·네트워크 **앞**
2.6.2  src/main/index.ts:1027-1028
         const tk = await usageTokenFor(account); if (!tk) return empty; ← 같음
```

R3의 배치는 이 문 앞에서 끝난다. 게다가 R3가 심은 캐시는 실홈 사본이라 **등록되지도 않은
남의 이메일**로 키가 잡혀 있었다 — 설령 문을 지났어도 그 계정 줄은 거기 없다. **두 겹으로
무효다**(크리틱은 앞의 한 겹만 짚었다).

이번에는 그걸 소스로만 말하지 않는다. 같은 배치(`noacct-*` 팔)를 다시 떠서 **문 앞에서
되돌아간다는 사실 자체를 계측**했다:

| 계측 | 계정 0 팔(= R3의 배치) | 계정 1 팔(합성) |
|---|---|---|
| 연속 두 번째 `usage:get` 지연 | 3.0 **1 ms** ×2 · 2.6.2 **0 ms** ×2 | 3.0 **1,199~1,201 ms** ×3 · 2.6.2 **1,203~1,216 ms** ×3 |
| 3.0 프록시 싱크에 찍힌 `CONNECT` | **0건** | 주행당 **5~6건**(합 33) |
| `auth:accounts-usage`(디스크를 읽는 채널) | **0행** | **1행** |

두 앱 다 usage 호출을 **전역 큐 + 1,200ms 간격**으로 직렬화한다
(`crates/ccg-auth/src/usage.rs:30 USAGE_GAP_MS` · `src/main/auth.ts:505 usageSlot`(간격 `:504`)). 문 앞에서 되돌아가면 큐에 **안 들어가므로** 연속 호출이
둘 다 즉시다. 즉 **0~1ms는 「캐시를 보지도 않았다」의 실행 증거**이고, 1,200ms는 「끝까지
갔다」의 실행 증거다. 3.0 쪽은 여기에 더해 **요청이 실제로 조립돼 나갔다는 흔적**(내 싱크에
찍힌 `CONNECT api.anthropic.com:443`)까지 남는다.

**R3의 12주행은 이 계측에서 왼쪽 칸이다. 그 일치는 아무 정보도 주지 않는다.**

### 2.3 크리틱의 괄호에 대한 반박 — 합성 자격증명은 함정 5 **안에서** 가능하다

크리틱은 처방 (b)에 이렇게 달았다: *「진짜로 가르려면 합성 자격증명이 필요하고 그건 함정 5
안에서는 불가하다 — **못 잰다고 적는 것**이 최선이다.」* **이 괄호는 틀렸다.** 함정 5가
금지하는 것은 *사용자 실홈의 자격증명을 복사·수정하는 것과 실계정 토큰 회전을 유발하는
것*이지, 격리 홈에 **가짜 계정을 만드는 것**이 아니다. 크리틱 자신도 §4.4에서 합성
`codex-accounts.json`으로 같은 일을 했다. 클로드 축도 같은 방식으로 열린다:

```
<홈>/accounts.json                      {"version":3,"defaultEmail":"audit-synth@example.invalid",
                                         "accounts":[{"email":"audit-synth@example.invalid","subscriptionType":"max"}]}
<홈>/accounts/<slug>/.credentials.json  {"claudeAiOauth":{"accessToken":"synthetic-…","expiresAt":now+30d,…}}
   slug = ccg-auth/src/lib.rs:125 account_slug == src/main/auth.ts:217 accountSlug  (두 앱 같은 규칙)
```

`claude.rs:1977-1988 account_access_token`(3.0)과 `auth.ts:376 accountAccessToken`(2.6.2 · 만료 판정은 `:394`)은
**만료만 본다** — 서명도 서버 확인도 없다. 그래서 이 가짜 토큰은 **네트워크 0회**로 토큰
문을 통과하고, 회전 경로(`net.rs:334 rotate`)는 애초에 안 열린다. 즉 **회전 위험 0 · 실계정
접촉 0 · 문은 열림.** 「못 잰다」가 아니라 **잴 수 있었다.**

### 2.4 판별력 있는 배치 — 20주행 (2 앱 × 2 계정상태 × 2 캐시상태)

심은 디스크 캐시는 **그 합성 계정의 이메일로** 키를 잡고 값을 유별나게 뒀다
(239 B · 5h **42%** · 주간 **43%** · Fable **44%**). 그러니 가설이 진짜로 갈린다 —
닿으면 팝오버는 **5행**(Fable 행이 생긴다)이고 42/43/44가 보인다.

> ※ **이 문장은 틀렸다 — R5 §2.3 정정.** 팝오버는 `100−pct`(**남음**)를 그린다
> (`app/src/components/Chat.tsx:3640`). 그래서 42/43/44를 심으면 화면에 뜨는 숫자는
> **58/57/56**이고, 바로 아래 표의 「42/43/44 보임」 칸은 **가설이 참인 세계에서도 false** —
> 판별력 0이다. 대체 칸은 `seesRemain`(58/57/56)이고, R5 §2.3의 스텁 대조군이
> 「고친 칸은 켜지고 옛 칸은 안 켜진다」를 실행으로 증명한다. **결론(4행·데이터 없음)은
> 안 흔들린다 — 흔들리는 것은 「무엇이 그 판을 갈랐는가」다.**

| 앱 | 팔 | 계정 | 팝오버 `prows` | 데이터 없음 | 42/43/44 보임<br>(※판별력 0 · R5 §2.3) | 2차 `usage:get` | `CONNECT` | `accountsUsage(cachedOnly)` |
|---|---|---|---|---|---|---|---|---|
| 3.0 | `synth-seeded` ×3 | 1 | **4** | true | **✗** | 1,201·1,201·1,200 ms | 15 | **`[{…,42,43,44}]`** ← 양성 대조 |
| 3.0 | `synth-bare` ×3 | 1 | **4** | true | ✗ | 1,200·1,199·1,200 ms | 18 | `[{…,null,null,null}]` |
| 3.0 | `noacct-seeded` ×2 | 0 | 4 | true | ✗ | **1·1 ms** | **0** | `[]` |
| 3.0 | `noacct-bare` ×2 | 0 | 4 | true | ✗ | **1·1 ms** | **0** | `[]` |
| 2.6.2 | `synth-seeded` ×3 | 1 | **4** | true | **✗** | 1,204·1,203·1,213 ms | — | **`[{…,42,43,44}]`** ← 양성 대조 |
| 2.6.2 | `synth-bare` ×3 | 1 | **4** | true | ✗ | 1,203·1,214·1,216 ms | — | `[{…,null,null,null}]` |
| 2.6.2 | `noacct-seeded` ×2 | 0 | 4 | true | ✗ | **0·0 ms** | — | `[]` |
| 2.6.2 | `noacct-bare` ×2 | 0 | 4 | true | ✗ | **0·0 ms** | — | `[]` |

팝오버 실측 텍스트(20/20 동일한 모양):

```
컨텍스트 120K / 1M 토큰 · 현재 컨텍스트 12% · 5시간 한도 데이터 없음 — · 주간 한도 데이터 없음 — · 토큰 사용량 …
   ↑ 4행. Fable 행 없음. 42·43·44 어디에도 없음.
```

**세 칸이 동시에 참이라 이 배치는 판별력이 있다:**

1. **문은 열렸다** — 계정 1 팔의 2차 호출이 1.2초 큐에 걸리고, 3.0 쪽은 요청이 실제로
   조립돼 내 싱크까지 왔다(`CONNECT` 33건). 즉 `cached()`·`stale()`(3.0)과
   `usageCache`(2.6.2)를 **실제로 지나갔다**.
2. **심은 파일은 유효하다** — 같은 순간 같은 홈의 같은 파일을 `auth:accounts-usage`가
   읽어 **42%를 그린다**. 키도 맞고 포맷도 맞고 앱이 읽기도 한다. (`bare` 팔에서 같은
   채널이 `null` 행을 주는 것이 그 대조다.)
3. **그런데도 팝오버는 4행 · 데이터 없음이다.**

→ **디스크 `usage-cache.json`은 이 화면에 안 닿는다. 이제 소스가 아니라 실행으로 그렇다.**
부수로: 주행 전후 심은 파일의 sha가 **20/20 동일**하고(`plantedCacheSha == diskCacheAfter.sha`),
`bare` 팔에서는 파일이 **생기지도 않았다** — 조회가 한 번도 성공하지 않았으므로 두 앱 다
캐시를 쓰지 않았다.

### 2.5 판정 — 숙제 (a)의 닫힘 근거를 **다시 적는다**

| 항목 | R3의 표기 | R4의 표기 |
|---|---|---|
| 숙제 (a)를 닫은 근거 | 「캐시를 심고 각 3회 재니 두 앱이 완전히 같다」(§2.3) | **① 소스**(양쪽 다 메모리 캐시 전용 · §2.4) **② 한도 축 관측 이력**(§3) **③ 문을 연 20주행**(§2.4 — R4가 새로 더한 것) |
| R3의 12주행 | 처방의 무효를 보인 실측 | **판별력 0.** 계정이 0이라 캐시·네트워크 앞에서 끝난다 — 계측으로도 확인(2차 호출 0~1ms · `CONNECT` 0) |
| `limit-pop`·`workbar-context-pop` 분류 | **환경 의존** | **환경 의존 — 유지.** 근거는 12주행이 아니라 위 ①②③ |
| T3 「닫힘」 | 유지 | **유지**(근거 각주는 §3.3에서 고친다) |

**출하 판정에는 영향이 없다**(크리틱과 같은 결론).

---

## 3. F2 — 「관측 전량」의 밖에 있던 것은 6건이 아니라 **14건**이었다

### 3.1 규칙을 사람 머리가 아니라 **코드**에 못 박았다

R3의 「전량 27건」은 실제로 **세 계열**(press `limit-pop` · apiprobe `usage.get` · A/B
`workbar-context-pop`)이었다. 「고르지 말라」가 숙제였으므로, 이번엔 무엇이 들어오는지를
수집기 헤더에 규칙으로 적고 그 규칙대로만 훑는다(`critic-r28f-observations2.mjs`):

> **포함 규칙 = 「두 앱 중 한쪽이라도 *한도 수치를 사용자에게 보여 주는 표면*의 값이
> 증거 파일에 기록된 자리」** — 표면 이름이 무엇이든, 극성이 어느 쪽이든.

그 규칙이 잡는 표면은 다섯 + 판정 하나다: ① 워크바 팝오버 ② 팝오버를 먹이는 채널
(`usage.get` — apiprobe **와 rawprobe**) ③ 설정 ▸ Account 클로드 한도(`auth.accountsUsage`)
④ 같은 화면 Codex 한도(`codexAuth.accountsUsage`) ⑤ API 과금 사용량(`apiConfig.listUsage`)
⑥ 블라인드 판정의 한도 축 행.

### 3.2 표 밖이었던 14건 (R3 시점 기준)

| # | 파일 | 관측 | 극성 | 크리틱이 셌나 |
|---|---|---|---|---|
| 1 | `final-parity-r1-apiprobe-tauri.json#auth.accountsUsage` | `[]`(0행) | 3.0 불리 | ✅ |
| 2 | `final-parity-r1-apiprobe-electron.json#auth.accountsUsage` | 실값 행(700자 절단 · 최소 5행) | 2.6.2 유리 | ✅ |
| 3 | `final-parity-r2-apiprobe-tauri.json#auth.accountsUsage(cachedOnly)` | **6행** | 3.0 유리 | ✅ |
| 4 | `final-parity-r2-apiprobe-tauri-nonet.json#…(cachedOnly)` | 최소 5행(절단) · **`CCG_NO_NET=1`** | 3.0 유리 | ✅ |
| 5 | `final-parity-r2-apiprobe-electron.json#…(cachedOnly)` | 「2.6.2엔 옵션이 없어 안 부른다」 | — | ✅ |
| 6 | `final-parity-r1-blind.json#workbar-context-pop` | 블라인드 승자 **2.6.2**(*"A는 데이터 없음, B는 %·게이지"*) | 3.0 불리 | ✅ |
| 7 | `final-parity-r3-rawprobe.json#usage.get(false)` | nulls+`unavailable` · 계정 0 | 3.0 불리 | ⛔ **크리틱도 놓쳤다** |
| 8–12 | apiprobe 5파일 `#codexAuth.accountsUsage` | 전부 `[]`(0행) — 두 앱 다 | 중립 | ⛔ |
| 13–14 | `final-parity-r1-apiprobe-{tauri,electron}.json#apiConfig.listUsage` | 전부 `[]` | 중립 | ⛔ |

**숨긴 반대 관측은 0이다**(빠진 14건 중 3.0에 유리한 것은 2건뿐이고 나머지는 불리하거나
중립이다). 그래도 이 표의 취지는 「유불리」가 아니라 **「고르지 말라」**이므로, 놓친 8건도
같은 무게로 적는다. #7이 뼈아프다 — R3의 수집기는 파일명에 `apiprobe`가 든 것만 훑어서
**자기가 그 라운드에 만든 rawprobe 파일**의 같은 채널 관측을 통째로 빠뜨렸다.

### 3.3 §2.6 각주 정정 — 「네트워크 0회로 6행」의 출처는 **#7이 아니다**

R3 §2.6은 T3 「닫힘」의 근거 셋을 전부 `#7`로 각주했는데, `#7`은 `usage.get` 행이다.
`accounts-usage(cachedOnly)`가 6행이라는 관측은 **같은 파일의 다른 자리**이고 표에 없었다.
게다가 「**네트워크 0회**」를 실제로 보증하는 것은 위 표의 **#4**다 — 그쪽이
`CCG_NO_NET=1` 주행이기 때문이다(#3은 같은 라운드에서 실 조회가 성공한 주행이라
「0회」의 증거가 못 된다). 고쳐 적는다:

> T3 「닫힘」의 근거 = ① `usage:get`이 실값을 준다(R3 표 #7) · ② `accounts-usage(cachedOnly)`가
> **`CCG_NO_NET=1`에서도** 디스크로 행을 그린다(§3.2 **#4** · 보조 #3) · ③ `CCG_NO_NET=1`에서
> `unavailable:true` 표식(R3 표 #9). ②는 이번 라운드에서 **합성 계정으로 재현**했다 —
> 네트워크가 전부 싱크에서 끊긴 20주행에서 `cachedOnly`가 디스크 행을 그렸다(§2.4).

### 3.4 새 총계

```
포함 규칙대로 다시 센 전량 = 62건
  A 팝오버(press)              4     E 설정▸Account 클로드 한도      5
  B usage.get 채널              7     F Codex 한도 · API 과금         7
  C 팝오버(A/B found)           6     G 블라인드 판정                 1
  D 팝오버(R3 12주행)          12     H 팝오버(R4 20주행)            20
R3가 「전량」이라 부른 범위 = A4 + B(apiprobe 5) + C6 + D12 = 27  → 밖에 있던 것 14건(§3.2)
극성(A~D만 · E~H는 행 수/판정이라 4↔5 극성이 없다):
  3.0 값 있음 4 / 데이터 없음 13   ·   2.6.2 값 있음 2 / 데이터 없음 10
```

라운드별 극성(R1 3.0 0값·2무 / 2.6.2 2값·0무 · R2 3.0 4값·2무 / 2.6.2 0값·4무)은 R3 표
그대로다 — 크리틱도 독립 수집으로 같은 값을 얻었다. **이 지표로 승패를 매길 수 없다**는
결론은 관측을 14건 더 실어도 그대로다.

---

## 4. F3 — §7.2의 한 칸이 3.0에 없는 호출부를 가리켰다

크리틱의 지적은 사실이다. `1078718` 트리에서 확인:

```
3.0    app/src/components/Settings.tsx  codexAuth.setDefaultAccount 호출 0회
       (:507 login · :518 logout · :537·:563·:584 reorderAccounts · :763 cancelLogin — 그게 전부)
       :495는 **클로드 축**(auth.setDefaultAccount)이고 그 값은 setAccounts로 간다
2.6.2  src/renderer/src/components/Settings.tsx:429  setCxAccounts(await window.api.codexAuth.setDefaultAccount(email))
```

**정정**: §7.2 표의 `codex-auth:set-default-account` 행에서 「앉는 자리 = `setCxAccounts`」를
내린다. 3.0에는 그 호출부가 없다 — 기본 지정을 `reorderAccounts`로 대신하기 때문이고
(`:537`), 그래서 이 채널의 위험은 **다른 넷과 같은 「목록 증발」이 아니다.** 다만
**채널 자체는 여전히 미구현**이고(§6의 원시 프로브에서 `{__unimplemented:true}`),
2.6.2에는 있는 UI 경로가 3.0에 없다는 사실은 그대로 남는다. 나머지 네 행
(login · logout · reorder · `app:open-directory`)은 내 실측과 일치한다.

## 5. F4 — 인용 줄 두 개 (하나는 내 실측으로 다시 확인했다)

| R3의 인용 | 실제 | 확인 |
|---|---|---|
| `src-tauri/nsis/hooks.nsh:26` = `CCG3_DIRSHELL` | **:28**이 `!define CCG3_DIRSHELL "Software\Classes\Directory\shell\${CCG3_KEY}"` · :26은 `CCG3_VERB` · HKCU 쓰기는 **:39-41**(`Directory\shell`)·**:44-46**(`Background\shell`) · 매크로는 :31 | 파일에서 직접 확인. **실체(설치기가 HKCU에 우클릭 항목을 쓴다)는 사실** — N3 승격 근거는 안 흔들린다 |
| `final-parity-r3-rawprobe.json`의 키 `shim:app.openDirectory 구독자` | 잰 것은 **구독자**(`onOpenDirectory`)인데 라벨이 방출자 이름이었다 | 도구를 고치고(`critic-r28f-rawprobe.mjs`) **방출자도 따로 쟀다**: `typeof window.api.app.onOpenDirectory = "function"` · `typeof window.api.app.openDirectory = **"undefined"**`(`final-parity-r4-rawprobe.json`) |

> 기존 증거 파일(`final-parity-r3-rawprobe.json`)은 **덮지 않았다**(함정 6). 라벨이 어긋난
> 사실을 여기 적고, 바른 라벨의 새 파일을 옆에 뒀다.

---

## 6. 안 움직인 것 — 내 손으로 다시 눌러 확인했다

**R3의 정정 넷은 전부 그대로 선다**(크리틱도 독립 실측으로 넷 다 사실로 확인했다):

| R3 정정 | 이 라운드의 재확인 |
|---|---|
| ① T3의 「역전 · 3.0 승」 철회 · §5 블라인드 칸 「미판정」 | **유지.** 관측을 14건 더 실어도 극성 결론이 그대로다(§3.4). 블라인드 관측 자체도 이제 표 안에 있다(§3.2 #6) |
| ② N3(`app:open-directory`) 중간 → **높음** | **유지.** baseline exe 재프로브에서 `raw:app:open-directory` → `{"__unimplemented":true}` · 방출자 `undefined` · 구독자 `function`. **HEAD에서도 여전히 `missing`**(§7) |
| ③ T1 「채널·화면 확인 · 왕복 미검증」 | **유지.** 이 라운드도 `auth:login`·`auth:logout`을 **한 번도 안 불렀다** |
| ④ 통짜 73.6% · 병합 99.2% 병기 | **유지.** R3 §1·§5·§8에 그대로 있다 |
| 숙제 (c) `explorer-tree` 103/105 = 픽스처 노이즈 | **유지.** 근거는 **내 R3 실측 114/114**(두 앱 동시 · 2라운드 · 라벨 차집합 0)다. 확인 크리틱도 독립 6주행으로 같은 결론을 냈다고 적었다(레포 119/119·119/119·118/118 · 통제에서 폴더 2개 추가에 40/40 → **42/42**) — **그건 그쪽 주행이고 나는 재현하지 않았다.** 인용은 보강일 뿐 근거의 대체가 아니다 |

baseline exe 원시 채널 재프로브(`final-parity-r4-rawprobe.json` · 이 라운드 주행):

```
raw:codex-auth:{login,logout,login-cancel,reorder-accounts,set-default-account} → {"__unimplemented":true} ×5   (N1, baseline 기준)
raw:app:open-directory → {"__unimplemented":true}   raw:app:get-initial-dir → null                              (N3)
raw:auth:login-cancel → null   raw:auth:reorder-accounts → []                                                   (T1)
raw:btw:open · raw:shortcut:close · raw:ui:open-api-settings → null ×3                                          (T4·M1·M3)
engine.state → bundled "unknown" / active 0.3.245   ·   engine.listAvailable → latest 0.3.245 · 277개           (T2·M6)
git.aiMessage(비-git) → {"ok":false,"error":"Git 저장소가 아니에요"}   ·   usage.get → nulls + unavailable:true  (M5·T3)
shim:codexAuth.{reorderAccounts([]),login(),logout()} → **[] 를 resolve** + 심 경고 3줄                          (숙제 d의 기전)
```

**전부 R3와 같은 값이다. 새로 죽은 채널 0.**

---

## 7. 출하 판정 — 그리고 baseline 이후에 움직인 것

| 사용자 기준 | 수치 | 판정 |
|---|---|---|
| 기존 기능을 화면 단위로 빠뜨리지 않았는가 | 화면 도달 **통짜 73.6%(89/121) · 병합 99.2%(120/121)**(원인: 하네스 §6.1-1) · 계약면 **216 / impl 198 / missing 18**(`1078718`) | **거의. 다만 아니다** — 남은 5채널 중 4개가 「Codex 계정」 한 축 |
| 블라인드에서 UI가 지지 않는가 | **미판정 — 근거 없음**(R3 §2.6 · 이 라운드에서 관측을 14건 더 실어도 그대로) | ⚠ 이월 |
| 치명 0인가 | **2** — N1(Codex 계정 축 5채널) · N2(에러 안전망 부팅 루프) | ⛔ **출하 불가** |
| 그 둘을 빼면 | 높음 **1**(N3) · 중간 **0** · 낮음 **2**(N4·N5) · **이 라운드가 찾은 새 치명 0** | 나머지는 출하를 막지 않는다 |

**N1·N2는 SHIPBLOCK 갈래 소관이고 나는 그 둘을 안 고쳤다 — 해소 확인도 그 갈래 크리틱의
일이다.** 다만 내 baseline 이후에 그 수정이 **착지했으므로**(숙제 b: 자기 증거와 어긋나면
먼저 적어라) 정적 사실만 적는다:

```
baseline 1078718 : 계약면 216 / impl 198 / commentOnly 0 / missing 18   (내 exe가 그 트리다)
HEAD     d461f21 : 계약면 216 / impl 203 / commentOnly 0 / missing 13   (final-parity-r4-channels-head.json)
  좁혀진 5 = codex-auth:{login,login-cancel,logout,set-default-account,reorder-accounts}
            → src-tauri/src/ipc/accounts.rs:631-635 (efdc08c·521221d = SHIPBLOCK R1)
  남은 13 = talk 6 · lsp 3 · app:{update-check,update-install,update-event} 3 · **app:open-directory 1**
```

- **N1은 배선이 생겼다는 것까지만 내 확인이다.** 동작·왕복은 안 봤다(그 갈래 크리틱 소관).
- **N3는 HEAD에서도 그대로 `missing`이다.** 등급 「높음」 유지.
- 내가 잰 코드 경로는 baseline 이후 무변(§0.1)이라 이 라운드의 수치는 HEAD에도 유효하다.

---

## 8. 남은 리스크 · 다음 라운드 숙제

1. **(이월 · R3 §9-1) 계정·한도 축 A/B는 `USERPROFILE`까지 돌려야 한다.** 2.6.2가
   `CCG_HOME`을 무시한다(`auth.ts:76`). 이 라운드의 20주행은 전부 그 손잡이를 썼다.
2. **(이월) 로그인/로그아웃 왕복 미검증(T1).** ★이 라운드가 길을 하나 열었다 — 합성
   자격증명이 함정 5 안에서 가능하다는 것이 §2.3에서 실증됐다. 다음 라운드는 합성 계정 +
   로컬 OAuth 콜백 스텁으로 `auth:login` → 계정 추가 → `auth:logout` 왕복을 격리 홈에서
   닫을 수 있다(실계정 토큰 해지 0).
3. **(신규) 하네스에 「나가는 요청 계측」을 상설로 달아라.** 이 라운드의 프록시 싱크
   (`HTTPS_PROXY` → `127.0.0.1`)는 3.0의 **모든** 나가는 요청을 잡아 기록한다. 「실 HTTP
   0건」을 주장하는 모든 감사 주행이 이걸 켜고 돌면 그 주장이 **로그**가 된다.
   2.6.2 쪽은 undici라 프록시를 안 읽으므로 소켓 계측(`net.Socket.prototype.connect`)이
   대응물이다(`final-parity-r4-electron-nosocket.json`의 방식).
4. **(신규) 증거 수집기는 파일명이 아니라 「표면」으로 훑어라.** R3의 27건이 새는 자리가
   정확히 그것이었다(`apiprobe`만 훑어 `rawprobe`의 같은 채널을 놓쳤다 · §3.2 #7).
5. **(이월) 블라인드 칸을 다시 세워라** — 환경 의존 화면을 표본에서 빼고 잔존 상태를 맞춘 뒤.
6. **(이월) 환경 의존 화면 표식(`envDependent: true`)** 을 하네스 화면 정의에 넣어 성공률·
   `found` 비교에서 자동으로 빼라.
7. **미해소로 남는 것**: `--merge`가 통짜 원수치를 제자리에서 덮는다(`bench/ab.mjs:644-656`) —
   2.6.2 통짜 대 통짜 비교는 여전히 불가능하다.

**이 라운드가 안 한 것(정직하게)**: 실계정으로는 아무것도 안 쟀다. 그래서 「실계정이 있는
사용자의 팝오버가 어떻게 보이는가」는 여전히 R1·R2의 흔들리는 관측뿐이고, 그 화면의 분류는
**환경 의존**이다. 합성 계정으로 연 문은 *「디스크 캐시가 이 문에 닿는가」* 하나를 닫았을
뿐, *「실 조회가 성공했을 때 두 앱이 같은가」* 는 닫지 못했다.

---

## 부록 A — R3 보고서에서 **고쳐 읽어야 할 줄**

| R3 위치 | 원문 | 정정 |
|---|---|---|
| §0.2 증거 파일 표 | 「`final-parity-r3-observations.json` — 한도 축 **모든 관측 27건**」 | 「**세 계열** 27건」. 전량은 62건(§3.4) · 그 시점 표 밖 14건(§3.2) |
| §2.1 표 제목 | 「한도 축 관측 **전량** — 27건」 | 「한도 축 관측 — **press·apiprobe usage.get·A/B found 세 계열** 27건」 |
| §2.3 | 「캐시를 심고 각 3회 이상 다시 쟀다 → **두 앱이 완전히 같다**」 | 「그 12주행은 **판별력이 0**이다(계정 0 → 캐시·네트워크 앞에서 반환 · 2차 호출 0~1ms·`CONNECT` 0으로 계측). 판별력 있는 배치는 R4 §2.4」 |
| §2.4 | 「그 처방은 이 화면에 닿지 않는다 — **소스**」 | **유지 + 승격.** 이제 실행으로도 그렇다(R4 §2.4 — 문을 연 20주행에서 seeded/bare 동일 · 같은 파일이 `accounts-usage`에서는 42%) |
| §2.6 T3 「닫힘」 각주 | 근거 셋을 전부 `#7`로 각주 | ②의 출처는 `#7`이 아니라 **§3.2 #4**(`CCG_NO_NET=1` 주행) · 보조 #3(R4 §3.3) |
| §7.2 표 `codex-auth:set-default-account` 행 | 「앉는 자리 `setCxAccounts` · 계정 목록 증발」 | **3.0에 호출부 없음**(기본 지정은 `reorderAccounts`로 감). 채널 미구현은 그대로(R4 §4) |
| §3 근거 1 | `nsis/hooks.nsh:26` | **:28**(HKCU 쓰기는 :39-41·:44-46) — 실체는 사실(R4 §5) |
| §0.2 / rawprobe | 키 `shim:app.openDirectory 구독자` | 잰 것은 `onOpenDirectory`. 방출자는 런타임 **`undefined`**(R4 §5 · 새 파일) |
| §8 출하 표 | 「N1·N2는 SHIPBLOCK 갈래가 **지금 고치고 있다**」 | 그 뒤 **착지했다**(`efdc08c`·`521221d`) — HEAD 계약면 `missing 18 → 13`. **동작 확인은 여전히 그 갈래 크리틱 소관**(R4 §7) |
