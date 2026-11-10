# Starts the real daemon and the real HUD with no allowlist overrides. Writes their process ids to -StateFile.
param(
    [string]$Config = 'Debug',
    [string]$OutDir,
    [string]$ModelId,
    [string]$HudExe,
    [string]$DaemonExe,
    [string]$Root
)
if (-not $Root) { $Root = (Resolve-Path "$PSScriptRoot\..\..").Path }
$hud = if ($HudExe) { $HudExe } else { Join-Path $Root "src\hud-native\target\$($Config.ToLower())\hud-native.exe" }
$daemon = if ($DaemonExe) { $DaemonExe } else { Join-Path $Root "src\DAsk.Daemon\bin\$Config\net8.0\DAsk.Daemon.exe" }
New-Item -ItemType Directory -Force $OutDir | Out-Null
$env:DASK_HUD_LOG = Join-Path $OutDir 'hud.log'
if ($ModelId) { $env:DASK_AgentHost__ModelId = $ModelId }
$d = Start-Process -FilePath $daemon -WorkingDirectory (Split-Path $daemon) -RedirectStandardOutput (Join-Path $OutDir 'daemon.log') -RedirectStandardError (Join-Path $OutDir 'daemon.err.log') -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 3
$h = Start-Process -FilePath $hud -WorkingDirectory $Root -PassThru
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    $p = Get-Process -Id $h.Id -ErrorAction SilentlyContinue
    if ($p -and $p.MainWindowHandle -ne 0) { break }
}
@{ daemon = $d.Id; hud = $h.Id } | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $OutDir 'pids.json')
"daemon=$($d.Id) hud=$($h.Id) hudExited=$($h.HasExited)"
