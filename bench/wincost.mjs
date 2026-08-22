// 창 하나당 비용 — 2.6.2가 창마다 110.7MB를 붙이는 그 자리를 정면으로 잰다.
//
//   node bench/wincost.mjs tauri            ← 공유 WebView2 환경(제품 기본값)
//   node bench/wincost.mjs tauri --isolated ← 대조군: 창마다 다른 user data folder
//   node bench/wincost.mjs electron         ← 2.6.2 같은 조건(창 3개) 재측정
//
// 왜 multi.mjs와 따로 두나: multi.mjs는 창 2개를 한꺼번에 열고 총합만 남긴다. 여기서는
// **창을 하나씩** 열어 그때마다 프로세스 트리를 역할(--type=)까지 찍어, "창이 늘 때
// 무엇이 늘어나는가"를 프로세스 단위로 보이게 한다. 창이 실제로 떴는지도 CDP 타깃 수와
// Win32 가시 창 수 **양쪽으로** 확인한다 — openSessionWindow가 조용히 실패하면
// "창당 0MB"라는 가짜 승리가 나오기 때문이다(R1에서 실제로 no-op이었다).
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import {
  electronProfile, tauriProfile, connectMainPage, cdpTargets,
  procTreeMem, killTree, sleep, envInfo, REPO
} from './lib.mjs'
import { makeMultiFixture } from './fixture.mjs'

const kind = process.argv[2] ?? 'tauri'
const isolated = process.argv.includes('--isolated')
const WINDOWS = Number((process.argv.find((a) => a.startsWith('--windows=')) ?? '--windows=3').split('=')[1])
const HOME = path.join(REPO, '.bench-home-wincost' + (kind === 'tauri' ? '-tauri' : ''))
const OUT = path.join(REPO, 'bench', 'results', 'window-cost.json')

const profile = kind === 'tauri'
  ? tauriProfile({ port: 9351, extraEnv: isolated ? { CCG_WIN_ISOLATED_ENV: '1' } : {} })
  : electronProfile({ port: 9352 })
profile.env.CCG_HOME = HOME
const arm = kind === 'tauri' ? (isolated ? 'tauri-isolated-env' : 'tauri-shared-env') : 'electron-2.6.2'

fs.rmSync(HOME, { recursive: true, force: true })
makeMultiFixture(HOME, kind === 'tauri' ? '3.0.0-beta.1' : '2.6.2', { panels: 4 })

/** 프로세스에 속한 200x200 이상 가시 창의 수 — 창이 진짜로 떴는지 OS에 직접 묻는다. */
function visibleWindows(rootPid) {
  const ps = String.raw`
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Collections.Generic;
public class WC {
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static int CountFor(uint target){
    int n=0;
    EnumWindows((h,l)=>{
      if(!IsWindowVisible(h)) return true;
      uint p; GetWindowThreadProcessId(h,out p);
      if(p!=target) return true;
      RECT r; GetWindowRect(h, out r);
      if((r.Right-r.Left) >= 200 && (r.Bottom-r.Top) >= 200) n++;
      return true;
    }, IntPtr.Zero);
    return n;
  }
}
"@
[WC]::CountFor(${rootPid})
`
  try {
    return Number(execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 20000 }).trim())
  } catch { return -1 }
}

const child = spawn(profile.cmd, profile.args, {
  env: { ...process.env, ...profile.env }, cwd: profile.cwd, stdio: 'ignore'
})
const cdp = await connectMainPage(profile.port, { timeoutMs: 45000 })
for (;;) {
  if (await cdp.eval(profile.mountExpr).catch(() => false)) break
  await sleep(100)
}
const gridPanels = await cdp.eval(`document.querySelectorAll('.ma-p-thread').length`)
console.log('arm:', arm, '· panels:', gridPanels)

const roleSum = (procs) => {
  const by = {}
  for (const p of procs ?? []) {
    const k = `${p.role ?? '?'}${p.sub ? ':' + p.sub : ''}`
    by[k] ??= { n: 0, wsMB: 0, privMB: 0 }
    by[k].n++
    by[k].wsMB = Math.round((by[k].wsMB + p.wsMB) * 10) / 10
    by[k].privMB = Math.round((by[k].privMB + p.privMB) * 10) / 10
  }
  return by
}

const steps = []
async function snap(label) {
  await sleep(12000)
  const m = procTreeMem(child.pid, { role: true })
  const t = await cdpTargets(profile.port).then((x) => x.filter((y) => y.type === 'page').length).catch(() => -1)
  const row = {
    label,
    wsMB: m.totalWsMB, privMB: m.totalPrivMB, procs: m.procs?.length ?? 0,
    cdpPages: t, osWindows: visibleWindows(child.pid),
    byRole: roleSum(m.procs)
  }
  steps.push(row)
  console.log(JSON.stringify({ ...row, byRole: undefined }))
  return row
}

const base = await snap('grid-only')
for (let i = 1; i <= WINDOWS; i++) {
  await cdp.eval(`window.api.openSessionWindow()`).catch((e) => console.log('open failed:', String(e)))
  await sleep(3500)
  await snap(`+${i} session window`)
}
const last = steps.at(-1)
const perWindow = {
  wsMBPerWindow: Math.round(((last.wsMB - base.wsMB) / WINDOWS) * 10) / 10,
  privMBPerWindow: Math.round(((last.privMB - base.privMB) / WINDOWS) * 10) / 10,
  procsPerWindow: Math.round(((last.procs - base.procs) / WINDOWS) * 10) / 10,
  osWindowsAdded: last.osWindows - base.osWindows,
  cdpPagesAdded: last.cdpPages - base.cdpPages
}
console.log('per-window:', JSON.stringify(perWindow))
if (perWindow.osWindowsAdded < WINDOWS) {
  console.error(`!! 창이 ${perWindow.osWindowsAdded}/${WINDOWS}개만 떴다 — 비용 수치를 믿지 말 것`)
}

const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {}
const arms = { ...(prev.arms ?? {}) }
arms[arm] = { windows: WINDOWS, gridPanels, steps, perWindow, at: new Date().toISOString() }
fs.writeFileSync(OUT, JSON.stringify({
  what: '창 하나 추가 비용 — 창을 하나씩 열며 프로세스 트리를 역할별로 합산 (CDP on, 양 팔 동일 조건)',
  env: prev.env ?? envInfo(),
  arms
}, null, 2))
console.log('saved:', OUT)
cdp.close()
await sleep(600)
killTree(child.pid)
