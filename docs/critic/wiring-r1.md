# 배선 R1 크리틱 — 엔진 IPC 배선 · 기본값 전환 · R8-1

**판정 대상**: `192dfa7..c771258` (엔진 크레이트 정합 3건 · R8-1 · 엔진 글루 · `CCG_UNIFIED_STORE`
기본값 전환 · `scripts/poc-live-chat.mjs` · `docs/m3-report-r2.md` · `docs/critic/m3-r2-live.json`)

**판정**: **조건부 불합격.** 빌더가 잰 것은 전부 재현됐다(세로 조각 PASS · R8-1 · 98/54 green ·
A/B 수치). 재현되지 않은 것은 **빌더가 밟지 않은 경로**다. 그중 하나는 이 프로젝트가 3.0을
만드는 이유 그 자체 — **m-logic P8(유령 UI)** — 가 제품 경로에서 그대로 살아 있다는 것이다.
`ChatRuntime::stream_died()`(T22)의 **호출자가 재생 테스트뿐**이라, CLI가 외부에서 죽으면
채팅이 **영구히 굳는다**. 라이브로 두 갈래(승인 카드 중 / 스트리밍 중) 재현했다.

> 재현 명령은 §8. 산출물은 `docs/critic/wiring-r1-*.json`, 하네스는
> `docs/critic/tools/critic-wiring-{live,mem,alias}.mjs`.

**측정 바이너리**: `target/release/agentcodegui.exe` — **내가** `npm run tauri:build`로
`c771258`(작업트리 clean)에서 빌드, 4,541,952 B, 2026-08-23 04:54. 라이브 5종·A/B·메모리 분해는
전부 이 바이너리다. 이후 병행 빌더가 `app/`을 고쳐 리빌드했으므로(4,545,536 B), 별칭 spot 3+1건은
그 새 바이너리의 **핀 사본**(`bench/scratch/pin/`)으로 돌았다 — `git diff c771258..HEAD -- src-tauri
crates` = **0바이트**라 Rust 면은 판정 대상과 동일하다(렌더러만 다르다).

**안전**: 이름 기반 kill 0회. 죽인 것은 ⑴ 내가 spawn한 PID 트리와 ⑵ `engine:debug`가 알려 준
**내 격리 홈의 자식 CLI pid 4개**(22120·8960·30420·24692)뿐. 사용자 실앱 6프로세스는 시작·종료 시
동일(`%LOCALAPPDATA%\Programs\AgentCodeGUI\`). 실홈 `claude.exe`는 3→2가 됐는데 사라진 pid 34556은
내가 죽인 목록에 없다(사용자 턴이 스스로 끝난 것). 실홈은 읽기/복사만(engines=정션, 자격증명=복사).
격리 홈 잔존 0. 크리틱 소유 파일(`m2-r1-semantics.json`·`m2-r1-tauri.json`)과 추적 대상
`bench/results/multi-tauri-3.0.0-default.json`은 실행 후 원복했다.

---

## 0. 한 장 요약

| 항목 | 결과 |
|---|---|
| 세로 조각(`poc-live-chat.mjs`) 재실행 | **PASS · 결함 0 재현** (8단계 전부) — `wiring-r1-live.json` |
| R8-1 (영속 2 + 창 1 → changed 3건) | **재현** + 빌더가 안 밟은 **닫기** 경로까지 확인 |
| 라이브 공격 5+1종 | **A 통과 · B 통과 · C 실패(판정 커밋 / 병행 라운드 빌드에선 통과) · D 통과 · E 실패 · F 실패** |
| +12MB 원인 | **팬아웃 캐시 아님(반박).** 실제는 ~2MB(Rust) + 측정 잡음. 12.6은 **순차 A/B** 아티팩트 |
| 별칭 충실도 | `critic-m2-semantics` ok · `critic-m2-tauri`(=0) ok · spot 3건 PASS · **spot 4번째에서 결함 1** |
| 미배선 목록 | `EngineEvent` 9종 **정확**. 코어 6 **정확**. 그러나 **목록 밖에 3건 더 있다**(§6) |
| 크레이트 테스트 | `ccg-engine` **98 green / 2 ignored** · `ccg-store` **54 green** — 재현 |
| **가장 큰 격차** | **T22(stdout EOF·프로세스 사망) 미배선 — 제품에 진입점이 없다** |

---

## 1. 재현 — 빌더가 잰 것

### 1.1 세로 조각 (`node scripts/poc-live-chat.mjs`)

`PASS · 결함 0`. 8단계 전부 내 주행에서도 초록이다. 산출물은
`docs/critic/wiring-r1-live.json`(빌더 파일은 실행 뒤 `git checkout`으로 원복).

| | 빌더(`m3-r2-live.json`) | 내 재현 |
|---|---|---|
| 턴 시간 | 6,944 ms | **6,631 ms** |
| 비용 | $0.0191 | **$0.0185** |
| 프레임 총계 | 42 | **38** |
| `assistant-stream` 총계 | 3 | **1** |
| 저장된 메시지 | 5 | **4** |
| `spawns/exits` | 1/1 | **1/1** (누수 0) |
| 승인 카드 무응답 3초 생존 | true | **true** |
| 재시작 후 화면 복원 | true | **true** |

모델 변동으로 델타·메시지 수가 갈리는 것은 정상이다. **다만 보고서 §2의 수치 두 개는
자기 산출물과 안 맞는다**(§7-F9).

### 1.2 R8-1

내 주행: 부팅 `["sc-alpha","sc-beta"]` → 창 1개 열기 → changed `["s-13332-1","sc-alpha","sc-beta"]`
(3건) · `persistedLostInBroadcast: []`. **재현.**

여기에 **빌더가 안 밟은 절반**을 더 밟았다(`critic-wiring-alias.mjs` S3). R8 크리틱의 증상
문장은 *"창을 하나 열거나 **닫는** 순간"*인데 빌더 하네스는 **여는 쪽만** 단언한다.
닫기까지 확인: 부팅 `["w-1","w-2"]` → 열기 `["s-31520-1","w-1","w-2"]` → **닫기
`["w-1","w-2"]`** · `persistedLostOnClose: []`. **닫기 경로도 닫혀 있다.**

### 1.3 게이트 재실행

```
cargo test -p ccg-engine --offline   98 passed · 0 failed · 2 ignored   ← 재현
cargo test -p ccg-store  --offline   54 passed · 0 failed               ← 재현
critic-m2-semantics.mjs              ok:true · findings 0               ← 재현
critic-m2-tauri.mjs (부모 env =0)     ok:true · findings 0
    flagOn.disk {chatsV3:7, boards:3, statusJson:true} / flagOff.disk {chatsV3:false, boards:false}
critic-m2-tauri.mjs (env 없이)        ok:false · findings 1 "플래그가 꺼졌는데 통합 스토어가 생겼다"
```

마지막 줄까지 보고서 §5.2의 서술과 **글자 그대로 같다**. 이 하네스는 "꺼짐"을 env 생략으로
표현하므로 전환 뒤에는 부모 env로 `=0`을 줘야 한다 — 보고서의 설명이 맞다.
(`ccg-migrate.exe`는 03:26 빌드가 남아 있어 플래그 전환 이후로 다시 빌드해 돌렸다.)

---

## 2. 라이브 공격 5+1종 — 빌더가 안 밟은 경로

전부 CDP 실측. 하네스 `docs/critic/tools/critic-wiring-live.mjs`, 산출물
`docs/critic/wiring-r1-attacks.json`. 이벤트는 **두 겹**으로 봤다 — 2.6.2 `engine:event`와
3.0 브로드캐스트(`chat:status`·`chat:run-state`·`chat:verdict`)를 `plugin:event|listen`으로 직접 도청.

> **산출물 출처(정직하게)**: 아래 서술과 수치는 **판정 대상 바이너리(04:54 · c771258 · 4,541,952 B)**
> 로 잰 1차 주행이다. 그 뒤 `--only=E`로 치명 2건을 재확인하다 하네스가 결과 파일을 덮었고
> (지금은 병합하도록 고쳤다), 그 시점엔 병행 빌더가 exe를 리빌드해 1차 바이너리가 사라진 뒤였다.
> 그래서 첨부 JSON은 **핀 사본(05:42 빌드)으로 A~F 전체를 재주행**해 채웠다. Rust 면은
> `git diff c771258..HEAD -- src-tauri crates` = 0바이트라 동일하고 **렌더러만 다르다**.
> 결과도 **A·B·D·E·F는 두 바이너리에서 동일**했다. **C만 갈렸다** — 그 자체가 근거라 §2-C에 적는다.

| # | 공격 | 결과 |
|---|---|---|
| **A** | 스트리밍 중 소프트 중단(Esc) | **통과** |
| **B** | 승인 카드 거부 | **통과** |
| **C** | busy 중 채팅 전환 | **실패 — 침묵 no-op** |
| **D** | 스트리밍 중 앱 강제 종료 → 재시작 | **통과** |
| **E** | 승인 카드 뜬 채 CLI kill | **실패 — 영구 정지, 사유 없음** |
| **F** | 스트리밍 중 CLI kill (E의 일반화) | **실패 — 영구 정지** |

### A. 소프트 중단 — 통과

델타 3개가 흐른 시점에 **Esc**(= 컴포저 중지 버튼과 같은 `cancelRun`)를 눌렀다.

```
runStates : starting → streaming → interrupting → terminating → idle
화면      : '중단함' 마커 있음 · WorkingIndicator 사라짐 · 컴포저 활성
회계      : spawns 1 → exits 1  (중단 뒤)  →  다음 턴 spawns 2 / exits 2
재개      : "Reply with exactly: RESUMED" → result "RESUMED" (isError:false) · DOM에 표시
잔존 CLI  : 0 (앱 kill 뒤 자식은 msedgewebview2.exe 하나뿐)
```

**주의 1** — `window.api.interrupt()`만 부르면 중단 마커가 **안 뜬다**(1차 주행에서 실측).
마커는 렌더러의 로컬 리듀서(`session.ts` `interrupt-turn`)가 붙이고 IPC는 그와 별개다.
사용자 경로(Esc/중지 버튼)는 둘을 같이 부르므로 정상이다. 하네스를 쓸 때 밟기 쉬운 함정이라 적어 둔다.

**주의 2** — `mod.rs:181` 주석은 *"소프트 중단 — 턴만 끊고 **상주는 유지**한다"*인데, 실측에서는
중단과 함께 `exits`가 1 올라간다(= CLI 프로세스가 끝난다). 정상 완료 턴도 마찬가지라
(`spawns:1/exits:1`) **지금 배선에는 상주 CLI가 없다**. 2.6.2의 "중단 1회 → 턴마다 CLI 사망 루프"는
재현되지 않았으므로 결함은 아니지만, 주석이 약속하는 것과 실물이 다르다.

### B. 승인 거부 — 통과

```
카드 [허용 · 항상 허용 · 거부] → '거부' 클릭
tool-end  : status "error" · result "사용자가 거부했습니다."
result    : isError:false · "I see — your permission settings are blocking this action…"
디스크    : deny-me.txt 없음 (거부가 실제로 먹었다)
정리      : 카드 사라짐 · chat:status {status:"done", busy:false, ask:"none"} · state Idle
```

거부 본문(`{"behavior":"deny","message":…}`)이 CLI까지 도달해 모델이 그것을 읽고 이어 간다.
`respond_permission`의 파리티 구현이 실물에서 동작한다.

### C. busy 중 채팅 전환 — **실패(침묵 no-op)**

채팅 2개(`c-a`·`c-b`) 홈에서 `c-a`를 스트리밍시킨 뒤 사이드바에서 `c-b`를 **클릭**했다.

```
busy 전 : [{cls:"sb-item active", t:"크리틱 c-a"}, {cls:"sb-item",        t:"크리틱 c-b"}]
busy 중 : [{cls:"sb-item active", t:"크리틱 c-a"}, {cls:"sb-item locked", t:"크리틱 c-b"}]  ← locked
클릭 후 : 활성 채팅 그대로 c-a · 사이드바 그대로 · 토스트/사유 0건
```

근거 코드(판정 커밋 기준): `Sidebar.tsx:332` `locked = !!s.busy && c.id !== currentId`,
`onClick={() => !locked && …}` · `App.tsx:799` `if (id === activeChatId || busy || wfAlive) return`.
**m-logic P7("busy 중 사용자 조작 = 침묵 no-op")이 그대로 살아 있다.**

엔진은 이미 **채팅별 런타임**(허브의 `slots: HashMap<chatId, Slot>`)을 갖췄고 `chat:run`은 주소를
인자로 받는다 — 즉 **막는 쪽은 얼려 둔 렌더러**다. 이번 라운드가 `app/` 금지였던 것은 알지만,
보고서 §4.4(알려진 구멍 A~E)와 §7(남은 것)에 **이 항목이 없다**. 전환 게이트를 통과시키는
문서라면 "엔진은 되는데 제품은 여전히 못 한다"가 목록에 있어야 한다.

**병행 라운드가 이미 고쳤다 — 실측으로 확인.** 같은 하네스를 05:42 빌드(= 병행 빌더의
`app/src/api/unified.ts` 신설 + `App.tsx`의 `landActiveChat`/`onChatEvent`가 들어간 렌더러)로 돌리면

```
busy 중 사이드바 : [{cls:"sb-item active", …c-a}, {cls:"sb-item", …c-b}]   ← locked 없음
클릭 후          : 활성 채팅 "c-b" · switched true · c-a는 계속 Streaming(spawns 1/exits 0)
```

로 **통과**한다. 즉 이 지적은 판정 대상 커밋에서 참이고, 다음 라운드에서 이미 닫히는 중이다.
남는 요구는 하나 — **문서**다. 판정 대상의 §4.4 구멍 목록에 이 항목이 없었다.

### D. 스트리밍 중 앱 강제 종료 → 재시작 — 통과

`killTree(app)` (= 작업관리자 kill · 종료 flush를 안 타는 경로).

```
죽기 전 디스크 status.json : {"status":"working","busy":true,…}      ← 유령 값이 남는다
kill 뒤 자식 CLI            : [] (job object가 claude.exe를 거뒀다 — 고아 0)
재시작 후 화면              : WorkingIndicator 없음 · 사이드바 점 "dot " (실행색 아님)
                              · 컴포저 활성 · 유령 문구 없음
재시작 후 다음 턴           : "Reply with exactly: ALIVE" → result "ALIVE"
```

`status::load_boot`의 규약 4(부팅 강제 `busy=false`·`ask=none`·`working|analyzing → idle`)가
디스크의 유령 값을 실제로 걷어낸다. **이 경로는 설계대로 동작한다.**

부수 관찰: 재시작 뒤 `chat:status` 수신 0건. `engine::boot()`이 첫 REPLACE를 창(=구독자)이
생기기 **전에** 쏘고, 그 뒤 전이가 없으면 다시 안 쏜다. 지금은 `chats:get`이 `statuses`를 합쳐
주므로 화면은 맞지만, `chat:status`만 구독하는 3.0 렌더러는 첫 그림을 못 받는다(§7-F12).

### E. 승인 카드 뜬 채 CLI kill — **실패 · 치명**

`engine:debug`가 알려 준 자식 `claude.exe` pid **하나만** kill(`pidStillAlive:false`로 자기검증).
**같은 결과를 두 번 재현**했다.

```
t=0 ~ 85s (5초 간격 18샘플, 전부 동일)
  카드            : 살아 있음
  chat:run-state  : state "awaiting_user" · live 2건 · settled []
  chat:status     : {status:"working", busy:true, ask:"permission"}
  notice/result   : 0건            ← 사용자에게 아무 말도 안 한다
  engine:debug    : state AwaitingUser · exits 0   ← 프로세스가 죽은 걸 아무도 모른다
```

**탈출구도 사실상 없다.** Esc는 `.q-overlay`가 떠 있으면 렌더러가 양보한다(App.tsx의 모달 가드).
카드를 눌러야 하는데, 눌러도

```
'허용' 클릭 후 20s : 카드는 사라짐 · state "streaming" · busy:true  ← 다시 굳는다
그 뒤 Esc 15s      : state "idle" · chat:status {status:"error", busy:false}
```

즉 **"카드 클릭 → 다시 무한 정지 → Esc"** 라는 우연한 2단 조작을 알아야만 빠져나온다.
사용자에게는 그 사이 내내 "무엇이 잘못됐는지"가 한 글자도 안 보인다.

### F. 스트리밍 중 CLI kill — **실패 · 치명(E의 일반화)**

승인 카드가 없어도 같다. 카드 유무의 문제가 아니라 **외부 CLI 사망 전체가 미탐지**다.

```
t=0 ~ 115s : chat:run-state "streaming" · chat:status {status:"working", busy:true} · notice 0 · result 0
             engine:debug state Streaming · exits 0
그 상태에서 사용자가 다음 메시지 전송 → 45초 대기 → **result 없음**(컴포저 비워짐 = 큐에 갇힘)
사이드바     : 다른 채팅으로 도피 불가(C의 잠금)
Esc          : state "streaming" → "interrupting" (INTERRUPT_TIMEOUT 6s 뒤 idle)  ← 유일한 탈출구
```

**즉 CLI가 외부에서 죽으면 그 채팅은 사용자가 Esc를 누를 때까지(그리고 카드가 떠 있으면 Esc마저
안 먹는 채로) 영구히 busy다. 새 채팅·채팅 전환도 busy에 잠긴다.**

#### 원인 (코드 대조로 확정)

| 자리 | 사실 |
|---|---|
| `crates/ccg-engine/src/runtime.rs:2393` | `pub fn stream_died(&mut self, cause)` = T22. **호출자가 `tests/replay.rs:766`·`:925`·`tests/replay_standing.rs:707` 셋뿐**. `src-tauri/` 전체에 호출 0 |
| `crates/ccg-engine/src/driver.rs:380-383` | `poll_frames`가 `TryRecvError::Disconnected`(= stdout EOF)를 `break`로 **삼킨다**. 주석은 *"상위(T22)가 처리한다"* — 그 상위가 없다 |
| `runtime.rs:2143-2247` `timers()` | 타이머 아크는 `Starting`(20s) · `Interrupting`(6s) · `HeldResult` · `Resident`(6h)뿐. **`Streaming`·`AwaitingUser`에는 아크가 없다** = 무한 |
| `runtime.rs watchdog()` | `ledger.evidence_bearing()`만 돈다. m-logic §5.4가 **AskCard·RunningTool은 "스트림 종속이라 T22/T25가 거둔다"**고 명시적으로 제외했다 — 그 T22가 안 붙었다 |
| `src-tauri/src/engine/hub.rs pump()` | `tick()` + `drain_stderr()`만 부른다. `driver.process_alive()`도, EOF 신호도 안 본다 |

**97개 재생 시나리오는 T22를 덮는다**(위 3곳). 커버리지 게이트가 초록인 채 **제품 경로에만
진입점이 없다** — "테스트는 초록인데 제품이 굳는다"의 교과서적 형태다.

수리 방향(제안): `CliDriver`에 EOF/exit를 **값으로** 노출하고(`poll_frames`가 `Disconnected`를
삼키지 말 것), `hub::pump()`가 그 신호에서 `rt.stream_died(CloseCause::ExternalKill)`을 부른다.
정착 사유(`SettleReason`)가 이미 있으므로 화면 문구는 `chat:run-state.settled` + `notice`로 나간다.
2차 안전망으로 `Streaming`·`AwaitingUser`에도 프레임 최신성 상한을 두는 것(§5.4 ①a의 리스)을 권한다.

---

## 3. `request_user_dialog` — kill 없이도 같은 영구 정지 (코드 대조, 라이브 미재현)

E·F와 같은 착지점에 **프로세스를 죽이지 않고** 도달하는 경로가 하나 더 있다.

```
state.rs:133  T4  Streaming --Frame("can_use_tool|request_user_dialog")--> AwaitingUser  (AskCard 등록)
wire.rs:296   "`request_user_dialog`(폴백 확인)는 … 2.6.2 렌더러에는 대응 카드가 없다"  ← 이벤트를 안 낸다
```

즉 CLI가 폴백 확인 다이얼로그를 물으면 상태기계는 `AwaitingUser`로 들어가는데 **화면에는 카드가
안 뜬다.** 답할 채널(`chat:respond-dialog`)은 3.0 전용이라 얼려 둔 렌더러가 부르지 않는다.
결과는 §2-E와 동일한 무한 busy이고, 이번에는 **사용자가 아무 이상한 짓도 안 했는데** 그렇게 된다.

폴백 확인은 실제로 관측된 경로다(메모리: *"거부 폴백은 질문 카드로 확인"*). 라이브 재현은
모델 거부를 강제해야 해서 이번 라운드에서 안 했다 — **코드 대조 근거만** 있다는 점을 명시한다.
보고서 §4.3은 이것을 `wire.rs` 주석 한 줄로만 남겼고 §4.4 구멍 목록에는 없다.

---

## 4. +12MB 원인 판정 — **팬아웃 캐시 가설은 반박**

### 4.1 먼저 빌더 값을 재현했다

`node bench/multi.mjs tauri --repeats=3` × 2팔(같은 바이너리, 빌더와 같은 순차 순서).
산출물 `docs/critic/wiring-r1-multi-{ON,OFF}.json`.

| | 켬 | 끔(`=0`) | Δ | 빌더 |
|---|---|---|---|---|
| idleGrid WS MB | **430.1** | **418.1** | **+12.0** | +12.6 |
| idleGrid Priv MB | **248.8** | **236.0** | **+12.8** | +11.4 |
| 회차 원값 WS | 433.4 / 426.6 / 430.1 | 420.2 / 418.1 / 418.0 | | |
| 스크롤 드랍 | 0 (3/3) | 0 (3/3) | | 0 |

**재현된다.** 그리고 같은 파일의 `procDetail`이 이미 첫 힌트를 준다 — Rust 프로세스
(`agentcodegui.exe`)는 켬 36.1/17.0 · 끔 34.0/15.3 MB, **차이 1.9/1.7MB**. 12MB가 Rust에 있지 않다.

### 4.2 역할별 분해 + 인터리브 A/B

`docs/critic/tools/critic-wiring-mem.mjs` — 같은 픽스처·같은 타이밍(4s+20s)으로 재되,
⑴ 프로세스를 **역할별로** 쪼개고(`--type=renderer` 판별) ⑵ 렌더러 JS 힙·DOM·페이로드 바이트를
같이 뜨고 ⑶ **팔을 번갈아** 돈다(순차 A/B의 머신 드리프트 제거).

**5쌍 인터리브** (`docs/critic/wiring-r1-mem-onoff.json`) — 쌍별 Δ(켬−끔):

| 항목 | 쌍별 Δ | 중앙값 |
|---|---|---|
| total WS MB | 5.5 · 1.6 · 8.6 · 3.9 · 7.7 | **5.5** |
| total Priv MB | 3.8 · −1.3 · 7.6 · 3.9 · 6.8 | **3.9** |
| **Rust(agentcodegui.exe) WS** | 2.0 · 1.3 · 1.8 · 2.1 · 2.0 | **2.0** ← 분산이 거의 없다 |
| **Rust Priv** | 2.3 · 0.7 · 2.0 · 2.2 · 1.7 | **2.0** |
| 렌더러 WS | 4.0 · 0 · 5.5 · 4.2 · 4.3 | 4.2 |
| 그 밖(gpu·utility·crashpad) | −0.6 · 0.2 · 1.2 · −2.4 · 1.4 | 0.2 |
| **렌더러 JS 힙 used** | −0.2 · −0.1 · 0.4 · −0.2 · 0.3 | **−0.1** |
| DOM 노드 | — | **+3** (16,196 vs 16,193) |
| `chats:get` 바이트 | — | +1,230 B |
| `ma:get` 바이트 | — | **−780 B** |
| 디스크 `chats-v3` | 336 KB | 0 KB |

**웜 프로필 팔**(같은 홈으로 한 번 띄웠다 끄고 두 번째 부팅을 재는 팔, 2쌍만 — 병행 빌더의
리빌드가 exe를 갈아치워 중단됨): total Δ **+1.7 WS**, Rust Δ **+0.9/+1.0**.

### 4.3 판정

1. **팬아웃 캐시(`HashMap<id, 파일 원문>`)는 원인이 아니다.** 그 캐시가 들 수 있는 최대치는
   `chats-v3` 디스크 크기 = **336 KB**다(캐시는 파일 원문 문자열이다). 12MB는 물리적으로 불가능하고,
   측정된 Rust 델타 2.0MB의 **17%**도 못 채운다. 덧붙여 **레거시 팔에도 같은 캐시가 있다**
   (`chats.rs:51 static CACHE: Mutex<Option<HashMap<String,String>>>`) — 팔 사이의 차이가 아니다.
2. **12.6MB는 순차 A/B의 아티팩트다.** 팔을 번갈아 돌면 같은 지표가 **5.5MB**로 내려가고,
   쌍별 스프레드가 1.6~8.6MB다 — 즉 측정 잡음 폭이 ±3.5MB인 무대에서 팔당 3회 순차 측정으로
   12.6이라는 점추정을 쓴 것이다. 콜드 WebView2 프로필이 큰 분산의 출처로 보인다
   (웜 팔에서 total이 415MB대로 15MB 내려간다).
3. **실재하는 몫은 Rust 프로세스의 ~2MB뿐**이고 그것은 **재현성이 매우 높다**(5쌍 전부 1.3~2.3).
   후보는 부팅 1회 마이그레이션이 남긴 할당(레거시 3스토어를 통째로 파싱해 336KB를 쓴다)과
   보드/상태 맵이다. 남은 ~3MB는 렌더러 쪽인데 **JS 힙 Δ ≈ 0 · DOM Δ ≈ 0 · 페이로드 Δ ≈ 0**이라
   데이터가 늘어난 것이 아니다(= 잡음 또는 할당자 수준의 차이).
4. 따라서 **다음 라운드가 팬아웃 캐시를 손대는 것은 낭비다.** 2MB를 실제로 줄이려면 마이그레이션
   경로의 피크 할당을 봐야 하고, 그 전에 **인터리브 A/B로 다시 재는 것**이 먼저다.

### 4.4 덤으로 — A/B 산출물이 서로를 덮는다

`bench/lib.mjs armName()`은 `CCG_SINGLE_PROCESS`·`CCG_WEBVIEW_*` 등만 보고 **`CCG_UNIFIED_STORE`를
안 본다.** 그래서 두 팔이 모두 `bench/results/multi-tauri-3.0.0-**default**.json`에 쓴다 —
두 번째 팔이 첫 팔을 지운다. 보고서 §6이 "확인 후 `git checkout`"이라고 적은 그 파일은
**2026-08-22T12:56Z·5회짜리 R8 기준선**이고, §5.3 표의 켬/끔 두 팔에 대응하는 산출물은
**레포에 하나도 없다.** R3 크리틱 §9-2가 고쳤던 바로 그 결함(팔이 파일 하나를 공유)이
새 플래그로 되살아났다. `armName`에 `if (env.CCG_UNIFIED_STORE === '0') parts.push('legacystore')`
한 줄이면 닫힌다.

---

## 5. 별칭 충실도 — spot 4건

`docs/critic/tools/critic-wiring-alias.mjs` (2.6.2 레거시 3스토어를 심고 새 기본값으로 부팅해
**도는 앱의 IPC**로 직접 친다). 산출물 `docs/critic/wiring-r1-alias.json`.

| # | 검사 | 결과 |
|---|---|---|
| S1 | `chats:get{light}`이 준 `unloaded` 마커를 그대로 `chats:save` → 스냅샷 보존 | **PASS** — 마커 2건(c-2·c-3), 왕복 후 메시지 6/7/8 그대로 |
| S2 | `ma:get` → 패널 제목 수정 → `ma:save` → `ma:get` | **PASS** — 제목 반영 + 패널 스냅샷 5/4 보존 |
| S3 | 추가 채팅 목록: 열기 **및 닫기** | **PASS** — 부팅 2 → 열기 3 → 닫기 2, 유실 0 |
| S4 | 추가 채팅 **창의 대화 저장/복원 채널** | **FAIL** (아래) |

### S4 — 추가 채팅 창의 대화가 저장되지 않는다

```
session-wins:persist   → { "__unimplemented": true }
session-wins:hydrate   → { "__unimplemented": true }
session-wins:rename    → { "__unimplemented": true }
session-wins:report    → null (구현됨)
persist 후 chats-v3/w-1.json 메시지 수 : 3  (= 마이그레이션 값 그대로. 보낸 페이로드는 버려졌다)
```

렌더러는 이 채널들을 **실제로 부른다**: `SessionWindow.tsx:342` `window.api.session?.persist?.(payload)`
(600ms 디바운스) · `:350` `onFlushRequest → persistNowRef` · hydrate로 마운트 복원.
셸에는 `ch::SESSION_REPORT`만 있고 나머지 셋은 상수조차 없다.

**왜 이번 라운드의 문제인가**: 이 라운드가 `session:run`·`session:*` 6채널을 배선해 **추가 채팅
창에서 실제로 대화가 돌기 시작했다.** 그 전까지는 돌지 않으니 저장할 것도 없었다. 지금은
"Ctrl+Shift+N → 대화 → 창 닫기 → 증발"이 **새로 열린 데이터 유실 경로**다. 게다가 그 창의 chatId는
`format!("s-{}-{}", std::process::id(), n)`(`win.rs:279`)이라 **앱을 다시 켤 때마다 값이 바뀐다** —
저장 채널이 생겨도 id 규약을 먼저 고쳐야 한다.

보고서 §4.2는 추가 채팅 표면을 "6개 배선"으로만 적고, §4.4-E는 "영속된 추가 채팅을 클릭해서 창을
되만드는 경로가 없다"까지만 말한다. **"그 창에서 나눈 대화는 저장되지 않는다"가 목록에 없다.**

---

## 6. 미배선 목록의 정확성

### 맞는 것

- **`EngineEvent` 23종 중 미배선 9종** — `protocol.ts`의 유니온을 기계적으로 세어 대조했다.
  23종 정확. 미배선 9종(`thinking-clear`·`todos`·`file-change`·`terminal`·`subagent`·`bg-tasks`·
  `bg-task-end`·`workflow`·`error`) **전부 일치**, 배선 14종도 전부 유니온에 있다. 빠뜨린 이름 0.
- **코어 32 중 미배선 6** — `win:chat-open/close/focus/list` + `chat:windows` + `chat:flush-req`.
  `ipc/mod.rs`에 상수 자체가 없다. 정확.
- `btw:open` · `ma:panel-*` · `talk:*` · Codex 미배선 — 정확(심 경고로도 확인:
  주 창이 실제로 부르는 미구현 채널은 `engine:list-available`·`lsp:prewarm`·`ma:panel-states`·
  `usage:get` 넷뿐이고 전부 M1 안전값 경로다).

### 목록 **밖**에 더 있는 것 (전부 이번 라운드에 의미가 생긴 자리)

| # | 빠진 항목 | 왜 목록에 있어야 하나 |
|---|---|---|
| 1 | **T22 — `stream_died()` 진입점** | 채널도 이벤트도 아니라 두 목록에 안 걸린다. 그런데 이게 §2-E/F의 원인이고 제품 최악의 실패다 |
| 2 | **`session-wins:persist` / `hydrate` / `rename`** | 얼려 둔 렌더러가 **부르는데** 없다 → 추가 채팅 대화 증발(§5-S4) |
| 3 | **`request_user_dialog` → 화면 카드** | `wire.rs` 주석에만 있고 §4.3/§4.4 표에는 없다. 결과가 "UI가 비어 있다"가 아니라 **"채팅이 굳는다"**라 등급이 다르다 |

§4.3의 마무리 문장 *"전부 '이벤트를 안 낸다'이지 '틀린 값을 낸다'가 아니다 — 그 UI만 비어 있다"*는
9종에 대해서는 맞지만, 위 3건에는 **적용되지 않는다**. 그 문장이 독자에게 "미배선 = 무해"라는
인상을 주는 것이 이 보고서의 가장 큰 서술 문제다.

---

## 7. 나머지 결함 (코드 대조 · 낮은 등급부터 높은 순)

| # | 자리 | 내용 |
|---|---|---|
| **F6** | `hub.rs handle()` | **`chat:verdict`가 명령마다 2번 나간다.** 글루가 `emit_all(verdict_wire(...))`를 쏘고, 같은 명령의 `ChatRuntime::dispatch`가 `Event::Verdict`를 또 낸다(`runtime.rs:541`은 **무조건** 방출). 실측 도청: 사용자 전송 1회 → `send:accepted` **2건**, 중단 1회 → `interrupt:accepted` **2건**. 지금은 구독자가 없어 잠재지만, 판정 토스트를 붙이는 순간 거부 사유가 두 번 뜬다. (`Op::Respond`·`IdentitySet` 등은 1건 — Run/Cmd만 이중) |
| **F8** | `hub.rs fanout()` | **이벤트 하나마다 디스크를 읽는다.** `super::active_chat_id()` → `chats-v3/index.json` 읽기, `panel_id_for_chat()` → `boards::read_boards()` = `Fanout::read_all()`(보드 파일 전수 읽기 + **캐시 `clear()` 후 재삽입**). 한 턴의 스트림 이벤트가 수십 개이므로 델타마다 파일 I/O 2종 + HashMap 재구축이 돈다. 20ms 틱과 겹치면 유휴가 아니라 스트리밍 구간의 CPU가 걸린다 |
| **F10** | `hub.rs wait()` | `Resident`가 **두 갈래 모두 `TICK_ACTIVE`(20ms)** 로 떨어진다(첫 조건의 `!= Resident`가 둘째 분기에서 다시 `TICK_ACTIVE`를 준다). 보고서 §3.2의 *"런타임만 있음 250ms"*는 **전부 `Idle`일 때만** 참이다. 상주 경로(bg 셸·워크플로)가 배선되는 순간 허브가 50Hz로 상시 회전한다 |
| **F11** | `runtime.rs land_turn()` | 중단으로 끝난 턴도 `TerminalStatus::Done`을 낸다(어휘에 Done/Error뿐). 이번 라운드가 그 값을 `status.json`에 **영속**시키기 시작했고 `load_boot`는 `done`을 안 내린다 → 사용자가 끊은 턴이 재시작 뒤에도 "완료"로 남는다. 지금 사이드바 점은 `done`과 `idle`이 같은 색이라 눈에 안 보이지만, 사용자 정정("완료 색은 진짜 완료일 때만")의 단일 소스가 되려는 값이라 지금 어휘를 늘리는 편이 싸다 |
| **F12** | `engine::boot()` | 첫 `chat:status` REPLACE를 창이 구독하기 전에 쏜다. 전이가 없으면 다시 안 쏘므로 그 채널만 보는 구독자는 영원히 빈손이다(현재는 `chats:get`이 합쳐 줘서 무해) |
| **F9** | `docs/m3-report-r2.md` §2 | 자기 산출물과 안 맞는 수치 2건. ⑴ 프레임 내역 `stream_event **34**` — 합이 45가 되어 같은 줄의 "42개"와 모순. `m3-r2-live.json`의 값은 **31**(합 42). ⑵ "델타 **3~6**" — JSON에는 3만 있고 6의 근거가 없다(내 재현은 1). "이 문서는 사실만 적는다"고 선언한 문서라 표기 정확도가 계약이다 |

---

## 8. 재현

```bash
# 판정 대상 바이너리 (작업트리를 c771258로 맞춘 뒤)
npm run tauri:build

# 빌더 게이트 재현
cargo test -p ccg-engine --offline                 # 98 green / 2 ignored
cargo test -p ccg-store  --offline                 # 54 green
node scripts/poc-live-chat.mjs                     # PASS · 결함 0  → docs/critic/m3-r2-live.json
cargo build -p ccg-store --features cli --bin ccg-migrate   # ← 플래그 전환 뒤 다시 빌드할 것
node docs/critic/tools/critic-m2-semantics.mjs
cp target/release/agentcodegui.exe "$TEMP/ccg-critic-m2-app.exe"   # 캐시 갱신 필수
CCG_UNIFIED_STORE=0 node docs/critic/tools/critic-m2-tauri.mjs

# 크리틱 하네스
node docs/critic/tools/critic-wiring-live.mjs              # A~F (실 CLI · 소액 과금)
node docs/critic/tools/critic-wiring-live.mjs --only=E,F   # 치명 2건만
node docs/critic/tools/critic-wiring-alias.mjs             # S1~S4 (CLI 불필요)
node docs/critic/tools/critic-wiring-mem.mjs --repeats=5   # 인터리브 A/B 분해
node docs/critic/tools/critic-wiring-mem.mjs --repeats=4 --arms=on2,off2   # 웜 프로필 팔

# 주 게이트(순차 A/B — 빌더 값 재현용. 두 팔이 같은 파일에 쓴다, §4.4)
node bench/multi.mjs tauri --repeats=3 && cp bench/results/multi-tauri-3.0.0-default.json /tmp/on.json
CCG_UNIFIED_STORE=0 node bench/multi.mjs tauri --repeats=3
git checkout bench/results/multi-tauri-3.0.0-default.json
```

산출물: `wiring-r1-live.json`(세로 조각 재현) · `wiring-r1-attacks.json`(A~F) ·
`wiring-r1-alias.json`(S1~S4) · `wiring-r1-mem-onoff.json`(5쌍 인터리브) ·
`wiring-r1-mem-migration.json`(콜드/웜 교란 확인) · `wiring-r1-multi-{ON,OFF}.json`(주 게이트).

---

## 9. 다음 라운드에 요구하는 순서

1. **T22 배선** — `poll_frames`가 EOF를 값으로 올리고 `hub::pump()`가 `stream_died()`를 부른다.
   정착 사유를 `chat:run-state.settled` + `notice`로 화면에 낸다. 회귀 하네스는
   `critic-wiring-live.mjs --only=E,F`가 이미 있다(지금은 붉다).
2. **`request_user_dialog`에 카드** 또는 최소한 **거부 후 정착** — 카드 없이 `AwaitingUser`로
   들어가는 경로를 남기지 않는다.
3. **추가 채팅 창 저장** — `session-wins:persist/hydrate/rename` 3채널 + chatId를 pid 기반에서
   영속 id로. 안 할 거면 **그 창에서 대화가 안 돌게** 막는 편이 대화 증발보다 낫다.
4. **busy 중 채팅 전환** — 코드는 병행 라운드에서 이미 열렸다(05:42 빌드 실측 통과).
   남은 것은 **문서** — 판정 대상 보고서의 구멍 목록에 이 항목이 없었다는 사실은 남는다.
   그리고 §2-C의 회귀 검사(`--only=C`)를 상시 게이트에 넣을 것.
5. `chat:verdict` 이중 방출 제거 · `fanout()`의 채팅↔창 역인덱스 캐시화.
6. 메모리는 **인터리브 A/B로 다시 재고 나서** 손댄다. 팬아웃 캐시는 후보가 아니다.
