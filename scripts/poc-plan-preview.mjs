// Real permission frames -> Markdown preview -> explicit approval/denial on stdin.
// Requires the Vite dev server and built agentcodegui / ccg-fakecli binaries.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { REPO, quietHome, connectMainPage, sleep, killTree } from '../bench/lib.mjs'

const home = fs.mkdtempSync(path.join(REPO, '.poc-home-plan-preview-'))
const work = path.join(home, 'work')
const config = path.join(home, 'existing CLI config')
const planFile = path.join(work, 'custom plans', '최종 계획.md')
const inputLog = path.join(home, 'stdin.jsonl')
const port = 19395
quietHome(home)
fs.mkdirSync(path.dirname(planFile), { recursive: true })
fs.mkdirSync(config)
const write = (name, data) => {
  const file = path.join(home, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data))
  return file
}
const planText = '# 최종 계획 · FINAL_PLAN\n\n## 구현 단계\n\n1. Read the current settings.\n2. Add **approval preview**.\n\n| Step | Result |\n| --- | --- |\n| Review | Ready |\n\n```ts\nconst reviewed = true\n```\n\n' + 'Details to review before proceeding.\n\n'.repeat(50)
fs.writeFileSync(planFile, planText)
write('ui-prefs.json', { 'ui.lang': 'en', 'workspace.mode': 'multi', 'sidebar.autohide': false })
write('engine-environments.json', { claude: { mode: 'system', cliPath: path.join(REPO, 'target/debug/ccg-fakecli.exe'), configDir: config } })
write('multi-agent/index.json', { version: 2, order: ['plans'], activeSessionId: 'plans' })
write('multi-agent/plans.json', { id: 'plans', title: 'Plan preview test', count: 2,
  panels: [0, 1].map(i => ({ title: `Plan ${i + 1}`, cwd: work, picker: { engine: 'claude', model: 'opus', mode: 'plan' }, snapshot: { messages: [] } })) })
const requests = [
  { id: 'file-plan', tool: 'ExitPlanMode', input: { planFilePath: 'custom plans/최종 계획.md', plan: 'STALE_INLINE_DRAFT', allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }] } },
  { id: 'inline-plan', tool: 'ExitPlanMode', input: { plan: '# INLINE_PLAN\n\n- Keep the existing approval flow.\n- Render **Markdown**.' } },
  { id: 'missing-plan', tool: 'ExitPlanMode', input: { planFilePath: 'custom plans/missing.md' } },
  { id: 'empty-plan', tool: 'ExitPlanMode', input: {} },
  { id: 'ordinary', tool: 'Bash', input: { command: 'echo regular-permission' } }
]
const script = write('script.jsonl', [
  { afterMs: 100, emit: { type: 'control_response', response: { subtype: 'success', request_id: 'init-1', response: {} } } },
  { emit: { type: 'system', subtype: 'init', session_id: 'plan-thread', cwd: work, model: 'opus', tools: [], apiKeySource: 'none' } },
  ...requests.flatMap(r => [
    { emit: { type: 'control_request', request_id: r.id, request: { subtype: 'can_use_tool', tool_name: r.tool, tool_use_id: r.id + '-tool', input: r.input } } },
    { awaitResponse: r.id }
  ]),
  { emit: { type: 'result', subtype: 'success', session_id: 'plan-thread', result: 'PLAN_REVIEW_DONE', is_error: false, num_turns: 1, duration_ms: 1, total_cost_usd: 0 } }
].map(x => JSON.stringify(x)).join('\n'))
const app = spawn(path.join(REPO, 'target/debug/agentcodegui.exe'), [], { windowsHide: true, stdio: 'ignore', env: {
  ...process.env, CCG_HOME: home, CCG_NO_NET: '1', CCG_FAKECLI_SCRIPT: script, CCG_FAKECLI_IN: inputLog,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`
} })
let cdp
const evaluate = expr => cdp.eval(`(async()=>(${expr}))()`, { awaitPromise: true })
const until = async expr => {
  const end = Date.now() + 20000
  while (Date.now() < end) { if (await evaluate(expr)) return; await sleep(100) }
  throw new Error(`Timed out: ${expr}\n${await evaluate('document.body.innerText.slice(-1800)')}`)
}
const click = async selector => {
  await until(`!!document.querySelector(${JSON.stringify(selector)})`)
  const p = await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', clickCount: 1 })
}
const responses = () => fs.existsSync(inputLog) ? fs.readFileSync(inputLog, 'utf8').trim().split('\n').filter(Boolean).map(x => JSON.parse(x)).filter(x => x.type === 'control_response') : []
try {
  cdp = await connectMainPage(port)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false })
  await until(`document.querySelectorAll('.ma-panel').length===2`)
  assert(await evaluate(`(async()=>{
    const {reducer,initialSessionState}=await import('/src/store/session.ts');
    const pending={...initialSessionState,pendingPermission:{requestId:'first',toolName:'ExitPlanMode',summary:''}};
    const action={type:'answer-permission',requestId:'first',behavior:'allow'};
    const answered=reducer(pending,action);
    const next={...answered,pendingPermission:{requestId:'second',toolName:'ExitPlanMode',summary:''}};
    return reducer(answered,action)===answered && reducer(next,action)===next;
  })()`), 'duplicate or stale answers cannot add records or dismiss a newer request')
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Get started')?.click()`)
  await evaluate(`(()=>{const el=document.querySelector('.ma-panel .composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'Make a plan');el.dispatchEvent(new Event('input',{bubbles:true}));})()`)
  await click('.ma-panel .composer .send')
  await until(`document.querySelector('.plan-approval-body')?.textContent.includes('FINAL_PLAN')`)
  assert(!await evaluate(`document.querySelector('.plan-approval-body').textContent.includes('STALE_INLINE_DRAFT')`))
  assert.equal(await evaluate(`document.querySelectorAll('.plan-approval-body .md-table').length`), 1)
  assert.equal(await evaluate(`document.querySelectorAll('.plan-approval-body .codeblock').length`), 1)
  assert(!await evaluate(`!!document.querySelectorAll('.ma-panel')[1].querySelector('.q-overlay')`), 'approval belongs to one panel')
  assert(await evaluate(`(()=>{const body=document.querySelector('.plan-approval-body'),card=document.querySelector('.plan-approval').getBoundingClientRect(),btn=document.querySelector('.plan-approval-actions .go').getBoundingClientRect();return body.scrollHeight>body.clientHeight && btn.bottom<=card.bottom})()`), 'long plans scroll while approval stays visible')
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: '1', code: 'Digit1', windowsVirtualKeyCode: 49 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: '1', code: 'Digit1', windowsVirtualKeyCode: 49 })
  await sleep(150)
  assert.equal(responses().length, 0, 'reading a numbered plan must not approve it')
  fs.appendFileSync(planFile, '\n## RELOADED_PLAN\n\nFinal addition.\n')
  await click('.plan-approval button[aria-label="Reload plan"]')
  await until(`document.querySelector('.plan-approval-body')?.textContent.includes('RELOADED_PLAN')`)
  assert.equal(responses().length, 0, 'reading or reloading never grants permission')
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(home, 'preview.png'), Buffer.from(shot.data, 'base64'))
  await click('.plan-approval-actions .go')
  await until(`document.querySelector('.plan-approval-body')?.textContent.includes('INLINE_PLAN')`)
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.ma-panel:first-child .qa .qa2')].map(el=>el.textContent)`), ['Plan approved.'])
  assert.equal(responses().find(x => x.response.request_id === 'file-plan')?.response.response.behavior, 'allow')
  assert.deepEqual(responses().find(x => x.response.request_id === 'file-plan')?.response.response, { behavior: 'allow', toolUseID: 'file-plan-tool' }, 'preview keeps the existing one-time permission response')
  await click('.plan-approval-actions button:first-child')
  await until(`document.querySelector('.plan-approval-error')?.textContent.includes('Could not read the plan file.')`)
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.ma-panel:first-child .qa .qa2')].map(el=>el.textContent)`), ['Plan approved.', 'Plan declined.'])
  assert.equal(responses().find(x => x.response.request_id === 'inline-plan')?.response.response.behavior, 'deny')
  assert(!await evaluate(`document.querySelector('.plan-approval-body').textContent.includes('INLINE_PLAN')`), 'failed read does not reuse a previous plan')
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await until(`document.querySelector('.plan-approval-body')?.textContent.includes('The CLI did not provide plan content or a file path.')`)
  await click('.plan-approval-actions button:first-child')
  await until(`document.querySelector('.qsum')?.textContent.includes('regular-permission')`)
  assert.equal(await evaluate(`document.querySelectorAll('.qopts .qopt').length`), 3)
  await click('.qopt-deny')
  await until(`!document.querySelector('.q-overlay')`)
  assert.equal(responses().length, requests.length)
  const expectedAnswers = ['Plan approved.', 'Plan declined.', 'Plan declined.', 'Plan declined.']
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.ma-panel:first-child .qa .qa2')].map(el=>el.textContent)`), expectedAnswers, 'each plan decision leaves one chat record; ordinary permissions do not')
  assert.equal(await evaluate(`document.querySelectorAll('.ma-panel:first-child .qa .qa-tm').length`), 4, 'decisions include their time')
  assert.equal(await evaluate(`document.querySelectorAll('.ma-panel')[1].querySelectorAll('.qa').length`), 0, 'records stay in the responding session')
  await until(`(await window.api.multi.loadSession('plans'))?.panels?.[0]?.snapshot?.messages?.filter(m=>m.kind==='qa').length===4`)
  const diskDeadline = Date.now() + 10000
  while (Date.now() < diskDeadline) {
    const saved = JSON.parse(fs.readFileSync(path.join(home, 'chats-v3/ma-plans-0.json'), 'utf8'))
    if (saved.snapshot.messages.filter(m => m.kind === 'qa').length === 4) break
    await sleep(100)
  }
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'chats-v3/ma-plans-0.json'), 'utf8'))
  assert.deepEqual(saved.snapshot.messages.filter(m => m.kind === 'qa').flatMap(m => m.pairs.flatMap(p => p.a)), expectedAnswers, 'decisions persist to disk')
  await evaluate(`window.__planReloadMarker=true`)
  await cdp.send('Page.reload')
  await until(`!window.__planReloadMarker && document.querySelectorAll('.ma-panel:first-child .qa').length===4`)
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.ma-panel:first-child .qa .qa2')].map(el=>el.textContent)`), expectedAnswers, 'decisions restore when reopening the chat')
  assert(!await evaluate(`!!document.querySelector('.q-overlay')`))
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Get started')?.click()`)
  await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`)
  const recordsShot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(home, 'decisions.png'), Buffer.from(recordsShot.data, 'base64'))
  console.log('PASS file/inline plans, Markdown, refresh, scroll, panel scope, approval/denial/Esc chat records, persistence and restore, duplicate/stale answers, missing-plan feedback, ordinary permissions')
  console.log(JSON.stringify({ ok: true, home }))
} catch (e) {
  if (cdp) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null)
    if (shot) fs.writeFileSync(path.join(home, 'failure.png'), Buffer.from(shot.data, 'base64'))
  }
  console.log('Artifacts:', home)
  throw e
} finally { cdp?.close(); killTree(app.pid) }
