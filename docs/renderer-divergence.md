# 렌더러 이식 장부 (app/ ↔ src/renderer)

3.0의 프론트엔드 `app/`은 2.6.2 렌더러(`src/renderer`)의 **이식본**이다. UI 파리티는
"같은 코드·같은 CSS"라는 구조로 담보하므로, 이식본에 손을 댄 자리는 **전부 여기에**
사유와 함께 남긴다. 이 파일이 파리티 감사의 대상이다 — 목록에 없는 차이가 발견되면
그건 회귀다.

검증 방법(누구나 재현 가능):

```
diff -rq src/renderer app --exclude=dist
```

2026-08-23 기준 출력은 아래 **4(수정) + 5(신규)** 가 전부다(`app/dist`·`app/tsconfig.json` 제외).
`src/renderer/src/**`의 .ts/.tsx 60개와 `styles.css`는 여전히 **한 글자도 안 바뀌었다** —
유리 폴백조차 CSS를 고치지 않고 클래스 주입으로 넣었다(§3.6).

---

## 1. 수정한 파일 (4개)

| 파일 | 변경 | 사유 |
|---|---|---|
| `app/index.html` | `<script type="module" src="/src/api/shim.ts">`를 `main.tsx` **앞에** 추가 | Electron의 preload가 하던 `window.api` 설치를 심이 대신한다. 모듈 스크립트는 문서 순서대로 실행되므로, 렌더러 진입점보다 앞에 두면 첫 렌더 코드가 돌기 전에 `window.api`가 선다. (빌드 후에도 순서 보존 확인: 번들 진입 청크 첫 줄이 `import"./shim-*.js"`) |
| `app/toast.html` | 같음 (`toast.ts` 앞) | 토스트 창도 `window.api.notify.*`를 쓴다 |
| `app/tray.html` | 같음 (`tray.ts` 앞) | 트레이 메뉴 창도 `window.api.trayMenu.*`를 쓴다 |
| `app/src/lib/limitResume.ts` | `import type … from '../../../shared/protocol'` → `'@shared/protocol'` | 원본의 **상대 경로**가 `app/`으로 옮기면 레포 밖(`C:/Code/shared/protocol`)을 가리킨다. 타입 전용 import라 번들은 통과하지만 타입 검사가 깨진다(`npm run typecheck:app`가 잡았다). 앱의 다른 30개 파일이 쓰는 별칭으로 통일 — 2.6.2 쪽 원본은 그대로 둔다 |

`src/renderer/src/**`의 나머지 60개 .ts/.tsx와 `styles.css`는 **한 글자도 바뀌지 않았다.**

## 2. 새로 추가한 파일 (5개 — 원본에 대응물이 없다)

| 파일 | 역할 |
|---|---|
| `app/vite.config.ts` | vite 루트(app/), `base:'./'`, 멀티 페이지 입력 3개(index/toast/tray), `@shared → ../src/shared`(복제 금지·단일 소스), minify 명시. **빌드 시각 HTML 변환 2개**(아래 §4) |
| `app/tsconfig.json` | `npm run typecheck:app` — 심이 `WindowApi`를 **전부·타입대로** 구현하는지 검사하는 유일한 자리(vite build는 타입을 안 본다) |
| `app/src/api/shim.ts` | `WindowApi` 전 메서드 구현. 호출은 `invoke('ipc_call', { channel, payload })` 하나, 이벤트는 Tauri `listen`(같은 채널명·preload의 허브 팬아웃 문법 그대로) |
| `app/src/api/chrome.ts` | 렌더러 CSS의 `-webkit-app-region`(드래그 영역)을 WebView2에서 재현 |
| `app/src/api/glassFallback.ts` | **유리 폴백 수신** — OS가 아크릴을 못 그릴 때 `<html>`에 클래스를 걸어 불투명 배경으로 갈아탄다 (아래 §3.6) |

`shim.ts`에 붙은 줄은 **두 줄뿐**이다: `import { initGlassFallback } from './glassFallback'` 와
파일 끝의 `initGlassFallback()` (기존 `initWindowChrome()` 바로 아래).

---

## 3. 심이 흡수한 런타임 차이 (렌더러 코드를 안 고치기 위해 심이 떠안은 것)

### 3.1 `-webkit-app-region` → 네이티브 드래그

`-webkit-app-region:drag|no-drag`은 **호스트(Electron)** 가 해석하는 문법이라 Tauri/WebView2
에서는 아무도 보지 않는다. styles.css를 고치지 않기 위해 `chrome.ts`가 같은 의미를 JS로
재현한다: 캡처 단계 `mousedown` → 대상(또는 조상)이 drag면 `startDragging()`
(= `ReleaseCapture` + `WM_NCLBUTTONDOWN/HTCAPTION`), 더블클릭이면 `toggleMaximize()`.

- 판정 1순위: `getComputedStyle(el)['-webkit-app-region']`. **WebView2가 이 속성을 계산값으로
  그대로 노출한다**(실측: `.sb-top`='drag', `.win-ctl button`='no-drag'). 즉 CSS 사본을
  만들 필요가 없다.
- 판정 2순위(폴백): 그 런타임이 속성을 버리면 문서의 스타일시트 텍스트를 훑어 drag/no-drag
  셀렉터 목록을 만들고 `closest()`로 판정한다. 역시 같은 CSS가 원본이다.
- 진단: `window.__ccgChrome` = `{ mode, dragSel, noDragSel, seen, drags }`.

**행동 차이(알려진 것)**: Electron의 drag 영역은 그 영역의 마우스 이벤트를 통째로 삼키지만,
심은 이벤트를 삼키지 않는다(`preventDefault`/`stopPropagation` 없음). 드래그가 시작되면
웹뷰가 캡처를 잃어 클릭이 뒤따르지 않는 게 보통이라 실사용 차이는 확인되지 않았다 —
드래그 영역 위에 클릭 핸들러가 있는 화면이 생기면 여기 다시 적는다.

### 3.2 `pathForFile` (드래그된 파일의 OS 경로)

Electron은 `webUtils.getPathForFile(file)`로 File→절대경로를 **동기** 해석했다. Tauri에는
대응물이 없고, 네이티브 drag-drop 이벤트(경로 동봉)를 켜면 **HTML5 drop이 웹뷰에 아예
오지 않아** 렌더러의 드롭 처리 전부가 죽는다. 그래서 창을 `disable_drag_drop_handler()`로
만들어 HTML5 경로를 살리고, `pathForFile`은 `''`을 돌려준다(채널당 1회 경고).

호출부(`lib/images.ts`)는 경로가 없으면 **바이트를 메인에 넘겨 임시 파일로 만드는 폴백**이
이미 있다 — `saveAttachmentData`가 구현되는 순간 OS 드래그·브라우저 드래그·붙여넣기가
한 길로 모인다(그게 오히려 정합적이다). M1에선 둘 다 미구현이라 첨부는 조용히 건너뛴다.

### 3.3 이벤트 구독의 등록 시점

preload는 `ipcRenderer.on`(동기)이었고 심은 `listen()`(비동기 등록)이다. 구독 직후 아주
짧은 공백이 있다. 계약면이 "마운트 때 스냅샷 조회로 따라잡는다"(engineUpdate.status,
app.getUpdateStatus, sessionWindows.list …)를 규약으로 갖고 있어 실사용 의미는 같지만,
새 채널을 만들 때 이 규약을 어기면 M1에서만 나타나는 유령 버그가 된다.

### 3.4 부팅 페이로드 선주입 (`window.__CCG_BOOT`) — R3 추가

렌더러 진입점(`app/src/main.tsx`)은 **`loadPrefs()`가 resolve된 뒤에야** `createRoot`를
부른다(저장된 줌·유리·언어가 첫 페인트부터 맞아야 하므로 2.6.2부터의 규약). 즉
`ui-prefs:get` IPC 왕복 하나가 `#root` 마운트의 임계 경로에 통째로 들어가 있었다.

셸(`src-tauri/src/win.rs::boot_payload_script`)이 창을 만들 때 이미 디스크에서 읽는 값이라,
문서 생성 시점에 `initialization_script`로 넣어 준다:

```js
window.__CCG_BOOT = { "ui-prefs:get": {...}, "profile:get": {...}, "app:get-version": "…" }
```

심의 `call()`이 **인자 없는 호출에 한해, 채널당 정확히 한 번** 이 값을 먹고 키를 지운다
(`takeBoot`). 두 번째 조회부터는 보통의 IPC로 간다 — 저장 후 재조회가 낡은 값을 보는
사고를 원천 차단한다. `null`도 정당한 값이라(`profile:get`) 박스(`{v}`)로 감싸 구분한다.

- **동작 불변인 이유**: 값이 창 생성 시점의 디스크 내용이고, 그 시점 이전에는 렌더러
  코드가 한 줄도 돌지 않는다(= 첫 조회 결과와 정의상 같다). 반환도 여전히 Promise라
  호출부의 비동기 순서가 그대로다.
- **일부러 안 넣은 것**: `chats:get`·`ma:get`. 큰 블롭을 document-start에 JS 리터럴로
  넣으면 수백 KB를 파싱하느라 첫 페인트가 오히려 늦고, 그 둘은 마운트 **이후** 조회라
  `rootMs`에 애초에 영향이 없다.
- 검증: `bench/boot.mjs`가 재로드 경로에 `__TAURI_INTERNALS__.invoke` 래퍼를 심어
  마운트 전 호출을 채널·시각까지 센다 → `bootIpcCalls: []`(0회, R3 이전 1회).

### 3.5 미구현 채널의 안전값

백엔드가 아직 없는 채널은 Rust가 `{ "__unimplemented": true }`를 돌려주고, 심이 **채널당
1회** `console.warn` 후 시그니처에 맞는 값(빈 배열/null/false/no-op)을 돌려준다. 예외는
`saveAttachmentData` 하나 — "경로 없음"을 뜻하는 안전한 문자열이 없어 reject하고,
유일한 호출부가 try/catch로 감싸 첨부를 건너뛴다(위 3.2).

### 3.5.1 **같은 사실의 두 채널 이름** — 셸이 둘 다 쏜다 (최종 파리티 R1 H5)

3.0 계약면은 이식본이 모르는 채널을 몇 개 새로 세웠다. 그중 **하나가 이식본의 옛 이름을
가려 버렸다**: 닫기 직전 마지막 저장 요청이 3.0에서는 `chat:flush-req`인데
(`protocol.ts:1199`) 이식 렌더러는 `session-wins:flush-request`만 듣는다
(`SessionWindow.tsx:351` → `shim.ts:391` `session.onFlushRequest`).
그 채널의 **방출자가 0**이라 요청이 한 번도 도착한 적이 없었다.

**방향은 「셸이 둘 다 쏜다」로 고른다.** 이식본을 옛 채널에서 떼어내는 쪽이 아니다 —
이 장부의 전제("`src/renderer/src/**`는 무수정")를 지키려면 방출자 쪽이 움직여야 한다.
그리고 이 규약은 새로 만든 게 아니다: `win.rs broadcast_sessions`가 이미 같은 목록을
`session-wins:changed`(2.6.2 이름)와 `chat:windows`(3.0 이름)로 **둘 다** 쏜다.
원천이 하나이므로 두 이름이 어긋날 수 없다.

| 사실 | 2.6.2 이름 | 3.0 이름 | 쏘는 자리 |
|---|---|---|---|
| 추가 채팅 목록 | `session-wins:changed` | `chat:windows` | `win.rs broadcast_sessions` |
| 닫기 전 마지막 저장 | `session-wins:flush-request` | `chat:flush-req` | `ipc/windows.rs flush_req` |

### 3.6 유리 폴백 — `styles.css`를 안 고치고 배경을 갈아 끼우기 (M-UI 추가)

**왜 필요한가.** 사이드바에는 자체 배경이 없다 — `body`의 `--panel`(`rgba(21,21,21,.70)`)
틴트가 DWM 아크릴 위에 얹혀 있을 뿐이다(`styles.css:7-20`). 3.0 창은 거기에
`transparent(true)`까지 걸려 있어서(`win.rs` b안), OS가 아크릴을 못 그리면
**벽지가 블러 없이 그대로 비친다** — 글자 뒤로 사진이 지나가 읽을 수 없다.
실측: 백드롭을 NONE으로 내려도 사이드바 픽셀이 원색 3띠 판을 그대로 따라갔다(스윙 23).
자세한 것은 `docs/design/ui-glass.md`.

**신호.** 셸(`src-tauri/src/glass.rs`)이 백드롭을 재단언해 되살리려 하고, 상태가 바뀌거나
드리프트가 늘거나 **문서가 새로 서면** `ui-glass:state`를 브로드캐스트한다.

- 채널 이름이 비슷한 **기존 `ui-glass:changed`와 다른 것**이다. 저건 설정 › Display의
  '벽지 비침' 슬라이더(0~100, 사용자 취향), 이건 OS 상태(bool)다.
- `ipc.rs`(`dispatch`)에 **등록하지 않는다** — 렌더러가 부르는 채널이 아니라 셸이 쏘는
  단방향 브로드캐스트라 항목이 필요 없다. 풀(pull) 경로가 없는 대신 **부팅 페이로드**
  (`win.rs boot_payload_script`, 위 §3.3)가 같은 채널 키로 스냅샷을 실어 보낸다.
- 셸이 부팅 직후 **250ms · 1s · 3s에 현재 상태를 무조건 한 번씩** 쏜다. Tauri `listen()`은
  비동기 등록이라 구독 직후 공백이 있어서(위 §3.3와 같은 함정), 한 번만 쏘면 첫 화면이
  틀린 채로 남는다. **다만 그건 프로세스당 1회다** — 문서당 보장은 아래 R2 항목이 맡는다.

**적용 방식 — 클래스 주입.** `styles.css`는 한 글자도 고치지 않는다.

1. `<html>`에 `ccg-glass-off` 클래스를 토글하고,
2. 그 클래스에만 걸리는 규칙을 담은 `<style id="ccg-glass-fallback">` 하나를 문서에 넣는다.

폴백이 걷히면 클래스만 떼면 되고 원본 CSS는 그대로 남는다. 덮는 것은 토큰 둘뿐:
`--panel: #1d1d1d` · `--chat-bg: #141414`(사이드바가 본문보다 밝은 **위계를 아크릴 때와 같은
순서로** 유지) + 아크릴의 광량 낙차를 흉내 낸 아주 옅은 좌상단 그라디언트.

**R2에서 바뀐 것 — 판정이 셸의 document-start 스크립트로 옮겨갔다.**

R1 구현은 *꺼짐을 증명해야* 폴백이 켜졌고, 그 결과 **부팅 순간에 존재하던 문서에만** 걸렸다
(`location.reload()` 후 · 나중에 연 추가 채팅 창 · 크래시 복구 재로드 = `__ccgGlass.events === 0`).
R2는 규칙을 뒤집었다 — **살아 있음을 증명해야 투명**.

- `glass::boot_script()`가 만든 스크립트를 `win.rs`가 창마다 `initialization_script`로 심는다.
  이건 **페이지 로드마다 다시 도는** 자리라, 재로드·새 창·크래시 복구가 함께 덮인다.
  하는 일: 무조건 클래스 + `<style>`을 걸고, 부팅 스냅샷이 `ok:true`를 증명하면 **같은 태스크
  안에서** 클래스를 뗀다(정상 경로의 불투명 프레임 0장 — 실측 0.1ms, 첫 rAF는 27ms).
- **폴백 CSS가 두 벌**이 됐다: 셸의 `FALLBACK_CSS`(document-start용)와 이 파일의 `styleText()`.
  시점이 달라서 어쩔 수 없다. 갈라지는 것은 렌더러가 막는다 — `ensureStyle()`이 심어진
  스타일에 `#1d1d1d`/`#141414`가 있는지 검사하고 없으면 자기 값으로 덮는다(drift 가드).
  **둘 중 하나만 고치면 안 된다.**
- `initGlassFallback()`은 구독보다 **먼저** 부팅 스냅샷을 먹는다. 이때 raw `ok`가 아니라
  부트스트랩이 남긴 `resolvedOk`를 본다 — raw를 보면 부트스트랩의 보수적 판정(아래)을
  렌더러가 되돌린다(실측으로 밟았다: 6ms에 폴백으로 섰다가 45ms에 투명으로 돌아갔다).
- `applyGlassFallback()`은 판정을 `sessionStorage['ccg.glass.last']`에 남긴다. 부팅 스냅샷은
  **창을 만든 순간**의 값이라 같은 웹뷰를 다시 세우는 재로드(`crash.rs reload_all` — 크래시
  복구 1순위 경로)에서는 낡아 있다. 부트스트랩이 둘을 **AND** 해서 "증명된 것보다 더
  투명해지지 않는" 방향으로만 간다.

**`!important`가 필요한 이유(함정).** 설정 › Display의 '벽지 비침' 슬라이더
(`app/src/lib/glass.ts`)는 값이 기본(50)이 아닐 때 `--panel`/`--chat-bg`를
**documentElement의 인라인 스타일**로 덮어쓴다. 인라인은 어떤 셀렉터보다 세서,
`!important`가 없으면 폴백이 슬라이더에 진다 — 유리가 죽었는데 사용자가 비침을 100으로
올려 둔 창은 벽지가 **더 크게** 비치는 최악이 된다. 폴백이 켜진 동안에는 슬라이더가 의미를
잃는 게 맞다(비칠 유리가 없다).

**검증.** 전역 투명 효과를 끄는 것은 금지 규약(사용자 데스크톱)이라 셸에 테스트 레버를 뒀다:
`CCG_GLASS_FORCE_OFF=1`(기본값에서는 no-op). 3띠 판 위 실측 — 폴백 전 스윙 21~23 →
폴백 후 **(20,20,20) 세 띠 전부 동일 · 스윙 0**. R2는 여기에 **문서 5개**(부팅 · 재로드 ·
나중에 연 추가 채팅 창 · `reload_all` 복구 후 둘 · `recreate_windows` 복구 후 둘)를 전부
확인하는 회차를 더했다 — `docs/design/ui-glass.md` §3 실측 절.
진단: `window.__ccgGlass`(`__ccgChrome`와 같은 규약) + `window.__ccgGlassBoot`(부트스트랩이
받은 스냅샷과 그 판정 · `tOn`/`tOff`) + 앱 홈 `glass.log`.

---

## 4. 빌드 시각 HTML 변환 (`app/vite.config.ts`) — 원본 HTML은 그대로다

`app/index.html`은 손대지 않는다(그 파일은 디자인 담당 에이전트와 겹친다). 대신 vite
플러그인이 **산출물만** 바꾼다. 원본과 산출물이 다르므로 여기 적는다.

| 플러그인 | 무엇을 | 기본값 | 대조군 |
|---|---|---|---|
| `nonBlockingRemoteFonts` | 원격 웹폰트 `<link rel=stylesheet>` 2개를 `media="print" onload="this.media='all'"`로 → 렌더 차단에서 뺀다 | **켬** | `CCG_BLOCKING_FONTS=1` |
| `paintSplashBeforeApp` | `<script type=module>`을 `modulepreload` + rAF 뒤 동적 import로 → 스플래시가 먼저 한 프레임 그려진다 | **끔** | `CCG_DEFER_APP_SCRIPTS=1`로 켬 |

두 폰트 CSS 모두 `font-display:swap`이라 비차단으로 바꿔도 글자가 사라지는 구간(FOIT)은
없다. 두 번째 플러그인을 기본으로 끈 이유는 실측 교환비 때문이다(`docs/m1-report-r3.md` §4.3):
켜면 스플래시 픽셀이 100ms 빨라지는 대신 `#root` 마운트가 43ms 늦는다.

## 5. 셸이 주입하는 스크립트 (렌더러 번들 밖)

| 스크립트 | 언제 | 무엇 |
|---|---|---|
| `boot_payload_script()` (win.rs) | document-start | `window.__CCG_BOOT` (§3.4) |
| `splash.js` (win.rs → include_str!) | document-start | 부팅 스플래시 오버레이 + **창 표시 신호** + **마운트 하트비트**. 2.6.2는 별도 300x240 BrowserWindow였다 — 3.0에서 같은 짓을 하면 웹뷰가 하나 더 생긴다(렌더러 프로세스 +1) |
| `CLOSE_SHORTCUT_JS` (`ipc/parity/misc.rs`) | document-start (메인 + 추가 채팅 창) | **Ctrl+W 포획기** (§5.2) |

### 5.2 Ctrl+W 포획기 `CLOSE_SHORTCUT_JS` (최종 파리티 R1 M1)

2.6.2는 메인 프로세스의 `before-input-event`로 Ctrl/⌘+W를 **삼키고**(Electron 기본 메뉴의
'창 닫기' 가속기라 그냥 두면 창이 닫힌다) 렌더러엔 `shortcut:close`로 알려 열린 코드
뷰어만 닫게 했다(`src/main/index.ts:987`).

Tauri에는 그 자리가 **없다** — 웹뷰 문서 안의 키 입력은 셸(tao의 `WindowEvent`)에 오지
않는다. 그래서 같은 일을 문서 쪽에서 한다. 규약 넷:

- **렌더러 번들이 아니다.** `splash.js`와 같은 지위의 셸 소유 주입 스크립트다.
  이식본은 지금도 `onCloseShortcut`을 **구독만** 하고(`Chat.tsx:419`·`FileModal.tsx:2998`),
  R1까지는 그 채널의 **방출자가 없었을 뿐**이다 — 이식본은 한 글자도 안 고쳤다.
- 채널 이름이 **양방향으로 하나**다: 스크립트가 `ipc_call('shortcut:close')`로 올리고,
  셸이 같은 이름의 이벤트로 되쏜다. 2.6.2도 이름이 하나다.
- 되쏘는 대상은 **누른 창 하나**다. 브로드캐스트하면 다른 창에 열려 있던 뷰어가 남의 키
  입력으로 닫힌다(2.6.2도 누른 창=메인에만 보냈다).
- `capture:true` + `preventDefault()`. 캡처 단계인 이유는 렌더러의 다른 키 핸들러가 먼저
  먹고 `stopPropagation` 하는 경우에도 봐야 하기 때문이고, `preventDefault`는 WebView2가
  이 조합을 자체 처리하는 판에서의 보험이다. `Alt`가 눌린 조합은 제외한다(2.6.2 `!input.alt`).

팝아웃 창에는 주입하지 않는다 — 2.6.2도 팝아웃에는 이 처리가 없었다.

`splash.js`의 표시 신호 규약(R3에서 고침): 오버레이를 DOM에 넣고 **렌더 차단 스타일시트가
전부 도착한 순간** 셸에 `win:first-paint`를 보낸다. R2는 rAF 두 번을 기다렸는데,
**창이 숨겨진 동안 WebView2는 프레임을 만들지 않아 rAF가 영영 오지 않는다**(닭-달걀) —
그래서 창은 늘 안전망(`PageLoadEvent::Finished` = `load`)으로 떴고, `load`는 원격 폰트
CDN 왕복을 기다렸다. 자세한 실측은 `docs/m1-report-r3.md` §4.2.

### 5.1 마운트 하트비트 `win:mounted` (R5 추가)

같은 스크립트가 스플래시를 걷는 순간(`#root`에 자식이 생김 = React 마운트) 셸 내부 채널
`win:mounted`를 한 번 보낸다. **크래시 복구가 실제로 붙었는지 판정하는 유일한 신호다** —
셸은 `reload()`를 걸어 놓고 그게 먹혔는지 알 방법이 없었고, 실패하면 로그 한 줄만 남긴 채
영구 유령 창이 됐다(R4 크리틱 §1.3-(3)). 규약 세 가지:

- **렌더러 번들의 계약면(protocol.ts)이 아니다.** 셸 내부 채널이라 번들이 몰라도 된다.
- initialization_script라 **재로드마다 다시 온다** — 복구 후에도 반드시 온다.
- 안 오면 셸이 `VERIFY_MS`(3s) 뒤 **창 재생성으로 승격**한다(`crash.rs`). 그래서 이 신호를
  없애거나 늦추면 정상 복구가 매번 재생성으로 격상된다. 지연에 민감한 자리다.

추가 채팅 창에는 `splash.js`를 주입하지 않으므로(오버레이가 필요 없다) 이 신호는 **메인
창에서만** 온다. 추가 채팅 창은 셸 쪽 신호(`on_page_load(Finished)` → `page-load`)로만
관측된다 — `--process-per-site`로 렌더러를 공유하므로 메인이 섰으면 같은 렌더러다.

---

## 6. 의도적 분기 (설계에 따라 일부러 갈라진 것)

여기까지의 장부는 "2.6.2와 같아야 하는데 어쩔 수 없이 다른 것"이었다. 아래부터는
성격이 다르다 — **설계 문서에 따라 일부러 갈라진 것**이고, 파리티 감사는 이 목록을
회귀가 아니라 의도된 변경으로 취급해야 한다. 공통 규약 하나: **변경 화면의 A/B 기준은
2.6.2가 아니라 목업**이다. 그 밖의 화면은 여전히 **픽셀 불변**이 계약이다.

### 6.1 M-UX 1단계 — `app/src`의 첫 의도적 분기 (커밋 d62ce52)

상세와 되집는 자리는 `docs/m-ux-report-r1.md` §3.

- 수정 5파일: 다이얼 1~6(하한 1·`visibleSlots = order.slice(0,count)`)·사이드바
  「채팅」+「배치」 2섹션·`setVisible()` 관문+`reconcileChatRefs()`·n1=IDE 크롬·
  busy 중 채팅 전환 허용(+`chat:event` 꼬리 수집기)
- 신설 1파일: `app/src/api/unified.ts` — `chats:set-active` 등 통합 스토어 채널의
  렌더러 쪽 어댑터(계약면 `src/shared`는 무수정)
- 변경 화면의 A/B 기준은 2.6.2가 아니라 **목업**(docs/design/mockups/chat-unify-*)이다.

### 6.2 M-UI — 스레드 알림 7종을 한 문법으로 (`docs/design/ui-notify.md`)

기준은 목업 `docs/design/mockups/ui-notify-*.html`의 **B안**이다(크리틱 블라인드
8승 0패). 상세·실측·되집는 자리는 `docs/m-ui-report-r1.md`.

**변경 화면 (기준 = 목업, 2.6.2와 다른 게 정상):**

| 종 | 2.6.2 | 3.0 | 형태·색조 |
|---|---|---|---|
| 모델 자동 전환 | `.notice-row` **재사용** | `kind:'fallback'` 전용 항목 + `[되돌리기]` | `band · notice · revert` |
| 안내 | `.notice-row` (무조건 노랑) | `kind:'notice'` + `tone`/`action` | `band · notice\|neutral` |
| 오류 | `.error-row` (제목 줄 '오류') | 제목 줄 제거 + **모노 원문 면** + `[복사]` | `band · danger` |
| 중단 | `.stopline` | + 지속시간·도구 수·시각(높이 불변) | `rule` 종결형 · `danger` |
| 압축 경계 | `.cmd-card`(auto) 93.8px | `kind:'boundary'` 15px | `rule` 경계형 · `neutral` |
| 명령 | `.cmd-card` | 치수 통일 + 수치를 부제 줄로 합침 | `card · face=on` |
| 문답 | `.qa` | 왼쪽 15px 마커 칸 + 시각 + 답 15.5→14.5px | `card · face=off` |

**수정 파일 6 (전부 `app/src/`):**

- `styles.css` — `--ntf-*` 토큰 + `.ntf-rule`/`.ntf-band`/`.ntf-card` × `.ntf-t-*` 4색조.
  `.notice-row`·`.error-row`·`.stopline`·`.cmd-card*`·`.qa*` 블록은 **대체**(삭제 후 신설).
- `store/session.ts` — `ThreadItem`에 `fallback`·`boundary` 신설, `notice.tone/action`,
  `interrupted.ms/tools/time`, `qa.time`. `state.turnAt`(중단선 지속시간 근거, 영속 안 함).
- `components/Chat.tsx` — `MessageView` 7분기 + `FallbackBand`·`ErrorBand` 신설,
  `CmdResultCard`·`IdentityBand`를 새 문법으로.
- `App.tsx`·`components/MultiAgent.tsx`·`components/SessionWindow.tsx` — `onNotify` 배선.

**충돌 규약 (목업 → 실앱 이름 매핑):** 목업의 짧은 클래스(`.band .tx`, `.card .ti`,
`.act`, `.num`, `.spin`, `.qa`…)는 `styles.css`에 **이미 같은 이름이 있다**(실측:
`.act` 2 · `.num` 1 · `.tx` 4 · `.ti` 3 · `.spin` 6 · `.qa` 6). 그대로 심으면 무관한
화면이 물든다 → **전부 `ntf-` 접두로 개명**해 심었다(픽셀은 같고 이름만 다르다).
색조 변수도 `--ntf-fg/key/face/edge`다(색조 클래스가 자손에 값을 흘리므로).
목업 로컬 `--shadow-sm`(0 2px 8px -2px)·`--font-mono`(Consolas)는 **채택하지 않았다** —
실앱 값이 2.6.2 원본이고 `.cmd-card`가 이미 그 값이었다.

**훅 클래스 2개는 남긴다:** `.cmd-card`·`.cmd-card-title`은 **스타일 없이** 이름만
유지한다. 파리티 저울(`bench/screens.mjs:959·963`)이 두 앱을 **같은 셀렉터**로 밟기
때문이다 — 한쪽만 이름을 갈면 그 화면은 3.0에서 캡처 자체가 안 된다.

**경계 밖으로 새지 않은 것:** `src/shared/protocol.ts`는 무수정이다. 셸이 이미 싣고 있는
`model-fallback.via`·`.revertTo`(`src-tauri/src/engine/hub.rs:885`)는 계약면 타입에
없어서 리듀서에서 **좁은 캐스트로 읽기만** 한다(없으면 문장만 쓰고 버튼을 뺀다).

**게이트 계약 변경 2건** (R1이 1건만 적었다 — 크리틱 F10):

1. `scripts/poc-live-chat.mjs`의 `E9-error`는 오류 표면을 낱말 '오류'의 개수로 셌다.
   M-UI가 그 제목 줄을 없앴으므로(§5-3 — 색조가 이미 말한다) 그대로 두면 문법이 바뀌었다는
   이유만으로 게이트가 빨개진다. 판정을 `max(낱말 수, danger band 수)`로 바꿔 **두 렌더러
   모두에서** "없다/두 번 말한다"를 똑같이 잡게 했다(약하게 만든 게 아니라 렌더러 중립).
2. `scripts/poc-auto-compact.mjs`의 리듀서 검사(5·8·9). R1은 단정만 3.0 문법
   (`boundary`)으로 갈고 **번들 진입점은 `src/renderer`(2.6.2) 그대로**여서 커밋 직후
   `5 FAILED`가 됐다(값은 옳고 대상이 틀렸다 — 크리틱 F1). **R2에서 하네스를 두 렌더러
   양쪽으로 돌린다**: `app/src`는 `boundary`+`label`/`num`, `src/renderer`는 예전 그대로
   `cmdresult`+`title`/`stats`. 이 장부가 "`src/renderer`는 무수정"이라고 적은 이상
   2.6.2 쪽 기대값도 초록이어야 하고, 지금 22검사 `all ok`다.

### 6.2.1 M-UI R2 — 같은 문법을 **좁은 컨테이너**에서도 (커밋 이 라운드)

R1은 1440px 본채팅(판 883px)에서 7종 전부 이겼지만 420px 멀티 패널 폭(판 364px)에서
오류 +57.3px · 전환 +18.8 · 문답 +13으로 3패였고, 압축 경계 선은 컨테이너를 61px 뚫었다
(크리틱 `docs/critic/mui-apply-r1.md` §2.3 · F2). R2는 **정보를 지우지 않고 배치만** 바꾼다.

- `styles.css` — `.ntf-band`·`.ntf-card`에 `container-type:inline-size`, 그리고
  `@container (max-width:520px)`(band 계열) · `(max-width:430px)`(문답)의 압축 변형.
  **폭을 재는 자는 창이 아니라 판 자신이다** — 같은 창 안에서 본채팅은 883, 패널은 364라
  미디어 쿼리로는 못 가른다. 경계값은 컨테이너의 **내용 상자** 폭이다(판 폭 −30).
- `styles.css` — 스레드 band의 트레이는 flex 칸이 아니라 **문장 블록 안의 오른쪽 띄움**
  (`.ntf-tx > .ntf-tray{float:right}` · `.ntf-bd{display:flow-root}`로 담는다).
  넓은 폭 좌표·높이는 그대로고(실측 47.0 동일), 좁아지면 둘째 줄부터 전폭을 쓴다.
- `styles.css` — `.ntf-rule .ntf-num`이 `flex:0 1 auto; min-width:0`으로 **줄어들 수 있다**
  (R1은 셋 다 `0 0 auto`라 선이 61px 넘쳤다). 말줄임은 쓰지 않는다 — 접힐 뿐이다.
- `styles.css` — `.ntf-act.ghost`(=`[복사]`·`[전체 보기]`) 색 `text-3`→`text-2`(AA · F6).
- `components/Chat.tsx` — 안내·전환·오류 band의 트레이를 `.ntf-tx` **안**(문장 앞)으로
  옮겼다(위 띄움의 전제). `FallbackBand`의 문장을 `isEn()`으로 갈라 영어 어순을 바로잡고
  (F5 — `model_delta`는 영어가 정반대를 말했다), 모르는 `cause`에 "정책상 거부"를 단정하던
  가지를 잘랐다(F4).
- **컴포저 위 `IdentityBand`는 안 건드렸다** — 트레이가 band 직계라 예전 flex 칸 그대로다
  (띄움 규칙은 `.ntf-tx > .ntf-tray`로 좁혀 두었다).
