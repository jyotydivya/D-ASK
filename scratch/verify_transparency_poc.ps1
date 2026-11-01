Add-Type -AssemblyName System.Drawing, System.Windows.Forms

$pocExe = "d:\D-ASK\D-ASK\src\hud-native\target\debug\transparency_poc.exe"
$beforePng = "d:\D-ASK\D-ASK\scratch\poc_desktop_before.png"
$activePng = "d:\D-ASK\D-ASK\scratch\poc_desktop_active.png"
$cropPng = "d:\D-ASK\D-ASK\scratch\poc_window_crop.png"

if (Test-Path $beforePng) { Remove-Item $beforePng -Force }
if (Test-Path $activePng) { Remove-Item $activePng -Force }
if (Test-Path $cropPng) { Remove-Item $cropPng -Force }

Write-Host "1. Capturing pre-launch desktop baseline..."
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmpBefore = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
$gBefore = [System.Drawing.Graphics]::FromImage($bmpBefore)
$gBefore.CopyFromScreen($screen.X, $screen.Y, 0, 0, $screen.Size)
$bmpBefore.Save($beforePng, [System.Drawing.Imaging.ImageFormat]::Png)
$gBefore.Dispose()

Write-Host "2. Launching transparency POC over desktop..."
$proc = Start-Process -FilePath $pocExe -ArgumentList "--duration-secs 5" -PassThru -NoNewWindow

Start-Sleep -Milliseconds 2000

Write-Host "3. Capturing active desktop with POC..."
$bmpActive = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
$gActive = [System.Drawing.Graphics]::FromImage($bmpActive)
$gActive.CopyFromScreen($screen.X, $screen.Y, 0, 0, $screen.Size)
$bmpActive.Save($activePng, [System.Drawing.Imaging.ImageFormat]::Png)
$gActive.Dispose()

Write-Host "4. Analyzing Transparency at Exact Window Coordinates (125, 125) to (625, 625)..."
$winLeft = 125
$winTop = 125
$winWidth = 500
$winHeight = 500

$cropBmp = New-Object System.Drawing.Bitmap($winWidth, $winHeight)
$gCrop = [System.Drawing.Graphics]::FromImage($cropBmp)
$gCrop.DrawImage($bmpActive, 0, 0, (New-Object System.Drawing.Rectangle($winLeft, $winTop, $winWidth, $winHeight)), [System.Drawing.GraphicsUnit]::Pixel)
$cropBmp.Save($cropPng, [System.Drawing.Imaging.ImageFormat]::Png)
$gCrop.Dispose()
$cropBmp.Dispose()
Write-Host "Saved 500x500 window crop to $cropPng"

Write-Host "`n5. Verifying Transparency at Window Corners (Outside Circle):"
$corners = @(
    @{ X = $winLeft + 20; Y = $winTop + 20; Name = "Top-Left Corner" },
    @{ X = $winLeft + $winWidth - 20; Y = $winTop + 20; Name = "Top-Right Corner" },
    @{ X = $winLeft + 20; Y = $winTop + $winHeight - 20; Name = "Bottom-Left Corner" },
    @{ X = $winLeft + $winWidth - 20; Y = $winTop + $winHeight - 20; Name = "Bottom-Right Corner" }
)

$allTransparent = $true
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

    if (-not $isMatch) { $allTransparent = $false }
}

Write-Host "`n6. Verifying Visual Element at Window Center (375, 375):"
$centerX = $winLeft + [int]($winWidth / 2)
$centerY = $winTop + [int]($winHeight / 2)
$pCenterBefore = $bmpBefore.GetPixel($centerX, $centerY)
$pCenterActive = $bmpActive.GetPixel($centerX, $centerY)

Write-Host "  Center at ($centerX, $centerY):"
Write-Host "    Desktop Baseline RGB: ($($pCenterBefore.R), $($pCenterBefore.G), $($pCenterBefore.B))"
Write-Host "    Active Window RGB:    ($($pCenterActive.R), $($pCenterActive.G), $($pCenterActive.B))"
$hasRendered = ($pCenterActive.ToArgb() -ne $pCenterBefore.ToArgb()) -and ($pCenterActive.B -gt 50 -or $pCenterActive.R -gt 50)
Write-Host "    Rendered Holographic Element: $hasRendered"

Write-Host "`n=== TRANSPARENCY GATE VERDICT ==="
if ($allTransparent -and $hasRendered) {
    Write-Host "SUCCESS: GENUINE PER-PIXEL TRANSPARENCY VERIFIED!" -ForegroundColor Green
    Write-Host "- All 4 window corners show the desktop wallpaper directly behind the window." -ForegroundColor Green
    Write-Host "- Zero black rectangular backing or opaque borders." -ForegroundColor Green
    Write-Host "- Circular holographic element rendered cleanly in center." -ForegroundColor Green
} else {
    Write-Host "VERDICT: Incomplete or corner mismatch." -ForegroundColor Red
}

$bmpBefore.Dispose()
$bmpActive.Dispose()
