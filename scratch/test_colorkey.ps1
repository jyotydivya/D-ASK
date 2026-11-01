Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Win32Window {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll")]
    public static extern bool SetLayeredWindowAttributes(IntPtr hwnd, uint crKey, byte bAlpha, uint dwFlags);
    [DllImport("user32.dll")]
    public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }
}
"@
Add-Type -AssemblyName System.Drawing, System.Windows.Forms

$hudExe = "d:\D-ASK\D-ASK\src\hud-native\target\debug\hud-native.exe"
$outScreen = "d:\D-ASK\D-ASK\scratch\desktop_with_colorkey.png"

Write-Host "Starting HUD..."
$proc = Start-Process -FilePath $hudExe -ArgumentList "--duration-secs 8" -PassThru

# Wait for window to appear
$hWnd = [IntPtr]::Zero
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 100
    $hWnd = [Win32Window]::FindWindow($null, "D-ASK Holographic Orb HUD")
    if ($hWnd -ne [IntPtr]::Zero) { break }
}

Write-Host "Found hWnd: $hWnd"

if ($hWnd -ne [IntPtr]::Zero) {
    # 0x80000 is WS_EX_LAYERED, GWL_EXSTYLE = -20
    $GWL_EXSTYLE = -20
    $WS_EX_LAYERED = 0x80000
    $LWA_COLORKEY = 0x1

    $style = [Win32Window]::GetWindowLong($hWnd, $GWL_EXSTYLE)
    Write-Host "Original ExStyle: 0x$($style.ToString("X"))"

    $newStyle = $style -bor $WS_EX_LAYERED
    [Win32Window]::SetWindowLong($hWnd, $GWL_EXSTYLE, $newStyle) | Out-Null
    
    # ColorKey 0x00000000 is RGB(0,0,0)
    $res = [Win32Window]::SetLayeredWindowAttributes($hWnd, 0x00000000, 0, $LWA_COLORKEY)
    Write-Host "SetLayeredWindowAttributes result: $res"

    Start-Sleep -Milliseconds 500

    # Capture screen
    $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($screen.X, $screen.Y, 0, 0, $screen.Size)
    $bmp.Save($outScreen, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()
    Write-Host "Saved screen to $outScreen"

    # Inspect corners
    $rect = New-Object Win32Window+RECT
    [Win32Window]::GetWindowRect($hWnd, [ref]$rect)
    Write-Host "Window Rect: ($($rect.Left), $($rect.Top)) to ($($rect.Right), $($rect.Bottom))"

    $base = [System.Drawing.Bitmap]::FromFile("d:\D-ASK\D-ASK\scratch\desktop_baseline.png")
    $tested = [System.Drawing.Bitmap]::FromFile($outScreen)

    $corners = @(
        @{ X = $rect.Left + 15; Y = $rect.Top + 15; Name = "Top-Left" },
        @{ X = $rect.Right - 15; Y = $rect.Top + 15; Name = "Top-Right" },
        @{ X = $rect.Left + 15; Y = $rect.Bottom - 15; Name = "Bottom-Left" },
        @{ X = $rect.Right - 15; Y = $rect.Bottom - 15; Name = "Bottom-Right" }
    )
    foreach ($c in $corners) {
        $pBase = $base.GetPixel($c.X, $c.Y)
        $pTest = $tested.GetPixel($c.X, $c.Y)
        $match = ($pBase.ToArgb() -eq $pTest.ToArgb())
        Write-Host "$($c.Name): Base=($($pBase.R),$($pBase.G),$($pBase.B)), Tested=($($pTest.R),$($pTest.G),$($pTest.B)) -> Transparent: $match"
    }

    # Also check center pixel
    $centerX = [int](($rect.Left + $rect.Right) / 2)
    $centerY = [int](($rect.Top + $rect.Bottom) / 2)
    $pCenter = $tested.GetPixel($centerX, $centerY)
    Write-Host "Center Orb pixel: RGB=($($pCenter.R),$($pCenter.G),$($pCenter.B))"

    $base.Dispose()
    $tested.Dispose()
} else {
    Write-Error "Could not find HUD window"
}

