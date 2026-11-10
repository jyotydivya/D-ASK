# Removes a per-user D-ASK install and its shortcuts. Your data (%LOCALAPPDATA%\D-ASK: memory, workflows, approved plugins,
# undo records, logs) is KEPT unless -RemoveData is given, which asks for confirmation unless -Yes is also given.
#   powershell -ExecutionPolicy Bypass -File Uninstall-D-ASK.ps1 [-Destination <folder>] [-RemoveData] [-Yes]
param(
    [string]$Destination = (Join-Path $env:LOCALAPPDATA 'Programs\D-ASK'),
    [switch]$RemoveData,
    [switch]$Yes
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path (Join-Path $Destination 'package-manifest.json'))) { throw "$Destination does not look like a D-ASK install (no package-manifest.json); nothing was removed." }
$running = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($Destination, [StringComparison]::OrdinalIgnoreCase) }
if ($running) { throw "D-ASK is running from $Destination; close it first. Nothing was removed." }
foreach ($lnk in (Join-Path ([Environment]::GetFolderPath('Programs')) 'D-ASK.lnk'), (Join-Path ([Environment]::GetFolderPath('Startup')) 'D-ASK.lnk')) {
    if (Test-Path $lnk) { Remove-Item $lnk -Force; Write-Host "Removed $lnk" }
}
Remove-Item -LiteralPath $Destination -Recurse -Force
Write-Host "Removed $Destination"
$data = Join-Path $env:LOCALAPPDATA 'D-ASK'
if ($RemoveData -and (Test-Path $data)) {
    if (-not $Yes) { $a = Read-Host "Delete ALL D-ASK data in $data (memory, workflows, plugins, logs)? Type DELETE to confirm"; if ($a -ne 'DELETE') { Write-Host 'Data kept.'; return } }
    Remove-Item -LiteralPath $data -Recurse -Force
    Write-Host "Removed $data"
} elseif (Test-Path $data) { Write-Host "Your data was kept in $data" }
