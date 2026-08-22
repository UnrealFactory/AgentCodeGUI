# M-LOGIC — 채팅/실행 상태 정리 (3.0.0 기반 설계) · **R2**

> **개정 R2 (2026-08-22)** — `docs/critic/design-r1.md` §2·§3·§4·§5 판정 반영.
> 무엇이 바뀌었는지는 **§12 크리틱 대응표**에 전수로 적었다. 요지 다섯:
> ① 주소는 `chatId` 하나(**`ChatRef` 삭제** — 리드 확정), ② **워치독 1차 리스를 프레임 최신성으로**
> 재설계(프로세스 생존은 Alive 근거에서 제외 — L2), ③ 전이표를 `protocol-claude-cli.md` §8.4
> **24행 전수 대응**으로 확장(L5), ④ 새로 만들던 버그 2건 제거 — 중단이 큐를 안 비우던 것(L1)과
> `deferred` 전체 교체가 폴백을 되돌리던 것(L3), ⑤ 인용 오류 정정(P1 필드 수·P5 허수 행·
> `effectiveStatus` 줄·LiveKind 출처).
>
> **성격**: 기능이 아니라 **기반**이다. M3(Claude 엔진)를 짜기 전에 이 문서가 닫혀 있어야 한다.
> 상태기계와 RunIdentity를 정하지 않고 엔진부터 만들면 2.6.2의 꼬임을 그대로 이식하게 된다.
>
> **목적**: 사용자 지적 — *"계정 변경하거나, 그냥 말할 때 뭔가 특수한 경우가 생기거나,
> 폴백돼서 모델이 바뀌거나 할 때 꼬이는 상황이 많다"* — 의 **구조적 원인**을 3.0에 옮기지 않는 것.
>
> **범위**: `crates/ccg-engine`(상태기계·정체성·라이브 항목 원장) + `src/shared/protocol.ts`
> 계약면 추가분 + 렌더러 쪽 소유권 규약. 코드는 이 문서에 포함하지 않는다(초안 타입만).
>
> **선행 문서**: `docs/protocol-claude-cli.md`(와이어), `docs/ARCHITECTURE-3.0.md`(경계),
> `docs/critic/m3-poc.md`(실증된 것/실증 안 된 것), `docs/HANDOFF-3.0.md` §M-LOGIC.
> **보조 문서**: `docs/design/m-logic-replay.md`(회귀 하네스 상세 — 8조합 시나리오 스크립트).

---

## 0. 한 장 요약

| 결정 | 한 줄 |
|---|---|
| **D1 RunIdentity** | 실행의 정체성을 **정규화된 값 하나**로 묶고, 재사용 판정은 그 값의 `==`(또는 16바이트 해시)로만. 필드가 늘어도 비교 로직은 그대로. |
| **D2 정체성 단일 소유** | 정체성의 진실은 **Rust `ChatRuntime` 하나**. 렌더러 picker는 브로드캐스트를 그리는 **뷰**. 렌더러가 몰래 바꾸는 경로 없음. |
| **D3 명시적 상태기계** | 스트림 1개 = 상태기계 1개. **수명 전이 36 + 프레임 소화 전이 22 = 58전이**, 9상태(+`Resident` 3변형). `protocol-claude-cli.md` §8.4 매핑표 **24행 전수 대응**(§3.7). 2.6.2의 암묵 규약(소프트 중단·무음 보류·통지 재주입·상주·5s 셸 유예·compact)이 전부 **표의 한 줄**로 존재. |
| **D4 설정 변경 = 명령** | `chat:identity-set` → Rust가 `applied` / `deferred(턴 끝)` / `rejected(사유)` 중 하나로 **판정을 돌려주고 브로드캐스트**. 예약분은 **정체성 전체가 아니라 패치**로 들고 착지에서 재정규화한다(폴백을 안 되돌린다 — §4.2). |
| **D5 예약 큐는 Rust 소유 + 정체성 동봉** | 큐 항목마다 `identity` 스냅샷. 드레인·한도 대기·재개가 **한 곳**에서 직렬화된다. **중단은 큐를 비운다**(2.6.2 파리티) — 단 조용히가 아니라 안내 + 되돌리기 토큰(§7.4). |
| **D6 폴백 = 보이는 상태 전이** | 엔진 자동 전환은 **정체성 리비전**을 만들고(origin=EngineFallback) 배너 + "되돌리기"를 준다. 신호 3경로는 **`fallback_armed` 하나로 합류** — 리비전·배너는 전환당 정확히 1개(§6.2). |
| **D7 침묵 no-op 금지** | 모든 명령은 `accepted` / `queued` / `rejected{reason}` 중 하나를 **반드시** 돌려준다. 표로 정의. |
| **D8 라이브 항목 원장** | UI에 "진행 중"인 모든 것은 **StreamId 소유**. 스트림이 죽으면 파생 항목 전부 **사유와 함께** 정착. 리스의 1차 근거는 **프레임 최신성** — 프로세스가 살아 있다는 사실은 리스를 재장전하지 못한다(§5.4). |
| **D9 사용자 조작 게이팅 금지** | **생사 관측이 가능한 항목만** 조작을 막을 수 있고, 막는 곳엔 항상 **강제 해제**가 있다. 사이드바 이동은 절대 막지 않는다. |
| **D10 재생 회귀 하네스** | 실와이어 프레임 + 가상 시계 + 폴트 주입으로 상태기계를 오프라인($0)에서 때린다. 필수 8조합 — R2 기준 **8/8 종이 재생 통과**(`m-logic-replay.md` §8). |

---

## 1. 병리 — 2.6.2에서 실제로 무엇이 깨지는가

전부 코드로 확인했다. 아래 P#는 이후 모든 설계 결정이 참조하는 번호다.

### P1. `optsMatch` = 손으로 비교하는 10개 필드

`src/main/claude/engine.ts:1185-1196`
(R1 초안은 "11개"라고 적었다 — **실 비교항은 10개**다: cwd·resume·model·mode·effort·useApi·
account·systemPrompt·addDirs·outputStyle. 크리틱 인용오류 #1 정정.)

```ts
const optsMatch =
  ncwd === cwd &&
  nreq.resume === bgSessionId &&
  nreq.model === req.model &&
  nreq.mode === req.mode &&
  nreq.effort === req.effort &&
  !!nreq.useApi === useApi &&
  (nreq.account ?? null) === (req.account ?? null) &&
  (nreq.systemPrompt?.trim() ?? '') === (req.systemPrompt?.trim() ?? '') &&
  JSON.stringify(nreq.addDirs ?? []) === JSON.stringify(req.addDirs ?? []) &&
  claudeOutputStyle() === outputStyle
```

- 필드가 늘 때마다 여기를 고쳐야 한다. `outputStyle`이 **뒤늦게 붙은 흔적**이 `engine.ts:51-55`
  주석에 남아 있다. 빠뜨리면 증상은 조용하다 — "옵션을 바꿨는데 예전 옵션으로 계속 돈다".
  **실제로 지금 네 개가 빠져 있다**(P1e — 아래).
- 정규화가 필드마다 제각각이다: `?? null`, `.trim()`, `!!`, `JSON.stringify`. 새 필드를 넣는
  사람이 이 규칙을 재발명한다. `addDirs`는 **순서만 달라도 불일치** → 불필요한 재스폰
  (= 살아있던 워크플로·셸·에이전트 전부 사망, `engine.ts:568-583`가 사후 안내만 한다).
- `nreq.resume === bgSessionId`가 **정체성과 대화 스레드를 한 비교에 섞는다.** 결과적으로
  "설정이 바뀌어서 새 프로세스"와 "다른 대화라서 새 프로세스"가 같은 사유(`'opts'`)로 뭉개진다.
- `claudeOutputStyle()`은 **비교 시점에 디스크를 읽는다** — 전역 pref다. 다른 채팅에서 스타일을
  바꾸면 이 채팅의 상주가 다음 메시지에 조용히 끊긴다.

### P1e. 스폰에만 정해지는데 `optsMatch`에 **없는** 축 4개 (크리틱 L7 — R2 신규)

"스폰 시점에만 정해진다"는 자기 기준으로 재면 아래 넷은 비교항에 있어야 하는데 없다.
전부 **조용한 오동작**이다 — 바꿨는데 상주가 옛 값으로 계속 돈다.

| 축 | 스폰 시점 결정 근거 | 증상 |
|---|---|---|
| **API 키 지문** | `engine.ts:762` `const apiKey = useApi ? getApiKey() : null` → `:894-895` `env:{…,ANTHROPIC_API_KEY: apiKey}` | 키를 갈아도 상주가 **옛 키로 계속 과금**된다 |
| **전역 env 키 확인 답**(`dropEnvKey`) | `engine.ts:846` `dropEnvKey = choice === 'sub'` → `:852` `delete subEnv.ANTHROPIC_API_KEY` (답은 **키 지문별** 저장) | 같은 상주 안에서 과금 경로가 어긋난다 |
| **`skillOverrides`** | `engine.ts:758` `disabledSkillOverrides()` → `:875` `settings.skillOverrides` | 설정에서 스킬을 껐는데 **안 꺼진다** |
| **`deniedMcpServers`** | `engine.ts:761` `deniedMcpServers()` → `:876` `settings.deniedMcpServers` | MCP 서버를 껐는데 **안 꺼진다** |

> 셋째·넷째는 P1의 "필드가 늘 때마다 손으로 고쳐야 한다"가 **실제로 실패한 증거**다.
> D1이 이 넷을 정체성 축으로 흡수한다(§2.2).

### P2. picker가 3벌 — 어느 게 진실인지 미정의

| 사본 | 위치 | 수명 |
|---|---|---|
| 렌더러 `useState` | `src/renderer/src/App.tsx:157` `const [picker, setPicker] = useState<PickerState>(DEFAULT_PICKER)` | 창 하나, 활성 채팅 1개분 |
| 채팅 파일 저장본 | `newChatMeta(manualCwd, picker, refDirs)`로 만들어 `chats.json`에 | 영속 |
| 실행 시점 `RunRequest` | `App.tsx:1059-1079`에서 매 전송마다 재조립 | 실행 1건 |

세 사본의 동기화 규약이 코드에 없다. `restore()`가 저장본→useState로 되싣지만, 그 사이에
엔진이 useState를 바꾸는 경로(P3)와 예약 큐가 옛 사본을 들고 있는 경로(P5)가 겹친다.

### P3. 폴백 = 엔진이 렌더러 picker를 뒤에서 바꾼다

`src/renderer/src/App.tsx:465-475`

```ts
window.api.onEngineEvent((e) => {
  if (e.type !== 'model-fallback') return
  …
  const next = pickerModelOf(e.toModel)
  if (next) setPicker((p) => (p.model === next ? p : { ...p, model: next }))
})
```

- 다음 턴의 `optsMatch`가 `nreq.model !== req.model`로 어긋나 **재스폰**된다 →
  살아있던 백그라운드 전부 사망 + 스레드에 "설정이 바뀌어…" 안내(`engine.ts:568-583`).
  사용자는 **자기가 바꾼 적이 없는데** 그 안내를 본다.
- 채팅 파일 저장본은 다음 `saveActive` 때 따라오지만, 그 사이 다른 채팅으로 갔다 오면
  되돌아온다(복원이 저장본을 읽으므로). **되돌리는 수단이 없다** — 폴백이 영구인지 일시인지
  사용자도 코드도 모른다.

### P4. 계정 변경 = 격리 CONFIG_DIR 물질화 + 재스폰인데 규약이 없다

- 계정은 `RunRequest.account`(`src/shared/protocol.ts:505`)로 **실행할 때** 정해지고,
  엔진이 `accountRunDir(email)`로 격리 `CLAUDE_CONFIG_DIR`을 물질화한다
  (`docs/protocol-claude-cli.md` §8.6).
- 그런데 **busy 중 picker에서 계정을 바꾸면**: 진행 중 턴은 옛 계정, 예약 큐 항목은
  `ScheduledMsg.picker`(`Chat.tsx:237-242`)의 **예약 시점 계정**, 새로 치는 메시지는 새 계정.
  세 개가 동시에 유효하고, **화면에는 하나만 보인다.**
- 턴 종료마다 `syncAccountTokens(accountEmail)`(`engine.ts:1819-1824`)이 도는데, 이게
  어느 계정 것인지도 위 셋 중 무엇으로 돌았느냐에 달렸다.

### P5. 예약 큐가 정체성의 **일부만** 스냅샷한다

`ScheduledMsg = { id, text, images, picker }` (`src/renderer/src/components/Chat.tsx:237-242`).
드레인은 `App.tsx:1104-1128` → `runPrompt(next.text, { picker: next.picker })`.
그런데 `runPrompt`(`App.tsx:989-1079`)가 `RunRequest`를 조립할 때:

| 필드 | 출처 | 예약 시점 값인가 |
|---|---|---|
| model·effort·mode·engine·account·codexModel·codexAccount | `pk = opts.picker` | ✅ |
| **cwd** | `let dir = cwd` (라이브) | ❌ |
| **addDirs** | `refDirs.filter(...)` (`App.tsx:1058`, 라이브) | ❌ |
| **useApi** | `apiMode` (라이브 전역) | ❌ |
| **outputStyle** | 메인이 디스크에서 읽음(`engine.ts:855`) | ❌ |
| **skillOverrides / deniedMcpServers / API 키 지문** | 메인이 스폰 시점에 읽음(P1e) | ❌ |
| resume | `state.session` (라이브) | ❌ (의도적) |

→ "예약할 때 보던 설정으로 나간다"가 **절반만 참**이다. 그리고 UI에는 예약 항목의 정체성이
표시되지 않는다.

> **R2 정정 (크리틱 인용오류 #2)**: R1 초안은 이 표에 `systemPrompt` 행("출처 = 채팅 메타(라이브)")을
> 넣었다. **허수였다.** `RunRequest.systemPrompt`(`protocol.ts:495`)는 렌더러 전 소스에 **세터가 0건**이고
> 소비처만 있다(`engine.ts:903-906`의 `systemPrompt.append`, `:1193`의 비교,
> `codex/engine.ts:1554`의 devNotes). 즉 2.6.2에서 이 필드는 **항상 undefined**이며
> "라이브로 새는 경로"가 존재하지 않는다. 행을 지우고, 대신 실제로 새는 P1e의 세 축으로 교체했다.
> (필드 자체는 3.0에서 채팅별 프롬프트로 **살릴 예정**이므로 `RunIdentity`에는 남긴다 —
> 다만 근거는 "2.6.2가 새고 있다"가 아니라 "스폰에만 정해지는 값이다"이다.)

### P6. 한도 자동 이어서 = 같은 상태를 만지는 별개 행위자

`src/renderer/src/lib/useLimitResume.ts` — 렌더러에 사는 두 번째 상태기계다.

- 장전 판정이 **스레드 마지막 말풍선의 텍스트**(`classifyLimitError(last.text)`)와
  `prev-busy` 에지에 의존한다. 상태가 아니라 **화면 내용**을 읽는다.
- 소유 키가 `activeChatId`(본채팅) — 채팅을 갈아타는 리듀서 하나 위에 얹혀 있다.
- 드레인 게이트가 훅 밖에 또 있다: `App.tsx:1118` `limitResume.holdRef.current?.key === activeChatIdRef.current`.
  `state`가 아니라 `ref`를 읽는 이유가 "같은 커밋에서 동기적으로 봐야 해서"라고 주석에 적혀 있다 —
  **두 행위자가 같은 전이에서 경합한다는 자백**이다.
- 창을 닫거나 채팅을 지우면 대기표가 증발한다(영속 안 함).

### P7. busy 중 사용자 조작 = 침묵 no-op

```ts
App.tsx:774  const createChat = … { if (busy || wfAlive) return   // 아무 반응 없음
App.tsx:799  const selectChat = … { if (id === activeChatId || busy || wfAlive) return
App.tsx:811  const deleteChat = … { if (id === activeChatId && (busy || wfAlive)) return
App.tsx:918  if (e.key !== 'Escape' || mode !== 'single' || (!busy && !wfAlive)) return
```

클릭했는데 아무 일도 안 일어난다. 이유도 안 보인다.

### P8. 고아 유령 — 실버그 (사용자 스크린샷)

대화가 끝났는데 워크플로 알약 "Critic · 1/2", "Build · 0/1"이 남아 UI가 잠긴다. 경로를 끝까지 짚었다:

1. `wfAlive`(`App.tsx:144` = `state.workflows.some(w => w.status === 'running')`)가 참으로 굳는다.
2. 그 값이 **새 채팅·채팅 전환·채팅 삭제·Esc를 전부 막는다**(P7의 네 줄).
3. 정착은 CLI 프레임에만 의존한다 — 워크플로가 외부에서 죽으면 그 프레임이 **영영 안 온다**.
4. **워치독이 없다.** `engine.ts:726-733`:
   ```ts
   const armHoldIdle = (): void => {
     …
     if (!this.turnEnded || liveBgIds.size || liveWorkflows.size) return   // ← 여기
     if (liveBgAgents.size) holdIdleTimer = setTimeout(fireHoldIdle, 30 * 60_000)
     else if (pendingSettles.size) holdIdleTimer = setTimeout(fireHoldIdle, 10 * 60_000)
   }
   ```
   **살아있는 워크플로/셸이 있으면 타이머를 아예 안 건다.** 주석의 논리("dev 서버·긴 단계는
   몇십 분 조용한 게 정상")는 맞지만, 결론이 "그럼 감시하지 말자"였다. 감시할 다른 방법
   (증거 프로브)을 안 만든 게 이 버그의 뿌리다.
5. 스트림 종료 정리(`engine.ts:1826-1876`)는 존재하지만 **`if (this.activeRunId === runId)`
   가드 뒤에 있다.** `cancel()`이 runLoop 종료를 최대 5초만 기다리고(`engine.ts:409-415`)
   포기하면, 그 뒤 `run()`이 `this.activeRunId`를 새 값으로 덮는다(`engine.ts:506`). 늦게
   깨어난 옛 루프의 `finally`는 가드에 걸려 **정리를 통째로 건너뛴다.**
6. 아이러니: **재시작 경로에만 방어가 있다.** `src/renderer/src/store/session.ts:199-203`이
   저장 시 `running → stopped`로 내리고 "도는 채로 복원되면 거짓 알약이 뜬다"는 주석까지 달려 있다.
   → 그래서 **앱을 재시작해야만 사라진다.**

### P9. 소유권이 프로세스가 아니라 "현재 실행"에 묶여 있다

`this.activeRunId === runId` (P8-5)는 "지금 이 실행이 최신인가"를 묻는다. 정리해야 할 것은
**그 스트림이 만든 항목들**인데, 판정 기준이 **다른 스트림의 최신성**이다. 두 스트림이
겹치는 순간(취소 유예·재스폰) 항상 틀린 쪽으로 틀린다.

---

## 2. D1 — RunIdentity: 정체성을 값 하나로

### 2.1 무엇이 들어가고 무엇이 안 들어가는가

**들어간다 = "이 값이 다르면 같은 CLI 프로세스를 재사용할 수 없다"**(스폰 시점에만 정해지는 것).

**안 들어간다 = 대화 스레드(`session_id`/fork), 프롬프트, 첨부, 실행 순번.**
P1에서 `resume`을 섞은 게 사유를 뭉갠 원인이므로 **분리한다.**

```
재사용 가능 = identity_hash 같음  AND  thread 연속  AND  스트림 상태가 Resident
                    │                      │
                    │                      └─ 불일치 사유 = ThreadChanged (다른 대화/포크)
                    └─ 불일치 사유 = IdentityChanged{ 바뀐 필드 목록 }
```

두 사유를 나눠야 UI가 정직해진다: "설정을 바꿔서 새로 시작했어요(백그라운드 3개 정리됨)" vs
"다른 대화라 새로 시작했어요".

### 2.2 Rust 초안 — `crates/ccg-engine/src/identity.rs`

```rust
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// 엔진별로 의미가 다른 축(모델 id 공간·계정 스토어)을 태그드 유니온으로 묶는다.
/// 평평하게 두면 "codexModel은 claude일 때 무시" 같은 암묵 규칙이 비교식에 스며든다(P1).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "engine", rename_all = "lowercase")]
pub enum EngineAxis {
    Claude { model: ModelId, effort: EffortId },
    /// ★R2: `codex_account`는 Codex 변형 **안에** 둔다. 평평하게 두면 claude 정체성에
    ///      죽은 필드가 남고(P1의 재발), 태그드로 두면 타입이 "claude엔 없다"를 말해 준다.
    Codex  { model: CodexModelId, effort: EffortId, account: Option<CodexAccountId> },
}

/// 과금·자격 경로. `api_mode` 불리언 + `account` 문자열 두 필드로 두면
/// "useApi면 account 무시"라는 규칙이 비교식 밖에 남는다 → 하나로 접는다.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BillingAxis {
    /// 구독(OAuth) — 격리 CONFIG_DIR을 물질화할 계정. None = 기본 계정(정규화가 실 이메일로 채운다).
    /// `drop_env_key` = 전역 `ANTHROPIC_API_KEY`가 있을 때 "구독으로 돌린다"고 답한 결과
    /// (`engine.ts:846-852` 파리티). **키 지문별로 저장되는 답**이라 정체성 축이다(P1e).
    Subscription { account: AccountEmail, drop_env_key: bool },
    /// 저장된 API 키로 과금. 계정 개념 없음.
    /// ★R2: **키 지문**(blake3(key)[..8])을 실어야 "키를 갈았는데 상주가 옛 키로 도는" 것을 막는다(P1e).
    ///      키 원문은 절대 정체성에 넣지 않는다 — 해시·로그·이벤트에 그대로 실리므로.
    ApiKey { key_fp: KeyFingerprint },
}

/// 스폰 시점 `settings` 플래그 계층에 굳는 도구 정책(`engine.ts:870-877`). 전역 pref에서 오지만
/// **스폰에만 정해지므로** 정체성이다. 2.6.2가 `optsMatch`에 안 넣어 "껐는데 안 꺼짐"이 조용히 났다(P1e).
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ToolPolicyAxis {
    pub skill_overrides: BTreeMap<SkillId, SkillOverride>, // 정렬 맵 — 순서가 재스폰을 못 만든다
    pub denied_mcp:      BTreeSet<McpServerId>,
}

/// **정규화된** 실행 정체성. 필드 추가 = 비교 로직 무수정(derive), 단
/// `Normalizer`에 그 필드의 정규화 규칙을 반드시 등록해야 한다(§2.3의 골든 테스트가 강제).
///
/// 생성자는 `RunIdentity::normalize()` 하나뿐이다 — 필드는 `pub(crate)`이고
/// 외부는 게터로만 읽는다. "정규화 안 된 정체성"이라는 상태가 타입 시스템에 존재하지 않는다.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[non_exhaustive]
pub struct RunIdentity {
    pub(crate) engine:        EngineAxis,
    pub(crate) billing:       BillingAxis,
    pub(crate) cwd:           CanonPath,        // 정규화된 절대경로 (§2.3)
    pub(crate) add_dirs:      BTreeSet<CanonPath>, // 정렬·중복제거 — 순서 흔들림이 재스폰을 못 만든다
    pub(crate) mode:          ModeId,
    pub(crate) system_prompt: Option<NonEmptyTrimmed>, // "" 와 None 이 같은 값
    pub(crate) output_style:  Option<OutputStyle>,     // 채팅에 물질화된 스냅샷(전역 pref 아님 — §2.4)
    pub(crate) tools:         ToolPolicyAxis,          // ★R2 (P1e)
}

impl RunIdentity {
    /// 유일한 생성 경로. 렌더러가 보낸 원시 값 + 앱 기본값(바탕화면 cwd, 기본 계정 …)을
    /// 받아 정규화한다. 실패는 `IdentityError`(존재하지 않는 폴더 / 미로그인 계정 / 키 없음).
    pub fn normalize(raw: RawIdentity, defaults: &IdentityDefaults) -> Result<Self, IdentityError>;

    /// 16바이트 안정 해시 — 로그·이벤트·큐 항목·리비전 키에 쓴다.
    /// `Hash` derive가 아니라 **정준 직렬화(canonical CBOR) → blake3**로 만든다.
    /// 이유: 프로세스 간(스토어에 저장된 값 ↔ 지금 값)과 릴리즈 간에도 같아야 한다.
    pub fn hash(&self) -> IdentityHash;

    /// 두 정체성의 **차이 필드 이름 목록** — UI 문구와 로그 사유에 그대로 쓴다.
    /// `serde_json::to_value` 두 개를 얕게 비교하므로 **필드 추가에 자동 대응**한다.
    pub fn diff(&self, other: &Self) -> Vec<IdentityField>;
}
```

### 2.3 정규화 규칙표 — P1의 "필드마다 제각각"을 죽인다

| 필드 | 정규화 | 왜 |
|---|---|---|
| `cwd` | 빈 문자열 → 앱 기본(바탕화면, `engine.ts:38-44` 파리티) → `dunce::canonicalize` → Windows는 대소문자 폴딩 + 후행 `\` 제거 | `C:\Code\x` vs `c:\code\x\`가 재스폰을 만들면 안 된다 |
| `add_dirs` | `cwd`와 같은 항목 제거(`App.tsx:1058` 파리티) → 각 항목 `cwd`와 동일 정규화 → `BTreeSet` | 순서·중복이 재스폰을 못 만든다 (**P1 개선**) |
| `system_prompt` | `trim()` → 빈 문자열이면 `None` | `""` ↔ `None` 동치 |
| `output_style` | CLI 내장 4종(`Concise/Explanatory/Learning/Proactive`)만 유효, 그 외 `None` | `engine.ts:56-60` 규약 보존 |
| `billing` | `api_mode`면 `ApiKey{key_fp}`(계정 필드 소멸 · 키 **지문만**), 아니면 `Subscription{account: 실 이메일, drop_env_key}`(미지정 → 기본 계정 해석) | "useApi면 account 무시"가 **타입으로** 표현됨 |
| `billing.key_fp` | `blake3(키 원문)[..8]` hex. 키 없음 = 정규화 실패(`api_key_missing`) | 키 교체가 재스폰을 만든다 (**P1e**) |
| `billing.drop_env_key` | 전역 `ANTHROPIC_API_KEY` 없으면 `false` 고정. 있으면 그 키 지문에 저장된 사용자 답(`apiConfig` 파리티), 미응답이면 안전값 `true`(구독) | 답이 정체성이므로 답이 바뀌면 재스폰 (**P1e**) |
| `engine` | 엔진별 모델 id 공간 분리, `effort`는 엔진 축 안, `codex_account`는 Codex 변형 안 | `codexModel`/`codexAccount`가 claude 정체성에 남지 않음 |
| `tools` | 전역 pref → `BTreeMap`/`BTreeSet`으로 정렬·중복제거. 빈 컨테이너 = 기본값(직렬화 생략) | 순서가 재스폰을 못 만든다 (**P1e**) |
| `mode` | 그대로(닫힌 열거형) | — |

**골든 테스트**(필드를 몰래 늘리지 못하게):

```rust
#[test]
fn identity_field_set_is_frozen() {
    // 필드를 추가/삭제하면 이 테스트가 깨진다. 깨진 사람은 세 가지를 같이 해야 한다:
    //   (1) §2.3 정규화 규칙표에 행 추가  (2) 정규화 구현  (3) m-logic-replay.md 시나리오 추가
    let fields = json_field_names::<RunIdentity>();
    assert_eq!(fields, ["engine","billing","cwd","add_dirs","mode",
                        "system_prompt","output_style","tools"]);   // ★R2: tools 추가 (P1e)
}

#[test]
fn identity_hash_is_stable_across_releases() {
    // 저장된 큐/리비전의 해시가 릴리즈 간에 살아야 한다
    assert_eq!(fixture_identity().hash().to_hex(), "…golden…");
}
```

> ▶ **죽이는 병리**: P1(손 비교 10필드·정규화 산재·순서 민감 addDirs·사유 뭉개짐),
> **P1e(빠진 축 4개)**. 비교식이 `a == b` 한 줄이 되고, 새 필드는 **컴파일/테스트가 강제**한다.

> ⚠ **M-UX와의 접점 (크리틱 L7 후단)**: 위 골든 목록은 `ux-chat-unify.md` §5.2 마이그레이션
> 검증표의 필드 집합(`{engine, account, codexAccount, api}` + 예약된 `mcpOverrides`/`skillOverrides`)과
> **이름·모양이 다르다**. 두 문서를 그대로 구현하면 마이그레이션 PoC가 반드시 실패한다.
> **규약**: 마이그레이션 검증은 원시 필드가 아니라 `RunIdentity::hash()` **하나**를 비교한다
> — 2.6.2 레코드 → `RawIdentity` → `normalize()` → hash. 매핑 함수는 M-UX가 쓰고,
> 비교 대상은 M-LOGIC이 정한다. (열린 문제 O12)

### 2.4 `output_style` — 전역 pref를 채팅에 물질화한다

2.6.2는 비교 시점에 디스크를 읽는다(`engine.ts:1196` `claudeOutputStyle() === outputStyle`).
전역 값이라 **다른 채팅에서 바꾸면 이 채팅의 상주가 조용히 끊긴다.**
3.0: 전역 pref는 **새 채팅의 기본값**으로만 쓰고, 채팅 생성 시 `RunIdentity`에 스냅샷된다.
전역을 바꾸면 "열려 있는 채팅에도 적용할까요?"를 묻고, 적용은 §4의 정체성 변경 명령을 탄다.

> ▶ **죽이는 병리**: P1의 마지막 줄(전역 값이 채팅 정체성을 뒤에서 흔드는 경로).

### 2.5 protocol.ts 초안

```ts
// ── 실행 정체성 (M-LOGIC) ─────────────────────────────────────
// 한 채팅이 "누구로·어떤 모델로·어디서" 도는가. 재사용/재스폰 판정은 이 값의 동일성으로만
// 한다 — 필드를 추가해도 비교 로직은 바뀌지 않는다(Rust가 정규화 후 해시 비교).
// ★ 대화 스레드(sessionId/fork)는 정체성이 아니다. 스레드 불일치는 별도 사유로 보고된다.
export type EngineAxis =
  | { engine: 'claude'; model: ModelId; effort: EffortId }
  | { engine: 'codex'; model: string; effort: EffortId; account?: string | null }

export type BillingAxis =
  | { kind: 'subscription'; account: string; dropEnvKey: boolean } // 실 이메일 (기본 계정도 해석해 채운다)
  | { kind: 'api_key'; keyFp: string }  // ★ 지문만 — 키 원문은 계약면에 절대 오르지 않는다

/** 도구 정책 축 — 스폰 시점 settings 플래그로 굳는다(P1e). */
export interface ToolPolicyAxis {
  skillOverrides: Record<string, 'disabled'>   // 정렬된 키
  deniedMcp: string[]                          // 정렬·중복제거
}

/** 렌더러가 보내는 원시 정체성 — 부분 지정 가능(미지정 = 현재 값 유지). */
export interface RawIdentity {
  engine?: EngineAxis
  billing?: BillingAxis
  cwd?: string
  addDirs?: string[]
  mode?: ModeId
  systemPrompt?: string | null
  outputStyle?: string | null
  tools?: Partial<ToolPolicyAxis>
}

/** Rust가 정규화해 돌려주는 확정 정체성. 렌더러는 이 값을 **그대로 그린다**(재해석 금지). */
export interface RunIdentity {
  engine: EngineAxis
  billing: BillingAxis
  cwd: string
  addDirs: string[] // 정렬·중복제거된 정규 경로
  mode: ModeId
  systemPrompt: string | null
  outputStyle: string | null
  tools: ToolPolicyAxis
  /** 16바이트 hex — 큐 항목·리비전·로그가 참조하는 키 */
  hash: string
}

export type IdentityField =
  | 'engine' | 'billing' | 'cwd' | 'addDirs' | 'mode' | 'systemPrompt' | 'outputStyle' | 'tools'
```

---

## 3. D3 — 명시적 상태기계

### 3.1 층위 — 무엇이 무엇을 소유하는가

```
ChatRuntime  (채팅 1개 = 인스턴스 1개, 앱 수명 동안 지속. Rust 소유. 주소 = chatId 문자열 하나)
 ├─ identity: RunIdentity                 ← 진실의 단일 소유자 (D2)
 ├─ pending_identity: Option<Staged>      ← 턴 끝에 적용될 **패치**(정체성 전체가 아님 — §4.2)
 ├─ revisions: Vec<IdentityRevision>      ← 폴백·수동 변경 이력 + 되돌리기 (D6)
 ├─ fallback_armed: Option<FallbackArm>   ← 폴백 3경로 합류점 (§6.2) ★R2
 ├─ observed_model: Option<ModelId>       ← 메인 경로에서 마지막으로 관측한 모델(미러 — 리비전 아님)
 ├─ thread: ThreadLink { session_id, cwd_at_bind, forked_from, fork_consumed }
 ├─ queue: VecDeque<QueuedMessage>        ← 정체성 스냅샷 동봉 (D5)
 ├─ queue_undo: Option<QueueUndo>         ← 중단이 비운 큐의 되돌리기 버퍼 (§7.4) ★R2
 ├─ hold: Option<LimitHold>               ← 한도 대기 = 큐 게이트 (D5)
 ├─ live: LiveLedger                      ← 진행 중 항목 원장 (D8)
 │    └─ confidence: Observed | Unverified ← 원장이 **관측으로** 비었나, **추정으로** 비었나 ★R2
 └─ stream: Option<Stream>                ← 지금 떠 있는 CLI 프로세스 0..1개
     ├─ spawn_identity: RunIdentity       ← 이 프로세스가 뜰 때 굳은 값(재사용 판정의 좌변)
     ├─ close_policy: StreamClosePolicy   ← OnIdle(기본) | Linger{ms} | KeepOpen  ★R2 (§3.4)
     ├─ last_frame_at: Instant            ← ★ 워치독 1차 리스의 근거(§5.4)
     └─ state: StreamState                ← ★ 이 절의 상태기계
        └─ turn: Option<Turn { run_id, seq_marks, … }>
```

**`spawn_identity`를 스트림에 두는 이유**: 재사용 판정은 `chat.identity == stream.spawn_identity`다.
`chat.identity`끼리 비교하면 폴백·deferred 착지가 만든 변화가 "프로세스에 반영된 값"과 뒤섞인다
(2.6.2가 `req`/`nreq` 두 스냅샷으로 하던 일 — `engine.ts:1185-1196`). 좌변을 스트림에 두면
"프로세스에 굳은 값"과 "지금 채팅이 원하는 값"이 타입 수준에서 갈린다.

**핵심 재배치**: 상태기계는 **채팅이 아니라 스트림(=CLI 프로세스 수명)에 붙는다.**
라이브 항목은 **StreamId가 소유**한다. 그래서 스트림이 어떻게 끝나든(정상·에러·중단·급사·
앱 종료·외부 kill) **그 스트림의 항목을 정착시키는 것은 항상 옳다** — "내가 아직 최신인가"를
물을 필요가 없다.

> ▶ **죽이는 병리**: P9(`activeRunId === runId` 가드), P8-5(가드에 걸려 정리 스킵).

### 3.2 상태

| 상태 | 뜻 | CLI | 턴 | busy(UI) |
|---|---|---|---|---|
| `Idle` | 스트림 없음 | 없음 | 없음 | false |
| `Starting` | spawn → `initialize` 왕복 → 첫 `user` 프레임 기록 | 뜨는 중 | 시작 | **true** |
| `Streaming` | 턴 진행 중(프레임 흐름) | 산다 | 진행 | **true** |
| `AwaitingUser` | `Streaming`의 하위 — 승인/질문/다이얼로그 대기(모델 정지) | 산다 | 진행 | **true** |
| `HeldResult` | `Streaming`의 하위 — 무음 `result` 보류(슬라이딩 재장전) | 산다 | 종결 유예 | **true** |
| `Interrupting` | `interrupt` 송신, 중단 `result` 대기 | 산다 | 끝나는 중 | **true** |
| `Resident{why}` | 턴 끝남. 프로세스를 유지한다. `why` 3종 ↓ | 산다 | 없음 | false (표시는 `why`별) |
| `Terminating` | stdin EOF 또는 kill. **라이브 항목 정착 처리 중** | 죽는 중 | 없음 | false |
| `Ended` | exit 관측(또는 kill 상한 도달) + 원장 비었음 → 스트림 해제 | 없음 | 없음 | false |

**`Resident{why}` 3종 (★R2 — 하나였던 것을 쪼갠다)**

| `why` | 언제 | 표시 | 왜 쪼갰나 |
|---|---|---|---|
| `LiveItems` | 원장에 항목이 있다 | '작업 중'(`effectiveStatus`) | 원래 정의 |
| `Unverified` | 원장이 **워치독 정착으로** 비었다 | '진행 상태 불명 — 엔진은 살아 있어요' + [엔진 정리] | 추정으로 빈 원장이 `close_input()`을 부르면 **살아 있는 dev 서버를 죽인다**(§5.4-c) |
| `Policy{Linger\|KeepOpen}` | 원장은 비었지만 종료 정책이 유지 | '대기 중'(스피너 없음) | 재생 #5의 픽스처(같은 프로세스 3턴)를 SUT로 표현하려면 종료 정책이 **명시 축**이어야 한다(§3.4) |

- `busy` = **원시 상태**(전송 게이트용). `effectiveStatus`(표시용)는 `Resident{LiveItems}`에서
  '작업 중'을 유지한다 — 2.6.2 `session.ts:219-221` `effectiveStatus`(+ `:210-217` `bgActive`)의
  규약을 그대로 계승. (R1은 `session.ts:210-221`이라 뭉뚱그렸다 — 210은 `bgActive`다.)
  (메모리 '완료 표시 규칙': 완료 색은 bg까지 걷혀야, 토스트는 턴마다.)
- `Ended`는 스트림의 종단이고 채팅은 `Idle`로 돌아간다. 채팅은 죽지 않는다.

### 3.3 전이표 — A. 수명 전이 (36)

`W` = 워치독/타이머, `F` = CLI 프레임, `C` = 렌더러 명령, `X` = 외부 사건(프로세스/OS).

> R1은 여기 31행만 두고 "31전이"라 불렀다. 크리틱 L5 지적대로 **실제 프레임의 절반이
> 진입점 없이 떠 있었다**(REPLACE 채우기·`task_progress`·`task_notification`·`task_started`·
> `init` 재도착·`notification`). R2는 표를 둘로 쪼갠다:
> **A. 수명 전이**(상태가 바뀌거나 프로세스 수명을 건드리는 것, 36행) +
> **B. 프레임 소화 전이**(상태는 그대로, 원장·회계만 바뀌는 것, 22행).
> 그리고 §3.7이 `protocol-claude-cli.md` §8.4의 **24행 전부**를 이 58행 중 하나로 사영한다.
> 빠진 프레임이 있으면 §3.7 표에 빈칸이 생기고, 그 빈칸이 곧 버그다.

| # | From | 트리거 | 가드 | 액션 | To |
|---|---|---|---|---|---|
| T1 | `Idle` | C `send` / 큐 드레인 | `hold` 없음 ∧ 정체성 정규화 성공 | 정체성 확정 → job object에 자식 등록 → spawn → `initialize` → 첫 `user` 프레임. `status:analyzing` 즉시 방출(2.6.2 계약 보존) | `Starting` |
| T2 | `Starting` | F `control_response(initialize)` ∧ `system/init` | — | `session_id` 채택(**id 변화만** 새 세션으로 판정 — `m3-poc.md` §3), `thread` 바인드 | `Streaming` |
| T3 | `Starting` | W 20s 타임아웃 / X spawn 실패 | — | `notice` + `status:error`, 원장 정착(비어 있음) | `Terminating{SpawnFailed}` |
| T4 | `Streaming` | F `can_use_tool` / `request_user_dialog` / `AskUserQuestion` | — | 라이브 항목 `AskCard{request_id, tool_use_id}` 등록(소유=StreamId) | `AwaitingUser` |
| T5 | `AwaitingUser` | C `respond(permission\|question\|dialog)` | `request_id`가 이 스트림 것 (**매칭 키는 `request_id`** — `toolUseID`는 동봉하되 키가 아니다, `protocol-claude-cli.md` §4.4a) | `control_response` 송신(**`toolUseID` 항상 동봉** — `ARCHITECTURE-3.0.md` M3 위험 #1), 카드 정착 `Answered`. ★R2: `dialog(refusal_fallback_prompt)`를 **수락**하면 여기서 **폴백 리비전이 생긴다**(§6.2 경로 A) — R1은 "정착 Answered"로만 적어 응답이 정체성을 바꾼다는 사실이 상태기계에 없었다 | `Streaming` |
| T6 | `AwaitingUser` | F `control_cancel_request` | — | 카드 정착 `Withdrawn`(CLI가 회수) — 사용자에게 "질문이 취소됨" 표시 | `Streaming` |
| T7 | `Streaming` | F `result` ∧ (턴 활동 있음 ∨ 결과 텍스트 있음) | — | `result` + 종결 `status` 1회 보장, `finish_wrap()` | §3.4 **턴종료 판정** |
| T8 | `Streaming` | F `result` ∧ 무음(활동X ∧ 텍스트X) | — | 종결 보류, 재장전 카운터 0 | `HeldResult` |
| T9 | `HeldResult` | F 활동 프레임 | — | 보류 취소, 미니턴 오판 복구(`turn_ended=false`) | `Streaming` |
| T10 | `HeldResult` | W 2.5s 슬라이딩 만료 | 재장전 < 8 ∧ (프레임 흘렀음 ∨ `delivered_notifs` 있음) | 재장전(+1) | `HeldResult` |
| T11 | `HeldResult` | W 재장전 소진(총 ~22s) | `delivered_notifs` 비었음 | 무음 턴으로 정착 + `notice(silent)` | §3.4 |
| T12 | `HeldResult` | W 만료 | `delivered_notifs` 있음 ∧ 활동 없음 ∧ **`replayed_once`=false** ∧ 중단 요청 없음 | **프롬프트 재주입**(`finish_wrap()` 먼저, 새 `run_id` 아님·같은 턴 연장) | `Streaming` |
| T13 | `Streaming`/`AwaitingUser`/`HeldResult` | C `interrupt` | — | ① 열린 카드 **전부 먼저 해제**(deny/null) → ② **큐 비움 + `queue_undo` 적재 + `hold` 해제**(§7.4 — 2.6.2 `App.tsx:908 setQueue([])` 파리티) → ③ `control_request{interrupt}` (레이스 4s) | `Interrupting` |
| T14 | `Interrupting` | F `result`(`terminal_reason=aborted_*`) ≤6s | — | `interrupted` 마커, `interrupt_requested=true`(재주입 금지 표식) | §3.4 |
| T15 | `Interrupting` | W 6s 무응답 | — | 하드 강등 | `Terminating{HardCancel}` |
| T16 | `Resident{*}` | C `send` | `chat.identity == stream.spawn_identity` ∧ `thread` 연속 | **주입**: 같은 stdin에 `user` 프레임, 새 `run_id`, 턴 불변식 리셋(§3.5) | `Streaming` |
| T17 | `Resident{*}` | C `send` | 정체성 **불일치** | `stream_close{IdentityChanged{diff}}` 예고 이벤트 → 라이브 항목 전부 정착 사유 `IdentityChanged` | `Terminating` → T1 |
| T18 | `Resident{*}` | C `send` | 스레드 **불일치**(폴더 변경·포크) | `stream_close{ThreadChanged}` — **사유가 T17과 다르다** | `Terminating` → T1 |
| T19 | `Resident{*}` | F `user`(`<task-notification>`) | — | CLI 자발 기상 턴. **새 `run_id` 발급**(★R2 — 아래), `turn_from_cli=true`, `status:working` | `Streaming` |
| T19b | `Resident{*}` | F 메인경로 활동 프레임(선행 `user` 프레임 없이) | `saw_turn_activity` 판정 통과(§3.5) | 워크플로 **정리 턴 재개**. 2.6.2는 같은 `run_id`로 `done→working→done`을 왕복했다(`engine.ts:1259-1268`) — 3.0은 **새 `run_id`**를 발급해 불변식 #3을 지킨다 | `Streaming` |
| T20 | `Resident{*}` | F `background_tasks_changed`(REPLACE) | 목록 비었음 ∧ `pending_settles` 없음 ∧ **`ledger.confidence == Observed`** ∧ `close_policy == OnIdle` | `close_input()` — CLI가 **직접** "아무것도 안 돈다"고 말했다 = 관측된 빔 | `Terminating{AllClear}` |
| T20b | `Resident{*}` | 같은 트리거 | 같은 가드 ∧ `close_policy == Linger{ms}` | 타이머만 건다(T33 대기) | `Resident{Policy::Linger}` |
| — | `Resident{*}` | 같은 트리거 | 같은 가드 ∧ `close_policy == KeepOpen` | **전이 없음** — 명시 종료(T23/T24/T32)까지 유지 | `Resident{Policy::KeepOpen}` |
| T21 | `Resident{*}` | W **리스 만료 + 증거 프로브 실패**(§5.4) | — | 해당 항목 정착 `Watchdog`; `ledger.confidence = Unverified`. **`close_input()`을 부르지 않는다** — 추정으로 빈 원장으로 프로세스를 회수하면 살아 있는 dev 서버를 죽인다(§5.4-c) | `Resident{Unverified}` |
| T22 | 임의(≠`Idle`) | X stdout EOF / 프로세스 exit | — | **원장 일괄 정착** `StreamClosed{cause}` — 스킵 불가(§5.3 `StreamGuard::drop`) | `Terminating{StreamClosed}` |
| T23 | 임의(≠`Idle`) | C `stop_all`(하드 취소) | — | **큐 비움 + `queue_undo` + `hold` 해제**(T13과 같은 §7.4 규약) → `turn_ended=false`일 때만 interrupt(1.5s) → `close_input` → kill. 정착 사유 `Cancelled` | `Terminating{Cancelled}` |
| T24 | 임의 | X 앱 종료 | — | **아무것도 기다리지 않는다**. stdin 닫고 kill 신호, job object가 손자까지 보증. 원장은 디스크에 `AppQuit`로 정착 기록 | `Terminating{AppQuit}` |
| T25 | `Terminating` | X exit 관측 ∨ W kill 상한(2s→5s→SIGKILL) | 원장 비었음 | 스트림 해제, `run_boundary` 로그 | `Ended` |
| T26 | `Ended` | 즉시 | — | 채팅으로 제어 반환. `pending_identity` 있으면 적용(§4) | `Idle` |
| T27 | `Idle` | 큐 비어있지 않음 ∧ `hold` 없음 ∧ 앞선 스트림 `Ended` | — | 큐 head 소비 → **그 항목의 정체성 스냅샷**으로 T1 | `Starting` |
| T28 | `Streaming` | F `system/compact_boundary` | — | `compact_pending` 버퍼(다음 assistant 프레임과 짝지어 방출; 턴이 먼저 끝나면 `after=null`) | `Streaming` |
| T29 | `Streaming` | F `model_refusal_fallback` ∨ `message.model` 변화(메인 경로만) | 사이드체인 프레임 아님(`parent_tool_use_id` 없음) ∧ **§6.2 합류표가 "리비전 생성"으로 판정**(경로 B'·C''만 — 이미 arm된 신호는 소비만 한다) | **정체성 자동 리비전**(origin=`EngineFallback{via}`) + `identity_changed` 브로드캐스트 + 인라인 배너 + 되돌리기 토큰(§6) | `Streaming` |
| T30 | `Streaming` | F `rate_limit_event{status:"blocked"}` ∨ `result`가 한도 에러(문구 분류) | — | `hold` 장전(§7.3 — **장전 근거 2종의 신뢰도가 다르다**) — **큐 게이트만** 걸고 상태기계는 정상 종료 경로를 탄다 | §3.4 |
| T31 | `Resident{*}`/`Idle` | C `identity_set`(즉시 적용) | 적용 가능(§4 판정) | 정체성 교체 + 리비전 기록. `Resident`면 "다음 메시지에 재스폰(백그라운드 N개 정리)" 예고 이벤트 | 같은 상태 |
| **T32** ★R2 | `Resident{Unverified\|Policy}` | W `stream_idle_limit`(마지막 프레임 후 **6h** — O16) | 턴 없음 | 유휴 회수. `close_input()` → kill 상한. 정착 사유 `IdleReclaim`, 안내 1줄. **행(hang)한 CLI의 마지막 탈출구** | `Terminating{IdleReclaim}` |
| **T33** ★R2 | `Resident{Policy::Linger}` | W linger 만료 | 원장 비었음 ∧ 큐 비었음 | `close_input()` | `Terminating{AllClear}` |
| **T34** ★R2 | `Starting` | C `interrupt` / `stop_all` | — | spawn 취소(핸들 abort). 첫 프레임 전이라 정착할 항목 없음. 큐 처리는 T13과 동일(§7.4). R1은 §3.6 표에만 "✅(spawn 취소)"라 적고 전이표에 행이 없었다 | `Terminating{Cancelled}` |

**T19/T19b의 새 `run_id` (★R2 — 크리틱 L11)**: 2.6.2는 정리 턴 재개에서 **같은 `run_id`로
`done→working→done`을 왕복**한다(`engine.ts:1259-1268`, "왕복의 두 번째 done이 완료 토스트를
겸한다"). 재생 하네스의 공통 불변식 #3("각 `run_id`마다 종결 status 정확히 1회")이 그 정상 동작을
빨간불로 잡는다. 3.0은 **CLI 자발 기상 턴에 새 `run_id`를 발급**해 불변식을 지킨다.
파리티 영향: '답변 도착' 토스트는 여전히 **턴마다** 뜬다(메모리 규약 그대로) — 오히려
`run_id`가 갈려 토스트 중복 판정이 쉬워진다.

### 3.3-B 전이표 — B. 프레임 소화 전이 (22)

상태를 바꾸지 않는다. **원장·회계·표시만** 바꾼다. 그래도 표에 올리는 이유: R1에서 이 22개가
표 밖에 있었고, 그중 4개(`background_tasks_changed` 채우기 · `task_progress` · `task_notification` ·
`task_started`)가 **D8 원장·§5.4 워치독·재생 하네스 전부의 기반**이었다(크리틱 L5).

| # | 프레임 | 유효 상태 | 액션 | 리스 효과(§5.4) |
|---|---|---|---|---|
| F1 | `system/init` **재도착** | `Streaming`/`Resident` | `session_id` 같으면 **아무것도 안 한다**(★ "init 도착 = 새 세션" 판정 금지 — `m3-poc.md` §3 실측). 다르면 스레드 재바인드 + `notice` | 없음 |
| F2 | `stream_event` `text_delta`(메인) | `Streaming` | `StreamingMsg` 열기/이어붙임, `saw_turn_activity=true` | 스트림 `last_frame_at` |
| F3 | `stream_event` `thinking_delta` | `Streaming` | `Thinking` 갱신(90자 요약) | 스트림 |
| F4 | `stream_event` `content_block_start:tool_use` | `Streaming` | `Thinking{도구 라벨}` | 스트림 |
| F5 | `stream_event` (**사이드체인**: `parent_tool_use_id` 있음) | 임의 | **즉시 버림**(§6.5 — 완성 프레임만 쓴다, `engine.ts:1574` 파리티) | 스트림만 |
| F6 | `assistant` text 블록(메인) | `Streaming` | `StreamingMsg` 정착 + `Thinking` 해제 + `saw_turn_activity=true` | 스트림 |
| F7 | `assistant` tool_use 블록(메인) | `Streaming` | `RunningTool` **원장 등록**(+ 첫 도구에서 `status:working`) | 항목 생성 |
| F8 | `assistant` (사이드체인) | 임의 | 부모 `Subagent` 카드의 `activity` 한 줄(200자) + 모델 칩(**값 변화 시만**). **메인 경로 오염 금지**(§6.5) | 부모 항목 재장전 |
| F9 | `assistant.message.usage`(메인) | `Streaming` | 컨텍스트 게이지 + 보류 중인 `compact`와 짝맞춤(T28) | 스트림 |
| F10 | `assistant.message.model` 변화(메인) | `Streaming` | **§6.2 합류 규약**으로 분기 — 리비전(T29) 또는 미러만 갱신 | 스트림 |
| F11 | `user` tool_result(메인) | `Streaming` | `RunningTool` 정착 + file-change/terminal 가공 + `saw_turn_activity=true` | 항목 정착 |
| F12 | `user` 텍스트에 `<task-notification>` | `Streaming` | `delivered_notifs`에 task id 적재(T12 재주입 판정 + `finish_wrap()` 안전벨트 재료 — §6.6) | 해당 항목 재장전 |
| F13 | **`system/background_tasks_changed`** (REPLACE) | `Streaming`/`AwaitingUser`/`HeldResult`/`Resident` | ★원장 재조정: **목록에 있는데 원장에 없으면 생성**(`task_type` 3분류 — `/workflow/i`→`Workflow`, `/bash\|shell/i`→`BgShell`, 그 외→`BgAgent`), **원장에 있는데 목록에서 빠졌으면** `pending_settles`로 이동 + `wf_notify_seq = frame_seq`(정착 통지는 목록이 빈 **뒤**에 온다 — 여기서 바로 닫으면 보고 턴이 잘린다). 목록이 비고 조건이 맞으면 T20/T20b로 승격 | **멤버십 = 최상위 증거**. 프레임 도착 시각을 `replace_seen_at`에 기록(§5.4가 신선도로 쓴다) |
| F14 | `system/task_started` | `Streaming` | `tool_use_id → task_id` 매핑 등록(`live_task_by_tool_use`). 이 매핑이 "서브에이전트 tool_result가 **백그라운드 시작 접수증**인지"를 문구 스니핑 없이 판정하게 한다 | 항목 생성(또는 예약) |
| F15 | `system/task_progress` **+ `workflow_progress`** | `Streaming`/`Resident` | `Workflow` 항목 생성/갱신(단계·에이전트 스냅샷 전체 교체). `note` = running이면 `promptPreview`, done이면 `resultPreview`(140자) | **하트비트 = Alive 증거** |
| F16 | `system/task_progress` (workflow_progress 없음) | `Streaming`/`Resident` | 보드 이벤트로 **승격하지 않는다**(2.6.2 파리티: 하트비트라 버린다). 그러나 **원장에서는 버리지 않는다** — `task_id`의 리스를 재장전한다 | **하트비트 = Alive 증거** ★R2에서 새로 쓰는 자리 |
| F17 | **`system/task_notification`** | `Streaming`/`Resident` | 정착 에지. ① `by_user`(사용자 중지)면 `pending_settles`에서 **즉시 제거**(보고 턴 없음) ② 아니면 `pending_settles.add` + `wf_notify_seq = frame_seq` ③ 워크플로면 스냅샷을 `status`로 마감하되 `summary`는 **진행 프레임 원문을 지킨다** ④ 유휴 상주면 방출을 정리 턴까지 미룬다 ⑤ `tool_use_id`가 추적 중인 서브에이전트면 **여기가 진짜 완료** | 항목 정착(증거 있는 정착) |
| F18 | `system/notification` · `system/informational` | 임의 | `notice{text}` 통과. 상태·원장 무영향 | 스트림 |
| F19 | `rate_limit_event` (`status:"allowed"`) | 임의 | `resets_at`·`rate_limit_type`만 기록(무료 한도 정보). **hold 장전 아님** | 스트림 |
| F20 | stderr 줄 | 임의 | `terminal{line:{type:'muted'}}` | 없음(★ stderr는 리스 증거가 아니다 — 죽어 가는 프로세스도 stderr를 뱉는다) |
| F21 | **미지 `type`/`subtype`** | 임의 | **조용히 버린다**(§5.16) + `CCG_ENGINE_LOG`에 1줄. 재생 하네스가 시나리오마다 무작위 위치에 1개 주입해 상시 검증(불변식 #10) | 스트림 |
| F22 | `control_request` `hook_callback` / `mcp_message` / `elicitation` / `oauth_token_refresh` / `host_auth_token_refresh` | 임의 | 프로토콜 §4.4 (c)~(f) 규약대로 자동 응답. **UI 카드로 올리지 않는다**(사용자 결정이 아니다). 미지 subtype은 `{"subtype":"error"}`로 응답 | 스트림 |

### 3.4 턴종료 판정 (T7·T11·T14·T30의 공통 착지점)

```
turn_ended = true
finish_wrap()            # 정착 회계 (§6.6 프로토콜 문서 규약 그대로: 순번 비교 + deliveredNotifs 안전벨트)
pending_identity 있으면 → 적용 (§4.2 Deferred 착지 — 패치 재정규화, 전체 교체 아님)
live 원장에 항목 남았나?
  ├─ 예 → Resident{LiveItems}   (+ 리스 재장전 §5.4 — ★ 2.6.2와 달리 "워크플로 있으면 타이머 없음" 아님)
  └─ 아니오 → match close_policy {
        OnIdle      => close_input() → Terminating{AllClear}      # 기본. 2.6.2 maybeCloseInput 파리티
        Linger{ms}  => 타이머 장전 → Resident{Policy::Linger}     # T33
        KeepOpen    => Resident{Policy::KeepOpen}                 # 재생 픽스처 파리티 (§3.4-b)
     }
그리고: 큐가 비어있지 않고 hold 없으면 → T16(주입) 또는 T17/T18(재스폰) 으로 즉시 이어짐
```

#### 3.4-b `StreamClosePolicy` — 왜 정책이 축이어야 하는가 (★R2)

크리틱 §5 #5: 실와이어 `wire/interrupt.jsonl`은 **같은 프로세스에서 2·3턴이 이어진다**.
그 이유는 CLI가 아니라 **PoC 하네스가 stdin을 안 닫았기 때문**이다(`m3-poc.md:39`, `:253-254`).
R1의 §3.4는 원장이 비면 무조건 `close_input()`이라 그 픽스처를 **그대로 재생할 수 없었다**
(SUT가 `Terminating`으로 떨어져 2턴이 갈 곳이 없다).

정책을 명시 축으로 올려 픽스처와 SUT를 화해시킨다:

| 정책 | 뜻 | 쓰는 곳 |
|---|---|---|
| `OnIdle` | 원장 비면 즉시 `close_input()` | **3.0 출하 기본값.** 2.6.2 `maybeCloseInput`(`engine.ts:658-663`) 파리티. `claude.exe` 상주는 실측 337MB — 채팅마다 붙들면 메모리가 안 남는다 |
| `Linger{ms}` | 원장 비어도 ms 동안 stdin 유지 | 실험용(답변 직후 후속 메시지의 재스폰 2~4s 제거). **기본 off** — 켜려면 O13을 먼저 닫아야 한다 |
| `KeepOpen` | 명시 종료까지 유지 | **재생 하네스 전용.** `wire/*.jsonl`이 채집된 조건과 동일 |

시나리오 TOML이 `close_policy`를 선언하고, 리포트가 시나리오별로 그 값을 표시한다.
선언 없으면 `OnIdle`. **이 축이 없으면 실와이어 픽스처의 절반이 "재생 불가"로 남는다.**

**백그라운드 셸 5s 유예**: 턴 종료 시 셸 항목은 `grace_until = now + 5s`가 붙는다(실측:
CLI가 턴 종료 직후 백그라운드 bash를 정리한다). 유예 안에 REPLACE에서 사라지면 정착 사유는
`TurnEnded`(≠`Completed`) — "끝남"이 아니라 "턴이 끝나서 정리됨"으로 표시한다. 유예를 넘겨
살아 있으면 정상 상주 항목으로 계속 추적한다.
> 유예 값 5s는 2.6.2 실사용 관측치다. **라이브 PoC로 재확인 필요** → §10 O7.

### 3.5 턴 불변식 (`Streaming` 진입마다 리셋 — 하나라도 빠지면 2.6.2 사고 재현)

`run_id` 새로 발급 · `turn_ended=false` · `interrupt_requested=false` · `saw_turn_activity=false`
· `held_result=None` · `rearms=0` · `turn_start_seq=frame_seq` · `replayed_once=false`
· 스트리밍 상태(`cur_text_id`/`thinking`/`streamed_this_msg`) 리셋 · `turn_from_cli` 갱신
· `sent_terminal_status=false`.
(`engine.ts:1201-1218` 파리티 — Rust는 이 리셋을 `Turn::new()` **생성자 하나**로 강제하고,
필드 직접 대입을 `pub(super)`로 막는다.)

**`run_id` 발급 지점은 넷뿐이다**: T1(콜드 스타트) · T16(주입) · T19(CLI 자발 기상) ·
T19b(정리 턴 재개). 다른 곳에서 턴이 시작되면 컴파일이 안 된다(`Turn::new()`가 유일 생성자).
이 규칙이 재생 불변식 #3("`run_id`당 종결 status 1회")을 **구조적으로** 성립시킨다.

**`saw_turn_activity` 정의(사이드체인 조기 분리 — `protocol-claude-cli.md` §6.5)**:
```
parent_tool_use_id 없음 ∧ ( assistant에 text|tool_use 블록
                          ∨ stream_event text_delta
                          ∨ user에 tool_result )
```

> ▶ **죽이는 병리**: P8(워치독 부재 → T21이 상시 존재), P9(소유권 재배치 → T22가 스킵 불가),
> 그리고 2.6.2가 주석으로만 갖고 있던 규약들(소프트 중단·무음 보류·통지 재주입·5s 유예·
> compact 짝맞춤)이 **표의 행**이 되어 재생 테스트로 때릴 수 있게 된다.

### 3.6 상태별 명령 허용표 (D7 — 침묵 no-op 금지)

모든 셀은 `accepted` / `queued` / `deferred` / `rejected{reason}` 중 하나다. **빈칸 없음.**
Rust는 모든 명령에 `CommandVerdict`를 **동기 응답**하고, 동시에 브로드캐스트한다(다른 창도 봐야 하므로).

**열이 8개인 이유(★R2 — 크리틱 L12)**: 상태는 9개지만 `Ended`는 **명령을 받지 않는다.**
T25가 `Ended`에 들어가는 순간 T26이 같은 tick에서 `Idle`로 내보내므로(§3.3 T26 "즉시"),
`Ended`에 도달한 명령이란 것이 존재할 수 없다. 렌더러가 `Ended` 상태를 관측하는 창도 없다
(`chat:run-state`는 `Ended`를 방출하지 않고 곧바로 `idle`을 보낸다 — §5.6 열거형에 `ended`가 없는 이유).
`Resident`는 `{LiveItems|Unverified|Policy}` 3변형이 **명령에 대해 동일하게** 반응하므로 한 열이다.

| 명령 | `Idle` | `Starting` | `Streaming` | `AwaitingUser` | `HeldResult` | `Interrupting` | `Resident{*}` | `Terminating` |
|---|---|---|---|---|---|---|---|---|
| `send` | ✅ accepted (T1) | 📥 queued(head) | 📥 queued | 📥 queued | 📥 queued | 📥 queued | ✅ accepted (T16/17/18) | 📥 queued |
| `enqueue` | ✅ (즉시 드레인) | 📥 | 📥 | 📥 | 📥 | 📥 | 📥 | 📥 |
| `interrupt` | ⛔ `nothing_running` (+큐 있으면 `queue.clear` 제안) | ✅ T34 **+큐 비움** | ✅ T13 **+큐 비움** | ✅ T13 **+큐 비움** | ✅ T13 **+큐 비움** | ⛔ `already_interrupting` | ✅ **bg 전체 중지 + 큐 비움**(2.6.2 파리티 ↓) | ⛔ `ending` |
| `stop_all` | ⛔ `nothing_running` | ✅ T34 **+큐 비움** | ✅ T23 | ✅ T23 | ✅ T23 | ✅ T23(강등) | ✅ T23 | ⛔ `already_ending` |
| `queue.restore` (되돌리기) | ✅ (토큰 유효할 때) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `respond_permission` | ⛔ `no_card` | ⛔ `no_card` | ⛔ `no_card` | ✅ T5 | ⛔ `no_card` | ⛔ `interrupting`(카드는 이미 해제됨) | ⛔ `no_card` | ⛔ `ending` |
| `respond_question` | ⛔ `no_card` | ⛔ `no_card` | ⛔ `no_card` | ✅ T5 | ⛔ `no_card` | ⛔ `interrupting` | ⛔ `no_card` | ⛔ `ending` |
| **`respond_dialog`** (`refusal_fallback_prompt`) | ⛔ `no_card` | ⛔ `no_card` | ⛔ `no_card` | ✅ T5 + **수락이면 폴백 리비전 생성**(§6.2 경로 A) | ⛔ `no_card` | ⛔ `interrupting` | ⛔ `no_card` | ⛔ `ending` |
| `bg_task.stop` | ⛔ `no_stream` | ⛔ `no_stream` | ✅ | ✅ | ✅ | ✅ | ✅ | ⛔ `ending` |
| `bg_task.background` (Ctrl+B) | ⛔ `no_stream` | ⛔ `no_stream` | ✅ | ✅(막고 있는 도구가 있을 때) | ✅ | ⛔ `interrupting` | ⛔ `no_foreground_tool` | ⛔ `ending` |
| `identity_set` | ✅ applied | ⏳ deferred(턴 끝) | ⏳ deferred | ⏳ deferred | ⏳ deferred | ⏳ deferred | ✅ applied + **재스폰 비용 예고** | ⏳ deferred(다음 스트림) |
| `identity_set{pendingOp:'cancel'}` | ⛔ `no_pending` | ✅ 예약 취소 | ✅ | ✅ | ✅ | ✅ | ⛔ `no_pending` | ✅ |
| `identity_revert` | ✅ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ✅ + 비용 예고 | ⏳ |
| `queue.remove` / `reorder` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `hold.cancel` (자동 이어서 끄기) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `clear` (/clear) | ✅ | ✅(스트림 취소 후) | ✅(**stop_all 선행** — 상주 백그라운드도 회수) | ✅ | ✅ | ✅ | ✅ | ⏳ |
| `switch_chat` (뷰 전환) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `new_chat` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `delete_chat` | ✅ | ⚠️ confirm(`run_in_flight`) | ⚠️ confirm | ⚠️ confirm | ⚠️ confirm | ⚠️ confirm | ⚠️ confirm(`bg_alive: N`) | ✅ |
| `fork_btw` (/btw) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `compact` (/compact) | ✅(런 시작) | 📥 | 📥 | 📥 | 📥 | 📥 | ✅ 주입 | 📥 |
| `force_settle{item}` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `dispose` (패널 제거/창 닫기) | ✅ | ✅ | ⚠️ confirm | ⚠️ confirm | ⚠️ confirm | ⚠️ confirm | ⚠️ confirm | ✅ |

범례: ✅ 즉시 수행 · 📥 큐에 넣고 그 사실을 UI에 표시 · ⏳ 예약 적용(언제 적용될지 표시) ·
⚠️ 확인 카드(비용을 문장으로 — "워크플로 2개가 정리됩니다") · ⛔ 거부 + 사유 문자열.

**★R2 변경 1 — `Resident`의 `interrupt`가 ✅로 승격 (크리틱 L9)**: R1은 ⚠️ `no_turn` +
"bg 전체 중지 **제안**"으로 강등했었다. 2.6.2는 클릭 **한 번**에 상주 워크플로를 실제로 중지한다
(`App.tsx:901-908` `cancelRun`의 else 가지 — `for (const w of state.workflows) if running → bgTask stop`;
Esc가 같은 경로 `App.tsx:918-928`; 멀티도 같다). 클릭 한 번이 두 번이 되는 건 **말없는 파리티 후퇴**라
되돌린다. 대신 정직성은 **결과 통지**로 챙긴다: "워크플로 2개·셸 1개를 중지했어요 — [되돌리기 불가]".

**★R2 변경 2 — 중단이 큐를 비운다 (크리틱 L1)**: R1의 T13/T14/T23과 이 표 어디에도 큐 효과가
없어서, 설계대로 구현하면 **Esc 직후 §3.4가 드레인을 불러 큐 head가 자동 전송**됐다.
2.6.2는 비운다(`App.tsx:908 setQueue([])` — Esc와 컴포저 중지 버튼이 같은 경로).
채택 정책은 **"비움 + 안내 + 되돌리기"**다(§7.4). 이유: 3.0 큐는 영속이고 정체성 스냅샷을
품고 있어 조용히 버리면 P5보다 큰 손실이고, 보존하면 "중지했는데 다음 게 나간다"라는
사용자 기대 위반이 남는다. 둘 다 피하는 유일한 지점이 **비우되 복구 가능**이다.

**★ `switch_chat`·`new_chat`이 전 상태에서 ✅인 이유**: 실행은 Rust의 `ChatRuntime`에 붙어 있고
패널/사이드바는 **뷰**다(M-UX 가정). 뷰를 옮겨도 실행은 계속된다. 2.6.2가 이걸 막았던 건
"리듀서 하나를 채팅들이 갈아탄다"는 렌더러 구현 사정 때문이지 도메인 제약이 아니었다.

> ▶ **죽이는 병리**: P7(침묵 no-op 4곳), P8-2(고아 워크플로가 사이드바 전체를 잠그는 경로 —
> **애초에 잠글 수 있는 셀이 표에 없다**).

### 3.7 프레임 전수 대응 — `protocol-claude-cli.md` §8.4 × 전이표

크리틱 L5("전이표가 실제 프레임의 절반만 소화 — 31전이가 닫혀 있지 않다")를 닫는 표다.
§8.4 매핑표는 **24행**이다(크리틱은 22행이라 셌다 — `protocol-claude-cli.md:1525-1548` 실 카운트 24).
빈칸이 하나라도 있으면 그 프레임은 상태기계에 **진입점이 없다**는 뜻이고, 그게 P8 계열 버그의 씨앗이다.

| # | §8.4 프레임 | 전이 | 상태 영향 | 원장 영향 |
|---|---|---|---|---|
| 1 | `system/init` (첫 도착) | **T2** | `Starting→Streaming` | 스레드 바인드 |
| 1b | `system/init` (재도착·같은 session_id) | **F1** | 없음 | 없음 (★ 새 세션 판정 금지) |
| 2 | `stream_event content_block_delta:text_delta` | **F2** | 없음 | `StreamingMsg` |
| 3 | `stream_event content_block_delta:thinking_delta` | **F3** | 없음 | `Thinking` |
| 4 | `stream_event content_block_start:tool_use` | **F4** | 없음 | `Thinking` 라벨 |
| 4b | `stream_event` (사이드체인) | **F5** | 없음 | 버림 |
| 5 | `assistant` text 블록 | **F6** | 없음 | `StreamingMsg` 정착 |
| 6 | `assistant` tool_use 블록 | **F7** | 없음 | `RunningTool` 생성 |
| 7 | `assistant` (사이드체인) | **F8** | 없음 | `Subagent` activity |
| 8 | `assistant.message.usage` | **F9** (+**T28** 짝맞춤) | 없음 | 없음 |
| 9 | `assistant.message.model` 변화 | **F10** → 조건부 **T29** | 없음 | 리비전 |
| 10 | `user` tool_result | **F11** | 없음 | `RunningTool` 정착 |
| 10b | `user` `<task-notification>` | **T19**(상주 기상) / **F12**(턴 중 배달 기록) | `Resident→Streaming` | `delivered_notifs` |
| 11 | `result` | **T7**(활동 있음) / **T8**(무음) / **T14**(중단) → §3.4 | 턴 종료 판정 | 원장 유지·정착 |
| 12 | `system/compact_boundary` | **T28** | 없음(자기 전이) | `compact_pending` |
| 13 | `system/model_refusal_fallback` | **T29** (§6.2 경로 B) | 없음(자기 전이) | 리비전 |
| 14 | `system/notification` | **F18** | 없음 | 없음 |
| 15 | `system/informational` | **F18** | 없음 | 없음 |
| 16 | **`system/background_tasks_changed`** | **F13** → 빈 목록이면 **T20/T20b** | 조건부 `Resident→Terminating` | ★생성·정착·`pending_settles` |
| 17 | **`system/task_progress`** (+`workflow_progress`) | **F15** / 하트비트만이면 **F16** | 없음 | ★`Workflow` 생성·갱신·**리스 재장전** |
| 18 | **`system/task_started`** | **F14** | 없음 | `tool_use_id→task_id` 매핑 |
| 19 | **`system/task_notification`** | **F17** | 없음 | ★정착 에지 + 보고 턴 회계 |
| 20 | `control_request can_use_tool` | **T4** | `Streaming→AwaitingUser` | `AskCard` |
| 21 | `can_use_tool` (AskUserQuestion) | **T4** | `Streaming→AwaitingUser` | `AskCard` |
| 22 | `control_request request_user_dialog` | **T4** (+응답이 **T5**·§6.2 경로 A) | `Streaming→AwaitingUser` | `AskCard` |
| 22b | `control_cancel_request` | **T6** | `AwaitingUser→Streaming` | 카드 `Withdrawn` |
| 23 | stderr 줄 | **F20** | 없음 | 없음(증거 아님) |
| 24 | 스트림 이상 종료 (stdout EOF·exit) | **T22** → **T25/T26** | `*→Terminating→Ended→Idle` | ★`StreamGuard::drop` 일괄 정착 |

§8.4에 없지만 와이어에 있는 것 3종도 자리를 준다:

| 프레임 | 전이 | 근거 |
|---|---|---|
| `rate_limit_event` (`status:"allowed"`) | **F19** | `protocol-claude-cli.md:1056-1066` — 실측 관측된 유일한 모양 |
| `rate_limit_event` (`status:"blocked"` — **미관측**) | **T30** | 합성 픽스처. 실관측 전까지 §7.3의 2순위 근거 |
| `control_request` (c)~(f) `hook_callback`/`mcp_message`/`elicitation`/`oauth_token_refresh` | **F22** | `protocol-claude-cli.md` §4.4 |
| 미지 `type`/`subtype` | **F21** | §5.16 — 조용히 버리되 죽지 않는다 |

**빈칸: 0.** 재생 하네스는 이 표를 기계가 읽는 형태로도 들고 있어야 한다 —
`tests/frame_coverage.rs`가 `§8.4 행 → 전이 id` 맵을 하드코딩하고, 상태기계에 그 전이가
실제로 존재하는지(그리고 시나리오 최소 1개가 그 전이를 밟는지) 검사한다. 안 밟는 전이가
있으면 **빌드 실패**(`m-logic-replay.md` §7의 커버리지 줄과 같은 장치).

---

## 4. D4 — 설정 변경은 명령이다

### 4.1 흐름

```
렌더러                         Rust ChatRuntime                        모든 창
  │  chat:identity-set                 │                                 │
  │  { chatId, patch, applyPolicy } ──▶│ 1. normalize(patch ∪ 현재)       │
  │                                    │ 2. 판정: applied|deferred|rejected│
  │                                    │ 3. 비용 계산(재스폰? 정리될 항목?) │
  │◀── IdentityVerdict ────────────────│                                 │
  │                                    │──── chat:identity (broadcast) ──▶│
  │  (picker는 이 브로드캐스트를 그린다 — 로컬 setState로 진실을 만들지 않는다)
```

**렌더러 picker의 새 규약**: `value = broadcast.identity`, `onChange = ipc(identity-set)`.
낙관적 UI를 쓰고 싶으면 `pending` 표시로만(회색 + 스피너), 확정은 브로드캐스트로.

### 4.2 판정 규칙

| 상황 | 판정 | UI 문구(예) |
|---|---|---|
| `Idle`, 정규화 성공 | `applied` | (조용히 반영) |
| `Resident` ∧ 라이브 항목 없음 | `applied` | (조용히 반영) |
| `Resident` ∧ 라이브 항목 N개 | `applied` + `effects.will_respawn` | "적용됨 — 다음 메시지부터 새 프로세스로 시작하며 진행 중인 작업 N개가 정리됩니다" |
| 위 상황 + `applyPolicy: 'ask_if_costly'` | `needs_confirm` | 확인 카드(비용 문장 + [지금 적용] [이번 작업 끝나고] [취소]) |
| 턴 진행 중(`Starting`~`Interrupting`) | `deferred{at:'turn_end'}` | 컴포저에 배지 "이번 답변 끝나고 적용 — Opus 5 · 계정 b@x" + [취소] |
| 계정 미로그인 / API 키 없음 | `rejected{reason:'account_unavailable'\|'api_key_missing'}` | "그 계정으로 로그인되어 있지 않아요 — 설정 ▸ 계정" |
| `cwd` 없음/접근 불가 | `rejected{reason:'cwd_missing'}` | 경로와 함께 |
| 엔진 전환(claude↔codex)인데 스레드가 바인드됨 | `applied` + `effects.thread_reset` | "대화 스레드가 새로 시작됩니다(이전 문맥은 이어지지 않아요)" |
| 같은 값 | `noop` | (무반응 아님 — `noop` 판정을 돌려주고 UI는 아무것도 안 함) |

### 4.2-b `deferred`는 **패치**로 들고 착지에서 재정규화한다 (★R2 — 크리틱 L3)

R1은 두 가지를 같이 적었고, 그 둘이 곱해져 새 버그를 만들었다:

1. `set_identity`가 **접수 시점**에 `normalize(self.identity.patched(patch))`로 *다음 정체성 전체*를
   굳혀 `pending_identity`에 넣는다.
2. `deferred`가 여러 번 오면 "**전체 교체**".

턴 중에 T29(폴백)가 나면 `identity.engine.model`이 즉시 바뀐다(리비전 origin=`EngineFallback`).
그런데 그 **전에** 접수된 `pending_identity`는 폴백 이전 model을 통째로 품고 있고,
§3.4 착지에서 그걸로 전체 교체한다 → **사용자가 계정만 바꿨는데 턴이 끝나는 순간 모델이 조용히
폴백 이전 값으로 되돌아간다.** P3("누가 이겼는지 모른다")이 형태만 바꿔 부활한다.

**수정된 의미론**:

```rust
pub struct Staged {
    /// 사용자가 요청한 **패치의 누적**. 필드 단위 last-write-wins 병합(전체 교체 아님).
    patch: RawIdentity,
    /// 접수 시점 리비전 — 표시·진단·드리프트 판정용. 착지 계산에는 **쓰지 않는다**.
    base_revision: u32,
    /// 접수 시점에 계산한 미리보기. 컴포저 배지가 그리는 값. 착지 계산에는 **쓰지 않는다**.
    preview: RunIdentity,
    policy: ApplyPolicy,
    corr_ids: Vec<String>,
}

// §3.4 착지:
let landed = RunIdentity::normalize(self.identity.patched(staged.patch), &self.defaults)?;
//                                  ^^^^^^^^^^^^^ ★ 착지 시점의 현재 정체성. 접수 시점이 아니다.
let drifted = staged.preview.diff(&landed);   // 그 사이 폴백·외부 리비전이 끼어든 필드
```

세 줄 규약:

| 항목 | R1 | **R2** |
|---|---|---|
| 예약분의 형태 | 정체성 전체 | **패치 + base_revision + preview(표시 전용)** |
| 여러 번 오면 | 전체 교체 | **필드별 병합**(last-write-wins). `pendingOp: 'merge'(기본) \| 'replace' \| 'cancel'`로 명시 가능 |
| 착지 계산 | 접수 시점 값 사용 | **착지 시점 `self.identity`에 패치를 다시 얹어 재정규화** |

전체 교체를 병합으로 바꾼 이유는 따로 있다: 사용자가 턴 중에 "계정 바꿈" → "모델 바꿈"을
연달아 하면, 전체 교체는 **두 번째가 첫 번째를 조용히 삼킨다**(두 번째 요청의 base가
`self.identity`인데 첫 요청은 아직 적용 전이므로 계정 변경이 사라진다). 병합은 둘 다 산다.

**착지 브로드캐스트**: `origin: 'deferred_apply'` + `driftedFields`. 드리프트가 있으면 UI가
한 문장을 더 붙인다 — *"계정만 바꿨고, 모델은 자동 전환값(Opus 5)을 유지했어요"* + [모델도 되돌리기]
(그 버튼이 `identity_revert`). 폴백을 진짜 무르고 싶은 사용자에게 명시 경로가 있고,
아무것도 안 하면 **최근 사실(폴백)이 이긴다** — "마지막에 관측된 것이 진실"이라는 D6의 원칙과 같다.

`preview != landed`인데 사용자가 그걸 못 보고 지나가는 경우가 없도록, 드리프트가 있으면
브로드캐스트를 **토스트로 승격**한다(조용한 반영 금지 — D7).

### 4.3 채널·페이로드 초안 (protocol.ts)

> **★R2 — `ChatRef` 삭제, 주소는 `chatId` 문자열 하나** (리드 확정 · 크리틱 §4 판정)
>
> 근거 셋(전부 크리틱이 코드로 대조한 것): ① M-UX가 스토어를 `chats/` 하나로 접는 순간
> `surface`가 실어 나르는 정보량은 **0비트**다. ② **이 문서 자신이 `surface`를 한 번도 쓰지 않는다** —
> 58전이·명령 판정표·원장 규칙·큐/hold 규칙 어디에도 `surface` 분기가 없다. ③ 남기면 팝아웃/창 이동으로
> 같은 `ChatRuntime`이 `{multi,X}`→`{session,X}`로 **주소가 변해** 브로드캐스트 구독자가 이벤트를 놓친다
> (2.6.2 토스트 키 `` `${surface}:${id}${sub}` ``가 정확히 그 버그 계열이다 — `notify.ts:38`).
>
> **과도기 어댑터에 필요한 것은 옛 채널명이지 공용 주소 타입이 아니다.** 옛 채널은 각자 자기 인자를 갖는다
> (`ma:*`→`panelId`, `session:*`→창 wcId, `claude:*`→인자 없음=활성 채팅). 그래서 별칭 계층에는
> **함수 3개**만 둔다 — 타입이 아니다:
>
> ```ts
> // src/main/legacy/chatAlias.ts — 과도기에만 산다. 코어는 이 파일을 모른다.
> function panelIdToChat(panelId: string): ChatId   // `${sessionId}::${slot}` → chatId
> function wcIdToChat(wcId: number): ChatId         // 창 레지스트리 역인덱스
> function activeChat(): ChatId                     // 옛 claude:* 의 대상(활성 채팅 세션 상태)
> ```
>
> `surface`가 필요하다고 느껴지는 자리가 남으면 그건 **창 라우팅**이며, 답은 창 레지스트리의
> `chatId → [label]` 역인덱스다(M-UX 소관).

```ts
export const IPC = {
  …
  // ── M-LOGIC: 채팅 실행 상태 (주소 = chatId 하나. 표면 구분 없음) ──
  chatIdentityGet:    'chat:identity-get',    // (chatId) → ChatIdentityState
  chatIdentitySet:    'chat:identity-set',    // (IdentitySetCmd) → IdentityVerdict
  chatIdentityRevert: 'chat:identity-revert', // (chatId, revision) → IdentityVerdict
  chatIdentityEvent:  'chat:identity',        // main→renderer 브로드캐스트 (전 창)
  chatQueueMutate:    'chat:queue-mutate',    // (QueueMutateCmd) → CommandVerdict
  chatQueueEvent:     'chat:queue',           // 브로드캐스트 — 큐 전체 REPLACE
  chatRunStateEvent:  'chat:run-state',       // 브로드캐스트 — 상태기계 상태 + 라이브 원장 REPLACE
  chatForceSettle:    'chat:force-settle',    // (chatId, liveItemId) → CommandVerdict  ★강제 해제
  chatVerdictEvent:   'chat:verdict',         // 브로드캐스트 — 거부/큐잉 사유(토스트·인라인 안내용)
} as const

/** 채팅 주소 — 표면 무관. 전역 유일 문자열 하나가 전부다. */
export type ChatId = string

export interface IdentitySetCmd {
  chatId: ChatId
  patch: RawIdentity                    // 부분 지정 — 미지정 필드는 현재 값 유지
  applyPolicy?: 'now' | 'after_turn' | 'ask_if_costly'  // 생략 = 'ask_if_costly'
  /** 예약분(pending) 처리 방식 — §4.2-b. 생략 = 'merge' */
  pendingOp?: 'merge' | 'replace' | 'cancel'
  /** 낙관적 UI가 자기 요청의 브로드캐스트를 알아보게 하는 상관 id */
  corrId?: string
}

export type IdentityVerdict =
  | { kind: 'applied'; identity: RunIdentity; revision: number; effects: IdentityEffects }
  | { kind: 'deferred'; at: 'turn_end' | 'next_stream'; identity: RunIdentity; effects: IdentityEffects }
  | { kind: 'needs_confirm'; identity: RunIdentity; effects: IdentityEffects; confirmToken: string }
  | { kind: 'rejected'; reason: IdentityRejectReason; message: string }
  | { kind: 'noop' }

export interface IdentityEffects {
  willRespawn: boolean
  threadReset: boolean
  /** 재스폰으로 정리될 라이브 항목들 — 문장에 그대로 쓴다("워크플로 2개, 셸 1개") */
  killsLive: Array<{ kind: LiveKind; count: number }>
  changed: IdentityField[]              // RunIdentity.diff() 결과 — 필드 추가에 자동 대응
}

export type IdentityRejectReason =
  | 'account_unavailable' | 'api_key_missing' | 'cwd_missing' | 'engine_unavailable' | 'chat_gone'

/** 브로드캐스트 — 렌더러 picker의 유일한 진실 소스 */
export interface ChatIdentityEvent {
  chatId: ChatId
  identity: RunIdentity
  /** 예약분 — `identity`는 **미리보기**(접수 시점 계산). 착지값은 재정규화된다(§4.2-b) */
  pending: { identity: RunIdentity; at: 'turn_end' | 'next_stream'; baseRevision: number } | null
  revision: number
  origin: 'user' | 'engine_fallback' | 'deferred_apply' | 'revert' | 'restore' | 'default'
  /** origin='engine_fallback'일 때만 — 배너·되돌리기 UI 재료 */
  fallback?: { fromModel: string; toModel: string; cause: FallbackVia; revertTo: number }
  /** origin='deferred_apply'일 때만 — 미리보기와 착지값이 갈린 필드(§4.2-b). 있으면 토스트로 승격 */
  driftedFields?: IdentityField[]
  corrId?: string
}

/** 폴백 신호 3경로 — 합류 규약은 §6.2. 리비전은 전환당 정확히 1개다. */
export type FallbackVia = 'dialog' | 'refusal_frame' | 'model_delta'
```

### 4.4 Rust 초안

```rust
pub enum ApplyPolicy { Now, AfterTurn, AskIfCostly }

pub enum IdentityVerdict {
    Applied  { identity: RunIdentity, revision: u32, effects: IdentityEffects },
    Deferred { at: DeferPoint, identity: RunIdentity, effects: IdentityEffects },
    NeedsConfirm { identity: RunIdentity, effects: IdentityEffects, token: ConfirmToken },
    Rejected { reason: IdentityRejectReason, message: String },
    Noop,
}

impl ChatRuntime {
    pub fn set_identity(&mut self, patch: RawIdentity, policy: ApplyPolicy, op: PendingOp)
        -> IdentityVerdict
    {
        if op == PendingOp::Cancel {
            return match self.pending_identity.take() {
                Some(_) => { self.broadcast(Origin::User); IdentityVerdict::Applied { .. } }
                None    => IdentityVerdict::Rejected { reason: NoPending, .. },
            };
        }
        // 미리보기는 "지금 적용하면 이렇게 된다" — 표시 전용.
        let preview = match RunIdentity::normalize(self.identity.patched(&patch), &self.defaults) {
            Ok(v) => v, Err(e) => return IdentityVerdict::Rejected { reason: e.reason(), message: e.to_string() },
        };
        if preview == self.identity && self.pending_identity.is_none() { return IdentityVerdict::Noop }
        let effects = self.effects_of(&preview);        // will_respawn / kills_live / changed
        match (self.stream_state(), policy) {
            (S::Idle | S::Resident(_), ApplyPolicy::AskIfCostly) if effects.is_costly()
                => IdentityVerdict::NeedsConfirm { .. },
            (S::Idle | S::Resident(_), _) => self.apply_now(preview, Origin::User),
            _ => {
                // ★R2: 정체성 전체가 아니라 **패치를 누적**한다(§4.2-b). 착지에서 재정규화.
                let staged = self.pending_identity.get_or_insert_with(|| Staged::new(self.revision()));
                match op {
                    PendingOp::Replace => staged.patch = patch,
                    _                  => staged.patch.merge_fields_from(patch), // last-write-wins
                }
                staged.preview = preview;
                IdentityVerdict::Deferred { at: DeferPoint::TurnEnd, .. }
            }
        }
        // 어느 갈래든 마지막에 broadcast(ChatIdentityEvent) — 판정이 전 창에 보인다
    }

    /// §3.4 착지. **접수 시점 값이 아니라 지금 값에** 패치를 얹는다 — 폴백이 살아남는 자리.
    fn land_pending(&mut self) -> Option<()> {
        let staged = self.pending_identity.take()?;
        let landed = RunIdentity::normalize(self.identity.patched(&staged.patch), &self.defaults)
            .unwrap_or_else(|e| { self.emit_reject(e); return_current(self) });
        let drifted = staged.preview.diff(&landed);
        self.apply_now(landed, Origin::DeferredApply { drifted });
        Some(())
    }
}
```

> ▶ **죽이는 병리**: P2(3벌 사본 → 진실 1벌 + 뷰), P3(엔진이 렌더러를 뒤에서 바꾸는 경로 제거),
> P4(계정 변경의 타이밍 규약 부재 → 판정표로 명문화).

---

## 5. D8/D9 — 라이브 항목 원장과 고아 정리

### 5.1 원장의 대상 — "진행 중"으로 보이는 것 전부

| `LiveKind` | 출처 프레임(전이) | 2.6.2 대응 (**소유 계층**) | 리스 | Alive를 줄 수 있는 프로브(§5.4) |
|---|---|---|---|---|
| `Workflow` | F15/F13 | `wfSnaps`·`liveWorkflows` (**엔진**) | 90s | ② 신선 REPLACE 멤버십 · ③ `task_progress` 하트비트 · ④ 전사 mtime |
| `BgShell` | F13 (`task_type: /bash\|shell/i`) | `liveBgIds` (**엔진**) | 90s (+턴종료 5s 유예) | ② 신선 REPLACE 멤버십 · ④ `outputFile` mtime |
| `BgAgent` | F13 (비-셸·비-워크플로) | `liveBgAgents` (**엔진**) | 10분 | ② 신선 REPLACE 멤버십 · ④ `projects/<slug>/<session>/subagents/**` mtime (`engine.ts:685-713` 이식) |
| `Subagent`(포그라운드) | F7/F8/F14 (`Task` tool_use ↔ tool_result) | `this.subagents` (**엔진**) | 턴 수명 | 부모 도구 카드 생사(스트림 종속) |
| `AskCard` | T4 | `permissionWaiters`/`questionWaiters` (**엔진**) | **무한(단 스트림 소유)** | 없음 — 스트림 종속 |
| `RunningTool` | F7 ↔ F11 | `this.tools` (**엔진**) | 턴 수명 | 없음 — 스트림 종속 |
| `CmdCard` | 슬래시 명령 카드(running) | `pendingCommand` (**렌더러 리듀서** `session.ts:78`) | 턴 수명 | 없음 — 스트림 종속 |
| `StreamingMsg` | F2/F6 | `curTextId` (**렌더러 리듀서**) | 턴 수명 | 없음 — 스트림 종속 |
| `Thinking` | F3/F4 | `thinkingText` (**렌더러 리듀서** `session.ts:86`) | 턴 수명 | 없음 — 스트림 종속 |
| `PendingSettle` | F13(목록 이탈)/F17 | `pendingSettles` (**엔진**) | 10분 | ③ 프레임 흐름(어떤 프레임이든) |

> **★R2 — 소유 계층 표기의 의미 (크리틱 L10)**: 아래 셋은 2.6.2에서 **엔진이 아니라 렌더러
> 리듀서 상태**다 — `pendingCommand`(`src/renderer/src/store/session.ts:78`) ·
> `thinkingText`(`:86`) · `curTextId`. 엔진 소스에는 `pendingCommand`/`thinkingText` 식별자가 **0건**이다.
> 이 셋을 Rust 원장(`CmdCard`/`Thinking`/`StreamingMsg`)으로 올린다는 것은
> **O2(렌더러 세션 리듀서 소유권 이전)가 선택이 아니라 선행 조건**이라는 뜻이다.
> R1의 §11 구현 순서엔 그 의존이 없었다 — R2에서 2.5단계로 박았다.
> 이 셋만 원장에서 빼고 렌더러에 남기는 절충도 가능하지만, 그러면 "UI에 진행 중인 모든 것은
> StreamId 소유"(D8)가 깨져 말풍선/사고 표시가 스트림 급사 때 굳는 옛 버그가 남는다.

### 5.2 항목 타입

```rust
pub struct LiveItem {
    pub id: LiveId,                 // 프레임의 task_id / tool_use_id / request_id
    pub kind: LiveKind,
    pub owner: StreamId,            // ★ 소유자는 스트림. run_id 아님(P9)
    pub born_run: RunId,            // 어느 턴에서 생겼나(표시용)
    pub label: String,
    pub liveness: Liveness,         // Observed | Unverified | Settling
    pub lease_until: Instant,       // 무증거 허용 한계
    pub last_evidence: Instant,     // 마지막 증거(프레임·멤버십·mtime) 시각
    pub gating: Gating,             // 이 항목이 사용자 조작을 막을 자격이 있는가 (§5.5)
}

pub enum SettleReason {
    Completed, Failed { message: String },
    Stopped { by_user: bool },              // 셸 칩 중지 / CLI 자체 중지
    TurnEnded,                              // 턴 종료 정리(백그라운드 셸 5s 유예 착지)
    IdentityChanged { diff: Vec<IdentityField> },
    ThreadChanged,
    Cancelled,                              // stop_all
    StreamClosed { cause: CloseCause },     // CliExit | Crash | AppQuit | ExternalKill
    Watchdog,                               // 리스 만료 + 증거 실패 → "알 수 없음(정리됨)"
    ForcedByUser,                           // 강제 해제
}
```

**표시 규약**: `Completed`만 "완료". `TurnEnded`/`StreamClosed`/`Watchdog`은
**"정리됨"** + 사유 부제("엔진이 종료돼서" / "응답이 없어서"). 사용자에게 다른 정보다.

### 5.3 스킵 불가 정착 — `StreamGuard`

```rust
/// 스트림이 어떻게 끝나든(정상·에러·패닉·취소·앱종료) 이 Drop이 원장을 비운다.
/// 2.6.2의 `if (this.activeRunId === runId)` 같은 **조건부 정리는 존재하지 않는다** —
/// 원장은 StreamId로 색인되므로 "내가 최신인가"를 물을 필요가 없다(P9).
pub struct StreamGuard {
    id: StreamId,
    ledger: Arc<Mutex<LiveLedger>>,
    sink: EventSink,
    cause: Arc<Mutex<CloseCause>>,   // 종료 직전에 원인을 채운다(기본 Crash)
}
impl Drop for StreamGuard {
    fn drop(&mut self) {
        let cause = *self.cause.lock();
        for item in self.ledger.lock().drain_owned_by(self.id) {
            self.sink.emit(settle_event(&item, SettleReason::StreamClosed { cause }));
        }
        self.sink.emit(Event::RunState { state: StreamState::Ended, live: vec![] }); // 빈 REPLACE
        self.sink.emit_terminal_status_once();   // 종결 status 1회 보장 (engine.ts:1865-1876 파리티)
    }
}
```

**추가 안전망**(프로세스 밖에서 죽는 경우): 앱 부팅 시 저장본을 읽어 `running` 항목이 있으면
`StreamClosed{AppQuit}`로 정착시키고 **그 사유를 표시**한다. 2.6.2의
`snapshotForPersist`(`session.ts:199-203`)는 조용히 `stopped`로 내렸다 — 사용자는 왜 사라졌는지
몰랐다. 3.0은 "앱이 종료돼 정리됨" 배지를 남긴다.

### 5.4 워치독 — 1차 리스는 **프레임 최신성**이다 (★R2 전면 재설계 — 크리틱 L2)

#### (a) R1이 자기 간판을 무력화한 지점

R1 §5.4의 프로브 목록 1번은 이랬다: *"① **CLI 프로세스 생존**(가장 강력 — 죽었으면 T22가 이미 처리)"*.
의사코드는 `match probe(item) { Alive → lease 재장전 … }`.

그런데 **P8의 정의 자체가 "프로세스는 살아 있는데 워크플로가 외부에서 죽어 알약이 굳는다"**이다
(폴트표의 `freeze{ms}` = "프로세스는 살아 있는데 프레임이 전혀 안 옴 — **P8 본체**").
프로브 ①이 Alive를 돌려주면 **리스가 무한 재장전**되어 `liveness=unverified`로도, `Watchdog` 정착으로도
가지 못한다. 즉 **P8을 죽인다는 워치독이 정확히 P8 조건에서만 발화하지 않았다.**
재생 7b의 시각표(90s 리스 만료 → 프로브 실패 → unverified → 30분 → settle)는 R1 문면으로는 성립하지 않았다.

#### (b) 프로브 등급 — 무엇이 무엇을 판정할 수 있는가

```rust
pub enum ProbeVerdict { Alive, Dead, Unknown }

/// 프로브는 "무슨 판정을 낼 자격이 있는지"가 등급으로 고정된다.
/// 등급 밖 판정은 타입이 막는다 — Alive를 못 내는 프로브는 Alive 배리언트를 만들 수 없다.
pub trait Probe {
    const CAN_SAY_ALIVE: bool;
    const CAN_SAY_DEAD:  bool;
}
```

| # | 프로브 | Alive 판정 | Dead 판정 | 신선도 창 | 비고 |
|---|---|---|---|---|---|
| ⓪ | **CLI 프로세스 생존** | **✗ 절대 불가** ★ | ✓ (죽었으면 즉시 전원 정착) | — | **P8의 정의가 "프로세스는 살아 있다"이다.** 생존은 항목에 대해 **아무것도 말하지 않는다.** 실무상 Dead 경로도 T22(stdout EOF)가 먼저 잡으므로, 이 프로브는 **T22가 유실됐을 때의 백스톱**으로만 남는다 |
| ① | **프레임 최신성**(1차 리스) | ✓ | ✗ | `lease(kind)` | 그 항목을 **지목한** 프레임(F13 멤버십·F15/F16 `task_id`·F12 통지 배달·F17)이 도착하면 `last_evidence = now` |
| ② | **최신 REPLACE 멤버십** | ✓ **단 REPLACE 자체가 신선할 때만** | ✓ (신선한 REPLACE에 없으면 Dead) | `replace_seen_at`가 60s 이내 | ★ 여기가 R1의 두 번째 함정이었다. `freeze` 중엔 새 REPLACE가 **안 온다** → 마지막 REPLACE는 35분 전 것 → **stale = Alive 근거 아님**(Unknown) |
| ③ | **`task_progress` 하트비트** | ✓ | ✗ | 90s | F16(workflow_progress 없는 하트비트)도 여기서 값을 한다 — 보드로는 안 올리지만 리스는 재장전한다 |
| ④ | **파일 mtime** (`subagents/**`, 셸 `outputFile`) | ✓ | ✗ | 10분 | `engine.ts:685-713` 이식(최대 400개 얕은 스캔). **조용한 dev 서버를 살리는 유일한 근거** |
| ⑤ | 사용자 강제 해제 | ✗ | ✓ (`ForcedByUser`) | — | §5.5-3 |

**LiveKind × 프로브 자격표** — 각 항목이 Alive를 받을 수 있는 경로를 못박는다(빈칸 = 그 프로브 없음):

| `LiveKind` | ① 프레임 | ② REPLACE | ③ 하트비트 | ④ mtime | `lease` | `hard_limit` |
|---|---|---|---|---|---|---|
| `Workflow` | ✓ | ✓ | ✓ | ✓(전사) | 90s | 30분 |
| `BgShell` | ✓ | ✓ | | ✓(outputFile) | 90s (+5s 유예) | 30분 |
| `BgAgent` | ✓ | ✓ | | ✓(subagents/**) | 10분 | 60분 |
| `PendingSettle` | ✓ | | | | 10분 | 10분 |
| 턴 수명 항목(`AskCard`·`RunningTool`·`CmdCard`·`StreamingMsg`·`Thinking`·`Subagent`) | | | | | **스트림 종속** | 없음(T22/T25가 거둔다) |

#### (c) 루프

```
매 tick(5s):
  # 1차 리스 = 프레임 최신성. 프로세스가 살아 있다는 사실은 여기 없다.
  for item in ledger.evidence_bearing():
     if now < item.lease_until { continue }

     # 리스 만료 — 조용한 게 정상일 수 있다. 등급 있는 프로브만 묻는다.
     match probe_chain(item) {           # ②→③→④ 순, ⓪은 Alive를 낼 수 없어 목록에 없다
        Alive  => { item.last_evidence = now; item.rearm(); }
        Dead   => settle(item, Watchdog),
        Unknown=> {
           item.liveness = Unverified;            # ★ 여기서 이미 게이팅 자격 상실(§5.5)
           if now - item.last_evidence > hard_limit(item.kind) { settle(item, Watchdog) }
        }
     }

  # 원장이 워치독으로 비었으면 confidence를 낮추고, close_input은 하지 않는다.
  if ledger.is_empty() && ledger.last_removal_was_watchdog() {
     ledger.confidence = Unverified;
     state = Resident{Unverified};                # T21 — T20(관측된 빔)과 다른 자리
  }
```

**세 줄 규약 (이게 L2의 답이다)**

1. **프로세스 생존은 리스를 재장전하지 못한다.** `last_evidence`를 움직일 수 있는 것은
   ①②③④뿐이다. 프로세스 핸들은 `ProbeVerdict::Alive`를 만들 수 없다(타입 수준).
2. **생존 + 무프레임 `lease`초 → `Unverified`**(게이팅 즉시 해제), **+ `hard_limit` → 정착**.
   `freeze{35분}`에서 90s에 게이팅이 풀리고 30분에 알약이 사라진다 — 재생 7b가 성립한다.
3. **워치독 정착은 프로세스를 회수하지 않는다.** 추정으로 빈 원장(`confidence=Unverified`)은
   `close_input()`을 유발하지 않고 `Resident{Unverified}`로 남는다(T21). 관측으로 빈 원장
   (CLI가 직접 보낸 빈 REPLACE)만 T20으로 프로세스를 거둔다.

#### (d) 왜 3번 규약이 필요한가 — 조용한 dev 서버 문제

2.6.2가 "워크플로/셸이 살아 있으면 타이머를 아예 안 건다"고 결정한 이유는 **틀리지 않았다**:
dev 서버·긴 빌드 단계는 몇십 분 조용한 게 정상이다(`engine.ts:676-680` 주석).
잘못된 건 결론("그럼 감시하지 말자")이었다.

R2는 **감시하되 회수하지 않는다**로 쪼갠다:

| | 2.6.2 | R1 | **R2** |
|---|---|---|---|
| 조용한 워크플로 30분 | 알약 유지, UI 잠김(P8) | 정착 + `close_input` | **알약 정착(UI 해제) + 프로세스 유지** |
| 실제로 죽은 워크플로 | 영원히 유령 | 정착 | 정착 |
| 진짜 도는 dev 서버 | 산다 | **죽는다**(R1의 숨은 회귀) | mtime(④)이 있으면 알약도 산다. 없으면 알약만 정리되고 **서버는 산다** |
| 완전히 행(hang)한 CLI | 영원히 | 30분 | 30분에 알약 정리, **6h**(T32 `stream_idle_limit`)에 프로세스 회수 |

`Resident{Unverified}`의 UI는 알약이 아니라 **한 줄 안내**다:
*"백그라운드 진행 상태를 알 수 없어 표시를 정리했어요. 엔진은 아직 살아 있습니다 — [엔진 정리]"*.
[엔진 정리] = `stop_all`. **막지 않고, 알리고, 손잡이를 준다** — D9의 형태 그대로.

> ▶ **죽이는 병리**: P8-4(감시 공백). 조용한 항목은 **증거로** 살리고(①②③④), 증거가 없으면
> 게이팅 자격부터 뺏고(90s), 그래도 없으면 정착시킨다(30분). 그리고 **정착이 프로세스 살해를
> 뜻하지 않게** 회수 경로를 분리했다 — R1이 P8을 고치다 새로 만들 뻔한 회귀다.

### 5.5 게이팅 자격 — D9

```rust
pub enum Gating {
    /// 이 항목은 사용자 조작을 막을 수 있다 — 단 §3.6 표에서 ⚠️(확인 카드)까지만.
    MayWarn,
    /// 절대 막지 못한다. 표시만.
    NeverBlocks,
}
```

규칙 세 줄:

1. **`liveness != Observed`인 항목은 어떤 조작도 막지 못한다.** (증거 없는 항목이 UI를 잠그는 게
   P8의 본질이다.)
2. **사이드바 이동(`switch_chat`/`new_chat`)은 어떤 항목도 막지 못한다.** 실행은 채팅에 붙어
   있으므로 뷰 이동과 무관하다.
3. **막는 곳(⚠️)에는 항상 강제 해제가 있다.** `chat:force-settle` — 항목을
   `ForcedByUser`로 정착시키고 "강제로 정리함(실제 프로세스는 남아 있을 수 있음)"을 표시한다.
   워크플로 알약·셸 칩·서브에이전트 카드의 컨텍스트 메뉴에 상시 노출.

> ▶ **죽이는 병리**: P8 전체. 유령 알약이 생겨도 ① 사이드바는 안 잠기고 ② 알약은 30분 내
> 스스로 정착하며 ③ 그 전에도 우클릭 한 번으로 치울 수 있다. **재시작이 유일한 탈출구가 아니다.**

### 5.6 브로드캐스트 — 상태 + 원장은 REPLACE

```ts
export interface ChatRunStateEvent {
  chatId: ChatId
  state: 'idle' | 'starting' | 'streaming' | 'awaiting_user' | 'held_result'
       | 'interrupting' | 'resident' | 'terminating'
  //  ★ 'ended'가 없는 이유: T26이 같은 tick에서 idle로 내보낸다(§3.6 8열 각주).
  /** state==='resident'일 때만 — 표시 문구가 갈린다(§3.2) */
  residentWhy?: 'live_items' | 'unverified' | 'linger' | 'keep_open'
  runId: string | null
  /** 살아있는 항목 전체 — REPLACE 의미(2.6.2 bg-tasks 규약을 원장 전체로 확장) */
  live: Array<{
    id: string; kind: LiveKind; label: string
    liveness: 'observed' | 'unverified'
    gating: 'may_warn' | 'never_blocks'
    bornRunId: string
  }>
  /** 원장이 **관측으로** 비었나 **추정으로** 비었나 — §5.4-c 3번 규약의 UI 재료 */
  ledgerConfidence: 'observed' | 'unverified'
  /** 이번 이벤트에서 정착한 항목들 — 사유를 UI가 문장으로 만든다 */
  settled: Array<{ id: string; kind: LiveKind; reason: SettleReasonWire }>
}
```

REPLACE로 두는 이유: 에지(추가/삭제) 기반은 **한 프레임만 놓쳐도 영구 불일치**가 된다.
`protocol-claude-cli.md` §9-②가 지목한 순서 의존성 위험을 구조적으로 우회한다 —
**레벨 신호가 진실, 에지는 장식.**

### 5.7 컨트롤 RPC 대기자 회계 — 늦게 온 응답 (★R2)

재생 #8의 단언 *"지연된 `control_response`는 버려진다(unmatched LRU)"*는 **SDK의 규약**이다
(`protocol-claude-cli.md:389-392` — 1024개 LRU). Rust가 직접 컨트롤 채널을 몰면 **우리가 구현할 규약**이
되는데 R1 본문에 없었다(크리틱 §5 #8).

```rust
pub struct ControlWaiters {
    pending:   HashMap<RequestId, oneshot::Sender<ControlResponse>>,  // 우리가 보낸 요청
    unmatched: LruCache<RequestId, ()>,                               // cap 1024 — SDK 파리티
}
```

규약 넷:

1. **스트림 종료 = 전원 취소.** `StreamGuard::drop`이 `pending`을 비우며 각 대기자에게
   `Cancelled{StreamClosed}`를 준다. 이게 없으면 `oneshot` 수신부가 영원히 매달린다.
2. **모르는 `request_id`의 응답은 조용히 버린다** + `unmatched`에 기록. `unmatched`는
   진단용이지 재시도용이 아니다(로그에 "늦게 온 응답 N건"으로 뜬다).
3. **중복 응답은 멱등.** 두 번째는 2번 경로로 간다(패닉 금지 — 재생 폴트 `duplicate`가 상시 검증).
4. **우리가 받은 요청**(`can_use_tool` 등)의 응답은 `AskCard` 원장이 소유한다. 카드가 이미
   정착했으면(T6 회수·T22 급사) 응답 전송을 **시도하지 않는다** — 닫힌 stdin에 쓰면 EPIPE다.

---

## 6. D6 — 폴백은 보이는 상태 전이

### 6.1 리비전 원장

```rust
pub struct IdentityRevision {
    pub n: u32,
    pub at: SystemTime,
    pub identity: RunIdentity,
    pub origin: RevisionOrigin,   // User | EngineFallback{..} | DeferredApply | Revert{to} | Restore | Default
    pub note: Option<String>,     // "Fable 5 정책 거부로 Opus 5 전환" 등 사람이 읽는 한 줄
}
```

`revisions`는 채팅 파일에 **최근 20개**만 영속(무한 성장 방지).

### 6.2 전이 (T29) — 신호 **셋**의 합류 규약 (★R2 — 크리틱 L4)

2.6.2는 폴백 신호가 **세 경로**이고 두 장치로 합류시킨다:

| 경로 | 코드 | 합류 장치 |
|---|---|---|
| A. `request_user_dialog(refusal_fallback_prompt)` **수락** | `engine.ts:999` `pendingFallbackNotices++` (+`:1013` `curModelDisplay` 갱신) | 카운터 |
| B. `system/model_refusal_fallback` 프레임 | `engine.ts:1334-1338` `if (pendingFallbackNotices > 0) --` | 카운터 |
| C. `assistant.message.model` 변화(메인) | `engine.ts:1660-1675` `curModelDisplay` 비교 | 미러 변수 |

R1의 T29는 B와 C만 적고 **합류 규칙이 없었다** → 한 번의 폴백에 리비전 2개·배너 2개가 난다
(메모리에 남은 "사이드체인 배너 핑퐁" 사고와 같은 계열). 게다가 A는 **사용자가 수락해야** 전환되는데,
R1의 T5는 카드 응답을 "정착 `Answered`"로만 적어 **응답이 정체성을 바꾼다는 사실이 상태기계 어디에도
없었다.**

**R2 합류 장치 — 상태 둘로 셋을 받는다** (`ChatRuntime.fallback_armed` + `observed_model`):

```rust
pub struct FallbackArm {
    to_model: ModelId,
    via:      FallbackVia,   // Dialog | RefusalFrame | ModelDelta
    at_seq:   FrameSeq,      // 중복 판정 창(같은 턴 안)
}
```

| 신호 | 조건 | 결과 |
|---|---|---|
| **A** `respond_dialog(refusal_fallback_prompt, **accept**)` (§3.6 표의 새 행) | — | **리비전 생성**(origin=`EngineFallback{via:Dialog}`) + `fallback_armed = {to_model, Dialog}` + `observed_model = to_model` |
| **A'** 같은 카드에 **decline** | — | **리비전 없음**, `fallback_armed` 없음. CLI가 no-dialog 기본동작(거부 에러로 턴 종료)을 적용한다 |
| **B** `system/model_refusal_fallback{fallback_model}` | `fallback_armed.to_model == fallback_model` | **소비만 한다**(리비전·배너 없음) — 2.6.2 카운터 감산 파리티 |
| **B'** 같은 프레임 | `fallback_armed` 없음 | **리비전 생성**(via=`RefusalFrame`) + arm 설정 |
| **C** 메인 `assistant.message.model = m` | `m == observed_model` | **아무것도 안 한다** |
| **C'** 같은 관측 | `m != observed_model` ∧ `fallback_armed.to_model == m` | **미러만 갱신**(`observed_model = m`) — 이미 A/B가 리비전을 냈다 |
| **C''** 같은 관측 | `m != observed_model` ∧ arm 없음/불일치 | **리비전 생성**(via=`ModelDelta`) + arm 설정 |
| — | 프레임에 `parent_tool_use_id` 있음(**사이드체인**) | 전부 **무시**(§6.5 — 핑퐁 사고의 원인) |

`fallback_armed`는 **턴 종료(§3.4)에서 해제**한다. 다음 턴에 또 폴백이 나면 그건 새 전환이다.

**불변식**: *한 번의 모델 전환 = 리비전 정확히 1개 = 배너 정확히 1개.*
재생 시나리오 #2와 상시 회귀 #19(3경로 6순열)가 이걸 상시 검증한다.

**전이 절차** (어느 경로로 왔든 리비전을 만들기로 결정된 뒤):

1. `identity.engine.model`을 새 값으로 하는 **리비전 생성**(`origin: EngineFallback{via}`).
2. `chat:identity` 브로드캐스트(`fallback: { fromModel, toModel, cause: via, revertTo }`).
3. 스레드에 인라인 배너 + **[되돌리기]** — `chat:identity-revert(revertTo)`.
4. 그 다음 턴은 **정체성이 실제로 바뀌었으므로** 재스폰 사유가 `IdentityChanged{['engine']}`로
   정직하게 뜬다. 2.6.2처럼 "사용자가 안 바꿨는데 설정이 바뀌었다는 안내"가 나오지 않는다 —
   **바꾼 주체가 기록돼 있다**("모델 자동 전환 때문에 새 프로세스로 시작했어요").
5. 턴 중에 예약된 `pending_identity`가 있으면 §4.2-b가 이 리비전을 **덮지 않는다**(패치 재정규화).

### 6.3 되돌리기의 의미

`revert(n)`은 리비전 n의 정체성으로 **새 리비전**을 만든다(히스토리 삭제 아님).
`Resident`에서 되돌리면 §4.2의 비용 예고가 똑같이 붙는다.

> ▶ **죽이는 병리**: P3(뒤에서 바뀌는 picker·되돌릴 수 없음·엉뚱한 안내 문구).

---

## 7. D5 — 예약 큐와 한도 대기(자동 이어서)

### 7.1 큐 항목 = 프롬프트 + **정체성 스냅샷**

```ts
export interface QueuedMessage {
  id: string
  text: string
  attachments: string[]
  /** 예약한 순간의 확정 정체성 — 이 값으로 나간다(기본 정책) */
  identity: RunIdentity
  identityRev: number
  /** 예약 시점의 스레드 의도 — 'continue'(resume) | 'fresh'(폴더 바뀜 등) */
  thread: 'continue' | 'fresh'
  /** 드리프트 정책: 예약 후 채팅 정체성이 바뀌었을 때 */
  onDrift: 'keep_snapshot' | 'use_current' | 'ask'
  createdAt: number
  origin: 'user' | 'limit_resume' | 'viewer_ask' | 'notif_replay'
}
```

- **드리프트 표시**: `identity.hash !== chat.identity.hash`면 큐 칩에 배지
  ("예약 당시 설정: Fable 5 · a@x") + [현재 설정으로 바꾸기].
- **기본값 `keep_snapshot`**: "예약할 때 보던 대로 나간다"가 사용자의 기대다.
  2.6.2가 절반만 지키던 약속(P5)을 **전 필드**로 확장한다.
- 큐는 **Rust 소유 + 채팅 파일에 영속**. 창을 닫아도, 앱을 껐다 켜도 남는다
  (복원 시 `origin` 유지, 사용자가 지울 수 있게 항상 표시).

### 7.2 드레인은 상태기계의 일부 (T27)

```
drain_if_possible():
   if stream_state != Idle && !matches!(stream_state, Resident{..}): return  # T16 주입은 Resident에서만
   if hold.is_some() && !hold.ready:                    return         # 한도 대기 게이트
   if queue.is_empty():                                 return
   let m = queue.front();
   match reuse_decision(m.identity, m.thread):          # 좌변 = stream.spawn_identity
       Reuse            => T16 (주입)
       Respawn { why }  => T17/T18 (사유 동봉 정리 후 T1)
       ColdStart        => T1
```

**드레인은 항목마다 판정한다 — 그래서 재스폰도 항목마다 날 수 있다** (★R2 — 크리틱 §5 #4-②).
큐 항목은 저마다 정체성 스냅샷을 들고 있으므로(D5), 정체성이 섞인 큐는 **드레인 도중 재스폰이
여러 번** 날 수 있다. 이건 버그가 아니라 "예약할 때 보던 대로 나간다"의 대가다. 다만
**말없이 비싸면 안 된다** — 세 가지로 정직해진다:

1. **연속 동일 정체성은 한 스트림에서 연속 주입한다**(배칭). `[A A B A]`는 재스폰 3회가 아니라
   `A A`(1스폰) → `B`(2스폰) → `A`(3스폰). 드레인 전에 `queue.group_by(identity_hash)`로 계획을 세운다.
2. **드레인 시작 전에 계획을 브로드캐스트한다**: `chat:queue{ plan: [{count, identityHash, willRespawn, killsLive}] }`.
   UI 한 줄: *"대기 3건 — 2건은 새 프로세스로 시작합니다(진행 중 작업 1개 정리)"*.
3. **항목 칩의 드리프트 배지**(§7.1)와 같은 재료를 쓴다. 사용자는 드레인 전에
   [전부 현재 설정으로] 한 번으로 재스폰을 0으로 만들 수 있다.

**2.6.2의 `injectMiss='busy'` 특수 경로**(`engine.ts:487-502`: 15초 기다렸다 재주입)는
**사라진다** — 턴 진행 중의 `send`는 애초에 큐로 가고(§3.6), 턴이 끝나면 §3.4가 드레인을
부른다. 특수 경로가 없으면 특수 버그도 없다.

### 7.3 한도 대기 = 큐 게이트, 자동 이어서 = 큐 항목

```rust
pub struct LimitHold {
    pub engine: EngineId,
    pub account: BillingAxis,      // ★ 대기표도 정체성 축으로 식별 — 계정 바꾸면 이 표는 무효
    pub resets_at: Option<SystemTime>,
    pub verified_at: Option<SystemTime>,
    pub ready: bool,
    pub armed_from_run: RunId,
}
```

- **장전**: T30. **근거가 둘이고 신뢰도가 다르다**(★R2 — 크리틱 L6):

  | 순위 | 근거 | 상태 | 비고 |
  |---|---|---|---|
  | 1 | `rate_limit_event{status:"blocked"}` 프레임 | 🔶 **미관측** | 실측된 `rate_limit_event`는 `status:"allowed"` 한 종류뿐이다(`protocol-claude-cli.md:1056-1066`, 라이브 로그 `:1341`). blocked 모양은 **합성 픽스처**(`synth/rate-limit-blocked.jsonl`)의 가정이다 |
  | 2 | `result{is_error}` + **한도 문구 분류** | ✅ 실동작 | 2.6.2 `classifyLimitError`(`src/renderer/src/lib/limitResume.ts:38`)를 Rust로 이식 |

  R1은 *"**상태에서** 판정한다(2.6.2는 스레드 마지막 말풍선 텍스트를 읽었다 — P6)"*라고만 적어
  P6가 죽은 것처럼 보였다. **절반만 참이다.** 1순위 프레임이 실관측되기 전까지는 2순위가 실제 경로이고,
  그건 여전히 **문자열 분류**다. 다만 P6가 죽인 나머지는 그대로 산다 — 읽는 대상이
  *스레드 마지막 말풍선(화면 상태)*이 아니라 *`result` 프레임의 `error` 필드(와이어 상태)*이고,
  판정 주체가 렌더러 훅이 아니라 `ChatRuntime` 하나다. **열린 문제 O14**에 올린다.

- **정제/발화**: `resets_at + 90s`에 신선 usage 재검증(2.6.2 `useLimitResume`의 검증 규약 계승),
  아직 막혔으면 재장전.
- **소진**: `ready`가 되면 **큐 head에 `origin:'limit_resume'` 항목을 삽입**한다
  (세션이 있으면 "이어서" 프롬프트, 없으면 원문 재전송). 그리고 §7.2의 일반 드레인이 돈다.

  **재개 항목의 정체성** (★R2 — 크리틱 §5 #4-①, R1 미정의):
  ```
  identity      = chat.identity   (재개 **발화 시점**의 현재 값. 장전 시점 스냅샷이 아니다)
  identityRev   = chat.revision
  onDrift       = 'use_current'
  thread        = 'continue'
  ```
  근거: 사용자가 대기 중에 모델·폴더를 바꿨다면 "지금 이걸로 이어서"가 기대다. 계정을 바꾸면
  애초에 대기표가 무효화되므로(아래) 계정만은 항상 일치한다. 그래서 재개 항목은 **뒤따르는
  큐 항목들과 정체성이 다를 수 있고**, 그 경우 §7.2의 드레인 계획이 재스폰 횟수를 미리 알린다.

- **해제**: 이 채팅에서 새 실행이 시작되면(수동 전송 포함) 해제. **`interrupt`/`stop_all`도 해제**한다
  (§7.4 — 안 그러면 "중지했는데 몇 시간 뒤 혼자 이어서 보낸다"가 된다).
- **계정/정체성 변경 시**: `hold.account != identity.billing`이면 대기표를 **무효화**하고
  UI에 알린다("계정을 바꿔서 대기표를 취소했어요"). 2.6.2는 계정을 바꿔도 옛 계정 기준으로
  재검증하고 옛 계정으로 재전송했다.

### 7.4 중단과 큐 — "비움 + 안내 + 되돌리기" (★R2 — 크리틱 L1)

R1은 T13/T14/T23·§3.4·§3.6 어디에도 큐 효과를 안 적었다. 설계대로 구현하면 **Esc 직후 §3.4가
드레인을 불러 큐 head가 자동 전송**된다 — 2.6.2에는 없는 **새 버그**다
(`App.tsx:901-908` `cancelRun`은 두 갈래 모두 끝에서 `setQueue([])`; Esc가 그 경로를 탄다 `:918-928`).

```rust
pub struct QueueUndo {
    items:      Vec<QueuedMessage>,   // 순서·정체성 스냅샷 그대로
    hold:       Option<LimitHold>,    // 같이 해제한 대기표
    token:      UndoToken,
    valid_until: Instant,             // 다음 성공 send 또는 5분, 둘 중 먼저
}
```

| 시점 | 동작 |
|---|---|
| T13(`interrupt`) · T23(`stop_all`) · T34(spawn 취소) | ① `queue`를 통째로 `queue_undo`로 옮긴다 ② `hold`가 있으면 같이 담고 해제 ③ `chat:queue` REPLACE(빈 목록) 브로드캐스트 ④ `chat:verdict{ kind:'queue_cleared', count, holdCancelled, undoToken }` |
| UI | 인라인 한 줄: *"대기 3건과 자동 이어서 대기를 취소했어요 — [되돌리기]"*. 조용히 버리지 않는다(D7) |
| `queue.restore(token)` | 순서·정체성 스냅샷·`origin` 그대로 복원 + `hold`도 복원. **드레인은 자동으로 돌지 않는다**(사용자가 다시 보내야 한다 — 되돌리기가 곧 전송이면 위험하다) |
| 무효화 | 다음 성공 `send` 또는 5분 경과. 무효화되면 토큰이 만료돼 `rejected{undo_expired}` |

**왜 "보존"이 아니라 "비움"인가**: 사용자가 중지를 누를 때의 기대는 *"지금 것도, 다음 것도 멈춰"*다
(2.6.2가 그렇게 동작하고, Esc와 중지 버튼이 같은 코드를 탄다). 보존을 기본으로 하면 중지 후
매번 "큐도 비울까요?" 확인이 붙어 클릭이 늘고, 확인을 안 붙이면 자동 전송 버그가 그대로다.
**왜 "조용한 비움"이 아닌가**: 3.0 큐는 **영속**이고 항목마다 정체성 스냅샷을 품는다.
조용히 버리면 P5보다 큰 손실이다. 그래서 되돌리기 토큰이 붙는다.

> ▶ **죽이는 병리**: P5(정체성 절반만 스냅샷), P6(별개 행위자·ref 경합·창 닫으면 증발·
> 화면 텍스트 판정), 그리고 "예약 큐 + 한도 소진" 조합(필수 시나리오 #4)이 **한 곳에서**
> 직렬화돼 재생 테스트가 가능해진다.

---

## 8. 2.6.2 병리 ↔ 설계 대응표

| 병리 | 근거 | 죽이는 설계 | 한 줄 |
|---|---|---|---|
| P1 손 비교 10필드 | `engine.ts:1185-1196` | D1 | 비교가 `a == b` 한 줄이 되고, 정규화는 생성자 1곳, 필드 추가는 골든 테스트가 강제 |
| **P1e 빠진 축 4개** | `engine.ts:762`·`:846`·`:758`·`:761` | D1 §2.2 | API 키 지문·`drop_env_key`·`skillOverrides`·`deniedMcpServers`를 정체성으로 흡수 — "껐는데 안 꺼짐"·"옛 키로 과금"이 재스폰으로 드러난다 |
| P1b addDirs 순서 민감 | 같은 곳 | D1 §2.3 | `BTreeSet<CanonPath>` — 순서·중복·대소문자가 재스폰을 못 만든다 |
| P1c 재스폰 사유 뭉개짐 | `injectMissReason='opts'` | D1 §2.1 | `IdentityChanged{diff}` vs `ThreadChanged`로 분리 — 안내 문구가 정직해진다 |
| P1d outputStyle 전역 누수 | `engine.ts:1196` | D1 §2.4 | 채팅에 물질화 — 다른 채팅의 설정 변경이 이 상주를 못 끊는다 |
| P2 picker 3벌 | `App.tsx:157`·`newChatMeta`·`:1059` | D2 | 진실 1벌(Rust) + 뷰 — 렌더러 `setPicker`는 브로드캐스트 수신자로만 남는다 |
| P3 폴백이 picker를 뒤에서 변경 | `App.tsx:465-475` | D6 | 리비전 + 배너 + 되돌리기. "누가 바꿨는가"가 기록된다 |
| P4 계정 변경 규약 부재 | `protocol.ts:505`, `engine.ts:1819` | D4 §4.2 | 상태별 판정표 — 지금/턴 끝/거부 중 하나가 **반드시** 응답되고 보인다 |
| P5 예약 큐 절반 스냅샷 | `Chat.tsx:237-242` + `App.tsx:1058-1079` | D5 §7.1 | 전 필드 스냅샷 + 드리프트 배지 + 정책 선택 |
| P6 한도 이어서 = 별개 행위자 | `useLimitResume.ts`, `App.tsx:1118` | D5 §7.3 | 큐 게이트 + 큐 항목으로 흡수 — 행위자 하나, 경합 없음 |
| P7 침묵 no-op | `App.tsx:774,799,811,918` | D7 §3.6 | 전 상태×전 명령 표에 빈칸 없음. 거부엔 사유 문자열 |
| P8 고아 유령(실버그) | `App.tsx:144` + `engine.ts:726-733` | D8·D9 | 증거 프로브 워치독 + 게이팅 자격 + 강제 해제 + 사이드바 절대 비잠금 |
| P8b 정리 스킵 | `engine.ts:1826` 가드 | D8 §5.3 | 원장을 StreamId로 색인 → `Drop`이 무조건 정착. "최신인가"를 안 묻는다 |
| P8c 재시작만이 탈출구 | `session.ts:199-203` | D8 §5.3 | 부팅 정착에 **사유 표시**("앱이 종료돼 정리됨") + 런타임 정착 경로 신설 |
| P9 소유권이 run에 묶임 | `activeRunId === runId` | D3 §3.1 | 소유자는 스트림. 턴은 스트림 안의 구간일 뿐 |
| 순서 의존성(위험 #2) | `protocol-claude-cli.md` §9-② | D8 §5.6 + D10 | 레벨(REPLACE) 우선 + 재생 하네스로 순서 뒤섞기 테스트 |
| 상주 특수 경로(`injectMiss='busy'`) | `engine.ts:487-502` | D5 §7.2 | 큐로 흡수 — 15초 대기 휴리스틱 삭제 |
| 소프트 중단 꼬임 루프 | `engine.ts:432-459` | D3 T13~T15 | 표의 3행으로 명시 + 재생 시나리오 #6·#7이 상시 검증 |
| 통지 삼킴 | `engine.ts:1149-1168` | D3 T12 | 상태(`HeldResult`) + 1회 제한 불변식 |
| 종결 status 누락 | `engine.ts:1865-1876` | D8 §5.3 | `Drop`에서 `emit_terminal_status_once()` — 스킵 불가 |
| **폴백 신호 3경로 합류 없음** | `engine.ts:999`·`:1334-1338`·`:1660-1675` | D6 §6.2 | `fallback_armed` + `observed_model` 둘로 셋을 받는다 — 전환당 리비전·배너 정확히 1개 |
| **정리 턴이 같은 run_id 왕복** | `engine.ts:1259-1268` | D3 T19b | CLI 자발 기상 턴은 **새 `run_id`** — 재생 불변식 #3이 정상 동작을 빨간불로 잡지 않는다 |
| **컨트롤 대기자 회계 부재**(Rust 신규) | SDK 1024 LRU (`protocol §4.2`) | D8 §5.7 | 스트림 종료=전원 취소, 미매칭=조용히 버림, 중복=멱등 |

---

## 9. D10 — 회귀 하네스 (요약)

상세: **`docs/design/m-logic-replay.md`**.

- **재료**: `scripts/poc-rs`가 남긴 실와이어 `%TEMP%\ccg-poc-rs\*.jsonl`
  (`smoke`·`approve`·`approve-noid`·`ask`·`park`·`interrupt`·`resume-1..3-fork`)를
  `crates/ccg-engine/tests/fixtures/wire/`로 **박제**(import 스크립트 제공) +
  `docs/protocol-claude-cli.md` §5 사전으로 손합성한 프레임(워크플로·백그라운드·통지·한도 —
  실계정 없이 만들 수 있다).
- **구동**: `FakeCli`(프레임 재생 + 폴트 주입) + **가상 시계**(모든 타이머는 주입된 `Clock`).
  프로세스 스폰 없음 → **$0, 결정적, CI 가능**.
- **폴트**: `StreamClose` · `Freeze(무프레임)` · `KillProcess` · `AppQuit` ·
  `ReorderFrames(정착↔통지 순서 뒤집기)` · `DropFrame`.
- **단언**: ① 방출 이벤트 시퀀스 ② 최종 상태 ③ **라이브 원장이 비었는가** ④ 정착 사유
  ⑤ 정체성 리비전 ⑥ 큐 잔량 ⑦ **busy가 풀렸는가**(모든 시나리오 공통 단언).

| # | 시나리오 | 재현하는 병리 | 핵심 단언 | R2 종이 재생 |
|---|---|---|---|---|
| 1 | 계정 변경 중 턴 시작 (+1b 셸 심음) | P4 | 진행 턴은 옛 계정 유지, 판정=`deferred`, 턴 끝에 적용 브로드캐스트 1회. **1b**에서만 `Respawn{IdentityChanged[billing]}` | ✅ 온전 |
| 2 | 폴백 직후 계정 변경 | P3+P4 | 리비전 3개(Default→EngineFallback→DeferredApply), 착지에서 **폴백 model 유지**, 재스폰 사유=`IdentityChanged{engine,billing}` | ✅ 온전 |
| 3 | busy 중 채팅 전환 | P7 | 전환 성공 + 실행 계속 + 두 채팅의 `run-state`가 독립 | ✅ 온전(단 O2 한계 명시) |
| 4 | 예약 큐 있는 상태에서 한도 소진→자동 이어서 | P5+P6 | 대기 중 드레인 0건, 해제 후 **큐 순서 보존**, 재개 항목이 head(정체성=현재값), 이중 전송 없음, 드레인 계획 브로드캐스트 1회 | ✅ 온전 |
| 5 | 중단 직후 재개 (5a `KeepOpen` / 5b `OnIdle`) | 소프트 중단 | **5a**: 픽스처 그대로 3턴·재스폰 0·session_id 불변. **5b**: 출하 기본값에서 `Terminating{AllClear}`→ColdStart+`--resume` | ✅ 온전 |
| 6 | 백그라운드 살아있는 상태의 중단 | 위험 #2 (**PoC 미검증 구간**) | 셸/워크플로가 중단으로 죽지 않음, 원장 유지, `Resident{LiveItems}` 착지, **큐는 비워짐** | ✅ 온전 |
| 7 | 워크플로 도는 중 CLI 강제 종료 (+7b freeze/7c force/7d idle) | **P8 유령** | 원장 전부 `StreamClosed{ExternalKill}` 정착, `wf` 알약 소멸, 게이팅 해제, busy 해제 | ✅ 온전(7b가 L2 수정으로 성립) |
| 8 | 승인 카드 뜬 채 CLI 사망 | P8+대기자 누수 | `AskCard` 정착 `StreamClosed`, 카드 닫힘, 종결 status 1회, 대기자 0, 늦은 응답은 §5.7 규약으로 폐기 | ✅ 온전 |

추가 상시 시나리오(회귀 방지): 9. 정착↔통지 **순서 뒤집기**(위험 #2) · 10. 무음 result 슬라이딩
보류 → 진짜 턴 도착 · 11. 통지 삼킴 재주입 1회 제한 · 12. `addDirs` 순서만 다른 재전송 =
**재스폰 없음** · 13. 전역 outputStyle 변경이 다른 채팅 상주를 끊지 않음 ·
**19. 폴백 3경로 6순열 = 리비전 1개** · **20. 중단이 큐를 비우고 되돌리기가 복원** ·
**21. 워치독이 프로세스 생존만으로 재장전되지 않음**(L2 회귀 잠금) ·
**22. `skillOverrides` 토글 = 재스폰**(P1e 회귀 잠금).

---

## 10. 열린 문제 (리드가 닫아야 함)

| # | 문제 | 왜 열려 있나 | 제안 |
|---|---|---|---|
| **O1** | **M-UX 접점** — "패널=뷰, 실행은 채팅에 붙는다"를 이 문서는 **가정**했다. `docs/design/ux-chat-unify.md`(병행 설계)가 다른 소유 모델을 쓰면 §3.6의 `switch_chat` 전 상태 ✅가 무너진다 | 두 설계가 동시 진행 | 통합 시 **소유 모델을 먼저 합의** — 이 문서는 "실행 상태는 `ChatRuntime`" 외의 어떤 가정도 안 한다 |
| **O2** | 렌더러 세션 리듀서의 소유권 — 2.6.2는 리듀서 **1개**를 채팅들이 갈아탄다(`load(snapshot)`). 채팅 전환 중 실행 계속을 지원하려면 리듀서가 채팅별이거나, Rust가 스냅샷을 밀어야 한다 | 렌더러 대공사 | M-UX와 함께 결정. 대안: Rust가 `chat:run-state` + 스레드 이벤트를 채팅 id로 태깅해 보내고 렌더러는 맵으로 보관 |
| **O3** | 팝아웃 창 소유권 이전 규약(2.6.2 `#mapanel`)이 Rust 단일 소유에서 **필요 없어진다**. 다만 초안(draft)·스크롤 등 순수 UI 상태는 여전히 이전 필요 | 기존 규약과 충돌(크리틱 U5 — 두 문서가 서로를 근거로 든다) | **M-LOGIC 쪽 확정 문장**: 큐 드레인·`hold` 타이머·자동 재개 전송은 **창과 무관하게 `ChatRuntime`이** 돌린다 — `Chat.owner` 같은 창 소유 축은 이 세 가지에 대해 **존재하지 않는다**. 창이 0개여도 돈다. 이전이 필요한 것은 **초안·이미지 초안·스크롤 위치·유령 셀 표시**뿐이고 그건 렌더러 소유다. M-UX가 `owner`를 남기려면 그 범위를 이 세 가지 **밖**으로 한정해야 한다 |
| **O4** | `Codex` 축 파리티 — `EngineAxis::Codex`의 정규화(모델 id 공간·`codexAccount`·`CODEX_HOME` 격리)를 Claude와 같은 규칙으로 접을 수 있는지 미확인 | Codex 드라이버는 M4 | M4 착수 전 `RunIdentity` 확장으로 검증. 필드 추가는 골든 테스트가 잡아준다 |
| **O5** | `output_style` 물질화 시 **기존 사용자 데이터 마이그레이션** — 2.6.2 채팅엔 그 필드가 없다 | 앱 홈 호환(ARCH §확정4) | 로드 시 전역 pref로 채우고 리비전 `origin:'restore'` 기록 |
| **O6** | 강제 해제 UI 위치·문구(알약 우클릭? WorkBar 칩 메뉴? 설정에 "정리" 버튼?) | UI 소관 | M-UX. 규약만 고정: **막는 곳엔 반드시 있다** |
| **O7** | 백그라운드 셸 **5s 유예**의 실제 값 — 2.6.2 관측치이지 계측치가 아니다 | 미실측 | M3 라이브 PoC 1회(셸 백그라운드화 → 턴 종료 → REPLACE 이탈까지 ms 계측) |
| **O8** | `resume`/`fork`를 정체성에서 뺀 결정과 **/btw 포크** 규약의 상호작용(`forkSession`은 첫 실행 1회만) | /btw는 2.6.0 기능 | `ThreadLink { forked_from, fork_consumed }`를 스레드 쪽에 두면 정합. 이식 시 재확인 |
| **O9** | **위험 #2(상주 회계 순서 의존성)는 여전히 미해소**다. 크리틱 판정: "백그라운드가 살아 있는 상태의 interrupt는 한 번도 시험되지 않았다"(`docs/critic/m3-poc.md` §3 범위 한정) | 라이브 PoC 부재 | 시나리오 #6·#9를 **재생으로 먼저** 통과시키고, M3에서 라이브 1회(셸 + 중단 + 재전송) |
| **O10** | `AwaitingUser`에 카드가 **여러 개**(병렬 도구 승인)일 때 `deferred` 정체성 적용 시점 | 와이어상 동시 다발 가능(`§8.2`) | "마지막 카드 응답 후 턴 종료"가 적용점 — 표의 §3.4가 이미 커버하나 UI 표시는 미정 |
| **O11** | 큐 영속 시 **첨부 파일 경로**의 수명(temp 파일이 지워질 수 있음) | 2.6.2도 미해결 | 드레인 시 존재 확인 → 없으면 항목을 `rejected{attachment_missing}`로 정착 |
| **O12** ★R2 | **마이그레이션 필드 집합이 M-UX와 어긋난다**(크리틱 L7 후단) — ux §5.2는 `{engine, account, codexAccount, api}` + `mcpOverrides`/`skillOverrides`, 여기 골든 목록은 8필드. 그대로 구현하면 마이그레이션 PoC가 **반드시 실패** | 두 문서가 다른 축을 얼렸다 | §2.3 각주의 규약 채택 — 검증은 원시 필드가 아니라 `RunIdentity::hash()` **하나**로. 매핑은 M-UX, 비교 대상은 M-LOGIC. **리드 확정 필요** |
| **O13** ★R2 | `StreamClosePolicy` 출하 기본값 — `OnIdle`(메모리 안전·재스폰 2~4s)이냐 `Linger{n초}`(응답성)냐 | `claude.exe` 상주 실측 337MB × 채팅 수 | 기본 `OnIdle`로 출하하고, `Linger`는 M3 라이브 PoC에서 "상주 1개당 RSS·재스폰 지연" 실측 후 결정. 재생은 두 정책 모두 커버(#5a/#5b) |
| **O14** ★R2 | **한도 장전 1순위 프레임이 미관측**(크리틱 L6) — `rate_limit_event{status:"blocked"}`를 아무도 본 적이 없다. 실제 경로는 여전히 **문구 분류**(P6 잔재) | 한도를 일부러 소진해야 관측 가능 | ① 합성 픽스처로 1순위 경로를 미리 짜 두고 ② 2순위(문구 분류)를 **출하 경로**로 구현 ③ 실사용 로그에 `rate_limit_event` 전량 덤프를 걸어 blocked 모양이 잡히면 wire로 승격 |
| **O15** ★R2 | **와이어에 있는 싼 경로를 안 쓴다**(크리틱 L8) — `set_permission_mode` / `set_model` / `apply_flag_settings` / `set_max_thinking_tokens`가 앱→CLI 요청으로 **존재하는데**(`protocol-claude-cli.md:486-492`) 2.6.2도 3.0 초안도 "변경 = 재스폰"이다. 문서 서두가 인용한 사용자 고통이 **안내 문구만 정직해질 뿐 사라지지 않는다** | 4개 전부 **라이브 미관측 🔶**(`:1366`) | M3 라이브 PoC 1턴(`set_model` 왕복 + 그 뒤 turn이 새 모델로 도는지)으로 닫는다. 성공하면 `mode`·`model`·`effort`·`output_style`은 정체성에서 **"싼 축"**으로 강등 — 재스폰 없이 `apply_*`로 반영하고 `spawn_identity`만 갱신. 실패하면 O15를 "영구 제약"으로 문서화 |
| **O16** ★R2 | `stream_idle_limit`(T32) 6시간이 맞는 값인가 | 근거 없는 첫 숫자 | dev 서버를 켜 두는 실사용 세션 길이를 텔레메트리 없이 알 수 없다. 초기값 6h + 설정 노출(`고급 ▸ 유휴 엔진 회수`)로 출하하고 실사용 피드백으로 조정 |

---

## 11. 구현 순서 (M3와 맞물림)

**★R2 재배치**: 크리틱 §8 지시대로 **7b(freeze 워치독)를 첫 빨간 테스트**로 올렸고,
O2(렌더러 리듀서 소유권) 의존을 2.5단계로 명시했다(크리틱 L10).

1. `crates/ccg-engine`: `identity.rs`(D1) + 골든 테스트 — **엔진 코드보다 먼저**.
2. `live.rs`(D8 원장·`StreamGuard`·§5.4 워치독) + `clock.rs`(가상 시계).
   → **첫 빨간 테스트 = 재생 7b**: `freeze{35분}`에서 `90s → unverified → 30분 → Watchdog →
   Resident{Unverified}` 시각표가 가상 시계로 정확히 재현되는가. 이게 게이트다.
   같은 라운드에 **L1(중단이 큐를 비운다 · §7.4)**과 **L3(`pending`은 패치 · §4.2-b)**을 닫는다 —
   둘 다 "새로 만드는 버그"라 나중에 고치면 그 위에 코드가 쌓인다.
3. `state.rs`(D3 전이표 A+B) — 아직 CLI 없이 `FakeCli`로.
   `tests/frame_coverage.rs`가 §3.7 사영표(24행)를 기계 검사한다.
   2.5. **O2 착지**: `CmdCard`/`Thinking`/`StreamingMsg`를 Rust 원장으로 올리려면 렌더러
   세션 리듀서 소유권 이전이 **선행**돼야 한다(§5.1 각주). M-UX와 같이 결정 — 안 되면
   그 셋만 렌더러에 남기는 절충안을 명시적으로 채택하고 D8 범위를 문서에서 좁힌다.
4. `m-logic-replay.md`의 시나리오 1~8을 **빨간 테스트로** 커밋(7b는 2단계에서 이미 초록).
5. `ccg-claude` 드라이버를 그 상태기계에 **끼운다**(프레임→전이 매핑은 §3.7 표 그대로).
6. `protocol.ts` 채널 9개 + 렌더러 picker를 뷰로 전환(D2·D4) — M-UX와 착지 조율(O1·O12).
7. 큐·한도 대기의 Rust 이관(D5) — `useLimitResume`은 표시 전용 훅으로 축소.
8. M3 라이브 PoC 3건으로 O14(한도 프레임)·O15(`set_model` 싼 경로)·O7(셸 5s 유예)를 닫는다.

**M3 게이트 추가 조건**: 위 4번의 8시나리오가 전부 초록이 아니면 M3를 "완료"로 부르지 않는다.

---

## 12. 크리틱 R1 대응표 (전수)

`docs/critic/design-r1.md` §2(M-LOGIC 구멍 L1~L12) · §3(인용 오류) · §4(ChatRef 판정) ·
§5(8조합 종이 재생) 전부에 대해 **어디서 무엇을 했는지**.

| 지적 | 판정 | R2 처리 | 위치 |
|---|---|---|---|
| **L1** 중단이 예약 큐를 안 비운다 | 인정(새 버그) | "비움 + 안내 + 되돌리기 토큰" 채택. T13/T23/T34 액션·§3.6 명령표·`queue.restore` 행 신설 | §7.4, §3.3 T13/T23/T34, §3.6 |
| **L2** 워치독이 P8 조건에서 발화 안 함 | 인정(**간판 거짓**) | 1차 리스를 **프레임 최신성**으로. 프로세스 생존은 `CAN_SAY_ALIVE=false`(타입 수준). REPLACE는 **신선할 때만** Alive. LiveKind×프로브 자격표. 추가로 "정착 ≠ 프로세스 회수" 분리(R1의 숨은 dev 서버 회귀) | §5.4 전체 |
| **L3** deferred 전체 교체가 폴백을 되돌린다 | 인정(새 버그) | `Staged{patch, base_revision, preview}` + 착지 재정규화 + 필드별 병합 + `driftedFields` 토스트 | §4.2-b, §4.4 |
| **L4** 폴백 신호 셋인데 합류 규약 없음 | 인정 | `fallback_armed` + `observed_model` 2상태로 3경로 합류. 전환당 리비전·배너 1개. `respond_dialog` 명령 행 신설 | §6.2, §3.6 |
| **L5** 전이표가 프레임 절반만 소화 | 인정 | 표를 A(수명 36)/B(프레임 소화 22)로 쪼개고 §3.7에서 §8.4 **24행 전수 사영**(빈칸 0) + 기계 검사 | §3.3, §3.3-B, §3.7 |
| **L6** 한도 장전 근거 프레임 미관측 | 인정 | 근거 2순위 표로 신뢰도 명시. "P6가 절반만 죽었다"를 본문에 적고 **O14** 신설 | §7.3, O14 |
| **L7** RunIdentity에 스폰 전용 축 4개 누락 | 인정 | P1e 신설 + `BillingAxis{key_fp, drop_env_key}`·`ToolPolicyAxis`·`Codex{account}` 흡수. 골든 목록에 `tools` 추가. M-UX 충돌은 **O12**로 리드 회부 | §1 P1e, §2.2, §2.3, O12 |
| **L8** 와이어의 싼 경로(`set_model` 등) 미사용 | 인정 | **O15** 신설 + M3 라이브 PoC 1턴으로 닫는 절차 명시 | O15, §11-8 |
| **L9** `Resident` interrupt 파리티 후퇴 | 인정 | ⚠️ 제안 → **✅ 즉시 bg 전체 중지**로 복원(2.6.2 `App.tsx:901-908` 파리티). 정직성은 결과 통지로 | §3.6 변경 1 |
| **L10** LiveKind 3종은 렌더러 리듀서 | 인정 | 소유 계층 열 추가(`session.ts:78`·`:86`) + **O2를 §11의 선행 조건(2.5단계)**으로 승격 | §5.1 각주, §11 |
| **L11** 불변식 #3이 정상 동작을 잡는다 | 인정 | T19/T19b가 **새 `run_id`** 발급. `run_id` 발급 지점 4곳으로 고정 | §3.3 T19b, §3.5 |
| **L12** 명령표가 8상태(9라 적음) | 인정 | `Ended`가 명령을 못 받는 이유를 각주로 명문화(T26 즉시 이탈·이벤트 열거형에 없음) | §3.6 |
| **인용 #1** P1 "11개 필드" | 오류 | **10개**로 정정 + 실 목록 나열 | §1 P1 |
| **인용 #2** P5 `systemPrompt` 행 | **허수** | 행 삭제. 세터 0건임을 근거와 함께 적고, 실제로 새는 P1e 3축으로 교체 | §1 P5 |
| (자체 발견) `session.ts:210-221` = `effectiveStatus` | 부정확 | `:219-221`이 `effectiveStatus`, `:210-217`이 `bgActive`로 분리 표기 | §3.2 |
| (자체 발견) `engine.ts:1185-1200` | 범위 넓음 | 비교식은 `:1185-1196`. `:1197-1200`은 `injectMissReason` 처리 | §1 P1, §8 |
| (자체 발견) §8.4 매핑표 행 수 | 크리틱이 22행이라 셈 | 실 카운트 **24행**(`protocol-claude-cli.md:1525-1548`) | §3.7 |
| **§4 판정** `ChatRef` 삭제 | 리드 확정 | 타입 삭제, 4채널·3이벤트 페이로드를 `chatId`로. 어댑터는 **함수 3개**(타입 아님) | §4.3, §5.6 |
| **§5 재생** 불가 3(#1·#2·#5)·부분 2(#4·#7) | 인정 | #1→#1/#1b, #2→L3+L4로 성립, #4→재개 항목 정체성·드레인 계획 정의, #5→`StreamClosePolicy` 축으로 픽스처와 화해, #7b→L2로 성립. **8/8 온전** | §3.4-b, §7.2, §7.3, `m-logic-replay.md` §8 |
