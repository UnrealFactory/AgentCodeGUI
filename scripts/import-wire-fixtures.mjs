#!/usr/bin/env node
// %TEMP%\ccg-poc-rs\*.jsonl (scripts/poc-rs가 남긴 실와이어) → crates/ccg-engine/tests/fixtures/wire/
//
// 규칙(m-logic-replay.md §2.1):
//   - session_id / uuid          → 결정적 가짜 id (같은 값 → 같은 대체값)
//   - 절대경로 C:\Users\<user>\… → C:\ccg-fixture\…
//   - 계정 이메일                 → fixture@example.com
//   - slash_commands/commands    → 3개만 남기고 절삭(초대형 init 응답)
//   - 그 외                       → **바이트 그대로**. 스키마를 "정리"하지 말 것.
//
// 원본 SHA-256과 채취 정보를 PROVENANCE.json에 남긴다 — 크리틱이 출처를 되짚을 수 있어야 한다.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const SRC = process.env.CCG_WIRE_SRC || path.join(os.tmpdir(), 'ccg-poc-rs')
const DST = path.resolve(process.argv[2] || 'crates/ccg-engine/tests/fixtures/wire')
const NAMES = [
  'smoke', 'approve', 'approve-noid', 'ask', 'park',
  'interrupt', 'resume-1', 'resume-2', 'resume-3-fork',
]

fs.mkdirSync(DST, { recursive: true })

const idMap = new Map()
let idSeq = 0
const fakeId = (real) => {
  if (!idMap.has(real)) {
    idSeq += 1
    idMap.set(real, `00000000-0000-4000-8000-${String(idSeq).padStart(12, '0')}`)
  }
  return idMap.get(real)
}
const USER = (os.userInfo().username || '').trim()
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

function maskString(s) {
  let out = s.replace(UUID_RE, (m) => fakeId(m.toLowerCase()))
  out = out.replace(EMAIL_RE, 'fixture@example.com')
  // 경로(이스케이프된 JSON 문자열 안이므로 \\ 두 글자)
  out = out.replace(/C:\\\\Users\\\\[^\\"]+\\\\AppData\\\\Local\\\\Temp\\\\ccg-poc-rs/gi, 'C:\\\\ccg-fixture')
  out = out.replace(/C:\\\\Users\\\\[^\\"]+/gi, 'C:\\\\ccg-fixture\\\\home')
  out = out.replace(/C:\\Users\\[^\\"]+\\AppData\\Local\\Temp\\ccg-poc-rs/gi, 'C:\\ccg-fixture')
  out = out.replace(/C:\\Users\\[^\\"]+/gi, 'C:\\ccg-fixture\\home')
  // 앱 홈 슬러그: `lmg56634_gmail.com-68e935` / `C--Users-User-AppData-…`
  out = out.replace(/[A-Za-z0-9._%+-]+_[A-Za-z0-9.-]+\.[A-Za-z]{2,}-[0-9a-f]{4,}/g, 'fixture_example.com-000000')
  out = out.replace(/C--Users-[A-Za-z0-9._%+-]+-/gi, 'C--ccg-fixture-')
  if (USER) out = out.split(USER).join('fixture-user')
  return out
}

function truncArrays(v) {
  if (Array.isArray(v)) return v.map(truncArrays)
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) {
      if ((k === 'slash_commands' || k === 'commands' || k === 'tools' || k === 'agents' || k === 'models')
          && Array.isArray(v[k]) && v[k].length > 3) {
        v[k] = v[k].slice(0, 3)
      } else v[k] = truncArrays(v[k])
    }
  }
  return v
}

const prov = { generatedAt: new Date().toISOString(), source: SRC, files: {} }
let total = 0
for (const name of NAMES) {
  const src = path.join(SRC, `${name}.jsonl`)
  if (!fs.existsSync(src)) { console.warn(`skip (없음): ${src}`); continue }
  const raw = fs.readFileSync(src)
  const sha = crypto.createHash('sha256').update(raw).digest('hex')
  const stat = fs.statSync(src)
  const lines = raw.toString('utf8').split('\n').filter((l) => l.trim())
  const out = []
  for (const line of lines) {
    let v
    try { v = JSON.parse(maskString(line)) } catch { continue }
    out.push(JSON.stringify(truncArrays(v)))
  }
  fs.writeFileSync(path.join(DST, `${name}.jsonl`), out.join('\n') + '\n')
  prov.files[`${name}.jsonl`] = {
    origin: 'wire',
    sourceSha256: sha,
    sourceMtime: stat.mtime.toISOString(),
    frames: out.length,
    cli: 'claude.exe 2.1.239 (@anthropic-ai/claude-agent-sdk-win32-x64 0.3.239, 337,672,352 B)',
    account: '기본 계정(구독) — docs/critic/m3-poc.md 재현 런',
    capturedBy: 'scripts/poc-rs (poc_engine.exe <scenario>)',
    note: 'PoC 하네스가 stdin을 안 닫은 조건에서 채집 = close_policy KEEP_OPEN',
  }
  total += out.length
  console.log(`${name}.jsonl  ${out.length} frames  (src sha256 ${sha.slice(0, 12)}…)`)
}

const provPath = path.join(DST, 'PROVENANCE.json')
const prev = fs.existsSync(provPath) ? JSON.parse(fs.readFileSync(provPath, 'utf8')) : {}
fs.writeFileSync(provPath, JSON.stringify({ ...prev, ...prov, files: { ...(prev.files || {}), ...prov.files } }, null, 2))
console.log(`총 ${total} 프레임 → ${DST}`)
