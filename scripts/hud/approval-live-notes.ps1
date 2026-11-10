# Real-HUD acceptance for note creation (notes.create / Files.CreateNote).
# The request is typed into the REAL HUD exactly as the person dictated it; the approval is clicked in the REAL HUD card;
# the artifact is checked independently on disk (exact bytes). Notes are enabled ONLY in this run's daemon environment and
# the notes folder is inside -OutDir; appsettings.json and the code default stay off (checked before and after).
#   powershell -ExecutionPolicy Bypass -File scripts\hud\approval-live-notes.ps1 -OutDir results\notes-hud\live-<stamp>
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

# The exact request (as dictated, typed without quote characters) and the words it asks for.
$Request = 'Create a note titled Meeting. The note should contain the exact words, open quote, remember to submit the project report by Friday, close quote.'
$Expected = 'remember to submit the project report by Friday'

$script:ExpectedChecks = 11
$N = [ordered]@{
    flags = '0b Notes default OFF in appsettings.json and in code; enabled here only via this run''s environment'
    setup = '0 setup: real HUD handshook with the real daemon; HUD interactive'
    pre   = '0c memory preflight: the local model would be admitted with the HUD running'
    n1 = 'N1 the exact request: ONE Files.CreateNote card showing Meeting.txt and the exact words; APPROVE; result shows "Created the note"'
    n2 = 'N2 notes.create was advertised by the daemon and agreed by the Agent Host (protocol v2 negotiation)'
    n3 = 'N3 the artifact: <notes>\Meeting.txt exists and holds EXACTLY the requested words (bytes, UTF-8, nothing added); the only file'
    n4 = 'N4 the HUD reports COMPLETED (verified), not unverified / "result not confirmed"'
    n5 = 'N5 the same request again: no card, never overwritten, not COMPLETED'
    n6 = 'N6 another note, DENIED in the card: nothing written, not COMPLETED'
    log = 'L1 the daemon log shows the note written and verified, and no [Notes] error'
    end = 'Z  end state: Notes still off in appsettings.json and code; the default notes folder untouched by this run'
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
function Next-Request([string]$Text) {
    if ((Wait-PanelClosed) -lt 0) { Abort 'the previous approval panel did not close'; return $null }
    Restore-HudFront
    return Invoke-Request $Text
}
function Carded([string]$Text, [string]$CardFile, [string[]]$Need, [bool]$Approve, [string]$ResultPattern) {
    $s = Next-Request $Text
    if (-not $s -or -not $s.Ok) { return [pscustomobject]@{ ok = $false; detail = @{ submit = $(if ($s) { $s.Record } else { $null }) } } }
    $a = Wait-NewApproval $s.Marks 180000
    if ($a.Found) { Set-Content -Encoding utf8 (Join-Path $OutDir $CardFile) $a.Text }
    $missing = if ($a.Found) { @($Need | Where-Object { -not (Contains-Text $a.Text $_) }) } else { $Need }
    if (-not $a.Found -or $missing.Count) { return [pscustomobject]@{ ok = $false; detail = @{ found = $a.Found; reason = $a.Reason; missing = $missing } } }
    $d = Decide $s.Marks $a $Approve
    $r = Wait-NewResult $s.Marks $ResultPattern 240000
    $cards = [regex]::Matches((Read-LogSince $script:hudLog $s.Marks.hud), 'Approval surface opened for').Count
    return [pscustomobject]@{ ok = $d.ok -and $r.arrived; outcome = $r.outcome; matched = $r.matched; cards = $cards; full = [string]$r.text
        detail = @{ decision = $d.decision; cards = $cards; result = @{ arrived = $r.arrived; outcome = $r.outcome; matched = $r.matched; text = ($r.text -split "`n" | Select-Object -First 14) -join ' | ' } } }
}
function Plain([string]$Text, [string]$ResultPattern) {
    $s = Next-Request $Text
    if (-not $s -or -not $s.Ok) { return [pscustomobject]@{ ok = $false; outcome = $null; matched = $false; cards = 0; full = ''; detail = @{ submit = $(if ($s) { $s.Record } else { $null }) } } }
    $r = Wait-NewResult $s.Marks $ResultPattern 240000
    $cards = [regex]::Matches((Read-LogSince $script:hudLog $s.Marks.hud), 'Approval surface opened for').Count
    return [pscustomobject]@{ ok = $r.arrived; outcome = $r.outcome; matched = $r.matched; cards = $cards; full = [string]$r.text; detail = @{ outcome = $r.outcome; matched = $r.matched; cards = $cards; text = ($r.text -split "`n" | Select-Object -First 14) -join ' | ' } }
}
function Sha([string]$Path) { if (Test-Path -LiteralPath $Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLower() } else { $null } }
function FlagsOff {
    $settings = Get-Content (Join-Path $Root 'src\DAsk.Daemon\appsettings.json') -Raw | ConvertFrom-Json
    $src = Get-Content (Join-Path $Root 'src\DAsk.Daemon\AgentHost\AgentHostManager.cs') -Raw
    $cfg = -not ($settings.AgentHost.PSObject.Properties.Name -contains 'Notes') -or $settings.AgentHost.Notes -eq $false
    $code = $src -match 'public bool Notes \{ get; set; \} = false;'
    [pscustomobject]@{ ok = $cfg -and $code; appsettings = $cfg; code = $code }
}

$script:hudLog = Join-Path $OutDir 'hud.log'
$script:daemonLog = Join-Path $OutDir 'daemon.log'
$notes = Join-Path $OutDir 'notes'                       # created by the daemon on the first approved note
$note = Join-Path $notes 'Meeting.txt'
$defaultNote = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'D-ASK Notes\Meeting.txt'
$defaultBefore = Sha $defaultNote
try {
    $f0 = FlagsOff
    Record $N.flags $f0.ok $f0
    $env:DASK_AgentHost__Notes = 'true'; $env:DASK_AgentHost__NotesDir = $notes
    & "$PSScriptRoot\start-stack.ps1" -OutDir $OutDir -Config $Config -Root $Root | Out-Null
    $pids = Get-Content "$OutDir\pids.json" -Raw | ConvertFrom-Json
    $script:hwnd = Get-HudHwnd $pids.hud
    $hs = [Diagnostics.Stopwatch]::StartNew(); while (-not ((Get-Content $script:hudLog -Raw -ErrorAction SilentlyContinue) -match 'Handshake accepted') -and $hs.ElapsedMilliseconds -lt 30000) { Start-Sleep -Milliseconds 200 }
    Enter-HudInteractive $script:hwnd
    Record $N.setup ((Get-Content $script:hudLog -Raw) -match 'Handshake accepted') @{ notesDir = $notes; daemonPid = $pids.daemon; hudPid = $pids.hud }
    try {
        $adm = Get-ModelMemoryAdmission $Root; $mp = Test-ModelMemoryPreflight $adm
        [pscustomobject]@{ utc = (Get-Utc); measurement = $adm; decision = $mp } | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 (Join-Path $OutDir 'memory-preflight.json')
        Record $N.pre $mp.ok @{ availableMB = $adm.availableMB; requiredMB = $adm.requiredMB }
        if (-not $mp.ok) { Abort $mp.reason }
    } catch { Record $N.pre $false @{ error = "$_" }; Abort "memory preflight failed: $_" }

    if (-not $script:Aborted) {
        # N1: the exact request; the card must show the file and the exact words; approve.
        $r = Carded $Request 'card-n1-create-note.txt' @('Create a new note', 'Meeting.txt', $Expected) $true 'Created the note "Meeting"'
        Record $N.n1 ($r.ok -and $r.matched -and $r.cards -eq 1) $r.detail
        # N2: advertised and agreed (logged by the daemon when the host negotiated protocol v2).
        $neg = @(Select-String -Path $script:daemonLog -Pattern 'Protocol v2 negotiated: read-only desktop tools (.*)\.' -ErrorAction SilentlyContinue | ForEach-Object { $_.Matches[0].Groups[1].Value })
        $agreed = if ($neg.Count) { @($neg[-1] -split ',\s*') } else { @() }
        Record $N.n2 ($agreed -contains 'notes.create') @{ agreedTools = $agreed }
        # N3: the artifact, independently: exact bytes, the only file in the notes folder.
        $bytes = if (Test-Path -LiteralPath $note) { [IO.File]::ReadAllBytes($note) } else { $null }
        $want = [Text.UTF8Encoding]::new($false).GetBytes($Expected)
        $exact = $bytes -and ([Convert]::ToBase64String($bytes) -eq [Convert]::ToBase64String($want))
        $files = @(Get-ChildItem -LiteralPath $notes -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
        Record $N.n3 ($exact -and $files.Count -eq 1 -and $files[0] -eq 'Meeting.txt') @{ path = $note; files = $files; bytes = $(if ($bytes) { $bytes.Length } else { 0 }); content = $(if ($bytes) { [Text.Encoding]::UTF8.GetString($bytes) } else { $null }); sha256 = (Sha $note); expected = $Expected }
        # N4: the HUD's own outcome labels, read from THIS task's result block only (the HUD also shows earlier tasks' history).
        $m = [regex]::Match([string]$r.full, '(?s)RESULT[^\n]*\n(.*?)(\nEVENT LOG|$)')
        $block = if ($m.Success) { $m.Groups[1].Value } else { '' }
        $verifiedBlock = $block -match '(?m)^COMPLETED\s*$' -and $block -match '(?m)^INDEPENDENTLY VERIFIED\s*$' -and $block -match 'Created the note "Meeting"' -and $block -notmatch '(?i)not confirmed|unverified'
        Record $N.n4 ($r.outcome -eq 'COMPLETED' -and $verifiedBlock) @{ outcome = $r.outcome; resultBlock = (($block -split "`n" | Select-Object -First 8) -join ' | ') }
        Set-Content -Encoding utf8 (Join-Path $OutDir 'hud-result-n1.txt') $r.full
        # N5: the same request again: refused before any card; the file is unchanged.
        $h0 = Sha $note
        $r5 = Plain $Request ''
        Record $N.n5 ($r5.ok -and $r5.cards -eq 0 -and $r5.outcome -ne 'COMPLETED' -and (Sha $note) -eq $h0) ($r5.detail + @{ fileUnchanged = ((Sha $note) -eq $h0) })
        # N6: a different note, denied in the card: nothing written.
        $r6 = Carded 'Create a note titled Agenda containing "Review the budget"' 'card-n6-deny.txt' @('Create a new note', 'Agenda.txt', 'Review the budget') $false ''
        Record $N.n6 ($r6.ok -and $r6.outcome -ne 'COMPLETED' -and -not (Test-Path -LiteralPath (Join-Path $notes 'Agenda.txt'))) $r6.detail
    }
} catch {
    Record 'unexpected error' $false @{ error = "$($_.Exception.Message)" }
    Abort "unexpected error: $($_.Exception.Message)"
} finally {
    try {
        $written = @(Select-String -Path $script:daemonLog -Pattern '\[Notes\] notes\.create .*"Meeting" verified=True' -ErrorAction SilentlyContinue).Count
        $errs = @(Select-String -Path $script:daemonLog -Pattern '\[Notes\].*(fail|error|exception)' -ErrorAction SilentlyContinue | ForEach-Object { $_.Line })
        Record $N.log ($written -eq 1 -and $errs.Count -eq 0) @{ verifiedWrites = $written; errorLines = $errs }
    } catch { Record $N.log $false @{ error = "$_" } }
    try { & "$PSScriptRoot\stop-stack.ps1" -OutDir $OutDir | Out-Null } catch { }
    foreach ($v in 'Notes', 'NotesDir') { Remove-Item "Env:\DASK_AgentHost__$v" -ErrorAction SilentlyContinue }
    $f1 = FlagsOff
    Record $N.end ($f1.ok -and (Sha $defaultNote) -eq $defaultBefore) @{ flagsOff = $f1.ok; defaultNotesFolderUntouched = ((Sha $defaultNote) -eq $defaultBefore) }
    foreach ($k in $N.Keys) { if (-not ($script:results | Where-Object { $_.name -eq $N[$k] })) { Record $N[$k] $false @{ notRun = "not reached: $($script:AbortReason)" } } }
    $checks = @($script:results.ToArray() | Where-Object { $_.name -ne 'unexpected error' })
    $passed = @($checks | Where-Object { $_.pass -eq $true }).Count
    $failed = @($script:results.ToArray() | Where-Object { $_.pass -ne $true }).Count
    $summary = [ordered]@{ expectedTotal = $script:ExpectedChecks; total = $checks.Count; passed = $passed; failed = $failed; aborted = $script:Aborted; abortReason = $script:AbortReason; note = $note }
    ConvertTo-Json -InputObject @($script:results.ToArray()) -Depth 8 | Set-Content -Encoding utf8 (Join-Path $OutDir 'approval-live.json')
    ConvertTo-Json -InputObject ([pscustomobject]$summary) -Depth 6 | Set-Content -Encoding utf8 (Join-Path $OutDir 'approval-live-summary.json')
    Write-Host "`n$passed / $($checks.Count) checks passed (expected $($script:ExpectedChecks)); failed $failed; aborted: $($script:Aborted)$(if ($script:AbortReason) { " ($($script:AbortReason))" })"
    Write-Host "Results: $OutDir"
    if ($passed -ne $script:ExpectedChecks -or $script:Aborted) { exit 1 }
}
