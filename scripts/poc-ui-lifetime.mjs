// Real sidebar/viewer lifecycle checks with delayed read-only services.
// Requires Vite on 5273 and a debug Tauri executable. Uses an isolated app home.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { connectMainPage, killTree, quietHome, sleep } from '../bench/lib.mjs'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccg-ui-lifecycle-'))
const work = path.join(home, 'work'), port = 19463
const write = (name, value) => {
  const file = path.join(home, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
}
quietHome(home)
write('profile.json', { nickname: 'UI lifecycle check' })
write('ui-prefs.json', { 'ui.lang': 'en', 'workspace.mode': 'multi', 'explorer.swap': true,
  'sidebar.autohide': false, 'whatsnew.seenVersion': fs.readFileSync('Cargo.toml', 'utf8').match(/^version = "([^"]+)"/m)[1] })
write('work/sample.json', { message: 'Read-only viewer sample' })
write('work/preview.html', '<!doctype html><html><body><h1>Local preview</h1></body></html>')
write('multi-agent/index.json', { version: 2, order: ['lifecycle'], activeSessionId: 'lifecycle' })
write('multi-agent/lifecycle.json', { id: 'lifecycle', title: 'Lifecycle', count: 1,
  panelOrder: [0, 1, 2, 3, 4, 5], panels: [{ title: 'Lifecycle', custom: true, cwd: work,
    picker: { engine: 'codex', model: 'opus', mode: 'normal' }, snapshot: { messages: [] } }] })
const exe = path.resolve(process.argv.find(a => a.startsWith('--exe='))?.slice(6) || 'target/debug/agentcodegui.exe')
const app = spawn(exe, [], { windowsHide: true, stdio: 'ignore', env: { ...process.env,
  CCG_HOME: home, CCG_NO_NET: '1', CCG_NO_BOOT_ENGINE_UPDATE: '1', CCG_CDP_PORT: String(port) } })
let c
const ev = code => c.eval('{\n' + code + '\n}', { awaitPromise: true })
const until = async code => {
  const end = Date.now() + 15000
  while (Date.now() < end) { if (await ev(code)) return; await sleep(25) }
  throw new Error('Timeout: ' + code)
}
const toggle = () => ev(`document.querySelector('button[aria-label="File explorer"]').click()`)
const open = async name => {
  if (!await ev('!!document.querySelector(".explorer")')) await toggle()
  await until(`Array.from(document.querySelectorAll('.fxr .n')).some(e => e.textContent === ${JSON.stringify(name)})`)
  await ev(`Array.from(document.querySelectorAll('.fx-file-open')).find(e => e.querySelector('.n')?.textContent === ${JSON.stringify(name)}).click()`)
  await until('!!document.querySelector(".fv-modal")')
  await until(name.endsWith('.html') ? '!!document.querySelector(".fv-modal iframe")' : '!!document.querySelector(".fv-modal .cm-editor")')
}
const close = async () => {
  await ev(`document.querySelector('.fv-modal .dclose[aria-label="Close"]').click()`)
  await until('!document.querySelector(".fv-modal")')
}
const passed = []
const check = (name, value) => { assert(value, name); passed.push(name); console.log('PASS ' + name) }
try {
  c = await connectMainPage(port)
  await c.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await until('!!document.querySelector(".ma-grid")')
  await ev(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Get started')?.click()`)
  await sleep(200)
  await ev(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Later')?.click()`)
  await sleep(1500)
  await ev(`window.__life = { status: 0, tokens: 0 };window.__status = window.api.lsp.status;window.__tokens = window.api.lsp.semanticTokens;
    window.api.lsp.status = async () => { window.__life.status++; return 'starting' }`)
  await open('sample.json')
  await until('window.__life.status > 1')
  await close()
  const statusAtClose = await ev('window.__life.status')
  await sleep(600)
  check('Closing a warming viewer cancels pending status retries', await ev('window.__life.status') === statusAtClose)

  await ev(`window.api.lsp.status = async () => 'ready';window.api.lsp.semanticTokens = async () => { window.__life.tokens++;return { data: [], types: [], mods: [], pending: true } }`)
  await open('sample.json')
  await until('window.__life.tokens > 0')
  await close()
  const tokensAtClose = await ev('window.__life.tokens')
  await sleep(1000)
  check('Closing a viewer cancels pending semantic-token retries', await ev('window.__life.tokens') === tokensAtClose)
  await ev('window.api.lsp.status = window.__status;window.api.lsp.semanticTokens = window.__tokens')

  await ev(`window.__fetch = window.fetch;window.__head = { calls: 0, active: 0, peak: 0, aborted: 0, release: [] };
    window.fetch = (url, options) => {
      if (options?.method !== 'HEAD') return window.__fetch(url, options);
      const h=window.__head;h.calls++;h.active++;h.peak=Math.max(h.peak,h.active);
      return new Promise((resolve,reject) => {let done=false;
        const finish=(aborted) => {if(done)return;done=true;h.active--;if(aborted){h.aborted++;reject(new DOMException('Aborted','AbortError'))}else resolve(new Response(null,{status:200}))};
        h.release.push(() => finish(false));options.signal?.addEventListener('abort',()=>finish(true),{once:true});
      });
    }`)
  await open('preview.html')
  await until('window.__head.calls === 1')
  await sleep(1700)
  check('A slow preview check never overlaps another check', await ev('window.__head.calls === 1 && window.__head.peak === 1'))
  await close()
  await until('window.__head.active === 0')
  check('Closing HTML aborts the pending preview request', await ev('window.__head.aborted === 1'))
  await ev('window.fetch = window.__fetch;window.__head.release.forEach(f=>f())')

  await ev(`window.__repos = window.api.git.repos;window.__gitStatus = window.api.git.status;window.__git = { repos: 0, status: 0 };
    window.api.git.repos = async () => {window.__git.repos++;await new Promise(r=>setTimeout(r,1000));return [{root:${JSON.stringify(work)},rel:''}]};
    window.api.git.status = async () => {window.__git.status++;return {repo:true,branch:'sample',files:[]}};`)
  for (let i = 0; i < 10; i++) { await toggle(); await sleep(35) }
  if (await ev('!!document.querySelector(".explorer")')) await toggle()
  await sleep(1200)
  check('Rapid sidebar switches share one pending repository scan', await ev('window.__git.repos === 1'))
  check('Retired explorers never start follow-up Git status jobs', await ev('window.__git.status === 0'))
  await toggle()
  await until('window.__git.status === 1')
  check('Reopening after completion requests fresh repository data', await ev('window.__git.repos === 2'))
  await ev('window.api.git.repos = window.__repos;window.api.git.status = window.__gitStatus')

  await open('sample.json'); await close(); await sleep(500)
  await c.send('HeapProfiler.collectGarbage')
  const before = await c.send('Memory.getDOMCounters')
  const timings = []
  for (let i = 0; i < 24; i++) {
    await ev('window.__openAt = performance.now()')
    await open(i % 2 ? 'preview.html' : 'sample.json')
    timings.push(await ev('performance.now() - window.__openAt'))
    await close()
  }
  await sleep(1800)
  await c.send('HeapProfiler.collectGarbage')
  const after = await c.send('Memory.getDOMCounters')
  check('Repeated viewer opens keep DOM listeners and documents bounded', after.jsEventListeners <= before.jsEventListeners + 16 && after.documents <= before.documents + 1)
  const result = { passed, before, after, timings, artifacts: home }
  fs.writeFileSync(path.join(home, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
} finally { c?.close(); killTree(app.pid) }
