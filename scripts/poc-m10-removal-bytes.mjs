#!/usr/bin/env node
/* ============================================================================
 * poc-m10-removal-bytes — **M10을 들어내면서 프롬프트 바이트가 안 변했음을 잰다.**
 *
 * R28k는 대화 연결(M10)을 통째로 제거한다. 그런데 그 배선을 얹은 R28f/R6이 같은
 * 자리에서 **파리티 수선** 하나를 함께 얹었다: `initialize` 프레임의 `systemPrompt.append`.
 * R5까지 그 인자는 두 호출처 모두 무조건 `None`이었고, 그래서 **채팅별 추가 지시가
 * Claude 엔진에서는 한 번도 안 나갔다**(Codex는 `developerInstructions`로 이미 싣고 있었다).
 * 제거하면서 그 수선까지 걷어내면 파리티 결함이 되살아난다.
 *
 * 그래서 이 하네스는 두 가지를 **stdin 바이트로** 잰다 — 코드 대조가 아니라, CLI가
 * 실제로 무엇을 받았는가로.
 *
 *   A. 추가 지시가 **없는** 채팅  → `initialize`에 `systemPrompt` 키가 **아예 없다**.
 *                                   (빈 문자열이 아니라 키의 부재 — 빈 값을 실으면
 *                                    CLI의 `claude_code` 프리셋이 죽는다.)
 *   B. 추가 지시가 **있는** 채팅  → 그 문자열이 `systemPrompt.append`에 그대로 실린다.
 *
 * 제거 **전** exe와 **후** exe에서 각각 돌리고 산출물을 비교하면 통과 조건이 닫힌다:
 * A는 두 판이 **바이트로 같아야** 하고, B는 두 판 모두 그 문자열을 실어야 한다.
 *
 * 계기는 가짜 CLI(`ccg-fakecli.exe`)다 — `CCG_FAKECLI_IN`에 받은 stdin 줄을 한 글자도
 * 안 고치고 덧붙인다. 실 CLI·실계정·네트워크를 아예 안 쓴다($0).
 *
 *   node scripts/poc-m10-removal-bytes.mjs --exe=... --tag=pre  --port=11010
 *   node scripts/poc-m10-removal-bytes.mjs --exe=... --tag=post --port=11020
 *   node scripts/poc-m10-removal-bytes.mjs --diff docs/…-pre.json docs/…-post.json
 *
 * ── 안전 규칙 (사용자 실앱이 떠 있다) ───────────────────────────────────────
 *  · 이름 기반 kill 금지 — 죽이는 것은 이 스크립트가 spawn한 PID 트리뿐이다.
 *  · 앱 홈은 전부 `CCG_HOME`으로 격리한다.
 * ========================================================================== */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { connectMainPage, killTree, sleep, REPO, resolveTauriExe } from '../bench/lib.mjs'

const args = process.argv.slice(2)

// ── --diff 모드: 두 산출물을 판정만 한다(앱을 안 띄운다) ────────────────────
if (args[0] === '--diff') {
  const [, aPath, bPath] = args
  const A = JSON.parse(fs.readFileSync(aPath, 'utf8'))
  const B = JSON.parse(fs.readFileSync(bPath, 'utf8'))
  const out = {
    at: new Date().toISOString(),
    a: { file: aPath, tag: A.tag, exe: A.exe },
    b: { file: bPath, tag: B.tag, exe: B.exe },
    plain: {
      aFrame: A.plain.frame,
      bFrame: B.plain.frame,
      aSha: A.plain.sha256,
      bSha: B.plain.sha256,
      identical: A.plain.frame === B.plain.frame,
      hasSystemPromptKey: A.plain.hasSystemPromptKey || B.plain.hasSystemPromptKey
    },
    instructed: {
      aAppend: A.instructed.append,
      bAppend: B.instructed.append,
      aCarries: A.instructed.carries,
      bCarries: B.instructed.carries,
      identical: A.instructed.append === B.instructed.append
    }
  }
  out.pass =
    out.plain.identical && !out.plain.hasSystemPromptKey && out.instructed.aCarries && out.instructed.bCarries
  console.log(JSON.stringify(out, null, 2))
  process.exit(out.pass ? 0 : 1)
}

const EXE = resolveTauriExe((args.find((a) => a.startsWith('--exe=')) ?? '').split('=')[1])
const FAKECLI =
  (args.find((a) => a.startsWith('--fakecli=')) ?? '').split('=')[1] ||
  path.join(path.dirname(EXE), 'ccg-fakecli.exe')
const TAG = (args.find((a) => a.startsWith('--tag=')) ?? '').split('=')[1] || 'x'
const PORT = Number((args.find((a) => a.startsWith('--port=')) ?? '').split('=')[1] || 11010)
const KEEP = args.includes('--keep')
const OUT =
  (args.find((a) => a.startsWith('--out=')) ?? '').split('=')[1] ||
  path.join(REPO, 'docs', 'critic', `m10rm-bytes-${TAG}.json`)

/** 채팅별 추가 지시 — B 축이 프레임에서 찾는 그 문자열이다. */
const EXTRA = '너는 코드 리뷰어다. 답은 한 문장으로만 한다.'
const PROMPT = '한 문장으로만 답해라. 지금 무엇을 맡고 있나?'

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex')
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true })
function write(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v))
}

function seed() {
  const HOME = path.join(REPO, `.poc-home-m10rm-${TAG}`)
  const WORK = path.join(HOME, 'work')
  rmrf(HOME)
  fs.mkdirSync(WORK, { recursive: true })
  if (!fs.existsSync(FAKECLI)) {
    throw new Error(
      `가짜 CLI가 없다: ${FAKECLI}\n  CARGO_TARGET_DIR=… cargo build --release -p ccg-engine --features fakecli --bin ccg-fakecli`
    )
  }
  const enginedir = path.join(HOME, 'engines', 'fake', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64')
  fs.mkdirSync(enginedir, { recursive: true })
  fs.copyFileSync(FAKECLI, path.join(enginedir, 'claude.exe'))
  write(path.join(HOME, 'config.json'), { activeVersion: 'fake' })
  write(path.join(HOME, 'accounts.json'), { defaultEmail: 'a@fake.test', accounts: [{ email: 'a@fake.test' }] })
  fs.mkdirSync(path.join(HOME, 'accounts', 'a_fake.test'), { recursive: true })
  // 두 채팅은 **모든 축이 같다**. 다른 것은 이 하네스가 `chat:run`에 실어 보내는
  // `systemPrompt` 한 줄뿐이다 — 그래야 프레임 차이가 그 한 줄의 것이 된다.
  write(path.join(HOME, 'chats', 'index.json'), { version: 1, order: ['c-a', 'c-b'], activeChatId: 'c-a' })
  for (const [id, title] of [
    ['c-a', '평범'],
    ['c-b', '추가지시']
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
  write(path.join(HOME, 'ui-prefs.json'), { 'ui.lang': 'ko' })
  write(path.join(HOME, 'profile.json'), { nickname: 'poc' })

  const SCRIPT = path.join(HOME, 'fake.jsonl')
  const line = (sid, text) =>
    [
      { afterMs: 60, emit: { type: 'system', subtype: 'init', session_id: sid, model: 'claude-haiku-4', cwd: WORK, tools: [], apiKeySource: 'none' } },
      {
        afterMs: 90,
        emit: {
          type: 'assistant',
          session_id: sid,
          parent_tool_use_id: null,
          message: { role: 'assistant', content: [{ type: 'text', text }], usage: { input_tokens: 5 } }
        }
      },
      { emit: { type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid, total_cost_usd: 0, duration_ms: 1, num_turns: 1 } }
    ]
      .map((s) => JSON.stringify(s))
      .join('\n') + '\n'
  write(SCRIPT, line('FAKE-1', '확인했습니다.'))
  const IN = path.join(HOME, 'stdin.log')
  return { HOME, WORK, SCRIPT, IN }
}

async function boot(home, port, env = {}) {
  const child = spawn(EXE, [], {
    env: {
      ...process.env,
      CCG_HOME: home,
      ...env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`
    },
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
    window.__ev = []
    const I = window.__TAURI_INTERNALS__
    const handler = I.transformCallback((e) => window.__ev.push(e.payload))
    await I.invoke('plugin:event|listen', { event: 'chat:event', target: { kind: 'Any' }, handler })
    return true
  })()`)
}
const events = (app, chatId) =>
  app.j(`window.__ev.filter((x) => x.chatId === ${JSON.stringify(chatId)}).map((x) => x.event)`)

async function waitFor(fn, ms, every = 200) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn().catch(() => null)
    if (v) return v
    if (Date.now() - t0 > ms) return null
    await sleep(every)
  }
}

/** stdin 로그의 `initialize` 컨트롤 요청 줄들(원문 바이트 그대로). */
function initFrames(inPath) {
  let raw = ''
  try {
    raw = fs.readFileSync(inPath, 'utf8')
  } catch {
    return []
  }
  return raw.split(/\r?\n/).filter((l) => l.includes('"subtype":"initialize"'))
}

async function main() {
  const s = seed()
  const rep = {
    at: new Date().toISOString(),
    tag: TAG,
    // ★확인 크리틱 R1 — 이 값은 **파일의 sha256이어야 한다.** 원판은
    // `sha(readFileSync().toString('latin1'))`이었다: 바이트를 latin1 문자열로 되읽고
    // 그것을 다시 utf8로 해싱해서, 도장으로는 작동하지만 이름이 사실과 달랐다
    // (`sha256sum`과 값이 안 맞는다). 버퍼를 그대로 넣는다.
    exe: {
      path: EXE,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(EXE)).digest('hex'),
      bytes: fs.statSync(EXE).size,
      mtime: fs.statSync(EXE).mtime.toISOString()
    },
    home: s.HOME,
    extra: EXTRA,
    prompt: PROMPT
  }
  const app = await boot(s.HOME, PORT, { CCG_FAKECLI_SCRIPT: s.SCRIPT, CCG_FAKECLI_IN: s.IN })
  try {
    await armEvents(app)
    // ── A. 추가 지시가 없는 채팅 ──────────────────────────────────────────
    await app.call('chat:run', [{ chatId: 'c-a', prompt: PROMPT }])
    await waitFor(async () => (await events(app, 'c-a')).find((e) => e?.type === 'status' && e.status === 'done'), 60_000)
    const beforeB = initFrames(s.IN)
    // ── B. 추가 지시가 있는 채팅 ─────────────────────────────────────────
    await app.call('chat:run', [{ chatId: 'c-b', prompt: PROMPT, systemPrompt: EXTRA }])
    await waitFor(async () => (await events(app, 'c-b')).find((e) => e?.type === 'status' && e.status === 'done'), 60_000)
    const all = initFrames(s.IN)

    const plainFrame = beforeB[0] ?? ''
    const instrFrame = all.slice(beforeB.length)[0] ?? ''
    const parse = (l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    }
    const pa = parse(plainFrame)
    const pb = parse(instrFrame)
    rep.plain = {
      frame: plainFrame,
      sha256: sha(plainFrame),
      bytes: Buffer.byteLength(plainFrame, 'utf8'),
      hasSystemPromptKey: !!(pa && pa.request && Object.prototype.hasOwnProperty.call(pa.request, 'systemPrompt'))
    }
    rep.instructed = {
      frame: instrFrame,
      sha256: sha(instrFrame),
      bytes: Buffer.byteLength(instrFrame, 'utf8'),
      append: pb?.request?.systemPrompt?.append ?? null,
      carries: typeof pb?.request?.systemPrompt?.append === 'string' && pb.request.systemPrompt.append.includes(EXTRA)
    }
    rep.frames = all.length
    rep.pass = !rep.plain.hasSystemPromptKey && rep.instructed.carries && !!plainFrame && !!instrFrame
  } finally {
    killTree(app.child.pid)
    await sleep(500)
    if (!KEEP) rmrf(s.HOME)
  }
  write(OUT, JSON.stringify(rep, null, 2))
  console.log(`\n[${TAG}] 평범한 채팅 initialize — systemPrompt 키 ${rep.plain?.hasSystemPromptKey ? '있음(★실패)' : '없음'} · sha ${rep.plain?.sha256?.slice(0, 12)}… ${rep.plain?.bytes}B`)
  console.log(`[${TAG}] 추가 지시 채팅 initialize — 문자열 ${rep.instructed?.carries ? '실림' : '★안 실림'} · sha ${rep.instructed?.sha256?.slice(0, 12)}… ${rep.instructed?.bytes}B`)
  console.log(`[${TAG}] → ${OUT}  ${rep.pass ? 'PASS' : '★FAIL'}`)
  process.exit(rep.pass ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
