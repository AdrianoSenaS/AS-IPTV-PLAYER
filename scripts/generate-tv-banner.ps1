$ErrorActionPreference = 'Stop'

try {
  [void][Reflection.Assembly]::LoadWithPartialName('System.Drawing')

  $root = Split-Path $PSScriptRoot -Parent
  $iconPath = Join-Path $root 'assets\images\icon.png'
  $outPath = Join-Path $root 'assets\images\tv-banner-320x180.png'

  $bmp = New-Object System.Drawing.Bitmap 320,180
  $graphics = [System.Drawing.Graphics]::FromImage($bmp)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

  $rect = New-Object System.Drawing.Rectangle 0,0,320,180
  $bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, ([System.Drawing.Color]::FromArgb(255,5,7,15)), ([System.Drawing.Color]::FromArgb(255,15,23,38)), 0
  $accentBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,255,122,24))
  $orbBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(120,255,59,48))
  $whiteBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,248,250,252))
  $mutedBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,177,185,196))
  $badgeBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,255,143,58))

  $titleFont = New-Object System.Drawing.Font('Segoe UI', 26, [System.Drawing.FontStyle]::Bold)
  $subtitleFont = New-Object System.Drawing.Font('Segoe UI', 12, [System.Drawing.FontStyle]::Regular)
  $captionFont = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)

  $graphics.FillRectangle($bgBrush, $rect)
  $graphics.FillRectangle($accentBrush, 0, 0, 320, 16)
  $graphics.FillEllipse($orbBrush, 220, 50, 110, 110)

  if (Test-Path $iconPath) {
    $icon = [System.Drawing.Image]::FromFile($iconPath)
    $graphics.DrawImage($icon, 24, 42, 74, 74)
    $icon.Dispose()
  }

  $graphics.DrawString('AS XSTREAM', $titleFont, $whiteBrush, 112, 48)
  $graphics.DrawString('IPTV PARA ANDROID TV', $captionFont, $badgeBrush, 114, 84)
  $graphics.DrawString('Streaming otimizado para TV, TV Box e tablet', $subtitleFont, $mutedBrush, 26, 132)

  $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)

  $titleFont.Dispose()
  $subtitleFont.Dispose()
  $captionFont.Dispose()
  $whiteBrush.Dispose()
  $mutedBrush.Dispose()
  $badgeBrush.Dispose()
  $orbBrush.Dispose()
  $accentBrush.Dispose()
  $bgBrush.Dispose()
  $graphics.Dispose()
  $bmp.Dispose()

  Write-Output "OK: $outPath"
}
catch {
  Write-Output "ERROR: $($_.Exception.Message)"
  exit 1
}
