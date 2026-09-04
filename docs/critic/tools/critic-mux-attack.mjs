#!/usr/bin/env node
/* ============================================================================
 * critic-mux-attack — M-UX 렌더러 1단계(커밋 d62ce52) **공격** 하네스.
 *
 * poc-dial.mjs가 "계약대로 되는가"를 물었다면 여기는 "안 밟은 경로에서 깨지는가"를
 * 묻는다. 재현이 아니라 반증이 목적이므로, 각 단계는 **깨질 만한 순서**로 조작한다.
 *
 *   node docs/critic/tools/critic-mux-attack.mjs --only=spam,geom,side,viewer
 *   node docs/critic/tools/critic-mux-attack.mjs --only=queue,busydel,mid   (실 CLI 필요)
 *
 * ── 안전 규칙 (사용자 실앱이 떠 있다) ───────────────────────────────────────
 *  · 이름 기반 kill 금지 — 죽이는 것은 이 스크립트가 spawn한 PID 트리뿐.
 *  · 실홈은 읽기/복사만(자격증명 복사, engines 정션).
 *  · 앱 홈은 CCG_HOME으로 격리(.critic-home-mux*).
 * ========================================================================== */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { connectMainPage, killTree, sleep, REPO, resolveTauriExe } from '../../../bench/lib.mjs'
import { makeMultiFixture } from '../../../bench/fixture.mjs'

const args = process.argv.slice(2)
const ONLY = new Set(((args.find((a) => a.startsWith('--only=')) ?? '').split('=')[1] || 'all').split(',').filter(Boolean))
const want = (id) => ONLY.has('all') || ONLY.has(id)
const KEEP = args.includes('--keep')
// M12 R2 — mainBinaryName 변경으로 exe 이름이 둘이다(구·신 모두 탐색·최신 mtime 우선)
const EXE = resolveTauriExe((process.argv.find((a) => a.startsWith('--exe=')) ?? '').split('=').slice(1).join('='))
const OUT = path.join(REPO, 'docs', 'critic', 'm-ux-r1-attack.json')
const APP_VERSION = '3.0.0-beta.1'

const rep = { at: new Date().toISOString(), exe: EXE, gitHead: '', steps: {}, findings: [] }
const fail = (id, why, extra) => {
  rep.findings.push({ id, why, ...(extra ? { detail: extra } : {}) })
  console.error(`  X ${id} — ${why}${extra ? ' ' + JSON.stringify(extra).slice(0, 400) : ''}`)
}
const ok = (id, v) => console.log(`  o ${id}${v === undefined ? '' : ' — ' + JSON.stringify(v).slice(0, 300)}`)

const HELPERS = `(() => {
  window.__c = (sel, n = 0) => { const e = document.querySelectorAll(sel)[n]; if (!e) return false; e.click(); return true }
  window.__n = (sel) => document.querySelectorAll(sel).length
  window.__txts = (sel) => [...document.querySelectorAll(sel)].map((e) => (e.textContent || '').trim())
  window.__rect = (sel, n = 0) => { const e = document.querySelectorAll(sel)[n]; if (!e) return null
    const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
  window.__mdown = (sel, n = 0) => { const e = document.querySelectorAll(sel)[n]; if (!e) return false
    e.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })); return true }
  window.__pick = (needle) => { const el = [...document.querySelectorAll('.sb-item')].find((e) => (e.textContent||'').includes(needle)); if (!el) return false; el.click(); return true }
  window.__ctx = (needle) => { const el = [...document.querySelectorAll('.sb-item')].find((e) => (e.textContent||'').includes(needle)); if (!el) return false
    const r = el.getBoundingClientRect()
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(r.x+20), clientY: Math.round(r.y+8) })); return true }
  window.__send = (text) => { const ta = document.querySelector('.composer-row textarea') || document.querySelector('textarea')
    if (!ta) return 'no-textarea'
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(ta, text)
    ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus()
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return 'sent' }
  window.__sendIn = (root, text) => { const ta = document.querySelector(root + ' textarea'); if (!ta) return 'no-textarea'
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(ta, text)
    ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus()
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return 'sent' }
  window.__sbItems = () => [...document.querySelectorAll('.sb-sec')].map((s) => ({
    label: (s.querySelector('.sb-label')?.childNodes[0]?.textContent || '').trim(),
    hint: (s.querySelector('.sb-foldhint')?.textContent || '').trim(),
    items: [...s.querySelectorAll('.sb-item')].map((i) => ({
      t: (i.querySelector('.t .tx')?.textContent || '').trim(),
      chip: (i.querySelector('.slotchip')?.textContent || '').trim(),
      kind: i.querySelector('.slotchip.folded') ? 'folded' : i.querySelector('.slotchip.winchip') ? 'win' : i.querySelector('.slotchip') ? 'live' : '',
      dot: (i.querySelector('.dot')?.className || '').replace('dot', '').trim(),
      run: !!i.querySelector('.runbadge'),
      active: i.className.includes('active')
    }))
  }))
  return true
})()`

async function boot(home, port, extraEnv = {}) {
  const child = spawn(EXE, [], {
    env: { ...process.env, CCG_HOME: home, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  child.stdout.on('data', (d) => (log += d.toString()))
  child.stderr.on('data', (d) => (log += d.toString()))
  const cdp = await connectMainPage(port, { timeoutMs: 60_000 })
  for (let i = 0; i < 300; i++) {
    const up = await cdp
      .eval(`(async () => { try { return !!(await window.api.app.getVersion()) } catch { return false } })()`, { awaitPromise: true })
      .catch(() => false)
    if (up) break
    await sleep(100)
  }
  await cdp.eval(HELPERS)
  return { child, cdp, log: () => log }
}

async function waitFor(cdp, expr, { tries = 120, gap = 100 } = {}) {
  for (let i = 0; i < tries; i++) {
    const v = await cdp.eval(expr).catch(() => false)
    if (v) return v
    await sleep(gap)
  }
  return false
}
async function rmHome(dir, tries = 12) {
  for (let i = 0; i < tries; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return true } catch { await sleep(500) }
  }
  return false
}

/** 실 CLI 1턴을 돌릴 수 있는 격리 홈 — poc-dial.mjs seedBgHome과 같은 규약(복사·정션만) */
function seedCreds(home) {
  const realHome = path.join(os.homedir(), '.agentcodegui')
  const ver = JSON.parse(fs.readFileSync(path.join(realHome, 'config.json'), 'utf8')).activeVersion
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ activeVersion: ver }))
  if (!fs.existsSync(path.join(home, 'engines')))
    spawnSync('cmd', ['/c', 'mklink', '/J', path.join(home, 'engines'), path.join(realHome, 'engines')], { encoding: 'utf8' })
  const cli = path.join(home, 'engines', ver, 'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe')
  if (!fs.existsSync(cli)) throw new Error(`claude.exe 없음: ${cli}`)
  const accounts = JSON.parse(fs.readFileSync(path.join(realHome, 'accounts.json'), 'utf8'))
  const prefix = accounts.defaultEmail.replace('@', '_').replace('+', '-')
  const srcDir = fs.readdirSync(path.join(realHome, 'accounts')).find((n) => n === prefix || n.startsWith(prefix + '-'))
  if (!srcDir) throw new Error(`기본 계정 폴더 없음: ${prefix}`)
  for (const f of ['.credentials.json', '.claude.json']) {
    const s = path.join(realHome, 'accounts', srcDir, f)
    if (fs.existsSync(s)) {
      fs.mkdirSync(path.join(home, 'accounts', srcDir), { recursive: true })
      fs.copyFileSync(s, path.join(home, 'accounts', srcDir, f))
    }
  }
  fs.writeFileSync(path.join(home, 'accounts.json'), JSON.stringify(accounts))
  return ver
}

function seedChatHome(home, { mode = 'single' } = {}) {
  fs.rmSync(home, { recursive: true, force: true })
  const work = path.join(home, 'work')
  fs.mkdirSync(work, { recursive: true })
  fs.mkdirSync(path.join(home, 'chats'), { recursive: true })
  const ver = seedCreds(home)
  const chat = (id, title) => ({
    id, title, custom: true, manualCwd: work, refDirs: [],
    picker: { model: 'haiku', effort: 'minimal', mode: 'bypass' },
    snapshot: { messages: [] }, updatedAt: Date.now()
  })
  const w = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v)) }
  w(path.join(home, 'chats', 'index.json'), { version: 1, order: ['c-run', 'c-side'], activeChatId: 'c-run' })
  w(path.join(home, 'chats', 'c-run.json'), chat('c-run', 'ATK 도는 채팅'))
  w(path.join(home, 'chats', 'c-side.json'), chat('c-side', 'ATK 옆 채팅'))
  w(path.join(home, 'ui-prefs.json'), { 'ui.lang': 'ko', 'workspace.mode': mode, 'whatsnew.seenVersion': APP_VERSION, 'chat.zoom': 1, 'sidebar.autohide': false })
  w(path.join(home, 'profile.json'), { nickname: 'atk' })
  w(path.join(home, 'engine-auto-update.json'), { enabled: false })
  const realLocalState = path.join(os.homedir(), 'AppData', 'Roaming', 'agent-code-gui', 'Local State')
  if (fs.existsSync(realLocalState)) {
    fs.mkdirSync(path.join(home, 'userData'), { recursive: true })
    fs.copyFileSync(realLocalState, path.join(home, 'userData', 'Local State'))
  }
  return { ver, work }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. 다이얼 연타 — 1→6→1→6을 빠르게. 상태기계가 중간 프레임에 걸려 굳는가?
// ═══════════════════════════════════════════════════════════════════════════
async function stepSpam() {
  console.log('\n[spam] 다이얼 연타 1→6→1→6')
  const s = (rep.steps.spam = {})
  const HOME = path.join(REPO, '.critic-home-mux-spam')
  fs.rmSync(HOME, { recursive: true, force: true })
  makeMultiFixture(HOME, APP_VERSION, { panels: 6, itemsPerPanel: 4 })
  const app = await boot(HOME, 9371)
  try {
    if (!(await waitFor(app.cdp, `__n('.ma-grid > .ma-panel') === 6`))) return fail('spam.boot', '6자리 부팅 실패')
    const before = await app.cdp.eval(`__txts('.ma-grid > .ma-panel .ma-p-title')`)
    s.before = before
    // 연타 — 렌더 프레임보다 짧은 간격으로 다이얼을 두들긴다
    for (const seq of [[1, 6, 1, 6], [6, 1, 6, 1], [1, 3, 1, 6]]) {
      for (const n of seq) {
        await app.cdp.eval(`__c('.ma-count-btn[data-count="${n}"]')`)
        await sleep(30)
      }
      await sleep(700)
      const last = seq[seq.length - 1]
      const panels = await app.cdp.eval(`__n('.ma-grid > .ma-panel')`)
      const cls = await app.cdp.eval(`(document.querySelector('.ma-grid')||{}).className || ''`)
      const heads = await app.cdp.eval(`__n('.ma-head')`)
      const dials = await app.cdp.eval(`__n('.ma-count')`)
      const rec = { seq, want: last, panels, cls, heads, dials }
      ;(s.rounds ??= []).push(rec)
      if (panels !== last) fail('spam.count', `연타 후 자리 수가 ${last}이 아니다`, rec)
      if (dials !== 1) fail('spam.dial', `다이얼이 ${dials}개다(1이어야 한다)`, rec)
      if (last === 1 && heads !== 0) fail('spam.head', 'n1인데 .ma-head 줄이 남았다', rec)
      if (last > 1 && heads !== 1) fail('spam.head2', `n${last}인데 .ma-head가 ${heads}개다`, rec)
    }
    // 6으로 되돌린 뒤 대화 생존·순서
    await app.cdp.eval(`__c('.ma-count-btn[data-count="6"]')`)
    await waitFor(app.cdp, `__n('.ma-grid > .ma-panel') === 6`)
    const after = await app.cdp.eval(`__txts('.ma-grid > .ma-panel .ma-p-title')`)
    s.after = after
    const lost = before.filter((x) => !after.includes(x))
    if (lost.length) fail('spam.lost', '연타 후 사라진 대화가 있다', { lost, after })
    else ok('spam.survive', after)
    // 접힘 배지 잔상 — n6인데 배지가 남아 있으면 유령
    const badge = await app.cdp.eval(`__n('.ma-fold-badge')`)
    if (badge !== 0) fail('spam.badge-ghost', 'n6인데 접힘 배지가 남았다', { badge })
    else ok('spam.badge-clean')
    // 저장된 count가 화면과 같은가 (연타 중 마지막 값만 남아야 한다)
    await sleep(1200)
    const saved = await app.cdp.eval(`(async () => { const d = await window.api.multi.get(); return d?.sessions?.[0]?.count ?? d?.sessions?.['fix-multi-session']?.count ?? null })()`, { awaitPromise: true }).catch(() => null)
    s.savedCount = saved
    ok('spam.saved', { saved })
  } finally {
    killTree(app.child.pid)
    await sleep(800)
    if (!KEEP) await rmHome(HOME)
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. §2.1 규약 — "1↔2 전환에서 다이얼이 화면에서 움직이지 않는다"
// ═══════════════════════════════════════════════════════════════════════════
async function stepGeom() {
  console.log('\n[geom] 다이얼 x좌표 고정 규약(§2.1)')
  const s = (rep.steps.geom = {})
  const HOME = path.join(REPO, '.critic-home-mux-geom')
  fs.rmSync(HOME, { recursive: true, force: true })
  makeMultiFixture(HOME, APP_VERSION, { panels: 6, itemsPerPanel: 3 })
  const app = await boot(HOME, 9372)
  try {
    if (!(await waitFor(app.cdp, `__n('.ma-grid > .ma-panel') === 6`))) return fail('geom.boot', '6자리 부팅 실패')
    const at = {}
    for (const n of [6, 2, 1]) {
      await app.cdp.eval(`__c('.ma-count-btn[data-count="${n}"]')`)
      await waitFor(app.cdp, `__n('.ma-grid > .ma-panel') === ${n}`)
      await sleep(400)
      at['n' + n] = await app.cdp.eval(`__rect('.ma-count')`)
    }
    // 일반 채팅(IDE 크롬) — 사이드바에서 픽스처 일반 채팅을 고른다
    await app.cdp.eval(`__pick('벤치 긴 스레드')`)
    await waitFor(app.cdp, `!!document.querySelector('.chat-head .ma-count') || !!document.querySelector('.ma-count')`)
    await sleep(500)
    at.single = await app.cdp.eval(`__rect('.ma-count')`)
    s.rects = at
    console.log('   ', JSON.stringify(at))
    const dy12 = at.n1 && at.n2 ? Math.abs(at.n1.y - at.n2.y) : null
    const dx12 = at.n1 && at.n2 ? Math.abs(at.n1.x - at.n2.x) : null
    const dxS1 = at.single && at.n1 ? Math.abs(at.single.x - at.n1.x) : null
    const dyS1 = at.single && at.n1 ? Math.abs(at.single.y - at.n1.y) : null
    s.delta = { n1_vs_n2: { dx: dx12, dy: dy12 }, single_vs_n1: { dx: dxS1, dy: dyS1 } }
    if (dx12 === null) fail('geom.miss', '다이얼을 못 찾았다', at)
    else if (dx12 > 2 || dy12 > 2) fail('geom.move-1-2', `1↔2 전환에서 다이얼이 움직인다(dx=${dx12} dy=${dy12})`, at)
    else ok('geom.fixed-1-2', s.delta.n1_vs_n2)
    if (dxS1 !== null && (dxS1 > 2 || dyS1 > 2))
      fail('geom.move-single-n1', `일반 채팅 ↔ n1 사이에서 다이얼이 움직인다(dx=${dxS1} dy=${dyS1})`, at)
    else if (dxS1 !== null) ok('geom.fixed-single-n1', s.delta.single_vs_n1)
  } finally {
    killTree(app.child.pid)
    await sleep(800)
    if (!KEEP) await rmHome(HOME)
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. 사이드바 의미 — 일반 채팅 화면에서 보드 자리 칩이 무엇을 말하는가 +
//    접힌 대화를 사이드바에서 고르면 정말 1번 자리로 올라오는가
// ═══════════════════════════════════════════════════════════════════════════
async function stepSide() {
  console.log('\n[side] 통합 사이드바 의미 + 접힘 승격 라우팅')
  const s = (rep.steps.side = {})
  const HOME = path.join(REPO, '.critic-home-mux-side')
  fs.rmSync(HOME, { recursive: true, force: true })
  makeMultiFixture(HOME, APP_VERSION, { panels: 6, itemsPerPanel: 3 })
  const app = await boot(HOME, 9373)
  try {
    if (!(await waitFor(app.cdp, `__n('.ma-grid > .ma-panel') === 6`))) return fail('side.boot', '6자리 부팅 실패')
    await sleep(1500)
    // 6 → 1: 5개 접힘
    await app.cdp.eval(`__c('.ma-count-btn[data-count="1"]')`)
    await waitFor(app.cdp, `__n('.ma-grid.n1 > .ma-panel') === 1`)
    await sleep(600)
    s.atMulti1 = await app.cdp.eval(`__sbItems()`)
    ok('side.multi1', s.atMulti1[0].items.map((i) => i.chip + (i.kind === 'folded' ? '⌄' : '')))

    // 일반 채팅으로 나간다 (IDE 크롬) — 보드는 여전히 count=1, 5자리 접힘 상태
    await app.cdp.eval(`__pick('벤치 긴 스레드')`)
    await waitFor(app.cdp, `!document.querySelector('.ma-grid')`)
    await sleep(900)
    const single = await app.cdp.eval(`__sbItems()`)
    s.atSingle = single
    const liveOnes = single[0].items.filter((i) => i.kind === 'live' && i.chip === '1')
    s.liveOnes = liveOnes
    if (liveOnes.length > 1)
      fail('side.dup-slot1', `일반 채팅 화면에서 「1번 자리」 칩이 ${liveOnes.length}개다 — 자리 하나에 대화 둘`, liveOnes)
    else ok('side.slot1-unique', liveOnes)
    const boardLive = single[0].items.filter((i) => i.kind === 'live' && i.t.startsWith('벤치 패널'))
    if (boardLive.length)
      fail('side.stale-live', '보드 크롬을 떠났는데 보드 자리가 여전히 「보이는 자리」로 표시된다', boardLive)
    else ok('side.no-stale-live')
    s.hintAtSingle = single[0].hint

    // ★ 접힌 대화를 사이드바에서 고른다 (일반 채팅 화면에서) — 보드로 돌아가 1번 자리로 승격돼야 한다
    const foldedTitle = (s.atMulti1[0].items.find((i) => i.kind === 'folded') || {}).t
    s.foldedPicked = foldedTitle
    await app.cdp.eval(`__pick(${JSON.stringify(foldedTitle)})`)
    const backToBoard = await waitFor(app.cdp, `__n('.ma-grid > .ma-panel') >= 1`, { tries: 60 })
    await sleep(900)
    const shown = await app.cdp.eval(`__txts('.ma-grid > .ma-panel .ma-p-title')`)
    s.afterRaiseFromSingle = { backToBoard: !!backToBoard, shown }
    if (!backToBoard) fail('side.raise-nav', '접힌 대화를 골랐는데 보드로 가지 않았다')
    else if (shown[0] !== foldedTitle)
      fail('side.raise-from-single', `접힌 대화를 골랐는데 1번 자리에 안 올라왔다 (1번=${JSON.stringify(shown[0])})`, s.afterRaiseFromSingle)
    else ok('side.raise-from-single', shown[0])

    // 같은 조작을 보드 안에서(마운트된 상태) — 이건 되는가 (대조군)
    await app.cdp.eval(`__c('.ma-count-btn[data-count="1"]')`)
    await waitFor(app.cdp, `__n('.ma-grid.n1 > .ma-panel') === 1`)
    await sleep(500)
    const foldedNow = await app.cdp.eval(`__sbItems()`)
    const pick2 = (foldedNow[0].items.find((i) => i.kind === 'folded') || {}).t
    await app.cdp.eval(`__pick(${JSON.stringify(pick2)})`)
    await sleep(900)
    const shown2 = await app.cdp.eval(`__txts('.ma-grid > .ma-panel .ma-p-title')`)
    s.afterRaiseInBoard = { pick: pick2, shown: shown2 }
    if (shown2[0] !== pick2) fail('side.raise-in-board', '보드 안에서도 접힌 대화 승격이 안 된다', s.afterRaiseInBoard)
    else ok('side.raise-in-board', shown2[0])
  } finally {
    killTree(app.child.pid)
    await sleep(800)
    if (!KEEP) await rmHome(HOME)
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. §2.2-1b 고아 UI — 뷰어 재바인드는 되는데, 관문을 안 지나는 전이는?
// ═══════════════════════════════════════════════════════════════════════════
async function stepViewer() {
  console.log('\n[viewer] 관문 밖 전이 — 크게보기 · 팝아웃 · n1 창 컨트롤 함정')
  const s = (rep.steps.viewer = {})
  const HOME = path.join(REPO, '.critic-home-mux-viewer')
  fs.rmSync(HOME, { recursive: true, force: true })
  makeMultiFixture(HOME, APP_VERSION, { panels: 6, itemsPerPanel: 3 })
  const app = await boot(HOME, 9374)
  try {
    if (!(await waitFor(app.cdp, `__n('.ma-grid > .ma-panel') === 6`))) return fail('viewer.boot', '6자리 부팅 실패')
    await sleep(1500)
    // ── (a) 3.0 백엔드 실측 — IDE 크롬의 「내용물」이 실제로 도는가 ──────────────
    const openedExplorer = await app.cdp.eval(`(() => { const b=[...document.querySelectorAll('button')].find(e=>(e.getAttribute('aria-label')||'').includes('탐색기')); if(!b) return false; b.click(); return true })()`)
    await sleep(2000)
    s.ide = {
      explorerBtn: openedExplorer,
      explorerMounted: await app.cdp.eval(`__n('.lcol .explorer')`),
      explorerRows: await app.cdp.eval(`__n('.explorer .fxr')`),
      explorerText: await app.cdp.eval(`((document.querySelector('.lcol .explorer')||{}).innerText||'').slice(0,120)`),
      gitStrip: await app.cdp.eval(`__n('.explorer .git-strip')`),
      workbars: await app.cdp.eval(`__n('.ma-grid > .ma-panel .workbar, .ma-grid > .ma-panel .wk')`)
    }
    if (!s.ide.explorerRows)
      fail('viewer.ide-explorer-empty', '탐색기가 열리긴 하는데 트리가 비어 있다(3.0 백엔드에 fs 목록 채널이 없다) — 「1 = IDE 크롬」의 내용물은 아직 검증 불가', s.ide)
    else ok('viewer.ide-explorer', s.ide)
    // 탐색기를 닫고 사이드바로
    await app.cdp.eval(`(() => { const b=[...document.querySelectorAll('button')].find(e=>(e.getAttribute('aria-label')||'').includes('탐색기')); if(b) b.click(); return !!b })()`)
    await sleep(600)

    // ── (b) 「크게 보기」 중 다이얼 — 오버레이가 정리되는가 / 창 컨트롤이 사는가 ──
    await app.cdp.eval(`__mdown('.ma-grid > .ma-panel', 2)`)
    await sleep(200)
    const expanded = await app.cdp.eval(`(() => { const p=document.querySelectorAll('.ma-grid > .ma-panel')[2]; const b=[...p.querySelectorAll('button')].find(e=>(e.getAttribute('aria-label')||'')==='크게 보기'); if(!b) return false; b.click(); return true })()`)
    await sleep(800)
    const expOn = await app.cdp.eval(`__n('.ma-panel.ma-expanded, .ma-expand-overlay, .multi.expanded')`)
    s.expand = { clicked: expanded, on: expOn }
    if (!expOn) fail('viewer.expand-open', '「크게 보기」를 못 열어 이 축을 못 쟀다', s.expand)
    else {
      // 포커스가 그 자리라 다이얼 1은 **그 자리를 남긴다**(승격) → soloSlot === expandedSlot
      await app.cdp.eval(`__c('.ma-count-btn[data-count="1"]')`)
      await sleep(900)
      s.expandThenOne = {
        heads: await app.cdp.eval(`__n('.ma-head')`),
        dials: await app.cdp.eval(`__n('.ma-count')`),
        winCtl: await app.cdp.eval(`__n('.ma-head .close, .ma-p-head .close')`),
        stillExpanded: await app.cdp.eval(`__n('.multi.expanded, .ma-expand-overlay')`)
      }
      if (s.expandThenOne.dials !== 1 || s.expandThenOne.winCtl < 1)
        fail('viewer.expand-chrome-gone', '크게보기 중 다이얼 1 → 다이얼/창 컨트롤이 사라졌다', s.expandThenOne)
      else ok('viewer.expand-chrome', s.expandThenOne)
      // 오버레이를 닫고 6으로
      await app.cdp.eval(`(() => { const b=[...document.querySelectorAll('button')].find(e=>(e.getAttribute('aria-label')||'')==='크게 보기 닫기' || (e.getAttribute('data-tip')||'').includes('접기')); if(b) b.click(); return !!b })()`)
      await app.cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
      await sleep(600)
    }
    await app.cdp.eval(`__c('.ma-count-btn[data-count="6"]')`)
    await waitFor(app.cdp, `__n('.ma-grid > .ma-panel') === 6`)
    await sleep(600)

    // ── (c) 팝아웃 + n1 — 보고서가 "미리 막았다"고 한 함정 ────────────────────
    await app.cdp.eval(`__mdown('.ma-grid > .ma-panel', 3)`)
    await sleep(200)
    const popped = await app.cdp.eval(`(() => { const p=document.querySelectorAll('.ma-grid > .ma-panel')[3]; const b=[...p.querySelectorAll('button')].find(e=>(e.getAttribute('aria-label')||'')==='별도 창으로'); if(!b) return false; b.click(); return true })()`)
    const ghost = await waitFor(app.cdp, `__n('.ma-panel.ma-ghost.pop') === 1`, { tries: 120 })
    s.popout = { clicked: popped, ghost: !!ghost }
    if (!ghost) fail('viewer.popout', '팝아웃 유령 셀이 안 생겼다', s.popout)
    else {
      ok('viewer.popout-ghost')
      // 유령이 1번 자리가 되게 다이얼 1 (포커스가 그 자리라 승격된다)
      await app.cdp.eval(`__c('.ma-count-btn[data-count="1"]')`)
      await sleep(1000)
      s.popoutThenOne = {
        heads: await app.cdp.eval(`__n('.ma-head')`),
        dials: await app.cdp.eval(`__n('.ma-count')`),
        winCtl: await app.cdp.eval(`__n('.ma-head .close, .ma-p-head .close')`),
        soloIsGhost: await app.cdp.eval(`__n('.ma-grid.n1 > .ma-panel.ma-ghost')`)
      }
      if (s.popoutThenOne.dials !== 1 || s.popoutThenOne.winCtl < 1)
        fail('viewer.popout-chrome-gone', 'n1의 그 한 자리가 팝아웃 유령인데 창 컨트롤/다이얼이 사라졌다', s.popoutThenOne)
      else ok('viewer.popout-chrome', s.popoutThenOne)
      // 사이드바 — 유령 자리는 「창」 칩이어야 한다(§3.3)
      const side = await app.cdp.eval(`__sbItems()`)
      s.popoutSidebar = side[0].items
      const winChips = side[0].items.filter((i) => i.kind === 'win')
      if (!winChips.length) fail('viewer.popout-chip', '팝아웃한 대화가 사이드바에서 「창」 칩을 안 단다', side[0].items)
      else ok('viewer.popout-chip', winChips)
      // 창을 닫으면 그리드로 복귀 + .ma-head가 다시 사라지는가
      await app.cdp.eval(`(async () => { const w = await window.api.sessionWindows?.list?.(); return w?.length ?? -1 })()`, { awaitPromise: true }).catch(() => null)
      const closed = await app.cdp.eval(`(() => { const g=document.querySelector('.ma-panel.ma-ghost.pop'); if(!g) return false; g.click(); return true })()`)
      s.popoutClickGhost = closed
    }
  } finally {
    killTree(app.child.pid)
    await sleep(1200)
    if (!KEEP) await rmHome(HOME)
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. busy 중 삭제 — 침묵 no-op인가 (M-LOGIC P7)
// ═══════════════════════════════════════════════════════════════════════════
async function stepBusyDel() {
  console.log('\n[busydel] 실행 중 삭제 — 반응이 있는가 (침묵 no-op 금지)')
  const s = (rep.steps.busydel = {})
  const HOME = path.join(REPO, '.critic-home-mux-busydel')
  let seed
  try { seed = seedChatHome(HOME) } catch (e) { return fail('busydel.seed', String(e.message ?? e)) }
  const app = await boot(HOME, 9375)
  try {
    if (!(await waitFor(app.cdp, `__txts('.sb-item .t .tx').filter(x=>x.startsWith('ATK')).length === 2`))) return fail('busydel.boot', '두 채팅이 안 떴다')
    await app.cdp.eval(`__send('Run this exact bash command and then reply DONE: sleep 90')`)
    const busy = await waitFor(app.cdp, `!!document.querySelector('.send.stop, .send.schedule') || __n('.thread .msg') > 0`, { tries: 300 })
    if (!busy) return fail('busydel.busy', '전송 후 실행이 안 걸렸다')
    await sleep(1500)
    s.busy = await app.cdp.eval(`!!document.querySelector('.send.stop, .send.schedule')`)
    s.busyBeforeCtx = s.busy
    // (a) 항목 우클릭 → 삭제 (busy 가드가 살아 있으면 메뉴 항목이 disabled여야 한다)
    await app.cdp.eval(`__ctx('ATK 도는 채팅')`)
    await sleep(300)
    const menu = await app.cdp.eval(`(() => { const b=[...document.querySelectorAll('.ctx-menu .ctx-item')].find(e=>(e.textContent||'').includes('삭제')); return b ? { found:true, disabled: b.disabled } : { found:false } })()`)
    s.ctxDelete = menu
    if (!menu.found) fail('busydel.menu', '우클릭 메뉴에 삭제가 없다')
    else if (!menu.disabled) {
      // 눌러 본다 — 확인 카드가 뜨는가? 뜬다면 확인 후 어떤 일이 일어나는가
      await app.cdp.eval(`(() => { const b=[...document.querySelectorAll('.ctx-menu .ctx-item')].find(e=>(e.textContent||'').includes('삭제')); b.click(); return true })()`)
      await sleep(400)
      const card = await app.cdp.eval(`(document.querySelector('.sconfirm .sct')||{}).textContent || ''`)
      s.confirmCard = card
      if (card) {
        await app.cdp.eval(`__c('.sconfirm .scb .danger')`)
        await sleep(1200)
        const still = await app.cdp.eval(`__txts('.sb-item .t .tx').filter(x=>x.includes('ATK 도는'))`)
        const anyNotice = await app.cdp.eval(`__txts('.toast, .notice, .sb-foldhint, .ma-rebind').join(' | ')`)
        s.afterConfirm = { still, anyNotice }
        if (still.length) fail('busydel.silent', '실행 중 삭제: 확인 카드까지 통과했는데 아무 일도 안 일어난다(침묵 no-op) — 이유를 말하지 않는다', s.afterConfirm)
        else fail('busydel.deleted', '실행 중인 채팅이 실제로 삭제됐다 — 삭제 금지 규약 위반', s.afterConfirm)
      } else {
        fail('busydel.nocard', '삭제 메뉴가 활성인데 확인 카드도 안 뜬다(침묵 no-op)')
      }
    } else ok('busydel.ctx-disabled')
    await app.cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
    await sleep(300)
    // (b) 「전체 삭제」 버튼 — busy 중에 눌리는가
    s.busyBeforeAll = await app.cdp.eval(`!!document.querySelector('.send.stop, .send.schedule')`)
    const allBtn = await app.cdp.eval(`(() => { const b=[...document.querySelectorAll('.sb-sec .sb-label .slb')].find(e=>(e.getAttribute('aria-label')||'').includes('전체 삭제')); return b ? { found:true, disabled:b.disabled, tip:b.getAttribute('data-tip') } : { found:false } })()`)
    s.deleteAllBtn = allBtn
    if (allBtn.found && !allBtn.disabled) {
      await app.cdp.eval(`(() => { const b=[...document.querySelectorAll('.sb-sec .sb-label .slb')].find(e=>(e.getAttribute('aria-label')||'').includes('전체 삭제')); b.click(); return true })()`)
      await sleep(400)
      const card = await app.cdp.eval(`(document.querySelector('.sconfirm .sct')||{}).textContent || ''`)
      s.deleteAllCard = card
      if (card) {
        await app.cdp.eval(`__c('.sconfirm .scb .danger')`)
        await sleep(1200)
        const left = await app.cdp.eval(`__txts('.sb-item .t .tx')`)
        s.afterDeleteAll = left
        if (!s.busyBeforeAll) ok('busydel.all-not-busy', '전체 삭제 시점엔 이미 실행이 끝나 있었다')
        else if (left.filter((x) => x.startsWith('ATK')).length === 2)
          fail('busydel.all-silent', '실행 중 「전체 삭제」: 확인 카드까지 통과했는데 아무 일도 안 일어난다(침묵 no-op)', { left })
        else fail('busydel.all-deleted', '실행 중인데 전체 삭제가 실행됐다', { left })
      }
    } else ok('busydel.all-disabled', allBtn)
  } finally {
    killTree(app.child.pid)
    await sleep(1200)
    if (!KEEP) await rmHome(HOME)
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 5b. **자리 밖에서 도는** 채팅의 삭제 — busy 전환을 연 대가로 새로 생긴 상태
//     (2.6.2에서는 이 상태 자체가 불가능했다: busy면 못 떠났으니까)
// ═══════════════════════════════════════════════════════════════════════════
async function stepBgDel() {
  console.log('\n[bgdel] 자리 밖에서 도는 채팅을 지울 수 있는가 (「삭제만은 막는다」의 실효성)')
  const s = (rep.steps.bgdel = {})
  const HOME = path.join(REPO, '.critic-home-mux-bgdel')
  try { seedChatHome(HOME) } catch (e) { return fail('bgdel.seed', String(e.message ?? e)) }
  const app = await boot(HOME, 9381)
  try {
    if (!(await waitFor(app.cdp, `__txts('.sb-item .t .tx').filter(x=>x.startsWith('ATK')).length === 2`))) return fail('bgdel.boot', '두 채팅이 안 떴다')
    await app.cdp.eval(`__send('Write out the numbers 1 to 500, one number per line, nothing else. Never stop early and never summarize.')`)
    if (!(await waitFor(app.cdp, `!!document.querySelector('.send.stop, .send.schedule')`, { tries: 300 }))) return fail('bgdel.busy', '실행이 안 걸렸다')
    await sleep(2500)
    // 실행 중 옆 채팅으로 (3.0이 새로 연 문)
    await app.cdp.eval(`__pick('ATK 옆 채팅')`)
    if (!(await waitFor(app.cdp, `(async () => (await window.api.getChats())?.activeChatId === 'c-side')()`, { tries: 80 })))
      return fail('bgdel.switch', '실행 중 전환 실패')
    await sleep(2000)
    const side = await app.cdp.eval(`__sbItems()`)
    s.runBadgeWhileAway = side[0].items.find((i) => i.t.includes('ATK 도는'))
    // ★ 삭제 직전에 **정말 도는 중**인지 chat:event 카운터의 증가로 확인한다
    const ev0 = await app.cdp.eval(`window.__ccgChatEv ? window.__ccgChatEv.n : -1`)
    await sleep(2500)
    const ev1 = await app.cdp.eval(`window.__ccgChatEv ? window.__ccgChatEv.n : -1`)
    s.liveAtDelete = { ev0, ev1, streaming: ev1 > ev0 }
    if (ev1 <= ev0) fail('bgdel.not-live', '삭제 시점에 배경 채팅이 이미 안 돌고 있었다 — 이 축을 못 쟀다', s.liveAtDelete)
    else ok('bgdel.live', s.liveAtDelete)
    // ★ 자리 밖에서 도는 채팅을 우클릭 → 삭제
    await app.cdp.eval(`__ctx('ATK 도는 채팅')`)
    await sleep(300)
    s.ctx = await app.cdp.eval(`(() => { const b=[...document.querySelectorAll('.ctx-menu .ctx-item')].find(e=>(e.textContent||'').includes('삭제')); return b ? { found:true, disabled:b.disabled } : { found:false } })()`)
    if (s.ctx.found && !s.ctx.disabled) {
      await app.cdp.eval(`(() => { const b=[...document.querySelectorAll('.ctx-menu .ctx-item')].find(e=>(e.textContent||'').includes('삭제')); b.click(); return true })()`)
      await sleep(400)
      s.card = await app.cdp.eval(`(document.querySelector('.sconfirm .sct')||{}).textContent || ''`)
      await app.cdp.eval(`__c('.sconfirm .scb .danger')`)
      await sleep(1500)
      const left = await app.cdp.eval(`__txts('.sb-item .t .tx')`)
      s.afterDelete = left
      const gone = !left.some((x) => x.includes('ATK 도는'))
      // 엔진이 아직 도는가 — chat:event가 계속 오면 대화만 지우고 엔진은 살아 있다
      await app.cdp.eval(`window.__ev0 = window.__ccgChatEv ? window.__ccgChatEv.n : -1`)
      await sleep(6000)
      s.chatEvAfter = await app.cdp.eval(`window.__ccgChatEv ? { before: window.__ev0, after: window.__ccgChatEv.n } : null`)
      if (gone)
        fail('bgdel.deleted-while-running', '자리 밖에서 **도는 채팅이 그대로 삭제됐다** — 「삭제만은 막는다」는 활성 채팅에만 걸려 있다', { left, chatEv: s.chatEvAfter, card: s.card })
      else fail('bgdel.silent', '삭제 카드까지 통과했는데 아무 일도 안 일어난다(침묵 no-op)', { left })
    } else ok('bgdel.blocked', s.ctx)
  } finally {
    killTree(app.child.pid)
    await sleep(1200)
    if (!KEEP) await rmHome(HOME)
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. 예약 메시지(큐) — busy 전환을 열면 큐는 어느 채팅으로 가는가
// ═══════════════════════════════════════════════════════════════════════════
async function stepQueue() {
  console.log('\n[queue] busy 중 예약한 메시지 + 채팅 전환 → 어디로 가는가')
  const s = (rep.steps.queue = {})
  const HOME = path.join(REPO, '.critic-home-mux-queue')
  let seed
  try { seed = seedChatHome(HOME) } catch (e) { return fail('queue.seed', String(e.message ?? e)) }
  const app = await boot(HOME, 9376)
  try {
    if (!(await waitFor(app.cdp, `__txts('.sb-item .t .tx').filter(x=>x.startsWith('ATK')).length === 2`))) return fail('queue.boot', '두 채팅이 안 떴다')
    await app.cdp.eval(`__send('Count from 1 to 80, one number per line, nothing else.')`)
    const busy = await waitFor(app.cdp, `!!document.querySelector('.send.stop, .send.schedule')`, { tries: 300 })
    if (!busy) return fail('queue.busy', '전송 후 실행이 안 걸렸다')
    // busy 중 두 번째 메시지 = 예약
    await app.cdp.eval(`__send('QUEUEDPROBE-9182')`)
    await sleep(500)
    const queued = await app.cdp.eval(`__txts('.sched-item .sched-text').join(' | ')`)
    const queuedN = await app.cdp.eval(`__n('.sched-item')`)
    s.queued = { text: queued, n: queuedN }
    ok('queue.enqueued', s.queued)
    // ★ 실행 중 전환 (3.0이 새로 연 문)
    await app.cdp.eval(`__pick('ATK 옆 채팅')`)
    const switched = await waitFor(app.cdp, `(async () => (await window.api.getChats())?.activeChatId === 'c-side')()`, { tries: 80 })
    s.switched = !!switched
    if (!switched) return fail('queue.switch', '실행 중 전환이 안 됐다')
    ok('queue.switch')
    await sleep(6000)
    // 옆 채팅에 남의 예약 메시지가 발사됐는가
    const sideMsgs = await app.cdp.eval(`__txts('.thread .msg').map(x=>x.slice(0,80))`)
    const sideHasProbe = await app.cdp.eval(`__txts('.thread .msg').some(x=>x.includes('QUEUEDPROBE-9182'))`)
    const sideBusy = await app.cdp.eval(`!!document.querySelector('.send.stop, .send.schedule')`)
    const activeNow = await app.cdp.eval(`(async () => (await window.api.getChats())?.activeChatId)()`, { awaitPromise: true })
    s.side = { msgs: sideMsgs, hasProbe: sideHasProbe, busy: sideBusy, activeNow }
    if (sideHasProbe)
      fail('queue.misroute', '떠난 채팅의 예약 메시지가 **옆 채팅으로 발사됐다** — 남의 대화에 내 프롬프트가 들어간다', s.side)
    else ok('queue.no-misroute', { msgs: sideMsgs.length })
    // 돌아와서 — 예약이 원래 채팅에서 살아 있었는가
    await sleep(20000)
    await app.cdp.eval(`__pick('ATK 도는 채팅')`)
    await sleep(4000)
    const runMsgs = await app.cdp.eval(`__txts('.thread .msg').map(x=>x.slice(0,80))`)
    const runHasProbe = await app.cdp.eval(`__txts('.thread .msg').some(x=>x.includes('QUEUEDPROBE-9182'))`)
    const stillQueued = await app.cdp.eval(`__n('.sched-item')`)
    s.back = { msgs: runMsgs.length, hasProbe: runHasProbe, stillQueued, tail: runMsgs.slice(-3) }
    if (!runHasProbe && !stillQueued)
      fail('queue.lost', '예약 메시지가 원래 채팅에서도 사라졌다 — 예약이 증발', s.back)
    else ok('queue.home', s.back)
  } finally {
    killTree(app.child.pid)
    await sleep(1200)
    if (!KEEP) await rmHome(HOME)
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. 스트리밍 도중 전환 → **스트리밍 도중** 복귀 (PoC는 턴이 끝난 뒤에만 돌아왔다)
// ═══════════════════════════════════════════════════════════════════════════
async function stepMid() {
  console.log('\n[mid] 스트리밍 중 전환 → 스트리밍 중 복귀 → 최신본인가')
  const s = (rep.steps.mid = {})
  const HOME = path.join(REPO, '.critic-home-mux-mid')
  let seed
  try { seed = seedChatHome(HOME) } catch (e) { return fail('mid.seed', String(e.message ?? e)) }
  const app = await boot(HOME, 9377)
  try {
    if (!(await waitFor(app.cdp, `__txts('.sb-item .t .tx').filter(x=>x.startsWith('ATK')).length === 2`))) return fail('mid.boot', '두 채팅이 안 떴다')
    await app.cdp.eval(`__send('Write out the numbers 1 to 700, one number per line, nothing else. Never stop early and never summarize.')`)
    if (!(await waitFor(app.cdp, `!!document.querySelector('.send.stop, .send.schedule')`, { tries: 300 }))) return fail('mid.busy', '실행이 안 걸렸다')
    // 어시스턴트 말풍선이 자라기 시작할 때까지
    await waitFor(app.cdp, `__txts('.thread .msg.ai-msg').join('').length > 20`, { tries: 300 })
    const lenAtLeave = await app.cdp.eval(`__txts('.thread .msg.ai-msg').join('').length`)
    s.lenAtLeave = lenAtLeave
    await app.cdp.eval(`__pick('ATK 옆 채팅')`)
    if (!(await waitFor(app.cdp, `(async () => (await window.api.getChats())?.activeChatId === 'c-side')()`, { tries: 80 })))
      return fail('mid.switch', '전환 실패')
    await sleep(2500) // 스트리밍이 아직 도는 동안
    // 배지를 재기 전에 **정말 도는 중**인지 chat:event 증가로 증명한다
    const e0 = await app.cdp.eval(`window.__ccgChatEv ? window.__ccgChatEv.n : -1`)
    await sleep(2500)
    const e1 = await app.cdp.eval(`window.__ccgChatEv ? window.__ccgChatEv.n : -1`)
    s.liveWhileAway = { e0, e1, streaming: e1 > e0 }
    const stillRunning = await app.cdp.eval(`__sbItems()`)
    s.sidebarWhileAway = stillRunning[0].items
    const runBadge = stillRunning[0].items.find((i) => i.t.includes('ATK 도는'))
    s.runBadge = runBadge
    if (!s.liveWhileAway.streaming) fail('mid.not-live', '떠난 뒤 스트림이 안 돌고 있어 배지 축을 못 쟀다', s.liveWhileAway)
    else if (!runBadge?.run) fail('mid.badge', '자리 밖에서 **도는 중인데** 사이드바에 「실행」 배지도 상태 점도 없다(스펙 ⑥이 약속한 보상 표시가 안 뜬다)', { runBadge, live: s.liveWhileAway })
    else ok('mid.badge', runBadge)
    // ★ 스트리밍이 계속되는 동안 되돌아온다
    const e2 = await app.cdp.eval(`window.__ccgChatEv ? window.__ccgChatEv.n : -1`)
    s.evAtReturn = e2
    await app.cdp.eval(`__pick('ATK 도는 채팅')`)
    await sleep(1500)
    const lenBack = await app.cdp.eval(`__txts('.thread .msg.ai-msg').join('').length`)
    const busyBack = await app.cdp.eval(`!!document.querySelector('.send.stop, .send.schedule')`)
    s.onReturn = { lenBack, busyBack }
    if (lenBack < lenAtLeave) fail('mid.shrink', '돌아왔더니 스레드가 떠날 때보다 짧다 — 꼬리 유실', s.onReturn)
    else ok('mid.grew', s.onReturn)
    if (!busyBack) fail('mid.busy-lost', '돌아왔더니 실행 표시가 없다 — 라이브 상태를 못 이어받았다', s.onReturn)
    else ok('mid.busy-kept')
    // 계속 자라는가 (라이브 리듀서가 이어받았는가)
    await sleep(6000)
    const lenLater = await app.cdp.eval(`__txts('.thread .msg.ai-msg').join('').length`)
    s.lenLater = lenLater
    if (lenLater <= lenBack) fail('mid.frozen', '복귀 후 스트림이 더 안 자란다 — 라이브 이벤트를 못 받는다', { lenBack, lenLater })
    else ok('mid.live', { lenBack, lenLater })
    // 턴 종료까지 기다렸다가 최종 무결성
    await waitFor(app.cdp, `!document.querySelector('.send.stop, .send.schedule')`, { tries: 600 })
    await sleep(1500)
    const final = await app.cdp.eval(`__txts('.thread .msg.ai-msg').join('')`)
    s.finalLen = final.length
    s.finalTail = final.slice(-120)
    // 숫자 세기 프롬프트라 1..N이 순서대로 있어야 한다 — 중간이 뭉텅 빠지면 꼬리 접기 실패
    const nums = (final.match(/\b\d+\b/g) || []).map(Number)
    const holes = []
    for (let i = 1; i < nums.length; i++) if (nums[i] !== nums[i - 1] + 1) holes.push([nums[i - 1], nums[i]])
    s.numHoles = holes.slice(0, 10)
    s.numCount = nums.length
    if (holes.length > 1) fail('mid.holes', '복귀한 스레드의 숫자열에 구멍이 있다 — 전환 구간의 토큰이 빠졌다', { holes: s.numHoles, n: nums.length })
    else ok('mid.contiguous', { n: nums.length, holes: holes.length })
  } finally {
    killTree(app.child.pid)
    await sleep(1200)
    if (!KEEP) await rmHome(HOME)
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. 접힌 자리에서 도는 실행 — 칩·배지·완료가 화면에 반영되는가
// ═══════════════════════════════════════════════════════════════════════════
async function stepFoldRun() {
  console.log('\n[foldrun] 접힌 자리 실행 — 칩 · 사이드바 · 완료 반영')
  const s = (rep.steps.foldrun = {})
  const HOME = path.join(REPO, '.critic-home-mux-foldrun')
  fs.rmSync(HOME, { recursive: true, force: true })
  makeMultiFixture(HOME, APP_VERSION, { panels: 2, itemsPerPanel: 2 })
  let ver
  try { ver = seedCreds(HOME) } catch (e) { return fail('foldrun.seed', String(e.message ?? e)) }
  // 패널 0의 폴더를 격리 작업 폴더로, picker는 값싼 조합으로
  const work = path.join(HOME, 'work')
  fs.mkdirSync(work, { recursive: true })
  const sp = path.join(HOME, 'multi-agent', 'fix-multi-session.json')
  const sess = JSON.parse(fs.readFileSync(sp, 'utf8'))
  sess.count = 2
  for (const p of sess.panels) { p.cwd = work; p.picker = { model: 'haiku', effort: 'minimal', mode: 'bypass' } }
  fs.writeFileSync(sp, JSON.stringify(sess))
  const app = await boot(HOME, 9378)
  try {
    if (!(await waitFor(app.cdp, `__n('.ma-grid > .ma-panel') === 2`))) return fail('foldrun.boot', '2자리 부팅 실패')
    await sleep(1200)
    // 2번 자리(인덱스 1)에서 실행을 건다
    await app.cdp.eval(`__mdown('.ma-grid > .ma-panel', 1)`)
    await sleep(200)
    const sent = await app.cdp.eval(`(() => { const p=document.querySelectorAll('.ma-grid > .ma-panel')[1]; const ta=p.querySelector('textarea'); if(!ta) return 'no-ta'
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set.call(ta,'Write out the numbers 1 to 700, one number per line, nothing else. Never stop early.')
      ta.dispatchEvent(new Event('input',{bubbles:true})); ta.focus()
      ta.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); return 'sent' })()`)
    s.sent = sent
    const running = await waitFor(app.cdp, `__n('.ma-panel .send.stop, .ma-panel .send.schedule') > 0 || __n('.ma-panel.running, .ma-panel .ma-p-st.run') > 0`, { tries: 300 })
    s.running = !!running
    if (!running) return fail('foldrun.run', '패널에서 실행이 안 걸렸다', { log: app.log().slice(-600) })
    ok('foldrun.run')
    // 실제로 자라고 있는지 확인 — 짧은 턴이 이미 끝난 상태로 접으면 축을 못 잰다
    const PLEN = `((document.querySelectorAll('.ma-grid > .ma-panel')[1] || {}).innerText || '').length`
    await waitFor(app.cdp, `${PLEN} > 900`, { tries: 600, gap: 200 })
    s.panelLenBeforeFold = await app.cdp.eval(PLEN)
    // ★ 도는 자리를 접는다 — 1번 자리(인덱스 0)를 포커스한 뒤 다이얼 1
    await app.cdp.eval(`__mdown('.ma-grid > .ma-panel', 0)`)
    await sleep(200)
    await app.cdp.eval(`__c('.ma-count-btn[data-count="1"]')`)
    await waitFor(app.cdp, `__n('.ma-grid.n1 > .ma-panel') === 1`)
    await sleep(800)
    const chip = await app.cdp.eval(`(document.querySelector('.ma-runsum')||{}).textContent || ''`)
    const badge = await app.cdp.eval(`(document.querySelector('.ma-fold-badge .cnt')||{}).textContent || ''`)
    const side = await app.cdp.eval(`__sbItems()`)
    s.whileFolded = { chip, badge, side: side[0].items }
    if (!chip) fail('foldrun.chip', '접힌 자리에서 실행이 도는데 「접힌 자리 실행 N」 칩이 없다', s.whileFolded)
    else ok('foldrun.chip', chip)
    const runItem = side[0].items.find((i) => i.run)
    if (!runItem) fail('foldrun.sidebadge', '접힌 자리 실행이 사이드바 「실행」 배지에 안 보인다', side[0].items)
    else ok('foldrun.sidebadge', runItem)
    // ★ 완료 — 칩이 사라지고 상태가 완료로 바뀌는가 (+ 토스트가 뜨는가)
    const gone = await waitFor(app.cdp, `!document.querySelector('.ma-runsum')`, { tries: 900, gap: 200 })
    s.chipCleared = !!gone
    if (!gone) fail('foldrun.chip-stuck', '실행이 끝났는데 「접힌 자리 실행」 칩이 안 사라진다')
    else ok('foldrun.chip-cleared')
    await sleep(1500)
    const after = await app.cdp.eval(`__sbItems()`)
    s.afterDone = after[0].items
    const stillRun = after[0].items.filter((i) => i.run)
    if (stillRun.length) fail('foldrun.badge-stuck', '완료됐는데 사이드바 「실행」 배지가 남았다', stillRun)
    else ok('foldrun.badge-cleared')
    // 팝오버가 완료 상태를 말하는가
    await app.cdp.eval(`__c('.ma-fold-badge')`)
    await sleep(300)
    s.popRows = await app.cdp.eval(`__txts('.ma-fold-row')`)
    ok('foldrun.pop', s.popRows)
    // 되올려서 답이 살아 있는가
    await app.cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
    await sleep(200)
    await app.cdp.eval(`__c('.ma-count-btn[data-count="2"]')`)
    await waitFor(app.cdp, `__n('.ma-grid > .ma-panel') === 2`)
    await sleep(800)
    const texts = await app.cdp.eval(`[...document.querySelectorAll('.ma-grid > .ma-panel')].map(p => (p.querySelector('.thread')||{}).innerText?.length ?? 0)`)
    s.threadLens = texts
    ok('foldrun.restored', texts)
  } finally {
    killTree(app.child.pid)
    await sleep(1200)
    if (!KEEP) await rmHome(HOME)
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 9. 접힘 → 팝오버 ↥ 복귀에서 **스레드·스크롤**이 보존되는가 +
//    보드가 하나도 없는 일반 채팅에서 다이얼 2‥6을 누르면 어디로 가는가
// ═══════════════════════════════════════════════════════════════════════════
async function stepRaise() {
  console.log('\n[raise] 접힘 ↔ 복귀에서 스레드·스크롤 · 보드 없는 다이얼')
  const s = (rep.steps.raise = {})
  const HOME = path.join(REPO, '.critic-home-mux-raise')
  fs.rmSync(HOME, { recursive: true, force: true })
  makeMultiFixture(HOME, APP_VERSION, { panels: 6, itemsPerPanel: 30 })
  const app = await boot(HOME, 9382)
  try {
    if (!(await waitFor(app.cdp, `__n('.ma-grid > .ma-panel') === 6`))) return fail('raise.boot', '6자리 부팅 실패')
    await sleep(2500)
    const SC = `(() => { const p=document.querySelectorAll('.ma-grid > .ma-panel')[2]; const t=p && p.querySelector('.thread, .chat-scroll, .scroll'); return t ? { top: Math.round(t.scrollTop), h: t.scrollHeight, len: (p.innerText||'').length } : null })()`
    // 3번 자리의 스레드를 중간까지 올린다
    await app.cdp.eval(`(() => { const p=document.querySelectorAll('.ma-grid > .ma-panel')[2]; const t=p && p.querySelector('.thread, .chat-scroll, .scroll'); if(!t) return false; t.scrollTop = Math.round(t.scrollHeight*0.35); t.dispatchEvent(new Event('scroll',{bubbles:true})); return true })()`)
    await sleep(700)
    s.before = await app.cdp.eval(SC)
    const title = (await app.cdp.eval(`__txts('.ma-grid > .ma-panel .ma-p-title')`))[2]
    s.title = title
    // 3번을 포커스하지 않은 채 접는다(1번 자리를 포커스) → 3번이 접힘 집합으로
    await app.cdp.eval(`__mdown('.ma-grid > .ma-panel', 0)`)
    await sleep(200)
    await app.cdp.eval(`__c('.ma-count-btn[data-count="1"]')`)
    await waitFor(app.cdp, `__n('.ma-grid.n1 > .ma-panel') === 1`)
    await sleep(600)
    // 팝오버에서 ↥
    await app.cdp.eval(`__c('.ma-fold-badge')`)
    await sleep(400)
    const rows = await app.cdp.eval(`__txts('.ma-fold-row')`)
    s.popRows = rows
    const picked = await app.cdp.eval(`(() => { const r=[...document.querySelectorAll('.ma-fold-row')].find(e=>(e.textContent||'').includes(${JSON.stringify(title)})); if(!r) return false; r.click(); return true })()`)
    s.picked = picked
    await sleep(1200)
    const shown = await app.cdp.eval(`__txts('.ma-grid > .ma-panel .ma-p-title')`)
    s.shown = shown
    if (shown[0] !== title) fail('raise.pop', '팝오버 ↥가 그 대화를 1번 자리로 올리지 않았다', { want: title, shown })
    else ok('raise.pop', shown[0])
    const after = await app.cdp.eval(`(() => { const p=document.querySelectorAll('.ma-grid > .ma-panel')[0]; const t=p && p.querySelector('.thread, .chat-scroll, .scroll'); return t ? { top: Math.round(t.scrollTop), h: t.scrollHeight, len: (p.innerText||'').length } : null })()`)
    s.after = after
    if (!after || !s.before) fail('raise.measure', '스크롤을 못 쟀다', { before: s.before, after })
    else if (after.len < Math.min(s.before.len, 200) * 0.5)
      fail('raise.thread', '되올린 자리의 스레드가 짧아졌다 — 대화 손실', { before: s.before, after })
    else ok('raise.thread', { beforeLen: s.before.len, afterLen: after.len })
    s.scrollKept = s.before && after ? Math.abs(after.top - s.before.top) < 40 : null
    if (s.scrollKept === false)
      fail('raise.scroll', '접었다 되올리면 스크롤 위치가 리셋된다(자리 밖으로 나간 패널은 언마운트된다) — 「같은 자리로 돌아온다」는 대화만이고 읽던 지점은 아니다', { before: s.before, after })
    else ok('raise.scroll', { before: s.before?.top, after: after?.top })

    // ── 보드가 없는 상태에서 일반 채팅의 다이얼 4 ──────────────────────────
    // (여기 픽스처는 보드가 하나 있으므로 배치를 지우고 시험한다)
    await app.cdp.eval(`__pick('벤치 긴 스레드')`)
    await waitFor(app.cdp, `!document.querySelector('.ma-grid')`)
    await sleep(800)
    await app.cdp.eval(`(async () => { await window.api.multi.save({ version: 2, activeSessionId: '', order: [], sessions: {} }) })()`, { awaitPromise: true }).catch(() => null)
    s.dialFromSingle = { before: await app.cdp.eval(`__n('.ma-grid')`) }
    await app.cdp.eval(`__c('.ma-count-btn[data-count="4"]')`)
    await sleep(1500)
    s.dialFromSingle.gridAfter = await app.cdp.eval(`__n('.ma-grid > .ma-panel')`)
    s.dialFromSingle.cls = await app.cdp.eval(`(document.querySelector('.ma-grid')||{}).className || ''`)
    s.dialFromSingle.body = await app.cdp.eval(`((document.querySelector('.win-body')||document.body).innerText||'').slice(0,200)`)
    if (s.dialFromSingle.gridAfter !== 4)
      fail('raise.dial-from-single', `일반 채팅에서 다이얼 4를 눌렀는데 4자리 보드가 안 열렸다(자리 ${s.dialFromSingle.gridAfter})`, s.dialFromSingle)
    else ok('raise.dial-from-single', s.dialFromSingle.gridAfter)
  } finally {
    killTree(app.child.pid)
    await sleep(1000)
    if (!KEEP) await rmHome(HOME)
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 10. 보드를 지운 뒤에도 그 자리들이 「채팅」 목록에 남는가 (panelInfos 고아)
// ═══════════════════════════════════════════════════════════════════════════
async function stepStale() {
  console.log('\n[stale] 보드 삭제 후 사이드바에 남는 자리 항목')
  const s = (rep.steps.stale = {})
  const HOME = path.join(REPO, '.critic-home-mux-stale')
  fs.rmSync(HOME, { recursive: true, force: true })
  makeMultiFixture(HOME, APP_VERSION, { panels: 6, itemsPerPanel: 3 })
  const app = await boot(HOME, 9383)
  try {
    if (!(await waitFor(app.cdp, `__n('.ma-grid > .ma-panel') === 6`))) return fail('stale.boot', '6자리 부팅 실패')
    await sleep(2000)
    s.before = (await app.cdp.eval(`__sbItems()`))[0].items.map((i) => i.t)
    // 「배치」 섹션의 보드를 우클릭 → 삭제
    await app.cdp.eval(`(() => { const sec=document.querySelectorAll('.sb-sec')[1]; const el=sec && sec.querySelector('.sb-item'); if(!el) return false
      const r=el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:Math.round(r.x+20),clientY:Math.round(r.y+8)})); return true })()`)
    await sleep(400)
    await app.cdp.eval(`(() => { const b=[...document.querySelectorAll('.ctx-menu .ctx-item')].find(e=>(e.textContent||'').includes('삭제')); if(!b) return false; b.click(); return true })()`)
    await sleep(400)
    s.card = await app.cdp.eval(`(document.querySelector('.sconfirm .sct')||{}).textContent || ''`)
    await app.cdp.eval(`__c('.sconfirm .scb .danger')`)
    await sleep(2000)
    const after = await app.cdp.eval(`__sbItems()`)
    s.after = after
    const ghosts = after[0].items.filter((i) => i.t.startsWith('벤치 패널'))
    s.ghosts = ghosts
    if (ghosts.length)
      fail('stale.board-deleted-items-remain', '보드를 지웠는데 그 자리 대화들이 「채팅」 목록에 그대로 남는다(panelInfos가 안 비워진다)', { ghosts: ghosts.map((g) => g.t + g.chip), boards: after[1]?.items })
    else ok('stale.cleared')
    if (ghosts.length) {
      // 남은 유령을 눌러 보면?
      await app.cdp.eval(`__pick(${JSON.stringify(ghosts[0].t)})`)
      await sleep(1200)
      s.clickResult = {
        grid: await app.cdp.eval(`__n('.ma-grid > .ma-panel')`),
        titles: await app.cdp.eval(`__txts('.ma-grid > .ma-panel .ma-p-title')`),
        body: await app.cdp.eval(`((document.querySelector('.win-body')||document.body).innerText||'').slice(0,160)`)
      }
      fail('stale.ghost-click', '지운 보드의 자리 항목을 누르면 무슨 일이 일어나는지 화면이 답하지 않는다', s.clickResult)
    }
  } finally {
    killTree(app.child.pid)
    await sleep(1000)
    if (!KEEP) await rmHome(HOME)
  }
}

// ── main ───────────────────────────────────────────────────────────────────
;(async () => {
  if (!fs.existsSync(EXE)) { console.error(`실행 파일 없음: ${EXE}`); process.exit(2) }
  try {
    rep.gitHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim()
    rep.exeMtime = fs.statSync(EXE).mtime.toISOString()
  } catch { /* 기록용 */ }
  if (want('spam')) await stepSpam()
  if (want('geom')) await stepGeom()
  if (want('side')) await stepSide()
  if (want('viewer')) await stepViewer()
  if (want('busydel')) await stepBusyDel()
  if (want('bgdel')) await stepBgDel()
  if (want('queue')) await stepQueue()
  if (want('mid')) await stepMid()
  if (want('foldrun')) await stepFoldRun()
  if (want('raise')) await stepRaise()
  if (want('stale')) await stepStale()

  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  rep.broke = rep.findings.length
  const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null
  if (prev && ONLY.size && !ONLY.has('all')) {
    rep.steps = { ...prev.steps, ...rep.steps }
    const keep = (prev.findings ?? []).filter((f) => !Object.keys(rep.steps).some((k) => f.id.startsWith(k + '.') && want(k)))
    rep.findings = [...keep, ...rep.findings]
    rep.broke = rep.findings.length
  }
  fs.writeFileSync(OUT, JSON.stringify(rep, null, 2))
  console.log(`\n리포트: ${OUT}`)
  console.log(rep.findings.length === 0 ? '\n공격 실패 — 아무것도 안 깨졌다' : `\n깨진 것 ${rep.findings.length}건`)
})().catch((e) => { console.error(e); process.exit(3) })
