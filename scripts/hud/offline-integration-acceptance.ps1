# Wi-Fi-OFF acceptance of KNOWLEDGE / RESEARCH (approval-live-knowledge.ps1) and the CROSS-FEATURE scenarios (approval-live-integration.ps1), both
# unchanged, under a monitor of EVERY process in the D-ASK trees (daemon, HUD, agent host, llama-server incl. the embedder, WebView2).
# Run through the radio wrapper (the PDFs folder is given in DASK_ACCEPT_PAPERS):
#   $env:DASK_ACCEPT_PAPERS = 'D:\path\to\pdfs'
#   powershell -ExecutionPolicy Bypass -File D:\D-ASK\D-ASK\scripts\hud\run-offline-acceptance-7b3.ps1 -AcceptanceScript offline-integration-acceptance.ps1 -ScriptTimeoutMin 50
# Never changes a network setting. Exit 0 only if every check of both passed, offline before and after, and 0 non-loopback connections.
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\offline-preflight.ps1"
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
$papers = $env:DASK_ACCEPT_PAPERS
if (-not $papers -or -not (Test-Path $papers)) { Write-Host 'DASK_ACCEPT_PAPERS is not set to a folder with PDFs: nothing was run.' -ForegroundColor Red; exit 3 }
$out = Join-Path $root "results\offline-integration\$((Get-Date).ToString('yyyyMMddTHHmmss'))"
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
$parts = [ordered]@{ knowledge = 'approval-live-knowledge.ps1'; integration = 'approval-live-integration.ps1' }
$codes = [ordered]@{}
try {
    foreach ($name in $parts.Keys) {
        $ErrorActionPreference = 'Continue'
        $log = & powershell -NoProfile -ExecutionPolicy Bypass -File "$root\scripts\hud\$($parts[$name])" -OutDir (Join-Path $out $name) -Papers $papers 2>&1
        $codes[$name] = $LASTEXITCODE
        $ErrorActionPreference = 'Stop'
        $log | Set-Content -Encoding utf8 (Join-Path $out "$name.log")
    }
} finally { Stop-Job $monitor -ErrorAction SilentlyContinue; Remove-Job $monitor -Force -ErrorAction SilentlyContinue }
$after = Get-OfflineEvidence; $d1 = Test-OfflineEvidence $after
[pscustomobject]@{ evidence = $after; decision = $d1 } | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $out 'network-after.json')
$conn = if (Test-Path $connections) { @(Get-Content $connections).Count } else { 0 }
$procs = if (Test-Path "$connections.processes") { @(Get-Content "$connections.processes").Count } else { 0 }
$lines = @(); $allPass = $true
foreach ($name in $parts.Keys) {
    $sp = Join-Path (Join-Path $out $name) 'approval-live-summary.json'
    $sum = if (Test-Path $sp) { Get-Content $sp -Raw | ConvertFrom-Json } else { $null }
    $ok = ($codes[$name] -eq 0) -and $sum -and $sum.passed -eq $sum.expectedTotal -and -not $sum.aborted
    if (-not $ok) { $allPass = $false }
    $lines += "${name}: $($sum.passed)/$($sum.total) (expected $($sum.expectedTotal)); aborted $($sum.aborted)$(if ($sum.abortReason) { " ($($sum.abortReason))" }); exit $($codes[$name])"
}
$pass = $allPass -and $d0.offline -and $d1.offline -and $conn -eq 0
$lines += "offline before $($d0.offline), after $($d1.offline); D-ASK tree processes observed $procs; non-loopback connections $conn"
$lines += "OVERALL: $(if ($pass) { 'PASS' } else { 'FAIL' })"
Set-Content -Encoding utf8 (Join-Path $out 'SUMMARY.txt') ($lines -join "`n")
Write-Host "`n$($lines -join "`n")`nEvidence: $out"
exit $(if ($pass) { 0 } else { 1 })
