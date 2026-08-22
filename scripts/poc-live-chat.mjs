#!/usr/bin/env node
/* ============================================================================
 * poc-live-chat — **세로 조각 실증**. 실 창 · 실 `claude.exe` · 실 화면.
 *
 * 이 라운드의 게이트다. 단위 테스트 97개가 통과해도 "창에서 대화가 되는가"는
 * 별개 질문이고, 그 질문에만 답한다:
 *
 *   부팅 → 채팅 열기 → 메시지 → 스트리밍이 **DOM에 그려짐** → 승인 카드가 **뜸**
 *        → 클릭하면 진행 → 완료(파일이 실제로 생김) → 재시작 후 대화가 남음
 *
 * 그리고 기본값 전환의 전제였던 R8-1도 같은 하네스로 잰다(별도 단계).
 *
 *   node scripts/poc-live-chat.mjs                 # 전부
 *   node scripts/poc-live-chat.mjs --only=r81      # R8-1 브로드캐스트만(CLI 불필요)
 *   node scripts/poc-live-chat.mjs --only=live     # 라이브 턴만
 *   node scripts/poc-live-chat.mjs --keep          # 홈·프레임 덤프 보존
 *
 * ── 안전 규칙 (사용자 실앱이 떠 있다) ───────────────────────────────────────
 *  · **이름 기반 kill 금지.** 죽이는 것은 이 스크립트가 spawn한 PID 트리뿐이다.
 *  · **실홈은 읽기/복사만.** 자격증명은 격리 홈으로 **복사**하고, 엔진 폴더는
 *    **정션(mklink /J)**으로 건다 — CLI가 토큰을 갱신해도 실홈에 안 닿는다.
 *  · 앱 홈은 전부 `CCG_HOME`으로 격리한다(레포 안 `.poc-home-*`).
 * ========================================================================== */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { connectMainPage, killTree, sleep, REPO } from '../bench/lib.mjs'

const args = process.argv.slice(2)
const only = (args.find((a) => a.startsWith('--only=')) ?? '').split('=')[1] || 'all'
const KEEP = args.includes('--keep')
const EXE = path.join(REPO, 'target', 'release', 'agentcodegui.exe')
const REAL_HOME = path.join(os.homedir(), '.agentcodegui')
const OUT = path.join(REPO, 'docs', 'critic', 'm3-r2-live.json')

const rep = { at: new Date().toISOString(), exe: EXE, steps: {}, findings: [] }
const fail = (id, why, extra) => {
  rep.findings.push({ id, why, ...(extra ?? {}) })
  console.error(`  ✗ ${id} — ${why}`)
}
const ok = (id, v) => console.log(`  ✓ ${id}${v === undefined ? '' : ' — ' + JSON.stringify(v)}`)

// ── 공용: 앱 부팅 + CDP ───────────────────────────────────────────────────────
async function boot(home, port, env = {}) {
  const child = spawn(EXE, [], {
    env: { ...process.env, CCG_HOME: home, ...env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  child.stdout.on('data', (d) => (log += d.toString()))
  child.stderr.on('data', (d) => (log += d.toString()))
  const cdp = await connectMainPage(port, { timeoutMs: 60_000 })
  // 렌더러 마운트 + IPC 브리지가 실제로 답할 때까지(둘은 다른 시점이다)
  for (let i = 0; i < 300; i++) {
    const up = await cdp
      .eval(`(async () => { try { return !!(await window.api.app.getVersion()) } catch { return false } })()`, { awaitPromise: true })
      .catch(() => false)
    if (up) break
    await sleep(100)
  }
  const j = async (expr) => JSON.parse(await cdp.eval(`(async () => JSON.stringify(${expr}))()`, { awaitPromise: true }))
  return { child, cdp, j, log: () => log }
}

const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true })
const write = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v))
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) R8-1 — `session-wins:changed`가 `list`와 같은 원천을 싣는가
//
//    크리틱 R8 §2.5가 실측한 증상: 영속 추가 채팅 2건이 있는데 창을 하나 열면
//    changed 페이로드에 **열린 창 1건만** 실려, 렌더러(REPLACE)가 사이드바에서
//    나머지를 지웠다. 기대: 열고 나면 **3건**(영속 2 + 열린 창 1).
// ─────────────────────────────────────────────────────────────────────────────
async function phaseR81() {
  console.log('\n[R8-1] session-wins 브로드캐스트 원천')
  const HOME = path.join(REPO, '.poc-home-r81')
  rmrf(HOME)
  // 2.6.2 포맷의 추가 채팅 2건 — 부팅 첫 통합 채널 접촉에서 마이그레이션된다.
  write(path.join(HOME, 'session-chats', 'index.json'), { version: 1, order: ['sc-alpha', 'sc-beta'] })
  for (const [id, title] of [
    ['sc-alpha', '영속 추가채팅 A'],
    ['sc-beta', '영속 추가채팅 B']
  ]) {
    write(path.join(HOME, 'session-chats', `${id}.json`), {
      id,
      title,
      cwd: REPO,
      picker: { model: 'haiku', effort: 'minimal', mode: 'normal' },
      snapshot: { messages: [{ id: 'm1', role: 'user', text: 'hi' }] }
    })
  }
  const app = await boot(HOME, 9361)
  const out = {}
  try {
    out.listAtBoot = await app.j('(await window.api.sessionWindows.list()).map((w) => w.id)')
    // 브로드캐스트를 통째로 받아 둔다(REPLACE 의미 그대로).
    await app.j(`(window.__chg = [], window.api.sessionWindows.onChanged((l) => window.__chg.push(l.map((w) => w.id))), 'armed')`)
    await app.j('(await window.api.openSessionWindow(), "opened")')
    for (let i = 0; i < 60; i++) {
      const n = await app.j('window.__chg.length')
      if (n > 0) break
      await sleep(100)
    }
    out.changedPayloads = await app.j('window.__chg')
    out.listAfterOpen = await app.j('(await window.api.sessionWindows.list()).map((w) => w.id)')
    const last = out.changedPayloads.at(-1) ?? []
    out.persistedLostInBroadcast = out.listAtBoot.filter((id) => !last.includes(id))
    out.verdict = last.length === 3 && out.persistedLostInBroadcast.length === 0 ? 'FIXED' : 'BROKEN'
    if (out.verdict !== 'FIXED') fail('R8-1', '브로드캐스트가 영속 추가 채팅을 지운다', out)
    else ok('R8-1', { boot: out.listAtBoot.length, afterOpen: last.length })
  } finally {
    killTree(app.child.pid)
    await sleep(600)
    if (!KEEP) rmrf(HOME)
  }
  rep.steps.r81 = out
  return out.verdict === 'FIXED'
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) 라이브 세로 조각
// ─────────────────────────────────────────────────────────────────────────────
function seedLiveHome() {
  const HOME = path.join(REPO, '.poc-home-live')
  const WORK = path.join(HOME, 'work')
  rmrf(HOME)
  fs.mkdirSync(WORK, { recursive: true })

  // (a) 엔진 — 실홈의 engines를 **정션**으로 건다(복사 337MB 회피 · 쓰기 없음)
  const ver = JSON.parse(fs.readFileSync(path.join(REAL_HOME, 'config.json'), 'utf8')).activeVersion
  write(path.join(HOME, 'config.json'), { activeVersion: ver })
  const link = path.join(HOME, 'engines')
  const r = spawnSync('cmd', ['/c', 'mklink', '/J', link, path.join(REAL_HOME, 'engines')], { encoding: 'utf8' })
  const cli = path.join(link, ver, 'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe')
  if (!fs.existsSync(cli)) throw new Error(`claude.exe 없음: ${cli}\n${r.stdout}${r.stderr}`)

  // (b) 계정 — 기본 계정의 자격증명을 **복사**한다(CLI의 토큰 갱신이 실홈에 안 닿게)
  const accounts = JSON.parse(fs.readFileSync(path.join(REAL_HOME, 'accounts.json'), 'utf8'))
  const email = accounts.defaultEmail
  const prefix = email.replace('@', '_').replace('+', '-')
  const srcDir = fs
    .readdirSync(path.join(REAL_HOME, 'accounts'))
    .find((n) => n === prefix || n.startsWith(prefix + '-'))
  if (!srcDir) throw new Error(`기본 계정 폴더 없음: ${prefix}`)
  const dstDir = path.join(HOME, 'accounts', srcDir)
  fs.mkdirSync(dstDir, { recursive: true })
  for (const f of ['.credentials.json', '.claude.json']) {
    const s = path.join(REAL_HOME, 'accounts', srcDir, f)
    if (fs.existsSync(s)) fs.copyFileSync(s, path.join(dstDir, f))
  }
  write(path.join(HOME, 'accounts.json'), accounts)

  // (c) 대화 — 2.6.2 포맷 채팅 1건. **manualCwd가 있어야** 렌더러가 폴더 선택
  //     대화상자를 안 띄운다(App.tsx:1013). 값싼 조합(haiku·minimal) + 승인 카드가
  //     실제로 뜨는 모드(normal — bypass면 CLI가 아예 안 묻는다).
  write(path.join(HOME, 'chats', 'index.json'), { version: 1, order: ['c-live'], activeChatId: 'c-live' })
  write(path.join(HOME, 'chats', 'c-live.json'), {
    id: 'c-live',
    title: '라이브 세로 조각',
    custom: true,
    manualCwd: WORK,
    picker: { model: 'haiku', effort: 'minimal', mode: 'normal' },
    refDirs: [],
    snapshot: { messages: [] },
    updatedAt: Date.now()
  })
  write(path.join(HOME, 'ui-prefs.json'), { 'ui.lang': 'ko' })
  write(path.join(HOME, 'profile.json'), { nickname: 'poc' })
  return { HOME, WORK, cli, email, ver }
}

const PROMPT = 'Use the Write tool to create live-approve.txt with the exact content OK. Then reply with exactly: DONE'

async function typeAndSend(app, text) {
  // 진짜 컴포저에 넣는다 — React의 value setter를 우회하지 않으면 상태가 안 바뀐다.
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

async function phaseLive() {
  console.log('\n[LIVE] 세로 조각 — 실 CLI 1턴')
  const seed = seedLiveHome()
  const target = path.join(seed.WORK, 'live-approve.txt')
  const out = { home: seed.HOME, engine: seed.ver, account: seed.email, steps: {} }
  const app = await boot(seed.HOME, 9362, { CCG_ENGINE_LOG: path.join(seed.HOME, 'frames.jsonl') })
  const t0 = Date.now()
  try {
    // ── 1. 부팅 ────────────────────────────────────────────────────────────
    const boot1 = await app.j(`({
      apiUp: typeof window.api === 'object',
      chats: (await window.api.getChats())?.chats?.map((c) => c.id) ?? [],
      active: (await window.api.getChats())?.activeChatId ?? null,
      composer: !!document.querySelector('.composer-row textarea'),
      migrated: !!(await window.api.getChats())
    })`)
    out.steps.boot = { ...boot1, ms: Date.now() - t0 }
    if (!boot1.apiUp || !boot1.composer || !boot1.chats.includes('c-live')) {
      fail('1-부팅', '창은 떴지만 채팅/컴포저가 없다', boot1)
      throw new Error('boot')
    }
    ok('1-부팅', { chats: boot1.chats, composer: true })

    // ── 2. 채팅 열기 ───────────────────────────────────────────────────────
    // 활성 채팅이 우리가 심은 것이고, 폴더(manualCwd)가 살아 돌아왔는가
    // (여기가 비면 전송이 네이티브 폴더 선택 대화상자로 빠진다 = 하네스 정지).
    const open = await app.j(`(() => {
      const c = window.__ccgChat
      return { cwdShown: (document.body.innerText.match(/work/) || [])[0] ?? null,
               title: document.title }
    })()`)
    out.steps.open = { active: boot1.active, ...open }
    if (boot1.active !== 'c-live') fail('2-채팅열기', `활성 채팅이 c-live가 아니다: ${boot1.active}`)
    else ok('2-채팅열기', { active: boot1.active })

    // 엔진 이벤트를 통째로 받아 둔다(화면 단언과 **독립**인 두 번째 증거).
    await app.j(`(window.__ev = [], window.api.onEngineEvent((e) => window.__ev.push(e)), 'armed')`)

    // ── 3. 메시지 (실제 컴포저에 타이핑 + Enter) ────────────────────────────
    const sent = await typeAndSend(app, PROMPT)
    out.steps.send = { via: 'composer', result: sent }
    if (sent !== 'sent') fail('3-메시지', `컴포저를 못 찾았다: ${sent}`)
    else ok('3-메시지')

    // ── 4. 스트리밍이 **DOM에** 그려지는가 ──────────────────────────────────
    let stream = null
    for (let i = 0; i < 600; i++) {
      const s = await app.j(`({
        deltas: window.__ev.filter((e) => e.type === 'assistant-stream').length,
        types: [...new Set(window.__ev.map((e) => e.type))],
        userEchoed: document.body.innerText.includes('live-approve.txt'),
        domChars: document.body.innerText.length
      })`)
      if (s.deltas > 0 || s.types.includes('permission-request')) {
        stream = s
        break
      }
      await sleep(100)
    }
    out.steps.stream = stream ?? { timeout: true }
    if (!stream) fail('4-스트리밍', '60초 안에 첫 스트림/카드가 안 왔다', await app.j('window.__ev.slice(0,20)'))
    else ok('4-스트리밍', { deltas: stream.deltas, types: stream.types })

    // ── 5. 승인 카드가 뜨는가 + 눌러서 진행되는가 ──────────────────────────
    let card = null
    for (let i = 0; i < 900; i++) {
      const c = await app.j(`(() => {
        const el = document.querySelector('.q-overlay .qcard')
        if (!el) return null
        return { head: el.querySelector('.qhl')?.textContent ?? '',
                 tool: el.querySelector('.qtool')?.textContent ?? '',
                 summary: el.querySelector('.qsum')?.textContent ?? '',
                 opts: [...el.querySelectorAll('.qopt .ql')].map((n) => n.textContent) }
      })()`)
      if (c) {
        card = c
        break
      }
      await sleep(100)
    }
    out.steps.card = card ?? { timeout: true }
    if (!card) {
      fail('5-승인카드', '90초 안에 승인 카드가 안 떴다', await app.j('window.__ev.map((e) => e.type)'))
    } else {
      ok('5-승인카드', card)
      // AwaitingUser는 **영구 정지**가 계약이다 — 3초를 그냥 둬도 카드가 살아 있어야 한다
      // (타임아웃으로 자동 허용/거부되면 여기서 사라진다).
      await sleep(3000)
      out.steps.cardStillThereAfter3s = await app.j(`!!document.querySelector('.q-overlay .qcard')`)
      if (!out.steps.cardStillThereAfter3s) fail('5b-영구정지', '무응답 3초에 카드가 스스로 닫혔다')
      else ok('5b-영구정지(무응답에 안 닫힘)')
      // 첫 선택지 = '허용'(1회) — permChoices() 순서(Chat.tsx:3619).
      await app.j(`(() => { document.querySelector('.q-overlay .qcard .qopt').click(); return 'clicked' })()`)
    }

    // ── 6. 완료 — 파일이 실제로 생기고 result가 오는가 ──────────────────────
    let done = null
    for (let i = 0; i < 1200; i++) {
      const d = await app.j(`(() => {
        const r = window.__ev.find((e) => e.type === 'result')
        const st = window.__ev.filter((e) => e.type === 'status').map((e) => e.status)
        return { result: r ? { isError: r.isError, text: (r.text || '').slice(0, 80), costUsd: r.costUsd, viaApi: r.viaApi } : null,
                 statuses: st, replyInDom: document.body.innerText.includes('DONE') }
      })()`)
      if (d.result) {
        done = d
        break
      }
      await sleep(100)
    }
    out.steps.done = { ...(done ?? { timeout: true }), fileOnDisk: fs.existsSync(target), turnMs: Date.now() - t0 }
    if (fs.existsSync(target)) out.steps.done.fileBody = fs.readFileSync(target, 'utf8').trim()
    if (!done) fail('6-완료', '120초 안에 result가 안 왔다', await app.j('window.__ev.map((e) => e.type)'))
    else if (!fs.existsSync(target)) fail('6-완료', '턴은 끝났는데 승인한 파일이 없다', out.steps.done)
    else ok('6-완료', { file: path.basename(target), body: out.steps.done.fileBody, ms: out.steps.done.turnMs })

    // 마지막 화면 상태 + 이벤트 전수(사람이 되짚을 재료).
    // ★ 스트리밍 판정은 **턴이 끝난 뒤** 세어야 한다 — 4단계의 폴링은 "카드가 먼저 왔다"에서
    //   빠져나오므로 그 시점의 delta 수는 0일 수 있다(1차 주행에서 실제로 그랬다).
    out.steps.finalDom = await app.j(`({
      chars: document.body.innerText.length,
      hasDone: document.body.innerText.includes('DONE'),
      hasPrompt: document.body.innerText.includes('live-approve.txt'),
      cardGone: !document.querySelector('.q-overlay .qcard'),
      events: window.__ev.reduce((m, e) => ((m[e.type] = (m[e.type] ?? 0) + 1), m), {}),
      streamedText: window.__ev.filter((e) => e.type === 'assistant-stream').map((e) => e.delta).join(''),
      assistantDone: window.__ev.filter((e) => e.type === 'assistant-done').map((e) => e.text)
    })`)
    if (!out.steps.finalDom.events['assistant-stream']) fail('4b-스트리밍(총계)', '턴이 끝나도 assistant-stream이 0건이다', out.steps.finalDom.events)
    else ok('4b-스트리밍(총계)', { deltas: out.steps.finalDom.events['assistant-stream'], text: out.steps.finalDom.streamedText })
    // ★ `j()`가 이미 JSON.stringify를 씌우므로 **Promise를 넘기면 `{}`가 된다** —
    //   await를 표현식 안에 둔다(1차 주행에서 실제로 밟은 함정. 값이 빈 객체로 보였다).
    out.steps.engineDebug = await app.j(
      `await window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: 'engine:debug', payload: [] })`
    )

    // ── 7. 저장 — 재시작 후 대화가 남는가 ──────────────────────────────────
    // 렌더러 저장은 디바운스다. 넉넉히 기다린 뒤 **정상 종료**시킨다(창 닫기 =
    // 종료 flush 경로 D15까지 함께 타게).
    await sleep(2500)
    const diskBefore = readChatV3(seed.HOME, 'c-live')
    out.steps.savedOnDisk = {
      msgs: diskBefore?.snapshot?.messages?.length ?? null,
      // 재시작 뒤의 `resume`이 여기서 나온다 — 없으면 다음 턴이 새 스레드가 된다.
      sessionId: diskBefore?.snapshot?.session?.sessionId ?? null,
      // Rust 소유 필드 되끼움(§4.1 규약 2) — 렌더러 페이로드가 아니라 런타임 값이어야 한다
      identityCwd: diskBefore?.identity?.cwd ?? null,
      identityModel: diskBefore?.identity?.engine?.model ?? null
    }
    await app.j(`(window.api.win.close(), 'closing')`).catch(() => {})
    await sleep(1500)
    killTree(app.child.pid)
    await sleep(800)
  } catch (e) {
    out.error = String(e && e.message ? e.message : e)
    fail('LIVE', out.error)
  } finally {
    try {
      killTree(app.child.pid)
    } catch {}
    out.appLog = app.log().split('\n').filter(Boolean).slice(-25)
  }

  // 종료 뒤 디스크 — `status.json`은 **Rust 전용 파일**이다(§5.8 규약 1).
  // 종료 flush(D15)가 배선돼 있어야 마지막 전이가 여기 남는다. (500ms 디바운스가
  // 이미 썼을 수도 있어 이 값만으로 flush를 격리 증명하지는 못한다 — 배선 확인용.)
  try {
    const st = JSON.parse(fs.readFileSync(path.join(seed.HOME, 'chats-v3', 'status.json'), 'utf8'))
    out.steps.statusJson = st.statuses?.['c-live'] ?? null
  } catch (e) {
    out.steps.statusJson = { error: String(e) }
  }

  // 재부팅 — 대화가 살아 있는가 (같은 홈, 새 프로세스)
  await sleep(800)
  const app2 = await boot(seed.HOME, 9363)
  try {
    // 화면이 스레드를 그릴 때까지 잠깐 준다(부팅 조회는 light — 활성 채팅은
    // `chats:load`로 지연 로드된다).
    let after = null
    for (let i = 0; i < 100; i++) {
      after = await app2.j(`await (async () => {
        const c = await window.api.getChats()
        const light = c?.chats?.find((x) => x.id === 'c-live')
        const full = await window.api.loadChat('c-live')
        return { lightMsgs: light?.snapshot?.messages?.length ?? null,
                 loadedMsgs: full?.snapshot?.messages?.length ?? null,
                 sessionId: full?.snapshot?.session?.sessionId ?? null,
                 texts: (full?.snapshot?.messages ?? []).map((m) => (m.text || '').slice(0, 40)),
                 domHasPrompt: document.body.innerText.includes('live-approve.txt'),
                 domHasDone: document.body.innerText.includes('DONE') }
      })()`)
      if (after.domHasPrompt && after.domHasDone) break
      await sleep(200)
    }
    out.steps.afterRestart = after
    if (!after?.loadedMsgs) fail('7-재시작(디스크)', '재부팅 후 대화가 비었다', after)
    else if (!after.domHasPrompt || !after.domHasDone) fail('7-재시작(화면)', '디스크엔 있는데 화면에 안 그려진다', after)
    else ok('7-재시작', { msgs: after.loadedMsgs, dom: true, session: !!after.sessionId })
  } catch (e) {
    fail('7-재시작', String(e))
  } finally {
    killTree(app2.child.pid)
    await sleep(600)
  }

  out.frames = countFrames(path.join(seed.HOME, 'frames.jsonl'))
  rep.steps.live = out
  if (!KEEP) {
    // 정션은 rmSync가 **대상까지 지울 수 있다** — 링크부터 rmdir로 떼고 지운다.
    spawnSync('cmd', ['/c', 'rmdir', path.join(seed.HOME, 'engines')], { encoding: 'utf8' })
    rmrf(seed.HOME)
  }
  return rep.findings.length === 0
}

function readChatV3(home, id) {
  for (const p of [path.join(home, 'chats-v3', `${id}.json`), path.join(home, 'chats', `${id}.json`)]) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'))
    } catch {}
  }
  return null
}

function countFrames(p) {
  try {
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim())
    const kinds = {}
    for (const l of lines) {
      try {
        const v = JSON.parse(l)
        const k = v.type + (v.subtype ? '/' + v.subtype : '')
        kinds[k] = (kinds[k] ?? 0) + 1
      } catch {}
    }
    return { total: lines.length, kinds }
  } catch {
    return { total: 0, kinds: {} }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
if (!fs.existsSync(EXE)) {
  console.error(`릴리즈 exe가 없다: ${EXE}  (npm run tauri:build)`)
  process.exit(2)
}
let allOk = true
if (only === 'all' || only === 'r81') allOk = (await phaseR81()) && allOk
if (only === 'all' || only === 'live') allOk = (await phaseLive()) && allOk
rep.verdict = rep.findings.length === 0 ? 'PASS' : 'FAIL'
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(rep, null, 2))
console.log(`\n판정: ${rep.verdict}  ·  결함 ${rep.findings.length}건  ·  ${OUT}`)
process.exit(rep.verdict === 'PASS' ? 0 : 1)
