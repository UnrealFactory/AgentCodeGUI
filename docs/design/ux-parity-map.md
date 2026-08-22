# 화면 사영표 — 2.6.2의 모든 화면은 통합 모델의 어디로 가는가

동반 문서: `docs/design/ux-chat-unify.md` (M-UX 채팅 통합 스펙 R2)
대조 원본: `docs/screen-inventory.md` · 얼린 2.6.2 소스(`src/`)

## 0. 이 표가 존재하는 이유

크리틱 R1의 메타 판정: **"통합 모델에 자리가 없는 화면이 스펙 안에서 스스로 드러나지 않는다."**
R1 스펙의 §0 「이중 배선 7종」 표는 *자기가 아는 것만* 센 목록이었고, 실제로는 코드 뷰어를
포함해 여덟 갈래를 더 놓쳤다(§4). 북극성이 "한 번만 구현"인데 **무엇이 몇 번 구현돼 있는지
세는 대장이 없었다.** 이 문서가 그 대장이다.

규칙 세 개:
1. 인벤토리의 **모든** id가 이 표에 한 줄씩 있다. 행선지 없는 행은 0이어야 한다.
2. 행선지가 **두 칸 이상**이면 그건 "아직 이중 배선"이다 — 통합 방법을 한 줄로 적는다(§4).
3. 「사라짐」 칸에는 **사용자 승인이 필요한 문장**을 함께 적는다(§5).

## 1. 표기법 — 행선지 6종

R2 §3.1이 확정한 껍데기 구조에 대응한다.

| 기호 | 이름 | 뜻 |
|---|---|---|
| **S** | `ChatSurface` | 채팅 하나를 그리는 유일한 컴포넌트. **껍데기 3종 전부에서 같은 코드**가 돈다 |
| **I** | `IdeShell` | count=1 자리 껍데기 (전폭) |
| **G** | `GridCell` | count≥2 자리 껍데기 (패널 헤더 + zoom .8) |
| **W** | `WindowShell` | 별도 OS 창 자리 껍데기 (추가 채팅 창 + 팝아웃 창 통합) |
| **A** | 앱 크롬 | 자리 **밖**. 메인 창에 하나만 있고 다이얼 값과 무관하다 (왼쪽 칼럼·코드 뷰어·Git·설정·토스트…) |
| **Aw** | 창 크롬 | `WindowShell`이 자기 창 안에 갖는 **앱 크롬 축소판**. 2.6.2 실측 = 뷰어·이미지 라이트박스·서브에이전트 카드 **셋뿐**(탐색기·Git·설정은 메인 창 전용 — `SessionWindow.tsx`·`PanelWindow.tsx`에 import 0건) |
| **X** | 사라짐 | 통합으로 화면 자체가 없어진다 — §5에 승인 문장 |
| **N** | 범위 밖 | 3.0.0에서 이식하지 않음(Verse — 커밋 `f3b8104`, 사용자 결정) |

「2.6.2 배선」 열은 **렌더 지점 수**(같은 컴포넌트를 몇 군데서 그리는가)다. 전부 grep 실측이다.

## 2. 통계

| 항목 | 수 |
|---|---|
| 인벤토리 표의 전체 행 | **161** |
| ─ 그중 「표면(surface) 표기」 범례 행 | 5 |
| **실제 화면 수** | **156** |
| 행선지 확정 | **156** (미배정 0) |
| 범위 밖(Verse) — 화면 통째 | **2** (`explorer-verse-section`, `explorer-verse-digest`) |
| 범위 밖 — 화면 안의 일부 항목만 | **2** (`settings-code-lsp`의 Verse 서버 행, `settings-code-expanded`의 Verse 연결 하위옵션) |
| 사라짐 | **1 확정**(`new-chat-step1`) + **1 조건부**(`new-chat-step2` — 열린 문제 ⑩) |
| 행선지가 두 칸 이상인 **행** | **35** (§1 1 · §2 3 · §5 25 · §8 3 · §9 3) |
| ─ 그중 「아직 이중 배선」이라 통합 방법을 적어야 하는 **갈래** | **14** (§4) |
| 2.6.2에서 이미 **4벌**로 배선돼 있던 것 | **5종** — 승인/질문 카드 · 코드 뷰어 · 이미지 라이트박스 · 서브에이전트 카드 · 폴더 변경 카드 |

> **「161화면」은 표의 행 수이고 실제 화면은 156이다.** 인벤토리 자체는 틀리지 않았지만
> (범례도 표 형식이라 같이 세졌다) 파리티 게이트의 분모로 쓰려면 156이 맞는 수다.
> 절별 실측: §1 3 · §2 42 · §3 12 · §4 14 · §5 26 · §6 10 · §7 19 · §8 17 · §9 5 · §10 8 = 156.
> (크리틱이 인용한 "8절 17 · 9절 5 · 5절 26"과 일치한다.)

---

## 3. 사영표

### §1 부팅 · 안전망 (3)

| id | 2.6.2 배선 | 행선지 | 한 줄 |
|---|---|---|---|
| `boot-splash-native` | 1 (main `createSplash`) | **A** | 변화 없음. Tauri 이식은 M1 소관 |
| `boot-loading` | 1 | **A** | `chats:get(light)` + `board:get` 대기 화면으로 재정의. `multi-hydrate`가 여기로 합류(2벌 → 1벌) |
| `error-boundary` | 2 (`App.tsx:1787` 앱 루트 · `:1474` 멀티 전체) | **A + I/G/W** | 껍데기 공통 래퍼 1벌. **자리 단위 경계**가 된다 — 2.6.2는 멀티 전체가 한 경계라 패널 하나의 예외가 6자리를 같이 죽였다 |

### §2 본채팅 (42) — 42 중 37이 `ChatSurface` 한 벌

| id | 2.6.2 배선 | 행선지 | 한 줄 |
|---|---|---|---|
| `chat-thread` | 3 (App·PanelView·SessionWindow) | **S** | 스레드·`useThreadWindow`·`useThreadFollow` |
| `chat-welcome` | 3 | **S** | 빈 채팅 웰컴. **빈 *자리* 타일(`multi-grid-empty`)과는 다른 화면** — 자리는 비었고 채팅은 없다 |
| `chat-working` | 3 | **S** | |
| `chat-jump-bottom` | 3 | **S** | |
| `chat-find` | 3 | **S** | 대상 = **포커스 자리의 스레드**(R2 §3.4 포커스 규약). 2.6.2는 활성 채팅 하나뿐이라 모호함이 없었다 — U9가 지적한 자리 |
| `chat-selection-bar` | 3 | **S** | |
| `chat-gesture-overlay` | 3 | **S** | 제스처는 자리 스코프(`.chat-scroll` 기준) |
| `chat-zoom-badge` | 4 배율 키 (`chat.zoom`·`multi.zoom`·`multi.expand.zoom`·`session.zoom`) | **S** | 배율 키를 **크롬별 3개**로 재정의(R2 §4.2 pref 표). 4→3은 값 승계 결정이 필요 — 열린 문제 ⑫ |
| `chat-folder-pop` | 2 (`.hfold` · 패널 `.ma-p-folder`) | **S** | `identity.cwd`/`addDirs` 한 소스. `multi-panel-folder-pop`과 같은 부품 |
| `chat-header` | 3 (`.chat-head` · `.ma-p-head` · `.pw-head`) | **A(TopBar) + G + W** | 실제로 **다른 헤더 셋**이라 이중 배선이 아니다. 단 안쪽 부품(제목 칩·폴더 칩·상태 칩·찾기)은 공용 1벌 → §4-11 |
| `composer` | 3 | **S** | |
| `composer-two-line` | 3 | **S** | |
| `composer-picker-pop` | **3 소유처** (App useState · `PanelMeta.picker` · `SessionChatRecord.picker`) | **S** | `Chat.identityOverrides` 하나. M-LOGIC의 `chat:identity-set` 왕복 |
| `composer-slash-palette` | 3 | **S** | |
| `composer-mention-palette` | 3 | **S** | 멘션 기준 폴더 = 그 채팅의 cwd |
| `composer-attachments` | 3 | **S** | |
| `composer-queue` | 2 소유처 (App state · `PanelMeta.queue`) | **S** | `Chat.queue`. 드레인은 Rust `ChatRuntime`(m-logic §7.2) |
| `composer-drop-hint` | 3 | **S** | |
| `limit-hold-bar` | **3 렌더 / 9 훅 인스턴스** | **S** | 훅 채팅당 1개. `LimitHoldBar`가 30초 틱 소유(`Chat.tsx:2729`·`useLimitResume.ts:169-171`) |
| `workbar` | 3 | **S** | |
| `workbar-todo-pop` | 3 | **S** | |
| `workbar-subagent-pop` | 3 | **S** | |
| `workbar-shell-pop` | 3 | **S** | |
| `workbar-file-pop` | 3 | **S** | |
| `workbar-context-pop` | 3 | **S** | |
| `workbar-context-pop-api` | 3 | **S** | 과금 = `identityOverrides.billing`(전역 `api.mode` 상속) — U10 |
| `bash-log-modal` | 1 (`Chat.tsx:389`, 전 표면 공용) | **S** | |
| `bgtask-modal` | 1 (`Chat.tsx:2983`) | **S** | |
| `subagent-modal` | **4** (App:1663 · MA:1928 · SW:888 · PW:531) | **S** | R1 §0 표가 놓친 이중 배선 — §4-3 |
| `cmd-result-card` | 1 | **S** | |
| `question-card` | **4** (App:1674 · MA:757 · SW:865 · PW=PanelView) | **S** | 자리 스코프. 접힌 자리에서 뜨면 → R2 §2.2-5 알림 규약 |
| `question-card-multistep` | 4 | **S** | |
| `question-mini` | 4 | **S** | 접힘 상태에서도 알약은 그 자리 안. 밖으로는 배지·칩·토스트가 알린다 |
| `permission-card` | **4** (App:1676 · MA:752 · SW:863 · PW=PanelView) | **S** | |
| `workflow-dock` | **3 렌더 / 4 표면** (App:1671 · MA:751 · SW:864) | **S** | |
| `workflow-card` | 3 | **S** | |
| `btw-dock` | **2** (App:1667 · MA:750) | **S** | `btwOf === 내 chatId` 필터. 슬롯 역산(`slotOfPanelId`) 소멸 |
| `image-lightbox` | **4** (App:1655 · MA:1934 · SW:891 · PW:533) | **A + Aw** | R1 §0 표가 놓친 이중 배선 — §4-2 |
| `image-lightbox-strip` | 4 | **A + Aw** | |
| `folder-switch-dialog` | **4** (App:1679 · MA:1906 · SW:868 · PW:524) | **S** | M-LOGIC `IdentityVerdict.needs_confirm`의 표시 형태로 흡수 — §4-5 |
| `autohide-preview` | 1 | **A** | 왼쪽 칼럼 설정 |
| `sidebar-autohide-edge` | 1 | **A** | |

### §3 사이드바 · 새 채팅 · 프롬프트 (12) — 전부 앱 크롬

| id | 2.6.2 배선 | 행선지 | 한 줄 |
|---|---|---|---|
| `sidebar` | 1 (`App.tsx:1465`, **mode 분기 밖**) | **A** | 3섹션(일반/멀티/추가) → 「채팅」+「배치」(+「창」). 최종 구성은 열린 문제 ①, 비교 목업 `chat-unify-sidebar-abc.html` |
| `sidebar-section-search` | 1 | **A** | |
| `sidebar-empty` | 1 | **A** | |
| `sidebar-ctx-menu` | 1 | **A** | 항목에 「이 자리로 보내기」·「창으로 열기」 추가(자리 배정이 사이드바에서 가능해진다) |
| `sidebar-rename-inline` | 1 | **A** | `multi-panel-rename`(F2)과 같은 부품 → §4-8 |
| `sidebar-delete-confirm` | 1 | **A** | 삭제 = 풀에서 제거 + 전 보드 slots에서 정화 + `chat:dispose` |
| `sidebar-deleteall-confirm` | 1 | **A** | |
| `new-chat-step1` | 1 | **X 사라짐** | 「일반/멀티」 구분이 없어진다 — §5-1 승인 문장 |
| `new-chat-step2` | 1 | **A** (조건부 X) | 「패널 수 2~6」 → 「1~6」 한 단계. 모달 자체를 없애고 다이얼만 남길지 = 열린 문제 ⑩ |
| `prompt-library-list` | 1 | **A** | |
| `prompt-library-editor` | 1 | **A** | |
| `prompt-library-delete` | 1 | **A** | |

### §4 파일 탐색기 (14) — 전부 앱 크롬. **2.6.2에서도 mode 분기 밖에 있었다**

`App.tsx:1432-1466`이 근거다. 왼쪽 칼럼은 single/multi 어느 쪽에서도 산다 —
R1 §3.1이 이걸 `<IdeShell>`(count=1 전용) 안에 넣은 것이 U4의 핵심이고, R2는 목업 쪽(=앱 크롬)으로 고쳤다.

| id | 2.6.2 배선 | 행선지 | 한 줄 |
|---|---|---|---|
| `explorer-tree` | 2 렌더 (`App.tsx:1438` single · `:1452` multi `multiExp`) | **A** | 추종 대상 = **포커스 자리의 채팅 cwd** 하나. mode 분기 소멸 → §4-6 |
| `explorer-blank` | 2 | **A** | |
| `explorer-search` | 2 | **A** | |
| `explorer-search-empty` | 2 | **A** | |
| `explorer-hidden-on` | 2 | **A** | |
| `explorer-ctx-menu` | 2 | **A** | |
| `explorer-fileop` | 2 | **A** | |
| `explorer-fileop-delete` | 2 | **A** | |
| `explorer-notice` | 2 | **A** | |
| `explorer-verse-section` | 2 | **N 범위 밖** | Verse 전체 제거(`f3b8104`) |
| `explorer-verse-digest` | 2 | **N 범위 밖** | |
| `explorer-git-strip` | 2 | **A** | 저장소 = 포커스 자리의 폴더 |
| `explorer-settings-foot` | 2 | **A** | |
| `changed-files-modal` | **1** (`App.tsx:1614` — 창엔 없다) | **A** | 대상 = `viewerTarget.chatId ?? 포커스 자리`. 2.6.2는 `mode==='multi' ? multiExp.files : state.files` 삼항 |

### §5 코드 뷰어 (26) — **전부 앱 크롬 단일 인스턴스.** R1이 통째로 빠뜨린 갈래

2.6.2는 `FileModal`을 **네 군데**에서 렌더한다: `App.tsx:1640` · `SessionWindow.tsx:879` ·
`PanelWindow.tsx:528` · `MultiAgent.tsx:1918`. `panel-window-viewer`는 인벤토리의 **[검증됨]** 화면이다.
R2는 뷰어를 앱 크롬으로 올리고 **`viewerTarget: { chatId, path, from }`** 한 값을 준다 —
diff 출처·질문 대상·변경파일 스코프가 전부 이 한 값에서 나온다(U9의 답).

| id | 2.6.2 배선 | 행선지 | 한 줄 |
|---|---|---|---|
| `viewer-code-read` | **4** | **A + Aw** | |
| `viewer-code-edit` | 4 | **A + Aw** | |
| `viewer-code-dirty` | 4 | **A + Aw** | |
| `viewer-code-saved` | 4 | **A + Aw** | |
| `viewer-diff-on` | 4 | **A + Aw** | diff 출처 = `viewerTarget.chatId`의 `diffs`. 2.6.2는 표면마다 다른 state를 넘겼다 |
| `viewer-markdown-preview` | 4 | **A + Aw** | |
| `viewer-markdown-source` | 4 | **A + Aw** | |
| `viewer-image` | 4 | **A + Aw** | |
| `viewer-html-preview` | 4 | **A + Aw** | `ccg-page` 스킴 규약 유지 |
| `viewer-html-code` | 4 | **A + Aw** | |
| `viewer-svg-preview` | 4 | **A + Aw** | |
| `viewer-svg-source` | 4 | **A + Aw** | |
| `viewer-loading` | 4 | **A + Aw** | |
| `viewer-empty` | 4 | **A + Aw** | |
| `viewer-truncated` | 4 | **A + Aw** | |
| `viewer-find` | 4 | **A + Aw** | |
| `viewer-cm-find` | 4 | **A + Aw** | |
| `viewer-selection-ask-bar` | **2** (App:1649 · SW:884 — **MA·PW엔 없다**) | **A + Aw** | 통합 = **확장**. 멀티·팝아웃에서 처음으로 생긴다(회귀 아님) |
| `viewer-ask-panel` | **2** | **A + Aw** | 질문 대상 = `viewerTarget.chatId`. 뷰어 헤더에 **대상 채팅 칩**을 그려 어디로 가는지 보인다. **전송해도 뷰어를 닫지 않는다**(2.6.2 `App.tsx:1157 setOpenFilePath(null)` — 메모리의 미결 불편) |
| `viewer-hover-card` | 4 | **A + Aw** | LSP — 채팅과 무관 |
| `viewer-header-ctx-menu` | 4 | **A + Aw** | |
| `viewer-maximized` | 4 | **A + Aw** | |
| `viewer-back-forward` | 4 | **A + Aw** | |
| `viewer-close-confirm` | 4 | **A + Aw** | |
| `viewer-save-error` | 4 | **A + Aw** | |
| `viewer-git-snapshot` | 4 | **A** | Git 카드에서만 진입 — 창엔 Git이 없다 |

### §6 Git 카드 (10) — 전부 앱 크롬(메인 창 전용)

| id | 2.6.2 배선 | 행선지 | 한 줄 |
|---|---|---|---|
| `git-changes` | **1** (`App.tsx:1626`) | **A** | 폴더 = 포커스 자리(2.6.2 주석 `App.tsx:1624`와 같은 규칙) |
| `git-history` | 1 | **A** | |
| `git-commit-detail` | 1 | **A** | |
| `git-repo-list` | 1 | **A** | |
| `git-new-branch` | 1 | **A** | |
| `git-ai-commit-step1` | 1 | **A** | 자체 계정 picker — 채팅 identity와 무관(2.6.2 그대로) |
| `git-ai-commit-step2` | 1 | **A** | |
| `git-discard-confirm` | 1 | **A** | |
| `git-switch-confirm` | 1 | **A** | |
| `git-error` | 1 | **A** | |

### §7 설정 모달 (19) — 전부 앱 크롬

| id | 2.6.2 배선 | 행선지 | 한 줄 |
|---|---|---|---|
| `settings-profile` | 1 | **A** | |
| `settings-account` | 1 | **A** | 계정 **목록**은 앱, 채팅의 계정 선택은 S(picker) |
| `settings-account-login` | 1 | **A** | |
| `settings-account-logout-confirm` | 1 | **A** | 로그아웃 = 그 계정을 쓰는 채팅들의 identity 재판정(M-LOGIC `account_unavailable`) |
| `settings-engine` | 1 | **A** | 출력 스타일 칩 = 전역 기본. 채팅 override는 `identityOverrides.outputStyle`(U10) |
| `settings-engine-confirm` | 1 | **A** | |
| `settings-engine-install-card` | 1 | **A** | |
| `settings-api` | 1 | **A** | 키·예산은 앱, **과금 모드는 채팅**으로 이동(U10) — 탭에 "기본값" 표시 |
| `settings-mcp` | 1 | **A** | M9 확장점: `identityOverrides.mcpOverrides` |
| `settings-skill` | 1 | **A** | M9 확장점: `identityOverrides.skillOverrides` |
| `settings-display` | 1 | **A** | |
| `settings-language` | 1 | **A** | |
| `settings-code-lsp` | 1 | **A** (Verse 행만 **N**) | 대상 언어 TS/JS·Python·C#·C++ 넷 |
| `settings-code-expanded` | 1 | **A** (Verse 하위옵션만 **N**) | C·C++ 행 펼침은 유지 |
| `settings-code-install-card` | 1 | **A** | |
| `settings-code-delete-confirm` | 1 | **A** | |
| `settings-explorer` | 1 | **A** | |
| `settings-gestures` | 1 | **A** | |
| `settings-rail-search` | 1 | **A** | |

### §8 멀티 채팅 (17)

| id | 2.6.2 배선 | 행선지 | 한 줄 |
|---|---|---|---|
| `multi-hydrate` | 1 | **A** | `boot-loading`으로 합류(2벌 → 1벌). 보드 복원도 같은 대기 화면 |
| `multi-grid-empty` | 1 | **G** | 빈 자리 타일(R2 §2.4) — 「＋새 채팅 / 최근에서 고르기 / 이 자리 숨기기」 |
| `multi-grid-counts` | 1 | **A(다이얼) + G(배치)** | 다이얼에 **1** 추가. 위치 고정이 규약(R2 §2.1) |
| `multi-panel-running` | 1 | **S + G(헤더 칩)** | 상태 단일 소스 = `effectiveStatus/bgActive` |
| `multi-panel-done-ring` | 1 | **G** | 완료 링 = bg까지 걷혀야(메모리 '완료 표시 규칙') |
| `multi-panel-expanded` | 1 | **A(오버레이)** | 「크게 보기」는 앱 크롬 오버레이 유지. 다이얼 1과 겹치는 문제 = 열린 문제 ⑨ |
| `multi-panel-ghost-expanded` | 1 | **G** | 유령 셀 |
| `multi-panel-ghost-popped` | 1 | **G** | 유령이 **chatId**를 가리킨다(창 레지스트리 역인덱스) |
| `multi-panel-rename` | 1 | **G** | 사이드바 인라인 편집과 같은 부품 → §4-8 |
| `multi-panel-peek` | 1 | **G** | 첫 지시 호버 peek |
| `multi-panel-folder-pop` | 1 | **S** | `chat-folder-pop`과 한 부품 |
| `multi-panel-question` | (=`question-card`) | **S** | |
| `multi-panel-permission` | (=`permission-card`) | **S** | |
| `multi-panel-btw-dock` | (=`btw-dock`) | **S** | |
| `multi-panel-workflow-dock` | (=`workflow-dock`) | **S** | |
| `multi-explorer` | 1 (`App.tsx:1452`) | **A** | 포커스 자리 추종. `explorer-tree`와 한 벌 |
| `multi-reorder` | 1 | **G(제스처) + A(Board.order)** | R2 §2.2-1: 드래그는 **보이는 자리끼리만** 순서를 바꾼다 → 접힘 집합 불변(U8) |

### §9 독립 창 (5)

| id | 2.6.2 배선 | 행선지 | 한 줄 |
|---|---|---|---|
| `session-window-welcome` | 1 (`SessionWindow`) | **W + S** | |
| `session-window-thread` | 1 | **W + S** | |
| `session-window-btw` | 1 | **W + S** | `btwSeed` 웰컴. 「own 세션 생기면 재포크 금지」 유지 |
| `panel-window` | 1 (`PanelWindow`) | **W** | **`SessionWindow`와 같은 것이 된다**(R2 §3.3) — 2벌 → 1벌 |
| `panel-window-viewer` | (=`FileModal` 4벌 중 하나) | **Aw** | 창 크롬의 뷰어. `onAskSelection`이 여기서 처음 생긴다 |

### §10 알림 · 트레이 · 업데이트 (8)

| id | 2.6.2 배선 | 행선지 | 한 줄 |
|---|---|---|---|
| `toast-single` | 1 (`toast.html`) | **A** | `NotifyTarget`이 `{ chatId }`로 접힌다. **전이 판정이 렌더러 → Rust로 이동**(R2 §2.2-4) |
| `toast-aggregate` | 1 | **A** | 업서트 키 = `chatId`(2.6.2 `` `${surface}:${id}:${sub}` ``) |
| `tray-menu` | 1 | **A** | |
| `engine-gate-prompt` | 1 | **A** | |
| `engine-gate-install` | 1 | **A** | |
| `engine-update-gate` | 1 | **A** | |
| `app-update-gate` | 1 | **A** | |
| `update-splash` | 1 (외부 프로세스) | **A** | `cmd /c powershell` 경유 규약 유지 |

---

## 4. 두 칸 이상 = 아직 이중 배선 — 통합 방법 14건

R1 §0 표는 7종을 셌다. 실측하니 **여덟 갈래가 더 있었다**(2~9번). 전부 grep으로 렌더 지점을 셌다.

| # | 무엇 | 2.6.2 렌더 지점 | 통합 방법 (한 줄) |
|---|---|---|---|
| 1 | 승인/질문 카드 | 4 (App:1674·1676 / MA:752·757 / SW:863·865 / PW=PanelView) | `ChatSurface` 안 1벌. 자리 스코프 유지, 키보드는 포커스 자리만 |
| 2 | **코드 뷰어** | **4** (App:1640 / SW:879 / PW:528 / MA:1918) | 앱 크롬 1개 + 창 크롬 1개 = 코드 1벌. 대상은 `viewerTarget{chatId,path}` |
| 3 | **서브에이전트 카드** | **4** (App:1663 / MA:1928 / SW:888 / PW:531) | `ChatSurface`의 워크바 안 1벌 |
| 4 | **이미지 라이트박스** | **4** (App:1655 / MA:1934 / SW:891 / PW:533) | 앱 크롬 1개 + 창 크롬 1개 |
| 5 | **폴더 변경 확인 카드** | **4** (App:1679 / MA:1906 / SW:868 / PW:524) | M-LOGIC `needs_confirm` verdict의 표시 1벌 |
| 6 | **탐색기** | **2 렌더 / mode 삼항** (App:1438·1452) | 앱 크롬 1벌 + 포커스 자리 추종. 삼항 소멸 |
| 7 | **워크바 / 컴포저** | 각 3 (App / MA:687·712 / SW:807·832) | `ChatSurface` 안 1벌 |
| 8 | **제목 인라인 편집** | 2 (사이드바 `sb-edit` / 패널 `ma-p-tin`) | 부품 1벌, 호출 지점만 둘 |
| 9 | **워크플로 도크 / 한도 배너 / btw 도크** | 3·3·2 | `ChatSurface` 안 1벌 |
| 10 | 한도 자동 이어서 훅 | 9 인스턴스 / 4 표면 | 채팅당 1개. 대기표는 Rust `ChatRuntime` 소유 |
| 11 | 채팅 헤더 | 3 (`.chat-head`/`.ma-p-head`/`.pw-head`) | **헤더 자체는 3벌이 맞다**(다른 화면이다). 안쪽 부품(제목·폴더·상태·찾기)만 공용화 |
| 12 | 토스트 감시 | 3 surface enum + 렌더러 훅 | Rust가 `ChatRuntime`마다 전이를 판정 → `notify:event`(렌더러→main) 채널이 사라진다 |
| 13 | 대화 스토어 | 4 (`chats/`·`multi-agent/`·`session-chats/`·`chat-talk.json`) | `chats-v3/` + `boards/` |
| 14 | 엔진 IPC | 4세트 (`claude:*`·`ma:*`·`session:*`·`talk:*`) | `chat:*` 1세트 + 과도기 별칭 |

## 5. 「사라짐」 — 사용자 승인이 필요한 문장

1. **`new-chat-step1`(새 채팅 1단계 — 일반/멀티 선택)**
   > "새 채팅을 만들 때 「일반 / 멀티」를 먼저 고르는 화면이 없어집니다. 통합 후에는 채팅이
   > 한 종류뿐이고, 몇 개를 나란히 볼지는 다이얼(1~6)이 정합니다. 이 화면을 없애도 될까요?"

2. **`new-chat-step2`(패널 수 2~6) — 조건부**
   > "패널 수 선택이 「1~6」으로 바뀝니다. 모달을 남길지, 아니면 모달을 통째로 없애고
   > 헤더 다이얼로만 정할지 골라 주세요." (열린 문제 ⑩)

3. **범위 밖 2건은 「사라짐」이 아니다** — `explorer-verse-section` / `explorer-verse-digest`는
   Verse 지원 전체 제거(커밋 `f3b8104`, 사용자 결정)에 따른 **의도된 범위 축소**다.
   파리티 감사에서 회귀로 잡지 않는다.

## 6. 통합이 **없애는 게 아니라 늘리는** 화면 (회귀 아님)

파리티 감사가 "새 화면이 생겼다"로 잡지 않게 미리 적는다.

| 화면 | 2.6.2 | 3.0 |
|---|---|---|
| `viewer-selection-ask-bar` / `viewer-ask-panel` | 본채팅·추가 채팅 창에만 | 전 자리(그리드·팝아웃 포함) |
| `workflow-dock` | 본채팅·패널·추가 채팅 창 | 전 자리 |
| 접힘 배지 · 접힌 자리 팝오버 · 실행 요약 칩 | **없음** | 신규(6→1의 답) |
| 빈 자리 타일 | 빈 패널 = 바로 대화 가능 | 「＋새 채팅 / 최근에서 고르기 / 이 자리 숨기기」 |
| 대상 채팅 칩(뷰어 헤더) | 없음(모호함이 없었다) | 신규 — N≥2에서 필수 |
| 읽지 않음 배지 | **없음**(사이드바는 상태 점뿐, `styles.css:336-341`) | 신규 제안 — 열린 문제 ⑪ |

## 7. 이 표의 사용법 (파리티 게이트)

- 3.0 화면 인벤토리를 다시 만들 때 **분모는 156 − 2(Verse) − 1(`new-chat-step1`) = 153**이다.
- 「A/Aw 두 칸」 행은 코드 1벌이어야 한다 — 창 크롬이 앱 크롬의 **다른 구현**이 되면 §4가 부활한다.
  회귀 판정: `FileModal`·`ImageViewer`·`SubAgentModal`의 **렌더 지점이 각 2개(메인+창)를 넘지 않을 것**.
- 「S」 행은 렌더 지점이 **정확히 1개**여야 한다. grep으로 셀 수 있게 컴포넌트 이름을 바꾸지 말 것.
