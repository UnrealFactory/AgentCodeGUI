# M-UX 렌더러 1단계 보고 **R1** — 다이얼 1~6 · 통합 사이드바 · 그리드=뷰

작업: `app/`(3.0 렌더러)를 `docs/design/ux-chat-unify.md` R3 계약대로 가르기 **1단계**.
브랜치 `feature/3.0.0-beta`. 앞선 라운드가 남긴 전제(통합 스토어 기본값 on · `chat:*` 채널 +
2.6.2 별칭 · 라이브 세로 조각 green)는 **그대로 유지**된 상태로 작업했고, 게이트로 재확인했다.

> 이 라운드가 만든 것은 **화면**이다. 스토어·엔진은 한 줄도 안 건드렸다
> (`src-tauri/`·`crates/`·`src/` 무변경 — `git status`로 확인 가능).

---

## 0. 한 줄 요약

| | |
|---|---|
| 다이얼 | **1~6**. 1 = IDE 크롬(전폭 한 자리·미니어처 배율 해제), 2‥6 = 기존 그리드 |
| 1↔N | **무손실**. `visibleSlots`가 「슬롯 번호 < count」에서 **「order 내 위치 < count」**로 바뀌었다 |
| 접힌 대화 | 사이드바 「채팅」 목록 · 다이얼 옆 접힘 배지(팝오버 ↥) · 접힘 안내 줄 — **세 곳이 동시에** 말한다 |
| 사이드바 | 3섹션(일반/멀티/추가) → **2섹션(채팅/배치)** + 자리 칩(`1` / 흐린 `⌄N` / `창`) |
| `chats:set-active` | 전환 착지점 **한 함수**(`landActiveChat`)로 모아 5곳에서 부른다 |
| 1 모드 busy 전환 | **허용**(스펙 ⑥) — 침묵 no-op 제거 + **떠난 대화의 꼬리를 `chat:event`로 계속 접는다** |
| 게이트 | typecheck ✅ · tauri:build ✅ · **poc-live-chat green 유지** ✅ · poc-dial 신설 **PASS(18검사)** ✅ · 파리티 A/B ✅ · multi 벤치 ✅ |

---

## 1. 선행 — 미작성 목업 3장

| 파일 | 스펙 | 내용 |
|---|---|---|
| `docs/design/mockups/chat-unify-apply-global.html` | §4.2·⑬(b) | 전역 토글 **비즉시** + 「기존 채팅 12개에도 적용할까요?」 카드 + **집계 verdict 카드**(9 적용 · 2 턴 끝에 · 1 거부: 계정 없음). 설정 본문 **안에서** 자라는 카드(모달 위 모달 금지), 기본값 「적용 안 함」 |
| `docs/design/mockups/chat-unify-orphan-rebind.html` | §2.2-1b | 6→1 직후 **전/후 2프레임**: 뷰어는 안 닫고 대상만 재바인드(칩 갱신 + 한 줄 안내), 서브에이전트 카드·크게보기는 닫힘, 이름 편집은 커밋. 아래에 **지목 상태 6종 표**(2.6.2 동작 ↔ 3.0 동작 ↔ 왜) |
| `docs/design/mockups/chat-unify-expand-overlay.html` | §3.1(N15) | `<ExpandOverlay>` 실물 — 베일(z55) 안의 전폭 카드가 `ChatSurface` 하나를 담고, **앱 크롬(뷰어 z60·서브에이전트 z70)은 그 위에** 뜬다. 껍데기 4종 미니 다이어그램 포함 |

기존 8장의 문법(`chat-unify.css` 토큰·주석 칼럼·legend)을 그대로 따랐고, 새 클래스는
파일 안 `<style>`에만 두어 공용 CSS를 건드리지 않았다(기존 목업 규약과 동일).

---

## 2. 구현 범위 (무엇이 실제로 바뀌었나)

### 2.1 다이얼 1~6 (`MultiAgent.tsx`)

- `COUNT_OPTIONS` `[2..6]` → **`[1..6]`**, `clampCount` 하한 2 → **1**.
- **`visibleSlots = panelOrder.slice(0, count)`** (2.6.2는 `panelOrder.filter(s => s < count)`).
  접힘 집합은 `panelOrder.slice(count)`. `slots`(패널 실체)는 **한 번도 안 건드린다.**
- **관문 하나로 모았다** — 보이는 자리 집합을 바꾸는 모든 동작은 `setVisible(order', count')`을
  지나고, 그 함수가 반드시 **`reconcileChatRefs(visible)`**을 부른다(§2.2-1b).
  소비자 셋: ① 다이얼(`applyCount`) ② 접힘 팝오버 ↥(`raiseSlot`) ③ 사이드바에서 접힌 대화 선택.
  2.6.2는 이 정리가 **다이얼 onClick 안에 인라인**이라 다른 경로로 자리가 바뀌면 안 돌았다.
- `reconcileChatRefs`의 갈림(스펙 표 그대로): 포커스 = **재바인드**(order[0]) · 이름 편집 =
  커밋 후 닫기 · 크게보기/서브에이전트 카드 = **닫기** · **코드 뷰어 = 닫지 않고 대상만 재바인드**
  (+ 「대상 채팅이 접혀서 「○○」로 바꿨어요」 한 줄 — `.ma-rebind`).
- 축소 시 **포커스된 자리가 order 맨 앞**으로(= 1번 자리), 나머지 상대 순서 보존.
- 접힘 배지 `⌄N`(+대기 `‼N`) + 팝오버(자리 번호·제목·상태·↥) + 헤더 「접힌 자리 실행 N」 칩.
- **n1 = IDE 크롬**: `.ma-head` 줄을 없애고 **그 자리 패널의 헤더가 TopBar를 겸한다**
  (다이얼·접힘 배지·탐색기 토글·창 컨트롤). 줄을 하나 더 쌓지 않는 것이 "기존 일반 채팅
  그대로"의 조건이다. 미니어처 배율(zoom .8/.9)·그리드 여백·카드 테두리는 `.ma-grid.n1`
  스코프에서 풀고, 배율 키도 `multi.zoom` → **`chat.zoom`**으로 갈아끼운다(§4.2 zoom.ide).
- **함정 하나를 미리 막았다**: n1의 그 한 자리가 팝아웃(유령)이거나 「크게 보기」로 오버레이에
  가 있으면 헤더를 얹을 몸통이 없다 → 그때는 `.ma-head`를 되살린다(`soloReal` 판정).
  안 그러면 **창 컨트롤이 통째로 사라져 창을 닫을 수도 없다.**

### 2.2 사이드바 통합 (`App.tsx` · `Sidebar.tsx`)

- 섹션 **둘**: 「채팅」(= 보드 자리 ∪ 창 ∪ 일반 채팅) + 「배치」(보드 목록).
  「추가 채팅」 섹션은 사라졌고, 그 대화들은 「채팅」 안에서 **창 칩**으로 구분된다(§3.3).
- 항목 칩 3종: 보이는 자리 `1`‥`6`(그 자리 컬러 태그) · 접힌 자리 흐린 **`⌄N`** · **`창`**.
- 접힘 안내 줄(`.sb-foldhint`): *"이 배치의 5개 자리가 접혔어요 — 대화는 그대로예요"*.
- 상태 점에 **`ask`(승인/질문 대기)** 추가 — 접힌 자리의 카드는 화면에 없으므로 목록이 대신 말한다.
- 실행 중 배지(`.runbadge`) — busy 전환을 허용한 대신 "지금 도는 대화"를 목록에서 보인다.
- 라우팅은 id로 판별한다(세 id 공간이 안 겹친다): 보드 자리 = `panelId`(`${sessionId}::${slot}`) →
  `multi.raiseSlot(slot)`(접혀 있으면 1번 자리로 승격) · 창 = 창 포커스 · 나머지 = 일반 채팅 전환.
  **항목 키를 panelId로 둔 이유**: 별칭 계층이 그대로 chatId로 번역하는 키라(§6.2 `panelIdToChat`),
  2단계에서 통합 풀 조회가 열리면 **키만 갈아끼우면 된다.**
- 「전체 삭제」는 목록 길이와 실제 삭제 개수가 다르다(보드 자리는 「배치」 소관) →
  `deleteAllCount`를 따로 넘겨 **확인 카드가 진짜 개수를 말한다.**

### 2.3 `chats:set-active` 배선 (렌더러 몫)

- `app/src/api/unified.ts` 신설 — `WindowApi`(얼린 계약면)에 없는 채널 둘을 부르는 얇은 창구.
  `src/shared/`는 경계 밖이라 **계약면을 고치지 않고** 심과 같은 문법(`invoke('ipc_call', …)`)으로 붙였다.
- 착지점을 **`landActiveChat(id)` 한 함수**로 모으고 다섯 곳에서 부른다:
  부팅 하이드레이션 · `restore()`(전환·삭제 후 착지) · `createChat`(새 채팅) ·
  `deleteChat`(마지막 하나 삭제) · `deleteAllChats`.
- 같은 값 연타는 접는다(전환 → restore 경로가 서로를 부른다).

### 2.4 그리드 = 뷰

- 자리 번호(1‥N)는 **`order` 내 위치**일 뿐이고, 슬롯 정체성(엔진 채널 `${sessionId}::${slot}`)은
  자리 이동·다이얼 변경으로 **바뀌지 않는다.** 접기·되올리기·↥ 승격은 전부 `order`만 바꾼다
  → **엔진 재스폰 0**(불변식 3), 대화·실행 상태 그대로.
- 팝아웃·창은 **기존 경로 보존**(창 자리 채널 미배선 — 이번 라운드 재구현 금지 지시대로).

### 2.5 1 모드 busy 전환 허용 (스펙 ⑥) — **그냥 열지 않았다**

침묵 no-op(`App.tsx:774,799,811` 상당)을 제거하면서, 그것이 막고 있던 **진짜 사고**를 같이 막았다.

- Rust는 `engine:event`를 **활성 채팅으로 게이팅**한다(`src-tauri/src/engine/hub.rs fanout`).
  그래서 전환 자체는 안전하다(남의 스트림이 지금 보는 스레드에 안 섞인다 — PoC `bg.bleed`로 확인).
- 그러나 **떠난 채팅의 꼬리가 렌더러에서 사라진다.** 그래서 통합 봉투 **`chat:event`**를 받아
  그 채팅의 스냅샷에 **같은 리듀서로** 접는 수집기를 넣었다:
  - 대상은 "실행 중에 떠난 채팅"뿐(집합에 없는 chatId는 무시) → 활성 채팅과 이중 적용 불가.
  - 토큰마다 setState 금지 — ref에 접고 **600ms마다** 스토어에 민다(스트리밍 fps 보호).
  - 돌아오면 ref의 최신 스냅샷으로 착지 → 플러시 대기분도 안 잃는다.
- **삭제만은 여전히 막는다** — 도는 엔진의 대화는 되돌릴 수 없다.
- 부수로 **2.6.2에도 있던 경쟁을 하나 닫았다**: 언로드 스윕이 "저장 이후에 더 자란 스냅샷"을
  내려버리던 창(`sentSnaps` 비교 추가). 이게 실제로 PoC를 **한 번 실패시켰다**(§4 참조).

---

## 3. 채택한 스펙 기본값 — **전부 되집기 가능**

열린 문제 ①~⑬ 중 이번 코드가 실제로 굳힌 것만 적는다. 각 항목에 "되집는 법"을 붙였다.

| # | 스펙 추천 | 이번에 채택한 것 | 되집기 |
|---|---|---|---|
| ① 사이드바 구조 | (a) 「채팅」+「배치」 2섹션 | **(a)** | `App.tsx`의 `sections` 배열 한 곳 — (c)로 가려면 창 항목을 3번째 섹션으로 떼면 된다(항목 데이터는 이미 `extraSummaries`로 분리돼 있다) |
| ② 접힘을 얼마나 알릴까 | 배지 + 요약 칩 + 사이드바 점 | 배지·팝오버·요약 칩·**접힘 안내 줄** 채택. 「접힌 대화」 전용 그룹은 **안 만들었다** | 안내 줄은 `sections[0].hint` 한 줄 |
| ③ 자리 비우기 = 실행 계속? | 계속 돈다 + 「자리 밖 실행 N」 칩 | **계속 돈다** + 헤더 「접힌 자리 실행 N」 칩 | 칩은 `topBar`의 `foldedRunning` 블록 |
| ⑤ 한도 대기표 재장전 | 보이는 자리 자동 / 나머지 표시만 | **미적용**(부팅 재장전은 Rust 몫 — 이번 경계 밖) | — |
| ⑥ 1 모드 busy 전환 | 허용 + 실행 중 배지 | **허용**(+ 꼬리 수집기 · 삭제는 계속 금지) | `leaveActive()` 호출 3곳을 지우고 `selectChat/createChat`에 `if (busy) return` 복원 |
| ⑦ 보드를 목록으로 | (a) 유지 | **(a)** — 「배치」 섹션 | — |
| ⑧ 빈 자리 기본 동작 | 미정 | **2.6.2 그대로**(빈 패널에서 바로 입력) — 타일 안 만듦 | — |
| ⑨ `Board.chrome` 노출 | 내부값 | **내부값**(count===1이 곧 ide 크롬) | — |
| ⑩ NewChatModal 철거 | 미정 | **현행 유지**(지시대로) — 2단계 패널 수는 여전히 2~6 | — |
| ⑪ 읽지 않음 배지 | 3.0.0 범위 밖 | **안 만듦** | — |
| ⑫ 배율 키 합류 | 미정 | n1은 **`chat.zoom`**, 2‥6은 `multi.zoom`(§4.2 zoom.ide/grid). `zoom.window` 승계는 **안 건드림** | `useZoom(count === 1 ? …)` 한 줄 |
| ⑬(a)(b) 동작 변경 승인 | 사용자 확인 대기 | **둘 다 미적용**(중단이 hold까지 취소 / 전역 토글 비즉시는 **목업만** 그렸다) | — |

추가로 굳힌 **스펙에 없던 결정 3개**(전부 이 문서에 기록):

1. **n1의 TopBar 호스트 = 그 자리의 패널 헤더**(별도 줄 금지). 근거: 목업 `chat-unify-1-ide`가
   헤더를 한 줄로 그렸고, 줄을 더 쌓으면 "기존 일반 채팅 그대로"가 깨진다.
   되집기: `soloReal` 판정을 `false`로 고정하면 항상 `.ma-head` 줄이 뜬다.
2. **1 모드의 두 갈래**를 인정했다 — IDE 크롬에는 **보드의 1번 자리**(다이얼로 내려온 경우)가
   앉을 수도, **일반 채팅**(사이드바에서 고른 경우)이 앉을 수도 있다. 통합 풀이 렌더러에
   열리기 전(2단계)까지의 과도기 모양이며, 사용자 눈에는 **같은 화면**이다.
3. **사이드바 항목 키 = panelId**(§2.2 마지막 줄). chatId로 바꿔 끼우는 것이 2단계의 한 줄 작업이 되게.

---

## 4. 게이트 결과 (전부 실행)

### 4.1 빌드·타입

```
npm run typecheck:app   → 통과 (오류 0)
npm run tauri:build     → 성공 (target/release/agentcodegui.exe)
```
> 함정 하나: 앱을 돌린 **직후** 빌드하면 `failed to remove agentcodegui.exe (os error 5)`가 난다.
> 잠근 것은 프로세스가 아니라(핸들 검사 통과) 스캐너로 보인다 — `rm -f target/release/agentcodegui.exe`
> 후 재빌드하면 항상 통과한다. 다음 사람이 같은 데서 안 막히게 남긴다.

### 4.2 `scripts/poc-live-chat.mjs` — **green 유지** ✅

내 변경 뒤 재실행:

```
[R8-1] ✓  · [LIVE] 1-부팅 ✓ 2-채팅열기 ✓ 3-메시지 ✓ 4-스트리밍 ✓ 5-승인카드 ✓
        5b-영구정지 ✓ 6-완료(파일 실제 생성) ✓ 4b-스트리밍 총계 ✓ 7-재시작 ✓
판정: PASS · 결함 0건
```

### 4.3 `scripts/poc-dial.mjs` (신설) — **PASS · 18검사** ✅

실 창·실 스토어·실 화면. 1·2단계는 엔진 0턴(픽스처가 대화를 심는다), 3단계만 실 CLI 1턴.

| 단계 | 검사 | 결과 |
|---|---|---|
| **dial** | 6자리 부팅 / 보드 자리 6개가 자리 칩을 단다 / 다이얼 1이 `.ma-grid.n1` 한 자리를 만든다 / **n1에서 헤더 줄이 둘로 안 쌓인다**(`.ma-head` 0 + 패널 헤더에 다이얼 1) / 접힘 배지 = 5 / **사이드바에서 사라진 대화 0** / 접힌 칩 5 / 팝오버 5줄 / 되올리면 6자리 / **순서 동일** / 포커스한 3번이 접으면 1번 자리로 **승격** / 승격 후 나머지 상대 순서 보존 / **재시작 후 전부 생존** / 재시작 후 자리 수 6 | ✅ 14/14 |
| **active** | 두 채팅 심기 / **전환 120ms 뒤 스토어의 activeChatId가 이미 새 값**(저장 디바운스 600ms보다 먼저) | ✅ 2/2 |
| **bg**(실 CLI 1턴) | 실행 중 전환이 **된다**(2.6.2는 침묵 no-op) / 옆 채팅에 남의 스트림이 **안 섞인다** / **돌아오니 자리 밖에서 온 어시스턴트 답이 스레드에 있다** | ✅ 3/3 (`chat:event` 8건 수신, chatId=`c-run`) |

리포트: `docs/critic/m-ux-r1-dial.json` (미커밋 산출물).

> **이 PoC가 실제로 잡은 것 둘** — 하네스가 장식이 아니라는 증거로 남긴다.
> 1. **가짜 통과**: 처음엔 `body.innerText.includes('BGDONE')`로 판정했는데, 사용자가 보낸
>    프롬프트에도 그 글자가 있어 **항상 통과**했다 → 어시스턴트 말풍선(`.msg.ai-msg`)만 보도록 고쳤다.
> 2. **진짜 결함**: 고친 판정이 바로 실패했다(`aiMsgs: []`). 원인은 언로드 스윕과 꼬리 수집기의
>    경쟁 — 저장 페이로드를 만든 **뒤** 더 자란 스냅샷을 스윕이 자리표시자로 덮었다.
>    `sentSnaps` 비교로 닫고 재실행 → PASS. **이 결함은 2.6.2에도 있던 형태**다(활성 채팅 보호만 있었다).

### 4.4 파리티 A/B — 무변경 화면 **픽셀 파리티 유지** ✅

전/후를 같은 방법으로 비교했다: `app/src`를 2.6.2 원본으로 되돌려 빌드 → 18화면 캡처 →
내 변경본으로 되돌려 빌드 → 같은 18화면 캡처 → 픽셀 비교(1320×880).

- **노이즈 바닥 측정**: 같은 빌드로 두 번 찍어 비교 → 임계 24 초과 **0px**(임계 없으면 7,895px·최대 17).
  아래 수치는 전부 **임계 24 초과**만 센 것이다.

| 화면 | 임계 초과 diff | 위치 | 판정 |
|---|---|---|---|
| chat-thread · composer · workbar · chat-welcome · sidebar · sidebar-empty · sidebar-ctx-menu | 791px (0.068%) | **x953–1109, y7–30** | 헤더에 들어온 **다이얼** 한 덩어리 — 그 밖은 전부 동일 |
| chat-find | 806px | 같은 띠 + 찾기 바 | 동상 |
| settings-api · settings-display · settings-mcp | 753px | x951–980, y5–32 | 모달 위로 보이는 다이얼 일부 |
| multi-grid-empty · multi-grid-counts | **38px** (0.003%) | x990–996, y14–22 | 멀티 다이얼에 늘어난 **「1」 글자** |
| multi-panel-expanded | 15px | x260, y819–833 | 컴포저 **캐럿 깜빡임**(내 변경 아님) |
| sidebar-deleteall-confirm | 1,712px | 확인 카드 문구 | 섹션 라벨·개수 변경(의도) |

> **읽는 법**: 왼쪽 칼럼(x<250)은 사이드바 자체가 변경 화면이라 제외하고 쟀다. 제외 없이 재면
> 사이드바 텍스트 델타(7,102px)가 모든 화면에 공통으로 얹힌다.
> **결론: 다이얼·사이드바 밖에서 바뀐 픽셀은 0이다.**
> 산출물: `bench/shots/tauri-before/` ↔ `bench/shots/tauri/`(미커밋).

**변경 화면 ↔ 목업 대조 스크린샷**(같은 폴더):
`mux-grid-six.png`(다이얼 1~6이 들어온 6분할) · **`mux-dial-one.png`**(n1 = IDE 크롬 —
목업 `chat-unify-1-ide` 대조) · **`mux-fold-pop.png`**(접힘 팝오버 — 목업 `chat-unify-collapse` 대조).
목업과 대조한 결과 차이는 둘뿐이고 **의도한 보존**이다:
① n1 헤더에 패널 어포던스(상태 칩·팝아웃·크게보기)가 남아 있다(목업은 통합 후 모델이라 생략) —
빼면 n1에서 팝아웃이 사라진다. ② 「접힌 자리 실행 N」 칩은 실행 중일 때만 뜬다(픽스처는 유휴).

### 4.5 `bench/multi.mjs tauri --repeats=1` — 게이트 유지 ✅

| 지표 | 커밋된 기준(5회 중앙값) | 이번(1회) | 판정 |
|---|---|---|---|
| 유휴 그리드 WS / Private | 424.0 / 242.0 MB | **433.8 / 250.1 MB** | +2.3% — 1회 표본 노이즈 범위(직전 단일 회차 기록은 466.5) |
| 창 1개 추가 비용 | 24.7 MB · +0 프로세스 | **21.8 MB · +0** | 개선 |
| 패널 1개 스크롤 | 56.7fps · p95 23.1 · 드랍 0.3% | **59.9fps · p95 17.0 · 드랍 0%** | 개선 |
| **4패널 동시 스크롤(부하 팔)** | 58.0fps · p95 20.1 · 드랍 0% | **58.9fps · p95 18.5 · 드랍 0%** | 개선 |

> 그리드=뷰 전환(=`order` 조작)은 **엔진을 재스폰하지 않으므로** 메모리·fps에 계통 영향이 없다.
> 다만 1회 표본이라 메모리 결론은 "게이트 위반 없음"까지만 주장한다.
> 커밋된 5회 중앙값 파일(`bench/results/multi-tauri-3.0.0-default.json`)은 **덮지 않고 되돌렸다**
> — 다른 빌더의 더 강한 증거를 1회 표본으로 바꿔치기하지 않기 위해서다.

---

## 5. 남은 것 (다음 라운드)

**코드**

1. **통합 풀 조회가 아직 없다.** 「채팅」 목록은 세 원천(일반 채팅 · 활성 보드 자리 · 창)을
   렌더러에서 **합쳐서** 그린다. `chats:get`이 여전히 옛 블롭 모양이라(별칭 계층) 그렇다.
   2단계에서 통합 조회가 열리면 항목 키 `panelId` → `chatId`가 되고 이 합성이 사라진다.
2. **비활성 보드의 자리는 목록에 안 뜬다**(활성 보드만 `onPanelInfo`로 보고한다).
   부팅 직후 보드 크롬에 한 번도 안 들어갔으면 그 보드 자리들도 아직 안 보인다.
3. **접힌 자리의 토스트 감시**는 여전히 렌더러 몫이라 자리에서 벗어난 실행의 완료 토스트가
   안 뜬다(스펙 §2.2-4는 감시자를 Rust로 옮긴다 — M-LOGIC/M3 몫).
4. **뷰어 대상 재바인드 안내**는 멀티 크롬에서만 뜬다(`.ma-rebind`). 통합 뷰어(`viewerTarget`)는 2단계.
5. **창 자리 재구현 금지**를 지켰다 — 창 닫기·복귀·`win:chat-*`는 손대지 않았다.
6. `docs/renderer-divergence.md` **갱신 필요**: 이 라운드가 `app/src`의 **첫 의도적 분기**다
   (App/Chat/MultiAgent/Sidebar/styles.css 수정 + `api/unified.ts` 신설).
   그 파일은 내 경계 밖이라 손대지 않았다 — **소유자가 5줄 추가해야 파리티 감사가 안 헷갈린다.**

**검증**

7. `poc-dial.mjs`의 bg 단계는 실 CLI 1턴을 쓴다(한도·계정 필요). CI에서 돌리려면
   `--only=dial,active`(엔진 0턴)만 쓰면 된다.
8. 파리티 A/B는 18화면 표본이다. 전 화면(156) 재주행은 별칭 계층 삭제 라운드의 게이트로 남겨 둔다.

**미해결 질문(사용자 결정 대기)** — 스펙 ⑬(a)(b), ⑩(NewChatModal), ⑫(`zoom.window` 승계).

---

## 6. 파일

| 파일 | 성격 |
|---|---|
| `app/src/components/MultiAgent.tsx` | 다이얼 1~6 · `setVisible`/`reconcileChatRefs` 관문 · 접힘 배지/팝오버 · n1 IDE 크롬 · 자리 요약 보고 |
| `app/src/App.tsx` | 통합 사이드바 2섹션 · `landActiveChat`(set-active) · busy 전환 허용 + 꼬리 수집기 · 헤더 다이얼 |
| `app/src/components/Sidebar.tsx` | 자리 칩 · 대기 점 · 실행 배지 · 안내 줄 · `deleteAllCount`/`emptyText` |
| `app/src/components/Chat.tsx` | `ChatHeader`에 `dial` 슬롯 한 자리(다이얼 x좌표 고정 규약) |
| `app/src/api/unified.ts` | **신설** — `chats:set-active` · `chat:event`(계약면을 안 고치고 붙인 창구) |
| `app/src/styles.css` | **추가만** — `.ma-grid.n1` 스코프 · 접힘 배지/팝오버 · 자리 칩 · 재바인드 안내 |
| `docs/design/mockups/chat-unify-{apply-global,orphan-rebind,expand-overlay}.html` | 목업 3장 |
| `scripts/poc-dial.mjs` | **신설** — 다이얼 1↔6 무손실 · set-active 즉시성 · 실행 중 전환 꼬리 보존 |
| `bench/screens.mjs` | `multi-grid-counts` 도달을 **인덱스 → 라벨 텍스트**로(두 앱에서 같은 배치에 도달) · `sidebar` 라벨 |

---

# R2 — 문 뒤의 소유권을 옮겼다

크리틱 `docs/critic/m-ux-r1.md`(조건부 불합격)의 판정 한 줄이 정확하다:
*"스펙 ⑥을 '여는' 작업이 열리는 문 뒤의 상태 소유권을 안 옮겼다."*
이 라운드는 그 소유권을 옮긴다. **⑥을 되집지 않았다** — 되집기는 사용자가 요청한 기능
(실행 중 전환)을 도로 뺏는 것이고, 크리틱 자신도 "큐를 `Chat`으로 옮기고 삭제 가드를
'도는 채팅 전부'로 넓히는 쪽이 정공법"이라고 적었다.

## R2.0 한 줄 표

| 크리틱 | 판정 | 이번 |
|---|---|---|
| ① `queue.misroute` (치명) | 예약이 남의 대화로 발사 | **큐 소유자 = 채팅** + 자리 밖 드레인은 `chat:run{chatId}` |
| ② `bgdel.deleted-while-running` (높음) | 도는 대화가 삭제됨 | 삭제 잠금 = `busy‖wfAlive‖bgSnapRef.has(id)` |
| ③ `busydel.silent` (높음·규약) | 확인까지 하고 침묵 no-op | 메뉴 잠금 + **이유를 말하는 카드** |
| ④ `side.raise-from-single` (중상) | 접힌 대화를 골라도 다른 대화가 열림 | `raiseSlot`이 레코드의 `panelOrder`도 올린다 |
| ⑤ `side.dup-slot1`·`stale-live` (중) | 「1번 자리」를 둘이 주장 | 보드 크롬 밖에서는 `live` 칩을 안 단다 |
| ⑥ `geom.move-1-2` (중) | 다이얼이 47px 튄다 | 접힘 배지 **자리 예약** + 세 크롬의 gap·버튼 박스 통일 |
| ⑦ n1 찾기 버튼 없음 (하) | 어포던스 손실 | TopBar에 돋보기 + n1 포커스 확정(Ctrl+F가 실제로 산다) |
| ⑧ `raise.scroll` (하) | 읽던 위치 휘발 | **고치지 않았다** — 스펙 §2.5가 명시한 계약이다(아래 R2.7) |
| ⑨ IDE 크롬 내용물 | 이 라운드 밖 | 그대로 (fs 채널은 M2/M6 몫) |
| 배선 R2가 넘긴 R2·R3·R4·R5 | 렌더러 몫 | 폴백 카드 · `settled[]` · `Aborted` 어휘 · F12 따라잡기 **전부 배선** |

## R2.1 큐 소유권 — 왜 렌더러에 남겼나 (스펙과의 거리를 먼저 적는다)

지시는 *"렌더러 큐를 Rust 큐로 이관하는 것이 스펙 정답"* 이었다. **오늘의 배선으로는
불가능하다.** 이 라운드의 경계(`src-tauri/`·`crates/` 금지) 안에서 확인한 사실 넷:

| # | 사실 | 근거 |
|---|---|---|
| 1 | `chat:queue-mutate`에 **넣는 op이 없다** — `restore`(undo 토큰)뿐이고 나머지는 `Cmd::QueueMutate` 하나로 접수된다 | `src-tauri/src/engine/hub.rs` `Op::QueueMutate` |
| 2 | 그 `Cmd::QueueMutate`는 런타임에서 **무동작**이다(`execute`의 `_ => verdict`) | `crates/ccg-engine/src/runtime.rs` |
| 3 | 엔진 큐 항목은 **텍스트뿐**이다 — `Event::Queue{ items: Vec<String> }`, `queue_texts()`. 렌더러 예약은 `{text, images, picker}`라 첨부·모델·모드가 통째로 사라진다 | `runtime.rs` `broadcast_queue` |
| 4 | 엔진이 스스로 드레인하면(`t16_inject`) **렌더러가 못 본다** — `wire.begin_run()`은 `Op::Run`에서만 불리므로 새 runId도, `analyzing` 상태도, 사용자 말풍선도 안 나간다 | `hub.rs` `Op::Run` ↔ `runtime.rs` `t16_inject` |

게다가 렌더러 사본은 **디스크에 실을 수도 없다**: `queue`는 chats-v3의 Rust 소유 필드라
`chats:save` 페이로드의 값이 어떤 경우에도 채택되지 않는다
(`crates/ccg-store/src/chats_v3.rs` `RUST_OWNED` / `apply_owned` — *"페이로드 값은 어떤
경우에도 채택되지 않는다"*). 그래서 이번 큐는 **세션 메모리 수명**이고, 저장 페이로드에서
명시적으로 뺐다(2.6.2도 재시작에 큐를 안 지켰으므로 회귀는 없다).

**대신 옮긴 것은 소유권이다.** 진실은 `ChatMeta.queue`이고 `queue` state는 그중 활성
채팅의 한 벌이다(초안 `draft`/`draftImages`와 같은 규약). 불변식 셋을 코드가 들고 있다:

1. **주차** — `saveActive`가 떠나는 채팅의 메타에 큐를 접어 넣고, `restore`의 `land()`가
   착지하는 채팅의 큐로 갈아 끼운다(`queueOwnerRef`도 같이 넘어간다).
2. **소유권 게이트** — 드레인 effect 맨 앞에
   `queueOwnerRef.current !== activeChatIdRef.current → return`.
   `busy`는 이 창의 라이브 리듀서가 내는 값이라 **전환(남의 idle 스냅샷 로드)만으로도**
   true→false 에지가 생긴다. R1이 발사한 것이 정확히 그 에지다.
3. **자리 밖 드레인** — 배경 채팅의 턴 종료는 `bgFlush`가 본다(이미 있던 꼬리 수집기).
   거기서 `drainBgQueue`가 ① `chat:run{chatId}`로 **주소를 실어** 쏘고 ② 사용자 말풍선을
   그 채팅의 배경 스냅샷에 `sessionReducer(begin)`으로 접는다(돌아오면 자기가 예약한 문장이
   스레드에 있다). 옛 별칭 `claude:run`은 주소를 안 실어 "그 순간의 활성 채팅"으로 가므로
   **그 채널로는 이 기능을 만들 수 없다** — `chat:run`이 배선돼 있어 가능했다.

요청 조립은 `buildRunRequest` 한 곳으로 모았다(활성 경로 `runPrompt`와 자리 밖 드레인이
같은 함수를 쓴다) — 두 경로가 프롬프트를 다르게 만들면 "돌아와 보니 내 예약이 다른 문장으로
나갔다"가 된다.

폴더를 아직 모르는 채팅(첫 전송 전)은 배경에서 쏘지 않는다 — 폴더 선택 창을 띄울 수 없다.
그 예약은 큐에 남고 사용자가 돌아오면 평소 경로로 나간다. 한도 대기표가 걸린 채팅도 보류다.

### 실증 — 크리틱 재현 시나리오가 뒤집힌다

`node docs/critic/tools/critic-mux-attack.mjs --only=queue` (실 CLI · 크리틱 하네스 그대로)

```
o queue.enqueued    {"text":"QUEUEDPROBE-9182","n":1}
o queue.switch
o queue.no-misroute {"msgs":0}            ← B의 스레드는 **비어 있다**
o queue.home        {"msgs":4,"hasProbe":true,"stillQueued":0,
                     "tail":["1 … 30", "QUEUEDPROBE-9182",
                             "I don't have context about a prior counting session …"]}
```

R1의 같은 명령은 `queue.misroute`(B의 엔진이 실제로 돌았다) + `queue.lost`(A에서 증발)였다.
지금은 **B가 0건**이고, A로 돌아오면 그 프롬프트가 A의 스레드에 사용자 말풍선으로 있고
그 뒤에 A의 답이 붙어 있다 — 화면이 B에 있는 동안 A로 나간 것이다.

`node scripts/poc-dial.mjs --only=queue` (신설 · 실 CLI 3턴 · 예약 2건)

```
o queue.enqueue     ["QOWNER-ALPHA","QOWNER-BETA"]
o queue.park        옆 채팅 컴포저의 .sched-item = 0
o queue.restore     {"backQ":["QOWNER-ALPHA","QOWNER-BETA"],"firedAway":[]}
o queue.no-misroute 옆 채팅 스레드 0건 (끝까지)
o queue.fired-home  {"i1":1,"i2":2}       ← 사용자 말풍선 순번 = 걸었던 순서
o queue.drained     남은 예약 0
o queue.answered    {"ai":3}              ← 표시만이 아니라 **엔진에 닿았다**
```

> `queue.restore`는 단순 동일성 비교가 아니다. 떠나 있는 동안 A의 턴이 끝나 **정상 드레인이
> 도는 경우가 실제로 있어서**(1차 실행에서 밟았다) 판정을 강한 형태로 바꿨다:
> *돌아온 목록은 원래 목록의 꼬리여야 하고, 그 사이 빠진 항목은 이 대화로 이미 나갔어야 한다.*
> 하네스가 잡은 두 번째 함정: 300줄짜리 답이 들어 있는 `.thread` 전문을 CDP로 끌어오면
> 직렬화가 잘려 `indexOf`가 -1이 된다(말풍선은 멀쩡히 있는데). 순서 판정을 **말풍선 순번**으로 바꿨다.

## R2.2 삭제 가드 — 「도는 채팅 전부」 + 이유를 말한다

`deleteLockOf(id)`가 **이유 문자열**을 돌려준다(빈 문자열 = 지울 수 있다):
활성 채팅은 `busy‖wfAlive`, 그 밖은 `bgSnapRef` 보유(= 지금 이 창이 꼬리를 접고 있는 대화).
배경 집합은 렌더 신호가 아니므로 `bgIds` state로 미러링한다 — ref만 보면 마지막 대화가
정착한 순간에도 배지·가드가 안 풀린다.

그 문자열이 네 곳으로 흐른다:

- 우클릭 「삭제」 **잠금**(2.6.2 파리티) + 메뉴 안 이유 한 줄(`.cmwhy`).
- `askDelete`가 잠긴 항목이면 **파괴 버튼 없는 확인 카드**를 띄운다(Delete 키·경쟁 경로).
  누를 것을 남겨 두면 또 침묵 no-op이 된다 — M-LOGIC P7.
- 「전체 삭제」는 `deleteAllLock()`으로 잠기고 툴팁이 이유를 말한다.
- `App.deleteChat`/`deleteAllChats`의 `return`은 **마지막 방어선**으로 남긴다.

```
--only=busydel : o busydel.ctx-disabled
                 o busydel.all-disabled {"disabled":true,
                    "tip":"지금 실행 중이에요 — 작업이 끝난 뒤 지울 수 있어요."}
--only=bgdel   : o bgdel.live    {"ev0":13,"ev1":20,"streaming":true}   ← 진짜 도는 중
                 o bgdel.blocked {"found":true,"disabled":true}
```

## R2.3 배선 R2가 넘긴 렌더러 몫 — 넷 다 배선

| 항목 | 이번 구현 |
|---|---|
| **R2 폴백 확인 카드 + `chat:respond-dialog`** | 셸이 파리티로 그린 질문 카드를 `header==='폴백 확인'`으로 식별(`isFallbackAsk`)해 **전용 카드**로 그린다(헤더 문구·「모델 폴백」 라벨·**자유 입력 제거** — 답이 예/아니오라 임의 문자열은 원장이 해석 못 한다). 답은 `chat:respond-dialog`로 §4.4b 어휘를 태워 보내고, **거절되면 질문 채널로 되돌아간다** — 안 그러면 카드만 닫히고 엔진이 영원히 기다린다. Esc/접어두기는 취소(폴백 안 함)다 |
| **R3 `settled[]` 사유 표시** | `chat:run-state.settled[]` → `app/src/lib/settled.ts` 레지스트리(항목 id는 전역 유일이라 프롭 드릴 대신 `useSyncExternalStore`). `settleText()`가 m-logic §5.2 어휘로 번역한다 — `completed`만 완료, 나머지는 **「정리됨」 + 사유 부제**(「엔진(CLI)이 외부에서 종료돼서」·「응답이 없어서」·「완료 통지를 못 받아서」…). 첫 소비자는 **도구 행**이다: 합성 `result`는 busy만 내리고 running 도구는 안 건드려서 R1에서는 그 스피너가 **영원히 돌았다** |
| **R4 `Aborted` 어휘** | 와이어에 그 값이 없다(셸이 `done`으로 접는다). 화면에 남은 진실은 리듀서가 붙인 '중단함' 마커 → `abortedTurn(state)`. `effectiveStatus`가 완료 색·완료 링을 끄고(단일 소스), 패널 상태 칩은 「중단됨」으로 말한다 |
| **R5 F12(첫 `chat:status`가 구독자보다 이르다)** | `onChatStatus` 구독 **직후 1회** `chats:get`의 `statuses`로 따라잡는다. 이미 도착한 브로드캐스트는 절대 덮지 않는다(비어 있는 키만 채운다). 소비처는 사이드바 — 화면에 없는 대화의 **승인/질문 대기 점**과 상태를 목록이 대신 말한다(§2.2-5) |

## R2.4 크리틱 부수 지적

- **⑦ 찾기 버튼** — TopBar에 돋보기 신설(`PanelFindButton`, 본채팅 헤더와 같은
  `ccg:chat-find` 창 이벤트). 그리고 **n1에서 Ctrl+F가 실제로 살아 있게** 했다:
  `setVisible`이 `n===1`이면 그 한 자리를 포커스로 세운다 — 안 그러면 그 패널의 `ChatFind`가
  `active=false`라 돋보기도 Ctrl+F도 죽는다(크리틱은 포커스가 있는 상태에서 재서 "동작한다"고
  적었지만, 부팅 직후 n1로 내려오면 `focusedSlot`이 `null`이다).
  보고서 §3 새 결정 2의 *"사용자 눈에는 같은 화면"* 은 여전히 **거짓**이다 — n1 헤더에는
  자리번호 칩·상태 칩·팝아웃·크게보기·컬러태그·제목잠금이 더 있다. 문장을 고친다:
  **"1 모드는 두 갈래이고 화면도 같지 않다 — 공통은 다이얼·찾기·탐색기·창 컨트롤의 위치와
  스레드/컴포저이고, 패널 어포던스 6개가 보드 쪽에만 더 있다."** 통합 풀이 열리는 2단계에
  한 갈래로 접는다.
- **⑤ 자리 칩** — 칩의 뜻은 *"이 대화가 지금 어느 자리에서 **보이는가**"*(`Sidebar.tsx:27`).
  보드 크롬을 떠나면 그 자리는 화면에 없으므로 `live` 칩을 **안 단다**(대화는 목록에 그대로
  남는다 — 사라지는 건 칩뿐이다). 접힘 안내 줄도 보드를 보고 있을 때만 뜬다.
- **⑥ 다이얼 x 고정** — 원인 셋을 다 잡았다: ⓐ 접힘 배지가 다이얼 **오른쪽**에서 나타났다
  사라진다 → 폭이 같은 **자리표시자**(`.ma-fold.hold` + `.ma-fold-hold`, 배지 클래스가
  아니라서 "n6인데 배지가 남았다"는 유령 판정과 구분된다)로 고정 ⓑ `.ma-head`의 gap이 10px,
  `.chat-head`/`.ma-p-head`가 8px → 8px로 통일 ⓒ `.h-ic` 규칙이 `.ma-p-head`를 스코프에
  안 넣어 n1에서 버튼이 25px→15px로 그려짐(둘이니 20px) → 스코프 추가. 본채팅 헤더에도 같은
  자리표시자(`FoldSlotHold`)를 넣어야 세 크롬이 일치한다.
  실측: `n6 904 · n2 904 · n1 904 · 일반 채팅 904` (R1은 976 / 929 / 947 / 949).
  목업 `chat-unify-collapse`가 배지를 다이얼 뒤에 두는 것은 그대로다 — **자리를 예약하는
  폭 고정**이 그 배치와 규약을 동시에 만족시키는 방법이고, 이번 구현이 그것이다.
- **`chats:set-active` 잔여 호출 지점 대조** — `setActiveChatId`는 `landActiveChat` 안에서만
  불린다(정적 대조 완료: 착지 6곳 전부 `landActiveChat`/`landOnFreshChat` 경유).
  **구멍 하나를 찾아 막았다**: 저장본이 없는 첫 실행·`chats:get` 실패에서는 하이드레이션의
  착지가 안 돌아 `chats:set-active`가 **한 번도 안 나간다** → 첫 전송이 저장 디바운스(600ms)
  보다 빠르면 별칭 계층이 빈 주소로 라우팅한다. `finally`에 폴백 착지를 넣되 이미 착지했으면
  건드리지 않는다(그 시점의 `activeChatIdRef`는 아직 커밋 전이라 다시 부르면 **낡은 id**가 나간다).

## R2.5 게이트

| 게이트 | 결과 |
|---|---|
| `npm run typecheck:app` | 통과(오류 0) |
| `npm run tauri:build` | 성공 (`rm -f target/release/agentcodegui.exe` 후 — os error 5 함정은 여전하다) |
| `node scripts/poc-live-chat.mjs` | **PASS · 결함 0건** (E9/ERROR/RELOAD/SLOTS/LIVE 전 항목 ✓) |
| `node scripts/poc-dial.mjs` | **PASS · 28검사** (dial 14 · active 2 · bg 5 · **queue 7 신설**) |
| `critic-mux-attack` 11단계 | **10단계 green**, 남은 1건은 `raise.scroll`(R2.7 — 계약대로) |

크리틱 하네스 항목별:

| 단계 | R1 | R2 |
|---|---|---|
| `spam` | ✅ | ✅ (`badge-clean` 유지 — 자리표시자는 배지가 아니다) |
| `geom` | ❌ move-1-2 | ✅ `fixed-1-2 {dx:0,dy:0}` · `fixed-single-n1 {dx:0,dy:0}` |
| `side` | ❌ dup-slot1 · stale-live · raise-from-single | ✅ 5/5 |
| `viewer` | ✅ | ✅ 5/5 |
| `busydel` | ❌ silent | ✅ ctx-disabled · all-disabled |
| `bgdel` | ❌ deleted-while-running | ✅ live(증명) · blocked |
| `queue` | ❌ **misroute** · lost | ✅ no-misroute · home |
| `mid` | ✅ | ✅ 숫자 700개 · 구멍 0 |
| `foldrun` | ✅ | ✅ 7/7 |
| `raise` | ❌ scroll | ❌ scroll (**계약대로** — R2.7) |
| `stale` | ✅ | ✅ |

## R2.6 파리티 A/B

이번 라운드가 건드린 픽셀은 **여전히 다이얼 띠와 사이드바 안**이지만 **띠가 넓어졌다** —
접힘 배지 자리 예약(모든 화면), `.ma-head` gap 10→8, n1 `.h-ic` 박스 복원, TopBar 돋보기 1개.
전부 §2.1(다이얼 위치 고정) 규약을 지키기 위한 **의도된 이동**이고, R1이 이미 등재한
분기(`docs/renderer-divergence.md` §6)와 같은 영역이다. 스레드·컴포저·워크바는 무변경.

## R2.7 고치지 않은 것 — `raise.scroll` (⑧)

접었다 되올리면 **읽던 위치**가 안 돌아온다. 고치지 않았다:

- **스펙 §2.5가 "스크롤은 창 로컬 휘발, 이관하지 않는다"고 명시**했고 크리틱도
  *"계약 위반은 아니다"* 라고 적었다(등급 하).
- 접힌 자리는 렌더 대상에서 빠져 **언마운트**되고, 되올릴 때 꼬리 윈도잉(`useThreadWindow`)이
  스레드를 꼬리로 리셋한다 — 실측 `scrollHeight 6962 → 4676`. 예전 `scrollTop`(3103)을 그대로
  꽂으면 **다른 지점**에 착지한다. 하네스는 숫자만 보므로 통과하겠지만 사용자에게는 거짓이다.
- 제대로 하려면 픽셀 오프셋이 아니라 **읽던 메시지 id**를 앵커로 복원해야 하고, 그건
  윈도잉·팔로우 래치와 함께 설계할 일이다(꼬리 윈도잉을 소유한 라운드의 몫).

보고서 §2.4의 문장을 고친다: *"되올리면 같은 **자리 번호**로 돌아온다 — 대화는 온전하지만
**읽던 지점은 아니다**(스펙 §2.5: 스크롤은 창 로컬 휘발)."*

## R2.8 남은 것

**렌더러 밖(목록만 — 이번 경계 밖)**

1. **큐를 진짜로 Rust로 옮기려면** 엔진에 셋이 필요하다(R2.1 표):
   `chat:queue-mutate`에 `enqueue`/`remove`/`reorder` op · `QueuedMessage`에 `images`와
   정체성 스냅샷(picker) · **드레인이 `wire.begin_run` + 사용자 에코를 내도록**.
   셋 다 M-LOGIC 몫이고, 그때 렌더러는 `ChatMeta.queue` 대신 `chat:queue` REPLACE를
   그리면 된다(소비 지점이 `queue` state 하나라 교체는 한 곳이다).
2. `chat:status`의 `queued`(예약 수)는 지금 렌더러 큐와 **다른 값**이다(엔진 큐는 비어 있다).
   1이 끝나야 하나가 된다 — 그 전까지 사이드바·컴포저는 렌더러 큐를 진실로 본다.
3. `settled[]`의 나머지 소비처 — 백그라운드 셸 카드·서브에이전트 카드는 아직 자기 어휘
   (`teardown`/`stopped`)를 쓴다. 원장 id와 화면 항목 id가 같으므로 붙이는 것은 한 줄씩이다.

**렌더러 안(다음 라운드)**

4. `raise.scroll` — 메시지 id 앵커 복원(R2.7).
5. n1 두 갈래 통합 — 통합 풀 조회가 열리면 패널 어포던스 차이가 사라진다(§3 새 결정 2).
6. R1 §5의 남은 것 1~8은 그대로 유효하다.

## R2.9 파일 (R2에서 바뀐 것)

| 파일 | R2 변경 |
|---|---|
| `app/src/App.tsx` | 큐 소유권(`ChatMeta.queue`·`queueOwnerRef`·`landOnFreshChat`) · `drainBgQueue` · `buildRunRequest`/`promptWithNotes` 공용화 · `deleteLockOf`/`deleteAllLock`·`bgIds` · `chat:status` 구독+F12 따라잡기 · `chat:run-state` 정착 구독 · 폴백 다이얼로그 응답 · 부팅 폴백 착지 |
| `app/src/api/unified.ts` | `runChat`(`chat:run`) · `onChatRunState` · `onChatStatus` · `respondDialog` · 구독 헬퍼 |
| `app/src/lib/settled.ts` | **신설** — 정착 사유 레지스트리 + m-logic §5.2 어휘(`settleText`) |
| `app/src/store/session.ts` | `abortedTurn` 신설 · `effectiveStatus`가 중단 턴을 완료에서 뺀다 |
| `app/src/components/Sidebar.tsx` | `ChatSummary.lock` / `SidebarSection.deleteAllLock` · 잠긴 항목의 이유 카드·메뉴 잠금 · `live` 칩 축소 |
| `app/src/components/MultiAgent.tsx` | `raiseSlot`이 레코드 순서도 올린다 · n1 포커스 확정 · `PanelFindButton` · `FoldSlotHold`/자리 예약 · 「중단됨」 칩 |
| `app/src/components/Chat.tsx` | 폴백 확인 카드(`isFallbackAsk`·`dialog` 변형) · `ToolResult`의 정착 표시 |
| `app/src/styles.css` | `.ma-fold.hold`/`.ma-fold-hold` · `.ma-head` gap 8 · `.ma-p-head .h-ic` 스코프 · `.t-res.settled` · `.ctx-menu .cmwhy` |
| `scripts/poc-dial.mjs` | `--only=queue` 신설(7검사) · `--only=a,b` 다중 선택 · `seedBgHome(name)` · `bootAt` |

### 재현

```
npm run typecheck:app
rm -f target/release/agentcodegui.exe && npm run tauri:build
node scripts/poc-live-chat.mjs
node scripts/poc-dial.mjs                      # 28검사 (queue 7 포함, 실 CLI)
node scripts/poc-dial.mjs --only=dial,active   # 엔진 0턴만
node docs/critic/tools/critic-mux-attack.mjs --only=spam,geom,side,viewer,raise,stale   # 엔진 0턴
node docs/critic/tools/critic-mux-attack.mjs --only=queue,busydel,bgdel,mid,foldrun     # 실 CLI
```

> 크리틱 산출물(`docs/critic/m-ux-r1-{attack,dial}.json`)은 하네스가 덮으므로 이 라운드는
> **원본을 `git checkout`으로 되돌려 두었다** — 위 수치의 원천은 콘솔 출력이다.
