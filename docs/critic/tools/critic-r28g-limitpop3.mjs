// 최종 파리티 R5 — `limit-pop` 판별 계기, **극성을 고친 판**.
//
//   node docs/critic/tools/critic-r28g-limitpop3.mjs <tauri|electron> \
//        [--exe=<경로>] [--port=10620] [--proxyport=10629] [--runs=3] \
//        [--arm=synth-seeded|synth-bare|noacct-seeded|noacct-bare|stub] \
//        [--userprofile=<경로>] [--homeroot=<경로>] [--out=json]
//
// ── R4의 계기(critic-r28f-limitpop2.mjs)를 왜 다시 쓰는가 ────────────────────
// R4는 5h **42%**·주간 **43%**·Fable **44%** 를 심고 판별의 한 칸으로
//     `rec.sees42 = /42|43|44/.test(popText)`            (limitpop2.mjs:267)
// 를 실었다. 그런데 팝오버는 **남은 비율**을 그린다 —
//     app/src/components/Chat.tsx:3640   const rem = w ? Math.max(0, 100 - Math.round(w.pct)) : null
//     src/renderer/src/components/Chat.tsx:2823  (2.6.2 · 같은 식)
// 그러므로 42/43/44가 `usage:get`에 닿았다면 화면에 뜨는 숫자는 **58/57/56**이다.
// `sees42`는 **가설이 참이어도 절대 안 켜진다** = 판별력 0. (확인 크리틱 R28f-AUDIT-R2 G1)
// 이 판은 그 칸을 **`seesRemain`(=100−pct)** 으로 고치고, `seesPlanted`(옛 극성)를
// 나란히 기록해 「옛 칸이 왜 못 켜졌나」를 같은 파일에서 볼 수 있게 한다.
//
// ── `--arm=stub` : 계기 자체의 판별력을 증명하는 양성 대조 ───────────────────
// 계정도 캐시도 없는 홈으로 앱을 띄운 뒤 `window.api.getUsage`를 **심은 값 그대로의
// pct**(기본 42/43/44)를 돌려주는 스텁으로 갈고, 제품 경로(설정 모달 열고 닫기 →
// `App.tsx:585 getUsage(true)`)로 재조회를 태운 다음 같은 팝오버를 다시 연다.
//   · 값이 오면 → `.wb-prow` **5행**(Fable 행이 생긴다) · `hasNoData=false` ·
//     화면 숫자 **58/57/56** → `seesRemain=true` · `seesPlanted=false`
//   · 즉 「4행·데이터 없음」은 **계기 무능이 아니라 실측**이다.
//
// ── 문을 여는 방법 · 안전 규약은 R4와 같다(합성 계정 · 실 HTTP 0) ────────────
// 합성 클로드 계정 하나를 격리 홈에 심는다. 두 앱 다 `account_access_token` /
// `accountAccessToken`이 **만료만** 보므로 네트워크·회전 0으로 조기 반환문
// (`ipc/parity/usage.rs:183` · `src/main/index.ts:1027`)을 지난다.
// 나가려는 HTTP는 3.0=`HTTPS_PROXY` 싱크(CONNECT를 502로 끊는다) ·
// 2.6.2=토큰 개행(undici `Headers.append`가 소켓 전에 TypeError)로 막는다.
// 실홈 자격증명은 읽지도 복사하지도 않는다(픽스처가 복사한 것은 기동 **전에** 삭제).
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { electronProfile, tauriProfile, cdpTargets, Cdp, killTree, sleep, REPO } from '../../../bench/lib.mjs'
import { makeFixtureHome } from '../../../bench/fixture.mjs'
import { augmentFixture } from '../../../bench/screens.mjs'

const kind = process.argv[2] ?? 'tauri'
const argv = process.argv.slice(3)
const arg = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d }
const PORT = Number(arg('port', kind === 'tauri' ? 10620 : 10621))
const PROXY_PORT = Number(arg('proxyport', 10629))
const RUNS = Number(arg('runs', 3))
const ARM = arg('arm', 'synth-seeded')
const SETTLE_MS = Number(arg('settle', 8000))
const POP_MS = Number(arg('popwait', 3500))
const HOMEROOT = arg('homeroot', 'C:\\Temp\\ccg-r28g-audit')
const UPROF = arg('userprofile', '')
const OUT = path.resolve(arg('out', path.join(REPO, 'docs', 'critic', `final-parity-r5-limitpop-${kind}-${ARM}.json`)))
const APP_VERSION = kind === 'tauri' ? '3.0.0-beta.1' : '2.6.2'

const STUB = ARM === 'stub'
const WITH_ACCT = ARM.startsWith('synth')
const SEEDED = ARM.endsWith('seeded')
const SYN_EMAIL = 'audit-r5@example.invalid'
// 심는 pct — 화면에는 100−pct 로 떠야 한다.
const PCT = { five: Number(arg('five', 42)), weekly: Number(arg('weekly', 43)), fable: Number(arg('fable', 44)) }
const REM = { five: 100 - PCT.five, weekly: 100 - PCT.weekly, fable: 100 - PCT.fable }
// 2.6.2만 개행을 넣는다(undici가 소켓 전에 죽는다). 3.0은 프록시 싱크가 막는다.
const SYN_TOKEN = kind === 'tauri'
  ? 'synthetic-audit-r5-access-token-not-real'
  : 'synthetic-audit-r5-access-token\nnot-real'

function accountSlug(email) {
  const safe = email.toLowerCase().replace(/[^a-z0-9._-]+/g, '_')
  let h = 0
  for (let i = 0; i < email.length; i++) h = (Math.imul(h, 31) + email.charCodeAt(i)) >>> 0
  return `${safe}-${h.toString(36)}`
}

/** 합성 계정 — 실홈에서 한 바이트도 안 가져온다. */
function plantAccount(root) {
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'accounts.json'), JSON.stringify({
    version: 3,
    defaultEmail: SYN_EMAIL,
    accounts: [{ email: SYN_EMAIL, subscriptionType: 'max' }]
  }, null, 2))
  const dir = path.join(root, 'accounts', accountSlug(SYN_EMAIL))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({
    claudeAiOauth: {
      accessToken: SYN_TOKEN,
      refreshToken: 'synthetic-audit-r5-refresh-token-not-real',
      expiresAt: Date.now() + 30 * 24 * 3600 * 1000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max'
    }
  }))
}

/** 심는 디스크 캐시 — 합성 계정의 이메일로 키를 잡고 값을 유별나게 둔다. */
function plantCache(root) {
  fs.mkdirSync(root, { recursive: true })
  const now = Date.now()
  fs.writeFileSync(path.join(root, 'usage-cache.json'), JSON.stringify({
    [SYN_EMAIL]: {
      at: now,
      data: {
        email: SYN_EMAIL,
        fiveHourPct: PCT.five,
        weeklyPct: PCT.weekly,
        fablePct: PCT.fable,
        fiveHourResetsAt: now + 3 * 3600 * 1000,
        weeklyResetsAt: now + 3 * 24 * 3600 * 1000,
        fableResetsAt: now + 3 * 24 * 3600 * 1000
      }
    }
  }))
}

const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16) } catch { return null } }

// ── 프록시 싱크(3.0 전용) — CONNECT를 받고 502로 끊는다. 밖으로 한 바이트도 안 나간다.
const proxyHits = []
let sink = null
if (kind === 'tauri') {
  sink = http.createServer((req, res) => {
    proxyHits.push({ at: new Date().toISOString(), method: req.method, url: req.url })
    res.writeHead(502); res.end('sink')
  })
  sink.on('connect', (req, socket) => {
    proxyHits.push({ at: new Date().toISOString(), method: 'CONNECT', url: req.url })
    try { socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n') } catch { /* 이미 닫힘 */ }
    try { socket.destroy() } catch { /* 이미 닫힘 */ }
  })
  await new Promise((r) => sink.listen(PROXY_PORT, '127.0.0.1', r))
}

const out = {
  app: kind === 'tauri' ? 'tauri-3.0.0' : 'electron-2.6.2',
  kind,
  arm: ARM,
  withAccount: WITH_ACCT,
  seededDiskCache: SEEDED,
  stubControl: STUB,
  syntheticEmail: WITH_ACCT ? SYN_EMAIL : null,
  at: new Date().toISOString(),
  settleMs: SETTLE_MS,
  plantedPct: PCT,
  expectedOnScreen: REM,
  netBlock: kind === 'tauri'
    ? `HTTPS_PROXY=http://127.0.0.1:${PROXY_PORT} (CONNECT를 502로 끊는 싱크 — 외부로 0바이트)`
    : 'accessToken에 개행 — undici Headers.append가 소켓 전에 TypeError (외부로 0바이트)',
  discriminator: STUB
    ? `양성 대조 — getUsage를 pct ${PCT.five}/${PCT.fable}/${PCT.weekly} 스텁으로 갈면 팝오버는 5행이고 화면 숫자는 ${REM.five}/${REM.fable}/${REM.weekly}`
    : `심은 디스크 캐시 pct ${PCT.five}/${PCT.weekly}/${PCT.fable} — **닿으면 팝오버가 5행이 되고 화면에는 ${REM.five}/${REM.fable}/${REM.weekly}(=100−pct)가 뜬다**`,
  polarityNote: '팝오버는 남은 비율을 그린다(Chat.tsx:3640 rem = 100 - round(pct)). R4의 sees42(=/42|43|44/)는 가설이 참이어도 안 켜진다 — 판별력 0.',
  safety: '실홈 자격증명 복사 0 · 합성 계정(example.invalid)만 · 실 HTTP 0',
  runs: []
}

async function connectMain(port, timeoutMs = 90000) {
  const t0 = Date.now()
  for (;;) {
    try {
      const ts = await cdpTargets(port)
      const t = ts.find((x) => x.type === 'page' && !x.url.startsWith('data:') && !/toast\.html|tray\.html/.test(x.url) && !x.url.includes('#') && /index\.html|localhost/.test(x.url))
      if (t?.webSocketDebuggerUrl) return await Cdp.connect(t.webSocketDebuggerUrl)
    } catch { /* 아직 */ }
    if (Date.now() - t0 > timeoutMs) throw new Error('main target not found')
    await sleep(80)
  }
}

function buildHome(i) {
  const home = path.join(HOMEROOT, `home-lp3-${kind}-${ARM}-${i}`)
  try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 잠기면 덮어쓴다 */ }
  makeFixtureHome(home, APP_VERSION)
  augmentFixture(home, { repo: REPO })
  // ★안전: 픽스처가 복사한 실계정 자격증명을 앱이 켜지기 전에 지운다.
  const removed = []
  for (const f of ['accounts.json', 'codex-accounts.json']) {
    const p = path.join(home, f)
    if (fs.existsSync(p)) { fs.rmSync(p); removed.push(f) }
  }
  try { fs.rmSync(path.join(home, 'accounts'), { recursive: true, force: true }) } catch { /* 없으면 그만 */ }
  try { fs.rmSync(path.join(home, 'usage-cache.json'), { force: true }) } catch { /* 없으면 그만 */ }

  // 2.6.2는 `CCG_HOME`을 무시하고 `os.homedir()/.agentcodegui`를 본다.
  const uhome = UPROF ? path.join(UPROF, '.agentcodegui') : null
  if (uhome) {
    fs.mkdirSync(uhome, { recursive: true })
    for (const f of ['accounts.json', 'codex-accounts.json', 'usage-cache.json']) { try { fs.rmSync(path.join(uhome, f), { force: true }) } catch { /* 없음 */ } }
    try { fs.rmSync(path.join(uhome, 'accounts'), { recursive: true, force: true }) } catch { /* 없음 */ }
  }
  const targets = [home, ...(uhome ? [uhome] : [])]
  if (WITH_ACCT) for (const t of targets) plantAccount(t)
  if (SEEDED) for (const t of targets) plantCache(t)
  const effective = uhome ?? home
  return {
    home,
    uhome,
    removed,
    cacheBytes: SEEDED ? fs.statSync(path.join(effective, 'usage-cache.json')).size : null,
    cacheSha: SEEDED ? sha(path.join(effective, 'usage-cache.json')) : null
  }
}

const HELP = `(() => { window.__all = (s) => [...document.querySelectorAll(s)]; return true })()`
const TIMED = (expr) => `(async () => { const t0 = Date.now(); let v, e = null; try { v = await (${expr}) } catch (x) { e = String(x && x.message || x) } return JSON.stringify({ ms: Date.now() - t0, v: v === undefined ? null : v, e }) })()`

// 팝오버를 열고(=워크바 5번째 칩) 읽는다. 이미 열려 있으면 한 번 닫았다 연다.
const OPEN_POP = `(() => {
  const p0 = document.querySelector('.wb-cell .wb-pop.r')
  const c = __all('.workbar .wb-chip')[4]
  if (!c) return 'no-chip'
  if (p0) { c.click(); }
  c.click(); return 'clicked'
})()`
const READ_POP = `(() => {
  const p = document.querySelector('.wb-cell .wb-pop.r')
  if (!p) return JSON.stringify({ text: '(팝오버 없음)', rows: [] })
  return JSON.stringify({
    text: (p.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 700),
    rows: [...p.querySelectorAll('.wb-prow')].map((r) => (r.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160))
  })
})()`
// 제품 경로 재조회 — 설정 모달을 열었다 닫으면 App.tsx:585 가 getUsage(true)를 다시 쏜다.
const REFETCH = `(async () => {
  const sl = (ms) => new Promise((r) => setTimeout(r, ms))
  const foot = document.querySelector('.sb-foot'); if (!foot) return 'no-foot'
  foot.click(); await sl(700)
  if (!document.querySelector('.set-modal')) return 'no-modal'
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await sl(700)
  if (document.querySelector('.set-modal')) {
    const x = document.querySelector('.set-modal .set-x') || document.querySelector('.set-modal .x') || document.querySelector('.set-close')
    if (x) { x.click(); await sl(700) }
  }
  return document.querySelector('.set-modal') ? 'still-open' : 'closed'
})()`

for (let i = 1; i <= RUNS; i++) {
  const { home, uhome, removed, cacheBytes, cacheSha } = buildHome(i)
  const hits0 = proxyHits.length
  const profile = kind === 'tauri' ? tauriProfile({ port: PORT, exe: arg('exe', undefined) }) : electronProfile({ port: PORT })
  if (kind !== 'tauri') profile.args = ['.', `--remote-debugging-port=${PORT}`]
  const extra = {}
  if (UPROF) {
    extra.USERPROFILE = UPROF
    extra.HOMEPATH = UPROF.slice(2)
    extra.HOMEDRIVE = UPROF.slice(0, 2)
  }
  if (kind === 'tauri') extra.HTTPS_PROXY = `http://127.0.0.1:${PROXY_PORT}`
  const env = { ...process.env, ...profile.env, ...extra, CCG_HOME: home }
  delete env.NO_PROXY
  delete env.no_proxy
  const child = spawn(profile.cmd, profile.args, { env, cwd: profile.cwd, stdio: 'ignore' })
  const rec = {
    run: i, home, userProfileHome: uhome, pid: child.pid, at: new Date().toISOString(),
    accountsRemovedFromFixture: removed,
    plantedAccount: WITH_ACCT ? SYN_EMAIL : null,
    plantedCacheBytes: cacheBytes,
    plantedCacheSha: cacheSha
  }
  let cdp = null
  try {
    cdp = await connectMain(PORT)
    await cdp.send('Runtime.enable').catch(() => {})
    for (let k = 0; k < 400; k++) {
      const ok = await cdp.eval(`!!document.getElementById('root') && document.getElementById('root').children.length > 0`).catch(() => false)
      if (ok) break
      await sleep(150)
    }
    await sleep(SETTLE_MS)
    await cdp.eval(HELP)
    rec.acctCount = await cdp.eval(`window.api.auth.listAccounts().then(a => a.length)`, { awaitPromise: true, timeoutMs: 20000 }).catch(() => 'THROW')
    rec.acctEmails = await cdp.eval(`window.api.auth.listAccounts().then(a => JSON.stringify(a.map(x => x.email)))`, { awaitPromise: true, timeoutMs: 20000 }).catch(() => 'THROW')

    if (STUB) {
      // ★양성 대조 — 채널을 스텁으로 갈고 제품 경로로 재조회를 태운다.
      // 2.6.2는 `contextBridge`가 `window.api`를 얼려 놔서 속성 재정의가 막힌다
      // (`Cannot redefine property: getUsage` — 실측). 그래서 두 갈래를 차례로 시도하고
      // **어느 갈래로 심었는지 기록한다**.
      rec.stubInstalled = await cdp.eval(`(() => {
        const v = async () => ({
          fiveHour: { pct: ${PCT.five}, resetsAt: Math.floor(Date.now()/1000) + 3600 },
          weekly: { pct: ${PCT.weekly}, resetsAt: Math.floor(Date.now()/1000) + 3*86400 },
          weeklyFable: { pct: ${PCT.fable}, resetsAt: Math.floor(Date.now()/1000) + 3*86400 },
          extraCredit: null
        })
        let e1 = null
        try {
          Object.defineProperty(window.api, 'getUsage', { value: v, configurable: true, writable: true })
          if (typeof window.api.getUsage === 'function' && String(window.api.getUsage).includes('${PCT.five}')) return 'ok'
        } catch (e) { e1 = String(e && e.message || e) }
        try {
          const real = window.api
          const fake = new Proxy(real, {
            get(t, k) {
              if (k === 'getUsage') return v
              const x = Reflect.get(t, k)
              return typeof x === 'function' ? x.bind(t) : x
            }
          })
          Object.defineProperty(window, 'api', { value: fake, configurable: true, writable: true })
          if (String(window.api.getUsage).includes('${PCT.five}')) return 'ok:proxy(defineProperty 실패: ' + e1 + ')'
          return 'not-applied(' + e1 + ')'
        } catch (e2) { return 'THROW defineProperty=' + e1 + ' proxy=' + String(e2 && e2.message || e2) }
      })()`)
      rec.refetch = await cdp.eval(REFETCH, { awaitPromise: true, timeoutMs: 20000 }).catch((e) => 'THROW ' + e.message)
      await sleep(1200)
    } else {
      // 연속 두 호출 — 문을 지났으면 큐(1,200ms 간격)가 두 번째를 붙잡는다.
      rec.usageA = await cdp.eval(TIMED(`window.api.getUsage(false).then(u => JSON.stringify(u))`), { awaitPromise: true, timeoutMs: 40000 }).catch((e) => 'THROW ' + e.message)
      rec.usageB = await cdp.eval(TIMED(`window.api.getUsage(true).then(u => JSON.stringify(u))`), { awaitPromise: true, timeoutMs: 40000 }).catch((e) => 'THROW ' + e.message)
    }

    // 팝오버(사용자가 실제로 보는 화면)
    rec.clicked = await cdp.eval(OPEN_POP)
    await sleep(POP_MS)
    const pop = JSON.parse(await cdp.eval(READ_POP))
    rec.popText = pop.text
    rec.popRows = pop.rows
    rec.prows = pop.rows.length
    rec.hasNoData = /데이터 없음|No data/.test(String(rec.popText))
    // ★고친 칸 — 화면에 뜨는 숫자는 100−pct 다.
    rec.seesRemain = new RegExp(`(^|[^0-9])(${REM.five}|${REM.weekly}|${REM.fable})%`).test(String(rec.popText))
    // 옛 칸(R4의 sees42) — 극성이 거꾸로라 켜질 수 없다. 나란히 남겨 대비를 보인다.
    rec.seesPlanted = new RegExp(`(^|[^0-9])(${PCT.five}|${PCT.weekly}|${PCT.fable})%`).test(String(rec.popText))
    rec.seesPlantedR4Regex = new RegExp(`${PCT.five}|${PCT.weekly}|${PCT.fable}`).test(String(rec.popText))

    if (!STUB) {
      // ★양성 대조(파일 유효성) — 디스크 캐시를 읽는 채널.
      rec.acctUsage = await cdp.eval(TIMED(`window.api.auth.accountsUsage({ cachedOnly: true }).then(r => JSON.stringify(r))`), { awaitPromise: true, timeoutMs: 40000 }).catch((e) => 'THROW ' + e.message)
    }
    const eff = uhome ?? home
    rec.diskCacheAfter = { exists: fs.existsSync(path.join(eff, 'usage-cache.json')), sha: sha(path.join(eff, 'usage-cache.json')) }
  } catch (e) {
    rec.fatal = String(e.stack ?? e).slice(0, 500)
  } finally {
    try { cdp?.close() } catch { /* 닫힘 */ }
    killTree(child.pid)
  }
  rec.proxyHits = proxyHits.slice(hits0)
  out.runs.push(rec)
  const pa = (() => { try { return JSON.parse(rec.usageA) } catch { return {} } })()
  const pb = (() => { try { return JSON.parse(rec.usageB) } catch { return {} } })()
  const au = (() => { try { return JSON.parse(rec.acctUsage) } catch { return {} } })()
  console.log(`[${kind}/${ARM} ${i}/${RUNS}] acct=${rec.acctCount} prows=${rec.prows} noData=${rec.hasNoData} seesRemain=${rec.seesRemain} seesPlanted=${rec.seesPlanted} usageMs=${pa.ms}/${pb.ms} proxy=${rec.proxyHits.length} stub=${rec.stubInstalled ?? '-'}/${rec.refetch ?? '-'}`)
  console.log(`    rows=${JSON.stringify(rec.popRows)}`)
  if (!STUB) console.log(`    acctUsage(${au.ms}ms)=${String(au.v).slice(0, 200)}`)
  await sleep(2000)
}

const seenProws = [...new Set(out.runs.map((r) => r.prows))]
const seenNoData = [...new Set(out.runs.map((r) => r.hasNoData))]
const ms2 = out.runs.map((r) => { try { return JSON.parse(r.usageB).ms } catch { return null } })
out.summary = {
  runs: out.runs.length,
  acctCounts: [...new Set(out.runs.map((r) => r.acctCount))],
  prows: seenProws,
  hasNoData: seenNoData,
  seesRemain: [...new Set(out.runs.map((r) => r.seesRemain))],
  seesPlanted: [...new Set(out.runs.map((r) => r.seesPlanted))],
  seesPlantedR4Regex: [...new Set(out.runs.map((r) => r.seesPlantedR4Regex))],
  secondUsageCallMs: ms2,
  gateOpen: STUB ? null : ms2.every((m) => typeof m === 'number' && m >= 900),
  proxyHits: out.runs.reduce((n, r) => n + (r.proxyHits?.length ?? 0), 0),
  stable: seenProws.length === 1 && seenNoData.length === 1
}
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(out, null, 2))
try { sink?.close() } catch { /* 이미 닫힘 */ }
console.log(`\nsummary ${JSON.stringify(out.summary)}\nsaved: ${OUT}`)
