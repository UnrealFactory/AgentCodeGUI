#!/usr/bin/env node
/* 멀티 크롬에서 IDE 크롬 조각(탐색기·뷰어·Git·워크바)이 실제로 도는지 손으로 더듬는 프로브 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { connectMainPage, killTree, sleep, REPO, resolveTauriExe } from '../../../bench/lib.mjs'
import { makeMultiFixture } from '../../../bench/fixture.mjs'

// M12 R2 — mainBinaryName 변경으로 exe 이름이 둘이다(구·신 모두 탐색·최신 mtime 우선)
const EXE = resolveTauriExe((process.argv.find((a) => a.startsWith('--exe=')) ?? '').split('=').slice(1).join('='))
const HOME = path.join(REPO, '.critic-home-mux-probe')
const N = Number((process.argv.find((a) => a.startsWith('--n=')) ?? '--n=6').split('=')[1])
fs.rmSync(HOME, { recursive: true, force: true })
makeMultiFixture(HOME, '3.0.0-beta.1', { panels: 6, itemsPerPanel: 2 })
const child = spawn(EXE, [], {
  env: { ...process.env, CCG_HOME: HOME, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9380' },
  stdio: ['ignore', 'pipe', 'pipe']
})
const cdp = await connectMainPage(9380, { timeoutMs: 60_000 })
const ev = (s, o) => cdp.eval(s, o)
try {
  for (let i = 0; i < 300; i++) {
    const up = await ev(`(async()=>{try{return !!(await window.api.app.getVersion())}catch{return false}})()`, { awaitPromise: true }).catch(() => false)
    if (up) break
    await sleep(100)
  }
  await ev(`(() => {
    window.__n = (s) => document.querySelectorAll(s).length
    window.__t = (s) => [...document.querySelectorAll(s)].map(e=>(e.textContent||'').trim())
    window.__key = (k) => { document.body.focus(); for (const tgt of [document, window]) tgt.dispatchEvent(new KeyboardEvent('keydown',{key:k,bubbles:true,cancelable:true})) ; return true }
    window.__labels = (s) => [...document.querySelectorAll(s)].map(e=>({ al: e.getAttribute('aria-label'), tip: e.getAttribute('data-tip'), cls: e.className }))
    return true })()`)
  for (let i = 0; i < 200; i++) { if (await ev(`__n('.ma-grid > .ma-panel') === 6`)) break; await sleep(100) }
  await sleep(1200)
  if (N === 0) {
    // 일반 채팅(IDE 크롬)으로 나간다 — 대조군
    await ev(`(()=>{const el=[...document.querySelectorAll('.sb-item')].find(e=>(e.textContent||'').includes('벤치 긴 스레드')); if(el) el.click(); return !!el})()`)
    await sleep(1500)
  } else if (N !== 6) {
    await ev(`(()=>{const b=document.querySelector('.ma-count-btn[data-count="${N}"]'); if(b) b.click(); return !!b})()`)
    await sleep(1200)
  }
  const out = {}
  out.mode = await ev(`(document.querySelector('.ma-grid')||{}).className`)
  out.headButtons = await ev(`__labels('.ma-head .h-ic, .ma-head button')`)
  out.panelHeadButtons = await ev(`__labels('.ma-grid > .ma-panel:first-child .ma-p-head button')`)
  // 백틱으로 탐색기
  await ev(`__key('\`')`)
  await sleep(1500)
  out.explorerAfterKey = await ev(`__n('.lcol .explorer')`)
  if (!out.explorerAfterKey) {
    // 헤더 토글 버튼
    await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>(e.getAttribute('aria-label')||'').includes('탐색기')); if(b) b.click(); return !!b})()`)
    await sleep(1800)
    out.explorerAfterBtn = await ev(`__n('.lcol .explorer')`)
  }
  for (let i = 0; i < 60; i++) { if (await ev(`__n('.explorer .fxr') > 0`)) break; await sleep(300) }
  out.explorerRows = await ev(`__n('.explorer .fxtree .fxr')`)
  out.explorerRowsAny = await ev(`__n('.explorer .fxr')`)
  out.explorerText = await ev(`((document.querySelector('.lcol .explorer')||{}).innerText||'').slice(0,500)`)
  out.explorerClasses = await ev(`[...document.querySelectorAll('.lcol .explorer *')].slice(0,40).map(e=>e.className).filter(Boolean)`)
  out.explorerHtmlHead = await ev(`(document.querySelector('.lcol')||{}).className + ' | ' + ((document.querySelector('.lcol')?.firstElementChild||{}).className || '')`)
  out.gitBtn = await ev(`__labels('.explorer .fxh button, .explorer .git-strip, .explorer .fx-foot button')`)
  out.workbar = await ev(`__n('.ma-grid > .ma-panel .workbar, .ma-grid > .ma-panel .wk')`)
  out.sidebarSecs = await ev(`__t('.sb-label')`)
  console.log(JSON.stringify(out, null, 1))
} finally {
  cdp.close?.()
  killTree(child.pid)
  await sleep(1000)
  for (let i = 0; i < 10; i++) { try { fs.rmSync(HOME, { recursive: true, force: true }); break } catch { await sleep(500) } }
}
