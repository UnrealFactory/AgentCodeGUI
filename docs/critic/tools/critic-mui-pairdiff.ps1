# M-UI R1 크리틱 — 블라인드 A/B 쌍(같은 폴더, <name>-A.png / <name>-B.png)을 한 세션에서 전부 비교한다.
# critic-pixdiff.mjs는 파일마다 powershell을 새로 띄워 Add-Type을 다시 컴파일한다(54쌍이면 분 단위).
# 여기선 타입을 한 번만 세우고 쌍을 순회한다. 출력은 JSON 한 덩어리.
param([string]$Dir, [int]$Thr = 1, [string]$Out)

Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing @"
using System; using System.Drawing; using System.Drawing.Imaging; using System.Runtime.InteropServices;
public class PairDiff {
  public static string Run(string a, string b, int thr){
    Bitmap A=(Bitmap)Bitmap.FromFile(a), B=(Bitmap)Bitmap.FromFile(b);
    int aw=A.Width, ah=A.Height, bw=B.Width, bh=B.Height;
    int w=Math.Min(aw,bw), h=Math.Min(ah,bh);
    Rectangle rc=new Rectangle(0,0,w,h);
    var fmt=PixelFormat.Format32bppArgb;
    var la=A.LockBits(rc,ImageLockMode.ReadOnly,fmt); var lb=B.LockBits(rc,ImageLockMode.ReadOnly,fmt);
    int n=w*h*4; byte[] ba=new byte[n], bb=new byte[n];
    Marshal.Copy(la.Scan0,ba,0,n); Marshal.Copy(lb.Scan0,bb,0,n);
    A.UnlockBits(la); B.UnlockBits(lb); A.Dispose(); B.Dispose();
    long raw=0, over=0; int max=0; int x0=int.MaxValue,y0=int.MaxValue,x1=-1,y1=-1;
    for(int y=0;y<h;y++) for(int x=0;x<w;x++){
      int i=(y*w+x)*4;
      int d0=Math.Abs(ba[i]-bb[i]), d1=Math.Abs(ba[i+1]-bb[i+1]), d2=Math.Abs(ba[i+2]-bb[i+2]);
      int m=Math.Max(d0,Math.Max(d1,d2));
      if(m>0) raw++;
      if(m>max) max=m;
      if(m>thr){ over++; if(x<x0)x0=x; if(y<y0)y0=y; if(x>x1)x1=x; if(y>y1)y1=y; }
    }
    string bbox = over>0 ? "{\"x0\":"+x0+",\"y0\":"+y0+",\"x1\":"+x1+",\"y1\":"+y1+"}" : "null";
    return "{\"aw\":"+aw+",\"ah\":"+ah+",\"bw\":"+bw+",\"bh\":"+bh+",\"w\":"+w+",\"h\":"+h+
           ",\"rawDiffPx\":"+raw+",\"overThr\":"+over+",\"maxChannel\":"+max+",\"pct\":"+
           (Math.Round(100.0*over/(w*h),4)).ToString(System.Globalization.CultureInfo.InvariantCulture)+",\"bbox\":"+bbox+"}";
  }
}
"@

$pairs = Get-ChildItem -Path $Dir -Filter '*-A.png' | Sort-Object Name
$res = @{}
foreach ($p in $pairs) {
  $name = $p.Name -replace '-A\.png$',''
  $bp = Join-Path $Dir ($name + '-B.png')
  if (!(Test-Path $bp)) { continue }
  $j = [PairDiff]::Run($p.FullName, $bp, $Thr)
  $res[$name] = ($j | ConvertFrom-Json)
  $o = $res[$name]
  $bb = if ($o.bbox) { "x$($o.bbox.x0)-$($o.bbox.x1) y$($o.bbox.y0)-$($o.bbox.y1)" } else { '-' }
  "{0,-30} over={1,8} pct={2,7} raw={3,8} max={4,3} {5}" -f $name, $o.overThr, $o.pct, $o.rawDiffPx, $o.maxChannel, $bb
}
$payload = [ordered]@{ at = (Get-Date).ToString('o'); dir = $Dir; thr = $Thr; pairs = $res }
if ($Out) { $payload | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 $Out; "`nreport: $Out" }
