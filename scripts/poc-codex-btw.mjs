// Native /btw regression. Runs the real GUI with synthetic accounts and a scripted
// Codex transport; never touches the installed app's conversations or credentials.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { REPO, quietHome, connectMainPage, cdpTargets, Cdp, sleep, killTree } from '../bench/lib.mjs'

const home = fs.mkdtempSync(path.join(REPO, '.poc-home-codex-btw-'))
quietHome(home)
const port = 19408
const parent = 'ma-btw-origin-0'
const email = 'btw@openai.test'
const write = (name, value) => {
  const file = path.join(home, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
}
const read = name => JSON.parse(fs.readFileSync(path.join(home, name), 'utf8'))
const script = steps => write('script.jsonl', steps.map(s => JSON.stringify(s)).join('\n'))
const begin = (method, thread) => [
  { await: 'initialize', result: { userAgent: 'fake-codex' } },
  { await: method, result: { thread: { id: thread, sessionId: 'parent-thread' } } },
  ...(method === 'thread/fork' ? [{ await: 'thread/goal/clear', result: { cleared: true } }] : [])
]
const turn = (thread, marker) => [
  { await: 'turn/start', result: { turn: { id: marker } } },
  { emit: { method: 'turn/started', params: { threadId: thread, turn: { id: marker } } } },
  { emit: { method: 'item/completed', params: { threadId: thread, item: { id: marker, type: 'agentMessage', text: marker } } } },
  { emit: { method: 'turn/completed', params: { threadId: thread, turn: { id: marker, status: 'completed', durationMs: 100 } } } }
]
const stub = 'engines/fixture/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe'
write(stub, '')
fs.copyFileSync(path.join(REPO, 'target/debug/ccg-fakecli.exe'), path.join(home, stub))
write('engines/fixture/node_modules/@anthropic-ai/claude-agent-sdk/package.json', { version: 'fixture' })
write('config.json', { activeVersion: 'fixture' })
write('accounts.json', { version: 3, accounts: [{ email: 'fixture@claude.test' }] })
write('codex-accounts.json', { version: 1, defaultEmail: email, accounts: [{ email, plan: 'plus', authEnc: '' }] })
const version = JSON.parse(fs.readFileSync(path.join(REPO, 'src-tauri/tauri.conf.json'), 'utf8')).version
write('ui-prefs.json', { 'ui.lang': 'en', 'workspace.mode': 'multi', 'whatsnew.seenVersion': version, 'limitResume.on': false, 'limitSwitch.on': false })
write('chats-v3/index.json', { version: 1, order: [parent], activeChatId: parent, migratedAt: Date.now(), migrationComplete: true })
write('boards/index.json', { version: 1, order: ['btw'], activeBoardId: 'btw' })
write('boards/btw.json', { id: 'btw', title: 'BTW verification', count: 2, chrome: 'grid', order: [0, 1, 2, 3, 4, 5], slots: [parent, null, null, null, null, null] })
write(`chats-v3/${parent}.json`, {
  id: parent, origin: 'panel', title: 'Original task',
  identity: {
    engine: { kind: 'codex', model: 'gpt-5.6-sol', effort: 'high', codexAccount: email },
    billing: { kind: 'subscription', account: 'fixture@claude.test', dropEnvKey: false },
    cwd: REPO, addDirs: [], mode: 'auto', systemPrompt: null, outputStyle: null,
    tools: { skillOverrides: {}, deniedMcp: [] }
  }, snapshot: { messages: [] }
})
// Remain active until the test explicitly cancels this parent. Independent child
// processes read the replacement script below when they start.
script([
  ...begin('thread/start', 'parent-thread'),
  ...turn('parent-thread', 'PARENT_WORKING').slice(0, 3),
  { await: 'turn/interrupt', result: {} },
  { emit: { method: 'turn/completed', params: { threadId: 'parent-thread', turn: { id: 'PARENT_WORKING', status: 'interrupted' } } } }
])
const app = spawn(process.env.CCG_BTW_EXE || path.join(REPO, 'target/debug/agentcodegui.exe'), [], {
  windowsHide: true, stdio: 'ignore', env: {
    ...process.env, CCG_HOME: home, CCG_NO_NET: '1',
    CCG_CODEX_BIN: path.join(REPO, 'target/debug/ccg-fakecodex.exe'),
    CCG_FAKECODEX_SCRIPT: path.join(home, 'script.jsonl'), CCG_FAKECODEX_IN: path.join(home, 'stdin.jsonl'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`
  }
})
let main, side
const evaluate = (cdp, expression) => cdp.eval(`(async()=>(${expression}))()`, { awaitPromise: true })
const ipc = (cdp, channel, payload = []) => evaluate(cdp, `window.__TAURI_INTERNALS__.invoke('ipc_call',${JSON.stringify({ channel, payload })})`)
const until = async (fn, label) => {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) { if (await fn()) return; await sleep(100) }
  throw new Error(`Timed out: ${label}`)
}
const send = async (cdp, text, selector = '.composer') => {
  await evaluate(cdp, `(()=>{
    const c=document.querySelector(${JSON.stringify(selector)}), ta=c.querySelector('textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(ta,${JSON.stringify(text)});
    ta.dispatchEvent(new Event('input',{bubbles:true}));
  })()`)
  await sleep(100)
  await evaluate(cdp, `document.querySelector(${JSON.stringify(selector + ' .send:not(.stop)')}).click()`)
}
const connectedSide = async () => {
  let target
  await until(async () => {
    target = (await cdpTargets(port)).find(t => t.type === 'page' && t.url.includes('#session'))
    return !!target
  }, 'side window')
  return Cdp.connect(target.webSocketDebuggerUrl)
}
const status = async id => (await ipc(main, 'chats:get', [{ light: true }])).statuses[id]
const input = () => fs.readFileSync(path.join(home, 'stdin.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
const includes = (cdp, marker) => evaluate(cdp, `document.body.innerText.includes(${JSON.stringify(marker)})`)
const shot = async (cdp, name) => {
  const s = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(home, name), Buffer.from(s.data, 'base64'))
}
try {
  main = await connectMainPage(port)
  await until(() => evaluate(main, `!!document.querySelector('.ma-panel .composer textarea')`), 'parent composer')
  await evaluate(main, `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Get started')?.click()`)
  await send(main, 'Continue the original task', '.ma-panel .composer')
  await until(() => includes(main, 'PARENT_WORKING'), 'parent running')
  assert.equal((await status(parent)).busy, true)

  script([...begin('thread/fork', 'side-thread'), ...turn('side-thread', 'SIDE_ANSWER')])
  const question = 'What was the original task?'
  await send(main, '/btw ' + question, '.ma-panel .composer')
  side = await connectedSide()
  await until(() => includes(side, 'SIDE_ANSWER'), 'automatic side answer')
  const child = (await ipc(main, 'session-wins:list')).find(w => w.btwOf === 'btw::0')
  assert(child, 'Child must belong to its source panel')
  await until(async () => !(await status(child.id))?.busy, 'child idle')
  const record = read(`chats-v3/${child.id}.json`)
  assert.equal(record.btwSeed.engine, 'codex')
  assert.equal(record.btwSeed.fork, 'parent-thread')
  assert.equal(record.identity.engine.kind, 'codex')
  assert.equal(record.identity.engine.codexAccount, email)
  assert.equal((await ipc(side, 'session-wins:hydrate')).btwPrompt, undefined)
  assert.equal((await status(parent)).busy, true, 'Side question must not stop its parent')
  assert.equal(await includes(main, question), false, 'Question must not enter the parent transcript')
  const fork = input().find(r => r.method === 'thread/fork')
  assert.equal(fork.params.threadId, 'parent-thread')
  assert.equal(fork.params.deferGoalContinuation, true)
  assert(input().some(r => r.method === 'thread/goal/clear' && r.params.threadId === 'side-thread'))
  assert(!input().some(r => r.method === 'thread/goal/clear' && r.params.threadId === 'parent-thread'))
  assert(!input().some(r => r.method === 'turn/interrupt'), 'No interrupt before explicit parent stop')
  const sideTurn = input().find(r => r.method === 'turn/start' && r.params.threadId === 'side-thread')
  assert(sideTurn.params.input[0].text.includes('Do NOT continue, resume, or advance'))
  assert(sideTurn.params.input[0].text.endsWith(question))
  await shot(side, 'side-answer.png')

  // Force a process restart through the ordinary idle close; the next question
  // must resume the child, never fork/resume the source again.
  script([...begin('thread/resume', 'side-thread'), ...turn('side-thread', 'FOLLOW_UP_ANSWER')])
  await until(async () => {
    const row = (await ipc(main, 'engine:debug')).chats.find(c => c.chatId === child.id)
    return row?.state === 'Idle'
  }, 'child process settled')
  await send(side, 'Please explain that answer')
  await until(() => includes(side, 'FOLLOW_UP_ANSWER'), 'follow-up')
  assert.equal(input().filter(r => r.method === 'thread/fork').length, 1)
  assert(input().some(r => r.method === 'thread/resume' && r.params.threadId === 'side-thread'))
  await until(async () => !(await status(child.id))?.busy, 'follow-up idle')

  // X means close the window, preserving a dock pill; reopening must restore the
  // same child transcript without re-sending the initial question.
  await evaluate(side, `window.api.win.close()`)
  side.close(); side = null
  await until(async () => (await ipc(main, 'session-wins:list')).some(w => w.id === child.id && !w.shown), 'closed pill')
  const beforeReopen = input().length
  await ipc(main, 'session-wins:focus', [child.id])
  side = await connectedSide()
  await until(() => includes(side, 'FOLLOW_UP_ANSWER'), 'restored child history')
  assert.equal(input().length, beforeReopen, 'Reopen must not auto-send')
  await shot(main, 'parent-running.png')
  assert.equal((await status(parent)).busy, true)

  await evaluate(side, `window.api.win.close()`)
  side.close(); side = null
  await until(async () => (await ipc(main, 'session-wins:list')).some(w => w.id === child.id && !w.shown), 'close before retry case')
  script([{ await: 'initialize', result: {} }, { await: 'thread/fork', error: 'FORK_FAILED_FIXTURE' }])
  const turnCount = input().filter(r => r.method === 'turn/start').length
  await send(main, '/btw A question whose fork will fail', '.ma-panel .composer')
  side = await connectedSide()
  await until(() => includes(side, 'FORK_FAILED_FIXTURE'), 'fork error displayed')
  const failed = (await ipc(main, 'session-wins:list')).find(w => w.btwOf === 'btw::0' && w.id !== child.id)
  await until(async () => !(await status(failed.id))?.busy, 'failed child idle')
  assert.equal(input().filter(r => r.method === 'turn/start').length, turnCount, 'Failed fork sends no question')
  script([...begin('thread/fork', 'retry-child'), ...turn('retry-child', 'RETRY_SIDE_ANSWER')])
  await send(side, 'Retry the side question')
  await until(() => includes(side, 'RETRY_SIDE_ANSWER'), 'failed fork retry')
  assert(input().some(r => r.method === 'turn/start' && r.params.threadId === 'retry-child'))
  assert.equal(input().filter(r => r.method === 'turn/start' && r.params.threadId === 'parent-thread').length, 1)
  assert.equal((await status(parent)).busy, true)
  console.log(JSON.stringify({ passed: true, home, checks: [
    'busy composer /btw opens immediately', 'Codex seed/account persisted',
    'thread/fork with original context id', 'side reminder sent only to child',
    'parent stays active and its transcript is unchanged', 'follow-up resumes child',
    'closing/reopening preserves child and does not re-send',
    'fork error shown without sending; retry forks again instead of resuming parent'
  ] }))
} catch (error) {
  if (side) await shot(side, 'side-failure.png').catch(() => {})
  if (main) await shot(main, 'main-failure.png').catch(() => {})
  console.log('Artifacts:', home)
  throw error
} finally { side?.close(); main?.close(); killTree(app.pid) }
