// 공통 측정 라이브러리 — Electron(2.6.2)과 Tauri(3.0.0)를 같은 방법으로 잰다.
// 공정성 = 대칭성: 두 앱 모두 (1) 프로세스 스폰 → 첫 가시 창(Win32 EnumWindows),
// (2) 스폰 → 렌더러 #root 마운트(CDP), (3) 프로세스 트리 메모리 합산(CIM 워크)로 측정.
import { spawn, execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
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

// **모든 요청에 타임아웃이 있다.** 없으면 렌더러가 죽은 뒤 `Runtime.evaluate`가 영원히
// 응답하지 않아 하네스가 통째로 멈춘다(크래시 복구 하네스를 쓰다가 실제로 밟았다 —
// 크리틱의 §9-7 `Page.crash` 정지와 같은 계열의 결함이고, 그쪽은 한 호출만 감싸는
// 국소 처방이었다). ws가 닫히면 대기 중인 요청도 전부 거부한다.
const CDP_TIMEOUT_MS = 20000

export class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.listeners = []
    this.dead = false
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id)
        clearTimeout(timer)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg)
      }
    })
    const die = (why) => {
      this.dead = true
      for (const [id, { reject, timer }] of this.pending) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error('cdp: ' + why))
      }
    }
    ws.addEventListener('close', () => die('ws closed'), { once: true })
    ws.addEventListener('error', () => die('ws error'), { once: true })
  }
  static async connect(wsUrl, { timeoutMs = 8000 } = {}) {
    const ws = new WebSocket(wsUrl)
    await new Promise((res, rej) => {
      const t = setTimeout(() => { try { ws.close() } catch { /* noop */ } rej(new Error('ws connect timeout')) }, timeoutMs)
      ws.addEventListener('open', () => { clearTimeout(t); res() }, { once: true })
      ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('ws connect failed')) }, { once: true })
    })
    return new Cdp(ws)
  }
  send(method, params = {}, { timeoutMs = CDP_TIMEOUT_MS } = {}) {
    if (this.dead) return Promise.reject(new Error('cdp: closed'))
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`cdp timeout: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try { this.ws.send(JSON.stringify({ id, method, params })) } catch (e) {
        clearTimeout(timer); this.pending.delete(id); reject(e)
      }
    })
  }
  async eval(expr, { awaitPromise = false, timeoutMs } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise
    }, { timeoutMs: timeoutMs ?? CDP_TIMEOUT_MS })
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description ?? 'error'))
    return r.result?.value
  }
  close() {
    this.dead = true
    try { this.ws.close() } catch { /* closed */ }
  }
}

/** 메인 페이지 타깃(#root를 갖는 index.html — toast/tray/splash 제외)을 찾아 연결. */
export async function connectMainPage(port, { timeoutMs = 30000, connectTimeoutMs = 8000 } = {}) {
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
      if (page?.webSocketDebuggerUrl) return await Cdp.connect(page.webSocketDebuggerUrl, { timeoutMs: connectTimeoutMs })
    } catch { /* not listening yet */ }
    await sleep(30)
  }
}

// ── 첫 가시 창 감시자 (PowerShell, 스폰 전에 대기 시작 → 폴 지연 최소화) ──────
//
// R3 크리틱 §9-5 결함: 감시자는 "200×200 넘는 첫 가시 창"만 보고 **그 창이 무엇인지**
// 남기지 않았다. 두 앱의 첫 창은 서로 다른 사건이다 —
//   Electron 2.6.2: 300×240 스플래시 BrowserWindow, `ready-to-show`(=이미 그려진 뒤) 표시
//   Tauri 3.0    : 풀사이즈 메인 창, "렌더 차단 CSS 준비"(=아직 한 프레임도 안 올라감) 표시
// 필터를 통과하는 건 같지만 재고 있는 사건이 다르다. 그래서 이제 **잡은 창의 크기·제목을
// 결과에 남긴다**(winW/winH/winTitle) — winMs를 인용할 때 무엇을 쟀는지 파일만 보고 알게.
// 대표 비교 지표는 paintMs다(§4.3, 두 앱 모두 '메인 페이지 첫 픽셀'로 대칭).
const WATCHER_PS = String.raw`
param($pidFile,$outFile)
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class W {
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static int W_, H_; public static string T_ = "";
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
      if((r.Right-r.Left) >= 200 && (r.Bottom-r.Top) >= 200){
        W_ = r.Right-r.Left; H_ = r.Bottom-r.Top;
        StringBuilder sb = new StringBuilder(256); GetWindowTextW(h, sb, 256); T_ = sb.ToString();
        found=true; return false;
      }
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
    "$([math]::Round($sw.Elapsed.TotalMilliseconds))|$([W]::W_)|$([W]::H_)|$([W]::T_)" | Out-File $outFile -Encoding utf8
    exit 0
  }
  Start-Sleep -Milliseconds 8
}
"timeout" | Out-File $outFile -Encoding utf8
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
  // paintMs = **웹 콘텐츠의 첫 픽셀**. winMs(=OS 창이 보이기 시작)만 보면 "창은 떴는데
  // DWM 아크릴만 있고 안은 비어 있는" 구간을 놓친다. 두 앱의 창 표시 규약이 다르므로
  // (Electron 2.6.2는 별도 스플래시 창, 3.0은 창 안 오버레이) 이 숫자가 있어야 같은
  // 잣대로 비교된다. 페이지의 first-paint 엔트리 + timeOrigin을 스폰 시각에 맞춰 환산한다.
  let rootMs = null
  let paintMs = null
  try {
    const cdp = await connectMainPage(port, { timeoutMs: 45000 })
    for (;;) {
      const ok = await cdp.eval(mountExpr).catch(() => false)
      if (ok) { rootMs = Math.round(performance.now() - t0) ; break }
      if (performance.now() - t0 > 45000) break
      await sleep(25)
    }
    const spawnEpoch = Date.now() - Math.round(performance.now() - t0)
    for (let i = 0; i < 60; i++) {
      const p = await cdp.eval(
        `(() => { const e = performance.getEntriesByType('paint')[0]
          return e ? Math.round(performance.timeOrigin + e.startTime) : null })()`
      ).catch(() => null)
      if (p) { paintMs = p - spawnEpoch; break }
      await sleep(25)
    }
    cdp.close()
  } catch { /* CDP 실패 — rootMs null 기록 */ }

  // 첫 가시 창 — "ms|w|h|title" (감시자가 잡은 창의 정체를 같이 남긴다, §9-5)
  let winMs = null
  let winW = null
  let winH = null
  let winTitle = null
  for (let i = 0; i < 200; i++) {
    if (fs.existsSync(outFile)) {
      const v = fs.readFileSync(outFile, 'utf8').replace(/^﻿/, '').trim()
      if (v !== 'timeout') {
        const [ms, w, h, ...t] = v.split('|')
        winMs = Number(ms)
        winW = w != null ? Number(w) : null
        winH = h != null ? Number(h) : null
        winTitle = t.length ? t.join('|') : null
      }
      break
    }
    await sleep(50)
  }

  killTree(child.pid)
  try { watcher.kill() } catch { /* gone */ }
  for (const f of [pidFile, outFile, psFile]) { try { fs.unlinkSync(f) } catch { /* gone */ } }
  return { winMs, rootMs, paintMs, winW, winH, winTitle }
}

// ── 어느 바이너리로 쟀는가 (§9-6) ────────────────────────────────────────────
// 커밋된 스윕 표의 Z행이 `procs 7`이었던 사고 = 채택 레버가 붙기 전 exe로 잰 값인데
// 파일 어디에도 그게 안 남아 있었다. 이제 모든 결과 파일이 exe의 mtime·크기·SHA256 앞
// 16자와 git HEAD를 박는다. 표를 인용하기 전에 이 세 줄만 보면 된다.
export function binInfo(exePath) {
  const info = { exe: exePath ?? null }
  try {
    const st = fs.statSync(exePath)
    info.exeMtime = new Date(st.mtimeMs).toISOString()
    info.exeSize = st.size
  } catch { info.exeMissing = true }
  try {
    const buf = fs.readFileSync(exePath)
    info.exeSha256 = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)
  } catch { /* 없거나 잠김 */ }
  try {
    info.gitHead = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim()
    info.gitDirty = execFileSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' }).trim().length > 0
  } catch { /* git 없음 */ }
  return info
}

/** 팔 이름 — env 조합을 결과 파일 키로 쓸 수 있는 짧은 슬러그로 (§9-1, §9-2). */
export function armName(env = process.env) {
  const parts = []
  if (env.CCG_SINGLE_PROCESS && env.CCG_SINGLE_PROCESS !== '0') parts.push('singleproc')
  if (env.CCG_GPU_PROCESS && env.CCG_GPU_PROCESS !== '0') parts.push('gpuproc')
  if (env.CCG_WEBVIEW_ARGS_BASE_ONLY) parts.push('baseonly')
  if (env.CCG_WEBVIEW_ENABLE_FEATURES) parts.push('on-' + env.CCG_WEBVIEW_ENABLE_FEATURES.replace(/[^A-Za-z0-9]+/g, ''))
  if (env.CCG_WEBVIEW_DISABLE_FEATURES) parts.push('off-' + env.CCG_WEBVIEW_DISABLE_FEATURES.replace(/[^A-Za-z0-9]+/g, ''))
  if (env.CCG_WEBVIEW_ARGS_EXTRA) parts.push('extra-' + env.CCG_WEBVIEW_ARGS_EXTRA.replace(/[^A-Za-z0-9]+/g, '').slice(0, 24))
  if (env.CCG_WEBVIEW_ARGS) parts.push('argsreplaced')
  if (env.CCG_CHROME) parts.push('chrome' + env.CCG_CHROME)
  // ★ 통합 스토어 A/B — 이게 없으면 켬/끔 두 팔이 **같은 결과 파일**에 쓴다(두 번째가
  //   첫 팔을 지운다). R3 크리틱 §9-2가 닫았던 결함이 새 플래그로 되살아난 자리다
  //   (크리틱 배선 R1 §4.4). 판정은 `ccg_store::unified_store_enabled()`와 같은 규약 —
  //   **"0/false만 끔"**이라 오타(`=yes`)는 켬으로 읽히고 팔 이름도 그렇게 나온다.
  if (env.CCG_UNIFIED_STORE === '0' || env.CCG_UNIFIED_STORE === 'false') parts.push('legacystore')
  return parts.length ? parts.join('+') : 'default'
}

/** 결과 파일에 항상 같이 박는 출처 블록. */
export function provenance(profile) {
  return {
    arm: armName({ ...process.env, ...(profile?.env ?? {}) }),
    bin: binInfo(profile?.cmd),
    armEnv: Object.fromEntries(
      Object.entries({ ...process.env, ...(profile?.env ?? {}) }).filter(([k]) => k.startsWith('CCG_'))
    )
  }
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

// 짝수 길이에서 **정수로 반올림하지 않는다**(R4 크리틱 §3.3). `Math.round`를 쓰면 참
// 중앙값 58.5가 `59`로 찍혀 절대 게이트(`medianAvgFps >= 59.0`)를 반올림으로 통과한다.
// 12시행·6쌍처럼 이 프로젝트의 대표 표본은 대부분 짝수라 상시로 걸리던 자리다.
// 소수 2자리로만 다듬는다(부동소수 꼬리 제거 — 55.35000000000001 같은 값이 파일에 박히지 않게).
export function median(nums) {
  const a = nums.filter((n) => n != null).sort((x, y) => x - y)
  if (!a.length) return null
  const m = a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2
  return Math.round(m * 100) / 100
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
export async function measureIdle(profile, { settleSec = 60, cdp = true, role = false } = {}) {
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
    return procTreeMem(child.pid, { role })
  } finally {
    killTree(child.pid)
    await sleep(1200)
  }
}
