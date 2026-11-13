# Starts the real daemon and the real HUD with no allowlist overrides. Writes their process ids to -StateFile.
param(
    [string]$Config = 'Debug',
    [string]$OutDir,
    [string]$ModelId,
    [string]$HudExe,
    [string]$DaemonExe,
    [string]$Root,
    [switch]$ReapStale   # stop left-over stacks that an acceptance launcher provably started (pids.json); anything else still blocks
)
if (-not $Root) { $Root = (Resolve-Path "$PSScriptRoot\..\..").Path }
$hud = if ($HudExe) { $HudExe } else { Join-Path $Root "src\hud-native\target\$($Config.ToLower())\hud-native.exe" }
$daemon = if ($DaemonExe) { $DaemonExe } else { Join-Path $Root "src\DAsk.Daemon\bin\$Config\net8.0\DAsk.Daemon.exe" }
New-Item -ItemType Directory -Force $OutDir | Out-Null

# A left-over daemon keeps the exclusive pipe and would silently serve this run with the PREVIOUS run's environment (store, journal, flags).
. "$PSScriptRoot\stack-guard.ps1"
$all = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in $script:StackExeNames })
if ($all.Count) {
    $pidFiles = @(Get-ChildItem (Join-Path $Root 'results') -Recurse -Filter pids.json -ErrorAction SilentlyContinue | ForEach-Object {
        try { $j = Get-Content $_.FullName -Raw | ConvertFrom-Json; [pscustomobject]@{ Path = $_.FullName; WrittenUtc = $_.LastWriteTimeUtc; Daemon = [int]$j.daemon; Hud = [int]$j.hud } } catch { } })
    $conflict = Get-StackConflict $all $pidFiles
    if ($conflict.blocking.Count -or ($conflict.reapable.Count -and -not $ReapStale)) {
        $list = (@($conflict.blocking + $conflict.reapable) | ForEach-Object { "$($_.Name) $($_.ProcessId)$(if ($_.Owner) { " (left by $($_.Owner))" } else { ' (not started by an acceptance launcher)' })" }) -join '; '
        throw "A D-ASK stack is already running: $list. Not starting another (it would keep the pipe and the previous environment). Stop it, or for stacks left by an acceptance run pass -ReapStale."
    }
    foreach ($r in $conflict.reapable) {
        Write-Host "reaping left-over $($r.Name) $($r.ProcessId) (recorded in $($r.Owner))"
        taskkill /PID $r.ProcessId /T /F 2>$null | Out-Null
    }
    if ($conflict.reapable.Count) { Start-Sleep -Seconds 2 }
}
$env:DASK_HUD_LOG = Join-Path $OutDir 'hud.log'
if ($ModelId) { $env:DASK_AgentHost__ModelId = $ModelId }
$d = Start-Process -FilePath $daemon -WorkingDirectory (Split-Path $daemon) -RedirectStandardOutput (Join-Path $OutDir 'daemon.log') -RedirectStandardError (Join-Path $OutDir 'daemon.err.log') -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 3
$bad = Get-DaemonStartViolation ([bool](Get-Process -Id $d.Id -ErrorAction SilentlyContinue)) (Get-Content (Join-Path $OutDir 'daemon.log') -Raw -ErrorAction SilentlyContinue) $d.Id
if ($bad) { throw "start-stack: $bad. See $(Join-Path $OutDir 'daemon.log')." }
$h = Start-Process -FilePath $hud -WorkingDirectory $Root -PassThru
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    $p = Get-Process -Id $h.Id -ErrorAction SilentlyContinue
    if ($p -and $p.MainWindowHandle -ne 0) { break }
}
@{ daemon = $d.Id; hud = $h.Id } | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $OutDir 'pids.json')
"daemon=$($d.Id) hud=$($h.Id) hudExited=$($h.HasExited)"
