// 최종 파리티 R4 — `limit-pop` **판별력 있는** 반복 측정기.
//
//   node docs/critic/tools/critic-r28f-limitpop2.mjs <tauri|electron> \
//        [--exe=<경로>] [--port=10530] [--proxyport=10539] [--runs=3] \
//        [--arm=synth-seeded|synth-bare|noacct-seeded|noacct-bare] \
//        [--userprofile=<경로>] [--out=json]
//
// ── 왜 R3의 도구(critic-r28f-limitpop.mjs)를 다시 쓰는가 ──────────────────────
// R3는 「캐시를 심고 각 3회 재니 두 앱이 완전히 같다」를 §2.3에 실었는데, 그 12주행은
// **전 주행 계정 0**이었다. 계정이 0이면
//
//   3.0    src-tauri/src/ipc/parity/usage.rs:183  `let Some(email) = email else { return unavailable_usage() }`
//   2.6.2  src/main/index.ts:1027-1028            `const tk = await usageTokenFor(account); if (!tk) return empty`
//
// 로 **캐시·네트워크를 보기도 전에** 끝난다. 즉 seeded와 bare가 같은 값을 내는 것은
// 「처방이 이 화면에 안 닿는다」의 증거가 아니라 **「이 배치는 어떤 가설도 못 가른다」**의
// 증거다(확인 크리틱 R28f-AUDIT-R1 F1 — 그 지적은 옳다). 게다가 R3가 심은 캐시는 실홈
// 사본이라 **등록되지 않은 남의 이메일**로 키가 잡혀 있었다 — 설령 그 문을 지났어도
// 내 계정 줄은 거기 없다. 두 겹으로 무효다.
//
// ── 이 도구가 문을 여는 방법 (실계정 0 · 실 HTTP 0) ──────────────────────────
// 합성 클로드 계정 하나를 격리 홈에 심는다(`audit-synth@example.invalid`).
//   · 스토어  `accounts.json` v3 + `accounts/<slug>/.credentials.json`
//   · 액세스 토큰은 **가짜**이고 만료는 +30일 — 두 앱 다 `account_access_token`/
//     `accountAccessToken`이 **로컬에서** 그걸 돌려준다(네트워크·회전 0).
// 그러면 두 앱 모두 위 두 조기 반환문을 **지나** 메모리 캐시 → 실패 폴백까지 실제로 간다.
// 나가려는 HTTP는 앱별로 다르게, **기계가 보장하는 방식으로** 막는다:
//   · 3.0   `HTTPS_PROXY=http://127.0.0.1:<proxyport>` — 이 도구가 띄운 싱크가 CONNECT를
//           받아 **502로 끊는다**(터널을 안 연다). ureq는 명시 프록시를 읽는다
//           (`crates/ccg-auth/src/net.rs:129 env_proxy`). 싱크에 찍힌 CONNECT 줄이
//           **「조회가 실제로 시도됐다」의 실행 증거**다.
//   · 2.6.2 액세스 토큰에 개행을 넣는다. `fetch`의 `Authorization: 'Bearer ' + token`이
//           undici 헤더 검증에 걸려 **소켓을 열기 전에** TypeError로 죽고
//           (`Headers.append: … is an invalid header value.` — 실측 29ms),
//           `index.ts:1110`의 catch가 곧 **메모리 캐시 폴백**이다. 즉 우리가 재려는 그 문.
//
// ── 판별식 ───────────────────────────────────────────────────────────────────
// 심은 디스크 캐시(`usage-cache.json`)는 **그 합성 계정의 이메일로** 키가 잡혀 있고 값이
// 유별나다(5h 42% · 주간 43% · Fable 44%). 그러니 이 라운드의 가설은 진짜로 갈린다:
//   · 디스크 캐시가 `usage:get`에 닿는다 → 팝오버는 **5행**(Fable 행이 생긴다) · 42/43/44가 보인다
//   · 안 닿는다                        → 팝오버는 4행 · 「데이터 없음」
// 그리고 **양성 대조**로 같은 파일을 `auth:accounts-usage`(디스크 캐시를 읽는 채널)로
// 다시 읽는다 — 거기서 42%가 나오면 「심은 파일이 유효하고, 키도 맞고, 앱이 그 파일을
// 실제로 읽는다」가 증명된다. 그 상태에서 팝오버만 비어 있으면 결론은 **실행으로** 닫힌다.
//
// ── 문이 열렸다는 것의 실행 증거(두 앱 공통) ─────────────────────────────────
// 두 앱 다 usage 호출을 **전역 큐 + 1,200ms 간격**으로 직렬화한다
// (`ccg_auth::usage::USAGE_GAP_MS` · `auth.ts:504 usageSlot`). 문 앞에서 되돌아가면
// 큐에 아예 안 들어가므로 연속 두 호출이 **둘 다 즉시**고, 문을 지나면 두 번째가
// **1.2초쯤 걸린다.** 그래서 `noacct-*` 팔(=R3의 배치)과 `synth-*` 팔의 `usageMs`가
// 이 실험의 판별력을 **숫자로** 보여 준다.
//
// ── 안전 규약(함정 5) ────────────────────────────────────────────────────────
// 실홈의 `accounts.json`·`codex-accounts.json`·`accounts/`는 **읽지도 복사하지도** 않는다
// (픽스처가 복사한 것은 앱 기동 **전에** 지운다). 심는 자격증명은 100% 합성이고
// (`example.invalid`), 실 HTTP는 위 두 장치로 0건이다. 2.6.2는 `USERPROFILE`까지 돌린다
// (그쪽은 `CCG_HOME`을 무시한다 — R3 §2.5).
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
const PORT = Number(arg('port', kind === 'tauri' ? 10530 : 10531))
const PROXY_PORT = Number(arg('proxyport', 10539))
const RUNS = Number(arg('runs', 3))
const ARM = arg('arm', 'synth-seeded')
const SETTLE_MS = Number(arg('settle', 8000))
const POP_MS = Number(arg('popwait', 3500))
const HOMEROOT = arg('homeroot', 'C:\\Temp\\ccg-r28f-audit')
const UPROF = arg('userprofile', '')
const OUT = path.resolve(arg('out', path.join(REPO, 'docs', 'critic', `final-parity-r4-limitpop-${kind}-${ARM}.json`)))
const APP_VERSION = kind === 'tauri' ? '3.0.0-beta.1' : '2.6.2'

const WITH_ACCT = ARM.startsWith('synth')
const SEEDED = ARM.endsWith('seeded')
const SYN_EMAIL = 'audit-synth@example.invalid'
// 2.6.2만 개행을 넣는다(위 헤더 — undici가 소켓 전에 죽는다). 3.0은 프록시 싱크가 막는다.
const SYN_TOKEN = kind === 'tauri'
  ? 'synthetic-audit-access-token-not-real'
  : 'synthetic-audit-access-token\nnot-real'

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
      refreshToken: 'synthetic-audit-refresh-token-not-real',
      expiresAt: Date.now() + 30 * 24 * 3600 * 1000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max'
    }
  }))
}

/** 심는 디스크 캐시 — **합성 계정의 이메일로** 키를 잡고 값을 유별나게 둔다. */
function plantCache(root) {
  fs.mkdirSync(root, { recursive: true })
  const now = Date.now()
  fs.writeFileSync(path.join(root, 'usage-cache.json'), JSON.stringify({
    [SYN_EMAIL]: {
      at: now,
      data: {
        email: SYN_EMAIL,
        fiveHourPct: 42,
        weeklyPct: 43,
        fablePct: 44,
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
  syntheticEmail: WITH_ACCT ? SYN_EMAIL : null,
  at: new Date().toISOString(),
  settleMs: SETTLE_MS,
  netBlock: kind === 'tauri'
    ? `HTTPS_PROXY=http://127.0.0.1:${PROXY_PORT} (CONNECT를 502로 끊는 싱크 — 외부로 0바이트)`
    : 'accessToken에 개행 — undici Headers.append가 소켓 전에 TypeError (외부로 0바이트)',
  discriminator: '심은 디스크 캐시는 5h 42% · 주간 43% · Fable 44% — 닿으면 팝오버가 5행이 되고 42/43/44가 보인다',
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
  const home = path.join(HOMEROOT, `home-lp2-${kind}-${ARM}-${i}`)
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

  // 2.6.2는 `CCG_HOME`을 무시하고 `os.homedir()/.agentcodegui`를 본다(R3 §2.5).
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
    // 연속 두 호출 — 문을 지났으면 큐(1,200ms 간격)가 두 번째를 붙잡는다.
    rec.usageA = await cdp.eval(TIMED(`window.api.getUsage(false).then(u => JSON.stringify(u))`), { awaitPromise: true, timeoutMs: 40000 }).catch((e) => 'THROW ' + e.message)
    rec.usageB = await cdp.eval(TIMED(`window.api.getUsage(true).then(u => JSON.stringify(u))`), { awaitPromise: true, timeoutMs: 40000 }).catch((e) => 'THROW ' + e.message)
    // 팝오버(사용자가 실제로 보는 화면)
    rec.clicked = await cdp.eval(`(() => { const c = __all('.workbar .wb-chip')[4]; if (!c) return false; c.click(); return true })()`)
    await sleep(POP_MS)
    rec.popText = await cdp.eval(`(() => { const p = document.querySelector('.wb-cell .wb-pop.r'); return p ? (p.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 600) : '(팝오버 없음)' })()`)
    rec.prows = await cdp.eval(`__all('.wb-cell .wb-pop.r .wb-prow').length`)
    rec.hasNoData = /데이터 없음|No data/.test(String(rec.popText))
    rec.sees42 = /42|43|44/.test(String(rec.popText))
    // ★양성 대조 — 디스크 캐시를 읽는 채널. 여기서 42%가 나오면 심은 파일은 유효하다.
    rec.acctUsage = await cdp.eval(TIMED(`window.api.auth.accountsUsage({ cachedOnly: true }).then(r => JSON.stringify(r))`), { awaitPromise: true, timeoutMs: 40000 }).catch((e) => 'THROW ' + e.message)
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
  console.log(`[${kind}/${ARM} ${i}/${RUNS}] acct=${rec.acctCount} prows=${rec.prows} noData=${rec.hasNoData} sees42=${rec.sees42} usageMs=${pa.ms}/${pb.ms} proxy=${rec.proxyHits.length}`)
  console.log(`    usage=${String(pa.v).slice(0, 130)}`)
  console.log(`    acctUsage(${au.ms}ms)=${String(au.v).slice(0, 200)}`)
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
  sees42: [...new Set(out.runs.map((r) => r.sees42))],
  secondUsageCallMs: ms2,
  gateOpen: ms2.every((m) => typeof m === 'number' && m >= 900),
  proxyHits: out.runs.reduce((n, r) => n + (r.proxyHits?.length ?? 0), 0),
  stable: seenProws.length === 1 && seenNoData.length === 1
}
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(out, null, 2))
try { sink?.close() } catch { /* 이미 닫힘 */ }
console.log(`\nsummary ${JSON.stringify(out.summary)}\nsaved: ${OUT}`)
