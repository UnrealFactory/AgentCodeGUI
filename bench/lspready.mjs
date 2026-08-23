// M7 R4 — cpp의 `ready` n=5 p50을 **판정 도구를 한 글자도 안 고치고** 얻는다.
//
// `m7-ready.mjs`는 자기 홈을 만들지만 내려받는 서버를 이어 주는 훅이 없다(cpp는 격리 홈에
// clangd가 없어 영영 `need-install`). 그래서 여기서 홈을 먼저 만들고 실홈 설치를 정션으로
// 이은 다음, 그 도구를 `--warm`(홈 보존)으로 돌린다. 도구 자체는 무접촉.
//
//   node bench/lspready.mjs --kind tauri|electron --exe <exe> [--n 5]
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { REPO } from './lib.mjs'
import { makeFixtureHome, FIX_ID } from './fixture.mjs'
import { FIXTURES } from './lspfix.mjs'

const argv = process.argv.slice(2)
const flag = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const KIND = flag('kind', 'tauri')
const EXE = flag('exe', '')
const N = Number(flag('n', '5'))
const WORK = path.join(os.tmpdir(), 'ccg-lsp-repo')
const REL = 'lspbench_cpp/big.cpp'
const home = path.join(os.tmpdir(), `ccg-m7c-ready-${KIND}`)
const version = KIND === 'tauri' ? '3.0.0-beta.1' : '2.6.2'

const fix = FIXTURES.cpp.make(WORK, { blocks: 420 })
fs.rmSync(home, { recursive: true, force: true })
makeFixtureHome(home, version)
const f = path.join(home, 'chats', `${FIX_ID}.json`)
const chat = JSON.parse(fs.readFileSync(f, 'utf8'))
chat.manualCwd = WORK
if (chat.snapshot) chat.snapshot.cwd = WORK
fs.writeFileSync(f, JSON.stringify(chat))
console.log('link:', JSON.stringify(fix.prepareHome(home)))

const rows = []
for (let i = 1; i <= N; i++) {
  const out = path.join(REPO, 'docs', 'critic', `m7-r4-ready-${KIND}-${i}.json`)
  const args = [
    path.join(REPO, 'docs', 'critic', 'tools', 'm7-ready.mjs'),
    '--kind', KIND, '--warm', '--rel', REL, '--out', out,
    '--port', String(KIND === 'tauri' ? 9394 : 9395)
  ]
  if (EXE) args.push('--exe', EXE)
  try {
    execFileSync('node', args, { stdio: 'ignore', cwd: REPO })
  } catch (e) {
    console.log(`run ${i} 실패: ${e?.message ?? e}`)
  }
  const j = JSON.parse(fs.readFileSync(out, 'utf8'))
  const p = j.probe ?? j
  rows.push({
    i,
    apiAt: p.apiAt,
    st0SentAt: p.st0SentAt,
    st0Ms: p.st0RespAt != null && p.st0SentAt != null ? Math.round(p.st0RespAt - p.st0SentAt) : null,
    st0: p.st0,
    readyAt: p.readyAt,
    states: (p.states || []).join('>')
  })
  console.log(JSON.stringify(rows[rows.length - 1]))
  // clangd/tsserver가 완전히 걷히도록 잠깐 쉰다
  await new Promise((r) => setTimeout(r, 2500))
}
const med = (v) => {
  const s = v.filter((x) => x != null).sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : null
}
const summary = {
  kind: KIND,
  rel: REL,
  n: rows.length,
  apiAtP50: med(rows.map((r) => r.apiAt)),
  st0SentP50: med(rows.map((r) => r.st0SentAt)),
  st0RoundTripP50: med(rows.map((r) => r.st0Ms)),
  readyP50: med(rows.map((r) => r.readyAt)),
  firstStatus: rows.map((r) => r.st0),
  rows
}
const file = path.join(REPO, 'docs', 'critic', `m7-r4-ready-${KIND}.json`)
fs.writeFileSync(file, JSON.stringify(summary, null, 2))
console.log('SUMMARY', JSON.stringify({ ...summary, rows: undefined }))
console.log('→', file)
