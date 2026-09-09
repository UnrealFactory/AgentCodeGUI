// Codex quota waits, manual sends and account changes through the real Tauri UI.
// Uses an isolated home and synthetic CLI responses; no paid model requests.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { REPO, quietHome, connectMainPage, sleep, killTree } from '../bench/lib.mjs'

const home = fs.mkdtempSync(path.join(REPO, '.poc-home-codex-limit-'))
quietHome(home)
const write = (name, data) => {
  const file = path.join(home, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data))
}
const limited = 'limited@openai.test', ready = 'ready@openai.test'
const ids = ['ma-quota-0', 'ma-quota-1']
const reset = new Date(Math.floor(Date.now() / 60000) * 60000 + 3 * 86400000)
const resetSeconds = reset.getTime() / 1000
const month = reset.toLocaleString('en-US', { month: 'short' })
const time = reset.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
const error = `You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at ${month} ${reset.getDate()}th, ${reset.getFullYear()} ${time}.`
const stub = 'engines/fixture/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe'
write(stub, '')
fs.copyFileSync(path.join(REPO, 'target/debug/ccg-fakecli.exe'), path.join(home, stub))
write('engines/fixture/node_modules/@anthropic-ai/claude-agent-sdk/package.json', { version: 'fixture' })
write('config.json', { activeVersion: 'fixture' })
write('accounts.json', { version: 3, accounts: [{ email: 'unrelated@claude.test' }] })
write('codex-accounts.json', { version: 1, defaultEmail: limited, accounts: [limited, ready].map(email => ({ email, plan: 'plus', authEnc: '' })) })
write('ui-prefs.json', { 'ui.lang': 'en', 'workspace.mode': 'multi', 'whatsnew.seenVersion': '99.0.0', 'limitResume.on': true, 'limitSwitch.on': false })
write('chats-v3/index.json', { version: 1, order: ids, activeChatId: ids[0], migratedAt: Date.now(), migrationComplete: true })
write('boards/index.json', { version: 1, order: ['quota'], activeBoardId: 'quota' })
write('boards/quota.json', { id: 'quota', title: 'Quota recovery', count: 2, chrome: 'grid', order: [0, 1, 2, 3, 4, 5], slots: [...ids, null, null, null, null] })
for (const [i, id] of ids.entries()) write(`chats-v3/${id}.json`, {
  id, origin: 'panel', title: i ? 'Fresh quota error' : 'Waiting for quota',
  identity: { engine: { kind: 'codex', model: 'gpt-5.6-sol', effort: 'low', codexAccount: limited },
    billing: { kind: 'subscription', account: 'unrelated@claude.test', dropEnvKey: true }, cwd: REPO, addDirs: [], mode: 'auto', tools: { skillOverrides: {}, deniedMcp: [] } },
  ...(i ? {} : { hold: { resetsAt: resetSeconds, ready: false } }),
  snapshot: { messages: [{ kind: 'msg', id: 'old', role: 'user', text: 'Previous conversation', time: '8:00 PM' }] }
})
const script = failed => write('script.jsonl', [
  { await: 'initialize', result: { userAgent: 'synthetic-codex' } },
  { await: 'thread/start', result: { thread: { id: failed ? 'limited-thread' : 'ready-thread' } } },
  { await: 'turn/start', result: { turn: { id: 'turn-1' } } },
  { emit: { method: 'turn/started', params: { threadId: failed ? 'limited-thread' : 'ready-thread', turn: { id: 'turn-1' } } } },
  ...(failed ? [
    { emit: { method: 'error', params: { threadId: 'limited-thread', turnId: 'turn-1', willRetry: false, error: { message: error } } } },
    { emit: { method: 'turn/completed', params: { threadId: 'limited-thread', turn: { id: 'turn-1', status: 'failed', error: { message: error } } } } }
  ] : [
    { emit: { method: 'item/completed', params: { threadId: 'ready-thread', item: { id: 'reply', type: 'agentMessage', text: 'READY_ACCOUNT_REPLY' } } } },
    { emit: { method: 'turn/completed', params: { threadId: 'ready-thread', turn: { id: 'turn-1', status: 'completed' } } } }
  ])
].map(JSON.stringify).join('\n'))
script(false)
const app = spawn(path.join(REPO, 'target/debug/agentcodegui.exe'), [], { windowsHide: true, stdio: 'ignore', env: {
  ...process.env, CCG_HOME: home, CCG_NO_NET: '1', CCG_CODEX_BIN: path.join(REPO, 'target/debug/ccg-fakecodex.exe'),
  CCG_FAKECODEX_SCRIPT: path.join(home, 'script.jsonl'), CCG_FAKECODEX_IN: path.join(home, 'stdin.jsonl'),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=19427'
} })
let cdp
const evaluate = expression => cdp.eval(`(async()=>(${expression}))()`, { awaitPromise: true })
const panel = i => `document.querySelectorAll('.ma-panel')[${i}]`
const statuses = `(await window.__TAURI_INTERNALS__.invoke('ipc_call',{channel:'chats:get',payload:[{light:true}]})).statuses`
const until = async expression => {
  const end = Date.now() + 15000
  while (Date.now() < end) { if (await evaluate(expression)) return; await sleep(100) }
  throw new Error(`Timed out: ${expression}\n${await evaluate('document.body.innerText.slice(-2400)')}`)
}
const send = async (slot, text) => {
  await evaluate(`(()=>{const ta=${panel(slot)}.querySelector('.composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(ta,${JSON.stringify(text)});ta.dispatchEvent(new Event('input',{bubbles:true}));})()`)
  await evaluate(`${panel(slot)}.querySelector('.composer [aria-label="Send"]').click()`)
}
const wire = () => fs.existsSync(path.join(home, 'stdin.jsonl')) ? fs.readFileSync(path.join(home, 'stdin.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
try {
  cdp = await connectMainPage(19427)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 950, deviceScaleFactor: 1, mobile: false })
  await until(`!!window.api && document.querySelectorAll('.ma-panel').length===2`)
  await evaluate(`(()=>{window.api.auth.accountsUsage=async()=>[];window.api.codexAuth.accountsUsage=async()=>[];[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Get started')?.click();})()`)
  await until(`${panel(0)}.innerText.includes('Previous conversation') && ${panel(0)}.querySelector('.lh-title') && !!(${statuses})[${JSON.stringify(ids[0])}].hold`)
  await send(0, 'Continue after the quota wait')
  await until(`(${statuses})[${JSON.stringify(ids[0])}].queued===1`)
  assert.equal(await evaluate(`${panel(0)}.querySelectorAll('.send.stop').length`), 0, 'A queued message must not display a running spinner')
  assert.equal(wire().filter(v => v.method === 'turn/start').length, 0)
  console.log('PASS: restored quota countdown is shown; a manual message waits without a fake running state')

  await evaluate(`${panel(0)}.querySelector('.model-chip').click()`)
  await until(`!![...document.querySelectorAll('.picker-pop .pp-row')].find(r=>r.querySelector('.pp-main')?.textContent.startsWith('ready'))`)
  await evaluate(`[...document.querySelectorAll('.picker-pop .pp-row')].find(r=>r.querySelector('.pp-main')?.textContent.startsWith('ready')).click()`)
  await evaluate(`document.querySelector('.set-dialog .sd-go')?.click()`)
  await evaluate(`${panel(0)}.querySelector('.model-chip.on')?.click()`)
  await until(`${panel(0)}.innerText.includes('READY_ACCOUNT_REPLY') && (${statuses})[${JSON.stringify(ids[0])}].status==='done'`)
  assert.equal((await evaluate(statuses))[ids[0]].codexAccount, ready)
  assert.equal((await evaluate(statuses))[ids[0]].hold, null)
  assert.equal(wire().filter(v => v.method === 'turn/start').length, 1, 'The waiting message must run exactly once')
  console.log('PASS: choosing a new GPT account releases the waiting message once and receives its answer')

  script(true)
  await send(1, 'Trigger the Codex quota response')
  await until(`(${statuses})[${JSON.stringify(ids[1])}]?.hold?.resetAt > Date.now()/1000`)
  assert(Math.abs((await evaluate(statuses))[ids[1]].hold.resetAt - resetSeconds) < 2)
  await until(`${panel(1)}.querySelector('.lh-title') && !${panel(1)}.querySelector('.send.stop')`)
  assert.equal(await evaluate(`${panel(1)}.querySelectorAll('.lh-title').length`), 1, 'Only the engine quota banner should appear')
  assert(!(await evaluate(`${panel(1)}.innerText`)).includes('Checks every 10 minutes'))
  assert.equal(await evaluate(`${panel(1)}.querySelector('.ma-status').textContent.trim()`), 'Quota wait')
  const count = wire().filter(v => v.method === 'turn/start').length
  await sleep(1000)
  assert.equal(wire().filter(v => v.method === 'turn/start').length, count)
  console.log('PASS: native Codex date/year becomes the real reset countdown with one quota owner')

  // Drive the shared hook through an actual busy -> limit transition in both
  // address forms used by detached chat windows and panel popouts.
  await evaluate(`(async()=>{
    const source=await (await fetch('/src/components/Chat.tsx')).text();
    const entry=await (await fetch('/src/main.tsx')).text();
    const {default:React}=await import(source.match(/from "([^"]*react[.]js[^"]*)"/)[1]);
    const {default:{createRoot}}=await import(entry.match(/from "([^"]*react-dom_client.js[^"]*)"/)[1]);
    const {useManagedLimitResume}=await import('/src/lib/useManagedLimitResume.ts');
    window.__quotaAutoSends=0;
    function Fixture(){
      const [busy,setBusy]=React.useState(true);window.__finishQuotaFixture=()=>setBusy(false);
      const options={state:{status:busy?'working':'error',messages:[{kind:'msg',role:'user',text:'Continue'},...busy?[]:[{kind:'msg',role:'assistant',error:true,text:${JSON.stringify(error)}}]],interrupted:false,session:{sessionId:'limited-thread'}},busy,enabled:true,apiMode:false,engine:'codex',account:${JSON.stringify(limited)},fable:false,holdKey:'fixture',send:()=>window.__quotaAutoSends++};
      const chat=useManagedLimitResume(options,${JSON.stringify(ids[1])});
      const panel=useManagedLimitResume(options,'quota::1');
      window.__quotaFixture={busy,local:[chat.hold,panel.hold],managed:[chat.managedHold,panel.managedHold]};return null;
    }
    const host=document.createElement('div');document.body.append(host);window.__quotaFixtureRoot=createRoot(host);window.__quotaFixtureRoot.render(React.createElement(Fixture));
  })()`)
  await until(`window.__quotaFixture?.busy===true`)
  await evaluate('window.__finishQuotaFixture()')
  await until(`window.__quotaFixture?.busy===false && window.__quotaFixture.managed.every(Boolean)`)
  await sleep(100)
  assert.deepEqual(await evaluate('window.__quotaFixture.local'), [null, null], 'No renderer quota timer should be armed alongside the engine')
  assert.equal(await evaluate('window.__quotaAutoSends'), 0)
  await evaluate('window.__quotaFixtureRoot.unmount()')
  console.log('PASS: chat and panel window hooks defer to the engine and never arm a duplicate resume')
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(home, 'verified.png'), Buffer.from(shot.data, 'base64'))
  console.log('Artifacts:', home)
} catch (e) {
  if (cdp) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null)
    if (shot) fs.writeFileSync(path.join(home, 'failure.png'), Buffer.from(shot.data, 'base64'))
  }
  console.log('Artifacts:', home)
  throw e
} finally { cdp?.close(); await killTree(app.pid) }
