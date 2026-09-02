#!/usr/bin/env node
/* ============================================================================
 * poc-qmini-pos — **내려둔 질문 알약(.q-mini)의 실제 좌표**를 표면별로 잰다.
 *
 * 사용자 보고(2026-09-01 17:19 스크린샷): "질문 2개 대기 중" 알약이 컴포저 줄에
 * 앉아 있다. styles.css의 n1 되돌림(.ma-grid.n1 … bottom:96px)은 이미 있고
 * 헤드리스 크로뮴에서는 96px가 맞게 나온다 — 그런데 뜬 앱은 아니었다.
 * 그래서 **제품 경로 그대로**(fakecli가 AskUserQuestion control_request를 흘리고,
 * 카드를 접어 알약으로 내린 뒤) 표면 넷에서 좌표를 잰다:
 *
 *   n1      다이얼 1 (IDE 크롬)            기대: 패널 바닥에서 96px
 *   n2      다이얼 2 (그리드 미니어처)      기대: 10px (설계값)
 *   expand  n2에서 크게 보기 카드           기대: 96px (기본값)
 *   popout  n2에서 별도 창(#mapanel)        기대: 96px (기본값)
 *
 *   node scripts/poc-qmini-pos.mjs [--exe=…] [--fakecli=…] [--port=11041] [--keep]
 *
 * ── 안전 규칙 (사용자 실앱이 떠 있다) ───────────────────────────────────────
 *  · 이름 기반 kill 금지 — 죽이는 것은 이 스크립트가 spawn한 PID 트리뿐이다.
 *  · 앱 홈은 CCG_HOME으로 격리하고 실 CLI·실계정을 아예 안 쓴다.
 * ========================================================================== */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { cdpTargets, connectMainPage, killTree, sleep, Cdp, REPO, resolveTauriExe } from '../bench/lib.mjs'

const args = process.argv.slice(2)
const EXE = resolveTauriExe((args.find((a) => a.startsWith('--exe=')) ?? '').split('=')[1])
const FAKECLI =
  (args.find((a) => a.startsWith('--fakecli=')) ?? '').split('=')[1] ||
  path.join(REPO, 'target', 'release', 'ccg-fakecli.exe')
const PORT = Number((args.find((a) => a.startsWith('--port=')) ?? '').split('=')[1] || 11041)
const KEEP = args.includes('--keep')
const OUT = path.join(REPO, 'docs', 'critic', 'qmini-pos-r1.json')

const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true })
function write(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v))
}
const rep = { at: new Date().toISOString(), exe: EXE, surfaces: {} }

function seed() {
  const HOME = path.join(REPO, '.poc-home-qmini-pos')
  const WORK = path.join(HOME, 'work')
  rmrf(HOME)
  fs.mkdirSync(WORK, { recursive: true })
  if (!fs.existsSync(FAKECLI)) throw new Error(`가짜 CLI가 없다: ${FAKECLI}`)
  const enginedir = path.join(HOME, 'engines', 'fake', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64')
  fs.mkdirSync(enginedir, { recursive: true })
  fs.copyFileSync(FAKECLI, path.join(enginedir, 'claude.exe'))
  write(path.join(HOME, 'config.json'), { activeVersion: 'fake' })
  // 엔진 카드·자동 업데이트 억제 + 설치 판정 마커 (poc-account-switch seedHome과 동일)
  write(path.join(HOME, 'engine-auto-update.json'), { enabled: false })
  const sdkdir = path.join(HOME, 'engines', 'fake', 'node_modules', '@anthropic-ai', 'claude-agent-sdk')
  fs.mkdirSync(sdkdir, { recursive: true })
  write(path.join(sdkdir, 'package.json'), { name: '@anthropic-ai/claude-agent-sdk', version: 'fake' })
  // 합성 계정 — 복호 가능한 가짜 토큰 (없으면 [auth] 토큰 교환 실패로 턴이 안 열린다)
  const PROBE = path.join(REPO, 'target', 'debug', 'ccg-auth-probe.exe')
  if (!fs.existsSync(PROBE)) throw new Error(`프로브가 없다: ${PROBE}\n  cargo build -p ccg-auth --features cli --bin ccg-auth-probe`)
  const pr = spawnSync(PROBE, ['seed', 'a@fake.test'], { env: { ...process.env, CCG_HOME: HOME }, encoding: 'utf8' })
  if (pr.status !== 0) throw new Error(`계정 심기 실패: ${pr.stderr || pr.stdout}`)
  fs.mkdirSync(path.join(HOME, 'accounts', 'a_fake.test'), { recursive: true })
  write(path.join(HOME, 'chats', 'index.json'), { version: 1, order: ['c-a'], activeChatId: 'c-a' })
  write(path.join(HOME, 'chats', 'c-a.json'), {
    id: 'c-a', title: '질문', custom: true, manualCwd: WORK,
    picker: { model: 'haiku', effort: 'minimal', mode: 'normal', account: 'a@fake.test' },
    refDirs: [], snapshot: { messages: [] }, updatedAt: 1700000000000
  })
  // 보드로 곧장 부팅 — 알약의 무대는 멀티 크롬이다
  write(path.join(HOME, 'ui-prefs.json'), { 'ui.lang': 'ko', 'whatsnew.seenVersion': '9.9.9', 'workspace.mode': 'multi' })
  write(path.join(HOME, 'profile.json'), { nickname: 'poc' })

  // 대본 — 턴을 열고, 질문 2개짜리 AskUserQuestion을 세워 둔 채 응답을 기다린다.
  // (카드가 살아 있는 동안 접어서 알약 좌표를 잰다. 응답이 오면 정상 종료.)
  const SCRIPT = path.join(HOME, 'fake.jsonl')
  write(SCRIPT, [
    { afterMs: 60, emit: { type: 'system', subtype: 'init', session_id: 'F1', model: 'claude-haiku-4', cwd: WORK, tools: [], apiKeySource: 'none' } },
    { afterMs: 250, emit: { type: 'control_request', request_id: 'q-1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', tool_use_id: 'tq-1', input: { questions: [
      { question: '언어는 무엇으로 할까요?', header: '언어', multiSelect: false, options: [{ label: 'Rust', description: '빠르다' }, { label: 'Go', description: '단순하다' }] },
      { question: '빌드는 무엇으로 할까요?', header: '빌드', multiSelect: false, options: [{ label: 'cargo', description: '기본' }, { label: 'bazel', description: '원격 캐시' }] }
    ] } } } },
    { awaitResponse: 'q-1' },
    { emit: { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'F1', total_cost_usd: 0, duration_ms: 1, num_turns: 1 } },
    { exit: 0 }
  ].map((s) => JSON.stringify(s)).join('\n') + '\n')
  return { HOME, WORK, SCRIPT }
}

/** 알약·주변 좌표 한 벌 — 어느 페이지에서든 같은 식으로 잰다 */
const MEASURE = `(() => {
  const qm = document.querySelector('.q-mini')
  const grid = document.querySelector('.ma-grid')
  const panel = qm ? qm.closest('.ma-panel') : document.querySelector('.ma-panel')
  const ci = panel ? panel.querySelector('.composer-inner') : document.querySelector('.composer-inner')
  const cw = panel ? panel.querySelector('.composer-wrap') : document.querySelector('.composer-wrap')
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), bottom: +r.bottom.toFixed(1) } }
  const pr = rect(panel), qr = rect(qm)
  return {
    gridClass: grid ? grid.className : null,
    pill: qr,
    pillCssBottom: qm ? getComputedStyle(qm).bottom : null,
    pillGapToPanelBottom: pr && qr ? +(pr.bottom - qr.bottom).toFixed(1) : null,
    pillGapToWinBottom: qr ? +(innerHeight - qr.bottom).toFixed(1) : null,
    panel: pr,
    composerMaxW: ci ? getComputedStyle(ci).maxWidth : null,
    composerWrap: rect(cw),
    zoomChain: (() => { const out = []; let el = qm; while (el && el !== document.body) { const z = getComputedStyle(el).zoom; if (z && z !== '1' && z !== 'normal') out.push(el.className.split(' ')[0] + ':' + z); el = el.parentElement } return out })(),
    dpr: devicePixelRatio, inner: { w: innerWidth, h: innerHeight }
  }
})()`

async function main() {
  const s = seed()
  const child = spawn(EXE, [], {
    env: {
      ...process.env,
      CCG_HOME: s.HOME,
      CCG_NO_NET: '1',
      CCG_FAKECLI_SCRIPT: s.SCRIPT,
      CCG_FAKECLI_IN: path.join(s.HOME, 'fake-in.log'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  child.stdout.on('data', (d) => (log += d.toString()))
  child.stderr.on('data', (d) => (log += d.toString()))

  try {
    const cdp = await connectMainPage(PORT, { timeoutMs: 60_000 })
    const ev = async (expr) => JSON.parse(await cdp.eval(`(async () => JSON.stringify(${expr}))()`, { awaitPromise: true }))
    const clickJs = (sel, n = 0) => ev(`(() => { const e = document.querySelectorAll(${JSON.stringify(sel)})[${n}]; if (!e) return false; e.click(); return true })()`)
    const waitFor = async (sel, ms = 8000, min = 1) => {
      const t0 = Date.now()
      for (;;) {
        const n = await ev(`document.querySelectorAll(${JSON.stringify(sel)}).length`).catch(() => 0)
        if (n >= min) return n
        if (Date.now() - t0 > ms) throw new Error(`waitFor timeout: ${sel}`)
        await sleep(100)
      }
    }
    const key = async (k, code, vk) => {
      const base = { modifiers: 0, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    }
    const shot = async (name) => {
      try {
        const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
        fs.writeFileSync(path.join(REPO, `.poc-qmini-${name}.png`), Buffer.from(r.data, 'base64'))
      } catch { /* 스크린샷은 참고용 — 실패해도 측정은 산다 */ }
    }

    // 실패 시 진단 — 어디까지 갔는지 화면·DOM·엔진 상태로 남긴다
    const diag = async (tag) => {
      await shot('fail-' + tag)
      rep.fail = {
        tag,
        multi: await ev(`document.querySelectorAll('.multi').length`).catch(() => -1),
        grid: await ev(`document.querySelector('.ma-grid')?.className ?? null`).catch(() => null),
        composer: await ev(`document.querySelectorAll('.composer textarea').length`).catch(() => -1),
        qcard: await ev(`document.querySelectorAll('.q-overlay, .q-mini').length`).catch(() => -1),
        engine: await ev(`await window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: 'engine:debug', payload: [] })`).catch((e) => String(e)),
        cliLog: log.slice(-1200)
      }
      console.log('FAIL-DIAG', JSON.stringify(rep.fail, null, 1).slice(0, 3000))
    }

    // 앱이 뜨고 보드가 그려질 때까지
    for (let i = 0; i < 300; i++) {
      const up = await cdp.eval(`(async () => { try { return !!(await window.api.app.getVersion()) } catch { return false } })()`, { awaitPromise: true }).catch(() => false)
      if (up) break
      await sleep(100)
    }
    await waitFor('.multi .ma-grid', 20_000).catch(async (e) => { await diag('grid'); throw e })
    await sleep(800)

    // ── n1 — 다이얼 1로 (IDE 크롬) ──────────────────────────────────────────
    await clickJs('.ma-count-btn[data-count="1"]')
    await sleep(600)

    // 패널 컴포저에 한 줄 보내 fakecli 턴을 연다
    await ev(`(() => { const t = document.querySelector('.composer textarea'); if (!t) return false; t.focus(); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, '질문 줘'); t.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await sleep(200)
    await key('Enter', 'Enter', 13)
    await waitFor('.q-overlay .qcard', 20_000).catch(async (e) => { await diag('qcard'); throw e })
    // 접어 알약으로 — 카드 헤더의 마지막 .qmin(접어두기)
    await ev(`(() => { const b = [...document.querySelectorAll('.qcard .qmin')].pop(); if (!b) return false; b.click(); return true })()`)
    await waitFor('.q-mini', 5000)
    await sleep(300)
    rep.surfaces.n1 = await ev(MEASURE)
    await shot('n1')

    // ── n2 — 다이얼 2 (그리드 미니어처, 설계값 10px 확인) ───────────────────
    await clickJs('.ma-count-btn[data-count="2"]')
    await sleep(700)
    // 다이얼 전환으로 패널이 리마운트되면 카드가 다시 펼쳐진다 — 다시 접는다
    if (await ev(`document.querySelectorAll('.q-overlay .qcard').length`).catch(() => 0)) {
      await ev(`(() => { const b = [...document.querySelectorAll('.qcard .qmin')].pop(); if (!b) return false; b.click(); return true })()`)
      await waitFor('.q-mini', 5000)
    }
    await sleep(300)
    rep.surfaces.n2 = await ev(MEASURE)
    await shot('n2')

    // ── expand — 크게 보기 카드 ────────────────────────────────────────────
    // n2 패널 헤더의 .ma-p-expand는 [별도 창으로, 크게 보기] 순 — 두 번째를 누른다
    await ev(`(() => { const p = document.querySelector('.ma-panel:not(.ma-ghost)'); const bs = p ? p.querySelectorAll('.ma-p-expand') : []; const b = bs[bs.length - 1]; if (!b) return false; b.click(); return true })()`)
    await waitFor('.ma-expand-card', 6000)
    if (await ev(`document.querySelectorAll('.q-overlay .qcard').length`).catch(() => 0)) {
      await ev(`(() => { const b = [...document.querySelectorAll('.ma-expand-card .qcard .qmin')].pop(); if (!b) return false; b.click(); return true })()`)
    }
    await sleep(400)
    rep.surfaces.expand = await ev(`(() => { const root = document.querySelector('.ma-expand-card'); if (!root) return { err: 'no card' }
      const qm = root.querySelector('.q-mini'); const panel = root.querySelector('.ma-panel'); const ci = root.querySelector('.composer-inner')
      const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), bottom: +r.bottom.toFixed(1) } }
      const pr = rect(panel), qr = rect(qm)
      const wb = root.querySelector('.workbar-wrap'); const cwr = root.querySelector('.composer-wrap')
      return { pill: qr, pillCssBottom: qm ? getComputedStyle(qm).bottom : null, pillGapToPanelBottom: pr && qr ? +(pr.bottom - qr.bottom).toFixed(1) : null, composerMaxW: ci ? getComputedStyle(ci).maxWidth : null, workbar: rect(wb), composerWrap: rect(cwr), panel: pr } })()`)
    await shot('expand')
    // 원래 크기로 — Esc는 카드/알약이 먹으니 헤더 버튼을 누른다
    await ev(`(() => { const b = [...document.querySelectorAll('.ma-expand-card .ma-p-expand')].pop(); if (!b) return false; b.click(); return true })()`)
    await sleep(500)

    // ── popout — 별도 창(#mapanel) ─────────────────────────────────────────
    await ev(`(() => { const p = document.querySelector('.ma-panel:not(.ma-ghost)'); const bs = p ? p.querySelectorAll('.ma-p-expand') : []; const b = bs[0]; if (!b || bs.length < 2) return false; b.click(); return true })()`)
    const t0 = Date.now()
    let popTarget = null
    while (Date.now() - t0 < 20_000) {
      const ts = await cdpTargets(PORT).catch(() => [])
      popTarget = ts.find((t) => t.type === 'page' && t.url.includes('mapanel'))
      if (popTarget?.webSocketDebuggerUrl) break
      await sleep(200)
    }
    if (popTarget) {
      const pc = await Cdp.connect(popTarget.webSocketDebuggerUrl, { timeoutMs: 8000 })
      const pev = async (expr) => JSON.parse(await pc.eval(`(async () => JSON.stringify(${expr}))()`, { awaitPromise: true }))
      for (let i = 0; i < 60; i++) {
        const n = await pev(`document.querySelectorAll('.q-overlay .qcard, .q-mini').length`).catch(() => 0)
        if (n) break
        await sleep(200)
      }
      if (await pev(`document.querySelectorAll('.q-overlay .qcard').length`).catch(() => 0)) {
        await pev(`(() => { const b = [...document.querySelectorAll('.qcard .qmin')].pop(); if (!b) return false; b.click(); return true })()`)
      }
      await sleep(400)
      rep.surfaces.popout = await pev(MEASURE)
      try {
        const r = await pc.send('Page.captureScreenshot', { format: 'png' })
        fs.writeFileSync(path.join(REPO, '.poc-qmini-popout.png'), Buffer.from(r.data, 'base64'))
      } catch { /* 참고용 */ }
      pc.close?.()
    } else {
      rep.surfaces.popout = { err: 'popout target not found' }
    }
  } finally {
    if (!KEEP) {
      killTree(child.pid)
      await sleep(800)
      rmrf(path.join(REPO, '.poc-home-qmini-pos'))
    }
  }

  write(OUT, JSON.stringify(rep, null, 2))
  console.log(JSON.stringify(rep.surfaces, null, 2))
  if (rep.fail) console.log('FAIL-DIAG', JSON.stringify(rep.fail).slice(0, 2000))
  console.log('→', OUT)
}

main().catch((e) => {
  console.error('FAIL', e)
  process.exit(1)
})
