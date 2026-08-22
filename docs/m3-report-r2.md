# M3 R2 — 엔진 × 스토어 × 셸 배선 (3.0.0)

**범위**: `src-tauri/`(엔진 글루 신설 · `win.rs` R8-1 · `main.rs`) · `crates/ccg-engine`(정합 3건) ·
`crates/ccg-store`(기본값 전환) · `scripts/poc-live-chat.mjs`
**계약**: `docs/design/m-logic.md` §4.3·§5.6·§5.8 · `docs/design/ux-chat-unify.md` §6.1(32채널)·§6.2
**전제 문서**: `docs/critic/r8-confirm.md` (R8-1 · D15 · D17)

> 이 문서는 **사실만** 적는다. 수치는 전부 내 주행값이고 명령은 §6에 그대로 있다.
> 판정은 크리틱 몫이다 — 여기에 "통과/합격" 같은 자기 채점은 없다.

**안전**: 이름 기반 kill 0회. 죽인 PID는 **내가 spawn한 트리만**(`killTree`). 사용자 실앱
6프로세스는 시작·종료 시 동일하고 전부 `%LOCALAPPDATA%\Programs\AgentCodeGUI\`(설치본).
실홈은 **읽기/복사만** — 엔진 폴더는 정션(`mklink /J`)으로 걸고 자격증명은 복사해 격리 홈에
넣었다(CLI의 토큰 갱신이 실홈에 안 닿는다). 실행 후 `poc-home` 소속 `claude.exe` 잔존 0.
크리틱 소유 파일(`docs/critic/m2-r1-*.json`)은 게이트 실행이 덮은 뒤 `git checkout`으로 복원했다.

---

## 0. 한 장 요약

| | 값 |
|---|---|
| **라이브 세로 조각** | `scripts/poc-live-chat.mjs` **PASS · 결함 0** — 8단계 전부(§2) |
| 실 CLI 1턴 | 스폰 1 · 종료 1(누수 0) · 턴 6.9s · 프레임 42 · 승인 왕복 1회 · 파일 실제 생성 |
| **배선 채널** | 3.0 코어 26/32 · 2.6.2 별칭 19명령 + 3이벤트 · `EngineEvent` 14/23종 |
| **미배선** | 코어 6(창 자리 4 + `chat:windows` + `chat:flush-req`) · `EngineEvent` 9종(§4) |
| `CCG_UNIFIED_STORE` | **기본 켬**으로 전환(탈출구 `=0` 유지) — 전제였던 R8-1을 먼저 닫았다 |
| 주 게이트(3회 중앙값) | 켬 **431.3 / 247.2 MB** · 끔 **418.7 / 235.8 MB** · 같은 바이너리 A/B(§5.3) |
| 크레이트 테스트 | `ccg-engine` **98 green**(97 + D17 1) · `ccg-store` **54 green** |

---

## 1. R8-1 — 기본값 전환의 전제 (닫음)

### 무엇이었나

`win.rs broadcast_sessions()`는 `session_list()`(**열린 창만**)를 실었고, `session-wins:list`는
통합 별칭이 가로채 **영속 + 열린 창**을 합쳐 줬다. 렌더러는 `onChanged`를 REPLACE로 먹는다
(`App.tsx:219-220`). → 추가 채팅 창을 **하나 열거나 닫는 평범한 클릭 한 번**에 마이그레이션된
추가 채팅이 사이드바에서 통째로 사라졌다(크리틱 R8 §2.5).

### 수정

`unified.rs`의 병합 함수를 `pub`으로 올리고 브로드캐스트가 **같은 원천**을 싣게 했다.
플래그가 꺼져 있으면 옛 동작(열린 창만) 그대로다 — 대조군의 픽셀을 바꾸지 않는다.

```rust
// src-tauri/src/win.rs
pub fn broadcast_sessions(app: &AppHandle) {
    let payload = if ccg_store::unified_store_enabled() {
        crate::ipc::unified::session_wins_list()   // 영속 + 열린 창
    } else {
        session_list()                              // 옛 동작
    };
    let _ = app.emit_to(MAIN, ch::SESSION_WINS_CHANGED, payload);
}
```

### 실측 (`node scripts/poc-live-chat.mjs --only=r81`)

합성 홈: 2.6.2 `session-chats/` 2건 · 열린 창 0 · 격리 홈 · 기본값(통합 켬).

```
부팅 직후 list()          : ["sc-alpha","sc-beta"]                 (2건)
추가 채팅 창 1개 열기      : changed 페이로드 = ["s-10668-1","sc-alpha","sc-beta"]   ★ 3건
그 직후 list()            : ["s-10668-1","sc-alpha","sc-beta"]
persistedLostInBroadcast  : []            ← R8 크리틱에서는 ["sc-alpha","sc-beta"]
```

근거 파일: `docs/critic/m3-r2-live.json` `steps.r81`.

---

## 2. 라이브 세로 조각 — 이번 라운드의 게이트

`scripts/poc-live-chat.mjs` (격리 홈 `.poc-home-live` · 실 `claude.exe` 0.3.239 · 실 계정 ·
haiku/minimal/`--permission-mode default` · CDP). **화면(DOM)과 이벤트를 서로 독립인 두 증거로**
본다 — 이벤트만 보면 "백엔드는 되는데 화면이 비어 있다"를 못 잡는다.

| # | 단계 | 무엇으로 확인했나 | 값 |
|---|---|---|---|
| 1 | **부팅** | `window.api` 응답 · 채팅 목록 · 컴포저 DOM | `chats:["c-live"]` · `composer:true` |
| 2 | **채팅 열기** | 활성 채팅 id | `active:"c-live"` |
| 3 | **메시지** | **실제 컴포저에 타이핑 + Enter**(React value setter 경유) | `sent` |
| 4 | **스트리밍** | `assistant-stream` 델타 + 화면 텍스트 | 델타 **3~6**, 텍스트 `"I'll create the file with the exact content \"OK\".DONE"` |
| 5 | **승인 카드** | `.q-overlay .qcard` DOM | 헤더 `Claude의 승인 요청` · 도구 `Write` · 요약 `Write …\live-approve.txt` · 선택지 `[허용, 항상 허용, 거부]` |
| 5b | **영구 정지** | 무응답 3초 뒤 카드 생존 | `true` (타임아웃 없음 = `AwaitingUser`의 정의) |
| 6 | **완료** | `result` 이벤트 + **디스크의 파일** | `isError:false` · `text:"DONE"` · 파일 `live-approve.txt` 내용 `OK` · 턴 **6.9s** |
| 7 | **재시작** | 새 프로세스로 재부팅 → 디스크 + **화면** | `loadedMsgs:5` · `sessionId` 살아 있음 · DOM에 프롬프트·`DONE` 둘 다 |

**턴 1회의 회계**(`engine:debug`): `spawns:1 · exits:1 · state:Idle · queued:0` — 프로세스 누수 0.
**프레임**(`CCG_ENGINE_LOG` 덤프) 42개: `system/init 1 · system/status 2 · stream_event 34 ·
assistant 3 · control_request 1 · control_response 1 · user 1 · rate_limit_event 1 · result/success 1`.
**이벤트**(렌더러가 실제로 받은 것): `status 3 · session 1 · assistant-stream 3 · assistant-done 2 ·
context 3 · tool-start 1 · permission-request 1 · tool-end 1 · result 1`.

디스크(종료 후):

```
chats-v3/c-live.json  snapshot.messages 5 · snapshot.session.sessionId b0a83c72-…
                      identity.cwd  c:\…\.poc-home-live\work   ← Rust 소유 필드 되끼움(§4.1 규약 2)
                      identity.engine.model  haiku
chats-v3/status.json  {"chatId":"c-live","status":"done","busy":false,"bgActive":false,
                       "ask":"none","hold":null,"queued":0,"unread":0}    ← Rust 전용 파일
```

> **정직하게 남는 것**: `status.json`의 값은 500ms 디바운스 쓰기와 종료 flush 중 어느 쪽이
> 썼는지 이 하네스가 가르지 못한다(턴 종료가 창 닫기보다 3초 앞선다). D15는 **배선**을
> 확인한 것이고, flush를 격리 증명한 것은 아니다.

---

## 3. 배선 — 무엇을 어떻게 이었나

### 3.1 새 모듈 `src-tauri/src/engine/` (6파일)

| 파일 | 하는 일 |
|---|---|
| `mod.rs` | 채널 디스패치 + **주소 번역 3함수**(`active_chat_id` · `panel_id_to_chat` · `chat_for_window`) + 부팅/상태 배열 |
| `hub.rs` | **`ChatRuntime`을 소유하는 스레드 하나** + 틱 펌프 + 브로드캐스트. 락 규율이 파일 헤더에 있다 |
| `tap.rs` | `ClaudeDriver`를 감싸 지나가는 **프레임을 한 벌 더 뜬다**(엔진 무수정) |
| `wire.rs` | 원시 프레임 → **2.6.2 `EngineEvent`** 번역 |
| `ident.rs` | 앱 홈 → `IdentityDefaults` · 옛 `RunRequest` → **리프 단위 패치** |
| `lite.rs` | `ChatStatusLite` 합성(§5.8) |

### 3.2 스레드·락 규율 (데드락 방지)

`ChatRuntime`은 내부에 `Rc<RefCell<…>>`를 들고 있어 **`!Send`**다. 그래서 구조가 강제된다:

```
IPC 스레드(N) ──Job──▶ [허브 스레드 1개: 런타임 소유·틱·프레임 탭] ──emit──▶ 창들
              ◀─Value─
```

규율 6줄(전문은 `hub.rs` 헤더):

1. **런타임에는 락이 없다** — 소유자가 하나라 필요가 없고, 다른 스레드가 만질 경로를 타입이 막는다.
2. 허브는 IPC를 **기다리지 않는다**(응답은 던지고 잊는다).
3. IPC는 허브를 **무한정 기다리지 않는다**(`recv_timeout` 3s → 안전값).
4. 스토어 락은 **잎**이다 — 허브에서만 잡히고 스토어는 허브로 되돌아오지 않는다(콜백 없음).
5. `app.emit*`은 허브에서 부른다(Tauri emit은 동기 콜백을 되부르지 않는다).
6. **프레임 수신 스레드는 런타임도 스토어도 모른다** — `mpsc::Sender<Value>`에만 쓴다.
   "프레임 스레드에서 스토어 쓰기 락"이라는 데드락 후보가 구조적으로 없다.

**승인 무응답 = 영구 정지**: 이 모듈 어디에도 카드를 자동으로 닫는 타이머가 없다(§2 5b가 실측).

**틱 간격**: 스트림 있음 20ms / 런타임만 있음 250ms / 런타임 0개 2000ms — 유휴에서 사실상 잠든다
(주 게이트의 유휴 측정 구간에는 런타임이 하나도 없다).

### 3.3 엔진 크레이트 정합 3건 (기존 97 테스트 무영향)

| # | 무엇 | 왜 |
|---|---|---|
| **D17** | `RawBilling`의 `Serialize`를 손으로 씀 — `api_key`면 `{"kind":"api_key"}`, 구독이면 `account`·`dropEnvKey`를 **항상** 싣는다 | 파생 구현은 `{"kind":"api_key","account":null,"dropEnvKey":null}`을 냈다. 크리틱 하네스의 `canon()`은 null을 안 지운다(`critic-m2-lib.mjs:35-42`) → 엔진이 `to_raw()`를 저장하는 순간 마이그레이션 **1차 비교가 거짓 불일치**. 고치는 방향은 **엔진이 스토어에 맞추는 쪽**이다(반대로 하면 크리틱의 독립 미러 `critic-m2-migrate.mjs:57`이 깨진다 = 판정자를 대상에 맞추는 수정). 새 테스트 `api_key_billing_serializes_without_null_leftovers`가 잠갔다 |
| `drain_events()` | 사인크를 **가져가며 비운다** | `events()`는 누적본을 통째로 복사한다(재생 하네스용). 상주 앱이 그걸 쓰면 턴마다 무한히 커지고 같은 이벤트를 다시 보낸다. 하네스는 이 메서드를 안 부른다 |
| `stage_respond_payload()` | 다음 `Cmd::Respond`의 **본문 오버라이드**(1회) | `Cmd::Respond`의 어휘는 `accept: bool`이다. 실 CLI에는 값이 더 필요한 카드가 있다 — `AskUserQuestion`은 답을 **`deny` + `message`**로 되먹인다(`protocol-claude-cli.md` §4.4a). 그 2.6.2 파리티 본문을 셸이 만들고, 상태기계는 매칭·정착·`AskClosed`를 그대로 돈다. 안 세우면 기본 본문이라 기존 동작 무변경 |

### 3.4 `ChatStatusLite`의 주인 (§5.8)

전이마다 `lite::build()` → **바뀐 것만**(`updatedAt` 제외 비교) `ccg_store::status::set` +
`chat:status` REPLACE 방출. 디스크는 스토어의 500ms 디바운스 + 종료 flush(D15, `main.rs`).
`status`(2.6.2 `AgentStatus`)와 `bgActive`를 **따로** 싣는다 — "완료 색은 bg까지 걷혀야 한다"는
규칙을 표시 쪽이 다시 만들 수 있어야 하므로 여기서 미리 합치지 않는다.

`hold` 요약의 키 이름은 `ccg_store::status::truth_from_chat_file`과 같게 맞췄다(`resetAt`/`ready`).
어긋나면 규약 3("채팅 파일이 이긴다")이 매 틱 발동해 화면이 깜빡인다.

---

## 4. 채널 인벤토리 — 배선 / 미배선

### 4.1 3.0 코어 32채널 (`ux-chat-unify` §6.1)

| 묶음 | 채널 | 상태 |
|---|---|---|
| 실행 8 | `chat:run` `chat:interrupt` `chat:cancel` `chat:permission` `chat:answer` `chat:respond-dialog` `chat:bg-task` `chat:dispose` | **8 배선**(`chat:bg-task`는 명령만 — 원장의 bg 항목 자체는 프레임 미배선, §4.3) |
| 정체성·큐·원장 5 | `chat:identity-get/set/revert` `chat:queue-mutate` `chat:force-settle` | **5 배선**(`queue-mutate`는 `restore`만 전용 명령, 나머지 op는 `Cmd::QueueMutate` 하나로) |
| 스토어 4 | `chats:get/load/save/set-active` | 4 (M2 배선 — 이번 라운드 무변경) |
| 보드 3 | `board:get/load/save` | 3 (M2 배선) |
| 창 자리 4 | `win:chat-open/close/focus/list` | **미배선** — 2.6.2 `session-wins:*`가 그 자리를 대신한다 |
| 이벤트 8 | `chat:event` `chat:identity` `chat:queue` `chat:run-state` `chat:verdict` `chat:status` | **6 배선** |
| | `chat:windows` `chat:flush-req` | **미배선**(각각 `session-wins:changed` / 렌더러 자체 저장으로 대체 중) |

**26 / 32.**

### 4.2 과도기 별칭(2.6.2 표면) — 이번 라운드 신규

| 표면 | 채널 | 주소 |
|---|---|---|
| 본채팅 | `claude:run/cancel/interrupt/permission-respond/question-respond/bg-task` (6) | `active_chat_id()` |
| 추가 채팅 창 | `session:…` 같은 6개 | 창 라벨 → 채팅(`win.rs chat_for_label`) |
| 멀티 패널 | `ma:run/cancel/interrupt/permission-respond/question-respond/bg-task/dispose` (7) | `panelId`(`<boardId>::<slot>`) → 보드 slot 역인덱스 |
| 이벤트 | `engine:event` · `session:event` · `ma:event` 팬아웃 (3) | 채팅 → 창 역인덱스 |

**19 명령 + 3 이벤트.** `btw:open` · `ma:panel-*` · `talk:*`(은퇴) · Codex(app-server)는 미배선
— 전부 M1의 안전값(빈 목록/no-op) 그대로다.

### 4.3 `EngineEvent` 23종 중 **14종** 배선

배선: `status` `session` `assistant-stream` `assistant-done` `thinking` `tool-start` `tool-end`
`permission-request` `question-request` `result` `context` `notice` `compact` `model-fallback`

미배선 9종: `thinking-clear` · `todos`(TodoWrite) · `file-change`(디프) · `terminal`(Bash 실시간) ·
`subagent` · `bg-tasks` · `bg-task-end` · `workflow` · `error`.
`result`의 `tokenUsage`·`contextWindow`는 `null`로 나간다.
전부 **"이벤트를 안 낸다"**이지 **"틀린 값을 낸다"**가 아니다 — 그 UI만 비어 있다.

### 4.4 알려진 구멍 (제품 쪽)

| # | 내용 |
|---|---|
| A | `activeChat()`의 진실 소스가 아직 **마지막 `chats:save`의 `activeChatId`**다. 렌더러가 `chats:set-active`를 안 부르므로(app/ 이번 라운드 금지) 저장 디바운스(400ms)만큼 낡을 수 있다 → "채팅 바꾸자마자 전송"이 남의 런타임에 붙을 수 있다. §6.2 U3이 요구하는 **렌더러 3곳 한 줄**이 다음 라운드 |
| B | 부팅 시 **큐·한도 대기 재장전**(§5.8 부팅 경로 2단계) 미배선 — 엔진에 큐/hold 로더가 없다. 재시작 후 자동 이어서는 아직 안 산다 |
| C | `allow_always`가 지금은 **1회 허용**과 같게 동작한다(`updatedPermissions` 미동봉) |
| D | 사이드체인(서브에이전트) 프레임은 버린다 |
| E | 영속된 추가 채팅을 **클릭해서 창을 되만드는** 경로는 여전히 없다(M2에서 넘어온 것) |

---

## 5. `CCG_UNIFIED_STORE` 기본값 전환 + 전환 후 게이트

### 5.1 전환

```rust
pub fn unified_store_enabled() -> bool {
    !matches!(std::env::var("CCG_UNIFIED_STORE").as_deref(), Ok("0") | Ok("false"))
}
```

**"0/false만 끔"**으로 판정한다 — 오타(`=yes`)로 조용히 꺼져 사용자가 옛 스토어에 새 대화를
쌓는 사고를 막는다. 마이그레이션은 옛 3디렉터리를 지우지 않으므로 `=0`으로 띄우면 2.6.2 포맷
그대로 돌아간다.

### 5.2 전환 후 재검증

| 게이트 | 결과 |
|---|---|
| `cargo test -p ccg-engine --offline` | **98 green** (lib 14 · frame_coverage 5 · identity_golden 11 · replay 27 · replay_standing 36 · zz_gate 5 / live_smoke 2 ignored) |
| `cargo test -p ccg-store --offline` | **54 green** |
| `critic-m2-semantics.mjs` | `ok:true · findings 0` |
| `critic-m2-tauri.mjs` (부모 env `CCG_UNIFIED_STORE=0`) | `ok:true · findings 0` · `flagOn.disk {chatsV3:7, boards:3, statusJson:true}` / `flagOff.disk {chatsV3:false, boards:false}` |
| `critic-m2-tauri.mjs` (env 없이 = 새 기본값) | `findings 1` — *"플래그가 꺼졌는데 통합 스토어가 생겼다"*. **이 하네스는 "꺼짐"을 env 생략으로 표현**한다(`boot(home,{flag:false})`가 아무 env도 안 준다). 전환의 정의상 나오는 값이고, 부모 env로 `=0`을 주면 두 팔이 원래 의미대로 돈다 |
| `scripts/poc-tauri-stores.mjs` | 정상 왕복(`chats 471 msgs` · `sidebarChats 2` · 미구현 채널 경고 7종은 M1 그대로) |
| `scripts/poc-tauri-chats.mjs` (`CCG_UNIFIED_STORE=0`) | 전 항목 종전값 — `unchangedAfterIdenticalSave:true` · `snapshotSurvives:471` · `newChatWritten.file:true` · `prunedRemovedChat:true` |
| `scripts/poc-tauri-chats.mjs` (새 기본값) | 3번만 `newChatWritten.file:false` — **하네스가 옛 주소(`chats/`)를 본다.** 아래 프로브로 데이터 유실이 아님을 확인 |
| `scripts/poc-live-chat.mjs` | **PASS · 결함 0** (§1·§2) |

> **`newChatWritten` 확인 프로브**(임시, 실행 후 삭제): 기본값으로 띄워 `chats:save`에 새 채팅을
> 얹고 `chats-v3/`를 100ms 간격으로 관측했다 —
> `t=0~400ms: [fix-long-thread.json, index.json, probe-new.json, status.json]` → `t=500ms`에
> `probe-new.json`이 **사라진다.** 지운 것은 렌더러의 디바운스 자동저장이다(자기 목록에 없는
> 채팅 = 지운 채팅 → D2 prune). 레거시 팔에서도 같은 일이 일어나고, 하네스가 400ms에 보기 때문에
> 못 볼 뿐이다. **쓰기는 정상**이고, 같은 시나리오를 Rust 단위로 재현하면 새 채팅이 남는다.

### 5.3 주 게이트 — `node bench/multi.mjs tauri --repeats=3` (같은 바이너리 A/B)

| 지표 | R1 크리틱 | R2 빌더 | R8 크리틱 | **켬(새 기본값)** | **끔(`=0`)** |
|---|---|---|---|---|---|
| idleGrid WS MB | 426.8 | 421.7 | 418.6 | **431.3** | **418.7** |
| idleGrid Priv MB | 241.6 | 238.4 | 237.0 | **247.2** | **235.8** |
| idleGrid procs | 5 | 5 | 5 | **5** | **5** |
| idleWithWindows WS / Priv | 473.7 / 250.8 | 469.5 / 248.3 | 468.0 / 247.4 | **476.2 / 255.3** | **470.1 / 247.1** |
| wsMB/window | 23.4 | 23.9 | 24.7 | **21.8** | **25.6** |
| procsAdded | 0 | 0 | 0 | **0** | **0** |
| scrollInPanel avgFps / p95 / drop% | 57.7 / 22.6 / 0 | 56.8 / 22.3 / 0 | 59.1 / 19.1 / 0 | **58.0 / 20.5 / 0** | **58.4 / 22.7 / 0** |
| scrollAllPanels avgFps / p95 / drop% | 59.4 / 17.4 / 0 | 59.4 / 17.0 / 0 | 59.6 / 17.8 / 0 | **59.7 / 17.0 / 0** | **59.4 / 17.1 / 0** |

켬 팔의 회차별 원값: WS `432.7 / 426.9 / 431.3`, Priv `249.1 / 243.9 / 247.2`(중앙값을 표에 실었다).

**읽는 법(사실만)**:

- **스크롤은 어느 팔에서도 회귀가 없다**(드랍 0, 3/3 회차).
- 유휴 메모리는 켬 팔이 끔 팔보다 **WS +12.6MB · Priv +11.4MB** 높다. 두 팔은 **같은 exe · 같은
  세션 · 같은 3회**라 차이의 원인은 **통합 스토어 경로**다(부팅 마이그레이션 + `chats-v3` 팬아웃
  캐시 + 별칭 투영). **엔진 글루는 양쪽에 다 링크돼 있고 유휴에는 런타임이 0개**라, 끔 팔이
  R8 크리틱 기준선(418.6 / 237.0)과 같다는 것이 그 증거다.
- 기준 밴드(R2 빌더 421.7 / 238.4)와 비교하면 켬 팔은 **+9.6 / +8.8MB**다.

---

## 6. 재현

```bash
cargo test -p ccg-engine --offline          # 98 green
cargo test -p ccg-store  --offline          # 54 green
npm run tauri:build                         # 릴리즈 exe (cargo build 단독 금지)

node scripts/poc-live-chat.mjs              # 세로 조각 + R8-1 (게이트)
node scripts/poc-live-chat.mjs --only=r81   # CLI 없이 R8-1만
#   결과: docs/critic/m3-r2-live.json

node docs/critic/tools/critic-m2-semantics.mjs
CCG_UNIFIED_STORE=0 node docs/critic/tools/critic-m2-tauri.mjs   # ★ 두 팔을 원래 의미로
#   ※ 이 하네스는 %TEMP%\ccg-critic-m2-app.exe 를 **캐시로 재사용**한다.
#     새 빌드를 재려면 먼저 target/release/agentcodegui.exe 를 그 자리에 복사할 것
#     (안 하면 낡은 바이너리를 잰다 — 내 1차 주행에서 실제로 밟았다).
node scripts/poc-tauri-stores.mjs
CCG_UNIFIED_STORE=0 node scripts/poc-tauri-chats.mjs             # 2.6.2 스토어 팔
node bench/multi.mjs tauri --repeats=3                           # 켬(기본값)
CCG_UNIFIED_STORE=0 node bench/multi.mjs tauri --repeats=3       # 끔 대조군
#   ※ bench/results/multi-tauri-3.0.0-default.json 은 추적 대상 — 확인 후 git checkout
```

---

## 7. 남은 것 (다음 라운드 후보)

1. **렌더러 3곳 한 줄** — `chats:set-active` 호출(§4.4 A). 지금은 활성 채팅이 디바운스만큼 낡는다.
2. **부팅 재장전** — 큐·한도 대기(§4.4 B). 엔진에 로더가 필요하다(재생 #27이 잠근 규약).
3. **`EngineEvent` 9종**(§4.3) — 특히 `file-change`(디프)·`terminal`·`bg-tasks`가 화면 비중이 크다.
4. **창 자리 4채널 + `chat:windows`** — 영속 추가 채팅을 클릭해 창을 되만드는 경로가 여기 붙는다.
5. **유휴 +12MB의 출처 확정** — 팬아웃의 `cache: HashMap<id, 파일 원문>`이 후보다(§5.3).
   측정은 있고 원인 분해는 아직 없다.
6. Codex(app-server) 엔진 · `btw:open` 포크 · `allow_always`의 `updatedPermissions`.
