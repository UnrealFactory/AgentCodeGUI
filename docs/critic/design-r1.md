# 설계 크리틱 R1 — M-UX 「채팅 통합」 / M-LOGIC 「상태기계」

판정 대상
- `docs/design/ux-chat-unify.md` + `docs/design/mockups/chat-unify-*.html`
- `docs/design/m-logic.md` + `docs/design/m-logic-replay.md`

대조 기준: 얼린 2.6.2 소스(`src/`), `crates/ccg-store/`, `docs/protocol-claude-cli.md`,
`docs/screen-inventory.md`(161화면), `docs/m3-poc-findings.md`.
이 문서의 모든 지적은 파일:줄로 확인했다. 추측은 「미확인」으로 표시했다.

---

## 0. 판정

| 스펙 | 판정 | 한 줄 |
|---|---|---|
| **M-UX 채팅 통합** | **보완** (구조 채택 가능 / 스펙 불완전) | 데이터 모델(채팅·자리·보드)은 옳다. 그러나 **통합 모델에 자리가 없는 2.6.2 화면**이 최소 4갈래 있고 스펙이 그걸 스스로 드러내지 못한다 |
| **M-LOGIC 상태기계** | **보완** (기반으로 쓰기엔 미완) | 병리 분석은 정확하다. 그러나 **전이표가 실제 프레임의 절반만 소화**하고, 간판 수리(P8 워치독·D4 deferred)가 각각 자기 모순으로 무력화된다 |

두 스펙 모두 「M3 착수 전 닫혀 있어야 한다」는 자기 기준을 아직 못 넘는다.

---

## 1. M-UX 구멍 (심각도순)

### U1 [치명] 접힌 채팅의 알림·상태가 죽는다 — §2.2-4와 §4.1이 정면 충돌

- §2.2-4: "축소해도 토스트는 계속 온다 … 접힘은 표시 상태일 뿐 감시 대상에서 빠지지 않는다."
- §4.1: 부팅 light 조회 = "활성 보드의 **보이는 자리(count개)** + 열린 창의 채팅만 스냅샷,
  나머지는 `unloaded: true`. **접힌 자리·비활성 보드는 마커.**"

`useTurnNotifyList`는 항목마다 `state: SessionState`를 요구한다
(`src/renderer/src/lib/notify.ts:34`, `NotifyWatchItem`은 `{state, busy, title, target}`).
마커에는 스냅샷이 없다. **감시 대상으로 두려면 스냅샷을 들고 있어야 하고, 스냅샷을 안 들면 감시가 안 된다.**
두 절이 같은 채팅에 대해 반대를 요구한다.

파생 구멍 둘:
1. §8-3의 제안 기본값("자리에서 빼도 계속 돈다")대로면, 보드 slots에도 창에도 없는 채팅이
   백그라운드로 돈다 → "열린 채팅 전부(보드 slots ∪ 창)"라는 감시 정의에서 **완전히 빠진다**.
   2.6.2는 멀티 6패널 전부를 감시했다(`MultiAgent.tsx:891-898`). 통합 후 알림이 줄어든다 = 기능 손실.
2. `useTurnNotifyList`의 `prev` 맵은 target 키로 살아남고 첫 관찰은 전이로 치지 않는다(`notify.ts:38-41`).
   감시 집합이 **가변 길이**가 되면(2.6.2는 6 고정) 빠졌다 돌아온 채팅이 낡은 `prev`와 비교돼
   오탐 토스트가 난다.

→ 스펙이 "접힌 자리도 감시"를 지키려면 마커에 `status`뿐 아니라 **전이 판정에 필요한 최소 필드**
(`status`, `pendingPermission?`, `pendingQuestion?`)를 실어야 한다. 지금 스펙은 `status`만 언급했다(§4.1).

### U2 [치명] `chat:permission` / `chat:answer`가 매칭 키(request_id)를 버렸다

2.6.2: `PermissionResponse { requestId, behavior, message? }` / `QuestionResponse { requestId, answers: string[][] | null }`
(`src/shared/protocol.ts:563-575`).
와이어 규약: **"매칭 키는 `request_id`"** — toolUseID는 넣되 키가 아니다
(`docs/protocol-claude-cli.md:1377`, `§4.4a`).

ux §6.1은 `chat:permission { chatId, toolUseId, behavior }` / `chat:answer { chatId, answers: string[][] }`.
- `toolUseId`로는 대기자를 못 고른다. 병렬 도구 승인은 와이어상 동시 다발이 가능하고
  (m-logic 스스로 O10에서 인정), 폴백 다이얼로그는 `ask-` 접두 requestId를 쓴다(`engine.ts:936`).
- `answers`에서 `null`(무응답 해제)이 사라졌다 — 2.6.2가 명시적으로 모델링한 상태다.
- m-logic T5의 가드("`request_id`가 이 스트림 것")와도 모순. **두 스펙이 같은 명령에서 어긋난다.**

### U3 [높음] 과도기 별칭의 `claude:run → chatId = 기본 보드 slots[0]`가 틀렸다

`claude:run`은 chat id를 안 싣는다 — 옛 렌더러의 대상은 **그 순간의 `activeChatId`**이고,
사용자는 사이드바로 자유롭게 갈아탄다(`App.tsx:799 selectChat`). `slots[0]` 고정 매핑이면
채팅을 바꾼 뒤의 모든 실행이 **남의 `ChatRuntime`**(정체성·큐·라이브 원장·계정 CONFIG_DIR)에 붙는다.
§6.2의 이득("M-UX가 M1을 막지 않는다")이 여기서 무너진다.
→ 어댑터는 `chats:save`가 실어 보내는 `activeChatId`를 세션 상태로 들고 있어야 한다(그것도 저장 시점에만
오므로 레이스가 남는다 — 별칭 계층에 `claude:set-active` 같은 한 채널이 필요할 수 있다).

### U4 [높음] 자리 껍데기 3종이 앱 크롬을 자리 안으로 밀어 넣었다

§3.1: `<IdeShell>`(count=1) = "왼쪽 칼럼 + 코드 뷰어 + Git + 변경파일 카드", `<GridCell>`은 패널 헤더만.

2.6.2 실제:
- 왼쪽 칼럼(사이드바⟷탐색기)은 **mode 분기 밖**에 있다(`App.tsx:1432-1466`) — 멀티에서도 산다.
  멀티 탐색기는 포커스 패널의 폴더를 따라간다(`multi-explorer`, `App.tsx:1462 multiExp`).
  §3.1 문면대로면 **2‥6에서 사이드바가 사라진다** — 보드/채팅 전환 수단이 없어진다.
  (목업은 반대로 사이드바를 유지해 그렸다 → **스펙과 목업 불일치**.)
- 코드 뷰어는 **4표면이 각자 렌더한다**: `App.tsx:1640` · `SessionWindow.tsx:879` ·
  `PanelWindow.tsx:528` · `MultiAgent.tsx:1918`. `panel-window-viewer`는 인벤토리의 **검증됨** 화면이다.
  §0의 "이중 배선" 표에 뷰어가 없고(5번째 이중 배선을 놓쳤다), §3.1에 자리도 없다.
- Git 모달도 앱 레벨이며 "따라가는 패널의 폴더 기준"으로 연다(`App.tsx:1624` 주석).

### U5 [높음] `Chat.owner`가 M-LOGIC과 충돌하고, 그래서 필요 없을 수도 있다

- ux §2.5: "큐 드레인·한도 대기표 타이머·자동 재개 전송은 `owner === 내 창`일 때만 돈다."
- m-logic §7.2 `drain_if_possible()` · §7.3 `LimitHold` · T27: **드레인과 hold는 Rust `ChatRuntime` 소유**.
  창이 여럿이든 하나든 렌더러는 드레인하지 않는다.

두 문서가 ux §7 "합의" 목록에 올려 둔 바로 그 항목이 실제로는 어긋난다. 반대 방향의 어긋남도 있다:
m-logic O3은 "초안(draft)·스크롤 등 순수 UI 상태는 **여전히 이전 필요**"라 했고,
ux §2.5는 "초안·큐·대기표가 채팅에 붙어 **복사본이 없다** → persist→fold-back / leftover 소비는 불필요".
소유권 이전 규약(`MultiAgent.tsx:1274-1309`, `index.ts:667-670`·`:722-732`·`:1315-1330`)을 지우려면
**초안·스크롤·유령 셀 갱신의 소유자**를 한 문장으로 못 박아야 한다. 지금은 두 문서가 서로를 근거로 든다.

### U6 [중] "한 채팅은 한 자리" 불변식이 보드 다중성과 충돌

불변식 2는 "같은 chatId를 두 자리에 넣는 것 금지"다. 보드가 N개인데 **범위가 안 적혀 있다**.
- 전역 금지 → 같은 장기 채팅을 여러 배치에 넣을 수 없다 = 후보 C의 존재 이유("그때 그 조합" 복원)가 반쪽.
- 활성 보드 한정 → 보드를 바꾸는 순간 같은 채팅이 두 보드의 자리에서 동시에 참조되므로
  §4.1의 "보이는 자리만 스냅샷" 계산과 §2.3의 "기억한 배정 복원"이 충돌 케이스를 갖는다.

### U7 [중] IPC 산수가 틀렸다 — 21이 아니라 25(또는 30)

§6.1 코드 블록의 명령을 세면 **22개**다(chat 8 + identity/settle 4 + chats 3 + board 3 + win:chat 4).
"명령 18"은 `win:chat-*` 4줄을 안 세었다. 여기에 m-logic §4.3이 이미 잡아 둔
`chat:queue-mutate`(명령) + `chat:identity`·`chat:queue`·`chat:run-state`·`chat:verdict`(이벤트 4)를
더하면 **명령 23 + 이벤트 7 = 30**이다.
(비교 대상인 55는 실측이 맞다: claude 6 / ma 17 / talk 7 / session 6 / session-wins 7 /
`win:open-session` 1 / `btw:open` 1 / chats 3 = 48 + 대화 관련 이벤트 7 — `protocol.ts:942-1006`,`:1130-1138`.)
표제 수치가 근거 없이 41% 낙관적이다.

### U8 [중] 다이얼 축소 규칙 변경이 재정렬·정리 로직의 의미를 바꾼다

§2.2-1: `visibleSlots` 필터를 "슬롯 번호 < count" → "**order 내 위치** < count"로.
그러면 `order`가 (a) 그리드 표시 순서, (b) 접힘 우선순위 두 역할을 겸직한다.
헤더 길게 누르기 드래그(`multi-reorder`)로 순서를 바꾸면 **접힘 집합이 함께 바뀐다** — 스펙에 없다.
또 2.6.2가 count 축소 때 하던 정리(`MultiAgent.tsx:1819-1824`: `focusedSlot`/`renamingSlot`이
`>= n`이면 해제)는 새 규칙에서 기준이 달라진다("자리 번호"가 아니라 "order 위치").
"필터 한 줄"이 아니라 세 소비자를 건드리는 변경이다.

### U9 [중] 뷰어發 동작의 대상 채팅이 미정

`viewer-selection-ask-bar` / `viewer-ask-panel`(인벤토리 6절)은 "이 선택으로 물어보기"다.
2.6.2는 활성 채팅 하나뿐이라 모호함이 없었다. N≥2에서 **포커스 자리인지 1번 자리인지** 스펙에 없다.
같은 부류로 답이 없는 것: `chat-find`(Ctrl+F — 어느 스레드), `changed-files-modal`(어느 채팅의 files),
`explorer-git-strip`/`git-*`(어느 폴더 — 2.6.2는 포커스 패널 폴더).
메모리의 미결 항목("뷰어+채팅 동시 사용 설계 — onAskSelection의 뷰어 강제 닫힘")이 그대로 남았다.

### U10 [중] 전역 pref의 채팅 물질화가 마이그레이션 표에 없다

- `api.mode`는 **전역**이다(`App.tsx:180 getPref('api.mode')`, 실행 시 `App.tsx:1076 useApi: apiMode`).
  멀티 패널만 패널별(`PanelMeta.api`), 추가 채팅 레코드엔 필드 자체가 없다(`sessionChats.ts:24-46`).
  m-logic이 `BillingAxis`를 **채팅별 정체성 축**으로 승격하므로, 마이그레이션 순간 기존 채팅 전부가
  그때의 전역값으로 굳는다. 이후 전역 토글을 꺼도 옛 채팅은 API로 돈다 — 마이그레이션 표(§4.2)에 이 행이 없다.
- `claude.outputStyle`도 같다(m-logic §2.4 물질화·O5). ux 표에 행이 없다.

### U11 [낮음] `version: 3`은 다운그레이드 가드가 아니다

main도 렌더러도 version을 **검사하지 않는다**(`chats.ts:79`·`:157`, `App.tsx:131`·`:620` — 읽을 때 `?? 1`,
쓸 때 상수). 2.6.2로 되돌리면 통합 스토어를 조용히 읽고 `version:1` + 유실 필드로 **되쓴다**.
같은 `chats/` 디렉터리를 재사용하는 한 백업이 유일한 방어라는 §4.2의 서술은 맞지만,
"조용히 파괴된다"는 사실은 안 적혀 있다. → 새 포맷은 `chats-v3/`처럼 **다른 디렉터리**가 안전하다.

### U12 [낮음] 빈 채팅 규칙 일반화가 반쪽

"빈 채팅 최대 1개"(`App.tsx:781-788`)를 "자리당 최대 1개"로 일반화하면 6자리 = 빈 채팅 6개다.
그 6개가 (a) 사이드바에 안 보이고 (b) 디스크에 안 남고 (c) light 조회에서 어떻게 취급되는지 —
특히 2.6.2 light 규칙은 **활성 채팅뿐 아니라 "스냅샷이 빈 채팅"도 통째로 유지**한다
(`chats.ts:70-75`, `chats.rs:97-104`). 이 예외가 `App.tsx:783`의 `!c.unloaded` 재사용 판정을 받치고 있다.
§4.1의 새 규칙("보이는 자리 + 열린 창만")은 이 예외를 지웠다.

---

## 2. M-LOGIC 구멍 (심각도순)

### L1 [치명] 중단이 예약 큐를 안 비운다 → "중지했는데 다음 예약이 나간다"

2.6.2 `cancelRun`은 큐를 통째로 버린다:
```
App.tsx:905-908   for (const w of state.workflows) if (running) onBgTaskMain({action:'stop', id:w.id})
                  setQueue([])
```
(Esc가 이 경로로 들어온다 — `App.tsx:917-928`.)

m-logic T13(interrupt)·T14·T23(stop_all) 어디에도 큐 처리가 없고, §3.4 턴종료 판정은
"큐가 비어있지 않고 hold 없으면 → 즉시 이어짐"이다. T23은 `Terminating → Ended → Idle`로 떨어지고
T27이 곧바로 드레인한다. **설계대로 구현하면 Esc 직후 큐 head가 자동 전송된다.**
§3.6 명령표의 `interrupt`/`stop_all` 셀에도 큐 효과가 없다.

### L2 [치명] P8을 죽인다는 워치독이 P8 조건에서 발화하지 않는다

§5.4 프로브 목록 ①: "**CLI 프로세스 생존**(가장 강력 — 죽었으면 T22가 이미 처리)".
§5.4 의사코드: `match probe(item) { Alive → lease 재장전 … }`.

그런데 P8의 정의는 "**프로세스는 살아 있는데** 워크플로가 외부에서 죽어 알약이 굳는다"이다
(`m-logic-replay.md` 폴트표: `freeze{ms}` = "프로세스는 살아 있는데 프레임이 전혀 안 옴 (**P8 본체**)").
프로브 ①이 Alive를 돌려주면 리스가 무한 재장전되어 `liveness=unverified`로도, `Watchdog` 정착으로도
가지 못한다. **재생 7b의 단언(90s 리스 만료 → 프로브 실패 → unverified → 30분 → settle)이
§5.4의 프로브 정의와 모순**이다.
→ 프로세스 생존은 **Dead 확정 전용**(죽었으면 즉시 정착)이어야 하고 Alive 판정 근거에서 빼야 한다.

### L3 [치명] `deferred`의 "전체 교체"가 폴백 리비전을 되돌린다

§4.2: "`deferred`가 여러 번 오면 마지막 것만 남긴다(**패치 병합 아님 — 전체 교체**)."
§4.4 `set_identity`: 요청 **접수 시점**에 `normalize(self.identity.patched(patch))`로 다음 정체성 전체를 굳혀
`pending_identity`에 넣는다.

턴 중에 T29(폴백)가 발생하면 `self.identity.engine.model`이 즉시 바뀐다(리비전 origin=EngineFallback).
그런데 그 전에 접수된 `pending_identity`는 **폴백 이전의 model**을 담고 있고, §3.4 착지에서 전체 교체된다.
→ 사용자가 턴 중에 계정만 바꿨는데 턴이 끝나는 순간 **모델이 조용히 폴백 이전 값으로 되돌아간다.**
재생 #2의 단언("다음 send 재사용 판정 = `IdentityChanged[engine, billing]`")은 이 규칙에서 성립하지 않는다.
P3("누가 이겼는지 모른다")이 형태만 바꿔 부활한다.
→ `pending`은 **정체성 전체가 아니라 패치 + base revision**으로 들고, 착지에서 재정규화해야 한다.

### L4 [높음] 폴백 신호가 셋인데 합류 규약이 없다

2.6.2는 세 경로를 두 장치로 합류시킨다:
| 경로 | 코드 | 합류 |
|---|---|---|
| `request_user_dialog(refusal_fallback_prompt)` 수락 | `engine.ts:999` `pendingFallbackNotices++` | 카운터 |
| `system/model_refusal_fallback` | `engine.ts:1336-1338` `if (pendingFallbackNotices>0) --` | 카운터 |
| `assistant.message.model` 변화 | `engine.ts:1660-1675` `curModelDisplay` 비교 | 미러 변수 |

T29는 앞의 두 경로 중 하나(다이얼로그 경로는 T4/T5의 AskCard로만 다룬다)와 세 번째만 적고
**합류 규칙이 없다**. 한 번의 폴백에 리비전 2개·배너 2개가 난다 —
메모리에 기록된 "사이드체인 배너 핑퐁" 사고와 같은 계열이다.
추가로: 다이얼로그 경로는 **사용자가 수락해야** 전환된다(사용자 확정 규약). T5는 카드 응답을
"정착 `Answered`"로만 적어, **응답이 정체성을 바꾼다는 사실이 상태기계 어디에도 없다.**
그리고 §3.6 명령표에 `respond_dialog` 행이 없다(T5는 `respond(permission|question|dialog)`라고 적었다).

### L5 [높음] 전이표가 실제 프레임의 절반만 소화한다 — "31전이"가 닫혀 있지 않다

`docs/protocol-claude-cli.md` §8.4의 22행 매핑표와 대조:

| 프레임 | 전이표 위치 |
|---|---|
| `system/background_tasks_changed` (★REPLACE) | **Resident의 T20(빈 목록)뿐.** Streaming/AwaitingUser/HeldResult에서 원장을 **채우는** 전이가 없다 |
| `system/task_progress`(+`workflow_progress`) | **없음** — `Workflow` LiveKind의 유일한 출처(§5.1)이자 하트비트 증거인데 |
| `system/task_notification` | **없음** — 정착 에지 + 셸/워크플로/서브에이전트 종료의 출처(`engine.ts:1565`) |
| `system/task_started` | **없음** (`tool_use_id→task_id` 매핑 등록) |
| `system/init` 재도착(같은 session_id) | 상시 회귀 #18에만 있고 전이표엔 없다 |
| `system/notification` · `informational` | 없음(무해) |

D8 원장·§5.4 워치독·재생 하네스가 전부 이 프레임들 위에 서 있는데 상태기계에 진입점이 없다.
"D3: 2.6.2의 암묵 규약이 전부 표의 한 줄로 존재"라는 주장이 성립하지 않는다.

### L6 [높음] 한도 장전의 근거 프레임이 미관측이다

§7.3: "장전 — T30 … **상태에서** 판정한다(2.6.2는 스레드 마지막 말풍선 텍스트를 읽었다 — P6)."
실측된 `rate_limit_event`는 `status:"allowed"` 한 종류뿐이다(`protocol-claude-cli.md:1056-1065`,
§7.2 라이브 로그 `:1341`). blocked 모양은 **합성 픽스처**(`synth/rate-limit-blocked.jsonl`)로
"result is_error + 한도 문구"를 가정한다. 즉 실제로는 2.6.2와 같은 **에러 문구 분류**로 떨어질 공산이 크고,
그러면 P6 비판("화면 텍스트를 읽는다")이 그대로 남는다. §10 열린 문제에 이 항목이 없다.

### L7 [높음] RunIdentity에 스폰 전용 축 4개가 빠졌다 (그리고 M-UX와 충돌한다)

"들어간다 = 이 값이 다르면 같은 CLI 프로세스를 재사용할 수 없다"는 자기 기준으로 재면:

| 빠진 축 | 스폰 시점 결정 근거 | 증상 |
|---|---|---|
| **API 키 지문** | `engine.ts:895` `env: { …, ANTHROPIC_API_KEY: apiKey }`, `apiKey = getApiKey()` (`:762`) | 키를 갈아도 `BillingAxis::ApiKey`는 같은 해시 → 상주가 **옛 키로 계속 돈다** |
| **전역 env 키 확인 답**(`dropEnvKey`) | `engine.ts:846-852` — 답이 `subEnv`에서 키를 걷어낼지를 정한다. 답은 **키 지문별 저장**(`apiConfig.ts:27`) | 같은 상주에서 과금 경로가 어긋난다 |
| **skillOverrides / deniedMcpServers** | `engine.ts:758-761` → `:874-875` `settings`에 굳음 (전역 pref) | 2.6.2도 `optsMatch`에 없어 "껐는데 안 꺼짐"이 조용히 난다 — P1과 같은 병리인데 D1이 안 죽인다 |
| **`codexAccount` / `codexModel`** | `PickerState`가 둘 다 상시 보유(`Chat.tsx:137-150`)하고 저장된다 | `EngineAxis::Claude`일 때 자리가 없다 |

마지막 항목은 **두 스펙의 충돌**이기도 하다:
ux §5.2 마이그레이션 검증표는 `{…, engine, account, codexAccount, api}` 맵 일치를 요구하는데
m-logic §2.3 골든 테스트는 필드 집합을 `["engine","billing","cwd","add_dirs","mode","system_prompt","output_style"]`로
**얼린다**. 같은 이유로 ux §7이 예약한 `Chat.identity.mcpOverrides` / `skillOverrides`도 얼린 집합 밖이다.
지금 두 문서를 그대로 구현하면 마이그레이션 PoC가 반드시 실패한다.

### L8 [중] 와이어에 있는 싼 경로를 안 본다 — 설정 변경 = 재스폰이 그대로 남는다

`protocol-claude-cli.md:486-492`(앱→CLI 요청 전수):
```
set_permission_mode  {mode}      → 미사용(2.6.2는 모드 변경 시 재스폰)
set_model            {model}     → 미사용
apply_flag_settings  {settings}  → 미사용(재스폰으로 대체)
set_max_thinking_tokens          → 미사용
```
D1은 `mode`·`model`·`effort`·`output_style`을 전부 정체성 축으로 두어 **변경 = 재스폰 = 백그라운드 몰살**을
그대로 계승한다. 문서 서두가 인용한 사용자 고통("모델이 바뀌거나 할 때 꼬인다")은 **안내 문구가 정직해질 뿐
사라지지 않는다.** 최소한 §10에 열린 문제로 올리고, M3 라이브 PoC 1턴(`set_model` 왕복)으로 닫아야 한다.
(주의: 이 4개는 라이브 미관측 🔶 — `protocol-claude-cli.md:1366`.)

### L9 [중] `Resident`에서 interrupt의 의미 변경이 파리티 표에 없다

2.6.2 Esc는 **상주 워크플로를 실제로 중지**한다(`App.tsx:917-928` → `cancelRun` → 전체 `bgTask stop`;
멀티도 같다 — `MultiAgent.tsx:1025-1028` "상주 워크플로(busy=false지만 도는 중)도 Esc 취소 대상").
§3.6은 `Resident`의 `interrupt`를 ⚠️ `no_turn` + "bg 전체 중지 **제안**"으로 강등한다.
클릭 한 번이 두 번이 되는 파리티 변경인데 §8 대응표에도 §10에도 없다.

### L10 [중] LiveKind 표의 "2.6.2 대응" 중 셋은 엔진이 아니라 렌더러 리듀서다

`pendingCommand`·`thinkingText`·`curTextId`는 `src/renderer/src/store/session.ts:78,86`의
**리듀서 상태**다(엔진 소스에는 `pendingCommand`/`thinkingText` 식별자가 0건).
이것들을 Rust 원장(`CmdCard`/`Thinking`/`StreamingMsg`)으로 올리려면 O2(리듀서 소유권 이전)가
**선택이 아니라 선행 조건**이 된다. §11 구현 순서에 그 의존이 없다.

### L11 [중] 공통 불변식 #3이 2.6.2의 정상 동작을 빨간불로 잡을 수 있다

`m-logic-replay.md` §3.4-3: "각 `run_id`마다 `status:done|error`가 **정확히 한 번**".
2.6.2는 워크플로 정리 턴 재개에서 **같은 runId로 done→working→done을 왕복**한다
(`engine.ts:1258-1265` — "같은 runId의 왕복은 렌더러 리듀서가 그대로 견디고, 두 번째 done이 완료 토스트를 겸한다").
T19(CLI 자발 기상 턴)가 **새 run_id를 발급한다**는 규약을 §3.3/§3.5에 명시하지 않으면
정상 흐름이 불변식 위반이 된다. (메모리의 "'답변 도착' 토스트=턴마다" 규약과도 맞물린다.)

### L12 [낮음] 명령표는 8상태다 (`Ended` 없음)

§0은 "9상태", §3.6 표의 열은 8개(`Ended` 제외 — T26이 즉시 `Idle`로 가므로 합리적).
"빈칸 없음"을 주장하려면 그 예외를 한 줄로 적어야 한다.
또 ux §6.1이 새로 만든 명령 8개(`chat:owner`, `chats:*`, `board:*`, `win:chat-*`)는 표에 없다 —
D7("모든 명령은 verdict를 반드시")의 범위를 명시할 것.

---

## 3. 인용 오류 전수

| # | 위치 | 인용 | 실제 | 무게 |
|---|---|---|---|---|
| 1 | m-logic §1 P1 제목 | "손으로 비교하는 **11개** 필드" | 비교항은 **10개**(`engine.ts:1186-1196`: cwd·resume·model·mode·effort·useApi·account·systemPrompt·addDirs·outputStyle) | 수치 |
| 2 | m-logic §1 P5 표 | `systemPrompt` 출처 = "채팅 메타(라이브)" | **렌더러가 `RunRequest.systemPrompt`를 어디서도 세우지 않는다**(전 소스 grep: 세터 0건, 소비처만 `engine.ts:906`·`:1193`·`codex/engine.ts:1554`). 존재하지 않는 동작을 근거로 든 유일한 행 | **실질** |
| 3 | ux §0 표 | 한도 훅 `PanelWindow.tsx:154·233` | 훅은 `:289`. `:154`는 `autoResume` pref useState, `:233`은 `/clear` 분기의 `setHold(null)`. (총 9개라는 **수는 맞다**: App 492 + MA 1629-1634 + SW 648 + PW 289) | 줄번호 |
| 4 | ux §2.2-4·§3.2 | `useTurnNotifyList`(`notify.ts:31`) | `:34`(31은 빈 줄) | 줄번호 |
| 5 | ux §4.2 | "`status`는 저장 시 얼려 오는 규약(`sessionChats.ts:29`)" | `:28`(`:29`는 `cwd`) | 줄번호 |
| 6 | ux §6.1 | "**명령 18 + 이벤트 3 = 21채널**" | 블록 자체가 명령 **22**개, m-logic 채널까지 세면 **명령 23 + 이벤트 7 = 30** | **실질**(U7) |
| 7 | ux §4.1 | "2.6.2는 **활성 채팅 1개만** 스냅샷을 실었다(`chats.ts:50-80`)" | 활성 **또는 스냅샷이 빈** 채팅을 유지한다(`chats.ts:70-75`, `chats.rs:97-104`). 이 예외가 `App.tsx:783`의 빈 채팅 재사용을 받친다 | **실질**(U12) |
| 8 | ux §1.2 | `Chat`의 `locked/color`가 "2.6.2 PanelMeta:113-125 **승계**" | 일반 채팅(`ChatMeta`, `App.tsx:57-73`)엔 `locked`·`color`·`api`가 **없다** — 승계가 아니라 신규 필드(기본값 주입 필요). 마이그레이션 표는 "그대로"라고 적었다 | 실질(작음) |
| 9 | ux §4.2 | "`btwOf`가 가리키는 원본 id도 **같은 매핑표**로 다시 쓴다" | 멀티에서 만든 btw의 `btwOf`는 **panelId 형식** `${sessionId}::${slot}`이다(`MultiAgent.tsx:1346 origin: chan(sessionId, slot)`). 매핑표 키는 `ma-<sid>-<i>` — **키 형식이 달라 그대로는 못 쓴다**(별도 파서 필요) | **실질** |
| 10 | ux §2.4 | "`MultiAgent.tsx:213 blankSession`" | 함수는 `:207`, `:213`은 그 안의 panels 줄 | 줄번호 |

**틀린 인용을 근거로 세운 결정**: #2(P5의 systemPrompt 행 — "절반만 참"의 근거 5개 중 하나가 허수),
#6(55→21이라는 통합 효과 수치), #7(light 조회 규칙 재정의), #9(마이그레이션 btw 그래프 재작성 계획).
나머지 인용(수십 건)은 **전부 정확**했다 — 특히 `optsMatch`·`armHoldIdle`·`activeRunId` 가드·
`tryNotifReplay`·`snapshotForPersist`·`useLimitResume` 3규약·팝아웃 소유권 이전 4지점은 줄까지 맞다.

---

## 4. `ChatRef{surface,id}` vs `chatId` — 판정

### 판정: **`chatId` 단일 문자열이 옳다. `ChatRef`는 삭제한다.**

근거 셋 (전부 코드 대조):

1. **surface는 주소가 아니라 스토어 선택자였다.**
   2.6.2에서 surface가 하는 일은 "어느 스토어/어느 IPC 세트를 쓸까"다 —
   `single`→`chats/`(`chats.ts`), `multi`→`${sessionId}::${slot}`(`MultiAgent.tsx:236`)+`maStore.ts`,
   `session`→`session-chats/`(`sessionChats.ts`). ux §4.1이 스토어를 `chats/` 하나로 접는 순간
   surface가 실어 나르는 정보량은 **0비트**가 된다.

2. **m-logic 자신이 surface를 한 번도 쓰지 않는다.**
   `ChatRef`가 등장하는 곳은 `IdentitySetCmd.ref`·`ChatIdentityEvent.ref`·`ChatRunStateEvent.ref` 필드뿐이고,
   §3.3의 31전이·§3.6의 19×8 판정표·§5의 원장 규칙·§7의 큐/hold 규칙 **어디에도 `surface` 분기가 없다**(언급 0회).
   쓰지 않는 축을 타입에 남기면 3표면 분기가 API 시그니처로 영구화된다 — M-UX가 없애려는 바로 그 자리.

3. **남기면 같은 채팅이 두 주소를 갖는다.**
   팝아웃/창 이동으로 표면이 바뀌면 같은 `ChatRuntime`이 `{multi,X}` → `{session,X}`로 주소가 변한다.
   브로드캐스트 구독자(창들)가 ref로 매칭하면 이동 순간 이벤트를 놓친다.
   2.6.2 토스트가 정확히 이 형태의 키를 쓴다: 감시 키 = `` `${surface}:${id}${sub}` ``(`notify.ts:38`),
   그래서 멀티 패널은 `sub`로 슬롯을 덧붙여야 했다(`MultiAgent.tsx:896`). 통합 후에도 이 구조를 남기면
   같은 버그 계열이 이식된다.

### ux의 절충안("과도기 어댑터 전용")은 절반만 맞다

어댑터가 필요한 것은 **옛 채널명**이지 `ChatRef` **타입**이 아니다. 옛 채널은 각자 자기 인자를 갖는다:
`ma:*`→`panelId`, `session:*`→창 wcId, `claude:*`→인자 없음(활성 채팅).
따라서 별칭 계층에 필요한 건 함수 3개(`panelIdToChat`, `wcIdToChat`, `activeChat`)이지 공용 주소 타입이 아니다.
타입을 만들면 §4.3의 코어 채널 4개에 그대로 박힌다 — **m-logic 초안이 이미 그렇게 박아 놓았다.**

**지시**: `ChatRef`를 `chatId: string`으로 치환하고, §4.3의 4개 채널·§5.6 브로드캐스트의 `ref` 필드를
`chatId`로 바꿀 것. `surface`가 필요하다고 느껴지는 자리가 남으면 그건 **창 라우팅**이며,
답은 창 레지스트리의 `chatId → [label]` 역인덱스다(ux §6.1). 단, 그 역인덱스는 U5(owner)와 함께 정의해야 한다.

---

## 5. 재생 하네스 8조합 — 종이 재생(trace) 결과

각 시나리오를 §3.3 전이표 + §3.4 착지 + §3.6 판정표만 써서 손으로 돌렸다.

| # | 표현 가능? | 결과 |
|---|---|---|
| **1** 계정 변경 중 턴 시작 | **✗ 마지막 단언 불가** | 이 시나리오엔 라이브 항목이 없다 → §3.4가 `close_input() → Terminating{AllClear} → Ended → Idle`로 착지한다(2.6.2 파리티 ✓ — `engine.ts:531`,`:658-663`). 그러면 다음 `send`는 **ColdStart**라 "재사용 판정 = `Respawn{IdentityChanged[billing]}`"이라는 단언이 **나올 수 없다**. 시나리오에 bg 셸 1개를 심거나 단언을 고쳐야 한다 |
| **2** 폴백 직후 계정 변경 | **✗ 두 군데** | (a) L3 — `deferred` 전체 교체가 폴백 model을 되돌려 `IdentityChanged[engine,billing]`이 안 나온다. (b) L4 — 폴백 신호 합류가 없어 리비전이 1개인지 2개인지 결정 불가. #1과 같은 ColdStart 문제도 그대로 |
| **3** busy 중 채팅 전환 | **✓** | 상태기계로 표현된다(두 `ChatRuntime` 독립). 단 O2 미해결이라 **하네스가 초록이어도 앱은 깨질 수 있다**(렌더러 리듀서 1개를 채팅들이 갈아탄다) — 하네스가 Rust만 때리므로 이 시나리오의 실제 위험은 검증 범위 밖이다. 문서가 그 한계를 안 적었다 |
| **4** 예약 큐 + 한도 소진 | **△ 미정의 2개** | 뼈대는 표현된다(T30→§3.4→hold 게이트→ready→head 삽입→T27). 미정의: ① 삽입되는 `origin:'limit_resume'` 항목의 **정체성**(현재값? 원래 항목 스냅샷?) — §7.3에 없다. ② 항목마다 정체성이 다르면 드레인이 **매 항목 재스폰**인지, 그 비용을 UI가 어떻게 알리는지. 4b(hold 무효화)는 ✓ |
| **5** 중단 직후 재개 | **✗ 픽스처와 SUT가 어긋난다** | `wire/interrupt.jsonl`은 같은 프로세스로 2·3턴이 이어진다(poc 하네스가 stdin을 안 닫으니까 — `m3-poc-findings.md:39`,`:253-254`). 그런데 SUT는 aborted result 시점에 라이브 항목이 0이라 §3.4가 `close_input`을 부른다 → `Terminating`. **"그대로 재생"이 불가능**하다. 단언 "프로세스 생존 + 재스폰 없이 2턴"은 라이브 항목이 있을 때만 참 |
| **6** 백그라운드 살아있는 상태의 중단 | **✓** | T13(카드 선해제)→result→§3.4(원장 남음)→`Resident`→T16 주입. 6b(정체성 변경→T17, 셸 정착 `IdentityChanged`)도 ✓. **8조합 중 가장 잘 표현된다** — 그리고 실제로 가장 중요한 미검증 구간이다 |
| **7** 워크플로 도는 중 CLI 강제 종료 | **△ 본체 ✓ / 7b ✗** | 본체는 T22→`StreamGuard::drop`→T25→T26로 깔끔히 떨어진다. **7b는 L2로 성립 불가**(프로세스 생존 프로브가 Alive를 준다). 7c(force_settle) ✓ |
| **8** 승인 카드 뜬 채 CLI 사망 | **✓ (규약 1개 누락)** | T22 → AskCard 정착 → 종결 status 1회(`emit_terminal_status_once`) → 대기자 0. 단 단언 "지연된 `control_response`는 버려진다(unmatched LRU)"는 **SDK의 1024 캐시 규약**이다(`protocol-claude-cli.md:389-392`). Rust가 직접 몰면 우리가 구현할 규약인데 설계 본문에 없다 |

**요약: 8조합 중 온전히 표현되는 것은 3개(#3·#6·#8), 부분 2개(#4·#7), 불가 3개(#1·#2·#5).**
공통 불변식 10개 중 #3은 L11로 위험, 나머지는 타당하다(특히 #10 미지 프레임 주입은 `protocol §5.16`과 일치).

---

## 6. 마이그레이션 무손실 — 누락 필드

ux §5.2 인벤토리에 **없는데 2.6.2 저장 스키마에 있는(또는 통합 스키마가 요구하는)** 것:

| 항목 | 2.6.2 위치 | 왜 문제인가 |
|---|---|---|
| **한도 대기표** | `ui-prefs.limitResume.hold`(단일 슬롯, key=activeChatId — `App.tsx:506-515`, `sanitizeHold`) | 통합 스키마엔 `Chat.hold`가 있는데 **채울 출처가 마이그레이션 표에 없다**. 검증표에도 행이 없다 |
| **전역 API 과금** | `ui-prefs.api.mode`(`App.tsx:180`) | 채팅별 `identity.billing`으로 승격 = 의미 변경(U10). 표에도 검증에도 없다 |
| **전역 출력 스타일** | `ui-prefs['claude.outputStyle']`(`engine.ts:57-59`) | `identity.outputStyle` 물질화(m-logic §2.4/O5)의 출처. ux 표에 없다 |
| **자동 이어서 토글** | `ui-prefs.limitResume.on` | 통합 후 전역인지 채팅별인지 미정 |
| **보드 목록 순서** | `multi-agent/index.json.order`(`maStore.ts:73`,`:180`) | 표는 `activeSessionId`만 매핑. `boards/index.json.order`를 뭘로 채우나 |
| **추가 채팅 목록 순서** | `session-chats/index.json.order` | 같은 문제 — 통합 후 `chats/index.json.order`의 어디에 끼우나(뒤? 시간순 병합?) |
| **추가 채팅 잔여 필드** | `SessionChatRecord`의 `status`(얼린 값)·`empty`·`draft`·`draftImages`·`updatedAt`(`sessionChats.ts:24-46`) | §4.2 행은 일부만 열거. 특히 `empty`는 §2.4 "빈 채팅 디스크 skip"·`sessionChats.ts:104` 규칙과 직결 |
| **btw 원본 키 형식** | `btwOf`가 멀티에선 `${sessionId}::${slot}`(`MultiAgent.tsx:1346`) | 인용 오류 #9 — 매핑표만으로는 재작성 불가. "고아 0건" 검사가 이걸 잡겠지만 **설계가 먼저 규칙을 적어야** 한다 |
| **패널 초안/큐** | `PersistedPanel`에 **없다**(`MultiAgent.tsx:127-137`) — input/images/queue는 영속되지 않는다 | 손실은 아니지만 §5.2의 "초안 맵 동일"이 패널에 대해 공집합 비교임을 명시해야 오검출이 안 난다 |
| **팝아웃/창 상태** | `panelLeftovers`(main 메모리), 창 목록 | 2.6.2도 재시작 복원 안 함 → 손실 아님. **명시적으로 "이관 없음"으로 적을 것**(지금은 침묵) |
| **읽지 않음 배지** | **2.6.2에 없다** | 사이드바는 상태 점(`styles.css:336-341`)뿐. 이관 대상 없음 — 정직하게 "해당 없음"으로 |

검증 절차 자체에도 두 구멍:
- §5.3의 6개 검사에 **"별칭 계층 왕복"**이 없다. §6.2가 옛 렌더러를 계속 돌리겠다고 했으므로
  `ma:save`(옛 블롭) → `board:*`+`chats:*` → `ma:get`(재조립) 왕복이 무손실인지가 **대화 증발의 두 번째 자리**다.
- `canon()`의 타임스탬프 화이트리스트를 "리포트에 명시"까지만 정했는데, `updatedAt`은 인벤토리 항목이면서
  왕복 검사(§5.3-1)에서 갱신될 수 있다. 어느 쪽인지 못 박을 것.

---

## 7. 목업 판정

**밀도: 합격.** "여백만 넓힌 깔끔함"이 아니다. 4장을 Electron으로 실제 렌더해 확인했다.

근거(렌더 캡처 + 마크업):
- 사이드바 10~14행 + 슬롯 칩 + 상대 시간 + 섹션 카운트/검색/삭제 아이콘 — 2.6.2 행 높이·폰트 급.
- 워크바 5~7칩(파일/셸/서브에이전트/워크플로/컨텍스트 게이지 `52% · 104k/200k`/5h/주간).
- 컴포저: 모델 dot칩·effort·mode·폴더칩·계정 고스트칩 + 아이콘 4개 + 전송.
- 스레드: user/ai 말풍선 + `toolgroup`(파일 편집 3건, +64/−12 diff 수치) + `runline`(진행 스피너).
- 뷰어: 라인 번호 + **전행 틴트 diff**(메모리의 "gutter bar 금지" 규약 준수) + 읽기/편집/diff 모드칩.
- 한도 배너·btw 도크·질문/승인 카드(Enter/Esc 키캡)·빈 자리 타일·팝아웃 유령 셀까지 있다.

**스펙의 답이 그림에 있는가:**

| 스펙의 답 | 목업 | 판정 |
|---|---|---|
| 다이얼에 1 추가 | `chat-unify-dial.html` — 4상태 스트립(1/1+5접힘/2+4접힘/6) | ✓ |
| 6→1 접힘 배지 | `collapse` — 배지 `⌄5` + **팝오버 열린 상태**(자리번호·제목·상태·↥) | ✓ |
| 접힌 대화의 3행선지 | 사이드바 흐린 `⌄N` 칩 + 배지 팝오버 + 헤더 "접힌 자리 실행 3" 요약 칩 | ✓ (세 곳 전부 그렸다) |
| 자리 스코프 승인 카드 | `grid4` — 포커스 자리 안에만, 숫자 키캡 | ✓ |
| 빈 자리 타일 | `grid4` — "＋새 채팅 / 최근에서 고르기 / 이 자리 숨기기" | ✓ |
| 창 자리 = 팝아웃+추가채팅 통합 | `grid2` 유령 셀 + 사이드바 "창" 칩 | ✓ |

**미흡 5건:**
1. **글과 그림이 다르다** — 목업은 그리드에서도 왼쪽 칼럼(사이드바)을 유지하는데
   §3.1은 왼쪽 칼럼을 `<IdeShell>`(count=1 전용) 안에 넣었다. **U4의 증거이자 그림 쪽이 옳다.**
2. `chat-unify-1-ide.html`에 창 컨트롤(`—/▢/✕`)이 없다(`dial`엔 있다) — 헤더 우측 구성이 장면마다 다르다.
3. 주석 말풍선이 실제 콘텐츠를 가린다(1-ide: 뷰어 코드 3줄 + 스레드 한 문장). 판정용 캡처로는 손해.
4. **안 그려진 것**: 접힌 자리에서 뜬 **승인/질문 카드를 어떻게 알리는지**(1 모드에서 보이지 않는 자리의
   승인 대기 — 스펙에도 없다), 워크플로 도크, 백그라운드 셸 칩 팝오버, q-mini,
   팝아웃 창/추가 채팅 창 **자체**의 통합 후 모습(§3.3이 가장 크게 바꾸는 화면인데 그림이 없다).
5. 사이드바 (a)안만 그렸다 — §8-1의 (b)(c)는 비교 그림 없이 열린 문제로만 남았다.

---

## 8. 각 스펙의 가장 큰 격차 + 설계자에게 돌려보낼 지시

### M-UX — 가장 큰 격차: **통합 모델에 자리가 없는 화면이 스펙 안에서 드러나지 않는다**

스펙은 §0 표에서 "이중 배선 7종"을 세었지만, 그 표는 **자기가 아는 것만** 센 목록이다.
실제로 세지 않은 이중 배선(코드 뷰어 4벌)과, 새 모델에 행선지가 없는 화면
(접힌 채팅의 토스트/상태, 멀티의 왼쪽 칼럼·탐색기 추종, 뷰어發 질문의 대상 채팅)이 최소 4갈래 남았다.
북극성이 "한 번만 구현"인데 **무엇이 몇 번 구현돼 있는지 세는 대장이 없다.**

> **지시**: §3에 **「161화면 사영표」**를 붙여라.
> `docs/screen-inventory.md`의 각 id에 대해 열 5개 —
> `IdeShell` / `GridCell` / `WindowShell` / **앱 크롬**(자리 밖) / **사라짐**.
> 규칙: (a) 「사라짐」 칸에는 사용자 승인이 필요한 문장을 함께 적을 것,
> (b) 두 칸 이상에 체크되면 그게 곧 "아직 이중 배선"이므로 통합 방법을 한 줄로 적을 것,
> (c) 최소한 인벤토리 **8절(멀티 17화면) · 9절(독립 창 5화면) · 5절(코드 뷰어 26화면)**은 전수.
> 이 표가 U1·U4·U9를 스펙 안에서 스스로 잡는다.

### M-LOGIC — 가장 큰 격차: **P8을 죽인다는 워치독이 P8 조건에서 발화하지 않는다**

문서의 존재 이유는 사용자 실물 버그(고아 워크플로 알약)다. D8·D9가 그걸 죽인다고 선언했고
재생 7b가 그 증명이다. 그런데 §5.4의 프로브 목록 1번(CLI 프로세스 생존)이
**P8의 정의 자체("프로세스는 살아 있는데 워크플로가 죽었다")와 정면으로 충돌**해
의사코드대로면 리스가 영원히 재장전된다. 한 줄 수정으로 고칠 수 있지만, 고치기 전까지
**이 문서의 간판 주장이 거짓**이다.

> **지시**: 세 가지를 같이 해라.
> 1. §5.4 프로브를 **등급으로 재정의**: `프로세스 사망 = Dead 확정`(단독 판정 가능),
>    `REPLACE 멤버십 / task_progress 하트비트 / 전사·outputFile mtime = Alive 판정 가능`,
>    **프로세스 생존은 Alive 근거에서 제외**. 각 `LiveKind`별로 "Alive를 줄 수 있는 프로브"를 표로 고정.
> 2. **7b를 첫 빨간 테스트로** 커밋해라(§11 3번보다 먼저). `freeze{35분}`에서
>    `90s → unverified → 30분 → Watchdog` 시각표가 가상 시계로 정확히 재현되는지가 게이트다.
> 3. 같은 라운드에 **L1(중단이 큐를 안 비운다)**과 **L3(deferred 전체 교체가 폴백을 되돌린다)**을 닫아라 —
>    둘 다 "새로 만드는 버그"이고, L1은 `App.tsx:908 setQueue([])` 한 줄, L3은 `pending`을
>    `{patch, base_revision}`으로 바꾸는 한 줄이다. 그 다음에야 §3.3 전이표를
>    `protocol-claude-cli.md §8.4`의 22행과 **전수 대응**시켜(L5) "31전이"라는 수를 써라.

---

## 부록 — 검증에 쓴 명령

- 인용 전수 해석: 두 스펙의 `파일:줄` 패턴을 뽑아 실제 파일에서 그 줄을 출력하는 일회성 스크립트(`%TEMP%`).
- 목업 렌더: Electron `BrowserWindow` 1700×1100으로 4장 `capturePage` → `%TEMP%\ccg-mockshots\`
  (사용자 실앱과 충돌 없음 — 별도 프로세스, `CCG_HOME` 격리, 이름 kill 없음).
- 레포에 남긴 산출물은 이 파일 하나다.
