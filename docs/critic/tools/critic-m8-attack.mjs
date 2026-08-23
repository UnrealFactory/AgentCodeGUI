#!/usr/bin/env node
/* ============================================================================
 * critic-m8-attack — M8 R1(창 표면 3종) **공격 하네스** (크리틱 전용).
 *
 * 빌더의 poc-winsurface는 "행복 경로"를 잰다. 이쪽은 그 경로 밖을 민다.
 *
 *   A1 popout-rollback  스트리밍/턴 종료 한복판에 팝아웃을 닫으면 그리드가 되감기는가
 *   A2 dial-shrink      팝아웃 떠 있는 채 다이얼을 줄이면 그 창은 어떻게 되나(고아 관문)
 *   A3 many-windows     팝아웃 2 + 추가 채팅 창 1 동시 — 회계·프로세스·소유 라벨
 *   A4 toast-burst      연속 알림 10건 · ✕ 직후 재알림(파기/생성 경합)
 *   A5 tray-hidden      트레이 숨김 중 알림 → 복원 · 숨김 중 두 번째 실행 · 종료 경로
 *   A6 crash-popout     팝아웃 열린 채 렌더러 사망 → 재생성 회계(중복/누락)
 *
 * 안전: 이름 기반 kill 금지(spawn한 PID 트리만) · CCG_HOME 격리 · 실홈 무접촉.
 * ========================================================================== */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { cdpTargets, connectMainPage, killTree, sleep, Cdp, REPO } from '../../../bench/lib.mjs'

const args = process.argv.slice(2)
const only = (args.find((a) => a.startsWith('--only=')) ?? '').split('=')[1] || 'all'
const KEEP = args.includes('--keep')
const EXE = (args.find((a) => a.startsWith('--exe=')) ?? '').split('=')[1] || path.join(REPO, 'target', 'release', 'agentcodegui.exe')
const OUT = path.join(REPO, 'docs', 'critic', 'm8-r1-attack.json')

const rep = { at: new Date().toISOString(), exe: EXE, steps: {}, findings: [] }
const fail = (id, why, extra) => { rep.findings.push({ id, why, ...(extra ?? {}) }); console.error(`  ✗ ${id} — ${why}`) }
const ok = (id, d) => console.log(`  ✓ ${id}${d !== undefined ? ` — ${JSON.stringify(d)}` : ''}`)
const note = (id, d) => console.log(`  · ${id}${d !== undefined ? ` — ${JSON.stringify(d)}` : ''}`)

const write = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v)) }
const rmrf = (p) => { for (let i = 0; i < 10; i++) { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }); return } catch { spawnSync('cmd', ['/c', 'ping', '127.0.0.1', '-n', '2'], { stdio: 'ignore' }) } } }
const homeFor = (n) => path.join(REPO, `.critic-home-m8-${n}`)

const IPC = (channel, payload = []) =>
  `await window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: ${JSON.stringify(channel)}, payload: ${JSON.stringify(payload)} })`

async function boot(home, port, extraEnv = {}) {
  if (!fs.existsSync(EXE)) throw new Error(`exe 없음: ${EXE}`)
  const child = spawn(EXE, [], { cwd: REPO, env: { ...process.env, CCG_HOME: home, CCG_CDP_PORT: String(port), ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', (d) => (log += d.toString()))
  child.stderr.on('data', (d) => (log += d.toString()))
  const cdp = await connectMainPage(port, { timeoutMs: 60_000 })
  for (let i = 0; i < 300; i++) {
    const up = await cdp.eval(`(async () => { try { return !!(await window.api.app.getVersion()) } catch { return false } })()`, { awaitPromise: true }).catch(() => false)
    if (up) break
    await sleep(100)
  }
  const j = async (expr) => JSON.parse(await cdp.eval(`(async () => JSON.stringify(${expr}))()`, { awaitPromise: true }))
  return { child, cdp, j, port, log: () => log }
}
async function listTargets(port) {
  const ts = await cdpTargets(port).catch(() => [])
  return ts.filter((t) => t.type === 'page').map((t) => ({ url: t.url, ws: t.webSocketDebuggerUrl }))
}
async function findTarget(port, frag, ms = 15000) {
  const t0 = Date.now()
  for (;;) {
    const t = (await listTargets(port)).find((x) => x.url.includes(frag))
    if (t) return t
    if (Date.now() - t0 > ms) return null
    await sleep(120)
  }
}
async function goneTarget(port, frag, ms = 15000) {
  const t0 = Date.now()
  for (;;) {
    if (!(await listTargets(port)).some((x) => x.url.includes(frag))) return true
    if (Date.now() - t0 > ms) return false
    await sleep(120)
  }
}
async function attach(t) {
  const c = await Cdp.connect(t.ws, { timeoutMs: 8000 })
  return { cdp: c, j: async (expr) => JSON.parse(await c.eval(`(async () => JSON.stringify(${expr}))()`, { awaitPromise: true })) }
}
async function waitUntil(page, expr, ms = 20000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await page.j(`await (async () => !!(${expr}))()`).catch(() => false)) return true
    await sleep(100)
  }
  return false
}
const ps = (s) => execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', s], { encoding: 'utf8', timeout: 60000 }).trim()
const WIN32 = String.raw`
Add-Type @"
using System; using System.Runtime.InteropServices;
public class W {
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static string Dump(uint target){
    var sb = new System.Text.StringBuilder();
    EnumWindows((h,l)=>{ uint p; GetWindowThreadProcessId(h, out p); if(p!=target) return true;
      RECT r; GetWindowRect(h, out r); long area=(long)(r.Right-r.Left)*(r.Bottom-r.Top); if(area<10000) return true;
      var t=new System.Text.StringBuilder(256); GetWindowTextW(h,t,256);
      sb.Append(h.ToInt64()).Append('|').Append(IsWindowVisible(h)?1:0).Append('|').Append(r.Right-r.Left).Append('x').Append(r.Bottom-r.Top).Append('|').Append(t.ToString()).Append('\n');
      return true; }, IntPtr.Zero);
    return sb.ToString(); } }
"@
`
function winDump(pid) {
  return ps(`${WIN32}
[W]::Dump(${pid})`).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [hwnd, vis, size, ...rest] = l.split('|')
    return { hwnd, visible: vis === '1', size, title: rest.join('|') }
  })
}
function procCount(rootPid) {
  const out = ps(`$ErrorActionPreference='SilentlyContinue'
$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId
$want = New-Object System.Collections.Generic.HashSet[int]
[void]$want.Add(${rootPid})
for($i=0; $i -lt 6; $i++){ foreach($p in $all){ if($want.Contains([int]$p.ParentProcessId)){ [void]$want.Add([int]$p.ProcessId) } } }
$want.Count`)
  return Number(out)
}
const pidAlive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
/** 격리 홈의 chats/·boards/ 전수에서 마커를 찾는다 — 되감김이 디스크까지 갔나 */
function diskMarks(HOME) {
  const marks = ['MARK-ONE', 'MARK-TWO', 'MARK-THREE']
  const hit = new Set()
  const scan = (dir) => {
    let ents = []
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) scan(p)
      else if (e.name.endsWith('.json')) {
        let txt = ''
        try { txt = fs.readFileSync(p, 'utf8') } catch { continue }
        for (const m of marks) if (txt.includes(m)) hit.add(m)
      }
    }
  }
  scan(path.join(HOME, 'chats'))
  scan(path.join(HOME, 'chats-v3')) // ★ 통합 스토어의 실제 저장 자리 — 멀티 패널 스냅샷이 여기 있다
  scan(path.join(HOME, 'boards'))
  scan(path.join(HOME, 'multi-agent'))
  return marks.filter((m) => hit.has(m))
}

// ── 홈 씨앗 ─────────────────────────────────────────────────────────────────
function seedFakeCli(HOME) {
  const stub = path.join(REPO, 'target', 'release', 'ccg-fakecli.exe')
  if (!fs.existsSync(stub)) throw new Error(`가짜 CLI 없음: ${stub}`)
  const ed = path.join(HOME, 'engines', 'fake', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64')
  fs.mkdirSync(ed, { recursive: true })
  fs.copyFileSync(stub, path.join(ed, 'claude.exe'))
  write(path.join(HOME, 'config.json'), { activeVersion: 'fake' })
  write(path.join(HOME, 'accounts.json'), { defaultEmail: 'fake@example.com', accounts: [{ email: 'fake@example.com' }] })
  fs.mkdirSync(path.join(HOME, 'accounts', 'fake_example.com'), { recursive: true })
}
/** 여러 번에 걸쳐 답을 뱉는 대본 — 되감기 손실을 재는 재료 */
function slowScript(HOME, WORK) {
  const SCRIPT = path.join(HOME, 'script.jsonl')
  const asst = (text) => ({ emit: { type: 'assistant', session_id: 'POP-1', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text }], usage: { input_tokens: 5 } } } })
  fs.writeFileSync(SCRIPT, [
    { afterMs: 60, emit: { type: 'control_response', response: { subtype: 'success', request_id: 'init-1', response: {} } } },
    { emit: { type: 'system', subtype: 'init', session_id: 'POP-1', model: 'claude-haiku', cwd: WORK, tools: [], apiKeySource: 'none' } },
    { afterMs: 150, ...asst('MARK-ONE 첫 조각') },
    { afterMs: 2600, ...asst('MARK-TWO 둘째 조각') },
    { afterMs: 2600, ...asst('MARK-THREE 셋째 조각') },
    { afterMs: 60, emit: { type: 'result', subtype: 'success', is_error: false, result: 'MARK-THREE 셋째 조각', session_id: 'POP-1', total_cost_usd: 0, duration_ms: 1, num_turns: 1 } }
  ].map((s) => JSON.stringify(s)).join('\n') + '\n')
  return SCRIPT
}
function seedMulti(name, opts = {}) {
  const HOME = homeFor(name)
  const WORK = path.join(HOME, 'work')
  rmrf(HOME)
  fs.mkdirSync(WORK, { recursive: true })
  seedFakeCli(HOME)
  write(path.join(HOME, 'ui-prefs.json'), { 'ui.lang': 'ko', 'workspace.mode': 'multi', 'whatsnew.seenVersion': '9.9.9', 'notify.toast': true, ...(opts.prefs ?? {}) })
  write(path.join(HOME, 'profile.json'), { nickname: 'critic' })
  write(path.join(HOME, 'chats', 'index.json'), { version: 1, order: ['c-main'], activeChatId: 'c-main' })
  write(path.join(HOME, 'chats', 'c-main.json'), { id: 'c-main', title: '본채팅', custom: true, manualCwd: WORK, picker: { model: 'haiku', effort: 'minimal', mode: 'normal' }, refDirs: [], snapshot: { messages: [] }, updatedAt: 1 })
  const SCRIPT = slowScript(HOME, WORK)
  return { HOME, WORK, SCRIPT }
}
function seedSingle(name, opts = {}) {
  const HOME = homeFor(name)
  const WORK = path.join(HOME, 'work')
  rmrf(HOME)
  fs.mkdirSync(WORK, { recursive: true })
  seedFakeCli(HOME)
  write(path.join(HOME, 'ui-prefs.json'), { 'ui.lang': 'ko', 'workspace.mode': 'single', 'whatsnew.seenVersion': '9.9.9', 'notify.toast': true, ...(opts.prefs ?? {}) })
  write(path.join(HOME, 'profile.json'), { nickname: 'critic' })
  write(path.join(HOME, 'chats', 'index.json'), { version: 1, order: ['c-main'], activeChatId: 'c-main' })
  write(path.join(HOME, 'chats', 'c-main.json'), { id: 'c-main', title: '본채팅', custom: true, manualCwd: WORK, picker: { model: 'haiku', effort: 'minimal', mode: 'normal' }, refDirs: [], snapshot: { messages: [] }, updatedAt: 1 })
  return { HOME, WORK }
}

// 패널 자리에 채팅을 앉힌다(F2 이름) — 빌더 하네스와 같은 사용자 경로
async function nameSlot(app, slotSel, title) {
  await app.j(`(() => { const b = document.querySelector('${slotSel} .ma-p-tedit'); if (!b) return 'no'; b.click(); return 'ok' })()`)
  await waitUntil(app, `document.querySelector('${slotSel} .ma-p-tin')`, 6000)
  return app.j(`(() => {
    const el = document.querySelector('${slotSel} .ma-p-tin'); if (!el) return 'no-input'
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    set.call(el, ${JSON.stringify(title)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return 'named'
  })()`)
}
const POPOUT_BTN = (slotSel) => `(() => {
  const b = [...document.querySelectorAll('${slotSel} button')].find((x) => /별도 창으로|own window/.test(x.getAttribute('aria-label') || ''))
  if (!b) return false
  b.click(); return true })()`

// ─────────────────────────────────────────────────────────────────────────────
// A1 — 되감기: 스트리밍 한복판 / 턴 종료 직후에 팝아웃을 닫으면?
// ─────────────────────────────────────────────────────────────────────────────
async function a1(closeWhen /* 'mid' | 'end' */, tagName) {
  console.log(`\n[A1:${tagName}] 팝아웃 닫기 타이밍 — 그리드 되감기`)
  const s = seedMulti(`a1-${tagName}`)
  const port = 9411 + (closeWhen === 'end' ? 1 : 0)
  const out = { closeWhen }
  const app = await boot(s.HOME, port, { CCG_FAKECLI_SCRIPT: s.SCRIPT })
  try {
    if (!(await waitUntil(app, `document.querySelector('.multi .ma-grid .ma-panel')`, 40000))) { fail(`${tagName}-부팅`, '그리드 미표시'); return }
    await sleep(1200)
    await nameSlot(app, '.ma-panel[data-slot="0"]', '되감기 대상')
    await waitUntil(app, `(await (async () => { const b = ${IPC('board:get')}; return (b?.boards ?? []).some((x) => x.id !== 'default' && (x.slots ?? []).some((v) => !!v)) })())`, 20000)
    // 팝아웃
    await app.j(POPOUT_BTN('.ma-panel[data-slot="0"]'))
    const pt = await findTarget(port, '#mapanel', 20000)
    if (!pt) { fail(`${tagName}-팝아웃`, '창이 안 떴다'); return }
    const pop = await attach(pt)
    await waitUntil(pop, `document.querySelector('.sw.pwin .pw-body .ma-panel')`, 25000)
    out.panelId = await pop.j(`(await window.api.multi.panelHydrate())?.panelId ?? null`)
    // 창의 컴포저에서 전송
    await sleep(600)
    await pop.j(`(() => { const ta = document.querySelector('.pw-body .composer textarea') || document.querySelector('.pw-body textarea')
      if (!ta) return 'no'
      const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      set.call(ta, '되감기 시험'); ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus()
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return 'sent' })()`)

    if (closeWhen === 'mid') {
      // MARK-TWO가 창에 뜬 **직후**(<600ms) 닫는다 — 그 사이 새 페르시스트는 못 내려간다
      if (!(await waitUntil(pop, `document.body.innerText.includes('MARK-TWO')`, 25000))) { fail(`${tagName}-대본`, 'MARK-TWO 미도착'); return }
    } else {
      if (!(await waitUntil(pop, `document.body.innerText.includes('MARK-THREE')`, 25000))) { fail(`${tagName}-대본`, 'MARK-THREE 미도착'); return }
    }
    out.popTextAtClose = await pop.j(`['MARK-ONE','MARK-TWO','MARK-THREE'].filter((m) => document.body.innerText.includes(m))`)
    out.flushAtClose = (await app.j(`${IPC('win:surface-debug')}`))?.popout?.flushes ?? []
    out.gridBeforeClose = await app.j(`['MARK-ONE','MARK-TWO','MARK-THREE'].filter((m) => document.body.innerText.includes(m))`)
    const tClose = Date.now()
    await pop.j(`(window.api.win.close(), 'x')`).catch(() => {})
    out.closedGone = await goneTarget(port, '#mapanel', 15000)
    out.closeMs = Date.now() - tClose
    await sleep(1800)
    out.gridAfterClose = await app.j(`['MARK-ONE','MARK-TWO','MARK-THREE'].filter((m) => document.body.innerText.includes(m))`)
    // 스트리밍 중이었으면 남은 대본이 계속 흐른다 — 다 끝난 뒤 최종 상태
    await sleep(4500)
    out.gridFinal = await app.j(`['MARK-ONE','MARK-TWO','MARK-THREE'].filter((m) => document.body.innerText.includes(m))`)
    out.gridMsgCount = await app.j(`document.querySelectorAll('.ma-panel .msg, .ma-panel .bubble').length`)
    // 디스크에 저장된 스냅샷 — 되감김이 영속됐는가 (chats/ma-*.json · boards/*.json 전수)
    await sleep(1500)
    out.diskMarks = diskMarks(s.HOME)
    const want = closeWhen === 'mid' ? ['MARK-ONE', 'MARK-TWO', 'MARK-THREE'] : ['MARK-ONE', 'MARK-TWO', 'MARK-THREE']
    const lost = want.filter((m) => !out.gridFinal.includes(m))
    if (lost.length) fail(`${tagName}-되감기`, `팝아웃을 닫았더니 그리드에서 답변 조각이 사라졌다: ${lost.join(',')}`, { pop: out.popTextAtClose, grid: out.gridFinal, disk: out.diskMarks, flush: out.flushAtClose })
    else ok(`${tagName}-되감기없음`, { grid: out.gridFinal, disk: out.diskMarks })
    note(`${tagName}-회계`, { flushAtClose: out.flushAtClose, gridBefore: out.gridBeforeClose, gridAfter: out.gridAfterClose })
  } finally {
    killTree(app.child.pid); await sleep(700); if (!KEEP) rmrf(s.HOME)
  }
  rep.steps[`a1-${tagName}`] = out
}

// ─────────────────────────────────────────────────────────────────────────────
// A2 — 팝아웃 떠 있는 채로 다이얼 축소 (고아 UI 정리 관문)
// ─────────────────────────────────────────────────────────────────────────────
async function a2() {
  console.log('\n[A2] 팝아웃 + 다이얼 축소 — 자리 정리 규약')
  const s = seedMulti('a2')
  const port = 9413
  const out = {}
  const app = await boot(s.HOME, port, { CCG_FAKECLI_SCRIPT: s.SCRIPT })
  try {
    if (!(await waitUntil(app, `document.querySelector('.multi .ma-grid .ma-panel')`, 40000))) { fail('A2-부팅', '그리드 미표시'); return }
    await sleep(1200)
    out.count0 = await app.j(`document.querySelectorAll('.ma-grid .ma-panel').length`)
    // 2번 자리(data-slot=1)를 채우고 팝아웃
    await nameSlot(app, '.ma-panel[data-slot="1"]', '축소 대상')
    await sleep(1200)
    await app.j(POPOUT_BTN('.ma-panel[data-slot="1"]'))
    const pt = await findTarget(port, '#mapanel', 20000)
    if (!pt) { fail('A2-팝아웃', '창이 안 떴다'); return }
    const pop = await attach(pt)
    await waitUntil(pop, `document.querySelector('.sw.pwin .pw-body .ma-panel')`, 25000)
    out.ghostBefore = await app.j(`!!document.querySelector('.ma-grid .ma-panel.ma-ghost.pop')`)
    // 다이얼 축소는 **포커스된 자리를 1번으로 승격**시킨다(applyCount). 팝아웃 자리가
    // 접히는 상황을 보려면 다른 자리에 포커스를 둬야 한다 — 0번 패널을 눌러 둔다.
    await app.j(`(() => { const p = document.querySelector('.ma-panel[data-slot="0"]'); if (!p) return 'no'
      p.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }))
      return 'focus0' })()`)
    await sleep(600)
    out.focusedBefore = await app.j(`[...document.querySelectorAll('.ma-grid .ma-panel')].map((e) => e.dataset.slot + ':' + (e.className.includes('focused') ? 'F' : '-'))`)
    // 다이얼 1로 — 자리 1은 접힌다
    out.dialClicked = await app.j(`(() => { const b = document.querySelector('.ma-count-btn[data-count="1"]'); if (!b) return 'no-dial'; b.click(); return 'ok' })()`)
    await sleep(1800)
    out.gridPanels = await app.j(`document.querySelectorAll('.ma-grid .ma-panel').length`)
    out.ghostAfter = await app.j(`!!document.querySelector('.ma-grid .ma-panel.ma-ghost.pop')`)
    out.popStillOpen = !!(await findTarget(port, '#mapanel', 2500))
    out.surface = await app.j(`${IPC('win:surface-debug')}`)
    out.osWindows = winDump(app.child.pid).map((w) => ({ visible: w.visible, size: w.size, title: w.title }))
    if (out.popStillOpen && !out.ghostAfter) {
      fail('A2-고아창', '다이얼을 줄여 자리를 접었는데 그 자리의 팝아웃 OS 창이 그대로 남았다(그리드에 되돌아갈 표식 없음)', {
        gridPanels: out.gridPanels, popouts: out.surface?.popout?.windows, osWindows: out.osWindows
      })
    } else ok('A2-자리정리', { popStillOpen: out.popStillOpen, ghostAfter: out.ghostAfter })
    // 그 상태에서 창을 닫으면 접힌 자리로 복귀분이 들어가나 (증발? 되메움?)
    await pop.j(`(window.api.win.close(), 'x')`).catch(() => {})
    await goneTarget(port, '#mapanel', 12000)
    await sleep(1800)
    out.surfaceAfterClose = await app.j(`${IPC('win:surface-debug')}`)
    out.leftoversAfterClose = out.surfaceAfterClose?.popout?.leftovers ?? []
    note('A2-닫은뒤', { leftovers: out.leftoversAfterClose, windows: out.surfaceAfterClose?.windows })
    // 다이얼을 되올리면 그 자리가 정상으로 돌아오나
    await app.j(`(() => { const b = document.querySelector('.ma-count-btn[data-count="4"]'); b && b.click(); return 'ok' })()`)
    await sleep(1500)
    out.restoredTitle = await app.j(`[...document.querySelectorAll('.ma-grid .ma-panel .ma-p-title')].map((e) => e.textContent)`)
    out.restoredGhost = await app.j(`!!document.querySelector('.ma-grid .ma-panel.ma-ghost.pop')`)
    if (out.restoredGhost) fail('A2-유령잔존', '창을 닫았는데 다이얼을 되올리니 그 자리가 여전히 팝아웃 유령이다', { titles: out.restoredTitle })
    else ok('A2-되올림', { titles: out.restoredTitle })
  } finally {
    killTree(app.child.pid); await sleep(700); if (!KEEP) rmrf(s.HOME)
  }
  rep.steps.a2 = out
}

// ─────────────────────────────────────────────────────────────────────────────
// A3 — 팝아웃 2개 + 추가 채팅 창 1개 동시
// ─────────────────────────────────────────────────────────────────────────────
async function a3() {
  console.log('\n[A3] 팝아웃 2 + 추가 채팅 창 1 동시')
  const s = seedMulti('a3')
  const port = 9414
  const out = {}
  const app = await boot(s.HOME, port, { CCG_FAKECLI_SCRIPT: s.SCRIPT })
  try {
    if (!(await waitUntil(app, `document.querySelector('.multi .ma-grid .ma-panel')`, 40000))) { fail('A3-부팅', '그리드 미표시'); return }
    await sleep(1200)
    out.procs0 = procCount(app.child.pid)
    await nameSlot(app, '.ma-panel[data-slot="0"]', '팝아웃 A')
    await sleep(900)
    await nameSlot(app, '.ma-panel[data-slot="1"]', '팝아웃 B')
    await sleep(1400)
    await app.j(POPOUT_BTN('.ma-panel[data-slot="0"]'))
    await sleep(1500)
    await app.j(POPOUT_BTN('.ma-panel[data-slot="1"]'))
    await sleep(2500)
    out.mapanelPages = (await listTargets(port)).filter((t) => t.url.includes('#mapanel')).length
    // 추가 채팅 창
    await app.j(`(window.api.openSessionWindow(), 'open')`)
    await findTarget(port, '#session', 20000)
    await sleep(2500)
    out.surface = await app.j(`${IPC('win:surface-debug')}`)
    out.windows = out.surface?.windows ?? []
    out.popouts = out.surface?.popout?.windows ?? []
    out.procs1 = procCount(app.child.pid)
    out.pages = (await listTargets(port)).map((t) => t.url.replace(/^.*\/(?=[^/]*$)/, ''))
    out.osWindows = winDump(app.child.pid).filter((w) => w.visible).map((w) => ({ size: w.size, title: w.title }))
    if (out.mapanelPages !== 2) fail('A3-두창', `팝아웃 두 개가 안 떴다(#mapanel 페이지 ${out.mapanelPages})`, { pages: out.pages })
    else ok('A3-두창', { mapanel: out.mapanelPages })
    if (out.procs1 !== out.procs0) fail('A3-프로세스', `창 3개를 더 열었더니 프로세스가 늘었다 ${out.procs0}→${out.procs1}`)
    else ok('A3-프로세스불변', { procs: out.procs1 })
    ok('A3-라벨', { windows: out.windows, popouts: out.popouts })
    // 한쪽만 닫아도 다른 쪽이 멀쩡한가
    const first = out.popouts[0]?.panelId
    await app.j(`${IPC('ma:panel-close', [first])}`)
    await sleep(2000)
    out.afterOneClose = await app.j(`${IPC('win:surface-debug')}`)
    out.mapanelAfter = (await listTargets(port)).filter((t) => t.url.includes('#mapanel')).length
    if (out.mapanelAfter !== 1) fail('A3-부분닫기', `하나만 닫았는데 남은 팝아웃 수가 1이 아니다(${out.mapanelAfter})`, out.afterOneClose?.popout)
    else ok('A3-부분닫기', { left: out.afterOneClose?.popout?.windows })
  } finally {
    killTree(app.child.pid); await sleep(700); if (!KEEP) rmrf(s.HOME)
  }
  rep.steps.a3 = out
}

// ─────────────────────────────────────────────────────────────────────────────
// A4 — 토스트 폭주 10건 · 소멸 규약 · ✕ 직후 재알림(파기/생성 경합)
// ─────────────────────────────────────────────────────────────────────────────
async function a4() {
  console.log('\n[A4] 토스트 폭주 · 소멸 · 파기/생성 경합')
  const s = seedSingle('a4')
  const port = 9415
  const out = {}
  const app = await boot(s.HOME, port)
  try {
    await waitUntil(app, `document.querySelector('#root').children.length > 0`, 30000)
    await sleep(900)
    await app.j(`(window.api.win.minimize(), 'min')`)
    await sleep(900)
    // 10건 연속
    const t0 = Date.now()
    await app.j(`(() => { for (let i = 0; i < 10; i++) window.api.notify.event({ kind: i % 2 ? 'ask' : 'done', title: '채팅' + i, preview: '알림 ' + i, target: { surface: 'single', id: 'c-' + i } }); return 'burst' })()`)
    const tt = await findTarget(port, 'toast.html', 15000)
    out.burstShowMs = Date.now() - t0
    if (!tt) { fail('A4-폭주표시', '10건을 보냈는데 토스트 창이 안 떴다', { dbg: await app.j(`${IPC('win:surface-debug')}`) }); return }
    const toast = await attach(tt)
    await waitUntil(toast, `document.querySelectorAll('#card .t-agg .t-row').length >= 10`, 12000)
    out.rows = await toast.j(`document.querySelectorAll('#card .t-agg .t-row').length`)
    out.dbg = await app.j(`${IPC('win:surface-debug')}`)
    out.bounds = await toast.j(`({ w: window.outerWidth, h: window.outerHeight, x: window.screenX, y: window.screenY, availW: window.screen.availWidth, availH: window.screen.availHeight })`)
    out.onScreen = out.bounds.y >= -2 && out.bounds.y + out.bounds.h <= out.bounds.availH + 2 && out.bounds.x + out.bounds.w <= out.bounds.availW + 24
    if (out.rows !== 10) fail('A4-행수', `10건인데 행이 ${out.rows}개다`, { count: out.dbg?.notify?.count })
    else ok('A4-행수', { rows: out.rows, count: out.dbg?.notify?.count, ms: out.burstShowMs })
    if (!out.onScreen) fail('A4-자리', '10행 카드가 작업 영역을 벗어났다', out.bounds)
    else ok('A4-자리', out.bounds)

    // (b) **포커스 회복만으로** 사라지는가 — 빌더 T6는 클릭이 이미 비운 뒤라 이걸 못 잰다
    await app.cdp.send('Page.bringToFront').catch(() => {})
    await app.j(`(window.api.win.maximize ? null : null, 'noop')`).catch(() => {})
    await sleep(2000)
    out.goneOnFocus = await goneTarget(port, 'toast.html', 12000)
    out.dbgAfterFocus = await app.j(`${IPC('win:surface-debug')}`)
    if (!out.goneOnFocus) fail('A4-포커스소멸', '본창이 포커스를 되찾았는데 토스트 10건이 안 사라졌다', out.dbgAfterFocus?.notify)
    else ok('A4-포커스소멸', { pending: out.dbgAfterFocus?.notify?.count })

    // (c) ✕ 직후 곧바로 새 알림 — 파기 중 창이 아직 맵에 있으면 ensure()가 조기 반환한다
    await app.j(`(window.api.win.minimize(), 'min')`)
    await sleep(900)
    await app.j(`(window.api.notify.event({ kind: 'done', title: '경합-1', preview: 'p', target: { surface: 'single', id: 'r-1' } }), 'e1')`)
    const t2 = await findTarget(port, 'toast.html', 12000)
    out.racePre = !!t2
    if (t2) {
      const tw = await attach(t2)
      // ✕ → 목록 비움 → 창 파기. 그 **직후** 새 알림을 던진다.
      await tw.j(`(document.querySelector('#close')?.click(), 'x')`).catch(() => {})
      for (let d of [0, 30, 80, 150]) {
        await sleep(d)
        await app.j(`(window.api.notify.event({ kind: 'done', title: '경합-${d}', preview: 'p', target: { surface: 'single', id: 'r-${d}' } }), 'e')`)
      }
      out.raceBack = !!(await findTarget(port, 'toast.html', 8000))
      await sleep(1500)
      out.raceDbg = await app.j(`${IPC('win:surface-debug')}`)
      out.raceVisible = out.raceBack ? await (async () => { const t = await findTarget(port, 'toast.html', 2000); if (!t) return null; const w = await attach(t); const v = await w.j(`document.querySelectorAll('#card .t-row').length + (document.querySelector('#card .t-body') ? 1 : 0)`); w.cdp.close(); return v })() : null
      if (!out.raceBack) fail('A4-경합', '✕ 직후 온 알림이 토스트를 못 띄웠다(파기/생성 경합)', out.raceDbg?.notify)
      else if (out.raceDbg?.notify?.count > 0 && !out.raceVisible) fail('A4-빈카드', '알림은 대기 중인데 카드가 비었다', { dbg: out.raceDbg?.notify, visible: out.raceVisible })
      else ok('A4-경합', { back: out.raceBack, count: out.raceDbg?.notify?.count, visibleItems: out.raceVisible })
    }
  } finally {
    killTree(app.child.pid); await sleep(700); if (!KEEP) rmrf(s.HOME)
  }
  rep.steps.a4 = out
}

// ─────────────────────────────────────────────────────────────────────────────
// A5 — 트레이 숨김 중 알림 · 복원 · 두 번째 실행 · 종료 도달성
// ─────────────────────────────────────────────────────────────────────────────
async function a5() {
  console.log('\n[A5] 트레이 숨김 중 알림 · 복원 · 두 번째 실행')
  const s = seedSingle('a5')
  const port = 9416
  const out = {}
  const app = await boot(s.HOME, port)
  let exited = false
  try {
    await waitUntil(app, `document.querySelector('#root').children.length > 0`, 30000)
    await sleep(900)
    // X = 숨김
    await app.j(`(window.api.win.close(), 'x')`)
    await sleep(1500)
    out.visibleAfterX = winDump(app.child.pid).filter((w) => w.visible).length
    out.aliveAfterX = pidAlive(app.child.pid)
    // 숨김 상태에서 알림
    await app.j(`(window.api.notify.event({ kind: 'done', title: '숨김중', preview: '트레이에 있는 동안 온 알림', target: { surface: 'single', id: 'c-main' } }), 'e')`)
    const tt = await findTarget(port, 'toast.html', 15000)
    out.toastWhileHidden = !!tt
    if (!tt) fail('A5-숨김알림', '트레이에 숨은 동안 온 알림이 토스트로 안 떴다', { dbg: await app.j(`${IPC('win:surface-debug')}`) })
    else ok('A5-숨김알림')
    // 토스트 클릭 → 숨은 본창이 되살아나는가
    if (tt) {
      const toast = await attach(tt)
      await waitUntil(toast, `document.querySelector('#card .t-body')`, 10000)
      await toast.j(`(document.querySelector('#card .t-body')?.click(), 'click')`).catch(() => {})
      await sleep(2000)
      out.visibleAfterClick = winDump(app.child.pid).filter((w) => w.visible).map((w) => ({ size: w.size, title: w.title }))
      out.restored = out.visibleAfterClick.some((w) => Number(w.size.split('x')[0]) > 600)
      if (!out.restored) fail('A5-복원', '토스트를 눌렀는데 숨은 본창이 안 돌아왔다', { wins: out.visibleAfterClick })
      else ok('A5-복원', out.visibleAfterClick)
    }
    // 다시 숨기고 → 두 번째 실행
    await app.j(`(window.api.win.close(), 'x')`)
    await sleep(1400)
    const t0 = Date.now()
    const second = spawn(EXE, [], { cwd: REPO, env: { ...process.env, CCG_HOME: s.HOME }, stdio: 'ignore' })
    let code = null
    second.on('exit', (c) => (code = c))
    for (let i = 0; i < 100 && code === null; i++) await sleep(100)
    out.secondExit = { code, ms: Date.now() - t0 }
    let raised = false
    for (let i = 0; i < 60; i++) { if (winDump(app.child.pid).some((w) => w.visible)) { raised = true; break } await sleep(200) }
    out.raised = raised
    out.raisedMs = Date.now() - t0
    if (code !== 0) fail('A5-두번째', `두 번째 인스턴스 exit=${code}`, out.secondExit)
    else ok('A5-두번째', out.secondExit)
    if (!raised) fail('A5-전면', '두 번째 실행이 숨은 창을 못 올렸다')
    else ok('A5-전면', { ms: out.raisedMs })
    // 종료 경로 — 진단 채널로 메뉴를 열고 '완전히 종료'
    await app.j(`(window.api.win.close(), 'x')`)
    await sleep(1200)
    out.hiddenBeforeQuit = winDump(app.child.pid).filter((w) => w.visible).length
    await app.j(`${IPC('win:surface-debug', ['traymenu-open'])}`)
    const mt = await findTarget(port, 'tray.html', 15000)
    out.menuWhileHidden = !!mt
    if (!mt) fail('A5-숨김메뉴', '숨은 상태에서 트레이 메뉴 창이 안 떴다')
    else {
      const menu = await attach(mt)
      out.menuItems = await menu.j(`[...document.querySelectorAll('#menu .row')].map((r) => r.innerText)`)
      ok('A5-숨김메뉴', out.menuItems)
      await menu.j(`(window.api.trayMenu.action('quit'), 'q')`).catch(() => {})
      for (let i = 0; i < 80 && pidAlive(app.child.pid); i++) await sleep(100)
      exited = !pidAlive(app.child.pid)
      out.quitFromHidden = exited
      if (!exited) fail('A5-숨김종료', '숨은 상태에서 완전히 종료가 안 됐다')
      else ok('A5-숨김종료')
    }
  } finally {
    if (!exited) killTree(app.child.pid)
    await sleep(700); if (!KEEP) rmrf(s.HOME)
  }
  rep.steps.a5 = out
}

// ─────────────────────────────────────────────────────────────────────────────
// A6 — 팝아웃 열린 채 렌더러 사망 → 재생성 회계
// ─────────────────────────────────────────────────────────────────────────────
async function a6() {
  console.log('\n[A6] 팝아웃 열린 채 렌더러 사망 → 재생성 회계')
  const s = seedMulti('a6')
  const port = 9417
  const out = {}
  const app = await boot(s.HOME, port, { CCG_FAKECLI_SCRIPT: s.SCRIPT })
  try {
    if (!(await waitUntil(app, `document.querySelector('.multi .ma-grid .ma-panel')`, 40000))) { fail('A6-부팅', '그리드 미표시'); return }
    await sleep(1200)
    await nameSlot(app, '.ma-panel[data-slot="0"]', '크래시 대상')
    await sleep(1400)
    await app.j(POPOUT_BTN('.ma-panel[data-slot="0"]'))
    const pt = await findTarget(port, '#mapanel', 20000)
    if (!pt) { fail('A6-팝아웃', '창이 안 떴다'); return }
    const pop = await attach(pt)
    await waitUntil(pop, `document.querySelector('.sw.pwin .pw-body .ma-panel')`, 25000)
    // 창의 컴포저에서 턴 하나 돌린다 — 복구가 그 스레드를 지키는지 볼 재료
    await pop.j(`(() => { const ta = document.querySelector('.pw-body .composer textarea') || document.querySelector('.pw-body textarea')
      const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      set.call(ta, '크래시 전 발화'); ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus()
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return 'sent' })()`)
    await waitUntil(pop, `document.body.innerText.includes('MARK-THREE')`, 30000)
    await sleep(1500)
    out.before = await app.j(`${IPC('win:surface-debug')}`)
    const logPath = path.join(s.HOME, 'crash-recovery.log')
    const cut = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').length : 0
    await pop.cdp.send('Page.crash', {}, { timeoutMs: 3000 }).catch(() => {})
    await sleep(9000)
    out.pages = (await listTargets(port)).map((t) => t.url.replace(/^.*\/(?=[^/]*$)/, ''))
    out.mapanelPages = out.pages.filter((u) => u.includes('#mapanel')).length
    const tail = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').slice(cut) : ''
    out.log = tail.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l).event } catch { return l.slice(0, 30) } })
    // 새 메인 창에 붙어서 회계를 읽는다.
    // ★ 주의: 팝아웃 URL도 `index.html#mapanel`이라 'index.html' 부분일치로 고르면
    //   팝아웃 페이지에 붙는다(빌더 하네스 phaseDefense의 D3도 같은 자리다).
    const mainOf = async () => {
      const t0 = Date.now()
      for (;;) {
        // 메인 창의 URL은 `http://tauri.localhost/` — **'index.html'이 아예 없다.**
        // 'index.html' 부분일치로 고르면 팝아웃(`index.html#mapanel`)이 먼저 잡힌다.
        const t = (await listTargets(port)).find((x) => !/\.html/.test(x.url))
        if (t) return t
        if (Date.now() - t0 > 20000) return null
        await sleep(150)
      }
    }
    const mt = await mainOf()
    out.mainUrl = mt?.url ?? null
    const main2 = mt ? await attach(mt) : null
    if (main2) {
      await waitUntil(main2, `document.getElementById('root')?.children.length > 0`, 25000)
      await sleep(2500)
      out.after = await main2.j(`${IPC('win:surface-debug')}`)
      out.ghost = await main2.j(`!!document.querySelector('.ma-grid .ma-panel.ma-ghost.pop')`)
      out.gridMarks = await main2.j(`['MARK-ONE','MARK-TWO','MARK-THREE'].filter((m) => document.body.innerText.includes(m))`)
      // 왜 유령이 없나 — 셸이 여전히 열린 창을 알고 있는지 / 렌더러가 무엇을 물었는지
      out.boardAfter = await main2.j(`${IPC('board:get')}`)
      const active = out.boardAfter?.activeBoardId ?? ''
      out.statesForActive = await main2.j(`${IPC('ma:panel-states', ['__ACTIVE__'])}`.replace('__ACTIVE__', active))
      out.composerLive = await main2.j(`!!document.querySelector('.ma-grid .ma-panel .composer textarea:not([disabled])')`)
      out.cells = await main2.j(`[...document.querySelectorAll('.ma-grid .ma-panel')].map((e) => ({ slot: e.dataset.slot, cls: e.className, marks: ['MARK-ONE','MARK-TWO','MARK-THREE'].filter((m) => e.innerText.includes(m)), composer: !!e.querySelector('.composer textarea') }))`)
    }
    const pt2 = await findTarget(port, '#mapanel', 15000)
    out.popBack = !!pt2
    if (pt2) {
      const p2 = await attach(pt2)
      out.popMounted = await waitUntil(p2, `document.querySelector('.sw.pwin .pw-body .ma-panel')`, 20000)
      out.popMarks = await p2.j(`['MARK-ONE','MARK-TWO','MARK-THREE'].filter((m) => document.body.innerText.includes(m))`)
      p2.cdp.close()
    }
    if (out.mapanelPages !== 1) fail('A6-중복', `복구 뒤 팝아웃 창 수가 1이 아니다(${out.mapanelPages})`, { pages: out.pages, popouts: out.after?.popout?.windows })
    else ok('A6-창수', { mapanel: out.mapanelPages, popouts: out.after?.popout?.windows?.length })
    if (!out.ghost) fail('A6-유령표식', '복구 뒤 그리드에 팝아웃 유령 표식이 없다(창은 떠 있는데 그리드는 모른다)', { popouts: out.after?.popout?.windows })
    else ok('A6-유령표식')
    if (out.popMarks && out.popMarks.length !== 3) fail('A6-스레드', `복구된 팝아웃의 스레드가 줄었다: ${JSON.stringify(out.popMarks)}`)
    else ok('A6-스레드', { pop: out.popMarks, grid: out.gridMarks })
    note('A6-로그', out.log.slice(0, 14))
  } finally {
    killTree(app.child.pid); await sleep(700); if (!KEEP) rmrf(s.HOME)
  }
  rep.steps.a6 = out
}

// ─────────────────────────────────────────────────────────────────────────────
// A7 — UI 언어 en에서 트레이 메뉴 라벨 (ui-prefs 키 대조)
// ─────────────────────────────────────────────────────────────────────────────
async function a7() {
  console.log('\n[A7] UI 언어 en — 트레이 메뉴 라벨')
  const s = seedSingle('a7', { prefs: { 'ui.lang': 'en' } })
  const port = 9418
  const out = {}
  const app = await boot(s.HOME, port)
  try {
    await waitUntil(app, `document.querySelector('#root').children.length > 0`, 30000)
    await sleep(900)
    out.rendererLang = await app.j(`(await window.api.uiPrefs.get())['ui.lang'] ?? null`).catch(() => null)
    out.rendererEnglish = await app.j(`/Settings|Chat|New chat|Code/.test(document.body.innerText)`)
    await app.j(`${IPC('win:surface-debug', ['traymenu-open'])}`)
    const mt = await findTarget(port, 'tray.html', 15000)
    if (!mt) { fail('A7-메뉴', '메뉴 창이 안 떴다'); return }
    const menu = await attach(mt)
    await waitUntil(menu, `document.querySelectorAll('#menu .row').length >= 2`, 10000)
    out.items = await menu.j(`[...document.querySelectorAll('#menu .row')].map((r) => r.innerText)`)
    const korean = out.items.some((x) => /[가-힣]/.test(x))
    if (korean) fail('A7-언어', `UI 언어가 en인데 트레이 메뉴가 한국어다: ${JSON.stringify(out.items)}`, { prefKey: 'tray.rs는 ui-prefs "lang"을 읽는다 — 렌더러/다른 Rust는 "ui.lang"', rendererLang: out.rendererLang })
    else ok('A7-언어', out.items)
  } finally {
    killTree(app.child.pid); await sleep(700); if (!KEEP) rmrf(s.HOME)
  }
  rep.steps.a7 = out
}

// ─────────────────────────────────────────────────────────────────────────────
// A8 — 팝아웃 창이 **유리 감시 목록에 실제로 올라갔나**
//      (빌더 D1은 팝아웃 문서의 부팅 스냅샷 windows=1을 근거로 들지만, 그 스냅샷은
//       glass::arm 이전에 만들어진 값이라 자기 자신이 안 들어 있다. 두 번째 창의
//       부팅 스냅샷이 1→2로 늘어야 arm이 실제로 걸린 것이다.)
// ─────────────────────────────────────────────────────────────────────────────
async function a8() {
  console.log('\n[A8] 팝아웃이 유리 감시 목록에 올라갔나 (두 번째 창 스냅샷)')
  const s = seedMulti('a8')
  const port = 9419
  const out = {}
  const app = await boot(s.HOME, port, { CCG_FAKECLI_SCRIPT: s.SCRIPT })
  try {
    if (!(await waitUntil(app, `document.querySelector('.multi .ma-grid .ma-panel')`, 40000))) { fail('A8-부팅', '그리드 미표시'); return }
    await sleep(1200)
    out.mainBoot = await app.j(`(window.__CCG_BOOT && window.__CCG_BOOT['ui-glass:state']?.health) ?? null`)
    await nameSlot(app, '.ma-panel[data-slot="0"]', '유리 A')
    await sleep(900)
    await nameSlot(app, '.ma-panel[data-slot="1"]', '유리 B')
    await sleep(1400)
    await app.j(POPOUT_BTN('.ma-panel[data-slot="0"]'))
    const p1 = await findTarget(port, '#mapanel', 20000)
    if (!p1) { fail('A8-팝아웃1', '첫 팝아웃이 안 떴다'); return }
    const w1 = await attach(p1)
    await waitUntil(w1, `document.querySelector('.sw.pwin')`, 20000)
    out.pop1Boot = await w1.j(`(window.__CCG_BOOT && window.__CCG_BOOT['ui-glass:state']?.health) ?? null`)
    await sleep(1200)
    await app.j(POPOUT_BTN('.ma-panel[data-slot="1"]'))
    await sleep(3000)
    const ts = (await listTargets(port)).filter((t) => t.url.includes('#mapanel'))
    out.mapanelPages = ts.length
    let pop2 = null
    for (const t of ts) {
      const w = await attach(t)
      const h = await w.j(`(window.__CCG_BOOT && window.__CCG_BOOT['ui-glass:state']?.health) ?? null`)
      if ((h?.windows ?? 0) > (out.pop1Boot?.windows ?? 0)) pop2 = h
      w.cdp.close()
    }
    out.pop2Boot = pop2
    if (!pop2) fail('A8-감시목록', '두 번째 팝아웃의 부팅 스냅샷에서 감시 창 수가 안 늘었다(첫 팝아웃이 glass::arm을 안 탄 것)', { pop1: out.pop1Boot, pages: out.mapanelPages })
    else ok('A8-감시목록', { pop1: { windows: out.pop1Boot?.windows, backdrops: out.pop1Boot?.backdrops }, pop2: { windows: pop2.windows, backdrops: pop2.backdrops } })
  } finally {
    killTree(app.child.pid); await sleep(700); if (!KEEP) rmrf(s.HOME)
  }
  rep.steps.a8 = out
}

// ─────────────────────────────────────────────────────────────────────────────
// A9 — 트레이 메뉴가 **빈 카드로 뜨는 회차**가 있나 (traymenu:show 구독 경합)
//      A5에서 숨김 상태로 연 메뉴가 항목 0개였다. 반복해서 빈도를 잰다.
//      메뉴는 '완전히 종료'의 유일한 경로라 빈 카드는 곧 "끌 수 없는 앱"이다.
// ─────────────────────────────────────────────────────────────────────────────
async function a9() {
  console.log('\n[A9] 트레이 메뉴 빈 카드 빈도 (traymenu:show 구독 경합)')
  const s = seedSingle('a9')
  const port = 9420
  const out = { rounds: [] }
  const app = await boot(s.HOME, port)
  try {
    await waitUntil(app, `document.querySelector('#root').children.length > 0`, 30000)
    await sleep(900)
    const ROUNDS = Number((args.find((a) => a.startsWith('--rounds=')) ?? '').split('=')[1] || 12)
    for (let i = 0; i < ROUNDS; i++) {
      const hidden = i >= ROUNDS / 2
      if (hidden && i === Math.ceil(ROUNDS / 2)) { await app.j(`(window.api.win.close(), 'x')`); await sleep(1200) }
      // 부하: 토스트 창을 같이 만들었다 부순다(창 생성 경합 — A5가 빈 카드를 본 조건)
      if (i % 2 === 0) await app.j(`(window.api.notify.event({ kind: 'done', title: 'L' + ${i}, preview: 'x', target: { surface: 'single', id: 'L${i}' } }), 'n')`).catch(() => {})
      else await app.j(`(window.api.notify.close(), 'c')`).catch(() => {})
      const t0 = Date.now()
      await app.j(`${IPC('win:surface-debug', ['traymenu-open'])}`)
      const mt = await findTarget(port, 'tray.html', 10000)
      if (!mt) { out.rounds.push({ i, hidden, window: false }); continue }
      const menu = await attach(mt)
      let rows = 0
      let ms = null
      const tw = Date.now()
      while (Date.now() - tw < 4000) {
        rows = await menu.j(`document.querySelectorAll('#menu .row').length`).catch(() => 0)
        if (rows >= 2) { ms = Date.now() - tw; break }
        await sleep(60)
      }
      const visible = await menu.j(`({ w: window.outerWidth, h: window.outerHeight })`).catch(() => null)
      out.rounds.push({ i, hidden, window: true, rows, rowMs: ms, openMs: Date.now() - t0, size: visible })
      await menu.j(`(window.api.trayMenu.action(''), 'esc')`).catch(() => {})
      menu.cdp.close()
      await goneTarget(port, 'tray.html', 8000)
      await sleep(300)
    }
    out.empty = out.rounds.filter((r) => r.window && r.rows < 2).length
    out.noWindow = out.rounds.filter((r) => !r.window).length
    out.maxRowMs = Math.max(...out.rounds.map((r) => r.rowMs ?? 0))
    if (out.empty > 0 || out.noWindow > 0)
      fail('A9-빈메뉴', `트레이 메뉴 ${out.rounds.length}회 중 항목이 안 그려진 회차 ${out.empty}건 · 창 자체가 안 뜬 회차 ${out.noWindow}건 — '완전히 종료'의 유일한 경로다`, { rounds: out.rounds })
    else ok('A9-메뉴', { rounds: out.rounds.length, maxRowMs: out.maxRowMs })
  } finally {
    killTree(app.child.pid); await sleep(700); if (!KEEP) rmrf(s.HOME)
  }
  rep.steps.a9 = out
}

// ── 실행 ────────────────────────────────────────────────────────────────────
const PHASES = {
  'a1-mid': () => a1('mid', 'mid'),
  'a1-end': () => a1('end', 'end'),
  a2, a3, a4, a5, a6, a7, a8, a9
}
;(async () => {
  const run = only === 'all' ? Object.keys(PHASES) : only.split(',').filter((k) => PHASES[k])
  if (!run.length) { console.error(`알 수 없는 단계: ${only} (가능: ${Object.keys(PHASES).join(', ')})`); process.exit(2) }
  for (const k of run) {
    try { await PHASES[k]() } catch (e) { fail(`${k}!`, String(e?.stack ?? e?.message ?? e)) }
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(rep, null, 2))
  console.log(`\n산출물: ${OUT}`)
  console.log(rep.findings.length === 0 ? '판정: 공격 전부 방어' : `판정: 관측된 미충족 ${rep.findings.length}건`)
  process.exit(0)
})()
