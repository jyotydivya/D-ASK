# Clicks STOP during real inference exactly as the HUD's 5 s heartbeat comes due, against the real daemon.
# A session that drops here loses the task's real result. Starts and stops only its own processes.
param([string]$OutDir, [string]$HudExe, [int]$Count = 8)
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path "$PSScriptRoot\..\..").Path
. "$PSScriptRoot\hud-driver.ps1"
New-Item -ItemType Directory -Force $OutDir | Out-Null
# Set only for this process tree and this run, so a build outside the two allowed paths can connect.
if ($HudExe) { $env:DASK_Daemon__AllowedClientImagePaths__0 = $HudExe; $env:DASK_Daemon__AllowedClientImagePaths__1 = $HudExe }
$stackArgs = @{ OutDir = $OutDir; Root = $Root }
if ($HudExe) { $stackArgs.HudExe = $HudExe }
& "$PSScriptRoot\start-stack.ps1" @stackArgs | Out-Null
try {
    $pids = Get-Content "$OutDir\pids.json" -Raw | ConvertFrom-Json
    $hwnd = Get-HudHwnd $pids.hud
    Enter-HudInteractive $hwnd
    Start-Sleep -Seconds 2
    $h = [regex]::Match((Get-Content "$OutDir\hud.log" -Raw), '(\S+)Z\s+INFO\s+hud_native::ipc::client: Handshake accepted')
    $start = [datetime]::Parse($h.Groups[1].Value, $null, [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal)
    $Submit = 'What is 1+1?'
    Submit-HudRequest $hwnd $Submit
    [void](Wait-HudOutcome $hwnd 120000)
    $outcomes = @()
    for ($i = 1; $i -le $Count; $i++) {
        Submit-HudRequest $hwnd "What is $i*1000+$i?"
        [void](Wait-HudText $hwnd '(?m)^(PLANNING|UNDERSTANDING|EXECUTING)$' 30000)
        $stop = Find-HudButton $hwnd 'STOP \[Ctrl'
        # Reconnects restart the heartbeat, so its phase comes from the latest handshake.
        $last = [regex]::Matches((Get-Content "$OutDir\hud.log" -Raw), '(\S+)Z\s+INFO\s+hud_native::ipc::client: Handshake accepted')
        $start = [datetime]::Parse($last[$last.Count - 1].Groups[1].Value, $null, [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal)
        $wait = 5 - ((([datetime]::UtcNow - $start).TotalSeconds) % 5) - 0.14
        if ($wait -lt 0.05) { $wait += 5 }
        Start-Sleep -Milliseconds ([int]($wait * 1000))
        Click-HudElement $hwnd $stop
        $o = Wait-HudOutcome $hwnd 30000
        $outcomes += $o.Outcome
        Click-HudElement $hwnd (Find-HudButton $hwnd 'RESUME')
        [void](Find-HudButton $hwnd 'STOP \[Ctrl' 8000)
        Start-Sleep -Seconds 1
    }
    $log = "$OutDir\hud.log"
    $report = [pscustomobject]@{
        runs = $Count
        cancelled = @($outcomes | Where-Object { $_ -eq 'CANCELLED' }).Count
        otherOutcomes = @($outcomes | Where-Object { $_ -ne 'CANCELLED' })
        reconnects = @(Select-String -Path $log -Pattern 'Handshake accepted').Count - 1
        writeTimeouts = @(Select-String -Path $log -Pattern 'write timed out').Count
    }
    $report | ConvertTo-Json | Set-Content -Encoding utf8 "$OutDir\aligned-stops.json"
    $report | ConvertTo-Json -Compress
} finally {
    & "$PSScriptRoot\stop-stack.ps1" -OutDir $OutDir
}
