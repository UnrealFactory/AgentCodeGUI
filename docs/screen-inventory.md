# 2.6.2 화면 인벤토리 — 3.0.0 파리티 체크리스트 / 블라인드 A/B 대본

Electron 2.6.2(`feature/3.0.0-beta`의 `src/renderer`)가 **사용자에게 보여주는 모든 화면·표면**의 전수 목록과,
각각에 CDP로 도달하는 경로다. 빠진 화면은 곧 3.0에서 누락될 화면이다.

## 실행 전제 (벤치 하네스)

```bash
# 1) 격리 홈 + 긴 스레드 픽스처(471항목) 생성 — 패치노트 차단·엔진 자동업데이트 끔·계정 OSCrypt 키 복사
node bench/fixture.mjs "$TEMP/ccg-screens-home" 2.6.2

# 2) 프로덕션 번들(out/)을 격리 홈으로 기동 (사용자 실앱과 단일 인스턴스 락 충돌 없음)
CCG_HOME="$TEMP/ccg-screens-home" NODE_ENV=production \
  ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9345
```

- CDP 부착: `bench/lib.mjs`의 `connectMainPage(9345)`.
  **주의** — `connectMainPage`의 URL 필터는 `#session`/`#mapanel` 창도 문다. 독립 창이 떠 있는 동안 메인 창에
  붙으려면 `/index\.html$/`(해시 없음)로 직접 고를 것.
- 부팅 직후 상태: 단일 뷰 · 사이드바(탐색기 아님) · 활성 채팅 = `fix-long-thread`(작업 폴더 `C:\Code\AgentCodeGUI`,
  꼬리 윈도잉으로 `.thread` 아래 ~61개 렌더) · 언어 ko · 줌 1.
- 본문에서 쓰는 조작 헬퍼(테스트 페이지에 주입해 쓴 것):
  ```js
  __k = (key, mods = {}, target) => (target || window).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...mods }))
  __c = (sel, n = 0) => document.querySelectorAll(sel)[n].click()
  __ctx = (sel, n = 0) => { const e = document.querySelectorAll(sel)[n], r = e.getBoundingClientRect()
    e.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 8, clientY: r.top + 8, button: 2 })) }
  __type = (sel, v) => { const i = document.querySelector(sel)
    Object.getOwnPropertyDescriptor(i.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(i, v)
    i.dispatchEvent(new Event('input', { bubbles: true })) }
  ```
- **[검증됨]** 표시는 이 문서를 만들며 실제로 CDP로 밟아 판정 셀렉터가 맞는 것을 확인한 화면이다(2026-08-22,
  격리 홈 · out/ 프로덕션 번들 · 자기 PID 트리만 정리).

## 표면(surface) 표기

| 표기 | 뜻 |
| --- | --- |
| `main-window` | 메인 창(`index.html`) 안의 화면·오버레이 |
| `session-window` | 추가 채팅 창(`index.html#session`, `SessionWindow`) |
| `panel-window` | 멀티 패널 팝아웃 창(`index.html#mapanel`, `PanelWindow`) + 그 밖의 독립 OS 창(스플래시) |
| `toast` | 알림 토스트 창(`toast.html`) |
| `tray` | 트레이 메뉴 창(`tray.html`) |

---

## 1. 부팅 · 안전망

| id | 이름 | 표면 | 도달 경로 | 판정 셀렉터 | 엔진 | 계정 |
| --- | --- | --- | --- | --- | --- | --- |
| `boot-splash-native` | 네이티브 시작 스플래시 | panel-window | 앱 스폰 직후 메인 창 `ready-to-show` 전까지 뜨는 300×240 frameless `data:` 창 (`src/main/index.ts` `createSplash`). CDP 타깃 `data:text/html…`로 잡힌다 — `bench/lib.mjs`의 필터는 `data:`를 제외하므로 `cdpTargets()`를 직접 훑을 것 | `.card .spin` (스플래시 문서 안) | X | X |
| `boot-loading` | 렌더러 로딩 화면 | main-window | `App`의 `ready=false` 구간(`getProfile()` 응답 전). 프로덕션에선 수십 ms — `Runtime.evaluate` 폴링으로 `.boot`를 잡거나 `getProfile` 지연을 주입해 재현 | `.win .boot .boot-spin` | X | X |
| `error-boundary` | 에러 안전망 카드 | main-window | 자식 렌더 예외. 재현: 스레드 map 안에서 던지도록 픽스처의 메시지에 손상 필드 주입, 또는 `ErrorBoundary`로 감싼 하위(멀티/앱)에서 예외 발생 | `.eb .eb-card .eb-title` | X | X |

## 2. 본채팅 (단일 뷰)

| id | 이름 | 표면 | 도달 경로 | 판정 셀렉터 | 엔진 | 계정 |
| --- | --- | --- | --- | --- | --- | --- |
| `chat-thread` | 대화 스레드(코드 뷰) | main-window | 부팅 직후 기본 화면 **[검증됨]** | `.chat.chat--code .thread` | X | X |
| `chat-welcome` | 웰컴(빈 채팅) | main-window | `__k('n',{ctrlKey:true})` → `__c('.nctile',0)` **[검증됨]** | `.chat-scroll .welcome .wc-grid` | X | X |
| `chat-working` | 작업 인디케이터(마스코트+경과) | main-window | 실행 중 & 본문 스트리밍 아님. `state.status='analyzing'` 필요 | `.thread .working-line` | O | O |
| `chat-jump-bottom` | 맨 아래로 점프 버튼 | main-window | `.chat-scroll`를 위로 스크롤(`scrollTop -= 2000`) → 래치 해제 | `.jump-bottom-wrap .jump-bottom` | X | X |
| `chat-find` | 대화에서 찾기 바 | main-window | `window.dispatchEvent(new Event('ccg:chat-find'))` 또는 Ctrl+F **[검증됨]** | `.chat-find` | X | X |
| `chat-selection-bar` | 선택 툴바(복사/더 자세히) | main-window | `.thread` 안 텍스트를 `Selection`으로 잡고 그 위에서 `contextmenu` | `.sel-bar .sel-act` | X | X |
| `chat-gesture-overlay` | 마우스 제스처 궤적·라벨 | main-window | `.chat-scroll`에 `pointerdown(button:2)` → `pointermove` 10회 위쪽(-16px씩) **[검증됨]** | `.mg-trail` + `.mg-label` | X | X |
| `chat-zoom-badge` | 줌 배지 | main-window | `.chat-scroll`에 `wheel` + `ctrlKey` | `.zoom-badge.on` | X | X |
| `chat-folder-pop` | 작업 폴더 팝오버(즐겨찾기/최근/참조) | main-window | `__c('.chat-head .fsel')` **[검증됨]** | `.hfold .wb-pop.hpop` | X | X |
| `chat-header` | 채팅 헤더(제목·폴더 칩·찾기·탐색기 토글·창 컨트롤) | main-window | 상시 **[검증됨]** | `.chat-head .hfold` | X | X |
| `composer` | 컴포저(한 줄 고스트 필) | main-window | 상시 **[검증됨]** | `.composer .composer-row` | X | X |
| `composer-two-line` | 컴포저 2줄 승격 | main-window | `__type('.composer textarea','아주 긴 문장…')`로 줄바꿈 유발 | `.composer-row.two-line` | X | X |
| `composer-picker-pop` | 모델·모드·과금·계정 통합 팝오버 | main-window | `__c('.composer .model-chip')` **[검증됨]** | `.picker-pop .pprov` | X | 계정 섹션은 O |
| `composer-slash-palette` | "/" 명령 팔레트(+스킬) | main-window | `__type('.composer textarea','/')` **[검증됨]** | `.slash-menu .slash-opt` | X | X |
| `composer-mention-palette` | "@" 파일 멘션 팔레트 | main-window | `__type('.composer textarea','@')` **[검증됨]** | `.slash-menu .mention-loc` | X | X |
| `composer-attachments` | 첨부 트레이(이미지/문서 썸네일) | main-window | `.composer`에 `DataTransfer` 담은 `DragEvent('drop')` 디스패치(blob 폴백이 `saveAttachmentData`로 저장) **[검증됨]** | `.composer .img-tray .img-thumb` | X | X |
| `composer-queue` | 예약 큐(작업 중 보낸 메시지) | main-window | 실행 중 입력 후 Enter(`onSchedule`) | `.composer .sched .sched-list` | O | O |
| `composer-drop-hint` | 파일 드롭 힌트 오버레이 | main-window | `.composer`에 `dragenter`(`dataTransfer.items[].kind='file'`) | `.composer .drop-hint` | X | X |
| `limit-hold-bar` | 한도 자동 이어서 대기표 바 | main-window | 한도 소진 턴 필요. 픽스처로: `ui-prefs`의 `limitResume.hold`에 `{key:<activeChatId>, resetAt, …}` 심고 재기동 | `.limit-hold-wrap .limit-hold` | O | O |
| `workbar` | 작업 바(5칩) | main-window | 상시 **[검증됨]** | `.workbar .wb-chip` (5개) | X | X |
| `workbar-todo-pop` | 할 일 팝오버 | main-window | `__c('.workbar .wb-chip',0)` **[검증됨]** | `.wb-cell .wb-pop .wb-pop-h` | X | X |
| `workbar-subagent-pop` | 서브에이전트 팝오버 | main-window | `__c('.workbar .wb-chip',1)` **[검증됨]** | `.wb-cell .wb-pop .wb-pop-h` | X | X |
| `workbar-shell-pop` | 백그라운드 셸 팝오버 | main-window | `__c('.workbar .wb-chip',2)` **[검증됨]** | `.wb-cell .wb-pop .wb-pop-h` | X | X |
| `workbar-file-pop` | 변경된 파일 팝오버 | main-window | `__c('.workbar .wb-chip',3)` **[검증됨]** | `.wb-cell .wb-pop .wb-pop-h` | X | X |
| `workbar-context-pop` | 컨텍스트·한도 팝오버 | main-window | `__c('.workbar .wb-chip',4)` **[검증됨]** (5시간/Fable 주간/주간 한도 행은 로그인 계정 필요) | `.wb-cell .wb-pop.r .wb-prow` | X | 한도 행은 O |
| `workbar-context-pop-api` | 컨텍스트 팝오버 — API 과금 모드 | main-window | picker 팝오버에서 과금 `API` 선택(키 필요) 후 컨텍스트 칩 | `.wb-cell .wb-pop.r .wb-prow` (행 라벨 '이번 대화 비용') | X | API 키 |
| `bash-log-modal` | Bash 출력 카드 | main-window | 스레드의 `.t-row.bash` 클릭. 픽스처의 toolgroup에 `kind:'bash', output:…` 존재 → `.toollog` 펼친 뒤 Bash 행 클릭 | `.sa-overlay .dc-card .dc-term-pre` | X | X |
| `bgtask-modal` | 백그라운드 셸 카드(중지) | main-window | 셸 팝오버의 행 클릭 (`state.bgTasks` 필요) | `.sa-overlay .dc-card .dc-stop` | O | O |
| `subagent-modal` | 서브에이전트 상세 카드 | main-window | 서브에이전트 팝오버의 행 클릭 (`state.subagents` 필요) | `.sa-overlay .dc-card .dc-tool` | O | O |
| `cmd-result-card` | 내장 명령 결과 카드(/init·/compact 등) | main-window | `/init` 실행 완료 후 스레드에 남는 카드 | `.thread .cmd-card .cmd-card-title` | O | O |
| `question-card` | AI 질문 카드 | main-window | 엔진의 `AskUserQuestion`. 스텁: `window.api` 이벤트 대신 실행 필요 | `.q-overlay .qcard .qopts` | O | O |
| `question-card-multistep` | AI 질문 카드 — 다단계(N/M) | main-window | 질문이 2개 이상인 요청 | `.q-overlay .qcard .qbl` | O | O |
| `question-mini` | 질문 내려두기 알약 | main-window | 질문 카드 헤더의 `⌄`(또는 Esc) | `.q-mini .qmt` | O | O |
| `permission-card` | 도구 승인 요청 카드 | main-window | `mode:'normal'`에서 쓰기 도구 실행 | `.q-overlay .qcard .qopt-deny` | O | O |
| `workflow-dock` | 워크플로 알약 도크 | main-window | 상주 워크플로 실행 중 | `.wf-dock .wf-mini` | O | O |
| `workflow-card` | 워크플로 펼침 카드(단계 레일+에이전트) | main-window | 워크플로 알약 클릭 | `.wf-card .wf-cols` | O | O |
| `btw-dock` | /btw 질문 창 알약 도크 | main-window | 컴포저에 `/btw 질문` → Enter로 창을 연 뒤 **그 창을 최소화**(도크는 `shown=false`인 창만 그린다) **[검증됨]** | `.btw-dock .btw-mini` | X(포크 없으면 새 컨텍스트) | X |
| `image-lightbox` | 이미지 라이트박스 | main-window | 첨부 트레이 썸네일 `__c('.img-thumb-open')` (또는 메시지 이미지 클릭) **[검증됨]** | `.iv-overlay .iv-stage` | X | X |
| `image-lightbox-strip` | 라이트박스 — 여러 장(썸네일 스트립) | main-window | 이미지 2장 이상 첨부 후 썸네일 클릭 | `.iv-overlay .iv-strip` | X | X |
| `folder-switch-dialog` | 작업 폴더 변경 확인 카드 | main-window | 메시지가 있는 채팅에서 폴더 팝오버의 **다른** 최근 폴더 선택 (최근 목록에 2곳 이상 필요 — `ui-prefs`의 `explorer.roots`/공유 최근 폴더 시드) | `.set-dialog-overlay .set-dialog .sd-title` | X | X |
| `autohide-preview` | 사이드바 감지 폭 미리보기 띠 | main-window | 설정 → Display → 사이드바 자동 숨김 켠 뒤 감지 폭 슬라이더 드래그 | `.autohide-trigger-preview .atp-lbl` | X | X |
| `sidebar-autohide-edge` | 사이드바 자동 숨김 — 접힘/가장자리 띠 | main-window | 설정 → Display에서 자동 숨김 ON | `.lcol.autohide` + `.lcol-edge` | X | X |

## 3. 사이드바 · 새 채팅 · 프롬프트

| id | 이름 | 표면 | 도달 경로 | 판정 셀렉터 | 엔진 | 계정 |
| --- | --- | --- | --- | --- | --- | --- |
| `sidebar` | 채팅 사이드바(3섹션) | main-window | 부팅 기본 **[검증됨]** — 섹션 라벨 `일반 채팅 / 멀티 채팅 / 추가 채팅` | `.lcol .sidebar .sb-sec` | X | X |
| `sidebar-section-search` | 섹션 검색 입력 | main-window | `__c('.sb-sec .slb')` **[검증됨]** | `.sb-search2 input` | X | X |
| `sidebar-empty` | 섹션 빈 상태 | main-window | 채팅 0건 섹션(멀티/추가) 기본 | `.sb-list .sb-empty` | X | X |
| `sidebar-ctx-menu` | 채팅 우클릭 메뉴 | main-window | `__ctx('.sb-item')` **[검증됨]** | `.ctx-menu .ctx-item` | X | X |
| `sidebar-rename-inline` | 채팅 이름 인라인 편집 | main-window | 우클릭 메뉴 → 이름 변경 | `.sb-item .sb-edit` | X | X |
| `sidebar-delete-confirm` | 채팅 삭제 확인 카드 | main-window | 우클릭 메뉴 → 삭제 `__c('.ctx-menu .ctx-item.danger')` **[검증됨]** | `.sconfirm .sccard` | X | X |
| `sidebar-deleteall-confirm` | 섹션 전체 삭제 확인 카드 | main-window | `__c('.sb-sec .slb.has-tip')`(휴지통) **[검증됨]** | `.sconfirm .sccard` | X | X |
| `new-chat-step1` | 새 채팅 — 일반/멀티 선택 | main-window | `__k('n',{ctrlKey:true})` **[검증됨]** | `.nc-veil .nctiles` | X | X |
| `new-chat-step2` | 새 채팅 — 패널 수(2~6) | main-window | 위에서 `__c('.nctile',1)` **[검증됨]** | `.nc-veil .nccnts .ncnt` | X | X |
| `prompt-library-list` | 프롬프트 라이브러리 — 목록/빈 상태 | main-window | 사이드바 `프롬프트` 버튼 **[검증됨]** | `.pr-overlay .plib-modal .plib-list` | X | X |
| `prompt-library-editor` | 프롬프트 편집(제목+본문) | main-window | 목록에서 `__c('.plib-add')` **[검증됨]** | `.plib-modal .plib-ed .tx` | X | X |
| `prompt-library-delete` | 프롬프트 삭제 확인 | main-window | 저장된 프롬프트 행의 휴지통 | `.sconfirm.up .sccard` | X | X |

## 4. 파일 탐색기

| id | 이름 | 표면 | 도달 경로 | 판정 셀렉터 | 엔진 | 계정 |
| --- | --- | --- | --- | --- | --- | --- |
| `explorer-tree` | 탐색기 트리 | main-window | `__k('`')`(백쿼트 — 입력에 포커스가 있으면 무시되니 먼저 `document.activeElement.blur()`) **[검증됨]** | `.lcol .explorer .fxtree .fxr` | X | X |
| `explorer-blank` | 탐색기 — 폴더 없음 | main-window | 작업 폴더가 빈 채팅에서 탐색기 열기 | `.explorer .exp-blank .exp-blank-btn` | X | X |
| `explorer-search` | 파일 검색 결과 | main-window | `__type('.fxs input','package')` **[검증됨]** | `.explorer .fxtree .fxr .pth` | X | X |
| `explorer-search-empty` | 검색 결과 없음 | main-window | 검색어에 매칭 0건 | `.explorer .fx-empty` | X | X |
| `explorer-hidden-on` | 숨긴 항목 보기 ON | main-window | `.fxh` 두 번째 버튼(눈 아이콘) **[검증됨]** (행 수 36 → 42) | `.fxh button.on` | X | X |
| `explorer-ctx-menu` | 탐색기 우클릭 메뉴 | main-window | `__ctx('.explorer .fxr',1)` **[검증됨]** — 항목: 변경된 파일 보기 / 새 파일 / 새 폴더 / 이름 변경 / 경로 복사 / 파일 탐색기에서 보기 / 숨김 목록에 추가 / 삭제 | `.ctx-menu .ctx-item` | X | X |
| `explorer-fileop` | 파일 작업 카드(새 파일·폴더·이름 변경) | main-window | 우클릭 → 새 파일 **[검증됨]** | `.pr-overlay .fop-modal .pr-input` | X | X |
| `explorer-fileop-delete` | 삭제 확인 카드 | main-window | 우클릭 → 삭제 | `.sconfirm .sccard` | X | X |
| `explorer-notice` | 파일 작업 오류 알림 카드 | main-window | 실패하는 작업(예: 이미 있는 이름으로 새 파일) | `.pr-overlay .pr-modal.fop-modal .pr-ic.danger` | X | X |
| `explorer-verse-section` | Verse API digest 접이식 묶음 | main-window | Verse 프로젝트(`.vproject`/`.uefnproject`) 폴더에서 탐색기 하단 | `.fxr.fx-verse .cntp` | X | X |
| `explorer-verse-digest` | Verse digest 뷰(돌아가기 행) | main-window | Verse API 묶음 펼친 뒤 패키지 행 클릭 | `.fxtree > .fxr .n.dir` (첫 행 = 돌아가기) | X | X |
| `explorer-git-strip` | Git 상태 스트립(저장소별 1줄) | main-window | 탐색기 하단 — git 저장소가 있는 폴더 **[검증됨]** | `.explorer .git-strip .br` | X | X |
| `explorer-settings-foot` | 탐색기 하단 프로필/설정 행 | main-window | 탐색기 상시 하단 | `.explorer .sb-foot` | X | X |
| `changed-files-modal` | 변경된 파일 카드(스코프 폴더) | main-window | 탐색기 우클릭 → `변경된 파일 보기`. **AI가 이번 세션에서 바꾼 파일이 0이면 메뉴 항목이 disabled** — 실행 후에만 도달 | `.chgm-overlay .chgm-modal .chgm-list` | O | O |

## 5. 코드 뷰어 (FileModal / CmEditor)

| id | 이름 | 표면 | 도달 경로 | 판정 셀렉터 | 엔진 | 계정 |
| --- | --- | --- | --- | --- | --- | --- |
| `viewer-code-read` | 코드 뷰어 — 읽기 모드(CodeMirror) | main-window | 탐색기에서 `package.json` 클릭 **[검증됨]** (vtool = `읽기 모드*`/`편집 모드`) | `.fv-overlay .fv-modal .fv-body .cm-mount` + `.vtool button[aria-label="읽기 모드"].on` | X | X |
| `viewer-code-edit` | 코드 뷰어 — 편집 모드(Ctrl+E) | main-window | vtool의 `편집 모드` 버튼 **[검증됨]** | `.vtool button[aria-label="편집 모드"].on` | X | X |
| `viewer-code-dirty` | 편집 중 미저장(● 저장 칩) | main-window | 편집 모드에서 CM 문서 변경 | `.diff-head .fv-lsp.install` | X | X |
| `viewer-code-saved` | 저장됨 칩 | main-window | Ctrl+S 저장 직후 1.4초 | `.diff-head .fv-lsp.ready` | X | X |
| `viewer-diff-on` | 변경 마킹(diff) 표시 | main-window | AI가 바꾼 파일을 열면 기본 ON. vtool의 `변경 보기` 토글 | `.vtool button[aria-label="변경 보기"].on` + `.diff-ruler` | O | O |
| `viewer-markdown-preview` | 마크다운 렌더 뷰 | main-window | 탐색기에서 `docs/ARCHITECTURE-3.0.md` 클릭 **[검증됨]** | `.fv-body .fv-md .content` | X | X |
| `viewer-markdown-source` | 마크다운 — 변경 소스 보기 | main-window | AI가 수정한 .md를 열고 vtool의 `<>`(변경 소스) — **diff가 있을 때만 토글이 생긴다**(`mdCanToggle = isMdFile && !!diff`) | `.vtool button[aria-label="변경 소스"].on` | O | O |
| `viewer-image` | 이미지 뷰(뷰어 안) | main-window | 탐색기에서 `docs/chat.png` 클릭 **[검증됨]** | `.fv-body .fv-imgview .fv-imgel` | X | X |
| `viewer-html-preview` | HTML 페이지 미리보기(ccg-page 스킴) | main-window | 탐색기에서 `app/toast.html` 클릭 **[검증됨]** (vtool = `페이지 미리보기*`/`코드 보기`) | `.fv-body iframe.fv-htmlframe` | X | X |
| `viewer-html-code` | HTML 코드 보기(Ctrl+D) | main-window | 위에서 `코드 보기` 버튼 **[검증됨]** | `.fv-body .cm-mount` + `.vtool button[aria-label="코드 보기"].on` | X | X |
| `viewer-svg-preview` | SVG 렌더 미리보기 | main-window | `.svg` 파일 열기 (레포엔 `src/renderer/src/assets/fileicons/*.svg`) | `.fv-body .fv-imgview` + `.vtool button[aria-label="SVG 소스"]` | X | X |
| `viewer-svg-source` | SVG 마크업 소스 | main-window | 위에서 `SVG 소스` 버튼 | `.vtool button[aria-label="SVG 소스"].on` | X | X |
| `viewer-loading` | 뷰어 로딩 스피너 | main-window | 큰 파일 열기 직후 프레임 | `.fv-body .fv-loading .spin` | X | X |
| `viewer-empty` | 뷰어 — 내용 없음/오류 | main-window | 0바이트 파일 또는 읽기 실패 파일 열기 | `.fv-body .fv-empty` | X | X |
| `viewer-truncated` | 일부만 표시 칩 | main-window | 매우 큰 파일 열기 | `.diff-head .fv-trunc` | X | X |
| `viewer-find` | 뷰어 찾기 바(비-CM) | main-window | 마크다운/이미지 아닌 비-CM 뷰에서 Ctrl+F **[검증됨]** | `.fv-find` | X | X |
| `viewer-cm-find` | CM 편집기 찾기 바 | main-window | CM 뷰(코드)에서 Ctrl+F **[검증됨]** | `.fv-find.cm-find` | X | X |
| `viewer-selection-ask-bar` | 코드 선택 툴바(복사/질문) | main-window | 뷰어 본문 텍스트 선택 후 `contextmenu` | `.fv-overlay .sel-bar .sel-act` | X | X |
| `viewer-ask-panel` | 선택 코드 질문 패널 | main-window | 선택 툴바의 `질문` | `.fv-modal .fv-ask .fv-ask-row textarea` | X | 전송 시 O |
| `viewer-hover-card` | LSP 호버 타입 카드 | main-window | 코드 심볼 위 `mousemove` 호버(LSP ready 필요 — `.fv-lsp.starting`이 사라진 뒤) | `.lsp-hover` (CM는 `.cm-lsp-hover`) | X | X |
| `viewer-header-ctx-menu` | 뷰어 헤더 우클릭 메뉴 | main-window | `__ctx('.fv-modal .diff-head')` — 경로 복사 / 파일 탐색기에서 보기 | `.ctx-menu .ctx-item` | X | X |
| `viewer-maximized` | 뷰어 최대화 | main-window | 헤더의 최대화 버튼(또는 헤더 더블클릭) | `.fv-modal.rzm` + 헤더 버튼 `aria-label="이전 크기로"` | X | X |
| `viewer-back-forward` | 뷰어 파일 히스토리(뒤로/앞으로) | main-window | 심볼 정의로 점프(Ctrl+클릭) 후 헤더에 나타나는 화살표 | `.diff-head .fv-back` | X | X |
| `viewer-close-confirm` | 미저장 편집 닫기 확인 | main-window | 편집 모드에서 수정 후 Esc/닫기 | `.set-dialog-overlay .set-dialog .sd-title` | X | X |
| `viewer-save-error` | 저장 실패 카드 | main-window | 읽기 전용 파일을 편집·저장 | `.set-dialog-overlay .set-dialog .sd-title` (본문 '저장하지 못했어요') | X | X |
| `viewer-git-snapshot` | Git 커밋 스냅샷 뷰어(해시 라벨) | main-window | Git 카드 → 히스토리 → 커밋 → 파일 클릭 | `.fv-modal .fv-glabel` | X | X |

## 6. Git 카드

| id | 이름 | 표면 | 도달 경로 | 판정 셀렉터 | 엔진 | 계정 |
| --- | --- | --- | --- | --- | --- | --- |
| `git-changes` | Git — 변경 목록 + 커밋 컴포저 | main-window | 탐색기 하단 `__c('.explorer .git-strip')` **[검증됨]** | `.gitm-overlay .gitm-modal .gitm-list.wide` | X | X |
| `git-history` | Git — 히스토리(커밋 리스트) | main-window | 좌측 내비 `히스토리` **[검증됨]** (`.gitm-day`/`.c-line` 135개) | `.gitm-modal .gitm-list .c-line` | X | X |
| `git-commit-detail` | Git — 커밋 상세(우측 패널) | main-window | 히스토리에서 커밋 행 클릭 **[검증됨]** | `.gitm-detail .gd-msg` | X | X |
| `git-repo-list` | Git — 저장소 선택(2곳 이상) | main-window | 하위 저장소가 2곳 이상인 폴더에서 Git 카드 | `.gitm-nav .gitm-sec` + 저장소 항목 | X | X |
| `git-new-branch` | Git — 새 브랜치 입력 | main-window | 좌측 내비 `새 브랜치…` | `.gitm-item .gitm-newbr` | X | X |
| `git-ai-commit-step1` | AI 커밋 메시지 — 1/2 계정 | main-window | 변경 파일을 체크한 뒤 컴포저의 AI 버튼 | `.set-dialog-overlay .qcard .qstep-b .qopts` | O | O |
| `git-ai-commit-step2` | AI 커밋 메시지 — 2/2 모델·effort | main-window | 위에서 계정 선택 | `.set-dialog-overlay .qcard .gai-seg` | O | O |
| `git-discard-confirm` | 변경 되돌리기 확인 | main-window | 변경 파일 행의 되돌리기 | `.set-dialog-overlay .set-dialog .sd-ic` | X | X |
| `git-switch-confirm` | 더티 브랜치 전환 확인 | main-window | 변경이 있는 채로 다른 브랜치 클릭 | `.set-dialog-overlay .set-dialog .sd-ic.warn` | X | X |
| `git-error` | Git 오류 칩 | main-window | 원격 없는 저장소에서 Pull/Push | `.gitm-head .gitm-err` | X | X |

## 7. 설정 모달 (탭마다 1건)

공통 진입: `__c('.sb-foot')`(사이드바 하단 프로필 행) 또는 탐색기 하단 같은 행. 탭 전환 = `__c('.set-ni', N)`.
레일 순서: `0 Profile · 1 Account · 2 Engine · 3 API · 4 MCP · 5 Skill · 6 Display · 7 Language · 8 Code · 9 Explorer · 10 Gestures` **[검증됨]**

| id | 이름 | 표면 | 도달 경로 | 판정 셀렉터 | 엔진 | 계정 |
| --- | --- | --- | --- | --- | --- | --- |
| `settings-profile` | 설정 — Profile(닉네임·아바타 20색) | main-window | `__c('.sb-foot')` (기본 탭) **[검증됨]** | `.set-modal .set-inner .sc2.hero2` | X | X |
| `settings-account` | 설정 — Account(Anthropic·OpenAI 계정 카드) | main-window | `__c('.set-ni',1)` **[검증됨]** (계정 카드 6장, `.set-addrow` 2개) | `.set-inner .set-sortrow` + `.sc2.acct` | X | O |
| `settings-account-login` | Account — 로그인 진행(취소 + 로그인 URL) | main-window | Account 탭의 `계정 추가` → OAuth 대기 상태 | `.set-inner .set-spin` + 로그인 URL `a[href^="http"]` | X | X |
| `settings-account-logout-confirm` | Account — 로그아웃 확인 카드 | main-window | 계정 카드의 로그아웃 | `.set-dialog-overlay .set-dialog` | X | O |
| `settings-engine` | 설정 — Engine(버전·정리·출력 스타일 칩·Codex) | main-window | `__c('.set-ni',2)` **[검증됨]** (칩: 기본/Concise/Explanatory/Learning/Proactive) | `.set-inner .sc2.row2.eng` | X | X |
| `settings-engine-confirm` | Engine — 이전 버전 정리 확인 | main-window | Engine 탭의 `정리` **[검증됨]** (제목 '이전 버전 정리', 버튼 취소/삭제) | `.set-dialog-overlay .set-dialog .sd-btns` | X | X |
| `settings-engine-install-card` | Engine — 설치/정리 로그 카드 | main-window | 버전 칩으로 다른 버전 설치 | `.set-dialog-overlay .install-card .ic-log` | X | X |
| `settings-api` | 설정 — API(키·예산·누적 사용액) | main-window | `__c('.set-ni',3)` **[검증됨]** (컴포저 과금 `API` + 키 없음도 이 탭을 연다) | `.set-inner .sc2.api` | X | X |
| `settings-mcp` | 설정 — MCP(서버 목록·범위 탭) | main-window | `__c('.set-ni',4)` **[검증됨]** | `.set-inner .set-tabs .set-tab` + `.set-sec`('서버') | X | X |
| `settings-skill` | 설정 — Skill(스킬 목록·범위 탭) | main-window | `__c('.set-ni',5)` **[검증됨]** | `.set-inner .set-tabs .set-tab` + `.set-sec`('스킬') | X | X |
| `settings-display` | 설정 — Display(유리·사이드바·알림) | main-window | `__c('.set-ni',6)` **[검증됨]** (섹션 3개) | `.set-inner .set-sec` (유리/사이드바/알림) | X | X |
| `settings-language` | 설정 — Language(ko/en 즉시 전환) | main-window | `__c('.set-ni',7)` **[검증됨]** | `.set-inner .sc2.row2.pick.on` | X | X |
| `settings-code-lsp` | 설정 — Code(언어 서버 목록) | main-window | `__c('.set-ni',8)` **[검증됨]** (TypeScript/Python/C#/C·C++/Verse 행) | `.set-inner .set-sec`('언어 서버') + `.sc2.row2` | X | X |
| `settings-code-expanded` | Code — 행 펼침(Verse 연결·UE 문서 언어) | main-window | Verse 또는 C·C++ 행 클릭 **[검증됨]** (행 5 → 6) | `.set-inner .sc2.row2` 증가 + 하위 옵션 | X | X |
| `settings-code-install-card` | Code — 분석 서버 설치/삭제 로그 카드 | main-window | C#/C++ 행의 설치 | `.set-dialog-overlay .install-card` | X | X |
| `settings-code-delete-confirm` | Code — 분석 서버 삭제 확인 | main-window | 설치된 서버 행의 삭제 | `.set-dialog-overlay .set-dialog .sd-title` | X | X |
| `settings-explorer` | 설정 — Explorer(숨김 필터 목록) | main-window | `__c('.set-ni',9)` **[검증됨]** | `.set-inner .sc2.tgl` + `.dim2` | X | X |
| `settings-gestures` | 설정 — Gestures(제스처·감도) | main-window | `__c('.set-ni',10)` **[검증됨]** | `.set-inner .set-sec`(제스처/감도) | X | X |
| `settings-rail-search` | 설정 — 레일 검색 필터 | main-window | `__type('.set-search input','제스처')` **[검증됨]** (레일이 `Gestures` 1개로 축소) | `.set-nav .set-ni` (개수 축소) | X | X |

## 8. 멀티 채팅

| id | 이름 | 표면 | 도달 경로 | 판정 셀렉터 | 엔진 | 계정 |
| --- | --- | --- | --- | --- | --- | --- |
| `multi-hydrate` | 멀티 — 세션 복원 스피너 | main-window | `ui-prefs`의 `workspace.mode='multi'`로 기동한 직후 프레임 | `.multi .ma-hydrate .ma-hydrate-spin` | X | X |
| `multi-grid-empty` | 멀티 — 빈 패널 그리드(4분할) | main-window | `__k('n',{ctrlKey:true})` → `__c('.nctile',1)` → `__c('.ncnt',2)` **[검증됨]** (패널 4개, 전부 빈 상태) | `.multi .ma-grid.n4 .ma-panel .ma-p-empty` | X | X |
| `multi-grid-counts` | 멀티 — 패널 수 2/3/5/6 배치 | main-window | 헤더 `.ma-count-btn`(5개) 클릭 **[검증됨]**(칩 존재) — n2·n3 한 줄, n5 3+2 스팬, n6 3×2 | `.ma-grid.n2` / `.n3` / `.n5` / `.n6` | X | X |
| `multi-panel-running` | 멀티 — 패널 실행 중(상태 칩·경과) | main-window | 패널 컴포저에 프롬프트 전송 | `.ma-panel .ma-status .ma-status-spin` | O | O |
| `multi-panel-done-ring` | 멀티 — 진짜 완료 링(bg까지 걷힘) | main-window | 턴이 끝나고 백그라운드도 없을 때 | `.ma-panel.done` | O | O |
| `multi-panel-expanded` | 멀티 — 크게 보기 오버레이 카드 | main-window | 패널 헤더 `크게 보기` **[검증됨]** | `.ma-expand-overlay .ma-expand-card .ma-panel` | X | X |
| `multi-panel-ghost-expanded` | 멀티 — 크게 보는 중 그리드 자리지킴 | main-window | 위와 동시 **[검증됨]** | `.ma-grid .ma-panel.ma-ghost` | X | X |
| `multi-panel-ghost-popped` | 멀티 — 팝아웃 중 그리드 유령 | main-window | 패널 헤더 `별도 창으로` **[검증됨]** | `.ma-grid .ma-panel.ma-ghost.pop` | X | X |
| `multi-panel-rename` | 멀티 — 패널 제목 인라인 편집(F2) | main-window | `__c('.ma-panel .ma-p-tedit')` **[검증됨]** | `.ma-panel .ma-p-tin` | X | X |
| `multi-panel-peek` | 멀티 — 첫 지시 호버 peek | main-window | 대화가 있는 패널 제목에 0.35s 호버 | `.ma-p-tw .ma-p-peek .pk-b` | X | X |
| `multi-panel-folder-pop` | 멀티 — 패널 폴더 팝오버(오른쪽 정렬) | main-window | `__c('.ma-panel .ma-p-folder')` **[검증됨]** | `.ma-panel .wb-pop.hpop.r` | X | X |
| `multi-panel-question` | 멀티 — 패널 스코프 질문 카드 | main-window | 그 패널의 실행이 질문을 낼 때 (키보드는 포커스 패널만) | `.ma-panel .q-overlay .qcard` | O | O |
| `multi-panel-permission` | 멀티 — 패널 스코프 승인 카드 | main-window | 그 패널의 도구 승인 요청 | `.ma-panel .q-overlay .qopt-deny` | O | O |
| `multi-panel-btw-dock` | 멀티 — 패널 btw 알약 도크 | main-window | 패널 컴포저에 `/btw …` → 창 최소화 | `.ma-panel .btw-dock .btw-mini` | X | X |
| `multi-panel-workflow-dock` | 멀티 — 패널 워크플로 도크 | main-window | 그 패널에서 워크플로 상주 | `.ma-panel .wf-dock .wf-mini` | O | O |
| `multi-explorer` | 멀티 — 포커스 패널을 따라가는 탐색기 | main-window | 멀티 뷰에서 패널 클릭 후 `__k('`')` | `.lcol .explorer .fxtree` (트리 = 그 패널 cwd) | X | X |
| `multi-reorder` | 멀티 — 패널 자리 드래그 재배치 | main-window | 패널 헤더 길게 누르기 → 드래그 | `.ma-grid.reordering` | X | X |

## 9. 독립 창

| id | 이름 | 표면 | 도달 경로 | 판정 셀렉터 | 엔진 | 계정 |
| --- | --- | --- | --- | --- | --- | --- |
| `session-window-welcome` | 추가 채팅 창 — 웰컴 | session-window | 메인에서 `__k('N',{ctrlKey:true,shiftKey:true})` → 새 CDP 타깃 `index.html#session` **[검증됨]** (`.sw`/`.chat-head`/`.welcome`/`.composer`/`.workbar` 모두 확인) | `.sw .chat--code .welcome` | X | X |
| `session-window-thread` | 추가 채팅 창 — 대화 스레드 | session-window | 위 창에서 프롬프트 전송 | `.sw .chat-scroll .thread` | O | O |
| `session-window-btw` | btw 질문 창 — 이어받기 안내 웰컴 | session-window | 본채팅 컴포저에 `/btw 질문` → Enter **[검증됨]**(창 생성·세션 레코드 `btwOf` 확인) | `.sw .welcome .wc-btw` | 포크는 O | X |
| `panel-window` | 멀티 패널 팝아웃 창 | panel-window | 멀티 그리드에서 패널 헤더 `별도 창으로` → 새 타깃 `index.html#mapanel` **[검증됨]** (`.pwin`/`.pw-head`/`.pw-body .ma-panel` 확인) | `.sw.pwin .pw-body .ma-panel` | X | X |
| `panel-window-viewer` | 팝아웃 창 안의 코드 뷰어 | panel-window | 팝아웃 창에서 파일 열기 | `.pwin .fv-overlay .fv-modal` | X | X |

## 10. 알림 · 트레이 · 업데이트

| id | 이름 | 표면 | 도달 경로 | 판정 셀렉터 | 엔진 | 계정 |
| --- | --- | --- | --- | --- | --- | --- |
| `toast-single` | 알림 토스트 — 단건 상세 카드 | toast | 메인 창을 비포커스로 만든 뒤(다른 앱 창 포커스 또는 `window.api.win.minimize()`) 메인 페이지에서 `window.api.notify.event({kind:'done', title, preview, target:{surface:'single', id}})` → 새 타깃 `toast.html` **[검증됨]** (`body.single` + `.t-body`) | `body.single #card .t-body .t-ico` | 실사용은 O | X |
| `toast-aggregate` | 알림 토스트 — 집계 행 | toast | 같은 방법으로 **키가 다른** 항목을 2건 이상 남긴 상태 (`surface:id[:sub]`가 키) | `#card .t-agg .t-rows` | 실사용은 O | X |
| `tray-menu` | 트레이 우클릭 메뉴 창 | tray | 트레이 아이콘 우클릭(`showTrayMenu`) → 타깃 `tray.html`. CDP만으론 트리거 불가 — OS 이벤트 필요 | `#menu .row` | X | X |
| `engine-gate-prompt` | 엔진 미설치 안내 카드 | main-window | `CCG_HOME`의 `engines` 정션을 빼고 기동 | `.set-dialog-overlay .set-dialog .sd-title`('Claude 엔진 설치') | X | X |
| `engine-gate-install` | 엔진 설치 로그 카드 | main-window | 위에서 `설치` | `.set-dialog-overlay .install-card .ic-log` | X | X |
| `engine-update-gate` | 엔진 자동 업데이트 카드 | main-window | `engine-auto-update.json`의 `enabled:true` + 구버전 엔진으로 기동 | `.set-dialog-overlay.eu-overlay .eu-card` | X | X |
| `app-update-gate` | 앱 업데이트 바(받는 중/적용 준비/오류) | main-window | 업데이트 서버가 새 버전을 보고할 때 | `.upd .uh` (+ 진행 중이면 `.upbar`) | X | X |
| `update-splash` | 업데이트 적용 스플래시 | panel-window | 앱 업데이트 바의 `업데이트` → 앱이 꺼지며 `cmd /c powershell` WPF 창이 뜬다. **Electron 밖 프로세스라 CDP 불가** — 화면 캡처로만 판정 | (없음 — 외부 프로세스 창) | X | X |

---

## 도달 난이도 요약

- **부팅 상태만으로 도달**: 본채팅·사이드바·탐색기·설정 전 탭·Git·뷰어 전 모드·멀티 그리드·새 채팅/프롬프트 모달·
  독립 창 3종·제스처/줌/라이트박스 — 위 표의 **[검증됨]** 전부.
- **실행(엔진 턴)이 필요**: 질문/승인 카드, q-mini, 워크플로 도크·카드, 서브에이전트·백그라운드 셸 카드,
  변경된 파일 카드, diff 마킹, 예약 큐, 작업 인디케이터, 한도 대기표.
- **환경 조작이 필요**: 엔진/앱 업데이트 게이트(엔진 정션 제거·버전 조작), 트레이 메뉴(OS 이벤트),
  업데이트 스플래시(외부 프로세스), 에러 안전망(예외 주입), Verse 화면(UEFN 프로젝트 폴더).
