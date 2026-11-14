# Registers (or removes) the D-ASK Chrome native-messaging host for the CURRENT user only (HKCU; no administrator rights).
# Chrome will start dask-chrome-host.exe ONLY for the D-ASK extension origin listed below; the host only relays to the D-ASK daemon's
# user-only broker pipe. No TCP port, no debugging port.
#   powershell -ExecutionPolicy Bypass -File scripts\chrome\register-native-host.ps1 [-HostExe <path>] [-Unregister]
param([string]$HostExe, [switch]$Unregister)
$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$key = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.dask.chrome'
$dir = Join-Path $env:LOCALAPPDATA 'D-ASK\chrome'
$manifestPath = Join-Path $dir 'com.dask.chrome.json'
if ($Unregister) {
    if (Test-Path $key) { Remove-Item $key -Force }
    if (Test-Path $manifestPath) { Remove-Item $manifestPath -Force }
    Write-Output 'D-ASK native host unregistered.'
    return
}
if (-not $HostExe) { $HostExe = Join-Path $repo 'src\DAsk.ChromeHost\bin\Release\net8.0\dask-chrome-host.exe' }
$HostExe = (Resolve-Path $HostExe).Path
$id = (Get-Content (Join-Path $repo 'extensions\dask-chrome\key.json') -Raw | ConvertFrom-Json).id
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$manifest = [ordered]@{
    name = 'com.dask.chrome'
    description = 'D-ASK local assistant bridge (relays to the D-ASK daemon on this computer only)'
    path = $HostExe
    type = 'stdio'
    allowed_origins = @("chrome-extension://$id/")
}
[System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 3), (New-Object System.Text.UTF8Encoding($false)))
New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name '(default)' -Value $manifestPath
Write-Output "Registered com.dask.chrome for extension $id -> $HostExe"
Write-Output "Manifest: $manifestPath"
