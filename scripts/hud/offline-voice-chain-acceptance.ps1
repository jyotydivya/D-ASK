# Wi-Fi-OFF acceptance of SPOKEN multi-step and chained requests (approval-live-voice-chain.ps1, interactive; a PERSON speaks), under a monitor of every
# process in the D-ASK trees. Run through the radio wrapper (PDFs folder in DASK_ACCEPT_PAPERS):
#   $env:DASK_ACCEPT_PAPERS = 'D:\path\to\pdfs'
#   powershell -ExecutionPolicy Bypass -File D:\D-ASK\D-ASK\scripts\hud\run-offline-acceptance-7b3.ps1 -AcceptanceScript offline-voice-chain-acceptance.ps1 -ScriptTimeoutMin 40
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\offline-preflight.ps1"
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
$papers = $env:DASK_ACCEPT_PAPERS
if (-not $papers -or -not (Test-Path $papers)) { Write-Host 'DASK_ACCEPT_PAPERS is not set to a folder with PDFs: nothing was run.' -ForegroundColor Red; exit 3 }
$out = Join-Path $root "results\offline-voice-chain\$((Get-Date).ToString('yyyyMMddTHHmmss'))"
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
        $tree = Get-DAskProcessTree @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
        foreach ($c in Get-NetTCPConnection -ErrorAction SilentlyContinue) {
            if ($tree.ContainsKey([int]$c.OwningProcess) -and $c.RemoteAddress -notmatch '^(127\.|::1$|0\.0\.0\.0$|::$)') {
                $key = "$($tree[[int]$c.OwningProcess])|$($c.RemoteAddress):$($c.RemotePort)|$($c.State)"
                if (-not $seen.ContainsKey($key)) { $seen[$key] = 1; Add-Content -Path $file -Value "$((Get-Date).ToString('o')) $key pid=$($c.OwningProcess)" }
            }
        }
        Start-Sleep -Milliseconds 300
    }
} -ArgumentList $connections, (Join-Path $PSScriptRoot 'dask-process-tree.ps1')
$dir = Join-Path $out 'voice-chain'
try {
    $ErrorActionPreference = 'Continue'
    # Streamed line by line (it used to be buffered in $log until the script ENDED, so its prompts were never seen). The person is
    # prompted in visible windows by the script itself; this console may be redirected to a file (run-offline-acceptance-7b3.ps1).
    $log = & powershell -NoProfile -ExecutionPolicy Bypass -File "$root\scripts\hud\approval-live-voice-chain.ps1" -OutDir $dir -Papers $papers 2>&1 | ForEach-Object { Write-Host "$_"; $_ }
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
} finally { Stop-Job $monitor -ErrorAction SilentlyContinue; Remove-Job $monitor -Force -ErrorAction SilentlyContinue }
$log | Set-Content -Encoding utf8 (Join-Path $out 'voice-chain.log')
$after = Get-OfflineEvidence; $d1 = Test-OfflineEvidence $after
[pscustomobject]@{ evidence = $after; decision = $d1 } | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $out 'network-after.json')
$conn = if (Test-Path $connections) { @(Get-Content $connections).Count } else { 0 }
$sum = if (Test-Path (Join-Path $dir 'approval-live-summary.json')) { Get-Content (Join-Path $dir 'approval-live-summary.json') -Raw | ConvertFrom-Json } else { $null }
$pass = ($code -eq 0) -and $sum -and $sum.passed -eq $sum.expectedTotal -and -not $sum.aborted -and $d0.offline -and $d1.offline -and $conn -eq 0
$lines = @("voice-chain: $($sum.passed)/$($sum.total) (expected $($sum.expectedTotal)); aborted $($sum.aborted); exit $code", "offline before $($d0.offline), after $($d1.offline); non-loopback connections $conn", "OVERALL: $(if ($pass) { 'PASS' } else { 'FAIL' })")
Set-Content -Encoding utf8 (Join-Path $out 'SUMMARY.txt') ($lines -join "`n")
Write-Host "`n$($lines -join "`n")`nEvidence: $out"
exit $(if ($pass) { 0 } else { 1 })
