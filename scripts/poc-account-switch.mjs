#!/usr/bin/env node
/* ============================================================================
 * poc-account-switch — ★M11 **한도 소진 시 초기화 임박순 자동 계정 전환** 실증.
 *
 * 재생 테스트(`crates/ccg-engine/tests/m11_account_switch.rs`)는 상태기계를 잡고,
 * 단위 테스트(`ccg-auth::switch`)는 판정식을 잡는다. **여기서만 잡히는 것**은 그 둘
 * 사이의 배선이다:
 *
 *   설정 토글(ui-prefs) → 셸 워커(계정 스토어·오염가드·usage 캐시) → `switch::plan`
 *      → 엔진 훅 → 정체성 리비전 → 새 계정으로 재스폰 → **화면의 배너** → 되돌리기
 *
 * 실계정도 네트워크도 안 쓴다:
 *  · 계정은 **합성**이다(`ccg-auth-probe seed` — 이 자리에서 만든 가짜 토큰).
 *  · 한도는 **합성**이다(계정별 대본을 읽는 가짜 CLI).
 *  · usage는 **합성**이다(`usage-cache.json`을 직접 심는다) + `CCG_NO_NET=1`.
 *
 * ── 안전 규칙 (사용자 실앱이 떠 있다) ───────────────────────────────────────
 *  · 이름 기반 kill 금지 — 죽이는 것은 이 스크립트가 spawn한 PID 트리뿐이다.
 *  · 실홈은 **읽지도 않는다**(계정이 합성이라 복사할 것이 없다).
 *  · 앱 홈은 전부 `CCG_HOME`으로 격리한다(레포 안 `.poc-home-m11-*`).
 *
 * 준비:
 *   cargo build -p ccg-engine --features fakecli --bin ccg-fakecli --release
 *   cargo build -p ccg-auth  --features cli      --bin ccg-auth-probe
 *   npm run tauri:build            (또는 --exe=<경로>)
 *
 * 실행:
 *   node scripts/poc-account-switch.mjs                # 전 시나리오
 *   node scripts/poc-account-switch.mjs --only=pick    # 후보 있음 + 배너 + 되돌리기
 *   node scripts/poc-account-switch.mjs --only=none    # 후보 없음(기존 대기표)
 *   node scripts/poc-account-switch.mjs --only=off     # 설정 꺼짐(무동작)
 *   node scripts/poc-account-switch.mjs --only=dirty   # 오염 스킵
 *   node scripts/poc-account-switch.mjs --only=chain   # 연속 소진 A→B→C
 *   node scripts/poc-account-switch.mjs --keep         # 격리 홈 보존
 *   node scripts/poc-account-switch.mjs --out=-sweep   # 산출물 접미사(기준 파일 보호)
 * ========================================================================== */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { connectMainPage, killTree, sleep, REPO, resolveTauriExe } from '../bench/lib.mjs'

const args = process.argv.slice(2)
const only = (args.find((a) => a.startsWith('--only=')) ?? '').split('=')[1] || 'all'
const KEEP = args.includes('--keep')
// M12 R2 — mainBinaryName 변경으로 exe 이름이 둘이다(구·신 모두 탐색·최신 mtime 우선)
const EXE = resolveTauriExe((args.find((a) => a.startsWith('--exe=')) ?? '').split('=')[1])
const STUB = path.join(REPO, 'target', 'release', 'ccg-fakecli.exe')
const PROBE = path.join(REPO, 'target', 'debug', 'ccg-auth-probe.exe')
// ★ 잔여 — `--out=<접미사>`. R1 보고서가 `m11-r1-switch.json`을 근거로 인용하므로
// 재주행이 그 파일을 말없이 덮으면 그 근거가 사라진다(poc-live-chat `--tag`·bench
// `--out`과 같은 규약). 기본값은 안 바꾼다.
const OUT_SUFFIX = (args.find((a) => a.startsWith('--out=')) ?? '').split('=')[1] || ''
const OUT = path.join(REPO, 'docs', 'critic', `m11-r1-switch${OUT_SUFFIX}.json`)

const rep = { at: new Date().toISOString(), exe: EXE, scenarios: {}, findings: [] }
const fail = (id, why, extra) => {
  rep.findings.push({ id, why, ...(extra ?? {}) })
  console.error(`  ✗ ${id} — ${why}`)
}
const ok = (id, v) => console.log(`  ✓ ${id}${v === undefined ? '' : ' — ' + JSON.stringify(v)}`)

const rmrf = (p) => {
  for (let i = 0; i < 12; i++) {
    try {
      fs.rmSync(p, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 })
      return
    } catch (e) {
      if (i === 11) throw e
      spawnSync('cmd', ['/c', 'timeout', '/t', '1', '/nobreak'], { stdio: 'ignore' })
    }
  }
}
const write = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v))
}
/**
 * 이메일 → 계정 폴더 슬러그. `ccg_auth::account_slug`와 **같은 규칙**이어야 한다
 * (crates/ccg-auth/src/lib.rs:125 — 소문자화 · 허용 밖 문자의 **연속 구간**을 `_`
 * 하나로 접기 · 소문자화 **전** UTF-16 코드 유닛 해시의 base36 접미).
 *
 * ★SLUG R1 — 여기 있던 `email.replace(/@/g,'_')`는 규칙이 아니라 **엔진의 옛 추측**과
 * 같은 값이었다. 그래서 이 하네스는 "맞아서" 돈 것이 아니라 **엔진과 같은 실수를 해서**
 * 돌았다: 엔진이 `accounts/a_ccg.test`를 집고 이 파일이 `fake.a_ccg.test.jsonl`을 써서
 * 우연히 맞물렸던 것이다. 엔진이 실물 폴더(`a_ccg.test-<해시>`)를 집기 시작하면 그
 * 맞물림이 풀리고 계정별 대본이 **한 장도 안 골라진다**(전부 기본 대본으로 떨어져
 * 한도 시나리오가 조용히 사라진다).
 */
const slug = (email) => {
  const safe = email.toLowerCase().replace(/[^a-z0-9._-]+/g, '_')
  let h = 0
  for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) >>> 0
  return `${safe}-${h.toString(36)}`
}

// ── 앱 부팅 + CDP ────────────────────────────────────────────────────────────
async function boot(home, port, env = {}) {
  const child = spawn(EXE, [], {
    env: {
      ...process.env,
      CCG_HOME: home,
      // ★ 킬 스위치 — 이 주행은 계정 한도를 **한 번도 실제로 묻지 않는다**.
      CCG_NO_NET: '1',
      ...env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  child.stdout.on('data', (d) => (log += d.toString()))
  child.stderr.on('data', (d) => (log += d.toString()))
  const page = await connectMainPage(port, { timeoutMs: 40_000 })
  // 창이 `window.api`를 붙일 때까지 기다린다 — 부팅 직후의 평가는 조용히 undefined다.
  for (let i = 0; i < 300; i++) {
    const up = await page
      .eval(`(async () => { try { return !!(await window.api.app.getVersion()) } catch { return false } })()`, { awaitPromise: true })
      .catch(() => false)
    if (up) break
    await sleep(100)
  }
  // `poc-live-chat`과 같은 규약: 표현식을 async IIFE + JSON 왕복으로 감싼다
  // (CDP `Runtime.evaluate`는 톱레벨 await를 모른다).
  const j = async (expr) => JSON.parse(await page.eval(`(async () => JSON.stringify(${expr}))()`, { awaitPromise: true }))
  return { child, page, log: () => log, j }
}
async function waitUntil(app, expr, ms = 30_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await app.j(`await (async () => !!(${expr}))()`).catch(() => false)) return true
    await sleep(120)
  }
  return false
}
async function typeAndSend(app, text) {
  return await app.j(`(() => {
    const ta = document.querySelector('.composer-row textarea') || document.querySelector('textarea')
    if (!ta) return 'no-textarea'
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    set.call(ta, ${JSON.stringify(text)})
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    ta.focus()
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    return 'sent'
  })()`)
}
const dbg = (app) => app.j(`await window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: 'engine:debug', payload: [] })`)

// ── 대본 ─────────────────────────────────────────────────────────────────────
const ack = { type: 'control_response', response: { subtype: 'success', request_id: 'init-1', response: {} } }
const init = (sid, cwd) => ({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-haiku-4-5', cwd, tools: [], apiKeySource: 'none' })
/** 한도로 죽는 턴. 꼬리의 unix 초가 대기표의 리셋 시각이 된다. */
const limitScript = (cwd, resetsAt) => [
  { afterMs: 80, emit: ack },
  { emit: init('LIM-1', cwd) },
  { afterMs: 60, emit: { type: 'result', subtype: 'error_during_execution', is_error: true, result: `Claude AI usage limit reached|${resetsAt}`, session_id: 'LIM-1', total_cost_usd: 0, duration_ms: 1, num_turns: 1 } }
]
/** 평범하게 답하는 턴. */
const okScript = (cwd, text) => [
  { afterMs: 80, emit: ack },
  { emit: init('OK-1', cwd) },
  { afterMs: 60, emit: { type: 'assistant', session_id: 'OK-1', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text }], usage: { input_tokens: 7 } } } },
  { emit: { type: 'result', subtype: 'success', is_error: false, result: text, session_id: 'OK-1', total_cost_usd: 0, duration_ms: 1, num_turns: 1 } }
]
const writeScript = (p, steps) => write(p, steps.map((s) => JSON.stringify(s)).join('\n') + '\n')

/**
 * 격리 홈 하나.
 *
 * @param name      홈 이름
 * @param accounts  [{ email, usage?: {fiveHourPct, fiveHourResetsAt, weeklyPct, weeklyResetsAt}, script: 'limit'|'ok' }]
 * @param opts      { toggle: boolean, dup?: [오염될 이메일, 토큰 주인] }
 */
function seedHome(name, accounts, opts = {}) {
  const HOME = path.join(REPO, `.poc-home-m11-${name}`)
  const WORK = path.join(HOME, 'work')
  rmrf(HOME)
  fs.mkdirSync(WORK, { recursive: true })
  if (!fs.existsSync(STUB)) throw new Error(`가짜 CLI가 없다: ${STUB}\n  cargo build -p ccg-engine --features fakecli --bin ccg-fakecli --release`)
  if (!fs.existsSync(PROBE)) throw new Error(`프로브가 없다: ${PROBE}\n  cargo build -p ccg-auth --features cli --bin ccg-auth-probe`)
  const enginedir = path.join(HOME, 'engines', 'fake', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64')
  fs.mkdirSync(enginedir, { recursive: true })
  fs.copyFileSync(STUB, path.join(enginedir, 'claude.exe'))
  write(path.join(HOME, 'config.json'), { activeVersion: 'fake' })
  // ★R28 T1T2 R2 — 이 홈이 **엔진 카드를 한 장도 안 띄우게** 두 줄을 더 심는다.
  //   ① 자동 업데이트 끔: 부팅 엔진 업데이트(`engine/boot_update.rs`)가 이 격리 홈에
  //      진짜 npm 설치를 시작하면 그 시간과 디스크가 이 하네스의 측정에 얹힌다.
  //   ② 설치 판정 마커: `engine:state`는 `node_modules/<패키지>/package.json`까지 봐서
  //      "진짜 설치본"을 가린다. 실행본만 있으면 active=null이라 EngineGate가 설치
  //      안내(모달)를 띄우고, 그 오버레이가 설정 화면 클릭 위에 앉는다.
  write(path.join(HOME, 'engine-auto-update.json'), { enabled: false })
  const sdkdir = path.join(HOME, 'engines', 'fake', 'node_modules', '@anthropic-ai', 'claude-agent-sdk')
  fs.mkdirSync(sdkdir, { recursive: true })
  write(path.join(sdkdir, 'package.json'), { name: '@anthropic-ai/claude-agent-sdk', version: 'fake' })

  // ① 합성 계정 — `accounts.json`에 **복호 가능한** 스냅샷을 심는다(가짜 토큰).
  const emails = accounts.map((a) => a.email)
  const seedArgs = opts.dup ? ['seed-dup', ...opts.dup, ...emails.filter((e) => !opts.dup.includes(e))] : ['seed', ...emails]
  const r = spawnSync(PROBE, seedArgs, { env: { ...process.env, CCG_HOME: HOME }, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`계정 심기 실패: ${r.stderr || r.stdout}`)
  const seeded = JSON.parse(r.stdout)
  for (const e of emails) fs.mkdirSync(path.join(HOME, 'accounts', slug(e)), { recursive: true })

  // ② 합성 usage — 셸의 워커는 이 캐시를 먼저 보고, TTL 안쪽이면 조회를 안 한다.
  //    (`CCG_NO_NET=1`이라 조회 자체가 불가능하기도 하다.)
  const cache = {}
  for (const a of accounts) {
    if (!a.usage) continue
    cache[a.email] = { at: Date.now(), data: { email: a.email, fablePct: null, fableResetsAt: null, ...a.usage } }
  }
  write(path.join(HOME, 'usage-cache.json'), cache)

  // ③ 설정 토글 — 렌더러의 `setPref('limitSwitch.on')`이 쓰는 바로 그 파일/키.
  write(path.join(HOME, 'ui-prefs.json'), { 'ui.lang': 'ko', 'limitSwitch.on': !!opts.toggle })
  write(path.join(HOME, 'profile.json'), { nickname: 'poc' })

  // ④ 채팅 — 첫 계정으로 실행한다.
  write(path.join(HOME, 'chats', 'index.json'), { version: 1, order: ['c-m11'], activeChatId: 'c-m11' })
  write(path.join(HOME, 'chats', 'c-m11.json'), {
    id: 'c-m11',
    title: 'M11',
    custom: true,
    manualCwd: WORK,
    picker: { model: 'haiku', effort: 'minimal', mode: 'normal', billing: 'subscription', account: emails[0] },
    refDirs: [],
    snapshot: { messages: [] },
    updatedAt: Date.now()
  })

  // ⑤ 계정별 대본 — 가짜 CLI가 `CLAUDE_CONFIG_DIR` 꼬리로 형제 파일을 고른다.
  const SCRIPT = path.join(HOME, 'fake.jsonl')
  writeScript(SCRIPT, okScript(WORK, 'DEFAULT-OK'))
  const resetsAt = Math.floor(Date.now() / 1000) + 5 * 3600
  for (const a of accounts) {
    const per = path.join(HOME, `fake.${slug(a.email)}.jsonl`)
    writeScript(per, a.script === 'limit' ? limitScript(WORK, resetsAt) : okScript(WORK, `OK-${slug(a.email)}`))
  }
  return { HOME, WORK, SCRIPT, seeded, resetsAt, emails }
}

/** 이 채팅에 지금 물린 계정 + 마지막 전환 배너 + 리비전 origin. */
async function snap(app) {
  return await app.j(`await (async () => {
    const d = await window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: 'engine:debug', payload: [] })
    // ★ 봉투는 **객체**다(\`core_dispatch\`의 chat() = arg[0].chatId). 문자열을 주면
    //   chatId가 ''로 읽혀 **빈 이름의 유령 런타임**이 하나 생기고, 그쪽 정체성이
    //   돌아온다(R1 주행에서 실제로 밟았다 — revision:0 · 계정 되돌아감으로 보였다).
    const ident = await window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: 'chat:identity-get', payload: [{ chatId: 'c-m11' }] })
    const thread = ([...document.querySelectorAll('.thread, .msgs, .msg-list, main')].map((n) => n.innerText).sort((a, b) => b.length - a.length)[0] ?? '')
    const sw = (window.__ev ?? []).filter((e) => e.type === 'notice' && e.switch).map((e) => ({ text: e.text, ...e.switch }))
    return {
      account: ident?.identity?.billing?.account ?? ident?.identity?.engine?.account ?? null,
      revision: ident?.revision ?? null,
      origins: (window.__ident ?? []).map((p) => p.origin + '#' + p.revision + '[' + (p.changed ?? []).join(',') + ']'),
      state: d?.chats?.[0]?.state ?? null,
      hold: d?.chats?.[0]?.hold ?? null,
      spawns: d?.chats?.[0]?.spawns ?? null,
      accountSwitch: d?.accountSwitch ?? null,
      banners: sw,
      notices: (window.__ev ?? []).filter((e) => e.type === 'notice').map((e) => e.text),
      domHasSwitch: /계정으로 바꿔 이어갑니다/.test(thread),
      domHasWait: /사용 한도에 걸려 대기합니다/.test(thread),
      thread: thread.slice(-900)
    }
  })()`)
}

/** 이벤트/리비전 수집기를 창에 심는다.
 *
 * `chat:identity`는 `window.api`에 공개 구독 함수가 없다(렌더러 내부에서 `unified.ts`가
 * 직접 `listen`한다). 그래서 Tauri 내부 이벤트 플러그인에 **직접** 붙는다 — 앱 코드를
 * 하네스용으로 늘리지 않으려는 것이고, 이 채널은 제품이 이미 내고 있는 그 채널이다. */
const arm = (app) =>
  app.j(`await (async () => {
    window.__ev = []
    window.__ident = []
    window.api.onEngineEvent((e) => window.__ev.push(e))
    try {
      const I = window.__TAURI_INTERNALS__
      await I.invoke('plugin:event|listen', {
        event: 'chat:identity',
        target: { kind: 'Any' },
        handler: I.transformCallback((e) => window.__ident.push(e.payload))
      })
      window.__identOk = true
    } catch (err) {
      window.__identOk = String(err)
    }
    return 'armed'
  })()`)

// ─────────────────────────────────────────────────────────────────────────────
async function run(name, seed, port, steps) {
  const out = { home: seed.HOME, emails: seed.emails }
  const app = await boot(seed.HOME, port, { CCG_FAKECLI_SCRIPT: seed.SCRIPT })
  try {
    await arm(app)
    out.ready = await waitUntil(app, `(await window.api.getChats())?.activeChatId === 'c-m11' && !!document.querySelector('.composer-row textarea')`, 40_000)
    if (!out.ready) throw new Error('창이 채팅을 못 잡았다')
    await steps(app, out)
  } catch (e) {
    fail(name, String(e && e.message ? e.message : e))
    out.error = String(e)
  } finally {
    out.appLog = app.log().split('\n').filter(Boolean).slice(-20)
    rep.scenarios[name] = out
    try { killTree(app.child.pid) } catch {}
    await sleep(800)
    if (!KEEP) {
      spawnSync('cmd', ['/c', 'rmdir', path.join(seed.HOME, 'engines')], { encoding: 'utf8' })
      try { rmrf(seed.HOME) } catch {}
    }
  }
}

// ① 후보 있음 — **초기화 임박순**으로 고르고, 배너가 뜨고, 되돌릴 수 있다.
async function scPick() {
  console.log('\n[PICK] 후보 있음 — 임박순 선택 + 배너 + 되돌리기')
  const now = Math.floor(Date.now() / 1000)
  const seed = seedHome(
    'pick',
    [
      { email: 'a@ccg.test', script: 'limit', usage: { fiveHourPct: 100, fiveHourResetsAt: now + 5 * 3600, weeklyPct: 40, weeklyResetsAt: now + 4 * 86400 } },
      // soon = 30분 뒤 리셋(= 곧 버려질 잔량) → **이쪽이 먼저**여야 한다
      { email: 'soon@ccg.test', script: 'ok', usage: { fiveHourPct: 55, fiveHourResetsAt: now + 1800, weeklyPct: 10, weeklyResetsAt: now + 6 * 86400 } },
      // late = 4시간 뒤 리셋 + 여유는 더 많다. 여유가 이기면 이쪽이 뽑힌다(= 규칙 위반)
      { email: 'late@ccg.test', script: 'ok', usage: { fiveHourPct: 5, fiveHourResetsAt: now + 4 * 3600, weeklyPct: 5, weeklyResetsAt: now + 6 * 86400 } }
    ],
    { toggle: true }
  )
  await run('pick', seed, 9481, async (app, out) => {
    await typeAndSend(app, '한도에 걸릴 질문')
    out.switched = await waitUntil(app, `(window.__ev ?? []).some((e) => e.type === 'notice' && e.switch)`, 60_000)
    await sleep(1200)
    const s = await snap(app)
    out.after = s
    if (!out.switched) return fail('PICK-전환', '배너가 안 왔다 — 전환이 안 일어났다', s)
    if (s.account !== 'soon@ccg.test') fail('PICK-임박순', `초기화 임박 계정이 아니라 ${s.account}로 갔다(여유가 이겼다)`, { banners: s.banners, plan: s.accountSwitch })
    else ok('PICK-임박순', { to: s.account, skipped: s.accountSwitch?.skipped })
    if (s.banners.length !== 1) fail('PICK-배너', `전환 1회에 배너가 ${s.banners.length}개`, s.banners)
    else if (!s.domHasSwitch) fail('PICK-배너(화면)', '이벤트는 왔는데 스레드에 줄이 없다', { thread: s.thread })
    else ok('PICK-배너', s.banners[0])
    if (s.hold) fail('PICK-대기표', '갈아탔는데 대기표가 남았다', s.hold)
    else ok('PICK-대기표 없음')
    const origin = (s.origins ?? []).find((o) => o.startsWith('auto_account_switch'))
    if (!origin) fail('PICK-리비전', 'origin=auto_account_switch 리비전이 안 왔다', s.origins)
    else if (!origin.includes('[billingAccount]')) fail('PICK-리비전', `계정 리프 하나만 바뀌어야 한다(billingAccount): ${origin}`)
    else ok('PICK-리비전', origin)
    if (s.spawns !== 2) fail('PICK-재스폰', `새 계정으로 다시 떠야 한다(spawns=${s.spawns})`)
    else ok('PICK-재스폰', s.spawns)

    // ── 되돌리기 — **화면의 알약을 실제로 누른다** ────────────────────────
    //
    // R1은 여기서 `chat:identity-revert`를 손으로 invoke 했다(와이어는 옳다는 증명).
    // 그런데 그 사이 화면에는 알약이 없어서 "사용자가 되돌릴 수 있다"는 주장은
    // 하네스 안에서만 참이었다(m11 §6-1). 잔여 청소 라운드가 알약을 붙였으니
    // **DOM에서 찾아 클릭**한다 — 이게 사용자 경로다. 배너의 `revertTo`는 여전히
    // 그 알약이 가리키는 지점과 같아야 하므로 함께 단언한다.
    const revertTo = s.banners[0]?.revertTo
    out.revertTo = revertTo
    if (typeof revertTo !== 'number') return fail('PICK-되돌리기', '배너에 revertTo가 없다', s.banners)

    const pill = await app.j(`(() => {
      const bands = [...document.querySelectorAll('.thread .ntf-band')]
      const band = bands.find((b) => /계정으로 바꿔 이어갑니다/.test(b.innerText))
      if (!band) return { found: false, why: 'switch band 없음', bands: bands.length }
      const btns = [...band.querySelectorAll('button.ntf-act')]
      return { found: btns.length > 0, labels: btns.map((b) => b.innerText.trim()), disabled: btns.map((b) => b.disabled) }
    })()`)
    out.pill = pill
    if (!pill.found) fail('PICK-알약', '전환 배너에 되돌리기 알약이 없다', pill)
    else ok('PICK-알약', pill.labels)

    out.pillClick = await app.j(`(() => {
      const band = [...document.querySelectorAll('.thread .ntf-band')].find((b) => /계정으로 바꿔 이어갑니다/.test(b.innerText))
      const btn = band && [...band.querySelectorAll('button.ntf-act')].find((b) => !b.disabled)
      if (!btn) return 'no-pill'
      btn.click()
      return 'clicked'
    })()`)
    if (out.pillClick !== 'clicked') fail('PICK-알약클릭', '알약을 못 눌렀다', out.pillClick)
    await sleep(1200)
    const back = await snap(app)
    out.afterRevert = back
    if (back.account !== 'a@ccg.test') fail('PICK-되돌리기', `알약을 눌렀는데 계정이 ${back.account}다`, { revertTo, click: out.pillClick })
    else if (back.revision <= s.revision) fail('PICK-되돌리기', '되돌리기는 **새 리비전**이어야 한다(히스토리 삭제 아님)', { before: s.revision, after: back.revision })
    else ok('PICK-되돌리기(알약)', { to: back.account, revision: `${s.revision}→${back.revision}` })

    // 되먹임 — 되돌린 뒤 알약은 `[되돌림 ✓]`로 **정착**해야 한다(비활성). 안 그러면
    // 두 번째 클릭이 `no_revision`을 받고, 사용자는 눌린 건지조차 모른다(M-UI F3).
    out.settled = await app.j(`(() => {
      const band = [...document.querySelectorAll('.thread .ntf-band')].find((b) => /계정으로 바꿔 이어갑니다/.test(b.innerText))
      if (!band) return { band: false }
      const btns = [...band.querySelectorAll('button.ntf-act')]
      return { band: true, labels: btns.map((b) => b.innerText.trim()), disabled: btns.map((b) => b.disabled) }
    })()`)
    if (!out.settled.band) fail('PICK-정착', '되돌린 뒤 배너가 사라졌다 — 되돌리기는 기록 삭제가 아니다', out.settled)
    else if (!out.settled.labels.some((l) => /되돌림/.test(l))) fail('PICK-정착', '알약이 [되돌림 ✓]로 정착하지 않았다', out.settled)
    else if (!out.settled.disabled.every(Boolean)) fail('PICK-정착', '정착한 알약이 아직 눌린다', out.settled)
    else ok('PICK-정착', out.settled.labels)
  })
}

// ② 후보 없음 — 계정이 하나뿐. 옛 경로(대기표) 그대로여야 한다.
async function scNone() {
  console.log('\n[NONE] 후보 없음 — 기존 대기표 경로')
  const now = Math.floor(Date.now() / 1000)
  const seed = seedHome('none', [{ email: 'a@ccg.test', script: 'limit', usage: { fiveHourPct: 100, fiveHourResetsAt: now + 5 * 3600, weeklyPct: 40, weeklyResetsAt: now + 4 * 86400 } }], { toggle: true })
  await run('none', seed, 9482, async (app, out) => {
    await typeAndSend(app, '한도에 걸릴 질문')
    out.waited = await waitUntil(app, `(window.__ev ?? []).some((e) => e.type === 'notice' && /사용 한도에 걸려 대기합니다/.test(e.text))`, 60_000)
    await sleep(1000)
    const s = await snap(app)
    out.after = s
    if (!out.waited) return fail('NONE-대기', '한도 대기 문장이 안 나왔다', s)
    if (s.banners.length) fail('NONE-전환', '후보가 없는데 전환 배너가 떴다', s.banners)
    else if (s.account !== 'a@ccg.test') fail('NONE-전환', `계정이 ${s.account}로 바뀌었다`)
    else if (!s.hold) fail('NONE-대기표', '대기표가 서야 한다', s)
    else if (s.spawns !== 1) fail('NONE-재스폰', `전환이 없으면 재스폰도 없다(spawns=${s.spawns})`)
    else ok('NONE', { account: s.account, hold: s.hold, skipped: s.accountSwitch?.skipped })
  })
}

// ③ 설정 꺼짐 — ①과 **같은 홈 재료**인데 토글만 끈다. ②와 구별되면 안 된다.
async function scOff() {
  console.log('\n[OFF] 설정 꺼짐 — 기능이 없던 판과 같아야 한다')
  const now = Math.floor(Date.now() / 1000)
  const seed = seedHome(
    'off',
    [
      { email: 'a@ccg.test', script: 'limit', usage: { fiveHourPct: 100, fiveHourResetsAt: now + 5 * 3600, weeklyPct: 40, weeklyResetsAt: now + 4 * 86400 } },
      { email: 'soon@ccg.test', script: 'ok', usage: { fiveHourPct: 55, fiveHourResetsAt: now + 1800, weeklyPct: 10, weeklyResetsAt: now + 6 * 86400 } }
    ],
    { toggle: false }
  )
  await run('off', seed, 9483, async (app, out) => {
    await typeAndSend(app, '한도에 걸릴 질문')
    out.waited = await waitUntil(app, `(window.__ev ?? []).some((e) => e.type === 'notice' && /사용 한도에 걸려 대기합니다/.test(e.text))`, 60_000)
    await sleep(1500)
    const s = await snap(app)
    out.after = s
    if (s.accountSwitch?.on !== false) fail('OFF-토글', '셸이 토글을 켜진 것으로 읽었다', s.accountSwitch)
    if (s.banners.length) fail('OFF-무동작', '꺼져 있는데 전환됐다', s.banners)
    else if (s.account !== 'a@ccg.test') fail('OFF-무동작', `계정이 ${s.account}로 바뀌었다`)
    else if (!s.hold) fail('OFF-대기표', '꺼져 있으면 대기표 경로 그대로여야 한다', s)
    else if (s.spawns !== 1) fail('OFF-재스폰', `spawns=${s.spawns}`)
    else ok('OFF', { on: s.accountSwitch?.on, account: s.account, spawns: s.spawns })
  })
}

// ④ 오염 스킵 — 임박순 1등이 오염 계정이다. 건너뛰고 2등으로 가야 한다.
async function scDirty() {
  console.log('\n[DIRTY] 오염 스킵 — 임박 1등이 오염이면 건너뛴다')
  const now = Math.floor(Date.now() / 1000)
  const seed = seedHome(
    'dirty',
    [
      { email: 'a@ccg.test', script: 'limit', usage: { fiveHourPct: 100, fiveHourResetsAt: now + 5 * 3600, weeklyPct: 40, weeklyResetsAt: now + 4 * 86400 } },
      // dirty는 10분 뒤 리셋 = 임박순 1등인데, 토큰 주인이 a라 적용하면 계정이 되돌아간다
      { email: 'dirty@ccg.test', script: 'ok', usage: { fiveHourPct: 30, fiveHourResetsAt: now + 600, weeklyPct: 10, weeklyResetsAt: now + 6 * 86400 } },
      { email: 'clean@ccg.test', script: 'ok', usage: { fiveHourPct: 30, fiveHourResetsAt: now + 2 * 3600, weeklyPct: 10, weeklyResetsAt: now + 6 * 86400 } }
    ],
    { toggle: true, dup: ['dirty@ccg.test', 'a@ccg.test'] }
  )
  await run('dirty', seed, 9484, async (app, out) => {
    out.seeded = seed.seeded
    await typeAndSend(app, '한도에 걸릴 질문')
    out.switched = await waitUntil(app, `(window.__ev ?? []).some((e) => e.type === 'notice' && e.switch)`, 60_000)
    await sleep(1200)
    const s = await snap(app)
    out.after = s
    if (!out.switched) return fail('DIRTY-전환', '배너가 안 왔다', s)
    if (s.account !== 'clean@ccg.test') fail('DIRTY-스킵', `오염 계정을 건너뛰지 못했다 — ${s.account}로 갔다`, s.accountSwitch)
    else ok('DIRTY-스킵', { to: s.account })
    const why = (s.accountSwitch?.skipped ?? []).find((x) => x.email === 'dirty@ccg.test')?.why
    if (why !== 'contaminated') fail('DIRTY-사유', `탈락 사유가 contaminated가 아니다: ${why}`, s.accountSwitch)
    else ok('DIRTY-사유', why)
  })
}

// ⑤ 연속 소진 A→B→C — 갈아탄 계정도 막히면 그다음으로. A로는 안 돌아간다.
async function scChain() {
  console.log('\n[CHAIN] 연속 소진 A→B→C')
  const now = Math.floor(Date.now() / 1000)
  const seed = seedHome(
    'chain',
    [
      { email: 'a@ccg.test', script: 'limit', usage: { fiveHourPct: 100, fiveHourResetsAt: now + 5 * 3600, weeklyPct: 40, weeklyResetsAt: now + 4 * 86400 } },
      { email: 'b@ccg.test', script: 'limit', usage: { fiveHourPct: 40, fiveHourResetsAt: now + 1800, weeklyPct: 10, weeklyResetsAt: now + 6 * 86400 } },
      { email: 'c@ccg.test', script: 'ok', usage: { fiveHourPct: 20, fiveHourResetsAt: now + 3 * 3600, weeklyPct: 10, weeklyResetsAt: now + 6 * 86400 } }
    ],
    { toggle: true }
  )
  await run('chain', seed, 9485, async (app, out) => {
    await typeAndSend(app, '한도에 걸릴 질문')
    out.two = await waitUntil(app, `(window.__ev ?? []).filter((e) => e.type === 'notice' && e.switch).length >= 2`, 90_000)
    await sleep(1500)
    const s = await snap(app)
    out.after = s
    const hops = s.banners.map((b) => `${b.from}→${b.to}`)
    if (hops.join(' ') !== 'a@ccg.test→b@ccg.test b@ccg.test→c@ccg.test') fail('CHAIN-경로', `A→B→C가 아니다: ${hops.join(' ')}`, s.banners)
    else ok('CHAIN-경로', hops)
    if (s.account !== 'c@ccg.test') fail('CHAIN-착지', `마지막 계정이 ${s.account}다`)
    else if (s.hold) fail('CHAIN-착지', 'C에서 답이 왔는데 대기표가 남았다', s.hold)
    else ok('CHAIN-착지', { account: s.account, spawns: s.spawns })
    if (s.banners.some((b) => b.to === 'a@ccg.test')) fail('CHAIN-핑퐁', '소진된 A로 되돌아갔다', s.banners)
    else ok('CHAIN-핑퐁 없음')
  })
}

// ⑥ 설정 토글 — **화면에서 켜면 셸이 읽는가**. 값의 전달 경로가 파일 하나라
//    (`ui-prefs.json`) 그 경로를 실물로 밟는다: 클릭 → 디스크 → 엔진 진단.
async function scToggle() {
  console.log('\n[TOGGLE] 설정 Account 탭의 스위치 — 클릭 → ui-prefs → 셸')
  const now = Math.floor(Date.now() / 1000)
  const seed = seedHome(
    'toggle',
    [
      { email: 'a@ccg.test', script: 'ok', usage: { fiveHourPct: 10, fiveHourResetsAt: now + 3600, weeklyPct: 10, weeklyResetsAt: now + 6 * 86400 } },
      { email: 'b@ccg.test', script: 'ok', usage: { fiveHourPct: 10, fiveHourResetsAt: now + 3600, weeklyPct: 10, weeklyResetsAt: now + 6 * 86400 } }
    ],
    { toggle: false }
  )
  await run('toggle', seed, 9486, async (app, out) => {
    out.before = (await dbg(app))?.accountSwitch?.on
    // 설정 열기 → Account 탭
    out.opened = await app.j(`(() => {
      const b = document.querySelector('.sb-foot') || [...document.querySelectorAll('button')].find((n) => /설정/.test(n.getAttribute('aria-label') ?? ''))
      if (!b) return 'no-button'
      b.click()
      return 'clicked'
    })()`)
    await waitUntil(app, `!!document.querySelector('.set-nav, .set-h1')`, 15_000)
    await app.j(`(() => {
      const tab = [...document.querySelectorAll('button, .set-nav *')].find((n) => (n.textContent || '').trim() === 'Account')
      if (tab) tab.click()
      return !!tab
    })()`)
    await waitUntil(app, `/한도 소진 시 계정 자동 전환/.test(document.body.innerText)`, 15_000)
    out.row = await app.j(`(() => {
      const em = [...document.querySelectorAll('.sc2.tgl .em')].find((n) => /한도 소진 시 계정 자동 전환/.test(n.textContent))
      if (!em) return null
      const card = em.closest('.sc2.tgl')
      const sw = card.querySelector('button[role="switch"]')
      return { label: em.textContent, desc: card.querySelector('.meta')?.textContent?.slice(0, 80) ?? '', checked: sw?.getAttribute('aria-checked') ?? null, hasSwitch: !!sw }
    })()`)
    if (!out.row?.hasSwitch) return fail('TOGGLE-행', '설정에 토글 행이 없다', out.row)
    if (out.row.checked !== 'false') fail('TOGGLE-기본값', `기본이 꺼짐이 아니다: ${out.row.checked}`, out.row)
    else ok('TOGGLE-기본 꺼짐', { label: out.row.label })
    // 클릭 → 디바운스(250ms) 저장 → 셸의 TTL(3s) 뒤 반영
    await app.j(`(() => {
      const em = [...document.querySelectorAll('.sc2.tgl .em')].find((n) => /한도 소진 시 계정 자동 전환/.test(n.textContent))
      em.closest('.sc2.tgl').querySelector('button[role="switch"]').click()
      return 'toggled'
    })()`)
    await sleep(1200)
    out.onDisk = JSON.parse(fs.readFileSync(path.join(seed.HOME, 'ui-prefs.json'), 'utf8'))['limitSwitch.on'] ?? null
    if (out.onDisk !== true) fail('TOGGLE-디스크', `ui-prefs.json에 안 실렸다: ${out.onDisk}`)
    else ok('TOGGLE-디스크', { 'limitSwitch.on': out.onDisk })
    // 셸이 읽는가 — 토글 캐시 TTL(3초)이 지나야 한다.
    out.shellSaw = await waitUntil(app, `(await window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: 'engine:debug', payload: [] }))?.accountSwitch?.on === true`, 12_000)
    out.after = (await dbg(app))?.accountSwitch
    if (!out.shellSaw) fail('TOGGLE-셸', '화면에서 켰는데 엔진이 못 읽었다', { before: out.before, after: out.after })
    else ok('TOGGLE-셸', { before: out.before, after: out.after?.on })
  })
}

// ─────────────────────────────────────────────────────────────────────────────
const plan = { pick: scPick, none: scNone, off: scOff, dirty: scDirty, chain: scChain, toggle: scToggle }
const chosen = only === 'all' ? Object.keys(plan) : only.split(',').filter((k) => plan[k])
if (!chosen.length) {
  console.error(`알 수 없는 --only=${only} (${Object.keys(plan).join('|')})`)
  process.exit(2)
}
if (!fs.existsSync(EXE)) {
  console.error(`앱 exe가 없다: ${EXE}\n  npm run tauri:build  (또는 --exe=<경로>)`)
  process.exit(2)
}
for (const k of chosen) await plan[k]()

write(OUT, JSON.stringify(rep, null, 2))
console.log(`\n리포트: ${OUT}`)
if (rep.findings.length) {
  console.error(`\nFAIL — ${rep.findings.length}건`)
  for (const f of rep.findings) console.error(`  · ${f.id}: ${f.why}`)
  process.exit(1)
}
console.log(`\nPASS — 시나리오 ${chosen.length}개`)
