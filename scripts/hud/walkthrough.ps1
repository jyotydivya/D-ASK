# The Phase 6 HUD walkthrough: real window, real mouse and keyboard, real daemon, host, llama-server and model.
# Starts and stops only its own processes. Writes results to -OutDir (walkthrough.json and screenshots).
param(
    [string]$OutDir,
    [string]$Config = 'Debug',
    [string]$ModelId,
    [string]$HudExe,
    [string]$DaemonExe,
    [string]$Root,
    [string]$Only
)
$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = (Resolve-Path "$PSScriptRoot\..\..").Path }
. "$PSScriptRoot\hud-driver.ps1"
New-Item -ItemType Directory -Force $OutDir | Out-Null

$script:results = New-Object System.Collections.ArrayList
function Record([string]$Name, [bool]$Pass, $Detail) {
    [void]$script:results.Add([pscustomobject]@{ name = $Name; pass = $Pass; detail = $Detail })
    "{0}  {1}  {2}" -f $(if ($Pass) { ' ok ' } else { 'FAIL' }), $Name, ($Detail | ConvertTo-Json -Compress -Depth 4)
}
function Start-Stack {
    $stackArgs = @{ OutDir = $OutDir; Config = $Config; Root = $Root }
    if ($ModelId) { $stackArgs.ModelId = $ModelId }
    if ($HudExe) { $stackArgs.HudExe = $HudExe }
    if ($DaemonExe) { $stackArgs.DaemonExe = $DaemonExe }
    & "$PSScriptRoot\start-stack.ps1" @stackArgs | Out-Null
    $script:pids = Get-Content "$OutDir\pids.json" -Raw | ConvertFrom-Json
    $script:hwnd = Get-HudHwnd $script:pids.hud
    Enter-HudInteractive $script:hwnd
    Start-Sleep -Seconds 2
}
function Host-Processes {
    Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'stdioHost' }
}
function Llama-Processes { @(Get-Process -Name 'llama-server' -ErrorAction SilentlyContinue) }
function Wait-Planning { (Wait-HudText $hwnd '(?m)^(PLANNING|UNDERSTANDING|EXECUTING)$' 30000).Found }
function Hud-Lines { (Get-HudText $hwnd) -split "`n" }
function Wait-Until([scriptblock]$Test, [int]$TimeoutMs) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    do { if (& $Test) { return $sw.ElapsedMilliseconds }; Start-Sleep -Milliseconds 50 } while ($sw.ElapsedMilliseconds -lt $TimeoutMs)
    return -1
}
function Run-Task([string]$Text, [int]$TimeoutMs = 180000) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Submit-HudRequest $hwnd $Text
    Start-Sleep -Milliseconds 300
    $o = Wait-HudOutcome $hwnd $TimeoutMs
    return [pscustomobject]@{ outcome = $o.Outcome; ms = $sw.ElapsedMilliseconds; verified = ((Get-HudText $hwnd) -match '(?m)^INDEPENDENTLY VERIFIED$') }
}

try {
Start-Stack
"stack: daemon=$($pids.daemon) hud=$($pids.hud)"
$hudLog = Get-Content "$OutDir\hud.log" -Raw
Record 'real HUD verified and handshook with the real daemon, no overrides' (($hudLog -match 'Verified pipe server') -and ($hudLog -match 'Handshake accepted')) @{}

# 1. A task from the HUD, through local inference and independent verification
$r = Run-Task 'What is (17+25)*2?'
Save-HudShot $hwnd "$OutDir\01-completed.png"
$lines = Hud-Lines
Record 'task completes from the HUD with verification (first task, model load)' (($r.outcome -eq 'COMPLETED') -and $r.verified -and ($lines -match '= 84').Count -gt 0) $r
Record 'host and exactly one llama-server run under the daemon' ((@(Host-Processes).Count -eq 1) -and ((Llama-Processes).Count -eq 1)) @{ host = @(Host-Processes).Count; llama = (Llama-Processes).Count }

# 2. A second task, model already loaded
$r = Run-Task 'What is 144/12?'
Record 'second task (model loaded)' ($r.outcome -eq 'COMPLETED') $r

# 3. A request nothing can do: must not read as success. Typing Q must not close the HUD.
$r = Run-Task 'Send an email to Quentin about the quarterly report'
Save-HudShot $hwnd "$OutDir\02-impossible.png"
Record 'an impossible request is not reported as completed' (($r.outcome -ne $null) -and ($r.outcome -ne 'COMPLETED')) $r
Record 'typing Q in the request box does not close the HUD' ($null -ne (Get-Process -Id $pids.hud -ErrorAction SilentlyContinue)) @{}

# 4. Cancel during real inference
Submit-HudRequest $hwnd 'What is 91*3?'
$planning = Wait-Planning
Save-HudShot $hwnd "$OutDir\03-before-cancel.png"
$sw = [Diagnostics.Stopwatch]::StartNew()
Click-HudElement $hwnd (Find-HudButton $hwnd '^CANCEL$')
$o = Wait-HudOutcome $hwnd 30000
$cancelMs = $sw.ElapsedMilliseconds
Save-HudShot $hwnd "$OutDir\04-cancelled.png"
Record 'CANCEL ends a running task as cancelled' ($planning -and ($o.Outcome -eq 'CANCELLED')) @{ outcome = $o.Outcome; clickToResultMs = $cancelMs }

# 5. Busy
Start-Sleep -Seconds 6
Submit-HudRequest $hwnd 'What is 7*8?'
[void](Wait-Planning)
Submit-HudRequest $hwnd 'What is 9*9?'
$busy = (Wait-HudText $hwnd 'ALREADY RUNNING' 5000).Found
Save-HudShot $hwnd "$OutDir\05-busy.png"
$o = Wait-HudOutcome $hwnd 120000
Record 'a second request while one runs is refused and the first still finishes' ($busy -and ($o.Outcome -eq 'COMPLETED')) @{ busyShown = $busy; first = $o.Outcome }

# 6. Emergency Stop button during inference
Submit-HudRequest $hwnd 'What is 123+456?'
[void](Wait-Planning)
$sw = [Diagnostics.Stopwatch]::StartNew()
Click-HudElement $hwnd (Find-HudButton $hwnd 'STOP \[Ctrl')
$o = Wait-HudOutcome $hwnd 30000
$stopMs = $sw.ElapsedMilliseconds
$resumeShown = [bool](Find-HudButton $hwnd 'RESUME' 5000)
Save-HudShot $hwnd "$OutDir\06-emergency-stop.png"
Record 'the STOP button ends a running task as cancelled and latches' (($o.Outcome -eq 'CANCELLED') -and $resumeShown) @{ outcome = $o.Outcome; clickToResultMs = $stopMs; resumeShown = $resumeShown }

# 7. A task during the stop is refused
Submit-HudRequest $hwnd 'What is 5+5?'
$refused = Wait-HudText $hwnd 'Emergency Stop is active' 10000
Save-HudShot $hwnd "$OutDir\07-refused-while-stopped.png"
Record 'a task during Emergency Stop is refused with the reason' $refused.Found @{}

# 8. Resume, then work again
Click-HudElement $hwnd (Find-HudButton $hwnd 'RESUME')
$stopBack = [bool](Find-HudButton $hwnd 'STOP \[Ctrl' 8000)
$r = Run-Task 'What is 6*7?'
Record 'RESUME clears the stop and the next task completes' ($stopBack -and ($r.outcome -eq 'COMPLETED')) $r

# 9. The global hotkey during inference
Submit-HudRequest $hwnd 'What is 31*4?'
[void](Wait-Planning)
Assert-HudForeground $hwnd
$sw = [Diagnostics.Stopwatch]::StartNew()
[HudInput]::Chord([uint16[]]@(0x11, 0x10), 0x7B)
$o = Wait-HudOutcome $hwnd 30000
$hotkeyMs = $sw.ElapsedMilliseconds
$resumeShown = [bool](Find-HudButton $hwnd 'RESUME' 5000)
Save-HudShot $hwnd "$OutDir\08-hotkey-stop.png"
Record 'Ctrl+Shift+F12 ends a running task as cancelled and latches' (($o.Outcome -eq 'CANCELLED') -and $resumeShown) @{ outcome = $o.Outcome; hotkeyToResultMs = $hotkeyMs }
Click-HudElement $hwnd (Find-HudButton $hwnd 'RESUME')
[void](Find-HudButton $hwnd 'STOP \[Ctrl' 8000)

# 9b. STOP clicked exactly as the 5 s heartbeat comes due. This timing once deadlocked the pipe, dropped the
#     session and lost the task's real result.
$handshake = [regex]::Match((Get-Content "$OutDir\hud.log" -Raw), '(\S+)Z\s+INFO\s+hud_native::ipc::client: Handshake accepted')
$sessionStart = [datetime]::Parse($handshake.Groups[1].Value, $null, [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal)
$handshakesBefore = @(Select-String -Path "$OutDir\hud.log" -Pattern 'Handshake accepted').Count
$aligned = @()
for ($i = 1; $i -le 5; $i++) {
    Submit-HudRequest $hwnd "What is $i*1000+$i?"
    [void](Wait-Planning)
    $stop = Find-HudButton $hwnd 'STOP \[Ctrl'
    $since = ([datetime]::UtcNow - $sessionStart).TotalSeconds
    $wait = 5 - ($since % 5) - 0.14
    if ($wait -lt 0.05) { $wait += 5 }
    Start-Sleep -Milliseconds ([int]($wait * 1000))
    Click-HudElement $hwnd $stop
    $o = Wait-HudOutcome $hwnd 30000
    $aligned += $o.Outcome
    Click-HudElement $hwnd (Find-HudButton $hwnd 'RESUME')
    [void](Find-HudButton $hwnd 'STOP \[Ctrl' 8000)
    Start-Sleep -Seconds 1
}
$handshakesAfter = @(Select-String -Path "$OutDir\hud.log" -Pattern 'Handshake accepted').Count
$writeTimeouts = @(Select-String -Path "$OutDir\hud.log" -Pattern 'write timed out').Count
Record 'STOP on the heartbeat: real result every time, session never drops' ((@($aligned | Where-Object { $_ -ne 'CANCELLED' }).Count -eq 0) -and ($handshakesAfter -eq $handshakesBefore) -and ($writeTimeouts -eq 0)) @{ outcomes = $aligned; reconnects = ($handshakesAfter - $handshakesBefore); writeTimeouts = $writeTimeouts }

# 10. Agent host crash during a task
Submit-HudRequest $hwnd 'What is 88/4?'
[void](Wait-Planning)
Start-Sleep -Milliseconds 500
$hostBefore = @(Host-Processes)[0].ProcessId
Stop-Process -Id $hostBefore -Force
$sw = [Diagnostics.Stopwatch]::StartNew()
$o = Wait-HudOutcome $hwnd 30000
$crashMs = $sw.ElapsedMilliseconds
$interrupted = (Get-HudText $hwnd) -match 'INTERRUPTED'
Save-HudShot $hwnd "$OutDir\09-host-crash.png"
Record 'a host crash shows the task as interrupted and not retried' (($o.Outcome -eq 'FAILED') -and $interrupted) @{ outcome = $o.Outcome; crashToResultMs = $crashMs; interrupted = $interrupted }
$goneMs = Wait-Until { (Llama-Processes).Count -eq 0 -or -not ((Llama-Processes).Parent.Id -contains $hostBefore) } 15000
$r = Run-Task 'What is 11*11?'
Record 'after the crash a new task runs on a new host' (($r.outcome -eq 'COMPLETED') -and (@(Host-Processes).Count -eq 1) -and (@(Host-Processes)[0].ProcessId -ne $hostBefore) -and ((Llama-Processes).Count -eq 1)) $r

# 11. Daemon crash during a task
Submit-HudRequest $hwnd 'What is 15*15?'
[void](Wait-Planning)
Stop-Process -Id $pids.daemon -Force
$sw = [Diagnostics.Stopwatch]::StartNew()
$o = Wait-HudOutcome $hwnd 30000
$lostMs = $sw.ElapsedMilliseconds
$lost = (Get-HudText $hwnd) -match 'Lost the connection'
Save-HudShot $hwnd "$OutDir\10-daemon-crash.png"
$treeGone = Wait-Until { (@(Host-Processes).Count -eq 0) -and ((Llama-Processes).Count -eq 0) } 10000
Record 'a daemon crash reads as connection lost, and the host and model server exit' (($o.Outcome -eq 'FAILED') -and $lost -and ($treeGone -ge 0)) @{ outcome = $o.Outcome; lostMs = $lostMs; treeGoneMs = $treeGone }
Submit-HudRequest $hwnd 'What is 2+3?'
$notSent = Wait-HudText $hwnd 'not connected' 10000
Save-HudShot $hwnd "$OutDir\11-no-daemon.png"
Record 'a task with no daemon is refused immediately and not queued' $notSent.Found @{ ms = $notSent.Ms }

# 12. Daemon back: reconnects, and the refused task was not silently run
$daemonExe = if ($DaemonExe) { $DaemonExe } else { Join-Path $Root "src\DAsk.Daemon\bin\$Config\net8.0\DAsk.Daemon.exe" }
$d2 = Start-Process -FilePath $daemonExe -WorkingDirectory (Split-Path $daemonExe) -RedirectStandardOutput "$OutDir\daemon2.log" -RedirectStandardError "$OutDir\daemon2.err.log" -PassThru -WindowStyle Hidden
$pids.daemon = $d2.Id
$pids | ConvertTo-Json | Set-Content -Encoding utf8 "$OutDir\pids.json"
Start-Sleep -Seconds 8
$noReplay = -not (Select-String -Path "$OutDir\daemon2.log" -Pattern 'accepted' -Quiet)
$r = Run-Task 'What is 21*2?'
Record 'after reconnecting nothing is replayed and a new task completes' ($noReplay -and ($r.outcome -eq 'COMPLETED')) (@{ noReplay = $noReplay; outcome = $r.outcome; ms = $r.ms })
$accepted = @(Select-String -Path "$OutDir\daemon2.log" -Pattern 'task t[0-9a-f]+ accepted').Count
Record 'the new daemon ran exactly the one new task' ($accepted -eq 1) @{ accepted = $accepted }

# 13. HUD closes during a task: the daemon cancels it and stays up
Submit-HudRequest $hwnd 'What is 77+23?'
[void](Wait-Planning)
Stop-Process -Id $pids.hud -Force
$cancelled = Wait-Until { Select-String -Path "$OutDir\daemon2.log" -Pattern 'finished: cancelled' -Quiet } 15000
Record 'closing the HUD cancels its task; the daemon stays up' (($cancelled -ge 0) -and ($null -ne (Get-Process -Id $d2.Id -ErrorAction SilentlyContinue))) @{ cancelledAfterMs = $cancelled }

# 14. A new HUD on the same daemon works and is not shown the old task
$stackHud = if ($HudExe) { $HudExe } else { Join-Path $Root "src\hud-native\target\$($Config.ToLower())\hud-native.exe" }
$env:DASK_HUD_LOG = "$OutDir\hud2.log"
$h2 = Start-Process -FilePath $stackHud -WorkingDirectory $Root -PassThru
for ($i = 0; $i -lt 40; $i++) { Start-Sleep -Milliseconds 500; $x = Get-Process -Id $h2.Id -ErrorAction SilentlyContinue; if ($x -and $x.MainWindowHandle -ne 0) { break } }
$pids.hud = $h2.Id
$pids | ConvertTo-Json | Set-Content -Encoding utf8 "$OutDir\pids.json"
$hwnd = Get-HudHwnd $h2.Id
Enter-HudInteractive $hwnd
Start-Sleep -Seconds 3
# History is kept across runs by design, so the old request may be listed. It must not look like it is still running.
$reopened = Get-HudText $hwnd
$clean = ($reopened -notmatch 'LOCAL AGENT WORKING') -and ($reopened -notmatch '(?m)^(PLANNING|UNDERSTANDING|EXECUTING|VERIFYING)$')
$r = Run-Task 'What is 12*12?'
Save-HudShot $hwnd "$OutDir\12-new-hud.png"
Record 'a reopened HUD starts clean and completes a task' ($clean -and ($r.outcome -eq 'COMPLETED')) (@{ clean = $clean; outcome = $r.outcome })

# 15. Logs hold no objectives or tokens
$secretHits = @()
foreach ($f in Get-ChildItem $OutDir -Filter '*.log') {
    $c = Get-Content $f.FullName -Raw
    foreach ($needle in 'Quentin', 'quarterly', '17\+25', 'session_token', 'DASK_AGENT_HOST_TOKEN', 'LLAMA_API_KEY=') { if ($c -match $needle) { $secretHits += "$($f.Name):$needle" } }
}
Record 'daemon and HUD logs contain no request text or credentials' ($secretHits.Count -eq 0) @{ hits = $secretHits }

} catch {
    Record 'walkthrough aborted' $false @{ error = "$_"; at = $_.InvocationInfo.ScriptLineNumber }
    if ($hwnd) { try { Save-HudShot $hwnd "$OutDir\aborted.png" } catch {} }
} finally {
    & "$PSScriptRoot\stop-stack.ps1" -OutDir $OutDir
}
$script:results | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 "$OutDir\walkthrough.json"
$pass = @($script:results | Where-Object pass).Count
"`n$pass of $($script:results.Count) passed"
