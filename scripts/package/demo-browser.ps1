# Real-HUD demonstration of BROWSER AUTOMATION on the PACKAGED D-ASK (needs the internet: it reads real public sites).
#   1. READ: "What is the title of https://example.com and its contents?" -> the packaged host opens Microsoft Edge (headless, locked to that site),
#      loads the page, and the result shows the page's own title and text, verified against what the browser actually loaded.
#   2. ACT (each protected action needs its own approval card): on https://httpbin.org/forms/post type a name into the Customer name field, then click
#      Submit order. The result is checked from the browser's own observation, and the site's response page is saved as a screenshot.
# -PackageRoot is a throwaway copy of a built package.
#   powershell -ExecutionPolicy Bypass -File scripts\package\demo-browser.ps1 -PackageRoot <copy> -OutDir results\packaging\browser-<stamp>
param([Parameter(Mandatory = $true)][string]$PackageRoot, [Parameter(Mandatory = $true)][string]$OutDir, [switch]$SkipAction)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\..\hud\hud-driver.ps1"
. "$PSScriptRoot\demo-common.ps1"
if ((Test-Path $OutDir) -and @(Get-ChildItem $OutDir -Force).Count -gt 0) { throw "OutDir must be new or empty: $OutDir" }
New-Item -ItemType Directory -Force $OutDir | Out-Null
$script:OutDir = (Resolve-Path $OutDir).Path
$script:PackageRoot = (Resolve-Path $PackageRoot).Path
$script:results = New-Object System.Collections.ArrayList
$env:DASK_AgentHost__ExtraEnvironment__DASK_MEMORY_DB = Join-Path $script:OutDir 'memory.db'
$evDir = Join-Path $env:LOCALAPPDATA 'D-ASK\browser-evidence'
$evBefore = @(if (Test-Path $evDir) { Get-ChildItem $evDir -File -Recurse | ForEach-Object FullName })
try {
    $avail = [int]((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1024)
    $online = [bool](Test-NetConnection example.com -Port 443 -WarningAction SilentlyContinue).TcpTestSucceeded
    Record 'the machine is online (this demonstration reads real public sites)' $online @{ availableMB = $avail }
    if (-not $online) { throw 'no internet connection' }
    Start-Packaged
    Record 'the packaged app started from its own launcher' ([bool](Find-Proc 'DAsk.Daemon.exe')) @{ package = $script:PackageRoot }

    # 1. READ
    $r1 = Invoke-DemoRequest 'What is the title of https://example.com and its contents?' @() 'read'
    $hit = ($r1.text -match 'Example Domain') -and ($r1.text -match 'https://example\.com/') -and ($r1.text -match 'HTTP 200')
    Record 'browser READ: the page was really loaded; its own title and address are shown, COMPLETED and INDEPENDENTLY VERIFIED' (($r1.outcome -eq 'COMPLETED') -and $r1.verified -and $hit) @{ outcome = $r1.outcome; verified = $r1.verified; titleAndStatusShown = $hit; ms = $r1.ms }

    # 2. ACT (two approvals)
    if (-not $SkipAction) {
        $req = 'On https://httpbin.org/forms/post, type "Alice" into the Customer name field, then click the Submit order button'
        $r2 = Invoke-DemoRequest $req @('Fill one field', 'Click one element') 'act' 240000
        Record 'browser ACT: fill card (site, field, exact text) and click card were both shown and approved separately, in order' (@($r2.cards | Where-Object { $_.shown }).Count -eq 2) @{ cards = @($r2.cards | ForEach-Object { @{ pattern = $_.pattern; shown = $_.shown } }) }
        Record 'browser ACT: result COMPLETED and INDEPENDENTLY VERIFIED' (($r2.outcome -eq 'COMPLETED') -and $r2.verified) @{ outcome = $r2.outcome; verified = $r2.verified; ms = $r2.ms }
        $newEv = @(if (Test-Path $evDir) { Get-ChildItem $evDir -File -Recurse | Where-Object { $evBefore -notcontains $_.FullName } })
        foreach ($f in $newEv) { Copy-Item $f.FullName (Join-Path $script:OutDir ("browser-evidence-" + $f.Directory.Name.Substring(0, 8) + "-" + $f.Name)) }
        Record 'the browser saved screenshot evidence of the acted-on pages' ($newEv.Count -ge 1) @{ files = @($newEv | ForEach-Object Name) }
    }
} catch {
    Record 'unexpected error' $false @{ error = "$($_.Exception.Message)" }
    try { Desktop-Shot "$script:OutDir\desktop-error.png"; Save-HudShot $script:hwnd "$script:OutDir\hud-error.png"; Set-Content -Encoding utf8 "$script:OutDir\hud-error.txt" (Get-HudText $script:hwnd) } catch { }
} finally {
    Stop-Packaged
    $failed = Save-DemoResults 'demo-browser'
    if ($failed) { exit 1 }
}
