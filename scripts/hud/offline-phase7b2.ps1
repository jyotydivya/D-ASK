# Phase 7B.2 live run (approval-connected window-operation requests, real HUD) with Wi-Fi OFF. Run it after turning
# Wi-Fi off:
#
#   powershell -ExecutionPolicy Bypass -File D:\D-ASK\D-ASK\scripts\hud\offline-phase7b2.ps1
#
# Preflight only (changes nothing, writes nothing):
#
#   powershell -ExecutionPolicy Bypass -File D:\D-ASK\D-ASK\scripts\hud\offline-phase7b2.ps1 -PreflightOnly
#
# -OnlineLoopbackCheck runs the same live test while ONLINE and records every non-loopback connection the D-ASK
# processes open. It is NOT an offline test and is stored separately (results\phase7b2\online-loopback-check).
#
# The test is scripts\hud\approval-live-7b2.ps1: real HUD, real daemon, real agent host, real local model, one disposable
# fixture window. Clicks and keys go only to the D-ASK HUD. No window operation is ever performed (no executor exists).
# This script never changes a network setting and never touches earlier phases' evidence.
#
# Exit code: 0 only if the wire test passed, every required HUD check passed (none aborted or missing), no D-ASK process
# opened a non-loopback connection and, for the offline run, the machine was offline before and after. Otherwise 1
# (2 = refused to start because the machine is online). Evidence is always written, including for partial failures.
param([switch]$PreflightOnly, [switch]$OnlineLoopbackCheck, [switch]$LoadFunctionsOnly)
$ErrorActionPreference = 'Stop'

# ---- pure result readers (no side effects; dot-source with -LoadFunctionsOnly to test them) ----

# Windows PowerShell 5.1 returns a JSON array from ConvertFrom-Json as ONE object; enumerate it to get the elements.
function Read-JsonArray([string]$Path) {
    $parsed = Get-Content $Path -Raw | ConvertFrom-Json
    # The leading comma keeps a one-element array an array when it is returned (PowerShell would unroll it).
    return , @($parsed | ForEach-Object { $_ })
}

function Get-WireResult([string]$TrxPath, $ExitCode) {
    $r = [ordered]@{ executed = $false; exitCode = $ExitCode; total = 0; passed = 0; failed = 0; other = 0 }
    if ($TrxPath -and (Test-Path $TrxPath)) {
        [xml]$x = Get-Content $TrxPath -Raw
        $tests = @($x.TestRun.Results.UnitTestResult | Where-Object { $_ })
        $r.executed = $tests.Count -gt 0
        $r.total = $tests.Count
        $r.passed = @($tests | Where-Object { $_.outcome -eq 'Passed' }).Count
        $r.failed = @($tests | Where-Object { $_.outcome -eq 'Failed' }).Count
        $r.other = $r.total - $r.passed - $r.failed
    }
    return [pscustomobject]$r
}

function Get-HudResult([string]$LiveDir, $ExitCode) {
    $r = [ordered]@{ executed = $false; exitCode = $ExitCode; total = 0; passed = 0; failed = 0; expectedTotal = $null
        aborted = $null; abortReason = $null; failedChecks = @() }
    $json = Join-Path $LiveDir 'approval-live.json'
    if (Test-Path $json) {
        $checks = Read-JsonArray $json
        $r.executed = $true
        $r.total = @($checks | Where-Object { $_.name -ne 'unexpected error' }).Count
        $r.passed = @($checks | Where-Object { $_.pass -eq $true -and $_.name -ne 'unexpected error' }).Count
        $r.failed = @($checks | Where-Object { $_.pass -ne $true }).Count
        $r.failedChecks = @($checks | Where-Object { $_.pass -ne $true } | ForEach-Object { $_.name })
    }
    $sum = Join-Path $LiveDir 'approval-live-summary.json'
    if (Test-Path $sum) {
        $s = Get-Content $sum -Raw | ConvertFrom-Json
        $r.expectedTotal = $s.expectedTotal; $r.aborted = $s.aborted; $r.abortReason = $s.abortReason
    }
    return [pscustomobject]$r
}

function Get-OverallVerdict($Wire, $Hud, [bool]$OfflineRequired, $OfflineBefore, $OfflineAfter, [int]$NonLoopback) {
    $why = New-Object System.Collections.ArrayList
    if (-not $Wire.executed) { [void]$why.Add('wire test: not executed (no test result)') }
    else {
        if ($Wire.failed -gt 0 -or $Wire.other -gt 0 -or $Wire.passed -lt 1) { [void]$why.Add("wire test: $($Wire.passed) passed, $($Wire.failed) failed, $($Wire.other) other") }
        if ($Wire.exitCode -ne 0) { [void]$why.Add("wire test: exit code $($Wire.exitCode)") }
    }
    if (-not $Hud.executed) { [void]$why.Add('HUD click-through: not executed (no results file)') }
    else {
        if ($Hud.failed -gt 0) { [void]$why.Add("HUD click-through: $($Hud.failed) check(s) failed or not run") }
        if ($null -eq $Hud.expectedTotal) { [void]$why.Add('HUD click-through: no summary file') }
        elseif ($Hud.total -ne $Hud.expectedTotal) { [void]$why.Add("HUD click-through: $($Hud.total) checks reported, $($Hud.expectedTotal) expected") }
        if ($Hud.aborted -eq $true) { [void]$why.Add("HUD click-through: aborted ($($Hud.abortReason))") }
        if ($Hud.exitCode -ne 0) { [void]$why.Add("HUD click-through: exit code $($Hud.exitCode)") }
    }
    if ($NonLoopback -ne 0) { [void]$why.Add("network: $NonLoopback non-loopback connection(s) by D-ASK processes") }
    if ($OfflineRequired -and -not ($OfflineBefore -eq $true -and $OfflineAfter -eq $true)) { [void]$why.Add("network: not offline for the whole run (before $OfflineBefore, after $OfflineAfter)") }
    return [pscustomobject]@{ pass = ($why.Count -eq 0); reasons = @($why.ToArray()) }
}

if ($LoadFunctionsOnly) { return }

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
$out = Join-Path $root ($(if ($OnlineLoopbackCheck) { 'results\phase7b2\online-loopback-check' } else { 'results\phase7b2\offline-live' }))
$out = Join-Path $out $stamp
# Never write into an earlier run's folder.
while (Test-Path $out) { $out = "$out-$(Get-Random -Maximum 10000)" }
New-Item -ItemType Directory -Force $out | Out-Null

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
                    # The owning process's command line, so a connection can be attributed (D-ASK or not).
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

$started = Get-Date
$liveOut = Join-Path $out 'approval-live'
$trx = Join-Path $out 'phase7b2-live.trx'
try {
    # The child's stderr is captured as output; it must not abort this runner (Windows PowerShell 5.1 behaviour).
    $ErrorActionPreference = 'Continue'
    # 1. The wire-level live test: real daemon, host and model; the test plays the HUD's wire role.
    Push-Location $root
    $wire = & dotnet test tests/DAsk.Daemon.Tests/DAsk.Daemon.Tests.csproj --no-build --filter "Category=Phase7B2Live" --logger "trx;LogFileName=$trx" --logger "console;verbosity=detailed" 2>&1
    $wireCode = $LASTEXITCODE
    Pop-Location
    $wire | Set-Content -Encoding utf8 (Join-Path $out 'wire-test.log')
    # 2. The real HUD, clicked: needs Ctrl+Alt+Space to be free (the HUD only becomes interactive through it).
    $output = & powershell -NoProfile -ExecutionPolicy Bypass -File "$root\scripts\hud\approval-live-7b2.ps1" -OutDir $liveOut 2>&1
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
} finally {
    Stop-Job $monitor -ErrorAction SilentlyContinue
    Remove-Job $monitor -Force -ErrorAction SilentlyContinue
}
$output | Set-Content -Encoding utf8 (Join-Path $out 'live-test.log')
$after = if ($OnlineLoopbackCheck) { Get-OfflineEvidence -SkipProbe } else { Get-OfflineEvidence }
$afterDecision = Test-OfflineEvidence $after
[pscustomobject]@{ evidence = $after; decision = $afterDecision } | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $out 'network-after.json')
$connectionCount = if (Test-Path $connections) { @(Get-Content $connections).Count } else { 0 }
$processes = if (Test-Path "$connections.processes") { @(Get-Content "$connections.processes") } else { @() }
$wireResult = Get-WireResult $trx $wireCode
$hudResult = Get-HudResult $liveOut $code
$verdict = Get-OverallVerdict $wireResult $hudResult (-not $OnlineLoopbackCheck) $decision.offline $afterDecision.offline $connectionCount

$summary = @(
    "mode: $(if ($OnlineLoopbackCheck) { 'ONLINE loopback check (not offline)' } else { 'Wi-Fi off' })"
    "started: $($started.ToString('o'))"
    "finished: $((Get-Date).ToString('o'))"
    "wire live test (Category=Phase7B2Live): executed $($wireResult.executed); $($wireResult.passed) passed, $($wireResult.failed) failed of $($wireResult.total); exit code $wireCode"
    "HUD click-through: executed $($hudResult.executed); $($hudResult.passed) / $($hudResult.total) checks passed (expected $($hudResult.expectedTotal)); failed or not run $($hudResult.failed); aborted $($hudResult.aborted)$(if ($hudResult.abortReason) { " ($($hudResult.abortReason))" }); exit code $code"
    "offline before: $($decision.offline); offline after: $($afterDecision.offline)"
    "D-ASK processes observed: $($processes.Count)"
    "non-loopback connections by D-ASK processes: $connectionCount"
    "OVERALL: $(if ($verdict.pass) { 'PASS' } else { 'FAIL' })"
) + @($verdict.reasons | ForEach-Object { "  - $_" }) -join "`n"
Set-Content -Encoding utf8 (Join-Path $out 'SUMMARY.txt') $summary
ConvertTo-Json -InputObject ([pscustomobject]@{ verdict = $verdict; wire = $wireResult; hud = $hudResult
    offlineBefore = $decision.offline; offlineAfter = $afterDecision.offline; nonLoopbackConnections = $connectionCount; processesObserved = $processes.Count }) -Depth 6 |
    Set-Content -Encoding utf8 (Join-Path $out 'RESULT.json')
Write-Host "`n$summary"
Write-Host "Evidence: $out"
exit $(if ($verdict.pass) { 0 } else { 1 })
