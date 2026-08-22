// 공통 측정 라이브러리 — Electron(2.6.2)과 Tauri(3.0.0)를 같은 방법으로 잰다.
// 공정성 = 대칭성: 두 앱 모두 (1) 프로세스 스폰 → 첫 가시 창(Win32 EnumWindows),
// (2) 스폰 → 렌더러 #root 마운트(CDP), (3) 프로세스 트리 메모리 합산(CIM 워크)로 측정.
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const REPO = path.resolve(import.meta.dirname, '..')
export const BENCH_HOME = path.join(REPO, '.bench-home')

// ── CDP 미니 클라이언트 (의존성 없음 — Node 22+ 전역 WebSocket) ──────────────
export async function cdpTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(900) })
  return await res.json()
}

export class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.listeners = []
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg)
      }
    })
  }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', () => rej(new Error('ws connect failed')), { once: true })
    })
    return new Cdp(ws)
  }
  send(method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }
  async eval(expr, { awaitPromise = false } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise
    })
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description ?? 'error'))
    return r.result?.value
  }
  close() {
    try { this.ws.close() } catch { /* closed */ }
  }
}

/** 메인 페이지 타깃(#root를 갖는 index.html — toast/tray/splash 제외)을 찾아 연결. */
export async function connectMainPage(port, { timeoutMs = 30000 } = {}) {
  const t0 = Date.now()
  for (;;) {
    if (Date.now() - t0 > timeoutMs) throw new Error('main page target not found')
    try {
      const targets = await cdpTargets(port)
      const page = targets.find(
        (t) =>
          t.type === 'page' &&
          /index\.html|localhost/.test(t.url) &&
          !/toast|tray|data:/.test(t.url)
      )
      if (page?.webSocketDebuggerUrl) return await Cdp.connect(page.webSocketDebuggerUrl)
    } catch { /* not listening yet */ }
    await sleep(30)
  }
}

// ── 첫 가시 창 감시자 (PowerShell, 스폰 전에 대기 시작 → 폴 지연 최소화) ──────
const WATCHER_PS = String.raw`
param($pidFile,$outFile)
Add-Type @"
using System; using System.Runtime.InteropServices;
public class W {
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  // 200x200 미만은 앱 창이 아니다. tao(Tauri)는 프로세스 시작과 함께 16x16짜리
  // "Tao Thread Event Target" 보조 창을 **가시 상태로** 만든다 — 크기 조건이 없으면
  // 이 창이 잡혀 Tauri의 '첫 가시 창'이 5ms로 찍힌다(실측). Electron의 첫 창은
  // 1320x880이라 이 조건에 영향받지 않는다(기준값 336ms는 rootMs보다 앞선 진짜 창).
  public static bool VisibleFor(uint target){
    bool found=false;
    EnumWindows((h,l)=>{
      if(!IsWindowVisible(h)) return true;
      uint p; GetWindowThreadProcessId(h,out p);
      if(p!=target) return true;
      RECT r; GetWindowRect(h, out r);
      if((r.Right-r.Left) >= 200 && (r.Bottom-r.Top) >= 200){ found=true; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
while(!(Test-Path $pidFile)){ Start-Sleep -Milliseconds 4 }
$target=[uint32](Get-Content $pidFile -Raw).Trim()
$sw=[System.Diagnostics.Stopwatch]::StartNew()
while($sw.Elapsed.TotalSeconds -lt 60){
  if([W]::VisibleFor($target)){
    "$([math]::Round($sw.Elapsed.TotalMilliseconds))" | Out-File $outFile -Encoding ascii
    exit 0
  }
  Start-Sleep -Milliseconds 8
}
"timeout" | Out-File $outFile -Encoding ascii
`

/**
 * 앱을 스폰하고 (첫 가시 창 ms, #root 마운트 ms)를 잰다.
 * cmd/args/env만 다르고 측정 경로는 두 앱이 완전히 같다.
 */
export async function measureColdStart({ cmd, args, env, cwd, port, mountExpr }) {
  const tag = Math.random().toString(36).slice(2, 8)
  const pidFile = path.join(os.tmpdir(), `ccg-bench-pid-${tag}`)
  const outFile = path.join(os.tmpdir(), `ccg-bench-win-${tag}`)
  const psFile = path.join(os.tmpdir(), `ccg-bench-watch-${tag}.ps1`)
  fs.writeFileSync(psFile, WATCHER_PS)
  const watcher = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile, pidFile, outFile], {
    stdio: 'ignore'
  })
  // 감시자의 Add-Type 컴파일이 끝나 pidFile 폴링에 들어갈 시간을 준다
  await sleep(2500)

  const t0 = performance.now()
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, cwd, stdio: 'ignore', detached: false })
  fs.writeFileSync(pidFile, String(child.pid))

  // #root 마운트 (앱이 "쓸 수 있는 상태") — CDP 폴링
  let rootMs = null
  try {
    const cdp = await connectMainPage(port, { timeoutMs: 45000 })
    for (;;) {
      const ok = await cdp.eval(mountExpr).catch(() => false)
      if (ok) { rootMs = Math.round(performance.now() - t0) ; break }
      if (performance.now() - t0 > 45000) break
      await sleep(25)
    }
    cdp.close()
  } catch { /* CDP 실패 — rootMs null 기록 */ }

  // 첫 가시 창
  let winMs = null
  for (let i = 0; i < 200; i++) {
    if (fs.existsSync(outFile)) {
      const v = fs.readFileSync(outFile, 'utf8').trim()
      winMs = v === 'timeout' ? null : Number(v)
      break
    }
    await sleep(50)
  }

  killTree(child.pid)
  try { watcher.kill() } catch { /* gone */ }
  for (const f of [pidFile, outFile, psFile]) { try { fs.unlinkSync(f) } catch { /* gone */ } }
  return { winMs, rootMs }
}

// ── 프로세스 트리 메모리 (CIM 워크 — WorkingSet + PrivatePageCount 합산) ─────
//
// role: Chromium/Electron의 `--type=` 스위치를 CommandLine에서 뽑아 프로세스의 역할
// (browser/renderer/gpu-process/utility/crashpad)을 붙인다. "웹 런타임이 어디에 쓰는가"를
// 이름(msedgewebview2.exe가 6개)만으로는 절대 알 수 없어서 R2에 추가했다.
// CommandLine은 Win32_Process에 이미 있는 필드라 추가 비용이 거의 없다.
export function procTreeMem(rootPid, { role = false } = {}) {
  const sel = role
    ? 'ProcessId,ParentProcessId,WorkingSetSize,PrivatePageCount,Name,CreationDate,CommandLine'
    : 'ProcessId,ParentProcessId,WorkingSetSize,PrivatePageCount,Name,CreationDate'
  const roleExpr = role
    ? String.raw`; role = $(if ($_.CommandLine -match '--type=([a-zA-Z-]+)') { $Matches[1] } elseif ($_.CommandLine -match '--utility-sub-type=') { 'utility' } else { 'browser' }); sub = $(if ($_.CommandLine -match '--utility-sub-type=([^\s"]+)') { $Matches[1] } else { '' })`
    : ''
  const ps = String.raw`
$all = Get-CimInstance Win32_Process | Select-Object ${sel}
$root = $all | Where-Object { $_.ProcessId -eq ${rootPid} }
if (-not $root) { '{"error":"root gone"}'; exit }
$kids = @{}
foreach ($p in $all) {
  if (-not $kids.ContainsKey([uint32]$p.ParentProcessId)) { $kids[[uint32]$p.ParentProcessId] = @() }
  $kids[[uint32]$p.ParentProcessId] += $p
}
$tree = @(); $q = New-Object System.Collections.Queue; $q.Enqueue($root)
while ($q.Count -gt 0) {
  $cur = $q.Dequeue(); $tree += $cur
  if ($kids.ContainsKey([uint32]$cur.ProcessId)) {
    foreach ($c in $kids[[uint32]$cur.ProcessId]) {
      if ($c.CreationDate -ge $root.CreationDate.AddSeconds(-2)) { $q.Enqueue($c) }
    }
  }
}
$rows = $tree | ForEach-Object { @{ pid=[uint32]$_.ProcessId; name=$_.Name; wsMB=[math]::Round($_.WorkingSetSize/1MB,1); privMB=[math]::Round($_.PrivatePageCount/1MB,1)${roleExpr} } }
@{ procs=@($rows); totalWsMB=[math]::Round(($tree | Measure-Object WorkingSetSize -Sum).Sum/1MB,1); totalPrivMB=[math]::Round(($tree | Measure-Object PrivatePageCount -Sum).Sum/1MB,1) } | ConvertTo-Json -Depth 4 -Compress
`
  const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 30000 })
  return JSON.parse(out)
}

export function killTree(pid) {
  try { execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', timeout: 15000 }) } catch { /* gone */ }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function median(nums) {
  const a = nums.filter((n) => n != null).sort((x, y) => x - y)
  if (!a.length) return null
  return a.length % 2 ? a[(a.length - 1) / 2] : Math.round((a[a.length / 2 - 1] + a[a.length / 2]) / 2)
}

export function envInfo() {
  const ps = `@{cpu=(Get-CimInstance Win32_Processor).Name; ramGB=[math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1GB,1); os=(Get-CimInstance Win32_OperatingSystem).Caption + ' ' + (Get-CimInstance Win32_OperatingSystem).BuildNumber} | ConvertTo-Json -Compress`
  try {
    return JSON.parse(execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 20000 }))
  } catch {
    return {}
  }
}

// ── 앱별 실행 프로파일 ────────────────────────────────────────────────────────
// Electron 2.6.2: 프로덕션 번들(out/, minify)을 electron 바이너리로 직접 실행.
// 패키징본과의 차이는 asar 묶음 여부뿐 — 코드·런타임 동일. CCG_HOME으로 홈 격리
// (설치본과 단일 인스턴스 락 충돌 방지 — isPackaged=false라 오버라이드가 산다).
export function electronProfile({ port = 9333, cdp = true } = {}) {
  return {
    name: 'electron-2.6.2',
    cmd: path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: cdp ? ['.', `--remote-debugging-port=${port}`] : ['.'],
    env: { CCG_HOME: BENCH_HOME, NODE_ENV: 'production' },
    cwd: REPO,
    port,
    mountExpr: `!!document.getElementById('root') && document.getElementById('root').children.length > 0`
  }
}

// Tauri 3.0.0: 릴리즈 빌드 exe. 산출 경로는 **워크스페이스 루트**의 target/ —
// src-tauri는 루트 Cargo.toml의 멤버라(crates/*와 같은 워크스페이스) cargo가 target
// 디렉터리를 루트에 하나로 둔다.
//
// CDP 포트를 **WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS로 주지 않는다**(R1과 달라진 점).
// 그 환경변수와 우리가 코드에서 넣는 AdditionalBrowserArguments 중 어느 쪽이 이기는지가
// 문서상 모호해서, 환경변수를 쓰면 제품이 박아둔 메모리 레버가 조용히 날아간 채로
// 측정될 수 있다. 대신 CCG_CDP_PORT를 셸의 조립기(src-tauri/src/webview_args.rs)에
// 넘겨 **레버 + 포트**가 한 문자열로 가게 한다.
export function tauriProfile({ port = 9334, exe, extraEnv = {}, cdp = true } = {}) {
  return {
    name: 'tauri-3.0.0',
    cmd: exe ?? path.join(REPO, 'target', 'release', 'agentcodegui.exe'),
    args: [],
    env: {
      CCG_HOME: BENCH_HOME + '-tauri',
      ...(cdp ? { CCG_CDP_PORT: String(port) } : {}),
      ...extraEnv
    },
    cwd: REPO,
    port,
    mountExpr: `!!document.getElementById('root') && document.getElementById('root').children.length > 0`
  }
}

// ── CDP 없이 유휴 메모리 재기 ────────────────────────────────────────────────
// 제품 실사용은 --remote-debugging-port가 **꺼진** 쪽이다. CDP를 켜면 Chromium이
// DevTools 프로토콜 호스트를 세우고(WebView2에서 Private +50MB대 관측) 프로세스 구성이
// 달라질 수 있다. 그래서 "첫 가시 창(Win32) → 고정 정착" 만으로 재는 모드를 둔다.
// 마운트 시점을 알 수 없으니 정착 시간은 창이 뜬 뒤부터 센다(양쪽 같은 규칙).
export async function waitFirstWindow(pid, { timeoutMs = 60000 } = {}) {
  const tag = Math.random().toString(36).slice(2, 8)
  const pidFile = path.join(os.tmpdir(), `ccg-bench-pid-${tag}`)
  const outFile = path.join(os.tmpdir(), `ccg-bench-win-${tag}`)
  const psFile = path.join(os.tmpdir(), `ccg-bench-watch-${tag}.ps1`)
  fs.writeFileSync(psFile, WATCHER_PS)
  fs.writeFileSync(pidFile, String(pid))
  const watcher = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile, pidFile, outFile], {
    stdio: 'ignore'
  })
  const t0 = Date.now()
  let ok = false
  while (Date.now() - t0 < timeoutMs) {
    if (fs.existsSync(outFile)) {
      ok = fs.readFileSync(outFile, 'utf8').trim() !== 'timeout'
      break
    }
    await sleep(50)
  }
  try { watcher.kill() } catch { /* gone */ }
  for (const f of [pidFile, outFile, psFile]) { try { fs.unlinkSync(f) } catch { /* gone */ } }
  return ok
}

/**
 * 유휴 메모리 1회 측정. cdp:true면 #root 마운트를, false면 첫 가시 창을 기점으로
 * settleSec 만큼 방치한 뒤 프로세스 트리를 합산한다.
 */
export async function measureIdle(profile, { settleSec = 60, cdp = true } = {}) {
  const child = spawn(profile.cmd, profile.args, {
    env: { ...process.env, ...profile.env }, cwd: profile.cwd, stdio: 'ignore'
  })
  try {
    if (cdp) {
      const c = await connectMainPage(profile.port, { timeoutMs: 45000 })
      for (;;) {
        if (await c.eval(profile.mountExpr).catch(() => false)) break
        await sleep(100)
      }
      c.close()
    } else {
      await waitFirstWindow(child.pid)
    }
    await sleep(settleSec * 1000)
    return procTreeMem(child.pid)
  } finally {
    killTree(child.pid)
    await sleep(1200)
  }
}
