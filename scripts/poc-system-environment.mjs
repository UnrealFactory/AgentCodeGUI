// Settings UI -> restart -> both real driver protocols with no app accounts.
// Start npm run app:dev; build agentcodegui and ccg-engine's fakecli binaries first.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { connectMainPage, killTree, quietHome, REPO, sleep } from '../bench/lib.mjs'

const home = fs.mkdtempSync(path.join(REPO, '.poc-home-system-environment-'))
const work = path.join(home, 'work')
const port = 19392
const exe = path.join(REPO, 'target/debug/agentcodegui.exe')
const write = (name, data) => {
  const p = path.join(home, name)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data))
  return p
}
quietHome(home)
fs.mkdirSync(work)
write('ui-prefs.json', { 'ui.lang': 'en', 'workspace.mode': 'multi', 'sidebar.autohide': false })
write('profile.json', { nickname: 'System environment test' })
const native = Object.fromEntries(['claude', 'codex'].map(engine => {
  const configDir = path.join(home, `existing ${engine} config`)
  fs.mkdirSync(configDir)
  fs.writeFileSync(path.join(configDir, engine === 'claude' ? '.credentials.json' : 'auth.json'), 'existing-login-sentinel')
  return [engine, { mode: 'system', cliPath: path.join(home, `company ${engine}.cmd`), configDir }]
}))
const recorder = write('record.cjs', `const fs=require('node:fs'),path=require('node:path');
  const engine=process.argv[2]; const keys=['CLAUDE_CONFIG_DIR','CODEX_HOME','HTTPS_PROXY','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE','NODE_OPTIONS','ANTHROPIC_API_KEY'];
  fs.writeFileSync(path.join(__dirname,engine+'-environment.json'),JSON.stringify(Object.fromEntries(keys.map(k=>[k,process.env[k]]))));`)
for (const engine of ['claude', 'codex']) {
  const fake = path.join(REPO, engine === 'claude' ? 'target/debug/ccg-fakecli.exe' : 'target/debug/ccg-fakecodex.exe')
  assert(fs.existsSync(fake), `${fake} must be built first`)
  fs.writeFileSync(native[engine].cliPath, `@echo off\r\n"${process.execPath}" "${recorder}" ${engine}\r\n"${fake}" %*\r\n`)
}
const detectedBin = path.join(home, 'detected CLI')
const detectedCodexConfig = path.join(home, 'detected codex config')
fs.mkdirSync(detectedBin)
for (const engine of ['claude', 'codex']) fs.copyFileSync(native[engine].cliPath, path.join(detectedBin, `${engine}.cmd`))
write('multi-agent/index.json', { version: 2, order: ['system-test'], activeSessionId: 'system-test' })
write('multi-agent/system-test.json', { id: 'system-test', title: 'System test', count: 2,
  panels: ['claude', 'codex'].map(engine => ({ title: engine, cwd: work,
    picker: { engine, codexModel: 'gpt-5.6-terra', model: 'opus', effort: 'medium', mode: 'normal' }, snapshot: { messages: [] } })) })
const claudeScript = write('claude.jsonl', [
  { afterMs: 150, emit: { type: 'control_response', response: { subtype: 'success', request_id: 'init-1', response: {} } } },
  { emit: { type: 'system', subtype: 'init', session_id: 'native-claude-thread', cwd: work, model: 'opus', tools: [], apiKeySource: 'none' } },
  { afterMs: 200, emit: { type: 'assistant', session_id: 'native-claude-thread', message: { id: 'native-answer', role: 'assistant', content: [{ type: 'text', text: 'CLAUDE_SYSTEM_OK' }] } } },
  { emit: { type: 'result', subtype: 'success', session_id: 'native-claude-thread', result: 'CLAUDE_SYSTEM_OK', is_error: false, total_cost_usd: 0, duration_ms: 1, num_turns: 1 } }
].map(v => JSON.stringify(v)).join('\n'))
const event = (method, params) => ({ emit: { jsonrpc: '2.0', method, params } })
const codexScript = write('codex.jsonl', [
  { await: 'initialize', result: {} },
  { await: 'thread/start', result: { thread: { id: 'native-codex-thread' } } },
  { await: 'turn/start', result: { turn: { id: 'native-turn' } } },
  event('turn/started', { threadId: 'native-codex-thread', turn: { id: 'native-turn' } }),
  event('item/agentMessage/delta', { threadId: 'native-codex-thread', itemId: 'answer', delta: 'CODEX_SYSTEM_OK' }),
  event('item/completed', { threadId: 'native-codex-thread', item: { type: 'agentMessage', id: 'answer', text: 'CODEX_SYSTEM_OK' } }),
  event('turn/completed', { threadId: 'native-codex-thread', turn: { id: 'native-turn', status: 'completed' } })
].map(v => JSON.stringify(v)).join('\n'))
const certificate = write('company-ca.pem', '')
const env = { ...process.env, CCG_HOME: home, CCG_NO_NET: '1',
  PATH: detectedBin + path.delimiter + (process.env.PATH || process.env.Path || ''),
  CLAUDE_CONFIG_DIR: native.claude.configDir, CODEX_HOME: detectedCodexConfig,
  CCG_FAKECLI_SCRIPT: claudeScript, CCG_FAKECODEX_SCRIPT: codexScript,
  CCG_FAKECLI_IN: path.join(home, 'claude-input.jsonl'), CCG_FAKECODEX_IN: path.join(home, 'codex-input.jsonl'),
  HTTPS_PROXY: 'http://fixture-proxy.invalid:3128', NODE_EXTRA_CA_CERTS: certificate, SSL_CERT_FILE: certificate,
  NODE_OPTIONS: '--no-warnings', ANTHROPIC_API_KEY: 'fixture-system-key', OPENAI_API_KEY: '',
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }
let app, cdp
const evaluate = expr => cdp.eval(`(async()=>(${expr}))()`, { awaitPromise: true })
const until = async expr => {
  const end = Date.now() + 20000
  while (Date.now() < end) { if (await evaluate(expr)) return; await sleep(100) }
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(home, 'failure.png'), Buffer.from(shot.data, 'base64'))
  console.log('Failure screenshot:', path.join(home, 'failure.png'))
  console.log(await evaluate(`(()=>{const el=document.querySelector('.sb-foot'),r=el?.getBoundingClientRect();return {rect:r?.toJSON(),width:innerWidth,height:innerHeight,hit:r&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML.slice(0,200)};})()`))
  throw new Error(`Timed out: ${expr}\n${await evaluate('document.body.innerText.slice(-2400)')}`)
}
const ipc = (channel, value = []) => evaluate(`window.__TAURI_INTERNALS__.invoke('ipc_call',{channel:${JSON.stringify(channel)},payload:${JSON.stringify(value)}})`)
const click = async expression => {
  const location = `(()=>{const el=${expression};if(!el)return null;el.scrollIntoView({block:'center'});
    const r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return el.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`
  await until(location)
  const point = await evaluate(location)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
}
const fill = (selector, value) => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`)
const stop = async () => { cdp?.close(); cdp = undefined; if (app) killTree(app.pid); app = undefined; await sleep(400) }
const start = async () => {
  app = spawn(exe, [], { env, windowsHide: true, stdio: 'ignore' })
  cdp = await connectMainPage(port)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await until(`document.querySelectorAll('.ma-panel').length===2`)
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Get started')?.click()`)
  if ((await ipc('engine-environment:get')).claude.activeMode === 'managed') {
    await until(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Later')`)
  }
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Later')?.click()`)
}
const settings = async () => {
  await click(`document.querySelector('.sb-foot')`)
  await until(`!!document.querySelector('.set-modal')`)
  await click(`Array.from(document.querySelectorAll('.set-ni')).find(b=>b.textContent.trim()==='Engine')`)
  await until(`document.querySelectorAll('.engine-environment').length===2`)
}
try {
  await start()
  await settings()
  for (const engine of ['claude', 'codex']) {
    const card = `.engine-environment[data-engine="${engine}"]`
    const cliField = card + ' input[aria-label="CLI executable"]'
    const configField = card + ' input[aria-label="Configuration folder"]'
    assert(!await evaluate(`!!document.querySelector(${JSON.stringify(card + ' .engine-environment-actions')})`), 'unchanged cards have no Save button')
    await click(`document.querySelectorAll(${JSON.stringify(card + ' [role=radio]')})[1]`)
    await fill(cliField, native[engine].cliPath)
    await fill(configField, native[engine].configDir)
    await click(`document.querySelector(${JSON.stringify(card + ' .engine-environment-detect')})`)
    if (engine === 'codex') {
      await until(`document.querySelector(${JSON.stringify(card + ' [role=alert]')})?.textContent.includes('Configuration folder not found')`)
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(cliField)}).value`), native[engine].cliPath)
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(configField)}).value`), native[engine].configDir, 'failed detection keeps manual edits')
      fs.mkdirSync(detectedCodexConfig)
      await click(`document.querySelector(${JSON.stringify(card + ' .engine-environment-detect')})`)
    }
    await until(`document.querySelector(${JSON.stringify(card + ' [role=status]')})?.textContent.includes('Detected CLI and configuration paths filled in.')`)
    const detection = (await ipc('engine-environment:get'))[engine]
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(cliField)}).value`), detection.detectedCliPath)
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(configField)}).value`), detection.detectedConfigDir)
    assert.equal(detection.mode, 'managed', 'detection only fills the draft')
    assert.equal(detection.restartRequired, false, 'another engine saving does not mark this engine as pending restart')
    assert((await evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(cliField)})).fontFamily`)).includes('JetBrains Mono'))
    await click(`document.querySelector(${JSON.stringify(card + ' .engine-environment-cancel')})`)
    await until(`!document.querySelector(${JSON.stringify(card + ' .engine-environment-actions')})`)
    assert(!await evaluate(`!!document.querySelector(${JSON.stringify(card + ' [role=status]')})`), 'cancel clears detection feedback')
    await click(`document.querySelectorAll(${JSON.stringify(card + ' [role=radio]')})[1]`)
    await fill(card + ' input[aria-label="CLI executable"]', path.join(home, 'missing.exe'))
    await fill(card + ' input[aria-label="Configuration folder"]', native[engine].configDir)
    await click(`Array.from(document.querySelectorAll(${JSON.stringify(card + ' button')})).find(b=>b.textContent==='Save')`)
    await until(`!!document.querySelector(${JSON.stringify(card + ' [role=alert]')})`)
    assert.equal((await ipc('engine-environment:get'))[engine].mode, 'managed')
    await fill(card + ' input[aria-label="CLI executable"]', native[engine].cliPath)
    await click(`Array.from(document.querySelectorAll(${JSON.stringify(card + ' button')})).find(b=>b.textContent==='Save')`)
    await until(`!!document.querySelector(${JSON.stringify(card + ' [role=status]')})`)
    const state = await ipc('engine-environment:get')
    assert.equal(state[engine].mode, 'system')
    assert.equal(state[engine].activeMode, 'managed', 'existing runtime stays in its original environment')
    assert.equal(state.restartRequired, true)
    await until(`!document.querySelector(${JSON.stringify(card + ' .engine-environment-actions')})`)
  }
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(home, 'settings.png'), Buffer.from(shot.data, 'base64'))
  console.log('PASS detection fills paths, failure keeps edits, cancel, conditional Save, path font, engine independence, restart boundary')
  await stop()
  await start()
  const activated = await ipc('engine-environment:get')
  assert.equal(activated.restartRequired, false)
  for (const [index, engine] of ['claude', 'codex'].entries()) {
    assert.equal(activated[engine].activeMode, 'system')
    await evaluate(`(()=>{const panel=document.querySelectorAll('.ma-panel')[${index}],ta=panel.querySelector('.composer textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(ta,'Test system configuration');
      ta.dispatchEvent(new Event('input',{bubbles:true}));})()`)
    await click(`document.querySelectorAll('.ma-panel')[${index}].querySelector('.composer .send')`)
    await until(`document.querySelectorAll('.ma-panel')[${index}].textContent.includes('${engine.toUpperCase()}_SYSTEM_OK')`)
    const recorded = JSON.parse(fs.readFileSync(path.join(home, engine + '-environment.json'), 'utf8'))
    assert.equal(recorded[engine === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'], native[engine].configDir)
    for (const key of ['HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'NODE_OPTIONS', 'ANTHROPIC_API_KEY']) assert.equal(recorded[key], env[key], key)
    assert.equal(fs.readFileSync(path.join(native[engine].configDir, engine === 'claude' ? '.credentials.json' : 'auth.json'), 'utf8'), 'existing-login-sentinel')
    await click(`document.querySelectorAll('.ma-panel')[${index}].querySelector('.model-chip')`)
    assert(!await evaluate(`document.querySelector('.picker-pop').textContent.includes('Switch account')`))
    assert(await evaluate(`document.querySelector('.picker-pop').textContent.includes('Login and billing follow your system CLI configuration.')`))
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
    console.log(`PASS ${engine}: selected .cmd, existing home, inherited network/auth environment, no app account required`)
  }
  assert(!fs.existsSync(path.join(home, 'engines')), 'system engines are not auto-installed')
  assert(!fs.existsSync(path.join(home, 'codex-engines')), 'system engines are not auto-installed')
  const alternate = path.join(home, 'different claude configuration')
  fs.mkdirSync(alternate)
  const switched = await ipc('engine-environment:save', [{ engine: 'claude', environment: { ...native.claude, configDir: alternate } }])
  assert.equal(switched.restartRequired, true)
  const previousSpawn = fs.statSync(path.join(home, 'claude-environment.json')).mtimeMs
  // The UI commits after 600 ms, then schedules a disk save after another 700 ms.
  // Wait for the persisted session IDs instead of killing the app between those steps.
  await until(`(await window.api.multi.loadSession('system-test'))?.panels?.[0]?.snapshot?.session?.sessionId === 'native-claude-thread' && (await window.api.multi.loadSession('system-test'))?.panels?.[1]?.snapshot?.session?.sessionId === 'native-codex-thread'`)
  await stop()
  await start()
  await evaluate(`(()=>{const ta=document.querySelector('.ma-panel .composer textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(ta,'Continue the previous conversation');
    ta.dispatchEvent(new Event('input',{bubbles:true}));})()`)
  await click(`document.querySelector('.ma-panel .composer .send')`)
  await until(`document.querySelector('.ma-panel').textContent.includes('The execution environment changed.')`)
  assert.equal(fs.statSync(path.join(home, 'claude-environment.json')).mtimeMs, previousSpawn, 'a mismatched resume must not spawn a CLI')
  console.log('PASS changed configuration cannot resume a conversation in another authentication home')
  console.log(JSON.stringify({ ok: true, home }))
} finally { await stop() }
