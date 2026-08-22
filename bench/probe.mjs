// 일회용 정찰 — 순간 프레임(부팅 로딩·뷰어 로딩) 캡처 수단 실측.
//  A) window.api를 렌더러에서 갈아끼울 수 있는가 (contextBridge 노출 속성의 서술자)
//  B) Page.addScriptToEvaluateOnNewDocument가 document-start에 window.api를 보는가
//  C) CPU 스로틀별 부팅 로딩(.boot) 가시 구간 실측
// 실행: node bench/probe.mjs   (자기 PID만 정리)
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { electronProfile, cdpTargets, Cdp, killTree, sleep, REPO } from './lib.mjs'
import { makeFixtureHome } from './fixture.mjs'
import { augmentFixture, makeScratch } from './screens.mjs'

const PORT = 9347
const HOME = path.join(os.tmpdir(), 'ccg-probe-home')
const profile = electronProfile({ port: PORT })

fs.rmSync(HOME, { recursive: true, force: true })
makeFixtureHome(HOME, '2.6.2')
augmentFixture(HOME, { repo: REPO })
makeScratch(REPO)

const child = spawn(profile.cmd, profile.args, {
  env: { ...process.env, ...profile.env, CCG_HOME: HOME },
  cwd: profile.cwd,
  stdio: 'ignore'
})

async function connectMain(timeoutMs = 60000) {
  const t0 = Date.now()
  for (;;) {
    try {
      const ts = await cdpTargets(PORT)
      const t = ts.find((x) => x.type === 'page' && !x.url.startsWith('data:') && !/toast|tray/.test(x.url) && !x.url.includes('#') && /index\.html/.test(x.url))
      if (t?.webSocketDebuggerUrl) return await Cdp.connect(t.webSocketDebuggerUrl)
    } catch { /* 아직 */ }
    if (Date.now() - t0 > timeoutMs) throw new Error('no main target')
    await sleep(60)
  }
}

const out = {}
let cdp = null
try {
  cdp = await connectMain()
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  for (let i = 0; i < 300; i++) {
    if (await cdp.eval(`!!document.querySelector('.win .chat, .win .boot')`).catch(() => false)) break
    await sleep(100)
  }
  await sleep(2500)

  // ── A) window.api 서술자 + 갈아끼우기 ──────────────────────────────────────
  out.desc = await cdp.eval(`(() => { const d = Object.getOwnPropertyDescriptor(window, 'api')
    return d ? { writable: !!d.writable, configurable: !!d.configurable, enumerable: !!d.enumerable, hasGet: !!d.get } : null })()`)
  out.patchTry = await cdp.eval(`(() => {
    try {
      const o = window.api
      const copy = {}
      for (const k in o) copy[k] = o[k]
      copy.__patched = true
      Object.defineProperty(window, 'api', { value: copy, configurable: true, writable: true })
      return { ok: window.api.__patched === true, keys: Object.keys(copy).length }
    } catch (e) { return { ok: false, err: String(e).slice(0, 160) } }
  })()`)
  // 되돌리기(가능하면)
  out.restore = await cdp.eval(`(() => { try { return typeof window.api.readFile } catch (e) { return String(e).slice(0,80) } })()`)

  // ── B) document-start 주입이 window.api를 보는가 ────────────────────────────
  const { identifier } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__probeStart = { hasApi: typeof window.api, t: Date.now() }
      try {
        const o = window.api
        if (o) {
          const copy = {}
          for (const k in o) copy[k] = o[k]
          const orig = o.getProfile ? o.getProfile.bind(o) : null
          if (orig) copy.getProfile = () => new Promise((r) => setTimeout(() => r(orig()), 4000))
          Object.defineProperty(window, 'api', { value: copy, configurable: true, writable: true })
          window.__probeStart.patched = window.api.getProfile !== o.getProfile
        }
      } catch (e) { window.__probeStart.err = String(e).slice(0, 160) }`
  })

  // ── C) 스로틀별 .boot 가시 구간 ─────────────────────────────────────────────
  const measure = async (rate, label) => {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate }).catch(() => {})
    const t0 = Date.now()
    await cdp.send('Page.reload', { ignoreCache: false })
    let first = null, last = null, ctxErrs = 0
    for (;;) {
      const n = await cdp.eval(`document.querySelectorAll('.win .boot .boot-spin').length`).catch(() => { ctxErrs++; return -1 })
      const el = Date.now() - t0
      if (n > 0) { if (first == null) first = el; last = el }
      if (first != null && n === 0) break
      if (el > 45000) break
      await sleep(10)
    }
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {})
    // 완전히 뜰 때까지
    for (let i = 0; i < 400; i++) {
      if (await cdp.eval(`!!document.querySelector('.chat, .multi')`).catch(() => false)) break
      await sleep(100)
    }
    const start = await cdp.eval(`window.__probeStart || null`).catch(() => null)
    return { label, rate, firstMs: first, lastMs: last, windowMs: first == null ? null : last - first, ctxErrs, start }
  }
  out.boot = []
  out.boot.push(await measure(1, 'no-throttle'))
  await sleep(1500)
  out.boot.push(await measure(8, 'throttle-8'))
  await sleep(1500)
  out.boot.push(await measure(20, 'throttle-20'))

  await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }).catch(() => {})

  // ── D) 뷰어 로딩 프레임 폭 (스로틀 20, 큰 파일) ─────────────────────────────
  await cdp.eval(`(() => { const e = document.activeElement; if (e) e.blur(); return true })()`)
  out.viewer = await (async () => {
    try {
      // 탐색기 열기
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: '`', code: 'Backquote', windowsVirtualKeyCode: 192, nativeVirtualKeyCode: 192 })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: '`', code: 'Backquote', windowsVirtualKeyCode: 192, nativeVirtualKeyCode: 192 })
      await sleep(1500)
      await cdp.eval(`(() => { const i = document.querySelector('.fxs input')
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'ccgbench-huge')
        i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
      await sleep(2500)
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 20 })
      const t0 = Date.now()
      await cdp.eval(`(() => { const r = [...document.querySelectorAll('.explorer .fxtree .fxr')].find((x) => (x.textContent||'').includes('ccgbench-huge')); if (!r) return false; r.click(); return true })()`)
      let first = null, last = null
      for (;;) {
        const n = await cdp.eval(`document.querySelectorAll('.fv-body .fv-loading .spin').length`).catch(() => -1)
        const el = Date.now() - t0
        if (n > 0) { if (first == null) first = el; last = el }
        if (first != null && n === 0) break
        if (el > 25000) break
        await sleep(8)
      }
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
      return { firstMs: first, lastMs: last, windowMs: first == null ? null : last - first }
    } catch (e) { return { err: String(e).slice(0, 200) } }
  })()
} catch (e) {
  out.fatal = String(e.message ?? e)
} finally {
  try { cdp?.close() } catch { /* 닫힘 */ }
  killTree(child.pid)
}
console.log(JSON.stringify(out, null, 2))
