// Native status -> account picker. Synthetic accounts and usage; no CLI or model calls.
// Requires the Vite dev server and the current debug app binary.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { REPO, quietHome, connectMainPage, sleep, killTree } from '../bench/lib.mjs'

const home = fs.mkdtempSync(path.join(REPO, '.poc-home-account-picker-'))
quietHome(home)
const write = (name, value) => {
  const file = path.join(home, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value))
}
const shared = 'shared@fixture.test'
const cxAccounts = ['default@fixture.test', shared, 'exhausted@fixture.test', 'reset@fixture.test']
  .map((email, i) => ({ email, plan: 'plus', isDefault: i === 0 }))
const now = Math.floor(Date.now() / 1000)
const usage = cxAccounts.map(a => ({ email: a.email, planType: 'plus', windows: [
  { label: 'Weekly', usedPct: a.email.startsWith('default') ? 20 : 100, resetsAt: a.email.startsWith('reset') ? now - 10 : now + 86400 }
] }))
write('ui-prefs.json', { 'ui.lang': 'en', 'workspace.mode': 'multi', 'sidebar.autohide': false, 'whatsnew.seenVersion': '99.0.0' })
write('accounts.json', { version: 3, defaultEmail: shared, accounts: [{ email: shared, subscriptionType: 'max' }] })
fs.mkdirSync(path.join(home, 'accounts', 'shared_fixture.test'), { recursive: true })
write('codex-accounts.json', { version: 1, defaultEmail: cxAccounts[0].email, accounts: cxAccounts })
write('multi-agent/index.json', { version: 2, order: ['account-test'], activeSessionId: 'account-test' })
write('multi-agent/account-test.json', { id: 'account-test', title: 'Account picker test', count: 3,
  panels: [0, 1, 2].map(i => ({ title: i ? `GPT ${i}` : 'Claude', cwd: REPO,
    picker: { engine: i ? 'codex' : 'claude', model: 'opus', effort: 'xhigh', mode: 'normal',
      account: shared, ...(i ? { codexModel: 'gpt-6-astra', codexAccount: shared } : {}) }, snapshot: { messages: [] } })) })

const app = spawn(path.join(REPO, 'target/debug/agentcodegui.exe'), [], { windowsHide: true, stdio: 'ignore', env: {
  ...process.env, CCG_HOME: home, CCG_NO_NET: '1', WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=19396'
} })
let cdp
const evaluate = expression => cdp.eval(`(async()=>(${expression}))()`, { awaitPromise: true })
const until = async expression => {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return
    await sleep(100)
  }
  throw new Error(`Timed out: ${expression}`)
}
const panel = n => `document.querySelectorAll('.ma-panel')[${n}]`
const row = name => `[...document.querySelectorAll('.picker-pop .pp-row')].find(r=>r.querySelector('.pp-main')?.textContent.startsWith(${JSON.stringify(name)}))`
const statusQuery = `(await window.__TAURI_INTERNALS__.invoke('ipc_call',{channel:'chats:get',payload:[{light:true}]})).statuses`
try {
  cdp = await connectMainPage(19396)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false })
  await until(`document.querySelectorAll('.ma-panel').length===3`)
  await evaluate(`(()=>{
    window.api.auth.accountsUsage=async()=>[];
    window.api.codexAuth.accountsUsage=async()=>${JSON.stringify(usage)};
    [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Get started')?.click();
  })()`)
  // Identity queries construct idle runtimes without spawning the CLI.
  await evaluate(`Promise.all([0,1,2].map(i=>window.__TAURI_INTERNALS__.invoke('ipc_call',{
    channel:'chat:identity-get',payload:[{chatId:'ma-account-test-'+i}]
  })))`)
  await until(`(${statusQuery})?.['ma-account-test-2']?.codexAccount===${JSON.stringify(shared)}`)
  const statuses = await evaluate(statusQuery)
  assert.equal(statuses['ma-account-test-0'].account, shared)
  assert.equal(statuses['ma-account-test-0'].codexAccount, null)
  for (const i of [1, 2]) {
    assert.equal(statuses[`ma-account-test-${i}`].account, null, 'GPT must not count against the Claude account')
    assert.equal(statuses[`ma-account-test-${i}`].codexAccount, shared)
  }
  await evaluate(`${panel(0)}.querySelector('.model-chip').click()`)
  await until(`!!${row('shared')}?.querySelector('.pp-now')`)
  assert.equal(await evaluate(`${row('shared')}.querySelector('.pp-warn')?.textContent??null`), null, 'only one Claude session uses this account')
  await evaluate(`${panel(0)}.querySelector('.model-chip').click()`)
  await evaluate(`${panel(1)}.querySelector('.model-chip').click()`)
  await until(`${row('shared')}?.querySelector('.pp-warn')?.textContent==='In use · Slot 3'`)
  assert.equal(await evaluate(`${row('shared')}.querySelector('.pp-now')?.textContent`), 'Current')
  assert.equal(await evaluate(`${row('default')}?.querySelector('.pp-now')?.textContent??null`), null)
  assert.equal(await evaluate(`!!${row('exhausted')}`), false, 'weekly exhausted account is hidden')
  assert.equal(await evaluate(`!!${row('shared')}`), true, 'current account remains visible even when exhausted')
  assert.equal(await evaluate(`!!${row('reset')}`), true, 'a reset weekly window is no longer exhausted')
  assert(await evaluate(`${row('reset')}.textContent.includes('100%')`), 'reset account has headroom again')
  await evaluate(`document.querySelector('.picker-pop .pp-filt').click()`)
  await until(`!!${row('exhausted')}`)
  await evaluate(`document.querySelector('.picker-pop .pp-filt').click()`)
  await until(`!${row('exhausted')}`)
  await evaluate(`(async()=>{
    const source=await (await fetch('/src/components/Chat.tsx')).text();
    const storePath=source.match(/from "([^"\\n]*\\/lib\\/accounts\\.ts[^"\\n]*)"/)[1];
    window.__pickerAccounts=await import(storePath);
    window.__pickerAccounts.putCodexAccounts([{email:${JSON.stringify(shared)},plan:'plus',isDefault:true}]);
  })()`)
  await until(`!${row('default')} && !${row('reset')} && document.querySelectorAll('.picker-pop .pp-now').length===1`)
  assert.equal(await evaluate(`document.querySelector('.picker-pop .pp-filt')?.textContent`), 'Hide weekly 0%', 'weekly filter remains available with one GPT account')
  assert.equal(await evaluate(`window.__pickerAccounts.liveAccountOf('account-test::1','codex')`), shared)
  await evaluate(`${row('shared')}.scrollIntoView({block:'center'})`)
  await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`)
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(home, 'picker.png'), Buffer.from(shot.data, 'base64'))
  console.log('PASS native Claude/Codex account separation, current/in-use badges, weekly filter, current and reset exceptions, one-account filter')
  console.log(JSON.stringify({ home }))
} catch (error) {
  if (cdp) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null)
    if (shot) fs.writeFileSync(path.join(home, 'failure.png'), Buffer.from(shot.data, 'base64'))
  }
  console.log('Artifacts:', home)
  throw error
} finally { cdp?.close(); killTree(app.pid) }
