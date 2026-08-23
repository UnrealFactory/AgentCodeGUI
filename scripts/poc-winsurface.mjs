#!/usr/bin/env node
/* ============================================================================
 * poc-winsurface — **창 표면 3종 실증** (M8 R1).
 *
 * 이 라운드가 새로 세운 창 종류가 실제로 뜨고, 실제로 일하고, 실제로 사라지는지를
 * 창·CDP·OS 세 층에서 확인한다. 주장이 아니라 관측만 적는다.
 *
 *   1) 팝아웃  — 열기 → 그 창에서 턴 진행 → 이벤트가 두 창에 미러 → 닫기 → 그리드 복귀
 *                (+ 엔진이 재스폰되지 않았다: spawns 불변)
 *   2) 토스트  — 비포커스에서만 뜸 · 집계 · 포커스 회복하면 자동 소멸 · 클릭 = 본창 포커스
 *   3) 트레이  — X = 창 숨김(프로세스 생존) · 두 번째 실행 = 기존 창 전면 · 메뉴 창 · 종료
 *   4) 비용    — 창 종류마다 WebView2 프로세스가 늘지 않는가(shared_env 성립)
 *   5) 방어    — 새 창 종류에 유리/크래시 방어가 걸려 있는가
 *
 *   node scripts/poc-winsurface.mjs                # 전부
 *   node scripts/poc-winsurface.mjs --only=popout  # 팝아웃만
 *   node scripts/poc-winsurface.mjs --only=toast
 *   node scripts/poc-winsurface.mjs --only=tray
 *   node scripts/poc-winsurface.mjs --only=cost
 *   node scripts/poc-winsurface.mjs --only=defense
 *   node scripts/poc-winsurface.mjs --keep         # 격리 홈 보존
 *   node scripts/poc-winsurface.mjs --tag[=s]      # 동시 실행(홈·포트·산출물 분리)
 *   node scripts/poc-winsurface.mjs --exe=…        # 고정 바이너리
 *
 *   ※ popout 단계는 가짜 CLI가 필요하다($0 · 네트워크 없음):
 *      cargo build -p ccg-engine --features fakecli --bin ccg-fakecli --release
 *
 * ── 안전 규칙 (사용자 실앱이 떠 있다) ───────────────────────────────────────
 *  · **이름 기반 kill 금지.** 죽이는 것은 이 스크립트가 spawn한 PID 트리뿐이다.
 *  · **실홈은 읽기/복사만.** engines는 정션(mklink /J), 나머지는 격리 홈에 새로 쓴다.
 *  · 앱 홈은 전부 `CCG_HOME`으로 격리한다(레포 안 `.poc-home-winsurface*`).
 *  · OS 입력(SetForegroundWindow 등)은 **우리가 띄운 hwnd**에만 건다.
 * ========================================================================== */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { cdpTargets, connectMainPage, killTree, sleep, Cdp, REPO } from '../bench/lib.mjs'

const args = process.argv.slice(2)
const only = (args.find((a) => a.startsWith('--only=')) ?? '').split('=')[1] || 'all'
const KEEP = args.includes('--keep')
const EXE = (args.find((a) => a.startsWith('--exe=')) ?? '').split('=')[1] || path.join(REPO, 'target', 'release', 'agentcodegui.exe')

const tagArg = args.find((a) => a === '--tag' || a.startsWith('--tag='))
const RUNTAG = tagArg === undefined ? '' : tagArg.split('=')[1] || `${process.pid}-${Math.random().toString(36).slice(2, 6)}`
const hash32 = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0 }
const homeFor = (n) => path.join(REPO, `.poc-home-winsurface-${n}${RUNTAG ? `-${RUNTAG}` : ''}`)
const PORT_SHIFT = RUNTAG ? 16 + (hash32(RUNTAG) % 40) * 16 : 0
const portFor = (b) => b + PORT_SHIFT
const OUT = path.join(REPO, 'docs', 'critic', `m8-r1-winsurface${RUNTAG ? `-${RUNTAG}` : ''}.json`)

const rep = { at: new Date().toISOString(), exe: EXE, steps: {}, findings: [] }
const fail = (id, why, extra) => { rep.findings.push({ id, why, ...(extra ?? {}) }); console.error(`  ✗ ${id} — ${why}`) }
const ok = (id, detail) => console.log(`  ✓ ${id}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`)

// ── 공용 ────────────────────────────────────────────────────────────────────
const write = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v))
}
const rmrf = (p) => {
  for (let i = 0; i < 12; i++) {
    try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }); return } catch (e) {
      if (i === 11) { console.warn(`[poc] 홈 정리 실패(무시): ${e.code ?? e.message}`); return }
      spawnSync('cmd', ['/c', 'ping', '127.0.0.1', '-n', '2'], { stdio: 'ignore' })
    }
  }
}

async function boot(home, port, extraEnv = {}) {
  if (!fs.existsSync(EXE)) throw new Error(`빌드된 exe가 없다: ${EXE}\n  npm run tauri:build`)
  const child = spawn(EXE, [], {
    cwd: REPO,
    env: { ...process.env, CCG_HOME: home, CCG_CDP_PORT: String(port), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe']
  })
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

/** 계약면 밖의 **셸 내부 진단 채널**을 부르는 식. `withGlobalTauri=false`라
 *  `window.__TAURI__`가 없다 — poc-live-chat과 같은 내부 브리지를 쓴다. */
const IPC = (channel, payload = []) =>
  `await window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: ${JSON.stringify(channel)}, payload: ${JSON.stringify(payload)} })`

async function listTargets(port) {
  const ts = await cdpTargets(port).catch(() => [])
  return ts.filter((t) => t.type === 'page').map((t) => ({ url: t.url, ws: t.webSocketDebuggerUrl }))
}
async function findTarget(port, frag, ms = 15000) {
  const t0 = Date.now()
  for (;;) {
    const ts = await listTargets(port)
    const t = ts.find((x) => x.url.includes(frag))
    if (t) return t
    if (Date.now() - t0 > ms) return null
    await sleep(150)
  }
}
async function goneTarget(port, frag, ms = 15000) {
  const t0 = Date.now()
  for (;;) {
    const ts = await listTargets(port)
    if (!ts.some((x) => x.url.includes(frag))) return true
    if (Date.now() - t0 > ms) return false
    await sleep(150)
  }
}
async function attach(t) {
  const c = await Cdp.connect(t.ws, { timeoutMs: 8000 })
  const j = async (expr) => JSON.parse(await c.eval(`(async () => JSON.stringify(${expr}))()`, { awaitPromise: true }))
  return { cdp: c, j }
}
async function waitUntil(page, expr, ms = 20000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await page.j(`await (async () => !!(${expr}))()`).catch(() => false)) return true
    await sleep(120)
  }
  return false
}

// ── Win32 (트레이 단계) ─────────────────────────────────────────────────────
const ps = (script) => execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', timeout: 60000 }).trim()
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
    EnumWindows((h,l)=>{
      uint p; GetWindowThreadProcessId(h, out p);
      if(p!=target) return true;
      RECT r; GetWindowRect(h, out r);
      long area = (long)(r.Right-r.Left)*(r.Bottom-r.Top);
      if(area < 10000) return true;                 // 100x100 미만 헬퍼 창 제외
      var t = new System.Text.StringBuilder(256); GetWindowTextW(h, t, 256);
      sb.Append(h.ToInt64()).Append('|').Append(IsWindowVisible(h)?1:0).Append('|')
        .Append(r.Right-r.Left).Append('x').Append(r.Bottom-r.Top).Append('|').Append(t.ToString()).Append('\n');
      return true;
    }, IntPtr.Zero);
    return sb.ToString();
  }
}
"@
`
/** 그 PID가 소유한 100x100 이상 창들 — [{hwnd, visible, size, title}] */
function winDump(pid) {
  const out = ps(`${WIN32}
[W]::Dump(${pid})`)
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [hwnd, vis, size, ...rest] = l.split('|')
      return { hwnd, visible: vis === '1', size, title: rest.join('|') }
    })
}
const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true } catch { return false }
}
/** 이 프로세스 트리의 WebView2 프로세스 회계(개수만 — 메모리는 리드가 잰다) */
function procRoles(rootPid) {
  const out = ps(`$ErrorActionPreference='SilentlyContinue'
$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine
$want = New-Object System.Collections.Generic.HashSet[int]
[void]$want.Add(${rootPid})
for($i=0; $i -lt 6; $i++){ foreach($p in $all){ if($want.Contains([int]$p.ParentProcessId)){ [void]$want.Add([int]$p.ProcessId) } } }
$rows = foreach($p in $all){ if($want.Contains([int]$p.ProcessId)){
  $t='browser'
  if($p.CommandLine -match '--type=([a-z-]+)'){ $t=$Matches[1] }
  if($p.CommandLine -match '--utility-sub-type=([A-Za-z0-9._]+)'){ $t=$t+':'+($Matches[1] -replace '.*\.','') }
  [pscustomobject]@{ pid=[int]$p.ProcessId; name=$p.Name; role=$t } } }
$rows | ConvertTo-Json -Compress -Depth 3`)
  if (!out) return []
  const v = JSON.parse(out)
  return Array.isArray(v) ? v : [v]
}

// ── 홈 씨앗 ─────────────────────────────────────────────────────────────────
function seedFakeCli(HOME) {
  const stub = path.join(REPO, 'target', 'release', 'ccg-fakecli.exe')
  if (!fs.existsSync(stub)) {
    throw new Error(`가짜 CLI가 없다: ${stub}\n  cargo build -p ccg-engine --features fakecli --bin ccg-fakecli --release`)
  }
  const ed = path.join(HOME, 'engines', 'fake', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64')
  fs.mkdirSync(ed, { recursive: true })
  fs.copyFileSync(stub, path.join(ed, 'claude.exe'))
  write(path.join(HOME, 'config.json'), { activeVersion: 'fake' })
  write(path.join(HOME, 'accounts.json'), { defaultEmail: 'fake@example.com', accounts: [{ email: 'fake@example.com' }] })
  fs.mkdirSync(path.join(HOME, 'accounts', 'fake_example.com'), { recursive: true })
}

function fakeScript(HOME, WORK, text) {
  const SCRIPT = path.join(HOME, 'script.jsonl')
  fs.writeFileSync(
    SCRIPT,
    [
      { afterMs: 80, emit: { type: 'control_response', response: { subtype: 'success', request_id: 'init-1', response: {} } } },
      { emit: { type: 'system', subtype: 'init', session_id: 'POP-1', model: 'claude-haiku', cwd: WORK, tools: [], apiKeySource: 'none' } },
      { afterMs: 120, emit: { type: 'assistant', session_id: 'POP-1', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text }], usage: { input_tokens: 5 } } } },
      { emit: { type: 'result', subtype: 'success', is_error: false, result: text, session_id: 'POP-1', total_cost_usd: 0, duration_ms: 1, num_turns: 1 } }
    ].map((s) => JSON.stringify(s)).join('\n') + '\n'
  )
  return SCRIPT
}

/** 멀티 그리드로 바로 뜨는 홈 */
function seedMultiHome(name) {
  const HOME = homeFor(name)
  const WORK = path.join(HOME, 'work')
  rmrf(HOME)
  fs.mkdirSync(WORK, { recursive: true })
  seedFakeCli(HOME)
  write(path.join(HOME, 'ui-prefs.json'), { 'ui.lang': 'ko', 'workspace.mode': 'multi', 'whatsnew.seenVersion': '9.9.9', 'notify.toast': true })
  write(path.join(HOME, 'profile.json'), { nickname: 'poc' })
  write(path.join(HOME, 'chats', 'index.json'), { version: 1, order: ['c-main'], activeChatId: 'c-main' })
  write(path.join(HOME, 'chats', 'c-main.json'), {
    id: 'c-main', title: '본채팅', custom: true, manualCwd: WORK,
    picker: { model: 'haiku', effort: 'minimal', mode: 'normal' }, refDirs: [],
    snapshot: { messages: [] }, updatedAt: 1
  })
  const SCRIPT = fakeScript(HOME, WORK, '팝아웃 창에서 답한 줄')
  return { HOME, WORK, SCRIPT }
}

/** 단일 채팅 홈 (토스트·트레이용 — 그리드가 필요 없다) */
function seedSingleHome(name) {
  const HOME = homeFor(name)
  const WORK = path.join(HOME, 'work')
  rmrf(HOME)
  fs.mkdirSync(WORK, { recursive: true })
  seedFakeCli(HOME)
  write(path.join(HOME, 'ui-prefs.json'), { 'ui.lang': 'ko', 'workspace.mode': 'single', 'whatsnew.seenVersion': '9.9.9', 'notify.toast': true })
  write(path.join(HOME, 'profile.json'), { nickname: 'poc' })
  write(path.join(HOME, 'chats', 'index.json'), { version: 1, order: ['c-main'], activeChatId: 'c-main' })
  write(path.join(HOME, 'chats', 'c-main.json'), {
    id: 'c-main', title: '본채팅', custom: true, manualCwd: WORK,
    picker: { model: 'haiku', effort: 'minimal', mode: 'normal' }, refDirs: [],
    snapshot: { messages: [] }, updatedAt: 1
  })
  return { HOME, WORK }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) 팝아웃 창 — 열기 → 그 창에서 턴 → 미러 → 닫기 → 그리드 복귀
// ─────────────────────────────────────────────────────────────────────────────
const POPOUT_BTN = `(() => {
  const b = [...document.querySelectorAll('.ma-panel button')].find((x) => /별도 창으로|own window/.test(x.getAttribute('aria-label') || ''))
  if (!b) return false
  b.click(); return true
})()`

async function phasePopout() {
  console.log('\n[POPOUT] 멀티 패널 팝아웃 창')
  const s = seedMultiHome('popout')
  const port = portFor(9381)
  const out = { home: s.HOME }
  const app = await boot(s.HOME, port, { CCG_FAKECLI_SCRIPT: s.SCRIPT })
  try {
    if (!(await waitUntil(app, `document.querySelector('.multi .ma-grid .ma-panel')`, 40000))) {
      fail('P0-그리드', '멀티 그리드가 안 떴다', { log: app.log().slice(-800) })
      return
    }
    await sleep(1200)
    out.panelIds = await app.j(`[...document.querySelectorAll('.ma-panel[data-slot]')].map((e) => e.dataset.slot)`)

    // ── 자리에 채팅을 앉힌다(F2 이름 붙이기) ────────────────────────────────
    // 3.0에서 `panelId`는 **보드의 자리 번호**일 뿐이고 실행은 그 자리에 앉은 chatId가
    // 소유한다(engine/mod.rs `panel_id_to_chat`). 빈 패널은 보드에 chatId가 없어
    // (`legacy_bridge::panel_has_content`) 실행이 어디에도 안 붙는다 — 그래서 먼저
    // 이름을 붙여 자리를 채운다. 사용자 경로 그대로(F2 → 입력 → Enter).
    out.renamed = await app.j(`(() => {
      const b = document.querySelector('.ma-panel .ma-p-tedit')
      if (!b) return 'no-edit-btn'
      b.click(); return 'editing'
    })()`)
    await waitUntil(app, `document.querySelector('.ma-panel .ma-p-tin')`, 6000)
    out.named = await app.j(`(() => {
      const el = document.querySelector('.ma-panel .ma-p-tin')
      if (!el) return 'no-input'
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      set.call(el, '팝아웃 대상 패널')
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      return 'named'
    })()`)
    out.titleShown = await waitUntil(app, `/팝아웃 대상 패널/.test(document.querySelector('.ma-panel .ma-p-title')?.textContent ?? '')`, 8000)
    // ma:save 디바운스가 **멀티 보드**의 자리에 chatId를 쓸 때까지 기다린다.
    // (`default` 보드는 마이그레이션이 만든 본채팅 자리라 판정에 쓰면 안 된다)
    const GRID_SLOT_FILLED = `(await (async () => {
      const b = ${IPC('board:get')}
      return (b?.boards ?? []).some((x) => x.id !== 'default' && (x.slots ?? []).some((s) => !!s))
    })())`
    out.boardReady = await waitUntil(app, GRID_SLOT_FILLED, 20000)
    out.board = await app.j(`${IPC('board:get')}`)
    if (!out.boardReady) fail('P0-보드', '패널에 이름을 붙였는데 활성 보드 자리에 채팅이 안 앉았다', { named: out.named, board: out.board })
    else ok('P0-보드', (out.board?.boards ?? []).map((b) => [b.id.slice(0, 8), b.slots.filter(Boolean)]))

    // 이 패널의 chatId·엔진 회계를 먼저 떠 둔다(재스폰 판정 기준선)
    const dbg0 = await app.j(`${IPC('engine:debug')}`)
    out.engineBefore = dbg0

    // 그리드 컴포저에 초안을 심는다 — 팝아웃이 **소유권을 넘겨받는지** 볼 값
    out.draftSet = await app.j(`(() => {
      const ta = document.querySelector('.ma-panel .composer textarea') || document.querySelector('.ma-panel textarea')
      if (!ta) return 'no-textarea'
      const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      set.call(ta, '팝아웃으로 넘어갈 초안')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      return 'set'
    })()`)
    await sleep(700)

    // ── 열기 ────────────────────────────────────────────────────────────────
    const t0 = Date.now()
    out.clicked = await app.j(POPOUT_BTN)
    const pt = await findTarget(port, '#mapanel', 20000)
    out.openMs = Date.now() - t0
    if (!pt) {
      fail('P1-열기', '#mapanel 창이 안 떴다', { targets: await listTargets(port), log: app.log().slice(-800) })
      return
    }
    ok('P1-열기', { ms: out.openMs })
    const pop = await attach(pt)
    out.popMounted = await waitUntil(pop, `document.querySelector('.sw.pwin .pw-body .ma-panel')`, 25000)
    if (!out.popMounted) fail('P1-마운트', '팝아웃 창에 PanelView가 안 섰다', { html: await pop.j(`document.body.className`) })
    else ok('P1-마운트')

    // 그리드 유령
    out.ghost = await waitUntil(app, `document.querySelector('.ma-grid .ma-panel.ma-ghost.pop')`, 8000)
    if (!out.ghost) fail('P2-유령', '그리드에 팝아웃 유령 셀이 안 생겼다')
    else ok('P2-유령')

    // 초안 소유권 이전: 창에는 있고 그리드에는 없다
    out.draftInPopout = await pop.j(`(document.querySelector('.pw-body textarea')?.value ?? null)`)
    out.draftInGrid = await app.j(`(document.querySelector('.ma-grid .ma-panel:not(.ma-ghost) textarea')?.value ?? null)`)
    if (out.draftInPopout !== '팝아웃으로 넘어갈 초안') fail('P3-초안이전', '초안이 창으로 안 넘어갔다', { got: out.draftInPopout })
    else ok('P3-초안이전')

    // 이 패널의 panelId(창이 안다) + 미러 구독 재설치
    out.panelId = await pop.j(`(await window.api.multi.panelHydrate())?.panelId ?? null`)
    if (!out.panelId) fail('P3-hydrate', 'ma:panel-hydrate가 부트 페이로드를 안 준다')
    else ok('P3-hydrate', out.panelId)
    await app.j(`(() => {
      window.__mirror = []
      window.api.multi.onEvent(${JSON.stringify(out.panelId ?? '')}, (e) => window.__mirror.push(e.type ?? String(e)))
      return 'armed'
    })()`)

    // ── 그 창에서 대화 계속 ────────────────────────────────────────────────
    // **창의 컴포저로** 보낸다(진짜 사용자 경로). 넘어온 초안이 그대로 프롬프트가 된다.
    out.sent = await pop.j(`(() => {
      const ta = document.querySelector('.pw-body .composer textarea') || document.querySelector('.pw-body textarea')
      if (!ta) return 'no-textarea'
      ta.focus()
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      return 'sent'
    })()`)
    out.popGotText = await waitUntil(pop, `document.body.innerText.includes('팝아웃 창에서 답한 줄')`, 25000)
    if (!out.popGotText) fail('P4-턴', '팝아웃 창에 답변이 안 그려졌다', { sent: out.sent, log: app.log().slice(-800) })
    else ok('P4-턴')

    // 미러 팬아웃 — 메인 창도 같은 panelId의 이벤트를 받았나
    out.mirror = await app.j(`window.__mirror ?? []`)
    if (!Array.isArray(out.mirror) || out.mirror.length === 0) fail('P5-미러', '메인 창이 팝아웃 턴의 ma:event를 못 받았다', { mirror: out.mirror })
    else ok('P5-미러', { events: out.mirror.length, kinds: [...new Set(out.mirror)].slice(0, 6) })

    // 엔진 재스폰 없음 — 같은 chatId의 spawns가 그대로인가
    const dbg1 = await app.j(`${IPC('engine:debug')}`)
    out.engineAfter = dbg1
    const chatOf = (d, id) => (d?.chats ?? []).find((c) => c.chatId === id) ?? null
    out.chatId = (dbg1?.chats ?? []).find((c) => c.spawns > 0)?.chatId ?? null
    const before = chatOf(dbg0, out.chatId)
    const after = chatOf(dbg1, out.chatId)
    out.spawns = { before: before?.spawns ?? 0, after: after?.spawns ?? null, session: after?.session ?? null, chats: (dbg1?.chats ?? []).length }
    if (out.spawns.after !== 1 || out.spawns.chats !== 1) {
      fail('P6-재스폰', `팝아웃에서 돈 턴이 CLI를 한 번만 띄우지 않았다(spawns=${out.spawns.after}, 런타임=${out.spawns.chats})`, out.spawns)
    } else ok('P6-재스폰', out.spawns)

    // ── 닫기 → 그리드 복귀(fold-back) ──────────────────────────────────────
    // 창의 페르시스트는 600ms 디바운스다 — 그 전에 닫으면 **부트 상태가 복귀분**이라는 게
    // 2.6.2부터의 규약이다. 여기서는 "정상적으로 답을 보고 나서 닫는" 경우를 잰다:
    // 복귀분이 이번 턴을 담을 때까지 기다렸다가 닫는다(기다린 시간도 기록한다).
    const tFlush = Date.now()
    out.flushReady = await waitUntil(
      app,
      `(((await (${IPC('win:surface-debug')}))?.popout?.flushes ?? []).some((f) => f.messages > 0))`,
      8000
    )
    out.flushWaitMs = Date.now() - tFlush
    out.flushBeforeClose = (await app.j(`${IPC('win:surface-debug')}`))?.popout?.flushes ?? []
    if (!out.flushReady) fail('P7-복귀분', '턴이 끝났는데 창의 페르시스트가 복귀분에 안 실렸다', out.flushBeforeClose)
    else ok('P7-복귀분', { ms: out.flushWaitMs, flushes: out.flushBeforeClose })
    await pop.j(`(window.api.win.close(), 'closing')`)
    out.closedGone = await goneTarget(port, '#mapanel', 20000)
    if (!out.closedGone) fail('P7-닫기', '팝아웃 창이 안 닫혔다')
    else ok('P7-닫기')
    out.ghostGone = await waitUntil(app, `!document.querySelector('.ma-grid .ma-panel.ma-ghost.pop')`, 12000)
    out.foldBackThread = await waitUntil(app, `document.body.innerText.includes('팝아웃 창에서 답한 줄')`, 12000)
    if (!out.ghostGone) fail('P7-유령해제', '닫았는데 그리드 유령이 남았다')
    else ok('P7-유령해제')
    if (!out.foldBackThread) fail('P8-복귀', '창에서 진행한 스레드가 그리드로 안 돌아왔다')
    else ok('P8-복귀')

    // leftover 회계 — 라이브 회수했으면 잔여 사본이 없어야 한다
    await sleep(900)
    out.surface = await app.j(`${IPC('win:surface-debug')}`)
    const left = out.surface?.popout?.leftovers ?? []
    if (left.length > 0) fail('P9-leftover', '라이브로 회수했는데 잔여 사본이 남았다', { left })
    else ok('P9-leftover')
    pop.cdp.close()
  } finally {
    killTree(app.child.pid)
    await sleep(800)
    if (!KEEP) rmrf(s.HOME)
  }
  rep.steps.popout = out
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) 토스트 창 — 표시 조건 · 집계 · 자동 소멸 · 클릭 라우팅
// ─────────────────────────────────────────────────────────────────────────────
const NOTIFY1 = `window.api.notify.event({ kind: 'done', title: '벤치 채팅', preview: '첫 번째 턴이 끝났어요.', target: { surface: 'single', id: 'c-main' } })`
const NOTIFY2 = `window.api.notify.event({ kind: 'ask', title: '두 번째', preview: '질문이 기다려요.', target: { surface: 'single', id: 'c-two' } })`

async function phaseToast() {
  console.log('\n[TOAST] 포커스 밖 알림 토스트 창')
  const s = seedSingleHome('toast')
  const port = portFor(9382)
  const out = { home: s.HOME }
  const app = await boot(s.HOME, port)
  try {
    await waitUntil(app, `document.querySelector('#root').children.length > 0`, 30000)
    await sleep(800)

    // (a) 포커스 상태에서는 뜨지 않는다 — 표시 판정이 셸에 있다는 증거
    await app.cdp.send('Page.bringToFront').catch(() => {})
    await sleep(600)
    await app.j(`(${NOTIFY1}, 'sent')`)
    await sleep(1500)
    out.whileFocused = (await listTargets(port)).some((t) => t.url.includes('toast.html'))
    out.dbgFocused = await app.j(`${IPC('win:surface-debug')}`)
    if (out.whileFocused) fail('T1-포커스억제', '포커스 중인데도 토스트가 떴다', out.dbgFocused?.notify)
    else ok('T1-포커스억제')

    // (b) 최소화 후 이벤트 → 토스트가 뜬다
    await app.j(`(window.api.win.minimize(), 'min')`)
    await sleep(900)
    const t0 = Date.now()
    await app.j(`(${NOTIFY1}, 'sent')`)
    const tt = await findTarget(port, 'toast.html', 15000)
    out.showMs = Date.now() - t0
    if (!tt) {
      fail('T2-표시', '토스트 창이 안 떴다', { targets: await listTargets(port), dbg: await app.j(`${IPC('win:surface-debug')}`) })
      return
    }
    ok('T2-표시', { ms: out.showMs })
    const toast = await attach(tt)
    out.singleCard = await waitUntil(toast, `document.querySelector('#card .t-body')`, 12000)
    out.cardText = await toast.j(`(document.querySelector('#card')?.innerText ?? '').replace(/\\s+/g,' ').trim().slice(0,120)`)
    if (!out.singleCard) fail('T2-카드', '단건 상세 카드가 안 그려졌다', { text: out.cardText })
    else ok('T2-카드', out.cardText)

    // 창이 실제로 앉은 자리(우하단) + 포커스를 안 뺏었는가
    out.bounds = await toast.j(`({ w: window.outerWidth, h: window.outerHeight, x: window.screenX, y: window.screenY })`)
    out.toastHasFocus = await toast.j(`document.hasFocus()`)
    if (out.toastHasFocus) fail('T3-포커스탈취', '토스트가 포커스를 가져갔다(WS_EX_NOACTIVATE 미적용?)', out.bounds)
    else ok('T3-포커스탈취없음', out.bounds)

    // (c) 두 번째 알림 → 집계 행
    await app.j(`(${NOTIFY2}, 'sent')`)
    out.aggregate = await waitUntil(toast, `document.querySelector('#card .t-agg .t-rows .t-row')`, 12000)
    out.rows = await toast.j(`document.querySelectorAll('#card .t-agg .t-row').length`)
    if (!out.aggregate) fail('T4-집계', '두 건인데 집계 행으로 안 접혔다', { rows: out.rows })
    else ok('T4-집계', { rows: out.rows })

    // 앉은 자리 — 커서가 있는 모니터의 작업 영역 **우하단**인가(notify:resize가 실제로 먹었나)
    await sleep(600)
    out.placed = await toast.j(`({ w: window.outerWidth, h: window.outerHeight, x: window.screenX, y: window.screenY,
      availW: window.screen.availWidth, availH: window.screen.availHeight, dpr: window.devicePixelRatio })`)
    const pl = out.placed
    out.bottomRight = !!pl && Math.abs(pl.x + pl.w - pl.availW) <= 24 && Math.abs(pl.y + pl.h - pl.availH) <= 24
    if (!out.bottomRight) fail('T4-자리', '토스트가 작업 영역 우하단에 안 앉았다', pl)
    else ok('T4-자리', pl)

    // (d) 클릭 = 본창 포커스 + 점프 통지
    await app.j(`(window.__jump = null, window.api.notify.onJump((t) => (window.__jump = t)), 'armed')`)
    const key = await toast.j(`document.querySelector('#card .t-row')?.dataset.key ?? null`)
    out.clickKey = key
    await toast.j(`(document.querySelector('#card .t-row[data-key=' + JSON.stringify(${JSON.stringify(key ?? '')}) + ']')?.click(), 'clicked')`)
    await sleep(1200)
    out.jump = await app.j(`window.__jump`)
    out.mainVisibleAfterClick = winDump(app.child.pid).some((w) => w.visible && Number(w.size.split('x')[0]) > 600)
    if (!out.jump) fail('T5-점프', '클릭했는데 notify:jump가 안 왔다')
    else ok('T5-점프', out.jump)
    if (!out.mainVisibleAfterClick) fail('T5-본창', '클릭했는데 본창이 안 올라왔다', { wins: winDump(app.child.pid) })
    else ok('T5-본창')

    // (e) 자동 소멸 — 클릭이 그 창 몫을 비웠으므로 목록이 줄고, 마지막이면 창이 사라진다
    await app.cdp.send('Page.bringToFront').catch(() => {})
    await sleep(1500)
    out.gone = await goneTarget(port, 'toast.html', 12000)
    out.dbgAfter = await app.j(`${IPC('win:surface-debug')}`)
    if (!out.gone) fail('T6-소멸', '본창이 포커스를 되찾았는데 토스트가 남았다', out.dbgAfter?.notify)
    else ok('T6-소멸', { pending: out.dbgAfter?.notify?.count })
  } finally {
    killTree(app.child.pid)
    await sleep(800)
    if (!KEEP) rmrf(s.HOME)
  }
  rep.steps.toast = out
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) 트레이 — X = 숨김 · 두 번째 실행 = 전면 · 메뉴 창 · 종료
// ─────────────────────────────────────────────────────────────────────────────
async function phaseTray() {
  console.log('\n[TRAY] 시스템 트레이')
  const s = seedSingleHome('tray')
  const port = portFor(9383)
  const out = { home: s.HOME }
  const app = await boot(s.HOME, port)
  let exited = false
  try {
    await waitUntil(app, `document.querySelector('#root').children.length > 0`, 30000)
    await sleep(900)
    out.dbg0 = await app.j(`${IPC('win:surface-debug')}`)
    if (!out.dbg0?.tray?.tray) fail('R1-아이콘', '트레이 아이콘이 안 올라갔다', out.dbg0?.tray)
    else ok('R1-아이콘', out.dbg0.tray)

    out.winsBefore = winDump(app.child.pid)
    // (a) X = 트레이로 숨김 (타이틀바 X와 같은 경로 = win:close)
    await app.j(`(window.api.win.close(), 'x')`)
    await sleep(1500)
    out.winsAfterX = winDump(app.child.pid)
    out.aliveAfterX = pidAlive(app.child.pid)
    out.visibleAfterX = out.winsAfterX.filter((w) => w.visible).length
    if (!out.aliveAfterX) fail('R2-생존', 'X를 눌렀더니 프로세스가 죽었다(트레이로 안 숨었다)')
    else if (out.visibleAfterX !== 0) fail('R2-숨김', 'X를 눌렀는데 창이 여전히 보인다', out.winsAfterX)
    else ok('R2-숨김', { alive: true, visibleWindows: 0 })

    // (b) 두 번째 실행 → 기존 창 전면 (M1 §7-3)
    const t0 = Date.now()
    const second = spawn(EXE, [], { cwd: REPO, env: { ...process.env, CCG_HOME: s.HOME }, stdio: 'ignore' })
    let secondExitCode = null
    second.on('exit', (c) => (secondExitCode = c))
    for (let i = 0; i < 100; i++) {
      if (secondExitCode !== null) break
      await sleep(100)
    }
    out.secondExit = { code: secondExitCode, ms: Date.now() - t0 }
    for (let i = 0; i < 60; i++) {
      out.winsAfterSecond = winDump(app.child.pid)
      if (out.winsAfterSecond.some((w) => w.visible)) break
      await sleep(200)
    }
    out.raisedMs = Date.now() - t0
    out.raised = (out.winsAfterSecond ?? []).some((w) => w.visible)
    if (secondExitCode === null) { try { second.kill() } catch { /* 이미 죽음 */ } }
    if (secondExitCode !== 0) fail('R3-두번째', `두 번째 인스턴스가 물러나지 않았다(exit=${secondExitCode})`, out.secondExit)
    else ok('R3-두번째', out.secondExit)
    if (!out.raised) fail('R3-전면', '두 번째 실행이 기존 창을 못 올렸다', { wins: out.winsAfterSecond })
    else ok('R3-전면', { ms: out.raisedMs })

    // (c) 트레이 우클릭 메뉴 창 — OS 알림 영역 우클릭은 CDP로 합성 불가라
    //     같은 진입 함수를 진단 채널로 부른다(그 뒤 경로는 실제와 동일).
    await app.j(`${IPC('win:surface-debug', ['traymenu-open'])}`)
    const mt = await findTarget(port, 'tray.html', 15000)
    out.menuWindow = !!mt
    if (!mt) fail('R4-메뉴창', '트레이 메뉴 창이 안 떴다', { targets: await listTargets(port) })
    else {
      const menu = await attach(mt)
      out.menuRows = await waitUntil(menu, `document.querySelectorAll('#menu .row').length >= 2`, 10000)
      out.menuText = await menu.j(`[...document.querySelectorAll('#menu .row')].map((r) => r.innerText)`)
      out.menuBounds = await menu.j(`({ w: window.outerWidth, h: window.outerHeight, x: window.screenX, y: window.screenY })`)
      if (!out.menuRows) fail('R4-항목', '메뉴 항목이 안 그려졌다', { text: out.menuText })
      else ok('R4-메뉴창', { items: out.menuText, bounds: out.menuBounds })
      // Esc = 닫기
      await menu.j(`(window.api.trayMenu.action(''), 'esc')`).catch(() => {})
      out.menuClosed = await goneTarget(port, 'tray.html', 10000)
      if (!out.menuClosed) fail('R4-닫기', 'Esc로 메뉴 창이 안 닫혔다')
      else ok('R4-닫기')
    }

    // (d) 메뉴 '완전히 종료' = 진짜 종료
    await app.j(`${IPC('win:surface-debug', ['traymenu-open'])}`)
    const mt2 = await findTarget(port, 'tray.html', 12000)
    if (mt2) {
      const menu2 = await attach(mt2)
      await menu2.j(`(window.api.trayMenu.action('quit'), 'quit')`).catch(() => {})
    }
    for (let i = 0; i < 80; i++) {
      if (!pidAlive(app.child.pid)) break
      await sleep(100)
    }
    exited = !pidAlive(app.child.pid)
    out.quitWorks = exited
    if (!exited) fail('R5-종료', "메뉴 '완전히 종료'로 앱이 안 죽었다")
    else ok('R5-종료')
  } finally {
    if (!exited) killTree(app.child.pid)
    await sleep(800)
    if (!KEEP) rmrf(s.HOME)
  }
  rep.steps.tray = out
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) 창당 비용 — 창 종류마다 WebView2 프로세스가 늘지 않는가 (shared_env 성립)
//    ※ 메모리(MB)는 이 하네스가 재지 않는다. 동시 주행 노이즈 — 리드가 따로 잰다.
// ─────────────────────────────────────────────────────────────────────────────
async function phaseCost() {
  console.log('\n[COST] 창 종류별 프로세스 회계(shared_env)')
  const s = seedMultiHome('cost')
  const port = portFor(9384)
  const out = { home: s.HOME, stages: [] }
  const app = await boot(s.HOME, port, { CCG_FAKECLI_SCRIPT: s.SCRIPT })
  const snap = async (label) => {
    await sleep(2500)
    const roles = procRoles(app.child.pid)
    const wins = (await listTargets(port)).map((t) => t.url.replace(/^.*\/(?=[^/]*$)/, ''))
    const row = { label, procs: roles.length, roles: roles.map((r) => r.role).sort(), pages: wins.length, urls: wins }
    out.stages.push(row)
    console.log(`  · ${label}: procs=${row.procs} pages=${row.pages} [${row.roles.join(' ')}]`)
    return row
  }
  try {
    await waitUntil(app, `document.querySelector('.multi .ma-grid .ma-panel')`, 40000)
    await sleep(1500)
    const base = await snap('메인 창만')

    await app.j(POPOUT_BTN)
    await findTarget(port, '#mapanel', 20000)
    const withPop = await snap('+ 팝아웃 창')

    await app.j(`(window.api.win.minimize(), 'min')`)
    await sleep(700)
    await app.j(`(${NOTIFY1}, 'sent')`)
    await findTarget(port, 'toast.html', 15000)
    const withToast = await snap('+ 토스트 창')

    await app.j(`${IPC('win:surface-debug', ['traymenu-open'])}`)
    await findTarget(port, 'tray.html', 15000)
    const withMenu = await snap('+ 트레이 메뉴 창')

    out.delta = {
      popout: withPop.procs - base.procs,
      toast: withToast.procs - withPop.procs,
      traymenu: withMenu.procs - withToast.procs
    }
    const bad = Object.entries(out.delta).filter(([, v]) => v !== 0)
    if (bad.length) fail('C1-shared_env', '창을 열었더니 프로세스가 늘었다(환경 공유 실패)', out.delta)
    else ok('C1-shared_env', out.delta)
    out.pagesFinal = withMenu.urls
  } finally {
    killTree(app.child.pid)
    await sleep(800)
    if (!KEEP) rmrf(s.HOME)
  }
  rep.steps.cost = out
}

// ─────────────────────────────────────────────────────────────────────────────
// 5) 방어 — 유리(glass)·크래시(crash)가 새 창 종류에도 걸리는가
// ─────────────────────────────────────────────────────────────────────────────
async function phaseDefense() {
  console.log('\n[DEFENSE] 유리·크래시 방어가 새 창에도 걸리나')
  const s = seedMultiHome('defense')
  const port = portFor(9385)
  const out = { home: s.HOME }
  const app = await boot(s.HOME, port, { CCG_FAKECLI_SCRIPT: s.SCRIPT })
  try {
    await waitUntil(app, `document.querySelector('.multi .ma-grid .ma-panel')`, 40000)
    await sleep(1200)
    const g0 = await app.j(`(window.__CCG_BOOT && window.__CCG_BOOT['ui-glass:state']) ?? null`)
    out.glassWindowsBefore = g0?.health?.windows ?? null

    await app.j(POPOUT_BTN)
    const pt = await findTarget(port, '#mapanel', 20000)
    if (!pt) { fail('D0', '팝아웃 창이 안 떴다'); return }
    const pop = await attach(pt)
    await waitUntil(pop, `document.querySelector('.sw.pwin')`, 20000)
    await sleep(1500)

    // (a) 유리 — 팝아웃 창도 감시 목록에 올라갔나(창 수 +1) + 그 문서가 부팅 스냅샷을 받았나
    const g1 = await pop.j(`(window.__CCG_BOOT && window.__CCG_BOOT['ui-glass:state']) ?? null`)
    out.popoutGlassBoot = g1 ? { ok: g1.ok, windows: g1.health?.windows, backdrops: g1.health?.backdrops } : null
    const g2 = await app.j(`(${IPC('win:surface-debug')})`)
    out.windowsNow = g2?.windows ?? []
    if (!g1) fail('D1-유리부팅', '팝아웃 창 문서에 유리 스냅샷이 안 실렸다')
    else ok('D1-유리부팅', out.popoutGlassBoot)

    // 백드롭 실측 — 팝아웃 창 hwnd의 DWM 시스템 백드롭 타입(3 = TRANSIENTWINDOW)
    out.backdrops = ps(`${WIN32}
Add-Type @"
using System; using System.Runtime.InteropServices;
public class D { [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s); }
"@
$r = @()
foreach($l in ([W]::Dump(${app.child.pid}).Split([char]10))){
  if($l.Trim() -eq ''){ continue }
  $p = $l.Split([char]124)
  $h = [IntPtr]::new([int64]$p[0]); $v = 0
  $hr = [D]::DwmGetWindowAttribute($h, 38, [ref]$v, 4)
  $r += [pscustomobject]@{ hwnd=$p[0]; visible=$p[1]; size=$p[2]; title=$p[3]; backdrop=$v; hr=$hr }
}
$r | ConvertTo-Json -Compress -Depth 3`)
    try { out.backdrops = JSON.parse(out.backdrops) } catch { /* 문자열 그대로 남긴다 */ }
    const bd = Array.isArray(out.backdrops) ? out.backdrops : [out.backdrops].filter(Boolean)
    const appWins = bd.filter((w) => String(w.title || '').includes('AgentCodeGUI'))
    out.appWindowBackdrops = appWins.map((w) => ({ title: w.title, backdrop: w.backdrop }))
    if (appWins.length && appWins.every((w) => w.backdrop === 3)) ok('D2-백드롭', out.appWindowBackdrops)
    else fail('D2-백드롭', '앱 창 중 아크릴 백드롭(3)이 아닌 창이 있다', out.appWindowBackdrops)

    // (b) 크래시 — 팝아웃 창을 띄운 채 렌더러를 죽이고, 두 창이 다시 서는가
    const logPath = path.join(s.HOME, 'crash-recovery.log')
    const before = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').length : 0
    await pop.cdp.send('Page.crash', {}, { timeoutMs: 3000 }).catch(() => {})
    await sleep(6000)
    out.afterCrashTargets = (await listTargets(port)).map((t) => t.url.replace(/^.*\/(?=[^/]*$)/, ''))
    out.mainRemounted = await (async () => {
      const t = await findTarget(port, 'index.html', 20000)
      if (!t) return false
      const p = await attach(t)
      const r = await waitUntil(p, `document.getElementById('root')?.children.length > 0`, 25000)
      p.cdp.close()
      return r
    })()
    out.popoutBack = !!(await findTarget(port, '#mapanel', 20000))
    const tail = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').slice(before) : ''
    out.crashLog = tail.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l).event } catch { return l.slice(0, 40) } })
    if (!out.mainRemounted) fail('D3-복구', '렌더러 사망 뒤 메인 창이 다시 안 섰다', { log: out.crashLog })
    else ok('D3-복구', { events: out.crashLog.slice(0, 10) })
    if (!out.popoutBack) fail('D4-팝아웃복구', '렌더러 사망 뒤 팝아웃 창이 사라졌다', { targets: out.afterCrashTargets })
    else ok('D4-팝아웃복구')
  } finally {
    killTree(app.child.pid)
    await sleep(800)
    if (!KEEP) rmrf(s.HOME)
  }
  rep.steps.defense = out
}

// ── 실행 ────────────────────────────────────────────────────────────────────
const PHASES = { popout: phasePopout, toast: phaseToast, tray: phaseTray, cost: phaseCost, defense: phaseDefense }

;(async () => {
  const run = only === 'all' ? Object.keys(PHASES) : only.split(',').filter((k) => PHASES[k])
  if (!run.length) {
    console.error(`알 수 없는 단계: ${only} (가능: ${Object.keys(PHASES).join(', ')})`)
    process.exit(2)
  }
  for (const k of run) {
    try {
      await PHASES[k]()
    } catch (e) {
      fail(`${k}!`, String(e?.message ?? e))
    }
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(rep, null, 2))
  console.log(`\n산출물: ${OUT}`)
  console.log(rep.findings.length === 0 ? '판정: 전 항목 관측 통과' : `판정: 미충족 ${rep.findings.length}건`)
  process.exit(rep.findings.length === 0 ? 0 : 1)
})()
