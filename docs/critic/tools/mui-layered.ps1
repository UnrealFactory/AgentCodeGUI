# "값은 3인데 안 그린다"(render-lost)를 **per-window로** 만들어 보는 레버.
#
# glass.rs는 주석에서 이렇게 단언한다: "값이 3인데 안 그리는 상태가 실재하고, 그때
# 되살리는 유일한 방법이 재기록이다." 그 단언은 검증된 적이 없다 — 빌더의 knock은
# 전부 **속성이 바뀌는**(attr-lost) 경로다. WS_EX_LAYERED를 얹으면 DWM은 시스템 백드롭을
# 안 그리는데 DWMWA_SYSTEMBACKDROP_TYPE 되읽기는 3 그대로다 = 정확히 그 상태다.
#
# 창 하나의 확장 스타일만 만지고 -Off 로 되돌린다. OS 전역 설정과 무관하다.
param(
  [Parameter(Mandatory=$true)][int]$TargetPid,
  [long]$Hwnd = 0,
  [switch]$Off
)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class L {
  public delegate bool EW(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EW cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowLongW(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern int SetWindowLongW(IntPtr h, int i, int v);
  [DllImport("user32.dll")] public static extern bool SetLayeredWindowAttributes(IntPtr h, uint key, byte alpha, uint flags);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int ht, uint f);
  [DllImport("user32.dll")] public static extern bool RedrawWindow(IntPtr h, IntPtr r, IntPtr rgn, uint f);
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
$GWL_EXSTYLE = -20
$WS_EX_LAYERED = 0x00080000
$h = if ($Hwnd -ne 0) { [IntPtr]$Hwnd } else { [L]::MainWindowOf([uint32]$TargetPid) }
if ($h -eq [IntPtr]::Zero) { throw "no window" }
$ex = [L]::GetWindowLongW($h, $GWL_EXSTYLE)
if ($Off) {
  [L]::SetWindowLongW($h, $GWL_EXSTYLE, ($ex -band (-bnot $WS_EX_LAYERED))) | Out-Null
} else {
  [L]::SetWindowLongW($h, $GWL_EXSTYLE, ($ex -bor $WS_EX_LAYERED)) | Out-Null
  [L]::SetLayeredWindowAttributes($h, 0, 255, 0x2) | Out-Null   # LWA_ALPHA, 완전 불투명
}
# 프레임 갱신
[L]::SetWindowPos($h, [IntPtr]::Zero, 0,0,0,0, (0x1 -bor 0x2 -bor 0x4 -bor 0x20)) | Out-Null  # NOSIZE|NOMOVE|NOZORDER|FRAMECHANGED
[L]::RedrawWindow($h, [IntPtr]::Zero, [IntPtr]::Zero, 0x0085) | Out-Null
Start-Sleep -Milliseconds 400
$bd = -1; [L]::DwmGetWindowAttribute($h, 38, [ref]$bd, 4) | Out-Null
$ex2 = [L]::GetWindowLongW($h, $GWL_EXSTYLE)
[pscustomobject]@{ hwnd=[int64]$h; layeredNow=(($ex2 -band $WS_EX_LAYERED) -ne 0); exStyle=('0x{0:X8}' -f $ex2); backdropReadback=$bd } | ConvertTo-Json -Compress
