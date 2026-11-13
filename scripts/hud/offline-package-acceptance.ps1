# Wi-Fi-OFF demonstration of the PACKAGED D-ASK (scripts\package\demo-offline.ps1, unchanged) under a monitor of EVERY process in the D-ASK trees.
# Run through the radio wrapper, with the package named in the environment:
#   $env:DASK_DEMO_PACKAGE = 'D:\D-ASK\D-ASK\dist\desktop\throwaway-verify-<stamp>'
#   powershell -ExecutionPolicy Bypass -File D:\D-ASK\D-ASK\scripts\hud\run-offline-acceptance-7b3.ps1 -AcceptanceScript offline-package-acceptance.ps1 -ScriptTimeoutMin 30
# Exit 0 only if every check passed, the radio was offline before and after, and 0 non-loopback connections were seen. (Same structure as offline-timed-acceptance.ps1.)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\offline-preflight.ps1"
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
$pkg = $env:DASK_DEMO_PACKAGE
if (-not $pkg -or -not (Test-Path "$pkg\Start-D-ASK.cmd")) { throw 'Set $env:DASK_DEMO_PACKAGE to a throwaway copy of a built package (it must contain Start-D-ASK.cmd).' }
$out = Join-Path $root "results\offline-package\$((Get-Date).ToString('yyyyMMddTHHmmss'))"
New-Item -ItemType Directory -Force $out | Out-Null
$before = Get-OfflineEvidence; $d0 = Test-OfflineEvidence $before
[pscustomobject]@{ evidence = $before; decision = $d0 } | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $out 'network-before.json')
if (-not $d0.offline) { Write-OfflineDecision $d0 $before; Write-Host 'Online: the acceptance was NOT run.' -ForegroundColor Red; exit 2 }

$connections = Join-Path $out 'non-loopback-connections.txt'
$monitor = Start-Job -ScriptBlock {
    param($file, $treeHelper)
    . $treeHelper
    $seen = @{}
    while ($true) {
        $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
        $tree = Get-DAskProcessTree $all
        foreach ($c in Get-NetTCPConnection -ErrorAction SilentlyContinue) {
            if ($tree.ContainsKey([int]$c.OwningProcess) -and $c.RemoteAddress -notmatch '^(127\.|::1$|0\.0\.0\.0$|::$)') {
                $key = "$($tree[[int]$c.OwningProcess])|$($c.RemoteAddress):$($c.RemotePort)|$($c.State)"
                if (-not $seen.ContainsKey($key)) { $seen[$key] = 1; Add-Content -Path $file -Value "$((Get-Date).ToString('o')) $key pid=$($c.OwningProcess)" }
            }
        }
        foreach ($id in $tree.Keys) { $k = "p|$id"; if (-not $seen.ContainsKey($k)) { $seen[$k] = 1; Add-Content -Path "$file.processes" -Value "$((Get-Date).ToString('o')) $($tree[$id]) pid $id" } }
        Start-Sleep -Milliseconds 300
    }
} -ArgumentList $connections, (Join-Path $PSScriptRoot 'dask-process-tree.ps1')
$dir = Join-Path $out 'demo'
try {
    $ErrorActionPreference = 'Continue'
    $log = & powershell -NoProfile -ExecutionPolicy Bypass -File "$root\scripts\package\demo-offline.ps1" -PackageRoot $pkg -OutDir $dir 2>&1
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
} finally { Stop-Job $monitor -ErrorAction SilentlyContinue; Remove-Job $monitor -Force -ErrorAction SilentlyContinue }
$log | Set-Content -Encoding utf8 (Join-Path $out 'demo.log')
$after = Get-OfflineEvidence; $d1 = Test-OfflineEvidence $after
[pscustomobject]@{ evidence = $after; decision = $d1 } | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $out 'network-after.json')
$conn = if (Test-Path $connections) { @(Get-Content $connections).Count } else { 0 }
$procs = if (Test-Path "$connections.processes") { @(Get-Content "$connections.processes").Count } else { 0 }
$res = if (Test-Path (Join-Path $dir 'demo-offline.json')) { @(Get-Content (Join-Path $dir 'demo-offline.json') -Raw | ConvertFrom-Json) } else { @() }
$passed = @($res | Where-Object { $_.pass }).Count
$pass = ($code -eq 0) -and $res.Count -gt 0 -and $passed -eq $res.Count -and $d0.offline -and $d1.offline -and $conn -eq 0
$lines = @("packaged offline demonstration: $passed/$($res.Count) checks passed; exit $code",
    "offline before $($d0.offline), after $($d1.offline); D-ASK tree processes observed $procs; non-loopback connections $conn", "OVERALL: $(if ($pass) { 'PASS' } else { 'FAIL' })")
Set-Content -Encoding utf8 (Join-Path $out 'SUMMARY.txt') ($lines -join "`n")
Write-Host "`n$($lines -join "`n")`nEvidence: $out"
exit $(if ($pass) { 0 } else { 1 })
