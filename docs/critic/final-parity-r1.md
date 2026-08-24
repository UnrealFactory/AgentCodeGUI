# 최종 파리티 감사 R1 — 화면은 거의 다 서는데, 「누를 수 있는 것」이 네 군데 비어 있다

판정자: 최종 파리티 크리틱(새 컨텍스트) · 2026-08-24 · `feature/3.0.0-beta` @ `076bf8c`
대상: 2.6.2 Electron(`node_modules/electron` + `out/`) vs 3.0.0-beta.1 Tauri(`target/release/agentcodegui.exe`, 2026-08-24 11:40 빌드)

증거 파일(전부 이 라운드에서 새로 만든 것):

| 파일 | 무엇 |
|---|---|
| `bench/shots/electron/report.json` · `bench/shots/tauri/report.json` | 전 화면 A/B 실행 리포트(각 121시도) |
| `docs/critic/final-parity-r1-join.json` | 사영표 156행 × 두 리포트 조인 |
| `docs/critic/final-parity-r1-channels.json` | 계약면 216채널 중 Rust 미구현 46개 |
| `docs/critic/final-parity-r1-apiprobe-{tauri,electron}.json` | 같은 `window.api` 호출을 두 앱에서 실행한 응답값 |
| `docs/critic/final-parity-r1-setnav-{tauri,electron}.json` | 설정 레일을 **라벨**로 눌러 재측정(인덱스 드리프트 보정) |
| `docs/critic/final-parity-r1-blind.json` | 블라인드 판정 19건 + 정답 키 대조 |
| `docs/critic/final-parity-r1-pixdiff.json` | 114쌍 픽셀 차이(임계 32) |

---

## 0. 한 문단 결론

**화면 도달은 사실상 파리티다.** 3.0의 13개 실패 중 9개는 하네스·픽스처 결함이었고
(레일 인덱스 드리프트 6 · Verse 인덱스 1 · 픽스처 비대칭 1 · 픽스처 옛 스키마 1),
보정 후 실패는 **4개(원인 2개)**로 줄어든다. 블라인드도 **5승 13무 1패**로 지지 않는다.

**진짜 구멍은 화면 목록이 못 보는 자리에 있다.** 계약면 216채널 중 **46개가 Rust에
핸들러조차 없고**, 심(shim)이 「안전값」으로 갈음하기 때문에 **화면은 정상으로 뜨고
버튼도 그려지는데 눌러도 아무 일이 없다.** 화면 단위 A/B는 이걸 구조적으로 못 잡는다 —
블라인드 유일한 1패(`workbar-context-pop`: 한도 「데이터 없음」)가 그 46개 중 하나가
화면으로 새어 나온 유일한 사례다.

그리고 **에러 안전망에서 나올 수 없다**(§1.4). 2.6.2는 리로드로 복구되는데 3.0은
같은 채팅으로 되돌아와 부팅 루프에 갇힌다 — 사이드바도 창 크롬도 없는 카드 한 장뿐이다.

---

## 1. 전 화면 A/B — 도달 실패 전수

### 1.1 실행 방법

```
node bench/ab.mjs tauri    --only=<error-boundary 제외 123화면> --merge
node bench/ab.mjs electron --only=<같은 목록>                  --merge
node bench/ab.mjs {tauri,electron} --only=chat-working,composer-queue,permission-card --engine --merge --no-boot
```

`error-boundary`를 목록에서 뺀 이유는 §1.4다 — 그 화면 하나가 3.0에서 뒤따르는
**모든 화면을 연쇄로 죽인다.** 처음 돌린 전체 패스는 그 지점 이후 전부 FAIL이었고,
그대로 집계하면 "3.0이 화면 100개를 못 그린다"는 거짓 결론이 나온다.

캡처 크기는 두 앱 모두 **1320×880**(실측 확인). 설정 재측정분만 처음에 tauri가
1440×900으로 나와 다시 찍었다 — 한쪽 캔버스가 120px 넓으면 줄바꿈이 달라져 비교가 아니다.

### 1.2 총계

| | 2.6.2 | 3.0 |
|---|---|---|
| 하네스 정의(비내부) | 156 | 156 |
| 시도 | 121 | 121 |
| 성공 | **118** | **108** |
| 실패 | 3 | 13 |
| 미시도(skip/notrun) | 34 | 34 |
| 성공률(시도 기준) | 97.5% | 89.3% |
| **원인 보정 후 성공률** | 97.5% | **96.6%** (115/119) |

### 1.3 3.0 실패 13건 — 원인별로 가른 결과

| # | 화면 | 사영표 행선지 | 판정 | 근거 |
|---|---|---|---|---|
| 1 | `btw-dock` | S | **진짜 구멍** | `btw:open` Rust 핸들러 0건(주석에만 등장: `engine/mod.rs:27`) |
| 2 | `multi-panel-btw-dock` | S | **진짜 구멍** | 위와 같은 원인 |
| 3 | `session-window-btw` | W+S | **진짜 구멍** | 위와 같은 원인 |
| 4 | `engine-gate-prompt` | A | **진짜 구멍** | `EngineGate.tsx:32`가 `engine.listAvailable().latest`를 요구 → 미구현이라 `null` → **게이트가 영영 안 뜬다** |
| 5 | `autohide-preview` | A | 하네스 결함 | 3.0이 레일에 **Talk**(M10)를 넣어 인덱스 +1 — `openSettings(6)`이 Display가 아니라 Talk를 연다 |
| 6 | `sidebar-autohide-edge` | A | 하네스 결함 | 위와 같음 |
| 7 | `settings-language` | A | 하네스 결함 | 위와 같음 |
| 8 | `settings-explorer` | A | 하네스 결함 | 위와 같음 |
| 9 | `settings-gestures` | A | 하네스 결함 | 위와 같음 |
| 10 | `settings-code-expanded` | A | 하네스 결함 | 하네스가 `.sc2.row2[4]`를 누른다 = **2.6.2의 Verse 행**. 3.0은 Verse를 뺐으니 인덱스가 없다 |
| 11 | `settings-engine-confirm` | A | 픽스처 비대칭 | 2.6.2 `src/main/codex/versions.ts:17`이 `APP_HOME`을 `os.homedir()`로 **하드코딩**해 `CCG_HOME`을 무시한다 → 2.6.2만 실홈의 codex 엔진 2개를 보고 「정리」가 뜬다. `codex-engines`를 정션하니 3.0도 「정리」 1개 |
| 12 | `boot-splash-native` | A | 양쪽 실패·의도 변경 | 3.0은 별도 스플래시 **창을 없애고** 메인 창 안 오버레이로 바꿨다(`src-tauri/src/splash.js` 헤더: 웹뷰 +1을 피하려고). 하네스는 `data:` 타깃을 찾는다 → 3.0엔 그런 타깃이 없다. **사영표 §1의 「변화 없음」은 낡았다** |
| 13 | `limit-hold-bar` | S | 양쪽 실패·픽스처 버그 | 픽스처가 심는 hold에 `at` 필드가 없다(`{key,resetAt,text,prompt,window}`) → `sanitizeHold`가 `h.at` 없으면 `null`(`limitResume.ts:105`). **두 앱 다 못 찍는다** — 이 화면은 어느 라운드에서도 캡처된 적이 없다 |

보정 재측정(라벨 기반 · `setnav.mjs`):

```
3.0  레일: Profile Account Engine API MCP Skill [Talk] Display Language Code Explorer Gestures  (12)
2.6.2 레일: Profile Account Engine API MCP Skill        Display Language Code Explorer Gestures  (11)
→ settings-display/language/code-lsp/code-expanded/explorer/gestures/autohide-preview/sidebar-autohide-edge
  = 3.0 8/8 OK, 2.6.2 8/8 OK  (+ settings-talk 은 3.0에만 존재)
```

> **거짓 통과가 거짓 실패보다 나쁘다.** 같은 드리프트 때문에 `settings-display`·
> `settings-code-lsp`는 **인덱스가 어긋난 채로 통과**했다 — 즉 이전 라운드의
> `bench/shots/tauri/settings-display.png`는 실은 **Talk 탭**이었고, 블라인드 비교에
> 서로 다른 화면이 짝지어져 있었다. 이번 라운드에서 두 앱 다 다시 찍었다.

### 1.4 ★ 에러 안전망에서 나올 수 없다 (3.0 단독 · 하네스 밖의 발견)

재현(결정적, 3/3):

```
1) 렌더 중 예외를 내는 채팅(픽스처 '벤치 예외 채팅')을 연다 → ErrorBoundary 카드
2) 카드의 [앱 새로고침] 또는 F5
3) 2.6.2 → 정상 앱으로 복귀. 직후 chat-thread 462ms에 통과
   3.0   → 같은 채팅으로 되돌아와 다시 카드. 사이드바 .sb-item 0개, .win 0개
           = 다른 채팅으로 갈 수단이 화면에 없다. 반복 리로드해도 같다
```

CDP 실측(리로드 후):

```
root children : 1
.eb-card      : 1     .chat : 0     .win : 0     .sidebar .sb-item : 0
root html     : <div class="eb"><div class="eb-card">…"e.slice is not a function"…
```

원인은 스토어에 있다. 3.0은 `chats-v3/index.json`의 `activeChatId`를 **즉시** 영속한다
(`ipc/mod.rs:194` 「저장 디바운스와 무관해야」 규약). 그래서 예외 채팅이 활성인 채로
재부팅되고, 앱 루트 ErrorBoundary가 다시 잡는다. 2.6.2는 `chats.json` 저장이 디바운스라
예외가 저장을 앞질러 **우연히** 복구됐다.

- 사용자 영향: 대화 하나가 렌더 예외를 유발하면 **앱 전체가 열리지 않는다.** 카드 문구는
  *"대화 기록은 저장되어 있습니다"*인데, 그 기록에 닿을 방법이 없다.
- 사영표 §1 `error-boundary` 행의 계획(**A + I/G/W** = 자리 단위 경계)이 정확히 이 문제를
  겨냥한 것인데 **아직 이식본 그대로**(앱 루트 1벌)다.
- 최소 수선: 부팅 시 ErrorBoundary가 잡히면 `activeChatId`를 비우고 다시 그리기 /
  카드에 「다른 대화 열기」 버튼 하나.

### 1.5 미시도 34건 — 오늘은 엔진 턴 자체가 불가능했다

- **엔진 턴 필요 14건**. 대표 3화면(`chat-working`·`composer-queue`·`permission-card`)을
  `--engine`으로 두 앱에 돌렸고 **3/3 대칭 실패**(같은 타임아웃, 같은 지점).
- 원인은 앱이 아니라 계정이다: 2.6.2의 `usage:get` 실측이 **주간 한도 100% 소진**
  (`weekly.pct=100`, 초기화 `1787752799`)이다. 오늘 이 계정으로는 어떤 턴도 못 돈다.
- **아이러니**: 그 사실을 2.6.2는 화면으로 말해 주고(§2 블라인드 유일한 패),
  3.0은 「데이터 없음」이라 사용자가 왜 안 되는지 알 수 없다.
- 나머지 20건은 파괴적(실계정 OAuth·엔진 재설치·원격 git)이거나 비결정적(AskUserQuestion)이라
  하네스가 `skip`으로 못 박아 둔 것들이다 — 이 라운드도 그대로 둔다.

---

## 2. 블라인드 판정

방법: `node bench/blind.mjs --seed=20260824` → 114쌍. **정답 키를 읽기 전에** 19건을
눈으로 판정해 `bench/scratch/blind-votes-final-r1.json`에 먼저 적고, 그 다음 키를 깠다.
프레임 차이(사이드바 섹션 수·헤더 다이얼)는 `chat-thread`·`boot-loading` 두 항목에서만
셌다 — 매 항목마다 세면 같은 차이를 19번 중복 계상하게 된다.

### 결과: **3.0 5승 · 13무 · 2.6.2 1승**

| 화면 | 승 | 이유 |
|---|---|---|
| `chat-thread` | **3.0** | 사이드바 빈 섹션 3→2, 헤더 1~6 다이얼, `/init` 카드 메타 2줄→1줄 |
| `boot-loading` | **3.0** | 빈 상태 "채팅이 없어요" 3줄→1줄 |
| `cmd-result-card` | **3.0** | 명령 카드 1줄 축약 + 문답 흔적에 `?` 마커 |
| `settings-account` | **3.0** | 「한도 소진 시 계정 자동 전환」 행(M11 신기능) |
| `viewer-save-error` | **3.0** | `EPERM: operation not permitted, open C:\…` → 「액세스가 거부되었습니다」 |
| **`workbar-context-pop`** | **2.6.2** | 3.0: 5시간·주간 한도가 **「데이터 없음」**, Fable 행 자체가 없음 / 2.6.2: %·초기화 시각·게이지 3줄 |
| 나머지 13 | 무 | 팝오버·설정·뷰어·토스트·팝아웃 창은 픽셀 수준으로 같다 |

기계 보조: 114쌍 픽셀 차이(임계 32) 중 **20쌍이 600px 미만 = 사실상 동일**.
상위 차이는 대부분 스크롤 위치·사이드바 섹션 수에서 오고, 내용이 실제로 다른 것은
`workbar-context-pop`(한도) 하나였다.

기존 기록과 합치면(같은 1440px 기준만 더한다 — 420px 6승 1무는 **같은 7항목의 다른 폭**이라
중복 계상하지 않는다): 알림 7종 **7승 0패**(M-UI R1/R2) + 이번 **5승 13무 1패**
= **12승 13무 1패**. 유일한 패는 「못생긴 디자인」이 아니라 **「빠진 데이터」**다.

---

## 3. 기능 누락 사냥 — 심각도순

방법 3겹: ① 계약면 216채널 × Rust 문자열 전수 대조 → 미구현 46개
② `apiprobe`로 같은 `window.api` 호출을 두 앱에 실행해 응답 비교
③ 화면에서 실제로 눌러 확인(A/B 도달·`enginecleanup`·`setnav`).

심(shim)이 미구현 채널에 **시그니처에 맞는 안전값**을 돌려주는 것이 M1의 계약이라
(`app/src/api/shim.ts:99`) **크래시는 없다.** 대신 조용하다 — 그래서 아래가 필요하다.

### 3.1 치명 — 3.0 단독으로는 시작조차 못 한다

| # | 무엇 | 실측 | 어디서 막히나 |
|---|---|---|---|
| **T1** | **계정 로그인/로그아웃/기본 계정/삭제/순서** | `auth:login`·`auth:logout`·`auth:set-default-account`·`auth:remove-account`·`auth:reorder-accounts` Rust 핸들러 **0**. 구현은 `AUTH_LIST_ACCOUNTS`·`CODEX_LIST_ACCOUNTS` **읽기 2개뿐**(`ipc/system.rs:19-20`) | 설정 ▸ Account의 「＋계정 추가」·「기본으로」·「삭제」가 전부 무반응. **새 사용자는 3.0에서 로그인할 방법이 없다**(2.6.2 홈을 승계해야만 쓴다) |
| **T2** | **엔진(Claude CLI) 설치·전환·정리 + 미설치 안내 게이트** | `engine:list-available`·`install`·`uninstall`·`set-active`·`cleanup` 전부 미구현. `engine:state`만 구현. Codex 쪽(`codex-engine:*`)은 **구현됨**(비대칭) | CLI가 없는 컴퓨터에서 **아무 안내도 안 뜬다**(A/B `engine-gate-prompt` 실패로도 확인). 설정 ▸ Engine에서 버전 목록이 비고 설치 버튼이 무반응 |
| **T3** | **한도 조회(`usage:get`) + 계정별 한도(`auth:accounts-usage`)** | 3.0 `{fiveHour:null, weekly:null, weeklyFable:null, extraCredit:null}` / 2.6.2 `weekly:{pct:100,resetsAt:…}` 등 실값 | ① 워크바 한도 게이지 「데이터 없음」(**블라인드 유일 패**) ② 설정 ▸ Account의 「한도 적게 남은순」 정렬이 근거 데이터 없이 돈다 ③ **한도 자동 이어서의 2단 재검증이 항상 「풀렸다」로 판정**된다(`useLimitResume.ts:144` — 조회 실패는 catch로 "풀린 것으로 두고 진행") → 시각 미상이면 10분마다 재전송을 시도하고 그때마다 다시 막힌다 |
| **T4** | **/btw 포크 질문 창(`btw:open`)** | Rust 핸들러 0(주석에만). A/B에서 3화면 도달 실패 | `/btw`·알약·본채팅/멀티/추가 창 전 표면에서 포크 창이 안 열린다 |

### 3.2 높음 — 있는 줄 알고 눌렀는데 안 되는 것

| # | 무엇 | 실측 |
|---|---|---|
| **H1** | **첨부 파일 선택(`dialog:pick-attachments`)** | 미구현. 컴포저 「＋」 버튼이 3표면(`App.tsx:774`·`MultiAgent.tsx:491`·`SessionWindow.tsx:503`)에서 무반응. **드래그·붙여넣기는 된다**(`attachment:save-data` 구현 — A/B `composer-attachments` 통과가 이 경로다) |
| **H2** | **MCP·Skill 목록/토글(`mcp:list`·`mcp:set-enabled`·`skill:list`·`skill:set-enabled`)** | 미구현. `.mcp.json`(서버 1개) + `.claude/skills/bench-skill`을 심은 스크래치 프로젝트로 실측: **2.6.2 = 1건/1건, 3.0 = 0건/0건**. 설정 ▸ MCP/Skill은 항상 「없습니다」이고 토글은 아무것도 저장하지 않는다. (M9의 채팅별 칩은 `chat:tooling-get`이라 **별개로 산다**) |
| **H3** | **앱 자동 업데이트(`app:update-check`·`app:update-install`·`app:update-event`)** | `app_meta.rs:14` 주석대로 **의도적 미구현**(항상 `idle`). `app-update-gate`·`update-splash`가 존재하지 않는다. 배포하면 사용자는 갱신 경로가 없다 |
| **H4** | **Codex 모델 목록(`codex:models`)** | 미구현 → 3.0 `[]`, 2.6.2 `gpt-5.6-sol` 등. Codex 엔진을 골라도 picker에 모델이 없다 |
| **H5** | **추가 채팅 창 닫기 flush(`session-wins:flush-request`)** | 이 채널의 **방출자가 0**이다. 3.0은 `chat:flush-req`(3.0 전용)로 갈아탔는데 이식 렌더러는 옛 채널을 듣는다(`SessionWindow.tsx:351`). 게다가 추가 채팅 창에는 `CloseRequested` 핸들러가 없다(`win.rs:418` — `Destroyed`만). 팝아웃 창은 `popout.rs:255`가 합성 `beforeunload`로 덮었지만 **추가 채팅 창은 안 덮였다** → 디바운스(600ms) 안 내려간 마지막 편집이 창과 함께 사라질 수 있다. *(코드 근거만 — 이번 라운드에 타이밍 실험은 못 했다)* |

### 3.3 중간

| # | 무엇 | 실측 |
|---|---|---|
| M1 | `shortcut:close`(Ctrl+W 계열 브로드캐스트) 미구현 — 렌더러 2곳이 구독 중 |
| M2 | `app:open-directory`("AgentCodeGUI로 열기") 미구현 — `app_meta.rs:11`이 M12 설치기와 함께라고 명시 |
| M3 | `ui:open-api-settings`·`ui:api-settings-requested` 미구현 — 다른 화면에서 API 설정으로 점프하는 경로 |
| M4 | `engine:install-progress` 미구현(T2에 딸린 진행 로그) |
| M5 | `git:ai-message` 미구현 — Git AI 커밋 메시지 버튼이 `{ok:false}`. 화면(`git-ai-commit-step1/2`)은 뜬다 |
| M6 | `engine.state.bundled`가 `"unknown"`(2.6.2는 `0.3.161`) — 3.0은 SDK를 번들하지 않는 **의도된** 차이 |

### 3.4 「됐다」로 확인된 것 (2.6.2 기능 목록 대조)

| 기능 | 판정 | 근거 |
|---|---|---|
| 멀티 패널 제목·컬러 태그 | ✅ | `MultiAgent.tsx:545/557/683` 동일 이식, A/B `multi-panel-rename`·`multi-reorder` 통과 |
| 추가 채팅 창 / 팝아웃 창 | ✅ | `session-window-welcome`·`panel-window` 통과(블라인드 무). persist/hydrate/rename 구현 |
| 토스트(단건·집계) | ✅ | 두 화면 통과, 블라인드 무 |
| 트레이 | ✅ | `tray.rs` 구현(X=숨김·첫 회 안내 카드). 화면 판정은 CDP 불가라 `skip` |
| 백그라운드 셸 칩 | ✅ | `workbar-shell-pop`·`bgtask-modal` 통과, `wire.rs:1224` `background_tasks_changed` 번역 |
| 워크플로 미러 | ✅(코드) | `wire.rs:1258-1343` `workflow_progress` → `{type:'workflow'}` 정착 포함. 화면은 엔진 턴 필요라 미측정 |
| 계정 오버라이드(채팅별) | ✅(코드) | `engine/ident.rs`의 identity 축 + `ccg-auth`의 격리 `CLAUDE_CONFIG_DIR` 물질화. **단 계정을 새로 추가할 수 없다(T1)** |
| 한도 이어서 | ⚠ 반쪽 | 훅·바·영속은 이식됨. **판정의 usage 축이 죽어 있다(T3)** |
| HTML 미리보기 | ✅ | `viewer-html-preview`·`viewer-html-code` 통과(`ccg-page` 스킴) |
| 첨부 | ⚠ 반쪽 | 드롭·붙여넣기 ✅ / 파일 선택 버튼 ✗(H1) |
| 아이콘(Material SVG) | ✅ | `fileType.tsx:14` glob 이식, 탐색기 A/B 통과 |
| LSP 4언어 | ✅ | `lsp.servers` = `ts,py,cs,cpp`(2.6.2는 +`verse` — 의도된 제외) |
| i18n | ✅ | `app/src/lib/i18n.ts`가 2.6.2와 **동일**(ko/en 2언어). 「4언어」는 사실이 아니다 — 2.6.2도 2언어다(LSP 4언어와 혼동) |
| 패치노트 카드 | ⚠ | `PatchNotes.tsx`의 `RELEASES`에 **`3.0.0` 항목이 없다**(`2.6.2`만). 3.0으로 올라온 사용자에게 보여줄 노트가 없다 |
| 업데이트 스플래시 | ✗ | H3 |
| btw 포크 | ✗ | T4 |

### 3.5 사영표에 **행이 없는** 3.0 신규 화면 5종 (회귀 아님 · 표 갱신 필요)

`settings-talk`(M10 대화 연결 탭) · Account 탭의 「한도 소진 시 계정 자동 전환」 행(M11) ·
IDE 크롬의 **1~6 다이얼**(M-UX 일부 착지 — `App.tsx:1822`) · 사이드바 2섹션(채팅/배치) ·
`TalkStop` 긴급 정지 알약. 사영표 §6(「늘리는 화면」)에 이 다섯 줄이 없다.

> 내부 불일치 1건: 헤더 다이얼은 **1~6**인데 새 채팅 모달은 여전히 **2~6**이다
> (블라인드 `new-chat-step2`에서 두 앱이 같았다). 같은 개념의 원천이 둘이다.

---

## 4. 사용자 결정 대기 항목 — 최신 실측으로 정리

### 4.1 성능 목표 재협상 (근거: `progress/data.js` · `bench/results/`)

| 지표 | 2.6.2 | 3.0 현재 | 목표 | 왜 재협상인가 |
|---|---|---|---|---|
| 멀티 4패널 유휴 **WS** | 712.8MB | **421.3MB** (0.59) | ≤356 | 356은 WebView2 **빈 문서 바닥값 351.5MB + 4.5MB**다. 앱 몫이 47.3MB라 구조적으로 불가 — 목표를 바닥값 기준으로 다시 쓰거나(예: 바닥+50) 포기 |
| 멀티 4패널 유휴 **Private** | 505.3MB | **253.2MB** (0.501) | ≤253 | 선상 통과. 잔여 0.2MB는 WS와 함께 결정 |
| 콜드 → 첫 창 | 336ms | **250ms** | ≤168 | 웹 런타임 기동 하한이 199~208ms(Electron도 같다) → 불가 |
| 콜드 → UI 사용 가능 | 422ms | **348ms** | ≤211 | 이론 하한 258ms → 불가 |
| 창 1개 추가 비용 | 110.7MB·+1프로세스 | **25.1MB·+0** | ≪110 | 통과(4.4배) |
| 설치 풋프린트 | **633.7MB**(실측, 파일 8141) | **미측정** | 대폭 감소 | 3.0 NSIS 설치본이 아직 없다(`bench/results/footprint-pre-install.json`, 오늘 11:54) |
| `CCG_SINGLE_PROCESS=1` | — | 전 지표 최고(WS 358.8/Priv 211.3/60fps) | — | **MS 미지원 + 크래시 복구 수단 자체가 없어짐**. 기본값으로 삼을지 사용자 결정 |

**결정 요청**: (a) WS 목표를 「바닥값 대비」로 다시 정의할지, (b) 콜드 두 목표를
「2.6.2 대비 비율」로 바꿀지(현재 0.74/0.82), (c) 단일 프로세스 모드를 옵트인으로 남길지.

### 4.2 UX 열린 문제 (`docs/design/ux-chat-unify.md` §8) — **11건이 사용자 대기**

①사이드바 구조(a/b/c 목업 있음) ②접힘 알림 강도 ③자리 비우기 = 실행 계속? ④창 닫으면
그리드 복귀? ⑦보드 목록 유지? ⑧빈 자리 기본 동작 ⑨`Board.chrome` 노출 여부
⑩새 채팅 모달 폐지 여부 ⑪읽지 않음 배지 신설 여부 ⑫배율 키 4→3 승계값
⑬**동작 변경 2건 승인**(중지가 자동 이어서 대기표까지 취소 / 전역 설정이 기존 채팅에
즉시 반영되지 않음)

여기에 사영표 §5의 승인 문장 2건(`new-chat-step1` 삭제 · `new-chat-step2` 1~6 축소)이 붙는다.

> **감사자 의견**: ⑩·⑫는 지금 코드가 이미 반쯤 답을 냈다 — 다이얼은 1~6으로 착지했는데
> 모달은 2~6이다(§3.5). 둘 중 하나는 곧 거짓말이 된다.

### 4.3 M-WF 워크플로 카드 effort — 대안 승인 대기

실측 확정(진행 페이지): `claude.exe 2.1.239`의 `workflow_agent` emitter **6개 전수 추출 →
effort 필드 없음**(`fallbackModel`은 있다). 세션 effort로 대체 표시하는 것은 거짓이라 기각.
**대안**: 카드에 `모델 + fallbackModel` 두 칩. → 사용자 승인 필요.

### 4.4 M10(세션 간 협업) 출하 수준

R3까지: 공격 8종 HELD 8/8, N7 3회 0/3, 봉투에서 비밀 제거, 권한 하한 readonly + 회신 전용,
긴급 정지 알약(못 멈춘 수까지 문장으로). **다만 프롬프트 인젝션은 닫히지 않았다**는 사실을
문서·UI 어휘로 통일해 둔 상태다. 기본값은 꺼짐이고 켤 때 한계 고지 카드가 뜬다.
→ **결정**: 3.0.0 정식에 이 상태로 낼지(고지+기본 꺼짐), 아니면 beta 플래그 뒤로 숨길지.

### 4.5 SmartScreen / 코드 서명

`src-tauri/tauri.conf.json`에 **서명 설정이 없다**(`certificateThumbprint`·`signCommand` 부재).
NSIS 설치본이 나오면 Windows SmartScreen이 「알 수 없는 게시자」 경고를 띄운다.
2.6.2도 같은 상태였는지는 이 라운드 범위 밖이지만, 3.0은 **제품명·바이너리 이름이 바뀌어**
(`AgentCodeGUI3`, `com.agentcodegui.app`) 기존 평판을 승계하지 못한다.
→ **결정**: (a) 서명 인증서 구입, (b) 경고를 감수, (c) 기존 제품명·식별자 유지로 평판 승계.

---

## 5. 하네스에 남기는 숙제 (다음 라운드가 같은 함정을 밟지 않게)

1. `bench/screens.mjs`의 `openSettings(n)`을 **라벨 기반**으로 바꿔라. 인덱스는 3.0이 탭을
   하나만 더 넣어도 6화면을 거짓 실패·2화면을 **거짓 통과**시킨다(§1.3).
2. `settings-code-expanded`의 `.sc2.row2[4]`(=2.6.2 Verse 행)를 `.sc2.row2.disc`로 바꿔라.
3. 픽스처의 `limitResume.hold`에 `at: Date.now()`를 넣어라 — 없으면 `sanitizeHold`가 버린다.
4. 픽스처가 `codex-engines`도 정션해야 한다. 안 그러면 2.6.2만 실홈을 읽어(그쪽 버그)
   비교가 어긋난다.
5. `boot-splash-native`의 `early: 'data:'`는 3.0에 해당 타깃이 없다 — 3.0은 창 안 오버레이라
   `#root` 옆의 `.ccg-splash`를 `selfShot`으로 잡아야 한다.
6. `error-boundary`는 **패스 맨 끝**으로 옮기거나 별도 기동으로 격리하라(§1.4가 고쳐지기 전까지).

---

## 6. 종합 판정

| 사용자 기준 | 판정 |
|---|---|
| 기존 기능 전부를 화면 단위로 대조해 하나도 빠뜨리지 않았는가 | **아직 아니다.** 화면 도달은 96.6%지만, **채널 46개 미구현**이 만든 「눌러도 안 되는 화면」이 남아 있다. 특히 T1(계정 로그인)·T2(엔진 설치)는 **새 사용자가 3.0을 시작할 수 없게** 만든다 |
| 블라인드 나란히 비교에서 UI가 지지 않는가 | **지지 않는다.** 이번 19건 5승 13무 1패, 1440px 누적 12승 13무 1패. 유일한 패는 디자인이 아니라 **빠진 데이터**(한도) |
| 남은 최대 격차 하나 | **T1+T2+T3 = 「계정·엔진·한도」 세 축의 IPC 배선.** 이 셋이 붙으면 블라인드 1패도 같이 사라진다 |
| 그 다음 | §1.4 에러 안전망 부팅 루프 — 데이터 손실은 없지만 **앱이 열리지 않는다** |
