#!/usr/bin/env node
/* ============================================================================
 * poc-limit-blind — 최종 파리티 R1 **확인 크리틱 실패1**의 재현과 소멸을 실물로 잰다.
 *
 * 크리틱의 실측(그대로 옮긴다):
 *   > 계정을 실은 격리 홈 + `CCG_NO_NET=1`(= 토큰은 나오는데 send가 죽는 판)에서
 *   > `usage:get`이 `{fiveHour:null, weekly:null, weeklyFable:null, extraCredit:null}`을
 *   > 돌려주고, 그 값을 훅이 실제로 부르는 `blockedResetsAt`에 먹이니 null →
 *   > fire()의 착지는 ready=true(자동 전송).
 *
 * 여기서 재는 것:
 *   ① 같은 판에서 `usage:get`이 이제 무엇을 돌려주나 (창 넷의 **모양은 그대로**인가,
 *      「못 물어봤다」 표식이 붙나) — 메인 창과 **추가 채팅 창** 양쪽에서.
 *   ② 그 **실측값 그대로**를 옛 판정(`blockedResetsAt`)에 먹이면 여전히 null인가
 *      = R1의 오판 조건은 값의 모양이 아니라 **판정**에 있었다는 대조.
 *   ③ 같은 값을 새 판정(`usageUnavailable`·`resumeVerdict`)에 먹이면 **유지**인가.
 *   ④ `auth:accounts-usage`도 같은 규약인가(행은 남고 표식이 붙는다).
 *   실측값은 `docs/critic/limit-blind-t3t4-r1.json`에 남고, `poc-limit-resume.mjs`의
 *   G절이 그 파일을 읽어 **실제 훅**에 같은 값을 먹인다(하네스가 지어낸 모양 금지).
 *
 * ── 안전 규칙 ───────────────────────────────────────────────────────────────
 *  · **실계정을 한 줄도 안 읽는다.** 계정은 이 스크립트가 만든 합성 자격증명이고,
 *    `CCG_NO_NET=1`이라 HTTP는 한 번도 안 나간다 = 토큰 회전 유발 0.
 *  · 이름 기반 kill 금지 — 죽이는 것은 spawn한 PID 트리뿐.
 *  · 앱 홈·CDP 포트는 T3T4 갈래 전용(다른 갈래와 안 겹친다).
 *
 *   node scripts/poc-limit-blind.mjs [--exe=…] [--keep] [--out=…]
 *
 * ★확인 크리틱 R2 위생 — `--out=`이 없어서 기본 출력이 **커밋된 기준 파일**이었다.
 * 주행 한 번이 기준을 갈아 치우고(크리틱이 `git checkout`으로 되돌렸다) 그 다음 주행은
 * 갈린 기준과 비교된다. 이제 시험 주행은 `--out=%TEMP%/…`로 뺄 수 있다.
 * ========================================================================== */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import esbuild from 'esbuild'
import { pathToFileURL } from 'node:url'
import { connectMainPage, cdpTargets, Cdp, killTree, sleep, REPO } from '../bench/lib.mjs'

const args = process.argv.slice(2)
const KEEP = args.includes('--keep')
const HOME = path.join(REPO, '.poc-home-blind-t3t4')
const PORT = 9423
const argOf = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) ?? '').split('=')[1] || d
const OUT = argOf('out', path.join(REPO, 'docs', 'critic', 'limit-blind-t3t4-r1.json'))
const EXE = argOf('exe', path.join(REPO, 'target-t3t4', 'release', 'agentcodegui.exe'))
const EMAIL = 'blind-seed@t3t4.test'

const rep = { at: new Date().toISOString(), exe: EXE, email: EMAIL, steps: {}, findings: [] }
let pass = 0
const ok = (id, detail) => {
  pass++
  console.log(`  ✓ ${id}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`)
}
const fail = (id, why, extra) => {
  rep.findings.push({ id, why, ...(extra ?? {}) })
  console.error(`  ✗ ${id} — ${why}${extra ? ` ${JSON.stringify(extra)}` : ''}`)
}
const check = (id, cond, why, extra) => (cond ? ok(id, extra) : fail(id, why, extra))

const rmrf = (p) => {
  for (let i = 0; i < 10; i++) {
    try {
      fs.rmSync(p, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 })
      return
    } catch {
      spawnSync('cmd', ['/c', 'ping', '127.0.0.1', '-n', '2'], { stdio: 'ignore' })
    }
  }
}

/** `ccg_auth::account_slug`의 JS 원본(auth.ts와 같은 식) — 폴더 이름이 어긋나면
 *  크리덴셜을 못 찾아 "토큰이 없다"가 되고, 그러면 재는 판이 달라진다. */
function accountSlug(email) {
  const safe = email.toLowerCase().replace(/[^a-z0-9._-]+/g, '_')
  let h = 0
  for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) >>> 0
  return `${safe}-${h.toString(36)}`
}

/** 합성 계정 하나 — **살아 있는 액세스 토큰**(만료 1시간 뒤)이라 `access_token`이
 *  네트워크 없이 그대로 돌려준다. 그 뒤 `send`가 킬 스위치로 죽는다 = 크리틱의 판. */
function seedHome() {
  rmrf(HOME)
  const dir = path.join(HOME, 'accounts', accountSlug(EMAIL))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(HOME, 'accounts.json'),
    JSON.stringify({ version: 3, defaultEmail: EMAIL, accounts: [{ email: EMAIL, subscriptionType: 'max' }] })
  )
  fs.writeFileSync(
    path.join(dir, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: { accessToken: 'A-blind-seed', expiresAt: Date.now() + 3600_000, scopes: ['user:inference'] }
    })
  )
}

const IPC = (channel, payload = []) =>
  `await window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: ${JSON.stringify(channel)}, payload: ${JSON.stringify(payload)} })`

async function boot() {
  if (!fs.existsSync(EXE)) throw new Error(`빌드된 exe가 없다: ${EXE}\n  cargo build --release --features custom-protocol`)
  const child = spawn(EXE, [], {
    cwd: REPO,
    env: { ...process.env, CCG_HOME: HOME, CCG_CDP_PORT: String(PORT), CCG_NO_NET: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  child.stdout.on('data', (d) => (log += d.toString()))
  child.stderr.on('data', (d) => (log += d.toString()))
  const cdp = await connectMainPage(PORT, { timeoutMs: 60_000 })
  for (let i = 0; i < 400; i++) {
    const up = await cdp
      .eval(`(async () => { try { return !!(await window.api.app.getVersion()) } catch { return false } })()`, { awaitPromise: true })
      .catch(() => false)
    if (up) break
    await sleep(100)
  }
  const j = async (expr, page = cdp) =>
    JSON.parse(await page.eval(`(async () => JSON.stringify(await (${expr})) ?? 'null')()`, { awaitPromise: true }))
  return { child, cdp, j, log: () => log }
}

async function main() {
  seedHome()
  // 판정 두 벌을 같은 번들에서 꺼낸다(옛 판정 `blockedResetsAt` · 새 판정 `resumeVerdict`).
  const tmp = path.join(os.tmpdir(), 'ccg-limit-blind-lib.mjs') // 레포 밖 스크래치
  await esbuild.build({
    entryPoints: [path.join(REPO, 'app/src/lib/limitResume.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile: tmp
  })
  const lib = await import(pathToFileURL(tmp).href)
  fs.rmSync(tmp, { force: true })

  const app = await boot()
  const pid = app.child.pid
  try {
    console.log('\n① usage:get — 토큰은 나오는데 send가 죽는 판(CCG_NO_NET=1)')
    const usage = await app.j(`window.api.getUsage(true, ${JSON.stringify(EMAIL)})`)
    const usageDefault = await app.j(`window.api.getUsage(true)`)
    const usageBogus = await app.j(`window.api.getUsage(true, "nobody@nowhere.test")`)
    rep.steps.usageGet = usage
    rep.steps.usageGetDefault = usageDefault
    rep.steps.usageGetBogus = usageBogus
    const wins = ['fiveHour', 'weekly', 'weeklyFable', 'extraCredit']
    check('B1 창 넷의 모양은 2.6.2 그대로(전부 null)', wins.every((k) => usage?.[k] === null), `모양이 갈렸다: ${JSON.stringify(usage)}`, { usage })
    check('B2 ★조회 실패에 「못 물어봤다」 표식이 붙는다', usage?.unavailable === true, '표식이 없다 — 훅이 「막는 창 없음」으로 읽는다', { usage })
    check('B3 계정 인자 없이 불러도 같다', usageDefault?.unavailable === true, JSON.stringify(usageDefault), { usageDefault })
    check('B4 없는 계정도 같다', usageBogus?.unavailable === true, JSON.stringify(usageBogus), { usageBogus })
    check('B5 캐시가 없으니 stale은 아니다', usage?.stale === undefined, '값이 없는데 stale이면 거짓말이다', { stale: usage?.stale })

    console.log('\n② 그 실측값을 **옛 판정**에 먹인다 (R1의 오판 재현)')
    const nowSec = Math.floor(Date.now() / 1000)
    const old = lib.blockedResetsAt(usage, false, nowSec + 60)
    rep.steps.oldVerdict = old
    check(
      'B6 옛 판정(blockedResetsAt)은 이 값을 「막는 창 없음」으로 읽는다',
      old === null,
      `기대 null(= R1 오판의 조건) · 실제 ${JSON.stringify(old)}`,
      { old }
    )

    console.log('\n③ 같은 값을 **새 판정**에 먹인다')
    const unavailable = lib.usageUnavailable(usage)
    const hold = { key: 'c1', engine: 'claude', account: EMAIL, resetsAt: nowSec - 100, fable: false, lastPrompt: 'p', at: Date.now() }
    const v1 = lib.resumeVerdict(hold, old, unavailable, nowSec)
    const v2 = lib.resumeVerdict({ ...hold, probes: 1 }, old, unavailable, nowSec)
    rep.steps.newVerdict = { unavailable, v1, v2 }
    check('B7 ★실측값 = 못 물어봤다', unavailable === true, '실패값이 「값 있음」으로 읽힌다', { unavailable })
    check('B8 ★재검증 착지 = 유지(자동 전송 없음)', v1.kind === 'hold' && v1.probes === 1, `착지가 ${JSON.stringify(v1)}`, { v1 })
    check('B9 두 번째 재검증도 유지', v2.kind === 'hold' && v2.probes === 2, JSON.stringify(v2), { v2 })

    console.log('\n④ auth:accounts-usage')
    const accts = await app.j(`window.api.auth.accountsUsage()`)
    rep.steps.accountsUsage = accts
    check('B10 계정 행이 목록에서 사라지지 않는다', Array.isArray(accts) && accts.length === 1 && accts[0].email === EMAIL, JSON.stringify(accts), { accts })
    check('B11 그 행에 「못 물어봤다」가 실린다', accts?.[0]?.unavailable === true, JSON.stringify(accts?.[0]), { row: accts?.[0] })
    check('B12 퍼센트는 여전히 null(모양 불변)', accts?.[0]?.weeklyPct === null && accts?.[0]?.fiveHourPct === null, JSON.stringify(accts?.[0]), {})

    console.log('\n⑤ managed가 없는 표면 — 추가 채팅 창에서 같은 값이 오나')
    const before = new Set((await cdpTargets(PORT)).filter((t) => t.type === 'page').map((t) => t.id))
    await app.j(IPC('win:open-session'))
    await sleep(2500)
    const fresh = (await cdpTargets(PORT)).find((t) => t.type === 'page' && /#session/.test(t.url) && !before.has(t.id))
    if (!fresh) {
      fail('B13', '추가 채팅 창을 못 짚었다')
    } else {
      const page = await Cdp.connect(fresh.webSocketDebuggerUrl, { timeoutMs: 8000 })
      const inWin = await app.j(`window.api.getUsage(true, ${JSON.stringify(EMAIL)})`, page)
      rep.steps.usageGetSessionWindow = inWin
      check('B13 추가 채팅 창에서도 같은 표식', inWin?.unavailable === true, JSON.stringify(inWin), { inWin })
      check(
        'B14 그 창의 훅도 같은 착지(유지)',
        lib.resumeVerdict(hold, lib.blockedResetsAt(inWin, false, nowSec + 60), lib.usageUnavailable(inWin), nowSec).kind === 'hold',
        '창마다 판정이 갈리면 안 된다',
        {}
      )
      try {
        page.close?.()
      } catch {
        /* 창이 이미 죽었다 */
      }
    }
  } finally {
    try {
      app.cdp.close?.()
    } catch {
      /* ignore */
    }
    killTree(pid)
    await sleep(500)
    if (!KEEP) rmrf(HOME)
  }
  rep.pass = pass
  rep.fail = rep.findings.length
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(rep, null, 2))
  console.log(`\n${rep.findings.length === 0 ? 'PASS' : 'FAIL'} — ${pass} 통과, ${rep.findings.length} 실패`)
  console.log(`리포트: ${OUT}`)
  process.exit(rep.findings.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
