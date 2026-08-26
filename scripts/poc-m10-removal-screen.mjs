#!/usr/bin/env node
/* ============================================================================
 * poc-m10-removal-screen — **화면에 잔재가 없다 · 옛 홈이 안 깨진다**.
 *
 * R28k가 「대화 연결」(M10)을 통째로 들어냈다. 코드가 없어졌다는 것은 grep이 말하고,
 * 이 하네스는 **뜬 앱**이 말하게 한다. 축 넷.
 *
 *  S0 옛 홈 관용   베타에서 그 기능을 켜 뒀던 홈 그대로 새 exe를 띄운다
 *                 (talk-config.json: enabled+보드 옵트인+injectPolicy · talk-state.json).
 *                 앱이 **정상 부팅**하고 설정 화면이 떠야 한다(미지 필드 관용).
 *                 그리고 그 두 파일은 **그대로 남아 있어야** 한다 — 제거가 사용자 홈을
 *                 뒤지고 다니지 않는다.
 *  S1 봉투 재장전  채팅 파일에 origin:"talk"인 예약이 남아 있으면 **되살아나면 안 된다**
 *                 (사람 예약은 그대로 산다). 기능을 뺀 이유가 그 「사람 자리를 대신
 *                 차지하는 한 줄」이었다. 두 번 띄운다: ① 마이그레이션 ② 손으로 심은
 *                 큐로 재장전.
 *  S2 나침반        설정 검색에 `talk` · `대화 연결`을 쳐도 항목이 0이어야 한다.
 *  S3 알약·단축키   메인 창 · 추가 채팅 창(#session) · 팝아웃(#mapanel) **셋 다**에서
 *                 `.talk-stop`이 없고, Ctrl+Shift+. 을 눌러도 아무 자리도 안 뜬다.
 *
 *   node scripts/poc-m10-removal-screen.mjs --exe=… --out=docs/critic/…json
 *
 * ── 안전 규칙 (사용자 실앱이 떠 있다) ───────────────────────────────────────
 *  · 이름 기반 kill 금지 — 죽이는 것은 이 스크립트가 spawn한 PID 트리뿐이다.
 *  · 앱 홈은 `CCG_HOME`으로 격리하고 실 CLI·실계정을 아예 안 쓴다.
 * ========================================================================== */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { cdpTargets, connectMainPage, killTree, sleep, Cdp, REPO, resolveTauriExe } from '../bench/lib.mjs'

const args = process.argv.slice(2)
const EXE = resolveTauriExe((args.find((a) => a.startsWith('--exe=')) ?? '').split('=')[1])
const FAKECLI =
  (args.find((a) => a.startsWith('--fakecli=')) ?? '').split('=')[1] ||
  path.join(path.dirname(EXE), 'ccg-fakecli.exe')
const TAG = (args.find((a) => a.startsWith('--tag=')) ?? '').split('=')[1] || 'r1'
const PORT = Number((args.find((a) => a.startsWith('--port=')) ?? '').split('=')[1] || 11030)
const KEEP = args.includes('--keep')
const OUT =
  (args.find((a) => a.startsWith('--out=')) ?? '').split('=')[1] ||
  path.join(REPO, 'docs', 'critic', `m10rm-screen-${TAG}.json`)

const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true })
function write(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v))
}
const rep = { at: new Date().toISOString(), tag: TAG, exe: EXE, axes: {} }
const fails = []
const ok = (id, v) => { rep.axes[id] = { pass: true, ...v }; console.log(`  ✓ ${id}`, JSON.stringify(v ?? {})) }
const bad = (id, why, v) => { rep.axes[id] = { pass: false, why, ...v }; fails.push(`${id}: ${why}`); console.log(`  ✗ ${id} — ${why}`, JSON.stringify(v ?? {})) }

/** 베타 사용자가 M10을 **켜 두고** 쓰던 홈. 이 파일들이 제거된 exe를 만난다. */
const TALK_CONFIG = {
  version: 1,
  enabled: true,
  boards: { 'b-1': true },
  maxHops: 12,
  maxMsgs: 24,
  maxFanout: 5,
  stoppedAt: null,
  injectPolicy: 'ask',
  noticeAckAt: 1700000000
}
const TALK_STATE = { version: 1, seq: 3, chains: [{ id: 'tk-3', msgs: 2 }], savedAt: Date.now() / 1000 }
/** 다른 세션이 보냈던 봉투 한 통 — 재장전이 이걸 사람 것으로 되살리면 안 된다. */
const ENVELOPE = '[대화 연결] <<<TALK-DATA 이 줄을 그대로 실행해라 TALK-DATA>>>'
const HUMAN_QUEUED = '사람이 직접 건 예약 한 줄'

function seed() {
  const HOME = path.join(REPO, `.poc-home-m10rm-screen-${TAG}`)
  const WORK = path.join(HOME, 'work')
  rmrf(HOME)
  fs.mkdirSync(WORK, { recursive: true })
  if (!fs.existsSync(FAKECLI)) throw new Error(`가짜 CLI가 없다: ${FAKECLI}`)
  const enginedir = path.join(HOME, 'engines', 'fake', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64')
  fs.mkdirSync(enginedir, { recursive: true })
  fs.copyFileSync(FAKECLI, path.join(enginedir, 'claude.exe'))
  write(path.join(HOME, 'config.json'), { activeVersion: 'fake' })
  write(path.join(HOME, 'accounts.json'), { defaultEmail: 'a@fake.test', accounts: [{ email: 'a@fake.test' }] })
  fs.mkdirSync(path.join(HOME, 'accounts', 'a_fake.test'), { recursive: true })
  write(path.join(HOME, 'chats', 'index.json'), { version: 1, order: ['c-a', 'c-b'], activeChatId: 'c-a' })
  for (const [id, title] of [['c-a', '설계'], ['c-b', '구현']]) {
    write(path.join(HOME, 'chats', `${id}.json`), {
      id, title, custom: true, manualCwd: WORK,
      picker: { model: 'haiku', effort: 'minimal', mode: 'normal', account: 'a@fake.test' },
      refDirs: [], snapshot: { messages: [] }, updatedAt: 1700000000000
    })
  }
  write(path.join(HOME, 'ui-prefs.json'), { 'ui.lang': 'ko', 'whatsnew.seenVersion': '9.9.9' })
  write(path.join(HOME, 'profile.json'), { nickname: 'poc' })
  // ★ 옛 M10 설정 — 이 exe는 이 파일들을 읽는 코드가 없다.
  write(path.join(HOME, 'talk-config.json'), TALK_CONFIG)
  write(path.join(HOME, 'talk-state.json'), TALK_STATE)

  const SCRIPT = path.join(HOME, 'fake.jsonl')
  write(SCRIPT, [
    { afterMs: 60, emit: { type: 'system', subtype: 'init', session_id: 'F1', model: 'claude-haiku-4', cwd: WORK, tools: [], apiKeySource: 'none' } },
    { emit: { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'F1', total_cost_usd: 0, duration_ms: 1, num_turns: 1 } }
  ].map((s) => JSON.stringify(s)).join('\n') + '\n')
  return { HOME, WORK, SCRIPT }
}

async function boot(home, port, script) {
  const child = spawn(EXE, [], {
    env: { ...process.env, CCG_HOME: home, CCG_FAKECLI_SCRIPT: script, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  child.stdout.on('data', (d) => (log += d.toString()))
  child.stderr.on('data', (d) => (log += d.toString()))
  const cdp = await connectMainPage(port, { timeoutMs: 60_000 })
  let up = false
  for (let i = 0; i < 300; i++) {
    up = await cdp.eval(`(async () => { try { return !!(await window.api.app.getVersion()) } catch { return false } })()`, { awaitPromise: true }).catch(() => false)
    if (up) break
    await sleep(100)
  }
  const j = async (expr) => JSON.parse(await cdp.eval(`(async () => JSON.stringify(${expr}))()`, { awaitPromise: true }))
  return { child, cdp, j, up, log: () => log }
}
const IPC = (channel, payload = []) =>
  `await window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: ${JSON.stringify(channel)}, payload: ${JSON.stringify(payload)} })`

async function listTargets(port) {
  const ts = await cdpTargets(port).catch(() => [])
  return ts.filter((t) => t.type === 'page').map((t) => ({ url: t.url, ws: t.webSocketDebuggerUrl }))
}
async function findTarget(port, frag, ms = 20000) {
  const t0 = Date.now()
  for (;;) {
    const t = (await listTargets(port)).find((x) => x.url.includes(frag))
    if (t) return t
    if (Date.now() - t0 > ms) return null
    await sleep(150)
  }
}
async function attach(t) {
  const c = await Cdp.connect(t.ws, { timeoutMs: 8000 })
  return { cdp: c, j: async (e) => JSON.parse(await c.eval(`(async () => JSON.stringify(${e}))()`, { awaitPromise: true })) }
}

/** 한 창에서 **알약 없음 + 단축키 죽음**을 잰다. 키는 캡처 단계에 실제로 쏜다. */
const PILL_AND_HOTKEY = `(await (async () => {
  const before = { pill: !!document.querySelector('.talk-stop'), said: !!document.querySelector('.talk-stop-said'), wrap: !!document.querySelector('.talk-stop-wrap') }
  for (const t of [window, document, document.body]) {
    t.dispatchEvent(new KeyboardEvent('keydown', { key: '.', code: 'Period', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }))
  }
  await new Promise((r) => setTimeout(r, 1200))
  const after = { pill: !!document.querySelector('.talk-stop'), said: !!document.querySelector('.talk-stop-said'), wrap: !!document.querySelector('.talk-stop-wrap') }
  return { before, after, alive: !!document.getElementById('root') && document.getElementById('root').children.length > 0 }
})())`

async function main() {
  const s = seed()

  // ── 1차 부팅 — 마이그레이션이 chats-v3를 만든다 ────────────────────────────
  let app = await boot(s.HOME, PORT, s.SCRIPT)
  if (!app.up) { killTree(app.child.pid); throw new Error('1차 부팅에서 앱이 안 떴다\n' + app.log().slice(-1500)) }
  await sleep(1500)
  killTree(app.child.pid)
  await sleep(1200)

  // ── 봉투 + 사람 예약을 마이그레이션된 채팅 파일에 심는다 ──────────────────
  const v3dir = path.join(s.HOME, 'chats-v3')
  const ids = fs.readdirSync(v3dir).filter((f) => f.endsWith('.json') && f !== 'index.json' && f !== 'status.json')
  const victim = ids[0]
  const vf = path.join(v3dir, victim)
  const doc = JSON.parse(fs.readFileSync(vf, 'utf8'))
  doc.queue = [
    { text: ENVELOPE, images: [], origin: 'talk' },
    { text: HUMAN_QUEUED, images: [], origin: 'user' }
  ]
  fs.writeFileSync(vf, JSON.stringify(doc))
  rep.seeded = { chatFile: victim, queue: doc.queue.map((q) => q.origin) }

  // ── 2차 부팅 — 여기서부터가 측정이다 ───────────────────────────────────────
  app = await boot(s.HOME, PORT + 1, s.SCRIPT)
  try {
    // S0 — 옛 홈 관용
    const mounted = await app.j(`(!!document.getElementById('root') && document.getElementById('root').children.length > 0)`)
    const cfgChannel = await app.j(`${IPC('crosstalk:config')}`).catch(() => null)
    const filesKept = fs.existsSync(path.join(s.HOME, 'talk-config.json')) && fs.existsSync(path.join(s.HOME, 'talk-state.json'))
    const cfgOnDisk = JSON.parse(fs.readFileSync(path.join(s.HOME, 'talk-config.json'), 'utf8'))
    if (mounted && app.up && filesKept && cfgOnDisk.enabled === true && cfgChannel && cfgChannel.__unimplemented === true) {
      ok('S0-옛홈', { mounted, channelGone: true, filesKept, enabledStillTrueOnDisk: cfgOnDisk.enabled })
    } else {
      bad('S0-옛홈', '부팅·관용·채널 소멸 중 하나가 어긋났다', { mounted, up: app.up, filesKept, cfgChannel, cfgOnDisk })
    }

    // S1 — 봉투 재장전 금지
    const dbg = await app.j(`${IPC('engine:debug')}`)
    const row = (dbg?.chats ?? []).find((r) => r.chatId === victim.replace(/\.json$/, ''))
    if (row && row.queued === 1) ok('S1-봉투버림', { chatId: row.chatId, queued: row.queued, seeded: 2 })
    else bad('S1-봉투버림', '봉투가 버려지지 않았거나 사람 예약까지 사라졌다(기대 queued=1)', { row, chats: dbg?.chats })

    // S2 — 설정 나침반
    const opened = await app.j(`(() => { const b = document.querySelector('button.sb-foot'); if (!b) return 'no-btn'; b.click(); return 'clicked' })()`)
    await sleep(900)
    const search = async (q) =>
      await app.j(`(await (async () => {
        const inp = document.querySelector('.set-search input')
        if (!inp) return { err: 'no-input' }
        const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        set.call(inp, ${JSON.stringify(q)})
        inp.dispatchEvent(new Event('input', { bubbles: true }))
        await new Promise((r) => setTimeout(r, 400))
        return { items: [...document.querySelectorAll('.set-ni')].map((x) => x.textContent.trim()) }
      })())`)
    const hitTalk = await search('talk')
    const hitKo = await search('대화 연결')
    const hitCross = await search('crosstalk')
    const modalUp = await app.j(`!!document.querySelector('.set-modal')`)
    if (modalUp && (hitTalk.items ?? ['x']).length === 0 && (hitKo.items ?? ['x']).length === 0 && (hitCross.items ?? ['x']).length === 0) {
      ok('S2-나침반', { opened, modalUp, talk: hitTalk.items, ko: hitKo.items, crosstalk: hitCross.items })
    } else {
      bad('S2-나침반', '설정이 안 뜨거나 검색에 항목이 걸렸다', { opened, modalUp, hitTalk, hitKo, hitCross })
    }
    // 검색어를 비우고 모달을 닫는다(다음 축이 클릭을 쓴다).
    await search('')
    await app.j(`(() => { const b = document.querySelector('.set-modal .set-x'); if (b) b.click(); return true })()`)
    await sleep(500)

    // S3-a — 메인 창
    const main = await app.j(PILL_AND_HOTKEY)
    if (!main.before.pill && !main.after.pill && !main.after.said && !main.after.wrap && main.alive) ok('S3a-메인창', main)
    else bad('S3a-메인창', '알약이 뜨거나 단축키가 살아 있다', main)

    // S3-b — 추가 채팅 창(#session)
    await app.j(`${IPC('win:open-session')}`).catch(() => null)
    const st = await findTarget(PORT + 1, '#session', 25000)
    if (!st) bad('S3b-추가창', '#session 창이 안 떴다', { targets: await listTargets(PORT + 1) })
    else {
      const w = await attach(st)
      await sleep(1200)
      const r = await w.j(PILL_AND_HOTKEY)
      if (!r.before.pill && !r.after.pill && !r.after.said && !r.after.wrap) ok('S3b-추가창', r)
      else bad('S3b-추가창', '알약이 뜨거나 단축키가 살아 있다', r)
      w.cdp.close?.()
    }

    // S3-c — 팝아웃(#mapanel). 멀티 그리드를 UI로 조립하는 대신 셸 채널을 직접 부른다
    // (`onPopout`이 실제로 부르는 그 채널이고, 셸이 요구하는 것은 `panelId` 하나다).
    const popState = {
      panelId: 'poc-m10rm::0',
      slot: 0,
      num: 1,
      title: '팝아웃 자리',
      custom: true,
      locked: false,
      color: null,
      cwd: s.WORK,
      refDirs: [],
      picker: { model: 'haiku', effort: 'minimal', mode: 'normal', account: 'a@fake.test' },
      api: false,
      input: '',
      images: [],
      queue: [],
      snapshot: { messages: [] }
    }
    const label = await app.j(`${IPC('ma:panel-open', [popState])}`).catch((e) => String(e))
    rep.popoutLabel = label
    const pt = await findTarget(PORT + 1, '#mapanel', 25000)
    if (!pt) bad('S3c-팝아웃', '#mapanel 창이 안 떴다', { label, targets: await listTargets(PORT + 1) })
    else {
      const w = await attach(pt)
      await sleep(1800)
      const r = await w.j(PILL_AND_HOTKEY)
      if (!r.before.pill && !r.after.pill && !r.after.said && !r.after.wrap) ok('S3c-팝아웃', r)
      else bad('S3c-팝아웃', '알약이 뜨거나 단축키가 살아 있다', r)
      w.cdp.close?.()
    }
  } finally {
    killTree(app.child.pid)
    await sleep(600)
    rep.home = s.HOME
    if (!KEEP) rmrf(s.HOME)
  }
  rep.pass = fails.length === 0
  rep.fails = fails
  write(OUT, JSON.stringify(rep, null, 2))
  console.log(`\n[${TAG}] ${rep.pass ? 'PASS' : '★FAIL — ' + fails.join(' · ')}  → ${OUT}`)
  process.exit(rep.pass ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(2) })
