Add-Type -AssemblyName System.Drawing, System.Windows.Forms

$hudExe = "d:\D-ASK\D-ASK\src\hud-native\target\debug\hud-native.exe"
$outScreen = "d:\D-ASK\D-ASK\scratch\desktop_with_hud.png"
$outWindow = "d:\D-ASK\D-ASK\scratch\hud_window_crop.png"
$errLog = "d:\D-ASK\D-ASK\scratch\hud_stderr.log"

if (Test-Path $outScreen) { Remove-Item $outScreen -Force }
if (Test-Path $outWindow) { Remove-Item $outWindow -Force }

Write-Host "Launching HUD..."
$proc = Start-Process -FilePath $hudExe -ArgumentList "--duration-secs 6" -PassThru -RedirectStandardError $errLog

Start-Sleep -Milliseconds 2500

Write-Host "Capturing desktop screenshot..."
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($screen.X, $screen.Y, 0, 0, $screen.Size)
$bmp.Save($outScreen, [System.Drawing.Imaging.ImageFormat]::Png)

Write-Host "Searching for HUD window..."
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")]
    public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }
}
"@

$hWnd = [Win32]::FindWindow($null, "D-ASK Holographic Orb HUD")
Write-Host "Found hWnd: $hWnd"

if ($hWnd -ne [IntPtr]::Zero) {
    $rect = New-Object Win32+RECT
    [Win32]::GetWindowRect($hWnd, [ref]$rect)
    Write-Host "Window Rect: Left=$($rect.Left), Top=$($rect.Top), Right=$($rect.Right), Bottom=$($rect.Bottom)"
    
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($width -gt 0 -and $height -gt 0) {
        $cropBmp = New-Object System.Drawing.Bitmap($width, $height)
        $cropG = [System.Drawing.Graphics]::FromImage($cropBmp)
        $cropG.DrawImage($bmp, 0, 0, (New-Object System.Drawing.Rectangle($rect.Left, $rect.Top, $width, $height)), [System.Drawing.GraphicsUnit]::Pixel)
        $cropBmp.Save($outWindow, [System.Drawing.Imaging.ImageFormat]::Png)
        $cropG.Dispose()
        $cropBmp.Dispose()
        Write-Host "Saved window crop to $outWindow"
    }
}

$g.Dispose()
$bmp.Dispose()

Start-Sleep -Seconds 2
Write-Host "Done."

