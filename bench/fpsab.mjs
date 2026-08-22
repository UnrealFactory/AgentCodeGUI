// 교대(A-B-A-B) FPS 하네스 — R3 크리틱 §9-4 결함의 답.
//
//   node bench/fpsab.mjs [--rounds=4] [--trials=3] [--lever=NetworkServiceInProcess2]
//
// ## 왜 필요한가
// multi.mjs의 FPS는 **팔마다 별도 세션**이라 세션 간 밴드 이동을 못 거른다. 크리틱이
// 실제로 밟았다: 같은 코드·같은 팔이 한 배치에서 60fps/16.8ms, 다음 배치에서 57fps/21ms.
// 그 상태에서 새 레버(NetworkServiceInProcess2)의 FPS를 재니 50.8~59.0으로 흔들려
// **판정 불가**가 됐다.
//
// ## 방법
//  - 한 라운드 = 대조군 부팅 → K회 시행 → 종료 → 레버 부팅 → K회 시행 → 종료.
//    라운드를 N번 돌린다(A-B-A-B-…). 기계 상태가 밴드째 움직여도 두 팔이 같은
//    시간대를 나눠 갖는다.
//  - 시행마다 **두 종류**를 잰다:
//      simple = 패널 하나 스크롤(기존 게이트와 같은 무대)
//      load   = **4패널 동시 스크롤**(부하 팔). 한 패널만 굴리면 두 앱 다 p95 16.8ms로
//               붙어 실패 경계 근처에 가지 않는다 = 게이트가 정보를 안 준다.
//  - 팔이 **실제로 붙었는지** 매 부팅마다 확인한다(프로세스 수 + WebGL renderer 문자열).
//    레버가 조용히 무시된 채 "차이 없음"으로 결론 내는 사고를 막는다.
//  - 판정: 짝지은 라운드 차이(paired)로 본다. 절대값이 아니라 **같은 라운드 안에서의 차**다.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  tauriProfile, connectMainPage, procTreeMem, killTree, median, sleep, envInfo, binInfo, REPO
} from './lib.mjs'
import { makeMultiFixture } from './fixture.mjs'

const argOf = (k, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${k}=`))
  return a ? a.split('=').slice(1).join('=') : d
}
const rounds = Number(argOf('rounds', 4))
const trials = Number(argOf('trials', 3))
const leverFeature = argOf('lever', 'NetworkServiceInProcess2')
const HOME = path.join(REPO, '.bench-home-fpsab')
// 고정 파일명 금지(R4 크리틱 §3.1) — `fps-ab.json` 한 자리에 쓰던 탓에 리드의 재실행이
// R4 §2.3 표의 **근거 파일을 통째로 지웠다**(`git show ce1c735:…`로만 복원된다).
// 기본값에도 레버 이름과 실행 시각을 박는다. `--out=이름` 으로 직접 줄 수도 있다.
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-')
const outName = (argOf('out', '') || `fps-ab-${leverFeature}-${stamp}`).replace(/\.json$/, '')
const OUT = path.join(REPO, 'bench', 'results', `${outName}.json`)

const ARMS = [
  { name: 'control', extraEnv: {}, note: '제품 채택 세트(--process-per-site --in-process-gpu)' },
  { name: 'lever', extraEnv: { CCG_WEBVIEW_ENABLE_FEATURES: leverFeature }, note: `채택 세트 + --enable-features=${leverFeature}` }
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
    for (const p of points) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: p.x, y: p.y, deltaX: 0, deltaY: dir })
    }
    await sleep(16)
  }
  return await cdp.eval(HARVEST)
}

async function runArm(arm, round) {
  const profile = tauriProfile({ port: 9451, extraEnv: arm.extraEnv })
  profile.env.CCG_HOME = HOME
  const child = spawn(profile.cmd, profile.args, {
    env: { ...process.env, ...profile.env }, cwd: profile.cwd, stdio: 'ignore'
  })
  const row = { round, arm: arm.name, at: new Date().toISOString(), simple: [], load: [] }
  try {
    const cdp = await connectMainPage(profile.port, { timeoutMs: 45000 })
    for (;;) { if (await cdp.eval(profile.mountExpr).catch(() => false)) break; await sleep(100) }
    await sleep(12000)

    // 팔이 실제로 붙었는지 — 프로세스 수·GPU 백엔드
    const mem = procTreeMem(child.pid, { role: true })
    row.procs = mem.procs?.length
    row.roles = mem.procs?.map((p) => `${p.role}${p.sub ? ':' + String(p.sub).replace(/^.*\.mojom\./, '') : ''}`).sort()
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
  } catch (e) {
    row.error = String(e?.message ?? e)
  }
  killTree(child.pid)
  await sleep(2000)
  const f = (k, m) => median(row[k].map((r) => r?.[m]))
  console.log(
    `  ${arm.name.padEnd(8)} procs=${row.procs} simple ${f('simple', 'avgFps')}fps/${f('simple', 'p95Ms')}ms drop=${Math.max(...row.simple.map((r) => r?.droppedPct ?? 0))}%  ` +
    `load ${f('load', 'avgFps')}fps/${f('load', 'p95Ms')}ms drop=${Math.max(...row.load.map((r) => r?.droppedPct ?? 0))}%`
  )
  return row
}

fs.rmSync(HOME, { recursive: true, force: true })
makeMultiFixture(HOME, '3.0.0-beta.1', { panels: 4 })

const all = []
// 워밍업 — WebView2 프로필 생성 비용이 첫 팔에만 실리지 않게 한 번 버린다.
console.log('warmup (버리는 부팅) …')
await runArm(ARMS[0], 0)

for (let r = 1; r <= rounds; r++) {
  console.log(`round ${r}/${rounds}`)
  for (const arm of ARMS) all.push(await runArm(arm, r))
}

function agg(name, kind) {
  const rows = all.filter((r) => r.arm === name)
  const flat = rows.flatMap((r) => r[kind]).filter(Boolean)
  return {
    trials: flat.length,
    medianAvgFps: median(flat.map((r) => r.avgFps)),
    minAvgFps: Math.min(...flat.map((r) => r.avgFps)),
    medianP95Ms: median(flat.map((r) => r.p95Ms)),
    worstFrameMs: Math.max(...flat.map((r) => r.worstMs)),
    worstDroppedPct: Math.max(...flat.map((r) => r.droppedPct)),
    zeroDropTrials: flat.filter((r) => r.droppedPct === 0).length,
    droppedFramesTotal: flat.reduce((a, r) => a + (r.droppedFrames ?? 0), 0),
    perTrialAvgFps: flat.map((r) => r.avgFps)
  }
}

// 짝지은 라운드 차 — 밴드 이동에 둔감한 판정
function paired(kind) {
  const d = []
  for (let r = 1; r <= rounds; r++) {
    const c = all.find((x) => x.round === r && x.arm === 'control')
    const l = all.find((x) => x.round === r && x.arm === 'lever')
    if (!c || !l) continue
    const cf = median(c[kind].map((x) => x?.avgFps))
    const lf = median(l[kind].map((x) => x?.avgFps))
    if (cf != null && lf != null) d.push({ round: r, controlFps: cf, leverFps: lf, deltaFps: Math.round((lf - cf) * 10) / 10 })
  }
  return d
}

const out = {
  what: '교대(A-B-A-B) FPS 판정 — 세션 간 밴드 이동을 제거하고 부하 팔(4패널 동시 스크롤)을 추가',
  lever: leverFeature,
  rounds, trials,
  bin: binInfo(tauriProfile({}).cmd),
  env: envInfo(),
  summary: {
    control: { simple: agg('control', 'simple'), load: agg('control', 'load') },
    lever: { simple: agg('lever', 'simple'), load: agg('lever', 'load') }
  },
  pairedSimple: paired('simple'),
  pairedLoad: paired('load'),
  perBoot: all,
  at: new Date().toISOString()
}
// 게이트: 60fps·드랍 0%
const gate = (a) => ({
  fps60: a.medianAvgFps >= 59.0,
  drop0: a.worstDroppedPct === 0,
  minAvgFps: a.minAvgFps
})
out.verdict = {
  controlSimple: gate(out.summary.control.simple),
  controlLoad: gate(out.summary.control.load),
  leverSimple: gate(out.summary.lever.simple),
  leverLoad: gate(out.summary.lever.load)
}
fs.writeFileSync(OUT, JSON.stringify(out, null, 2))
console.log('\n' + JSON.stringify({ summary: out.summary, verdict: out.verdict, pairedSimple: out.pairedSimple, pairedLoad: out.pairedLoad }, null, 2))
console.log('saved:', path.relative(REPO, OUT))
