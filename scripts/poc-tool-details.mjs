// Real React click/clipboard/navigation checks in a hidden Electron renderer.
// No live engine, network, user profile, or project files are accessed.
// Run: node scripts/poc-tool-details.mjs
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import electron from 'electron'

const root = resolve(import.meta.dirname, '..')
const cache = join(root, 'node_modules', '.cache')
mkdirSync(cache, { recursive: true })
const dir = mkdtempSync(join(cache, 'tool-details-'))
await build({
  stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { flushSync } from 'react-dom';
    import { ToolActivityRow } from './app/src/components/ToolActivity';
    import { SubAgentModal } from './app/src/components/AgentPanel';
    import { FileModal } from './app/src/components/FileModal';
    import { reducer, engineAction, initialSessionState } from './app/src/store/session';
    import { viewerPayload } from './app/src/lib/viewerWindow';
    const root = createRoot(document.getElementById('root'));
    window.fileOpens = []; window.parentCloses = 0;
    const openFile = (...args) => window.fileOpens.push(args);
    function AgentWithFile({ agent }) {
      const [file, setFile] = React.useState(null);
      return <>
        <SubAgentModal agent={agent} onClose={() => window.parentCloses++} onOpenFile={(path, line) => { openFile(path, line); setFile({ path, line }); }} />
        {file && <FileModal {...file} cwd="C:/test" backToParent onClose={() => setFile(null)} />}
      </>;
    }
    window.renderTool = tool => flushSync(() => root.render(<ToolActivityRow key={tool.id} t={tool} onOpenFile={openFile} />));
    window.renderAgent = agent => flushSync(() => root.render(<AgentWithFile key={agent.id} agent={agent} />));
    window.renderFile = (path, line) => flushSync(() => root.render(<FileModal path={path} line={line} cwd="C:/test" onClose={() => {}} />));
    window.reduceEvents = events => events.reduce((s, event) => reducer(s, engineAction(event)), initialSessionState);
    window.viewerPayload = viewerPayload;
  `, resolveDir: root, loader: 'tsx' },
  bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic',
  define: { 'import.meta.glob': '__testGlob', 'process.env.NODE_ENV': '"production"' },
  banner: { js: 'var __testGlob = () => ({});' },
  alias: { '@shared': join(root, 'src/shared') },
  outfile: join(dir, 'bundle.js'), logLevel: 'silent'
})

function setup() {
  window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async () => null, convertFileSrc: path => path }
  window.copied = ''; window.openedUrls = []; window.closeListeners = new Set()
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copied = text } } })
  const lsp = new Proxy({ status: async () => 'unsupported', onFilesChanged: () => () => {} }, { get: (o, k) => o[k] || (async () => null) })
  window.api = new Proxy({
    onCloseShortcut: fn => { window.closeListeners.add(fn); return () => window.closeListeners.delete(fn) },
    openExternal: async url => { window.openedUrls.push(url) },
    lsp,
    readFile: async (_cwd, path) => ({ path, content: Array.from({ length: 220 }, (_, i) => `// source line ${i + 1}`).join('\n'), truncated: false }),
    win: { isMaximized: async () => false },
    onWinState: () => () => {}
  }, { get: (o, k) => o[k] || (String(k).startsWith('on') ? () => () => {} : async () => null) })
}
writeFileSync(join(dir, 'index.html'), `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(join(root, 'app/src/styles.css')).href}"><style>body{height:100vh}#root{height:100%;padding:24px}</style><div id="root"></div><script>(${setup.toString()})()</script><script src="bundle.js"></script><script>(${setup.toString()})()</script>`)

async function check() {
  const results = []
  const assert = (label, ok) => { if (!ok) throw new Error(label); results.push(label) }
  const tick = () => new Promise(resolve => setTimeout(resolve, 40))
  const leftGesture = async selector => {
    const base = { bubbles: true, pointerType: 'mouse', pointerId: 81, button: 2, buttons: 2, clientX: 700, clientY: 400 }
    document.querySelector(selector).dispatchEvent(new PointerEvent('pointerdown', base))
    window.dispatchEvent(new PointerEvent('pointermove', { ...base, clientX: 600 }))
    window.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0, clientX: 600 }))
    await tick()
  }
  const until = async predicate => { for (let i = 0; i < 70; i++) { if (predicate()) return; await tick() } throw new Error('Timed out: ' + predicate + '\nDOM: ' + document.body.innerText.slice(-1200) + '\nFlash: ' + document.querySelector('.cm-flash')?.outerHTML) }
  const row = (id, kind, fields = {}) => ({ id, kind, verb: kind === 'bash' ? 'Bash' : kind === 'web' ? 'Web' : 'Search', target: id, status: 'done', ...fields })
  const command = 'echo ' + 'x'.repeat(220) + '\nWrite-Output "명령 끝"'
  window.renderTool(row('long', 'bash', { target: command.slice(0, 180) + '…', command, output: '', outputLines: 0, outputTruncated: false, exitCode: 0 }))
  document.querySelector('.t-row').click(); await tick()
  assert('Bash without output opens details', !!document.querySelector('.tool-detail-overlay'))
  assert('Command details preserve the original multiline command', document.querySelector('.dc-cmd').textContent === command)
  document.querySelector('.dc-copy').click(); await tick()
  assert('Copy command copies all characters and newlines', window.copied === command)
  assert('Exit code zero is visible', document.querySelector('.dc-foot').textContent.includes('0'))
  document.querySelector('.dc-close').click(); await tick()
  window.renderTool(row('fail', 'bash', { command: 'exit 2', status: 'error', exitCode: 2, output: '' }))
  document.querySelector('.t-row').click(); await tick()
  assert('Empty failed commands open an error detail', document.querySelector('.dc-badge').classList.contains('err'))
  document.querySelector('.dc-close').click(); await tick()

  window.renderTool(row('grep', 'search', { output: 'src/example.rs:145:Foo()', args: '{"pattern":"Foo","output_mode":"content"}' }))
  document.querySelector('.t-row').click(); await tick()
  document.querySelector('.dc-file').click(); await tick()
  assert('Search click passes file and matching line', JSON.stringify(window.fileOpens.at(-1)) === '["src/example.rs",145]')
  window.renderTool(row('count', 'search', { output: 'src/example.rs:145', args: '{"output_mode":"count"}' }))
  document.querySelector('.t-row').click(); await tick()
  document.querySelector('.dc-file').click(); await tick()
  assert('Grep count values do not become line destinations', window.fileOpens.at(-1)[1] == null)

  const saved = window.reduceEvents([
    { type: 'tool-start', runId: 'r', tool: row('meta', 'bash', { command, status: 'running', output: 'old' }) },
    { type: 'tool-end', runId: 'r', id: 'meta', status: 'done', output: '', outputLines: 120, outputTruncated: false, exitCode: 0 }
  ]).messages.find(m => m.kind === 'toolgroup').tools[0]
  assert('Reducer preserves metadata and clears stale output', saved.command === command && saved.output === '' && saved.outputLines === 120 && saved.outputTruncated === false && saved.exitCode === 0)
  window.renderTool(saved)
  assert('Bash summary uses the full output count', document.querySelector('.t-res').textContent.includes('120'))
  window.renderTool(row('mcp', 'mcp', { verb: 'MCP', name: 'mcp__sample__lookup', args: '{"query":"actual request"}', output: 'actual result\n{"found":3}' }))
  document.querySelector('.t-row').click(); await tick()
  assert('MCP detail displays the request and response', document.querySelector('.dc-card').textContent.includes('actual request') && document.querySelector('.dc-card').textContent.includes('actual result'))
  document.querySelector('.dc-close').click(); await tick()
  window.renderTool(row('links', 'web', { links: [{ title: 'Example', url: 'https://example.com/' }], outputTruncated: true }))
  document.querySelector('.t-row').click(); await tick()
  assert('Web links remain available with a truncated text preview', document.querySelector('.wl-item')?.getAttribute('href') === 'https://example.com/')

  const agent = { id: 'sa', name: 'Explore', role: '코드 탐색', status: 'done', activity: '테스트용 탐색 결과', tools: [row('agent-bash', 'bash', { command: 'echo detail', output: 'SUBAGENT_DETAIL' }), row('agent-file', 'read', { verb: 'Read', target: 'src/example.rs' }), row('agent-search', 'search', { output: 'src/example.rs:145:Foo()', args: '{"pattern":"Foo","output_mode":"content"}' })] }
  window.renderAgent(agent)
  document.querySelector('[data-tool-id="agent-bash"]').click(); await tick()
  assert('Subagent tool click opens the shared detail', document.querySelector('.tool-detail-overlay')?.textContent.includes('SUBAGENT_DETAIL'))
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick()
  assert('Escape closes tool detail while preserving the subagent card', !document.querySelector('.tool-detail-overlay') && !!document.querySelector('.sa-overlay') && window.parentCloses === 0)
  document.querySelector('[data-tool-id="agent-file"]').click(); await tick()
  assert('Read keeps the source subagent card for return navigation', window.fileOpens.at(-1)[0] === 'src/example.rs' && window.parentCloses === 0 && !!document.querySelector('.sa-overlay'))
  await until(() => !!document.querySelector('.fv-overlay.from-detail .cm-content'))
  assert('File preview is above the source card', Number(getComputedStyle(document.querySelector('.fv-overlay')).zIndex) > Number(getComputedStyle(document.querySelector('.sa-overlay')).zIndex))
  await leftGesture('.fv-modal')
  assert('Left gesture from Read returns to the same tool list', !document.querySelector('.fv-overlay') && !!document.querySelector('[data-tool-id="agent-file"]') && window.parentCloses === 0)
  document.querySelector('[data-tool-id="agent-file"]').click(); await tick()
  document.querySelector('.fv-overlay button[aria-label="닫기"], .fv-overlay button[aria-label="Close"]').click(); await tick()
  assert('Close from Read returns to the tool list', !document.querySelector('.fv-overlay') && !!document.querySelector('.sa-overlay') && window.parentCloses === 0)
  document.querySelector('[data-tool-id="agent-file"]').click(); await tick()
  document.querySelector('.fv-back').click(); await tick()
  assert('File header back returns to the tool list', !document.querySelector('.fv-overlay') && window.parentCloses === 0)
  document.querySelector('[data-tool-id="agent-file"]').click(); await tick()
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick()
  assert('Escape from Read preserves the source card', !document.querySelector('.fv-overlay') && !!document.querySelector('.sa-overlay') && window.parentCloses === 0)
  document.querySelector('[data-tool-id="agent-search"]').click(); await tick()
  document.querySelector('.dc-file').click(); await tick()
  await until(() => document.querySelector('.cm-flash')?.textContent === '// source line 145')
  await leftGesture('.fv-modal')
  assert('Search result files also return to the source tool list', !document.querySelector('.fv-overlay') && !!document.querySelector('.sa-overlay') && window.parentCloses === 0)

  const payload = window.viewerPayload({ path: 'src/example.rs', line: 145, cwd: 'C:/test', backToParent: true })
  assert('Independent viewer payload preserves line and return navigation', payload.line === 145 && payload.backToParent === true)
  window.renderFile('src/example.rs', 145)
  await until(() => document.querySelector('.cm-flash')?.textContent === '// source line 145')
  assert('File viewer scrolls to and highlights the requested source line', true)
  await leftGesture('.fv-modal')
  assert('Standalone file viewers keep their existing back behavior', !!document.querySelector('.fv-overlay') && !document.querySelector('.fv-overlay.from-detail'))
  window.renderFile('src/example.rs', 37)
  await until(() => document.querySelector('.cm-flash')?.textContent === '// source line 37')
  assert('Another hit in the same file moves the highlight', true)
  window.renderFile('README.md', 50)
  await until(() => document.querySelector('.fvl.flash')?.getAttribute('data-ln') === '50')
  assert('Markdown search hits open source at the matched line', true)
  window.renderAgent(agent)
  await new Promise(resolve => setTimeout(resolve, 220))
  return results
}

writeFileSync(join(dir, 'runner.cjs'), `
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
app.setPath('userData', ${JSON.stringify(join(dir, 'profile'))});
app.whenReady().then(async () => {
  const timer = setTimeout(() => { console.error('Renderer test timed out'); app.exit(1); }, 25000);
  try {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, cb) => cb({ cancel: true }));
    const win = new BrowserWindow({ show: false, width: 1000, height: 760, webPreferences: { offscreen: true, backgroundThrottling: false } });
    win.webContents.on('console-message', event => { if (event.level === 'error') console.error('Renderer:', event.message); });
    await win.loadFile(${JSON.stringify(join(dir, 'index.html'))});
    const results = await win.webContents.executeJavaScript('(' + ${JSON.stringify(check.toString())} + ')()');
    results.forEach(result => console.log('PASS  ' + result));
    fs.writeFileSync(${JSON.stringify(join(dir, 'subagent-tools.png'))}, (await win.webContents.capturePage()).toPNG());
    console.log('Screenshot: ' + ${JSON.stringify(join(dir, 'subagent-tools.png'))});
    clearTimeout(timer); app.exit(0);
  } catch (error) { console.error(error); clearTimeout(timer); app.exit(1); }
});`)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, [join(dir, 'runner.cjs')], { env, windowsHide: true, stdio: 'inherit' })
child.on('error', error => { console.error(error); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
