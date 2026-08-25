#!/usr/bin/env node
/* ============================================================================
 * critic-m10-r6-bytes — **「꺼짐이 진짜 꺼짐」을 stdin 바이트로 잰다**.
 *
 * R6의 발신 배선(Land 단계, 커밋 `be308fa`)이 세운 주장은 하나다:
 *
 *   > 대화 연결이 꺼진 보드에서는 CLI에 들어가는 **프롬프트 바이트가 0 변한다.**
 *
 * 이건 코드 대조로 「`None`이 흘러가는 사슬」을 따라가는 것으로는 절반만 닫힌다.
 * 마지막 한 뼘 — `initialize` 프레임이 실제로 무엇을 싣고 stdin으로 나가는가 — 은
 * **프로세스 밖에서 재야** 한다. 그래서 가짜 CLI(`ccg-fakecli.exe`)의 `CCG_FAKECLI_IN`
 * 을 쓴다: 그 스텁은 받은 stdin 줄을 **한 글자도 안 고치고** 파일에 덧붙인다.
 *
 * ── 세 축 ───────────────────────────────────────────────────────────────────
 *  B1 꺼진 보드 vs 켠 보드   같은 씨앗·같은 프롬프트로 홈 둘을 돌리고 `initialize`
 *                           프레임을 **바이트로 비교**한다. 꺼진 쪽은 `systemPrompt`
 *                           키가 **없어야** 한다(빈 문자열이 아니라 키의 부재 —
 *                           빈 문자열을 실으면 CLI의 `claude_code` 프리셋이 죽는다).
 *  B2 전역만 켬             전역 스위치만 켜고 보드는 옵트인 안 한 상태. 이것도 꺼짐과
 *                           **바이트가 같아야** 한다(게이트가 둘 다 참을 요구하는가).
 *  B3 껐다 되돌림           한 홈에서 켠 뒤 다시 끄면 상주 CLI가 재스폰되고 **두 번째
 *                           `initialize`가 꺼짐 기준선과 바이트로 같은가**. 도는 CLI가
 *                           계속 통로를 알고 있으면 「끔」은 UI 문구일 뿐이다.
 *
 * 판정은 전부 **문자열 동등**이다. 「비슷하다」로는 이 성질을 못 잰다.
 *
 *   node scripts/critic-m10-r6-bytes.mjs --exe=... --fakecli=... --out=docs/critic/x.json
 *
 * ── 안전 규칙 (사용자 실앱이 떠 있다) ───────────────────────────────────────
 *  · 이름 기반 kill 금지 — 죽이는 것은 이 스크립트가 spawn한 PID 트리뿐이다.
 *  · 실 CLI·실계정을 **아예 안 쓴다**(가짜 CLI · $0 · 네트워크 없음).
 *  · 앱 홈은 전부 `CCG_HOME`으로 격리.
 * ========================================================================== */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { connectMainPage, killTree, sleep, REPO, resolveTauriExe } from '../bench/lib.mjs'

const args = process.argv.slice(2)
const EXE = resolveTauriExe((args.find((a) => a.startsWith('--exe=')) ?? '').split('=')[1])
const FAKECLI =
  (args.find((a) => a.startsWith('--fakecli=')) ?? '').split('=')[1] ||
  path.join(path.dirname(EXE), 'ccg-fakecli.exe')
const KEEP = args.includes('--keep')
const TAG = (args.find((a) => a.startsWith('--tag=')) ?? '').split('=')[1] || 'r6bytes'
const PORT0 = Number((args.find((a) => a.startsWith('--port=')) ?? '').split('=')[1] || 10560)
const OUT =
  (args.find((a) => a.startsWith('--out=')) ?? '').split('=')[1] ||
  path.join(REPO, 'docs', 'critic', `m10-r6-bytes-${TAG}.json`)

const rep = { at: new Date().toISOString(), exe: EXE, fakecli: FAKECLI, axes: {}, broken: [] }
const broke = (id, why, extra) => {
  rep.broken.push({ id, why, ...(extra ?? {}) })
  console.error(`  X ${id} — ${why}${extra === undefined ? '' : ' ' + JSON.stringify(extra).slice(0, 600)}`)
}
const held = (id, v) => console.log(`  o ${id}${v === undefined ? '' : ' — ' + JSON.stringify(v).slice(0, 400)}`)

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

// ── 앱 부팅 (poc-talk와 같은 규약) ──────────────────────────────────────────
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

async function waitFor(fn, ms, every = 200) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn().catch(() => null)
    if (v) return v
    if (Date.now() - t0 > ms) return null
    await sleep(every)
  }
}

// ── 씨앗 ────────────────────────────────────────────────────────────────────
/**
 * 두 홈이 **`talk-config.json` 한 파일만 빼고 똑같아야** 이 측정이 뜻을 가진다.
 * 그래서 씨앗은 하나의 함수이고, 다른 점은 인자 `talk` 하나뿐이다.
 */
function seed(name, talk) {
  const HOME = path.join(REPO, `.crit-home-m10r6b-${TAG}-${name}`)
  const WORK = path.join(HOME, 'work')
  rmrf(HOME)
  fs.mkdirSync(WORK, { recursive: true })
  if (!fs.existsSync(FAKECLI)) {
    throw new Error(`가짜 CLI가 없다: ${FAKECLI}\n  cargo build -p ccg-engine --features fakecli --bin ccg-fakecli --release`)
  }
  const enginedir = path.join(HOME, 'engines', 'fake', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64')
  fs.mkdirSync(enginedir, { recursive: true })
  fs.copyFileSync(FAKECLI, path.join(enginedir, 'claude.exe'))
  write(path.join(HOME, 'config.json'), { activeVersion: 'fake' })
  write(path.join(HOME, 'accounts.json'), {
    defaultEmail: 'a@fake.test',
    accounts: [{ email: 'a@fake.test' }, { email: 'b@fake.test' }]
  })
  fs.mkdirSync(path.join(HOME, 'accounts', 'a_fake.test'), { recursive: true })
  fs.mkdirSync(path.join(HOME, 'accounts', 'b_fake.test'), { recursive: true })
  write(path.join(HOME, 'chats', 'index.json'), { version: 1, order: ['c-a', 'c-b'], activeChatId: 'c-a' })
  for (const [id, title, acct] of [
    ['c-a', '설계', 'a@fake.test'],
    ['c-b', '구현', 'b@fake.test']
  ]) {
    write(path.join(HOME, 'chats', `${id}.json`), {
      id,
      title,
      custom: true,
      manualCwd: WORK,
      picker: { model: 'haiku', effort: 'minimal', mode: 'normal', account: acct },
      refDirs: [],
      snapshot: { messages: [] },
      updatedAt: 1700000000000
    })
  }
  write(path.join(HOME, 'ui-prefs.json'), { 'ui.lang': 'ko' })
  write(path.join(HOME, 'profile.json'), { nickname: 'crit' })
  if (talk) write(path.join(HOME, 'talk-config.json'), talk)

  const SCRIPT = path.join(HOME, 'fake.jsonl')
  const script = (sid, text) =>
    [
      { afterMs: 80, emit: { type: 'system', subtype: 'init', session_id: sid, model: 'claude-haiku-4', cwd: WORK, tools: [], apiKeySource: 'none' } },
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
  write(SCRIPT, script('FAKE-X', '대본 없음'))
  // 발신 구문을 **쓰지 않는** 대본이다 — 이 하네스가 재는 것은 라우팅이 아니라 바이트다.
  write(path.join(HOME, 'fake.a_fake.test.jsonl'), script('FAKE-A', '확인했습니다.'))
  write(path.join(HOME, 'fake.b_fake.test.jsonl'), script('FAKE-B', '확인했습니다.'))
  const IN = path.join(HOME, 'stdin.log')
  return { HOME, WORK, SCRIPT, IN }
}

async function installBoard(app) {
  const got = await app.call('chats:get', [{ light: true }])
  const byTitle = (t) => (got?.chats ?? []).find((c) => c.title === t)?.id
  const a = byTitle('설계')
  const b = byTitle('구현')
  if (!a || !b) throw new Error(`채팅을 못 찾았다: ${JSON.stringify((got?.chats ?? []).map((c) => [c.id, c.title]))}`)
  await app.call('board:save', [
    {
      version: 1,
      activeBoardId: 'b-1',
      boards: [
        { id: 'b-1', title: '협업 보드', custom: true, count: 2, chrome: 'grid', order: [0, 1, 2, 3, 4, 5], slots: [a, b, null, null, null, null], updatedAt: 1700000000000 }
      ]
    }
  ])
  return { a, b }
}

/** stdin 로그에서 `initialize` 컨트롤 요청 줄들만(원문 바이트 그대로). */
function initFrames(inPath) {
  let raw = ''
  try {
    raw = fs.readFileSync(inPath, 'utf8')
  } catch {
    return []
  }
  return raw
    .split(/\r?\n/)
    .filter((l) => l.includes('"subtype":"initialize"'))
}

const PROMPT = '한 문장으로만 답해라. 지금 무엇을 맡고 있나?'

/** stdin 로그의 **사용자 프레임**(턴 하나가 실제로 CLI에 들어간 증거 · ★R28h R7 B6). */
function userFrames(inPath) {
  let raw = ''
  try {
    raw = fs.readFileSync(inPath, 'utf8')
  } catch {
    return []
  }
  return raw.split(/\r?\n/).filter((l) => l.includes('"type":"user"'))
}

/** 홈 하나를 돌려 `initialize` 프레임을 받아 온다. */
async function runOne(name, talk, port) {
  const s = seed(name, talk)
  const app = await boot(s.HOME, port, { CCG_FAKECLI_SCRIPT: s.SCRIPT, CCG_FAKECLI_IN: s.IN })
  const out = { home: s.HOME }
  try {
    await armEvents(app)
    const { a: A } = await installBoard(app)
    out.chats = { A }
    out.cfg = await app.call('crosstalk:config', [])
    await app.call('chat:run', [{ chatId: A, prompt: PROMPT }])
    await waitFor(async () => (await events(app, A)).find((e) => e?.type === 'assistant-done'), 60_000)
    await sleep(600)
    out.frames = initFrames(s.IN)
    out.stdinAll = (() => {
      try {
        return fs.readFileSync(s.IN, 'utf8')
      } catch {
        return ''
      }
    })()
  } finally {
    killTree(app.child.pid)
    await sleep(900)
    if (!KEEP) rmrf(s.HOME)
  }
  return out
}

// ── B1 · B2 — 꺼짐 / 전역만 / 켬 ───────────────────────────────────────────
const ON = { version: 1, enabled: true, boards: { 'b-1': true }, maxHops: 2, maxMsgs: 6, maxFanout: 2 }
const GLOBAL_ONLY = { version: 1, enabled: true, boards: {}, maxHops: 2, maxMsgs: 6, maxFanout: 2 }

async function axisOnOff() {
  console.log('\n[B1·B2] 꺼짐 vs 전역만 vs 켬 — `initialize` 바이트')
  const off = await runOne('off', null, PORT0)
  const glob = await runOne('globalonly', GLOBAL_ONLY, PORT0 + 1)
  const on = await runOne('on', ON, PORT0 + 2)
  const A = { off: off.frames, globalOnly: glob.frames, on: on.frames }
  rep.axes.b1 = {
    off: { cfg: off.cfg, frames: off.frames },
    globalOnly: { cfg: glob.cfg, frames: glob.frames },
    on: { cfg: on.cfg, frames: on.frames }
  }
  for (const [k, v] of Object.entries(A)) {
    if (v.length !== 1) {
      broke('B0-표본', `${k}: initialize 프레임이 1개가 아니다 (${v.length})`, { frames: v.slice(0, 2) })
      return
    }
  }
  const offF = A.off[0]
  const globF = A.globalOnly[0]
  const onF = A.on[0]
  rep.axes.b1.bytes = {
    off: Buffer.byteLength(offF, 'utf8'),
    globalOnly: Buffer.byteLength(globF, 'utf8'),
    on: Buffer.byteLength(onF, 'utf8')
  }

  // ① 꺼진 보드 — `systemPrompt` **키가 없다**(빈 문자열이 아니다).
  const offHasKey = offF.includes('"systemPrompt"')
  if (offHasKey) broke('B1-꺼짐', '꺼진 보드의 initialize에 systemPrompt 키가 있다', { off: offF.slice(0, 400) })
  else held('B1-꺼짐', { systemPromptKey: false, bytes: rep.axes.b1.bytes.off })

  // ② 전역만 켬 — 꺼짐과 **바이트로 같다**.
  if (globF !== offF) broke('B2-전역만', '전역만 켰는데 프롬프트 바이트가 변했다', { off: offF.slice(0, 300), globalOnly: globF.slice(0, 300) })
  else held('B2-전역만', { identicalToOff: true })

  // ③ 켠 보드 — 실제로 **달라야** 한다(안 변하면 배선이 사문이다).
  if (onF === offF) broke('B3-켬', '보드를 켰는데 프롬프트 바이트가 그대로다 — 안내가 CLI에 안 닿았다', { on: onF.slice(0, 300) })
  else if (!onF.includes('[대화 연결]')) broke('B3-켬', '켠 보드의 initialize에 대화 연결 안내가 없다', { on: onF.slice(0, 400) })
  else
    held('B3-켬', {
      systemPromptKey: true,
      bytes: rep.axes.b1.bytes.on,
      delta: rep.axes.b1.bytes.on - rep.axes.b1.bytes.off
    })

  // ④ **꺼짐의 나머지 바이트가 켬의 부분집합인가** — 켬은 오직 systemPrompt만 더한 것이어야 한다.
  try {
    const o = JSON.parse(offF)
    const n = JSON.parse(onF)
    const { systemPrompt, ...restOn } = n.request ?? {}
    const same = JSON.stringify({ ...n, request: restOn }) === JSON.stringify(o)
    rep.axes.b1.onlyDelta = same
    if (!same) broke('B4-델타', '켬/꺼짐의 차이가 systemPrompt 하나가 아니다', { off: offF.slice(0, 300), on: JSON.stringify({ ...n, request: restOn }).slice(0, 300) })
    else held('B4-델타', { onlyAddedKey: 'systemPrompt' })
    rep.axes.b1.appendPreview = String(systemPrompt?.append ?? '').slice(0, 200)
    rep.axes.b1.preset = systemPrompt?.preset ?? null
  } catch (e) {
    broke('B4-델타', `프레임 파싱 실패: ${e?.message ?? e}`)
  }
}

// ── B5 — 껐다 되돌림(같은 홈 · 상주 CLI) ────────────────────────────────────
/**
 * 켠 뒤 다시 끄면 **상주 CLI가 재스폰**되고, 두 번째 `initialize`가 꺼짐 기준선과
 * 바이트로 같아야 한다. 안 그러면 「끔」은 UI 문구일 뿐 도는 CLI는 계속 통로를 안다.
 */
async function axisToggleBack() {
  console.log('\n[B5] 켰다 끄기 — 상주 CLI가 통로를 잊는가')
  const s = seed('toggle', ON)
  const app = await boot(s.HOME, PORT0 + 3, { CCG_FAKECLI_SCRIPT: s.SCRIPT, CCG_FAKECLI_IN: s.IN })
  const out = { home: s.HOME }
  try {
    await armEvents(app)
    const { a: A } = await installBoard(app)
    await app.call('chat:run', [{ chatId: A, prompt: PROMPT }])
    await waitFor(async () => (await events(app, A)).find((e) => e?.type === 'assistant-done'), 60_000)
    await sleep(500)
    out.afterOn = initFrames(s.IN)

    // 보드를 끈다 — 그리고 **같은 채팅**에 다시 말을 건다.
    out.cfgOff = await app.call('crosstalk:set', [{ board: 'b-1', on: false }])
    await app.call('chat:run', [{ chatId: A, prompt: PROMPT }])
    await sleep(4000)
    out.afterOff = initFrames(s.IN)
    rep.axes.b5 = out

    if (out.afterOn.length !== 1) {
      broke('B5-표본', `켠 뒤 initialize가 1개가 아니다 (${out.afterOn.length})`)
      return
    }
    if (out.afterOff.length < 2) {
      broke('B5-재스폰', `보드를 껐는데 재스폰이 없다 — initialize 총 ${out.afterOff.length}개(상주 CLI가 통로를 계속 안다)`, {
        frames: out.afterOff.map((f) => f.slice(0, 160))
      })
      return
    }
    const second = out.afterOff[out.afterOff.length - 1]
    if (second.includes('"systemPrompt"')) {
      broke('B5-되돌림', '보드를 껐는데 재스폰된 initialize가 아직 systemPrompt를 싣는다', { second: second.slice(0, 400) })
    } else {
      held('B5-되돌림', { respawned: true, secondHasSystemPrompt: false, initCount: out.afterOff.length })
    }
    // 꺼짐 기준선과 **바이트로 같은가**(B1의 off 프레임).
    const base = rep.axes.b1?.off?.frames?.[0]
    if (base) {
      rep.axes.b5.identicalToColdOff = second === base
      if (second !== base) broke('B5-기준선', '재스폰된 프레임이 콜드 꺼짐 기준선과 바이트로 다르다', { base: base.slice(0, 300), second: second.slice(0, 300) })
      else held('B5-기준선', { identicalToColdOff: true })
    }
  } finally {
    killTree(app.child.pid)
    await sleep(900)
    if (!KEEP) rmrf(s.HOME)
  }
}

/**
 * ★R28h R7 (확인 크리틱 R2 **E-1**) — **끄기 전에 이미 큐에 앉은 턴은 「꺼짐」을 못 본다.**
 *
 * B5가 닫은 것은 「끈 **뒤에** 사람이 다시 말을 걸면」이다. 그 자리는 `hub.rs:695`가
 * `Op::Run`/`Op::Enqueue`에서 안내를 다시 계산하므로 `reuse_decision`이 돌고 CLI가
 * 재스폰된다. 그런데 **순서가 반대면** 그 계산이 아예 안 걸린다:
 *
 *   ① 사람이 A에 전송(턴 1이 돈다 · 안내 1454B가 실린 채)
 *   ② 사람이 A에 **예약**(그 순간에도 보드는 켜져 있으니 안내는 그대로)
 *   ③ 사람이 보드를 **끈다**(또는 긴급 정지)
 *   ④ 턴 1이 끝나고 큐가 드레인된다 — `spawn_guide == talk_guide`라 **재사용**이고,
 *      그 턴은 1454바이트 안내를 실은 스트림에서 그대로 돈다.
 *
 * 배달은 라우터가 막는다(`no_board`/`stopped` — 수신 봉투 0). 새는 것은 바이트와
 * **모델의 믿음**이지 메시지가 아니다. 그래도 `runtime.rs:297-299`가 스스로 *"보드를
 * 껐는데 도는 CLI가 계속 그 통로를 알고 있으면 「꺼짐이 진짜 꺼짐」이 아니다"* 라고 못
 * 박은 바로 그 칸이다.
 *
 * ★이 축은 **재는 것뿐이고 고치지 않는다.** 처방이 `hub.rs`(안내 재계산의 자리)나
 * `runtime.rs`(재사용 판정)에 있는데 둘 다 이 라운드의 소유가 아니다 — `talk.rs`의
 * `guide_for`는 값을 만들 뿐 **언제 다시 만들지를 못 정한다**(`Op::TalkConfig`·`Op::TalkStop`은
 * `ensure()` **앞에서** 답하고 끝나 슬롯 런타임에 닿지 않는다). 그래서 여기 계기만 세운다.
 */
async function axisQueuedBeforeOff() {
  console.log('\n[B6] 큐에 앉은 뒤 끄기 — 그 턴은 「꺼짐」을 보는가 (E-1)')
  // 턴 1을 **느리게** 만들어야 ②가 큐에 앉는다(끝나 버리면 예약이 아니라 즉시 실행이다).
  const slow = (HOME, WORK) => {
    const lines = [
      { afterMs: 80, emit: { type: 'system', subtype: 'init', session_id: 'FAKE-A', model: 'claude-haiku-4', cwd: WORK, tools: [], apiKeySource: 'none' } },
      { afterMs: 5000, emit: { type: 'assistant', session_id: 'FAKE-A', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: '확인했습니다.' }], usage: { input_tokens: 7 } } } },
      { emit: { type: 'result', subtype: 'success', is_error: false, result: '확인했습니다.', session_id: 'FAKE-A', total_cost_usd: 0, duration_ms: 1, num_turns: 1 } }
    ]
    write(path.join(HOME, 'fake.a_fake.test.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  }
  /** `order`: 'queue-then-off'(재현) · 'off-then-queue'(대조 — B5와 같은 순서) · 'stop'(긴급 정지판) */
  const one = async (order, port) => {
    const s = seed(`b6-${order}`, ON)
    slow(s.HOME, s.WORK)
    const app = await boot(s.HOME, port, { CCG_FAKECLI_SCRIPT: s.SCRIPT, CCG_FAKECLI_IN: s.IN })
    const out = { order, home: s.HOME }
    try {
      await armEvents(app)
      const { a: A } = await installBoard(app)
      await app.call('chat:run', [{ chatId: A, prompt: PROMPT }])
      await sleep(1200) // 턴 1이 도는 중
      const enq = async () => await app.call('chat:queue-mutate', [{ chatId: A, op: 'enqueue', text: PROMPT + ' (예약)' }])
      const kill = async () =>
        order === 'stop' ? await app.call('crosstalk:stop', []) : await app.call('crosstalk:set', [{ board: 'b-1', on: false }])
      if (order === 'off-then-queue') {
        out.off = await kill()
        await sleep(300)
        out.enq = await enq()
      } else {
        out.enq = await enq()
        await sleep(300)
        out.off = await kill()
      }
      // 두 턴이 다 나갈 때까지 — **이벤트 버스가 아니라 stdin으로** 센다. 재는 것이
      // 「CLI에 실제로 들어간 바이트」이므로 완주 판정도 같은 자리에서 나와야 한다
      // (렌더러 이벤트는 예약 드레인에 대해 항상 말풍선을 내지는 않는다 — 실측).
      await waitFor(async () => userFrames(s.IN).length >= 2, 60_000)
      // 그리고 **프레임 수가 멎을 때까지** 기다린다. 대조군은 재스폰이 한 박자 늦게
      // 오는데(끔 → 다음 스폰), 고정 유예로 끊으면 그 프레임을 놓쳐 대조가 무너진다.
      for (let i = 0, stable = 0, last = -1; i < 60 && stable < 4; i++) {
        const n = initFrames(s.IN).length
        stable = n === last ? stable + 1 : 0
        last = n
        await sleep(400)
      }
      out.frames = initFrames(s.IN)
      out.userFrames = userFrames(s.IN).length
      out.userEchoes = (await events(app, A)).filter((e) => e?.type === 'user-echo').length
      out.withGuide = out.frames.filter((f) => f.includes('"systemPrompt"')).length
      out.bytes = out.frames.map((f) => Buffer.byteLength(f, 'utf8'))
    } finally {
      killTree(app.child.pid)
      await sleep(900)
      if (!KEEP) rmrf(s.HOME)
    }
    return out
  }

  const ctl = await one('off-then-queue', PORT0 + 4)
  const bad = await one('queue-then-off', PORT0 + 5)
  const stop = await one('stop', PORT0 + 6)
  rep.axes.b6 = { control: ctl, repro: bad, emergencyStop: stop }

  // 대조군 — 끄고 나서 예약하면 두 번째 프레임에 안내가 **없다**(B5와 같은 결론).
  if (ctl.userFrames >= 2 && ctl.frames.length >= 2 && !ctl.frames[ctl.frames.length - 1].includes('"systemPrompt"')) {
    held('B6-대조(끄고 예약)', { initCount: ctl.frames.length, withGuide: ctl.withGuide, bytes: ctl.bytes, userFrames: ctl.userFrames })
  } else {
    broke('B6-대조(끄고 예약)', '대조군이 성립 안 했다 — 이 축의 재현 판정을 믿을 수 없다', { frames: ctl.frames.map((f) => f.slice(0, 120)) })
  }
  // 재현 — 예약하고 끄면 재스폰이 없고 그 턴은 안내를 안은 채 돈다.
  for (const [label, r] of [
    ['B6-재현(예약하고 끄기)', bad],
    ['B6-재현(예약하고 긴급정지)', stop]
  ]) {
    if (r.userFrames < 2) {
      broke(label, `예약 턴이 안 돌았다 — 표본 미성립(user 프레임 ${r.userFrames})`, { frames: r.frames.length })
    } else if (r.frames.length === 1 && r.withGuide === 1) {
      // **이것이 E-1이다.** 실패로 센다(고칠 자리가 남의 파일이라도 결함은 결함이다).
      broke(label, '예약 턴이 안내를 안은 채 돌았다 — 「꺼짐」을 못 봤다(E-1)', {
        initCount: r.frames.length,
        withGuide: r.withGuide,
        bytes: r.bytes,
        userFrames: r.userFrames
      })
    } else {
      held(label, { initCount: r.frames.length, withGuide: r.withGuide, bytes: r.bytes, userFrames: r.userFrames })
    }
  }
}

await axisOnOff()
await axisToggleBack()
await axisQueuedBeforeOff()

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(rep, null, 2))
console.log(`\n산출물: ${OUT}`)
console.log(rep.broken.length === 0 ? '판정: HELD (전 축 초록)' : `판정: BROKEN ${rep.broken.length}건`)
process.exit(rep.broken.length === 0 ? 0 : 1)
