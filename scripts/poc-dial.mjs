#!/usr/bin/env node
/* ============================================================================
 * poc-dial — **다이얼 1↔6 무손실 실증**. 실 창 · 실 스토어 · 실 화면.
 *
 * M-UX 1단계의 계약(ux-chat-unify §2.2)이 화면에서 지켜지는지에만 답한다:
 *
 *   대화 6개가 있는 배치 → 다이얼 **1** → 5개는 접힘(삭제 아님) → 다이얼 **6**
 *        → 여섯 대화가 **전부 살아 있고 순서도 그대로**  → 앱 재시작 후에도 그대로
 *
 *   그리고 스펙이 명시한 두 규약을 같은 하네스로 잰다:
 *     · 축소 시 **포커스된 자리가 1번 자리로** 승격되고, 나머지 상대 순서는 보존된다.
 *     · 채팅 전환이 `chats:set-active`로 **즉시** 반영된다(저장 디바운스 600ms 이전에).
 *
 *   node scripts/poc-dial.mjs                # 전부
 *   node scripts/poc-dial.mjs --only=dial    # 1↔6↔1 왕복만
 *   node scripts/poc-dial.mjs --only=active  # chats:set-active 즉시성만
 *   node scripts/poc-dial.mjs --only=queue   # ★ R2 예약 큐 소유권 (실 CLI 3턴)
 *   node scripts/poc-dial.mjs --keep         # 홈 보존(사후 조사용)
 *
 * ── 안전 규칙 (사용자 실앱이 떠 있다) ───────────────────────────────────────
 *  · **이름 기반 kill 금지.** 죽이는 것은 이 스크립트가 spawn한 PID 트리뿐이다.
 *  · **실홈은 읽기/복사만.** 픽스처가 자격증명을 격리 홈으로 복사할 뿐 되쓰지 않는다.
 *  · 앱 홈은 `CCG_HOME`으로 격리한다(레포 안 `.poc-home-dial`).
 *  · 엔진 턴은 **한 번도 돌리지 않는다** — 픽스처가 대화를 미리 심어 두므로 CLI·계정·
 *    토큰 소비가 0이다. 이 PoC가 재는 것은 UI 상태기계지 엔진이 아니다.
 * ========================================================================== */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { connectMainPage, killTree, sleep, REPO } from '../bench/lib.mjs'
import { makeMultiFixture } from '../bench/fixture.mjs'

const args = process.argv.slice(2)
const only = (args.find((a) => a.startsWith('--only=')) ?? '').split('=')[1] || 'all'
const KEEP = args.includes('--keep')
const EXE = path.join(REPO, 'target', 'release', 'agentcodegui.exe')
const HOME = path.join(REPO, '.poc-home-dial')
const OUT = path.join(REPO, 'docs', 'critic', 'm-ux-r1-dial.json')
const APP_VERSION = '3.0.0-beta.1'
const PORT = 9351

const rep = { at: new Date().toISOString(), exe: EXE, steps: {}, findings: [] }
const fail = (id, why, extra) => {
  rep.findings.push({ id, why, ...(extra ?? {}) })
  console.error(`  x ${id} — ${why}${extra ? ' ' + JSON.stringify(extra) : ''}`)
}
const ok = (id, v) => console.log(`  o ${id}${v === undefined ? '' : ' — ' + JSON.stringify(v)}`)

// ── 앱 부팅 + CDP ─────────────────────────────────────────────────────────────
async function boot() {
  const child = spawn(EXE, [], {
    env: {
      ...process.env,
      CCG_HOME: HOME,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  child.stdout.on('data', (d) => (log += d.toString()))
  child.stderr.on('data', (d) => (log += d.toString()))
  const cdp = await connectMainPage(PORT, { timeoutMs: 60_000 })
  // 렌더러 마운트 + IPC 브리지가 실제로 답할 때까지(둘은 다른 시점이다)
  for (let i = 0; i < 300; i++) {
    const up = await cdp
      .eval(`(async () => { try { return !!(await window.api.app.getVersion()) } catch { return false } })()`, {
        awaitPromise: true
      })
      .catch(() => false)
    if (up) break
    await sleep(100)
  }
  // 헬퍼 주입 — 화면 인벤토리(bench/screens.mjs)와 같은 문법
  await cdp.eval(`(() => {
    window.__c = (sel, n = 0) => { const e = document.querySelectorAll(sel)[n]; if (!e) return false; e.click(); return true }
    window.__n = (sel) => document.querySelectorAll(sel).length
    window.__txts = (sel) => [...document.querySelectorAll(sel)].map((e) => (e.textContent || '').trim())
    window.__mdown = (sel, n = 0) => {
      const e = document.querySelectorAll(sel)[n]; if (!e) return false
      e.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
      return true
    }
    return true
  })()`)
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

/**
 * 값이 **멈출 때까지** 기다린다. 사이드바는 두 번에 나눠 찬다 — 보드 자리는 마운트
 * 즉시, 일반 채팅은 `chats:get`(비동기 하이드레이션)이 온 뒤. 앞의 스냅샷을 기준으로
 * 삼으면 "나중에 하나 늘었다"를 대화 증발로 오판한다(이 PoC가 처음 밟은 함정).
 */
async function waitStable(cdp, expr, { gap = 350, rounds = 3, tries = 40 } = {}) {
  let last = JSON.stringify(await cdp.eval(expr).catch(() => null))
  let same = 0
  for (let i = 0; i < tries; i++) {
    await sleep(gap)
    const now = JSON.stringify(await cdp.eval(expr).catch(() => null))
    same = now === last ? same + 1 : 0
    last = now
    if (same >= rounds - 1) break
  }
  return JSON.parse(last)
}

/** 격리 홈 정리 — 죽인 직후엔 WebView2 핸들이 잠깐 남는다(ab.mjs와 같은 함정) */
async function rmHome(dir, tries = 12) {
  for (let i = 0; i < tries; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      return true
    } catch {
      await sleep(500)
    }
  }
  return false
}

/** 그리드에 보이는 자리들의 제목 — 자리 순서대로. 이게 "순서 보존"의 저울이다. */
const VISIBLE_TITLES = `__txts('.ma-grid > .ma-panel .ma-p-title')`
/** 사이드바 「채팅」 목록에 실린 대화 제목 전부 (접힌 것 포함 — 이게 "생존"의 저울이다) */
const SIDEBAR_TITLES = `__txts('.sb-sec:first-child .sb-item .t .tx')`
/** 접힌 자리 칩 개수 */
const FOLDED_CHIPS = `__n('.sb-sec:first-child .sb-item .slotchip.folded')`

// ── 1. 다이얼 1↔6 왕복 ────────────────────────────────────────────────────────
async function stepDial() {
  console.log('\n[dial] 대화 6개 → 1 → 6 — 전부 생존 + 순서 보존')
  const s = (rep.steps.dial = { checks: {} })
  const app = await boot()
  try {
    // 부팅 상태 — 픽스처는 6패널 배치(전부 내용 있음)로 열린다
    const grid6 = await waitFor(app.cdp, `__n('.ma-grid > .ma-panel') === 6`)
    if (!grid6) {
      fail('dial.boot', '6자리 그리드로 부팅하지 못했다', { panels: await app.cdp.eval(`__n('.ma-grid > .ma-panel')`) })
      return
    }
    const before = await app.cdp.eval(VISIBLE_TITLES)
    // 사이드바는 두 원천(보드 자리 + 일반 채팅 하이드레이션)이 채우므로 멈출 때까지 기다린다
    const sideBefore = await waitStable(app.cdp, SIDEBAR_TITLES)
    s.checks.before = { visible: before, sidebar: sideBefore }
    ok('dial.boot', { visible: before.length, sidebar: sideBefore.length })
    // 통합 목록 — 보드 자리는 자리 칩을 달고, 일반 채팅(픽스처의 긴 스레드)은 칩이 없다
    const chips = await app.cdp.eval(`__n('.sb-sec:first-child .sb-item .slotchip')`)
    s.checks.chipsAt6 = chips
    if (chips !== 6) fail('dial.unified', '보드 자리 6개가 자리 칩을 달지 않았다(또는 일반 채팅에 칩이 붙었다)', { chips, sidebar: sideBefore })
    else ok('dial.unified', { chips, chats: sideBefore.length })

    // ── 6 → 1 ────────────────────────────────────────────────────────────────
    await app.cdp.eval(`__c('.ma-count-btn[data-count="1"]')`)
    const one = await waitFor(app.cdp, `__n('.ma-grid.n1 > .ma-panel') === 1`)
    if (!one) fail('dial.to1', '다이얼 1이 IDE 크롬(.ma-grid.n1 한 자리)을 만들지 못했다')
    else ok('dial.to1')

    // .ma-head는 사라지고 그 줄의 역할(다이얼·창 컨트롤)은 패널 헤더가 이어받는다
    const headGone = await app.cdp.eval(`__n('.ma-head') === 0 && __n('.ma-grid.n1 .ma-p-head .ma-count') === 1`)
    if (!headGone) fail('dial.topbar', 'n1에서 헤더 줄이 둘로 쌓였다(또는 다이얼이 패널 헤더에 없다)')
    else ok('dial.topbar')

    // 접힘 배지 = 5 (삭제가 아니라 접힘이라는 유일한 화면 증거)
    const badge = await app.cdp.eval(`(document.querySelector('.ma-fold-badge .cnt')||{}).textContent || ''`)
    s.checks.foldBadge = badge
    if (badge.trim() !== '5') fail('dial.badge', `접힘 배지가 5가 아니다`, { badge })
    else ok('dial.badge', badge)

    // 사이드바 — 여섯 대화가 **그대로** 있고, 다섯은 접힌 자리 칩을 단다
    const sideAt1 = await app.cdp.eval(SIDEBAR_TITLES)
    const folded = await app.cdp.eval(FOLDED_CHIPS)
    s.checks.at1 = { sidebar: sideAt1, foldedChips: folded }
    const gone = sideBefore.filter((x) => !sideAt1.includes(x))
    if (gone.length) fail('dial.sidebar1', '접었더니 사이드바에서 대화가 사라졌다', { gone })
    else ok('dial.sidebar1', { chats: sideAt1.length })
    if (folded !== 5) fail('dial.chips', `접힌 자리 칩이 5개가 아니다`, { folded })
    else ok('dial.chips', folded)

    // 접힌 자리 팝오버 — 다섯 줄이 뜨고 각 줄이 「1번 자리로 올리기」를 준다
    await app.cdp.eval(`__c('.ma-fold-badge')`)
    const rows = await waitFor(app.cdp, `__n('.ma-fold-row')`)
    s.checks.foldRows = rows
    if (rows !== 5) fail('dial.pop', `접힘 팝오버 줄이 5개가 아니다`, { rows })
    else ok('dial.pop', rows)
    await app.cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
    await sleep(150)

    // ── 1 → 6 ────────────────────────────────────────────────────────────────
    await app.cdp.eval(`__c('.ma-count-btn[data-count="6"]')`)
    const six = await waitFor(app.cdp, `__n('.ma-grid.n6 > .ma-panel') === 6`)
    if (!six) fail('dial.to6', '되올렸는데 6자리로 복귀하지 못했다')
    else ok('dial.to6')
    const after = await app.cdp.eval(VISIBLE_TITLES)
    s.checks.after = after
    const sameOrder = JSON.stringify(before) === JSON.stringify(after)
    if (!sameOrder) fail('dial.order', '되올린 자리 순서가 접기 전과 다르다', { before, after })
    else ok('dial.order', after)

    // ── 포커스 승격 규약 — 3번 자리를 포커스하고 접으면 그게 1번 자리가 된다 ──
    await app.cdp.eval(`__mdown('.ma-grid > .ma-panel', 2)`)
    await sleep(120)
    const focusTitle = (await app.cdp.eval(VISIBLE_TITLES))[2]
    await app.cdp.eval(`__c('.ma-count-btn[data-count="1"]')`)
    await waitFor(app.cdp, `__n('.ma-grid.n1 > .ma-panel') === 1`)
    const promoted = (await app.cdp.eval(VISIBLE_TITLES))[0]
    s.checks.promote = { focused: focusTitle, shown: promoted }
    if (promoted !== focusTitle) fail('dial.promote', '접을 때 포커스된 자리가 1번 자리로 오지 않았다', s.checks.promote)
    else ok('dial.promote', promoted)

    // 되올리면 승격된 자리가 맨 앞, 나머지는 상대 순서 보존
    await app.cdp.eval(`__c('.ma-count-btn[data-count="6"]')`)
    await waitFor(app.cdp, `__n('.ma-grid.n6 > .ma-panel') === 6`)
    const after2 = await app.cdp.eval(VISIBLE_TITLES)
    const expect2 = [focusTitle, ...before.filter((x) => x !== focusTitle)]
    s.checks.after2 = { got: after2, expect: expect2 }
    if (JSON.stringify(after2) !== JSON.stringify(expect2)) fail('dial.promote-order', '승격 후 나머지 상대 순서가 깨졌다', s.checks.after2)
    else ok('dial.promote-order')

    // ── 재시작 생존 — 화면 상태가 아니라 **디스크**가 대화를 지켰는지 ──────────
    await sleep(1200) // 커밋 디바운스(600ms) + 저장 여유
    killTree(app.child.pid)
    await sleep(1500)
    const app2 = await boot()
    try {
      const back = await waitFor(app2.cdp, `__n('.ma-grid > .ma-panel') >= 1`)
      if (!back) {
        fail('dial.restart', '재시작 후 배치가 안 떴다')
        return
      }
      const sideAfter = await waitStable(app2.cdp, SIDEBAR_TITLES)
      s.checks.restart = { sidebar: sideAfter }
      const lost = sideBefore.filter((tt) => !sideAfter.includes(tt))
      if (lost.length) fail('dial.restart', '재시작 후 사라진 대화가 있다', { lost })
      else ok('dial.restart', { chats: sideAfter.length })
      // 자리 수도 기억한다(마지막이 6이었다)
      const n = await app2.cdp.eval(`__n('.ma-grid > .ma-panel')`)
      s.checks.restartCount = n
      if (n !== 6) fail('dial.restart-count', '재시작 후 자리 수가 6이 아니다', { n })
      else ok('dial.restart-count', n)
    } finally {
      killTree(app2.child.pid)
    }
    app.child.killed = true // 위에서 이미 정리했다
  } finally {
    if (!app.child.killed) killTree(app.child.pid)
  }
}

// ── 2. chats:set-active 즉시성 ────────────────────────────────────────────────
// 별칭 계층(claude:* → chat:*)이 "지금 활성 채팅"으로 명령을 라우팅하므로, 전환은
// 저장 디바운스(600ms)를 기다리면 안 된다. 전환 직후 조회가 이미 새 값이어야 한다.
async function stepActive() {
  console.log('\n[active] 채팅 전환이 chats:set-active로 즉시 반영되는가')
  const s = (rep.steps.active = { checks: {} })
  const app = await boot()
  try {
    await waitFor(app.cdp, `!!document.querySelector('.sidebar')`)
    // 일반 채팅 2개를 만든다 — 전송 없이(엔진 0턴): 제목만 붙여도 목록에 뜬다
    const made = await app.cdp.eval(
      `(async () => {
         const get = async () => await window.api.getChats()
         const cur = await get()
         const mk = (id, title) => ({ id, title, custom: true, snapshot: { status:'idle', messages:[{kind:'msg',id:id+'m',role:'user',text:title,animate:false,time:'오후 3:00'}], todos:[], files:[], diffs:{}, subagents:[], bgTasks:[], session:null, result:null, spentUsd:0, tokenTotals:{}, seq:1, shownNotices:[] }, manualCwd:'', refDirs:[], picker:{model:'haiku',effort:'minimal',mode:'bypass'}, updatedAt: Date.now() })
         const chats = [mk('poc-a','POC 채팅 A'), mk('poc-b','POC 채팅 B'), ...(cur?.chats ?? [])]
         await window.api.saveChats({ version: 1, chats, activeChatId: 'poc-a' })
         return chats.length
       })()`,
      { awaitPromise: true }
    )
    s.checks.seeded = made
    // 재부팅해야 렌더러가 이 목록을 읽는다(부팅 경로가 유일한 하이드레이션)
    killTree(app.child.pid)
    app.child.killed = true
    await sleep(1200)
    const app2 = await boot()
    try {
      const listed = await waitFor(app2.cdp, `__txts('.sb-item .t .tx').filter((x)=>x.startsWith('POC 채팅')).length === 2`)
      if (!listed) {
        fail('active.seed', '심어둔 두 채팅이 목록에 안 보인다', { titles: await app2.cdp.eval(`__txts('.sb-item .t .tx')`) })
        return
      }
      ok('active.seed')
      const before = await app2.cdp.eval(`(async () => (await window.api.getChats())?.activeChatId)()`, { awaitPromise: true })
      // 목록에서 다른 채팅으로 전환 → **즉시** 스토어의 활성이 바뀌어야 한다
      const target = before === 'poc-a' ? 'POC 채팅 B' : 'POC 채팅 A'
      await app2.cdp.eval(
        `(() => { const el = [...document.querySelectorAll('.sb-item')].find((e) => (e.textContent||'').includes(${JSON.stringify(target)})); if (el) el.click(); return !!el })()`
      )
      await sleep(120) // 저장 디바운스(600ms)보다 한참 짧게
      const after = await app2.cdp.eval(`(async () => (await window.api.getChats())?.activeChatId)()`, { awaitPromise: true })
      s.checks.active = { before, after, target }
      if (!after || after === before) fail('active.immediate', '전환 직후 스토어의 활성 채팅이 안 바뀌었다', s.checks.active)
      else ok('active.immediate', s.checks.active)
    } finally {
      killTree(app2.child.pid)
    }
  } finally {
    if (!app.child.killed) killTree(app.child.pid)
  }
}

// ── 3. 실행 중 채팅 전환 — 떠난 대화의 꼬리를 잃지 않는가 (스펙 ⑥) ─────────────
//
// 2.6.2는 busy 중 전환을 **조용히 막았다**(App.tsx:799). 3.0은 허용하는 대신
// `chat:event`(통합 봉투)로 떠난 채팅의 스트림을 계속 접는다. 이 단계가 재는 것은
// 딱 하나다 — **돌아왔을 때 그 답이 스레드에 있는가.** 없으면 대화 유실이고,
// 그러면 ⑥은 채택하면 안 되는 변경이다.
//
// 실 CLI 1턴이 필요하다(값싼 조합: haiku·minimal·bypass — 승인 카드 없이 끝난다).
const BG_PROMPT = 'Reply with exactly: BGDONE'

function seedBgHome(name = 'bg') {
  const home = path.join(REPO, `.poc-home-dial-${name}`)
  const work = path.join(home, 'work')
  const realHome = path.join(os.homedir(), '.agentcodegui')
  fs.rmSync(home, { recursive: true, force: true })
  fs.mkdirSync(work, { recursive: true })
  const write = (p, v) => {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify(v))
  }
  // 엔진 — 실홈 engines를 정션으로(복사 없음·쓰기 없음)
  const ver = JSON.parse(fs.readFileSync(path.join(realHome, 'config.json'), 'utf8')).activeVersion
  write(path.join(home, 'config.json'), { activeVersion: ver })
  spawnSync('cmd', ['/c', 'mklink', '/J', path.join(home, 'engines'), path.join(realHome, 'engines')], { encoding: 'utf8' })
  const cli = path.join(home, 'engines', ver, 'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe')
  if (!fs.existsSync(cli)) throw new Error(`claude.exe 없음: ${cli}`)
  // 계정 — 기본 계정 자격증명을 **복사**(CLI의 토큰 갱신이 실홈에 안 닿게)
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
  write(path.join(home, 'accounts.json'), accounts)
  const chat = (id, title) => ({
    id, title, custom: true, manualCwd: work, refDirs: [],
    picker: { model: 'haiku', effort: 'minimal', mode: 'bypass' },
    snapshot: { messages: [] }, updatedAt: Date.now()
  })
  write(path.join(home, 'chats', 'index.json'), { version: 1, order: ['c-run', 'c-side'], activeChatId: 'c-run' })
  write(path.join(home, 'chats', 'c-run.json'), chat('c-run', 'POC 도는 채팅'))
  write(path.join(home, 'chats', 'c-side.json'), chat('c-side', 'POC 옆 채팅'))
  write(path.join(home, 'ui-prefs.json'), { 'ui.lang': 'ko', 'workspace.mode': 'single', 'whatsnew.seenVersion': APP_VERSION })
  write(path.join(home, 'profile.json'), { nickname: 'poc' })
  return { home, ver, email: accounts.defaultEmail }
}

async function stepBg() {
  console.log('\n[bg] 실행 중 전환 — 떠난 대화의 꼬리를 잃지 않는가')
  const s = (rep.steps.bg = { checks: {} })
  let seed
  try {
    seed = seedBgHome()
  } catch (e) {
    fail('bg.seed', `격리 홈을 못 만들었다: ${String(e.message ?? e)}`)
    return
  }
  s.engine = seed.ver
  const child = spawn(EXE, [], {
    env: { ...process.env, CCG_HOME: seed.home, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT + 1}` },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const cdp = await connectMainPage(PORT + 1, { timeoutMs: 60_000 })
  try {
    for (let i = 0; i < 300; i++) {
      const up = await cdp.eval(`(async () => { try { return !!(await window.api.app.getVersion()) } catch { return false } })()`, { awaitPromise: true }).catch(() => false)
      if (up) break
      await sleep(100)
    }
    await cdp.eval(`(() => {
      window.__c = (sel, n = 0) => { const e = document.querySelectorAll(sel)[n]; if (!e) return false; e.click(); return true }
      window.__n = (sel) => document.querySelectorAll(sel).length
      window.__txts = (sel) => [...document.querySelectorAll(sel)].map((e) => (e.textContent || '').trim())
      window.__pick = (needle) => { const el = [...document.querySelectorAll('.sb-item')].find((e) => (e.textContent||'').includes(needle)); if (!el) return false; el.click(); return true }
      return true
    })()`)
    const ready = await waitFor(cdp, `__txts('.sb-item .t .tx').filter((x)=>x.startsWith('POC')).length === 2`)
    if (!ready) {
      fail('bg.boot', '두 채팅이 목록에 안 떴다', { titles: await cdp.eval(`__txts('.sb-item .t .tx')`) })
      return
    }
    ok('bg.boot')
    // 전송 — 진짜 컴포저에 타이핑 + Enter (React value setter 우회 금지)
    await cdp.eval(`(() => {
      const ta = document.querySelector('.composer-row textarea') || document.querySelector('textarea')
      if (!ta) return 'no-textarea'
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(ta, ${JSON.stringify(BG_PROMPT)})
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      ta.focus()
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      return 'sent'
    })()`)
    // busy가 실제로 걸릴 때까지 — 여기서 전환해야 "실행 중 전환"이다
    const busy = await waitFor(cdp, `!!document.querySelector('.composer .stop-btn, .composer-row .stop, .wk-ind') || __n('.thread .msg') > 0`, { tries: 300 })
    s.checks.busyBeforeSwitch = !!busy
    if (!busy) fail('bg.busy', '전송 후 실행 표시가 안 떴다')
    else ok('bg.busy')
    // ★ 실행 중 전환 — 2.6.2라면 여기서 아무 일도 안 일어난다(침묵 no-op)
    await cdp.eval(`__pick('POC 옆 채팅')`)
    const switched = await waitFor(cdp, `(async () => (await window.api.getChats())?.activeChatId === 'c-side')()`, { tries: 60 })
    s.checks.switchedWhileBusy = !!switched
    if (!switched) {
      fail('bg.switch', '실행 중 전환이 여전히 막혀 있다(침묵 no-op)')
      return
    }
    ok('bg.switch')
    // 옆 채팅은 비어 있어야 한다 — 남의 스트림이 섞이면 그게 최악의 사고다
    await sleep(1500)
    const sideClean = await cdp.eval(`__n('.thread .msg') === 0`)
    s.checks.sideClean = sideClean
    if (!sideClean) fail('bg.bleed', '떠난 채팅의 스트림이 옆 채팅 화면에 섞였다')
    else ok('bg.bleed(섞임 없음)')
    // 턴이 끝날 때까지 기다렸다가 되돌아온다
    await sleep(20000)
    await cdp.eval(`__pick('POC 도는 채팅')`)
    // ★ 판정은 **어시스턴트 말풍선**으로 — 사용자가 보낸 프롬프트에도 BGDONE이 들어 있어
    // body 전체를 보면 항상 통과하는 가짜 통과가 된다(1차 실행에서 실제로 밟았다).
    const AI_HAS = `__txts('.thread .msg.ai-msg').some((x) => x.includes('BGDONE'))`
    const back = await waitFor(cdp, AI_HAS, { tries: 300 })
    s.checks.tailKept = !!back
    s.checks.aiMsgs = await cdp.eval(`__txts('.thread .msg.ai-msg').map((x) => x.slice(0, 60))`)
    s.checks.chatEv = await cdp.eval(`window.__ccgChatEv ? { n: window.__ccgChatEv.n, ids: window.__ccgChatEv.ids } : null`)
    if (!back) fail('bg.tail', '돌아왔더니 자리 밖에서 온 답이 스레드에 없다 — 대화 꼬리 유실', s.checks)
    else ok('bg.tail', { ai: s.checks.aiMsgs })
  } finally {
    cdp.close()
    killTree(child.pid)
    await sleep(1200)
    if (!KEEP) await rmHome(seed.home)
  }
}

// ── 4. ★ R2 — 예약 큐의 **소유자는 채팅이다** ─────────────────────────────────
//
// 스펙 ⑥(busy 중 전환)을 열면 "활성 채팅 = 유일하게 도는 채팅"이라는 전제가 깨진다.
// R1은 큐를 App 단위 단일 목록으로 뒀고, 전환이 만든 busy true→false 에지에서 드레인이
// 돌아 **A의 예약이 B로 발사됐다**(크리틱 M-UX R1 §2-① `queue.misroute` — B의 엔진이
// B의 폴더·모델·계정·모드로 실제로 돌았다).
//
// 이 단계가 잠그는 불변식 넷:
//   ① 예약은 그 채팅에 **주차**된다 — 떠나면 B의 컴포저에 남의 예약이 안 보인다.
//   ② 돌아오면 **되돌아온다** — 주차가 삭제가 아니다.
//   ③ 발사는 **그 채팅의 턴 종료**에만, **그 채팅으로**(`chat:run{chatId}`) — 화면이
//      B에 있어도 A로 나간다.
//   ④ B는 처음부터 끝까지 **한 글자도 안 받는다**.
//
// 실 CLI 3턴(값싼 조합: haiku·minimal·bypass). 첫 턴은 예약을 걸 시간을 벌 만큼 길어야
// 한다 — 짧으면 예약하기 전에 턴이 끝나 축 자체를 못 잰다(크리틱이 남긴 함정 그대로).
const Q_LONG = 'Count from 1 to 300, one number per line, nothing else. Never stop early.'
const Q_P1 = 'QOWNER-ALPHA'
const Q_P2 = 'QOWNER-BETA'

async function bootAt(home, port) {
  const child = spawn(EXE, [], {
    env: { ...process.env, CCG_HOME: home, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const cdp = await connectMainPage(port, { timeoutMs: 60_000 })
  for (let i = 0; i < 300; i++) {
    const up = await cdp
      .eval(`(async () => { try { return !!(await window.api.app.getVersion()) } catch { return false } })()`, { awaitPromise: true })
      .catch(() => false)
    if (up) break
    await sleep(100)
  }
  await cdp.eval(`(() => {
    window.__n = (sel) => document.querySelectorAll(sel).length
    window.__txts = (sel) => [...document.querySelectorAll(sel)].map((e) => (e.textContent || '').trim())
    window.__pick = (needle) => { const el = [...document.querySelectorAll('.sb-item')].find((e) => (e.textContent||'').includes(needle)); if (!el) return false; el.click(); return true }
    window.__send = (text) => {
      const ta = document.querySelector('.composer-row textarea') || document.querySelector('textarea')
      if (!ta) return 'no-textarea'
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(ta, text)
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      ta.focus()
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      return 'sent'
    }
    return true
  })()`)
  return { child, cdp }
}

async function stepQueue() {
  console.log('\n[queue] 예약 큐의 소유자는 채팅이다 — 떠나도 남의 대화로 안 나간다')
  const s = (rep.steps.queue = { checks: {} })
  let seed
  try {
    seed = seedBgHome('queue')
  } catch (e) {
    fail('queue.seed', `격리 홈을 못 만들었다: ${String(e.message ?? e)}`)
    return
  }
  s.engine = seed.ver
  const app = await bootAt(seed.home, PORT + 2)
  try {
    if (!(await waitFor(app.cdp, `__txts('.sb-item .t .tx').filter((x)=>x.startsWith('POC')).length === 2`))) {
      fail('queue.boot', '두 채팅이 목록에 안 떴다', { titles: await app.cdp.eval(`__txts('.sb-item .t .tx')`) })
      return
    }
    // A에서 긴 턴 시작
    await app.cdp.eval(`__send(${JSON.stringify(Q_LONG)})`)
    if (!(await waitFor(app.cdp, `!!document.querySelector('.send.stop, .send.schedule')`, { tries: 300 }))) {
      fail('queue.busy', '전송 후 실행이 안 걸렸다')
      return
    }
    // busy 중 예약 2건
    await app.cdp.eval(`__send(${JSON.stringify(Q_P1)})`)
    await sleep(300)
    await app.cdp.eval(`__send(${JSON.stringify(Q_P2)})`)
    await sleep(400)
    const queued = await app.cdp.eval(`__txts('.sched-item .sched-text')`)
    s.checks.queued = queued
    if (queued.length !== 2) {
      fail('queue.enqueue', '예약 2건이 안 걸렸다', { queued })
      return
    }
    ok('queue.enqueue', queued)

    // ① 떠나면 **주차** — 옆 채팅의 컴포저에 남의 예약이 없다
    await app.cdp.eval(`__pick('POC 옆 채팅')`)
    if (!(await waitFor(app.cdp, `(async () => (await window.api.getChats())?.activeChatId === 'c-side')()`, { tries: 80 }))) {
      fail('queue.switch', '실행 중 전환이 안 됐다')
      return
    }
    await sleep(800)
    const sideQ = await app.cdp.eval(`__n('.sched-item')`)
    s.checks.sideQueued = sideQ
    if (sideQ !== 0) fail('queue.park', '옆 채팅 컴포저에 남의 예약이 보인다 — 큐가 앱 단위다', { sideQ })
    else ok('queue.park')

    // ② 돌아오면 **되돌아온다** — 주차는 삭제가 아니다.
    //    강한 형태로 잰다: 돌아온 목록은 원래 목록의 **꼬리**여야 하고, 그 사이 빠진
    //    항목은 **이 대화로 이미 나갔어야** 한다. (떠나 있는 동안 A의 턴이 끝나 정상
    //    드레인이 도는 경우가 실제로 있다 — 단순 동일성 비교는 그걸 오판한다.)
    await app.cdp.eval(`__pick('POC 도는 채팅')`)
    await waitFor(app.cdp, `(async () => (await window.api.getChats())?.activeChatId === 'c-run')()`, { tries: 80 })
    await sleep(800)
    const backQ = await app.cdp.eval(`__txts('.sched-item .sched-text')`)
    // 스레드 전문을 CDP로 끌어오지 않는다 — 300줄짜리 답이 들어 있어 직렬화가 잘린다
    // (1차 실행에서 실제로 밟았다: 말풍선은 있는데 indexOf가 -1). 판정은 페이지 안에서.
    const threadUsers = await app.cdp.eval(`__txts('.thread .msg.user').map((x) => x.slice(0, 80))`)
    const firedAway = queued.slice(0, queued.length - backQ.length)
    const isTail = backQ.every((x, i) => x === queued[queued.length - backQ.length + i])
    s.checks.restoredQueue = { queued, backQ, firedAway }
    if (!isTail) fail('queue.restore', '돌아온 예약이 원래 목록의 꼬리가 아니다 — 주차가 순서를 깼다', s.checks.restoredQueue)
    else if (!firedAway.every((x) => threadUsers.some((u) => u.includes(x))))
      fail('queue.restore', '떠난 사이 사라진 예약이 이 대화로도 안 나갔다 — 예약 증발', s.checks.restoredQueue)
    else ok('queue.restore', { backQ, firedAway })

    // ③ 다시 떠난 채로 A의 턴이 끝나기를 기다린다 — 발사는 A로 나가야 한다
    await app.cdp.eval(`__pick('POC 옆 채팅')`)
    await waitFor(app.cdp, `(async () => (await window.api.getChats())?.activeChatId === 'c-side')()`, { tries: 80 })
    // 화면은 B다. A의 예약이 전부 소진될 때까지(마지막 프롬프트의 답이 A에 도착할 때까지)
    // 기다린다 — 판정은 아래에서 A로 돌아가 스레드로 한다.
    await sleep(150_000)

    // ④ B는 처음부터 끝까지 한 글자도 안 받았다
    const sideMsgs = await app.cdp.eval(`__txts('.thread .msg').map((x) => x.slice(0, 60))`)
    s.checks.sideMsgs = sideMsgs
    if (sideMsgs.length !== 0) fail('queue.misroute', '옆 채팅에 남의 예약이 발사됐다', { sideMsgs })
    else ok('queue.no-misroute')

    // 돌아가서 — 두 예약이 **A의 스레드에 순서대로** 있고 큐는 비었다
    await app.cdp.eval(`__pick('POC 도는 채팅')`)
    await sleep(3000)
    const users = await app.cdp.eval(`__txts('.thread .msg.user').map((x) => x.slice(0, 80))`)
    const left = await app.cdp.eval(`__n('.sched-item')`)
    // 순서는 **말풍선 순번**으로 잰다(문자열 오프셋이 아니라) — 스레드 전문은 못 끌어온다
    const i1 = users.findIndex((x) => x.includes(Q_P1))
    const i2 = users.findIndex((x) => x.includes(Q_P2))
    s.checks.home = { users: users.map((x) => x.slice(0, 40)), left, i1, i2 }
    if (i1 < 0 || i2 < 0) fail('queue.fired-home', '돌아왔는데 예약한 프롬프트가 이 대화에 없다', s.checks.home)
    else if (i1 > i2) fail('queue.order', '예약이 걸었던 순서대로 안 나갔다', s.checks.home)
    else ok('queue.fired-home', { i1, i2 })
    if (left !== 0) fail('queue.drained', '턴이 다 끝났는데 예약이 남아 있다', { left })
    else ok('queue.drained')
    // 답이 실제로 왔는가(발사가 표시만이 아니라 **엔진에 닿았다**는 증거)
    const ai = await app.cdp.eval(`__n('.thread .msg.ai-msg')`)
    s.checks.aiMsgs = ai
    if (ai < 2) fail('queue.answered', '예약 턴의 답이 없다 — 발사가 엔진에 안 닿았다', { ai })
    else ok('queue.answered', { ai })
  } finally {
    app.cdp.close()
    killTree(app.child.pid)
    await sleep(1200)
    if (!KEEP) await rmHome(seed.home)
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
;(async () => {
  if (!fs.existsSync(EXE)) {
    console.error(`실행 파일이 없다: ${EXE} — 먼저 npm run tauri:build`)
    process.exit(2)
  }
  fs.rmSync(HOME, { recursive: true, force: true })
  const fx = makeMultiFixture(HOME, APP_VERSION, { panels: 6, itemsPerPanel: 6 })
  rep.fixture = fx
  console.log(`홈: ${HOME} (자리 ${fx.panels} · 자리당 항목 ${fx.itemsPerPanel})`)

  const want = (id) => only === 'all' || only.split(',').includes(id)
  if (want('dial')) await stepDial()
  if (want('active')) await stepActive()
  if (want('bg')) await stepBg()
  if (want('queue')) await stepQueue()

  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  rep.pass = rep.findings.length === 0
  fs.writeFileSync(OUT, JSON.stringify(rep, null, 2))
  console.log(`\n리포트: ${OUT}`)
  if (!KEEP && !(await rmHome(HOME))) console.log('(홈 정리 실패 — 핸들이 남아 있다. 다음 실행이 지운다)')
  console.log(rep.pass ? '\nPASS — 다이얼 1↔6 무손실' : `\nFAIL — ${rep.findings.length}건`)
  process.exit(rep.pass ? 0 : 1)
})().catch((e) => {
  console.error(e)
  process.exit(3)
})
