# M-UX 「채팅 통합」 — 설계 스펙 (3.0.0)

상태: **스펙 확정 제안 + 목업**. 코드 없음. 구현은 다음 라운드.
근거는 전부 얼린 2.6.2 소스(`src/`)에서 확인했고 파일:줄로 남겼다. 추측으로 쓴 문장은 없다.

목업: `docs/design/mockups/chat-unify-*.html` (5장)

---

## 0. 요구 (사용자 채택안)

일반 채팅과 멀티 채팅을 「채팅」 하나로 합친다. 패널 개수 다이얼에 **1**을 추가한다.

- **1** = 기존 일반 채팅 그대로 — 전체 IDE 레이아웃(탐색기·코드 뷰어·Git·워크바 전부)
- **2+** = 멀티 그리드
- 1↔N 전환에서 **대화를 잃지 않는다.** 현재 대화는 항상 1번 자리. 6→1로 내려도 나머지
  대화는 삭제되지 않는다 — 그 대화들이 UI 어디로 가는지 이 스펙이 답한다.

### 왜 하는가 (북극성)

2.6.2는 대화를 담는 그릇이 **네 벌**이고 IPC가 **다섯 세트**다. 같은 기능이 표면마다
따로 배선돼 파리티 버그가 반복됐다. 통합 모델의 존재 이유는 "한 번만 구현되게" 하는 것이다.

| 기능 | 2.6.2 배선 수 | 위치 |
|---|---|---|
| 승인/질문 카드 | 4 | `App.tsx:1674,1676` · `MultiAgent.tsx:752,757` · `SessionWindow.tsx:863,865` · `PanelWindow.tsx`(PanelView 재사용) |
| 한도 자동 이어서 | 9개 훅 인스턴스 / 4 표면 | `App.tsx:492` · `MultiAgent.tsx:1629-1634`(슬롯당 1개×6) · `SessionWindow.tsx:648` · `PanelWindow.tsx:154·233` |
| btw 포크 | 4 | `App.tsx:962`(tryBtw) · `MultiAgent.tsx:1336`(tryBtwPanel) · SessionWindow · PanelWindow |
| 토스트 알림 | 3 surface enum | `protocol.ts:811` `'single' \| 'multi' \| 'session'`, 라우팅 `App.tsx:718-726` |
| 계정/모델 picker | 3 소유처 | `App.tsx:157`(useState) · `MultiAgent.tsx:113-125`(PanelMeta.picker) · `sessionChats.ts:32`(레코드 필드) |
| 대화 스토어 | 4 | `chats/` · `multi-agent/` · `session-chats/` · `chat-talk.json` |
| 엔진 IPC | 4세트 | `claude:*` · `ma:*` · `session:*` · `talk:*` (`protocol.ts:942-1006`) |

IPC 실측 수(`protocol.ts:942-1006`, `1130-1138`): 명령 48 + 이벤트 7 = **55채널**이 대화
하나를 굴리는 데 쓰인다. (claude 6 / ma 17 / talk 7 / session 6 / session-wins 7 /
win:open-session 1 / btw:open 1 / chats 3 / 이벤트 7)

---

## 1. 통합 데이터 모델

### 1.1 후보 비교

#### 후보 A — 「세션이 패널을 소유」 (멀티 모델을 확장, 1은 count=1 특수 케이스)

2.6.2 멀티(`MultiAgent.tsx:139-158 PersistedSession`)를 그대로 승격시킨다. 사이드바의
단위는 세션. 일반 채팅 = 패널 1개짜리 세션.

- 장점: 멀티 코드가 거의 그대로 살아남는다. `count`·`panelOrder`·팝아웃이 무변경.
- 단점 ①: 기존 일반 채팅 N개가 전부 "패널 1개짜리 세션 N개"가 된다 — 사이드바가 세션
  목록으로 바뀌면서 **채팅 단위 탐색이 사라진다.** 대화 하나를 찾는 게 두 단계가 된다.
- 단점 ②: 6→1 축소 시 나머지 5개 대화의 UI 행선지가 "세션 안에 접혀 있음"밖에 없다.
  사이드바 어디에도 개별로 안 보인다 → 사용자 요구("어디로 가는지 답하라")에 약한 답.
- 단점 ③: 슬롯 번호가 곧 엔진 채널(`chan()` = `${sessionId}::${slot}`, `MultiAgent.tsx:236`)
  이라 자리와 정체성이 붙어 있다. M-LOGIC의 "실행 상태는 채팅에 붙는다"와 정면 충돌.

#### 후보 B — 「평평한 채팅 풀 + 자리(뷰)」 (배치는 휘발)

채팅은 단일 풀. 패널은 채팅을 가리키는 자리일 뿐. 배치는 앱 상태 하나(현재 배치)만.

- 장점: 6→1 답이 자명하다 — 대화는 애초에 자리에 속한 적이 없다. 그대로 목록에 있다.
- 단점: 2.6.2 멀티 세션 목록(`useMultiSessions`, `MultiAgent.tsx:1949`)이 갈 곳이 없다.
  "그때 그 4개 조합"을 되부르는 기능이 사라진다 — **기능 손실**(3.0의 금지 사항).

#### 후보 C — 「채팅 풀 + 자리 + 보드」 ★ **추천**

B에 "배치를 저장 가능한 객체"를 더한 것. 세 개념이 각자 하나씩만 책임진다.

```
Chat   (대화)   = 스레드 + 정체성(RunIdentity) + 초안/큐 + 실행 상태.   ← 유일한 진실
Slot   (자리)   = 화면에서 채팅 하나를 보는 칸. chatId를 가리킬 뿐 소유하지 않는다.
Board  (배치)   = 자리들의 구성 { count 1~6, order, slots[6] }. 2.6.2 멀티 세션의 후신.
```

- 다이얼 N = **활성 보드의 count** = 동시에 보는 자리 수.
- 6→1 답: 자리만 접힌다. 대화는 풀에 그대로 있고(사이드바 「채팅」), 보드는 접힌 자리의
  배정을 **기억**하므로 다이얼을 되올리면 같은 자리로 복귀한다. (§2.2)
- 멀티 세션 목록 = 보드 목록으로 1:1 이관 → 기능 손실 없음.
- 엔진 채널이 `chatId`가 되므로 자리 번호·다이얼 값과 완전히 분리된다 → M-LOGIC 전제와 일치.

**추천: 후보 C.** 이유는 세 가지다.
1. 6→1 요구에 데이터 모델 자체가 답한다(자리와 대화의 분리). UI 규칙을 덧대 막는 게 아니다.
2. 표면 통합(§3)이 "채팅 하나를 그리는 컴포넌트 1개 + 자리 껍데기 3종"으로 떨어진다.
   2.6.2가 4벌로 배선한 것들이 구조적으로 1벌이 된다.
3. 2.6.2 멀티 세션·추가 채팅·일반 채팅이 전부 이 모델의 특수 케이스로 표현된다 —
   마이그레이션이 **의미 손실 없는 사영**이다(§5.2).

### 1.2 타입 스케치

```ts
// 대화 — 유일한 진실. 실행 상태·초안·큐·정체성이 전부 여기에 붙는다.
interface Chat {
  id: string
  title: string; custom: boolean; locked: boolean; color: string   // 2.6.2 PanelMeta:113-125 승계
  identity: RunIdentity     // {engine,account,cwd,addDirs,model,effort,mode,apiMode,systemPrompt,outputStyle}
                            // ← M-LOGIC 소유. picker(3벌)·manualCwd·refDirs·api를 흡수
  draft: string; draftImages: string[]
  queue: ScheduledMsg[]     // 2.6.2는 본채팅만 App state(App.tsx:165), 패널은 PanelMeta.queue
  snapshot: SessionState    // 스레드 + session(resume id) + status + files + workflows
  hold?: LimitHold          // 한도 대기표 — 2.6.2는 훅 인스턴스마다 흩어져 있다
  btwOf?: string; btwSeed?: {fork:string;cwd:string}; btwPrompt?: string   // sessionChats.ts:43-45
  updatedAt?: number
  unloaded?: boolean        // 스냅샷이 메모리에 없음 (chats.ts:22-35 규약 그대로)
}

// 자리 — 채팅을 보는 칸. 대화를 소유하지 않는다.
type Slot =
  | { kind: 'grid';   index: 0..5; chatId: string | null }   // 보드의 칸
  | { kind: 'window'; label: string; chatId: string }        // 별도 OS 창 (추가 채팅 + 팝아웃 통합)

// 배치 — 2.6.2 PersistedSession(MultiAgent.tsx:139-158)의 후신
interface Board {
  id: string; title: string; custom: boolean
  count: 1 | 2 | 3 | 4 | 5 | 6        // 다이얼. 2.6.2 clampCount는 하한 2(MultiAgent.tsx:216-219)
  chrome: 'ide' | 'grid'              // count=1의 기본은 'ide'. 확장점(M9 전용 뷰)
  order: number[]                      // 자리 순열 — 2.6.2 panelOrder(MultiAgent.tsx:884-886)
  slots: (string | null)[]             // 길이 6. 인덱스=슬롯 정체성, 값=chatId (null=빈 자리)
  updatedAt?: number
}
```

**핵심 불변식 4개**
1. **대화는 어느 자리에도 속하지 않는다.** 자리가 대화를 가리킨다. 역참조는 파생값이다.
2. **한 채팅은 동시에 최대 한 자리에서 보인다.** 같은 chatId를 두 자리에 넣는 것은 금지
   (같은 스레드에 두 컴포저가 붙으면 초안·큐가 갈라진다 — 2.6.2가 팝아웃에서 소유권
   이전으로 막던 바로 그 문제, `MultiAgent.tsx:1274-1309`).
3. **엔진은 chatId가 소유한다.** 자리 이동·다이얼 변경·팝아웃으로 엔진이 재스폰되지 않는다.
4. **자리에서 사라져도 실행은 계속된다.** 2.6.2 멀티가 이미 그렇다("a session's runs keep
   going in the background after you switch away", `MultiAgent.tsx:57-58`) — 그 규약을
   전 표면으로 넓힌다.

---

## 2. 다이얼 1~6 상호작용

### 2.1 다이얼과 크롬

| N | 크롬 | 근거 |
|---|---|---|
| 1 | **IDE 레이아웃** — 왼쪽 칼럼(사이드바⟷탐색기 `` ` `` 전환), 코드 뷰어, Git 카드, 풀 워크바, 변경파일 카드 | 2.6.2 `App.tsx:1437-1466`(lcol) + `:1489-1630`(chat--code) 그대로 |
| 2‥6 | **그리드** — `.ma-grid.nN` 배치(2·3 한 줄, 4=2×2, 5=3+2 스팬, 6=3×2), 패널은 zoom .8 미니어처 | `styles.css:3623-3634`, `MultiAgent.tsx:1856` |

다이얼은 현재 위치를 유지한다: 2.6.2에서 다이얼은 멀티 헤더 오른쪽(`MultiAgent.tsx:1812-1833`,
`.ma-count`), 1 모드에서는 채팅 헤더 오른쪽 같은 자리. 즉 **1↔2 전환에서 다이얼 버튼이
화면에서 이동하지 않는다** — 이게 "합쳐졌다"는 유일한 시각적 증거이므로 위치 고정이 규약이다.

### 2.2 N→1 축소 (6→1이 대표)

```
before  count=6  order=[0,1,2,3,4,5]  slots=[A,B,C,D,E,F]   focused=slot2(C)
after   count=1  order=[2,0,1,3,4,5]  slots=[A,B,C,D,E,F]   ← slots 무변경
                 보이는 자리 = order.filter(i => 자리번호<count) = [2] → C
```

규칙:
1. **현재 대화 = 1번 자리.** 축소 시 포커스된 자리의 채팅이 `order`의 맨 앞으로 이동한다.
   나머지 자리의 상대 순서는 보존. (2.6.2 `visibleSlots = panelOrder.filter(s => s < count)`,
   `MultiAgent.tsx:886`을 그대로 쓰되, 필터 기준이 "슬롯 번호 < count"가 아니라
   "**order 내 위치 < count**"로 바뀐다 — 이게 축소가 자리를 잃지 않게 하는 한 줄이다.)
   2.6.2는 `s < count`라서 count를 6→2로 줄이면 슬롯 4번 패널이 보이던 자리를 통째로 잃었다.
2. **접힌 자리는 살아 있다.** `slots` 배열은 손대지 않는다. 엔진도 죽이지 않는다
   (2.6.2 `ma:dispose`는 세션 삭제에서만 호출, `MultiAgent.tsx:2161`).
3. **접힌 대화의 UI 행선지 — 세 곳에 동시에 있다:**
   - **사이드바 「채팅」 목록** — 애초에 항상 거기 있었다. 실행 중이면 상태 점이 계속 돈다
     (2.6.2 `.sb-item .dot.run`, `styles.css:336-341`).
   - **다이얼 옆 접힘 배지** — `1 ⌄5`. 클릭하면 접힌 자리 팝오버: 자리 번호·제목·상태 칩 ·
     "이 자리로 바꾸기"(그 채팅을 1번 자리로) · "자리 비우기"(보드에서만 제거, 대화는 유지).
   - **워크바/타이틀 라인의 실행 중 칩** — 접힌 자리에서 도는 실행이 몇 개인지. 2.6.2가
     멀티 뷰 밖에서 멀티 실행을 못 보던 문제(사이드바 점만 있었다)를 여기서 갚는다.
4. **축소해도 토스트는 계속 온다.** 2.6.2 `useTurnNotifyList`(`notify.ts:31`,
   `MultiAgent.tsx:891-898`)가 `sessions.map`으로 전 슬롯을 감시한다 — 통합 후에는
   "열려 있는 채팅 전부"(보드 slots ∪ 창)로 감시 대상이 정의된다. 접힘은 표시 상태일 뿐
   감시 대상에서 빠지지 않는다.

### 2.3 1→N 확대

1. 1번 자리(= 현재 대화)는 그대로 1번 자리에 남는다.
2. 자리 2‥N은 보드가 기억한 배정(`slots[order[1..N-1]]`)으로 되채워진다.
3. 기억이 없거나(첫 확대) 배정이 가리키던 채팅이 삭제됐으면 **빈 자리**.

### 2.4 빈 자리

빈 자리(`slots[i] === null`)는 대화가 아니다. 카드 하나를 그린다:
`＋ 새 채팅` / `최근 채팅에서 고르기`(목록 팝오버) / `이 자리 숨기기`(count −1).

2.6.2의 빈 패널은 "아직 안 쓴 대화"였고(`MultiAgent.tsx:213 blankSession`), 사이드바에는
제목이 생길 때까지 안 보였다(`MultiAgent.tsx:2209-2223 summaries` 필터 / 본채팅은
`App.tsx:709-712 activeEmpty`). 통합 후 규칙:
- 빈 자리에서 첫 전송 → 그 순간 채팅이 생성돼 풀에 편입 + 그 자리에 배정.
- 제목이 생기기 전(=첫 전송 전) 채팅은 사이드바에 안 보인다. **빈 채팅 최대 1개** 규칙
  (`App.tsx:781-788`)은 "자리당 최대 1개"로 일반화.
- 디스크에는 남기지 않는다 — `sessionChats.ts:104`의 `(rec.empty && !rec.btwOf) → skip`을
  전 채팅에 적용. 단 btw 채팅은 빈 채로도 남긴다(알약 규약).

### 2.5 자리 번호와 팝아웃 소유권

2.6.2에서 자리 번호는 **표시**(그리드 위치)고 슬롯 번호는 **정체성**(엔진 채널)이다
(`MultiAgent.tsx:144-147`, `:266`, `:883-886`). 통합 모델에서 이 이중성이 사라진다:

| | 2.6.2 | 3.0 통합 |
|---|---|---|
| 엔진 채널 | `${sessionId}::${slot}` (`MultiAgent.tsx:236`) | `chatId` |
| 자리 번호 | `visibleSlots.indexOf(slot)+1` | 동일 (`order` 내 위치) |
| 팝아웃 키 | panelId(=세션+슬롯) | chatId |
| 팝아웃 중 그리드 | 유령 셀(`MultiAgent.tsx:1865-1879`) | 동일 — 유령이 chatId를 가리킨다 |
| 자리 이동/다이얼 변경 시 창 | `slotOfPanelId`가 count 밖을 가리키면 미아 | 무관 (창은 chatId로 라우팅) |

**소유권 이전 규약은 살아남되 한 필드로 줄어든다.** 2.6.2는 창을 열 때 초안·이미지·예약
큐를 창으로 넘기고 그리드 쪽을 비운다(`MultiAgent.tsx:1304 patchMeta(slot,{input:'',images:[],queue:[]})`),
한도 대기표도 넘긴다(`:1306 lrs[slot].setHold(null)`, 짝: `:1617` 미러 비활성화 주석),
닫히면 `maPanelClosed`의 flush로 되메운다(`:1240-1254`, main `index.ts:722-732`), 화면이
내려가 있었으면 leftover로 다음 마운트가 소비한다(`:1255-1273`, main `index.ts:667-670`,
`:1315-1330`).

통합 모델에서는 초안·큐·대기표가 **채팅에 붙어 있고 창은 그 채팅의 뷰**라 복사본이 없다.
넘길 것은 "누가 구동하는가"뿐:

```ts
Chat.owner: string   // 창 라벨. 'main' | 'window:<label>'
```

- 창을 열면 `owner = 창 라벨`, 닫히면 `'main'`.
- **큐 드레인·한도 대기표 타이머·자동 재개 전송은 `owner === 내 창`일 때만 돈다.**
  (2.6.2의 `enabled` 게이트 `MultiAgent.tsx:1617`와 큐 드레인 가드 `:1653`가 하던 일)
- persist→fold-back / leftover 소비는 **불필요해진다** — 상태가 애초에 한 곳(스토어)에
  있으니 돌려줄 게 없다. 창이 죽어도 마지막 자동저장까지는 스토어에 있다.
- 남는 위험: 창이 크래시하면 `owner`가 그 창에 박힌 채 남는다 → 창 레지스트리에서
  라벨이 사라질 때 `owner`를 `'main'`으로 되돌리는 **고아 회수**가 필수(M-LOGIC의
  고아 상태 정리 규약과 같은 자리).

---

## 3. 표면 통합 — 한 벌로 배선하기

### 3.1 컴포넌트 경계

```
<ChatSurface chatId>            ← 채팅 하나를 그리는 유일한 컴포넌트
   ├ 스레드 (MessageView, useThreadWindow, useThreadFollow)
   ├ WorkBar          (Chat.tsx:3142)
   ├ Composer         (Chat.tsx:4251)
   ├ LimitHoldBar     (Chat.tsx:2729)      ← 30초 틱을 스스로 소유 (memo 함정, :2729·useLimitResume.ts:169-171)
   ├ QuestionModal    (Chat.tsx:3585)      ← 자리 스코프
   ├ PermissionModal  (Chat.tsx:3634)      ← 자리 스코프
   ├ WorkflowDock     (Chat.tsx:3982)
   └ BtwDock          (Chat.tsx:4059)

자리 껍데기 3종 — ChatSurface를 담기만 한다
   ├ <IdeShell>    count=1: 왼쪽 칼럼 + 코드 뷰어 + Git + 변경파일 카드
   ├ <GridCell>    count≥2: 패널 헤더(자리번호·제목·폴더칩·상태·크게보기·팝아웃) + zoom .8
   └ <WindowShell> 별도 OS 창: 창 헤더(WinControls) + 리사이즈
```

2.6.2 대응: `App.tsx`(IDE) · `MultiAgent.tsx PanelView:317`(그리드) ·
`SessionWindow.tsx`(창) · `PanelWindow.tsx`(창) 네 벌 → **1 + 3**.
`PanelView`는 이미 "본채팅과 완전히 같은 문법"을 목표로 만들어져 있다(`MultiAgent.tsx:261-263`
주석) — 통합은 그 목표를 코드로 확정하는 것이다.

### 3.2 기능별 통합 방법

**승인/질문 카드.** 카드는 항상 `ChatSurface` 안에 그린다(= 자리 스코프). 2.6.2 멀티가
이미 그렇다(`screen-inventory.md:226-227` `multi-panel-question`/`multi-panel-permission`).
1 모드에서는 자리가 화면 전체이므로 지금과 똑같이 보인다. 키보드(숫자/화살표/Enter)는
**포커스 자리만** — 2.6.2 `focusedSlot` 게이트(`MultiAgent.tsx:1017-1110`)를
`focusedChatId` 하나로 승격. IDE 모드는 자리가 하나라 항상 포커스.

**한도 자동 이어서.** `useLimitResume`(`lib/useLimitResume.ts:18-30`)은 이미 표면 중립
인터페이스다 — 통합 후 **채팅당 1개**만 산다. 2.6.2가 9개(본채팅 1 + 슬롯 6 + 창 2)를
따로 굴리던 것은 자리마다 상태를 들고 있었기 때문. 규약 보존:
- `holdKey` = chatId (2.6.2 본채팅은 activeChatId, 그 외는 고정값 — `useLimitResume.ts:26`)
- busy 상승 에지 자동 해제(`:109-116`), prev-busy 장전 가드(`:50-57`), 발화 재검증(`:118-145`)
- **LimitHoldBar가 카운트다운 틱을 소유**(`:169-171`) — 호스트 재렌더가 memo를 못 뚫는 함정
- 재시작 복원은 2.6.2가 활성 채팅 것만 되살렸다(`App.tsx:506-515`). 통합 후에는 **열려
  있는 자리의 채팅 전부**로 넓힐 수 있다(대기표가 채팅 파일에 붙으므로 ui-prefs 단일 슬롯
  제약이 사라진다). → 열린 문제 ⑤

**btw 포크.** `tryBtw`(`App.tsx:962-979`) / `tryBtwPanel`(`MultiAgent.tsx:1336-1358`)이
같은 함수가 된다: `origin = chatId`, `originTitle = chat.title`, 상속물 = `chat.identity`.
알약 도크는 `btwOf === 내 chatId`로 거른다(2.6.2 `App.tsx:1380` / `MultiAgent.tsx:1320-1333`
와 같은 규칙, 슬롯 역산 `slotOfPanelId`가 사라져 단순해진다). **own 세션이 생기면 재포크
금지** 규약 유지(`sessionChats.ts:38-42`), `btwPrompt`는 읽으면 소비(`:41-42`).

**토스트.** `NotifyTarget`(`protocol.ts:810-811`)의 `surface: 'single'|'multi'|'session'`이
`{ chatId }` 하나로 접힌다. 라우팅(`App.tsx:718-726`)은 "그 채팅이 보이는 자리로 점프"
= (a) 보드 slots에 있으면 그 자리로 + 접혀 있으면 1번 자리로 올림, (b) 창이면 창 포커스,
(c) 어디에도 없으면 1번 자리에 얹는다. 감시는 `useTurnNotifyList`(`notify.ts:31`) 하나가
"열린 채팅 전부"를 본다.

**계정 오버라이드 / picker.** `Chat.identity`에 붙으므로 자리와 무관하게 따라간다.
2.6.2의 3벌(§0 표)이 1벌. 계정별 `CLAUDE_CONFIG_DIR` 물질화·projects 정션 공유 규약은
그대로(M-LOGIC/M5 소관).

**워크바.** 백그라운드 셸 칩·워크플로·서브에이전트 전부 `ChatSurface` 안. `chat:bg-task`
하나가 `claude:bg-task`/`ma:bg-task`/`session:bg-task`(3채널)를 대체.

**완료 표시.** `effectiveStatus/bgActive` 단일 소스 규칙 유지 — 이제 소스가 `Chat`이라
자리·사이드바·접힘 배지·토스트가 같은 값을 읽는다. 2.6.2는 사이드바 점(멀티는
`aggregateStatus`, `MultiAgent.tsx:240-246`)과 패널 링이 다른 경로로 계산됐다.

### 3.3 추가 채팅 창은 이 모델에서 무엇인가

**답: 자리를 창으로 뺀 것이다. 팝아웃 창과 같은 것이다.**

2.6.2는 둘이 우연히 갈라진 두 구현이다:

| | 추가 채팅 창(`#session`) | 패널 팝아웃 창(`#mapanel`) |
|---|---|---|
| 엔진 | 창 전용(`sessionEngines`, wcId 키, `index.ts:410-434`) | 메인의 패널 풀(`maEngines`) 미러(`index.ts:660-663`) |
| 이벤트 | `session:event` → 그 창만 | `ma:event` → 메인 + 창 팬아웃 |
| 영속 | `session-chats/`(`sessionChats.ts`) | 없음 — 메인 창 그리드로 되돌려 저장(`index.ts:722-732`) |
| 닫기 | flush 후 destroy, 대화는 목록에 남음(`index.ts:494-515`) | flush가 그리드로 복귀 |
| 폴더 | 창이 독립 선택 | 패널 것 상속 |

통합 후 **하나**: `WindowSlot { label, chatId }`.
- 엔진은 언제나 chatId 소유(창은 뷰). → `sessionEngines` 맵이 사라진다.
- 이벤트는 `chat:event`를 chatId→창 레지스트리로 팬아웃. → 2.6.2 팝아웃 미러 규약이
  일반 규칙이 된다(`ARCHITECTURE-3.0.md` 창 시스템 절과 일치).
- 영속은 `chats/<id>.json` 하나. → `session-chats/` 스토어가 사라진다.
- `Ctrl+Shift+N` = "새 채팅을 창 자리에서 열기". 팝아웃 = "그리드 자리의 채팅을 창 자리로
  이동". btw = "포크한 채팅을 창 자리에서 열기". **세 동작이 같은 명령의 인자 차이**다.
- 창 닫기 = 자리 소멸. 대화는 풀에 남는다. 그리드 복귀 여부는 → 열린 문제 ④.
- 살아남는 규약: 독립 OS 창(네이티브 리사이즈·스냅 유지, `titleBarStyle:hidden` 계열 —
  Tauri 대응은 M1 소관), 창별 아크릴 유지(`index.ts:521-528 keepAcrylicWhenBlurred`),
  닫기 전 flush 요청 + 1.5s 타임아웃(`index.ts:509-515`), 창이 다시 보이면 정리 취소(`:506`).

---

## 4. 저장 스키마

### 4.1 파일 배치

```
~/.agentcodegui/
  chats/
    index.json            { version: 3, order: [chatId…], activeChatId, migratedFrom?: "2.6.2" }
    <chatId>.json         { id, title, custom, locked, color, identity, draft, draftImages,
                            queue?, hold?, btwOf?, btwSeed?, btwPrompt?, updatedAt, snapshot }
  boards/
    index.json            { version: 1, order: [boardId…], activeBoardId }
    <boardId>.json        { id, title, custom, count, chrome, order, slots, updatedAt }
  backup-2.6.2-<stamp>/   마이그레이션 전 원본 통째 복사 (chats/ · multi-agent/ · session-chats/ · chat-talk.json)
```

- **팬아웃 구조는 2.6.2와 동일**: 항목별 파일 + `index.json`(버전·순서·활성) + 내용
  문자열 비교로 바뀐 파일만 쓰기 + 목록에서 사라진 파일 prune. `chats.ts:116-162` /
  `chats.rs:175-218`을 그대로 재사용한다 — `boards/`는 `chats/`의 복제.
- **원자 저장**: `writeFileAtomic` / `ccg_store::write_atomic`(`lib.rs:60-70`) 그대로.
- **unloaded 마커**: 규약 한 글자도 바꾸지 않는다. 렌더러가 스냅샷 없는 메타만 되보내면
  스토어가 디스크의 스냅샷을 되끼워 저장(`chats.ts:22-35`, `chats.rs:151-172`).
  **이걸 깨면 대화가 통째로 증발한다** — `chats.rs:1-12`가 그 경고를 이미 달고 있다.
- **부팅 light 조회**: 2.6.2는 활성 채팅 1개만 스냅샷을 실었다(`chats.ts:50-80`,
  `chats.rs:87-112`). 통합 후 기준이 바뀐다 — **"활성 보드의 보이는 자리(count개) +
  열린 창의 채팅"만 스냅샷**, 나머지는 `unloaded: true`. 최대 6~8개. 접힌 자리·비활성
  보드는 마커. 상태 배지용 요약은 `maStore.ts:94`의 `panelStatuses` 패턴을 채팅 단위로
  일반화(`status` 필드만 마커에 실어 보냄).
- **지연 로드**: 자리에 얹히는 순간 `chats:load`로 되읽는다(`App.tsx:746-771 restore`,
  `MultiAgent.tsx:2124-2147 activate`의 seq 가드 규약 — 연타 시 마지막 요청만 이긴다).
- **버전**: `chats/index.json.version` 1→3으로 올린다(2는 `MULTI_VERSION`이 쓰던 값이라
  건너뛴다, `MultiAgent.tsx:110`). 버전이 3이면 마이그레이션 완료 표식.

### 4.2 3스토어 → 통합 마이그레이션 매핑

| 2.6.2 | 3.0 통합 | 비고 |
|---|---|---|
| `chats/<id>.json` | `chats/<id>.json` (id 유지) | `manualCwd`→`identity.cwd`, `refDirs`→`identity.addDirs`, `picker.*`→`identity.*`. 스냅샷·초안·updatedAt 그대로 |
| `chats/index.json.order` | `chats/index.json.order` 앞부분 | 순서 보존 |
| `chats/index.json.activeChatId` | 기본 보드 `slots[0]` + `activeChatId` | |
| `multi-agent/<sid>.json.panels[i]` | `chats/ma-<sid>-<i>.json` (새 id, 결정론적) | title/custom/locked/color/cwd/refDirs/picker/api/snapshot 그대로. 내용 없는 패널(제목·스냅샷 없음)은 생성하지 않고 `slots[i]=null` |
| `multi-agent/<sid>.json` | `boards/<sid>.json` | `count`·`panelOrder`→`order`·`title`·`custom`·`updatedAt` 그대로, `slots[i]=ma-<sid>-<i>\|null`, `chrome='grid'` |
| `multi-agent/index.json.activeSessionId` | `boards/index.json.activeBoardId` | |
| `session-chats/<id>.json` | `chats/<id>.json` (충돌 시 `sc-<id>`) | `snapshot`·`cwd`·`refDirs`·`picker`·`btwOf`·`btwSeed`·`btwPrompt`·`custom` 보존. `status`는 저장 시 idle/done/error로 얼려 오는 규약 유지(`sessionChats.ts:29`) |
| 추가 채팅의 창 배정 | 없음 (창 자동 복원 안 함) | 2.6.2도 재시작 때 창을 되열지 않는다 — 목록에만 남는다(`sessionChats.ts:7-9`) |
| `chat-talk.json` | 남아 있으면 `chats/`로 1회 편입 후 비움 | 2.6.2가 이미 하던 것(`App.tsx:528-594`). 3.0은 같은 규칙을 마이그레이터에 옮긴다 |
| — | 기본 보드 `boards/default.json` | `count = ui-prefs의 workspace.mode==='multi' ? 마지막 세션 count : 1`, `slots[0] = 이전 activeChatId` |

**id 충돌.** `chats/`와 `session-chats/`는 둘 다 `randomUUID`라 충돌 확률은 무시할 수
있지만 마이그레이터는 **검사하고 접두사를 붙인다**(`sc-`). `btwOf`가 가리키는 원본 id도
같은 매핑표로 다시 쓴다 — 안 하면 알약이 고아가 된다. 멀티 패널은 무조건 새 id
(`ma-<sid>-<i>`, 결정론적이라 재실행해도 같은 id → 멱등).

**롤백.** 마이그레이션 전 `backup-2.6.2-<stamp>/`에 원본 3디렉터리 + `chat-talk.json`을
통째 복사한다. 3.0이 마이그레이션하면 2.6.2로 되돌아갈 수 없으므로(2.6.2는 `boards/`를
모른다) 이 백업이 유일한 되돌리기다.

---

## 5. 마이그레이션 무손실 검증 (PoC 설계 — 구현은 다음 라운드)

파일: `scripts/poc-chat-unify-migrate.mjs` (2.6.2 PoC 하네스 규약과 같은 자리)

### 5.1 안전 규칙 (사용자 실홈 보호)

- 스크립트는 **`--home <경로>` 필수**. 인자 없이 돌면 즉시 종료.
- `--home`이 `os.homedir()/.agentcodegui`(정규화 비교)이면 **거부하고 종료**. 실홈을
  대상으로 삼을 방법이 없다.
- 실홈을 쓰려면 `--clone-from-real` 전용 모드 — 이 모드는 실홈을 **읽기만** 하고
  `%TEMP%/ccg-unify-poc-<stamp>/`로 복사한 뒤 그 복사본을 대상으로 돈다. 원본에는
  파일 핸들을 쓰기 모드로 열지 않는다(복사는 `fs.cp` 읽기 스트림).
- 마이그레이터 실행 시 `CCG_HOME=<대상>`을 강제로 세팅한다(3.0은 릴리즈에서도 존중 —
  `ccg-store/src/lib.rs:36-46`).
- 리포트는 `docs/design/poc-out/chat-unify-<stamp>.json`. 대화 본문은 리포트에 싣지
  않는다(해시만) — 사용자 대화가 레포에 커밋되지 않게.

### 5.2 인벤토리 (before / after 동일하게 수집)

`before`는 2.6.2 3스토어를, `after`는 통합 스토어를 읽어 **같은 모양의 정규화 인벤토리**로
만든다. 대조는 정규화된 값끼리.

| 항목 | before 계산 | after 계산 | 판정 |
|---|---|---|---|
| 채팅 수 | `chats.length + Σ(세션별 내용 있는 패널 수) + sessionChats.length` | `chats.length` | 동일 |
| 메시지 총수 | 위 각 스냅샷의 `messages.length` 합 | 합 | 동일 |
| 채팅별 메시지 수 | `{키: n}` 맵 (키 = 매핑표의 새 id) | `{id: n}` | 맵 동일 |
| 마지막 메시지 해시 | `sha256(canon(messages.at(-1)))` | 동일 | 집합·맵 동일 |
| 스레드 전체 해시 | `sha256(canon(messages))` | 동일 | 맵 동일 (순서까지 검증) |
| 세션 id(resume) | `snapshot.session.id` | 동일 | 맵 동일 — **깨지면 이어하기가 죽는다** |
| cwd / picker | `{cwd, refDirs[], model, effort, mode, engine, account, codexAccount, api}` | `identity` 사영 | 맵 동일 |
| 제목·잠금·색 | `{title, custom, locked, color}` | 동일 | 맵 동일 |
| 초안 | `{draft, draftImages[]}` | 동일 | 맵 동일 |
| updatedAt | 값 | 값 | 동일 |
| 보드 | 세션별 `{count, panelOrder, 패널i→chatId}` | `boards/<id>` | 매핑 동일 |
| 활성 선택 | `activeChatId`, `activeSessionId` | `activeChatId`, `activeBoardId` | 대응 |
| btw 그래프 | `{child: btwOf}` (원본 id) | 새 id 공간 | **고아 0건** + 간선 수 동일 |
| 파일 수 | `chats/*.json` + `multi-agent/*.json` + `session-chats/*.json` | `chats/*.json` + `boards/*.json` | 기대값 계산과 일치 |

`canon()` = 키 정렬 + undefined 제거 + 숫자 정규화 JSON. 스냅샷에 타임스탬프성 필드가
있으면 화이트리스트로 제외하고, 제외 목록을 리포트에 명시한다(숨은 손실 방지).

### 5.3 추가로 반드시 도는 검사

1. **왕복 안정성** — 마이그레이션 후 스토어를 읽어 렌더러 블롭으로 재조립 → 다시 저장 →
   인벤토리 재수집. 1회차와 동일해야 한다. (2.6.2가 `poc-chats-merge.mjs`에서 잡던
   "병합이 대화를 지우는" 사고를 통합 포맷에서 재현 방지)
2. **unloaded 병합** — 전 채팅을 마커로 만들어 저장 → 스냅샷이 전부 살아 있는지.
   이게 3.0에서 대화 증발이 나올 유일한 자리다(`chats.rs:1-12`).
3. **멱등성** — 마이그레이터 2회 실행 후 채팅 수·id 집합 불변(`version:3` 표식 + 결정론 id).
4. **크래시 내성** — 마이그레이션을 임시 디렉터리에 완성한 뒤 마지막에 rename. 중간
   프로세스 kill 후 원본이 온전한지(백업 없이도).
5. **light 조회 등가** — `read_chats(light=true)`가 보이는 자리 + 열린 창의 채팅만
   스냅샷을 싣고 나머지는 마커인지, 그리고 마커를 되보내 저장해도 손실 0인지.
6. **부하 픽스처** — 채팅 200개 / 멀티 세션 20개(각 6패널) / 추가 채팅 30개 합성 홈으로
   마이그레이션 시간·피크 메모리 측정(수치를 리포트에).

판정: 항목 하나라도 어긋나면 **비영 종료코드 + 어긋난 키 목록**. 통과 없이는 통합 스토어
코드를 머지하지 않는다.

---

## 6. IPC 통합

### 6.1 새 채널 면 (`chat:*` / `board:*`)

명령 — 전부 `chatId`를 받는다.

```
chat:run          { chatId, prompt, images?, identityPatch? }        → { runId }
chat:interrupt    { chatId }                       소프트 중단 (턴만; 상주 유지)
chat:cancel       { chatId }                       프로세스째 (/clear·폴더 전환·계정 전환 전용)
chat:permission   { chatId, toolUseId, behavior }  'allow'|'allow_always'|'deny'
chat:answer       { chatId, answers: string[][] }
chat:bg-task      { chatId, action, id? }
chat:dispose      { chatId }                       엔진 회수 (채팅 삭제·유휴 스윕)
chat:owner        { chatId, owner }                구동 권한 이전 (창 열기/닫기)

  ↓ 정체성 계열은 M-LOGIC이 이미 이름을 잡았다 (docs/design/m-logic.md:553-566) — 그대로 쓴다
chat:identity-get     (ChatRef) → ChatIdentityState
chat:identity-set     (IdentitySetCmd) → IdentityVerdict     applied / deferred / needs_confirm / rejected
chat:identity-revert  (ChatRef, revision) → IdentityVerdict
chat:force-settle     (ChatRef, liveItemId) → CommandVerdict

chats:get         { light?: boolean }              → { version, chats, activeChatId }
chats:load        { chatId }                       → 채팅 파일 (지연 로드)
chats:save        { version, chats, activeChatId } → void (팬아웃 저장)

board:get         {}                               → { version, boards, activeBoardId }
board:load        { boardId }
board:save        { version, boards, activeBoardId }

win:chat-open     { chatId?, from?: 'grid'|'new'|'btw' }   창 자리 열기 (추가채팅+팝아웃+btw 통합)
win:chat-close    { chatId }
win:chat-focus    { chatId }
win:chat-list     {}                               → WindowSlotInfo[]  (열린 창 목록)
```

이벤트 — 봉투 하나.

```
chat:event        { chatId, event: EngineEvent }   메인 + 그 채팅을 보는 창들로 팬아웃
chat:windows      WindowSlotInfo[]                 REPLACE 목록 (2.6.2 session-wins:changed)
chat:flush-req    { chatId }                       창 닫기 전 마지막 저장 요청
```

**명령 18 + 이벤트 3 = 21채널**. 2.6.2의 55채널(§0)을 대체한다.

`ma:event`가 이미 `{ panelId, event }` 봉투다(`protocol.ts:1133`) — `chat:event`는 그
일반화다. 창 라우팅은 WindowRegistry의 `chatId → [창 라벨]` 역인덱스로 `emit_to`
(`ARCHITECTURE-3.0.md` 창 시스템 절의 팬아웃 규칙 그대로).

### 6.2 과도기 호환 전략

`ARCHITECTURE-3.0.md` 결정 3은 "protocol.ts의 채널 이름·페이로드·의미를 보존한다"이다.
M1 빌더가 지금 이식 중인 렌더러는 **2.6.2 그대로**라 옛 채널을 부른다. 그래서:

- Rust 디스패처 레지스트리에 **별칭 어댑터**를 둔다. 핸들러는 `chat:*` 하나, 어댑터는
  옛 채널명 → 새 페이로드 변환 함수:
  - `claude:run` → `chat:run { chatId: 기본 보드 slots[0] }`
  - `ma:run { panelId }` → `chat:run { chatId: panelIdToChat(panelId) }`
    (`panelIdToChat`은 마이그레이션 매핑표 `ma-<sid>-<i>`를 그대로 쓴다)
  - `session:run` (창) → `chat:run { chatId: 그 창의 chatId }`
  - `talk:*` → 마이그레이션에서 이미 흡수됨. `talk:get`은 빈 블롭, `talk:save`는 no-op.
  - `ma:get/save/load-session` → `board:*` + `chats:*` 조합으로 옛 블롭 모양 재조립
  - `ma:panel-*` → `win:chat-*` (leftover/persist는 no-op으로 응답 — 상태가 스토어에 있어
    돌려줄 게 없다. 옛 렌더러는 빈 leftover를 무해하게 무시한다, `MultiAgent.tsx:1259-1268`)
- 이벤트는 역방향: `chat:event`를 옛 렌더러가 구독한 `engine:event`/`ma:event`/
  `session:event`로도 함께 내보낸다(창 종류로 어느 이름을 쓸지 결정).
- 별칭 계층은 **통합 UI가 완성되는 라운드에 통째로 삭제**한다. 삭제 시점의 회귀 판정은
  "옛 채널 참조 0건"(grep) + 화면 인벤토리 재주행.

이 전략의 이득: **M-UX가 M1을 막지 않는다.** 스토어·IPC를 먼저 통합해도 이식 중인 렌더러가
계속 돈다.

---

## 7. 다른 조각이 얹힐 자리

**M9 (멀티 기준 MCP/Skill 전용 뷰).**
2.6.2의 MCP/Skill on/off는 앱 전역이다(`mcp:set-enabled`/`skill:set-enabled`, 앱 홈에 영속 —
`protocol.ts:1050-1053`). 통합 모델에서 자연스러운 층은 **채팅**(picker와 같은 층)이다.
지금 스키마에 자리만 예약한다: `Chat.identity.mcpOverrides?: Record<string,boolean>`,
`Chat.identity.skillOverrides?`. 전용 뷰는 `Board.chrome`의 값 추가(`'mcp' | 'skill'`)로
붙는다 — 자리 배치는 그대로 두고 각 자리에 다른 콘텐츠를 그리는 모드. 이 확장점이
`chrome` 필드를 지금 넣는 유일한 이유다.

**M11 (한도 소진 시 계정 자동 전환).**
`useLimitResume`은 이미 `account`를 들고 재검증한다(`useLimitResume.ts:24,92-102,127-134`).
통합 후 대기표가 채팅에 붙으므로, "이 채팅의 계정을 초기화 임박순 다음 계정으로 바꾸고
재개"는 `chat:identity { patch: { account } }` + 기존 ready 소진 경로로 표현된다. 훅이
1벌이면 전환 로직도 1벌 — 2.6.2였다면 9곳에 배선해야 했다.

**M-LOGIC (RunIdentity).**
이 스펙은 두 가정만 공유한다: **패널 = 뷰**, **실행 상태는 채팅에 붙는다.**
`Chat.identity: RunIdentity`의 내용(필드 목록·비교 규칙·상태기계·변경 명령의 즉시/턴후/거부
판정)은 전부 `docs/design/m-logic.md` 소관이다. 이 문서는 필드 이름과 그것이 채팅에
붙는다는 사실만 예약한다. 경계:

| 이 문서(M-UX) | m-logic.md(M-LOGIC) |
|---|---|
| 채팅/자리/보드의 관계, 다이얼, 저장 포맷, IPC 채널 면 | RunIdentity 내용, 상태기계 전이표, 재사용/재스폰 판정 |
| `chat:identity-*` 채널이 존재한다는 것 | 그 명령의 응답 4종(applied/deferred/needs_confirm/rejected)과 판정 규칙 |
| `Chat.owner`로 구동 권한이 표현된다는 것 | 고아 회수 타이밍, busy 중 명령 허용 여부 |

**두 문서가 실제로 합의한 것 / 아직 어긋나는 것 (2026-08-22 시점, m-logic.md 읽고 대조)**

합의:
- `ChatRuntime`이 채팅 1개당 1개, 앱 수명 동안 지속(`m-logic.md:352-360`) = 이 문서의
  "엔진은 chatId가 소유한다"(불변식 3).
- 큐·한도 대기표(`hold`)가 `ChatRuntime`에 붙는다(`:357-358`) = 이 문서의
  `Chat.queue` / `Chat.hold`. 팝아웃 소유권 이전이 사본이 아니라 `owner` 한 필드가 되는 근거.
- "패널/사이드바는 뷰다. 뷰를 옮겨도 실행은 계속된다"(`:501`, `:763`) = 불변식 1·4.
  2.6.2의 busy 게이트(`App.tsx:774,799,811`)를 걷는 근거도 여기서 나온다 → 열린 문제 ⑥.

**어긋나는 것 — 하나 정해야 한다:**
m-logic은 주소를 `ChatRef { surface: 'single'|'multi'|'session'; id }`로 잡았다(`:566`).
이 문서는 `chatId` 문자열 하나로 접는다(§1.2). `surface`가 남으면 3표면 분기가 타입에
살아남아 M-UX가 없애려는 바로 그 파리티 버그 자리가 유지된다. 제안:
**`ChatRef`는 과도기 어댑터 전용으로 두고 코어 API는 `chatId`**로 간다 —
`ChatRef → chatId` 변환을 별칭 계층(§6.2)에서 한 번만 하고, `ChatRuntime`·상태기계·
스토어는 `chatId`만 안다. (M-LOGIC 작성자와 확정 필요)

---

## 8. 열린 문제 — 사용자에게 물어야 할 결정

1. **사이드바 구조.** 2.6.2는 3섹션(일반/멀티/추가 채팅, `App.tsx:1385-1422`). 통합 후
   후보: (a) 「채팅」 1섹션 평평 + 「배치」 1섹션, (b) 「채팅」 1섹션만 두고 배치는 헤더
   드롭다운, (c) 「채팅」 + 「배치」 + 「창」 3섹션(창은 지금 열려 있는 것만).
   → 목업은 (a)로 그렸다.
2. **6→1 접힘을 얼마나 크게 알릴까.** 다이얼 옆 배지(`1 ⌄5`) + 팝오버로 충분한가, 아니면
   사이드바에 "이 배치에 접힌 대화" 그룹을 따로 띄울까? 배지만으로는 놓칠 수 있고,
   그룹까지 만들면 §8-1의 섹션이 또 늘어난다.
3. **자리 비우기의 의미.** 자리에서 채팅을 빼면 실행은 계속 도는가(백그라운드 유지), 아니면
   자리 이탈 = 소프트 중단인가? 2.6.2 멀티는 계속 돈다(`MultiAgent.tsx:57-58`).
   기본값을 "계속 돈다"로 제안하지만 확인이 필요하다 — 6패널 전부 돌려두고 1로 내리면
   보이지 않는 곳에서 5개가 계속 토큰을 쓴다.
4. **창을 닫으면 그리드로 복귀하는가.** 2.6.2는 팝아웃만 복귀하고(`index.ts:722-732`)
   추가 채팅 창은 목록에만 남는다(`sessionChats.ts:7-9`). 통합하면 둘이 같아져야 하는데
   어느 쪽으로? (a) 항상 그리드 자리로 복귀 — 팝아웃 감각, (b) 항상 목록에만 — 추가 채팅
   감각, (c) 열 때 어디서 왔는지 기억해서 다르게(`from: 'grid' | 'new'`).
5. **한도 대기표 복원 범위.** 2.6.2는 재시작 후 활성 채팅 것만 되살린다(`App.tsx:506-515`
   — "비활성 채팅 표는 전환·로드 조건이 얽혀 위험 대비 이득이 없다"). 통합 후에는
   대기표가 채팅 파일에 붙어 전 채팅 복원이 가능해진다. 6개가 동시에 자동 재개되는 게
   맞나, 아니면 보이는 자리만인가?
6. **1 모드에서 실행 중 채팅 전환 허용?** 2.6.2는 busy·워크플로 상주 중 전환/새 채팅/
   삭제를 조용히 막는다(`App.tsx:774,799,811`) — 사용자가 클릭했는데 아무 일도 안 일어나는
   경험(HANDOFF의 M-LOGIC 지적). 통합 모델에서는 자리가 여러 개라 "실행은 그 자리에서
   계속, 화면은 다른 채팅"이 자연스럽다. 1 모드에서도 전환 허용으로 갈까?
   (M-LOGIC과 공동 결정 — 여기서는 "허용 + 실행 중 배지"를 제안)
7. **보드를 계속 목록으로 남길까.** (a) 2.6.2 멀티 세션처럼 보드 N개를 사이드바에 유지,
   (b) 보드는 현재 하나만 두고 세션 개념 은퇴 — 마이그레이션에서 세션들의 패널이 전부
   평평한 채팅으로 풀리고 배치는 마지막 활성 세션 것만 남는다. (b)는 단순하지만
   "그때 그 조합" 복원 기능이 사라진다.
8. **빈 자리 기본 동작.** 빈 자리에 자동으로 새 채팅을 만들까(2.6.2 빈 패널 = 바로 대화
   가능), 아니면 "새 채팅 / 최근에서 고르기" 타일을 먼저 보여줄까? 후자가 통합 모델에
   충실하지만 클릭이 하나 는다.
9. **다이얼 1에서도 그리드 크롬을 고를 수 있나.** `Board.chrome`을 사용자에게 노출할지.
   (1인데 탐색기 없이 패널 하나만 크게 = 지금의 "크게 보기"와 겹친다)
10. **새 채팅 모달의 운명.** 2.6.2 `NewChatModal`은 1단계 일반/멀티, 2단계 패널 수 2~6
    (`NewChatModal.tsx:7,COUNTS`). 통합 후 "일반/멀티" 구분이 사라지므로 모달은 패널 수
    1~6 한 단계로 줄어든다 — 아니면 모달 자체를 없애고 다이얼만 남길까?

---

## 9. 목업

`docs/design/mockups/` (정적 HTML, 2.6.2 다크·아크릴 톤 토큰 그대로 — `styles.css:7-84`)

| 파일 | 내용 |
|---|---|
| `chat-unify-dial.html` | 다이얼에 1이 추가된 모습 — 1↔6 전 상태, 접힘 배지, 팝오버 |
| `chat-unify-1-ide.html` | 1 모드 = 기존 IDE 레이아웃(사이드바·탐색기 전환·코드 뷰어·Git 스트립·워크바) |
| `chat-unify-grid2.html` | 2 그리드 |
| `chat-unify-grid4.html` | 4 그리드 (패널 스코프 승인 카드 포함) |
| `chat-unify-collapse.html` | 6→1 전환 직후 — 사이드바 상태 + 접힘 배지 + 팝오버 열린 상태 |
| `chat-unify.css` | 5장 공용 스타일 (2.6.2 토큰 사본) |

밀도 기준: 실물급. 사이드바 항목 높이·폰트 크기·워크바 칩 수·컴포저 구성은 2.6.2 값을
따랐다("여백만 넓힌 깔끔함"은 사용자가 기각).
