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
const add = (metric, tauri, electron, { lower = true, from, note, gate } = {}) => {
  const ratio = div(tauri, electron)
  // ★ 여유(headroom)는 **기계가 낸다.** 「G1·G3·G4는 오늘 값에 8~15% 여유」라고 손으로
  //   적었다가 G4가 실제로 2.3%였던 사고(확인 크리틱 S3-1)를 구조적으로 막는 자리다.
  const headroomPct = gate == null || ratio == null || typeof gate !== 'number' ? null : r3(((gate - ratio) / gate) * 100)
  rows.push({
    metric, tauri: r2(tauri), electron: r2(electron), ratio: r3(ratio), gate,
    pass: gate == null || typeof gate !== 'number' || ratio == null ? null : (lower ? ratio <= gate : ratio >= gate),
    headroomPct, from, note
  })
}

// ── 1. 주 게이트(멀티 4패널) ─────────────────────────────────────────────────
const e = F.e26Multi
const t4 = F.t30MultiR4?.summary
// ★ `gate`는 **제안 합격선**이다(docs/decisions-3.0.md §1.5의 G1~G12).
//   결정되면 이 숫자만 바꾸면 판정이 따라온다.
const G = { idleWs: 0.7, idlePriv: 0.6, withWindows: 0.7, perWindow: 0.3, coldRoot: 0.85, coldApp: 0.7, footprint: 0.1 }
if (e && t4) {
  add('멀티 4패널 유휴 WS', t4.idleGridWsMB, e.idleGrid?.totalWsMB, { gate: G.idleWs, from: `${SRC.t30MultiR4}.summary.idleGridWsMB ÷ ${SRC.e26Multi}.idleGrid.totalWsMB` })
  add('멀티 4패널 유휴 Private', t4.idleGridPrivMB, e.idleGrid?.totalPrivMB, { gate: G.idlePriv, from: `${SRC.t30MultiR4} ÷ ${SRC.e26Multi}` })
  add('+추가 창 2개 WS', t4.idleWithWindowsWsMB, e.idleWithWindows?.totalWsMB, { gate: G.withWindows, from: `${SRC.t30MultiR4} ÷ ${SRC.e26Multi}` })
  add('창 1개 추가 비용(WS)', t4.wsMBPerWindow, e.windowCost?.wsMBPerWindow, { gate: G.perWindow, from: `${SRC.t30MultiR4} ÷ ${SRC.e26Multi}` })
  add('유휴 프로세스 수', t4.idleGridProcs, e.idleGrid?.procs, { gate: 1, from: `${SRC.t30MultiR4} ÷ ${SRC.e26Multi}` })
}
// ★ S3-2 — 같은 지표의 **대안 출처**. `final-parity-r1.md` §4.1이 WS는 크리틱 R4 파일에서,
//   Private은 이 파일에서 가져와 **섞여 있었다.** 「한 파일로 통일한다」는 정정은 통일
//   **방향이 둘**이고, 어느 쪽을 골랐는지가 결과를 바꾼다. 그래서 둘 다 낸다 — 고른 쪽만
//   싣는 것은 선택을 감추는 것이다. (대안 쪽 exe가 더 새것이고 트리도 `gitDirty:false`다.)
const tAlt = F.t30MultiAlt?.summary
if (e && tAlt) {
  add('[대안 출처] 멀티 4패널 유휴 WS', tAlt.idleGridWsMB, e.idleGrid?.totalWsMB, { gate: G.idleWs, from: `${SRC.t30MultiAlt} ÷ ${SRC.e26Multi}`, note: `exe ${F.t30MultiAlt?.bin?.exeSha256}·${F.t30MultiAlt?.bin?.gitHead}·dirty=${F.t30MultiAlt?.bin?.gitDirty}` })
  add('[대안 출처] 멀티 4패널 유휴 Private', tAlt.idleGridPrivMB, e.idleGrid?.totalPrivMB, { gate: G.idlePriv, from: `${SRC.t30MultiAlt} ÷ ${SRC.e26Multi}`, note: '253.2의 진짜 출처 — 파리티 감사가 인용한 0.50이 여기서 나왔다' })
  add('[대안 출처] 창 1개 추가 비용(WS)', tAlt.wsMBPerWindow, e.windowCost?.wsMBPerWindow, { gate: G.perWindow, from: `${SRC.t30MultiAlt} ÷ ${SRC.e26Multi}` })
}
// R28j 재측정(같은 세션 두 팔) — 파일이 있을 때만
const tN = F.t30MultiNew?.summary
const eN = F.e26MultiNew?.summary
if (tN && eN) {
  add('[R28j 같은세션] 유휴 WS(있는 그대로)', tN.idleGridWsMB, eN.idleGridWsMB, { gate: null, from: `${SRC.t30MultiNew} ÷ ${SRC.e26MultiNew}` })
  add('[R28j 같은세션] 유휴 Private(있는 그대로)', tN.idleGridPrivMB, eN.idleGridPrivMB, { gate: null, from: `${SRC.t30MultiNew} ÷ ${SRC.e26MultiNew}` })
  add('[R28j 같은세션] +창2 WS', tN.idleWithWindowsWsMB, eN.idleWithWindowsWsMB, { gate: G.withWindows, from: `${SRC.t30MultiNew} ÷ ${SRC.e26MultiNew}` })
  add('[R28j 같은세션] 창당 비용', tN.wsMBPerWindow, eN.wsMBPerWindow, { gate: G.perWindow, from: `${SRC.t30MultiNew} ÷ ${SRC.e26MultiNew}` })
}

// ── 1b. ★ LSP 헬퍼 프로세스 분리 — 주 게이트가 두 앱에서 같은 것을 재는가 ────
// R28j 실측: 3.0은 부팅 때 LSP를 프리웜한다(`ipc/lsp.rs boot_prewarm` — 활성 채팅의 cwd를
// 읽어 스스로 부른다). 서버는 `Provision::Bundled`라 앱 옆 node_modules에서 바로 뜬다.
// 2.6.2는 같은 프리웜을 **렌더러에서** 부르지만 서버가 앱 홈에 설치돼 있어야 뜨고,
// 벤치 픽스처 홈은 비어 있어 **안 뜬다.** 그래서 같은 픽스처가 3.0에만 node.exe 2개(+conhost)를
// 얹는다 — 두 팔이 같은 것을 재고 있지 않다. 수를 나눠 싣는 이유다.
const HELPER = /^(node|conhost|python|pyright|clangd|Microsoft\.CodeAnalysis)/i
function lspSplit(j) {
  const runs = j?.perRun ?? []
  const per = runs.map((r) => {
    const d = r.procDetail ?? []
    const h = d.filter((p) => HELPER.test(p.name))
    return {
      procs: d.length,
      helpers: h.length,
      helperWsMB: r2(h.reduce((a, p) => a + (p.wsMB ?? 0), 0)),
      helperPrivMB: r2(h.reduce((a, p) => a + (p.privMB ?? 0), 0)),
      names: h.map((p) => p.name)
    }
  })
  if (!per.length) return null
  const mid = (k) => { const a = per.map((x) => x[k]).sort((x, y) => x - y); return a[Math.floor(a.length / 2)] }
  return { runs: per.length, helperCount: mid('helpers'), helperWsMB: mid('helperWsMB'), helperPrivMB: mid('helperPrivMB'), names: [...new Set(per.flatMap((p) => p.names))], per }
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
  const LSP_APPROX = '★근사 — 피감수는 정착 직후 summary, 감수는 주행 끝 procDetail(서로 다른 순간). 두 팔에 같은 규칙'
  add('[R28j·LSP제외] 유휴 WS', tN.idleGridWsMB - splitT.helperWsMB, eN.idleGridWsMB - splitE.helperWsMB, { gate: G.idleWs, from: 'summary − procDetail의 헬퍼(node/conhost) 합', note: LSP_APPROX })
  add('[R28j·LSP제외] 유휴 Private', tN.idleGridPrivMB - splitT.helperPrivMB, eN.idleGridPrivMB - splitE.helperPrivMB, { gate: G.idlePriv, from: 'summary − procDetail 헬퍼', note: LSP_APPROX })
  // ★ S3-1 — G4(+창2)도 **같은 자로** 뺀다. 한 표 안에서 G1은 LSP 제외, G4는 있는 그대로면
  //   그건 잣대가 아니라 서술이다.
  add('[R28j·LSP제외] +창2 WS', tN.idleWithWindowsWsMB - splitT.helperWsMB, eN.idleWithWindowsWsMB - splitE.helperWsMB, { gate: G.withWindows, from: 'summary.idleWithWindowsWsMB − procDetail 헬퍼', note: 'G1과 같은 자. 있는 그대로와 섞어 읽지 말 것 · ' + LSP_APPROX })
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
  add('★[배포 경로] 유휴 WS — 오늘 사용자가 겪는 값', tDist.idleGridWsMB, eR1.idleGridWsMB, { gate: G.idleWs, from: `${SRC.t30MultiDist} ÷ ${SRC.e26MultiR1}`, note: `LSP 헬퍼 3.0=${splitDist?.helperCount} / 2.6.2=${splitER1?.helperCount}` })
  add('★[배포 경로] 유휴 Private', tDist.idleGridPrivMB, eR1.idleGridPrivMB, { gate: G.idlePriv, from: `${SRC.t30MultiDist} ÷ ${SRC.e26MultiR1}` })
  add('★[배포 경로] +창2 WS', tDist.idleWithWindowsWsMB, eR1.idleWithWindowsWsMB, { gate: G.withWindows, from: `${SRC.t30MultiDist} ÷ ${SRC.e26MultiR1}` })
  add('★[배포 경로] 창 1개 추가 비용', tDist.wsMBPerWindow, eR1.wsMBPerWindow, { gate: G.perWindow, from: `${SRC.t30MultiDist} ÷ ${SRC.e26MultiR1}` })
}
if (tBench && eR1) {
  add('[벤치 경로] 유휴 WS(있는 그대로)', tBench.idleGridWsMB, eR1.idleGridWsMB, { gate: null, from: `${SRC.t30MultiBench} ÷ ${SRC.e26MultiR1}`, note: `헬퍼 ${splitBench?.helperCount}개가 얹힌 상태 — 배포본에 없는 상태다` })
  add('[벤치 경로] 유휴 Private(있는 그대로)', tBench.idleGridPrivMB, eR1.idleGridPrivMB, { gate: null, from: `${SRC.t30MultiBench} ÷ ${SRC.e26MultiR1}` })
}

// ── 2. 콜드 스타트 ───────────────────────────────────────────────────────────
const cp = F.coldPair?.summary
if (F.coldE26 && cp) {
  add('콜드 첫 가시 창(박제 분모 · ★비대칭)', cp.tauri?.winMs, F.coldE26.medianWinMs, { gate: null, from: `${SRC.coldPair}.summary.tauri.winMs ÷ ${SRC.coldE26}.medianWinMs`, note: '3.0=본 창 / 2.6.2=300×240 스플래시 — 서로 다른 사건. 게이트로 쓰지 말 것' })
  add('콜드 UI 사용 가능 rootMs(박제 분모)', cp.tauri?.rootMs, F.coldE26.medianRootMs, { gate: G.coldRoot, from: `${SRC.coldPair} ÷ ${SRC.coldE26}` })
}
if (cp) {
  add('콜드 첫 가시 창(교대 · ★비대칭)', cp.tauri?.winMs, cp.electron?.winMs, { gate: null, from: `${SRC.coldPair}.summary`, note: '위와 같은 비대칭' })
  add('콜드 UI 사용 가능 rootMs(교대)', cp.tauri?.rootMs, cp.electron?.rootMs, { gate: G.coldRoot, from: `${SRC.coldPair}.summary` })
}

// ── 3. 설치 풋프린트 ─────────────────────────────────────────────────────────
if (F.foot?.compare) {
  const c = F.foot.compare
  add('설치본 파일 크기', c.installerBytes?.tauri, c.installerBytes?.electron, { gate: G.footprint, from: `${SRC.foot}.compare.installerBytes` })
  add('설치 폴더(논리)', c.installDirLogical?.tauri, c.installDirLogical?.electron, { gate: G.footprint, from: `${SRC.foot}.compare.installDirLogical` })
  add('설치 폴더(할당 4K)', c.installDirAlloc?.tauri, c.installDirAlloc?.electron, { gate: G.footprint, from: `${SRC.foot}.compare.installDirAlloc` })
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
  proposedGates: {
    note: '★제안이다 — 결정은 사용자 몫(docs/decisions-3.0.md §1.5)',
    'G1 주게이트 유휴 WS(LSP 헬퍼 제외)': G.idleWs,
    'G2 유휴 WS(★배포 경로 실측 = 오늘 사용자가 겪는 값)': G.idleWs,
    'G2b 유휴 WS(벤치 경로·있는 그대로)': '게이트 아님 — 공시만. 배포본에 없는 상태다(decisions-3.0.md §1.4·§1.6-A)',
    'G3 유휴 Private(LSP 제외)': G.idlePriv,
    'G4 +창2 WS(★G1과 같은 자 — LSP 제외)': G.withWindows,
    'G5 창당 비용 WS': G.perWindow,
    'G6 창당 프로세스': '= 0 (절대)',
    'G7 콜드 rootMs': G.coldRoot,
    'G8 콜드 첫 가시 창': '게이트에서 내림 — 두 앱이 다른 사건을 잰다',
    'G9 설치 풋프린트': G.footprint,
    'G10 FPS': '드랍 0% + p95 ≤ 25ms (절대 · avgFps는 세션 속성이라 게이트 부적합)',
    'G11 앱 몫 WS': '게이트 아님 — 관측만',
    'G12 앱 몫 콜드': G.coldApp
  },
  rows,
  lspSplit: { tauri: splitT, electron: splitE, note: '헬퍼 = procDetail에서 node/conhost/clangd/roslyn 계열. 3.0만 부팅 프리웜으로 뜬다(R28j 실측)' },
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
console.log(w('지표', 44) + wr('3.0', 10) + wr('2.6.2', 10) + wr('비율', 8) + wr('제안선', 8) + wr('여유%', 8) + '  판정')
for (const r of rows) {
  console.log(
    w(r.metric, 44) + wr(r.tauri, 10) + wr(r.electron, 10) + wr(r.ratio, 8) + wr(typeof r.gate === 'number' ? r.gate : '—', 8) +
      wr(r.headroomPct == null ? '—' : r.headroomPct.toFixed(1), 8) +
      '  ' + (r.pass == null ? '(게이트 없음)' : r.pass ? '통과' : '미달') + (r.note ? '  ← ' + r.note : '')
  )
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
