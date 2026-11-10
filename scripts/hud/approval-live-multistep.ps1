# P1/P2 multi-step live run: ONE natural-language request with two ordered input steps, through the REAL HUD, on ONE
# disposable fixture window. Each step is a separate approval card in the real HUD; step 2 is asked for only after step 1
# was performed AND verified; a DENY of step 2 leaves step 1's verified effect and nothing else.
#   request typed into the real HUD -> daemon -> agent host + local model -> ordered input facets -> approval 1 (type) ->
#   APPROVE -> typed + verified -> approval 2 (Backspace), a NEW card in the same task -> APPROVE -> verified -> ONE
#   completed result. The fixture independently reports its text ("TEXT len sha256").
#
# Safety: the same guards as approval-live-input.ps1 (whose P0 helper loading is reused verbatim). Only the fixture this
# script creates receives input; mouse and keyboard input are enabled for THIS daemon process only (environment).
# Nothing is retried; an uncertain step aborts.
#
#   powershell -ExecutionPolicy Bypass -File scripts\hud\approval-live-multistep.ps1 -OutDir results\p1p2-multistep\live-<stamp>
#
# Exit code 0 only if every check passed and nothing was aborted.
param([Parameter(Mandatory = $true)][string]$OutDir, [string]$Root, [string]$Config = 'Debug')
$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = (Resolve-Path "$PSScriptRoot\..\..").Path }
if ((Test-Path $OutDir) -and @(Get-ChildItem $OutDir -Force).Count -gt 0) { throw "OutDir must be new or empty: $OutDir" }
New-Item -ItemType Directory -Force $OutDir | Out-Null
$keepOut = $OutDir; $keepRoot = $Root; $keepConfig = $Config
. "$PSScriptRoot\approval-live-7b3.ps1" -OutDir $keepOut -Root $keepRoot -Config $keepConfig -LoadFunctionsOnly
$OutDir = $keepOut; $Root = $keepRoot; $Config = $keepConfig
$ErrorActionPreference = 'Stop'
$p0Lines = Get-Content "$PSScriptRoot\approval-live-7b3.ps1"
$from = [Array]::FindIndex($p0Lines, [Predicate[string]] { param($l) $l -eq 'if ($LoadFunctionsOnly) { return }' })
if ($from -lt 0) { throw 'the P0 harness layout changed; refusing to guess which helpers to load' }
$to = [Array]::FindIndex($p0Lines, $from + 1, [Predicate[string]] { param($l) $l -match '^\S' -and $l -notmatch '^(function |\}|#|\$script:procNames = @\{\})' })
if ($to -le $from + 1) { throw 'the P0 helper region could not be delimited; refusing to run it' }
$helperText = ($p0Lines[($from + 1)..($to - 1)] -join "`r`n")
foreach ($fn in 'Invoke-Request', 'Invoke-GuardedClick', 'Wait-NewApproval', 'Confirm-Decision', 'Wait-NewResult', 'Wait-PanelClosed', 'Wait-Log') {
    if ($helperText -notmatch "(?m)^function $fn\b") { throw "the P0 helper region does not define $fn; refusing to run" }
}
. ([scriptblock]::Create($helperText))

$script:ExpectedChecks = 11
$N = [ordered]@{
    setup = '0 setup: real HUD handshook with the real daemon (input enabled for THIS run only); HUD interactive; input fixture ready'
    flags = '0b input flags default OFF in appsettings.json and in code; enabled here only through this run''s environment'
    pre   = '0c memory preflight: the local model would be admitted with the HUD running'
    m1a = '1a ONE request with two steps (type, then Backspace) came back as a NEW approval for step 1 showing the complete text'
    m1b = '1b APPROVE step 1: both logs show approved=true; the daemon typed and verified it'
    m1c = '1c the fixture independently reports exactly the step-1 text'
    m2a = '2a a SECOND, different approval in the same task (no result yet) shows step 2 (Press Backspace ONCE)'
    m2b = '2b APPROVE step 2 (the card took the click: pass-through had ended); the daemon pressed and verified it; ONE completed result says Verified'
    m2c = '2c the fixture independently reports the text one character shorter'
    m3 = '3 second request: step 1 approved and verified, step 2 DENIED: no key sent, the fixture keeps exactly step 1''s text, no third approval, not reported as completed'
    end = '4 end state: the fixture exists; its final text is exactly what was approved and verified'
}

$fxFile = Join-Path $OutDir 'fixture-reports.txt'
function Fx-Lines { if (Test-Path $fxFile) { @(Get-Content $fxFile) } else { @() } }
function Fx-LastText { $t = @(Fx-Lines | Where-Object { $_ -like 'TEXT *' }); if ($t.Count) { $p = $t[-1].Split(' '); [pscustomobject]@{ len = [int]$p[1]; sha = $p[2] } } else { [pscustomobject]@{ len = 0; sha = $null } } }
function Sha([string]$s) { ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($s)))).Replace('-', '') }
function Wait-Fx([scriptblock]$Cond, [int]$TimeoutMs = 10000) { $sw = [Diagnostics.Stopwatch]::StartNew(); while ($sw.ElapsedMilliseconds -lt $TimeoutMs) { if (& $Cond) { return $true }; Start-Sleep -Milliseconds 50 }; return $false }
function Fx-Holds([string]$s, [int]$TimeoutMs = 5000) { Wait-Fx { $t = Fx-LastText; $t.len -eq $s.Length -and $t.sha -eq (Sha $s) } $TimeoutMs }
function InputLog($Marks, [string]$Tool) { Wait-Log 'daemon' $Marks ('\[DesktopInput\] ' + [regex]::Escape($Tool) + ' for task \S+: (\d+)/(\d+) steps, stopped=(\S+), verified=(\w+) \(([^)]*)\)') 30000 }
function Verified($exec) { $exec.Found -and $exec.Match.Groups[4].Value -eq 'True' -and $exec.Match.Groups[3].Value -eq 'no' }

# Same as approval-live-input.ps1: between actions (no input running), bring the HUD back in front with its own hotkey.
function Restore-HudFront {
    if ([HudInput]::GetForegroundWindow() -eq $script:hwnd) { return }
    if ((Get-HudMode $script:hwnd) -eq 'interactive') {
        Send-HudToggleHotkey
        try { [void](Wait-HudMode $script:hwnd 'ambient' 3000) } catch { }
    }
    Enter-HudInteractive $script:hwnd
    Assert-HudForeground $script:hwnd
    Start-Sleep -Milliseconds 1200
    [void](Find-HudElement $script:hwnd -AutomationId 'ultron-command' -TimeoutMs 8000)
}

# Approve the pending card $A (found after $Marks); returns the confirmed decision or $null (recorded by the caller).
function Approve-Card($Marks, $A, [bool]$Approve) {
    $click = Invoke-GuardedClick -Label $(if ($Approve) { 'APPROVE' } else { 'DENY' }) -ButtonPattern $(if ($Approve) { '^APPROVE$' } else { '^DENY$' }) -WaitEnabled
    if (-not $click.sent) { return [pscustomobject]@{ ok = $false; click = $click; decision = $null } }
    $d = Confirm-Decision $Marks $A.Id $Approve $click
    return [pscustomobject]@{ ok = ($d.evidence.state -eq 'confirmed'); click = $click; decision = $d }
}

$script:hudLog = Join-Path $OutDir 'hud.log'
$script:daemonLog = Join-Path $OutDir 'daemon.log'
$tag = [Guid]::NewGuid().ToString('N').Substring(0, 6)
$title = "DASK Input Fixture $tag"
$fxPsi = New-Object Diagnostics.ProcessStartInfo 'powershell.exe'
$fxPsi.Arguments = "-NoProfile -STA -ExecutionPolicy Bypass -File `"$Root\tests\DAsk.Daemon.Tests\Fixtures\input-fixture.ps1`" -Title `"$title`" -X 140 -Y 140 -OutFile `"$fxFile`""
$fxPsi.UseShellExecute = $false; $fxPsi.CreateNoWindow = $true
$fx = [Diagnostics.Process]::Start($fxPsi)
if (-not (Wait-Fx { @(Fx-Lines | Where-Object { $_ -like 'READY *' }).Count -gt 0 } 30000)) { throw 'the input fixture did not start' }
$script:fxHwnd = [IntPtr][int64](@(Fx-Lines | Where-Object { $_ -like 'READY *' })[0].Split(' ')[1])
$typed = ''   # what the fixture should contain, from approved and verified steps only

$env:DASK_AgentHost__DesktopReadAllowedProcessIds__0 = "$($fx.Id)"
$env:DASK_AgentHost__DesktopActionExecution = 'true'
$env:DASK_AgentHost__DesktopMouseInput = 'true'      # this run only
$env:DASK_AgentHost__DesktopKeyboardInput = 'true'   # this run only
try {
    $settings = Get-Content (Join-Path $Root 'src\DAsk.Daemon\appsettings.json') -Raw | ConvertFrom-Json
    $src = Get-Content (Join-Path $Root 'src\DAsk.Daemon\AgentHost\AgentHostManager.cs') -Raw
    $cfgOff = (-not ($settings.AgentHost.PSObject.Properties.Name -contains 'DesktopMouseInput') -or $settings.AgentHost.DesktopMouseInput -eq $false) -and
              (-not ($settings.AgentHost.PSObject.Properties.Name -contains 'DesktopKeyboardInput') -or $settings.AgentHost.DesktopKeyboardInput -eq $false)
    $codeOff = ($src -match 'public bool DesktopMouseInput \{ get; set; \} = false;') -and ($src -match 'public bool DesktopKeyboardInput \{ get; set; \} = false;')
    Record $N.flags ($cfgOff -and $codeOff) @{ appsettingsOff = $cfgOff; codeDefaultOff = $codeOff; enabledForThisRunVia = 'environment of this daemon process only' }

    & "$PSScriptRoot\start-stack.ps1" -OutDir $OutDir -Config $Config -Root $Root | Out-Null
    $script:hwnd = Get-HudHwnd ((Get-Content "$OutDir\pids.json" -Raw | ConvertFrom-Json).hud)
    # Wait (bounded) for the handshake rather than a fixed delay: the daemon's pipe can take several seconds to appear.
    [void](Wait-Fx { (Get-Content $script:hudLog -Raw -ErrorAction SilentlyContinue) -match 'Handshake accepted|Could not register Ctrl\+Alt\+Space' } 30000)
    Start-Sleep -Seconds 1
    if ((Get-Content $script:hudLog -Raw) -match 'Could not register Ctrl\+Alt\+Space') {
        Record $N.setup $false @{ blocked = 'another application owns Ctrl+Alt+Space' }; Abort 'Ctrl+Alt+Space is owned by another application'
    } else {
        Enter-HudInteractive $script:hwnd
        $ok = ((Get-Content $script:hudLog -Raw) -match 'Handshake accepted') -and [Fx7B2]::IsWindow($script:fxHwnd)
        Record $N.setup $ok @{ fixturePid = $fx.Id; fixtureHwnd = [int64]$script:fxHwnd; title = $title }
        if (-not $ok) { Abort 'setup failed' }
    }
    if (-not $script:Aborted) {
        try {
            $adm = Get-ModelMemoryAdmission $Root; $mp = Test-ModelMemoryPreflight $adm
            Record $N.pre $mp.ok @{ availableMB = $adm.availableMB; requiredMB = $adm.requiredMB }
            if (-not $mp.ok) { Abort $mp.reason }
        } catch { Record $N.pre $false @{ error = "$_" }; Abort "memory preflight failed: $_" }
    }

    # ---- 1/2. one request, two steps, both approved ----
    if (-not $script:Aborted) {
        $text1 = 'ok'
        Restore-HudFront
        $s = Invoke-Request "Type `"$text1`" into the notes field of the window titled `"$title`", then press Backspace"
        if (-not $s.Ok) { Record $N.m1a $false @{ submit = $s.Record }; Abort "request 1 not submitted: $($s.Reason)" } else {
            $a1 = Wait-NewApproval $s.Marks
            if ($a1.Found) { Set-Content -Encoding utf8 (Join-Path $OutDir 'card-1-step1-type.txt') $a1.Text }
            $shows = $a1.Found -and (Contains-Text $a1.Text 'Type exactly the 2 character(s)') -and (Contains-Text $a1.Text $text1)
            Record $N.m1a $shows @{ approvalId = $a1.Id; reason = $a1.Reason }
            if (-not $shows) { Abort "step 1 card: $($a1.Reason)" } else {
                $m2 = Mark-Logs
                $d1 = Approve-Card $s.Marks $a1 $true
                $exec1 = if ($d1.ok) { InputLog $s.Marks 'desktop.type_text' } else { $null }
                Record $N.m1b ($d1.ok -and (Verified $exec1)) @{ click = $d1.click; decision = $d1.decision; daemonInput = $(if ($exec1 -and $exec1.Found) { $exec1.Match.Value } else { $null }) }
                if (-not ($d1.ok -and (Verified $exec1))) { Abort 'step 1 was not executed and verified' } else {
                    $typed = $text1
                    $h = Fx-Holds $typed
                    Record $N.m1c $h @{ expected = $typed.Length; fixture = (Fx-LastText) }
                    if (-not $h) { Abort 'the fixture does not hold exactly step 1''s text' } else {
                        $a2 = Wait-NewApproval $m2 60000
                        $two = $a2.Found -and $a2.Id -ne $a1.Id -and (Contains-Text $a2.Text 'Press Backspace ONCE') -and
                            -not ((Read-LogSince $script:hudLog $s.Marks.hud) -match 'HUD received IPC message: AgentTaskResultNotification')
                        if ($a2.Found) { Set-Content -Encoding utf8 (Join-Path $OutDir 'card-2-step2-keys.txt') $a2.Text }
                        Record $N.m2a $two @{ approvalId = $a2.Id; firstApprovalId = $a1.Id; reason = $a2.Reason; passthroughEndedLogged = ((Read-LogSince $script:hudLog $m2.hud) -match 'Input pass-through off') }
                        if (-not $two) { Abort "step 2 card: $($a2.Reason)" } else {
                            Restore-HudFront
                            $d2 = Approve-Card $m2 $a2 $true
                            $exec2 = if ($d2.ok) { InputLog $m2 'desktop.press_keys' } else { $null }
                            $r = Wait-NewResult $s.Marks 'Verified'
                            $resultCount = [regex]::Matches((Read-LogSince $script:hudLog $s.Marks.hud), 'HUD received IPC message: AgentTaskResultNotification').Count
                            $ok2 = $d2.ok -and (Verified $exec2) -and $r.matched -and $r.outcome -eq 'COMPLETED' -and $resultCount -eq 1
                            Record $N.m2b $ok2 @{ click = $d2.click; decision = $d2.decision; daemonInput = $(if ($exec2 -and $exec2.Found) { $exec2.Match.Value } else { $null }); result = @{ arrived = $r.arrived; outcome = $r.outcome; results = $resultCount } }
                            if (-not ($d2.ok -and (Verified $exec2))) { Abort 'step 2 was not executed and verified' } else {
                                $typed = $typed.Substring(0, $typed.Length - 1)
                                $h2 = Fx-Holds $typed
                                Record $N.m2c $h2 @{ expected = $typed.Length; fixture = (Fx-LastText) }
                                if (-not $h2) { Abort 'the fixture text did not lose exactly one character' }
                            }
                        }
                    }
                }
            }
        }
    }

    # ---- 3. second request: approve step 1, DENY step 2 ----
    if (-not $script:Aborted) { if ((Wait-PanelClosed) -lt 0) { Abort 'the previous approval panel did not close' } }
    if (-not $script:Aborted) {
        $text3 = 'xy'
        Restore-HudFront
        $s = Invoke-Request "Type `"$text3`" into the notes field of the window titled `"$title`", then press Backspace"
        $detail = [ordered]@{}
        $pass = $false
        if ($s.Ok) {
            $a1 = Wait-NewApproval $s.Marks
            $detail.approval1 = $a1.Id
            if ($a1.Found) {
                $m2 = Mark-Logs
                $d1 = Approve-Card $s.Marks $a1 $true
                $exec1 = if ($d1.ok) { InputLog $s.Marks 'desktop.type_text' } else { $null }
                $detail.step1 = @{ decision = $d1.decision; daemonInput = $(if ($exec1 -and $exec1.Found) { $exec1.Match.Value } else { $null }) }
                if ($d1.ok -and (Verified $exec1) -and (Fx-Holds ($typed + $text3))) {
                    $typed = $typed + $text3
                    $a2 = Wait-NewApproval $m2 60000
                    $detail.approval2 = $a2.Id
                    if ($a2.Found -and $a2.Id -ne $a1.Id) {
                        Restore-HudFront
                        $m3 = Mark-Logs
                        $dn = Approve-Card $m2 $a2 $false
                        $r = Wait-NewResult $s.Marks 'declined|not approved|Nothing was done'
                        Start-Sleep -Milliseconds 1500
                        $noKey = -not ((Read-LogSince $script:daemonLog $m3.daemon) -match '\[DesktopInput\] desktop\.press_keys for task \S+: \d+/\d+ steps')
                        $noThird = -not ((Read-LogSince $script:hudLog $m3.hud) -match 'Approval surface opened for')
                        $kept = Fx-Holds $typed 2000
                        $detail.step2 = @{ decision = $dn.decision; noKeySent = $noKey; noThirdApproval = $noThird; fixture = (Fx-LastText); result = @{ arrived = $r.arrived; outcome = $r.outcome } }
                        $pass = $dn.ok -and $noKey -and $noThird -and $kept -and $r.arrived -and $r.outcome -ne 'COMPLETED'
                    } else { $detail.reason = "no second approval: $($a2.Reason)" }
                } else { $detail.reason = 'step 1 was not executed and verified' }
            } else { $detail.reason = $a1.Reason }
        } else { $detail.submit = $s.Record }
        Record $N.m3 $pass $detail
        if (-not $pass) { Abort 'the deny-in-the-middle check failed' }
    }
} catch {
    Record 'unexpected error' $false @{ error = "$($_.Exception.Message)" }
    Abort "unexpected error: $($_.Exception.Message)"
} finally {
    try {
        $t = Fx-LastText
        Record $N.end ([Fx7B2]::IsWindow($script:fxHwnd) -and $t.len -eq $typed.Length -and ($typed.Length -eq 0 -or $t.sha -eq (Sha $typed))) @{ fixtureText = $t; expectedLength = $typed.Length }
    } catch { Record $N.end $false @{ error = "$($_.Exception.Message)" } }
    try { & "$PSScriptRoot\stop-stack.ps1" -OutDir $OutDir | Out-Null } catch { }
    try { if (-not $fx.HasExited) { $fx.Kill() } } catch { }
    foreach ($v in 'DesktopReadAllowedProcessIds__0', 'DesktopActionExecution', 'DesktopMouseInput', 'DesktopKeyboardInput') { Remove-Item "Env:\DASK_AgentHost__$v" -ErrorAction SilentlyContinue }

    foreach ($k in $N.Keys) { if (-not ($script:results | Where-Object { $_.name -eq $N[$k] })) { Record $N[$k] $false @{ notRun = "not reached: $($script:AbortReason)" } } }
    $dmAll = Read-LogSince $script:daemonLog 0
    $hudAll = Read-LogSince $script:hudLog 0
    $diag = [ordered]@{
        aborted = $script:Aborted; abortReason = $script:AbortReason
        approvalsShownByHud = [regex]::Matches($hudAll, 'Approval surface opened for').Count
        decisionsSentByHud = [regex]::Matches($hudAll, 'Action approval decision: approval_id=').Count
        decisionsReceivedByDaemon = [regex]::Matches($dmAll, 'Received user approval decision for').Count
        inputExecutions = [regex]::Matches($dmAll, '\[DesktopInput\] desktop\.\w+ for task').Count
        passthroughOn = [regex]::Matches($hudAll, 'Input pass-through on').Count
        passthroughOff = [regex]::Matches($hudAll, 'Input pass-through off').Count
    }
    $checks = @($script:results.ToArray() | Where-Object { $_.name -ne 'unexpected error' })
    $passed = @($checks | Where-Object { $_.pass -eq $true }).Count
    $failed = @($script:results.ToArray() | Where-Object { $_.pass -ne $true }).Count
    $summary = [ordered]@{ expectedTotal = $script:ExpectedChecks; total = $checks.Count; passed = $passed; failed = $failed; aborted = $script:Aborted; abortReason = $script:AbortReason; diagnostics = $diag }
    ConvertTo-Json -InputObject @($script:results.ToArray()) -Depth 8 | Set-Content -Encoding utf8 (Join-Path $OutDir 'approval-live.json')
    ConvertTo-Json -InputObject ([pscustomobject]$summary) -Depth 6 | Set-Content -Encoding utf8 (Join-Path $OutDir 'approval-live-summary.json')
    Write-Host "`n$passed / $($checks.Count) checks passed (expected $($script:ExpectedChecks)); failed $failed; aborted: $($script:Aborted)$(if ($script:AbortReason) { " ($($script:AbortReason))" })"
    Write-Host "Results: $OutDir"
}
exit $(if ($failed -eq 0 -and -not $script:Aborted -and $checks.Count -eq $script:ExpectedChecks) { 0 } else { 1 })
