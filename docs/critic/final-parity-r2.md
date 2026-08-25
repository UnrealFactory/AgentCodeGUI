# 최종 파리티 감사 R2 — 열여섯 중 열넷은 진짜로 닫혔다. 남은 둘은 「엔진 하나를 통째로 못 쓴다」와 「앱이 안 열린다」다

> ⛔ **정정됨 — 이 문서는 단독으로 읽지 마라.** `docs/critic/final-parity-r3.md`가 네 칸을
> 내렸다: T3의 「역전·3.0 승」과 §5 블라인드 칸(**철회 — 환경 의존 화면**) · T1 「클로드 축 닫힘」
> (→ **로그인/로그아웃 왕복 미검증**) · N3 중간(→ **높음**) · 헤드라인 99.2%(→ **통짜 73.6% 병기**).
> §0의 「픽스처가 실홈 `accounts.json`을 복사한다」도 반쪽이다 — **2.6.2는 `CCG_HOME`을 무시하고
> 실홈을 읽는다**(R3 §2.5).

판정자: 최종 파리티 크리틱 R2(새 컨텍스트) · 2026-08-25 · `feature/3.0.0-beta` @ `72a142d`
대상: 2.6.2 Electron(`node_modules/electron` + `out/`) vs 3.0.0-beta.1 Tauri
직전 감사: `docs/critic/final-parity-r1.md`(2026-08-24 @ `076bf8c` — 치명 4 · 높음 5(+§1.4) · 중간 6)

> **나는 R28 라운드들의 「닫았다」를 믿지 않았다.** 열여섯 항목을 전부 **커밋된 소스에서
> 다시 구운 exe**로, 코드가 아니라 **화면에서 눌러** 다시 쟀다.

## 0. 측정 대상 — 옆 갈래의 미커밋이 한 바이트도 안 섞였다

같은 워킹트리에서 네 갈래가 동시에 돈다(감사 시작 시 `crates/ccg-auth` 4파일이 미커밋이었다).
그래서 R28d가 쓴 방식대로 **순수 트리를 떠서** 거기서만 구웠다.

| 항목 | 값 |
|---|---|
| 판정 트리 | `git archive HEAD`(`72a142d`) → `C:\Temp\ccg-r28e\wt` (`git worktree` 미등록 · 공유 `.git` 무변) |
| 의존성 | `node_modules`만 정션 (`npm ci`·`npm install` **0회**) |
| 프론트 | `npm run app:build` (vite, 2.16s) |
| 셸 | `cargo build --release --features custom-protocol` · `CARGO_TARGET_DIR=C:\Temp\ccg-r28e\target` (**새 디렉터리** — 재활용 시 거짓 초록 함정 회피) · 2m17s |
| 산출 exe | `C:\Temp\ccg-r28e\target\release\agentcodegui.exe` · 6,507,008 B · sha256 `0bbd18264b0aaa3b` · 2026-08-25T05:50:50Z |
| 홈 | 전 주행 격리(`%TEMP%\ccg-screens-*` · `%TEMP%\ccg-r28e-*`) · CDP 포트 태그 분리(10230~10235 · 9637) |
| 프로세스 | 이름 기반 kill **0회** — 내가 스폰한 PID만(`taskkill /T /F /PID 5128`) |

> **측정 기준선 이후에 두 커밋이 착지했다**(감사 중 옆 갈래가 커밋했다):
> `61d818a` R28e WFIRE R1(`app/src/lib/limitResume.ts`·`useLimitResume.ts`·`store/session.ts`·
> `ccg-engine/limit.rs`·`runtime.rs`) · `b6c559b` R28e CASX2(`ccg-auth` 원장).
> 이 보고서의 수치는 **전부 `72a142d`**의 것이다. 둘 중 어느 것도 이 라운드의 치명 2건이
> 짚는 자리(`codex-auth:*` 배선 · `ErrorBoundary`/`activeChatId` 영속 · `app:open-directory`)를
> 건드리지 않으므로 **N1·N2·N3의 판정은 그대로 선다.** 다만 WFIRE가 한도 이어서의 렌더러
> 두 파일을 바꿨으므로 `limit-hold-bar`·`workbar-context-pop`의 **화면 수치는 다음 라운드에
> 다시 떠야 한다**(이 라운드 값은 그 커밋 이전이다).

### 증거 파일 (전부 이 라운드 산출)

| 파일 | 무엇 |
|---|---|
| `bench/shots/tauri-r28e/report.json` · `bench/shots/electron-r28e/report.json` | 전 화면 A/B(각 121시도 · 실패 재주행 `--merge`) |
| `bench/shots/tauri-r28e2/report.json` | 3.0 **2차 통짜** 주행(플레이키 판정) |
| `bench/shots/tauri-r28ex/report.json` | 격리 재현·`--keep` 진단 주행 |
| `docs/critic/final-parity-r2-channels.json` | 계약면 216채널 × 커밋 Rust 소스 전수 대조 |
| `docs/critic/final-parity-r2-apiprobe-{tauri,electron}.json` · `-tauri-nonet.json` | 같은 `window.api` 호출 3벌(3.0 · 2.6.2 · 3.0 `CCG_NO_NET=1`) |
| `docs/critic/final-parity-r2-press-tauri.json` · `-tauri-eb.json` · `-electron-eb.json` · `-electron-limit2.json` | **화면에서 눌러 본** 결과 |
| `docs/critic/final-parity-r2-pixdiff.json` · `-xmin250.json` | 119쌍 픽셀 차이(임계 32) |

도구(전부 신규 · `docs/critic/tools/`): `critic-r28e-channels.mjs` · `critic-r28e-apiprobe.mjs` ·
`critic-r28e-press.mjs` · `critic-r28e-surface.mjs` · `critic-r28e-explorer-dump.mjs`

### 안전 규약 — 무엇을 **일부러 안 했는가**

픽스처 홈은 사용자 실홈의 `accounts.json`을 **복사**하고 `engines/`·`codex-engines/`를
**정션**한다. 그래서 로그아웃(= 서버 토큰 해지) · 설치 · 정리 · 업데이트 · Codex 로그인은
**한 번도 부르지 않았다.** 계정별 한도는 `auth:accounts-usage({cachedOnly:true})` +
실홈 `usage-cache.json` **복사본**으로 봤다 — 만료 계정에서 리프레시 토큰이 회전하는
경로를 아예 안 열었다. 실 HTTP는 `usage:get(false)` 기본 계정 1건 + `npm view` 뿐이다.

---

## 1. 한 문단 결론

**R1의 열여섯 중 열넷이 진짜로 닫혔다.** 계약면 216채널의 Rust 미구현은 **46 → 18**로
줄었고, 그 18 중 실제 격차는 **5개뿐**이다(나머지는 범위 밖 6 · 두 앱 다 죽은 표면 6 ·
의도적 분기 1). 화면 A/B는 **3.0 120/121(99.2%)** 대 **2.6.2 119/121(98.3%)** —
3.0의 유일한 실패는 **2.6.2도 같이 실패**하는 대칭 실패다. R1의 블라인드 유일한 1패
(`workbar-context-pop` 한도 「데이터 없음」)는 닫힌 정도가 아니라 **뒤집혔다.**

**남은 치명은 둘이다.** ① Codex(ChatGPT) 계정 축이 통째로 죽어 있다 — 설정 ▸ Account의
OpenAI 「계정 추가」를 누르면 아무 일도 안 일어난다(`[shim] codex-auth:login — 백엔드
미구현`). R1이 클로드 축에 대해 「새 사용자는 3.0에서 로그인할 방법이 없다」고 치명을
매긴 것과 **글자 그대로 같은 상황**이 Codex 축에 남아 있다. ② R1 §1.4의 에러 안전망
부팅 루프가 **그대로다** — 이번엔 두 앱을 나란히 눌러 확인했다(2.6.2는 새로고침으로
복구, 3.0은 카드에 갇힌다).

**그러므로 치명 0이 아니다. 지금 상태로는 출하할 수 없다.**

---

## 2. R1이 지적한 16건 — 하나씩 실측

### 2.1 치명 4

| # | R1의 지적 | 판정 | 이번 라운드 실측 |
|---|---|---|---|
| **T1** | 계정 로그인/로그아웃/기본/삭제/순서 Rust 핸들러 0 | **부분 닫힘** | **클로드 축 닫힘**: `auth:login`·`login-cancel`·`login-url`·`logout`·`set-default-account`·`remove-account`·`reorder-accounts` 전부 코드에 있고(`ipc/accounts.rs`) 원시 호출이 `__unimplemented`가 아니다(`raw:auth:login-cancel` → `{ok:true}`). no-op 재정렬이 **6행**을 돌려준다. 설정 ▸ Account에 6계정 · 「삭제」6 · 「맨 위로」5 · 「계정 추가」2가 그려진다. ⛔ **Codex 축은 안 닫혔다 → §4 N1** |
| **T2** | 엔진 설치·전환·정리 + 미설치 안내 게이트 미구현 | **닫힘** | `engine:list-available`·`install`·`uninstall`·`set-active`·`cleanup`·`install-progress` 전부 구현(`engine/versions.rs`). `engine.listAvailable().latest = "0.3.245"`(R1은 `null`이라 게이트가 영영 안 떴다). A/B `engine-gate-prompt` **3.0 OK · 2.6.2 OK**(boot:no-engines) |
| **T3** | `usage:get`·`auth:accounts-usage` 값이 전부 null | **닫힘 + 역전** | `usage:get(false)` → `{fiveHour:{pct:0}, weekly:{pct:100, resetsAt:1787752800}, weeklyFable:{pct:33}, extraCredit:{…}}` **실값**. `auth:accounts-usage({cachedOnly:true})` → 6계정 실값(`{email, fiveHourPct:0, weeklyPct:100, fablePct:33, …}`) · **네트워크 0회**. `CCG_NO_NET=1`에서는 `{…nulls, unavailable:true}` — 「못 물어봤다」 표식이 실제로 붙는다(= 위 실값은 캐시가 아니라 진짜 조회였다는 증명) |
| **T4** | `/btw` 포크 창 `btw:open` 핸들러 0 | **닫힘** | A/B `btw-dock` · `multi-panel-btw-dock` · `session-window-btw` **3/3 OK**(R1은 3/3 실패). 실제로 `#session` 창이 뜨고 사이드바에 「BTW - …」 행이 남는다 |

**T3 역전의 실측**(`limit-pop` press · 같은 픽스처 · 같은 시각대):

```
3.0    prows=5  「5시간 한도 초기화 시간 미상 100% 남음 · Fable 주간 한도 1일 7시간 후 초기화 67% 남음
                · 주간 한도 1일 7시간 후 초기화 0% 남음」          hasNoData=false
2.6.2  prows=4  「5시간 한도 데이터 없음 — · 주간 한도 데이터 없음 —」  hasNoData=true  (2회 재측정 동일)
```

A/B 리포트의 `found` 수도 같은 말을 한다: `workbar-context-pop` **T=5 / E=4**.
R1의 블라인드 유일한 1패는 사라졌고, 이 화면은 이제 **3.0 승**이다.
(2.6.2가 이 환경에서 왜 null인지는 이 라운드 범위 밖이다 — 격리 홈에서의 토큰 갱신 실패로 보인다.)

### 2.2 높음 (R1 §3.2는 H1~H5 **5건**이다 — 지시문의 「높음 6」은 §1.4를 여섯 번째로 센 것으로 읽고 같이 판정한다)

| # | 판정 | 실측 |
|---|---|---|
| **H1** 첨부 파일 선택 | **닫힘** | 컴포저 `.composer button.plus`를 **눌렀더니** 내가 스폰한 PID의 **새 네이티브 창**이 떴다(제목 = 「첨부할 파일 선택」). WM_CLOSE로 닫아 원복 확인. `ipc/parity/dialog.rs` |
| **H2** MCP·Skill 목록/토글 | **닫힘** | `.mcp.json` + `.claude/skills/bench-skill`를 심은 스크래치 프로젝트에서 **두 앱 동일**: `mcp.list` = `[{name:'bench-echo', scope:'local', transport:'stdio', enabled:true}]`, `skill.list` = `[{name:'bench-skill', …}]`. R1은 3.0 0건/0건이었다. A/B `settings-mcp`·`settings-skill` found **3/3 동일** |
| **H3** 앱 자동 업데이트 | **범위 밖** | 지시 4번(설계 문서만이 맞다). `app:update-check`·`update-install`·`update-event` 미구현 유지 — 회귀로 잡지 않는다 |
| **H4** Codex 모델 목록 | **닫힘** | `codexModels()` 두 앱 동일(`gpt-5.6-sol` 외) |
| **H5** 추가 채팅 창 닫기 flush | **닫힘** | `win.rs:485 CloseRequested` → `flush_req` → **두 이름 다 방출**(`session-wins:flush-request` 2.6.2 이름 · `chat:flush-req` 3.0 이름 — 장부 §3.5.1) + `FLUSH_GRACE 1500ms` 뒤 `destroy()`. R1의 「방출자 0」은 사라졌다 |
| **(6번째) §1.4** 에러 안전망 | ⛔ **안 닫혔다** | §4 N2 |

### 2.3 중간 6

| # | 판정 | 실측 |
|---|---|---|
| **M1** `shortcut:close` | **닫힘** | `ipc/parity/misc.rs` `CLOSE_SHORTCUT_JS` 주입(메인 + 추가 채팅 창) + 같은 이름으로 되쏨. 원시 호출 `{ok:true}`(미구현 아님) |
| **M2** `app:open-directory` | ⚠ **반만 닫힘** | 콜드 실행은 된다(`app:get-initial-dir` — `parity/misc.rs::initial_dir`). **이미 떠 있는 앱에 폴더를 보내는 길은 없다** → §4 N3 |
| **M3** `ui:open-api-settings`·`ui:api-settings-requested` | **닫힘** | 원시 호출 `{ok:true}` |
| **M4** `engine:install-progress` | **닫힘** | `engine/versions.rs:36` |
| **M5** `git:ai-message` | **닫힘** | `ipc/parity/aimsg.rs`. 같은 인자로 **두 앱 응답 동일**(`{ok:false, "Git 저장소가 아니에요"}`) — 채널이 살아 있고 판정도 같다 |
| **M6** `engine.state.bundled = "unknown"` | **의도** | 3.0 `"unknown"` / 2.6.2 `"0.3.161"` — SDK 미번들(M3). 회귀 아님 |

### 2.4 계약면 216채널 재대조 — 46 → 18, 그중 실격차 5

`docs/critic/tools/critic-r28e-channels.mjs`가 `src/shared/protocol.ts`의 `IPC` 맵을
TS AST로 읽어 **순수 트리의 Rust 소스 전수**와 대조한다(주석에만 있는 것은 미구현으로 센다 —
R1의 `btw:open`이 정확히 그 함정이었다).

```
total 216 · impl 198 · commentOnly 0 · missing 18      (R1: impl 170 · missing 46)
```

| 갈래 | 수 | 채널 |
|---|---|---|
| **범위 밖**(지시 4번) | 6 | `lsp:pick-verse-server`·`lsp:set-verse-path`·`lsp:clear-verse-path` · `app:update-check`·`app:update-install`·`app:update-event` |
| **두 앱 다 죽은 표면** | 6 | `talk:run`·`talk:cancel`·`talk:permission-respond`·`talk:question-respond`·`talk:bg-task`·`talk:event` — 1.x 「채팅 모드」의 잔해다. **2.6.2 렌더러도 안 부른다**(`window.api.talk`의 유일한 호출부는 `App.tsx`의 `getState`/`saveState` 마이그레이션 2줄이고 그 둘은 3.0에 구현돼 있다) |
| **의도적 분기**(장부 §6.5) | 1 | `codex-auth:set-default-account` — 「기본 계정」 제거로 3.0 화면이 안 부른다 |
| ⛔ **남은 실격차** | **5** | `codex-auth:login`·`codex-auth:logout`·`codex-auth:login-cancel`·`codex-auth:reorder-accounts`(N1) · `app:open-directory`(N3) |

**계약면 메서드 누락은 0이다.** `WindowApi` 표면 184개 잎 이름 전수 대조에서
`app/src/api/shim.ts`에 없는 것 **0개**(`critic-r28e-surface.mjs`). 즉 "메서드가 통째로
없어 화면이 죽는" 자리는 없고, 남은 건 전부 "심이 안전값으로 갈음하는" 자리다.

---

## 3. ★ 하네스 숙제 반영본으로 A/B 재주행 — 거짓 통과 2건이 진짜 판정이 됐다

M12 R2(`581a27c`)가 R1 §5의 숙제 6건을 반영했다. 그 반영본으로 다시 쟀다.

### 3.1 총계

| | 2.6.2 | 3.0 | R1의 3.0 |
|---|---|---|---|
| 하네스 정의(비내부) | 156 | 156 | 156 |
| 시도 | 121 | 121 | 124 |
| 성공 | **119** | **120** | 108 |
| 실패 | 2 | **1** | 16 |
| skip | 35 | 35 | 1 |
| 성공률(skip 제외) | **98.3%** | **99.2%** | 87.1%(보정 96.6%) |

`--merge` 규약대로 통짜 주행 뒤 실패 화면만 재주행해 병합했다(원 리포트
`bench/shots/{tauri,electron}/report.json`은 **한 글자도 안 건드렸다**).

### 3.2 거짓 통과가 진짜 판정으로 바뀌었는가 — **바뀌었다**

R1이 인덱스 드리프트로 **거짓 실패 6 · 거짓 통과 2**를 만들었던 묶음이 전부 초록이다.

```
settings-display   FAIL→OK (found T=3 E=3)    settings-language   FAIL→OK
settings-explorer  FAIL→OK                    settings-gestures   FAIL→OK
settings-code-expanded FAIL→OK                autohide-preview    FAIL→OK
sidebar-autohide-edge  FAIL→OK                settings-code-lsp   OK(진짜) — found T=4 E=5
```

- `settings-display`·`settings-code-lsp`는 R1에서 **Talk 탭·Language 탭을 찍고 통과**하고
  있었다. 이제 `openSettings()`가 **라벨**을 누르고 **선택된 탭이 그 라벨인지 확인**까지
  하므로 같은 종류의 거짓 통과가 구조적으로 안 생긴다.
- `settings-code-lsp`의 4 vs 5는 **Verse 제외**(범위 밖)라 의도된 차이다.
- R1에서 「양쪽 실패」였던 `boot-splash-native`·`limit-hold-bar`도 두 앱 다 OK가 됐다
  (숙제 3·5).

### 3.3 남은 실패 3건 — 하나도 3.0 단독이 아니다

| 화면 | 3.0 | 2.6.2 | 판정 |
|---|---|---|---|
| `settings-engine-confirm` | FAIL | FAIL | **대칭 · 환경** — 실홈의 **유효** 설치본이 1개(`0.3.245`)뿐이라 `oldCount = installed.length - 1 = 0` → 「정리」 행 자체가 안 그려진다. `0.3.241`·`0.3.243`은 `node_modules/@anthropic-ai/claude-agent-sdk`가 없는 반쪽 설치라 **두 앱의 같은 판정식**(`installedVersionAt`/`installed_version_at`)이 똑같이 제외한다. R1이 「픽스처 비대칭」이라 적은 원인은 숙제 4로 해소됐고, 남은 것은 앱 차이가 아니다 |
| `btw-dock` | OK | **FAIL**(2/2) | **2.6.2 단독 실패** — 3.0이 이긴다 |
| (통짜 1회차의 `multi-exit`) | 내부 화면 | — | 집계 대상 아님(`internal`) |

### 3.4 ★ 통짜 주행의 31화면 연쇄 실패는 **하네스 결함이다** (원인까지 잡았다)

3.0 통짜 주행 **2/2**에서 같은 지점이 무너졌다 — `explorer-blank` 다음부터 뷰어 23 · Git 7 ·
`changed-files-modal` 1이 연쇄로 죽어 73.6%가 나온다. R1 리포트에는 이 화면들이 OK였으므로
**3.0 회귀로 보이는 모양**이었다. 아니었다.

`ab.mjs --keep`으로 실패한 그 순간의 앱을 살려 두고 붙어서 봤다(`critic-r28e-explorer-dump.mjs`):

```
activeChatId : "fix-empty"          ← 되돌아가지 못했다
chatHead     : "폴더 선택"           ← 폴더 없는 채팅이 활성
explorer     : .exp-blank 1개, .fxs input 0, .fxr 0, .git-strip 0
sidebar 행   : ["BTW - 벤치 긴 스레드창", "벤치 긴 스레드5분", "벤치 빈 채팅15분", "벤치 예외 채팅5분"]
```

`explorer-blank`의 reset은 `clickText('.sidebar .sb-item', '벤치 긴 스레드')`인데,
`__txt`는 **부분 문자열 포함**으로 첫 요소를 고른다. 0번 행이 `btw-dock`이 남긴
**「BTW - 벤치 긴 스레드」 창 레코드**라 그게 먼저 걸린다 — 창 행을 누르면 채팅이 안 바뀐다.
그래서 조용히(예외 없이) 빈 채팅에 머물고, 그 뒤 모든 탐색기·뷰어·Git 화면이 죽는다.

같은 창에서 **`startsWith`로 다시 눌러** 반대를 실증했다:

```
click(startsWith '벤치 긴 스레드') → activeChatId = fix-long-thread
                                    chatHead = C:\Code\AgentCodeGUI
                                    .fxs input 1 · .fxr 254 · .git-strip 1   ← 전부 되살아난다
```

2.6.2에서 안 터진 이유도 같은 뿌리다 — 2.6.2는 `btw-dock`이 **실패**해서 그 창 행이
아예 안 생긴다. 즉 **3.0이 T4를 고쳐서 새로 생긴 행이 하네스의 느슨한 매칭을 밟았다.**
격리 재주행 3/3(3화면 · 13화면 · 9화면)이 전부 초록인 것도 이걸로 설명된다.

> 이 발견은 픽셀 비교에도 그대로 걸린다. 3.0 쪽 사진에는 사이드바 행이 **하나 더** 있어
> 이후 전 화면의 레이아웃이 밀린다 — 그래서 이번 라운드의 `final-parity-r2-pixdiff.json`
> (119쌍, 600px 미만 8쌍 · xmin=250에서 11쌍)은 **UI 격차의 근거로 못 쓴다.**
> R1의 20/114와 직접 비교하지 말 것. 다음 라운드는 두 앱의 **잔존 상태를 대칭으로**
> 맞춘 뒤 다시 떠야 한다.

---

## 4. 156화면 사영표 훑기 — 남은 파리티 격차 5건

사영표(`docs/design/ux-parity-map.md`) 156행 · 하네스 정의 156 · 시도 121 · skip 35
(35건은 **두 앱 동일**하고 사유도 전부 「엔진 턴 필요 · 파괴적 · 비결정적 · OS 자동화 불가」다 —
Verse 2행은 지시 4번의 범위 밖이다).

### N1 — ⛔ **치명** · Codex(ChatGPT) 계정 축이 통째로 죽어 있다

**화면에서 눌러 확인**(`final-parity-r2-press-tauri.json` `codex-login`):

```
설정 ▸ Account ▸ OpenAI ▸ 「계정 추가」 클릭
  → 4.0초 뒤: 스피너 0 · 브라우저 0 · 새 창 0 · codex 계정 수 0 (변화 없음)
  → 콘솔: [shim] codex-auth:login — 백엔드 미구현 채널 (3.0 M1: 안전값 반환)
```

원시 호출도 같은 말을 한다: `raw:codex-auth:login-cancel` = **UNIMPLEMENTED** ·
`raw:codex-auth:reorder-accounts` = **UNIMPLEMENTED**. Rust 전수 스캔에서
`"codex-auth:login"`·`"codex-auth:logout"`·`"codex-auth:login-cancel"`·
`"codex-auth:reorder-accounts"` 문자열이 **0회**다(도메인 `ccg_auth::codex::reorder_accounts`는
`crates/ccg-auth/src/codex.rs:305`에 **있는데 셸이 안 부른다**).

죽는 조작(전부 `app/src/components/Settings.tsx`가 실제로 부르는 것):

| 조작 | 호출 | 결과 |
|---|---|---|
| OpenAI 「계정 추가」 | `codexAuth.login()` | 무반응 |
| OpenAI 「삭제」 | `codexAuth.logout(email)` | 무반응 |
| OpenAI 「맨 위로」 | `codexAuth.reorderAccounts(order)` | 무반응 |
| 꾹-드래그 재정렬 · 정렬 버튼 2종 | `codexAuth.reorderAccounts(...)` | 무반응 |
| 로그인 중 「취소」 | `codexAuth.cancelLogin()` | 무반응 |

**두 번째 피해가 더 나쁘다.** 심의 안전값이 `[]`라, 위 넷은 전부
`setCxAccounts(await …)` 자리에 **빈 배열을 앉힌다** — 즉 codex 계정이 있는 사용자가
「맨 위로」나 정렬을 누르면 **화면의 OpenAI 계정 목록이 통째로 사라진다**(재열기 전까지).
실측 확인: `codexAuth.reorderAccounts(현재 순서)` → `{isArray:true, n:0}`.

**장부가 사실과 다르다.** `docs/renderer-divergence.md` §6.5는
*"`codex-auth:set-default-account` … 3.0 화면은 안 부른다(**`reorderAccounts`로 같은 결과를
저장한다**)"* 라고 적고, `Settings.tsx:521`의 주석도 *"결과는 같고(맨 위 = 기본), **실제로
저장된다**"* 라고 적는다. **저장되지 않는다** — 그 채널에 핸들러가 없다.

등급 근거: R1은 클로드 축의 같은 상황(로그인 채널 0)에 **치명**을 매겼고 이유는
「새 사용자는 3.0에서 로그인할 방법이 없다」였다. Codex 축은 지금 **글자 그대로 같은 상태**다
(실홈의 `codex-accounts.json`은 `accounts: []` — 즉 이 사용자는 3.0에서 Codex 구독 엔진을
**한 번도 못 쓴다**). 완화 요소: ① 엔진 축의 나머지는 산다(`codex-engine:*` 6채널 ·
`codex-auth:list-accounts` · `codex-auth:accounts-usage` · `codex:models` 전부 구현) ②
OpenAI **API 키** 과금 경로는 별개로 산다. 그래서 「두 엔진 중 하나」짜리 치명이다.

### N2 — ⛔ **치명** · 에러 안전망에서 나올 수 없다 (R1 §1.4 그대로)

이번엔 **두 앱을 나란히 눌러** 쟀다(`-press-tauri-eb.json` / `-press-electron-eb.json`).
같은 픽스처 · 같은 순서 · 같은 조작(예외 채팅 선택 → 카드의 **「앱 새로고침」 실제 클릭** → 재접속):

```
                    선택 직후                    새로고침 뒤
3.0    eb-card 1 · sb-item 0 · win 0   →   eb-card 1 · sb-item 0 · win 0 · chat 0   ← 갇힌다
2.6.2  eb-card 1 · sb-item 0 · win 0   →   eb-card 0 · sb-item 3 · win 1 · chat 1   ← 복구된다
```

`ErrorBoundary.tsx`는 두 앱이 **바이트 동일**이고(diff 0줄), 갈리는 것은 스토어다 —
3.0은 `activeChatId`를 즉시 영속하므로(`chats_v3::set_active`) 예외 채팅이 활성인 채로
재부팅되고 앱 루트 경계가 다시 잡는다. 화면에는 사이드바도 창 크롬도 없다 = **다른 대화로
갈 수단이 없다.** 카드 문구는 *"대화 기록은 저장되어 있습니다"*인데 그 기록에 닿을 길이 없다.

사영표 §1의 `error-boundary` 행이 계획한 **A + I/G/W**(자리 단위 경계)가 정확히 이걸
겨냥한 것인데 아직 이식본 그대로(앱 루트 1벌)다. A/B에서 이 화면이 **양쪽 OK**로 찍히는
이유도 적어 둔다 — 하네스는 카드가 뜨는지만 보고 **나올 수 있는지는 안 본다.**

### N3 — 중간 · 「AgentCodeGUI3으로 열기」가 **떠 있는 앱**에는 폴더를 못 보낸다

2.6.2는 두 번째 실행을 단일 인스턴스 락으로 받아 창을 올리고 **`app:open-directory`로 폴더를
전달**한다(`src/main/index.ts:1910-1916`). 3.0은 같은 자리에서 창만 올리고 폴더를 **버린다**
(`src-tauri/src/main.rs:171-177` — `win::tray::raise_existing()` 후 `return`).
채널 `app:open-directory`는 Rust에 없다(전수 스캔 0회).

M12 R2가 우클릭 메뉴 「AgentCodeGUI3으로 열기」를 **실제로 등록**했으므로(커밋 `60022e0`),
사용자가 그 메뉴를 누르는 순간 **앱이 이미 떠 있으면 아무 폴더도 안 열린다**(창만 앞으로 온다).
콜드 실행은 정상이다(`app:get-initial-dir`). `ipc/parity/misc.rs`가 **의도적 연기**라고
적어 두었으나, 메뉴가 이미 배포 경로에 붙은 지금은 「연기」가 아니라 **격차**다.

### N4 — 낮음 · 토스트 창의 **콘텐츠 폭**이 16px 넓다

A/B 하네스의 캔버스 대조가 잡았다(두 앱 리포트의 `canvasMismatch`):

```
toast-single     3.0 [360,109]  vs  2.6.2 [344,103]
toast-aggregate  3.0 [360,172]  vs  2.6.2 [344,164]
```

상수는 **양쪽 다 360**이다(`src-tauri/src/notify.rs:57 TOAST_W = 360.0` ·
`src/main/notifyToast.ts:31 TOAST_W = 360`). 2.6.2는 `BrowserWindow({width:360})`가
콘텐츠 344로 앉고, 3.0은 콘텐츠가 그대로 360이다 — 즉 **의도한 디자인 차이가 아니라
프레임 폭을 안 뺀 것**으로 보인다. 카드가 16px 넓게 그려지고 줄바꿈이 달라진다(높이 6~8px 차).
장부 §6.2(M-UI 알림 재설계)에 **크기를 바꾼다는 문장이 없다.**

### N5 — 낮음 · 「1~6 다이얼」과 「2~6 모달」이 아직 둘 다 산다 (R1 §3.5 그대로)

`MultiAgent.tsx:70 COUNT_OPTIONS = [1,2,3,4,5,6]` vs `NewChatModal.tsx:7 COUNTS = [2,3,4,5,6]`.
2.6.2 대비 회귀는 아니다(2.6.2 모달도 2~6). **내부 불일치**이고 사영표 §5-2·열린 문제 ⑩의
사용자 승인을 기다리는 자리다 — R1이 지적한 뒤 한 라운드가 지났는데 그대로다.

### 4.1 「됐다」로 다시 확인한 것

| 기능 | 판정 | 근거 |
|---|---|---|
| 계정(클로드) 추가·삭제·순서 | ✅ | §2.1 T1 |
| 엔진 설치·전환·정리·게이트 | ✅ | §2.1 T2 |
| 한도(워크바·계정별·자동 이어서 재검증) | ✅ | §2.1 T3 · `unavailable` 표식 실측 |
| /btw 포크 창(3표면) | ✅ | §2.1 T4 |
| 첨부 파일 선택 | ✅ | §2.2 H1 — 네이티브 대화상자 실제 표시 |
| MCP·Skill | ✅ | §2.2 H2 — 두 앱 1건/1건 |
| Codex 모델·엔진·계정 한도 | ✅ | 두 앱 동일 |
| 추가 채팅 창 닫기 flush | ✅ | §2.2 H5 |
| Ctrl+W · API 설정 점프 · AI 커밋 메시지 | ✅ | §2.3 M1·M3·M5 |
| 패치노트 3.0.0 덩이 | ✅ | `PatchNotes.tsx:38 '3.0.0'` + 「현재 버전 노트 없으면 최신」 폴백(앱 버전이 `3.0.0-beta.1`이라 필요) |
| 계정 삭제 확인 카드 부재 | ✅ 대칭 | `doDelete`가 두 앱 다 확인 없이 `auth.logout` — 3.0 회귀 아님(인벤토리 행 정정 필요) |
| `WindowApi` 184 표면 | ✅ | 심 누락 0 |
| Codex 계정 추가·삭제·순서 | ✗ | **N1** |
| 에러 안전망 탈출 | ✗ | **N2** |
| 떠 있는 앱에 폴더 보내기 | ✗ | **N3** |

---

## 5. 종합 판정 — 치명 0인가? **아니다 (2)**

| 사용자 기준 | 수치 | 판정 |
|---|---|---|
| 기존 기능을 화면 단위로 하나도 빠뜨리지 않았는가 | 화면 도달 **120/121 = 99.2%**(2.6.2 119/121 = 98.3%) · 유일 실패는 **대칭** · 계약면 **211/216 = 97.7%** 실사용 가능 | **거의. 다만 아니다** — 남은 5채널 중 4개가 「Codex 계정」 한 축에 몰려 있어 그 엔진을 **시작할 수 없다** |
| 블라인드에서 UI가 지지 않는가 | R1의 유일한 1패(`workbar-context-pop`)가 **역전**(3.0 5행 실값 vs 2.6.2 4행 「데이터 없음」). 이번 라운드 픽셀 대조는 잔존 상태 비대칭으로 **근거 불가**(§3.4) | **지지 않는다**(단, 픽셀 근거는 다음 라운드에 다시 떠야 한다) |
| 치명 0인가 | **2** (N1 Codex 계정 축 · N2 에러 안전망 부팅 루프) | ⛔ **출하 불가** |
| 그 둘을 빼면 | 높음 **0** · 중간 **1**(N3) · 낮음 **2**(N4·N5) | 나머지는 출하를 막지 않는다 |

**R1 대비 이동**: 치명 4 → **2**(T1 절반·T2·T3·T4 닫힘, §1.4가 치명으로 승격) ·
높음 5 → **0**(H3은 범위 밖) · 중간 6 → **1**.
미구현 채널 **46 → 18**, 그중 실격차 **5**.

**출하 조건(수치로)**: N1의 4채널 + N2의 부팅 경로 1건 = **5건**을 닫으면 치명 0이 되고,
계약면은 214/216(99.1%)이 된다. 남은 2채널(`app:open-directory` · `codex-auth:set-default-account`)은
각각 중간·의도적 분기다.

---

## 6. 다음 라운드에 남기는 숙제

### 6.1 하네스 (이번에 새로 밟은 것)

1. **`clickText`의 부분 문자열 매칭이 채팅 제목에 쓰이면 안 된다.** `selectChat`은
   `.sb-item`의 텍스트가 제목으로 **시작하는지**(또는 제목 노드 정확 일치)로 골라야 한다.
   3.0이 T4를 고쳐 사이드바에 「BTW - <부모 제목>」 행이 생기는 순간 이 매칭이 31화면을
   조용히 죽였다(§3.4). **부분 일치는 이 하네스에서 이미 두 번째 사고다**(R1 §5-1 인덱스 드리프트와 같은 계열).
2. **`selectChat`은 바뀐 것을 확인해야 한다.** 지금은 클릭만 하고 돌아온다 —
   `openSettings()`가 「선택된 탭이 그 라벨인가」를 확인하도록 고친 것과 **같은 처방**을
   여기에도 적용하라(활성 채팅 제목 또는 `chats:get().activeChatId` 확인).
3. **잔존 상태를 두 앱에서 대칭으로 맞춰라.** `btw-dock`이 한쪽에서만 성공하면 그 뒤 전
   화면의 사이드바 행 수가 달라져 **픽셀 비교의 전제가 깨진다**(§3.4 인용문).
   화면별 `reset`이 만든 레코드(창·포크 세션)를 지우거나, 픽셀 비교 전에 사이드바 상태를 맞춰라.
4. `error-boundary`는 **카드가 뜨는지**만 보고 **나올 수 있는지**는 안 본다. N2가 살아 있는
   동안에는 A/B 초록이 그 사실을 가린다 — 「새로고침 후 복구」 판정을 화면 정의에 넣어라.
5. 2.6.2 쪽 `Page.captureScreenshot` 타임아웃이 통짜 1회차에서 **15건** 났다(재주행에서 전부 초록).
   Electron 창이 가려지면 프레임을 안 만드는 알려진 성질이라, 캡처 실패는 **자동 1회 재시도**로 흡수하는 게 맞다.
6. `settings-engine-confirm`은 **환경 의존**이다(유효 설치본 ≥2 필요). 픽스처가 조건을
   못 만들면 `skip` 사유를 적어 두는 편이 「실패」로 남는 것보다 정직하다.

### 6.2 장부·주석 정정 (사실과 다른 두 줄)

- `docs/renderer-divergence.md` §6.5 표의 `codex-auth:set-default-account` 행:
  *"reorderAccounts로 같은 결과를 저장한다"* → **저장되지 않는다**(N1).
- `app/src/components/Settings.tsx:525` 주석: *"결과는 같고(맨 위 = 기본), 실제로 저장된다"* → 같음.

### 6.3 사용자 결정 대기(R1 §4에서 이월 · 이번 라운드에서 안 건드림)

성능 목표 재협상(WS·콜드 2건·단일 프로세스 모드) · UX 열린 문제 11건 + 승인 문장 2건 ·
M-WF 워크플로 카드 effort 대안 · M10 출하 수준 · SmartScreen/코드 서명.
여기에 **N5(다이얼 1~6 vs 모달 2~6)** 가 붙는다 — R1이 *"둘 중 하나는 곧 거짓말이 된다"*
고 적은 뒤 한 라운드가 지났다.
