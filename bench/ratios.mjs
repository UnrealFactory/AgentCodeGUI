// 성능 게이트를 **비율로** 계산한다 — R28j DECIDE의 사용자 결정을 기계로 옮긴 것.
//
//   node bench/ratios.mjs [--json=bench/results/ratios-<태그>.json]
//
// 왜 비율인가(결정의 근거는 `docs/decisions-3.0.md` §1):
//   절대치 목표(유휴 WS ≤356MB · 콜드 ≤168/211ms)는 **물리적으로 불가능하다**는 것이
//   실측으로 확정됐다. WebView2 **빈 문서**(about:blank로 통째로 언로드한 상태)가 이미
//   목표선의 98.7%를 먹고, 웹 런타임 기동만으로 199ms가 간다 — Electron도 같은 199ms다.
//   그래서 게이트를 「≤절대치」에서 「2.6.2 대비 ≤비율」로 다시 쓴다.
//
// 이 파일이 하는 일은 **산술뿐이다.** 측정은 하지 않는다 — 이미 커밋된 결과 파일을 읽어
// 비율을 다시 계산하고, 어느 파일의 어느 필드에서 왔는지를 산출물에 같이 박는다.
// 보고서에 손으로 옮겨 적은 비율이 파일과 어긋나는 사고(M1 R4 §8.1)를 막는 자리다.
//
// ★ 「앱 몫」 비율 — 총량 비율은 두 앱이 **어쩔 수 없이 지고 가는 런타임 바닥값**을
//   분자·분모에 같이 담는다. 바닥값을 빼면 「문서를 언로드하면 돌아오는 몫」이 남는다.
//   바닥값은 두 앱 모두 `bench/gpuprobe.mjs`의 6단계(`about:blank` 언로드 + DOM·리스너
//   90% 감소 검증)로 **같은 방법으로** 쟀다.
//
//   ★★ 그 수를 「우리 코드」라고 부르면 안 된다 — R28j 확인 크리틱 S2-2가 잡은 자리다.
//   같은 파일의 `byRole`을 역할별로 가르면 **문서가 붙드는 몫(renderer)만 떼었을 때
//   3.0이 두 축 다 더 많이 쓴다.** 앱 몫 Private 0.53을 만드는 것은 2.6.2의 비-렌더러
//   프로세스(browser·gpu-process)가 언로드 때 Private을 돌려주는 것이고, 그건
//   Chromium의 프로세스 구조지 우리 코드가 아니다. 그래서 이 파일이 `roleSplit`을
//   **기계로 같이 낸다** — 손으로 옮겨 적은 서술이 반대 증거를 못 가리게.
//
// ★★★ 그리고 「벤치 경로」와 「배포 경로」는 다른 것을 잰다(S2-1).
//   `crates/ccg-lsp/src/launch.rs::shipped_module()`이 node_modules를 exe 폴더와
//   프로세스 cwd에서 **위로** 훑기 때문에, exe가 레포 안(`target-*/release`)이면
//   LSP 헬퍼가 뜨고 배포 위치(`%LOCALAPPDATA%\AgentCodeGUI3`, 파일 2개)면 안 뜬다.
//   `--cwd`/`--exe`로 두 자리를 다 잰 뒤 `paths` 블록에 나란히 싣는다.
import fs from 'node:fs'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '..')
const R = (f) => path.join(REPO, 'bench', 'results', f)
const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=')
const OUT = arg('json', '')

const read = (f) => {
  const p = R(f)
  if (!fs.existsSync(p)) return null
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100)
const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000)
const div = (a, b) => (a == null || b == null || !b ? null : a / b)

// ── 원천 파일 ────────────────────────────────────────────────────────────────
const SRC = {
  e26Multi: 'multi-electron-2.6.2.json',                 // 2.6.2 주 게이트(박제)
  t30MultiR4: 'critic-r4-multi-default.json',            // 3.0 주 게이트(파리티 감사가 인용한 값)
  t30MultiAlt: 'multi-tauri-3.0.0-default.json',         // ★ 같은 지표의 **대안 출처**(S3-2) — 더 새 exe·깨끗한 트리
  t30MultiNew: 'multi-tauri-3.0.0-default-r28jdec.json', // 3.0 주 게이트(R28j 재측정)
  e26MultiNew: 'multi-electron-2.6.2-default-r28jdec.json', // 2.6.2 주 게이트(R28j 재측정 · 같은 세션)
  // ★ R28j 수정 R1 — 같은 exe를 **두 자리에서** 잰 짝(S2-1의 실측)
  t30MultiDist: 'multi-tauri-3.0.0-default-r28jdecr1-dist.json',   // 배포 위치(레포 밖 · node_modules 조상 없음)
  t30MultiBench: 'multi-tauri-3.0.0-default-r28jdecr1-bench.json', // 벤치 위치(레포 안 target-*/release)
  // ★ 대조군 — 배포 위치 그대로에 `CCG_LSP_MODULES=<레포>`만 얹는다. 헬퍼가 돌아오면
  //   원인이 「위치」가 아니라 **node_modules 해석**이라는 것이 못 박힌다(1회).
  t30MultiDistMod: 'multi-tauri-3.0.0-default-r28jdecr1-distmod.json',
  e26MultiR1: 'multi-electron-2.6.2-default-r28jdecr1.json',       // 2.6.2 분모(같은 세션)
  // ★★ GATES R1(2026-08-31) — **확정 게이트가 읽는 짝**. 같은 세션 두 팔 · 각 3회 ·
  //   분류는 명령줄 기반(`cmdline`) · 헬퍼 표본은 `summary`와 **같은 순간**(procDetailIdle).
  //   3.0 = HEAD 격리 트리에서 구운 exe를 `%LOCALAPPDATA%` 배포 모사(exe + node.exe +
  //   node_modules 5,428파일)에 두고 실행. 2.6.2 = 레포 `out/` + `node_modules/electron`.
  e26MultiGates: 'multi-electron-2.6.2-gates.json',
  t30MultiGates: 'multi-tauri-3.0.0-default-gates-dist.json',
  // ★★★ GATES R2(2026-09-01) — **최종 확정 게이트가 읽는 짝**. R1 이후 착지한 세 갈래
  //   (LSPIDLE 온디맨드·FPS144·SLUG)를 담은 exe를 같은 방식의 배포 모사에서 쟀다.
  //   R1과 달라진 것 하나: **유휴에 언어 서버가 한 톨도 없다**(온디맨드라 파일을 안 열면
  //   애초에 안 뜬다) → 「있는 그대로」가 곧 앱 몫이 됐고, 그래서 주 게이트가 그 행으로 옮겨졌다.
  t30MultiGates2: 'multi-tauri-3.0.0-default-gates2-dist.json',
  coldGates2: 'coldstart-gates2-dist.json',       // 같은 exe·같은 배포 모사의 콜드
  idleGates2: 'idlemem-tauri-3.0.0-gates2.json',  // 단일 채팅 유휴(참고 — 변별력이 없는 눈금)
  e26Idle: 'idlemem-electron-2.6.2.json',         // 그 분모(박제)
  footGates2: 'footprint-gates2.json',            // 배포 모사 설치 폴더 실측(§5.2 숙제 해소)
  t30FloorR4: 'critic-r4-gpuprobe.json',                 // 3.0 빈 문서 바닥값(R4 크리틱)
  t30Floor: 'gpu-css-probe-r28j-dec-tauri.json',         // 3.0 빈 문서 바닥값(R28j)
  e26Floor: 'gpu-css-probe-r28j-dec-electron.json',      // 2.6.2 빈 문서 바닥값(R28j · 최초 측정)
  coldE26: 'coldstart-electron-2.6.2.json',              // 2.6.2 콜드(박제 — 인수인계 336/422의 출처)
  coldPair: 'pair-coldstart.json',                       // 교대 A-B-A-B 콜드(같은 부하)
  boot: 'boot-breakdown.json',                           // 웹 런타임 기동 바닥값(spawn→timeOrigin)
  foot: 'footprint.json'                                 // 설치 풋프린트
}
const F = Object.fromEntries(Object.entries(SRC).map(([k, v]) => [k, read(v)]))

const rows = []
// ★★ GATES R2 — `alt`는 **두 번째 분모**다. R2의 분자는 오늘(2026-09-01) 쟀고 분모는
//   GATES R1 세션(2026-08-31)의 2.6.2 팔을 재사용한다(§1.6-B ②의 「같은 세션 두 팔」을
//   엄밀히는 못 지킨다 — 리드 지시로 분모를 다시 재지 않았다). 그 흠을 말로 덮는 대신
//   **박제 분모(`multi-electron-2.6.2.json`)로 같은 판정을 한 번 더 돌린다.**
//   두 분모에서 다 통과하면 「분모가 그 사이 움직였을 수 있다」는 의심이 판정을 못 뒤집는다.
//   두 분모의 차이 자체도 기계가 낸다(`denomCheck`) — 손으로 적는 칸이 없다.
const add = (metric, tauri, electron, { lower = true, from, note, gate, alt } = {}) => {
  const ratio = div(tauri, electron)
  // ★ 여유(headroom)는 **기계가 낸다.** 「G1·G3·G4는 오늘 값에 8~15% 여유」라고 손으로
  //   적었다가 G4가 실제로 2.3%였던 사고(확인 크리틱 S3-1)를 구조적으로 막는 자리다.
  // `gate === 0`(절대 0 게이트)에서는 여유가 정의되지 않는다 — 0으로 나누면 NaN이 표에 찍힌다.
  const hr = (rr) => (gate == null || rr == null || typeof gate !== 'number' || gate === 0 ? null : r3(((gate - rr) / gate) * 100))
  const ok = (rr) => (gate == null || typeof gate !== 'number' || rr == null ? null : (lower ? rr <= gate : rr >= gate))
  const altRatio = alt ? div(tauri, alt.electron) : null
  rows.push({
    metric, tauri: r2(tauri), electron: r2(electron), ratio: r3(ratio), gate,
    pass: ok(ratio), headroomPct: hr(ratio), from, note,
    ...(alt ? { alt: { label: alt.label, electron: r2(alt.electron), ratio: r3(altRatio), pass: ok(altRatio), headroomPct: hr(altRatio), from: alt.from } } : {})
  })
}

// ── 1. 주 게이트(멀티 4패널) ─────────────────────────────────────────────────
const e = F.e26Multi
const t4 = F.t30MultiR4?.summary
// ★★★ `gate`는 **최종 확정 합격선**이다 — GATES R2(2026-09-01)에서 잣대가 뒤집혔다.
//
//   ── R1이 정한 것(2026-08-31 사용자 승인) ─────────────────────────────────
//    ① 메모리 게이트의 잣대 = **「LSP 제외」**, 「있는 그대로」는 참고 행.
//    ② `footprint` 0.10 → **0.25**.
//    ③ 나머지(창당·콜드·앱 몫)는 제안값 그대로.
//
//   ── R2가 바꾼 것: ①을 **정확히 뒤집는다** (리드 방침) ────────────────────
//   **주 게이트는 「있는 그대로 · 배포 경로」다. 「LSP 제외」는 `gate:null` 참고 행으로 내린다.**
//   R1과 반대 배선인데, 근거는 R1 이후 제품이 움직였다는 사실 하나다:
//
//    (ⅰ) **유휴에 언어 서버가 0이 됐다**(LSPIDLE — 프리웜이 「준비만」 하고 기동은
//         파일을 열 때로 미뤄졌다). 코드 뷰어를 안 여는 유휴에서는 헬퍼가 **애초에 안 뜬다.**
//         그래서 3.0 쪽에서는 「LSP 제외」와 「있는 그대로」가 **같은 수**다 —
//         뺄셈이 아무것도 안 뺀다. 「있는 그대로」가 곧 앱 몫이다.
//    (ⅱ) 그런데 **2.6.2 쪽에서는 여전히 208.3MB를 뺀다**(그쪽은 프리웜이 기동한다).
//         즉 오늘의 「LSP 제외」는 **분모에서만 빼는 잣대**가 됐고, 그 뺄셈은
//         3.0을 실제보다 나쁘게 만든다. R1 §4.2가 「WS는 분모에서 부풀린 값을 뺀다」고
//         이미 지적한 왜곡이 R1 때보다 **더 커졌다**(3.0 쪽 빼는 값이 0이 됐으므로).
//    (ⅲ) 「있는 그대로」를 못 쓰던 이유(=「적재물의 함수라 성능 회귀선이 못 된다」)도
//         함께 사라졌다. 적재물이 유휴 메모리에 얹히던 경로가 온디맨드로 끊겼기 때문이다.
//         지금은 **적재물이 늘어도 유휴 수가 안 움직인다**(디스크 풋프린트에만 얹힌다 —
//         그건 G9가 따로 본다).
//
//   ── 합격선을 어떻게 골랐나 (규칙을 먼저 적고 값을 뒤에 적는다) ────────────
//   규칙: **오늘 실측(두 분모 중 나쁜 쪽) 위에 여유를 두되, R1의 확정선보다 느슨하게는
//   절대 안 간다.** 선은 조이기만 한다. 조일 때는 0.05 눈금으로 내리고,
//   **조인 뒤에도 두 분모 모두에서 여유가 10% 이상** 남아야 한다(안 남으면 조이지 않는다).
//    · `idleWs` **0.70 유지** — 0.65로 조이면 박제 분모에서 여유가 1% 밑이라 못 조인다.
//      「30% 이상 덜 쓴다」는 사용자에게 하는 약속이라 이 수를 느슨하게 할 이유도 없다.
//    · `idlePriv` **0.60 유지** — 0.55는 조인 뒤 여유가 10%에 못 미친다.
//    · `withWindows` 0.70 → **0.60**(조임). 조인 뒤에도 두 분모 다 10% 넘게 남는다.
//    · `perWindow` 0.30 → **0.25**(조임). 0.20까지 갈 수 있지만 **안 간다** —
//      창당 비용은 두 스냅샷의 뺄셈이라 회차 산포가 ±2MB다(오늘 18.1 / 19.0 / 22.8 ·
//      PATCHNOTES R1도 18.1~21.3). 최악 회차(22.8)가 단독으로도 통과해야 게이트가
//      「성능」을 재지 「잡음」을 안 잰다.
//    · `coldRoot` **0.85 유지**(0.80은 여유 2%대) · `coldApp` **0.70 유지** ·
//      `footprint` **0.25 유지**(R1 결정 ② 그대로).
//   ★ 여유(headroomPct)는 **기계가 낸다** — 이 파일에도, 장부에도, 보고서에도 손으로 적지 마라.
//     위 문단이 적은 것은 **규칙과 방향**뿐이고 퍼센트는 한 칸도 안 적었다.
const G = { idleWs: 0.7, idlePriv: 0.6, withWindows: 0.6, perWindow: 0.25, coldRoot: 0.85, coldApp: 0.7, footprint: 0.25 }
if (e && t4) {
  // ★GATES R1 — 아래 세 줄은 「있는 그대로」다. **게이트를 뗐다**(결정 ①). 참고 행으로 남긴다.
  add('멀티 4패널 유휴 WS(있는 그대로)', t4.idleGridWsMB, e.idleGrid?.totalWsMB, { gate: null, from: `${SRC.t30MultiR4}.summary.idleGridWsMB ÷ ${SRC.e26Multi}.idleGrid.totalWsMB` })
  add('멀티 4패널 유휴 Private(있는 그대로)', t4.idleGridPrivMB, e.idleGrid?.totalPrivMB, { gate: null, from: `${SRC.t30MultiR4} ÷ ${SRC.e26Multi}` })
  add('+추가 창 2개 WS(있는 그대로)', t4.idleWithWindowsWsMB, e.idleWithWindows?.totalWsMB, { gate: null, from: `${SRC.t30MultiR4} ÷ ${SRC.e26Multi}` })
  // ★GATES R2 — 이 두 줄의 게이트도 뗐다. 3.0 쪽이 **2026-08-22 exe**(LSPDIST·LSPIDLE 이전)라
  //   오늘의 제품이 아니다. 판정은 아래 `★★[GATES R2]` 블록 한 곳에서만 한다.
  add('창 1개 추가 비용(WS)', t4.wsMBPerWindow, e.windowCost?.wsMBPerWindow, { gate: null, from: `${SRC.t30MultiR4} ÷ ${SRC.e26Multi}`, note: '회귀 기록 — 판정은 GATES R2 블록이 한다' })
  add('유휴 프로세스 수', t4.idleGridProcs, e.idleGrid?.procs, { gate: null, from: `${SRC.t30MultiR4} ÷ ${SRC.e26Multi}`, note: '〃' })
}
// ★ S3-2 — 같은 지표의 **대안 출처**. `final-parity-r1.md` §4.1이 WS는 크리틱 R4 파일에서,
//   Private은 이 파일에서 가져와 **섞여 있었다.** 「한 파일로 통일한다」는 정정은 통일
//   **방향이 둘**이고, 어느 쪽을 골랐는지가 결과를 바꾼다. 그래서 둘 다 낸다 — 고른 쪽만
//   싣는 것은 선택을 감추는 것이다. (대안 쪽 exe가 더 새것이고 트리도 `gitDirty:false`다.)
const tAlt = F.t30MultiAlt?.summary
if (e && tAlt) {
  add('[대안 출처] 멀티 4패널 유휴 WS', tAlt.idleGridWsMB, e.idleGrid?.totalWsMB, { gate: null, from: `${SRC.t30MultiAlt} ÷ ${SRC.e26Multi}`, note: `exe ${F.t30MultiAlt?.bin?.exeSha256}·${F.t30MultiAlt?.bin?.gitHead}·dirty=${F.t30MultiAlt?.bin?.gitDirty}` })
  add('[대안 출처] 멀티 4패널 유휴 Private', tAlt.idleGridPrivMB, e.idleGrid?.totalPrivMB, { gate: null, from: `${SRC.t30MultiAlt} ÷ ${SRC.e26Multi}`, note: '253.2의 진짜 출처 — 파리티 감사가 인용한 0.50이 여기서 나왔다' })
  add('[대안 출처] 창 1개 추가 비용(WS)', tAlt.wsMBPerWindow, e.windowCost?.wsMBPerWindow, { gate: null, from: `${SRC.t30MultiAlt} ÷ ${SRC.e26Multi}` })
}
// R28j 재측정(같은 세션 두 팔) — 파일이 있을 때만
const tN = F.t30MultiNew?.summary
const eN = F.e26MultiNew?.summary
if (tN && eN) {
  add('[R28j 같은세션] 유휴 WS(있는 그대로)', tN.idleGridWsMB, eN.idleGridWsMB, { gate: null, from: `${SRC.t30MultiNew} ÷ ${SRC.e26MultiNew}` })
  add('[R28j 같은세션] 유휴 Private(있는 그대로)', tN.idleGridPrivMB, eN.idleGridPrivMB, { gate: null, from: `${SRC.t30MultiNew} ÷ ${SRC.e26MultiNew}` })
  add('[R28j 같은세션] +창2 WS(있는 그대로)', tN.idleWithWindowsWsMB, eN.idleWithWindowsWsMB, { gate: null, from: `${SRC.t30MultiNew} ÷ ${SRC.e26MultiNew}` })
  add('[R28j 같은세션] 창당 비용', tN.wsMBPerWindow, eN.wsMBPerWindow, { gate: null, from: `${SRC.t30MultiNew} ÷ ${SRC.e26MultiNew}` })
}

// ── 1b. ★ LSP 헬퍼 프로세스 분리 — 주 게이트가 두 앱에서 같은 것을 재는가 ────
// R28j 실측: 3.0은 부팅 때 LSP를 프리웜한다(`ipc/lsp.rs boot_prewarm` — 활성 채팅의 cwd를
// 읽어 스스로 부른다). 서버는 `Provision::Bundled`라 앱 옆 node_modules에서 바로 뜬다.
// 2.6.2는 같은 프리웜을 **렌더러에서** 부르지만 서버가 앱 홈에 설치돼 있어야 뜨고,
// 벤치 픽스처 홈은 비어 있어 **안 뜬다.** 그래서 같은 픽스처가 3.0에만 node.exe 2개(+conhost)를
// 얹는다 — 두 팔이 같은 것을 재고 있지 않다. 수를 나눠 싣는 이유다.
// ★★ GATES R1 — **이름 기반 분류는 2.6.2를 구조적으로 못 셌다.**
//   옛 규칙은 `/^(node|conhost|…)/`로 **프로세스 이름**을 봤는데, 2.6.2는 TS·Python 서버를
//   `electron.exe`로 띄운다(`ELECTRON_RUN_AS_NODE=1` · `src/main/lsp/manager.ts:788`).
//   그래서 「2.6.2 헬퍼 0」은 측정이 아니라 **분류 산물**이었고(LSPDIST R1 §6.5 · 확인
//   크리틱 C5), 그 위에 세운 「LSP 제외」는 3.0에서만 100MB대를 빼고 2.6.2에서는 0을 뺐다.
//   게이트를 그 수로 확정하는 라운드라 분류부터 고친다.
//
//   새 규칙은 **명령줄**이다 — 두 앱이 같은 서버 스크립트를 같은 이름으로 넘긴다:
//     2.6.2 : electron.exe <레포>\node_modules\typescript-language-server\lib\cli.mjs --stdio
//     3.0   : node.exe     <배포>\node_modules\typescript-language-server\lib\cli.mjs --stdio
//   `bench/lsp.mjs:373`이 이미 쓰던 판정과 같은 자다(그쪽은 진작 명령줄을 봤다).
//
//   ★ `node_modules`를 키로 쓰면 안 된다 — 레포에서 띄운 2.6.2는 **모든** 프로세스의
//   argv[0]이 `…\node_modules\electron\dist\electron.exe`다(렌더러·GPU·크래시패드 전부).
//   엔진 CLI(`…\engines\<v>\node_modules\…\claude.exe`)도 같은 낱말을 달고 다닌다.
const LSP_CMD = /typescript-language-server|tsserver|pyright|langserver\.index\.js|Microsoft\.CodeAnalysis\.LanguageServer|clangd|verse-lsp/i
// 옛 결과 파일(= `cmdline` 필드가 없는 파일)을 읽을 때만 쓰는 폴백. 산출물에 `mode`로 남는다.
const HELPER_NAME = /^(node|conhost|python|pyright|clangd|Microsoft\.CodeAnalysis)/i

/**
 * 한 주행의 프로세스 표본에서 LSP 헬퍼를 갈라낸다.
 * @param phase 'idle' = `summary.idleGrid*`와 같은 순간 · 'windows' = +창2와 같은 순간 ·
 *              'end' = 주행 맨 끝(옛 파일에 있는 유일한 표본).
 */
function lspSplit(j, phase = 'end') {
  const runs = j?.perRun ?? []
  const key = phase === 'idle' ? 'procDetailIdle' : phase === 'windows' ? 'procDetailWindows' : 'procDetail'
  const per = runs.map((r) => {
    const rows = r[key] ?? r.procDetail ?? []
    const exact = Array.isArray(r[key]) && r[key].length > 0
    const hasCmd = rows.some((p) => Object.prototype.hasOwnProperty.call(p, 'cmdline'))
    let h
    if (hasCmd) {
      // ① 명령줄이 서버를 가리키는 프로세스
      const hit = new Set(rows.filter((p) => p.cmdline && LSP_CMD.test(p.cmdline)).map((p) => p.pid))
      // ② 그 자손(=`conhost.exe`)까지 헬퍼 몫에 붙인다. 콘솔 서브시스템 자식에 Windows가
      //    하나씩 붙이는 프로세스인데 **그 명령줄에는 서버 이름이 없다.** 3.0은 node.exe라
      //    conhost가 붙고 2.6.2는 electron.exe(GUI)라 안 붙는다 — 비대칭이 실재하므로
      //    「LSP가 지우면 같이 사라지는 몫」에 넣는 것이 맞다.
      for (let grew = true; grew;) {
        grew = false
        for (const p of rows) if (!hit.has(p.pid) && p.ppid != null && hit.has(p.ppid)) { hit.add(p.pid); grew = true }
      }
      h = rows.filter((p) => hit.has(p.pid))
    } else {
      h = rows.filter((p) => HELPER_NAME.test(p.name))
    }
    return {
      mode: hasCmd ? 'cmdline' : 'name(legacy)',
      sameMoment: exact,
      procs: rows.length,
      helpers: h.length,
      helperWsMB: r2(h.reduce((a, p) => a + (p.wsMB ?? 0), 0)),
      helperPrivMB: r2(h.reduce((a, p) => a + (p.privMB ?? 0), 0)),
      names: h.map((p) => p.name),
      // 무엇을 헬퍼라 불렀는지 **파일에 남긴다** — 분류가 결론을 만드는 자리라 감사 가능해야 한다.
      hits: h.map((p) => (p.cmdline ?? p.name).slice(0, 160))
    }
  })
  if (!per.length) return null
  const mid = (k) => { const a = per.map((x) => x[k]).sort((x, y) => x - y); return a[Math.floor(a.length / 2)] }
  return {
    runs: per.length,
    mode: per[0].mode,
    sameMoment: per.every((p) => p.sameMoment),
    phase,
    helperCount: mid('helpers'), helperWsMB: mid('helperWsMB'), helperPrivMB: mid('helperPrivMB'),
    names: [...new Set(per.flatMap((p) => p.names))],
    hits: [...new Set(per.flatMap((p) => p.hits))],
    per
  }
}
const splitT = lspSplit(F.t30MultiNew)
const splitE = lspSplit(F.e26MultiNew)
if (tN && eN && splitT && splitE) {
  // ★★ 확인 크리틱 R2 **F2** — 아래 **세 줄 전부가 「서로 다른 두 순간의 뺄셈」**이다.
  //   피감수(`summary.*`)는 정착 직후의 값이고, 감수(`procDetail`의 헬퍼 합)는 **주행 맨 끝**
  //   표본이다. 초판은 이 근사를 G4 한 줄에만 주석으로 달아 두어, 유휴 두 줄은 마치
  //   같은 순간의 뺄셈인 것처럼 읽혔다.
  //
  //   크기가 무시할 수준도 아니다 — 벤치 팔의 두 총계가 **691.3 대 594.6**으로 벌어진다
  //   (`procDetail` 합 ≠ `summary` 총계). 헬퍼가 창을 열어도 안 늘어난다는 성질 덕분에
  //   **방향은 두 팔에서 같고** 게이트 판정을 뒤집지는 않지만, 이 수를 인용할 때는
  //   「같은 규칙으로 뺀 근사」까지가 정확한 표현이다. 정공법은 `summary`와 같은 순간의
  //   역할별 표본을 남기는 것이고, 그건 하네스 숙제다.
  // ★GATES R1 덧붙임 — 이 세 줄의 **분모는 이제 틀린 것으로 밝혀졌다.** 옛 파일에는
  //   `cmdline`이 없어 이름 분류로 떨어지는데, 그 규칙은 2.6.2의 tsls+tsserver를 못 센다
  //   (= 2.6.2에서 0을 뺀다). 회귀 기록으로 남기되 **판정은 위 GATES 블록이 한다.**
  const LSP_APPROX = `★근사 — 피감수는 정착 직후 summary, 감수는 주행 끝 procDetail(서로 다른 순간) · 분류=${splitE?.mode ?? '?'}(2.6.2 헬퍼 ${splitE?.helperCount ?? '?'}개 — 이름 분류의 과소계수)`
  add('[R28j·LSP제외] 유휴 WS', tN.idleGridWsMB - splitT.helperWsMB, eN.idleGridWsMB - splitE.helperWsMB, { gate: null, from: 'summary − procDetail의 헬퍼(node/conhost) 합', note: LSP_APPROX })
  add('[R28j·LSP제외] 유휴 Private', tN.idleGridPrivMB - splitT.helperPrivMB, eN.idleGridPrivMB - splitE.helperPrivMB, { gate: null, from: 'summary − procDetail 헬퍼', note: LSP_APPROX })
  // ★ S3-1 — G4(+창2)도 **같은 자로** 뺀다. 한 표 안에서 G1은 LSP 제외, G4는 있는 그대로면
  //   그건 잣대가 아니라 서술이다.
  add('[R28j·LSP제외] +창2 WS', tN.idleWithWindowsWsMB - splitT.helperWsMB, eN.idleWithWindowsWsMB - splitE.helperWsMB, { gate: null, from: 'summary.idleWithWindowsWsMB − procDetail 헬퍼', note: 'G1과 같은 자. 있는 그대로와 섞어 읽지 말 것 · ' + LSP_APPROX })
}

// ── 1b′. ★★★ GATES R1 — **확정 잣대로 판정하는 자리** (사용자 승인 2026-08-31) ──
// 위 블록들과 다른 점 셋:
//   ① 분류가 **명령줄** 기반이다 — 2.6.2의 LSP(=`electron.exe`로 뜨는 tsls+tsserver)가
//      드디어 세어진다. 옛 이름 분류에서 「2.6.2 헬퍼 0」은 측정이 아니라 산물이었다.
//   ② 감수(헬퍼 합)를 **피감수와 같은 스냅샷**에서 뽑는다(`procDetailIdle`/`Windows`) —
//      §1.6-A (c″)의 「서로 다른 두 순간의 뺄셈」이 여기서는 성립하지 않는다.
//   ③ 3.0은 **node 사이드카까지 놓인 배포 모사**다(LSPDIST R2 이후의 진짜 배포 상태).
// ★★GATES R2가 이 블록의 **게이트를 전부 뗐다.** 두 가지 이유가 겹친다:
//   (a) 3.0 쪽 exe가 **LSPIDLE 이전**이라 오늘의 제품이 아니다(유휴 헬퍼 3개인 판).
//   (b) 잣대가 「LSP 제외」에서 「있는 그대로」로 뒤집혔다(위 G 상수 주석의 (ⅰ)~(ⅲ)).
// 지우지 않고 남긴다 — R1의 판정이 무엇이었는지가 사라지면 왜 뒤집혔는지도 사라진다.
// **판정은 아래 `★★[GATES R2]` 블록 한 곳에서만 한다.**
const tG = F.t30MultiGates?.summary
const eG = F.e26MultiGates?.summary
const splitGT = lspSplit(F.t30MultiGates, 'idle')
const splitGE = lspSplit(F.e26MultiGates, 'idle')
const splitGTw = lspSplit(F.t30MultiGates, 'windows')
const splitGEw = lspSplit(F.e26MultiGates, 'windows')
if (tG && eG && splitGT && splitGE) {
  const nx = (s) => (s?.sameMoment ? '같은 순간 표본' : '★근사(주행 끝 표본)')
  const cls = `분류=${splitGT.mode}/${splitGE.mode} · 헬퍼 3.0=${splitGT.helperCount} / 2.6.2=${splitGE.helperCount} · ${nx(splitGT)}`
  add('[GATES R1·폐기된 잣대] 유휴 WS — LSP 제외', tG.idleGridWsMB - splitGT.helperWsMB, eG.idleGridWsMB - splitGE.helperWsMB,
    { gate: null, from: `${SRC.t30MultiGates} ÷ ${SRC.e26MultiGates} — summary − procDetailIdle의 헬퍼`, note: 'R1 판정 기록(게이트 뗌) · ' + cls })
  add('[GATES R1·폐기된 잣대] 유휴 Private — LSP 제외', tG.idleGridPrivMB - splitGT.helperPrivMB, eG.idleGridPrivMB - splitGE.helperPrivMB,
    { gate: null, from: `${SRC.t30MultiGates} ÷ ${SRC.e26MultiGates} — summary − procDetailIdle의 헬퍼`, note: 'R1 판정 기록(게이트 뗌) · ' + cls })
  add('[GATES R1·폐기된 잣대] +창2 WS — LSP 제외', tG.idleWithWindowsWsMB - (splitGTw ?? splitGT).helperWsMB, eG.idleWithWindowsWsMB - (splitGEw ?? splitGE).helperWsMB,
    { gate: null, from: `${SRC.t30MultiGates} ÷ ${SRC.e26MultiGates} — summary − procDetailWindows의 헬퍼`, note: `R1 판정 기록(게이트 뗌) · ${nx(splitGTw)}` })
  add('[GATES R1] 창 1개 추가 비용(WS)', tG.wsMBPerWindow, eG.wsMBPerWindow,
    { gate: null, from: `${SRC.t30MultiGates} ÷ ${SRC.e26MultiGates}`, note: '두 스냅샷의 뺄셈이라 헬퍼가 약분된다 — LSP 잣대와 무관' })
  add('[GATES R1] 유휴 프로세스 수', tG.idleGridProcs, eG.idleGridProcs, { gate: null, from: `${SRC.t30MultiGates} ÷ ${SRC.e26MultiGates}` })
  add('[GATES·참고] 유휴 WS(있는 그대로)', tG.idleGridWsMB, eG.idleGridWsMB, { gate: null, from: `${SRC.t30MultiGates} ÷ ${SRC.e26MultiGates}`, note: '공시용 — 게이트 아님(결정 ①). 적재물이 바뀌면 같이 움직인다' })
  add('[GATES·참고] 유휴 Private(있는 그대로)', tG.idleGridPrivMB, eG.idleGridPrivMB, { gate: null, from: `${SRC.t30MultiGates} ÷ ${SRC.e26MultiGates}` })
  add('[GATES·참고] +창2 WS(있는 그대로)', tG.idleWithWindowsWsMB, eG.idleWithWindowsWsMB, { gate: null, from: `${SRC.t30MultiGates} ÷ ${SRC.e26MultiGates}` })
  add('[GATES·참고] LSP 헬퍼 몫 WS', splitGT.helperWsMB, splitGE.helperWsMB, { gate: null, from: 'procDetailIdle의 헬퍼 합', note: '이 줄이 1에 가까울수록 두 팔이 같은 것을 지고 잰다는 뜻이다' })
  add('[GATES·참고] LSP 헬퍼 몫 Private', splitGT.helperPrivMB, splitGE.helperPrivMB, { gate: null, from: 'procDetailIdle의 헬퍼 합' })
}

// ── 1b″. ★★★ GATES R2 — **최종 확정 게이트가 판정하는 유일한 자리** (2026-09-01) ──
// R1 블록과 다른 점 셋:
//   ① 3.0이 **오늘의 제품**이다 — LSPIDLE(온디맨드 기동) · FPS144 · SLUG가 다 들어간 exe.
//   ② 잣대가 **「있는 그대로 · 배포 경로」**다(위 G 상수 주석 참조). LSP 제외는 참고로 내려간다.
//   ③ 모든 게이트 행에 **두 번째 분모**(박제 2.6.2)를 붙여 같은 판정을 한 번 더 돌린다 —
//      분모를 재측정하지 않은 흠을 판정으로 덮지 않으려고.
// 「LSP 제외」 참고 행이 오늘 무엇을 뜻하는지: 3.0 쪽에서 빼는 값이 **0**이므로
// 그 행은 「3.0 있는 그대로 ÷ (2.6.2 − 208.3)」이다 — 분모에서만 빼는 뺄셈이다.
const tG2 = F.t30MultiGates2?.summary
const splitG2 = lspSplit(F.t30MultiGates2, 'idle')
const splitG2w = lspSplit(F.t30MultiGates2, 'windows')
const eFrozen = F.e26Multi
if (tG2 && eG) {
  const ALT = (k, v) => ({ label: '박제 2.6.2', electron: v, from: `${SRC.e26Multi}.${k}` })
  const helpers = `유휴 헬퍼 3.0=${splitG2?.helperCount ?? '?'}개(${splitG2?.helperWsMB ?? '?'}MB) / 2.6.2=${splitGE?.helperCount ?? '?'}개(${splitGE?.helperWsMB ?? '?'}MB) · 분류=${splitG2?.mode ?? '?'} · ${splitG2?.sameMoment ? '같은 순간 표본' : '★근사'}`
  add('★★[GATES R2] 유휴 WS(있는 그대로 · 배포 경로)', tG2.idleGridWsMB, eG.idleGridWsMB,
    { gate: G.idleWs, from: `${SRC.t30MultiGates2}.summary.idleGridWsMB ÷ ${SRC.e26MultiGates}.summary.idleGridWsMB`, note: helpers, alt: ALT('idleGrid.totalWsMB', eFrozen?.idleGrid?.totalWsMB) })
  add('★★[GATES R2] 유휴 Private(있는 그대로)', tG2.idleGridPrivMB, eG.idleGridPrivMB,
    { gate: G.idlePriv, from: `${SRC.t30MultiGates2} ÷ ${SRC.e26MultiGates}`, alt: ALT('idleGrid.totalPrivMB', eFrozen?.idleGrid?.totalPrivMB) })
  add('★★[GATES R2] +창2 WS(있는 그대로)', tG2.idleWithWindowsWsMB, eG.idleWithWindowsWsMB,
    { gate: G.withWindows, from: `${SRC.t30MultiGates2} ÷ ${SRC.e26MultiGates}`, alt: ALT('idleWithWindows.totalWsMB', eFrozen?.idleWithWindows?.totalWsMB) })
  add('★★[GATES R2] 창 1개 추가 비용(WS)', tG2.wsMBPerWindow, eG.wsMBPerWindow,
    { gate: G.perWindow, from: `${SRC.t30MultiGates2} ÷ ${SRC.e26MultiGates}`, note: '회차 산포가 ±2MB인 수다 — 선을 0.20까지 조이지 않은 이유(G 상수 주석)', alt: ALT('windowCost.wsMBPerWindow', eFrozen?.windowCost?.wsMBPerWindow) })
  add('★★[GATES R2] 유휴 프로세스 수', tG2.idleGridProcs, eG.idleGridProcs,
    { gate: 1, from: `${SRC.t30MultiGates2} ÷ ${SRC.e26MultiGates}`, note: 'R1은 8:7로 미달이었다 — conhost와 node 둘이 사라져 5:7이 됐다', alt: ALT('idleGrid.procs', eFrozen?.idleGrid?.procs) })
  // ★ 창당 프로세스는 비율이 아니라 **절대 0**이다(G6). 값 자체를 싣는다.
  add('★★[GATES R2] 창 1개 추가 프로세스(절대 0)', tG2.procsAdded, 1,
    { gate: 0, from: `${SRC.t30MultiGates2}.summary.procsAdded`, note: `분모 칸은 자리표시(1)다 — 판정은 3.0 값이 0인지로만 한다. 2.6.2는 ${eG.procsAdded}` })
  // 참고 — 오늘의 「LSP 제외」가 무엇이 됐는지 그대로 보여 준다(게이트 아님).
  if (splitG2 && splitGE) {
    add('[GATES R2·참고] 유휴 WS — LSP 제외(폐기된 잣대)', tG2.idleGridWsMB - splitG2.helperWsMB, eG.idleGridWsMB - splitGE.helperWsMB,
      { gate: null, from: 'summary − procDetailIdle의 헬퍼', note: `★3.0 쪽에서 빼는 값이 ${splitG2.helperWsMB}MB다 — 분모에서만 빼는 잣대가 됐다` })
    add('[GATES R2·참고] 유휴 Private — LSP 제외(폐기된 잣대)', tG2.idleGridPrivMB - splitG2.helperPrivMB, eG.idleGridPrivMB - splitGE.helperPrivMB,
      { gate: null, from: 'summary − procDetailIdle의 헬퍼', note: '〃' })
    add('[GATES R2·참고] LSP 헬퍼 몫 WS', splitG2.helperWsMB, splitGE.helperWsMB, { gate: null, from: 'procDetailIdle의 헬퍼 합', note: '유휴에 코드 인텔리전스가 한 톨도 안 뜬다 — 0이 이 라운드의 표제다' })
    add('[GATES R2·참고] LSP 헬퍼 몫 Private', splitG2.helperPrivMB, splitGE.helperPrivMB, { gate: null, from: 'procDetailIdle의 헬퍼 합' })
  }
  add('[GATES R2·참고] +창2 Private(있는 그대로)', tG2.idleWithWindowsPrivMB, eG.idleWithWindowsPrivMB, { gate: null, from: `${SRC.t30MultiGates2} ÷ ${SRC.e26MultiGates}` })
}
// 콜드 — 같은 exe·같은 배포 모사. 분모는 박제(2.6.2 콜드는 이 라운드에서 안 쟀다).
if (F.coldGates2 && F.coldE26) {
  add('★★[GATES R2] 콜드 UI 사용 가능 rootMs', F.coldGates2.medianRootMs, F.coldE26.medianRootMs,
    { gate: G.coldRoot, from: `${SRC.coldGates2}.medianRootMs ÷ ${SRC.coldE26}.medianRootMs`, note: '분모가 박제라 교대 주행이 아니다 — 같은 판정을 아래 「교대」 행이 독립적으로 한 번 더 한다' })
  add('[GATES R2·참고] 콜드 첫 가시 창(★비대칭)', F.coldGates2.medianWinMs, F.coldE26.medianWinMs,
    { gate: null, from: `${SRC.coldGates2} ÷ ${SRC.coldE26}`, note: '3.0=본 창 / 2.6.2=300×240 스플래시 — 게이트로 쓰지 말 것(G8)' })
}
// 단일 채팅 유휴 — **게이트가 아니다.** 변별력이 없는 눈금이라는 것이 이 두 줄로 보인다.
if (F.idleGates2 && F.e26Idle) {
  add('[GATES R2·참고] 단일 채팅 유휴 WS', F.idleGates2.totalWsMB, F.e26Idle.totalWsMB,
    { gate: null, from: `${SRC.idleGates2} ÷ ${SRC.e26Idle}`, note: '★1에 가깝다 — 단일 채팅에서는 두 런타임의 바닥값이 수를 지배한다. 주 게이트를 멀티로 잡은 이유가 이 줄이다(bench/multi.mjs 머리말)' })
  add('[GATES R2·참고] 단일 채팅 유휴 Private', F.idleGates2.totalPrivMB, F.e26Idle.totalPrivMB,
    { gate: null, from: `${SRC.idleGates2} ÷ ${SRC.e26Idle}`, note: 'Private 축에서는 같은 상태가 절반 아래다 — WS 열과 Private 열을 섞어 읽지 말 것' })
}

// ── 1c. ★★ 벤치 경로 vs 배포 경로 — 같은 exe를 두 자리에서 잰다 (S2-1) ───────
// 확인 크리틱이 뒤집은 자리다. 「있는 그대로」는 **사용자가 겪는 상태가 아니라 벤치가
// 만든 상태**다: exe가 레포 안이면 `shipped_module()`이 레포 node_modules를 물어 LSP가
// 뜨고, 배포 위치(파일 2개)면 못 물어 안 뜬다. 아래 두 행의 차이는 **exe 위치 + cwd
// 하나뿐**이고 나머지(픽스처·정착·반복·세션)는 같다.
const tDist = F.t30MultiDist?.summary
const tBench = F.t30MultiBench?.summary
const eR1 = F.e26MultiR1?.summary
const tDistMod = F.t30MultiDistMod?.summary
const splitDist = lspSplit(F.t30MultiDist)
const splitBench = lspSplit(F.t30MultiBench)
const splitDistMod = lspSplit(F.t30MultiDistMod)
const splitER1 = lspSplit(F.e26MultiR1)
if (tDist && eR1) {
  // ★GATES R1 — 게이트를 뗐다. 이 파일들은 **LSPDIST 이전**의 배포본(= 언어 서버가 안 실린
  //   판)이고, 분모 쪽 헬퍼 수(`2.6.2=…`)도 **옛 이름 분류**의 산물이다. 회귀 기록으로만 남긴다.
  add('[배포 경로·LSPDIST 이전] 유휴 WS', tDist.idleGridWsMB, eR1.idleGridWsMB, { gate: null, from: `${SRC.t30MultiDist} ÷ ${SRC.e26MultiR1}`, note: `LSP 헬퍼 3.0=${splitDist?.helperCount} / 2.6.2=${splitER1?.helperCount} (분류 ${splitER1?.mode})` })
  add('[배포 경로·LSPDIST 이전] 유휴 Private', tDist.idleGridPrivMB, eR1.idleGridPrivMB, { gate: null, from: `${SRC.t30MultiDist} ÷ ${SRC.e26MultiR1}` })
  add('[배포 경로·LSPDIST 이전] +창2 WS', tDist.idleWithWindowsWsMB, eR1.idleWithWindowsWsMB, { gate: null, from: `${SRC.t30MultiDist} ÷ ${SRC.e26MultiR1}` })
  add('[배포 경로·LSPDIST 이전] 창 1개 추가 비용', tDist.wsMBPerWindow, eR1.wsMBPerWindow, { gate: null, from: `${SRC.t30MultiDist} ÷ ${SRC.e26MultiR1}` })
}
if (tBench && eR1) {
  add('[벤치 경로] 유휴 WS(있는 그대로)', tBench.idleGridWsMB, eR1.idleGridWsMB, { gate: null, from: `${SRC.t30MultiBench} ÷ ${SRC.e26MultiR1}`, note: `헬퍼 ${splitBench?.helperCount}개가 얹힌 상태 — 배포본에 없는 상태다` })
  add('[벤치 경로] 유휴 Private(있는 그대로)', tBench.idleGridPrivMB, eR1.idleGridPrivMB, { gate: null, from: `${SRC.t30MultiBench} ÷ ${SRC.e26MultiR1}` })
}

// ── 2. 콜드 스타트 ───────────────────────────────────────────────────────────
const cp = F.coldPair?.summary
if (F.coldE26 && cp) {
  add('콜드 첫 가시 창(박제 분모 · ★비대칭)', cp.tauri?.winMs, F.coldE26.medianWinMs, { gate: null, from: `${SRC.coldPair}.summary.tauri.winMs ÷ ${SRC.coldE26}.medianWinMs`, note: '3.0=본 창 / 2.6.2=300×240 스플래시 — 서로 다른 사건. 게이트로 쓰지 말 것' })
  add('[R28j] 콜드 UI 사용 가능 rootMs(박제 분모)', cp.tauri?.rootMs, F.coldE26.medianRootMs, { gate: null, from: `${SRC.coldPair} ÷ ${SRC.coldE26}`, note: '3.0 쪽 exe가 오늘 것이 아니다 — 판정은 GATES R2의 콜드 행이 한다' })
}
if (cp) {
  add('콜드 첫 가시 창(교대 · ★비대칭)', cp.tauri?.winMs, cp.electron?.winMs, { gate: null, from: `${SRC.coldPair}.summary`, note: '위와 같은 비대칭' })
  add('콜드 UI 사용 가능 rootMs(교대)', cp.tauri?.rootMs, cp.electron?.rootMs, { gate: G.coldRoot, from: `${SRC.coldPair}.summary` })
}

// ── 3. 설치 풋프린트 ─────────────────────────────────────────────────────────
// ★★GATES R2 — R1 §5.2가 남긴 숙제를 갚는다. `footprint.json`의 세 행은 설치기가
//   **2.4MB이던 시절**(LSPDIST 이전 · 언어 서버와 node를 안 싣던 판)의 값이라
//   여유 94~96%를 내는데 **그건 오늘의 수가 아니다.** 게이트를 그 위에 걸면 게이트가
//   아무것도 안 막는다. 그래서 세 행의 게이트를 떼고, **오늘 실측한 배포 모사 폴더**로
//   G9를 다시 건다(아래). 설치기 **바이트**는 NSIS를 다시 구워야 재는 수라 이 라운드에서
//   못 쟀다 — 그 칸은 여전히 미측정으로 남는다(보고서 §「남은 것」).
const FOOT_STALE = '★낡음 — 설치기 2.4MB 시절(LSPDIST 이전)의 값이다. 게이트를 뗐다(GATES R2). 오늘 값은 아래 배포 모사 행'
if (F.foot?.compare) {
  const c = F.foot.compare
  add('[낡음] 설치본 파일 크기', c.installerBytes?.tauri, c.installerBytes?.electron, { gate: null, from: `${SRC.foot}.compare.installerBytes`, note: FOOT_STALE })
  add('[낡음] 설치 폴더(논리)', c.installDirLogical?.tauri, c.installDirLogical?.electron, { gate: null, from: `${SRC.foot}.compare.installDirLogical`, note: FOOT_STALE })
  add('[낡음] 설치 폴더(할당 4K)', c.installDirAlloc?.tauri, c.installDirAlloc?.electron, { gate: null, from: `${SRC.foot}.compare.installDirAlloc`, note: FOOT_STALE })
}
// ★★ G9 — 오늘의 풋프린트. 분자는 이 라운드가 잰 배포 모사 폴더, 분모는 `footprint.json`의
//   2.6.2 설치 폴더(박제 · 디스크 실측이라 세션에 안 흔들린다). **두 파일에서 각각 읽는다** —
//   이 파일에 손으로 옮겨 적은 바이트가 한 칸도 없다.
if (F.footGates2 && F.foot?.compare?.installDirLogical?.electron) {
  add('★★[GATES R2] 설치 폴더(논리 · 배포 모사)', F.footGates2.installDirLogicalBytes, F.foot.compare.installDirLogical.electron,
    { gate: G.footprint, from: `${SRC.footGates2}.installDirLogicalBytes ÷ ${SRC.foot}.compare.installDirLogical.electron`,
      note: `3.0 ${F.footGates2.files}파일 — uninstall.exe(NSIS 생성)가 빠져 있어 실제 설치 폴더는 이보다 조금 크다(보수적이지 않은 방향이라 보고서에 적었다)` })
}

// ── 4. ★ 바닥값을 뺀 「앱 몫」 비율 ──────────────────────────────────────────
const armOf = (j) => (j ? Object.entries(j).find(([k]) => k !== 'env' && k !== 'what')?.[1] : null)
const floorOf = (j) => {
  const a = j?.appShare ? j : armOf(j)
  if (!a?.appShare) return null
  return { base: a.appShare.baselineWsMB, blank: a.appShare.blankWsMB, appWs: a.appShare.wsMB, appPriv: a.appShare.privMB, valid: a.appShare.valid, bin: a.bin, steps: a.steps }
}
const fT = floorOf(F.t30Floor)
const fTR4 = floorOf(F.t30FloorR4)
const fE = floorOf(F.e26Floor)
const privOf = (f) => {
  const b = f?.steps?.[0]?.privMB
  const z = f?.steps?.[f.steps.length - 1]?.privMB
  return b == null || z == null ? null : { base: b, blank: z }
}
const appShare = {
  what: '앱 몫 = (4패널 기준선 − 빈 문서 바닥값). 같은 실행 안에서 뺀 값이라 세션 밴드에 둔감하다.',
  method: 'bench/gpuprobe.mjs 6단계: Page.navigate about:blank → DOM 노드·리스너 90%+ 감소를 해제 조건으로 검증(release.verdict)',
  tauri: fT && { source: SRC.t30Floor, baselineWs: fT.base, blankFloorWs: fT.blank, appWs: fT.appWs, appPriv: fT.appPriv, valid: fT.valid, exe: fT.bin?.exe, exeSha: fT.bin?.exeSha256, priv: privOf(fT) },
  tauriR4: fTR4 && { source: SRC.t30FloorR4, baselineWs: fTR4.base, blankFloorWs: fTR4.blank, appWs: fTR4.appWs, appPriv: fTR4.appPriv, exeSha: fTR4.bin?.exeSha256, priv: privOf(fTR4) },
  electron: fE && { source: SRC.e26Floor, baselineWs: fE.base, blankFloorWs: fE.blank, appWs: fE.appWs, appPriv: fE.appPriv, valid: fE.valid, exeSha: fE.bin?.exeSha256, priv: privOf(fE) }
}
if (fT && fE) {
  add('★ 앱 몫 WS (R28j 같은 세션)', fT.appWs, fE.appWs, { gate: null, from: `${SRC.t30Floor} ÷ ${SRC.e26Floor} (appShare.wsMB)` })
  add('★ 앱 몫 Private (R28j 같은 세션)', fT.appPriv, fE.appPriv, { gate: null, from: `appShare.privMB` })
  add('런타임 바닥값 WS (앱 코드로 못 줄이는 몫)', fT.blank, fE.blank, { gate: null, from: 'appShare.blankWsMB', note: '이 비율은 우리 성과가 아니라 WebView2 ÷ Chromium이다' })
}
if (fTR4 && fE) {
  add('★ 앱 몫 WS (3.0=R4 크리틱 exe · 세션 다름)', fTR4.appWs, fE.appWs, { gate: null, from: `${SRC.t30FloorR4} ÷ ${SRC.e26Floor}`, note: '3.0 쪽은 2026-08-22 exe다 — 교차 세션 비교라 참고값' })
}

// ── 4b. ★★ 앱 몫을 **역할별로** 가른다 (확인 크리틱 S2-2) ───────────────────
// 「앱 몫 Private 0.53 = 우리 코드의 승점」은 같은 파일이 반박한다. `byRole`로 가르면
// 문서가 붙드는 몫(renderer)만 뗐을 때 **3.0이 두 축 다 더 많이 쓴다.** 0.53을 만드는
// 것은 2.6.2의 비-렌더러(browser·gpu-process)가 언로드 때 Private을 돌려주는 것이다.
// 손으로 적은 서술이 이 표를 가리지 못하게 **기계가 낸다.**
function roleDelta(j) {
  const a = j?.appShare ? j : armOf(j)
  const st = a?.steps
  if (!st?.length) return null
  const first = st[0]
  const last = st[st.length - 1]
  const names = [...new Set([...Object.keys(first.byRole ?? {}), ...Object.keys(last.byRole ?? {})])]
  const roles = {}
  for (const n of names) {
    const b = first.byRole?.[n] ?? { wsMB: 0, privMB: 0, n: 0 }
    const z = last.byRole?.[n] ?? { wsMB: 0, privMB: 0, n: 0 }
    roles[n] = { procs: b.n ?? null, dWsMB: r2((b.wsMB ?? 0) - (z.wsMB ?? 0)), dPrivMB: r2((b.privMB ?? 0) - (z.privMB ?? 0)) }
  }
  const sum = (k) => r2(Object.values(roles).reduce((s, x) => s + x[k], 0))
  return { baseline: first.label, blank: last.label, roles, sumDWsMB: sum('dWsMB'), sumDPrivMB: sum('dPrivMB') }
}
const rdT = roleDelta(F.t30Floor)
const rdE = roleDelta(F.e26Floor)
if (rdT && rdE) {
  add('★ 앱 몫 WS — renderer만(문서가 붙드는 몫)', rdT.roles.renderer?.dWsMB, rdE.roles.renderer?.dWsMB, { gate: null, from: `${SRC.t30Floor} ÷ ${SRC.e26Floor} — steps[0].byRole.renderer − steps[마지막].byRole.renderer`, note: '>1이면 우리 문서가 2.6.2보다 더 쓴다는 뜻이다' })
  add('★ 앱 몫 Private — renderer만', rdT.roles.renderer?.dPrivMB, rdE.roles.renderer?.dPrivMB, { gate: null, from: 'byRole.renderer(Private)', note: '총량 앱 몫 Private 0.53과 방향이 반대다 — 0.53은 우리 코드가 아니다' })
  const nonRendPriv = (rd) => r2(Object.entries(rd.roles).filter(([k]) => k !== 'renderer').reduce((s, [, v]) => s + v.dPrivMB, 0))
  add('앱 몫 Private — 비-렌더러(런타임 프로세스 구조)', nonRendPriv(rdT), nonRendPriv(rdE), { gate: null, from: 'byRole에서 renderer를 뺀 합', note: '2.6.2의 browser+gpu-process가 언로드 때 Private을 반납한다 — 0.53의 진짜 출처' })
}

// ── 5. 콜드의 「앱 몫」 — 웹 런타임 기동(spawn→timeOrigin)을 뺀다 ────────────
const bootT = F.boot?.['tauri-3.0.0+default']?.spawnToTimeOriginMs
const bootE = F.boot?.['electron-2.6.2+default']?.spawnToTimeOriginMs
if (cp && bootT && bootE) {
  add('★ 콜드 앱 몫(rootMs − 런타임 기동)', cp.tauri?.rootMs - bootT, cp.electron?.rootMs - bootE, {
    gate: G.coldApp,
    from: `${SRC.coldPair}.summary − ${SRC.boot}.spawnToTimeOriginMs`,
    note: `런타임 기동 바닥값 3.0 ${bootT}ms / 2.6.2 ${bootE}ms — 같은 값이다`
  })
}

const out = {
  what: '성능 게이트 비율 재계산(측정 없음 — 커밋된 결과 파일의 산술)',
  at: new Date().toISOString(),
  sources: Object.fromEntries(Object.entries(SRC).map(([k, v]) => [k, { file: v, present: !!F[k] }])),
  gates: {
    note: '★★최종 확정 — GATES R2(2026-09-01). 잣대=**있는 그대로 · 배포 경로**(R1의 「LSP 제외」를 뒤집었다 — 유휴 헬퍼가 0이 되면서 그 뺄셈이 분모에서만 빼는 자가 됐다). footprint 0.25 유지. docs/decisions-3.0.md §1.5-c · docs/parity-fix-gates-r2.md',
    'G1 주게이트 유휴 WS(있는 그대로 · 배포 경로)': G.idleWs,
    'G2 유휴 WS(LSP 제외)': '게이트 아님 — 참고만(R1에서 강등). 3.0 쪽에서 빼는 값이 0이라 분모에서만 빼는 잣대가 됐다',
    'G2b 유휴 WS(벤치 경로)': '게이트 아님 — 공시만. 배포본에 없는 상태다(decisions-3.0.md §1.4-b)',
    'G3 유휴 Private(있는 그대로)': G.idlePriv,
    'G4 +창2 WS(★G1과 같은 자 — 있는 그대로)': G.withWindows,
    'G5 창당 비용 WS': G.perWindow,
    'G6 창당 프로세스': '= 0 (절대)',
    'G7 콜드 rootMs': G.coldRoot,
    'G8 콜드 첫 가시 창': '게이트에서 내림 — 두 앱이 다른 사건을 잰다',
    'G9 설치 풋프린트(설치 폴더 논리)': G.footprint,
    'G9b 설치기 바이트': '미측정 — NSIS를 다시 구워야 재는 수다(GATES R2가 못 갚은 숙제)',
    'G10 FPS': '드랍 0% + p95 ≤ 25ms (절대 · avgFps는 세션 속성이라 게이트 부적합)',
    'G11 앱 몫 WS': '게이트 아님 — 관측만',
    'G12 앱 몫 콜드': G.coldApp,
    'G13 단일 채팅 유휴': '게이트 아님 — 변별력이 없다(WS 비율이 1 근처). 주 게이트는 멀티다'
  },
  // ★★GATES R2 — 분모를 **두 벌**로 돌린 결과. 분자는 오늘, 분모는 어제(R1 세션)라
  //   생기는 흠을 판정 밖에 두지 않으려고 박제 분모로 같은 판정을 한 번 더 한다.
  //   두 분모가 얼마나 다른지도 여기서 기계가 낸다 — 보고서에 손으로 옮겨 적지 마라.
  denomCheck: eG && eFrozen?.idleGrid && {
    what: '2.6.2 분모 두 벌: R1 같은세션 실측(multi-electron-2.6.2-gates.json) vs 박제(multi-electron-2.6.2.json)',
    why: 'GATES R2는 분모를 재측정하지 않았다(리드 지시). 대신 게이트 행마다 alt로 박제 분모 판정을 같이 낸다.',
    sameSession: { idleWs: eG.idleGridWsMB, idlePriv: eG.idleGridPrivMB, withWindowsWs: eG.idleWithWindowsWsMB, perWindow: eG.wsMBPerWindow, procs: eG.idleGridProcs },
    frozen: { idleWs: eFrozen.idleGrid.totalWsMB, idlePriv: eFrozen.idleGrid.totalPrivMB, withWindowsWs: eFrozen.idleWithWindows?.totalWsMB, perWindow: eFrozen.windowCost?.wsMBPerWindow, procs: eFrozen.idleGrid.procs },
    deltaPct: {
      idleWs: r3(((eG.idleGridWsMB - eFrozen.idleGrid.totalWsMB) / eFrozen.idleGrid.totalWsMB) * 100),
      idlePriv: r3(((eG.idleGridPrivMB - eFrozen.idleGrid.totalPrivMB) / eFrozen.idleGrid.totalPrivMB) * 100),
      withWindowsWs: r3(((eG.idleWithWindowsWsMB - eFrozen.idleWithWindows?.totalWsMB) / eFrozen.idleWithWindows?.totalWsMB) * 100),
      perWindow: r3(((eG.wsMBPerWindow - eFrozen.windowCost?.wsMBPerWindow) / eFrozen.windowCost?.wsMBPerWindow) * 100)
    },
    verdict: rows.filter((r) => r.alt).every((r) => r.pass && r.alt.pass) ? '두 분모 모두에서 전 게이트 통과 — 분모 재사용이 판정을 만들지 않았다' : '★두 분모의 판정이 갈린다 — 분모를 다시 재야 한다'
  },
  // ★GATES R1 — 확정 게이트가 실제로 쓴 분류. `mode`가 `name(legacy)`면 그 줄의 2.6.2 헬퍼는
  //   **못 센 것**이지 없는 것이 아니다. `hits`에 무엇을 헬퍼라 불렀는지 그대로 남긴다.
  lspSplitGates: (splitGT || splitGE) && {
    tauri: splitGT, electron: splitGE,
    tauriWindows: splitGTw, electronWindows: splitGEw,
    note: '헬퍼 = 명령줄에 서버 스크립트 이름이 있는 프로세스 + 그 자손(conhost). 두 앱에 같은 자.'
  },
  rows,
  lspSplit: { tauri: splitT, electron: splitE, note: '★옛 파일 전용 — 이름 분류(node/conhost/…)라 2.6.2의 electron.exe LSP를 구조적으로 못 센다. 판정은 lspSplitGates가 한다' },
  // ★ S2-1 — 같은 exe를 두 자리에서 잰 짝. 「있는 그대로」가 어느 상태의 수인지 여기서 갈린다.
  paths: {
    what: '같은 exe · 같은 픽스처 · 같은 세션. 다른 것은 exe 위치와 프로세스 cwd 하나뿐이다.',
    why: 'crates/ccg-lsp/src/launch.rs::shipped_module()이 node_modules를 exe 폴더/프로세스 cwd에서 위로 훑는다. 레포 안이면 물고, 배포 위치(파일 2개)면 못 문다.',
    dist: tDist && { source: SRC.t30MultiDist, cwd: F.t30MultiDist?.launchCwd, exe: F.t30MultiDist?.bin?.exe, exeSha: F.t30MultiDist?.bin?.exeSha256, idleWs: tDist.idleGridWsMB, idlePriv: tDist.idleGridPrivMB, procs: tDist.idleGridProcs, helpers: splitDist?.helperCount, helperWsMB: splitDist?.helperWsMB, helperNames: splitDist?.names },
    bench: tBench && { source: SRC.t30MultiBench, cwd: F.t30MultiBench?.launchCwd, exe: F.t30MultiBench?.bin?.exe, exeSha: F.t30MultiBench?.bin?.exeSha256, idleWs: tBench.idleGridWsMB, idlePriv: tBench.idleGridPrivMB, procs: tBench.idleGridProcs, helpers: splitBench?.helperCount, helperWsMB: splitBench?.helperWsMB, helperNames: splitBench?.names },
    distWithModules: tDistMod && { source: SRC.t30MultiDistMod, cwd: F.t30MultiDistMod?.launchCwd, exeSha: F.t30MultiDistMod?.bin?.exeSha256, env: F.t30MultiDistMod?.armEnv?.CCG_LSP_MODULES, idleWs: tDistMod.idleGridWsMB, idlePriv: tDistMod.idleGridPrivMB, procs: tDistMod.idleGridProcs, helpers: splitDistMod?.helperCount, note: '배포 위치 그대로 + CCG_LSP_MODULES만 얹음(1회) — 헬퍼가 돌아오면 원인은 위치가 아니라 node_modules 해석이다' },
    electron: eR1 && { source: SRC.e26MultiR1, cwd: F.e26MultiR1?.launchCwd, idleWs: eR1.idleGridWsMB, idlePriv: eR1.idleGridPrivMB, procs: eR1.idleGridProcs, helpers: splitER1?.helperCount }
  },
  appShare,
  roleSplit: { tauri: rdT, electron: rdE, note: '기준선 − 빈 문서를 역할별로. renderer만 떼면 3.0이 더 많이 쓴다 — 앱 몫 Private 0.53을 「우리 코드」라 부르면 안 되는 이유(확인 크리틱 S2-2)' },
  webRuntimeBootFloorMs: { tauri: bootT, electron: bootE, source: SRC.boot }
}

const w = (s, n) => String(s ?? '—').padEnd(n)
const wr = (s, n) => String(s ?? '—').padStart(n)
console.log('──── 비율 재계산 (측정 없음 · 커밋된 결과 파일의 산술) ────')
console.log(w('지표', 44) + wr('3.0', 10) + wr('2.6.2', 10) + wr('비율', 8) + wr('합격선', 8) + wr('여유%', 8) + '  판정')
for (const r of rows) {
  console.log(
    w(r.metric, 44) + wr(r.tauri, 10) + wr(r.electron, 10) + wr(r.ratio, 8) + wr(typeof r.gate === 'number' ? r.gate : '—', 8) +
      wr(r.headroomPct == null ? '—' : r.headroomPct.toFixed(1), 8) +
      '  ' + (r.pass == null ? '(게이트 없음)' : r.pass ? '통과' : '미달') + (r.note ? '  ← ' + r.note : '')
  )
}
// ★★GATES R2 — 게이트 행을 **두 번째 분모(박제 2.6.2)로 다시 판정한 표.**
//   화면에 안 보이면 없는 것과 같다 — JSON에만 두지 않는다.
const altRows = rows.filter((r) => r.alt)
if (altRows.length) {
  console.log('\n── ★★ GATES R2 — 같은 게이트를 **박제 분모**로 다시 판정 (분모 재사용의 흠을 판정 밖에 안 둔다) ──')
  console.log('  ' + w('지표', 42) + wr('박제 2.6.2', 12) + wr('비율', 8) + wr('여유%', 8) + '  판정')
  for (const r of altRows) {
    console.log('  ' + w(r.metric, 42) + wr(r.alt.electron, 12) + wr(r.alt.ratio, 8) +
      wr(r.alt.headroomPct == null ? '—' : r.alt.headroomPct.toFixed(1), 8) +
      '  ' + (r.alt.pass == null ? '(게이트 없음)' : r.alt.pass ? '통과' : '미달'))
  }
  console.log('  ⇒ ' + out.denomCheck?.verdict)
}
const failed = rows.filter((r) => r.pass === false).concat(altRows.filter((r) => r.alt.pass === false))
console.log(`\n★ 게이트 판정: ${rows.filter((r) => r.pass != null).length}칸 중 미달 ${failed.length}칸` +
  (failed.length ? ' — ' + [...new Set(failed.map((r) => r.metric))].join(' · ') : ' (전 칸 초록)'))
if (splitG2) {
  console.log('\n── ★★ GATES R2 — 유휴 LSP 헬퍼(오늘의 제품) ──')
  console.log(`  3.0   분류=${w(splitG2.mode, 10)} 같은순간=${w(splitG2.sameMoment, 6)} 헬퍼 ${wr(splitG2.helperCount, 2)}개  WS ${wr(splitG2.helperWsMB, 7)}  Priv ${wr(splitG2.helperPrivMB, 7)}`)
  for (const h of splitG2.hits) console.log(`         · ${h}`)
  if (!splitG2.hits.length) console.log('         · (없음 — 코드 뷰어를 안 열면 언어 서버가 애초에 안 뜬다)')
}
if (splitGT || splitGE) {
  console.log('\n── ★ GATES R1 — LSP 헬퍼 분류(명령줄 기반 · R1의 폐기된 잣대가 쓰던 수) ──')
  for (const [k, s] of [['3.0', splitGT], ['2.6.2', splitGE]]) {
    if (!s) continue
    console.log(`  ${w(k, 6)} 분류=${w(s.mode, 14)} 같은순간=${w(s.sameMoment, 6)} 헬퍼 ${wr(s.helperCount, 2)}개  WS ${wr(s.helperWsMB, 7)}  Priv ${wr(s.helperPrivMB, 7)}`)
    for (const h of s.hits) console.log(`         · ${h}`)
  }
}
if (out.paths?.dist && out.paths?.bench) {
  console.log('\n── ★ 벤치 경로 vs 배포 경로 (같은 exe · cwd/위치만 다름) ──')
  for (const [k, v] of [['배포', out.paths.dist], ['배포+MOD', out.paths.distWithModules], ['벤치', out.paths.bench], ['2.6.2', out.paths.electron]]) {
    if (v) console.log(`  ${w(k, 6)} cwd=${w(v.cwd, 46)} procs=${wr(v.procs, 3)} LSP헬퍼=${wr(v.helpers, 2)} WS=${wr(v.idleWs, 7)} Priv=${wr(v.idlePriv, 7)}`)
  }
}
if (appShare.tauri && appShare.electron) {
  console.log('\n── 앱 몫(바닥값 제외) ──')
  console.log(`  3.0   기준선 ${appShare.tauri.baselineWs} − 바닥 ${appShare.tauri.blankFloorWs} = 앱 몫 WS ${appShare.tauri.appWs} / Priv ${appShare.tauri.appPriv}`)
  console.log(`  2.6.2 기준선 ${appShare.electron.baselineWs} − 바닥 ${appShare.electron.blankFloorWs} = 앱 몫 WS ${appShare.electron.appWs} / Priv ${appShare.electron.appPriv}`)
}
if (rdT && rdE) {
  console.log('\n── ★ 앱 몫을 역할별로 (기준선 − 빈 문서) ──')
  const names = [...new Set([...Object.keys(rdT.roles), ...Object.keys(rdE.roles)])]
  console.log('  ' + w('역할', 26) + wr('3.0 ΔWS', 10) + wr('ΔPriv', 10) + wr('2.6.2 ΔWS', 12) + wr('ΔPriv', 10))
  for (const n of names) {
    const a = rdT.roles[n], b = rdE.roles[n]
    console.log('  ' + w(n, 26) + wr(a?.dWsMB, 10) + wr(a?.dPrivMB, 10) + wr(b?.dWsMB, 12) + wr(b?.dPrivMB, 10))
  }
  console.log('  ' + w('합(=앱 몫)', 26) + wr(rdT.sumDWsMB, 10) + wr(rdT.sumDPrivMB, 10) + wr(rdE.sumDWsMB, 12) + wr(rdE.sumDPrivMB, 10))
}
if (OUT) {
  const p = path.isAbsolute(OUT) ? OUT : path.join(REPO, OUT)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(out, null, 2))
  console.log('\nsaved:', p)
}
