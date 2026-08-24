#!/usr/bin/env node
/* ============================================================================
 * poc-winsurface — **창 표면 3종 실증** (M8 R1 → **R2**).
 *
 * 이 라운드가 새로 세운 창 종류가 실제로 뜨고, 실제로 일하고, 실제로 사라지는지를
 * 창·CDP·OS 세 층에서 확인한다. 주장이 아니라 관측만 적는다.
 *
 *   1) 팝아웃  — 열기 → 그 창에서 턴 진행 → 이벤트가 두 창에 미러 → 닫기 → 그리드 복귀
 *                (+ 엔진이 재스폰되지 않았다: spawns 불변) **+ 소실 0(디스크까지)**
 *   2) 토스트  — 비포커스에서만 뜸 · 집계 · 포커스 회복하면 자동 소멸 · 클릭 = 본창 포커스
 *   3) 트레이  — X = 창 숨김(프로세스 생존) · **첫 숨김 안내** · 두 번째 실행 = 기존 창
 *                전면 · 메뉴 창 · **아이콘 해제** · 종료
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
 * ── R2에서 고친 **증거 결함 4건** (크리틱 M8 §6) ───────────────────────────
 *  · T6 「포커스 회복 → 자동 소멸」 — 바로 앞 T5가 카드를 **클릭**해 목록을 이미 비웠다.
 *    두 항목 모두 owner="main"이라 `notify::open` → `clear_for_window("main")`이 그
 *    순간 창까지 부순다. T6은 사라진 뒤를 물었으므로 **포커스 소멸 경로를 한 번도 안
 *    탔다.** → 클릭이 지나간 뒤 **새 알림을 다시 넣고**, 클릭 없이 포커스만 되돌려 잰다.
 *  · T4 자리 — `screenX`(가상 데스크톱 좌표)를 `availWidth`(그 모니터 폭)와 비교해
 *    **보조 모니터에서는 항상 실패**한다. → `screen.availLeft/availTop`으로 모니터 로컬
 *    좌표로 환산해서 잰다(가상 좌표도 함께 기록한다).
 *  · D3 「메인 창이 다시 섰다」 — 메인 창을 `findTarget('index.html')`로 골랐는데
 *    **메인 창 URL에는 index.html이 없고**(`http://tauri.localhost/`) 팝아웃이
 *    `index.html#mapanel`이라, 사실상 팝아웃을 잰 값이었다. → `mainTarget()`
 *    (URL에 `.html`이 없는 페이지)로 고른다.
 *  · D1 「팝아웃에 유리가 걸린다」 — 그 근거로 든 부팅 스냅샷은 `glass::arm`보다
 *    **먼저** 찍히므로(popout.rs:164 vs :174) 자기 자신이 목록에 없다 = 아무것도
 *    증명하지 못한다. → 팝아웃을 **둘** 열고 두 번째 창의 스냅샷에서 감시 창 수가
 *    1→2로 느는지 본다.
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
import { cdpTargets, connectMainPage, killTree, sleep, Cdp, REPO, resolveTauriExe } from '../bench/lib.mjs'

const args = process.argv.slice(2)
const only = (args.find((a) => a.startsWith('--only=')) ?? '').split('=')[1] || 'all'
const KEEP = args.includes('--keep')
// M12 R2 — mainBinaryName 변경으로 exe 이름이 둘이다(구·신 모두 탐색·최신 mtime 우선)
const EXE = resolveTauriExe((args.find((a) => a.startsWith('--exe=')) ?? '').split('=')[1])

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
/** **메인 창** 페이지. R1은 `findTarget('index.html')`로 골랐는데 메인 창의 URL은
 *  `http://tauri.localhost/`라 그 조각이 **없고**, 팝아웃(`index.html#mapanel`)이 대신
 *  잡혔다(크리틱 §6-4). 셸의 창 중 문서 파일명이 URL에 없는 페이지가 메인 창이다. */
async function mainTarget(port, ms = 20000) {
  const t0 = Date.now()
  for (;;) {
    const t = (await listTargets(port)).find((x) => !/\.html/.test(x.url))
    if (t) return t
    if (Date.now() - t0 > ms) return null
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
/** **우리가 띄운 본창을 복원 + 전면으로.** 반환 = 손댄 창 수.
 *
 *  CDP `Page.bringToFront`는 회차에 따라 최소화된 창을 실제로 되살리지 못하고, 그러면
 *  `Focused(true)` 에지가 안 나서 "포커스 회복 → 토스트 소멸"이 측정되지 않는다.
 *  OS 입력은 **우리가 띄운 hwnd에만** 건다는 규칙 안에서, 제목으로 우리 본창을 찾아
 *  `ShowWindow(SW_RESTORE)` + `SetForegroundWindow`를 건다(사용자가 작업 표시줄에서
 *  창을 되살리는 것과 같은 경로). `winDump`는 최소화 창을 면적 필터로 걸러 내므로
 *  여기서는 따로 연다. */
function restoreMain(pid) {
  const out = ps(`
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class RM {
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public static int Raise(uint target, string want){
    int n = 0;
    EnumWindows((h,l)=>{
      uint p; GetWindowThreadProcessId(h, out p);
      if(p!=target) return true;
      var t = new StringBuilder(256); GetWindowTextW(h, t, 256);
      if(!t.ToString().Contains(want)) return true;
      ShowWindow(h, 9); SetForegroundWindow(h); n++;
      return true;
    }, IntPtr.Zero);
    return n; } }
"@
[RM]::Raise(${pid}, "AgentCodeGUI3")`)
  return Number(out) || 0
}

/** 그 PID가 소유한 **tray-icon 히든 창** 수(클래스 `tray_icon_app`).
 *  0×0 툴윈도라 `winDump`(100×100 이상)에는 안 잡힌다. `TrayIcon::drop`이
 *  `Shell_NotifyIcon(NIM_DELETE)` 직후 이 창을 `DestroyWindow`하므로,
 *  1 → 0 전이가 곧 "아이콘을 실제로 놓았다"의 OS 층 관측면이다. 열거만 한다. */
function trayClassWindows(pid) {
  const out = ps(`
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class TC {
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  public static int Count(uint target){
    int n = 0;
    EnumWindows((h,l)=>{
      uint p; GetWindowThreadProcessId(h, out p);
      if(p!=target) return true;
      var c = new StringBuilder(128); GetClassNameW(h, c, 128);
      if(c.ToString() == "tray_icon_app") n++;
      return true;
    }, IntPtr.Zero);
    return n; } }
"@
[TC]::Count(${pid})`)
  return Number(out) || 0
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

/** 한 턴을 **세 조각**으로 뱉는 대본 — 되감기(소실)를 눈금으로 재기 위한 재료.
 *  조각 사이 간격(2.6s)이 팝아웃 페르시스트 디바운스(600ms)보다 넉넉히 크므로,
 *  "마지막 조각이 복귀분에 실리기 전에 닫는" 순간을 확실히 만들 수 있다. */
function fakeSlowScript(HOME, WORK) {
  const SCRIPT = path.join(HOME, 'script.jsonl')
  const asst = (text) => ({
    emit: { type: 'assistant', session_id: 'POP-1', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text }], usage: { input_tokens: 5 } } }
  })
  fs.writeFileSync(
    SCRIPT,
    [
      { afterMs: 60, emit: { type: 'control_response', response: { subtype: 'success', request_id: 'init-1', response: {} } } },
      { emit: { type: 'system', subtype: 'init', session_id: 'POP-1', model: 'claude-haiku', cwd: WORK, tools: [], apiKeySource: 'none' } },
      { afterMs: 150, ...asst('LOSS-ONE 첫 조각') },
      { afterMs: 2600, ...asst('LOSS-TWO 둘째 조각') },
      { afterMs: 2600, ...asst('LOSS-THREE 셋째 조각') },
      { afterMs: 60, emit: { type: 'result', subtype: 'success', is_error: false, result: 'LOSS-THREE 셋째 조각', session_id: 'POP-1', total_cost_usd: 0, duration_ms: 1, num_turns: 1 } }
    ].map((s) => JSON.stringify(s)).join('\n') + '\n'
  )
  return SCRIPT
}

/** 격리 홈의 저장 파일 전수에서 마커를 찾는다 — 화면뿐 아니라 **디스크**까지 봤나.
 *  (chats-v3/·chats/·boards/ 어디에 떨어지든 잡히게 홈 전체를 훑는다) */
function diskMarks(HOME, marks) {
  const hit = new Set()
  const scan = (dir) => {
    let ents = []
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'engines' || e.name === 'webview2') continue // 정션·캐시는 안 본다
        scan(p)
      } else if (e.name.endsWith('.json')) {
        let txt = ''
        try { txt = fs.readFileSync(p, 'utf8') } catch { continue }
        for (const m of marks) if (txt.includes(m)) hit.add(m)
      }
    }
  }
  scan(HOME)
  return [...hit]
}

/** 멀티 그리드로 바로 뜨는 홈. `opts.slow`면 세 조각 대본(소실 검사용). */
function seedMultiHome(name, opts = {}) {
  const HOME = homeFor(name)
  const WORK = path.join(HOME, 'work')
  rmrf(HOME)
  fs.mkdirSync(WORK, { recursive: true })
  seedFakeCli(HOME)
  write(path.join(HOME, 'ui-prefs.json'), { 'ui.lang': 'ko', 'workspace.mode': 'multi', 'whatsnew.seenVersion': '9.9.9', 'notify.toast': true, ...(opts.prefs ?? {}) })
  write(path.join(HOME, 'profile.json'), { nickname: 'poc' })
  write(path.join(HOME, 'chats', 'index.json'), { version: 1, order: ['c-main'], activeChatId: 'c-main' })
  write(path.join(HOME, 'chats', 'c-main.json'), {
    id: 'c-main', title: '본채팅', custom: true, manualCwd: WORK,
    picker: { model: 'haiku', effort: 'minimal', mode: 'normal' }, refDirs: [],
    snapshot: { messages: [] }, updatedAt: 1
  })
  const SCRIPT = opts.slow ? fakeSlowScript(HOME, WORK) : fakeScript(HOME, WORK, '팝아웃 창에서 답한 줄')
  return { HOME, WORK, SCRIPT }
}

/** 단일 채팅 홈 (토스트·트레이용 — 그리드가 필요 없다) */
function seedSingleHome(name, opts = {}) {
  const HOME = homeFor(name)
  const WORK = path.join(HOME, 'work')
  rmrf(HOME)
  fs.mkdirSync(WORK, { recursive: true })
  seedFakeCli(HOME)
  write(path.join(HOME, 'ui-prefs.json'), { 'ui.lang': 'ko', 'workspace.mode': 'single', 'whatsnew.seenVersion': '9.9.9', 'notify.toast': true, ...(opts.prefs ?? {}) })
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
// 1b) **소실 0** — 팝아웃을 닫는 순간 답변이 사라지지 않는가 (R2 신설 · 크리틱 §3.1)
//
// R1에서 여기가 뚫려 있었다. 그리드는 팝아웃이 떠 있는 동안에도 같은 panelId의
// `ma:event`를 계속 리듀스하는데(전 창 브로드캐스트), 창의 페르시스트는 600ms
// 디바운스다. 그래서 복귀분은 **항상 라이브보다 같거나 낡았고**, 그걸 `load`로 전체
// 교체하던 R1은 마지막 답변을 화면과 chats-v3에서 함께 지웠다:
//   · 턴 종료 직후 닫기 → 다 읽은 답변이 **영구 손실**
//   · 스트리밍 중 닫기  → **스레드 한가운데 구멍**
// 두 시점 모두 재고, 화면뿐 아니라 **디스크까지** 본다.
// ─────────────────────────────────────────────────────────────────────────────
const MARKS = ['LOSS-ONE', 'LOSS-TWO', 'LOSS-THREE']

async function lossRound(when /* 'mid' | 'end' */, out) {
  const s = seedMultiHome(`loss-${when}`, { slow: true })
  const port = portFor(when === 'end' ? 9387 : 9386)
  const r = { when, home: s.HOME }
  const app = await boot(s.HOME, port, { CCG_FAKECLI_SCRIPT: s.SCRIPT })
  try {
    if (!(await waitUntil(app, `document.querySelector('.multi .ma-grid .ma-panel')`, 40000))) {
      fail(`L-${when}-부팅`, '멀티 그리드가 안 떴다', { log: app.log().slice(-600) })
      return
    }
    await sleep(1200)
    // 자리에 채팅을 앉힌다(팝아웃 단계와 같은 사용자 경로: F2 → 입력 → Enter)
    await app.j(`(() => { const b = document.querySelector('.ma-panel[data-slot="0"] .ma-p-tedit'); if (!b) return 'no'; b.click(); return 'ok' })()`)
    await waitUntil(app, `document.querySelector('.ma-panel[data-slot="0"] .ma-p-tin')`, 6000)
    await app.j(`(() => {
      const el = document.querySelector('.ma-panel[data-slot="0"] .ma-p-tin')
      if (!el) return 'no-input'
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      set.call(el, '소실 검사')
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      return 'named'
    })()`)
    await waitUntil(app, `(await (async () => { const b = ${IPC('board:get')}
      return (b?.boards ?? []).some((x) => x.id !== 'default' && (x.slots ?? []).some((v) => !!v)) })())`, 20000)

    await app.j(POPOUT_BTN)
    const pt = await findTarget(port, '#mapanel', 20000)
    if (!pt) { fail(`L-${when}-팝아웃`, '팝아웃 창이 안 떴다'); return }
    const pop = await attach(pt)
    if (!(await waitUntil(pop, `document.querySelector('.sw.pwin .pw-body .ma-panel')`, 25000))) {
      fail(`L-${when}-마운트`, '팝아웃 창에 PanelView가 안 섰다'); return
    }
    await sleep(600)
    // **창의 컴포저에서** 전송(소유권이 넘어간 뒤의 진짜 경로)
    r.sent = await pop.j(`(() => {
      const ta = document.querySelector('.pw-body .composer textarea') || document.querySelector('.pw-body textarea')
      if (!ta) return 'no'
      const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      set.call(ta, '소실 시험'); ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus()
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      return 'sent'
    })()`)
    const waitFor = when === 'mid' ? 'LOSS-TWO' : 'LOSS-THREE'
    if (!(await waitUntil(pop, `document.body.innerText.includes('${waitFor}')`, 30000))) {
      fail(`L-${when}-대본`, `${waitFor}가 창에 안 왔다`, { log: app.log().slice(-600) }); return
    }
    r.popAtClose = await pop.j(`${JSON.stringify(MARKS)}.filter((m) => document.body.innerText.includes(m))`)
    r.flushAtClose = (await app.j(`${IPC('win:surface-debug')}`))?.popout?.flushes ?? []
    // 닫기 — 디바운스가 아직 안 내려간 순간이다(대본 간격 2.6s ≫ 600ms).
    const tClose = Date.now()
    await pop.j(`(window.api.win.close(), 'x')`).catch(() => {})
    r.closedGone = await goneTarget(port, '#mapanel', 20000)
    r.closeMs = Date.now() - tClose
    if (!r.closedGone) fail(`L-${when}-닫힘`, '닫기 전 저장 유예를 준 창이 닫히지 않았다(새 실패 모드)')
    await sleep(1800)
    r.gridAfterClose = await app.j(`${JSON.stringify(MARKS)}.filter((m) => document.body.innerText.includes(m))`)
    // 스트리밍 중이었으면 남은 대본이 계속 흐른다 — 다 끝난 뒤의 최종 상태를 본다
    await sleep(5000)
    r.gridFinal = await app.j(`${JSON.stringify(MARKS)}.filter((m) => document.body.innerText.includes(m))`)
    r.surface = await app.j(`${IPC('win:surface-debug')}`)
    r.flushReqs = r.surface?.popout?.flushReqs ?? 0
    await sleep(1500)
    r.disk = diskMarks(s.HOME, MARKS)
    const lostUi = MARKS.filter((m) => !r.gridFinal.includes(m))
    const lostDisk = MARKS.filter((m) => !r.disk.includes(m))
    if (lostUi.length || lostDisk.length) {
      fail(`L-${when}-소실`, `팝아웃을 닫았더니 답변 조각이 사라졌다 — 화면:${lostUi.join(',') || '-'} 디스크:${lostDisk.join(',') || '-'}`, {
        pop: r.popAtClose, grid: r.gridFinal, disk: r.disk, flush: r.flushAtClose
      })
    } else ok(`L-${when}-소실0`, { grid: r.gridFinal, disk: r.disk })
    // 닫기 전 마지막 저장 요청이 실제로 나갔나(추가 채팅 창의 chat:flush-req와 같은 규약)
    if (r.flushReqs < 1) fail(`L-${when}-flushReq`, '닫기 전 마지막 저장 요청이 안 나갔다', { flushReqs: r.flushReqs })
    else ok(`L-${when}-flushReq`, { flushReqs: r.flushReqs, closeMs: r.closeMs })
    pop.cdp.close()
  } finally {
    killTree(app.child.pid)
    await sleep(800)
    if (!KEEP) rmrf(s.HOME)
  }
  out[when] = r
}

async function phaseLoss() {
  console.log('\n[LOSS] 팝아웃 닫기 = 소실 0 (화면 + 디스크)')
  const out = {}
  await lossRound('end', out) // 답을 다 읽고 닫는다 — 가장 자연스러운 동작
  await lossRound('mid', out) // 스트리밍 한복판에 닫는다 — 구멍이 나는가
  rep.steps.loss = out
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
    //
    // ★R2 — `Page.bringToFront` 한 번으로는 **OS 포커스가 실제로 오지 않는 회차**가 있다
    //   (자동화 프로세스가 다른 창을 쥐고 있으면 그렇다). 그 회차에 셸의 `is_focused()`는
    //   false라 토스트가 정상적으로 뜨고, 검사만 "억제 실패"로 잘못 찍힌다. 포커스를
    //   **실제로 잡을 때까지** 확인하고 나서 알림을 던진다(못 잡으면 그 사실을 싣는다).
    //   판정 술어는 **셸의 `is_focused()`**다(`win:surface-debug.mainFocused`).
    //   `document.hasFocus()`로 대신 재면 어긋난다 — 실측으로 페이지는 true인데 셸은
    //   false인 회차가 있었다(웹뷰 내부 포커스 ≠ `GetForegroundWindow`).
    out.focusTries = 0
    for (let i = 0; i < 16; i++) {
      restoreMain(app.child.pid)
      await app.cdp.send('Page.bringToFront').catch(() => {})
      await sleep(500)
      out.focusTries = i + 1
      if ((await app.j(`${IPC('win:surface-debug')}`).catch(() => null))?.mainFocused) break
    }
    out.mainFocused = (await app.j(`${IPC('win:surface-debug')}`).catch(() => null))?.mainFocused ?? false
    await app.j(`(${NOTIFY1}, 'sent')`)
    await sleep(1500)
    out.whileFocused = (await listTargets(port)).some((t) => t.url.includes('toast.html'))
    out.dbgFocused = await app.j(`${IPC('win:surface-debug')}`)
    if (out.whileFocused) {
      fail('T1-포커스억제', `포커스 중인데도 토스트가 떴다(본창 hasFocus=${out.mainFocused})`, {
        notify: out.dbgFocused?.notify, focusTries: out.focusTries
      })
    } else ok('T1-포커스억제', { focusTries: out.focusTries })

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
    //
    // ★R2 — R1은 `screenX + w ≈ availWidth`로 쟀다. `screenX`는 **가상 데스크톱 좌표**고
    //   `availWidth`는 **그 모니터의 폭**이라, 커서가 보조 모니터에 있으면 이 식은 항상
    //   틀린다(크리틱 §6-3: 실측 x=4752 · availW=2560 → 자리는 맞는데 검사가 실패).
    //   `screen.availLeft/availTop`으로 **모니터 로컬 좌표**로 환산해서 잰다.
    await sleep(600)
    out.placed = await toast.j(`({ w: window.outerWidth, h: window.outerHeight, x: window.screenX, y: window.screenY,
      availW: window.screen.availWidth, availH: window.screen.availHeight,
      availLeft: window.screen.availLeft ?? 0, availTop: window.screen.availTop ?? 0,
      dpr: window.devicePixelRatio })`)
    const pl = out.placed
    // 프레임리스 창에는 비가시 리사이즈 테두리(8px)가 붙어 outerWidth가 그만큼 크다 — 24px 허용
    out.local = pl && { x: pl.x - pl.availLeft, y: pl.y - pl.availTop }
    out.bottomRight =
      !!pl && Math.abs(out.local.x + pl.w - pl.availW) <= 24 && Math.abs(out.local.y + pl.h - pl.availH) <= 24
    if (!out.bottomRight) fail('T4-자리', '토스트가 (커서가 있는 모니터의) 작업 영역 우하단에 안 앉았다', { ...pl, local: out.local })
    else ok('T4-자리', { ...pl, local: out.local })

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

    // (e) 클릭이 그 창 몫을 비웠는가 — 여기까지는 **클릭 경로**의 소멸이다
    await sleep(1200)
    out.goneAfterClick = await goneTarget(port, 'toast.html', 12000)
    out.dbgAfterClick = await app.j(`${IPC('win:surface-debug')}`)
    if (!out.goneAfterClick) fail('T5-클릭소멸', '카드를 눌렀는데 그 창 몫이 안 비워졌다', out.dbgAfterClick?.notify)
    else ok('T5-클릭소멸', { pending: out.dbgAfterClick?.notify?.count })

    // (f) ★R2 — **포커스 회복만으로** 사라지는가.
    //
    //   R1의 T6은 이 경로를 **한 번도 실행하지 않았다**(크리틱 §6-2). 바로 앞 T5가
    //   카드를 클릭하는데, 두 항목 모두 owner="main"이라 `notify::open`이
    //   `clear_for_window("main")`으로 그 순간 목록을 비우고 창까지 부순다. T6이
    //   `goneTarget`을 물었을 때는 이미 사라진 뒤였다 — 즉 "포커스 회복 → 자동 소멸"은
    //   측정된 적이 없다. 그래서 여기서 **새 알림을 다시 넣고, 클릭하지 않고**,
    //   본창 포커스만 되돌려 잰다.
    await app.j(`(window.api.win.minimize(), 'min')`)
    await sleep(900)
    await app.j(`(${NOTIFY1}, 'sent')`)
    await app.j(`(${NOTIFY2}, 'sent')`)
    const t6 = await findTarget(port, 'toast.html', 15000)
    out.refocusPre = !!t6
    out.dbgBeforeRefocus = await app.j(`${IPC('win:surface-debug')}`)
    if (!t6) {
      fail('T6-재투입', '두 번째 알림 묶음이 토스트를 못 띄웠다', out.dbgBeforeRefocus?.notify)
    } else {
      // 클릭 없이 본창만 앞으로 — 이것만으로 그 창 몫이 비워져야 한다
      restoreMain(app.child.pid)
      await app.cdp.send('Page.bringToFront').catch(() => {})
      await sleep(1500)
      out.gone = await goneTarget(port, 'toast.html', 12000)
      out.dbgAfter = await app.j(`${IPC('win:surface-debug')}`)
      if (!out.gone) fail('T6-포커스소멸', '본창이 포커스를 되찾았는데 토스트가 남았다', out.dbgAfter?.notify)
      else ok('T6-포커스소멸', { before: out.dbgBeforeRefocus?.notify?.count, pending: out.dbgAfter?.notify?.count })
    }

    // (g) ★R2 — **폭주 10건**: 창이 하나인가 · 10행인가 · 작업 영역 안인가.
    //
    //   R1에는 이 검사가 없었고, 크리틱의 공격 하네스가 여기서 창 두 개를 만들었다:
    //   `notify:event`는 async 커맨드라 10건이 **동시에** 들어오는데 `ensure()`의
    //   "창이 있나?"와 `build()` 사이가 벌어져 같은 라벨로 창이 둘 만들어지고, tauri
    //   레지스트리에 남지 않은 쪽이 **항상 위 빈 카드**로 화면에 눌러앉는다(고아 창).
    //   `push()`를 한 줄로 세워 없앴다(notify.rs `PUSH_LOCK`) — 그 회귀 감시가 여기다.
    await app.j(`(window.api.win.minimize(), 'min')`)
    await sleep(900)
    const tBurst = Date.now()
    await app.j(`(() => { for (let i = 0; i < 10; i++) window.api.notify.event({ kind: i % 2 ? 'ask' : 'done', title: '폭주' + i, preview: '알림 ' + i, target: { surface: 'single', id: 'b-' + i } }); return 'burst' })()`)
    const bt = await findTarget(port, 'toast.html', 15000)
    out.burstMs = Date.now() - tBurst
    if (!bt) {
      fail('T7-폭주표시', '10건을 보냈는데 토스트 창이 안 떴다', await app.j(`${IPC('win:surface-debug')}`))
    } else {
      const burst = await attach(bt)
      out.burstRows = await waitUntil(burst, `document.querySelectorAll('#card .t-agg .t-row').length >= 10`, 15000)
      out.burstRowCount = await burst.j(`document.querySelectorAll('#card .t-agg .t-row').length`)
      out.burstWindows = (await listTargets(port)).filter((t) => t.url.includes('toast.html')).length
      out.burstDbg = await app.j(`${IPC('win:surface-debug')}`)
      out.burstPlaced = await burst.j(`({ w: window.outerWidth, h: window.outerHeight, x: window.screenX, y: window.screenY,
        availW: window.screen.availWidth, availH: window.screen.availHeight,
        availLeft: window.screen.availLeft ?? 0, availTop: window.screen.availTop ?? 0 })`)
      const bp = out.burstPlaced
      const local = { x: bp.x - bp.availLeft, y: bp.y - bp.availTop }
      out.burstLocal = local
      out.burstOnScreen = local.y >= -2 && local.y + bp.h <= bp.availH + 2 && local.x + bp.w <= bp.availW + 24
      if (out.burstWindows !== 1) fail('T7-창하나', `토스트 문서가 ${out.burstWindows}개다(고아 창 — ensure 경합)`, { dbg: out.burstDbg?.notify })
      else ok('T7-창하나')
      if (!out.burstRows) fail('T7-행수', `10건인데 행이 ${out.burstRowCount}개다`, { count: out.burstDbg?.notify?.count })
      else ok('T7-행수', { rows: out.burstRowCount, ms: out.burstMs })
      // 자리 — **모니터 로컬 좌표**로 잰다(T4와 같은 이유)
      if (!out.burstOnScreen) fail('T7-자리', '10행 카드가 작업 영역을 벗어났다', { ...bp, local })
      else ok('T7-자리', { ...bp, local })
      burst.cdp.close()
    }
    // 정리 겸 검사 — 포커스 회복만으로 10건이 한 번에 걷히는가(최소화 복원은 몇 프레임 걸린다)
    out.burstCleared = false
    for (let i = 0; i < 24; i++) {
      restoreMain(app.child.pid)
      await app.cdp.send('Page.bringToFront').catch(() => {})
      await sleep(500)
      if ((await app.j(`${IPC('win:surface-debug')}`))?.notify?.count === 0) {
        out.burstCleared = true
        break
      }
    }
    out.burstGone = out.burstCleared && (await goneTarget(port, 'toast.html', 10000))
    if (!out.burstCleared) fail('T7-소멸', '폭주 10건이 포커스 회복으로 안 걷혔다', await app.j(`${IPC('win:surface-debug')}`))
    else if (!out.burstGone) fail('T7-창소멸', '목록은 비었는데 토스트 문서가 남았다(고아 창)')
    else ok('T7-소멸')
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
    // ★R2 — 이제 첫 숨김에 **안내 카드**가 하나 뜬다(아래 R6). "숨었다"의 판정은
    //   **본창**(가로 600px 초과)이 안 보이는 것이다 — 안내 카드는 336×~90이라 안 걸린다.
    out.bigVisibleAfterX = out.winsAfterX.filter((w) => w.visible && Number(w.size.split('x')[0]) > 600).length
    out.visibleAfterX = out.winsAfterX.filter((w) => w.visible).length
    if (!out.aliveAfterX) fail('R2-생존', 'X를 눌렀더니 프로세스가 죽었다(트레이로 안 숨었다)')
    else if (out.bigVisibleAfterX !== 0) fail('R2-숨김', 'X를 눌렀는데 본창이 여전히 보인다', out.winsAfterX)
    else ok('R2-숨김', { alive: true, mainVisible: 0, otherVisible: out.visibleAfterX })

    // (a2) ★R2 — **첫 숨김 안내**: X가 종료가 아니라는 것을 알리는 유일한 자리.
    //      R1에는 안내가 아예 없어 "껐구나" 하고 넘어가는 동안 프로세스가 계속 돌았다
    //      (크리틱 §4 — 무게 「상」). 카드가 실제로 뜨고, 눌러서 창이 돌아오고,
    //      두 번째 X에는 다시 안 뜨는지까지 본다.
    out.dbgAfterX = await app.j(`${IPC('win:surface-debug')}`)
    out.noticeWindow = !!out.dbgAfterX?.tray?.noticeWindow
    out.noticeCard = out.winsAfterX.find((w) => w.visible && Number(w.size.split('x')[0]) <= 600) ?? null
    if (!out.noticeWindow) fail('R6-안내', '처음 트레이로 숨었는데 안내 카드가 안 떴다', out.dbgAfterX?.tray)
    else ok('R6-안내', { card: out.noticeCard, shown: out.dbgAfterX?.tray?.noticeShown })
    // 카드 문구 + 클릭 = 복원
    const nt = await findTarget(port, 'tray.html', 12000)
    if (!nt) fail('R6-카드페이지', '안내 카드 문서를 못 찾았다', { targets: await listTargets(port) })
    else {
      const notice = await attach(nt)
      out.noticeRows = await notice.j(`[...document.querySelectorAll('#menu .row')].map((r) => r.innerText)`)
      out.noticeBounds = await notice.j(`({ w: window.outerWidth, h: window.outerHeight, x: window.screenX, y: window.screenY,
        availW: window.screen.availWidth, availH: window.screen.availHeight,
        availLeft: window.screen.availLeft ?? 0, availTop: window.screen.availTop ?? 0 })`)
      out.noticeHasFocus = await notice.j(`document.hasFocus()`)
      const words = (out.noticeRows ?? []).join(' ')
      if (!/트레이|tray/i.test(words) || !/완전히 종료|Quit completely/.test(words)) {
        fail('R6-문구', '안내에 "트레이에서 계속 실행"과 "완전히 종료" 안내가 다 있지 않다', { rows: out.noticeRows })
      } else ok('R6-문구', out.noticeRows)
      if (out.noticeHasFocus) fail('R6-포커스탈취', '안내 카드가 포커스를 가져갔다(WS_EX_NOACTIVATE 미적용?)', out.noticeBounds)
      else ok('R6-포커스탈취없음', out.noticeBounds)
      // 첫 행 클릭 = 창 복원
      await notice.j(`(document.querySelector('#menu .row')?.click(), 'click')`).catch(() => {})
      await sleep(1800)
      out.restoredByNotice = winDump(app.child.pid).some((w) => w.visible && Number(w.size.split('x')[0]) > 600)
      out.noticeGone = await goneTarget(port, 'tray.html', 10000)
      if (!out.restoredByNotice) fail('R6-복원', '안내 카드를 눌렀는데 창이 안 돌아왔다', { wins: winDump(app.child.pid) })
      else ok('R6-복원')
      if (!out.noticeGone) fail('R6-소멸', '창이 돌아왔는데 안내 카드가 남았다')
      else ok('R6-소멸')
    }
    // 두 번째 X — 안내는 **한 번만**이다
    await app.j(`(window.api.win.close(), 'x')`)
    await sleep(1500)
    out.dbgSecondX = await app.j(`${IPC('win:surface-debug')}`)
    if (out.dbgSecondX?.tray?.noticeWindow) fail('R6-일회성', '두 번째 X에도 안내가 또 떴다', out.dbgSecondX?.tray)
    else ok('R6-일회성', { noticeShown: out.dbgSecondX?.tray?.noticeShown })

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

      // ★R2 — **발신자 가드**(크리틱 §5.3 · 2.6.2 index.ts:853). 메뉴 창이 아닌
      //   렌더러가 `traymenu:resize`를 부르면 메뉴 창이 낡은 앵커 자리로 끌려가고
      //   포커스를 뺏겼다. 지금은 무시돼야 한다 — 본창에서 불러 보고 자리를 다시 잰다.
      await app.j(`${IPC('traymenu:resize', [640])}`).catch(() => {})
      await sleep(700)
      out.menuBoundsAfterSpoof = await menu.j(`({ w: window.outerWidth, h: window.outerHeight, x: window.screenX, y: window.screenY })`)
      out.resizeGuard =
        JSON.stringify(out.menuBounds) === JSON.stringify(out.menuBoundsAfterSpoof)
      if (!out.resizeGuard) fail('R4-발신자가드', '메뉴 창이 아닌 창의 traymenu:resize가 먹혔다', { before: out.menuBounds, after: out.menuBoundsAfterSpoof })
      else ok('R4-발신자가드', out.menuBoundsAfterSpoof)
      // 같은 채널의 action도 본창에서는 안 먹어야 한다(있던 가드 — 회귀 감시)
      await app.j(`${IPC('traymenu:action', ['quit'])}`).catch(() => {})
      await sleep(900)
      out.aliveAfterSpoofQuit = pidAlive(app.child.pid)
      if (!out.aliveAfterSpoofQuit) fail('R4-액션가드', '본창이 보낸 traymenu:action("quit")이 앱을 껐다')
      else ok('R4-액션가드')

      // Esc = 닫기
      await menu.j(`(window.api.trayMenu.action(''), 'esc')`).catch(() => {})
      out.menuClosed = await goneTarget(port, 'tray.html', 10000)
      if (!out.menuClosed) fail('R4-닫기', 'Esc로 메뉴 창이 안 닫혔다')
      else ok('R4-닫기')
    }

    // (c2) ★R2 — **트레이 아이콘 해제**(크리틱 §3.3 · 2.6.2 index.ts:2174 `tray?.destroy()`).
    //      `TrayIcon`은 refcount라 `NIM_DELETE`가 Drop에서만 나가는데 R1은 `OnceLock`에
    //      담아 두었다 = static은 절대 drop되지 않는다 = 죽은 아이콘이 알림 영역에 남는다.
    //      종료 뒤에는 프로세스가 없어 관측할 수 없으므로, **살아 있는 동안** 종료가
    //      부르는 바로 그 함수(`release_icon`)를 진단 채널로 태우고 두 층에서 잰다:
    //        ① 셸 회계 `tray.tray`가 false로 떨어진다(값이 실제로 take됐다)
    //        ② tray-icon이 만든 히든 창(클래스 `tray_icon_app`)이 **OS 창 목록에서
    //           사라진다** — Drop이 `DestroyWindow`까지 돌았다는 뜻이고, 그 바로 앞줄이
    //           `Shell_NotifyIcon(NIM_DELETE)`다(tray-icon 0.24 windows/mod.rs:305-318).
    out.trayClassBefore = trayClassWindows(app.child.pid)
    out.releaseCall = await app.j(`${IPC('win:surface-debug', ['tray-release'])}`)
    for (let i = 0; i < 40; i++) {
      out.dbgAfterRelease = await app.j(`${IPC('win:surface-debug')}`)
      if (!out.dbgAfterRelease?.tray?.tray) break
      await sleep(100)
    }
    out.trayClassAfter = trayClassWindows(app.child.pid)
    if (out.trayClassBefore < 1) fail('R7-아이콘창', 'tray-icon 히든 창(tray_icon_app)이 애초에 없다', { before: out.trayClassBefore })
    else if (out.dbgAfterRelease?.tray?.tray) fail('R7-해제', 'release_icon 뒤에도 트레이 핸들이 남아 있다', out.dbgAfterRelease?.tray)
    else if (out.trayClassAfter !== 0) fail('R7-Drop', 'Drop이 안 돌았다 — tray_icon_app 히든 창이 남아 있다(NIM_DELETE 미발송)', { before: out.trayClassBefore, after: out.trayClassAfter })
    else ok('R7-아이콘해제', { trayIconWindows: `${out.trayClassBefore} → ${out.trayClassAfter}`, before: out.releaseCall?.before })

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

    // (a) 유리 — 팝아웃 창 문서가 부팅 스냅샷을 받았나
    const g1 = await pop.j(`(window.__CCG_BOOT && window.__CCG_BOOT['ui-glass:state']) ?? null`)
    out.popoutGlassBoot = g1 ? { ok: g1.ok, windows: g1.health?.windows, backdrops: g1.health?.backdrops } : null
    const g2 = await app.j(`(${IPC('win:surface-debug')})`)
    out.windowsNow = g2?.windows ?? []
    if (!g1) fail('D1-유리부팅', '팝아웃 창 문서에 유리 스냅샷이 안 실렸다')
    else ok('D1-유리부팅', out.popoutGlassBoot)

    // (a2) ★R2 — **팝아웃이 유리 감시 목록에 실제로 올라갔나**(크리틱 §5.1·§6-1).
    //   R1은 위 `windows:1`을 그 근거로 들었는데, 그 스냅샷은 `popout::open()`이
    //   `boot_script()`를 만드는 시점 = **`glass::arm`보다 앞**에서 찍힌다
    //   (popout.rs:164 vs :174). 즉 `windows:1`은 "메인 창 하나만 감시 중"이라는 뜻이고
    //   그 문서 자신은 아직 목록에 없다 — 아무것도 증명하지 않는다.
    //   눈금을 바꾼다: 팝아웃을 **하나 더** 열고, 두 번째 창의 부팅 스냅샷에서
    //   감시 창 수가 1 → 2로 느는지 본다. 늘었다면 첫 팝아웃이 arm을 탄 것이다.
    await app.j(`(() => { const b = document.querySelector('.ma-panel[data-slot="1"] .ma-p-tedit'); if (!b) return 'no'; b.click(); return 'ok' })()`)
    await waitUntil(app, `document.querySelector('.ma-panel[data-slot="1"] .ma-p-tin')`, 6000)
    await app.j(`(() => {
      const el = document.querySelector('.ma-panel[data-slot="1"] .ma-p-tin')
      if (!el) return 'no-input'
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      set.call(el, '유리 B'); el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 'named'
    })()`)
    await sleep(1400)
    await app.j(`(() => {
      const b = [...document.querySelectorAll('.ma-panel[data-slot="1"] button')].find((x) => /별도 창으로|own window/.test(x.getAttribute('aria-label') || ''))
      if (!b) return false
      b.click(); return true })()`)
    await sleep(3000)
    out.mapanelPages = (await listTargets(port)).filter((t) => t.url.includes('#mapanel')).length
    out.pop2GlassBoot = null
    for (const t of (await listTargets(port)).filter((x) => x.url.includes('#mapanel'))) {
      const w = await attach(t)
      const h = await w.j(`(window.__CCG_BOOT && window.__CCG_BOOT['ui-glass:state']?.health) ?? null`)
      if ((h?.windows ?? 0) > (g1?.health?.windows ?? 0)) out.pop2GlassBoot = h
      w.cdp.close()
    }
    if (!out.pop2GlassBoot) {
      fail('D1b-유리arm', '두 번째 팝아웃의 부팅 스냅샷에서 감시 창 수가 안 늘었다(첫 팝아웃이 glass::arm을 안 탄 것)', {
        pop1: out.popoutGlassBoot, pages: out.mapanelPages
      })
    } else ok('D1b-유리arm', { pop1: out.popoutGlassBoot?.windows, pop2: out.pop2GlassBoot.windows, backdrops: out.pop2GlassBoot.backdrops })

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
    // ★R2 — 메인 창을 `findTarget('index.html')`로 고르면 **팝아웃**이 잡힌다
    //   (메인 창 URL은 `http://tauri.localhost/`라 그 조각이 없고, 팝아웃이
    //   `index.html#mapanel`이다 — 크리틱 §6-4). `mainTarget()`으로 고른다.
    out.mainRemounted = await (async () => {
      const t = await mainTarget(port, 20000)
      if (!t) return false
      out.mainUrl = t.url
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

// ─────────────────────────────────────────────────────────────────────────────
// 6) 언어 — UI 언어를 en으로 두면 **셸이 그리는 표면도** 영어인가 (R2 신설)
//
// R1의 `tray.rs`는 ui-prefs를 `"lang"`으로 읽었다. 3.0의 그 키는 `"ui.lang"` 하나뿐이라
// (렌더러 i18n·ipc/stores·ccg-fs 전부) 트레이 메뉴는 **영원히 한국어**였다(크리틱 §3.4).
// 셸이 문자열을 직접 만드는 자리가 늘 때마다 같은 실수가 재발할 수 있어 눈금을 남긴다.
// ─────────────────────────────────────────────────────────────────────────────
async function phaseLang() {
  console.log('\n[LANG] UI 언어 en — 셸이 그리는 표면')
  const s = seedSingleHome('lang', { prefs: { 'ui.lang': 'en' } })
  const port = portFor(9388)
  const out = { home: s.HOME }
  const app = await boot(s.HOME, port)
  try {
    await waitUntil(app, `document.querySelector('#root').children.length > 0`, 30000)
    await sleep(900)
    out.pref = await app.j(`(await window.api.uiPrefs.get())['ui.lang'] ?? null`).catch(() => null)
    // 트레이 메뉴
    await app.j(`${IPC('win:surface-debug', ['traymenu-open'])}`)
    const mt = await findTarget(port, 'tray.html', 15000)
    if (!mt) { fail('G1-메뉴', '메뉴 창이 안 떴다'); return }
    const menu = await attach(mt)
    await waitUntil(menu, `document.querySelectorAll('#menu .row').length >= 2`, 10000)
    out.menuItems = await menu.j(`[...document.querySelectorAll('#menu .row')].map((r) => r.innerText)`)
    if ((out.menuItems ?? []).some((x) => /[가-힣]/.test(x))) {
      fail('G1-메뉴언어', `ui.lang=en인데 트레이 메뉴가 한국어다: ${JSON.stringify(out.menuItems)}`, { pref: out.pref })
    } else ok('G1-메뉴언어', out.menuItems)
    await menu.j(`(window.api.trayMenu.action(''), 'esc')`).catch(() => {})
    await goneTarget(port, 'tray.html', 8000)
    // 첫 숨김 안내 카드도 같은 키를 읽는다
    await app.j(`(window.api.win.close(), 'x')`)
    await sleep(1600)
    const nt = await findTarget(port, 'tray.html', 12000)
    if (!nt) { fail('G2-안내', 'ui.lang=en에서 첫 숨김 안내가 안 떴다'); return }
    const notice = await attach(nt)
    out.noticeItems = await notice.j(`[...document.querySelectorAll('#menu .row')].map((r) => r.innerText)`)
    if ((out.noticeItems ?? []).some((x) => /[가-힣]/.test(x))) {
      fail('G2-안내언어', `ui.lang=en인데 안내 카드가 한국어다: ${JSON.stringify(out.noticeItems)}`)
    } else ok('G2-안내언어', out.noticeItems)
  } finally {
    killTree(app.child.pid)
    await sleep(800)
    if (!KEEP) rmrf(s.HOME)
  }
  rep.steps.lang = out
}

// ── 실행 ────────────────────────────────────────────────────────────────────
const PHASES = {
  popout: phasePopout,
  loss: phaseLoss,
  toast: phaseToast,
  tray: phaseTray,
  lang: phaseLang,
  cost: phaseCost,
  defense: phaseDefense
}

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
