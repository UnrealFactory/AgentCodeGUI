// 확인 크리틱 계기 ① — **눈금 자체를 공격한다**.
//
//   node docs/critic/tools/critic-fps144-gauge.mjs --exe=PATH [--cwd=DIR] [--port=11141]
//        [--ms=4000] [--out=NAME]
//
// 빌더 주장: rAF 콜백 안에서 MessageChannel로 t0을 쏘면 그 메시지 태스크는 커밋 뒤에
// 돌고, t1-t0 = 프레임 메인 스레드 **작업 시간**이며 **vsync 대기가 안 섞인다**.
//
// 이 계기는 그 주장을 네 갈래로 시험한다.
//  (L) 선형성 — rAF 안에 **인위 바쁜 대기 X ms**를 심고 눈금이 base+X를 읽는지.
//      vsync 대기가 섞여 있다면 X가 늘어도 눈금은 프레임 주기(16.67ms)에 붙어 있을 것이다.
//  (O) 순서 민감도 — 같은 부하를 눈금 **앞**에 등록하면 눈금이 그것을 못 본다(=하한 한계).
//      그 크기를 실측해 「과소평가 폭」을 숫자로 못 박는다.
//  (S) 포화 — X를 프레임 주기보다 크게(25ms) 주면 gap은 33ms로 튀고 work는 25ms+를 읽는가.
//  (T) CDP Tracing 대조 — 최대값뿐 아니라 **분위 전체**를, 그리고 `FireAnimationFrame`을
//      품은 RunTask만 골라 같은 모집단끼리 비교한다(빌더는 max만 대조했다).
//      덤으로 **컴포지터/GPU 스레드**의 프레임당 몫도 뽑는다(눈금이 못 보는 몫 = 한계 3).
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { tauriProfile, connectMainPage, killTree, sleep, envInfo, binInfo, REPO } from '../../../bench/lib.mjs'
import { makeMultiFixture } from '../../../bench/fixture.mjs'
import { COLLECT, HARVEST, PANEL_POINTS, wheelSweep, cpuMark, cpuSince } from '../../../bench/ftgauge.mjs'

const argv = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=')
const EXE = argv('exe', '')
const CWD = argv('cwd', '')
const PORT = Number(argv('port', 11141))
const MS = Number(argv('ms', 4000))
const HOME = argv('home', path.join(process.env.TEMP ?? '.', 'ccg-critic-fps144', 'home-gauge'))
const OUT = path.join(REPO, 'docs', 'critic', 'evidence', argv('out', 'fps144-gauge-attack.json'))
if (!EXE) { console.error('--exe=PATH 필요'); process.exit(1) }

// 인위 부하 — rAF 콜백 안에서 정확히 `ms`만큼 **메인 스레드를 붙잡는다**.
const LOAD = (ms) => `(() => {
  window.__ldStop = false
  window.__ldN = 0
  const spin = () => {
    const end = performance.now() + ${ms}
    while (performance.now() < end) { /* busy */ }
    window.__ldN++
    if (!window.__ldStop) requestAnimationFrame(spin)
  }
  requestAnimationFrame(spin)
  return true
})()`
const LOAD_OFF = `(() => { window.__ldStop = true; return window.__ldN ?? 0 })()`

// ── 트레이스: 스레드별 몫 + FireAnimationFrame을 품은 RunTask만 고른 분위 ─────
function traceHook(cdp) {
  const chunks = []
  const onMsg = (m) => { if (m.method === 'Tracing.dataCollected' && Array.isArray(m.params?.value)) chunks.push(...m.params.value) }
  cdp.listeners.push(onMsg)
  return { chunks, onMsg }
}
async function traceStart2(cdp) {
  const h = traceHook(cdp)
  await cdp.send('Tracing.start', {
    transferMode: 'ReportEvents',
    traceConfig: {
      includedCategories: [
        'devtools.timeline', 'disabled-by-default-devtools.timeline',
        'disabled-by-default-devtools.timeline.frame', 'viz', 'gpu', 'cc', 'toplevel', '__metadata'
      ]
    }
  })
  return h
}
async function traceEnd2(cdp, h) {
  let resolve
  const done = new Promise((r) => { resolve = r })
  const onDone = (m) => { if (m.method === 'Tracing.tracingComplete') resolve() }
  cdp.listeners.push(onDone)
  await cdp.send('Tracing.end')
  await Promise.race([done, sleep(30000)])
  cdp.listeners = cdp.listeners.filter((f) => f !== h.onMsg && f !== onDone)
  return h.chunks
}
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100)
function qq(sorted, p) { return sorted.length ? r2(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]) : null }

function analyze2(events) {
  if (!events?.length) return null
  // 스레드 이름 맵
  const names = new Map()
  for (const e of events) {
    if (e.ph === 'M' && e.name === 'thread_name') names.set(`${e.pid}:${e.tid}`, e.args?.name ?? '?')
  }
  // 스레드별 최상위 X 이벤트 busy 합
  const perThread = new Map()
  const runTasksByThread = new Map()
  for (const e of events) {
    if (e.ph !== 'X' || typeof e.dur !== 'number') continue
    const k = `${e.pid}:${e.tid}`
    if (e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask') {
      if (!runTasksByThread.has(k)) runTasksByThread.set(k, [])
      runTasksByThread.get(k).push(e)
    }
  }
  // 렌더러 메인 = RunTask 총합 최대인 CrRendererMain
  let main = null
  for (const [k, arr] of runTasksByThread) {
    if (names.get(k) !== 'CrRendererMain') continue
    const sum = arr.reduce((a, c) => a + c.dur, 0)
    if (!main || sum > main.sum) main = { k, arr, sum }
  }
  const out = { threads: [] }
  // 스레드별 busy(최상위 X 이벤트만 — 중첩 제외) 합계
  const byThreadTop = new Map()
  const evsSorted = events.filter((e) => e.ph === 'X' && typeof e.dur === 'number')
    .sort((a, b) => (a.ts - b.ts) || (b.dur - a.dur))
  const stacks = new Map()
  for (const e of evsSorted) {
    const k = `${e.pid}:${e.tid}`
    if (!stacks.has(k)) stacks.set(k, [])
    const st = stacks.get(k)
    while (st.length && st[st.length - 1] <= e.ts) st.pop()
    if (!st.length) byThreadTop.set(k, (byThreadTop.get(k) ?? 0) + e.dur)
    st.push(e.ts + e.dur)
  }
  for (const [k, us] of [...byThreadTop.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    out.threads.push({ thread: k, name: names.get(k) ?? '?', busyMs: Math.round(us / 1000) })
  }
  if (main) {
    const all = main.arr.map((e) => e.dur / 1000).sort((a, b) => a - b)
    out.mainThread = names.get(main.k)
    out.taskAll = {
      n: all.length, p50: qq(all, 0.5), p95: qq(all, 0.95), p99: qq(all, 0.99), max: r2(all[all.length - 1]),
      over69Pct: Math.round(all.filter((x) => x > 6.9).length / all.length * 1000) / 10,
      busyMs: Math.round(main.sum / 1000)
    }
    // ★ FireAnimationFrame을 품은 RunTask만 = 눈금이 재는 것과 **같은 모집단**
    const fafs = events.filter((e) => e.ph === 'X' && e.name === 'FireAnimationFrame' && `${e.pid}:${e.tid}` === main.k)
      .map((e) => e.ts).sort((a, b) => a - b)
    const frameTasks = main.arr.filter((t) => {
      // 이 태스크 구간에 FireAnimationFrame이 하나라도 들어 있나 (이분 탐색 대신 선형 — 규모 작음)
      const s = t.ts, e2 = t.ts + t.dur
      let lo = 0, hi = fafs.length - 1
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (fafs[mid] < s) lo = mid + 1; else hi = mid - 1 }
      return lo < fafs.length && fafs[lo] <= e2
    }).map((t) => t.dur / 1000).sort((a, b) => a - b)
    out.taskWithRaf = frameTasks.length ? {
      n: frameTasks.length, p50: qq(frameTasks, 0.5), p75: qq(frameTasks, 0.75), p95: qq(frameTasks, 0.95),
      p99: qq(frameTasks, 0.99), max: r2(frameTasks[frameTasks.length - 1]),
      over69Pct: Math.round(frameTasks.filter((x) => x > 6.9).length / frameTasks.length * 1000) / 10
    } : null
  }
  return out
}

// ── 주행 ─────────────────────────────────────────────────────────────────────
const profile = tauriProfile({ exe: EXE, port: PORT })
profile.env.CCG_HOME = HOME
if (CWD) profile.cwd = path.resolve(CWD)
fs.rmSync(HOME, { recursive: true, force: true })
makeMultiFixture(HOME, '3.0.0-beta.1', { panels: 4 })

const child = spawn(profile.cmd, profile.args, { env: { ...process.env, ...profile.env }, cwd: profile.cwd, stdio: 'ignore' })
const rows = []
let refreshRateHz = null
try {
  const cdp = await connectMainPage(profile.port, { timeoutMs: 45000 })
  for (;;) { if (await cdp.eval(profile.mountExpr).catch(() => false)) break; await sleep(100) }
  await sleep(5000)
  refreshRateHz = await cdp.eval(`(() => new Promise((res) => { let n = 0, t0 = 0
    const f = (t) => { if (!n++) { t0 = t; requestAnimationFrame(f); return }
      if (n < 40) return requestAnimationFrame(f); res(Math.round(1000 / ((t - t0) / (n - 1)) * 10) / 10) }
    requestAnimationFrame(f) }))()`, { awaitPromise: true }).catch(() => null)
  console.log(`refresh: ${refreshRateHz}Hz · panels=${await cdp.eval(`document.querySelectorAll('.ma-p-thread').length`)}`)

  // (L)(O)(S) — 인위 부하 팔
  const arms = [
    { load: 0, order: 'after' },
    { load: 2, order: 'after' },
    { load: 5, order: 'after' },
    { load: 8, order: 'after' },
    { load: 12, order: 'after' },
    { load: 25, order: 'after' },
    { load: 5, order: 'before' },
    { load: 12, order: 'before' }
  ]
  for (const a of arms) {
    if (a.order === 'before' && a.load) await cdp.eval(LOAD(a.load))
    await cdp.eval(COLLECT)
    if (a.order === 'after' && a.load) await cdp.eval(LOAD(a.load))
    const cpu0 = cpuMark()
    await sleep(MS)
    const m = await cdp.eval(HARVEST)
    const spins = await cdp.eval(LOAD_OFF)
    await sleep(400)
    const row = { arm: `load=${a.load}ms/${a.order}`, load: a.load, order: a.order, spins, sysCpuPct: cpuSince(cpu0), ...m }
    delete row.hist
    rows.push(row)
    console.log(`  ${row.arm}: work p50=${m?.workP50} p95=${m?.workP95} max=${m?.workMax} · gap p50=${m?.rafP50} p95=${m?.rafP95} fps=${m?.avgFps} drop=${m?.droppedPct}% · frames=${m?.frames} spins=${spins} cpu=${row.sysCpuPct}%`)
  }

  // (T) — 4패널 동시 스크롤 + 트레이스 대조 (부하 없음)
  const pts = await cdp.eval(PANEL_POINTS)
  await cdp.eval(COLLECT)
  const h = await traceStart2(cdp)
  const cpu0 = cpuMark()
  await wheelSweep(cdp, pts, 6000)
  const m = await cdp.eval(HARVEST)
  const tr = analyze2(await traceEnd2(cdp, h))
  const row = { arm: 'scroll4+trace', sysCpuPct: cpuSince(cpu0), ...m, trace: tr }
  delete row.hist
  rows.push(row)
  console.log(`  scroll4: work p50=${m?.workP50} p95=${m?.workP95} p99=${m?.workP99} max=${m?.workMax} over69=${m?.over69Pct}% frames=${m?.frames}`)
  console.log(`  trace  : ${JSON.stringify(tr?.taskWithRaf)}`)
  console.log(`  threads: ${JSON.stringify(tr?.threads)}`)
  cdp.close()
} catch (e) {
  console.error('!', e?.message ?? e)
  rows.push({ error: String(e?.message ?? e) })
}
await sleep(400)
killTree(child.pid)

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify({
  what: '눈금 공격 — 선형성/순서 민감도/포화/트레이스 분위 대조 + 컴포지터 몫',
  exe: EXE, bin: binInfo(EXE), cwd: CWD || null, refreshRateHz, windowMs: MS,
  env: envInfo(), rows, at: new Date().toISOString()
}, null, 2))
console.log('saved:', path.relative(REPO, OUT))
