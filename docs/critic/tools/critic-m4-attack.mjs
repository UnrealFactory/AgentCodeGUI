#!/usr/bin/env node
/* ============================================================================
 * critic-m4-attack — M4 R1(3f0c179) 크리틱 공격 하네스.
 *
 *   --only=failui   미로그인 실패 경로를 **실측 프레임 그대로** 재생 → 화면에 뜨는
 *                   결과/오류 카드 수를 센다(빌더 주장: "결과 카드 한 장").
 *   --only=extkill  app-server를 **프로세스 밖에서** kill → T22 상당 정착 규약이
 *                   Claude와 같은가(5s 안 정착 · 사유 문장 · 컴포저 해제 · 재전송).
 *   --only=switch   채팅 도중 Claude→Codex 전환(T17 재스폰) — 상태·큐·hold 보존.
 *   --only=newver   신버전 가정 프레임(모르는 통지·아이템·서버요청) 유입 → 침묵/크래시.
 *
 * 안전: 이름 기반 kill 0회(내가 spawn한 PID 트리 + engine:debug가 알려 준 자식 pid만).
 *       실홈은 읽기만. 앱 홈은 전부 CCG_HOME 격리(워크트리 안 .critic-home-m4-*).
 * ========================================================================== */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { connectMainPage, killTree, sleep, REPO, resolveTauriExe } from '../../../bench/lib.mjs'

const args = process.argv.slice(2)
const only = (args.find((a) => a.startsWith('--only=')) ?? '').split('=')[1] || 'all'
const KEEP = args.includes('--keep')
// M12 R2 — mainBinaryName 변경으로 exe 이름이 둘이다(AgentCodeGUI3/agentcodegui — 둘 다 탐색, 최신 mtime 채택)
const EXE = (args.find((a) => a.startsWith('--exe=')) ?? '').split('=')[1] || resolveTauriExe('')
const OUT = path.join(REPO, 'docs', 'critic', 'm4-r1-attack.json')
const STUB_CODEX = path.join(REPO, 'target', 'release', 'ccg-fakecodex.exe')
const STUB_CLI = path.join(REPO, 'target', 'release', 'ccg-fakecli.exe')

const rep = { at: new Date().toISOString(), exe: EXE, steps: {}, findings: [] }
const fail = (id, why, extra) => { rep.findings.push({ id, why, ...(extra ?? {}) }); console.error(`  X ${id} — ${why}`) }
const ok = (id, v) => console.log(`  o ${id}${v === undefined ? '' : ' — ' + JSON.stringify(v)}`)
const rmrf = (p) => { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 }) } catch { /* 다음 주행 */ } }
const write = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v, null, 2)) }
const homeFor = (n) => path.join(REPO, `.critic-home-m4-${n}`)

// ── 공통 홈 시드 ─────────────────────────────────────────────────────────────
function seed(name, { chat, engine, script }) {
  const HOME = homeFor(name)
  const WORK = path.join(HOME, 'work')
  rmrf(HOME)
  fs.mkdirSync(WORK, { recursive: true })
  write(path.join(HOME, 'accounts.json'), { defaultEmail: 'fake@example.com', accounts: [{ email: 'fake@example.com' }] })
  fs.mkdirSync(path.join(HOME, 'accounts', 'fake_example.com'), { recursive: true })
  write(path.join(HOME, 'codex-accounts.json'), {
    version: 1, defaultEmail: 'fake@openai.com', accounts: [{ email: 'fake@openai.com', plan: 'plus', authEnc: '' }]
  })
  // 가짜 claude.exe(엔진 전환 공격에 필요) — 2.6.2 엔진 디렉터리 규약 그대로.
  const ed = path.join(HOME, 'engines', 'fake', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64')
  fs.mkdirSync(ed, { recursive: true })
  if (fs.existsSync(STUB_CLI)) fs.copyFileSync(STUB_CLI, path.join(ed, 'claude.exe'))
  write(path.join(HOME, 'config.json'), { activeVersion: 'fake' })

  const codex = engine === 'codex'
  const identity = {
    engine: codex
      ? { kind: 'codex', model: 'gpt-5.6-terra', effort: 'medium', codexAccount: 'fake@openai.com' }
      : { kind: 'claude', model: 'haiku', effort: 'minimal' },
    billing: { kind: 'subscription', account: 'fake@example.com', dropEnvKey: false },
    cwd: WORK, addDirs: [], mode: 'auto', systemPrompt: null, outputStyle: null,
    tools: { skillOverrides: {}, deniedMcp: [] }
  }
  write(path.join(HOME, 'chats', 'index.json'), { version: 1, order: [chat], activeChatId: chat })
  write(path.join(HOME, 'chats', `${chat}.json`), {
    id: chat, title: 'critic', custom: true, manualCwd: WORK,
    picker: codex
      ? { model: 'haiku', effort: 'medium', mode: 'auto', engine: 'codex', codexModel: 'gpt-5.6-terra', codexAccount: 'fake@openai.com' }
      : { model: 'haiku', effort: 'minimal', mode: 'auto' },
    identity, refDirs: [], snapshot: { messages: [] }, updatedAt: Date.now()
  })
  write(path.join(HOME, 'ui-prefs.json'), { 'ui.lang': 'ko' })
  write(path.join(HOME, 'profile.json'), { nickname: 'critic' })
  const SCRIPT = path.join(HOME, 'script.jsonl')
  if (script) fs.writeFileSync(SCRIPT, script.map((s) => JSON.stringify(s)).join('\n') + '\n')
  return { HOME, WORK, SCRIPT }
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
const dbg = async (app) => await app.j(`(await window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: 'engine:debug', payload: [] })).chats?.[0] ?? null`)
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

// ─────────────────────────────────────────────────────────────────────────────
// ① 미로그인 실패 경로 UI — 실측 프레임을 그대로 재생
// ─────────────────────────────────────────────────────────────────────────────

/** poc-codex --only=handshake가 실 0.149.0에서 받아 적은 순서(요지 그대로). */
function failScript() {
  const th = 'th-fail'
  const tu = 'tu-fail'
  const N = (method, params) => ({ emit: { jsonrpc: '2.0', method, params: { threadId: th, ...params } } })
  const retry = (n, url) => ({ afterMs: 40, ...N('error', {
    turnId: tu, willRetry: true,
    error: { message: `Reconnecting... ${n}/5`, codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 401 } },
             additionalDetails: `unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: ${url}` } }) })
  return [
    { await: 'initialize', result: { userAgent: 'codex/0.149.0' } },
    { await: 'thread/start', result: { thread: { id: th } } },
    { await: 'turn/start', result: { turn: { id: tu } } },
    N('turn/started', { turn: { id: tu } }),
    { afterMs: 40, ...N('item/completed', { item: { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'ping' }] } }) },
    ...[2, 3, 4, 5].map((n) => retry(n, 'wss://api.openai.com/v1/responses')),
    { afterMs: 40, ...N('warning', { message: 'Falling back from WebSockets to HTTPS transport. unexpected status 401 Unauthorized' }) },
    ...[1, 2, 3, 4, 5].map((n) => retry(n, 'https://api.openai.com/v1/responses')),
    { afterMs: 40, ...N('thread/status/changed', { status: { type: 'systemError' } }) },
    { afterMs: 40, ...N('error', { turnId: tu, willRetry: false,
      error: { message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header', codexErrorInfo: 'other' } }) },
    { afterMs: 200, ...N('turn/completed', { turn: { id: tu, status: 'failed', itemsView: 'notLoaded',
      error: { message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header' } } }) }
  ]
}

async function phaseFailUi() {
  console.log('\n[FAILUI] 미로그인 실패 경로 — 실측 프레임 재생')
  const s = seed('failui', { chat: 'c-fail', engine: 'codex', script: failScript() })
  const out = { home: s.HOME }
  const app = await boot(s.HOME, 9520, { CCG_CODEX_BIN: STUB_CODEX, CCG_FAKECODEX_SCRIPT: s.SCRIPT })
  try {
    await app.j(`(window.__ev = [], window.api.onEngineEvent((e) => window.__ev.push(e)), 'armed')`)
    await waitUntil(app, `(await window.api.getChats())?.activeChatId === 'c-fail' && !!document.querySelector('.composer-row textarea')`, 40_000)
    await typeAndSend(app, '로그인 없이 한 턴')
    out.settled = await waitUntil(app, `window.__ev.some((e) => e.type === 'result')`, 60_000)
    await sleep(2500) // 늦게 오는 둘째 프레임까지 기다린다
    out.events = await app.j(`window.__ev.reduce((m, e) => ((m[e.type] = (m[e.type] ?? 0) + 1), m), {})`)
    out.results = await app.j(`window.__ev.filter((e) => e.type === 'result').map((e) => ({ isError: e.isError, text: String(e.text ?? '').slice(0, 110) }))`)
    out.noticeCounts = await app.j(`(() => { const m = {}; for (const e of window.__ev) if (e.type === 'notice') m[e.text] = (m[e.text] ?? 0) + 1; return m })()`)
    out.errors = await app.j(`window.__ev.filter((e) => e.type === 'error').map((e) => String(e.message ?? '').slice(0, 90))`)
    out.notices = await app.j(`window.__ev.filter((e) => e.type === 'notice').map((e) => String(e.text ?? '').slice(0, 80))`)
    // 화면에 실제로 그려진 것
    out.dom = await app.j(`(() => {
      const t = document.body.innerText
      const count = (re) => (t.match(re) ?? []).length
      return {
        errCards: document.querySelectorAll('.msg-error, .err-card, .result-error').length,
        reconnecting: count(/Reconnecting/g),
        unauthorized: count(/401 Unauthorized/g),
        fallingBack: count(/Falling back/g),
        bodyTail: t.slice(-900)
      }
    })()`)
    out.state = (await dbg(app))?.state ?? null
    out.busy = await app.j(`(() => { const ta = document.querySelector('.composer-row textarea'); return { disabled: !!ta?.disabled } })()`)
    const nRes = out.results.length + out.errors.length
    if (nRes === 1) ok('failui.oneCard', { results: out.results, errors: out.errors })
    else fail('failui.oneCard', `결과/오류 카드가 ${nRes}장`, { results: out.results, errors: out.errors })
    if (out.dom.reconnecting <= 2) ok('failui.noise', { reconnecting: out.dom.reconnecting })
    else fail('failui.noise', `재시도 안내가 ${out.dom.reconnecting}줄 — 화면 소음`, { reconnecting: out.dom.reconnecting, notices: out.notices.length })
    if (out.state === 'Resident' || out.state === 'Idle') ok('failui.settled', { state: out.state })
    else fail('failui.settled', `정착 안 됨: ${out.state}`)
    if (!out.busy.disabled) ok('failui.composer')
    else fail('failui.composer', '컴포저가 잠긴 채로 남았다')
  } finally {
    await app.j(`(window.api.win.close(), 'closing')`).catch(() => {})
    await sleep(700)
    killTree(app.child.pid)
    out.log = app.log().slice(-400)
  }
  rep.steps.failui = out
  if (!KEEP) rmrf(s.HOME)
}

// ─────────────────────────────────────────────────────────────────────────────
// ② app-server 외부 kill — T22 상당(Claude와 같은 규약인가)
// ─────────────────────────────────────────────────────────────────────────────

function stallScript() {
  const th = 'th-kill'
  const N = (m, p) => ({ emit: { jsonrpc: '2.0', method: m, params: { threadId: th, ...p } } })
  return [
    { await: 'initialize', result: { userAgent: 'codex/0.149.0' } },
    { await: 'thread/start', result: { thread: { id: th } } },
    { await: 'turn/start', result: { turn: { id: 'tu-kill' } } },
    N('turn/started', { turn: { id: 'tu-kill' } }),
    { afterMs: 80, ...N('item/agentMessage/delta', { itemId: 'm1', delta: 'CRITIC-STREAMING' }) }
    // 여기서 멈춘다 — turn/completed를 영영 안 준다(= 스트리밍 중 kill의 무대)
  ]
}

async function phaseExtKill() {
  console.log('\n[EXTKILL] app-server 외부 kill — T22 상당')
  const s = seed('extkill', { chat: 'c-kill', engine: 'codex', script: stallScript() })
  const out = { home: s.HOME, samples: [] }
  const app = await boot(s.HOME, 9524, { CCG_CODEX_BIN: STUB_CODEX, CCG_FAKECODEX_SCRIPT: s.SCRIPT })
  try {
    await app.j(`(window.__ev = [], window.api.onEngineEvent((e) => window.__ev.push(e)), 'armed')`)
    await waitUntil(app, `(await window.api.getChats())?.activeChatId === 'c-kill' && !!document.querySelector('.composer-row textarea')`, 40_000)
    await typeAndSend(app, '스트리밍 중에 죽여 본다')
    out.streaming = await waitUntil(app, `document.body.innerText.includes('CRITIC-STREAMING')`, 40_000)
    const d0 = await dbg(app)
    out.before = { state: d0?.state, pid: d0?.pid, engine: d0?.engine, spawns: d0?.spawns, exits: d0?.exits }
    if (!d0?.pid) { fail('extkill.pid', 'engine:debug가 자식 pid를 안 준다'); return }
    // ★ 죽이는 것은 **engine:debug가 알려 준 격리 홈의 자식 pid** 하나뿐이다.
    console.log(`  · taskkill /T /F /PID ${d0.pid} (격리 홈의 fakecodex)`)
    execFileSync('taskkill', ['/T', '/F', '/PID', String(d0.pid)], { stdio: 'ignore' })
    const t0 = Date.now()
    for (let i = 0; i < 24; i++) {
      await sleep(1000)
      const d = await dbg(app)
      const ui = await app.j(`(() => {
        const ta = document.querySelector('.composer-row textarea')
        const t = document.body.innerText
        return { composerDisabled: !!ta?.disabled,
                 notice: (t.match(/엔진[^\\n]{0,80}/g) ?? []).slice(-2),
                 hasResult: window.__ev.some((e) => e.type === 'result'),
                 lastEvents: window.__ev.slice(-4).map((e) => e.type) }
      })()`)
      out.samples.push({ atMs: Date.now() - t0, state: d?.state, exits: d?.exits, ...ui })
      if (d?.state === 'Idle' || d?.state === 'Resident' || ui.hasResult) break
    }
    const settled = out.samples.find((x) => x.state === 'Idle' || x.state === 'Resident' || x.hasResult)
    out.settledInMs = settled?.atMs ?? null
    if (settled && settled.atMs <= 6000) ok('extkill.settle', { ms: settled.atMs, state: settled.state })
    else fail('extkill.settle', `6초 안에 정착 안 함 (${out.settledInMs ?? '>24s'}ms)`, { samples: out.samples.slice(-3) })
    const last = out.samples[out.samples.length - 1]
    if (last && !last.composerDisabled) ok('extkill.composer')
    else fail('extkill.composer', '컴포저가 잠긴 채', { last })
    if (last && last.notice.length) ok('extkill.notice', { notice: last.notice })
    else fail('extkill.notice', '사유 문장이 화면에 없다', { last })
    // 재전송이 되는가(굳지 않았다는 증거) — 대본이 끝났으니 새 프로세스는 침묵한다.
    await typeAndSend(app, '다시 보내기')
    await sleep(3000)
    const d2 = await dbg(app)
    out.after = { state: d2?.state, spawns: d2?.spawns, exits: d2?.exits, pid: d2?.pid }
    if ((d2?.spawns ?? 0) > (out.before.spawns ?? 0)) ok('extkill.respawn', out.after)
    else fail('extkill.respawn', '재전송이 새 프로세스를 못 띄웠다', out.after)
  } finally {
    await app.j(`(window.api.win.close(), 'closing')`).catch(() => {})
    await sleep(700)
    killTree(app.child.pid)
    out.log = app.log().slice(-400)
  }
  rep.steps.extkill = out
  if (!KEEP) rmrf(s.HOME)
}

// ─────────────────────────────────────────────────────────────────────────────
// ③ 채팅 도중 Claude→Codex 전환 (T17 재스폰)
// ─────────────────────────────────────────────────────────────────────────────

function claudeScript() {
  return [
    { afterMs: 100, emit: { type: 'control_response', response: { subtype: 'success', request_id: 'init-1', response: {} } } },
    { emit: { type: 'system', subtype: 'init', session_id: 'CL-1', model: 'claude-haiku', cwd: '.', tools: [], apiKeySource: 'none' } },
    { afterMs: 150, emit: { type: 'assistant', session_id: 'CL-1', parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'text', text: 'CLAUDE-SIDE-OK' }], usage: { input_tokens: 7 } } } },
    { emit: { type: 'result', subtype: 'success', is_error: false, result: 'CLAUDE-SIDE-OK', session_id: 'CL-1', total_cost_usd: 0, duration_ms: 1, num_turns: 1 } }
  ]
}
function codexScript() {
  const th = 'th-sw'
  const N = (m, p) => ({ emit: { jsonrpc: '2.0', method: m, params: { threadId: th, ...p } } })
  return [
    { await: 'initialize', result: { userAgent: 'codex/0.149.0' } },
    { await: 'thread/start', result: { thread: { id: th } } },
    { await: 'turn/start', result: { turn: { id: 'tu-sw' } } },
    N('turn/started', { turn: { id: 'tu-sw' } }),
    { afterMs: 80, ...N('item/agentMessage/delta', { itemId: 'm9', delta: 'CODEX-SIDE-OK' }) },
    { afterMs: 60, ...N('item/completed', { item: { id: 'm9', type: 'agentMessage', text: 'CODEX-SIDE-OK' } }) },
    { afterMs: 60, ...N('turn/completed', { turn: { id: 'tu-sw', status: 'completed', durationMs: 9 } }) }
  ]
}

async function phaseSwitch() {
  console.log('\n[SWITCH] 채팅 도중 Claude→Codex (T17)')
  const s = seed('switch', { chat: 'c-sw', engine: 'claude', script: claudeScript() })
  const CX = path.join(s.HOME, 'codex-script.jsonl')
  const CXIN = path.join(s.HOME, 'codex-stdin.jsonl')
  fs.writeFileSync(CX, codexScript().map((x) => JSON.stringify(x)).join('\n') + '\n')
  const out = { home: s.HOME }
  const app = await boot(s.HOME, 9528, {
    CCG_FAKECLI_SCRIPT: s.SCRIPT, CCG_CODEX_BIN: STUB_CODEX, CCG_FAKECODEX_SCRIPT: CX, CCG_FAKECODEX_IN: CXIN
  })
  try {
    await app.j(`(window.__ev = [], window.api.onEngineEvent((e) => window.__ev.push(e)), 'armed')`)
    await waitUntil(app, `(await window.api.getChats())?.activeChatId === 'c-sw' && !!document.querySelector('.composer-row textarea')`, 40_000)
    // 1턴 — Claude
    await typeAndSend(app, '클로드로 한 턴')
    out.claudeTurn = await waitUntil(app, `document.body.innerText.includes('CLAUDE-SIDE-OK')`, 40_000)
    const d1 = await dbg(app)
    out.afterClaude = { engine: d1?.engine, identityEngine: d1?.identityEngine, spawns: d1?.spawns, session: d1?.session, state: d1?.state }
    if (d1?.engine === 'claude') ok('switch.claudeFirst', out.afterClaude)
    else fail('switch.claudeFirst', `1턴이 claude가 아니다: ${d1?.engine}`, out.afterClaude)
    // 2턴 — picker를 codex로 바꾸고 보낸다(렌더러가 보내는 claude:run 모양 그대로)
    out.run = await app.j(`await window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: 'claude:run', payload: [{
      chatId: 'c-sw', prompt: '코덱스로 한 턴', engine: 'codex', codexModel: 'gpt-5.6-terra',
      codexAccount: 'fake@openai.com', effort: 'medium', mode: 'auto', cwd: ${JSON.stringify(s.WORK)} }] })`)
    out.codexTurn = await waitUntil(app, `document.body.innerText.includes('CODEX-SIDE-OK')`, 60_000)
    await sleep(1200)
    out.trace = []
    for (let i = 0; i < 6; i++) {
      const d = await dbg(app)
      out.trace.push({ i, state: d?.state, engine: d?.engine, spawns: d?.spawns, exits: d?.exits, pid: d?.pid, session: d?.session })
      await sleep(700)
    }
    out.stdinToCodex = fs.existsSync(CXIN) ? fs.readFileSync(CXIN, 'utf8').split('\n').filter(Boolean).map((l) => l.slice(0, 160)) : null
    out.evTypes = await app.j(`window.__ev.map((e) => e.type + (e.type === 'notice' ? ':' + String(e.text).slice(0, 60) : ''))`)
    const d2 = await dbg(app)
    out.afterCodex = { engine: d2?.engine, identityEngine: d2?.identityEngine, spawns: d2?.spawns, exits: d2?.exits, session: d2?.session, state: d2?.state, queued: d2?.queued }
    if (d2?.engine === 'codex') ok('switch.toCodex', out.afterCodex)
    else fail('switch.toCodex', `전환 뒤에도 codex가 아니다: ${d2?.engine}`, out.afterCodex)
    if ((d2?.spawns ?? 0) > (d1?.spawns ?? 0)) ok('switch.respawned', { before: d1?.spawns, after: d2?.spawns })
    else fail('switch.respawned', 'T17 재스폰이 안 보인다', { before: d1?.spawns, after: d2?.spawns })
    // 대화가 **둘 다** 남았는가(전환이 원장을 날리지 않았는가)
    out.dom = await app.j(`(() => { const t = document.body.innerText
      return { claude: t.includes('CLAUDE-SIDE-OK'), codex: t.includes('CODEX-SIDE-OK') } })()`)
    if (out.dom.claude && out.dom.codex) ok('switch.ledger', out.dom)
    else fail('switch.ledger', '전환이 앞 턴을 지웠다', out.dom)
    // 되돌아가기 — codex → claude
    out.back = await app.j(`await window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: 'claude:run', payload: [{
      chatId: 'c-sw', prompt: '다시 클로드', model: 'haiku', effort: 'minimal', mode: 'auto', cwd: ${JSON.stringify(s.WORK)} }] })`)
    await sleep(4000)
    const d3 = await dbg(app)
    out.afterBack = { engine: d3?.engine, identityEngine: d3?.identityEngine, spawns: d3?.spawns, state: d3?.state }
    if (d3?.engine === 'claude') ok('switch.backToClaude', out.afterBack)
    else fail('switch.backToClaude', `되돌리기가 안 됐다: ${d3?.engine}`, out.afterBack)
  } finally {
    await app.j(`(window.api.win.close(), 'closing')`).catch(() => {})
    await sleep(700)
    killTree(app.child.pid)
    out.log = app.log().slice(-500)
  }
  rep.steps.switch = out
  if (!KEEP) rmrf(s.HOME)
}

// ─────────────────────────────────────────────────────────────────────────────
// ④ 신버전 가정 — 모르는 프레임이 들어오면
// ─────────────────────────────────────────────────────────────────────────────

function newverScript() {
  const th = 'th-nv'
  const N = (m, p) => ({ emit: { jsonrpc: '2.0', method: m, params: { threadId: th, ...p } } })
  return [
    { await: 'initialize', result: { userAgent: 'codex/0.999.0', newField: { nested: true } } },
    { await: 'thread/start', result: { thread: { id: th, newShape: [1, 2] } } },
    { await: 'turn/start', result: { turn: { id: 'tu-nv' } } },
    N('turn/started', { turn: { id: 'tu-nv' } }),
    // 모르는 통지 6종
    { afterMs: 50, ...N('thread/compaction/started', { at: 1 }) },
    { afterMs: 30, ...N('item/videoGeneration/delta', { itemId: 'v1', delta: 'zzz' }) },
    { afterMs: 30, ...N('turn/usage/v2', { usage: { newUnits: 5 } }) },
    { afterMs: 30, ...N('item/started', { item: { id: 'z1', type: 'brandNewToolKind', label: 'X' } }) },
    { afterMs: 30, ...N('item/completed', { item: { id: 'z1', type: 'brandNewToolKind' } }) },
    { afterMs: 30, ...N('item/reasoning/encryptedDelta', { delta: '????' }) },
    // 모르는 서버→클라 요청(우리가 답해야 한다 — 안 답하면 서버가 멈춘다)
    { afterMs: 30, emit: { jsonrpc: '2.0', id: 9001, method: 'item/mcpToolCall/requestApproval', params: { threadId: th, tool: 'deploy' } } },
    { awaitResponse: 9001 },
    // 그 뒤에도 정상 스트림이 계속 흐르는가
    { afterMs: 50, ...N('item/agentMessage/delta', { itemId: 'm1', delta: 'NEWVER-SURVIVED' }) },
    { afterMs: 40, ...N('item/completed', { item: { id: 'm1', type: 'agentMessage', text: 'NEWVER-SURVIVED' } }) },
    { afterMs: 40, ...N('turn/completed', { turn: { id: 'tu-nv', status: 'completed', durationMs: 3 } }) }
  ]
}

async function phaseNewVer() {
  console.log('\n[NEWVER] 신버전 프레임 유입')
  const s = seed('newver', { chat: 'c-nv', engine: 'codex', script: newverScript() })
  const IN = path.join(s.HOME, 'stdin.jsonl')
  const out = { home: s.HOME }
  const app = await boot(s.HOME, 9532, { CCG_CODEX_BIN: STUB_CODEX, CCG_FAKECODEX_SCRIPT: s.SCRIPT, CCG_FAKECODEX_IN: IN })
  try {
    await app.j(`(window.__ev = [], window.api.onEngineEvent((e) => window.__ev.push(e)), 'armed')`)
    await waitUntil(app, `(await window.api.getChats())?.activeChatId === 'c-nv' && !!document.querySelector('.composer-row textarea')`, 40_000)
    await typeAndSend(app, '신버전 서버')
    out.survived = await waitUntil(app, `document.body.innerText.includes('NEWVER-SURVIVED')`, 60_000)
    await sleep(1500)
    out.events = await app.j(`window.__ev.reduce((m, e) => ((m[e.type] = (m[e.type] ?? 0) + 1), m), {})`)
    const d = await dbg(app)
    out.debug = { state: d?.state, engine: d?.engine, spawns: d?.spawns, exits: d?.exits, pid: d?.pid }
    out.replied9001 = fs.existsSync(IN) && fs.readFileSync(IN, 'utf8').split('\n').some((l) => l.includes('9001'))
    out.reply9001 = fs.existsSync(IN) ? (fs.readFileSync(IN, 'utf8').split('\n').find((l) => l.includes('9001')) ?? '').slice(0, 200) : null
    if (out.survived) ok('newver.survived', { events: out.events })
    else fail('newver.survived', '모르는 프레임 뒤 정상 스트림이 끊겼다', { events: out.events, log: app.log().slice(-400) })
    if (out.replied9001) ok('newver.answeredUnknownRequest', { reply: out.reply9001 })
    else fail('newver.answeredUnknownRequest', '모르는 서버 요청에 답을 안 보냈다 — 서버가 멈춘다')
    if (out.debug.state === 'Resident' || out.debug.state === 'Idle') ok('newver.settled', out.debug)
    else fail('newver.settled', `정착 안 됨: ${out.debug.state}`, out.debug)
    if ((out.debug.exits ?? 0) === 0) ok('newver.noCrash', { exits: out.debug.exits })
    else fail('newver.noCrash', `프로세스가 죽었다(exits=${out.debug.exits})`, out.debug)
  } finally {
    await app.j(`(window.api.win.close(), 'closing')`).catch(() => {})
    await sleep(700)
    killTree(app.child.pid)
    out.log = app.log().slice(-400)
  }
  rep.steps.newver = out
  if (!KEEP) rmrf(s.HOME)
}

// ─────────────────────────────────────────────────────────────────────────────

const main = async () => {
  for (const p of [STUB_CODEX, STUB_CLI, EXE]) {
    if (!fs.existsSync(p)) throw new Error(`없다: ${p}`)
  }
  if (only === 'all' || only === 'failui') await phaseFailUi()
  if (only === 'all' || only === 'extkill') await phaseExtKill()
  if (only === 'all' || only === 'switch') await phaseSwitch()
  if (only === 'all' || only === 'newver') await phaseNewVer()
  write(OUT, rep)
  console.log(`\n결과 → ${path.relative(REPO, OUT)}  (findings ${rep.findings.length})`)
  process.exit(rep.findings.length ? 1 : 0)
}
main().catch((e) => {
  console.error(e)
  rep.findings.push({ id: 'harness', why: String(e?.stack ?? e) })
  try { write(OUT, rep) } catch { /* 보고 못 남김 */ }
  process.exit(1)
})
