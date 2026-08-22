// 크리틱 M1 R1 — 시각 파리티 전용 재현. 1차 실행에서 Tauri 쪽만 '업데이트 소식' 카드가
// 떠(앱 버전 3.0.0-beta.1 ≠ ui-prefs의 whatsnew.seenVersion 2.6.2) 나란히 비교가 막혔다.
// 여기서는 카드를 닫고 같은 화면끼리 찍는다. 두 창을 TOPMOST로 올려 다른 창에 가리지 않게.
//
//   node docs/critic/tools/m1-r1-visual.mjs
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { electronProfile, tauriProfile, connectMainPage, killTree, sleep, REPO } from '../../../bench/lib.mjs'

const SHOTS = path.join(REPO, 'docs', 'critic', 'shots')
fs.mkdirSync(SHOTS, { recursive: true })
const spawned = []
const OUT = { at: new Date().toISOString() }

const ps = (s) =>
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', s], {
    encoding: 'utf8',
    timeout: 60000
  })

const PRELUDE = String.raw`
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class N {
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
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

// HWND_TOPMOST = -1, HWND_NOTOPMOST = -2
function place(pid, x, y, w, h, topmost = true) {
  ps(
    PRELUDE +
      String.raw`
$h=[N]::MainOf(${pid})
if($h -ne [IntPtr]::Zero){ [void][N]::SetWindowPos($h,[IntPtr](${topmost ? -1 : -2}),${x},${y},${w},${h},0x0040) }
''
`
  )
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

async function boot(profile, label) {
  const child = spawn(profile.cmd, profile.args, { env: { ...process.env, ...profile.env }, cwd: profile.cwd, stdio: 'ignore' })
  spawned.push(child.pid)
  const cdp = await connectMainPage(profile.port, { timeoutMs: 60000 })
  await cdp.send('Page.enable')
  for (;;) {
    const ok = await cdp.eval(profile.mountExpr).catch(() => false)
    if (ok) break
    await sleep(60)
  }
  console.log(`[${label}] pid ${child.pid} mounted`)
  return { child, cdp }
}

const shot = async (cdp, f) => {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(f, Buffer.from(r.data, 'base64'))
}

const prefsPath = path.join(REPO, '.bench-home-tauri', 'ui-prefs.json')
const prefsBackup = fs.readFileSync(prefsPath, 'utf8')

try {
  const ta = await boot(tauriProfile({ port: 9334 }), 'tauri')
  const el = await boot(electronProfile({ port: 9333 }), 'electron')
  await sleep(2500)

  // '업데이트 소식' 카드 닫기 (Tauri에만 뜬다)
  const dismiss = `(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /시작하기|Get started/.test(b.textContent ?? ''))
    if (btn) { btn.click(); return 'clicked' }
    return 'none'
  })()`
  OUT.dismissTauri = await ta.cdp.eval(dismiss)
  OUT.dismissElectron = await el.cdp.eval(dismiss)
  await sleep(1200)

  const probe = `({ nodes: document.querySelectorAll('*').length, text: document.body.innerText.replace(/\\s+/g,' ').slice(0,400) })`
  OUT.tauriDom = await ta.cdp.eval(probe)
  OUT.electronDom = await el.cdp.eval(probe)

  await shot(ta.cdp, path.join(SHOTS, 'm1-r1-ta-main-clean.png'))
  await shot(el.cdp, path.join(SHOTS, 'm1-r1-el-main-clean.png'))

  // 나란히 OS 캡처 (TOPMOST — 다른 창에 가리지 않게)
  place(el.child.pid, 20, 60, 1240, 830)
  await sleep(300)
  place(ta.child.pid, 1280, 60, 1240, 830)
  await sleep(1500)
  grabRegion(path.join(SHOTS, 'm1-r1-sbs-main.png'), 0, 40, 2560, 880)
  grabRegion(path.join(SHOTS, 'm1-r1-el-os.png'), 20, 60, 1240, 830)
  grabRegion(path.join(SHOTS, 'm1-r1-ta-os.png'), 1280, 60, 1240, 830)
  // 타이틀바 확대 (아크릴·창 컨트롤 비교)
  grabRegion(path.join(SHOTS, 'm1-r1-el-titlebar.png'), 20, 60, 1240, 70)
  grabRegion(path.join(SHOTS, 'm1-r1-ta-titlebar.png'), 1280, 60, 1240, 70)

  // 설정 화면 나란히
  const openSet = `(() => { const b = document.querySelector('.sb-foot'); if (!b) return 'no-button'; b.click(); return 'ok' })()`
  await ta.cdp.eval(openSet)
  await el.cdp.eval(openSet)
  await sleep(1400)
  await shot(ta.cdp, path.join(SHOTS, 'm1-r1-ta-settings-clean.png'))
  await shot(el.cdp, path.join(SHOTS, 'm1-r1-el-settings-clean.png'))
  grabRegion(path.join(SHOTS, 'm1-r1-sbs-settings.png'), 0, 40, 2560, 880)

  // Account 탭 (실계정 목록 — 백엔드 파리티가 눈에 보이는 화면)
  const acct = `(() => { const b = [...document.querySelectorAll('button')].find(x => /^Account$/.test((x.textContent??'').trim())); if(!b) return 'no'; b.click(); return 'ok' })()`
  OUT.acctTauri = await ta.cdp.eval(acct)
  OUT.acctElectron = await el.cdp.eval(acct)
  await sleep(1600)
  await shot(ta.cdp, path.join(SHOTS, 'm1-r1-ta-account.png'))
  await shot(el.cdp, path.join(SHOTS, 'm1-r1-el-account.png'))
  grabRegion(path.join(SHOTS, 'm1-r1-sbs-account.png'), 0, 40, 2560, 880)

  place(el.child.pid, 20, 60, 1240, 830, false)
  place(ta.child.pid, 1280, 60, 1240, 830, false)
} finally {
  for (const pid of spawned) killTree(pid)
  await sleep(600)
  fs.writeFileSync(prefsPath, prefsBackup) // whatsnew.seenVersion 원복
  fs.writeFileSync(path.join(REPO, 'docs', 'critic', 'm1-r1-visual.json'), JSON.stringify(OUT, null, 2))
  console.log('cleaned pids:', spawned.join(', '))
}
console.log(JSON.stringify(OUT, null, 2))
