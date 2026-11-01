# D-ASK Stage 3 IPC Reconnect and Resilience Test
$ErrorActionPreference = "Stop"

$dotnetExe = "C:\Users\divya\.dotnet\dotnet.exe"
$daemonDll = "d:\D-ASK\D-ASK\src\DAsk.Daemon\bin\Debug\net8.0\DAsk.Daemon.dll"
$hudExe = "d:\D-ASK\D-ASK\src\hud-native\target\debug\hud-native.exe"
$hudLog = "d:\D-ASK\D-ASK\scratch\reconnect_hud.log"
$daemonLog = "d:\D-ASK\D-ASK\scratch\reconnect_daemon.log"

if (-not (Test-Path "d:\D-ASK\D-ASK\scratch")) {
    New-Item -ItemType Directory -Path "d:\D-ASK\D-ASK\scratch" -Force | Out-Null
}

if (Test-Path $hudLog) { Remove-Item $hudLog -Force }
if (Test-Path $daemonLog) { Remove-Item $daemonLog -Force }

Write-Output "=== TEST 1: Launch Initial Daemon ==="
$daemon1 = Start-Process -FilePath $dotnetExe -ArgumentList $daemonDll -PassThru -RedirectStandardOutput $daemonLog -RedirectStandardError "d:\D-ASK\D-ASK\scratch\reconnect_daemon_err.log"
Start-Sleep -Seconds 3

Write-Output "=== TEST 2: Launch HUD (Headless) ==="
$hud = Start-Process -FilePath $hudExe -ArgumentList "--headless" -PassThru -RedirectStandardError $hudLog
Start-Sleep -Seconds 4

Write-Output "=== TEST 3: Kill Daemon and observe HUD reconnect backoff ==="
Stop-Process -Id $daemon1.Id -Force
Start-Sleep -Seconds 4

Write-Output "=== TEST 4: Restart Daemon and observe HUD auto-reconnect & state restore ==="
$daemon2 = Start-Process -FilePath $dotnetExe -ArgumentList $daemonDll -PassThru -RedirectStandardOutput $daemonLog -RedirectStandardError "d:\D-ASK\D-ASK\scratch\reconnect_daemon_err.log"
Start-Sleep -Seconds 4

Write-Output "=== TEST 5: Clean Shutdown ==="
Stop-Process -Id $hud.Id -Force -ErrorAction SilentlyContinue
Stop-Process -Id $daemon2.Id -Force -ErrorAction SilentlyContinue

Write-Output "=== HUD RECONNECT TEST LOG ==="
if (Test-Path $hudLog) {
    Get-Content $hudLog
} else {
    Write-Error "HUD log not generated!"
}


