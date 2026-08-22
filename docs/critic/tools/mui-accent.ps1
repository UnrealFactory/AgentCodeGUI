# per-window 합성 속성 공격 — SetWindowCompositionAttribute(WCA_ACCENT_POLICY).
# ui-glass.md U9("다른 앱이 우리 창에 SetWindowCompositionAttribute 등을 건다 → 드리프트 감지로
# 덮인다고 가정")를 실제로 시험한다. 이 API는 DWMWA_SYSTEMBACKDROP_TYPE와 **다른 축**이라
# 되읽기는 3 그대로일 수 있다 = 방어의 사각(값은 3, 안 그림)을 만드는지 보는 것.
#   -State 0(DISABLED) 1(GRADIENT) 3(BLURBEHIND) 4(ACRYLICBLURBEHIND) 5(HOSTBACKDROP) 6(DISABLED_2)
param(
  [Parameter(Mandatory=$true)][int]$TargetPid,
  [long]$Hwnd = 0,
  [int]$State = 0,
  [uint32]$GradientColor = 0
)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class AC {
  public delegate bool EW(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EW cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
  [DllImport("user32.dll")] public static extern int SetWindowCompositionAttribute(IntPtr hwnd, ref WINCOMPATTRDATA data);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  [StructLayout(LayoutKind.Sequential)] public struct ACCENTPOLICY { public int nAccentState, nFlags; public uint nColor; public int nAnimationId; }
  [StructLayout(LayoutKind.Sequential)] public struct WINCOMPATTRDATA { public int nAttribute; public IntPtr pData; public int ulDataSize; }
  public static IntPtr MainWindowOf(uint target) {
    IntPtr best = IntPtr.Zero; long bestArea = -1;
    EnumWindows((h,l)=>{ if(!IsWindowVisible(h)) return true; uint p; GetWindowThreadProcessId(h, out p);
      if(p != target) return true; RECT r; GetWindowRect(h, out r);
      long a = (long)(r.R-r.L)*(r.B-r.T); if(a > bestArea){ bestArea = a; best = h; } return true; }, IntPtr.Zero);
    return best; }
  public static int SetAccent(IntPtr h, int state, uint color) {
    ACCENTPOLICY p = new ACCENTPOLICY(); p.nAccentState = state; p.nFlags = 2; p.nColor = color; p.nAnimationId = 0;
    int sz = Marshal.SizeOf(p); IntPtr mem = Marshal.AllocHGlobal(sz); Marshal.StructureToPtr(p, mem, false);
    WINCOMPATTRDATA d = new WINCOMPATTRDATA(); d.nAttribute = 19; d.pData = mem; d.ulDataSize = sz;  // WCA_ACCENT_POLICY
    int r = SetWindowCompositionAttribute(h, ref d);
    Marshal.FreeHGlobal(mem); return r; }
}
"@ | Out-Null
$h = if ($Hwnd -ne 0) { [IntPtr]$Hwnd } else { [AC]::MainWindowOf([uint32]$TargetPid) }
if ($h -eq [IntPtr]::Zero) { throw "no window" }
$r = [AC]::SetAccent($h, $State, $GradientColor)
Start-Sleep -Milliseconds 500
$bd = -1; [AC]::DwmGetWindowAttribute($h, 38, [ref]$bd, 4) | Out-Null
[pscustomobject]@{ hwnd=[int64]$h; accentState=$State; apiResult=$r; backdropReadback=$bd } | ConvertTo-Json -Compress
