// Native regression: stale Claude binding + Codex limit hold -> /clear -> reply.
// Also checks selecting a valid GPT account repairs a missing GPT binding.
// Requires Vite, the debug app and ccg-fakecodex. Uses only a synthetic isolated home.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { REPO, quietHome, connectMainPage, sleep, killTree } from '../bench/lib.mjs'

const home = fs.mkdtempSync(path.join(REPO, '.poc-home-codex-recovery-'))
quietHome(home)
const write = (name, data) => {
  const file = path.join(home, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data))
}
const good = 'recovered@openai.test'
const removedClaude = 'removed@claude.test'
const removedCodex = 'removed@openai.test'
const ids = ['ma-recovery-0', 'ma-recovery-1']
// Suppress the unrelated Claude installation prompt; this binary is never run.
const claudeStub = 'engines/fixture/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe'
write(claudeStub, '')
fs.copyFileSync(path.join(REPO, 'target/debug/ccg-fakecli.exe'), path.join(home, claudeStub))
write('engines/fixture/node_modules/@anthropic-ai/claude-agent-sdk/package.json', { version: 'fixture' })
write('config.json', { activeVersion: 'fixture' })
write('accounts.json', { version: 3, defaultEmail: 'other@claude.test', accounts: [{ email: 'other@claude.test' }] })
write('codex-accounts.json', { version: 1, defaultEmail: good, accounts: [{ email: good, plan: 'plus', authEnc: '' }] })
write('ui-prefs.json', { 'ui.lang': 'en', 'workspace.mode': 'multi', 'whatsnew.seenVersion': '99.0.0', 'limitResume.on': false, 'limitSwitch.on': false })
write('chats-v3/index.json', { version: 1, order: ids, activeChatId: ids[0], migratedAt: Date.now(), migrationComplete: true })
write('boards/index.json', { version: 1, order: ['recovery'], activeBoardId: 'recovery' })
write('boards/recovery.json', { id: 'recovery', title: 'Codex recovery', count: 2, chrome: 'grid', order: [0, 1, 2, 3, 4, 5], slots: [...ids, null, null, null, null] })
for (const [i, id] of ids.entries()) write(`chats-v3/${id}.json`, {
  id, origin: 'panel', title: i ? 'Missing GPT account' : 'Limit hold', status: 'error',
  identity: { engine: { kind: 'codex', model: 'gpt-5.6-sol', effort: 'high', codexAccount: i ? removedCodex : good },
    billing: { kind: 'subscription', account: removedClaude, dropEnvKey: false }, cwd: REPO, addDirs: [], mode: 'auto',
    systemPrompt: null, outputStyle: null, tools: { skillOverrides: {}, deniedMcp: [] } },
  ...(i ? {} : { hold: { resetsAt: Math.floor(Date.now() / 1000) + 3600, ready: false } }),
  snapshot: { messages: [{ kind: 'msg', id: 'old', role: 'user', text: 'Previous conversation', time: '8:00 PM' }] }
})
const th = 'recovered-thread'
write('script.jsonl', [
  { await: 'initialize', result: { userAgent: 'fake-codex' } },
  { await: 'thread/start', result: { thread: { id: th } } },
  { await: 'turn/start', result: { turn: { id: 'recovered-turn' } } },
  { emit: { method: 'turn/started', params: { threadId: th, turn: { id: 'recovered-turn' } } } },
  { emit: { method: 'item/completed', params: { threadId: th, item: { id: 'answer', type: 'agentMessage', text: 'RECOVERY_REPLY' } } } },
  { emit: { method: 'turn/completed', params: { threadId: th, turn: { id: 'recovered-turn', status: 'completed', durationMs: 100 } } } }
].map(x => JSON.stringify(x)).join('\n'))
const app = spawn(path.join(REPO, 'target/debug/agentcodegui.exe'), [], { windowsHide: true, stdio: 'ignore', env: {
  ...process.env, CCG_HOME: home, CCG_NO_NET: '1', CCG_CODEX_BIN: path.join(REPO, 'target/debug/ccg-fakecodex.exe'),
  CCG_FAKECODEX_SCRIPT: path.join(home, 'script.jsonl'), CCG_FAKECODEX_IN: path.join(home, 'stdin.jsonl'),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=19397'
} })
let cdp
const evaluate = expression => cdp.eval(`(async()=>(${expression}))()`, { awaitPromise: true })
const until = async expression => {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) { if (await evaluate(expression)) return; await sleep(100) }
  throw new Error(`Timed out: ${expression}\n${await evaluate('document.body.innerText.slice(-2000)')}`)
}
const panel = i => `document.querySelectorAll('.ma-panel')[${i}]`
const statusQuery = `(await window.__TAURI_INTERNALS__.invoke('ipc_call',{channel:'chats:get',payload:[{light:true}]})).statuses`
const send = async (i, text) => {
  await evaluate(`(()=>{const ta=${panel(i)}.querySelector('.composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(ta,${JSON.stringify(text)});ta.dispatchEvent(new Event('input',{bubbles:true}));})()`)
  await evaluate(`${panel(i)}.querySelector('.composer .send').click()`)
}
try {
  cdp = await connectMainPage(19397)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
  await until(`document.querySelectorAll('.ma-panel').length===2`)
  await until(`${panel(0)}.querySelector('.model-chip')?.textContent.includes('GPT') && ${panel(1)}.innerText.includes('Previous conversation')`)
  await evaluate(`(()=>{
    window.api.auth.accountsUsage=async()=>[];
    window.api.codexAuth.accountsUsage=async()=>[];
    [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Get started')?.click();
    window.__recoveryEvents=[[],[]];
    [0,1].forEach(i=>window.api.multi.onEvent('recovery::'+i,e=>window.__recoveryEvents[i].push(e)));
  })()`)
  await until(`!!(${statusQuery})['ma-recovery-0']?.hold`)
  await send(0, '/clear')
  await until(`!${panel(0)}.innerText.includes('Previous conversation') && !(${statusQuery})['ma-recovery-0']?.hold`)
  await send(0, 'First message after clear')
  await until(`${panel(0)}.innerText.includes('RECOVERY_REPLY') && (${statusQuery})['ma-recovery-0']?.status==='done'`)
  assert(!await evaluate(`${panel(0)}.innerText.includes(${JSON.stringify(removedClaude)})`), 'GPT must not be rejected for the unrelated Claude binding')

  // A genuinely missing GPT account still reports its own error, then recovers
  // on the first send after selecting the registered GPT account.
  await send(1, 'Try the missing account')
  await until(`${panel(1)}.innerText.includes(${JSON.stringify(removedCodex)})`)
  await evaluate(`${panel(1)}.querySelector('.model-chip').click()`)
  await until(`!![...document.querySelectorAll('.picker-pop .pp-row')].find(r=>r.querySelector('.pp-main')?.textContent.startsWith('recovered'))`)
  await evaluate(`[...document.querySelectorAll('.picker-pop .pp-row')].find(r=>r.querySelector('.pp-main')?.textContent.startsWith('recovered')).click()`)
  await evaluate(`document.querySelector('.set-dialog .sd-go')?.click()`)
  await evaluate(`${panel(1)}.querySelector('.model-chip.on')?.click()`)
  await send(1, 'First message after selecting the valid account')
  await until(`${panel(1)}.innerText.includes('RECOVERY_REPLY') && (${statusQuery})['ma-recovery-1']?.status==='done'`)
  assert(await evaluate(`${panel(1)}.innerText.includes('Previous conversation')`), 'switching account preserves the conversation')
  const statuses = await evaluate(statusQuery)
  for (const id of ids) {
    assert.equal(statuses[id].codexAccount, good)
    assert.equal(statuses[id].hold, null)
    assert.equal(statuses[id].busy, false)
  }
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(home, 'recovered.png'), Buffer.from(shot.data, 'base64'))
  console.log('PASS stale Claude binding + Codex quota hold -> /clear -> first reply; missing GPT account -> valid selection -> first reply')
  console.log(JSON.stringify({ home }))
} catch (error) {
  if (cdp) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null)
    if (shot) fs.writeFileSync(path.join(home, 'failure.png'), Buffer.from(shot.data, 'base64'))
  }
  console.log('Artifacts:', home)
  throw error
} finally { cdp?.close(); killTree(app.pid) }
