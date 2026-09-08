// Actual chat components + reducer in an isolated browser, with synthetic events.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { Cdp, cdpTargets, killTree, sleep } from '../bench/lib.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const code = `
import React, { useReducer } from 'react';
import { createRoot } from 'react-dom/client';
import { reducer, initialSessionState } from '/src/store/session.ts';
import { MessageView, WorkingIndicator } from '/src/components/Chat.tsx';
import '/src/styles.css';
const h = React.createElement;
function Preview() {
  const [state, dispatch] = useReducer(reducer, initialSessionState);
  window.__event = event => dispatch({type:'engine', event:{runId:'ui-run', ...event}});
  window.__begin = () => { dispatch({type:'begin', text:'연결 복구 후 코드 작업을 이어가 주세요.', time:'오전 11:10', command:null}); window.__event({type:'status', status:'analyzing'}); };
  window.__state = state;
  return h('main', {style:{maxWidth:820, margin:'24px auto', padding:20, width:'100%', boxSizing:'border-box'}},
    state.messages.map(item => h(MessageView, {key:item.id, item, cwd:'C:/Preview', engine:'codex'})),
    ['analyzing','working'].includes(state.status) && !state.streaming && h(WorkingIndicator, {elapsed:64, retry:state.apiRetry, connectionRetry:state.connectionRetry})
  );
}
createRoot(document.getElementById('root')).render(h(Preview));
`
const virtualId = '\0diagnostics-preview'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccg-diagnostics-ui-'))
const server = await createServer({
  configFile: path.join(root, 'app/vite.config.ts'),
  server: { host: '127.0.0.1', port: 0, strictPort: false },
  plugins: [{
    name: 'diagnostics-preview',
    resolveId(id) { if (id === 'virtual:diagnostics-preview') return virtualId },
    load(id) { if (id === virtualId) return code },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== '/diagnostics-preview') return next()
        res.setHeader('Content-Type', 'text/html')
        res.end(await server.transformIndexHtml('/diagnostics-preview', '<!doctype html><html lang="ko"><meta charset="utf-8"><body style="background:#101010"><div id="root"></div><script type="module">import "virtual:diagnostics-preview";</script></body></html>'))
      })
    }
  }]
})
let browser
let cdp
const until = async (check) => {
  for (let n = 0; n < 150; n++) { const value = await check(); if (value) return value; await sleep(100) }
  throw new Error('UI timeout')
}
try {
  await server.listen()
  const url = server.resolvedUrls.local[0] + 'diagnostics-preview'
  const profile = path.join(dir, 'profile')
  browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
    '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + profile, '--remote-debugging-port=0', '--window-size=1050,700', url
  ], { windowsHide: true, stdio: 'ignore' })
  await until(() => fs.existsSync(path.join(profile, 'DevToolsActivePort')))
  const port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0])
  const target = await until(async () => (await cdpTargets(port)).find(t => t.type === 'page' && t.url.includes('diagnostics-preview')))
  cdp = await Cdp.connect(target.webSocketDebuggerUrl)
  await until(() => cdp.eval('!!window.__begin'))
  await cdp.eval('window.__begin()')
  await until(() => cdp.eval("window.__state.status === 'analyzing'"))
  await cdp.eval(`for(let n=2;n<=5;n++) window.__event({type:'notice', text:'Codex: Reconnecting... '+n+'/5 — 다시 시도하는 중이에요.'});`)
  await until(() => cdp.eval("document.querySelector('.working-time')?.textContent.includes('5/5')"))
  assert.equal(await cdp.eval("document.querySelectorAll('.diagnostic-notice').length"), 1)
  assert.equal(await cdp.eval("document.querySelector('.diagnostic-notice').open"), false)
  assert.equal(await cdp.eval("!!document.querySelector('.diagnostic-entry')"), false, 'collapsed logs are rendered on demand')
  await cdp.eval("window.__event({type:'notice', text:'Codex: Falling back from WebSockets to HTTPS transport. stream disconnected before completion: websocket closed by server before response completed.'})")
  await until(() => cdp.eval("document.querySelector('.working-label')?.textContent.includes('HTTPS')"))
  const screenshot = async (name) => {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(dir, name), Buffer.from(shot.data, 'base64'))
  }
  await screenshot('retry.png')
  await cdp.eval("window.__event({type:'assistant-done', messageId:'reply', text:'연결이 복구되어 코드 검토를 이어갑니다.'}); for(let n=0;n<5;n++)window.__event({type:'notice', text:'[stderr] diagnostic trace from CLI'});")
  await until(() => cdp.eval("document.querySelector('.diagnostic-status')?.textContent === '작업 재개됨'"))
  assert.equal(await cdp.eval("!!document.querySelector('.working-label.retry')"), false)
  assert.equal(await cdp.eval("document.querySelectorAll('.diagnostic-notice').length"), 2)
  await cdp.eval("document.querySelector('.diagnostic-notice summary').click()")
  await until(() => cdp.eval("document.querySelectorAll('.diagnostic-entry').length === 5"))
  assert.equal(await cdp.eval("document.querySelector('.diagnostic-entries').innerText.includes('Reconnecting... 2/5')"), true)
  await cdp.eval("document.querySelectorAll('.diagnostic-notice summary')[1].click()")
  await until(() => cdp.eval("document.querySelectorAll('.diagnostic-notice')[1].innerText.includes('×5')"))
  await screenshot('resumed-expanded.png')
  await cdp.eval("document.querySelectorAll('.diagnostic-notice summary').forEach(e => e.click())")
  await until(() => cdp.eval("!document.querySelector('.diagnostic-entry')"))
  await screenshot('resumed.png')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 740, deviceScaleFactor: 1, mobile: false })
  await cdp.eval("document.querySelector('.diagnostic-notice summary').click()")
  await until(() => cdp.eval("!!document.querySelector('.diagnostic-entry')"))
  assert.equal(await cdp.eval("document.documentElement.scrollWidth <= 360"), true, 'long error text wraps on narrow panels')
  await cdp.eval("window.__event({type:'notice', text:'Codex: Reconnecting... 1/5 — 다시 시도하는 중이에요.'})")
  await until(() => cdp.eval("!!document.querySelector('.working-label.retry')"))
  await cdp.eval("window.__event({type:'error', message:'Connection failed permanently'})")
  await until(() => cdp.eval("!document.querySelector('.working-label.retry')"))
  await cdp.eval("window.__event({type:'status', status:'error'})")
  await until(() => cdp.eval("!document.querySelector('.working-line')"))
  assert.equal(await cdp.eval("document.querySelector('.diagnostic-status').textContent"), '지난 기록')
  assert.equal(await cdp.eval("document.body.innerText.includes('Connection failed permanently')"), true)
  console.log('Diagnostics UI: collapsed records, latest retry, recovery, raw log expansion, repeat counts, narrow layout and fatal errors passed.')
  console.log(dir)
} finally {
  if (cdp) await cdp.send('Browser.close', {}, { timeoutMs: 1500 }).catch(() => {})
  cdp?.close()
  if (browser?.pid) killTree(browser.pid)
  await server.close()
}
