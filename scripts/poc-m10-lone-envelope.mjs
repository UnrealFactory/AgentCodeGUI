#!/usr/bin/env node
/* ============================================================================
 * poc-m10-lone-envelope — **봉투 한 통만 남은 채팅도 부팅 한 번에 스스로 낫는다.**
 *
 * R28k가 M10(「대화 연결」)을 통째로 들어내면서 재장전 필터를 뒀다
 * (`engine::is_retired_talk_row`). 그 필터는 **재장전되는 채팅**에만 닿았다 —
 * `engine/mod.rs`가 `queued.is_empty() && hold.is_none()`이면 `Op::Reload`를 아예 안
 * 불렀으므로, 큐에 `origin:"talk"` 한 줄뿐이고 한도 대기표가 없는 채팅은 필터가 그 줄을
 * 버린 **바로 그 순간** "되살릴 게 없다"가 되어 허브를 안 탔다. 재경화(`persist_queue`)가
 * 재장전에 매달려 있으니 **디스크의 봉투가 그대로 남고**, 사이드바가 읽는 부팅 행은
 * 파일의 `queue` 길이를 세므로 「1」이 계속 붙는다(R28k 확인 크리틱 R2 §3 F1).
 *
 * 이 하네스는 **뜬 앱**으로 그 자리를 잰다. 축 넷.
 *
 *  L1 봉투 한 통     큐에 봉투 한 줄 · `hold` 없음인 채팅을 심고 부팅 →
 *                   디스크 `queue` **0줄** · `chats:get.statuses[id].queued` **0** ·
 *                   `chats:load` 페이로드에 `TALK-DATA` **0건** · 화면(`.sched`) **없음**.
 *  L2 영속           한 번 더 부팅해도 그대로 깨끗한가(첫 부팅이 파일을 실제로 고쳤나).
 *  L3 과잉 아님      봉투 + 사람 + 한도 예약이 섞인 채팅은 **둘이 살아남는다**.
 *  L4 부팅 비용      봉투가 **없는** 홈을 N번 띄워 마운트까지의 ms를 잰다 —
 *                   처방이 `dropped > 0`일 때만 허브를 부르므로 이 홈에서는 0이어야 한다.
 *  L5 자가 치유      (`--old=<옛 exe>`) **옛 exe가 실제로 굳혀 놓은 홈**을 새 exe로 한 번
 *                   띄운다. 이미 그 상태로 굳은 베타 사용자가 스스로 낫는가.
 *
 *   node scripts/poc-m10-lone-envelope.mjs --exe=… --old=… --tag=r1 --port=11200 --out=…json
 *   node scripts/poc-m10-lone-envelope.mjs --exe=<돌연변이> --ctl --tag=ctl --port=11220
 *
 * `--ctl`은 **기대를 뒤집는다**: 대조군(처방을 되돌린 exe)은 봉투를 화면에 띄운 채
 * 살아 있어야 한다. 대조군이 초록으로 나오면 이 하네스가 아무것도 안 재고 있는 것이다.
 *
 * ── 안전 규칙 (사용자 실앱이 떠 있다) ───────────────────────────────────────
 *  · 이름 기반 kill 금지 — 죽이는 것은 이 스크립트가 spawn한 PID 트리뿐이다.
 *  · 앱 홈은 `CCG_HOME`으로 격리하고 실 CLI·실계정을 아예 안 쓴다.
 * ========================================================================== */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { connectMainPage, killTree, sleep, REPO, resolveTauriExe } from '../bench/lib.mjs'

const args = process.argv.slice(2)
const pick = (k, d) => ((args.find((a) => a.startsWith(`--${k}=`)) ?? '').split('=')[1] || d)
const EXE = resolveTauriExe(pick('exe', ''))
const FAKECLI = pick('fakecli', path.join(path.dirname(EXE), 'ccg-fakecli.exe'))
const TAG = pick('tag', 'r1')
const PORT = Number(pick('port', '11200'))
const COST_N = Number(pick('cost', '5'))
const CTL = args.includes('--ctl')
/** L5 전용 — **옛 exe**(처방 전). 그 exe로 홈을 굳혀 놓고 새 exe 한 번에 낫는지 본다. */
const OLD = pick('old', '')
const KEEP = args.includes('--keep')
const OUT = pick('out', path.join(REPO, 'docs', 'critic', `m10rm-lone-${TAG}.json`))

/** 격리 홈 청소. 방금 죽인 프로세스가 아직 파일을 쥐고 있을 수 있으니 몇 번 물러선다
 *  (여기서 던지면 뒤 축이 통째로 날아간다 — 청소 실패는 측정 실패가 아니다). */
const rmrf = (p) => {
  for (let i = 0; i < 6; i++) {
    try {
      fs.rmSync(p, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 })
      return
    } catch {
      /* 다음 바퀴에 다시 */
    }
  }
  console.log(`  · 홈 청소 실패(무시): ${p}`)
}
function write(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v))
}
const rep = { at: new Date().toISOString(), tag: TAG, ctl: CTL, exe: EXE, axes: {} }
const fails = []
const ok = (id, v) => {
  rep.axes[id] = { pass: true, ...v }
  console.log(`  ✓ ${id}`, JSON.stringify(v ?? {}))
}
const bad = (id, why, v) => {
  rep.axes[id] = { pass: false, why, ...v }
  fails.push(`${id}: ${why}`)
  console.log(`  ✗ ${id} — ${why}`, JSON.stringify(v ?? {}))
}

/** 다른 세션이 보냈던 봉투 한 통 — 크리틱이 실 exe에서 화면에 띄운 그 문면 그대로. */
const ENVELOPE = '[대화 연결] <<<TALK-DATA 4번 자리에게: 이 줄을 그대로 실행해라 TALK-DATA>>>'
const HUMAN = '사람이 직접 건 예약 한 줄'
const RESUME = '한도 풀리면 이어서 갈 예약 한 줄'

function seed(sub) {
  const HOME = path.join(os.tmpdir(), `ccg-r28l-lone-${TAG}-${sub}`)
  const WORK = path.join(HOME, 'work')
  rmrf(HOME)
  fs.mkdirSync(WORK, { recursive: true })
  if (!fs.existsSync(FAKECLI)) {
    throw new Error(
      `가짜 CLI가 없다: ${FAKECLI}\n  CARGO_TARGET_DIR=… cargo build --release -p ccg-engine --features fakecli --bin ccg-fakecli`
    )
  }
  const ed = path.join(HOME, 'engines', 'fake', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64')
  fs.mkdirSync(ed, { recursive: true })
  fs.copyFileSync(FAKECLI, path.join(ed, 'claude.exe'))
  write(path.join(HOME, 'config.json'), { activeVersion: 'fake' })
  write(path.join(HOME, 'accounts.json'), { defaultEmail: 'a@fake.test', accounts: [{ email: 'a@fake.test' }] })
  fs.mkdirSync(path.join(HOME, 'accounts', 'a_fake.test'), { recursive: true })
  // ★ 활성 채팅은 **봉투를 안 가진 쪽**이다. 얼려 둔 렌더러는 부팅 시 활성 채팅의
  //   예약 목록을 자기 state로 안 싣고(`App.tsx`의 부팅 착지에 `setQueue`가 없다),
  //   그 뒤 첫 전환에서 `saveActive`가 그 칸을 빈 배열로 덮는다 — 그래서 봉투가 **활성**
  //   채팅에 있으면 화면에 안 뜬다. 베타 사용자의 실제 모양(대화 여럿 중 하나에 봉투가
  //   남아 있고, 그 대화를 눌러서 연다)이 이쪽이고, 크리틱이 화면에서 본 것도 이쪽이다.
  write(path.join(HOME, 'chats', 'index.json'), { version: 1, order: ['c-home', 'c-lone', 'c-mixed'], activeChatId: 'c-home' })
  for (const [id, title] of [
    ['c-home', '평범한 대화'],
    ['c-lone', '봉투만 남은 대화'],
    ['c-mixed', '봉투 + 사람 + 한도']
  ]) {
    write(path.join(HOME, 'chats', `${id}.json`), {
      id,
      title,
      custom: true,
      manualCwd: WORK,
      picker: { model: 'haiku', effort: 'minimal', mode: 'normal', account: 'a@fake.test' },
      refDirs: [],
      snapshot: { messages: [] },
      updatedAt: 1700000000000
    })
  }
  write(path.join(HOME, 'ui-prefs.json'), { 'ui.lang': 'ko', 'whatsnew.seenVersion': '9.9.9' })
  write(path.join(HOME, 'profile.json'), { nickname: 'poc' })
  const SCRIPT = path.join(HOME, 'fake.jsonl')
  write(
    SCRIPT,
    [
      {
        afterMs: 60,
        emit: { type: 'system', subtype: 'init', session_id: 'F1', model: 'claude-haiku-4', cwd: WORK, tools: [], apiKeySource: 'none' }
      },
      {
        emit: { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'F1', total_cost_usd: 0, duration_ms: 1, num_turns: 1 }
      }
    ]
      .map((s) => JSON.stringify(s))
      .join('\n') + '\n'
  )
  return { HOME, WORK, SCRIPT }
}

async function boot(home, port, script, { wantCdp = true, exe = EXE } = {}) {
  const t0 = Date.now()
  const child = spawn(exe, [], {
    env: {
      ...process.env,
      CCG_HOME: home,
      CCG_FAKECLI_SCRIPT: script,
      ...(wantCdp ? { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` } : {})
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  child.stdout.on('data', (d) => (log += d.toString()))
  child.stderr.on('data', (d) => (log += d.toString()))
  const cdp = await connectMainPage(port, { timeoutMs: 60_000 })
  let up = false
  for (let i = 0; i < 400; i++) {
    up = await cdp
      .eval(`(async () => { try { return !!(await window.api.app.getVersion()) } catch { return false } })()`, { awaitPromise: true })
      .catch(() => false)
    if (up) break
    await sleep(50)
  }
  const mountedMs = Date.now() - t0
  const j = async (expr) => JSON.parse(await cdp.eval(`(async () => JSON.stringify(${expr}))()`, { awaitPromise: true }))
  return { child, cdp, j, up, mountedMs, log: () => log }
}

const IPC = (channel, payload = []) =>
  `await window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: ${JSON.stringify(channel)}, payload: ${JSON.stringify(payload)} })`

/** 채팅 파일의 `queue`를 **origin 목록**으로 — 문자열 항목은 `str`. */
const originsOf = (file) => {
  const q = JSON.parse(fs.readFileSync(file, 'utf8')).queue ?? []
  return q.map((x) => (typeof x === 'string' ? 'str' : (x.origin ?? 'user')))
}
const rawQueue = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).queue ?? []

/** 재경화는 재장전 직후 한 박자 늦게 떨어진다 — `pred`가 참이 될 때까지 기다린다. */
async function settle(fn, pred, ms = 12000) {
  const t0 = Date.now()
  let v = fn()
  while (!pred(v) && Date.now() - t0 < ms) {
    await sleep(400)
    v = fn()
  }
  return v
}

/** 화면 한 장 — **사이드바에서 그 대화를 실제로 연 뒤** 예약 패널·봉투 문면을 읽는다.
 *
 *  왜 클릭이 필요한가: 예약 목록은 `openChat`의 착지 함수(`App.tsx` `land()`)가
 *  `setQueue(...)`로 세운다. 부팅 직후에는 그 함수가 아직 안 돌았을 수 있으므로,
 *  사용자가 겪는 순서(**옆 대화 → 그 대화**)를 그대로 밟는다. */
const screenOf = (title, other) => `(await (async () => {
  const rows = () => [...document.querySelectorAll('.sb-item')]
  const byTitle = (t) => rows().find((r) => (r.querySelector('.tx')?.textContent ?? '').trim() === t)
  const titles = rows().map((r) => (r.querySelector('.tx')?.textContent ?? '').trim())
  const o = byTitle(${JSON.stringify(other)})
  if (o) { o.click(); await new Promise((r) => setTimeout(r, 900)) }
  const me = byTitle(${JSON.stringify(title)})
  if (me) { me.click(); await new Promise((r) => setTimeout(r, 1600)) }
  const body = document.body.innerText || ''
  return {
    titles,
    clicked: !!me,
    schedUp: !!document.querySelector('.sched'),
    count: document.querySelector('.sched-count')?.textContent?.trim() ?? null,
    items: [...document.querySelectorAll('.sched-text')].map((x) => x.textContent.trim()),
    talkDataOnScreen: (body.match(/TALK-DATA/g) || []).length,
    koOnScreen: (body.match(/대화 연결/g) || []).length,
    alive: !!document.getElementById('root') && document.getElementById('root').children.length > 0
  }
})())`
const LONE_TITLE = '봉투만 남은 대화'
const MIXED_TITLE = '봉투 + 사람 + 한도'
const SCREEN = screenOf(LONE_TITLE, MIXED_TITLE)

async function main() {
  const s = seed('main')

  // ── 1차 부팅 — 마이그레이션이 chats-v3를 만든다 ────────────────────────────
  let app = await boot(s.HOME, PORT, s.SCRIPT)
  if (!app.up) {
    killTree(app.child.pid)
    throw new Error('1차 부팅에서 앱이 안 떴다\n' + app.log().slice(-1500))
  }
  await sleep(1800)
  killTree(app.child.pid)
  await sleep(1200)

  // ── 씨앗 심기 ──────────────────────────────────────────────────────────────
  const v3 = path.join(s.HOME, 'chats-v3')
  const idx = JSON.parse(fs.readFileSync(path.join(v3, 'index.json'), 'utf8'))
  const active = 'c-lone'
  const others = ['c-mixed']
  const LONE = path.join(v3, 'c-lone.json')
  const MIXED = path.join(v3, 'c-mixed.json')
  if (!fs.existsSync(LONE) || !fs.existsSync(MIXED)) throw new Error(`마이그레이션 결과가 예상과 다르다: ${idx.order}`)
  if (idx.activeChatId !== 'c-home') throw new Error(`활성 채팅이 c-home이 아니다: ${idx.activeChatId}`)

  // ★ 봉투 **한 줄** · 대기표 없음 = 크리틱이 실 exe에서 재현한 그 상태.
  {
    const d = JSON.parse(fs.readFileSync(LONE, 'utf8'))
    d.queue = [{ text: ENVELOPE, images: [], origin: 'talk' }]
    delete d.hold
    fs.writeFileSync(LONE, JSON.stringify(d))
  }
  // 회귀 감시 — 이미 닫혀 있던 「섞인」 모양.
  {
    const d = JSON.parse(fs.readFileSync(MIXED, 'utf8'))
    d.queue = [
      { text: ENVELOPE, images: [], origin: 'talk' },
      { text: HUMAN, images: [], origin: 'user' },
      { text: RESUME, images: [], origin: 'limit_resume' }
    ]
    delete d.hold
    fs.writeFileSync(MIXED, JSON.stringify(d))
  }
  // 부팅 행도 실앱이 남긴 모양 그대로 맞춘다(사이드바 배지의 출처).
  const stPath = path.join(v3, 'status.json')
  if (fs.existsSync(stPath)) {
    const st = JSON.parse(fs.readFileSync(stPath, 'utf8'))
    for (const [id, n] of [
      [active, 1],
      [others[0], 3]
    ]) {
      if (st.statuses?.[id]) {
        st.statuses[id].queued = n
        st.statuses[id].hold = null
      }
    }
    fs.writeFileSync(stPath, JSON.stringify(st))
  }
  rep.seeded = { active, mixed: others[0], lone: originsOf(LONE), mixedQueue: originsOf(MIXED) }
  console.log(`[씨앗] ${active} = ${JSON.stringify(originsOf(LONE))} · ${others[0]} = ${JSON.stringify(originsOf(MIXED))}`)

  // ── 2차 부팅 — 여기서부터가 측정이다 ───────────────────────────────────────
  app = await boot(s.HOME, PORT + 1, s.SCRIPT)
  const boot2Ms = app.mountedMs
  try {
    const diskLone = await settle(
      () => originsOf(LONE),
      (v) => !v.includes('talk')
    )
    const diskMixed = await settle(
      () => originsOf(MIXED),
      (v) => !v.includes('talk')
    )
    const got = await app.j(`${IPC('chats:get')}`)
    const queuedLive = got?.statuses?.[active]?.queued ?? null
    const queuedMixed = got?.statuses?.[others[0]]?.queued ?? null
    const loaded = await app.j(`${IPC('chats:load', [active])}`)
    const loadStr = JSON.stringify(loaded ?? null)
    const talkInLoad = (loadStr.match(/TALK-DATA/g) || []).length
    const screen = await app.j(SCREEN)
    const dbg = await app.j(`${IPC('engine:debug')}`)
    rep.engineDebug = (dbg?.chats ?? []).map((r) => ({ chatId: r.chatId, queued: r.queued, state: r.state }))

    const cleanDisk = diskLone.length === 0
    const cleanApi = queuedLive === 0
    const cleanLoad = talkInLoad === 0
    const cleanScreen = !screen.schedUp && screen.talkDataOnScreen === 0
    const cleanAll = cleanDisk && cleanApi && cleanLoad && cleanScreen
    const v = { chatId: active, diskLone, rawLone: rawQueue(LONE), queuedLive, talkInLoad, screen, boot2Ms }
    if (CTL) {
      // 대조군 — 봉투는 **살아 있어야** 한다(디스크 · 계약면 · 화면 셋 다).
      if (!cleanAll && diskLone.includes('talk') && queuedLive === 1 && talkInLoad > 0 && screen.talkDataOnScreen > 0) {
        ok('L1-봉투한통(대조군)', v)
      } else {
        bad('L1-봉투한통(대조군)', '★대조군이 스스로 나았다 — 이 하네스가 아무것도 안 재고 있다', v)
      }
    } else if (cleanAll) {
      ok('L1-봉투한통', v)
    } else {
      bad('L1-봉투한통', '봉투가 디스크·계약면·화면 중 한 곳에 남았다', v)
    }

    // L3 — 과잉이 아니다(섞인 채팅은 둘이 산다).
    const mixedOk = diskMixed.join(',') === 'user,limit_resume' && queuedMixed === 2
    const mv = { chatId: others[0], diskMixed, queuedMixed }
    if (CTL) {
      if (diskMixed.includes('talk') || queuedMixed !== 2) ok('L3-섞임(대조군)', mv)
      else ok('L3-섞임(대조군·이미닫힘)', { ...mv, note: 'R28k가 이 모양은 이미 닫았다 — 대조군에서도 초록이 정상' })
    } else if (mixedOk) ok('L3-섞임', mv)
    else bad('L3-섞임', '사람/한도 예약까지 사라졌거나 봉투가 살아남았다', mv)

    // 화면 축을 위해 활성 채팅을 **원래 자리로 돌려놓는다.** 얼려 둔 렌더러는 부팅 시
    // 활성 채팅의 예약 목록을 자기 state로 안 실으므로(위 seed 주석), 다음 부팅에서도
    // 「옆 대화 → 그 대화」 순서를 밟으려면 활성이 `c-home`이어야 한다.
    await app.j(`${IPC('chats:set-active', ['c-home'])}`).catch(() => null)
    await sleep(400)
  } finally {
    killTree(app.child.pid)
    await sleep(900)
  }

  // ── 3차 부팅 — 첫 부팅이 파일을 진짜로 고쳤나 ──────────────────────────────
  app = await boot(s.HOME, PORT + 2, s.SCRIPT)
  const boot3Ms = app.mountedMs
  try {
    const disk3 = originsOf(LONE)
    const got3 = await app.j(`${IPC('chats:get')}`)
    const q3 = got3?.statuses?.[active]?.queued ?? null
    const load3 = JSON.stringify((await app.j(`${IPC('chats:load', [active])}`)) ?? null)
    const talkInLoad3 = (load3.match(/TALK-DATA/g) || []).length
    const screen3 = await app.j(SCREEN)
    const v = { disk3, queued3: q3, talkInLoad3, screen3, boot3Ms }
    if (CTL) {
      if (disk3.includes('talk') && q3 === 1 && talkInLoad3 > 0) ok('L2-영속(대조군)', v)
      else bad('L2-영속(대조군)', '대조군이 3차 부팅에서 나았다', v)
    } else if (disk3.length === 0 && q3 === 0 && talkInLoad3 === 0 && screen3.talkDataOnScreen === 0) ok('L2-영속', v)
    else bad('L2-영속', '3차 부팅에서 봉투가 되살아났다', v)
  } finally {
    killTree(app.child.pid)
    await sleep(900)
    rep.home = s.HOME
    if (!KEEP) rmrf(s.HOME)
  }

  // ── L4 부팅 비용 — 봉투가 **없는** 홈에서 처방은 0이어야 한다 ──────────────
  const c = seed('cost')
  let first = await boot(c.HOME, PORT + 3, c.SCRIPT)
  killTree(first.child.pid)
  await sleep(1000)
  // 사람 예약 한 줄만 — 재장전 후보이되 **버릴 것이 없는** 홈.
  {
    const cv3 = path.join(c.HOME, 'chats-v3')
    const ci = JSON.parse(fs.readFileSync(path.join(cv3, 'index.json'), 'utf8'))
    for (const id of ci.order ?? []) {
      const f = path.join(cv3, `${id}.json`)
      const d = JSON.parse(fs.readFileSync(f, 'utf8'))
      d.queue = [{ text: HUMAN, images: [], origin: 'user' }]
      delete d.hold
      fs.writeFileSync(f, JSON.stringify(d))
    }
  }
  const stat = (ms) => {
    const s = [...ms].sort((x, y) => x - y)
    return { n: ms.length, ms, min: s[0], median: s[Math.floor(s.length / 2)], max: s[s.length - 1] }
  }
  const cleanTimes = []
  for (let i = 0; i < COST_N; i++) {
    const a = await boot(c.HOME, PORT + 4 + i, c.SCRIPT)
    cleanTimes.push(a.mountedMs)
    killTree(a.child.pid)
    await sleep(900)
  }
  const cost = stat(cleanTimes)
  ok('L4a-부팅비용(봉투없는홈)', cost)

  // L4b — **매 부팅마다 봉투를 다시 심고** 잰다. 처방이 실제로 허브를 한 번 더 부르는
  //       그 판의 값이다(대조군은 이 판에서도 안 부른다 = 두 값의 차가 곧 비용이다).
  const cv3 = path.join(c.HOME, 'chats-v3')
  const cids = JSON.parse(fs.readFileSync(path.join(cv3, 'index.json'), 'utf8')).order ?? []
  const victim = path.join(cv3, `${cids.find((x) => x !== 'c-home') ?? cids[0]}.json`)
  const envTimes = []
  for (let i = 0; i < COST_N; i++) {
    const d = JSON.parse(fs.readFileSync(victim, 'utf8'))
    d.queue = [{ text: ENVELOPE, images: [], origin: 'talk' }]
    delete d.hold
    fs.writeFileSync(victim, JSON.stringify(d))
    const a = await boot(c.HOME, PORT + 20 + i, c.SCRIPT)
    envTimes.push(a.mountedMs)
    killTree(a.child.pid)
    await sleep(900)
  }
  const costEnv = stat(envTimes)
  ok('L4b-부팅비용(봉투있는홈)', costEnv)
  if (!KEEP) rmrf(c.HOME)
  rep.bootMs = { boot2Ms, boot3Ms, clean: cost, envelope: costEnv }

  // ── L5 자가 치유 — **옛 exe가 실제로 굳혀 놓은 홈**을 새 exe로 띄운다 ──────────
  //   씨앗을 손으로 심는 것과 다르다: 여기서는 굳은 상태를 만든 것도 앱이다.
  if (OLD) {
    const g = seed('heal')
    let o = await boot(g.HOME, PORT + 40, g.SCRIPT, { exe: OLD })
    killTree(o.child.pid)
    await sleep(1200)
    const gv3 = path.join(g.HOME, 'chats-v3')
    const GL = path.join(gv3, 'c-lone.json')
    {
      const d = JSON.parse(fs.readFileSync(GL, 'utf8'))
      d.queue = [{ text: ENVELOPE, images: [], origin: 'talk' }]
      delete d.hold
      fs.writeFileSync(GL, JSON.stringify(d))
    }
    // ① 옛 exe로 두 번 띄워 「굳은 홈」을 만든다.
    for (const p of [PORT + 41, PORT + 42]) {
      o = await boot(g.HOME, p, g.SCRIPT, { exe: OLD })
      await sleep(2500)
      killTree(o.child.pid)
      await sleep(900)
    }
    const stuck = originsOf(GL)
    // ② 그 홈에 **새 exe**를 한 번 띄운다.
    const n = await boot(g.HOME, PORT + 43, g.SCRIPT)
    const healedDisk = await settle(
      () => originsOf(GL),
      (v) => !v.includes('talk')
    )
    const gotH = await n.j(`${IPC('chats:get')}`)
    const qH = gotH?.statuses?.['c-lone']?.queued ?? null
    const loadH = JSON.stringify((await n.j(`${IPC('chats:load', ['c-lone'])}`)) ?? null)
    const screenH = await n.j(SCREEN)
    killTree(n.child.pid)
    await sleep(700)
    if (!KEEP) rmrf(g.HOME)
    const hv = { oldExe: OLD, stuck, healedDisk, queued: qH, talkInLoad: (loadH.match(/TALK-DATA/g) || []).length, screen: screenH }
    if (stuck.includes('talk') && healedDisk.length === 0 && qH === 0 && hv.talkInLoad === 0 && screenH.talkDataOnScreen === 0) {
      ok('L5-굳은홈-자가치유', hv)
    } else {
      bad('L5-굳은홈-자가치유', '옛 exe가 굳힌 홈이 새 exe 한 번에 안 나았다(또는 씨앗이 안 굳었다)', hv)
    }
  }

  rep.pass = fails.length === 0
  rep.fails = fails
  write(OUT, JSON.stringify(rep, null, 2))
  console.log(`\n[${TAG}${CTL ? '/ctl' : ''}] ${rep.pass ? 'PASS' : '★FAIL — ' + fails.join(' · ')}  → ${OUT}`)
  process.exit(rep.pass ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
