// Native GUI regression for 5 -> 4 replacing the fourth conversation with a blank panel.
// Requires npm run app:dev and a debug app binary. Uses an isolated home; no engine turns.
// node scripts/poc-panel-resize.mjs [--exe=target/debug/agentcodegui.exe]
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { connectMainPage, killTree, quietHome, REPO, sleep } from '../bench/lib.mjs'

const exe = path.resolve(process.argv.find(a => a.startsWith('--exe='))?.slice(6) ?? 'target/debug/agentcodegui.exe')
const home = fs.mkdtempSync(path.join(REPO, '.poc-home-panel-resize-'))
const port = 19402
const write = (name, value) => {
  const file = path.join(home, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value))
}
quietHome(home)
write('profile.json', { nickname: 'Panel resize regression' })
write('ui-prefs.json', { 'ui.lang': 'en', 'workspace.mode': 'multi', 'sidebar.autohide': false, 'whatsnew.seenVersion': '99.0.0' })
write('multi-agent/index.json', { version: 2, order: ['resize'], activeSessionId: 'resize' })
write('multi-agent/resize.json', { id: 'resize', title: 'Panel resize', count: 5, panelOrder: [0, 1, 2, 3, 4, 5],
  panels: Array.from({ length: 6 }, (_, slot) => ({
    title: slot < 4 ? `Conversation ${slot + 1}` : '', custom: slot < 4, locked: slot < 3, cwd: REPO,
    picker: { engine: 'codex', codexModel: 'gpt-6-astra', model: 'opus', effort: 'medium', mode: 'normal' },
    snapshot: { messages: slot < 4 ? [{ kind: 'msg', id: `answer-${slot}`, role: 'assistant',
      text: `PRESERVED_CONVERSATION_${slot + 1}`, animate: false, time: '12:00' }] : [] }
  })) })

let cdp
const app = spawn(exe, [], { windowsHide: true, stdio: 'ignore', env: { ...process.env, CCG_HOME: home, CCG_NO_NET: '1',
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` } })
const evaluate = expression => cdp.eval(`(async()=>(${expression}))()`, { awaitPromise: true })
const until = async expression => {
  const end = Date.now() + 20000
  while (Date.now() < end) { if (await evaluate(expression)) return; await sleep(100) }
  throw new Error(`Timed out: ${expression}`)
}
const panel = slot => `.ma-grid > .ma-panel[data-slot="${slot}"]`
const visible = () => evaluate(`Array.from(document.querySelectorAll('.ma-grid > .ma-panel')).map(el=>Number(el.dataset.slot))`)
const click = async selector => {
  const location = `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;
    el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
    return el.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`
  await until(location)
  const point = await evaluate(location)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
}
const dial = async count => {
  await click(`.ma-count-btn[data-count="${count}"]`)
  await until(`document.querySelectorAll('.ma-grid.n${count} > .ma-panel').length===${count}`)
}
const focus = async slot => {
  await click(`${panel(slot)} .composer textarea`)
  await until(`document.querySelector(${JSON.stringify(panel(slot))}).classList.contains('focused')`)
}
const checkConversations = async count => {
  assert.deepEqual(await visible(), Array.from({ length: count }, (_, i) => i))
  for (let slot = 0; slot < Math.min(count, 4); slot++) {
    assert((await evaluate(`document.querySelector(${JSON.stringify(panel(slot))}).innerText`)).includes(`PRESERVED_CONVERSATION_${slot + 1}`))
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(panel(slot) + ' .ma-p-title')}).textContent`), `Conversation ${slot + 1}`)
  }
}
try {
  cdp = await connectMainPage(port)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
  await until(`document.querySelectorAll('.ma-grid > .ma-panel').length===5`)
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Get started')?.click()`)
  await until(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Later')`)
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Later').click()`)
  await checkConversations(5)
  // Exact reported case: the focused fifth panel is empty, the fourth holds a conversation.
  await focus(4)
  await dial(4)
  await checkConversations(4)
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(home, 'four-panels.png'), Buffer.from(shot.data, 'base64'))
  await dial(5)
  await checkConversations(5)
  console.log('PASS focused empty fifth panel folds; the original fourth conversation stays visible')

  // Folding also retains an unsent draft without submitting it to an engine.
  await focus(4)
  await cdp.send('Input.insertText', { text: 'UNSENT_DRAFT_FIVE' })
  await dial(4)
  await dial(5)
  await checkConversations(5)
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(panel(4) + ' .composer textarea')}).value`), 'UNSENT_DRAFT_FIVE')
  for (const count of [4, 3, 2]) {
    await focus(count)
    await dial(count)
    await checkConversations(count)
  }
  await dial(5)
  await checkConversations(5)
  console.log('PASS draft and conversations survive repeated 5/4/3/2 transitions')

  await focus(4)
  await dial(1)
  assert.deepEqual(await visible(), [4], 'Single-panel view follows the selected conversation')
  await dial(4)
  await checkConversations(4)
  // The commit and store save have separate debounce timers. Wait for the stored count.
  await until(`(await window.api.multi.getState()).sessions.find(s=>s.id==='resize')?.count===4`)
  await evaluate(`window.__beforeResizeReload=true`)
  await cdp.send('Page.reload')
  await until(`!window.__beforeResizeReload && document.querySelectorAll('.ma-grid.n4 > .ma-panel').length===4`)
  await checkConversations(4)
  console.log('PASS single-panel return and saved four-panel layout retain the original conversations')
  console.log(JSON.stringify({ passed: true, home }))
} catch (error) {
  if (cdp) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null)
    if (shot) fs.writeFileSync(path.join(home, 'failure.png'), Buffer.from(shot.data, 'base64'))
  }
  console.log('Artifacts:', home)
  throw error
} finally { cdp?.close(); killTree(app.pid) }
