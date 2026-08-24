/**
 * PoC — ★R28 ACCT **실 exe** 회귀 못(확인 크리틱 R1 F1~F5).
 *
 * 왜 이 파일이 따로 있나: ACCT R1은 단위 테스트와 스텁 하네스가 전부 초록이었는데
 * **실 exe에서 셋이 무너졌다**(F1·F2·F3). 셋 다 "앱을 껐다 켜면"·"부팅 첫 세션이면"
 * 처럼 **프로세스 경계를 넘는** 사실이라, 프로세스 안에서 도는 검증으로는 구조적으로
 * 못 잡는다. 그래서 진짜 exe를 띄우고, 껐다 켜고, 디스크를 읽는다.
 *
 * 시나리오:
 *  A. inuse  (F1·F4) 턴 1회 → 「사용 중」 칩 · `panelId`는 **본채팅이면 없음** →
 *            종료 → `status.json`에 `"account"` **0건** → ★그 파일에 두 키를 도로 끼워
 *            넣어 **R1이 써 둔 홈**을 만든 뒤 재기동 → 「사용 중」 **0건**
 *            (쓰기만 막으면 그 홈은 영원히 유령 칩을 문다 — 읽는 쪽 청소가 이 팔이다)
 *  B. undo   (F2)    전환 → 되돌리기 → **턴 없이** 재시작 → 실제 실행이 **원 계정**
 *  C. top    (F3)    `defaultEmail`=3번째 스토어 첫 부팅 → **그 세션의** 목록·새 채팅이 3번째
 *  D. retry  (F5)    조회 실패 판에서 「다시 시도」가 `retry` 표식을 실어 보낸다
 *                    (셸의 격리 통과 자체는 밖에서 관측 불가 — 그쪽 못은
 *                     `ipc::parity::usage` 단위 테스트 `a_manual_retry_gets_past…`)
 *
 * 안전(이 하네스가 지키는 것):
 *  · `CCG_HOME`은 언제나 격리(`%TEMP%/ccg-acct-live*`) — 사용자 실앱 홈을 안 만진다.
 *  · `CCG_NO_NET=1` + 합성 계정(`ccg-auth-probe seed`) → **실계정 토큰 0회 · 실 HTTP 0건**.
 *  · 종료는 **자기가 spawn한 PID 트리만**(`killTree`) — 이름 기반 kill 금지.
 *
 * 실행:
 *   node scripts/poc-acct-live.mjs --exe=target-acct/release/agentcodegui.exe
 *   node scripts/poc-acct-live.mjs --only=inuse,undo --out=-r2
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { connectMainPage, killTree, sleep } from '../bench/lib.mjs'

const REPO = path.resolve(import.meta.dirname, '..')
const argOf = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=')
const EXE = path.resolve(REPO, argOf('exe', 'target-acct/release/agentcodegui.exe'))
const STUB = path.join(path.dirname(EXE), 'ccg-fakecli.exe')
const PROBE = path.join(path.dirname(EXE), 'ccg-auth-probe.exe')
const ROOT = path.join(process.env.TEMP ?? '/tmp', 'ccg-acct-live' + argOf('out', ''))
const PORT0 = Number(argOf('port', '9486'))
const only = argOf('only', 'all')

for (const [n, p] of [['exe', EXE], ['fakecli', STUB], ['auth-probe', PROBE]]) {
  if (!fs.existsSync(p)) {
    console.error(`[준비 안 됨] ${n}: ${p}\n  cargo build --release --features custom-protocol -p agentcodegui  (스텁은 --features fakecli)`)
    process.exit(2)
  }
}

const rep = { at: new Date().toISOString(), exe: EXE, sc: {}, findings: [] }
const fail = (id, why, extra) => {
  rep.findings.push({ id, why, ...(extra ?? {}) })
  console.error(`  X ${id} — ${why}${extra === undefined ? '' : ' ' + JSON.stringify(extra)}`)
}
const ok = (id, v) => console.log(`  o ${id}${v === undefined ? '' : ' — ' + JSON.stringify(v)}`)
const write = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v))
}
const slug = (e) => e.replace(/@/g, '_')
const rmrf = (p) => {
  for (let i = 0; i < 10; i++) {
    try {
      fs.rmSync(p, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 })
      return
    } catch (e) {
      if (i === 9) throw e
      spawnSync('cmd', ['/c', 'timeout', '/t', '1', '/nobreak'], { stdio: 'ignore' })
    }
  }
}

// ── 가짜 CLI 대본 ────────────────────────────────────────────────────────────
// 계정마다 다른 답(`RAN-<slug>`)을 낸다 — 「어느 계정이 **실제로** 돌았나」의 판별식이다.
// (`ccg_fakecli`가 `CLAUDE_CONFIG_DIR` 꼬리로 형제 대본을 고른다.)
const ack = { type: 'control_response', response: { subtype: 'success', request_id: 'init-1', response: {} } }
const script = (cwd, text) => [
  { afterMs: 60, emit: ack },
  { emit: { type: 'system', subtype: 'init', session_id: 'S', model: 'claude-haiku-4-5', cwd, tools: [], apiKeySource: 'none' } },
  { afterMs: 40, emit: { type: 'assistant', session_id: 'S', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text }], usage: { input_tokens: 7 } } } },
  { emit: { type: 'result', subtype: 'success', is_error: false, result: text, session_id: 'S', total_cost_usd: 0, duration_ms: 1, num_turns: 1 } }
]
const writeScript = (p, steps) => write(p, steps.map((s) => JSON.stringify(s)).join('\n') + '\n')

/**
 * 격리 홈 한 벌. `cacheAgeMs=null`이면 디스크 캐시를 안 심는다(=조회 실패 판).
 * `defaultEmail`을 주면 **2.6.2 승계 판**이 된다(§4 마이그레이션 대상).
 */
function seedHome(name, emails, { cacheAgeMs = 30_000, account = 0, defaultEmail = null } = {}) {
  const HOME = path.join(ROOT, name)
  const WORK = path.join(HOME, 'work')
  rmrf(HOME)
  fs.mkdirSync(WORK, { recursive: true })
  const ed = path.join(HOME, 'engines', 'fake', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64')
  fs.mkdirSync(ed, { recursive: true })
  fs.copyFileSync(STUB, path.join(ed, 'claude.exe'))
  write(path.join(HOME, 'config.json'), { activeVersion: 'fake' })
  write(path.join(HOME, 'engine-auto-update.json'), { enabled: false })
  const sdk = path.join(HOME, 'engines', 'fake', 'node_modules', '@anthropic-ai', 'claude-agent-sdk')
  fs.mkdirSync(sdk, { recursive: true })
  write(path.join(sdk, 'package.json'), { name: '@anthropic-ai/claude-agent-sdk', version: 'fake' })

  const r = spawnSync(PROBE, ['seed', ...emails], { env: { ...process.env, CCG_HOME: HOME }, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`계정 심기 실패: ${r.stderr || r.stdout}`)
  for (const e of emails) fs.mkdirSync(path.join(HOME, 'accounts', slug(e)), { recursive: true })
  if (defaultEmail) {
    const st = JSON.parse(fs.readFileSync(path.join(HOME, 'accounts.json'), 'utf8'))
    st.defaultEmail = defaultEmail
    write(path.join(HOME, 'accounts.json'), JSON.stringify(st, null, 2))
  }
  if (cacheAgeMs != null) {
    const cache = {}
    emails.forEach((e, i) => {
      cache[e] = {
        at: Date.now() - cacheAgeMs,
        data: { email: e, fiveHourPct: 10 + i, weeklyPct: 20 + i * 5, fablePct: null, fiveHourResetsAt: null, weeklyResetsAt: null, fableResetsAt: null }
      }
    })
    write(path.join(HOME, 'usage-cache.json'), cache)
  }
  write(path.join(HOME, 'ui-prefs.json'), { 'ui.lang': 'ko' })
  write(path.join(HOME, 'profile.json'), { nickname: 'poc' })
  write(path.join(HOME, 'chats', 'index.json'), { version: 1, order: ['c-a'], activeChatId: 'c-a' })
  write(path.join(HOME, 'chats', 'c-a.json'), {
    id: 'c-a',
    title: '첫 채팅',
    custom: true,
    manualCwd: WORK,
    picker: { model: 'haiku', effort: 'minimal', mode: 'normal', billing: 'subscription', ...(account == null ? {} : { account: emails[account] }) },
    refDirs: [],
    snapshot: { messages: [] },
    updatedAt: Date.now()
  })
  const SCRIPT = path.join(HOME, 'fake.jsonl')
  writeScript(SCRIPT, script(WORK, 'RAN-default'))
  for (const e of emails) writeScript(path.join(HOME, `fake.${slug(e)}.jsonl`), script(WORK, `RAN-${slug(e)}`))
  return { HOME, WORK, SCRIPT, emails }
}

// 계측은 **문서 생성 시점**에 심는다 — 늦게 붙으면 부팅 워밍을 놓친다.
// (모듈 스코프인 이유: `ensureIpc`가 측정 직전에 같은 문자열을 다시 쓴다.)
const PATCH = `(() => { window.__ipc = []; const t0 = Date.now();
    const wrap = (o, ns, k) => { const f0 = o[k]; if (!f0 || f0.__p) return; const f = function (...a) { window.__ipc.push({ t: Date.now() - t0, ch: ns + ":" + k, p: a[0] === undefined ? null : a[0] }); return f0.apply(o, a) }; f.__p = 1; o[k] = f };
    setInterval(() => { const A = window.api; if (!A) return;
      if (A.auth) { wrap(A.auth, "auth", "accountsUsage"); wrap(A.auth, "auth", "listAccounts") } }, 3) })()`

async function boot(seed, port) {
  const child = spawn(EXE, [], {
    env: {
      ...process.env,
      CCG_HOME: seed.HOME,
      CCG_NO_NET: '1', // ★ 실 HTTP 0건의 킬 스위치
      CCG_FAKECLI_SCRIPT: seed.SCRIPT,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  child.stdout.on('data', (d) => (log += d.toString()))
  child.stderr.on('data', (d) => (log += d.toString()))
  const page = await connectMainPage(port, { timeoutMs: 40_000 })
  // ★R2 — **문서가 갈려도 살아남게** 심는다. R1 주행에서 `window.__ipc`는 부팅 직후엔
  // `true`인데 측정 시점엔 사라져 있었다(= 그 사이 문서가 한 번 갈린다). `Runtime.evaluate`
  // 한 방으로는 구조적으로 못 잡는 자리다.
  await page.send('Page.enable').catch(() => {})
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: PATCH }).catch(() => {})
  await page.eval(PATCH).catch(() => {})
  const j = async (expr) => JSON.parse(await page.eval(`(async () => JSON.stringify(${expr}))()`, { awaitPromise: true }))
  for (let i = 0; i < 500; i++) {
    const up = await j(`(async () => { try { return !!(await window.api.app.getVersion()) } catch { return false } })()`).catch(() => false)
    if (up) break
    await sleep(100)
  }
  // ★R2 — **한 번 더 심는다.** 위 주입은 아직 문서가 갈리기 전(초기 문서)에 들어갈 수
  // 있고, 그러면 앱이 자기 문서로 넘어가는 순간 `window.__ipc`가 통째로 사라진다
  // (R1 주행에서 실제로 그랬다 — D 시나리오가 `undefined.filter`로 죽었다).
  // 이 자리는 `window.api`가 확인된 뒤라 문서가 확정이다. 이미 있으면 `f.__p` 가드가
  // 이중 래핑을 막는다.
  await page.eval(`(() => { if (!window.__ipc) { ${PATCH} } return !!window.__ipc })()`).catch(() => {})
  // 패치노트 오버레이가 뜨면 클릭을 가린다 — 닫는다.
  await j(`(() => { const x = document.querySelector('.pn-x') || document.querySelector('.pn-go'); if (x) x.click(); return !!x })()`).catch(() => {})
  return { child, page, j, log: () => log }
}

async function waitUntil(app, expr, ms = 20_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await app.j(`await (async () => !!(${expr}))()`).catch(() => false)) return true
    await sleep(120)
  }
  return false
}
const stop = async (app) => {
  try {
    killTree(app.child.pid)
  } catch {}
  await sleep(1500) // 종료 flush(디스크 쓰기)까지 기다린다
}
/** ★R2 — `__TAURI_INTERNALS__`가 뜬 **뒤에** 구독한다(부팅 직후에 부르면 undefined다). */
const armStatus = async (app) => {
  await waitUntil(app, `!!window.__TAURI_INTERNALS__`, 30_000)
  return app.j(`await (async () => { const I = window.__TAURI_INTERNALS__; window.__st = window.__st ?? []
    await I.invoke('plugin:event|listen', { event: 'chat:status', target: { kind: 'Any' }, handler: I.transformCallback((e) => window.__st.push(e.payload)) })
    return 'armed' })()`)
}
const lastStatus = (app) =>
  app.j(`(window.__st?.at(-1) ?? []).map((r) => ({ chatId: r.chatId, status: r.status, account: r.account ?? null, panelId: r.panelId ?? null }))`)
const sendTurn = (app, text) =>
  app.j(`(() => {
    const ta = document.querySelector('.composer-row textarea'); if (!ta) return 'no-composer'
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    set.call(ta, ${JSON.stringify(text)}); ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus()
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    return 'sent'
  })()`)
const openAccountTab = async (app) => {
  await app.j(`(() => { const b = document.querySelector('.sb-foot'); if (b) b.click(); return !!b })()`)
  await waitUntil(app, `!!document.querySelector('.set-nav, .set-h1')`, 15_000)
  await app.j(`(() => { const t = [...document.querySelectorAll('button, .set-nav *')].find((n) => (n.textContent||'').trim() === 'Account'); if (t) t.click(); return !!t })()`)
  await waitUntil(app, `!!document.querySelector('.sc2.acct')`, 15_000)
}
/** 계측이 살아 있나 — 없으면 지금 다시 심는다(측정 창은 이 순간부터다). */
const ensureIpc = (app) => app.j(`(() => { if (!window.__ipc) { ${PATCH} } return (window.__ipc ?? []).length })()`)
const badges = (app) => app.j(`[...document.querySelectorAll('.sc2.acct .set-badge')].map((n) => n.textContent)`)
const chip = (app) => app.j(`document.querySelector('.model-chip')?.innerText ?? null`)
const threadText = (app) => app.j(`document.querySelector('.thread')?.innerText ?? document.body.innerText`)

// ── A. F1·F4 — 「사용 중」은 프로세스와 함께 죽는다 ───────────────────────────
async function scInUse() {
  console.log('\n[A] F1·F4 — 「사용 중」 칩의 수명(턴 → 종료 → 재기동)')
  const seed = seedHome('inuse', ['one@ccg.test', 'two@ccg.test'])
  const out = {}
  const app = await boot(seed, PORT0)
  try {
    await armStatus(app)
    await waitUntil(app, `!!document.querySelector('.composer-row textarea')`, 30_000)
    await sendTurn(app, '안녕')
    await sleep(3500)
    out.liveStatus = await lastStatus(app)
    await openAccountTab(app)
    await sleep(800)
    out.chipLive = await badges(app)
    const row = out.liveStatus.find((r) => r.chatId === 'c-a')
    if (row?.account !== seed.emails[0]) fail('A-살아 있는 런타임', 'chat:status에 계정이 안 실렸다', out.liveStatus)
    else ok('A-살아 있는 런타임', row)
    // ★F4 — 본채팅은 자리 번호를 안 단다(마이그레이션의 `default` 보드는 `chrome:"ide"`).
    if (row?.panelId) fail('A-F4 본채팅 자리', `본채팅에 자리 id가 붙었다(칩이 「1번 자리」가 된다): ${row.panelId}`)
    else ok('A-F4 본채팅 자리', null)
    if (!out.chipLive.some((s) => /사용 중/.test(s))) fail('A-칩(살아 있음)', '살아 있는 런타임인데 「사용 중」 칩이 없다', out.chipLive)
    else if (out.chipLive.some((s) => /\d번 자리/.test(s))) fail('A-칩 문구', '★ 본채팅이 「N번 자리」로 표기됐다', out.chipLive)
    else ok('A-칩(살아 있음)', out.chipLive)
  } catch (e) {
    console.error(e?.stack)
    fail('A-1', String(e?.message ?? e))
  } finally {
    out.log1 = app.log().split('\n').filter(Boolean).slice(-8)
    await stop(app)
  }

  // ★ 디스크 — `status.json`에 계정이 남으면 그 홈은 영원히 유령 칩을 문다.
  for (const p of [path.join(seed.HOME, 'chats-v3', 'status.json'), path.join(seed.HOME, 'chats', 'status.json')]) {
    if (fs.existsSync(p)) {
      out.statusFile = p
      out.statusRaw = fs.readFileSync(p, 'utf8')
      break
    }
  }
  out.accountOnDisk = (out.statusRaw ?? '').includes('"account"')
  if (out.accountOnDisk) fail('A-디스크', '★ status.json에 account가 영속됐다', { file: out.statusFile, raw: out.statusRaw?.slice(0, 300) })
  else ok('A-디스크', { file: out.statusFile ? path.basename(out.statusFile) : null, len: (out.statusRaw ?? '').length })

  // ★R2 — **R1이 이미 써 둔 홈**을 만든다: 쓰기만 막으면 그 홈은 영원히 유령 칩을 문다
  // (확인 크리틱 R1 F1의 지시 (1) — 읽는 쪽에서도 걷어내는지가 여기서 갈린다).
  // 방금 앱이 쓴 진짜 파일에 두 키를 도로 끼워 넣는다 = R1 판의 status.json과 같은 모양.
  if (out.statusFile) {
    const st = JSON.parse(out.statusRaw)
    for (const row of Object.values(st.statuses ?? {})) {
      row.account = seed.emails[0]
      row.panelId = 'default::0'
    }
    write(out.statusFile, JSON.stringify(st))
    out.poisoned = fs.readFileSync(out.statusFile, 'utf8')
  }

  // ★ 재기동 — 아무 런타임도 없는 판.
  const app2 = await boot(seed, PORT0 + 1)
  try {
    await armStatus(app2)
    await waitUntil(app2, `!!document.querySelector('.composer-row textarea')`, 30_000)
    await sleep(2500)
    out.rebootStatus = await lastStatus(app2)
    await openAccountTab(app2)
    await sleep(1000)
    out.chipReboot = await badges(app2)
    if (out.rebootStatus.some((r) => r.account)) fail('A-재기동 status', '★ 런타임이 없는데 account 키가 살아났다', out.rebootStatus)
    else ok('A-재기동 status', out.rebootStatus)
    if (out.chipReboot.some((s) => /사용 중/.test(s))) fail('A-재기동 유령칩', '★ 아무것도 안 도는데 「사용 중」 칩이 섰다', { badges: out.chipReboot, poisoned: out.poisoned })
    else ok('A-재기동 유령칩', { badges: out.chipReboot, 오염된입력: (out.poisoned ?? '').includes('"account"') })
  } catch (e) {
    console.error(e?.stack)
    fail('A-2', String(e?.message ?? e))
  } finally {
    out.log2 = app2.log().split('\n').filter(Boolean).slice(-8)
    rep.sc.inuse = out
    await stop(app2)
  }
}

// ── B. F2 — 되돌리기는 정체성에 닿는다 ───────────────────────────────────────
async function scUndo() {
  console.log('\n[B] F2 — 전환 → 되돌리기 → **턴 없이** 재시작 → 원 계정으로 실행')
  const seed = seedHome('undo', ['one@ccg.test', 'two@ccg.test', 'three@ccg.test'])
  const out = {}
  const app = await boot(seed, PORT0 + 2)
  try {
    await waitUntil(app, `!!document.querySelector('.composer-row textarea')`, 30_000)
    await sleep(1500)
    out.chip0 = await chip(app)
    await app.j(`(() => { const b = document.querySelector('.model-chip'); if (b) b.click(); return !!b })()`)
    await sleep(700)
    out.picked = await app.j(`(() => {
      const rows = [...document.querySelectorAll('.pp-row')].filter((n) => /남음|left/.test(n.innerText))
      const other = rows.find((n) => !n.className.includes('cur')); if (!other) return 'no-other'
      const label = other.innerText.split('\\n')[0]; other.click(); return label })()`)
    await sleep(400)
    // 되돌릴 줄은 **팝오버가 닫힌 뒤에** 뜬다(실수를 알아채는 건 보통 닫은 뒤라서).
    await app.j(`(() => { document.body.click(); document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return 1 })()`)
    await sleep(700)
    out.undoRow = await app.j(`document.querySelector('.acct-undo')?.innerText?.replace(/\\n+/g,' | ') ?? null`)
    if (!out.undoRow) fail('B-되돌릴 줄', '「A → B 전환됨 · 되돌리기」가 없다', { picked: out.picked })
    else ok('B-되돌릴 줄', out.undoRow)
    await app.j(`(() => { const b = [...document.querySelectorAll('.acct-undo button')].find((n) => /되돌리기|Undo/.test(n.textContent)); if (!b) return 'no-btn'; b.click(); return 'clicked' })()`)
    // ★ 여기서 **턴을 보내지 않는다** — 실행 경로가 정체성을 재물질화하면 F2가 가려진다.
    await sleep(3000)
    out.chipAfter = await chip(app)
  } catch (e) {
    console.error(e?.stack)
    fail('B-1', String(e?.message ?? e))
  } finally {
    out.log1 = app.log().split('\n').filter(Boolean).slice(-8)
    await stop(app)
  }

  // ★ 디스크 — 화면만 되돌아왔는지, 파일까지 되돌아왔는지.
  const recPath = path.join(seed.HOME, 'chats-v3', 'c-a.json')
  out.diskAccount = fs.existsSync(recPath)
    ? (JSON.parse(fs.readFileSync(recPath, 'utf8')).identity?.billing?.account ?? null)
    : 'NO-FILE'
  if (out.diskAccount !== seed.emails[0]) fail('B-디스크 정체성', `★ 되돌리기가 화면만 되돌렸다: ${out.diskAccount}`, { want: seed.emails[0] })
  else ok('B-디스크 정체성', out.diskAccount)

  // ★ 재시작 — 그리고 **그제서야** 턴을 보낸다. 실제로 어느 계정이 돌았나.
  const app2 = await boot(seed, PORT0 + 3)
  try {
    await waitUntil(app2, `!!document.querySelector('.composer-row textarea')`, 30_000)
    await sleep(1500)
    out.chipReboot = await chip(app2)
    await sendTurn(app2, '누가 돌았나')
    await sleep(4000)
    const txt = await threadText(app2)
    out.ran = (txt.match(/RAN-[a-z0-9_.]+/gi) ?? []).at(-1) ?? null
    if (out.ran !== `RAN-${slug(seed.emails[0])}`) fail('B-실제 실행 계정', `★ 실수한 계정으로 실행됐다: ${out.ran}`, { chip: out.chipReboot, want: `RAN-${slug(seed.emails[0])}` })
    else ok('B-실제 실행 계정', { ran: out.ran, chip: out.chipReboot })
  } catch (e) {
    console.error(e?.stack)
    fail('B-2', String(e?.message ?? e))
  } finally {
    out.log2 = app2.log().split('\n').filter(Boolean).slice(-8)
    rep.sc.undo = out
    await stop(app2)
  }
}

// ── C. F3 — 마이그레이션은 **첫 세션에서** 보인다 ────────────────────────────
async function scTop() {
  console.log('\n[C] F3 — `defaultEmail`=3번째 스토어의 **첫 부팅**')
  const emails = ['one@ccg.test', 'two@ccg.test', 'three@ccg.test']
  // 계정 미지정 채팅(= 파생 기본을 쓴다) + 옛 기본은 3번째.
  const seed = seedHome('top', emails, { account: null, defaultEmail: emails[2] })
  const out = { want: emails[2] }
  const app = await boot(seed, PORT0 + 4)
  try {
    await waitUntil(app, `!!document.querySelector('.composer-row textarea')`, 30_000)
    await sleep(2500)
    const st = JSON.parse(fs.readFileSync(path.join(seed.HOME, 'accounts.json'), 'utf8'))
    out.storeOrder = st.accounts.map((a) => a.email)
    out.mainChip = await chip(app)
    await openAccountTab(app)
    await sleep(1200)
    out.tabList = await app.j(`[...document.querySelectorAll('.sc2.acct .emt')].map((n) => n.textContent)`)
    // 설정을 닫고 새 채팅 — 파생 기본(맨 위)을 물어야 한다.
    await app.j(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 1 })()`)
    await sleep(900)
    out.newChat = await app.j(`(() => { const b = [...document.querySelectorAll('.sb-new')].find((n) => /새 채팅|New chat/.test(n.textContent)); if (!b) return 'no-btn'; b.click(); return 'clicked' })()`)
    await sleep(2500)
    out.newChip = await chip(app)
    await sendTurn(app, '누가 돌았나')
    await sleep(4000)
    const txt = await threadText(app)
    out.ran = (txt.match(/RAN-[a-z0-9_.]+/gi) ?? []).at(-1) ?? null

    if (out.storeOrder[0] !== emails[2]) fail('C-마이그레이션', '스토어가 안 옮겨졌다', out.storeOrder)
    else ok('C-마이그레이션', out.storeOrder)
    if (out.tabList[0] !== emails[2]) fail('C-첫 세션 목록', '★ 그 세션의 목록이 옛 순서다(재시작해야 맞는다)', out.tabList)
    else ok('C-첫 세션 목록', out.tabList)
    if (!out.newChip?.includes(emails[2].split('@')[0])) fail('C-새 채팅 계정', '★ 새 채팅이 말없이 1번째 계정으로 갈아탔다', { chip: out.newChip })
    else ok('C-새 채팅 계정', out.newChip)
    if (out.ran !== `RAN-${slug(emails[2])}`) fail('C-실제 실행 계정', `★ 실행이 옛 순서의 1번째로 갔다: ${out.ran}`, { want: `RAN-${slug(emails[2])}` })
    else ok('C-실제 실행 계정', out.ran)
  } catch (e) {
    console.error(e?.stack)
    fail('C', String(e?.message ?? e))
  } finally {
    out.log = app.log().split('\n').filter(Boolean).slice(-8)
    rep.sc.top = out
    await stop(app)
  }
}

// ── D. F5 — 「다시 시도」가 표식을 실어 보낸다 ───────────────────────────────
async function scRetry() {
  console.log('\n[D] F5 — 조회 실패 · 「다시 시도」의 봉투')
  const seed = seedHome('retry', ['one@ccg.test', 'two@ccg.test'], { cacheAgeMs: null })
  const out = {}
  const app = await boot(seed, PORT0 + 5)
  try {
    await waitUntil(app, `!!document.querySelector('.composer-row textarea')`, 30_000)
    await sleep(3000)
    await openAccountTab(app)
    await sleep(2500)
    out.hasFail = await app.j(`/한도를 못 불러왔어요|Couldn/.test(document.body.innerText)`)
    // ★R2 — 측정 창은 **여기서부터**다(부팅 중 문서가 갈리면 계측이 통째로 날아간다).
    await ensureIpc(app)
    out.before = await app.j(`(window.__ipc ?? []).filter((c) => /accountsUsage/.test(c.ch)).length`)
    out.clicked = await app.j(`(() => { const b = [...document.querySelectorAll('.lim-state button')].find((n) => /다시 시도|Retry/.test(n.textContent)); if (!b) return 'no-btn'; b.click(); return 'clicked' })()`)
    await sleep(2500)
    out.after = await app.j(`(window.__ipc ?? []).filter((c) => /accountsUsage/.test(c.ch)).length`)
    out.lastOpts = await app.j(`(window.__ipc ?? []).filter((c) => /accountsUsage/.test(c.ch)).map((c) => c.p).slice(-2)`)
    if (!out.hasFail) fail('D-실패 문구', '조회가 불가능한 판인데 실패 문구가 없다')
    else ok('D-실패 문구', true)
    if (out.clicked !== 'clicked') fail('D-버튼', '「다시 시도」 버튼이 없다')
    else if (out.after <= out.before) fail('D-새 조회', '재시도가 새 조회를 안 냈다', { before: out.before, after: out.after })
    else ok('D-새 조회', { before: out.before, after: out.after })
    // ★ 셸의 실패 격리(3분)를 넘는 유일한 근거 — 이 표식이 없으면 버튼이 무동작이다.
    if (out.lastOpts.at(-1)?.retry !== true) fail('D-retry 표식', '★ 수동 재시도 표식이 셸까지 안 간다', out.lastOpts)
    else ok('D-retry 표식', out.lastOpts.at(-1))
  } catch (e) {
    console.error(e?.stack)
    fail('D', String(e?.message ?? e))
  } finally {
    out.log = app.log().split('\n').filter(Boolean).slice(-8)
    rep.sc.retry = out
    await stop(app)
  }
}

const plan = { inuse: scInUse, undo: scUndo, top: scTop, retry: scRetry }
const chosen = only === 'all' ? Object.keys(plan) : only.split(',').filter((k) => plan[k])
console.log(`exe: ${EXE}\n홈: ${ROOT}\n시나리오: ${chosen.join(', ')}`)
for (const k of chosen) await plan[k]()
const reportPath = path.join(REPO, 'docs', 'critic', `acct-live${argOf('out', '')}.json`)
write(reportPath, JSON.stringify(rep, null, 2))
console.log(`\n리포트: ${reportPath}`)
if (rep.findings.length) {
  console.error(`\n❌ FAIL — ${rep.findings.length}건`)
  process.exit(1)
}
console.log('\n✅ PASS')
