Add-Type -AssemblyName System.Drawing, System.Windows.Forms

$hudExe = "d:\D-ASK\D-ASK\src\hud-native\target\release\hud-native.exe"
$states = @("Critical", "ModelGenerating", "TaskCompleted", "Listening", "Processing")

$winLeft = 125
$winTop = 125
$winWidth = 600
$winHeight = 650

foreach ($st in $states) {
    Write-Host "`n=== Testing State: $st ==="
    $outPng = "d:\D-ASK\D-ASK\results\state_$st.png"
    $proc = Start-Process -FilePath $hudExe -ArgumentList "--duration-secs 3 --backend vulkan --state $st" -PassThru -NoNewWindow
    Start-Sleep -Milliseconds 1800

    $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmpActive = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
    $gActive = [System.Drawing.Graphics]::FromImage($bmpActive)
    $gActive.CopyFromScreen($screen.X, $screen.Y, 0, 0, $screen.Size)

    $cropBmp = New-Object System.Drawing.Bitmap($winWidth, $winHeight)
    $gCrop = [System.Drawing.Graphics]::FromImage($cropBmp)
    $gCrop.DrawImage($bmpActive, 0, 0, (New-Object System.Drawing.Rectangle($winLeft, $winTop, $winWidth, $winHeight)), [System.Drawing.GraphicsUnit]::Pixel)
    $cropBmp.Save($outPng, [System.Drawing.Imaging.ImageFormat]::Png)
    $gCrop.Dispose()
    $cropBmp.Dispose()
    $bmpActive.Dispose()
    $gActive.Dispose()

    $proc.WaitForExit(4000)

    # Sample center orb color
    $crop = [System.Drawing.Bitmap]::FromFile($outPng)
    $centerX = [int]($crop.Width * 0.50)
    $centerY = [int]($crop.Height * 0.42)
    $p = $crop.GetPixel($centerX, $centerY)
    $crop.Dispose()
    Write-Host "State $st Center Color: RGB=($($p.R), $($p.G), $($p.B)) -> Saved to $outPng"
}

