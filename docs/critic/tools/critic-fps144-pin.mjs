// 확인 크리틱 계기 ③ — **바닥 고정 규약**이 캡 이후에도 그대로인가.
//
//   node docs/critic/tools/critic-fps144-pin.mjs --exe=PATH [--cwd=DIR] [--port=11147] [--tag=B]
//
// `useThreadFollow`의 rAF 루프에 `now - lastStick >= MIN_COMMIT_MS` 가드가 들어갔다.
// 그 가드가 규약을 깨는 자리는 셋이다:
//   (P1) 스트리밍 중 바닥에 **붙어 있나** (가드 때문에 바닥에서 뒤처지지 않나)
//   (P2) 사용자가 **위로 스크롤하면 고정이 풀리나** (rAF가 도로 끌어내리지 않나)
//   (P3) 다시 바닥으로 돌아오면 **재고정되나**
// 셋 다 스트리밍이 도는 동안 실제 휠 이벤트로 확인한다(합성 스트리밍 = 결정적 일정).
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { tauriProfile, connectMainPage, killTree, sleep, envInfo, binInfo, REPO } from '../../../bench/lib.mjs'
import { makeMultiFixture } from '../../../bench/fixture.mjs'

const argv = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=')
const EXE = argv('exe', '')
const CWD = argv('cwd', '')
const PORT = Number(argv('port', 11147))
const TAG = argv('tag', 'X')
const PANELS = 4
const HOME = argv('home', path.join(process.env.TEMP ?? '.', 'ccg-critic-fps144', 'home-pin'))
const OUT = path.join(REPO, 'docs', 'critic', 'evidence', argv('out', `fps144-pin-${TAG}.json`))
if (!EXE) { console.error('--exe=PATH 필요'); process.exit(1) }

const INTERCEPT = `(() => {
  let real
  const reg = { main: [], panels: new Map() }
  window.__ftInject = reg
  const wrap = (api) => {
    try {
      const oTop = api.onEngineEvent
      if (typeof oTop === 'function') api.onEngineEvent = (cb) => { reg.main.push(cb); return oTop.call(api, cb) }
      if (api.multi && typeof api.multi.onEvent === 'function') {
        const oMul = api.multi.onEvent
        api.multi.onEvent = (pid, cb) => {
          if (!reg.panels.has(pid)) reg.panels.set(pid, [])
          reg.panels.get(pid).push(cb)
          return oMul.call(api.multi, pid, cb)
        }
      }
      reg.wrapped = true
    } catch (e) { reg.err = String(e && e.message || e) }
    return api
  }
  try {
    Object.defineProperty(window, 'api', { configurable: true, get: () => real, set: (v) => { real = (v && typeof v === 'object') ? wrap(v) : v } })
  } catch (e) { reg.defineErr = String(e && e.message || e) }
})()`

// 20초짜리 느린 스트림 — 휠 제스처를 넣을 시간을 준다.
const STREAM_FN = `window.__ftStream = (opts) => new Promise((resolve) => {
  const reg = window.__ftInject
  const ids = [...reg.panels.keys()].slice(0, opts.panels)
  if (!ids.length) return resolve({ error: 'no panel channels captured' })
  let full = ''
  for (let i = 0; full.length < opts.totalChars; i++) full += '### 구간 ' + i + '\\n\\n본문 줄 하나. 캐시 무효화는 세대 비교로만 동작한다. 소비자는 이벤트를 구독한다.\\n\\n'
  const runId = 'ft-' + Date.now(), msgId = 'ftmsg-' + Date.now()
  const fire = (pid, ev) => { for (const cb of (reg.panels.get(pid) || [])) { try { cb(ev) } catch (e) {} } }
  for (const pid of ids) { fire(pid, { type: 'status', status: 'analyzing', runId }); fire(pid, { type: 'status', status: 'working', runId }) }
  let sent = 0
  const timer = setInterval(() => {
    const next = Math.min(full.length, sent + opts.chunkChars); const delta = full.slice(sent, next); sent = next
    for (const pid of ids) fire(pid, { type: 'assistant-stream', messageId: msgId, delta })
    if (sent >= full.length) {
      clearInterval(timer)
      for (const pid of ids) { fire(pid, { type: 'assistant-done', messageId: msgId, text: full }); fire(pid, { type: 'status', status: 'done', runId }) }
      resolve({ panels: ids.length, chars: full.length })
    }
  }, opts.chunkMs)
})`

// 100ms마다 (바닥까지 남은 px, scrollTop, scrollHeight)을 찍는다.
const WATCH_ON = `(() => {
  const el = document.querySelectorAll('.ma-p-thread')[0]
  if (!el) return { error: 'no .ma-p-thread' }
  const b = { s: [] }
  window.__pin = b
  b.t = setInterval(() => b.s.push({
    t: Math.round(performance.now()),
    off: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
    top: Math.round(el.scrollTop), sh: Math.round(el.scrollHeight)
  }), 100)
  return { ok: true, h: el.clientHeight }
})()`
const WATCH_OFF = `(() => { const b = window.__pin; if (!b) return null; clearInterval(b.t); return b.s })()`

const profile = tauriProfile({ exe: EXE, port: PORT })
profile.env.CCG_HOME = HOME
if (CWD) profile.cwd = path.resolve(CWD)
fs.rmSync(HOME, { recursive: true, force: true })
makeMultiFixture(HOME, '3.0.0-beta.1', { panels: PANELS })

const child = spawn(profile.cmd, profile.args, { env: { ...process.env, ...profile.env }, cwd: profile.cwd, stdio: 'ignore' })
const row = { tag: TAG, exe: EXE, at: new Date().toISOString(), marks: {} }
try {
  const cdp = await connectMainPage(profile.port, { timeoutMs: 45000 })
  for (;;) { if (await cdp.eval(profile.mountExpr).catch(() => false)) break; await sleep(100) }
  await cdp.send('Page.enable', {})
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INTERCEPT })
  await cdp.send('Page.reload', {})
  await sleep(1200)
  for (;;) { if (await cdp.eval(profile.mountExpr).catch(() => false)) break; await sleep(100) }
  await sleep(6000)
  await cdp.eval(STREAM_FN)
  const pt = await cdp.eval(`(() => { const el = document.querySelectorAll('.ma-p-thread')[0]
    const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) } })()`)
  row.watch = await cdp.eval(WATCH_ON)
  const t0 = Date.now()
  const stream = cdp.eval(`window.__ftStream({ panels: ${PANELS}, chunkMs: 60, chunkChars: 40, totalChars: 12000 })`, { awaitPromise: true, timeoutMs: 120000 })

  // (P1) 3초간 붙어 있는지
  await sleep(3000); row.marks.pinnedPhaseEnd = Date.now() - t0
  // (P2) 위로 휠 — 고정이 풀려야 한다
  for (let i = 0; i < 6; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: pt.x, y: pt.y, deltaX: 0, deltaY: -220 })
    await sleep(40)
  }
  row.marks.wheelUpAt = Date.now() - t0
  await sleep(4000); row.marks.releasedPhaseEnd = Date.now() - t0
  // (P3) 바닥으로 되돌린다 — 재고정되어야 한다
  for (let i = 0; i < 40; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: pt.x, y: pt.y, deltaX: 0, deltaY: 400 })
    await sleep(25)
  }
  row.marks.wheelDownAt = Date.now() - t0
  await sleep(4000); row.marks.repinPhaseEnd = Date.now() - t0
  await stream.catch(() => null)
  row.samples = await cdp.eval(WATCH_OFF)
  cdp.close()
} catch (e) { row.error = String(e?.message ?? e) }
await sleep(400)
killTree(child.pid)

// ── 판정 ─────────────────────────────────────────────────────────────────────
if (row.samples?.length) {
  const s = row.samples
  const base = s[0].t
  const rel = s.map((x) => ({ ...x, rt: x.t - base }))
  const seg = (a, b) => rel.filter((x) => x.rt >= a && x.rt < b).map((x) => x.off)
  const stat = (a) => a.length ? { n: a.length, min: Math.min(...a), med: a.slice().sort((p, q) => p - q)[a.length >> 1], max: Math.max(...a) } : null
  row.verdict = {
    P1_pinned: stat(seg(600, row.marks.pinnedPhaseEnd - 200)),
    P2_released: stat(seg(row.marks.wheelUpAt + 400, row.marks.releasedPhaseEnd - 200)),
    P3_repinned: stat(seg(row.marks.wheelDownAt + 600, row.marks.repinPhaseEnd - 200))
  }
}
console.log(`[pin ${TAG}] ${JSON.stringify(row.verdict ?? row.error)}`)
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify({ what: '바닥 고정 규약(붙음/풀림/재고정) — MIN_COMMIT_MS 캡 이후', bin: binInfo(EXE), env: envInfo(), row }, null, 2))
console.log('saved:', path.relative(REPO, OUT))
