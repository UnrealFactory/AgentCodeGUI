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
| `app/vite.config.ts` | vite 루트(app/), `base:'./'`, 멀티 페이지 입력 3개(index/toast/tray), `@shared → ../src/shared`(복제 금지·단일 소스), minify 명시 |
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

### 3.4 미구현 채널의 안전값

백엔드가 아직 없는 채널은 Rust가 `{ "__unimplemented": true }`를 돌려주고, 심이 **채널당
1회** `console.warn` 후 시그니처에 맞는 값(빈 배열/null/false/no-op)을 돌려준다. 예외는
`saveAttachmentData` 하나 — "경로 없음"을 뜻하는 안전한 문자열이 없어 reject하고,
유일한 호출부가 try/catch로 감싸 첨부를 건너뛴다(위 3.2).
