/**
 * M-UI R1 크리틱 — **무변경 화면 파리티 재검증(넓힌 판)**.
 *
 * 빌더는 M-UI 직전/적용 두 빌드로 8화면을 찍어 전부 0px이라고 보고했다. 그런데 그 8개 중
 * `chat-header`·`composer`·`workbar`는 **같은 프레임**이라(SHA 동일) 실제 고유 프레임은 6개고,
 * 사이드바·Git·뷰어·설정·멀티·토스트는 한 장도 없다. `styles.css`는 그 표면들이 **같이 쓰는**
 * 파일이고, M-UI는 그 안에서 `.notice-row`·`.error-row`·`.stopline`·`.cmd-card*`·`.qa*` 블록을
 * **삭제 후 신설**했다. 새 셀렉터가 밖으로 새면 그건 저 표면들에서 보인다.
 *
 *   node docs/critic/tools/critic-mui-parity.mjs <exeBase> <exeNew> <outDir> [--only=a,b]
 *
 * 빌더 하네스(%TEMP%/mui-density/mui-parity.mjs)의 절차를 그대로 쓴다(같은 픽스처·같은 창
 * 정착 재확정·같은 스크롤 못박기) — 다른 건 화면 목록과 포트·홈뿐이다.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const REPO = 'C:/Code/AgentCodeGUI'
const lib = await import(pathToFileURL(path.join(REPO, 'bench', 'lib.mjs')).href)
const fixture = await import(pathToFileURL(path.join(REPO, 'bench', 'fixture.mjs')).href)
const screens = await import(pathToFileURL(path.join(REPO, 'bench', 'screens.mjs')).href)
const { Cdp, cdpTargets, killTree, sleep } = lib
const { SCREENS, HELPERS_JS, DIRTY_SEL, makeCtx, augmentFixture, makeScratch, primeJs } = screens

const EXES = [process.argv[2], process.argv[3]]
const OUTDIR = process.argv[4]
const onlyArg = process.argv.find((a) => a.startsWith('--only='))
const DEFAULT_ONLY = [
  // 채팅 표면 (빌더 목록 — 재현 확인용)
  'chat-header', 'composer', 'workbar', 'chat-welcome', 'explorer-tree',
  'composer-picker-pop', 'composer-slash-palette', 'workbar-todo-pop',
  // 빌더가 한 장도 안 찍은 표면들
  'chat-find', 'chat-jump-bottom', 'error-boundary',
  'sidebar', 'sidebar-empty', 'sidebar-ctx-menu', 'sidebar-deleteall-confirm',
  'new-chat-step1', 'prompt-library-list',
  'explorer-git-strip', 'explorer-search', 'explorer-hidden-on', 'explorer-ctx-menu', 'explorer-blank',
  'changed-files-modal', 'subagent-modal', 'bgtask-modal',
  'viewer-code-read', 'viewer-diff-on', 'viewer-markdown-preview', 'viewer-empty', 'viewer-maximized',
  'git-changes', 'git-history', 'git-commit-detail',
  'settings-profile', 'settings-api', 'settings-display',
  'multi-grid-empty', 'multi-grid-counts', 'multi-panel-expanded',
  'toast-single', 'toast-aggregate'
].join(',')
const ONLY = new Set((onlyArg ? onlyArg.slice(7) : DEFAULT_ONLY).split(',').filter(Boolean))
const VIEW = { width: 1440, height: 900 }
const scratch = makeScratch(REPO)

async function runOne(exe, tag, port) {
  const HOME = path.join(os.tmpdir(), `ccg-muicrit-parity-${tag}`)
  const OUT = path.join(OUTDIR, tag)
  fs.rmSync(HOME, { recursive: true, force: true })
  fs.mkdirSync(OUT, { recursive: true })
  fixture.makeFixtureHome(HOME, '3.0.0-beta.1')
  augmentFixture(HOME, { repo: REPO })
  // 알림 7종을 스레드에서 뺀다 — 알림이 보이는 화면은 정의상 '변경 화면'(기준=목업)이라
  // 0px을 요구할 수 없다. 재는 것은 "알림 **밖**의 픽셀이 움직였는가"다.
  {
    const f = path.join(HOME, 'chats', 'fix-long-thread.json')
    const c = JSON.parse(fs.readFileSync(f, 'utf8'))
    const NTF = new Set(['notice', 'qa', 'cmdresult', 'interrupted', 'fallback', 'boundary'])
    c.snapshot.messages = c.snapshot.messages.filter((m) => !NTF.has(m.kind))
    fs.writeFileSync(f, JSON.stringify(c))
  }
  const child = spawn(exe, [], { env: { ...process.env, CCG_HOME: HOME, CCG_CDP_PORT: String(port) }, cwd: REPO, stdio: 'ignore' })
  const rows = []
  let cdp = null
  try {
    const t0 = Date.now()
    for (;;) {
      try {
        const ts = await cdpTargets(port)
        const t = ts.find((x) => x.type === 'page' && !x.url.includes('#') && /index\.html|localhost/.test(x.url) && !/toast|tray/.test(x.url))
        if (t?.webSocketDebuggerUrl) { cdp = await Cdp.connect(t.webSocketDebuggerUrl); break }
      } catch { /* not yet */ }
      if (Date.now() - t0 > 90000) throw new Error('no main target')
      await sleep(120)
    }
    await cdp.send('Page.enable').catch(() => {})
    await cdp.send('Runtime.enable').catch(() => {})
    await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 14, g: 16, b: 22, a: 1 } }).catch(() => {})
    const setBounds = async () => {
      try {
        const { windowId } = await cdp.send('Browser.getWindowForTarget', {})
        await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
        await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: 40, top: 40, width: VIEW.width, height: VIEW.height } })
      } catch { /* 미지원 */ }
    }
    await setBounds()
    await sleep(700)
    for (;;) {
      const ok = await cdp.eval(`!!document.getElementById('root') && document.getElementById('root').children.length > 0`).catch(() => false)
      if (ok) break
      if (Date.now() - t0 > 120000) throw new Error('never mounted')
      await sleep(150)
    }
    await sleep(3500)
    for (let i = 0; i < 12; i++) {
      const wh = await cdp.eval(`[window.innerWidth, window.innerHeight]`).catch(() => null)
      if (wh && wh[0] === VIEW.width) break
      await setBounds()
      await sleep(500)
    }
    const vp = await cdp.eval(`[window.innerWidth, window.innerHeight, window.devicePixelRatio]`).catch(() => null)
    console.error(`[${tag}] viewport ${JSON.stringify(vp)}`)
    await sleep(800)
    const ctx = makeCtx(cdp, { home: HOME, repo: REPO, app: 'tauri', ...scratch })
    await cdp.eval(HELPERS_JS)
    await cdp.eval(primeJs(REPO))
    for (const s of SCREENS.filter((x) => ONLY.has(x.id))) {
      const row = { id: s.id, ok: false }
      const t2 = Date.now()
      try {
        await cdp.eval(HELPERS_JS)
        await s.reach(cdp, ctx)
        const t1 = Date.now()
        for (;;) {
          const n = await cdp.eval(`document.querySelectorAll(${JSON.stringify(s.assert)}).length`).catch(() => 0)
          if (n >= (s.assertMin ?? 1)) break
          if (Date.now() - t1 > 9000) throw new Error(`assert 실패: ${s.assert}`)
          await sleep(120)
        }
        await cdp.eval(`(() => { const s = document.querySelector('.chat-scroll'); if (s) s.scrollTop = s.scrollHeight; return true })()`).catch(() => {})
        await sleep(400)
        await cdp.eval(`(() => { const s = document.querySelector('.chat-scroll'); if (s) s.scrollTop = s.scrollHeight; return true })()`).catch(() => {})
        await sleep(s.settle ?? 400)
        const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
        const buf = Buffer.from(r.data, 'base64')
        fs.writeFileSync(path.join(OUT, `${s.id}.png`), buf)
        row.sha = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)
        row.bytes = buf.length
        row.ok = true
      } catch (e) {
        row.error = String(e.message ?? e).slice(0, 200)
      }
      row.ms = Date.now() - t2
      try { if (s.reset) await s.reset(cdp, ctx) } catch { /* 무시 */ }
      for (let i = 0; i < 6; i++) {
        const d = await cdp.eval(`document.querySelectorAll(${JSON.stringify(DIRTY_SEL)}).length`).catch(() => 0)
        if (!d) break
        await ctx.esc(1)
        await sleep(220)
      }
      console.error(`[${tag}] ${row.id} ${row.ok ? row.sha : 'ERR ' + row.error}`)
      rows.push(row)
    }
  } finally {
    if (cdp) try { cdp.close() } catch { /* 닫힘 */ }
    killTree(child.pid)
    await sleep(1200)
  }
  return rows
}

fs.mkdirSync(OUTDIR, { recursive: true })
const a = await runOne(EXES[0], 'base', 9481)
const b = await runOne(EXES[1], 'new', 9482)
const byId = (rs) => Object.fromEntries(rs.map((r) => [r.id, r]))
const A = byId(a)
const B = byId(b)
const out = []
for (const id of ONLY) {
  const x = A[id]
  const y = B[id]
  out.push({
    id,
    baseOk: !!x?.ok,
    newOk: !!y?.ok,
    same: !!(x?.ok && y?.ok && x.sha === y.sha),
    baseSha: x?.sha ?? null,
    newSha: y?.sha ?? null,
    baseErr: x?.error ?? null,
    newErr: y?.error ?? null
  })
}
const uniqBase = new Set(out.filter((r) => r.baseOk).map((r) => r.baseSha))
const summary = {
  screens: out.length,
  captured: out.filter((r) => r.baseOk && r.newOk).length,
  identical: out.filter((r) => r.same).length,
  differ: out.filter((r) => r.baseOk && r.newOk && !r.same).map((r) => r.id),
  failed: out.filter((r) => !r.baseOk || !r.newOk).map((r) => r.id),
  uniqueFramesBase: uniqBase.size
}
fs.writeFileSync(path.join(OUTDIR, 'parity.json'), JSON.stringify({ at: new Date().toISOString(), view: VIEW, exes: EXES, summary, rows: out }, null, 1))
console.log(JSON.stringify(summary, null, 1))
