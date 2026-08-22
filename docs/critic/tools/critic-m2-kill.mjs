#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// critic-m2-kill — **중간 SIGKILL**을 서로 다른 타이밍 3곳에서.
//
// 빌더 하네스는 35% 한 지점만 죽였다(§5.3-6). 여기서는 부하 홈(200/20×6/30)에서
// 완주 시간을 재고 **15% / 55% / 92%** 세 지점에서 죽인 뒤,
//   · 옛 3디렉터리 바이트 동일 (롤백 경로)
//   · chats-v3 상태 = absent | complete | **partial**
//   · boards 와의 **찢어진 커밋**(chats-v3만 커밋되고 boards는 없음) — 커밋이 rename **둘**이라
//     그 사이에 죽으면 `is_migrated()`는 true인데 보드가 없다
//   · 재실행이 잔여물을 쓸어내고 완주하는가
// 를 본다. 추가로 **저장 경로(팬아웃 write_all) 중간 kill**도 한 번 — 마이그레이션이
// 아니라 평소 저장이 반쪽으로 끊겼을 때 대화가 남는가.
//
//   node docs/critic/tools/critic-m2-kill.mjs
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync, spawn } from 'node:child_process'
import { EXE, canon, cli, dirHash, payloadFile, readJSON, rmrf, sha, v3Units, writeResult } from './critic-m2-lib.mjs'

const ROOT = path.join(os.tmpdir(), `ccg-critic-m2-kill-${Date.now()}`)

const snap = (n, sid) => ({
  status: 'idle',
  messages: Array.from({ length: n }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', text: `줄 ${i} — ${'가'.repeat(60)}`, animate: false })),
  todos: [], files: [], diffs: {}, terminal: [], subagents: [], bgTasks: [], workflows: [],
  pendingPermission: null, pendingQuestion: null,
  session: sid ? { sessionId: sid, model: 'opus', cwd: 'C:\\Code' } : null,
  result: null, spentUsd: 0, tokenTotals: {}, streaming: false, seq: n, shownNotices: []
})

function loadHome(dir) {
  rmrf(dir)
  for (const d of ['chats', 'multi-agent', 'session-chats']) fs.mkdirSync(path.join(dir, d), { recursive: true })
  fs.writeFileSync(path.join(dir, 'ui-prefs.json'), JSON.stringify({ 'workspace.mode': 'multi', 'api.mode': false }))
  const order = []
  for (let i = 0; i < 200; i++) {
    const id = `chat-${String(i).padStart(4, '0')}`
    order.push(id)
    fs.writeFileSync(path.join(dir, 'chats', `${id}.json`), JSON.stringify({
      id, title: `채팅 ${i}`, custom: false, snapshot: snap(60, `sess-c-${i}`), manualCwd: 'C:\\Code',
      picker: { model: 'opus', effort: 'max', mode: 'bypass' }, refDirs: [], updatedAt: 1_700_000_000_000 + i
    }))
  }
  fs.writeFileSync(path.join(dir, 'chats', 'index.json'), JSON.stringify({ version: 1, order, activeChatId: order[3] }))
  const morder = []
  for (let s = 0; s < 20; s++) {
    const sid = `ms-${s}`
    morder.push(sid)
    const panels = Array.from({ length: 6 }, (_, i) => ({
      title: `패널 ${s}-${i}`, custom: false, cwd: 'C:\\Code', refDirs: [], picker: { model: 'opus', effort: 'high', mode: 'auto' },
      snapshot: snap(40, `sess-p-${s}-${i}`)
    }))
    fs.writeFileSync(path.join(dir, 'multi-agent', `${sid}.json`), JSON.stringify({ id: sid, title: `세션 ${s}`, custom: false, count: 4, panelOrder: [0, 1, 2, 3, 4, 5], panels }))
  }
  fs.writeFileSync(path.join(dir, 'multi-agent', 'index.json'), JSON.stringify({ version: 2, order: morder, activeSessionId: morder[1] }))
  const sorder = []
  for (let i = 0; i < 30; i++) {
    const id = `scu-${i}`
    sorder.push(id)
    fs.writeFileSync(path.join(dir, 'session-chats', `${id}.json`), JSON.stringify({
      id, title: `추가 ${i}`, status: 'done', cwd: 'C:\\Code', refDirs: [], snapshot: snap(20, `sess-s-${i}`), picker: {}, updatedAt: 1
    }))
  }
  fs.writeFileSync(path.join(dir, 'session-chats', 'index.json'), JSON.stringify({ version: 1, order: sorder }))
  return dir
}

function hashes(dir) {
  return { chats: dirHash(path.join(dir, 'chats')), ma: dirHash(path.join(dir, 'multi-agent')), sc: dirHash(path.join(dir, 'session-chats')) }
}

function killRun(src, label, killMs) {
  const dir = path.join(ROOT, `run-${label}`)
  rmrf(dir)
  fs.cpSync(src, dir, { recursive: true })
  const before = hashes(dir)
  const t0 = Date.now()
  const r = spawnSync(EXE, ['migrate', '--no-backup'], { env: { ...process.env, CCG_HOME: dir }, encoding: 'utf8', timeout: killMs, killSignal: 'SIGKILL', maxBuffer: 1 << 28 })
  const wall = Date.now() - t0
  const killed = r.error?.code === 'ETIMEDOUT' || r.signal != null
  const after = hashes(dir)
  const v3dir = path.join(dir, 'chats-v3')
  const bdir = path.join(dir, 'boards')
  const idx = readJSON(path.join(v3dir, 'index.json'))
  const v3state = !fs.existsSync(v3dir)
    ? 'absent'
    : idx && (idx.order ?? []).every((id) => fs.existsSync(path.join(v3dir, `${id}.json`)))
      ? 'complete'
      : 'partial'
  const out = {
    label,
    killMs,
    wallMs: wall,
    killed,
    oldDirsIntact: canon(before) === canon(after),
    chatsV3: v3state,
    chatsV3Files: fs.existsSync(v3dir) ? fs.readdirSync(v3dir).length : 0,
    boardsExists: fs.existsSync(bdir),
    boardsFiles: fs.existsSync(bdir) ? fs.readdirSync(bdir).length : 0,
    // 커밋이 rename **둘**이므로 "chats-v3는 있는데 boards가 없다"가 가능하다.
    // 그 상태에서 is_migrated()는 true다 = 다시는 마이그레이션하지 않는다.
    tornCommit: fs.existsSync(v3dir) && !!idx?.migratedAt && !fs.existsSync(path.join(bdir, 'index.json')),
    leftovers: fs.readdirSync(dir).filter((f) => f.includes('.tmp-') || f.includes('.old-'))
  }
  // 재실행 복구
  const re = cli(dir, ['migrate', '--no-backup'], { timeout: 240_000 })
  out.rerun = {
    ok: re.json?.ok ?? false,
    total: re.json?.counts?.total ?? null,
    messages: re.json?.counts?.messages ?? null,
    leftoversAfter: fs.readdirSync(dir).filter((f) => f.includes('.tmp-') || f.includes('.old-')),
    boardsAfter: fs.existsSync(bdir) ? fs.readdirSync(bdir).length : 0
  }
  const v3 = v3Units(dir)
  out.rerun.chatFiles = v3.units.size
  rmrf(dir)
  return out
}

/** 저장(팬아웃 write_all) 중간 kill — 평소 저장이 끊기면 대화가 남는가. */
function killDuringSave(src) {
  const dir = path.join(ROOT, 'save-kill')
  rmrf(dir)
  fs.cpSync(src, dir, { recursive: true })
  cli(dir, ['migrate', '--no-backup'], { timeout: 240_000 })
  const base = v3Units(dir)
  const full = cli(dir, ['read-chats']).json
  // 모든 채팅의 제목을 바꿔 **전 파일이 쓰기 대상**이 되게 한다
  const payload = { version: 1, activeChatId: full.activeChatId, chats: full.chats.map((c) => ({ ...c, title: `${c.title} ★변경` })) }
  const pf = payloadFile(payload, 'save')
  // 완주 시간을 재고 그 55% 지점에서 죽인다
  const t0 = Date.now()
  spawnSync(EXE, ['save-chats', pf], { env: { ...process.env, CCG_HOME: dir }, encoding: 'utf8', timeout: 240_000 })
  const fullMs = Date.now() - t0
  // 원상 복구 후 다시(제목 되돌리기)
  const restore = { version: 1, activeChatId: full.activeChatId, chats: full.chats }
  spawnSync(EXE, ['save-chats', payloadFile(restore, 'restore')], { env: { ...process.env, CCG_HOME: dir }, encoding: 'utf8' })
  const killAt = Math.max(5, Math.round(fullMs * 0.55))
  const r = spawnSync(EXE, ['save-chats', pf], { env: { ...process.env, CCG_HOME: dir }, encoding: 'utf8', timeout: killAt, killSignal: 'SIGKILL' })
  const killed = r.error?.code === 'ETIMEDOUT' || r.signal != null
  const after = v3Units(dir)
  let lost = 0
  let renamed = 0
  const tmpLeft = fs.readdirSync(path.join(dir, 'chats-v3')).filter((f) => f.endsWith('.tmp'))
  for (const [id, u] of base.units) {
    const a = after.units.get(id)
    if (!a || !a.parseOk) {
      lost++
      continue
    }
    if (a.threadBytes !== u.threadBytes) lost++
    if ((a.rec?.title ?? '').endsWith('★변경')) renamed++
  }
  const out = { fullSaveMs: fullMs, killAt, killed, chats: base.units.size, lostOrCorrupt: lost, partiallyApplied: renamed, tmpLeftovers: tmpLeft.slice(0, 5), tmpLeftoverCount: tmpLeft.length }
  rmrf(dir)
  return out
}

/** 스테이징 창을 **관측해서** 죽인다 — 시간 비율로는 못 맞추는 자리(마지막 100ms). */
async function killInStaging(src, waitFiles) {
  const dir = path.join(ROOT, `staging-${waitFiles}`)
  rmrf(dir)
  fs.cpSync(src, dir, { recursive: true })
  const before = hashes(dir)
  const child = spawn(EXE, ['migrate', '--no-backup'], { env: { ...process.env, CCG_HOME: dir }, stdio: 'ignore' })
  let sawStaging = false
  let filesAtKill = 0
  const t0 = Date.now()
  while (Date.now() - t0 < 60_000) {
    const stag = fs.readdirSync(dir).find((f) => f.startsWith('chats-v3.tmp-'))
    if (stag) {
      sawStaging = true
      const n = fs.readdirSync(path.join(dir, stag)).length
      if (n >= waitFiles) {
        filesAtKill = n
        child.kill('SIGKILL')
        break
      }
    }
    if (fs.existsSync(path.join(dir, 'chats-v3', 'index.json'))) break // 이미 커밋됨
    await new Promise((r) => setTimeout(r, 1))
  }
  await new Promise((r) => child.on('exit', r))
  const after = hashes(dir)
  const v3dir = path.join(dir, 'chats-v3')
  const idx = readJSON(path.join(v3dir, 'index.json'))
  const out = {
    waitFiles,
    sawStaging,
    filesAtKill,
    oldDirsIntact: canon(before) === canon(after),
    chatsV3Exists: fs.existsSync(v3dir),
    chatsV3Complete: !!idx && (idx.order ?? []).every((id) => fs.existsSync(path.join(v3dir, `${id}.json`))),
    boardsExists: fs.existsSync(path.join(dir, 'boards')),
    tornCommit: fs.existsSync(v3dir) && !!idx?.migratedAt && !fs.existsSync(path.join(dir, 'boards', 'index.json')),
    leftovers: fs.readdirSync(dir).filter((f) => f.includes('.tmp-') || f.includes('.old-'))
  }
  const re = cli(dir, ['migrate', '--no-backup'], { timeout: 240_000 })
  out.rerun = { ok: re.json?.ok ?? false, total: re.json?.counts?.total ?? null, leftoversAfter: fs.readdirSync(dir).filter((f) => f.includes('.tmp-') || f.includes('.old-')) }
  rmrf(dir)
  return out
}

/** 찢어진 커밋의 **결과**: chats-v3만 커밋되고 boards가 없다(rename 둘 사이 / boards 커밋 실패).
 *  `is_migrated()`는 index.json의 migratedAt만 보므로 **다시는 마이그레이션하지 않는다**. */
function tornCommitConsequence(src) {
  const dir = path.join(ROOT, 'torn')
  rmrf(dir)
  fs.cpSync(src, dir, { recursive: true })
  cli(dir, ['migrate', '--no-backup'], { timeout: 240_000 })
  rmrf(path.join(dir, 'boards')) // ← 두 rename 사이에서 죽은 것과 같은 상태
  const boards = cli(dir, ['read-boards'])
  const ma = cli(dir, ['alias-ma-get'])
  const light = cli(dir, ['read-chats', '--light'])
  const chats = light.json?.chats ?? []
  const again = cli(dir, ['migrate', '--no-backup']) // 사용자가 손으로 다시 돌렸을 때만 복구된다
  const out = {
    isMigratedStillTrue: !!readJSON(path.join(dir, 'chats-v3', 'index.json'))?.migratedAt,
    readBoards: boards.json,
    maGetNull: ma.json === null || ma.json === undefined,
    lightMarkers: chats.filter((c) => c.unloaded === true).length,
    lightWithSnapshot: chats.filter((c) => c.unloaded !== true).length,
    totalChats: chats.length,
    manualRerunFixesBoards: again.json?.ok === true && fs.existsSync(path.join(dir, 'boards', 'index.json'))
  }
  rmrf(dir)
  return out
}

async function main() {
  fs.mkdirSync(ROOT, { recursive: true })
  const src = loadHome(path.join(ROOT, 'src'))
  const rep = { at: new Date().toISOString(), runs: [] }

  // 완주 시간 측정(같은 조건)
  const probe = killRun(src, 'probe', 240_000)
  rep.fullRunMs = probe.wallMs
  rep.probe = probe
  for (const [label, frac] of [['early-15', 0.15], ['mid-55', 0.55], ['late-92', 0.92]]) {
    const at = Math.max(10, Math.round(probe.wallMs * frac))
    const r = killRun(src, label, at)
    rep.runs.push(r)
    process.stdout.write(`  ${label}: killed=${r.killed} old=${r.oldDirsIntact} v3=${r.chatsV3} boards=${r.boardsExists} torn=${r.tornCommit} leftovers=${r.leftovers.length} rerun=${r.rerun.ok}/${r.rerun.total}\n`)
  }
  // 스테이징 창(마지막 100ms) — 관측 기반 kill 둘
  rep.staging = []
  for (const n of [5, 200]) {
    const r = await killInStaging(src, n)
    rep.staging.push(r)
    process.stdout.write(`  staging@${n}: saw=${r.sawStaging} files=${r.filesAtKill} old=${r.oldDirsIntact} v3=${r.chatsV3Exists} torn=${r.tornCommit} leftovers=${r.leftovers.length} rerun=${r.rerun.ok}/${r.rerun.total}\n`)
  }
  rep.tornCommit = tornCommitConsequence(src)
  process.stdout.write(`  torn-commit: ${JSON.stringify(rep.tornCommit)}\n`)

  rep.saveKill = killDuringSave(src)
  process.stdout.write(`  save-kill: ${JSON.stringify(rep.saveKill)}\n`)
  rep.verdict = {
    oldDirsAlwaysIntact: rep.runs.every((r) => r.oldDirsIntact),
    neverPartial: rep.runs.every((r) => r.chatsV3 !== 'partial'),
    tornCommitSeen: rep.runs.filter((r) => r.tornCommit).map((r) => r.label),
    rerunAlwaysRecovers: rep.runs.every((r) => r.rerun.ok && r.rerun.total === probe.rerun.total)
  }
  const out = writeResult('m2-r1-kill.json', rep)
  console.log(JSON.stringify(rep.verdict), out)
  rmrf(ROOT)
}

main()
