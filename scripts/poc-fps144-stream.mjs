// PoC — **합성 스트리밍**으로 4패널 동시 스트리밍의 프레임 작업 시간을 잰다.
//
//   node scripts/poc-fps144-stream.mjs --exeA=PATH [--exeB=PATH] [--cwdA=DIR] [--cwdB=DIR]
//        [--rounds=3] [--panels=4] [--chunkMs=40] [--chunkChars=48] [--seconds=8] [--port=11116]
//
// ## 왜 실엔진 팔을 안 쓰나 (측정 결함 보고)
// `bench/multi.mjs --live` 계열의 스트리밍 팔은 **3.0 격리 홈에서 성립하지 않는다.**
// 진단(bench/scratch/fps144-diag-live.mjs) 실측:
//   · 3.0(배포 모사): 전송 → 1초 안에 `Not logged in · Please run /login` 말풍선 → busy 314ms
//   · 2.6.2         : 같은 프롬프트로 busy 4046ms (실제로 스트리밍)
// 즉 그 팔의 3.0 칸은 **스트리밍이 아니라 오류 말풍선 한 장**을 재고 있었다(프레임 15장).
// 두 앱이 서로 다른 사건을 재는 눈금은 비교가 안 된다. `accounts.json`을 지운 대조 팔은
// 턴이 아예 안 열려(스케줄링조차 안 뜸) 더 나빴다 — 격리 홈에서 실계정 턴은 못 쓴다.
//
// ## 그래서 무엇을 재나
// 엔진 이벤트가 렌더러로 들어오는 **바로 그 경계**(`window.api.multi.onEvent`의 콜백)에
// 합성 델타를 넣는다. 그 아래로는 제품 코드가 그대로 돈다:
//   리듀서(assistant-stream) → React 팬아웃 → SmoothMarkdown rAF 공개 → remark 재파싱
//   → useThreadFollow의 매 프레임 바닥 고정 → 레이아웃/페인트/합성
// 즉 **렌더러 핫패스 전체**를 재고, 엔진·IPC·모델 지연만 뺀다. 이 라운드가 고치는 자리가
// 정확히 그 안이므로 오히려 신호가 깨끗하다. 게다가 델타 일정이 고정이라 **결정적**이다.
//
// ## 한계 (보고서에 그대로)
//  (1) 2.6.2에는 못 쓴다 — Electron contextBridge의 `window.api`는 frozen·non-writable이라
//      경계를 감쌀 수 없다(실측: apiFrozen=true, writable=false). 그래서 이 팔은 **3.0 전용**이고
//      앱 간 비교가 아니라 **3.0의 고치기 전/후 비교**에 쓴다.
//  (2) 엔진/IPC 비용이 빠졌으므로 절대값을 "실사용 스트리밍 프레임 시간"으로 읽으면 안 된다.
//      읽는 법: 같은 일정 아래 렌더러가 프레임당 몇 ms를 쓰는가.
//  (3) A/B는 **부팅 교대**(A-B-A-B)다. 한 프로세스 안에서 두 exe를 못 바꾸므로, 라운드
//      안에서 짝지어 빼 밴드 이동을 지운다(fpsab.mjs와 같은 규약).
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { tauriProfile, connectMainPage, killTree, median, sleep, envInfo, binInfo, REPO } from '../bench/lib.mjs'
import { makeMultiFixture } from '../bench/fixture.mjs'
import {
  COLLECT, HARVEST, PANEL_POINTS, wheelSweep, cpuMark, cpuSince, traceStart, traceEnd, analyzeTrace
} from '../bench/ftgauge.mjs'

const argv = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=')
const ROUNDS = Number(argv('rounds', 3))
const PANELS = Number(argv('panels', 4))
const CHUNK_MS = Number(argv('chunkMs', 40))
const CHUNK_CHARS = Number(argv('chunkChars', 48))
const SECONDS = Number(argv('seconds', 8))
const PORT = Number(argv('port', 11116))
const TRACE = process.argv.includes('--trace')
const OUT = path.join(REPO, 'bench', 'results', argv('out', 'poc-fps144-stream.json'))
const ARMS = [
  { name: 'A', exe: argv('exeA', ''), cwd: argv('cwdA', '') },
  ...(argv('exeB', '') ? [{ name: 'B', exe: argv('exeB', ''), cwd: argv('cwdB', '') }] : [])
]
if (!ARMS[0].exe) { console.error('--exeA=PATH 가 필요하다'); process.exit(1) }

// ── 경계 가로채기 ────────────────────────────────────────────────────────────
// `window.api`가 **대입되는 순간** 감싼다. 앱 번들보다 먼저 돌아야 하므로
// Page.addScriptToEvaluateOnNewDocument + Page.reload로 넣는다.
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
    Object.defineProperty(window, 'api', {
      configurable: true,
      get: () => real,
      set: (v) => { real = (v && typeof v === 'object') ? wrap(v) : v }
    })
  } catch (e) { reg.defineErr = String(e && e.message || e) }
})()`

// ── 합성 스트리밍 (페이지 안에서 자체 타이머로 돈다) ─────────────────────────
// CDP로 델타마다 왕복하면 하네스 왕복 비용이 측정 창에 섞인다. 일정 전체를 페이지에
// 심고 완료를 기다린다. 델타 하나 = 타이머 태스크 하나 = 실 IPC 델타와 같은 모양.
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

// ── 측정 전용 vsync 해제 ─────────────────────────────────────────────────────
// 이 기계의 모니터는 60Hz다. 144Hz에서만 갈리는 수정(표시율 분리)을 60Hz에서 그대로
// 재면 **두 팔이 같게 나온다** — 바닥(15ms)이 16.7ms 프레임에선 매 프레임 만족되니까.
// 그래서 프레임 상한을 풀어 rAF가 메인 스레드가 감당하는 만큼 빨리 돌게 한다. 그러면
// 「표시율이 60보다 높을 때」의 거동이 드러난다. 제품 기본값은 안 바꾼다 — 3.0이 이미
// 가진 env 옵트인(`CCG_WEBVIEW_ARGS_EXTRA`)으로만 준다.
const NOVSYNC = process.argv.includes('--novsync')
const NOVSYNC_SWITCHES = '--disable-gpu-vsync --disable-frame-rate-limit'

async function runArm(arm, round) {
  const profile = tauriProfile({
    exe: arm.exe, port: PORT,
    extraEnv: NOVSYNC ? { CCG_WEBVIEW_ARGS_EXTRA: NOVSYNC_SWITCHES } : {}
  })
  profile.env.CCG_HOME = path.join(REPO, '.bench-home-fps144stream')
  if (arm.cwd) profile.cwd = path.resolve(arm.cwd)
  fs.rmSync(profile.env.CCG_HOME, { recursive: true, force: true })
  makeMultiFixture(profile.env.CCG_HOME, '3.0.0-beta.1', { panels: PANELS })

  const child = spawn(profile.cmd, profile.args, {
    env: { ...process.env, ...profile.env }, cwd: profile.cwd, stdio: 'ignore'
  })
  const row = { round, arm: arm.name, at: new Date().toISOString() }
  try {
    const cdp = await connectMainPage(profile.port, { timeoutMs: 45000 })
    for (;;) { if (await cdp.eval(profile.mountExpr).catch(() => false)) break; await sleep(100) }
    // 가로채기를 심고 **다시 부팅**한다 — 앱이 구독하기 전에 경계를 감싸야 한다.
    await cdp.send('Page.enable', {})
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INTERCEPT })
    await cdp.send('Page.reload', {})
    await sleep(1200)
    for (;;) { if (await cdp.eval(profile.mountExpr).catch(() => false)) break; await sleep(100) }
    await sleep(6000)

    const reg = await cdp.eval(`(() => { const r = window.__ftInject
      return r ? { wrapped: !!r.wrapped, main: r.main.length, panels: [...r.panels.keys()], err: r.err ?? null, defineErr: r.defineErr ?? null } : null })()`)
    row.inject = reg
    if (!reg?.panels?.length) throw new Error('패널 채널을 못 잡았다: ' + JSON.stringify(reg))
    row.gridPanels = await cdp.eval(`document.querySelectorAll('.ma-p-thread').length`)

    // 1) 대조 무대 — 4패널 동시 스크롤(합성 주입과 무관한 기존 부하 팔)
    const pts = await cdp.eval(PANEL_POINTS)
    await cdp.eval(COLLECT)
    let cpu0 = cpuMark()
    await wheelSweep(cdp, pts, 4000)
    row.scrollAllPanels = await cdp.eval(HARVEST)
    if (row.scrollAllPanels) row.scrollAllPanels.sysCpuPct = cpuSince(cpu0)
    await sleep(1200)

    // 2) 합성 스트리밍 — 4패널 동시
    await cdp.eval(STREAM_FN)
    await cdp.eval(COLLECT)
    cpu0 = cpuMark()
    const th = TRACE ? await traceStart(cdp).catch(() => null) : null
    const res = await cdp.eval(
      `window.__ftStream({ panels: ${PANELS}, chunkMs: ${CHUNK_MS}, chunkChars: ${CHUNK_CHARS}, totalChars: ${Math.round(SECONDS * 1000 / CHUNK_MS) * CHUNK_CHARS} })`,
      { awaitPromise: true, timeoutMs: 120000 }
    )
    row.streamInfo = res
    row.streamSynthetic = await cdp.eval(HARVEST)
    if (row.streamSynthetic) row.streamSynthetic.sysCpuPct = cpuSince(cpu0)
    if (th && row.streamSynthetic) {
      try { row.streamSynthetic.trace = analyzeTrace(await traceEnd(cdp, th)) } catch (e) { row.streamSynthetic.trace = { err: String(e?.message ?? e) } }
    }
    cdp.close()
  } catch (e) {
    row.error = String(e?.message ?? e)
  }
  await sleep(400)
  killTree(child.pid)
  await sleep(1200)
  const f = (k) => row[k] ? `p50=${row[k].workP50} p95=${row[k].workP95} p99=${row[k].workP99} max=${row[k].workMax} >6.9=${row[k].over69Pct}% fps=${row[k].avgFps} drop=${row[k].droppedPct}% cpu=${row[k].sysCpuPct}%` : '(없음)'
  console.log(`  r${round} ${arm.name}  scroll4: ${f('scrollAllPanels')}`)
  console.log(`  r${round} ${arm.name}  stream4: ${f('streamSynthetic')}  ${JSON.stringify(row.streamInfo ?? row.error ?? null)}`)
  return row
}

const rows = []
console.log(`arms: ${ARMS.map((a) => a.name + '=' + path.basename(path.dirname(a.exe)) + '/' + path.basename(a.exe)).join('  ')}`)
for (let r = 1; r <= ROUNDS; r++) {
  console.log(`round ${r}/${ROUNDS}`)
  for (const arm of ARMS) rows.push(await runArm(arm, r))
}

const KEYS = ['scrollAllPanels', 'streamSynthetic']
const agg = (armName, key) => {
  const f = rows.filter((r) => r.arm === armName && r[key])
  if (!f.length) return null
  const m = (k) => median(f.map((r) => r[key][k]))
  return {
    n: f.length, workP50: m('workP50'), workP95: m('workP95'), workP99: m('workP99'),
    workMaxWorst: Math.max(...f.map((r) => r[key].workMax ?? 0)),
    over69Pct: m('over69Pct'), over69PctWorst: Math.max(...f.map((r) => r[key].over69Pct ?? 0)),
    over166Pct: m('over166Pct'),
    avgFps: m('avgFps'), rafP95Ms: m('rafP95'),
    worstDroppedPct: Math.max(...f.map((r) => r[key].droppedPct ?? 0)),
    zeroDropRuns: f.filter((r) => (r[key].droppedPct ?? 1) === 0).length,
    sysCpuPct: m('sysCpuPct'), longTaskMs: m('longTaskMs')
  }
}
const summary = {}
for (const a of ARMS) { summary[a.name] = {}; for (const k of KEYS) summary[a.name][k] = agg(a.name, k) }

// 짝지은 라운드 차 (B - A) — 밴드 이동에 둔감
const paired = {}
if (ARMS.length > 1) {
  for (const k of KEYS) {
    const d = []
    for (let r = 1; r <= ROUNDS; r++) {
      const a = rows.find((x) => x.round === r && x.arm === 'A')?.[k]
      const b = rows.find((x) => x.round === r && x.arm === 'B')?.[k]
      if (a && b) d.push({
        round: r,
        dP50: Math.round((b.workP50 - a.workP50) * 100) / 100,
        dP95: Math.round((b.workP95 - a.workP95) * 100) / 100,
        dP99: Math.round((b.workP99 - a.workP99) * 100) / 100,
        dOver69: Math.round((b.over69Pct - a.over69Pct) * 10) / 10
      })
    }
    paired[k] = {
      rounds: d.length,
      medianDeltaP50: median(d.map((x) => x.dP50)),
      medianDeltaP95: median(d.map((x) => x.dP95)),
      medianDeltaP99: median(d.map((x) => x.dP99)),
      medianDeltaOver69: median(d.map((x) => x.dOver69)),
      per: d
    }
  }
}

const out = {
  what: '합성 스트리밍(엔진 이벤트 경계 주입) + 4패널 스크롤 — 프레임 작업 시간, 부팅 교대 A/B',
  budgetMs: 6.9, rounds: ROUNDS, panels: PANELS,
  novsync: NOVSYNC, novsyncSwitches: NOVSYNC ? NOVSYNC_SWITCHES : null,
  schedule: { chunkMs: CHUNK_MS, chunkChars: CHUNK_CHARS, seconds: SECONDS },
  arms: ARMS.map((a) => ({ name: a.name, exe: a.exe, cwd: a.cwd || null, bin: binInfo(a.exe) })),
  env: envInfo(), summary, paired, rows, at: new Date().toISOString()
}
fs.writeFileSync(OUT, JSON.stringify(out, null, 2))
console.log('\nsummary:', JSON.stringify(summary, null, 2))
if (ARMS.length > 1) console.log('paired(B-A):', JSON.stringify(paired, (k, v) => (k === 'per' ? undefined : v), 2))
console.log('saved:', path.relative(REPO, OUT))
