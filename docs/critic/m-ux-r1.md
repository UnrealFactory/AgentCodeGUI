# M-UX 렌더러 1단계 크리틱 **R1** — 다이얼은 섰고, 문 하나를 연 대가를 안 치렀다

판정 대상: `d62ce52`(구현) + `47a0c86`(증거) + `bd60bf1`(이식 장부 등재)
계약: `docs/design/ux-chat-unify.md` R3 · `docs/design/mockups/` · `docs/design/ux-parity-map.md`
보고서: `docs/m-ux-report-r1.md`

## 0. 측정 기준선 (동시 빌더 3명 — 흔들리는 바닥 고정)

| | |
|---|---|
| 시작 시점 HEAD | `bd60bf1` (작업 트리 clean) |
| 실측 빌드 | 그 트리로 `npm run tauri:build` (`rm -f target/release/agentcodegui.exe` 후) — 06:15 KST |
| 판정 대상 코드 | `app/` — 세션 내내 **한 글자도 안 바뀜**(`git diff bd60bf1 HEAD -- app/` 공백, `git status -- app/` 공백) |
| 오염 고지 | 다른 빌더가 06:47 KST에 공용 `target/release/agentcodegui.exe`를 재빌드했다(md5 `60ab34d0…`, 4,585,984B). 이후 회차는 그 셸을 썼다. **렌더러 번들은 동일**하고, 렌더러 findings(geom·side)는 재빌드된 셸에서 **다시 재현**해 확인했다 |
| 실행 규칙 | 이름 kill 0회 · spawn한 PID 트리만 · `CCG_HOME` 격리(`.critic-home-mux-*`, `.poc-home-dial*`) · 실홈은 읽기/복사만 |

산출물: `docs/critic/m-ux-r1-attack.json` · `m-ux-r1-recheck-{dial,bg}.json` ·
`m-ux-r1-pixdiff-{builder,repro}.json` · `m-ux-r1-dialshift.json` · `m-ux-r1-multi.json` ·
`docs/critic/shots/mux/*.png` · 하네스 `docs/critic/tools/critic-mux-{attack,pixdiff,dialshift,probe}.mjs`

---

## 1. 판정

> **조건부 불합격.** 다이얼 1~6 · 접힘 · 꼬리 수집기라는 이 라운드의 **본체는 합격**이고
> PoC 18검사·파리티 수치·멀티 게이트가 전부 독립 재현된다. 불합격 사유는 딱 한 조각,
> **스펙 ⑥(busy 중 전환 허용)** 이다 — 문은 열었는데 그 문 뒤에 있던 두 가지를 안 옮겼다:
> **예약 메시지(큐)의 소유자**와 **삭제 금지 가드의 범위.**
> 그 결과 (a) 예약한 프롬프트가 **남의 대화로 발사되어 실제로 실행되고**,
> (b) **자리 밖에서 스트리밍 중인 대화가 아무 저지 없이 삭제된다.**
> 보고서가 "그냥 열지 않았다 … 잃는 것이 없게 두 가지를 건다"고 쓴 바로 그 지점이다.
>
> 되집기는 싸다 — 보고서 §3의 ⑥ 행이 이미 방법을 적어 뒀다(`leaveActive()` 3곳 제거 +
> `if (busy) return` 복원). 큐를 `Chat`으로 옮기고 삭제 가드를 "도는 채팅 전부"로 넓히는
> 쪽이 정공법이고, 그 전까지 ⑥은 켜면 안 된다.

**재현은 전부 됐다.** `scripts/poc-dial.mjs` 3단계 전부 PASS 재현 —
dial 14검사(`m-ux-r1-recheck-dial.json`) · bg 3검사(`m-ux-r1-recheck-bg.json`, `BGDONE` 어시스턴트
말풍선 도착) · active 2검사(`{before:"fix-long-thread", after:"poc-a"}` — 클릭 120ms 뒤 스토어의
`activeChatId`가 이미 새 값, 저장 디바운스 600ms보다 먼저).
하네스가 장식이 아니라는 보고서의 주장도 사실이다 — 다만 **하네스가 물어보지 않은 것**에서
전부 깨졌다.

---

## 2. 공격에서 깨진 것 (심각도순)

### ① 치명 — 예약 메시지가 **남의 채팅으로 발사된다** (`queue.misroute`)

```
채팅 A(실행 중) → 컴포저에 'QUEUEDPROBE-9182' + Enter = 예약 1건 (.sched-item 확인)
→ 사이드바에서 채팅 B로 전환 (3.0이 새로 연 문)
→ 6초 뒤 B의 스레드:
   ["QUEUEDPROBE-9182",
    "I'm ready to assist. What would you like me to do with this AgentCodeGUI project"]
→ A로 돌아오면 A에는 그 프롬프트가 없다(hasProbe:false), 예약 목록도 비었다(stillQueued:0)
```

`queue`는 `App.tsx:167`의 **앱 단위 단일 state**이고 `ChatMeta`에도 `saveActive/restore`에도
없다. 2.6.2가 그래도 안전했던 이유는 바로 위 주석이 말한다 —
*"you can only enqueue while busy, and **you can't switch chats while busy**, so this single
list always belongs to the active chat"* (`App.tsx:164-166`). 이 커밋은 그 뒷문장을 지웠고
앞문장의 결론은 그대로 뒀다.

발사 경로: 전환 → `restore()` → `load(B.snapshot)` → `busy` true→false →
드레인 effect(`App.tsx:1229-1249`)의 `was=true, busy=false` 조건 성립 → `runPrompt`가
**지금 활성인 B**로 나간다. 주석이 예고한 그대로다.

피해가 표시 오류가 아니다 — B의 엔진이 **실제로 돌았다**. B의 폴더·모델·계정·모드로
남의 프롬프트가 집행된다(모드가 `bypass`/`acceptEdits`면 남의 폴더에 파일을 쓴다).
동시에 A에서는 예약이 증발한다(`queue.lost`).

### ② 높음 — **자리 밖에서 도는 채팅이 그대로 삭제된다** (`bgdel.deleted-while-running`)

```
스트리밍 중임을 chat:event 카운터 증가로 증명: {ev0:12, ev1:20, streaming:true}
→ 그 채팅을 사이드바 우클릭 → 삭제(메뉴 disabled 아님) → 확인 카드 → [삭제]
→ 목록: ["ATK 옆 채팅"]  ← 도는 대화가 사라졌다
```

`deleteChat`의 가드는 `if (id === activeChatId && (busy || wfAlive)) return` — **활성 채팅에만**
걸린다. 2.6.2에서는 "busy인데 활성이 아닌 채팅"이라는 상태 자체가 만들어질 수 없었으므로
이 가드로 충분했다. ⑥이 그 상태를 만들었고 가드는 안 넓혔다.
보고서 §2.5의 *"삭제만은 여전히 막는다 — 도는 엔진의 대화는 되돌릴 수 없다"* 는
**활성 채팅에 한해서만** 참이다. `deleteAllChats`도 같은 형태(`if (busy || wfAlive) return`,
활성 기준)라 같은 구멍이 있다.

### ③ 높음(규약) — busy 중 삭제가 **침묵 no-op**이 됐다 (`busydel.silent`)

```
busy 확인(.send.stop) → 사이드바 우클릭 → 「삭제」 (disabled 아님)
→ 확인 카드: "'ATK 도는 채팅' 채팅이 삭제돼요. 되돌릴 수 없어요."
→ [삭제] → 항목이 200ms 접혀 사라졌다가 **되살아난다** → 아무 문구도 안 뜬다
```

`sections[0]`에서 `busy`를 빼면서 `Sidebar`의 세 가드가 통째로 죽었다:
`askDelete`의 `if (s.busy && …) return`(`Sidebar.tsx:219`) · ctx 메뉴 `disabled`(`:459`) ·
「전체 삭제」 `disabled`+툴팁 *"작업이 끝난 뒤 지울 수 있어요"*(`:305,307`).
남은 것은 `App.deleteChat`의 조용한 `return` 하나뿐이다.
보고서는 *"no-op이 아니라 확인 카드가 이유를 말한다 — Sidebar의 busy 가드가 그 자리"* 라고
적었는데, **그 자리에 가드가 없다.** 2.6.2보다 나쁘다: 2.6.2는 애초에 못 눌렀고,
지금은 눌러서 확인까지 하고 삭제 애니메이션까지 본 뒤 아무 일도 안 일어난다.
M-LOGIC P7 「침묵 no-op 금지」 위반이며, 이 라운드가 없애겠다고 선언한 바로 그 형태다.

### ④ 중상 — 사이드바에서 접힌 대화를 고르면 **다른 대화가 열린다** (`side.raise-from-single`)

```
보드 6자리 → 다이얼 1(5개 접힘) → 일반 채팅으로 나감 → 사이드바에서 「벤치 패널 2」(⌄2) 클릭
→ 보드로 돌아오긴 한다. 그런데 1번 자리 = 「벤치 패널 1」  ← 내가 고른 대화가 아니다
   (대조군: 보드 안에서 같은 조작 → 「벤치 패널 2」 정상 승격)
```

`onSelectUnified`는 `switchMode('multi')`와 `multi.raiseSlot(slot)`을 같은 이벤트에서 부른다.
`raiseSlot`은 `raiseSeed.seq`만 올리는데, `ActiveSession`이 **그 직후 마운트**되면서
`const raiseSeqRef = useRef(raiseSeed?.seq ?? 0)`가 **이미 오른 seq로 초기화**된다 →
`useEffect`의 `seq === ref` 조건에 걸려 승격이 통째로 삼켜진다(`MultiAgent.tsx` 2078-2090 상당).
같은 자리의 `countSeed`는 `setActiveCount`가 `dataRef.current[activeId].count`를 **직접 쓰기**
때문에 마운트 초기값으로 살아남는다 — `raiseSeed`에는 그 대비책이 없다.
"대화가 사라지지 않는다"는 이 라운드의 약속이 클릭 한 번에서 어긋난다(사라지진 않지만 **못 간다**).

### ⑤ 중 — 「1번 자리」를 두 대화가 동시에 주장한다 (`side.dup-slot1` · `side.stale-live`)

일반 채팅 화면(보드 크롬 밖)에서 사이드바:

```
벤치 패널 1  [1] live      ← 보드는 화면에 없는데 "보이는 1번 자리"라고 말한다
벤치 패널 2  [⌄2] folded
…
벤치 긴 스레드 [1] live active   ← 지금 화면. 같은 「1」
```

`panelInfos`를 보드 크롬을 떠나도 비우지 않는 건 의도(코드 주석)지만, 그 대가로 칩의 의미
(*"이 대화가 지금 어느 자리에서 **보이는가**"* — `Sidebar.tsx:27-29`)가 거짓이 된다.
스펙 §2.6 불변식(같은 **보이는 자리**에 둘 금지)의 취지와도 정면으로 어긋난다.
접힘 안내 줄(*"이 배치의 5개 자리가 접혔어요"*)도 보드가 화면에 없는 동안 계속 뜬다.
보고서 §5-2는 "비활성 보드의 자리는 목록에 안 뜬다"만 적었고 이 반대 방향은 없다.
(보드를 **삭제**하면 목록은 제대로 비워진다 — `stale.cleared` 통과. 문제는 "떠나 있는 동안"뿐이다.)

### ⑥ 중 — §2.1 「다이얼은 화면에서 안 움직인다」가 실제로 깨진다 (`geom.move-1-2`)

`.ma-count` 실측 x좌표(1320×880, 같은 창):

| 상태 | x | 이동 |
|---|---|---|
| n6 (접힘 0) | 976 | — |
| n2 (접힘 4) | 929 | **−47px** |
| n1 (접힘 5) | 947 | +18px |
| 일반 채팅(IDE) | 949 | (n1 대비 +2 — 여기는 규약대로다) |

원인은 오른쪽 정렬 줄에서 **다이얼 뒤에 붙은 접힘 배지**와 **앞에 붙은 실행 요약 칩**이
나타났다 사라졌다 하는 것이다. 즉 **다이얼을 돌릴 때마다 다이얼이 움직인다.**

실사용 귀결을 따로 쟀다(`m-ux-r1-dialshift.json`, 버튼 폭 26px):

```
n6에서 「2」의 중심 x=1021 을 클릭 → n2가 된 뒤 같은 화면 좌표(1021)에 있는 버튼 = 「4」
n2에서 「1」의 중심 x=946  을 클릭 → n1이 된 뒤 같은 화면 좌표(946) = 다이얼 밖(.ma-p-head)
```

스펙 §2.1은 *"1↔2 전환에서 다이얼 버튼이 화면에서 이동하지 않는다 — 이게 '합쳐졌다'는
유일한 시각적 증거이므로 **위치 고정이 규약**"* 이라 못 박았고, 목업 `chat-unify-1-ide`의
주석 카드도 같은 문장을 그림 위에 적어 뒀다. 보고서는 `Chat.tsx`의 `dial` prop 주석에
*"다이얼 x좌표 고정 규약"* 이라 쓰면서 **재지 않았다.**
(정직하게 덧붙이면: 목업 `chat-unify-collapse`의 배치 순서도 배지를 다이얼 뒤에 두므로
목업 자체가 이 규약을 못 지킨다 — 자리를 예약하는 폭 고정이 필요하다. 계약의 자기모순이지만,
출하되는 건 코드이고 코드는 47px 튄다.)

### ⑦ 하 — n1의 TopBar에 **찾기 버튼이 없다**

스펙 §3.1/§2.1의 TopBar 오른쪽 목록: `다이얼 · 접힘 배지 · 실행 요약 칩 · **찾기** · 탐색기 토글 · 창 컨트롤`.
목업 `chat-unify-collapse`도 돋보기를 그렸다. 실물 n1의 패널 헤더 버튼 실측:

```
[컬러태그][이름바꾸기][제목잠금][폴더칩][별도 창으로][크게 보기][1..6][접힌 자리][파일 탐색기][─][□][✕]
```

돋보기가 없다(일반 채팅 헤더에는 있다 — `chat-thread.png` 대조). `ChatFind`는 패널 안에
살아 있어 **Ctrl+F는 동작한다** — 기능 손실이 아니라 어포던스 손실이다.
다만 보고서의 새 결정 2 *"두 갈래지만 사용자 눈에는 **같은 화면**"* 은 이것만으로도 거짓이다
(패널 어포던스 6개가 더 있고 돋보기가 없다 — 보고서는 앞의 차이만 고백했다).

### ⑧ 하 — 접었다 되올리면 **읽던 위치**는 안 돌아온다 (`raise.scroll`)

```
접기 전 3번 자리: scrollTop 3103 / scrollHeight 6962 (35% 지점)
↥ 로 1번 자리 복귀: scrollTop 3777 / scrollHeight 4676  ← 사실상 맨 아래(팔로우)
```

스레드 자체는 온전하다(내용 손실 0). 접힌 자리는 렌더 대상에서 빠져 언마운트되므로
스크롤은 휘발한다 — **스펙 §2.5가 "스크롤은 창 로컬 휘발, 이관하지 않는다"고 명시**했으니
계약 위반은 아니다. 다만 보고서 §2.4의 *"되올리면 같은 자리로 돌아온다"* 는 자리 번호 얘기지
읽던 지점 얘기가 아니라는 걸 문서가 구분해 주는 편이 낫다.

### ⑨ 맥락(이 라운드 잘못 아님) — 「1 = IDE 크롬」의 **내용물은 아직 검증 불가**

```
멀티/일반 양쪽에서 탐색기 토글은 열린다. 트리는 "비어 있음".
src-tauri/src/ipc/mod.rs 채널 목록에 fs 목록/파일 읽기/git 채널이 **없다**(fs:dir-exists뿐).
```

그래서 코드 뷰어·Git 카드·변경파일 카드는 3.0에서 아직 못 켠다. `reconcileChatRefs`의
**뷰어 재바인드(`.ma-rebind`)** 는 이 라운드의 자랑인데 **띄울 방법 자체가 없어 실측 못 했다**
(코드 경로는 읽었고 타당하다). 그리고 A/B 18화면 중 `explorer-git-strip`이 실패한 이유가
정확히 이것이다(before/after 동일 실패 = 회귀 아님), `git-repo-list`는 중첩 저장소 부재로 skip.
**보고서 §4.4는 이 2건을 표에서 통째로 빼고 "18화면"이라고만 적었다** — 커밋한 `report.json`
본문은 `attempted 17 · ok 16 · failed 1 · skipped 1`이다. 수치는 정직한데 서술이 반올림됐다.

---

## 3. 파리티 A/B — 항목별 판정

방법: 커밋된 `bench/shots/tauri-before` ↔ `bench/shots/tauri`(빌더 산출, `tauri-builder`로 보존)를
**내가 만든 도구로 다시** 쟀다(`critic-pixdiff.mjs`, 채널 임계 24, 왼쪽 칼럼 x<250 별도 집계).
그리고 `bench/ab.mjs tauri`를 같은 18 id로 **내 빌드에서 재캡처**해 빌더 산출과 대조했다.
`blind.mjs --apps=tauri-before,tauri-builder --seed=4242`로 16쌍 블라인드 배치도 만들었다
(`bench/shots/blind.html`).

| 화면 | 임계 초과(x≥250) | 위치 | 판정 |
|---|---|---|---|
| chat-thread · chat-header · composer · workbar *(4개가 **동일 파일**, md5 `218a105…`)* | 791 | x953–1109 y7–30 | ✅ 파리티 — 차이는 다이얼 한 덩어리 |
| chat-welcome | 791 | 같은 띠 | ✅ |
| sidebar · sidebar-empty *(**동일 파일** `6339684…`)* | 791 | 같은 띠 | ✅ (왼쪽 칼럼 1,260px = 의도된 2섹션) |
| sidebar-ctx-menu | 791 | 같은 띠 | ✅ (왼쪽 1,222) |
| chat-find | 806 | 띠 + 찾기 바 | ✅ |
| settings-api · settings-display · settings-mcp | 753 | x951–980 y5–32 | ✅ 모달 위로 비치는 다이얼 |
| multi-grid-empty · multi-grid-counts | **38** | x990–996 y14–22 | ✅ 늘어난 「1」 글자뿐 |
| multi-panel-expanded | 15 | x260 y819–833 | ✅ 캐럿 깜빡임(노이즈) |
| sidebar-deleteall-confirm | 1,712 | x606–980 y5–441 | ✅ 의도(섹션 라벨·개수 문구) |
| explorer-git-strip | — | — | ⚠️ **도달 실패**(before/after 동일) — §2-⑨ |
| git-repo-list | — | — | ⚠️ skip(중첩 .git 없음) — 하네스 한계, 정당 |

**보고서 §4.4의 수치는 한 자리도 안 틀렸다.** 791 / 806 / 753 / 38 / 15 / 1,712, 좌표까지 일치한다.
"다이얼·사이드바 밖에서 바뀐 픽셀 0"도 참이다(바운딩 박스가 전부 그 두 영역 안).

**재현성**: 내 빌드 재캡처 ↔ 빌더 산출 = 12/16 id에서 **0px**. 나머지 4개는 위의 동일 파일
1프레임(chat-thread 계열)이고 53,413px 차이의 정체는 **스레드 스크롤 ~5px 오프셋**이다
(두 이미지를 눈으로 대조 — 내용 동일). 즉 커밋된 "after" 픽셀은 커밋된 코드에서 나온 것이 맞다.

**표본에 대한 비판 하나**: "18화면"의 실체는 **12개 서로 다른 프레임**이다(위 표의 *동일 파일* 표시).
156행 사영표 대비 7.7%이고, 그중 이 라운드의 간판(IDE 크롬의 내용물)을 건드리는 2건이
도달 실패다. 파리티 자체는 깨끗하지만 **덮은 넓이는 보고서가 주는 인상보다 좁다.**

**변경 화면 ↔ 목업 대조**(목업을 직접 렌더해 `docs/critic/shots/mux/`에 남김):

| 축 | 목업 | 실물 | 판정 |
|---|---|---|---|
| n1 TopBar 왼쪽 | 채팅 제목 + 폴더 칩 | + 자리번호 칩·상태 칩·팝아웃·크게보기 | 보고서가 고백한 의도 ① — 수용 |
| n1 TopBar 오른쪽 | 실행칩·다이얼·접힘배지·**찾기**·탐색기·창컨트롤 | 찾기 **없음** | §2-⑦ |
| 다이얼 x 고정 | 주석 카드가 명문화 | 47px/18px 이동 | §2-⑥ |
| 접힘 배지·팝오버 | ⌄N · 자리번호·제목·상태·↥ | 동일 | ✅ |
| 팝오버 「자리 비우기」 | 목업엔 없음(스펙 §2.2-3엔 있음) | 없음 | 목업과는 일치 · **스펙과는 불일치**(보고서 미기재) |
| 사이드바 2섹션·자리 칩·접힘 안내 | 동일 | 동일 | ✅ |

---

## 4. 스펙 기본값 ①~⑬ 실물 대조

| # | 보고서 주장 | 실물 | |
|---|---|---|---|
| ① 2섹션 | 채택 | 「채팅」+「배치」 확인 | ✅ |
| ② 접힘 고지 | 배지·팝오버·요약칩·안내줄 | 4종 다 있음 | ✅ (「자리 비우기」 누락 미기재) |
| ③ 접혀도 계속 돈다 + 칩 | 채택 | `foldrun`: 칩 「접힌 자리 실행 1」 · 사이드바 run 배지 + run 점 · 완료 시 둘 다 해제 · 팝오버 「완료」 · 되올리면 스레드 3,092자 복원 | ✅ **완전 검증** |
| ⑤ 대기표 재장전 | 미적용 | 미적용 | ✅ |
| ⑥ busy 전환 허용 | 허용 + 꼬리 수집 + 삭제 금지 | 전환·꼬리 ✅ / **삭제 금지 ✗**(§2-②③) / **큐 ✗**(§2-①) | ❌ |
| ⑦ 보드 목록 유지 | (a) | 「배치」 섹션 | ✅ |
| ⑧ 빈 자리 | 2.6.2 그대로 | 그대로 | ✅ |
| ⑨ Board.chrome 내부값 | 내부값 | count===1이 곧 ide | ✅ |
| ⑩ NewChatModal | 현행 유지 | 2~6 그대로 | ✅ |
| ⑪ 읽지 않음 | 안 만듦 | 없음 | ✅ |
| ⑫ 배율 키 | n1=chat.zoom | `useZoom(count===1?'chat.zoom':'multi.zoom')`, 훅이 키 변경 시 재조회(`zoom.tsx:39-41`) | ✅ |
| ⑬ | 미적용(목업만) | 목업 3장 존재 | ✅ |

**절차 지적 하나.** 스펙 §8은 *"[U] 사용자 결정 대기 — **코드를 쓰기 전에** 사용자가 골라야 한다:
①②③④⑦⑧⑨⑩⑪⑫⑬"* 이라 못 박았고 **[B](구현 중 확정)는 ⑤⑥ 둘뿐**이다.
이번 라운드는 ①②③⑦⑧⑨⑫를 사용자 결정 없이 코드로 굳혔다. 되집기 경로를 다 적어 둔 건
성실하지만, 지시를 따른 것은 아니다. (④는 표에서 아예 빠졌다 — 「창 자리 재구현 금지」와
겹치므로 누락이 자연스럽지만, 표가 "①~⑬ 중 굳힌 것"이라고 선언한 이상 한 줄이 필요하다.)

**새로 굳힌 3건의 타당성**

1. **n1 TopBar 호스트 = 그 자리의 패널 헤더** — 근거(줄을 안 쌓는다)는 옳고, 팝아웃·크게보기에서
   `.ma-head`를 되살리는 함정 방어도 **실측으로 확인**했다(`viewer.popout-chrome` / `viewer.expand-chrome`:
   두 경우 모두 다이얼 1개·창 컨트롤 생존). 대가는 §2-⑥·⑦ — **대가를 다 적지 않았다.**
2. **1 모드의 두 갈래** — "사용자 눈에는 같은 화면"이 **거짓**이다(§2-⑤ 사이드바 「1」 중복,
   §2-⑦ 찾기 부재, 헤더 어포던스 6개 차이). 과도기 모양이라는 판단 자체는 타당하나 문장을 고쳐야 한다.
3. **사이드바 항목 키 = panelId** — 타당. 2단계에서 chatId로 갈아끼우는 설계가 실제로 한 줄이다.

---

## 5. 멀티 게이트 — 렌더러 대공사가 성능을 안 깼다 ✅

`node bench/multi.mjs tauri --repeats=3` (내 빌드, 3회 중앙값 — 결과는 `docs/critic/m-ux-r1-multi.json`,
커밋된 기준 파일 `bench/results/multi-tauri-3.0.0-default.json`은 **백업 후 원본 복원**)

| 지표 | 커밋 기준(5회) | 지시 밴드 | 이번(3회) | 판정 |
|---|---|---|---|---|
| 유휴 그리드 WS / Priv | 424.0 / 242.0 | 431.3 / 247.2 | **431.8 / 246.1** | 밴드 안 |
| 프로세스 | 5 | — | 5 | 동일 |
| 창당 비용 | 24.7MB · +0 | — | **21.8MB · +0** | 개선 |
| 패널 1개 스크롤 | 56.7fps · p95 23.1 · 드랍 0.3% | — | **57.9 · 21.3 · 0%** | 개선 |
| 4패널 동시(부하 팔) | 58.0 · p95 20.1 · 0% | — | **59.0 · 18.0 · 0%** | 개선 |

3회 전부 드랍 0%. `order` 조작이 엔진을 재스폰하지 않는다는 보고서의 설명과 수치가 맞는다.

---

## 6. 안 깨진 것 (공격 실패 — 기록으로 남긴다)

- **다이얼 연타** `1→6→1→6` / `6→1→6→1` / `1→3→1→6` 을 30ms 간격으로 두들겨도
  자리 수·`.ma-head` 개수·다이얼 개수가 전부 최종값과 일치하고, 6대화 전부 생존·순서 보존,
  n6에서 접힘 배지 잔상 0 (`spam.*`).
- **꼬리 수집기 — PoC보다 센 조건에서도 무손실.** PoC는 턴이 **끝난 뒤** 돌아왔다.
  나는 **스트리밍 한복판에 떠나서 스트리밍 한복판으로 돌아왔다**:
  떠날 때 23자 → 돌아올 때 1,903자 → 계속 자라 2,691자 → 최종 **숫자 700개, 구멍 0개**,
  복귀 직후 실행 표시 유지(라이브 리듀서가 끊김 없이 이어받는다). 사이드바 실행 배지도
  `chat:event` 증가로 라이브를 증명한 상태에서 정상 표시(`mid.*`).
  ("2.6.2에도 있던 언로드 스윕 경쟁을 닫았다"는 주장의 실효도 여기서 간접 확인된다 —
  `sentSnaps`/`bgSnapRef` 가드가 없으면 이 700개가 안 온다.)
- **팝아웃 유령이 1번 자리일 때**도 창 컨트롤·다이얼 생존, 사이드바 「창」 칩 정상(`viewer.popout-*`).
- **보드 삭제** 시 그 자리 항목들이 사이드바에서 정상 제거(`stale.cleared`).
- **보드가 없는 일반 채팅에서 다이얼 4** → 4자리 보드 정상 생성(`raise.dial-from-single`).
- `npm run typecheck:app` 통과.

---

## 7. 가장 큰 격차 **하나**

> **스펙 ⑥을 "여는" 작업이 열리는 문 뒤의 상태 소유권을 안 옮겼다.**
>
> 2.6.2에서 `queue`·`limitResume.hold`·삭제 가드는 전부 **"활성 채팅 = 유일하게 도는 채팅"**
> 이라는 전제 위에 서 있었고, 그 전제를 지키던 것이 바로 "busy면 못 떠난다"였다.
> 이 커밋은 그 문을 열면서 `chat:event` 꼬리 수집기 **하나만** 만들었다 — 스레드는 지켰지만
> 같은 전제에 기대던 나머지는 그대로 뒀다. 결과가 §2의 ①②③이다.
>
> 고칠 곳은 세 군데다: **큐를 `ChatMeta`로 내리고**(전환 시 같이 저장/복원, 드레인 조건에
> `owner === activeChatId` 추가), **삭제 가드를 "도는 채팅 전부"로**(`busy || bgSnapRef.has(id)`),
> **삭제가 막힐 땐 카드가 이유를 말하게**(`sections[0].busy` 복원 또는 확인 카드 문구 분기).
> 셋 다 렌더러 안에서 끝나고, 셋 다 이 커밋이 만든 상태(`bgSnapRef`)로 판정 가능하다.
> 그 전까지 ⑥은 **되집는 편이 안전하다** — 보고서 §3이 이미 되집는 법을 적어 뒀다.

---

## 8. 재현 방법

```bash
node scripts/poc-dial.mjs --only=dial      # 14검사  (보고서 재현)
node scripts/poc-dial.mjs --only=active    # 2검사
node scripts/poc-dial.mjs --only=bg        # 3검사 (실 CLI 1턴)

node docs/critic/tools/critic-mux-attack.mjs --only=spam      # 다이얼 연타
node docs/critic/tools/critic-mux-attack.mjs --only=geom      # §2.1 좌표 고정
node docs/critic/tools/critic-mux-attack.mjs --only=side      # 사이드바 의미·승격 라우팅
node docs/critic/tools/critic-mux-attack.mjs --only=viewer    # 고아 UI·팝아웃·크게보기
node docs/critic/tools/critic-mux-attack.mjs --only=busydel   # 실행 중 삭제 (실 CLI)
node docs/critic/tools/critic-mux-attack.mjs --only=bgdel     # 자리 밖 실행 삭제 (실 CLI)
node docs/critic/tools/critic-mux-attack.mjs --only=queue     # ★ 예약 오발사 (실 CLI)
node docs/critic/tools/critic-mux-attack.mjs --only=mid       # 스트리밍 중 왕복 (실 CLI)
node docs/critic/tools/critic-mux-attack.mjs --only=foldrun   # 접힌 자리 실행 (실 CLI)
node docs/critic/tools/critic-mux-attack.mjs --only=raise     # ↥ 복귀·스크롤·보드 없는 다이얼
node docs/critic/tools/critic-mux-attack.mjs --only=stale     # 보드 삭제 후 목록

node docs/critic/tools/critic-mux-dialshift.mjs               # 좌표 이동의 오클릭 귀결
node docs/critic/tools/critic-mux-probe.mjs --n=1             # n1/일반 채팅의 IDE 크롬 조각 더듬기
node docs/critic/tools/critic-pixdiff.mjs bench/shots/tauri-before bench/shots/tauri --thr=24 --xmin=250
node bench/blind.mjs --apps=tauri-before,tauri --seed=4242    # 항목별 블라인드 배치
node bench/multi.mjs tauri --repeats=3                        # 기준 파일 백업 후 실행할 것
```

목업 렌더(`docs/critic/shots/`는 gitignore라 각자 다시 뜬다 — Git Bash에서 **역슬래시 경로는
JSON이 깨지므로 슬래시**로):

```bash
export SHOT_JOBS='[{"src":"C:/Code/AgentCodeGUI/docs/design/mockups/chat-unify-1-ide.html",
                    "out":"C:/Code/AgentCodeGUI/docs/critic/shots/mux/chat-unify-1-ide.png"}]'
export SHOT_RESULT_FILE='C:/Users/User/AppData/Local/Temp/muxshot.json'
./node_modules/electron/dist/electron.exe scripts/poc-glass/shot-html-main.cjs
```
> `scripts/poc-glass/shot-html.mjs` 래퍼는 `os.tmpdir()`을 쓰므로 그냥 돌아가지만,
> 6장을 `--all`로 한 번에 주면 HARD 타임아웃에 걸린다(장당 45초 예산). **한 장씩** 돌리면 3초다.

> 실 CLI를 쓰는 단계는 **긴 턴**이 필요하다(숫자 700개 쓰기). 짧은 프롬프트로 돌리면
> 접기·삭제 시점에 이미 턴이 끝나 축을 못 잰다 — 1차 실행에서 실제로 밟았고,
> 그래서 각 단계에 `chat:event` 카운터 증가로 **라이브임을 증명**하는 검사를 넣었다.
