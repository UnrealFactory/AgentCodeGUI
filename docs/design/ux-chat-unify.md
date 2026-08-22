# M-UX 「채팅 통합」 — 설계 스펙 **R2** (3.0.0)

상태: **스펙 확정 제안 + 목업**. 코드 없음.
R1(2026-08-22) → **R2 개정**: `docs/critic/design-r1.md`의 M-UX 지적 전수 반영.
근거는 전부 얼린 2.6.2 소스(`src/`)에서 확인했고 파일:줄로 남겼다. 추측으로 쓴 문장은 없다.

목업: `docs/design/mockups/chat-unify-*.html` (8장)
동반 문서: **`docs/design/ux-parity-map.md`** — 156화면 전수 사영표(신설, R2의 핵심 산출물)

---

## R2 개정 요약 — 크리틱 R1 대응

| 지적 | 무게 | R2에서 무엇을 했나 | 절 |
|---|---|---|---|
| **U1** 접힌 채팅의 알림·상태가 죽는다(§2.2-4 ↔ §4.1 정면 충돌) | 치명 | **감시자를 렌더러 → Rust로 이동.** 감시 집합 = `ChatRuntime`이 사는 모든 채팅(자리·창·접힘 무관). 마커의 표시값은 스냅샷이 아니라 `ChatStatusLite` 경량 레코드에서 온다. 접힌 자리의 승인/질문 알림 규약 신설 | §2.2-4·§2.2-5·§4.3 |
| **U2** `chat:permission`/`chat:answer`가 매칭 키를 버렸다 | 치명 | `requestId`를 되살리고 `answers: string[][] \| null`(무응답 해제) 복원. `chat:respond-dialog` 추가 | §6.1 |
| **U3** `claude:run → slots[0]` 매핑이 틀렸다 | 높음 | 별칭 계층에 `activeChat()` 함수 + **`chats:set-active` 즉시 채널**. 레이스 시 misroute 대신 verdict 거부 | §6.2 |
| **U4** 앱 크롬을 자리 안으로 밀어 넣었다 | 높음 | **왼쪽 칼럼·코드 뷰어·Git을 앱 크롬으로 되돌렸다**(= 목업이 옳았다). 껍데기 3종은 `ChatSurface`만 담는다 | §3.1 |
| **U5** `Chat.owner`가 M-LOGIC과 충돌 | 높음 | **`owner` 필드 삭제.** 드레인·hold·자동 재개는 Rust 소유(m-logic §7.2/§7.3). 창 배정은 `WindowRegistry`의 `chatId → label` 역인덱스가 유일한 진실 | §2.5 |
| **U6** "한 채팅은 한 자리"의 범위가 없다 | 중 | 불변식을 **"동시에 *보이는* 자리 최대 1개"**로 좁히고 보드 활성화 시 중복 해소 알고리즘을 명시 | §2.6 |
| **U7** IPC 산수가 틀렸다(21이 아니다) | 중 | 다시 셌다 — **명령 24 + 이벤트 8 = 32채널**. m-logic 채널 포함, 블록과 수가 일치 | §6.1 |
| **U8** 다이얼 축소 규칙이 재정렬·정리 로직 의미를 바꾼다 | 중 | 드래그는 **보이는 자리끼리만** 순서를 바꾼다 → 접힘 집합 불변. `focusedSlot`/`renamingSlot` 정리 규칙 재정의 | §2.2-1 |
| **U9** 뷰어發 동작의 대상 채팅 미정 | 중 | `viewerTarget { chatId, path, from }` 신설 + 「대상 채팅 칩」. `chat-find`·`changed-files`·Git의 대상도 한 규약으로 | §3.4 |
| **U10** 전역 pref의 채팅 물질화가 마이그레이션 표에 없다 | 중 | 저장은 **`identityOverrides`(부분)** 만. 미지정 = 전역 상속 → "전역을 꺼도 옛 채팅은 API로 돈다"가 안 생긴다. pref 이관 표 신설 | §4.2 |
| **U11** `version: 3`은 다운그레이드 가드가 아니다 | 낮음 | 통합 스토어를 **`chats-v3/`** 새 디렉터리로. 2.6.2 디렉터리는 읽고 **남긴다** | §4.1 |
| **U12** 빈 채팅 규칙 일반화가 반쪽 | 낮음 | light 조회의 「빈 스냅샷 채팅은 통째로 유지」 예외 보존. 빈 채팅은 "자리당 1개"가 아니라 **자리에 배정된 것만 존재** | §2.4·§4.3 |
| 인용 오류 #3·4·5·7·8·9·10 | — | 전부 수정(§R2-끝 인덱스에 대조표) | §10 |
| 목업 미흡 5건 | — | 창 컨트롤 추가·주석 위치 이동·창/접힘알림/사이드바 3안 목업 3장 신설 | §9 |
| **`ChatRef` vs `chatId`** | 판정 | **리드 확정: `chatId` 문자열 하나. `ChatRef` 타입은 삭제.** 근거 3개를 §1.3에 인용 | §1.3 |

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

**이중 배선 실측 — R1 표를 다시 셌다.** R1은 7종을 셌지만 *자기가 아는 것만* 센 목록이었다.
전 렌더 지점을 grep으로 세니 **여덟 갈래가 더** 있었다(★ 표시).

| 기능 | 렌더 지점 | 위치 |
|---|---|---|
| 승인/질문 카드 | 4 | `App.tsx:1674,1676` · `MultiAgent.tsx:752,757` · `SessionWindow.tsx:863,865` · `PanelWindow`(PanelView 재사용) |
| ★ **코드 뷰어** | **4** | `App.tsx:1640` · `SessionWindow.tsx:879` · `PanelWindow.tsx:528` · `MultiAgent.tsx:1918` |
| ★ **서브에이전트 카드** | **4** | `App.tsx:1663` · `MultiAgent.tsx:1928` · `SessionWindow.tsx:888` · `PanelWindow.tsx:531` |
| ★ **이미지 라이트박스** | **4** | `App.tsx:1655` · `MultiAgent.tsx:1934` · `SessionWindow.tsx:891` · `PanelWindow.tsx:533` |
| ★ **폴더 변경 확인 카드** | **4** | `App.tsx:1679` · `MultiAgent.tsx:1906` · `SessionWindow.tsx:868` · `PanelWindow.tsx:524` |
| ★ **워크바 / 컴포저** | 각 3 | `App.tsx:1548,1578` · `MultiAgent.tsx:687,712` · `SessionWindow.tsx:807,832` |
| ★ **워크플로 도크** | 3 (4 표면) | `App.tsx:1671` · `MultiAgent.tsx:751` · `SessionWindow.tsx:864` |
| ★ **한도 배너 / btw 도크** | 3 / 2 | `App.tsx:1573,1667` · `MultiAgent.tsx:711,750` · `SessionWindow.tsx:831` |
| ★ **탐색기** | 2 렌더 + mode 삼항 | `App.tsx:1438`(single) · `:1452`(multi `multiExp`) |
| 한도 자동 이어서 훅 | 9 인스턴스 / 4 표면 | `App.tsx:492` · `MultiAgent.tsx:1629-1634`(슬롯당 1개×6) · `SessionWindow.tsx:648` · `PanelWindow.tsx:289` |
| btw 포크 | 2 (4 표면) | `App.tsx:962`(tryBtw) · `MultiAgent.tsx:1336`(tryBtwPanel) |
| 토스트 알림 | 3 surface enum | `protocol.ts:811` `'single' \| 'multi' \| 'session'`, 라우팅 `App.tsx:718-726` |
| 계정/모델 picker | 3 소유처 | `App.tsx:157`(useState) · `MultiAgent.tsx:113-125`(`PanelMeta.picker`) · `sessionChats.ts:32`(레코드 필드) |
| 대화 스토어 | 4 | `chats/` · `multi-agent/` · `session-chats/` · `chat-talk.json` |
| 엔진 IPC | 4세트 | `claude:*` · `ma:*` · `session:*` · `talk:*` (`protocol.ts:942-1006`) |

IPC 실측 수(`protocol.ts:942-1006`, `1130-1138`): 명령 48 + 대화 관련 이벤트 7 = **55채널**이
대화 하나를 굴리는 데 쓰인다. (claude 6 / ma 17 / talk 7 / session 6 / session-wins 7 /
`win:open-session` 1 / `btw:open` 1 / chats 3 = 48 · 이벤트 7 = `engine:event`·`ma:event`·
`ma:panel-closed`·`talk:event`·`session:event`·`session-wins:changed`·`session-wins:flush-request`)

> **어디로 가는지 세는 대장**: 위 표는 "몇 번 구현됐나"를 센다. "어디로 가나"는
> `docs/design/ux-parity-map.md`가 156화면 전수로 센다. 두 표가 같은 답을 줘야 한다.

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
- 단점 ③: 슬롯 번호가 곧 엔진 채널(`chan()` = `${sessionId}::${slot}`, `MultiAgent.tsx:236`)
  이라 자리와 정체성이 붙어 있다. M-LOGIC의 "실행 상태는 채팅에 붙는다"와 정면 충돌.

#### 후보 B — 「평평한 채팅 풀 + 자리(뷰)」 (배치는 휘발)

- 장점: 6→1 답이 자명하다 — 대화는 애초에 자리에 속한 적이 없다.
- 단점: 2.6.2 멀티 세션 목록(`useMultiSessions`, `MultiAgent.tsx:1949`)이 갈 곳이 없다.
  "그때 그 4개 조합"을 되부르는 기능이 사라진다 — **기능 손실**(3.0의 금지 사항).

#### 후보 C — 「채팅 풀 + 자리 + 보드」 ★ **추천**

```
Chat   (대화)   = 스레드 + 정체성 override + 초안/큐 + 실행 상태.   ← 유일한 진실
Slot   (자리)   = 화면에서 채팅 하나를 보는 칸. chatId를 가리킬 뿐 소유하지 않는다.
Board  (배치)   = 자리들의 구성 { count 1~6, order, slots[6] }. 2.6.2 멀티 세션의 후신.
```

- 다이얼 N = **활성 보드의 count** = 동시에 보는 자리 수.
- 6→1 답: 자리만 접힌다. 대화는 풀에 그대로 있고(사이드바 「채팅」), 보드는 접힌 자리의
  배정을 **기억**하므로 다이얼을 되올리면 같은 자리로 복귀한다. (§2.2)
- 멀티 세션 목록 = 보드 목록으로 1:1 이관 → 기능 손실 없음.
- 엔진 채널이 `chatId`가 되므로 자리 번호·다이얼 값과 완전히 분리된다 → M-LOGIC 전제와 일치.

**추천: 후보 C.** 이유 셋:
1. 6→1 요구에 데이터 모델 자체가 답한다(자리와 대화의 분리).
2. 표면 통합(§3)이 "채팅 하나를 그리는 컴포넌트 1개 + 자리 껍데기 3종 + 앱 크롬 1벌"로 떨어진다.
3. 2.6.2 멀티 세션·추가 채팅·일반 채팅이 전부 이 모델의 특수 케이스 — 마이그레이션이
   **의미 손실 없는 사영**이다(§5.2).

### 1.2 타입 스케치

```ts
// 대화 — 유일한 진실. 실행 상태·초안·큐·정체성 override가 전부 여기에 붙는다.
interface Chat {
  id: string                       // ★ 주소는 이 문자열 하나뿐이다 (§1.3)
  title: string; custom: boolean
  locked: boolean; color: string   // ※ 신규 필드 (일반 채팅 ChatMeta엔 없다 — App.tsx:57-73).
                                   //   멀티 패널만 갖고 있었다(PanelMeta:113-125) → 기본값 주입 필요
  identityOverrides: Partial<RunIdentity>   // ★ 부분 지정. 미지정 필드는 전역 pref 상속 (§4.2 U10)
                                   //   picker(3벌)·manualCwd·refDirs·api를 흡수
  draft: string; draftImages: string[]
  queue: ScheduledMsg[]            // 2.6.2는 본채팅만 App state(App.tsx:165), 패널은 PanelMeta.queue
  snapshot: SessionState           // 스레드 + session(resume id) + files + workflows
  hold?: LimitHold                 // 한도 대기표 — 2.6.2는 훅 인스턴스마다 흩어져 있다
  btwOf?: string; btwSeed?: {fork:string;cwd:string}; btwPrompt?: string   // sessionChats.ts:43-45
  empty?: boolean                  // 메시지 0 — 디스크 skip 판정 (sessionChats.ts:34·:104)
  lastSeenAt?: number              // 읽지 않음 계산용 (신규 — 열린 문제 ⑪)
  updatedAt?: number
  unloaded?: boolean               // 스냅샷이 메모리에 없음 (chats.ts:22-35 규약 그대로)
}

// ※ Chat.owner는 R2에서 삭제됐다 — U5. 구동은 Rust ChatRuntime, 창 배정은 WindowRegistry (§2.5)

// 자리 — 채팅을 보는 칸. 대화를 소유하지 않는다.
type Slot =
  | { kind: 'grid';   index: 0..5; chatId: string | null }   // 보드의 칸
  | { kind: 'window'; label: string; chatId: string }        // 별도 OS 창 (추가 채팅 + 팝아웃 통합)

// 배치 — 2.6.2 PersistedSession(MultiAgent.tsx:139-158)의 후신
interface Board {
  id: string; title: string; custom: boolean
  count: 1 | 2 | 3 | 4 | 5 | 6        // 다이얼. 2.6.2 clampCount는 하한 2(MultiAgent.tsx:216-219)
  chrome: 'ide' | 'grid'              // count=1의 기본은 'ide'. 확장점(M9 전용 뷰)
  order: number[]                     // 자리 순열 — 2.6.2 panelOrder(MultiAgent.tsx:884-886).
                                      // 앞 count개가 보이는 자리. 접힘 집합 = order.slice(count)
  slots: (string | null)[]            // 길이 6. 인덱스=슬롯 정체성, 값=chatId (null=빈 자리)
  updatedAt?: number
}

// 마커 채팅도 항상 갖는 경량 상태 — 스냅샷이 아니다 (§4.3, U1의 답)
interface ChatStatusLite { /* §4.3 */ }
```

**핵심 불변식 5개**
1. **대화는 어느 자리에도 속하지 않는다.** 자리가 대화를 가리킨다. 역참조는 파생값이다.
2. **한 채팅은 동시에 최대 한 *보이는* 자리에서 보인다.** (범위는 §2.6에서 정확히 정의 — U6)
   같은 스레드에 두 컴포저가 붙으면 초안·큐가 갈라진다(2.6.2가 팝아웃에서 소유권 이전으로
   막던 문제, `MultiAgent.tsx:1274-1309`).
3. **엔진은 chatId가 소유한다.** 자리 이동·다이얼 변경·팝아웃으로 엔진이 재스폰되지 않는다.
4. **자리에서 사라져도 실행은 계속된다.** 2.6.2 멀티가 이미 그렇다("a session's runs keep
   going in the background after you switch away", `MultiAgent.tsx:57-58`).
5. **★ 실행 상태의 감시는 자리와 무관하다.** 감시 집합 = `ChatRuntime`이 사는 모든 채팅.
   접힘·자리 이탈·창 닫힘은 **표시 상태의 변화일 뿐 감시 대상의 변화가 아니다.** (§2.2-4)

### 1.3 주소는 `chatId` 문자열 하나 — `ChatRef` 타입은 삭제한다 (리드 확정)

크리틱 R1 §4의 판정을 그대로 채택한다. 근거 셋, 전부 코드 대조:

1. **surface는 주소가 아니라 스토어 선택자였다.**
   2.6.2에서 surface가 하는 일은 "어느 스토어/어느 IPC 세트를 쓸까"다 —
   `single`→`chats/`(`chats.ts`), `multi`→`${sessionId}::${slot}`(`MultiAgent.tsx:236`)+`maStore.ts`,
   `session`→`session-chats/`(`sessionChats.ts`). §4.1이 스토어를 하나로 접는 순간
   surface가 실어 나르는 정보량은 **0비트**가 된다.
2. **m-logic 자신이 surface를 한 번도 쓰지 않는다.**
   `ChatRef`가 등장하는 곳은 `IdentitySetCmd.ref`·`ChatIdentityEvent.ref`·`ChatRunStateEvent.ref`
   필드뿐이고, m-logic §3.3의 31전이·§3.6의 판정표·§5의 원장 규칙·§7의 큐/hold 규칙
   **어디에도 `surface` 분기가 없다**(언급 0회). 쓰지 않는 축을 타입에 남기면 3표면 분기가
   API 시그니처로 영구화된다 — M-UX가 없애려는 바로 그 자리.
3. **남기면 같은 채팅이 두 주소를 갖는다.**
   팝아웃/창 이동으로 표면이 바뀌면 같은 `ChatRuntime`이 `{multi,X}` → `{session,X}`로 주소가
   변한다. 브로드캐스트 구독자(창들)가 ref로 매칭하면 **이동 순간 이벤트를 놓친다.**
   2.6.2 토스트가 정확히 이 형태의 키를 쓴다: 감시 키 = `` `${surface}:${id}${sub}` ``
   (`notify.ts:38`), 그래서 멀티 패널은 `sub`로 슬롯을 덧붙여야 했다(`MultiAgent.tsx:896`).

**지시(확정)**:
- `ChatRef`를 `chatId: string`으로 치환한다. m-logic §4.3의 4개 채널(`chat:identity-get/set/
  revert`·`chat:force-settle`)과 §5.6 브로드캐스트의 `ref` 필드를 `chatId`로 바꾼다.
- **과도기 어댑터는 타입이 아니라 함수 3개다.** 옛 채널은 각자 자기 인자를 갖는다
  (`ma:*`→`panelId`, `session:*`→창 wcId, `claude:*`→인자 없음):
  ```
  panelIdToChat(panelId: string): string | null   // `${sessionId}::${slot}` → ma-<sid>-<i>
  wcIdToChat(wcId: number): string | null         // 창 레지스트리 역인덱스
  activeChat(): string | null                     // 별칭 계층이 들고 있는 활성 채팅 (§6.2)
  ```
  공용 주소 **타입**을 만들면 §6.1의 코어 채널에 그대로 박힌다.
- `surface`가 필요하다고 느껴지는 자리가 남으면 그건 **창 라우팅**이며, 답은 창 레지스트리의
  `chatId → label` 역인덱스다(§2.5·§6.1). 그 역인덱스가 U5(옛 `owner`)를 대체한다.

---

## 2. 다이얼 1~6 상호작용

### 2.1 다이얼과 크롬

| N | 크롬 | 근거 |
|---|---|---|
| 1 | **IDE 레이아웃** — 왼쪽 칼럼(사이드바⟷탐색기 `` ` `` 전환), 코드 뷰어, Git 카드, 풀 워크바, 변경파일 카드 | 2.6.2 `App.tsx:1432-1466`(lcol) + `:1489-1630`(chat--code) 그대로 |
| 2‥6 | **그리드** — `.ma-grid.nN` 배치(2·3 한 줄, 4=2×2, 5=3+2 스팬, 6=3×2), 패널은 zoom .8 미니어처 | `styles.css:3623-3634`, `MultiAgent.tsx:1856` |

**★ 중요(U4 수정)**: 위 표의 "왼쪽 칼럼·코드 뷰어·Git"은 **1 모드 전용이 아니다.** 2.6.2에서도
`App.tsx:1432-1466`은 **mode 분기 밖**에 있어 멀티에서도 산다. 2‥6에서도 그대로 있다 —
§3.1이 이걸 앱 크롬으로 못 박는다. (R1은 이걸 `<IdeShell>` 안에 넣었고, 문면대로면 2‥6에서
사이드바가 사라져 보드/채팅 전환 수단이 없어졌다. 목업은 처음부터 사이드바를 유지해 그렸다 —
**그림이 옳았고 글을 고쳤다.**)

다이얼은 현재 위치를 유지한다: 2.6.2에서 다이얼은 멀티 헤더 오른쪽(`MultiAgent.tsx:1812-1833`,
`.ma-count`), 1 모드에서는 채팅 헤더 오른쪽 같은 자리. 즉 **1↔2 전환에서 다이얼 버튼이
화면에서 이동하지 않는다** — 이게 "합쳐졌다"는 유일한 시각적 증거이므로 위치 고정이 규약이다.
R2에서 그 줄에 이름을 준다: **TopBar**(§3.1) — 앱 크롬의 한 줄이고, 왼쪽은 자리 문맥
(count=1이면 채팅 제목·폴더 칩 / count≥2면 보드 제목), 오른쪽은 다이얼·접힘 배지·실행 요약
칩·찾기·탐색기 토글·창 컨트롤.

### 2.2 N→1 축소 (6→1이 대표)

```
before  count=6  order=[0,1,2,3,4,5]  slots=[A,B,C,D,E,F]   focused=slot2(C)
after   count=1  order=[2,0,1,3,4,5]  slots=[A,B,C,D,E,F]   ← slots 무변경
                 보이는 자리 = order.slice(0, count) = [2] → C
                 접힌 자리   = order.slice(count)   = [0,1,3,4,5]
```

**1. 현재 대화 = 1번 자리.** 축소 시 포커스된 자리의 채팅이 `order`의 맨 앞으로 이동한다.
나머지 자리의 상대 순서는 보존.
2.6.2는 `visibleSlots = panelOrder.filter(s => s < count)`(`MultiAgent.tsx:886`)라서
count를 6→2로 줄이면 슬롯 4번 패널이 보이던 자리를 통째로 잃었다. R2는 필터 기준을
**"order 내 위치 < count"**(= `order.slice(0,count)`)로 바꾼다.

> **U8 해소 — `order`가 두 역할을 겸직하는 문제.** 표시 순서와 접힘 우선순위가 한 배열에
> 얹히므로, 규칙을 세 줄로 못 박는다.
> - **드래그 재배치(`multi-reorder`)는 보이는 자리끼리만 순서를 바꾼다.** 즉
>   `order[0..count-1]` 내부의 순열만 허용 — **접힘 집합 `order.slice(count)`는 불변.**
>   (2.6.2에서도 드래그는 그리드 안에서만 일어났다. 이건 제약 추가가 아니라 명문화다.)
> - 접힘 집합을 바꾸는 동작은 **딱 둘**: 다이얼 값 변경, 접힘 배지 팝오버의
>   「이 자리로 바꾸기」(= 보이는 위치 하나와 접힌 위치 하나를 swap).
> - 2.6.2의 count 축소 정리(`MultiAgent.tsx:1819-1824`: `focusedSlot`/`renamingSlot`이
>   `>= n`이면 해제)는 기준이 "슬롯 번호"에서 **"order 내 위치"**로 바뀐다. 포커스는
>   `focusedChatId`로 승격되므로 규칙은 한 줄이 된다:
>   *포커스 채팅이 보이는 자리에 없으면 `order[0]`의 채팅으로 옮긴다.* 이름 편집 중이면 커밋.

**2. 접힌 자리는 살아 있다.** `slots` 배열은 손대지 않는다. 엔진도 죽이지 않는다
(2.6.2 `ma:dispose`는 세션 삭제에서만 호출, `MultiAgent.tsx:2161`).

**3. 접힌 대화의 UI 행선지 — 세 곳에 동시에 있다:**
- **사이드바 「채팅」 목록** — 애초에 항상 거기 있었다. 실행 중이면 상태 점이 계속 돈다
  (2.6.2 `.sb-item .dot.run`, `styles.css:336-341`). 접힌 자리는 흐린 `⌄N` 칩.
- **다이얼 옆 접힘 배지** — `1 ⌄5`. 클릭하면 접힌 자리 팝오버: 자리 번호·제목·상태 칩 ·
  「이 자리로 바꾸기」(그 채팅을 1번 자리로) · 「자리 비우기」(보드에서만 제거, 대화는 유지).
- **TopBar의 실행 중 요약 칩** — 접힌 자리에서 도는 실행이 몇 개인지. 2.6.2가
  멀티 뷰 밖에서 멀티 실행을 못 보던 문제(사이드바 점만 있었다)를 여기서 갚는다.

**4. ★ 감시는 접힘과 무관하다 — 감시자를 Rust로 옮긴다 (U1의 해소).**

R1은 §2.2-4에서 "접힘은 감시 대상에서 빠지지 않는다"고 했고 §4.1에서 "접힌 자리는
마커(스냅샷 없음)"라고 했다. `useTurnNotifyList`는 항목마다 `state: SessionState`를 요구하므로
(`src/renderer/src/lib/notify.ts:34`, `NotifyWatchItem = { state, busy, title, target }`)
두 절이 같은 채팅에 대해 반대를 요구했다. **이건 규칙 조정으로는 못 푼다 — 감시자의 위치가 틀렸다.**

2.6.2가 렌더러에서 감시한 이유는 하나다: 실행 상태(`SessionState`)가 렌더러 리듀서에만
있었기 때문. 3.0은 `ChatRuntime`이 채팅마다 1개, **앱 수명 동안** 산다(m-logic §3.1) —
뷰가 없어도 상태가 있다. 전이 판정에 필요한 값(busy 하강 에지 · `pendingPermission` 상승 에지 ·
`pendingQuestion` 상승 에지 · `interrupted` · `status==='error'`)이 전부 상태기계 안에 있다.

```
감시 집합 = ChatRuntime이 살아 있는 모든 채팅
          (= 이 앱 세션에서 한 번이라도 스폰됐거나, 큐·hold를 들고 있는 채팅)
```

- 자리(보드 slots)·창·다이얼·접힘과 **무관**하다.
- §8-3의 "자리에서 빼도 계속 돈다" 시나리오 — 보드 slots에도 창에도 없는 채팅 — 이
  정의에 **그대로 들어온다.** R1의 "열린 채팅 전부(보드 slots ∪ 창)"는 이 채팅을 놓쳤다.
- **후퇴 없음**: 2.6.2가 감시한 것은 활성 세션의 6패널(`MultiAgent.tsx:891-898`) + 본채팅 1
  (`App.tsx:716`) + 열린 창 각 1이고, **비활성 세션의 패널은 마운트되지 않아 감시 밖**이었다.
  3.0의 집합은 그 상위집합이다.
- **오탐 토스트도 같이 죽는다**: `useTurnNotifyList`의 `prev` 맵은 컴포넌트 수명에 묶여 있고
  첫 관찰은 전이로 치지 않는다(`notify.ts:42`). 감시 집합이 가변 길이가 되면 빠졌다 돌아온
  채팅이 낡은 `prev`와 비교돼 오탐이 난다(크리틱 U1 파생 ②). Rust는 `prev`를 `ChatRuntime`에
  두므로 마운트/언마운트가 없다 — 구조적으로 안 난다.
- **미리보기 한 줄**: 2.6.2는 스냅샷을 거슬러 마지막 어시스턴트 텍스트를 뽑았다
  (`notify.ts:17-30 lastAssistantText`). Rust는 스트리밍 중 **꼬리 200자만 링버퍼**로 유지하고
  (`ChatRuntime.notify_tail`) 턴이 끝나면 그 값을 쓴다. 잡음 제거 규칙(``` 블록 · `` [#*`>|] `` ·
  공백 접기 · 140자)은 같은 함수를 Rust로 옮긴다. 스냅샷은 필요 없다.
- **남는 렌더러 몫: 없음.** `notify:event`(렌더러→main) 채널이 사라진다. `notify:open`
  (토스트 클릭 → main)만 남고 라우팅 대상이 `{ chatId }`다.
- 표시(사이드바 점·배지 숫자·완료 링)에 필요한 값은 스냅샷이 아니라 §4.3의 `ChatStatusLite`.

**5. ★ 접힌 자리에서 승인/질문이 뜨면 — 카드는 자리 안, 알림은 밖 (신설).**

목업이 안 그렸고 R1 스펙에도 없던 규약이다(크리틱 목업 미흡 #4).

- 카드는 **자리 스코프**를 지킨다. 접힌 자리의 카드는 화면에 없다.
  **자동 승격 금지** — 사용자가 보던 화면을 뺏지 않는다.
- 대신 **네 곳**이 동시에 알린다:
  1. 접힘 배지가 `1 ⌄5` → `1 ⌄5 ‼2`(노랑). 클릭하면 팝오버가 대기 중인 자리를 맨 위로 정렬.
  2. TopBar에 「승인 대기 2」 칩. 클릭 = 그 자리를 1번 자리로 올린다(swap).
  3. 사이드바 항목의 상태 점이 대기 색(`.dot.ask` — 2.6.2엔 없던 상태).
  4. 창이 비포커스면 토스트(위 4번 규약. 2.6.2도 `approve`/`ask` kind를 이미 쏜다 —
     `notify.ts:47-48`).
- **키보드는 안 먹는다.** 숫자·화살표·Enter·Esc는 포커스 자리 전용(`focusedChatId` 게이트).
  접힌 자리의 카드를 답하려면 먼저 올려야 한다 — 보이지 않는 카드가 키를 먹는 사고를 막는다.
- 응답 없이 오래 두면 2.6.2와 같다: **아무 일도 안 한다**(모델이 대기). M-LOGIC의 `AskCard`
  라이브 항목은 리스가 무한(스트림 소유)이라 워치독도 안 건다.
- 목업: `chat-unify-fold-alert.html`.

### 2.3 1→N 확대

1. 1번 자리(= 현재 대화)는 그대로 1번 자리에 남는다.
2. 자리 2‥N은 보드가 기억한 배정(`order.slice(1,N)`이 가리키는 `slots`)으로 되채워진다.
3. 기억이 없거나(첫 확대) 배정이 가리키던 채팅이 삭제됐으면 **빈 자리**.
4. 되채워지는 채팅이 창에 열려 있으면 **유령 셀**(§2.6 중복 해소).

### 2.4 빈 자리와 빈 채팅

빈 자리(`slots[i] === null`)는 대화가 아니다. 카드 하나를 그린다:
`＋ 새 채팅` / `최근 채팅에서 고르기`(목록 팝오버) / `이 자리 숨기기`(count −1).

2.6.2의 빈 패널은 "아직 안 쓴 대화"였고(`MultiAgent.tsx:207 blankSession`), 사이드바에는
제목이 생길 때까지 안 보였다(`MultiAgent.tsx:2209-2223 summaries` 필터 / 본채팅은
`App.tsx:709-712 activeEmpty`). 통합 후 규칙:

- 빈 자리에서 첫 전송 → 그 순간 채팅이 생성돼 풀에 편입 + 그 자리에 배정.
- 제목이 생기기 전(=첫 전송 전) 채팅은 사이드바에 안 보인다.
- **★ U12 수정 — "빈 채팅 최대 1개"(`App.tsx:781-788`)의 일반화 방향.**
  R1은 "자리당 최대 1개"라고 했는데 그러면 6자리 = 빈 채팅 6개이고, 그 6개가 사이드바·디스크·
  light 조회에서 어떻게 취급되는지가 비었다. R2의 규칙:
  1. 빈 채팅은 **자리에 배정된 것만 존재한다.** 자리 밖 빈 채팅은 만들지 않는다
     (= 상한 = 보이는 자리 수 + 열린 창 수, 최대 6+W).
  2. **light 조회에서 빈 채팅은 통째로 유지한다** — 2.6.2 예외를 그대로 보존
     (`chats.ts:70-75`: *활성이거나 스냅샷이 빈* 채팅은 접지 않는다 / `chats.rs:97-104`).
     이 예외가 `App.tsx:783`의 `!c.unloaded` 재사용 판정을 받친다. R1 §4.1은 이걸 지웠다.
  3. 디스크에는 남기지 않는다 — `sessionChats.ts:104`의 `(rec.empty && !rec.btwOf) → skip`을
     전 채팅에 적용. 단 btw 채팅은 빈 채로도 남긴다(알약 규약).
  4. 3의 결과로 다음 부팅에 **보드 `slots[i]`가 없는 id를 가리킬 수 있다** → 보드 로드 시
     정화(sanitize): 존재하지 않는 chatId는 `null`로 내린다. (2.6.2 `sanitizePanelOrder`
     `MultiAgent.tsx:222-224`와 같은 자리.)

### 2.5 자리 번호와 창 — `Chat.owner`는 삭제한다 (U5)

2.6.2에서 자리 번호는 **표시**(그리드 위치)고 슬롯 번호는 **정체성**(엔진 채널)이다
(`MultiAgent.tsx:144-147`, `:266`, `:883-886`). 통합 모델에서 이 이중성이 사라진다:

| | 2.6.2 | 3.0 통합 |
|---|---|---|
| 엔진 채널 | `${sessionId}::${slot}` (`MultiAgent.tsx:236`) | `chatId` |
| 자리 번호 | `visibleSlots.indexOf(slot)+1` | 동일 (`order` 내 위치) |
| 팝아웃 키 | panelId(=세션+슬롯) | chatId |
| 팝아웃 중 그리드 | 유령 셀(`MultiAgent.tsx:1865-1879`) | 동일 — 유령이 chatId를 가리킨다 |
| 자리 이동/다이얼 변경 시 창 | `slotOfPanelId`가 count 밖을 가리키면 미아 | 무관 (창은 chatId로 라우팅) |

**R1의 `Chat.owner`를 삭제한다.** 이유(크리틱 U5):
R1 §2.5는 "큐 드레인·한도 대기표 타이머·자동 재개 전송은 `owner === 내 창`일 때만 돈다"고 했다.
그런데 m-logic §7.2 `drain_if_possible()` · §7.3 `LimitHold` · T27은 **드레인과 hold를
Rust `ChatRuntime`이 소유**한다 — 창이 여럿이든 하나든 **렌더러는 드레인하지 않는다.**
`owner`는 존재하지 않는 문제를 푸는 필드였다.

R2가 그 자리에 두는 것:

```
WindowRegistry:  label ⇄ chatId   (1:1 역인덱스)
```

- **구동**: 언제나 Rust. 큐 드레인·hold 타이머·자동 재개·정체성 착지 전부 `ChatRuntime`.
  창이 몇 개 열려 있든, 하나도 없든 같다.
- **뷰**: 어떤 창이 그 채팅의 자리를 그리는가 = 레지스트리 역인덱스. 그 채팅이 레지스트리에
  있으면 그리드 자리는 **유령 셀**이 된다(2.6.2 팝아웃과 같은 그림).
- **초안·큐·대기표의 소유권 이전은 필요 없다.** 상태가 스토어 한 곳에 있고, 불변식 2에 따라
  컴포저는 동시에 하나뿐이다(창에 있으면 그리드는 유령 = 컴포저 없음). 2.6.2의
  persist→fold-back(`index.ts:722-732`)·leftover 소비(`index.ts:667-670`,`:1315-1330`)·
  `patchMeta(slot,{input:'',images:[],queue:[]})`(`MultiAgent.tsx:1304`)·
  `lrs[slot].setHold(null)`(`:1306`)가 전부 사라진다.
- **m-logic O3("초안·스크롤 등 순수 UI 상태는 여전히 이전 필요")와의 화해**:
  - **초안·이미지·큐** → `Chat`(스토어). 이전 없음.
  - **스크롤 위치·접힌 ToolGroup·모달 포커스** → **창 로컬 휘발 상태.** 이전하지 않는다
    (2.6.2도 안 했다 — 팝아웃하면 스크롤이 맨 아래로 간다). 명시적으로 "이관 없음".
  - **키보드 스코프** → 포커스된 창의 `focusedChatId` 하나(§3.4).
- **고아 회수**: 창이 크래시하면 레지스트리에서 라벨이 빠진다 → 그 chatId는 그리드 자리로
  되돌아온다(유령 해제). 옛 `owner` 필드가 남길 수 있었던 "죽은 창에 박힌 소유권"이 원천적으로
  없다. (M-LOGIC의 고아 상태 정리 규약과 같은 자리.)

### 2.6 「한 채팅은 한 자리」의 범위 (U6)

R1의 불변식 2는 범위가 없어 보드 다중성과 충돌했다. R2의 정의:

- **금지되는 것**: 같은 chatId가 **동시에 두 개의 *보이는* 자리**에 있는 것.
  보이는 자리 = (활성 보드의 `order.slice(0,count)`) ∪ (열린 창).
- **허용되는 것**: 같은 chatId가 **여러 보드의 `slots`에, 그리고 접힌 자리에** 들어 있는 것.
  그건 "뷰"가 아니라 "기억된 배정"이다 — 후보 C의 존재 이유("그때 그 조합" 복원)를 살린다.
- **보드 활성화 시 중복 해소** (결정론적, 왼쪽/앞 자리 우선):

```
activateBoard(b):
  seen = {}                                   # 이번에 보이게 된 chatId
  for pos, i in enumerate(b.order[:b.count]):
    id = b.slots[i]
    if id is null:            continue                     # 빈 자리
    if id in WindowRegistry:  render ghost(id); continue    # 창에 있다 → 유령 셀
    if id in seen:            b.slots[i] = null             # 중복 → 빈 자리로 강등
                              chip("이 대화는 자리 {seen[id]}에 이미 있어요")
                              continue
    seen[id] = pos + 1
```

- 강등은 **활성 보드의 메모리 상태에만** 적용하고 다른 보드의 `slots`는 건드리지 않는다.
- 이 규칙 덕에 §4.3의 "보이는 자리 count개만 스냅샷" 계산이 항상 유일한 집합을 만든다
  (같은 채팅을 두 번 세지 않는다).

---

## 3. 표면 통합 — 한 벌로 배선하기

### 3.1 컴포넌트 경계 (★ U4 수정 — 앱 크롬을 자리 밖으로 되돌렸다)

```
앱 크롬  (자리 밖 — 메인 창에 하나. 다이얼 값과 무관하게 산다)
   ├ TitleBar / WinControls / 앱 업데이트 바
   ├ TopBar            ← 왼쪽: 자리 문맥(count=1이면 채팅 제목·폴더 칩 / count≥2면 보드 제목)
   │                     오른쪽: 다이얼 · 접힘 배지 · 실행 요약 칩 · 찾기 · 탐색기 토글 · 창 컨트롤
   ├ 왼쪽 칼럼          ← Sidebar ⟷ Explorer (` 전환). 2.6.2도 mode 분기 밖(App.tsx:1432-1466)
   ├ CodeViewer(FileModal)   ← 단일 인스턴스. 대상은 viewerTarget { chatId, path, from } (§3.4)
   ├ GitModal · ChangedFilesModal · ImageViewer · SubAgentModal(앱 레벨 진입분)
   ├ SettingsModal · PromptLibrary · NewChatModal
   └ 게이트류(엔진/앱 업데이트) · 토스트 창 · 트레이 창

<ChatSurface chatId>            ← 채팅 하나를 그리는 유일한 컴포넌트
   ├ 스레드 (MessageView, useThreadWindow, useThreadFollow)
   ├ WorkBar          (Chat.tsx:3142)
   ├ Composer         (Chat.tsx:4251)
   ├ LimitHoldBar     (Chat.tsx:2729)      ← 30초 틱을 스스로 소유 (memo 함정, useLimitResume.ts:169-171)
   ├ QuestionModal    (Chat.tsx:3585)      ← 자리 스코프
   ├ PermissionModal  (Chat.tsx:3634)      ← 자리 스코프
   ├ WorkflowDock     (Chat.tsx:3982)
   ├ BtwDock          (Chat.tsx:4059)
   ├ BashLogModal / BgTaskModal / SubAgentModal (Chat.tsx:389·2983 · AgentPanel)
   └ FolderSwitchDialog                     ← M-LOGIC needs_confirm의 표시 형태

자리 껍데기 3종 — ChatSurface를 담기만 한다 (앱 크롬을 담지 않는다)
   ├ <IdeShell>    count=1 : 전폭. 자체 헤더 없음(TopBar가 그 역할)
   ├ <GridCell>    count≥2 : 패널 헤더(자리번호·제목·폴더칩·상태·크게보기·팝아웃) + zoom .8
   └ <WindowShell> 창      : 창 헤더(제목·폴더칩·찾기·WinControls) + 창 크롬 축소판
                             창 크롬 = 뷰어 · 이미지 라이트박스 · 서브에이전트 카드 **셋뿐**
                             (2.6.2 실측: SessionWindow/PanelWindow에 Explorer·Git·Settings import 0건)
   └ 공통: ErrorBoundary 래퍼 1벌 — 자리 하나가 죽어도 나머지가 산다
           (2.6.2는 멀티 전체가 한 경계라 패널 하나의 예외가 6자리를 같이 죽였다, App.tsx:1474)
```

2.6.2 대응: `App.tsx`(IDE) · `MultiAgent.tsx PanelView:317`(그리드) ·
`SessionWindow.tsx`(창) · `PanelWindow.tsx`(창) 네 벌 → **앱 크롬 1 + ChatSurface 1 + 껍데기 3**.
`PanelView`는 이미 "본채팅과 완전히 같은 문법"을 목표로 만들어져 있다(`MultiAgent.tsx:261-263`
주석) — 통합은 그 목표를 코드로 확정하는 것이다.

> 전 화면이 이 다섯 칸 중 어디로 가는지는 **`docs/design/ux-parity-map.md`**가 156행으로 답한다.
> 그 표에서 두 칸 이상 체크된 14건이 "아직 이중 배선"이고, 각각 통합 방법이 한 줄씩 붙어 있다.

### 3.2 기능별 통합 방법

**승인/질문 카드.** 카드는 항상 `ChatSurface` 안에 그린다(= 자리 스코프). 2.6.2 멀티가
이미 그렇다(`screen-inventory.md` §8 `multi-panel-question`/`multi-panel-permission`).
1 모드에서는 자리가 화면 전체이므로 지금과 똑같이 보인다. 키보드(숫자/화살표/Enter)는
**포커스 자리만** — 2.6.2 `focusedSlot` 게이트(`MultiAgent.tsx:1017-1110`)를
`focusedChatId` 하나로 승격. 접힌 자리의 카드는 §2.2-5.

**한도 자동 이어서.** `useLimitResume`(`lib/useLimitResume.ts:18-30`)은 이미 표면 중립
인터페이스다 — 통합 후 **채팅당 1개**만 산다. 2.6.2가 9개(본채팅 1 + 슬롯 6 + 창 2)를
따로 굴리던 것은 자리마다 상태를 들고 있었기 때문. 규약 보존:
- `holdKey` = chatId (2.6.2 본채팅은 activeChatId, 그 외는 고정값 — `useLimitResume.ts:26`)
- busy 상승 에지 자동 해제(`:109-116`), prev-busy 장전 가드(`:50-57`), 발화 재검증(`:118-145`)
- **LimitHoldBar가 카운트다운 틱을 소유**(`:169-171`) — 호스트 재렌더가 memo를 못 뚫는 함정
- **장전·해제 판정은 Rust로 간다**(m-logic §7.3). 훅은 표시와 사용자 조작만 남는다.
- 재시작 복원 범위 → 열린 문제 ⑤

**btw 포크.** `tryBtw`(`App.tsx:962-979`) / `tryBtwPanel`(`MultiAgent.tsx:1336-1358`)이
같은 함수가 된다: `origin = chatId`, `originTitle = chat.title`, 상속물 = 그 채팅의 identity.
알약 도크는 `btwOf === 내 chatId`로 거른다(2.6.2 `App.tsx:1380` / `MultiAgent.tsx:1320-1333`
와 같은 규칙, 슬롯 역산 `slotOfPanelId`가 사라져 단순해진다). **own 세션이 생기면 재포크
금지** 규약 유지(`sessionChats.ts:38-42`), `btwPrompt`는 읽으면 소비(`:41-42`).

**토스트.** `NotifyTarget`(`protocol.ts:810-811`)의 `surface: 'single'|'multi'|'session'`이
`{ chatId }` 하나로 접힌다. 감시·전이 판정은 Rust(§2.2-4). 라우팅(`App.tsx:718-726`)은
"그 채팅이 보이는 자리로 점프" = (a) 활성 보드의 보이는 자리에 있으면 그 자리로 포커스,
(b) 접혀 있으면 1번 자리로 swap 후 포커스, (c) 창이면 창 포커스, (d) 어디에도 없으면
**1번 자리에 얹는다**(기존 1번 자리 채팅은 접힘 집합의 맨 앞으로 밀린다 — 대화는 안 잃는다).

**계정 오버라이드 / picker.** `Chat.identityOverrides`에 붙으므로 자리와 무관하게 따라간다.
2.6.2의 3벌(§0 표)이 1벌. 계정별 `CLAUDE_CONFIG_DIR` 물질화·projects 정션 공유 규약은
그대로(M-LOGIC/M5 소관).

**워크바.** 백그라운드 셸 칩·워크플로·서브에이전트 전부 `ChatSurface` 안. `chat:bg-task`
하나가 `claude:bg-task`/`ma:bg-task`/`session:bg-task`(3채널)를 대체.

**완료 표시.** `effectiveStatus/bgActive` 단일 소스 규칙 유지 — 이제 소스가 `ChatStatusLite`라
자리·사이드바·접힘 배지·토스트가 **같은 값**을 읽는다. 2.6.2는 사이드바 점(멀티는
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
| 코드 뷰어의 질문 바 | 있다(`SessionWindow.tsx:884`) | **없다**(`PanelWindow.tsx:528`) |

통합 후 **하나**: `WindowSlot { label, chatId }`.
- 엔진은 언제나 chatId 소유(창은 뷰). → `sessionEngines` 맵이 사라진다.
- 이벤트는 `chat:event`를 chatId→창 레지스트리로 팬아웃. → 2.6.2 팝아웃 미러 규약이
  일반 규칙이 된다(`ARCHITECTURE-3.0.md` 창 시스템 절과 일치).
- 영속은 `chats-v3/<id>.json` 하나. → `session-chats/` 스토어가 사라진다.
- `Ctrl+Shift+N` = "새 채팅을 창 자리에서 열기". 팝아웃 = "그리드 자리의 채팅을 창 자리로
  이동". btw = "포크한 채팅을 창 자리에서 열기". **세 동작이 같은 명령의 인자 차이**다.
- 창 닫기 = 자리 소멸. 대화는 풀에 남는다. 그리드 복귀 여부는 → 열린 문제 ④.
- 살아남는 규약: 독립 OS 창(네이티브 리사이즈·스냅 유지, `titleBarStyle:hidden` 계열 —
  Tauri 대응은 M1 소관), 창별 아크릴 유지(`index.ts:521-528 keepAcrylicWhenBlurred`),
  닫기 전 flush 요청 + 1.5s 타임아웃(`index.ts:509-515`), 창이 다시 보이면 정리 취소(`:506`).
- 목업: `chat-unify-window.html` (§3.3이 가장 크게 바꾸는 화면인데 R1엔 그림이 없었다).

### 3.4 ★ 포커스와 「대상 채팅」 — N≥2에서 모호해지는 것들 (신설, U9)

2.6.2는 활성 채팅이 하나뿐이라 "이 동작이 어느 대화로 가는가"가 물어질 일이 없었다.
N≥2에서는 물어야 한다. **규약 하나로 전부 답한다.**

```ts
focusedChatId: string | null    // 마지막으로 클릭/키 입력이 들어간 자리의 채팅.
                                // 2.6.2 focusedSlot(MultiAgent.tsx:1017-1110)의 승격판.
                                // count=1이면 항상 그 자리. 창은 그 창 자신.
viewerTarget: { chatId, path, from: 'explorer'|'thread'|'git'|'changed' } | null
```

| 동작 | 2.6.2 | 3.0 대상 |
|---|---|---|
| 탐색기 트리 추종 폴더 | mode 삼항(`App.tsx:1452 multiExp`) | `focusedChatId`의 cwd |
| 탐색기에서 파일 열기 | 그 표면의 FileModal | 앱 크롬 뷰어, `viewerTarget = {focusedChatId, path, 'explorer'}` |
| 스레드의 파일 링크 클릭 | 그 표면의 FileModal | `viewerTarget = {그 자리의 chatId, path, 'thread'}` |
| **뷰어 선택 → 질문**(`onAskSelection`) | App / SessionWindow만(2벌), 멀티·팝아웃엔 없음 | `viewerTarget.chatId`로 전송. 뷰어 헤더의 **대상 채팅 칩**이 어디로 가는지 보여주고, 칩 클릭으로 대상 변경 가능 |
| 뷰어 diff 출처 | 표면마다 다른 `state.diffs` | `viewerTarget.chatId`의 diffs |
| `Ctrl+F` 대화에서 찾기 | 활성 채팅 | `focusedChatId`의 스레드 |
| 변경된 파일 카드 | mode 삼항 | `viewerTarget?.chatId ?? focusedChatId` |
| Git 카드 폴더 | "따라가는 패널의 폴더"(`App.tsx:1624` 주석) | `focusedChatId`의 cwd |
| 새 채팅(Ctrl+N) | 활성 채팅 자리 | `focusedChatId`의 자리(빈 채팅 규칙은 §2.4) |
| 승인/질문 키보드 | `focusedSlot` 게이트 | `focusedChatId` 게이트 |

**두 가지를 함께 고친다:**
1. **뷰어發 질문이 뷰어를 강제로 닫던 문제.** 2.6.2 `App.tsx:1157`은 전송 직전에
   `setOpenFilePath(null)`을 부른다 — 메모리에 남은 미결 불편("onAskSelection의 뷰어 강제
   닫힘")이다. R2: **닫지 않는다.** 카드/스레드는 자리 안에서 흐르고 뷰어는 그대로 열려 있다.
   대신 그 자리의 스레드를 맨 아래로 스크롤한다.
2. **대상이 보이게 한다.** 뷰어 헤더에 대상 채팅 칩(제목 + 자리 번호)을 항상 그린다.
   N=1이면 칩이 흐리게(정보만), N≥2면 또렷하게.

---

## 4. 저장 스키마

### 4.1 파일 배치 (★ U11 수정 — 새 디렉터리)

```
~/.agentcodegui/
  chats-v3/                     ← ★ 새 디렉터리. 2.6.2의 chats/ 를 재사용하지 않는다
    index.json            { version: 1, order: [chatId…], activeChatId,
                            statuses: { <chatId>: ChatStatusLite },   ← §4.3
                            migratedFrom?: "2.6.2", migratedAt?: number }
    <chatId>.json         { id, title, custom, locked, color, identityOverrides,
                            draft, draftImages, queue?, hold?, btwOf?, btwSeed?, btwPrompt?,
                            empty?, lastSeenAt?, updatedAt, snapshot }
  boards/
    index.json            { version: 1, order: [boardId…], activeBoardId }
    <boardId>.json        { id, title, custom, count, chrome, order, slots, updatedAt }
  chats/  multi-agent/  session-chats/  chat-talk.json
                                ← ★ 읽고 **남긴다**(삭제하지 않는다). 2.6.2로 되돌아가면
                                   마이그레이션 시점 상태로 그대로 산다
  backup-2.6.2-<stamp>/         마이그레이션 전 원본 통째 복사(추가 안전망)
```

- **왜 새 디렉터리인가**: R1은 `chats/index.json.version`을 1→3으로 올려 다운그레이드를
  막겠다고 했지만, **main도 렌더러도 version을 검사하지 않는다**(`chats.ts:79`·`:157`,
  `App.tsx:131`·`:620` — 읽을 때 `?? 1`, 쓸 때 상수). 2.6.2로 되돌리면 통합 스토어를 조용히
  읽고 `version:1` + 유실 필드로 **되쓴다.** 디렉터리를 분리하면 그 경로가 원천 차단된다.
- **부작용 하나를 명시**: 마이그레이션 후 3.0에서 만든 대화는 2.6.2에 보이지 않는다.
  되돌리면 **마이그레이션 시점의 대화까지만** 남는다. 백업이 아니라 이게 설계된 동작이다.
- 3.0 부팅 시 옛 디렉터리의 mtime이 `migratedAt`보다 **새로우면**(= 그사이 2.6.2를 돌렸다)
  안내 카드: "2.6.2에서 만든 대화가 있어요 — 다시 가져올까요?" → 재마이그레이션(멱등).
- **팬아웃 구조는 2.6.2와 동일**: 항목별 파일 + `index.json`(버전·순서·활성) + 내용
  문자열 비교로 바뀐 파일만 쓰기 + 목록에서 사라진 파일 prune. `chats.ts:116-162` /
  `chats.rs:175-218`을 그대로 재사용한다 — `boards/`는 `chats-v3/`의 복제.
- **원자 저장**: `writeFileAtomic` / `ccg_store::write_atomic`(`lib.rs:60-70`) 그대로.
- **unloaded 마커**: 규약 한 글자도 바꾸지 않는다. 렌더러가 스냅샷 없는 메타만 되보내면
  스토어가 디스크의 스냅샷을 되끼워 저장(`chats.ts:22-35`, `chats.rs:151-172`).
  **이걸 깨면 대화가 통째로 증발한다** — `chats.rs:1-12`가 그 경고를 이미 달고 있다.
- **지연 로드**: 자리에 얹히는 순간 `chats:load`로 되읽는다(`App.tsx:746-771 restore`,
  `MultiAgent.tsx:2124-2147 activate`의 seq 가드 규약 — 연타 시 마지막 요청만 이긴다).

### 4.2 3스토어 → 통합 마이그레이션 매핑

| 2.6.2 | 3.0 통합 | 비고 |
|---|---|---|
| `chats/<id>.json` | `chats-v3/<id>.json` (id 유지) | `manualCwd`→`identityOverrides.cwd`, `refDirs`→`.addDirs`, `picker.*`→`.model/.effort/.mode/.engine/.account/.codexAccount`. 스냅샷·초안·updatedAt 그대로. **`locked`·`color`는 없던 필드 → 기본값 주입**(`false`, `''`) — R1이 "그대로"라 적은 것은 오류 |
| `chats/index.json.order` | `chats-v3/index.json.order` 앞부분 | 순서 보존 |
| `chats/index.json.activeChatId` | 기본 보드 `slots[0]` + `activeChatId` | |
| `multi-agent/<sid>.json.panels[i]` | `chats-v3/ma-<sid>-<i>.json` (새 id, 결정론적) | title/custom/locked/color/cwd/refDirs/picker/api/snapshot 그대로. 내용 없는 패널(제목·스냅샷 없음)은 생성하지 않고 `slots[i]=null` |
| `multi-agent/<sid>.json` | `boards/<sid>.json` | `count`·`panelOrder`→`order`·`title`·`custom`·`updatedAt` 그대로, `slots[i]=ma-<sid>-<i>\|null`, `chrome='grid'` |
| `multi-agent/index.json.activeSessionId` | `boards/index.json.activeBoardId` | |
| **`multi-agent/index.json.order`** | **`boards/index.json.order`** | (R1 누락 — 크리틱 §6) 순서 그대로 |
| `session-chats/<id>.json` | `chats-v3/<id>.json` (충돌 시 `sc-<id>`) | `snapshot`·`cwd`·`refDirs`·`picker`·`btwOf`·`btwSeed`·`btwPrompt`·`custom`·**`empty`**·**`draft`/`draftImages`**·**`updatedAt`** 보존. `status`는 저장 시 idle/done/error로 얼려 오는 규약 유지(`sessionChats.ts:28`) → `index.json.statuses`로 |
| **`session-chats/index.json.order`** | **`chats-v3/index.json.order` 뒤에 이어 붙인다** | (R1 누락) 시간순 병합이 아니라 **일반 채팅 → 멀티 패널 → 추가 채팅** 순 연결. 결정론적이고 사용자가 예측 가능 |
| 추가 채팅의 창 배정 | 없음 (창 자동 복원 안 함) | 2.6.2도 재시작 때 창을 되열지 않는다(`sessionChats.ts:7-9`) |
| **`panelLeftovers`(main 메모리) · 열린 창 목록** | **이관 없음** | (R1 침묵) 2.6.2도 재시작 복원 안 함 → 손실 아님. **명시적으로 "이관 없음"** |
| **`PersistedPanel`의 초안/큐** | **공집합** | `MultiAgent.tsx:127-137` — input/images/queue는 애초에 영속되지 않는다. §5.2의 "초안 맵 동일"은 패널에 대해 **공집합 비교**임을 명시(오검출 방지) |
| **읽지 않음 배지** | **해당 없음** | 2.6.2에 없다(사이드바는 상태 점뿐, `styles.css:336-341`). 신규 필드이므로 이관 대상 아님 |
| `chat-talk.json` | 남아 있으면 `chats-v3/`로 1회 편입 후 비움 | 2.6.2가 이미 하던 것(`App.tsx:528-594`) |
| — | 기본 보드 `boards/default.json` | `count = ui-prefs의 workspace.mode==='multi' ? 마지막 세션 count : 1`, `slots[0] = 이전 activeChatId` |

**★ 전역 pref → 채팅 층 이관 (U10 — R1에 표가 없었다)**

문제: `api.mode`는 **전역**이다(`App.tsx:180 getPref('api.mode')`, 실행 시 `App.tsx:1076 useApi: apiMode`).
멀티 패널만 패널별(`PanelMeta.api`), 추가 채팅 레코드엔 필드 자체가 없다(`sessionChats.ts:24-46`).
M-LOGIC이 `BillingAxis`를 **채팅별 정체성 축**으로 승격하므로, 마이그레이션 순간 기존 채팅
전부가 그때의 전역값으로 굳는다 → 이후 전역 토글을 꺼도 옛 채팅은 API로 돈다.

해결: **저장하는 것은 `identityOverrides`(부분)뿐이고, 미지정 필드는 전역을 상속한다.**
`RunIdentity`(m-logic의 얼린 필드 집합)는 `전역 기본 + overrides`로 **계산**되므로 m-logic의
정규화 규칙·골든 테스트와 충돌하지 않는다 — 얼린 것은 계산 결과의 필드 집합이지 저장 스키마가 아니다.

| 전역 pref | 2.6.2 위치 | 3.0 |
|---|---|---|
| `api.mode` | `ui-prefs`(`App.tsx:180`) | 전역 기본 유지. 채팅 override는 **멀티 패널의 `PanelMeta.api`만** 승격(그건 이미 패널별이었다). 일반·추가 채팅은 **미지정(상속)** |
| `claude.outputStyle` | `ui-prefs`(`engine.ts:57-59`) | 같은 규칙. 전 채팅 미지정으로 마이그레이션 |
| `limitResume.on` (자동 이어서 토글) | `ui-prefs` | **전역 유지**(채팅별로 만들 이유가 없다). 열린 문제 ⑤와 별개 |
| `limitResume.hold` (단일 슬롯, key=activeChatId) | `ui-prefs`(`App.tsx:506-515`, `sanitizeHold`) | `Chat.hold`로 이관 — **key가 가리키는 그 채팅 하나만.** 24시간 만료·형태 위생은 `sanitizeHold` 규칙 그대로 |
| `chat.zoom` / `multi.zoom` / `multi.expand.zoom` / `session.zoom` | `ui-prefs` 4개 | 크롬별 3개로: `zoom.ide`←`chat.zoom`, `zoom.grid`←`multi.zoom`, `zoom.window`←? (`session.zoom`과 `multi.expand.zoom`이 합쳐진다 — 어느 값을 승계할지 열린 문제 ⑫) |
| MCP/Skill on-off | 앱 전역(`protocol.ts:1050-1053`) | 전역 유지. 채팅 override는 M9의 확장점(`identityOverrides.mcpOverrides/skillOverrides`) |

**id 충돌.** `chats/`와 `session-chats/`는 둘 다 `randomUUID`라 충돌 확률은 무시할 수
있지만 마이그레이터는 **검사하고 접두사를 붙인다**(`sc-`). 멀티 패널은 무조건 새 id
(`ma-<sid>-<i>`, 결정론적이라 재실행해도 같은 id → 멱등).

**★ `btwOf` 재작성 — 매핑표만으로는 안 된다 (R1 오류, 크리틱 인용 #9).**
멀티에서 만든 btw의 `btwOf`는 **panelId 형식** `${sessionId}::${slot}`이다
(`MultiAgent.tsx:1346 origin: chan(sessionId, slot)`). 매핑표의 키는 `ma-<sid>-<i>`라
**키 형식이 다르다.** 마이그레이터는 두 단계로 푼다:
```
rewriteBtwOf(v):
  if v matches /^(.+)::(\d)$/        → `ma-${$1}-${$2}`      # 멀티 패널 원본
  else if v in idMap                 → idMap[v]              # 일반/추가 채팅 원본
  else                               → drop(btwOf) + 로그    # 원본이 이미 삭제됨
```
`drop`한 건수는 리포트에 남긴다(§5.2의 "고아 0건"은 *재작성 실패*가 0이라는 뜻이지
*원본이 없던 것*까지 살린다는 뜻이 아니다).

**롤백.** `backup-2.6.2-<stamp>/`에 원본 3디렉터리 + `chat-talk.json`을 통째 복사한다.
옛 디렉터리를 남기는 정책(§4.1)과 합쳐 되돌리기 경로가 둘이 된다.

### 4.3 ★ 부팅 light 조회와 `ChatStatusLite` (U1·U12의 데이터 쪽)

**light 조회 규칙** — R1의 규칙에서 두 곳을 고쳤다.

```
스냅샷을 싣는다:
  (a) 활성 보드의 보이는 자리(count개)의 채팅
  (b) 열린 창의 채팅
  (c) ★ 스냅샷이 빈 채팅 전부 (2.6.2 예외 보존 — chats.ts:70-75, chats.rs:97-104)
나머지 → unloaded: true 마커
```

- (c)를 R1이 지웠다(크리틱 인용 #7·U12). 이 예외가 `App.tsx:783`의 `!c.unloaded` 빈 채팅
  재사용 판정을 받치고 있다. 지우면 "새 채팅을 눌렀는데 골라둔 모델·폴더가 사라진다"가 난다.
- 최대 개수: 6(자리) + W(창) + E(빈 채팅, 실무상 0~2). 2.6.2의 "활성 1개"보다 늘지만
  마커의 페이로드가 0에 가까우므로 순증가는 자리 수만큼이다.
- R1이 "`status` 필드만 마커에 실어 보낸다"고 한 것을 아래 레코드로 정확히 대체한다.

**`ChatStatusLite` — 마커 채팅의 표시값은 여기서 온다 (스냅샷이 아니다)**

```ts
// 마커든 아니든 모든 채팅이 항상 갖는다. 파일에는 index.json에만 산다.
interface ChatStatusLite {
  chatId: string
  status: AgentStatus                 // idle | working | analyzing | done | error
  busy: boolean                       // 원시 상태(전송 게이트) — m-logic §3.2
  bgActive: boolean                   // 라이브 원장이 비었나 → 완료 링 판정(effectiveStatus 단일 소스)
  ask: 'none' | 'permission' | 'question'
  hold: { resetAt: number; ready: boolean } | null
  queued: number                      // 예약 큐 길이
  unread: number                      // lastSeenAt 이후 도착한 어시스턴트 턴 수 (신규 — 열린 문제 ⑪)
  updatedAt: number
}
```

출처 둘, 우선순위 있음:
1. **부팅** — `chats-v3/index.json.statuses`. 저장 시점에 얼려 온다. 2.6.2가 이미 하던 두 규약의
   일반화다: `sessionChats.ts:28`(`status`를 idle/done/error로 얼려 저장 — 실행 중 상태 복원 방지)
   + `maStore.ts:94`(light가 마커에 `panelStatuses`를 실어 보냄).
   부팅 직후엔 `busy=false`·`ask='none'`·`bgActive=false`로 **강제**한다.
2. **런타임** — `chat:status` 이벤트(REPLACE, 전 채팅). Rust가 `ChatRuntime` 상태에서 파생해
   내보낸다. 도착하는 순간 1의 값을 덮는다.

> **이것이 R1 §2.2-4와 §4.1의 충돌을 없앤다.** "마커"는 *감시 대상에서 뺀다*는 뜻이 아니라
> *스레드 본문을 메모리에 안 들고 있다*는 뜻일 뿐이다. 상태는 스냅샷 없이 항상 있고,
> 전이 판정은 애초에 렌더러가 하지 않는다(§2.2-4).

무엇이 무엇을 읽는가:

| 표시 | 읽는 값 | 스냅샷 필요? |
|---|---|---|
| 사이드바 상태 점 | `status` + `ask` | ✗ |
| 접힘 배지 숫자 / `‼N` | 접힌 자리들의 `status`·`ask` 집계 | ✗ |
| 자리 완료 링 | `status === 'done' && !bgActive` | ✗ |
| TopBar 「승인 대기 N」 / 「자리 밖 실행 N」 | `ask` / `busy\|\|bgActive` 집계 | ✗ |
| 읽지 않음 배지 | `unread` | ✗ |
| 토스트 본문 미리보기 | Rust `notify_tail`(200자 링버퍼) | ✗ |
| 스레드 본문·검색·diff | `snapshot` | **✓** (자리에 얹힐 때 `chats:load`) |

---

## 5. 마이그레이션 무손실 검증 (PoC 설계 — 구현은 다음 라운드)

파일: `scripts/poc-chat-unify-migrate.mjs` (2.6.2 PoC 하네스 규약과 같은 자리)

### 5.1 안전 규칙 (사용자 실홈 보호)

- 스크립트는 **`--home <경로>` 필수**. 인자 없이 돌면 즉시 종료.
- `--home`이 `os.homedir()/.agentcodegui`(정규화 비교)이면 **거부하고 종료**.
- 실홈을 쓰려면 `--clone-from-real` 전용 모드 — 실홈을 **읽기만** 하고
  `%TEMP%/ccg-unify-poc-<stamp>/`로 복사한 뒤 그 복사본을 대상으로 돈다.
- 마이그레이터 실행 시 `CCG_HOME=<대상>`을 강제로 세팅한다(`ccg-store/src/lib.rs:36-46`).
- 리포트는 `docs/design/poc-out/chat-unify-<stamp>.json`. 대화 본문은 리포트에 싣지
  않는다(해시만).

### 5.2 인벤토리 (before / after 동일하게 수집)

| 항목 | before 계산 | after 계산 | 판정 |
|---|---|---|---|
| 채팅 수 | `chats.length + Σ(세션별 내용 있는 패널 수) + sessionChats.length` | `chats.length` | 동일 |
| 메시지 총수 | 위 각 스냅샷의 `messages.length` 합 | 합 | 동일 |
| 채팅별 메시지 수 | `{키: n}` 맵 (키 = 매핑표의 새 id) | `{id: n}` | 맵 동일 |
| 마지막 메시지 해시 | `sha256(canon(messages.at(-1)))` | 동일 | 집합·맵 동일 |
| 스레드 전체 해시 | `sha256(canon(messages))` | 동일 | 맵 동일 (순서까지 검증) |
| 세션 id(resume) | `snapshot.session.id` | 동일 | 맵 동일 — **깨지면 이어하기가 죽는다** |
| cwd / picker | `{cwd, refDirs[], model, effort, mode, engine, account, codexAccount, api}` | `identityOverrides` **∪ 전역 기본**의 사영 | 맵 동일. ★ override가 비어 상속으로 가는 필드는 **전역값과 대조**한다(U10 — 비교 대상이 달라졌음을 명시) |
| 제목·잠금·색 | `{title, custom, locked ?? false, color ?? ''}` | 동일 | 맵 동일. ★ 일반/추가 채팅은 `locked`/`color`가 없으므로 **기본값 주입 후** 비교 |
| 초안 | `{draft, draftImages[]}` | 동일 | 맵 동일. ★ 멀티 패널은 **공집합**(영속 안 됨, `MultiAgent.tsx:127-137`) |
| updatedAt | 값 | 값 | 동일 — `canon()` 화이트리스트에서 **제외하지 않는다**(§5.4) |
| 한도 대기표 | `ui-prefs.limitResume.hold`(단일, key=activeChatId) | 그 chatId의 `Chat.hold` | 1건 이관 or 없음 |
| 보드 | 세션별 `{count, panelOrder, 패널i→chatId}` | `boards/<id>` | 매핑 동일 |
| 보드/채팅 목록 순서 | `multi-agent/index.json.order`, `session-chats/index.json.order` | `boards/index.json.order`, `chats-v3/index.json.order` | 순서 동일(연결 규칙 §4.2) |
| 활성 선택 | `activeChatId`, `activeSessionId` | `activeChatId`, `activeBoardId` | 대응 |
| btw 그래프 | `{child: btwOf}` (원본 id **또는 panelId 형식**) | 새 id 공간 | **재작성 실패 0건** + 간선 수 동일(원본 부재로 drop한 건은 별도 카운트) |
| 상태 | `SessionChatRecord.status`, 패널 `snapshot.status` | `index.json.statuses[id].status` | 맵 동일 |
| 파일 수 | `chats/*.json` + `multi-agent/*.json` + `session-chats/*.json` | `chats-v3/*.json` + `boards/*.json` | 기대값 계산과 일치 |

`canon()` = 키 정렬 + undefined 제거 + 숫자 정규화 JSON. 스냅샷에 타임스탬프성 필드가
있으면 화이트리스트로 제외하고, 제외 목록을 리포트에 명시한다.

### 5.3 추가로 반드시 도는 검사

1. **왕복 안정성** — 마이그레이션 후 스토어를 읽어 렌더러 블롭으로 재조립 → 다시 저장 →
   인벤토리 재수집. 1회차와 동일해야 한다. (`poc-chats-merge.mjs`가 잡던 "병합이 대화를
   지우는" 사고의 통합 포맷판)
2. **unloaded 병합** — 전 채팅을 마커로 만들어 저장 → 스냅샷이 전부 살아 있는지.
   3.0에서 대화 증발이 나올 유일한 자리다(`chats.rs:1-12`).
3. **★ 별칭 계층 왕복** (R1 누락 — 크리틱 §6) — `ma:save`(옛 블롭) → `board:*`+`chats:*` →
   `ma:get`(재조립) 왕복이 무손실인가. §6.2가 옛 렌더러를 계속 돌리겠다고 했으므로
   **여기가 대화 증발의 두 번째 자리**다. `session-wins:persist`/`hydrate`, `chats:save`/`get`도 같이.
4. **★ light 조회 등가** — (a)(b)(c) 세 부류만 스냅샷을 싣는지, **빈 채팅이 마커로 접히지
   않는지**(U12), 마커를 되보내 저장해도 손실 0인지.
5. **멱등성** — 마이그레이터 2회 실행 후 채팅 수·id 집합 불변(결정론 id + `migratedAt` 표식).
6. **크래시 내성** — 임시 디렉터리에 완성한 뒤 마지막에 rename. 중간 kill 후 **옛 3디렉터리가
   온전한지**(§4.1이 남기는 정책이므로 이 검사가 곧 롤백 검증이다).
7. **부하 픽스처** — 채팅 200개 / 멀티 세션 20개(각 6패널) / 추가 채팅 30개 합성 홈으로
   마이그레이션 시간·피크 메모리 측정(수치를 리포트에).

### 5.4 `canon()`과 `updatedAt`의 처리 (R1 미정)

`updatedAt`은 **인벤토리 항목이면서** 왕복 검사(§5.3-1)에서 갱신될 수 있는 값이다. 규칙:
- 마이그레이터는 `updatedAt`을 **절대 갱신하지 않는다**(원본 값을 그대로 옮긴다).
- 왕복 검사의 저장 경로도 `updatedAt`을 건드리지 않는다(렌더러가 명시적으로 실을 때만 바뀐다).
- 따라서 `canon()` 화이트리스트에 `updatedAt`은 **없다** — 어긋나면 진짜 버그다.
- 스냅샷 내부의 진짜 휘발 필드(예: 진행 중 타이머 값)만 화이트리스트에 넣고 리포트에 명시.

판정: 항목 하나라도 어긋나면 **비영 종료코드 + 어긋난 키 목록**. 통과 없이는 통합 스토어
코드를 머지하지 않는다.

---

## 6. IPC 통합

### 6.1 새 채널 면 (`chat:*` / `chats:*` / `board:*` / `win:chat-*`)

명령 — 전부 `chatId: string`을 받는다(`ChatRef` 없음, §1.3).

```
── 실행 (8)
chat:run            { chatId, prompt, images?, identityPatch? }        → { runId }
chat:interrupt      { chatId }                        소프트 중단 (턴만; 상주 유지)
chat:cancel         { chatId }                        프로세스째 (/clear·폴더 전환·계정 전환 전용)
chat:permission     { chatId, requestId, behavior, message? }          ★ 매칭 키 = requestId
chat:answer         { chatId, requestId, answers: string[][] | null }  ★ null = 무응답 해제
chat:respond-dialog { chatId, requestId, accepted: boolean }           ★ 폴백 다이얼로그(engine.ts:936 'ask-' 계열)
chat:bg-task        { chatId, action, id? }
chat:dispose        { chatId }                        엔진 회수 (채팅 삭제·유휴 스윕)

── 정체성·큐·원장 (5)  ※ M-LOGIC §4.3에서 이름을 가져오되 ref → chatId
chat:identity-get     { chatId }                      → ChatIdentityState
chat:identity-set     { chatId, patch, applyPolicy?, corrId? }  → IdentityVerdict
chat:identity-revert  { chatId, revision }            → IdentityVerdict
chat:queue-mutate     { chatId, op }                  → CommandVerdict
chat:force-settle     { chatId, liveItemId }          → CommandVerdict     ★강제 해제

── 스토어 (4)
chats:get           { light?: boolean }               → { version, chats, activeChatId, statuses }
chats:load          { chatId }                        → 채팅 파일 (지연 로드)
chats:save          { version, chats, activeChatId }  → void (팬아웃 저장)
chats:set-active    { chatId }                        ★ 즉시. 저장 디바운스와 무관 (§6.2 U3)

── 보드 (3)
board:get           {}                                → { version, boards, activeBoardId }
board:load          { boardId }
board:save          { version, boards, activeBoardId }

── 창 자리 (4)
win:chat-open       { chatId?, from?: 'grid'|'new'|'btw' }   창 자리 열기 (추가채팅+팝아웃+btw 통합)
win:chat-close      { chatId }
win:chat-focus      { chatId }
win:chat-list       {}                                → WindowSlotInfo[]
```

이벤트 — 봉투 하나 + 브로드캐스트.

```
chat:event      { chatId, event: EngineEvent }   메인 + 그 채팅을 보는 창들로 팬아웃
chat:identity   ChatIdentityEvent(chatId)        정체성·리비전·pending (m-logic §4.3)
chat:queue      { chatId, queue }                큐 전체 REPLACE
chat:run-state  ChatRunStateEvent(chatId)        상태기계 상태 + 라이브 원장 REPLACE
chat:verdict    { chatId, verdict }              거부/큐잉 사유(토스트·인라인 안내)
chat:status     ChatStatusLite[]                 ★ 전 채팅 경량 상태 REPLACE (§4.3)
chat:windows    WindowSlotInfo[]                 REPLACE 목록 (2.6.2 session-wins:changed)
chat:flush-req  { chatId }                       창 닫기 전 마지막 저장 요청
```

**★ 정확한 수: 명령 8+5+4+3+4 = 24, 이벤트 8 → 총 32채널.**
2.6.2의 55채널(§0)을 대체한다. R1의 "명령 18 + 이벤트 3 = 21"은 틀렸다 —
`win:chat-*` 4줄을 안 셌고 m-logic이 이미 잡아 둔 채널 5개(`chat:queue-mutate` + 이벤트 4)를
빼먹었다(크리틱 U7·인용 #6). **덤으로 `notify:event`(렌더러→main)가 사라진다**(§2.2-4) —
감시가 Rust로 가므로 렌더러가 알릴 게 없다.

`ma:event`가 이미 `{ panelId, event }` 봉투다(`protocol.ts:1133`) — `chat:event`는 그
일반화다. 창 라우팅은 WindowRegistry의 `chatId → label` 역인덱스로 `emit_to`
(`ARCHITECTURE-3.0.md` 창 시스템 절의 팬아웃 규칙 그대로). 그 역인덱스가 §2.5에서
`Chat.owner`를 대체한 바로 그 자료구조다.

> D7("모든 명령은 verdict를 반드시 돌려준다", m-logic)의 범위: **실행·정체성·큐 13개**가 대상이다.
> 스토어·보드·창 명령 11개는 순수 CRUD/창 조작이라 `{ok}` 또는 데이터를 돌려준다.
> (m-logic §3.6 명령표에 이 11개가 없는 것은 누락이 아니라 범위 밖 — 그쪽 L12 지적에 대한 답.)

### 6.2 과도기 호환 전략

`ARCHITECTURE-3.0.md` 결정 3은 "protocol.ts의 채널 이름·페이로드·의미를 보존한다"이다.
M1 빌더가 지금 이식 중인 렌더러는 **2.6.2 그대로**라 옛 채널을 부른다. 그래서:

- Rust 디스패처 레지스트리에 **별칭 어댑터**를 둔다. 핸들러는 `chat:*` 하나, 어댑터는
  옛 채널명 → 새 페이로드 변환 함수. **주소 변환은 함수 3개뿐이다**(§1.3):
  `panelIdToChat` · `wcIdToChat` · `activeChat`.

| 옛 채널 | 새 것 | 주소 |
|---|---|---|
| `claude:*` | `chat:*` | `activeChat()` |
| `ma:run/cancel/interrupt/…` `{panelId}` | `chat:*` | `panelIdToChat(panelId)` — 마이그레이션 매핑표 `ma-<sid>-<i>` |
| `session:*` (창) | `chat:*` | `wcIdToChat(sender.wcId)` |
| `talk:*` | — | 마이그레이션에서 흡수. `talk:get`은 빈 블롭, `talk:save`는 no-op |
| `ma:get/save/load-session` | `board:*` + `chats:*` | 옛 블롭 모양 재조립 |
| `ma:panel-*` | `win:chat-*` | leftover/persist는 no-op 응답 — 상태가 스토어에 있어 돌려줄 게 없다. 옛 렌더러는 빈 leftover를 무해하게 무시한다(`MultiAgent.tsx:1259-1268`) |
| `session-wins:*` | `chats:*` + `win:chat-*` | 목록·이름 변경·hydrate/persist |

**★ `activeChat()`의 진실 소스 (U3 수정).**
R1은 `claude:run → chatId = 기본 보드 slots[0]`이라고 썼다. **틀렸다.** `claude:run`은 chat id를
싣지 않고, 옛 렌더러의 대상은 **그 순간의 `activeChatId`**이며 사용자는 사이드바로 자유롭게
갈아탄다(`App.tsx:799 selectChat`). `slots[0]` 고정 매핑이면 채팅을 바꾼 뒤의 모든 실행이
**남의 `ChatRuntime`**(정체성·큐·라이브 원장·계정 CONFIG_DIR)에 붙는다 — §6.2가 내세우는
이득("M-UX가 M1을 막지 않는다")이 바로 거기서 무너진다.

R2의 규칙 셋:
1. 별칭 계층은 **세션 상태로 `activeChatId`를 들고 있다.**
2. 그 값은 **`chats:set-active`**(코어 채널, 즉시)로 갱신된다. 이식 중인 렌더러가 채팅 전환
   착지점(`App.tsx:799 selectChat` / `:746 restore` / `createChat`)에서 한 줄 부른다.
   *비용은 렌더러 3곳 한 줄씩*이고, 이건 별칭 전용 hack이 아니라 **코어에도 필요한 채널**이다
   (부팅 light 조회·토스트 라우팅·창 열기가 전부 "지금 활성 채팅"을 물어본다).
3. **`chats:save`의 `activeChatId`만으로는 안 된다** — 저장이 디바운스라 "전환 직후 전송"에서
   낡은 값이 온다. 그래서 2가 필요하다. 그럼에도 값이 없을 때(구 빌드)의 폴백:
   마지막 `chats:save`의 값을 쓰되, **그 채팅이 지금 턴 중이면 실행을 붙이지 않고
   `chat:verdict { reason: 'ambiguous_target' }`로 거부한다.** 잘못된 채팅에 붙이는 것보다
   안 되는 게 낫다(조용한 오배선 금지).

- 이벤트는 역방향: `chat:event`를 옛 렌더러가 구독한 `engine:event`/`ma:event`/
  `session:event`로도 함께 내보낸다(창 종류로 어느 이름을 쓸지 결정).
- 별칭 계층은 **통합 UI가 완성되는 라운드에 통째로 삭제**한다. 삭제 시점의 회귀 판정은
  "옛 채널 참조 0건"(grep) + **화면 인벤토리 재주행(분모 153, `ux-parity-map.md` §7)**.

---

## 7. 다른 조각이 얹힐 자리

**M9 (멀티 기준 MCP/Skill 전용 뷰).**
2.6.2의 MCP/Skill on/off는 앱 전역이다(`protocol.ts:1050-1053`). 통합 모델에서 자연스러운
층은 **채팅**(picker와 같은 층)이다. 지금 스키마에 자리만 예약한다:
`Chat.identityOverrides.mcpOverrides?: Record<string,boolean>` / `.skillOverrides?`.
전용 뷰는 `Board.chrome`의 값 추가(`'mcp' | 'skill'`)로 붙는다 — 자리 배치는 그대로 두고
각 자리에 다른 콘텐츠를 그리는 모드. 이 확장점이 `chrome` 필드를 지금 넣는 유일한 이유다.

> **주의(m-logic L7과의 접점)**: m-logic §2.3의 골든 테스트가 `RunIdentity`의 필드 집합을
> `["engine","billing","cwd","add_dirs","mode","system_prompt","output_style"]`로 얼렸다.
> `mcpOverrides`/`skillOverrides`(+ 크리틱이 지적한 API 키 지문·`dropEnvKey` 답·`codexAccount`)는
> 그 밖이다. **M-UX는 저장 스키마에 자리를 예약할 뿐이고, 정체성 축으로 승격할지는 M-LOGIC 결정**이다.
> 두 문서가 같은 라운드에 닫아야 마이그레이션 검증표(§5.2 cwd/picker 행)가 성립한다.

**M11 (한도 소진 시 계정 자동 전환).**
`useLimitResume`은 이미 `account`를 들고 재검증한다(`useLimitResume.ts:24,92-102,127-134`).
통합 후 대기표가 채팅에 붙으므로 "이 채팅의 계정을 초기화 임박순 다음 계정으로 바꾸고 재개"는
`chat:identity-set { patch: { account } }` + 기존 ready 소진 경로로 표현된다. 훅이 1벌이면
전환 로직도 1벌 — 2.6.2였다면 9곳에 배선해야 했다.

**M-LOGIC (RunIdentity).**
이 스펙은 두 가정만 공유한다: **패널 = 뷰**, **실행 상태는 채팅에 붙는다.**
`RunIdentity`의 내용(필드 목록·비교 규칙·상태기계·변경 명령의 즉시/턴후/거부 판정)은 전부
`docs/design/m-logic.md` 소관이다. 경계:

| 이 문서(M-UX) | m-logic.md(M-LOGIC) |
|---|---|
| 채팅/자리/보드의 관계, 다이얼, 저장 포맷, IPC 채널 면, 감시 집합의 정의 | RunIdentity 내용, 상태기계 전이표, 재사용/재스폰 판정, 워치독 |
| `chat:identity-*` 채널이 존재한다는 것 | 그 명령의 응답 4종과 판정 규칙 |
| `chatId`가 유일한 주소라는 것(§1.3) | 그 주소로 색인되는 `ChatRuntime`의 내부 |
| **저장 스키마는 `identityOverrides`(부분)** | **계산된 `RunIdentity`의 필드 집합** — 둘은 다른 것이다(§4.2) |

**두 문서의 합의 / R2에서 정리된 어긋남**

합의:
- `ChatRuntime`이 채팅 1개당 1개, 앱 수명 동안 지속(`m-logic.md:352-360`) = 불변식 3.
  **R2는 여기에 하나를 더 얹는다**: 그래서 감시(토스트)도 Rust가 한다(§2.2-4, 불변식 5).
- 큐·한도 대기표(`hold`)가 `ChatRuntime`에 붙는다(`:357-358`) = `Chat.queue`/`Chat.hold`.
- "패널/사이드바는 뷰다. 뷰를 옮겨도 실행은 계속된다"(`:501`, `:763`) = 불변식 1·4.

R2에서 닫은 어긋남:
- **주소**: `ChatRef{surface,id}` → **`chatId` 문자열**(§1.3, 리드 확정). m-logic §4.3·§5.6의
  `ref` 필드를 `chatId`로 바꿔야 한다.
- **구동 주체**: R1의 `Chat.owner`(렌더러 창이 드레인)는 m-logic §7.2와 충돌했다 →
  **필드 삭제, 드레인은 Rust**(§2.5). ux §7의 "합의" 목록에서 이 항목을 내렸다.
- **순수 UI 상태**(m-logic O3): 초안·이미지·큐 = 스토어(이전 없음) / 스크롤·접힘·모달 포커스
  = 창 로컬 휘발(**이관 없음**을 명시) / 키보드 스코프 = 포커스 창의 `focusedChatId`.

여전히 열린 것(M-LOGIC 쪽 결정 필요):
- `RunIdentity` 축에 API 키 지문·`dropEnvKey` 답·`codexAccount`·MCP/Skill override를 넣는가
  (크리틱 L7). 넣지 않으면 §5.2 cwd/picker 검증표의 비교 필드가 줄어야 한다.
- `interrupt`가 예약 큐를 비우는가(크리틱 L1). **M-UX의 `composer-queue` 화면 동작이 여기 달려 있다** —
  2.6.2는 Esc가 큐를 통째로 버렸다(`App.tsx:905-908 setQueue([])`).

---

## 8. 열린 문제 — 사용자에게 물어야 할 결정

R2에서 답이 바뀐 항목은 **[R2]**로 표시하고, 남은 질문만 물어본다.

1. **사이드바 구조.** 2.6.2는 3섹션(일반/멀티/추가 채팅, `App.tsx:1385-1422`). 통합 후
   후보: (a) 「채팅」 1섹션 평평 + 「배치」 1섹션, (b) 「채팅」 1섹션만 두고 배치는 헤더
   드롭다운, (c) 「채팅」 + 「배치」 + 「창」 3섹션(창은 지금 열려 있는 것만).
   → **[R2] 세 안을 나란히 그렸다**: `chat-unify-sidebar-abc.html`. 목업 본편은 (a).
2. **6→1 접힘을 얼마나 크게 알릴까.** → **[R2] 최소선은 확정했다**: 접힘 배지(+`‼N`) ·
   TopBar 요약 칩 · 사이드바 상태 점 · 토스트(§2.2-5). 남은 질문은 **"사이드바에 「이 배치에
   접힌 대화」 그룹을 따로 띄울까"** 하나다(띄우면 §8-1의 섹션이 또 늘어난다).
3. **자리 비우기의 의미.** 자리에서 채팅을 빼면 실행은 계속 도는가, 아니면 자리 이탈 =
   소프트 중단인가? → **[R2] 알림 손실 걱정은 해소됐다** — 감시가 자리와 무관해졌으므로
   자리 밖 실행도 토스트·사이드바 점·TopBar 칩으로 전부 보인다(§2.2-4). 남은 질문은
   **비용**뿐이다: 6개 돌려두고 1로 내리면 보이지 않는 곳에서 5개가 토큰을 계속 쓴다.
   R2 제안: **계속 돈다 + TopBar에 「자리 밖 실행 N」 칩**(클릭 = 목록 팝오버, 각 행에 중지).
4. **창을 닫으면 그리드로 복귀하는가.** 2.6.2는 팝아웃만 복귀하고(`index.ts:722-732`)
   추가 채팅 창은 목록에만 남는다(`sessionChats.ts:7-9`). (a) 항상 그리드 자리로 복귀,
   (b) 항상 목록에만, (c) 열 때 어디서 왔는지 기억(`from: 'grid'|'new'|'btw'` — 이미 §6.1
   `win:chat-open`에 인자가 있다). R2 제안: **(c)**.
5. **한도 대기표 복원 범위.** 2.6.2는 재시작 후 활성 채팅 것만 되살린다(`App.tsx:506-515`).
   → **[R2] 구조는 바뀌었다** — 대기표가 채팅 파일에 붙고 장전 판정은 Rust다. 그래서
   "복원"이 아니라 "재장전"이고 전 채팅이 가능하다. 남은 질문: 6개가 **동시에 자동 재개**되는 게
   맞나? R2 제안: **보이는 자리 + 열린 창 = 자동 발사 / 나머지 = `ready`만 표시하고 사용자가
   누르면 발사**(사이드바 점이 초록으로 깜빡).
6. **1 모드에서 실행 중 채팅 전환 허용?** 2.6.2는 busy·워크플로 상주 중 전환/새 채팅/삭제를
   조용히 막는다(`App.tsx:774,799,811`). 통합 모델에서는 자리가 여러 개라 "실행은 그 자리에서
   계속, 화면은 다른 채팅"이 자연스럽다. R2 제안 유지: **허용 + 실행 중 배지**
   (M-LOGIC P7 「침묵 no-op 금지」와 공동 결정).
7. **보드를 계속 목록으로 남길까.** (a) 2.6.2 멀티 세션처럼 보드 N개를 사이드바에 유지,
   (b) 보드는 현재 하나만 두고 세션 개념 은퇴. (b)는 단순하지만 "그때 그 조합" 복원이 사라진다.
   → **[R2] (a)를 전제로 §2.6의 중복 해소 알고리즘을 썼다.** (b)로 가면 §2.6이 통째로 필요 없어진다.
8. **빈 자리 기본 동작.** 빈 자리에 자동으로 새 채팅을 만들까(2.6.2 빈 패널 = 바로 대화 가능),
   아니면 「새 채팅 / 최근에서 고르기」 타일을 먼저 보여줄까? 후자가 통합 모델에 충실하지만
   클릭이 하나 는다.
9. **다이얼 1에서도 그리드 크롬을 고를 수 있나.** → **[R2] 「크게 보기」는 앱 크롬 오버레이로
   유지**하기로 정리했으므로(파리티 맵 §8 `multi-panel-expanded`) 질문이 좁아졌다:
   *`Board.chrome`을 사용자에게 노출할 필요가 있나?* 없으면 필드는 M9 전용 내부값으로 남긴다.
10. **새 채팅 모달의 운명.** 2.6.2 `NewChatModal`은 1단계 일반/멀티, 2단계 패널 수 2~6.
    통합 후 1단계는 확실히 사라진다(파리티 맵 §5-1 승인 문장). 2단계도 없애고 다이얼만 남길까?
11. **★[신규] 읽지 않음 배지를 만들까.** 2.6.2엔 없다(사이드바는 상태 점뿐,
    `styles.css:336-341`). 자리가 6개가 되면 "내가 안 본 답변"이 실제로 생긴다.
    `ChatStatusLite.unread`는 스키마에 자리만 잡아 뒀다 — 표시할지는 결정 필요.
12. **★[신규] 읽기 배율 키 합류.** 2.6.2는 4개(`chat.zoom`·`multi.zoom`·`multi.expand.zoom`·
    `session.zoom`). 통합 후 3개(`zoom.ide`/`zoom.grid`/`zoom.window`)로 접히는데,
    `zoom.window`가 **추가 채팅 창(`session.zoom`)과 팝아웃 창(`multi.expand.zoom`) 중
    어느 값을 승계**할지 골라야 한다(둘 다 쓰던 사용자는 하나를 잃는다).

---

## 9. 목업

`docs/design/mockups/` (정적 HTML, 2.6.2 다크·아크릴 톤 토큰 그대로 — `styles.css:7-84`)

| 파일 | 내용 | R2 |
|---|---|---|
| `chat-unify-dial.html` | 다이얼에 1이 추가된 모습 — 1↔6 전 상태, 접힘 배지, 팝오버 | |
| `chat-unify-1-ide.html` | 1 모드 = 기존 IDE 레이아웃 | **창 컨트롤 추가**(장면 간 헤더 구성 통일) · **주석을 창 밖 여백으로** 이동(콘텐츠 가림 해소) |
| `chat-unify-grid2.html` | 2 그리드 + 유령 셀 | |
| `chat-unify-grid4.html` | 4 그리드 (자리 스코프 승인 카드 포함) | |
| `chat-unify-collapse.html` | 6→1 전환 직후 — 사이드바 + 접힘 배지 + 팝오버 | |
| **`chat-unify-window.html`** | **창 자리(WindowShell)** — 추가 채팅 창 + 팝아웃 창이 하나가 된 모습, 창 크롬(뷰어·라이트박스) 범위, 그리드 쪽 유령 셀 | **신설** (§3.3이 가장 크게 바꾸는 화면인데 R1엔 그림이 없었다) |
| **`chat-unify-fold-alert.html`** | **접힌 자리에서 승인/질문이 떴을 때** — 배지 `‼2` · TopBar 「승인 대기 2」 칩 · 팝오버 정렬 · 사이드바 대기 점 · 토스트 | **신설** (§2.2-5) |
| **`chat-unify-sidebar-abc.html`** | **사이드바 (a)(b)(c) 3안 나란히** | **신설** (열린 문제 ①) |
| `chat-unify.css` | 공용 스타일 (2.6.2 토큰 사본) | 신규 클래스 몇 개 추가 |

밀도 기준: 실물급. 사이드바 항목 높이·폰트 크기·워크바 칩 수·컴포저 구성은 2.6.2 값을
따랐다("여백만 넓힌 깔끔함"은 사용자가 기각).

여전히 안 그린 것(다음 라운드): 워크플로 도크 확장 카드, 백그라운드 셸 칩 팝오버, q-mini.

---

## 10. 크리틱 R1 인용 오류 — 대조표

크리틱이 지적한 M-UX 인용 오류 7건을 전부 고쳤다. (#1·#2는 m-logic 소관이라 여기 없다.)

| # | R1이 적은 것 | 실제 | R2 |
|---|---|---|---|
| 3 | 한도 훅 `PanelWindow.tsx:154·233` | 훅은 **`:289`**. `:154`는 `autoResume` pref useState, `:233`은 `/clear` 분기의 `setHold(null)` | §0 표 수정 (총 9개라는 수는 맞다: App 492 + MA 1629-1634 + SW 648 + PW 289) |
| 4 | `useTurnNotifyList`(`notify.ts:31`) | **`:34`** (31은 빈 줄) | §2.2-4 수정 |
| 5 | "`status`는 저장 시 얼려 오는 규약(`sessionChats.ts:29`)" | **`:28`** (`:29`는 `cwd`) | §4.2·§4.3 수정 |
| 6 | "명령 18 + 이벤트 3 = 21채널" | 블록 자체가 명령 22개였고, m-logic 채널까지 세면 더 는다 | §6.1에서 **명령 24 + 이벤트 8 = 32**로 다시 셌다 |
| 7 | "2.6.2는 **활성 채팅 1개만** 스냅샷을 실었다(`chats.ts:50-80`)" | 활성 **또는 스냅샷이 빈** 채팅을 유지한다(`chats.ts:70-75`, `chats.rs:97-104`) | §4.3에 (c) 규칙으로 **복원** — 이 예외가 `App.tsx:783` 빈 채팅 재사용을 받친다 |
| 8 | `Chat`의 `locked/color`가 "2.6.2 `PanelMeta:113-125` **승계**" | 일반 채팅(`ChatMeta`, `App.tsx:57-73`)엔 `locked`·`color`·`api`가 **없다** | §1.2에 「신규 필드」로 표기 + §4.2에 **기본값 주입** 명시 |
| 9 | "`btwOf`가 가리키는 원본 id도 **같은 매핑표**로 다시 쓴다" | 멀티 btw의 `btwOf`는 **panelId 형식** `${sessionId}::${slot}`(`MultiAgent.tsx:1346`) — 키 형식이 다르다 | §4.2에 `rewriteBtwOf()` 2단계 파서 + drop 카운트 |
| 10 | "`MultiAgent.tsx:213 blankSession`" | 함수는 **`:207`** (`:213`은 그 안의 panels 줄) | §2.4 수정 |

그 외 R1의 인용(수십 건)은 크리틱이 "전부 정확"으로 확인했다 — `optsMatch`·`armHoldIdle`·
`activeRunId` 가드·`tryNotifReplay`·`snapshotForPersist`·`useLimitResume` 3규약·팝아웃
소유권 이전 4지점. R2는 그것들을 그대로 유지했다.
