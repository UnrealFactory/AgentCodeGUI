# 설계 크리틱 R2 — M-UX 「채팅 통합」 R2 / M-LOGIC 「상태기계」 R2

판정 대상
- `docs/design/ux-chat-unify.md` · `docs/design/ux-parity-map.md` · `docs/design/mockups/` (M-UX R2, `2ced4fa`)
- `docs/design/m-logic.md` · `docs/design/m-logic-replay.md` (M-LOGIC R2, `d6be21f`)

대조 기준: 얼린 2.6.2 소스(`src/`, 읽기 전용), `crates/ccg-store/`,
`docs/protocol-claude-cli.md`, `docs/screen-inventory.md`, `docs/critic/design-r1.md`.
이 문서의 모든 지적은 파일:줄로 확인했다. 사영표는 **기계 대조**했다(§3.0).

---

## 0. 판정

| 스펙 | 판정 | 한 줄 |
|---|---|---|
| **M-UX 채팅 통합 R2** | **보완**(구조 합격 / 리드 결정 3건 선행) | R1의 최대 격차(사영 대장 부재·U1 충돌)는 **실제로 닫혔다**. 남은 건 스펙 안의 구멍이 아니라 **M-LOGIC과의 충돌 3건**(N4 상속↔물질화 · N5 ChatStatusLite 쓰기 주인 · N10 해시 비교 계산 불가) |
| **M-LOGIC 상태기계 R2** | **보완**(간판 3건 닫힘 / 구현 전 4줄) | L1·L2·L5는 말이 아니라 **구조로** 닫혔다(프로브 등급·불변식 11/12·24행 전수 사영은 실물 대조 통과). 남은 건 새로 생긴 4건 — N1 워치독 루프의 상태 덮어쓰기 · N2 패치 입도가 L3를 되살림 · N3 재생 #4가 SUT와 어긋남 · N8 표의 새 빈칸 |

R1 대비: **지적 63건 중 해소 57 · 부분 6 · 미해소 0 (90%)**. 새 구멍 16건(치명 0 · 높음 4).
두 스펙 모두 "M3 착수 전 닫혀 있어야 한다"는 자기 기준에 **한 라운드 거리**까지 왔다.

---

## 1. R1 지적 전수 대조

### 1.1 M-UX (U1~U12)

| # | R1 지적 | 판정 | 근거 / 남은 것 |
|---|---|---|---|
| U1 | 접힌 채팅의 알림·상태가 죽는다 | **부분** | 감시자 Rust 이관은 **성립한다**(아래 §1.3 추적). 마커 재정의(`ChatStatusLite`)로 §2.2-4↔§4.1 충돌은 소멸. 남은 것 = **영속 경로에 주인이 없다**(N5) |
| U2 | `requestId` 버림 | **해소** | `chat:permission/answer`에 `requestId` 복원, `answers: string[][]｜null` 복원(`protocol.ts:563-575` 대조 ✓), `chat:respond-dialog` 신설. 인용은 어긋남(N16) |
| U3 | `claude:run → slots[0]` | **해소** | `activeChat()` + `chats:set-active` 즉시 채널 + 값 부재 시 `ambiguous_target` 거부. 조용한 오배선 경로 제거 |
| U4 | 앱 크롬을 자리 안으로 | **해소** | 코드가 스펙을 이겼다 — `App.tsx:1432-1466`(왼쪽 칼럼) · `:1614`(변경파일) · `:1626`(Git) 전부 mode 밖. §3.1이 앱 크롬으로 되돌렸고 파리티 맵 §4가 같은 답 |
| U5 | `Chat.owner` 충돌 | **해소** | 필드 삭제 + `WindowRegistry` 역인덱스. O3의 "순수 UI 상태"를 초안=스토어 / 스크롤·포커스=창 로컬 휘발로 분해 — 두 문서가 같은 문장 |
| U6 | 불변식 2의 범위 | **해소** | "동시에 *보이는* 자리 최대 1개" + `activateBoard()` 결정론 중복 해소 |
| U7 | IPC 산수 | **해소** | 8+5+4+3+4=24 · 이벤트 8 = **32** — 블록을 직접 세어 일치 ✓ |
| U8 | 다이얼 축소가 재정렬·정리 의미를 바꾼다 | **부분** | 드래그를 보이는 자리로 한정한 건 옳다. 그러나 2.6.2 정리는 **5개**다(`MultiAgent.tsx:1819-1828`: focusedSlot·renamingSlot·**expandedSlot·openFile·openSub**) — R2는 앞 둘만 덮었다(N9). "접힘 집합을 바꾸는 동작은 딱 둘"도 이미 깨져 있다(N13) |
| U9 | 뷰어發 대상 미정 | **해소** | `viewerTarget{chatId,path,from}` + 대상 채팅 칩 + 강제 닫힘 제거(`App.tsx:1157` 대조 ✓) |
| U10 | 전역 pref의 채팅 물질화 | **부분(역행 위험)** | 표는 생겼지만 채택한 답("미지정=전역 **상속**, RunIdentity는 계산")이 m-logic §2.4(물질화)와 **정면 충돌**한다 → P1d 부활(N4) |
| U11 | `version:3`은 가드가 아니다 | **해소** | `chats-v3/` 새 디렉터리 + 옛 디렉터리 보존 + 재마이그레이션(멱등) |
| U12 | 빈 채팅 규칙 반쪽 | **해소** | light (c) 예외 복원 — `chats.ts:70-77`·`chats.rs:97-104` 대조 ✓, `App.tsx:783` 재사용 판정이 다시 받쳐진다 |

### 1.2 M-LOGIC (L1~L12)

| # | R1 지적 | 판정 | 근거 / 남은 것 |
|---|---|---|---|
| L1 | 중단이 큐를 안 비운다 | **해소** | T13/T23/T34 액션 + §3.6 셀 + `queue.restore` 행 + §7.4. 2.6.2 대조 ✓(`App.tsx:901-909`의 `setQueue([])`, Esc가 같은 경로 `:915-928`). 파리티 미표기 1건(N14) |
| L2 | 워치독이 P8에서 발화 안 함 | **해소(간판 복구)** | 프로브 ⓪ `CAN_SAY_ALIVE=false`를 **타입**으로, 불변식 11/12를 러너 자동 검사로. 7b 시각표가 이제 성립(§5 재검 ✓). 새 구멍 셋은 별건(N1·N6) |
| L3 | deferred 전체 교체가 폴백을 되돌림 | **부분** | `Staged{patch, base_revision, preview}` + 착지 재정규화는 옳다. 그러나 패치 입도가 `engine`(=model+effort 통째)이라 **effort만 바꿔도 폴백 model이 되돌아간다**(N2). 재생 #2/2b는 billing 패치만 잠근다 |
| L4 | 폴백 3경로 합류 없음 | **해소** | `fallback_armed`+`observed_model` 2상태로 3경로 수용, `respond_dialog` 행 신설. 2.6.2 3경로 대조 ✓(`engine.ts:999`·`:1334-1338`·`:1659-1675`). 한 턴 2전환에선 arm이 카운터보다 좁다(경미) |
| L5 | 전이표가 프레임 절반만 소화 | **해소** | §8.4 실 카운트 **24행**(`protocol-claude-cli.md:1525-1548` 직접 셈 — R1의 22가 틀렸다) → §3.7 사영 빈칸 0 ✓. A36+B22=58도 표 행 수와 일치 ✓ |
| L6 | 한도 장전 근거 미관측 | **해소** | 근거 2순위 + 신뢰도 표기 + O14. 재생 픽스처에 `assumed` 등급 신설(정직) |
| L7 | RunIdentity 스폰 축 4개 누락 | **해소(문서 내)** | P1e 신설 + `key_fp`·`drop_env_key`·`ToolPolicyAxis`·`Codex{account}` 흡수 + 골든 목록에 `tools`. 2.6.2 대조 ✓(`engine.ts:762`·`:846-852`·`:758-761`·`:874-876`). **M-UX 쪽 미반영**(§4) |
| L8 | 와이어의 싼 경로 미사용 | **해소** | O15 + M3 라이브 1턴 절차 + 실패 시 "영구 제약" 문서화 규약 |
| L9 | `Resident` interrupt 파리티 후퇴 | **해소(단 빈칸 생성)** | ✅로 복원 — 2.6.2 대조 ✓(`App.tsx:906` else 가지, `MultiAgent.tsx:1025-1028`). 대응 전이 행이 없다(N8) |
| L10 | LiveKind 3종은 렌더러 리듀서 | **해소** | 소유 계층 열 + O2를 §11-2.5 선행 조건으로. `session.ts:78`·`:86` 대조 ✓ |
| L11 | 불변식 #3이 정상 동작을 잡는다 | **해소** | T19/T19b 새 `run_id` + 발급 지점 4곳 고정 + 러너가 발급 지점을 검사 |
| L12 | 명령표 8상태 | **해소** | `Ended`가 명령을 못 받는 이유(T26 즉시 이탈·이벤트 열거형에 없음)를 각주로. UX §6.1이 D7 범위(13개)를 명시해 짝이 맞는다 |

### 1.3 U1 추적 — 감시자 Rust 이관은 정말 성립하는가

지시대로 설계를 따라갔다. **판정: 감시·전이 판정은 성립한다. 영속·부팅 복원은 구멍이 하나 있다.**

| 단계 | 성립? | 근거 |
|---|---|---|
| 전이 판정에 스냅샷이 필요 없다 | ✅ | 2.6.2가 읽던 값(`notify.ts:40`: `busy`·`pendingPermission`·`pendingQuestion`)이 전부 상태기계 안에 있다(`AskCard` 원장·`busy` 원시 상태) |
| 감시 집합이 후퇴하지 않는다 | ✅ | 2.6.2 = 활성 세션 6패널(`MultiAgent.tsx:891-898`) + 본채팅 1(`App.tsx:716`) + 열린 창. 비활성 세션 패널은 마운트 자체가 없어 감시 밖 → 3.0(런타임 있는 전 채팅)은 상위집합 |
| `prev` 오탐이 죽는다 | ✅ | `notify.ts:35,42` — `prev`가 컴포넌트 수명에 묶여 첫 관찰을 건너뛰던 구조가 사라진다 |
| 미리보기 한 줄 | ✅(경미) | `notify_tail` 링버퍼로 대체 가능. 도구만 돈 턴에서 2.6.2(`lastAssistantText`가 스냅샷을 거슬러 올라감)보다 빈 미리보기가 날 수 있다 — 무해 |
| 마커의 표시값 | ✅ | `ChatStatusLite`. 2.6.2가 이미 하던 두 규약의 일반화가 맞다 — `sessionChats.ts:28`(status 얼려 저장) · `maStore.ts:94`(마커에 `panelStatuses`) 대조 ✓ |
| **영속 시점** | ❌ | `chats:save {version, chats, activeChatId}`에 **statuses가 없다**(§6.1). `chats-v3/index.json`은 렌더러 팬아웃이 쓰는 파일인데 statuses의 진실은 Rust다 → **쓰는 주인·시점·경합 규약이 없다**(N5) |
| **크래시 시 유실** | ⚠️ | 부팅 강제(`busy=false·ask=none·bgActive=false`) 덕에 유령 알약은 안 뜬다. 그러나 `hold`·`queued`가 index.json(statuses)과 `<chatId>.json` **양쪽에** 있어 반쪽 쓰기 후 어느 쪽이 이기는지 미정 |
| **부팅 복원 경로** | ⚠️ | 감시 집합 정의("큐·hold를 들고 있는 채팅")대로면 부팅에 그 채팅들의 `ChatRuntime`을 세워야 하는데, 부팅은 light 조회라 큐/hold를 **statuses에서만** 알 수 있다. N5가 안 닫히면 재시작 후 대기표가 조용히 안 살아난다 |
| `unread` | ⚠️ | 마커 채팅에선 재계산이 불가능하다(스레드가 없다 = 마커의 정의). statuses가 어긋나면 되돌릴 길이 없음 |

### 1.4 인용 오류 · ChatRef · 마이그레이션 · 목업

| 묶음 | 판정 |
|---|---|
| 인용 오류 10건 | **10/10 수정.** 재대조 ✓ — `PanelWindow.tsx:289` · `notify.ts:34` · `sessionChats.ts:28` · 32채널 · light (c) · `App.tsx:57-73`(ChatMeta에 locked/color/api **없음** ✓) vs `MultiAgent.tsx:113-125`(있음 ✓) · `MultiAgent.tsx:1346`(btwOf=panelId) · `:207`(blankSession). 자체 발견 3건(`App.tsx:716`·`:1465`·`:1157`)도 전부 실물과 일치 ✓. m-logic 자체 발견 3건(`session.ts:219-221`/`:210-217` · `engine.ts:1185-1196` · §8.4 24행)도 ✓ |
| **신규 오기 1건** | ux §6.1 "`engine.ts:936` 'ask-' 계열" — `:936`은 dialogKind 가드이고 `ask-` 접두 id는 **`:948`**(질문 경로는 `:802`). 게다가 2.6.2는 이 다이얼로그를 **`questionWaiters`로 받는다**(`:950`) → N16 |
| `ChatRef` 치환 | **양쪽 완료.** grep 결과 남은 `ChatRef` 언급은 전부 "삭제했다"는 서술문뿐, 페이로드 필드에 `ref:` 0건 ✓ |
| 마이그레이션 누락 13건(§6 11필드 + 검증 2구멍) | **13/13 반영.** 보드/추가채팅 순서·hold·api.mode·outputStyle·limitResume.on·empty/draft/updatedAt·`rewriteBtwOf` 2단 파서 + drop 카운트·panelLeftovers "이관 없음"·읽지 않음 "해당 없음"·별칭 왕복(§5.3-3)·`canon()`의 updatedAt 확정(§5.4) |
| 목업 미흡 5건 | **4.5/5.** 창 컨트롤 ✓(`chat-unify-1-ide.html:83`) · 주석 이동 ✓ · 창/접힘알림/사이드바 3안 3장 신설 ✓(제목·본문 확인) · 글↔그림 불일치는 글을 고쳐 해소 ✓. 워크플로 도크 확장·셸 칩 팝오버·q-mini는 여전히 미작성(문서가 자인) |
| R1 §8 지시 2건 | **둘 다 이행.** 사영표는 **기계 검증 통과**(§3.0). 워치독 3부(프로브 등급 · 7b 첫 빨간 테스트 §11-2 · L1·L3 동시 처리)도 이행 — L3만 반쪽(N2) |

---

## 2. 워치독의 새 함정 사냥

### 2.1 긴 도구 실행(수 분짜리 Bash) — 정상 턴이 unverified로 오판되는가

와이어 흐름으로 추적했다(`protocol-claude-cli.md` §8.4 · §5.11).

```
assistant tool_use(Bash)  → F7  → 원장에 RunningTool 등록 (턴 수명, lease 없음)
      … 4분간 프레임 0 …            ← 백그라운드화 안 한 Bash는 정말 아무 프레임도 안 낸다
user tool_result          → F11 → RunningTool 정착
```

- **턴 자체는 안전하다.** `Streaming`에는 스트림 수준 타임아웃이 없고(T3는 `Starting` 20s 전용),
  `RunningTool`·`StreamingMsg`·`Thinking`·`AskCard`는 §5.4-b 자격표에서 **프로브 0개 · lease 스트림 종속 ·
  hard_limit 없음**이다 → 워치독이 손대지 않는다. **오판 없음 ✓**
- 단, 루프가 도는 대상이 `ledger.evidence_bearing()`인데 **그 함수의 정의가 문서에 없다.**
  "턴 수명 항목은 제외"는 자격표에서 *유추*될 뿐이다. 한 줄로 못 박을 것.
- **위험은 옆에 있다**: 같은 턴에 워크플로/셸이 떠 있으면 그것들은 lease를 가진 항목이라
  4분 침묵에 리스가 만료된다. 이때 §5.4-c의 마지막 블록이 터진다 → **N1**.

### 2.2 REPLACE 신선도 60초가 조용한 정상 상태를 죽이는가

**죽이지는 않는다. 대신 프로브 ②가 Alive를 낼 수 없는 죽은 경로가 된다.**

근거 사슬(전부 실물):
1. `background_tasks_changed`는 **멤버십이 바뀔 때만** 온다 — emitter `cgo(e)`는 tasks 변화에서만 호출
   (`protocol-claude-cli.md:955-975`, `engine.ts:1385-1425`). 주기 송신이 아니다.
2. F13의 리스 효과가 "멤버십 = 최상위 증거"이므로 그 REPLACE가 **`last_evidence`를 갱신**한다(프로브 ① 목록에 F13이 있다).
3. 따라서 리스가 만료되는 순간(≥90s 후)의 `replace_seen_at`은 **항상 90초 이상 과거** = 신선도 창 60s 밖 = stale.

→ **어떤 `LiveKind`에서도 ②는 Alive를 못 낸다.** 문서 자신의 트레이스가 그걸 보여준다:
7b(`t=90s ② … stale → Unknown`) · 6c(`② REPLACE 신선도 60s 초과 → stale → ④`).
그런데 §5.4-b의 LiveKind×프로브 표는 `Workflow`/`BgShell`/`BgAgent`의 ② 칸에 ✓를 찍어
"Alive 경로가 2~4개"로 읽히게 한다. **실효 Alive 경로는 ③(워크플로)과 ④(mtime)뿐**이다 → N6.

부수 효과 둘:
- **출력이 없는 정상 셸**(예: 응답 대기 중인 서버, `sleep`)은 ④도 못 받는다 → 90s에 게이팅 상실,
  30분에 `Watchdog` 정착("응답이 없어서 정리됨"). 2.6.2는 알약을 유지했다.
  R2가 §5.4-d 표에서 "진짜 도는 dev 서버는 mtime이 살린다"고 한 방어는 **파일을 쓰는 작업에만** 유효하다.
  타이밍 상수는 전부 미실측이라고 §8.1-2가 자인했으니, 이 케이스를 O16 옆에 명시할 것.
- **프로토콜이 문서화한 진짜 능동 프로브를 안 쓴다**: 이미 돌고 있는 세션에 `initialize`를 다시 보내면
  CLI가 **현재 `background_tasks_changed` 스냅샷을 (비어 있어도) 밀어 준다**
  (`protocol-claude-cli.md:466-469`, `sdk.d.ts:3131` JSDoc). 이건 ②를 **신선하게 만들 수 있는 유일한 수단**이고
  Alive/Dead를 둘 다 낼 자격이 있는 프로브다. R2의 프로브는 전부 수동 관측이라 이 카드를 버렸다.
  이걸 쓰면 "30분 hard_limit"의 절반은 필요 없어진다.

---

## 3. 파리티 사영표 spot-check

### 3.0 기계 대조 — "미배정 0"은 참이다

일회성 스크립트로 인벤토리의 `| \`id\` |` 행과 사영표 행을 집합 비교했다.

```
인벤토리 id 행 161  |  사영표 id 행 156
인벤토리에만 있는 것: main-window · session-window · toast · tray   (= 「표면 표기」 범례)
사영표에만 있는 것: 0
중복 id: panel-window (범례 1행 + §9 실화면 1행)
절별: 3 · 42 · 12 · 14 · 26 · 10 · 19 · 17 · 5 · 8 = 156
```

→ **161 − 5(범례) = 156 · 미배정 0 · 유령 행 0.** R2의 통계·분모(153 = 156 − 2 Verse − 1 사라짐)는 맞다.
(범례가 5행인데 누락이 4건인 이유는 `panel-window`가 범례·실화면 양쪽에 있기 때문 — 산수가 우연히 맞은 게 아니라 정확히 맞다.)

### 3.1 어려운 20행 — 행선지가 실제로 성립하는가

| # | 행 | 사영표 | 2.6.2 실물 | 판정 |
|---|---|---|---|---|
| 1 | `viewer-selection-ask-bar` | A+Aw, "2벌 → 전 자리로 확장" | `App.tsx:1649` · `SessionWindow.tsx:884`만 `onAskSelection` 있음. `MultiAgent.tsx:1918`·`PanelWindow.tsx:528`엔 없음 ✓ | ✅ |
| 2 | `viewer-ask-panel` | A+Aw, 대상=`viewerTarget.chatId`, 닫지 않음 | `App.tsx:1157 setOpenFilePath(null)` 실재 ✓ | ✅ |
| 3 | `panel-window-viewer` | Aw | `PanelWindow.tsx:528` FileModal(질문 바 없음) ✓ | ✅ |
| 4 | 코드 뷰어 4벌 | A+Aw | 1640·879·528·1918 전부 확인 ✓ | ✅ |
| 5 | `subagent-modal` | **S** | 1663·1928·888·531 — 전부 **패널 밖 최상위** 렌더 | ⚠️ **N7** (ux §3.1은 같은 카드를 「창 크롬 3종」에도 넣었다 — 두 문서가 아니라 **한 문서 안**의 모순) |
| 6 | `image-lightbox` | A+Aw | 1655·1934·891·533 ✓ | ✅ |
| 7 | `folder-switch-dialog` | S(=needs_confirm 표시) | 1679·1906·868·524 ✓ | ✅ |
| 8 | `changed-files-modal` | A, 대상=viewerTarget??포커스 | `App.tsx:1613-1620` 삼항(`mode==='multi' ? multiExp.files : state.files`) ✓, 창엔 없음 ✓ | ✅ |
| 9 | `git-changes` | A, 폴더=포커스 자리 | `App.tsx:1623-1629` 주석·`multiExp.tick` ✓ | ✅ |
| 10 | `explorer-tree` | A, 2렌더+mode 삼항 | `App.tsx:1437-1466` ✓ | ✅ |
| 11 | `chat-header` | A(TopBar)+G+W, "3벌이 맞다" | `Chat.tsx:1428 .chat-head`(App·SW 공용) · `MultiAgent.tsx:484 .ma-p-head` · `PanelWindow.tsx:69/82/454 .pw-head` = 3 ✓ | ✅ |
| 12 | `limit-hold-bar` | S, 3렌더/9훅 | 렌더 `App.tsx:1573`·`MA:711`·`SW:831` ✓ / 훅 `App:492`·`MA:1629-1634`·`SW:648`·`PW:289` = 9 ✓ | ✅ |
| 13 | `btw-dock` | S, 2 | `App:1667`·`MA:750` ✓ (PW는 PanelView 재사용이라 표면은 4 — 워크플로 도크 행처럼 "(4 표면)" 표기가 빠졌다) | ✅(경미) |
| 14 | `workbar-shell-pop` | S | WorkBar 공용 부품, `chat:bg-task` 1채널로 접힘 ✓ | ✅ |
| 15 | `composer-queue` | S, 드레인=Rust | `App.tsx:165` state · `PanelMeta.queue`(`MA:124`) ✓. 중단 시 비움은 L1로 확정 ✓ | ✅ |
| 16 | `multi-panel-ghost-popped` | G, 유령이 chatId | `MultiAgent.tsx:1859` "실물 PanelView는 오버레이 카드에" ✓ | ✅ |
| 17 | `multi-panel-expanded` | **A(오버레이)** | 오버레이가 **실물 PanelView를 담는다**(`:1859` 주석) | ⚠️ **N15** — ChatSurface를 담는 4번째 호스트인데 §3.1 껍데기 3종에 없다 |
| 18 | `multi-reorder` | G+A(Board.order) | `MultiAgent.tsx:884-886` ✓ | ⚠️ **N9**(정리 규칙 3개 누락) |
| 19 | `toast-aggregate` | A, 업서트 키=chatId | 실제 키 `` `${surface}:${id}:${sub}` ``(`notifyToast.ts:148`) ✓ | ✅ |
| 20 | `session-window-*` / `panel-window` | W(+S), 2벌→1벌 | SW/PW에 Explorer·Git·Settings import **0건** 확인 ✓ → Aw 3종 범위 근거 성립 | ✅ |

**spot-check 결론**: 20행 중 17행 성립, 3행이 표 안팎 모순(N7·N15·N9).
"미배정 0"과 이중 배선 14갈래의 수는 실물과 일치한다 — 이 표는 **파리티 게이트로 쓸 수 있다.**
다만 §5 제목("전부 앱 크롬 **단일 인스턴스**")과 §7 회귀 판정("렌더 지점 각 **2개**(메인+창)")이
서로 다른 말을 한다 — 게이트 문장은 §7 쪽으로 통일할 것.

---

## 4. 문서 간 정합 — 남은 어긋남

| # | 어긋남 | 상태 |
|---|---|---|
| **X1** | **`chatId` 치환** | ✅ 양쪽 완료. `ref:` 필드 0건, 어댑터도 함수 3개로 동일 서술 |
| **X2** | **L1(중단 시 예약 큐)** | ⚠️ **UX가 낡았다.** m-logic R2 §7.4가 "비움+안내+되돌리기"로 **확정**했는데 ux §7 「여전히 열린 것」에 *"`interrupt`가 예약 큐를 비우는가(크리틱 L1)"*가 그대로 남아 있다. 커밋 순서상(d6be21f → 2ced4fa) UX가 나중인데 반영이 안 됐다 |
| **X3** | **L7(RunIdentity 스폰 축)** | ⚠️ **UX가 낡았다.** m-logic은 이미 `tools`(skillOverrides·deniedMcp)를 골든 목록에 넣고 `key_fp`·`drop_env_key`를 흡수했다. ux §7은 *"정체성 축으로 승격할지는 M-LOGIC 결정"*이라고 미결로 적었다 |
| **X4** | **UX §5.2 검증표 ↔ O12(해시 하나로 비교)** | ❌ **정합하지 않는다.** §5.2는 여전히 원시 필드 맵(`{cwd, refDirs[], model, effort, mode, engine, account, codexAccount, api}`)을 비교하고, 심지어 "상속 필드는 **전역값과 대조**"라는 행까지 더했다. O12의 규약("2.6.2 레코드 → RawIdentity → normalize() → hash 하나")으로 갈아끼우려면 이 행이 통째로 바뀐다 |
| **X5** | **`identityOverrides`의 타입** | ❌ ux §1.2는 `Partial<RunIdentity>`라 하고 §4.2 매핑은 `.model/.effort/.mode/.engine/.account/.codexAccount`로 **평평하게** 쓴다. m-logic의 `RunIdentity`엔 그런 필드가 없다(모델·effort는 `EngineAxis` 안, 계정은 `BillingAxis` 안). 부분 지정용 타입은 m-logic이 이미 `RawIdentity`로 갖고 있다 → **ux는 `Partial<RawIdentity>`라고 써야 한다.** 파리티 맵 §2 `workbar-context-pop-api` 행만 `identityOverrides.billing`이라 UX 안에서도 갈린다 |
| **X6** | **override 필드 이름** | ⚠️ ux `mcpOverrides`/`skillOverrides` ↔ m-logic `tools.denied_mcp`/`tools.skill_overrides`. M9 확장점을 예약한 자리라 지금 이름을 맞춰 두는 게 싸다 |
| **X7** | **전역 pref의 의미** | ❌ **N4** — ux "미지정=전역 상속, RunIdentity는 계산" ↔ m-logic §2.4 "전역은 새 채팅 기본값, 채팅에 스냅샷 + 전역 변경은 명령을 탄다". 이건 이름 문제가 아니라 **동작이 반대**다 |
| **X8** | `ChatRuntime`의 수명 | ⚠️ m-logic §3.1 "채팅 1개 = 인스턴스 1개, 앱 수명 동안" ↔ ux §2.2-4 "한 번이라도 스폰됐거나 큐·hold를 든 채팅". 후자가 현실적이지만, 그러면 `chat:status`(전 채팅 REPLACE)를 **런타임 없는 채팅에 대해 누가 만드는가**가 빈다(N5와 같은 뿌리) |
| **X9** | 승인/질문/다이얼로그 카드 종류 | ⚠️ ux가 `chat:respond-dialog`를 별 채널로 뺐는데, m-logic §5.6의 `live[]`는 `kind: AskCard` 하나뿐이라 카드가 자기 종류를 못 알린다. 2.6.2는 셋을 같은 `questionWaiters`로 받았다(`engine.ts:950`) |

**O12는 지금 상태로 양 문서에 반영 가능한가**: **아니다 — 한 줄이 더 필요하다.**
`RunIdentity::normalize()`는 폴더 없음·미로그인·키 없음에서 **실패**한다(§2.3). 마이그레이션 대상에는
지워진 `cwd`, 로그아웃된 계정, API 모드였지만 키가 사라진 채팅이 실제로 섞인다. before/after 해시 비교가
그 채팅들에서 **정의되지 않으므로**, O12를 채택하려면 "정규화 실패 시 비교 키 = `RawIdentity`의 정준
직렬화 해시(=`unresolved` 표식)"처럼 **실패 경로의 비교 규약**을 같이 정해야 한다 → N10.

---

## 5. 재생 8조합 종이 재생 재검

R2와 **같은 방식**으로 다시 돌렸다(§3.3 A/B + §3.4 착지 + §3.6 판정표 + §5.4 루프만 사용).

| # | R2 주장 | **재검** | 근거 |
|---|---|---|---|
| 1 / 1b | ✅ 온전 | **✅ 동의** | #1: deferred → 착지 재정규화 → 원장 빔 → OnIdle close → Idle → 다음 send는 ColdStart. 단언이 사실과 일치. #1b: 셸 1개 → Resident{LiveItems} → T17 `IdentityChanged[billing]` ✓ |
| 2 / 2b | ✅ 온전 | **✅ 동의(단 잠금 부족)** | §6.2 경로 B'→C' 순열이 리비전 1개를 낸다 ✓. 2b의 `driftedFields=["engine"]`도 계산이 맞다. **그러나 두 시나리오 모두 patch가 `billing`뿐**이라 N2(engine 패치가 폴백을 삼키는 경로)를 못 잡는다 → **2c 필요** |
| 3 | ✅ 온전 + 한계 명시 | **✅ 동의** | 한계(O2·하네스는 Rust만) 명시는 정직하다 |
| **4 / 4b / 4c** | ✅ 온전 | **❌ 단언이 SUT와 어긋난다** | `close_policy=on_idle`인데 §3.4는 **매 턴 종료마다** 원장 빔 → `close_input()` → Terminating이다. 그러면 §7.2의 "연속 동일 정체성 배칭"(`fable 1스폰에 2·3 연속 주입`)이 **불가능**하다 — T16 주입은 `Resident`에서만 난다. 실제 스폰 수는 **4**(최초+resume+2+3)인데 단언은 "총 spawn 3 / exit 3"이다. 4b·4c는 성립 ✓ |
| 5a / 5b | ✅ 온전 | **✅ 동의** | `StreamClosePolicy`가 픽스처와 SUT를 화해시키는 건 옳은 축 도입. 5a는 `keep_open`에서 T16 2회, 5b는 ColdStart+`--resume` ✓ |
| 6 / 6b / 6c | ✅ 온전 | **✅ 동의** | T13이 카드 해제→큐 비움→interrupt 순서로 명시돼 6의 "큐 0건"이 성립. 6c의 프로브 사슬도 성립(단 ②는 항상 stale — N6이 그 사슬을 그대로 드러낸다) |
| 7 / 7b~7e | ✅ 온전 | **✅ 동의(#7b는 성립)** | 7b는 상태가 `Resident{LiveItems}`라 T21(From=`Resident{*}`)이 정확히 적용된다 → 90s Unverified → 30분 Watchdog → `Resident{Unverified}`, close_input 없음 ✓. 7d(6h·T32)·7e(mtime 거짓양성 방지)도 성립 ✓ |
| 8 / 8b / 8c | ✅ 온전 | **✅ 동의** | §5.7 신설로 "늦게 온 응답"이 우리 규약이 됐다. 8c 멱등도 규약 3으로 표현됨 ✓ |

**재검 요약: 8/8이 아니라 7/8.** #4는 하네스가 아니라 **본문 §3.4의 한 줄**(큐가 남아 있을 때의
`close_input` 보류)이 없어서 깨진다. 같은 한 줄이 §7.2 배칭·드레인 계획 브로드캐스트의 수치도 좌우한다.

부수 발견 — **프레임 커버리지 게이트가 첫 커밋부터 빨간불이다.** 리포트 형식은
"전이 58개 중 58개 밟음"을 주장하고 `covers` 미달 = 빌드 실패로 정했는데, 열거된 33개 시나리오에
**T3**(spawn 실패·20s) · **T6**(`control_cancel_request`) · **T15**(하드 강등) · **T18**(ThreadChanged) ·
**T28**(compact) · **T34**(Starting 취소) · **F14/F18/F22**를 밟는 것이 보이지 않는다(`synth/compact.jsonl`·
`task-started.jsonl`은 만들어 두고 쓰는 시나리오가 없다) → N11.

---

## 6. 새 구멍 (심각도순)

### N1 [높음] 워치독 루프가 상태를 가드 없이 덮어쓴다

`§5.4-c` 마지막 블록:
```
if ledger.is_empty() && ledger.last_removal_was_watchdog() {
   ledger.confidence = Unverified;
   state = Resident{Unverified};      # ← 상태 가드가 없다
}
```
T21의 From은 `Resident{*}`인데 루프는 **어느 상태에서도** 대입한다.
재현: 긴 턴(수 분짜리 Bash) 중 유일한 원장 항목이던 워크플로가 30분 hard_limit에 정착
→ 원장 빔 → **진행 중인 `Streaming`이 `Resident{Unverified}`로 튄다** → busy가 풀려 컴포저가 열리고,
뒤이어 오는 `result`는 T7(From=`Streaming`)에 붙을 자리가 없다.
`last_removal_was_watchdog()`의 **리셋 규약도 없어** `Idle`에서도 매 tick 재대입될 수 있다.
→ 고칠 곳: 블록을 `if matches!(state, Resident{..})`로 감싸고, 플래그를 T1/T16에서 리셋.
덤으로 `ledger.evidence_bearing()`의 정의(턴 수명 항목 제외)를 한 줄로 못 박을 것.

### N2 [높음] `deferred` 패치의 입도가 L3를 되살린다

`RawIdentity.engine?: EngineAxis`는 **model+effort를 통째로** 나른다(§2.5).
"필드별 병합"은 그 통째 필드 단위다.
```
턴 중: 사용자가 effort만 변경 → staged.patch = { engine: { claude, model: fable, effort: high } }
턴 중: 폴백 발생        → identity.engine.model = opus (리비전 1)
착지:  normalize(현재.patched({engine:{fable, high}})) → model이 **fable로 되돌아감**
드리프트: preview(fable+high) == landed(fable+high) → driftedFields = [] → 토스트도 없다
```
즉 R2가 "죽였다"고 선언한 L3가 **effort/mode 변경 경로로 그대로 살아 있고, 이번엔 경고조차 없다.**
→ 고칠 곳: 패치를 서브필드 단위(`engine: { model?: , effort?: }`)로 쪼개거나,
`fallback_armed`가 건드린 서브필드를 착지에서 **패치보다 우선**시키는 규칙 한 줄. 재생 2c로 잠글 것.

### N3 [높음] 재생 #4가 SUT와 어긋난다 — §3.4에 「큐 있으면 close 보류」가 없다

§3.4는 착지에서 `원장 빔 ∧ OnIdle → close_input()`을 **큐를 보기 전에** 실행하고,
그 다음 줄에서 "큐가 비어있지 않고 hold 없으면 → T16(주입)"이라고 적는다. 두 줄이 모순이다
(Terminating에서 T16은 불가). 결과:
- §7.2의 배칭(`[A A B A]` → 스폰 3회)은 **출하 기본값에서 성립하지 않는다** — 큐 항목마다 1스폰.
- 재생 #4의 단언 "총 spawn 3 / exit 3"과 "fable 1스폰에 2,3 연속 주입"이 거짓(실제 4).
- 드레인 계획 브로드캐스트("2건은 새 프로세스로")가 사용자에게 **틀린 수**를 말한다.
→ 고칠 곳: §3.4 착지에 `큐 비어있지 않으면 close_input 보류(Resident{Policy::Linger(0)} 취급)` 한 줄.
2.6.2 파리티(`engine.ts:658-663 maybeCloseInput`)를 넘어서는 개선이므로 O13과 함께 판단할 것.

### N4 [높음] U10(상속) ↔ m-logic §2.4(물질화) 정면 충돌 — P1d 부활

ux §4.2: *"저장하는 것은 `identityOverrides`(부분)뿐이고 미지정 필드는 전역을 상속한다.
`RunIdentity`는 전역 기본 + overrides로 **계산**된다."*
m-logic §2.4: *"전역 pref는 새 채팅의 기본값으로만 쓰고, 채팅 생성 시 `RunIdentity`에 **스냅샷**된다.
전역을 바꾸면 '열려 있는 채팅에도 적용할까요?'를 묻는다."*

UX 안대로면 설정에서 출력 스타일을 바꾸는 순간 override 없는 **전 채팅의 identity 해시가 동시에 바뀐다**
→ 다음 send가 전부 `IdentityChanged` 재스폰 = **P1d(전역 값이 채팅 상주를 뒤에서 끊는다)가 그대로 부활**.
m-logic이 §1 P1의 마지막 줄로 지목하고 §2.4로 죽였다고 선언한 바로 그 병리다.
게다가 ux §5.2 검증행("상속으로 가는 필드는 전역값과 대조")이 **상속 해석을 마이그레이션 게이트에 박아 놨다.**
→ 리드 결정 1문장 필요: *물질화(m-logic) + 저장은 부분 override(ux)* 로 화해시키려면
"마이그레이션·채팅 생성 시점에 전역을 **읽어 override로 굳힌다**(origin=`restore`, O5)"라고 적으면 둘 다 산다.

### N5 [중] `ChatStatusLite`의 쓰기 주인·시점·경합 규약이 없다

- `chats:save {version, chats, activeChatId}`에 `statuses`가 **없다**(§6.1). 그런데 `chats:get`은 돌려준다.
- `chats-v3/index.json`은 렌더러 팬아웃이 쓰는 파일이고(§4.1이 `chats.ts:116-162` 재사용을 명시),
  `statuses`의 진실은 Rust다 → **같은 파일 두 주인 = lost update**.
- `hold`·`queued`가 `index.json.statuses`와 `<chatId>.json` 양쪽에 있어 **이중 진실**. 반쪽 쓰기 후 우선순위 미정.
- 부팅에 hold/queue 있는 채팅의 `ChatRuntime`을 세우려면 statuses가 필요한데(§2.2-4 감시 집합 정의),
  그 경로가 안 서면 **재시작 후 자동 이어서가 조용히 안 산다**.
- `unread`는 마커 채팅에서 재계산 불가(스레드가 없다).
→ 고칠 곳: `statuses`를 **Rust 전용 파일**(`chats-v3/status.json`)로 빼거나, `chats:save`에 statuses를 싣고
"Rust가 최종 판정" 규약을 적을 것. 셋 중 하나면 된다.

### N6 [중] 프로브 ②는 Alive를 낼 수 없다 + 능동 프로브를 안 쓴다

§2.2의 사슬 그대로. LiveKind×프로브 표의 ② 열 ✓ 4개는 **실효 없음**이고,
실제 Alive 경로는 `Workflow`=③④, `BgShell`=④, `BgAgent`=④, `PendingSettle`=없음이다.
표를 그렇게 고치면 "조용한 셸/에이전트는 파일을 써야만 산다"는 **실제 제약**이 드러난다.
그리고 `initialize` 재전송이라는 **문서화된 능동 프로브**(`protocol-claude-cli.md:466-469`)가 미사용이다 —
이것 하나로 ②가 살아나고 Dead 판정까지 가능해진다.

### N7 [중] `SubAgentModal`의 행선지가 한 문서 안에서 갈린다

ux §3.1은 `ChatSurface` 목록에도, 「창 크롬 3종」에도 서브에이전트 카드를 넣었다.
파리티 맵은 `subagent-modal` → **S**(자리 안). 2.6.2는 셋 다 **패널 밖 최상위**다
(`MultiAgent.tsx:1928` · `SessionWindow.tsx:888` · `PanelWindow.tsx:531`).
S로 넣으면 그리드에서 카드가 **1/6 셀 · zoom .8 안에** 갇힌다 = 읽을 수 없는 회귀.
2.6.2가 같은 함정을 이미 주석으로 경고한다 — `MultiAgent.tsx:1914-1915`:
*"패널이 아니라 여기서 한 번만 렌더해 `.fv-overlay(absolute inset:0)`가 `.win-body` 전체를 덮게 한다"*.
→ 뷰어·라이트박스와 같은 취급(A+Aw)으로 통일할 것.

### N8 [중] §3.6에 대응 전이가 없는 셀이 생겼다 — `Resident{*}` × `interrupt`

L9를 되돌리며 `Resident`의 `interrupt`를 ✅("bg 전체 중지 + 큐 비움")로 올렸는데,
T13의 From은 `Streaming`/`AwaitingUser`/`HeldResult`뿐이고 Resident발 interrupt 행이 **없다**.
착지 상태(Resident 유지? Terminating?), 중지된 항목의 정착 사유(`Stopped{by_user}`?),
`Resident{LiveItems}`→`Resident{Unverified}` 전이 여부가 전부 미정.
"표에 빈칸 없음"이 이 셀에서 깨진다.

### N9 [중] 다이얼 축소 정리 규칙이 2.6.2보다 얇다 — 유령 UI 규약 위반

2.6.2는 count 축소에서 **5개**를 정리한다(`MultiAgent.tsx:1819-1828`):
`focusedSlot` · `renamingSlot` · `expandedSlot` · `openFile` · `openSub`.
R2 §2.2-1은 앞 둘만 다루고 "한 줄이 된다"고 적었다. 통합 모델에서 나머지 셋은 더 위험해진다 —
앱 크롬 뷰어(`viewerTarget.chatId`) · 서브에이전트 카드 · 「크게 보기」 오버레이가
**접힌(=화면에 없는) 채팅을 가리킨 채** 남는다. 메모리에 남은 '고아 상태(유령 UI) 정리 규약'
(커밋 `8e762d2`, 사용자 실물 제보)이 정확히 이 형태다.

### N10 [중] O12(`RunIdentity::hash()` 하나로 비교)가 마이그레이션 데이터에서 계산 불가

§2.3: 정규화 실패 = 존재하지 않는 폴더 / 미로그인 계정 / 키 없음.
마이그레이션 대상 2.6.2 채팅에는 이 셋이 흔하다(지운 프로젝트 폴더, 로그아웃한 계정,
API 모드였는데 키를 지운 경우 — `billing.key_fp`는 **키 원문이 있어야** 계산된다).
before/after 해시 비교가 정의되지 않으면 ux §5.4의 게이트("항목 하나라도 어긋나면 비영 종료 + 머지 금지")가
**첫 실행부터 못 돈다**. 실패 경로의 비교 규약을 O12에 한 줄 붙일 것.

### N11 [중] 프레임 커버리지 게이트를 채울 시나리오가 없다

§5 참조. `covers` 집계 미달 = 빌드 실패라고 스스로 정했으니, 시나리오 6~9개를 더 적거나
게이트를 "핵심 전이 목록"으로 좁혀야 한다.

### N12 [낮음] `PendingSettle`의 증거 정의가 두 절에서 다르다

§5.1은 *"③ 프레임 흐름(**어떤 프레임이든**)"*, §5.4-b의 ①은 *"그 항목을 **지목한** 프레임"*.
후자면 `PendingSettle`은 증거를 영영 못 받고 `lease=hard_limit=10분`이라 **Unverified 단계 없이** 즉시 정착한다.
2.6.2의 10분 안전망(`engine.ts:731`)과 사유 표시가 달라진다.

### N13 [낮음] "접힘 집합을 바꾸는 동작은 딱 둘"이 이미 셋·넷이다

§3.2 토스트 라우팅 (b)(접힌 채팅을 1번 자리로 swap) · (d)(어디에도 없는 채팅을 1번 자리에 얹고
기존 1번을 접힘 집합 맨 앞으로) · §3 사이드바 ctx 메뉴 「이 자리로 보내기」.
U8이 지적한 "규칙 한 줄에 소비자 셋"이 같은 형태로 재발.

### N14 [낮음] `interrupt`가 한도 대기표까지 취소하는 건 파리티 변경인데 표에 없다

2.6.2 `cancelRun`은 큐만 비운다(`App.tsx:901-909`) — `hold`는 건드리지 않는다.
R2 §7.4는 hold도 같이 해제한다(이유는 타당). 그러나 사용자 승인 문장(ux §8)에도
파리티 맵 §6(늘어나는/바뀌는 화면)에도 이 변경이 없다. 자동 이어서는 사용자가 아끼는 기능이다.

### N15 [낮음] 파리티 맵의 자기 모순 2건

- §5 제목 "전부 앱 크롬 **단일 인스턴스**" ↔ §7 회귀 판정 "렌더 지점 **각 2개**(메인+창)".
- `multi-panel-expanded` → **A**인데 그 오버레이는 ChatSurface를 담는다 = §3.1에 없는 4번째 호스트.

### N16 [낮음] 신규 인용 오기 + 카드 종류 판별자 부재

- ux §6.1 "`engine.ts:936` 'ask-' 계열" → 실제는 **`:948`**(`:936`은 dialogKind 가드, 질문 경로는 `:802`).
- 2.6.2는 폴백 다이얼로그를 `questionWaiters`로 받는다(`:950`). `chat:respond-dialog`를 별 채널로 뺐으면
  렌더러가 "이 카드는 dialog다"를 알 방법이 필요한데 m-logic §5.6 `live[]`의 `kind`는 `AskCard` 하나뿐이다.
- (경미) §6.2의 `fallback_armed`는 단일 슬롯이라 **한 턴에 전환이 둘**이면 2.6.2의 카운터보다 좁다.

---

## 7. 착수 가능 여부

| 조각 | 판정 | 조건 |
|---|---|---|
| **M-LOGIC 1~2단계** (`identity.rs` + 골든 테스트 · `live.rs` + `clock.rs` + 7b/7e) | **착수 가능** | 단 코드 첫 줄 전에 **N2**(패치 입도 = `RawIdentity` 타입 모양)와 **N1**(루프 상태 가드) 두 줄을 문서에 확정할 것. 둘 다 타입/루프에 박히는 결정이라 나중에 고치면 그 위에 코드가 쌓인다. N6은 `live.rs` 안에서 표만 고치면 된다 |
| **M-LOGIC 3단계** (`state.rs` 전이표) | **보류** | **N3**(§3.4 close 보류 한 줄) · **N8**(Resident interrupt 전이 행) · **N11**(covers 채우기)를 먼저. 셋 다 문서 수정 30분 |
| **M3 드라이버** (5단계) | 순서대로 | 게이트(8시나리오 초록)는 유효. 단 #4의 단언을 N3 결정에 맞춰 고쳐야 8/8이 다시 참이 된다 |
| **M-UX 코드 — 목업/표면 통합(UI)** | **착수 가능** | 사영표가 기계 검증을 통과했으므로 파리티 게이트로 그대로 쓸 수 있다. 착수 전 **N7**(SubAgentModal 행선지) · **N9**(축소 정리 5개) · **N15**를 반영 — 전부 표 한 줄씩 |
| **M-UX 코드 — 통합 스토어·마이그레이션** | **보류** | **N4**(상속 vs 물질화) · **N5**(ChatStatusLite 주인) · **N10**(해시 비교 실패 경로) 세 건은 **스키마와 게이트를 직접 결정**한다. 리드가 한 문단으로 닫기 전에 `poc-chat-unify-migrate.mjs`를 짜면 두 번 짜게 된다 |

**종합**: R1은 "둘 다 M3 착수 전 닫혀 있어야 한다는 자기 기준을 못 넘는다"였다.
R2는 **M-LOGIC 2단계와 M-UX 표면 작업을 지금 시작해도 되는 수준**이다.
남은 것은 스펙의 구조가 아니라 **리드가 고를 문장 4개**(N1·N2·N3·N4)와 **주인 없는 데이터 하나**(N5)다.

---

## 부록 — 검증에 쓴 것

- 사영표 기계 대조: 인벤토리/사영표에서 `| \`id\` |` 행을 뽑아 집합 비교하는 일회성 파이썬(`%TEMP%`).
  결과는 §3.0에 그대로 실었다.
- 인용 재대조: 두 R2 문서가 인용한 `파일:줄`을 `awk`로 직접 출력해 대조(§1.4에 통과분 요약).
  이번 라운드에서 **틀린 인용은 1건**(N16)이고 나머지는 전부 맞다 — R1이 지적한 10건은 10건 다 고쳐졌다.
- 프레임 대조: `protocol-claude-cli.md:1525-1548`을 직접 세어 **24행** 확인(R2의 정정이 옳고 R1이 틀렸다).
- 앱 실행 없음(이 라운드는 문서·소스 대조만). 레포에 남긴 산출물은 이 파일 하나다.
