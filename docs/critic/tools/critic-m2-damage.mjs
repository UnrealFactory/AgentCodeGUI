#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// critic-m2-damage — **손상 홈 공격**. 마이그레이션이 각 손상에 대해
// [드랍 없이 보존 / 명시적 unresolved / 조용한 드랍 / 크래시] 중 무엇을 하는가.
//
// 판정 기준(§5.2 "조용한 값 보정이 가장 위험한 마이그레이션 버그다"의 대우):
//   silent-drop = 대화가 사라졌는데 warnings/에러 어디에도 흔적이 없다 → **불합격**
//   reported-drop = 사라졌지만 warnings에 사유가 남는다 → 허용(사용자 통지 가능)
//   preserved = 그대로 옮겨졌다 → 최선
//   crash = 비영 종료 / 패닉 → 불합격(마이그레이션이 안 끝나면 앱이 못 뜬다)
//
//   node docs/critic/tools/critic-m2-damage.mjs
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { canon, cli, readJSON, rmrf, sha, v3Units, writeResult } from './critic-m2-lib.mjs'

const ROOT = path.join(os.tmpdir(), `ccg-critic-m2-damage-${Date.now()}`)

const snap = (n, sid) => ({
  status: 'idle',
  messages: Array.from({ length: n }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', text: `줄 ${i} ${'가'.repeat(20)}`, animate: false })),
  todos: [], files: [], diffs: {}, terminal: [], subagents: [], bgTasks: [], workflows: [],
  pendingPermission: null, pendingQuestion: null,
  session: sid ? { sessionId: sid, model: 'opus', cwd: 'C:\\Code' } : null,
  result: null, spentUsd: 0, tokenTotals: {}, streaming: false, seq: n, shownNotices: []
})

/** 정상 베이스 홈 — 채팅 3 / 세션 1(패널 2) / 추가 채팅 2. */
function baseHome(dir, { prefs = {} } = {}) {
  rmrf(dir)
  for (const d of ['chats', 'multi-agent', 'session-chats']) fs.mkdirSync(path.join(dir, d), { recursive: true })
  fs.writeFileSync(path.join(dir, 'ui-prefs.json'), JSON.stringify({ 'workspace.mode': 'single', 'api.mode': false, ...prefs }))
  const chats = ['c-aaa', 'c-bbb', 'c-ccc']
  chats.forEach((id, i) =>
    fs.writeFileSync(path.join(dir, 'chats', `${id}.json`), JSON.stringify({
      id, title: `채팅 ${i}`, custom: false, snapshot: snap(4 + i, `sess-${id}`),
      manualCwd: 'C:\\Code', refDirs: [], picker: { model: 'opus', effort: 'high', mode: 'auto' }, updatedAt: 1_700_000_000_000 + i
    })))
  fs.writeFileSync(path.join(dir, 'chats', 'index.json'), JSON.stringify({ version: 1, order: chats, activeChatId: 'c-aaa' }))
  fs.writeFileSync(path.join(dir, 'multi-agent', 's-1.json'), JSON.stringify({
    id: 's-1', title: '세션', custom: false, count: 2, panelOrder: [0, 1, 2, 3, 4, 5],
    panels: [
      { title: '패널0', custom: false, cwd: 'C:\\Code', refDirs: [], picker: { model: 'opus', effort: 'high', mode: 'auto' }, snapshot: snap(3, 'sess-p0') },
      { title: '패널1', custom: false, cwd: 'C:\\Code', refDirs: [], picker: { model: 'opus', effort: 'high', mode: 'auto' }, snapshot: snap(2, 'sess-p1') }
    ]
  }))
  fs.writeFileSync(path.join(dir, 'multi-agent', 'index.json'), JSON.stringify({ version: 2, order: ['s-1'], activeSessionId: 's-1' }))
  const scs = ['s-xxx', 's-yyy']
  scs.forEach((id, i) =>
    fs.writeFileSync(path.join(dir, 'session-chats', `${id}.json`), JSON.stringify({
      id, title: `추가 ${i}`, status: 'done', cwd: 'C:\\Code', refDirs: [], snapshot: snap(2, `sess-${id}`), picker: {}, updatedAt: 1
    })))
  fs.writeFileSync(path.join(dir, 'session-chats', 'index.json'), JSON.stringify({ version: 1, order: scs }))
  return dir
}

/** 읽을 수 없는(손상) 원본 파일 목록 — "조용히 건너뛰는가"의 판정 대상. */
function brokenSources(dir) {
  const out = []
  for (const d of ['chats', 'multi-agent', 'session-chats']) {
    const p = path.join(dir, d)
    if (!fs.existsSync(p)) continue
    for (const n of fs.readdirSync(p)) {
      if (!n.endsWith('.json')) continue
      if (readJSON(path.join(p, n)) === null) out.push(`${d}/${n}`)
    }
  }
  return out
}

/** 홈에 남아 있는 **모든** 원본 대화(파일 기준) → 스레드 해시 집합. */
function sourceThreads(dir) {
  const out = new Map()
  const add = (k, ms) => out.set(k, sha(canon(ms ?? [])))
  for (const n of fs.existsSync(path.join(dir, 'chats')) ? fs.readdirSync(path.join(dir, 'chats')) : []) {
    if (!n.endsWith('.json') || n === 'index.json') continue
    const r = readJSON(path.join(dir, 'chats', n))
    if (r) add(`chat:${n.slice(0, -5)}`, r.snapshot?.messages)
  }
  for (const n of fs.existsSync(path.join(dir, 'multi-agent')) ? fs.readdirSync(path.join(dir, 'multi-agent')) : []) {
    if (!n.endsWith('.json') || n === 'index.json') continue
    const r = readJSON(path.join(dir, 'multi-agent', n))
    const sid = n.slice(0, -5)
    ;(Array.isArray(r?.panels) ? r.panels : []).forEach((p, i) => {
      if (!(p?.title || (p?.snapshot?.messages ?? []).length)) return
      add(`panel:${sid}::${i}`, p.snapshot?.messages)
    })
  }
  for (const n of fs.existsSync(path.join(dir, 'session-chats')) ? fs.readdirSync(path.join(dir, 'session-chats')) : []) {
    if (!n.endsWith('.json') || n === 'index.json') continue
    const r = readJSON(path.join(dir, 'session-chats', n))
    if (r) add(`sc:${n.slice(0, -5)}`, r.snapshot?.messages)
  }
  return out
}

function afterThreads(dir) {
  const { units } = v3Units(dir)
  const set = new Set()
  for (const u of units.values()) if (u.parseOk) set.add(u.threadBytes)
  return set
}

const cases = []
const add = (name, build, judge) => cases.push({ name, build, judge })

// 1. 잘린 JSON — 채팅 파일
add('잘린 채팅 JSON', (d) => {
  baseHome(d)
  const p = path.join(d, 'chats', 'c-bbb.json')
  const raw = fs.readFileSync(p, 'utf8')
  fs.writeFileSync(p, raw.slice(0, Math.floor(raw.length * 0.6)))
})

// 2. 잘린 index.json — 목록 자체가 깨졌다
add('잘린 chats/index.json', (d) => {
  baseHome(d)
  const p = path.join(d, 'chats', 'index.json')
  const raw = fs.readFileSync(p, 'utf8')
  fs.writeFileSync(p, raw.slice(0, 12))
})

// 3. 인코딩 깨짐 — UTF-8이 아닌 바이트가 섞인 파일
add('인코딩 깨짐(UTF-8 아님)', (d) => {
  baseHome(d)
  const p = path.join(d, 'chats', 'c-ccc.json')
  const buf = Buffer.from(fs.readFileSync(p))
  const bad = Buffer.concat([buf.subarray(0, 40), Buffer.from([0xff, 0xfe, 0x80, 0x81]), buf.subarray(44)])
  fs.writeFileSync(p, bad)
})

// 4. 순환 참조 btwOf (A↔B, 자기 자신)
add('순환 참조 btwOf', (d) => {
  baseHome(d)
  const w = (id, btwOf) =>
    fs.writeFileSync(path.join(d, 'session-chats', `${id}.json`), JSON.stringify({ id, title: id, status: 'done', cwd: '', snapshot: snap(2, `sess-${id}`), btwOf }))
  w('cyc-a', 'cyc-b')
  w('cyc-b', 'cyc-a')
  w('cyc-self', 'cyc-self')
  fs.writeFileSync(path.join(d, 'session-chats', 'index.json'), JSON.stringify({ version: 1, order: ['s-xxx', 's-yyy', 'cyc-a', 'cyc-b', 'cyc-self'] }))
})

// 5. 거대 첨부 — 32MB 문자열이 스냅샷에 박혀 있다
add('거대 첨부(32MB)', (d) => {
  baseHome(d)
  const big = 'A'.repeat(32 * 1024 * 1024)
  const p = path.join(d, 'chats', 'c-aaa.json')
  const rec = readJSON(p)
  rec.snapshot.messages.push({ id: 'big', role: 'user', text: '이미지', images: [big] })
  fs.writeFileSync(p, JSON.stringify(rec))
})

// 6. 중복 chatId — chats/ 와 session-chats/ 에 같은 id + 그 id를 가리키는 btwOf·hold
add('중복 chatId(본채팅 ↔ 추가 채팅)', (d) => {
  baseHome(d, { prefs: { 'limitResume.hold': { key: 'c-aaa', engine: 'claude', resetsAt: 2_000_000_000_000, at: Date.now(), lastPrompt: '이어서' } } })
  const dup = readJSON(path.join(d, 'session-chats', 's-xxx.json'))
  dup.id = 'c-aaa'
  dup.title = '중복 id 추가 채팅'
  fs.writeFileSync(path.join(d, 'session-chats', 'c-aaa.json'), JSON.stringify(dup))
  fs.writeFileSync(path.join(d, 'session-chats', 's-yyy.json'), JSON.stringify({
    id: 's-yyy', title: 'btw 자식', status: 'done', cwd: '', snapshot: snap(2, 'sess-yyy'), btwOf: 'c-aaa'
  }))
  fs.writeFileSync(path.join(d, 'session-chats', 'index.json'), JSON.stringify({ version: 1, order: ['c-aaa', 's-yyy'] }))
})

// 7. 존재하지 않는 세션/채팅 참조
add('존재하지 않는 세션 참조', (d) => {
  baseHome(d)
  fs.writeFileSync(path.join(d, 'multi-agent', 'index.json'), JSON.stringify({ version: 2, order: ['s-1', 's-gone', 's-also-gone'], activeSessionId: 's-gone' }))
  fs.writeFileSync(path.join(d, 'session-chats', 's-yyy.json'), JSON.stringify({
    id: 's-yyy', title: '고아 btw', status: 'done', cwd: '', snapshot: snap(2, 'sess-yyy'), btwOf: 's-gone::3'
  }))
})

// 8. 인덱스에 없는 채팅 파일(= 인덱스 반쪽 쓰기 후)
add('인덱스에 없는 채팅 파일', (d) => {
  baseHome(d)
  fs.writeFileSync(path.join(d, 'chats', 'index.json'), JSON.stringify({ version: 1, order: ['c-aaa', 'c-bbb'], activeChatId: 'c-aaa' }))
  // c-ccc.json 은 디스크에 그대로 남아 있다(대화 5줄)
})

// 9. 경로 탈출 id
add('경로 탈출 id', (d) => {
  baseHome(d)
  const idx = readJSON(path.join(d, 'chats', 'index.json'))
  idx.order.push('..\\..\\evil', '../../evil2')
  fs.writeFileSync(path.join(d, 'chats', 'index.json'), JSON.stringify(idx))
})

// 10. 깊은 중첩(serde 재귀 한도)
add('깊은 중첩 JSON(1000단)', (d) => {
  baseHome(d)
  let deep = '1'
  for (let i = 0; i < 1000; i++) deep = `[${deep}]`
  const p = path.join(d, 'chats', 'c-bbb.json')
  const rec = readJSON(p)
  fs.writeFileSync(p, JSON.stringify(rec).replace('"todos":[]', `"todos":${deep}`))
})

// 11. 패널 결정론 id와 충돌하는 본채팅 id
add('본채팅 id가 패널 id와 충돌', (d) => {
  baseHome(d)
  const rec = readJSON(path.join(d, 'chats', 'c-bbb.json'))
  rec.id = 'ma-s-1-0'
  rec.title = '패널 id를 쓴 본채팅'
  fs.writeFileSync(path.join(d, 'chats', 'ma-s-1-0.json'), JSON.stringify(rec))
  fs.rmSync(path.join(d, 'chats', 'c-bbb.json'))
  fs.writeFileSync(path.join(d, 'chats', 'index.json'), JSON.stringify({ version: 1, order: ['c-aaa', 'ma-s-1-0', 'c-ccc'], activeChatId: 'c-aaa' }))
})

// 12. 손상된 ui-prefs / mcp / skills (전역 물질화 소스가 깨졌다)
add('전역 pref 파일 손상', (d) => {
  baseHome(d)
  fs.writeFileSync(path.join(d, 'ui-prefs.json'), '{"api.mode": tru')
  fs.writeFileSync(path.join(d, 'mcp.json'), '{{{')
  fs.writeFileSync(path.join(d, 'skills.json'), '[1,2,3]')
})

// 13. api.mode=true + 채팅별 계정 — 매핑이 계정을 버리는가(무손실 주장 공격)
add('api.mode=true에서 채팅별 계정', (d) => {
  baseHome(d, { prefs: { 'api.mode': true } })
  const p = path.join(d, 'chats', 'c-aaa.json')
  const rec = readJSON(p)
  rec.picker = { model: 'fable', effort: 'max', mode: 'plan', account: 'me@example.com' }
  fs.writeFileSync(p, JSON.stringify(rec))
  const q = path.join(d, 'chats', 'c-bbb.json')
  const r2 = readJSON(q)
  r2.picker = { model: 'opus', effort: 'high', mode: 'auto', engine: 'codex', codexModel: 'gpt-5.6-sol', account: 'sub@example.com' }
  fs.writeFileSync(q, JSON.stringify(r2))
})

// 14. 손상된 ui-prefs가 **틀린 전역값**을 굳히는가(조용한 값 보정 금지 규약 공격)
add('손상 ui-prefs가 전역값을 뒤집음', (d) => {
  baseHome(d, { prefs: { 'api.mode': true, 'claude.outputStyle': 'Explanatory' } })
  const p = path.join(d, 'ui-prefs.json')
  const raw = fs.readFileSync(p, 'utf8')
  fs.writeFileSync(p, raw.slice(0, raw.length - 3)) // 꼬리만 잘린 JSON
})

// 15. chat-talk.json의 id가 본채팅과 겹칠 때 idMap이 덮이는가
add('chat-talk id 중복', (d) => {
  baseHome(d)
  fs.writeFileSync(path.join(d, 'chat-talk.json'), JSON.stringify({
    version: 1, activeChatId: 'c-aaa',
    chats: [{ id: 'c-aaa', title: '옛 채팅 모드', custom: false, snapshot: snap(3, 'sess-talk'), picker: {} }]
  }))
  fs.writeFileSync(path.join(d, 'session-chats', 's-yyy.json'), JSON.stringify({
    id: 's-yyy', title: 'btw 자식', status: 'done', cwd: '', snapshot: snap(2, 'sess-yyy'), btwOf: 'c-aaa'
  }))
})

function judgeDefault(dir, before, mig) {
  const after = afterThreads(dir)
  const lost = []
  for (const [k, h] of before) if (!after.has(h)) lost.push(k)
  const warns = mig.json?.warnings ?? []
  return { lost, warnCount: warns.length, warns: warns.slice(0, 6) }
}

function main() {
  fs.mkdirSync(ROOT, { recursive: true })
  const rep = { at: new Date().toISOString(), root: ROOT, cases: [] }
  for (const c of cases) {
    const dir = path.join(ROOT, c.name.replace(/[^\w가-힣]+/g, '_'))
    c.build(dir)
    const before = sourceThreads(dir)
    const broken = brokenSources(dir)
    const t0 = Date.now()
    const mig = cli(dir, ['migrate', '--no-backup'], { timeout: 240_000 })
    const ms = Date.now() - t0
    const crashed = mig.status !== 0 || mig.json === null
    const j = crashed ? { lost: [...before.keys()], warnCount: 0, warns: [] } : judgeDefault(dir, before, mig)
    const v3 = fs.existsSync(path.join(dir, 'chats-v3')) ? v3Units(dir) : null
    const entry = {
      case: c.name,
      elapsedMs: ms,
      exit: mig.status,
      crashed,
      stderr: crashed ? mig.stderr.slice(0, 400) : undefined,
      sourceThreads: before.size,
      v3Files: v3 ? v3.units.size : 0,
      v3Order: v3 ? v3.order.length : 0,
      orphanFiles: v3?.orphanFiles ?? [],
      missingFiles: v3?.missingFiles ?? [],
      brokenSources: broken,
      lostThreads: j.lost,
      warnings: j.warns,
      verdict: crashed
        ? 'crash'
        : j.lost.length
          ? j.warnCount
            ? 'reported-drop'
            : 'silent-drop'
          : broken.length && !j.warnCount
            ? 'silent-skip(손상 원본 무통지)'
            : 'preserved'
    }
    // 케이스별 추가 관찰
    if (c.name.startsWith('중복 chatId')) {
      const u = v3?.units
      entry.detail = {
        holdOn: [...(u?.values() ?? [])].filter((x) => x.hold).map((x) => x.id),
        btwEdges: [...(u?.values() ?? [])].filter((x) => x.rec?.btwOf).map((x) => ({ child: x.id, parent: x.rec.btwOf })),
        ids: [...(u?.keys() ?? [])]
      }
    }
    if (c.name.startsWith('본채팅 id가 패널')) {
      entry.detail = {
        ids: [...(v3?.units.keys() ?? [])],
        orderHasDup: v3 ? v3.order.length !== new Set(v3.order).size : null,
        order: v3?.order ?? [],
        collidedRecord: v3?.units.get('ma-s-1-0')?.rec?.title ?? null,
        collidedMsgs: v3?.units.get('ma-s-1-0')?.msgs ?? null
      }
    }
    if (c.name.startsWith('api.mode=true')) {
      const a = v3?.units.get('c-aaa')?.identity
      const b = v3?.units.get('c-bbb')?.identity
      entry.detail = { cAaaBilling: a?.billing ?? null, cAaaEngine: a?.engine ?? null, cBbbBilling: b?.billing ?? null, cBbbEngine: b?.engine ?? null }
      // 계정이 어디에도 없으면 손실
      const gone = []
      if (JSON.stringify(v3?.units.get('c-aaa')?.rec ?? {}).indexOf('me@example.com') < 0) gone.push('me@example.com')
      if (JSON.stringify(v3?.units.get('c-bbb')?.rec ?? {}).indexOf('sub@example.com') < 0) gone.push('sub@example.com')
      entry.detail.accountsGone = gone
      if (gone.length && entry.verdict === 'preserved') entry.verdict = 'silent-leaf-drop'
    }
    if (c.name.startsWith('경로 탈출')) {
      entry.detail = { homeEntries: fs.readdirSync(dir), evilOutside: fs.existsSync(path.join(ROOT, 'evil.json')) || fs.existsSync(path.join(ROOT, 'evil2.json')) }
    }
    if (c.name.startsWith('전역 pref') || c.name.startsWith('손상 ui-prefs')) {
      const id = v3?.units.get('c-aaa')?.identity ?? null
      entry.detail = { billing: id?.billing ?? null, outputStyle: id?.outputStyle ?? null, expected: c.name.startsWith('손상') ? { billing: 'api_key', outputStyle: 'Explanatory' } : null }
      if (c.name.startsWith('손상 ui-prefs') && id?.billing?.kind !== 'api_key') entry.verdict = 'silent-value-flip'
    }
    if (c.name.startsWith('chat-talk id')) {
      entry.detail = {
        ids: [...(v3?.units.keys() ?? [])],
        btwEdges: [...(v3?.units.values() ?? [])].filter((x) => x.rec?.btwOf).map((x) => ({ child: x.id, parent: x.rec.btwOf }))
      }
    }
    rep.cases.push(entry)
    process.stdout.write(`  ${entry.verdict.padEnd(16)} ${c.name} (${ms}ms, 소실 ${entry.lostThreads.length})\n`)
  }
  rep.summary = rep.cases.reduce((m, c) => ((m[c.verdict] = (m[c.verdict] ?? 0) + 1), m), {})
  const out = writeResult('m2-r1-damage.json', rep)
  console.log(JSON.stringify(rep.summary), out)
  rmrf(ROOT)
}

main()
