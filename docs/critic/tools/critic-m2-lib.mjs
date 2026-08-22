// ─────────────────────────────────────────────────────────────────────────────
// critic-m2-lib — M2(통합 스토어) 크리틱 공용부.
//
// 빌더 하네스(scripts/poc-chat-unify-migrate.mjs)를 **부르지 않는다.** 인벤토리는
// index.json이 아니라 **디스크의 파일**에서 만든다 — 빌더 하네스는 before/after 둘 다
// index.order로 항목을 세므로 "파일은 있는데 인덱스에 없는 대화"가 양쪽에서 동시에
// 사라져 검사에 안 걸린다(맹점 재현용).
//
// 안전: 사용자 실홈은 **읽기/복사만**. 모든 대상은 %TEMP%/ccg-critic-m2-*.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
export const EXE = path.join(REPO, 'target', 'debug', 'ccg-migrate.exe')
export const REAL_HOME = path.join(os.homedir(), '.agentcodegui')
export const SLOT_COUNT = 6

export const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
export const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true })

export function readJSON(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/** 키 정렬 정준 직렬화(배열 순서는 보존). */
export function canon(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v)
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']'
  const keys = Object.keys(v)
    .filter((k) => v[k] !== undefined)
    .sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'
}

const SKIP_CLONE = new Set(['engines', 'codex-engines', 'lsp', 'attachments', 'accounts', 'codex', 'shared', 'node_modules'])

export function cpdir(src, dst, skipTop = false) {
  fs.mkdirSync(dst, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (skipTop && SKIP_CLONE.has(e.name)) continue
    const s = path.join(src, e.name)
    const d = path.join(dst, e.name)
    if (e.isDirectory()) cpdir(s, d)
    else if (e.isFile()) fs.copyFileSync(s, d)
  }
}

/** 사용자 실홈의 **읽기 전용** 복사본. 원본은 절대 열어 쓰지 않는다. */
export function cloneReal(tag) {
  const dst = path.join(os.tmpdir(), `ccg-critic-m2-${tag}-${Date.now()}`)
  cpdir(REAL_HOME, dst, true)
  return dst
}

/**
 * 설치본(2.6.2)의 `Local State`를 격리 userData로 복사한다 — 벤치 픽스처와 같은 규약.
 *
 * **왜 필수인가(R8 확인 크리틱 실측)**: 이걸 안 하면 Electron이 그 프로필만의 OSCrypt 키를
 * 새로 만든다. 그 프로필에서는 **어떤 `v10` 암호문도 못 푼다** — 3.0이 쓴 것은 물론
 * *Electron 자신이 다른 프로필에서 만든 v10*도 실패한다. 즉 시드 없는 프로필로 재는
 * "2.6.2가 읽는가"는 **제품이 아니라 하네스를 재는 것**이다.
 *
 * 실측(같은 암호문, Local State만 다르게):
 * ```
 * 3.0 v10 / 시드 없음                 → FAIL "Error while decrypting the ciphertext…"
 * 3.0 v10 / 설치본 Local State 시드    → OK   sk-ant-critic-m2-0000-TEST-9999
 * Electron 자신의 v10 / 시드 없음      → FAIL (같은 에러) ← 형상 증명
 * ```
 * 참고: *포맷* 거부는 에러 문구가 다르다("Ciphertext does not appear to be encrypted.").
 * 두 문구를 구별해야 D6(포맷) 회귀와 시드 누락(키)을 안 헷갈린다.
 *
 * @returns {boolean} 설치본 Local State를 실제로 복사했는가
 */
export function seedLocalState(userData) {
  const src = path.join(process.env.APPDATA ?? '', 'agent-code-gui', 'Local State')
  if (!fs.existsSync(src)) return false
  fs.mkdirSync(userData, { recursive: true })
  fs.copyFileSync(src, path.join(userData, 'Local State'))
  return true
}

export function dirHash(dir) {
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

/** 마이그레이터 CLI. status !== 0도 그대로 돌려준다(크래시 판정용). */
export function cli(home, args, { timeout = 180_000 } = {}) {
  const r = spawnSync(EXE, args, {
    env: { ...process.env, CCG_HOME: home },
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    timeout
  })
  let json = null
  try {
    json = JSON.parse(r.stdout)
  } catch {
    /* 비-JSON 출력 = 크래시 신호 */
  }
  return { status: r.status, signal: r.signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '', json, error: r.error?.code ?? null }
}

export function payloadFile(v, tag = 'p') {
  const dir = path.join(os.tmpdir(), `ccg-critic-m2-payload-${process.pid}`)
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, `${tag}-${Math.random().toString(36).slice(2)}.json`)
  fs.writeFileSync(p, JSON.stringify(v))
  return p
}

// ── 디스크 기준 인벤토리 (index.json을 신뢰하지 않는다) ─────────────────────
const msgsOf = (rec) => (Array.isArray(rec?.snapshot?.messages) ? rec.snapshot.messages : [])

/** 디렉터리의 모든 <id>.json(인덱스 제외)을 읽는다 — 인덱스 유무와 무관. */
export function filesOf(dir) {
  const out = new Map()
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return out
  }
  for (const n of names) {
    if (!n.endsWith('.json') || n === 'index.json' || n === 'status.json') continue
    const id = n.slice(0, -5)
    const raw = (() => {
      try {
        return fs.readFileSync(path.join(dir, n), 'utf8')
      } catch {
        return null
      }
    })()
    let parsed = null
    try {
      parsed = JSON.parse(raw)
    } catch {
      /* 손상 파일 */
    }
    out.set(id, { raw, rec: parsed, parseOk: parsed !== null })
  }
  return out
}

/** 2.6.2 소스 홈 — **파일 기준** 대화 목록(마이그레이터가 뭘 빠뜨렸는지 보려고). */
export function sourceUnits(home) {
  const units = [] // { key, source, id, msgs, threadBytes, rec }
  for (const [id, f] of filesOf(path.join(home, 'chats'))) {
    if (!f.parseOk) {
      units.push({ key: `chat:${id}`, source: 'chat', id, broken: true })
      continue
    }
    const ms = msgsOf(f.rec)
    units.push({ key: `chat:${id}`, source: 'chat', id, msgs: ms.length, threadBytes: sha(canon(ms)), rec: f.rec })
  }
  for (const [sid, f] of filesOf(path.join(home, 'multi-agent'))) {
    if (!f.parseOk) {
      units.push({ key: `ma:${sid}`, source: 'panel', id: sid, broken: true })
      continue
    }
    const panels = Array.isArray(f.rec?.panels) ? f.rec.panels : []
    panels.forEach((p, i) => {
      if (i >= SLOT_COUNT) return
      const has = !!(p?.title || msgsOf(p).length)
      if (!has) return
      const ms = msgsOf(p)
      units.push({ key: `panel:${sid}::${i}`, source: 'panel', id: `ma-${sid}-${i}`, msgs: ms.length, threadBytes: sha(canon(ms)), rec: p })
    })
  }
  for (const [id, f] of filesOf(path.join(home, 'session-chats'))) {
    if (!f.parseOk) {
      units.push({ key: `sc:${id}`, source: 'session', id, broken: true })
      continue
    }
    const ms = msgsOf(f.rec)
    units.push({ key: `sc:${id}`, source: 'session', id, msgs: ms.length, threadBytes: sha(canon(ms)), rec: f.rec })
  }
  const talk = readJSON(path.join(home, 'chat-talk.json'))
  for (const rec of Array.isArray(talk?.chats) ? talk.chats : []) {
    if (typeof rec?.id !== 'string' || !rec.id) continue
    if (!rec.title && msgsOf(rec).length === 0) continue // 2.6.2 채택 규칙
    const ms = msgsOf(rec)
    units.push({ key: `talk:${rec.id}`, source: 'talk', id: rec.id, msgs: ms.length, threadBytes: sha(canon(ms)), rec })
  }
  return units
}

/** chats-v3 — **파일 기준**(index.order에 없는 파일까지 본다). */
export function v3Units(home) {
  const dir = path.join(home, 'chats-v3')
  const index = readJSON(path.join(dir, 'index.json')) ?? {}
  const order = Array.isArray(index.order) ? index.order.map(String) : []
  const files = filesOf(dir)
  const out = new Map()
  for (const [id, f] of files) {
    const ms = msgsOf(f.rec)
    out.set(id, {
      id,
      inIndex: order.includes(id),
      parseOk: f.parseOk,
      origin: f.rec?.origin ?? null,
      msgs: ms.length,
      threadBytes: f.parseOk ? sha(canon(ms)) : null,
      identity: f.rec?.identity ?? null,
      hold: f.rec?.hold ?? null,
      queue: f.rec?.queue ?? null,
      rec: f.rec
    })
  }
  return { index, order, units: out, orphanFiles: [...files.keys()].filter((id) => !order.includes(id)), missingFiles: order.filter((id) => !files.has(id)) }
}

export function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

export function writeResult(name, obj) {
  const p = path.join(REPO, 'docs', 'critic', name)
  fs.writeFileSync(p, JSON.stringify(obj, null, 2))
  return p
}
