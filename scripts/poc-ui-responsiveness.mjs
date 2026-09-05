// Real WebView2 regression: sidebar pointer work, file-open latency, and speed tips.
// Uses an isolated home, no live account/engine, and only stops its own process tree.
// node scripts/poc-ui-responsiveness.mjs [--baseline] [--exe=target/release/AgentCodeGUI3.exe]
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { connectMainPage, killTree, quietHome, REPO, sleep } from '../bench/lib.mjs'

const baseline = process.argv.includes('--baseline')
const exe = path.resolve(process.argv.find(a => a.startsWith('--exe='))?.slice(6) ?? 'target/release/AgentCodeGUI3.exe')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccg-ui-response-'))
const work = path.join(home, 'work')
const port = 19397
const write = (name, value) => {
  const file = path.join(home, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
}
quietHome(home)
write('config.json', { activeVersion: 'fake' })
const fakeBinary = 'engines/fake/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe'
write(fakeBinary, '')
fs.copyFileSync(path.join(REPO, 'target/release/ccg-fakecli.exe'), path.join(home, fakeBinary))
write('engines/fake/node_modules/@anthropic-ai/claude-agent-sdk/package.json', { name: '@anthropic-ai/claude-agent-sdk', version: 'fake' })
write('api-config.json', { openaiKey: 'sk-fixture-no-network', openaiEnc: false })
write('work/sample.ts', 'export const hello = "UI regression"\n'.repeat(250))
write('profile.json', { nickname: 'UI regression' })
write('ui-prefs.json', { 'ui.lang': 'ko', 'sidebar.autohide': true, 'whatsnew.seenVersion': '99.0.0', 'viewer.window': false })
write('chats/index.json', { version: 1, order: ['ui-test'], activeChatId: 'ui-test' })
write('chats/ui-test.json', { id: 'ui-test', title: 'UI regression', custom: true, manualCwd: work,
  picker: { engine: 'codex', codexModel: 'gpt-6', model: 'opus', effort: 'high', mode: 'normal' },
  refDirs: [], updatedAt: Date.now(), snapshot: { messages: [
    ...Array.from({ length: 80 }, (_, i) => ({ kind: 'msg', id: `m${i}`, role: i % 2 ? 'assistant' : 'user', text: `대화 ${i} — 응답 속도 확인`, time: '12:00', animate: false })),
    { kind: 'toolgroup', id: 'tools', tools: [{ id: 'read', verb: 'Read', kind: 'read', target: 'sample.ts', status: 'done', result: '250 lines' }] }
  ] }
})
const child = spawn(exe, [], { windowsHide: true, stdio: 'ignore', env: { ...process.env, CCG_HOME: home, CCG_NO_NET: '1',
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` } })
let cdp
const report = { baseline, exe, checks: {} }
try {
  cdp = await connectMainPage(port)
  const evaluate = expr => cdp.eval(`(async()=>(${expr}))()`, { awaitPromise: true })
  const until = async expr => {
    const end = Date.now() + 20000
    while (Date.now() < end) { if (await evaluate('!!(' + expr + ')')) return; await sleep(50) }
    throw new Error(`Timed out: ${expr}\n${await evaluate('document.body.innerText.slice(-1800)')}`)
  }
  await until('document.querySelector(".lcol") && document.querySelector(".t-row")')
  await evaluate(`(() => { document.querySelector('.pn-x')?.click(); return true })()`)
  await evaluate(`(() => { [...document.querySelectorAll('button')].find(b => b.textContent === '나중에')?.click(); return true })()`)
  await sleep(500)
  // Count layout getters during pointer traffic after layout has settled.
  report.checks.pointer = await evaluate(`(() => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    let reads = 0;
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { reads++; return descriptor.get.call(this) } });
    const start = performance.now();
    for (let i = 0; i < 1000; i++) window.dispatchEvent(new MouseEvent('mousemove', { clientX: 700 + i % 100, clientY: 400 }));
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', descriptor);
    return { reads, ms: performance.now() - start };
  })()`)
  for (let i = 0; i < 3; i++) {
    await evaluate(`window.dispatchEvent(new MouseEvent('mousemove', { clientX: 2, clientY: 400 }))`)
    await until('document.querySelector(".lcol.revealed")')
    await evaluate(`window.dispatchEvent(new MouseEvent('mousemove', { clientX: 700, clientY: 400 }))`)
    await until('!document.querySelector(".lcol.revealed")')
  }
  report.checks.sidebar = 'opens and closes repeatedly'
  // Width changes must reach the reveal boundary without per-move layout reads.
  await evaluate(`document.querySelector('.lcol').style.setProperty('--lcol-w', '340px')`)
  await sleep(50)
  await evaluate(`window.dispatchEvent(new MouseEvent('mousemove', { clientX: 2, clientY: 400 }))`)
  await until('document.querySelector(".lcol.revealed")')
  await evaluate(`window.dispatchEvent(new MouseEvent('mousemove', { clientX: 320, clientY: 400 }))`)
  await sleep(50)
  assert.ok(await evaluate('!!document.querySelector(".lcol.revealed")'), 'stay open inside a resized panel')
  await evaluate(`window.dispatchEvent(new Event('blur'))`)
  await until('!document.querySelector(".lcol.revealed")')
  await evaluate(`document.querySelector('.lcol').style.removeProperty('--lcol-w')`)
  report.checks.viewer = []
  for (let i = 0; i < 3; i++) {
    await evaluate(`(() => { window.__openedAt = performance.now(); window.__shellAt = null; window.__bodyAt = null;
      const watch = new MutationObserver(() => {
        if (window.__shellAt === null && document.querySelector('.fv-modal')) window.__shellAt = performance.now() - window.__openedAt;
        if (document.querySelector('.fv-body .cm-content')) { window.__bodyAt = performance.now() - window.__openedAt; watch.disconnect() }
      }); watch.observe(document.body, { childList: true, subtree: true });
      document.querySelector('.t-row').click(); return true;
    })()`)
    await until('window.__bodyAt !== null')
    report.checks.viewer.push(await evaluate('({ shellMs: window.__shellAt, bodyMs: window.__bodyAt, text: document.querySelector(".cm-content").textContent.includes("UI regression") })'))
    await evaluate(`document.querySelector('.fv-modal button[data-tip="닫기 (Esc)"]').click()`)
    await until('!document.querySelector(".fv-modal")')
  }
  await evaluate(`document.querySelector('.model-chip').click()`)
  await until('document.querySelector(".picker-pop")')
  await evaluate(`(() => { const row = [...document.querySelectorAll('.pp-row')].find(el => /Astra/.test(el.textContent)); row?.click(); return !!row })()`)
  await until('document.querySelector(".edrawer.open .eseg-b")')
  await sleep(300) // Let the drawer finish moving before choosing hover coordinates.
  const target = await evaluate(`(() => { const el = [...document.querySelectorAll('.edrawer.open .eseg-b')].find(el => el.textContent === 'Fast'); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, title: el.getAttribute('title') } })()`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y, button: 'none', buttons: 0 })
  await sleep(600)
  report.checks.tooltip = { title: target.title, ...await evaluate(`(() => { const el = document.querySelector('[role="tooltip"]'); if (!el) return { custom: false }; const r = el.getBoundingClientRect(); return { custom: true, text: el.textContent, visible: r.width > 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight } })()`) }
  const out = path.join(REPO, 'node_modules', '.cache', 'poc-ui-responsiveness')
  fs.mkdirSync(out, { recursive: true })
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(out, `${baseline ? 'before' : 'after'}.png`), Buffer.from(shot.data, 'base64'))
  if (!baseline) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 400, button: 'none', buttons: 0 })
    await until('!document.querySelector("[role=tooltip]")')
    await evaluate(`(() => { const fast = [...document.querySelectorAll('.edrawer.open .eseg-b')].find(el => el.textContent === 'Fast'); fast.focus(); return true })()`)
    await until('document.querySelector("[role=tooltip]")')
    assert.ok(await evaluate(`document.activeElement.getAttribute('aria-describedby') === document.querySelector('[role=tooltip]').id`), 'keyboard focus describes the speed option')
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await until('!document.querySelector("[role=tooltip]")')
    report.checks.keyboardTooltip = 'focus shows description; Escape dismisses it'
  }
  fs.writeFileSync(path.join(out, `${baseline ? 'before' : 'after'}.json`), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  if (!baseline) {
    assert.equal(report.checks.pointer.reads, 0, 'pointer movement must not force layout')
    assert.ok(report.checks.viewer[0].shellMs < 200, 'the prepared viewer must avoid the first-click Suspense delay')
    assert.ok(report.checks.viewer.every(v => v.text), 'file content appears on each open')
    assert.ok(report.checks.viewer.slice(1).every(v => v.bodyMs - v.shellMs < 200), 'no fixed entrance delay before content')
    assert.equal(report.checks.tooltip.title, null, 'no native tooltip')
    assert.ok(report.checks.tooltip.custom && report.checks.tooltip.visible, 'custom tooltip escapes drawer clipping')
  }
} finally {
  cdp?.close()
  killTree(child.pid)
}
