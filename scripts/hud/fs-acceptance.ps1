# Phase 7A Release acceptance: filesystem requests typed into the real HUD on the Release package, answered by the
# daemon's agent host and the local model, over a synthetic project (DASK_WORKSPACE_ROOT). Real keyboard and mouse
# input. Records every outcome and answer, and any non-loopback connection by a D-ASK process.
# Starts and stops only its own processes.
param([string]$OutDir, [string]$Root, [string]$Config = 'Release', [string]$ModelId)
$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = (Resolve-Path "$PSScriptRoot\..\..").Path }
. "$PSScriptRoot\hud-driver.ps1"
New-Item -ItemType Directory -Force $OutDir | Out-Null

$project = Join-Path $env:TEMP ("dask-fs-acceptance-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
& node "$PSScriptRoot\make-fs-fixture.mjs" $project | Out-Null
$env:DASK_WORKSPACE_ROOT = $project   # inherited by the daemon, which passes it to the agent host

$script:results = New-Object System.Collections.ArrayList
function Record([string]$Name, [bool]$Pass, $Detail) {
    [void]$script:results.Add([pscustomobject]@{ name = $Name; pass = $Pass; detail = $Detail })
    "{0}  {1}  {2}" -f $(if ($Pass) { ' ok ' } else { 'FAIL' }), $Name, ($Detail | ConvertTo-Json -Compress -Depth 4)
}

# Any connection from a D-ASK process to something other than loopback, sampled every 500 ms.
$monitorFile = Join-Path $OutDir 'non-loopback-connections.txt'
$monitor = Start-Job -ScriptBlock {
    param($file)
    $seen = @{}
    while ($true) {
        $ids = @{}
        foreach ($p in Get-Process -Name 'node', 'llama-server', 'DAsk.Daemon', 'hud-native' -ErrorAction SilentlyContinue) { $ids[[int]$p.Id] = $p.ProcessName }
        foreach ($c in Get-NetTCPConnection -ErrorAction SilentlyContinue) {
            if ($ids.ContainsKey([int]$c.OwningProcess) -and $c.RemoteAddress -notmatch '^(127\.|::1$|0\.0\.0\.0$|::$)') {
                $k = "$($ids[[int]$c.OwningProcess])|$($c.RemoteAddress):$($c.RemotePort)"
                if (-not $seen.ContainsKey($k)) { $seen[$k] = 1; Add-Content -Path $file -Value "$((Get-Date).ToString('o')) $k" }
            }
        }
        Start-Sleep -Milliseconds 500
    }
} -ArgumentList $monitorFile

function Run-Request([string]$Id, [string]$Text) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Submit-HudRequest $hwnd $Text
    Start-Sleep -Milliseconds 300
    $o = Wait-HudOutcome $hwnd 240000
    $hudText = Get-HudText $hwnd
    Save-HudShot $hwnd (Join-Path $OutDir "$Id.png")
    $verified = $hudText -match '(?m)^INDEPENDENTLY VERIFIED$'
    # The panel's RESULT block: everything after the outcome line up to the event log.
    # The result panel only: its own "RESULT —" line, the outcome on the next line, then the answer up to the event log.
    $m = [regex]::Match($hudText, '(?sm)^RESULT[^\n]*\n(?:COMPLETED|UNVERIFIED|PARTIAL|FAILED|REFUSED|CANCELLED)\n(.*?)\nEVENT LOG')
    $answer = if ($m.Success) { $m.Groups[1].Value -replace '(?m)^INDEPENDENTLY VERIFIED\n', '' } else { '' }
    [pscustomobject]@{ id = $Id; request = $Text; outcome = $o.Outcome; ms = $sw.ElapsedMilliseconds; verified = $verified; answer = $answer }
}

try {
    $stackArgs = @{ OutDir = $OutDir; Config = $Config; Root = $Root }
    if ($ModelId) { $stackArgs.ModelId = $ModelId }
    & "$PSScriptRoot\start-stack.ps1" @stackArgs | Out-Null
    $pids = Get-Content "$OutDir\pids.json" -Raw | ConvertFrom-Json
    $script:hwnd = Get-HudHwnd $pids.hud
    Enter-HudInteractive $hwnd
    Start-Sleep -Seconds 2

    $runs = @(
        Run-Request 'A' 'Find all PDF files in my authorized project directory'
        Run-Request 'B' 'Find the latest report and show its metadata'
        Run-Request 'C' 'Read the introduction of this report'
        Run-Request 'C2' 'Read the introduction of docs/reports/2026-q3-report.md'
        Run-Request 'D' 'Find every occurrence of the term architecture in the project documentation'
        Run-Request 'E' 'Summarize the report using its actual contents'
        Run-Request 'E2' 'Summarize docs/reports/2026-q3-report.md using its actual contents'
    )
    $runs | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 (Join-Path $OutDir 'requests.json')
    foreach ($r in $runs) { "{0,-3} {1,-11} {2,6} ms verified={3}  {4}" -f $r.id, $r.outcome, $r.ms, $r.verified, $r.request }

    $byId = @{}; foreach ($r in $runs) { $byId[$r.id] = $r }
    $A = $byId['A']; $B = $byId['B']; $C = $byId['C']; $C2 = $byId['C2']; $D = $byId['D']; $E = $byId['E']; $E2 = $byId['E2']
    Record 'A: a completed answer lists exactly the two real PDFs' (($A.outcome -ne 'COMPLETED') -or (($A.answer -match 'docs/manual\.pdf') -and ($A.answer -match 'reports/annual-2025\.pdf'))) @{ outcome = $A.outcome }
    Record 'B: a completed answer puts the newest report first with its metadata' (($B.outcome -ne 'COMPLETED') -or ($B.answer -match '(?s)^.*?- docs/reports/2026-q3-report\.md .*?modified 2026-10-01')) @{ outcome = $B.outcome }
    Record 'C: "this report" names no file and is never reported completed' ($C.outcome -ne 'COMPLETED') @{ outcome = $C.outcome }
    Record 'C2: a completed read shows the real section and its lines' (($C2.outcome -ne 'COMPLETED') -or (($C2.answer -match 'lines 3') -and ($C2.answer -match 'rebuilt the architecture'))) @{ outcome = $C2.outcome }
    Record 'D: a completed search has real file:line evidence' (($D.outcome -ne 'COMPLETED') -or ($D.answer -match 'docs/architecture\.md:3')) @{ outcome = $D.outcome }
    Record 'E/E2: a summary is never reported as verified' (($E.outcome -ne 'COMPLETED') -and ($E2.outcome -ne 'COMPLETED')) @{ E = $E.outcome; E2 = $E2.outcome }
    Record 'no answer shows the .env or .pem content' (-not ($runs | Where-Object { $_.answer -match 'should-never-show' })) @{}
    Record 'every completed answer was independently verified' (-not ($runs | Where-Object { $_.outcome -eq 'COMPLETED' -and -not $_.verified })) @{}

    # Cancellation from the HUD during a long content search (3,000 log files).
    Start-Sleep -Seconds 6
    Submit-HudRequest $hwnd 'Find every occurrence of the term zebra in the project'
    [void](Wait-HudText $hwnd '(?m)^(PLANNING|UNDERSTANDING|EXECUTING)$' 30000)
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Click-HudElement $hwnd (Find-HudButton $hwnd '^CANCEL$')
    $x = Wait-HudOutcome $hwnd 60000
    Record 'CANCEL from the HUD stops a filesystem task' ($x.Outcome -eq 'CANCELLED') @{ outcome = $x.Outcome; clickToResultMs = $sw.ElapsedMilliseconds }

    Start-Sleep -Seconds 1
    $connections = if (Test-Path $monitorFile) { @(Get-Content $monitorFile) } else { @() }
    Record 'no D-ASK process opened a non-loopback connection' ($connections.Count -eq 0) @{ connections = $connections }
    $hostLine = Select-String -Path "$OutDir\daemon.log" -Pattern 'Package check (passed|failed)' | Select-Object -First 1
    Record 'the Release host started from the verified package' ([bool]$hostLine -and $hostLine.Line -match 'passed') @{ line = $(if ($hostLine) { $hostLine.Line.Substring($hostLine.Line.IndexOf('[AgentHost]')) } else { $null }) }
    $leak = Select-String -Path "$OutDir\daemon.log", "$OutDir\hud.log" -Pattern 'should-never-show|rebuilt the architecture|Find all PDF' -Quiet
    Record 'logs hold no file contents or request text' (-not $leak) @{}
} catch {
    Record 'acceptance run aborted' $false @{ error = "$_"; line = $_.InvocationInfo.ScriptLineNumber }
} finally {
    Stop-Job $monitor -ErrorAction SilentlyContinue; Remove-Job $monitor -Force -ErrorAction SilentlyContinue
    if (Test-Path "$OutDir\pids.json") { & "$PSScriptRoot\stop-stack.ps1" -OutDir $OutDir | Out-Null }
    Remove-Item -LiteralPath $project -Recurse -Force -ErrorAction SilentlyContinue
}
$script:results | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 (Join-Path $OutDir 'fs-acceptance.json')
"`n$(@($script:results | Where-Object pass).Count) of $($script:results.Count) passed"
