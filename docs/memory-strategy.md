# 3.0 메모리 전략 — "Tauri니까 가볍다"는 거짓이다

> **주 게이트는 멀티채팅이다** (사용자 지시: "여러 개 켰을 때가 항상 문제").
> 단일 채팅은 어느 런타임이든 여유롭게 통과해 변별력이 없다. 아래 단일 수치는
> 참고이고, **판정은 `bench/multi.mjs`가 한다.**

## 멀티채팅 기준 실측 (2.6.2, 패널 4개 × 120항목)

| 상태 | WS | Private | 프로세스 | 3.0 목표(≤0.5) |
|---|---|---|---|---|
| 패널 4개 유휴 | **712.8 MB** | 505.3 MB | 7 | ≤356 / ≤253 |
| + 추가 채팅 창 2개 | **934.1 MB** | 556.0 MB | 9 | ≤467 / ≤278 |
| 4패널 동시 스트리밍 직후 | **1161 MB** (UI 몫 1049.7) | 772.9 | 10 | ≤580 (UI ≤525) |
| 창 1개 추가 비용 | **110.7 MB / +1 프로세스** | | | ≪110 |
| 패널 스크롤 FPS (나머지 패널 살아있음) | 60 fps · 드랍 0% | | | ≥60 · 0% |
| 4패널 동시 스트리밍 FPS | 60 fps · 드랍 0% | | | ≥60 · 0% |

**창 하나 열 때마다 110MB가 붙는다** — 사용자가 여러 개 켰을 때 느려진다고 말한
정확한 자리다. 3.0이 여기서 이기지 못하면 이겼다고 할 수 없다.

측정은 앱 몫과 엔진(CLI) 몫을 PID 차집합으로 분리한다 — 엔진 프로세스 비용은 두
앱이 똑같이 부담하는 외부 비용이라, 총합만 보면 절반이 구조적으로 불가능해진다.


## M1 R1 실측이 말해준 것

| | Electron 2.6.2 | Tauri M1 R1 | 판정 |
|---|---|---|---|
| 프로세스 수 | 5 | **7** | 악화 |
| WS 합 | 428.1 MB | **415.6 MB** | −3% (목표 −50%) |
| Private 합 | 341.4 MB | **351.4 MB** | +3% (악화) |

프로세스별로 뜯으면 승패가 갈린 자리가 정확히 보인다.

| 역할 | Electron | Tauri | 차이 |
|---|---|---|---|
| 호스트(메인) | electron.exe **WS 113.8 / Priv 81.2** | agentcodegui.exe **WS 29 / Priv 10.7** | **−85 MB WS** ✅ |
| 웹 런타임 전체 | Chromium 4개 합 **WS 314.3** | WebView2 6개 합 **WS 386.6** | **+72 MB WS** ❌ |

**결론: Rust 호스트로 바꿔 번 85MB를, WebView2가 72MB 더 써서 도로 반납했다.**
Node+Chromium을 들어낸 이득은 실재하지만(호스트가 1/4로 줄었다), WebView2는
Electron보다 프로세스를 더 쪼개고 더 쓴다. 여기를 이기지 못하면 3.0의 존재 이유가
사라진다 — 기능 파리티만 맞추고 성능은 못 이기는 재작성은 실패다.

## R3 실측 결과 — 아래 "공격 순서"는 절반이 죽은 길이었다 (2026-08-22)

전문은 `docs/m1-report-r3.md`. 다음 사람이 같은 길을 다시 파지 않도록 결론만 여기 박는다.

### ★ 분모가 우리 앱이 아니다 — **다만 R3가 적은 8.4MB는 무효였다(R4 정정)**

R3는 `bench/gpuprobe.mjs`로 4패널 앱의 `#root`를 `innerHTML=''`로 비우고 "우리 UI 전부의
값 = WS 8.4MB"라고 적었다. **그 방법이 틀렸다** — `innerHTML=''`은 DOM을 화면에서 뗄 뿐
해제하지 않는다(React 파이버 트리가 노드를 붙들고 있다). R4에서 하네스를 고쳐
`about:blank`로 문서를 통째로 언로드하고, 단계마다 노드·리스너·JS힙을 **판정 조건으로**
찍게 했다(`gpu-css-probe.json`의 `release` / `appShare`):

| 단계 | 총 WS | 총 Priv | JS 힙 | DOM 노드 | JS 리스너 | 해제? |
|---|---|---|---|---|---|---|
| 4패널 × 120항목 | 436.6 | 226.5 | 8.3 | 8,486 | 641 | — |
| `#root` `innerHTML=''` (R3가 쓴 방법) | 412.3 | 210.6 | **8.3** | **8,315** | **641** | **✗ 무효** |
| `about:blank`(진짜 언로드) | **391.0** | **188.2** | 0.9 | 4 | 3 | ✓ |

**우리 UI 전부의 값 = WS 45.6MB / Priv 38.3MB** (크리틱 독립 측정 43.3 / 34.0).
R3 수치의 5배다.

→ 그래도 **렌더러 다이어트만으로는 목표에 못 닿는다**(격차 100MB의 20% 이하).
"죽은 길"이 아니라 **마지막 20MB용 조각**으로 격하해 둔다. 다이어트로 되찾을 수 있는
최대치가 43~46MB이고 현실적으로는 10~20MB다.

### 레버는 두 개만 살아남았다

| 채택 | 실측 |
|---|---|
| `--process-per-site` | **창당 114.7MB / +2프로세스 → 14.8MB / +0프로세스**. 3.0이 Electron(112MB·+2)을 확실히 이기는 유일한 자리 |
| `--in-process-gpu` | 멀티 유휴 Priv 337.4 → 251.6MB, 프로세스 7 → 6, 60fps 유지, 하드웨어 GPU 유지 |

기각 15개(전부 실측): `SpareRendererForSitePerProcess`·`AudioServiceOutOfProcess`·
`Translate`·`OptimizationHints`·`BackForwardCache`·`MediaRouter`·
`StorageServiceOutOfProcess`·`--disable-breakpad`·`--single-process-network`·
`--renderer-process-limit=1`·부팅 잡업 스위치 7종 — 프로세스 수가 하나도 안 줄었다.
`--use-angle=gl`/`--disable-gpu`는 Priv를 가장 크게 줄이지만 WebGL renderer가
`Microsoft Basic Render Driver`로 바뀐다(= 소프트웨어 래스터).

> ### ⚠ 기각 사유 한 줄은 **틀렸다** (R3 크리틱 §5.1 · R4 정정)
> R3는 "프로세스 수가 안 줄었다 = WebView2가 그 스위치를 무시한다"고 적었다.
> **그 추론이 한 번 틀렸다.** `NetworkServiceInProcess`가 무효로 보인 진짜 이유는
> 런타임이 무시해서가 아니라 **Chromium이 M96 무렵 feature 이름을
> `NetworkServiceInProcess2`로 바꿔서** 존재하지 않는 이름을 준 것이었다(모르는 feature
> 이름에 Chromium은 경고하지 않는다). 올바른 이름을 주면 `utility:NetworkService`가
> 통째로 사라진다 — R4 실측 `ΔWS −30.5 / ΔPriv −5.7 / **Δprocs −1**`
> (`webview-flags.json`의 `B5b-network-in-process2`).
> → **규약: 무효로 적기 전에 현행 Chromium feature 이름부터 대조할 것.** 위 기각 목록의
> `AudioServiceOutOfProcess`·`BackForwardCache` 등은 아직 이 대조를 안 거쳤다.
> (`StorageServiceOutOfProcess`는 올바른 이름으로도 안 죽는 것을 확인했다 — 진짜 무효.)

**`NetworkServiceInProcess2`(정식 이름)는 R4 시점 미채택이다.** 기여는 실재하고
(주 게이트 5회 중앙값: 유휴 WS 450.7→426.3 · Priv 248.1→241.6 · **프로세스 6→5** ·
+창2 WS 500.9→471.8) FPS도 대조군과 같거나 낫지만, 채택 판정을 한 세션에서 **대조군조차
≥60fps를 못 넘었다**(기계 부하). 재판정은 `node bench/fpsab.mjs --rounds=4 --trials=3`
한 줄이면 끝난다 — 자세한 건 `docs/m1-report-r4.md` §2.
재현 스위치: `CCG_WEBVIEW_ENABLE_FEATURES=NetworkServiceInProcess2`(재빌드 불필요).

### 남은 격차와, 그 격차를 넘는 유일한 실측 경로

유휴 WS 479.3(목표 356)이 최대 격차이고, 원인은 레버가 아니라 **WebView2 프로세스
바닥값**이다. `--single-process`만이 거기 닿는다(WS 358.8 / Priv 211.3 / 3프로세스 /
60fps / 하드웨어 GPU / 콜드 스타트도 최고). 그런데 Chromium이 "디버깅 전용"이라 못박은
스위치이고 WebView2 미지원이며, **Evergreen 런타임이라 다음 Edge 업데이트가 깨면 배포된
앱이 전부 죽는다.** 그래서 기본값이 아니라 `CCG_SINGLE_PROCESS=1` 옵트인으로 뒀다.
채택하려면 **고정 버전 WebView2 런타임**(설치 크기 +120MB)과 묶어 판단해야 한다.

### 측정 규약에서 고친 것 (숫자를 믿으려면 필요했다)

- `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`는 코드의 `AdditionalBrowserArguments`를
  **덮어쓴다**(실측). 그 변수가 세팅된 환경에서는 이 문서의 레버가 전부 무효다.
- 3군(CDP 편향)의 답: **차이가 3% 이내**라 대표값은 CDP 켠 쪽 유지. R1이 적은
  "CDP가 Priv +57MB"는 재현되지 않는다. 근거는 `bench/results/idlemem-nocdp.json`.
- 박제된 **단일 채팅** 기준값(`idlemem-electron-2.6.2.json` 428.1/341.4/5프로세스)은
  재현되지 않는다(실측 626~660MB / 7프로세스). **주 게이트인 멀티 기준값
  (712.8/505.3)은 재현된다**(730.1/502.9) — 판정 분모는 믿어도 된다.
- 레버를 하나씩 재는 스윕은 **무대가 맞아야 한다**: `--process-per-site`는 창이 하나뿐인
  스윕에서 기여 0으로 보였다. 창 비용이 걸린 레버는 `bench/multi.mjs`로 재라.

## 공격 순서 (효과 큰 것부터, 전부 측정으로 확정할 것)

### 1군 — 웹 런타임 프로세스 모델 (기대 효과 최대)
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`로 Chromium 스위치를 직접 넣는다.
- `--disable-site-isolation-trials` / `--process-per-site` — 렌더러 프로세스 통합.
  WebView2가 6개까지 쪼갠 게 지금 최대 손실원이다.
- `--renderer-process-limit=1`
- `--disable-features=…` — 쓰지 않는 서브시스템 끄기(번역·스펠체크·백그라운드
  네트워킹·동기화·확장 등). 무엇이 실제로 프로세스/메모리를 줄이는지 하나씩 측정.
- `--disable-gpu-compositing` / `--disable-gpu`: **주의 — 스크롤 FPS와 맞바꾼다.**
  메모리가 줄어도 `bench/scroll.mjs`에서 60fps·드랍 0%를 잃으면 채택 금지.
- `--js-flags="--max-old-space-size=… --lite-mode"` 계열: 힙 상한과 GC 압력.

### 2군 — 우리 쪽 렌더러 (Tauri 렌더러가 Electron보다 Priv 214 vs 169로 더 쓴다)
숫자가 뒤집힌 게 이상하다 — **같은 앱인데 우리 쪽이 더 쓴다면 빌드 설정 차이**다.
- `app/vite.config.ts`의 minify·target·sourcemap이 electron.vite.config.ts와 같은가.
  2.6.2는 minify를 켜서 2.97MB→1MB로 줄인 이력이 있다(그게 곧 힙이다).
- 부팅 시 즉시 파싱되는 코드량: FileModal 등 무거운 모듈의 lazy 분할이 이식본에서도
  살아 있는가.
- CodeMirror·highlight.js·react-markdown이 부팅 경로에서 즉시 로드되는가.

### 3군 — 측정 자체의 편향 제거
- **CDP(remote-debugging-port)가 켜진 채로 잰 수치다.** Electron·Tauri 양쪽 다
  켜져 있으니 대칭이지만, WebView2에서 이 플래그가 프로세스를 더 만들 수 있다.
  → CDP 없이(첫 가시 창 + 고정 정착) 재는 모드를 추가해 양쪽 다 재고, 두 모드의
  차이를 기록할 것. 제품 실사용은 CDP가 꺼진 쪽이다.
- 두 홈의 상태가 같아야 한다(픽스처 유무·채팅 수·엔진 정션). `bench/pair.mjs`가
  양쪽 홈을 동일 시드로 만들도록 고쳤다.

### 4군 — 구조 (위가 부족하면)
- 창을 여러 개 여는 표면(멀티 팝아웃·추가 채팅·토스트·트레이)에서 WebView2가
  창마다 프로세스를 늘리는지 확인. 2.6.2는 창이 늘어도 렌더러만 는다.
- 토스트·트레이처럼 작고 짧은 창을 WebView2 대신 네이티브로 그릴 수 있는가
  (Win32 레이어드 창). 2.6.2에서 이 둘은 각각 별도 BrowserWindow다.

## 판정 규칙

- 채택 조건: 유휴 WS·Priv 둘 다 Electron 대비 **≤0.5**, 그리고 `bench/scroll.mjs`·
  `bench/stream.mjs`에서 60fps·드랍 0% 유지. 메모리를 얻고 부드러움을 잃으면 반려.
- 모든 스위치는 **하나씩 켜고 재서** 기여도를 기록한다. 뭉뚱그린 "플래그 세트"는
  다음 사람이 되돌릴 수 없다.
- 결과는 `bench/results/webview-flags.json`에 표로 남긴다.
- 무효 판정 전에 **현행 Chromium feature 이름부터 대조한다**(위 ⚠ 상자).
- **FPS 게이트는 대조군이 같은 세션에서 기준을 넘을 때만 유효하다.** 기계가 밴드째
  내려앉은 세션에서는 어느 팔도 60fps에 못 닿아 판정이 성립하지 않는다 —
  대조군 중앙 avgFps를 먼저 보고, ≥59.0이 아니면 그 세션의 FPS 판정은 버린다
  (R4에서 실제로 이 이유로 레버 채택을 보류했다). 교대·부하 하네스는 `bench/fpsab.mjs`.
- 결과 파일에는 **어느 exe로 쟀는지**(exe mtime·SHA·gitHead)가 반드시 박혀 있어야 한다
  (`lib.mjs`의 `binInfo`/`provenance`). 없으면 그 표는 인용하지 않는다.
