#!/usr/bin/env node
/* ============================================================================
 * poc-limit-engine — R28 확인 크리틱 R2가 세운 **통과 조건 하나**를 실물로 잰다.
 *
 * 크리틱의 문장(그대로 옮긴다):
 *   > 본채팅에 이번 안전장치가 아예 안 걸린다 — `lite.rs`가 `resumeOwner:"engine"`을
 *   > 조건 없이 실어 `useLimitResume`이 장전·타이머·재검증·소진을 전부 건너뛴다.
 *   > 그런데 엔진 쪽 재검증의 원천은 아직 `NoProbe`(=「풀린 것으로 두고 진행」)다.
 *   > **통과 조건은 하나다 — 대기표를 심은 본채팅에서 조회 불가 판(CCG_NO_NET=1 +
 *   > 리셋 시각 경과)을 만들고 전송 0이 나오는 실측.**
 *
 * 그래서 이 하네스는 **엔진의 판**을 만든다(렌더러 pref가 아니라):
 *   ① 격리 홈에 채팅 하나를 심고 `chats-v3/<id>.json`에 `hold`(리셋 시각 = 2시간 전)를 넣는다.
 *      부팅 재장전(`engine/mod.rs::reload_pending`)이 그 표를 엔진 런타임에 다시 건다.
 *   ② 그 채팅을 **활성**으로 둔다 = `auto_resume: true`. 자동이 켜진 최악의 판이다.
 *   ③ 엔진 자리에는 **가짜 CLI**(ccg-fakecli)를 꽂는다. 한 글자라도 나가면
 *      `stdin.log`에 바이트로 남는다 — 「전송 0」의 물증이 추론이 아니라 파일이다.
 *   ④ `CCG_NO_NET=1` — 토큰은 나오는데 usage 조회가 죽는 그 판.
 *
 * 재는 것:
 *   A. 관찰창(기본 110초) 내내 **spawns 0 · stdin.log 없음 · 큐에 재개 나팔 0**
 *   B. 재검증이 **돌긴 돈다**(`limitProbe.asks`가 오르고 판정이 `unavailable`)
 *   C. 재확인 간격이 15초부터 배로 — tick마다 조회를 때리지 않는다
 *   D. (--long) 계속 실패하면 **눌러서 이어가기**로 착지한다(ready·autoPaused) —
 *      눈감고 쏘는 대신 사용자에게 넘긴다. 그리고 눌렀을 때 정확히 한 번 나간다.
 *
 * ── 안전 규칙 ───────────────────────────────────────────────────────────────
 *  · 실계정을 한 줄도 안 읽는다(합성 자격증명) · `CCG_NO_NET=1`이라 HTTP 0건 = 토큰 회전 0.
 *  · 이름 기반 kill 금지 — 죽이는 것은 spawn한 PID 트리뿐.
 *  · 앱 홈·CDP 포트는 T3T4 갈래 전용.
 *
 *   node scripts/poc-limit-engine.mjs [--exe=…] [--fakecli=…] [--long] [--keep] [--out=…]
 * ========================================================================== */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { connectMainPage, killTree, sleep, REPO } from '../bench/lib.mjs'

const args = process.argv.slice(2)
const KEEP = args.includes('--keep')
const LONG = args.includes('--long')
const HOME = path.join(REPO, '.poc-home-engine-t3t4')
const PORT = 9425
const argOf = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) ?? '').split('=')[1] || d
const OUT = argOf('out', path.join(REPO, 'docs', 'critic', 'limit-engine-t3t4-r3.json'))
const EXE = argOf('exe', path.join(REPO, 'target-t3t4', 'release', 'agentcodegui.exe'))
const FAKECLI = argOf('fakecli', path.join(REPO, 'target-t3t4', 'release', 'ccg-fakecli.exe'))
/** 관찰창(초). 크리틱은 92초를 봤다 — 그보다 길게 본다. */
const WATCH_S = Number(argOf('watch', LONG ? 540 : 110))
const EMAIL = 'engine-seed@t3t4.test'
const CHAT = 'c-limit-engine'

const rep = { at: new Date().toISOString(), exe: EXE, watchSec: WATCH_S, long: LONG, steps: {}, findings: [] }
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

  // ① 합성 계정 — **살아 있는 액세스 토큰**이라 `access_token`이 네트워크 없이 돈다.
  //    그 뒤 `send`가 CCG_NO_NET으로 죽는다 = 「토큰은 나오는데 조회가 죽는」 그 판.
  write(path.join(HOME, 'accounts.json'), {
    version: 3,
    defaultEmail: EMAIL,
    accounts: [{ email: EMAIL, subscriptionType: 'max' }]
  })
  write(path.join(HOME, 'accounts', accountSlug(EMAIL), '.credentials.json'), {
    claudeAiOauth: { accessToken: 'A-engine-seed', expiresAt: Date.now() + 3600_000, scopes: ['user:inference'] }
  })

  // ② 가짜 CLI를 엔진 자리에 꽂는다 — **한 글자라도 나가면 파일로 남는다.**
  const engd = path.join(HOME, 'engines', 'fake', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64')
  fs.mkdirSync(engd, { recursive: true })
  fs.copyFileSync(FAKECLI, path.join(engd, 'claude.exe'))
  write(path.join(HOME, 'config.json'), { activeVersion: 'fake' })
  // 스폰되면 곧바로 정상 종료하는 대본(전송이 일어났을 때 앱이 매달리지 않게).
  write(
    path.join(HOME, 'fake.jsonl'),
    [
      JSON.stringify({ emit: { type: 'system', subtype: 'init', session_id: 'S1', model: 'opus' } }),
      JSON.stringify({
        emit: { type: 'result', subtype: 'success', is_error: false, result: '(가짜 응답)', session_id: 'S1' },
        afterMs: 200
      }),
      JSON.stringify({ exit: 0 })
    ].join('\n')
  )

  // ③ 채팅 하나 + **리셋 시각이 2시간 전인 대기표**.
  const resetsAt = Math.floor(Date.now() / 1000) - 7200
  write(path.join(HOME, 'chats-v3', 'index.json'), { version: 1, order: [CHAT], activeChatId: CHAT })
  write(path.join(HOME, 'chats-v3', `${CHAT}.json`), {
    id: CHAT,
    title: '한도 대기표',
    identity: {
      engine: { kind: 'claude', model: 'opus', effort: 'xhigh', codexAccount: null },
      billing: { kind: 'subscription', account: EMAIL, dropEnvKey: false },
      cwd: work,
      addDirs: [],
      mode: 'auto',
      systemPrompt: null,
      outputStyle: null,
      tools: { skillOverrides: {}, deniedMcp: [] }
    },
    // ★ 이 표가 이 하네스의 과녁이다. 리셋 시각은 이미 지났다 = 옛 판이 쏘던 조건.
    hold: { resetsAt, ready: false },
    draft: '',
    draftImages: [],
    updatedAt: Date.now(),
    snapshot: { messages: [], session: 'S0' }
  })
  // 한도 자동 이어서 토글은 켜 둔 상태(최악의 판).
  write(path.join(HOME, 'ui-prefs.json'), { 'limitResume.on': true })
  return { resetsAt, work }
}

const IPC = (channel, payload = []) =>
  `await window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: ${JSON.stringify(channel)}, payload: ${JSON.stringify(payload)} })`

async function boot() {
  for (const [what, p] of [
    ['빌드된 exe', EXE],
    ['가짜 CLI', FAKECLI]
  ])
    if (!fs.existsSync(p))
      throw new Error(`${what}가 없다: ${p}\n  cargo build --release --features custom-protocol\n  cargo build -p ccg-engine --features fakecli --release --bin ccg-fakecli`)
  const child = spawn(EXE, [], {
    cwd: REPO,
    env: {
      ...process.env,
      CCG_HOME: HOME,
      CCG_CDP_PORT: String(PORT),
      CCG_NO_NET: '1',
      CCG_FAKECLI_SCRIPT: path.join(HOME, 'fake.jsonl'),
      CCG_FAKECLI_IN: path.join(HOME, 'stdin.log')
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

/** 전송의 물증 — 가짜 CLI가 받은 stdin 바이트. */
const stdinBytes = () => {
  try {
    return fs.statSync(path.join(HOME, 'stdin.log')).size
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
    // 부팅 재장전은 `chats:get`이 도는 부팅 흐름에서 걸린다 — 화면이 뜬 뒤 한 박자 준다.
    await app.j(IPC('chats:get', [{ light: true }])).catch(() => null)
    await sleep(3000)

    const dbg0 = await app.j(IPC('engine:debug'))
    const row0 = (dbg0?.chats ?? []).find((c) => c.chatId === CHAT) ?? null
    rep.steps.reload = { row: row0, limitProbe: dbg0?.limitProbe ?? null }
    check('E0 부팅 재장전이 엔진에 대기표를 다시 걸었다', !!row0?.hold, '엔진이 표를 안 들었다 = 이 하네스가 재는 판이 아니다', { row: row0 })
    check('E0′ 자동 재개가 켜진 최악의 판이다', row0?.autoResume === true, '자동이 꺼져 있으면 안 쏘는 게 당연하다', { autoResume: row0?.autoResume })

    console.log(`\n① 관찰 — ${WATCH_S}초 (CCG_NO_NET=1 · 리셋 시각 2시간 전 · 자동 ON)`)
    const t0 = Date.now()
    let worst = { spawns: 0, stdin: 0, queue: 0 }
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
      worst = {
        spawns: Math.max(worst.spawns, s.spawns),
        stdin: Math.max(worst.stdin, s.stdin),
        queue: Math.max(worst.queue, s.queue)
      }
      process.stdout.write(
        `   t=${String(s.t).padStart(3)}s spawns=${s.spawns} stdin=${s.stdin}B queue=${s.queue} ` +
          `probes=${s.hold?.probes ?? '-'} ready=${s.hold?.ready ?? '-'} asks=${s.probe?.asks ?? '-'}\n`
      )
      if (s.spawns > 0 || s.stdin > 0) break // 이미 졌다 — 더 볼 것이 없다
    }
    rep.steps.samples = samples
    const last = samples[samples.length - 1] ?? {}

    console.log('\n② 판정')
    check('E1 ★★ 전송 0 — CLI가 한 번도 안 떴다', worst.spawns === 0, `spawns=${worst.spawns}`, { spawns: worst.spawns })
    check('E1′ ★★ 전송 0 — 가짜 CLI의 stdin이 비었다(바이트 물증)', worst.stdin === 0, `${worst.stdin}바이트가 나갔다`, { bytes: worst.stdin })
    check('E2 재개 나팔이 큐에 안 들어갔다', worst.queue === 0, `큐 ${worst.queue}건`, { queue: worst.queue })
    check('E3 대기표가 살아 있다(소진 = 전송이다)', !!last.hold, '표가 사라졌다', { hold: last.hold })
    check('E4 「풀렸다」로 켜지지 않았다', last.hold?.ready === false, 'ready=true = 못 물어봤는데 풀렸다고 했다', { hold: last.hold })

    console.log('\n③ 재검증이 실제로 돌았나(안 도는 것과 구분)')
    check('E5 ★ 훅이 배선돼 있다(asks > 0)', (last.probe?.asks ?? 0) > 0, '엔진이 훅을 한 번도 안 물었다 = NoProbe 그대로다', { probe: last.probe })
    check('E6 판정이 「못 물어봤다」로 나왔다', (last.probe?.unavailable ?? 0) > 0 && (last.probe?.clear ?? 0) === 0, JSON.stringify(last.probe), { probe: last.probe })
    check('E7 재확인 계수가 올랐다', (last.hold?.probes ?? 0) >= 2, `probes=${last.hold?.probes}`, { probes: last.hold?.probes })
    // 15·30·60·120·240초 사다리 = 110초에 4회 안쪽. tick(20ms)마다 물으면 수천이다.
    check('E8 tick마다 조회하지 않는다(사다리)', (last.probe?.asks ?? 0) <= Math.ceil(WATCH_S / 15) + 2, `asks=${last.probe?.asks}`, {
      asks: last.probe?.asks
    })

    if (LONG) {
      console.log('\n④ --long — 계속 실패하면 「눌러서 이어가기」로 착지하나')
      const give = samples.find((s) => s.hold?.ready === true)
      rep.steps.giveUp = give ?? null
      check('E9 ★ 눈감고 쏘는 대신 사용자에게 넘긴다', !!give?.hold?.autoPaused, '착지가 ready+autoPaused가 아니다', { give })
      check('E9′ 넘기는 그 순간에도 전송은 0이다', (give?.spawns ?? 0) === 0 && (give?.stdin ?? 0) === 0, JSON.stringify(give), { give })
      if (give) {
        // 「눌러서 이어가기」의 유일한 출구 — 채널을 늘리지 않고 `op:'resume'`로 간다.
        await app.j(IPC('chat:queue-mutate', [{ chatId: CHAT, op: 'resume' }])).catch(() => null)
        await sleep(4000)
        const dbg = await app.j(IPC('engine:debug')).catch(() => null)
        const row = (dbg?.chats ?? []).find((c) => c.chatId === CHAT) ?? null
        rep.steps.afterPress = { row, stdin: stdinBytes() }
        check('E10 사용자가 누르면 그때 나간다(출구가 막히면 그건 침묵이다)', (row?.spawns ?? 0) >= 1 || stdinBytes() > 0, JSON.stringify(row), {
          row,
          stdin: stdinBytes()
        })
      }
    }
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
