// GATES R2 확인 크리틱 — 수치 전수 재계산 계기.
//
// 이 파일이 하는 일은 셋이다.
//  ① `ratios-gates-r2.json`의 **게이트 10칸 전부**를 원 결과 파일에서 다시 나눠 대조한다
//     (빌더의 산출물을 읽어 베끼는 게 아니라, 분자·분모를 각각의 원파일에서 다시 집어온다).
//  ② 「잣대 몫 / 제품 몫」 귀속을 **2×2 격자**로 편다. 보고서 §3은 이 격자의 네 칸 중
//     **셋만** 쓰고 넷째(R1 측정 × 있는 그대로)를 안 냈는데, 귀속 문장이 서는지 아닌지는
//     바로 그 넷째 칸이 정한다.
//  ③ 합격선을 **절대 MB 천장**으로 환산해 R1과 R2를 견준다. 비율 게이트는 분모가 바뀌면
//     같은 숫자라도 다른 잣대가 된다 — 「느슨해진 칸 0」이 어느 뜻에서 참인지 여기서 갈린다.
//
// 사용: node docs/critic/tools/critic-gates-r2-recompute.mjs [--json=<out>]
import fs from 'node:fs'
import path from 'node:path'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '../../..')
const R = (f) => JSON.parse(fs.readFileSync(path.join(REPO, 'bench/results', f), 'utf8'))
const r3 = (n) => (n == null || !isFinite(n) ? null : Math.round(n * 1000) / 1000)
const r1 = (n) => (n == null || !isFinite(n) ? null : Math.round(n * 10) / 10)

const out = { what: 'GATES R2 확인 크리틱 — 게이트 전 칸 독립 재계산 + 귀속 격자 + 절대 천장 대조', at: new Date().toISOString() }

// ── 원 결과 파일(빌더의 ratios 산출물이 아니라 **실측 파일**에서 집는다) ────────────
const t2 = R('multi-tauri-3.0.0-default-gates2-dist.json')   // 3.0 오늘(R2)
const t1 = R('multi-tauri-3.0.0-default-gates-dist.json')    // 3.0 어제(R1)
const eG = R('multi-electron-2.6.2-gates.json')              // 2.6.2 같은세션 분모
const eF = R('multi-electron-2.6.2.json')                    // 2.6.2 박제 분모
const cG2 = R('coldstart-gates2-dist.json')
const cE = R('coldstart-electron-2.6.2.json')
const pair = R('pair-coldstart.json')
const boot = R('boot-breakdown.json')
const fG2 = R('footprint-gates2.json')
const fBase = R('footprint.json')
const ratios = R('ratios-gates-r2.json')

// ── ① 중앙값이 정말 중앙값인가 ────────────────────────────────────────────────
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
out.medianCheck = {}
for (const [k, f] of [
  ['idleGridWsMB', (r) => r.idleGrid.totalWsMB], ['idleGridPrivMB', (r) => r.idleGrid.totalPrivMB],
  ['idleGridProcs', (r) => r.idleGrid.procs], ['idleWithWindowsWsMB', (r) => r.idleWithWindows.totalWsMB],
  ['idleWithWindowsPrivMB', (r) => r.idleWithWindows.totalPrivMB],
  ['wsMBPerWindow', (r) => r.windowCost.wsMBPerWindow], ['procsAdded', (r) => r.windowCost.procsAdded]
]) {
  const v = t2.perRun.map(f)
  out.medianCheck[k] = { runs: v, median: med(v), summary: t2.summary[k], ok: med(v) === t2.summary[k] }
}

// ── 유휴 헬퍼: R2 팔에 언어 서버가 정말 0인가(원 프로세스 표본에서 직접 센다) ──────
const isHelper = (p) => /typescript-language-server|tsserver\.js|pyright|conhost\.exe/i.test(String(p.cmdline || p.name || ''))
out.helperCount = {
  r2Idle: t2.perRun.map((r) => ({
    procs: r.procDetailIdle.length,
    helpers: r.procDetailIdle.filter(isHelper).length,
    names: r.procDetailIdle.map((p) => p.name)
  })),
  note: 'R2 유휴 표본에 node/conhost가 한 톨도 없으면 「처음부터 헬퍼 0」(온디맨드)이 관측된 것이다'
}

// ── ② 게이트 10칸 독립 재계산 ────────────────────────────────────────────────
const hr = (ratio, gate) => (gate === 0 || gate == null ? null : r3(((gate - ratio) / gate) * 100))
const G2 = { idleWs: 0.7, idlePriv: 0.6, withWindows: 0.6, perWindow: 0.25, procs: 1, coldRoot: 0.85, coldApp: 0.7, footprint: 0.25 }
const cells = []
const cell = (id, num, den, gate, altDen) => {
  const ratio = num / den
  const c = { id, num, den, ratio: r3(ratio), gate, pass: ratio <= gate, headroomPct: hr(ratio, gate) }
  if (altDen != null) { const ar = num / altDen; c.alt = { den: altDen, ratio: r3(ar), pass: ar <= gate, headroomPct: hr(ar, gate) } }
  cells.push(c); return c
}
cell('G1 유휴 WS', t2.summary.idleGridWsMB, eG.summary.idleGridWsMB, G2.idleWs, eF.idleGrid.totalWsMB)
cell('G3 유휴 Priv', t2.summary.idleGridPrivMB, eG.summary.idleGridPrivMB, G2.idlePriv, eF.idleGrid.totalPrivMB)
cell('G4 +창2 WS', t2.summary.idleWithWindowsWsMB, eG.summary.idleWithWindowsWsMB, G2.withWindows, eF.idleWithWindows.totalWsMB)
cell('G5 창당 WS', t2.summary.wsMBPerWindow, eG.summary.wsMBPerWindow, G2.perWindow, eF.windowCost.wsMBPerWindow)
cell('G1b 유휴 프로세스', t2.summary.idleGridProcs, eG.summary.idleGridProcs, G2.procs, eF.idleGrid.procs)
cell('G7 콜드 rootMs', cG2.medianRootMs, cE.medianRootMs, G2.coldRoot)
cell('G9 설치 폴더', fG2.installDirLogicalBytes, fBase.compare.installDirLogical.electron, G2.footprint)
out.gateCells = cells
out.g6 = { tauriProcsAdded: t2.summary.procsAdded, electronProcsAdded: eG.summary.procsAdded, pass: t2.summary.procsAdded === 0 }
out.g10 = { droppedPct: t2.summary.scrollAllPanels.worstDroppedPct, p95Ms: t2.summary.scrollAllPanels.p95Ms, fpsErrorRuns: t2.summary.fpsErrorRuns, pass: t2.summary.scrollAllPanels.worstDroppedPct === 0 && t2.summary.scrollAllPanels.p95Ms <= 25 }

// 빌더 산출물과의 칸별 대조
out.vsBuilder = ratios.rows.filter((r) => r.gate != null).map((r) => ({
  metric: r.metric, builderRatio: r.ratio, builderHeadroom: r.headroomPct,
  builderTauri: r.tauri, builderElectron: r.electron
}))

// ── ③ 귀속 2×2 격자 (유휴 WS · Private) ──────────────────────────────────────
// 헬퍼 몫: R1 팔은 3개(WS 115.5 / Priv 101.6) · R2 팔은 0 · 2.6.2는 2개(WS 208.3 / Priv 111.3)
const hlp = ratios.lspSplitGates
const grid = (numR1, numR2, denRaw, denMinus, gate, label) => ({
  label, gate,
  'R1측정 × LSP제외': { v: r3(numR1.minus / denMinus), pass: numR1.minus / denMinus <= gate },
  'R1측정 × 있는그대로': { v: r3(numR1.raw / denRaw), pass: numR1.raw / denRaw <= gate, note: '★보고서·산출물에 없는 칸' },
  'R2측정 × LSP제외': { v: r3(numR2.minus / denMinus), pass: numR2.minus / denMinus <= gate },
  'R2측정 × 있는그대로': { v: r3(numR2.raw / denRaw), pass: numR2.raw / denRaw <= gate }
})
out.attributionGrid = {
  idleWs: grid(
    { raw: t1.summary.idleGridWsMB, minus: t1.summary.idleGridWsMB - hlp.tauri.helperWsMB },
    { raw: t2.summary.idleGridWsMB, minus: t2.summary.idleGridWsMB - 0 },
    eG.summary.idleGridWsMB, eG.summary.idleGridWsMB - hlp.electron.helperWsMB, G2.idleWs, '유휴 WS'),
  idlePriv: grid(
    { raw: t1.summary.idleGridPrivMB, minus: t1.summary.idleGridPrivMB - hlp.tauri.helperPrivMB },
    { raw: t2.summary.idleGridPrivMB, minus: t2.summary.idleGridPrivMB - 0 },
    eG.summary.idleGridPrivMB, eG.summary.idleGridPrivMB - hlp.electron.helperPrivMB, G2.idlePriv, '유휴 Private'),
  note: '한 칸만 바꿔서 초록이 되는지 보라. 넷 중 초록이 하나뿐이면 두 변화가 **둘 다 필요조건**이고, 어느 하나에 「초록을 만들었다」를 귀속할 수 없다.'
}

// ── ④ 합격선을 절대 MB 천장으로 환산 — R1 vs R2 ──────────────────────────────
// 비율 게이트의 실질 강도는 `gate × 분모`다. 분모(잣대)가 바뀌면 같은 비율도 다른 천장이다.
const G1r = { idleWs: 0.7, idlePriv: 0.6, withWindows: 0.7, perWindow: 0.3, coldRoot: 0.85, footprint: 0.25, coldApp: 0.7 }
const ceil = (id, gateR1, denR1, gateR2, denR2, unit) => {
  const c1 = gateR1 * denR1, c2 = gateR2 * denR2
  return { id, unit, R1: { gate: gateR1, den: r1(denR1), ceiling: r1(c1) }, R2: { gate: gateR2, den: r1(denR2), ceiling: r1(c2) }, deltaCeiling: r1(c2 - c1), deltaPct: r3(((c2 - c1) / c1) * 100), verdict: c2 > c1 ? '★천장이 올라갔다(실질 완화)' : c2 < c1 ? '천장이 내려갔다(실질 조임)' : '동일' }
}
const eIdleWsMinus = eG.summary.idleGridWsMB - hlp.electron.helperWsMB
const eIdlePrivMinus = eG.summary.idleGridPrivMB - hlp.electron.helperPrivMB
const eWinWsMinus = eG.summary.idleWithWindowsWsMB - hlp.electronWindows.helperWsMB
out.ceilingCompare = [
  ceil('G1 유휴 WS', G1r.idleWs, eIdleWsMinus, G2.idleWs, eG.summary.idleGridWsMB, 'MB'),
  ceil('G3 유휴 Priv', G1r.idlePriv, eIdlePrivMinus, G2.idlePriv, eG.summary.idleGridPrivMB, 'MB'),
  ceil('G4 +창2 WS', G1r.withWindows, eWinWsMinus, G2.withWindows, eG.summary.idleWithWindowsWsMB, 'MB'),
  ceil('G5 창당 WS', G1r.perWindow, eG.summary.wsMBPerWindow, G2.perWindow, eG.summary.wsMBPerWindow, 'MB'),
  ceil('G7 콜드 rootMs', G1r.coldRoot, cE.medianRootMs, G2.coldRoot, cE.medianRootMs, 'ms'),
  ceil('G9 설치 폴더', G1r.footprint, fBase.compare.installDirLogical.electron, G2.footprint, fBase.compare.installDirLogical.electron, 'bytes'),
  ceil('G12 앱 몫 콜드', G1r.coldApp, 244, G2.coldApp, 244, 'ms')
]
out.ceilingNote = '「느슨해진 칸은 하나도 없다」는 **비율 숫자**에 대해서는 참이다. 위 표는 **천장(MB)**으로 같은 질문을 다시 한 것이다.'

// ── ⑤ G1 여유가 실제로 몇 MB인가 (보고서 §8-6의 「20MB」 검증) ────────────────
out.g1Slack = {
  ceilingSameSession: r1(G2.idleWs * eG.summary.idleGridWsMB),
  ceilingFrozen: r1(G2.idleWs * eF.idleGrid.totalWsMB),
  today: t2.summary.idleGridWsMB,
  worstRun: Math.max(...t2.perRun.map((r) => r.idleGrid.totalWsMB)),
  slackMBSameSession: r1(G2.idleWs * eG.summary.idleGridWsMB - t2.summary.idleGridWsMB),
  slackMBFrozen: r1(G2.idleWs * eF.idleGrid.totalWsMB - t2.summary.idleGridWsMB),
  reportClaim: '유휴 WS를 20MB 넘게 얹는 기능이 착지하면 이 칸이 먼저 붉어진다'
}

const outArg = (process.argv.find((a) => a.startsWith('--json=')) ?? '').split('=')[1]
if (outArg) fs.writeFileSync(path.resolve(REPO, outArg), JSON.stringify(out, null, 1))
console.log(JSON.stringify(out, null, 1))
