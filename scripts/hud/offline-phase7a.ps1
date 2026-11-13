# Phase 7A with Wi-Fi off: the live filesystem test (real local model, synthetic project) on a machine with no network.
# Run it yourself after turning Wi-Fi off:
#
#   powershell -ExecutionPolicy Bypass -File D:\D-ASK\D-ASK\scripts\hud\offline-phase7a.ps1
#
# It changes no network setting. It refuses to run unless the offline preflight passes (offline-preflight.ps1:
# no connected interface, no usable default route, no connectivity reported by Windows, no probe connection).
# Unlike the Phase 5 run, this test can be repeated.
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\offline-preflight.ps1"
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
$out = Join-Path $root 'results\phase7a\offline-live'
New-Item -ItemType Directory -Force $out | Out-Null
$stamp = (Get-Date).ToString('yyyyMMddTHHmmss')

$before = Get-OfflineEvidence
$decision = Test-OfflineEvidence $before
[pscustomobject]@{ evidence = $before; decision = $decision } | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $out "preflight-$stamp.json")
Write-OfflineDecision $decision $before
if (-not $decision.offline) { Write-Host 'The machine still looks online, so the test was NOT run.' -ForegroundColor Red; exit 2 }

Push-Location $root
try {
    # --offline: npx must use its cache, never the registry.
    $log = & npx --offline tsx tests/agent-runtime/filesystem.live.ts --out (Join-Path $out "live-$stamp.json") 2>&1
    $code = $LASTEXITCODE
} finally { Pop-Location }
$log | Set-Content -Encoding utf8 (Join-Path $out "live-$stamp.log")
$after = Test-OfflineEvidence (Get-OfflineEvidence)
"stayed offline: $($after.offline)" | Add-Content (Join-Path $out "live-$stamp.log")
$log | Select-String -Pattern '^\[live\]|FAIL|passed' | ForEach-Object { $_.Line }
Write-Host "`nexit code $code; stayed offline: $($after.offline). Evidence in $out" -ForegroundColor Green
exit $code
