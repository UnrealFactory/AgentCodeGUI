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
| 4 | **스트리밍** | `assistant-stream` 델타 + 화면 텍스트 | 델타 **총 3**(4단계 폴링 시점엔 1 — 카드가 먼저 온다), 텍스트 `"I'll create the file with the exact content \"OK\".DONE"` |
| 5 | **승인 카드** | `.q-overlay .qcard` DOM | 헤더 `Claude의 승인 요청` · 도구 `Write` · 요약 `Write …\live-approve.txt` · 선택지 `[허용, 항상 허용, 거부]` |
| 5b | **영구 정지** | 무응답 3초 뒤 카드 생존 | `true` (타임아웃 없음 = `AwaitingUser`의 정의) |
| 6 | **완료** | `result` 이벤트 + **디스크의 파일** | `isError:false` · `text:"DONE"` · 파일 `live-approve.txt` 내용 `OK` · 턴 **6.9s** |
| 7 | **재시작** | 새 프로세스로 재부팅 → 디스크 + **화면** | `loadedMsgs:5` · `sessionId` 살아 있음 · DOM에 프롬프트·`DONE` 둘 다 |

**턴 1회의 회계**(`engine:debug`): `spawns:1 · exits:1 · state:Idle · queued:0` — 프로세스 누수 0.
**프레임**(`CCG_ENGINE_LOG` 덤프) 42개: `system/init 1 · system/status 2 · stream_event 31 ·
assistant 3 · control_request 1 · control_response 1 · user 1 · rate_limit_event 1 · result/success 1`.
(R2 초판은 `stream_event 34`라 적어 합이 45가 됐다 — 같은 줄의 "42개"와 모순이었다.
산출물 `m3-r2-live.json`의 값은 **31**이고 합이 42다. 크리틱 배선 R1 F9-⑴ 정정.)
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

> **★R2 — 이 목록은 R1 시점의 것이고 불완전했다.** 크리틱이 목록 **밖에서** 세 건을 더
> 찾았다(T22 미배선 · `session-wins:persist/hydrate/rename` · `request_user_dialog`) —
> 셋 다 "그 UI만 비어 있다"가 아니라 **"채팅이 굳는다/대화가 증발한다"** 였다.
> 갱신된 목록은 **§R2.8**이다. 아래 A~E는 R1 기록으로 남긴다.

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

> **★R2 — 이 표는 순차 A/B다.** 크리틱 §4가 그 방식의 점추정(`+12.6MB`)을 아티팩트로
> 판정했고, 대응 산출물도 레포에 없었다(두 팔이 한 파일을 덮었다 — §R2.5).
> **인터리브 5쌍 재측정은 §R2.10**이고 산출물은 팔별로 두 벌 커밋했다. 아래는 R1 기록이다.

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

> **★R2** — 갱신본은 **§R2.9**다. 아래는 R1 기록이다(5번은 크리틱이 **반박**했다 —
> 팬아웃 캐시는 +12MB의 원인이 아니고, 실 델타는 Rust ~2MB다).

1. **렌더러 3곳 한 줄** — `chats:set-active` 호출(§4.4 A). 지금은 활성 채팅이 디바운스만큼 낡는다.
2. **부팅 재장전** — 큐·한도 대기(§4.4 B). 엔진에 로더가 필요하다(재생 #27이 잠근 규약).
3. **`EngineEvent` 9종**(§4.3) — 특히 `file-change`(디프)·`terminal`·`bg-tasks`가 화면 비중이 크다.
4. **창 자리 4채널 + `chat:windows`** — 영속 추가 채팅을 클릭해 창을 되만드는 경로가 여기 붙는다.
5. **유휴 +12MB의 출처 확정** — 팬아웃의 `cache: HashMap<id, 파일 원문>`이 후보다(§5.3).
   측정은 있고 원인 분해는 아직 없다.
6. Codex(app-server) 엔진 · `btw:open` 포크 · `allow_always`의 `updatedPermissions`.

---

# §R2 — 배선 R1 크리틱 대응 (조건부 불합격 → 수정)

**대상 판정**: `docs/critic/wiring-r1.md` (조건부 불합격 · 치명 2건 E·F + F6·F8·F9·F10·F11 +
미배선 목록 밖 3건). 이 절도 §0~§7과 같은 규약이다 — **사실만**, 자기 채점 없음.

**측정 바이너리**: `target/release/agentcodegui.exe` — `npm run tauri:build`(직전 exe를
`rm -f` 후. os error 5 함정). **어느 주행이 어느 바이너리인지 정확히 적는다**:

| 바이너리(sha256 앞 16) | 무엇을 쟀나 |
|---|---|
| `2b4dd308afb39509` **(최종)** | 세로 조각 4단계(r81 · dialog · winsave · live) · 별칭 S1~S4 · **공격 E · F** |
| `4f29fbd54dacc332` | 공격 **A · B · C · D**. 최종본과의 차이는 `win.rs session_close` **한 곳**뿐이다 — 창 레지스트리에서 먼저 빼고 브로드캐스트하도록 순서를 고쳤다(사용자가 사이드바 X를 누르는 경로. A~D는 이 경로를 밟지 않는다) |
| `58897f1f2a0a51d2` | §R2.10 인터리브 A/B 10회 + 콜드/웜 프로브. 위 두 변경(`session_close` 순서 · 그 앞의 브로드캐스트 추가)이 아직 없는 판이고, **둘 다 벤치가 밟지 않는 사용자 조작 경로**다 |

**안전**: 이름 기반 kill 0회. 죽인 것은 (1) 내가 spawn한 PID 트리(`killTree`)와
(2) 크리틱 하네스가 `engine:debug`로 알아낸 **내 격리 홈의 자식 CLI pid**뿐
(E · F 주행마다 1개씩 — 최종 주행은 33548 · 16580). 사용자 실앱 6프로세스
(`%LOCALAPPDATA%\Programs\AgentCodeGUI\`)는 시작 · 종료 시 동일.
실홈은 읽기/복사만(engines=정션, 자격증명=복사). 크리틱 소유 파일
(`m2-r1-*.json` · `wiring-r1-{attacks,alias}.json`)은 실행 뒤 `git checkout`으로 원복했다.

---

## R2.0 한 장 요약

| 항목 | R1 | R2 |
|---|---|---|
| **E** 승인 카드 뜬 채 CLI kill | 실패 — 영구 정지 · 사유 0 | **green** — 카드 정착 5s 안 · 사유 문장 · `state idle` |
| **F** 스트리밍 중 CLI kill | 실패 — 영구 정지 | **green** — `state idle` · 다음 전송이 그대로 돈다 |
| A · B · C · D 재실행 | 통과(C는 병행 라운드에서) | **A · B · C · D 전부 green** |
| S1~S4 별칭 | S4 실패(저장 채널 없음) | **S1~S4 전부 green** |
| `request_user_dialog` | 이벤트 0 → 카드 없는 정지 | **질문 카드로 배선** + 응답 어휘 §4.4b(가짜 CLI 실증) |
| 추가 채팅 창 저장 | 3채널 `__unimplemented` | **persist/hydrate/rename 배선** + `chatId`에서 pid 제거 + 되만들기 |
| F6 `chat:verdict` 이중 | 명령마다 2건 | **런타임 한 곳으로** |
| F8 팬아웃 디스크 I/O | 이벤트마다 2종 | **틱 1회 캐시**(무효화 규약 3줄) |
| F10 `wait()` Resident | 두 갈래 다 20ms | **250ms**(유휴) |
| F11 중단 턴 = `Done` | 재시작 뒤 "완료" | **`Aborted` 어휘 신설** → `status.json`은 `idle` |
| 크레이트 테스트 | 98 / 54 | **104 green(+2 ignored) / 58 green** |
| 하네스 | 두 팔이 한 파일을 덮음 | `armName`에 `legacystore` — 팔별 산출물 2벌 커밋 |
| §5.3 메모리 | 순차 A/B `+12.6MB` 점추정 | **인터리브 5쌍 재측정**(§R2.10): total 중앙값 +9.9(쌍별 0.1~12.6) · **Rust +2.1**(쌍별 1.7~4.3) · 마이그레이션 1회 피크의 몫은 그중 **~0.5MB** |

---

## R2.1 T22 제품 배선 — 치명 2건(E·F)의 뿌리 하나

### 무엇이었나 (크리틱 §2-E/F · §6-1)

`ChatRuntime::stream_died()`(T22)의 **호출자가 재생 테스트 셋뿐**이었다. 제품 경로에는
진입점이 없었다 — `driver.rs poll_frames`가 `TryRecvError::Disconnected`(= stdout EOF)를
`break`로 **삼켰고**, 주석의 *"상위(T22)가 처리한다"* 는 그 상위가 존재하지 않았다.
그래서 CLI가 외부에서 죽으면 채팅이 **영구히 busy**였다. m-logic P8(유령 UI) 그 자체다.

### 수정 — 신호를 값으로 올리고, 상태기계가 스스로 밟는다

| 자리 | 무엇 |
|---|---|
| `driver.rs` `CliDriver::stream_eof()` | **새 trait 메서드**. 기본값 `None`(재생 드라이버는 EOF를 모른다 — 폴트는 여전히 `stream_died()` 직접 호출) |
| `driver.rs` `poll_frames` | `Disconnected`를 **삼키지 않는다**. `eof_at = Instant::now()` 래치 |
| `driver.rs` `stream_eof` | 종료 코드로 사유를 가른다: `0` → `CliExit` · `≠0` → `ExternalKill` · 종료가 아직 관측 안 되면 **700ms 유예 뒤 `Crash`**(EOF 자체가 이미 죽음이라 무한 대기 금지) |
| `driver.rs` `spawn` | EOF 래치 **리셋**. 안 하면 재스폰이 즉사한다 |
| `driver.rs` `process_alive` | `child.is_some() && eof_at.is_none()` — **`false`는 Dead 관측**이다(§5.4-b (0)). R1은 항상 `true`였다 |
| `runtime.rs` `tick()` | 프레임을 **다 소화한 뒤** `stream_eof()`를 본다(마지막 `result`가 EOF와 같은 틱에 올 수 있다) → `stream_died(cause)` |
| `runtime.rs` `timers()` | **`Streaming` · `AwaitingUser` 아크 신설**(R1은 아크가 아예 없었다 = 무한) |
| `runtime.rs` `next_deadline()` | 같은 아크를 실어 재생 하네스도 그 시각에 깨어난다 |
| `engine/tap.rs` | 신호를 그대로 통과(감싼 값이 제품에서만 사라지지 않게) |

**`AwaitingUser`의 무기한 계약은 안 깼다.** 새 아크의 발화 조건은
`프레임 90s 정지 AND !process_alive()` 이고, `process_alive()`는 **EOF를 봤을 때만** `false`다.
프로세스가 살아 있는 동안에는 이 아크가 아무것도 하지 않는다 — 승인 카드 무응답은
여전히 영구 대기다(세로 조각 5b가 매 주행 확인한다). 아크의 역할은 **T22 신호가 유실됐을
때의 두 번째 그물**뿐이다(m-logic §5.4-b (0) "T22가 유실됐을 때의 백스톱").

### 정착을 화면으로 (`engine/wire.rs` + `engine/hub.rs`)

정착 자체는 이미 `StreamGuard::drop`이 사유와 함께 했지만, **얼려 둔 2.6.2 렌더러에는
그 사유를 읽는 구독자가 없었다**. 카드를 닫는 이벤트는 `result` 하나뿐이고
(`session.ts:933` `pendingPermission: null`), busy를 내리는 것은 종결 `status`다. 셋을 만든다:

1. `Event::Settled` → 허브가 모아 **`chat:run-state.settled[]`** 에 싣는다(R1은 이 배열이
   **항상 비어 있었다** — 엔진은 항목마다 따로 내고 REPLACE는 그 뒤에 오는데 잇는 코드가 없었다).
2. `Event::Exit{cause}` → `wire.stream_closed(cause, n)`이 **`notice`**(사유 한 줄)와,
   CLI가 `result`를 못 보내고 죽었을 때만 **합성 `result`**(`isError:true`)를 낸다.
   카드 해제 · 도구 스피너 정착 · 컴포저 해제가 이 하나에 달려 있다.
3. 사용자 의사로 닫힌 경로(`AllClear` · `Cancelled` · `AppQuit`)와 재스폰
   (`IdentityChanged` · `ThreadChanged`)은 **여기 오지 않는다** — 각자 자기 안내가 이미 있다.

### 실측 — `node docs/critic/tools/critic-wiring-live.mjs --only=E,F`

```
[E] 승인 카드 뜬 채 CLI kill        PASS  E-정착 {"afterSec":0,"state":"idle"}   E-사유
    killed pid 33548 (engine:debug가 알려 준 자식 하나) · pidStillAlive:false
    첫 5s 샘플     card:false · working:false · state:"idle" · live:0
    settled        [{id:"toolu_01XHL7g1…", kind:"running_tool", reason:"stream_closed:externalkill"},
                    {id:"38123927-…",      kind:"ask_card",     reason:"stream_closed:externalkill"}]
    chat:status    {status:"error", busy:false, ask:"none"}
    notice         "엔진(CLI)이 외부에서 종료됐어요 — 진행 중이던 표시 2개를 정리했어요.
                    다시 보내면 새 프로세스로 이어집니다."
    result         있음(합성) · engine:debug spawns 1 / exits 1

[F] 스트리밍 중 CLI kill            PASS  F-정착 {"state":"idle","sec":5}
    killed pid 16580 · pidStillAlive:false
    첫 5s 샘플     state:"idle" · busy:false · composerDisabled:false
    notice         "엔진(CLI)이 외부에서 종료됐어요. 다시 보내면 새 프로세스로 이어집니다."
    사이드바        ["sb-item active"]   ← 잠금 없음
    그 뒤 전송      "Reply with exactly: PING" → result "PING"   ← R1은 45s 타임아웃이었다
```

**A~D 재실행**(같은 하네스, `--only=A,B,C,D`) — 전 항목 초록:

```
[A] 소프트 중단   중단 마커 있음 · runStates starting→streaming→interrupting→terminating→idle
                 verdicts ["identity_set:noop","send:accepted","interrupt:accepted"]  ← 각 1건(F6)
                 chat:status {s:"idle", busy:false}   ← R1은 "done"이었다(F11 수정의 실측)
                 재개 result "RESUMED" · spawns 2/exits 2 · 잔존 CLI 0
[B] 승인 거부     tool-end {status:"error", result:"사용자가 거부했습니다."} · deny-me.txt 없음
                 카드 사라짐 · {s:"done", busy:false, ask:"none"}
[C] busy 중 전환  switched:true · locked 없음 · 활성 "c-b"      ← 병행 라운드의 렌더러 수정
[D] 강제 종료     kill 뒤 자식 CLI [] · 재시작 status [] · dot 실행색 아님 · 다음 턴 "ALIVE"
```

> **하네스 주의**: `--only` 없이 돌리면 `critic-wiring-live.mjs:44`가 **이전 주행의
> `findings`를 필터하지 않는다**(`!pick`이 참이라 전부 남는다). 그래서 전 항목이 초록인
> 주행도 파일의 `verdict`는 R1이 남긴 3건 때문에 `FAIL`로 찍힌다. 항목별 결과는 콘솔의
> 체크와 `attacks.*` 블록이 진실이다. 크리틱 소유 하네스라 고치지 않았다.

R1의 탈출구 문제도 같이 사라졌다: E의 후속 조작(카드 클릭 → 20s → Esc → 15s)은
셋 다 이미 `state:"idle"`인 상태에서 관측된다 — **누를 것이 남아 있지 않다.**

### 오프라인 증거 (돈 안 드는 회귀)

`cargo test -p ccg-engine` 안에 T22 진입점 자체를 잠그는 테스트를 넣었다
(`runtime.rs` `mod t22_tests` 4건 · `driver.rs` 2건):

| 테스트 | 무엇을 막나 |
|---|---|
| `stdout_eof_settles_the_ask_card_and_lands_idle` | 드라이버가 EOF를 올리면 `tick()`이 T22를 밟고 원장이 사유와 함께 빈다 |
| `eof_while_streaming_settles_too` | `RunningTool`도 같은 자리에서 거둔다 |
| `no_stream_no_t22` | 스트림 없을 때의 EOF는 아무것도 아니다(유령 정착 금지) |
| `interrupted_turn_is_aborted_not_done` | F11 — 중단 턴의 종결값 |
| `stdout_eof_becomes_a_close_cause` | **실 프로세스**(`cmd /c exit 0` · `exit 1`)로 EOF → 사유 분류 |
| `a_fresh_spawn_clears_the_eof_latch` | 재스폰이 앞 스트림의 EOF로 즉사하지 않는다 |

---

## R2.2 `request_user_dialog` — 카드 없는 영구 정지 제거

### 무엇이었나 (크리틱 §3)

상태기계는 T4로 `AwaitingUser`에 들어가는데(카드를 원장에 세운다) `wire.rs`는 **이벤트를
안 냈다**. 답할 채널(`chat:respond-dialog`)은 3.0 전용이라 얼려 둔 렌더러가 부르지 않는다.
결과는 §2-E와 같은 무한 busy이고, **사용자가 아무 이상한 짓도 안 했는데** 그렇게 된다.

### 수정

- `wire.rs`가 `request_user_dialog`를 **질문 카드**(`question-request`)로 번역한다 —
  2.6.2가 하던 그대로다(`engine.ts:930-1019`). 선택지는 `["<대상모델>로 계속", "중단"]`.
- 답은 질문 채널로 돌아온다. 원장은 그 카드를 `Dialog`로 알고 있으므로 `t5_respond`가
  `wrong_card_kind`로 튕긴다 — **옳은 가드다**(N16). 어긋남을 푸는 것은 **원장을 볼 수 있는
  셸**의 몫이라 `ChatRuntime::ask_kind_of(request_id)`를 열고 허브가 종류를 되맞춘다.
  응답 어휘도 질문과 다르다: `{behavior:'completed', result:'retry_fallback'}` /
  `{behavior:'cancelled'}` (§4.4b).
- 취소도 침묵하지 않는다(D7) — `"폴백을 취소했어요 — … 거부한 채로 턴을 마칩니다."`
- **엔진 버그 하나를 같이 고쳤다**: `t5_respond`의 폴백 대상 모델이 `tool_use_id`에서
  왔다(재생 픽스처의 합성 규약). 실 CLI의 그 값은 `toolu_…`라 **정체성의 모델이 도구 id로
  덮인다.** `AskInfo.fallback_model`(= `payload.fallbackModel`)을 우선으로 두고 픽스처
  규약은 폴백으로 남겼다.

### 실증 — 가짜 CLI로 **제품 경로 그대로** (0달러)

이 프레임은 모델이 응답을 거부해야 오므로 라이브로 강제할 수 없다. 그래서 하네스 전용
스텁 `ccg-fakecli`(`crates/ccg-engine`, **`--features fakecli`에서만 빌드** — `ccg-migrate`와
같은 규약)를 격리 홈의 엔진 자리에 꽂았다. spawn → stdout JSONL → 상태기계 → wire →
렌더러 카드 → 클릭 → stdin 응답까지 **전부 실제 배선**이고 모델만 가짜다.

```
node scripts/poc-live-chat.mjs --only=dialog
  D1-카드      {"opts":["sonnet로 계속","중단"],"state":"AwaitingUser"}
  D2-응답      {"behavior":"completed","result":"retry_fallback","toolUseID":"toolu_fake_1"}
               ← CLI stdin 바이트를 그대로 읽어 대조(스텁이 받은 줄을 파일로 남긴다)
  D3-진행      result "FALLBACK-OK" · 카드 사라짐
               banner "fable 이(가) 응답을 거부해 sonnet 로 전환했어요"
  D4-폴백리비전 identity.engine.model "sonnet" · revision 1
```

---

## R2.3 추가 채팅 창 — 대화 저장 · 복원 · 안정 id · 되만들기

### 무엇이었나 (크리틱 §5-S4)

R1이 `session:*` 6채널을 배선해 **그 창에서 실제로 대화가 돌기 시작했는데**, 렌더러가
부르는 저장 채널 셋은 셸에 상수조차 없어 `{__unimplemented:true}`였다:

```
session-wins:persist / hydrate / rename  → __unimplemented
    (SessionWindow.tsx:342 · :350 · :369가 실제로 부른다)
그 창의 chatId = format!("s-{}-{}", process::id(), n)   → 앱을 다시 켤 때마다 값이 바뀐다
```

즉 **"Ctrl+Shift+N → 대화 → 창 닫기 = 증발"** 이 이번 라운드에 새로 열린 유실 경로였고,
저장 채널만 만들어도 id 규약 때문에 재시작 뒤에는 못 찾았다.

### 수정 (5조각)

| 자리 | 무엇 |
|---|---|
| `win.rs` `mint_session_chat_id` | `sc-{unix_ms}-{n}` — **pid 제거**. 재시작 생존이 계약이다 |
| `ipc/mod.rs` + `ipc/windows.rs` | 3채널 배선. 주소는 **부른 창**(`session_chat_for_window`)이 1순위 — 메인 창으로 오면 활성 채팅으로 **폴백하지 않는다**(그러면 추가 채팅 저장 한 번이 본채팅을 덮는다). 2순위는 페이로드의 명시 `id`인데 **그것이 이미 영속된 추가 채팅일 때만** |
| `ccg-store` `chats_v3::upsert_chat` / `remove_chat` | **레코드 하나만** 쓰고 지운다. `write_chats`(목록 REPLACE)는 D2 prune이 붙어 있어, 창 하나의 저장이 그 경로를 타면 남의 대화가 통째로 사라진다 |
| `ccg-store` `legacy_bridge::session_chat_{persist,hydrate,rename}` · `is_session_chat` | 2.6.2 페이로드(`picker` · `cwd` · `refDirs`)를 정체성으로 흡수(D1 에코 판별 그대로), btw 시드 · `legacyAccount` 보존, `origin != session`인 레코드는 **거부** |
| `win.rs` `session_focus` / `session_close` | focus = 창이 없으면 **되만든다**(R1 §4.4-E가 "없다"고 적은 경로). close = **대화 삭제**(protocol.ts의 계약) + 그 채팅의 런타임 회수 |

`session-wins:rename`은 레코드에 `custom:true`를 세우고, 그 뒤 창의 **자동** 제목 보고는
레코드도 사이드바 표시도 덮지 못한다.

### 실증 — `node scripts/poc-live-chat.mjs --only=winsave` (가짜 CLI · 0달러)

```
W1-id        "sc-1787437625709-1"                       ← pid 없음
W2-턴        추가 채팅 창에서 실제 턴 1회(그 창 CDP로 컴포저 타이핑)
W3-저장      chats-v3/<id>.json {origin:"session", msgs:2, title:"창에서 보낸 질문",
                                 identity.cwd:"…\.poc-home-winsave\work"}
W3-격리      본채팅 c-main 메시지 1 그대로               ← 저장이 남의 칸을 안 건드린다
── 앱 종료 → 재시작 ──────────────────────────────────────────────────────────
W4-재시작목록 [{id:"sc-1787437625709-1", title:"창에서 보낸 질문", open:false}]
W5-복원      focus(id) → 창이 새로 뜨고 저장된 대화가 화면에 그려짐
W5-중복없음  목록에 같은 id가 두 번 뜨지 않는다
```

별칭 하네스도 같이 닫혔다 — `node docs/critic/tools/critic-wiring-alias.mjs`:

```
S1-unloaded  {chats:3, msgs:{c-1:6, c-2:7, c-3:8}}
S2-ma        패널 제목 반영 + 스냅샷 5/4 보존
S3           부팅 ["w-1","w-2"] → 열기 ["sc-1787437444254-1","w-1","w-2"] → 닫기 ["w-1","w-2"]
S4           persist:"true" · hydrate:"null"(메인 창엔 세션 채팅이 없다 — 정의대로) ·
             rename:"true" · report:"null" · w-1 메시지 3 → 2(보낸 스냅샷이 실제로 저장됐다)
```

오프라인 회귀는 `ccg-store` 4건(`legacy_bridge_tests.rs`):
`a_session_window_conversation_survives_persist_and_hydrate` ·
`persisting_one_session_window_does_not_prune_the_others` ·
`rename_wins_over_the_windows_auto_title` · `a_brand_new_session_chat_lands_in_the_index`.

---

## R2.4 나머지 결함 4건

| # | 무엇 | 수정 |
|---|---|---|
| **F6** | `chat:verdict`가 명령마다 **2번** 나갔다(글루 `emit_all` + `runtime.rs:541`의 무조건 방출) | 저자를 **런타임 하나**로. 글루는 호출자에게 돌려주기만 한다. 유일한 예외는 `ensure()` 실패(런타임이 없어 방출할 주체가 없다 — `cmd:"ensure"`) |
| **F8** | `fanout()`이 **이벤트마다** `chats-v3/index.json`(활성 채팅) + 보드 전수(`read_boards` → 캐시 `clear()` 후 재삽입)를 읽었다 | `RouteCache{active, panel}`. **무효화 규약 3줄**: (1) `pump()` 진입마다 버린다(수명 20ms 이하) (2) `handle()`이 잡을 처리하면 버린다(`chats:set-active` · `board:save`가 다른 스레드에서 갈아도 다음 이벤트는 새 값) (3) 캐시에 없으면 항상 스토어에 묻는다. 창 레지스트리는 메모리 `Mutex<Vec<_>>`라 캐시 대상이 아니다 |
| **F10** | `wait()`의 `Resident`가 **두 갈래 모두** `TICK_ACTIVE`(20ms)로 떨어졌다 | 한 갈래로 합쳤다 — 스트림 있음 20ms / 그 밖(`Idle` · `Resident`) 250ms / 런타임 0개 2000ms. `Resident`는 턴이 없고 타이머만 도는 상태라 프레임 지연 상한이 화면에 안 보인다 |
| **F11** | 중단으로 끝난 턴도 `TerminalStatus::Done` → `status.json`에 `done`이 남고 `load_boot`는 `done`을 안 내린다 = 재시작 뒤에도 "완료" | 어휘를 셋으로: `Done` / `Error` / **`Aborted`**. `land_turn`은 `interrupt_marker`를, `finish_termination`은 `Cancelled` · `HardCancel`을 본다. 2.6.2 와이어로는 `done`(중단 마커는 렌더러 로컬 리듀서가 이미 붙인다), **영속값(`ChatStatusLite.status`)은 `idle`** — "완료도 오류도 아니다"가 지금 낼 수 있는 가장 정확한 값이다. 공격 A의 `chat:status`가 R1의 `done`에서 **`idle`로 바뀐 것**이 그 실측이다 |

---

## R2.5 하네스 — 두 팔이 한 파일을 덮던 것

`bench/lib.mjs armName()`이 `CCG_UNIFIED_STORE`를 안 봐서 켬/끔 두 팔이 모두
`bench/results/multi-tauri-3.0.0-default.json`에 썼다(두 번째가 첫 팔을 지운다).
R3 크리틱 §9-2가 닫았던 결함이 새 플래그로 되살아난 자리다(크리틱 §4.4).

```js
if (env.CCG_UNIFIED_STORE === '0' || env.CCG_UNIFIED_STORE === 'false') parts.push('legacystore')
```

판정 규약은 `ccg_store::unified_store_enabled()`와 **같다** — "0/false만 끔". 오타(`=yes`)는
켬으로 읽히고 팔 이름도 그렇게 나온다.

```
armName({})                        → "default"
armName({CCG_UNIFIED_STORE:'0'})   → "legacystore"
armName({CCG_UNIFIED_STORE:'yes'}) → "default"
```

---

## R2.6 §2 수치 자기 불일치 2건 정정

| # | R1 표기 | 산출물(`m3-r2-live.json`) | 정정 |
|---|---|---|---|
| F9-(1) | 프레임 내역 `stream_event 34` (합 45 — 같은 줄의 "42개"와 모순) | `stream_event` **31** (합 42) | §2 본문 수정 |
| F9-(2) | "델타 **3~6**" | `steps.stream.deltas` = 1 · `finalDom.events['assistant-stream']` = 3. **6의 근거가 없다** | "델타 **총 3**(4단계 폴링 시점엔 1 — 카드가 먼저 온다)"로 수정 |

---

## R2.7 재현

```bash
cargo test -p ccg-engine --offline        # 104 green / 2 ignored
cargo test -p ccg-store  --offline        #  58 green
rm -f target/release/agentcodegui.exe && npm run tauri:build
cargo build -p ccg-engine --features fakecli --bin ccg-fakecli --release   # 가짜 CLI

node scripts/poc-live-chat.mjs            # r81 + dialog + winsave + live
node scripts/poc-live-chat.mjs --only=dialog    # 폴백 확인 카드만 (0달러)
node scripts/poc-live-chat.mjs --only=winsave   # 추가 채팅 창 영속만 (0달러)

node docs/critic/tools/critic-wiring-live.mjs --only=E,F   # 치명 2건(실 CLI · 소액 과금)
node docs/critic/tools/critic-wiring-live.mjs --only=A,B,C,D
node docs/critic/tools/critic-wiring-alias.mjs             # S1~S4 (CLI 불필요)

cargo build -p ccg-store --features cli --bin ccg-migrate --offline
node docs/critic/tools/critic-m2-semantics.mjs
cp target/release/agentcodegui.exe "$TEMP/ccg-critic-m2-app.exe"
CCG_UNIFIED_STORE=0 node docs/critic/tools/critic-m2-tauri.mjs
#   ※ 크리틱 소유 산출물(m2-r1-*.json · wiring-r1-*.json)은 실행 뒤 git checkout

# 주 게이트 — **인터리브 5쌍**(§R2.10). 순차로 돌리면 크리틱이 반박한 그 아티팩트가 다시 난다.
for i in 1 2 3 4 5; do
  node bench/multi.mjs tauri --repeats=1
  CCG_UNIFIED_STORE=0 node bench/multi.mjs tauri --repeats=1
done
#   ★ armName 수정 덕에 두 팔이 자기 파일에 쓴다:
#     bench/results/multi-tauri-3.0.0-default.json     (켬)
#     bench/results/multi-tauri-3.0.0-legacystore.json (끔)
#   커밋된 두 파일은 위 5쌍의 perRun을 접어 중앙값을 다시 낸 것이다(interleaved 블록 참조).
```


---

## R2.8 알려진 구멍 — 갱신 (§4.4 대체)

**성격을 함께 적는다.** R1 목록의 마무리 문장(*"전부 '이벤트를 안 낸다'이지 '틀린 값을
낸다'가 아니다 — 그 UI만 비어 있다"*)이 독자에게 "미배선 = 무해"라는 인상을 준 것이
크리틱이 지목한 이 보고서의 가장 큰 서술 문제였다(§6). 그래서 칸을 하나 더 둔다.

| # | 구멍 | 결과의 등급 | 상태 |
|---|---|---|---|
| A | `activeChat()`의 진실 소스가 마지막 `chats:save`의 `activeChatId` — 렌더러가 `chats:set-active`를 안 부른다 | **틀린 주소**(전환 직후 전송이 남의 런타임에 붙는다) | **열림 · 렌더러 몫** |
| B | 부팅 시 큐·한도 대기 **재장전** 미배선(§5.8 부팅 경로 2단계) | 기능 미동작(재시작 후 자동 이어서가 안 산다) | 열림 · 엔진에 로더 필요 |
| C | `allow_always`가 1회 허용과 같게 동작(`updatedPermissions` 미동봉) | 조용한 축소(매번 다시 묻는다) | 열림 |
| D | 사이드체인(서브에이전트) 프레임은 버린다 | **빈 UI**(서브에이전트 말풍선 없음) | 열림 |
| E | 영속된 추가 채팅을 클릭해 창을 되만드는 경로 | 도달 불가 | **닫힘(R2.3)** |
| F | **T22 미배선** — 외부 CLI 사망 미탐지 | **채팅이 영구히 굳는다**(P8) | **닫힘(R2.1)** |
| G | **`session-wins:persist/hydrate/rename` 없음** | **대화 증발** | **닫힘(R2.3)** |
| H | **`request_user_dialog`에 카드 없음** | **채팅이 굳는다**(kill 없이도) | **닫힘(R2.2)** |
| I | busy 중 채팅 전환이 침묵 no-op(m-logic P7) | **막힌 조작 + 사유 0** | **닫힘 — 병행 라운드의 렌더러 수정**(공격 C가 `switched:true`로 실측) |

### 렌더러 몫 (이번 라운드 `app/` 금지 — 목록만)

| # | 무엇 | 왜 렌더러인가 |
|---|---|---|
| R1 | `chats:set-active` 호출 3곳 | 위 A. 셸은 이미 채널을 갖고 있고 즉시 반영한다 |
| R2 | **폴백 확인 전용 카드 + `chat:respond-dialog`** | 지금은 셸이 질문 카드로 접어 그린다(2.6.2 파리티). 원래 계약면은 카드 종류가 셋이다(m-logic §5.6 `ask.askKind`) |
| R3 | **`chat:run-state.settled[]`를 읽는 UI** | 셸이 사유(`stream_closed:externalkill` · `watchdog:none` · `notify_timeout` …)를 실어 보내는데 읽는 쪽이 없다. m-logic §5.2 표시 규약(*"`Completed`만 완료, 나머지는 '정리됨' + 사유 부제"*)이 아직 화면에 없다 — 지금은 셸이 만든 `notice` 한 줄로 대신한다 |
| R4 | `TerminalStatus::Aborted`를 아는 표시 | 셸은 `idle`로 접어 보낸다(2.6.2 어휘에 자리가 없다). 사이드바 점이 `done`/`idle` 같은 색이라 지금은 안 보이지만, "완료 색은 진짜 완료일 때만"의 단일 소스가 되려면 어휘가 필요하다 |
| R5 | `chat:status`만 구독하는 화면의 첫 그림(F12) | `engine::boot()`이 첫 REPLACE를 창이 생기기 **전에** 쏘고 전이가 없으면 다시 안 쏜다. 지금은 `chats:get`이 `statuses`를 합쳐 줘서 무해하다 |

---

## R2.9 남은 것 (다음 라운드 후보) — §7 대체

1. **부팅 재장전** — 큐 · 한도 대기(§5.8 부팅 경로 2단계). 재생 #27이 잠근 규약인데 로더가 없다.
2. **`EngineEvent` 9종** — `thinking-clear` · `todos` · `file-change`(디프) · `terminal` ·
   `subagent` · `bg-tasks` · `bg-task-end` · `workflow` · `error`. **전부 "그 UI만 비어 있다"** 등급이다
   (정지·증발 등급은 이번 라운드에 셋 다 닫혔다). 화면 비중은 `file-change` · `terminal` · `bg-tasks` 순.
3. **창 자리 4채널 + `chat:windows`** — 이번 라운드는 `session-wins:focus` **한 채널의 의미를
   2.6.2와 같게** 채워 되만들기를 열었다(채널 수 불변). 팝아웃 · btw까지 통합하려면 그때 연다.
4. **F12** — `engine::boot()`의 첫 `chat:status`가 구독자보다 이르다(위 R5).
5. **워치독 ⑥ 능동 프로브의 라이브 관측**(O17) — 문서 · JSDoc 근거만 있고 실측이 없다.
   이번 라운드가 연 `Streaming`/`AwaitingUser` 백스톱도 **T22가 유실된 경우**를 위한 것이라
   정상 경로에서는 발화하지 않는다(= 라이브로 재본 적이 없다).
6. Codex(app-server) 엔진 · `btw:open` 포크 · `allow_always`의 `updatedPermissions`.
7. **유휴 메모리 ~2MB(Rust)** — §R2.10이 마이그레이션 1회 피크(~0.5MB)와 상시분(~0.9MB)으로
   쪼갰다. 더 줄이려면 **할당 프로파일러**가 필요하다(점추정은 잡음에 묻힌다).

---

## R2.10 §5.3 재측정 — 인터리브 5쌍 (순차 A/B 폐기)

크리틱 §4가 R1의 `+12.6MB`를 **순차 A/B의 아티팩트**로 판정했다(팔을 번갈아 돌면 같은
지표가 내려가고 쌍별 스프레드가 1.6~8.6MB). 그래서 §5.3 표를 **버리지 않고 다시 잰다** —
같은 바이너리(`exeSha256 58897f1f2a0a51d2` · `gitHead 4c2b587`)로, 팔을 **쌍 단위로 번갈아**
5쌍. 각 회차는 별도 프로세스(`--repeats=1`)이고, `armName` 수정 덕에 두 팔이 **자기 파일에**
쓴다.

산출물: `bench/results/multi-tauri-3.0.0-default.json`(켬) ·
`bench/results/multi-tauri-3.0.0-legacystore.json`(끔). 둘 다 `interleaved` 블록과
`perRun` 5회분을 싣는다.

### 중앙값 (5회)

| 지표 | 켬(기본값) | 끔(`=0`) | Δ |
|---|---|---|---|
| idleGrid WS MB | **430.7** | **420.8** | +9.9 |
| idleGrid Priv MB | **246.4** | **237.5** | +8.9 |
| idleGrid procs | 5 | 5 | 0 |
| idleWithWindows WS / Priv | 475.2 / 252.1 | 470.4 / 248.5 | +4.8 / +3.6 |
| wsMB/window | 22.3 | 24.1 | −1.8 |
| procsAdded | 0 | 0 | 0 |
| scrollInPanel avgFps / p95 / worstDrop% | 58.9 / 19.6 / 0.3 | 57.9 / 23.2 / 0.3 | — |
| scrollAllPanels avgFps / p95 / worstDrop% | 59.0 / 18.5 / 0 | 59.6 / 17.0 / 0 | — |

### 쌍별 Δ (켬 − 끔) — 점추정을 못 믿는 이유가 여기 있다

| 쌍 | total WS | total Priv | **Rust(`agentcodegui.exe`) WS** |
|---|---|---|---|
| 1 | **+0.1** | +7.8 | +4.3 |
| 2 | +9.9 | +7.5 | +2.0 |
| 3 | +10.0 | +10.1 | +2.8 |
| 4 | +12.6 | +12.1 | +1.7 |
| 5 | +7.1 | +5.0 | +2.1 |
| **중앙값** | **+9.9** | **+7.8** | **+2.1** |

1쌍의 `+0.1`은 그 쌍의 **끔 회차가 431.2MB**로 혼자 튄 값이다(다른 끔 회차는 419~423).
콜드 WebView2 프로필이 첫 회차에 붙는다는 크리틱의 관찰과 같은 모양이다. 즉 **total의
쌍별 스프레드가 0.1~12.6**이고, 그 무대에서 어떤 점추정도 ±5MB 이하를 말할 수 없다.

반면 **Rust 프로세스 델타는 1.7~4.3(중앙값 2.1)로 재현성이 높다** — 크리틱 §4.3-3의
판정(*"실재하는 몫은 Rust의 ~2MB뿐"*)이 내 주행에서도 같다.

### 마이그레이션 1회 피크 가설 — **부분적으로만 맞다**

크리틱이 남긴 후보는 *"부팅 1회 마이그레이션이 남긴 할당(레거시 3스토어를 통째로 파싱)"*
이었다. 그것만이면 **두 번째 부팅**에서는 사라져야 한다 — `migrationComplete` 마커가
있어 마이그레이션 자체가 no-op이기 때문이다. 같은 홈으로 **콜드(1차) → 웜(2차)** 를 재고
팔을 짝지어 3회 반복했다(픽스처: 2.6.2 채팅 12 × 40메시지 + 패널 6 + 추가 채팅 3.
패널 격자를 안 그리므로 절대값은 주 게이트와 비교 대상이 아니다 — **쌍별 Δ만** 본다).

| | Rust WS Δ (쌍별) | 중앙값 | Rust Priv Δ 중앙값 | total WS Δ 중앙값 |
|---|---|---|---|---|
| **콜드**(마이그레이션 돎) | 1.1 · 1.3 · 1.7 | **+1.4** | +1.0 | +5.5 |
| **웜**(마이그레이션 no-op) | 0.9 · 1.1 · 0.5 | **+0.9** | +1.0 | **−0.9** |

읽는 법:

- **마이그레이션 1회 피크의 몫은 `1.4 − 0.9 ≈ 0.5MB`** 다. 가설은 맞지만 **절반 이하**다.
- 나머지 **~0.9MB는 상시**다 — 통합 스토어의 부팅 경로(`chats-v3` 팬아웃 캐시 · `status`
  맵 · 보드)가 계속 들고 있는 몫이고, 두 번째 부팅에서도 그대로다.
- **웜에서 total Δ가 −0.9로 뒤집힌다**(쌍별 2.4 · 1.6 · −1.1). Rust 밖의 델타는 **방향조차
  안정적이지 않다** = 팔의 차이가 아니라 잡음이다. 크리틱이 렌더러 JS 힙 Δ ≈ 0 · DOM Δ ≈ 0 ·
  페이로드 Δ ≈ 0으로 이미 같은 결론에 도달했다.

**따라서 이번 라운드는 메모리를 손대지 않았다.** 팬아웃 캐시는 후보가 아니고(크리틱
§4.3-1: 그 캐시의 상한은 `chats-v3` 디스크 크기 336KB이며 레거시 팔에도 같은 캐시가 있다),
실제 표적은 **~2MB 중 ~0.5MB(마이그레이션 잔여) + ~0.9MB(상시 구조)** 다. 이 크기는
지금 라운드의 치명 결함들보다 우선순위가 낮고, 손대려면 **할당 프로파일러**가 필요하다
(점추정으로는 잡음에 묻힌다 — 위 표가 그 증거다).

> **정직하게 남는 것**: 위 콜드/웜 표는 **주 게이트와 다른 픽스처**(패널 격자 없음)로 쟀다.
> 두 표의 절대값을 섞어 읽으면 안 된다. 같은 표 안의 쌍별 Δ만 의미가 있다.

---

# §R3 — 빈 UI를 채운다 (EngineEvent 9종 · 부팅 재장전 · 창 자리 4채널 · F12)

**범위**: `crates/ccg-engine`(재장전 API + 스펙 ⑤ 게이트) · `crates/ccg-store`(큐 본문 로더) ·
`src-tauri/src/engine/`(와이어 9종 + 디프 + 허브 잡) · `src-tauri/src/ipc/windows.rs` ·
`src-tauri/src/win.rs` · `scripts/poc-live-chat.mjs`
**출발점**: §R2.9 남은 것 1·2·3·4 (부팅 재장전 · `EngineEvent` 9종 · 창 자리 채널 · F12)
**규약**: 이 절도 §0~§7과 같다 — **사실만**, 자기 채점 없음. 판정은 크리틱 몫이다.

**측정 바이너리**: `sha256 de9567b55554a70f`. 게이트 주행 중 **다른 라운드가 같은 레포에서
`rm -f target/release/agentcodegui.exe && npm run tauri:build`을 돌려** 주행이 두 번 깨졌다
(ENOENT). 그래서 하네스에 `--exe=`를 열고 `%TEMP%`에 스냅샷을 떠 그것을 쟀다 — 최종 주행의
바이너리는 위 해시 하나다.

**안전**: 이름 기반 kill 0회. 죽인 것은 내가 spawn한 PID 트리(`killTree`)뿐. 사용자 실앱
6프로세스(`%LOCALAPPDATA%\Programs\AgentCodeGUI\`)는 시작·종료 시 동일. 실홈은 읽기/복사만
(engines=정션, 자격증명=복사). 크리틱 소유 산출물(`wiring-r1-attacks.json`)과 벤치 기준
결과(`bench/results/multi-tauri-3.0.0-default.json`)는 주행 뒤 `git checkout`으로 원복했다.
**R2의 산출물을 덮지 않으려고** 하네스 출력 경로를 `m3-r2-live.json` → **`m3-r3-live.json`**
으로 갈랐다(R2 §2가 그 파일을 인용한다).

---

## R3.0 한 장 요약

| 항목 | R2 | R3 |
|---|---|---|
| `EngineEvent` 배선 | 14 / 23 | **23 / 23** (§R3.1) |
| 3.0 코어 32채널 | 26 | **31**(`win:chat-*` 4 + `chat:windows`. 남은 1 = `chat:flush-req`) |
| 부팅 재장전(§5.8 2단계) | **없음** — "재시작 후 자동 이어서가 조용히 안 산다" | **배선 + 실증**(§R3.3) |
| 스펙 ⑤(보이는 자리만 자동) | 해당 없음 | **엔진 게이트로 구현**(`auto_resume`) · 실측 |
| F12(첫 `chat:status` 레이스) | 열림 | **Rust 몫 닫음**(§R3.5) — 렌더러 몫은 남는다 |
| 크레이트 테스트 | 104 / 58 | **108 green(+2 ignored) / 60 green** + `src-tauri` **14 신규** |
| 세로 조각 하네스 | 4단계 | **8단계**(events · error · reload · slots 추가) · **PASS 결함 0** |
| 크리틱 공격 A~F | green | **A~F green**(E는 2차 주행 — 1차는 모델이 Write를 안 골라 카드가 안 떴다) |
| 주 게이트 | 5쌍 중앙값 430.7 / 246.4 | 4회 **440.5 / 254.7**(§R3.7 — **귀속 불가**: 같은 바이너리에 다른 3라운드의 변경이 함께 들어 있다) |

---

## R3.1 `EngineEvent` 9종 — 무엇을 어떻게 옮겼나

원본은 2.6.2 `src/main/claude/engine.ts`다. 옮긴 자리는 `src-tauri/src/engine/wire.rs`
(+ 디프 계산은 새 파일 `engine/diff.rs`). **의도적으로 다르게 한 것**은 아래 표의 마지막 칸에 적는다.

| 이벤트 | 프레임 → 이벤트 | 2.6.2와 다른 점 |
|---|---|---|
| `thinking-clear` | 답변 텍스트 델타 / 완성 프레임의 텍스트·도구 블록이 생각 줄을 닫는다 | 없음. 도구 인자 스트리밍 구간의 `thinking`(도구별 라벨)도 같이 옮겼다 — 그게 없으면 `thinking-clear`가 닫을 것이 없다 |
| `todos` | `TodoWrite`(전량 REPLACE) · `TaskCreate/Update/List`(증분 누적) | 없음. **도구 행을 만들지 않는다**(패널 전용 도구) |
| `file-change` | `Write`/`Edit`/`MultiEdit`의 **성공한** `tool_result` | 없음. **런 기준선 대비 전체 파일 누적 디프** · `whole:true` · LF 정규화 · 거대 파일 요약 행까지 같다. LSP 통지만 소비자가 없다(§R3.8) |
| `terminal` | `Bash` 도구 시작 = `cmd` 줄, 결과 = `out`/`err` 줄 + `✓ 완료` | 없음(200줄 상한 포함) |
| `subagent` | `Task`/`Agent` 스폰 · **사이드체인** 내레이션/모델 · `tool_result` · 백그라운드 정착 통지 | 없음 |
| `bg-tasks` | `system/background_tasks_changed` — **셸 계열만** 목록에 싣는다 | 없음. `outputFile` 유도 규칙(`%TEMP%\claude\<cwd슬러그>\<session>\tasks\<id>.output`)도 같다 |
| `bg-task-end` | `system/task_notification` | 없음(`byUser` · `atTurnEnd` 포함) |
| `workflow` | `system/task_progress`의 `workflow_progress`(전체 스냅샷 REPLACE) + 정착 통지 | **정착 방출을 미루지 않는다.** 2.6.2는 유휴 상주의 정착을 `wfSettledEmits`로 미뤄 `result`보다 앞세웠는데, 3.0은 펌프가 **① 와이어 이벤트 → ② 상태 이벤트** 순서라 순서가 구조로 보장된다 |
| `error` | 스트림이 **깨져서** 닫힌 경우(`SpawnFailed` · `Crash`) | 2.6.2는 실행 루프의 예외였다. 3.0의 같은 등급은 이 둘이고, 그때는 **안내(`notice`) 대신** 오류 말풍선을 낸다(말을 두 번 하지 않는다) |

### 순서 규약 둘 — 여기서 지킨 것

**① `bg-tasks`는 REPLACE, 상세는 그 뒤.** `background_tasks_changed`는 *살아 있는 목록 전체*다.
렌더러는 목록에서 빠진 실행 중 작업을 종료로 접고, 상태·요약은 뒤따르는 `bg-task-end`가 채운다
(`protocol.ts:409-415`). 와이어는 프레임 도착 순서를 그대로 지키기만 하면 되고, 실측이 그렇다:
`bg-tasks [bg-1]` → `bg-tasks []` → `bg-task-end{bg-1, completed}`.

**② 스트림이 닫히면 전부 정착한다 — 고아 알약 금지.** CLI 프로세스가 죽으면 그 안에서 돌던
워크플로 · 셸 · 서브에이전트도 **전부** 죽는다. 통지가 못 온 것을 손수 거두지 않으면 도는 알약이
화면에 영원히 남는다(m-logic P8의 백그라운드 판). `wire::settle_all_background()`가
`stream_closed`의 **첫 줄**에서 그 셋을 낸다: running 워크플로 → `stopped` · 남은 셸 →
`bg-task-end{stopped, atTurnEnd}` · 빈 `bg-tasks` REPLACE · 살아 있던 서브에이전트 → `done`.
오프라인 회귀가 잠근다(`a_running_workflow_never_survives_the_stream_close`).

### 사이드체인 조기 분리 (메모리 「사이드체인 모델 프레임 + 폴백 확인 카드」)

`translate()`의 **첫 줄**에서 가른다(`parent_tool_use_id` **또는** `subagent_type`).
그 프레임이 메인 경로에 닿으면 네 가지가 깨진다 — ① 모델 전환 배너 핑퐁 ② 게이지 오염
③ 내레이션이 메인 말풍선에 섞임 ④ `cur_msg` 리셋으로 말풍선 쪼개짐. 하네스가 그 넷 중
측정 가능한 둘을 **실측으로 막는다**: 서브에이전트가 `usage.input_tokens: 999999`와
`model: claude-opus-5`를 보고해도 `context` 이벤트는 `[20]`(메인 값)이고 `model-fallback`은 **0건**.

---

## R3.2 실증 — `node scripts/poc-live-chat.mjs --only=events` (가짜 CLI · $0)

실 CLI로는 아홉을 한 턴에 강제할 수 없다(워크플로 · 백그라운드는 모델이 스스로 골라야 하고,
`error`는 엔진이 깨져야 온다). 그래서 `ccg-fakecli`가 그 프레임을 흘린다 — spawn → stdout
JSONL → 상태기계 → wire → 렌더러 → **DOM**까지 전부 실제 배선이고 모델만 가짜다.

단언은 **두 겹**이다: ① 렌더러가 받은 이벤트 ② 화면. 그리고 화면은 **구조를 알고** 재야 한다 —
할 일 · 서브에이전트 · 백그라운드 셸 · 변경 파일은 WorkBar의 **칩(개수)**이고 목록은 눌러야 뜨는
팝오버다(`Chat.tsx:3395`). 워크플로는 **실행 중에만** 있는 독이라 사후에는 없는 것이 정답이다.

```
이벤트   status 3 · session 1 · thinking 1 · thinking-clear 1 · assistant-stream 1 ·
         todos 1 · tool-start 2 · file-change 1 · tool-end 2 · terminal 3 · subagent 4 ·
         bg-tasks 2 · workflow 2 · bg-task-end 2 · assistant-done 1 · context 1 · result 1

file-change   {path:"r3-made.txt", add:2, tag:"new", whole:true, lines:3}
terminal      ["cmd","out","ok"]
bg-tasks      [["bg-1"], []]                     ← 워크플로(wf-1)는 셸 칩에 안 섞인다
bg-task-end   {id:"bg-1", status:"completed", summary:"R3-BG-DONE", atTurnEnd:false}
workflow      running{agents:["Opus 5.1/start"], phases:1, tokens:1234} → completed
subagent      running → running(model "Opus 5") → running → done
사이드체인     context [20] · model-fallback 0건  ← 999999 usage가 게이지에 안 섞였다

화면(칩)      할 일 0/2 · 서브에이전트 1/1 · 백그라운드 셸 1/1 · 변경된 파일 1
화면(목록)     todo→"파일 만들기" · sub→"Explore" · sh→"R3-BG-SHELL" · file→"r3-made.txt"
화면(워크플로) 실행 중 .wf-dock "R3-PHASE · 0/1"  →  정착 후 **없음**(고아 알약 0)
화면(스레드)   터미널 출력 · 답변 둘 다 있음
```

> **읽는 법**: `할 일 0/2`는 버그가 아니다 — 칩의 좌변은 **완료 수**이고 픽스처는
> `in_progress 1 + pending 1`이다. 1차 주행에서 내가 `1/2`를 기대해 실패로 찍었고,
> 화면 구조를 읽고 나서 기대값을 고쳤다.

`error`는 별도 단계다(`--only=error`). 스텁이 **아무 프레임도 안 내면** T3(20초 무응답)가
`SpawnFailed`를 만든다 — 상태기계의 `START_TIMEOUT`이라 줄일 수 없다.

```
events   status/analyzing → notice("엔진이 20초 안에 응답하지 않았어요") → status/error → error → result
error    {message:"엔진을 시작하지 못했어요."}
화면      오류 말풍선 **1개**(중복 없음) · 컴포저 · 스피너 해제
```

> **중복 하나를 여기서 없앴다**: 합성 `result`가 사유를 또 실으면 같은 문장이 빨간 말풍선
> 두 벌로 뜬다(`session.ts:1000` `rerr…`). 깨진 경로에서는 `result.text`를 **빈 문자열**로
> 둔다 — result 자체는 여전히 필요하다(카드 해제 · 스피너 정착 · 컴포저 해제가 거기 달려 있다).

---

## R3.3 부팅 재장전 (§R2.8-B 닫음)

### 엔진에 연 것 (`crates/ccg-engine/src/runtime.rs`)

| API | 하는 일 |
|---|---|
| `reload_state(queued, hold)` | 큐 본문과 대기표를 세운다. **드레인하지 않는다** — 앱을 켜는 것은 "보내라"가 아니다. 나가는 계기는 ① 사용자의 다음 전송 ② 한도 해제뿐이다 |
| `ReloadHold { in_ms, ready }` | `in_ms`는 **지금부터 남은 시간**이다(절대 시각이 아니다). 디스크의 `resetsAt`은 epoch 초, 런타임 시계는 프로세스 기동 기준 단조 ms — 두 축을 섞으면 대기표가 1970년으로 읽혀 **부팅이 곧 전송**이 된다 |
| `set_auto_resume(bool)` / `auto_resume()` | 스펙 ⑤. 기본 `true`(라이브 경로는 2.6.2와 같아야 하고 재생 시나리오 전부가 그 동작을 잠근다) |
| `resume_now()` | 사용자가 "이어서"를 눌렀다 — `ready`인 대기표를 지금 소진한다. 누른 것 자체가 "이 채팅은 이제 보고 있다"이므로 자동도 함께 켠다 |
| `hold_gate_open()` | 드레인 게이트를 `h.ready` → **`h.ready && auto_resume`**로. `ready`인데도 안 나가는 상태가 스펙 ⑤의 요구다. 자동이 켜져 있으면 옛 조건과 글자 그대로 같다 |

`check_hold`는 자동이 꺼진 채팅에서 `ready`만 켜고 **멈춘다**(+ 사유 한 줄). 대기표가 남으므로
사이드바가 "이어갈 수 있음"을 그릴 수 있고, 그 채팅의 **예약분도 혼자 나가지 않는다**.

### 스토어에 연 것

`ccg_store::status::read_chat_queue(id)` — `read_chat_lite`는 개수만 세려고 큐를
`IgnoredAny`로 건너뛴다. 본문이 필요한 쪽이 이것이다(2.6.2 문자열 배열과 `{text}` 객체 배열 둘 다).
후보 선정(`reload_candidates`)은 R2에 이미 있었고 호출자가 없었을 뿐이다.

### 셸 (`engine::reload_pending`)

```
boot() → status::load_boot(ids) → hub::start → reload_pending(ids) → chat:status REPLACE

reload_pending: 후보     = { chatId | hold != null ∨ queued > 0 }
                자동 범위 = boards::visible_chat_ids() ∪ { activeChatId }
                (부팅 시점에 추가 채팅 창은 하나도 없다 — 창 복원은 사용자 클릭이다)
```

### 실측 — `node scripts/poc-live-chat.mjs --only=reload` (합성 hold · 가짜 CLI · $0)

두 채팅을 심는다: `c-see`(활성 = 보이는 자리) · `c-hide`(화면 밖). 둘 다 예약 1건 +
**이미 지난** `resetsAt`(unix 초). 한도는 실제로 걸 수 없으므로 채팅 파일의 `hold`를 직접 심었다.

```
B1 재장전    c-see  {queued:1, queue:["예약 하나"], hold:{ready:false}, auto:true,  spawns:0}
             c-hide {queued:1, queue:["예약 둘"],  hold:{ready:false}, auto:false, spawns:0}
             ← 런타임은 섰고 **아무것도 안 나갔다**
B2 이어서    c-see  spawns 1 · hold null · queued 0 · 화면에 답변("R3-RESUMED") 도착
B3 화면 밖   c-hide hold {ready:true} · spawns **0** · queued 1 그대로
B4 눌러서    chat:queue-mutate {chatId:'c-hide', op:'resume'} → spawns 1 · hold null · auto true
```

> **정직하게 남는 것**: 재장전된 대기표는 **부팅 후 최대 90초 뒤**에 발화한다.
> §7.3의 재검증 지연(`due_at = resets_at + 90s`)을 재장전에도 그대로 걸기 때문이고,
> 저장된 reset 시각이 한참 전이어도 그렇다. 이건 "앱을 켜자마자 자동 전송"을 막는 바닥값이기도
> 하다(2.6.2 `resumeDelayMs`의 15초 하한과 같은 성격, 값만 다르다). 위 실측의 런타임 시계는
> 발화 시점에 **91.4초**였다.

### 오프라인 회귀 (`cargo test -p ccg-engine`, `mod reload_tests` 4건)

`reload_restores_the_queue_and_hold_without_sending_anything` ·
`a_released_hold_resumes_the_reloaded_queue` ·
`an_off_screen_chat_turns_ready_but_does_not_fire` ·
`resume_now_on_a_chat_without_a_ready_hold_is_a_rejection_not_a_send`.

---

## R3.4 창 자리 4채널 + `chat:windows`

`win:chat-open` / `close` / `focus` / `list` + `chat:windows`(REPLACE) — 배선 자리는
`src-tauri/src/ipc/windows.rs`다. **채널 이름 상수를 `ipc/mod.rs`의 `ch`가 아니라 그 파일에
둔 이유**: `mod.rs`는 지금 다른 라운드(M6 파일·Git 도메인)가 소유해 한 줄 추가도 충돌을 만든다.
문자열의 원본은 `src/shared/protocol.ts:1187-1198`이고 이 모듈이 유일한 소비자라 진실이 두 곳이 되지 않는다.

**의미가 하나 정반대다. 그 하나가 이 절의 전부다.**

```
session-wins:close  = 대화 **삭제** (protocol.ts의 옛 계약: "열린 창이 있으면 저장 없이 닫는다")
win:chat-close      = **창만** 닫기 (통합 모델: 자리는 뷰, 대화는 접힐 뿐 사라지지 않는다)
```

한 함수로 합치면 둘 중 하나가 반드시 대화를 잃는다 — `win.rs`도 `session_close` /
`chat_window_close`로 나눠 뒀다. `broadcast_sessions()`는 **둘 다** 낸다
(`session-wins:changed` + `chat:windows`) — 얼려 둔 렌더러는 앞의 것만 알고 3.0 화면은 뒤의
것만 안다. 원천이 하나라 어긋날 수 없다.

### 실측 — `--only=slots` (가짜 CLI · $0)

```
S1 list         []                                              (창 0개)
S2 open         {label:"session-1", chatId:"sc-1787441940052-1", title:"", focused:true}
S3 chat:windows 브로드캐스트 = ["sc-1787441940052-1"]            ← 저수준 listen으로 직접 구독
                (그 창에서 실제 턴 1회 — 대화 2줄)
S5 close        목록 0개 · **레코드는 남아 있다** {msgs:2, title:"자리 채널 검증"}
S6 focus        닫힌 자리를 클릭 → 창이 새로 뜬다(session-2) · 제목 · 대화 복원
S7 중복없음      같은 chatId로 다시 open → 창은 여전히 1개(앞으로 가져오기만)
```

`chat:flush-req`는 **여전히 미배선**이다(렌더러가 창 닫기 전에 자체 저장을 한다). 31 / 32.

---

## R3.5 F12 — 첫 `chat:status`의 Rust 몫

`engine::boot()`은 첫 REPLACE를 창이 생기기 **전에** 쏘고, 그 뒤로는 상태 전이가 있어야만
다시 쏜다. 유휴 앱에는 전이가 없다 → `chat:status`만 구독하는 화면은 영원히 빈 값으로 시작한다.

Rust 몫은 "구독 시 현재 상태 1회 송신"이다. Tauri에는 렌더러의 `listen`을 셸이 관측할 방법이
없으므로 **관측 가능한 가장 가까운 지점**인 `win:mounted`(splash.js가 `#root`에 자식이 생긴
순간 쏜다)에 건다. 마운트는 `useEffect` 구독보다 **이르므로** 400ms 뒤 한 번 더 보낸다 —
REPLACE라 두 번 받아도 무해하다. 창 자리 목록(`chat:windows`)도 같은 이유로 함께 보충한다.

> **정직하게 남는 것**: 이것은 레이스를 **좁힌** 것이지 없앤 것이 아니다. 완전한 해법은
> 렌더러가 구독 직후 스냅샷을 한 번 당겨 가는 것이고, `app/`은 이번 라운드 경계 밖이다.
> 그리고 지금은 `chats:get`이 `statuses`를 합쳐 주므로 이 구멍이 화면에 보이지 않는다.

---

## R3.6 하네스에서 찾아 고친 것 (제품 결함 아님 — 기록)

| # | 무엇 | 왜 중요한가 |
|---|---|---|
| H1 | `waitUntil(app, expr)`가 표현식을 `!!(...)`로 감싼다 — **Promise를 넘기면 항상 참**이라 기다리지 않고 지나간다 | 내가 "130초를 줬다"고 믿은 대기가 실제로는 **1.4초**였다(런타임 시계가 그렇게 찍혔다). 이런 하네스는 초록도 빨강도 의미가 없다 |
| H2 | `rmrf`가 EPERM에 죽는다 | 방금 죽인 앱의 WebView2가 핸들을 놓는 데 한 박자 걸린다 → 다음 단계의 씨앗 뿌리기가 통째로 죽었다. 재시도로 감쌌다 |
| H3 | exe 경로가 고정 | 같은 레포의 다른 라운드가 `rm -f … && npm run tauri:build`을 돌리면 주행 도중 exe가 사라진다(ENOENT 2회). `--exe=`를 열었다 |
| H4 | 산출물 파일이 `m3-r2-live.json` | R2 보고서가 인용하는 근거 파일을 덮는다. `m3-r3-live.json`으로 갈랐다 |

> 그리고 **하네스 홈 이름이 고정**(`.poc-home-*`)이라, 다른 라운드가 같은 하네스를 동시에
> 돌리면 서로의 격리 홈을 지운다(실제로 한 번 겹쳤다 — 상대 주행이 끝나기를 기다렸다).
> 고치지 않았다: 이름이 문서·보고서에 인용돼 있어 지금 바꾸면 추적성이 끊긴다.

---

## R3.7 게이트 주행 결과

| 게이트 | 결과 |
|---|---|
| `cargo test -p ccg-engine --offline` | **108 green** / 2 ignored (R2의 104 + `reload_tests` 4) |
| `cargo test -p ccg-store --offline` | **60 green** (R2의 58 + 큐 본문 · 재장전 후보 2) |
| `cargo test`(`src-tauri`) | **14 green** — `engine::wire` 9 + `engine::diff` 5 (신규) |
| `node scripts/poc-live-chat.mjs` (확장판 8단계) | **PASS · 결함 0** — `docs/critic/m3-r3-live.json` |
| `critic-wiring-live.mjs --only=A,B,C,D` | A · B · C · D **green** |
| `critic-wiring-live.mjs --only=E,F` → `--only=E` | F **green** · E는 **1차 실패 → 2차 green**. 1차는 haiku가 Write를 안 골라 승인 카드 자체가 안 떴다(공격 전제가 안 섰다). 2차: `E-정착 {afterSec:0, state:"idle"}` · 사유 *"엔진(CLI)이 외부에서 종료됐어요 — 진행 중이던 표시 2개를 정리했어요…"* |
| `node bench/multi.mjs tauri` | 아래 |

### 주 게이트 — 4회 (`--repeats=1` 1회 + `--repeats=3` 1회)

| 지표 | 회차별 | 중앙값(3회 세트) | R2 기준(5쌍 중앙값) |
|---|---|---|---|
| idleGrid WS MB | 438.7 · 452.1 · 440.5 · 434.5 | **440.5** | 430.7 |
| idleGrid Priv MB | 251.3 · 254.7 · 256.7 · 249.4 | **254.7** | 246.4 |
| idleGrid procs | 5 · 5 · 5 · 5 | **5** | 5 |
| idleWithWindows WS | 476.4 · 482.8 · 479.7 · 479.9 | **479.9** | 475.2 |
| wsMB/window | 18.8 · 15.3 · 19.6 · 22.7 | **19.6** | 22.3 |
| procsAdded | 0 (전 회차) | **0** | 0 |
| scrollInPanel avgFps / p95 / drop% | 58.8 · 59.9 · 58.7 · 58.7 / ≤20.6 / **0** | 58.7 / 20.6 / 0 | 58.9 / 19.6 / 0.3 |
| scrollAllPanels avgFps / p95 / drop% | 59.8 · 59.9 · 59.3 · 59.4 / ≤18.3 / **0** | 59.4 / 18.3 / 0 | 59.0 / 18.5 / 0 |

**읽는 법(사실만)**:

- **스크롤 회귀는 없다** — 4회 전부 드랍 0.
- 유휴 WS는 R2 기준보다 **+9.8MB** 높다. **이 델타를 이번 라운드에 귀속할 수 없다**:
  같은 바이너리에 **다른 세 라운드의 변경이 함께** 들어 있다(M-UX의 렌더러 4파일 ·
  M6의 `ipc/fs.rs` · `ipc/git.rs` + **새 크레이트 `ccg-fs` 링크** · 그 외). R2가 자기 델타를
  주장할 때 쓴 방법(같은 바이너리 인터리브 A/B)이 여기서는 성립하지 않는다 — 팔을 가를 플래그가 없다.
- 이번 라운드의 코드가 **유휴에 도는 경로는 없다**: 벤치 픽스처에는 hold · 큐가 있는 채팅이
  없어 `reload_pending`이 no-op이고, 런타임이 0개면 허브는 2초 틱(변경 없음)이다. 와이어 9종은
  **프레임이 흐를 때만** 돈다. 다만 이건 **논증이지 측정이 아니다** — 분해 측정은 §R3.9-4로 남긴다.

---

## R3.8 알려진 구멍 — 갱신 (§R2.8 대체)

| # | 구멍 | 결과의 등급 | 상태 |
|---|---|---|---|
| A | `activeChat()`의 진실 소스 | **틀린 주소** | **닫힘 — 병행 라운드의 렌더러 수정**(`unified.ts setActiveChat`) |
| B | 부팅 시 큐 · 한도 대기 재장전 | 기능 미동작 | **닫힘(R3.3)** |
| C | `allow_always`가 1회 허용과 같게 동작 | 조용한 축소(매번 다시 묻는다) | 열림 |
| D | 사이드체인 프레임을 버린다 | 빈 UI | **닫힘(R3.1)** |
| E~I | (R2에서 닫힘) | | 닫힘 |
| **J** | `result.tokenUsage` · `result.contextWindow`가 `null` | **빈 칸**(토큰 사용량 표가 비고, 게이지가 모델 기본 창으로 폴백) | 열림 |
| **K** | `tool-end.links`(WebSearch가 찾은 페이지) 미배선 | **빈 칸**(웹 행이 안 펼쳐진다) | 열림 |
| **L** | `chat:flush-req` 미배선 | 없음(렌더러가 자체 저장) | 열림 — 31/32 |
| **M** | `driver.spawn()`의 IO 오류를 **삼킨다**(`let _ = self.driver.spawn(...)`) | **20초 침묵**(`claude.exe`가 없으면 T3까지 아무 말도 없다) | 열림 — 이번 라운드에서 **발견만** 했다 |

### 렌더러 몫 (이번 라운드 `app/` 금지 — 목록만)

R2의 R2~R5 그대로 + 셋 추가:

| # | 무엇 | 왜 렌더러인가 |
|---|---|---|
| R6 | **구독 직후 `chat:status` 스냅샷 당겨 오기** | §R3.5. 셸이 마운트에 맞춰 두 번 쏘는 것으로 레이스를 좁혔지만, 없애는 것은 구독자 쪽 한 줄이다 |
| R7 | **`win:chat-*` · `chat:windows`를 쓰는 화면** | 셸은 4채널 + REPLACE를 다 낸다. 지금 그 값을 읽는 것은 하네스뿐이고, 화면은 여전히 `session-wins:*`를 쓴다 |
| R8 | **`ready` 대기표를 눌러 이어가는 UI** | 스펙 ⑤의 후반부. 셸은 `chat:queue-mutate {op:'resume'}`를 받고 `hold.ready`를 `chat:status`에 싣는다 — 누를 자리가 아직 없다 |

---

## R3.9 남은 것 (다음 라운드 후보) — §R2.9 대체

1. **렌더러 몫 R6~R8**(위 표) — 셸은 다 냈고 읽는 쪽이 없다.
2. **`result.tokenUsage` · `contextWindow` · `tool-end.links`**(J · K) — 전부 "그 칸만 비어 있다" 등급.
3. **`driver.spawn()` 오류 삼킴**(M) — 엔진 한 줄이면 20초 침묵이 즉시 안내로 바뀐다.
   이번 라운드에 안 고친 이유: 발견이 게이트 주행 중이었고, 상태기계의 종결 경로를 건드리는
   변경이라 재생 시나리오를 다시 봐야 한다.
4. **유휴 메모리 귀속** — §R3.7의 +9.8MB는 네 라운드가 섞인 값이다. 라운드별 분해를 하려면
   팔을 가를 수단(플래그 또는 라운드별 바이너리)이 먼저 필요하다.
5. **재장전 대기표의 90초 지연**(§R3.3) — 저장된 reset 시각이 한참 전이면 즉시 재검증하는 쪽이
   맞을 수도 있다. 지금은 안전한 바닥값으로 두었다. 바꾸려면 §7.3의 상수를 재장전 경로에서만
   가르는 규약이 필요하다.
6. `allow_always`의 `updatedPermissions`(C) · Codex(app-server) 엔진 · `btw:open` 포크.
7. **워치독 ⑥ 능동 프로브의 라이브 관측**(O17) — R2에서 그대로 남았다.

---

## R3.10 재현

```bash
cargo test -p ccg-engine --offline          # 108 green / 2 ignored
cargo test -p ccg-store  --offline          #  60 green
(cd src-tauri && cargo test --offline)      #  14 green (engine::wire · engine::diff)

rm -f target/release/agentcodegui.exe && npm run tauri:build
cargo build -p ccg-engine --features fakecli --bin ccg-fakecli --release   # 가짜 CLI

# 다른 라운드가 같은 레포에서 빌드를 돌면 주행 중 exe가 사라진다 — 스냅샷을 떠서 잰다
cp target/release/agentcodegui.exe "$TEMP/ccg-r3-snap.exe"
node scripts/poc-live-chat.mjs --exe="$TEMP/ccg-r3-snap.exe"   # 8단계 (게이트)
node scripts/poc-live-chat.mjs --only=events    # EngineEvent 8종 ($0)
node scripts/poc-live-chat.mjs --only=error     # error (T3 20초 · $0)
node scripts/poc-live-chat.mjs --only=reload    # 부팅 재장전 + 스펙 ⑤ ($0 · 약 100초)
node scripts/poc-live-chat.mjs --only=slots     # win:chat-* 4채널 + chat:windows ($0)
#   결과: docs/critic/m3-r3-live.json

node docs/critic/tools/critic-wiring-live.mjs --only=A,B,C,D
node docs/critic/tools/critic-wiring-live.mjs --only=E,F
#   ※ 크리틱 소유 산출물(wiring-r1-attacks.json)은 실행 뒤 git checkout

node bench/multi.mjs tauri --repeats=3
#   ※ bench/results/multi-tauri-3.0.0-default.json 은 추적 대상 — 확인 후 git checkout
```
