Add-Type -AssemblyName System.Drawing, System.Windows.Forms

$pocExe = "d:\D-ASK\D-ASK\src\hud-native\target\debug\inspect_webview2_transparency.exe"
$beforePng = "d:\D-ASK\D-ASK\scratch\subclass_desktop_before.png"
$activePng = "d:\D-ASK\D-ASK\scratch\subclass_desktop_active.png"
$cropPng = "d:\D-ASK\D-ASK\scratch\subclass_window_crop.png"

if (Test-Path $beforePng) { Remove-Item $beforePng -Force }
if (Test-Path $activePng) { Remove-Item $activePng -Force }
if (Test-Path $cropPng) { Remove-Item $cropPng -Force }

Write-Host "=== TEST: Subclassed Background Transparency ==="
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmpBefore = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
$gBefore = [System.Drawing.Graphics]::FromImage($bmpBefore)
$gBefore.CopyFromScreen($screen.X, $screen.Y, 0, 0, $screen.Size)
$bmpBefore.Save($beforePng, [System.Drawing.Imaging.ImageFormat]::Png)
$gBefore.Dispose()
Write-Host "Captured desktop baseline: $beforePng"

$proc = Start-Process -FilePath $pocExe -PassThru -NoNewWindow
Start-Sleep -Milliseconds 1800

Write-Host "Capturing active desktop with subclassed window..."
$bmpActive = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
$gActive = [System.Drawing.Graphics]::FromImage($bmpActive)
$gActive.CopyFromScreen($screen.X, $screen.Y, 0, 0, $screen.Size)
$bmpActive.Save($activePng, [System.Drawing.Imaging.ImageFormat]::Png)
$gActive.Dispose()

$proc.WaitForExit(4000)

$winLeft = 125
$winTop = 125
$winWidth = 600
$winHeight = 650

$cropBmp = New-Object System.Drawing.Bitmap($winWidth, $winHeight)
$gCrop = [System.Drawing.Graphics]::FromImage($cropBmp)
$gCrop.DrawImage($bmpActive, 0, 0, (New-Object System.Drawing.Rectangle($winLeft, $winTop, $winWidth, $winHeight)), [System.Drawing.GraphicsUnit]::Pixel)
$cropBmp.Save($cropPng, [System.Drawing.Imaging.ImageFormat]::Png)
$gCrop.Dispose()
$cropBmp.Dispose()
Write-Host "Saved window crop to $cropPng"

$corners = @(
    @{ X = $winLeft + 25; Y = $winTop + 25; Name = "Top-Left Corner" },
    @{ X = $winLeft + $winWidth - 25; Y = $winTop + 25; Name = "Top-Right Corner" },
    @{ X = $winLeft + 25; Y = $winTop + $winHeight - 25; Name = "Bottom-Left Corner" },
    @{ X = $winLeft + $winWidth - 25; Y = $winTop + $winHeight - 25; Name = "Bottom-Right Corner" }
)

foreach ($c in $corners) {
    $pBefore = $bmpBefore.GetPixel($c.X, $c.Y)
    $pActive = $bmpActive.GetPixel($c.X, $c.Y)
    $isMatch = ($pBefore.ToArgb() -eq $pActive.ToArgb())
    $isBlack = ($pActive.R -eq 0 -and $pActive.G -eq 0 -and $pActive.B -eq 0)
    
    Write-Host "  $($c.Name) at ($($c.X), $($c.Y)):"
    Write-Host "    Desktop Baseline RGB: ($($pBefore.R), $($pBefore.G), $($pBefore.B))"
    Write-Host "    Active Window RGB:    ($($pActive.R), $($pActive.G), $($pActive.B))"
    Write-Host "    Is Black Box:         $isBlack"
    Write-Host "    Desktop Shows Through: $isMatch"
}

$centerX = $winLeft + [int]($winWidth / 2)
$centerY = $winTop + [int]($winHeight / 2) - 20
$pCenterBefore = $bmpBefore.GetPixel($centerX, $centerY)
$pCenterActive = $bmpActive.GetPixel($centerX, $centerY)
Write-Host "`n  Orb Core at ($centerX, $centerY):"
Write-Host "    Baseline Desktop RGB: ($($pCenterBefore.R), $($pCenterBefore.G), $($pCenterBefore.B))"
Write-Host "    Active Orb Core RGB:  ($($pCenterActive.R), $($pCenterActive.G), $($pCenterActive.B))"

$bmpBefore.Dispose()
$bmpActive.Dispose()

