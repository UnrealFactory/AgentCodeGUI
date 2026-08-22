# 프로세스 트리 CPU — **사이클 카운터**로 잰다.
#
# 왜 TotalProcessorTime이 아닌가: 프로세스 시간은 스케줄러 틱(15.6ms) 단위로만 적산돼,
# 700ms마다 DWM 호출 두 번 같은 소비는 60초를 재도 0ms로 나온다(실측 — 판정 불가).
# QueryProcessCycleTime은 실제 소비 사이클을 돌려주므로 "무시할 만하다"를 수치로 말할 수 있다.
param(
  [Parameter(Mandatory=$true)][int]$TargetPid,
  [int]$Seconds = 60,
  [string]$Tag = "idle",
  [string]$Json = "docs/critic/mui-r1-cpu.json",
  [double]$GHz = 3.0
)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System; using System.Runtime.InteropServices;
public class C {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint a, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool QueryProcessCycleTime(IntPtr h, out ulong cycles);
  public static long Cycles(int pid) {
    IntPtr h = OpenProcess(0x1000, false, (uint)pid);   // PROCESS_QUERY_LIMITED_INFORMATION
    if (h == IntPtr.Zero) return -1;
    ulong c; bool ok = QueryProcessCycleTime(h, out c); CloseHandle(h);
    return ok ? (long)c : -1;
  }
}
"@ | Out-Null
function TreePids([int]$root) {
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
  $set = New-Object System.Collections.Generic.HashSet[int]
  [void]$set.Add($root)
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($p in $all) { if ($set.Contains([int]$p.ParentProcessId) -and -not $set.Contains([int]$p.ProcessId)) { [void]$set.Add([int]$p.ProcessId); $changed = $true } }
  }
  return @($set)
}
function Snap([int[]]$pids) {
  $m = @{}
  foreach ($id in $pids) { $c = [C]::Cycles($id); if ($c -ge 0) { $m[$id] = $c } }
  return $m
}
$pids = TreePids $TargetPid
$names = @{}
foreach ($id in $pids) { try { $names[$id] = (Get-Process -Id $id -ErrorAction Stop).ProcessName } catch {} }
$a = Snap $pids
$sw = [System.Diagnostics.Stopwatch]::StartNew()
Start-Sleep -Seconds $Seconds
$b = Snap $pids
$sw.Stop()
$elapsed = $sw.Elapsed.TotalMilliseconds
$rows = @()
foreach ($id in $b.Keys) {
  $d = $b[$id] - $(if ($a.ContainsKey($id)) { $a[$id] } else { 0 })
  $ms = $d / ($GHz * 1e6)
  $rows += [pscustomobject]@{
    pid = $id; name = $names[$id]; cycles = $d
    approxMs = [Math]::Round($ms, 2); pctOneCore = [Math]::Round(100.0 * $ms / $elapsed, 4)
  }
}
$rows = $rows | Sort-Object -Property cycles -Descending
$sumC = ($rows | Measure-Object -Property cycles -Sum).Sum
$sumMs = $sumC / ($GHz * 1e6)
$out = [ordered]@{
  ts = (Get-Date).ToString('o'); tag = $Tag; targetPid = $TargetPid
  elapsedMs = [Math]::Round($elapsed,0); ghzAssumed = $GHz; procs = $rows.Count
  totalCycles = $sumC; totalApproxMs = [Math]::Round($sumMs,2)
  totalPctOneCore = [Math]::Round(100.0*$sumMs/$elapsed, 4)
  mainOnlyCycles = ($rows | Where-Object { $_.pid -eq $TargetPid }).cycles
  perProc = $rows
}
$existing = @()
if (Test-Path $Json) { try { $existing = @(Get-Content $Json -Raw | ConvertFrom-Json) } catch { $existing = @() } }
$existing += $out
$existing | ConvertTo-Json -Depth 6 | Set-Content -Path $Json -Encoding UTF8
$out | ConvertTo-Json -Depth 2 -Compress | Write-Host
