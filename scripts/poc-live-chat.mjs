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
 *   node scripts/poc-live-chat.mjs --only=dialog   # 폴백 확인 카드(가짜 CLI · $0)
 *   node scripts/poc-live-chat.mjs --only=winsave  # 추가 채팅 창 영속(가짜 CLI · $0)
 *   node scripts/poc-live-chat.mjs --only=live     # 라이브 턴만
 *   node scripts/poc-live-chat.mjs --keep          # 홈·프레임 덤프 보존
 *
 *   ※ --only=dialog 전에:
 *      cargo build -p ccg-engine --features fakecli --bin ccg-fakecli --release
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
import { cdpTargets, connectMainPage, killTree, sleep, Cdp, REPO } from '../bench/lib.mjs'

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

/// 조건이 참이 될 때까지(또는 상한까지). 폴링 단언의 공용 형태.
async function waitUntil(app, expr, ms = 30_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await app.j(`await (async () => !!(${expr}))()`).catch(() => false)) return true
    await sleep(120)
  }
  return false
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

// ─────────────────────────────────────────────────────────────────────────────
// 3) 폴백 확인 다이얼로그(`request_user_dialog`) — **가짜 CLI로 제품 경로 그대로**
//
//    이 프레임은 모델이 응답을 거부해야 오므로 라이브로 강제할 수가 없다. R1은 그래서
//    코드 대조로만 남겼고, 크리틱이 "kill 없이도 §2-E와 같은 영구 정지에 도달한다"고
//    지적했다(배선 R1 §3): 상태기계는 T4로 `AwaitingUser`에 들어가는데 화면에는 카드가
//    안 떴다. 여기서 그 프레임을 **엔진 자리에 꽂은 스텁**이 흘린다 —
//    spawn → stdout JSONL → 상태기계 → wire → 렌더러 카드 → 클릭 → stdin 응답까지
//    전부 실제 배선이고 모델만 가짜다($0).
// ─────────────────────────────────────────────────────────────────────────────
function seedDialogHome() {
  const HOME = path.join(REPO, '.poc-home-dialog')
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
  // 계정은 **이름만** 필요하다(정규화가 known_accounts로 판정한다) — 자격증명 0바이트.
  write(path.join(HOME, 'accounts.json'), { defaultEmail: 'fake@example.com', accounts: [{ email: 'fake@example.com' }] })
  fs.mkdirSync(path.join(HOME, 'accounts', 'fake_example.com'), { recursive: true })
  write(path.join(HOME, 'chats', 'index.json'), { version: 1, order: ['c-dlg'], activeChatId: 'c-dlg' })
  write(path.join(HOME, 'chats', 'c-dlg.json'), {
    id: 'c-dlg',
    title: '폴백 확인',
    custom: true,
    manualCwd: WORK,
    picker: { model: 'fable', effort: 'minimal', mode: 'normal' },
    refDirs: [],
    snapshot: { messages: [] },
    updatedAt: Date.now()
  })
  write(path.join(HOME, 'ui-prefs.json'), { 'ui.lang': 'ko' })
  write(path.join(HOME, 'profile.json'), { nickname: 'poc' })

  const SCRIPT = path.join(HOME, 'fake-script.jsonl')
  const IN = path.join(HOME, 'fake-stdin.jsonl')
  const steps = [
    { afterMs: 120, emit: { type: 'control_response', response: { subtype: 'success', request_id: 'init-1', response: {} } } },
    { emit: { type: 'system', subtype: 'init', session_id: 'FAKE-1', model: 'claude-fable-5', cwd: WORK, tools: [], apiKeySource: 'none' } },
    {
      afterMs: 250,
      emit: {
        type: 'control_request',
        request_id: 'dlg-1',
        request: {
          subtype: 'request_user_dialog',
          dialog_kind: 'refusal_fallback_prompt',
          tool_use_id: 'toolu_fake_1',
          payload: { originalModel: 'fable', fallbackModel: 'sonnet', apiRefusalCategory: 'policy' }
        }
      }
    },
    { awaitResponse: 'dlg-1' },
    {
      afterMs: 150,
      emit: {
        type: 'assistant',
        session_id: 'FAKE-1',
        parent_tool_use_id: null,
        message: { role: 'assistant', content: [{ type: 'text', text: 'FALLBACK-OK' }], usage: { input_tokens: 11 } }
      }
    },
    { emit: { type: 'result', subtype: 'success', is_error: false, result: 'FALLBACK-OK', session_id: 'FAKE-1', total_cost_usd: 0, duration_ms: 1, num_turns: 1 } }
  ]
  fs.writeFileSync(SCRIPT, steps.map((s) => JSON.stringify(s)).join('\n') + '\n')
  return { HOME, WORK, SCRIPT, IN }
}

async function phaseDialog() {
  console.log('\n[DIALOG] 폴백 확인 카드 — 가짜 CLI(제품 경로)')
  const s = seedDialogHome()
  const out = { home: s.HOME }
  const app = await boot(s.HOME, 9364, { CCG_FAKECLI_SCRIPT: s.SCRIPT, CCG_FAKECLI_IN: s.IN })
  try {
    await app.j(`(window.__ev = [], window.api.onEngineEvent((e) => window.__ev.push(e)), 'armed')`)
    // ★ 컴포저가 **활성 채팅을 잡은 뒤**에 보낸다. `window.api`가 답하는 시점과
    //   렌더러가 채팅을 채택한 시점은 다르다 — 사이에 보내면 Enter가 조용히 삼켜진다
    //   (전체 주행에서 실제로 한 번 밟았다).
    out.ready = await waitUntil(app, `(await window.api.getChats())?.activeChatId === 'c-dlg' && !!document.querySelector('.composer-row textarea')`, 30_000)
    await typeAndSend(app, '거부를 유발하는 질문')
    // ① 카드가 **뜨는가** — R1에서는 여기가 영원히 비어 있었다.
    let card = null
    for (let i = 0; i < 400; i++) {
      const c = await app.j(`(() => {
        const el = document.querySelector('.q-overlay .qcard')
        if (!el) return null
        return { head: el.querySelector('.qhl')?.textContent ?? '',
                 opts: [...el.querySelectorAll('.qopt .ql')].map((n) => n.textContent),
                 text: el.textContent.slice(0, 200) }
      })()`)
      if (c) { card = c; break }
      await sleep(100)
    }
    out.card = card ?? { timeout: true }
    out.state = await app.j(`(await window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: 'engine:debug', payload: [] })).chats?.[0]?.state ?? null`)
    if (!card) {
      fail('D1-카드', '폴백 확인 다이얼로그에 카드가 안 뜬다(= 카드 없는 영구 정지)', out)
      return
    }
    ok('D1-카드', { opts: card.opts, state: out.state })
    // ② 클릭 → **§4.4b 어휘로** 응답이 CLI stdin에 도달하는가
    await app.j(`(() => { document.querySelector('.q-overlay .qcard .qopt').click(); return 'clicked' })()`)
    let res = null
    for (let i = 0; i < 400; i++) {
      const r = await app.j(`(() => { const r = window.__ev.find((e) => e.type === 'result'); return r ? { isError: r.isError, text: (r.text||'').slice(0,40) } : null })()`)
      if (r) { res = r; break }
      await sleep(100)
    }
    out.result = res ?? { timeout: true }
    out.stdin = (() => {
      try {
        return fs.readFileSync(s.IN, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      } catch { return [] }
    })()
    const answer = out.stdin.find((v) => v.type === 'control_response' && v.response?.request_id === 'dlg-1')
    out.answer = answer?.response?.response ?? null
    out.after = await app.j(`({
      cardGone: !document.querySelector('.q-overlay .qcard'),
      fallbackBanner: window.__ev.filter((e) => e.type === 'model-fallback').map((e) => e.text),
      types: window.__ev.reduce((m, e) => ((m[e.type] = (m[e.type] ?? 0) + 1), m), {}),
      domHasReply: document.body.innerText.includes('FALLBACK-OK')
    })`)
    out.identityAfter = await app.j(
      `await window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: 'chat:identity-get', payload: [{ chatId: 'c-dlg' }] })`
    )
    if (!out.answer) fail('D2-응답', '카드를 눌렀는데 CLI stdin에 control_response가 안 갔다', { stdin: out.stdin.map((v) => v.type) })
    else if (out.answer.behavior !== 'completed' || out.answer.result !== 'retry_fallback')
      fail('D2-응답', `§4.4b 어휘가 아니다: ${JSON.stringify(out.answer)}`, out.answer)
    else if (out.answer.toolUseID !== 'toolu_fake_1') fail('D2-응답', 'toolUseID가 안 실렸다(고아 경로가 버린다)', out.answer)
    else ok('D2-응답', out.answer)
    if (!res) fail('D3-진행', '응답 뒤 턴이 안 끝났다(result 없음)', out)
    else if (!out.after.cardGone) fail('D3-진행', '응답 뒤에도 카드가 남아 있다', out.after)
    else ok('D3-진행', { result: res, banner: out.after.fallbackBanner })
    const modelAfter = out.identityAfter?.raw?.engine?.model ?? out.identityAfter?.identity?.engine?.model ?? null
    if (modelAfter !== 'sonnet')
      fail('D4-폴백리비전', `수락이 정체성을 안 바꿨다(모델 ${modelAfter})`, out.identityAfter)
    else ok('D4-폴백리비전', { model: modelAfter, revision: out.identityAfter?.revision })
  } catch (e) {
    fail('DIALOG', String(e))
  } finally {
    // ★ 실패 경로의 `return`이 기록을 건너뛰면 다음 사람이 진단할 재료가 없다.
    rep.steps.dialog = out
    try { killTree(app.child.pid) } catch {}
    await sleep(600)
    if (!KEEP) rmrf(s.HOME)
  }
  return rep.findings.length === 0
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) 추가 채팅 창 영속 — **닫아도, 앱을 껐다 켜도 그 대화가 남는가**
//
//    R1이 `session:*` 6채널을 배선해 그 창에서 대화가 실제로 돌기 시작했는데,
//    저장 채널(`session-wins:persist/hydrate/rename`)은 셸에 상수조차 없어
//    `{__unimplemented:true}`였다 → "Ctrl+Shift+N → 대화 → 창 닫기 = 증발"
//    (크리틱 배선 R1 §5-S4). 게다가 그 창의 chatId가 `s-{pid}-{n}`이라 **앱을 다시
//    켜면 값이 바뀐다** — 저장이 생겨도 다시 못 찾는다. 둘 다 여기서 잰다.
// ─────────────────────────────────────────────────────────────────────────────
function seedWinSaveHome() {
  const HOME = path.join(REPO, '.poc-home-winsave')
  const WORK = path.join(HOME, 'work')
  rmrf(HOME)
  fs.mkdirSync(WORK, { recursive: true })
  const stub = path.join(REPO, 'target', 'release', 'ccg-fakecli.exe')
  if (!fs.existsSync(stub)) throw new Error(`가짜 CLI가 없다: ${stub}`)
  const ed = path.join(HOME, 'engines', 'fake', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64')
  fs.mkdirSync(ed, { recursive: true })
  fs.copyFileSync(stub, path.join(ed, 'claude.exe'))
  write(path.join(HOME, 'config.json'), { activeVersion: 'fake' })
  write(path.join(HOME, 'accounts.json'), { defaultEmail: 'fake@example.com', accounts: [{ email: 'fake@example.com' }] })
  fs.mkdirSync(path.join(HOME, 'accounts', 'fake_example.com'), { recursive: true })
  write(path.join(HOME, 'chats', 'index.json'), { version: 1, order: ['c-main'], activeChatId: 'c-main' })
  write(path.join(HOME, 'chats', 'c-main.json'), {
    id: 'c-main', title: '본채팅', custom: true, manualCwd: WORK,
    picker: { model: 'haiku', effort: 'minimal', mode: 'normal' }, refDirs: [],
    snapshot: { messages: [{ kind: 'msg', id: 'm0', role: 'user', text: '본채팅 원본' }] }, updatedAt: 1
  })
  write(path.join(HOME, 'ui-prefs.json'), { 'ui.lang': 'ko' })
  write(path.join(HOME, 'profile.json'), { nickname: 'poc' })
  const SCRIPT = path.join(HOME, 'script.jsonl')
  fs.writeFileSync(
    SCRIPT,
    [
      { afterMs: 100, emit: { type: 'control_response', response: { subtype: 'success', request_id: 'init-1', response: {} } } },
      { emit: { type: 'system', subtype: 'init', session_id: 'WIN-1', model: 'claude-haiku', cwd: WORK, tools: [], apiKeySource: 'none' } },
      { afterMs: 150, emit: { type: 'assistant', session_id: 'WIN-1', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: '창에서 답한 줄' }], usage: { input_tokens: 7 } } } },
      { emit: { type: 'result', subtype: 'success', is_error: false, result: '창에서 답한 줄', session_id: 'WIN-1', total_cost_usd: 0, duration_ms: 1, num_turns: 1 } }
    ]
      .map((s) => JSON.stringify(s))
      .join('\n') + '\n'
  )
  return { HOME, WORK, SCRIPT }
}

/// 추가 채팅 **창**의 CDP 페이지(메인이 아닌 index.html 문서).
async function connectSessionPage(port, mainWsUrl) {
  for (let i = 0; i < 300; i++) {
    const targets = await cdpTargets(port).catch(() => [])
    const p = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url) && /#session/.test(t.url))
    if (p?.webSocketDebuggerUrl && p.webSocketDebuggerUrl !== mainWsUrl) return await Cdp.connect(p.webSocketDebuggerUrl, { timeoutMs: 8000 })
    await sleep(100)
  }
  return null
}

async function phaseWinSave() {
  console.log('\n[WINSAVE] 추가 채팅 창 영속(가짜 CLI)')
  const s = seedWinSaveHome()
  const out = { home: s.HOME }
  const app = await boot(s.HOME, 9365, { CCG_FAKECLI_SCRIPT: s.SCRIPT })
  let ok1 = false
  try {
    out.listAtBoot = await app.j('(await window.api.sessionWindows.list()).map((w) => w.id)')
    await app.j('(await window.api.openSessionWindow(), "opened")')
    for (let i = 0; i < 80; i++) {
      out.listAfterOpen = await app.j('(await window.api.sessionWindows.list()).map((w) => w.id)')
      if (out.listAfterOpen.length > out.listAtBoot.length) break
      await sleep(100)
    }
    out.winId = (out.listAfterOpen ?? []).find((id) => !out.listAtBoot.includes(id)) ?? null
    if (!out.winId) {
      fail('W1-창', '추가 채팅 창이 목록에 안 뜬다', out)
      return
    }
    // ★ id 규약 — pid가 박히면 재시작 뒤 같은 대화를 못 찾는다.
    if (/^s-\d+-\d+$/.test(out.winId)) fail('W1-id', `chatId에 pid가 박혔다: ${out.winId}`)
    else ok('W1-id', out.winId)

    const sp = await connectSessionPage(9365, null)
    if (!sp) {
      fail('W2-창페이지', '추가 채팅 창의 CDP 페이지를 못 찾았다')
      return
    }
    const sj = async (e) => JSON.parse(await sp.eval(`(async () => JSON.stringify(${e}))()`, { awaitPromise: true }))
    for (let i = 0; i < 400; i++) {
      const up = await sp.eval(`(async () => { try { return !!(await window.api.app.getVersion()) } catch { return false } })()`, { awaitPromise: true }).catch(() => false)
      if (up) break
      await sleep(100)
    }
    // 그 창에서 실제로 한 턴 돌린다(작업 폴더가 있어야 전송이 대화상자로 안 빠진다)
    // 새 창은 `localStorage['session.cwd']`(SessionWindow.tsx:106)로 폴더를 복원한다 —
    // 안 심으면 전송이 **네이티브 폴더 선택 대화상자**로 빠져 하네스가 멈춘다.
    await sj(`(() => { try { localStorage.setItem('session.cwd', ${JSON.stringify(s.WORK)}) } catch {} return 'cwd' })()`)
    await sp.eval(`location.reload()`).catch(() => {})
    await sleep(1500)
    const sp2 = await connectSessionPage(9365, null)
    const sj2 = async (e) => JSON.parse(await sp2.eval(`(async () => JSON.stringify(${e}))()`, { awaitPromise: true }))
    for (let i = 0; i < 400; i++) {
      const up = await sp2.eval(`(async () => { try { return !!(await window.api.app.getVersion()) } catch { return false } })()`, { awaitPromise: true }).catch(() => false)
      if (up) break
      await sleep(100)
    }
    out.sent = await sp2.eval(`(() => {
      const ta = document.querySelector('.composer-row textarea') || document.querySelector('textarea')
      if (!ta) return 'no-textarea'
      const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      set.call(ta, '창에서 보낸 질문')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      ta.focus(); ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      return 'sent'
    })()`)
    let replied = false
    for (let i = 0; i < 400; i++) {
      replied = await sj2(`document.body.innerText.includes('창에서 답한 줄')`)
      if (replied) break
      await sleep(100)
    }
    out.replyInWindow = replied
    if (!replied) fail('W2-턴', '추가 채팅 창에서 턴이 안 돌았다', out)
    else ok('W2-턴')
    await sleep(1800) // 600ms 디바운스 저장

    // 디스크 — 그 창의 대화가 레코드로 남았나
    out.recordAfterTurn = (() => {
      const v = readChatV3(s.HOME, out.winId)
      return v ? { origin: v.origin, msgs: v.snapshot?.messages?.length ?? null, title: v.title, cwd: v.identity?.cwd ?? null } : null
    })()
    if (!out.recordAfterTurn || !out.recordAfterTurn.msgs)
      fail('W3-저장', '창의 대화가 디스크에 없다(= 닫으면 증발)', out.recordAfterTurn)
    else ok('W3-저장', out.recordAfterTurn)
    // 본채팅은 안 건드렸다
    out.mainAfter = readChatV3(s.HOME, 'c-main')?.snapshot?.messages?.length ?? null
    if (out.mainAfter !== 1) fail('W3-격리', `추가 채팅 저장이 본채팅을 건드렸다(${out.mainAfter})`)
    else ok('W3-격리')
    ok1 = true
  } catch (e) {
    fail('WINSAVE', String(e))
  } finally {
    killTree(app.child.pid)
    await sleep(1000)
  }
  if (!ok1) {
    rep.steps.winsave = out
    return false
  }

  // 재시작 — 목록에 남는가 · 클릭하면 창이 되살아나는가 · 대화가 복원되는가
  const app2 = await boot(s.HOME, 9366, { CCG_FAKECLI_SCRIPT: s.SCRIPT })
  try {
    out.listAfterRestart = await app2.j('(await window.api.sessionWindows.list()).map((w) => ({ id: w.id, title: w.title, open: w.open }))')
    const survived = (out.listAfterRestart ?? []).some((w) => w.id === out.winId)
    if (!survived) fail('W4-재시작목록', '재시작 뒤 추가 채팅이 사이드바에서 사라졌다', out.listAfterRestart)
    else ok('W4-재시작목록', out.listAfterRestart)
    // 사이드바 클릭 = focus. 창이 없으면 **되만들어야** 한다(R1 §4.4-E).
    await app2.j(`(window.api.sessionWindows.focus(${JSON.stringify(out.winId)}), 'focus')`)
    const sp = await connectSessionPage(9366, null)
    out.reopened = !!sp
    if (!sp) {
      fail('W5-되만들기', '닫힌 추가 채팅을 클릭해도 창이 안 뜬다', out)
    } else {
      for (let i = 0; i < 400; i++) {
        const up = await sp.eval(`(async () => { try { return !!(await window.api.app.getVersion()) } catch { return false } })()`, { awaitPromise: true }).catch(() => false)
        if (up) break
        await sleep(100)
      }
      let restored = false
      for (let i = 0; i < 400; i++) {
        restored = JSON.parse(await sp.eval(`(async () => JSON.stringify(document.body.innerText.includes('창에서 답한 줄')))()`, { awaitPromise: true }).catch(() => 'false'))
        if (restored) break
        await sleep(100)
      }
      out.restoredInWindow = restored
      if (!restored) fail('W5-복원', '되만든 창에 저장된 대화가 안 그려진다', out)
      else ok('W5-복원')
      out.listWhileOpen = await app2.j('(await window.api.sessionWindows.list()).map((w) => ({ id: w.id, open: w.open }))')
      if ((out.listWhileOpen ?? []).filter((w) => w.id === out.winId).length !== 1)
        fail('W5-중복', '되만든 창이 목록에 두 번 뜬다', out.listWhileOpen)
      else ok('W5-중복없음')
    }
  } catch (e) {
    fail('WINSAVE-2', String(e))
  } finally {
    killTree(app2.child.pid)
    await sleep(800)
    if (!KEEP) rmrf(s.HOME)
  }
  rep.steps.winsave = out
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
if (only === 'all' || only === 'dialog') allOk = (await phaseDialog()) && allOk
if (only === 'all' || only === 'winsave') allOk = (await phaseWinSave()) && allOk
if (only === 'all' || only === 'live') allOk = (await phaseLive()) && allOk
rep.verdict = rep.findings.length === 0 ? 'PASS' : 'FAIL'
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(rep, null, 2))
console.log(`\n판정: ${rep.verdict}  ·  결함 ${rep.findings.length}건  ·  ${OUT}`)
process.exit(rep.verdict === 'PASS' ? 0 : 1)
