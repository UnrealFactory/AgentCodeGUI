# 캡처에서 사각형을 오려 확대 저장한다 (블라인드 항목별 판정용).
#   -Src a.png -X 330 -Y 80 -W 900 -H 70 -Scale 2 -OutPath out.png
# 두 장을 세로로 붙이려면 -Src2/-Y2를 준다(위=Src, 아래=Src2 · 같은 X/W/H).
param([string]$Src, [string]$Src2 = '', [int]$X, [int]$Y, [int]$Y2 = -1, [int]$W, [int]$H, [double]$Scale = 2, [int]$Gap = 10, [string]$OutPath)
Add-Type -AssemblyName System.Drawing

function Get-Crop([string]$p, [int]$sx, [int]$sy, [int]$sw, [int]$sh, [double]$sc) {
  $bmp = [System.Drawing.Bitmap]::FromFile((Resolve-Path $p).Path)
  $nw = [int]($sw * $sc); $nh = [int]($sh * $sc)
  $dst = New-Object System.Drawing.Bitmap($nw, $nh)
  $gg = [System.Drawing.Graphics]::FromImage($dst)
  $gg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
  $gg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
  $dr = New-Object System.Drawing.Rectangle(0, 0, $nw, $nh)
  $gg.DrawImage($bmp, $dr, $sx, $sy, $sw, $sh, [System.Drawing.GraphicsUnit]::Pixel)
  $gg.Dispose(); $bmp.Dispose()
  return $dst
}

$topBmp = Get-Crop $Src $X $Y $W $H $Scale
if ($Src2) {
  $yy = if ($Y2 -ge 0) { $Y2 } else { $Y }
  $botBmp = Get-Crop $Src2 $X $yy $W $H $Scale
  $canvas = New-Object System.Drawing.Bitmap($topBmp.Width, ($topBmp.Height + $Gap + $botBmp.Height))
  $gc = [System.Drawing.Graphics]::FromImage($canvas)
  $gc.Clear([System.Drawing.Color]::FromArgb(255, 90, 90, 105))
  $gc.DrawImage($topBmp, 0, 0)
  $gc.DrawImage($botBmp, 0, ($topBmp.Height + $Gap))
  $gc.Dispose(); $botBmp.Dispose(); $topBmp.Dispose()
  $canvas.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
  "$OutPath ($($canvas.Width) x $($canvas.Height))"
  $canvas.Dispose()
} else {
  $topBmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
  "$OutPath ($($topBmp.Width) x $($topBmp.Height))"
  $topBmp.Dispose()
}
