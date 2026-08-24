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
//  - 배경만 두 앱에 똑같이 강제한다(기본 배경 오버라이드). 아크릴 블러는 CDP 캡처에
//    애초에 안 담기므로, 투명 대신 같은 불투명 배경을 깔아야 "한쪽만 배경이 비침" 같은
//    가짜 차이가 안 생긴다.
//  - 창 크기는 **강제하지 않는다**. `Browser.setWindowBounds`가 3.0에만 먹는 한쪽짜리
//    레버라, 강제하면 두 앱 사진이 서로 다른 캔버스가 된다(settleWindowSize 주석).
//    대신 앱이 자기 크기를 적용할 때까지 기다렸다 찍고, 끝에 반대편 리포트와 맞춰 본다.
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
// 공용 target/release/agentcodegui.exe가 **옆 에이전트가 띄워 둔 앱에 잠겨** 있으면
// 새 빌드를 그 자리에 못 넣는다(EBUSY). 그때 격리 CARGO_TARGET_DIR의 exe를 바로 지목한다.
const exeArg = argv.find((a) => a.startsWith('--exe='))
const EXE = exeArg ? exeArg.slice(6) : undefined

// --tag=<name> — 산출을 `bench/shots/<kind>-<name>/`으로 돌린다.
// 왜 필요한가: `bench/shots/<kind>/report.json`은 최종 파리티 R1의 **증거 파일**이다.
// 하네스를 고친 뒤 몇 화면만 재주행하면서 그 리포트에 덮어쓰면 R1의 수치(성공률·실패
// 목록)를 되짚을 수 없게 된다. 홈과 CDP 포트도 태그로 갈라 다른 갈래의 동시 실행과
// 겹치지 않게 한다(같은 워크트리에서 3갈래가 동시에 돈다).
// --port=<n> — 포트를 직접 지정(태그 해시가 남의 포트와 겹칠 때).
const tagArg = argv.find((a) => a.startsWith('--tag='))
const TAG = tagArg ? tagArg.slice(6).replace(/[^\w.-]/g, '') : ''
const portArg = argv.find((a) => a.startsWith('--port='))
const hashTag = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 400, 7)
const basePort = kind === 'tauri' ? 9346 : 9345
const PORT = portArg ? Number(portArg.slice(7)) : TAG ? 9500 + hashTag(TAG) * 2 + (kind === 'tauri' ? 1 : 0) : basePort

const profile = kind === 'tauri' ? tauriProfile({ port: PORT, exe: EXE }) : electronProfile({ port: PORT })
const APP_VERSION = kind === 'tauri' ? '3.0.0-beta.1' : '2.6.2'
const HOME = path.join(os.tmpdir(), `ccg-screens-${kind}${TAG ? '-' + TAG : ''}`)
const OUT = path.join(REPO, 'bench', 'shots', kind + (TAG ? '-' + TAG : ''))
const SIBLING_OUT = path.join(REPO, 'bench', 'shots', (kind === 'tauri' ? 'electron' : 'tauri') + (TAG ? '-' + TAG : ''))

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

/**
 * 캔버스를 **강제하지 않고**, 앱이 자기 창 크기를 적용할 때까지 기다렸다 그 값을 받는다.
 *
 * ★ 왜 강제를 버렸나 (M12 R2가 원인까지 파 놓고, R28b GIT R1 확인 크리틱이 그 대가를 잡았다)
 *   `Browser.setWindowBounds`는 **Electron에서 안 먹는다**(CDP Browser 도메인 미지원 —
 *   당시 리포트가 `windowSized: tauri true / electron false`로 스스로 적어 뒀다).
 *   즉 그건 한쪽짜리 레버라, 강제하면 3.0만 1440×900으로 끌려가고 2.6.2는 자기 기본값
 *   1320×880에 남는다. 그렇게 찍힌 19화면 A/B의 본 패스 17행은 **서로 다른 캔버스**의
 *   사진 쌍이었고, 픽셀 비교의 전제가 깨진 채 파리티 근거로 쓰일 뻔했다.
 *   두 앱은 같은 기본 창 크기를 쓴다(2.6.2 `src/main/index.ts` DEFAULT_STATE 1320×880 —
 *   3.0이 그대로 승계). **기다리면 저절로 같아진다** — 그게 M12 R2가 적어 둔 처방이다.
 *
 * 배경 오버라이드(`prepPage`)는 그대로 둔다: 그건 두 앱에 **똑같이** 먹는다.
 */
async function settleWindowSize(cdp, { ms = 15000, stableFor = 3, interval = 250 } = {}) {
  const t0 = Date.now()
  let last = null
  let streak = 0
  for (;;) {
    const vp = await cdp.eval(`[innerWidth, innerHeight]`).catch(() => null)
    if (Array.isArray(vp) && vp[0] > 0) {
      const key = vp.join('x')
      streak = key === last ? streak + 1 : 1
      last = key
      if (streak >= stableFor) return { vp, ms: Date.now() - t0, settled: true }
    }
    if (Date.now() - t0 > ms) {
      return { vp: last ? last.split('x').map(Number) : null, ms: Date.now() - t0, settled: false }
    }
    await sleep(interval)
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
/**
 * 찍고, **사진 자신의 픽셀 크기**를 돌려준다(PNG IHDR).
 * 리포트가 사진의 크기를 들고 있으면 「리포트와 사진이 다른 말을 한다」가 다음 감사에서
 * 손검사 없이 잡힌다 — R28b GIT R1의 실패는 정확히 그 대조를 사람이 해야 했던 자리다.
 */
async function shoot(cdp, id) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const buf = Buffer.from(r.data, 'base64')
  fs.writeFileSync(path.join(OUT, `${id}.png`), buf)
  return buf.length > 24 ? [buf.readUInt32BE(16), buf.readUInt32BE(20)] : null
}

/** 못 찍은 화면의 옛 PNG를 치운다 — 실패 행 옆에 남은 사진은 거짓 증거다. */
function dropStalePng(id, row) {
  const p = path.join(OUT, `${id}.png`)
  try {
    if (fs.existsSync(p)) {
      fs.rmSync(p)
      row.stalePngRemoved = true
    }
  } catch { /* 잠겼으면 다음 판에서 */ }
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
// `canvas`는 **잰 값**이다(옛 `viewport: VIEW`는 강제하려던 값이라, 강제가 한쪽에만
// 먹는 순간 리포트가 자기 사진과 다른 숫자를 적게 됐다 — R28b GIT R1이 그렇게 어긋났다).
const report = {
  app: profile.name,
  kind,
  at: new Date().toISOString(),
  sizePolicy: 'app-own — 하네스가 창 크기를 강제하지 않는다(settleWindowSize)',
  canvas: null,
  screens: []
}
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
    if (!(await waitMounted(cdp, 90000))) throw new Error('renderer never mounted')
    await sleep(3500) // 스레드 하이드레이션·git 스트립·아바타 안정화
    // 캔버스는 강제하지 않고 **앱이 자기 크기를 적용한 뒤** 읽는다(settleWindowSize 주석).
    const settled = await settleWindowSize(cdp)
    report.canvas = settled.vp
    report.canvasSettled = settled.settled
    console.log(`[ab] 캔버스 ${JSON.stringify(settled.vp)}${settled.settled ? '' : ' (안정화 못 함)'} — ${settled.ms}ms`)

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
          ctx._shotPng = await shoot(cdp, id)
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
      // 캡처를 실제로 한 창 — 독립 창 화면이면 그쪽이다. viewport를 **그 창에서** 읽으려고
      // 루프 스코프에 둔다(M12 R2가 부팅 패스에만 남긴 기록을 본 패스로 끌어올린다).
      let shotCdp = cdp
      ctx._shotFound = null
      ctx._shotPng = null
      try {
        await cdp.eval(HELPERS_JS)
        await s.reach(cdp, ctx)
        if (s.selfShot) {
          // reach가 ctx.snapWhen으로 판정+촬영을 한꺼번에 끝낸 화면
          if (!ctx._shotFound) throw new Error('selfShot: reach가 캡처 시점을 보고하지 않음')
          row.found = ctx._shotFound
          row.png = ctx._shotPng ?? null
          row.capturedInReach = true
        } else {
          if (s.win) shotCdp = sub = await wh.attachWindow(s.win, 15000)
          if (s.win) await sleep(600)
          row.found = await assertOn(shotCdp, s.assert, s.assertMin ?? 1, 9000)
          await sleep(s.settle ?? 400)
          if (!s.internal) row.png = await shoot(shotCdp, s.id)
        }
        row.ok = true
      } catch (e) {
        row.error = String(e.message ?? e).slice(0, 300)
      }
      // ★ 캔버스 크기는 **모든 행**에 남긴다. M12 R2는 이 줄을 부팅 패스(bootPass)에만
      //   넣어서, 그 라운드가 실측으로 밝힌 「두 앱 캔버스 어긋남」을 본 패스 18행에서는
      //   다시 눈으로 찾아야 했다. reset 전에 읽는다 — reset이 창을 닫을 수 있다.
      row.viewport = await shotCdp.eval(`[innerWidth, innerHeight]`).catch(() => null)
      // 실패한 행이 **옛 실행의 PNG**를 남겨 두면 그 사진이 이번 판의 증거처럼 읽힌다 —
      // R28b GIT R1의 settings-engine-confirm 두 장이 정확히 그랬다(두 시간 전 실행분).
      if (!row.ok && !s.internal) dropStalePng(s.id, row)
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
    // ── 스플래시: 별도 창이 있으면 그걸, 없으면 창 안 오버레이를 잡는다 ──────────
    //
    // ★ R1 §5-5. 예전엔 `data:` 창만 노렸고, 3.0은 그 창을 없앤 구조 변경(웹뷰 +1 회피)
    // 이라 **의도된 차이가 실패로 집계**됐다. 앱별 분기 대신 러너가 두 자리를 순서대로
    // 본다 — 화면 정의(screens.mjs)는 여전히 한 벌이고, 셀렉터만 두 구현의 합집합이다.
    //
    // 판정과 촬영은 **같은 순간**이다(selfShot 규약). 스플래시는 한 프레임짜리라
    // assert → sleep → shoot로 나누면 "있었는데 못 찍었다"가 된다.
    if (v.early) {
      // 캔버스 크기는 **찍은 그 창에서, 찍은 직후** 읽는다. 2.6.2의 스플래시는 기동과
      // 동시에 닫히는 별도 창이라 몇 백 ms만 늦어도 eval이 죽어 `viewport:null`이 된다(실측).
      const shotWhen = async (c, s, ms, interval = 12) => {
        const t1 = Date.now()
        for (;;) {
          const n = await c.eval(`document.querySelectorAll(${JSON.stringify(s.assert)}).length`).catch(() => 0)
          if (n >= (s.assertMin ?? 1)) {
            const png = await shoot(c, s.id)
            return { n, png, vp: await c.eval(`[innerWidth, innerHeight]`).catch(() => null) }
          }
          if (Date.now() - t1 > ms) throw new Error(`스플래시 셀렉터 미포착: ${s.assert}`)
          await sleep(interval)
        }
      }

      // 1단 — 별도 창(2.6.2). 기동과 동시에 사라지므로 25ms 간격으로 훑는다.
      const deadline = Date.now() + (v.earlyMs ?? 12000)
      let done = false
      while (Date.now() < deadline && !done) {
        try {
          const ts = await cdpTargets(profile.port)
          const t = ts.find((x) => x.type === 'page' && x.url.startsWith(v.early))
          if (t) {
            const c = await Cdp.connect(t.webSocketDebuggerUrl)
            await prepPage(c, { bg: false })
            for (const s of screens) {
              const row = { id: s.id, label: s.label, area: s.area, surface: s.surface, ok: false, ms: Date.now() - t0, via: 'separate-window' }
              // 스플래시는 두 앱의 캔버스가 **일부러** 다르다(2.6.2 별도 창 vs 3.0 창 안
              // 오버레이). M12 R2가 손으로 적어 둔 그 사실을 행에 남긴다.
              try { const got = await shotWhen(c, s, 3000); row.found = got.n; row.viewport = got.vp; row.png = got.png; row.ok = true }
              catch (e) { row.error = String(e.message ?? e).slice(0, 300) }
              if (!row.ok) dropStalePng(s.id, row)
              rec(row)
              console.log(`${row.ok ? 'OK ' : 'FAIL'} ${s.id} (boot:${variantKey}/별도창)${row.error ? ' — ' + row.error : ''}`)
            }
            c.close()
            done = true
          }
        } catch { /* 아직 */ }
        await sleep(25)
      }
      if (done) return

      // 2단 — 창 안 오버레이(3.0). 리로드로 스플래시를 **다시 만든다**: 오버레이는
      // initialization_script라 새 문서마다 다시 돈다. CPU를 조이지 않으면 React 마운트가
      // 300ms대라 폴링 사이로 빠져나간다.
      const fb = v.reloadFallback
      if (!fb) {
        for (const s of screens) { rec({ id: s.id, label: s.label, area: s.area, ok: false, error: `${v.early} 스플래시 타깃을 ${v.earlyMs ?? 12000}ms 안에 잡지 못함` }); console.log(`FAIL ${s.id} (boot:${variantKey}) — 스플래시 타깃 미포착`) }
        return
      }
      console.log(`[ab] boot:${variantKey} — 별도 창 없음. 창 안 오버레이로 재시도(리로드 + CPU×${fb.throttle})`)
      const c = await connectMain(profile.port, 90000)
      try {
        await prepPage(c, { bg: false })
        // 크기 강제 없음 — 스플래시는 한 프레임짜리라 settle을 못 기다린다. 그래서 더더욱
        // 강제하면 안 된다(강제는 3.0에만 먹어 두 앱 캔버스를 갈라놓는다).
        for (const s of screens) {
          const row = { id: s.id, label: s.label, area: s.area, surface: s.surface, ok: false, ms: 0, via: 'in-window-overlay' }
          const st = Date.now()
          try {
            await c.send('Emulation.setCPUThrottlingRate', { rate: fb.throttle }).catch(() => {})
            await c.send('Page.reload', { ignoreCache: false })
            const got = await shotWhen(c, s, fb.ms ?? 25000)
            row.found = got.n
            row.viewport = got.vp
            row.png = got.png
            row.ok = true
          } catch (e) { row.error = String(e.message ?? e).slice(0, 300) }
          await c.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {})
          if (!row.ok) dropStalePng(s.id, row)
          row.ms = Date.now() - st
          rec(row)
          console.log(`${row.ok ? 'OK ' : 'FAIL'} ${s.id} (boot:${variantKey}/창안)${row.error ? ' — ' + row.error : ''}`)
        }
      } finally { try { c.close() } catch { /* 닫힘 */ } }
      return
    }

    cdp = await connectMain(profile.port, 90000)
    await prepPage(cdp)
    if (v.throttle) await cdp.send('Emulation.setCPUThrottlingRate', { rate: v.throttle }).catch(() => {})
    // ★ M12 R2가 원인까지 팠고, R28b GIT R1 확인 크리틱이 그 대가를 잡은 자리.
    //   `Browser.setWindowBounds`는 3.0에만 먹는 한쪽짜리 레버라 **강제를 아예 뺐다**
    //   (settleWindowSize 주석). 두 앱의 캔버스가 같아지는 이유는 CDP가 아니라 같은 기본
    //   창 크기다(2.6.2 `src/main/index.ts:293` DEFAULT_STATE 1320×880 — 3.0이 승계).
    // 한 프레임짜리 화면(multi-hydrate·스플래시)은 마운트를 기다리면 놓치므로 **옵트인**이다.
    if (v.settleSize) {
      await waitMounted(cdp, 90000)
      await sleep(1200)
      const settled = await settleWindowSize(cdp)
      console.log(`[ab] boot:${variantKey} 캔버스 ${JSON.stringify(settled.vp)}${settled.settled ? '' : ' (안정화 못 함)'}`)
    }
    for (const s of screens) {
      const row = { id: s.id, label: s.label, area: s.area, surface: s.surface, ok: false, ms: 0 }
      const st = Date.now()
      try {
        row.found = await assertOn(cdp, s.assert, s.assertMin ?? 1, v.throttle ? 25000 : 40000)
        await sleep(250)
        row.png = await shoot(cdp, s.id)
        row.ok = true
      } catch (e) { row.error = String(e.message ?? e).slice(0, 300) }
      row.viewport = await cdp.eval(`[innerWidth, innerHeight]`).catch(() => null)
      if (!row.ok) dropStalePng(s.id, row)
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
let prev = null
// ①번 경고가 볼 것은 **이번 판이 실제로 돈 행 수**다(병합 뒤 총계가 아니다).
// --merge를 붙이면 총계는 당연히 --only보다 많아지므로, 병합 전에 세어 둔다.
const ranRows = report.screens.length
try { prev = JSON.parse(fs.readFileSync(path.join(OUT, 'report.json'), 'utf8')) } catch { /* 없거나 깨짐 */ }
const ORDER = new Map(SCREENS.map((s, i) => [s.id, i]))
if (MERGE && prev) {
  try {
    const now = new Map(report.screens.map((r) => [r.id, r]))
    report.screens = [...(prev.screens ?? []).filter((r) => !now.has(r.id)), ...report.screens]
    report.mergedFrom = prev.at
  } catch { /* 이전 리포트가 깨졌으면 이번 것만 남긴다 */ }
}
// 행 순서는 **항상 screens.mjs 정의 순서**다. 예전엔 병합할 때만 정렬해서, 통짜 실행은
// 실행 순서(본 패스 → 부팅)로 남고 병합본은 정의 순서로 남았다 — 두 앱 리포트를 나란히
// 놓고 비교하는 것이 파리티 감사가 하는 일인데, 그때 행이 서로 밀려 있었다.
report.screens.sort((a, b) => (ORDER.get(a.id) ?? 999) - (ORDER.get(b.id) ?? 999))

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
// ── 리포트가 조용히 줄어드는 것을 막는 경고 둘 (stderr) ─────────────────────────
//  ① --only로 고른 개수와 집계 행 수가 어긋남 = 도달 못 한 화면이 통째로 빠졌다는 뜻.
//  ② --merge 없이 **더 짧은** 리포트로 덮어쓰기 — M12 R2의 19행 증거가 단건 재주행에
//     덮여 1행으로 남은 그 사고다. ①만으로는 안 잡힌다(1개 요청·1행이면 숫자는 맞다).
if (ONLY && ranRows !== ONLY.size) {
  console.error(`[ab] 경고 — --only ${ONLY.size}개인데 이번 판이 남긴 건 ${ranRows}행 — 도달 못 한 화면이 통째로 빠졌다`)
}
if (!MERGE && (prev?.screens?.length ?? 0) > report.screens.length) {
  console.error(`[ab] 경고 — 이전 리포트 ${prev.screens.length}행을 ${report.screens.length}행으로 덮어쓴다. 단건 재주행이면 --merge를 붙여라`)
}

// ── ③ 리포트가 **자기 사진과 다른 말**을 하는지 ─────────────────────────────────
// row.viewport(잰 캔버스)와 row.png(PNG IHDR의 실제 픽셀)가 어긋나면, 그 행의 숫자로는
// 사진을 설명할 수 없다. R28b GIT R1에서 이 대조는 사람이 해야 했고, 그래서 안 됐다.
const pngOff = report.screens
  .filter((r) => r.png && r.viewport && String(r.png) !== String(r.viewport))
  .map((r) => `${r.id} vp${JSON.stringify(r.viewport)}≠png${JSON.stringify(r.png)}`)
if (pngOff.length) {
  report.pngViewportOff = pngOff
  console.error(`[ab] 경고 — 리포트 숫자와 PNG 픽셀이 다른 행 ${pngOff.length}개: ${pngOff.slice(0, 3).join(' · ')}`)
}

// ── ④ 두 앱의 캔버스가 어긋난 채로 남는 것을 막는다 ─────────────────────────────
//
// A/B 사진 쌍은 **같은 캔버스**일 때만 픽셀 비교의 근거가 된다. R28b GIT R1은 3.0만
// 1440×900으로 강제된 채 17행을 찍고도 그 사실을 모른 채 「두 앱 모두 1320×880」이라고
// 적었다(리포트 자신은 반대를 적고 있었다). 이제 하네스가 반대편 리포트를 열어 화면별로
// 맞춰 보고, 어긋나면 stderr로 말하고 `canvasMismatch`에 남긴다.
// 스플래시는 구조가 **일부러** 다르다(2.6.2 별도 창 300×240 vs 3.0 창 안 오버레이) —
// 그 행은 `via`가 이미 이유를 적고 있으므로 어긋남으로 세지 않는다.
try {
  const other = JSON.parse(fs.readFileSync(path.join(SIBLING_OUT, 'report.json'), 'utf8'))
  const om = new Map((other.screens ?? []).filter((r) => r.viewport).map((r) => [r.id, r.viewport]))
  const mismatch = report.screens
    .filter((r) => r.viewport && om.has(r.id) && String(om.get(r.id)) !== String(r.viewport))
    .filter((r) => !r.via) // via가 붙은 행 = 구조가 일부러 다른 자리(스플래시)
    .map((r) => `${r.id} ${JSON.stringify(r.viewport)}≠${JSON.stringify(om.get(r.id))}`)
  report.canvasComparedWith = { app: other.app, at: other.at, rows: om.size }
  report.canvasMismatch = mismatch
  if (mismatch.length) {
    console.error(`[ab] 경고 — 두 앱 캔버스가 다른 화면 ${mismatch.length}개: ${mismatch.slice(0, 4).join(' · ')}${mismatch.length > 4 ? ' …' : ''}`)
    console.error('[ab]        이 사진들은 픽셀 비교의 근거가 못 된다(캔버스가 다르면 레이아웃이 달라진다).')
  }
} catch { /* 반대편 리포트가 아직 없다 — 두 앱을 다 돌리면 채워진다 */ }

fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2))

console.log('\n──────────────── 요약 ────────────────')
console.log(`정의 ${defined} · 시도 ${attempted.length} · 성공 ${okRows.length} · 실패 ${attempted.length - okRows.length} · skip ${skipped.length}`)
console.log(`성공률(skip 제외): ${rate}%`)
if (attempted.length - okRows.length) {
  console.log('\n실패:')
  for (const r of attempted.filter((x) => !x.ok)) console.log(`  ${r.id} — ${r.error}`)
}
console.log(`\nsaved: ${path.relative(REPO, path.join(OUT, 'report.json')).replace(/\\/g, '/')}`)
