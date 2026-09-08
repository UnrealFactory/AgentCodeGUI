// Native regression for account-registry refresh and atomic Run rejection.
// Requires Vite + debug app + ccg-fakecodex. All accounts and files are synthetic.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { REPO, quietHome, connectMainPage, sleep, killTree } from '../bench/lib.mjs'

const home = fs.mkdtempSync(path.join(REPO, '.poc-home-run-identity-'))
quietHome(home)
const write = (name, value) => {
  const file = path.join(home, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
}
const id = 'ma-run-identity-0'
const first = 'first@openai.test'
const added = 'added@openai.test'
const picker = 'picker@openai.test'
const missing = 'missing@openai.test'
const register = emails => write('codex-accounts.json', {
  version: 1, defaultEmail: first, accounts: emails.map(email => ({ email, plan: 'plus', authEnc: '' }))
})
const claudeStub = 'engines/fixture/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe'
write(claudeStub, '')
fs.copyFileSync(path.join(REPO, 'target/debug/ccg-fakecli.exe'), path.join(home, claudeStub))
write('engines/fixture/node_modules/@anthropic-ai/claude-agent-sdk/package.json', { version: 'fixture' })
write('config.json', { activeVersion: 'fixture' })
write('accounts.json', { version: 3, accounts: [{ email: 'fixture@claude.test' }] })
register([first])
write('ui-prefs.json', {
  'ui.lang': 'en', 'workspace.mode': 'multi', 'whatsnew.seenVersion': '99.0.0',
  'limitResume.on': false, 'limitSwitch.on': false
})
write('chats-v3/index.json', { version: 1, order: [id], activeChatId: id, migratedAt: Date.now(), migrationComplete: true })
write('boards/index.json', { version: 1, order: ['run-identity'], activeBoardId: 'run-identity' })
write('boards/run-identity.json', {
  id: 'run-identity', title: 'Run identity', count: 2, chrome: 'grid',
  order: [0, 1, 2, 3, 4, 5], slots: [id, null, null, null, null, null]
})
write(`chats-v3/${id}.json`, {
  id, origin: 'panel', title: 'Run identity',
  identity: {
    engine: { kind: 'codex', model: 'gpt-5.6-sol', effort: 'high', codexAccount: first },
    billing: { kind: 'subscription', account: 'fixture@claude.test', dropEnvKey: false },
    cwd: REPO, addDirs: [], mode: 'auto', systemPrompt: null, outputStyle: null,
    tools: { skillOverrides: {}, deniedMcp: [] }
  }, snapshot: { messages: [{ kind: 'msg', id: 'old', role: 'user', text: 'Previous conversation', time: '8:00 PM' }] }
})
const script = marker => write('script.jsonl', [
  { await: 'initialize', result: { userAgent: 'fake-codex' } },
  { await: 'thread/start', result: { thread: { id: marker } } },
  { await: 'turn/start', result: { turn: { id: marker + '-turn' } } },
  { emit: { method: 'turn/started', params: { threadId: marker, turn: { id: marker + '-turn' } } } },
  { emit: { method: 'item/completed', params: { threadId: marker, item: { id: marker, type: 'agentMessage', text: marker } } } },
  { emit: { method: 'turn/completed', params: { threadId: marker, turn: { id: marker + '-turn', status: 'completed', durationMs: 100 } } } }
].map(v => JSON.stringify(v)).join('\n'))
script('BASELINE_REPLY')
const app = spawn(path.join(REPO, 'target/debug/agentcodegui.exe'), [], { windowsHide: true, stdio: 'ignore', env: {
  ...process.env, CCG_HOME: home, CCG_NO_NET: '1',
  CCG_CODEX_BIN: path.join(REPO, 'target/debug/ccg-fakecodex.exe'),
  CCG_FAKECODEX_SCRIPT: path.join(home, 'script.jsonl'), CCG_FAKECODEX_IN: path.join(home, 'stdin.jsonl'),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=19407'
} })
let cdp
const evaluate = expression => cdp.eval(`(async()=>(${expression}))()`, { awaitPromise: true })
const ipc = (channel, request = {}) => evaluate(`window.__TAURI_INTERNALS__.invoke('ipc_call',${JSON.stringify({ channel, payload: [request] })})`)
const until = async expression => {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) { if (await evaluate(expression)) return; await sleep(100) }
  throw new Error(`Timed out: ${expression}\n${await evaluate('document.body.innerText.slice(-2000)')}`)
}
const statusQuery = `(await window.__TAURI_INTERNALS__.invoke('ipc_call',{channel:'chats:get',payload:[{light:true}]})).statuses[${JSON.stringify(id)}]`
const status = async () => (await ipc('chats:get', { light: true })).statuses[id]
const debug = async () => (await ipc('engine:debug')).chats.find(row => row.chatId === id)
const input = () => fs.readFileSync(path.join(home, 'stdin.jsonl'), 'utf8')
const request = (account, prompt, cwd = REPO) => ({ chatId: id, engine: 'codex', codexModel: 'gpt-5.6-sol', codexAccount: account, cwd, mode: 'auto', prompt })
try {
  cdp = await connectMainPage(19407)
  await until(`document.querySelector('.ma-panel .model-chip')?.textContent.includes('GPT')`)
  await evaluate(`(async()=>{
    window.api.auth.accountsUsage=async()=>[];
    window.api.codexAuth.accountsUsage=async()=>[];
    [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Get started')?.click();
    window.__runVerdicts=[];
    const {onChatVerdict}=await import('/src/api/unified.ts');
    onChatVerdict((chatId,verdict,panelId)=>window.__runVerdicts.push({chatId,verdict,panelId}));
    const ta=document.querySelector('.ma-panel .composer textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(ta,'Baseline message');
    ta.dispatchEvent(new Event('input',{bubbles:true}));
  })()`)
  await evaluate(`document.querySelector('.ma-panel .composer .send').click()`)
  await until(`document.body.innerText.includes('BASELINE_REPLY') && (${statusQuery})?.status==='done'`)

  // Add an account after this chat already has a runtime, then send with a new cwd.
  register([first, added])
  const selectedCwd = path.join(home, 'selected-work')
  fs.mkdirSync(selectedCwd)
  script('ADDED_ACCOUNT_REPLY')
  await evaluate('window.__runVerdicts=[]')
  assert(await ipc('chat:run', request(added, 'New account and folder', selectedCwd)))
  await until(`document.body.innerText.includes('ADDED_ACCOUNT_REPLY') && (${statusQuery})?.status==='done'`)
  assert.equal((await status()).codexAccount, added)
  assert.equal(await evaluate(`window.__runVerdicts.filter(v=>v.verdict.kind==='rejected').length`), 0)
  const threads = input().trim().split('\n').map(s => JSON.parse(s)).filter(v => v.method === 'thread/start')
  assert.equal(threads.at(-1).params.cwd.toLowerCase(), selectedCwd.toLowerCase())

  // A direct picker change must also use the current registry.
  register([first, added, picker])
  const applied = await ipc('chat:identity-set', { chatId: id, applyPolicy: 'now', patch: { engine: { codexAccount: picker } } })
  assert.equal(applied.kind, 'applied')
  assert.equal((await status()).codexAccount, picker)

  // Reject the entire Run before changing its thread, sending, or issuing a runId.
  const before = await debug()
  const beforeInput = input()
  await evaluate('window.__runVerdicts=[]')
  const bad = { ...request(missing, 'MUST_NOT_REACH_ENGINE', REPO), resume: 'MUST_NOT_BIND' }
  assert.equal(await ipc('chat:run', bad), null)
  await until(`document.body.innerText.includes("Couldn't send the message")`)
  await sleep(300)
  const rejected = await evaluate(`window.__runVerdicts.filter(v=>v.verdict.kind==='rejected')`)
  assert.equal(rejected.length, 1)
  assert.equal(rejected[0].verdict.cmd, 'run')
  assert.equal(rejected[0].verdict.reason, 'account_unavailable')
  assert.equal(input(), beforeInput, 'rejected prompt must not reach the old engine')
  const after = await debug()
  assert.equal(after.session, before.session)
  assert.equal(after.spawns, before.spawns)
  assert.equal(after.queued, before.queued)
  assert.equal((await status()).busy, false)
  assert.equal((await status()).codexAccount, picker)

  // Removing a previously valid account must take effect in the same open chat.
  register([first, added])
  assert.equal(await ipc('chat:run', request(picker, 'REMOVED_ACCOUNT_MUST_NOT_SEND')), null)
  assert.equal(input(), beforeInput)

  // The rejection does not poison the next valid send.
  script('RETRY_REPLY')
  assert(await ipc('chat:run', request(added, 'Valid retry', selectedCwd)))
  await until(`document.body.innerText.includes('RETRY_REPLY') && (${statusQuery})?.status==='done'`)
  assert.equal((await status()).codexAccount, added)
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(home, 'verified.png'), Buffer.from(shot.data, 'base64'))
  console.log(JSON.stringify({ passed: true, home, checks: [
    'new account + cwd applied to existing runtime', 'picker reads new account',
    'one blocking run verdict', 'no old-account send, thread mutation, spawn or queue',
    'removed account rejected', 'valid retry succeeds'
  ] }))
} catch (error) {
  if (cdp) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null)
    if (shot) fs.writeFileSync(path.join(home, 'failure.png'), Buffer.from(shot.data, 'base64'))
  }
  console.log('Artifacts:', home)
  throw error
} finally { cdp?.close(); killTree(app.pid) }
