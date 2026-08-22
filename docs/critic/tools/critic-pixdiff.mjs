#!/usr/bin/env node
/* 두 캡처 폴더의 같은 이름 PNG를 임계값 기준으로 비교한다.
 * m1-r1-pixdiff.mjs의 LockBits 비교를 재사용하되 (a) 채널 임계값, (b) 좌측 칼럼 제외,
 * (c) 바뀐 픽셀의 바운딩 박스를 더한다 — "어디가 바뀌었나"를 수치로 말하기 위해서.
 *
 *   node docs/critic/tools/critic-pixdiff.mjs <dirA> <dirB> [--thr=24] [--xmin=250] [--out=file.json]
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { REPO } from '../../../bench/lib.mjs'

const [A, B] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const arg = (k, d) => { const v = process.argv.find((a) => a.startsWith(`--${k}=`)); return v ? v.split('=')[1] : d }
const THR = Number(arg('thr', '24'))
const XMIN = Number(arg('xmin', '0'))
const OUT = arg('out', path.join(REPO, 'docs', 'critic', 'm-ux-r1-pixdiff.json'))

const CS = String.raw`
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing @"
using System; using System.Drawing; using System.Drawing.Imaging; using System.Runtime.InteropServices;
public class PixDiff2 {
  public static string Run(string a, string b, int thr, int xmin){
    Bitmap A=(Bitmap)Bitmap.FromFile(a), B=(Bitmap)Bitmap.FromFile(b);
    int w=Math.Min(A.Width,B.Width), h=Math.Min(A.Height,B.Height);
    Rectangle rc=new Rectangle(0,0,w,h);
    var fmt=PixelFormat.Format32bppArgb;
    var la=A.LockBits(rc,ImageLockMode.ReadOnly,fmt); var lb=B.LockBits(rc,ImageLockMode.ReadOnly,fmt);
    int n=w*h*4; byte[] ba=new byte[n], bb=new byte[n];
    Marshal.Copy(la.Scan0,ba,0,n); Marshal.Copy(lb.Scan0,bb,0,n);
    A.UnlockBits(la); B.UnlockBits(lb); A.Dispose(); B.Dispose();
    long raw=0, over=0; int max=0; int x0=int.MaxValue,y0=int.MaxValue,x1=-1,y1=-1;
    long overL=0; int x0L=int.MaxValue,y0L=int.MaxValue,x1L=-1,y1L=-1;
    for(int y=0;y<h;y++) for(int x=0;x<w;x++){
      int i=(y*w+x)*4;
      int d0=Math.Abs(ba[i]-bb[i]), d1=Math.Abs(ba[i+1]-bb[i+1]), d2=Math.Abs(ba[i+2]-bb[i+2]);
      int m=Math.Max(d0,Math.Max(d1,d2));
      if(m>0) raw++;
      if(m>max) max=m;
      if(m>thr){
        if(x<xmin){ overL++; if(x<x0L)x0L=x; if(y<y0L)y0L=y; if(x>x1L)x1L=x; if(y>y1L)y1L=y; }
        else { over++; if(x<x0)x0=x; if(y<y0)y0=y; if(x>x1)x1=x; if(y>y1)y1=y; }
      }
    }
    string bbox = over>0 ? "{\"x0\":"+x0+",\"y0\":"+y0+",\"x1\":"+x1+",\"y1\":"+y1+"}" : "null";
    string bboxL = overL>0 ? "{\"x0\":"+x0L+",\"y0\":"+y0L+",\"x1\":"+x1L+",\"y1\":"+y1L+"}" : "null";
    return "{\"w\":"+w+",\"h\":"+h+",\"rawDiffPx\":"+raw+",\"overThr\":"+over+",\"overThrLeftCol\":"+overL+
           ",\"maxChannel\":"+max+",\"bbox\":"+bbox+",\"bboxLeftCol\":"+bboxL+"}";
  }
}
"@
`
const ps = (s) => execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', s], { encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024 })
const q = (p) => p.replace(/\\/g, '\\\\')

const names = fs.readdirSync(A).filter((f) => f.endsWith('.png') && fs.existsSync(path.join(B, f)))
const out = { at: new Date().toISOString(), a: A, b: B, thr: THR, leftColExcludedBelowX: XMIN, screens: {} }
for (const f of names) {
  const r = JSON.parse(ps(CS + `\n[PixDiff2]::Run('${q(path.join(A, f))}','${q(path.join(B, f))}',${THR},${XMIN})\n`).trim())
  out.screens[f.replace(/\.png$/, '')] = r
  const bb = r.bbox ? `x${r.bbox.x0}-${r.bbox.x1} y${r.bbox.y0}-${r.bbox.y1}` : '-'
  console.log(
    `${f.replace(/\.png$/, '').padEnd(28)} over=${String(r.overThr).padStart(7)}  leftcol=${String(r.overThrLeftCol).padStart(6)}  raw=${String(r.rawDiffPx).padStart(7)}  max=${String(r.maxChannel).padStart(3)}  ${bb}`
  )
}
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(out, null, 2))
console.log('\n리포트: ' + OUT)
