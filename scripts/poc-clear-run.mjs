// Native regression: Clear -> send -> delayed blank save -> answer and idle.
// Uses an isolated home and fake CLI; never touches the installed app or accounts.
// Prerequisites: cargo build -p ccg-engine --release --features fakecli --bin ccg-fakecli
//               cargo build -p ccg-auth --features cli --bin ccg-auth-probe
//               cargo build -p agentcodegui --features custom-protocol
// node scripts/poc-clear-run.mjs --exe=target/debug/agentcodegui.exe
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { connectMainPage, killTree, quietHome, REPO, sleep } from '../bench/lib.mjs'

const exe = path.resolve(process.argv.find((a) => a.startsWith('--exe='))?.slice(6) ?? 'target/debug/agentcodegui.exe')
const home = fs.mkdtempSync(path.join(REPO, '.poc-home-clear-run-'))
const work = path.join(home, 'work')
const port = 19383
const write = (name, value) => {
  const file = path.join(home, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
}
quietHome(home)
fs.mkdirSync(work)
const engine = 'engines/fake/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe'
write(engine, '')
fs.copyFileSync(path.join(REPO, 'target/release/ccg-fakecli.exe'), path.join(home, engine))
write('config.json', { activeVersion: 'fake' })
write('engines/fake/node_modules/@anthropic-ai/claude-agent-sdk/package.json', { name: '@anthropic-ai/claude-agent-sdk', version: 'fake' })
execFileSync(path.join(REPO, 'target/debug/ccg-auth-probe.exe'), ['seed', 'fake@example.com'], {
  windowsHide: true, env: { ...process.env, CCG_HOME: home, CCG_NO_NET: '1' }, stdio: 'pipe'
})
write('ui-prefs.json', { 'ui.lang': 'en', 'workspace.mode': 'multi' })
write('profile.json', { nickname: 'clear regression' })
write('multi-agent/index.json', { version: 2, order: ['clear-board'], activeSessionId: 'clear-board' })
write('multi-agent/clear-board.json', {
  id: 'clear-board', title: 'Clear regression', count: 1,
  panels: [{ title: 'Old conversation', cwd: work, refDirs: [], api: false,
    picker: { model: 'haiku', effort: 'minimal', mode: 'normal' },
    snapshot: { messages: [{ kind: 'msg', id: 'old', role: 'user', text: 'Old conversation' }] }
  }]
})
write('script.jsonl', [
  { afterMs: 100, emit: { type: 'control_response', response: { subtype: 'success', request_id: 'init-1', response: {} } } },
  { emit: { type: 'system', subtype: 'init', session_id: 'CLEAR-NEW', model: 'claude-haiku-4', cwd: work, tools: [] } },
  { afterMs: 3000, emit: { type: 'assistant', session_id: 'CLEAR-NEW', parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'text', text: 'CLEAR-FIRST-REPLY' }] } } },
  { emit: { type: 'result', subtype: 'success', is_error: false, session_id: 'CLEAR-NEW', result: 'CLEAR-FIRST-REPLY', duration_ms: 3100, num_turns: 1, total_cost_usd: 0 } }
].map((v) => JSON.stringify(v)).join('\n'))

let cdp
const app = spawn(exe, [], {
  windowsHide: true, stdio: 'ignore',
  env: { ...process.env, CCG_HOME: home, CCG_NO_NET: '1', CCG_FAKECLI_SCRIPT: path.join(home, 'script.jsonl'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }
})
try {
  cdp = await connectMainPage(port)
  const evaluate = (expr) => cdp.eval(`(async () => (${expr}))()`, { awaitPromise: true })
  const until = async (expr, timeout = 15000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      if (await evaluate(expr)) return
      await sleep(100)
    }
    console.log(await evaluate(`JSON.stringify({text: document.body.innerText.slice(-1800), saves: window.__clearSaves, events: window.__clearEvents})`))
    throw new Error(`Timed out: ${expr}`)
  }
  const send = async (text) => {
    await evaluate(`(() => {
      const ta = document.querySelector('.ma-panel .composer textarea')
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, ${JSON.stringify(text)})
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      ta.focus()
    })()`)
    await evaluate(`document.querySelector('.ma-panel .composer button.send').click()`)
  }
  await until(`!!document.querySelector('.ma-panel .composer textarea')`)
  // Hold just the first blank save, like an IPC delayed behind another request.
  await evaluate(`(() => {
    window.__clearEvents = []
    window.__clearSaves = []
    window.api.multi.onEvent('clear-board::0', (e) => window.__clearEvents.push(e))
    window.__saveClear = window.api.multi.saveState
    window.api.multi.saveState = (blob) => {
      const p = blob.sessions.find((s) => s.id === 'clear-board')?.panels?.[0]
      window.__clearSaves.push({title: p?.title, messages: p?.snapshot?.messages?.length})
      if (p && !p.title && !p.snapshot?.messages?.length && !window.__blankClear) {
        window.__blankClear = structuredClone(blob)
        return Promise.resolve()
      }
      return window.__saveClear(blob)
    }
  })()`)
  await send('/clear')
  await until(`!!window.__blankClear`)
  await send('First message after Clear')
  await until(`window.__clearEvents.some((e) => e.type === 'status' && e.status === 'analyzing')`)
  await evaluate(`window.__saveClear(window.__blankClear)`)
  await sleep(4500)
  const result = JSON.parse(await evaluate(`JSON.stringify({
    answer: document.querySelector('.ma-panel')?.innerText.includes('CLEAR-FIRST-REPLY'),
    done: window.__clearEvents.some((e) => e.type === 'result'),
    statuses: window.__clearEvents.filter((e) => e.type === 'status').map((e) => e.status),
    errors: window.__clearEvents.filter((e) => e.type === 'error' || e.type === 'notice'),
    seat: (await window.api.multi.getState()).sessions.find((s) => s.id === 'clear-board')?.panels?.[0]?.title
  })`))
  console.log(JSON.stringify({ exe, home, ...result }, null, 2))
  assert.equal(result.answer, true, 'The first reply must reach the panel without Esc/resend')
  assert.equal(result.done, true, 'The first run must finish after the delayed Clear save')
  assert.equal(result.statuses.at(-1), 'done')
} finally {
  cdp?.ws.close()
  killTree(app.pid)
}
