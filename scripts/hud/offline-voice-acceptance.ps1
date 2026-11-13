# Wi-Fi-OFF acceptance of a VOICE-INITIATED task (a person speaks; the radio is off for the whole run) (approval-live-voice.ps1, unchanged), under a
# monitor of EVERY process in the D-ASK trees (daemon, HUD, agent host, llama-server, WebView2).
# Run through the radio wrapper:
#   powershell -ExecutionPolicy Bypass -File D:\D-ASK\D-ASK\scripts\hud\run-offline-acceptance-7b3.ps1 -AcceptanceScript offline-voice-acceptance.ps1 -ScriptTimeoutMin 20
# Never changes a network setting. Exit 0 only if every check passed, offline before and after, and 0 non-loopback connections.
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\offline-preflight.ps1"
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
$out = Join-Path $root "results\offline-voice\$((Get-Date).ToString('yyyyMMddTHHmmss'))"
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
$dir = Join-Path $out 'voice'
try {
    $ErrorActionPreference = 'Continue'
    $log = & powershell -NoProfile -ExecutionPolicy Bypass -File "$root\scripts\hud\approval-live-voice.ps1" -OutDir $dir 2>&1
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
} finally { Stop-Job $monitor -ErrorAction SilentlyContinue; Remove-Job $monitor -Force -ErrorAction SilentlyContinue }
$log | Set-Content -Encoding utf8 (Join-Path $out 'voice.log')
$after = Get-OfflineEvidence; $d1 = Test-OfflineEvidence $after
[pscustomobject]@{ evidence = $after; decision = $d1 } | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $out 'network-after.json')
$conn = if (Test-Path $connections) { @(Get-Content $connections).Count } else { 0 }
$procs = if (Test-Path "$connections.processes") { @(Get-Content "$connections.processes").Count } else { 0 }
$sum = if (Test-Path (Join-Path $dir 'approval-live-summary.json')) { Get-Content (Join-Path $dir 'approval-live-summary.json') -Raw | ConvertFrom-Json } else { $null }
$pass = ($code -eq 0) -and $sum -and $sum.passed -eq $sum.expectedTotal -and $sum.total -eq $sum.expectedTotal -and -not $sum.aborted -and $d0.offline -and $d1.offline -and $conn -eq 0
$lines = @("voice: $($sum.passed)/$($sum.total) (expected $($sum.expectedTotal)); aborted $($sum.aborted)$(if ($sum.abortReason) { " ($($sum.abortReason))" }); exit $code",
    "offline before $($d0.offline), after $($d1.offline); D-ASK tree processes observed $procs; non-loopback connections $conn", "OVERALL: $(if ($pass) { 'PASS' } else { 'FAIL' })")
Set-Content -Encoding utf8 (Join-Path $out 'SUMMARY.txt') ($lines -join "`n")
Write-Host "`n$($lines -join "`n")`nEvidence: $out"
exit $(if ($pass) { 0 } else { 1 })
