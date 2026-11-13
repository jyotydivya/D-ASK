# Full offline acceptance (Wi-Fi OFF) in one offline window. Run it through the wrapper, which switches the radio:
#
#   powershell -ExecutionPolicy Bypass -File D:\D-ASK\D-ASK\scripts\hud\run-offline-acceptance-7b3.ps1 -AcceptanceScript offline-full-acceptance.ps1 -ScriptTimeoutMin 75
#
# Sequentially, each only after the previous one finished and its stack was stopped:
#   1. the UNCHANGED P0 acceptance (offline-phase7b3.ps1: wire test + 17 real-HUD checks, its own monitor);
#   2. P1/P2 guarded input (approval-live-input.ps1, 23 checks);
#   3. multi-step input (approval-live-multistep.ps1, 11 checks);
#   4. Browser Stage 2 (approval-live-browser.ps1, 11 checks; loopback fixture site, D-ASK's headless Chromium).
# Parts 2–4 run under this script's monitor of EVERY process in the D-ASK trees (DAsk.Daemon and hud-native and all their
# descendants: agent host, llama-server, Chromium, WebView2), recording any TCP connection to a non-loopback address.
# This script never changes a network setting. Exit 0 only if every part passed, offline was confirmed before and after,
# and no D-ASK process opened a non-loopback connection; 2 if it refused to start because the machine was online.
param([switch]$SkipP0)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\offline-preflight.ps1"
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
$stamp = (Get-Date).ToString('yyyyMMddTHHmmss')
$out = Join-Path $root "results\offline-full\$stamp"
New-Item -ItemType Directory -Force $out | Out-Null

$before0 = Get-OfflineEvidence; $d0 = Test-OfflineEvidence $before0
[pscustomobject]@{ evidence = $before0; decision = $d0 } | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $out 'network-before.json')
if (-not $d0.offline) { Write-OfflineDecision $d0 $before0; Write-Host 'Online: the acceptance was NOT run.' -ForegroundColor Red; exit 2 }

$parts = [ordered]@{}
# ---- 1. P0, unchanged ----
if (-not $SkipP0) {
    $liveRoot = Join-Path $root 'results\phase7b3\offline-live'
    $existing = @(Get-ChildItem $liveRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object Name)
    $ErrorActionPreference = 'Continue'
    $p0Out = & powershell -NoProfile -ExecutionPolicy Bypass -File "$root\scripts\hud\offline-phase7b3.ps1" 2>&1
    $p0Code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    $p0Out | Set-Content -Encoding utf8 (Join-Path $out 'p0-offline.log')
    $p0Dir = @(Get-ChildItem $liveRoot -Directory | Where-Object { $existing -notcontains $_.Name } | ForEach-Object FullName) | Select-Object -Last 1
    $p0Result = if ($p0Dir -and (Test-Path (Join-Path $p0Dir 'RESULT.json'))) { Get-Content (Join-Path $p0Dir 'RESULT.json') -Raw | ConvertFrom-Json } else { $null }
    $parts.p0 = [pscustomobject]@{ pass = (($p0Code -eq 0) -and $p0Result -and $p0Result.verdict.pass); exit = $p0Code; evidence = $p0Dir
        detail = "wire $($p0Result.wire.passed)/$($p0Result.wire.total); HUD $($p0Result.hud.passed)/$($p0Result.hud.total); non-loopback $($p0Result.nonLoopbackConnections)" }
}

# ---- 2–4 under one monitor of the whole D-ASK process trees ----
$connections = Join-Path $out 'non-loopback-connections.txt'
$monitor = Start-Job -ScriptBlock {
    param($file, $treeHelper)
    . $treeHelper
    $seen = @{}
    while ($true) {
        $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
        $tree = Get-DAskProcessTree $all   # creation-time checked: a reused parent id is not descent (dask-process-tree.ps1)
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
try {
    foreach ($h in @(@{ k = 'input'; s = 'approval-live-input.ps1' }, @{ k = 'multistep'; s = 'approval-live-multistep.ps1' }, @{ k = 'browser'; s = 'approval-live-browser.ps1' })) {
        $dir = Join-Path $out $h.k
        $ErrorActionPreference = 'Continue'
        $log = & powershell -NoProfile -ExecutionPolicy Bypass -File "$root\scripts\hud\$($h.s)" -OutDir $dir 2>&1
        $code = $LASTEXITCODE
        $ErrorActionPreference = 'Stop'
        $log | Set-Content -Encoding utf8 (Join-Path $out "$($h.k).log")
        $sum = if (Test-Path (Join-Path $dir 'approval-live-summary.json')) { Get-Content (Join-Path $dir 'approval-live-summary.json') -Raw | ConvertFrom-Json } else { $null }
        $parts[$h.k] = [pscustomobject]@{ pass = (($code -eq 0) -and $sum -and $sum.passed -eq $sum.expectedTotal -and $sum.total -eq $sum.expectedTotal -and -not $sum.aborted); exit = $code; evidence = $dir
            detail = "$($sum.passed)/$($sum.total) (expected $($sum.expectedTotal)); aborted $($sum.aborted)$(if ($sum.abortReason) { " ($($sum.abortReason))" })" }
    }
} finally { Stop-Job $monitor -ErrorAction SilentlyContinue; Remove-Job $monitor -Force -ErrorAction SilentlyContinue }

$after = Get-OfflineEvidence; $d2 = Test-OfflineEvidence $after
[pscustomobject]@{ evidence = $after; decision = $d2 } | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $out 'network-after.json')
$conn = if (Test-Path $connections) { @(Get-Content $connections).Count } else { 0 }
$procs = if (Test-Path "$connections.processes") { @(Get-Content "$connections.processes").Count } else { 0 }
$pass = (@($parts.Values | Where-Object { -not $_.pass }).Count -eq 0) -and $d0.offline -and $d2.offline -and $conn -eq 0
$lines = @(foreach ($k in $parts.Keys) { "$k : $(if ($parts[$k].pass) { 'PASS' } else { 'FAIL' }) (exit $($parts[$k].exit)) $($parts[$k].detail) - $($parts[$k].evidence)" })
$lines += "offline before $($d0.offline), after $($d2.offline); D-ASK tree processes observed $procs; non-loopback connections $conn"
$lines += "OVERALL: $(if ($pass) { 'PASS' } else { 'FAIL' })"
Set-Content -Encoding utf8 (Join-Path $out 'SUMMARY.txt') ($lines -join "`n")
ConvertTo-Json -InputObject ([pscustomobject]@{ pass = $pass; parts = $parts; offlineBefore = $d0.offline; offlineAfter = $d2.offline; nonLoopbackConnections = $conn; processesObserved = $procs }) -Depth 8 |
    Set-Content -Encoding utf8 (Join-Path $out 'RESULT.json')
Write-Host "`n$($lines -join "`n")`nEvidence: $out"
exit $(if ($pass) { 0 } else { 1 })
