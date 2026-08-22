// R4 크리틱 — NetSvc2 **진짜** 재판정 A/B.
//
//   node docs/critic/tools/critic-r4-fpsab2.mjs [--rounds=4] [--trials=3]
//
// ## 왜 bench/fpsab.mjs를 그대로 쓰면 안 되나
// fpsab.mjs의 팔은 이렇다:
//   control = extraEnv {}                                  ← "제품 기본값"
//   lever   = CCG_WEBVIEW_ENABLE_FEATURES=NetworkServiceInProcess2
// 리드가 c673b15에서 그 feature를 `FEATURES_ON_ADOPTED`에 넣은 **뒤로는 control이
// 이미 레버를 켜고 있다.** 즉 두 팔이 같은 구성이고, 켠 위에 또 켜는 lever는 무동작이다.
// 실측(bench/results/critic-r4-fps-ab.json): 8회 부팅 전부 `procs=5` — 양 팔 동일.
// 하네스가 "레버가 붙었는지" 보려고 심어둔 프로세스 수 확인이 5 vs 5인데도 통과했다.
// §2.4·§8이 재판정 명령으로 지정한 그 한 줄이 **이제 자기 자신을 비교한다.**
//
// 여기서는 팔을 뒤집는다 — 끄는 쪽이 대조군이다:
//   off = CCG_WEBVIEW_DISABLE_FEATURES=NetworkServiceInProcess2  (disable이 enable을 이긴다)
//   on  = 제품 기본값(레버가 exe에 박혀 있다)
// 덤으로 §8이 "긴급 탈출구"라고 적은 그 환경변수가 실제로 프로세스를 되살리는지도
// 같은 실행에서 실증된다(역할 목록에 utility:NetworkService가 돌아오는가).
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { tauriProfile, connectMainPage, procTreeMem, killTree, median, sleep, envInfo, binInfo, REPO } from '../../../bench/lib.mjs'
import { makeMultiFixture } from '../../../bench/fixture.mjs'

const argOf = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d }
const rounds = Number(argOf('rounds', 4))
const trials = Number(argOf('trials', 3))
const HOME = path.join(REPO, '.bench-home-critic-fpsab')
const OUT = path.join(REPO, 'bench', 'results', 'critic-r4-fpsab-inverted.json')

const ARMS = [
  { name: 'netsvc-OFF', extraEnv: { CCG_WEBVIEW_DISABLE_FEATURES: 'NetworkServiceInProcess2' }, note: '대조군 — 레버를 끈다(=채택 전 구성)' },
  { name: 'netsvc-ON', extraEnv: {}, note: '제품 기본값 — 레버가 exe에 박혀 있다' }
]

const COLLECT = `(() => {
  window.__bench = { frames: [], long: 0, stop: false }
  const b = window.__bench
  let last = performance.now()
  function loop(t) { b.frames.push(t - last); last = t; if (!b.stop) requestAnimationFrame(loop) }
  requestAnimationFrame(loop)
  try { b.po = new PerformanceObserver((l) => { for (const e of l.getEntries()) b.long += e.duration }); b.po.observe({ entryTypes: ['longtask'] }) } catch (e) {}
  return true
})()`
const HARVEST = `(() => {
  const b = window.__bench; b.stop = true; if (b.po) b.po.disconnect()
  const f = b.frames.slice(5); if (!f.length) return null
  const s = [...f].sort((a, c) => a - c), sum = f.reduce((a, c) => a + c, 0)
  return { frames: f.length, avgFps: Math.round(1000 / (sum / f.length) * 10) / 10,
    p95Ms: Math.round(s[Math.floor(s.length * 0.95)] * 10) / 10,
    worstMs: Math.round(s[s.length - 1] * 10) / 10,
    droppedPct: Math.round(f.filter((x) => x > 33).length / f.length * 1000) / 10,
    droppedFrames: f.filter((x) => x > 33).length,
    longTaskMs: Math.round(b.long) }
})()`
const GLINFO = `(() => { try {
  const c = document.createElement('canvas'); const gl = c.getContext('webgl')
  const e = gl && gl.getExtension('WEBGL_debug_renderer_info')
  return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : (gl ? 'no-ext' : 'no-webgl')
} catch (err) { return 'err:' + err.message } })()`

async function fps(cdp, points, ms = 6000) {
  await cdp.eval(COLLECT)
  const end = performance.now() + ms
  let dir = -140
  let flip = performance.now() + ms / 2
  while (performance.now() < end) {
    if (performance.now() > flip) { dir = 140; flip = Infinity }
    for (const p of points) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: p.x, y: p.y, deltaX: 0, deltaY: dir })
    await sleep(16)
  }
  return await cdp.eval(HARVEST)
}

async function runArm(arm, round) {
  const profile = tauriProfile({ port: 9491, extraEnv: arm.extraEnv })
  profile.env.CCG_HOME = HOME
  const child = spawn(profile.cmd, profile.args, { env: { ...process.env, ...profile.env }, cwd: profile.cwd, stdio: 'ignore' })
  const row = { round, arm: arm.name, at: new Date().toISOString(), simple: [], load: [] }
  try {
    const cdp = await connectMainPage(profile.port, { timeoutMs: 45000 })
    for (;;) { if (await cdp.eval(profile.mountExpr).catch(() => false)) break; await sleep(100) }
    await sleep(12000)
    const mem = procTreeMem(child.pid, { role: true })
    row.procs = mem.procs?.length
    row.roles = mem.procs?.map((p) => `${p.role}${p.sub ? ':' + String(p.sub).replace(/^.*\.mojom\./, '') : ''}`).sort()
    row.hasNetworkService = !!row.roles?.some((r) => /NetworkService/i.test(r))
    row.wsMB = mem.totalWsMB
    row.privMB = mem.totalPrivMB
    row.glRenderer = await cdp.eval(GLINFO).catch(() => null)
    const pts = await cdp.eval(`(() => [...document.querySelectorAll('.ma-p-thread')].map((el) => {
      const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } }))()`)
    row.panels = pts?.length ?? 0
    for (let t = 0; t < trials; t++) {
      row.simple.push(await fps(cdp, [pts[0]]))
      await sleep(1200)
      row.load.push(await fps(cdp, pts))
      await sleep(1200)
    }
    cdp.close()
  } catch (e) { row.error = String(e?.message ?? e) }
  killTree(child.pid)
  await sleep(2000)
  const f = (k, m) => median(row[k].map((r) => r?.[m]))
  console.log(`  ${arm.name.padEnd(11)} procs=${row.procs} netsvc=${row.hasNetworkService} ws=${row.wsMB} priv=${row.privMB} simple ${f('simple', 'avgFps')}fps load ${f('load', 'avgFps')}fps`)
  return row
}

fs.rmSync(HOME, { recursive: true, force: true })
makeMultiFixture(HOME, '3.0.0-beta.1', { panels: 4 })

const all = []
console.log('warmup (버리는 부팅) …')
await runArm(ARMS[0], 0)
for (let r = 1; r <= rounds; r++) {
  console.log(`round ${r}/${rounds}`)
  for (const arm of ARMS) all.push(await runArm(arm, r))
}

// 정확한(반올림 없는) 중앙값 — bench/lib.mjs의 median()은 짝수 길이에서 Math.round를 건다.
const exactMed = (a) => { const s = a.filter((x) => x != null).sort((x, y) => x - y); if (!s.length) return null
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round(((s[s.length / 2 - 1] + s[s.length / 2]) / 2) * 100) / 100 }

function agg(name, kind) {
  const flat = all.filter((r) => r.arm === name).flatMap((r) => r[kind]).filter(Boolean)
  return {
    trials: flat.length,
    medianAvgFps: exactMed(flat.map((r) => r.avgFps)),
    minAvgFps: Math.min(...flat.map((r) => r.avgFps)),
    medianP95Ms: exactMed(flat.map((r) => r.p95Ms)),
    worstFrameMs: Math.max(...flat.map((r) => r.worstMs)),
    worstDroppedPct: Math.max(...flat.map((r) => r.droppedPct)),
    zeroDropTrials: flat.filter((r) => r.droppedPct === 0).length,
    droppedFramesTotal: flat.reduce((a, r) => a + (r.droppedFrames ?? 0), 0),
    perTrialAvgFps: flat.map((r) => r.avgFps)
  }
}
function paired(kind) {
  const d = []
  for (let r = 1; r <= rounds; r++) {
    const c = all.find((x) => x.round === r && x.arm === 'netsvc-OFF')
    const l = all.find((x) => x.round === r && x.arm === 'netsvc-ON')
    if (!c || !l) continue
    const cf = exactMed(c[kind].map((x) => x?.avgFps))
    const lf = exactMed(l[kind].map((x) => x?.avgFps))
    if (cf != null && lf != null) d.push({ round: r, offFps: cf, onFps: lf, deltaFps: Math.round((lf - cf) * 100) / 100 })
  }
  return d
}

const out = {
  what: 'NetSvc2 재판정 — 팔을 뒤집은 교대 A/B(off=대조군). bench/fpsab.mjs는 채택 이후 두 팔이 같아져 무효다.',
  arms: ARMS.map((a) => ({ name: a.name, env: a.extraEnv, note: a.note })),
  rounds, trials,
  bin: binInfo(tauriProfile({}).cmd),
  env: envInfo(),
  leverAttached: {
    what: '§8의 긴급 탈출구(CCG_WEBVIEW_DISABLE_FEATURES)가 실제로 프로세스를 되살리는가',
    offProcs: all.filter((r) => r.arm === 'netsvc-OFF').map((r) => r.procs),
    onProcs: all.filter((r) => r.arm === 'netsvc-ON').map((r) => r.procs),
    offHasNetworkService: all.filter((r) => r.arm === 'netsvc-OFF').map((r) => r.hasNetworkService),
    onHasNetworkService: all.filter((r) => r.arm === 'netsvc-ON').map((r) => r.hasNetworkService),
    offRoles: all.find((r) => r.arm === 'netsvc-OFF')?.roles,
    onRoles: all.find((r) => r.arm === 'netsvc-ON')?.roles
  },
  memory: {
    offWsMB: exactMed(all.filter((r) => r.arm === 'netsvc-OFF').map((r) => r.wsMB)),
    onWsMB: exactMed(all.filter((r) => r.arm === 'netsvc-ON').map((r) => r.wsMB)),
    offPrivMB: exactMed(all.filter((r) => r.arm === 'netsvc-OFF').map((r) => r.privMB)),
    onPrivMB: exactMed(all.filter((r) => r.arm === 'netsvc-ON').map((r) => r.privMB))
  },
  summary: {
    off: { simple: agg('netsvc-OFF', 'simple'), load: agg('netsvc-OFF', 'load') },
    on: { simple: agg('netsvc-ON', 'simple'), load: agg('netsvc-ON', 'load') }
  },
  pairedSimple: paired('simple'),
  pairedLoad: paired('load'),
  perBoot: all,
  at: new Date().toISOString()
}
const ds = out.pairedSimple.map((x) => x.deltaFps)
const dl = out.pairedLoad.map((x) => x.deltaFps)
out.pairedStats = {
  simpleMedian: exactMed(ds), simpleMean: Math.round((ds.reduce((a, b) => a + b, 0) / ds.length) * 100) / 100, simpleRange: [Math.min(...ds), Math.max(...ds)],
  loadMedian: exactMed(dl), loadMean: Math.round((dl.reduce((a, b) => a + b, 0) / dl.length) * 100) / 100, loadRange: [Math.min(...dl), Math.max(...dl)]
}
fs.writeFileSync(OUT, JSON.stringify(out, null, 2))
console.log('\n' + JSON.stringify({ leverAttached: out.leverAttached, memory: out.memory, pairedStats: out.pairedStats, pairedSimple: out.pairedSimple, pairedLoad: out.pairedLoad }, null, 2))
console.log('saved:', path.relative(REPO, OUT))
process.exit(0)
