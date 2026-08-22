# M-UI R1 크리틱 — 격리 홈으로 3.0 셸을 띄우고 PID/HWND를 돌려준다.
# 사용자 실앱을 건드리지 않기 위해 **내가 띄운 PID만** 파일에 남긴다.
param(
  [string]$HomeDir = ".mui-home",
  [string]$ForceOff = "",
  [string]$Chrome = "",
  [int]$CdpPort = 0,
  [string]$PidFile = "docs/critic/tools/.mui-pid"
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path "$PSScriptRoot\..\..\..").Path
$exe = Join-Path $repo "target\release\agentcodegui.exe"
if (-not (Test-Path $exe)) { throw "no exe: $exe" }
$env:CCG_HOME = $HomeDir
if ($ForceOff) { $env:CCG_GLASS_FORCE_OFF = $ForceOff } else { Remove-Item Env:CCG_GLASS_FORCE_OFF -ErrorAction SilentlyContinue }
if ($Chrome) { $env:CCG_CHROME = $Chrome } else { Remove-Item Env:CCG_CHROME -ErrorAction SilentlyContinue }
if ($CdpPort -gt 0) { $env:CCG_CDP_PORT = "$CdpPort" } else { Remove-Item Env:CCG_CDP_PORT -ErrorAction SilentlyContinue }
$p = Start-Process -FilePath $exe -WorkingDirectory $repo -PassThru
Add-Content -Path (Join-Path $repo $PidFile) -Value $p.Id
# 창이 뜰 때까지 대기
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class W {
  public delegate bool EW(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EW cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  public static IntPtr MainWindowOf(uint target) {
    IntPtr best = IntPtr.Zero; long bestArea = -1;
    EnumWindows((h,l)=>{ if(!IsWindowVisible(h)) return true; uint p; GetWindowThreadProcessId(h, out p);
      if(p != target) return true; RECT r; GetWindowRect(h, out r);
      long a = (long)(r.R-r.L)*(r.B-r.T); if(a > bestArea){ bestArea = a; best = h; } return true; }, IntPtr.Zero);
    return best; }
}
"@ | Out-Null
$h = [IntPtr]::Zero
$sw = [System.Diagnostics.Stopwatch]::StartNew()
while ($sw.ElapsedMilliseconds -lt 40000) {
  Start-Sleep -Milliseconds 250
  $h = [W]::MainWindowOf([uint32]$p.Id)
  if ($h -ne [IntPtr]::Zero) { break }
}
$bd = -1; if ($h -ne [IntPtr]::Zero) { [W]::DwmGetWindowAttribute($h, 38, [ref]$bd, 4) | Out-Null }
[pscustomobject]@{ pid = $p.Id; hwnd = [int64]$h; visibleAfterMs = $sw.ElapsedMilliseconds; backdrop = $bd } | ConvertTo-Json -Compress
