// 확인 크리틱 R2 계기 ③ — **왜 같은 팔이 두 개의 값을 내는가**(쌍봉)를 가른다.
//
//   node docs/critic/tools/critic-fps144-mode.mjs --exe=PATH [--cwd=DIR] [--port=11145]
//        [--novsync] [--wheel] [--rafGate=6.94] [--sampleMs=5] [--tag=A] [--out=NAME]
//
// 배경. 빌더의 이득 배율(`fps144-r2-stream-novsync.json`)과 전임 크리틱의 재현
// (`critic-r2-ae-novsync.json`)이 **라운드마다 3배씩 튄다.** 두 파일 모두 라운드별
// `streamInfo`는 `{panels:4, chars:9730}`으로 똑같은데 프레임당 일이
//   · 0.2~0.3ms (fps 590~1040)   ← 「가벼운 결」
//   · 0.6~2.5ms (fps 170~330)    ← 「무거운 결」
// 두 무리로 갈린다. 어느 결에 떨어지느냐는 **팔(코드)이 아니라 주행**이 정한다.
// 그런데 그 무대(`scripts/poc-fps144-stream.mjs`)에는 **무엇이 그려졌는지 증인이 없다** —
// 합성 스트리밍 직전에 4초 휠 스윕이 돌고, 그 스윕이 스레드를 바닥에 되돌려 놓았는지
// 아닌지가 기록되지 않는다. 이 계기는 그 빠진 증인을 넣는다:
//   ① 스트리밍 **직전/직후** 패널별 (scrollHeight-clientHeight-scrollTop) = 바닥까지 남은 px
//   ② 하이라이터가 실제로 걸렸는지 (`.hljs` · `pre code` 개수)
//   ③ 관측 패널의 공개 커밋 박자(MutationObserver) + 바닥 고정 표본(기본 5ms)
//   ④ `--wheel`로 그 휠 스윕을 켜고 끌 수 있다 → 쌍봉이 스윕에서 오는지 직접 가른다.
//
// `--rafGate=MS`. 이 기계엔 144Hz 패널이 없다. 리드 질문(「실 144Hz에서 바닥 px 꼬리는
// 얼마인가」)에 답하려면 **rAF 주기**를 144Hz로 놓아야 한다. 상한 해제(`--novsync`)로
// 프레임을 풀어 둔 채 `requestAnimationFrame`을 문서 로드 **전에** 감싸 콜백을 MS 간격으로
// 모아 친다. 제품 코드는 한 글자도 안 고친다(주입은 페이지 쪽). 이 대리자가 믿을 만한지는
// **MS=16.67로 놓고 실 60Hz vsync 주행과 맞춰 보는 것**으로 검증한다(같은 계기·같은 무대).
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { tauriProfile, connectMainPage, killTree, sleep, envInfo, binInfo, REPO } from '../../../bench/lib.mjs'
import { makeMultiFixture } from '../../../bench/fixture.mjs'
import { COLLECT, HARVEST, PANEL_POINTS, wheelSweep, cpuMark, cpuSince } from '../../../bench/ftgauge.mjs'

const argv = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=')
const EXE = argv('exe', '')
const CWD = argv('cwd', '')
const PORT = Number(argv('port', 11145))
const TAG = argv('tag', 'X')
const PANELS = Number(argv('panels', 4))
const CHUNK_MS = Number(argv('chunkMs', 40))
const CHUNK_CHARS = Number(argv('chunkChars', 48))
const SECONDS = Number(argv('seconds', 8))
const NOVSYNC = process.argv.includes('--novsync')
const WHEEL = process.argv.includes('--wheel')
const RAF_GATE = Number(argv('rafGate', 0))
const SAMPLE_MS = Number(argv('sampleMs', 5))
// ★관측자 자체가 무대를 바꾼다. `--noobs`는 MutationObserver·스크롤 표본기를 **아예 안 단다** —
// 빌더 하네스(`scripts/poc-fps144-stream.mjs`)와 **같은 관측 조건**을 만들어, 거기서만 나타나는
// 「가벼운 결」(프레임당 0.2ms · fps 600~1040)이 관측 때문에 사라진 것인지 가른다.
const NOOBS = process.argv.includes('--noobs')
const HOME = argv('home', path.join(process.env.TEMP ?? '.', 'ccg-critic-fps144', 'home-mode'))
const OUT = path.join(REPO, 'docs', 'critic', 'evidence', argv('out', `r2-mode-${TAG}.json`))
if (!EXE) { console.error('--exe=PATH 필요'); process.exit(1) }

// 경계 가로채기 — 크리틱 계기 ②(critic-fps144-cadence.mjs)와 **같은 코드**다.
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

// ── 144Hz 대리자 ────────────────────────────────────────────────────────────
// 실 rAF는 상한 해제로 200~1000Hz까지 돈다. 그 위에 **문지기**를 얹어 콜백을 GATE 간격
// 으로만 흘린다. 제품의 rAF 소비자(공개 루프 `SmoothMarkdown` · 바닥 고정 `useThreadFollow`
// · 눈금 `COLLECT`)가 전부 같은 주기를 보게 된다 = 「그 주사율의 패널」 흉내.
// 타임스탬프는 **실제 흘린 시각**을 그대로 넘긴다(가짜 시간을 만들면 공개 커서 속도가 틀어진다).
const RAF_GATE_SRC = (ms) => `(() => {
  const GATE = ${ms}
  const raf = window.requestAnimationFrame.bind(window)
  let queue = new Map(), nextId = 1, pending = 0, last = -1e9, fired = 0
  const driver = (t) => {
    pending = 0
    if (t - last + 0.5 >= GATE) {
      last = t; fired++
      const q = queue; queue = new Map()
      for (const cb of q.values()) { try { cb(t) } catch (e) {} }
    }
    if (queue.size && !pending) pending = raf(driver)
  }
  window.requestAnimationFrame = (cb) => {
    const id = nextId++
    queue.set(id, cb)
    if (!pending) pending = raf(driver)
    return id
  }
  window.cancelAnimationFrame = (id) => { queue.delete(id) }
  window.__rafGate = { ms: GATE, fired: () => fired }
})()`

const STREAM_FN = `window.__ftStream = (opts) => new Promise((resolve) => {
  const reg = window.__ftInject
  const ids = [...reg.panels.keys()].slice(0, opts.panels)
  if (!ids.length) return resolve({ error: 'no panel channels captured' })
  const body = (i) => (
    '## 구간 ' + i + ' 정리\\n\\n' +
    '이 구간에서는 **모듈 경계**와 캐시 무효화 규칙을 검토했다. 요점은 셋이다.\\n\\n' +
    '- \`invalidate(rev)\` 는 세대 비교로만 동작한다\\n' +
    '- 소비자는 레지스트리를 폴링하지 않고 이벤트를 구독한다\\n' +
    '- 실패 경로는 재시도 없이 상위로 전파한다\\n\\n' +
    '\\u0060\\u0060\\u0060ts\\n' +
    'export function step' + i + '(rev: number): Result {\\n' +
    '  const snap = registry.at(rev)\\n' +
    '  if (!snap) return { ok: false, reason: \\'stale\\' }\\n' +
    '  return { ok: true, value: snap.tokens.length }\\n' +
    '}\\n' +
    '\\u0060\\u0060\\u0060\\n\\n' +
    '측정값은 ' + (100 + i) + 'ms로, 직전 구간보다 ' + (i % 7) + 'ms 개선됐다.\\n\\n'
  )
  let full = ''
  for (let i = 0; full.length < opts.totalChars; i++) full += body(i)
  const runId = 'ft-' + Date.now()
  const fire = (pid, ev) => { for (const cb of (reg.panels.get(pid) || [])) { try { cb(ev) } catch (e) {} } }
  for (const pid of ids) {
    fire(pid, { type: 'status', status: 'analyzing', runId })
    fire(pid, { type: 'status', status: 'working', runId })
  }
  let sent = 0
  const msgId = 'ftmsg-' + runId
  const t0 = performance.now()
  const timer = setInterval(() => {
    const next = Math.min(full.length, sent + opts.chunkChars)
    const delta = full.slice(sent, next)
    sent = next
    for (const pid of ids) fire(pid, { type: 'assistant-stream', messageId: msgId, delta })
    if (sent >= full.length) {
      clearInterval(timer)
      for (const pid of ids) {
        fire(pid, { type: 'assistant-done', messageId: msgId, text: full })
        fire(pid, { type: 'status', status: 'done', runId })
      }
      resolve({ panels: ids.length, chars: full.length, ms: Math.round(performance.now() - t0) })
    }
  }, opts.chunkMs)
})`

// ★빠져 있던 증인 — 무대가 실제로 어떤 상태였나.
const SCENE = `(() => {
  const els = [...document.querySelectorAll('.ma-p-thread')]
  return {
    panels: els.map((el) => ({
      off: Math.round(el.scrollHeight - el.clientHeight - el.scrollTop),
      sh: Math.round(el.scrollHeight), ch: Math.round(el.clientHeight),
      len: el.textContent.length,
      hljs: el.querySelectorAll('.hljs, code.hljs, pre code span').length,
      pre: el.querySelectorAll('pre').length
    })),
    atBottom: els.filter((el) => (el.scrollHeight - el.clientHeight - el.scrollTop) <= 2).length,
    rafGate: window.__rafGate ? window.__rafGate.ms : null
  }
})()`

const CADENCE_ON = (sampleMs) => `(() => {
  const root = document.querySelectorAll('.ma-p-thread')[0]
  if (!root) return { error: 'no .ma-p-thread' }
  const b = { t: [], len: [], scrollTop: [], sh: [] }
  window.__cad = b
  const last = () => (root.lastElementChild ? root.lastElementChild.textContent.length : root.textContent.length)
  const obs = new MutationObserver(() => { b.t.push(performance.now()); b.len.push(last()) })
  obs.observe(root, { subtree: true, childList: true, characterData: true })
  b.obs = obs
  const sc = root
  b.sc = sc
  b.sampleMs = ${sampleMs}
  b.sample = setInterval(() => { if (sc) { b.scrollTop.push(Math.round(sc.scrollTop)); b.sh.push(Math.round(sc.scrollHeight - sc.clientHeight)) } }, ${sampleMs})
  return { ok: true, tag: root.className, sampleMs: ${sampleMs} }
})()`

const CADENCE_OFF = `(() => {
  const b = window.__cad; if (!b) return null
  try { b.obs.disconnect() } catch (e) {}
  try { clearInterval(b.sample) } catch (e) {}
  const t = b.t, len = b.len
  if (t.length < 3) return { n: t.length }
  const gaps = []
  for (let i = 1; i < t.length; i++) gaps.push(t[i] - t[i - 1])
  const grow = []
  for (let i = 1; i < len.length; i++) { const d = len[i] - len[i - 1]; if (d > 0) grow.push(d) }
  const r2 = (x) => x == null ? null : Math.round(x * 100) / 100
  const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? r2(s[Math.min(s.length - 1, Math.floor(s.length * p))]) : null }
  const span = t[t.length - 1] - t[0]
  const off = b.scrollTop.map((v, i) => (b.sh[i] ?? 0) - v)
  return {
    commits: t.length, spanMs: Math.round(span), commitsPerSec: r2(t.length / (span / 1000)),
    gapP50: q(gaps, 0.5), gapP95: q(gaps, 0.95), gapP99: q(gaps, 0.99), gapMax: r2(Math.max(...gaps)),
    gapOver33: gaps.filter((x) => x > 33).length,
    growP50: q(grow, 0.5), growP95: q(grow, 0.95), finalLen: len[len.length - 1],
    pinSamples: off.length, pinOffP50: q(off, 0.5), pinOffP90: q(off, 0.9), pinOffP95: q(off, 0.95),
    pinOffP99: q(off, 0.99), pinOffMax: off.length ? Math.max(...off) : null,
    pinSampleMs: b.sampleMs, pinEffMs: r2(span / off.length),
    pinDuty: [8, 20, 40, 80].map((th) => ({ th, pct: Math.round(off.filter((x) => x > th).length / off.length * 1000) / 10 })),
    pinMaxRunMs: (() => { let best = 0, cur = 0
      for (const x of off) { if (x > 20) { cur += b.sampleMs; if (cur > best) best = cur } else cur = 0 }
      return best })()
  }
})()`

const NOVSYNC_SWITCHES = '--disable-gpu-vsync --disable-frame-rate-limit'
const profile = tauriProfile({ exe: EXE, port: PORT, extraEnv: NOVSYNC ? { CCG_WEBVIEW_ARGS_EXTRA: NOVSYNC_SWITCHES } : {} })
profile.env.CCG_HOME = HOME
if (CWD) profile.cwd = path.resolve(CWD)
fs.rmSync(HOME, { recursive: true, force: true })
makeMultiFixture(HOME, '3.0.0-beta.1', { panels: PANELS })

const child = spawn(profile.cmd, profile.args, { env: { ...process.env, ...profile.env }, cwd: profile.cwd, stdio: 'ignore' })
const row = { tag: TAG, novsync: NOVSYNC, wheel: WHEEL, noobs: NOOBS, rafGate: RAF_GATE || null, exe: EXE, at: new Date().toISOString() }
try {
  const cdp = await connectMainPage(profile.port, { timeoutMs: 45000 })
  for (;;) { if (await cdp.eval(profile.mountExpr).catch(() => false)) break; await sleep(100) }
  await cdp.send('Page.enable', {})
  if (RAF_GATE > 0) await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: RAF_GATE_SRC(RAF_GATE) })
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INTERCEPT })
  await cdp.send('Page.reload', {})
  await sleep(1200)
  for (;;) { if (await cdp.eval(profile.mountExpr).catch(() => false)) break; await sleep(100) }
  await sleep(6000)
  row.refreshRateHz = await cdp.eval(`(() => new Promise((res) => { let n = 0, t0 = 0
    const f = (t) => { if (!n++) { t0 = t; requestAnimationFrame(f); return }
      if (n < 40) return requestAnimationFrame(f); res(Math.round(1000 / ((t - t0) / (n - 1)) * 10) / 10) }
    requestAnimationFrame(f) }))()`, { awaitPromise: true }).catch(() => null)
  row.inject = await cdp.eval(`(() => { const r = window.__ftInject; return r ? { wrapped: !!r.wrapped, panels: [...r.panels.keys()].length } : null })()`)
  row.gridPanels = await cdp.eval(`document.querySelectorAll('.ma-p-thread').length`)
  row.sceneBoot = await cdp.eval(SCENE)

  // ① 선택 무대 — 빌더/전임 하네스와 **같은** 4초 휠 스윕(위 2초 · 아래 2초)
  if (WHEEL) {
    const pts = await cdp.eval(PANEL_POINTS)
    await wheelSweep(cdp, pts, 4000)
    await sleep(1200)
  }
  row.sceneBeforeStream = await cdp.eval(SCENE)

  // ② 합성 스트리밍 — 4패널 동시
  await cdp.eval(STREAM_FN)
  row.cadenceOn = NOOBS ? { skipped: true } : await cdp.eval(CADENCE_ON(SAMPLE_MS))
  await cdp.eval(COLLECT)
  const cpu0 = cpuMark()
  row.streamInfo = await cdp.eval(
    `window.__ftStream({ panels: ${PANELS}, chunkMs: ${CHUNK_MS}, chunkChars: ${CHUNK_CHARS}, totalChars: ${Math.round(SECONDS * 1000 / CHUNK_MS) * CHUNK_CHARS} })`,
    { awaitPromise: true, timeoutMs: 120000 })
  const ft = await cdp.eval(HARVEST)
  if (ft) { delete ft.hist; ft.sysCpuPct = cpuSince(cpu0) }
  row.frame = ft
  row.cadence = NOOBS ? null : await cdp.eval(CADENCE_OFF)
  row.sceneAfterStream = await cdp.eval(SCENE)
  row.gateFired = await cdp.eval(`window.__rafGate ? window.__rafGate.fired() : null`)
  cdp.close()
} catch (e) { row.error = String(e?.message ?? e) }
await sleep(400)
killTree(child.pid)

const sb = row.sceneBeforeStream
console.log(`[${TAG}${NOVSYNC ? ' novsync' : ''}${WHEEL ? ' +wheel' : ''}${RAF_GATE ? ' gate=' + RAF_GATE : ''}] refresh=${row.refreshRateHz}Hz atBottom=${sb?.atBottom}/${sb?.panels?.length} offs=${JSON.stringify(sb?.panels?.map((p) => p.off))}`)
console.log(`  frame  : p50=${row.frame?.workP50} p95=${row.frame?.workP95} mean=${row.frame?.workMean} fps=${row.frame?.avgFps} frames=${row.frame?.frames} cpu=${row.frame?.sysCpuPct}%`)
console.log(`  cadence: cps=${row.cadence?.commitsPerSec} pinP95=${row.cadence?.pinOffP95} duty8=${row.cadence?.pinDuty?.[0]?.pct}% duty20=${row.cadence?.pinDuty?.[1]?.pct}% run=${row.cadence?.pinMaxRunMs}ms hljs=${row.sceneAfterStream?.panels?.[0]?.hljs}`)
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify({ what: '쌍봉 가르기 + 144Hz rAF 대리자 — 무대 증인 포함', bin: binInfo(EXE), env: envInfo(), row }, null, 2))
console.log('saved:', path.relative(REPO, OUT))
