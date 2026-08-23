#!/usr/bin/env node
/**
 * ★M11 R3 확인 크리틱 — **진짜 2.6.2 코드와 3.0 배경 쓰기를 같은 홈에서 겹친다.**
 *
 * R3의 실증(`crates/ccg-auth/tests/m11r3_store_race.rs`)과 R2 크리틱 T4는 자식도
 * `ccg-auth`를 쓴다 = **자식도 잠금을 잡는다**. 그건 "3.0 두 벌"의 판이지 "3.0 + 2.6.2"가
 * 아니다. 여기서는 로그아웃을 **2.6.2 실코드**(`src/main/auth.ts::removeAccount` —
 * readStoreFile → writeStoreFile → deleteAccountDir, 잠금 없음)가 한다.
 *
 * ## 왜 설치본 exe가 아니라 실코드 번들인가 (안전)
 *
 * | 막힌 길 | 이유 |
 * |---|---|
 * | 설치본 `AgentCodeGUI.exe` | `auth.ts:76 APP_HOME = os.homedir()/.agentcodegui` — **CCG_HOME 오버라이드가 없다**. 격리가 불가능하고 사용자 실홈·실토큰을 건드린다 |
 * | 설치본 + `USERPROFILE` 치환 | `src/main/index.ts:56` 주석이 못 쓴다고 못 박은 길(크래시패드 exit 127 · Electron이 env 무시) |
 * | dev(`npm run dev`) | CCG_HOME은 `versions.ts`·`userData`만 옮긴다. **auth.ts는 여전히 실홈**이다 |
 * | 설치본을 그냥 띄우기 | 사용자 실앱이 떠 있으면 단일 인스턴스 락에 즉사한다(실측: 5 PID 상주) |
 *
 * 그래서 **같은 소스**(`src/main/auth.ts`)를 esbuild로 번들해 **같은 Electron 런타임**
 * (node_modules/electron — 설치본과 같은 major)에서 돌린다. 바꾼 것은 0줄이고,
 * `USERPROFILE`은 Node의 `os.homedir()`가 존중하므로 홈이 진짜로 격리된다.
 * 네트워크 호출이 있는 `authLogout`(= `claude auth logout` 토큰 해지)은 **부르지 않는다** —
 * 스토어를 고치는 반쪽 `removeAccount`만 부른다. 계정은 전부 합성이다.
 *
 * 돌리는 법:
 * ```text
 * node docs/critic/tools/critic-m11r3-262race.mjs --exe=<critic_m11r3_attack.exe> [--rounds=100] [--out=-m11r3c]
 * ```
 */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..')
const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`))
  return hit ? hit.slice(k.length + 3) : d
}
const ROUNDS = Number(arg('rounds', '100'))
const TAG = arg('out', '-m11r3c')
const EXE = arg('exe', '')
if (!EXE || !fs.existsSync(EXE)) {
  console.error('--exe=<critic_m11r3_attack 테스트 바이너리> 가 필요하다')
  process.exit(2)
}

// ── 격리 홈 ─────────────────────────────────────────────────────────────────
const ISO = path.join(os.tmpdir(), `ccg-m11r3c-262-${process.pid}`)
fs.rmSync(ISO, { recursive: true, force: true })
const HOME = path.join(ISO, '.agentcodegui')
fs.mkdirSync(HOME, { recursive: true })
fs.mkdirSync(path.join(ISO, 'userData'), { recursive: true })

// ── ① 2.6.2 실코드 번들(변경 0줄) ───────────────────────────────────────────
const ENTRY = path.join(ISO, 'entry.mjs')
fs.writeFileSync(ENTRY, `export * from ${JSON.stringify(path.join(REPO, 'src/main/auth.ts').replace(/\\/g, '/'))}\n`)
const AUTH_CJS = path.join(ISO, 'auth262.cjs')
const esbuild = await import(pathToFileURL(path.join(REPO, 'node_modules/esbuild/lib/main.js')).href)
await esbuild.build({
  entryPoints: [ENTRY],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  alias: { '@shared': path.join(REPO, 'src/shared') },
  outfile: AUTH_CJS,
  logLevel: 'error'
})

// ── ② Electron 하네스 메인 ──────────────────────────────────────────────────
const MAIN = path.join(ISO, 'main262.cjs')
fs.writeFileSync(
  MAIN,
  `
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { app, safeStorage } = require('electron')
app.setPath('userData', process.env.CCG_262_USERDATA)
app.disableHardwareAcceleration()
const auth = require(process.env.CCG_262_AUTH)
const HOME = path.join(os.homedir(), '.agentcodegui')
const STORE = path.join(HOME, 'accounts.json')
const ROUNDS = Number(process.env.CCG_262_ROUNDS)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const read = () => { try { return JSON.parse(fs.readFileSync(STORE, 'utf8')) } catch { return { version: 3, accounts: [] } } }
const has = (e) => (read().accounts || []).some((a) => a.email === e)
// 픽스처(2.6.2의 writeStoreFile과 같은 8줄 모양) — **로그인만** 하네스가 흉내 낸다.
function addGhost() {
  const f = read()
  if ((f.accounts || []).some((a) => a.email === 'ghost@x')) return
  const snap = JSON.stringify({ creds: JSON.stringify({ claudeAiOauth: { accessToken: 'A-ghost', refreshToken: 'g-0', expiresAt: 4e12 } }), account: { emailAddress: 'ghost@x' } })
  const credEnc = safeStorage.encryptString(snap).toString('base64')
  const accounts = [...(f.accounts || []), { email: 'ghost@x', subscriptionType: 'max', credEnc }]
  fs.writeFileSync(STORE, JSON.stringify({ version: 3, defaultEmail: f.defaultEmail, accounts }, null, 2))
}
app.whenReady().then(async () => {
  let resurrected = 0, removed = 0
  fs.writeFileSync(path.join(process.env.CCG_262_GATE, 'go'), '1') // ★ 겹침 시작 신호
  for (let i = 0; i < ROUNDS; i++) {
    addGhost()
    await sleep(4)
    await auth.removeAccount('ghost@x') // ★ 2.6.2 실코드
    removed++
    // 되살아남은 잠깐일 수 있다 — 15ms를 1ms 간격으로 훑는다(그 순간의 파일이 곧 화면이다)
    for (let k = 0; k < 15; k++) {
      await sleep(1)
      if (has('ghost@x')) { resurrected++; break }
    }
  }
  fs.writeFileSync(path.join(process.env.CCG_262_GATE, 'done'), '1')
  console.log('[262] ' + JSON.stringify({ rounds: ROUNDS, removed, resurrected, homedir: os.homedir(), store: read().accounts.map((a) => a.email) }))
  app.exit(0)
})
`
)

// ── ③ 합성 계정 시드(3.0 쪽이 자기 credEnc를 다루므로 Rust가 심는다) ───────
const rustEnv = { ...process.env, CCG_HOME: HOME, CCG_NO_NET: '1', USERPROFILE: ISO }
const seed = execFileSync(EXE, ['--exact', 'x_seed_for_the_262_harness', '--nocapture'], {
  env: { ...rustEnv, CCG_M11R3C_SEED: 'mine@x' },
  encoding: 'utf8'
})
console.log(seed.split('\n').filter((l) => l.startsWith('[SEED]')).join('\n'))

// ── ④ 두 프로세스를 동시에 ─────────────────────────────────────────────────
const bg = spawn(EXE, ['--exact', 'x_background_writer_for_the_262_harness', '--nocapture'], {
  env: { ...rustEnv, CCG_M11R3C_BGW: `mine@x:${Math.round(ROUNDS * 3)}`, CCG_M11R3C_GATE: ISO }
})
let bgOut = ''
bg.stdout.on('data', (d) => (bgOut += d))
bg.stderr.on('data', () => {})

const el = spawn(path.join(REPO, 'node_modules/electron/dist/electron.exe'), [MAIN], {
  env: {
    ...process.env,
    USERPROFILE: ISO, // ★ Node os.homedir()가 존중한다 = auth.ts의 APP_HOME이 여기로
    HOME: ISO,
    CCG_262_AUTH: AUTH_CJS,
    CCG_262_USERDATA: path.join(ISO, 'userData'),
    CCG_262_ROUNDS: String(ROUNDS),
    CCG_262_GATE: ISO,
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
  }
})
let elOut = ''
el.stdout.on('data', (d) => (elOut += d))
el.stderr.on('data', (d) => (elOut += d))

const done = (p) => new Promise((r) => p.on('close', (c) => r(c)))
const [elCode, bgCode] = await Promise.all([done(el), done(bg)])

const line = elOut.split('\n').find((l) => l.startsWith('[262] '))
const stat = line ? JSON.parse(line.slice(6)) : null
const bgLine = bgOut.split('\n').find((l) => l.startsWith('[BGW] '))
console.log(bgLine || '(bg 출력 없음)')
console.log(line || elOut.slice(-2000))

const report = {
  tool: 'critic-m11r3-262race',
  rounds: ROUNDS,
  isolatedHome: HOME,
  realHomeTouched: false,
  electronExit: elCode,
  bgExit: bgCode,
  the262: stat,
  bg: bgLine || null
}
// 안전 확인 — 실홈은 열지도 않았다(경로 문자열로 확인).
report.realHomeTouched = !!(stat && !String(stat.homedir).startsWith(ISO))
const out = path.join(REPO, 'docs/critic', `m11-r3-262race${TAG}.json`)
fs.writeFileSync(out, JSON.stringify(report, null, 2))
console.log(`→ ${out}`)
if (report.realHomeTouched) {
  console.error('★ 하네스가 실홈을 봤다 — 즉시 중단')
  process.exit(3)
}
