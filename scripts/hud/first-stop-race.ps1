# The first Emergency Stop on a fresh daemon takes about 180 ms (the audit store initialises), and during it the
# daemon's read loop is busy. This clicks that first stop just before the HUD's 5 s heartbeat is due, on a new
# daemon each round, and counts dropped sessions. No task or model is needed. Starts and stops only its own processes.
param([string]$OutDir, [string]$HudExe, [int]$Rounds = 12)
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path "$PSScriptRoot\..\..").Path
. "$PSScriptRoot\hud-driver.ps1"
if ($HudExe) { $env:DASK_Daemon__AllowedClientImagePaths__0 = $HudExe; $env:DASK_Daemon__AllowedClientImagePaths__1 = $HudExe }
$offsets = 0.28, 0.24, 0.20, 0.16
$rows = @()
for ($r = 1; $r -le $Rounds; $r++) {
    $dir = Join-Path $OutDir "round-$r"
    $stackArgs = @{ OutDir = $dir; Root = $Root }
    if ($HudExe) { $stackArgs.HudExe = $HudExe }
    & "$PSScriptRoot\start-stack.ps1" @stackArgs | Out-Null
    try {
        $pids = Get-Content "$dir\pids.json" -Raw | ConvertFrom-Json
        $hwnd = Get-HudHwnd $pids.hud
        Enter-HudInteractive $hwnd
        Start-Sleep -Seconds 1
        $h = [regex]::Match((Get-Content "$dir\hud.log" -Raw), '(\S+)Z\s+INFO\s+hud_native::ipc::client: Handshake accepted')
        $start = [datetime]::Parse($h.Groups[1].Value, $null, [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal)
        $stop = Find-HudButton $hwnd 'STOP \[Ctrl'
        $offset = $offsets[($r - 1) % $offsets.Count]
        $wait = 5 - ((([datetime]::UtcNow - $start).TotalSeconds) % 5) - $offset
        if ($wait -lt 0.05) { $wait += 5 }
        Start-Sleep -Milliseconds ([int]($wait * 1000))
        Click-HudElement $hwnd $stop
        Start-Sleep -Seconds 2
        $rows += [pscustomobject]@{
            round = $r; offset = $offset
            stopReceived = [bool](Select-String -Path "$dir\hud.log" -Pattern 'Emergency Stop requested' -Quiet)
            writeTimeouts = @(Select-String -Path "$dir\hud.log" -Pattern 'write timed out').Count
            reconnects = @(Select-String -Path "$dir\hud.log" -Pattern 'Handshake accepted').Count - 1
        }
    } finally {
        & "$PSScriptRoot\stop-stack.ps1" -OutDir $dir | Out-Null
    }
}
$rows | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $OutDir 'first-stop-race.json')
$rows | ForEach-Object { "round $($_.round) offset $($_.offset): stop=$($_.stopReceived) timeouts=$($_.writeTimeouts) reconnects=$($_.reconnects)" }
"TOTAL dropped sessions: $(@($rows | Where-Object { $_.reconnects -gt 0 }).Count) of $Rounds"
