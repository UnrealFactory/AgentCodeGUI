# M-UI R1 크리틱 — 유리 판정을 **두 축**으로 잰다.
#
# 왜 새 도구인가: repro.ps1의 swing(저주파 추적성)은 "벽지를 따라가나"만 재고
# **블러 여부를 못 가른다**. 3.0의 핵심 주장("재질이 죽으면 벽지가 '블러 없이' 생으로
# 비쳐 글자를 못 읽는다")은 고주파(디테일) 축이라 swing으로는 확인도 반박도 안 된다.
# 그래서 여기서는
#   swing  = 배경을 마젠타/시안/흰색으로 갈아 끼울 때 사이드바 색의 최대 진폭 (추적성)
#   detail = 격자무늬(4px 체커) 배경 위에서 사이드바의 **인접 픽셀 차 평균** (선명도)
# 두 값을 같이 잰다. 아크릴이면 추적은 하되 detail이 낮고(블러), 백드롭이 죽으면
# 추적하면서 detail도 높다(생비침). 불투명 폴백이면 둘 다 0.
#
# 배경판은 **대상 창을 덮을 만큼만** 만들고 z-order로 창 바로 아래에 끼운다
# (repro.ps1처럼 전체 화면을 덮지 않고, 창을 옮기지도 않는다 — 포커스 훔치기 없음).
# -HoldNone 을 주면 별도 프로세스가 백드롭을 25ms마다 NONE으로 찍어 눌러
# **방어가 이기지 못하게** 한 상태를 잰다(그 상태가 사용자 증상의 픽셀이다).
param(
  [Parameter(Mandatory = $true)][int]$TargetPid,
  [Parameter(Mandatory = $true)][string]$Tag,
  [switch]$HoldNone,
  [int]$Seconds = 8,
  [string]$OutDir = "docs/critic/shots",
  [string]$Json = "docs/critic/mui-r1-px.json",
  [int]$SidebarX = 46
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type -ReferencedAssemblies System.Drawing, System.Windows.Forms @"
using System; using System.Drawing; using System.Drawing.Imaging;
using System.Runtime.InteropServices; using System.Text;
public class P {
  public delegate bool EW(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EW cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int ht, uint flags);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
  [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr h, int a, ref int v, int s);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  public static IntPtr MainWindowOf(uint target) {
    IntPtr best = IntPtr.Zero; long bestArea = -1;
    EnumWindows((h,l)=>{ if(!IsWindowVisible(h)) return true; uint p; GetWindowThreadProcessId(h, out p);
      if(p != target) return true; RECT r; GetWindowRect(h, out r);
      long a = (long)(r.R-r.L)*(r.B-r.T); if(a > bestArea){ bestArea = a; best = h; } return true; }, IntPtr.Zero);
    return best; }
  // 화면 사각형 하나를 캡처해 통계를 낸다.
  //  [0..2] meanR/G/B  [3] 휘도 stdev  [4] 가로 인접차 평균(detail)  [5] 세로 인접차 평균  [6] 최대 채도
  public static double[] Stats(int x, int y, int w, int h, string savePath) {
    Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
    using (Graphics g = Graphics.FromImage(bmp)) { g.CopyFromScreen(x, y, 0, 0, new Size(w, h)); }
    if (savePath != null && savePath.Length > 0) bmp.Save(savePath, ImageFormat.Png);
    BitmapData bd = bmp.LockBits(new Rectangle(0,0,w,h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    int stride = bd.Stride; byte[] buf = new byte[stride * h];
    Marshal.Copy(bd.Scan0, buf, 0, buf.Length); bmp.UnlockBits(bd); bmp.Dispose();
    double sr=0, sg=0, sb=0; int n = w*h;
    double[] lum = new double[n]; double maxChroma = 0;
    for (int yy=0; yy<h; yy++) for (int xx=0; xx<w; xx++) {
      int i = yy*stride + xx*4; byte B=buf[i], G=buf[i+1], R=buf[i+2];
      sr+=R; sg+=G; sb+=B; lum[yy*w+xx] = (R+G+B)/3.0;
      int mx = Math.Max(R, Math.Max(G,B)), mn = Math.Min(R, Math.Min(G,B));
      if (mx-mn > maxChroma) maxChroma = mx-mn;
    }
    double mr=sr/n, mg=sg/n, mb=sb/n, ml=(mr+mg+mb)/3.0, ss=0;
    for (int i=0;i<n;i++){ double d=lum[i]-ml; ss+=d*d; }
    double sd = Math.Sqrt(ss/n);
    double dh=0; int ch=0;
    for (int yy=0; yy<h; yy++) for (int xx=1; xx<w; xx++){ dh += Math.Abs(lum[yy*w+xx]-lum[yy*w+xx-1]); ch++; }
    double dv=0; int cv=0;
    for (int yy=1; yy<h; yy++) for (int xx=0; xx<w; xx++){ dv += Math.Abs(lum[yy*w+xx]-lum[(yy-1)*w+xx]); cv++; }
    return new double[]{ mr, mg, mb, sd, dh/Math.Max(1,ch), dv/Math.Max(1,cv), maxChroma };
  }
}
"@ | Out-Null

$SBT = 38
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path

$hwnd = [P]::MainWindowOf([uint32]$TargetPid)
if ($hwnd -eq [IntPtr]::Zero) { throw "PID $TargetPid : no window" }
$r = New-Object P+RECT; [P]::GetWindowRect($hwnd, [ref]$r) | Out-Null
$orig = 0; [P]::DwmGetWindowAttribute($hwnd, $SBT, [ref]$orig, 4) | Out-Null
Write-Host ("target hwnd={0} rect={1},{2} {3}x{4} backdrop={5}" -f [int64]$hwnd, $r.L, $r.T, ($r.R-$r.L), ($r.B-$r.T), $orig)

# 배경판: 창을 덮을 만큼만, z-order로 창 바로 아래
$pad = 30
$bx = $r.L - $pad; $by = $r.T - $pad; $bw = ($r.R - $r.L) + $pad*2; $bh = ($r.B - $r.T) + $pad*2
$script:mode = 'magenta'
$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'; $form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point($bx, $by)
$form.Size = New-Object System.Drawing.Size($bw, $bh)
$form.ShowInTaskbar = $false
$form.Add_Paint({
  param($s, $e)
  $w = $s.ClientSize.Width; $h = $s.ClientSize.Height
  if ($script:mode -eq 'magenta') {
    $br = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,255,0,170))
    $e.Graphics.FillRectangle($br,0,0,$w,$h); $br.Dispose()
  } elseif ($script:mode -eq 'cyan') {
    $br = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,0,210,255))
    $e.Graphics.FillRectangle($br,0,0,$w,$h); $br.Dispose()
  } elseif ($script:mode -eq 'white') {
    $br = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,250,250,250))
    $e.Graphics.FillRectangle($br,0,0,$w,$h); $br.Dispose()
  } else {
    # 4px 체커 — 고주파 성분. 아크릴(블러)이면 뭉개지고, 생비침이면 격자가 그대로 온다.
    $b1 = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,250,250,250))
    $b0 = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,10,10,10))
    $e.Graphics.FillRectangle($b0,0,0,$w,$h)
    for ($yy=0; $yy -lt $h; $yy+=8) {
      for ($xx=0; $xx -lt $w; $xx+=8) {
        $e.Graphics.FillRectangle($b1, $xx, $yy, 4, 4)
        $e.Graphics.FillRectangle($b1, $xx+4, $yy+4, 4, 4)
      }
    }
    $b1.Dispose(); $b0.Dispose()
  }
})
$form.Show()
$SWP_NOMOVE=0x2; $SWP_NOSIZE=0x1; $SWP_NOACTIVATE=0x10
[P]::SetWindowPos($form.Handle, $hwnd, 0,0,0,0, ($SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_NOACTIVATE)) | Out-Null

function Pump([int]$ms) { $end=(Get-Date).AddMilliseconds($ms); while((Get-Date) -lt $end){ [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 15 } }

# 방어를 못 이기게 누르는 해머(별도 프로세스)
$hammer = $null
if ($HoldNone) {
  $code = @'
param([long]$h, [int]$secs)
Add-Type @"
using System; using System.Runtime.InteropServices;
public class H { [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr h, int a, ref int v, int s); }
"@
$end = (Get-Date).AddSeconds($secs)
$v = 1
while ((Get-Date) -lt $end) { [H]::DwmSetWindowAttribute([IntPtr]$h, 38, [ref]$v, 4) | Out-Null; Start-Sleep -Milliseconds 25 }
'@
  $tmp = Join-Path $env:TEMP "mui-hammer.ps1"
  [System.IO.File]::WriteAllText($tmp, $code, (New-Object System.Text.UTF8Encoding $true))
  $hammer = Start-Process powershell -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$tmp,'-h',[string][int64]$hwnd,'-secs',[string]$Seconds) -PassThru -WindowStyle Hidden
  Start-Sleep -Milliseconds 500
}

$sx = $r.L + $SidebarX; $sy = $r.T + [int](($r.B-$r.T) * 0.42)
$patchW = 120; $patchH = 150
$rows = @()
try {
  foreach ($m in @('magenta','cyan','white','check')) {
    $script:mode = $m
    $form.Invalidate(); $form.Update(); Pump 700
    $bdNow = -1; [P]::DwmGetWindowAttribute($hwnd, $SBT, [ref]$bdNow, 4) | Out-Null
    $png = Join-Path $OutDir ("{0}-{1}.png" -f $Tag, $m)
    $st = [P]::Stats($sx, $sy, $patchW, $patchH, $png)
    $rows += [pscustomobject]@{
      bg = $m; backdropAtSample = $bdNow
      mean = ("{0:N1},{1:N1},{2:N1}" -f $st[0], $st[1], $st[2])
      r = [Math]::Round($st[0],1); g = [Math]::Round($st[1],1); b = [Math]::Round($st[2],1)
      stdev = [Math]::Round($st[3],2); detailH = [Math]::Round($st[4],3); detailV = [Math]::Round($st[5],3)
      chroma = [int]$st[6]
    }
    "{0,-8} bd={1} mean={2,-18} stdev={3,6} detailH={4,7} detailV={5,7}" -f $m, $bdNow, $rows[-1].mean, $rows[-1].stdev, $rows[-1].detailH, $rows[-1].detailV | Write-Host
  }
} finally {
  if ($hammer) { try { Stop-Process -Id $hammer.Id -Force -ErrorAction SilentlyContinue } catch {} }
  try { $form.Close() } catch {}
  $v = [int]$orig; [P]::DwmSetWindowAttribute($hwnd, $SBT, [ref]$v, 4) | Out-Null
}
$solid = $rows | Where-Object { $_.bg -ne 'check' }
$swing = 0
foreach ($c in @('r','g','b')) {
  $vals = $solid | ForEach-Object { $_.$c }
  $sw = ($vals | Measure-Object -Maximum).Maximum - ($vals | Measure-Object -Minimum).Minimum
  if ($sw -gt $swing) { $swing = $sw }
}
$chk = $rows | Where-Object { $_.bg -eq 'check' }
$out = [ordered]@{
  ts = (Get-Date).ToString('o'); tag = $Tag; targetPid = $TargetPid; hwnd = [int64]$hwnd
  heldNone = [bool]$HoldNone; patch = @($sx,$sy,$patchW,$patchH)
  swing = [Math]::Round($swing,1)
  checkDetailH = $chk.detailH; checkDetailV = $chk.detailV; checkStdev = $chk.stdev
  rows = $rows
}
# JSONL 한 줄 추가. (배열을 다시 읽어 += 하면 ConvertFrom-Json이 배열을 PSObject로
# 감싸 회차가 중첩되며 앞 기록이 사라진다 — 이 크리틱에서 실제로 밟았다.)
# [M-UI R2 빌더의 수리 — 판정 로직은 한 글자도 안 건드렸다]
# 커밋된 상태의 이 꼬리 여섯 줄은 붙여넣기 사고로 깨져 있어 **파서가 파일을 아예 못 읽는다**
# (`TerminatorExpectedAtEndOfString` — Add-Content의 -replace 인자 안에 마지막 두 줄이
# 통째로 삼켜져 있었다). 크리틱의 수치는 그 사고 이전 판으로 잰 것이고(도구 02:05 <
# 결과 파일 02:02), 원래 의도는 주석이 말하는 "JSONL 한 줄 추가"다. 그대로 복원한다.
($out | ConvertTo-Json -Depth 6 -Compress) | Add-Content -Path ($Json -replace '\.json$', '.jsonl') -Encoding UTF8
""
"=== {0} : swing={1}  checkDetailH={2}  checkStdev={3} ===" -f $Tag, $out.swing, $out.checkDetailH, $out.checkStdev | Write-Host
