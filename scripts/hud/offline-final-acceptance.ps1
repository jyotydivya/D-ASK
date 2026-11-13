# Wi-Fi-OFF acceptance of the PACKAGED application (scripts\package\verify-package.ps1 on a throwaway copy: real launcher, packaged Node, llama-server,
# memory, knowledge with the packaged embedder, literature review, composition, tamper checks) AND the offline cross-feature scenarios of round 2
# (approval-live-integration2.ps1 without -Online: file copy/rename/undo, Character Map, plugins, history recovery), all under one monitor of every
# process in the D-ASK trees. Run through the radio wrapper:
#   $env:DASK_ACCEPT_PAPERS = 'D:\path\to\pdfs'; $env:DASK_ACCEPT_PACKAGE = 'D:\D-ASK\D-ASK\dist\desktop\throwaway-verify-<stamp>'
#   powershell -ExecutionPolicy Bypass -File D:\D-ASK\D-ASK\scripts\hud\run-offline-acceptance-7b3.ps1 -AcceptanceScript offline-final-acceptance.ps1 -ScriptTimeoutMin 60
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\offline-preflight.ps1"
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
$papers = $env:DASK_ACCEPT_PAPERS; $pkg = $env:DASK_ACCEPT_PACKAGE
if (-not $papers -or -not (Test-Path $papers) -or -not $pkg -or -not (Test-Path "$pkg\Start-D-ASK.cmd")) { Write-Host 'Set DASK_ACCEPT_PAPERS (PDF folder) and DASK_ACCEPT_PACKAGE (throwaway package copy). Nothing was run.' -ForegroundColor Red; exit 3 }
$out = Join-Path $root "results\offline-final\$((Get-Date).ToString('yyyyMMddTHHmmss'))"
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
$lines = @(); $allPass = $true
try {
    $ErrorActionPreference = 'Continue'
    # 1. The packaged application.
    $pkgOut = Join-Path $out 'package'
    $log = & powershell -NoProfile -ExecutionPolicy Bypass -File "$root\scripts\package\verify-package.ps1" -PackageRoot $pkg -OutDir $pkgOut -Papers $papers 2>&1
    $log | Set-Content -Encoding utf8 (Join-Path $out 'package.log')
    $pk = if (Test-Path (Join-Path $pkgOut 'verify-package.json')) { @(Get-Content (Join-Path $pkgOut 'verify-package.json') -Raw | ConvertFrom-Json) } else { @() }
    $pkPass = @($pk | Where-Object { $_.pass -eq $true }).Count
    if ($pk.Count -eq 0 -or $pkPass -ne $pk.Count) { $allPass = $false }
    $lines += "package: $pkPass/$($pk.Count) passed"
    # 2. The offline cross-feature scenarios (dev stack, same build).
    $log = & powershell -NoProfile -ExecutionPolicy Bypass -File "$root\scripts\hud\approval-live-integration2.ps1" -OutDir (Join-Path $out 'integration2') -Papers $papers 2>&1
    $code = $LASTEXITCODE
    $log | Set-Content -Encoding utf8 (Join-Path $out 'integration2.log')
    $sp = Join-Path (Join-Path $out 'integration2') 'approval-live-summary.json'
    $sum = if (Test-Path $sp) { Get-Content $sp -Raw | ConvertFrom-Json } else { $null }
    if (-not ($code -eq 0 -and $sum -and $sum.passed -eq $sum.expectedTotal -and -not $sum.aborted)) { $allPass = $false }
    $lines += "integration2 (offline subset): $($sum.passed)/$($sum.total) (expected $($sum.expectedTotal)); aborted $($sum.aborted); exit $code"
    $ErrorActionPreference = 'Stop'
} finally { Stop-Job $monitor -ErrorAction SilentlyContinue; Remove-Job $monitor -Force -ErrorAction SilentlyContinue }
$after = Get-OfflineEvidence; $d1 = Test-OfflineEvidence $after
[pscustomobject]@{ evidence = $after; decision = $d1 } | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $out 'network-after.json')
$conn = if (Test-Path $connections) { @(Get-Content $connections).Count } else { 0 }
$procs = if (Test-Path "$connections.processes") { @(Get-Content "$connections.processes").Count } else { 0 }
$pass = $allPass -and $d0.offline -and $d1.offline -and $conn -eq 0
$lines += "offline before $($d0.offline), after $($d1.offline); D-ASK tree processes observed $procs; non-loopback connections $conn"
$lines += "OVERALL: $(if ($pass) { 'PASS' } else { 'FAIL' })"
Set-Content -Encoding utf8 (Join-Path $out 'SUMMARY.txt') ($lines -join "`n")
Write-Host "`n$($lines -join "`n")`nEvidence: $out"
exit $(if ($pass) { 0 } else { 1 })
