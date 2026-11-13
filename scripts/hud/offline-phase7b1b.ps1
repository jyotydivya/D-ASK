# Phase 7B.1b live run (read-only desktop intelligence) with Wi-Fi OFF. Run it yourself after turning Wi-Fi off:
#
#   powershell -ExecutionPolicy Bypass -File D:\D-ASK\D-ASK\scripts\hud\offline-phase7b1b.ps1
#
# Preflight only (changes nothing, writes nothing):
#
#   powershell -ExecutionPolicy Bypass -File D:\D-ASK\D-ASK\scripts\hud\offline-phase7b1b.ps1 -PreflightOnly
#
# -OnlineLoopbackCheck runs the same live test while ONLINE and records every non-loopback connection the D-ASK
# processes open. It is NOT an offline test and is stored separately (results\phase7b1b\online-loopback-check).
#
# The test is Category=Phase7B1bLive: real daemon, real agent host, real local model, real Win32/UI Automation
# observation, restricted to disposable fixture windows it creates. Nothing is clicked, typed or focused.
# This script never changes a network setting and never touches Phase 6 or Phase 7A evidence.
param([switch]$PreflightOnly, [switch]$OnlineLoopbackCheck)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\offline-preflight.ps1"
$root = (Resolve-Path "$PSScriptRoot\..\..").Path

if ($PreflightOnly) {
    $evidence = Get-OfflineEvidence
    $decision = Test-OfflineEvidence $evidence
    Write-OfflineDecision $decision $evidence
    Write-Host "`nPreflight only: the test was not run and nothing was written."
    exit $(if ($decision.offline) { 0 } else { 2 })
}

$stamp = (Get-Date).ToString('yyyyMMddTHHmmss')
$out = Join-Path $root ($(if ($OnlineLoopbackCheck) { 'results\phase7b1b\online-loopback-check' } else { 'results\phase7b1b\offline-live' }))
$out = Join-Path $out $stamp
New-Item -ItemType Directory -Force $out | Out-Null

# The online check skips the probe: it is known to be online and must not be mistaken for an offline run.
$before = if ($OnlineLoopbackCheck) { Get-OfflineEvidence -SkipProbe } else { Get-OfflineEvidence }
$decision = Test-OfflineEvidence $before
[pscustomobject]@{ mode = $(if ($OnlineLoopbackCheck) { 'online-loopback-check' } else { 'offline' }); evidence = $before; decision = $decision } |
    ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $out 'network-before.json')
Write-OfflineDecision $decision $before
if (-not $OnlineLoopbackCheck -and -not $decision.offline) {
    Write-Host "The machine still looks online, so the test was NOT run. Turn Wi-Fi off and try again." -ForegroundColor Red
    exit 2
}
if ($OnlineLoopbackCheck) { Write-Host 'ONLINE loopback check (not an offline test). Running the live test...' -ForegroundColor Yellow }
else { Write-Host 'Offline confirmed. Running the live test...' -ForegroundColor Green }

# Any connection a D-ASK process opens to a non-loopback address during the run is recorded.
$connections = Join-Path $out 'non-loopback-connections.txt'
$monitor = Start-Job -ScriptBlock {
    param($file)
    $seen = @{}
    while ($true) {
        $ids = @{}
        foreach ($p in Get-Process -Name 'node', 'llama-server', 'DAsk.Daemon', 'testhost' -ErrorAction SilentlyContinue) { $ids[[int]$p.Id] = $p.ProcessName }
        foreach ($c in Get-NetTCPConnection -ErrorAction SilentlyContinue) {
            if ($ids.ContainsKey([int]$c.OwningProcess) -and $c.RemoteAddress -notmatch '^(127\.|::1$|0\.0\.0\.0$|::$)') {
                $key = "$($ids[[int]$c.OwningProcess])|$($c.RemoteAddress):$($c.RemotePort)|$($c.State)"
                if (-not $seen.ContainsKey($key)) { $seen[$key] = 1; Add-Content -Path $file -Value "$((Get-Date).ToString('o')) $key" }
            }
        }
        foreach ($p in Get-Process -Name 'llama-server', 'DAsk.Daemon' -ErrorAction SilentlyContinue) {
            $k = "seen|$($p.ProcessName)|$($p.Id)"
            if (-not $seen.ContainsKey($k)) { $seen[$k] = 1; Add-Content -Path "$file.processes" -Value "$((Get-Date).ToString('o')) $($p.ProcessName) pid $($p.Id)" }
        }
        Start-Sleep -Milliseconds 250
    }
} -ArgumentList $connections

Push-Location $root
$started = Get-Date
$trx = Join-Path $out 'phase7b1b-live.trx'
try {
    $output = & dotnet test tests/DAsk.Daemon.Tests/DAsk.Daemon.Tests.csproj --no-build --filter "Category=Phase7B1bLive" --logger "trx;LogFileName=$trx" --logger "console;verbosity=detailed" 2>&1
    $code = $LASTEXITCODE
} finally {
    Pop-Location
    Stop-Job $monitor -ErrorAction SilentlyContinue
    Remove-Job $monitor -Force -ErrorAction SilentlyContinue
}
$output | Set-Content -Encoding utf8 (Join-Path $out 'dotnet-test.log')
$after = if ($OnlineLoopbackCheck) { Get-OfflineEvidence -SkipProbe } else { Get-OfflineEvidence }
$afterDecision = Test-OfflineEvidence $after
[pscustomobject]@{ evidence = $after; decision = $afterDecision } | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $out 'network-after.json')
$connectionCount = if (Test-Path $connections) { @(Get-Content $connections).Count } else { 0 }
$processes = if (Test-Path "$connections.processes") { @(Get-Content "$connections.processes") } else { @() }

$summary = @(
    "mode: $(if ($OnlineLoopbackCheck) { 'ONLINE loopback check (not offline)' } else { 'Wi-Fi off' })"
    "started: $($started.ToString('o'))"
    "finished: $((Get-Date).ToString('o'))"
    "dotnet exit code: $code"
    "test executed: $(Test-Path $trx)"
    "offline before: $($decision.offline); offline after: $($afterDecision.offline)"
    "D-ASK processes observed: $($processes.Count)"
    "non-loopback connections by D-ASK processes: $connectionCount"
) -join "`n"
Set-Content -Encoding utf8 (Join-Path $out 'SUMMARY.txt') $summary
Write-Host "`n$summary"
Write-Host "Evidence: $out"
exit $code
