# M1 — 뼈대 (Tauri 셸 + 렌더러 이식 + IPC 디스패처)

라운드 1 · 2026-08-22 · 브랜치 `feature/3.0.0-beta`

자기 채점은 하지 않는다. 아래는 **무엇을 만들었고, 무엇을 어떻게 실측했고, 무엇이
아직 없는지**의 기록이다. 판정은 크리틱 몫.

---

## 1. 빌드·실행

```bash
npm install                 # @tauri-apps/cli@2, @tauri-apps/api@2 포함
npm run tauri:build         # ★ 유일한 정식 빌드 경로 (vite build → cargo build --release)
# 산출물: target/release/agentcodegui.exe   (워크스페이스 루트의 target/ — 크레이트 공유)

# 격리 홈으로 실행 (사용자 실앱과 단일 인스턴스 충돌 없음)
CCG_HOME=.bench-home-tauri ./target/release/agentcodegui.exe

npm run tauri:dev           # vite dev(5273) + cargo run — 프론트엔드 HMR
```

> **`cargo build --release`만 단독으로 쓰지 말 것.** tauri는 `custom-protocol` 피처가
> 꺼져 있으면 dev로 간주해 `devUrl(http://localhost:5273)`을 로드한다. 릴리즈 exe인데
> 빈 오류 페이지가 뜨고, dev 서버가 떠 있으면 **벤치가 dev 서버를 재는 사고**가 난다
> (이번 라운드에 실제로 한 번 밟았다 — 그래서 `scripts/poc-tauri-stores.mjs`가
> `location.href`가 `http://tauri.localhost`인지 먼저 확인한다). 수동 빌드가 필요하면
> `cargo build --release --features custom-protocol`.

측정 하네스:

```bash
node bench/coldstart.mjs tauri 4      # 첫 가시 창 / #root 마운트
node bench/idlemem.mjs   tauri 60     # 유휴 메모리 (프로세스 트리 합산)
node scripts/poc-tauri-chrome.mjs b   # 창 껍데기 실측 (a|b|c 후보 전환)
node scripts/poc-tauri-stores.mjs     # IPC 왕복 + 앱 홈 호환 실측
```

## 2. 구조

```
Cargo.toml            워크스페이스 루트 (members: src-tauri, crates/ccg-store) — target/ 공유
crates/ccg-store/     앱 홈 경로 결정·원자 저장·uiPrefs/profile/chats/window-state
src-tauri/            앱 셸: 창 생성·복원·상태 저장, ipc_call 디스패처 하나, 단일 인스턴스
app/                  이식된 렌더러 (vite 루트) + src/api/shim.ts(window.api) + chrome.ts
```

- `@shared`는 **복제하지 않는다** — `app/vite.config.ts`가 `../src/shared`를 가리킨다.
  `protocol.ts`/`api.ts`가 계약면의 단일 소스라는 규칙이 빌드로 강제된다.
- 렌더러 이식본의 수정은 **HTML 3줄 + import 1줄**이 전부다(`docs/renderer-divergence.md`).
  나머지 60개 .ts/.tsx와 `styles.css`는 무변경. import 1줄은 원본의 상대 경로
  (`../../../shared/protocol`)가 app/에서 레포 밖을 가리켜 `@shared/protocol`로 바꾼 것 —
  타입 전용이라 번들은 통과하고 `npm run typecheck:app`만 잡아낸다.
- `npm run typecheck:app`(app/tsconfig.json)이 심의 `WindowApi` 전 메서드 구현을 타입으로
  강제한다 — vite build는 타입을 보지 않으므로 이게 유일한 그물이다. 현재 통과.
- Rust 커맨드는 `ipc_call` **하나**. 채널 문자열은 protocol.ts의 IPC 상수 그대로,
  `payload`는 **호출 인자 배열**(2.6.2의 `ipcRenderer.invoke(ch, ...args)` 가변 인자 보존).

## 3. 창 껍데기 — 후보 3안 실증과 채택

2.6.2 메인 창 = `frame:false` + `backgroundMaterial:'acrylic'`. 프레임리스인데
네이티브 리사이즈·Aero Snap·최대화가 살아 있고 DWM이 아크릴을 그린다. 이 셋의 동시
성립이 M1 최대 리스크였다. `CCG_CHROME=a|b|c`로 같은 빌드에서 후보를 갈아 끼우며
Win32/DWM 실측(`scripts/poc-tauri-chrome.mjs`).

| 항목 | a) decorations:true | **b) decorations:false + shadow + transparent + Acrylic** | c) b − 아크릴/투명 |
|---|---|---|---|
| WS_THICKFRAME (엣지 리사이즈) | ✔ | **✔** | ✔ |
| WS_MAXIMIZEBOX (스냅·최대화) | ✔ | **✔** | ✔ |
| DWM 백드롭(38) == 3 (`DWMSBT_TRANSIENTWINDOW`) | ✔ | **✔** | ✗ (0) |
| 최대화 클라이언트 rect == 작업 영역 | ✔ | **✔** | ✔ |
| Aero Snap(Win+←) 좌반 | ✔ | **✔** | ✔ |
| 2.6.2 커스텀 타이틀바와 공존 | ✗ **OS 캡션이 위에 하나 더** | **✔** | ✔ |

→ **채택 = (b)**. 근거:

1. tao는 undecorated 창에도 `WS_CAPTION|WS_THICKFRAME|WS_MAXIMIZEBOX|WS_MINIMIZEBOX`를
   남기고 `WM_NCCALCSIZE`로 프레임만 지운다(= Electron frameless와 같은 수법). 그래서
   엣지 리사이즈·스냅·최대화가 OS 것 그대로다.
2. 최대화 시 **클라이언트 rect가 정확히 작업 영역**(0,0,2560,1392)이 된다 — 창 rect는
   프레임 두께만큼 부푼 (-8,-8,2568,1400)이지만 콘텐츠는 작업 표시줄을 덮지 않는다.
   (tao의 NCCALCSIZE가 최대화 시 rcWork로 잡아준다. 창 rect로 판정하면 오진한다.)
3. 아크릴은 `window-vibrancy`가 Win11 22H2+에서 `DwmSetWindowAttribute(38,
   DWMSBT_TRANSIENTWINDOW)`를 쓴다 — **Electron의 `backgroundMaterial:'acrylic'`과 같은
   경로**다. 실측 백드롭 값 3으로 확인. (c)와 비교하면 재질이 스냅/리사이즈에 아무
   영향이 없다는 것도 확인됐다.
4. (a)는 OS 캡션이 앱의 커스텀 타이틀바 위에 하나 더 뜬다(스크린샷으로 확인) — 파리티 불가.

드래그(=창 이동)는 `-webkit-app-region` 재현으로 해결했다. **WebView2가 이 CSS 속성을
계산값으로 노출한다**는 실측(`.sb-top`='drag', `.win-ctl button`='no-drag') 덕분에 CSS
사본 없이 `getComputedStyle`만으로 판정한다 → `startDragging()`. 실마우스(SendInput
절대좌표) 드래그로 창이 실제로 따라오는 것까지 확인(요청 Δ(160,90) → 이동 (80,90);
X가 작은 것은 직전 최대화 복원 상태에서 Windows가 커서 기준으로 재배치하기 때문).

> 실측 함정 2개(재현할 사람을 위해): ① `SetCursorPos`+`mouse_event(MOVE,0,0)`로는 창
> 이동 모달 루프가 따라오지 않는다 — `SendInput` 절대좌표여야 한다. ② 패치노트 카드가
> 전면 오버레이로 떠 있으면 드래그 클릭이 카드로 간다(2.6.2 때도 같은 함정).

## 4. 구현한 채널 (나머지는 전부 `__unimplemented` + 심의 안전값)

| 채널 | 동작 |
|---|---|
| `app:get-version` | `3.0.0-beta.1` |
| `app:get-initial-dir` | `null` (컨텍스트 메뉴 "…로 열기"는 M12 설치기와 함께) |
| `app:update-status` | `phase:'idle'` 스텁 — 앱 자동 업데이트 없음. AppUpdateGate는 뜨지 않는다 |
| `engine:update-status` | `active:false` 스텁 — 부팅 엔진 업데이트 흐름은 M3 |
| `engine:auto-update` | **실구현**: `engine-auto-update.json` 읽기/쓰기(기본 켬) |
| `engine:state` / `codex-engine:state` | **실구현**: `engines/`·`codex-engines/`의 실제 설치본 + `config.json`의 activeVersion. `bundled`는 `"unknown"`(3.0엔 번들 SDK가 없다 — Rust가 CLI를 직접 몬다) |
| `profile:get` / `profile:save` | **실구현** (2칸 들여쓰기·같은 파일) |
| `ui-prefs:get` / `ui-prefs:save` | **실구현** + 저장 시 `ui-glass:changed`/`ui-lang:changed` 브로드캐스트(2.6.2와 같은 "바뀐 저장에만" 조건) |
| `chats:get` / `chats:save` / `chats:load` | **실구현**: index.json+chats/&lt;id&gt;.json, 부팅 경량(light) 조회, unloaded 마커의 스냅샷 되끼움, 내용 같으면 저장 스킵, 사라진 채팅 파일 prune, 옛 단일 chats.json 이관 |
| `win:minimize` / `win:maximize-toggle` / `win:close` / `win:is-maximized` | **실구현** + 최대화 전이마다 `win:state` emit |
| `fs:dir-exists` | **실구현** |
| `dialog:pick-directory` | **실구현** (tauri dialog 플러그인) |
| `auth:list-accounts` / `codex-auth:list-accounts` | **실구현(읽기 전용)**: accounts.json(v3/v2)·codex-accounts.json(v1) 파싱 — 이메일·구독/플랜·기본 계정만. 토큰은 손대지 않는다 |

엔진 게이트를 "거짓 데이터로 뚫지" 않았다:

- `EngineGate`는 `engineAutoUpdate()`가 켬이면 그대로 숨는다. 벤치 홈은 꺼짐이라
  `engine.listAvailable()`까지 가는데, 이건 **미구현**이라 심이 `{latest:null}`을
  돌려주고 게이트는 "최신 버전을 알 수 없음 → 숨김" 경로로 조용히 닫힌다.
  (레지스트리 조회는 M3의 몫. 지금 가짜 버전을 만들어 넣지 않았다.)
- `EngineUpdateGate`는 `active:false`라 안 뜨고, `AppUpdateGate`는 `phase:'idle'`이라 안 뜬다.

## 5. 앱 홈 호환 실측 (`scripts/poc-tauri-stores.mjs`, 홈 = `.bench-home-tauri`)

2.6.2가 저장해 둔 홈을 **그대로** 읽는다:

- `profile` = `{nickname:"Bench", color:"#0EA5E9"}`
- `ui-prefs` = 6키 그대로(`ui.lang:"ko"` 등)
- `chats` = `activeChatId:"fix-long-thread"`, 메시지 474개 로드, `loadChat`도 474개
- `auth.listAccounts` = 6계정(구독 max), 기본 계정 1개 정확히 표시
- `engine.state` = `active:"0.3.239"`, `installed:["0.3.239","0.3.238"]`
  (`0.3.228`은 package.json이 없어 2.6.2와 같은 규칙으로 걸러짐)
- `engineAutoUpdate` = `false` (저장값)
- 미구현 채널 안전값: `getUsage`→네 필드 null, `sessionWindows.list`→[], `git.status`→repo:false,
  `talk.getState`→null, `lsp.status`→'unsupported' — 크래시 없음, 경고는 채널당 1회
- 화면: `#root` 마운트, `.win` 존재, 사이드바에 그 채팅 1개

**채팅 병합 의미론**(`scripts/poc-tauri-chats.mjs` — 여기가 깨지면 대화가 증발한다.
2.6.2의 `poc-chats-merge.mjs`에 대응하는 Rust판, 던지는 홈 `.poc-home-chats`에서):

| 검사 | 결과 |
|---|---|
| 조회한 블롭을 그대로 저장 → 파일 무변경(내용 같으면 저장 스킵) | ✔ |
| `unloaded` 마커(스냅샷 null) 저장 → 디스크 스냅샷 474개 보존 | ✔ |
| 저장된 파일에 `unloaded` 키가 남지 않음 | ✔ |
| 새 채팅 추가 → 파일 생성 + `index.order` 반영, 기존 채팅 무사 | ✔ |
| 목록에서 뺀 채팅 → 파일 prune, 남은 채팅 무사 | ✔ |

## 6. 측정치 (참고 기록 — 판정은 크리틱)

| | 2.6.2 (Electron) | 3.0 M1 (Tauri) |
|---|---|---|
| 콜드 스타트 첫 가시 창 (웜 중앙값) | 336ms | **239ms** |
| 콜드 스타트 #root 마운트 | 422ms | **336ms** |
| 유휴 WS (60s settle) | 428.1MB / 5프로세스 | **415.6MB / 7프로세스** |
| 유휴 Private | 341.4MB | **351.4MB** |

- 목표(절반 이하)에는 **한참 못 미친다.** 앱 프로세스 자체는 29MB WS/10.7MB priv로
  Electron 메인(113MB/81MB)보다 훨씬 작지만, WebView2가 6프로세스를 띄워 그 이득을
  전부 먹는다. 이게 지금 가장 큰 격차다(§7).
- CDP(`--remote-debugging-port`)는 두 앱 모두에 켜서 대칭이지만, WebView2 쪽에서 Private
  +57MB쯤을 더 쓴다(포트 없이 재보면 priv 322MB). 하네스 규약을 바꾸는 건 크리틱 몫이라
  그대로 뒀다.
- `bench/results/idlemem-tauri-3.0.0-settle30.json`은 30초 정착 값(417.4/345.2). 기준값이
  60초라 대표값은 60초 쪽을 남겼다.

**하네스 수정 2건**(bench/lib.mjs):

1. `tauriProfile`의 exe 경로 → `target/release/agentcodegui.exe`(워크스페이스 루트 공유 target).
2. 첫 가시 창 감시자에 **200×200 최소 크기** 조건 추가. tao는 프로세스 시작과 함께
   16×16짜리 `Tao Thread Event Target` 창을 **가시 상태로** 만든다 — 조건이 없으면
   Tauri의 '첫 가시 창'이 **5ms**로 찍힌다(실측). Electron의 첫 창은 1320×880이라
   영향받지 않고, 기존 기준값 336ms도 rootMs(422ms)보다 앞선 진짜 창이라 유효하다.
   (그래도 기준값 재측정 여부는 크리틱 판단 — Electron 결과 파일은 건드리지 않았다.)

창을 보여주는 시점은 `PageLoadEvent::Finished`로 잡았다. `Started`에서 보여주면 창이
~100ms 먼저 뜨지만 빈 유리창이 번쩍이고, Electron의 `ready-to-show`("그릴 준비 완료")와
다른 잣대가 된다.

## 7. 알려진 갭 (다음 라운드/조각의 재료)

1. **유휴 메모리가 아직 2.6.2와 비슷하다.** WebView2 6프로세스가 전부다. 후보 레버:
   창을 여러 개 띄울 때 WebView2 브라우저 프로세스를 공유하는 이점(2.6.2는 창마다
   렌더러가 는다), `additional_browser_args`로 불필요 기능 차단, GPU/유틸 프로세스 축소,
   번들 1MB JS의 코드 스플리팅. **M1은 뼈대라 여기서 이기지 못한다** — 인정하고 넘긴다.
2. **창은 메인 하나뿐.** `openSessionWindow`·`btwOpen`·`multi.openPanelWindow`·토스트·
   트레이 메뉴는 안전 no-op(미구현). 창 레지스트리(label→kind)와 이벤트 라우팅은 M2.
3. **단일 인스턴스는 "조용히 물러남"까지만.** 앱 홈의 `.instance-lock`을 공유 금지로 잡아
   같은 홈의 두 번째 인스턴스는 즉시 종료된다. 2.6.2처럼 기존 창을 앞으로 가져오는 건
   창 라우팅(M2)과 함께.
4. **X = 진짜 닫기.** 2.6.2는 트레이로 숨긴다. 트레이가 없는 M1에서 숨기면 되찾을 길이
   없어 닫기로 뒀다. 트레이 조각에서 원복.
5. **`pathForFile`은 스텁**(`''`). `saveAttachmentData`(바이트→임시 파일)가 구현되면
   드래그·붙여넣기가 한 경로로 모인다 — `docs/renderer-divergence.md` §3.2.
6. **`CCG_HOME`을 릴리즈에서도 존중한다**(2.6.2는 dev 한정). ARCHITECTURE-3.0의
   "dev/release 불문 격리" 결정을 따른 의도적 차이다.
7. **codex 계정 스토어 경로**: 2.6.2 `codex/auth.ts`는 `os.homedir()/.agentcodegui`를
   하드코딩해 `CCG_HOME`을 무시한다(격리 홈에서도 실계정 파일을 본다). 3.0은 전부
   `app_home()`을 쓴다 — 의도적 수정.
8. **`engine.state().bundled`는 `"unknown"`**. 2.6.2는 앱 package.json의 SDK 의존성
   버전을 폴백으로 표시했는데, 3.0엔 번들 SDK가 없다(M3에서 이 필드의 의미를 재정의).
9. **`tauri build`는 번들러 끔**(`bundle.active:false`) — 지금은 exe만 만든다. 설치기·
   아이콘·서명은 M12.
10. 드래그 영역이 이벤트를 삼키지 않는 미세 차이(§3.1 장부).

## 8. 이번 라운드에 남긴 실측 스크립트

- `scripts/poc-tauri-chrome.mjs [a|b|c]` — 창 스타일 비트·DWM 백드롭·최대화 클라이언트
  rect·Aero Snap·실마우스 드래그·창 영역 스크린샷. 앱 홈은 `.poc-home-tauri`로 격리
  (창을 움직이므로 벤치 홈을 오염시키지 않는다).
- `scripts/poc-tauri-stores.mjs [home]` — 릴리즈 exe를 격리 홈으로 띄워 계약면 채널을
  실제로 호출하고, 2.6.2 저장본이 그대로 읽히는지·미구현 안전값·화면 마운트를 확인.
  `location.href`가 `tauri.localhost`가 아니면 dev 빌드라고 경고한다.
- `scripts/poc-tauri-chats.mjs` — 채팅 저장 왕복(스킵·unloaded 병합·추가·prune). 픽스처를
  `.poc-home-chats`로 복사해 돌리므로 벤치 홈을 건드리지 않는다.
