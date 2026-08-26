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
// ★ 「앱 몫」 비율이 이 파일의 진짜 목적이다.
//   총량 비율은 두 앱이 **어쩔 수 없이 지고 가는 런타임 바닥값**을 분자·분모에 같이
//   담는다. 바닥값을 빼면 남는 것이 우리가 쓴 코드의 값이고, 그 비율이 엔지니어링 성과다.
//   바닥값은 두 앱 모두 `bench/gpuprobe.mjs`의 6단계(`about:blank` 언로드 + DOM·리스너
//   90% 감소 검증)로 **같은 방법으로** 쟀다.
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
  t30MultiNew: 'multi-tauri-3.0.0-default-r28jdec.json', // 3.0 주 게이트(R28j 재측정)
  e26MultiNew: 'multi-electron-2.6.2-default-r28jdec.json', // 2.6.2 주 게이트(R28j 재측정 · 같은 세션)
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
  rows.push({ metric, tauri: r2(tauri), electron: r2(electron), ratio: r3(ratio), gate, pass: gate == null || ratio == null ? null : (lower ? ratio <= gate : ratio >= gate), from, note })
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
  add('[R28j·LSP제외] 유휴 WS', tN.idleGridWsMB - splitT.helperWsMB, eN.idleGridWsMB - splitE.helperWsMB, { gate: G.idleWs, from: 'summary − procDetail의 헬퍼(node/conhost) 합', note: '두 팔에서 같은 규칙으로 뺀다' })
  add('[R28j·LSP제외] 유휴 Private', tN.idleGridPrivMB - splitT.helperPrivMB, eN.idleGridPrivMB - splitE.helperPrivMB, { gate: G.idlePriv, from: 'summary − procDetail 헬퍼' })
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
    'G2 유휴 WS(있는 그대로)': '게이트 아님 — 공시만(픽스처 비대칭 · decisions-3.0.md §1.6-A)',
    'G3 유휴 Private(LSP 제외)': G.idlePriv,
    'G4 +창2 WS': G.withWindows,
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
  appShare,
  webRuntimeBootFloorMs: { tauri: bootT, electron: bootE, source: SRC.boot }
}

const w = (s, n) => String(s ?? '—').padEnd(n)
const wr = (s, n) => String(s ?? '—').padStart(n)
console.log('──── 비율 재계산 (측정 없음 · 커밋된 결과 파일의 산술) ────')
console.log(w('지표', 40) + wr('3.0', 10) + wr('2.6.2', 10) + wr('비율', 8) + wr('제안선', 8) + '  판정')
for (const r of rows) {
  console.log(
    w(r.metric, 40) + wr(r.tauri, 10) + wr(r.electron, 10) + wr(r.ratio, 8) + wr(r.gate ?? '—', 8) +
      '  ' + (r.pass == null ? '(게이트 없음)' : r.pass ? '통과' : '미달') + (r.note ? '  ← ' + r.note : '')
  )
}
if (appShare.tauri && appShare.electron) {
  console.log('\n── 앱 몫(바닥값 제외) ──')
  console.log(`  3.0   기준선 ${appShare.tauri.baselineWs} − 바닥 ${appShare.tauri.blankFloorWs} = 앱 몫 WS ${appShare.tauri.appWs} / Priv ${appShare.tauri.appPriv}`)
  console.log(`  2.6.2 기준선 ${appShare.electron.baselineWs} − 바닥 ${appShare.electron.blankFloorWs} = 앱 몫 WS ${appShare.electron.appWs} / Priv ${appShare.electron.appPriv}`)
}
if (OUT) {
  const p = path.isAbsolute(OUT) ? OUT : path.join(REPO, OUT)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(out, null, 2))
  console.log('\nsaved:', p)
}
