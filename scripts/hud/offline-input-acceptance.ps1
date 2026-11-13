# P0 + P1/P2 acceptance with Wi-Fi OFF, in one offline window. Run it through the wrapper (which switches the radio):
#
#   powershell -ExecutionPolicy Bypass -File D:\D-ASK\D-ASK\scripts\hud\run-offline-acceptance-7b3.ps1 -AcceptanceScript offline-input-acceptance.ps1
#
# 1. the UNCHANGED P0 acceptance (scripts\hud\offline-phase7b3.ps1: wire test, 17 real-HUD checks, its own network monitor,
#    offline before/after); its evidence goes to results\phase7b3\offline-live\<stamp>\;
# 2. the P1/P2 real-HUD input checks (scripts\hud\approval-live-input.ps1, 23 checks) under this script's own monitor of
#    every connection the D-ASK processes open, with offline confirmed before and after.
# This script never changes a network setting. Exit code: 0 only if both parts pass, the machine was offline before and
# after the input part, and no D-ASK process opened a non-loopback connection; 2 if it refused to start because online.
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\offline-preflight.ps1"
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
$stamp = (Get-Date).ToString('yyyyMMddTHHmmss')
$out = Join-Path $root "results\p1p2-hud\offline\$stamp"
while (Test-Path $out) { $out = "$out-$(Get-Random -Maximum 10000)" }
New-Item -ItemType Directory -Force $out | Out-Null

$before0 = Get-OfflineEvidence; $d0 = Test-OfflineEvidence $before0
if (-not $d0.offline) { Write-OfflineDecision $d0 $before0; Write-Host 'Online: the acceptance was NOT run.' -ForegroundColor Red; exit 2 }

# ---- 1. P0, unchanged ----
$liveRoot = Join-Path $root 'results\phase7b3\offline-live'
$existing = @(Get-ChildItem $liveRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object Name)
$ErrorActionPreference = 'Continue'
$p0Out = & powershell -NoProfile -ExecutionPolicy Bypass -File "$root\scripts\hud\offline-phase7b3.ps1" 2>&1
$p0Code = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
$p0Out | Set-Content -Encoding utf8 (Join-Path $out 'p0-offline.log')
$p0Dir = @(Get-ChildItem $liveRoot -Directory | Where-Object { $existing -notcontains $_.Name } | ForEach-Object FullName) | Select-Object -Last 1
$p0Result = if ($p0Dir -and (Test-Path (Join-Path $p0Dir 'RESULT.json'))) { Get-Content (Join-Path $p0Dir 'RESULT.json') -Raw | ConvertFrom-Json } else { $null }

# ---- 2. P1/P2 input, with this script's own monitor ----
$before = Get-OfflineEvidence; $d1 = Test-OfflineEvidence $before
[pscustomobject]@{ evidence = $before; decision = $d1 } | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $out 'network-before-input.json')
$connections = Join-Path $out 'non-loopback-connections.txt'
$monitor = Start-Job -ScriptBlock {
    param($file)
    $seen = @{}
    while ($true) {
        $ids = @{}
        foreach ($p in Get-Process -Name 'node', 'llama-server', 'DAsk.Daemon', 'hud-native' -ErrorAction SilentlyContinue) { $ids[[int]$p.Id] = $p.ProcessName }
        foreach ($c in Get-NetTCPConnection -ErrorAction SilentlyContinue) {
            if ($ids.ContainsKey([int]$c.OwningProcess) -and $c.RemoteAddress -notmatch '^(127\.|::1$|0\.0\.0\.0$|::$)') {
                $key = "$($ids[[int]$c.OwningProcess])|$($c.RemoteAddress):$($c.RemotePort)|$($c.State)"
                if (-not $seen.ContainsKey($key)) {
                    $seen[$key] = 1
                    $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$c.OwningProcess)" -ErrorAction SilentlyContinue).CommandLine
                    Add-Content -Path $file -Value "$((Get-Date).ToString('o')) $key pid=$($c.OwningProcess) cmd=$cmd"
                }
            }
        }
        foreach ($p in Get-Process -Name 'llama-server', 'DAsk.Daemon', 'hud-native' -ErrorAction SilentlyContinue) {
            $k = "seen|$($p.ProcessName)|$($p.Id)"
            if (-not $seen.ContainsKey($k)) { $seen[$k] = 1; Add-Content -Path "$file.processes" -Value "$((Get-Date).ToString('o')) $($p.ProcessName) pid $($p.Id)" }
        }
        Start-Sleep -Milliseconds 250
    }
} -ArgumentList $connections
$inputOut = Join-Path $out 'approval-live-input'
try {
    $ErrorActionPreference = 'Continue'
    $inLog = & powershell -NoProfile -ExecutionPolicy Bypass -File "$root\scripts\hud\approval-live-input.ps1" -OutDir $inputOut 2>&1
    $inCode = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
} finally { Stop-Job $monitor -ErrorAction SilentlyContinue; Remove-Job $monitor -Force -ErrorAction SilentlyContinue }
$inLog | Set-Content -Encoding utf8 (Join-Path $out 'input-live.log')
$after = Get-OfflineEvidence; $d2 = Test-OfflineEvidence $after
[pscustomobject]@{ evidence = $after; decision = $d2 } | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $out 'network-after-input.json')
$conn = if (Test-Path $connections) { @(Get-Content $connections).Count } else { 0 }
$procs = if (Test-Path "$connections.processes") { @(Get-Content "$connections.processes").Count } else { 0 }
$inSum = if (Test-Path (Join-Path $inputOut 'approval-live-summary.json')) { Get-Content (Join-Path $inputOut 'approval-live-summary.json') -Raw | ConvertFrom-Json } else { $null }

$p0Pass = ($p0Code -eq 0) -and $p0Result -and $p0Result.verdict.pass
$inPass = ($inCode -eq 0) -and $inSum -and ($inSum.passed -eq $inSum.expectedTotal) -and ($inSum.total -eq $inSum.expectedTotal) -and -not $inSum.aborted
$pass = $p0Pass -and $inPass -and $d1.offline -and $d2.offline -and $conn -eq 0
$summary = @(
    "P0 (unchanged offline-phase7b3.ps1): exit $p0Code; evidence $p0Dir"
    "    wire $($p0Result.wire.passed)/$($p0Result.wire.total); HUD $($p0Result.hud.passed)/$($p0Result.hud.total) (expected $($p0Result.hud.expectedTotal)); offline before $($p0Result.offlineBefore), after $($p0Result.offlineAfter); non-loopback $($p0Result.nonLoopbackConnections); verdict $(if ($p0Result.verdict.pass) { 'PASS' } else { 'FAIL' })"
    "P1/P2 input (approval-live-input.ps1): exit $inCode; $($inSum.passed)/$($inSum.total) checks (expected $($inSum.expectedTotal)); aborted $($inSum.aborted)$(if ($inSum.abortReason) { " ($($inSum.abortReason))" })"
    "    offline before $($d1.offline), after $($d2.offline); D-ASK processes observed $procs; non-loopback connections $conn"
    "OVERALL: $(if ($pass) { 'PASS' } else { 'FAIL' })"
) -join "`n"
Set-Content -Encoding utf8 (Join-Path $out 'SUMMARY.txt') $summary
ConvertTo-Json -InputObject ([pscustomobject]@{ pass = $pass; p0 = @{ exitCode = $p0Code; evidence = $p0Dir; result = $p0Result }
    input = @{ exitCode = $inCode; summary = $inSum; offlineBefore = $d1.offline; offlineAfter = $d2.offline; nonLoopbackConnections = $conn; processesObserved = $procs } }) -Depth 8 |
    Set-Content -Encoding utf8 (Join-Path $out 'RESULT.json')
Write-Host "`n$summary`nEvidence: $out"
exit $(if ($pass) { 0 } else { 1 })
