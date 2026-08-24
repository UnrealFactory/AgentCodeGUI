#!/usr/bin/env node
/* ============================================================================
 * critic-m9r2-query — M9 **R2의 새 창구**(`chat:tooling-get`)를 공격한다.
 *
 * R2가 낸 주장 넷을 각각 다른 계기로 민다. 전부 가짜 CLI(ccg-fakecli)라 토큰 0.
 *
 *   Q1 nospawn   "조회는 `ensure` 앞에서 끝내 런타임을 만들지 않는다"
 *                → 프로세스 계수(app 트리의 claude.exe) + `engine:debug`의 슬롯 수·spawns
 *                  · 한 번도 안 돈 패널 · 없는 chatId · 없는 보드 · 턴이 끝나 CLI가 죽은 뒤
 *   Q2 addr      "멀티 칩은 자기 chatId를 모르므로 디스패처가 보드 자리 키를 번역한다"
 *                → 폴더가 다른 3패널에 서로 다른 목록을 물려 두고
 *                  크게 보기 · 팝아웃 · 다이얼 축소(3→1→3)에서 **자리마다 제 값**인가
 *   Q3 flood     "렌더러는 마운트마다 한 번 묻는다"
 *                → 마운트 100회 상당(직렬 100 · 병렬 100 · 실제 재마운트 40) ·
 *                  턴이 도는 중(허브가 바쁠 때)의 100발 · 그동안 UI 스레드가 사나
 *   Q4 race      "왕복 중에 푸시가 먼저 닿으면 그쪽을 남긴다"
 *                → 턴 한복판에 목록이 바뀌는 순간 재마운트를 난사한다.
 *                  낡은 조회 답이 새 푸시를 이기면 칩이 옛 값에 얼어붙는다.
 *
 * 안전: 이름 기반 kill 금지(내가 spawn한 PID 트리만) · CCG_HOME 격리 · 실홈 무접촉.
 *
 *   node docs/critic/tools/critic-m9r2-query.mjs [--only=Q1,Q3] [--exe=…] [--out=…]
 * ========================================================================== */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { cdpTargets, connectMainPage, killTree, sleep, Cdp, REPO, resolveTauriExe } from '../../../bench/lib.mjs'

const args = process.argv.slice(2)
const only = ((args.find((a) => a.startsWith('--only=')) ?? '').split('=')[1] || 'all').split(',')
const KEEP = args.includes('--keep')
// M12 R2 — mainBinaryName 변경으로 exe 이름이 둘이다(AgentCodeGUI3/agentcodegui — 둘 다 탐색, 최신 mtime 채택)
const EXE = (args.find((a) => a.startsWith('--exe=')) ?? '').split('=').slice(1).join('=') || resolveTauriExe('')
const OUT = (args.find((a) => a.startsWith('--out=')) ?? '').split('=').slice(1).join('=') || path.join(REPO, 'docs', 'critic', 'm9-r2c-query.json')
const PORT = 9398
const want = (id) => only[0] === 'all' || only.includes(id)

const rep = { at: new Date().toISOString(), exe: EXE, steps: {}, findings: [] }
const fail = (id, why, extra) => { rep.findings.push({ id, why, ...(extra ?? {}) }); console.error(`  X ${id} — ${why}`) }
const ok = (id, d) => console.log(`  o ${id}${d !== undefined ? ` — ${JSON.stringify(d)}` : ''}`)
const note = (id, d) => console.log(`  . ${id}${d !== undefined ? ` — ${JSON.stringify(d)}` : ''}`)
const write = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v)) }
const rmrf = (p) => { for (let i = 0; i < 10; i++) { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }); return } catch { spawnSync('cmd', ['/c', 'ping', '127.0.0.1', '-n', '2'], { stdio: 'ignore' }) } } }

const HOME = path.join(REPO, '.critic-home-m9q')
const W = [path.join(HOME, 'wA'), path.join(HOME, 'wB'), path.join(HOME, 'wC')]
const SCRIPT = path.join(HOME, 'script.jsonl')
const FRAMES = path.join(HOME, 'frames.jsonl')
const SID = 'm9q'
const PIDS = [0, 1, 2].map((i) => `${SID}::${i}`)

// ── 가짜 CLI 대본(공격 하네스와 같은 문법) ───────────────────────────────────
const ack = (commands) => ({ type: 'control_response', response: { subtype: 'success', request_id: 'init-1', response: commands ? { commands } : {} } })
const init = (cwd, { mcp = [], skills = [], tools = [], plugins = [] } = {}) => ({
  type: 'system', subtype: 'init', session_id: 'CRIT-Q', model: 'claude-haiku-4-5', cwd,
  tools, mcp_servers: mcp, skills, plugins, slash_commands: [], apiKeySource: 'none'
})
const say = (text) => ({ type: 'assistant', session_id: 'CRIT-Q', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text }], usage: { input_tokens: 5 } } })
const done = (text) => ({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: 'CRIT-Q', total_cost_usd: 0, duration_ms: 1, num_turns: 1 })
const putScript = (steps) => fs.writeFileSync(SCRIPT, steps.map((s) => JSON.stringify(s)).join('\n') + '\n')
const turn = (cwd, env, mark, { commands = null, pre = [], post = [] } = {}) => [
  { afterMs: 60, emit: ack(commands) }, { emit: init(cwd, env) }, ...pre,
  { afterMs: 80, emit: say(mark) }, { emit: done(mark) }, ...post
]

/** 자리마다 다른 목록 — 칩 본문이 "1 · N"으로 갈려서 눈으로도 자리 오배정이 보인다. */
const ENVS = [0, 1, 2].map((i) => {
  const tag = 'abc'[i]
  const skills = Array.from({ length: i + 1 }, (_, k) => `s-${tag}${k + 1}`)
  return {
    env: { mcp: [{ name: `srv-${tag}`, status: 'connected' }], skills, tools: [`mcp__srv-${tag}__echo`] },
    commands: skills.map((n) => ({ name: n, description: `${tag} 스킬 (project)`, argumentHint: '' })),
    chip: `1 · ${i + 1}`,
    srv: `srv-${tag}`
  }
})

// ── 앱 ───────────────────────────────────────────────────────────────────────
function seed() {
  rmrf(HOME)
  for (const w of W) fs.mkdirSync(w, { recursive: true })
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
  putScript(turn(W[0], {}, 'SEED'))
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

/** 앱 프로세스 트리에서 CLI(claude.exe)를 센다 — "조회가 런타임을 만드나"의 물증. */
function cliProcs(rootPid) {
  const ps = String.raw`
$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name
$kids = @{}
foreach ($p in $all) { if (-not $kids.ContainsKey([uint32]$p.ParentProcessId)) { $kids[[uint32]$p.ParentProcessId] = @() }; $kids[[uint32]$p.ParentProcessId] += $p }
$q = New-Object System.Collections.Queue; $q.Enqueue([uint32]${rootPid}); $seen = @{}; $out = @()
while ($q.Count -gt 0) {
  $cur = $q.Dequeue(); if ($seen.ContainsKey($cur)) { continue }; $seen[$cur] = $true
  if ($kids.ContainsKey($cur)) { foreach ($c in $kids[$cur]) { $out += $c.Name; $q.Enqueue([uint32]$c.ProcessId) } }
}
ConvertTo-Json @{ total = $out.Count; cli = @($out | Where-Object { $_ -eq 'claude.exe' }).Count } -Compress`
  try {
    return JSON.parse(execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 30000 }).trim())
  } catch (e) {
    return { error: String(e.message ?? e) }
  }
}
/** 허브가 든 슬롯 수와 스폰 누계 — 프로세스 계수와 독립인 두 번째 증거. */
const hubShape = async (app) => {
  const d = await app.j(IPC('engine:debug'))
  return { slots: (d?.chats ?? []).length, spawns: (d?.chats ?? []).reduce((a, c) => a + (c.spawns ?? 0), 0),
           ids: (d?.chats ?? []).map((c) => c.chatId), pids: (d?.chats ?? []).map((c) => c.pid ?? null) }
}
const getTL = (app, arg) => app.j(IPC('chat:tooling-get', [arg]))
const chipIn = (scope) => `(() => { const b = [...document.querySelectorAll(${JSON.stringify(scope)} + ' button.ma-p-folder')]
  .find((x) => /MCP/.test(x.getAttribute('aria-label') || '')); return b ? b.innerText.replace(/\\s+/g, ' ').trim() : null })()`
const chipOfSlot = (app, slot) => app.j(chipIn(`.ma-panel[data-slot="${slot}"] .ma-p-head`))
async function send(app, slot, text) {
  const r = await app.j(`(() => {
    const p = document.querySelector('.ma-panel[data-slot="${slot}"]')
    const ta = p && p.querySelector('textarea')
    if (!ta) return 'no-textarea'
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    set.call(ta, ${JSON.stringify(text)})
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    ta.focus(); ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    return 'sent'
  })()`)
  if (r !== 'sent') throw new Error(`슬롯 ${slot} 컴포저 없음: ${r}`)
}
const clickAria = (re, scope = '') => `(() => { const b = [...document.querySelectorAll('${scope} button'.trim())]
  .find((x) => ${re}.test(x.getAttribute('aria-label') || '')); if (!b) return 'no-btn'; b.click(); return 'clicked' })()`

// ── 본체 ─────────────────────────────────────────────────────────────────────
seed()
const app = await boot()
try {
  if (!(await until(app, 'typeof window.api === "object" && !!(await window.api.app.getVersion())', 60_000)))
    throw new Error('앱 IPC가 안 올라옴')
  const board = {
    version: 2, activeSessionId: SID,
    sessions: [{
      id: SID, title: 'M9 R2 질의', custom: true, count: 3,
      panels: [0, 1, 2].map((i) => ({ title: 'ABC'[i], custom: true, cwd: W[i], picker: { model: 'haiku', effort: 'minimal', mode: 'normal' } })),
      updatedAt: Date.now()
    }]
  }
  await app.j(`(await window.api.multi.saveState(${JSON.stringify(board)}), 'saved')`)
  await app.cdp.send('Page.reload', {})
  await sleep(1500)
  if (!(await until(app, 'typeof window.api === "object" && !!(await window.api.app.getVersion())', 40_000))) throw new Error('reload 뒤 IPC 없음')
  if (!(await until(app, 'document.querySelectorAll(".ma-panel").length >= 3', 30_000))) throw new Error('3패널이 안 떴다')
  rep.steps.boot = { panels: await app.j('document.querySelectorAll(".ma-panel").length'), pid: app.child.pid }

  // ══ Q1 · 조회가 런타임을 만드는가 ═══════════════════════════════════════════
  if (want('Q1')) {
    const base = { proc: cliProcs(app.child.pid), hub: await hubShape(app) }
    // ① 한 번도 안 돈 패널 3개에 각각 5번 + 없는 chatId + 없는 보드
    const cold = []
    for (let r = 0; r < 5; r++) for (const p of PIDS) cold.push(await getTL(app, { panelId: p }))
    const ghostChat = []
    for (let r = 0; r < 5; r++) ghostChat.push(await getTL(app, { chatId: 'chat-does-not-exist-999' }))
    const ghostBoard = []
    for (let r = 0; r < 5; r++) ghostBoard.push(await getTL(app, { panelId: 'no-such-board::4' }))
    const weird = {
      empty: await getTL(app, {}),
      emptyPanel: await getTL(app, { panelId: '' }),
      noSep: await getTL(app, { panelId: 'nosep' }),
      hugeSlot: await getTL(app, { panelId: `${SID}::99999999999999999999` }),
      negSlot: await getTL(app, { panelId: `${SID}::-1` }),
      slotOutOfRange: await getTL(app, { panelId: `${SID}::5` })
    }
    const afterCold = { proc: cliProcs(app.child.pid), hub: await hubShape(app) }
    rep.steps.Q1 = { base, coldNulls: cold.filter((x) => x === null).length, coldTotal: cold.length,
                     ghostChatNulls: ghostChat.filter((x) => x === null).length,
                     ghostBoardNulls: ghostBoard.filter((x) => x === null).length, weird, afterCold }
    note('Q1 기준', base)
    note('Q1 냉조회 뒤', afterCold)
    if (afterCold.proc.cli !== base.proc.cli) fail('Q1-spawn-cold', `한 번도 안 돈 패널에 조회했더니 CLI 프로세스가 ${base.proc.cli} → ${afterCold.proc.cli}`)
    if (afterCold.hub.slots !== base.hub.slots) fail('Q1-slot-cold', `조회가 허브 슬롯을 만들었다 ${base.hub.slots} → ${afterCold.hub.slots}`, afterCold.hub)
    if (cold.some((x) => x !== null)) fail('Q1-cold-value', '안 돈 패널이 값을 돌려준다(있을 수 없는 스냅샷)')
    if (Object.values(weird).some((x) => x !== null)) fail('Q1-weird', '이상한 주소가 값을 돌려준다', weird)

    // ② 한 턴 돌린 뒤 — CLI는 턴 끝에 죽는다. 조회가 그것을 되살리면 안 된다.
    putScript(turn(W[0], ENVS[0].env, 'Q1-OK', { commands: ENVS[0].commands }))
    await send(app, 0, 'Q1')
    await until(app, `document.querySelector('.ma-panel[data-slot="0"]').innerText.includes('Q1-OK')`, 60_000)
    await sleep(2500) // 턴 끝 → driver.kill()이 정착할 시간
    const afterTurn = { proc: cliProcs(app.child.pid), hub: await hubShape(app) }
    const warm = []
    for (let r = 0; r < 20; r++) warm.push(await getTL(app, { panelId: PIDS[0] }))
    const afterWarm = { proc: cliProcs(app.child.pid), hub: await hubShape(app) }
    rep.steps.Q1.turn = { afterTurn, afterWarm, warmNonNull: warm.filter(Boolean).length,
                          sample: warm[0], srv: warm[0]?.tooling?.mcp?.[0]?.name ?? null }
    note('Q1 턴 뒤', afterTurn)
    note('Q1 20발 조회 뒤', afterWarm)
    if (warm.filter(Boolean).length !== warm.length) fail('Q1-warm-null', `턴을 돈 패널인데 조회가 null을 준다(${warm.filter(Boolean).length}/${warm.length})`)
    if (afterWarm.proc.cli > afterTurn.proc.cli) fail('Q1-spawn-warm', `조회가 죽은 CLI를 되살렸다 ${afterTurn.proc.cli} → ${afterWarm.proc.cli}`)
    if (afterWarm.hub.spawns !== afterTurn.hub.spawns) fail('Q1-respawn', `조회가 spawns를 올렸다 ${afterTurn.hub.spawns} → ${afterWarm.hub.spawns}`)
    if (afterWarm.hub.slots !== afterTurn.hub.slots) fail('Q1-slot-warm', `조회가 슬롯을 늘렸다 ${afterTurn.hub.slots} → ${afterWarm.hub.slots}`)
  }

  // ══ Q2 · 보드 자리 번역이 껍데기마다 정확한가 ══════════════════════════════
  if (want('Q2')) {
    for (const i of [0, 1, 2]) {
      putScript(turn(W[i], ENVS[i].env, `Q2-${i}-OK`, { commands: ENVS[i].commands }))
      await send(app, i, `Q2-${i}`)
      await until(app, `document.querySelector('.ma-panel[data-slot="${i}"]').innerText.includes('Q2-${i}-OK')`, 60_000)
      await sleep(500)
    }
    await sleep(800)
    const gridChips = await Promise.all([0, 1, 2].map((i) => chipOfSlot(app, i)))
    const direct = []
    for (const i of [0, 1, 2]) {
      const v = await getTL(app, { panelId: PIDS[i] })
      direct.push({ panelId: PIDS[i], srv: v?.tooling?.mcp?.map((m) => m.name) ?? null, cwd: v?.tooling?.cwd ?? null, skills: v?.tooling?.skills?.length ?? null })
    }
    // 같은 값을 **chatId 주소**로도 물어본다 — 채널의 두 주소가 같은 함수에 닿는가
    // (본채팅·추가 채팅이 붙을 때 쓸 길. 멀티 칩은 panelId만 안다).
    const dbg = await app.j(IPC('engine:debug'))
    const byChat = []
    for (const c of dbg?.chats ?? []) {
      const v = await getTL(app, { chatId: c.chatId })
      byChat.push({ chatId: c.chatId, srv: v?.tooling?.mcp?.[0]?.name ?? null, cwd: (v?.tooling?.cwd ?? '').toLowerCase() })
    }
    rep.steps.Q2 = { gridChips, direct, byChat }
    note('Q2 그리드 칩', gridChips)
    note('Q2 직접 조회', direct)
    note('Q2 chatId 주소', byChat)
    const srvSet = new Set(byChat.map((b) => b.srv))
    if (byChat.length !== 3 || srvSet.size !== 3) fail('Q2-chatid', `chatId 주소가 세 채팅을 서로 다르게 못 짚는다 — ${JSON.stringify(byChat)}`)
    for (const i of [0, 1, 2]) {
      if (gridChips[i] !== ENVS[i].chip) fail(`Q2-grid-${i}`, `자리 ${i} 칩이 어긋난다 — 기대 ${ENVS[i].chip} · 실제 ${gridChips[i]}`)
      if (direct[i].srv?.[0] !== ENVS[i].srv) fail(`Q2-addr-${i}`, `panelId ${PIDS[i]} 조회가 남의 목록을 준다 — 기대 ${ENVS[i].srv} · 실제 ${JSON.stringify(direct[i])}`)
      if (String(direct[i].cwd ?? '').toLowerCase() !== W[i].toLowerCase()) fail(`Q2-cwd-${i}`, `자리 ${i}의 cwd가 어긋난다 — 기대 ${W[i]} · 실제 ${direct[i].cwd}`)
    }

    // ① 크게 보기(오버레이 카드 재마운트) — 가운데 자리로 연다
    await app.j(clickAria('/크게 보기|Expand/', '.ma-panel[data-slot="1"]'))
    await until(app, `!!document.querySelector('.ma-expand-card')`, 10_000)
    await sleep(1400)
    const expandedChip = await app.j(chipIn('.ma-expand-card'))
    await app.j(clickAria('/원래 크기로|Restore size/'))
    await sleep(1400)
    const afterRestore = await Promise.all([0, 1, 2].map((i) => chipOfSlot(app, i)))
    rep.steps.Q2.expand = { expandedChip, afterRestore }
    note('Q2 크게 보기(자리1)', expandedChip)
    note('Q2 복귀 뒤 칩', afterRestore)
    if (expandedChip !== ENVS[1].chip) fail('Q2-expand', `크게 보기 카드의 칩이 자리1이 아니다 — 기대 ${ENVS[1].chip} · 실제 ${expandedChip}`)
    for (const i of [0, 1, 2]) if (afterRestore[i] !== ENVS[i].chip) fail(`Q2-restore-${i}`, `복귀 뒤 자리 ${i} 칩 — 기대 ${ENVS[i].chip} · 실제 ${afterRestore[i]}`)

    // ② 팝아웃 — 셋째 자리를 별도 창으로(턴 0회). 그 창의 칩이 자리2의 값이어야 한다.
    await app.j(clickAria('/별도 창으로|own window/', '.ma-panel[data-slot="2"]'))
    await sleep(2800)
    const tgt = (await cdpTargets(PORT).catch(() => [])).filter((t) => t.type === 'page').find((t) => /mapanel/.test(t.url))
    if (!tgt) fail('Q2-popout-window', '팝아웃 창 타깃을 못 찾음')
    else {
      const c = await Cdp.connect(tgt.webSocketDebuggerUrl, { timeoutMs: 8000 })
      const wj = async (e) => JSON.parse(await c.eval(`(async () => JSON.stringify((${e}) ?? null))()`, { awaitPromise: true }))
      for (let i = 0; i < 40; i++) { if (await wj(chipIn('.ma-p-head')).catch(() => null)) break; await sleep(150) }
      const popChip = await wj(chipIn('.ma-p-head'))
      const popPanelId = await wj(`(() => { const el = document.querySelector('[data-panel-id]'); return el ? el.getAttribute('data-panel-id') : null })()`).catch(() => null)
      rep.steps.Q2.popout = { popChip, popPanelId, url: tgt.url }
      note('Q2 팝아웃 칩(자리2 · 턴 0회)', popChip)
      if (popChip !== ENVS[2].chip) fail('Q2-popout', `팝아웃 첫 진입 칩이 자리2가 아니다 — 기대 ${ENVS[2].chip} · 실제 ${popChip}`)
      try { c.close() } catch { /* closed */ }
      await app.j(`(await window.api.multi.panelClose('${PIDS[2]}'), 'closed')`).catch(() => null)
      await sleep(2400)
    }

    // ③ 다이얼 축소 3 → 1 → 3 (자리가 접히고 펴진다 = 재마운트 · order 순열까지 바뀐다)
    const dialTo = (n) => `(() => { const b = [...document.querySelectorAll('.ma-count .ma-count-btn')].find((x) => x.dataset.count === '${n}'); if (!b) return 'no-dial'; b.click(); return 'clicked' })()`
    const d1 = await app.j(dialTo(1))
    await sleep(1400)
    const oneChip = await app.j(chipIn('.ma-panel .ma-p-head'))
    const visibleAfter1 = await app.j(`[...document.querySelectorAll('.ma-panel')].map((p) => p.dataset.slot)`)
    const d3 = await app.j(dialTo(3))
    await sleep(1800)
    const backChips = await Promise.all([0, 1, 2].map((i) => chipOfSlot(app, i)))
    const visibleAfter3 = await app.j(`[...document.querySelectorAll('.ma-panel')].map((p) => p.dataset.slot)`)
    rep.steps.Q2.dial = { d1, oneChip, visibleAfter1, d3, backChips, visibleAfter3 }
    note('Q2 다이얼 1칸', { oneChip, visibleAfter1 })
    note('Q2 다이얼 3칸 복귀', { backChips, visibleAfter3 })
    if (d1 === 'no-dial' || d3 === 'no-dial') fail('Q2-dial-missing', '다이얼 버튼을 못 찾음(이 판정은 무효)')
    else {
      const soloSlot = Number(visibleAfter1?.[0] ?? -1)
      if (soloSlot >= 0 && oneChip !== ENVS[soloSlot].chip)
        fail('Q2-dial-solo', `1칸으로 접으니 남은 자리(${soloSlot})의 칩이 어긋난다 — 기대 ${ENVS[soloSlot].chip} · 실제 ${oneChip}`)
      for (const i of [0, 1, 2]) if (backChips[i] !== ENVS[i].chip) fail(`Q2-dial-back-${i}`, `다이얼 복귀 뒤 자리 ${i} 칩 — 기대 ${ENVS[i].chip} · 실제 ${backChips[i]}`)
    }
  }

  // ══ Q3 · 조회 폭주 ══════════════════════════════════════════════════════════
  if (want('Q3')) {
    // 자립 준비 — 자리0에 한 턴(--only=Q3로 단독 실행해도 조회가 값이 있어야 한다)
    putScript(turn(W[0], ENVS[0].env, 'Q3-WARM', { commands: ENVS[0].commands }))
    await send(app, 0, 'Q3warm')
    await until(app, `document.querySelector('.ma-panel[data-slot="0"]').innerText.includes('Q3-WARM')`, 60_000)
    await sleep(1200)
    const before = { proc: cliProcs(app.child.pid), hub: await hubShape(app) }
    // ① 직렬 100발
    const seq = await app.j(`await (async () => {
      const t0 = performance.now(); let nulls = 0
      for (let i = 0; i < 100; i++) { const v = await window.api.multi.toolingGet('${PIDS[0]}'); if (!v) nulls++ }
      return { ms: Math.round(performance.now() - t0), nulls }
    })()`)
    // ② 병렬 100발 + 그동안 UI 스레드 지연 측정(16ms 타이머의 최대 공백)
    const par = await app.j(`await (async () => {
      const gaps = []; let last = performance.now()
      const h = setInterval(() => { const n = performance.now(); gaps.push(n - last); last = n }, 16)
      const t0 = performance.now()
      const rs = await Promise.all(Array.from({ length: 100 }, () => window.api.multi.toolingGet('${PIDS[0]}')))
      const ms = Math.round(performance.now() - t0)
      clearInterval(h)
      return { ms, nulls: rs.filter((x) => !x).length, maxGapMs: Math.round(Math.max(0, ...gaps)), ticks: gaps.length }
    })()`)
    // ③ 턴이 도는 중(허브가 바쁠 때)의 100발 — 스폰이 큐 앞에 있으면 조회가 밀린다
    putScript([
      { afterMs: 60, emit: ack(ENVS[0].commands) }, { emit: init(W[0], ENVS[0].env) },
      { afterMs: 4000, emit: say('Q3-BUSY') }, { emit: done('Q3-BUSY') }
    ])
    await send(app, 0, 'Q3busy')
    await sleep(120) // 스폰 한복판
    const busy = await app.j(`await (async () => {
      const t0 = performance.now(); const each = []
      const rs = await Promise.all(Array.from({ length: 100 }, async () => { const a = performance.now(); const v = await window.api.multi.toolingGet('${PIDS[0]}'); each.push(performance.now() - a); return v }))
      return { ms: Math.round(performance.now() - t0), nulls: rs.filter((x) => !x).length, maxOneMs: Math.round(Math.max(...each)) }
    })()`)
    await until(app, `document.querySelector('.ma-panel[data-slot="0"]').innerText.includes('Q3-BUSY')`, 60_000)
    await sleep(1500)
    // ④ 실제 재마운트 40회(크게 보기 ⟷ 원래 크기로 20왕복) — 칩이 매번 살아나야 한다
    let missing = 0
    const seen = []
    for (let i = 0; i < 20; i++) {
      await app.j(clickAria('/크게 보기|Expand/', '.ma-panel[data-slot="0"]'))
      await sleep(260)
      const c1 = await app.j(chipIn('.ma-expand-card'))
      await app.j(clickAria('/원래 크기로|Restore size/'))
      await sleep(260)
      const c2 = await chipOfSlot(app, 0)
      seen.push([c1, c2])
      if (!c1 || !c2) missing++
    }
    const after = { proc: cliProcs(app.child.pid), hub: await hubShape(app) }
    const alive = await app.j(`({ panels: document.querySelectorAll('.ma-panel').length, api: typeof window.api })`)
    rep.steps.Q3 = { before, seq, par, busy, remount: { missing, first: seen[0], last: seen.at(-1) }, after, alive }
    note('Q3 직렬 100', seq)
    note('Q3 병렬 100', par)
    note('Q3 턴 중 100', busy)
    note('Q3 재마운트 20왕복', { missing, last: seen.at(-1) })
    note('Q3 뒤 상태', { after, alive })
    if (seq.nulls || par.nulls) fail('Q3-null', `폭주 중 조회가 null을 준다 — 직렬 ${seq.nulls} · 병렬 ${par.nulls}`)
    if (missing) fail('Q3-remount', `20왕복 재마운트 중 ${missing}회 칩이 없다`)
    if (after.proc.cli > before.proc.cli + 1) fail('Q3-procs', `폭주 뒤 CLI 프로세스가 늘었다 ${before.proc.cli} → ${after.proc.cli}`)
    if (alive.panels < 3) fail('Q3-dead', `폭주 뒤 화면이 무너졌다 — 패널 ${alive.panels}`)
    if (par.maxGapMs > 1000) fail('Q3-uithread', `병렬 100발 동안 UI 타이머가 ${par.maxGapMs}ms 멎었다`)
    if (busy.maxOneMs > 8000) fail('Q3-busy-latency', `턴 중 조회 한 발이 ${busy.maxOneMs}ms 걸렸다(허브 큐 뒤에 섰다)`)
  }

  // ══ Q4 · 푸시와 조회의 경합 — 낡은 값이 이기나 ═════════════════════════════
  if (want('Q4')) {
    const rounds = []
    for (let r = 0; r < 3; r++) {
      const oldEnv = { mcp: [{ name: 'srv-old', status: 'connected' }], skills: ['o1'], tools: ['mcp__srv-old__echo'] }
      const newEnv = { mcp: [{ name: 'srv-new', status: 'connected' }], skills: ['n1', 'n2', 'n3', 'n4'], tools: ['mcp__srv-new__echo'] }
      putScript([
        { afterMs: 60, emit: ack([{ name: 'o1', description: '옛 (project)', argumentHint: '' }, { name: 'n1', description: '새 (project)', argumentHint: '' },
                                  { name: 'n2', description: '새 (project)', argumentHint: '' }, { name: 'n3', description: '새 (project)', argumentHint: '' },
                                  { name: 'n4', description: '새 (project)', argumentHint: '' }]) },
        { emit: init(W[0], oldEnv) },
        { afterMs: 1600, emit: init(W[0], newEnv) }, // ★턴 한복판에 목록이 갈린다
        { afterMs: 1400, emit: say(`Q4-${r}-OK`) },
        { emit: done(`Q4-${r}-OK`) }
      ])
      await send(app, 0, `Q4-${r}`)
      // 전이 구간(0~3000ms)에 재마운트를 난사한다 — 조회 왕복이 푸시와 겹치게
      const t0 = Date.now()
      const marks = []
      while (Date.now() - t0 < 3000) {
        await app.j(clickAria('/크게 보기|Expand/', '.ma-panel[data-slot="0"]'))
        await sleep(90)
        marks.push(await app.j(chipIn('.ma-expand-card')))
        await app.j(clickAria('/원래 크기로|Restore size/'))
        await sleep(90)
        marks.push(await chipOfSlot(app, 0))
      }
      await until(app, `document.querySelector('.ma-panel[data-slot="0"]').innerText.includes('Q4-${r}-OK')`, 60_000)
      await sleep(1600)
      const settled = await chipOfSlot(app, 0)
      const shell = await getTL(app, { panelId: PIDS[0] })
      rep.steps[`Q4_${r}`] = { marks, settled, shellSrv: shell?.tooling?.mcp?.[0]?.name ?? null, shellSkills: shell?.tooling?.skills?.length ?? null }
      rounds.push({ settled, shell: shell?.tooling?.mcp?.[0]?.name ?? null })
      note(`Q4 라운드 ${r}`, { marksTail: marks.slice(-4), settled, shell: shell?.tooling?.mcp?.[0]?.name })
      if (settled !== '1 · 4') fail(`Q4-stale-${r}`, `전이 뒤 칩이 새 값이 아니다 — 기대 "1 · 4" · 실제 ${JSON.stringify(settled)} (셸은 ${shell?.tooling?.mcp?.[0]?.name})`)
      if ((shell?.tooling?.mcp?.[0]?.name ?? null) !== 'srv-new') fail(`Q4-shell-${r}`, `셸 스냅샷이 새 값이 아니다 — ${shell?.tooling?.mcp?.[0]?.name}`)
    }
    rep.steps.Q4 = { rounds }
  }

  // ══ Q5 · A4-push 미룸의 값 — 「arm은 이미 배선돼 있다」가 참인가 ════════════
  //
  // R2가 미룬 하나(`result` 뒤의 `commands_changed`)의 근거는 "CLI가 죽어 프레임이
  // 안 온다 · 레버는 Linger 한 줄 · 그때 arm은 **코드 변경 0으로** 초록이 된다"이다.
  // 앞 둘은 크리틱이 확인했지만 셋째는 **예측**이라 아무도 안 재봤다. Linger를 켤 수는
  // 없지만(제품 수정 0), 같은 상태를 사용자 경로로 만들 수 있다: `land_turn`의
  // `(empty, drainable)`가 `(true,true)`면 — 즉 **result 순간 큐에 다음 발화가 있으면**
  // — 닫지 않고 `Resident{Linger(0)}`로 드레인한다. CLI가 살아 있으니 result **뒤**의
  // 프레임이 실제로 셸에 온다. 여기서 화면까지 닿으면 미룸은 값이 맞고, 안 닿으면
  // 미룬 항목이 광고보다 크다.
  if (want('Q5')) {
    putScript([
      { afterMs: 60, emit: ack([{ name: 'p1', description: '', argumentHint: '' }]) },
      { emit: init(W[0], { mcp: [], skills: ['p1'], tools: [] }) },
      { afterMs: 3000, emit: say('Q5-T1') },
      { emit: done('Q5-T1') },
      // ★result **뒤**의 푸시 — 큐 덕분에 CLI가 아직 살아 있다
      { afterMs: 600, emit: { type: 'system', subtype: 'commands_changed', commands: [{ name: 'p1', description: '결과 뒤 푸시 설명 (project)', argumentHint: '' }] } },
      { afterMs: 500, emit: say('Q5-T2') },
      { emit: done('Q5-T2') }
    ])
    await send(app, 0, 'Q5-a')
    await sleep(1000)
    await send(app, 0, 'Q5-b') // 큐에 선다 → result 순간 (empty=true, drainable=true)
    await until(app, `document.querySelector('.ma-panel[data-slot="0"]').innerText.includes('Q5-T2')`, 60_000)
    await sleep(1500)
    const tl = await getTL(app, { panelId: PIDS[0] })
    const dbg = await app.j(IPC('engine:debug'))
    const me = (dbg?.chats ?? []).find((c) => c.chatId === 'ma-m9q-0')
    const frames = fs.existsSync(FRAMES)
      ? fs.readFileSync(FRAMES, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
      : []
    const cc = frames.filter((m) => m?.type === 'system' && m?.subtype === 'commands_changed').length
    const desc = tl?.tooling?.skills?.find((s) => s.name === 'p1')?.description ?? null
    rep.steps.Q5 = { desc, scope: tl?.tooling?.skills?.find((s) => s.name === 'p1')?.scope ?? null,
                     wireCommandsChanged: cc, spawns: me?.spawns ?? null }
    note('Q5 result 뒤 푸시 → 스냅샷의 설명', { desc, cc, spawns: me?.spawns })
    if ((me?.spawns ?? 0) !== 1) note('Q5-precondition', '큐 드레인이 같은 프로세스로 안 이어졌다(spawns ' + me?.spawns + ') — 이 회차는 판정 불가')
    else if (cc === 0) fail('Q5-noframe', 'result 뒤 푸시 프레임이 셸에 아예 안 왔다(큐 드레인으로도 CLI가 안 살아남는다)')
    else if (desc !== '결과 뒤 푸시 설명')
      fail('Q5-arm-dead', `프레임은 셸에 왔는데(${cc}장) 스냅샷에 안 붙는다 — arm이 "코드 변경 0"이 아니다. 실제 ${JSON.stringify(desc)}`)
  }
} catch (e) {
  fail('run', String(e && e.message ? e.message : e))
  rep.error = String(e.stack || e)
  rep.applog = app?.log?.().slice(-2500)
} finally {
  try { app.cdp.close() } catch { /* closed */ }
  killTree(app.child.pid)
  await sleep(1200)
  if (!KEEP) rmrf(HOME)
  write(OUT, JSON.stringify(rep, null, 1))
  console.log('\n산출:', OUT)
  console.log(rep.findings.length ? `\n지적 ${rep.findings.length}건` : '\n지적 0건')
}
process.exit(0)
