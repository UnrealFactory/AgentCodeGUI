# 유리(아크릴) 트리거 실험대 — Win32 레벨.
#
# 왜 OS 캡처인가: 아크릴은 **DWM이 합성한 결과**다. CDP/PrintWindow 스크린샷은 웹뷰가
# 그린 레이어만 담아서, 유리가 꺼져도 늘 똑같이 나온다. 그래서 화면 픽셀을
# Graphics.CopyFromScreen으로 그대로 뜬다.
#
# 왜 기준 배경판인가: 바탕 화면 사진 위에서는 유리가 켜지나 꺼지나 색 차이가 몇 단위라
# 사람 눈에도 계측에도 애매하다. 창 뒤에 **원색 3띠 판**을 깔면 유리 = 강한 채도,
# 유리 꺼짐 = 채도 0(무채색 회색)으로 갈린다. chroma(max-min 채널)가 그 판정기다.
#
# 왜 TOPMOST인가: '비활성' 상태를 찍으려면 창이 포커스를 잃어야 하는데, 그러면 다른 창이
# 위로 올라와 캡처를 가린다(1차 실행 실패 원인). 앱 창을 TOPMOST로 고정하면
# **비활성이면서 화면 맨 위**라는 상태를 만들 수 있다. 백드롭 판정에는 영향이 없다
# (DWMWA_SYSTEMBACKDROP_TYPE 읽기값으로 확인).
#
#   pwsh -File lab.ps1 -TargetPid 1234 -Prefix e262 -OutDir ..\..\docs\design\glass-shots
param(
  [Parameter(Mandatory = $true)][int]$TargetPid,
  [Parameter(Mandatory = $true)][string]$Prefix,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [switch]$SkipTransparencyToggle
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Lab {
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
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wp, string lp, uint flags, uint timeout, out IntPtr res);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  public static IntPtr MainWindowOf(uint target) {
    IntPtr best = IntPtr.Zero; int bestArea = 0;
    EnumWindows((h,l)=>{
      if(!IsWindowVisible(h)) return true;
      uint p; GetWindowThreadProcessId(h, out p);
      if(p != target) return true;
      RECT r; GetWindowRect(h, out r);
      int a = (r.Right-r.Left) * (r.Bottom-r.Top);
      if((r.Right-r.Left) >= 300 && (r.Bottom-r.Top) >= 300 && a > bestArea){ bestArea = a; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
  public static void ForceForeground(IntPtr h){
    keybd_event(0x12, 0, 0, UIntPtr.Zero);   // ALT down/up = "사용자 입력 중" → 포그라운드 제한 해제
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(h);
  }
}
"@

$SW_RESTORE = 9; $SW_MAXIMIZE = 3; $SW_MINIMIZE = 6
$VK_LWIN = 0x5B; $VK_LEFT = 0x25; $VK_UP = 0x26
$KEYUP = 2
$HWND_TOPMOST = [IntPtr](-1); $HWND_NOTOPMOST = [IntPtr](-2)
$SWP_NOSIZE = 0x1; $SWP_NOMOVE = 0x2; $SWP_NOACTIVATE = 0x10

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path

$hwnd = [Lab]::MainWindowOf([uint32]$TargetPid)
if ($hwnd -eq [IntPtr]::Zero) { throw "PID $TargetPid main window not found" }
$sb = New-Object System.Text.StringBuilder 256
[Lab]::GetWindowText($hwnd, $sb, 256) | Out-Null
Write-Host ("target hwnd={0} title='{1}'" -f $hwnd, $sb.ToString())

function Pump([int]$ms = 400) {
  $end = (Get-Date).AddMilliseconds($ms)
  while ((Get-Date) -lt $end) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 15 }
}

# ── 기준 배경판: 원색 3띠(마젠타/시안/흰색) ─────────────────────────────────
$scr = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$back = New-Object System.Windows.Forms.Form
$back.FormBorderStyle = 'None'; $back.StartPosition = 'Manual'
$back.Location = New-Object System.Drawing.Point($scr.X, $scr.Y)
$back.Size = New-Object System.Drawing.Size($scr.Width, $scr.Height)
$back.ShowInTaskbar = $false
$back.Add_Paint({
  param($s, $e)
  $w = $s.ClientSize.Width; $h = $s.ClientSize.Height
  $bands = @(
    @([System.Drawing.Color]::FromArgb(255, 255, 0, 170), 0.0, 0.34),
    @([System.Drawing.Color]::FromArgb(255, 0, 210, 255), 0.34, 0.67),
    @([System.Drawing.Color]::FromArgb(255, 250, 250, 250), 0.67, 1.0)
  )
  foreach ($b in $bands) {
    $br = New-Object System.Drawing.SolidBrush $b[0]
    $e.Graphics.FillRectangle($br, [int]($w * $b[1]), 0, [int]($w * ($b[2] - $b[1])) + 1, $h)
    $br.Dispose()
  }
})
$back.Show(); Pump 400

# ── 포커스 도둑(작은 창, 화면 우하단) ───────────────────────────────────────
$thief = New-Object System.Windows.Forms.Form
$thief.Text = "glass-lab"
$thief.StartPosition = 'Manual'
$thief.Size = New-Object System.Drawing.Size(300, 140)
$thief.BackColor = [System.Drawing.Color]::FromArgb(255, 30, 30, 30)
$thief.Location = New-Object System.Drawing.Point(($scr.Right - 320), ($scr.Bottom - 200))
$thief.Show(); Pump 300

# 앱 창을 배경판 위 화면 중앙에 고정 + TOPMOST
[Lab]::ShowWindow($hwnd, $SW_RESTORE) | Out-Null; Pump 500
$winW = 1500; $winH = 950
[Lab]::SetWindowPos($hwnd, $HWND_TOPMOST, ($scr.X + [int](($scr.Width - $winW) / 2)), ($scr.Y + 180), $winW, $winH, 0) | Out-Null
Pump 800

function WaitFocus([bool]$wantApp) {
  for ($i = 0; $i -lt 12; $i++) {
    if ($wantApp) { [Lab]::ForceForeground($hwnd) } else { [Lab]::ForceForeground($thief.Handle) }
    Pump 250
    $isApp = ([Lab]::GetForegroundWindow() -eq $hwnd)
    if ($isApp -eq $wantApp) { Pump 550; return $true }   # DWM 비활성 전환이 끝날 시간
  }
  return $false
}
function FocusApp { WaitFocus $true | Out-Null }
function FocusThief { WaitFocus $false | Out-Null }
function Chord([int]$mod, [int]$key) {
  [Lab]::keybd_event([byte]$mod, 0, 0, [UIntPtr]::Zero)
  [Lab]::keybd_event([byte]$key, 0, 0, [UIntPtr]::Zero)
  [Lab]::keybd_event([byte]$key, 0, $KEYUP, [UIntPtr]::Zero)
  [Lab]::keybd_event([byte]$mod, 0, $KEYUP, [UIntPtr]::Zero)
  Pump 900
}

$samples = @()
$n = 0
function Snap([string]$state, [string]$note = "") {
  $script:n++
  $idx = "{0:D2}" -f $script:n
  $file = Join-Path $OutDir "$Prefix-$idx-$state.png"
  if ([Lab]::IsIconic($hwnd)) { Write-Host ("{0,2}. {1,-28} MINIMIZED - skip" -f $script:n, $state); return }
  $r = New-Object Lab+RECT
  [Lab]::GetWindowRect($hwnd, [ref]$r) | Out-Null
  $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $cx = [Math]::Max($r.Left - 40, $vs.Left); $cy = [Math]::Max($r.Top - 40, $vs.Top)
  $cw = [Math]::Min($r.Right + 40, $vs.Right) - $cx; $ch = [Math]::Min($r.Bottom + 40, $vs.Bottom) - $cy
  if ($cw -le 0 -or $ch -le 0) { Write-Host ("{0,2}. {1,-28} OFFSCREEN - skip" -f $script:n, $state); return }
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
  $side = Avg $bmp ($ox + 45) ($oy + [int]($h * 0.60))              # 사이드바 빈 구간
  $body = Avg $bmp ($ox + [int]($w * 0.90)) ($oy + [int]($h * 0.52)) # 본문 빈 구간
  $out  = Avg $bmp ([Math]::Max($ox - 20, 2)) ($oy + [int]($h * 0.5))# 창 바깥 = 배경판 대조군
  $bmp.Dispose()

  $maxz = [Lab]::IsZoomed($hwnd); $fg = ([Lab]::GetForegroundWindow() -eq $hwnd)
  $bd = 0; [Lab]::DwmGetWindowAttribute($hwnd, 38, [ref]$bd, 4) | Out-Null   # 38 = DWMWA_SYSTEMBACKDROP_TYPE
  $chroma = [Math]::Max([Math]::Max($side[0], $side[1]), $side[2]) - [Math]::Min([Math]::Min($side[0], $side[1]), $side[2])
  $rec = [pscustomobject]@{
    idx = $script:n; state = $state; note = $note; file = "$Prefix-$idx-$state.png"
    focused = $fg; maximized = $maxz; backdropAttr = $bd
    rect = "$($r.Left),$($r.Top) ${w}x${h}"
    sidebar = "$($side[0]),$($side[1]),$($side[2])"
    body = "$($body[0]),$($body[1]),$($body[2])"
    outside = "$($out[0]),$($out[1]),$($out[2])"
    chroma = $chroma
    glass = if ($chroma -ge 8) { "ON" } else { "OFF" }
  }
  $script:samples += $rec
  "{0,2}. {1,-28} focus={2,-5} max={3,-5} bd={4} sidebar={5,-14} chroma={6,3} glass={7,-3} body={8,-14} back={9}" -f `
    $rec.idx, $state, $fg, $maxz, $bd, $rec.sidebar, $chroma, $rec.glass, $rec.body, $rec.outside | Write-Host
}

function Get-Transparency {
  (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name EnableTransparency -ErrorAction SilentlyContinue).EnableTransparency
}
function Set-Transparency([int]$v) {
  Set-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name EnableTransparency -Value $v -Type DWord
  $res = [IntPtr]::Zero
  [Lab]::SendMessageTimeout([IntPtr]0xFFFF, 0x1A, [IntPtr]::Zero, "ImmersiveColorSet", 2, 2000, [ref]$res) | Out-Null
  Pump 2000
}

$origTransparency = Get-Transparency
$cover = $null
try {
  # ── 1. 기준선: 활성 ↔ 비활성 ────────────────────────────────────────────────
  FocusApp;   Snap "base-focused"     "배경판 위, 활성"
  FocusThief; Snap "base-blurred"     "포커스를 다른 창으로 = 비활성"
  FocusApp;   Snap "base-refocused"

  # ── 2. 최대화 ────────────────────────────────────────────────────────────────
  [Lab]::ShowWindow($hwnd, $SW_MAXIMIZE) | Out-Null; Pump 1000
  FocusApp;   Snap "max-focused"      "최대화(배경판을 완전히 덮는다)"
  FocusThief; Snap "max-blurred"
  FocusApp; [Lab]::ShowWindow($hwnd, $SW_RESTORE) | Out-Null; Pump 1000
  [Lab]::SetWindowPos($hwnd, $HWND_TOPMOST, ($scr.X + [int](($scr.Width - $winW) / 2)), ($scr.Y + 180), $winW, $winH, 0) | Out-Null
  Pump 600
  Snap "restored-focused"

  # ── 3. 스냅(Win+Left) ────────────────────────────────────────────────────────
  FocusApp; Chord $VK_LWIN $VK_LEFT
  [System.Windows.Forms.SendKeys]::SendWait("{ESC}"); Pump 800
  FocusApp;   Snap "snap-left-focused"
  FocusThief; Snap "snap-left-blurred"
  FocusApp; [Lab]::ShowWindow($hwnd, $SW_RESTORE) | Out-Null; Pump 800
  [Lab]::SetWindowPos($hwnd, $HWND_TOPMOST, ($scr.X + [int](($scr.Width - $winW) / 2)), ($scr.Y + 180), $winW, $winH, 0) | Out-Null
  Pump 600
  Snap "unsnap-restored"

  # ── 4. 최소화 → 복원 ────────────────────────────────────────────────────────
  [Lab]::ShowWindow($hwnd, $SW_MINIMIZE) | Out-Null; Pump 1200
  [Lab]::ShowWindow($hwnd, $SW_RESTORE) | Out-Null; Pump 1200
  [Lab]::SetWindowPos($hwnd, $HWND_TOPMOST, ($scr.X + [int](($scr.Width - $winW) / 2)), ($scr.Y + 180), $winW, $winH, 0) | Out-Null
  FocusApp; Snap "min-restore-focused"

  # ── 5. 다른 창이 위에 겹침 → 비켜남 ─────────────────────────────────────────
  $r0 = New-Object Lab+RECT; [Lab]::GetWindowRect($hwnd, [ref]$r0) | Out-Null
  $cover = New-Object System.Windows.Forms.Form
  $cover.FormBorderStyle = 'None'; $cover.BackColor = [System.Drawing.Color]::FromArgb(255, 255, 240, 0)
  $cover.StartPosition = 'Manual'; $cover.ShowInTaskbar = $false
  $cover.Location = New-Object System.Drawing.Point(($r0.Left + 300), ($r0.Top + 200))
  $cover.Size = New-Object System.Drawing.Size(700, 500)
  $cover.TopMost = $true; $cover.Show(); Pump 1200
  FocusApp; Snap "covered-partially" "노란 창이 앱 위 일부를 덮음(참고)"
  $cover.Hide(); Pump 900
  FocusApp; Snap "after-cover-removed"

  # ── 6. 두 번째 모니터 ───────────────────────────────────────────────────────
  $screens = [System.Windows.Forms.Screen]::AllScreens
  if ($screens.Count -gt 1) {
    $cur = [System.Windows.Forms.Screen]::FromHandle($hwnd)
    $other = $screens | Where-Object { $_.DeviceName -ne $cur.DeviceName } | Select-Object -First 1
    [Lab]::SetWindowPos($hwnd, $HWND_TOPMOST, ($other.Bounds.X + 300), ($other.Bounds.Y + 200), $winW, $winH, 0) | Out-Null
    Pump 1200
    FocusApp;   Snap "monitor2-focused" "두 번째 모니터(배경판 없음 = 바탕화면 위)"
    FocusThief; Snap "monitor2-blurred"
    FocusApp
    [Lab]::SetWindowPos($hwnd, $HWND_TOPMOST, ($scr.X + [int](($scr.Width - $winW) / 2)), ($scr.Y + 180), $winW, $winH, 0) | Out-Null
    Pump 1000
    Snap "monitor1-back"
  }

  # ── 7. 투명 효과 끄기 / 켜기 ────────────────────────────────────────────────
  if (-not $SkipTransparencyToggle) {
    FocusApp
    Set-Transparency 0
    FocusApp;   Snap "transparency-off-focused" "설정>개인 설정>색>투명 효과 = 끔"
    FocusThief; Snap "transparency-off-blurred"
    FocusApp;   Snap "transparency-off-refocused"
    Set-Transparency $origTransparency
    FocusApp;   Snap "transparency-on-focused"  "투명 효과 되돌림 - 유리가 스스로 복구되나"
    FocusThief; Snap "transparency-on-blurred"
    FocusApp;   Snap "transparency-on-refocused"
  }
} finally {
  if ($null -ne $origTransparency) { Set-Transparency $origTransparency }
  [Lab]::SetWindowPos($hwnd, $HWND_NOTOPMOST, 0, 0, 0, 0, ($SWP_NOSIZE -bor $SWP_NOMOVE -bor $SWP_NOACTIVATE)) | Out-Null
  if ($cover) { try { $cover.Close() } catch {} }
  try { $thief.Close() } catch {}
  try { $back.Close() } catch {}
  $jsonPath = Join-Path $OutDir "$Prefix-samples.json"
  $samples | ConvertTo-Json -Depth 4 | Set-Content -Path $jsonPath -Encoding UTF8
  Write-Host ""
  Write-Host "-> $jsonPath"
}
