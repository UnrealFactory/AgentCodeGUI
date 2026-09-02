#!/usr/bin/env node
/* ============================================================================
 * poc-wf-live-interleave — **긴 워크플로 + 중간 대화 + 자발 보고** 실측 (라이브).
 *
 * 사용자 보고(2026-09-01 19:34): 2.6.2에서는 워크플로를 백그라운드로 두고 대화하다가
 * 결과가 오면 모델이 **스스로 이어서** 보고했는데, 3.0에서 그게 안 되는 것 같다.
 *
 * 시나리오:
 *   ① 발사 턴 — 수십 초 걸리는 에이전트 2개짜리 인라인 워크플로
 *   ② 발사 턴 종료 후, 워크플로가 도는 동안 잡담 1턴("지금 뭐 하는 중이야?")
 *      → 즉시 전송·즉시 답이 와야 한다(상주 T16 주입)
 *   ③ 잡담 턴 종료 후 손 떼고 대기 — 워크플로 완료 시 **사용자 입력 없이**
 *      정리 턴(WFDONE=<합>)이 오는가
 *
 * 표본: 300ms 간격 DOM(.wf-dock·busy·WFDONE 텍스트·메시지 수) + engine:debug.
 * 프레임: CCG_ENGINE_LOG 전체 덤프에서 관심 프레임의 순서.
 *
 *   node scripts/poc-wf-live-interleave.mjs [--exe=…] [--port=11081] [--keep]
 *
 * 안전 규칙: 이름 kill 금지 · 실홈 읽기/복사만(자격증명 복사·engines 정션) · CCG_HOME 격리.
 * ========================================================================== */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { connectMainPage, killTree, sleep, REPO, resolveTauriExe } from '../bench/lib.mjs'

const args = process.argv.slice(2)
const EXE = resolveTauriExe((args.find((a) => a.startsWith('--exe=')) ?? '').split('=')[1])
const PORT = Number((args.find((a) => a.startsWith('--port=')) ?? '').split('=')[1] || 11081)
const KEEP = args.includes('--keep')
const REAL_HOME = path.join(os.homedir(), '.agentcodegui3')
const OUT = path.join(
  REPO, 'docs', 'critic',
  `wf-live-interleave-${((args.find((a) => a.startsWith('--kind=')) ?? '').split('=')[1] || 'workflow')}-r1.json`
)

const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true })
const write = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v))
}

function seed() {
  const HOME = path.join(REPO, '.poc-home-wf-interleave')
  const WORK = path.join(HOME, 'work')
  rmrf(HOME)
  fs.mkdirSync(WORK, { recursive: true })
  const ver = JSON.parse(fs.readFileSync(path.join(REAL_HOME, 'config.json'), 'utf8')).activeVersion
  write(path.join(HOME, 'config.json'), { activeVersion: ver })
  write(path.join(HOME, 'engine-auto-update.json'), { enabled: false })
  const link = path.join(HOME, 'engines')
  const r = spawnSync('cmd', ['/c', 'mklink', '/J', link, path.join(REAL_HOME, 'engines')], { encoding: 'utf8' })
  const cli = path.join(link, ver, 'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe')
  if (!fs.existsSync(cli)) throw new Error(`claude.exe 없음: ${cli}\n${r.stdout}${r.stderr}`)
  const accounts = JSON.parse(fs.readFileSync(path.join(REAL_HOME, 'accounts.json'), 'utf8'))
  const email = accounts.defaultEmail
  const prefix = email.replace('@', '_').replace('+', '-')
  const srcDir = fs.readdirSync(path.join(REAL_HOME, 'accounts')).find((n) => n === prefix || n.startsWith(prefix + '-'))
  if (!srcDir) throw new Error(`기본 계정 폴더 없음: ${prefix}`)
  const dstDir = path.join(HOME, 'accounts', srcDir)
  fs.mkdirSync(dstDir, { recursive: true })
  for (const f of ['.credentials.json', '.claude.json']) {
    const sfile = path.join(REAL_HOME, 'accounts', srcDir, f)
    if (fs.existsSync(sfile)) fs.copyFileSync(sfile, path.join(dstDir, f))
  }
  write(path.join(HOME, 'accounts.json'), accounts)
  write(path.join(HOME, 'chats', 'index.json'), { version: 1, order: ['c-wf'], activeChatId: 'c-wf' })
  write(path.join(HOME, 'chats', 'c-wf.json'), {
    id: 'c-wf', title: 'wf interleave', custom: true, manualCwd: WORK,
    picker: { model: 'haiku', effort: 'minimal', mode: 'bypass', account: email },
    refDirs: [], snapshot: { messages: [] }, updatedAt: Date.now()
  })
  write(path.join(HOME, 'ui-prefs.json'), { 'ui.lang': 'ko', 'whatsnew.seenVersion': '99.0.0' })
  write(path.join(HOME, 'profile.json'), { nickname: 'poc' })
  return { HOME, WORK, email, ver }
}

// 에이전트가 수십 초 걸리게 — 도구 없이 글쓰기 과제(하이쿠도 400단어면 십수 초).
// --kind=agent 면 워크플로 대신 **백그라운드 서브에이전트**(Agent 도구)로 같은 3박자를 잰다.
const KIND = (args.find((a) => a.startsWith('--kind=')) ?? '').split('=')[1] || 'workflow'
const LAUNCH =
  KIND === 'agent'
    ? 'Launch ONE subagent with the Agent tool RIGHT NOW, running in the background: its task is to compute 123+456 and then write a 400-word English essay about mountains (return the number first on its own line). End your turn immediately after launching — do not wait for it. When the subagent completes later, report its number as "WFDONE=<n>". Do not use any other tools.'
    : 'Use the Workflow tool RIGHT NOW with an inline script: two agents in parallel. Agent one: compute 111+222 and then write a 400-word English essay about clocks (return the number first on its own line). Agent two: compute 333+444 and then write a 400-word English essay about rivers (return the number first on its own line). After the workflow completes, report the sum of the two numbers as "WFDONE=<n>". Do not use any other tools.'
const CHITCHAT = '기다리는 동안 잡담 — 좋아하는 숫자 하나만 말해줘. 도구는 쓰지 마.'

async function main() {
  const s = seed()
  const FRAMES = path.join(s.HOME, 'frames.jsonl')
  const child = spawn(EXE, [], {
    env: {
      ...process.env,
      CCG_HOME: s.HOME,
      CCG_ENGINE_LOG: FRAMES,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`
    },
    stdio: ['ignore', 'ignore', 'ignore']
  })
  const rep = { at: new Date().toISOString(), engine: s.ver, account: s.email, phases: {}, samples: [], frames: [], verdict: {} }
  try {
    const cdp = await connectMainPage(PORT, { timeoutMs: 60_000 })
    const ev = async (expr) => JSON.parse(await cdp.eval(`(async () => JSON.stringify(${expr}))()`, { awaitPromise: true }))
    for (let i = 0; i < 300; i++) {
      const up = await cdp.eval(`(async () => { try { return !!(await window.api.app.getVersion()) } catch { return false } })()`, { awaitPromise: true }).catch(() => false)
      if (up) break
      await sleep(100)
    }
    await sleep(1500)
    await ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /시작하기|Get started/.test(x.textContent || '')); if (b) b.click(); return true })()`)
    await sleep(400)

    const typeSend = async (text) => await ev(`(() => {
      const ta = document.querySelector('.composer textarea') || document.querySelector('textarea')
      if (!ta) return 'no-textarea'
      const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      set.call(ta, ${JSON.stringify(text)})
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      ta.focus()
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      return 'sent'
    })()`)
    const snap = async (phase) => {
      const dom = await ev(`(() => ({
        pill: document.querySelectorAll('.wf-dock .wf-mini').length,
        busy: !!document.querySelector('.composer .stop'),
        msgs: document.querySelectorAll('.thread .msg').length,
        queued: document.querySelectorAll('.sched-item').length,
        done: /WFDONE\\s*=\\s*\\d+/.test(document.querySelector('.thread')?.textContent || ''),
        text: (document.querySelector('.thread')?.textContent || '').slice(-90)
      }))()`).catch(() => null)
      const dbg = await ev(`await window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: 'engine:debug', payload: [] })`).catch(() => null)
      const c = dbg?.chats?.[0] ?? {}
      const row = { t: Date.now() - t0, phase, ...dom, state: c.state, exits: c.exits, queuedEng: c.queued }
      rep.samples.push(row)
      return row
    }

    const t0 = Date.now()
    // ── ① 발사 턴 ──────────────────────────────────────────────────────────
    await typeSend(LAUNCH)
    let launchEnded = false
    while (Date.now() - t0 < 120_000) {
      const r = await snap('launch')
      if (r && !r.busy && r.msgs >= 2 && r.state !== 'Streaming' && r.state !== 'Starting') { launchEnded = true; break }
      await sleep(300)
    }
    rep.phases.launchEnded = launchEnded

    // ── ② 워크플로 상주 중 잡담 — 알약이 살아 있는 동안 보낸다 ────────────────
    const midPill = (await snap('pre-chat'))?.pill ?? 0
    await typeSend(CHITCHAT)
    let chatAnswered = false
    const chatT = Date.now()
    while (Date.now() - chatT < 60_000) {
      const r = await snap('chitchat')
      if (r && !r.busy && r.state !== 'Streaming' && r.msgs >= 4) { chatAnswered = true; break }
      await sleep(300)
    }
    rep.phases.pillAliveWhenChatting = midPill > 0
    rep.phases.chatAnswered = chatAnswered

    // ── ③ 손 떼고 대기 — 자발 정리 턴(WFDONE)이 오는가 (최대 3분) ─────────────
    const waitT = Date.now()
    let spontaneous = false
    while (Date.now() - waitT < 180_000) {
      const r = await snap('wait')
      if (r?.done) { spontaneous = true; break }
      await sleep(300)
    }
    rep.phases.spontaneousReport = spontaneous
    await sleep(1200)
    await snap('final')

    // ── 프레임 판독 ─────────────────────────────────────────────────────────
    const lines = fs.existsSync(FRAMES) ? fs.readFileSync(FRAMES, 'utf8').split('\n').filter(Boolean) : []
    let i = 0
    for (const ln of lines) {
      i++
      let f
      try { f = JSON.parse(ln) } catch { continue }
      const ty = f.type ?? ''
      const sub = f.subtype ?? ''
      if (ty === 'system' && sub === 'background_tasks_changed') rep.frames.push({ i, f: 'REPLACE', n: (f.tasks ?? []).length })
      else if (ty === 'system' && sub === 'task_notification') rep.frames.push({ i, f: 'NOTIFY', status: f.status })
      else if (ty === 'result') rep.frames.push({ i, f: 'RESULT' })
      else if (ty === 'system' && sub === 'init') rep.frames.push({ i, f: 'INIT' })
      else if (ty === 'user') {
        const txt = JSON.stringify(f.message?.content ?? '')
        if (txt.includes('task-notification')) rep.frames.push({ i, f: 'USER-NOTIF' })
      }
    }
    rep.verdict = {
      launchEnded,
      pillAliveWhenChatting: rep.phases.pillAliveWhenChatting,
      chatAnswered,
      spontaneousReport: spontaneous,
      frameSeq: rep.frames.map((x) => x.f + (x.status ? ':' + x.status : '')).join(' → ')
    }
  } finally {
    if (!KEEP) {
      killTree(child.pid)
      await sleep(800)
      spawnSync('cmd', ['/c', 'rmdir', path.join(REPO, '.poc-home-wf-interleave', 'engines')], { encoding: 'utf8' })
      rmrf(path.join(REPO, '.poc-home-wf-interleave'))
    }
  }
  write(OUT, JSON.stringify(rep, null, 2))
  console.log(JSON.stringify(rep.verdict, null, 2))
  console.log('→', OUT)
}

main().catch((e) => {
  console.error('FAIL', e)
  process.exit(1)
})
