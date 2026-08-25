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
| `app/src/lib/limitResume.ts`<br>`app/src/lib/useLimitResume.ts`<br>`app/src/components/Chat.tsx` | 한도 재검증에 **「못 물어봤다」 갈래** 추가 (§6.3) | 조회 실패를 「풀렸다」로 오판해 **자동 전송**하던 자리(최종 파리티 R1 확인 크리틱 실패1). 아래 §6.3 |
| `app/src/components/ErrorBoundary.tsx` ★R28f | 선택 prop 둘(`resetKey`·`onError`) 추가 | **여기까지는 두 앱이 바이트 동일이었다**(md5 `6f1115813f09eac2936de557eec34448`) — 최종 파리티 감사 R2 §N2가 그 사실을 근거로 "갈리는 것은 스토어"라고 적었다. 그 사실이 이 라운드부터 **거짓**이다. 렌더 예외에서 나올 길을 만드는 데 이 둘이 필요했다. 아래 §6.8 |

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

### 3.3.1 구독은 **이 창 것만** (최종 파리티 R1 확인 크리틱 실패2)

preload의 `ipcRenderer.on`은 `webContents.send`로 온 것만 받았다 — 창 경계가 공짜였다.
Tauri의 `listen()`은 기본 대상이 `{ kind: 'Any' }`이고, 팬아웃이 그 대상을 **필터보다
먼저** 통과시킨다(`tauri/src/event/listener.rs` `match_any_or_filter`). 그래서 셸이
`emit_to(창, …)`로 한 창에만 보낸 이벤트를 **모든 창이 받았다.**

실측(크리틱): 메인에서 `shortcut:close`를 1회 부르면 메인 1 + 추가 채팅 창 1.
`FileModal.tsx:2998`이 그 채널로 뷰어를 닫으므로 **다른 창의 Ctrl+W가 이 창에 열린 파일
뷰어를 닫는다** — `ipc/parity/misc.rs:54`의 주석이 "그러면 안 된다"고 적은 바로 그 사고다.
같은 병이 `win:state`(남의 최대화가 내 타이틀바 아이콘을 뒤집는다)와
`session-wins:flush-request`(한 창을 닫으면 전 창이 저장한다)에도 있었다.

`subscribe()`가 **현재 창 라벨을 실어 등록한다**(`{ target: label }` → `AnyLabel`).
브로드캐스트(`app.emit`)는 필터 자체가 없어 그대로 다 받는다.

> **짝이 되는 셸 수정 하나**: `win.rs broadcast_sessions`가 `emit_to(MAIN, …)`이었다.
> 2.6.2 `broadcastSessionWins`는 `getAllWindows()`를 돌며 "팝아웃 창도 자기 btw 알약을
> 그리므로 목록 변화를 같이 받아야 한다"고 적어 뒀는데, 3.0은 메인에만 쏘고 **위 버그
> 덕분에 우연히** 전 창에 닿고 있었다. 필터를 살리는 순간 그 줄이 팝아웃·추가 채팅 창의
> 알약을 죽인다 → `app.emit`(진짜 브로드캐스트)으로 바꿨다.
> 검증: `poc-parity-t3t4.mjs` M1-2·M1-3(창 경계) · M1-4(브로드캐스트는 전 창).

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

### 3.5.2 ★R28f — **쓰기 채널은 안전값을 안 쓴다**(reject한다)

위 규약("어떤 화면도 크래시하지 않는다")은 **조회**에 옳다. 목록이 잠깐 비는 것은 다음
조회가 고친다. **상태를 바꾸라는 호출**에서는 그 규약이 정확히 거꾸로 돈다 — 최종 파리티
감사 R2 §N1이 잰 모양이다:

```
codexAuth.reorderAccounts(현재 순서) → {__unimplemented:true} → 심이 [] 로 갈음
  → setCxAccounts([]) → 화면의 OpenAI 계정이 통째로 사라진다
  → 호출부의 catch는 reject일 때만 도니 영원히 안 돈다(안내 문구 0개)
```

즉 **"실패했다"가 "빈 결과가 왔다"로 번역돼** 호출부에 도착했다. 그래서 `shim.ts`에 문이
하나 더 생겼다: `callStrict` — 미구현·IPC 실패를 `ShimUnavailableError`(어느 채널인지
들고 있다)로 **reject**한다. 조회는 그대로 `call`이다(그 문을 조회까지 넓히면 목록 하나가
없다고 설정 화면이 통째로 죽는다 = M1이 `call`을 만든 이유).

| 문 | 쓰는 채널 | 실패하면 |
|---|---|---|
| `call` | 조회 전부 · `auth:login`(반환값 `{ok:false,error}`에 실패가 실린다) | 안전값 resolve |
| `callStrict` | `auth:{logout,set-default-account,remove-account,reorder-accounts}` · `codex-auth:{logout,set-default-account,reorder-accounts}` | **reject** → 호출부가 문구를 세운다 |
| `callList` | `codex-auth:login` | strict + **배열이 아니면 reject**(사유는 `detail`) |

`callList`가 따로 있는 이유(★R28f · 2.6.2와의 분기): `codex-auth:login`은 **띄울 CLI가
없을 때** 목록이 아니라 `{ "error": "codex 실행 파일을 찾지 못했어요" }`를 돌려준다.
2.6.2는 그 판에서 목록을 그대로 돌려줬고(`src/main/codex/auth.ts:334` — `codexBin()`이
없어도 spawn 실패로 `finish()`가 돈다), 그러면 화면은 「눌렀는데 아무 일도 안 일어난다」다 =
이 절이 닫는 병과 같은 모양이다. claude 축은 반환 타입에 `error` 칸이 있어 이미 말하고
있었다(`status_wire`). 그 객체가 목록 setter에 그대로 앉으면 `cxAccounts.map`이 죽으므로
**배열만** 통과시킨다.

호출부 짝(`Settings.tsx`): 계정 쓰기의 `catch`가 예외 없이 `setNote(...)`를 세운다
(R1까지는 대부분 `/* ignore */`였고, 심이 안 던졌으니 티가 안 났다).
실측기 `scripts/poc-shim-strict.mjs` — `invoke`를 스텁으로 갈아끼워 두 갈래를 같이 잰다.

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

### 6.3 한도 자동 이어서 — 「못 물어봤다」 갈래 (최종 파리티 R1 확인 크리틱 실패1)

**2.6.2에는 없는 갈래를 일부러 더했다.** 원본의 2단 재검증은 판정이 **둘**이었다:
`blockedResetsAt(usage)`가 시각을 주면 아직 막힌 것, `null`이면 풀린 것. 그런데 조회가
실패해도 값의 모양이 `{fiveHour:null, weekly:null, weeklyFable:null, extraCredit:null}`
이라 **같은 `null`에 착지한다** — 즉 "못 물어봤다"가 "풀렸다"로 읽힌다.

2.6.2에서는 이 구멍이 대체로 덮여 있었다(실패 시 `getUsage`가 **마지막 성공값**을 주고,
그 값이 대개 창을 갖고 있다). 3.0에서 실제 사고가 된 것은 R1의 `usage:get`이 실패에
캐시조차 없을 때 빈 값을 그대로 냈기 때문이고, 크리틱이 `CCG_NO_NET=1` + 살아 있는
계정으로 **자동 전송까지 재현**했다.

| 조각 | 무엇 |
|---|---|
| `limitResume.ts` `usageUnavailable` | 셸의 `unavailable` 표식, 없으면 **창이 하나도 없다**가 같은 뜻 |
| `limitResume.ts` `codexUsageUnavailable` | Codex 판(창 목록이 비었다) |
| `limitResume.ts` `resumeVerdict` | 착지 셋 — 막혔다 / **못 물어봤다(유지)** / 풀렸다 |
| `limitResume.ts` `MAX_AUTO_ATTEMPTS`·`RECHECK_MS`·`recheckDelayMs`·`holdDelayMs` | 재확인 간격(15초→배증→10분)과 **눈감고 쏘는 재개의 상한**(2 — `crates/ccg-engine/src/limit.rs`와 같은 값) |
| `LimitHold.probes` | 연속 조회 실패 횟수. `sanitizeHold`가 복원에서도 살린다(껐다 켜기로 상한이 초기화되면 그게 곧 "부팅마다 한 번 눈감고 쏘기"다) |
| `useLimitResume.ts` `fire()` | 위 판정을 부르는 배선. 조회가 **던져도** 실패로 읽는다 |
| `Chat.tsx` `LimitHoldBar` | 카운트다운이 `resumeDelayMs` → `holdDelayMs`. 타이머와 배너가 같은 함수를 본다 |

**계약면도 한 칸 넓혔다**(`src/shared/protocol.ts` `UsageInfo`): `unavailable?`·`stale?`.
둘 다 선택이고 2.6.2 본체는 내지 않는다 — 없으면 위 ②(창 0개) 규칙으로 떨어진다.

**언제 그래도 쏘나**: 조회 실패가 상한(2회)을 넘겼고 **문구가 알려 준 리셋 시각이 이미
지났을 때**만 한 번. 시각을 모르면(배너형 문구) 영원히 안 쏜다 — 근거가 하나도 없다.

검증: `scripts/poc-limit-resume.mjs` G절이 **실제 훅을 그대로 구동한다**(최소 훅 런타임
+ 가짜 `window.api`), 본채팅·멀티 패널·추가 채팅 **세 표면의 실제 props**로 각각.
실패값은 지어낸 모양이 아니라 `scripts/poc-limit-blind.mjs`가 실 exe에서 읽어 온 값이다.

### 6.4 AI 커밋 메시지의 diff — 수집 방법이 갈렸다 (후속 GIT R1)

**표면은 같다**(프롬프트 모양·캡·마커·톤 참조 전부 2.6.2 그대로). 갈린 것은 **그 diff를
어떻게 모으는가**이고, 결과 텍스트가 드물게 달라질 수 있어 여기 적는다.

| 조각 | 2.6.2 (`src/main/git.ts`) | 3.0 (`ccg_fs::git::bulk_file_diffs`) |
|---|---|---|
| 스폰 수 | 파일당 `gitFileDiff` = **2N회** | 전체 **2회**가 보통 (실측 900파일: 43.8초/1800 → 195ms/2) |
| diff 엔진 | 자체 LCS(`compute_line_diff`) | `git diff -U0` (같은 줄이 나오지만 **줄 귀속이 드물게 다를 수 있다**) |
| 1.5MB 초과 파일 | 본문 통째로 접고 「너무 커요」 | **변경 줄은 그대로 준다**(한 줄 고친 2MB 파일이 한 줄로 나온다) |
| 안 바뀐 파일 | 전체 파일 diff(+0 −0) | 변경 줄 0 — 직렬화 결과는 **같다**(ctx는 원래 안 실린다) |

**뷰어는 안 갈렸다.** 뷰어 계약(전체 파일·ctx 포함)은 `file_diff` 그대로이고,
`bulk_file_diffs`는 AI 프롬프트 전용이다.

**되돌아가는 단위**(R28b GIT R1 확인 크리틱 정정 — 앞선 판은 전부 "그 파일만"이라고
적었는데, 실제로는 **배치 전체**로 내려앉는 자리가 있었다):

| 자리 | 단위 | 지금 |
|---|---|---|
| C 인용 경로(제어문자)·중복 경로·디스크에 없는 경로 | **그 파일만** `file_diff` | 그대로 |
| unborn HEAD(첫 커밋 전) | 배치 전체가 파일당 호출(300파일 = 902스폰·31.3초) | 옛 쪽이 통째로 비었다는 뜻이라 **디스크에서 바로**(300파일 = 3스폰·107ms) |
| 전 트리 diff가 32MB 캡 초과 | 배치 전체가 파일당 호출(600파일·45MB = 1,202스폰·32.4초) | 목록을 **반으로 갈라** 다시(400파일·72MB = 9스폰·1.7초) |
| 파일 **하나**가 혼자 32MB 초과 | — | 그 덩이만 `file_diff`가 사유를 낸다 |

어느 경우든 **답은 옛길과 같다**(테스트가 두 길을 1:1로 마주 세운다). 갈린 것은 속도뿐이고,
위 두 줄이 R1에서 속도만 조용히 옛날로 돌아가 있던 자리다.

### 6.5 「기본 계정」 개념 제거 — 기본 = 정렬 맨 위 (후속 ACCT R1 · 사용자 요청)

사용자 요청(`docs/r28-followup.md` §4): *"계정의 「기본」 개념을 삭제하고, 항상 정렬 기준
맨 위 계정이 선택되게. 괜히 복잡하다."*

**2.6.2와의 의도적 분기다.** 파리티 재감사가 「기본으로」 버튼 부재를 회귀로 잡지 않게
여기 적는다.

| 조각 | 2.6.2 | 3.0 |
|---|---|---|
| 기본 계정의 진실 | `accounts.json`의 `defaultEmail` **필드**(상태) | **목록 0번**(파생값) |
| 설정 ▸ Account 버튼 | 「기본으로」(`auth:set-default-account`) | **「맨 위로」**(순서를 바꾼다) |
| 배지 | 「기본」 | 「기본 · 맨 위」 — 인덱스 0의 파생 표시 |
| `AccountInfo.isDefault` | `defaultEmail === email` | `index === 0` (`ipc/system.rs`·`claude::list_accounts`) |
| `auth:set-default-account` | 필드를 쓴다 | **「맨 위로 이동」과 동치**(채널은 남는다 — 동결 2.6.2 렌더러가 아직 부른다) |
| `codex-auth:set-default-account` | 필드를 쓴다 | **「맨 위로 이동」과 동치** — Anthropic 축과 같은 규약(★R28f 정정, 아래) |

**★R28f SHIPBLOCK 정정 — 이 표의 마지막 줄은 R28f 이전까지 거짓이었다.**
그 자리에는 *"3.0 화면은 안 부른다(`reorderAccounts`로 **같은 결과를 저장한다**)"* 라고
적혀 있었고, `Settings.tsx`의 주석도 *"결과는 같고(맨 위 = 기본), **실제로 저장된다**"* 라고
적었다. **저장되지 않았다** — `codex-auth:reorder-accounts`에도 핸들러가 없었다(감사 R2 §N1의
전수 grep: `codex-auth:{login,logout,login-cancel,reorder-accounts,set-default-account}` 문자열이
Rust 소스에 **0회**). 화면이 부르던 채널과 장부가 가리키던 채널이 **둘 다 비어 있었다.**

R28f가 다섯을 배선하면서(`src-tauri/src/ipc/accounts.rs`) 이 칸의 선택도 다시 골랐다 —
**재정렬로 흡수한다**(`codex::set_default_account` = `move_account_to_top`). 근거 셋:

1. 같은 홈을 여는 **2.6.2 렌더러(동결)** 가 아직 이 채널을 부른다. 거기서 「기본으로」를
   누르면 3.0에서도 같은 결과(그 계정이 맨 위 = 기본)가 나와야 한다.
2. Anthropic 축이 이미 이 선택을 했다(위 줄). 두 축이 같은 이름의 채널에서 다르게 굴면
   장부가 두 벌이 되고, 다음 라운드에 한쪽만 고쳐진다.
3. no-op은 **성공처럼 보이는 실패**다 — 렌더러는 새 목록을 받아 그대로 그리므로 아무 표시
   없이 순서만 안 바뀐다. 이 라운드가 닫는 병과 정확히 같은 모양이다.

그리고 3.0 화면도 이제 **이 채널을 부른다**(`doCodexMoveTop` → `codexAuth.setDefaultAccount`) —
Anthropic 축의 `doMoveTop`과 같은 모양으로. 꾹-드래그·정렬 버튼은 그대로
`reorderAccounts`다(그건 순서 전체를 옮기는 조작이라 채널도 그쪽이 맞다).

**마이그레이션**(`claude::migrate_default_to_top` · `codex::migrate_default_to_top`):
기존 `defaultEmail`이 3번째를 가리키고 있었으면 그 계정을 **맨 위로 옮긴 뒤** 우리는 그
필드를 안 읽는다. 옮기지 않고 무시만 하면 그 사용자의 새 채팅이 **말없이 1번째 계정으로
갈아탄다**(프롬프트 캐시가 식고 남의 한도를 태운다). 프로세스당 한 번, 옮길 게 있을 때만
쓴다. **파일에서 필드가 사라지지는 않는다** — `render_store`가 `None`을 받으면 맨 위
계정으로 다시 채우기 때문이고, 그래서 같은 홈을 2.6.2로 열어도 기본 계정이 그대로다
(값이 언제나 「맨 위」와 같아질 뿐이다).

**함정 하나**(테스트가 지킨다 — `moving_to_the_top_and_reordering_survive_a_restart`):
정렬·「맨 위로」가 옛 `defaultEmail`을 그대로 들고 저장하면, **다음 부팅의 마이그레이션이
사용자의 정렬을 되돌린다.** 그래서 순서를 바꾸는 세 경로(`reorder_accounts`·
`move_account_to_top`·codex 짝)는 전부 `default_email = None`으로 쓴다.

**파급 전수**(「기본」을 읽던 자리 전부 파생값으로):
`ipc/system.rs`(두 목록의 `isDefault`) · `engine/ident.rs`(실행 정체성의 기본 계정 · Codex 축 포함) ·
`ccg_auth::claude/codex::default_account_email`(→ `usage:get`·`git:ai-message`·`codex_limit`·
`codex_versions`가 이걸 부른다) · 렌더러의 `accounts.find(a => a.isDefault)`(Chat picker · GitModal).

**★R2 — 마이그레이션은 「첫 조회보다 먼저」여야 한다.** R1은 이관을 `ccg_auth`의
`list_accounts`/`default_account_email`이 지날 때만 돌렸다. 그런데 위 파급 목록의 앞 둘
(`ipc/system.rs`·`engine/ident.rs`)은 `accounts.json`을 **직접** 읽어 그 문을 안 지난다.
그래서 2.6.2 승계 판(`defaultEmail`이 3번째)의 **첫 세션 내내** 화면 목록·본채팅·새 채팅이
전부 옛 순서의 1번째 계정이었다 — 이 절이 막겠다고 적은 바로 그 사고이고, 재시작해야
맞았다(확인 크리틱 R1 F3). R2는 셋을 함께 잠근다: `main()`이 창·IPC보다 **먼저**
`ensure_default_migrated()`를 부르고(양 축), `ipc/system.rs`의 두 목록과
`engine/ident.rs::defaults()`도 읽기 직전에 같은 문을 지난다(프로세스당 1회 CAS).

### 6.6 계정 「사용 중」 표시 + 「현재」 강조 + 전환 되돌리기 (후속 ACCT R1 · 신기능)

2.6.2에 대응물이 없다(추가 기능이라 회귀가 아니다). 근거: `docs/r28-followup.md` §3·§3-b.

| 조각 | 무엇 |
|---|---|
| `ChatStatusLite.account` | ★새 필드 — 이 채팅이 물고 있는 구독 계정. **키가 있으면 살아 있는 런타임**이다 |
| `ChatStatusLite.panelId` | ★새 필드 — 그 채팅이 앉은 **멀티 보드** 자리(`${boardId}::${slot}`). 「2번 자리」 문구가 여기서 나온다(panelId↔chatId는 보드 스토어만 안다). **본채팅은 없음** |
| `app/src/lib/accounts.ts` | 역인덱스 + 자리 이름표. 판정 소스는 위 REPLACE **하나**다 — 창이 여럿이라 렌더러가 모은 표로는 자기 창밖을 못 본다 |
| picker `.pp-row.cur`·`.pp-now` | §3-b 「현재」(파랑 계열) |
| picker `.pp-warn` | §3 「사용 중 · 2번 자리」(주황 계열). **선택은 막지 않는다** |
| `.acct-undo` | §3-b 「A → B 전환됨 · 되돌리기」(12초) |

**★R2 정정 — 「키가 있으면 살아 있는 런타임」은 R1에서 문장일 뿐이었다.**
확인 크리틱 R1 F1이 실 exe로 잡았다: `ccg_store::status::set()`이 `lite::build`의 결과를
통째로 메모리 맵에 넣고 `flush()`가 그 맵을 그대로 썼기 때문에, **턴을 한 번이라도 돌린
채팅은 이후 모든 부팅에서** 그 계정을 「사용 중」으로 만들었다(재기동 직후 런타임이 하나도
없는 판에서 배지 확인). 늘 켜져 있는 경고는 없는 것보다 나쁘다. R2에서 그 문장을 **세 자리의
코드**로 만든다:

| 자리 | 무엇 |
|---|---|
| `engine/lite.rs` | 생존 판정 — *busy 턴 중 **이거나** 상주 CLI 생존*(§3의 정의 그대로). 슬롯만 있는 채팅·밖에서 죽은 CLI는 계정을 안 싣는다 |
| `ccg_store::status` | `account`·`panelId`는 **디스크에 안 쓰고**(`flush`), **부팅 첫 장전에서만 걷어낸다**(`load_boot` — R1이 이미 써 둔 파일의 답). ★R28c AG2: 그 뒤의 `load_boot`(=`chats:get`)은 **조회**라 살아 있는 메모리가 이긴다 — 읽기 한 번이 살아 있는 런타임의 계정·승인 대기를 지우던 자리(G2) |
| ~~`hub::Op::Dispose`~~ | ~~런타임을 거두면 마지막 lite에서 계정을 뗀다(`status::clear_runtime`)~~ → **★R3 정정 아래** |

**★R3 정정 — 「사용 중」을 걷는 자리는 `Op::Dispose`가 아니었다(확인 크리틱 R2 G1).**
R2가 위 표 셋째 줄에 세운 문은 **사용자가 닿는 어느 삭제 경로에서도 안 열렸다.** 실 exe
실측: 같은 계정을 문 채팅 둘 중 하나를 지우면 디스크는 prune되는데(`index.json`·`status.json`
둘 다 한 줄) `chat:status`는 지운 채팅을 계정과 함께 계속 싣고 picker 칩이 「사용 중 ·
**다른 자리**」로 남았다 — 이름표까지 잃은 유령이고, 12초 무입력에 브로드캐스트 0건이었다.
기제는 **순서**다: ① 본채팅 삭제는 `chats:save`(목록 REPLACE) → `chats_v3::write_chats` →
`status::retain` 하나뿐이라 `Op::Dispose`가 아예 안 나갔고, ② 유일한 `dispose_chat` 호출자
(`win::session_close`)마저 `remove_chat` 안의 `status::forget_one`이 **먼저** 돌아
`clear_runtime`이 `false`를 돌려줬다(→ 거기 매단 `emit_all`이 영원히 침묵).

R3은 문을 **값을 지우는 자리**로 옮긴다 — 「값의 주인이 브로드캐스트도 책임진다」:

| 자리 | 무엇 |
|---|---|
| `status::retain` → `Vec<String>` · `status::forget_one` → `bool` | **지운 이름을 돌려준다**(`#[must_use]`). 지운 것이 없으면 빈 값 — 헛 브로드캐스트를 안 만든다 |
| `chats_v3::write_chats` · `legacy_bridge::{chats_save, ma_save}` → `Vec<String>` | 이번 저장이 목록에서 **지운 채팅들**. 기준선은 *저장 전 `index.order`* ∪ *걷힌 상태 행* — 앞은 턴을 한 번도 안 돈 채팅을 잡고, 뒤는 인덱스가 깨진 판을 잡는다 |
| `engine::dispose_removed_chats(app, &removed)` | ①`Op::Dispose` 던지기 → ②허브 FIFO **배리어**(`Op::Debug`의 답 = "전부 거뒀다") → ③늦은 전이가 되앉힌 행 청소 → ④`chat:status` REPLACE **한 번**. R2의 `dispose_chat`은 여기로 흡수했다(회수와 통지를 가를 수 있는 모양을 남기면 다음 호출자가 또 반쪽만 부른다) |

겸해 닫힌 것: **본채팅 삭제 경로에 런타임 회수가 아예 없었다.** 상주 CLI가 붙어 있으면
지운 대화의 프로세스가 그대로 남는다(§3 밖의 사실이라 크리틱은 결함으로 안 셌다).
회귀 못은 **삭제 축**으로 새로 박았다 — `poc-acct-live` 시나리오 E(재시작 축인 A는 이
결함을 100% 통과한다) + `ccg-store` 단위 못 3.

**★R2 정정 2 — 본채팅은 「1번 자리」가 아니다.** 마이그레이션이 만드는 `default` 보드는
`count:1`일 때 `chrome:"ide"`(= 본채팅 화면)이고 그 슬롯 0이 본채팅을 문다. R1은 라우팅용
`panel_id_for_chat`을 표시에도 써서 본채팅의 `panelId`가 `default::0`이었고, 렌더러가 자리
번호를 이름표보다 먼저 고르므로 칩이 **「사용 중 · 1번 자리」**였다 — 멀티 첫 자리와 문구가
충돌해 *어디서 쓰는 중인지*를 못 가렸다(크리틱 F4). 표시용 `panel_seat_for_chat`이
`chrome:"ide"` 보드를 자리로 세지 않는다. **라우팅(`ma:event` 봉투)은 안 바꿨다** — 그쪽
질문은 "이 봉투를 누가 듣나"라 판정이 다르다.

**알려진 한계**: 역인덱스를 먹이는 `chat:status` 구독은 메인 창에만 있다
(`App.tsx`). 추가 채팅 창(`SessionWindow`)은 자기 chatId를 렌더러에서 모르기도 해서,
그 창의 picker에는 「사용 중」 칩이 **안 뜬다**(거짓 칩 대신 침묵을 고른다).

**★R2 — 되돌리기가 정체성에 닿는다(F2).** `chats:save`의 정체성 흡수는 에코 가드
(`legacy_bridge::renderer_authored`) 뒤에 있고, 그 판정은 *"셸이 마지막으로 투영한 지문과
다른가"*였다. 되돌리기가 복원하는 값은 정의상 마지막 투영값과 같아서 **에코로 분류됐다** —
화면만 돌아오고 파일은 실수한 계정으로 남았다(크리틱 F2: 재시작 뒤 `RAN-two_ccg.test`).
R2는 `PROJECTED`의 뜻을 *"마지막으로 **내보낸** 값"* → *"마지막으로 **합의한** 값"* 으로
넓힌다: 흡수도 합의이므로 채택한 지문을 되적는다. 셸이 저자인 턴 중 폴백은 흡수를 안 거쳐
`PROJECTED`를 안 건드리므로, R2 가드(낡은 디바운스 저장이 폴백을 되돌리는 P3 재발)는 그대로다.

### 6.7 `auth:accounts-usage`가 선택 옵션을 받는다 (후속 ACCT R1 · §1)

2.6.2는 인자 0개다. 3.0은 **선택 옵션 하나**를 더 받고, 안 넘기면 한 글자도 다르지 않다.

| 옵션 | 무엇 | 왜 |
|---|---|---|
| `cachedOnly` | HTTP 0회 · 디스크 캐시만 | 첫 페인트가 조회를 안 기다리게(계정 3개 실측 **6.19ms**) |
| `priority` | 그 계정을 먼저 조회 | 사용자가 지금 보는 숫자가 먼저 갱신되게. **응답 순서(=등록 순서)는 안 바뀐다** — 바뀌면 §4에서 기본이 널뛴다 |
| `warm` | 로컬 토큰이 살아 있는 계정만 | 워밍이 **리프레시 토큰을 회전시키지 않게**(M11 R2 C1이 부팅 프리웜을 들어낸 그 이유) |
| `retry` ★R2 | 실패 격리(3분)를 **넘는다** | 사람이 누른 조회다. 없으면 「다시 시도」가 격리 창 내내 무동작이다(크리틱 F5) |

행에도 표식이 붙는다(`AccountUsage.stale`·`unavailable`) — §6.3의 `UsageInfo`와 같은 규약이고,
설정 화면이 「조회 실패 · 다시 시도」와 「그 플랜엔 그 한도가 없다」를 나눠 말하는 근거다.
연속 실패 계정은 3분간 조회를 건너뛴다(직렬 큐를 죽은 계정 하나가 막지 않게) — **다만
`retry`는 그 문을 연다**. 격리는 벌이 아니라 큐 보호용 우회이고, 사람이 기다리기로 한
조회까지 막을 이유가 없다. 렌더러 쪽 짝: 수동 재시도는 **워밍·자동 갱신에 합류하지 않는다**
(그 답에는 사용자가 보려는 계정이 비어 있다). 재시도끼리는 그대로 합류한다 —
「인플라이트 중복 0」은 이 축에서 안 갈린다(`poc-acct-store.mjs` C2·C3).

**★R2 정정 — 「인플라이트 중복 0」은 한 창 안에서만 참이었다(N1).** `#session`(추가 채팅
창)·`#mapanel`(팝아웃)은 같은 번들의 **다른 OS 창 = 다른 JS 힙**이라 `lib/accounts.ts`를 한
벌씩 들고, 그 창들도 계정 picker를 그린다. R1의 합류는 렌더러 모듈 안에만 있어서 두 창이
겹치면 조회가 **계정 수 × 2벌** 나갔고(분당 1~2건이 예산인 엔드포인트다), 더 나쁘게는
나중에 끝난 훑기가 자기 **낡은 스냅샷**을 `usage-cache.json`에 통째로 되박아 상대의 신선한
값을 지웠다(확인 크리틱 R1 N1 — 1차·2차 판정 양쪽이 못 본 자리). R2는 합류의 진실을 셸로
내린다:

| 자리 | 무엇 |
|---|---|
| `ipc/parity/usage.rs` 계정별 레인 | 같은 계정을 도는 훑기가 있으면 **줄을 선다**(`net`의 토큰 레인과 다른 축이다 — 저쪽은 이중 회전, 여기는 조회 중복) |
| 레인 안 디스크 재확인 | 깨어나서 파일을 다시 본다 → 앞 주자의 값이 신선하면 **HTTP 0회** |
| `usage::merge_usage_cache` | 캐시는 이제 **줄 단위 병합**이다(`write_usage_cache` 통째 쓰기는 초기화·시드 전용). M11 자동 전환 워커(`engine/acct_switch.rs`)도 같은 문을 쓴다 |

실측(레인을 빼고 재본 대조군): 계정 3개 × 두 창 훑기 = **6회 → 3회**
(`two_windows_sweeping_at_once_ask_each_account_only_once`). 렌더러 합류는 IPC 왕복을 아끼는
앞단으로 남는다 — 그 경계 자체가 `poc-acct-store.mjs` C4의 못이다(모듈을 한 벌 더 들면
조회도 한 벌 더 나간다고 **적어 둔다**. 「창끼리도 합쳐진다」고 적으면 셸 레인을 걷어내도 초록이다).

**★R2 정정 2 — 「워밍은 회전을 유발할 수 없다」는 사실보다 셌다(N2).** `warm`의 문은 **로컬
만료 시각만** 본다. *"시간상 살아 있는데 서버가 이미 죽인"* 토큰은 그 문을 통과하고,
`fetch_account_usage`가 401/403에서 `force_refresh` → `rotate`로 간다 — 성공하면 그 순간 옛
refresh 토큰이 서버에서 죽는다(사용자는 앱을 켜기만 했다). R2는 문장을 코드로 만든다:
`ccg_auth::rotation`(스레드 로컬 **회전 금지 구역**)을 워밍 조회 둘레에 두르고, 회전으로 가는
문 **둘 다**(`access_token`·`force_refresh`)가 그 관문을 지나 `NetError::RotateForbidden`으로
착지한다. 스레드 로컬인 이유: 사용자가 Account 탭을 직접 열어 부른 조회는 **구역 밖**이라
옛 규약대로 교환까지 간다(거기까지 막으면 만료된 계정의 게이지가 영영 안 낫는다).

### 6.8 `ErrorBoundary`가 **자리 단위**가 된다 + 부팅 격리 (R28f SHIPBLOCK N2)

`app/src/components/ErrorBoundary.tsx`는 이 라운드 전까지 2.6.2와 **바이트 동일**이었다
(md5 `6f1115813f09eac2936de557eec34448`). 이제 갈린다. 갈라야 했던 이유는 감사 R2 §N2의 실측이다:

```
                       선택 직후                  「앱 새로고침」 클릭 뒤
 3.0(R28f 전)  eb 1·sb 0·win 0  →  eb 1·sb 0·win 0·chat 0   activeChatId="fix-boom"  갇힘
 2.6.2         eb 1·sb 0·win 0  →  eb 0·sb 3·win 1·chat 1   activeChatId="fix-long…" 복구
```

두 앱 다 **선택 직후 화면에서 크롬이 통째로 사라진다**(경계가 앱 루트 하나뿐이라
`MainApp`이 언마운트된다 = 사이드바도 없다). 갈리는 곳은 새로고침 뒤다: 3.0은 활성 채팅을
**즉시 영속**하므로(`chats:set-active` → `chats_v3::set_active`) 예외 채팅이 활성인 채로
재부팅되고 같은 카드로 되돌아온다. 2.6.2는 디바운스 저장이라 옛 활성 채팅으로 돌아온다.

**즉시 영속은 안 건드린다.** ① 그건 M-UX §6.2 U3의 계약이고(별칭 계층은 인자에 `chatId`가
없어 "그 순간의 활성 채팅"으로 실행을 라우팅한다 — 미루면 "전환 직후 전송"이 남의
`ChatRuntime`에 붙는다), ② **미뤄도 이 감옥은 안 풀린다**: 「앱 새로고침」은 웹뷰만 다시
그리고 셸(Rust) 프로세스는 그대로라, 활성 채팅의 진실이 셸 메모리에 남아 그대로 돌아온다.

대신 탈출구를 **둘** 만든다.

| # | 무엇 | 어디 |
|---|---|---|
| ① | 본채팅 워크스페이스가 **자기 경계**를 갖는다(멀티 보드는 이미 그랬다) | `App.tsx` 단일 모드 가지 |
| ② | 렌더를 넘어뜨린 채팅 id를 적어 두고, 다음 부팅이 그 채팅을 활성으로 잡으려 하면 **다른 대화로 착지**한다(1회 소비) | `App.tsx` `markChatCrash`/`takeChatCrash` + `ErrorBoundary.onError` |

①이 있으면 카드가 떠도 왼쪽 칼럼(사이드바·탐색기)과 창 크롬은 경계 **밖**이라 그대로
살아 있다 — 다른 대화로 갈 수단이 화면에 있다. 그 클릭 하나로 경계가 스스로 풀리도록
`resetKey`(=활성 채팅 id) prop이 붙었다(「다시 시도」를 또 누르게 하지 않는다).
②는 새로고침 경로를 2.6.2와 **같은 결과**로 만든다. 영구 블랙리스트가 아니다 —
표식은 읽는 즉시 지워지고, 그 대화는 사이드바에 그대로 있으며 다시 고르면 평소처럼 열린다
(그리고 또 터지면 다시 적힌다).

**실측**(`scripts/poc-shipblock.mjs` — 두 앱 나란히, 같은 픽스처·같은 순서):

```
                     선택 직후                       사이드바로 탈출   새로고침 뒤
 3.0(R28f)  eb 1·sb 3·win 1·chat 0            eb 0·chat 1      eb 0·sb 3·win 1·chat 1  active=fix-long-thread
 2.6.2      eb 1·sb 0·win 0·chat 0            (사이드바 없음)   eb 0·sb 3·win 1·chat 1  active=fix-long-thread
```

**「다른 문」도 같이 쟀다**(`--boot=multi` — 예외를 던지는 것이 멀티 보드일 때):
3.0 `eb 1·sb 6·win 1`, 2.6.2 `eb 1·sb 4·win 1`, 둘 다 사이드바로 탈출 성공. 멀티 보드는
**두 앱 다 원래 안 갇힌다**(자기 경계가 이미 있었다 — 그래서 본채팅에도 같은 처방을 놓은 것이다).
설정 모달은 `settingsOpen`이 `useState(false)`이고 어떤 pref에도 안 실리므로
(`App.tsx:325` · `setPref` 호출 목록에 없다) 새로고침이 언제나 닫힌 채로 착지한다 = 부팅 루프가 없다.

### 6.9 로그인 「취소」가 **래퍼 안의 CLI까지** 닿는다 (R28f SHIPBLOCK R2)

2.6.2보다 **더 하는** 자리다(회귀가 아니라 의도적 개선 — 파리티 재감사가 「2.6.2와 다르다」로
잡지 않게 여기 적는다).

**무엇이 문제였나**(R28f 확인 크리틱 ★최대 격차 · 내 손으로 재현):
전역 npm 설치의 codex는 `codex.cmd` 셰임이라 셸이 `cmd /C`를 거쳐 띄운다
(`ipc/accounts.rs::codex_command`). 그러면 **우리 자식은 `cmd.exe`**고, 정작 CLI는 그
자식이다. R1의 「취소」는 `Child::kill()` 하나였으므로 `cmd.exe`만 죽었고 —

| 결과 | 실측 |
|---|---|
| 손자(CLI)가 stdout/stderr 파이프를 쥔 채 산다 | `pump_login`의 **유일한** 완료 신호였던 파이프 EOF가 영영 안 온다 |
| `codex-auth:login` IPC가 5분 상한까지 안 돌아온다 | 렌더러 `busy='codex-login'`이 계정 탭 **두 축** 버튼을 전부 disabled로 묶는다 |
| 앱을 닫아도 손자가 산다 | `PING.EXE`(픽스처) / 실제로는 로그인 콜백 포트를 문 CLI |

2.6.2도 **같은 픽스처에서 똑같이 얼어붙는다**(크리틱·나 둘 다 실측). 즉 회귀는 아니었지만
`cmd /C` 갈래와 EOF 완료 판정은 둘 다 R28f가 새로 쓴 코드라 이 라운드가 닫는다.

**처방 둘.**

1. **완료 신호를 둘로.** `pump_login`이 파이프 EOF만 기다리지 않고 150ms마다
   `LoginSlot::owns(gen)`을 함께 본다 — 「슬롯에 내 자식이 더 이상 없다」 = 취소됐거나 다음
   시도가 치웠다. 손자를 못 죽이는 판이 또 와도 **화면은 안 선다**.
2. **죽이는 대상은 「래퍼 + 직속 자식」**(`kill_wrapped_child`). 트리 전체(`taskkill /T`)가
   **아니다**: 로그인 CLI는 브라우저를 자기가 열고, 그 브라우저는 CLI의 자식이다. 트리째
   죽이면 사용자가 방금 연 브라우저 창이 같이 죽는다. `cmd /C`는 **우리 구현의 사정**이지
   사용자의 것이 아니므로, 네이티브 `.exe` 갈래(`Child::kill()`이 CLI만 죽이고 브라우저는
   안 건드린다)와 **대칭이 되는 지점**이 정확히 깊이 1이다.

**실측**(내 계기 `C:\Temp\ccg-r28f-ship\tools-r2` · 대조군 = R28f 직전이 아니라 **이 라운드
직전 HEAD**를 새 `CARGO_TARGET_DIR`에서 따로 구운 exe):

| 픽스처 | 대조군(`59b743ec…`) | R2(`7a6eccf9…`) |
|---|---|---|
| `.cmd` 셰임 — 취소 후 스피너 | **90초 내내 1**(안 풀림) | **518ms에 0** |
| 〃 「계정 추가」·「삭제」 | `disabled=[true]` / `[true,true]` | `[false,false]` / `[false,false]` |
| 〃 손자(CLI) | 취소 후 · **앱 종료 후에도 생존** | 취소 즉시 0 · 종료 후 0 |
| 네이티브 `.exe` — 스피너 | 508ms | 516ms (파리티) |
| 깊이 2 「브라우저」 — 취소 후 | 생존(CLI도 같이 생존) | **생존**(CLI만 죽는다) |

마지막 줄이 처방 2의 근거다: 래퍼와 CLI는 죽고, **CLI가 연 것은 산다.**

### 6.10 Verse 「지정」 셋은 **사유를 돌려준다**(조회 셋은 그대로 조용하다) — R28f SHIPBLOCK R2

Verse가 3.0 범위 밖이라는 결정은 그대로다(사용자 결정 — §6.5와 같은 성격의 의도적 분기).
바뀌는 것은 **그 사실을 화면이 말하는가**뿐이다.

| 채널 | R1까지 | R2 |
|---|---|---|
| `lsp:verse-registry` / `-digests` / `-excludes`(조회) | `null` / `[]` (셸이 명시적으로) | **그대로** — 없는 게 정상이다 |
| `lsp:pick-verse-server`(버튼) | 셸이 안 받음 → 심 안전값 `null` | `{ error: "Verse 서버 지정은 3.0에서 아직 제공하지 않아요" }` |
| `lsp:set-verse-path`(버튼) | 〃 → `{ok:false,error:"unimplemented"}` | `{ ok:false, error: 위 문장 }` |
| `lsp:clear-verse-path`(버튼) | 〃 | `{ ok:true }` — 지울 게 없으면 **이미 목표 상태**다 |

**왜 `pick`만 유독 위험했나.** 그 채널의 `null`에는 뜻이 **둘** 있다 — 「사용자가 파일
대화상자를 취소했다」(조용한 게 맞다)와 「셸에 그 채널이 없다」(말해야 한다). 심의 안전값이
후자를 전자로 **번역**해서 호출부의 `if (!p) return`이 아무 흔적 없이 삼켰다. §3.5.2가
계정 쓰기에 세운 것과 같은 처방을 여기에 놓는다: 심의 `callPathOrNull`이 문자열/`null`
**둘만** 통과시키고, 그 밖은 사유(`detail`)를 실어 reject한다.

**★그런데 그 버튼은 3.0 화면에 없다**(실측 — 이 절이 고친 것의 범위를 정직하게 적는다).
설정 ▸ Code의 서버 목록에 Verse 행이 **0개**다: `Provision::External`은 타입에 있지만
`crates/ccg-lsp/src/spec.rs`의 어떤 서버 스펙도 그 값을 안 쓴다. 두 exe에서 Code 탭을 열어
센 결과가 같다 — `verseRows=0`, 버튼은 `["설치","설치"]`(C#·C++) 둘뿐.
즉 지금 고친 것은 **채널의 정직함**이고, Verse 행이 3.0에 들어오는 날 이 침묵이 되살아나지
않게 하는 자물쇠다(테스트 `the_verse_buttons_answer_with_a_reason_while_the_lookups_stay_quiet`).

### 6.11 「AgentCodeGUI3으로 열기」의 **웜 런치 반쪽** — 실패가 화면에 뜬다 (R28i N3)

우클릭 메뉴 자체는 이미 설치기가 HKCU에 쓴다(`src-tauri/nsis/hooks.nsh` —
`Directory\shell` + `Directory\Background\shell`, 명령은 `"<exe>" "%V"`). 3.0은 X를 눌러도
트레이로 숨는 것이 기본이라(`win.rs` `hide_on_close`) **「이미 떠 있다」가 정상 상태**고,
R28h까지 그 상태에서 그 메뉴를 누르면 `main.rs`의 단일 인스턴스 관문이 창만 앞으로 올리고
**폴더 인자를 버렸다** — 오류도 안내도 없이(최종 파리티 R5 §9.1 `N3` · 높음).

| 축 | 2.6.2 | 3.0 R28h까지 | 3.0 R28i (확인 크리틱 R1 수정 뒤) |
|---|---|---|---|
| 콜드 런치(앱이 꺼져 있음) | `openedDirFromArgv(process.argv)` → `app:get-initial-dir` | **같다**(`parity::misc::initial_dir`) | 「어느 인자가 폴더인가」는 **그대로 그 함수**가 고른다. 그 답을 `classify`로 한 번 더 걸러 **못 여는 경로면 카드**를 띄우고 착지를 접는다 |
| 웜 런치(이미 떠 있음) | `second-instance` → `send(IPC.openDirectory, dir)` | **없다**(방출자 0 · `raise_existing()` 뒤 `return`) | `main.rs`가 인계 파일을 남기고 → `win::tray`의 raise 수신부가 소비 → `app:open-directory` |
| 폴더가 아닌 인자 | `statSync().isDirectory()`가 false → **조용히 버림** | 〃(그 앞에서 이미 버려짐) | **`app:open-directory-failed`로 사유를 보낸다** → `NoticeModal` 카드 (**콜드·웜 양쪽**) |
| **못 읽는 폴더**(deny ACL) | `statSync().isDirectory()`는 true → **그냥 연다** | 〃 | **안 연다** — `read_dir` 한 번을 더 보고 `denied` 카드 |
| 공백만 있는 인자 | 조용히 버림 | 〃 | `empty` 카드 |
| **기동 중**(0~0.8초)에 온 폴더 | `second-instance`가 이미 서 있어 도착 | (도착 자체가 없다) | 렌더러가 설 때까지 인계를 **남겨 두고**, 첫 조회(`app:get-initial-dir`) 때 걷는다 |
| 인자 **없는** 두 번째 실행 | 그냥 focus | 그냥 raise | 그냥 raise — 신호의 `WPARAM=0`이라 인계를 **안 걷는다** |
| 원시 `app:open-directory` 호출 | (핸들러 없음 — send 전용) | `{__unimplemented:true}` | `{ok:true,dir}` / `{ok:false,reason,path}` |

**성공 페이로드는 2.6.2와 글자 그대로 같다**(문자열 하나) — 렌더러 구독부(`App.tsx`의
`onOpenDirectory`)는 한 글자도 안 고쳤다. 갈라진 것은 **실패 통지**뿐이고, 그것은 계약면
(`src/shared/protocol.ts`)에 **없는** 3.0 전용 셸 채널이다(`app:open-directory-failed`).
2.6.2에 대응물이 없으니 계약면 채널 수(216)는 안 움직인다 — 대신 `IPC.openDirectory`가
`missing`에서 `impl`로 넘어가 계약면 재고가 **10 → 9**가 된다.

**왜 인계가 파일인가.** 두 번째 인스턴스가 첫 인스턴스를 깨우는 통로는 등록 윈도우 메시지
브로드캐스트다(`raise_existing` — 이름에 앱 홈 해시가 있어 격리 홈끼리 안 섞인다). 그 봉투에는
`WPARAM`/`LPARAM`(정수 둘)뿐이라 **경로가 안 실린다**: 포인터는 남의 주소 공간이고
`WM_COPYDATA`는 브로드캐스트가 안 된다(대상 HWND를 알아야 하는데 우리는 모른다). 그래서 앱 홈
아래 `.pending-open-dir`에 `{path, at}`를 원자 저장하고 브로드캐스트를 뒤에 보낸다(순서가 규약).
받는 쪽은 **읽으면 지우고**(소비 1회), 15초보다 오래된 것은 버린다 — 안 그러면 한참 뒤의
평범한 재실행이 엉뚱한 폴더를 연다. 콜드 부팅은 잔해를 한 번 턴다.

**파일 인자는 부모로 올리지 않는다.** 사용자가 안 고른 자리에 조용히 착지하는 것이고,
콜드 런치(`initial_dir`)는 파일을 그냥 무시한다. 대신 카드가 "‘…’ 은(는) 파일이에요"라고
말한다 — 이제 **콜드에서도** 말한다.

#### 6.11.1 「폴더다」를 `metadata`로 물으면 Windows가 거짓말을 한다 (확인 크리틱 R1 D1)

R1의 판정은 `fs::metadata` 한 번이었다. Windows에서는 **부모를 읽을 수만 있으면 deny ACL이
걸린 폴더에도 `metadata`가 성공한다**(속성이 부모의 디렉터리 엔트리에서 온다). 그래서
`Verdict::Denied`는 **사실상 도달 불가**였고, 대신 `Ok`로 떨어져 **못 읽는 폴더가 작업
폴더가 됐다.** 화면은 사유를 말하지 않고 파일 트리는 `비어 있음`이라고 적었다 — 침묵이
아니라 **오답**이다("빈 폴더구나"로 읽힌다). 2.6.2도 같은 병이 있다(`statSync().isDirectory()`).

잣대를 「탐색기가 하려는 그 일」로 바꾼다 — 목록을 한 번 열어 본다(`read_dir`, 값은 안 읽음):

```text
                     metadata      read_dir
 못 읽는 폴더        Ok(is_dir)    Err PermissionDenied (os error 5)   ← 여기만 갈린다
 빈 폴더             Ok(is_dir)    Ok · 첫 항목 None
 보통 폴더 · C:\     Ok(is_dir)    Ok
```

**빈 폴더가 `Ok`인 것이 이 잣대의 핵심**이다: "안이 비었다"와 "안을 못 본다"를 가른다.
도달 불가 UNC는 그 앞 `metadata`에서 이미 걸러지므로 이 한 줄이 UNC 21초에 더하는 시간은 0이다.

#### 6.11.2 인계는 **듣는 사람이 설 때까지** 안 걷는다 (D2)

R1은 raise 신호를 받자마자 인계를 소비했다. 기동 후 0.3~0.8초 창에서는 렌더러가 아직
`listen()` 전이라(§3.3) 방출이 통째로 버려졌고, 폴더는 N3이 없애려던 그 모양 그대로
사라졌다. 게다가 **더 이른 창**(+30ms)에서는 raise 리스너 자체가 아직 안 붙어 브로드캐스트가
유실됐는데, 그때 남은 인계 파일이 15초 TTL 안의 **인자 없는 재실행**에 소비되어 창이
엉뚱한 폴더로 끌려갔다(대조군에는 인계 파일이라는 물건 자체가 없어 불가능한 **새 거동**이었다).

두 가지로 닫는다.

| 무엇 | 어디 |
|---|---|
| 렌더러가 **듣기 시작했다**는 신호 — 그 전에는 인계를 **남겨 둔다** | `open_dir::RENDERER_READY` ← `app:get-initial-dir` 도착 |
| 남겨 둔 인계를 **첫 조회 때 걷는다** — 늦게라도 착지한다 | `open_dir::initial_dir` |

`app:get-initial-dir`가 신호인 이유: 렌더러는 하이드레이션 뒤에 그것을 묻고, 구독 둘
(`onOpenDirectory`·`onOpenDirectoryFailed`)은 **마운트 이펙트**라 같은 브리지로 그보다
**먼저** 등록 요청을 보냈다. 브리지가 FIFO라 이 신호가 켜졌으면 방출은 반드시 닿는다.
그리고 그 조회 자체는 **방출이 아니라 응답**이라 §3.3의 공백을 아예 안 밟는다 — R1이
"콜드에서 카드를 못 띄우는 이유"로 적었던 벽이 여기서 없어진다.

#### 6.11.3 봉투의 **한 비트** — 인자 없는 재실행은 인계를 안 걷는다 (D2)

`WPARAM`에 경로는 못 실어도 **"인계를 남겼다"는 1비트는 실린다.** 두 번째 인스턴스가
`stash_from_args()`의 결과를 그대로 `raise_existing(with_handoff)`에 넘기고, 수신부는
`WPARAM == 1`일 때만 `deliver_pending`을 부른다. 「인자 없는 두 번째 실행 = 그냥 raise만」이
이 한 비트로 규약이 된다.

#### 6.11.4 남은 비대칭 (정직하게 — R1의 「하나」는 사실이 아니었다)

R1은 여기에 「남은 비대칭 **하나**(콜드 침묵)」라고 적었다. 확인 크리틱 R1이 최소 셋임을
보였고(콜드 침묵 · 못 읽는 폴더 · 부팅 창), 그 셋은 위에서 닫혔다. 지금 남은 것은 하나다.

- **겹친 두 번의 「…으로 열기」**(A 직후 B)에서 **앞의 것은 인계가 덮여 사라진다.**
  2.6.2(Electron `second-instance`)는 둘 다 순서대로 적용하지만 **끝 상태는 같은 B**라
  사용자가 보는 결과는 같다. 인계를 큐로 만들면 A가 잠깐 스쳤다 B로 바뀌는 깜빡임이
  생길 뿐이라 **일부러 안 고친다**.

곁가지로 갈린 것 둘(둘 다 콜드 쪽이 웜에 맞춰진 것이다):

- 콜드의 **상대 경로** 인자가 이제 절대 경로로 다듬어진 뒤 착지한다(웜은 R1부터 그랬다).
- 콜드에 **도달 불가 UNC** 인자가 오면 카드가 21초 뒤에 뜬다(`is_dir()` 한 번의 값이다).
  R1까지 이 21초는 async 워커에서 잤다 — 그동안 **모든 창의 IPC가 굶었다**. 이제
  `app:get-initial-dir`도 `app:open-directory`와 같은 블로킹 풀에서 돈다.
