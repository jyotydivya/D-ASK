# Shared helpers for the packaged-HUD demonstrations (demo-browser.ps1, demo-offline.ps1). Dot-source after hud-driver.ps1.
# Everything goes through the REAL packaged launcher and the REAL HUD: requests are typed into the HUD, approval cards are clicked in the HUD,
# results are read from the HUD. Nothing is simulated. The memory guard is never touched.
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing, System.Windows.Forms

function Record([string]$Name, [bool]$Pass, $Detail) {
    [void]$script:results.Add([pscustomobject]@{ name = $Name; pass = $Pass; detail = $Detail })
    "{0}  {1}  {2}" -f $(if ($Pass) { ' ok ' } else { 'FAIL' }), $Name, ($Detail | ConvertTo-Json -Compress -Depth 4)
}
function Find-Proc([string]$ExeTail) { Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.EndsWith($ExeTail, [StringComparison]::OrdinalIgnoreCase) -and $_.ExecutablePath.StartsWith($script:PackageRoot, [StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1 }
function Stop-Packaged { foreach ($n in 'hud-native.exe', 'DAsk.Daemon.exe') { $x = Find-Proc $n; if ($x) { taskkill /PID $x.ProcessId /T /F 2>$null | Out-Null } } }
function Start-Packaged {
    if (Get-Process DAsk.Daemon, hud-native -ErrorAction SilentlyContinue) { throw 'A D-ASK daemon or HUD is already running; stop it first (one instance only).' }
    Start-Process -FilePath "$script:PackageRoot\Start-D-ASK.cmd" -WindowStyle Hidden | Out-Null
    for ($i = 0; $i -lt 90; $i++) { Start-Sleep -Milliseconds 500; $h = Find-Proc 'hud-native.exe'; if ($h) { $p = Get-Process -Id $h.ProcessId -EA SilentlyContinue; if ($p -and $p.MainWindowHandle -ne 0) { break } } }
    $script:hwnd = Get-HudHwnd (Find-Proc 'hud-native.exe').ProcessId
    Enter-HudInteractive $script:hwnd; Start-Sleep -Seconds 2
}
function Restore-HudFront {
    if ([HudInput]::GetForegroundWindow() -eq $script:hwnd) { return }
    if ((Get-HudMode $script:hwnd) -eq 'interactive') { Send-HudToggleHotkey; try { [void](Wait-HudMode $script:hwnd 'ambient' 3000) } catch { } }
    Enter-HudInteractive $script:hwnd
    Start-Sleep -Milliseconds 800
}
function Wait-Card([string]$Pattern, [int]$TimeoutMs = 90000) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    do { $t = Get-HudText $script:hwnd; if ($t -cmatch 'APPROVAL REQUIRED' -and $t -match $Pattern) { return $t }; if (Get-HudOutcome $script:hwnd) { return $null }; Start-Sleep -Milliseconds 200 } while ($sw.ElapsedMilliseconds -lt $TimeoutMs)
    return $null
}
function Approve-Card([string]$Label) {
    Restore-HudFront
    $btn = Find-HudButton $script:hwnd '^APPROVE$'
    $sw = [Diagnostics.Stopwatch]::StartNew(); while (-not $btn.Current.IsEnabled -and $sw.ElapsedMilliseconds -lt 8000) { Start-Sleep -Milliseconds 50 }
    Confirm-HudForeground $script:hwnd | Out-Null
    Click-HudElement $script:hwnd $btn
    Record "$Label approved in the real HUD" $true @{ enabledAfterMs = $sw.ElapsedMilliseconds }
}
# Types one request into the HUD, approves each expected card (by pattern, in order), waits for the result. Returns the evidence.
function Invoke-DemoRequest([string]$Text, [string[]]$CardPatterns = @(), [string]$Tag = 'req', [int]$ResultTimeoutMs = 180000) {
    Restore-HudFront
    Submit-HudRequest $script:hwnd $Text
    $cards = @()
    $i = 0
    foreach ($pat in $CardPatterns) {
        $i++
        $c = Wait-Card $pat 120000
        if ($c) { Set-Content -Encoding utf8 "$script:OutDir\$Tag-card$i.txt" $c; Save-HudShot $script:hwnd "$script:OutDir\$Tag-card$i.png" }
        $cards += [pscustomobject]@{ pattern = $pat; shown = [bool]$c; text = $c }
        if (-not $c) { break }
        Approve-Card "$Tag card $i"
    }
    $o = Wait-HudOutcome $script:hwnd $ResultTimeoutMs
    $t = Get-HudText $script:hwnd
    Set-Content -Encoding utf8 "$script:OutDir\$Tag-result.txt" $t
    Save-HudShot $script:hwnd "$script:OutDir\$Tag-result.png"
    return [pscustomobject]@{ outcome = $o.Outcome; ms = $o.Ms; text = $t; cards = $cards; verified = ($t -match '(?m)^INDEPENDENTLY VERIFIED$'); answeredLabel = ($t -match 'ANSWERED BY THE LOCAL MODEL') }
}
function Desktop-Shot([string]$Path) {
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size); $g.Dispose()
    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
}
function Save-DemoResults([string]$Name) {
    ConvertTo-Json -InputObject @($script:results.ToArray()) -Depth 6 | Set-Content -Encoding utf8 "$script:OutDir\$Name.json"
    $failed = @($script:results | Where-Object { -not $_.pass }).Count
    "`n$(@($script:results | Where-Object { $_.pass }).Count) of $($script:results.Count) passed"
    return $failed
}
