# R28 「T3T4」 확인 크리틱 R1 — 게이지는 살아났는데, 「풀렸다고 착각하는 자리」는 그대로다

판정자: T3T4 확인 크리틱(새 컨텍스트) · 2026-08-24 · `feature/3.0.0-beta`
대상 커밋: `4197a84`(T3) · `e581b2a`(T4+높음/중간) · `2d971c9`(실증) — 트리 팁 `39c2701`에서 검증
판정: **불합격(pass = false).** 체크리스트 6항 중 **2항 실패 · 1항 부분**, 그리고 **새 회귀 1건**.

빌드는 크리틱이 직접 했다:
`CARGO_TARGET_DIR=target-t3t4 cargo build --release --features custom-protocol` → 1분 31초,
`target-t3t4/release/agentcodegui.exe` **6,344,192바이트 · 17:51**(`app/dist`는 17:48 —
`app/src`의 어느 파일보다 새것이라 내장 자산도 현행). 아래 모든 실측은 **이 exe**로 잰 것이다.

---

## 0. 한 문단 결론

**T3의 절반은 진짜로 살아났다.** 격리 홈 + 실 HTTP로 워크바 한도 팝오버를 실제로 눌러 보니
「데이터 없음」이 사라지고 `5시간 한도 100% 남음 / Fable 주간 67% 남음 / 주간 0% 남음 ·
2일 4시간 후 초기화`가 그려진다 — 감사의 블라인드 유일 1패는 화면에서 소멸했다.

**그런데 체크리스트 2번은 실패다.** 「조회 실패 = 풀림」 오판은 **한 글자도 사라지지 않았다.**
조회 실패를 인위로 유발하니 `usage:get`이 감사가 지적한 바로 그 모양
(`{fiveHour:null, weekly:null, weeklyFable:null, extraCredit:null}`)을 그대로 돌려주고,
훅이 부르는 **진짜 판정 함수** `blockedResetsAt`이 `null`을 내며, 그 착지점은
`ready = true`(=풀렸다 → 자동 전송)다. 빌더의 「오판 소멸」은 **조회가 성공할 때만** 참이다.

**그리고 이번 라운드가 새 회귀를 하나 넣었다.** M1(Ctrl+W)의 `emit_to(window.label(), …)`는
**그 창에만 가지 않는다** — 창 둘에 계수기를 달아 재니 한쪽에서 1회 호출에 **양쪽이 1회씩**
받았다. 코드 주석이 *"브로드캐스트하면 다른 창에 열려 있던 뷰어가 남의 키 입력으로 닫힌다"*
고 적어 둔 바로 그 사고가, 그 주석이 달린 줄에서 일어난다.

부수로: 빌더 헤드라인 **「37 통과 / 0 실패」는 재현되지 않는다**(같은 하네스·같은 exe로 **36/1**).
다만 그 실패 검사는 하네스 자체가 레이스라 **기능은 무사하다**(§3.3).

---

## 1. 체크리스트 항목별 판정

| # | 항목 | 판정 | 근거(실측) |
|---|---|---|---|
| 1 | 릴리즈 빌드 후 격리 홈에서 워크바 게이지에 **실값** | **통과** | 팝오버 DOM 5행 전부 실값, 「데이터 없음」 0회(§2.1) |
| 1' | TTL 2분/5분/15초 · 1200ms 직렬 · 429 백오프가 코드+테스트로 | **부분** | 상수 4개 2.6.2와 일치, 게이트는 `net::send` 전 호출 경유. 다만 **1200ms 게이트·2분 디스크 TTL에 테스트가 없고**, 429 `Retry-After`를 **헤더가 아니라 본문**에서 읽는다(§5.1) |
| 2 | `useLimitResume.ts:144` 오판(조회 실패=풀림) 소멸 | **실패** | 조회 실패 유발 → `blockedResetsAt = null` → `ready=true`. 훅 무수정 + Rust 실패값이 `empty`라 경로가 그대로다(§3.1) |
| 3 | `poc-btw-fork` 초록 + btw 규약 4종 | **통과** | 33/0. 규약 4종 코드·실행 확인(§2.2) |
| 4 | `poc-mcpskill` 초록 + 실디스크 2.6.2와 동수 | **통과** | 와이어 하네스 전부 통과. 같은 스크래치에서 **2.6.2 동결 모듈 1건/1건 = 3.0 1건/1건**(§2.3) |
| 5 | 첨부 3표면 · `codex:models` · flush 통일(+CloseRequested) · 중간 4건 | **부분** | 앞 셋 통과(3표면 네이티브 대화상자 · 모델 7종 236ms · flush 마커 5/5). 중간 4건 중 **M5 `git:ai-message` 미구현 · M2 후반 `app:open-directory` 미구현**, M1은 통과했으나 **창 경계가 깨진다**(§3.2) |
| 6 | cargo test 크레이트별 + typecheck 3종 + poc-limit-resume 재실행 | **통과** | 전부 초록(§2.4) |

---

## 2. 통과로 확인한 것 — 실측치

### 2.1 워크바 한도 게이지(블라인드 유일 1패의 자리)

격리 홈(`%TEMP%\ccg-critic-t3t4\home4`)에 **토큰이 20분 넘게 살아 있는 계정 1개만** 복사해
띄우고(실 HTTP는 usage 조회 1건, 리프레시 교환 0), `.workbar .wb-chip[4]`를 눌러 팝오버 DOM을 읽었다.

```
현재 컨텍스트   | 이 대화가 차지하는 컨텍스트 창 | 0%
5시간 한도      | 초기화 시간 미상              | 100% 남음
Fable 주간 한도 | 2일 4시간 후 초기화           | 67% 남음
주간 한도       | 2일 4시간 후 초기화           | 0% 남음
토큰 사용량     | 입력 0 · 출력 0 · 캐시 0      | 0
「데이터 없음」 문구 존재: false
```

빌더의 하네스도 재현했다: `usage:get(fresh)` = `weekly {pct:100, resetsAt:1787752800}`,
`auth:accounts-usage` 6/6 실값, 「남은 %」가 0·17·52·55·85로 갈린다(=「한도 적게 남은순」이
근거를 갖는다), 캐시 재조회 200ms → 3ms.

### 2.2 btw 규약 4종

- **forkSession 포크** — `T4-5` 시드가 hydrate로 내려오고, `T4-6b`에서 첫 실행이 실제로
  `--resume ses-fork-1`로 나가 CLI 거절문이 **시드를 인용**한다(포크 인자가 실행에 실렸다는 뜻).
- **own 생기면 재포크 금지** — 렌더러 `btwRunResume`. `poc-btw-fork` D절 통과(33/0).
  `app/src/lib/btw.ts`는 동결본 `src/renderer/src/lib/btw.ts`와 **바이트까지 동일**(diff 0)이라
  PoC가 동결본을 번들해도 판정이 성립한다.
- **읽으면 소비** — 두 번째 hydrate에 `btwPrompt` 없음(`T4-8`), 시드는 남음(`T4-8b`).
- **wrapBtwFork 1회** — `btw.rs`는 프롬프트를 감싸지 않는다(셸이 두 벌로 만들지 않는다).
  감싸는 자리는 `SessionWindow.tsx:595`의 `rs.forkSession` 갈래 하나뿐.
- **전 창 브로드캐스트** — 팝아웃 창(`#mapanel`)에 계수기를 달고 `btw:open`을 부르니
  **메인 2회 · 팝아웃 2회** 수신. 성립한다. 다만 성립 **이유**가 코드 의도와 반대다 —
  `broadcast_sessions`는 `emit_to(MAIN, …)`인데 shim의 구독이 전역 `listen()`이라 창 경계가
  없어서 닿는 것이다. 같은 성질이 §3.2에서는 사고가 된다.

### 2.3 MCP·스킬 동수

같은 스크래치 폴더(`.mcp.json` 서버 1 + `.claude/skills/bench-skill`)를 두 구현에 물렸다.
2.6.2 쪽은 **동결 모듈 `src/main/mcp.ts`·`skills.ts`를 그대로 번들해** 돌렸다(`APP_HOME`만 스텁).

| | MCP(project) | Skill(local) |
|---|---|---|
| 2.6.2 동결 모듈 | **1** (`bench-mcp` · `node stub.js` · stdio) | **1** (`bench-skill` · 「파리티 실측용 스킬」) |
| 3.0 `mcp:list`·`skill:list` | **1** (같은 필드) | **1** (같은 필드) |

토글은 앱 홈(`mcp.json`·`skills.json`)에만 남고, 그 끔 목록은 `ccg-store/raw_identity.rs:80,83`이
읽어 실행 정체성으로 접는다 = **끄면 실제 실행에서도 빠진다**(2.6.2 `deniedMcpServers`/
`skillOverrides`와 착지가 같다). `poc-mcpskill.mjs`(와이어)도 전부 통과.

### 2.4 회귀 그물

| 대상 | 결과 |
|---|---|
| `cargo test -p agentcodegui` | **98 통과 / 0** (그중 `ipc::parity` **19**) |
| `cargo test -p ccg-auth` | **97 통과 / 0** (79 유닛 + 통합 18) — 빌더 보고의 86은 옆 갈래가 늘리기 전 수 |
| `cargo test -p ccg-store` | **76 통과 / 0** |
| `cargo test -p ccg-engine` | **129 통과 / 0** (2 ignored) |
| `npm run typecheck`(node·web) + `typecheck:app` | **3종 초록** |
| `scripts/poc-btw-fork.mjs` | **33 / 0** |
| `scripts/poc-limit-resume.mjs` | **39 / 0** (훅·순수 모듈 무수정 확인) |
| `scripts/poc-mcpskill.mjs` | 전부 통과 |
| `scripts/poc-tauri-chats.mjs` | 무이상(3단계의 `newChatWritten:false`는 렌더러가 주입 채팅을 프룬한 하네스 인공물 — 별도 재현으로 확인) |

동결 구역(`src/main`·`src/preload`·`src/renderer`·`out/`·`dist/`)은 세 커밋 어디에서도
**한 파일도 건드리지 않았다**. `app/` 렌더러도 0줄이다(커밋 파일 목록 20개 전수 확인).

---

## 3. 실패 셋

### 3.1 ★체크리스트 2 실패 — 「조회 실패 = 풀림」 오판은 살아 있다

**재현.** 격리 홈에 살아 있는 계정 하나를 복사하고 `CCG_NO_NET=1`로 띄웠다. 이 조합이 곧
「계정은 있는데 조회가 실패한다」이다 — `net::access_token`은 로컬 토큰이 살아 있으면
네트워크 없이 그대로 돌려주고(`net.rs:289`), 그 다음 `net::send`가 `Disabled`로 죽는다.

```
getUsage(true)              = {"fiveHour":null,"weekly":null,"weeklyFable":null,"extraCredit":null}
getUsage(true, <실계정>)     = {"fiveHour":null,"weekly":null,"weeklyFable":null,"extraCredit":null}
auth:accounts-usage()       = [{... 여섯 필드 전부 null ...}]
```

그 값을 **훅이 실제로 부르는 함수**에 그대로 먹였다(`app/src/lib/limitResume.ts`를 esbuild로
번들해 구동):

```
조회 실패(계정 있음): blockedResetsAt = null → 훅 fire()의 착지 = ★풀림(ready=true → 자동 전송)
조회 실패(기본 계정): blockedResetsAt = null → 훅 fire()의 착지 = ★풀림(ready=true → 자동 전송)
대조군 실값(주간 100%): blockedResetsAt = 1787752800 → 유지
```

**왜 안 고쳐졌나.** 빌더의 처방은 *"Rust가 실값을 흘리면 판정이 되살아난다"* 였다. 그 말은
조회가 **성공할 때만** 참이다. 실패 경로는 `usage.rs:138`·`:156`이 2.6.2와 똑같이 `empty`를
돌려주고, `limitResume.ts:62-71`의 `!w continue`가 그 넷을 전부 건너뛰어 「막는 창 없음」에
착지한다. 감사가 지목한 `useLimitResume.ts:155` `catch`는 **아예 타지도 않는다** — shim이
throw하지 않으므로 더 조용한 경로로 같은 오답에 도착한다.

**어디서 터지나(=2.6.2 대비 더 나쁜 자리가 있다).** 엔진 쪽 대기표에는 상한이 있다
(`runtime.rs:3193` `MAX_AUTO_ATTEMPTS` — *"재검증 훅이 없거나 조회에 실패한 판"*을 위해 만든
바로 그 문). 그런데 `managed`(=엔진이 표를 들고 있다)를 넘기는 화면은 **`App.tsx:604` 본채팅
하나뿐**이다. `MultiAgent`·`SessionWindow`·`PanelWindow` 셋은 `managed`가 없어 **렌더러 훅이
단독 소유자**이고, 그 훅에는 상한이 없다. 즉 멀티 패널·추가 채팅 창·팝아웃에서는
「조회 실패 → 풀렸다고 판단 → 전송 → 또 막힘 → 재장전」이 무한이다.

**현실성.** 콜드 스타트(메모리 캐시 비어 있음) + 리셋 시각 도래 + 그 순간 조회 실패
(네트워크 단절 · 리프레시 실패 → `NoToken` · 429에 캐시 없음)면 그대로 재현된다.
대기표는 ui-prefs에 영속되므로 앱을 껐다 켠 뒤가 정확히 그 판이다.

### 3.2 ★새 회귀 — `shortcut:close`(M1)가 창 경계를 안 지킨다

`misc.rs:54-59`의 주석은 이렇게 적혀 있다.

> **부른 창에만** 되쏜다. 브로드캐스트하면 다른 창에 열려 있던 뷰어가 남의 키 입력으로
> 닫힌다 — 2.6.2도 누른 창(메인)에만 보냈다.

**실측(창 둘에 같은 계약면 구독으로 계수기).**

```
메인 창에서 shortcut:close 1회 호출  → 수신: 메인 1 · 추가 채팅 창 1
추가 채팅 창에서 1회 더 호출         → 누적: 메인 2 · 추가 채팅 창 2
```

`emit_to(label, …)`는 Tauri v2에서 **대상 라벨로 필터링되지만**, shim의 구독은
`@tauri-apps/api/event`의 전역 `listen()`(`shim.ts:140`)이라 **어느 대상으로 쏜 이벤트든 받는다.**
그래서 「그 창에만」이 성립하지 않는다.

**사용자에게 보이는 손해.** `FileModal.tsx:2998`이 `onCloseShortcut`으로 뷰어를 닫는다.
파일 뷰어를 띄워 둔 채 다른 창에서 Ctrl+W를 누르면 **그 뷰어가 같이 닫힌다**(편집 중이면
확인 카드가 뜬다). `Chat.tsx:419`의 명령 결과 카드도 같다. 2.6.2는 `before-input-event`로
**누른 창의 웹콘텐츠에만** 보냈으므로 이건 3.0이 새로 만든 어긋남이고, 이번 라운드가
그 채널의 **첫 방출자**를 세우면서 들어왔다(그전에는 방출자가 0이라 아무 일도 없었다).

같은 성질이 `windows.rs:51` `flush_req`의 *"그 창에만 보낸다"* 도 무효로 만든다. 그쪽은
손해가 작다 — 다른 창들도 flush 요청을 받지만 각자 **자기** 레코드에 저장하므로(주소는
`session_target`의 창 기준) 남의 자리를 덮지는 않는다. 잉여 저장 몇 건이다.
`ui:api-settings-requested`도 전 창에 가지만 구독자가 메인뿐이라 무해하다.

### 3.3 빌더 헤드라인 「37 통과 / 0 실패」 재현 불가 — 다만 기능은 무사

같은 하네스(`scripts/poc-parity-t3t4.mjs`)를 크리틱이 새로 빌드한 exe로 돌렸다.

```
FAIL — 36 통과, 1 실패
  ✗ H5-2 닫기 직전 저장이 **실제로 도착**한다(옛 채널로) — 요청이 안 왔다
```

`--no-live --only=h5`로 3회 더 돌려 **1 통과 / 3 실패**(전체 4회 중 1회만 통과)를 봤다.
**원인은 하네스다.** H5-2는 페이지에 `onFlushRequest` 귀를 **하나 더** 달고 그 귀가
`session.persist({title:'FLUSH-OK'})`를 부르게 한다. 그런데 원래 컴포넌트의 귀도 같은 순간
`session.persist({title: winTitle})`(빈 문자열)를 부른다 — **두 저장이 경합하고 늦게 닿는 쪽이
이긴다.** 실패한 주행의 레코드는 `title:""`였다.

**기능 자체는 결정적으로 산다.** 경합하지 않는 증거로 바꿔 다시 쟀다 — flush 귀가
`persist`가 아니라 **파일 하나를 쓰게** 하고(`writeFile`), 창이 죽은 뒤 그 파일의 존재를 본다.

```
#0 있음 · #1 있음 · #2 있음 · #3 있음 · #4 있음  → 도착 5/5
```

`win:close` → `CloseRequested`(`win.rs:485`) → `begin_close_flush` → 두 이름 동시 방출 →
저장 도착 → `finish_close_flush`가 유예를 앞당겨 파기, 이 사슬은 5/5로 돈다.
**고칠 것은 제품이 아니라 하네스의 H5-2 검사다**(경합하는 증거를 쓰고 있다).

---

## 4. 중간 4건 — 개별 실동작

| # | 채널 | 판정 | 실측 |
|---|---|---|---|
| M1 | `shortcut:close` | 동작하나 **경계 깨짐** | 주입 스크립트 → 왕복 1회 확인. 다만 §3.2 |
| M2 | `app:get-initial-dir` | **통과** | argv 폴더가 그대로 내려온다 |
| M2' | `app:open-directory` | **미구현** | `{"__unimplemented":true}` — 빌더가 설치기 라운드로 미룸(단일 인스턴스 잠금 때문, 근거 타당) |
| M3 | `ui:open-api-settings` | **통과** | 메인 창까지 왕복 1회 |
| M5 | `git:ai-message` | **미구현** | `{"__unimplemented":true}` — Git AI 커밋 메시지 버튼은 여전히 죽어 있다 |
| (참고) M4 | `engine:install-progress` | 미구현 | T2 몫 |
| (참고) H3 | `app:update-check` | 미구현 | 범위 밖(의도) |

---

## 5. 2.6.2 동결본과의 남은 어긋남(전부 `ccg-auth` — 이번 라운드가 만든 것은 아니다)

### 5.1 429 백오프

| | 2.6.2 `auth.ts:557-559` | 3.0 `net.rs:462-486` |
|---|---|---|
| 대기 시간 출처 | 응답 **헤더** `retry-after` | 응답 **본문** `retry_after` |
| 기본값 / 상한 | 15초 / 30초 | 15초 / 30초 (동일) |
| 401·403 강제 리프레시 후 1회 재시도 | 있다 | **없다** |

`HttpResponse`가 `status`·`body`만 들고 헤더를 버리므로(`net.rs:117`) 헤더 값을 존중할
**구조가 없다** — 실제 429에서는 사실상 항상 기본 15초다. 손해는 제한적이지만
「2.6.2와 같다」는 서술은 정확하지 않다.

### 5.2 테스트가 없는 두 규약

- **1200ms 전역 직렬화**: `net::send`가 무조건 `throttle()`을 지나므로 코드로는 지켜지지만,
  간격을 재는 테스트가 워크스페이스에 없다.
- **`auth:accounts-usage`의 2분 디스크 TTL**: `usage.rs:192`가 상수를 쓰지만 그 갈래를 밟는
  테스트가 `ipc::parity`에 없다(있는 4건은 메모리 캐시·stale·빈 계정 경로다).

---

## 6. 종합 판정

| 사용자 기준 | 판정 |
|---|---|
| T3(한도)가 화면까지 살아났는가 | **그렇다.** 워크바 팝오버 5행 실값, 「데이터 없음」 소멸. 계정별 6/6 실값 |
| T4(btw 포크 창)가 규약대로 서는가 | **그렇다.** 창·시드·소비·알약(`shown:false`)·전 창 수신 전부 실측 |
| 감사가 지목한 **오판**이 사라졌는가 | **아니다.** 조회 실패 한 번이면 그대로 「풀렸다」이고, 상한이 있는 엔진 경로는 본채팅에만 붙어 있다 |
| 이번 라운드가 새 사고를 만들지 않았는가 | **아니다.** Ctrl+W가 창 경계를 넘는다 |
| 보고된 수치가 재현되는가 | **헤드라인은 아니다.** 37/0 → 36/1(검사가 레이스). 기능은 5/5로 무사 |

### 다음 라운드에 넘기는 지시(중요도순)

1. **`fire()`가 「조회 불가」와 「막는 창 없음」을 가르게 하라.** 셋 중 하나면 된다 —
   (a) `usage:get`이 실패를 **구분 가능한 모양**으로 돌려주고(예: `{ unavailable: true }`)
   훅이 그때는 **유지**로 착지, (b) 훅에 엔진과 같은 시도 상한(`MAX_AUTO_ATTEMPTS`)을 넣기,
   (c) `managed`를 멀티·추가 채팅·팝아웃 세 표면에도 배선해 엔진 한 주체로 접기.
   (a)·(b)는 `app/` 이식본 한 줄 변경이므로 `docs/renderer-divergence.md`에 등재할 것.
   무엇을 택하든 **조회 실패를 인위로 유발해 「유지」가 나오는 실측**이 통과 조건이다.
2. **`shortcut:close`를 진짜로 그 창에만.** 전역 `listen()` 구독이 창 필터를 무력화하므로
   이벤트 페이로드에 **대상 라벨을 실어** 렌더러가 `getCurrentWebview().label`과 대조하게
   하거나, shim의 그 채널만 `getCurrentWebview().listen()`으로 바꿔라. 실측 조건:
   창 둘에 계수기를 달고 한쪽에서 눌렀을 때 **1 · 0**이 나올 것.
3. **`poc-parity-t3t4.mjs`의 H5-2를 경합 없는 증거로.** 지금은 컴포넌트의 persist와
   경쟁해 4회 중 3회 거짓 실패다. 파일 마커(또는 그 창이 유일하게 만질 수 있는 산물)로 바꿔라.
4. M5 `git:ai-message` — T1T2의 `engine:*` 설계가 정해지는 대로 일회성 실행 경로에 얹을 것.
   (빌더의 유보 사유는 타당하나, 「눌러도 안 되는 버튼」은 아직 화면에 남아 있다.)
5. 429의 `Retry-After` **헤더**를 살리려면 `HttpResponse`가 헤더를 들어야 한다.
   그리고 1200ms 게이트·2분 디스크 TTL에 테스트 한 줄씩.

### 부수 관측(범위 밖)

- 빌더가 넘긴 「`dialog:pick-directory`는 `#32770`을 만들지 않는다 → `close_orphan_dialogs`가
  폴더 picker의 고아 창을 못 거둘 수 있다」는 코드상 성립한다(`system.rs:79`가 `#32770`만 훑는다).
  이번 라운드가 만든 문제는 아니지만 R4 크리틱 A5의 원본이 폴더 picker였으므로 별도로 세워 둘 것.
- 감사 서술 정정(빌더 주장) 확인: Codex picker는 비지 않았다 — `Chat.tsx:200`이
  `codexFallback()` 3종으로 받는다. 이번 구현의 실제 이득은 **새 모델이 보이기 시작한 것**이다
  (`codex:models` **7종 · 236ms**, `gpt-5.6-sol` `isDefault:true`, `efforts` 6단 포함).

---

### 재현 명령

```
cd src-tauri && CARGO_TARGET_DIR=…/target-t3t4 cargo build --release --features custom-protocol
node scripts/poc-parity-t3t4.mjs                    # 36/1 (H5-2는 레이스)
node scripts/poc-parity-t3t4.mjs --no-live --only=h5 # 3회 중 2~3회 H5-2 실패
node scripts/poc-btw-fork.mjs                        # 33/0
node scripts/poc-limit-resume.mjs                    # 39/0
node scripts/poc-mcpskill.mjs                        # 와이어 전부 통과
CARGO_TARGET_DIR=…/target-t3t4 cargo test -p {agentcodegui,ccg-auth,ccg-store,ccg-engine}
```

크리틱 전용 실측기 넷은 레포 밖(`%TEMP%\ccg-critic-t3t4\`)에 두었다 — 레포의 코드·하네스는
한 줄도 고치지 않았고, `docs/critic/parity-t3t4-r1.json`은 주행 전 바이트를 그대로 되돌려 놨다.
