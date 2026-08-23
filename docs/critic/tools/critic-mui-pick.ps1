# 캡처의 특정 좌표 픽셀 색을 읽는다. -Points "x,y;x,y;..."
param([string]$Src, [string]$Points)
Add-Type -AssemblyName System.Drawing
$bmp = [System.Drawing.Bitmap]::FromFile((Resolve-Path $Src).Path)
foreach ($p in $Points.Split(';')) {
  $xy = $p.Split(',')
  $c = $bmp.GetPixel([int]$xy[0], [int]$xy[1])
  "{0},{1} = {2},{3},{4}" -f $xy[0], $xy[1], $c.R, $c.G, $c.B
}
$bmp.Dispose()
