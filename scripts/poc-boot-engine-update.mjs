#!/usr/bin/env node
/* ============================================================================
 * poc-boot-engine-update — **부팅 엔진 자동 업데이트** 실증 (R28 T1T2 수정 R1).
 *
 * 확인 크리틱이 실패시킨 한 줄을 잡는다: *「엔진도 CLI도 없는 컴퓨터에서, 설정을
 * 만진 적 없는 새 사용자는 25초를 기다려도 카드 한 장 못 본다」*
 * (`docs/critic/r28-t1t2-critic-r1.md` §4.2 — `.sd-title=null` · `.eu-card=0`).
 *
 *   src-tauri/src/engine/boot_update.rs   ← 2.6.2 `index.ts:2046 runBootEngineUpdate`
 *      → engine:update-event (REPLACE 스냅샷) → app/src/components/EngineUpdateGate.tsx
 *      → engine:update-status               → app/src/components/EngineGate.tsx (조기 반환 판정)
 *
 * ── 왜 **가짜 npm**인가 ─────────────────────────────────────────────────────
 * 이 흐름의 알맹이는 `npm install @anthropic-ai/claude-agent-sdk@latest`다. 진짜로
 * 돌리면 한 주행에 수백 MB를 받고 몇 분이 걸리며 레지스트리 응답에 따라 답이 갈린다.
 * 그래서 PATH 앞에 **가짜 npm**(`view`는 합성 패큐먼트, `install`은 폴더 하나)을 꽂아
 * 흐름 전체(조사→설치→활성화→정리)를 결정적으로 밟는다. 앱 코드에는 하네스용 분기가
 * 한 줄도 없다 — 바꾸는 것은 자식 프로세스가 보는 PATH 하나뿐이다.
 *
 * ── 안전 규칙 (사용자 실앱이 떠 있다) ───────────────────────────────────────
 *  · 이름 기반 kill 금지 — 죽이는 것은 이 스크립트가 spawn한 PID 트리뿐.
 *  · 앱 홈은 `CCG_HOME`으로 격리(`.poc-home-bootupd`). 실홈은 읽지도 않는다.
 *  · 실 네트워크 0건(`CCG_NO_NET=1` + 가짜 npm). 실계정 0건.
 *
 * 준비: CARGO_TARGET_DIR=target-t1t2 cargo build --release --features custom-protocol
 * 실행: node scripts/poc-boot-engine-update.mjs --exe=target-t1t2/release/agentcodegui.exe
 *       node scripts/poc-boot-engine-update.mjs --only=a       # 시나리오 하나만
 *       node scripts/poc-boot-engine-update.mjs --keep         # 격리 홈 보존
 * ========================================================================== */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { connectMainPage, killTree, sleep, REPO, resolveTauriExe } from '../bench/lib.mjs'

const args = process.argv.slice(2)
const only = (args.find((a) => a.startsWith('--only=')) ?? '').split('=')[1] || 'all'
const KEEP = args.includes('--keep')
const EXE = resolveTauriExe((args.find((a) => a.startsWith('--exe=')) ?? '').split('=')[1])
// 다른 갈래(T1T2 본 하네스 9361 · 크리틱 9371 · T3T4)와 안 겹치는 자리.
const PORT = 9377
const HOME = path.join(REPO, '.poc-home-bootupd')
const NPMDIR = path.join(REPO, '.poc-home-bootupd-npm')
const OUT = path.join(REPO, 'docs', 'critic', 'boot-engine-update-r1.json')
// 합성 최신 버전(순수 숫자 — `parse_packument`가 프리릴리즈를 걸러낸다).
const LATEST = { '@anthropic-ai/claude-agent-sdk': '9.9.9', '@openai/codex': '8.8.8' }

const rep = { at: new Date().toISOString(), exe: EXE, checks: [], scen: {} }
let bad = 0
const rec = (id, pass, detail) => {
  if (!pass) bad++
  rep.checks.push({ id, pass, detail })
  console.log(`  ${pass ? 'OK ' : 'XX '} ${id} — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}
const rmrf = (p) => { try { fs.rmSync(p, { recursive: true, force: true }) } catch { /* 없음 */ } }
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }

// ── 가짜 npm ────────────────────────────────────────────────────────────────
// `ccg_engine::versions`는 Windows에서 `cmd /C npm …`으로 부른다 → PATH 앞에 이걸 꽂으면
// `npm.cmd`가 먼저 잡힌다. 호출 기록은 `<NPMDIR>/calls.log`에 한 줄씩 남는다.
function writeFakeNpm() {
  rmrf(NPMDIR)
  fs.mkdirSync(NPMDIR, { recursive: true })
  fs.writeFileSync(path.join(NPMDIR, 'npm.cmd'), '@echo off\r\nnode "%~dp0fake-npm.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n')
  fs.writeFileSync(
    path.join(NPMDIR, 'fake-npm.mjs'),
    `import fs from 'node:fs'
import path from 'node:path'
const LATEST = ${JSON.stringify(LATEST)}
const argv = process.argv.slice(2)
const log = path.join(import.meta.dirname, 'calls.log')
fs.appendFileSync(log, JSON.stringify({ at: Date.now(), argv }) + '\\n')
// 진짜 npm은 install에 수십 초가 걸린다 — 그 자리를 0ms로 만들면 흐름이 사람이 볼 수
// 없는 속도로 끝나 카드의 수명을 잴 수 없다. 여기서만 인위적으로 늦춘다(앱은 모른다).
const nap = (ms) => new Promise((r) => setTimeout(r, ms))
if (argv[0] === 'install') await nap(Number(process.env.FAKE_NPM_DELAY_MS ?? 1200))
if (argv[0] === 'view') {
  const pkg = argv[1]
  const v = LATEST[pkg]
  if (!v) { console.error('unknown package'); process.exit(1) }
  process.stdout.write(JSON.stringify({ 'dist-tags': { latest: v }, versions: [v, '1.0.0'], time: { [v]: new Date().toISOString() } }))
  process.exit(0)
}
if (argv[0] === 'install') {
  if (process.env.FAKE_NPM_FAIL === '1') {
    console.log('npm ERR! code E404 (가짜 실패)')
    process.exit(1)
  }
  const at = argv[1].lastIndexOf('@')
  const pkg = argv[1].slice(0, at)
  const version = argv[1].slice(at + 1)
  const prefix = argv[argv.indexOf('--prefix') + 1]
  console.log('npm http fetch GET 200 registry (가짜)')
  const dir = path.join(prefix, 'node_modules', ...pkg.split('/'))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: pkg, version }))
  // 플랫폼 패키지의 실행본까지 심어야 claude_bin()이 실제로 그것을 고른다.
  if (pkg === '@anthropic-ai/claude-agent-sdk') {
    const p = path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64')
    fs.mkdirSync(p, { recursive: true })
    fs.writeFileSync(path.join(p, 'claude.exe'), 'stub')
  }
  console.log('added 1 package in 0s (가짜)')
  process.exit(0)
}
process.exit(0)
`
  )
}
const npmCalls = () => {
  try {
    return fs.readFileSync(path.join(NPMDIR, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).argv)
  } catch { return [] }
}
const clearNpmLog = () => { try { fs.rmSync(path.join(NPMDIR, 'calls.log')) } catch { /* 없음 */ } }

// ── 격리 홈 ─────────────────────────────────────────────────────────────────
/** `autoUpdate:null` = **파일을 안 만든다** = 기본값(켬) — 크리틱이 잰 그 판이다. */
function seedHome({ autoUpdate = null, installed = null } = {}) {
  rmrf(HOME)
  fs.mkdirSync(path.join(HOME, 'work'), { recursive: true })
  fs.writeFileSync(path.join(HOME, 'profile.json'), JSON.stringify({ nickname: 'BOOTUPD', color: '#0EA5E9' }))
  fs.writeFileSync(
    path.join(HOME, 'ui-prefs.json'),
    JSON.stringify({ 'workspace.mode': 'single', 'sidebar.autohide': false, 'ui.lang': 'ko', 'whatsnew.seenVersion': '99.0.0' })
  )
  if (autoUpdate !== null) fs.writeFileSync(path.join(HOME, 'engine-auto-update.json'), JSON.stringify({ enabled: autoUpdate }))
  for (const [pkg, versions] of Object.entries(installed ?? {})) {
    const dir = pkg === '@openai/codex' ? 'codex-engines' : 'engines'
    const cfg = pkg === '@openai/codex' ? 'codex-config.json' : 'config.json'
    for (const v of versions) {
      const d = path.join(HOME, dir, v, 'node_modules', ...pkg.split('/'))
      fs.mkdirSync(d, { recursive: true })
      fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: pkg, version: v }))
    }
    fs.writeFileSync(path.join(HOME, cfg), JSON.stringify({ activeVersion: versions[0] }))
  }
}

/** Windows의 PATH는 대소문자가 섞여 온다 — 그대로 두고 새 키를 얹으면 자식이 둘을 본다. */
function withFakeNpm(env) {
  const out = {}
  for (const [k, v] of Object.entries(env)) if (k.toLowerCase() !== 'path') out[k] = v
  out.PATH = NPMDIR + path.delimiter + (env.PATH ?? env.Path ?? '')
  return out
}

// ── 앱 기동 ─────────────────────────────────────────────────────────────────
async function boot(extraEnv = {}) {
  const child = spawn(EXE, [], {
    cwd: REPO,
    env: withFakeNpm({ ...process.env, CCG_HOME: HOME, CCG_CDP_PORT: String(PORT), CCG_NO_NET: '1', CCG_CLAUDE_BIN: '', ...extraEnv }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  const log = []
  child.stdout.on('data', (b) => log.push(String(b)))
  child.stderr.on('data', (b) => log.push(String(b)))
  let cdp = null
  for (let attempt = 0; attempt < 6; attempt++) {
    cdp = await connectMainPage(PORT, { timeoutMs: 45000 })
    try {
      const ready = await cdp.eval(
        `(async()=>{for(let i=0;i<160;i++){if(window.api&&document.querySelector('#root')?.children.length)return 1;await new Promise(r=>setTimeout(r,50))}return 0})()`,
        { awaitPromise: true, timeoutMs: 20000 }
      )
      if (ready) return { child, cdp, log }
    } catch { /* 네비게이션 — 다시 붙는다 */ }
    try { cdp.close() } catch { /* 이미 닫힘 */ }
    await sleep(400)
  }
  throw new Error('앱이 준비되지 않았다(window.api·#root)')
}
const down = async (app) => { try { app.cdp.close() } catch { /* 이미 닫힘 */ } killTree(app.child.pid); await sleep(700) }

const V = async (cdp, expr, ms = 30000) => {
  const r = await cdp.eval(`(async()=>{try{return {v: await (${expr})}}catch(e){return {err:String(e&&e.message||e)}}})()`, { awaitPromise: true, timeoutMs: ms })
  if (r?.err) throw new Error(`${expr} → ${r.err}`)
  return r?.v
}
const poll = async (cdp, expr, ms = 25000, step = 250) => {
  const t0 = Date.now()
  for (;;) {
    const v = await cdp.eval(expr).catch(() => null)
    if (v) return v
    if (Date.now() - t0 > ms) return null
    await sleep(step)
  }
}
const gateTitle = (cdp, ms) => poll(cdp, `(()=>{const e=document.querySelector('.set-dialog-overlay .set-dialog .sd-title');return e?e.textContent:0})()`, ms)
const euCard = (cdp) => cdp.eval(`!!document.querySelector('.eu-card')`)
/** 부팅 업데이터가 결론(`active` 또는 `done`)을 낼 때까지. */
async function settle(cdp, ms = 25000) {
  const t0 = Date.now()
  let last = null
  for (;;) {
    last = await V(cdp, `window.api.engineUpdate.status()`)
    if (last?.done) return { st: last, ms: Date.now() - t0 }
    if (Date.now() - t0 > ms) return { st: last, ms: Date.now() - t0, timeout: true }
    await sleep(250)
  }
}

// ── A. 기본 설정 · 엔진 0개 → 부팅 업데이터가 깔고 카드로 말한다 ─────────────
async function scenFresh() {
  console.log('\n── A · 기본값(자동 업데이트 켬) · 엔진 0개 ────────────────')
  const s = (rep.scen.fresh = {})
  seedHome({ autoUpdate: null })
  clearNpmLog()
  const app = await boot()
  try {
    const { cdp } = app
    s.autoUpdate = await V(cdp, `window.api.engineAutoUpdate()`)
    rec('A0 자동 업데이트 기본값이 켬(=크리틱이 잰 그 판)', s.autoUpdate === true, s.autoUpdate)
    // ★ 크리틱이 null을 본 자리 — 이제 진행 카드가 뜬다
    const card = await poll(cdp, `!!document.querySelector('.eu-card')`, 25000, 200)
    s.euCard = !!card
    s.cardMs = Date.now()
    rec('A1 ★ 엔진 없는 컴퓨터에서 안내 카드가 뜬다(.eu-card)', s.euCard, { euCard: s.euCard })
    s.rows = await cdp.eval(`[...document.querySelectorAll('.eu-card .eu-row')].map(r=>r.textContent.replace(/\\s+/g,' ').trim())`)
    rec('A2 카드가 두 엔진을 줄로 보여준다', (s.rows ?? []).length >= 2, s.rows)
    const { st, ms } = await settle(cdp, 30000)
    s.final = st
    s.settleMs = ms
    rec('A3 흐름이 끝까지 간다(done · cleanup done)', st?.done === true && st?.cleanup === 'done', { done: st?.done, cleanup: st?.cleanup, ms })
    const items = st?.items ?? []
    rec('A4 두 엔진 모두 설치·활성화 성공', items.length === 2 && items.every((i) => i.status === 'done'), items.map((i) => `${i.id} ${i.from ?? 'null'}→${i.to} ${i.status}`))
    rec('A5 신규 설치는 from=null(카드가 「새로 설치」로 그린다)', items.every((i) => i.from === null), items.map((i) => i.from))
    s.cfg = rj(path.join(HOME, 'config.json'))
    s.codexCfg = rj(path.join(HOME, 'codex-config.json'))
    rec('A6 디스크 활성 표식', s.cfg?.activeVersion === LATEST['@anthropic-ai/claude-agent-sdk'] && s.codexCfg?.activeVersion === LATEST['@openai/codex'], { claude: s.cfg, codex: s.codexCfg })
    s.state = await V(cdp, `window.api.engine.state()`)
    rec('A7 engine:state가 방금 깐 것을 본다', s.state?.active === LATEST['@anthropic-ai/claude-agent-sdk'], s.state)
    s.npm = npmCalls().map((a) => a.slice(0, 2).join(' '))
    rec('A8 npm 왕복 = view 2 + install 2', s.npm.filter((c) => c.startsWith('view')).length === 2 && s.npm.filter((c) => c.startsWith('install')).length === 2, s.npm)
    s.gateTitle = await cdp.eval(`(()=>{const e=document.querySelector('.set-dialog-overlay .set-dialog .sd-title');return e?e.textContent:null})()`)
    rec('A9 안내 카드 둘이 겹치지 않는다(EngineGate는 물러난다)', s.gateTitle === null, s.gateTitle)
    // 카드는 성공하면 스스로 닫힌다(1.65초)
    await sleep(2200)
    s.cardAfter = await euCard(cdp)
    rec('A10 성공 카드는 스스로 닫힌다', s.cardAfter === false, s.cardAfter)
  } finally { await down(app) }
}

// ── B. 아무도 안 도는 판 → EngineGate가 말한다 (조기 반환 좁히기의 증명) ─────
async function scenNobodyRunning() {
  console.log('\n── B · 자동 업데이트는 켬인데 아무도 안 도는 판 ───────────')
  const s = (rep.scen.nobody = {})
  seedHome({ autoUpdate: null })
  clearNpmLog()
  // 부팅 업데이터만 끈다 — **자동 업데이트 플래그는 기본값(켬) 그대로**다.
  // R1의 3.0이 영구적으로 앉아 있던 상태(플래그는 켬 · 도는 것은 없음)와 같다.
  const app = await boot({ CCG_NO_BOOT_ENGINE_UPDATE: '1' })
  try {
    const { cdp } = app
    s.autoUpdate = await V(cdp, `window.api.engineAutoUpdate()`)
    s.status = await V(cdp, `window.api.engineUpdate.status()`)
    const t0 = Date.now()
    s.gateTitle = await gateTitle(cdp, 25000)
    s.ms = Date.now() - t0
    rec('B1 ★ 자동 업데이트가 켜져 있어도, 아무도 안 돌면 설치 안내가 뜬다', s.gateTitle === 'Claude 엔진 설치', { title: s.gateTitle, autoUpdate: s.autoUpdate, status: s.status, ms: s.ms })
    s.msg = await cdp.eval(`(()=>{const e=document.querySelector('.set-dialog .sd-msg');return e?e.textContent:null})()`)
    rec('B2 안내가 설치할 버전을 말한다', (s.msg ?? '').includes(LATEST['@anthropic-ai/claude-agent-sdk']), s.msg)
    s.euCard = await euCard(cdp)
    rec('B3 진행 카드는 안 뜬다(도는 것이 없으므로)', s.euCard === false, s.euCard)
  } finally { await down(app) }
}

// ── C. 할 일 없음 → 카드 없이 조용히 끝나고 옛 버전만 정리한다 ───────────────
async function scenNoWork() {
  console.log('\n── C · 최신이 이미 활성 + 옛 버전 하나 ────────────────────')
  const s = (rep.scen.noWork = {})
  seedHome({
    autoUpdate: null,
    installed: {
      '@anthropic-ai/claude-agent-sdk': [LATEST['@anthropic-ai/claude-agent-sdk'], '1.0.0'],
      '@openai/codex': [LATEST['@openai/codex'], '1.0.0']
    }
  })
  clearNpmLog()
  const app = await boot()
  try {
    const { cdp } = app
    const { st, ms } = await settle(cdp, 25000)
    s.final = st
    s.settleMs = ms
    rec('C1 할 일이 없으면 active=false로 끝난다', st?.active === false && st?.done === true, { ...st, ms })
    s.euCard = await euCard(cdp)
    s.gateTitle = await cdp.eval(`(()=>{const e=document.querySelector('.set-dialog-overlay .set-dialog .sd-title');return e?e.textContent:null})()`)
    rec('C2 카드가 한 장도 안 뜬다(할 말이 없다)', s.euCard === false && s.gateTitle === null, { euCard: s.euCard, gateTitle: s.gateTitle })
    s.state = await V(cdp, `window.api.engine.state()`)
    s.codexState = await V(cdp, `window.api.codexEngine.state()`)
    rec('C3 옛 버전은 정리됐다(최신 하나만 남는다)',
      JSON.stringify(s.state?.installed) === JSON.stringify([LATEST['@anthropic-ai/claude-agent-sdk']]) &&
      JSON.stringify(s.codexState?.installed) === JSON.stringify([LATEST['@openai/codex']]),
      { claude: s.state?.installed, codex: s.codexState?.installed })
    s.npm = npmCalls().map((a) => a.slice(0, 2).join(' '))
    rec('C4 설치는 한 번도 안 돈다', s.npm.every((c) => !c.startsWith('install')), s.npm)
  } finally { await down(app) }
}

// ── D. 설치 실패 → 카드가 사유를 남기고 안 닫힌다 ────────────────────────────
async function scenInstallFails() {
  console.log('\n── D · 설치가 실패하는 판 ─────────────────────────────────')
  const s = (rep.scen.fail = {})
  seedHome({ autoUpdate: null })
  clearNpmLog()
  const app = await boot({ FAKE_NPM_FAIL: '1' })
  try {
    const { cdp } = app
    const { st } = await settle(cdp, 30000)
    s.final = st
    rec('D1 실패해도 흐름은 끝까지 간다', st?.done === true, { done: st?.done, cleanup: st?.cleanup })
    const items = st?.items ?? []
    rec('D2 실패가 항목에 사유와 함께 남는다', items.length === 2 && items.every((i) => i.status === 'error' && !!i.error), items.map((i) => `${i.id}: ${i.error}`))
    await sleep(2200)
    s.euCard = await euCard(cdp)
    s.err = await cdp.eval(`(()=>{const e=document.querySelector('.eu-card .eu-err');return e?e.textContent:null})()`)
    rec('D3 실패 카드는 스스로 닫히지 않는다', s.euCard === true, { euCard: s.euCard, err: s.err })
    s.state = await V(cdp, `window.api.engine.state()`)
    rec('D4 반쪽 폴더는 설치본으로 안 잡힌다', (s.state?.installed ?? []).length === 0 && s.state?.active === null, s.state)
  } finally { await down(app) }
}

;(async () => {
  if (!fs.existsSync(EXE)) throw new Error(`없음: ${EXE}`)
  console.log(`[boot-engine-update] exe=${EXE}`)
  writeFakeNpm()
  if (only === 'all' || only === 'a') await scenFresh()
  if (only === 'all' || only === 'b') await scenNobodyRunning()
  if (only === 'all' || only === 'c') await scenNoWork()
  if (only === 'all' || only === 'd') await scenInstallFails()
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  rep.pass = bad === 0
  fs.writeFileSync(OUT, JSON.stringify(rep, null, 2))
  console.log(`\n[boot-engine-update] ${rep.checks.length}개 중 실패 ${bad} → ${path.relative(REPO, OUT)}`)
  for (const c of rep.checks.filter((c) => !c.pass)) console.log(`   XX ${c.id}`)
  if (!KEEP) { rmrf(HOME); rmrf(NPMDIR) }
  process.exit(bad === 0 ? 0 : 1)
})().catch((e) => { console.error('[boot-engine-update] 치명:', e); process.exit(2) })
