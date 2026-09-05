// Real GUI + fake Codex protocol: expand a multi-file Edit, open each file,
// collapse again, and retain exact paths after saving/reloading the conversation.
// node scripts/poc-edit-files.mjs [--exe=target/debug/agentcodegui.exe]
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { connectMainPage, killTree, quietHome, REPO, sleep } from '../bench/lib.mjs'

const exe = path.resolve(process.argv.find(a => a.startsWith('--exe='))?.slice(6) ?? 'target/debug/agentcodegui.exe')
const home = fs.mkdtempSync(path.join(REPO, '.poc-home-edit-files-'))
const work = path.join(home, 'work')
const port = 19389
const write = (name, value) => {
  const file = path.join(home, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
}
quietHome(home)
const paths = ['src/first.ts', 'src/with, comma.ts']
for (const [i, file] of paths.entries()) write(`work/${file}`, `// FILE_${i}\n`)
write('work/src/legacy-one.ts', '// LEGACY_ONE\n')
write('work/src/legacy-two.ts', '// LEGACY_TWO\n')
write('work/src/solo.ts', '// SINGLE_FILE\n')
write('api-config.json', { openaiKey: 'sk-fixture-no-network', openaiEnc: false, key: 'sk-fixture-gate-only', enc: false })
write('ui-prefs.json', { 'ui.lang': 'en', 'workspace.mode': 'multi' })
write('profile.json', { nickname: 'Edit files regression' })
write('multi-agent/index.json', { version: 2, order: ['edits'], activeSessionId: 'edits' })
write('multi-agent/edits.json', { id: 'edits', title: 'Edit files', count: 1, panels: [{ title: 'Edit files', cwd: work, api: true,
  picker: { engine: 'codex', codexModel: 'gpt-5.6-terra', model: 'opus', effort: 'medium', mode: 'normal' },
  snapshot: { messages: [{ kind: 'toolgroup', id: 'old-tools', tools: [
    { id: 'legacy-edit', verb: 'Edit', kind: 'edit', target: `src/legacy-one.ts, ${path.join(work, 'src/legacy-two.ts')}`, status: 'done', result: '2 files +2 −1' },
    { id: 'single-read', verb: 'Read', kind: 'read', target: 'src/solo.ts', status: 'done', result: '1 lines' }
  ] }] } }] })
const changes = paths.map((file, i) => ({ path: path.join(work, file), kind: { type: 'update' }, diff: `@@ -1 +1 @@\n-old\n+// FILE_${i}\n` }))
const event = (method, params) => ({ emit: { jsonrpc: '2.0', method, params } })
write('fake.jsonl', [
  { await: 'initialize', result: {} },
  { await: 'thread/start', result: { thread: { id: 'edit-thread' } } },
  { await: 'turn/start', result: { turn: { id: 'edit-turn' } } },
  event('turn/started', { threadId: 'edit-thread', turn: { id: 'edit-turn' } }),
  event('item/started', { threadId: 'edit-thread', item: { type: 'fileChange', id: 'new-edit', changes } }),
  { ...event('item/completed', { threadId: 'edit-thread', item: { type: 'fileChange', id: 'new-edit', status: 'completed', changes } }), afterMs: 120 },
  event('turn/completed', { threadId: 'edit-thread', turn: { id: 'edit-turn', status: 'completed' } })
].map(v => JSON.stringify(v)).join('\n'))
let cdp
const app = spawn(exe, [], { windowsHide: true, stdio: 'ignore', env: { ...process.env, CCG_HOME: home, CCG_NO_NET: '1',
  CCG_CODEX_BIN: path.join(REPO, 'target/release/ccg-fakecodex.exe'), CCG_FAKECODEX_SCRIPT: path.join(home, 'fake.jsonl'),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` } })
try {
  cdp = await connectMainPage(port)
  const evaluate = expr => cdp.eval(`(async()=>(${expr}))()`, { awaitPromise: true })
  const until = async expr => {
    const end = Date.now() + 20000
    while (Date.now() < end) { if (await evaluate(expr)) return; await sleep(100) }
    console.log(await evaluate('document.body.innerText.slice(-2200)'))
    throw new Error(`Timed out: ${expr}`)
  }
  const click = async (selector, index = 0) => {
    // First-run fixture dialogs are outside the feature under test. Dismiss
    // them before dispatching real pointer events, never click through them.
    await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Get started')?.click()`)
    const location = `(()=>{const el=document.querySelectorAll(${JSON.stringify(selector)})[${index}];
      if(!el)return null;
      el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();
      const x=r.x+r.width/2,y=r.y+r.height/2;
      if(!el.contains(document.elementFromPoint(x,y)))return null;
      return {x,y};})()`
    await until(location)
    const point = await evaluate(location)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  }
  const toggle = id => click(`[data-tool-id="${id}"]`)
  const closeViewer = async () => {
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
    await until(`!document.querySelector('.fv-overlay')`)
  }
  await until(`!!document.querySelector('[data-tool-id="legacy-edit"]')`)
  await until(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Later')`)
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Later').click()`)
  assert.equal(await evaluate(`document.querySelector('[data-tool-id="legacy-edit"]').getAttribute('aria-expanded')`), 'false')
  await toggle('legacy-edit')
  assert.equal(await evaluate(`document.querySelectorAll('.t-file').length`), 2)
  for (const [i, marker] of ['LEGACY_ONE', 'LEGACY_TWO'].entries()) {
    await click('.t-file', i)
    await until(`document.body.innerText.includes('// ${marker}')`)
    await closeViewer()
  }
  await toggle('legacy-edit')
  assert.equal(await evaluate(`document.querySelectorAll('.t-file').length`), 0)
  await toggle('single-read')
  await until(`document.body.innerText.includes('// SINGLE_FILE')`)
  await closeViewer()
  await evaluate(`(()=>{const ta=document.querySelector('.ma-panel .composer textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(ta,'Edit two files');
    ta.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.ma-panel .composer .send').click();})()`)
  await until(`!!document.querySelector('[data-tool-id="new-edit"].done')`)
  await toggle('new-edit')
  assert.equal(await evaluate(`document.querySelectorAll('.t-file').length`), 2, 'Comma in a filename must not create a third path')
  for (let i = 0; i < 2; i++) {
    await click('.t-file', i)
    await until(`document.body.innerText.includes('// FILE_${i}')`)
    await closeViewer()
  }
  const labels = await evaluate(`Array.from(document.querySelectorAll('.t-file')).map(b=>b.innerText)`)
  assert(labels.every(label => label.includes('+1') && label.includes('−1')), 'Each file carries its own change counts')
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(home, 'expanded.png'), Buffer.from(shot.data, 'base64'))
  await toggle('new-edit')
  // Existing persistence copies the extra metadata, so reopening the app can
  // still expand the same row without parsing its display string.
  await sleep(800)
  await evaluate(`window.__beforeEditReload = true`)
  await cdp.send('Page.reload')
  await until(`!window.__beforeEditReload && !!document.querySelector('[data-tool-id="new-edit"].done')`)
  await until(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Later')`)
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Later').click()`)
  await toggle('new-edit')
  assert.equal(await evaluate(`document.querySelectorAll('.t-file').length`), 2)
  assert((await evaluate(`document.querySelectorAll('.t-file')[1].innerText`)).includes('with, comma.ts'))
  console.log(JSON.stringify({ passed: true, home, checks: ['legacy logs', 'expand/collapse', 'individual file viewers', 'single-file click', 'Codex multi-file edit', 'comma in path', 'per-file counts', 'reload persistence'] }))
} finally {
  cdp?.close()
  killTree(app.pid)
}
