// 크리틱 M1 R1 검증 — 두 앱을 격리 홈으로 나란히 띄우고 직접 재현한다.
//
//   node docs/critic/tools/m1-r1-verify.mjs
//
// 하는 일
//  1) Electron(2.6.2, CCG_HOME=.bench-home, CDP 9333) + Tauri(3.0.0, .bench-home-tauri, 9334) 동시 부팅
//  2) 두 창을 같은 크기로 나란히 배치 → 전체 화면 1장 캡처(아크릴·타이틀바·DWM 포함)
//  3) 각 앱 CDP Page.captureScreenshot (웹 콘텐츠만 — 레이아웃·폰트 비교용)
//  4) Tauri: 콘솔 에러/예외 수집, window.api 표면 대조, win.* 왕복, 설정/새 채팅 모달 구동
//  5) 산출: docs/critic/shots/*.png + docs/critic/m1-r1-data.json
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { spawn } from 'node:child_process'
import { electronProfile, tauriProfile, connectMainPage, cdpTargets, Cdp, killTree, sleep, REPO } from '../../../bench/lib.mjs'

const SHOTS = path.join(REPO, 'docs', 'critic', 'shots')
fs.mkdirSync(SHOTS, { recursive: true })
const DATA = { at: new Date().toISOString(), tauri: {}, electron: {} }
const spawned = []

function ps(script) {
  return execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    timeout: 60000
  })
}

// ── Win32 도우미 (창 스타일·배치·화면 캡처) ─────────────────────────────────────
const WIN32_PRELUDE = String.raw`
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class N {
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", SetLastError=true)] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static IntPtr MainOf(uint target){
    IntPtr best=IntPtr.Zero; int bestArea=0;
    EnumWindows((h,l)=>{
      if(!IsWindowVisible(h)) return true;
      uint p; GetWindowThreadProcessId(h,out p);
      if(p!=target) return true;
      RECT r; GetWindowRect(h,out r);
      int a=(r.Right-r.Left)*(r.Bottom-r.Top);
      if(a>bestArea){ bestArea=a; best=h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
}
"@
`

function winInfo(pid) {
  const out = ps(
    WIN32_PRELUDE +
      String.raw`
$h=[N]::MainOf(${pid})
if($h -eq [IntPtr]::Zero){ '{"found":false}'; exit }
$r=New-Object N+RECT; [void][N]::GetWindowRect($h,[ref]$r)
$c=New-Object N+RECT; [void][N]::GetClientRect($h,[ref]$c)
$style=[N]::GetWindowLong($h,-16); $ex=[N]::GetWindowLong($h,-20)
$sb=New-Object System.Text.StringBuilder 256; [void][N]::GetWindowText($h,$sb,256)
@{ found=$true; hwnd=[int64]$h; title=$sb.ToString();
   rect=@{l=$r.Left;t=$r.Top;r=$r.Right;b=$r.Bottom};
   client=@{w=$c.Right-$c.Left;h=$c.Bottom-$c.Top};
   style=$style; exstyle=$ex;
   WS_THICKFRAME=[bool]($style -band 0x00040000);
   WS_CAPTION=[bool]($style -band 0x00C00000);
   WS_MAXIMIZEBOX=[bool]($style -band 0x00010000);
   WS_MINIMIZEBOX=[bool]($style -band 0x00020000);
   maximized=[N]::IsZoomed($h); minimized=[N]::IsIconic($h) } | ConvertTo-Json -Compress
`
  )
  return JSON.parse(out.trim())
}

function placeWindow(pid, x, y, w, h) {
  ps(
    WIN32_PRELUDE +
      String.raw`
$h=[N]::MainOf(${pid})
if($h -ne [IntPtr]::Zero){
  [void][N]::SetWindowPos($h,[IntPtr]::Zero,${x},${y},${w},${h},0x0040)
  [void][N]::SetForegroundWindow($h)
}
''
`
  )
}

function grabScreen(file) {
  ps(String.raw`
Add-Type -AssemblyName System.Drawing,System.Windows.Forms
$b=[System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height
$g=[System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size)
$bmp.Save('${file.replace(/\\/g, '\\\\')}',[System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
''
`)
}

function grabRegion(file, x, y, w, h) {
  ps(String.raw`
Add-Type -AssemblyName System.Drawing
$bmp=New-Object System.Drawing.Bitmap ${w},${h}
$g=[System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(${x},${y},0,0,$bmp.Size)
$bmp.Save('${file.replace(/\\/g, '\\\\')}',[System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
''
`)
}

// ── CDP 콘솔 수집기 ─────────────────────────────────────────────────────────────
function attachConsole(cdp, sink) {
  cdp.listeners.push((msg) => {
    if (msg.method === 'Runtime.consoleAPICalled') {
      const { type, args } = msg.params
      const text = (args ?? []).map((a) => a.value ?? a.description ?? a.unserializableValue ?? `[${a.type}]`).join(' ')
      sink.push({ kind: 'console', type, text })
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails
      sink.push({
        kind: 'exception',
        type: 'error',
        text: d.exception?.description ?? d.text ?? 'uncaught',
        url: d.url,
        line: d.lineNumber
      })
    } else if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry
      sink.push({ kind: 'log', type: e.level, text: `${e.source}: ${e.text}`, url: e.url })
    }
  })
}

async function shot(cdp, file) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
  return file
}

async function boot(profile, label) {
  const child = spawn(profile.cmd, profile.args, {
    env: { ...process.env, ...profile.env },
    cwd: profile.cwd,
    stdio: 'ignore'
  })
  spawned.push(child.pid)
  console.log(`[${label}] spawned pid ${child.pid}`)
  const logs = []
  const cdp = await connectMainPage(profile.port, { timeoutMs: 60000 })
  await cdp.send('Runtime.enable')
  await cdp.send('Log.enable')
  await cdp.send('Page.enable')
  attachConsole(cdp, logs)
  for (;;) {
    const ok = await cdp.eval(profile.mountExpr).catch(() => false)
    if (ok) break
    await sleep(60)
  }
  console.log(`[${label}] #root mounted`)
  return { child, cdp, logs }
}

// ─────────────────────────────────────────────────────────────────────────────
const EXPECTED = JSON.parse(
  execFileSync(process.execPath, [path.join(REPO, 'docs', 'critic', 'tools', 'api-surface.mjs'), '--json'], {
    encoding: 'utf8'
  })
).map((e) => e.path)
DATA.expectedApiCount = EXPECTED.length

try {
  // 스텁 package.json 재현 확인 — 부팅 전에 지운다
  const strayPath = path.join(REPO, '.bench-home-tauri', 'package.json')
  const strayBefore = fs.existsSync(strayPath)
  try { fs.rmSync(strayPath) } catch { /* 없음 */ }

  const ta = await boot(tauriProfile({ port: 9334 }), 'tauri')
  const el = await boot(electronProfile({ port: 9333 }), 'electron')

  await sleep(3000)
  DATA.tauri.strayPackageJsonBefore = strayBefore
  DATA.tauri.strayPackageJsonRecreated = fs.existsSync(strayPath)

  // ── 나란히 배치 + 전체 화면 캡처 ────────────────────────────────────────────
  placeWindow(el.child.pid, 20, 60, 1240, 830)
  placeWindow(ta.child.pid, 1280, 60, 1240, 830)
  await sleep(1500)
  placeWindow(el.child.pid, 20, 60, 1240, 830) // 포커스 순서 때문에 한 번 더
  await sleep(400)
  placeWindow(ta.child.pid, 1280, 60, 1240, 830)
  await sleep(1200)
  grabScreen(path.join(SHOTS, 'm1-r1-sidebyside.png'))
  grabRegion(path.join(SHOTS, 'm1-r1-el-window.png'), 20, 60, 1240, 830)
  grabRegion(path.join(SHOTS, 'm1-r1-ta-window.png'), 1280, 60, 1240, 830)

  DATA.electron.win = winInfo(el.child.pid)
  DATA.tauri.win = winInfo(ta.child.pid)

  // ── CDP 웹 콘텐츠 캡처 (레이아웃·폰트) ──────────────────────────────────────
  await shot(el.cdp, path.join(SHOTS, 'm1-r1-el-main.png'))
  await shot(ta.cdp, path.join(SHOTS, 'm1-r1-ta-main.png'))

  // ── DOM 요약 diff ───────────────────────────────────────────────────────────
  const domProbe = `(() => {
    const q = (s) => document.querySelector(s)
    const cs = (s, p) => { const e = q(s); return e ? getComputedStyle(e)[p] : null }
    return {
      title: document.title,
      href: location.href,
      rootKids: document.getElementById('root')?.children.length ?? 0,
      nodes: document.querySelectorAll('*').length,
      win: !!q('.win'),
      sbTop: !!q('.sb-top'),
      winCtl: document.querySelectorAll('.win-ctl button').length,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      bodyFont: getComputedStyle(document.body).fontFamily,
      htmlBg: getComputedStyle(document.documentElement).backgroundColor,
      dragRegion: cs('.sb-top', '-webkit-app-region'),
      noDragRegion: (() => { const e = q('.win-ctl button'); return e ? getComputedStyle(e)['-webkit-app-region'] : null })(),
      chatItems: document.querySelectorAll('.chat-item, .sb-item, .side-chat').length,
      modals: document.querySelectorAll('.modal, .set-dialog, .card').length,
      overlayText: (q('.patch-card, .whatsnew, .gate') || {}).textContent?.slice(0, 80) ?? null,
      classes: [...document.querySelectorAll('#root > *')].map(e => e.className).slice(0, 6),
      dpr: window.devicePixelRatio,
      vw: innerWidth, vh: innerHeight
    }
  })()`
  DATA.electron.dom = await el.cdp.eval(domProbe)
  DATA.tauri.dom = await ta.cdp.eval(domProbe)

  // ── window.api 표면 대조 (Tauri) ────────────────────────────────────────────
  const surfaceProbe = `(() => {
    const want = ${JSON.stringify(EXPECTED)}
    const missing = [], notFn = []
    for (const p of want) {
      let cur = window.api
      let ok = true
      const parts = p.split('.')
      for (let i = 0; i < parts.length; i++) {
        if (cur == null) { ok = false; break }
        cur = cur[parts[i]]
      }
      if (cur === undefined) missing.push(p)
      else if (typeof cur !== 'function') notFn.push(p + ':' + typeof cur)
    }
    const extra = []
    const walk = (obj, prefix) => {
      for (const k of Object.keys(obj ?? {})) {
        const v = obj[k]
        const dotted = prefix ? prefix + '.' + k : k
        if (typeof v === 'function') { if (!want.includes(dotted)) extra.push(dotted) }
        else if (v && typeof v === 'object') walk(v, dotted)
        else if (!want.includes(dotted)) extra.push(dotted + '=' + typeof v)
      }
    }
    walk(window.api, '')
    return { has: !!window.api, missing, notFn, extra, tauriInternals: !!window.__TAURI_INTERNALS__, chrome: window.__ccgChrome ?? null }
  })()`
  DATA.tauri.surface = await ta.cdp.eval(surfaceProbe)
  DATA.electron.surface = await el.cdp.eval(surfaceProbe)

  // ── 미구현 채널 실제 호출 (throw 하는지) ────────────────────────────────────
  const callProbe = `(async () => {
    const tries = [
      ['getUsage', () => window.api.getUsage()],
      ['sessionWindows.list', () => window.api.sessionWindows.list()],
      ['git.status', () => window.api.git.status('C:/Code/AgentCodeGUI')],
      ['lsp.status', () => window.api.lsp.status('C:/Code/AgentCodeGUI', 'package.json')],
      ['talk.getState', () => window.api.talk.getState()],
      ['multi.getState', () => window.api.multi.getState()],
      ['skill.list', () => window.api.skill.list('C:/Code/AgentCodeGUI')],
      ['mcp.list', () => window.api.mcp.list('C:/Code/AgentCodeGUI')],
      ['listDir', () => window.api.listDir('C:/Code/AgentCodeGUI', '')],
      ['listFiles', () => window.api.listFiles('C:/Code/AgentCodeGUI')],
      ['readFile', () => window.api.readFile('C:/Code/AgentCodeGUI', 'package.json')],
      ['app.getVersion', () => window.api.app.getVersion()],
      ['app.getUpdateStatus', () => window.api.app.getUpdateStatus()],
      ['engine.state', () => window.api.engine.state()],
      ['engine.listAvailable', () => window.api.engine.listAvailable()],
      ['codexEngine.state', () => window.api.codexEngine.state()],
      ['codexModels', () => window.api.codexModels()],
      ['auth.listAccounts', () => window.api.auth.listAccounts()],
      ['codexAuth.listAccounts', () => window.api.codexAuth.listAccounts()],
      ['apiConfig.get', () => window.api.apiConfig.get()],
      ['getUiPrefs', () => window.api.getUiPrefs()],
      ['getProfile', () => window.api.getProfile()],
      ['getChats', () => window.api.getChats()],
      ['dirExists', () => window.api.dirExists('C:/Code/AgentCodeGUI')],
      ['engineAutoUpdate', () => window.api.engineAutoUpdate()],
      ['engineUpdate.status', () => window.api.engineUpdate.status()],
      ['multi.panelStates', () => window.api.multi.panelStates('x')],
      ['session.hydrate', () => window.api.session.hydrate()],
      ['lsp.servers', () => window.api.lsp.servers()],
      ['lsp.cachedTokens', () => window.api.lsp.cachedTokens('C:/Code/AgentCodeGUI', 'package.json')],
      ['git.repos', () => window.api.git.repos('C:/Code/AgentCodeGUI')],
      ['openSessionWindow', () => window.api.openSessionWindow()],
      ['btwOpen', () => window.api.btwOpen({ chatId: 'x', prompt: 'hi' })],
      ['multi.openPanelWindow', () => window.api.multi.openPanelWindow({ panelId: 'p1' })],
      ['notify.event', () => window.api.notify.event({ kind: 'done' })],
      ['saveAttachmentData', () => window.api.saveAttachmentData(new ArrayBuffer(4), 'png')],
      ['pathForFile', () => window.api.pathForFile(new File([], 'x.txt'))]
    ]
    const out = []
    for (const [name, fn] of tries) {
      const t0 = performance.now()
      try {
        const v = await fn()
        out.push({ name, ok: true, ms: Math.round(performance.now() - t0), v: JSON.stringify(v)?.slice(0, 160) ?? String(v) })
      } catch (e) {
        out.push({ name, ok: false, ms: Math.round(performance.now() - t0), err: String(e?.message ?? e).slice(0, 160) })
      }
    }
    return out
  })()`
  DATA.tauri.calls = await ta.cdp.eval(callProbe, { awaitPromise: true })

  // ── win.* 왕복 ──────────────────────────────────────────────────────────────
  await ta.cdp.eval(
    `window.__winEvents = []; window.__unsubWin = window.api.onWinState((s) => window.__winEvents.push(s)); 'ok'`
  )
  const winBefore = winInfo(ta.child.pid)
  const tMax = await ta.cdp.eval(`window.api.win.toggleMaximize()`, { awaitPromise: true })
  await sleep(900)
  const winMaxed = winInfo(ta.child.pid)
  const isMax1 = await ta.cdp.eval(`window.api.win.isMaximized()`, { awaitPromise: true })
  const tUnmax = await ta.cdp.eval(`window.api.win.toggleMaximize()`, { awaitPromise: true })
  await sleep(900)
  const winRestored = winInfo(ta.child.pid)
  const isMax2 = await ta.cdp.eval(`window.api.win.isMaximized()`, { awaitPromise: true })
  await ta.cdp.eval(`window.api.win.minimize()`, { awaitPromise: true })
  await sleep(900)
  const winMin = winInfo(ta.child.pid)
  // 복원 (SW_RESTORE)
  ps(
    WIN32_PRELUDE +
      String.raw`
Add-Type @"
using System; using System.Runtime.InteropServices;
public class S { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c); }
"@
$h=[N]::MainOf(${ta.child.pid}); if($h -ne [IntPtr]::Zero){ [void][S]::ShowWindow($h,9) }
''
`
  )
  await sleep(900)
  const winEvents = await ta.cdp.eval(`window.__winEvents`)
  DATA.tauri.winRoundTrip = {
    before: { maximized: winBefore.maximized, rect: winBefore.rect, client: winBefore.client },
    toggleMaximizeReturned: tMax,
    afterMaximize: { osMaximized: winMaxed.maximized, rect: winMaxed.rect, client: winMaxed.client },
    isMaximizedAfterMax: isMax1,
    toggleBackReturned: tUnmax,
    afterRestore: { osMaximized: winRestored.maximized, rect: winRestored.rect },
    isMaximizedAfterRestore: isMax2,
    afterMinimize: { osMinimized: winMin.minimized },
    winStateEvents: winEvents
  }

  // ── UI 구동: 설정 열기/닫기, 새 채팅 ────────────────────────────────────────
  const HIT = `const hit = (el) => {
      if (!el) return false
      const r = el.getBoundingClientRect()
      const x = r.left + r.width / 2, y = r.top + r.height / 2
      for (const t of ['pointerdown','mousedown','pointerup','mouseup','click']) {
        el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }))
      }
      return true
    }
    const modalCount = () => document.querySelectorAll('.modal, .set-dialog, .settings, .set, .sheet, .overlay').length
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))`

  const openSettings = `(async () => {
    ${HIT}
    const steps = []
    const gear = document.querySelector('.sb-foot')
    steps.push({ step: 'find-settings', found: !!gear, cls: gear?.className ?? null, before: modalCount() })
    if (gear) { hit(gear); await sleep(1000) }
    steps.push({ step: 'after-settings', modals: modalCount(),
                 tabs: [...document.querySelectorAll('.set-tabs button, .set-nav button, nav button')].map(b => b.textContent?.trim()).slice(0, 12),
                 text: document.body.innerText.slice(0, 300).replace(/\\s+/g,' ') })
    return steps
  })()`
  DATA.tauri.uiDrive = await ta.cdp.eval(openSettings, { awaitPromise: true })
  await sleep(600)
  await shot(ta.cdp, path.join(SHOTS, 'm1-r1-ta-settings.png'))
  DATA.electron.uiDrive = await el.cdp.eval(openSettings, { awaitPromise: true })
  await sleep(600)
  await shot(el.cdp, path.join(SHOTS, 'm1-r1-el-settings.png'))

  // 설정 화면도 OS 캡처로 나란히
  placeWindow(el.child.pid, 20, 60, 1240, 830)
  await sleep(400)
  placeWindow(ta.child.pid, 1280, 60, 1240, 830)
  await sleep(900)
  grabScreen(path.join(SHOTS, 'm1-r1-sidebyside-settings.png'))

  // Esc로 닫기
  for (const app of [ta, el]) {
    await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  }
  await sleep(1200)
  const countExpr = `document.querySelectorAll('.modal, .set-dialog, .settings, .set, .sheet, .overlay').length`
  DATA.tauri.afterEsc = await ta.cdp.eval(countExpr)
  DATA.electron.afterEsc = await el.cdp.eval(countExpr)

  // ── 새 채팅 모달 열기/닫기 ──────────────────────────────────────────────────
  const openNewChat = `(async () => {
    ${HIT}
    const steps = []
    const btn = document.querySelector('.sb-new')
    steps.push({ step: 'find-new', found: !!btn, before: modalCount() })
    if (btn) { hit(btn); await sleep(900) }
    steps.push({ step: 'after-new', modals: modalCount(), text: document.body.innerText.slice(0, 220).replace(/\\s+/g,' ') })
    return steps
  })()`
  DATA.tauri.newChat = await ta.cdp.eval(openNewChat, { awaitPromise: true })
  DATA.electron.newChat = await el.cdp.eval(openNewChat, { awaitPromise: true })
  await sleep(500)
  await shot(ta.cdp, path.join(SHOTS, 'm1-r1-ta-newchat.png'))
  await shot(el.cdp, path.join(SHOTS, 'm1-r1-el-newchat.png'))
  for (const app of [ta, el]) {
    await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  }
  await sleep(900)
  DATA.tauri.afterEsc2 = await ta.cdp.eval(countExpr)
  DATA.electron.afterEsc2 = await el.cdp.eval(countExpr)

  await sleep(1500)
  DATA.tauri.console = ta.logs
  DATA.electron.console = el.logs
  DATA.tauri.consoleErrors = ta.logs.filter((l) => l.type === 'error').length
  DATA.electron.consoleErrors = el.logs.filter((l) => l.type === 'error').length
  DATA.tauri.unimplementedWarns = ta.logs.filter((l) => /unimplemented|미구현|__unimplemented/i.test(l.text)).length

  ta.cdp.close()
  el.cdp.close()
} finally {
  fs.writeFileSync(path.join(REPO, 'docs', 'critic', 'm1-r1-data.json'), JSON.stringify(DATA, null, 2))
  for (const pid of spawned) killTree(pid)
  console.log('spawned pids cleaned:', spawned.join(', '))
}
console.log('saved docs/critic/m1-r1-data.json')
