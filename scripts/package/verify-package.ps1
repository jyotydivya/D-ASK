# Verifies a built package from outside the repository. Uses the real launcher, the real HUD and real input.
# -PackageRoot must be a throwaway copy: this changes files in it to check they are refused, then restores them.
param([string]$PackageRoot, [string]$OutDir)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\..\hud\hud-driver.ps1"
New-Item -ItemType Directory -Force $OutDir | Out-Null
$env:PATH = (($env:PATH -split ';') | Where-Object { $_ -notmatch 'nodejs' }) -join ';'
$results = New-Object System.Collections.ArrayList
function Record([string]$Name, [bool]$Pass, $Detail) {
    [void]$results.Add([pscustomobject]@{ name = $Name; pass = $Pass; detail = $Detail })
    "{0}  {1}  {2}" -f $(if ($Pass) { ' ok ' } else { 'FAIL' }), $Name, ($Detail | ConvertTo-Json -Compress -Depth 4)
}
function Find-Proc([string]$ExeTail) { Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.EndsWith($ExeTail, [StringComparison]::OrdinalIgnoreCase) -and $_.ExecutablePath.StartsWith($PackageRoot, [StringComparison]::OrdinalIgnoreCase) } }

function Start-ViaLauncher {
    Start-Process -FilePath "$PackageRoot\Start-D-ASK.cmd" -WindowStyle Hidden | Out-Null
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 500
        $h = Find-Proc 'hud-native.exe'
        if ($h) { $p = Get-Process -Id $h.ProcessId -ErrorAction SilentlyContinue; if ($p -and $p.MainWindowHandle -ne 0) { break } }
    }
    $script:daemon = Find-Proc 'DAsk.Daemon.exe'
    $script:hud = Find-Proc 'hud-native.exe'
    if (-not $script:daemon -or -not $script:hud) { throw 'The launcher did not start both processes' }
    $script:hwnd = Get-HudHwnd $script:hud.ProcessId
    Enter-HudInteractive $script:hwnd
    Start-Sleep -Seconds 2
}
function Stop-All {
    foreach ($n in 'hud-native.exe', 'DAsk.Daemon.exe') { $x = Find-Proc $n; if ($x) { taskkill /PID $x.ProcessId /T /F 2>$null | Out-Null } }
    for ($i = 0; $i -lt 40 -and (Find-Proc 'node.exe'); $i++) { Start-Sleep -Milliseconds 250 }
}
function Task([string]$Text) {
    Submit-HudRequest $hwnd $Text
    Start-Sleep -Milliseconds 300
    return Wait-HudOutcome $hwnd 180000
}
function Check-Tamper([string]$Name, [scriptblock]$Tamper, [scriptblock]$Restore, [string]$Expect, [string]$Request, [string]$Request2) {
    $dir = Join-Path $OutDir ($Name -replace '\W','-')
    & $Tamper
    try {
        # Started with logs on, so the daemon's stated reason can be checked.
        & "$PSScriptRoot\..\hud\start-stack.ps1" -OutDir $dir -Config Release -Root $PackageRoot | Out-Null
        $pids = Get-Content "$dir\pids.json" -Raw | ConvertFrom-Json
        $script:hwnd = Get-HudHwnd $pids.hud
        Enter-HudInteractive $hwnd
        Start-Sleep -Seconds 2
        Submit-HudRequest $hwnd $Request
        # The daemon's decision comes first, so nothing is restored before the check has really run.
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $reason = $null
        do {
            Start-Sleep -Milliseconds 100
            $reason = Select-String -Path "$dir\daemon.log" -Pattern 'Package check (failed|passed)' | Select-Object -First 1
        } while (-not $reason -and $sw.ElapsedMilliseconds -lt 30000)
        Start-Sleep -Milliseconds 1500
        # History is kept across runs and listed newest first, so only the first row for this request counts.
        $lines = (Get-HudText $hwnd) -split "`n"
        $row = [Array]::IndexOf($lines, $Request.ToUpper())
        $shown = ($row -ge 0) -and ($lines[$row + 1] -match 'could not be started')
        $nodeRan = [bool](Find-Proc 'node.exe')
        Save-HudShot $hwnd "$dir\refused.png"
        $reasonOk = $reason -and ($reason.Line -match 'Package check failed') -and ($reason.Line -match $Expect)
        Record "$Name stops the host" ($shown -and -not $nodeRan -and $reasonOk) @{ shownInHud = $shown; nodeStarted = $nodeRan; reason = $(if ($reason) { $reason.Line.Substring($reason.Line.IndexOf('Package check')) } else { $null }) }
        & $Restore
        Start-Sleep -Seconds 6
        $o2 = Task $Request2
        $lines = (Get-HudText $hwnd) -split "`n"
        Save-HudShot $hwnd "$dir\recovered.png"
        Record "after restoring, $Name recovers without a restart" ($o2.Outcome -eq 'COMPLETED') @{ outcome = $o2.Outcome; passed = @(Select-String -Path "$dir\daemon.log" -Pattern 'Package check passed').Count; lastError = @(Select-String -Path "$dir\daemon.log" -Pattern 'fail:|Host unavailable|Failed to' | Select-Object -Last 2 | ForEach-Object { $_.Line }) }
    } finally {
        if (Test-Path "$dir\pids.json") { & "$PSScriptRoot\..\hud\stop-stack.ps1" -OutDir $dir | Out-Null }
        for ($i = 0; $i -lt 40 -and (Find-Proc 'node.exe'); $i++) { Start-Sleep -Milliseconds 250 }
        & $Restore
    }
}

# 1. The real launcher, the packaged Node
Start-ViaLauncher
$o = Task 'What is (17+25)*2?'
$node = Find-Proc 'node.exe'
$llama = Find-Proc 'llama-server.exe'
Save-HudShot $hwnd "$OutDir\launcher-completed.png"
Record 'Start-D-ASK.cmd starts the stack and a task completes with verification' (($o.Outcome -eq 'COMPLETED') -and ((Get-HudText $hwnd) -match '(?m)^INDEPENDENTLY VERIFIED$')) @{ outcome = $o.Outcome; ms = $o.Ms }
Record 'the host runs on the packaged Node, not a system one' ($node -and $node.ExecutablePath -eq "$PackageRoot\runtime\node\node.exe") @{ node = $node.ExecutablePath }
Record 'llama-server runs from the package' ([bool]$llama) @{ exe = $llama.ExecutablePath }
Stop-All

# 2. Every kind of change must stop the host, on the real daemon
$hostJs = "$PackageRoot\dist\agent-host\agent\host\host.js"
$nodeExe = "$PackageRoot\runtime\node\node.exe"
$extra = "$PackageRoot\dist\agent-host\agent\host\injected.js"
$manifest = "$PackageRoot\package-manifest.json"
$hostBackup = "$OutDir\host.js.bak"; $nodeBackup = "$OutDir\node.exe.bak"; $manifestBackup = "$OutDir\manifest.bak"
Copy-Item $hostJs $hostBackup -Force; Copy-Item $nodeExe $nodeBackup -Force; Copy-Item $manifest $manifestBackup -Force

Check-Tamper 'a changed host file' { Add-Content -Path $hostJs -Value '// changed' } { Copy-Item $hostBackup $hostJs -Force } 'changed' 'What is 2+3?' 'What is 12+13?'
Check-Tamper 'a changed Node runtime' { $fs = [IO.File]::Open($nodeExe, 'Append'); $fs.WriteByte(0); $fs.Close() } { Copy-Item $nodeBackup $nodeExe -Force } 'changed' 'What is 4+5?' 'What is 14+15?'
Check-Tamper 'an added host file' { Set-Content -Path $extra -Value 'module.exports = {}' } { Remove-Item $extra -Force -ErrorAction SilentlyContinue } 'Unexpected' 'What is 6+7?' 'What is 16+17?'
Check-Tamper 'an edited manifest' { Add-Content -Path $manifest -Value ' ' } { Copy-Item $manifestBackup $manifest -Force } 'expected hash' 'What is 8+9?' 'What is 18+19?'

$results | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 "$OutDir\verify-package.json"
"`n$(@($results | Where-Object pass).Count) of $($results.Count) passed"
