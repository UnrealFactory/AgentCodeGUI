# 렌더러 이식 장부 (app/ ↔ src/renderer)

3.0의 프론트엔드 `app/`은 2.6.2 렌더러(`src/renderer`)의 **이식본**이다. UI 파리티는
"같은 코드·같은 CSS"라는 구조로 담보하므로, 이식본에 손을 댄 자리는 **전부 여기에**
사유와 함께 남긴다. 이 파일이 파리티 감사의 대상이다 — 목록에 없는 차이가 발견되면
그건 회귀다.

검증 방법(누구나 재현 가능):

```
diff -rq src/renderer app --exclude=dist
```

2026-08-22 (M1 R1) 기준 출력은 아래 4+4가 전부다(`app/dist`·`app/tsconfig.json` 제외).

---

## 1. 수정한 파일 (4개)

| 파일 | 변경 | 사유 |
|---|---|---|
| `app/index.html` | `<script type="module" src="/src/api/shim.ts">`를 `main.tsx` **앞에** 추가 | Electron의 preload가 하던 `window.api` 설치를 심이 대신한다. 모듈 스크립트는 문서 순서대로 실행되므로, 렌더러 진입점보다 앞에 두면 첫 렌더 코드가 돌기 전에 `window.api`가 선다. (빌드 후에도 순서 보존 확인: 번들 진입 청크 첫 줄이 `import"./shim-*.js"`) |
| `app/toast.html` | 같음 (`toast.ts` 앞) | 토스트 창도 `window.api.notify.*`를 쓴다 |
| `app/tray.html` | 같음 (`tray.ts` 앞) | 트레이 메뉴 창도 `window.api.trayMenu.*`를 쓴다 |
| `app/src/lib/limitResume.ts` | `import type … from '../../../shared/protocol'` → `'@shared/protocol'` | 원본의 **상대 경로**가 `app/`으로 옮기면 레포 밖(`C:/Code/shared/protocol`)을 가리킨다. 타입 전용 import라 번들은 통과하지만 타입 검사가 깨진다(`npm run typecheck:app`가 잡았다). 앱의 다른 30개 파일이 쓰는 별칭으로 통일 — 2.6.2 쪽 원본은 그대로 둔다 |

`src/renderer/src/**`의 나머지 60개 .ts/.tsx와 `styles.css`는 **한 글자도 바뀌지 않았다.**

## 2. 새로 추가한 파일 (4개 — 원본에 대응물이 없다)

| 파일 | 역할 |
|---|---|
| `app/vite.config.ts` | vite 루트(app/), `base:'./'`, 멀티 페이지 입력 3개(index/toast/tray), `@shared → ../src/shared`(복제 금지·단일 소스), minify 명시. **빌드 시각 HTML 변환 2개**(아래 §4) |
| `app/tsconfig.json` | `npm run typecheck:app` — 심이 `WindowApi`를 **전부·타입대로** 구현하는지 검사하는 유일한 자리(vite build는 타입을 안 본다) |
| `app/src/api/shim.ts` | `WindowApi` 전 메서드 구현. 호출은 `invoke('ipc_call', { channel, payload })` 하나, 이벤트는 Tauri `listen`(같은 채널명·preload의 허브 팬아웃 문법 그대로) |
| `app/src/api/chrome.ts` | 렌더러 CSS의 `-webkit-app-region`(드래그 영역)을 WebView2에서 재현 |

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
