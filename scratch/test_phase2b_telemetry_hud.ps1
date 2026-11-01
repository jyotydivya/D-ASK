Add-Type -AssemblyName System.Drawing, System.Windows.Forms

$hudExe = "d:\D-ASK\D-ASK\src\hud-native\target\release\hud-native.exe"
$traceLog = "d:\D-ASK\D-ASK\scratch\hud_trace.log"
$cropPng = "d:\D-ASK\D-ASK\scratch\phase2b_telemetry_crop.png"

Write-Host "Launching HUD with default telemetry card enabled..."
$proc = Start-Process -FilePath $hudExe -ArgumentList "--duration-secs 4 --backend vulkan" -PassThru -NoNewWindow

Start-Sleep -Milliseconds 2500

Write-Host "Capturing active desktop with telemetry card..."
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmpActive = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
$gActive = [System.Drawing.Graphics]::FromImage($bmpActive)
$gActive.CopyFromScreen($screen.X, $screen.Y, 0, 0, $screen.Size)

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
$bmpActive.Dispose()
$gActive.Dispose()

Write-Host "Saved telemetry HUD window crop to $cropPng"

# Inspect bottom region for telemetry HUD elements:
# The telemetry panel is at the bottom of the window crop (Y ~ 470 to 570)
$crop = [System.Drawing.Bitmap]::FromFile($cropPng)
$panelY = [int]($crop.Height * 0.83) # ~ 540 px
$panelX = [int]($crop.Width * 0.50)  # ~ 300 px
$pPanel = $crop.GetPixel($panelX, $panelY)
Write-Host "Telemetry Panel Center Pixel at ($panelX, $panelY): RGB=($($pPanel.R), $($pPanel.G), $($pPanel.B))"
$crop.Dispose()

$proc.WaitForExit(5000)
Copy-Item $cropPng "d:\D-ASK\D-ASK\results\phase2b_telemetry_crop.png" -Force
Write-Host "Copied to results\phase2b_telemetry_crop.png"

