// Native edge-hover checks and optional same-window blur comparison.
// Requires Vite on 5273 and a debug Tauri binary. Uses synthetic data only.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { connectMainPage, killTree, quietHome, sleep } from '../bench/lib.mjs'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccg-autohide-')), port = 19464
const write = (name, value) => {
  const file = path.join(home, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value))
}
quietHome(home)
write('profile.json', { nickname: 'Autohide check' })
write('ui-prefs.json', { 'ui.lang': 'en', 'workspace.mode': 'multi', 'sidebar.autohide': true,
  'sidebar.autohide.trigger': 50, 'whatsnew.seenVersion': fs.readFileSync('Cargo.toml','utf8').match(/^version = "([^"]+)"/m)[1] })
write('multi-agent/index.json', { version: 2, order: ['autohide'], activeSessionId: 'autohide' })
write('multi-agent/autohide.json', { id: 'autohide', title: 'Autohide check', count: 1,
  panelOrder: [0, 1, 2, 3, 4, 5], panels: [{ title: 'Autohide check', custom: true, cwd: home,
    picker: { engine: 'codex', model: 'opus', mode: 'normal' }, snapshot: { messages:
      Array.from({ length: 100 }, (_, i) => ({ kind: 'msg', id: 'm' + i, role: i % 2 ? 'assistant' : 'user',
        text: i % 2 ? 'A completed response.\n\n' + 'Long conversation content for the slide background. '.repeat(30) : 'Request ' + i,
        animate: false, time: '12:00' })) } }] })
const app = spawn(path.resolve('target/debug/agentcodegui.exe'), [], { windowsHide: true, stdio: 'ignore',
  env: { ...process.env, CCG_HOME: home, CCG_NO_NET: '1', CCG_NO_BOOT_ENGINE_UPDATE: '1', CCG_CDP_PORT: String(port) } })
let c
const ev = code => c.eval('{\n' + code + '\n}', { awaitPromise: true })
const until = async expr => {
  const end = Date.now() + 15000
  while (Date.now() < end) { if (await ev(expr)) return; await sleep(20) }
  throw Error('Timeout ' + expr)
}
const move = (x, y = 450) => c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
const revealed = 'document.querySelector(".lcol").classList.contains("revealed")'
const metrics = async () => Object.fromEntries((await c.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]))
const checks = []
const check = (name, ok) => { assert(ok, name); checks.push(name); console.log('PASS ' + name) }
const cpu = () => JSON.parse(execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `
  $all = @(Get-CimInstance Win32_Process); $ids = [System.Collections.Generic.HashSet[int]]::new(); [void]$ids.Add(${app.pid});
  do { $changed = $false; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)) { $changed = $true } } } while ($changed);
  $result = @{}; foreach ($p in $all) { if ($ids.Contains([int]$p.ProcessId)) { $role = 'browser'; if ($p.ProcessId -eq ${app.pid}) { $role = 'native' } elseif ($p.CommandLine -match '--type=([^ ]+)') { $role = $matches[1] }; $result[$role] += ([double]$p.KernelModeTime + [double]$p.UserModeTime) / 10000000 } }; $result | ConvertTo-Json -Compress
`], { encoding: 'utf8', windowsHide: true }))
async function sample(label) {
  await move(600); await sleep(300)
  const cpuBefore = cpu()
  const before = await metrics()
  await ev(`window.__frames=[];window.__sampling=true;let last=performance.now();
    const frame=t=>{if(!window.__sampling)return;window.__frames.push(t-last);last=t;requestAnimationFrame(frame)};requestAnimationFrame(frame)`)
  const delays = []
  for (let i = 0; i < 12; i++) {
    await ev('window.__start=performance.now()')
    await move(10); await until(revealed)
    delays.push(await ev('performance.now()-window.__start'))
    await sleep(280)
    await move(600); await until('!' + revealed); await sleep(280)
  }
  await ev('window.__sampling=false')
  const after = await metrics(), gaps = await ev('window.__frames')
  const cpuAfter = cpu()
  const sorted = a => [...a].sort((x, y) => x - y)
  return { label, revealMedianMs: sorted(delays)[Math.floor(delays.length / 2)],
    frameP95Ms: sorted(gaps)[Math.floor(gaps.length * .95)], framesOver25ms: gaps.filter(t => t > 25).length,
    frames: gaps.length, layoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000,
    styleMs: (after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000,
    taskMs: (after.TaskDuration - before.TaskDuration) * 1000,
    cpuMs: Object.fromEntries(Object.entries(cpuAfter).map(([role, value]) => [role, (value - (cpuBefore[role] || 0)) * 1000])) }
}
try {
  c = await connectMainPage(port)
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false })
  await c.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await c.send('Performance.enable')
  await until('!!document.querySelector(".lcol.autohide")')
  await sleep(1500)
  await ev(`document.querySelector('.pn-go')?.click();Array.from(document.querySelectorAll('.set-dialog-overlay button')).find(b=>b.textContent.trim()==='Later')?.click()`)
  await until('!document.querySelector(".pn-overlay,.set-dialog-overlay")')
  await move(600); await until('!' + revealed)
  const width = await ev('document.querySelector(".multi").getBoundingClientRect().width')
  await move(51); await sleep(100)
  check('Outside the configured trigger stays hidden', !await ev(revealed))
  await move(49); await until(revealed)
  await sleep(300)
  check('Edge hover opens without changing conversation width', await ev('document.querySelector(".multi").getBoundingClientRect().width') === width)
  await move(180); await sleep(100)
  check('Pointer inside the column keeps it open', await ev(revealed))
  await move(600); await until('!' + revealed)
  check('Returning to the conversation closes it', true)
  await move(10); await until(revealed); await sleep(300)
  const handle = await ev(`(()=>{const r=document.querySelector('.lcol-rs').getBoundingClientRect();return {x:r.x+r.width/2,y:450}})()`)
  check('The resize handle is exposed to the pointer', await ev(`document.elementFromPoint(${handle.x},450)?.classList.contains('lcol-rs')`))
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...handle, button: 'left', clickCount: 1 })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x + 90, y: handle.y, button: 'left', buttons: 1 })
  await sleep(100)
  check('Resizing past the old boundary keeps the sidebar open', await ev(revealed))
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: handle.x + 90, y: handle.y, button: 'left', clickCount: 1 })
  await sleep(100)
  check('The reveal boundary follows the resized width', await ev('document.querySelector(".lcol").offsetWidth') > handle.x + 70)
  // Return to a standard width before measuring repeated slides.
  await ev(`document.querySelector('.lcol-rs').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`)
  await move(600); await until('!' + revealed)
  const original = await sample('current')
  const samples = [original]
  if (process.argv.includes('--compare')) {
    await ev(`const style=document.createElement('style');style.id='autohide-prior-blur';style.textContent='.lcol.autohide{backdrop-filter:blur(32px) saturate(1.25)!important;-webkit-backdrop-filter:blur(32px) saturate(1.25)!important;background:rgba(28,28,28,.72)!important}';document.head.append(style)`)
    samples.push(await sample('prior-blur'))
    await ev('document.querySelector("#autohide-prior-blur").remove()')
    samples.push(await sample('current-restored'))
  }
  await move(10); await until(revealed); await sleep(300)
  const columnStyle = await ev(`(()=>{const s=getComputedStyle(document.querySelector('.lcol'));return {background:s.backgroundColor,backdrop:s.backdropFilter,transition:s.transitionProperty}})()`)
  check('Autohide uses a transform slide without backdrop filtering', columnStyle.backdrop === 'none' && columnStyle.transition === 'transform')
  await ev(`window.dispatchEvent(new Event('blur'))`)
  await until('!' + revealed)
  check('Losing window focus hides the sidebar', true)
  await ev(`import('/src/lib/prefs.ts').then(prefs=>{prefs.setPref('sidebar.autohide',false);window.dispatchEvent(new Event('ccg-sidebar-autohide-changed'))})`)
  await until('!document.querySelector(".lcol.autohide")')
  await move(600)
  check('Pinned mode remains visible away from the edge', await ev('document.querySelector(".lcol").getBoundingClientRect().x >= 0'))
  await ev(`import('/src/lib/prefs.ts').then(prefs=>{prefs.setPref('sidebar.autohide',true);prefs.setPref('sidebar.autohide.trigger',20);window.dispatchEvent(new Event('ccg-sidebar-autohide-changed'))})`)
  await until('!!document.querySelector(".lcol.autohide")')
  await move(30); await sleep(100)
  check('Changing the trigger width takes effect immediately', !await ev(revealed))
  await move(19); await until(revealed); await sleep(300)
  const result = { samples, checks, columnStyle, artifacts: home }
  fs.writeFileSync(path.join(home, 'result.json'), JSON.stringify(result, null, 2))
  const shot = await c.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(home, 'sidebar.png'), Buffer.from(shot.data, 'base64'))
  console.log(JSON.stringify(result, null, 2))
} finally { c?.close(); killTree(app.pid) }
