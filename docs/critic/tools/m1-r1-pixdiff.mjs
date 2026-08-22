// 크리틱 M1 R1 — 같은 화면의 픽셀 차이를 수치로. 두 앱을 같은 뷰포트(1224x800)로 강제한 뒤
// CDP 캡처를 LockBits로 빠르게 비교한다. 산출: 다른 픽셀 수 / 최대 채널 차 / 차분 이미지.
//
//   node docs/critic/tools/m1-r1-pixdiff.mjs
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { electronProfile, tauriProfile, connectMainPage, killTree, sleep, REPO } from '../../../bench/lib.mjs'

const SHOTS = path.join(REPO, 'docs', 'critic', 'shots')
const spawned = []
const OUT = { at: new Date().toISOString(), cases: {} }
const ps = (s) =>
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', s], { encoding: 'utf8', timeout: 120000 })

const DIFF_CS = String.raw`
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing @"
using System; using System.Drawing; using System.Drawing.Imaging; using System.Runtime.InteropServices;
public class PixDiff {
  public static string Run(string a, string b, string outFile){
    Bitmap A=(Bitmap)Bitmap.FromFile(a), B=(Bitmap)Bitmap.FromFile(b);
    int w=Math.Min(A.Width,B.Width), h=Math.Min(A.Height,B.Height);
    Rectangle rc=new Rectangle(0,0,w,h);
    var fmt=PixelFormat.Format32bppArgb;
    var la=A.LockBits(rc,ImageLockMode.ReadOnly,fmt); var lb=B.LockBits(rc,ImageLockMode.ReadOnly,fmt);
    int n=w*h*4; byte[] ba=new byte[n], bb=new byte[n];
    Marshal.Copy(la.Scan0,ba,0,n); Marshal.Copy(lb.Scan0,bb,0,n);
    A.UnlockBits(la); B.UnlockBits(lb);
    Bitmap D=new Bitmap(w,h); var ld=D.LockBits(rc,ImageLockMode.WriteOnly,fmt);
    byte[] bd=new byte[n]; long diff=0,sum=0; int max=0;
    for(int i=0;i<n;i+=4){
      int d0=Math.Abs(ba[i]-bb[i]), d1=Math.Abs(ba[i+1]-bb[i+1]), d2=Math.Abs(ba[i+2]-bb[i+2]);
      int m=Math.Max(d0,Math.Max(d1,d2));
      if(m>0){ diff++; sum+=m; if(m>max) max=m; }
      byte v=(byte)Math.Min(255,m*8);
      bd[i]=v; bd[i+1]=v; bd[i+2]=v; bd[i+3]=255;
    }
    Marshal.Copy(bd,0,ld.Scan0,n); D.UnlockBits(ld);
    D.Save(outFile, ImageFormat.Png);
    A.Dispose(); B.Dispose(); D.Dispose();
    double mean = diff>0 ? (double)sum/diff : 0;
    return "{\"w\":"+w+",\"h\":"+h+",\"total\":"+(w*h)+",\"diffPx\":"+diff+
           ",\"pct\":"+(Math.Round(100.0*diff/(w*h),3)).ToString(System.Globalization.CultureInfo.InvariantCulture)+
           ",\"maxChannel\":"+max+",\"meanDiffOfChanged\":"+(Math.Round(mean,2)).ToString(System.Globalization.CultureInfo.InvariantCulture)+"}";
  }
}
"@
`

function diffPng(a, b, outFile) {
  const out = ps(
    DIFF_CS +
      `\n[PixDiff]::Run('${a.replace(/\\/g, '\\\\')}','${b.replace(/\\/g, '\\\\')}','${outFile.replace(/\\/g, '\\\\')}')\n`
  )
  return JSON.parse(out.trim())
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
  // 같은 뷰포트로 강제 (창 크기·프레임 차이를 제거)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1224, height: 800, deviceScaleFactor: 1, mobile: false })
  await sleep(700)
  console.log(`[${label}] pid ${child.pid} ready`)
  return { child, cdp }
}
const shot = async (cdp, f) => {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(f, Buffer.from(r.data, 'base64'))
  return f
}

const prefsPath = path.join(REPO, '.bench-home-tauri', 'ui-prefs.json')
const prefsBackup = fs.readFileSync(prefsPath, 'utf8')

try {
  const ta = await boot(tauriProfile({ port: 9334 }), 'tauri')
  const el = await boot(electronProfile({ port: 9333 }), 'electron')
  await sleep(2500)
  // '업데이트 소식' 카드가 뜨면 닫는다 (버전 차이에서 오는 화면 차 — 별도로 보고)
  const dismiss = `(() => { const b=[...document.querySelectorAll('button')].find(x=>/시작하기|Get started/.test(x.textContent??'')); if(b){b.click(); return 'closed'} return 'absent' })()`
  OUT.whatsnew = { tauri: await ta.cdp.eval(dismiss), electron: await el.cdp.eval(dismiss) }
  await sleep(1200)

  const cases = [
    ['main', `'noop'`],
    ['settings', `(()=>{document.querySelector('.sb-foot')?.click(); return 'ok'})()`],
    ['account', `(()=>{[...document.querySelectorAll('button')].find(x=>/^Account$/.test((x.textContent??'').trim()))?.click(); return 'ok'})()`],
    ['engine', `(()=>{[...document.querySelectorAll('button')].find(x=>/^Engine$/.test((x.textContent??'').trim()))?.click(); return 'ok'})()`],
    ['display', `(()=>{[...document.querySelectorAll('button')].find(x=>/^Display$/.test((x.textContent??'').trim()))?.click(); return 'ok'})()`]
  ]
  for (const [name, act] of cases) {
    await ta.cdp.eval(act)
    await el.cdp.eval(act)
    await sleep(1400)
    const fa = await shot(ta.cdp, path.join(SHOTS, `m1-r1-px-ta-${name}.png`))
    const fb = await shot(el.cdp, path.join(SHOTS, `m1-r1-px-el-${name}.png`))
    OUT.cases[name] = diffPng(fa, fb, path.join(SHOTS, `m1-r1-px-diff-${name}.png`))
    console.log(name, JSON.stringify(OUT.cases[name]))
  }
} finally {
  for (const pid of spawned) killTree(pid)
  await sleep(600)
  fs.writeFileSync(prefsPath, prefsBackup)
  fs.writeFileSync(path.join(REPO, 'docs', 'critic', 'm1-r1-pixdiff.json'), JSON.stringify(OUT, null, 2))
  console.log('cleaned pids:', spawned.join(', '))
}
