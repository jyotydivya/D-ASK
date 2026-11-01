Add-Type -AssemblyName System.Drawing

$img = [System.Drawing.Bitmap]::FromFile("d:\D-ASK\D-ASK\results\phase_b_desktop_active.png")

# Window started at position (100, 100). Valid rectangle on screen is (100, 100, 1400, 750)
$cropRect = New-Object System.Drawing.Rectangle 100, 100, ($img.Width - 110), ($img.Height - 110)
$cropBmp = $img.Clone($cropRect, $img.PixelFormat)

$cropPath = "d:\D-ASK\D-ASK\results\phase_b_window_crop.png"
$cropBmp.Save($cropPath, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Host "Saved cropped window to $cropPath"

# Analyze pixel colors across the window:
# 1. Background outside orb (e.g. at local coordinate 20, 20 inside window)
$bgPix = $cropBmp.GetPixel(20, 20)
Write-Host "Background pixel at (20, 20): RGB($($bgPix.R), $($bgPix.G), $($bgPix.B))"

# 2. Orb center (approx center of window: ($cropBmp.Width / 2), ($cropBmp.Height / 2))
$cx = [int]($cropBmp.Width / 2)
$cy = [int]($cropBmp.Height / 2)
$orbPix = $cropBmp.GetPixel($cx, $cy)
Write-Host "Orb Center pixel at ($cx, $cy): RGB($($orbPix.R), $($orbPix.G), $($orbPix.B))"

# 3. Check for any white backing: count white/light-gray box pixels
$whiteCount = 0
$totalSampled = 0
for ($x = 10; $x -lt $cropBmp.Width - 10; $x += 20) {
    for ($y = 10; $y -lt $cropBmp.Height - 10; $y += 20) {
        $p = $cropBmp.GetPixel($x, $y)
        $totalSampled++
        if ($p.R -gt 245 -and $p.G -gt 245 -and $p.B -gt 245) {
            $whiteCount++
        }
    }
}
$whitePct = ($whiteCount / $totalSampled) * 100
Write-Host "White pixel percentage across window: $whitePct % ($whiteCount / $totalSampled)"

$img.Dispose()
$cropBmp.Dispose()

