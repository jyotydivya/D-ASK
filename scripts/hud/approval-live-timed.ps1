# Real-HUD acceptance of TIMED (scheduled) workflow execution: persistence across a restart, a due schedule actually firing,
# a step that still needs approval during the timed run, LastRunUtc/LastNote, and live unscheduling.
# Narrow by design: it does NOT repeat W1-W3 (approval-live-features.ps1). Helpers are loaded from the accepted P0 harness
# exactly as approval-live-features.ps1 does. Requests are typed into the REAL HUD; approvals are clicked in the REAL HUD card;
# effects are checked independently (workflow store file, files on disk, daemon/HUD logs).
# Workflows and FileOrganize are enabled ONLY in this run's environment (appsettings.json and code defaults stay off).
# The restart uses the official launcher (start-stack.ps1 / stop-stack.ps1) twice with the SAME store.
# NOTE: names and paths used in workflow steps must not contain the words "workflow" or "schedul" (step validation).
#   powershell -ExecutionPolicy Bypass -File scripts\hud\approval-live-timed.ps1 -OutDir results\timed-hud\live-<stamp>
param([Parameter(Mandatory = $true)][string]$OutDir, [string]$Root, [string]$Config = 'Debug', [int]$LeadMinutes = 7)
$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = (Resolve-Path "$PSScriptRoot\..\..").Path }
if ((Test-Path $OutDir) -and @(Get-ChildItem $OutDir -Force).Count -gt 0) { throw "OutDir must be new or empty: $OutDir" }
New-Item -ItemType Directory -Force $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path
if ($OutDir -match '(?i)workflow|\bschedul') { throw "OutDir must not contain 'workflow' or 'schedul' (it appears in a workflow step): $OutDir" }
$keepOut = $OutDir; $keepRoot = $Root; $keepConfig = $Config; $keepLead = $LeadMinutes
. "$PSScriptRoot\approval-live-7b3.ps1" -OutDir $keepOut -Root $keepRoot -Config $keepConfig -LoadFunctionsOnly
$OutDir = $keepOut; $Root = $keepRoot; $Config = $keepConfig; $LeadMinutes = $keepLead
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
. "$PSScriptRoot\timed-helpers.ps1"
. "$PSScriptRoot\stack-guard.ps1"

$script:ExpectedChecks = 17
$N = [ordered]@{
    flags = '0b Workflows and FileOrganize default OFF in appsettings.json and in code; enabled here only via this run''s environment'
    setup = '0 setup: real HUD handshook with the real daemon (run 1); HUD interactive'
    pre   = '0c memory preflight: the local model would be admitted with the HUD running'
    s1 = 'S1 save "nightly" (step 1 arithmetic, step 2 an organise request): COMPLETED, no card, the store holds exactly the two steps'
    s2 = 'S2 save "dropme" (one arithmetic step): COMPLETED, no card'
    s3 = 'S3 schedule "nightly" daily at T: a Workflow.Schedule card showing both steps and T; APPROVE; COMPLETED; the store holds the schedule (LastRunUtc null)'
    s4 = 'S4 schedule "dropme" daily at the same T: card; APPROVE; COMPLETED; store holds it'
    s5 = 'S5 live cancellation: "unschedule the workflow dropme" before T: COMPLETED; its schedule is gone from the store, the workflow is kept'
    r1 = 'R1 restart via start-stack/stop-stack: old daemon+HUD gone, new daemon+HUD handshook, the store file is byte-identical, "nightly" still scheduled, restart finished before T'
    f1 = 'F1 the WorkflowScheduler of the NEW daemon fired "nightly" at T (log: due ... submitted as task t...), once, not skipped/missed, within 90 s of T'
    f2 = 'F2 the timed run asked for approval: exactly one NEW Files.Organize card appeared with no typed request; APPROVE confirmed in both logs'
    f3 = 'F3 the timed run COMPLETED per the agent host''s own end-of-task line for that task id (a workflow is "completed" only if every step completed) and the organise step really moved the files on disk (the HUD presentation is recorded separately as an observation, never as a pass)'
    f4 = 'F4 the store now has LastRunUtc (at T, +-90 s) and LastNote "submitted as task ..." for "nightly"; "dropme" has none'
    u1 = 'U1 live unscheduling after the run: "unschedule the workflow nightly": COMPLETED; schedule gone, workflow kept'
    c1 = 'C1 the cancelled "dropme" never fired: no due line for it in either daemon log; exactly one due line (nightly) overall'
    log = 'L1 no D-ASK process reported a Workflows/FileOrganize error in either daemon log'
    end = 'Z  end state: flags still off in appsettings.json; no store/journal outside OutDir'
}

function Restore-HudFront {
    if ([HudInput]::GetForegroundWindow() -eq $script:hwnd) { return }
    if ((Get-HudMode $script:hwnd) -eq 'interactive') { Send-HudToggleHotkey; try { [void](Wait-HudMode $script:hwnd 'ambient' 3000) } catch { } }
    Enter-HudInteractive $script:hwnd
    Assert-HudForeground $script:hwnd
    Start-Sleep -Milliseconds 1200
    [void](Find-HudElement $script:hwnd -AutomationId 'ultron-command' -TimeoutMs 8000)
}
function Decide($Marks, $A, [bool]$Approve) {
    $click = Invoke-GuardedClick -Label $(if ($Approve) { 'APPROVE' } else { 'DENY' }) -ButtonPattern $(if ($Approve) { '^APPROVE$' } else { '^DENY$' }) -WaitEnabled
    if (-not $click.sent) { return [pscustomobject]@{ ok = $false; click = $click; decision = $null } }
    $d = Confirm-Decision $Marks $A.Id $Approve $click
    return [pscustomobject]@{ ok = ($d.evidence.state -eq 'confirmed'); click = $click; decision = $d }
}
# Waits (at most 10 s) until the mouse has not moved for 600 ms. It only chooses WHEN to try; it clicks nothing and relaxes no check.
function Wait-CursorQuiet {
    $sw = [Diagnostics.Stopwatch]::StartNew(); $last = Get-Cursor; $since = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt 10000) {
        Start-Sleep -Milliseconds 100
        $c = Get-Cursor
        if ($c.X -ne $last.X -or $c.Y -ne $last.Y) { $last = $c; $since.Restart() } elseif ($since.ElapsedMilliseconds -ge 600) { return $true }
    }
    return $false
}
# Run 20261112T170514 / U1: the guarded click refused ("the cursor is at 1650,104, not at the control's centre 1644,126": the pointer was moved
# by something other than the harness between SetCursorPos and the check; SetCursorPos itself reads back exactly, 90/90 DPI-aware probes), so the
# request was never typed and the check recorded an empty result. A refused click sends nothing (no click, no key), so another attempt is safe;
# EVERY attempt runs the full unchanged guard (identity, stable rectangle, centre +-1 px, window under cursor, HUD foreground, last-instant
# cursor check). At most 3 attempts, only for a click refusal; a refusal after typing started (or a daemon that never answered) is never retried.
function Next-Request([string]$Text) {
    if ((Wait-PanelClosed) -lt 0) { Abort 'the previous approval panel did not close'; return $null }
    $attempts = @(); $s = $null
    for ($i = 1; $i -le 3; $i++) {
        Restore-HudFront
        $quiet = Wait-CursorQuiet
        $s = Invoke-Request $Text
        $attempts += [pscustomobject]@{ attempt = $i; cursorQuietBefore = $quiet; ok = $s.Ok; reason = $s.Reason; utc = (Get-Utc) }
        if ($s.Ok -or $s.Reason -notmatch '^the command input was not clicked') { break }
        Start-Sleep -Milliseconds 1000
    }
    if ($attempts.Count -gt 1) { Observe "submit attempts for '$Text'" @{ attempts = $attempts } }
    $script:lastAttempts = $attempts
    return $s
}
function Carded([string]$Key, [string]$Text, [string]$CardFile, [string[]]$Need, [bool]$Approve, [string]$ResultPattern) {
    $s = Next-Request $Text
    if (-not $s -or -not $s.Ok) { return [pscustomobject]@{ ok = $false; outcome = $null; detail = @{ submit = $s.Record } } }
    $a = Wait-NewApproval $s.Marks 180000
    if ($a.Found) { Set-Content -Encoding utf8 (Join-Path $OutDir $CardFile) $a.Text }
    $missing = if ($a.Found) { @($Need | Where-Object { -not (Contains-Text $a.Text $_) }) } else { $Need }
    if (-not $a.Found -or $missing.Count) { return [pscustomobject]@{ ok = $false; outcome = $null; detail = @{ found = $a.Found; reason = $a.Reason; missing = $missing } } }
    $d = Decide $s.Marks $a $Approve
    $r = Wait-NewResult $s.Marks $ResultPattern
    return [pscustomobject]@{ ok = $d.ok -and $r.arrived; outcome = $r.outcome; matched = $r.matched; detail = @{ decision = $d.decision; result = @{ arrived = $r.arrived; outcome = $r.outcome; matched = $r.matched; text = ($r.text -split "`n" | Select-Object -First 12) -join ' | ' } } }
}
function Plain([string]$Text, [string]$ResultPattern) {
    $s = Next-Request $Text
    if (-not $s -or -not $s.Ok) { return [pscustomobject]@{ ok = $false; state = 'not-submitted'; outcome = $null; matched = $false; cards = 0; marks = $null; resultPart = ''; detail = @{ state = 'not-submitted'; submit = $s.Record; attempts = $script:lastAttempts } } }
    $r = Wait-NewResult $s.Marks $ResultPattern 240000
    $state = Get-RequestState $s.Record $r.arrived $r.outcome
    $cards = [regex]::Matches((Read-LogSince $script:hudLog $s.Marks.hud), 'Approval surface opened for').Count
    $script:reqNo++
    $part = Get-ResultPart ([string]$r.text)
    Set-Content -Encoding utf8 (Join-Path $OutDir ('hud-request-{0:D2}.txt' -f $script:reqNo)) ("REQUEST: $Text`r`nOUTCOME: $($r.outcome)`r`n--- HUD text ---`r`n$($r.text)")
    return [pscustomobject]@{ ok = $r.arrived; state = $state; outcome = $r.outcome; matched = $r.matched; cards = $cards; marks = $s.Marks; resultPart = $part; full = [string]$r.text; detail = @{ state = $state; attempts = $script:lastAttempts; outcome = $r.outcome; matched = $r.matched; cards = $cards; hudRequestFile = ('hud-request-{0:D2}.txt' -f $script:reqNo); resultText = (($part -split "`n" | Select-Object -First 14) -join ' | ') } }
}
function Read-Store { if (Test-Path $store) { @(ConvertFrom-WorkflowStore (Get-Content $store -Raw)) } else { @() } }
function Get-Wf([string]$Name) { Find-Workflow (Read-Store) $Name }
$script:Observations = New-Object System.Collections.ArrayList
function Observe([string]$Name, $Detail) { [void]$script:Observations.Add([pscustomobject]@{ name = $Name; utc = (Get-Utc); detail = $Detail }); Write-Host ("note  {0}  {1}" -f $Name, ($Detail | ConvertTo-Json -Compress -Depth 5)) }
$script:reqNo = 0
$script:lastAttempts = @()
function Raw-Field([string]$Name, [string]$Field) {   # an ISO instant from the raw store text (no PowerShell date coercion)
    $raw = Get-Content $store -Raw
    $m = [regex]::Match($raw, '"Name":"' + [regex]::Escape($Name) + '".*?"' + $Field + '":(null|"([^"]+)")')
    if ($m.Success -and $m.Groups[2].Success) { return [DateTimeOffset]::Parse($m.Groups[2].Value, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal) }
    return $null
}
function Start-Run([string]$Dir, [switch]$ReapStale) {
    # start-stack.ps1 refuses (throws) while ANY other D-ASK daemon/HUD runs: a left-over daemon would keep the pipe and serve this run with
    # the previous run's workflow store (run 20261112T171739). -ReapStale stops only stacks an acceptance launcher provably started.
    $startArgs = @{ OutDir = $Dir; Config = $Config; Root = $Root }; if ($ReapStale) { $startArgs.ReapStale = $true }
    & "$PSScriptRoot\start-stack.ps1" @startArgs | Out-Null
    $p = Get-Content "$Dir\pids.json" -Raw | ConvertFrom-Json
    $script:hudLog = Join-Path $Dir 'hud.log'; $script:daemonLog = Join-Path $Dir 'daemon.log'
    $script:hwnd = Get-HudHwnd $p.hud
    $hs = [Diagnostics.Stopwatch]::StartNew(); while (-not ((Get-Content $script:hudLog -Raw -ErrorAction SilentlyContinue) -match 'Handshake accepted') -and $hs.ElapsedMilliseconds -lt 40000) { Start-Sleep -Milliseconds 200 }
    $ok = ((Get-Content $script:hudLog -Raw -ErrorAction SilentlyContinue) -match 'Handshake accepted')
    # Isolation: the daemon this HUD talks to must be the one launched for THIS run (alive, owning the pipe, logging its own pid).
    $iso = Get-DaemonStartViolation ([bool](Get-Process -Id $p.daemon -ErrorAction SilentlyContinue)) (Get-Content $script:daemonLog -Raw -ErrorAction SilentlyContinue) ([int]$p.daemon)
    if ($iso) { Write-Host "isolation: $iso"; $ok = $false }
    if ($ok) { Enter-HudInteractive $script:hwnd }
    return [pscustomobject]@{ pids = $p; handshake = $ok; isolation = $iso }
}

$run1 = Join-Path $OutDir 'run1'; $run2 = Join-Path $OutDir 'run2'
$org = Join-Path $OutDir 'fixture\organize-me'; New-Item -ItemType Directory -Force $org | Out-Null
foreach ($fileName in 'report.pdf', 'notes.txt', 'photo.jpg', 'mystery.qqq') { Set-Content -Encoding ascii (Join-Path $org $fileName) "content of $fileName" }
$store = Join-Path $OutDir 'workflows.json'; $journal = Join-Path $OutDir 'file-undo'
$names = 'FileOrganize', 'FileOrganizeRoots__0', 'FileOrganizeJournalDir', 'Workflows', 'WorkflowStorePath'
function FlagsOff {
    $settings = Get-Content (Join-Path $Root 'src\DAsk.Daemon\appsettings.json') -Raw | ConvertFrom-Json
    $src = Get-Content (Join-Path $Root 'src\DAsk.Daemon\AgentHost\AgentHostManager.cs') -Raw
    $cfg = foreach ($f in 'FileOrganize', 'Workflows') { -not ($settings.AgentHost.PSObject.Properties.Name -contains $f) -or $settings.AgentHost.$f -eq $false }
    $code = foreach ($f in 'FileOrganize', 'Workflows') { $src -match "public bool $f \{ get; set; \} = false;" }
    [pscustomobject]@{ ok = (@($cfg) -notcontains $false) -and (@($code) -notcontains $false); appsettings = @($cfg); code = @($code) }
}
$step2 = "Organize the files in `"$org`" by type"
$due = $null; $dueDt = $null
try {
    $f0 = FlagsOff
    Record $N.flags $f0.ok $f0
    $env:DASK_AgentHost__FileOrganize = 'true'; $env:DASK_AgentHost__FileOrganizeRoots__0 = $org; $env:DASK_AgentHost__FileOrganizeJournalDir = $journal
    $env:DASK_AgentHost__Workflows = 'true'; $env:DASK_AgentHost__WorkflowStorePath = $store
    $s1run = Start-Run $run1 -ReapStale
    Record $N.setup $s1run.handshake @{ run1Pids = $s1run.pids; store = $store; organiseFolder = $org }
    try {
        $adm = Get-ModelMemoryAdmission $Root; $mp = Test-ModelMemoryPreflight $adm
        [pscustomobject]@{ utc = (Get-Utc); measurement = $adm; decision = $mp } | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 (Join-Path $OutDir 'memory-preflight.json')
        Record $N.pre $mp.ok @{ availableMB = $adm.availableMB; requiredMB = $adm.requiredMB }
        if (-not $mp.ok) { Abort $mp.reason }
    } catch { Record $N.pre $false @{ error = "$_" }; Abort "memory preflight failed: $_" }
    if (-not $s1run.handshake) { Abort 'no handshake in run 1' }

    # ---- Phase 1: create and schedule (run 1) ----
    if (-not $script:Aborted) {
        $r = Plain "Save a workflow called nightly: What is 2+3?; then $step2" 'Saved the workflow'
        $w = Get-Wf 'nightly'
        Record $N.s1 ($r.outcome -eq 'COMPLETED' -and $r.cards -eq 0 -and $w -and @($w.Steps).Count -eq 2 -and $w.Steps[0] -eq 'What is 2+3?' -and $w.Steps[1] -eq $step2) @{ result = $r.detail; steps = $(if ($w) { @($w.Steps) } else { $null }) }
        if (-not ($r.outcome -eq 'COMPLETED' -and $w)) { Abort 'nightly was not saved' }
    }
    if (-not $script:Aborted) {
        $r = Plain 'Save a workflow called dropme: What is 7+8?' 'Saved the workflow'
        $w = Get-Wf 'dropme'
        Record $N.s2 ($r.outcome -eq 'COMPLETED' -and $r.cards -eq 0 -and $w -and @($w.Steps).Count -eq 1) @{ result = $r.detail; steps = $(if ($w) { @($w.Steps) } else { $null }) }
        if (-not ($r.outcome -eq 'COMPLETED' -and $w)) { Abort 'dropme was not saved' }
    }
    if (-not $script:Aborted) {
        $dueDt = (Get-Date).AddMinutes($LeadMinutes); $due = $dueDt.ToString('HH:mm')
        $dueDt = [datetime]::ParseExact((Get-Date).ToString('yyyy-MM-dd') + ' ' + $due, 'yyyy-MM-dd HH:mm', [Globalization.CultureInfo]::InvariantCulture)
        if ($dueDt -lt (Get-Date)) { $dueDt = $dueDt.AddDays(1) }   # a midnight crossing: the daily schedule's first run is then tomorrow
        $r = Carded 's3' "Run the workflow nightly every day at $due" 'card-s3-nightly.txt' @('Run a saved workflow on a schedule', 'What is 2+3?', 'Organize the files in', $due) $true 'will run every day'
        $w = Get-Wf 'nightly'
        Record $N.s3 ($r -and $r.ok -and $r.outcome -eq 'COMPLETED' -and $w.Schedule -and $w.Schedule.Kind -eq 'daily' -and $w.Schedule.Time -eq $due -and $null -eq $w.Schedule.LastRunUtc) @{ due = $due; result = $(if ($r) { $r.detail } else { $null }); schedule = $w.Schedule }
        if (-not ($w.Schedule)) { Abort 'nightly was not scheduled' }
    }
    if (-not $script:Aborted) {
        $r = Carded 's4' "Run the workflow dropme every day at $due" 'card-s4-dropme.txt' @('Run a saved workflow on a schedule', 'What is 7+8?', $due) $true 'will run every day'
        $w = Get-Wf 'dropme'
        Record $N.s4 ($r -and $r.ok -and $r.outcome -eq 'COMPLETED' -and $w.Schedule -and $w.Schedule.Time -eq $due) @{ result = $(if ($r) { $r.detail } else { $null }); schedule = $w.Schedule }
    }
    if (-not $script:Aborted) {
        $r = Plain 'Unschedule the workflow dropme' 'no longer run on a schedule'
        $w = Get-Wf 'dropme'
        $dl = Read-LogSince $script:daemonLog $r.marks.daemon
        $reach = @([regex]::Matches($dl, 'Desktop call \S+ (workflows\.\w+)') | ForEach-Object { $_.Groups[1].Value })
        $fin = @([regex]::Matches($dl, 'task (t[0-9a-f]+) (accepted|finished: \w+ in \d+ ms)') | ForEach-Object { $_.Value })
        $s5ok = ($r.outcome -eq 'COMPLETED' -and $r.cards -eq 0 -and $w -and $null -eq $w.Schedule -and @($w.Steps).Count -eq 1)
        Record $N.s5 $s5ok @{ requestState = $r.state; firstAttempt = $r.detail; resultPart = $r.resultPart; daemonWorkflowCallsSinceRequest = $reach; hostLines = $fin; dropmeSchedule = $(if ($w) { $w.Schedule } else { 'workflow missing' }); at = (Get-Utc) }
        if (-not $s5ok) {
            # Diagnostic only (S5 stays failed): the identical request once more, so the rest of the run still tests the timed path and the
            # comparison with a request that works is on record. Both HUD texts are in OutDir (hud-request-NN.txt).
            $r2 = Plain 'Unschedule the workflow dropme' 'no longer run on a schedule'
            $w2 = Get-Wf 'dropme'
            $dl2 = Read-LogSince $script:daemonLog $r2.marks.daemon
            Observe 'S5 diagnostic: identical retry of the dropme unschedule request' @{ outcome = $r2.outcome; resultPart = $r2.resultPart; daemonWorkflowCalls = @([regex]::Matches($dl2, 'Desktop call \S+ (workflows\.\w+)') | ForEach-Object { $_.Groups[1].Value }); dropmeScheduleAfterRetry = $(if ($w2) { $w2.Schedule } else { 'workflow missing' }) }
        }
    }

    # ---- Restart (official launcher), same store ----
    $pre = $null
    if (-not $script:Aborted) {
        if ((Get-Date) -gt $dueDt.AddSeconds(-60)) { Abort "too close to the due time ($due) to restart safely; the run was too slow" }
    }
    if (-not $script:Aborted) {
        $pre = [pscustomobject]@{ hash = (Get-FileHash $store -Algorithm SHA256).Hash; text = (Get-Content $store -Raw); utc = (Get-Utc) }
        Copy-Item $store (Join-Path $OutDir 'workflows.before-restart.json')
        $oldPids = $s1run.pids
        $stop = & "$PSScriptRoot\stop-stack.ps1" -OutDir $run1
        $stop | Set-Content -Encoding utf8 (Join-Path $OutDir 'stop-run1.txt')
        $goneOld = -not (Get-Process -Id $oldPids.daemon -ErrorAction SilentlyContinue) -and -not (Get-Process -Id $oldPids.hud -ErrorAction SilentlyContinue)
        $s2run = Start-Run $run2
        $readyUtc = Get-Utc
        $post = if (Test-Path $store) { (Get-FileHash $store -Algorithm SHA256).Hash } else { $null }
        Copy-Item $store (Join-Path $OutDir 'workflows.after-restart.json') -ErrorAction SilentlyContinue
        $w = Get-Wf 'nightly'
        $freshPids = ($s2run.pids.daemon -ne $oldPids.daemon) -and ($s2run.pids.hud -ne $oldPids.hud)
        $beforeDue = (Get-Date) -lt $dueDt
        Record $N.r1 ($goneOld -and $freshPids -and $s2run.handshake -and $post -eq $pre.hash -and $w.Schedule -and $w.Schedule.Time -eq $due -and $beforeDue) @{
            oldPidsGone = $goneOld; newPids = $s2run.pids; handshake = $s2run.handshake; storeHashBefore = $pre.hash; storeHashAfter = $post
            nightlyScheduleAfterRestart = $w.Schedule; restartReadyBeforeDue = $beforeDue; readyUtc = $readyUtc; stop = $stop }
        if (-not ($s2run.handshake)) { Abort 'no handshake after restart' }
    }

    # ---- Phase 2: the due run (run 2) ----
    $marks = $null; $a = $null; $dec = $null; $res = $null
    if (-not $script:Aborted) {
        $waitMs = [int](($dueDt.AddSeconds(-30)) - (Get-Date)).TotalMilliseconds
        if ($waitMs -gt 0) { Start-Sleep -Milliseconds $waitMs }
        try { Restore-HudFront } catch { Write-Host "HUD front: $($_.Exception.Message)" }
        $marks = Mark-Logs
        $limit = [int](($dueDt.AddMinutes(4)) - (Get-Date)).TotalMilliseconds
        $a = Wait-NewApproval $marks ([math]::Max($limit, 60000))
        if ($a.Found) { Set-Content -Encoding utf8 (Join-Path $OutDir 'card-f2-timed-run.txt') $a.Text }
    }
    if ($a) {
        $nd = @(Get-DueRuns (Get-Content $script:daemonLog -Raw) 'nightly')
        $lag = if ($nd.Count -ge 1) { [int]($nd[0].loggedLocal - $dueDt).TotalSeconds } else { $null }
        $timedTaskId = if ($nd.Count -ge 1) { $nd[0].taskId } else { $null }
        Record $N.f1 ($nd.Count -eq 1 -and $nd[0].submitted -and $nd[0].dueLocal -eq $dueDt.ToString('yyyy-MM-dd HH:mm') -and $null -ne $lag -and $lag -ge 0 -and $lag -le 90) @{ dueRuns = @($nd | ForEach-Object { $_.line }); taskId = $timedTaskId; secondsAfterDue = $lag; dueLocal = $dueDt.ToString('o') }

        $cardOk = $false
        if ($a.Found) {
            $cardOk = (Contains-Text $a.Text 'Move files into subfolders') -and (Contains-Text $a.Text 'report.pdf') -and (Contains-Text $a.Text 'Documents')
            $dec = if ($cardOk) { try { Restore-HudFront } catch { }; Decide $marks $a $true } else { $null }
        }
        $cards = [regex]::Matches((Read-LogSince $script:hudLog $marks.hud), 'Approval surface opened for').Count
        Record $N.f2 ($a.Found -and $cardOk -and $dec -and $dec.ok -and $cards -eq 1) @{ cardFound = $a.Found; reason = $a.Reason; cardIsOrganise = $cardOk; cardsOpened = $cards; decision = $(if ($dec) { $dec.decision } else { $null }); click = $(if ($dec) { $dec.click } else { $null }) }
        if (-not ($a.Found -and $dec -and $dec.ok)) { Abort 'the timed run produced no usable approval' }
    }
    if (-not $script:Aborted) {
        # Completion is read from the agent host's own end-of-task line (daemon log) for the timed task id.
        $fin = $null; $sw3 = [Diagnostics.Stopwatch]::StartNew()
        while (-not $fin -and $sw3.Elapsed.TotalSeconds -lt 120 -and $timedTaskId) { $fin = Get-HostFinish (Get-Content $script:daemonLog -Raw) $timedTaskId; if (-not $fin) { Start-Sleep -Milliseconds 500 } }
        $moved = (Test-Path "$org\Documents\report.pdf") -and (Test-Path "$org\Documents\notes.txt") -and (Test-Path "$org\Images\photo.jpg") -and (Test-Path "$org\mystery.qqq") -and -not (Test-Path "$org\report.pdf")
        $performed = (Get-Content $script:daemonLog -Raw) -match ('files\.organize for task ' + [regex]::Escape([string]$timedTaskId) + ': 3/3 moved, verified=True')
        Record $N.f3 ($fin -and $fin.outcome -eq 'completed' -and $moved -and $performed) @{ taskId = $timedTaskId; hostFinish = $fin; organiseLoggedVerified = $performed; filesMoved = $moved
            files = @(Get-ChildItem $org -Recurse -File | ForEach-Object { $_.FullName.Substring($org.Length + 1) }) }
        # What the HUD itself showed for the timed run: recorded, NOT scored. The HUD only presents tasks it submitted (hooks/nativeAgent.ts #onTaskMessage).
        $hudText = ''; $hudOutcome = $null; $sw4 = [Diagnostics.Stopwatch]::StartNew()
        while ($sw4.Elapsed.TotalSeconds -lt 30) { $hudText = Safe-HudText; $hudOutcome = Get-OutcomeFromText $hudText; if ($hudOutcome) { break }; Start-Sleep -Milliseconds 500 }
        Set-Content -Encoding utf8 (Join-Path $OutDir 'hud-after-timed-run.txt') $hudText
        $resultNotice = [regex]::Matches((Read-LogSince $script:hudLog $marks.hud), 'AgentTaskResultNotification').Count
        Observe 'F3b HUD presentation of the timed run (not scored)' @{ resultPanelObserved = [bool]$hudOutcome; hudOutcome = $hudOutcome; resultPart = (Get-ResultPart $hudText); agentTaskResultNotificationsReceivedByHud = $resultNotice; file = 'hud-after-timed-run.txt'
            note = 'the HUD ignores task messages for tasks it did not submit (hooks/nativeAgent.ts:237-238); a result panel for a timed run is therefore not expected and is not claimed' }
        Start-Sleep -Seconds 2
        $w = Get-Wf 'nightly'; $d = Get-Wf 'dropme'
        $last = Raw-Field 'nightly' 'LastRunUtc'
        $note = [string]$w.Schedule.LastNote
        $delta = if ($last) { [int]([math]::Abs(($last.UtcDateTime.ToLocalTime() - $dueDt).TotalSeconds)) } else { $null }
        Record $N.f4 ($last -and $delta -le 90 -and (Test-SubmittedNote $note) -and $note -eq "submitted as task $timedTaskId" -and $d -and -not $d.Schedule.LastNote) @{ lastRunUtc = "$last"; secondsFromDue = $delta; lastNote = $note; expectedNote = "submitted as task $timedTaskId"; dropmeSchedule = $d.Schedule }
    }
    # ---- Live unscheduling after the run ----
    if (-not $script:Aborted) {
        $r = Plain 'Unschedule the workflow nightly' 'no longer run on a schedule'
        $w = Get-Wf 'nightly'
        $verdict = Get-ScheduleRemovalVerdict $w 2    # the store, read independently of the HUD
        Record $N.u1 ($r.state -eq 'completed' -and $r.cards -eq 0 -and $verdict.ok) @{ requestState = $r.state; storeWorkflowRetained = $verdict.workflowRetained; storeScheduleRemoved = $verdict.scheduleRemoved
            result = $r.detail; nightlySchedule = $(if ($w) { $w.Schedule } else { 'workflow missing' }); nightlySteps = $(if ($w) { @($w.Steps) } else { $null }) }
    }
    if (-not $script:Aborted) {
        Start-Sleep -Seconds 45   # two more scheduler ticks: nothing else may fire
        $dueNightly = @(); $dueDrop = @()
        foreach ($lg in (Join-Path $run1 'daemon.log'), (Join-Path $run2 'daemon.log')) { $t = Get-Content $lg -Raw; $dueNightly += @(Get-DueRuns $t 'nightly'); $dueDrop += @(Get-DueRuns $t 'dropme') }
        Record $N.c1 ($dueDrop.Count -eq 0 -and $dueNightly.Count -eq 1) @{ nightlyDueLines = @($dueNightly | ForEach-Object { $_.line }); dropmeDueLines = @($dueDrop | ForEach-Object { $_.line }) }
    }
} catch {
    Record 'unexpected error' $false @{ error = "$($_.Exception.Message)" }
    Abort "unexpected error: $($_.Exception.Message)"
} finally {
    try {
        $errs = @()
        foreach ($lg in (Join-Path $run1 'daemon.log'), (Join-Path $run2 'daemon.log')) { if (Test-Path $lg) { $errs += @(Select-String -Path $lg -Pattern '\[(FileOrganize|Workflows)\].*(fail|error|exception)' -ErrorAction SilentlyContinue | ForEach-Object { $_.Line }) } }
        Record $N.log ($errs.Count -eq 0) @{ lines = $errs }
    } catch { Record $N.log $false @{ error = "$_" } }
    foreach ($d in $run1, $run2) { try { if (Test-Path "$d\pids.json") { & "$PSScriptRoot\stop-stack.ps1" -OutDir $d | Out-Null } } catch { } }
    foreach ($v in $names) { Remove-Item "Env:\DASK_AgentHost__$v" -ErrorAction SilentlyContinue }
    $f1 = FlagsOff
    Record $N.end ($f1.ok -and -not (Test-Path (Join-Path $env:LOCALAPPDATA 'D-ASK\workflows.json.tmp'))) @{ flagsOff = $f1.ok; stores = @($store, $journal) }
    foreach ($k in $N.Keys) { if (-not ($script:results | Where-Object { $_.name -eq $N[$k] })) { Record $N[$k] $false @{ notRun = "not reached: $($script:AbortReason)" } } }
    $checks = @($script:results.ToArray() | Where-Object { $_.name -ne 'unexpected error' })
    $passed = @($checks | Where-Object { $_.pass -eq $true }).Count
    $failed = @($script:results.ToArray() | Where-Object { $_.pass -ne $true }).Count
    $summary = [ordered]@{ expectedTotal = $script:ExpectedChecks; total = $checks.Count; passed = $passed; failed = $failed; aborted = $script:Aborted; abortReason = $script:AbortReason }
    ConvertTo-Json -InputObject @($script:results.ToArray()) -Depth 8 | Set-Content -Encoding utf8 (Join-Path $OutDir 'approval-live.json')
    ConvertTo-Json -InputObject ([pscustomobject]$summary) -Depth 6 | Set-Content -Encoding utf8 (Join-Path $OutDir 'approval-live-summary.json')
    ConvertTo-Json -InputObject @($script:Observations.ToArray()) -Depth 8 | Set-Content -Encoding utf8 (Join-Path $OutDir 'observations.json')
    Write-Host "`n$passed / $($checks.Count) checks passed (expected $($script:ExpectedChecks)); failed $failed; aborted: $($script:Aborted)$(if ($script:AbortReason) { " ($($script:AbortReason))" })"
    Write-Host "Results: $OutDir"
    if ($passed -ne $script:ExpectedChecks -or $script:Aborted) { exit 1 }
}
