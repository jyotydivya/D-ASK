Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$proc = Start-Process -FilePath "d:\D-ASK\D-ASK\src\hud-native\target\debug\hud-native.exe" -PassThru
Start-Sleep -Seconds 4

try {
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $gfx = [System.Drawing.Graphics]::FromImage($bmp)
    $gfx.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)

    $resultsDir = "d:\D-ASK\D-ASK\results"
    if (-not (Test-Path $resultsDir)) { New-Item -ItemType Directory -Path $resultsDir | Out-Null }

    $fullPath = Join-Path $resultsDir "phase_b_desktop_active.png"
    $bmp.Save($fullPath, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Host "Saved full screenshot to $fullPath"

    # Crop the HUD window region (position 100, 100, size 1280, 800)
    $cropRect = New-Object System.Drawing.Rectangle 100, 100, 1280, 800
    $cropBmp = $bmp.Clone($cropRect, $bmp.PixelFormat)
    $cropPath = Join-Path $resultsDir "phase_b_window_crop.png"
    $cropBmp.Save($cropPath, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Host "Saved cropped HUD window to $cropPath"

    # Sample colors:
    # 1. Top left corner (outside orb, should be transparent desktop)
    $cTopLeft = $cropBmp.GetPixel(30, 30)
    Write-Host "Window Top-Left Pixel Color: RGB($($cTopLeft.R), $($cTopLeft.G), $($cTopLeft.B))"

    # 2. Orb center (approx center 640, 400)
    $cCenter = $cropBmp.GetPixel(640, 400)
    Write-Host "Orb Center Pixel Color: RGB($($cCenter.R), $($cCenter.G), $($cCenter.B))"

    # 3. Top right corner
    $cTopRight = $cropBmp.GetPixel(1250, 30)
    Write-Host "Window Top-Right Pixel Color: RGB($($cTopRight.R), $($cTopRight.G), $($cTopRight.B))"

    $gfx.Dispose()
    $bmp.Dispose()
    $cropBmp.Dispose()
} finally {
    if ($proc -and -not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force
    }
}

