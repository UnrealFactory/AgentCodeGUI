#!/usr/bin/env node
/* ============================================================================
 * poc-wf-live-race — **빠른 워크플로의 경주 실측** (실 CLI · 실 계정 · 라이브 1턴).
 *
 * 사용자 실측(2026-09-01 19:09): 3초짜리 워크플로가 턴 안에서 완주하니
 *   · 알약은 스쳐 지나가고(또는 안 보이고)
 *   · 완료 통지가 result보다 먼저 원장을 비워, 턴 종료의 §3.4가 CLI를 **즉시 닫아**
 *     모델의 자발 정리 턴(최종 합)이 죽는 것으로 의심된다.
 *
 * 이 하네스는 그 의심을 프레임 원문으로 판정한다:
 *   1. 격리 홈(실홈 ~/.agentcodegui3 자격증명 복사·engines 정션) + CCG_ENGINE_LOG
 *   2. 작은 인라인 워크플로를 지시하는 라이브 1턴
 *   3. 300ms 간격 DOM 표본: .wf-dock 존재 · busy · 최종 합 등장
 *   4. frames.jsonl에서 background_tasks_changed/task_progress/task_notification/result
 *      의 순서·시각 추출 + engine:debug의 spawns/exits
 *
 *   node scripts/poc-wf-live-race.mjs [--exe=…] [--port=11061] [--keep]
 *
 * ── 안전 규칙 (사용자 실앱이 떠 있다) ───────────────────────────────────────
 *  · 이름 기반 kill 금지 — 죽이는 것은 spawn한 PID 트리뿐.
 *  · 실홈은 읽기/복사만 — 자격증명은 격리 홈으로 복사, engines는 정션(쓰기 없음).
 * ========================================================================== */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { connectMainPage, killTree, sleep, REPO, resolveTauriExe } from '../bench/lib.mjs'

const args = process.argv.slice(2)
const EXE = resolveTauriExe((args.find((a) => a.startsWith('--exe=')) ?? '').split('=')[1])
const PORT = Number((args.find((a) => a.startsWith('--port=')) ?? '').split('=')[1] || 11061)
const KEEP = args.includes('--keep')
const REAL_HOME = path.join(os.homedir(), '.agentcodegui3')
const OUT = path.join(REPO, 'docs', 'critic', 'wf-live-race-r1.json')

const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true })
const write = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v))
}

function seed() {
  const HOME = path.join(REPO, '.poc-home-wf-race')
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
    const s = path.join(REAL_HOME, 'accounts', srcDir, f)
    if (fs.existsSync(s)) fs.copyFileSync(s, path.join(dstDir, f))
  }
  write(path.join(HOME, 'accounts.json'), accounts)
  write(path.join(HOME, 'chats', 'index.json'), { version: 1, order: ['c-wf'], activeChatId: 'c-wf' })
  write(path.join(HOME, 'chats', 'c-wf.json'), {
    id: 'c-wf', title: 'wf race', custom: true, manualCwd: WORK,
    // bypass — 승인 카드가 워크플로 발사를 막지 않게. 값싼 조합(haiku·minimal).
    picker: { model: 'haiku', effort: 'minimal', mode: 'bypass', account: email },
    refDirs: [], snapshot: { messages: [] }, updatedAt: Date.now()
  })
  write(path.join(HOME, 'ui-prefs.json'), { 'ui.lang': 'ko', 'whatsnew.seenVersion': '99.0.0' })
  write(path.join(HOME, 'profile.json'), { nickname: 'poc' })
  return { HOME, WORK, email, ver }
}

const PROMPT =
  'Use the Workflow tool RIGHT NOW with an inline script: two agents in parallel, one computes 12+34 and one computes 56+78 (each just returns the number, no tools). After the workflow completes, tell me the final total of both results as "TOTAL=<n>". Do not use any other tools.'

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
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  child.stdout.on('data', (d) => (log += d.toString()))
  child.stderr.on('data', (d) => (log += d.toString()))
  const rep = { at: new Date().toISOString(), exe: EXE, engine: s.ver, account: s.email, samples: [], frames: [], verdict: {} }
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

    const sent = await ev(`(() => {
      const ta = document.querySelector('.composer textarea') || document.querySelector('textarea')
      if (!ta) return 'no-textarea'
      const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      set.call(ta, ${JSON.stringify(PROMPT)})
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      ta.focus()
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      return 'sent'
    })()`)
    if (sent !== 'sent') throw new Error('전송 실패: ' + sent)

    // ── 표본 채집 — 최대 4분: 알약·상태·최종 합·CLI 생사 ─────────────────────
    const t0 = Date.now()
    let sawTotal = false
    while (Date.now() - t0 < 240_000) {
      const dom = await ev(`(() => ({
        pill: document.querySelectorAll('.wf-dock .wf-mini').length,
        card: document.querySelectorAll('.wf-card').length,
        busy: !!document.querySelector('.composer .stop, .ma-status-spin'),
        total: (document.querySelector('.thread')?.textContent || '').match(/TOTAL\\s*=\\s*(\\d+)/)?.[1] ?? null,
        worked: document.querySelectorAll('.worked').length
      }))()`).catch(() => null)
      const dbg = await ev(`await window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: 'engine:debug', payload: [] })`).catch(() => null)
      const c = dbg?.chats?.[0] ?? {}
      rep.samples.push({ t: Date.now() - t0, ...dom, state: c.state, spawns: c.spawns, exits: c.exits, pid: c.pid })
      if (dom?.total) { sawTotal = true; if (rep.samples.filter((x) => x.total).length > 3) break }
      // 정리 턴까지 기다린다 — 완주 판정: 합이 보였고 엔진이 다시 Idle
      if (sawTotal && c.state === 'Idle') break
      await sleep(300)
    }
    await sleep(1500)

    // ── 프레임 판독 — 관심 프레임의 순서와 시각(파일 내 등장 순서 = 도착 순서) ──
    const lines = fs.existsSync(FRAMES) ? fs.readFileSync(FRAMES, 'utf8').split('\n').filter(Boolean) : []
    let idx = 0
    for (const ln of lines) {
      idx++
      let f
      try { f = JSON.parse(ln) } catch { continue }
      const ty = f.type ?? ''
      const sub = f.subtype ?? ''
      if (ty === 'system' && sub === 'background_tasks_changed') {
        rep.frames.push({ i: idx, f: 'REPLACE', tasks: (f.tasks ?? []).map((t) => `${t.task_id}:${t.task_type}`) })
      } else if (ty === 'system' && sub === 'task_progress') {
        rep.frames.push({ i: idx, f: 'PROGRESS', task: f.task_id, wf: Array.isArray(f.workflow_progress) ? f.workflow_progress.length : 0 })
      } else if (ty === 'system' && sub === 'task_notification') {
        rep.frames.push({ i: idx, f: 'NOTIFY', task: f.task_id, status: f.status })
      } else if (ty === 'system' && sub === 'task_started') {
        rep.frames.push({ i: idx, f: 'STARTED', task: f.task_id })
      } else if (ty === 'result') {
        rep.frames.push({ i: idx, f: 'RESULT', isError: !!f.is_error })
      } else if (ty === 'system' && sub === 'init') {
        rep.frames.push({ i: idx, f: 'INIT', session: f.session_id })
      }
    }

    // ── 판정 ────────────────────────────────────────────────────────────────
    const seq = rep.frames.map((x) => x.f)
    const firstResult = seq.indexOf('RESULT')
    const notifyIdx = rep.frames.findIndex((x) => x.f === 'NOTIFY')
    rep.verdict = {
      totalShown: rep.samples.some((x) => x.total),
      pillEverShown: rep.samples.some((x) => x.pill > 0),
      pillShownMs: rep.samples.filter((x) => x.pill > 0).length * 300,
      replaceHadWorkflow: rep.frames.some((x) => x.f === 'REPLACE' && (x.tasks ?? []).some((t) => t.includes('workflow'))),
      notifyBeforeFirstResult: notifyIdx >= 0 && firstResult >= 0 && notifyIdx < firstResult,
      results: seq.filter((x) => x === 'RESULT').length,
      inits: seq.filter((x) => x === 'INIT').length,
      lastSample: rep.samples[rep.samples.length - 1] ?? null
    }
  } finally {
    if (!KEEP) {
      killTree(child.pid)
      await sleep(800)
      // 정션 링크 먼저 안전 제거(rmdir는 링크만 지운다 — 실홈 engines 불가침)
      spawnSync('cmd', ['/c', 'rmdir', path.join(REPO, '.poc-home-wf-race', 'engines')], { encoding: 'utf8' })
      rmrf(path.join(REPO, '.poc-home-wf-race'))
    }
  }
  write(OUT, JSON.stringify(rep, null, 2))
  console.log(JSON.stringify({ verdict: rep.verdict, frames: rep.frames.slice(0, 40) }, null, 2))
  console.log('→', OUT)
}

main().catch((e) => {
  console.error('FAIL', e)
  process.exit(1)
})
