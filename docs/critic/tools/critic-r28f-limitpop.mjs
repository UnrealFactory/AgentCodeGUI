// 최종 파리티 R3 — `limit-pop`(워크바 컨텍스트·한도 팝오버)이 **앱의 성질인가 환경의
// 성질인가**를 가리는 반복 측정기.
//
//   node docs/critic/tools/critic-r28f-limitpop.mjs <tauri|electron> \
//        [--exe=<경로>] [--port=10530] [--runs=3] [--arm=seeded|bare] [--out=json]
//
// ── 왜 이 도구가 필요한가 ────────────────────────────────────────────────────
// R2 감사는 이 화면을 「3.0 5행 실값 vs 2.6.2 4행 데이터 없음 → 역전 · 3.0 승」이라 적었다.
// 그런데 **같은 홈에서 75초 먼저 돈 3.0 주행**이 정반대(4행·데이터 없음)를 기록해 두었고,
// R1 기준선은 극성이 아예 반대다(T=4/E=5). 그래서 이 도구는 「한 번 눌러 본 값」이 아니라
// **같은 조건 N회**를 재고, 두 앱을 **같은 레시피**로 세운다.
//
// ── 안전 규약(함정 5: 실계정 토큰 회전 금지) ─────────────────────────────────
// `bench/fixture.mjs`는 실홈 `accounts.json`을 복사한다. 그 파일이 홈에 있으면 앱이
// `usage:get` → `net::access_token` → (액세스 토큰 만료 시) **리프레시 교환**으로 가고,
// 그 경로가 실계정의 리프레시 토큰을 회전시킨다(= 실앱 되싱크). 그래서 이 도구는
// 픽스처를 만든 **직후** `accounts.json`·`codex-accounts.json`을 지운다 —
// 앱이 켜지기 전에 지우므로 자격증명은 **한 바이트도** 프로세스에 안 들어간다.
// 심는 것은 `usage-cache.json` 하나뿐이다(퍼센트만 든 파일 · 토큰 없음).
//
// ── 두 팔 ────────────────────────────────────────────────────────────────────
// | arm | 홈에 심는 것 | 묻는 것 |
// |---|---|---|
// | `seeded` | 실홈 `usage-cache.json` 복사본 | 크리틱 R1 §3.1의 처방 그대로 — 캐시를 심으면 이 화면이 서는가 |
// | `bare`   | (없음) | 대조군 — 심는 것과 안 심는 것의 차이가 있는가 |
//
// ── ★`--userprofile=<경로>` — 2.6.2를 진짜로 격리하는 유일한 손잡이 ───────────
// 2.6.2 `src/main/auth.ts:76`은 `APP_HOME = path.join(os.homedir(), '.agentcodegui')`로
// **하드코딩**돼 있다 — `CCG_HOME`을 안 본다. 그래서 `CCG_HOME`만 준 2.6.2는 계정도
// `usage-cache.json`도 **사용자 실홈**에서 읽는다(이 도구의 첫 스모크에서 실측:
// 격리 홈에 `accounts.json`이 0바이트인데 화면은 6계정을 그렸다). Node의 `os.homedir()`는
// Windows에서 `USERPROFILE`을 먼저 보므로, 자식 프로세스의 `USERPROFILE`을 돌리면
// 그제야 2.6.2도 격리된다. 이 플래그가 없으면 이 화면의 A/B는 **3.0(격리 홈) vs
// 2.6.2(실홈)** 를 비교하는 것이고, 그건 앱 비교가 아니다.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { electronProfile, tauriProfile, cdpTargets, Cdp, killTree, sleep, REPO } from '../../../bench/lib.mjs'
import { makeFixtureHome } from '../../../bench/fixture.mjs'
import { augmentFixture } from '../../../bench/screens.mjs'

const kind = process.argv[2] ?? 'tauri'
const argv = process.argv.slice(3)
const arg = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d }
const PORT = Number(arg('port', kind === 'tauri' ? 10530 : 10531))
const RUNS = Number(arg('runs', 3))
const ARM = arg('arm', 'seeded')
const SETTLE_MS = Number(arg('settle', 9000)) // 두 앱에 **같은** 대기 시간
const POP_MS = Number(arg('popwait', 4000))
const HOMEROOT = arg('homeroot', 'C:\\Temp\\ccg-r28f-audit')
const UPROF = arg('userprofile', '') // 2.6.2 격리용(위 헤더 참고) — 빈 값이면 안 건드린다
const OUT = path.resolve(arg('out', path.join(REPO, 'docs', 'critic', `final-parity-r3-limitpop-${kind}-${ARM}.json`)))
const APP_VERSION = kind === 'tauri' ? '3.0.0-beta.1' : '2.6.2'
const REAL_CACHE = path.join(os.homedir(), '.agentcodegui', 'usage-cache.json')

const out = {
  app: kind === 'tauri' ? 'tauri-3.0.0' : 'electron-2.6.2',
  kind,
  arm: ARM,
  at: new Date().toISOString(),
  settleMs: SETTLE_MS,
  popWaitMs: POP_MS,
  userProfileOverride: UPROF || null,
  safety: 'accounts.json·codex-accounts.json을 앱 기동 **전에** 삭제 — 실계정 토큰이 프로세스에 안 들어간다(회전 0)',
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
  const home = path.join(HOMEROOT, `home-lp-${kind}-${ARM}-${i}`)
  try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 잠기면 덮어쓴다 */ }
  makeFixtureHome(home, APP_VERSION)
  augmentFixture(home, { repo: REPO })
  // ★안전: 픽스처가 복사한 실계정 자격증명을 **앱이 켜지기 전에** 지운다.
  const removed = []
  for (const f of ['accounts.json', 'codex-accounts.json']) {
    const p = path.join(home, f)
    if (fs.existsSync(p)) { fs.rmSync(p); removed.push(f) }
  }
  let seeded = null
  if (ARM === 'seeded' && fs.existsSync(REAL_CACHE)) {
    fs.copyFileSync(REAL_CACHE, path.join(home, 'usage-cache.json'))
    seeded = fs.statSync(path.join(home, 'usage-cache.json')).size
  }
  return { home, removed, seeded }
}

const HELP = `(() => {
  window.__all = (s) => [...document.querySelectorAll(s)]
  return true
})()`

for (let i = 1; i <= RUNS; i++) {
  const { home, removed, seeded } = buildHome(i)
  const profile = kind === 'tauri' ? tauriProfile({ port: PORT, exe: arg('exe', undefined) }) : electronProfile({ port: PORT })
  if (kind !== 'tauri') profile.args = ['.', `--remote-debugging-port=${PORT}`]
  const extra = {}
  if (UPROF) {
    // 격리 USERPROFILE 아래에도 `.agentcodegui`가 있어야 2.6.2가 거기서 읽는다.
    // 홈 자체를 그대로 쓰면 두 앱이 **정확히 같은 파일**을 본다(= 진짜 대칭).
    const fake = path.join(UPROF, '.agentcodegui')
    fs.mkdirSync(fake, { recursive: true })
    for (const f of ['usage-cache.json']) {
      const src = path.join(home, f)
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(fake, f))
      else { try { fs.rmSync(path.join(fake, f)) } catch { /* 없으면 그만 */ } }
    }
    for (const f of ['accounts.json', 'codex-accounts.json']) { try { fs.rmSync(path.join(fake, f)) } catch { /* 없으면 그만 */ } }
    extra.USERPROFILE = UPROF
    extra.HOMEPATH = UPROF.slice(2)
    extra.HOMEDRIVE = UPROF.slice(0, 2)
  }
  const child = spawn(profile.cmd, profile.args, {
    env: { ...process.env, ...profile.env, ...extra, CCG_HOME: home },
    cwd: profile.cwd,
    stdio: 'ignore'
  })
  const rec = {
    run: i, home, pid: child.pid, at: new Date().toISOString(),
    accountsRemoved: removed,
    usageCacheSeededBytes: seeded,
    accountsJsonPresentAtLaunch: fs.existsSync(path.join(home, 'accounts.json')),
    userProfile: UPROF || '(실홈)'
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
    rec.chips = await cdp.eval(`__all('.workbar .wb-chip').length`)
    // 계정 축이 정말 비었는지 화면 쪽에서도 확인(자격증명 0 = 이 라운드의 전제)
    rec.acctCount = await cdp.eval(`window.api.auth.listAccounts().then(a => a.length)`, { awaitPromise: true, timeoutMs: 20000 }).catch(() => 'THROW')
    rec.clicked = await cdp.eval(`(() => { const c = __all('.workbar .wb-chip')[4]; if (!c) return false; c.click(); return true })()`)
    await sleep(POP_MS)
    rec.popText = await cdp.eval(`(() => { const p = document.querySelector('.wb-cell .wb-pop.r'); return p ? (p.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 500) : '(팝오버 없음)' })()`)
    rec.prows = await cdp.eval(`__all('.wb-cell .wb-pop.r .wb-prow').length`)
    rec.hasNoData = /데이터 없음|No data/.test(String(rec.popText))
    // 이 화면을 먹이는 유일한 문 — `usage:get`. 값의 모양을 그대로 남긴다.
    rec.usageGet = await cdp.eval(`window.api.getUsage(false).then(u => JSON.stringify(u))`, { awaitPromise: true, timeoutMs: 30000 }).catch((e) => 'THROW ' + e.message)
    // 디스크 캐시는 이 화면에 닿는가 — 심은 파일이 그대로 있는지도 같이 본다
    rec.diskCacheStillThere = fs.existsSync(path.join(home, 'usage-cache.json'))
  } catch (e) {
    rec.fatal = String(e.stack ?? e).slice(0, 500)
  } finally {
    try { cdp?.close() } catch { /* 닫힘 */ }
    killTree(child.pid)
  }
  out.runs.push(rec)
  console.log(`[${kind}/${ARM} ${i}/${RUNS}] prows=${rec.prows} hasNoData=${rec.hasNoData} acct=${rec.acctCount} usage=${String(rec.usageGet).slice(0, 120)}`)
  await sleep(2500)
}

const seenProws = [...new Set(out.runs.map((r) => r.prows))]
const seenNoData = [...new Set(out.runs.map((r) => r.hasNoData))]
out.summary = {
  runs: out.runs.length,
  prows: seenProws,
  hasNoData: seenNoData,
  stable: seenProws.length === 1 && seenNoData.length === 1
}
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(out, null, 2))
console.log(`\nsummary ${JSON.stringify(out.summary)}\nsaved: ${OUT}`)
