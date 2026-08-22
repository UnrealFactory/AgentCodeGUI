#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// critic-m2-semantics — **왕복 의미론 공격**(옵트인 경로의 별칭 계층).
//
// 2.6.2 규약에 대응하는 시나리오를 통합 스토어에 그대로 쏜다:
//   A. unloaded 마커 저장 → 스냅샷 보존
//   B. Rust 소유 3필드 위조 → 미채택 / **런타임 값 vs 별칭 번역 — 누가 이기는가(P3)**
//   C. prune — origin 필드가 남의 칸을 지키는가 / **origin이 없거나 틀리면**
//   D. 멱등(별칭 왕복 3회)
//   E. status.json 재구성(삭제·손상·반쪽) + index.json 손상
//   F. chats:set-active 즉시성 vs 디바운스 저장의 덮어쓰기
//
//   node docs/critic/tools/critic-m2-semantics.mjs
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { canon, cli, payloadFile, readJSON, rmrf, sha, v3Units, writeResult } from './critic-m2-lib.mjs'

const ROOT = path.join(os.tmpdir(), `ccg-critic-m2-sem-${Date.now()}`)
const findings = []
const F = (item, d) => findings.push({ item, ...d })

const snap = (n, sid) => ({
  status: 'idle',
  messages: Array.from({ length: n }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', text: `줄 ${i} ${'나'.repeat(30)}`, animate: false })),
  todos: [], files: [], diffs: {}, terminal: [], subagents: [], bgTasks: [], workflows: [],
  pendingPermission: null, pendingQuestion: null,
  session: sid ? { sessionId: sid, model: 'opus', cwd: 'C:\\Code' } : null,
  result: null, spentUsd: 0, tokenTotals: {}, streaming: false, seq: n, shownNotices: []
})

function home(tag) {
  const dir = path.join(ROOT, tag)
  rmrf(dir)
  for (const d of ['chats', 'multi-agent', 'session-chats']) fs.mkdirSync(path.join(dir, d), { recursive: true })
  fs.writeFileSync(path.join(dir, 'ui-prefs.json'), JSON.stringify({ 'workspace.mode': 'multi', 'api.mode': false, 'claude.outputStyle': 'Concise' }))
  const chats = ['c-1', 'c-2', 'c-3']
  chats.forEach((id, i) =>
    fs.writeFileSync(path.join(dir, 'chats', `${id}.json`), JSON.stringify({
      id, title: `채팅 ${i}`, custom: false, snapshot: snap(6 + i, `sess-${id}`), manualCwd: 'C:\\Code',
      refDirs: [], picker: { model: 'opus', effort: 'high', mode: 'auto', account: `u${i}@x.com` }, updatedAt: 1000 + i
    })))
  fs.writeFileSync(path.join(dir, 'chats', 'index.json'), JSON.stringify({ version: 1, order: chats, activeChatId: 'c-1' }))
  fs.writeFileSync(path.join(dir, 'multi-agent', 'sess-A.json'), JSON.stringify({
    id: 'sess-A', title: 'A', custom: false, count: 2, panelOrder: [0, 1, 2, 3, 4, 5],
    panels: [
      { title: 'P0', custom: false, cwd: 'C:\\Code', refDirs: [], picker: { model: 'opus', effort: 'high', mode: 'auto' }, api: false, snapshot: snap(5, 'sess-p0') },
      { title: 'P1', custom: false, cwd: 'C:\\Code', refDirs: [], picker: { model: 'sonnet', effort: 'low', mode: 'plan' }, api: true, snapshot: snap(4, 'sess-p1') }
    ]
  }))
  fs.writeFileSync(path.join(dir, 'multi-agent', 'sess-B.json'), JSON.stringify({
    id: 'sess-B', title: 'B', custom: false, count: 1, panelOrder: [0, 1, 2, 3, 4, 5],
    panels: [{ title: 'Q0', custom: false, cwd: 'C:\\Code', refDirs: [], picker: { model: 'opus', effort: 'high', mode: 'auto' }, snapshot: snap(7, 'sess-q0') }]
  }))
  fs.writeFileSync(path.join(dir, 'multi-agent', 'index.json'), JSON.stringify({ version: 2, order: ['sess-A', 'sess-B'], activeSessionId: 'sess-A' }))
  const scs = ['w-1', 'w-2']
  scs.forEach((id, i) =>
    fs.writeFileSync(path.join(dir, 'session-chats', `${id}.json`), JSON.stringify({
      id, title: `추가 ${i}`, status: 'done', cwd: 'C:\\Code', snapshot: snap(3 + i, `sess-${id}`), picker: {}, updatedAt: 5
    })))
  fs.writeFileSync(path.join(dir, 'session-chats', 'index.json'), JSON.stringify({ version: 1, order: scs }))
  cli(dir, ['migrate', '--no-backup'])
  return dir
}

const threads = (dir) => {
  const m = new Map()
  for (const [id, u] of v3Units(dir).units) m.set(id, u.threadBytes)
  return m
}
const lostSince = (dir, base) => {
  const now = threads(dir)
  const out = []
  for (const [id, h] of base) {
    if (!now.has(id)) out.push({ id, why: '파일 사라짐' })
    else if (now.get(id) !== h) out.push({ id, why: '스레드 바뀜' })
  }
  return out
}

const rep = { at: new Date().toISOString(), checks: {} }

// ── A. unloaded 마커 ────────────────────────────────────────────────────────
{
  const dir = home('A-marker')
  const base = threads(dir)
  const full = cli(dir, ['read-chats']).json
  const markers = { version: 1, activeChatId: full.activeChatId, chats: full.chats.map((c) => ({ id: c.id, origin: c.origin, title: c.title, custom: c.custom, unloaded: true, snapshot: null })) }
  cli(dir, ['save-chats', payloadFile(markers)])
  const lost = lostSince(dir, base)
  rep.checks.markerMerge = { chats: base.size, lost }
  if (lost.length) F('A. unloaded 마커 저장이 대화를 지웠다', { lost })
}

// ── B. Rust 소유 3필드 ──────────────────────────────────────────────────────
{
  const dir = home('B-owned')
  const base = threads(dir)
  const full = cli(dir, ['read-chats']).json
  const fake = {
    version: 1, activeChatId: full.activeChatId,
    chats: full.chats.map((c) => ({
      ...c,
      identity: { engine: { kind: 'claude', model: 'STALE', effort: 'low', codexAccount: null }, billing: { kind: 'subscription', account: null, dropEnvKey: false }, cwd: 'C:\\STALE', addDirs: [], mode: 'normal', systemPrompt: null, outputStyle: null, tools: { skillOverrides: {}, deniedMcp: [] } },
      queue: [{ id: 'fake', text: '위조' }],
      hold: { key: c.id, engine: 'claude', resetsAt: 9, at: Date.now(), lastPrompt: '위조' }
    }))
  }
  cli(dir, ['save-chats', payloadFile(fake)])
  const after = v3Units(dir)
  const adopted = [...after.units.values()].filter((u) => u.identity?.cwd === 'C:\\STALE' || (u.queue ?? []).length || u.hold)
  rep.checks.ownedForgery = { chats: base.size, adopted: adopted.map((u) => u.id), lost: lostSince(dir, base) }
  if (adopted.length) F('B1. 위조된 소유 3필드가 채택됐다', { ids: adopted.map((u) => u.id) })

  // B2 — 런타임(set_owned)이 세운 정체성 vs **별칭 번역**(옛 picker가 실린 저장)
  const victim = [...after.units.keys()].find((id) => after.units.get(id).origin === 'chat')
  const runtimeIdentity = {
    engine: { kind: 'claude', model: 'sonnet', effort: 'low', codexAccount: null }, // 폴백으로 바뀐 값
    billing: { kind: 'subscription', account: 'fallback@x.com', dropEnvKey: false },
    cwd: 'C:\\Code', addDirs: [], mode: 'auto', systemPrompt: null, outputStyle: 'Concise',
    tools: { skillOverrides: {}, deniedMcp: [] }
  }
  // ★ 순서가 전부다: 렌더러는 **폴백 이전에** 목록을 읽어 두고, 디바운스가 끝난 뒤 되보낸다.
  const staleCopy = cli(dir, ['alias-chats-get']).json // ← 폴백 전 사본(낡은 picker)
  cli(dir, ['set-owned', victim, 'identity', payloadFile(runtimeIdentity)]) // 턴 중 폴백
  cli(dir, ['alias-chats-save', payloadFile(staleCopy)]) // 낡은 사본의 디바운스 저장
  const idAfter = v3Units(dir).units.get(victim)?.identity
  const runtimeWon = canon(idAfter) === canon(runtimeIdentity)
  rep.checks.p3Regression = { chatId: victim, runtimeWon, runtime: runtimeIdentity, onDisk: idAfter, stalePicker: (staleCopy.chats ?? []).find((c) => c.id === victim)?.picker ?? null }
  if (!runtimeWon) F('B2. 낡은 렌더러 사본이 런타임 정체성을 되돌렸다(P3 재발)', { chatId: victim, expect: runtimeIdentity, got: idAfter })

  // B3 — 그 뒤 **읽은 사본**(폴백 후)으로 저장하면 되돌지 않는가(대조군)
  const freshCopy = cli(dir, ['alias-chats-get']).json
  cli(dir, ['set-owned', victim, 'identity', payloadFile({ ...runtimeIdentity, engine: { ...runtimeIdentity.engine, model: 'haiku' } })])
  cli(dir, ['alias-chats-save', payloadFile(freshCopy)])
  rep.checks.p3Control = { onDisk: v3Units(dir).units.get(victim)?.identity?.engine?.model ?? null, expect: 'haiku' }
  if (rep.checks.p3Control.onDisk !== 'haiku') F('B3. 폴백 이후 저장도 정체성을 되돌린다', rep.checks.p3Control)
}

// ── C. prune — origin 칸 ───────────────────────────────────────────────────
{
  const dir = home('C-prune')
  const base = threads(dir)
  // C1: 본채팅 목록만 담은 chats:save
  const cg = cli(dir, ['alias-chats-get']).json
  rep.checks.aliasChatsList = { ids: (cg.chats ?? []).map((c) => c.id) }
  cli(dir, ['alias-chats-save', payloadFile(cg)])
  const l1 = lostSince(dir, base)
  if (l1.length) F('C1. 본채팅 저장이 남의 칸을 지웠다', { lost: l1 })

  // C2: 본채팅 하나를 지운 페이로드 → 그 하나만 사라져야 한다
  const drop = cg.chats[1].id
  cli(dir, ['alias-chats-save', payloadFile({ ...cg, chats: cg.chats.filter((c) => c.id !== drop) })])
  const l2 = lostSince(dir, base)
  rep.checks.prunePrecision = { dropped: drop, lost: l2.map((x) => x.id) }
  if (l2.length !== 1 || l2[0].id !== drop) F('C2. prune 범위가 틀렸다', { expect: [drop], got: l2 })

  // C3: origin 필드가 **없는** 레코드는 남의 칸이어도 지워진다
  const dir3 = home('C3-noorigin')
  const b3 = threads(dir3)
  const scId = [...v3Units(dir3).units.values()].find((u) => u.origin === 'session')?.id
  const f = path.join(dir3, 'chats-v3', `${scId}.json`)
  const rec = readJSON(f)
  delete rec.origin // 3.0이 만든 채팅·미래의 다른 저자·수동 편집 — origin이 없는 레코드
  fs.writeFileSync(f, JSON.stringify(rec))
  const cg3 = cli(dir3, ['alias-chats-get']).json
  cli(dir3, ['alias-chats-save', payloadFile(cg3)])
  const l3 = lostSince(dir3, b3)
  rep.checks.originMissing = {
    chatId: scId,
    lost: l3.map((x) => x.id),
    survived: !l3.length,
    // origin이 없으면 **본채팅 목록에 섞여 들어간다**(origin_of의 기본값이 'chat')
    leakedIntoMainList: (cg3.chats ?? []).some((c) => c.id === scId)
  }
  if (l3.length) F('C3. origin 없는 레코드가 본채팅 저장 한 번에 삭제됐다', { chatId: scId, lost: l3 })
  if (rep.checks.originMissing.leakedIntoMainList) F('C3b. origin 없는 레코드가 본채팅 목록으로 샜다', { chatId: scId })

  // C3c: **Rust가 만든**(origin 없는) 채팅 + 그것을 모르는 낡은 렌더러 목록 → prune?
  const dir3c = home('C3c-rustmade')
  const b3c = threads(dir3c)
  const staleList = cli(dir3c, ['alias-chats-get']).json // ← Rust가 만들기 **전** 사본
  const newFile = path.join(dir3c, 'chats-v3', 'rust-made.json')
  fs.writeFileSync(newFile, JSON.stringify({ id: 'rust-made', title: 'M-LOGIC이 만든 채팅', custom: false, snapshot: snap(9, 'sess-rust') }))
  const idx3c = readJSON(path.join(dir3c, 'chats-v3', 'index.json'))
  idx3c.order.push('rust-made')
  fs.writeFileSync(path.join(dir3c, 'chats-v3', 'index.json'), JSON.stringify(idx3c))
  cli(dir3c, ['alias-chats-save', payloadFile(staleList)])
  const survived3c = fs.existsSync(newFile)
  rep.checks.rustMadeChatPruned = { survived: survived3c, lostOthers: lostSince(dir3c, b3c).map((x) => x.id) }
  if (!survived3c) F('C3c. Rust가 만든 채팅(origin 없음)이 낡은 렌더러 저장 한 번에 삭제됐다', rep.checks.rustMadeChatPruned)

  // C4: ma:save가 **일부 세션만** 담아 왔을 때 다른 보드의 패널
  const dir4 = home('C4-masubset')
  const b4 = threads(dir4)
  const ma = cli(dir4, ['alias-ma-get']).json
  const one = { ...ma, sessions: ma.sessions.filter((s) => s.id === 'sess-A') }
  cli(dir4, ['alias-ma-save', payloadFile(one)])
  const l4 = lostSince(dir4, b4)
  const boardsAfter = cli(dir4, ['read-boards']).json
  rep.checks.maSubsetSave = { lost: l4.map((x) => x.id), boards: (boardsAfter?.boards ?? []).map((b) => b.id) }
  if (l4.length) F('C4. ma:save가 페이로드에 없는 세션의 패널 대화를 지웠다', { lost: l4, boards: rep.checks.maSubsetSave.boards })

  // C5: 마커 세션(unloaded)이 실려 와도 패널이 남는가
  const dir5 = home('C5-masession-marker')
  const b5 = threads(dir5)
  const ma5 = cli(dir5, ['alias-ma-get', '--light']).json
  cli(dir5, ['alias-ma-save', payloadFile(ma5)])
  const l5 = lostSince(dir5, b5)
  rep.checks.maMarkerSave = { markerSessions: (ma5?.sessions ?? []).filter((s) => s.unloaded).map((s) => s.id), lost: l5.map((x) => x.id) }
  if (l5.length) F('C5. 마커 세션 저장이 패널 대화를 지웠다', { lost: l5 })
}

// ── D. 멱등 — 별칭 왕복 3회 ─────────────────────────────────────────────────
{
  const dir = home('D-idem')
  const base = threads(dir)
  const snapshots = []
  for (let i = 0; i < 3; i++) {
    const cg = cli(dir, ['alias-chats-get']).json
    cli(dir, ['alias-chats-save', payloadFile(cg)])
    const ma = cli(dir, ['alias-ma-get']).json
    if (ma) cli(dir, ['alias-ma-save', payloadFile(ma)])
    snapshots.push(sha(canon({ chats: cli(dir, ['read-chats']).json, boards: cli(dir, ['read-boards']).json })))
  }
  const stable = snapshots[0] === snapshots[1] && snapshots[1] === snapshots[2]
  rep.checks.aliasIdempotent = { stable, snapshots, lost: lostSince(dir, base).map((x) => x.id) }
  if (!stable) F('D. 별칭 왕복이 멱등하지 않다(매 왕복마다 스토어가 바뀐다)', { snapshots })
  const lostD = lostSince(dir, base)
  if (lostD.length) F('D. 별칭 왕복 3회가 대화를 지웠다', { lost: lostD })
}

// ── E. status.json 재구성 ───────────────────────────────────────────────────
{
  const dir = home('E-status')
  const sfile = path.join(dir, 'chats-v3', 'status.json')
  const truth = readJSON(sfile)?.statuses ?? {}
  const withFile = cli(dir, ['status']).json
  // hold·큐를 하나 심고 재구성 정확도를 본다
  const victim = Object.keys(truth)[0]
  cli(dir, ['set-owned', victim, 'hold', payloadFile({ key: victim, engine: 'claude', resetsAt: 1_800_000_000, at: Date.now(), lastPrompt: '이어서' })])
  cli(dir, ['set-owned', victim, 'queue', payloadFile([{ id: 'q1', text: '대기' }, { id: 'q2', text: '대기2' }])])
  const before = cli(dir, ['status']).json

  fs.rmSync(sfile)
  const deleted = cli(dir, ['status']).json
  fs.writeFileSync(sfile, '{"version":1,"statuses":{')
  const corrupt = cli(dir, ['status']).json
  // 반쪽 쓰기 — status.json은 낡았고 <chatId>.json이 진짜
  fs.writeFileSync(sfile, JSON.stringify({ version: 1, statuses: { ...truth, [victim]: { ...truth[victim], queued: 99, hold: { resetAt: 1, ready: true }, status: 'working', busy: true, ask: 'permission', bgActive: true } } }))
  const halfWritten = cli(dir, ['status']).json

  const statusOf = (s) => Object.fromEntries(Object.entries(s?.statuses ?? {}).map(([k, v]) => [k, v.status]))
  rep.checks.statusRebuild = {
    withFile: statusOf(withFile),
    afterDelete: statusOf(deleted),
    afterCorrupt: statusOf(corrupt),
    statusLostOnRebuild: canon(statusOf(withFile)) !== canon(statusOf(deleted)),
    candidatesWithFile: before.reloadCandidates,
    candidatesAfterDelete: deleted.reloadCandidates,
    candidatesAfterCorrupt: corrupt.reloadCandidates,
    halfWrittenLite: halfWritten?.statuses?.[victim] ?? null,
    bootForced: {
      busy: halfWritten?.statuses?.[victim]?.busy,
      ask: halfWritten?.statuses?.[victim]?.ask,
      bgActive: halfWritten?.statuses?.[victim]?.bgActive,
      status: halfWritten?.statuses?.[victim]?.status,
      queued: halfWritten?.statuses?.[victim]?.queued,
      hold: halfWritten?.statuses?.[victim]?.hold
    }
  }
  if (canon(deleted.reloadCandidates) !== canon(before.reloadCandidates)) F('E1. status.json 삭제 후 재장전 후보가 달라졌다', rep.checks.statusRebuild)
  if (rep.checks.statusRebuild.statusLostOnRebuild) F('E2. status.json 재구성이 얼려둔 status를 잃는다(전부 idle)', { withFile: rep.checks.statusRebuild.withFile, afterDelete: rep.checks.statusRebuild.afterDelete })
  const hw = rep.checks.statusRebuild.bootForced
  if (hw.queued !== 2 || hw.hold?.resetAt !== 1_800_000_000) F('E3. 반쪽 쓰기에서 <chatId>.json이 이기지 않았다', hw)

  // index.json이 깨지면?
  const idxf = path.join(dir, 'chats-v3', 'index.json')
  const idxRaw = fs.readFileSync(idxf, 'utf8')
  fs.writeFileSync(idxf, idxRaw.slice(0, 20))
  const brokenIdx = {
    status: cli(dir, ['status']).json,
    readChats: cli(dir, ['read-chats']).json,
    aliasChatsGet: cli(dir, ['alias-chats-get']).json,
    filesOnDisk: fs.readdirSync(path.join(dir, 'chats-v3')).filter((f) => f.endsWith('.json')).length
  }
  rep.checks.brokenIndex = {
    filesOnDisk: brokenIdx.filesOnDisk,
    statusesSeen: Object.keys(brokenIdx.status?.statuses ?? {}).length,
    readChatsNull: brokenIdx.readChats === null,
    aliasChatsNull: brokenIdx.aliasChatsGet === null
  }
  if (brokenIdx.readChats === null) F('E4. chats-v3/index.json이 깨지면 전 대화가 조회에서 사라진다', rep.checks.brokenIndex)

  // 그 상태에서 렌더러가 새 채팅 하나를 저장하면?
  const newChat = { version: 1, activeChatId: 'brand-new', chats: [{ id: 'brand-new', title: '새 채팅', custom: false, snapshot: snap(1, 'sess-new'), picker: {}, manualCwd: '' }] }
  cli(dir, ['alias-chats-save', payloadFile(newChat)])
  const survivors = fs.readdirSync(path.join(dir, 'chats-v3')).filter((f) => f.endsWith('.json') && f !== 'index.json' && f !== 'status.json')
  rep.checks.brokenIndexThenSave = { survivors, wiped: brokenIdx.filesOnDisk - survivors.length }
  if (survivors.length <= 1) F('E5. index.json 손상 후 저장 한 번이 chats-v3의 모든 대화 파일을 지웠다', rep.checks.brokenIndexThenSave)
}

// ── F. set-active vs 디바운스 저장 ──────────────────────────────────────────
{
  const dir = home('F-active')
  const ids = [...v3Units(dir).units.keys()]
  const target = ids.find((i) => i !== readJSON(path.join(dir, 'chats-v3', 'index.json')).activeChatId)
  const sa = cli(dir, ['set-active', target]).json
  const onDisk = readJSON(path.join(dir, 'chats-v3', 'index.json'))?.activeChatId
  // 이제 **낡은** activeChatId를 실은 디바운스 저장이 도착한다(2.6.2 렌더러는 항상 싣는다)
  const cg = cli(dir, ['alias-chats-get']).json
  cli(dir, ['alias-chats-save', payloadFile({ ...cg, activeChatId: 'c-1' })])
  const after = readJSON(path.join(dir, 'chats-v3', 'index.json'))?.activeChatId
  rep.checks.setActive = { target, immediate: onDisk, afterStaleSave: after, overwritten: after !== target }
  if (sa?.ok !== true || onDisk !== target) F('F1. set-active가 즉시 반영되지 않았다', rep.checks.setActive)
  if (after !== target) F('F2. 낡은 chats:save가 set-active를 덮었다(activeChat 오배선 창)', rep.checks.setActive)
}

rep.findings = findings
rep.ok = findings.length === 0
const out = writeResult('m2-r1-semantics.json', rep)
console.log(JSON.stringify({ ok: rep.ok, findings: findings.map((f) => f.item) }, null, 2), out)
rmrf(ROOT)
process.exit(0)
