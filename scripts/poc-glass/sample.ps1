# 스크린샷 픽셀 표본기 — 유리(아크릴)가 살아 있는지 숫자로 가른다.
#   .\sample.ps1 shot.png            → 사이드바/본문/카드 3점 평균 RGB
#   .\sample.ps1 shot.png -Points "x,y;x,y"
# 눈으로는 "비슷해 보이는" 두 컷도 아크릴이 꺼지면 R/B 채널이 통째로 빠진다.
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$Points = ""
)
Add-Type -AssemblyName System.Drawing
$bmp = [System.Drawing.Bitmap]::FromFile((Resolve-Path $Path))
try {
  $w = $bmp.Width; $h = $bmp.Height
  if ($Points) {
    $pts = @()
    foreach ($p in $Points.Split(';')) { $a = $p.Split(','); $pts += , @([int]$a[0], [int]$a[1], "pt") }
  } else {
    # 사이드바 = 좌측 컬럼(창 폭의 4%)의 세로 중앙 근처 빈 영역
    $pts = @(
      @([int]($w * 0.035), [int]($h * 0.62), "sidebar"),
      @([int]($w * 0.035), [int]($h * 0.72), "sidebar2"),
      @([int]($w * 0.60), [int]($h * 0.95), "chatbody"),
      @([int]($w * 0.90), [int]($h * 0.55), "chatbody2")
    )
  }
  $out = @()
  foreach ($p in $pts) {
    $x = $p[0]; $y = $p[1]; $name = $p[2]
    # 7x7 평균 — 안티앨리어싱/디더 노이즈 제거
    $r = 0; $g = 0; $b = 0; $n = 0
    for ($dx = -3; $dx -le 3; $dx++) {
      for ($dy = -3; $dy -le 3; $dy++) {
        $xx = [Math]::Min([Math]::Max($x + $dx, 0), $w - 1)
        $yy = [Math]::Min([Math]::Max($y + $dy, 0), $h - 1)
        $c = $bmp.GetPixel($xx, $yy)
        $r += $c.R; $g += $c.G; $b += $c.B; $n++
      }
    }
    $out += [pscustomobject]@{
      name = $name; x = $x; y = $y
      R = [Math]::Round($r / $n, 1); G = [Math]::Round($g / $n, 1); B = [Math]::Round($b / $n, 1)
    }
  }
  $out | ForEach-Object { "{0,-10} ({1,4},{2,4})  R={3,5} G={4,5} B={5,5}" -f $_.name, $_.x, $_.y, $_.R, $_.G, $_.B }
} finally { $bmp.Dispose() }
