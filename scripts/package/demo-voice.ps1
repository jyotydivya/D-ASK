# Real-MICROPHONE demonstration of the voice pipeline on the PACKAGED D-ASK. A PERSON speaks; nothing is typed or injected.
#   microphone -> local speech recognition (whisper.cpp or SAPI) -> local AI -> HUD result -> local text-to-speech
# For each question the script arms the microphone in the real HUD, prompts you (console text + a beep), waits for the transcript, waits for the
# task result, and then checks: the transcript, the outcome and verification label, and that the local voice spoke exactly the characters of the
# answer the HUD shows (the HUD log records the LENGTH of each utterance, never its text, by design).
# Run it yourself in a terminal (it must be able to ask you to speak):
#   powershell -ExecutionPolicy Bypass -File scripts\package\demo-voice.ps1 -PackageRoot <package copy> -OutDir results\packaging\voice-<stamp>
param([Parameter(Mandatory = $true)][string]$PackageRoot, [Parameter(Mandatory = $true)][string]$OutDir, [int]$SpeakTimeoutSec = 120, [ValidateSet('Q1', 'Q2')][string[]]$Questions = @('Q1', 'Q2'))
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\..\hud\hud-driver.ps1"
. "$PSScriptRoot\demo-common.ps1"
if ((Test-Path $OutDir) -and @(Get-ChildItem $OutDir -Force).Count -gt 0) { throw "OutDir must be new or empty: $OutDir" }
New-Item -ItemType Directory -Force $OutDir | Out-Null
$script:OutDir = (Resolve-Path $OutDir).Path
$script:PackageRoot = (Resolve-Path $PackageRoot).Path
$script:results = New-Object System.Collections.ArrayList
$env:DASK_AgentHost__ExtraEnvironment__DASK_MEMORY_DB = Join-Path $script:OutDir 'memory.db'
$sttDir = Join-Path $script:OutDir 'stt'; New-Item -ItemType Directory -Force $sttDir | Out-Null
$env:DASK_STT_EVIDENCE_DIR = $sttDir          # test-only knob (unset in normal use): keeps each recording and its transcript as evidence
$hudLog = Join-Path $env:LOCALAPPDATA 'D-ASK\hud.log'

function Log-Size { if (Test-Path $hudLog) { (Get-Item $hudLog).Length } else { 0 } }
function Log-Since([long]$Offset) {
    if (-not (Test-Path $hudLog)) { return '' }
    $fs = [IO.File]::Open($hudLog, 'Open', 'Read', 'ReadWrite')
    try { if ($Offset -gt $fs.Length) { $Offset = 0 }; [void]$fs.Seek($Offset, 'Begin'); $sr = New-Object IO.StreamReader($fs); return $sr.ReadToEnd() } finally { $fs.Dispose() }
}
function Spoken-Summary([string]$Text) {   # the same transformation the HUD applies before speaking (components/JarvisOrb.tsx spokenSummary)
    $t = $Text -replace '^Done\.\s*', ''; $t = $t -replace [char]0x2022, ''; $t = ($t -replace '\s+', ' ').Trim()
    if ($t.Length -gt 600) { $t = $t.Substring(0, 600) }
    # ... then the voice's own clean-up (lib/spokenText.ts toSpokenText): a multiplication sign between numbers is spoken as "times" (it used to be deleted:
    # "7*8 = 56" was spoken as "78 = 56"). The answers of this demonstration contain no other markdown.
    $t = $t -replace '(\d(?:[.,]\d+)*)\s*[*×]\s*(?=[\d(])', '$1 times '
    return ($t -replace '\s+', ' ').Trim()
}
function Result-Response([string]$HudText) {
    $m = [regex]::Match($HudText, '(?ms)^RESULT[^\n]*\n(?<outcome>[A-Z]+)\s*\n(?<rest>.*?)(?:\nEVENT LOG|\z)')
    if (-not $m.Success) { return $null }
    $lines = @($m.Groups['rest'].Value -split "`n" | ForEach-Object { $_.TrimEnd() })
    $lines = @($lines | Where-Object { $_ -ne 'INDEPENDENTLY VERIFIED' -and $_ -ne 'NOT INDEPENDENTLY VERIFIED' -and $_ -notmatch '^ANSWERED BY THE LOCAL MODEL' })
    return [pscustomobject]@{ outcome = $m.Groups['outcome'].Value; response = (($lines -join "`n").Trim()) }
}
function Ask-Aloud([string]$Tag, [string]$Say, [string[]]$Words, [string]$ExpectOutcome, [string]$ExpectInResponse) {
    Restore-HudFront
    $offset = Log-Size
    # The microphone listens continuously once armed and the button then reads "ARMED (V)"; clicking it again would DISARM. Click only when not armed.
    $already = $false; try { [void](Find-HudButton $script:hwnd '^ARMED' 1500); $already = $true } catch { }
    if (-not $already) {
        $btn = Find-HudButton $script:hwnd '^ARM VOICE'   # never the "VOICE ON (S)" speech toggle
        Confirm-HudForeground $script:hwnd | Out-Null
        Click-HudElement $script:hwnd $btn
    }
    $armed = $false; $sw = [Diagnostics.Stopwatch]::StartNew()
    while (-not $armed -and $sw.ElapsedMilliseconds -lt 15000) { if ((Get-HudText $script:hwnd) -match 'ARMED|LISTENING') { $armed = $true }; Start-Sleep -Milliseconds 200 }
    Record "$Tag the microphone was armed in the real HUD" $armed @{}
    [console]::Beep(880, 250)
    Write-Host "`n>>> SPEAK NOW, clearly, at normal volume:  `"$Say`"" -ForegroundColor Yellow
    $stt = $null; $sw = [Diagnostics.Stopwatch]::StartNew()
    while (-not $stt -and $sw.Elapsed.TotalSeconds -lt $SpeakTimeoutSec) {
        $m = [regex]::Match((Log-Since $offset), '\[STT\] Transcribed (\d+) bytes of audio \((\d+) characters\) with (\S+) in (\d+) ms')
        if ($m.Success -and [int]$m.Groups[2].Value -gt 0) { $stt = $m }
        Start-Sleep -Milliseconds 300
    }
    $utt = Get-ChildItem $sttDir -Filter 'utt-*.txt' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1
    $transcript = if ($utt) { ((Get-Content $utt.FullName -Raw) -split "`t", 2)[1].Trim() } else { $null }
    Record "$Tag a person spoke: the HUD sent the recording to the LOCAL recognizer and got a transcript" ([bool]$stt) @{ engine = $(if ($stt) { $stt.Groups[3].Value }); ms = $(if ($stt) { [int]$stt.Groups[4].Value }); transcript = $transcript }
    if (-not $stt) { return }
    $heard = @($Words | Where-Object { $transcript -match [regex]::Escape($_) }).Count
    Record "$Tag the transcript is the question that was asked (at least $([math]::Ceiling($Words.Count / 2)) of $($Words.Count) key words heard)" ($heard -ge [math]::Ceiling($Words.Count / 2)) @{ transcript = $transcript; heard = $heard }

    # The HUD submits the recognised text as an ordinary task; wait for ITS result (a result notification after this utterance).
    $sw = [Diagnostics.Stopwatch]::StartNew(); $done = $false
    while (-not $done -and $sw.ElapsedMilliseconds -lt 240000) { if ((Log-Since $offset) -match 'AgentTaskResultNotification') { $done = $true } else { Start-Sleep -Milliseconds 300 } }
    Start-Sleep -Milliseconds 2500   # the HUD draws the result, then speaks it
    $hudText = Get-HudText $script:hwnd
    Set-Content -Encoding utf8 "$script:OutDir\$Tag-hud.txt" $hudText; Save-HudShot $script:hwnd "$script:OutDir\$Tag-hud.png"
    $res = Result-Response $hudText
    $verified = ($hudText -match '(?m)^INDEPENDENTLY VERIFIED$'); $answered = ($hudText -match 'ANSWERED BY THE LOCAL MODEL')
    $ok = $res -and ($res.outcome -eq $ExpectOutcome) -and $(if ($ExpectOutcome -eq 'COMPLETED') { $verified } else { $answered -and -not $verified }) -and ($res.response -match $ExpectInResponse)
    Record "$Tag the spoken question produced $ExpectOutcome$(if ($ExpectOutcome -eq 'COMPLETED') { ' / INDEPENDENTLY VERIFIED' } else { ' / labelled as the local model''s own answer, NOT independently verified' }) with the expected answer" ([bool]$ok) @{ outcome = $res.outcome; verified = $verified; answeredLabel = $answered; response = $res.response }
    $tts = [regex]::Matches((Log-Since $offset), '\[TTS\] speaking (\d+) characters \(local SAPI\)') | ForEach-Object { [int]$_.Groups[1].Value }
    $expected = if ($res) { (Spoken-Summary $res.response).Length } else { -1 }
    Record "$Tag the LOCAL voice spoke the answer the HUD shows (utterance length = the HUD answer's spoken length)" (@($tts) -contains $expected) @{ spokenLengths = @($tts); expectedFromHud = $expected; spokenText = $(if ($res) { Spoken-Summary $res.response }) }
    # The HUD must not hear its own voice and run it as a command: wait for the speech (estimate + grace) and then a few seconds more, and
    # require exactly ONE person's transcript and ONE task in this question's slice of the log.
    $words = if ($res) { @((Spoken-Summary $res.response) -split '\s+').Count } else { 5 }
    Start-Sleep -Milliseconds (800 + $words * 450 + 1500 + 5000)
    $after = Log-Since $offset
    $heard = [regex]::Matches($after, '\[STT\] Transcribed \d+ bytes of audio \((?!0 )\d+ characters\)').Count
    $tasks = [regex]::Matches($after, 'AgentTaskSubmitResponse').Count
    Record "$Tag the HUD did not hear its own voice: exactly one transcript and one task for this question" (($heard -eq 1) -and ($tasks -eq 1)) @{ transcripts = $heard; tasks = $tasks }
}

try {
    $avail = [int]((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1024)
    Start-Packaged
    Record 'the packaged app started from its own launcher' ([bool](Find-Proc 'DAsk.Daemon.exe')) @{ availableMBBeforeStart = $avail }
    if ($Questions -contains 'Q1') { Ask-Aloud 'Q1' 'What is seven times eight?' @('seven', 'times', 'eight') 'COMPLETED' '56' }
    if ($Questions -contains 'Q2') { Ask-Aloud 'Q2' 'What is the capital of France?' @('capital', 'France') 'ANSWERED' 'Paris' }
} catch {
    Record 'unexpected error' $false @{ error = "$($_.Exception.Message)" }
    try { Desktop-Shot "$script:OutDir\desktop-error.png"; Set-Content -Encoding utf8 "$script:OutDir\hud-error.txt" (Get-HudText $script:hwnd) } catch { }
} finally {
    Stop-Packaged
    $failed = Save-DemoResults 'demo-voice'
    if ($failed) { exit 1 }
}
