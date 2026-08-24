#!/usr/bin/env node
/* ============================================================================
 * poc-codex-usage — R28b 「RVERD」의 두 번째 구멍을 **라이브로** 잰다:
 * `codex-auth:accounts-usage`가 3.0 Rust에 실제로 답하는가.
 *
 * CRIT 확인 크리틱 R1 §4.1이 라이브로 남긴 값(그대로 옮긴다):
 *   > `ipc_call('codex-auth:accounts-usage')` → `{"__unimplemented":true}`,
 *   > 렌더러 심 경유 `window.api.codexAuth.accountsUsage()` → `[]`.
 *   > `[]`면 `codexUsageUnavailable`이 참이라 codex 채팅의 렌더러 재검증은 **언제나**
 *   > 「못 물어봤다」다.
 * 그리고 통과 조건도 크리틱이 적었다: **`accountsUsage()`가 빈 배열이 아닐 것.**
 *
 * ── 판을 어떻게 세우나 (크리틱 §2.2가 연 길) ────────────────────────────────
 *  ① 격리 `CCG_HOME`에 **합성 codex 계정 둘**. `authEnc`는 DPAPI로 봉인한다 —
 *     `ccg_store::safe_storage::decrypt`는 `v10` 접두사가 없으면 DPAPI 직접으로 풀고
 *     (`safe_storage.rs:155`), DPAPI는 PowerShell 한 줄로 만들 수 있다. 실계정 0건.
 *  ② codex 실행본 자리에는 **가짜 app-server**(`ccg-fakecodex`)를 꽂고
 *     (`CCG_CODEX_BIN`) `account/rateLimits/read`에 답하는 대본을 준다.
 *  ③ `CCG_NO_NET`은 **끄고** 돈다 — 그 스위치가 `read_row`를 즉사시킨다(킬 스위치).
 *     그래도 실 HTTP는 0건이다: 이 경로가 말을 거는 상대는 로컬 가짜 프로세스뿐이고
 *     부팅 엔진 업데이트는 `CCG_NO_BOOT_ENGINE_UPDATE=1`로 막는다.
 *
 * ── 무엇을 재나 ─────────────────────────────────────────────────────────────
 *  U1 채널이 살아 있다(`{__unimplemented:true}`가 아니다)
 *  U2 심 경유 값이 **빈 배열이 아니다**(= 크리틱의 통과 조건)
 *  U3 행 모양이 계약면 `CodexAccountUsage`다(email·planType·windows[label,usedPct,resetsAt])
 *  U4 라벨이 렌더러가 문자열로 찾는 그 값이다(`주간`/`Weekly` — `Chat.tsx cxUsageLine`)
 *  U5 가짜 app-server가 **실제로** `account/rateLimits/read`를 받았다(와이어 물증)
 *  U6 두 번째 호출은 캐시로 답한다(프로세스를 또 안 태운다 — 2분 TTL)
 *  U7 `planType`이 계정 스토어에 되싱크됐다(2.6.2 `codexAccountsUsage`의 그 줄)
 *  U8 재검증이 쓰는 판정(`codexBlockedResetsAt`)에 재료가 실제로 닿는다
 *
 *   node scripts/poc-codex-usage.mjs [--exe=…] [--fakecodex=…] [--keep] [--out=…]
 * ========================================================================== */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { connectMainPage, killTree, sleep, REPO } from '../bench/lib.mjs'

const args = process.argv.slice(2)
const KEEP = args.includes('--keep')
const HOME = path.join(REPO, '.poc-home-rverd')
const PORT = 9455 // RVERD 전용(다른 갈래와 안 겹친다)
const argOf = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) ?? '').split('=')[1] || d
const OUT = argOf('out', path.join(REPO, 'docs', 'critic', 'rverd-r1-codexusage.json'))
const EXE = argOf('exe', path.join(REPO, 'target-rverd', 'release', 'agentcodegui.exe'))
const FAKECODEX = argOf('fakecodex', path.join(REPO, 'target-rverd', 'release', 'ccg-fakecodex.exe'))
const A = 'rverd-a@openai.test'
const B = 'rverd-b@openai.test'
// 가짜 app-server가 돌려줄 창 — 5시간 창은 소진(100%), 주간 창은 여유(12%).
const RESETS = Math.floor(Date.now() / 1000) + 3600

const rep = { at: new Date().toISOString(), exe: EXE, steps: {}, findings: [] }
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
const write = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v, null, 2))
}

/** 원문 → DPAPI 봉인 base64. `safe_storage::decrypt`의 **비-v10 갈래**가 이걸 푼다. */
function dpapiSeal(text) {
  const tmp = path.join(HOME, `.seal-${Math.random().toString(36).slice(2)}.txt`)
  write(tmp, text)
  const ps = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Add-Type -AssemblyName System.Security; ` +
        `$b=[IO.File]::ReadAllBytes('${tmp.replace(/'/g, "''")}'); ` +
        `$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'); ` +
        `[Convert]::ToBase64String($p)`
    ],
    { encoding: 'utf8', timeout: 30_000 }
  )
  fs.rmSync(tmp, { force: true })
  const b64 = (ps.stdout ?? '').trim()
  if (!b64) throw new Error(`DPAPI 봉인 실패: ${ps.stderr ?? ps.error}`)
  return b64
}

function seedHome() {
  rmrf(HOME)
  fs.mkdirSync(path.join(HOME, 'work'), { recursive: true })
  // ① 합성 codex 계정 둘. `plan`은 **일부러 낡게**(free) 심는다 — 조회의 planType이
  //    스토어로 되싱크되는지(U7)를 보기 위해서다.
  const auth = (email) =>
    JSON.stringify({
      tokens: { access_token: `A-${email}`, refresh_token: `R-${email}`, account_id: 'acct_fake' },
      last_refresh: '2026-08-24T00:00:00.000Z'
    })
  write(path.join(HOME, 'codex-accounts.json'), {
    version: 1,
    defaultEmail: A,
    accounts: [
      { email: A, plan: 'free', authEnc: dpapiSeal(auth(A)) },
      { email: B, plan: 'free', authEnc: dpapiSeal(auth(B)) }
    ]
  })
  // ② 가짜 app-server 대본 — `initialize` 뒤 `account/rateLimits/read`에 답한다.
  write(
    path.join(HOME, 'fakecodex.jsonl'),
    [
      JSON.stringify({ await: 'initialize', result: { userAgent: 'fake' } }),
      JSON.stringify({
        await: 'account/rateLimits/read',
        result: {
          rateLimits: {
            planType: 'pro',
            primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: RESETS },
            secondary: { usedPercent: 12.4, windowDurationMins: 10080, resetsAt: RESETS + 86400 }
          }
        }
      })
    ].join('\n')
  )
  write(path.join(HOME, 'ui-prefs.json'), { 'limitResume.on': true })
  return { resetsAt: RESETS }
}

const IPC = (channel, payload = []) =>
  `window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: ${JSON.stringify(channel)}, payload: ${JSON.stringify(payload)} })`

async function boot() {
  for (const [what, p] of [
    ['빌드된 exe', EXE],
    ['가짜 codex', FAKECODEX]
  ])
    if (!fs.existsSync(p))
      throw new Error(
        `${what}가 없다: ${p}\n  cargo build --release --features custom-protocol\n  cargo build -p ccg-engine --features fakecli --release --bin ccg-fakecodex`
      )
  const child = spawn(EXE, [], {
    cwd: REPO,
    env: {
      ...process.env,
      CCG_HOME: HOME,
      CCG_CDP_PORT: String(PORT),
      // ★ `CCG_NO_NET`은 **안 켠다** — 그게 켜지면 `read_row`가 프로세스를 안 띄운다.
      CCG_CODEX_BIN: FAKECODEX,
      CCG_FAKECODEX_SCRIPT: path.join(HOME, 'fakecodex.jsonl'),
      CCG_FAKECODEX_IN: path.join(HOME, 'codex-stdin.log'),
      CCG_NO_BOOT_ENGINE_UPDATE: '1'
    },
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
  const j = async (expr) =>
    JSON.parse(await cdp.eval(`(async () => JSON.stringify(await (${expr})) ?? 'null')()`, { awaitPromise: true }))
  return { child, cdp, j, log: () => log }
}

/** 가짜 app-server가 받은 줄(와이어 물증). */
const stdinLog = () => {
  try {
    return fs.readFileSync(path.join(HOME, 'codex-stdin.log'), 'utf8')
  } catch {
    return ''
  }
}

async function main() {
  const seed = seedHome()
  const app = await boot()
  const pid = app.child.pid
  try {
    console.log('\n① 채널 — 살아 있나 (크리틱이 `{__unimplemented:true}`를 받은 그 자리)')
    const t0 = Date.now()
    const raw = await app.j(IPC('codex-auth:accounts-usage'))
    const ms1 = Date.now() - t0
    rep.steps.raw = raw
    rep.steps.firstCallMs = ms1
    check('U1 ★★ ipc_call이 미구현이 아니다', !(raw && raw.__unimplemented === true), `raw=${JSON.stringify(raw)}`, { raw, ms: ms1 })

    console.log('\n② 렌더러 심 경유 — 크리틱의 통과 조건')
    const via = await app.j(`window.api.codexAuth.accountsUsage()`)
    rep.steps.via = via
    check('U2 ★★ accountsUsage()가 빈 배열이 아니다', Array.isArray(via) && via.length > 0, `via=${JSON.stringify(via)}`, {
      len: Array.isArray(via) ? via.length : null
    })
    const rowA = (via ?? []).find((r) => r.email === A) ?? null
    const w0 = rowA?.windows?.[0] ?? null
    check(
      'U3 행 모양이 계약면 CodexAccountUsage다',
      !!rowA && rowA.planType === 'pro' && Array.isArray(rowA.windows) && rowA.windows.length === 2 && w0?.usedPct === 100 && w0?.resetsAt === seed.resetsAt,
      `row=${JSON.stringify(rowA)}`,
      { row: rowA }
    )
    check(
      'U4 라벨이 렌더러가 찾는 문자열이다',
      rowA?.windows?.[0]?.label === '5시간' && rowA?.windows?.[1]?.label === '주간',
      `labels=${JSON.stringify((rowA?.windows ?? []).map((w) => w.label))}`,
      { labels: (rowA?.windows ?? []).map((w) => w.label) }
    )
    check('U2′ 등록 계정 수만큼 행이 온다(등록 순서)', (via ?? []).map((r) => r.email).join(',') === `${A},${B}`, JSON.stringify((via ?? []).map((r) => r.email)))

    console.log('\n③ 와이어 물증 — 가짜 app-server가 무엇을 받았나')
    const wire = stdinLog()
    rep.steps.wire = wire.slice(0, 2000)
    const asks = (wire.match(/account\/rateLimits\/read/g) ?? []).length
    check('U5 ★ account/rateLimits/read가 실물로 나갔다', asks >= 2, `asks=${asks}`, { asks })

    console.log('\n④ 캐시 — 두 번째 호출이 프로세스를 또 태우나(2분 TTL)')
    const t1 = Date.now()
    const via2 = await app.j(`window.api.codexAuth.accountsUsage()`)
    const ms2 = Date.now() - t1
    const asks2 = (stdinLog().match(/account\/rateLimits\/read/g) ?? []).length
    rep.steps.secondCall = { ms: ms2, asks: asks2, len: (via2 ?? []).length }
    check('U6 ★ 두 번째 호출은 캐시로 답한다', asks2 === asks && (via2 ?? []).length === (via ?? []).length, `asks ${asks}→${asks2}`, {
      asks,
      asks2,
      ms1,
      ms2
    })

    console.log('\n⑤ planType 되싱크 — 스토어의 낡은 plan(free)이 따라왔나')
    const accts = await app.j(IPC('codex-auth:list-accounts'))
    rep.steps.accounts = accts
    check(
      'U7 스토어 plan이 pro로 되싱크됐다',
      (accts ?? []).every((a) => a.plan === 'pro'),
      `accounts=${JSON.stringify(accts)}`,
      { accounts: accts }
    )

    console.log('\n⑥ 판정 재료 — 재검증이 이 값으로 무엇을 얻나')
    // 렌더러의 재검증이 부르는 그 두 함수를 **앱 안에서** 그대로 돌린다.
    const verdict = await app.j(`(async () => {
      const list = await window.api.codexAuth.accountsUsage()
      const acct = list.find((a) => a.email === ${JSON.stringify(A)})
      const now = Math.floor(Date.now() / 1000)
      const ws = acct?.windows ?? []
      // codexUsageUnavailable / codexBlockedResetsAt의 규칙 그대로(순수 판정 — lib과 같은 두 줄)
      const unavailable = !ws || ws.length === 0
      let latest = null
      for (const w of ws) { if (w.usedPct < 100 || w.resetsAt == null || w.resetsAt <= now) continue; if (latest == null || w.resetsAt > latest) latest = w.resetsAt }
      return { unavailable, blockedUntil: latest }
    })()`)
    rep.steps.verdict = verdict
    check(
      'U8 ★★ 재검증이 「못 물어봤다」에서 벗어났다',
      verdict?.unavailable === false && verdict?.blockedUntil === seed.resetsAt,
      `verdict=${JSON.stringify(verdict)}`,
      { verdict, expect: seed.resetsAt }
    )
  } finally {
    try {
      app.cdp.close?.()
    } catch {
      /* ignore */
    }
    rep.steps.appLog = app.log().slice(-3000)
    killTree(pid)
    await sleep(500)
    if (!KEEP) rmrf(HOME)
  }
  rep.seed = seed
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
