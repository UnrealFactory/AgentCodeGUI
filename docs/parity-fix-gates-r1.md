# GATES R1 — 성능 합격선 확정 + 2.6.2 분모 재측정

> 사용자 결정(2026-08-31): **메모리 게이트는 「LSP 제외」 잣대로 확정 · 설치 게이트 0.10 → 0.25 ·
> 확정 전에 2.6.2 분모를 한 번 다시 잰다.**
> 여는 미결: `docs/decisions-3.0.md` §1.6-B(분모 재측정 규약) · §1.4-b 이관분(분모의 LSP 상태 미확인) ·
> §1.5(합격선 제안 → 확정)
> 대상: `bench/ratios.mjs` · `bench/multi.mjs` · `docs/decisions-3.0.md` 삽입 블록 2개
> 실측: `bench/results/multi-electron-2.6.2-gates.json` ·
> `bench/results/multi-tauri-3.0.0-default-gates-dist.json` · `bench/results/ratios-gates-r1.json`

---

## 0. 한 줄

**확정하려고 분모를 재보니 확정의 근거가 무너졌다.** 「2.6.2 팔에는 LSP가 없다」는 세 라운드를
떠돌던 전제가 **거짓**이었다 — 2.6.2도 TS 서버 둘을 처음부터 지고 있었고, 안 보였던 이유는
헬퍼 분류기가 **프로세스 이름**을 봤기 때문이다(2.6.2는 서버를 `electron.exe`로 띄운다).
분류를 **명령줄** 기반으로 고치고 같은 세션에서 다시 재니 **분자는 안 움직였고(450.5 → 454.5MB)
분모가 200MB 넘게 내려왔다(718.6 → 512.9MB).** 그 결과 **G1·G3가 미달로 뒤집힌다.**

승인받은 대로 배선은 그대로 했다(잣대 = LSP 제외 · `footprint` 0.25). **판정만 정직하게 붉다.**
그리고 그 붉음이 진짜 성능 회귀가 아니라 **잣대의 성질**일 수 있다는 증거도 §4에 같이 적었다.

---

## 1. 결함 — 셋을 찾았고 셋 다 고쳤다

### 1.1 ★ 헬퍼 분류가 이름 기반이라 2.6.2를 **구조적으로** 못 셌다

`bench/ratios.mjs`의 판정기는 이랬다:

```js
const HELPER = /^(node|conhost|python|pyright|clangd|Microsoft\.CodeAnalysis)/i
```

**2.6.2는 TS·Python 서버를 `electron.exe`로 띄운다** — `ELECTRON_RUN_AS_NODE=1`
(`src/main/lsp/manager.ts:788`). 이 정규식에 걸릴 수가 없다. 그래서 표에 찍히던
**「2.6.2 헬퍼 0」은 측정이 아니라 분류 산물**이었다.

LSPDIST R1 §6.5가 이것을 발견했고, 그 확인 크리틱 C5가 한 발 더 나갔다 —
*「G1은 가장 둔감한 수가 아니라 **가장 오염되기 쉬운 수**다 … 거칠게 잡아도 0.74로 제안선
0.70을 넘길 수 있다」*. **예고가 맞았다.** 실측은 0.74보다도 나쁘다(§3).

그리고 §1.4가 적어 둔 **인과 설명도 틀렸다.** 장부는
*「2.6.2도 같은 프리웜을 부르지만 서버가 **앱 홈에 설치돼 있어야** 뜨고, 벤치 격리 홈은
비어 있다」*고 했는데, 코드는 그렇지 않다:

| 무엇이 | 2.6.2 | 근거 |
|---|---|---|
| TS·Python 서버 경로 | `app.getAppPath()/node_modules/…` — **설치 불필요** | `src/main/lsp/manager.ts:773-785` |
| 실행 파일 | `process.execPath` + `ELECTRON_RUN_AS_NODE=1` | `manager.ts:788-791` |
| 앱 홈 설치를 타는 것 | **C#·C++·Verse뿐** | `src/main/lsp/install.ts:19,116-120` |

벤치는 2.6.2를 레포에서 띄운다(`bench/lib.mjs:403`) → `getAppPath()` = 레포 →
레포의 `node_modules/typescript-language-server`를 문다. **처음부터 떠 있었다.**

> 이건 벤치가 만든 상태도 아니다. 설치본에서는 같은 함수가
> `app.asar.unpacked/node_modules`를 문다(`asarUnpack: ["node_modules/**"]`) — **같은 자리다.**
> 즉 레포 실행은 2.6.2의 **배포 상태를 그대로 재현**한다.

### 1.2 감수와 피감수가 **다른 순간**의 값이었다

「LSP 제외」는 *(정착 직후 `summary`) − (**주행 맨 끝** `procDetail`의 헬퍼 합)* 이었다.
§1.6-A (c″)가 *「정공법은 `summary`와 같은 순간의 역할별 표본을 남기는 것이고, 그건 하네스
숙제다」*라고 적어 둔 자리다. **게이트를 그 뺄셈 위에 세우는 라운드라 그 숙제를 갚았다.**

### 1.3 FPS 단계가 죽으면 **주행 3회가 통째로 버려졌다**

2.6.2 팔에서 `Input.dispatchMouseEvent`가 20초 타임아웃으로 죽는 일이 잦다
(이 라운드 실측: **다섯 번 중 네 번**). 메모리 표본은 그 **앞에서** 이미 다 찍혔는데
예외 하나가 `runOnce`를 깨서 **결과 파일이 아예 안 써졌다.** 분모를 못 재던 진짜 원인이다.

**내 변경 탓이 아니라는 것은 대조로 못 박았다**: `git archive HEAD`로 푼 격리 트리에서
**손대지 않은 HEAD의 `bench/multi.mjs`**를 그대로 돌려도 같은 자리에서 죽는다(주행 2/3 ·
`target-gates/tree/bench/results/ctl-electron.json` 자리에서 확인).

---

## 2. 처방

| 파일 | 무엇을 |
|---|---|
| `bench/multi.mjs` | `procSample()` 신설 — 프로세스 표본에 **`cmdline`·`ppid`·`role`**을 싣는다(`--no-cmdline`으로 끔). 표본을 **세 순간**에 남긴다(`procDetailIdle` / `procDetailWindows` / 주행 끝 `procDetail`). FPS 단계를 `try/catch`로 감싸 `fpsError`·`summary.fpsErrorRuns`로 남기고 **주행을 살린다** |
| `bench/ratios.mjs` | `lspSplit(j, phase)` — **명령줄**로 서버를 고르고 **부모-자식으로 `conhost`를 붙인다.** 옛 파일(= `cmdline` 없음)은 이름 분류로 떨어지고 `mode: 'name(legacy)'`로 **산출물에 자백한다.** `G.footprint` 0.10 → **0.25**. 메모리 게이트를 **LSP 제외 행에만** 걸고 「있는 그대로」는 전부 `gate: null`로 내렸다. `proposedGates` → `gates`(★확정) |

값과 분류를 **다른 순간에서 뽑지 않는다**: WS/Private은 `procTreeMem` 한 번의 스냅샷이고,
두 번째 질의는 **분류에 쓸 문자열만** 가져온다(PID는 그 사이 정체가 안 바뀐다).

분류에 무엇을 헬퍼라 불렀는지는 `lspSplitGates.*.hits`에 **명령줄 그대로** 남는다 —
분류가 결론을 만드는 자리라 감사 가능해야 한다.

> **`node_modules`를 키로 쓰면 안 된다.** 레포에서 띄운 2.6.2는 **모든** 프로세스의 argv[0]이
> `…\node_modules\electron\dist\electron.exe`이고(렌더러·GPU·크래시패드 전부), 엔진 CLI도
> `…\engines\<v>\node_modules\…\claude.exe`다. 서버 **스크립트 이름**으로만 문다.

---

## 3. 실측 — 같은 세션 두 팔 · 각 3회

- **3.0**: `git archive HEAD`(`01d6210`) → `target-gates/tree`(`node_modules`는 정션) →
  `npm run app:build` + `CARGO_TARGET_DIR=target-gates/target cargo build --release
  --features custom-protocol`. exe sha256 **`9144b43acd89d197…`**(7,074,304 B).
  배포 모사 `%LOCALAPPDATA%\ccg-gates-r1` = `AgentCodeGUI3.exe` + **`node.exe`**(핀 v24.20.0 ·
  sha256·크기 재검증) + `tauri.conf.json`의 `bundle.resources` 그대로 = **5,428 파일 · 139.3MB**.
  **조상 사슬에 `node_modules` 없음을 확인**했다. `launchCwd` = 그 자리.
- **2.6.2**: 레포 `out/` + `node_modules/electron/dist/electron.exe`(= `app.asar.unpacked`와
  같은 모듈 자리 · §1.1).
- 픽스처·정착(20초)·반복(3회 중앙값)·포트 대역(11060~11069)은 두 팔이 같다.

### 3.1 ★ 분모에 LSP가 있었다 — 이번에 실제로 셌다

| | 헬퍼 수 | 헬퍼 WS | 헬퍼 Private | 무엇이 떴나 |
|---|---:|---:|---:|---|
| **2.6.2** | **2** | **208.3** | **111.3** | `electron.exe …\typescript-language-server\lib\cli.mjs --stdio` · `electron.exe --max-old-space-size=3072 …\typescript\lib\tsserver.js` |
| **3.0** | **3** | **115.5** | **101.6** | `node.exe …\typescript-language-server\lib\cli.mjs --stdio` · `node.exe … tsserver.js` · 그 `conhost.exe` |

회차 산포가 좁다 — 2.6.2 WS `207.9 / 208.3 / 210.5`, 3.0 WS `114.9 / 115.5 / 115.6`.
**「분모의 LSP 상태 미확인」(§1.4-b 이관분)은 이것으로 닫힌다.** 답은 **「있었다」**이다.

3.0 쪽 `115.5 / 101.6`은 PATCHNOTES R1의 배포 경로 실측(`115.1 / 101.6`)과 같은 자리다 —
두 세션이 서로를 검증한다.

### 3.2 분모 자체는 재현된다

2.6.2 유휴 **WS 721.2 / Private 507.4 / 7프로세스**. 박제값(712.8 / 505.3 / 7) 대비
**+1.2% / +0.4%**다. 즉 **이 세션의 눈금은 옛 눈금과 같고**, 아래 변화를 「기계가 달라서」로
설명할 수 없다.

### 3.3 확정 게이트 판정 (전부 `ratios-gates-r1.json`이 낸 값 — 손으로 적은 칸 없음)

| 지표 | 3.0 | 2.6.2 | 비율 | 합격선 | 여유 | 판정 |
|---|---:|---:|---:|---:|---:|---|
| 유휴 WS — LSP 제외 | 454.5 | 512.9 | **0.886** | 0.7 | -26.6% | **미달** |
| 유휴 Private — LSP 제외 | 249.5 | 396.1 | **0.63** | 0.6 | -5.0% | **미달** |
| +창2 WS — LSP 제외 | 503 | 737.8 | **0.682** | 0.7 | 2.6% | **통과** |
| 창 1개 추가 비용(WS) | 24.1 | 109.5 | **0.22** | 0.3 | 26.6% | **통과** |
| 유휴 프로세스 수 | 8 | 7 | **1.143** | 1 | -14.3% | **미달** |

참고 행(게이트 아님 · 결정 ①):

| 지표 | 3.0 | 2.6.2 | 비율 |
|---|---:|---:|---:|
| 유휴 WS(있는 그대로) | 570 | 721.2 | **0.79** |
| 유휴 Private(있는 그대로) | 351.1 | 507.4 | **0.692** |
| +창2 WS(있는 그대로) | 618.4 | 940.3 | **0.658** |
| LSP 헬퍼 몫 WS | 115.5 | 208.3 | **0.554** |
| LSP 헬퍼 몫 Private | 101.6 | 111.3 | **0.913** |

나머지 확정 게이트는 **전부 통과**다 — 창당 비용 `0.22`(여유 26.6%) · 콜드 `rootMs`
`0.825`/`0.786` · 콜드 앱 몫 `0.611` · 풋프린트 3행(단, **§5.2의 단서**).

---

## 4. 무엇이 뒤집혔나 — 그리고 뒤집힌 것이 **성능인가 잣대인가**

### 4.1 분자는 안 움직였다. 분모가 틀렸었다

| | 옛 값(§1.4-b) | 오늘 | 차 |
|---|---:|---:|---:|
| 3.0 배포 경로 · LSP 제외 유휴 WS | 450.5 | **454.5** | +0.9% |
| 2.6.2 분모 · LSP 제외 유휴 WS | ~~718.6~~(LSP 포함이었다) | **512.9** | **−205.7** |
| → 비율(G1) | 0.627 | **0.886** | **미달로 뒤집힘** |

**3.0은 나빠지지 않았다.** 0.627이 좋아 보였던 것은 *LSP 없는 3.0*을
*LSP를 몰래 진 2.6.2*와 나눴기 때문이다.

### 4.2 ★ 그런데 이 잣대는 분모에서 **부풀린 값**을 뺀다

두 앱의 LSP 몫이 축에 따라 다른 이야기를 한다:

```
WS      : 2.6.2 208.3  vs  3.0 115.5   → 2.6.2가 1.80배
Private : 2.6.2 111.3  vs  3.0 101.6   → 거의 같다(1.10배)
```

WS는 프로세스마다 **공유 이미지 페이지를 다시 센다.** 2.6.2는 서버를 **Chromium 바이너리
(`electron.exe`)로** 띄우므로 서버 하나가 지고 오는 공유 이미지가 크고, 그게 WS 열에
그대로 얹힌다. Private(= 그 프로세스만의 실제 사유 메모리)에서는 두 앱이 사실상 같다.

**그래서 「LSP 제외 WS」는 분모에서 100MB 가까이 과하게 빼는 잣대**이고, 그 뺄셈이
**3.0의 진짜 승점 — 같은 기능을 절반 값(115.5 대 208.3)에 지고 간다 — 을 표에서 지운다.**
「있는 그대로」 WS가 `0.79`인데 「LSP 제외」가 `0.886`으로 **더 나쁜** 이유가 이것이다.

승인받은 결정은 「LSP 제외」이므로 **그대로 배선했고 판정도 그대로 붉다.**
다만 위 사실을 표 옆에 같이 둔다 — 그게 이 장부의 규약이다.

### 4.3 프로세스 수 게이트도 뒤집혔다(1.143)

3.0 = 앱 5 + `node` 2 + **`conhost` 1** = 8, 2.6.2 = 앱 5 + `electron` 2 = 7.
차이는 **`conhost` 하나**다 — 3.0은 서버를 콘솔 서브시스템 실행 파일(`node.exe`)로 띄우고
2.6.2는 GUI 서브시스템(`electron.exe`)으로 띄우기 때문이다. 그 `conhost`는 WS 7.6 / Priv 1.2다.

---

## 5. 남은 것 — 정직하게

### 5.1 ★ 잣대를 다시 물어야 한다(리드 결정 필요)

§4.2 때문이다. 갈래 셋: ① 그대로 두고 미달을 받는다 · ② 메모리 게이트를 **Private 축**으로
옮긴다(공유 페이지에 안 흔들린다 — 오늘 값은 LSP 제외 `0.63` / 있는 그대로 `0.692`) ·
③ 「LSP 제외」를 버리고 **있는 그대로**로 간다(WS `0.79` / Priv `0.692`).
**어느 갈래를 골라도 오늘 값은 0.70/0.60 선을 넘는다** — 즉 선 자체를 다시 볼지도 같이
정해야 한다. 이 라운드는 **선을 손대지 않았다**(승인 범위 밖).

### 5.2 ★ `footprint.json`이 낡았다 — 그 세 행은 LSPDIST **이전** 값이다

표의 풋프린트 3행(0.015 / 0.009 / 0.009 · 여유 94~96%)은 설치기 **2.4MB** 시절의
`bench/results/footprint.json`을 읽은 것이다. 오늘의 실제 값은
설치기 **30.9 ÷ 157.5 = 약 0.196**, 설치 폴더 **139.3 ÷ 633.7 = 약 0.220**이다
(앞은 PATCHNOTES R1 실측, 뒤는 이 라운드의 배포 모사 실측 · **표에는 안 넣었다** —
`ratios.mjs`에 손으로 적는 것을 금지한 규약 때문이다).
**0.25 게이트의 진짜 여유는 12~22%이지 94%가 아니다.** `footprint.json` 재측정은 NSIS
설치기를 다시 구워야 하는 일이라 이 조각의 경계 밖이다 — **다음 라운드 숙제.**

### 5.3 USERPROFILE 격리는 시도했고 **측정을 깨뜨렸다**

과제가 지시한 대로 2.6.2 팔의 `USERPROFILE`을 격리 디렉터리로 돌려 봤다.
**3.0 팔에서 WebView2가 CDP 리스너를 안 연다** — `--remote-debugging-port=N`은 자식
명령줄에 정확히 실리는데 포트가 **listen 상태가 되지 않는다**(재현 2/2 · 같은 exe를
`USERPROFILE` 없이 띄우면 즉시 열린다). 그래서 **격리를 걷었다.**
지금 보호는 이렇게 선다: 앱의 **쓰기**는 전부 `CCG_HOME`(격리)로 가고, 실홈은
`bench/fixture.mjs`가 **읽기만** 한다(엔진 정션 + `accounts.json`/`Local State` 복사) —
이것은 모든 기존 분모 주행과 **같은 프로토콜**이라 비교 가능성도 이쪽이 지켜진다.
**사용자 실앱은 건드리지 않았다**(이름 기반 kill 없음 · 내가 스폰한 PID만 정리 · 주행 뒤
실앱 6프로세스 생존 확인).

### 5.4 두 팔이 **엄밀히 동시**는 아니다

3.0 팔과 2.6.2 팔은 같은 앉은자리(같은 세션·재부팅 없음·다른 벤치 동시 주행 없음)에서
쟀지만 **약 40분 간격**이다(그 사이 §1.3 결함으로 2.6.2 팔이 세 번 죽었다).
눈금이 같다는 근거는 §3.2다(분모가 박제값을 +1.2% 안에서 재현).

### 5.5 2.6.2 FPS 플레이크의 **원인은 못 찾았다**

`try/catch`로 **주행을 살렸을 뿐** 원인은 안 봤다. 마지막 주행은 3/3 모두 성공해
(`fpsErrorRuns: 0`) 이번 표의 FPS 칸은 온전하지만, 이 플레이크는 남아 있다.
3.0 팔에서는 한 번도 안 났다.

### 5.6 옛 결과 파일의 「LSP 제외」 행은 **여전히 틀린 분모**다

`[R28j·LSP제외]` 세 행(0.643 / 0.508 / 0.528 · 전부 통과)은 `cmdline`이 없는 옛 파일이라
이름 분류로 떨어진다. **일부러 지우지 않고 남겼고**, 산출물과 표의 `note`에
`분류=name(legacy)(2.6.2 헬퍼 0개 — 이름 분류의 과소계수)`를 **기계가 붙이게** 했다.
회귀 기록으로만 읽어라 — **판정은 `★★[GATES]` 블록이 한다.**

---

## 6. 재현

```bash
# ① 3.0 exe — HEAD 격리 트리(워크트리의 미커밋 변경을 안 섞는다)
git archive HEAD | tar -x -C target-gates/tree
powershell -NoProfile -Command "New-Item -ItemType Junction -Path '…\tree\node_modules' -Target '…\node_modules'"
cp src-tauri/lsp-runtime/node.exe target-gates/tree/src-tauri/lsp-runtime/   # 없으면 `node scripts/tauri-build.mjs stage`
cd target-gates/tree && npm run app:build
cd src-tauri && CARGO_TARGET_DIR=…/target-gates/target cargo build --release --features custom-protocol

# ② 배포 모사 = exe + node.exe + tauri.conf.json의 bundle.resources 그대로 (%LOCALAPPDATA%\ccg-gates-r1)
#    조상 사슬에 node_modules가 없음을 반드시 확인할 것

# ③ 같은 세션 두 팔 (기준 파일 무접촉 — --out 필수 · 포트 11060~11069)
node bench/multi.mjs electron --repeats=3 --tag=gates --port=11067 \
     --out=multi-electron-2.6.2-gates.json
node bench/multi.mjs tauri --repeats=3 --tag=gates --port=11064 \
     --exe="$SIM\AgentCodeGUI3.exe" --cwd="$SIM" \
     --out=multi-tauri-3.0.0-default-gates-dist.json

# ④ 판정
node bench/ratios.mjs --json=bench/results/ratios-gates-r1.json
```

기준 결과 파일(`multi-tauri-3.0.0-default-r28jdecr1-*.json` ·
`multi-electron-2.6.2-default-r28jdecr1.json` · `-lspdist*` · `-patchnotes-*` ·
`footprint.json` · `boot-breakdown.json`)은 **하나도 안 덮었다.**
