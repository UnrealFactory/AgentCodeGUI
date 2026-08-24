# R28 「T3T4」 확인 크리틱 R3 — 본채팅에 눈은 달렸다. 그런데 그 눈이 **Codex 채팅을 클로드 한도로** 판정한다

판정자: T3T4 확인 크리틱(새 컨텍스트) · 2026-08-24 · `feature/3.0.0-beta`
대상 커밋: `38a8810`(엔진 재검증) · `04e4c57`(`git:ai-message`) · `f284d43`(보고서)
판정: **불합격(pass = false).** 체크리스트 **6항 전부 통과**, 그러나 **이 라운드가 만든 새 회귀 1건(치명)** 을 실측했다.

빌드는 크리틱이 직접 했다.
`CARGO_TARGET_DIR=target-t3t4 cargo build --release --features custom-protocol` → **`Finished in 0.32s`(재컴파일 0)**,
exe **6,387,712바이트 · md5 `a80c61370d259749b9c95c519ec5ace2`**(빌더가 적은 값과 같다) = HEAD 소스에서 나온 물건이 맞다.
내장 자산도 현행이다: `app/dist` 18:56 > `app/src`의 최신 파일(18:56 이후 파일 **0개**).
대조군은 `target-t3t4-base/release/agentcodegui.exe`(**6,356,992바이트** — R2가 잰 크기 그대로. md5는 빌드 경로가 달라 다르다).
**아래 모든 수치는 크리틱이 이 두 exe로 직접 낸 것이다.**

---

## 0. 한 문단 결론

**빌더가 닫겠다고 한 자리는 실제로 닫혔다.** 옛 exe는 대기표를 심은 본채팅에서 t=90초에 가짜 CLI의
stdin에 **313바이트**(`{"type":"user",…"이어서 진행해 주세요"}`)를 밀어 넣는다 — 크리틱이 같은 하네스로
직접 재현했다. 새 exe는 110초 내내 `spawns=0 · stdin 0B · queue 0`이고, 620초 주행에서는 t=556초에
`ready+autoPaused`(눌러서 이어가기)로 착지한 뒤 눌렀을 때만 나간다. `git:ai-message`도 살아났다
(크리틱이 설치본 CLI로 직접 대조: `--ccg-bogus-flag`는 `unknown option`, `--max-turns 1`은 통과 · SDK
본체의 `if(St.length>0)…--allowedTools`도 직접 확인).

**그런데 새로 단 그 눈은 「어느 엔진의 한도인가」를 안 본다.** 재검증 훅은 `hold.account`
(= `identity.billing()` = **클로드 구독 계정**)로만 묻는데, Codex 채팅의 대기표도 같은 필드를 들고 있다.
크리틱이 **Codex 채팅 + 실계정**으로 재현했다: 주간 창이 100% 소진된(2일 뒤 해제) 클로드 계정 때문에
Codex 채팅의 대기표가 **50시간 뒤로 재장전**됐고, 그 뒤 **사용자가 직접 보낸 메시지까지 큐에 주차**됐다
(`queued:1 · spawns:0`). 같은 판에서 **옛 exe는 t=90초에 정상 발사(spawns=1)** 한다.
즉 이 라운드는 「눈감고 쏘는 재개」를 없애면서 **엉뚱한 눈으로 보고 2일을 잠그는 자물쇠**를 새로 만들었다.

---

## 1. 체크리스트 항목별 판정 — 전부 크리틱 실측

| # | 항목 | 판정 | 근거 |
|---|---|---|---|
| 1 | 격리 홈에서 워크바 게이지 **실값** | **통과** | 팝오버 5행 실값 · 「데이터 없음」 **false**(§2.1) |
| 1' | TTL 2분/5분/15초 · 1200ms 직렬 · 429 백오프(코드+테스트, 2.6.2 대조) | **통과** | 상수 4개 동결본과 일치 · 게이트 **실측 1.2006s / 1.2002s** · `Retry-After` 헤더 우선(§2.2) |
| 2 | `useLimitResume.ts:144` 오판 소멸(조회 실패를 인위 유발) | **통과** | 렌더러 141/0·14/0 · **엔진 11/0(전송 0)** vs 대조군 **313바이트 발사**(§2.3) |
| 3 | `poc-btw-fork` + btw 규약 4종 | **통과** | 33/0 · 규약 4종 코드 + 라이브 T4 11/12(§2.4) |
| 4 | `poc-mcpskill` + 실디스크 2.6.2와 동수 | **통과** | 3.0 **1/1** · 2.6.2 **동결 모듈 직접 구동 1/1** · 레코드 필드까지 동일(§2.5) |
| 5 | 첨부 3표면 · `codex:models` · flush 통일(+`CloseRequested`) · 중간 4건 각각 | **통과** | 5/5 — **M5 `git:ai-message` 20/0**(R2의 부분2가 닫혔다)(§2.6) |
| 6 | cargo 크레이트별 + typecheck 3종 + `poc-limit-resume` 재실행 | **통과** | 121 / 201 / 76 / 113 · 3종 초록 · 141/0(§2.7) |
| ★ | (체크리스트 밖) **이 라운드가 만든 회귀** | **실패** | **Codex 채팅을 클로드 한도로 판정한다**(§3) |

체크리스트만 보면 6/6이다. 그런데 크리틱의 일은 *"빌더가 고른 자를 대는 것"* 이 아니라
**새로 생긴 사고를 찾는 것**이고, §3은 사용자가 2일 동안 대화를 못 쓰게 만든다.

---

## 2. 통과로 확인한 것 — 실측치

### 2.1 워크바 한도 게이지 (체크리스트 1)

크리틱 전용 격리 홈(`%TEMP%\ccg-crit-t3t4r3\home-gauge`)에 **토큰이 447분 남은 계정 하나만** 복사해
띄우고 워크바 칩을 눌렀다(실 HTTP = usage GET **1건**, 리프레시 교환 **0** → 토큰 회전 0).

```
칩      : 할 일 0/0 · 서브에이전트 0/0 · 백그라운드 셸 0/0 · 변경된 파일 0 · 컨텍스트 0%
팝오버  : 현재 컨텍스트 | 이 대화가 차지하는 컨텍스트 창 | 0%
          5시간 한도    | 초기화 시간 미상        | 100% 남음
          Fable 주간 한도 | 2일 2시간 후 초기화    | 67% 남음
          주간 한도      | 2일 2시간 후 초기화    | 0% 남음
          토큰 사용량   | 입력 0 · 출력 0 · 캐시 0
「데이터 없음」 존재 : false
usage:get = {fiveHour{pct:0}, weekly{pct:100, resetsAt:1787752799}, weeklyFable{pct:33}, extraCredit{…}}
```

라이브 파리티 주행도 같은 말을 한다 — `auth:accounts-usage` **5계정 5행 실값**, 남은 % = `0 · 42 · 82 · 52 · 3`
(정렬이 근거를 갖는다), 첫 조회 **550ms → 캐시 3ms**.

### 2.2 TTL·게이트·429 (체크리스트 1')

| 규약 | 2.6.2 동결본 | 3.0 |
|---|---|---|
| 전역 직렬 간격 | `USAGE_GAP_MS = 1200`(`auth.ts:504`) | `USAGE_GAP_MS = 1_200` |
| 계정별 디스크 TTL | `ACCT_USAGE_TTL = 2분`(`auth.ts:511`) | `ACCT_USAGE_TTL_MS = 2분` |
| `usage:get` TTL | `USAGE_TTL = 5분`(`index.ts:1009`) | `USAGE_TTL_MS = 5분` |
| `fresh` 바닥 TTL | `USAGE_TTL_FRESH = 15초`(`index.ts:1013`) | `USAGE_TTL_FRESH_MS = 15초` |
| 429 | `parseInt(headers['retry-after'])` → 15초 → 상한 30초 | 헤더 우선 → 본문 → 15초, 상한 30초 |

상수 대조가 아니라 **경과를 잰다**:

```
[gate] 연속 호출 간격 = 1.2006736s · 1.2002387s (규약 1.2s)
test net::tests::the_global_gate_actually_spaces_the_calls ... ok
test net::tests::retry_after_prefers_the_header_then_the_body_and_is_capped ... ok
test net::tests::a_response_carries_its_headers ... ok
test ipc::parity::usage::tests::the_two_minute_disk_ttl_is_the_gate_between_a_hit_and_a_stale_fallback ... ok
```

### 2.3 ★ 조회 실패 = 풀림 오판 (체크리스트 2) — **대조군까지 크리틱이 직접 돌렸다**

`scripts/poc-limit-engine.mjs`(빌더가 새로 판 하네스)를 읽고 **재는 것이 진짜인지 먼저 확인했다**:
전송의 물증은 추론이 아니라 파일이다(가짜 CLI가 받은 `stdin.log` 바이트).

| t | 옛 exe(`babd925` · 6,356,992B) | 새 exe(`a80c6137…` · 6,387,712B) |
|---|---|---|
| 5–85초 | `spawns=0 stdin=0B` | `spawns=0 stdin=0B` |
| **90초** | **`spawns=1 · stdin 313B`** | `spawns=0 · probes=1 · asks=1` |
| 105–110초 | 표 사라짐(=소진=전송) | `spawns=0 · stdin 0B · queue 0 · ready=false · probes=2` |

옛 exe가 그 90초에 밀어 넣은 바이트(크리틱이 파일에서 그대로 읽은 것):

```json
{"type":"control_request","request_id":"init-1","request":{"subtype":"initialize", …}}
{"type":"user","session_id":"","message":{"role":"user","content":[{"type":"text","text":"이어서 진행해 주세요"}]}}
```

- `poc-limit-engine`(110초) **11/0** · 대조군(`--exe=옛 exe`) **5통과/6실패**(E1·E1′·E3·E5·E6·E7)
  — 빌더 보고의 「4/7」과 한 칸 다르지만(E4는 표본 타이밍) **실패 id의 뜻은 같다**: 하네스에 판별력이 있다.
- `--long`(620초) **14/0** — t=556초에 `probes=6 · ready=true · autoPaused=true`, 그 순간에도 `spawns=0 · stdin=0B`.
  이어서 `chat:queue-mutate {op:'resume'}`을 누르면 `spawns=1 · stdin 313B`.
- 렌더러 쪽: `poc-limit-resume` **141/0** · `poc-limit-blind` **14/0**(`--out=`으로 기준 파일 보호).
- `limitProbe = {asks:2, fetches:2, blocked:0, clear:0, unavailable:2}` — 훅이 실제로 배선됐고(옛 exe는 이 키 자체가 없다) 판정이 「못 물어봤다」로 착지했다.

> **한 자리 미검**: 620초 착지에서 화면의 **「이어가기」 버튼**은 픽셀로 못 봤다(하네스는 IPC로 눌렀다).
> 소스·와이어 수준으로는 열려 있다 — `lite.rs:93`이 `autoResume = rt.auto_resume() && !auto_paused`로
> 접어 주고, `resumeOwner.ts:64` `canPressResume = ready && auto !== true`, `Chat.tsx:3304` `press`가
> 그 값을 그대로 쓴다. 다만 **이 접힘을 잠그는 테스트가 없다**(`lite.rs` 테스트는 `resetAt` 하나뿐).
> 이 줄이 지워지면 배너가 *"한도가 풀렸어요 — 곧 이어서 계속해요"* 라고 적고 버튼을 안 준다.

### 2.4 btw 규약 4종 (체크리스트 3)

`poc-btw-fork` **33/0**. 규약 넷을 코드와 실물로 다시 확인했다.

| 규약 | 근거 |
|---|---|
| 재포크 금지 | `app/src/lib/btw.ts:90` `if (own) return { resume: own }` — `forkSession` 없음 |
| 읽으면 소비 | 라이브 T4-8(2차 hydrate에 `btwPrompt` 없음) + Rust 테스트 `the_seed_survives_into_hydrate_and_the_prompt_is_consumed_once` |
| 전 창 브로드캐스트 | `win.rs:609` `app.emit(SESSION_WINS_CHANGED)` + `:613` `chat:windows` — 라이브 M1-4 **메인 2 · 추가 창 2** |
| `wrapBtwFork` 1회 | 전 소스 호출 자리 **하나**(`SessionWindow.tsx:595`, `rs.forkSession` 갈래) |

라이브 T4는 12항 중 11 통과. 남은 하나(`T4-6b`)는 §4.2 — **회귀가 아니다**(대조군 동일).

### 2.5 MCP·스킬 동수 (체크리스트 4)

같은 모양의 스크래치(`.mcp.json` 서버 1 + `.claude/skills/bench-skill`)를 **두 구현에 직접** 물렸다.
2.6.2 쪽은 동결 모듈(`src/main/mcp.ts`·`skills.ts`)을 esbuild로 묶어 `APP_HOME`만 스텁으로 갈아 끼웠다.

| | 2.6.2 동결 모듈(크리틱 구동) | 3.0 `mcp:list`·`skill:list` |
|---|---|---|
| MCP | **1** `{name:"bench-mcp", scope:"local", origin:"project", transport:"stdio", detail:"node stub.js", enabled:true}` | **1** — 같은 여섯 필드, 같은 값 |
| Skill | **1** `{name:"bench-skill", description:"파리티 실측용 스킬", scope:"local", enabled:true}` | **1** — 같은 값 |

`poc-mcpskill.mjs` **전부 통과**. 끔 목록은 앱 홈에만 남는다(`{"disabled":["bench-mcp"]}`·`{"disabled":["bench-skill"]}`).

### 2.6 체크리스트 5 — 다섯 자리 전부 실동작

| 항목 | 판정 | 실측 |
|---|---|---|
| 첨부 picker 3표면 | **통과** | 본채팅·추가 채팅·멀티 **3/3** 네이티브 대화상자 + 이식본 3파일이 모두 `pickAttachments` 호출 |
| `codex:models` | **통과** | 배열 실값(미구현 아님) |
| flush 채널 통일 + `CloseRequested` | **통과** | `win.rs:485` `CloseRequested`→`begin_close_flush` · `windows.rs:53,58`이 두 이름을 같은 자리에서 방출 · 파일 마커 도착 · 닫은 뒤 목록 유지 |
| M1 `shortcut:close` | **통과** | 메인에서 1회 → **메인 1 · 추가 0** / 추가 창에서 → **추가 1 · 메인 1**(자기 창) · 목록 브로드캐스트는 **2 · 2** |
| M2 `app:get-initial-dir` | **통과** | argv 폴더가 그대로 내려온다 |
| M3 `ui:open-api-settings` | **통과** | 메인 창까지 왕복 1회 |
| **M5 `git:ai-message`** | **통과(R2의 부분2가 닫혔다)** | `poc-git-aimsg` **20/0** — 아래 |

M5는 근거까지 크리틱이 독립 재현했다(**API 호출 0건**):

```
설치본 claude.exe 0.3.241
  --ccg-bogus-flag 1  →  error: unknown option '--ccg-bogus-flag'   (대조군)
  --max-turns 1       →  (조용히 통과)                                (시험)
SDK sdk.mjs           →  if(St.length>0)Y.push("--allowedTools",…)   ← 빈 배열이면 플래그가 안 붙는다
2.6.2 src/main/git.ts:593-594  maxTurns: 1 · allowedTools: []
```

즉 **R2가 적어 둔 「미룬 근거」의 뒤 절반이 틀렸다는 빌더의 정정이 사실이다.** 실제로 나간 argv도 그대로다:

```
["--output-format","stream-json","--verbose","--input-format","stream-json",
 "--effort","low","--model","sonnet","--permission-mode","default","--max-turns","1"]
```

`--allowedTools` 없음 = 2.6.2 와이어와 같은 바이트. 화면 배선도 살아 있다
(`GitModal.tsx:342` → `shim.ts:332` → `git:ai-message`). 실패도 문장으로 착지한다
(`커밋에 담긴 파일이 없어요` · `Git 저장소가 아니에요`)고, 그 실패는 엔진을 안 띄운다.

### 2.7 회귀 그물 (체크리스트 6)

| 대상 | 결과 |
|---|---|
| `cargo test --bin agentcodegui` | **121 / 0** |
| `cargo test -p ccg-engine` | **201 / 0**(2 ignored) — 13개 테스트 타깃 합산 |
| `cargo test -p ccg-store` | **76 / 0** |
| `cargo test -p ccg-auth --features net` | **88 유닛 + 25 통합 = 113 / 0** |
| `npm run typecheck`(node·web) + `typecheck:app` | **3종 초록** |
| `poc-limit-resume` / `poc-limit-blind` / `poc-btw-fork` / `poc-mcpskill` | 141/0 · 14/0 · 33/0 · 전부 통과 |
| `poc-parity-t3t4`(라이브·격리 홈) | **40 / 1**(§4.2) · `--no-live` **34 / 1**(같은 id) |

규율도 깨끗하다: 세 커밋 통틀어 **동결 구역 0파일 · `app/` 0파일 · 공유 파일 0줄**
(`git diff --name-only babd925..HEAD`로 확인). 기준 파일도 안 갈렸다 —
`poc-limit-blind`에 `--out=`이 생겼고(R2 지적 4의 앞 절반), 크리틱 주행도 전부 `--out=`을 썼다.

---

## 3. ★ 이 라운드가 만든 회귀 — **Codex 채팅을 클로드 한도로 판정한다**

### 3.1 구조

```text
  Codex 채팅이 한도 에러로 죽는다
        │  classify_limit_error는 **엔진을 안 가른다**(runtime.rs:2693)
        ▼
  arm_hold → LimitHold.account = identity.billing()      ← runtime.rs:2773
        │     Codex 채팅의 billing은 **클로드 구독 계정**이다
        │     (identity.rs:329-334 — 미지정이면 default_account로 접는다.
        │      Codex 실행이 쓰는 계정은 EngineAxis::Codex{account}로 **따로** 산다)
        ▼
  check_hold → probe.blocked_until_for(account, model, now)   ← runtime.rs:3180
        │     limit_probe.rs 어디에도 엔진 종류 분기가 없다
        ▼
  peek_usage(클로드 이메일) → fold(클로드 usage) → **Blocked{클로드 주간 해제 시각}**
```

렌더러의 이식본은 이 축을 **가른다** — `useLimitResume.ts`의 `fire()`가
`cur.engine === 'claude'`면 `getUsage`, 아니면 `codexAuth.accountsUsage()` + `codexBlockedResetsAt`을 쓴다.
엔진 훅에는 그 갈래가 없다.

### 3.2 실측 (레포 밖 하네스 · 실계정 usage GET 1건 · 토큰 438분 남은 계정만 · 회전 0)

격리 홈에 **클로드 계정 하나**(주간 `pct:100`, 해제 `1787752800` = 약 50시간 뒤)와
**Codex 채팅 하나**(`identity.engine.kind='codex'`, 대기표 리셋 시각 2시간 전)를 심고 관찰했다.

```
   t= 85s eng=codex spawns=0 hold={resetsAt:0, ready:false, dueAt:90000, probes:0}      probe={asks:0,…}
   t= 90s eng=codex spawns=0 hold={resetsAt:0, ready:false, dueAt:105062, probes:1}     probe={asks:1, unavailable:1}
   t=105s eng=codex spawns=0 hold={resetsAt:179793813, ready:false,
                                   dueAt:179883813, probes:0}                            probe={asks:2, blocked:1}
```

`resetsAt = 179,793,813ms`(부팅 기준) **≈ 49.9시간** = 클로드 주간 창의 해제 시각.
그리고 **그 상태에서 사용자가 직접 보낸 메시지가 나가지 않는다**:

```
send 전 : {state:"Idle", queued:0, spawns:0, identityEngine:"codex", hold:{resetsAt:179793813, ready:false}}
chat:run  {chatId:"c-codex-hold", prompt:"사용자가 직접 보낸 새 메시지"}
send 후 : {state:"Idle", queued:1, spawns:0, queue:["사용자가 직접 보낸 새 메시지"]}
```

`hold_gate_open()`(`runtime.rs:845-849`)이 `ready && auto_resume && !auto_paused`라
표가 `ready`가 아니면 **드레인 자체가 막힌다**(`runtime.rs:1788`·`:1874`).

**같은 판, 같은 하네스, 옛 exe:**

```
   t= 85s eng=codex spawns=0 hold={resetsAt:0, ready:false, dueAt:90000}  probe=null
   t= 90s eng=codex spawns=1 hold=null                                    probe=null   ← 정상 발사
```

### 3.3 왜 치명인가

1. **틀린 근거로 사실을 주장한다.** 엔진은 이때 *"확인해 보니 아직 한도가 안 풀렸어요 — 다시 기다립니다"*
   (`runtime.rs:3194`)를 말한다. 확인한 것은 **다른 서비스의 한도**다.
2. **출구가 없다.** `ready=false`라 배너에 「이어가기」가 안 뜨고(`canPressResume` = `ready && …`),
   `managed` 배너에는 ✕도 없다(`Chat.tsx:3301` 주석: *"엔진의 대기표를 취소하는 채널이 아직 없다"*).
   대기표를 지우는 유일한 경로는 `check_hold`의 `same_account` 검사인데, 그것도 **due(50시간 뒤)** 에야 돈다.
   즉 그 채팅은 **최대 7일(주간 창)** 동안 아무것도 못 보낸다.
3. **오늘 이 사용자에게 실재하는 판이다.** 기본 계정 `lmg56634@gmail.com`의 주간 창이 지금 `pct:100`이다.
   Codex 채팅에서 한도를 한 번 만나면 그대로 걸린다.
4. **`Blocked`는 `probes`를 0으로 되돌린다**(`runtime.rs:3190`). 그래서 이 라운드가 새로 만든
   「6회 실패하면 사용자에게 넘긴다」 안전망도 **이 경로에는 안 걸린다.**

### 3.4 곁다리(같은 뿌리, 더 조용한 자리) — 시각 미상이면 **영영 손을 안 든다**

`runtime.rs:3219` `if probes < MAX_BLIND_PROBES || !past`의 `past`는
`h.resets_at.is_some_and(|r| now >= r)`이다. 즉 **리셋 시각을 모르는 표**(`arm_hold(None)` — 에러 문구에
`…|epoch` 꼬리가 없을 때)는 `past`가 영원히 거짓이라 `ready+auto_paused` 착지에 **도달하지 못한다**.
조회가 영구히 죽은 판(로그아웃·오프라인)에서 그 채팅은 10분마다 조용히 다시 묻기만 하고,
사용자 메시지는 §3.2와 같은 이유로 큐에 주차된다.

옛 경로에는 출구가 있었다: `Unknown` → 발사 → 또 막힘 → `attempts >= MAX_AUTO_ATTEMPTS` →
`auto_paused` + *"준비되면 눌러서 이어가세요"*(`runtime.rs:3270-3277`). 새 경로는 발사를 안 하므로
`attempts`가 0에서 안 움직이고, 그 사다리 자체가 **닿지 않는 코드**가 된다.
*(이 곁다리는 소스로 확정했고 시간은 안 쟀다 — 첫 프로브가 10분 뒤라 관찰창이 18분이다.)*

---

## 4. 회귀가 **아닌** 것으로 확인한 것

### 4.1 재검증이 정상 판을 느리게 만들지 않는다

첫 프로브는 스냅샷이 차가워 언제나 `Unavailable`이다(설계). 그 뒤 15초면 워커가 캐시를 채우고
두 번째 프로브가 `Clear`/`Blocked`로 착지한다 — Codex 실측(§3.2)에서 그 사다리가 그대로 보인다
(t=90s `asks=1 unavailable=1` → t=105s `asks=2 blocked=1`). **정상 재개의 추가 지연은 15초**다.
`probes==2`에서만 말하는 안내도 정상 판에서는 안 뜬다(2회차가 값을 얻으면 `probes`가 0으로 돌아간다).

### 4.2 라이브 `T4-6b` 1실패 — 회귀 아님(대조군 동일)

`poc-parity-t3t4`(라이브) **40/1**, `--no-live` **34/1**. 실패는 둘 다 `T4-6b`
(*"엔진 응답이 합성 시드 `ses-fork-1`을 인용해야 한다"*)이고, **옛 exe로 `--only=t4`를 라이브로 돌려도
같은 항목이 같은 값으로 실패한다**(크리틱이 직접 대조: 12통과/1실패, `echo`도 동일).
R2가 잰 41/0이 오늘 재현되지 않는 이유는 앱이 아니라 **하네스의 시간 가정**이다 — 이 검사는 실 CLI가
1.8초 안에 거절문을 돌려주는 데 기댄다. 오늘은 그 시각에 스레드에 사용자 메시지 한 줄뿐이었다.
**하네스 숙제로 남긴다(§6-3).**

### 4.3 라벨 스코핑·창 경계·브로드캐스트

M1(1·0 / 1·1)·M1-4(2·2)·H5(파일 마커 도착 + 닫은 뒤 목록 유지)가 전부 R2 값 그대로다.

---

## 5. 하네스·규율 관측

- **규율 위반 0.** 동결 구역 0 · `app/` 0 · 공유 파일 0줄 · 이름 기반 kill 0 ·
  기준 파일 복원 불필요(전 주행 `--out=`) · 실계정 토큰 회전 0(크리틱의 실 HTTP는 **usage GET 뿐**,
  토큰이 **4시간 이상** 남은 계정만 격리 홈에 실었다 — 5분 남은 `junelius_naver.com`은 한 번도 안 실렸다).
- ⚠ **`.gitignore`에 `.poc-scratch-*/`가 아직 없다**(R2 지적 4의 뒤 절반). `poc-parity-t3t4`가 만드는
  `.poc-scratch-t3t4/`는 정상 종료면 지워지지만 중간에 죽으면 남의 `git status`를 더럽힌다.
- ⚠ `lite.rs:93`의 `autoResume && !auto_paused` 접힘에 **테스트가 없다**(§2.3 각주). 이 줄 하나가
  「눌러서 이어가기」 버튼의 유일한 근거다.
- 빌더 보고의 수치는 대체로 재현됐다(11/0 · 14/0 · 20/0 · 141/0 · 33/0 · 76/113/201, typecheck 3종).
  다른 곳 둘: `agentcodegui`는 **121**(커밋 메시지의 114는 보고서에서 이미 정정됨),
  대조군 주행은 **5통과/6실패**(보고 4/7 — E4 표본 타이밍 차이, 판별력은 같다).

---

## 6. 종합 판정과 다음 라운드 지시

| 사용자 기준 | 판정 |
|---|---|
| R2가 세운 최대 격차(본채팅에 안전장치가 안 걸림)가 닫혔나 | **닫혔다.** 옛 exe 313바이트 → 새 exe 0바이트, 대조군까지 크리틱이 직접 재현 |
| R2의 부분2(`git:ai-message`)가 닫혔나 | **닫혔다.** argv·프롬프트·파싱·실패 문장 전부 실측, CLI 플래그 근거도 독립 재현 |
| 체크리스트 6항이 실동작하나 | **6/6 통과** |
| 이번 라운드가 새 사고를 만들었나 | **만들었다.** Codex 채팅이 클로드 한도로 최대 7일 잠긴다(사용자 메시지까지 주차) |

### 지시(중요도순)

1. **★ 재검증 훅에 엔진 축을 넣어라.** `LimitProbe::blocked_until_for`가 **어느 엔진의 한도인지**를
   받아야 한다. 최소 수선 두 갈래 —
   (a) Codex 정체성이면 `codex` 계정의 창(`codexBlockedResetsAt`의 Rust 짝)으로 묻는다,
   또는 (b) 그게 아직 없으면 **Codex는 판정하지 않는다**(= `Unknown`을 돌려 옛 계약으로 떨어뜨린다).
   (b)는 한 줄이고 이번 회귀를 즉시 없앤다. **통과 조건**: §3.2와 같은 판(클로드 주간 100% + Codex 대기표)에서
   `probe.blocked == 0`이고 t≈90초에 정상 발사 또는 정상 유지가 나올 것.
2. **시각 미상 표에도 출구를 만들어라**(§3.4). `past`가 거짓이어도 `probes >= MAX_BLIND_PROBES`면
   `ready+auto_paused`로 넘기든지, 최소한 「대기표 취소」 채널을 열어라 —
   지금은 `managed` 배너에 ✕도 「이어가기」도 없는 상태가 존재한다.
3. `poc-parity-t3t4`의 `T4-6b`를 시간 가정에서 떼어내라(엔진 응답을 기다리거나, 시드 인용 대신
   **나간 argv**를 물증으로 삼아라 — `CCG_FAKECLI_ARGV`가 이미 있다).
4. `.gitignore`에 `.poc-scratch-*/` · `lite.rs`의 `autoResume` 접힘에 테스트 한 줄.

---

### 재현 명령 (전부 크리틱이 실제로 돌린 것)

```
cd src-tauri && CARGO_TARGET_DIR=…/target-t3t4 cargo build --release --features custom-protocol
node scripts/poc-limit-engine.mjs                        --out=<레포 밖>      # 11/0
node scripts/poc-limit-engine.mjs --exe=<옛 exe>          --out=<레포 밖>      # 5/6 (대조군)
node scripts/poc-limit-engine.mjs --long                  --out=<레포 밖>      # 14/0
node scripts/poc-git-aimsg.mjs                            --out=<레포 밖>      # 20/0
node scripts/poc-parity-t3t4.mjs                          --out=<레포 밖>      # 40/1
node scripts/poc-parity-t3t4.mjs --only=t4 --exe=<옛 exe>  --out=<레포 밖>      # 12/1 (대조군)
node scripts/poc-limit-resume.mjs                                              # 141/0
node scripts/poc-limit-blind.mjs                          --out=<레포 밖>      # 14/0
node scripts/poc-btw-fork.mjs · node scripts/poc-mcpskill.mjs
CARGO_TARGET_DIR=…/target-t3t4 cargo test --bin agentcodegui                   # 121/0
CARGO_TARGET_DIR=…/target-t3t4 cargo test -p {ccg-engine,ccg-store}            # 201/0 · 76/0
CARGO_TARGET_DIR=…/target-t3t4 cargo test -p ccg-auth --features net           # 88+25/0
npm run typecheck && npm run typecheck:app
```

크리틱 전용 실측기 넷(워크바 게이지 DOM · **Codex 축 재현** · 2.6.2 MCP/스킬 모듈 구동 · 착지 DOM 시도)은
**레포 밖**(`%TEMP%\ccg-crit-t3t4r3\`)에 두었다 — 레포의 코드·하네스는 한 줄도 고치지 않았고,
기준 결과 파일은 하나도 덮지 않았다.
