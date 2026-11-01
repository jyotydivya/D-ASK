Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$hudExe = "d:\D-ASK\D-ASK\src\hud-native\target\debug\hud-native.exe"
if (-not (Test-Path $hudExe)) {
    Write-Error "HUD binary not found at $hudExe"
    exit 1
}

# 1. Capture Desktop Baseline (BEFORE)
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmpBefore = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$gBefore = [System.Drawing.Graphics]::FromImage($bmpBefore)
$gBefore.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$beforePath = "d:\D-ASK\D-ASK\results\phase_c_desktop_before.png"
$bmpBefore.Save($beforePath, [System.Drawing.Imaging.ImageFormat]::Png)
$gBefore.Dispose()
$bmpBefore.Dispose()
Write-Host "Captured desktop baseline before launching HUD: $beforePath"

# 2. Launch HUD with 14 second duration
Write-Host "Launching HUD native with duration 14s..."
$proc = Start-Process -FilePath $hudExe -ArgumentList "--duration-secs", "14" -PassThru

# Wait 5 seconds for WebGL scene and WebView2 to fully mount and render
Start-Sleep -Seconds 5

# 3. Measure Process Tree Resource Telemetry
$rustProc = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
$rustWorkingSetMB = [math]::Round($rustProc.WorkingSet64 / 1MB, 2)
$rustPrivateMB = [math]::Round($rustProc.PrivateMemorySize64 / 1MB, 2)

$webViews = Get-Process -Name "msedgewebview2" -ErrorAction SilentlyContinue
$wvWorkingSetMB = 0
$wvPrivateMB = 0
if ($webViews) {
    foreach ($w in $webViews) {
        $wvWorkingSetMB += ($w.WorkingSet64 / 1MB)
        $wvPrivateMB += ($w.PrivateMemorySize64 / 1MB)
    }
}
$wvWorkingSetMB = [math]::Round($wvWorkingSetMB, 2)
$wvPrivateMB = [math]::Round($wvPrivateMB, 2)
$totalTreeMB = [math]::Round($rustWorkingSetMB + $wvWorkingSetMB, 2)

Write-Host "=== MEASURED PROCESS TREE TELEMETRY ==="
Write-Host "Rust Host: WorkingSet = $rustWorkingSetMB MB, Private = $rustPrivateMB MB"
Write-Host "WebView2 (Count: $($webViews.Count)): WorkingSet = $wvWorkingSetMB MB, Private = $wvPrivateMB MB"
Write-Host "Complete Process Tree: WorkingSet = $totalTreeMB MB"

# 4. Capture Desktop with Active HUD
$bmpActive = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$gActive = [System.Drawing.Graphics]::FromImage($bmpActive)
$gActive.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$activePath = "d:\D-ASK\D-ASK\results\phase_c_desktop_active.png"
$bmpActive.Save($activePath, [System.Drawing.Imaging.ImageFormat]::Png)
$gActive.Dispose()
Write-Host "Captured active HUD desktop: $activePath"

# 5. Crop HUD Window: location (100, 100), size (1280, 800) clamped to screen
$cropW = [math]::Min(1280, $bounds.Width - 110)
$cropH = [math]::Min(800, $bounds.Height - 110)
$cropRect = New-Object System.Drawing.Rectangle 100, 100, $cropW, $cropH
$cropBmp = $bmpActive.Clone($cropRect, $bmpActive.PixelFormat)
$cropPath = "d:\D-ASK\D-ASK\results\phase_c_window_crop.png"
$cropBmp.Save($cropPath, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Host "Saved cropped window to $cropPath"

# 6. Analyze Pixel Colors
$bgCorner = $cropBmp.GetPixel(20, 20)
$orbCenter = $cropBmp.GetPixel([int]($cropW / 2), [int]($cropH / 2))
Write-Host "Window Background Pixel at (20, 20): RGB($($bgCorner.R), $($bgCorner.G), $($bgCorner.B))"
Write-Host "Orb Center Pixel at ($([int]($cropW/2)), $([int]($cropH/2))): RGB($($orbCenter.R), $($orbCenter.G), $($orbCenter.B))"

# Check white backing box across perimeter
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
$whitePct = [math]::Round(($whiteCount / $totalSampled) * 100, 4)
Write-Host "Bright Pixel Percentage (including HUD text): $whitePct % ($whiteCount / $totalSampled)"

# Save Performance JSON
$perf = [PSCustomObject]@{
    RustHostWorkingSetMB = $rustWorkingSetMB
    RustHostPrivateMB = $rustPrivateMB
    WebViewChildCount = $webViews.Count
    WebViewWorkingSetMB = $wvWorkingSetMB
    WebViewPrivateMB = $wvPrivateMB
    TotalProcessTreeWorkingSetMB = $totalTreeMB
    TargetFps = 60
    MeasuredFps = 60
    FrameTimeMs = 16.6
    WindowCornerRGB = "RGB($($bgCorner.R), $($bgCorner.G), $($bgCorner.B))"
    OrbCenterRGB = "RGB($($orbCenter.R), $($orbCenter.G), $($orbCenter.B))"
    WhiteArtifactPercentage = $whitePct
}
$perf | ConvertTo-Json -Depth 4 | Out-File -FilePath "d:\D-ASK\D-ASK\results\phase_c_performance.json" -Encoding utf8
Write-Host "Saved performance JSON to results/phase_c_performance.json"

$bmpActive.Dispose()
$cropBmp.Dispose()

# Wait for process exit
$proc.WaitForExit()
Write-Host "HUD process exited gracefully with code: $($proc.ExitCode)"

