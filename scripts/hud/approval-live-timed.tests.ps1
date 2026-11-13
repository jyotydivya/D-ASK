# Focused regression tests for scripts\hud\timed-helpers.ps1 (the defects found by the first scheduled-run acceptance).
#   powershell -ExecutionPolicy Bypass -File scripts\hud\approval-live-timed.tests.ps1
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\timed-helpers.ps1"
$script:pass = 0; $script:fail = 0
function T([string]$Name, [bool]$Ok) { if ($Ok) { $script:pass++; Write-Host " ok   $Name" } else { $script:fail++; Write-Host "FAIL  $Name" } }

# --- S2/S4/U1: the PowerShell 5.1 array quirk (a stored array of two workflows must give per-workflow records) ---
$raw = '[{"Name":"nightly","Steps":["What is 2+3?","Organize it"],"CreatedUtc":"2026-11-10T19:58:05Z","Schedule":null},{"Name":"dropme","Steps":["What is 7+8?"],"CreatedUtc":"2026-11-10T19:58:15Z","Schedule":{"Kind":"daily","Time":"01:35","LastRunUtc":null,"LastNote":null}}]'
$list = @(ConvertFrom-WorkflowStore $raw)
T 'T1 two stored workflows parse as two records' (@($list).Count -eq 2)
$d = Find-Workflow $list 'dropme'; $n = Find-Workflow $list 'nightly'
T 'T2 dropme has exactly its own single step' (@($d.Steps).Count -eq 1 -and $d.Steps[0] -eq 'What is 7+8?')
T 'T3 nightly has exactly its own two steps and no schedule' (@($n.Steps).Count -eq 2 -and $null -eq $n.Schedule)
T 'T4 dropme schedule is a single object, not an array' ($d.Schedule.Kind -eq 'daily' -and $d.Schedule.Time -eq '01:35' -and $d.Schedule -isnot [array])
T 'T5 an unknown name finds nothing' ($null -eq (Find-Workflow $list 'nope'))
T 'T6 a single stored workflow still parses' (@(ConvertFrom-WorkflowStore '[{"Name":"a","Steps":["x y z"],"Schedule":null}]').Count -eq 1)
T 'T7 an empty store parses to no records' (@(ConvertFrom-WorkflowStore '[]').Count -eq 0 -and @(ConvertFrom-WorkflowStore '').Count -eq 0)
T 'T8 names match case-sensitively (the daemon keeps the saved spelling)' ($null -eq (Find-Workflow $list 'Nightly'))

# --- F1/F4: task ids begin with "t" (they are not hex-only) ---
$log = "[2026-11-11 01:35:10.715] info: DAsk.Daemon.Automation.Workflows.WorkflowScheduler[0] [Workflows] `"nightly`" due 2026-11-11 01:35: submitted as task t20c061444e374e939de6662d696aca2d.`r`n" +
       "[2026-11-11 01:35:10.734] info: DAsk.Daemon.Automation.Workflows.WorkflowScheduler[0] [Workflows] `"dropme`" due 2026-11-11 01:35: skipped: not started: busy.`r`n"
$r = @(Get-DueRuns $log 'nightly')
T 'T9 the nightly due line is found once, as submitted, with its t-prefixed task id' ($r.Count -eq 1 -and $r[0].submitted -and $r[0].taskId -eq 't20c061444e374e939de6662d696aca2d' -and $r[0].dueLocal -eq '2026-11-11 01:35')
$k = @(Get-DueRuns $log 'dropme')
T 'T10 a skipped line is found and is not "submitted"' ($k.Count -eq 1 -and -not $k[0].submitted -and $k[0].note -eq 'skipped: not started: busy')
T 'T11 no due line for an unknown workflow' (@(Get-DueRuns $log 'ghost').Count -eq 0)
T 'T12 the LastNote check accepts the stored note and rejects look-alikes' ((Test-SubmittedNote 'submitted as task t20c061444e374e939de6662d696aca2d') -and -not (Test-SubmittedNote 'submitted as task t20c061444e374e939de6662d696aca2d skipped: not started: busy') -and -not (Test-SubmittedNote 'skipped: not started: busy') -and -not (Test-SubmittedNote $null))
T 'T13 the logged time parses as local time' ($r[0].loggedLocal -eq [datetime]'2026-11-11 01:35:10.715')

# --- F3: the host's own end-of-task line, and the HUD result text ---
$host1 = "[2026-11-11 01:35:38.030] dbug: DAsk.Daemon.AgentHost.AgentHostManager[0] [AgentHost stderr] [agent-host 2026-11-10T20:05:38.028Z] task t20c061444e374e939de6662d696aca2d finished: completed in 27346 ms`r`n"
$f = Get-HostFinish $host1 't20c061444e374e939de6662d696aca2d'
T 'T14 the host finish line is read (outcome and duration)' ($f -and $f.outcome -eq 'completed' -and $f.ms -eq 27346)
T 'T15 another task id has no finish line' ($null -eq (Get-HostFinish $host1 't000'))
$hud = "D-ASK`nINTERACTIVE`nFPS:`n37`nRESULT`nREFUSED`nI can't do that with the tools I currently have. No tool unschedules.`nDRAG"
T 'T16 the HUD result part starts at RESULT and keeps the refusal reason' ((Get-ResultPart $hud) -match "^RESULT\nREFUSED\nI can't do that" -and (Get-ResultPart $hud) -match 'No tool unschedules')
T 'T17 no RESULT in the HUD text gives an empty result part (never invented)' ((Get-ResultPart "D-ASK`nINTERACTIVE`nFPS:`n37") -eq '' -and (Get-ResultPart $null) -eq '')

# --- U1: the request-state classification and the store's verdict after an unschedule (run 20261112T170514 recorded an empty result) ---
T 'T18 a refused click is "not-submitted", never a failed unschedule' ((Get-RequestState ([pscustomobject]@{ ok = $false }) $false $null) -eq 'not-submitted' -and (Get-RequestState $null $false $null) -eq 'not-submitted')
T 'T19 an accepted task with no result is "submitted-no-response"' ((Get-RequestState ([pscustomobject]@{ ok = $true }) $false $null) -eq 'submitted-no-response')
T 'T20 a COMPLETED result is "completed"; other outcomes keep their name' ((Get-RequestState ([pscustomobject]@{ ok = $true }) $true 'COMPLETED') -eq 'completed' -and (Get-RequestState ([pscustomobject]@{ ok = $true }) $true 'FAILED') -eq 'ended-FAILED' -and (Get-RequestState ([pscustomobject]@{ ok = $true }) $true $null) -eq 'ended-UNKNOWN')
$sched = ConvertFrom-WorkflowStore '[{"Name":"nightly","Steps":["a b c","d e f"],"Schedule":{"Kind":"daily","Time":"17:12","LastRunUtc":"2026-11-12T11:42:09Z"}}]'
$v = Get-ScheduleRemovalVerdict (Find-Workflow @($sched) 'nightly') 2
T 'T21 the state of run 20261112T170514 (schedule still there) is NOT a pass' (-not $v.ok -and $v.workflowRetained -and -not $v.scheduleRemoved)
$gone = ConvertFrom-WorkflowStore '[{"Name":"nightly","Steps":["a b c","d e f"],"Schedule":null}]'
$v = Get-ScheduleRemovalVerdict (Find-Workflow @($gone) 'nightly') 2
T 'T22 schedule null and both steps kept is a pass' ($v.ok -and $v.workflowRetained -and $v.scheduleRemoved)
$v = Get-ScheduleRemovalVerdict $null 2
T 'T23 a deleted workflow is not a pass (neither retained nor "removed")' (-not $v.ok -and -not $v.workflowRetained -and -not $v.scheduleRemoved)
$v = Get-ScheduleRemovalVerdict (Find-Workflow @(ConvertFrom-WorkflowStore '[{"Name":"nightly","Steps":["a b c"],"Schedule":null}]') 'nightly') 2
T 'T24 a workflow that lost a step is not a pass' (-not $v.ok -and -not $v.workflowRetained)

Write-Host "`n$($script:pass) passed, $($script:fail) failed"
if ($script:fail -gt 0) { exit 1 }
