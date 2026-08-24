#!/usr/bin/env node
/* ============================================================================
 * critic-wiring-alias — 2.6.2 **별칭 충실도 spot 3건**을 도는 앱의 IPC로 직접 친다.
 *
 *  S1 unloaded 병합 — light 조회가 준 마커를 그대로 되보내면 디스크 스냅샷이 살아 있나
 *                     (깨지면 = 대화 증발. `poc-chats-merge` 규약의 3.0 대응물)
 *  S2 ma 패널 저장  — `ma:get` → 고쳐서 `ma:save` → 다시 `ma:get`. 패널 스냅샷 보존?
 *  S3 추가 채팅 목록 — 창을 열고 **닫을 때**도 영속 추가 채팅이 목록에 남나
 *                     (빌더의 R8-1 하네스는 **여는 쪽만** 밟았다. 크리틱 R8 §2.5의
 *                      증상 문장은 "열거나 **닫는** 순간"이다)
 *
 *   node docs/critic/tools/critic-wiring-alias.mjs [--exe=<path>]
 * ========================================================================== */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { connectMainPage, killTree, sleep, REPO, resolveTauriExe } from '../../../bench/lib.mjs'

const exeArg = (process.argv.find((a) => a.startsWith('--exe=')) ?? '').split('=')[1]
// M12 R2 — mainBinaryName 변경으로 exe 이름이 둘이다(구·신 모두 탐색·최신 mtime 우선)
const EXE = resolveTauriExe(exeArg)
const HOME = path.join(REPO, '.critic-home-alias')
const PORT = 9385
const OUT = path.join(REPO, 'docs', 'critic', 'wiring-r1-alias.json')
const rep = { at: new Date().toISOString(), exe: EXE, spots: {}, findings: [] }
const fail = (id, why, extra) => {
  rep.findings.push({ id, why, ...(extra ?? {}) })
  console.error(`  ✗ ${id} — ${why}`)
}
const ok = (id, v) => console.log(`  ✓ ${id}${v === undefined ? '' : ' — ' + JSON.stringify(v)}`)
const write = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(v))
}

const snap = (n, sid) => ({
  status: 'done',
  messages: Array.from({ length: n }, (_, i) => ({ kind: 'msg', id: `m${i}`, role: i % 2 ? 'assistant' : 'user', text: `줄 ${i} ${'가'.repeat(40)}`, animate: false })),
  todos: [], files: [], diffs: {}, terminal: [], subagents: [], bgTasks: [], workflows: [],
  pendingPermission: null, pendingQuestion: null,
  session: sid ? { sessionId: sid, model: 'opus', cwd: 'C:\\Code' } : null,
  result: null, spentUsd: 0, tokenTotals: {}, streaming: false, seq: n, shownNotices: []
})

function seed() {
  fs.rmSync(HOME, { recursive: true, force: true })
  const chats = ['c-1', 'c-2', 'c-3']
  chats.forEach((id, i) =>
    write(path.join(HOME, 'chats', `${id}.json`), {
      id, title: `채팅 ${i}`, custom: true, manualCwd: REPO, refDirs: [],
      picker: { model: 'opus', effort: 'high', mode: 'auto' }, snapshot: snap(6 + i, `s-${id}`), updatedAt: 1000 + i
    })
  )
  write(path.join(HOME, 'chats', 'index.json'), { version: 1, order: chats, activeChatId: 'c-1' })
  write(path.join(HOME, 'multi-agent', 'sess-A.json'), {
    id: 'sess-A', title: 'A', custom: true, count: 2, panelOrder: [0, 1, 2, 3, 4, 5],
    panels: [
      { title: 'P0', custom: true, cwd: REPO, refDirs: [], picker: { model: 'opus', effort: 'high', mode: 'auto' }, api: false, snapshot: snap(5, 's-p0') },
      { title: 'P1', custom: true, cwd: REPO, refDirs: [], picker: { model: 'sonnet', effort: 'low', mode: 'plan' }, api: true, snapshot: snap(4, 's-p1') }
    ]
  })
  write(path.join(HOME, 'multi-agent', 'index.json'), { version: 2, order: ['sess-A'], activeSessionId: 'sess-A' })
  const scs = ['w-1', 'w-2']
  scs.forEach((id, i) =>
    write(path.join(HOME, 'session-chats', `${id}.json`), { id, title: `추가 ${i}`, status: 'done', cwd: REPO, snapshot: snap(3 + i, `s-${id}`), picker: {}, updatedAt: 5 })
  )
  write(path.join(HOME, 'session-chats', 'index.json'), { version: 1, order: scs })
  write(path.join(HOME, 'ui-prefs.json'), { 'ui.lang': 'ko', 'whatsnew.seenVersion': '3.0.0-beta.1' })
  write(path.join(HOME, 'profile.json'), { nickname: 'critic' })
}

const app = {}
async function boot() {
  app.child = spawn(EXE, [], { env: { ...process.env, CCG_HOME: HOME, CCG_CDP_PORT: String(PORT) }, cwd: REPO, stdio: 'ignore' })
  app.cdp = await connectMainPage(PORT, { timeoutMs: 60_000 })
  for (let i = 0; i < 400; i++) {
    const up = await app.cdp.eval(`(async () => { try { return !!(await window.api.app.getVersion()) } catch { return false } })()`, { awaitPromise: true }).catch(() => false)
    if (up) break
    await sleep(100)
  }
  app.j = async (e) => JSON.parse(await app.cdp.eval(`(async () => JSON.stringify(${e}))()`, { awaitPromise: true }))
  app.ipc = (channel, payload = []) =>
    app.j(`await window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: ${JSON.stringify(channel)}, payload: ${JSON.stringify(payload)} })`)
}

seed()
if (!fs.existsSync(EXE)) {
  console.error('exe 없음: ' + EXE)
  process.exit(2)
}
await boot()
try {
  // ── S1 — unloaded 마커 왕복 ────────────────────────────────────────────────
  console.log('\n[S1] unloaded 마커 병합')
  const light = await app.ipc('chats:get', [{ light: true }])
  const before = Object.fromEntries(
    await Promise.all((light.chats ?? []).map(async (c) => [c.id, (await app.ipc('chats:load', [c.id]))?.snapshot?.messages?.length ?? null]))
  )
  const markers = (light.chats ?? []).map((c) => ({ id: c.id, marked: c.unloaded === true, msgs: c.snapshot?.messages?.length ?? null }))
  // 렌더러가 하는 그대로 되보낸다 — light 페이로드 그대로 chats:save
  await app.ipc('chats:save', [{ version: light.version ?? 1, chats: light.chats, activeChatId: light.activeChatId }])
  await sleep(1200)
  const after = Object.fromEntries(
    await Promise.all((light.chats ?? []).map(async (c) => [c.id, (await app.ipc('chats:load', [c.id]))?.snapshot?.messages?.length ?? null]))
  )
  rep.spots.s1 = { markers, before, after }
  const lost = Object.keys(before).filter((k) => before[k] !== after[k])
  if (lost.length) fail('S1-unloaded', '마커 왕복에 스냅샷이 갈렸다', { lost, before, after })
  else ok('S1-unloaded', { chats: Object.keys(before).length, msgs: before })

  // ── S2 — ma 패널 저장 ──────────────────────────────────────────────────────
  console.log('\n[S2] ma 패널 저장')
  const ma0 = await app.ipc('ma:get')
  const sess0 = (ma0?.sessions ?? [])[0] ?? null
  const panels0 = (sess0?.panels ?? []).map((p) => ({ title: p?.title ?? null, msgs: p?.snapshot?.messages?.length ?? null }))
  const edited = JSON.parse(JSON.stringify(ma0))
  if (edited?.sessions?.[0]?.panels?.[0]) edited.sessions[0].panels[0].title = 'P0-크리틱'
  await app.ipc('ma:save', [edited])
  await sleep(1200)
  const ma1 = await app.ipc('ma:get')
  const panels1 = ((ma1?.sessions ?? [])[0]?.panels ?? []).map((p) => ({ title: p?.title ?? null, msgs: p?.snapshot?.messages?.length ?? null }))
  rep.spots.s2 = { panels0, panels1, sessionIds: (ma1?.sessions ?? []).map((s) => s.id) }
  if (!panels0.length) fail('S2-ma', 'ma:get이 패널을 안 준다', { ma0Keys: Object.keys(ma0 ?? {}) })
  else if (panels1[0]?.title !== 'P0-크리틱') fail('S2-ma', '저장한 제목이 안 돌아온다', { panels0, panels1 })
  else if (panels0.some((p, i) => p.msgs !== panels1[i]?.msgs)) fail('S2-ma', '패널 스냅샷이 왕복에 갈렸다', { panels0, panels1 })
  else ok('S2-ma', { panels: panels1 })

  // ── S3 — 추가 채팅 목록: 열 때 **와 닫을 때** ──────────────────────────────
  console.log('\n[S3] 추가 채팅 목록 (열기 + 닫기)')
  const s3 = {}
  s3.listAtBoot = (await app.ipc('session-wins:list')).map((w) => w.id)
  await app.j(`(window.__chg = [], window.api.sessionWindows.onChanged((l) => window.__chg.push(l.map((w) => w.id))), 'armed')`)
  await app.j(`(await window.api.openSessionWindow(), 'opened')`)
  for (let i = 0; i < 60; i++) {
    if ((await app.j('window.__chg.length')) > 0) break
    await sleep(100)
  }
  s3.afterOpen = await app.j('window.__chg.at(-1)')
  const opened = s3.afterOpen.find((id) => !s3.listAtBoot.includes(id))
  s3.openedId = opened ?? null
  // 닫는다 — R8 크리틱의 증상 문장은 "열거나 **닫는** 순간"이다
  if (opened) await app.j(`(window.api.sessionWindows.close(${JSON.stringify(opened)}), 'closing')`)
  for (let i = 0; i < 80; i++) {
    const n = await app.j('window.__chg.length')
    if (n >= 2) break
    await sleep(100)
  }
  s3.allPayloads = await app.j('window.__chg')
  s3.afterClose = await app.j('window.__chg.at(-1)')
  s3.listAfterClose = (await app.ipc('session-wins:list')).map((w) => w.id)
  s3.persistedLostOnClose = s3.listAtBoot.filter((id) => !(s3.afterClose ?? []).includes(id))
  rep.spots.s3 = s3
  if (s3.listAtBoot.length !== 2) fail('S3-부팅목록', `영속 추가 채팅 2건이 안 보인다: ${JSON.stringify(s3.listAtBoot)}`)
  else ok('S3-부팅목록', s3.listAtBoot)
  if (!opened) fail('S3-열기', '창을 열어도 changed에 새 항목이 없다', s3)
  else ok('S3-열기', s3.afterOpen)
  if (s3.persistedLostOnClose.length) fail('S3-닫기', '창을 닫으면 영속 추가 채팅이 목록에서 사라진다', s3)
  else ok('S3-닫기', s3.afterClose)
  // ── S4 — 추가 채팅 **창의 대화 저장** 채널 (보고서 미배선 목록에 없는 자리) ───
  //    이번 라운드가 `session:run`을 배선해 그 창에서 **실제로 대화가 돈다**. 그런데
  //    그 대화를 저장하는 채널(`session-wins:persist`)은 셸에 없다 → 창을 닫으면 증발.
  console.log('\n[S4] 추가 채팅 창 저장/복원 채널')
  const s4 = {}
  for (const c of ['session-wins:persist', 'session-wins:hydrate', 'session-wins:rename', 'session-wins:report']) {
    const r = await app.ipc(c, c === 'session-wins:persist' ? [{ id: 'w-1', snapshot: snap(2, 's-w1'), title: 'x' }] : c === 'session-wins:rename' ? ['w-1', 'x'] : [])
    s4[c] = r && typeof r === 'object' && r.__unimplemented === true ? 'UNIMPLEMENTED' : JSON.stringify(r).slice(0, 80)
  }
  await sleep(1200)
  s4.w1MsgsAfterPersist = (await app.ipc('chats:load', ['w-1']))?.snapshot?.messages?.length ?? null
  rep.spots.s4 = s4
  const dead = Object.entries(s4).filter(([k, v]) => k.startsWith('session-wins:') && v === 'UNIMPLEMENTED').map(([k]) => k)
  if (dead.length) fail('S4-추가채팅저장', `추가 채팅 창의 대화를 저장/복원할 채널이 없다: ${dead.join(', ')}`, s4)
  else ok('S4-추가채팅저장', s4)
} catch (e) {
  fail('alias', String(e))
} finally {
  try {
    killTree(app.child.pid)
  } catch {}
  await sleep(800)
  fs.rmSync(HOME, { recursive: true, force: true })
}
rep.verdict = rep.findings.length === 0 ? 'PASS' : 'FAIL'
fs.writeFileSync(OUT, JSON.stringify(rep, null, 2))
console.log(`\n판정: ${rep.verdict} · 결함 ${rep.findings.length}건 · ${OUT}`)
