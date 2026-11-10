# Browser Stage 2 live run through the REAL HUD: ONE natural-language request with two ordered browser steps on a
# loopback fixture site (scripts\hud\browser-fixture-site.mjs) in D-ASK's own headless Chromium.
#   request typed into the real HUD -> daemon -> agent host + local model -> browser.fill_field (approval card 1 in the
#   real HUD) -> APPROVE -> filled + verified -> browser.click_element (card 2, same task) -> APPROVE -> clicked + verified
#   -> ONE completed result. The site independently logs the submission ("SUBSCRIBE <email>").
# Then a second request whose FIRST card is DENIED: nothing filled, no second card, no submission.
#
# Safety: the P0 helpers are reused verbatim (as approval-live-input.ps1). Browser read + actions are enabled for THIS
# daemon process only (environment); appsettings and code defaults stay off (checked). The site listens on 127.0.0.1
# only. Nothing is retried; an uncertain step aborts.
#
#   powershell -ExecutionPolicy Bypass -File scripts\hud\approval-live-browser.ps1 -OutDir results\browser-stage2\hud-<stamp>
#
# Exit code 0 only if every check passed and nothing was aborted.
param([Parameter(Mandatory = $true)][string]$OutDir, [string]$Root, [string]$Config = 'Debug')
$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = (Resolve-Path "$PSScriptRoot\..\..").Path }
if ((Test-Path $OutDir) -and @(Get-ChildItem $OutDir -Force).Count -gt 0) { throw "OutDir must be new or empty: $OutDir" }
New-Item -ItemType Directory -Force $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path
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
    flags = '0b browser flags default OFF in appsettings.json and in code; enabled here only through this run''s environment'
    setup = '0 setup: real HUD handshook with the real daemon; HUD interactive; loopback fixture site ready'
    pre   = '0c memory preflight: the local model would be admitted with the HUD running'
    b1a = '1a ONE request (fill, then click) came back as a NEW approval for the FILL showing the site, the field and the complete text'
    b1b = '1b APPROVE the fill: both logs show approved=true; the daemon consumed it once (Browser.Fill)'
    b1c = '1c a SECOND approval in the same task (no result yet) shows the CLICK on the Subscribe button of the same site'
    b1d = '1d APPROVE the click: the daemon consumed it once (Browser.Click); ONE completed result says Verified'
    b1e = '1e the site independently received exactly ONE submission, with exactly the approved text'
    b2  = '2 second request: the FILL card is DENIED: no second card, no submission, not reported as completed'
    nav = '3 the loopback site received the page-flow requests (non-loopback sockets are checked by the offline wrapper''s monitor, not here)'
    end = '4 end state: the site''s submissions are exactly the approved one'
}

function Restore-HudFront {
    if ([HudInput]::GetForegroundWindow() -eq $script:hwnd) { return }
    if ((Get-HudMode $script:hwnd) -eq 'interactive') { Send-HudToggleHotkey; try { [void](Wait-HudMode $script:hwnd 'ambient' 3000) } catch { } }
    Enter-HudInteractive $script:hwnd
    Assert-HudForeground $script:hwnd
    Start-Sleep -Milliseconds 1200
    [void](Find-HudElement $script:hwnd -AutomationId 'ultron-command' -TimeoutMs 8000)
}
function Approve-Card($Marks, $A, [bool]$Approve) {
    $click = Invoke-GuardedClick -Label $(if ($Approve) { 'APPROVE' } else { 'DENY' }) -ButtonPattern $(if ($Approve) { '^APPROVE$' } else { '^DENY$' }) -WaitEnabled
    if (-not $click.sent) { return [pscustomobject]@{ ok = $false; click = $click; decision = $null } }
    $d = Confirm-Decision $Marks $A.Id $Approve $click
    return [pscustomobject]@{ ok = ($d.evidence.state -eq 'confirmed'); click = $click; decision = $d }
}

$script:hudLog = Join-Path $OutDir 'hud.log'
$script:daemonLog = Join-Path $OutDir 'daemon.log'
$siteLog = Join-Path $OutDir 'site.log'
function Site-Lines { if (Test-Path $siteLog) { @(Get-Content $siteLog) } else { @() } }
function Site-Subs { @(Site-Lines | Where-Object { $_ -like 'SUBSCRIBE *' }) }
function Wait-Cond([scriptblock]$Cond, [int]$TimeoutMs = 10000) { $sw = [Diagnostics.Stopwatch]::StartNew(); while ($sw.ElapsedMilliseconds -lt $TimeoutMs) { if (& $Cond) { return $true }; Start-Sleep -Milliseconds 100 }; return $false }

$node = (Get-Command node).Source
$sitePsi = New-Object Diagnostics.ProcessStartInfo $node
$sitePsi.Arguments = "`"$Root\scripts\hud\browser-fixture-site.mjs`" `"$siteLog`""
$sitePsi.UseShellExecute = $false; $sitePsi.CreateNoWindow = $true
$site = [Diagnostics.Process]::Start($sitePsi)
if (-not (Wait-Cond { @(Site-Lines | Where-Object { $_ -like 'PORT *' }).Count -gt 0 } 15000)) { throw 'the fixture site did not start' }
$port = [int](@(Site-Lines | Where-Object { $_ -like 'PORT *' })[0].Split(' ')[1])
$hostPort = "127.0.0.1:$port"
$email = 'me@example.com'

$env:DASK_AgentHost__BrowserRead = 'true'      # this run only
$env:DASK_AgentHost__BrowserActions = 'true'   # this run only
try {
    $settings = Get-Content (Join-Path $Root 'src\DAsk.Daemon\appsettings.json') -Raw | ConvertFrom-Json
    $src = Get-Content (Join-Path $Root 'src\DAsk.Daemon\AgentHost\AgentHostManager.cs') -Raw
    $cfgOff = (-not ($settings.AgentHost.PSObject.Properties.Name -contains 'BrowserActions') -or $settings.AgentHost.BrowserActions -eq $false) -and
              (-not ($settings.AgentHost.PSObject.Properties.Name -contains 'BrowserRead') -or $settings.AgentHost.BrowserRead -eq $false)
    $codeOff = ($src -match 'public bool BrowserRead \{ get; set; \} = false;') -and ($src -match 'public bool BrowserActions \{ get; set; \} = false;')
    Record $N.flags ($cfgOff -and $codeOff) @{ appsettingsOff = $cfgOff; codeDefaultOff = $codeOff; enabledForThisRunVia = 'environment of this daemon process only' }

    & "$PSScriptRoot\start-stack.ps1" -OutDir $OutDir -Config $Config -Root $Root | Out-Null
    $pids = Get-Content "$OutDir\pids.json" -Raw | ConvertFrom-Json
    $script:hwnd = Get-HudHwnd $pids.hud
    if (-not (Wait-Cond { (Get-Content $script:hudLog -Raw -ErrorAction SilentlyContinue) -match 'Handshake accepted' } 30000)) { Record $N.setup $false @{ handshake = $false }; Abort 'no handshake' }
    else { Enter-HudInteractive $script:hwnd; Record $N.setup $true @{ site = $hostPort; sitePid = $site.Id } }

    if (-not $script:Aborted) {
        try {
            $adm = Get-ModelMemoryAdmission $Root; $mp = Test-ModelMemoryPreflight $adm
            [pscustomobject]@{ utc = (Get-Utc); measurement = $adm; decision = $mp } | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 (Join-Path $OutDir 'memory-preflight.json')
            Record $N.pre $mp.ok @{ availableMB = $adm.availableMB; requiredMB = $adm.requiredMB }
            if (-not $mp.ok) { Abort $mp.reason }
        } catch { Record $N.pre $false @{ error = "$_" }; Abort "memory preflight failed: $_" }
    }

    # ---- 1. fill, then click; both approved ----
    if (-not $script:Aborted) {
        Restore-HudFront
        $s = Invoke-Request "On http://$hostPort/form, type `"$email`" into the Email field, then click the Subscribe button"
        if (-not $s.Ok) { Record $N.b1a $false @{ submit = $s.Record }; Abort "request 1 not submitted: $($s.Reason)" } else {
            $a1 = Wait-NewApproval $s.Marks
            if ($a1.Found) { Set-Content -Encoding utf8 (Join-Path $OutDir 'card-1-fill.txt') $a1.Text }
            $shows = $a1.Found -and (Contains-Text $a1.Text 'Fill the') -and (Contains-Text $a1.Text 'Email') -and (Contains-Text $a1.Text $email) -and (Contains-Text $a1.Text $hostPort) -and (Contains-Text $a1.Text 'Nothing is submitted')
            Record $N.b1a $shows @{ approvalId = $a1.Id; reason = $a1.Reason }
            if (-not $shows) { Abort "fill card: $($a1.Reason)" } else {
                $m2 = Mark-Logs
                $d1 = Approve-Card $s.Marks $a1 $true
                $fillLog = if ($d1.ok) { Wait-Log 'daemon' $s.Marks '\[BrowserAction\] Browser\.Fill approved and consumed for task' 20000 } else { $null }
                Record $N.b1b ($d1.ok -and $fillLog.Found) @{ click = $d1.click; decision = $d1.decision; daemon = $(if ($fillLog -and $fillLog.Found) { $fillLog.Match.Value } else { $null }) }
                if (-not ($d1.ok -and $fillLog.Found)) { Abort 'the fill was not approved and consumed' } else {
                    $a2 = Wait-NewApproval $m2 60000
                    if ($a2.Found) { Set-Content -Encoding utf8 (Join-Path $OutDir 'card-2-click.txt') $a2.Text }
                    $two = $a2.Found -and $a2.Id -ne $a1.Id -and (Contains-Text $a2.Text 'Click ONCE on the') -and (Contains-Text $a2.Text 'Subscribe') -and (Contains-Text $a2.Text $hostPort) -and
                        -not ((Read-LogSince $script:hudLog $s.Marks.hud) -match 'HUD received IPC message: AgentTaskResultNotification')
                    Record $N.b1c $two @{ approvalId = $a2.Id; firstApprovalId = $a1.Id; reason = $a2.Reason; submissionsBeforeClick = @(Site-Subs).Count }
                    if (-not $two) { Abort "click card: $($a2.Reason)" } else {
                        Restore-HudFront
                        $d2 = Approve-Card $m2 $a2 $true
                        $clickLog = if ($d2.ok) { Wait-Log 'daemon' $m2 '\[BrowserAction\] Browser\.Click approved and consumed for task' 20000 } else { $null }
                        $r = Wait-NewResult $s.Marks 'Verified'
                        $resultCount = [regex]::Matches((Read-LogSince $script:hudLog $s.Marks.hud), 'HUD received IPC message: AgentTaskResultNotification').Count
                        Record $N.b1d ($d2.ok -and $clickLog.Found -and $r.matched -and $r.outcome -eq 'COMPLETED' -and $resultCount -eq 1) @{ decision = $d2.decision; daemon = $(if ($clickLog -and $clickLog.Found) { $clickLog.Match.Value } else { $null }); result = @{ arrived = $r.arrived; outcome = $r.outcome; results = $resultCount } }
                        $subOk = Wait-Cond { @(Site-Subs).Count -ge 1 } 5000
                        Start-Sleep -Milliseconds 500
                        $subs = @(Site-Subs)
                        Record $N.b1e ($subOk -and $subs.Count -eq 1 -and $subs[0] -eq ('SUBSCRIBE "' + $email + '"')) @{ submissions = $subs }
                    }
                }
            }
        }
    }

    # ---- 2. DENY the fill: nothing else happens ----
    if (-not $script:Aborted) { if ((Wait-PanelClosed) -lt 0) { Abort 'the previous approval panel did not close' } }
    if (-not $script:Aborted) {
        Restore-HudFront
        $subs0 = @(Site-Subs).Count
        $s = Invoke-Request "On http://$hostPort/form, type `"deny@example.com`" into the Email field, then click the Subscribe button"
        if (-not $s.Ok) { Record $N.b2 $false @{ submit = $s.Record }; Abort "request 2 not submitted: $($s.Reason)" } else {
            $a = Wait-NewApproval $s.Marks
            if (-not $a.Found) { Record $N.b2 $false @{ reason = $a.Reason }; Abort "request 2: $($a.Reason)" } else {
                $m3 = Mark-Logs
                $d = Approve-Card $s.Marks $a $false
                $r = Wait-NewResult $s.Marks ''
                Start-Sleep -Milliseconds 3000
                $second = (Read-LogSince $script:hudLog $m3.hud) -match 'Approval surface opened for'
                $consumed = (Read-LogSince $script:daemonLog $s.Marks.daemon) -match '\[BrowserAction\] Browser\.\w+ approved and consumed'
                Record $N.b2 ($d.ok -and -not $second -and -not $consumed -and @(Site-Subs).Count -eq $subs0 -and $r.arrived -and $r.outcome -ne 'COMPLETED') @{
                    decision = $d.decision; secondCard = $second; anythingConsumed = $consumed; submissions = @(Site-Subs).Count; result = @{ arrived = $r.arrived; outcome = $r.outcome } }
            }
        }
    }
} catch {
    Record 'unexpected error' $false @{ error = "$($_.Exception.Message)" }
    Abort "unexpected error: $($_.Exception.Message)"
} finally {
    try {
        $hits = @(Site-Lines | Where-Object { $_ -like 'HIT *' })
        Record $N.nav ($hits.Count -ge 1) @{ requestsSeenBySite = $hits.Count; note = 'the browser cannot resolve any name (host-resolver lockdown); non-loopback sockets are checked by the offline wrapper' }
        $subs = @(Site-Subs)
        Record $N.end (($subs.Count -eq 0 -and $script:Aborted) -or ($subs.Count -eq 1 -and $subs[0] -eq ('SUBSCRIBE "' + $email + '"'))) @{ submissions = $subs }
    } catch { Record $N.end $false @{ error = "$($_.Exception.Message)" } }
    try { & "$PSScriptRoot\stop-stack.ps1" -OutDir $OutDir | Out-Null } catch { }
    try { if (-not $site.HasExited) { $site.Kill() } } catch { }
    foreach ($v in 'BrowserRead', 'BrowserActions') { Remove-Item "Env:\DASK_AgentHost__$v" -ErrorAction SilentlyContinue }
    foreach ($k in $N.Keys) { if (-not ($script:results | Where-Object { $_.name -eq $N[$k] })) { Record $N[$k] $false @{ notRun = "not reached: $($script:AbortReason)" } } }
    $checks = @($script:results.ToArray() | Where-Object { $_.name -ne 'unexpected error' })
    $passed = @($checks | Where-Object { $_.pass -eq $true }).Count
    $failed = @($script:results.ToArray() | Where-Object { $_.pass -ne $true }).Count
    $summary = [ordered]@{ expectedTotal = $script:ExpectedChecks; total = $checks.Count; passed = $passed; failed = $failed; aborted = $script:Aborted; abortReason = $script:AbortReason }
    ConvertTo-Json -InputObject @($script:results.ToArray()) -Depth 8 | Set-Content -Encoding utf8 (Join-Path $OutDir 'approval-live.json')
    ConvertTo-Json -InputObject ([pscustomobject]$summary) -Depth 6 | Set-Content -Encoding utf8 (Join-Path $OutDir 'approval-live-summary.json')
    Write-Host "`n$passed / $($checks.Count) checks passed (expected $($script:ExpectedChecks)); failed $failed; aborted: $($script:Aborted)$(if ($script:AbortReason) { " ($($script:AbortReason))" })"
    Write-Host "Results: $OutDir"
    if ($passed -ne $script:ExpectedChecks -or $script:Aborted) { exit 1 }
}
