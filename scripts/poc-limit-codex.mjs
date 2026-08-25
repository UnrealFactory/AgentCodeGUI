#!/usr/bin/env node
/* ============================================================================
 * poc-limit-codex — R28 「T3T4」 확인 크리틱 R3 §3이 실측한 **회귀 하나**를 잰다.
 *
 * 크리틱의 문장(그대로 옮긴다):
 *   > 새로 단 그 눈은 「어느 엔진의 한도인가」를 안 본다. 재검증 훅은 `hold.account`
 *   > (= `identity.billing()` = **클로드 구독 계정**)로만 묻는데, Codex 채팅의 대기표도
 *   > 같은 필드를 들고 있다. … 주간 창이 100% 소진된 클로드 계정 때문에 Codex 채팅의
 *   > 대기표가 **50시간 뒤로 재장전**됐고, 그 뒤 **사용자가 직접 보낸 메시지까지 큐에
 *   > 주차**됐다(`queued:1 · spawns:0`). 같은 판에서 **옛 exe는 t=90초에 정상 발사**한다.
 *
 * 그래서 이 하네스는 `poc-limit-engine`과 **판은 같고 축만 다른** 판을 만든다:
 *   ① 격리 홈에 **클로드 계정 하나**(합성 · 살아 있는 액세스 토큰)
 *   ② **Codex 채팅** 하나(`identity.engine.kind='codex'`) + 리셋 시각이 2시간 전인 대기표
 *   ③ codex 실행본 자리에는 **가짜 app-server**(ccg-fakecodex) — 나가면 spawn으로 남는다
 *   ④ `CCG_NO_NET=1` — 클로드 usage 조회가 죽는다(= 훅이 클로드 축을 보면 「못 물어봤다」로
 *      대기표를 유지한다. 실계정 판에서는 그 자리가 `Blocked{50시간 뒤}`였다)
 *
 * **판정의 폴러리티가 `poc-limit-engine`과 반대다.** 저쪽은 "안 쏴야 한다"를 재고
 * 이쪽은 "쏴야 한다"를 잰다 — Codex 채팅에는 물어볼 클로드 창이 애초에 없기 때문이다.
 * 두 하네스를 같이 돌려야 이 라운드가 **한쪽을 고치며 다른 쪽을 깨지 않았다**가 증명된다.
 *
 * 대조군(회귀가 살아 있는 exe)에서는 C1·C2가 빨강이어야 한다 — 판별력의 증거다:
 *   node scripts/poc-limit-codex.mjs --exe=<옛 exe> --out=<레포 밖>
 *
 * ── 안전 규칙 ───────────────────────────────────────────────────────────────
 *  · 실계정 0건(합성 자격증명) · `CCG_NO_NET=1`이라 HTTP 0건 = 토큰 회전 0.
 *  · 이름 기반 kill 금지 — 죽이는 것은 spawn한 PID 트리뿐.
 *  · 앱 홈·CDP 포트는 CRIT 갈래 전용(다른 갈래와 안 겹친다).
 *
 *   node scripts/poc-limit-codex.mjs [--exe=…] [--fakecodex=…] [--keep] [--out=…]
 * ========================================================================== */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { connectMainPage, killTree, sleep, REPO } from '../bench/lib.mjs'

const args = process.argv.slice(2)
const KEEP = args.includes('--keep')
const argOf = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) ?? '').split('=')[1] || d
// ★R28f WFIRE — 홈·CDP 포트를 **인자로 받는다**(기본값은 R28e 그대로 · `poc-limit-engine`과
// 같은 이유). 다섯 갈래가 한 워킹트리에서 도는 라운드라 하드코딩은 서로의 홈·포트를 밟는다.
const HOME = argOf('home', path.join(REPO, '.poc-home-codex-crit'))
const PORT = Number(argOf('port', 9437))
const OUT = argOf('out', path.join(REPO, 'docs', 'critic', 'limit-codex-crit-r1.json'))
const EXE = argOf('exe', path.join(REPO, 'target-crit', 'release', 'agentcodegui.exe'))
const FAKECODEX = argOf('fakecodex', path.join(REPO, 'target-crit', 'release', 'ccg-fakecodex.exe'))
const WATCH_S = Number(argOf('watch', 120))
const EMAIL = 'codex-seed@crit.test'
const CHAT = 'c-codex-hold'

const rep = { at: new Date().toISOString(), exe: EXE, watchSec: WATCH_S, steps: {}, findings: [] }
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

/** `ccg_auth::account_slug`의 JS 원본 — 폴더 이름이 어긋나면 토큰을 못 찾아 판이 달라진다. */
function accountSlug(email) {
  const safe = email.toLowerCase().replace(/[^a-z0-9._-]+/g, '_')
  let h = 0
  for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) >>> 0
  return `${safe}-${h.toString(36)}`
}

function seedHome() {
  rmrf(HOME)
  const work = path.join(HOME, 'work')
  fs.mkdirSync(work, { recursive: true })

  // ① 클로드 계정 — 크리틱 판의 "주간 100%인 그 계정" 자리다. 토큰은 살아 있고(로컬),
  //    조회만 죽는다(`CCG_NO_NET`). 훅이 이 축을 보면 대기표를 유지한다.
  write(path.join(HOME, 'accounts.json'), {
    version: 3,
    defaultEmail: EMAIL,
    accounts: [{ email: EMAIL, subscriptionType: 'max' }]
  })
  write(path.join(HOME, 'accounts', accountSlug(EMAIL), '.credentials.json'), {
    claudeAiOauth: { accessToken: 'A-codex-seed', expiresAt: Date.now() + 3600_000, scopes: ['user:inference'] }
  })
  // codex 계정은 **하나도 없다** — 크리틱의 판 그대로다(등록 codex 계정 0).

  // ② 가짜 codex app-server. `initialize`에 답하고 그 뒤엔 조용히 산다 —
  //    스폰이 일어났다는 사실만 남기면 되고, 턴을 완주시킬 이유는 없다.
  write(
    path.join(HOME, 'fakecodex.jsonl'),
    [JSON.stringify({ await: 'initialize', result: { userAgent: 'fake' } })].join('\n')
  )

  // ③ Codex 채팅 + **리셋 시각이 2시간 전인 대기표**.
  const resetsAt = Math.floor(Date.now() / 1000) - 7200
  write(path.join(HOME, 'chats-v3', 'index.json'), { version: 1, order: [CHAT], activeChatId: CHAT })
  write(path.join(HOME, 'chats-v3', `${CHAT}.json`), {
    id: CHAT,
    title: 'Codex 한도 대기표',
    identity: {
      // ★ 이 한 줄이 이 하네스의 과녁이다.
      engine: { kind: 'codex', model: 'gpt-5.6-codex', effort: 'medium', codexAccount: null },
      // 그런데 과금 축은 여전히 **클로드 계정**이다(정규화가 기본 계정으로 접는다) —
      // 회귀의 뿌리가 정확히 여기다.
      billing: { kind: 'subscription', account: EMAIL, dropEnvKey: false },
      cwd: work,
      addDirs: [],
      mode: 'auto',
      systemPrompt: null,
      outputStyle: null,
      tools: { skillOverrides: {}, deniedMcp: [] }
    },
    hold: { resetsAt, ready: false },
    draft: '',
    draftImages: [],
    updatedAt: Date.now(),
    snapshot: { messages: [], session: 'T0' }
  })
  write(path.join(HOME, 'ui-prefs.json'), { 'limitResume.on': true })
  return { resetsAt, work }
}

const IPC = (channel, payload = []) =>
  `await window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: ${JSON.stringify(channel)}, payload: ${JSON.stringify(payload)} })`

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
      CCG_NO_NET: '1',
      CCG_CODEX_BIN: FAKECODEX,
      CCG_FAKECODEX_SCRIPT: path.join(HOME, 'fakecodex.jsonl'),
      CCG_FAKECODEX_IN: path.join(HOME, 'codex-stdin.log'),
      // 부팅 엔진 자동 업데이트는 이 측정과 무관하고 735MB를 받는다(크리틱 R2 §6).
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

/** 발사의 물증 — 가짜 app-server가 받은 바이트. */
const stdinBytes = () => {
  try {
    return fs.statSync(path.join(HOME, 'codex-stdin.log')).size
  } catch {
    return 0
  }
}

async function main() {
  const seed = seedHome()
  const app = await boot()
  const pid = app.child.pid
  const samples = []
  try {
    await app.j(IPC('chats:get', [{ light: true }])).catch(() => null)
    await sleep(3000)

    const dbg0 = await app.j(IPC('engine:debug'))
    const row0 = (dbg0?.chats ?? []).find((c) => c.chatId === CHAT) ?? null
    rep.steps.reload = { row: row0, limitProbe: dbg0?.limitProbe ?? null }
    check('C0 부팅 재장전이 엔진에 대기표를 다시 걸었다', !!row0?.hold, '엔진이 표를 안 들었다 = 이 하네스가 재는 판이 아니다', { row: row0 })
    check('C0′ 자동 재개가 켜진 판이다', row0?.autoResume === true, '자동이 꺼져 있으면 안 쏘는 게 당연하다', { autoResume: row0?.autoResume })
    check('C0″ 이 채팅은 Codex 정체성이다', row0?.identityEngine === 'codex', '엔진 축이 codex가 아니면 과녁이 틀렸다', {
      identityEngine: row0?.identityEngine ?? null,
      driverEngine: row0?.engine ?? null
    })

    // ★ 크리틱 §3.2의 두 번째 사실 — 대기표가 살아 있는 동안 **사용자가 직접 보낸 메시지**.
    //   표가 있으면 큐에 서는 것이 정상이고(게이트), 표가 풀리면 그 줄이 그대로 나가야 한다.
    //   회귀 판에서는 표가 50시간 뒤로 재장전돼 그 줄이 **영원히 서 있었다**.
    await app.j(IPC('chat:run', [{ chatId: CHAT, prompt: '사용자가 직접 보낸 새 메시지' }])).catch(() => null)
    await sleep(1500)
    const parked = await app.j(IPC('engine:debug')).catch(() => null)
    rep.steps.userSend = (parked?.chats ?? []).find((c) => c.chatId === CHAT) ?? null
    console.log(`   [사용자 전송] queued=${(rep.steps.userSend?.queue ?? []).length} state=${rep.steps.userSend?.state}`)

    console.log(`\n① 관찰 — ${WATCH_S}초 (Codex 채팅 · 리셋 시각 2시간 전 · 자동 ON · CCG_NO_NET=1)`)
    const t0 = Date.now()
    let best = { spawns: 0, stdin: 0 }
    while ((Date.now() - t0) / 1000 < WATCH_S) {
      await sleep(5000)
      const dbg = await app.j(IPC('engine:debug')).catch(() => null)
      const row = (dbg?.chats ?? []).find((c) => c.chatId === CHAT) ?? null
      const s = {
        t: Math.round((Date.now() - t0) / 1000),
        spawns: row?.spawns ?? -1,
        queue: (row?.queue ?? []).length,
        hold: row?.hold ?? null,
        stdin: stdinBytes(),
        probe: dbg?.limitProbe ?? null
      }
      samples.push(s)
      best = { spawns: Math.max(best.spawns, s.spawns), stdin: Math.max(best.stdin, s.stdin) }
      process.stdout.write(
        `   t=${String(s.t).padStart(3)}s spawns=${s.spawns} stdin=${s.stdin}B hold=${s.hold ? 'yes' : 'no'} ` +
          `resetsAt=${s.hold?.resetsAt ?? '-'} blocked=${s.probe?.blocked ?? '-'} unknown=${s.probe?.unknown ?? '-'}\n`
      )
      if (s.spawns > 0) break // 이겼다 — 더 볼 것이 없다
    }
    rep.steps.samples = samples
    const last = samples[samples.length - 1] ?? {}
    const fired = samples.find((s) => s.spawns > 0) ?? null
    rep.steps.fired = fired

    console.log('\n② 판정 — Codex 채팅이 클로드 한도에 잡히지 않는가')
    check('C1 ★★ 대기표가 풀려 실제로 발사됐다', best.spawns > 0, `${WATCH_S}초 동안 spawns=0 — Codex 채팅이 잠겼다`, {
      spawns: best.spawns,
      firedAt: fired?.t ?? null
    })
    check('C2 ★★ 클로드 창으로 「막혔다」 판정을 한 적이 없다', (last.probe?.blocked ?? 0) === 0, `blocked=${last.probe?.blocked}`, {
      probe: last.probe
    })
    check(
      'C3 ★ 물어볼 창구가 없다고 판정했다(unknown)',
      (last.probe?.unknown ?? 0) > 0,
      '엔진 축 갈래를 안 탔다(=옛 코드이거나 클로드 축으로 샜다)',
      { probe: last.probe }
    )
    // 재장전이 일어났다면 그 시각이 클로드 주간 창(수십 시간)일 리 없다.
    const relArmed = samples.filter((s) => s.hold?.resetsAt && s.hold.resetsAt > 3600_000)
    check('C4 대기표가 몇십 시간 뒤로 재장전되지 않았다', relArmed.length === 0, JSON.stringify(relArmed[0]?.hold), {
      first: relArmed[0] ?? null
    })

    console.log('\n③ 사용자가 직접 보낸 메시지 — 대기표와 함께 풀렸는가(크리틱 §3.2)')
    await sleep(3000)
    const after = await app.j(IPC('engine:debug')).catch(() => null)
    const rowA = (after?.chats ?? []).find((c) => c.chatId === CHAT) ?? null
    rep.steps.afterFire = rowA
    check(
      'C5 ★ 사용자 메시지가 큐에서 풀려 나갔다',
      (rowA?.queue ?? []).length === 0 && (rowA?.spawns ?? 0) > 0 && !rowA?.hold,
      `queued=${(rowA?.queue ?? []).length} · spawns=${rowA?.spawns} · hold=${JSON.stringify(rowA?.hold ?? null)}`,
      { queue: rowA?.queue ?? [], spawns: rowA?.spawns ?? null, hold: rowA?.hold ?? null }
    )
  } finally {
    try {
      app.cdp.close?.()
    } catch {
      /* ignore */
    }
    rep.steps.appLog = app.log().slice(-4000)
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
