// 확인 크리틱 계기 ② — **사람이 보는 것**을 잰다(체감 회귀 판정).
//
//   node docs/critic/tools/critic-fps144-cadence.mjs --exe=PATH [--cwd=DIR] [--port=11143]
//        [--novsync] [--rounds=1] [--tag=A] [--out=NAME]
//
// `MIN_COMMIT_MS=10`은 「프레임당 일」을 줄이는 대신 **화면 갱신 횟수**를 깎는다. 프레임
// 작업 시간(ms)만 보면 그 대가가 안 보인다. 그래서 이 계기는 DOM이 실제로 바뀐 순간을
// MutationObserver로 찍어 **공개 커밋의 박자**를 직접 잰다:
//   · 초당 커밋 수 (=글자가 갱신되는 횟수)
//   · 커밋 간격 p50/p95/p99/최대 (=「뚝뚝 끊긴다」가 나올 자리)
//   · 커밋당 늘어난 글자 수 (=한 번에 얼마나 튀어나오나)
//   · 총 공개 시간 (=수정이 애니메이션을 느리게 만들지 않았나)
// 60Hz에서 A/B가 같고, 상한 해제(≈고주사율 대리)에서만 B가 100/s 상한에 걸리면
// 「60Hz 무후퇴 · 고주사율에서 일만 줄었다」는 주장이 화면 쪽에서도 참이다.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { tauriProfile, connectMainPage, killTree, sleep, envInfo, binInfo, REPO } from '../../../bench/lib.mjs'
import { makeMultiFixture } from '../../../bench/fixture.mjs'
import { COLLECT, HARVEST, cpuMark, cpuSince } from '../../../bench/ftgauge.mjs'

const argv = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=')
const EXE = argv('exe', '')
const CWD = argv('cwd', '')
const PORT = Number(argv('port', 11143))
const TAG = argv('tag', 'X')
const PANELS = Number(argv('panels', 4))
const CHUNK_MS = Number(argv('chunkMs', 40))
const CHUNK_CHARS = Number(argv('chunkChars', 48))
const SECONDS = Number(argv('seconds', 8))
const NOVSYNC = process.argv.includes('--novsync')
const HOME = argv('home', path.join(process.env.TEMP ?? '.', 'ccg-critic-fps144', 'home-cadence'))
const OUT = path.join(REPO, 'docs', 'critic', 'evidence', argv('out', `fps144-cadence-${TAG}${NOVSYNC ? '-novsync' : ''}.json`))
if (!EXE) { console.error('--exe=PATH 필요'); process.exit(1) }

// poc-fps144-stream.mjs와 **같은 경계 가로채기·같은 일정**을 쓴다(그 결과와 짝이 맞게).
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

// ── 커밋 박자 기록기 ─────────────────────────────────────────────────────────
// 패널 **하나만** 본다(관찰 비용이 측정 창에 섞이지 않게). 배치 하나 = React 커밋 하나.
const CADENCE_ON = `(() => {
  const root = document.querySelectorAll('.ma-p-thread')[0]
  if (!root) return { error: 'no .ma-p-thread' }
  const b = { t: [], len: [], scrollTop: [], sh: [] }
  window.__cad = b
  const last = () => (root.lastElementChild ? root.lastElementChild.textContent.length : root.textContent.length)
  const obs = new MutationObserver(() => {
    b.t.push(performance.now())
    b.len.push(last())
  })
  obs.observe(root, { subtree: true, childList: true, characterData: true })
  b.obs = obs
  // 바닥 고정 규약 증인 — 스크롤 위치가 바닥에 붙어 있나.
  // .ma-p-thread 가 곧 스크롤러다 (styles.css:4061 overflow-y:auto) — 조상이 아니다.
  const sc = root
  b.sc = sc
  b.sample = setInterval(() => { if (sc) { b.scrollTop.push(Math.round(sc.scrollTop)); b.sh.push(Math.round(sc.scrollHeight - sc.clientHeight)) } }, 100)
  return { ok: true, tag: root.className }
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
  // 바닥 고정 증인: 샘플마다 (maxScrollTop - scrollTop). 0에 가까우면 바닥에 붙어 있다.
  const off = b.scrollTop.map((v, i) => (b.sh[i] ?? 0) - v)
  return {
    commits: t.length, spanMs: Math.round(span), commitsPerSec: r2(t.length / (span / 1000)),
    gapP50: q(gaps, 0.5), gapP95: q(gaps, 0.95), gapP99: q(gaps, 0.99), gapMax: r2(Math.max(...gaps)),
    gapOver33: gaps.filter((x) => x > 33).length, gapOver50: gaps.filter((x) => x > 50).length,
    growP50: q(grow, 0.5), growP95: q(grow, 0.95), growMax: grow.length ? Math.max(...grow) : null,
    finalLen: len[len.length - 1],
    pinSamples: off.length, pinOffP50: q(off, 0.5), pinOffP95: q(off, 0.95), pinOffMax: off.length ? Math.max(...off) : null
  }
})()`

const NOVSYNC_SWITCHES = '--disable-gpu-vsync --disable-frame-rate-limit'
const profile = tauriProfile({ exe: EXE, port: PORT, extraEnv: NOVSYNC ? { CCG_WEBVIEW_ARGS_EXTRA: NOVSYNC_SWITCHES } : {} })
profile.env.CCG_HOME = HOME
if (CWD) profile.cwd = path.resolve(CWD)
fs.rmSync(HOME, { recursive: true, force: true })
makeMultiFixture(HOME, '3.0.0-beta.1', { panels: PANELS })

const child = spawn(profile.cmd, profile.args, { env: { ...process.env, ...profile.env }, cwd: profile.cwd, stdio: 'ignore' })
const row = { tag: TAG, novsync: NOVSYNC, exe: EXE, at: new Date().toISOString() }
try {
  const cdp = await connectMainPage(profile.port, { timeoutMs: 45000 })
  for (;;) { if (await cdp.eval(profile.mountExpr).catch(() => false)) break; await sleep(100) }
  await cdp.send('Page.enable', {})
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
  await cdp.eval(STREAM_FN)
  row.cadenceOn = await cdp.eval(CADENCE_ON)
  await cdp.eval(COLLECT)
  const cpu0 = cpuMark()
  row.streamInfo = await cdp.eval(
    `window.__ftStream({ panels: ${PANELS}, chunkMs: ${CHUNK_MS}, chunkChars: ${CHUNK_CHARS}, totalChars: ${Math.round(SECONDS * 1000 / CHUNK_MS) * CHUNK_CHARS} })`,
    { awaitPromise: true, timeoutMs: 120000 })
  const ft = await cdp.eval(HARVEST)
  if (ft) { delete ft.hist; ft.sysCpuPct = cpuSince(cpu0) }
  row.frame = ft
  row.cadence = await cdp.eval(CADENCE_OFF)
  cdp.close()
} catch (e) { row.error = String(e?.message ?? e) }
await sleep(400)
killTree(child.pid)

console.log(`[${TAG}${NOVSYNC ? ' novsync' : ''}] refresh=${row.refreshRateHz}Hz stream=${JSON.stringify(row.streamInfo)}`)
console.log(`  frame  : p50=${row.frame?.workP50} p95=${row.frame?.workP95} p99=${row.frame?.workP99} >6.9=${row.frame?.over69Pct}% fps=${row.frame?.avgFps} drop=${row.frame?.droppedPct}% cpu=${row.frame?.sysCpuPct}%`)
console.log(`  cadence: ${JSON.stringify(row.cadence)}`)
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify({ what: '공개 커밋 박자(사람이 보는 갱신) + 바닥 고정 증인', bin: binInfo(EXE), env: envInfo(), row }, null, 2))
console.log('saved:', path.relative(REPO, OUT))
