# 유리(아크릴) 실험용 Win32 헬퍼 — 한 번에 한 명령.
#   powershell -NoProfile -ExecutionPolicy Bypass -File glass-native.ps1 <cmd> [args...]
#
# cmd:
#   hwnd <pid>                    가장 큰 가시 창 HWND (10진)
#   rect <hwnd>                   {l,t,r,b}
#   place <hwnd> <x> <y> <w> <h>  이동/크기 (활성화 없음)
#   bottom <hwnd>                 z 최하단으로 (활성화 없음)
#   focus <hwnd>                  전경으로 (AttachThreadInput 패턴) → 결과 fg hwnd 반환
#   fg                            현재 전경 창 hwnd
#   show <hwnd> <n>               ShowWindow (3=최대화 9=복원 6=최소화 1=보통)
#   dwmget <hwnd> <attr>          DwmGetWindowAttribute (int)
#   dwmset <hwnd> <attr> <val>    DwmSetWindowAttribute (int)
#   style <hwnd>                  GWL_STYLE/EXSTYLE (16진)
#   grab <file> <x> <y> <w> <h>   화면 영역 캡처 → PNG
#   avg <file> <x> <y> <w> <h>    PNG 안 사각형 평균 RGB
#   cols <file> <y> <h> <x0> <x1> x 축 1px 열별 평균(사이드바 경계 찾기용)
param([Parameter(Position=0)][string]$cmd, [Parameter(ValueFromRemainingArguments=$true)][string[]]$rest)

Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class N {
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
  [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int val, int size);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  public static IntPtr MainOf(uint target){
    IntPtr best=IntPtr.Zero; int bestArea=0;
    EnumWindows((h,l)=>{
      if(!IsWindowVisible(h)) return true;
      uint p; GetWindowThreadProcessId(h,out p);
      if(p!=target) return true;
      RECT r; GetWindowRect(h,out r);
      int a=(r.Right-r.Left)*(r.Bottom-r.Top);
      if(a>bestArea){ bestArea=a; best=h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
  public static bool Focus(IntPtr h){
    IntPtr fg = GetForegroundWindow();
    uint dummy = 0;
    uint t1 = GetWindowThreadProcessId(fg, out dummy);
    uint t2 = GetCurrentThreadId();
    AttachThreadInput(t1, t2, true);
    BringWindowToTop(h);
    bool ok = SetForegroundWindow(h);
    AttachThreadInput(t1, t2, false);
    return ok;
  }
}
"@

function J($o) { $o | ConvertTo-Json -Compress -Depth 5 }

switch ($cmd) {
  'hwnd'   { [int64][N]::MainOf([uint32]$rest[0]) }
  'fg'     { [int64][N]::GetForegroundWindow() }
  'at'     { $p=New-Object N+POINT; $p.X=[int]$rest[0]; $p.Y=[int]$rest[1]; [int64][N]::GetAncestor([N]::WindowFromPoint($p),2) }
  'title'  { $n=[N]::GetWindowTextLength([IntPtr][int64]$rest[0]); $sb=New-Object System.Text.StringBuilder ($n+1); [void][N]::GetWindowText([IntPtr][int64]$rest[0],$sb,$n+1); $sb.ToString() }
  'rect'   { $r=New-Object N+RECT; [void][N]::GetWindowRect([IntPtr][int64]$rest[0],[ref]$r); J @{l=$r.Left;t=$r.Top;r=$r.Right;b=$r.Bottom;w=$r.Right-$r.Left;h=$r.Bottom-$r.Top} }
  # SWP_NOACTIVATE(0x10) | SWP_NOZORDER(0x4)
  'place'  { [void][N]::SetWindowPos([IntPtr][int64]$rest[0],[IntPtr]::Zero,[int]$rest[1],[int]$rest[2],[int]$rest[3],[int]$rest[4],0x14); 'ok' }
  # HWND_BOTTOM(1) + SWP_NOACTIVATE|SWP_NOMOVE(0x2)|SWP_NOSIZE(0x1)
  'bottom' { [void][N]::SetWindowPos([IntPtr][int64]$rest[0],[IntPtr]1,0,0,0,0,0x13); 'ok' }
  'top'    { [void][N]::SetWindowPos([IntPtr][int64]$rest[0],[IntPtr]0,0,0,0,0,0x13); 'ok' }
  'focus'  { [void][N]::Focus([IntPtr][int64]$rest[0]); Start-Sleep -Milliseconds 60; [int64][N]::GetForegroundWindow() }
  'show'   { [void][N]::ShowWindow([IntPtr][int64]$rest[0],[int]$rest[1]); 'ok' }
  'style'  { $s=[N]::GetWindowLong([IntPtr][int64]$rest[0],-16); $e=[N]::GetWindowLong([IntPtr][int64]$rest[0],-20); J @{style=('0x{0:X8}' -f $s); ex=('0x{0:X8}' -f $e)} }
  'dwmget' { $v=0; $hr=[N]::DwmGetWindowAttribute([IntPtr][int64]$rest[0],[int]$rest[1],[ref]$v,4); J @{hr=$hr; val=$v} }
  'dwmset' { $v=[int]$rest[2]; $hr=[N]::DwmSetWindowAttribute([IntPtr][int64]$rest[0],[int]$rest[1],[ref]$v,4); J @{hr=$hr} }
  'grab'   {
    Add-Type -AssemblyName System.Drawing
    $bmp=New-Object System.Drawing.Bitmap ([int]$rest[3]),([int]$rest[4])
    $g=[System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen([int]$rest[1],[int]$rest[2],0,0,$bmp.Size)
    $bmp.Save($rest[0],[System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose(); 'ok'
  }
  'avg'    {
    Add-Type -AssemblyName System.Drawing
    $bmp=[System.Drawing.Bitmap]::FromFile($rest[0])
    $x=[int]$rest[1]; $y=[int]$rest[2]; $w=[int]$rest[3]; $h=[int]$rest[4]
    $r=0;$g=0;$b=0;$n=0
    for($i=$x;$i -lt $x+$w -and $i -lt $bmp.Width;$i+=2){ for($j=$y;$j -lt $y+$h -and $j -lt $bmp.Height;$j+=2){
      $p=$bmp.GetPixel($i,$j); $r+=$p.R;$g+=$p.G;$b+=$p.B;$n++ } }
    $bmp.Dispose()
    J @{r=[math]::Round($r/$n,2); g=[math]::Round($g/$n,2); b=[math]::Round($b/$n,2); n=$n}
  }
  'cols'   {
    Add-Type -AssemblyName System.Drawing
    $bmp=[System.Drawing.Bitmap]::FromFile($rest[0])
    $y=[int]$rest[1]; $h=[int]$rest[2]; $x0=[int]$rest[3]; $x1=[int]$rest[4]
    $out=@()
    for($i=$x0;$i -lt $x1 -and $i -lt $bmp.Width;$i++){
      $r=0;$g=0;$b=0;$n=0
      for($j=$y;$j -lt $y+$h -and $j -lt $bmp.Height;$j+=3){ $p=$bmp.GetPixel($i,$j); $r+=$p.R;$g+=$p.G;$b+=$p.B;$n++ }
      $out += ,@([math]::Round($r/$n,1),[math]::Round($g/$n,1),[math]::Round($b/$n,1))
    }
    $bmp.Dispose(); J $out
  }
  default  { "unknown cmd: $cmd"; exit 1 }
}
