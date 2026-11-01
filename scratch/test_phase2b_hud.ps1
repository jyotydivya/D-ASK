Add-Type -AssemblyName System.Drawing, System.Windows.Forms

$hudExe = "d:\D-ASK\D-ASK\src\hud-native\target\release\hud-native.exe"
$traceLog = "d:\D-ASK\D-ASK\scratch\hud_trace.log"

$beforePng = "d:\D-ASK\D-ASK\scratch\phase2b_desktop_before.png"
$activePng = "d:\D-ASK\D-ASK\scratch\phase2b_desktop_active.png"
$cropPng = "d:\D-ASK\D-ASK\scratch\phase2b_window_crop.png"

if (Test-Path $beforePng) { Remove-Item $beforePng -Force }
if (Test-Path $activePng) { Remove-Item $activePng -Force }
if (Test-Path $cropPng) { Remove-Item $cropPng -Force }
if (Test-Path $traceLog) { Remove-Item $traceLog -Force }

Write-Host "=== TEST 1: Baseline Desktop & Window Launch ==="
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmpBefore = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
$gBefore = [System.Drawing.Graphics]::FromImage($bmpBefore)
$gBefore.CopyFromScreen($screen.X, $screen.Y, 0, 0, $screen.Size)
$bmpBefore.Save($beforePng, [System.Drawing.Imaging.ImageFormat]::Png)
$gBefore.Dispose()
Write-Host "Captured desktop baseline: $beforePng"

Write-Host "`nLaunching HUD ($hudExe) with --no-panel for 5 seconds..."
$proc = Start-Process -FilePath $hudExe -ArgumentList "--duration-secs 5 --backend vulkan --no-panel" -PassThru -NoNewWindow

Start-Sleep -Milliseconds 2200

Write-Host "Capturing active desktop with HUD..."
$bmpActive = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
$gActive = [System.Drawing.Graphics]::FromImage($bmpActive)
$gActive.CopyFromScreen($screen.X, $screen.Y, 0, 0, $screen.Size)
$bmpActive.Save($activePng, [System.Drawing.Imaging.ImageFormat]::Png)
$gActive.Dispose()

# Measure process resource usage while active
try {
    $wsMB = [math]::Round($proc.WorkingSet64 / 1MB, 2)
    $cpuSecs = $proc.TotalProcessorTime.TotalSeconds
    Write-Host "Active HUD Process ID: $($proc.Id)"
    Write-Host "Working Set: $wsMB MB"
    Write-Host "CPU Time: $cpuSecs s"
} catch {
    Write-Host "Process status check: $_"
}

# Wait for proc to exit naturally
$proc.WaitForExit(6000)

Write-Host "`n=== TEST 2: Inspect Window Region & Transparency ==="
# Position is explicitly (100, 100) logical -> (125, 125) physical at 1.25x scale factor
# Size is 480x520 logical -> 600x650 physical
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
Write-Host "Saved 600x650 window crop to $cropPng"

Write-Host "`n=== TEST 3: Corner Transparency Verification (Outside Circle) ==="
$corners = @(
    @{ X = $winLeft + 25; Y = $winTop + 25; Name = "Top-Left Corner" },
    @{ X = $winLeft + $winWidth - 25; Y = $winTop + 25; Name = "Top-Right Corner" },
    @{ X = $winLeft + 25; Y = $winTop + $winHeight - 25; Name = "Bottom-Left Corner" },
    @{ X = $winLeft + $winWidth - 25; Y = $winTop + $winHeight - 25; Name = "Bottom-Right Corner" }
)

$cornersPass = $true
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

    if (-not $isMatch) {
        # Check if DWM glass compositing blend difference
        $diff = [math]::Abs($pActive.R - $pBefore.R) + [math]::Abs($pActive.G - $pBefore.G) + [math]::Abs($pActive.B - $pBefore.B)
        if ($diff -gt 35) { $cornersPass = $false }
    }
}

Write-Host "`n=== TEST 4: Center Holographic Core Verification ==="
$centerX = $winLeft + [int]($winWidth / 2)
$centerY = $winTop + [int]($winHeight / 2) - 30
$pCenterBefore = $bmpBefore.GetPixel($centerX, $centerY)
$pCenterActive = $bmpActive.GetPixel($centerX, $centerY)

Write-Host "  Orb Core at ($centerX, $centerY):"
Write-Host "    Baseline Desktop RGB: ($($pCenterBefore.R), $($pCenterBefore.G), $($pCenterBefore.B))"
Write-Host "    Active Orb Core RGB:  ($($pCenterActive.R), $($pCenterActive.G), $($pCenterActive.B))"
$hasRendered = ($pCenterActive.ToArgb() -ne $pCenterBefore.ToArgb()) -and ($pCenterActive.B -gt 30 -or $pCenterActive.R -gt 30)
Write-Host "    Rendered Holographic Element: $hasRendered"

Write-Host "`n=== TEST 5: Frame Telemetry Log Output ($traceLog) ==="
if (Test-Path $traceLog) {
    $traceLines = Get-Content $traceLog
    Write-Host "Trace Log total lines: $($traceLines.Count)"
    $traceLines | Select-String "BENCHMARK|FRAME TELEMETRY|Adapter|Surface|initialized|SHUTDOWN" | ForEach-Object {
        Write-Host "  TRACE: $_"
    }
} else {
    Write-Host "Trace log not found at $traceLog"
}

$bmpBefore.Dispose()
$bmpActive.Dispose()

Write-Host "`n=== TEST 1..5 VERDICT ==="
if ($cornersPass -and $hasRendered) {
    Write-Host "SUCCESS: PHASE 2B HOLOGRAPHIC ORB PASSED TRANSPARENCY & RENDERING AUDIT!" -ForegroundColor Green
} else {
    Write-Host "VERDICT: CornersPass=$cornersPass, HasRendered=$hasRendered" -ForegroundColor Yellow
}
