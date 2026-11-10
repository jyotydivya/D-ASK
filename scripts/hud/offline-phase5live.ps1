# The single Wi-Fi-off run of the Phase 5 live test. Run it yourself, from any folder, after turning Wi-Fi off:
#
#   powershell -ExecutionPolicy Bypass -File D:\D-ASK\D-ASK\scripts\hud\offline-phase5live.ps1
#
# To check the offline state without running the test (writes no files, changes nothing, never uses up the run):
#
#   powershell -ExecutionPolicy Bypass -File D:\D-ASK\D-ASK\scripts\hud\offline-phase5live.ps1 -PreflightOnly
#
# It does not change any network setting. If the machine is still online it stops WITHOUT running the test, and
# only a run where the test actually executed counts as the one approved run. The offline rules are in
# offline-preflight.ps1.
param([switch]$PreflightOnly)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\offline-preflight.ps1"

if ($PreflightOnly) {
    $evidence = Get-OfflineEvidence
    $decision = Test-OfflineEvidence $evidence
    Write-OfflineDecision $decision $evidence
    Write-Host "`nPreflight only: the test was not run, nothing was written, and the one-time run is still available."
    exit $(if ($decision.offline) { 0 } else { 2 })
}

$root = (Resolve-Path "$PSScriptRoot\..\..").Path
$out = Join-Path $root 'results\phase6\offline-live'
New-Item -ItemType Directory -Force $out | Out-Null
$done = Join-Path $out 'RUN-COMPLETED.txt'
if (Test-Path $done) { Write-Host "This test already ran once:`n$(Get-Content $done -Raw)`nNot running it again." -ForegroundColor Yellow; exit 0 }

$before = Get-OfflineEvidence
$decision = Test-OfflineEvidence $before
# Every preflight keeps its own record, so a refused one never overwrites another's evidence.
$stamp = (Get-Date).ToString('yyyyMMddTHHmmss')
[pscustomobject]@{ evidence = $before; decision = $decision } | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $out "preflight-$stamp.json")
Write-OfflineDecision $decision $before
if (-not $decision.offline) {
    Write-Host "The machine still looks online, so the test was NOT run and this does not use up the run." -ForegroundColor Red
    exit 2
}
Copy-Item (Join-Path $out "preflight-$stamp.json") (Join-Path $out 'network-before.json') -Force
Write-Host 'Offline confirmed. Running the test once...' -ForegroundColor Green

# Any connection these processes open to a non-loopback address during the test is recorded.
$monitor = Start-Job -ScriptBlock {
    param($file)
    $seen = @{}
    while ($true) {
        $names = 'node', 'llama-server', 'DAsk.Daemon', 'testhost', 'dotnet'
        $ids = @{}
        foreach ($p in Get-Process -Name $names -ErrorAction SilentlyContinue) { $ids[[int]$p.Id] = $p.ProcessName }
        foreach ($c in Get-NetTCPConnection -ErrorAction SilentlyContinue) {
            if ($ids.ContainsKey([int]$c.OwningProcess) -and $c.RemoteAddress -notmatch '^(127\.|::1$|0\.0\.0\.0$|::$)') {
                $key = "$($ids[[int]$c.OwningProcess])|$($c.RemoteAddress):$($c.RemotePort)|$($c.State)"
                if (-not $seen.ContainsKey($key)) { $seen[$key] = 1; Add-Content -Path $file -Value "$((Get-Date).ToString('o')) $key" }
            }
        }
        Set-Content -Path "$file.alive" -Value (Get-Date).ToString('o')
        Start-Sleep -Milliseconds 500
    }
} -ArgumentList (Join-Path $out 'non-loopback-connections.txt')

Push-Location $root
$started = Get-Date
$trx = Join-Path $out 'phase5live.trx'
try {
    $output = & dotnet test tests/DAsk.Daemon.Tests/DAsk.Daemon.Tests.csproj --filter "Category=Phase5Live" --logger "trx;LogFileName=$trx" --logger "console;verbosity=normal" 2>&1
    $code = $LASTEXITCODE
} finally {
    Pop-Location
    Stop-Job $monitor -ErrorAction SilentlyContinue
    Remove-Job $monitor -Force -ErrorAction SilentlyContinue
}
$output | Set-Content -Encoding utf8 (Join-Path $out 'dotnet-test.log')
$after = Get-OfflineEvidence
$afterDecision = Test-OfflineEvidence $after
[pscustomobject]@{ evidence = $after; decision = $afterDecision } | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $out 'network-after.json')
$connections = Join-Path $out 'non-loopback-connections.txt'
$connectionCount = if (Test-Path $connections) { @(Get-Content $connections).Count } else { 0 }

if (-not (Test-Path $trx)) {
    Write-Host "dotnet test ended (exit code $code) before running the test, so this does not count as the run." -ForegroundColor Red
    Write-Host "See $out\dotnet-test.log"
    exit 3
}
$stayedOffline = $afterDecision.offline
$summary = @(
    "started: $($started.ToString('o'))"
    "finished: $((Get-Date).ToString('o'))"
    "dotnet exit code: $code"
    "stayed offline for the whole run: $stayedOffline"
    "non-loopback connections seen: $connectionCount"
) -join "`n"
Set-Content -Encoding utf8 $done $summary
Write-Host "`n$summary"
Write-Host "`nDone. You can turn Wi-Fi back on and tell Claude the run finished." -ForegroundColor Green
exit $code
