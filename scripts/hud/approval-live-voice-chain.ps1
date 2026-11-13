# Real-HUD acceptance of VOICE-INITIATED, MULTI-STEP and CHAINED requests. A PERSON speaks into the real microphone three times; this script never types
# a spoken request or injects audio. (Setup only: the test library is indexed with one typed request BEFORE the voice gate is enforced.)
#   S1 "What is seven times eight?"                                              -> COMPLETED, INDEPENDENTLY VERIFIED, 56, spoken back
#   S2 "According to my research papers, when is the D-ASK evaluation deadline? Then remember it."
#                                                                                 -> the knowledge answer is found AND passed to local memory (isolated DB), spoken back
#   S3 "What do you remember about the evaluation deadline?"                     -> recalled from memory (16 November), spoken back
#
# INTERACTIVE, step by step (voice-step-gate.ps1; repair of results/offline-voice-chain/20261113T214254, where the prompts were never shown and
# unrelated speech became the three tasks): a visible top-most window shows the exact sentence; the person clicks "I'm ready"; the harness
# arms the HUD microphone and waits for ARMED; "SPEAK NOW"; the HUD's acceptance voice gate (DASK_VOICE_GATE_DIR, src/hud-native/src/voice_gate.rs)
# holds the fresh local-Whisper transcript; a mismatch is rejected (nothing is submitted) and may be retried; only the matching transcript is
# released, and once enforced the HUD forwards ONLY that exact text to the daemon. The step's task is then awaited and verified independently,
# and the next step starts only if this one passed.
# Run online, or Wi-Fi off through: run-offline-acceptance-7b3.ps1 -AcceptanceScript offline-voice-chain-acceptance.ps1 (with DASK_ACCEPT_PAPERS set).
#   powershell -ExecutionPolicy Bypass -File scripts\hud\approval-live-voice-chain.ps1 -OutDir results\voice-hud\chain-<stamp> -Papers <folder with PDFs>
param([Parameter(Mandatory = $true)][string]$OutDir, [Parameter(Mandatory = $true)][string]$Papers, [string]$Root, [string]$Config = 'Debug',
    [int]$SpeakTimeoutSec = 90, [int]$MaxAttempts = 5)
$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = (Resolve-Path "$PSScriptRoot\..\..").Path }
if ((Test-Path $OutDir) -and @(Get-ChildItem $OutDir -Force).Count -gt 0) { throw "OutDir must be new or empty: $OutDir" }
. "$PSScriptRoot\voice-step-gate.ps1"
# A prompt that nobody can see is not a prompt: refuse before anything starts if no window can be shown to a person.
if (-not (Test-CanShowWindows)) { Write-Host 'No interactive desktop: the prompts cannot be shown to a person. Nothing was run.' -ForegroundColor Red; exit 3 }
New-Item -ItemType Directory -Force $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path
$keepOut = $OutDir; $keepRoot = $Root; $keepConfig = $Config; $keepPapers = (Resolve-Path $Papers).Path; $keepT = $SpeakTimeoutSec; $keepMax = $MaxAttempts
. "$PSScriptRoot\approval-live-7b3.ps1" -OutDir $keepOut -Root $keepRoot -Config $keepConfig -LoadFunctionsOnly
$OutDir = $keepOut; $Root = $keepRoot; $Config = $keepConfig; $Papers = $keepPapers; $SpeakTimeoutSec = $keepT; $MaxAttempts = $keepMax
$ErrorActionPreference = 'Stop'
$p0Lines = Get-Content "$PSScriptRoot\approval-live-7b3.ps1"
$from = [Array]::FindIndex($p0Lines, [Predicate[string]] { param($l) $l -eq 'if ($LoadFunctionsOnly) { return }' })
$to = [Array]::FindIndex($p0Lines, $from + 1, [Predicate[string]] { param($l) $l -match '^\S' -and $l -notmatch '^(function |\}|#|\$script:procNames = @\{\})' })
if ($from -lt 0 -or $to -le $from + 1) { throw 'the P0 harness layout changed; refusing to run' }
. ([scriptblock]::Create(($p0Lines[($from + 1)..($to - 1)] -join "`r`n")))
. "$PSScriptRoot\voice-step-gate.ps1"   # again: the P0 block must not shadow the step functions
Initialize-VoiceUi

$Steps = [ordered]@{
    s1 = 'What is seven times eight?'
    s2 = 'According to my research papers, when is the D-ASK evaluation deadline? Then remember it.'
    s3 = 'What do you remember about the evaluation deadline?'
}
$N = [ordered]@{
    setup = 'Z1 setup: real HUD + daemon; memory and knowledge isolated inside OutDir; the test library indexed (typed setup request, before the voice gate is enforced)'
    pre   = 'Z2 memory preflight (guard unchanged)'
    s1 = "S1 spoken `"$($Steps.s1)`": prompt shown + acknowledged, fresh local transcript MATCHED, exactly it submitted, task COMPLETED + INDEPENDENTLY VERIFIED with 56, answer spoken"
    s2 = "S2 spoken `"$($Steps.s2)`": prompt shown + acknowledged, fresh local transcript MATCHED, exactly it submitted, knowledge answer passed to memory (16 November in the isolated memory DB), spoken"
    s3 = "S3 spoken `"$($Steps.s3)`": prompt shown + acknowledged, fresh local transcript MATCHED, exactly it submitted, recalled from memory (16 November), spoken"
    local = 'Z3 every released transcript came from a LOCAL recognizer (whisper-local or sapi-local)'
    gate  = 'Z4 nothing unvalidated reached the daemon: after setup, every daemon task is a released step transcript (one per step), no other submission was forwarded'
}
$script:ExpectedChecks = $N.Count
$script:hudLog = Join-Path $OutDir 'hud.log'; $script:daemonLog = Join-Path $OutDir 'daemon.log'
$sttDir = Join-Path $OutDir 'stt'; New-Item -ItemType Directory -Force $sttDir | Out-Null
$gateDir = Join-Path $OutDir 'voice-gate'; New-Item -ItemType Directory -Force $gateDir | Out-Null
$stepLog = Join-Path $OutDir 'voice-steps.log'
$lib = Join-Path $OutDir 'library'; New-Item -ItemType Directory -Force $lib | Out-Null
Copy-Item (Join-Path $Papers '*.pdf') $lib
Set-Content -Encoding utf8 (Join-Path $lib 'project-notes.md') "# Project notes`n`n## Schedule`n`nThe D-ASK evaluation deadline is 16 November 2026.`n"
$memDb = Join-Path $OutDir 'memory.db'
$taskResults = Join-Path $OutDir 'task-results.json'
$envs = [ordered]@{ Memory = 'true'; ExtraEnvironment__DASK_MEMORY_DB = $memDb; ExtraEnvironment__DASK_KNOWLEDGE_DB = (Join-Path $OutDir 'knowledge.db'); ExtraEnvironment__DASK_KNOWLEDGE_ROOTS = $lib; TaskResultsPath = $taskResults }
function Mem-Has([string]$Needle) { foreach ($f in @($memDb, "$memDb-wal")) { if (Test-Path -LiteralPath $f) { $fs = [IO.File]::Open($f, 'Open', 'Read', 'ReadWrite'); try { $ms = New-Object IO.MemoryStream; $fs.CopyTo($ms); if ([Text.Encoding]::UTF8.GetString($ms.ToArray()).Contains($Needle)) { return $true } } finally { $fs.Dispose() } } }; $false }
function TtsLines { @(Select-String -Path $script:hudLog -Pattern '\[TTS\] speaking (\d+) characters' -ErrorAction SilentlyContinue) }
function Gate-Files([string]$Filter) { @(Get-ChildItem -LiteralPath $gateDir -Filter $Filter -ErrorAction SilentlyContinue | Sort-Object Name) }
function Step-Log([string]$m) { $line = "$((Get-Date).ToString('o')) $m"; Add-Content -Encoding utf8 -LiteralPath $stepLog -Value $line; Write-Host $line -ForegroundColor Cyan }
function Task-Response([string]$Id) {
    try { $all = Get-Content -LiteralPath $taskResults -Raw | ConvertFrom-Json; $r = @($all | Where-Object { $_.TaskId -eq $Id }); if ($r.Count) { return "$($r[0].Response)" } } catch { }
    return ''
}

# Real operations for Invoke-VoiceStep: visible windows, the real HUD microphone button, the gate files.
$script:speakForm = $null
$ops = New-GateFileOps $gateDir $SpeakTimeoutSec 15 { [System.Windows.Forms.Application]::DoEvents() } { $null -ne $script:speakForm -and ($script:speakForm.Tag -eq 0 -or $script:speakForm.IsDisposed) }
$ops.Log = { param($m) Step-Log $m }
$ops.ShowPrompt = {
    param($step, $expected, $attempt)
    $i = [array]::IndexOf(@($Steps.Keys), $step) + 1
    Write-Host "`n[$step] PROMPT (a window is open on screen): say exactly `"$expected`"" -ForegroundColor Green
    [console]::beep(880, 200)
    $r = Show-VoiceChoice "D-ASK voice acceptance - step $i of $($Steps.Count)" `
        "Step $i of $($Steps.Count)$(if ($attempt -gt 1) { " (attempt $attempt)" }). When you click 'I'm ready', D-ASK arms its microphone. Wait for the SPEAK NOW window, then say exactly:" `
        "`"$expected`"" `
        "Say it in one go: a pause longer than about one second splits the recording. ONLY this sentence is accepted; anything else is rejected and NOT sent to D-ASK. The microphone is off until you click." `
        @("I'm ready - arm the microphone", 'Cancel the test')
    [pscustomobject]@{ choice = $(if ($r.index -eq 0) { 'ack' } else { 'cancel' }); shownUtc = $r.shownUtc; ackUtc = $r.ackUtc; visible = $r.visible }
}
$ops.MicIsArmed = { try { [void](Find-HudButton $script:hwnd '^ARMED' 800); $true } catch { $false } }
$ops.Arm = {
    try { Confirm-HudForeground $script:hwnd | Out-Null } catch { }
    $c = Invoke-GuardedClick -Label 'arm voice' -ButtonPattern '^ARM VOICE'
    Step-Log "ARM VOICE click: sent=$($c.sent) $(if ($c.abortReason) { "reason=$($c.abortReason)" })"
}
$ops.WaitArmed = {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt 15000) {
        if (& $ops.MicIsArmed) {
            # Let the HUD's own arming sound finish (and its 1.5 s silence segment close) BEFORE the gate opens: a segment that began
            # before the opening is withheld by the HUD, and the person's sentence must not be merged into it.
            Start-Sleep -Milliseconds 2500
            Step-Log 'HUD shows ARMED'; return $true
        }
        if ((Safe-HudText) -match 'MICROPHONE PERMISSION DENIED') { Step-Log 'HUD reports microphone permission denied'; return $false }
        Start-Sleep -Milliseconds 200
    }
    $false
}
$ops.Disarm = {
    if (& $ops.MicIsArmed) {
        try { Confirm-HudForeground $script:hwnd | Out-Null } catch { }
        $c = Invoke-GuardedClick -Label 'disarm voice' -ButtonPattern '^ARMED'
        $sw = [Diagnostics.Stopwatch]::StartNew(); while ((& $ops.MicIsArmed) -and $sw.ElapsedMilliseconds -lt 5000) { Start-Sleep -Milliseconds 150 }
        Step-Log "microphone disarmed: $(-not (& $ops.MicIsArmed)) (click sent=$($c.sent))"
    }
}
$ops.ShowSpeakNow = {
    param($step, $expected)
    $f = New-VoiceForm 'D-ASK voice acceptance - SPEAK NOW' 'SPEAK NOW. The D-ASK microphone is ARMED. Say:' "`"$expected`"" "Waiting up to $SpeakTimeoutSec s for your sentence. This window closes by itself when D-ASK has heard you." @('Cancel the test')
    $f.Show(); $f.Activate(); [System.Windows.Forms.Application]::DoEvents()
    $script:speakForm = $f   # no beep here: the gate is open and the microphone would hear it
    Write-Host "[$step] SPEAK NOW: `"$expected`"" -ForegroundColor Yellow
}
$ops.HideSpeakNow = { if ($script:speakForm -and -not $script:speakForm.IsDisposed) { $script:speakForm.Close(); $script:speakForm.Dispose() }; [System.Windows.Forms.Application]::DoEvents() }
$ops.AskRetry = {
    param($step, $reason, $heard, $expected)
    $note = 'NOTHING was sent to D-ASK. Try again, or cancel the test.'
    if ($null -ne $heard) { $note = "D-ASK heard: `"$heard`"" + "`n" + $note }
    $r = Show-VoiceChoice "D-ASK voice acceptance - $step not accepted" "Not accepted: $reason" "Expected: `"$expected`"" $note @('Try again', 'Cancel the test')
    $(if ($r.index -eq 0) { 'retry' } else { 'cancel' })
}

# After a release: the HUD must forward EXACTLY that transcript (submitted-*.json with its hash, nothing blocked), and the daemon must accept ONE
# new task for it. Returns the task's id and outcome, or why not.
function Wait-StepTask($Held, [long]$DaemonMark, [string[]]$SubmittedBefore, [string[]]$BlockedBefore) {
    $res = [ordered]@{ submitted = $false; objectiveSha256 = $null; blocked = @(); taskId = $null; outcome = $null; problem = $null }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt 30 -and -not $res.submitted) {
        $new = @(Gate-Files 'submitted-*.json' | Where-Object { $SubmittedBefore -notcontains $_.Name })
        foreach ($f in $new) { $s = Read-GateJson $f.FullName; if ($s.objectiveSha256 -eq $Held.transcriptSha256) { $res.submitted = $true; $res.objectiveSha256 = $s.objectiveSha256 } }
        $res.blocked = @(Gate-Files 'blocked-*.json' | Where-Object { $BlockedBefore -notcontains $_.Name } | ForEach-Object { (Read-GateJson $_.FullName).reason })
        if ($res.blocked.Count) { break }
        Start-Sleep -Milliseconds 200
    }
    if (-not $res.submitted) { $res.problem = $(if ($res.blocked.Count) { "the HUD blocked the submission: $($res.blocked -join '; ')" } else { 'the released transcript was not submitted by the page within 30 s' }); return [pscustomobject]$res }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt 30 -and -not $res.taskId) {
        $m = [regex]::Matches((Read-LogSince $script:daemonLog $DaemonMark), 'task (t\w+) accepted')
        if ($m.Count -gt 1) { $res.problem = "more than one task accepted after the release: $($m | ForEach-Object { $_.Groups[1].Value })"; return [pscustomobject]$res }
        if ($m.Count -eq 1) { $res.taskId = $m[0].Groups[1].Value } else { Start-Sleep -Milliseconds 200 }
    }
    if (-not $res.taskId) { $res.problem = 'the daemon accepted no task for the released transcript'; return [pscustomobject]$res }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt 240 -and -not $res.outcome) {
        $m = [regex]::Match((Read-LogSince $script:daemonLog $DaemonMark), "task $($res.taskId) finished: (\w+)")
        if ($m.Success) { $res.outcome = $m.Groups[1].Value } else { Start-Sleep -Milliseconds 300 }
    }
    if (-not $res.outcome) { $res.problem = "task $($res.taskId) did not finish within 240 s" }
    return [pscustomobject]$res
}

$seenWav = @{}; $seenStem = @{}; $released = New-Object System.Collections.Generic.List[object]
function Spoken([string]$Key) {
    $expected = $Steps[$Key]
    $dMark = Get-LogLength $script:daemonLog; $t0 = (TtsLines).Count
    $subBefore = @(Gate-Files 'submitted-*.json' | ForEach-Object Name); $blkBefore = @(Gate-Files 'blocked-*.json' | ForEach-Object Name)
    $v = Invoke-VoiceStep $Key $expected $ops $seenWav $seenStem $MaxAttempts
    $out = [ordered]@{ step = $v; task = $null; spoken = @(); text = ''; response = '' }
    if ($v.status -ne 'released') { return [pscustomobject]$out }
    $released.Add($v.held)
    $out.task = Wait-StepTask $v.held $dMark $subBefore $blkBefore
    Start-Sleep -Seconds 3
    $out.spoken = @(TtsLines | Select-Object -Skip $t0 | ForEach-Object { $_.Line })
    $out.text = Safe-HudText
    Set-Content -Encoding utf8 (Join-Path $OutDir "hud-$Key.txt") $out.text
    if ($out.task.taskId) { $out.response = Task-Response $out.task.taskId }
    return [pscustomobject]$out
}
function Step-Detail($a) {
    @{ status = $a.step.status; reason = $a.step.reason; transcript = $a.step.transcript; attempts = @($a.step.attempts | ForEach-Object { [pscustomobject]@{ attempt = $_.attempt; prompt = $_.prompt; armed = $_.armed; nonce = $_.nonce; openedUtc = $_.openedUtc; heard = $(if ($_.held) { "$($_.held.transcript)" }); recording = $(if ($_.held) { "$($_.held.stem)" }); wavSha256 = $(if ($_.held) { "$($_.held.wavSha256)" }); engine = $(if ($_.held) { "$($_.held.engine)" }); verdict = $_.verdict; problem = $_.problem } })
        task = $a.task; response = $a.response; spoken = $a.spoken }
}
# Common to every step: released (prompt acknowledged, fresh matching local transcript), exactly it submitted, one task for it.
function Step-Ok($a) { $a.step.status -eq 'released' -and $a.task -and $a.task.submitted -and $a.task.taskId -and -not $a.task.problem -and $a.spoken.Count -ge 1 }

try {
    foreach ($k in $envs.Keys) { Set-Item "Env:\DASK_AgentHost__$k" $envs[$k] }
    $env:DASK_STT_EVIDENCE_DIR = $sttDir
    $env:DASK_VOICE_GATE_DIR = $gateDir
    & "$PSScriptRoot\start-stack.ps1" -OutDir $OutDir -Config $Config -Root $Root | Out-Null
    $pids = Get-Content "$OutDir\pids.json" -Raw | ConvertFrom-Json
    $script:hwnd = Get-HudHwnd $pids.hud
    $hs = [Diagnostics.Stopwatch]::StartNew(); while (-not ((Get-Content $script:hudLog -Raw -ErrorAction SilentlyContinue) -match 'Handshake accepted') -and $hs.ElapsedMilliseconds -lt 40000) { Start-Sleep -Milliseconds 200 }
    Enter-HudInteractive $script:hwnd
    try { $adm = Get-ModelMemoryAdmission $Root; $mp = Test-ModelMemoryPreflight $adm; Record $N.pre $mp.ok @{ availableMB = $adm.availableMB; requiredMB = $adm.requiredMB }; if (-not $mp.ok) { Abort $mp.reason } }
    catch { Record $N.pre $false @{ error = "$_" }; Abort "memory preflight failed: $_" }
    if (-not $script:Aborted) {
        # Setup (typed, before anyone speaks; the gate is not enforced yet and no step is open): index the test library.
        $s = Invoke-Request "Index `"$lib`" as research"
        $r = if ($s.Ok) { Wait-NewResult $s.Marks 'Indexing finished' 240000 20000 } else { $null }
        Record $N.setup ($r -and $r.outcome -eq 'COMPLETED') @{ pids = $pids; index = $(if ($r) { $r.outcome } else { $null }) }
        if (-not ($r -and $r.outcome -eq 'COMPLETED')) { Abort 'setup failed' }
    }
    if (-not $script:Aborted) {
        # From now on the HUD forwards to the daemon only a transcript released for an acknowledged, matching step.
        [IO.File]::WriteAllText((Join-Path $gateDir 'enforce'), (Get-Date).ToUniversalTime().ToString('o'), $script:Utf8NoBom)
        $script:daemonAfterSetup = Get-LogLength $script:daemonLog
        Step-Log 'voice gate ENFORCED'

        $a = Spoken 's1'
        Record $N.s1 ((Step-Ok $a) -and $a.task.outcome -eq 'completed' -and $a.text -match '(?m)^INDEPENDENTLY VERIFIED\s*$' -and $a.response -match '\b56\b') (Step-Detail $a)
        if (-not ($script:results | Where-Object { $_.name -eq $N.s1 -and $_.pass })) { Abort "S1 did not pass ($($a.step.status)$(if ($a.step.reason) { ": $($a.step.reason)" })$(if ($a.task.problem) { ": $($a.task.problem)" }))" }
    }
    if (-not $script:Aborted) {
        $b = Spoken 's2'
        Record $N.s2 ((Step-Ok $b) -and $b.task.outcome -in 'completed', 'unverified' -and (Mem-Has '16 November')) ((Step-Detail $b) + @{ inMemory = (Mem-Has '16 November') })
        if (-not ($script:results | Where-Object { $_.name -eq $N.s2 -and $_.pass })) { Abort "S2 did not pass ($($b.step.status)$(if ($b.step.reason) { ": $($b.step.reason)" })$(if ($b.task.problem) { ": $($b.task.problem)" }))" }
    }
    if (-not $script:Aborted) {
        $c = Spoken 's3'
        Record $N.s3 ((Step-Ok $c) -and $c.task.outcome -eq 'completed' -and $c.response -match '16 November' -and $c.text -match '16 November') (Step-Detail $c)
        if (-not ($script:results | Where-Object { $_.name -eq $N.s3 -and $_.pass })) { Abort "S3 did not pass ($($c.step.status)$(if ($c.step.reason) { ": $($c.step.reason)" })$(if ($c.task.problem) { ": $($c.task.problem)" }))" }
    }
    if (-not $script:Aborted) {
        $engines = @($released | ForEach-Object { "$($_.engine)" })
        Record $N.local ($engines.Count -eq 3 -and @($engines | Where-Object { $_ -notin $script:LocalEngines }).Count -eq 0) @{ engines = $engines }
        $accepted = @([regex]::Matches((Read-LogSince $script:daemonLog $script:daemonAfterSetup), 'task (t\w+) accepted') | ForEach-Object { $_.Groups[1].Value })
        $stepTasks = @($a, $b, $c | ForEach-Object { $_.task.taskId })
        $submitted = @(Gate-Files 'submitted-*.json' | ForEach-Object { (Read-GateJson $_.FullName).objectiveSha256 })
        $releasedSha = @($released | ForEach-Object { "$($_.transcriptSha256)" })
        Record $N.gate ($accepted.Count -eq 3 -and @($accepted | Where-Object { $stepTasks -notcontains $_ }).Count -eq 0 -and $submitted.Count -eq 3 -and @($submitted | Where-Object { $releasedSha -notcontains $_ }).Count -eq 0) @{
            daemonTasksAfterSetup = $accepted; stepTasks = $stepTasks; submittedSha256 = $submitted; releasedSha256 = $releasedSha
            withheld = @(Gate-Files '*.withheld.json' | ForEach-Object { $w = Read-GateJson $_.FullName; [pscustomobject]@{ recording = $w.stem; heard = $w.transcript; reason = $w.reason } })
            blocked = @(Gate-Files 'blocked-*.json' | ForEach-Object { $w = Read-GateJson $_.FullName; [pscustomobject]@{ objective = $w.objective; reason = $w.reason } }) }
    }
} catch {
    Record 'unexpected error' $false @{ error = "$($_.Exception.Message)" }
    Abort "unexpected error: $($_.Exception.Message)"
} finally {
    try { & $ops.HideSpeakNow } catch { }
    try { & "$PSScriptRoot\stop-stack.ps1" -OutDir $OutDir | Out-Null } catch { }
    foreach ($k in $envs.Keys) { Remove-Item "Env:\DASK_AgentHost__$k" -ErrorAction SilentlyContinue }
    Remove-Item Env:\DASK_STT_EVIDENCE_DIR, Env:\DASK_VOICE_GATE_DIR -ErrorAction SilentlyContinue
    foreach ($k in $N.Keys) { if (-not ($script:results | Where-Object { $_.name -eq $N[$k] })) { Record $N[$k] $false @{ notRun = "not reached: $($script:AbortReason)" } } }
    $checks = @($script:results.ToArray() | Where-Object { $_.name -ne 'unexpected error' })
    $passed = @($checks | Where-Object { $_.pass -eq $true }).Count
    $failed = @($script:results.ToArray() | Where-Object { $_.pass -ne $true }).Count
    ConvertTo-Json -InputObject @($script:results.ToArray()) -Depth 10 | Set-Content -Encoding utf8 (Join-Path $OutDir 'approval-live.json')
    ConvertTo-Json -InputObject ([pscustomobject]([ordered]@{ expectedTotal = $script:ExpectedChecks; total = $checks.Count; passed = $passed; failed = $failed; aborted = $script:Aborted; abortReason = $script:AbortReason })) | Set-Content -Encoding utf8 (Join-Path $OutDir 'approval-live-summary.json')
    Write-Host "`n$passed / $($checks.Count) checks passed (expected $($script:ExpectedChecks)); failed $failed; aborted: $($script:Aborted)"
    Write-Host "Results: $OutDir"
    if ($passed -ne $script:ExpectedChecks -or $script:Aborted) { exit 1 }
}
