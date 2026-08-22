# 실험용 보조 창 — 메시지 루프를 돌리는 진짜 폼(정지 화면 아님).
#   -Kind backdrop  : 지정 사각형을 꽉 채우는 단색판(창 뒤에 깔아 '비침'을 잰다)
#   -Kind thief     : 작은 창(포커스를 뺏어 '비활성' 상태를 만든다)
param(
  [string]$Kind = 'backdrop',
  [int]$X = 0, [int]$Y = 0, [int]$W = 2560, [int]$H = 1440,
  [int]$R = 255, [int]$G = 0, [int]$B = 220,
  [int]$Seconds = 300,
  [string]$Title = 'glass-lab'
)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$f = New-Object System.Windows.Forms.Form
$f.Text = $Title
$f.FormBorderStyle = 'None'
$f.BackColor = [System.Drawing.Color]::FromArgb($R, $G, $B)
$f.StartPosition = 'Manual'
$f.Location = New-Object System.Drawing.Point($X, $Y)
$f.Size = New-Object System.Drawing.Size($W, $H)
$f.ShowInTaskbar = ($Kind -eq 'thief')
$f.TopMost = $false
if ($Kind -eq 'thief') {
  $l = New-Object System.Windows.Forms.Label
  $l.Text = 'focus thief'; $l.AutoSize = $true; $l.Location = New-Object System.Drawing.Point(12,12)
  $f.Controls.Add($l)
}
$t = New-Object System.Windows.Forms.Timer
$t.Interval = $Seconds * 1000
$t.Add_Tick({ $f.Close() })
$t.Start()
[System.Windows.Forms.Application]::Run($f)
