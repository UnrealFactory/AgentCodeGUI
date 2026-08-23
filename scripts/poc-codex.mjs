#!/usr/bin/env node
/* ============================================================================
 * poc-codex — **M4 Codex 엔진 실증**. 두 가지를 따로 잰다.
 *
 *   --only=handshake  실 `codex app-server`(앱 홈의 설치본)와 **격리된 빈 CODEX_HOME**으로
 *                     JSON-RPC 핸드셰이크. 로그인이 필요한 지점이 정확히 어디인지 기록한다.
 *                     (실홈 `~/.codex`는 건드리지 않는다 — 아래 안전 규칙)
 *   --only=app        실 창 · 제품 경로 · **가짜 app-server**(ccg-fakecodex)로
 *                     부팅 → 전송 → 스트리밍 → 도구 → 완료 → 재시작 후 대화 잔존.
 *
 *   node scripts/poc-codex.mjs                # 둘 다
 *   node scripts/poc-codex.mjs --keep         # 격리 홈 보존
 *   node scripts/poc-codex.mjs --tag          # 동시 실행(홈·포트 분리)
 *
 *   ※ app 단계 전에:
 *      cargo build -p ccg-engine --features fakecli --bin ccg-fakecodex --release
 *      npm run tauri:build   (또는 --exe=<경로>)
 *
 * ── 안전 규칙 (사용자 실앱이 떠 있다) ───────────────────────────────────────
 *  · **이름 기반 kill 금지.** 죽이는 것은 이 스크립트가 spawn한 PID 트리뿐이다.
 *  · **실홈은 읽기만.** codex 실행본은 앱 홈에서 **실행만** 하고, 그 프로세스의
 *    `CODEX_HOME`은 레포 안 격리 폴더다 — 사용자의 `~/.codex`에 아무것도 안 쓴다.
 *  · 앱 홈은 전부 `CCG_HOME`으로 격리한다(레포 안 `.poc-home-codex*`).
 * ========================================================================== */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { connectMainPage, killTree, sleep, REPO } from '../bench/lib.mjs'

const args = process.argv.slice(2)
const only = (args.find((a) => a.startsWith('--only=')) ?? '').split('=')[1] || 'all'
const KEEP = args.includes('--keep')
const EXE = (args.find((a) => a.startsWith('--exe=')) ?? '').split('=')[1] || path.join(REPO, 'target', 'release', 'agentcodegui.exe')
const tagArg = args.find((a) => a === '--tag' || a.startsWith('--tag='))
const RUNTAG = tagArg === undefined ? '' : tagArg.split('=')[1] || `${process.pid}-${Math.random().toString(36).slice(2, 6)}`
const hash32 = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0 }
const homeFor = (name) => path.join(REPO, `.poc-home-codex-${name}${RUNTAG ? `-${RUNTAG}` : ''}`)
const PORT = 9391 + (RUNTAG ? 4 + (hash32(RUNTAG) % 40) * 4 : 0)
const REAL_HOME = path.join(os.homedir(), '.agentcodegui')
const OUT = path.join(REPO, 'docs', 'critic', `m4-r1-codex${RUNTAG ? `-${RUNTAG}` : ''}.json`)

const rep = { at: new Date().toISOString(), exe: EXE, steps: {}, findings: [] }
const fail = (id, why, extra) => { rep.findings.push({ id, why, ...(extra ?? {}) }); console.error(`  ✗ ${id} — ${why}`) }
const ok = (id, v) => console.log(`  ✓ ${id}${v === undefined ? '' : ' — ' + JSON.stringify(v)}`)
const rmrf = (p) => { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 }) } catch { /* 다음 주행이 지운다 */ } }
const write = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v, null, 2)) }

// ─────────────────────────────────────────────────────────────────────────────
// 1) 실 바이너리 핸드셰이크 — 로그인 없이 **어디까지 가는가**
// ─────────────────────────────────────────────────────────────────────────────

/** 앱 홈에 설치된 codex **네이티브 실행본**(Rust `versions::codex_bin`과 같은 규칙). */
function realCodexBin() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(REAL_HOME, 'codex-config.json'), 'utf8'))
    const v = cfg.activeVersion
    if (!v) return null
    const openai = path.join(REAL_HOME, 'codex-engines', v, 'node_modules', '@openai')
    const exe = process.platform === 'win32' ? 'codex.exe' : 'codex'
    for (const pkg of fs.readdirSync(openai).filter((n) => n.startsWith('codex-'))) {
      const vendor = path.join(openai, pkg, 'vendor')
      if (!fs.existsSync(vendor)) continue
      for (const triple of fs.readdirSync(vendor)) {
        const cand = path.join(vendor, triple, 'bin', exe)
        if (fs.existsSync(cand)) return { bin: cand, version: v, native: true }
      }
    }
    // shim 폴백 — 이 경로로는 `cmd` 인용이 필요하다(아래 spawn 참고).
    const shim = path.join(REAL_HOME, 'codex-engines', v, 'node_modules', '.bin', process.platform === 'win32' ? 'codex.cmd' : 'codex')
    return fs.existsSync(shim) ? { bin: shim, version: v, native: false } : null
  } catch {
    return null
  }
}

/** JSONL 한 줄씩 읽는 최소 JSON-RPC 클라이언트(우리 드라이버가 하는 일의 Node 대역). */
function rpcClient(child) {
  let buf = ''
  const lines = []
  const waiters = []
  child.stdout.on('data', (d) => {
    buf += d.toString('utf8')
    for (let nl; (nl = buf.indexOf('\n')) >= 0; ) {
      const l = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!l) continue
      let v
      try { v = JSON.parse(l) } catch { continue }
      lines.push(v)
      for (const w of waiters.splice(0)) w(v)
    }
  })
  return {
    lines,
    send: (o) => child.stdin.write(JSON.stringify(o) + '\n'),
    /** 그 id의 응답(또는 상한). */
    wait: (id, ms) =>
      new Promise((resolve) => {
        const hit = lines.find((v) => v.id === id && (v.result !== undefined || v.error !== undefined))
        if (hit) return resolve(hit)
        const t = setTimeout(() => resolve(null), ms)
        const on = (v) => {
          if (v.id === id && (v.result !== undefined || v.error !== undefined)) { clearTimeout(t); resolve(v) }
          else waiters.push(on)
        }
        waiters.push(on)
      })
  }
}

async function phaseHandshake() {
  console.log('\n[HANDSHAKE] 실 codex app-server — 격리 CODEX_HOME')
  const found = realCodexBin()
  const out = { bin: found?.bin ?? null, version: found?.version ?? null }
  if (!found) {
    out.skipped = '앱 홈에 설치된 codex 실행본이 없다'
    rep.steps.handshake = out
    console.log(`  · 건너뜀 — ${out.skipped}`)
    return
  }
  // **격리** CODEX_HOME. 비어 있다 = codex는 "로그인 안 됨"으로 본다(2.6.2 실측 주석).
  const HOME = homeFor('rpc')
  rmrf(HOME)
  fs.mkdirSync(HOME, { recursive: true })
  out.codexHome = HOME
  out.realCodexUntouched = !fs.existsSync(path.join(HOME, '..', '.codex'))

  out.native = found.native
  const t0 = Date.now()
  // 네이티브면 직접, shim이면 `cmd /C ""<경로>" app-server"`(바깥 따옴표 한 겹 —
  // Node의 인자 이스케이프를 피하려고 verbatim으로 넘긴다).
  const child = found.native
    ? spawn(found.bin, ['app-server'], { cwd: HOME, env: { ...process.env, CODEX_HOME: HOME }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    : spawn('cmd', ['/C', `""${found.bin}" app-server"`], {
        cwd: HOME, env: { ...process.env, CODEX_HOME: HOME }, stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true, windowsVerbatimArguments: true
      })
  let err = ''
  child.stderr.on('data', (d) => (err += d.toString()))
  const rpc = rpcClient(child)
  try {
    rpc.send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { clientInfo: { name: 'agentcodegui', title: 'AgentCodeGUI', version: '3.0.0' }, capabilities: { experimentalApi: true } }
    })
    const init = await rpc.wait(1, 20_000)
    out.initializeMs = Date.now() - t0
    out.initialize = init ? (init.error ? { error: init.error } : { ok: true, result: init.result }) : null
    if (!init) fail('handshake.initialize', '20초 안에 응답이 없다', { stderr: err.slice(-400) })
    else if (init.error) fail('handshake.initialize', 'initialize가 거절됐다', { error: init.error })
    else ok('handshake.initialize', { ms: out.initializeMs, keys: Object.keys(init.result ?? {}) })

    if (init && !init.error) {
      rpc.send({
        jsonrpc: '2.0', id: 2, method: 'thread/start',
        params: {
          cwd: HOME, model: 'gpt-5.6-terra', approvalPolicy: 'untrusted', sandbox: 'workspace-write',
          config: { tools: { experimental_request_user_input: {} }, features: { default_mode_request_user_input: true, unified_exec: true } }
        }
      })
      const th = await rpc.wait(2, 20_000)
      out.threadStart = th ? (th.error ? { error: th.error } : { ok: true, threadId: th.result?.thread?.id ?? null }) : null
      if (!th) fail('handshake.thread', '20초 안에 응답이 없다')
      else if (th.error) console.log(`  · thread/start 거절(예상: 미로그인) — ${JSON.stringify(th.error).slice(0, 200)}`)
      else ok('handshake.thread', { threadId: out.threadStart.threadId })

      // ── 드라이런: 우리가 **보내는 모든 RPC**를 실 서버가 받아 주는가 ────────
      //
      // 자격증명이 없으니 모델을 부르는 호출은 실패한다. 재는 것은 성공 여부가 아니라
      // **"메서드 이름·파라미터 모양이 0.149.0에서 여전히 유효한가"** 다:
      // `-32601 Method not found`나 스키마 오류가 오면 우리 조립이 낡은 것이고,
      // 인증/네트워크 오류가 오면 조립은 맞고 계정만 없는 것이다.
      const tid = out.threadStart?.threadId
      if (tid) {
        const calls = [
          ['thread/backgroundTerminals/list', { threadId: tid }],
          ['turn/start', { threadId: tid, input: [{ type: 'text', text: 'ping', text_elements: [] }], model: 'gpt-5.6-terra', effort: 'medium' }],
          ['turn/interrupt', { threadId: tid, turnId: '00000000-0000-0000-0000-000000000000' }],
          ['model/list', {}]
        ]
        out.dryRun = {}
        let id = 2
        for (const [method, params] of calls) {
          id += 1
          rpc.send({ jsonrpc: '2.0', id, method, params })
          const r = await rpc.wait(id, 25_000)
          const verdict = !r
            ? 'timeout'
            : r.error
              ? (String(r.error.code) === '-32601' ? 'unknown-method' : 'error')
              : 'ok'
          out.dryRun[method] = { verdict, error: r?.error ?? null, resultKeys: r?.result ? Object.keys(r.result) : null }
          if (verdict === 'unknown-method') fail(`handshake.${method}`, '0.149.0이 모르는 메서드 — 조립이 낡았다', out.dryRun[method])
          else console.log(`  · ${method} → ${verdict}${r?.error ? ' — ' + String(r.error.message ?? '').slice(0, 120) : ''}`)
          // ★ 미로그인 턴의 **실패 경로**를 그대로 받아 적는다. 2.6.2 주석은
          //   "error 알림(willRetry=false) → turn/completed(failed)"라고 적었는데,
          //   그 문장이 0.149.0에서도 참인지는 여기서만 알 수 있다(우리 옮김기가
          //   그 두 프레임에 의존한다 — FRAME_MAP `error{willRetry:false}`·`turn/completed`).
          if (method === 'turn/start' && verdict === 'ok') {
            const t1 = Date.now()
            while (Date.now() - t1 < 25_000) {
              if (rpc.lines.some((l) => l.method === 'turn/completed' || (l.method === 'error' && l.params?.willRetry === false))) break
              await sleep(200)
            }
            out.unauthenticatedTurn = rpc.lines
              .filter((l) => l.method && l.id === undefined)
              .slice(-14)
              .map((l) => ({ method: l.method, params: JSON.stringify(l.params ?? {}).slice(0, 320) }))
          }
        }
      }
    }
    // 우리 드라이버가 실제로 보는 프레임 수(프레이밍이 도는지)
    out.framesSeen = rpc.lines.length
    out.notifications = [...new Set(rpc.lines.filter((l) => l.method && l.id === undefined).map((l) => l.method))]
    // 서버→클라 **요청**(우리가 답해야 하는 것). 옮김표에 없는 method가 여기 뜨면
    // 그건 우리가 모르는 승인/질문 경로다 — 조용히 지나가면 안 된다.
    out.serverRequests = [...new Set(rpc.lines.filter((l) => l.method && l.id !== undefined).map((l) => l.method))]
  } finally {
    try { child.stdin.end() } catch { /* 이미 닫힘 */ }
    await sleep(400)
    killTree(child.pid)
    out.stderrTail = err.slice(-400)
  }
  rep.steps.handshake = out
  if (!KEEP) rmrf(HOME)
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) 앱 세로 조각 — 실 창 · 제품 경로 · 가짜 app-server
// ─────────────────────────────────────────────────────────────────────────────

const CHAT = 'c-cx'

function fakeHome(steps) {
  const HOME = homeFor('app')
  const WORK = path.join(HOME, 'work')
  rmrf(HOME)
  fs.mkdirSync(WORK, { recursive: true })
  const stub = path.join(REPO, 'target', 'release', 'ccg-fakecodex.exe')
  if (!fs.existsSync(stub)) {
    throw new Error(`가짜 app-server가 없다: ${stub}\n  cargo build -p ccg-engine --features fakecli --bin ccg-fakecodex --release`)
  }
  // Claude 쪽 계정/엔진도 최소로 채운다(부팅 경로가 둘 다 읽는다).
  write(path.join(HOME, 'accounts.json'), { defaultEmail: 'fake@example.com', accounts: [{ email: 'fake@example.com' }] })
  fs.mkdirSync(path.join(HOME, 'accounts', 'fake_example.com'), { recursive: true })
  // Codex 계정 — 등록만 있으면 정규화가 통과한다(토큰은 가짜 서버가 안 본다).
  write(path.join(HOME, 'codex-accounts.json'), {
    version: 1, defaultEmail: 'fake@openai.com', accounts: [{ email: 'fake@openai.com', plan: 'plus', authEnc: '' }]
  })
  const identity = {
    engine: { kind: 'codex', model: 'gpt-5.6-terra', effort: 'medium', codexAccount: 'fake@openai.com' },
    billing: { kind: 'subscription', account: 'fake@example.com', dropEnvKey: false },
    cwd: WORK, addDirs: [], mode: 'auto', systemPrompt: null, outputStyle: null,
    tools: { skillOverrides: {}, deniedMcp: [] }
  }
  write(path.join(HOME, 'chats', 'index.json'), { version: 1, order: [CHAT], activeChatId: CHAT })
  write(path.join(HOME, 'chats', `${CHAT}.json`), {
    id: CHAT, title: 'codex', custom: true, manualCwd: WORK,
    picker: { model: 'haiku', effort: 'medium', mode: 'auto', engine: 'codex', codexModel: 'gpt-5.6-terra', codexAccount: 'fake@openai.com' },
    identity, refDirs: [], snapshot: { messages: [] }, updatedAt: Date.now()
  })
  write(path.join(HOME, 'ui-prefs.json'), { 'ui.lang': 'ko' })
  write(path.join(HOME, 'profile.json'), { nickname: 'poc' })
  const SCRIPT = path.join(HOME, 'script.jsonl')
  fs.writeFileSync(SCRIPT, steps.map((s) => JSON.stringify(s)).join('\n') + '\n')
  return { HOME, WORK, SCRIPT, stub }
}

/** 한 턴 대본 — 2.6.2 와이어 모양 그대로(옮김표의 주요 행을 화면까지 밀어 본다). */
function turnScript(work) {
  const target = path.join(work, 'cx-made.txt')
  const th = 'th-poc'
  const N = (method, params) => ({ emit: { jsonrpc: '2.0', method, params: { threadId: th, ...params } } })
  return [
    { await: 'initialize', result: { userAgent: 'fake-codex/0.0' } },
    { await: 'thread/start', result: { thread: { id: th } } },
    { await: 'turn/start', result: { turn: { id: 'tu-poc' } } },
    N('turn/started', { turn: { id: 'tu-poc' } }),
    { afterMs: 60, ...N('item/reasoning/summaryTextDelta', { itemId: 'r1', delta: 'M4-THINKING' }) },
    { afterMs: 60, ...N('item/agentMessage/delta', { itemId: 'm1', delta: 'M4-STREAM' }) },
    // 할 일 패널
    { afterMs: 60, ...N('turn/plan/updated', { plan: [{ step: 'M4-TODO-A', status: 'inProgress' }, { step: 'M4-TODO-B', status: 'pending' }] }) },
    // 명령 실행(터미널 줄 + 출력)
    { afterMs: 60, ...N('item/started', { item: { id: 'i1', type: 'commandExecution', command: 'echo M4-TERM-OUT' } }) },
    { afterMs: 60, ...N('item/commandExecution/outputDelta', { itemId: 'i1', delta: 'M4-TERM-OUT\n' }) },
    { afterMs: 60, ...N('item/completed', { item: { id: 'i1', type: 'commandExecution', exitCode: 0, aggregatedOutput: 'M4-TERM-OUT', durationMs: 12 } }) },
    // 파일 변경(add — diff 필드에 원문 그대로가 오는 실측 모양)
    { afterMs: 60, ...N('item/started', { item: { id: 'i2', type: 'fileChange', changes: [{ path: target }] } }) },
    { afterMs: 60, ...N('item/completed', { item: { id: 'i2', type: 'fileChange', status: 'completed', changes: [
      { path: target, kind: { type: 'add' }, diff: 'M4-LINE-1\nM4-LINE-2\n' }] } }) },
    // 토큰/컨텍스트
    { afterMs: 60, ...N('thread/tokenUsage/updated', { tokenUsage: {
      last: { inputTokens: 500, cachedInputTokens: 100, outputTokens: 40, totalTokens: 540 },
      total: { inputTokens: 500, cachedInputTokens: 100, outputTokens: 40, totalTokens: 540 },
      modelContextWindow: 272000 } }) },
    { afterMs: 60, ...N('item/completed', { item: { id: 'm1', type: 'agentMessage', text: 'M4-ALL-DONE' } }) },
    { afterMs: 60, ...N('turn/completed', { turn: { id: 'tu-poc', status: 'completed', durationMs: 1234 } }) }
  ]
}

async function boot(home, port, env = {}) {
  const child = spawn(EXE, [], {
    env: { ...process.env, CCG_HOME: home, ...env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  child.stdout.on('data', (d) => (log += d.toString()))
  child.stderr.on('data', (d) => (log += d.toString()))
  const cdp = await connectMainPage(port, { timeoutMs: 60_000 })
  for (let i = 0; i < 300; i++) {
    const up = await cdp.eval(`(async () => { try { return !!(await window.api.app.getVersion()) } catch { return false } })()`, { awaitPromise: true }).catch(() => false)
    if (up) break
    await sleep(100)
  }
  const j = async (expr) => JSON.parse(await cdp.eval(`(async () => JSON.stringify(${expr}))()`, { awaitPromise: true }))
  return { child, cdp, j, log: () => log }
}

async function waitUntil(app, expr, ms = 30_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await app.j(`await (async () => !!(${expr}))()`).catch(() => false)) return true
    await sleep(120)
  }
  return false
}

async function typeAndSend(app, text) {
  return await app.j(`(() => {
    const ta = document.querySelector('.composer-row textarea') || document.querySelector('textarea')
    if (!ta) return 'no-textarea'
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    set.call(ta, ${JSON.stringify(text)})
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    ta.focus()
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    return 'sent'
  })()`)
}

async function phaseApp() {
  console.log('\n[APP] 세로 조각 — 실 창 · 가짜 app-server')
  if (!fs.existsSync(EXE)) {
    console.log(`  · 건너뜀 — exe가 없다: ${EXE}`)
    rep.steps.app = { skipped: `exe 없음: ${EXE}` }
    return
  }
  const s = fakeHome(turnScript(path.join(homeFor('app'), 'work')))
  const out = { home: s.HOME }
  const app = await boot(s.HOME, PORT, { CCG_CODEX_BIN: s.stub, CCG_FAKECODEX_SCRIPT: s.SCRIPT })
  try {
    await app.j(`(window.__ev = [], window.api.onEngineEvent((e) => window.__ev.push(e)), 'armed')`)
    out.ready = await waitUntil(app, `(await window.api.getChats())?.activeChatId === ${JSON.stringify(CHAT)} && !!document.querySelector('.composer-row textarea')`, 40_000)
    if (!out.ready) fail('app.ready', '컴포저가 안 떴다')
    await typeAndSend(app, 'Codex로 한 바퀴 돌아 줘')
    out.turnDone = await waitUntil(app, `window.__ev.some((e) => e.type === 'result')`, 60_000)
    if (!out.turnDone) fail('app.turn', 'result 이벤트가 안 왔다')
    await sleep(800)

    // ① 엔진이 실제로 codex로 떴는가(허브 진단)
    out.debug = await app.j(`(await window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: 'engine:debug', payload: [] })).chats?.[0] ?? null`)
    if (out.debug?.engine !== 'codex') fail('app.engine', `codex 드라이버로 안 떴다: ${JSON.stringify(out.debug?.engine)}`)
    else ok('app.engine', { engine: out.debug.engine, session: out.debug.session })

    // ② 이벤트 — 2.6.2 EngineEvent로 도착했는가
    out.events = await app.j(`window.__ev.reduce((m, e) => ((m[e.type] = (m[e.type] ?? 0) + 1), m), {})`)
    out.byType = await app.j(`(() => {
      const pick = (t) => window.__ev.filter((e) => e.type === t)
      return {
        session: pick('session').map((e) => ({ sessionId: e.sessionId, model: e.model })),
        todos: pick('todos').map((e) => e.todos.map((t) => t.label + ':' + t.status)),
        fileChange: pick('file-change').map((e) => ({ path: e.file.path, add: e.file.add, tag: e.file.tag, whole: e.whole })),
        terminal: pick('terminal').map((e) => e.line.text),
        context: pick('context').map((e) => e.contextTokens),
        result: pick('result').map((e) => ({ isError: e.isError, durationMs: e.durationMs, ctx: e.contextTokens, win: e.contextWindow, usage: e.tokenUsage }))
      }
    })()`)
    // ③ 화면(DOM) — 이벤트와 독립인 두 번째 증거
    out.dom = await app.j(`(() => {
      const txt = document.body.innerText
      return { reply: txt.includes('M4-ALL-DONE'), term: txt.includes('M4-TERM-OUT'),
               chips: [...document.querySelectorAll('.workbar .wb-chip')].map((b) => (b.querySelector('.cc-label')?.textContent ?? '') + '=' + (b.querySelector('.cc-pct')?.textContent ?? '')) }
    })()`)
    out.fileMade = fs.existsSync(path.join(s.WORK, 'cx-made.txt'))
    for (const [id, cond] of [
      ['app.session', out.byType.session.some((x) => x.sessionId === 'th-poc')],
      ['app.stream', out.dom.reply],
      ['app.terminal', out.byType.terminal.some((t) => t.includes('M4-TERM-OUT'))],
      ['app.todos', (out.byType.todos[0] ?? []).some((t) => t.startsWith('M4-TODO-A'))],
      ['app.fileChange', out.byType.fileChange.some((f) => f.path.endsWith('cx-made.txt'))],
      ['app.context', out.byType.context.includes(540)],
      ['app.result', (out.byType.result[0]?.usage ?? []).some((u) => u.model === 'gpt-5.6-terra')]
    ]) {
      if (cond) ok(id)
      else fail(id, '없음', { events: out.events })
    }
  } finally {
    await app.j(`(window.api.win.close(), 'closing')`).catch(() => {})
    await sleep(700)
    killTree(app.child.pid)
    out.log = app.log().slice(-500)
  }

  // ④ 재시작 후 대화가 남는가(저장 = 세로 조각의 마지막 칸)
  await sleep(600)
  const app2 = await boot(s.HOME, PORT + 1, { CCG_CODEX_BIN: s.stub, CCG_FAKECODEX_SCRIPT: s.SCRIPT })
  try {
    out.afterRestart = await app2.j(`await (async () => {
      const full = await window.api.loadChat(${JSON.stringify(CHAT)})
      const msgs = full?.snapshot?.messages ?? []
      return { count: msgs.length, hasReply: JSON.stringify(msgs).includes('M4-ALL-DONE') }
    })()`)
    if (out.afterRestart?.hasReply) ok('app.persist', out.afterRestart)
    else fail('app.persist', '재시작 후 답변이 없다', out.afterRestart)
  } finally {
    await app2.j(`(window.api.win.close(), 'closing')`).catch(() => {})
    await sleep(600)
    killTree(app2.child.pid)
  }
  rep.steps.app = out
  if (!KEEP) rmrf(s.HOME)
}

// ─────────────────────────────────────────────────────────────────────────────

const main = async () => {
  if (only === 'all' || only === 'handshake') await phaseHandshake()
  if (only === 'all' || only === 'app') await phaseApp()
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(rep, null, 2))
  console.log(`\n결과 → ${path.relative(REPO, OUT)}  (findings ${rep.findings.length})`)
  process.exit(rep.findings.length ? 1 : 0)
}
main().catch((e) => {
  console.error(e)
  rep.findings.push({ id: 'harness', why: String(e?.message ?? e) })
  try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(rep, null, 2)) } catch { /* 보고 못 남김 */ }
  process.exit(1)
})
