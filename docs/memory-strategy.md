# 3.0 메모리 전략 — "Tauri니까 가볍다"는 거짓이다

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
