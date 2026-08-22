// ── A/B 캡처 실행기 — 두 앱의 같은 화면을 같은 방법으로 찍는다 ──────────────────
//
//   node bench/ab.mjs electron            2.6.2 기준 세트
//   node bench/ab.mjs tauri               3.0.0 비교 세트
//   node bench/ab.mjs electron --only=chat-thread,settings-api
//   node bench/ab.mjs electron --engine   엔진 턴이 필요한 대표 화면까지 (기본 제외)
//   node bench/ab.mjs electron --no-boot  별도 기동이 필요한 부팅 변형 생략
//   node bench/ab.mjs electron --only=… --merge   실패 화면만 고쳐 재시도 (리포트 병합)
//
// 산출: bench/shots/<app>/<id>.png + bench/shots/<app>/report.json
//
// [공정성 규약]
//  - 창 크기와 배경을 두 앱에 똑같이 강제한다(Browser.setWindowBounds + 기본 배경 오버라이드).
//    아크릴 블러는 CDP 캡처에 애초에 안 담기므로, 투명 대신 같은 불투명 배경을 깔아야
//    "한쪽만 배경이 비침" 같은 가짜 차이가 안 생긴다.
//  - reach/assert/reset은 screens.mjs 한 벌뿐 — 앱별 분기가 없다.
//  - assert 실패는 치명이 아니라 기록이다. 러너는 다음 화면으로 간다.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { electronProfile, tauriProfile, cdpTargets, Cdp, killTree, sleep, REPO } from './lib.mjs'
import { makeFixtureHome } from './fixture.mjs'
import {
  SCREENS, BOOT_VARIANTS, HELPERS_JS, DIRTY_SEL, makeCtx, augmentFixture, makeScratch, primeJs
} from './screens.mjs'

const kind = process.argv[2] ?? 'electron'
const argv = process.argv.slice(3)
const onlyArg = argv.find((a) => a.startsWith('--only='))
const ONLY = onlyArg ? new Set(onlyArg.slice(7).split(',').map((s) => s.trim()).filter(Boolean)) : null
const WITH_ENGINE = argv.includes('--engine')
const NO_BOOT = argv.includes('--no-boot')
const KEEP = argv.includes('--keep') // 캡처 후 앱을 띄워 둔다 (수동 확인용)
const MERGE = argv.includes('--merge') // 이전 report.json에 덮어쓰지 않고 병합 (--only 재시도용)

const profile = kind === 'tauri' ? tauriProfile({ port: 9346 }) : electronProfile({ port: 9345 })
const APP_VERSION = kind === 'tauri' ? '3.0.0-beta.1' : '2.6.2'
const HOME = path.join(os.tmpdir(), `ccg-screens-${kind}`)
const OUT = path.join(REPO, 'bench', 'shots', kind)
const VIEW = { width: 1440, height: 900 }

fs.mkdirSync(OUT, { recursive: true })

// ── 홈 준비 ─────────────────────────────────────────────────────────────────────
//
// [실측 함정] 앱을 killTree로 죽인 **직후** 홈을 지우면 EPERM이 난다. Chromium userData의
// leveldb/로그 핸들이 프로세스 종료 뒤에도 잠깐 살아 있어서다(부팅 변형 패스가 여기서
// 통째로 죽어 report.json이 아예 안 남았던 실패 모드). 물러섰다 다시 시도하고, 끝내
// 안 되면 잠긴 홈을 옆으로 치우고 새 홈으로 계속 간다 — 캡처가 멈추는 것보다 낫다.
const staleHomes = []

async function rmHomeRobust(dir, tries = 14) {
  for (let i = 0; i < tries; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      return { ok: true }
    } catch (e) {
      if (i === tries - 1) return { ok: false, err: e }
      await sleep(500)
    }
  }
  return { ok: false }
}

async function buildHome() {
  const rm = await rmHomeRobust(HOME)
  if (!rm.ok) {
    const aside = `${HOME}-stale-${Date.now()}`
    let moved = false
    try { fs.renameSync(HOME, aside); moved = true } catch { /* 이름 변경도 막히면 덮어쓴다 */ }
    console.log(`[ab] 홈 정리 실패(${rm.err?.code ?? 'EPERM'}) — ${moved ? `${aside}로 치우고` : '덮어쓰며'} 계속`)
    if (moved) staleHomes.push(aside)
  }
  const fx = makeFixtureHome(HOME, APP_VERSION)
  const aug = augmentFixture(HOME, { repo: REPO })
  return { fx, aug }
}

const scratch = makeScratch(REPO)
const SCRATCH_SNAPSHOT = fs.readFileSync(scratch.sample, 'utf8')

// ── 앱 기동 + 메인 창 CDP ───────────────────────────────────────────────────────
function spawnApp() {
  return spawn(profile.cmd, profile.args, {
    env: { ...process.env, ...profile.env, CCG_HOME: HOME },
    cwd: profile.cwd,
    stdio: 'ignore'
  })
}

/**
 * 메인 창만 정확히 고른다.
 * 인벤토리의 주의사항: lib.mjs의 connectMainPage 필터는 `#session`/`#mapanel` 창까지 문다.
 * 독립 창이 떠 있는 동안에도 메인을 잡으려면 해시 없는 index.html이어야 한다.
 */
const isMainUrl = (u) => /index\.html(\?[^#]*)?$/.test(u) || /localhost(:\d+)?\/?$/.test(u) || /index\.html$/.test(u.split('#')[0]) && !u.includes('#')

async function findMainTarget(port) {
  const ts = await cdpTargets(port)
  return ts.find((t) => t.type === 'page' && !t.url.startsWith('data:') && !/toast\.html|tray\.html/.test(t.url) && !t.url.includes('#') && /index\.html|localhost/.test(t.url))
}

async function connectMain(port, timeoutMs = 60000) {
  const t0 = Date.now()
  for (;;) {
    try {
      const t = await findMainTarget(port)
      if (t?.webSocketDebuggerUrl) return await Cdp.connect(t.webSocketDebuggerUrl)
    } catch { /* 아직 안 뜸 */ }
    if (Date.now() - t0 > timeoutMs) throw new Error('main page target not found')
    await sleep(60)
  }
}

async function prepPage(cdp, { bg = true } = {}) {
  await cdp.send('Page.enable').catch(() => {})
  await cdp.send('Runtime.enable').catch(() => {})
  if (bg) {
    await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 14, g: 16, b: 22, a: 1 } }).catch(() => {})
  }
}

/** 두 앱의 창 크기를 같게 — 실패해도(도메인 미지원) 조용히 넘어간다. */
async function fixWindowSize(cdp) {
  try {
    const { windowId } = await cdp.send('Browser.getWindowForTarget', {})
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: 40, top: 40, width: VIEW.width, height: VIEW.height } })
    await sleep(700)
    return true
  } catch {
    return false
  }
}

async function waitMounted(cdp, ms = 60000) {
  const t0 = Date.now()
  for (;;) {
    const ok = await cdp.eval(`!!document.getElementById('root') && document.getElementById('root').children.length > 0`).catch(() => false)
    if (ok) return true
    if (Date.now() - t0 > ms) return false
    await sleep(120)
  }
}

// ── 독립 창(session/panel/toast) 헬퍼 — ctx로 넘겨 준다 ─────────────────────────
function windowHelpers(port) {
  const matches = (url, frag) => frag.split('|').some((f) => url.includes(f))
  const findWin = async (frag) => {
    const ts = await cdpTargets(port)
    return ts.find((t) => t.type === 'page' && matches(t.url, frag))
  }
  return {
    async waitForWindow(frag, ms = 15000) {
      const t0 = Date.now()
      for (;;) {
        const t = await findWin(frag).catch(() => null)
        if (t) return t
        if (Date.now() - t0 > ms) throw new Error(`waitForWindow timeout: ${frag}`)
        await sleep(150)
      }
    },
    /** 지금 떠 있는 매칭 창들의 타깃 id — 직후 '새로 뜬 창'만 고르기 위한 기준선 */
    async windowIds(frag) {
      const ts = await cdpTargets(port).catch(() => [])
      return ts.filter((t) => t.type === 'page' && matches(t.url, frag)).map((t) => t.id)
    },
    /** seen에 없던 새 창이 뜰 때까지 — 직전 화면의 잔존 창을 물지 않게 한다 */
    async waitForNewWindow(frag, seen = [], ms = 15000) {
      const t0 = Date.now()
      const seenSet = new Set(seen)
      for (;;) {
        const ts = await cdpTargets(port).catch(() => [])
        const t = ts.find((x) => x.type === 'page' && matches(x.url, frag) && !seenSet.has(x.id))
        if (t) return t
        if (Date.now() - t0 > ms) throw new Error(`waitForNewWindow timeout: ${frag}`)
        await sleep(150)
      }
    },
    async attachTarget(t) {
      const c = await Cdp.connect(t.webSocketDebuggerUrl)
      await prepPage(c)
      return c
    },
    /** 진단용 — 지금 붙어 있는 모든 CDP 페이지 타깃 */
    async listWindows() {
      const ts = await cdpTargets(port).catch(() => [])
      return ts.filter((t) => t.type === 'page').map((t) => t.url.replace(/^file:\/\/\/.*\//, ''))
    },
    async attachWindow(frag, ms = 15000) {
      const t = await this.waitForWindow(frag, ms)
      const c = await Cdp.connect(t.webSocketDebuggerUrl)
      await prepPage(c)
      return c
    },
    /** 매칭되는 독립 창을 전부 닫는다 (다음 화면 오염 차단) */
    async closeSubWindows(...frags) {
      for (const frag of frags) {
        for (let i = 0; i < 4; i++) {
          const t = await findWin(frag).catch(() => null)
          if (!t) break
          try {
            const c = await Cdp.connect(t.webSocketDebuggerUrl)
            await c.eval(`(window.api && window.api.win ? window.api.win.close() : window.close(), true)`).catch(() => {})
            c.close()
          } catch { /* 이미 닫힘 */ }
          await sleep(500)
        }
      }
    }
  }
}

// ── 캡처 한 판 ──────────────────────────────────────────────────────────────────
async function shoot(cdp, id) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(path.join(OUT, `${id}.png`), Buffer.from(r.data, 'base64'))
}

async function assertOn(cdp, sel, min = 1, ms = 8000) {
  const t0 = Date.now()
  for (;;) {
    const n = await cdp.eval(`document.querySelectorAll(${JSON.stringify(sel)}).length`).catch(() => 0)
    if (n >= min) return n
    if (Date.now() - t0 > ms) throw new Error(`assert 실패: ${sel} (${n}/${min})`)
    await sleep(120)
  }
}

async function dirtyNow(cdp) {
  return await cdp.eval(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(DIRTY_SEL)})]
    return els.map((e) => e.className && typeof e.className === 'string' ? '.' + e.className.split(' ')[0] : e.tagName).slice(0, 6)
  })()`).catch(() => [])
}

/** 화면 사이 강제 정리 — Esc 연타로도 안 걷히면 리로드(핵옵션). */
async function forceClean(cdp, ctx) {
  for (let i = 0; i < 5; i++) {
    const d = await dirtyNow(cdp)
    if (!d.length) return { clean: true, reloaded: false }
    await ctx.esc(1)
    await sleep(220)
  }
  const d = await dirtyNow(cdp)
  if (!d.length) return { clean: true, reloaded: false }
  await cdp.send('Page.reload', {}).catch(() => {})
  await waitMounted(cdp, 45000)
  await sleep(2000)
  await cdp.eval(HELPERS_JS).catch(() => {})
  await cdp.eval(primeJs(REPO)).catch(() => {})
  const d2 = await dirtyNow(cdp)
  return { clean: !d2.length, reloaded: true, left: d2 }
}

// ── 메인 패스 ───────────────────────────────────────────────────────────────────
const report = { app: profile.name, kind, at: new Date().toISOString(), viewport: VIEW, screens: [] }
const rec = (o) => { report.screens.push(o); return o }

function wanted(s) {
  if (ONLY) return ONLY.has(s.id)
  return true
}

async function mainPass() {
  const child = spawnApp()
  let cdp = null
  try {
    cdp = await connectMain(profile.port, 90000)
    await prepPage(cdp)
    const sized = await fixWindowSize(cdp)
    report.windowSized = sized
    if (!(await waitMounted(cdp, 90000))) throw new Error('renderer never mounted')
    await sleep(3500) // 스레드 하이드레이션·git 스트립·아바타 안정화

    const wh = windowHelpers(profile.port)
    const ctx = makeCtx(cdp, {
      ...wh,
      home: HOME,
      repo: REPO,
      app: kind,
      /** 엔진 턴이 끝날 때까지 (엔진 화면 전용) */
      async waitTurnIdle(ms = 90000) {
        const t0 = Date.now()
        for (;;) {
          const busy = await cdp.eval(`document.querySelectorAll('.thread .working-line, .composer .stop-btn').length > 0`).catch(() => false)
          if (!busy) return true
          if (Date.now() - t0 > ms) return false
          await sleep(500)
        }
      }
    })
    // 메서드 안에서 this로 서로를 부르므로 wh에 바인딩해 넘긴다
    ctx.attachWindow = (frag, ms) => wh.attachWindow.call(wh, frag, ms)
    ctx.closeSubWindows = (...f) => wh.closeSubWindows.call(wh, ...f)
    ctx.waitForWindow = (frag, ms) => wh.waitForWindow.call(wh, frag, ms)
    ctx.waitForNewWindow = (frag, seen, ms) => wh.waitForNewWindow.call(wh, frag, seen, ms)
    ctx.windowIds = (frag) => wh.windowIds.call(wh, frag)
    ctx.attachTarget = (t) => wh.attachTarget.call(wh, t)
    ctx.listWindows = () => wh.listWindows.call(wh)

    /**
     * 한 프레임짜리 화면(로딩 스피너)용 자가 캡처.
     * 러너의 기본 흐름(reach → assert → 촬영)은 assert 폴링 사이에 상태가 사라지는 화면을
     * 못 찍는다. selfShot 화면은 reach가 직접 고빈도로 폴링하다가 **셀렉터를 본 그 순간**
     * 찍고 개수를 보고한다 — 판정(셀렉터 존재)과 촬영 시점이 같으므로 헐거워지지 않는다.
     * 두 앱이 같은 코드를 타므로 대칭성도 유지된다.
     */
    ctx.snapWhen = async (id, sel, { ms = 20000, interval = 12 } = {}) => {
      const t0 = Date.now()
      for (;;) {
        const n = await cdp.eval(`document.querySelectorAll(${JSON.stringify(sel)}).length`).catch(() => 0)
        if (n > 0) {
          await shoot(cdp, id)
          ctx._shotFound = n
          return n
        }
        if (Date.now() - t0 > ms) throw new Error(`snapWhen timeout: ${sel}`)
        await sleep(interval)
      }
    }

    await cdp.eval(HELPERS_JS)
    await cdp.eval(primeJs(REPO))

    const list = SCREENS.filter((s) => !s.boot).filter(wanted)
    for (const s of list) {
      if (s.skip) { if (!s.internal) rec({ id: s.id, label: s.label, area: s.area, ok: false, skipped: true, reason: s.skip }); continue }
      if (s.needsEngine && !WITH_ENGINE) {
        rec({ id: s.id, label: s.label, area: s.area, ok: false, skipped: true, reason: '엔진 턴 필요 — --engine 없이 실행(기본 제외)' })
        continue
      }
      const t0 = Date.now()
      const row = { id: s.id, label: s.label, area: s.area, surface: s.surface, ok: false, ms: 0 }
      let sub = null
      ctx._shotFound = null
      try {
        await cdp.eval(HELPERS_JS)
        await s.reach(cdp, ctx)
        if (s.selfShot) {
          // reach가 ctx.snapWhen으로 판정+촬영을 한꺼번에 끝낸 화면
          if (!ctx._shotFound) throw new Error('selfShot: reach가 캡처 시점을 보고하지 않음')
          row.found = ctx._shotFound
          row.capturedInReach = true
        } else {
          const shotCdp = s.win ? (sub = await wh.attachWindow(s.win, 15000)) : cdp
          if (s.win) await sleep(600)
          row.found = await assertOn(shotCdp, s.assert, s.assertMin ?? 1, 9000)
          await sleep(s.settle ?? 400)
          if (!s.internal) await shoot(shotCdp, s.id)
        }
        row.ok = true
      } catch (e) {
        row.error = String(e.message ?? e).slice(0, 300)
      }
      ctx.sub = sub
      try { if (s.reset) await s.reset(cdp, ctx) } catch (e) { row.resetError = String(e.message ?? e).slice(0, 200) }
      if (sub) { try { sub.close() } catch { /* 닫힘 */ } ctx.sub = null }
      const clean = await forceClean(cdp, ctx)
      if (!clean.clean) row.dirtyAfterReset = clean.left
      if (clean.reloaded) row.reloadedAfter = true
      row.ms = Date.now() - t0
      if (!s.internal) rec(row)
      const mark = row.ok ? 'OK ' : 'FAIL'
      console.log(`${mark} ${s.id} (${row.ms}ms)${row.error ? ' — ' + row.error : ''}${clean.reloaded ? ' [reload]' : ''}`)
    }
  } finally {
    try { cdp?.close() } catch { /* 닫힘 */ }
    if (!KEEP) killTree(child.pid)
    // 다음 패스가 홈을 지울 수 있게 파일 핸들이 닫힐 시간을 준다 (EPERM 예방)
    await sleep(2500)
  }
}

// ── 부팅 변형 패스 (별도 기동이 필요한 화면) ────────────────────────────────────
async function bootPass(variantKey) {
  const screens = SCREENS.filter((s) => s.boot === variantKey).filter(wanted)
  if (!screens.length) return
  const v = BOOT_VARIANTS[variantKey]
  await buildHome()
  v.prepare?.(HOME)

  const child = spawnApp()
  let cdp = null
  const t0 = Date.now()
  try {
    // 스플래시는 기동과 동시에 사라지므로 data: 타깃을 최우선으로 훑는다
    if (v.early) {
      const deadline = Date.now() + 20000
      let done = false
      while (Date.now() < deadline && !done) {
        try {
          const ts = await cdpTargets(profile.port)
          const t = ts.find((x) => x.type === 'page' && x.url.startsWith(v.early))
          if (t) {
            const c = await Cdp.connect(t.webSocketDebuggerUrl)
            await prepPage(c, { bg: false })
            for (const s of screens) {
              const row = { id: s.id, label: s.label, area: s.area, surface: s.surface, ok: false, ms: Date.now() - t0 }
              try {
                row.found = await assertOn(c, s.assert, s.assertMin ?? 1, 3000)
                await shoot(c, s.id)
                row.ok = true
              } catch (e) { row.error = String(e.message ?? e).slice(0, 300) }
              rec(row)
              console.log(`${row.ok ? 'OK ' : 'FAIL'} ${s.id} (boot:${variantKey})${row.error ? ' — ' + row.error : ''}`)
            }
            c.close()
            done = true
          }
        } catch { /* 아직 */ }
        await sleep(25)
      }
      if (!done) for (const s of screens) { rec({ id: s.id, label: s.label, area: s.area, ok: false, error: 'data: 스플래시 타깃을 기동 20초 안에 잡지 못함' }); console.log(`FAIL ${s.id} (boot:${variantKey}) — 스플래시 타깃 미포착`) }
      return
    }

    cdp = await connectMain(profile.port, 90000)
    await prepPage(cdp)
    if (v.throttle) await cdp.send('Emulation.setCPUThrottlingRate', { rate: v.throttle }).catch(() => {})
    await fixWindowSize(cdp)
    for (const s of screens) {
      const row = { id: s.id, label: s.label, area: s.area, surface: s.surface, ok: false, ms: 0 }
      const st = Date.now()
      try {
        row.found = await assertOn(cdp, s.assert, s.assertMin ?? 1, v.throttle ? 25000 : 40000)
        await sleep(250)
        await shoot(cdp, s.id)
        row.ok = true
      } catch (e) { row.error = String(e.message ?? e).slice(0, 300) }
      row.ms = Date.now() - st
      rec(row)
      console.log(`${row.ok ? 'OK ' : 'FAIL'} ${s.id} (boot:${variantKey})${row.error ? ' — ' + row.error : ''}`)
    }
    if (v.throttle) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {})
  } finally {
    try { cdp?.close() } catch { /* 닫힘 */ }
    killTree(child.pid)
    await sleep(1200)
  }
}

// ── 실행 ────────────────────────────────────────────────────────────────────────
// [규약] 어느 패스가 터져도 report.json은 남는다. 리포트가 없으면 "무엇을 못 찍었는지"가
// 통째로 사라져 파리티 판정이 근거를 잃는다 — 실제로 부팅 패스 EPERM 크래시로 한 번 잃었다.
console.log(`[ab] ${profile.name} — home ${HOME}`)
try {
  await buildHome()
  await mainPass()

  if (!NO_BOOT) {
    for (const key of Object.keys(BOOT_VARIANTS)) {
      const has = SCREENS.some((s) => s.boot === key && wanted(s) && !s.skip)
      if (!has) continue
      try {
        await bootPass(key)
      } catch (e) {
        const msg = String(e.message ?? e).slice(0, 300)
        for (const s of SCREENS.filter((x) => x.boot === key && wanted(x) && !x.skip)) {
          if (!report.screens.some((r) => r.id === s.id)) {
            rec({ id: s.id, label: s.label, area: s.area, surface: s.surface, ok: false, error: `boot 패스 실패: ${msg}` })
          }
        }
        console.log(`FAIL boot:${key} — ${msg}`)
      }
    }
  } else {
    for (const s of SCREENS.filter((s) => s.boot && wanted(s))) {
      rec({ id: s.id, label: s.label, area: s.area, ok: false, skipped: true, reason: '--no-boot' })
    }
  }
} catch (e) {
  report.fatal = String(e.stack ?? e.message ?? e).slice(0, 900)
  console.log(`FATAL — ${report.fatal.split('\n')[0]}`)
}

// 치우기만 하고 못 지운 옛 홈들 — 마지막에 한 번 더 시도(정션이라 실홈은 안 건드린다)
for (const d of staleHomes) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* 다음 실행에서 */ } }

// 스크래치 원복 — viewer-code-saved가 실제로 파일을 저장하므로 다음 실행 기준선을 맞춘다
try { fs.writeFileSync(scratch.sample, SCRATCH_SNAPSHOT) } catch { /* 무시 */ }

// ── 요약 ────────────────────────────────────────────────────────────────────────
//
// --merge: --only로 실패 화면만 고쳐 다시 돌릴 때, 이번에 안 돈 화면의 기록을 지우지
// 않는다(png는 어차피 이전 실행 것이 남아 있다). 병합 없이 --only를 쓰면 report.json이
// 그 몇 줄로 줄어들어 "전체 성공률"이 거짓말이 된다.
if (MERGE) {
  const prevFile = path.join(OUT, 'report.json')
  if (fs.existsSync(prevFile)) {
    try {
      const prev = JSON.parse(fs.readFileSync(prevFile, 'utf8'))
      const now = new Map(report.screens.map((r) => [r.id, r]))
      const order = new Map(SCREENS.map((s, i) => [s.id, i]))
      const merged = [...(prev.screens ?? []).filter((r) => !now.has(r.id)), ...report.screens]
      merged.sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999))
      report.screens = merged
      report.mergedFrom = prev.at
    } catch { /* 이전 리포트가 깨졌으면 이번 것만 남긴다 */ }
  }
}

const defined = SCREENS.filter((s) => !s.internal).length
const skipped = report.screens.filter((r) => r.skipped)
const attempted = report.screens.filter((r) => !r.skipped)
const okRows = attempted.filter((r) => r.ok)
const rate = attempted.length ? Math.round((okRows.length / attempted.length) * 1000) / 10 : 0
report.summary = {
  defined,
  attempted: attempted.length,
  ok: okRows.length,
  failed: attempted.length - okRows.length,
  skipped: skipped.length,
  successRatePct: rate
}
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2))

console.log('\n──────────────── 요약 ────────────────')
console.log(`정의 ${defined} · 시도 ${attempted.length} · 성공 ${okRows.length} · 실패 ${attempted.length - okRows.length} · skip ${skipped.length}`)
console.log(`성공률(skip 제외): ${rate}%`)
if (attempted.length - okRows.length) {
  console.log('\n실패:')
  for (const r of attempted.filter((x) => !x.ok)) console.log(`  ${r.id} — ${r.error}`)
}
console.log(`\nsaved: bench/shots/${kind}/report.json`)
