#!/usr/bin/env node
/* ============================================================================
 * poc-slug-account-dir — ★SLUG R1 **계정 격리 폴더는 추측이 아니라 주입**임을 실증.
 *
 * 단위 테스트는 두 자리를 잡는다:
 *   · `ccg-engine::runtime::slug_r1_account_dir_tests` — 리졸버가 낸 경로가 그대로
 *     `CLAUDE_CONFIG_DIR`로 나가고, 실패는 사유로 정착한다.
 *   · `agentcodegui::engine::claude_account::tests` — (a)~(d) 네 갈래를 `ccg-auth`의
 *     **진짜** 슬러그로 재현한다.
 *
 * **여기서만 잡히는 것**은 그 둘 사이의 배선이다 — `hub.rs`가 리졸버를 실제로 꽂았는가.
 * 두 테스트 다 초록인데 `with_account_resolver` 한 줄이 없으면, 앱은 여전히
 * `accounts/_no-resolver`로 CLI를 태운다(= 미로그인). 그 줄의 유무는 **실행 중인 앱이
 * CLI에 넘긴 env**로만 보인다.
 *
 * 관측 방법: 가짜 CLI(`ccg-fakecli`)는 `CLAUDE_CONFIG_DIR`의 **마지막 폴더 이름**으로
 * 형제 대본(`fake.<그이름>.jsonl`)을 고른다. 그래서 화면에 찍히는 답 한 줄이 곧
 * "엔진이 어느 폴더를 집었나"의 증언이다.
 *
 *   fake.<실물슬러그>.jsonl  → "OK-REAL"        ← 이것이 나와야 한다
 *   fake.<옛추측이름>.jsonl  → "WRONG-GUESS"    ← 오염 폴더를 집으면 이것
 *   fake.jsonl               → "NO-ACCOUNT-DIR" ← 리졸버 미배선(_no-resolver)이면 이것
 *
 * ── 시나리오 ────────────────────────────────────────────────────────────────
 *  A(resolve) — (a) 오염 폴더를 미리 깔아 둔 홈에서, 앱이 **실물 폴더**를 집고
 *               자격증명까지 물질화하는가.
 *  B(fail)    — 등록은 돼 있는데 자격증명을 못 푸는 계정에서, 없는 경로로 CLI를
 *               태우지 않고 **사유가 보이는 오류**가 렌더러까지 닿는가.
 *
 * ── 안전 규칙 (사용자 실앱이 떠 있다) ───────────────────────────────────────
 *  · 실홈(%USERPROFILE%\.agentcodegui)은 **읽지도 않는다** — 계정이 합성이라 복사할
 *    것이 없다. 이메일은 전부 `@example.invalid`(RFC 6761 예약 TLD)다.
 *  · 이름 기반 kill 금지 — 죽이는 것은 이 스크립트가 spawn한 PID 트리뿐이다.
 *  · 앱 홈은 전부 `CCG_HOME`으로 격리한다(레포 안 `.poc-home-slug-*`).
 *  · `CCG_NO_NET=1` — 네트워크를 한 번도 안 탄다.
 *
 * 준비:
 *   cargo build -p ccg-engine --features fakecli --bin ccg-fakecli --release
 *   cargo build -p ccg-auth  --features cli      --bin ccg-auth-probe
 *   npm run tauri:build            (또는 --exe=<경로>)
 *
 * 실행:
 *   node scripts/poc-slug-account-dir.mjs
 *   node scripts/poc-slug-account-dir.mjs --only=resolve
 *   node scripts/poc-slug-account-dir.mjs --only=fail
 *   node scripts/poc-slug-account-dir.mjs --keep          # 격리 홈 보존
 *   node scripts/poc-slug-account-dir.mjs --out=-sweep    # 산출물 접미사
 * ========================================================================== */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { connectMainPage, killTree, sleep, REPO, resolveTauriExe } from '../bench/lib.mjs'

const args = process.argv.slice(2)
const only = (args.find((a) => a.startsWith('--only=')) ?? '').split('=')[1] || 'all'
const KEEP = args.includes('--keep')
const EXE = resolveTauriExe((args.find((a) => a.startsWith('--exe=')) ?? '').split('=')[1])
/**
 * 가짜 CLI. `--stub=`·`CARGO_TARGET_DIR`·`target/` 순으로 찾고 **가장 최신**을 쓴다.
 *
 * ★ 이 라운드에서 실제로 밟은 함정 — 레포의 `target/release/ccg-fakecli.exe`가 소스보다
 * 오래됐고(그 빌드는 `CCG_FAKECLI_ARGV`를 모른다), 그래서 "argv.json이 없다 = CLI가 안
 * 떴다"는 판정이 **언제나 참**이 됐다. 「안 떴다」를 증명하려던 단언이 스텁이 낡았다는
 * 이유로 공짜로 통과한 것이다. 그래서 아래 `argvSupported`로 **능력을 먼저 확인**한다.
 */
const STUB = (() => {
  const explicit = (args.find((a) => a.startsWith('--stub=')) ?? '').split('=')[1]
  if (explicit) return path.resolve(explicit)
  const cands = [process.env.CARGO_TARGET_DIR, path.join(REPO, 'target-slug'), path.join(REPO, 'target')]
    .filter(Boolean)
    .map((r) => path.join(path.resolve(r), 'release', 'ccg-fakecli.exe'))
    .filter((p) => fs.existsSync(p))
    .map((p) => ({ p, m: fs.statSync(p).mtimeMs }))
    .sort((a, b) => b.m - a.m)
  return cands[0]?.p ?? path.join(REPO, 'target', 'release', 'ccg-fakecli.exe')
})()
const PROBE = path.join(REPO, 'target', 'debug', 'ccg-auth-probe.exe')
/** 이 스텁이 `CCG_FAKECLI_ARGV`를 아는가(낡은 빌드면 argv 판정이 공짜로 통과한다). */
const argvSupported = fs.existsSync(STUB) && fs.readFileSync(STUB).includes('CCG_FAKECLI_ARGV')
/** CLI가 실제로 떴다는 **스텁 나이와 무관한** 증거 — 프롬프트가 stdin으로 들어갔는가. */
const stdinBytes = (p) => {
  try { return fs.statSync(p).size } catch { return 0 }
}
const OUT_SUFFIX = (args.find((a) => a.startsWith('--out=')) ?? '').split('=')[1] || ''
const OUT = path.join(REPO, 'docs', 'critic', `slug-r1-account-dir${OUT_SUFFIX}.json`)
// 과제 지정 대역 11160~11179.
const PORTS = { resolve: 11161, fail: 11162 }

const rep = { at: new Date().toISOString(), exe: EXE, scenarios: {}, findings: [] }
const fail = (id, why, extra) => {
  rep.findings.push({ id, why, ...(extra ?? {}) })
  console.error(`  x ${id} — ${why}`)
}
const ok = (id, v) => console.log(`  o ${id}${v === undefined ? '' : ' — ' + JSON.stringify(v)}`)
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
 * 이메일 → 계정 폴더 이름. `ccg_auth::account_slug`(crates/ccg-auth/src/lib.rs:125)의
 * **원본 JS 레시피 그대로**다. 함정 둘: ① 치환은 연속 구간을 `_` **하나로** 접는다,
 * ② 해시는 소문자화 **전** 원본의 UTF-16 코드 유닛을 돈다.
 *
 * 이 값은 아래에서 `ccg-auth-probe diagnose`가 내는 `slug`와 **대조된다** —
 * 사본이 어긋나면 하네스가 조용히 헛것을 재는 자리라, 대조를 실패 조건으로 둔다.
 */
const slug = (email) => {
  const safe = email.toLowerCase().replace(/[^a-z0-9._-]+/g, '_')
  let h = 0
  for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) >>> 0
  return `${safe}-${h.toString(36)}`
}
/** 옛 엔진(`Runtime::account_dir`)이 조립하던 이름 — 치환 두 개가 전부였다. */
const oldGuess = (email) => email.replace(/@/g, '_').replace(/\+/g, '-')

// ── 앱 부팅 + CDP ────────────────────────────────────────────────────────────
async function boot(home, port, env = {}) {
  const child = spawn(EXE, [], {
    env: {
      ...process.env,
      CCG_HOME: home,
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
  for (let i = 0; i < 300; i++) {
    const up = await page
      .eval(`(async () => { try { return !!(await window.api.app.getVersion()) } catch { return false } })()`, { awaitPromise: true })
      .catch(() => false)
    if (up) break
    await sleep(100)
  }
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
const arm = (app) =>
  app.j(`await (async () => { window.__ev = []; window.api.onEngineEvent((e) => window.__ev.push(e)); return 'armed' })()`)

/** 화면이 말하는 것 전부 — 스레드 본문 · notice 목록 · 엔진 상태. */
async function snap(app) {
  return await app.j(`await (async () => {
    const d = await window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: 'engine:debug', payload: [] })
    const thread = ([...document.querySelectorAll('.thread, .msgs, .msg-list, main')].map((n) => n.innerText).sort((a, b) => b.length - a.length)[0] ?? '')
    return {
      state: d?.chats?.[0]?.state ?? null,
      spawns: d?.chats?.[0]?.spawns ?? null,
      notices: (window.__ev ?? []).filter((e) => e.type === 'notice').map((e) => e.text),
      thread: thread.slice(-1200)
    }
  })()`)
}

// ── 대본 ─────────────────────────────────────────────────────────────────────
const ack = { type: 'control_response', response: { subtype: 'success', request_id: 'init-1', response: {} } }
const init = (sid, cwd) => ({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-haiku-4-5', cwd, tools: [], apiKeySource: 'none' })
const okScript = (cwd, text) => [
  { afterMs: 80, emit: ack },
  { emit: init('OK-1', cwd) },
  { afterMs: 60, emit: { type: 'assistant', session_id: 'OK-1', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text }], usage: { input_tokens: 7 } } } },
  { emit: { type: 'result', subtype: 'success', is_error: false, result: text, session_id: 'OK-1', total_cost_usd: 0, duration_ms: 1, num_turns: 1 } }
]
const writeScript = (p, steps) => write(p, steps.map((s) => JSON.stringify(s)).join('\n') + '\n')

/**
 * 격리 홈 하나.
 * @param name   홈 이름
 * @param email  합성 계정(@example.invalid)
 * @param opts   { poison: bool — (a) 오염 폴더를 미리 깔까, corrupt: bool — credEnc를 깨뜨릴까 }
 */
function seedHome(name, email, opts = {}) {
  const HOME = path.join(REPO, `.poc-home-slug-${name}`)
  const WORK = path.join(HOME, 'work')
  rmrf(HOME)
  fs.mkdirSync(WORK, { recursive: true })
  if (!fs.existsSync(STUB)) throw new Error(`가짜 CLI가 없다: ${STUB}\n  cargo build -p ccg-engine --features fakecli --bin ccg-fakecli --release`)
  if (!fs.existsSync(PROBE)) throw new Error(`프로브가 없다: ${PROBE}\n  cargo build -p ccg-auth --features cli --bin ccg-auth-probe`)

  const enginedir = path.join(HOME, 'engines', 'fake', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64')
  fs.mkdirSync(enginedir, { recursive: true })
  fs.copyFileSync(STUB, path.join(enginedir, 'claude.exe'))
  write(path.join(HOME, 'config.json'), { activeVersion: 'fake' })
  // 이 홈이 엔진 카드를 한 장도 안 띄우게(부팅 자동 업데이트 끔 + 설치 마커).
  write(path.join(HOME, 'engine-auto-update.json'), { enabled: false })
  const sdkdir = path.join(HOME, 'engines', 'fake', 'node_modules', '@anthropic-ai', 'claude-agent-sdk')
  fs.mkdirSync(sdkdir, { recursive: true })
  write(path.join(sdkdir, 'package.json'), { name: '@anthropic-ai/claude-agent-sdk', version: 'fake' })

  // ① 합성 계정 — `accounts.json`에 **복호 가능한** 스냅샷을 심는다(가짜 토큰).
  const r = spawnSync(PROBE, ['seed', email], { env: { ...process.env, CCG_HOME: HOME }, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`계정 심기 실패: ${r.stderr || r.stdout}`)

  // ★ 하네스 자기 검증 — 폴더 이름의 **진짜 출처**(ccg-auth)와 이 파일의 사본을 대조한다.
  const diag = spawnSync(PROBE, ['diagnose'], { env: { ...process.env, CCG_HOME: HOME }, encoding: 'utf8' })
  if (diag.status !== 0) throw new Error(`diagnose 실패: ${diag.stderr || diag.stdout}`)
  // `diagnose`는 이메일을 **평문으로 내지 않는다**(지문뿐) — 그래서 홈마다 계정을 하나만
  // 심고 `claude.rows[].slug` 목록에 우리 값이 있는지로 대조한다.
  const truth = (JSON.parse(diag.stdout).claude?.rows ?? []).map((r) => r.slug)
  if (!truth.includes(slug(email))) {
    throw new Error(`슬러그 사본이 어긋났다: 하네스=${slug(email)} ccg-auth=${JSON.stringify(truth)}`)
  }

  const REAL = slug(email)
  const GUESS = oldGuess(email)

  // ② (a) 자가영속 오염 — 옛 주행이 남겼을 빈 폴더를 실물 **옆에** 미리 깔아 둔다.
  if (opts.poison) fs.mkdirSync(path.join(HOME, 'accounts', GUESS), { recursive: true })

  // ③ 자격증명을 못 푸는 계정 — 등록 목록에는 그대로 남는다(`known_accounts`는
  //    accounts.json의 email 필드만 본다). 리졸버만 Err(Undecryptable)로 떨어진다.
  if (opts.corrupt) {
    const p = path.join(HOME, 'accounts.json')
    const f = JSON.parse(fs.readFileSync(p, 'utf8'))
    for (const a of f.accounts) if (a.email === email) a.credEnc = 'v10:not-a-real-blob'
    write(p, f)
  }

  write(path.join(HOME, 'ui-prefs.json'), { 'ui.lang': 'ko' })
  write(path.join(HOME, 'profile.json'), { nickname: 'poc' })
  write(path.join(HOME, 'chats', 'index.json'), { version: 1, order: ['c-slug'], activeChatId: 'c-slug' })
  write(path.join(HOME, 'chats', 'c-slug.json'), {
    id: 'c-slug',
    title: 'SLUG',
    custom: true,
    manualCwd: WORK,
    picker: { model: 'haiku', effort: 'minimal', mode: 'normal', billing: 'subscription', account: email },
    refDirs: [],
    snapshot: { messages: [] },
    updatedAt: Date.now()
  })

  // ④ 대본 셋 — 어느 폴더를 집었는지가 **답 한 줄**로 갈린다.
  const SCRIPT = path.join(HOME, 'fake.jsonl')
  writeScript(SCRIPT, okScript(WORK, 'NO-ACCOUNT-DIR'))
  writeScript(path.join(HOME, `fake.${REAL}.jsonl`), okScript(WORK, 'OK-REAL'))
  writeScript(path.join(HOME, `fake.${GUESS}.jsonl`), okScript(WORK, 'WRONG-GUESS'))

  return { HOME, WORK, SCRIPT, email, REAL, GUESS, IN: path.join(HOME, 'stdin.log'), ARGV: path.join(HOME, 'argv.json') }
}

// ─────────────────────────────────────────────────────────────────────────────
async function run(name, seed, port, steps) {
  const out = { home: seed.HOME, email: seed.email, realSlug: seed.REAL, oldGuess: seed.GUESS }
  const app = await boot(seed.HOME, port, {
    CCG_FAKECLI_SCRIPT: seed.SCRIPT,
    CCG_FAKECLI_IN: seed.IN,
    CCG_FAKECLI_ARGV: seed.ARGV
  })
  try {
    await arm(app)
    out.ready = await waitUntil(app, `(await window.api.getChats())?.activeChatId === 'c-slug' && !!document.querySelector('.composer-row textarea')`, 40_000)
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

// ── A. 리졸버가 실물 폴더를 집는다 ───────────────────────────────────────────
async function scResolve() {
  console.log('\n[A] resolve — (a) 오염 폴더가 깔린 홈에서 실물 계정 폴더를 집는가')
  const seed = seedHome('resolve', 'slug-a@example.invalid', { poison: true })
  await run('resolve', seed, PORTS.resolve, async (app, out) => {
    await typeAndSend(app, '어느 폴더로 떴니')
    out.answered = await waitUntil(app, `/OK-REAL|WRONG-GUESS|NO-ACCOUNT-DIR/.test(document.body.innerText)`, 60_000)
    await sleep(1000)
    const s = await snap(app)
    Object.assign(out, s)

    // ① 화면의 답 한 줄 = 엔진이 집은 폴더의 증언.
    const picked = /OK-REAL/.test(s.thread) ? 'real' : /WRONG-GUESS/.test(s.thread) ? 'poison' : /NO-ACCOUNT-DIR/.test(s.thread) ? 'no-resolver' : 'none'
    out.picked = picked
    if (picked === 'real') ok('A1 실물 폴더로 스폰', picked)
    else fail('A1', `CLAUDE_CONFIG_DIR이 실물 폴더가 아니다 (${picked})`, { thread: s.thread.slice(-300) })

    // ② 물질화 — 리졸버는 자격증명을 폴더에 써 넣는다(옛 경로는 이 함수를 안 불렀다).
    const credReal = path.join(seed.HOME, 'accounts', seed.REAL, '.credentials.json')
    const credPoison = path.join(seed.HOME, 'accounts', seed.GUESS, '.credentials.json')
    out.materialized = fs.existsSync(credReal)
    out.poisonMaterialized = fs.existsSync(credPoison)
    if (out.materialized) ok('A2 자격증명 물질화', path.basename(path.dirname(credReal)))
    else fail('A2', `실물 폴더에 자격증명이 없다: ${credReal}`)
    if (!out.poisonMaterialized) ok('A3 오염 폴더는 비어 있다')
    else fail('A3', '오염 폴더에 자격증명이 들어갔다 — 여전히 그쪽을 집는다')

    // ③ CLI가 실제로 떴다 — 프롬프트가 stdin으로 들어갔다.
    out.stdinBytes = stdinBytes(seed.IN)
    out.argvSupported = argvSupported
    out.argv = argvSupported && fs.existsSync(seed.ARGV) ? JSON.parse(fs.readFileSync(seed.ARGV, 'utf8')).slice(0, 4) : null
    if (out.stdinBytes > 0) ok('A4 CLI 스폰됨(stdin 바이트)', out.stdinBytes)
    else fail('A4', 'CLI가 뜨지 않았다 — stdin에 아무것도 안 들어갔다')
    if (argvSupported && !out.argv) fail('A4b', 'argv를 남기는 스텁인데 argv.json이 없다')
  })
}

// ── B. 사유 없는 실패를 하지 않는다 ──────────────────────────────────────────
async function scFail() {
  console.log('\n[B] fail — 자격증명을 못 푸는 계정에서 사유가 렌더러까지 닿는가')
  const seed = seedHome('fail', 'slug-b@example.invalid', { corrupt: true })
  await run('fail', seed, PORTS.fail, async (app, out) => {
    await typeAndSend(app, '못 뜰 턴')
    out.noticed = await waitUntil(app, `(window.__ev ?? []).some((e) => e.type === 'notice' && /계정 폴더를 열지 못했어요/.test(e.text ?? ''))`, 60_000)
    await sleep(1200)
    const s = await snap(app)
    Object.assign(out, s)

    const notice = (s.notices ?? []).find((t) => /계정 폴더를 열지 못했어요/.test(t))
    out.notice = notice ?? null
    if (notice) ok('B1 사유가 채널로 나갔다', notice)
    else fail('B1', '침묵했다 — notice가 없다', { notices: s.notices })

    if (notice && notice.includes(seed.email)) ok('B2 누구의 실패인지가 문장에 있다')
    else fail('B2', '이메일이 사유에 없다', { notice })

    out.domHasReason = /계정 폴더를 열지 못했어요/.test(s.thread)
    if (out.domHasReason) ok('B3 화면(DOM)에 사유가 보인다')
    else fail('B3', 'notice는 나갔는데 화면에는 안 보인다', { thread: s.thread.slice(-300) })

    // 없는 경로로 CLI를 태우지 않는다 — 프로세스가 아예 안 떠야 한다.
    //
    // ★ 판정 근거는 **stdin 바이트**다. `argv.json` 부재만 보면 낡은 스텁(그 빌드는
    //   `CCG_FAKECLI_ARGV`를 모른다)에서 이 단언이 공짜로 통과한다 — 실제로 그랬다.
    out.stdinBytes = stdinBytes(seed.IN)
    out.argvSupported = argvSupported
    out.cliSpawned = out.stdinBytes > 0 || (argvSupported && fs.existsSync(seed.ARGV))
    if (!out.cliSpawned) ok('B4 CLI를 태우지 않았다', { stdinBytes: out.stdinBytes, argvSupported })
    else fail('B4', '없는 계정 폴더로 CLI를 띄웠다', { stdinBytes: out.stdinBytes })

    // 래치가 남으면 채팅이 굳는다.
    out.settled = s.state === 'idle' || s.state === 'Idle'
    if (out.settled) ok('B5 그 자리에서 정착', s.state)
    else fail('B5', `상태가 안 내려왔다: ${s.state}`)
  })
}

// ─────────────────────────────────────────────────────────────────────────────
const run_ = async () => {
  if (!fs.existsSync(EXE)) throw new Error(`앱 실행본이 없다: ${EXE}`)
  if (only === 'all' || only === 'resolve') await scResolve()
  if (only === 'all' || only === 'fail') await scFail()
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(rep, null, 2))
  console.log(`\n보고서 → ${OUT}`)
  if (rep.findings.length) {
    console.error(`\n${rep.findings.length}건 실패`)
    process.exit(1)
  }
  console.log('\n전부 통과')
}
run_().catch((e) => {
  console.error(e)
  process.exit(1)
})
