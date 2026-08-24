#!/usr/bin/env node
/* ============================================================================
 * critic-m9-attack — M9(도구 환경 칩 · 582872f) **공격 하네스** (크리틱 전용).
 *
 * 빌더 하네스(poc-mcpskill)는 실 CLI 2벌로 행복 경로를 잰다. 이쪽은 실 CLI가
 * **강제할 수 없는 판**을 가짜 CLI(ccg-fakecli)로 만들어 그 경로 밖을 민다.
 *
 *   A1 density     서버 10 + 스킬 50 — 칩 문구·팝오버 기하(스크롤·잘림)·최장 행
 *   A2 weird       이름 특수문자 — mcp_norm 되맞춤 · 서버 이름의 `__` · 도구 이름의 `__`
 *                  · 중복 스킬 이름(React key) · 플러그인 스킬(`plug:skill`)
 *   A3 midturn     턴 **한복판**의 재-init(connected → failed) — 칩이 따라가나
 *   A4 lateCmds    설명이 **늦게** 오는 판: ① commands_changed 푸시 ② init보다 늦은
 *                  initialize 응답 (빌더 문서의 "①이 먼저 온다" 가정이 깨진 경우)
 *   A5 offParallel 같은 보드에서 denied 정책 패널 vs 아닌 패널 — off 행이 옆으로 새나
 *   A6 popout      팝아웃 창(#mapanel)에서도 칩이 사는가 (보고서 §6 미확인 항목)
 *   A7 narrow      420px 패널 헤더 — 칩이 들어간 뒤에도 헤더가 서는가
 *
 * 안전: 이름 기반 kill 금지(내가 spawn한 PID 트리만) · CCG_HOME 격리 · 실홈 무접촉
 *       (가짜 계정 · 가짜 CLI라 토큰·과금 0). 제품 코드 수정 0.
 *
 *   node docs/critic/tools/critic-m9-attack.mjs [--only=A1,A3] [--out=…] [--keep]
 * ========================================================================== */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { cdpTargets, connectMainPage, killTree, sleep, Cdp, REPO, resolveTauriExe } from '../../../bench/lib.mjs'

const args = process.argv.slice(2)
const only = ((args.find((a) => a.startsWith('--only=')) ?? '').split('=')[1] || 'all').split(',')
const KEEP = args.includes('--keep')
// M12 R2 — mainBinaryName 변경으로 exe 이름이 둘이다(AgentCodeGUI3/agentcodegui — 둘 다 탐색, 최신 mtime 채택)
const EXE = (args.find((a) => a.startsWith('--exe=')) ?? '').split('=')[1] || resolveTauriExe('')
const OUT = (args.find((a) => a.startsWith('--out=')) ?? '').split('=')[1] || path.join(REPO, 'docs', 'critic', 'm9-r1-attack.json')
const PORT = 9397
const want = (id) => only[0] === 'all' || only.includes(id)

const rep = { at: new Date().toISOString(), exe: EXE, steps: {}, findings: [] }
const fail = (id, why, extra) => { rep.findings.push({ id, why, ...(extra ?? {}) }); console.error(`  X ${id} — ${why}`) }
const ok = (id, d) => console.log(`  o ${id}${d !== undefined ? ` — ${JSON.stringify(d)}` : ''}`)
const note = (id, d) => console.log(`  . ${id}${d !== undefined ? ` — ${JSON.stringify(d)}` : ''}`)
const write = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v)) }
const rmrf = (p) => { for (let i = 0; i < 10; i++) { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }); return } catch { spawnSync('cmd', ['/c', 'ping', '127.0.0.1', '-n', '2'], { stdio: 'ignore' }) } } }

const HOME = path.join(REPO, '.critic-home-m9')
const WORK0 = path.join(HOME, 'wA')
const WORK1 = path.join(HOME, 'wB')
const SCRIPT = path.join(HOME, 'script.jsonl')
const FRAMES = path.join(HOME, 'frames.jsonl')
/** 셸이 실제로 **받은** 프레임(CCG_ENGINE_LOG) — 화면 계수와 독립인 두 번째 증거. */
const wireFrames = () => {
  if (!fs.existsSync(FRAMES)) return []
  return fs.readFileSync(FRAMES, 'utf8').split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}
const SID = 'm9-crit'
const PID0 = `${SID}::0`
const PID1 = `${SID}::1`

// ── 가짜 CLI 대본 ────────────────────────────────────────────────────────────
const ack = (commands) => ({
  type: 'control_response',
  response: { subtype: 'success', request_id: 'init-1', response: commands ? { commands } : {} }
})
const init = (cwd, { mcp = [], skills = [], tools = [], plugins = [] } = {}) => ({
  type: 'system', subtype: 'init', session_id: 'CRIT-1', model: 'claude-haiku-4-5', cwd,
  tools, mcp_servers: mcp, skills, plugins, slash_commands: [], apiKeySource: 'none'
})
const say = (text) => ({ type: 'assistant', session_id: 'CRIT-1', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text }], usage: { input_tokens: 5 } } })
const done = (text) => ({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: 'CRIT-1', total_cost_usd: 0, duration_ms: 1, num_turns: 1 })
const putScript = (steps) => fs.writeFileSync(SCRIPT, steps.map((s) => JSON.stringify(s)).join('\n') + '\n')
/** 평범한 한 턴: ack → init → 답 → result. `extra`는 result 앞뒤에 끼우는 지시들. */
const turn = (cwd, env, mark, { commands = null, pre = [], post = [] } = {}) => [
  { afterMs: 60, emit: ack(commands) },
  { emit: init(cwd, env) },
  ...pre,
  { afterMs: 80, emit: say(mark) },
  { emit: done(mark) },
  ...post
]

// ── 앱 ───────────────────────────────────────────────────────────────────────
function seed() {
  rmrf(HOME)
  fs.mkdirSync(WORK0, { recursive: true })
  fs.mkdirSync(WORK1, { recursive: true })
  const stub = path.join(REPO, 'target', 'release', 'ccg-fakecli.exe')
  if (!fs.existsSync(stub)) throw new Error(`가짜 CLI 없음: ${stub}`)
  const ed = path.join(HOME, 'engines', 'fake', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64')
  fs.mkdirSync(ed, { recursive: true })
  fs.copyFileSync(stub, path.join(ed, 'claude.exe'))
  write(path.join(HOME, 'config.json'), { activeVersion: 'fake' })
  write(path.join(HOME, 'accounts.json'), { defaultEmail: 'fake@example.com', accounts: [{ email: 'fake@example.com' }] })
  fs.mkdirSync(path.join(HOME, 'accounts', 'fake_example.com'), { recursive: true })
  write(path.join(HOME, 'ui-prefs.json'), { 'ui.lang': 'ko', 'workspace.mode': 'multi', 'whatsnew.seenVersion': '9.9.9' })
  write(path.join(HOME, 'profile.json'), { nickname: 'critic' })
  putScript(turn(WORK0, {}, 'SEED'))
}

async function boot() {
  const child = spawn(EXE, [], {
    cwd: REPO,
    env: { ...process.env, CCG_HOME: HOME, CCG_CDP_PORT: String(PORT), CCG_FAKECLI_SCRIPT: SCRIPT, CCG_ENGINE_LOG: FRAMES },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  child.stdout.on('data', (d) => (log += d.toString()))
  child.stderr.on('data', (d) => (log += d.toString()))
  const cdp = await connectMainPage(PORT, { timeoutMs: 60_000 })
  const j = async (expr) => JSON.parse(await cdp.eval(`(async () => JSON.stringify((${expr}) ?? null))()`, { awaitPromise: true }))
  return { child, cdp, j, log: () => log }
}
async function until(app, expr, ms = 30_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await app.j(`await (async () => !!(${expr}))()`).catch(() => false)) return true
    await sleep(120)
  }
  return false
}
const IPC = (channel, payload = []) =>
  `await window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: ${JSON.stringify(channel)}, payload: ${JSON.stringify(payload)} })`

/** 패널 슬롯에 한 턴 보낸다(사용자 경로: 컴포저 + Enter). */
async function send(app, slot, text) {
  const r = await app.j(`(() => {
    const p = document.querySelector('.ma-panel[data-slot="${slot}"]')
    const ta = p && p.querySelector('textarea')
    if (!ta) return 'no-textarea'
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    set.call(ta, ${JSON.stringify(text)})
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    ta.focus()
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    return 'sent'
  })()`)
  if (r !== 'sent') throw new Error(`슬롯 ${slot} 컴포저 없음: ${r}`)
}

const CHIP = (slot) => `[...document.querySelectorAll('.ma-panel[data-slot="${slot}"] .ma-p-head button.ma-p-folder')]
  .find((b) => /MCP/.test(b.getAttribute('aria-label') || '')) ?? null`
const chipOf = (app, slot) =>
  app.j(`(() => { const b = ${CHIP(slot)}; return b && { text: b.innerText.replace(/\\s+/g,' ').trim(), tip: b.getAttribute('aria-label'),
    redCount: !!b.querySelector('span[style*="--red"]'), w: Math.round(b.getBoundingClientRect().width) } })()`)

/** 팝오버를 열어 통째로 읽는다(행 텍스트 + 기하) — 읽고 바깥클릭으로 닫는다. */
async function popOf(app, slot) {
  await app.j(`(() => { const b = ${CHIP(slot)}; if (!b) return 'no-chip'; b.click(); return 'clicked' })()`)
  await sleep(260)
  const r = await app.j(`(() => {
    const p = document.querySelector('.ma-panel[data-slot="${slot}"]')
    const b = ${CHIP(slot)}
    if (!b) return null
    const pop = (b.closest('.hfold') || p).querySelector('.wb-pop')
    if (!pop) return null
    const secs = []
    let cur = null, foot = null
    for (const el of pop.children) {
      if (el.classList.contains('wb-psep')) { cur = null; foot = ''; continue }
      if (foot !== null) { foot += el.innerText.trim(); continue }
      if (el.classList.contains('hsec')) { cur = { head: el.innerText.trim(), rows: [] }; secs.push(cur) }
      else if (el.classList.contains('wb-pop-list') && cur) cur.rows = [...el.children].map((r) => r.innerText.replace(/\\n/g, ' | ').trim())
      else if (el.classList.contains('ag-none') && cur) cur.rows = ['(EMPTY) ' + el.innerText.trim()]
    }
    const pr = pop.getBoundingClientRect(), pnr = p.getBoundingClientRect()
    const rows = [...pop.querySelectorAll('.wb-prow')]
    const rowH = rows.length ? Math.round(rows[0].getBoundingClientRect().height) : null
    return {
      head: pop.querySelector('.wb-pop-h')?.innerText.replace(/\\n/g, ' | ').trim() ?? null,
      secs, foot,
      geo: { w: Math.round(pr.width), h: Math.round(pr.height), scrollH: pop.scrollHeight, clientH: pop.clientHeight,
             rows: rows.length, rowH,
             overflowX: Math.round(Math.max(0, pnr.left - pr.left) + Math.max(0, pr.right - pnr.right)),
             belowViewport: Math.round(Math.max(0, pr.bottom - window.innerHeight)),
             visibleRows: rows.filter((r) => { const rr = r.getBoundingClientRect(); return rr.top >= pr.top - 1 && rr.bottom <= pr.top + pop.clientHeight + 1 }).length }
    }
  })()`)
  await app.j(`(document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })), 'closed')`)
  await sleep(140)
  return r
}
const longest = (pop) => Math.max(0, ...(pop?.secs ?? []).flatMap((s) => s.rows.map((r) => r.length)))

// ── 본체 ─────────────────────────────────────────────────────────────────────
seed()
const app = await boot()
try {
  if (!(await until(app, 'typeof window.api === "object" && !!(await window.api.app.getVersion())', 60_000)))
    throw new Error('앱 IPC가 안 올라옴')
  // 보드는 앱 자신의 IPC로 심는다(디스크 포맷 무의존) — 폴더가 다른 2패널
  const board = {
    version: 2, activeSessionId: SID,
    sessions: [{
      id: SID, title: 'M9 크리틱', custom: true, count: 2,
      panels: [
        { title: 'A', custom: true, cwd: WORK0, picker: { model: 'haiku', effort: 'minimal', mode: 'normal' } },
        { title: 'B', custom: true, cwd: WORK1, picker: { model: 'haiku', effort: 'minimal', mode: 'normal' } }
      ],
      updatedAt: Date.now()
    }]
  }
  await app.j(`(await window.api.multi.saveState(${JSON.stringify(board)}), 'saved')`)
  await app.cdp.send('Page.reload', {})
  await sleep(1400)
  if (!(await until(app, 'typeof window.api === "object" && !!(await window.api.app.getVersion())', 40_000))) throw new Error('reload 뒤 IPC 없음')
  if (!(await until(app, 'document.querySelectorAll(".ma-panel").length >= 2', 30_000))) throw new Error('2패널이 안 떴다')
  rep.steps.boot = { panels: await app.j('document.querySelectorAll(".ma-panel").length'), win: await app.j('({w:innerWidth,h:innerHeight})') }
  // 이벤트 계수기 — 화면과 독립인 두 번째 증거
  await app.j(`(window.__tl0 = [], window.__tl1 = [],
    window.api.multi.onEvent('${PID0}', (e) => { if (e.type === 'tooling') window.__tl0.push({ at: Date.now(), t: e.tooling }) }),
    window.api.multi.onEvent('${PID1}', (e) => { if (e.type === 'tooling') window.__tl1.push({ at: Date.now(), t: e.tooling }) }), 'armed')`)

  // ── A1 · 서버 10 + 스킬 50 ────────────────────────────────────────────────
  if (want('A1')) {
    const mcp = [
      ...Array.from({ length: 7 }, (_, i) => ({ name: `srv-${i + 1}`, status: 'connected' })),
      { name: 'srv-dead', status: 'failed' },
      { name: 'srv-auth', status: 'needs-auth' },
      { name: 'srv-wait', status: 'pending' }
    ]
    const tools = mcp.flatMap((m) => ['echo', 'ping', 'search'].map((t) => `mcp__${m.name}__${t}`))
    const skills = Array.from({ length: 50 }, (_, i) => `skill-${String(i + 1).padStart(2, '0')}`)
    const commands = skills.map((n, i) => ({
      name: n,
      description: i % 3 === 0
        ? 'Use this skill whenever you are about to create ANY chart, graph, plot, dashboard, or data visualization, in ANY output medium — an HTML or React artifact, inline SVG, plotting code in any library (project)'
        : `짧은 설명 ${i}`,
      argumentHint: ''
    }))
    putScript(turn(WORK0, { mcp, skills, tools }, 'A1-OK', { commands }))
    await send(app, 0, 'A1')
    await until(app, `document.querySelector('.ma-panel[data-slot="0"]').innerText.includes('A1-OK')`, 60_000)
    await sleep(900)
    const chip = await chipOf(app, 0)
    const pop = await popOf(app, 0)
    rep.steps.A1 = { chip, pop: { head: pop?.head, geo: pop?.geo, secHeads: pop?.secs.map((s) => `${s.head}/${s.rows.length}`), longest: longest(pop), sample: pop?.secs?.[0]?.rows?.slice(0, 12) } }
    note('A1 칩', chip)
    note('A1 기하', pop?.geo)
    // 판정 재료: 칩이 10개 중 몇을 말하나 / 팝오버가 몇 행을 한 화면에 보여주나
    if (chip && !/10/.test(chip.text)) fail('A1-count', `서버 10개인데 칩 본문에 전체 수가 없다: "${chip.text}"`, { tip: chip.tip })
    if (chip && !/pending|연결 중|대기/.test(chip.tip ?? '')) fail('A1-tip-pending', `pending 서버가 툴팁에서 사라진다: "${chip.tip}"`)
    if (pop && pop.geo.visibleRows < 8) note('A1-scroll', `한 화면 ${pop.geo.visibleRows}행 / 전체 ${pop.geo.rows}행 (scrollH ${pop.geo.scrollH})`)
  }

  // ── A2 · 이상한 이름 ──────────────────────────────────────────────────────
  if (want('A2')) {
    const longName = 'srv-' + 'x'.repeat(120)
    const mcp = [
      { name: 'my.co tools', status: 'connected' },
      { name: 'srv__dbl', status: 'connected' },
      { name: 'Ω 유니코드 🚀', status: 'connected' },
      { name: longName, status: 'connected' },
      { name: 'no-status-here', status: undefined }
    ].map((m) => (m.status === undefined ? { name: m.name } : m))
    const tools = [
      'mcp__my_co_tools__search',
      'mcp__srv__dbl__ping',           // 서버 이름에 `__` — 뒤에서 가르면 서버=srv, 도구=dbl__ping?
      'mcp__srv__dbl__get__thing',     // 도구 이름에도 `__`
      'mcp__Ω_유니코드_🚀__hello',
      `mcp__${longName}__t1`,
      'mcp__ghost__orphan'             // 서버 목록에 없는 접두사
    ]
    const skills = ['dup-name', 'dup-name', 'myplug:skill', '  공백 ', 'x'.repeat(90)]
    const commands = [
      { name: 'dup-name', description: '중복 이름 스킬 (project)', argumentHint: '' },
      { name: 'myplug:skill', description: '플러그인 스킬 (plugin)', argumentHint: '' },
      { name: 'x'.repeat(90), description: '긴 이름 (user)', argumentHint: '' }
    ]
    putScript(turn(WORK0, { mcp, skills, tools, plugins: [{ name: 'myplug', path: 'C:\\p', version: '1.2.3' }] }, 'A2-OK', { commands }))
    await send(app, 0, 'A2')
    await until(app, `document.querySelector('.ma-panel[data-slot="0"]').innerText.includes('A2-OK')`, 60_000)
    await sleep(900)
    const chip = await chipOf(app, 0)
    const pop = await popOf(app, 0)
    const ev = await app.j('window.__tl0.at(-1).t')
    rep.steps.A2 = { chip, rows: pop?.secs.map((s) => ({ head: s.head, rows: s.rows })), geo: pop?.geo, event: ev }
    note('A2 칩', chip)
    for (const s of pop?.secs ?? []) note('A2 ' + s.head, s.rows)
    const mrow = (n) => (pop?.secs?.[0]?.rows ?? []).find((r) => r.startsWith(n))
    if (!/search/.test(mrow('my.co tools') ?? '')) fail('A2-norm', `mcp_norm 되맞춤 실패: "${mrow('my.co tools')}"`)
    if (!/ping/.test(mrow('srv__dbl') ?? '')) fail('A2-dbl', `서버 이름의 __가 도구 귀속을 깬다: "${mrow('srv__dbl')}"`)
    if (!/hello/.test(mrow('Ω 유니코드 🚀') ?? '')) fail('A2-uni', `유니코드 서버 이름 되맞춤 실패: "${mrow('Ω 유니코드 🚀')}"`)
  }

  // ── A3 · 턴 한복판의 상태 전이 ────────────────────────────────────────────
  if (want('A3')) {
    const alive = { mcp: [{ name: 'srv-live', status: 'connected' }], skills: ['s1'], tools: ['mcp__srv-live__echo'] }
    const dead = { mcp: [{ name: 'srv-live', status: 'failed' }], skills: ['s1'], tools: [] }
    putScript([
      { afterMs: 60, emit: ack([{ name: 's1', description: '스킬 하나 (project)', argumentHint: '' }]) },
      { emit: init(WORK0, alive) },
      { afterMs: 900, emit: say('A3-MID') },
      { afterMs: 900, emit: init(WORK0, dead) },   // ★턴 한복판에 서버가 죽는다(재-init)
      { afterMs: 900, emit: say('A3-OK') },
      { emit: done('A3-OK') }
    ])
    await send(app, 0, 'A3')
    await until(app, `document.querySelector('.ma-panel[data-slot="0"]').innerText.includes('A3-MID')`, 60_000)
    const midChip = await chipOf(app, 0)
    await until(app, `document.querySelector('.ma-panel[data-slot="0"]').innerText.includes('A3-OK')`, 60_000)
    await sleep(700)
    const endChip = await chipOf(app, 0)
    const evs = await app.j('window.__tl0.map((e) => e.t.mcp.map((m) => m.name + ":" + m.status).join(","))')
    rep.steps.A3 = { midChip, endChip, evs: evs.slice(-4) }
    note('A3 중간 칩', midChip)
    note('A3 종료 칩', endChip)
    if (!endChip?.redCount) fail('A3-follow', `턴 중 죽은 서버가 칩에 안 잡힌다 — 종료 칩 "${endChip?.text}" tip "${endChip?.tip}"`)
  }

  // ── A4 · 설명이 늦게 오는 두 판 ───────────────────────────────────────────
  if (want('A4')) {
    // ① init 먼저, initialize 응답이 **나중** (빌더 문서가 "먼저"라고 못 박은 순서의 반대)
    putScript([
      { emit: init(WORK0, { mcp: [], skills: ['late-a'], tools: [] }) },
      { afterMs: 700, emit: ack([{ name: 'late-a', description: '늦게 온 설명 (project)', argumentHint: '' }]) },
      { afterMs: 500, emit: say('A4a-OK') },
      { emit: done('A4a-OK') }
    ])
    await send(app, 0, 'A4a')
    await until(app, `document.querySelector('.ma-panel[data-slot="0"]').innerText.includes('A4a-OK')`, 60_000)
    await sleep(800)
    const popA = await popOf(app, 0)
    // ② result **뒤**의 commands_changed 푸시 (실 앱에선 CLI가 죽어 0장이던 arm)
    putScript([
      { afterMs: 60, emit: ack(null) },
      { emit: init(WORK0, { mcp: [], skills: ['push-b'], tools: [] }) },
      { afterMs: 200, emit: say('A4b-OK') },
      { emit: done('A4b-OK') },
      { afterMs: 700, emit: { type: 'system', subtype: 'commands_changed', commands: [{ name: 'push-b', description: '푸시로 온 설명 (user)', argumentHint: '' }] } },
      { afterMs: 1500, exit: 0 }
    ])
    await send(app, 0, 'A4b')
    await until(app, `document.querySelector('.ma-panel[data-slot="0"]').innerText.includes('A4b-OK')`, 60_000)
    await sleep(2500)
    const popB = await popOf(app, 0)
    // ③ 같은 푸시를 **턴 한복판**에(result 전에) — 와이어 arm 자체가 죽었나, 아니면
    //    턴 끝에 CLI가 죽어 프레임이 애초에 안 오는가를 가른다.
    putScript([
      { afterMs: 60, emit: ack(null) },
      { emit: init(WORK0, { mcp: [], skills: ['mid-c'], tools: [] }) },
      { afterMs: 500, emit: { type: 'system', subtype: 'commands_changed', commands: [{ name: 'mid-c', description: '턴 중 푸시 설명 (project)', argumentHint: '' }] } },
      { afterMs: 400, emit: say('A4c-OK') },
      { emit: done('A4c-OK') }
    ])
    await send(app, 0, 'A4c')
    await until(app, `document.querySelector('.ma-panel[data-slot="0"]').innerText.includes('A4c-OK')`, 60_000)
    await sleep(900)
    const popC = await popOf(app, 0)
    note('A4c(턴 중 푸시) 스킬행', popC?.secs?.at(-1)?.rows)
    if (!/턴 중 푸시 설명/.test(JSON.stringify(popC?.secs ?? []))) fail('A4-midpush', '턴 한복판의 commands_changed도 화면에 안 닿는다(와이어 arm 자체가 죽었다)')
    // ★푸시가 화면에 없을 때 **어디서 끊겼나**: 셸이 프레임을 받기는 했나
    const fr = wireFrames()
    const gotPush = fr.filter((m) => m?.type === 'system' && m?.subtype === 'commands_changed').length
    rep.steps.A4 = {
      late: popA?.secs?.map((s) => s.rows), push: popB?.secs?.map((s) => s.rows),
      evs: await app.j('window.__tl0.length'),
      wire: { frames: fr.length, inits: fr.filter((m) => m?.type === 'system' && m?.subtype === 'init').length, commandsChanged: gotPush }
    }
    note('A4 와이어 계수', rep.steps.A4.wire)
    note('A4a(늦은 initialize) 스킬행', popA?.secs?.at(-1)?.rows)
    note('A4b(commands_changed) 스킬행', popB?.secs?.at(-1)?.rows)
    if (!/늦게 온 설명/.test(JSON.stringify(popA?.secs ?? []))) fail('A4-late', '초기화 응답이 init보다 늦으면 설명이 안 붙는다')
    if (!/푸시로 온 설명/.test(JSON.stringify(popB?.secs ?? []))) fail('A4-push', 'commands_changed 푸시가 화면까지 안 온다')
  }

  // ── A5 · denied 정책 패널 vs 아닌 패널(같은 보드 · 병렬) ──────────────────
  if (want('A5')) {
    const cmds = [{ name: 's-keep', description: '남는 스킬 (project)', argumentHint: '' }]
    const env = { mcp: [{ name: 'srv-on', status: 'connected' }], skills: ['s-keep'], tools: ['mcp__srv-on__echo'] }
    putScript(turn(WORK0, env, 'A5-OK', { commands: cmds }))
    await send(app, 0, 'A5')
    await until(app, `document.querySelector('.ma-panel[data-slot="0"]').innerText.includes('A5-OK')`, 60_000)
    await sleep(600)
    putScript(turn(WORK1, env, 'A5-B-OK', { commands: cmds }))
    await send(app, 1, 'A5b')
    await until(app, `document.querySelector('.ma-panel[data-slot="1"]').innerText.includes('A5-B-OK')`, 60_000)
    await sleep(800)
    // ★패널의 chatId는 panelId가 아니다(`panel_id_to_chat`: 보드 슬롯 → 채팅). 정체성
    //   채널은 chatId를 받으므로 cwd로 되찾는다 — 안 그러면 유령 런타임을 패치한다.
    const dbg = await app.j(IPC('engine:debug'))
    const ids = (dbg?.chats ?? []).map((c) => c.chatId)
    const idents = {}
    for (const id of ids) idents[id] = await app.j(IPC('chat:identity-get', [{ chatId: id }]))
    const cwdOf = (id) => String(idents[id]?.identity?.cwd ?? '').toLowerCase()
    const chat0 = ids.find((id) => cwdOf(id) === WORK0.toLowerCase())
    const chat1 = ids.find((id) => cwdOf(id) === WORK1.toLowerCase())
    rep.steps.A5 = { chats: ids.map((id) => ({ id, cwd: cwdOf(id) })), chat0, chat1 }
    if (!chat0) throw new Error(`패널0의 chatId를 못 찾음: ${JSON.stringify(rep.steps.A5.chats)}`)
    const r = await app.j(IPC('chat:identity-set', [{ chatId: chat0, patch: { tools: { deniedMcp: { 'srv-off': true }, skillOverrides: { 'skill-off': 'disabled' } } }, applyPolicy: 'now' }]))
    rep.steps.A5.identitySet = { kind: r?.kind, tools: r?.identity?.tools, revision: r?.revision }
    note('A5 정책 적용', rep.steps.A5.identitySet)
    await sleep(1500) // 정책은 허브 tick에서 옮김기로 간다 — 재스폰 없이도 스냅샷이 다시 나야 한다
    const cP = await chipOf(app, 0), pP = await popOf(app, 0)
    rep.steps.A5.afterPolicyNoRespawn = { chip: cP, rows: pP?.secs.map((s) => s.rows) }
    note('A5 정책 직후(재스폰 없이)', rep.steps.A5.afterPolicyNoRespawn)
    // 다음 턴(재스폰) 뒤에도 같은가
    putScript(turn(WORK0, env, 'A5-C-OK', { commands: cmds }))
    await send(app, 0, 'A5c')
    await until(app, `document.querySelector('.ma-panel[data-slot="0"]').innerText.includes('A5-C-OK')`, 60_000)
    await sleep(800)
    const c0 = await chipOf(app, 0), p0 = await popOf(app, 0)
    const c1 = await chipOf(app, 1), p1 = await popOf(app, 1)
    rep.steps.A5 = { ...rep.steps.A5, c0, c1, p0: p0?.secs.map((s) => s.rows), p1: p1?.secs.map((s) => s.rows) }
    note('A5 denied 패널 칩', c0); note('A5 denied 패널 행', p0?.secs.map((s) => s.rows))
    note('A5 보통 패널 칩', c1); note('A5 보통 패널 행', p1?.secs.map((s) => s.rows))
    if (!/srv-off/.test(JSON.stringify(p0?.secs ?? []))) fail('A5-offrow', 'denied 패널에 off 행이 안 붙었다(실물 경로 미개통)')
    if (/srv-off|skill-off/.test(JSON.stringify(p1?.secs ?? []))) fail('A5-leak', '옆 패널로 off 행이 샜다')
  }

  // ── A10 · 두 팝오버가 정말 동시에 안 열리나 ───────────────────────────────
  // 보고서 §2.2: "서로의 칩 클릭이 상대에겐 바깥 클릭이다 → 동시에 안 열린다".
  // 그런데 폴더 칩의 래퍼 `.hfold`는 `onMouseDown={stopPropagation}`이고, 도구 팝오버의
  // 바깥닫힘은 **window mousedown**이다. 전파가 막히면 그 창구는 안 울린다.
  if (want('A10')) {
    const env = { mcp: [{ name: 'srv-pop2', status: 'connected' }], skills: ['s2'], tools: [] }
    putScript(turn(WORK0, env, 'A10-OK', { commands: [{ name: 's2', description: '두 팝오버 (project)', argumentHint: '' }] }))
    await send(app, 0, 'A10')
    await until(app, `document.querySelector('.ma-panel[data-slot="0"]').innerText.includes('A10-OK')`, 60_000)
    await sleep(800)
    const openBoth = await app.j(`(() => {
      const p = document.querySelector('.ma-panel[data-slot="0"]')
      const chips = [...p.querySelectorAll('.ma-p-head button.ma-p-folder')]
      const tool = chips.find((b) => /MCP/.test(b.getAttribute('aria-label') || ''))
      const folder = chips.find((b) => !/MCP/.test(b.getAttribute('aria-label') || ''))
      if (!tool || !folder) return { err: 'chip-missing', chips: chips.length }
      tool.click()
      return { afterTool: p.querySelectorAll('.wb-pop').length }
    })()`)
    await sleep(250)
    const both = await app.j(`(() => {
      const p = document.querySelector('.ma-panel[data-slot="0"]')
      const chips = [...p.querySelectorAll('.ma-p-head button.ma-p-folder')]
      const folder = chips.find((b) => !/MCP/.test(b.getAttribute('aria-label') || ''))
      // 사용자의 실제 입력 순서: mousedown → mouseup → click
      folder.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      folder.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }))
      folder.click()
      return 'clicked-folder'
    })()`)
    await sleep(300)
    const shot = await app.j(`(() => {
      const p = document.querySelector('.ma-panel[data-slot="0"]')
      const pops = [...p.querySelectorAll('.wb-pop')].map((x) => { const r = x.getBoundingClientRect()
        return { head: (x.querySelector('.wb-pop-h, .hsec')?.innerText || x.innerText).replace(/\\s+/g, ' ').slice(0, 40),
                 x: Math.round(r.x), w: Math.round(r.width), y: Math.round(r.y), h: Math.round(r.height) } })
      // 겹침 넓이
      let overlap = 0
      if (pops.length === 2) {
        const [a, b] = pops
        overlap = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
      }
      return { count: pops.length, pops, overlap }
    })()`)
    await app.j(`(document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })), 'closed')`)
    rep.steps.A10 = { openBoth, both, shot }
    note('A10 팝오버 상태', shot)
    if (shot.count > 1) fail('A10-two-pops', `도구 환경 팝오버가 열린 채 폴더 칩을 누르면 팝오버가 ${shot.count}장 동시에 뜬다(보고서 §2.2의 반대) · 겹침 ${shot.overlap}px²`, shot.pops)
  }

  // ── A9 · 칩의 수명 — 껍데기가 바뀌면 살아남나 ─────────────────────────────
  // 스냅샷은 컴포넌트 state에 있고 셸(`Wire::env`)에는 그대로 남아 있다. 그런데 다시
  // 물어볼 창구가 없다 — 「크게 보기」·다이얼 변경처럼 **마운트가 갈리는** 조작에서
  // 칩이 사라지면, 사용자는 턴을 한 번 더 태우기 전까지 목록을 못 본다.
  if (want('A9')) {
    const env = { mcp: [{ name: 'srv-life', status: 'connected' }], skills: ['s-life'], tools: ['mcp__srv-life__echo'] }
    putScript(turn(WORK0, env, 'A9-OK', { commands: [{ name: 's-life', description: '수명 시험 (project)', argumentHint: '' }] }))
    await send(app, 0, 'A9')
    await until(app, `document.querySelector('.ma-panel[data-slot="0"]').innerText.includes('A9-OK')`, 60_000)
    await sleep(800)
    const before = await chipOf(app, 0)
    // ① 크게 보기 → 원래 크기로
    const clickBy = (re) => `(() => { const b = [...document.querySelectorAll('.ma-panel[data-slot="0"] button')]
      .find((x) => ${re}.test(x.getAttribute('aria-label') || '')); if (!b) return 'no-btn'; b.click(); return 'clicked' })()`
    await app.j(clickBy('/크게 보기|Expand/'))
    await sleep(1200)
    const expandedChip = await app.j(`(() => { const b = [...document.querySelectorAll('button.ma-p-folder')]
      .find((x) => /MCP/.test(x.getAttribute('aria-label') || '')); return b && { text: b.innerText.replace(/\\s+/g,' ').trim() } })()`)
    await app.j(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /원래 크기로|Restore size/.test(x.getAttribute('aria-label') || '')); if (b) b.click(); return 'back' })()`)
    await sleep(1200)
    const afterRestore = await chipOf(app, 0)
    // ② 다이얼로 자리 수 바꾸기(2 → 1 → 2) — 자리가 접히고 펴지는 사용자 조작
    const dial = await app.j(`(() => { const b = [...document.querySelectorAll('button')].filter((x) => /칸|panel/i.test((x.getAttribute('aria-label')||'') + (x.getAttribute('data-tip')||'')))
      .map((x) => x.getAttribute('aria-label') || x.getAttribute('data-tip')); return b.slice(0, 12) })()`)
    rep.steps.A9 = { before, expandedChip, afterRestore, dialLabels: dial }
    note('A9 칩(턴 뒤)', before)
    note('A9 칩(크게 보기 중)', expandedChip)
    note('A9 칩(원래 크기로 복귀)', afterRestore)
    if (before && !expandedChip) fail('A9-expand', '「크게 보기」로 옮기면 도구 환경 칩이 사라진다(셸엔 값이 그대로 있는데 다시 물을 창구가 없다)')
    if (before && !afterRestore) fail('A9-restore', '「원래 크기로」 돌아오면 칩이 사라진다')
  }

  // ── A8 · 칩이 훔친 자리 (긴 제목 A/B) ─────────────────────────────────────
  // 헤더는 한 줄이다. 칩이 생긴 만큼 제목이 줄어든다 — 402px에서 얼마나 줄었나를
  // **같은 화면에서** 칩만 숨겼다 되살려 잰다(레이아웃 측정용 주입 · 제품 상태 무변경).
  if (want('A8')) {
    await app.cdp.send('Emulation.setDeviceMetricsOverride', { width: 840, height: 780, deviceScaleFactor: 1, mobile: false })
    await sleep(600)
    const LONG = '리팩터링 대형 작업 — 엔진 전환 · 계정 스위치 · 한도 이어서'
    const measure = `(() => {
      const p = document.querySelector('.ma-panel[data-slot="0"]')
      const t = p.querySelector('.ma-p-title')
      const r = t.getBoundingClientRect()
      return { titleW: Math.round(r.width), full: t.scrollWidth, clipped: t.scrollWidth > t.clientWidth + 1,
               panelW: Math.round(p.getBoundingClientRect().width) }
    })()`
    await app.j(`(() => { const t = document.querySelector('.ma-panel[data-slot="0"] .ma-p-title'); t.textContent = ${JSON.stringify(LONG)}; return 'set' })()`)
    await sleep(200)
    const withChip = await app.j(measure)
    await app.j(`(() => { const b = ${CHIP(0)}; if (!b) return 'no-chip'; b.dataset.criticHidden = '1'; b.style.display = 'none'; return 'hidden' })()`)
    await sleep(250)
    const noChip = await app.j(measure)
    await app.j(`(() => { const b = document.querySelector('[data-critic-hidden]'); if (b) b.style.display = ''; return 'restored' })()`)
    await app.cdp.send('Emulation.clearDeviceMetricsOverride', {})
    rep.steps.A8 = { withChip, noChip, lost: noChip.titleW - withChip.titleW, title: LONG }
    note('A8 제목 폭(칩 있음 → 없음)', rep.steps.A8)
  }

  // ── A6 · 팝아웃 창 ────────────────────────────────────────────────────────
  if (want('A6')) {
    await app.j(`(() => { const b = [...document.querySelectorAll('.ma-panel[data-slot="0"] button')].find((x) => /별도 창으로|own window/.test(x.getAttribute('aria-label') || '')); if (!b) return 'no-btn'; b.click(); return 'clicked' })()`)
    await sleep(2500)
    const targets = (await cdpTargets(PORT).catch(() => [])).filter((t) => t.type === 'page')
    const win = targets.find((t) => /mapanel/.test(t.url))
    rep.steps.A6 = { targets: targets.map((t) => t.url) }
    if (!win) fail('A6-window', '팝아웃 창 타깃을 못 찾음', { targets: targets.map((t) => t.url) })
    else {
      const c = await Cdp.connect(win.webSocketDebuggerUrl, { timeoutMs: 8000 })
      const wj = async (expr) => JSON.parse(await c.eval(`(async () => JSON.stringify((${expr}) ?? null))()`, { awaitPromise: true }))
      const w = { j: wj }
      await sleep(600)
      const chip = await wj(`(() => { const b = [...document.querySelectorAll('.ma-p-head button.ma-p-folder')].find((x) => /MCP/.test(x.getAttribute('aria-label') || '')); return b && { text: b.innerText.replace(/\\s+/g,' ').trim(), tip: b.getAttribute('aria-label') } })()`)
      rep.steps.A6.chipBeforeTurn = chip
      note('A6 팝아웃 칩(첫 진입)', chip)
      // 팝아웃 창에서 한 턴 더 — 그 창의 구독으로 스냅샷이 오는가
      putScript(turn(WORK0, { mcp: [{ name: 'srv-pop', status: 'connected' }], skills: ['sp'], tools: ['mcp__srv-pop__echo'] }, 'A6-OK',
        { commands: [{ name: 'sp', description: '팝아웃 스킬 (project)', argumentHint: '' }] }))
      await wj(`(() => {
        const ta = document.querySelector('textarea')
        const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
        set.call(ta, 'A6'); ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus()
        ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return 'sent'
      })()`)
      for (let i = 0; i < 200; i++) { if (await wj('document.body.innerText.includes("A6-OK")').catch(() => false)) break; await sleep(150) }
      await sleep(900)
      const chip2 = await wj(`(() => { const b = [...document.querySelectorAll('.ma-p-head button.ma-p-folder')].find((x) => /MCP/.test(x.getAttribute('aria-label') || '')); return b && { text: b.innerText.replace(/\\s+/g,' ').trim(), tip: b.getAttribute('aria-label') } })()`)
      await wj(`(() => { const b = [...document.querySelectorAll('.ma-p-head button.ma-p-folder')].find((x) => /MCP/.test(x.getAttribute('aria-label') || '')); if (b) b.click(); return 'x' })()`)
      await sleep(300)
      const pop = await wj(`(() => { const p = document.querySelector('.wb-pop'); if (!p) return null
        const r = p.getBoundingClientRect()
        return { text: p.innerText.replace(/\\n/g, ' | ').slice(0, 400), rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, win: { w: innerWidth, h: innerHeight } } })()`)
      rep.steps.A6.chipAfterTurn = chip2
      rep.steps.A6.pop = pop
      note('A6 팝아웃 칩(턴 뒤)', chip2)
      note('A6 팝아웃 팝오버', pop)
      if (!chip2) fail('A6-chip', '팝아웃 창에서 턴을 돌려도 칩이 안 뜬다')
      if (pop && (pop.rect.x < 0 || pop.rect.x + pop.rect.w > pop.win.w + 1)) fail('A6-clip', `팝아웃 창에서 팝오버가 창 밖으로 나간다: ${JSON.stringify(pop.rect)} win ${JSON.stringify(pop.win)}`)
      try { c.close() } catch { /* closed */ }
      // 그리드로 되돌린다(다음 공격이 슬롯 0을 쓴다)
      await app.j(`(() => { const b = [...document.querySelectorAll('.ma-panel[data-slot="0"] button')].find((x) => /창에서 보는 중|되돌|본창/.test((x.getAttribute('aria-label')||'') + (x.getAttribute('data-tip')||''))); if (b) { b.click(); return 'back' } return 'no-back' })()`).catch(() => null)
      await sleep(1200)
    }
  }

  // ── A7 · 420px 패널 헤더 ──────────────────────────────────────────────────
  // M-UI R2가 "420px 패널에서도 이긴다"로 닫은 자리에 M9가 헤더 칩을 하나 더 세웠다.
  // 그 폭에서 헤더가 아직 서는지(잘림·겹침·팝오버 이탈)를 기하로 잰다.
  if (want('A7')) {
    const HEAD = (slot) => `(() => {
      const p = document.querySelector('.ma-panel[data-slot="${slot}"]')
      if (!p) return null
      const h = p.querySelector('.ma-p-head')
      const hr = h.getBoundingClientRect(), pr = p.getBoundingClientRect()
      const pick = (sel) => { const e = h.querySelector(sel); if (!e) return null
        const r = e.getBoundingClientRect()
        return { x: Math.round(r.x), w: Math.round(r.width), text: (e.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
                 clipped: e.scrollWidth > e.clientWidth + 1, outside: r.right > hr.right + 1 || r.left < hr.left - 1 } }
      const chip = [...h.querySelectorAll('button.ma-p-folder')].find((b) => /MCP/.test(b.getAttribute('aria-label') || ''))
      const cr = chip && chip.getBoundingClientRect()
      return {
        panelW: Math.round(pr.width), headW: Math.round(hr.width), headScrollW: h.scrollWidth,
        overflow: h.scrollWidth > h.clientWidth + 1,
        title: pick('.ma-p-title'), folder: pick('.ma-p-folder-name'), status: pick('.ma-status'),
        chip: chip ? { x: Math.round(cr.x), w: Math.round(cr.width), text: chip.innerText.replace(/\\s+/g, ' ').trim(),
                       clipped: chip.scrollWidth > chip.clientWidth + 1,
                       outside: cr.right > hr.right + 1 || cr.left < hr.left - 1 } : null
      }
    })()`
    // 팝아웃(A6)이 슬롯 0을 창으로 보냈으면 그 자리는 껍데기다 — 칩이 있는 슬롯을 고른다
    const S = (await chipOf(app, 0)) ? 0 : 1
    rep.steps.A7_slot = S
    const wide = await app.j(HEAD(S))
    for (const W of [1100, 900, 840]) {
      await app.cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: 780, deviceScaleFactor: 1, mobile: false })
      await sleep(700)
      const h0 = await app.j(HEAD(S))
      const pop = await popOf(app, S)
      rep.steps[`A7_${W}`] = { head: h0, popGeo: pop?.geo }
      note(`A7 viewport ${W}`, { panelW: h0?.panelW, chip: h0?.chip, title: h0?.title, folder: h0?.folder, overflow: h0?.overflow, popW: pop?.geo?.w, popOverflowX: pop?.geo?.overflowX })
      if (h0?.chip?.clipped || h0?.chip?.outside) fail(`A7-chip-${W}`, `패널 ${h0.panelW}px에서 도구 칩이 잘리거나 헤더 밖으로 나간다`, h0.chip)
      if (h0?.overflow) fail(`A7-head-${W}`, `패널 ${h0.panelW}px에서 헤더가 넘친다(scrollW ${h0.headScrollW} > ${h0.headW})`, { title: h0.title, folder: h0.folder })
      if (pop && pop.geo.overflowX > 0) fail(`A7-pop-${W}`, `패널 ${h0?.panelW}px에서 팝오버가 패널 밖으로 ${pop.geo.overflowX}px 나간다`, pop.geo)
    }
    await app.cdp.send('Emulation.clearDeviceMetricsOverride', {})
    rep.steps.A7_wide = wide
    await sleep(500)
  }
} catch (e) {
  fail('run', String(e && e.message ? e.message : e))
  rep.error = String(e.stack || e)
  rep.applog = app?.log?.().slice(-2000)
} finally {
  try { app.cdp.close() } catch { /* closed */ }
  killTree(app.child.pid)
  await sleep(1000)
  if (!KEEP) rmrf(HOME)
  write(OUT, JSON.stringify(rep, null, 1))
  console.log('\n산출:', OUT)
  console.log(rep.findings.length ? `\n지적 ${rep.findings.length}건` : '\n지적 0건')
}
process.exit(0)
