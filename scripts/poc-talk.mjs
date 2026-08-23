#!/usr/bin/env node
/* ============================================================================
 * poc-talk — **대화 연결(M10) 실증 하네스**. 세션 둘이 진짜로 말을 주고받는가,
 * 그리고 **정해진 자리에서 멈추는가**.
 *
 * 이 기능은 2.6.2에서 만들었다가 사용자 요청으로 롤백된 적이 있다("세션끼리 자동으로
 * 대화하는 게 위험하다"). 그래서 이 하네스의 절반은 "된다"가 아니라 "**안 된다**"를
 * 잰다 — 꺼져 있으면 안 나가고, 상한에 닿으면 멎고, 정지를 누르면 죽는가.
 *
 *   node scripts/poc-talk.mjs              # 전부 (wall → live)
 *   node scripts/poc-talk.mjs --only=wall  # 안전벽만 (가짜 CLI · $0)
 *   node scripts/poc-talk.mjs --only=live  # 실 CLI 왕복 (haiku 3턴)
 *   node scripts/poc-talk.mjs --keep       # 격리 홈 보존
 *   node scripts/poc-talk.mjs --tag        # 동시 실행(홈·포트·산출물 분리)
 *
 *   ※ wall 단계 전에:
 *      cargo build -p ccg-engine --features fakecli --bin ccg-fakecli --release
 *   ※ 둘 다 앱 실물이 필요하다: target/release/agentcodegui.exe (--exe=로 교체 가능)
 *
 * ── 안전 규칙 (사용자 실앱이 떠 있다) ───────────────────────────────────────
 *  · **이름 기반 kill 금지.** 죽이는 것은 이 스크립트가 spawn한 PID 트리뿐이다.
 *  · **실홈은 읽기/복사만.** 엔진은 정션, 자격증명은 복사.
 *  · 앱 홈은 전부 `CCG_HOME`으로 격리한다(레포 안 `.poc-home-talk*`).
 * ========================================================================== */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { connectMainPage, killTree, sleep, REPO } from '../bench/lib.mjs'

const args = process.argv.slice(2)
const only = (args.find((a) => a.startsWith('--only=')) ?? '').split('=')[1] || 'all'
const KEEP = args.includes('--keep')
const EXE =
  (args.find((a) => a.startsWith('--exe=')) ?? '').split('=')[1] ||
  path.join(REPO, 'target', 'release', 'agentcodegui.exe')
const REAL_HOME = path.join(os.homedir(), '.agentcodegui')
const tagArg = args.find((a) => a === '--tag' || a.startsWith('--tag='))
const RUNTAG = tagArg === undefined ? '' : tagArg.split('=')[1] || `${process.pid}-${Math.random().toString(36).slice(2, 6)}`
const hash32 = (s) => {
  let h = 2166136261
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return h >>> 0
}
const homeFor = (name) => path.join(REPO, `.poc-home-talk-${name}${RUNTAG ? `-${RUNTAG}` : ''}`)
// 이 하네스가 쓰는 포트는 9391~9392. 태그당 16씩 민다(poc-live-chat과 겹치지 않는 대역).
const PORT_SHIFT = RUNTAG ? 16 + (hash32(RUNTAG) % 40) * 16 : 0
const portFor = (base) => base + PORT_SHIFT
// **기준 결과 파일을 덮지 않는다** — 라운드마다 자기 파일에 쓴다.
const OUT = path.join(REPO, 'docs', 'critic', `m10-r1-talk${RUNTAG ? `-${RUNTAG}` : ''}.json`)

const rep = { at: new Date().toISOString(), exe: EXE, steps: {}, findings: [] }
const fail = (id, why, extra) => {
  rep.findings.push({ id, why, ...(extra ?? {}) })
  console.error(`  x ${id} — ${why}${extra === undefined ? '' : ' ' + JSON.stringify(extra).slice(0, 400)}`)
}
const ok = (id, v) => console.log(`  o ${id}${v === undefined ? '' : ' — ' + JSON.stringify(v).slice(0, 300)}`)

const rmrf = (p) => {
  for (let i = 0; i < 12; i++) {
    try {
      fs.rmSync(p, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 })
      return
    } catch (e) {
      if (i === 11) throw e
      spawnSync('cmd', ['/c', 'ping', '127.0.0.1', '-n', '2'], { stdio: 'ignore' })
    }
  }
}
const write = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v))
}

// ── 앱 부팅 + CDP ────────────────────────────────────────────────────────────
async function boot(home, port, env = {}) {
  const child = spawn(EXE, [], {
    env: { ...process.env, CCG_HOME: home, ...env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  child.stdout.on('data', (d) => (log += d.toString()))
  child.stderr.on('data', (d) => (log += d.toString()))
  const cdp = await connectMainPage(port, { timeoutMs: 60_000 })
  for (let i = 0; i < 300; i++) {
    const up = await cdp
      .eval(`(async () => { try { return !!(await window.api.app.getVersion()) } catch { return false } })()`, { awaitPromise: true })
      .catch(() => false)
    if (up) break
    await sleep(100)
  }
  const j = async (expr) => JSON.parse(await cdp.eval(`(async () => JSON.stringify(${expr}))()`, { awaitPromise: true }))
  const call = async (ch, payload) =>
    await j(`await window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: ${JSON.stringify(ch)}, payload: ${JSON.stringify(payload)} })`)
  return { child, cdp, j, call, log: () => log }
}

/** 모든 채팅의 `chat:event`를 창 하나에서 통째로 받아 둔다(화면과 독립인 증거). */
async function armEvents(app) {
  return await app.j(`await (async () => {
    window.__tk = []
    const I = window.__TAURI_INTERNALS__
    const handler = I.transformCallback((e) => window.__tk.push(e.payload))
    await I.invoke('plugin:event|listen', { event: 'chat:event', target: { kind: 'Any' }, handler })
    return true
  })()`)
}
const events = (app, chatId) =>
  app.j(`window.__tk.filter((x) => ${chatId ? `x.chatId === ${JSON.stringify(chatId)}` : 'true'}).map((x) => x.event)`)
/** 대화 연결 관련 notice만(발신 기록·거절 사유). */
const talkNotices = async (app, chatId) =>
  (await events(app, chatId)).filter((e) => e?.type === 'notice' && e.talk).map((e) => ({ text: e.text, ...e.talk }))

async function waitFor(fn, ms, every = 200) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn().catch(() => null)
    if (v) return v
    if (Date.now() - t0 > ms) return null
    await sleep(every)
  }
}

// ── 공용 씨앗: 채팅 둘 (보드는 부팅 뒤에 채널로 세운다) ──────────────────────
/**
 * 2.6.2 포맷으로 심는다 — 첫 통합 채널 접촉에서 마이그레이터가 `chats-v3/`로 옮긴다.
 *
 * **`boards/`는 파일로 심지 않는다.** 마이그레이터는 "이미 3.0으로 옮긴 홈"이 아닌 한
 * `boards/`를 자기가 만든 것으로 **덮는다**(`migrate_v3.rs:634` — `already_migrated`가
 * 거짓이면 3.0 보드를 보존하지 않는다). 그래서 자리 배치는 부팅 **뒤에** `board:save`로
 * 세운다(제품이 쓰는 그 채널이다).
 */
function seedChats(HOME, WORK, picker, accounts) {
  write(path.join(HOME, 'chats', 'index.json'), { version: 1, order: ['c-a', 'c-b'], activeChatId: 'c-a' })
  for (const [id, title, acct] of [
    ['c-a', '설계', accounts?.[0]],
    ['c-b', '구현', accounts?.[1]]
  ]) {
    write(path.join(HOME, 'chats', `${id}.json`), {
      id,
      title,
      custom: true,
      manualCwd: WORK,
      picker: { ...picker, ...(acct ? { account: acct } : {}) },
      refDirs: [],
      snapshot: { messages: [] },
      updatedAt: Date.now()
    })
  }
  write(path.join(HOME, 'ui-prefs.json'), { 'ui.lang': 'ko' })
  write(path.join(HOME, 'profile.json'), { nickname: 'poc' })
}

/**
 * 자리 배치 — 「설계」=자리 1, 「구현」=자리 2, `count:2`(둘 다 **보이는 자리**).
 * 도달 범위는 보이는 자리이므로 접힌 자리는 애초에 서로를 못 본다.
 * 채팅 id는 마이그레이션이 정하므로 **제목으로 되찾는다**.
 */
async function installBoard(app) {
  const got = await app.call('chats:get', [{ light: true }])
  const byTitle = (t) => (got?.chats ?? []).find((c) => c.title === t)?.id
  const a = byTitle('설계')
  const b = byTitle('구현')
  if (!a || !b) throw new Error(`마이그레이션 뒤 채팅을 못 찾았다: ${JSON.stringify((got?.chats ?? []).map((c) => [c.id, c.title]))}`)
  await app.call('board:save', [
    {
      version: 1,
      activeBoardId: 'b-1',
      boards: [
        { id: 'b-1', title: '협업 보드', custom: true, count: 2, chrome: 'grid', order: [0, 1, 2, 3, 4, 5], slots: [a, b, null, null, null, null], updatedAt: Date.now() }
      ]
    }
  ])
  return { a, b }
}

// ═════════════════════════════════════════════════════════════════════════════
// 1) WALL — 안전벽. 가짜 CLI라 $0이고 결정적이다.
//
//    가짜 CLI는 대본을 **스폰당 한 번** 흘리고 만다. 그래서 `maxHops:1`로 잡는다:
//      A(사람 턴) → `@talk[2]` → 홉 1 = 통과 → B가 콜드 스타트
//      B(전달 턴) → `@talk[1]` → 홉 2 > 1 = **차단** → 왕복이 여기서 멎는다
//    두 스폰으로 "간다"와 "멈춘다"를 동시에 보이고, 죽은 스트림에 두 번째 턴을
//    밀어 넣지 않으므로 T3(침묵 감시)로 오염되지도 않는다.
// ═════════════════════════════════════════════════════════════════════════════
function fakeScript(work, sid, text) {
  return (
    [
      { afterMs: 80, emit: { type: 'system', subtype: 'init', session_id: sid, model: 'claude-haiku-4', cwd: work, tools: [], apiKeySource: 'none' } },
      {
        afterMs: 120,
        emit: {
          type: 'assistant',
          session_id: sid,
          parent_tool_use_id: null,
          message: { role: 'assistant', content: [{ type: 'text', text }], usage: { input_tokens: 7 } }
        }
      },
      { emit: { type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid, total_cost_usd: 0, duration_ms: 1, num_turns: 1 } }
    ]
      .map((s) => JSON.stringify(s))
      .join('\n') + '\n'
  )
}

function seedWallHome() {
  const HOME = homeFor('wall')
  const WORK = path.join(HOME, 'work')
  rmrf(HOME)
  fs.mkdirSync(WORK, { recursive: true })
  const stub = path.join(REPO, 'target', 'release', 'ccg-fakecli.exe')
  if (!fs.existsSync(stub)) {
    throw new Error(`가짜 CLI가 없다: ${stub}\n  cargo build -p ccg-engine --features fakecli --bin ccg-fakecli --release`)
  }
  const enginedir = path.join(HOME, 'engines', 'fake', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64')
  fs.mkdirSync(enginedir, { recursive: true })
  fs.copyFileSync(stub, path.join(enginedir, 'claude.exe'))
  write(path.join(HOME, 'config.json'), { activeVersion: 'fake' })
  // 계정 둘 — 이름만 필요하다(정규화는 known_accounts로만 판정한다). 갈라 두는 이유는
  // 가짜 CLI가 `CLAUDE_CONFIG_DIR` 꼬리로 **채팅마다 다른 대본**을 고르기 때문이다.
  write(path.join(HOME, 'accounts.json'), {
    defaultEmail: 'a@fake.test',
    accounts: [{ email: 'a@fake.test' }, { email: 'b@fake.test' }]
  })
  fs.mkdirSync(path.join(HOME, 'accounts', 'a_fake.test'), { recursive: true })
  fs.mkdirSync(path.join(HOME, 'accounts', 'b_fake.test'), { recursive: true })
  seedChats(HOME, WORK, { model: 'haiku', effort: 'minimal', mode: 'normal' }, ['a@fake.test', 'b@fake.test'])

  const SCRIPT = path.join(HOME, 'fake.jsonl')
  write(SCRIPT, fakeScript(WORK, 'FAKE-X', '대본 없음'))
  write(path.join(HOME, 'fake.a_fake.test.jsonl'), fakeScript(WORK, 'FAKE-A', '확인했습니다.\n@talk[2] 빌드가 깨졌어요. 확인 부탁합니다.'))
  write(path.join(HOME, 'fake.b_fake.test.jsonl'), fakeScript(WORK, 'FAKE-B', '살펴봤습니다.\n@talk[1] 고쳤습니다.'))
  return { HOME, WORK, SCRIPT }
}

async function phaseWall() {
  console.log('\n[WALL] 안전벽 — 옵트인 · 전달 · 홉 상한 · 긴급 정지 (가짜 CLI · $0)')
  const s = seedWallHome()
  const out = { home: s.HOME, steps: {} }
  const app = await boot(s.HOME, portFor(9391), { CCG_FAKECLI_SCRIPT: s.SCRIPT })
  try {
    await armEvents(app)
    const { a: A, b: B } = await installBoard(app)
    out.chats = { A, B }

    // ── W1. 기본값은 꺼짐 ────────────────────────────────────────────────
    const cfg0 = await app.call('crosstalk:config', [])
    out.steps.defaultOff = cfg0
    if (cfg0?.enabled !== false) fail('W1-기본꺼짐', '설정 파일이 없는데 켜져 있다', cfg0)
    else ok('W1-기본꺼짐', { enabled: cfg0.enabled, maxHops: cfg0.maxHops })

    // ── W2. 꺼진 상태에서는 구문이 **글자로만** 남는다 ────────────────────
    await app.call('chat:run', [{ chatId: A, prompt: '2번 자리에 상황을 알려줘.' }])
    const offNotice = await waitFor(async () => (await talkNotices(app, A)).find((n) => n.result), 30_000)
    out.steps.off = { notice: offNotice, bSpawned: (await events(app, B)).length }
    if (offNotice?.result !== 'off') fail('W2-옵트인', `꺼짐인데 result=${offNotice?.result ?? '(없음)'}`, offNotice)
    else if (out.steps.off.bSpawned !== 0) fail('W2-옵트인', 'B에 이벤트가 갔다 = 실제로 나갔다', out.steps.off)
    else ok('W2-옵트인', { result: offNotice.result, bEvents: 0 })

    // ── W3. 켜고 다시 — 이번엔 나간다 ─────────────────────────────────────
    // 스트림째 끊고(가짜 CLI는 대본을 스폰당 1회만 흘린다) 다음 전송을 콜드 스타트로.
    await app.call('chat:cancel', [{ chatId: A }])
    await sleep(1200)
    const cfg1 = await app.call('crosstalk:set', [{ enabled: true, board: 'b-1', on: true, maxHops: 1 }])
    out.steps.enabled = cfg1
    if (cfg1?.enabled !== true || cfg1?.boards?.['b-1'] !== true || cfg1?.maxHops !== 1) {
      fail('W3-옵트인켜기', '설정이 안 붙었다', cfg1)
    } else ok('W3-옵트인켜기', { enabled: true, boards: Object.keys(cfg1.boards), maxHops: cfg1.maxHops })

    await app.j('(window.__tk = [], true)')
    await app.call('chat:run', [{ chatId: A, prompt: '2번 자리에 상황을 알려줘.' }])
    const sent = await waitFor(async () => (await talkNotices(app, A)).find((n) => n.result), 40_000)
    out.steps.sent = sent
    if (sent?.result !== 'delivered' && sent?.result !== 'queued') {
      fail('W4-전달', `발신이 통과 못 했다: ${sent?.result ?? '(없음)'}`, sent)
    } else ok('W4-전달', { result: sent.result, to: sent.to, hop: sent.hop })

    // ── W5. 수신자 스레드에 **말풍선으로 보인다** ─────────────────────────
    const echo = await waitFor(async () => (await events(app, B)).find((e) => e?.type === 'user-echo'), 40_000)
    out.steps.echo = echo ? { text: String(echo.text).slice(0, 220) } : null
    if (!echo) fail('W5-가시성', 'B 스레드에 수신 말풍선이 없다')
    else if (!String(echo.text).includes('[대화 연결]') || !String(echo.text).includes('빌드가 깨졌'))
      fail('W5-가시성', '봉투/본문이 말풍선에 없다', out.steps.echo)
    else ok('W5-가시성', { envelope: true, body: true })

    // ── W6. 홉 상한 — B의 회신이 **여기서 멎는다** ────────────────────────
    const capped = await waitFor(async () => (await talkNotices(app, B)).find((n) => n.result), 60_000)
    out.steps.hopCap = capped
    if (capped?.result !== 'hop_cap') fail('W6-홉상한', `상한(1)에서 안 멎었다: ${capped?.result ?? '(없음)'}`, capped)
    else ok('W6-홉상한', { result: capped.result, text: capped.text })

    // A가 B의 회신을 **받지 않았는가**(차단이 실제 차단인가).
    await sleep(1500)
    const aEchoes = (await events(app, A)).filter((e) => e?.type === 'user-echo')
    out.steps.aEchoesAfterCap = aEchoes.length
    if (aEchoes.length !== 0) fail('W6b-차단실효', '차단했는데 A에 수신 말풍선이 생겼다', aEchoes.length)
    else ok('W6b-차단실효', { aIncoming: 0 })

    // ── W7. 라우터 회계 — 거절 사유가 진단에 남는가 ───────────────────────
    const dbg = await app.call('engine:debug', [])
    out.steps.debug = dbg?.talk ?? null
    const kinds = (dbg?.talk?.log ?? []).map((l) => l.what)
    if (!kinds.includes('send') || !kinds.includes('hop_cap')) fail('W7-진단', '라우터 로그에 판정이 안 남는다', kinds)
    else ok('W7-진단', { log: kinds })

    // ── W8. 긴급 정지 ─────────────────────────────────────────────────────
    const stopped = await app.call('crosstalk:stop', [])
    out.steps.stop = stopped
    const after = await app.call('crosstalk:config', [])
    if (stopped?.enabled !== false || after?.enabled !== false) fail('W8-긴급정지', '정지 후에도 켜져 있다', { stopped, after })
    else ok('W8-긴급정지', { enabled: after.enabled })
  } finally {
    killTree(app.child.pid)
    await sleep(800)
    if (!KEEP) rmrf(s.HOME)
  }
  rep.steps.wall = out
  return rep.findings.filter((f) => f.id.startsWith('W')).length === 0
}

// ═════════════════════════════════════════════════════════════════════════════
// 2) LIVE — 실 claude.exe로 진짜 왕복. haiku · 짧은 턴 · 3턴.
//
//    A(사람) → B → A 세 턴이면 `maxHops:2`에서 셋째 발신이 상한에 닿는다.
//    본문 자체가 상대에게 "너도 한 줄 써라"라고 지시하므로 왕복이 성립하고,
//    마지막 한 걸음만 **라우터가** 막는다(모델의 자제가 아니라 벽으로 막는 것을 본다).
// ═════════════════════════════════════════════════════════════════════════════
function seedLiveHome() {
  const HOME = homeFor('live')
  const WORK = path.join(HOME, 'work')
  rmrf(HOME)
  fs.mkdirSync(WORK, { recursive: true })

  // (a) 엔진 — 실홈 engines를 정션(복사 없음·쓰기 없음)
  const ver = JSON.parse(fs.readFileSync(path.join(REAL_HOME, 'config.json'), 'utf8')).activeVersion
  write(path.join(HOME, 'config.json'), { activeVersion: ver })
  const link = path.join(HOME, 'engines')
  const r = spawnSync('cmd', ['/c', 'mklink', '/J', link, path.join(REAL_HOME, 'engines')], { encoding: 'utf8' })
  const cli = path.join(link, ver, 'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe')
  if (!fs.existsSync(cli)) throw new Error(`claude.exe 없음: ${cli}\n${r.stdout}${r.stderr}`)

  // (b) 계정 — 기본 계정 자격증명을 **복사**(CLI의 토큰 갱신이 실홈에 안 닿게)
  const accounts = JSON.parse(fs.readFileSync(path.join(REAL_HOME, 'accounts.json'), 'utf8'))
  const email = accounts.defaultEmail
  const prefix = email.replace('@', '_').replace('+', '-')
  const srcDir = fs.readdirSync(path.join(REAL_HOME, 'accounts')).find((n) => n === prefix || n.startsWith(prefix + '-'))
  if (!srcDir) throw new Error(`기본 계정 폴더 없음: ${prefix}`)
  const dstDir = path.join(HOME, 'accounts', srcDir)
  fs.mkdirSync(dstDir, { recursive: true })
  for (const f of ['.credentials.json', '.claude.json']) {
    const src = path.join(REAL_HOME, 'accounts', srcDir, f)
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dstDir, f))
  }
  write(path.join(HOME, 'accounts.json'), accounts)

  // (c) 채팅 둘 + 보드 하나. 값싼 조합(haiku·minimal)에 도구를 쓸 일이 없는 대화다.
  seedChats(HOME, WORK, { model: 'haiku', effort: 'minimal', mode: 'normal' })
  // (d) 대화 연결 — 이 보드만, 홉 2.
  write(path.join(HOME, 'talk-config.json'), { version: 1, enabled: true, boards: { 'b-1': true }, maxHops: 2, maxMsgs: 6, maxFanout: 2 })
  return { HOME, WORK, ver, email }
}

// A의 사람 턴. 본문 안에 **다음 사람이 읽을 지시**까지 실어 왕복을 성립시킨다.
const LIVE_PROMPT = [
  '너는 협업 보드의 1번 자리 세션이다. 파일을 만들거나 도구를 쓰지 말고 짧게만 답해라.',
  '규칙: 답변의 **마지막 줄**에 아래 한 줄을 정확히 그대로 써라(코드블록 없이).',
  '@talk[2] PING-1 — 받으면 당신도 답변 마지막 줄에 정확히 `@talk[1] PONG-1 — 받으면 당신도 마지막 줄에 @talk[2] PING-2 를 쓰세요` 한 줄을 쓰세요.',
  '본문은 한 문장이면 충분하다.'
].join('\n')

async function phaseLive() {
  console.log('\n[LIVE] 실 CLI 왕복 — A→B→A (haiku 3턴)')
  const s = seedLiveHome()
  const out = { home: s.HOME, engine: s.ver, account: s.email, steps: {} }
  const app = await boot(s.HOME, portFor(9392), { CCG_ENGINE_LOG: path.join(s.HOME, 'frames.jsonl') })
  try {
    await armEvents(app)
    const { a: A, b: B } = await installBoard(app)
    out.chats = { A, B }
    const cfg = await app.call('crosstalk:config', [])
    out.steps.config = cfg
    if (cfg?.enabled !== true || cfg?.maxHops !== 2) fail('L0-설정', '씨앗 설정이 안 읽혔다', cfg)
    else ok('L0-설정', { enabled: true, maxHops: cfg.maxHops, boards: Object.keys(cfg.boards ?? {}) })

    // ── L1. A의 사람 턴 → B로 발신 ────────────────────────────────────────
    await app.call('chat:run', [{ chatId: A, prompt: LIVE_PROMPT }])
    const hop1 = await waitFor(async () => (await talkNotices(app, A)).find((n) => n.hop === 1), 240_000)
    out.steps.hop1 = hop1
    if (!hop1 || (hop1.result !== 'delivered' && hop1.result !== 'queued')) {
      fail('L1-A→B', `A의 발신이 안 나갔다: ${hop1?.result ?? '(구문 없음)'}`, {
        hop1,
        aText: (await events(app, A)).filter((e) => e?.type === 'assistant-done').map((e) => String(e.text).slice(-260))
      })
      throw new Error('L1')
    }
    ok('L1-A→B', { result: hop1.result, to: hop1.to, hop: hop1.hop })

    // ── L2. B가 봉투를 말풍선으로 받고, 그 턴을 돈다 ──────────────────────
    const bEcho = await waitFor(async () => (await events(app, B)).find((e) => e?.type === 'user-echo'), 90_000)
    out.steps.bEcho = bEcho ? String(bEcho.text).slice(0, 300) : null
    if (!bEcho || !String(bEcho.text).includes('[대화 연결]')) fail('L2-수신', 'B 스레드에 봉투 말풍선이 없다', out.steps.bEcho)
    else ok('L2-수신', { envelope: true })

    // ── L3. B → A (홉 2) ──────────────────────────────────────────────────
    const hop2 = await waitFor(async () => (await talkNotices(app, B)).find((n) => n.hop === 2 || n.result === 'hop_cap'), 240_000)
    out.steps.hop2 = hop2
    if (!hop2 || (hop2.result !== 'delivered' && hop2.result !== 'queued')) {
      fail('L3-B→A', `B의 회신이 안 나갔다: ${hop2?.result ?? '(구문 없음)'}`, {
        hop2,
        bText: (await events(app, B)).filter((e) => e?.type === 'assistant-done').map((e) => String(e.text).slice(-260))
      })
    } else ok('L3-B→A', { result: hop2.result, hop: hop2.hop })

    // ── L4. A의 셋째 발신이 **상한에서 멎는다** ───────────────────────────
    const capped = await waitFor(
      async () => (await talkNotices(app, A)).find((n) => n.result === 'hop_cap' || (n.hop ?? 0) >= 3),
      240_000
    )
    out.steps.hop3 = capped
    if (!capped) {
      fail('L4-홉상한', 'A의 셋째 턴에서 판정이 안 나왔다(모델이 구문을 안 썼을 수 있다)', {
        aText: (await events(app, A)).filter((e) => e?.type === 'assistant-done').map((e) => String(e.text).slice(-260))
      })
    } else if (capped.result !== 'hop_cap') {
      fail('L4-홉상한', `상한(2)을 넘겼는데 통과했다: ${capped.result} hop=${capped.hop}`, capped)
    } else ok('L4-홉상한', { result: capped.result, text: capped.text })

    // ── L5. 회계 — 왕복은 2건, 셋째는 거절 ────────────────────────────────
    const dbg = await app.call('engine:debug', [])
    out.steps.debug = dbg?.talk ?? null
    const log = (dbg?.talk?.log ?? []).map((l) => l.what)
    const sends = log.filter((w) => w === 'send').length
    const caps = log.filter((w) => w === 'hop_cap').length
    out.steps.tally = { sends, caps, log }
    if (sends !== 2 || caps < 1) fail('L5-회계', `왕복 2건 + 상한 1건이 아니다 (send=${sends}, hop_cap=${caps})`, log)
    else ok('L5-회계', { sends, caps })

    // ── L6. 대화 내용 — 실제로 서로의 말을 읽었는가 ───────────────────────
    const aTexts = (await events(app, A)).filter((e) => e?.type === 'assistant-done').map((e) => e.text)
    const bTexts = (await events(app, B)).filter((e) => e?.type === 'assistant-done').map((e) => e.text)
    out.steps.transcript = { a: aTexts.map((t) => String(t).slice(0, 400)), b: bTexts.map((t) => String(t).slice(0, 400)) }
    if (aTexts.length < 2 || bTexts.length < 1) fail('L6-대화', `턴 수가 모자라다 (A=${aTexts.length}, B=${bTexts.length})`)
    else ok('L6-대화', { aTurns: aTexts.length, bTurns: bTexts.length })
  } catch (e) {
    if (String(e?.message) !== 'L1') fail('LIVE', String(e?.message ?? e))
  } finally {
    killTree(app.child.pid)
    await sleep(900)
    if (!KEEP) rmrf(s.HOME)
  }
  rep.steps.live = out
  return rep.findings.filter((f) => f.id.startsWith('L')).length === 0
}

// ── main ─────────────────────────────────────────────────────────────────────
const t0 = Date.now()
if (!fs.existsSync(EXE)) {
  console.error(`앱 실물이 없다: ${EXE}\n  npm run tauri:build (또는 --exe=<경로>)`)
  process.exit(2)
}
let allOk = true
if (only === 'all' || only === 'wall') allOk = (await phaseWall()) && allOk
if (only === 'all' || only === 'live') allOk = (await phaseLive()) && allOk
rep.ms = Date.now() - t0
rep.verdict = rep.findings.length === 0 ? 'PASS' : 'FAIL'
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(rep, null, 2))
console.log(`\n${rep.verdict} — ${rep.findings.length}건 · ${(rep.ms / 1000).toFixed(1)}s\n산출물: ${OUT}`)
process.exit(rep.verdict === 'PASS' ? 0 : 1)
