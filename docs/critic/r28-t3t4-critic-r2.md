# R28 「T3T4」 확인 크리틱 R2 — 오판은 훅에서 사라졌다. 다만 **본채팅은 그 훅을 안 쓴다**

판정자: T3T4 확인 크리틱(새 컨텍스트) · 2026-08-24 · `feature/3.0.0-beta`
대상 커밋: `5863055`(실패 1·2·3 + [부분] 3건) · `6d2d291`(보고서) · `8311e3a`(하네스 위생)
판정: **불합격(pass = false).** 체크리스트 6항 중 **4항 통과 · 2항 부분**, 새 회귀 0건.

빌드는 크리틱이 직접 했다. `CARGO_TARGET_DIR=target-t3t4 cargo build --release --features
custom-protocol` → **`Finished in 1.85s`(재컴파일 0)** 이고 exe의 md5가
`89a411c254eafcb9dddf17ba918504b0`로 **그대로**다 = `target-t3t4/release/agentcodegui.exe`
(**6,356,992바이트 · 18:59**)는 HEAD 소스에서 나온 물건이 맞다. 내장 자산도 현행이다:
`app/dist` 18:56 > `app/src` 최신 파일 18:37이고, 번들에서 이번 라운드의 흔적 세 개
(`AnyLabel` · `unavailable` · `probes`)를 직접 확인했다. **아래 모든 실측은 이 exe다.**

---

## 0. 한 문단 결론

**R1이 지목한 두 실패는 실제로 고쳐졌다.** 「조회 실패 = 풀림」은 판정을 셋으로 갈라
없앴고(크리틱이 실 exe로 독립 재현: `CCG_NO_NET=1` + 합성 계정 → `usage:get` =
`{창 넷 null, unavailable:true}` → 새 판정은 `hold`), Ctrl+W의 창 누수는 **크리틱 자체
계수기로 1 · 0**이 나온다. 덤으로 빌더가 "안 쟀다"고 남긴 **토스트 창**을 크리틱이 직접
띄워 확인했다 — 라벨 스코핑이 `emit_to(TOAST)`를 죽이지 않는다.

**그런데 그 훅이 실앱의 본채팅에서는 한 번도 돌지 않는다.** `engine/lite.rs:112`가
`resumeOwner: "engine"`을 **무조건** 실어 보내므로 `App.tsx:604`의 `managed`는 늘 참이고,
훅은 장전·타이머·소진을 전부 멈춘다. 크리틱이 대기표를 ui-prefs에 심고 실앱을 띄워 보니
**3초 안에 렌더러 사본이 접히고 pref가 지워졌으며**, 화면에 남은 배너는 ✕ 없는 **엔진의
것**이었다. 그리고 엔진의 재검증 훅은 아직 `NoProbe`(=`LimitVerdict::Unknown` = *"풀린
것으로 두고 진행"*)다. 즉 **가장 많이 쓰는 표면에서는 이번 수선이 닿지 않는다.**

그리고 M5 `git:ai-message`는 여전히 `{"__unimplemented":true}`다 — 이유의 근거는
실측으로 바뀌었지만(사실 확인함), 화면의 버튼은 아직 눌러도 아무 일이 없다.

---

## 1. 체크리스트 항목별 판정

| # | 항목 | 판정 | 근거(전부 크리틱 실측) |
|---|---|---|---|
| 1 | 격리 홈에서 워크바 게이지 **실값** | **통과** | 팝오버 DOM 5행 실값·「데이터 없음」 없음(§2.1) |
| 1' | TTL 2분/5분/15초 · 1200ms 직렬 · 429 백오프가 코드+테스트로 | **통과** | 상수 4개 2.6.2 동결본과 일치 · `Retry-After` **헤더** 우선(+`parseInt` 규약) · 401/403 1회 재시도 · 게이트 실측 **1.2003s** 테스트 신설(§2.2) |
| 2 | `useLimitResume.ts:144` 오판 소멸 | **부분** | 훅·순수 판정은 「유지」로 착지(독립 재현). 그러나 **실앱 본채팅에서는 훅이 안 돈다**(§3.1) |
| 3 | `poc-btw-fork` + btw 규약 4종 | **통과** | 33/0 · 규약 4종 코드·실측(§2.3) |
| 4 | `poc-mcpskill` + 실디스크 2.6.2와 동수 | **통과** | 3.0 = 1/1 · **2.6.2 동결 모듈 직접 구동 = 1/1**(§2.4) |
| 5 | 첨부 3표면 · `codex:models` · flush 통일(+CloseRequested) · 중간 4건 | **부분** | 앞 셋 통과 + M1 창 경계 **1·0** + 토스트 수신 확인. **M5 `git:ai-message` 미구현**(§3.2) |
| 6 | cargo 크레이트별 + typecheck 3종 + `poc-limit-resume` 재실행 | **통과** | 107 / 113 / 76 / 197 · 3종 초록 · 141/0(§2.5) |

---

## 2. 통과로 확인한 것 — 실측치

### 2.1 워크바 한도 게이지 (체크리스트 1)

크리틱 전용 격리 홈(`%TEMP%\ccg-crit-t3t4r2\home-gauge`)에 **토큰이 43분 남은 계정
하나만** 복사해 띄우고(실 HTTP는 usage GET 1건, 리프레시 교환 0) 워크바 칩을 눌렀다.

```
워크바 칩 : 할 일 0/0 · 서브에이전트 0/0 · 백그라운드 셸 0/0 · 변경된 파일 0 · 컨텍스트 0%
팝오버    : 컨텍스트 | 0 / 1M 토큰 | 현재 컨텍스트 0% |
            5시간 한도 | 초기화 시간 미상 | 100% 남음 |
            Fable 주간 한도 | 2일 3시간 후 초기화 | 67% 남음 |
            주간 한도 | 2일 3시간 후 초기화 | 0% 남음 |
            토큰 사용량 | 입력 0 · 출력 0 · 캐시 0
「데이터 없음」 존재 : false
```

빌더 하네스(`poc-parity-t3t4`, 실 HTTP)도 재현했다 — `usage:get` =
`weekly{pct:100, resetsAt:1787752800}` · `weeklyFable{pct:33}` · `fiveHour{pct:0}`,
계정 4/4 실값(남은 % = **0 · 49 · 0 · 60** — 정렬이 근거를 갖는다), 첫 조회 **313ms → 캐시 3ms**.

### 2.2 TTL·게이트·429 (체크리스트 1')

동결본(`src/main/auth.ts:504,511` · `src/main/index.ts:1011,1015`)과 한 줄씩 대조했다.

| 규약 | 2.6.2 | 3.0 (`ccg_auth::usage`) |
|---|---|---|
| 전역 직렬 간격 | `USAGE_GAP_MS = 1200` | `USAGE_GAP_MS = 1_200` |
| 계정별 디스크 TTL | `ACCT_USAGE_TTL = 2분` | `ACCT_USAGE_TTL_MS = 2분` |
| `usage:get` TTL | `USAGE_TTL = 5분` | `USAGE_TTL_MS = 5분` |
| `fresh` 바닥 TTL | `USAGE_TTL_FRESH = 15초` | `USAGE_TTL_FRESH_MS = 15초` |
| 429 대기 | `parseInt(headers['retry-after'])` → 기본 15초 → 상한 30초 | **헤더 우선** → 본문 `retry_after` → 15초, 상한 30초 |
| 401/403 | `freshAccountToken(email, true)` 후 1회 재시도 | `force_refresh` 후 1회(토큰이 그대로면 재시도 안 함) |

R1이 "테스트가 0건"이라고 적은 두 자리에 **동작 테스트**가 섰다. 이름으로 직접 돌렸다:

```
test net::tests::a_response_carries_its_headers ... ok
test net::tests::retry_after_prefers_the_header_then_the_body_and_is_capped ... ok
[gate] 연속 호출 간격 = 1.2003364s · 1.2003184s (규약 1.2s)
test net::tests::the_global_gate_actually_spaces_the_calls ... ok
```

상수 대조가 아니라 **실제 경과를 잰다** — 게이트를 걷어내면 빨개진다. 2분 디스크 TTL은
`ipc::parity::usage::the_two_minute_disk_ttl_is_the_gate_between_a_hit_and_a_stale_fallback`
가 `CCG_NO_NET`으로 적중/만료를 가른다(107개 안에서 초록).

> 남은 미세 어긋남 하나(이번 라운드가 만든 것 아님): 2.6.2의 `usageInflight`는 동시 호출을
> **한 프로미스로 합쳐** 요청을 1회로 만드는데, 3.0은 레인 뒤에서 캐시를 다시 본다 —
> 조회가 **실패**하면 캐시가 안 채워지므로 N명이 각자 1회씩 나간다(1.2초 간격으로 직렬화되긴 한다).

### 2.3 btw 규약 4종 (체크리스트 3)

`scripts/poc-btw-fork.mjs` **33 통과 / 0 실패**. 그 하네스가 구동하는 모듈은 동결본
(`src/renderer/src/lib/btw.ts`)인데, `app/src/lib/btw.ts`와 **바이트까지 동일**(diff 0)임을
다시 확인했으므로 판정이 3.0에도 성립한다.

- **재포크 금지** — `btwRunResume('own-9', SEED, …)` = `{resume:'own-9'}`(forkSession 없음).
- **읽으면 소비** — `poc-parity-t3t4` T4-8: 2차 hydrate에 `btwPrompt` 없음, 시드는 남음(T4-8b).
- **wrapBtwFork 1회** — 전 소스에서 호출 자리가 **하나**다(`SessionWindow.tsx:595`,
  `rs.forkSession` 갈래). 셸(`ipc/parity/btw.rs`)은 감싸지 않는다.
- **전 창 브로드캐스트** — 크리틱 자체 계수기로 창 둘에 `sessionWindows.onChanged`를 달고
  창을 하나 더 열었다: **메인 0→2 · 추가 채팅 창 0→2**. R1에서는 이 성질이 심의 버그에
  얹혀 있었는데, 이제 `win.rs broadcast_sessions`가 `app.emit`이라 **의도대로** 닿는다.

### 2.4 MCP·스킬 동수 (체크리스트 4)

같은 모양의 스크래치(`.mcp.json` 서버 1 + `.claude/skills/bench-skill`)를 **두 구현에
직접** 물렸다. 2.6.2 쪽은 동결 모듈 `src/main/mcp.ts`·`skills.ts`를 esbuild로 번들해
`APP_HOME`만 스텁으로 갈아 끼우고 돌렸다.

| | MCP | Skill |
|---|---|---|
| **2.6.2 동결 모듈** | **1** (`bench-mcp` · stdio · `node stub.js`) | **1** (`bench-skill` · 「파리티 실측용 스킬」) |
| **3.0 `mcp:list`·`skill:list`** | **1** (같은 필드) | **1** (같은 필드) |

`scripts/poc-mcpskill.mjs`(와이어 하네스) **전부 통과**. 끔 목록이 앱 홈에만 남는 것도 확인
(`{"disabled":["bench-mcp"]}` · `{"disabled":["bench-skill"]}`).

### 2.5 회귀 그물 (체크리스트 6)

| 대상 | 결과 |
|---|---|
| `cargo test --bin agentcodegui` | **107 / 0**(0 ignored) — `ipc/parity/*.rs`의 `#[test]` 22개 포함 |
| `cargo test -p ccg-auth --features net` | **88 유닛 + 25 통합 = 113 / 0** |
| `cargo test -p ccg-store` | **76 / 0** |
| `cargo test -p ccg-engine` | **197 / 0**(2 ignored) |
| `npm run typecheck`(node·web) + `typecheck:app` | **3종 초록** |
| `scripts/poc-limit-resume.mjs` | **141 / 0** |
| `scripts/poc-limit-blind.mjs` | **14 / 0**(주행 후 기준 파일 `git checkout` 복원) |
| `scripts/poc-btw-fork.mjs` | **33 / 0** |
| `scripts/poc-mcpskill.mjs` | 전부 통과 |
| `scripts/poc-parity-t3t4.mjs`(실 HTTP·격리 홈) | **41 / 0** |
| `poc-parity-t3t4 --no-live --only=h5` × 5 | **5 / 5**(R1은 4회 중 1회 — 하네스 경합 수선이 재현된다) |

동결 구역(`src/main`·`src/preload`·`src/renderer`·`out/`·`dist/`)은 세 커밋 통틀어
**0파일**이다. 공유 파일 `src/shared/protocol.ts`는 `UsageInfo`에 선택 키 둘을 얹은
**한 헝크**뿐이고, 그 때문에 2.6.2 타입 검사가 깨지지 않는다(둘 다 `?`).

### 2.6 ★빌더가 "안 쟀다"고 남긴 자리 — 토스트 창 (크리틱이 직접 쟀다)

심의 라벨 스코핑은 **전 채널**에 걸리므로, `emit_to(TOAST, …)`·`emit_to(MENU_WIN, …)`처럼
**다른 창을 겨냥한 emit**이 조용히 죽으면 알림이 통째로 사라진다. 실제로 띄워 봤다.

```
라벨: main = main · other = session-1
토스트 라벨 = toast
토스트 본문 = "AGENTCODEGUI | ✕ | 답변 도착크리틱 알림 | 토스트 팬아웃 확인"
토스트가 notify:show를 받았나 = true
```

`notify:event` → `emit_to(TOAST, NOTIFY_SHOW)` → 라벨 `toast`로 등록된 구독이 받는다.
같은 메커니즘·같은 라벨 규약인 트레이 두 창(`traymenu`·`traynotice`)은 직접 열 수단이
없어 못 쟀지만, 이 결과가 그 경로의 대표 증거다.

---

## 3. 부분 둘

### 3.1 ★체크리스트 2 — 훅에서는 사라졌는데, **본채팅은 그 훅을 안 쓴다**

#### (a) 훅 자체는 고쳐졌다 (독립 재현)

크리틱이 만든 판(합성 계정 + `CCG_NO_NET=1`, 실계정 자격 0줄·HTTP 0회)에서 실 exe가 낸 값:

```
usage:get           = {"fiveHour":null,"weekly":null,"weeklyFable":null,"extraCredit":null,"unavailable":true}
accounts-usage[0]   = {... 여섯 필드 null ..., "unavailable":true}      (행은 목록에 남는다)
```

이 값을 옛 판정에 먹이면 여전히 `null`(= R1 오판의 조건이 그대로 재현된다)이고, 새 판정에
먹이면 `hold{probes:1}` → `hold{probes:2}`다. `poc-limit-resume` G절이 **훅 소스를 실제로
구동**해 세 표면 모두 「유지·전송 0」에 착지하는 것도 141/0으로 재현된다(시각 미상이면
5회 연속 유지, 표식 없는 R1 값도 유지, 조회가 던져도 유지).

**남는 밸브 하나**(빌더가 밝힌 것): 상한 2회를 넘겼고 **문구의 리셋 시각이 이미 지났으면**
한 번은 눈감고 쏜다. 2.6.2는 그 판에서 15초마다 계속 쐈으므로 **후퇴는 아니다.** 다만
같은 이름을 쓴 엔진 상수와 **뜻이 반대**라는 점은 적어 둔다 — `ccg-engine`의
`MAX_AUTO_ATTEMPTS`는 *"넘기면 자동을 멈추고 사용자에게 넘긴다"*(`limit.rs:36-42`)인데,
렌더러의 착지는 *"넘기면 (한 번) 쏜다"*다.

#### (b) 그런데 실앱의 본채팅에서는 이 코드가 **한 줄도 안 돈다**

`engine/lite.rs:112`가 `"resumeOwner": "engine"`을 **조건 없이** 싣는다 →
`resumeOwner.ts:36`의 `engineOwnsResume`이 항상 참 → `App.tsx:604`의 `managed`가 참 →
훅은 장전·타이머·소진·재검증을 전부 건너뛴다(`useLimitResume.ts:81,151,181,191`).

실측(크리틱 E2E — 실 exe · 격리 홈 · 합성 계정 · `CCG_NO_NET=1`, 대기표를
`ui-prefs.limitResume.hold`에 심고 92초 관찰):

```
t=  1s  prefs.limitResume.hold = {probes:0, resetsAt:1787562919}   배너 있음
t=  4s  prefs.limitResume.hold = null                              배너 그대로
t= 92s  prefs.limitResume.hold = null                              배너 그대로 · 전송 0
```

배너를 뜯어 보니 **✕가 없다**(`.lh-x` 부재) = `LimitHoldBar`의 `managed` 갈래다.
디스크도 같은 말을 한다:

```
chats-v3/crit-chat-1.json  hold = {key,engine,account,resetsAt,fable,lastPrompt,at}
chats-v3/status.json       ... "hold":{"resetAt":1787563122,"ready":false},
                               "autoResume":true, "resumeOwner":"engine"
```

즉 렌더러가 복원한 대기표는 **엔진에게 넘어가고 렌더러 사본은 접힌다**(그 접힘이
`limitResume.hold` pref를 지운 것이다). 그리고 엔진 쪽 재검증의 원천은 아직
**`NoProbe`**다 — `runtime.rs:332-334`가 `LimitVerdict::Unknown`을 돌려주고,
`limit.rs:209-211`의 주석이 그 뜻을 못 박아 뒀다: *"2.6.2 `fire()`의 `catch`와 같이
**풀린 것으로 두고 진행**하되, 그 관대함의 대가는 `MAX_AUTO_ATTEMPTS`가 치른다."*
`with_limit_probe`를 부르는 자리는 워크스페이스 전체에서 **테스트 하나뿐**이다
(`crates/ccg-engine/tests/r14_limit_loop.rs:265`).

**정직하게 적는다**: 92초 관찰 동안 엔진이 실제로 쏘지는 **않았다**(대기표를 디스크에서
주워 온 판이라 재확인이 예약되지 않았을 수 있다). 그래서 "본채팅에서 눈감고 쏜다"를
실측으로 못 박지는 못했다. 하지만 확실한 것은 이것이다 — **이번 라운드가 세운 안전장치가
본채팅에는 걸려 있지 않고, 그 자리의 판정 원천은 아직 「못 물어봤다」를 「풀렸다」로 읽는다.**

#### (c) 그리고 남은 세 표면도 소유자가 **둘**일 수 있다

빌더가 (c)안(세 표면에 `managed` 배선)을 기각한 근거는 *"`chat:status.hold`는 채팅 단위라
멀티 슬롯·팝아웃엔 대응물이 없다"* 였는데, 코드는 그렇게 말하지 않는다:

```
engine/mod.rs:325  SESSION_RUN … => (chat_for_window(window), 0)
engine/mod.rs:326  MA_RUN      … => panel_id_to_chat(panelId)
engine/mod.rs:350  … => hub::call(&chat, hub::Op::Run(...))
```

추가 채팅 창도 멀티 패널도 **같은 `ChatRuntime`을 탄다** = 한도 에러를 본 엔진이 그쪽에도
대기표를 장전한다. 그런데 `SessionWindow.tsx:649`·`MultiAgent.tsx:1986`은 `managed`를
안 넘긴다 → 같은 채팅에 재개 주체가 둘이 된다(리셋 시각에 전송 두 번). `managed`가 애초에
막으려던 사고가 그 세 표면에는 열려 있고, 대응물이 없다는 근거는 사실과 다르다.
(이건 이번 라운드가 만든 것이 아니라 **기각 근거의 사실관계** 문제다.)

### 3.2 체크리스트 5 — 셋은 통과, 중간 4건 중 하나가 아직 죽어 있다

| 항목 | 판정 | 실측 |
|---|---|---|
| 첨부 picker 3표면 | **통과** | 본채팅·추가 채팅·멀티 패널 **3/3** 네이티브 대화상자 + 이식본 소스가 셋 다 `pickAttachments`를 부른다 |
| `codex:models` | **통과** | 7종 실값(`gpt-5.6-sol` `isDefault:true` · `efforts` 6단) |
| flush 채널 통일 + `CloseRequested` | **통과** | `win.rs:485` `CloseRequested`→`begin_close_flush`, 두 이름을 같은 자리에서(`windows.rs:53,58`) 방출. 파일 마커 도착 · 닫은 뒤에도 목록 유지. **h5 5회 5/5** |
| M1 `shortcut:close` | **통과(회귀 소멸)** | 크리틱 자체 계수기: 메인에서 1회 → **메인 1 · 추가 0** / 추가 창에서 1회 → **추가 1 · 메인 그대로**. 목록 브로드캐스트는 여전히 **2 · 2** |
| M2 `app:get-initial-dir` | **통과** | argv 폴더 `"C:\\Code\\AgentCodeGUI"` |
| M3 `ui:open-api-settings` | **통과** | 메인 창까지 왕복 1회 |
| **M5 `git:ai-message`** | **미구현** | `{"__unimplemented":true}` — 대조군 `git:status`는 정상 응답. **Git AI 커밋 메시지 버튼은 여전히 죽어 있다** |
| (참고) M2' `app:open-directory` · M4 `engine:install-progress` | 미구현 | 각각 단일 인스턴스 잠금 · T2 몫(범위 밖) |

빌더가 M5를 미룬 근거는 **사실이다**(크리틱이 설치본으로 확인):
`claude.exe 0.3.241 --help`에 `turns`는 **0회** 등장하고(= `--max-turns` 없음), 도구
플래그는 `--allowedTools` / `--disallowedTools`(허용·거부 목록)뿐이라 2.6.2가 쓰는
`allowedTools: []`(빈 목록)를 argv로 표현할 수단이 없다. **근거는 타당하지만, 체크리스트
5의 조건은 「중간 4건 각각 실동작 확인」이고 이 한 건은 동작하지 않는다.**

---

## 4. 하네스·규율 관측

- **규약 위반 0.** 동결 구역 0파일 · `git add -A` 흔적 없음 · 공유 파일은 자기 헝크 하나 ·
  실계정 토큰 회전 유발 0(크리틱도 실 HTTP는 usage GET만, 토큰 20분 이상 남은 계정만 실었다).
- ⚠ **`poc-limit-blind.mjs`에는 `--out=`이 없다.** 기본 출력이 커밋된 기준 파일
  `docs/critic/limit-blind-t3t4-r1.json`이라 **재주행이 곧 덮어쓰기**다(병렬 규율 6의
  재발 자리). 크리틱 주행 중 실제로 그 파일이 갈렸고 `git checkout`으로 되돌렸다.
  `poc-parity-t3t4`에 넣은 `--out=`을 이쪽에도 넣을 것.
- ⚠ `poc-parity-t3t4`의 스크래치 `.poc-scratch-t3t4/`는 **gitignore에 없다**(`.poc-home-*`만
  있다). 정상 종료면 지워지지만 중간에 죽으면 남의 `git status`를 더럽힌다 —
  커밋 `8311e3a`가 닫으려던 바로 그 구멍의 나머지 반쪽.
- 빌더 보고의 수치는 전부 재현됐다(41/0 · 141/0 · 14/0 · 33/0 · 5/5 · 107/113/76/197).
  다만 `poc-limit-resume` G절이 「본채팅의 **실제 props**」라며 쓰는 `managed:false`는
  실앱과 다르다(§3.1b) — 세 표면 중 하나는 실물과 어긋난 모형이다.

---

## 5. 종합 판정

| 사용자 기준 | 판정 |
|---|---|
| R1이 지목한 **실패 2건**이 실제로 닫혔는가 | **닫혔다.** 오판은 훅에서 사라졌고(독립 재현), Ctrl+W 창 누수는 1·0이다 |
| 그 수선이 **사용자가 쓰는 자리**까지 닿는가 | **본채팅은 아니다.** `resumeOwner:"engine"`이 무조건이라 훅이 꺼져 있고, 그 자리의 판정 원천은 아직 `NoProbe`(=풀린 것으로 간주) |
| 이번 라운드가 새 사고를 만들었는가 | **아니다.** 라벨 스코핑은 창 경계를 살리면서 브로드캐스트·`emit_to(다른 창)`(토스트 포함)을 죽이지 않는다 |
| 보고된 수치가 재현되는가 | **전부 재현된다.** H5 거짓 실패도 5/5로 사라졌다 |
| 「눌러도 안 되는 버튼」이 남았는가 | **하나 남았다** — Git AI 커밋 메시지(`git:ai-message`) |

### 다음 라운드에 넘기는 지시(중요도순)

1. **본채팅에 안전장치를 실제로 걸어라.** 둘 중 하나다 —
   (a) `LimitProbe`를 셸에 배선한다. 재료는 이미 다 있다: `ipc/parity/usage.rs`가
   `unavailable` 표식과 실값을 내고, `limit.rs`의 `LimitVerdict`는 `Blocked/Clear/Unknown`
   셋을 이미 갖고 있다 — 어댑터 하나면 `Unknown`이 진짜 `Unknown`인 판(조회 실패)과
   `Blocked`인 판이 갈린다. 또는 (b) `lite.rs:112`의 `resumeOwner`를 **무조건**에서
   **엔진이 실제로 대기표를 든 채팅**으로 좁혀 렌더러 훅이 살아나게 한다.
   실측 조건: 대기표를 심은 본채팅 + 조회 불가 판에서 **전송 0**이 나올 것.
2. **재개 주체를 세 표면에서도 하나로.** `SESSION_RUN`·`MA_RUN`이 `chat_for_window`/
   `panel_id_to_chat`으로 이미 채팅 주소를 만든다 = `managed`의 대응물이 있다.
   지금은 엔진과 렌더러가 같은 채팅에 각자 대기표를 들 수 있다.
3. **M5 `git:ai-message`** — 근거(드라이버를 타야 한다)는 확정됐으니 이제 그 드라이버에
   1턴·도구 없음 실행을 얹을 것. 화면의 버튼이 아직 죽어 있다.
4. `poc-limit-blind.mjs`에 `--out=`, `.gitignore`에 `.poc-scratch-*/`.
5. (표기) 렌더러의 `MAX_AUTO_ATTEMPTS`는 엔진과 **값만** 같고 뜻이 반대다. 이름을 가르거나
   주석에 "엔진: 넘기면 멈춘다 / 렌더러: 넘기면 한 번 쏜다"를 명시할 것.

---

### 재현 명령

```
cd src-tauri && CARGO_TARGET_DIR=…/target-t3t4 cargo build --release --features custom-protocol
node scripts/poc-parity-t3t4.mjs --out=<레포 밖 경로>            # 41/0
node scripts/poc-parity-t3t4.mjs --no-live --only=h5 --out=…     # ×5 → 5/5
node scripts/poc-limit-resume.mjs                                # 141/0
node scripts/poc-limit-blind.mjs && git checkout -- docs/critic/limit-blind-t3t4-r1.json
node scripts/poc-btw-fork.mjs                                    # 33/0
node scripts/poc-mcpskill.mjs
CARGO_TARGET_DIR=…/target-t3t4 cargo test --bin agentcodegui                    # 107/0
CARGO_TARGET_DIR=…/target-t3t4 cargo test -p ccg-auth --features net            # 88+25/0
CARGO_TARGET_DIR=…/target-t3t4 cargo test -p {ccg-store,ccg-engine}             # 76/0 · 197/0
npm run typecheck && npm run typecheck:app
```

크리틱 전용 실측기 다섯(게이지 DOM · 대기표 E2E · 배너 소유자 · 팬아웃/토스트 · 중간
채널 · 2.6.2 MCP 모듈)은 **레포 밖**(`%TEMP%\ccg-crit-t3t4r2\`)에 두었다 — 레포의 코드와
하네스는 한 줄도 고치지 않았고, 주행으로 갈린 기준 파일은 즉시 복원했다.
