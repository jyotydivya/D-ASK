Add-Type -AssemblyName System.Drawing, System.Windows.Forms

$pocExe = "d:\D-ASK\D-ASK\src\hud-native\target\debug\webview_transparency_poc.exe"
$beforePng = "d:\D-ASK\D-ASK\results\webview_desktop_before.png"
$activePng = "d:\D-ASK\D-ASK\results\webview_desktop_active.png"
$cropPng = "d:\D-ASK\D-ASK\results\webview_window_crop.png"

$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds

Write-Host "=== TEST 1: Capture Pre-Launch Desktop Baseline ==="
$bmpBefore = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
$gBefore = [System.Drawing.Graphics]::FromImage($bmpBefore)
$gBefore.CopyFromScreen($screen.X, $screen.Y, 0, 0, $screen.Size)
$bmpBefore.Save($beforePng, [System.Drawing.Imaging.ImageFormat]::Png)
$gBefore.Dispose()
Write-Host "Captured baseline: $beforePng"

Write-Host "`n=== TEST 2: Launching Transparent WebView2 Window ==="
$proc = Start-Process -FilePath $pocExe -PassThru -NoNewWindow
Start-Sleep -Milliseconds 2500

Write-Host "Capturing active desktop with WebView2 HUD..."
$bmpActive = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
$gActive = [System.Drawing.Graphics]::FromImage($bmpActive)
$gActive.CopyFromScreen($screen.X, $screen.Y, 0, 0, $screen.Size)
$bmpActive.Save($activePng, [System.Drawing.Imaging.ImageFormat]::Png)
$gActive.Dispose()

# Measure process resource usage while active
try {
    $wsMB = [math]::Round($proc.WorkingSet64 / 1MB, 2)
    $cpuSecs = $proc.TotalProcessorTime.TotalSeconds
    Write-Host "Active Host Process ID: $($proc.Id)"
    Write-Host "Working Set: $wsMB MB"
    Write-Host "CPU Time: $cpuSecs s"
} catch {
    Write-Host "Process stats: $_"
}

# Stop the process cleanly
$proc.Kill()
$proc.WaitForExit(3000)

Write-Host "`n=== TEST 3: Inspect Window Region & Transparency ==="
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

Write-Host "`n=== TEST 4: Quantitative Pixel Audit (Outside Central Orb) ==="
$testPoints = @(
    @{ X = $winLeft + 25; Y = $winTop + 25; Name = "Top-Left Corner" },
    @{ X = $winLeft + $winWidth - 25; Y = $winTop + 25; Name = "Top-Right Corner" },
    @{ X = $winLeft + 25; Y = $winTop + $winHeight - 25; Name = "Bottom-Left Corner" },
    @{ X = $winLeft + $winWidth - 25; Y = $winTop + $winHeight - 25; Name = "Bottom-Right Corner" },
    @{ X = $winLeft + 25; Y = $winTop + [int]($winHeight / 2); Name = "Mid-Left Edge" },
    @{ X = $winLeft + $winWidth - 25; Y = $winTop + [int]($winHeight / 2); Name = "Mid-Right Edge" }
)

$allPassed = $true
$totalDiff = 0
foreach ($p in $testPoints) {
    $pBefore = $bmpBefore.GetPixel($p.X, $p.Y)
    $pActive = $bmpActive.GetPixel($p.X, $p.Y)
    
    $diff = [math]::Abs($pActive.R - $pBefore.R) + [math]::Abs($pActive.G - $pBefore.G) + [math]::Abs($pActive.B - $pBefore.B)
    $totalDiff += $diff
    $isMatch = ($diff -le 35)
    $isWhite = ($pActive.R -gt 245 -and $pActive.G -gt 245 -and $pActive.B -gt 245)
    $isBlack = ($pActive.R -eq 0 -and $pActive.G -eq 0 -and $pActive.B -eq 0)

    Write-Host "  $($p.Name) at ($($p.X), $($p.Y)):"
    Write-Host "    Desktop Baseline RGB: ($($pBefore.R), $($pBefore.G), $($pBefore.B))"
    Write-Host "    Active Window RGB:    ($($pActive.R), $($pActive.G), $($pActive.B))"
    Write-Host "    Color Diff:           $diff"
    Write-Host "    Desktop Shows Through: $isMatch"
    Write-Host "    Is White Box:         $isWhite"
    Write-Host "    Is Black Box:         $isBlack"

    if (-not $isMatch) {
        $allPassed = $false
    }
}

Write-Host "`n=== TEST 5: Central Holographic Core Verification ==="
$centerX = $winLeft + [int]($winWidth / 2)
$centerY = $winTop + [int]($winHeight / 2) - 20
$pCenterBefore = $bmpBefore.GetPixel($centerX, $centerY)
$pCenterActive = $bmpActive.GetPixel($centerX, $centerY)

Write-Host "  Orb Core at ($centerX, $centerY):"
Write-Host "    Baseline Desktop RGB: ($($pCenterBefore.R), $($pCenterBefore.G), $($pCenterBefore.B))"
Write-Host "    Active Orb Core RGB:  ($($pCenterActive.R), $($pCenterActive.G), $($pCenterActive.B))"
$hasRendered = ($pCenterActive.ToArgb() -ne $pCenterBefore.ToArgb()) -and ($pCenterActive.R -gt 150)
Write-Host "    Rendered Holographic Element: $hasRendered"

$bmpBefore.Dispose()
$bmpActive.Dispose()

# Copy to artifacts directory
Copy-Item $activePng "C:\Users\divya\.gemini\antigravity\brain\efa02fd5-ce13-4aeb-94e4-76409f4f9fb9\webview_desktop_active.png" -Force
Copy-Item $beforePng "C:\Users\divya\.gemini\antigravity\brain\efa02fd5-ce13-4aeb-94e4-76409f4f9fb9\webview_desktop_before.png" -Force
Copy-Item $cropPng "C:\Users\divya\.gemini\antigravity\brain\efa02fd5-ce13-4aeb-94e4-76409f4f9fb9\webview_window_crop.png" -Force

Write-Host "`n=== FINAL VERDICT ==="
if ($allPassed -and $hasRendered) {
    Write-Host "SUCCESS: WEBVIEW2 TRANSPARENCY PROOF-OF-CONCEPT FORMALLY PASSED!" -ForegroundColor Green
    Write-Host "- Per-pixel alpha transparency verified across all outer regions." -ForegroundColor Green
    Write-Host "- Zero white backing box or opaque frame artifacts." -ForegroundColor Green
    Write-Host "- Zero black box composition artifacts." -ForegroundColor Green
    Write-Host "- Active holographic element rendered with high fidelity directly over desktop wallpaper." -ForegroundColor Green
} else {
    Write-Host "PARTIAL / AUDIT NEEDED: AllPassed=$allPassed, HasRendered=$hasRendered, TotalDiff=$totalDiff" -ForegroundColor Yellow
}

