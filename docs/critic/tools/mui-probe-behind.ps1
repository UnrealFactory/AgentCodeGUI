# 디버그 — 배경판이 정말 창 뒤에 들어갔는지 전체 화면 캡처로 확인한다(읽기 전용 + 내 창만).
param([Parameter(Mandatory=$true)][int]$TargetPid, [string]$Out = "docs/critic/shots/probe-behind.png", [int]$WaitMs = 1500)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Drawing @"
using System; using System.Drawing; using System.Drawing.Imaging; using System.Runtime.InteropServices;
public class Q {
  public delegate bool EW(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EW cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int ht, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  public static IntPtr MainWindowOf(uint target) {
    IntPtr best = IntPtr.Zero; long bestArea = -1;
    EnumWindows((h,l)=>{ if(!IsWindowVisible(h)) return true; uint p; GetWindowThreadProcessId(h, out p);
      if(p != target) return true; RECT r; GetWindowRect(h, out r);
      long a = (long)(r.R-r.L)*(r.B-r.T); if(a > bestArea){ bestArea = a; best = h; } return true; }, IntPtr.Zero);
    return best; }
  public static void Shot(int x,int y,int w,int h,string path){
    Bitmap b = new Bitmap(w,h,PixelFormat.Format32bppArgb);
    using(Graphics g = Graphics.FromImage(b)) g.CopyFromScreen(x,y,0,0,new Size(w,h));
    b.Save(path, ImageFormat.Png); b.Dispose(); }
}
"@ | Out-Null
$hwnd = [Q]::MainWindowOf([uint32]$TargetPid)
$r = New-Object Q+RECT; [Q]::GetWindowRect($hwnd, [ref]$r) | Out-Null
$pad = 30
$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle='None'; $form.StartPosition='Manual'
$form.Location = New-Object System.Drawing.Point (($r.L-$pad), ($r.T-$pad))
$form.Size = New-Object System.Drawing.Size ((($r.R-$r.L)+$pad*2), (($r.B-$r.T)+$pad*2))
$form.ShowInTaskbar=$false
$form.Add_Paint({ param($s,$e)
  $br = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,255,0,170))
  $e.Graphics.FillRectangle($br,0,0,$s.ClientSize.Width,$s.ClientSize.Height); $br.Dispose() })
$form.Show()
[Q]::SetWindowPos($form.Handle, $hwnd, 0,0,0,0, (0x2 -bor 0x1 -bor 0x10)) | Out-Null
$end=(Get-Date).AddMilliseconds($WaitMs); while((Get-Date) -lt $end){ [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 15 }
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$dir = Split-Path -Parent $Out; if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
[Q]::Shot($vs.Left, $vs.Top, $vs.Width, $vs.Height, (Join-Path (Get-Location) $Out))
$form.Close()
"shot -> $Out  (win rect {0},{1} {2}x{3})" -f $r.L,$r.T,($r.R-$r.L),($r.B-$r.T) | Write-Host
