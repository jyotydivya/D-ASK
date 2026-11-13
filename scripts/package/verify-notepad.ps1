# Real-HUD demonstration of native Windows control on a PACKAGED D-ASK: "Open Notepad and type HELLO".
# The real launcher starts the stack; the request is typed into the real HUD; both approval cards (open Notepad, type the text) are clicked in the real
# HUD; the result is read from the HUD; and, independently of the HUD and the daemon, Notepad's own editor is read through UI Automation.
# Nothing is simulated. -PackageRoot is a throwaway copy of a built package. Refuses to run if Notepad windows already exist (it never touches them).
#   powershell -ExecutionPolicy Bypass -File scripts\package\verify-notepad.ps1 -PackageRoot <package copy> -OutDir results\packaging\notepad-<stamp>
param([Parameter(Mandatory = $true)][string]$PackageRoot, [Parameter(Mandatory = $true)][string]$OutDir, [string]$Request = 'Open Notepad and type HELLO', [string]$Expected = 'HELLO')
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\..\hud\hud-driver.ps1"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing, System.Windows.Forms
if ((Test-Path $OutDir) -and @(Get-ChildItem $OutDir -Force).Count -gt 0) { throw "OutDir must be new or empty: $OutDir" }
New-Item -ItemType Directory -Force $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path
$PackageRoot = (Resolve-Path $PackageRoot).Path
$results = New-Object System.Collections.ArrayList
$memDb = Join-Path $OutDir 'memory.db'
$env:DASK_AgentHost__ExtraEnvironment__DASK_MEMORY_DB = $memDb   # nothing here may touch the user's memory database
function Record([string]$Name, [bool]$Pass, $Detail) {
    [void]$results.Add([pscustomobject]@{ name = $Name; pass = $Pass; detail = $Detail })
    "{0}  {1}  {2}" -f $(if ($Pass) { ' ok ' } else { 'FAIL' }), $Name, ($Detail | ConvertTo-Json -Compress -Depth 4)
}
function Find-Proc([string]$ExeTail) { Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.EndsWith($ExeTail, [StringComparison]::OrdinalIgnoreCase) -and $_.ExecutablePath.StartsWith($PackageRoot, [StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1 }
function Stop-All { foreach ($n in 'hud-native.exe', 'DAsk.Daemon.exe') { $x = Find-Proc $n; if ($x) { taskkill /PID $x.ProcessId /T /F 2>$null | Out-Null } } }
function Desktop-Shot([string]$Path) {
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size); $g.Dispose()
    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
}
# Notepad windows as UI Automation sees them (independent of D-ASK).
function Get-NotepadWindows {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    @($root.FindAll('Children', [System.Windows.Automation.Condition]::TrueCondition) | Where-Object { $_.Current.ClassName -eq 'Notepad' -or $_.Current.Name -match '- Notepad$' })
}
function Read-NotepadText($Window) {
    $doc = $Window.FindAll('Descendants', [System.Windows.Automation.Condition]::TrueCondition) | Where-Object { $_.Current.ControlType.ProgrammaticName -eq 'ControlType.Document' } | Select-Object -First 1
    if (-not $doc) { return $null }
    $vp = $null
    if ($doc.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { return $vp.Current.Value }
    return $null
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
function Approve([string]$Label) {
    Restore-HudFront
    $btn = Find-HudButton $script:hwnd '^APPROVE$'
    $sw = [Diagnostics.Stopwatch]::StartNew(); while (-not $btn.Current.IsEnabled -and $sw.ElapsedMilliseconds -lt 8000) { Start-Sleep -Milliseconds 50 }
    Confirm-HudForeground $script:hwnd | Out-Null
    Click-HudElement $script:hwnd $btn
    Record "$Label approved in the real HUD" $true @{ enabledAfterMs = $sw.ElapsedMilliseconds }
}

$avail = [int]((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1024)
$pre = @(Get-NotepadWindows)
if ($pre.Count -gt 0) { throw "Notepad windows already exist ($($pre.Count)); close them first. This script never touches existing windows." }
if (Get-Process DAsk.Daemon, hud-native -ErrorAction SilentlyContinue) { throw 'A D-ASK daemon or HUD is already running; stop it first (one instance only).' }
$launchedNotepadPid = $null
# Win11 Notepad keeps unsaved tabs and restores them at the next start. The run must neither type into someone's restored text nor leave its own
# demonstration text behind: Notepad's saved tab state is snapshotted first and put back exactly as it was at the end.
$npState = Join-Path $env:LOCALAPPDATA 'Packages\Microsoft.WindowsNotepad_8wekyb3d8bbwe\LocalState\TabState'
$npSnapshot = Join-Path $OutDir 'notepad-tabstate-before'
New-Item -ItemType Directory -Force $npSnapshot | Out-Null
$npHadState = Test-Path $npState
if ($npHadState) { Copy-Item (Join-Path $npState '*') $npSnapshot -Recurse -Force }
if ($npHadState -and @(Get-ChildItem $npState -File -ErrorAction SilentlyContinue).Count -gt 0) { throw "Notepad has saved tabs ($npState); the run would type into restored text. Save or close them first." }
try {
    Start-Process -FilePath "$PackageRoot\Start-D-ASK.cmd" -WindowStyle Hidden | Out-Null
    for ($i = 0; $i -lt 90; $i++) { Start-Sleep -Milliseconds 500; $h = Find-Proc 'hud-native.exe'; if ($h) { $p = Get-Process -Id $h.ProcessId -EA SilentlyContinue; if ($p -and $p.MainWindowHandle -ne 0) { break } } }
    $script:hwnd = Get-HudHwnd (Find-Proc 'hud-native.exe').ProcessId
    Enter-HudInteractive $script:hwnd; Start-Sleep -Seconds 2
    Record 'the packaged app started from its own launcher (HUD and daemon from the package)' ([bool](Find-Proc 'DAsk.Daemon.exe')) @{ availableMBBeforeStart = $avail; package = $PackageRoot }

    Restore-HudFront
    Submit-HudRequest $script:hwnd $Request
    $card1 = Wait-Card 'Open Notepad'
    if ($card1) { Set-Content -Encoding utf8 "$OutDir\card1-open.txt" $card1; Save-HudShot $script:hwnd "$OutDir\card1-open.png" }
    Record 'card 1 offered: open Notepad (exact application and executable shown)' ($card1 -and $card1 -match 'notepad\.exe' -and $card1 -match 'System32') @{ shown = [bool]$card1 }
    if (-not $card1) { throw 'no approval card appeared for opening Notepad' }
    Approve 'card 1 (open Notepad)'

    $card2 = Wait-Card 'Type (this text|exactly)' 120000
    if ($card2) { Set-Content -Encoding utf8 "$OutDir\card2-type.txt" $card2; Save-HudShot $script:hwnd "$OutDir\card2-type.png" }
    Record 'card 2 offered: type the exact text into the window that was opened' ($card2 -and $card2 -cmatch [regex]::Escape($Expected) -and $card2 -match 'Notepad') @{ shown = [bool]$card2 }
    if (-not $card2) { throw 'no approval card appeared for typing' }
    $np = @(Get-NotepadWindows)
    Record 'Notepad is open after card 1 (UI Automation, independent of D-ASK)' ($np.Count -eq 1) @{ windows = $np.Count; title = $(if ($np.Count) { $np[0].Current.Name }) }
    Approve 'card 2 (type the text)'

    $o = Wait-HudOutcome $script:hwnd 120000
    $hudText = Get-HudText $script:hwnd
    Set-Content -Encoding utf8 "$OutDir\hud-result.txt" $hudText
    Save-HudShot $script:hwnd "$OutDir\hud-result.png"
    Record 'the HUD reports COMPLETED and INDEPENDENTLY VERIFIED' (($o.Outcome -eq 'COMPLETED') -and ($hudText -match '(?m)^INDEPENDENTLY VERIFIED$')) @{ outcome = $o.Outcome; ms = $o.Ms }

    # Independent evidence: Notepad's own editor, read through UI Automation now.
    Start-Sleep -Milliseconds 500
    $np = @(Get-NotepadWindows)
    $text = if ($np.Count -eq 1) { Read-NotepadText $np[0] } else { $null }
    if ($np.Count -eq 1) { $launchedNotepadPid = $np[0].Current.ProcessId }
    Desktop-Shot "$OutDir\desktop-final.png"
    Record "Notepad's editor holds exactly '$Expected' (read by UI Automation, not by D-ASK)" ($np.Count -eq 1 -and $text -ceq $Expected) @{ windows = $np.Count; text = $text }
} catch {
    Record 'unexpected error' $false @{ error = "$($_.Exception.Message)" }
    try { Desktop-Shot "$OutDir\desktop-error.png"; Save-HudShot $script:hwnd "$OutDir\hud-error.png"; Set-Content -Encoding utf8 "$OutDir\hud-error.txt" (Get-HudText $script:hwnd) } catch { }
} finally {
    # Close only the Notepad THIS run opened (the one holding the demo text), then stop the packaged stack.
    try {
        foreach ($w in @(Get-NotepadWindows)) { if ($launchedNotepadPid -and $w.Current.ProcessId -eq $launchedNotepadPid) { Stop-Process -Id $launchedNotepadPid -Force -ErrorAction SilentlyContinue } }
    } catch { }
    Stop-All
    # Put Notepad's saved tab state back exactly as it was before the run (blank: the demonstration text is not left behind).
    try {
        Start-Sleep -Milliseconds 500
        if (Test-Path $npState) { Get-ChildItem $npState -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue }
        if ($npHadState) { Get-ChildItem $npSnapshot -File -ErrorAction SilentlyContinue | Copy-Item -Destination $npState -Force }
    } catch { }
    $real = Join-Path $env:LOCALAPPDATA 'D-ASK\memory.db'
    ConvertTo-Json -InputObject @($results.ToArray()) -Depth 6 | Set-Content -Encoding utf8 "$OutDir\verify-notepad.json"
    $failed = @($results | Where-Object { -not $_.pass }).Count
    "`n$(@($results | Where-Object { $_.pass }).Count) of $($results.Count) passed"
    if ($failed) { exit 1 }
}
