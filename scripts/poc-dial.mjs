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
 *   node scripts/poc-dial.mjs --only=raise   # ★ R3 읽던 자리 앵커 복원 (엔진 0턴)
 *   node scripts/poc-dial.mjs --only=settle  # ★ R4 앵커의 **정착 후** 실측 (엔진 0턴)
 *   node scripts/poc-dial.mjs --only=own     # ★ R3 재개 소유권 + 창 자리 UI (실 CLI 1턴)
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
import { connectMainPage, killTree, sleep, REPO, resolveTauriExe } from '../bench/lib.mjs'
import { makeMultiFixture } from '../bench/fixture.mjs'

const args = process.argv.slice(2)
const only = (args.find((a) => a.startsWith('--only=')) ?? '').split('=')[1] || 'all'
const KEEP = args.includes('--keep')
// M12 R2 — mainBinaryName 변경으로 exe 이름이 둘이다(구·신 모두 탐색·최신 mtime 우선)
const EXE = resolveTauriExe()
const HOME = path.join(REPO, '.poc-home-dial')
// ★ R3 — 산출 경로를 갈랐다(`m-ux-r1-dial.json` → `m-ux-r3-dial.json`). R1·R2 보고서가
// 앞 파일의 수치를 인용하는데 이 하네스가 매 주행마다 덮으면 그 근거가 사라진다
// (배선 R3/R4가 `m3-r{3,4}-live.json`으로 가른 것과 같은 규약).
const OUT = path.join(REPO, 'docs', 'critic', 'm-ux-r3-dial.json')
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

// ── 5. ★ R3 — 읽던 자리 앵커 (`raise.scroll`의 정공법) ────────────────────────
//
// 크리틱 §2-⑧이 물은 것: **접었다 되올리면 읽던 위치가 돌아오는가.** R2는 "픽셀
// 오프셋을 그대로 꽂으면 다른 지점에 착지한다"는 이유로 안 고쳤다(§R2.7) — 진단은
// 옳다. 되올림은 대개 **크기가 다른 자리**로 가기 때문이다(6분할 3번 칸 → n1 전폭:
// 같은 대화의 scrollHeight가 6962 → 4676, 스크롤러 zoom도 .8 → 1).
//
// 그래서 이 단계는 **두 축**으로 잰다. 둘을 안 가르면 실패도 성공도 해석이 안 된다:
//
//   A. 자리 크기가 **같은** 되올림(n3 안에서 3번 칸 → 1번 칸, `grid-template-columns:
//      repeat(3, 1fr)`라 셀이 동일) — 여기서는 **픽셀까지** 같아야 한다.
//   B. 자리 크기가 **다른** 되올림(6분할 → n1, 크리틱과 같은 축) — 여기서 같아야 하는
//      것은 픽셀이 아니라 **읽던 문단**이다. 같은 메시지가 뷰포트 같은 오프셋에 있으면
//      계약을 지킨 것이고, 그때 scrollTop은 반드시 다른 수가 된다(그 수도 함께 남긴다).
//   C. 바닥에서 접었으면 되올림도 **바닥**(팔로우 래치의 뜻 — 앵커를 남기지 않는다).
const RAISE_HELPERS = `(() => {
  window.__panelTop = (n = 0) => {
    const p = document.querySelectorAll('.ma-grid > .ma-panel')[n]
    const sc = p && p.querySelector('.ma-p-thread')
    const th = sc && sc.querySelector(':scope > .thread')
    if (!sc || !th) return null
    const base = sc.getBoundingClientRect().top
    const kids = [...th.children]
    const geo = {
      top: Math.round(sc.scrollTop), h: Math.round(sc.scrollHeight), ch: Math.round(sc.clientHeight),
      w: Math.round(sc.getBoundingClientRect().width),
      zoom: +(sc.getBoundingClientRect().height / Math.max(1, sc.clientHeight)).toFixed(3),
      msgs: th.querySelectorAll('.msg').length
    }
    for (let i = 0; i < kids.length; i++) {
      const r = kids[i].getBoundingClientRect()
      if (r.bottom - base > 0)
        return { ...geo, i, off: Math.round(r.top - base), text: (kids[i].innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 44) }
    }
    return { ...geo, i: -1, off: 0, text: '' }
  }
  window.__panelScroll = (n, frac) => {
    const p = document.querySelectorAll('.ma-grid > .ma-panel')[n]
    const sc = p && p.querySelector('.ma-p-thread')
    if (!sc) return false
    sc.scrollTop = Math.round((sc.scrollHeight - sc.clientHeight) * frac)
    sc.dispatchEvent(new Event('scroll', { bubbles: true }))
    return true
  }
  // 배지 클릭 → 팝오버는 **다음 커밋**에 뜬다(React state) — 같은 틱에서 행을 찾으면 없다
  window.__foldOpen = () => { const b = document.querySelector('.ma-fold-badge'); if (!b) return 'no-badge'; b.click(); return 'ok' }
  window.__foldPick = (needle) => {
    const row = [...document.querySelectorAll('.ma-fold-row')].find((e) => (e.textContent || '').includes(needle))
    if (!row) return 'no-row:' + document.querySelectorAll('.ma-fold-row').length
    row.click()
    return 'ok'
  }
  window.__anchors = () => (window.__ccgAnchors ? window.__ccgAnchors() : null)
  window.__landings = () => (window.__ccgLandings ? window.__ccgLandings() : null)
  return true
})()`

/** 접힘 배지 팝오버에서 그 대화를 1번 자리로 — 여는 것과 고르는 것은 다른 커밋이다. */
async function raiseFolded(cdp, needle) {
  const opened = await cdp.eval(`__foldOpen()`)
  await sleep(350)
  const picked = await cdp.eval(`__foldPick(${JSON.stringify(needle)})`)
  return `${opened}/${picked}`
}

async function stepRaise() {
  console.log('\n[raise] 접었다 되올리면 **읽던 문단**이 돌아오는가 (메시지 id 앵커)')
  const s = (rep.steps.raise = { checks: {} })
  const home = path.join(REPO, '.poc-home-dial-raise')
  await rmHome(home)
  // itemsPerPanel 30 — 스크롤이 실제로 생겨야 "읽던 위치"라는 축이 존재한다
  makeMultiFixture(home, APP_VERSION, { panels: 6, itemsPerPanel: 30 })
  const app = await bootAt(home, PORT + 3)
  try {
    await app.cdp.eval(`(() => { window.__c = (sel, n = 0) => { const e = document.querySelectorAll(sel)[n]; if (!e) return false; e.click(); return true }
      window.__mdown = (sel, n = 0) => { const e = document.querySelectorAll(sel)[n]; if (!e) return false
        e.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })); return true }
      return true })()`)
    await app.cdp.eval(RAISE_HELPERS)
    if (!(await waitFor(app.cdp, `__n('.ma-grid > .ma-panel') === 6`))) {
      fail('raise.boot', '6자리 그리드로 부팅하지 못했다')
      return
    }
    await sleep(2500) // 마크다운·하이라이트 리플로가 멎을 때까지 (여기서 재면 높이가 흔들린다)

    // ── A. 자리 크기가 **같은** 되올림 (n3의 3번 칸 → 1번 칸) ────────────────
    await app.cdp.eval(`__c('.ma-count-btn[data-count="3"]')`)
    if (!(await waitFor(app.cdp, `__n('.ma-grid.n3 > .ma-panel') === 3`))) {
      fail('raise.n3', '다이얼 3이 3자리 그리드를 만들지 못했다')
      return
    }
    await sleep(900)
    await app.cdp.eval(`__panelScroll(2, 0.42)`)
    await sleep(1800)
    const beforeA = await app.cdp.eval(`__panelTop(2)`)
    s.checks.beforeA = beforeA
    if (!beforeA || beforeA.top < 100) {
      fail('raise.n3-scroll', '3번 칸을 중간까지 못 올렸다(스레드가 짧다?)', { beforeA })
      return
    }
    // 3번 칸(벤치 패널 3)을 접힘으로 밀어낸다 — 접힌 자리 하나를 1번으로 올리면 된다
    await app.cdp.eval(`__mdown('.ma-grid > .ma-panel', 0)`)
    await sleep(150)
    const pushed = await raiseFolded(app.cdp, '벤치 패널 4')
    await sleep(900)
    const visMid = await app.cdp.eval(`__txts('.ma-grid > .ma-panel .ma-p-title')`)
    s.checks.pushed = { pushed, visMid }
    if (visMid.includes('벤치 패널 3')) {
      fail('raise.n3-push', '되올림이 3번 칸을 접힘으로 밀어내지 않았다', s.checks.pushed)
      return
    }
    // 앵커가 실제로 **적혔는가** — 저장이 안 됐는데 복원만 보면 원인을 못 가른다
    s.checks.anchors = await app.cdp.eval(`__anchors()`)
    const anchored = Object.values(s.checks.anchors ?? {}).length > 0
    if (!anchored) fail('raise.anchor-saved', '접힌 자리의 앵커가 저장되지 않았다', s.checks.anchors)
    else ok('raise.anchor-saved', s.checks.anchors)
    // 되올린다 → 1번 칸(같은 크기)
    await raiseFolded(app.cdp, '벤치 패널 3')
    await waitFor(app.cdp, `(__txts('.ma-grid > .ma-panel .ma-p-title')[0] || '') === '벤치 패널 3'`)
    await sleep(2600)
    const afterA = await app.cdp.eval(`__panelTop(0)`)
    s.checks.afterA = afterA
    if (!afterA) {
      fail('raise.n3-measure', '되올린 자리를 못 쟀다')
      return
    }
    // 계약의 저울은 **앵커 메시지의 상단 오프셋**이다(화면 위 "맨 위 문단"이 아니다).
    // 왜: `.thread > .msg`의 content-visibility 때문에 **같은 메시지의 높이가 마운트마다
    // 다르다** — 앵커가 계약대로 −163px에 놓였는데도 그 메시지가 163→147로 줄면 "맨 위
    // 문단"은 다음 항목이 된다(1차 실행에서 이걸 실패로 찍었다). 착지 기록으로 잰다.
    const landA = await app.cdp.eval(`__landings()`)
    const savedA = Object.entries(s.checks.anchors ?? {})[0]
    const lA = savedA ? (landA ?? {})[savedA[0]] : null
    s.checks.landA = { saved: savedA, landed: lA }
    if (!lA || lA.id !== savedA?.[1]?.id)
      fail('raise.anchor-land', '되올린 자리가 저장해 둔 그 메시지로 착지하지 않았다', s.checks.landA)
    else if (Math.abs(lA.got - lA.want) > 2)
      fail('raise.anchor-land', '앵커 메시지가 저장 때와 다른 높이에 놓였다', s.checks.landA)
    else ok('raise.anchor-land', { id: lA.id, want: Math.round(lA.want), got: Math.round(lA.got) })
    // ★ R4 — **저울을 고쳤다.** R3의 검사식은 `|afterA.top − beforeA.top| < 40` 하나였고
    // 그건 "자리 크기가 같으면 문서 높이도 같다"를 전제로 깔고 있다. 그 전제는 거짓이다:
    // `.thread > .msg`의 content-visibility 때문에 **같은 스레드의 scrollHeight가 마운트
    // 뒤에 줄어든다**(실측 6962 → 6687, 275px). 그러면 픽셀이 같다는 것은 오히려
    // **다른 문단을 보고 있다**는 뜻이 된다. R14 확인 크리틱이 남긴 기준 산출이 그 증거다:
    //
    //   R14 beforeA  top 3148 · h 6962 · i 13 · off -163 · "패널 2 · 구간 4 검토 결과…"
    //   R14 afterA   top 3148 · h 6687 · i 14 · off  -16 · "Read src/mod4/cache.ts 412줄…"
    //   R14 deltaA   dTop 0  → **초록**            ← 픽셀은 같고 문단은 바뀌었다
    //   R14 landA    top 2272.5                    ← 착지 기록은 화면과 875px 갈려 있었다
    //
    // 즉 이 검사는 F3(앵커가 정착 뒤 밀린다)을 **초록으로 덮고 있었다**. 그래서 둘로 나눈다:
    //   · `raise.same-para` — 계약 그 자체. 되올린 화면의 맨 위 문단이 **같은 문단·같은
    //     오프셋**인가를 착지 기록이 아니라 **화면에서** 잰다. 이게 주 검사다.
    //   · `raise.same-pixel` — 픽셀은 **전제가 성립할 때만** 묻는다(w·ch·h 전부 같을 때).
    //     높이가 변했으면 물어야 할 것은 "안 움직였나"가 아니라 "**변한 높이만큼** 움직였나"다.
    const dTop = Math.abs(afterA.top - beforeA.top)
    const dH = Math.abs(afterA.h - beforeA.h)
    const sameLayout = afterA.w === beforeA.w && afterA.ch === beforeA.ch && afterA.h === beforeA.h
    s.checks.deltaA = {
      dTop, dH, beforeTop: beforeA.top, afterTop: afterA.top,
      sameW: afterA.w === beforeA.w, sameCh: afterA.ch === beforeA.ch, sameH: afterA.h === beforeA.h
    }
    s.checks.paraA = { before: { i: beforeA.i, off: beforeA.off, text: beforeA.text }, after: { i: afterA.i, off: afterA.off, text: afterA.text } }
    if (afterA.text !== beforeA.text)
      fail('raise.same-para', '되올린 화면의 맨 위 문단이 접기 전과 다르다 — 읽던 자리를 잃었다', s.checks.paraA)
    else if (Math.abs(afterA.off - beforeA.off) > 8)
      fail('raise.same-para', '같은 문단인데 화면에서의 높이가 달라졌다', s.checks.paraA)
    else ok('raise.same-para', { i: afterA.i, off: afterA.off, text: afterA.text.slice(0, 24) })
    if (sameLayout && dTop >= 40)
      fail('raise.same-pixel', '레이아웃이 완전히 같은데 스크롤 위치가 안 돌아왔다', { before: beforeA, after: afterA, dTop })
    else if (!sameLayout && Math.abs(dTop - dH) >= 40)
      fail('raise.same-pixel', '문서 높이가 변한 폭과 스크롤 이동 폭이 안 맞는다 — 문단 보존이 우연이었다는 뜻', { before: beforeA, after: afterA, dTop, dH })
    else ok('raise.same-pixel', s.checks.deltaA)

    // ── B. 자리 크기가 **다른** 되올림 (6분할 → n1, 크리틱과 같은 축) ──────────
    await app.cdp.eval(`__c('.ma-count-btn[data-count="6"]')`)
    await waitFor(app.cdp, `__n('.ma-grid.n6 > .ma-panel') === 6`)
    await sleep(1500)
    await app.cdp.eval(`__panelScroll(2, 0.42)`)
    await sleep(1800)
    const beforeB = await app.cdp.eval(`__panelTop(2)`)
    const titleB = (await app.cdp.eval(`__txts('.ma-grid > .ma-panel .ma-p-title')`))[2]
    s.checks.beforeB = { ...beforeB, title: titleB }
    // 3번 칸이 아닌 자리를 포커스한 뒤 1로 접는다 → 3번 칸이 접힘 집합으로 간다
    await app.cdp.eval(`__mdown('.ma-grid > .ma-panel', 0)`)
    await sleep(150)
    await app.cdp.eval(`__c('.ma-count-btn[data-count="1"]')`)
    await waitFor(app.cdp, `__n('.ma-grid.n1 > .ma-panel') === 1`)
    await sleep(800)
    await raiseFolded(app.cdp, titleB)
    await waitFor(app.cdp, `(__txts('.ma-grid > .ma-panel .ma-p-title')[0] || '') === ${JSON.stringify(titleB)}`)
    await sleep(2600)
    const afterB = await app.cdp.eval(`__panelTop(0)`)
    s.checks.afterB = afterB
    if (!afterB || !beforeB) {
      fail('raise.n1-measure', '6→n1 되올림을 못 쟀다', { beforeB, afterB })
    } else {
      // 계약은 **문단**이다. 픽셀은 자리 크기가 달라 반드시 달라진다 — 그 수도 남긴다.
      s.checks.deltaB = {
        dTop: Math.abs(afterB.top - beforeB.top),
        dOff: Math.abs(afterB.off - beforeB.off),
        geom: { before: { h: beforeB.h, ch: beforeB.ch, w: beforeB.w, zoom: beforeB.zoom }, after: { h: afterB.h, ch: afterB.ch, w: afterB.w, zoom: afterB.zoom } }
      }
      const landB = await app.cdp.eval(`__landings()`)
      const lB = Object.values(landB ?? {}).sort((x, y) => y.at - x.at)[0]
      s.checks.landB = lB
      if (!lB || Math.abs(lB.got - lB.want) > 2)
        fail('raise.anchor-land-n1', '6→n1 되올림에서 앵커 메시지가 제 높이에 안 놓였다', { landB, deltaB: s.checks.deltaB })
      else ok('raise.anchor-land-n1', { id: lB.id, want: Math.round(lB.want), got: Math.round(lB.got), delta: s.checks.deltaB })
      if (afterB.msgs < beforeB.msgs)
        fail('raise.thread-n1', '되올린 자리의 메시지 수가 줄었다 — 대화 손실', { before: beforeB.msgs, after: afterB.msgs })
      else ok('raise.thread-n1', { msgs: afterB.msgs })
    }

    // ── C. 바닥에서 접었으면 되올림도 바닥 (앵커를 남기지 않는 계약) ───────────
    await app.cdp.eval(`__c('.ma-count-btn[data-count="6"]')`)
    await waitFor(app.cdp, `__n('.ma-grid.n6 > .ma-panel') === 6`)
    await sleep(1200)
    await app.cdp.eval(`__panelScroll(2, 1)`)
    await sleep(1800)
    await app.cdp.eval(`__panelScroll(2, 1)`)
    await sleep(600)
    const titleC = (await app.cdp.eval(`__txts('.ma-grid > .ma-panel .ma-p-title')`))[2]
    await app.cdp.eval(`__mdown('.ma-grid > .ma-panel', 0)`)
    await sleep(150)
    await app.cdp.eval(`__c('.ma-count-btn[data-count="1"]')`)
    await waitFor(app.cdp, `__n('.ma-grid.n1 > .ma-panel') === 1`)
    await sleep(700)
    await raiseFolded(app.cdp, titleC)
    await waitFor(app.cdp, `(__txts('.ma-grid > .ma-panel .ma-p-title')[0] || '') === ${JSON.stringify(titleC)}`)
    await sleep(2600)
    const afterC = await app.cdp.eval(`__panelTop(0)`)
    s.checks.afterC = afterC
    const atBottom = afterC ? afterC.h - afterC.top - afterC.ch <= 60 : false
    if (!atBottom) fail('raise.bottom-stays-bottom', '바닥에서 접었는데 되올림이 바닥이 아니다', afterC)
    else ok('raise.bottom-stays-bottom', { top: afterC.top, h: afterC.h, ch: afterC.ch })
  } finally {
    app.cdp.close()
    killTree(app.child.pid)
    await sleep(1200)
    if (!KEEP) await rmHome(home)
  }
}

// ── 5b. ★ R4 — 앵커의 **정착 후** 자리 (크리틱 R14 §5-F3) ─────────────────────
//
// 위 `raise` B 케이스는 `__ccgLandings()`를 읽는다. 그것은 **착지 기록** — 유지 루프가
// 마지막으로 돈 순간의 값이지 리플로가 끝난 화면이 아니다. 크리틱은 같은 픽스처·같은
// 파라미터(6분할 · frac 0.42 · 정착 1800ms)에서 착지 기록은 `want -331 → got -331`인데
// **정착 뒤 그 행은 -696**이더라고 실측했다(오차 -365px · +1.2s/+2.6s/+5s/+9s 전부 동일 ·
// 3/3 결정적). 즉 그 초록은 **구조적으로 이 사고를 볼 수 없다**.
//
// 그래서 저울을 바꾼다. 이 단계는 기록을 안 믿고 **화면을 다시 잰다**:
//   ① 접기 전에 스레드의 모든 행을 (텍스트 지문, 오프셋)으로 찍어 앵커 행을 특정하고
//   ② 되올린 뒤 네 시점에서 그 **지문으로 같은 행을 찾아** 오프셋을 직접 읽는다
//   ③ 착지 기록과 실측이 갈리면 그것도 결함이다 — 저울이 거짓말을 하고 있다는 뜻이라
//      다음 라운드가 또 초록을 믿는다.
// 재현 파라미터는 크리틱 것을 그대로 쓴다(별도 홈·별도 부팅 — `raise`가 A를 먼저 도는
// 바람에 저장 오프셋이 작아지던 그 차이를 없앤다).
const SETTLE_FRAC = 0.42
const SETTLE_PRE_MS = 1800
const SETTLE_AT_MS = [1200, 2600, 5000, 9000]
/** 허용 오차 — 되올림은 폭·zoom이 바뀌므로 시각 px 몇 개는 리플로 잡음이다. 365는 아니다. */
const SETTLE_TOL_PX = 24

const SETTLE_HELPERS = `(() => {
  // 스레드의 **모든 행**을 (텍스트 지문, 뷰포트 상단 대비 오프셋)으로 — 앵커 행을 지문으로 추적한다
  window.__rows = (n) => {
    const p = document.querySelectorAll('.ma-grid > .ma-panel')[n]
    const sc = p && p.querySelector('.ma-p-thread')
    const th = sc && sc.querySelector(':scope > .thread')
    if (!sc || !th) return null
    const b = sc.getBoundingClientRect().top
    return {
      top: Math.round(sc.scrollTop), h: Math.round(sc.scrollHeight), ch: Math.round(sc.clientHeight),
      w: Math.round(sc.getBoundingClientRect().width),
      zoom: +(sc.getBoundingClientRect().height / Math.max(1, sc.clientHeight)).toFixed(3),
      rows: [...th.children].map((c) => ({ tx: (c.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40), off: Math.round(c.getBoundingClientRect().top - b) }))
    }
  }
  return true
})()`

async function stepSettle() {
  console.log('\n[settle] 되올린 앵커가 **정착 뒤에도** 그 자리인가 (착지 기록이 아니라 화면을 잰다)')
  const s = (rep.steps.settle = { params: { frac: SETTLE_FRAC, pre: SETTLE_PRE_MS, at: SETTLE_AT_MS, tol: SETTLE_TOL_PX }, checks: {} })
  const home = path.join(REPO, '.poc-home-dial-settle')
  await rmHome(home)
  makeMultiFixture(home, APP_VERSION, { panels: 6, itemsPerPanel: 30 })
  const app = await bootAt(home, PORT + 4)
  try {
    await app.cdp.eval(`(() => { window.__c = (sel, n = 0) => { const e = document.querySelectorAll(sel)[n]; if (!e) return false; e.click(); return true }
      window.__mdown = (sel, n = 0) => { const e = document.querySelectorAll(sel)[n]; if (!e) return false
        e.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })); return true }
      return true })()`)
    await app.cdp.eval(RAISE_HELPERS)
    await app.cdp.eval(SETTLE_HELPERS)
    if (!(await waitFor(app.cdp, `__n('.ma-grid > .ma-panel') === 6`))) {
      fail('settle.boot', '6자리 그리드로 부팅하지 못했다')
      return
    }
    await sleep(2500) // 마크다운·하이라이트 리플로가 멎을 때까지

    await app.cdp.eval(`__panelScroll(2, ${SETTLE_FRAC})`)
    await sleep(SETTLE_PRE_MS)
    const before = await app.cdp.eval(`__rows(2)`)
    const title = (await app.cdp.eval(`__txts('.ma-grid > .ma-panel .ma-p-title')`))[2]
    s.checks.before = before && { top: before.top, h: before.h, ch: before.ch, w: before.w, zoom: before.zoom, rows: before.rows.length }
    if (!before || before.top < 100) {
      fail('settle.scroll', '3번 칸을 중간까지 못 올렸다(스레드가 짧다?)', { before: s.checks.before })
      return
    }
    // 3번 칸이 아닌 자리를 포커스한 뒤 1로 접는다 → 3번 칸이 접힘 집합으로 간다
    await app.cdp.eval(`__mdown('.ma-grid > .ma-panel', 0)`)
    await sleep(200)
    await app.cdp.eval(`__c('.ma-count-btn[data-count="1"]')`)
    await waitFor(app.cdp, `__n('.ma-grid.n1 > .ma-panel') === 1`)
    await sleep(700)
    const anchors = (await app.cdp.eval(`__anchors()`)) ?? {}
    const saved = Object.values(anchors)[0] ?? null
    s.checks.anchor = { key: Object.keys(anchors)[0] ?? null, ...(saved ?? {}) }
    if (!saved || typeof saved.off !== 'number') {
      fail('settle.anchor-saved', '접힌 자리의 앵커가 저장되지 않았다 — 잴 대상이 없다', { anchors })
      return
    }
    ok('settle.anchor-saved', { id: saved.id, off: Math.round(saved.off) })
    // 앵커 행을 **지문**으로 특정 — 저장 오프셋과 같은 자리에 있던 행의 텍스트
    const anchorRow = before.rows.reduce(
      (best, r) => (best && Math.abs(best.off - saved.off) <= Math.abs(r.off - saved.off) ? best : r),
      null
    )
    const dupes = before.rows.filter((r) => r.tx === anchorRow?.tx).length
    s.checks.anchorRow = { ...(anchorRow ?? {}), dupes }
    if (!anchorRow || !anchorRow.tx) {
      fail('settle.row-id', '앵커 행의 텍스트 지문을 못 잡았다 — 이 저울은 쓸 수 없다', s.checks.anchorRow)
      return
    }
    if (dupes !== 1) {
      fail('settle.row-id', '같은 지문의 행이 둘 이상 — 엉뚱한 행을 재고 초록을 낼 수 있다', s.checks.anchorRow)
      return
    }

    await raiseFolded(app.cdp, title)
    await waitFor(app.cdp, `(__txts('.ma-grid > .ma-panel .ma-p-title')[0] || '') === ${JSON.stringify(title)}`)
    const t0 = Date.now()
    const track = []
    for (const at of SETTLE_AT_MS) {
      const wait = at - (Date.now() - t0)
      if (wait > 0) await sleep(wait)
      const now = await app.cdp.eval(`__rows(0)`)
      const land = Object.values((await app.cdp.eval(`__landings()`)) ?? {}).sort((x, y) => y.at - x.at)[0] ?? null
      const hit = (now?.rows ?? []).find((r) => r.tx === anchorRow.tx) ?? null
      track.push({
        at,
        top: now?.top ?? null,
        h: now?.h ?? null,
        ch: now?.ch ?? null,
        w: now?.w ?? null,
        zoom: now?.zoom ?? null,
        anchorOff: hit ? hit.off : null,
        err: hit ? Math.round(hit.off - saved.off) : null,
        landingGot: land ? Math.round(land.got) : null,
        landingWant: land ? Math.round(land.want) : null
      })
    }
    s.checks.track = track
    const missing = track.filter((r) => r.anchorOff == null)
    if (missing.length) {
      fail('settle.row-found', '되올린 화면에서 앵커 행을 못 찾았다 — 창 밖으로 밀렸거나 사라졌다', { track })
      return
    }
    const worst = track.reduce((m, r) => (Math.abs(r.err) > Math.abs(m.err) ? r : m), track[0])
    if (Math.abs(worst.err) > SETTLE_TOL_PX)
      fail('settle.after-reflow', `정착 뒤 앵커가 ${worst.err}px 어긋났다 — 착지 기록만 보는 저울은 이걸 못 본다`, { worst, track })
    else ok('settle.after-reflow', { worstErr: worst.err, at: worst.at, samples: track.map((r) => r.err) })
    // 저울 자체의 정직성 — 착지 기록과 실측이 갈리면 다음 라운드가 또 기록을 믿는다
    const last = track[track.length - 1]
    const gap = last.landingGot == null ? null : Math.round(last.anchorOff - last.landingGot)
    s.checks.scaleGap = { gap, landingGot: last.landingGot, live: last.anchorOff }
    if (gap == null) fail('settle.scale-agrees', '착지 기록이 없다 — 앵커 복원이 아예 안 돌았다', s.checks.scaleGap)
    else if (Math.abs(gap) > SETTLE_TOL_PX)
      fail('settle.scale-agrees', `착지 기록(${last.landingGot})과 정착 후 실측(${last.anchorOff})이 ${gap}px 갈린다 — 기록만 읽는 검사는 거짓 초록을 낸다`, s.checks.scaleGap)
    else ok('settle.scale-agrees', s.checks.scaleGap)
  } catch (e) {
    fail('settle', String(e?.message ?? e))
  } finally {
    app.cdp.close()
    killTree(app.child.pid)
    await sleep(1200)
    if (!KEEP) await rmHome(home)
  }
}

// ── 6. ★ R3 — 재개의 주인 · 창 자리 UI ────────────────────────────────────────
//
// 두 가지를 한 홈에서 잰다. 둘 다 "셸은 이미 내는데 읽는 화면이 없다"였던 자리다
// (배선 R3 §R3.8의 렌더러 몫 R7·R8, M-UX R2 §R2.9의 이중 전송 접점).
//
//  ① **재개의 주인** — 엔진이 대기표를 들고 있으면(`chat:status`의 `resumeOwner:"engine"`)
//     렌더러 기계는 손을 떼고, 배너는 **엔진의 표**를 그린다. 화면에서 그걸 가르는 표식이
//     ✕(대기 취소)다: 렌더러 소유 배너에만 있다(엔진 대기표는 취소 채널이 없다).
//     그리고 자동이 꺼진(화면 밖) 채팅은 `ready`가 켜져도 안 나가고, 목록의 「이어가기」
//     알약이 유일한 출구다(`chat:queue-mutate {op:'resume'}`).
//  ② **창 자리** — 「창」 칩의 진실은 `chat:windows`다. 창을 닫으면 칩만 사라지고 대화는
//     목록에 남아야 하며(`win:chat-close`는 삭제가 아니다), 그 항목을 다시 누르면
//     `win:chat-focus`가 창을 **되만든다**.
//
// 한도는 **합성**이다(실제로 한도에 걸릴 수 없다) — chats-v3의 `hold`를 직접 심는다.
// 실 CLI는 1턴만 돈다(자동 발사가 실제로 엔진에 닿았다는 증거).
const OWN_PROMPT = 'Reply with exactly: OWNRESUME'

function seedOwnHome() {
  const home = path.join(REPO, '.poc-home-dial-own')
  const work = path.join(home, 'work')
  const realHome = path.join(os.homedir(), '.agentcodegui')
  fs.rmSync(home, { recursive: true, force: true })
  fs.mkdirSync(work, { recursive: true })
  const write = (p, v) => {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify(v))
  }
  const ver = JSON.parse(fs.readFileSync(path.join(realHome, 'config.json'), 'utf8')).activeVersion
  write(path.join(home, 'config.json'), { activeVersion: ver })
  spawnSync('cmd', ['/c', 'mklink', '/J', path.join(home, 'engines'), path.join(realHome, 'engines')], { encoding: 'utf8' })
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
  // resetsAt은 **이미 지난** unix 초 — due_at(=resetsAt+90s)도 지났으므로 재검증 바닥값
  // (부팅 후 90초)만 지나면 발화한다. 그 90초가 이 단계에서 가장 오래 걸리는 구간이다.
  const past = Math.floor(Date.now() / 1000) - 600
  const chat = (id, title) => ({
    id,
    title,
    origin: 'chat',
    custom: true,
    cwd: work,
    manualCwd: work,
    refDirs: [],
    identity: {
      engine: { kind: 'claude', model: 'haiku', effort: 'minimal' },
      billing: { kind: 'subscription', account: accounts.defaultEmail, dropEnvKey: false },
      cwd: work,
      addDirs: [],
      mode: 'bypass',
      tools: {}
    },
    picker: { model: 'haiku', effort: 'minimal', mode: 'bypass' },
    queue: [OWN_PROMPT],
    hold: { key: id, resetsAt: past, ready: false },
    snapshot: { messages: [{ kind: 'msg', id: id + 'm0', role: 'user', text: title + ' 원본', animate: false, time: '오후 3:00' }] },
    updatedAt: Date.now()
  })
  write(path.join(home, 'chats-v3', 'index.json'), {
    version: 1,
    order: ['c-see', 'c-hide'],
    activeChatId: 'c-see',
    chats: [{ id: 'c-see' }, { id: 'c-hide' }]
  })
  write(path.join(home, 'chats-v3', 'c-see.json'), chat('c-see', 'POC 보이는 채팅'))
  write(path.join(home, 'chats-v3', 'c-hide.json'), chat('c-hide', 'POC 화면 밖 채팅'))
  write(path.join(home, 'chats-v3', 'status.json'), { version: 1, statuses: {} })
  write(path.join(home, 'chats-v3', '.migrated'), { at: Date.now() }) // 옛 폴더 재흡수 금지
  // 자동 이어서 토글은 **켜 둔다** — 렌더러가 주인이었다면 스스로 쏠 조건이다.
  write(path.join(home, 'ui-prefs.json'), { 'ui.lang': 'ko', 'workspace.mode': 'single', 'limitResume.on': true, 'whatsnew.seenVersion': APP_VERSION })
  write(path.join(home, 'profile.json'), { nickname: 'poc' })
  return { home, ver }
}

async function stepOwn() {
  console.log('\n[own] 재개의 주인은 하나다 + 창 자리 칩은 chat:windows를 읽는다')
  const s = (rep.steps.own = { checks: {} })
  let seed
  try {
    seed = seedOwnHome()
  } catch (e) {
    fail('own.seed', `격리 홈을 못 만들었다: ${String(e.message ?? e)}`)
    return
  }
  s.engine = seed.ver
  const app = await bootAt(seed.home, PORT + 4)
  const ipc = async (channel, payload) =>
    await app.cdp.eval(
      `window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: ${JSON.stringify(channel)}, payload: ${JSON.stringify(payload)} })`,
      { awaitPromise: true }
    )
  const dbg = async () => await ipc('engine:debug', [])
  try {
    if (!(await waitFor(app.cdp, `__txts('.sb-item .t .tx').filter((x)=>x.startsWith('POC')).length === 2`))) {
      fail('own.boot', '두 채팅이 목록에 안 떴다', { titles: await app.cdp.eval(`__txts('.sb-item .t .tx')`) })
      return
    }
    // ── ① 와이어에 관장 표시가 실렸는가(렌더러가 읽는 그 필드) ────────────────
    const st = await ipc('chats:get', [])
    s.checks.status = Object.fromEntries(
      Object.entries((st?.statuses ?? {})).map(([k, v]) => [k, { resumeOwner: v.resumeOwner, autoResume: v.autoResume, hold: v.hold }])
    )
    const see = s.checks.status['c-see']
    if (see?.resumeOwner !== 'engine')
      fail('own.signal', '`chat:status`에 재개 관장 표시(resumeOwner)가 없다 — 렌더러 게이트가 설 근거가 없다', s.checks.status)
    else ok('own.signal', s.checks.status)

    // ── ② 배너가 **엔진의 표**를 그린다 — 렌더러 소유 배너에만 있는 ✕가 없어야 한다 ──
    await waitFor(app.cdp, `__n('.limit-hold') === 1`)
    s.checks.bar = await app.cdp.eval(
      `(() => { const b = document.querySelector('.limit-hold'); if (!b) return null
         return { sub: (b.querySelector('.lh-sub')||{}).textContent || '', x: b.querySelectorAll('.lh-x').length, go: b.querySelectorAll('.lh-go').length } })()`
    )
    if (!s.checks.bar) fail('own.bar', '대기표 배너가 안 떴다')
    else if (s.checks.bar.x !== 0)
      fail('own.bar-managed', '엔진이 관장하는데 렌더러 소유 배너(✕ 취소)가 떴다 — 재개 주체가 둘이다', s.checks.bar)
    else ok('own.bar-managed', s.checks.bar)

    // ── ③ 화면 밖 채팅: ready가 켜져도 **안 나가고**, 목록에 「이어가기」가 뜬다 ──
    //    발화 바닥값(부팅 후 90초)을 기다린다 — 그 전에는 ready 자체가 안 켜진다.
    const readyPill = await waitFor(app.cdp, `__n('.sb-item .sb-resume') >= 1`, { tries: 160, gap: 1000 })
    s.checks.pill = await app.cdp.eval(
      `[...document.querySelectorAll('.sb-item')].filter((e) => e.querySelector('.sb-resume')).map((e) => (e.querySelector('.t .tx')||{}).textContent || '')`
    )
    const d1 = await dbg()
    s.checks.afterHold = (d1?.chats ?? []).map((c) => ({ id: c.chatId, spawns: c.spawns, hold: c.hold, auto: c.autoResume, queued: c.queued }))
    if (!readyPill) fail('own.ready-pill', 'ready 대기표를 눌러 이어갈 자리가 목록에 안 생겼다', s.checks.afterHold)
    else if (!s.checks.pill.some((t) => t.includes('화면 밖'))) fail('own.ready-pill', '「이어가기」가 엉뚱한 항목에 붙었다', s.checks)
    else ok('own.ready-pill', s.checks.pill)
    const hide1 = s.checks.afterHold.find((c) => c.id === 'c-hide')
    if (hide1 && hide1.spawns > 0) fail('own.offscreen-silent', '화면 밖 채팅이 혼자 발사했다(스펙 ⑤ 위반)', hide1)
    else ok('own.offscreen-silent', hide1)
    // 보이는 채팅은 **엔진이** 자동으로 쐈다 — 렌더러가 아니라(렌더러는 managed로 멈춰 있다)
    const see1 = s.checks.afterHold.find((c) => c.id === 'c-see')
    if (!see1 || see1.spawns < 1) fail('own.auto-fired', '보이는 채팅의 예약이 안 나갔다', s.checks.afterHold)
    else if (see1.spawns > 1) fail('own.auto-fired', `보이는 채팅이 ${see1.spawns}번 나갔다 — 재개 주체가 둘이다`, s.checks.afterHold)
    else ok('own.auto-fired', { spawns: see1.spawns })

    // ── ④ 「이어가기」를 누르면 그때 나간다 ──────────────────────────────────
    await app.cdp.eval(
      `(() => { const e = [...document.querySelectorAll('.sb-item')].find((x) => (x.textContent||'').includes('화면 밖'))
         const b = e && e.querySelector('.sb-resume'); if (!b) return false; b.click(); return true })()`
    )
    await sleep(2500)
    const d2 = await dbg()
    s.checks.afterPress = (d2?.chats ?? []).map((c) => ({ id: c.chatId, spawns: c.spawns, hold: c.hold, auto: c.autoResume }))
    const hide2 = s.checks.afterPress.find((c) => c.id === 'c-hide')
    if (!hide2 || hide2.spawns < 1) fail('own.press-resume', '「이어가기」를 눌렀는데 안 나갔다 — 침묵 no-op', s.checks.afterPress)
    else if (hide2.hold) fail('own.press-resume', '눌렀는데 대기표가 그대로 남았다', hide2)
    else ok('own.press-resume', hide2)

    // ── ⑤ 창 자리 — 「창」 칩은 chat:windows를 읽는다 ─────────────────────────
    await app.cdp.eval(`window.api.openSessionWindow()`, { awaitPromise: true }).catch(() => {})
    const chipUp = await waitFor(app.cdp, `__n('.sb-item .slotchip.win') === 1`, { tries: 120 })
    const slots = await ipc('win:chat-list', [])
    const winChatId = (slots ?? [])[0]?.chatId ?? ''
    // **이름을 준다** = 그 추가 채팅이 디스크에 영속된다. 이름 없는 빈 대화는 창을 닫으면
    // 목록에서도 사라지는 게 정상이라(2.6.2 파리티) 「창만 닫기」의 저울이 못 된다.
    // 이름을 준다 = 그 추가 채팅이 목록에 **자기 이름으로** 남는다. 실패해도(빈 대화라
    // 아직 디스크에 없을 수 있다) 무해하다 — 아래 판정은 이름이 아니라 **항목 수**를 본다.
    if (winChatId) await ipc('session-wins:rename', [winChatId, 'POC 창 대화'])
    await sleep(1200)
    s.checks.winChip = await app.cdp.eval(`__txts('.sb-item .slotchip.win')`)
    s.checks.slots = slots
    if (!chipUp) fail('own.win-chip', '창을 열었는데 목록에 「창」 칩이 안 붙었다', { chip: s.checks.winChip, slots })
    else ok('own.win-chip', { chip: s.checks.winChip, slots: (slots ?? []).map((w) => w.chatId) })
    // 창만 닫기 — 칩은 사라지고 **대화는 목록에 남는다**(삭제가 아니다)
    const before = await app.cdp.eval(`__txts('.sb-item .t .tx')`)
    await ipc('win:chat-close', [{ chatId: winChatId }])
    const chipGone = await waitFor(app.cdp, `__n('.sb-item .slotchip.win') === 0`, { tries: 120 })
    await sleep(600)
    const after = await app.cdp.eval(`__txts('.sb-item .t .tx')`)
    s.checks.closeOnly = { before, after, chipGone }
    if (!chipGone) fail('own.win-close-chip', '창을 닫았는데 「창」 칩이 남았다 — 목록이 거짓말을 한다', s.checks.closeOnly)
    else if (after.length !== before.length) fail('own.win-close-keeps-chat', '창만 닫았는데 대화가 목록에서 사라졌다 — win:chat-close는 삭제가 아니다', s.checks.closeOnly)
    else ok('own.win-close-only', { chats: after.length, kept: after })
    // 되만들기 — 그 항목을 누르면 창이 다시 뜬다(win:chat-focus)
    await app.cdp.eval(
      `(() => { const e = [...document.querySelectorAll('.sb-item')].find((x) => !(x.textContent||'').includes('POC '))
         if (!e) return false; e.click(); return true })()`
    )
    const chipBack = await waitFor(app.cdp, `__n('.sb-item .slotchip.win') === 1`, { tries: 120 })
    s.checks.recreate = { slots: await ipc('win:chat-list', []), chipBack }
    if (!chipBack) fail('own.win-recreate', '닫힌 창 항목을 눌러도 창이 되만들어지지 않는다', s.checks.recreate)
    else ok('own.win-recreate', { slots: (s.checks.recreate.slots ?? []).map((w) => w.chatId) })
  } catch (e) {
    fail('own', String(e?.message ?? e))
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
  if (want('raise')) await stepRaise()
  if (want('settle')) await stepSettle()
  if (want('own')) await stepOwn()
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
