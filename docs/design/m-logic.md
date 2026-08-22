# M-LOGIC — 채팅/실행 상태 정리 (3.0.0 기반 설계)

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
| **D3 명시적 상태기계** | 스트림 1개 = 상태기계 1개(9상태·31전이). 2.6.2의 암묵 규약(소프트 중단·무음 보류·통지 재주입·상주·5s 셸 유예·compact)이 전부 **표의 한 줄**로 존재. |
| **D4 설정 변경 = 명령** | `chat:identity-set` → Rust가 `applied` / `deferred(턴 끝)` / `rejected(사유)` 중 하나로 **판정을 돌려주고 브로드캐스트**. 판정이 UI에 보인다. |
| **D5 예약 큐는 Rust 소유 + 정체성 동봉** | 큐 항목마다 `identity` 스냅샷. 드레인·한도 대기·재개가 **한 곳**에서 직렬화된다. |
| **D6 폴백 = 보이는 상태 전이** | 엔진 자동 전환은 **정체성 리비전**을 만들고(origin=EngineFallback) 배너 + "되돌리기"를 준다. |
| **D7 침묵 no-op 금지** | 모든 명령은 `accepted` / `queued` / `rejected{reason}` 중 하나를 **반드시** 돌려준다. 표로 정의. |
| **D8 라이브 항목 원장** | UI에 "진행 중"인 모든 것은 **StreamId 소유**. 스트림이 죽으면 파생 항목 전부 **사유와 함께** 정착. 항목마다 리스·증거·워치독. |
| **D9 사용자 조작 게이팅 금지** | **생사 관측이 가능한 항목만** 조작을 막을 수 있고, 막는 곳엔 항상 **강제 해제**가 있다. 사이드바 이동은 절대 막지 않는다. |
| **D10 재생 회귀 하네스** | 실와이어 프레임 + 가상 시계 + 폴트 주입으로 상태기계를 오프라인($0)에서 때린다. 필수 8조합. |

---

## 1. 병리 — 2.6.2에서 실제로 무엇이 깨지는가

전부 코드로 확인했다. 아래 P#는 이후 모든 설계 결정이 참조하는 번호다.

### P1. `optsMatch` = 손으로 비교하는 11개 필드

`src/main/claude/engine.ts:1185-1200`

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
- 정규화가 필드마다 제각각이다: `?? null`, `.trim()`, `!!`, `JSON.stringify`. 새 필드를 넣는
  사람이 이 규칙을 재발명한다. `addDirs`는 **순서만 달라도 불일치** → 불필요한 재스폰
  (= 살아있던 워크플로·셸·에이전트 전부 사망, `engine.ts:568-583`가 사후 안내만 한다).
- `nreq.resume === bgSessionId`가 **정체성과 대화 스레드를 한 비교에 섞는다.** 결과적으로
  "설정이 바뀌어서 새 프로세스"와 "다른 대화라서 새 프로세스"가 같은 사유(`'opts'`)로 뭉개진다.
- `claudeOutputStyle()`은 **비교 시점에 디스크를 읽는다** — 전역 pref다. 다른 채팅에서 스타일을
  바꾸면 이 채팅의 상주가 다음 메시지에 조용히 끊긴다.

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
| **addDirs** | `refDirs.filter(...)` (라이브) | ❌ |
| **useApi** | `apiMode` (라이브 전역) | ❌ |
| **systemPrompt** | 채팅 메타(라이브) | ❌ |
| **outputStyle** | 메인이 디스크에서 읽음 | ❌ |
| resume | `state.session` (라이브) | ❌ (의도적) |

→ "예약할 때 보던 설정으로 나간다"가 **절반만 참**이다. 그리고 UI에는 예약 항목의 정체성이
표시되지 않는다.

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
    Codex  { model: CodexModelId, effort: EffortId },
}

/// 과금·자격 경로. `api_mode` 불리언 + `account` 문자열 두 필드로 두면
/// "useApi면 account 무시"라는 규칙이 비교식 밖에 남는다 → 하나로 접는다.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BillingAxis {
    /// 구독(OAuth) — 격리 CONFIG_DIR을 물질화할 계정. None = 기본 계정(정규화가 실 이메일로 채운다).
    Subscription { account: AccountEmail },
    /// 저장된 API 키로 과금. 계정 개념 없음.
    ApiKey,
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
| `billing` | `api_mode`면 `ApiKey`(계정 필드 소멸), 아니면 `Subscription{account: 실 이메일}`(미지정 → 기본 계정 해석) | "useApi면 account 무시"가 **타입으로** 표현됨 |
| `engine` | 엔진별 모델 id 공간 분리, `effort`는 엔진 축 안 | `codexModel`이 claude 정체성에 남지 않음 |
| `mode` | 그대로(닫힌 열거형) | — |

**골든 테스트**(필드를 몰래 늘리지 못하게):

```rust
#[test]
fn identity_field_set_is_frozen() {
    // 필드를 추가/삭제하면 이 테스트가 깨진다. 깨진 사람은 세 가지를 같이 해야 한다:
    //   (1) §2.3 정규화 규칙표에 행 추가  (2) 정규화 구현  (3) m-logic-replay.md 시나리오 추가
    let fields = json_field_names::<RunIdentity>();
    assert_eq!(fields, ["engine","billing","cwd","add_dirs","mode","system_prompt","output_style"]);
}

#[test]
fn identity_hash_is_stable_across_releases() {
    // 저장된 큐/리비전의 해시가 릴리즈 간에 살아야 한다
    assert_eq!(fixture_identity().hash().to_hex(), "…golden…");
}
```

> ▶ **죽이는 병리**: P1(손 비교 11필드·정규화 산재·순서 민감 addDirs·사유 뭉개짐).
> 비교식이 `a == b` 한 줄이 되고, 새 필드는 **컴파일/테스트가 강제**한다.

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
  | { engine: 'codex'; model: string; effort: EffortId }

export type BillingAxis =
  | { kind: 'subscription'; account: string } // 실 이메일 (기본 계정도 해석해 채운다)
  | { kind: 'api_key' }

/** 렌더러가 보내는 원시 정체성 — 부분 지정 가능(미지정 = 현재 값 유지). */
export interface RawIdentity {
  engine?: EngineAxis
  billing?: BillingAxis
  cwd?: string
  addDirs?: string[]
  mode?: ModeId
  systemPrompt?: string | null
  outputStyle?: string | null
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
  /** 16바이트 hex — 큐 항목·리비전·로그가 참조하는 키 */
  hash: string
}

export type IdentityField =
  | 'engine' | 'billing' | 'cwd' | 'addDirs' | 'mode' | 'systemPrompt' | 'outputStyle'
```

---

## 3. D3 — 명시적 상태기계

### 3.1 층위 — 무엇이 무엇을 소유하는가

```
ChatRuntime  (채팅 1개 = 인스턴스 1개, 앱 수명 동안 지속. Rust 소유)
 ├─ identity: RunIdentity                 ← 진실의 단일 소유자 (D2)
 ├─ pending_identity: Option<Staged>      ← 턴 끝에 적용될 예약분 (D4)
 ├─ revisions: Vec<IdentityRevision>      ← 폴백·수동 변경 이력 + 되돌리기 (D6)
 ├─ thread: ThreadLink { session_id, cwd_at_bind, forked_from }
 ├─ queue: VecDeque<QueuedMessage>        ← 정체성 스냅샷 동봉 (D5)
 ├─ hold: Option<LimitHold>               ← 한도 대기 = 큐 게이트 (D5)
 ├─ live: LiveLedger                      ← 진행 중 항목 원장 (D8)
 └─ stream: Option<Stream>                ← 지금 떠 있는 CLI 프로세스 0..1개
     └─ state: StreamState                ← ★ 이 절의 상태기계
        └─ turn: Option<Turn { run_id, seq_marks, … }>
```

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
| `Resident` | 턴 끝남. 살아있는 라이브 항목 때문에 프로세스 유지 | 산다 | 없음 | false (표시는 '작업 중') |
| `Terminating` | stdin EOF 또는 kill. **라이브 항목 정착 처리 중** | 죽는 중 | 없음 | false |
| `Ended` | exit 관측(또는 kill 상한 도달) + 원장 비었음 → 스트림 해제 | 없음 | 없음 | false |

- `busy` = **원시 상태**(전송 게이트용). `effectiveStatus`(표시용)는 `Resident`에서
  '작업 중'을 유지한다 — 2.6.2 `session.ts:210-221`의 규약을 그대로 계승.
  (메모리 '완료 표시 규칙': 완료 색은 bg까지 걷혀야, 토스트는 턴마다.)
- `Ended`는 스트림의 종단이고 채팅은 `Idle`로 돌아간다. 채팅은 죽지 않는다.

### 3.3 전이표 (31전이)

`W` = 워치독/타이머, `F` = CLI 프레임, `C` = 렌더러 명령, `X` = 외부 사건(프로세스/OS).

| # | From | 트리거 | 가드 | 액션 | To |
|---|---|---|---|---|---|
| T1 | `Idle` | C `send` / 큐 드레인 | `hold` 없음 ∧ 정체성 정규화 성공 | 정체성 확정 → job object에 자식 등록 → spawn → `initialize` → 첫 `user` 프레임. `status:analyzing` 즉시 방출(2.6.2 계약 보존) | `Starting` |
| T2 | `Starting` | F `control_response(initialize)` ∧ `system/init` | — | `session_id` 채택(**id 변화만** 새 세션으로 판정 — `m3-poc.md` §3), `thread` 바인드 | `Streaming` |
| T3 | `Starting` | W 20s 타임아웃 / X spawn 실패 | — | `notice` + `status:error`, 원장 정착(비어 있음) | `Terminating{SpawnFailed}` |
| T4 | `Streaming` | F `can_use_tool` / `request_user_dialog` / `AskUserQuestion` | — | 라이브 항목 `AskCard{request_id, tool_use_id}` 등록(소유=StreamId) | `AwaitingUser` |
| T5 | `AwaitingUser` | C `respond(permission\|question\|dialog)` | `request_id`가 이 스트림 것 | `control_response` 송신(**`toolUseID` 항상 동봉** — `ARCHITECTURE-3.0.md` M3 위험 #1), 카드 정착 `Answered` | `Streaming` |
| T6 | `AwaitingUser` | F `control_cancel_request` | — | 카드 정착 `Withdrawn`(CLI가 회수) — 사용자에게 "질문이 취소됨" 표시 | `Streaming` |
| T7 | `Streaming` | F `result` ∧ (턴 활동 있음 ∨ 결과 텍스트 있음) | — | `result` + 종결 `status` 1회 보장, `finish_wrap()` | §3.4 **턴종료 판정** |
| T8 | `Streaming` | F `result` ∧ 무음(활동X ∧ 텍스트X) | — | 종결 보류, 재장전 카운터 0 | `HeldResult` |
| T9 | `HeldResult` | F 활동 프레임 | — | 보류 취소, 미니턴 오판 복구(`turn_ended=false`) | `Streaming` |
| T10 | `HeldResult` | W 2.5s 슬라이딩 만료 | 재장전 < 8 ∧ (프레임 흘렀음 ∨ `delivered_notifs` 있음) | 재장전(+1) | `HeldResult` |
| T11 | `HeldResult` | W 재장전 소진(총 ~22s) | `delivered_notifs` 비었음 | 무음 턴으로 정착 + `notice(silent)` | §3.4 |
| T12 | `HeldResult` | W 만료 | `delivered_notifs` 있음 ∧ 활동 없음 ∧ **`replayed_once`=false** ∧ 중단 요청 없음 | **프롬프트 재주입**(`finish_wrap()` 먼저, 새 `run_id` 아님·같은 턴 연장) | `Streaming` |
| T13 | `Streaming`/`AwaitingUser`/`HeldResult` | C `interrupt` | — | ① 열린 카드 **전부 먼저 해제**(deny/null) → ② `control_request{interrupt}` (레이스 4s) | `Interrupting` |
| T14 | `Interrupting` | F `result`(`terminal_reason=aborted_*`) ≤6s | — | `interrupted` 마커, `interrupt_requested=true`(재주입 금지 표식) | §3.4 |
| T15 | `Interrupting` | W 6s 무응답 | — | 하드 강등 | `Terminating{HardCancel}` |
| T16 | `Resident` | C `send` | `identity_hash` 같음 ∧ `thread` 연속 | **주입**: 같은 stdin에 `user` 프레임, 새 `run_id`, 턴 불변식 리셋(§3.5) | `Streaming` |
| T17 | `Resident` | C `send` | 정체성 **불일치** | `stream_close{IdentityChanged{diff}}` 예고 이벤트 → 라이브 항목 전부 정착 사유 `IdentityChanged` | `Terminating` → T1 |
| T18 | `Resident` | C `send` | 스레드 **불일치**(폴더 변경·포크) | `stream_close{ThreadChanged}` — **사유가 T17과 다르다** | `Terminating` → T1 |
| T19 | `Resident` | F `user`(`<task-notification>`) | — | CLI 자발 기상 턴. `turn_from_cli=true`(T12의 삼킴 판정 재료) | `Streaming` |
| T20 | `Resident` | F `background_tasks_changed`(REPLACE) | 목록 비었음 ∧ `pending_settles` 없음 | `close_input()` — 지킬 게 없다 | `Terminating{AllClear}` |
| T21 | `Resident` | W **리스 만료 + 증거 프로브 실패**(§5.4) | — | 해당 항목 정착 `Unknown{watchdog}`; 남은 항목 0이면 T20 | `Resident`/`Terminating` |
| T22 | 임의(≠`Idle`) | X stdout EOF / 프로세스 exit | — | **원장 일괄 정착** `StreamClosed{cause}` — 스킵 불가(§5.3 `StreamGuard::drop`) | `Terminating{StreamClosed}` |
| T23 | 임의(≠`Idle`) | C `stop_all`(하드 취소) | — | `turn_ended=false`일 때만 interrupt(1.5s) → `close_input` → kill. 정착 사유 `Cancelled` | `Terminating{Cancelled}` |
| T24 | 임의 | X 앱 종료 | — | **아무것도 기다리지 않는다**. stdin 닫고 kill 신호, job object가 손자까지 보증. 원장은 디스크에 `AppQuit`로 정착 기록 | `Terminating{AppQuit}` |
| T25 | `Terminating` | X exit 관측 ∨ W kill 상한(2s→5s→SIGKILL) | 원장 비었음 | 스트림 해제, `run_boundary` 로그 | `Ended` |
| T26 | `Ended` | 즉시 | — | 채팅으로 제어 반환. `pending_identity` 있으면 적용(§4) | `Idle` |
| T27 | `Idle` | 큐 비어있지 않음 ∧ `hold` 없음 ∧ 앞선 스트림 `Ended` | — | 큐 head 소비 → **그 항목의 정체성 스냅샷**으로 T1 | `Starting` |
| T28 | `Streaming` | F `system/compact_boundary` | — | `compact_pending` 버퍼(다음 assistant 프레임과 짝지어 방출; 턴이 먼저 끝나면 `after=null`) | `Streaming` |
| T29 | `Streaming` | F `model_refusal_fallback` ∨ `message.model` 변화(메인 경로만) | 사이드체인 프레임 아님(`parent_tool_use_id` 없음) | **정체성 자동 리비전**(origin=`EngineFallback`) + `identity_changed` 브로드캐스트 + 인라인 배너 + 되돌리기 토큰(§6) | `Streaming` |
| T30 | `Streaming` | F `rate_limit_event` ∨ `result`가 한도 에러 | — | `hold` 장전(§7) — **큐 게이트만** 걸고 상태기계는 정상 종료 경로를 탄다 | §3.4 |
| T31 | `Resident`/`Idle` | C `identity_set`(즉시 적용) | 적용 가능(§4 판정) | 정체성 교체 + 리비전 기록. `Resident`면 "다음 메시지에 재스폰(백그라운드 N개 정리)" 예고 이벤트 | 같은 상태 |

### 3.4 턴종료 판정 (T7·T11·T14·T30의 공통 착지점)

```
turn_ended = true
finish_wrap()            # 정착 회계 (§6.6 프로토콜 문서 규약 그대로: 순번 비교 + deliveredNotifs 안전벨트)
pending_identity 있으면 → 적용 (§4 Deferred 착지)
live 원장에 항목 남았나?
  ├─ 예 → Resident        (+ 리스 재장전 §5.4 — ★ 2.6.2와 달리 "워크플로 있으면 타이머 없음" 아님)
  └─ 아니오 → close_input() → Terminating{AllClear}
그리고: 큐가 비어있지 않고 hold 없으면 → T16(주입) 또는 T17/T18(재스폰) 으로 즉시 이어짐
```

**백그라운드 셸 5s 유예**: 턴 종료 시 셸 항목은 `grace_until = now + 5s`가 붙는다(실측:
CLI가 턴 종료 직후 백그라운드 bash를 정리한다). 유예 안에 REPLACE에서 사라지면 정착 사유는
`TurnEnded`(≠`Completed`) — "끝남"이 아니라 "턴이 끝나서 정리됨"으로 표시한다. 유예를 넘겨
살아 있으면 정상 상주 항목으로 계속 추적한다.
> 유예 값 5s는 2.6.2 실사용 관측치다. **라이브 PoC로 재확인 필요** → §10 O7.

### 3.5 턴 불변식 (`Streaming` 진입마다 리셋 — 하나라도 빠지면 2.6.2 사고 재현)

`run_id` 새로 발급 · `turn_ended=false` · `interrupt_requested=false` · `saw_turn_activity=false`
· `held_result=None` · `rearms=0` · `turn_start_seq=frame_seq` · `replayed_once=false`
· 스트리밍 상태(`cur_text_id`/`thinking`/`streamed_this_msg`) 리셋 · `turn_from_cli` 갱신.
(`engine.ts:1201-1218` 파리티 — Rust는 이 리셋을 `Turn::new()` **생성자 하나**로 강제하고,
필드 직접 대입을 `pub(super)`로 막는다.)

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

| 명령 | `Idle` | `Starting` | `Streaming` | `AwaitingUser` | `HeldResult` | `Interrupting` | `Resident` | `Terminating` |
|---|---|---|---|---|---|---|---|---|
| `send` | ✅ accepted (T1) | 📥 queued(head) | 📥 queued | 📥 queued | 📥 queued | 📥 queued | ✅ accepted (T16/17/18) | 📥 queued |
| `enqueue` | ✅ (즉시 드레인) | 📥 | 📥 | 📥 | 📥 | 📥 | 📥 | 📥 |
| `interrupt` | ⛔ `nothing_running` | ✅ (spawn 취소) | ✅ T13 | ✅ T13 | ✅ T13 | ⛔ `already_interrupting` | ⚠️ `no_turn` → **대신 bg 전체 중지 제안** | ⛔ `ending` |
| `stop_all` | ⛔ `nothing_running` | ✅ | ✅ T23 | ✅ T23 | ✅ T23 | ✅ T23(강등) | ✅ T23 | ⛔ `already_ending` |
| `respond_permission` | ⛔ `no_card` | ⛔ | ⛔ `no_card` | ✅ T5 | ⛔ | ⛔ `interrupting`(카드는 이미 해제됨) | ⛔ | ⛔ |
| `respond_question` | ⛔ `no_card` | ⛔ | ⛔ | ✅ T5 | ⛔ | ⛔ | ⛔ | ⛔ |
| `bg_task.stop` | ⛔ `no_stream` | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | ⛔ |
| `bg_task.background` (Ctrl+B) | ⛔ | ⛔ | ✅ | ✅(막고 있는 도구가 있을 때) | ✅ | ⛔ | ⛔ `no_foreground_tool` | ⛔ |
| `identity_set` | ✅ applied | ⏳ deferred(턴 끝) | ⏳ deferred | ⏳ deferred | ⏳ deferred | ⏳ deferred | ✅ applied + **재스폰 비용 예고** | ⏳ deferred(다음 스트림) |
| `identity_revert` | ✅ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ✅ + 비용 예고 | ⏳ |
| `queue.remove` / `reorder` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
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

**★ `switch_chat`·`new_chat`이 전 상태에서 ✅인 이유**: 실행은 Rust의 `ChatRuntime`에 붙어 있고
패널/사이드바는 **뷰**다(M-UX 가정). 뷰를 옮겨도 실행은 계속된다. 2.6.2가 이걸 막았던 건
"리듀서 하나를 채팅들이 갈아탄다"는 렌더러 구현 사정 때문이지 도메인 제약이 아니었다.

> ▶ **죽이는 병리**: P7(침묵 no-op 4곳), P8-2(고아 워크플로가 사이드바 전체를 잠그는 경로 —
> **애초에 잠글 수 있는 셀이 표에 없다**).

---

## 4. D4 — 설정 변경은 명령이다

### 4.1 흐름

```
렌더러                         Rust ChatRuntime                        모든 창
  │  chat:identity-set                 │                                 │
  │  { chatRef, patch, applyPolicy } ─▶│ 1. normalize(patch ∪ 현재)       │
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

**`deferred`의 착지**: §3.4 턴종료 판정에서 `pending_identity`를 적용한다.
적용 순간에도 브로드캐스트가 한 번 더 나간다(`origin: 'deferred_apply'`) — 사용자가
"아, 지금 바뀌었구나"를 본다.

**`deferred`가 여러 번 오면**: 마지막 것만 남긴다(패치 병합 아님 — **전체 교체**).
UI는 예약된 최종 정체성을 보여준다.

### 4.3 채널·페이로드 초안 (protocol.ts)

```ts
export const IPC = {
  …
  // ── M-LOGIC: 채팅 실행 상태 (surface 통합 — ChatRef로 본채팅/멀티패널/추가채팅 공용) ──
  chatIdentityGet:    'chat:identity-get',    // (ChatRef) → ChatIdentityState
  chatIdentitySet:    'chat:identity-set',    // (IdentitySetCmd) → IdentityVerdict
  chatIdentityRevert: 'chat:identity-revert', // (ChatRef, revision) → IdentityVerdict
  chatIdentityEvent:  'chat:identity',        // main→renderer 브로드캐스트 (전 창)
  chatQueueMutate:    'chat:queue-mutate',    // (QueueMutateCmd) → CommandVerdict
  chatQueueEvent:     'chat:queue',           // 브로드캐스트 — 큐 전체 REPLACE
  chatRunStateEvent:  'chat:run-state',       // 브로드캐스트 — 상태기계 상태 + 라이브 원장 REPLACE
  chatForceSettle:    'chat:force-settle',    // (ChatRef, liveItemId) → CommandVerdict  ★강제 해제
  chatVerdictEvent:   'chat:verdict',         // 브로드캐스트 — 거부/큐잉 사유(토스트·인라인 안내용)
} as const

/** 어느 표면의 어느 채팅인가 — 2.6.2의 surface('single'|'multi'|'session') 규약을 잇는다. */
export interface ChatRef { surface: 'single' | 'multi' | 'session'; id: string }

export interface IdentitySetCmd {
  ref: ChatRef
  patch: RawIdentity                    // 부분 지정 — 미지정 필드는 현재 값 유지
  applyPolicy?: 'now' | 'after_turn' | 'ask_if_costly'  // 생략 = 'ask_if_costly'
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
  ref: ChatRef
  identity: RunIdentity
  pending: { identity: RunIdentity; at: 'turn_end' | 'next_stream' } | null
  revision: number
  origin: 'user' | 'engine_fallback' | 'deferred_apply' | 'revert' | 'restore' | 'default'
  /** origin='engine_fallback'일 때만 — 배너·되돌리기 UI 재료 */
  fallback?: { fromModel: string; toModel: string; cause: string; revertTo: number }
  corrId?: string
}
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
    pub fn set_identity(&mut self, patch: RawIdentity, policy: ApplyPolicy) -> IdentityVerdict {
        let next = match RunIdentity::normalize(self.identity.patched(patch), &self.defaults) {
            Ok(v) => v, Err(e) => return IdentityVerdict::Rejected { reason: e.reason(), message: e.to_string() },
        };
        if next == self.identity && self.pending_identity.is_none() { return IdentityVerdict::Noop }
        let effects = self.effects_of(&next);           // will_respawn / kills_live / changed
        match (self.stream_state(), policy) {
            (S::Idle | S::Resident, ApplyPolicy::AskIfCostly) if effects.is_costly()
                => IdentityVerdict::NeedsConfirm { .. },
            (S::Idle | S::Resident, _) => { self.apply_now(next, Origin::User) }
            (_, _) => { self.pending_identity = Some(Staged::new(next)); IdentityVerdict::Deferred { at: DeferPoint::TurnEnd, .. } }
        }
        // 어느 갈래든 마지막에 broadcast(ChatIdentityEvent) — 판정이 전 창에 보인다
    }
}
```

> ▶ **죽이는 병리**: P2(3벌 사본 → 진실 1벌 + 뷰), P3(엔진이 렌더러를 뒤에서 바꾸는 경로 제거),
> P4(계정 변경의 타이밍 규약 부재 → 판정표로 명문화).

---

## 5. D8/D9 — 라이브 항목 원장과 고아 정리

### 5.1 원장의 대상 — "진행 중"으로 보이는 것 전부

| `LiveKind` | 출처 프레임 | 2.6.2 대응 | 리스(무증거 허용 시간) | 증거 프로브 |
|---|---|---|---|---|
| `Workflow` | `task_progress`+`workflow_progress` / REPLACE 멤버십 | `wfSnaps`·`liveWorkflows` | 90s | REPLACE 멤버십 · `task_progress` 하트비트 · 전사 mtime |
| `BgShell` | `background_tasks_changed`(`task_type: bash/shell`) | `liveBgIds` | 90s (+턴종료 5s 유예) | REPLACE 멤버십 · outputFile mtime |
| `BgAgent` | REPLACE의 비-셸·비-워크플로 항목 | `liveBgAgents` | 10분 | `projects/<slug>/<session>/subagents/**` mtime (`engine.ts:685-713` 이식) |
| `Subagent`(포그라운드) | `Task` tool_use ↔ tool_result | `this.subagents` | 턴 수명 | 부모 도구 카드 생사 |
| `AskCard` | `can_use_tool`/`request_user_dialog`/`AskUserQuestion` | `permissionWaiters`/`questionWaiters` | **무한(단 스트림 소유)** | 스트림 생존 |
| `RunningTool` | `tool_use` ↔ `tool_result` | `this.tools` | 턴 수명 | 스트림 생존 |
| `CmdCard` | 슬래시 명령 카드(running) | `pendingCommand` | 턴 수명 | 스트림 생존 |
| `StreamingMsg` | `cur_text_id` 열린 말풍선 | `curTextId` | 턴 수명 | 스트림 생존 |
| `Thinking` | 사고 표시 | `thinkingText` | 턴 수명 | 스트림 생존 |
| `PendingSettle` | 정착 관측 후 보고 턴 대기 | `pendingSettles` | 10분 | 프레임 흐름 |

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

### 5.4 워치독 — "타이머를 안 건다"는 선택지 없음

2.6.2의 치명적 결정(`engine.ts:726-733`: 워크플로/셸이 살아 있으면 타이머 자체를 안 검)을
**증거 프로브**로 대체한다.

```
매 tick(5s):
  for item in ledger:
     if 프레임/REPLACE 멤버십/하트비트 관측됨   → last_evidence = now; lease 재장전; continue
     if now < lease_until                      → continue
     # 리스 만료 — 조용한 게 정상일 수 있다. 증거를 찾는다.
     match probe(item):
        Alive  → lease 재장전 (조용하지만 일하는 중)
        Dead   → settle(item, Watchdog)
        Unknown→ liveness = Unverified          # ★ 게이팅 자격 상실(§5.5). 정착은 아직 안 함
                 if now - last_evidence > hard_limit(kind) → settle(item, Watchdog)
```

프로브 종류: ① CLI 프로세스 생존(가장 강력 — 죽었으면 T22가 이미 처리) ②
`background_tasks_changed` 최신 REPLACE의 멤버십 ③ 전사 파일 mtime(`subagents/**`,
셸 `outputFile`) ④ `task_progress` 하트비트.

`hard_limit`: Workflow 30분 · BgShell 30분 · BgAgent 60분 · PendingSettle 10분 ·
턴 수명 항목은 스트림에 종속(별도 상한 없음).

> ▶ **죽이는 병리**: P8-4(감시 공백). 조용한 워크플로는 **증거로** 살리고, 증거가 없으면
> 게이팅 자격부터 뺏고, 그래도 없으면 정착시킨다.

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
  ref: ChatRef
  state: 'idle' | 'starting' | 'streaming' | 'awaiting_user' | 'held_result'
       | 'interrupting' | 'resident' | 'terminating'
  runId: string | null
  /** 살아있는 항목 전체 — REPLACE 의미(2.6.2 bg-tasks 규약을 원장 전체로 확장) */
  live: Array<{
    id: string; kind: LiveKind; label: string
    liveness: 'observed' | 'unverified'
    gating: 'may_warn' | 'never_blocks'
    bornRunId: string
  }>
  /** 이번 이벤트에서 정착한 항목들 — 사유를 UI가 문장으로 만든다 */
  settled: Array<{ id: string; kind: LiveKind; reason: SettleReasonWire }>
}
```

REPLACE로 두는 이유: 에지(추가/삭제) 기반은 **한 프레임만 놓쳐도 영구 불일치**가 된다.
`protocol-claude-cli.md` §9-②가 지목한 순서 의존성 위험을 구조적으로 우회한다 —
**레벨 신호가 진실, 에지는 장식.**

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

### 6.2 전이 (T29)

1. 엔진이 `model_refusal_fallback` 또는 메인 경로 `message.model` 변화를 관측
   (**사이드체인 프레임은 제외** — `protocol-claude-cli.md` §6.5, 배너 핑퐁 사고).
2. `identity.engine.model`을 새 값으로 하는 **리비전 생성**(`origin: EngineFallback`).
3. `chat:identity` 브로드캐스트(`fallback: { fromModel, toModel, cause, revertTo }`).
4. 스레드에 인라인 배너 + **[되돌리기]** — `chat:identity-revert(revertTo)`.
5. 그 다음 턴은 **정체성이 실제로 바뀌었으므로** 재스폰 사유가 `IdentityChanged{['engine']}`로
   정직하게 뜬다. 2.6.2처럼 "사용자가 안 바꿨는데 설정이 바뀌었다는 안내"가 나오지 않는다 —
   **바꾼 주체가 기록돼 있다**("모델 자동 전환 때문에 새 프로세스로 시작했어요").

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
   if stream_state != Idle && stream_state != Resident: return         # T16 주입은 Resident에서만
   if hold.is_some() && !hold.ready:                    return         # 한도 대기 게이트
   if queue.is_empty():                                 return
   let m = queue.front();
   match reuse_decision(m.identity, m.thread):
       Reuse            => T16 (주입)
       Respawn { why }  => T17/T18 (사유 동봉 정리 후 T1)
       ColdStart        => T1
```

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

- **장전**: T30 — `rate_limit_event` 또는 한도성 `result` 에러. **상태에서** 판정한다
  (2.6.2는 스레드 마지막 말풍선 텍스트를 읽었다 — P6).
- **정제/발화**: `resets_at + 90s`에 신선 usage 재검증(2.6.2 `useLimitResume`의 검증 규약 계승),
  아직 막혔으면 재장전.
- **소진**: `ready`가 되면 **큐 head에 `origin:'limit_resume'` 항목을 삽입**한다
  (세션이 있으면 "이어서" 프롬프트, 없으면 원문 재전송). 그리고 §7.2의 일반 드레인이 돈다.
- **해제**: 이 채팅에서 새 실행이 시작되면(수동 전송 포함) 해제.
- **계정/정체성 변경 시**: `hold.account != identity.billing`이면 대기표를 **무효화**하고
  UI에 알린다("계정을 바꿔서 대기표를 취소했어요"). 2.6.2는 계정을 바꿔도 옛 계정 기준으로
  재검증하고 옛 계정으로 재전송했다.

> ▶ **죽이는 병리**: P5(정체성 절반만 스냅샷), P6(별개 행위자·ref 경합·창 닫으면 증발·
> 화면 텍스트 판정), 그리고 "예약 큐 + 한도 소진" 조합(필수 시나리오 #4)이 **한 곳에서**
> 직렬화돼 재생 테스트가 가능해진다.

---

## 8. 2.6.2 병리 ↔ 설계 대응표

| 병리 | 근거 | 죽이는 설계 | 한 줄 |
|---|---|---|---|
| P1 손 비교 11필드 | `engine.ts:1185-1200` | D1 | 비교가 `a == b` 한 줄이 되고, 정규화는 생성자 1곳, 필드 추가는 골든 테스트가 강제 |
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

| # | 시나리오 | 재현하는 병리 | 핵심 단언 |
|---|---|---|---|
| 1 | 계정 변경 중 턴 시작 | P4 | 진행 턴은 옛 계정 유지, 판정=`deferred`, 턴 끝에 적용 브로드캐스트 1회 |
| 2 | 폴백 직후 계정 변경 | P3+P4 | 리비전 2개(EngineFallback→User), 재스폰 사유=`IdentityChanged{engine,billing}` |
| 3 | busy 중 채팅 전환 | P7 | 전환 성공 + 실행 계속 + 두 채팅의 `run-state`가 독립 |
| 4 | 예약 큐 있는 상태에서 한도 소진→자동 이어서 | P5+P6 | 대기 중 드레인 0건, 해제 후 **큐 순서 보존**, 재개 항목이 head, 이중 전송 없음 |
| 5 | 중단 직후 재개 | 소프트 중단 | `Interrupting`→`Resident`, 프로세스 생존, 다음 턴 정상(실와이어 `interrupt.jsonl`) |
| 6 | 백그라운드 살아있는 상태의 중단 | 위험 #2 (**PoC 미검증 구간**) | 셸/워크플로가 중단으로 죽지 않음, 원장 유지, `Resident` 착지 |
| 7 | 워크플로 도는 중 CLI 강제 종료 | **P8 유령** | 원장 전부 `StreamClosed{ExternalKill}` 정착, `wf` 알약 소멸, 게이팅 해제, busy 해제 |
| 8 | 승인 카드 뜬 채 CLI 사망 | P8+대기자 누수 | `AskCard` 정착 `StreamClosed`, 카드 닫힘, 종결 status 1회, 대기자 0 |

추가 상시 시나리오(회귀 방지): 9. 정착↔통지 **순서 뒤집기**(위험 #2) · 10. 무음 result 슬라이딩
보류 → 진짜 턴 도착 · 11. 통지 삼킴 재주입 1회 제한 · 12. `addDirs` 순서만 다른 재전송 =
**재스폰 없음** · 13. 전역 outputStyle 변경이 다른 채팅 상주를 끊지 않음.

---

## 10. 열린 문제 (리드가 닫아야 함)

| # | 문제 | 왜 열려 있나 | 제안 |
|---|---|---|---|
| **O1** | **M-UX 접점** — "패널=뷰, 실행은 채팅에 붙는다"를 이 문서는 **가정**했다. `docs/design/ux-chat-unify.md`(병행 설계)가 다른 소유 모델을 쓰면 §3.6의 `switch_chat` 전 상태 ✅가 무너진다 | 두 설계가 동시 진행 | 통합 시 **소유 모델을 먼저 합의** — 이 문서는 "실행 상태는 `ChatRuntime`" 외의 어떤 가정도 안 한다 |
| **O2** | 렌더러 세션 리듀서의 소유권 — 2.6.2는 리듀서 **1개**를 채팅들이 갈아탄다(`load(snapshot)`). 채팅 전환 중 실행 계속을 지원하려면 리듀서가 채팅별이거나, Rust가 스냅샷을 밀어야 한다 | 렌더러 대공사 | M-UX와 함께 결정. 대안: Rust가 `chat:run-state` + 스레드 이벤트를 채팅 id로 태깅해 보내고 렌더러는 맵으로 보관 |
| **O3** | 팝아웃 창 소유권 이전 규약(2.6.2 `#mapanel`)이 Rust 단일 소유에서 **필요 없어진다**. 다만 초안(draft)·스크롤 등 순수 UI 상태는 여전히 이전 필요 | 기존 규약과 충돌 | 큐·정체성은 Rust, 초안은 렌더러 → 이전 페이로드가 **작아진다**. M-UX 확인 필요 |
| **O4** | `Codex` 축 파리티 — `EngineAxis::Codex`의 정규화(모델 id 공간·`codexAccount`·`CODEX_HOME` 격리)를 Claude와 같은 규칙으로 접을 수 있는지 미확인 | Codex 드라이버는 M4 | M4 착수 전 `RunIdentity` 확장으로 검증. 필드 추가는 골든 테스트가 잡아준다 |
| **O5** | `output_style` 물질화 시 **기존 사용자 데이터 마이그레이션** — 2.6.2 채팅엔 그 필드가 없다 | 앱 홈 호환(ARCH §확정4) | 로드 시 전역 pref로 채우고 리비전 `origin:'restore'` 기록 |
| **O6** | 강제 해제 UI 위치·문구(알약 우클릭? WorkBar 칩 메뉴? 설정에 "정리" 버튼?) | UI 소관 | M-UX. 규약만 고정: **막는 곳엔 반드시 있다** |
| **O7** | 백그라운드 셸 **5s 유예**의 실제 값 — 2.6.2 관측치이지 계측치가 아니다 | 미실측 | M3 라이브 PoC 1회(셸 백그라운드화 → 턴 종료 → REPLACE 이탈까지 ms 계측) |
| **O8** | `resume`/`fork`를 정체성에서 뺀 결정과 **/btw 포크** 규약의 상호작용(`forkSession`은 첫 실행 1회만) | /btw는 2.6.0 기능 | `ThreadLink { forked_from, fork_consumed }`를 스레드 쪽에 두면 정합. 이식 시 재확인 |
| **O9** | **위험 #2(상주 회계 순서 의존성)는 여전히 미해소**다. 크리틱 판정: "백그라운드가 살아 있는 상태의 interrupt는 한 번도 시험되지 않았다"(`docs/critic/m3-poc.md` §3 범위 한정) | 라이브 PoC 부재 | 시나리오 #6·#9를 **재생으로 먼저** 통과시키고, M3에서 라이브 1회(셸 + 중단 + 재전송) |
| **O10** | `AwaitingUser`에 카드가 **여러 개**(병렬 도구 승인)일 때 `deferred` 정체성 적용 시점 | 와이어상 동시 다발 가능(`§8.2`) | "마지막 카드 응답 후 턴 종료"가 적용점 — 표의 §3.4가 이미 커버하나 UI 표시는 미정 |
| **O11** | 큐 영속 시 **첨부 파일 경로**의 수명(temp 파일이 지워질 수 있음) | 2.6.2도 미해결 | 드레인 시 존재 확인 → 없으면 항목을 `rejected{attachment_missing}`로 정착 |

---

## 11. 구현 순서 (M3와 맞물림)

1. `crates/ccg-engine`: `identity.rs`(D1) + 골든 테스트 — **엔진 코드보다 먼저**.
2. `state.rs`(D3 전이표) + `live.rs`(D8 원장·`StreamGuard`) — 아직 CLI 없이 `FakeCli`로.
3. `docs/design/m-logic-replay.md`의 시나리오 1~8을 **빨간 테스트로 먼저** 커밋.
4. `ccg-claude` 드라이버를 그 상태기계에 **끼운다**(프레임→전이 매핑은
   `protocol-claude-cli.md` §8.4 표 그대로).
5. `protocol.ts` 채널 6개 + 렌더러 picker를 뷰로 전환(D2·D4) — M-UX와 착지 조율(O1).
6. 큐·한도 대기의 Rust 이관(D5) — `useLimitResume`은 표시 전용 훅으로 축소.

**M3 게이트 추가 조건**: 위 3번의 8시나리오가 전부 초록이 아니면 M3를 "완료"로 부르지 않는다.
