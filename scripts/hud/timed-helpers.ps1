# Pure helpers of approval-live-timed.ps1 (no UI, no processes); unit-tested by approval-live-timed.tests.ps1.

# Windows PowerShell 5.1 emits a parsed JSON array as ONE object when piped, so "@(... | ConvertFrom-Json)" is an array holding an
# array and Where-Object matches the whole list. Enumerate explicitly instead.
function ConvertFrom-WorkflowStore([string]$Raw) {
    $out = New-Object System.Collections.ArrayList
    if (-not [string]::IsNullOrWhiteSpace($Raw)) { $parsed = ConvertFrom-Json -InputObject $Raw; foreach ($w in $parsed) { [void]$out.Add($w) } }
    return $out.ToArray()   # emitted element by element: callers wrap the call in @(...)
}
function Find-Workflow($List, [string]$Name) { foreach ($w in $List) { if ($w.Name -ceq $Name) { return $w } }; return $null }

# The scheduler's per-schedule log lines for one workflow: "[ts] ... [Workflows] "name" due 2026-11-11 01:35: <note>."
function Get-DueRuns([string]$LogText, [string]$Name) {
    $rx = '(?m)^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+)\][^\r\n]*\[Workflows\] "' + [regex]::Escape($Name) + '" due (\d{4}-\d\d-\d\d \d\d:\d\d): ([^\r\n]*?)\.?\r?$'
    foreach ($m in [regex]::Matches($LogText, $rx)) {
        $note = $m.Groups[3].Value
        $id = $null; if ($note -match '^submitted as task ([0-9a-z]+)$') { $id = $Matches[1] }   # ids look like t<32 hex>: NOT hex-only
        [pscustomobject]@{ loggedLocal = [datetime]::ParseExact($m.Groups[1].Value, 'yyyy-MM-dd HH:mm:ss.fff', [Globalization.CultureInfo]::InvariantCulture); dueLocal = $m.Groups[2].Value; note = $note; taskId = $id; submitted = ($null -ne $id); line = $m.Value.TrimEnd() }
    }
}
function Test-SubmittedNote([string]$Note) { return ($Note -match '^submitted as task [0-9a-z]+$') }

# The agent host's own end-of-task line (daemon log): "task <id> finished: completed in 27346 ms".
function Get-HostFinish([string]$LogText, [string]$TaskId) {
    $m = [regex]::Match($LogText, 'task ' + [regex]::Escape($TaskId) + ' finished: (\w+) in (\d+) ms')
    if ($m.Success) { return [pscustomobject]@{ outcome = $m.Groups[1].Value; ms = [int]$m.Groups[2].Value } }
    return $null
}
# The part of the HUD's text from its RESULT line on (the window title/telemetry that precedes it is not evidence).
function Get-ResultPart([string]$HudText) {
    if ([string]::IsNullOrEmpty($HudText)) { return '' }
    $m = [regex]::Match($HudText, '(?m)^RESULT')
    if ($m.Success) { return $HudText.Substring($m.Index) }
    return ''
}

# What happened to one typed request, from the submit record (Invoke-Request) and the result wait (Wait-NewResult). Never merges the cases:
#   not-submitted         the request never reached the daemon (a guard refused the click/typing/Enter, or the daemon never answered)
#   submitted-no-response the daemon accepted a task but no result arrived in the wait
#   completed             a result arrived and the HUD says COMPLETED
#   ended-<OUTCOME>       a result arrived with another outcome (FAILED, REFUSED, UNVERIFIED ...)
function Get-RequestState($Submit, $Arrived, [string]$Outcome) {
    if ($null -eq $Submit -or -not $Submit.ok) { return 'not-submitted' }
    if (-not $Arrived) { return 'submitted-no-response' }
    if ($Outcome -eq 'COMPLETED') { return 'completed' }
    return ('ended-' + $(if ($Outcome) { $Outcome } else { 'UNKNOWN' }))
}
# The store's independent verdict after an unschedule: the workflow is still saved with its steps, and its schedule is null. $Wf is the
# stored record (or $null if the workflow is missing); $ExpectedSteps its step count.
function Get-ScheduleRemovalVerdict($Wf, [int]$ExpectedSteps) {
    $retained = ($null -ne $Wf) -and (@($Wf.Steps).Count -eq $ExpectedSteps)
    $removed = ($null -ne $Wf) -and ($null -eq $Wf.Schedule)
    [pscustomobject]@{ workflowRetained = $retained; scheduleRemoved = $removed; ok = ($retained -and $removed) }
}
