#!/usr/bin/env node
/* 다이얼 좌표 이동의 **실사용 결과**를 잰다: 6에서 「2」를 누른 뒤, 마우스를 안 움직이고
 * 같은 화면 좌표를 다시 누르면 어느 숫자가 눌리는가. (§2.1 "위치 고정" 규약의 대가) */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { connectMainPage, killTree, sleep, REPO } from '../../../bench/lib.mjs'
import { makeMultiFixture } from '../../../bench/fixture.mjs'

const EXE = path.join(REPO, 'target', 'release', 'agentcodegui.exe')
const HOME = path.join(REPO, '.critic-home-mux-shift')
const OUT = path.join(REPO, 'docs', 'critic', 'm-ux-r1-dialshift.json')

const rep = { at: new Date().toISOString(), cases: {} }
fs.rmSync(HOME, { recursive: true, force: true })
makeMultiFixture(HOME, '3.0.0-beta.1', { panels: 6, itemsPerPanel: 2 })
const child = spawn(EXE, [], {
  env: { ...process.env, CCG_HOME: HOME, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9379' },
  stdio: ['ignore', 'pipe', 'pipe']
})
const cdp = await connectMainPage(9379, { timeoutMs: 60_000 })
try {
  for (let i = 0; i < 300; i++) {
    const up = await cdp.eval(`(async()=>{try{return !!(await window.api.app.getVersion())}catch{return false}})()`, { awaitPromise: true }).catch(() => false)
    if (up) break
    await sleep(100)
  }
  await cdp.eval(`(() => {
    window.__btns = () => [...document.querySelectorAll('.ma-count-btn')].map(b => { const r=b.getBoundingClientRect()
      return { n: b.dataset.count, x: Math.round(r.x), cx: Math.round(r.x + r.width/2), w: Math.round(r.width), on: b.className.includes('on') } })
    window.__at = (x, y) => { const e = document.elementFromPoint(x, y); return e ? (e.closest('.ma-count-btn')?.dataset.count ?? e.className) : null }
    window.__click = (sel, n=0) => { const e=document.querySelectorAll(sel)[n]; if(!e) return false; e.click(); return true }
    window.__nPanels = () => document.querySelectorAll('.ma-grid > .ma-panel').length
    return true })()`)
  for (let i = 0; i < 200; i++) { if (await cdp.eval(`__nPanels() === 6`)) break; await sleep(100) }
  await sleep(800)

  const at6 = await cdp.eval(`__btns()`)
  rep.cases.at6 = at6
  const b2 = at6.find((b) => b.n === '2')
  const y = 19
  // 6 → 2 (진짜로 「2」를 누른다)
  await cdp.eval(`__click('.ma-count-btn[data-count="2"]')`)
  for (let i = 0; i < 100; i++) { if (await cdp.eval(`__nPanels() === 2`)) break; await sleep(50) }
  await sleep(500)
  const at2 = await cdp.eval(`__btns()`)
  rep.cases.at2 = at2
  // 마우스를 안 움직이고 같은 좌표를 다시 누르면?
  const under = await cdp.eval(`__at(${b2.cx}, ${y})`)
  rep.cases.sameSpotAfter = { clickedCx: b2.cx, nowUnderCursor: under }
  // 2 → 1 뒤에도
  await cdp.eval(`__click('.ma-count-btn[data-count="1"]')`)
  for (let i = 0; i < 100; i++) { if (await cdp.eval(`__nPanels() === 1`)) break; await sleep(50) }
  await sleep(500)
  const at1 = await cdp.eval(`__btns()`)
  rep.cases.at1 = at1
  const b1 = at2.find((b) => b.n === '1')
  rep.cases.sameSpotAfter1 = { clickedCx: b1.cx, nowUnderCursor: await cdp.eval(`__at(${b1.cx}, ${y})`) }
  console.log(JSON.stringify(rep.cases, null, 1))
} finally {
  cdp.close?.()
  killTree(child.pid)
  await sleep(1000)
  fs.writeFileSync(OUT, JSON.stringify(rep, null, 2))
  for (let i = 0; i < 10; i++) { try { fs.rmSync(HOME, { recursive: true, force: true }); break } catch { await sleep(500) } }
  console.log('리포트: ' + OUT)
}
