# Per-user install of a built D-ASK package (no administrator rights, nothing outside the user's profile).
#   powershell -ExecutionPolicy Bypass -File Install-D-ASK.ps1 [-Destination <folder>] [-NoShortcut] [-Autostart]
# Run it from the package folder. It copies the package, verifies every file against package-manifest.json and the
# manifest's hash pinned in the daemon's appsettings.json (the same check the daemon makes before starting the agent
# host), creates a Start Menu shortcut, and optionally starts D-ASK at sign-in. It refuses to overwrite a running install.
param(
    [string]$Destination = (Join-Path $env:LOCALAPPDATA 'Programs\D-ASK'),
    [switch]$NoShortcut,
    [switch]$Autostart
)
$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
$daemonRel = 'src\DAsk.Daemon\bin\Release\net8.0'
function Sha([string]$p) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() }
function Verify([string]$root) {
    $manifestPath = Join-Path $root 'package-manifest.json'
    if (-not (Test-Path $manifestPath)) { throw "No package-manifest.json in $root" }
    $settings = Get-Content (Join-Path $root "$daemonRel\appsettings.json") -Raw | ConvertFrom-Json
    if ((Sha $manifestPath) -ne ([string]$settings.AgentHost.ManifestSha256).ToLowerInvariant()) { throw 'The manifest hash does not match the daemon settings' }
    $m = Get-Content $manifestPath -Raw | ConvertFrom-Json
    $bad = @($m.files | Where-Object { $p = Join-Path $root $_.path; -not (Test-Path -LiteralPath $p) -or (Sha $p) -ne $_.sha256 })
    if ($bad.Count) { throw "$($bad.Count) file(s) differ from the manifest, e.g. $($bad[0].path)" }
    return $m.files.Count
}

$n = Verify $src
Write-Host "Package verified: $n files match the manifest."
if ([IO.Path]::GetFullPath($Destination).TrimEnd('\') -eq [IO.Path]::GetFullPath($src).TrimEnd('\')) { throw 'Destination is the package folder itself.' }
$running = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($Destination, [StringComparison]::OrdinalIgnoreCase) }
if ($running) { throw "D-ASK is running from $Destination ($(@($running).Count) process(es)); close it first." }
New-Item -ItemType Directory -Force $Destination | Out-Null
robocopy $src $Destination /MIR /NFL /NDL /NJH /NJS /NP /XF 'Install-D-ASK.ps1' | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Copy failed (robocopy $LASTEXITCODE)" }
Copy-Item (Join-Path $src 'Install-D-ASK.ps1') $Destination -Force
$n = Verify $Destination
Write-Host "Installed to $Destination and verified ($n files)."

$launcher = Join-Path $Destination 'Start-D-ASK.cmd'
$shell = New-Object -ComObject WScript.Shell
if (-not $NoShortcut) {
    $lnk = Join-Path ([Environment]::GetFolderPath('Programs')) 'D-ASK.lnk'
    $s = $shell.CreateShortcut($lnk); $s.TargetPath = $launcher; $s.WorkingDirectory = $Destination
    $s.IconLocation = (Join-Path $Destination 'src\hud-native\target\release\hud-native.exe') + ',0'; $s.Description = 'D-ASK desktop assistant (offline)'; $s.Save()
    Write-Host "Start Menu shortcut: $lnk"
}
if ($Autostart) {
    $lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'D-ASK.lnk'
    $s = $shell.CreateShortcut($lnk); $s.TargetPath = $launcher; $s.WorkingDirectory = $Destination; $s.WindowStyle = 7; $s.Save()
    Write-Host "Starts at sign-in: $lnk"
}
Write-Host 'Done. Start D-ASK from the Start Menu (or run Start-D-ASK.cmd). Your data stays in %LOCALAPPDATA%\D-ASK.'
