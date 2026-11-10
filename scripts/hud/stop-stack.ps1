# Stops only the processes start-stack.ps1 started, then reports any D-ASK process that is still running.
param([string]$OutDir)
$p = Get-Content (Join-Path $OutDir 'pids.json') -Raw | ConvertFrom-Json
foreach ($id in @($p.hud, $p.daemon)) {
    if (Get-Process -Id $id -ErrorAction SilentlyContinue) { taskkill /PID $id /T /F 2>$null | Out-Null }
}
Start-Sleep -Seconds 1
$left = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -in 'llama-server.exe', 'DAsk.Daemon.exe', 'hud-native.exe' -or ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'stdioHost')
}
"still running: $(@($left).Count)"
$left | ForEach-Object { "  $($_.Name) $($_.ProcessId)" }
