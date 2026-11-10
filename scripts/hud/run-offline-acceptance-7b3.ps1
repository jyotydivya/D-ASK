# Phase 7B.3: one-command Wi-Fi-off acceptance run around the UNMODIFIED scripts\hud\offline-phase7b3.ps1.
#
#   powershell -ExecutionPolicy Bypass -File D:\D-ASK\D-ASK\scripts\hud\run-offline-acceptance-7b3.ps1
#
# 1. records available physical memory (the click-through itself refuses before its first task if the local model would
#    not be admitted with the HUD running: approval-live-7b3.ps1 memory preflight, 2973 MB);
# 2. records the Wi-Fi radio state, switches the radio off (Windows radio API, as Quick Settings does; no admin), reads it
#    back, and waits until the project's own offline preflight confirms offline;
# 3. runs offline-phase7b3.ps1 unchanged (wire test + 17 real-HUD checks + non-loopback monitor + offline before/after);
# 4. ALWAYS restores the radio to its recorded state in a finally path (also on exceptions and timeouts) and logs whether
#    the restore succeeded.
# It closes no application. DASK_AGENT_MODEL_DIAGNOSTICS=1 only adds the model-supervisor status log (stderr) to the
# daemon log; no protocol message changes.
#
# Exit code: 0 only if the radio was confirmed off, offline was confirmed, the acceptance script ran and exited 0, the
# radio was still off when it finished, and the radio was restored. Otherwise: the acceptance script's non-zero code,
# 1 (acceptance timed out, or the radio was not off afterwards), 3 (acceptance not run), 4 (passed, but restore failed).
#
# Tests: scripts\hud\run-offline-acceptance-7b3.tests.ps1 (dot-sources this file with -LoadFunctionsOnly).
# -AcceptanceScript: which acceptance script in scripts\hud runs offline (default: the unchanged P0 offline-phase7b3.ps1;
# offline-input-acceptance.ps1 runs P0 and then the P1/P2 input checks in the same offline window).
param([int]$StartDelaySec = 5, [int]$ScriptTimeoutMin = 25, [switch]$LoadFunctionsOnly, [string]$AcceptanceScript = 'offline-phase7b3.ps1')
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------------------------------------------
# WinRT interop (Windows PowerShell 5.1 / .NET Framework). WinRT async operations are awaited through
# System.WindowsRuntimeSystemExtensions.AsTask<TResult>(IAsyncOperation<TResult>), the single one-parameter overload over
# IAsyncOperation`1. NOTE: PowerShell variable names are case-insensitive; the result type and the task MUST have
# different names (a [Type]$T parameter plus "$t = <task>" made PowerShell convert the Task to System.Type: the 19:22 failure).
# ---------------------------------------------------------------------------------------------------------------
function Initialize-WinRtRadio {
    if ($script:WinRtAsTask) { return }
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $candidates = @([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })
    if ($candidates.Count -ne 1) { throw "expected exactly one AsTask(IAsyncOperation`1) overload, found $($candidates.Count)" }
    $script:WinRtAsTask = $candidates[0]
    [void][Windows.Devices.Radios.Radio, Windows.System.Devices, ContentType = WindowsRuntime]
    [void][Windows.Devices.Radios.RadioAccessStatus, Windows.System.Devices, ContentType = WindowsRuntime]
    [void][Windows.Devices.Radios.RadioState, Windows.System.Devices, ContentType = WindowsRuntime]
}

function Await-WinRtOperation($Operation, [Type]$ResultType, [int]$TimeoutMs = 15000) {
    Initialize-WinRtRadio
    $netTask = $script:WinRtAsTask.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    if (-not $netTask.Wait($TimeoutMs)) { throw "WinRT operation did not complete within $TimeoutMs ms" }
    return $netTask.Result
}

function Get-WifiRadio {
    Initialize-WinRtRadio
    $access = Await-WinRtOperation ([Windows.Devices.Radios.Radio]::RequestAccessAsync()) ([Windows.Devices.Radios.RadioAccessStatus])
    if ("$access" -ne 'Allowed') { throw "radio access: $access" }
    $radios = Await-WinRtOperation ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]])
    $wifi = @($radios | Where-Object { "$($_.Kind)" -eq 'WiFi' })
    if ($wifi.Count -ne 1) { throw "expected exactly one Wi-Fi radio, found $($wifi.Count)" }
    return $wifi[0]
}

function Get-WifiRadioState { return "$((Get-WifiRadio).State)" }

function Set-WifiRadioState([ValidateSet('On', 'Off')][string]$Desired) {
    $radio = Get-WifiRadio
    $status = Await-WinRtOperation ($radio.SetStateAsync([Windows.Devices.Radios.RadioState]::$Desired)) ([Windows.Devices.Radios.RadioAccessStatus])
    if ("$status" -ne 'Allowed') { throw "SetStateAsync($Desired) returned $status" }
    return (Get-WifiRadioState)   # read back; the caller compares it with what it asked for
}

# ---------------------------------------------------------------------------------------------------------------
# Orchestration. Every side effect goes through $Ops so the decision logic can be tested with fakes:
#   GetRadioState() -> 'On'|'Off'|...    SetRadioState($desired) -> state read back
#   ConfirmOffline() -> bool             RunAcceptance() -> @{ exitCode; timedOut; evidence }
#   ConfirmOnline() -> bool              Sleep($seconds)              Log($message)
# ---------------------------------------------------------------------------------------------------------------
function Invoke-OfflineAcceptanceRun([hashtable]$Ops, [int]$OfflineTimeoutSec = 120, [int]$OnlineTimeoutSec = 180, [int]$PollSec = 3) {
    $res = [ordered]@{ radioBefore = $null; radioSwitchedByUs = $false; radioOffConfirmed = $false; offlineConfirmed = $false
        acceptanceRan = $false; scriptExitCode = $null; scriptTimedOut = $false; acceptanceEvidence = $null; radioAfterAcceptance = $null
        restore = $null; radioRestoredTo = $null; onlineAgain = $null; error = $null; acceptancePassed = $false; exitCode = 3 }
    try {
        $res.radioBefore = & $Ops.GetRadioState
        & $Ops.Log "Wi-Fi radio before: $($res.radioBefore)"
        if ($res.radioBefore -ne 'Off') {
            $res.radioSwitchedByUs = $true          # set BEFORE the call: a call that fails half-way is still restored
            $readBack = & $Ops.SetRadioState 'Off'
            & $Ops.Log "Wi-Fi radio switched off; read back: $readBack"
        }
        $observed = & $Ops.GetRadioState
        if ($observed -ne 'Off') { throw "the Wi-Fi radio is '$observed' after switching it off; acceptance is NOT run" }
        $res.radioOffConfirmed = $true
        $waited = 0
        while (-not (& $Ops.ConfirmOffline)) {
            if ($waited -ge $OfflineTimeoutSec) { throw "offline was not confirmed within $OfflineTimeoutSec s; acceptance is NOT run" }
            & $Ops.Sleep $PollSec; $waited += $PollSec
        }
        $res.offlineConfirmed = $true
        & $Ops.Log "offline confirmed by the project preflight after about $waited s; running the acceptance script"
        $res.acceptanceRan = $true
        $a = & $Ops.RunAcceptance
        $res.scriptExitCode = $a.exitCode; $res.scriptTimedOut = [bool]$a.timedOut; $res.acceptanceEvidence = $a.evidence
        & $Ops.Log "acceptance script finished: exit code $($res.scriptExitCode); timed out $($res.scriptTimedOut)"
        try { $res.radioAfterAcceptance = & $Ops.GetRadioState } catch { $res.radioAfterAcceptance = "unknown ($_)" }
        & $Ops.Log "Wi-Fi radio when the acceptance script finished: $($res.radioAfterAcceptance)"
    } catch {
        $res.error = "$_"
        & $Ops.Log "ERROR: $_"
    } finally {
        if (-not $res.radioSwitchedByUs) {
            $res.restore = $(if ($null -eq $res.radioBefore) { 'not-changed: the radio state could not be read, so it was never switched' } else { "not-needed: the radio was already $($res.radioBefore)" })
            & $Ops.Log "Wi-Fi restore: $($res.restore)"
        } else {
            try {
                $res.radioRestoredTo = & $Ops.SetRadioState $res.radioBefore
                if ($res.radioRestoredTo -ne $res.radioBefore) { throw "the radio reads '$($res.radioRestoredTo)', expected '$($res.radioBefore)'" }
                $res.restore = 'restored'
                & $Ops.Log "Wi-Fi restore: SUCCEEDED, the radio is $($res.radioRestoredTo) again"
                $waited = 0; $res.onlineAgain = $false
                while ($waited -lt $OnlineTimeoutSec) { if (& $Ops.ConfirmOnline) { $res.onlineAgain = $true; break }; & $Ops.Sleep $PollSec; $waited += $PollSec }
                & $Ops.Log "online again: $($res.onlineAgain)"
            } catch {
                $res.restore = "FAILED: $_"
                & $Ops.Log "Wi-Fi restore: FAILED ($_). Turn Wi-Fi on from Quick Settings."
            }
        }
    }
    # Verdict. Offline acceptance is never reported as passed unless the radio was confirmed off, offline was confirmed,
    # the script exited 0 without timing out, and the radio was still off when it finished.
    $res.acceptancePassed = $res.radioOffConfirmed -and $res.offlineConfirmed -and $res.acceptanceRan -and -not $res.scriptTimedOut -and
        ($res.scriptExitCode -eq 0) -and ($res.radioAfterAcceptance -eq 'Off')
    $res.exitCode = $(if (-not $res.acceptanceRan) { 3 }
        elseif ($res.scriptTimedOut -or $null -eq $res.scriptExitCode) { 1 }
        elseif ($res.radioAfterAcceptance -ne 'Off') { 1 }
        elseif ($res.scriptExitCode -ne 0) { $res.scriptExitCode }
        elseif ($res.restore -ne 'restored' -and $res.radioSwitchedByUs) { 4 }
        else { 0 })
    return [pscustomobject]$res
}

if ($LoadFunctionsOnly) { return }

# ---------------------------------------------------------------------------------------------------------------
# The real run
# ---------------------------------------------------------------------------------------------------------------
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
if ($AcceptanceScript -notmatch '^[A-Za-z0-9._-]+\.ps1$' -or -not (Test-Path (Join-Path $PSScriptRoot $AcceptanceScript))) { throw "unknown acceptance script: $AcceptanceScript" }
$stamp = (Get-Date).ToString('yyyyMMddTHHmmss')
$out = Join-Path $root "results\phase7b3\acceptance-runs\$stamp"
while (Test-Path $out) { $out = "$out-$(Get-Random -Maximum 10000)" }
New-Item -ItemType Directory -Force $out | Out-Null
$logFile = Join-Path $out 'wrapper.log'
$logFn = { param($m) $line = "$((Get-Date).ToString('o')) $m"; Add-Content -Path $logFile -Value $line -Encoding utf8; Write-Host $line }
. "$root\scripts\hud\offline-preflight.ps1"

$freeMB = [int]((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1024)
& $logFn "available physical memory before the stack starts: $freeMB MB (the HUD typically takes another 0.6-1.5 GB; the model needs 2973 MB free with the HUD running; the click-through checks this itself)"
Start-Sleep -Seconds $StartDelaySec

$runAcceptance = {
    $before = @(Get-ChildItem (Join-Path $root 'results\phase7b3\offline-live') -Directory -ErrorAction SilentlyContinue | ForEach-Object Name)
    $env:DASK_AgentHost__ExtraEnvironment__DASK_AGENT_MODEL_DIAGNOSTICS = '1'
    try {
        $proc = Start-Process powershell.exe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "$root\scripts\hud\$AcceptanceScript") -WorkingDirectory $root `
            -NoNewWindow -PassThru -RedirectStandardOutput (Join-Path $out 'offline-script.stdout.log') -RedirectStandardError (Join-Path $out 'offline-script.stderr.log')
        $null = $proc.Handle   # keep the handle so ExitCode is available after the process exits
        $timedOut = -not $proc.WaitForExit($ScriptTimeoutMin * 60000)
        if ($timedOut) { & $logFn "TIMEOUT after $ScriptTimeoutMin min: stopping the acceptance script and its children"; & taskkill /PID $proc.Id /T /F | Out-Null; $code = $null }
        else { $proc.WaitForExit(); $code = $proc.ExitCode }
    } finally { Remove-Item Env:\DASK_AgentHost__ExtraEnvironment__DASK_AGENT_MODEL_DIAGNOSTICS -ErrorAction SilentlyContinue }
    $new = @(Get-ChildItem (Join-Path $root 'results\phase7b3\offline-live') -Directory | Where-Object { $before -notcontains $_.Name } | ForEach-Object FullName)
    @{ exitCode = $code; timedOut = $timedOut; evidence = $new }
}

$ops = @{
    GetRadioState  = { Get-WifiRadioState }
    SetRadioState  = { param($desired) Set-WifiRadioState $desired }
    ConfirmOffline = { (Test-OfflineEvidence (Get-OfflineEvidence)).offline }
    RunAcceptance  = $runAcceptance
    ConfirmOnline  = { @(Invoke-ConnectivityProbe | Where-Object { $_.connected }).Count -gt 0 }
    Sleep          = { param($s) Start-Sleep -Seconds $s }
    Log            = $logFn
}
$result = Invoke-OfflineAcceptanceRun $ops
$result | Add-Member -NotePropertyName availableMBBeforeHud -NotePropertyValue $freeMB
$result | Add-Member -NotePropertyName evidence -NotePropertyValue $out
$result | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 (Join-Path $out 'wrapper-result.json')
& $logFn "wrapper done: acceptance passed $($result.acceptancePassed); exit code $($result.exitCode); evidence $out"
exit $result.exitCode
