# Focused tests for scripts\hud\run-offline-acceptance-7b3.ps1 (Windows PowerShell 5.1).
#
#   powershell -ExecutionPolicy Bypass -File D:\D-ASK\D-ASK\scripts\hud\run-offline-acceptance-7b3.tests.ps1
#
# Part 1 exercises the REAL WinRT interop read-only (it never changes the radio). Part 2 drives the orchestration with
# fakes that record every radio call, to check restoration on every failure path. Nothing is started; no network change.
# Exit code: 0 if every test passed.
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\run-offline-acceptance-7b3.ps1" -LoadFunctionsOnly
$script:passed = 0; $script:failed = 0
function Check([bool]$Cond, [string]$Label, $Detail) {
    if ($Cond) { $script:passed++; Write-Host "  PASS: $Label" }
    else { $script:failed++; Write-Host "  FAIL: $Label $(if ($null -ne $Detail) { '| ' + ($Detail | ConvertTo-Json -Compress -Depth 5) })" }
}

Write-Host "`n[1] Real WinRT interop (read-only; PowerShell $($PSVersionTable.PSVersion), CLR $($PSVersionTable.CLRVersion))"
Initialize-WinRtRadio
Check ("$($script:WinRtAsTask)" -eq 'System.Threading.Tasks.Task`1[TResult] AsTask[TResult](Windows.Foundation.IAsyncOperation`1[TResult])') `
    'R1 the selected awaiter is AsTask<TResult>(IAsyncOperation<TResult>), the only one-parameter IAsyncOperation`1 overload' "$($script:WinRtAsTask)"
$setState = [Windows.Devices.Radios.Radio].GetMethod('SetStateAsync')
Check ($setState.ReturnType.Name -eq 'IAsyncOperation`1' -and $setState.ReturnType.GetGenericArguments()[0] -eq [Windows.Devices.Radios.RadioAccessStatus]) `
    'R2 Radio.SetStateAsync returns IAsyncOperation<RadioAccessStatus> (the type the disable/restore await uses)' "$($setState.ReturnType)"
$reqAccess = [Windows.Devices.Radios.Radio].GetMethod('RequestAccessAsync')
Check ($reqAccess.ReturnType.GetGenericArguments()[0] -eq [Windows.Devices.Radios.RadioAccessStatus]) 'R3 Radio.RequestAccessAsync returns IAsyncOperation<RadioAccessStatus>' "$($reqAccess.ReturnType)"
$access = $null; $err = $null
try { $access = Await-WinRtOperation ([Windows.Devices.Radios.Radio]::RequestAccessAsync()) ([Windows.Devices.Radios.RadioAccessStatus]) } catch { $err = "$_" }
Check ($null -eq $err -and "$access" -eq 'Allowed') 'R4 regression of the 19:22 failure: awaiting RequestAccessAsync returns RadioAccessStatus (no Task->System.Type conversion)' @{ access = "$access"; error = $err }
$st = $null; $err = $null
try { $st = Get-WifiRadioState } catch { $err = "$_" }
Check ($null -eq $err -and $st -in 'On', 'Off') 'R5 Get-WifiRadioState reads the one Wi-Fi radio (read-only)' @{ state = $st; error = $err }
# The defect class, checked on the syntax tree: inside any function, an assignment to a variable whose name equals
# (case-insensitively, as PowerShell resolves it) one of that function's type-constrained parameters.
function Find-TypedParameterReuse([string]$Path) {
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$null, [ref]$null)
    $hits = @()
    foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
        $params = @(); if ($fn.Parameters) { $params += $fn.Parameters }; if ($fn.Body.ParamBlock) { $params += $fn.Body.ParamBlock.Parameters }
        $typed = @($params | Where-Object { $_.Attributes | Where-Object { $_ -is [System.Management.Automation.Language.TypeConstraintAst] } } | ForEach-Object { $_.Name.VariablePath.UserPath.ToLowerInvariant() })
        foreach ($as in $fn.Body.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] }, $true)) {
            $left = $as.Left; if ($left -is [System.Management.Automation.Language.ConvertExpressionAst]) { $left = $left.Child }
            if ($left -is [System.Management.Automation.Language.VariableExpressionAst] -and $typed -contains $left.VariablePath.UserPath.ToLowerInvariant()) {
                $hits += "$($fn.Name): `$$($left.VariablePath.UserPath) (line $($as.Extent.StartLineNumber))"
            }
        }
    }
    return , $hits
}
$reuse = Find-TypedParameterReuse "$PSScriptRoot\run-offline-acceptance-7b3.ps1"
Check ($reuse.Count -eq 0) 'R6 no function in the wrapper assigns to a variable that collides with one of its type-constrained parameters' $reuse
# The detector itself must catch the original defect (a [Type]$T parameter and "$t = <task>").
$probe = Join-Path $env:TEMP "dask-reuse-probe-$PID.ps1"
Set-Content -Path $probe -Encoding ascii -Value 'function Await-WinRt($Op, [Type]$T) { $t = $script:AsTaskOp.MakeGenericMethod($T).Invoke($null, @($Op)); $t.Result }'
$caught = Find-TypedParameterReuse $probe
Remove-Item $probe -ErrorAction SilentlyContinue
Check ($caught.Count -eq 1 -and $caught[0] -match 'Await-WinRt: \$t') 'R6b the detector catches the original 19:22 defect pattern' $caught
Check (@([IO.File]::ReadAllBytes("$PSScriptRoot\run-offline-acceptance-7b3.ps1") | Where-Object { $_ -gt 127 }).Count -eq 0) 'R7 the wrapper is ASCII-only (Windows PowerShell 5.1 reads it without a BOM)'

Write-Host "`n[2] Orchestration with fakes (no radio change, nothing started)"
function New-Fake([hashtable]$Cfg) {
    $f = @{ radio = $(if ($Cfg.ContainsKey('initial')) { $Cfg.initial } else { 'On' }); sets = New-Object System.Collections.ArrayList
        log = New-Object System.Collections.ArrayList; accRuns = 0; offlineCalls = 0; cfg = $Cfg }
    $script:F = $f
    $ops = @{
        GetRadioState  = { if ($script:F.cfg.readFails) { throw 'radio read failed (fake)' }; $script:F.radio }
        SetRadioState  = { param($d)
            [void]$script:F.sets.Add($d)
            if ($d -eq 'Off' -and $script:F.cfg.disableThrowsAfterSwitch) { $script:F.radio = 'Off'; throw 'SetStateAsync(Off) failed after switching (fake)' }
            if ($d -eq 'Off' -and $script:F.cfg.disableThrows) { throw 'SetStateAsync(Off) failed (fake)' }
            if ($d -eq 'Off' -and $script:F.cfg.disableIgnored) { return $script:F.radio }
            if ($d -ne 'Off' -and $script:F.cfg.restoreThrows) { throw 'SetStateAsync(On) failed (fake)' }
            $script:F.radio = $d; $script:F.radio }
        ConfirmOffline = { $script:F.offlineCalls++; -not $script:F.cfg.neverOffline }
        RunAcceptance  = { $script:F.accRuns++
            if ($script:F.cfg.accThrows) { throw 'acceptance crashed (fake)' }
            if ($script:F.cfg.radioOnDuringAcc) { $script:F.radio = 'On' }
            @{ exitCode = $(if ($script:F.cfg.accTimeout) { $null } elseif ($script:F.cfg.ContainsKey('accExit')) { $script:F.cfg.accExit } else { 0 }); timedOut = [bool]$script:F.cfg.accTimeout; evidence = @('fake') } }
        ConfirmOnline  = { $true }
        Sleep          = { param($s) }
        Log            = { param($m) [void]$script:F.log.Add($m) }
    }
    return $ops
}
function Run([hashtable]$Cfg) { $ops = New-Fake $Cfg; $r = Invoke-OfflineAcceptanceRun $ops -OfflineTimeoutSec 6 -OnlineTimeoutSec 6 -PollSec 3; return $r }
$logHas = { param($re) @($script:F.log | Where-Object { $_ -match $re }).Count -gt 0 }

$r = Run @{}
Check ($r.acceptancePassed -and $r.exitCode -eq 0 -and $script:F.accRuns -eq 1 -and ($script:F.sets -join ',') -eq 'Off,On' -and $r.restore -eq 'restored' -and $script:F.radio -eq 'On') `
    'O1 happy path: before recorded, radio off and confirmed, acceptance once, restored to On, exit 0' $r
Check ((& $logHas 'Wi-Fi radio before: On') -and (& $logHas 'Wi-Fi restore: SUCCEEDED')) 'O1b the state before and the restore success are logged explicitly' $script:F.log

$r = Run @{ disableThrows = $true }
Check ((-not $r.acceptancePassed) -and $r.exitCode -eq 3 -and $script:F.accRuns -eq 0 -and ($script:F.sets -join ',') -eq 'Off,On' -and $r.restore -eq 'restored') `
    'O2 failure DURING disable: acceptance not run, restore still attempted and succeeded, exit 3' $r
$r = Run @{ disableThrowsAfterSwitch = $true }
Check ((-not $r.acceptancePassed) -and $script:F.accRuns -eq 0 -and $script:F.radio -eq 'On' -and $r.restore -eq 'restored') 'O3 disable fails AFTER the radio switched: the radio is still restored to On' $r
$r = Run @{ disableIgnored = $true }
Check ((-not $r.acceptancePassed) -and $r.exitCode -eq 3 -and $script:F.accRuns -eq 0 -and -not $r.radioOffConfirmed -and $r.error -match 'NOT run') 'O4 radio still On after "switching off": not confirmed, acceptance NOT run' $r
$r = Run @{ neverOffline = $true }
Check ((-not $r.acceptancePassed) -and $r.exitCode -eq 3 -and $script:F.accRuns -eq 0 -and $r.radioOffConfirmed -and -not $r.offlineConfirmed -and $r.restore -eq 'restored') `
    'O5 radio off but offline never confirmed (timeout): acceptance NOT run, radio restored' $r
$r = Run @{ accThrows = $true }
Check ((-not $r.acceptancePassed) -and $r.exitCode -eq 1 -and $script:F.accRuns -eq 1 -and $r.restore -eq 'restored' -and $script:F.radio -eq 'On') `
    'O6 failure DURING acceptance (exception): reported failed, radio restored' $r
$r = Run @{ accTimeout = $true }
Check ((-not $r.acceptancePassed) -and $r.exitCode -eq 1 -and $r.scriptTimedOut -and $r.restore -eq 'restored') 'O7 acceptance timeout: reported failed (exit 1), radio restored' $r
$r = Run @{ accExit = 1 }
Check ((-not $r.acceptancePassed) -and $r.exitCode -eq 1 -and $r.restore -eq 'restored') 'O8 acceptance failed (exit 1): wrapper exits 1, radio restored' $r
$r = Run @{ radioOnDuringAcc = $true }
Check ((-not $r.acceptancePassed) -and $r.exitCode -eq 1 -and $r.radioAfterAcceptance -eq 'On') 'O9 acceptance exit 0 but the radio was On when it finished: NOT passed (exit 1)' $r
$r = Run @{ restoreThrows = $true }
Check ($r.acceptancePassed -and $r.exitCode -eq 4 -and $r.restore -match '^FAILED' -and (& $logHas 'Wi-Fi restore: FAILED')) 'O10 restore failure is logged explicitly and makes the wrapper exit 4' $r
$r = Run @{ readFails = $true }
Check ((-not $r.acceptancePassed) -and $r.exitCode -eq 3 -and $script:F.sets.Count -eq 0 -and $script:F.accRuns -eq 0 -and $r.restore -match '^not-changed') `
    'O11 radio state cannot be read: nothing is switched, nothing restored, acceptance NOT run' $r
$r = Run @{ initial = 'Off' }
Check ($r.acceptancePassed -and $r.exitCode -eq 0 -and $script:F.sets.Count -eq 0 -and $r.restore -match '^not-needed' -and $script:F.radio -eq 'Off') `
    'O12 radio already Off: not switched, acceptance runs, left Off (its recorded state)' $r

Write-Host "`n$($script:passed) passed, $($script:failed) failed"
exit $(if ($script:failed -eq 0) { 0 } else { 1 })
