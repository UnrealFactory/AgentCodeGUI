import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { Cdp, cdpTargets, killTree, sleep } from '../bench/lib.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixture = path.join(root, 'scripts/fixtures/blazor')
const files = Object.fromEntries(fs.readdirSync(fixture).map((name) => [name, fs.readFileSync(path.join(fixture, name), 'utf8')]))
const code = [
  "import React, { useState } from 'react'; import { createRoot } from 'react-dom/client';",
  "import { Explorer } from '/src/components/Explorer.tsx';",
  "import { CmEditor } from '/src/components/CmEditor.tsx';",
  "import { langForPath } from '/src/components/fileType.tsx';",
  "import '/src/styles.css';",
  'const files = ' + JSON.stringify(files) + ';',
  'window.__dirReads = [];',
  "window.api = { listDir: async (_, rel) => { window.__dirReads.push(rel); return Object.keys(files).sort().map(name => ({ name, dir: false })); }, listFiles: async () => Object.keys(files), lsp: { verseDigests: async () => [], verseExcludes: async () => [] } };",
  "const h = React.createElement;",
  "function Preview() {",
  " const [file, setFile] = useState('Counter.razor'); const [epoch, setEpoch] = useState(0);",
  " window.__remount = () => setEpoch(n => n + 1);",
  " window.__pick = path => { window.__opened = path; setFile(path); };",
  " return h('div', { style: { display: 'grid', gridTemplateColumns: '260px 1fr', height: '100vh' } },",
  "  h(Explorer, { key: epoch, cwd: 'C:/BlazorProbe', refreshKey: 0, onPickFolder() {}, onOpenFile: window.__pick, changed: [{ path: 'Counter.razor.cs', tag: 'edit' }] }),",
  "  h('main', { style: { display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, padding: '20px', overflow: 'hidden' } }, h('p', { style: { marginBottom: '20px' } }, file),",
  "   h(CmEditor, { key: file, content: files[file], lang: langForPath(file), path: file, cwd: 'C:/BlazorProbe', readOnly: true, lsp: false })));",
  "}",
  "createRoot(document.getElementById('root')).render(h(Preview));"
].join('\n')
const virtualId = '\0blazor-preview'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccg-blazor-ui-'))
const server = await createServer({
  configFile: path.join(root, 'app/vite.config.ts'),
  server: { host: '127.0.0.1', port: 0, strictPort: false },
  plugins: [{
    name: 'blazor-preview',
    resolveId(id) { if (id === 'virtual:blazor-preview') return virtualId },
    load(id) { if (id === virtualId) return code },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== '/blazor-preview') return next()
        res.setHeader('Content-Type', 'text/html')
        res.end(await server.transformIndexHtml('/blazor-preview', '<!doctype html><html lang="ko"><meta charset="utf-8"><body style="background:#101010"><div id="root"></div><script type="module">import "virtual:blazor-preview";</script></body></html>'))
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
  const url = server.resolvedUrls.local[0] + 'blazor-preview'
  const profile = path.join(dir, 'profile')
  browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
    '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + profile, '--remote-debugging-port=0', '--window-size=1280,850', url
  ], { windowsHide: true, stdio: 'ignore' })
  await until(() => fs.existsSync(path.join(profile, 'DevToolsActivePort')))
  const port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0])
  const target = await until(async () => (await cdpTargets(port)).find(t => t.type === 'page' && t.url.includes('blazor-preview')))
  cdp = await Cdp.connect(target.webSocketDebuggerUrl)
  await until(() => cdp.eval("!!document.querySelector('.fx-nest-toggle') && !!document.querySelector('.cm-content')"))
  assert.equal(await cdp.eval("!![...document.querySelectorAll('.fx-file-open')].find(b => b.textContent.includes('Counter.razor.cs'))"), false)
  await cdp.eval("document.querySelector('.fx-nest-toggle').click()")
  await until(() => cdp.eval("!![...document.querySelectorAll('.fx-file-open')].find(b => b.textContent.includes('Counter.razor.cs'))"))
  await cdp.eval("[...document.querySelectorAll('.fx-file-open')].find(b => b.textContent.includes('Counter.razor.cs')).click()")
  await until(() => cdp.eval("window.__opened === 'Counter.razor.cs'"))
  await cdp.eval("window.__pick('Counter.razor'); window.__remount()")
  await until(() => cdp.eval("document.querySelector('.fx-nest-toggle')?.getAttribute('aria-expanded') === 'true'"))
  assert.equal(await cdp.eval("window.__dirReads.every(p => p === '')"), true, 'a file group is never read as a directory')
  assert.ok(await cdp.eval("document.querySelectorAll('.cm-content .hljs-keyword').length"), 'Razor/C# syntax is painted')
  assert.ok(await cdp.eval("document.querySelector('.cm-host').getBoundingClientRect().height > 100"), 'the editor is visible')
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(dir, 'blazor.png'), Buffer.from(shot.data, 'base64'))
  await cdp.eval("document.querySelector('.fx-nest-toggle').click()")
  await until(() => cdp.eval("document.querySelector('.fx-nest-toggle').getAttribute('aria-expanded') === 'false'"))
  await cdp.eval("const input = document.querySelector('.fxs input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Counter.razor.js'); input.dispatchEvent(new Event('input', { bubbles: true }));")
  await until(() => cdp.eval("!![...document.querySelectorAll('.fxr')].find(b => b.textContent.includes('Counter.razor.js'))"))
  await cdp.eval("[...document.querySelectorAll('.fxr')].find(b => b.textContent.includes('Counter.razor.js')).click()")
  await until(() => cdp.eval("window.__opened === 'Counter.razor.js'"))
  console.log('Blazor UI: collapse, expansion, child selection, restored expansion, search and syntax colors passed.')
  console.log(path.join(dir, 'blazor.png'))
} finally {
  // Edge can hand off to another PID; close the connected browser before the launcher.
  if (cdp) await cdp.send('Browser.close', {}, { timeoutMs: 1500 }).catch(() => {})
  cdp?.close()
  if (browser?.pid) killTree(browser.pid)
  await server.close()
}
