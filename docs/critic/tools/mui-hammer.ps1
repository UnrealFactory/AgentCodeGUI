# 적대 루프 — 백드롭을 계속 걷어차 방어가 이기지 못하게 한다.
# 목적 (크리틱): 재단언 폭주·이벤트 폭주·CPU 폭주가 나는지, 공격이 끝나면 스스로 복구하는지.
# per-window DWM 속성 하나만 만진다(OS 전역 설정 무관). 대상은 **내가 띄운 PID**뿐.
param(
  [Parameter(Mandatory=$true)][int]$TargetPid,
  [int]$Seconds = 30,
  [int]$EveryMs = 25,
  [int]$Backdrop = 1,
  [switch]$Nudge,
  [string]$Json = "docs/critic/mui-r1-hammer.json"
)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class HM {
  public delegate bool EW(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EW cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeoutW(IntPtr h, uint msg, IntPtr wp, string lp, uint flags, uint ms, out IntPtr res);
  [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr h, int a, ref int v, int s);
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
$h = [HM]::MainWindowOf([uint32]$TargetPid)
if ($h -eq [IntPtr]::Zero) { throw "no window for pid $TargetPid" }
$end = (Get-Date).AddSeconds($Seconds)
$kicks = 0; $foundThree = 0; $reads = 0
$v = [int]$Backdrop
while ((Get-Date) -lt $end) {
  [HM]::DwmSetWindowAttribute($h, 38, [ref]$v, 4) | Out-Null
  $kicks++
  if ($Nudge) {
    $res = [IntPtr]::Zero
    [HM]::SendMessageTimeoutW($h, 0x001A, [IntPtr]::Zero, "ImmersiveColorSet", 2, 200, [ref]$res) | Out-Null
  }
  Start-Sleep -Milliseconds $EveryMs
  $cur = -1; [HM]::DwmGetWindowAttribute($h, 38, [ref]$cur, 4) | Out-Null
  $reads++
  if ($cur -eq 3) { $foundThree++ }
}
# 공격을 멈춘 뒤 스스로 3으로 돌아오는가
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$recovered = $null
while ($sw.ElapsedMilliseconds -lt 15000) {
  Start-Sleep -Milliseconds 25
  $cur = -1; [HM]::DwmGetWindowAttribute($h, 38, [ref]$cur, 4) | Out-Null
  if ($cur -eq 3) { $recovered = $sw.ElapsedMilliseconds; break }
}
$out = [ordered]@{
  ts = (Get-Date).ToString('o'); targetPid = $TargetPid; hwnd = [int64]$h
  seconds = $Seconds; everyMs = $EveryMs; nudge = [bool]$Nudge
  kicks = $kicks; reads = $reads; readBackWasThree = $foundThree
  recoveredAfterAttackMs = $recovered
}
$existing = @()
if (Test-Path $Json) { try { $existing = @(Get-Content $Json -Raw | ConvertFrom-Json) } catch { $existing = @() } }
$existing += $out
$existing | ConvertTo-Json -Depth 4 | Set-Content -Path $Json -Encoding UTF8
$out | ConvertTo-Json -Compress | Write-Host
