# 유리 소실 재현 — "증상 = 아크릴 소실"을 픽셀로 확정하는 실험.
#
# 판정 방법(벽지 색에 의존하지 않는다): 창 뒤에 **원색 3띠 판**을 깔고 창을 세 띠 위로
# 옮기며 사이드바 픽셀을 잰다.
#   아크릴 살아 있음 → 사이드바 색이 **띠를 따라 움직인다**(벽지가 비친다).
#   아크릴 죽음      → 사이드바가 **어디서나 같은 값**이다(단색 판이 드러난다).
# "회색이 몇이냐"를 맞히는 게 아니라 **추적성(tracking)** 을 재는 것이라, 폴백 색이
# 무엇이든 · 벽지가 어둡든 밝든 갈린다.
#
# 왜 per-window 레버인가: OS 전역 투명 효과 토글은 **사용자 데스크톱을 건드리는 짓**이라
# 금지다. 대신 DwmSetWindowAttribute(hwnd, DWMWA_SYSTEMBACKDROP_TYPE, v)로 **이 창 하나만**
# 갈아 끼운다. 끝나면 원래 값으로 되돌린다.
#
#   powershell -File repro.ps1 -TargetPid 1234 -Prefix repro-electron -OutDir ..\..\docs\design\glass-shots
param(
  [Parameter(Mandatory = $true)][int]$TargetPid,
  [Parameter(Mandatory = $true)][string]$Prefix,
  [string]$OutDir = "..\..\docs\design\glass-shots",
  [int[]]$Backdrops = @(3, 1, 0, 2),
  [int]$SidebarX = 46
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class R {
  public delegate bool EW(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EW cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int ht, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int m);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
  [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr h, int a, ref int v, int s);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  public static IntPtr MainWindowOf(uint target) {
    IntPtr best = IntPtr.Zero; long bestArea = -1;
    EnumWindows((h,l)=>{
      if(!IsWindowVisible(h)) return true;
      uint p; GetWindowThreadProcessId(h, out p);
      if(p != target) return true;
      RECT r; GetWindowRect(h, out r);
      long a = (long)(r.R-r.L)*(r.B-r.T);
      if(a > bestArea){ bestArea = a; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
  public static void Fg(IntPtr h){
    keybd_event(0x12,0,0,UIntPtr.Zero); keybd_event(0x12,0,2,UIntPtr.Zero);  // ALT = 포그라운드 제한 해제
    SetForegroundWindow(h);
  }
}
"@

$SBT = 38
$HWND_TOPMOST = [IntPtr](-1); $HWND_NOTOPMOST = [IntPtr](-2)
$SWP_NOSIZE = 0x1; $SWP_NOMOVE = 0x2; $SWP_NOACTIVATE = 0x10
$NAME = @{ 0 = 'AUTO'; 1 = 'NONE'; 2 = 'MICA'; 3 = 'ACRYLIC'; 4 = 'TABBED' }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path

$hwnd = [R]::MainWindowOf([uint32]$TargetPid)
if ($hwnd -eq [IntPtr]::Zero) { throw "PID $TargetPid 창 없음" }
$sb = New-Object System.Text.StringBuilder 300
[R]::GetWindowTextW($hwnd, $sb, 300) | Out-Null
$orig = 0; [R]::DwmGetWindowAttribute($hwnd, $SBT, [ref]$orig, 4) | Out-Null
Write-Host ("target hwnd={0} title='{1}' 원래 backdrop={2}({3})" -f $hwnd, $sb.ToString(), $orig, $NAME[$orig])

function Pump([int]$ms) {
  $end = (Get-Date).AddMilliseconds($ms)
  while ((Get-Date) -lt $end) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 15 }
}

# ── 원색 3띠 배경판(전체 화면) ───────────────────────────────────────────────
$scr = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$back = New-Object System.Windows.Forms.Form
$back.FormBorderStyle = 'None'; $back.StartPosition = 'Manual'
$back.Location = New-Object System.Drawing.Point($scr.X, $scr.Y)
$back.Size = New-Object System.Drawing.Size($scr.Width, $scr.Height)
$back.ShowInTaskbar = $false
$bands = @(
  @{ n = 'magenta'; c = [System.Drawing.Color]::FromArgb(255, 255, 0, 170) },
  @{ n = 'cyan'; c = [System.Drawing.Color]::FromArgb(255, 0, 210, 255) },
  @{ n = 'white'; c = [System.Drawing.Color]::FromArgb(255, 250, 250, 250) }
)
$back.Add_Paint({
  param($s, $e)
  $w = $s.ClientSize.Width; $h = $s.ClientSize.Height
  for ($i = 0; $i -lt 3; $i++) {
    $br = New-Object System.Drawing.SolidBrush $bands[$i].c
    $e.Graphics.FillRectangle($br, [int]($w * $i / 3), 0, [int]($w / 3) + 1, $h)
    $br.Dispose()
  }
})
$back.Show(); Pump 500

function SampleSidebar([IntPtr]$h) {
  $r = New-Object R+RECT; [R]::GetWindowRect($h, [ref]$r) | Out-Null
  $ht = $r.B - $r.T
  $x = $r.L + $SidebarX
  $ys = @([int]($r.T + $ht * 0.45), [int]($r.T + $ht * 0.60), [int]($r.T + $ht * 0.75))
  $bmp = New-Object System.Drawing.Bitmap 9, 9
  $acc = @(0, 0, 0); $n = 0
  foreach ($y in $ys) {
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen(($x - 4), ($y - 4), 0, 0, (New-Object System.Drawing.Size(9, 9)))
    $g.Dispose()
    for ($dx = 0; $dx -lt 9; $dx++) { for ($dy = 0; $dy -lt 9; $dy++) {
      $c = $bmp.GetPixel($dx, $dy); $acc[0] += $c.R; $acc[1] += $c.G; $acc[2] += $c.B; $n++
    } }
  }
  $bmp.Dispose()
  return @([Math]::Round($acc[0] / $n, 1), [Math]::Round($acc[1] / $n, 1), [Math]::Round($acc[2] / $n, 1))
}

function Shot([IntPtr]$h, [string]$file) {
  $r = New-Object R+RECT; [R]::GetWindowRect($h, [ref]$r) | Out-Null
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $cx = [Math]::Max($r.L, $vs.Left); $cy = [Math]::Max($r.T, $vs.Top)
  $cw = [Math]::Min($r.R, $vs.Right) - $cx; $ch = [Math]::Min($r.B, $vs.Bottom) - $cy
  if ($cw -le 0 -or $ch -le 0) { return }
  $bmp = New-Object System.Drawing.Bitmap $cw, $ch
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($cx, $cy, 0, 0, (New-Object System.Drawing.Size($cw, $ch)))
  $g.Dispose(); $bmp.Save((Join-Path $OutDir $file), [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
}

$rows = @()
try {
  $r0 = New-Object R+RECT; [R]::GetWindowRect($hwnd, [ref]$r0) | Out-Null
  $w = $r0.R - $r0.L; $h0 = $r0.B - $r0.T
  # 각 띠의 왼쪽 1/6 지점에 창 왼쪽을 둔다 — 사이드바(창 왼쪽 242px)가 그 띠 안에 온다
  $xs = @()
  for ($i = 0; $i -lt 3; $i++) { $xs += [int]($scr.X + $scr.Width * $i / 3 + 20) }
  $y = $scr.Y + 220

  foreach ($bd in $Backdrops) {
    $v = [int]$bd
    $hr = [R]::DwmSetWindowAttribute($hwnd, $SBT, [ref]$v, 4)
    Pump 700
    $got = 0; [R]::DwmGetWindowAttribute($hwnd, $SBT, [ref]$got, 4) | Out-Null
    $samples = @()
    for ($i = 0; $i -lt 3; $i++) {
      [R]::SetWindowPos($hwnd, $HWND_TOPMOST, $xs[$i], $y, $w, $h0, 0) | Out-Null
      [R]::Fg($hwnd) | Out-Null
      Pump 900
      $s = SampleSidebar $hwnd
      $samples += , $s
      Shot $hwnd ("{0}-bd{1}-{2}.png" -f $Prefix, $bd, $bands[$i].n)
    }
    # 추적성 = 세 띠에서 잰 값의 최대-최소 (채널별 최대 스윙)
    $swing = 0
    for ($c = 0; $c -lt 3; $c++) {
      $vals = $samples | ForEach-Object { $_[$c] }
      $sw = ($vals | Measure-Object -Maximum).Maximum - ($vals | Measure-Object -Minimum).Minimum
      if ($sw -gt $swing) { $swing = $sw }
    }
    $rec = [pscustomobject]@{
      backdropSet = $bd; backdropName = $NAME[$bd]; setHr = ('0x{0:X8}' -f $hr); backdropRead = $got
      magenta = ($samples[0] -join ','); cyan = ($samples[1] -join ','); white = ($samples[2] -join ',')
      swing = [Math]::Round($swing, 1)
      glass = $(if ($swing -ge 6) { 'LIVE' } else { 'DEAD' })
    }
    $rows += $rec
    "{0,-8} set={1} read={2}  magenta={3,-16} cyan={4,-16} white={5,-16} swing={6,5}  → {7}" -f `
      $rec.backdropName, $bd, $got, $rec.magenta, $rec.cyan, $rec.white, $rec.swing, $rec.glass | Write-Host
  }
} finally {
  $v = [int]$orig
  [R]::DwmSetWindowAttribute($hwnd, $SBT, [ref]$v, 4) | Out-Null
  [R]::SetWindowPos($hwnd, $HWND_NOTOPMOST, 0, 0, 0, 0, ($SWP_NOSIZE -bor $SWP_NOMOVE -bor $SWP_NOACTIVATE)) | Out-Null
  try { $back.Close() } catch {}
  $json = Join-Path $OutDir "$Prefix-repro.json"
  $rows | ConvertTo-Json -Depth 5 | Set-Content -Path $json -Encoding UTF8
  Write-Host ""
  Write-Host "-> $json  (원래 backdrop $orig 로 복구)"
}
