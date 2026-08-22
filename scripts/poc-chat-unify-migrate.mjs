#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// poc-chat-unify-migrate — 3스토어(chats/·multi-agent/·session-chats/) → chats-v3
// **무손실 마이그레이션 검증 하네스**. 설계: docs/design/ux-chat-unify.md §5.
//
// 판정은 자기 채점이 아니다 — 이 스크립트는 사실만 모아 리포트에 적고, 하나라도
// 어긋나면 비영 종료한다(§5.4). 마이그레이터 본체는 흉내 내지 않고 **프로덕션 코드**를
// 부른다(crates/ccg-store, bin `ccg-migrate`) — 하네스가 자기 구현을 검사하면 무의미하다.
//
// 안전 규칙(§5.1) — 사용자 실홈은 읽기만:
//   · --home <경로> 필수(또는 --clone-from-real / --fixture / --synthetic)
//   · 대상이 os.homedir()/.agentcodegui 이면 즉시 거부
//   · 마이그레이터 실행 시 CCG_HOME=<대상>을 강제
//
// 사용:
//   node scripts/poc-chat-unify-migrate.mjs --clone-from-real
//   node scripts/poc-chat-unify-migrate.mjs --fixture          (bench 픽스처 홈 합성)
//   node scripts/poc-chat-unify-migrate.mjs --synthetic        (부하 픽스처 200/20×6/30)
//   node scripts/poc-chat-unify-migrate.mjs --home <경로>
//   (여러 개를 같이 줘도 된다 — 순서대로 다 돈다)
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXE = path.join(ROOT, 'target', 'debug', 'ccg-migrate.exe')
const SLOT_COUNT = 6
const REAL_HOME = path.join(os.homedir(), '.agentcodegui')

// ── 작은 도구들 ──────────────────────────────────────────────────────────────
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
const readJSON = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}
/** 정준 직렬화 — 키 정렬 + undefined 제거 + 배열 순서 보존.
 *  ★ updatedAt은 화이트리스트에 **없다**(§5.4) — 어긋나면 진짜 버그다. */
function canon(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v)
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']'
  const keys = Object.keys(v)
    .filter((k) => v[k] !== undefined)
    .sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'
}
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true })
/** 스토어와 무관한 무거운 폴더 — 복사에서 뺀다(엔진 설치본만 수백 MB다).
 *  마이그레이션이 읽는 것은 chats/·multi-agent/·session-chats/ + 홈의 JSON 몇 개뿐이다. */
const SKIP_CLONE = new Set(['engines', 'codex-engines', 'lsp', 'attachments', 'accounts', 'codex', 'shared', 'node_modules'])
function cpdir(src, dst, skipTop = false) {
  fs.mkdirSync(dst, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (skipTop && SKIP_CLONE.has(e.name)) continue
    const s = path.join(src, e.name)
    const d = path.join(dst, e.name)
    if (e.isDirectory()) cpdir(s, d)
    else if (e.isFile()) fs.copyFileSync(s, d)
  }
}
/** 디렉터리 전체의 내용 해시 — "옛 3디렉터리가 그대로인가"(롤백 검증)에 쓴다. */
function dirHash(dir) {
  if (!fs.existsSync(dir)) return 'ABSENT'
  const parts = []
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name)
      const r = rel + '/' + e.name
      if (e.isDirectory()) walk(p, r)
      else parts.push(r + ':' + sha(fs.readFileSync(p)))
    }
  }
  walk(dir, '')
  return sha(parts.join('\n'))
}

// ── 마이그레이터 CLI 호출 ────────────────────────────────────────────────────
function cli(home, args, { allowFail = false } = {}) {
  const r = spawnSync(EXE, args, { env: { ...process.env, CCG_HOME: home }, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
  if (r.status !== 0 && !allowFail) throw new Error(`ccg-migrate ${args[0]} 실패(${r.status}): ${r.stderr || r.stdout}`)
  try {
    return JSON.parse(r.stdout)
  } catch {
    if (allowFail) return null
    throw new Error(`ccg-migrate ${args[0]} 출력이 JSON이 아니다: ${r.stdout?.slice(0, 200)}`)
  }
}

// ── toRawIdentity 미러 (M-UX §4.2 매핑표에서 독립 구현) ──────────────────────
// Rust 구현(crates/ccg-store/src/raw_identity.rs)과 **같은 표를 보고 따로 쓴 것**이다.
// 두 구현이 어긋나면 1차 비교가 깨진다 = 매핑표 해석 차이를 잡는 그물.
const MODEL_IDS = ['fable', 'opus', 'sonnet', 'haiku']
const EFFORT_IDS = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal']
const MODE_IDS = ['normal', 'plan', 'acceptEdits', 'auto', 'bypass']
const OUTPUT_STYLES = ['Concise', 'Explanatory', 'Learning', 'Proactive']
const DEFAULT_PICKER = {
  chat: { model: 'opus', effort: 'xhigh', mode: 'auto' }, // App.tsx:76
  panel: { model: 'opus', effort: 'xhigh', mode: 'bypass' }, // MultiAgent.tsx:86
  session: { model: 'opus', effort: 'high', mode: 'auto' }, // SessionWindow.tsx:66
  talk: { model: 'opus', effort: 'xhigh', mode: 'auto' }
}

function readGlobals(home) {
  const prefs = readJSON(path.join(home, 'ui-prefs.json')) ?? {}
  const skills = readJSON(path.join(home, 'skills.json'))?.disabled ?? []
  const mcp = readJSON(path.join(home, 'mcp.json'))?.disabled ?? []
  const cfg = readJSON(path.join(home, 'api-config.json')) ?? {}
  const envKey = process.env.ANTHROPIC_API_KEY ?? ''
  let dropEnvKey = false
  if (envKey) {
    const fp = sha(envKey).slice(0, 12)
    const ans = cfg.envKeyChoices?.[fp]
    dropEnvKey = ans === 'sub' || ans === undefined // 미응답이면 안전값(구독)
  }
  return {
    apiMode: prefs['api.mode'] === true,
    outputStyle: OUTPUT_STYLES.includes(prefs['claude.outputStyle']) ? prefs['claude.outputStyle'] : null,
    disabledSkills: [...new Set(skills.filter((s) => typeof s === 'string'))].sort(),
    deniedMcp: [...new Set(mcp.filter((s) => typeof s === 'string'))].sort(),
    dropEnvKey,
    workspaceMulti: prefs['workspace.mode'] === 'multi',
    hold: prefs['limitResume.hold'] ?? null,
    hasApiKey: !!cfg.key
  }
}

function toRawIdentity(rec, source, g) {
  const p = rec.picker ?? {}
  const d = DEFAULT_PICKER[source]
  const pick = (k) => (typeof p[k] === 'string' && p[k] ? p[k] : null)
  const isCodex = pick('engine') === 'codex'
  const model = isCodex ? (pick('codexModel') ?? '') : MODEL_IDS.includes(pick('model')) ? p.model : d.model
  const effort = EFFORT_IDS.includes(pick('effort')) ? p.effort : d.effort
  const mode = MODE_IDS.includes(pick('mode')) ? p.mode : d.mode
  const api = source === 'panel' ? (typeof rec.api === 'boolean' ? rec.api : g.apiMode) : g.apiMode
  const billing = api
    ? { kind: 'api_key' }
    : { kind: 'subscription', account: pick('account'), dropEnvKey: g.dropEnvKey }
  const cwd = source === 'chat' ? (rec.manualCwd ?? '') : source === 'talk' ? '' : (rec.cwd ?? '')
  const addDirs = Array.isArray(rec.refDirs) ? rec.refDirs.filter((s) => typeof s === 'string' && s).slice(0, 8) : []
  const skillOverrides = {}
  for (const s of g.disabledSkills) skillOverrides[s] = 'disabled'
  return {
    engine: { kind: isCodex ? 'codex' : 'claude', model, effort, codexAccount: isCodex ? pick('codexAccount') : null },
    billing,
    cwd,
    addDirs,
    mode,
    systemPrompt: null,
    outputStyle: g.outputStyle,
    tools: { skillOverrides, deniedMcp: g.deniedMcp }
  }
}

// ── normalize() 미러 (m-logic §2.3) — **2차 교차검증 전용** ──────────────────
// 진짜 normalize()는 M-LOGIC(ccg-engine) 소관이다. 아직 계약면이 서지 않아 여기 미러로
// 돌린다: 실패 사유(cwd_missing·account_unavailable·api_key_missing)를 뽑아 unresolved[]에
// 싣는 게 목적이고, 성공분의 해시는 before/after 교차 비교에만 쓴다.
function normalizeMirror(raw, ctx) {
  const reasons = []
  let cwd = raw.cwd || ctx.defaultCwd
  try {
    cwd = fs.realpathSync.native(cwd)
  } catch {
    reasons.push('cwd_missing')
  }
  cwd = cwd.replace(/\\+$/, '').toLowerCase()
  if (raw.billing.kind === 'api_key' && !ctx.hasApiKey) reasons.push('api_key_missing')
  let account = null
  if (raw.billing.kind === 'subscription') {
    account = raw.billing.account ?? ctx.defaultAccount
    if (!account || !ctx.accounts.includes(account)) reasons.push('account_unavailable')
  }
  if (reasons.length) return { ok: false, reasons }
  const addDirs = [
    ...new Set(
      raw.addDirs
        .map((d) => {
          try {
            return fs.realpathSync.native(d).replace(/\\+$/, '').toLowerCase()
          } catch {
            return d.replace(/\\+$/, '').toLowerCase()
          }
        })
        .filter((d) => d !== cwd)
    )
  ].sort()
  const sp = (raw.systemPrompt ?? '').trim()
  const norm = {
    engine: raw.engine,
    billing: raw.billing.kind === 'api_key' ? { kind: 'api_key', keyFp: ctx.keyFp } : { kind: 'subscription', account, dropEnvKey: !!raw.billing.dropEnvKey },
    cwd,
    addDirs,
    mode: raw.mode,
    systemPrompt: sp === '' ? null : sp,
    outputStyle: OUTPUT_STYLES.includes(raw.outputStyle) ? raw.outputStyle : null,
    tools: { skillOverrides: raw.tools.skillOverrides, deniedMcp: [...raw.tools.deniedMcp].sort() }
  }
  return { ok: true, hash: sha(canon(norm)).slice(0, 32) }
}

// ── 인벤토리 ─────────────────────────────────────────────────────────────────
const msgsOf = (rec) => (Array.isArray(rec?.snapshot?.messages) ? rec.snapshot.messages : [])
const hasContent = (rec) => !!(rec?.title || msgsOf(rec).length > 0)

function fanout(dir) {
  const idx = readJSON(path.join(dir, 'index.json'))
  const out = []
  for (const id of Array.isArray(idx?.order) ? idx.order : []) {
    const rec = readJSON(path.join(dir, `${id}.json`))
    if (rec) out.push([String(id), rec])
  }
  return { index: idx ?? {}, items: out }
}

function entryOf(id, rec, source, g, statusValue) {
  const ms = msgsOf(rec)
  return {
    id,
    origin: source === 'panel' ? 'panel' : source === 'session' ? 'session' : 'chat',
    title: rec.title ?? '',
    custom: !!rec.custom,
    locked: !!rec.locked, // ★ 없던 필드 → 기본값 주입 후 비교(§5.2)
    color: rec.color ?? '',
    draft: source === 'panel' ? '' : (rec.draft ?? ''), // 패널 초안은 **공집합**
    draftImages: source === 'panel' ? [] : (rec.draftImages ?? []),
    updatedAt: rec.updatedAt ?? null,
    messages: ms.length,
    lastHash: ms.length ? sha(canon(ms[ms.length - 1])) : null,
    threadHash: sha(canon(ms)),
    sessionId: rec.snapshot?.session?.sessionId ?? null,
    status: statusValue,
    btwOf: rec.btwOf ?? null,
    queue: Array.isArray(rec.queue) ? rec.queue.length : 0,
    raw: toRawIdentity(rec, source, g)
  }
}

/** BEFORE — 2.6.2 3스토어(+chat-talk)에서 기대 인벤토리를 만든다. */
function inventoryBefore(home) {
  const g = readGlobals(home)
  const chats = fanout(path.join(home, 'chats'))
  const ma = fanout(path.join(home, 'multi-agent'))
  const sc = fanout(path.join(home, 'session-chats'))
  const talk = readJSON(path.join(home, 'chat-talk.json'))
  const entries = new Map()
  const order = []
  const taken = new Set()
  const idMap = new Map()

  for (const [id, rec] of chats.items) {
    entries.set(id, entryOf(id, rec, 'chat', g, rec.snapshot?.status ?? 'idle'))
    order.push(id)
    taken.add(id)
    idMap.set(id, id)
  }
  const boards = []
  for (const [sid, sess] of ma.items) {
    const slots = Array(SLOT_COUNT).fill(null)
    const panels = Array.isArray(sess.panels) ? sess.panels : []
    for (let i = 0; i < Math.min(panels.length, SLOT_COUNT); i++) {
      const p = panels[i]
      if (!hasContent(p)) continue
      const nid = `ma-${sid}-${i}`
      entries.set(nid, entryOf(nid, p, 'panel', g, p.snapshot?.status ?? 'idle'))
      order.push(nid)
      taken.add(nid)
      idMap.set(`${sid}::${i}`, nid)
      slots[i] = nid
    }
    boards.push({
      id: sid,
      title: sess.title ?? '',
      custom: !!sess.custom,
      count: Math.min(Math.max(sess.count ?? 1, 1), SLOT_COUNT),
      order: sanitizeOrder(sess.panelOrder),
      slots,
      updatedAt: sess.updatedAt ?? null
    })
  }
  for (const [id, rec] of sc.items) {
    const nid = taken.has(id) ? `sc-${id}` : id
    entries.set(nid, entryOf(nid, rec, 'session', g, rec.status ?? 'idle'))
    order.push(nid)
    taken.add(nid)
    idMap.set(id, nid)
  }
  let talkAbsorbed = 0
  for (const rec of Array.isArray(talk?.chats) ? talk.chats : []) {
    if (typeof rec?.id !== 'string' || !rec.id) continue
    if (!rec.title && msgsOf(rec).length === 0) continue // 2.6.2와 같은 채택 규칙
    const nid = taken.has(rec.id) ? `talk-${rec.id}` : rec.id
    entries.set(nid, entryOf(nid, rec, 'talk', g, rec.snapshot?.status ?? 'idle'))
    order.push(nid)
    taken.add(nid)
    idMap.set(rec.id, nid)
    talkAbsorbed++
  }
  // btwOf 재작성 기대값
  const btwExpect = new Map()
  let btwDropExpect = 0
  for (const [id, rec] of sc.items) {
    if (typeof rec.btwOf !== 'string') continue
    const nid = idMap.get(id)
    const m = /^(.+)::(\d)$/.exec(rec.btwOf)
    const target = m ? (taken.has(`ma-${m[1]}-${m[2]}`) ? `ma-${m[1]}-${m[2]}` : null) : (idMap.get(rec.btwOf) ?? null)
    if (target) btwExpect.set(nid, target)
    else btwDropExpect++
  }
  const holdRaw = sanitizeHold(g.hold, Date.now())
  return {
    globals: g,
    entries,
    order,
    idMap,
    boards,
    talkAbsorbed,
    btwExpect,
    btwDropExpect,
    hold: holdRaw,
    activeChatId: idMap.has(chats.index.activeChatId) ? chats.index.activeChatId : '',
    activeSessionId: ma.index.activeSessionId ?? '',
    boardOrder: ma.items.map(([sid]) => sid),
    counts: {
      chats: chats.items.length,
      maSessions: ma.items.length,
      maPanels: [...entries.values()].filter((e) => e.origin === 'panel').length,
      sessionChats: sc.items.length,
      talkAbsorbed
    },
    files: {
      chats: countJson(path.join(home, 'chats')),
      ma: countJson(path.join(home, 'multi-agent')),
      sessionChats: countJson(path.join(home, 'session-chats'))
    }
  }
}

// index.json은 목록이고 status.json은 Rust 전용 사이드카다 — 둘 다 항목 파일이 아니다
function countJson(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'index.json' && f !== 'status.json').length
  } catch {
    return 0
  }
}

function sanitizeOrder(v) {
  const def = [0, 1, 2, 3, 4, 5]
  if (!Array.isArray(v)) return def
  const got = v.filter((x) => Number.isInteger(x) && x >= 0 && x < SLOT_COUNT)
  return got.length === SLOT_COUNT && new Set(got).size === SLOT_COUNT ? got : def
}

function sanitizeHold(v, nowMs) {
  if (!v || typeof v !== 'object') return null
  if (typeof v.key !== 'string' || !v.key) return null
  if (typeof v.at !== 'number' || !(nowMs - v.at < 24 * 3600_000)) return null
  return {
    key: v.key,
    engine: v.engine === 'codex' ? 'codex' : 'claude',
    ...(typeof v.account === 'string' && v.account ? { account: v.account } : {}),
    resetsAt: typeof v.resetsAt === 'number' ? v.resetsAt : null,
    fable: !!v.fable,
    lastPrompt: typeof v.lastPrompt === 'string' ? v.lastPrompt : '',
    at: v.at
  }
}

/** AFTER — chats-v3 / boards / status.json 을 읽는다. */
function inventoryAfter(home) {
  const dir = path.join(home, 'chats-v3')
  const index = readJSON(path.join(dir, 'index.json')) ?? {}
  const statuses = readJSON(path.join(dir, 'status.json'))?.statuses ?? {}
  const entries = new Map()
  for (const id of Array.isArray(index.order) ? index.order : []) {
    const rec = readJSON(path.join(dir, `${id}.json`))
    if (!rec) continue
    const ms = msgsOf(rec)
    entries.set(String(id), {
      id: String(id),
      origin: rec.origin ?? 'chat',
      title: rec.title ?? '',
      custom: !!rec.custom,
      locked: !!rec.locked,
      color: rec.color ?? '',
      draft: rec.draft ?? '',
      draftImages: rec.draftImages ?? [],
      updatedAt: rec.updatedAt ?? null,
      messages: ms.length,
      lastHash: ms.length ? sha(canon(ms[ms.length - 1])) : null,
      threadHash: sha(canon(ms)),
      sessionId: rec.snapshot?.session?.sessionId ?? null,
      status: statuses[id]?.status ?? 'idle',
      btwOf: rec.btwOf ?? null,
      queue: Array.isArray(rec.queue) ? rec.queue.length : 0,
      hold: rec.hold ?? null,
      raw: rec.identity ?? null
    })
  }
  const bdir = path.join(home, 'boards')
  const bindex = readJSON(path.join(bdir, 'index.json')) ?? {}
  const boards = (Array.isArray(bindex.order) ? bindex.order : []).map((id) => readJSON(path.join(bdir, `${id}.json`))).filter(Boolean)
  return {
    index,
    statuses,
    entries,
    boards,
    boardOrder: Array.isArray(bindex.order) ? bindex.order : [],
    activeBoardId: bindex.activeBoardId ?? '',
    files: { chatsV3: countJson(dir), boards: countJson(bdir) }
  }
}

// ── 비교 ─────────────────────────────────────────────────────────────────────
function leafDiff(a, b, prefix = '') {
  const out = []
  const ka = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])
  for (const k of ka) {
    const va = a?.[k]
    const vb = b?.[k]
    const p = prefix ? `${prefix}.${k}` : k
    if (va && vb && typeof va === 'object' && typeof vb === 'object' && !Array.isArray(va)) out.push(...leafDiff(va, vb, p))
    else if (canon(va) !== canon(vb)) out.push({ path: p, before: va ?? null, after: vb ?? null })
  }
  return out
}

function compare(before, after, ctx) {
  const fails = []
  const warn = []
  const add = (item, detail) => fails.push({ item, ...detail })

  // 채팅 수 / id 집합
  const bKeys = [...before.entries.keys()].sort()
  const aKeys = [...after.entries.keys()].sort()
  if (canon(bKeys) !== canon(aKeys)) {
    add('채팅 id 집합', {
      missing: bKeys.filter((k) => !after.entries.has(k)),
      extra: aKeys.filter((k) => !before.entries.has(k))
    })
  }
  const expectedTotal =
    before.counts.chats + before.counts.maPanels + before.counts.sessionChats + before.counts.talkAbsorbed
  if (expectedTotal !== after.entries.size) {
    add('채팅 수', { before: expectedTotal, after: after.entries.size })
  }

  // 항목별
  const identity1 = { compared: 0, mismatch: [] }
  const identity2 = { compared: 0, mismatch: [], unresolved: [] }
  let msgBefore = 0
  let msgAfter = 0
  for (const [id, b] of before.entries) {
    const a = after.entries.get(id)
    msgBefore += b.messages
    if (!a) continue
    msgAfter += a.messages
    for (const f of ['title', 'custom', 'locked', 'color', 'draft', 'draftImages', 'updatedAt', 'messages', 'lastHash', 'threadHash', 'sessionId', 'status', 'queue']) {
      if (canon(b[f]) !== canon(a[f])) add(`항목 필드 ${f}`, { id, before: b[f] ?? null, after: a[f] ?? null })
    }
    // btwOf — 재작성 기대값과 대조
    const expectBtw = before.btwExpect.get(id) ?? null
    if (canon(expectBtw) !== canon(a.btwOf)) add('btwOf 재작성', { id, expect: expectBtw, after: a.btwOf })

    // 1차 — 저장 원시 필드 바이트 비교(전 항목)
    identity1.compared++
    if (canon(b.raw) !== canon(a.raw)) identity1.mismatch.push({ id, leaves: leafDiff(b.raw, a.raw) })

    // 2차 — 정규화 해시(성공분만). 실패는 unresolved[]로 게이트 비차단
    const nb = normalizeMirror(b.raw, ctx)
    const na = a.raw ? normalizeMirror(a.raw, ctx) : { ok: false, reasons: ['missing_identity'] }
    if (nb.ok && na.ok) {
      identity2.compared++
      if (nb.hash !== na.hash) identity2.mismatch.push({ id, before: nb.hash, after: na.hash })
    } else {
      identity2.unresolved.push({ id, reasons: [...new Set([...(nb.reasons ?? []), ...(na.reasons ?? [])])] })
    }
  }
  if (msgBefore !== msgAfter) add('메시지 총수', { before: msgBefore, after: msgAfter })
  if (identity1.mismatch.length) add('정체성 1차(원시 바이트)', { count: identity1.mismatch.length, sample: identity1.mismatch.slice(0, 3) })
  if (identity2.mismatch.length) add('정체성 2차(정규화 해시)', { count: identity2.mismatch.length, sample: identity2.mismatch.slice(0, 3) })

  // 순서 — 일반 → 멀티 패널 → 추가 채팅 → talk 연결(§4.2)
  const expectOrder = before.order
  const gotOrder = (after.index.order ?? []).slice(0, expectOrder.length)
  if (canon(expectOrder) !== canon(gotOrder)) add('채팅 순서', { before: expectOrder, after: gotOrder })

  // 활성 선택
  if ((after.index.activeChatId ?? '') !== before.activeChatId) {
    add('activeChatId', { before: before.activeChatId, after: after.index.activeChatId ?? '' })
  }
  const expectBoardActive =
    before.globals.workspaceMulti && before.boardOrder.includes(before.activeSessionId) ? before.activeSessionId : 'default'
  if (after.activeBoardId !== expectBoardActive) add('activeBoardId', { expect: expectBoardActive, after: after.activeBoardId })

  // 보드 — 기본 보드 1개 + 세션 보드
  const expectBoardOrder = ['default', ...before.boardOrder]
  if (canon(expectBoardOrder) !== canon(after.boardOrder)) add('보드 순서', { before: expectBoardOrder, after: after.boardOrder })
  for (const eb of before.boards) {
    const ab = after.boards.find((x) => x.id === eb.id)
    if (!ab) {
      add('보드 누락', { id: eb.id })
      continue
    }
    for (const [f, v] of [['count', eb.count], ['order', eb.order], ['slots', eb.slots], ['title', eb.title], ['custom', eb.custom]]) {
      if (canon(v) !== canon(ab[f])) add(`보드 필드 ${f}`, { id: eb.id, before: v, after: ab[f] ?? null })
    }
    if (ab.chrome !== 'grid') add('보드 chrome', { id: eb.id, after: ab.chrome })
  }

  // 한도 대기표
  const holdAfter = [...after.entries.values()].filter((e) => e.hold).map((e) => ({ id: e.id, hold: e.hold }))
  if (before.hold) {
    const target = before.idMap.get(before.hold.key)
    if (!target) warn.push({ item: '한도 대기표', why: '가리키는 채팅이 없다(2.6.2에서도 죽은 표)', key: before.hold.key })
    else if (holdAfter.length !== 1 || holdAfter[0].id !== target) add('한도 대기표 이관', { expect: target, after: holdAfter })
    else if (canon({ ...before.hold, ready: undefined }) !== canon(holdAfter[0].hold)) {
      add('한도 대기표 내용', { before: before.hold, after: holdAfter[0].hold })
    }
  } else if (holdAfter.length) add('한도 대기표(없어야 함)', { after: holdAfter })

  // 예약 큐 — 2.6.2는 어디에도 영속하지 않는다 → 공집합
  const queued = [...after.entries.values()].filter((e) => e.queue > 0)
  if (queued.length) add('예약 큐(공집합이어야 함)', { after: queued.map((e) => e.id) })

  // 파일 수
  const expectFiles = expectedTotal
  if (after.files.chatsV3 !== expectFiles) add('chats-v3 파일 수', { expect: expectFiles, after: after.files.chatsV3 })
  if (after.files.boards !== expectBoardOrder.length) add('boards 파일 수', { expect: expectBoardOrder.length, after: after.files.boards })

  return { fails, warn, identity1, identity2, msgBefore, msgAfter, expectedTotal }
}

// ── §5.3 추가 검사 ───────────────────────────────────────────────────────────
function extraChecks(home, before, after, report) {
  const fails = []
  const tmp = path.join(os.tmpdir(), `ccg-unify-poc-payload-${process.pid}`)
  fs.mkdirSync(tmp, { recursive: true })
  const payloadFile = (v) => {
    const p = path.join(tmp, `p-${Math.random().toString(36).slice(2)}.json`)
    fs.writeFileSync(p, JSON.stringify(v))
    return p
  }

  // 1) 왕복 안정성 — 읽고 → 그대로 되저장 → 인벤토리 동일
  const full = cli(home, ['read-chats'])
  cli(home, ['save-chats', payloadFile(full)])
  const after2 = inventoryAfter(home)
  const rt = compareInventories(after, after2)
  report.checks.roundTrip = { ok: rt.length === 0, diffs: rt.slice(0, 5) }
  if (rt.length) fails.push({ item: '§5.3-1 왕복 안정성', diffs: rt.slice(0, 5) })

  // 2) unloaded 마커 병합 + Rust 소유 3필드 되끼움
  const markers = {
    version: 1,
    activeChatId: full.activeChatId,
    chats: (full.chats ?? []).map((c) => ({
      ...c,
      snapshot: null,
      unloaded: true,
      // ★ 일부러 낡은 값을 실어 보낸다 — Rust 값이 이겨야 한다(§4.1 / §5.3-2)
      identity: { engine: { kind: 'claude', model: 'STALE', effort: 'low', codexAccount: null }, billing: { kind: 'subscription', account: null, dropEnvKey: false }, cwd: 'C:\\STALE', addDirs: [], mode: 'normal', systemPrompt: null, outputStyle: null, tools: { skillOverrides: {}, deniedMcp: [] } },
      queue: [{ id: 'stale-q', text: 'stale' }],
      hold: { key: c.id, engine: 'claude', resetsAt: 1, fable: false, lastPrompt: 'stale', at: Date.now() }
    }))
  }
  cli(home, ['save-chats', payloadFile(markers)])
  const afterMarker = inventoryAfter(home)
  const markerDiffs = compareInventories(after, afterMarker)
  const staleWon = [...afterMarker.entries.values()].filter((e) => e.raw?.cwd === 'C:\\STALE' || e.queue > 0 || !!e.hold)
  report.checks.markerMerge = {
    ok: markerDiffs.length === 0 && staleWon.length === 0,
    lostChats: markerDiffs.filter((d) => d.field === 'threadHash' || d.field === 'messages').length,
    staleAcceptedCount: staleWon.length,
    staleAccepted: staleWon.slice(0, 5).map((e) => e.id)
  }
  if (markerDiffs.length) fails.push({ item: '§5.3-2 마커 병합(대화 증발)', count: markerDiffs.length, diffs: markerDiffs.slice(0, 5) })
  if (staleWon.length) fails.push({ item: '§5.3-2 Rust 소유 필드 되끼움', count: staleWon.length, staleAccepted: staleWon.slice(0, 5).map((e) => e.id) })

  // 3) 별칭 계층 왕복 — ma:get(옛 블롭) → ma:save → ma:get
  const ma1 = cli(home, ['alias-ma-get'])
  if (ma1 && ma1.sessions) {
    cli(home, ['alias-ma-save', payloadFile(ma1)])
    const ma2 = cli(home, ['alias-ma-get'])
    const maDiff = canon(stripVolatile(ma1)) === canon(stripVolatile(ma2)) ? [] : [{ before: 'ma1', after: 'ma2' }]
    const afterAlias = inventoryAfter(home)
    const aliasLoss = compareInventories(after, afterAlias).filter((d) => ['messages', 'threadHash', 'sessionId'].includes(d.field))
    report.checks.aliasMaRoundTrip = { ok: maDiff.length === 0 && aliasLoss.length === 0, blobEqual: maDiff.length === 0, dataLoss: aliasLoss.slice(0, 5) }
    if (aliasLoss.length) fails.push({ item: '§5.3-3 별칭 왕복(대화 증발)', diffs: aliasLoss.slice(0, 5) })
    if (maDiff.length) {
      report.checks.aliasMaRoundTrip.note = 'ma 블롭이 왕복에서 달라졌다 — 아래 diff 참고'
      report.checks.aliasMaRoundTrip.blobDiff = firstBlobDiff(ma1, ma2)
      fails.push({ item: '§5.3-3 별칭 왕복(블롭 동일성)', diff: report.checks.aliasMaRoundTrip.blobDiff })
    }
  } else {
    report.checks.aliasMaRoundTrip = { ok: true, skipped: '보드(멀티 세션)가 없다' }
  }
  // chats 별칭 왕복
  const cg1 = cli(home, ['alias-chats-get'])
  cli(home, ['alias-chats-save', payloadFile(cg1)])
  const afterAlias2 = inventoryAfter(home)
  const aliasLoss2 = compareInventories(after, afterAlias2).filter((d) => ['messages', 'threadHash', 'sessionId'].includes(d.field))
  report.checks.aliasChatsRoundTrip = { ok: aliasLoss2.length === 0, dataLoss: aliasLoss2.slice(0, 5) }
  if (aliasLoss2.length) fails.push({ item: '§5.3-3 chats 별칭 왕복', diffs: aliasLoss2.slice(0, 5) })

  // 4) light 조회 등가 — (a) 보이는 자리 (b) 열린 창 (c) 빈 채팅
  const light = cli(home, ['read-chats', '--light'])
  const visible = new Set()
  const activeBoard = after.boards.find((b) => b.id === after.activeBoardId)
  if (activeBoard) {
    const ord = sanitizeOrder(activeBoard.order)
    for (const s of ord.slice(0, activeBoard.count ?? 1)) if (activeBoard.slots?.[s]) visible.add(activeBoard.slots[s])
  }
  if (after.index.activeChatId) visible.add(after.index.activeChatId)
  const lightBad = []
  for (const c of light.chats ?? []) {
    const isMarker = c.unloaded === true
    const empty = (after.entries.get(c.id)?.messages ?? 0) === 0
    const shouldKeep = visible.has(c.id) || empty
    if (shouldKeep && isMarker) lightBad.push({ id: c.id, why: '실려야 하는데 마커' })
    if (!shouldKeep && !isMarker) lightBad.push({ id: c.id, why: '접혀야 하는데 스냅샷' })
  }
  // (b) 열린 창 — 접혔을 채팅을 열린 창으로 지목하면 스냅샷이 실려야 한다
  const folded = (light.chats ?? []).find((c) => c.unloaded === true)
  if (folded) {
    const light2 = cli(home, ['read-chats', '--light', '--open', folded.id])
    const got = (light2.chats ?? []).find((c) => c.id === folded.id)
    if (got?.unloaded === true) lightBad.push({ id: folded.id, why: '열린 창인데 마커(b 미적용)' })
  }

  // 마커를 되보내도 손실 0
  cli(home, ['save-chats', payloadFile(light)])
  const afterLight = inventoryAfter(home)
  const lightLoss = compareInventories(after, afterLight)
  report.checks.lightQuery = { ok: lightBad.length === 0 && lightLoss.length === 0, wrong: lightBad.slice(0, 5), loss: lightLoss.slice(0, 5) }
  if (lightBad.length) fails.push({ item: '§5.3-4 light 조회 규칙', wrong: lightBad.slice(0, 5) })
  if (lightLoss.length) fails.push({ item: '§5.3-4 마커 되저장 손실', diffs: lightLoss.slice(0, 5) })

  // 4b) chats:set-active — **즉시** 반영돼야 한다(§6.2 U3). 저장 디바운스와 무관.
  const ids = [...after.entries.keys()]
  const pick = ids.find((i) => i !== after.index.activeChatId) ?? ids[0]
  if (pick) {
    const sa = cli(home, ['set-active', pick])
    const onDisk = readJSON(path.join(home, 'chats-v3', 'index.json'))?.activeChatId
    const ok = sa.ok === true && sa.activeChatId === pick && onDisk === pick
    // 되돌린다(뒤 검사들이 원래 활성 채팅을 기준으로 돈다)
    cli(home, ['set-active', after.index.activeChatId || pick])
    report.checks.setActive = { ok, picked: pick, onDisk }
    if (!ok) fails.push({ item: '§6.2 chats:set-active 즉시 반영', detail: report.checks.setActive })
  }

  // 5) 부팅 재장전 경로(§4.3 / m-logic §5.8) — hold·큐가 있는 채팅이 후보로 잡히는가.
  //    이 경로가 없으면 "재시작 후 자동 이어서가 조용히 안 산다".
  const victim = [...after.entries.keys()][0]
  if (victim) {
    const hold = { key: victim, engine: 'claude', resetsAt: 1_800_000_000, fable: false, lastPrompt: '이어서', at: Date.now() }
    cli(home, ['set-owned', victim, 'hold', payloadFile(hold)])
    cli(home, ['set-owned', victim, 'queue', payloadFile([{ id: 'q1', text: '대기 1', images: [] }])])
    const st1 = cli(home, ['status'])
    // status.json을 지워도 얕은 스캔으로 재구성돼야 한다(규약 5)
    fs.rmSync(path.join(home, 'chats-v3', 'status.json'), { force: true })
    const st2 = cli(home, ['status'])
    const ok1 = (st1.reloadCandidates ?? []).includes(victim)
    const ok2 = (st2.reloadCandidates ?? []).includes(victim)
    const lite = st2.statuses?.[victim] ?? {}
    const ok3 = lite.queued === 1 && lite.hold && lite.hold.resetAt === 1_800_000_000 && lite.busy === false && lite.ask === 'none' && lite.unread === 0
    cli(home, ['set-owned', victim, 'hold', 'null'])
    cli(home, ['set-owned', victim, 'queue', 'null'])
    const st3 = cli(home, ['status'])
    const ok4 = !(st3.reloadCandidates ?? []).includes(victim)
    report.checks.bootReload = { ok: ok1 && ok2 && ok3 && ok4, withStatusJson: ok1, afterStatusJsonDeleted: ok2, liteDerived: ok3, clearedAgain: ok4, lite }
    if (!(ok1 && ok2 && ok3 && ok4)) fails.push({ item: '§4.3 부팅 재장전 후보', detail: report.checks.bootReload })
    // 그 채팅의 스냅샷이 살아 있는지도 확인(소유 필드 쓰기가 파일을 덮어쓰지 않았나)
    const afterOwned = inventoryAfter(home)
    const ownedLoss = compareInventories(after, afterOwned).filter((d) => ['messages', 'threadHash'].includes(d.field))
    if (ownedLoss.length) fails.push({ item: '§4.3 소유 필드 쓰기가 스냅샷을 훼손', diffs: ownedLoss.slice(0, 5) })
  }

  rmrf(tmp)
  return fails
}

function stripVolatile(v) {
  return v
}

function firstBlobDiff(a, b) {
  const sa = canon(a)
  const sb = canon(b)
  let i = 0
  while (i < sa.length && i < sb.length && sa[i] === sb[i]) i++
  return { at: i, before: sa.slice(Math.max(0, i - 60), i + 60), after: sb.slice(Math.max(0, i - 60), i + 60) }
}

function compareInventories(x, y) {
  const out = []
  const keys = new Set([...x.entries.keys(), ...y.entries.keys()])
  for (const k of keys) {
    const a = x.entries.get(k)
    const b = y.entries.get(k)
    if (!a || !b) {
      out.push({ id: k, field: a ? 'deleted' : 'added' })
      continue
    }
    for (const f of ['title', 'custom', 'locked', 'color', 'draft', 'updatedAt', 'messages', 'threadHash', 'sessionId', 'raw', 'queue', 'origin']) {
      if (canon(a[f]) !== canon(b[f])) out.push({ id: k, field: f, before: a[f] ?? null, after: b[f] ?? null })
    }
  }
  return out
}

// ── 픽스처 ───────────────────────────────────────────────────────────────────
function makeSyntheticHome(dir) {
  // §5.3-7 부하 픽스처 — 채팅 200 / 멀티 세션 20(각 6패널) / 추가 채팅 30.
  // 스냅샷 규약(bench/fixture.mjs): session은 실제 값이 필요한 검증이라 채우되
  // animate:false · 항목 500 미만.
  rmrf(dir)
  for (const d of ['chats', 'multi-agent', 'session-chats']) fs.mkdirSync(path.join(dir, d), { recursive: true })
  fs.writeFileSync(path.join(dir, 'ui-prefs.json'), JSON.stringify({ 'workspace.mode': 'multi', 'api.mode': false, 'claude.outputStyle': 'Concise' }))
  fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({ disabled: ['ctx7', 'aaa'] }))
  fs.writeFileSync(path.join(dir, 'skills.json'), JSON.stringify({ disabled: ['dataviz'] }))
  const snap = (n, sid) => ({
    status: 'idle',
    messages: Array.from({ length: n }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', text: `줄 ${i} — ${'가'.repeat(40)}`, time: '오후 3:00', animate: false })),
    todos: [], files: [], diffs: {}, terminal: [], subagents: [], bgTasks: [], workflows: [],
    pendingPermission: null, pendingQuestion: null,
    session: sid ? { sessionId: sid, model: 'opus', cwd: 'C:\\Code' } : null,
    result: null, pendingCommand: null, spentUsd: 0, tokenTotals: {}, thinkingText: null,
    streaming: false, openGroupId: null, seq: n, shownNotices: []
  })
  const order = []
  for (let i = 0; i < 200; i++) {
    const id = `chat-${String(i).padStart(4, '0')}`
    order.push(id)
    fs.writeFileSync(path.join(dir, 'chats', `${id}.json`), JSON.stringify({
      id, title: `채팅 ${i}`, custom: i % 3 === 0,
      snapshot: snap(60, `sess-c-${i}`),
      manualCwd: i % 5 ? 'C:\\Code' : '',
      picker: { model: ['opus', 'fable', 'sonnet'][i % 3], effort: 'max', mode: 'bypass', ...(i % 7 === 0 ? { engine: 'codex', codexModel: 'gpt-5.6-sol' } : {}), ...(i % 4 === 0 ? { account: 'a@b.c' } : {}) },
      draft: i % 2 ? `초안 ${i}` : '', draftImages: [], updatedAt: 1_700_000_000_000 + i, refDirs: i % 6 ? [] : ['C:\\Code\\x']
    }))
  }
  fs.writeFileSync(path.join(dir, 'chats', 'index.json'), JSON.stringify({ version: 1, order, activeChatId: order[3] }))
  const morder = []
  for (let s = 0; s < 20; s++) {
    const sid = `ms-${s}`
    morder.push(sid)
    const panels = Array.from({ length: 6 }, (_, i) => ({
      title: i < 4 ? `패널 ${s}-${i}` : '', custom: false, locked: i === 1, color: i === 2 ? '#f00' : '',
      cwd: 'C:\\Code', refDirs: [], picker: { model: 'opus', effort: 'high', mode: 'auto' }, api: i === 3,
      snapshot: i < 4 ? snap(40, `sess-p-${s}-${i}`) : snap(0, null)
    }))
    fs.writeFileSync(path.join(dir, 'multi-agent', `${sid}.json`), JSON.stringify({ id: sid, title: `세션 ${s}`, custom: s % 2 === 0, count: 4, panelOrder: [0, 2, 1, 3, 4, 5], panels, updatedAt: 1_700_000_000_000 + s }))
  }
  fs.writeFileSync(path.join(dir, 'multi-agent', 'index.json'), JSON.stringify({ version: 2, activeSessionId: morder[1], order: morder }))
  const sorder = []
  for (let i = 0; i < 30; i++) {
    const id = `sc-uuid-${i}`
    sorder.push(id)
    fs.writeFileSync(path.join(dir, 'session-chats', `${id}.json`), JSON.stringify({
      id, title: `추가 ${i}`, custom: false, status: i % 5 === 0 ? 'error' : 'done', cwd: 'C:\\Code', refDirs: [],
      snapshot: snap(20, `sess-s-${i}`), picker: { model: 'sonnet', effort: 'medium', mode: 'plan' },
      draft: '', draftImages: [], empty: false, updatedAt: 1_700_000_000_000 + i,
      // btw 그래프 — 절반은 일반 채팅 원본, 몇 개는 멀티 패널(panelId 형식), 하나는 고아
      ...(i % 3 === 0 ? { btwOf: order[i % 200] } : i % 3 === 1 ? { btwOf: `ms-${i % 20}::1` } : i === 29 ? { btwOf: 'gone-forever' } : {})
    }))
  }
  fs.writeFileSync(path.join(dir, 'session-chats', 'index.json'), JSON.stringify({ version: 1, order: sorder }))
  fs.writeFileSync(path.join(dir, 'chat-talk.json'), JSON.stringify({ version: 1, chats: [{ id: 'talk-1', title: '옛 채팅 모드', custom: false, snapshot: snap(10, 'sess-t-1'), picker: { model: 'opus', effort: 'xhigh', mode: 'auto' } }, { id: 'talk-empty', title: '', custom: false, snapshot: snap(0, null), picker: {} }], activeChatId: 'talk-1' }))
}

function makeFixtureHome(dir) {
  rmrf(dir)
  fs.mkdirSync(dir, { recursive: true })
  execFileSync(process.execPath, [path.join(ROOT, 'bench', 'fixture.mjs'), dir, '3.0.0'], { stdio: 'ignore', cwd: ROOT })
}

/** §5.3-6 크래시 내성 — 마이그레이션 **도중** 프로세스를 죽인다.
 *  기대: 옛 3디렉터리는 온전하고(롤백 경로 살아 있음), chats-v3는 없거나 **완전**하다
 *  (스테이징 → rename이라 반쪽이 제자리에 앉지 못한다). */
function crashTest(home, killMs) {
  const clone = `${home}-crash`
  rmrf(clone)
  cpdir(home, clone, true)
  const before = { chats: dirHash(path.join(clone, 'chats')), ma: dirHash(path.join(clone, 'multi-agent')), sc: dirHash(path.join(clone, 'session-chats')) }
  const r = spawnSync(EXE, ['migrate', '--no-backup'], {
    env: { ...process.env, CCG_HOME: clone },
    encoding: 'utf8',
    timeout: killMs,
    killSignal: 'SIGKILL'
  })
  const killed = r.error?.code === 'ETIMEDOUT' || r.signal != null
  const after = { chats: dirHash(path.join(clone, 'chats')), ma: dirHash(path.join(clone, 'multi-agent')), sc: dirHash(path.join(clone, 'session-chats')) }
  const v3 = path.join(clone, 'chats-v3')
  const idx = readJSON(path.join(v3, 'index.json'))
  const complete = !fs.existsSync(v3) ? 'absent' : idx && (idx.order ?? []).every((id) => fs.existsSync(path.join(v3, `${id}.json`))) ? 'complete' : 'partial'
  const leftovers = fs.readdirSync(clone).filter((f) => f.includes('.tmp-') || f.includes('.old-'))
  // 죽은 스테이징이 남았으면, **다음 마이그레이션이 그걸 쓸어내는지**까지 본다
  let sweptByRerun = null
  if (leftovers.length) {
    spawnSync(EXE, ['migrate', '--no-backup'], { env: { ...process.env, CCG_HOME: clone }, encoding: 'utf8', timeout: 120_000 })
    sweptByRerun = fs.readdirSync(clone).filter((f) => f.includes('.tmp-') || f.includes('.old-')).length === 0
  }
  const out = { killed, killMs, oldDirsIntact: canon(before) === canon(after), chatsV3: complete, stagingLeftovers: leftovers, sweptByRerun }
  rmrf(clone)
  return out
}

// ── 한 홈에 대한 전체 주행 ──────────────────────────────────────────────────
function run(label, home) {
  const rep = { label, home, checks: {}, at: new Date().toISOString() }
  const oldHashes = {
    chats: dirHash(path.join(home, 'chats')),
    ma: dirHash(path.join(home, 'multi-agent')),
    sessionChats: dirHash(path.join(home, 'session-chats'))
  }
  const before = inventoryBefore(home)
  const accounts = (readJSON(path.join(home, 'accounts.json'))?.accounts ?? []).map((a) => a.email).filter(Boolean)
  const ctx = {
    defaultCwd: path.join(os.homedir(), 'Desktop'),
    accounts,
    defaultAccount: readJSON(path.join(home, 'accounts.json'))?.defaultEmail ?? accounts[0] ?? null,
    hasApiKey: before.globals.hasApiKey,
    keyFp: 'FP'
  }

  // 크래시 내성은 **마이그레이션 전** 상태의 복사본에서 잰다(진짜 중간 kill).
  // 먼저 죽이지 않고 한 번 돌려 소요를 재고, 그 35% 지점에서 SIGKILL.
  const probeT0 = Date.now()
  const probe = crashTest(home, 120_000)
  const probeMs = Date.now() - probeT0
  const killAt = Math.max(20, Math.round(probeMs * 0.35))
  rep.checks.crash = { normalRunMs: probeMs, ...crashTest(home, killAt) }
  if (!rep.checks.crash.killed) rep.checks.crash.note = '너무 빨라 중간에 못 죽였다(완주) — 부하 픽스처 쪽 수치를 보라'
  if (probe.chatsV3 !== 'complete') rep.checks.crash.probeAnomaly = probe

  const t0 = Date.now()
  const mig = cli(home, ['migrate'])
  rep.migrate = { ...mig, idMap: undefined, order: undefined, wallMs: Date.now() - t0 }
  rep.migrateIdMapSize = Object.keys(mig.idMap ?? {}).length
  if (!mig.ok) {
    rep.fails = [{ item: '마이그레이션 실패', detail: mig }]
    return rep
  }
  const after = inventoryAfter(home)
  const cmp = compare(before, after, ctx)
  rep.counts = {
    before: { ...before.counts, expectedTotal: cmp.expectedTotal, messages: cmp.msgBefore, files: before.files },
    after: { chats: after.entries.size, messages: cmp.msgAfter, boards: after.boards.length, files: after.files }
  }
  rep.identity = {
    primary: { compared: cmp.identity1.compared, mismatch: cmp.identity1.mismatch.length, sample: cmp.identity1.mismatch.slice(0, 3) },
    secondary: {
      compared: cmp.identity2.compared,
      mismatch: cmp.identity2.mismatch.length,
      unresolved: cmp.identity2.unresolved.length,
      reasons: tally(cmp.identity2.unresolved.flatMap((u) => u.reasons))
    }
  }
  rep.btw = { ...mig.btw, expectRewritten: before.btwExpect.size, expectDropped: before.btwDropExpect }
  if (mig.btw.rewritten !== before.btwExpect.size || mig.btw.dropped !== before.btwDropExpect) {
    cmp.fails.push({ item: 'btw 재작성 건수', expect: { rewritten: before.btwExpect.size, dropped: before.btwDropExpect }, after: mig.btw })
  }
  rep.warnings = cmp.warn
  const fails = [...cmp.fails]

  // §5.3 추가 검사
  fails.push(...extraChecks(home, before, after, rep))

  // 5) 멱등성 — 2회 실행 후 채팅 수·id 집합 불변
  const before2 = inventoryAfter(home)
  const mig2 = cli(home, ['migrate', '--no-backup'])
  const after2 = inventoryAfter(home)
  const idsSame = canon([...before2.entries.keys()].sort()) === canon([...after2.entries.keys()].sort())
  rep.checks.idempotent = { ok: idsSame && mig2.ok, before: before2.entries.size, after: after2.entries.size }
  if (!idsSame) fails.push({ item: '§5.3-5 멱등성', before: before2.entries.size, after: after2.entries.size })

  // 6) 크래시 내성 / 롤백 — 옛 3디렉터리가 그대로인가 + 스테이징 잔여물 없음
  const nowHashes = {
    chats: dirHash(path.join(home, 'chats')),
    ma: dirHash(path.join(home, 'multi-agent')),
    sessionChats: dirHash(path.join(home, 'session-chats'))
  }
  const oldIntact = canon(oldHashes) === canon(nowHashes)
  const leftovers = fs.readdirSync(home).filter((f) => f.includes('.tmp-') || f.includes('.old-'))
  const backupOk = !!mig.backupDir && fs.existsSync(mig.backupDir)
  rep.checks.rollback = { oldDirsIntact: oldIntact, stagingLeftovers: leftovers, backupExists: backupOk, backupDir: mig.backupDir ?? null }
  if (!oldIntact) fails.push({ item: '§5.3-6 옛 디렉터리 훼손', before: oldHashes, after: nowHashes })
  if (!rep.checks.crash.oldDirsIntact) fails.push({ item: '§5.3-6 중간 kill 후 옛 디렉터리 훼손', crash: rep.checks.crash })
  if (rep.checks.crash.chatsV3 === 'partial') fails.push({ item: '§5.3-6 중간 kill 후 반쪽 chats-v3', crash: rep.checks.crash })
  if (leftovers.length) fails.push({ item: '§5.3-6 스테이징 잔여물', leftovers })
  if (!backupOk) fails.push({ item: '§5.3-6 백업 없음', backupDir: mig.backupDir ?? null })

  // API 키 승계(재로그인 없이) — 원문은 싣지 않는다
  const api = cli(home, ['api-status'], { allowFail: true })
  rep.apiConfig = api ? { ...api, keyLen: api.keyLen > 0 ? '>0' : 0 } : null

  rep.fails = fails
  rep.ok = fails.length === 0
  return rep
}

const tally = (arr) => arr.reduce((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {})

// ── main ─────────────────────────────────────────────────────────────────────
function main() {
  const argv = process.argv.slice(2)
  const stampStr = new Date().toISOString().replace(/[:.]/g, '-')
  const targets = []

  if (argv.includes('--clone-from-real')) {
    if (!fs.existsSync(REAL_HOME)) throw new Error('실홈이 없다')
    const dst = path.join(os.tmpdir(), `ccg-unify-poc-real-${Date.now()}`)
    cpdir(REAL_HOME, dst, true) // ★ 읽기만 — 원본은 건드리지 않는다
    targets.push(['실홈 복사본', dst])
  }
  if (argv.includes('--fixture')) {
    const dst = path.join(os.tmpdir(), `ccg-unify-poc-fixture-${Date.now()}`)
    makeFixtureHome(dst)
    targets.push(['벤치 픽스처 홈', dst])
  }
  if (argv.includes('--synthetic')) {
    const dst = path.join(os.tmpdir(), `ccg-unify-poc-load-${Date.now()}`)
    makeSyntheticHome(dst)
    targets.push(['부하 픽스처(200/20×6/30)', dst])
  }
  const hi = argv.indexOf('--home')
  if (hi >= 0 && argv[hi + 1]) targets.push(['지정 홈', path.resolve(argv[hi + 1])])

  if (!targets.length) {
    console.error('사용: --clone-from-real | --fixture | --synthetic | --home <경로> (하나 이상)')
    process.exit(2)
  }
  for (const [, home] of targets) {
    if (path.resolve(home).toLowerCase() === REAL_HOME.toLowerCase()) {
      console.error(`거부: 대상이 사용자 실홈이다 (${home})`)
      process.exit(2)
    }
  }
  if (!fs.existsSync(EXE)) {
    console.error(`마이그레이터 바이너리가 없다 — 먼저: cargo build -p ccg-store --features cli\n(${EXE})`)
    process.exit(2)
  }

  const out = { at: new Date().toISOString(), exe: EXE, runs: [] }
  for (const [label, home] of targets) {
    process.stdout.write(`\n── ${label} — ${home}\n`)
    const rep = run(label, home)
    out.runs.push(rep)
    process.stdout.write(
      `   채팅 ${rep.counts?.after.chats ?? '?'}개 · 메시지 ${rep.counts?.after.messages ?? '?'} · ` +
        `정체성 1차 불일치 ${rep.identity?.primary.mismatch ?? '?'} · 2차 미수행 ${rep.identity?.secondary.unresolved ?? '?'} · ` +
        `실패 ${rep.fails.length}\n`
    )
    for (const f of rep.fails.slice(0, 10)) process.stdout.write(`   ✗ ${f.item} ${JSON.stringify(f).slice(0, 220)}\n`)
  }
  out.ok = out.runs.every((r) => r.ok)
  const dir = path.join(ROOT, 'docs', 'poc-out')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `chat-unify-${stampStr}.json`)
  fs.writeFileSync(file, JSON.stringify(out, null, 2))
  process.stdout.write(`\n리포트: ${file}\n판정: ${out.ok ? 'PASS' : 'FAIL'}\n`)
  process.exit(out.ok ? 0 : 1)
}

main()
