// 크리틱 M1 R1 — 아크릴 실증. 두 앱 창 뒤에 **밝은 마젠타 판**을 깔고 같은 자리를 찍어
// 배경이 비치는(블러 틴트) 정도를 픽셀로 비교한다. 더불어 DWMWA_SYSTEMBACKDROP_TYPE(38)을
// 두 창에서 직접 읽는다 (Electron backgroundMaterial:'acrylic' ↔ window-vibrancy Acrylic).
//
//   node docs/critic/tools/m1-r1-acrylic.mjs
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { electronProfile, tauriProfile, connectMainPage, killTree, sleep, REPO } from '../../../bench/lib.mjs'

const SHOTS = path.join(REPO, 'docs', 'critic', 'shots')
const spawned = []
const OUT = { at: new Date().toISOString() }
const ps = (s) =>
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', s], { encoding: 'utf8', timeout: 90000 })

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
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
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

function dwmBackdrop(pid) {
  const out = ps(
    PRELUDE +
      String.raw`
$h=[N]::MainOf(${pid})
if($h -eq [IntPtr]::Zero){ '{"found":false}'; exit }
$v=0; $hr=[N]::DwmGetWindowAttribute($h,38,[ref]$v,4)
$c=0; $hr2=[N]::DwmGetWindowAttribute($h,35,[ref]$c,4)   # DWMWA_CAPTION_COLOR
$m=0; $hr3=[N]::DwmGetWindowAttribute($h,1023,[ref]$m,4) # 존재하지 않는 attr (대조군)
@{ found=$true; backdrop=$v; hr=$hr; captionColor=$c; hrCaption=$hr2; hrBogus=$hr3 } | ConvertTo-Json -Compress
`
  )
  return JSON.parse(out.trim())
}

function place(pid, x, y, w, h, z = -1) {
  ps(PRELUDE + String.raw`
$h=[N]::MainOf(${pid}); if($h -ne [IntPtr]::Zero){ [void][N]::SetWindowPos($h,[IntPtr](${z}),${x},${y},${w},${h},0x0040) }
''`)
}

function grabRegion(file, x, y, w, h) {
  ps(String.raw`
Add-Type -AssemblyName System.Drawing
$bmp=New-Object System.Drawing.Bitmap ${w},${h}
$g=[System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(${x},${y},0,0,$bmp.Size)
$bmp.Save('${file.replace(/\\/g, '\\\\')}',[System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
''`)
}

/** 캡처 PNG의 한 사각형 평균 RGB */
function avgRgb(file, x, y, w, h) {
  const out = ps(String.raw`
Add-Type -AssemblyName System.Drawing
$bmp=[System.Drawing.Bitmap]::FromFile('${file.replace(/\\/g, '\\\\')}')
$r=0;$g=0;$b=0;$n=0
for($i=${x}; $i -lt ${x + w}; $i+=2){ for($j=${y}; $j -lt ${y + h}; $j+=2){
  $p=$bmp.GetPixel($i,$j); $r+=$p.R; $g+=$p.G; $b+=$p.B; $n++ } }
$bmp.Dispose()
@{ r=[math]::Round($r/$n,1); g=[math]::Round($g/$n,1); b=[math]::Round($b/$n,1); n=$n } | ConvertTo-Json -Compress
`)
  return JSON.parse(out.trim())
}

async function boot(profile, label) {
  const child = spawn(profile.cmd, profile.args, { env: { ...process.env, ...profile.env }, cwd: profile.cwd, stdio: 'ignore' })
  spawned.push(child.pid)
  const cdp = await connectMainPage(profile.port, { timeoutMs: 60000 })
  for (;;) {
    const ok = await cdp.eval(profile.mountExpr).catch(() => false)
    if (ok) break
    await sleep(60)
  }
  console.log(`[${label}] pid ${child.pid} mounted`)
  return { child, cdp }
}

// 배경판 — 화면 전체를 덮는 밝은 마젠타 폼 (앱 창보다 아래 z에 둔다)
const backdropPs = String.raw`
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$f = New-Object System.Windows.Forms.Form
$f.FormBorderStyle='None'; $f.BackColor=[System.Drawing.Color]::FromArgb(255,0,220)
$f.StartPosition='Manual'; $f.Location=New-Object System.Drawing.Point(0,0)
$f.Size=New-Object System.Drawing.Size(2560,1392); $f.TopMost=$false
$f.Show(); $f.Refresh()
Start-Sleep -Seconds 40
$f.Close()
`

try {
  const ta = await boot(tauriProfile({ port: 9334 }), 'tauri')
  const el = await boot(electronProfile({ port: 9333 }), 'electron')
  await sleep(2000)

  OUT.dwm = { tauri: dwmBackdrop(ta.child.pid), electron: dwmBackdrop(el.child.pid) }
  console.log('DWM backdrop:', JSON.stringify(OUT.dwm))

  // 1) 어두운 바탕(기존 데스크톱) 기준 캡처
  place(el.child.pid, 20, 60, 1240, 830)
  await sleep(300)
  place(ta.child.pid, 1280, 60, 1240, 830)
  await sleep(1200)
  const darkEl = path.join(SHOTS, 'm1-r1-acrylic-el-dark.png')
  const darkTa = path.join(SHOTS, 'm1-r1-acrylic-ta-dark.png')
  grabRegion(darkEl, 20, 60, 1240, 830)
  grabRegion(darkTa, 1280, 60, 1240, 830)

  // 2) 밝은 마젠타 판을 창 뒤에 깔고 같은 자리 캡처
  const bg = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', backdropPs], { stdio: 'ignore' })
  spawned.push(bg.pid)
  await sleep(4000)
  place(el.child.pid, 20, 60, 1240, 830)
  await sleep(300)
  place(ta.child.pid, 1280, 60, 1240, 830)
  await sleep(1500)
  const brightEl = path.join(SHOTS, 'm1-r1-acrylic-el-bright.png')
  const brightTa = path.join(SHOTS, 'm1-r1-acrylic-ta-bright.png')
  grabRegion(brightEl, 20, 60, 1240, 830)
  grabRegion(brightTa, 1280, 60, 1240, 830)
  grabRegion(path.join(SHOTS, 'm1-r1-acrylic-sbs.png'), 0, 40, 2560, 880)

  // 사이드바 빈 영역(스레드 목록 아래 = 단색 배경)의 평균 RGB로 비침을 잰다
  const box = { x: 30, y: 400, w: 150, h: 200 }
  OUT.pixel = {
    electronDark: avgRgb(darkEl, box.x, box.y, box.w, box.h),
    electronBright: avgRgb(brightEl, box.x, box.y, box.w, box.h),
    tauriDark: avgRgb(darkTa, box.x, box.y, box.w, box.h),
    tauriBright: avgRgb(brightTa, box.x, box.y, box.w, box.h)
  }
  const dr = (a, b) => ({ dr: +(b.r - a.r).toFixed(1), dg: +(b.g - a.g).toFixed(1), db: +(b.b - a.b).toFixed(1) })
  OUT.bleed = {
    electron: dr(OUT.pixel.electronDark, OUT.pixel.electronBright),
    tauri: dr(OUT.pixel.tauriDark, OUT.pixel.tauriBright)
  }
  console.log('bleed:', JSON.stringify(OUT.bleed))
  place(el.child.pid, 20, 60, 1240, 830, -2)
  place(ta.child.pid, 1280, 60, 1240, 830, -2)
} finally {
  for (const pid of spawned) killTree(pid)
  fs.writeFileSync(path.join(REPO, 'docs', 'critic', 'm1-r1-acrylic.json'), JSON.stringify(OUT, null, 2))
  console.log('cleaned pids:', spawned.join(', '))
}
console.log(JSON.stringify(OUT, null, 2))
