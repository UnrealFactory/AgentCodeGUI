#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// critic-m2-api — api-config / api-usage의 **2.6.2 왕복 호환**을 양방향으로 잰다.
//
//   A. 실홈 복사본에서 키 복호(승계) 재현 — keyDecrypts
//   B. **2.6.2(Electron safeStorage) → 3.0**: v10 암호문을 3.0이 읽는가
//   C. **3.0 → 2.6.2(Electron safeStorage)**: 3.0이 쓴 DPAPI 암호문을 2.6.2가 읽는가
//      (보고서 §4의 "되돌려도 키가 안 죽는다" 주장)
//   D. api-usage 손상 줄·회전 파리티
//
//   node docs/critic/tools/critic-m2-api.mjs
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { REPO, cli, cloneReal, readJSON, rmrf, writeResult } from './critic-m2-lib.mjs'

const rep = { at: new Date().toISOString(), findings: [] }
const F = (item, d) => rep.findings.push({ item, ...d })
const ELECTRON = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe')

/** 격리 userData로 Electron을 띄워 safeStorage를 부른다(설치본 홈은 안 건드린다). */
function electron(script, { userData }) {
  const dir = path.join(os.tmpdir(), `ccg-critic-m2-el-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(dir, { recursive: true })
  const outFile = path.join(dir, 'out.json')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'ccg-critic-el', main: 'main.js' }))
  fs.writeFileSync(
    path.join(dir, 'main.js'),
    `const { app, safeStorage } = require('electron')
const fs = require('fs')
app.setPath('userData', ${JSON.stringify(userData)})
app.whenReady().then(() => {
  const out = { available: safeStorage.isEncryptionAvailable() }
  try { ${script} } catch (e) { out.error = String(e && e.message) }
  fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify(out))
  app.exit(0)
})`
  )
  const r = spawnSync(ELECTRON, [dir], { encoding: 'utf8', timeout: 90_000 })
  const res = readJSON(outFile) ?? { error: `electron 실패(${r.status}): ${(r.stderr || '').slice(0, 200)}` }
  rmrf(dir)
  return res
}

/** 설치본(2.6.2)의 Local State를 격리 userData로 복사 — 벤치 픽스처와 같은 규약.
 *  이게 없으면 Electron이 새 OSCrypt 키를 만들고, 그 키는 `app.exit()`에서 디스크에
 *  안 남아 v10 암호문이 **아무도 못 푸는 값**이 된다(테스트 아티팩트). */
function seedLocalState(userData) {
  const src = path.join(process.env.APPDATA ?? '', 'agent-code-gui', 'Local State')
  if (!fs.existsSync(src)) return false
  fs.mkdirSync(userData, { recursive: true })
  fs.copyFileSync(src, path.join(userData, 'Local State'))
  return true
}

// ── A. 실홈 복사본 승계 ─────────────────────────────────────────────────────
{
  const home = cloneReal('api')
  const cfg = readJSON(path.join(home, 'api-config.json')) ?? {}
  const bytes = Buffer.from(typeof cfg.key === 'string' ? cfg.key : '', 'base64')
  const st = cli(home, ['api-status']).json
  rep.inherit = {
    fileScheme: bytes.subarray(0, 3).toString() === 'v10' ? 'v10(OSCrypt AES-GCM)' : bytes.subarray(0, 4).toString('hex') === '01000000' ? 'DPAPI 직접' : 'unknown',
    enc: cfg.enc,
    keyTail: cfg.keyTail,
    budgetUsd: cfg.budgetUsd,
    keyDecrypts: st?.keyDecrypts ?? null,
    keyLen: st?.keyLen ?? null,
    status: st?.status ?? null,
    encryptionAvailable: st?.encryptionAvailable ?? null,
    localStateFound: fs.existsSync(path.join(process.env.APPDATA ?? '', 'agent-code-gui', 'Local State'))
  }
  if (cfg.key && !rep.inherit.keyDecrypts) F('A. 실홈의 API 키를 3.0이 복호하지 못한다', rep.inherit)
  rep.inherit.usage = { records: (cli(home, ['api-usage']).json ?? []).length }
  rmrf(home)
}

// ── B. 2.6.2(Electron v10) → 3.0 ────────────────────────────────────────────
{
  const home = path.join(os.tmpdir(), `ccg-critic-m2-api-b-${Date.now()}`)
  fs.mkdirSync(path.join(home, 'userData'), { recursive: true })
  const KEY = 'sk-ant-2_6_2-side-ABCD'
  const seeded = seedLocalState(path.join(home, 'userData'))
  const e = electron(`out.enc = safeStorage.encryptString(${JSON.stringify(KEY)}).toString('base64')`, { userData: path.join(home, 'userData') })
  const enc = e.enc ?? ''
  fs.writeFileSync(path.join(home, 'api-config.json'), JSON.stringify({ key: enc, enc: true, keyTail: KEY.slice(-4), budgetUsd: 12.5, spentUsd: 1.25 }, null, 2))
  const st = cli(home, ['api-status']).json
  rep.electronToTauri = {
    electronPrefix: Buffer.from(enc, 'base64').subarray(0, 3).toString(),
    localStateSeededFromInstall: seeded,
    localState: fs.existsSync(path.join(home, 'userData', 'Local State')),
    keyDecrypts: st?.keyDecrypts ?? null,
    keyLen: st?.keyLen ?? null,
    statusBudget: st?.status?.budgetUsd ?? null
  }
  if (!rep.electronToTauri.keyDecrypts) F('B. 2.6.2가 쓴 v10 키를 3.0이 못 읽는다', rep.electronToTauri)
  rmrf(home)
}

// ── C. 3.0(DPAPI) → 2.6.2(Electron) ─────────────────────────────────────────
// 3.0의 쓰기는 IPC에만 있으므로 critic-m2-tauri.mjs가 남긴 실제 암호문을 쓴다.
{
  const keyFile = path.join(os.tmpdir(), 'ccg-critic-m2-key.txt')
  if (fs.existsSync(keyFile)) {
    const b64 = fs.readFileSync(keyFile, 'utf8')
    const ud = path.join(os.tmpdir(), `ccg-critic-m2-ud-${Date.now()}`)
    fs.mkdirSync(ud, { recursive: true })
    const e = electron(`out.dec = safeStorage.decryptString(Buffer.from(${JSON.stringify(b64)}, 'base64'))`, { userData: ud })
    rep.tauriToElectron = {
      prefix: Buffer.from(b64, 'base64').subarray(0, 4).toString('hex'),
      scheme: Buffer.from(b64, 'base64').subarray(0, 3).toString() === 'v10' ? 'v10' : 'DPAPI 직접',
      electronDecrypts: typeof e.dec === 'string',
      electronError: e.error ?? null
    }
    if (!rep.tauriToElectron.electronDecrypts) F('C. 3.0이 쓴 키를 2.6.2(Electron safeStorage)가 못 읽는다 — 보고서 §4 주장 반증', rep.tauriToElectron)
    rmrf(ud)
  } else {
    rep.tauriToElectron = { skipped: 'critic-m2-tauri.mjs를 먼저 돌려라(3.0이 쓴 암호문이 필요하다)' }
  }
}

// ── D. api-usage 손상·회전 파리티 ───────────────────────────────────────────
{
  const home = path.join(os.tmpdir(), `ccg-critic-m2-api-d-${Date.now()}`)
  fs.mkdirSync(home, { recursive: true })
  const good = (ts) => JSON.stringify({ ts, model: 'Opus', source: 'chat', costUsd: 0.1, inTok: 1, outTok: 2 })
  const lines = [good(1), '{"ts":"문자열이라 버려야 한다"}', '깨진 줄', '', good(2), '{"no_ts":1}', good(3)]
  fs.writeFileSync(path.join(home, 'api-usage.jsonl'), lines.join('\n') + '\n')
  const got = cli(home, ['api-usage']).json ?? []
  rep.usageParity = { lines: lines.length, accepted: got.length, tsList: got.map((r) => r.ts) }
  if (got.length !== 3) F('D. api-usage 손상 줄 스킵이 2.6.2와 다르다', rep.usageParity)
  rmrf(home)
}

rep.ok = rep.findings.length === 0
const out = writeResult('m2-r1-api.json', rep)
console.log(JSON.stringify({ ok: rep.ok, findings: rep.findings.map((f) => f.item) }, null, 2), out)
process.exit(0)
