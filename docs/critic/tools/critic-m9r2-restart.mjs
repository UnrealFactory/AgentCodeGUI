#!/usr/bin/env node
/* ============================================================================
 * critic-m9r2-restart — 질의 채널이 **디스크 절임을 만들지 않았는가**.
 *
 * M9의 원칙 하나: "지난주에 붙어 있던 MCP 서버"를 되살리지 않는다 — 스냅샷은 셸
 * **메모리**에만 있다. R2가 조회 창구를 열면서 그 원칙이 깨졌으면(어딘가에 절였으면)
 * 앱을 껐다 켜도 값이 돌아온다. 같은 CCG_HOME으로 두 번 띄워 판정한다.
 *
 *   ① 1회차: 턴 한 번 → 칩이 뜬다 → 조회가 값을 준다
 *   ② 앱 종료(내가 spawn한 PID 트리만) → 같은 홈으로 재기동
 *   ③ 2회차: 턴 0회 → 조회는 null이어야 하고 칩은 없어야 한다
 *
 *   node docs/critic/tools/critic-m9r2-restart.mjs [--exe=…] [--out=…]
 * ========================================================================== */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { connectMainPage, killTree, sleep, REPO, resolveTauriExe } from '../../../bench/lib.mjs'

const args = process.argv.slice(2)
// M12 R2 — mainBinaryName 변경으로 exe 이름이 둘이다(구·신 모두 탐색·최신 mtime 우선)
const EXE = resolveTauriExe((args.find((a) => a.startsWith('--exe=')) ?? '').split('=').slice(1).join('='))
const OUT = (args.find((a) => a.startsWith('--out=')) ?? '').split('=').slice(1).join('=') || path.join(REPO, 'docs', 'critic', 'm9-r2c-restart.json')
const PORT = 9399
const HOME = path.join(REPO, '.critic-home-m9r')
const WORK = path.join(HOME, 'wA')
const SCRIPT = path.join(HOME, 'script.jsonl')
const SID = 'm9r'
const PID0 = `${SID}::0`

const rep = { at: new Date().toISOString(), exe: EXE, steps: {}, findings: [] }
const fail = (id, why, extra) => { rep.findings.push({ id, why, ...(extra ?? {}) }); console.error(`  X ${id} — ${why}`) }
const note = (id, d) => console.log(`  . ${id}${d !== undefined ? ` — ${JSON.stringify(d)}` : ''}`)
const write = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v)) }
const rmrf = (p) => { for (let i = 0; i < 10; i++) { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }); return } catch { spawnSync('cmd', ['/c', 'ping', '127.0.0.1', '-n', '2'], { stdio: 'ignore' }) } } }

const IPC = (channel, payload = []) =>
  `await window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: ${JSON.stringify(channel)}, payload: ${JSON.stringify(payload)} })`
const CHIP = `(() => { const b = [...document.querySelectorAll('.ma-panel[data-slot="0"] .ma-p-head button.ma-p-folder')]
  .find((x) => /MCP/.test(x.getAttribute('aria-label') || '')); return b ? b.innerText.replace(/\\s+/g, ' ').trim() : null })()`

const ENV = { mcp: [{ name: 'srv-restart', status: 'connected' }], skills: ['s-r'], tools: ['mcp__srv-restart__echo'] }
const steps = [
  { afterMs: 60, emit: { type: 'control_response', response: { subtype: 'success', request_id: 'init-1', response: { commands: [{ name: 's-r', description: '재시작 (project)', argumentHint: '' }] } } } },
  { emit: { type: 'system', subtype: 'init', session_id: 'CRIT-R', model: 'claude-haiku-4-5', cwd: WORK, tools: ENV.tools, mcp_servers: ENV.mcp, skills: ENV.skills, plugins: [], slash_commands: [], apiKeySource: 'none' } },
  { afterMs: 80, emit: { type: 'assistant', session_id: 'CRIT-R', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'R-OK' }], usage: { input_tokens: 5 } } } },
  { emit: { type: 'result', subtype: 'success', is_error: false, result: 'R-OK', session_id: 'CRIT-R', total_cost_usd: 0, duration_ms: 1, num_turns: 1 } }
]

function seed() {
  rmrf(HOME)
  fs.mkdirSync(WORK, { recursive: true })
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
  fs.writeFileSync(SCRIPT, steps.map((s) => JSON.stringify(s)).join('\n') + '\n')
}
async function boot() {
  const child = spawn(EXE, [], {
    cwd: REPO,
    env: { ...process.env, CCG_HOME: HOME, CCG_CDP_PORT: String(PORT), CCG_FAKECLI_SCRIPT: SCRIPT },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const cdp = await connectMainPage(PORT, { timeoutMs: 60_000 })
  const j = async (e) => JSON.parse(await cdp.eval(`(async () => JSON.stringify((${e}) ?? null))()`, { awaitPromise: true }))
  return { child, cdp, j }
}
async function until(app, expr, ms = 30_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await app.j(`await (async () => !!(${expr}))()`).catch(() => false)) return true
    await sleep(120)
  }
  return false
}

seed()
let app = await boot()
try {
  if (!(await until(app, 'typeof window.api === "object" && !!(await window.api.app.getVersion())', 60_000))) throw new Error('IPC 없음')
  const board = { version: 2, activeSessionId: SID, sessions: [{ id: SID, title: '재시작', custom: true, count: 1,
    panels: [{ title: 'A', custom: true, cwd: WORK, picker: { model: 'haiku', effort: 'minimal', mode: 'normal' } }], updatedAt: Date.now() }] }
  await app.j(`(await window.api.multi.saveState(${JSON.stringify(board)}), 'saved')`)
  await app.cdp.send('Page.reload', {})
  await sleep(1500)
  if (!(await until(app, 'document.querySelectorAll(".ma-panel").length >= 1', 30_000))) throw new Error('패널이 안 떴다')
  await app.j(`(() => {
    const ta = document.querySelector('.ma-panel[data-slot="0"] textarea')
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    set.call(ta, 'R'); ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus()
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return 'sent'
  })()`)
  await until(app, `document.querySelector('.ma-panel[data-slot="0"]').innerText.includes('R-OK')`, 60_000)
  await sleep(1200)
  rep.steps.run1 = { chip: await app.j(CHIP), tl: await app.j(IPC('chat:tooling-get', [{ panelId: PID0 }])) }
  note('1회차 칩', rep.steps.run1.chip)
  note('1회차 조회', rep.steps.run1.tl?.tooling?.mcp?.[0]?.name ?? null)
  // ── 재기동(내가 spawn한 트리만 죽인다) ──
  try { app.cdp.close() } catch { /* closed */ }
  killTree(app.child.pid)
  await sleep(2500)
  app = await boot()
  if (!(await until(app, 'typeof window.api === "object" && !!(await window.api.app.getVersion())', 60_000))) throw new Error('재기동 IPC 없음')
  if (!(await until(app, 'document.querySelectorAll(".ma-panel").length >= 1', 30_000))) throw new Error('재기동 패널 없음')
  await sleep(2500) // 마운트 조회 왕복이 끝날 시간
  rep.steps.run2 = { chip: await app.j(CHIP), tl: await app.j(IPC('chat:tooling-get', [{ panelId: PID0 }])),
                     dbg: await app.j(IPC('engine:debug')) }
  note('2회차 칩(턴 0회)', rep.steps.run2.chip)
  note('2회차 조회', rep.steps.run2.tl)
  note('2회차 슬롯', (rep.steps.run2.dbg?.chats ?? []).length)
  if (!rep.steps.run1.chip) fail('R-run1', '1회차에 칩이 없다(이 판정 무효)')
  if (rep.steps.run2.tl !== null) fail('R-persist', `재시작 뒤에도 조회가 값을 준다(디스크 절임) — ${JSON.stringify(rep.steps.run2.tl)}`)
  if (rep.steps.run2.chip !== null) fail('R-chip', `재시작 뒤 칩이 되살아난다 — ${JSON.stringify(rep.steps.run2.chip)}`)
} catch (e) {
  fail('run', String(e?.message ?? e))
  rep.error = String(e.stack || e)
} finally {
  try { app.cdp.close() } catch { /* closed */ }
  killTree(app.child.pid)
  await sleep(1000)
  rmrf(HOME)
  write(OUT, JSON.stringify(rep, null, 1))
  console.log('\n산출:', OUT)
  console.log(rep.findings.length ? `\n지적 ${rep.findings.length}건` : '\n지적 0건')
}
process.exit(0)
