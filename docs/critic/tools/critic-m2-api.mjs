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
import { REPO, cli, cloneReal, readJSON, rmrf, seedLocalState, writeResult } from './critic-m2-lib.mjs'

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

// ── C. 3.0 → 2.6.2(Electron) ────────────────────────────────────────────────
// 3.0의 쓰기는 IPC에만 있으므로 critic-m2-tauri.mjs가 남긴 실제 암호문을 쓴다.
//
// ★R8 하네스 수정: `seedLocalState(ud)`가 없었다. 시드 없는 프로필의 Electron은 자기만의
// OSCrypt 키를 새로 만들어 **어떤 v10도** 못 푼다(자기가 만든 것조차 — `critic-m2-lib`의
// `seedLocalState` 주석에 실측 3행). 그래서 R1의 §C는 "2.6.2가 읽는가"가 아니라
// "시드 없는 프로필이 읽는가"를 재고 있었다. §B는 처음부터 시드했다 = 비대칭.
// 대조군(`seededProfile:false`)을 같이 실어 두 갈래가 구별되게 남긴다.
{
  const keyFile = path.join(os.tmpdir(), 'ccg-critic-m2-key.txt')
  if (fs.existsSync(keyFile)) {
    const b64 = fs.readFileSync(keyFile, 'utf8')
    const bytes = Buffer.from(b64, 'base64')
    const dec = (seed) => {
      const ud = path.join(os.tmpdir(), `ccg-critic-m2-ud-${seed ? 'seed' : 'bare'}-${Date.now()}`)
      fs.mkdirSync(ud, { recursive: true })
      const seeded = seed ? seedLocalState(ud) : false
      const e = electron(`out.dec = safeStorage.decryptString(Buffer.from(${JSON.stringify(b64)}, 'base64'))`, { userData: ud })
      rmrf(ud)
      return { seeded, ok: typeof e.dec === 'string', tail: typeof e.dec === 'string' ? e.dec.slice(-4) : null, error: e.error ?? null }
    }
    const seeded = dec(true)
    const bare = dec(false)
    rep.tauriToElectron = {
      prefix: bytes.subarray(0, 4).toString('hex'),
      scheme: bytes.subarray(0, 3).toString() === 'v10' ? 'v10' : 'DPAPI 직접',
      localStateSeededFromInstall: seeded.seeded,
      electronDecrypts: seeded.ok,
      electronKeyTail: seeded.tail,
      electronError: seeded.error,
      // 대조군: 시드 없는 프로필. 여기서 실패하는 것은 **정상**(하네스 형상).
      bareProfile: { decrypts: bare.ok, error: bare.error }
    }
    if (!seeded.seeded) {
      F('C. 설치본 Local State가 없어 2.6.2 왕복을 잴 수 없다(판정 보류)', rep.tauriToElectron)
    } else if (!seeded.ok) {
      F('C. 3.0이 쓴 키를 2.6.2(Electron safeStorage)가 못 읽는다', rep.tauriToElectron)
    }
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
