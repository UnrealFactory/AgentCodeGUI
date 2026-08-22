# 유리 A/B 촬영기 — lab.ps1의 축소판. 화면을 통째로 덮지 않고 **창 뒤 딱 필요한 만큼만**
# 원색 판을 깔아 찍는다(다른 에이전트가 같은 화면에서 벤치를 돌리는 중이라 방해를 줄인다).
#
# 판정기는 lab.ps1과 같다: 창 뒤에 마젠타 판을 깔면
#   유리 살아 있음 = 사이드바가 마젠타로 물든다(chroma 큼)
#   유리 꺼짐      = 무채색 회색(chroma ~0)
#
#   pwsh -File abglass.ps1 -TargetPid 123 -Prefix lab-a -OutDir ..\..\docs\design\glass-shots `
#        -X 120 -Y 120 -W 900 -H 560 -States focus,blur,refocus
param(
  [Parameter(Mandatory = $true)][int]$TargetPid,
  [Parameter(Mandatory = $true)][string]$Prefix,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [int]$X = 120, [int]$Y = 120, [int]$W = 900, [int]$H = 560,
  [string]$States = "focus,blur,refocus",
  [int]$Settle = 700
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class AB {
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int ht, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wp, string lp, uint flags, uint timeout, out IntPtr res);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
  [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int val, int size);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static IntPtr MainWindowOf(uint target) {
    IntPtr best = IntPtr.Zero; int bestArea = 0;
    EnumWindows((h,l)=>{
      if(!IsWindowVisible(h)) return true;
      uint p; GetWindowThreadProcessId(h, out p);
      if(p != target) return true;
      RECT r; GetWindowRect(h, out r);
      int a = (r.Right-r.Left) * (r.Bottom-r.Top);
      if((r.Right-r.Left) >= 200 && (r.Bottom-r.Top) >= 200 && a > bestArea){ bestArea = a; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
  public static void ForceForeground(IntPtr h){
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(h);
  }
}
"@

$SW_RESTORE = 9; $SW_MAXIMIZE = 3
$HWND_TOPMOST = [IntPtr](-1); $HWND_NOTOPMOST = [IntPtr](-2)
$SWP_NOSIZE = 0x1; $SWP_NOMOVE = 0x2; $SWP_NOACTIVATE = 0x10
$SBT = 38   # DWMWA_SYSTEMBACKDROP_TYPE

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path

$hwnd = [AB]::MainWindowOf([uint32]$TargetPid)
if ($hwnd -eq [IntPtr]::Zero) { throw "PID $TargetPid 창을 못 찾음" }

function Pump([int]$ms = 300) {
  $end = (Get-Date).AddMilliseconds($ms)
  while ((Get-Date) -lt $end) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 15 }
}

# 창 뒤 원색 판 — 창보다 60px씩 크게만
$pad = 60
$back = New-Object System.Windows.Forms.Form
$back.FormBorderStyle = 'None'; $back.StartPosition = 'Manual'; $back.ShowInTaskbar = $false
$back.Location = New-Object System.Drawing.Point(($X - $pad), ($Y - $pad))
$back.Size = New-Object System.Drawing.Size(($W + $pad * 2), ($H + $pad * 2))
$back.BackColor = [System.Drawing.Color]::FromArgb(255, 255, 0, 170)
$back.Show(); Pump 300

$thief = New-Object System.Windows.Forms.Form
$thief.Text = "ab-thief"; $thief.StartPosition = 'Manual'
$thief.Size = New-Object System.Drawing.Size(260, 120)
$thief.BackColor = [System.Drawing.Color]::FromArgb(255, 30, 30, 30)
$thief.Location = New-Object System.Drawing.Point(($X + $W + $pad + 30), $Y)
$thief.Show(); Pump 250

[AB]::ShowWindow($hwnd, $SW_RESTORE) | Out-Null; Pump 300
[AB]::SetWindowPos($hwnd, $HWND_TOPMOST, $X, $Y, $W, $H, 0) | Out-Null; Pump 600

function WaitFocus([bool]$wantApp) {
  for ($i = 0; $i -lt 12; $i++) {
    if ($wantApp) { [AB]::ForceForeground($hwnd) } else { [AB]::ForceForeground($thief.Handle) }
    Pump 220
    if (([AB]::GetForegroundWindow() -eq $hwnd) -eq $wantApp) { Pump $Settle; return }
  }
}

$samples = @()
$n = 0
function Snap([string]$state, [string]$note = "") {
  $script:n++
  $idx = "{0:D2}" -f $script:n
  $file = Join-Path $OutDir "$Prefix-$idx-$state.png"
  $r = New-Object AB+RECT
  [AB]::GetWindowRect($hwnd, [ref]$r) | Out-Null
  $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $cx = [Math]::Max($r.Left - 30, $vs.Left); $cy = [Math]::Max($r.Top - 30, $vs.Top)
  $cw = [Math]::Min($r.Right + 30, $vs.Right) - $cx; $ch = [Math]::Min($r.Bottom + 30, $vs.Bottom) - $cy
  $bmp = New-Object System.Drawing.Bitmap $cw, $ch
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($cx, $cy, 0, 0, (New-Object System.Drawing.Size($cw, $ch)))
  $g.Dispose()
  $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  function Avg($bm, [int]$px, [int]$py) {
    $rr = 0; $gg = 0; $bb = 0; $cnt = 0
    for ($dx = -4; $dx -le 4; $dx++) { for ($dy = -4; $dy -le 4; $dy++) {
      $xx = [Math]::Min([Math]::Max($px + $dx, 0), $bm.Width - 1)
      $yy = [Math]::Min([Math]::Max($py + $dy, 0), $bm.Height - 1)
      $c = $bm.GetPixel($xx, $yy); $rr += $c.R; $gg += $c.G; $bb += $c.B; $cnt++
    } }
    return @([int][Math]::Round($rr / $cnt), [int][Math]::Round($gg / $cnt), [int][Math]::Round($bb / $cnt))
  }
  $ox = $r.Left - $cx; $oy = $r.Top - $cy
  $side = Avg $bmp ($ox + 45) ($oy + [int]($h * 0.62))
  $body = Avg $bmp ($ox + [int]($w * 0.90)) ($oy + [int]($h * 0.52))
  $out  = Avg $bmp ([Math]::Max($ox - 15, 2)) ($oy + [int]($h * 0.5))
  $bmp.Dispose()
  $bd = 0; [AB]::DwmGetWindowAttribute($hwnd, $SBT, [ref]$bd, 4) | Out-Null
  $chroma = [Math]::Max([Math]::Max($side[0], $side[1]), $side[2]) - [Math]::Min([Math]::Min($side[0], $side[1]), $side[2])
  $rec = [pscustomobject]@{
    idx = $script:n; state = $state; note = $note; file = "$Prefix-$idx-$state.png"
    focused = ([AB]::GetForegroundWindow() -eq $hwnd); maximized = [AB]::IsZoomed($hwnd); backdropAttr = $bd
    sidebar = "$($side[0]),$($side[1]),$($side[2])"; body = "$($body[0]),$($body[1]),$($body[2])"
    outside = "$($out[0]),$($out[1]),$($out[2])"; chroma = $chroma
    glass = if ($chroma -ge 8) { "ON" } else { "OFF" }
  }
  $script:samples += $rec
  "{0,2}. {1,-26} focus={2,-5} bd={3} sidebar={4,-14} chroma={5,3} glass={6,-3} body={7,-14} back={8}" -f `
    $rec.idx, $state, $rec.focused, $bd, $rec.sidebar, $chroma, $rec.glass, $rec.body, $rec.outside | Write-Host
}

function Get-Transparency { (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name EnableTransparency -ErrorAction SilentlyContinue).EnableTransparency }
function Set-Transparency([int]$v) {
  Set-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name EnableTransparency -Value $v -Type DWord
  $res = [IntPtr]::Zero
  [AB]::SendMessageTimeout([IntPtr]0xFFFF, 0x1A, [IntPtr]::Zero, "ImmersiveColorSet", 2, 2000, [ref]$res) | Out-Null
  Pump 1800
}
$origTransparency = Get-Transparency

try {
  foreach ($s in $States.Split(',')) {
    # 백드롭 타입을 **바깥 프로세스에서** 갈아 끼운다 (MicaForEveryone과 같은 수법):
    #   sbt:N     → DwmSetWindowAttribute(38, N)   0=Auto 1=None 2=Mica 3=Acrylic 4=Tabbed
    #   resbt     → 지금 값을 그대로 다시 써 넣는다 = (a)안의 '재적용'
    $t = $s.Trim()
    if ($t -eq 'focus') { WaitFocus $true;  Snap "focused" }
    elseif ($t -eq 'blur') { WaitFocus $false; Snap "blurred" }
    elseif ($t -eq 'refocus') { WaitFocus $true;  Snap "refocused" }
    elseif ($t -eq 'max') { WaitFocus $true; [AB]::ShowWindow($hwnd, $SW_MAXIMIZE) | Out-Null; Pump 900; Snap "max-focused" }
    elseif ($t -eq 'maxblur') { WaitFocus $false; Snap "max-blurred" }
    elseif ($t -eq 'restore') {
      WaitFocus $true; [AB]::ShowWindow($hwnd, $SW_RESTORE) | Out-Null; Pump 700
      [AB]::SetWindowPos($hwnd, $HWND_TOPMOST, $X, $Y, $W, $H, 0) | Out-Null; Pump 500; Snap "restored"
    }
    elseif ($t -eq 'troff') { Set-Transparency 0; WaitFocus $true;  Snap "tr-off-focused" "투명 효과 끔" }
    elseif ($t -eq 'troffblur') { WaitFocus $false; Snap "tr-off-blurred" }
    elseif ($t -eq 'tron') { Set-Transparency $origTransparency; WaitFocus $true; Snap "tr-on-focused" "투명 효과 복구" }
    elseif ($t -match '^sbt:(\d)$') {
      $v = [int]$Matches[1]
      [AB]::DwmSetWindowAttribute($hwnd, $SBT, [ref]$v, 4) | Out-Null; Pump 600
      Snap ("sbt" + $v)
    }
    elseif ($t -eq 'resbt') {
      $cur = 0; [AB]::DwmGetWindowAttribute($hwnd, $SBT, [ref]$cur, 4) | Out-Null
      [AB]::DwmSetWindowAttribute($hwnd, $SBT, [ref]$cur, 4) | Out-Null; Pump 400
      Snap "reapplied" "그 상태 그대로 백드롭 재적용"
    }
    elseif ($t -match '^wait:(\d+)$') { Pump ([int]$Matches[1]) }
    else { Write-Host "unknown state: $t" }
  }
} finally {
  if ($null -ne $origTransparency) { Set-Transparency $origTransparency }
  [AB]::SetWindowPos($hwnd, $HWND_NOTOPMOST, 0, 0, 0, 0, ($SWP_NOSIZE -bor $SWP_NOMOVE -bor $SWP_NOACTIVATE)) | Out-Null
  try { $thief.Close() } catch {}
  try { $back.Close() } catch {}
  $jsonPath = Join-Path $OutDir "$Prefix-samples.json"
  $samples | ConvertTo-Json -Depth 4 | Set-Content -Path $jsonPath -Encoding UTF8
  Write-Host "-> $jsonPath"
}
