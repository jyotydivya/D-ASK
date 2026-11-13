# Real-HUD CROSS-FEATURE acceptance: capabilities cooperating through ONE assistant (same runtime, approvals, Emergency Stop, evidence).
#   X1 knowledge indexing (prerequisite)
#   X2 knowledge -> note    "According to my research papers, ...? Then save the answer as a note called Deadline answer" (note card shows the answer)
#   X3 conversation -> memory "Remember that" (the previous answer), then a memory recall question
#   X4 knowledge + notes in a WORKFLOW, run by the SCHEDULER: step 2 "save that as a note called ..." uses step 1's answer; the timed run asks for
#      its own note approval
#   X5 Windows control: "Open Calculator" (approval card, a NEW Calculator window confirmed); the window is closed afterwards
#   X6 Emergency Stop during a research task, RESUME, then a task works again
# Every store is isolated inside -OutDir (knowledge, research, memory, notes, workflows). The user's real stores are hashed before/after.
#   powershell -ExecutionPolicy Bypass -File scripts\hud\approval-live-integration.ps1 -OutDir results\integration-hud\live-<stamp> -Papers <folder with PDFs>
param([Parameter(Mandatory = $true)][string]$OutDir, [Parameter(Mandatory = $true)][string]$Papers, [string]$Root, [string]$Config = 'Debug', [int]$LeadMinutes = 3)
$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = (Resolve-Path "$PSScriptRoot\..\..").Path }
if ((Test-Path $OutDir) -and @(Get-ChildItem $OutDir -Force).Count -gt 0) { throw "OutDir must be new or empty: $OutDir" }
New-Item -ItemType Directory -Force $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path
$keepOut = $OutDir; $keepRoot = $Root; $keepConfig = $Config; $keepPapers = (Resolve-Path $Papers).Path; $keepLead = $LeadMinutes
. "$PSScriptRoot\approval-live-7b3.ps1" -OutDir $keepOut -Root $keepRoot -Config $keepConfig -LoadFunctionsOnly
$OutDir = $keepOut; $Root = $keepRoot; $Config = $keepConfig; $Papers = $keepPapers; $LeadMinutes = $keepLead
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
Add-Type @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class XWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static List<long> Titled(string t) { var r = new List<long>(); EnumWindows((h, l) => { if (IsWindowVisible(h)) { var s = new StringBuilder(256); GetWindowText(h, s, 256); if (s.ToString() == t) r.Add((long)h); } return true; }, IntPtr.Zero); return r; }
}
"@

$script:ExpectedChecks = 12
$N = [ordered]@{
    setup = 'Z1 setup: real HUD + daemon with notes, memory, workflows, app launch and knowledge; every store isolated inside OutDir'
    pre   = 'Z2 memory preflight: the local model would be admitted with the HUD running (guard unchanged)'
    x1 = 'X1 knowledge: the library is indexed (COMPLETED, verified)'
    x2 = 'X2 knowledge -> note: the note card shows the ANSWER; approved; the note file holds the answer and its source (independent read)'
    x3 = 'X3 conversation -> memory: "Remember that" stores the previous answer (independent DB read); a later question recalls it'
    x4a = 'X4a workflow saved with a knowledge step and a "save that as a note" step; scheduled through its approval card'
    x4b = 'X4b the SCHEDULER fired the workflow: its note step asked for its own approval, showing step 1''s answer; the note file holds it; the HUD shows the scheduled run'
    x5 = 'X5 "Open Calculator": approval card names Calculator (calc.exe); approved; a NEW Calculator window was confirmed; it was then closed'
    x6 = 'X6 Emergency Stop during a research task: stop confirmed in daemon + HUD logs; the task ends CANCELLED; RESUME confirmed; the next task COMPLETES'
    log = 'L1 no knowledge/notes/memory/workflow errors in the daemon logs'
    same = 'L2 one assistant: every request went through the same daemon and agent host process (pids unchanged during the run)'
    end = 'Z3 end state: the user''s real knowledge.db, memory.db, workflows.json, notes folder and research folder are unchanged'
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
    Restore-HudFront
    $click = Invoke-GuardedClick -Label $(if ($Approve) { 'APPROVE' } else { 'DENY' }) -ButtonPattern $(if ($Approve) { '^APPROVE$' } else { '^DENY$' }) -WaitEnabled
    if (-not $click.sent) { return [pscustomobject]@{ ok = $false; click = $click; decision = $null } }
    $d = Confirm-Decision $Marks $A.Id $Approve $click
    return [pscustomobject]@{ ok = ($d.evidence.state -eq 'confirmed'); click = $click; decision = $d }
}
function Next-Request([string]$Text) {
    if ((Wait-PanelClosed) -lt 0) { Abort 'the previous approval panel did not close'; return $null }
    Restore-HudFront
    return Invoke-Request $Text
}
function Plain([string]$Text, [string]$ResultPattern, [int]$TimeoutMs = 300000) {
    $s = Next-Request $Text
    if (-not $s -or -not $s.Ok) { return [pscustomobject]@{ ok = $false; outcome = $null; matched = $false; cards = 0; full = ''; detail = @{ submit = $(if ($s) { $s.Record } else { $null }) } } }
    $r = Wait-NewResult $s.Marks $ResultPattern $TimeoutMs 20000
    $cards = [regex]::Matches((Read-LogSince $script:hudLog $s.Marks.hud), 'Approval surface opened for').Count
    return [pscustomobject]@{ ok = $r.arrived; outcome = $r.outcome; matched = $r.matched; cards = $cards; full = [string]$r.text; detail = @{ outcome = $r.outcome; matched = $r.matched; cards = $cards; msToArrive = $r.msToArrive } }
}
function Carded([string]$Text, [string]$CardFile, [string[]]$Need, [string]$ResultPattern) {
    $s = Next-Request $Text
    if (-not $s -or -not $s.Ok) { return [pscustomobject]@{ ok = $false; full = ''; detail = @{ submit = $(if ($s) { $s.Record } else { $null }) } } }
    $a = Wait-NewApproval $s.Marks 300000
    if ($a.Found) { Save $CardFile $a.Text }
    $missing = if ($a.Found) { @($Need | Where-Object { -not (Contains-Text $a.Text $_) }) } else { $Need }
    if (-not $a.Found -or $missing.Count) { return [pscustomobject]@{ ok = $false; full = ''; detail = @{ found = $a.Found; reason = $a.Reason; missing = $missing } } }
    $d = Decide $s.Marks $a $true
    $r = Wait-NewResult $s.Marks $ResultPattern 240000 20000
    return [pscustomobject]@{ ok = $d.ok -and $r.arrived; outcome = $r.outcome; matched = $r.matched; full = [string]$r.text; card = $a.Text; detail = @{ decision = $d.ok; outcome = $r.outcome; matched = $r.matched } }
}
function Sha([string]$Path) { if (Test-Path -LiteralPath $Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLower() } else { $null } }
function DirState([string]$Path) { if (Test-Path -LiteralPath $Path) { @(Get-ChildItem -LiteralPath $Path -Recurse -File | ForEach-Object { "$($_.FullName)|$($_.Length)|$($_.LastWriteTimeUtc.Ticks)" }) -join "`n" } else { '<absent>' } }
function Save([string]$Name, [string]$Text) { Set-Content -Encoding utf8 (Join-Path $OutDir $Name) $Text }
function Mem-List { $env:DASK_MEMORY_DB = $memDb; try { Push-Location $Root; @(& npx tsx agent/runtime/memory/memoryCli.ts list 2>&1 | ForEach-Object { "$_" } | Where-Object { $_ -match '\[' }) } finally { Pop-Location; Remove-Item Env:\DASK_MEMORY_DB -ErrorAction SilentlyContinue } }
function Host-Pid { @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'stdioHost' -and $_.ParentProcessId -eq $script:pids.daemon } | ForEach-Object { $_.ProcessId }) }

# ---- the run's own world ----
$lib = Join-Path $OutDir 'library'; New-Item -ItemType Directory -Force $lib | Out-Null
Copy-Item (Join-Path $Papers '*.pdf') $lib
Set-Content -Encoding utf8 (Join-Path $lib 'project-notes.md') "# Project notes`n`n## Schedule`n`nThe D-ASK evaluation deadline is 16 November 2026, and the viva is held in room B-214.`n"
$kDb = Join-Path $OutDir 'knowledge.db'; $research = Join-Path $OutDir 'research'; $memDb = Join-Path $OutDir 'memory.db'
$notes = Join-Path $OutDir 'notes'; New-Item -ItemType Directory -Force $notes | Out-Null
$store = Join-Path $OutDir 'workflows.json'
$real = [ordered]@{
    knowledge = Join-Path $env:LOCALAPPDATA 'D-ASK\knowledge.db'; memory = Join-Path $env:LOCALAPPDATA 'D-ASK\memory.db'; workflows = Join-Path $env:LOCALAPPDATA 'D-ASK\workflows.json'
}
$realDirs = [ordered]@{ research = Join-Path $env:USERPROFILE 'Documents\D-ASK\Research'; notes = Join-Path $env:USERPROFILE 'Documents\D-ASK Notes' }
$before = @{}; foreach ($k in $real.Keys) { $before[$k] = Sha $real[$k] }; foreach ($k in $realDirs.Keys) { $before[$k] = DirState $realDirs[$k] }
$envs = [ordered]@{
    Notes = 'true'; NotesDir = $notes; Memory = 'true'; Workflows = 'true'; WorkflowStorePath = $store; DesktopAppLaunch = 'true'
    ExtraEnvironment__DASK_MEMORY_DB = $memDb; ExtraEnvironment__DASK_KNOWLEDGE_DB = $kDb; ExtraEnvironment__DASK_RESEARCH_DIR = $research; ExtraEnvironment__DASK_KNOWLEDGE_ROOTS = $lib
}
$run = $null
try {
    foreach ($k in $envs.Keys) { Set-Item "Env:\DASK_AgentHost__$k" $envs[$k] }
    $dir = Join-Path $OutDir 'run'
    $script:hudLog = Join-Path $dir 'hud.log'; $script:daemonLog = Join-Path $dir 'daemon.log'
    & "$PSScriptRoot\start-stack.ps1" -OutDir $dir -Config $Config -Root $Root | Out-Null
    $script:pids = Get-Content "$dir\pids.json" -Raw | ConvertFrom-Json
    $script:hwnd = Get-HudHwnd $script:pids.hud
    $hs = [Diagnostics.Stopwatch]::StartNew(); while (-not ((Get-Content $script:hudLog -Raw -ErrorAction SilentlyContinue) -match 'Handshake accepted') -and $hs.ElapsedMilliseconds -lt 40000) { Start-Sleep -Milliseconds 200 }
    Enter-HudInteractive $script:hwnd
    $hostPids0 = $null
    Record $N.setup ((Get-Content $script:hudLog -Raw) -match 'Handshake accepted') @{ pids = $script:pids; stores = @{ knowledge = $kDb; memory = $memDb; notes = $notes; workflows = $store } }
    try {
        $adm = Get-ModelMemoryAdmission $Root; $mp = Test-ModelMemoryPreflight $adm
        Record $N.pre $mp.ok @{ availableMB = $adm.availableMB; requiredMB = $adm.requiredMB }
        if (-not $mp.ok) { Abort $mp.reason }
    } catch { Record $N.pre $false @{ error = "$_" }; Abort "memory preflight failed: $_" }

    if (-not $script:Aborted) {
        $r = Plain "Index `"$lib`" as research" 'Indexing finished'
        Save 'hud-x1.txt' $r.full
        $hostPids0 = @(Host-Pid)
        Record $N.x1 ($r.ok -and $r.outcome -eq 'COMPLETED' -and $r.full -match 'INDEPENDENTLY VERIFIED') $r.detail

        # X2 knowledge -> note
        $r = Carded 'According to my research papers, when is the D-ASK evaluation deadline? Then save the answer as a note called Deadline answer' 'card-x2.txt' @('Create a new note', 'Deadline answer.txt', '16 November') 'Saved the result'
        Save 'hud-x2.txt' $r.full
        $nf = Join-Path $notes 'Deadline answer.txt'
        $nt = if (Test-Path $nf) { Get-Content $nf -Raw } else { '' }
        Record $N.x2 ($r.ok -and $r.matched -and $nt -match '16 November' -and $nt -match 'project-notes\.md') ($r.detail + @{ noteFile = (Test-Path $nf); noteText = $nt })

        # X3 conversation -> memory, then recall
        $r = Plain 'Remember that' 'Saved the result'
        Save 'hud-x3a.txt' $r.full
        $ml = @(Mem-List)
        $r2 = Plain 'What do you remember about the D-ASK evaluation deadline?' '16 November'
        Save 'hud-x3b.txt' $r2.full
        Record $N.x3 ($r.ok -and $r.outcome -eq 'COMPLETED' -and @($ml | Where-Object { $_ -match '16 November' }).Count -eq 1 -and $r2.ok -and $r2.matched) @{ remember = $r.detail; memory = $ml; recall = $r2.detail }

        # X4 workflow (knowledge + note) run by the scheduler
        $r = Plain 'Save a workflow called "paper digest": According to my research papers, how does GraphSAGE aggregate features from a node''s neighbours?; then save that as a note called GraphSAGE digest' 'Saved the workflow'
        Save 'hud-x4-save.txt' $r.full
        $due = (Get-Date).AddMinutes($LeadMinutes).ToString('HH:mm')
        $rs = Carded "Run the workflow `"paper digest`" every day at $due" 'card-x4-schedule.txt' @('Run a saved workflow on a schedule', 'save that as a note called GraphSAGE digest', $due) 'will run every day'
        $wf = if (Test-Path $store) { Get-Content $store -Raw } else { '' }
        Record $N.x4a ($r.ok -and $r.outcome -eq 'COMPLETED' -and $rs.ok -and $wf -match 'paper digest' -and $wf -match [regex]::Escape($due)) @{ save = $r.detail; schedule = $rs.detail; due = $due }
        if ($rs.ok) {
            $m = Mark-Logs
            $a = Wait-NewApproval $m (($LeadMinutes + 3) * 60000)
            if ($a.Found) { Save 'card-x4-timed-note.txt' $a.Text }
            $cardOk = $a.Found -and (Contains-Text $a.Text 'GraphSAGE digest.txt') -and (Contains-Text $a.Text 'aggregat')
            $d = if ($a.Found) { Decide $m $a $true } else { $null }
            $gf = Join-Path $notes 'GraphSAGE digest.txt'
            $sw = [Diagnostics.Stopwatch]::StartNew(); while (-not (Test-Path $gf) -and $sw.ElapsedMilliseconds -lt 60000) { Start-Sleep -Milliseconds 300 }
            $sched = Wait-HudText $script:hwnd 'SCHEDULED RUN' 90000
            Save 'hud-x4-scheduled.txt' $sched.Text
            $gt = if (Test-Path $gf) { Get-Content $gf -Raw } else { '' }
            Record $N.x4b ($cardOk -and $d -and $d.ok -and $gt -match 'aggregat' -and $gt -match 'Sources:' -and $sched.Found) @{ card = $cardOk; decision = $(if ($d) { $d.ok } else { $null }); noteText = $gt; scheduledShown = $sched.Found }
        } else { Record $N.x4b $false @{ notRun = 'the schedule was not set' } }

        # X5 Calculator
        $calcBefore = @([XWin]::Titled('Calculator'))
        $r = Carded 'Open Calculator' 'card-x5.txt' @('Open Calculator', 'calc.exe', 'none') ''
        Save 'hud-x5.txt' $r.full
        Start-Sleep -Milliseconds 800
        $calcNew = @([XWin]::Titled('Calculator') | Where-Object { $calcBefore -notcontains $_ })
        foreach ($h in $calcNew) { [void][XWin]::PostMessage([IntPtr]$h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }
        Record $N.x5 ($r.ok -and $r.outcome -eq 'COMPLETED' -and $r.full -match 'INDEPENDENTLY VERIFIED' -and $calcNew.Count -eq 1) ($r.detail + @{ newCalculatorWindows = $calcNew.Count })

        # X6 Emergency Stop during research, then RESUME
        Start-Sleep -Seconds 2
        $s = Next-Request 'Prepare a literature review about graph attention networks from my research papers'
        if ($s -and $s.Ok) {
            Start-Sleep -Milliseconds 1500
            Restore-HudFront
            $click = Invoke-GuardedClick -Label 'STOP' -ButtonPattern 'STOP \[Ctrl\+Shift\+F12\]$'
            $stopD = Wait-Log 'daemon' $s.Marks '\[EMERGENCY STOP\] Triggered'
            $res = Wait-NewResult $s.Marks $null 120000 20000
            Save 'hud-x6-stop.txt' $res.text
            $m6 = Mark-Logs
            Restore-HudFront
            $rc = Invoke-GuardedClick -Label 'RESUME' -ButtonPattern '(^|\s)RESUME$' -WaitEnabled
            $resumed = Wait-Log 'daemon' $m6 '\[RESUME\] Execution resumed'
            Start-Sleep -Seconds 2
            $after = Plain 'List my knowledge collections.' 'research \[research\]'
            Record $N.x6 ($click.sent -and $stopD.Found -and $res.outcome -eq 'CANCELLED' -and $rc.sent -and $resumed.Found -and $after.outcome -eq 'COMPLETED') @{ stopClick = $click.sent; stopLogged = $stopD.Found; outcome = $res.outcome; resumeClick = $rc.sent; resumed = $resumed.Found; after = $after.detail }
        } else { Record $N.x6 $false @{ submit = $(if ($s) { $s.Record } else { $null }) } }
    }
} catch {
    Record 'unexpected error' $false @{ error = "$($_.Exception.Message)" }
    Abort "unexpected error: $($_.Exception.Message)"
} finally {
    try {
        $errs = @(Select-String -Path $script:daemonLog -Pattern '(?i)knowledge (unavailable|task failed)|\[(Notes|Memory|Workflow)\w*\].*(fail|exception)|unhandled' -ErrorAction SilentlyContinue | ForEach-Object { $_.Line })
        Record $N.log ($errs.Count -eq 0) @{ errorLines = $errs }
    } catch { Record $N.log $false @{ error = "$_" } }
    try {
        $hostNow = @(Host-Pid)
        Record $N.same ($hostPids0 -and $hostPids0.Count -eq 1 -and $hostNow.Count -eq 1 -and $hostNow[0] -eq $hostPids0[0] -and (Get-Process -Id $script:pids.daemon -ErrorAction SilentlyContinue)) @{ hostAtStart = $hostPids0; hostAtEnd = $hostNow; daemon = $script:pids.daemon }
    } catch { Record $N.same $false @{ error = "$_" } }
    try { if ($script:pids -and (Get-Process -Id $script:pids.daemon -ErrorAction SilentlyContinue)) { & "$PSScriptRoot\stop-stack.ps1" -OutDir (Join-Path $OutDir 'run') | Out-Null } } catch { }
    foreach ($k in $envs.Keys) { Remove-Item "Env:\DASK_AgentHost__$k" -ErrorAction SilentlyContinue }
    $diff = @(); foreach ($k in $real.Keys) { if ((Sha $real[$k]) -ne $before[$k]) { $diff += $k } }; foreach ($k in $realDirs.Keys) { if ((DirState $realDirs[$k]) -ne $before[$k]) { $diff += $k } }
    Record $N.end ($diff.Count -eq 0) @{ changed = $diff }
    foreach ($k in $N.Keys) { if (-not ($script:results | Where-Object { $_.name -eq $N[$k] })) { Record $N[$k] $false @{ notRun = "not reached: $($script:AbortReason)" } } }
    $checks = @($script:results.ToArray() | Where-Object { $_.name -ne 'unexpected error' })
    $passed = @($checks | Where-Object { $_.pass -eq $true }).Count
    $failed = @($script:results.ToArray() | Where-Object { $_.pass -ne $true }).Count
    ConvertTo-Json -InputObject @($script:results.ToArray()) -Depth 8 | Set-Content -Encoding utf8 (Join-Path $OutDir 'approval-live.json')
    ConvertTo-Json -InputObject ([pscustomobject]([ordered]@{ expectedTotal = $script:ExpectedChecks; total = $checks.Count; passed = $passed; failed = $failed; aborted = $script:Aborted; abortReason = $script:AbortReason })) | Set-Content -Encoding utf8 (Join-Path $OutDir 'approval-live-summary.json')
    Write-Host "`n$passed / $($checks.Count) checks passed (expected $($script:ExpectedChecks)); failed $failed; aborted: $($script:Aborted)$(if ($script:AbortReason) { " ($($script:AbortReason))" })"
    Write-Host "Results: $OutDir"
    if ($passed -ne $script:ExpectedChecks -or $script:Aborted) { exit 1 }
}
