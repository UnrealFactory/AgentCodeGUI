# 대상 PID의 보이는 창 전부 + 각 창의 백드롭 값 (읽기 전용).
# 옵션 -KnockHwnd <hwnd> 를 주면 그 창 하나만 걷어차고 복구 시간을 잰다.
param(
  [Parameter(Mandatory=$true)][int]$TargetPid,
  [long]$KnockHwnd = 0,
  [int]$Trials = 4,
  [int]$GapMs = 2500,
  [string]$Json = ""
)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class WN {
  public delegate bool EW(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EW cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int m);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
  [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr h, int a, ref int v, int s);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  public static System.Collections.Generic.List<IntPtr> WindowsOf(uint target) {
    var list = new System.Collections.Generic.List<IntPtr>();
    EnumWindows((h,l)=>{ if(!IsWindowVisible(h)) return true; uint p; GetWindowThreadProcessId(h, out p);
      if(p == target) list.Add(h); return true; }, IntPtr.Zero);
    return list; }
  public static string Title(IntPtr h){ var sb=new StringBuilder(300); GetWindowTextW(h,sb,300); return sb.ToString(); }
}
"@ | Out-Null
$rows = @()
foreach ($h in [WN]::WindowsOf([uint32]$TargetPid)) {
  $r = New-Object WN+RECT; [WN]::GetWindowRect($h, [ref]$r) | Out-Null
  $bd = -1; $hr = [WN]::DwmGetWindowAttribute($h, 38, [ref]$bd, 4)
  $rows += [pscustomobject]@{
    hwnd = [int64]$h; title = [WN]::Title($h); backdrop = $bd; hr = ('0x{0:X8}' -f $hr)
    rect = "$($r.L),$($r.T) $($r.R-$r.L)x$($r.B-$r.T)"
  }
}
$rows | Format-Table -AutoSize | Out-String -Width 200 | Write-Host

$knock = @()
if ($KnockHwnd -ne 0) {
  $h = [IntPtr]$KnockHwnd
  for ($i=1; $i -le $Trials; $i++) {
    $v = 1
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    [WN]::DwmSetWindowAttribute($h, 38, [ref]$v, 4) | Out-Null
    $ms = $null
    while ($sw.ElapsedMilliseconds -lt 15000) {
      Start-Sleep -Milliseconds 25
      $cur = -1; [WN]::DwmGetWindowAttribute($h, 38, [ref]$cur, 4) | Out-Null
      if ($cur -eq 3) { $ms = $sw.ElapsedMilliseconds; break }
    }
    $knock += [pscustomobject]@{ trial=$i; recoveredMs=$ms }
    "knock {0} on hwnd {1} -> {2}" -f $i, $KnockHwnd, $(if($null -ne $ms){"${ms}ms"}else{"FAIL"}) | Write-Host
    Start-Sleep -Milliseconds $GapMs
  }
}
if ($Json) {
  $out = [ordered]@{ ts=(Get-Date).ToString('o'); targetPid=$TargetPid; windows=$rows; knockHwnd=$KnockHwnd; knock=$knock }
  $existing = @()
  if (Test-Path $Json) { try { $existing = @(Get-Content $Json -Raw | ConvertFrom-Json) } catch { $existing = @() } }
  $existing += $out
  $existing | ConvertTo-Json -Depth 6 | Set-Content -Path $Json -Encoding UTF8
}
