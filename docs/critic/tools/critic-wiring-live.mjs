#!/usr/bin/env node
/* ============================================================================
 * critic-wiring-live — **배선 R1 크리틱의 라이브 공격 5종**.
 *
 * 빌더의 세로 조각(scripts/poc-live-chat.mjs)은 **행복 경로 한 줄**만 밟는다:
 * 부팅→전송→스트리밍→승인(허용)→완료→재시작. 사용자가 실제로 밟는 나머지 경로는
 * 하나도 안 밟혔다. 여기서 그 다섯을 실 CLI·실 창·실 화면으로 친다.
 *
 *  A 중단   스트리밍 중 소프트 중단 → 화면에 중단선? 그 뒤 재개(다음 턴)가 되나?
 *  B 거부   승인 카드 '거부' → 턴이 정상 정리되나? 파일은 안 생기나?
 *  C 전환   busy 중 다른 채팅으로 전환 (m-logic P7: 침묵 no-op이면 결함)
 *  D 강종   스트리밍 중 앱 강제 종료 → 재시작 시 유령 진행 표시가 남나? (m-logic §5)
 *  E CLI킬  승인 카드 뜬 채 claude.exe만 kill → 카드가 정착하나? 사유가 보이나?
 *
 *   node docs/critic/tools/critic-wiring-live.mjs            # 전부
 *   node docs/critic/tools/critic-wiring-live.mjs --only=A,C # 골라서
 *   node docs/critic/tools/critic-wiring-live.mjs --keep     # 홈 보존
 *
 * ── 안전 ────────────────────────────────────────────────────────────────────
 *  · 이름 기반 kill 금지. 죽이는 것은 이 스크립트가 spawn한 PID(와 그 트리)뿐이다.
 *    E는 예외적으로 **engine:debug가 알려 준 자식 pid 하나**만 죽인다.
 *  · 실홈은 읽기/복사만(engines=정션, 자격증명=복사). CCG_HOME으로 완전 격리.
 * ========================================================================== */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { connectMainPage, killTree, sleep, REPO } from '../../../bench/lib.mjs'

const argv = process.argv.slice(2)
const only = (argv.find((a) => a.startsWith('--only=')) ?? '').split('=')[1]
const pick = only ? new Set(only.split(',').map((s) => s.trim().toUpperCase())) : null
const KEEP = argv.includes('--keep')
const EXE = (argv.find((a) => a.startsWith('--exe=')) ?? '').split('=')[1] || path.join(REPO, 'target', 'release', 'agentcodegui.exe')
const REAL_HOME = path.join(os.homedir(), '.agentcodegui')
const OUT = path.join(REPO, 'docs', 'critic', 'wiring-r1-attacks.json')

// --only로 일부만 돌려도 **직전 결과를 덮지 않는다**(공격별 산출물이 사라지는 사고 방지).
const prior = (() => { try { return JSON.parse(fs.readFileSync(OUT, 'utf8')) } catch { return null } })()
const rep = {
  at: new Date().toISOString(),
  exe: EXE,
  attacks: prior?.attacks ?? {},
  findings: (prior?.findings ?? []).filter((f) => !pick || !pick.has(String(f.id)[0])),
  runs: [...(prior?.runs ?? []), { at: new Date().toISOString(), exe: EXE, only: only ?? 'all' }]
}
const fail = (id, why, extra) => {
  rep.findings.push({ id, why, ...(extra ?? {}) })
  console.error(`  ✗ ${id} — ${why}`)
}
const ok = (id, v) => console.log(`  ✓ ${id}${v === undefined ? '' : ' — ' + JSON.stringify(v)}`)
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true })
const write = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v))
}

// ── 격리 홈 씨앗 ─────────────────────────────────────────────────────────────
function seed(tag, chats) {
  const HOME = path.join(REPO, `.critic-home-${tag}`)
  const WORK = path.join(HOME, 'work')
  rmrf(HOME)
  fs.mkdirSync(WORK, { recursive: true })
  const ver = JSON.parse(fs.readFileSync(path.join(REAL_HOME, 'config.json'), 'utf8')).activeVersion
  write(path.join(HOME, 'config.json'), { activeVersion: ver })
  const link = path.join(HOME, 'engines')
  spawnSync('cmd', ['/c', 'mklink', '/J', link, path.join(REAL_HOME, 'engines')], { encoding: 'utf8' })
  const cli = path.join(link, ver, 'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe')
  if (!fs.existsSync(cli)) throw new Error(`claude.exe 없음: ${cli}`)
  const accounts = JSON.parse(fs.readFileSync(path.join(REAL_HOME, 'accounts.json'), 'utf8'))
  const prefix = accounts.defaultEmail.replace('@', '_').replace('+', '-')
  const srcDir = fs.readdirSync(path.join(REAL_HOME, 'accounts')).find((n) => n === prefix || n.startsWith(prefix + '-'))
  const dstDir = path.join(HOME, 'accounts', srcDir)
  fs.mkdirSync(dstDir, { recursive: true })
  for (const f of ['.credentials.json', '.claude.json']) {
    const s = path.join(REAL_HOME, 'accounts', srcDir, f)
    if (fs.existsSync(s)) fs.copyFileSync(s, path.join(dstDir, f))
  }
  write(path.join(HOME, 'accounts.json'), accounts)
  write(path.join(HOME, 'chats', 'index.json'), { version: 1, order: chats, activeChatId: chats[0] })
  for (const id of chats) {
    write(path.join(HOME, 'chats', `${id}.json`), {
      id,
      title: `크리틱 ${id}`,
      custom: true,
      manualCwd: WORK,
      picker: { model: 'haiku', effort: 'minimal', mode: 'normal' },
      refDirs: [],
      snapshot: { messages: [] },
      updatedAt: Date.now()
    })
  }
  write(path.join(HOME, 'ui-prefs.json'), { 'ui.lang': 'ko' })
  write(path.join(HOME, 'profile.json'), { nickname: 'critic' })
  return { HOME, WORK, ver }
}

function cleanup(HOME) {
  if (KEEP) return
  spawnSync('cmd', ['/c', 'rmdir', path.join(HOME, 'engines')], { encoding: 'utf8' })
  rmrf(HOME)
}

// ── 부팅 + CDP + 3.0 채널 도청 ───────────────────────────────────────────────
async function boot(home, port, env = {}) {
  const child = spawn(EXE, [], {
    env: { ...process.env, CCG_HOME: home, ...env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  child.stdout.on('data', (d) => (log += d.toString()))
  child.stderr.on('data', (d) => (log += d.toString()))
  const cdp = await connectMainPage(port, { timeoutMs: 60_000 })
  for (let i = 0; i < 400; i++) {
    const up = await cdp
      .eval(`(async () => { try { return !!(await window.api.app.getVersion()) } catch { return false } })()`, { awaitPromise: true })
      .catch(() => false)
    if (up) break
    await sleep(100)
  }
  const j = async (expr) => JSON.parse(await cdp.eval(`(async () => JSON.stringify(${expr}))()`, { awaitPromise: true }))
  // 2.6.2 렌더러가 받는 이벤트 + 3.0 브로드캐스트를 **둘 다** 도청한다.
  await j(`(window.__ev = [], window.api.onEngineEvent((e) => window.__ev.push(e)), 'armed')`)
  await j(`await (async () => {
    window.__b = { 'chat:status': [], 'chat:run-state': [], 'chat:verdict': [], 'chat:event': [], 'chat:identity': [] }
    for (const ch of Object.keys(window.__b)) {
      const cb = window.__TAURI_INTERNALS__.transformCallback((ev) => window.__b[ch].push(ev.payload))
      await window.__TAURI_INTERNALS__.invoke('plugin:event|listen', { event: ch, target: { kind: 'Any' }, handler: cb })
    }
    return 'armed'
  })()`)
  return { child, cdp, j, log: () => log }
}

const dbg = (app) => app.j(`await window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: 'engine:debug', payload: [] })`)

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

async function waitFor(app, expr, ms = 60_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const v = await app.j(expr).catch(() => null)
    if (v) return v
    await sleep(120)
  }
  return null
}

const LONG = 'Count from 1 to 80. Print one number per line, and after each number add a short sentence about that number. Do not use any tools.'
const WRITE_PROMPT = (name, body) =>
  `Use the Write tool to create ${name} with the exact content ${body}. Then reply with exactly: DONE`

// ─────────────────────────────────────────────────────────────────────────────
// A — 스트리밍 중 소프트 중단
// ─────────────────────────────────────────────────────────────────────────────
async function attackA() {
  console.log('\n[A] 스트리밍 중 소프트 중단')
  const s = seed('int', ['c-a'])
  const app = await boot(s.HOME, 9371, { CCG_ENGINE_LOG: path.join(s.HOME, 'frames.jsonl') })
  const out = {}
  try {
    await typeAndSend(app, LONG)
    // 델타가 넉넉히 흐를 때까지
    const got = await waitFor(app, `(window.__ev.filter((e) => e.type === 'assistant-stream').length >= 3) || null`, 90_000)
    out.deltasBeforeInterrupt = await app.j(`window.__ev.filter((e) => e.type === 'assistant-stream').length`)
    if (!got) fail('A-스트리밍', '중단할 스트림이 안 왔다', out)
    out.beforeDbg = await dbg(app)
    // ★ 사용자 경로 그대로 — Esc(=컴포저 중지 버튼과 같은 `cancelRun`).
    //   window.api.interrupt()만 부르면 렌더러의 로컬 리듀서(중단 마커)를 건너뛴다.
    out.via = 'Escape'
    await app.j(`(window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })), 'esc')`)
    await sleep(3000)
    out.afterInterrupt = await app.j(`({
      marker: !!document.body.innerText.match(/중단함|Interrupted/),
      working: !!document.querySelector('.working-line'),
      composerDisabled: !!document.querySelector('.composer-row textarea')?.disabled,
      verdicts: window.__b['chat:verdict'].map((v) => v.verdict && v.verdict.cmd + ':' + v.verdict.kind),
      lastStatus: (window.__b['chat:status'].at(-1) || []).map((x) => ({ id: x.chatId, s: x.status, busy: x.busy })),
      runStates: window.__b['chat:run-state'].map((r) => r.state),
      status262: window.__ev.filter(e => e.type === 'status').map(e => e.status),
      sidebarDot: [...document.querySelectorAll('.sb-item .dot')].map(n => n.className)
    })`)
    out.afterDbg = await dbg(app)
    // 재개 — 중단 뒤 다음 턴이 정상적으로 도는가
    const evBefore = await app.j(`window.__ev.length`)
    await typeAndSend(app, 'Reply with exactly: RESUMED')
    const res = await waitFor(app, `(() => { const r = window.__ev.slice(${evBefore}).find((e) => e.type === 'result'); return r ? { text: (r.text||'').slice(0,40), isError: r.isError } : null })()`, 120_000)
    out.resume = res ?? { timeout: true }
    out.resumeDom = await app.j(`document.body.innerText.includes('RESUMED')`)
    out.finalDbg = await dbg(app)
    if (!out.afterInterrupt.marker) fail('A-중단선', '중단 마커가 화면에 없다', out.afterInterrupt)
    else ok('A-중단선')
    if (!res) fail('A-재개', '중단 후 다음 턴이 안 돌았다(result 없음)', out)
    else ok('A-재개', res)
  } catch (e) {
    fail('A', String(e))
  } finally {
    out.leftoverCli = liveChildren(app.child.pid)
    killTree(app.child.pid)
    await sleep(800)
    out.cliAfterKill = liveChildren(app.child.pid)
    cleanup(s.HOME)
  }
  rep.attacks.A = out
}

// ─────────────────────────────────────────────────────────────────────────────
// B — 승인 거부
// ─────────────────────────────────────────────────────────────────────────────
async function attackB() {
  console.log('\n[B] 승인 카드 거부')
  const s = seed('deny', ['c-a'])
  const target = path.join(s.WORK, 'deny-me.txt')
  const app = await boot(s.HOME, 9372, { CCG_ENGINE_LOG: path.join(s.HOME, 'frames.jsonl') })
  const out = {}
  try {
    await typeAndSend(app, WRITE_PROMPT('deny-me.txt', 'NOPE'))
    const card = await waitFor(
      app,
      `(() => { const el = document.querySelector('.q-overlay .qcard'); if (!el) return null;
        return { tool: el.querySelector('.qtool')?.textContent ?? '', opts: [...el.querySelectorAll('.qopt .ql')].map(n => n.textContent) } })()`,
      120_000
    )
    out.card = card
    if (!card) {
      fail('B-카드', '승인 카드가 안 떴다')
      return
    }
    // 마지막 선택지 = 거부
    out.clicked = await app.j(`(() => {
      const opts = [...document.querySelectorAll('.q-overlay .qcard .qopt')]
      const i = opts.findIndex((o) => /거부|Deny/.test(o.textContent || ''))
      if (i < 0) return 'no-deny-option'
      opts[i].click(); return 'clicked:' + i
    })()`)
    const res = await waitFor(
      app,
      `(() => { const r = window.__ev.find((e) => e.type === 'result'); return r ? { isError: r.isError, text: (r.text||'').slice(0,80) } : null })()`,
      120_000
    )
    out.result = res ?? { timeout: true }
    await sleep(1500)
    out.after = await app.j(`({
      cardGone: !document.querySelector('.q-overlay .qcard'),
      working: !!document.querySelector('.working-line'),
      events: window.__ev.reduce((m,e) => ((m[e.type]=(m[e.type]??0)+1), m), {}),
      toolEnd: window.__ev.filter(e => e.type === 'tool-end').map(e => ({ status: e.status, result: (e.result||'').slice(0,60) })),
      lastStatus: (window.__b['chat:status'].at(-1) || []).map((x) => ({ id: x.chatId, s: x.status, busy: x.busy, ask: x.ask })),
      domTail: document.body.innerText.slice(-400)
    })`)
    out.fileCreated = fs.existsSync(target)
    out.dbg = await dbg(app)
    if (!res) fail('B-정리', '거부 뒤 턴이 안 끝났다(result 없음)', out)
    else if (out.fileCreated) fail('B-거부', '거부했는데 파일이 생겼다', out)
    else if (!out.after.cardGone) fail('B-카드정착', '거부 뒤에도 카드가 남아 있다', out.after)
    else if (out.after.lastStatus.some((x) => x.busy || x.ask !== 'none')) fail('B-상태', '거부 뒤 busy/ask가 안 내려갔다', out.after.lastStatus)
    else ok('B-거부', { result: res, file: out.fileCreated })
  } catch (e) {
    fail('B', String(e))
  } finally {
    killTree(app.child.pid)
    await sleep(800)
    cleanup(s.HOME)
  }
  rep.attacks.B = out
}

// ─────────────────────────────────────────────────────────────────────────────
// C — busy 중 채팅 전환
// ─────────────────────────────────────────────────────────────────────────────
async function attackC() {
  console.log('\n[C] busy 중 채팅 전환')
  const s = seed('sw', ['c-a', 'c-b'])
  const app = await boot(s.HOME, 9373, { CCG_ENGINE_LOG: path.join(s.HOME, 'frames.jsonl') })
  const out = {}
  try {
    out.sidebarBefore = await app.j(`[...document.querySelectorAll('.sb-item')].map(n => ({ cls: n.className, t: n.querySelector('.tx')?.textContent }))`)
    await typeAndSend(app, LONG)
    await waitFor(app, `(window.__ev.filter((e) => e.type === 'assistant-stream').length >= 2) || null`, 90_000)
    out.busyNow = await app.j(`!!document.querySelector('.working-line') || window.__ev.some(e => e.type==='status' && e.status==='working')`)
    out.sidebarBusy = await app.j(`[...document.querySelectorAll('.sb-item')].map(n => ({ cls: n.className, t: n.querySelector('.tx')?.textContent }))`)
    // 사이드바에서 다른 채팅을 **클릭**한다(사용자가 하는 그대로).
    out.clickResult = await app.j(`(() => {
      const items = [...document.querySelectorAll('.sb-item')]
      const other = items.find(n => !n.className.includes('active'))
      if (!other) return 'no-other-item'
      other.click(); return 'clicked'
    })()`)
    await sleep(1200)
    out.afterClick = await app.j(`({
      active: (await window.api.getChats())?.activeChatId ?? null,
      sidebar: [...document.querySelectorAll('.sb-item')].map(n => ({ cls: n.className, t: n.querySelector('.tx')?.textContent })),
      threadHasCount: document.body.innerText.includes('Count from 1 to 80') || /\\b1\\b[\\s\\S]{0,80}\\b2\\b/.test(document.body.innerText)
    })`)
    out.switched = out.afterClick.sidebar.findIndex((x) => x.cls.includes('active')) !== out.sidebarBusy.findIndex((x) => x.cls.includes('active'))
    out.lockedClass = out.sidebarBusy.some((x) => x.cls.includes('locked'))
    out.dbg = await dbg(app)
    if (!out.switched) fail('C-전환', 'busy 중 채팅 전환이 침묵 no-op이다(m-logic P7)', { locked: out.lockedClass, sidebar: out.sidebarBusy })
    else ok('C-전환', { active: out.afterClick.active })
  } catch (e) {
    fail('C', String(e))
  } finally {
    killTree(app.child.pid)
    await sleep(800)
    cleanup(s.HOME)
  }
  rep.attacks.C = out
}

// ─────────────────────────────────────────────────────────────────────────────
// D — 스트리밍 중 앱 강제 종료 → 재시작
// ─────────────────────────────────────────────────────────────────────────────
async function attackD() {
  console.log('\n[D] 스트리밍 중 강제 종료 → 재시작')
  const s = seed('crash', ['c-a'])
  const out = {}
  const app = await boot(s.HOME, 9374, { CCG_ENGINE_LOG: path.join(s.HOME, 'frames.jsonl') })
  try {
    await typeAndSend(app, LONG)
    await waitFor(app, `(window.__ev.filter((e) => e.type === 'assistant-stream').length >= 3) || null`, 90_000)
    out.beforeKill = await app.j(`({ status: (window.__b['chat:status'].at(-1)||[]).map(x=>({id:x.chatId,s:x.status,busy:x.busy})),
                                     working: !!document.querySelector('.working-line') })`)
    out.dbgBeforeKill = await dbg(app)
    const kids = liveChildren(app.child.pid)
    out.cliBeforeKill = kids
    // 강제 종료 — 종료 flush(D15)를 **안 태우는** 경로(사용자의 작업관리자 kill / 크래시)
    killTree(app.child.pid)
    await sleep(1500)
    out.cliAfterKill = kids.filter((p) => alive(Number(String(p).split(' ')[0])))
    out.statusJsonOnDisk = readJson(path.join(s.HOME, 'chats-v3', 'status.json'))
    out.chatFileOnDisk = (() => {
      const v = readJson(path.join(s.HOME, 'chats-v3', 'c-a.json'))
      return v ? { msgs: v.snapshot?.messages?.length ?? null, status: v.status ?? null, queue: v.queue?.length ?? null } : null
    })()
  } catch (e) {
    fail('D-kill', String(e))
  }
  // 재시작
  const app2 = await boot(s.HOME, 9375)
  try {
    await sleep(2500)
    out.afterRestart = await app2.j(`({
      working: !!document.querySelector('.working-line'),
      ghostText: /진행 중|Working|생각 중|Thinking/.test(document.body.innerText),
      dots: [...document.querySelectorAll('.sb-item .dot')].map(n => n.className),
      composerDisabled: !!document.querySelector('.composer-row textarea')?.disabled,
      status: (window.__b['chat:status'].at(-1)||[]).map(x=>({id:x.chatId,s:x.status,busy:x.busy,ask:x.ask})),
      msgs: (await window.api.loadChat('c-a'))?.snapshot?.messages?.length ?? null,
      domTail: document.body.innerText.slice(-300)
    })`)
    out.dbgAfterRestart = await dbg(app2)
    // 재시작 뒤 한 턴이 정상으로 도는가(유령이 다음 턴을 막지 않는가)
    const evBefore = await app2.j(`window.__ev.length`)
    await typeAndSend(app2, 'Reply with exactly: ALIVE')
    const r = await waitFor(app2, `(() => { const r = window.__ev.slice(${evBefore}).find(e => e.type==='result'); return r ? { text:(r.text||'').slice(0,40) } : null })()`, 120_000)
    out.postRestartTurn = r ?? { timeout: true }
    const ghost = out.afterRestart.working || out.afterRestart.status.some((x) => x.busy || x.s === 'working' || x.s === 'analyzing')
    if (ghost) fail('D-유령', '재시작 후에도 진행 중 표시가 남았다', out.afterRestart)
    else ok('D-유령없음', out.afterRestart.status)
    if (!r) fail('D-후속턴', '재시작 후 다음 턴이 안 돌았다', out)
    else ok('D-후속턴', r)
  } catch (e) {
    fail('D-restart', String(e))
  } finally {
    killTree(app2.child.pid)
    await sleep(800)
    cleanup(s.HOME)
  }
  rep.attacks.D = out
}

// ─────────────────────────────────────────────────────────────────────────────
// E — 승인 카드 뜬 채 claude.exe만 kill
// ─────────────────────────────────────────────────────────────────────────────
async function attackE() {
  console.log('\n[E] 승인 카드 뜬 채 CLI kill')
  const s = seed('kill', ['c-a'])
  const app = await boot(s.HOME, 9376, { CCG_ENGINE_LOG: path.join(s.HOME, 'frames.jsonl') })
  const out = {}
  try {
    await typeAndSend(app, WRITE_PROMPT('kill-me.txt', 'X'))
    const card = await waitFor(app, `(!!document.querySelector('.q-overlay .qcard')) || null`, 120_000)
    if (!card) {
      fail('E-카드', '승인 카드가 안 떴다')
      return
    }
    out.dbgAtCard = await dbg(app)
    const pid = out.dbgAtCard?.chats?.[0]?.pid ?? null
    out.cliPid = pid
    if (!pid) {
      fail('E-pid', 'engine:debug가 CLI pid를 안 준다', out.dbgAtCard)
      return
    }
    // **이 앱이 spawn한 자식 하나만** 죽인다(이름 기반 kill 아님).
    try {
      execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', timeout: 15000 })
    } catch {}
    out.killedAt = Date.now()
    await sleep(1000)
    out.pidStillAlive = alive(pid) // ← kill이 실제로 먹었는지(하네스 자기검증)
    // 90초 동안 카드가 정착하는지 관찰(5s 간격 샘플)
    out.samples = []
    for (let i = 0; i < 18; i++) {
      await sleep(5000)
      const snap = await app.j(`({
        t: ${i} * 5,
        card: !!document.querySelector('.q-overlay .qcard'),
        working: !!document.querySelector('.working-line'),
        state: (window.__b['chat:run-state'].at(-1)||{}).state ?? null,
        settled: (window.__b['chat:run-state'].at(-1)||{}).settled ?? [],
        live: ((window.__b['chat:run-state'].at(-1)||{}).live||[]).length,
        status: (window.__b['chat:status'].at(-1)||[]).map(x=>({s:x.status,busy:x.busy,ask:x.ask})),
        notices: window.__ev.filter(e => e.type==='notice').map(e => (e.text||'').slice(0,80)),
        result: !!window.__ev.find(e => e.type==='result')
      })`).catch(() => null)
      if (snap) out.samples.push(snap)
      if (snap && !snap.card && (snap.result || snap.state === 'idle')) break
    }
    const last = out.samples.at(-1) ?? {}
    out.settledIn = out.samples.findIndex((x) => !x.card)
    out.dbgAfter = await dbg(app)
    // 탈출구가 있나 — ① 카드를 눌러 본다 ② Esc를 눌러 본다
    await app.j(`(() => { const o = document.querySelector('.q-overlay .qcard .qopt'); if (o) o.click(); return 'clicked' })()`)
    await sleep(20_000)
    out.afterAllowClick = await app.j(`({
      card: !!document.querySelector('.q-overlay .qcard'),
      state: (window.__b['chat:run-state'].at(-1)||{}).state ?? null,
      status: (window.__b['chat:status'].at(-1)||[]).map(x=>({s:x.status,busy:x.busy,ask:x.ask})),
      result: !!window.__ev.find(e => e.type==='result')
    })`)
    await app.j(`(window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })), 'esc')`)
    await sleep(15_000)
    out.afterEsc = await app.j(`({
      card: !!document.querySelector('.q-overlay .qcard'),
      state: (window.__b['chat:run-state'].at(-1)||{}).state ?? null,
      status: (window.__b['chat:status'].at(-1)||[]).map(x=>({s:x.status,busy:x.busy,ask:x.ask}))
    })`)
    out.dbgAfterEsc = await dbg(app)
    if (last.card) fail('E-정착', 'CLI가 죽었는데 승인 카드가 90초 뒤에도 살아 있다', last)
    else ok('E-정착', { afterSec: out.settledIn * 5, state: last.state })
    if (!last.notices?.length && !last.result) fail('E-사유', '정착 사유가 화면에 안 보인다(notice/result 없음)', last)
    else ok('E-사유', { notices: last.notices, result: last.result })
  } catch (e) {
    fail('E', String(e))
  } finally {
    killTree(app.child.pid)
    await sleep(800)
    cleanup(s.HOME)
  }
  rep.attacks.E = out
}

// ─────────────────────────────────────────────────────────────────────────────
// F — **스트리밍 중** CLI kill (E의 일반화: 카드가 없어도 같은 자리에서 굳나?)
//     E가 AwaitingUser 전용 문제인지, 외부 CLI 사망 전반이 미탐지인지 가른다.
// ─────────────────────────────────────────────────────────────────────────────
async function attackF() {
  console.log('\n[F] 스트리밍 중 CLI kill')
  const s = seed('killstream', ['c-a'])
  const app = await boot(s.HOME, 9377, { CCG_ENGINE_LOG: path.join(s.HOME, 'frames.jsonl') })
  const out = {}
  try {
    await typeAndSend(app, LONG)
    await waitFor(app, `(window.__ev.filter((e) => e.type === 'assistant-stream').length >= 3) || null`, 90_000)
    out.dbgBefore = await dbg(app)
    const pid = out.dbgBefore?.chats?.[0]?.pid ?? null
    out.cliPid = pid
    try {
      execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', timeout: 15000 })
    } catch {}
    await sleep(1000)
    out.pidStillAlive = alive(pid)
    out.samples = []
    for (let i = 0; i < 24; i++) {
      await sleep(5000)
      const snap = await app.j(`({
        t: ${i} * 5,
        working: !!document.querySelector('.working-line'),
        state: (window.__b['chat:run-state'].at(-1)||{}).state ?? null,
        live: ((window.__b['chat:run-state'].at(-1)||{}).live||[]).length,
        status: (window.__b['chat:status'].at(-1)||[]).map(x=>({s:x.status,busy:x.busy})),
        notices: window.__ev.filter(e => e.type==='notice').map(e => (e.text||'').slice(0,60)),
        result: !!window.__ev.find(e => e.type==='result'),
        composerDisabled: !!document.querySelector('.composer-row textarea')?.disabled
      })`).catch(() => null)
      if (snap) out.samples.push(snap)
      if (snap && (snap.result || snap.state === 'idle')) break
    }
    const last = out.samples.at(-1) ?? {}
    out.dbgAfter = await dbg(app)
    // 굳은 채팅에서 사용자가 할 수 있는 게 남아 있나 — 전송 / 다른 채팅으로 도피 / Esc
    const evBefore = await app.j(`window.__ev.length`)
    await typeAndSend(app, 'Reply with exactly: PING')
    out.wedged = await app.j(`({
      queuedChip: /대기|Queued|\\+1/.test(document.querySelector('.composer-row')?.innerText || ''),
      composerText: (document.querySelector('.composer-row textarea')?.value || '').slice(0, 40),
      sidebarLocked: [...document.querySelectorAll('.sb-item')].map(n => n.className)
    })`)
    out.pingResult =
      (await waitFor(app, `(() => { const r = window.__ev.slice(${evBefore}).find(e => e.type==='result'); return r ? { text:(r.text||'').slice(0,30) } : null })()`, 45_000)) ?? { timeout: true }
    // Esc(소프트 중단)로 탈출할 수 있나
    await app.j(`(window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })), 'esc')`)
    await sleep(5000)
    out.afterEsc = await app.j(`({
      state: (window.__b['chat:run-state'].at(-1)||{}).state ?? null,
      status: (window.__b['chat:status'].at(-1)||[]).map(x=>({s:x.status,busy:x.busy})),
      marker: !!document.body.innerText.match(/중단함|Interrupted/)
    })`)
    out.dbgAfterEsc = await dbg(app)
    if (last.state !== 'idle' && !last.result) fail('F-정착', '스트리밍 중 CLI가 죽어도 120초까지 상태가 안 내려온다', last)
    else ok('F-정착', { state: last.state, sec: out.samples.length * 5 })
  } catch (e) {
    fail('F', String(e))
  } finally {
    killTree(app.child.pid)
    await sleep(800)
    cleanup(s.HOME)
  }
  rep.attacks.F = out
}

// ── 유틸 ─────────────────────────────────────────────────────────────────────
function liveChildren(pid) {
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`],
      { encoding: 'utf8', timeout: 20000 }
    )
    return out.split('\n').map((x) => x.trim()).filter(Boolean)
  } catch {
    return []
  }
}
function alive(pid) {
  try {
    return (
      execFileSync('powershell', ['-NoProfile', '-Command', `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'y' } else { 'n' }`], {
        encoding: 'utf8',
        timeout: 15000
      }).trim() === 'y'
    )
  } catch {
    return false
  }
}
function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
if (!fs.existsSync(EXE)) {
  console.error(`릴리즈 exe가 없다: ${EXE}`)
  process.exit(2)
}
const run = { A: attackA, B: attackB, C: attackC, D: attackD, E: attackE, F: attackF }
for (const [k, fn] of Object.entries(run)) {
  if (pick && !pick.has(k)) continue
  try {
    await fn()
  } catch (e) {
    fail(k, '하네스 예외: ' + String(e))
  }
}
rep.verdict = rep.findings.length === 0 ? 'PASS' : 'FAIL'
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(rep, null, 2))
console.log(`\n판정: ${rep.verdict} · 결함 ${rep.findings.length}건 · ${OUT}`)
