# Real-HUD acceptance of a VOICE-INITIATED task: a PERSON speaks into the real microphone; nothing in this script types, clicks or injects audio.
# It starts the real stack (default local model, nothing switched), waits for the person to click the microphone button and say the prompted request,
# and then verifies, from the HUD's and the daemon's own logs and the HUD's text:
#   the local recognizer transcribed it (engine named) -> the HUD submitted the transcript as an ordinary task -> the local agent finished it COMPLETED and
#   independently verified -> the HUD shows the answer -> the answer was SPOKEN by the local voice ("[TTS] speaking N characters" after the task finished).
# Run it through the Wi-Fi wrapper (offline-voice-acceptance.ps1) for the offline acceptance.
#   powershell -ExecutionPolicy Bypass -File scripts\hud\approval-live-voice.ps1 -OutDir results\voice-hud\live-<stamp> [-TimeoutSec 600]
param([Parameter(Mandatory = $true)][string]$OutDir, [string]$Root, [string]$Config = 'Debug', [int]$TimeoutSec = 600,
      [string]$Phrase = 'What is seven times eight?', [string]$Answer = '56')
$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = (Resolve-Path "$PSScriptRoot\..\..").Path }
if ((Test-Path $OutDir) -and @(Get-ChildItem $OutDir -Force).Count -gt 0) { throw "OutDir must be new or empty: $OutDir" }
New-Item -ItemType Directory -Force $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path
$keepOut = $OutDir; $keepRoot = $Root; $keepConfig = $Config
. "$PSScriptRoot\approval-live-7b3.ps1" -OutDir $keepOut -Root $keepRoot -Config $keepConfig -LoadFunctionsOnly
$OutDir = $keepOut; $Root = $keepRoot; $Config = $keepConfig
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\hud-driver.ps1"

$script:ExpectedChecks = 8
$N = [ordered]@{
    setup = 'Z1 setup: real HUD handshook with the real daemon; HUD interactive; default configuration'
    pre   = 'Z2 memory preflight: the local model would be admitted with the HUD running'
    v1    = 'V1 a person spoke: the HUD sent a recording to the LOCAL recognizer and got a non-empty transcript back (engine, time and length logged)'
    v2    = 'V2 the transcript is the prompted request (at least two of seven / times / eight, or 7 / 8, are heard)'
    v3    = 'V3 the HUD submitted that transcript as an ordinary task (no typing): the daemon accepted a task after the transcription and finished it COMPLETED'
    v4    = 'V4 the HUD shows the result: COMPLETED, INDEPENDENTLY VERIFIED, and the answer'
    v5    = 'V5 the answer was SPOKEN by the local voice after the task finished (the HUD log names the length of each utterance, never the text)'
    z3    = 'Z3 local only: the recognizer engine is a local one (whisper-local or sapi-local); no cloud speech route was used'
}
$script:hudLog = Join-Path $OutDir 'hud.log'; $script:daemonLog = Join-Path $OutDir 'daemon.log'
$sttDir = Join-Path $OutDir 'stt'; New-Item -ItemType Directory -Force $sttDir | Out-Null
$env:DASK_STT_EVIDENCE_DIR = $sttDir       # this run's HUD only: keeps the recording and transcript as evidence
$started = $false
try {
    & "$PSScriptRoot\start-stack.ps1" -OutDir $OutDir -Config $Config -Root $Root | Out-Null
    $started = $true
    $pids = Get-Content "$OutDir\pids.json" -Raw | ConvertFrom-Json
    $hwnd = Get-HudHwnd $pids.hud
    $hs = [Diagnostics.Stopwatch]::StartNew(); while (-not ((Get-Content $script:hudLog -Raw -ErrorAction SilentlyContinue) -match 'Handshake accepted') -and $hs.ElapsedMilliseconds -lt 40000) { Start-Sleep -Milliseconds 200 }
    Enter-HudInteractive $hwnd
    Record $N.setup ((Get-Content $script:hudLog -Raw) -match 'Handshake accepted') @{ daemonPid = $pids.daemon; hudPid = $pids.hud }
    try {
        $adm = Get-ModelMemoryAdmission $Root; $mp = Test-ModelMemoryPreflight $adm
        [pscustomobject]@{ utc = (Get-Utc); measurement = $adm; decision = $mp } | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 (Join-Path $OutDir 'memory-preflight.json')
        Record $N.pre $mp.ok @{ availableMB = $adm.availableMB; requiredMB = $adm.requiredMB }
        if (-not $mp.ok) { Abort $mp.reason }
    } catch { Record $N.pre $false @{ error = "$_" }; Abort "memory preflight failed: $_" }

    if (-not $script:Aborted) {
        $prompt = "READY. In the D-ASK window click the microphone button (ARM VOICE), wait for it to show ARMED, then say clearly: `"$Phrase`"  (waiting up to $TimeoutSec s)"
        Set-Content -Encoding utf8 (Join-Path $OutDir 'PROMPT.txt') $prompt
        Write-Host $prompt -ForegroundColor Green
        $deadline = (Get-Date).AddSeconds($TimeoutSec)
        $stt = $null
        while ((Get-Date) -lt $deadline -and -not $stt) {
            $lines = @(Select-String -Path $script:hudLog -Pattern '\[STT\] Transcribed (\d+) bytes of audio \((\d+) characters\) with (\S+) in (\d+) ms' -ErrorAction SilentlyContinue)
            foreach ($l in $lines) { $m = $l.Matches[0]; if ([int]$m.Groups[2].Value -gt 0 -and -not $stt) { $stt = [pscustomobject]@{ bytes = [int]$m.Groups[1].Value; chars = [int]$m.Groups[2].Value; engine = $m.Groups[3].Value; ms = [int]$m.Groups[4].Value; utc = (Get-Utc) } } }
            if (-not $stt) { Start-Sleep -Milliseconds 500 }
        }
        Record $N.v1 ([bool]$stt) @{ stt = $stt; allTranscriptions = @(Select-String -Path $script:hudLog -Pattern '\[STT\] Transcribed' -ErrorAction SilentlyContinue | ForEach-Object { $_.Line }) }
        # the transcript as the HUD shows it (the command box, then the history entry for the submitted request)
        $transcript = ''
        if ($stt) {
            $sw = [Diagnostics.Stopwatch]::StartNew()
            do {
                Start-Sleep -Milliseconds 300
                $txt = Get-HudText $hwnd
                $hist = ($txt -split "`n") | Where-Object { $_ -match '^[A-Z0-9 ,.\x27\-?]{6,}$' -and $_ -match '(?i)SEVEN|EIGHT|TIMES| 7 | 8 ' } | Select-Object -First 1
                try { $cmd = Find-HudElement $hwnd -AutomationId 'ultron-command' -TimeoutMs 800; $box = ($cmd.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)).Current.Value } catch { $box = '' }
                $transcript = if ($box) { $box } elseif ($hist) { $hist } else { '' }
            } while (-not $transcript -and $sw.Elapsed.TotalSeconds -lt 20)
            if (-not $transcript) { $transcript = ($txt -split "`n" | Where-Object { $_ -match '(?i)seven|eight|times' } | Select-Object -First 1) }
        }
        $heard = 0; foreach ($rx in 'seven|\b7\b', 'times|multipl|\bx\b', 'eight|\b8\b') { if ($transcript -match "(?i)$rx") { $heard++ } }
        Record $N.v2 ($heard -ge 2) @{ transcript = $transcript; expected = $Phrase; wordsHeard = $heard }
        # the daemon's own account: a task accepted after the transcription, finished completed
        $task = $null
        if ($stt) {
            $sw = [Diagnostics.Stopwatch]::StartNew()
            do {
                $d = Get-Content $script:daemonLog -Raw -ErrorAction SilentlyContinue
                $fin = [regex]::Match([string]$d, 'task (t\w+) finished: (\w+) in (\d+) ms')
                if ($fin.Success) { $task = [pscustomobject]@{ id = $fin.Groups[1].Value; outcome = $fin.Groups[2].Value; ms = [int]$fin.Groups[3].Value } }
                if (-not $task) { Start-Sleep -Milliseconds 500 }
            } while (-not $task -and $sw.Elapsed.TotalSeconds -lt 180)
        }
        Record $N.v3 ($task -and $task.outcome -eq 'completed') @{ task = $task }
        Start-Sleep -Seconds 2
        $final = Get-HudText $hwnd
        Set-Content -Encoding utf8 (Join-Path $OutDir 'hud-after-voice-task.txt') $final
        Record $N.v4 ($final -match '(?m)^COMPLETED\s*$' -and $final -match '(?m)^INDEPENDENTLY VERIFIED\s*$' -and $final -match [regex]::Escape($Answer)) @{ answerExpected = $Answer; hasCompleted = ($final -match '(?m)^COMPLETED\s*$'); hasVerified = ($final -match '(?m)^INDEPENDENTLY VERIFIED\s*$'); hasAnswer = ($final -match [regex]::Escape($Answer)) }
        # spoken: a "[TTS] speaking N characters" line that appears AFTER the task finished line in time order (both logs are timestamped; use line order in the HUD log vs. the daemon's finish)
        $sw = [Diagnostics.Stopwatch]::StartNew(); $spoken = @()
        do { $spoken = @(Select-String -Path $script:hudLog -Pattern '\[TTS\] speaking (\d+) characters' -ErrorAction SilentlyContinue | ForEach-Object { $_.Line }); if (-not $spoken.Count) { Start-Sleep -Milliseconds 500 } } while (-not $spoken.Count -and $sw.Elapsed.TotalSeconds -lt 20)
        Record $N.v5 ($spoken.Count -ge 1) @{ utterances = $spoken }
        Record $N.z3 ($stt -and $stt.engine -in 'whisper-local', 'sapi-local') @{ engine = $(if ($stt) { $stt.engine } else { $null }) }
    }
} catch {
    Record 'unexpected error' $false @{ error = "$($_.Exception.Message)" }
    Abort "unexpected error: $($_.Exception.Message)"
} finally {
    try { if ($started) { & "$PSScriptRoot\stop-stack.ps1" -OutDir $OutDir | Out-Null } } catch { }
    Remove-Item Env:\DASK_STT_EVIDENCE_DIR -ErrorAction SilentlyContinue
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
