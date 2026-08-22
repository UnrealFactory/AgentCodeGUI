# 유리(아크릴) 관측·강제 엔진 — Win32/DWM/WinRT 레벨.
#
# 왜 Windows PowerShell 5.1인가: 판정의 진실 소스가 **WinRT
# `Windows.UI.ViewManagement.UISettings.AdvancedEffectsEnabled`** 인데, PS7에서는
# WinRT 투영이 빠져 있어 타입을 못 찾는다(실측: PS 7.6.5 "Unable to find type").
# 5.1에서는 그대로 뜬다. 그래서 이 스크립트는 반드시 `powershell.exe`로 돈다.
#
# 왜 DWMWA_SYSTEMBACKDROP_TYPE만으로는 안 되는가: 그 속성은 **우리가 써 넣은 값을
# 되읽는 것**이지 "지금 DWM이 아크릴을 그리고 있는가"가 아니다. 앞선 실험대 실행에서
# OS 투명 효과를 껐는데도 bd=3이 그대로 나왔다(docs/critic/glass-lab-electron.json
# 09~11번 상태). 그래서 관측은 **속성 + OS 상태 + 실제 화면 픽셀** 세 갈래를 함께 찍는다.
#
# 왜 DwmGetColorizationColor는 안 쓰는가: 이 컴퓨터(Win11 26200, 투명 효과 켜짐)에서
# pfOpaqueBlend가 **True**로 나온다 — 문서상 "투명 꺼짐"을 뜻하는 값인데 실제와 반대다.
# 신호로 쓸 수 없다(실측).
#
#   powershell -File glass.ps1 -Action read    -TargetPid 1234
#   powershell -File glass.ps1 -Action force   -TargetPid 1234 -Backdrop 1
#   powershell -File glass.ps1 -Action shot    -TargetPid 1234 -Out shot.png
#   powershell -File glass.ps1 -Action observe -TargetPid 1234 -Seconds 3600 -Out log.jsonl
#
# 안전 규약(이 스크립트가 지키는 것):
#  - **OS 전역 설정을 절대 건드리지 않는다.** 투명 효과 토글·전원 계획 변경 없음.
#    -Action force는 **지정한 hwnd 하나**의 DWM 백드롭만 바꾼다(per-window).
#  - 남의 프로세스를 죽이지 않는다. -TargetPid는 관측 대상일 뿐이다.
#  - force는 -Restore로 되돌린다. observe는 아무것도 쓰지 않는다(읽기 전용).
param(
  [ValidateSet('read', 'force', 'shot', 'observe', 'knock')][string]$Action = 'read',
  [int]$TargetPid = 0,
  [long]$Hwnd = 0,
  # 0=AUTO 1=NONE 2=MAINWINDOW(mica) 3=TRANSIENTWINDOW(acrylic) 4=TABBEDWINDOW
  [int]$Backdrop = 3,
  [string]$Out = "",
  [int]$Seconds = 600,
  [int]$IntervalMs = 1000,
  # knock 전용 — 걷어찬 직후 **그 창 하나에만** WM_SETTINGCHANGE("ImmersiveColorSet")를 보낸다.
  # OS 설정을 바꾸지 않고 "테마가 바뀐 척"만 하는 것이라 데스크톱에 아무 영향이 없다
  # (HWND_BROADCAST가 아니라 대상 hwnd 지정). 메시지 경로의 복구 속도를 재기 위한 것.
  [switch]$Nudge,
  # 시행 사이 간격. 기본 2500ms인 이유: glass.rs는 사건 하나에 60·400·1200ms 세 박자로
  # 나눠 단언한다(합 1660ms + 검증 패스). 그보다 짧은 간격으로 연달아 걷어차면 다음
  # 시행이 **앞 시행의 단언 열차 안**에 떨어져, 측정값이 앱의 반응 속도가 아니라
  # 열차의 남은 시간이 된다(실측으로 밟은 함정: 900ms 간격에서 76ms → 750ms로 보였다).
  [int]$GapMs = 2500,
  [switch]$Quiet
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing | Out-Null

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class G {
  public delegate bool EW(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EW cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int m);
  [DllImport("user32.dll")] public static extern int GetWindowLongW(IntPtr h, int i);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeoutW(IntPtr h, uint msg, IntPtr wp, string lp, uint flags, uint ms, out IntPtr res);
  [DllImport("kernel32.dll")] public static extern bool GetSystemPowerStatus(out SPS s);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
  [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr h, int a, ref int v, int s);
  [DllImport("dwmapi.dll")] public static extern int DwmIsCompositionEnabled(out bool e);
  [DllImport("dwmapi.dll")] public static extern int DwmGetColorizationColor(out uint c, out bool opaque);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  [StructLayout(LayoutKind.Sequential)] public struct SPS {
    public byte ACLineStatus, BatteryFlag, BatteryLifePercent, SystemStatusFlag;
    public uint BatteryLifeTime, BatteryFullLifeTime;
  }
  /// 대상 PID의 "가장 큰 보이는 창" = 메인 창. 최소화된 창(-32000)도 후보로 남긴다.
  public static IntPtr MainWindowOf(uint target) {
    IntPtr best = IntPtr.Zero; long bestArea = -1;
    EnumWindows((h,l)=>{
      if(!IsWindowVisible(h)) return true;
      uint p; GetWindowThreadProcessId(h, out p);
      if(p != target) return true;
      RECT r; GetWindowRect(h, out r);
      long a = (long)(r.R-r.L) * (r.B-r.T);
      if(a > bestArea){ bestArea = a; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
  public static string TitleOf(IntPtr h){
    var sb = new StringBuilder(320); GetWindowTextW(h, sb, 320); return sb.ToString();
  }
}
"@ | Out-Null

# ── DWM 상수 ────────────────────────────────────────────────────────────────
$DWMWA_CLOAKED = 14
$DWMWA_SYSTEMBACKDROP_TYPE = 38
$SBT_NAME = @{ 0 = 'AUTO'; 1 = 'NONE'; 2 = 'MAINWINDOW(mica)'; 3 = 'TRANSIENTWINDOW(acrylic)'; 4 = 'TABBEDWINDOW' }

function Resolve-Hwnd {
  if ($Hwnd -ne 0) { return [IntPtr]$Hwnd }
  if ($TargetPid -le 0) { throw "-TargetPid 또는 -Hwnd 중 하나는 필요하다" }
  $h = [G]::MainWindowOf([uint32]$TargetPid)
  if ($h -eq [IntPtr]::Zero) { throw "PID $TargetPid 의 창을 찾지 못했다" }
  return $h
}

# ── OS 상태(읽기 전용) ──────────────────────────────────────────────────────
# 여기서 읽는 값 중 **AdvancedEffectsEnabled 하나가 판정의 진실 소스**다.
# 나머지는 "왜 꺼졌나"를 설명하는 재료다(원인 후보 좁히기).
$script:UISettings = $null
function Get-AdvancedEffects {
  try {
    if ($null -eq $script:UISettings) {
      [Windows.UI.ViewManagement.UISettings, Windows.UI.ViewManagement, ContentType = WindowsRuntime] | Out-Null
      $script:UISettings = New-Object Windows.UI.ViewManagement.UISettings
    }
    return [bool]$script:UISettings.AdvancedEffectsEnabled
  } catch { return $null }   # PS7 등 WinRT 없는 환경
}

function Get-OsState {
  $reg = $null
  try {
    $reg = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' `
        -Name EnableTransparency -ErrorAction SilentlyContinue).EnableTransparency
  } catch {}
  $comp = $false; [G]::DwmIsCompositionEnabled([ref]$comp) | Out-Null
  $sps = New-Object G+SPS
  $havePower = $false
  try { $havePower = [G]::GetSystemPowerStatus([ref]$sps) } catch {}
  $col = 0; $opaque = $false
  try { [G]::DwmGetColorizationColor([ref]$col, [ref]$opaque) | Out-Null } catch {}
  $fg = [G]::GetForegroundWindow()
  $fgPid = 0; if ($fg -ne [IntPtr]::Zero) { [G]::GetWindowThreadProcessId($fg, [ref]$fgPid) | Out-Null }
  $fgName = ''
  if ($fgPid -ne 0) { try { $fgName = (Get-Process -Id $fgPid -ErrorAction SilentlyContinue).ProcessName } catch {} }
  [ordered]@{
    advancedEffects = Get-AdvancedEffects            # ← 진실 소스(WinRT)
    regTransparency = $reg                           # ← 설정 앱이 쓰는 레지스트리 값
    dwmComposition  = [bool]$comp
    remoteSession   = ([G]::GetSystemMetrics(4096) -ne 0)
    powerSaver      = if ($havePower) { [int]$sps.SystemStatusFlag } else { $null }   # 1 = 절전 모드
    acLine          = if ($havePower) { [int]$sps.ACLineStatus } else { $null }
    colorization    = ('0x{0:X8}' -f $col)
    opaqueBlend     = [bool]$opaque                  # ← 실측상 신뢰 불가(헤더 주석 참조)
    monitors        = [System.Windows.Forms.Screen]::AllScreens.Count
    foreground      = $fgName
  }
}
Add-Type -AssemblyName System.Windows.Forms | Out-Null

# ── 창 상태 ─────────────────────────────────────────────────────────────────
function Get-WinState([IntPtr]$h) {
  if (-not [G]::IsWindow($h)) { return $null }
  $r = New-Object G+RECT; [G]::GetWindowRect($h, [ref]$r) | Out-Null
  $bd = -1; $hr = [G]::DwmGetWindowAttribute($h, $DWMWA_SYSTEMBACKDROP_TYPE, [ref]$bd, 4)
  if ($hr -ne 0) { $bd = -1 }
  $ck = 0; [G]::DwmGetWindowAttribute($h, $DWMWA_CLOAKED, [ref]$ck, 4) | Out-Null
  [ordered]@{
    hwnd       = [int64]$h
    title      = [G]::TitleOf($h)
    backdrop   = $bd
    backdropHr = ('0x{0:X8}' -f $hr)
    cloaked    = $ck
    minimized  = [G]::IsIconic($h)
    maximized  = [G]::IsZoomed($h)
    focused    = ([G]::GetForegroundWindow() -eq $h)
    rect       = @($r.L, $r.T, ($r.R - $r.L), ($r.B - $r.T))
  }
}

# ── 픽셀 표본 ───────────────────────────────────────────────────────────────
# 사이드바 세로 띠를 훑는다. 아크릴이 살아 있으면 벽지가 비쳐 **세로로 값이 변하고**
# 채널이 어긋난다(chroma>0). 폴백 단색이면 띠 전체가 **한 값으로 딱 붙는다**
# (stdev≈0 ∧ r=g=b). 그래서 판정은 "채도"가 아니라 **평탄도 + 무채색**이다 —
# 어두운/무채색 벽지에서도 갈린다(채도만 보면 오탐).
function Get-StripSample([IntPtr]$h) {
  if ([G]::IsIconic($h)) { return $null }
  $r = New-Object G+RECT; [G]::GetWindowRect($h, [ref]$r) | Out-Null
  $w = $r.R - $r.L; $ht = $r.B - $r.T
  if ($w -lt 200 -or $ht -lt 200) { return $null }
  # 사이드바 = 좌측 컬럼. x는 창 왼쪽에서 46px(레일 아이콘을 피한 빈 자리),
  # y는 상단 30% ~ 하단 85% 사이를 24스텝으로.
  $x = $r.L + 46
  $y0 = $r.T + [int]($ht * 0.30); $y1 = $r.T + [int]($ht * 0.85)
  $n = 24
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  if ($x -lt $vs.Left -or $x -ge $vs.Right -or $y0 -lt $vs.Top -or $y1 -ge $vs.Bottom) { return $null }
  $bmp = New-Object System.Drawing.Bitmap 1, ($y1 - $y0)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try { $g.CopyFromScreen($x, $y0, 0, 0, (New-Object System.Drawing.Size(1, ($y1 - $y0)))) }
  catch { $g.Dispose(); $bmp.Dispose(); return $null }
  $g.Dispose()
  $rs = @(); $gs = @(); $bs = @()
  for ($i = 0; $i -lt $n; $i++) {
    $yy = [int](($bmp.Height - 1) * $i / ($n - 1))
    $c = $bmp.GetPixel(0, $yy); $rs += $c.R; $gs += $c.G; $bs += $c.B
  }
  $bmp.Dispose()
  $lum = for ($i = 0; $i -lt $n; $i++) { ($rs[$i] + $gs[$i] + $bs[$i]) / 3.0 }
  $mean = ($lum | Measure-Object -Average).Average
  $sd = [Math]::Sqrt((($lum | ForEach-Object { ($_ - $mean) * ($_ - $mean) } | Measure-Object -Sum).Sum) / $n)
  # 채널 최대 어긋남(무채색이면 0)
  $chroma = 0
  for ($i = 0; $i -lt $n; $i++) {
    $mx = [Math]::Max([Math]::Max($rs[$i], $gs[$i]), $bs[$i])
    $mn = [Math]::Min([Math]::Min($rs[$i], $gs[$i]), $bs[$i])
    if (($mx - $mn) -gt $chroma) { $chroma = $mx - $mn }
  }
  [ordered]@{
    at    = @($x, $y0, $y1)
    mean  = [Math]::Round($mean, 2)
    stdev = [Math]::Round($sd, 3)
    chroma = $chroma
    # 평탄 + 무채색 = DWM이 재질을 안 그리고 단색 폴백을 깔았다는 뜻
    flat  = ($sd -lt 0.75 -and $chroma -le 1)
    head  = "$($rs[0]),$($gs[0]),$($bs[0])"
    tail  = "$($rs[$n-1]),$($gs[$n-1]),$($bs[$n-1])"
  }
}

# ── 액션 ────────────────────────────────────────────────────────────────────
function Emit($obj) {
  $json = $obj | ConvertTo-Json -Depth 8 -Compress
  if ($Out) { Add-Content -Path $Out -Value $json -Encoding UTF8 }
  if (-not $Quiet) { Write-Host $json }
}

switch ($Action) {

  'read' {
    $h = Resolve-Hwnd
    $rec = [ordered]@{
      ts = (Get-Date).ToString('o'); kind = 'read'
      win = (Get-WinState $h); os = (Get-OsState); pixel = (Get-StripSample $h)
    }
    $rec.win.backdropName = $SBT_NAME[[int]$rec.win.backdrop]
    Emit $rec
  }

  # per-window 강제 — **이 hwnd 하나만** 바꾼다. OS 전역 설정은 손대지 않는다.
  # 사용자 증상(아크릴 소실)을 안전하게 만들어 내는 유일한 합법 레버다.
  'force' {
    $h = Resolve-Hwnd
    $before = Get-WinState $h
    $bpx = Get-StripSample $h
    $v = [int]$Backdrop
    $hr = [G]::DwmSetWindowAttribute($h, $DWMWA_SYSTEMBACKDROP_TYPE, [ref]$v, 4)
    Start-Sleep -Milliseconds 450
    $after = Get-WinState $h
    $apx = Get-StripSample $h
    Emit ([ordered]@{
        ts = (Get-Date).ToString('o'); kind = 'force'
        requested = $v; requestedName = $SBT_NAME[$v]; setHr = ('0x{0:X8}' -f $hr)
        before = $before; beforePixel = $bpx
        after = $after; afterPixel = $apx
        os = (Get-OsState)
      })
  }

  # 방어 실측 — 백드롭을 **밖에서 걷어차고** 앱이 스스로 되돌리는 데 걸리는 시간을 잰다.
  # glass.rs의 재단언이 실제로 도는지 가르는 유일한 검사다(코드를 읽어서는 알 수 없다).
  #   -Seconds = 시행 횟수, -Backdrop = 걷어찰 값(1=NONE), -IntervalMs = 폴링 간격
  'knock' {
    $h = Resolve-Hwnd
    $trials = [Math]::Max(1, $Seconds)
    $poll = [Math]::Max(20, $IntervalMs)
    $rows = @()
    for ($i = 1; $i -le $trials; $i++) {
      $v = [int]$Backdrop
      $t0 = [System.Diagnostics.Stopwatch]::StartNew()
      [G]::DwmSetWindowAttribute($h, $DWMWA_SYSTEMBACKDROP_TYPE, [ref]$v, 4) | Out-Null
      # 정말 걷어차였는지 확인 — 안 바뀌었으면 시행 자체가 무효다
      $imm = -1; [G]::DwmGetWindowAttribute($h, $DWMWA_SYSTEMBACKDROP_TYPE, [ref]$imm, 4) | Out-Null
      if ($Nudge) {
        # 0x001A = WM_SETTINGCHANGE. 0x2 = SMTO_ABORTIFHUNG. 이 창 하나에만 보낸다.
        $res = [IntPtr]::Zero
        [G]::SendMessageTimeoutW($h, 0x001A, [IntPtr]::Zero, "ImmersiveColorSet", 2, 1000, [ref]$res) | Out-Null
      }
      $ms = $null
      while ($t0.ElapsedMilliseconds -lt 15000) {
        Start-Sleep -Milliseconds $poll
        $cur = -1; [G]::DwmGetWindowAttribute($h, $DWMWA_SYSTEMBACKDROP_TYPE, [ref]$cur, 4) | Out-Null
        if ($cur -eq 3) { $ms = $t0.ElapsedMilliseconds; break }
      }
      $t0.Stop()
      $rows += [pscustomobject]@{ trial = $i; knockedTo = $v; readBackAfterKnock = $imm; recoveredMs = $ms }
      "{0,2}. {1}(으)로 걷어참 → 즉시 읽기={2} · 복구 {3}" -f $i, $SBT_NAME[$v], $imm, $(if ($null -ne $ms) { "${ms}ms" } else { "실패(15초 안에 안 돌아옴)" }) | Write-Host
      Start-Sleep -Milliseconds $GapMs   # 앞 시행의 단언 열차가 끝날 시간(헤더 주석)
    }
    $oks = $rows | Where-Object { $null -ne $_.recoveredMs }
    $summary = [ordered]@{
      ts = (Get-Date).ToString('o'); kind = 'knock'; hwnd = [int64]$h; trials = $trials
      recovered = $oks.Count
      minMs = $(if ($oks) { ($oks.recoveredMs | Measure-Object -Minimum).Minimum } else { $null })
      maxMs = $(if ($oks) { ($oks.recoveredMs | Measure-Object -Maximum).Maximum } else { $null })
      avgMs = $(if ($oks) { [Math]::Round((($oks.recoveredMs | Measure-Object -Average).Average), 1) } else { $null })
      rows = $rows; os = (Get-OsState)
    }
    Emit $summary
  }

  'shot' {
    $h = Resolve-Hwnd
    $r = New-Object G+RECT; [G]::GetWindowRect($h, [ref]$r) | Out-Null
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $cx = [Math]::Max($r.L, $vs.Left); $cy = [Math]::Max($r.T, $vs.Top)
    $cw = [Math]::Min($r.R, $vs.Right) - $cx; $ch = [Math]::Min($r.B, $vs.Bottom) - $cy
    if ($cw -le 0 -or $ch -le 0) { throw "창이 화면 밖이다 (최소화?)" }
    $bmp = New-Object System.Drawing.Bitmap $cw, $ch
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    # OS 레벨 캡처 — CDP/PrintWindow는 DWM 합성 결과(아크릴)를 담지 못한다.
    $g.CopyFromScreen($cx, $cy, 0, 0, (New-Object System.Drawing.Size($cw, $ch)))
    $g.Dispose()
    $path = if ($Out) { $Out } else { "glass-shot.png" }
    $dir = Split-Path -Parent $path
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
    Write-Host ("shot -> {0}  ({1}x{2})" -f $path, $cw, $ch)
  }

  # 주기 폴링 관측기 — **읽기 전용**. 변화가 있을 때만 줄을 쓴다(+60초 하트비트).
  # 증상이 재발하면 그 순간의 창 상태 + OS 상태가 같은 줄에 남는다.
  'observe' {
    $h = Resolve-Hwnd
    if (-not $Out) { $Out = "glass-observe.jsonl" }
    $dir = Split-Path -Parent $Out
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Write-Host ("observe hwnd={0} pid={1} title='{2}'" -f [int64]$h, $TargetPid, [G]::TitleOf($h))
    Write-Host ("  -> {0}  ({1}초 · {2}ms 간격). Ctrl+C로 중단." -f (Resolve-Path -LiteralPath (Split-Path -Parent $Out) -ErrorAction SilentlyContinue), $Seconds, $IntervalMs)
    $deadline = (Get-Date).AddSeconds($Seconds)
    $prevKey = $null; $lastBeat = [datetime]::MinValue
    Emit ([ordered]@{ ts = (Get-Date).ToString('o'); kind = 'start'; pid = $TargetPid; hwnd = [int64]$h; win = (Get-WinState $h); os = (Get-OsState); pixel = (Get-StripSample $h) })
    while ((Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds $IntervalMs
      if (-not [G]::IsWindow($h)) {
        Emit ([ordered]@{ ts = (Get-Date).ToString('o'); kind = 'window-gone'; hwnd = [int64]$h })
        # 같은 PID가 창을 다시 만들었을 수 있다(크래시 복구) — 재탐색
        if ($TargetPid -gt 0) {
          $h2 = [G]::MainWindowOf([uint32]$TargetPid)
          if ($h2 -ne [IntPtr]::Zero) { $h = $h2; $prevKey = $null; continue }
        }
        break
      }
      $win = Get-WinState $h
      $os = Get-OsState
      $px = Get-StripSample $h
      # 변화 키 — 이 중 하나라도 달라지면 줄을 쓴다.
      # 픽셀은 평탄 판정(flat)만 키에 넣는다(mean은 벽지 애니메이션에 늘 흔들린다).
      $key = "{0}|{1}|{2}|{3}|{4}|{5}|{6}|{7}|{8}|{9}|{10}" -f `
        $win.backdrop, $win.cloaked, $win.minimized, $win.maximized, $win.focused, `
        $os.advancedEffects, $os.regTransparency, $os.dwmComposition, $os.remoteSession, `
        $os.monitors, $(if ($px) { $px.flat } else { 'na' })
      $now = Get-Date
      $beat = ($now - $lastBeat).TotalSeconds -ge 60
      if ($key -ne $prevKey -or $beat) {
        $kind = if ($key -ne $prevKey) { 'change' } else { 'beat' }
        # 유리가 죽은 순간인가 — 두 갈래로 나눠 적는다.
        #  attr-lost  : 우리가 넣어 둔 백드롭 값이 3이 아니게 됐다(누가 되돌렸다)
        #  render-lost: 값은 3인데 화면은 평탄한 단색이다(= DWM이 안 그린다)
        $flags = @()
        if ($win.backdrop -ne 3 -and $win.backdrop -ne -1) { $flags += 'attr-lost' }
        if ($px -and $px.flat -and -not $win.minimized) { $flags += 'render-lost' }
        if ($os.advancedEffects -eq $false) { $flags += 'effects-off' }
        Emit ([ordered]@{ ts = $now.ToString('o'); kind = $kind; flags = $flags; win = $win; os = $os; pixel = $px })
        $prevKey = $key; $lastBeat = $now
      }
    }
    Emit ([ordered]@{ ts = (Get-Date).ToString('o'); kind = 'end' })
  }
}
