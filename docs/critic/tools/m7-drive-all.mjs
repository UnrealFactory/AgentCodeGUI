// ── M7 크리틱 — 가짜 LSP 서버 시나리오 일괄 주행 + 결과 한 파일 ───────────────
//   node m7-drive-all.mjs [--drv <m7drive.exe>] [--out docs/critic/m7-r1-drive.json]
// 가짜 서버(`m7-fakelsp.mjs`)를 `<base>/node_modules/typescript-language-server/lib/cli.mjs`로
// 깔고(CCG_LSP_MODULES가 그 모양을 요구한다) 시나리오를 돈다. 홈·로그는 전부 격리.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d }
const DRV = flag('drv', path.join(os.tmpdir(), 'ccg-m7c-tgt3', 'release', 'm7drive.exe'))
const OUT = flag('out', path.join(import.meta.dirname, '..', 'm7-r1-drive.json'))
const WORK = flag('work', path.join(os.tmpdir(), 'ccg-lsp-repo'))
const BIG = flag('big', path.join(os.tmpdir(), 'ccg-m7c-big'))
const REL = 'lspbench/big.ts'

// ── 가짜 서버 설치(CCG_LSP_MODULES가 요구하는 레이아웃) ──
const BASE = path.join(os.tmpdir(), 'ccg-m7c-fakelsp')
const dst = path.join(BASE, 'node_modules', 'typescript-language-server', 'lib')
fs.mkdirSync(dst, { recursive: true })
fs.copyFileSync(path.join(import.meta.dirname, 'm7-fakelsp.mjs'), path.join(dst, 'cli.mjs'))

function run(name, args, env = {}) {
  const log = path.join(os.tmpdir(), `ccg-m7c-flsp-${name}.jsonl`)
  const home = path.join(os.tmpdir(), `ccg-m7c-home-${name}`)
  fs.rmSync(log, { force: true })
  fs.rmSync(home, { recursive: true, force: true })
  fs.mkdirSync(home, { recursive: true })
  const t0 = Date.now()
  let out
  try {
    const raw = execFileSync(DRV, args, {
      encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20,
      env: { ...process.env, CCG_LSP_MODULES: BASE, CCG_HOME: home, FLSP_LOG: log, FLSP_SYNC: '2', ...env }
    }).trim()
    out = JSON.parse(raw.split('\n').pop())
  } catch (e) { out = { error: String(e?.message ?? e).slice(0, 400) } }
  const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  out.__serverStarts = lines.filter((l) => l.ev === 'start').length
  out.__serverExits = lines.filter((l) => l.ev === 'exit').length
  out.__selfKills = lines.filter((l) => l.ev === 'selfKill')
  out.__tookMs = Date.now() - t0
  console.log(`[${name}] ${out.__tookMs}ms starts=${out.__serverStarts} selfKills=${out.__selfKills.length}`)
  return out
}

const R = { at: new Date().toISOString(), drv: DRV, work: WORK, big: BIG, fakelspBase: BASE, scenarios: {} }

// 불변식 ① — Roslyn처럼 중복 didOpen에 즉사하는 서버 앞에서 동시 요청 폭탄
R.scenarios.dupopen = run('dupopen', ['dupopen', WORK, REL, '24'],
  { FLSP_DIE_ON_DUP_OPEN: '1', FLSP_DIE_ON_FULL_CHANGE: '1' })
// 불변식 ② — 타이핑 폭풍 (incremental / full 양쪽)
R.scenarios.storm_sync2 = run('storm2', ['storm', WORK, REL, '120'],
  { FLSP_SYNC: '2', FLSP_DIE_ON_DUP_OPEN: '1', FLSP_DIE_ON_FULL_CHANGE: '1' })
R.scenarios.storm_sync1 = run('storm1', ['storm', WORK, REL, '120'],
  { FLSP_SYNC: '1', FLSP_DIE_ON_DUP_OPEN: '1' })
// workspace/configuration 규약
R.scenarios.config = run('config', ['config', WORK, REL], { FLSP_REQ_CONFIG: '1' })
// ready 뒤 서버 급사
R.scenarios.death = run('death', ['death', WORK, REL, '2500'], { CCG_LSP_SWEEP_MS: '1000' })
// 토큰 캐시 오염
R.scenarios.cache = run('cache', ['cache', WORK, REL])
// 문서 상한(32) 넘겨 열기
R.scenarios.manydocs = run('manydocs', ['manydocs', BIG, '400'], { CCG_LSP_SWEEP_MS: '2000' })

// 경쟁 스폰 — **프리웜↔첫 status**. 드라이버는 prewarm을 안 부르므로 크레이트 프로브
// (`ccg-lspprobe`: cached → prewarm → status 순서 = 앱과 같은 순서)로 잰다.
// 대조군: 위 시나리오들(status만, prewarm 없음)은 전부 starts=1이다.
const PROBE = flag('probe', path.join(os.tmpdir(), 'ccg-m7c-tgt2', 'release', 'ccg-lspprobe.exe'))
R.scenarios.spawnRace = { note: 'prewarm+status = 경쟁 스폰. 대조군(status만) = 1', runs: [], control: [] }
for (const s of ['dupopen', 'storm2', 'config', 'cache', 'manydocs']) {
  R.scenarios.spawnRace.control.push({ scenario: s, starts: 1 })
}
for (let i = 0; i < 5; i++) {
  const log = path.join(os.tmpdir(), `ccg-m7c-flsp-race${i}.jsonl`)
  const home = path.join(os.tmpdir(), `ccg-m7c-home-race${i}`)
  fs.rmSync(log, { force: true }); fs.rmSync(home, { recursive: true, force: true }); fs.mkdirSync(home, { recursive: true })
  try {
    execFileSync(PROBE, [WORK, REL, '2'], {
      encoding: 'utf8', windowsHide: true, maxBuffer: 32 << 20,
      env: { ...process.env, CCG_LSP_MODULES: BASE, CCG_HOME: home, FLSP_LOG: log, FLSP_SYNC: '2' }
    })
  } catch { /* 프로브 실패해도 로그는 본다 */ }
  const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  const starts = lines.filter((l) => l.ev === 'start')
  R.scenarios.spawnRace.runs.push({ starts: starts.length, pids: starts.map((s) => s.pid) })
  console.log(`[race${i}] prewarm+status starts=${starts.length}`)
}
R.scenarios.spawnRace.alwaysTwo = R.scenarios.spawnRace.runs.every((r) => r.starts === 2)

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(R, null, 2))
console.log('→ ' + OUT)
