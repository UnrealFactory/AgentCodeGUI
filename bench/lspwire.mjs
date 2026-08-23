// ── M7 R4 배선 실증 — §R3-9가 남긴 두 자리를 **실물에서** 확인한다 ─────────────
//
//   node bench/lspwire.mjs --exe <agentcodegui.exe> [--skip-install]
//
// ① `lsp:files-changed` — 앱을 거친 쓰기(`fs:write-file`)가 서버에 흘러가고 **열린 창이
//    깨어나는가**. R3까지 크레이트에는 실체가 있는데 부르는 곳이 없었다.
// ② `lsp:install-progress` + **실제 다운로드** — R3은 "네트워크를 타는 경로라 이번 라운드에
//    실제 다운로드는 돌려 보지 않았다"였다. 여기서 격리 홈에 clangd를 진짜로 받는다
//    (실홈 `~/.agentcodegui/lsp/cpp`는 **건드리지 않는다** — 격리 홈에 새로 받는다).
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { tauriProfile, connectMainPage, killTree, sleep, REPO } from './lib.mjs'
import { makeFixtureHome, FIX_ID } from './fixture.mjs'
import { FIXTURES } from './lspfix.mjs'

const argv = process.argv.slice(2)
const flag = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const EXE = flag('exe', path.join(REPO, 'target', 'release', 'agentcodegui.exe'))
const SKIP_INSTALL = argv.includes('--skip-install')
const WORK = path.join(os.tmpdir(), 'ccg-r4wire-work')
const HOME = path.join(os.tmpdir(), 'ccg-r4wire-home')
const out = { at: new Date().toISOString(), exe: EXE, checks: [] }

function homeWith(fix, { linkServer }) {
  fs.rmSync(HOME, { recursive: true, force: true })
  makeFixtureHome(HOME, '3.0.0-beta.1')
  const f = path.join(HOME, 'chats', `${FIX_ID}.json`)
  const chat = JSON.parse(fs.readFileSync(f, 'utf8'))
  chat.manualCwd = WORK
  if (chat.snapshot) chat.snapshot.cwd = WORK
  fs.writeFileSync(f, JSON.stringify(chat))
  // ②에서는 **일부러 안 잇는다** — 진짜로 내려받는지 보려는 것이다
  if (linkServer) fix.prepareHome(HOME)
  return HOME
}

async function boot() {
  const profile = tauriProfile({ port: 9377, exe: EXE })
  const child = spawn(profile.cmd, profile.args, {
    env: { ...process.env, ...profile.env, CCG_HOME: HOME },
    cwd: profile.cwd,
    stdio: 'ignore'
  })
  const cdp = await connectMainPage(9377, { timeoutMs: 90000 })
  await cdp.send('Runtime.enable')
  const t0 = Date.now()
  while (Date.now() - t0 < 90000) {
    if (await cdp.eval(profile.mountExpr).catch(() => false)) break
    await sleep(80)
  }
  return { child, cdp }
}

const S = (v) => JSON.stringify(v)

// ── ① files-changed ───────────────────────────────────────────────────────────
async function filesChanged() {
  const fix = FIXTURES.cpp.make(WORK, { blocks: 40 })
  homeWith(fix, { linkServer: true })
  const { child, cdp } = await boot()
  try {
    // 서버를 실제로 띄운다 — 뜬 서버가 하나도 없으면 규약대로 **브로드캐스트를 안 한다**
    await cdp.eval(`window.api.lsp.status(${S(WORK)}, ${S(fix.bigRel)})`, { awaitPromise: true })
    const t0 = Date.now()
    for (;;) {
      const st = await cdp.eval(`window.api.lsp.status(${S(WORK)}, ${S(fix.bigRel)})`, { awaitPromise: true })
      if (st === 'ready') break
      if (Date.now() - t0 > 60000) throw new Error(`status가 ready가 안 됨: ${st}`)
      await sleep(150)
    }
    // 토큰을 한 번 받아 문서를 서버에 연다(재동기화 대상이 생긴다)
    await cdp.eval(`window.api.lsp.semanticTokens(${S(WORK)}, ${S(fix.bigRel)})`, { awaitPromise: true })
    await cdp.eval(`(() => {
      window.__r4 = { events: [] }
      window.api.lsp.onFilesChanged((e) => window.__r4.events.push(e))
      return true
    })()`)
    // 앱을 거친 쓰기 — 뷰어의 저장/에이전트 편집이 타는 그 채널
    const abs = path.join(WORK, fix.bigRel)
    const edited = fix.edit(fs.readFileSync(abs, 'utf8'), 7)
    const wrote = await cdp.eval(
      `window.api.writeFile(${S(WORK)}, ${S(fix.bigRel)}, ${S(edited)})`,
      { awaitPromise: true }
    )
    const t1 = Date.now()
    let ev = []
    while (Date.now() - t1 < 10000) {
      ev = await cdp.eval(`window.__r4.events`)
      if (ev.length) break
      await sleep(120)
    }
    // 서버가 새 심볼을 아는가(= 통지가 실제로 서버까지 갔는가)
    const marker = fix.editedMarker(7)
    const line = edited.split('\n').findIndex((l) => l.includes(marker))
    const ch = (edited.split('\n')[line] ?? '').indexOf(marker) + 3
    let hover = null
    const t2 = Date.now()
    while (Date.now() - t2 < 20000) {
      hover = await cdp.eval(
        `window.api.lsp.hover(${S(WORK)}, ${S(fix.bigRel)}, { line: ${line}, character: ${ch} })`,
        { awaitPromise: true }
      )
      if (hover && hover.contents && hover.contents.includes(marker)) break
      await sleep(250)
    }
    return {
      wrote,
      events: ev,
      broadcastMs: ev.length ? Date.now() - t1 : null,
      serverKnowsNewSymbol: !!(hover && hover.contents && hover.contents.includes(marker)),
      hoverHead: hover && hover.contents ? hover.contents.replace(/\s+/g, ' ').slice(0, 80) : null
    }
  } finally {
    try { cdp.close() } catch { /* closed */ }
    killTree(child.pid)
    await sleep(1200)
  }
}

// ── ② 실제 다운로드 + 진행률 ──────────────────────────────────────────────────
async function installProgress() {
  const fix = FIXTURES.cpp.make(WORK, { blocks: 40 })
  homeWith(fix, { linkServer: false }) // ← 정션을 안 건다: 격리 홈에 진짜로 받는다
  const { child, cdp } = await boot()
  try {
    const before = await cdp.eval(`window.api.lsp.status(${S(WORK)}, ${S(fix.bigRel)})`, { awaitPromise: true })
    await cdp.eval(`(() => {
      window.__r4i = { events: [] }
      window.api.lsp.onInstallProgress((e) => window.__r4i.events.push(e))
      return true
    })()`)
    const t0 = Date.now()
    const res = await cdp.eval(`window.api.lsp.installServer('cpp')`, { awaitPromise: true, timeoutMs: 600000 })
    const ms = Date.now() - t0
    await sleep(400)
    const ev = await cdp.eval(`window.__r4i.events`)
    const after = await cdp.eval(`window.api.lsp.status(${S(WORK)}, ${S(fix.bigRel)})`, { awaitPromise: true })
    const dir = path.join(HOME, 'lsp', 'cpp')
    const find = (d, depth = 0) => {
      if (depth > 6) return null
      let ents = []
      try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return null }
      for (const e of ents) {
        const p = path.join(d, e.name)
        if (e.isFile() && e.name === 'clangd.exe') return p
        if (e.isDirectory()) { const r = find(p, depth + 1); if (r) return r }
      }
      return null
    }
    const bin = find(dir)
    const pcts = ev.map((e) => e.percent).filter((p) => typeof p === 'number')
    return {
      statusBefore: before,
      statusAfter: after,
      result: res,
      elapsedMs: ms,
      events: ev.length,
      firstLines: ev.slice(0, 3).map((e) => `${e.percent}% ${e.line ?? ''}`),
      lastEvent: ev[ev.length - 1] ?? null,
      monotonic: pcts.every((p, i) => i === 0 || p >= pcts[i - 1]),
      sawMidProgress: pcts.some((p) => p > 0 && p < 100),
      binary: bin,
      binaryBytes: bin ? fs.statSync(bin).size : 0
    }
  } finally {
    try { cdp.close() } catch { /* closed */ }
    killTree(child.pid)
    await sleep(1200)
  }
}

const run = async (id, fn) => {
  try {
    const detail = await fn()
    out.checks.push({ id, ok: true, detail })
    console.log(`[ok]   ${id} — ${JSON.stringify(detail).slice(0, 400)}`)
  } catch (e) {
    out.checks.push({ id, ok: false, error: String(e?.message ?? e) })
    console.log(`[FAIL] ${id} — ${e?.message ?? e}`)
  }
}

await run('files-changed', filesChanged)
if (!SKIP_INSTALL) await run('install-progress', installProgress)
const file = path.join(REPO, 'docs', 'critic', 'm7-r4-wire.json')
fs.mkdirSync(path.dirname(file), { recursive: true })
fs.writeFileSync(file, JSON.stringify(out, null, 2))
console.log(`→ ${file}`)
