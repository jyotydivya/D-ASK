# One INTERACTIVE spoken acceptance step, enforced end to end (dot-source; used by approval-live-voice-chain.ps1).
#
# Repair of results/offline-voice-chain/20261113T214254 (3/6). The old harness only Write-Host'ed its prompts (captured
# into a variable by offline-voice-chain-acceptance.ps1 and into a file by run-offline-acceptance-7b3.ps1, so NOBODY saw
# them), never asked for acknowledgement, never armed the microphone, and took the FIRST new transcription of any text as
# the step's utterance: "can you hear me", "what is 25 multiplied by 4" and "tell me a joke" became S1-S3.
#
# Now every step is:
#   1 a VISIBLE, top-most window shows the exact utterance        (not the console: it may be redirected; a log is not a prompt)
#   2 the person explicitly acknowledges it (button) or cancels   (the click is the evidence the prompt was seen)
#   3 the harness makes sure the microphone is OFF, then arms the real HUD microphone (ARM VOICE)
#   4 it waits for the HUD to show ARMED                           (not armed -> nothing is opened; retry or cancel)
#   5 it opens the HUD voice gate for THIS step (fresh nonce) and shows "SPEAK NOW"
#   6 the HUD holds the FIRST recording transcribed after the opening (one per opening) and reports it with its WAV hash
#   7 the transcript is from the LOCAL recognizer (whisper-local / sapi-local), the recording is new (unseen WAV hash, held
#     after the opening, this step's nonce)
#   8 it is compared with the expected utterance (normalised, otherwise exact)
#   9 a mismatch is REJECTED: the HUD gives the page an empty transcript, nothing is submitted; the person may retry
#  10/11 only a matching transcript is released; the HUD forwards to the daemon ONLY that exact text (voice_gate.rs)
# The caller then waits for that task and verifies its result independently, and moves on only if the step passed.
# Tests: scripts\hud\voice-step-gate.tests.ps1 (fake operations, no HUD; plus the real file protocol against a fake HUD).

$script:LocalEngines = @('whisper-local', 'sapi-local')
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding $false

function Get-TextSha256([string]$Text) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return (($sha.ComputeHash($script:Utf8NoBom.GetBytes($Text)) | ForEach-Object { $_.ToString('x2') }) -join '') } finally { $sha.Dispose() }
}

# --------------------------------------------------------------------------------------------------------------------
# Transcript comparison. Normalisation removes only what a recognizer legitimately varies (case, punctuation, digits vs
# number words, "what's", how D-ASK is spelled); the remaining words must then be IDENTICAL. No fuzzy threshold.
# --------------------------------------------------------------------------------------------------------------------
$script:NumberWords = @('zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
    'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen')
$script:TensWords = @{ 2 = 'twenty'; 3 = 'thirty'; 4 = 'forty'; 5 = 'fifty'; 6 = 'sixty'; 7 = 'seventy'; 8 = 'eighty'; 9 = 'ninety' }
function ConvertTo-NumberWords([int]$N) {
    if ($N -lt 20) { return $script:NumberWords[$N] }
    $t = $script:TensWords[[int][math]::Floor($N / 10)]
    if ($N % 10) { return "$t $($script:NumberWords[$N % 10])" } else { return $t }
}
function ConvertTo-UtteranceKey([string]$Text) {
    if ($null -eq $Text) { return '' }
    $s = $Text.ToLowerInvariant()
    $s = $s -replace "[$([char]0x2018)$([char]0x2019)$([char]0x02BC)]", "'"
    $s = $s -replace "\bwhat's\b", 'what is' -replace "\bwhen's\b", 'when is' -replace "\bit's\b", 'it is'
    $s = $s -replace "(?<=\d)\s*[x$([char]0x00D7)*]\s*(?=\d)", ' times '
    $s = $s -replace '\bd\s*[-.]?\s*a\s*\.?\s*s\s*\.?\s*k\b', 'dask' -replace '\bde\s*-?\s*ask(?:ed)?\b', 'dask'   # deask, de-ask, de ask (Whisper, run 20261113T225616); de-asked, de asked (run 20261113T232906)
    $s = $s -replace "[^a-z0-9 ]", ' '
    $s = [regex]::Replace($s, '\b\d{1,2}\b', { param($m) ConvertTo-NumberWords ([int]$m.Value) })
    return (($s -split '\s+') | Where-Object { $_ }) -join ' '
}
function Test-UtteranceMatch([string]$Expected, [string]$Transcript) {
    $e = ConvertTo-UtteranceKey $Expected; $t = ConvertTo-UtteranceKey $Transcript
    return [pscustomobject]@{ match = ($e.Length -gt 0 -and $e -ceq $t); expectedKey = $e; transcriptKey = $t }
}

# A held recording may be used for a step only if it was made for THIS opening, after it, from audio never seen before in
# this run, by a local recognizer. Returns $null when acceptable, otherwise the reason.
function Get-HeldRecordProblem($Held, [string]$Nonce, [datetime]$OpenedUtc, [hashtable]$SeenWav, [hashtable]$SeenStem) {
    if (-not $Held) { return 'no held record' }
    if ("$($Held.nonce)" -ne $Nonce) { return "held for another step (nonce $($Held.nonce))" }
    if (-not $Held.stem -or -not $Held.wavSha256) { return 'held record without recording identity' }
    if ($SeenStem.ContainsKey("$($Held.stem)")) { return "recording $($Held.stem) was already used" }
    if ($SeenWav.ContainsKey("$($Held.wavSha256)")) { return "stale audio: the same recording (sha256 $("$($Held.wavSha256)".Substring(0, 12))) was already used in this run" }
    $heldUtc = [datetime]::MinValue
    if (-not [datetime]::TryParse("$($Held.utc)", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$heldUtc)) { return 'held record without a time' }
    if ($heldUtc -lt $OpenedUtc.AddMilliseconds(-5)) { return "stale: transcribed at $($Held.utc), before the step opened at $($OpenedUtc.ToString('o'))" }
    $startUtc = [datetime]::MinValue
    if (-not [datetime]::TryParse("$($Held.recordingStartedUtc)", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$startUtc)) { return 'held record without the recording start time' }
    if ($startUtc -lt $OpenedUtc.AddMilliseconds(-250)) { return "stale: the recording began at $($Held.recordingStartedUtc), before the step opened at $($OpenedUtc.ToString('o'))" }
    if ("$($Held.engine)" -notin $script:LocalEngines) { return "not a local recognizer: $($Held.engine)" }
    if ((Get-TextSha256 "$($Held.transcript)") -ne "$($Held.transcriptSha256)") { return 'transcript hash mismatch in the held record' }
    return $null
}

# --------------------------------------------------------------------------------------------------------------------
# The step. Every side effect goes through $Ops (scriptblocks) so the order and the refusals are testable without a HUD:
#   ShowPrompt(step, expected, attempt) -> @{ choice = 'ack'|'cancel'; shownUtc; ackUtc; visible }
#   MicIsArmed() -> bool     Arm()     Disarm()     WaitArmed() -> bool
#   OpenGate(step, nonce, expected) -> [datetime] openedUtc     CloseGate()
#   ShowSpeakNow(step, expected)     HideSpeakNow()
#   WaitHeld(nonce, openedUtc) -> held record | 'cancel' | $null (nothing recorded in time)
#   WriteVerdict(held, release, reason)     WaitReleased(held) -> bool
#   AskRetry(step, reason, heard, expected) -> 'retry'|'cancel'     Log(message)
# Returns @{ status = 'released'|'cancelled'|'failed'; transcript; held; attempts }. Nothing is released unless it matched.
# --------------------------------------------------------------------------------------------------------------------
function Invoke-VoiceStep([string]$Step, [string]$Expected, [hashtable]$Ops, [hashtable]$SeenWav, [hashtable]$SeenStem, [int]$MaxAttempts = 5) {
    $attempts = New-Object System.Collections.Generic.List[object]
    $finish = { param($status, $why, $held) [pscustomobject]@{ step = $Step; expected = $Expected; status = $status; reason = $why; transcript = $(if ($held) { "$($held.transcript)" }); held = $held; attempts = $attempts.ToArray() } }
    for ($n = 1; $n -le $MaxAttempts; $n++) {
        $a = [ordered]@{ attempt = $n; prompt = $null; armed = $null; nonce = $null; openedUtc = $null; held = $null; verdict = $null; problem = $null }
        $attempts.Add($a)
        $p = & $Ops.ShowPrompt $Step $Expected $n
        $a.prompt = $p
        & $Ops.Log "[$Step] attempt $n prompt: choice=$($p.choice) visible=$($p.visible) shown=$($p.shownUtc) ack=$($p.ackUtc)"
        if ($p.choice -ne 'ack' -or -not $p.visible) { $a.problem = $(if ($p.visible) { 'cancelled at the prompt' } else { 'the prompt could not be shown' }); return (& $finish 'cancelled' $a.problem $null) }

        # Nothing heard before the acknowledgement can be used: the microphone is switched off first (the gate is closed anyway).
        if (& $Ops.MicIsArmed) { & $Ops.Log "[$Step] microphone was armed before this step; disarming first"; & $Ops.Disarm }
        & $Ops.Arm
        $a.armed = [bool](& $Ops.WaitArmed)
        if (-not $a.armed) {
            & $Ops.Disarm; & $Ops.CloseGate
            $a.problem = 'the HUD did not confirm that the microphone is armed'
            & $Ops.Log "[$Step] attempt ${n}: $($a.problem)"
            if ((& $Ops.AskRetry $Step $a.problem $null $Expected) -eq 'retry') { continue } else { return (& $finish 'cancelled' $a.problem $null) }
        }
        $a.nonce = [guid]::NewGuid().ToString('N')
        $opened = & $Ops.OpenGate $Step $a.nonce $Expected
        $a.openedUtc = $opened.ToString('o')
        & $Ops.ShowSpeakNow $Step $Expected
        $held = $null
        try { $held = & $Ops.WaitHeld $a.nonce $opened } finally { & $Ops.HideSpeakNow; & $Ops.Disarm; & $Ops.CloseGate }
        if ("$held" -eq 'cancel') { $a.problem = 'cancelled while waiting for speech'; return (& $finish 'cancelled' $a.problem $null) }
        if (-not $held) {
            $a.problem = 'no speech was recorded in time'
            if ((& $Ops.AskRetry $Step $a.problem $null $Expected) -eq 'retry') { continue } else { return (& $finish 'cancelled' $a.problem $null) }
        }
        $a.held = $held
        $problem = Get-HeldRecordProblem $held $a.nonce $opened $SeenWav $SeenStem
        if ($held.stem) { $SeenStem["$($held.stem)"] = $Step }
        if ($held.wavSha256) { $SeenWav["$($held.wavSha256)"] = $Step }
        if (-not $problem) {
            $m = Test-UtteranceMatch $Expected "$($held.transcript)"
            if (-not $m.match) { $problem = "transcript does not match: heard `"$($held.transcript)`"" }
        }
        if ($problem) {
            & $Ops.WriteVerdict $held $false $problem   # the HUD gives the page "" and never forwards it
            $a.verdict = 'rejected'; $a.problem = $problem
            & $Ops.Log "[$Step] attempt ${n} REJECTED (not submitted): $problem"
            if ((& $Ops.AskRetry $Step $problem "$($held.transcript)" $Expected) -eq 'retry') { continue } else { return (& $finish 'cancelled' $problem $null) }
        }
        & $Ops.WriteVerdict $held $true 'matches the expected utterance'
        $a.verdict = 'released'
        if (-not (& $Ops.WaitReleased $held)) { $a.problem = 'the HUD did not confirm the release'; return (& $finish 'failed' $a.problem $held) }
        & $Ops.Log "[$Step] attempt ${n} RELEASED: `"$($held.transcript)`" (recording $($held.stem), wav sha256 $("$($held.wavSha256)".Substring(0, 12)))"
        return (& $finish 'released' $null $held)
    }
    return (& $finish 'failed' "no matching utterance in $MaxAttempts attempts" $null)
}

# --------------------------------------------------------------------------------------------------------------------
# Real operations: gate files (shared with src/hud-native/src/voice_gate.rs), the HUD microphone, visible windows.
# --------------------------------------------------------------------------------------------------------------------
function Write-GateJson([string]$Path, $Object) {
    $tmp = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
    [IO.File]::WriteAllText($tmp, ($Object | ConvertTo-Json -Depth 6 -Compress), $script:Utf8NoBom)   # no BOM: serde_json
    Move-Item -LiteralPath $tmp -Destination $Path -Force
}
function Read-GateJson([string]$Path) {
    try { return ([IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF) | ConvertFrom-Json) } catch { return $null }
}
# (Plain scriptblocks reading $script:VoiceGateCfg, not GetNewClosure(): a closure runs in its own module and would not see
# this file's functions.)
function New-GateFileOps([string]$GateDir, [int]$SpeakTimeoutSec = 120, [int]$ReleaseTimeoutSec = 15, [scriptblock]$Pump = { }, [scriptblock]$Cancelled = { $false }) {
    $script:VoiceGateCfg = @{ dir = $GateDir; speak = $SpeakTimeoutSec; release = $ReleaseTimeoutSec; pump = $Pump; cancelled = $Cancelled }
    return @{
        OpenGate = { param($step, $nonce, $expected) $t = (Get-Date).ToUniversalTime(); Write-GateJson (Join-Path $script:VoiceGateCfg.dir 'open.json') ([ordered]@{ step = $step; nonce = $nonce; expected = $expected; openedUtc = $t.ToString('o') }); $t }
        CloseGate = { Remove-Item -LiteralPath (Join-Path $script:VoiceGateCfg.dir 'open.json') -Force -ErrorAction SilentlyContinue }
        WaitHeld = {
            param($nonce, $openedUtc)
            $c = $script:VoiceGateCfg
            $sw = [Diagnostics.Stopwatch]::StartNew()
            while ($sw.Elapsed.TotalSeconds -lt $c.speak) {
                & $c.pump
                if (& $c.cancelled) { return 'cancel' }
                foreach ($f in @(Get-ChildItem -LiteralPath $c.dir -Filter '*.held.json' -ErrorAction SilentlyContinue)) {
                    $h = Read-GateJson $f.FullName
                    if ($h -and "$($h.nonce)" -eq $nonce) { return $h }
                }
                Start-Sleep -Milliseconds 150
            }
            return $null
        }
        WriteVerdict = { param($held, [bool]$release, $reason) Write-GateJson (Join-Path $script:VoiceGateCfg.dir "$($held.stem).verdict.json") ([ordered]@{ stem = "$($held.stem)"; nonce = "$($held.nonce)"; transcriptSha256 = "$($held.transcriptSha256)"; release = $release; reason = "$reason"; utc = (Get-Date).ToUniversalTime().ToString('o') }) }
        WaitReleased = {
            param($held)
            $c = $script:VoiceGateCfg
            $sw = [Diagnostics.Stopwatch]::StartNew()
            while ($sw.Elapsed.TotalSeconds -lt $c.release) {
                if (Test-Path -LiteralPath (Join-Path $c.dir "$($held.stem).released.json")) { return $true }
                if (Test-Path -LiteralPath (Join-Path $c.dir "$($held.stem).withheld.json")) { return $false }
                Start-Sleep -Milliseconds 100
            }
            return $false
        }
    }
}

# Visible windows (WinForms, top-most). They work even when the console output is redirected to a file.
function Test-CanShowWindows { return [Environment]::UserInteractive -and ((Get-Process -Id $PID).SessionId -ne 0) }
function Initialize-VoiceUi { Add-Type -AssemblyName System.Windows.Forms, System.Drawing; [System.Windows.Forms.Application]::EnableVisualStyles() }
function New-VoiceForm([string]$Title, [string]$Headline, [string]$Utterance, [string]$Note, [string[]]$Buttons) {
    $f = New-Object System.Windows.Forms.Form
    $f.Text = $Title; $f.TopMost = $true; $f.StartPosition = 'CenterScreen'; $f.FormBorderStyle = 'FixedDialog'
    $f.MinimizeBox = $false; $f.MaximizeBox = $false; $f.ClientSize = New-Object System.Drawing.Size 760, 330; $f.ShowInTaskbar = $true
    $y = 16
    foreach ($part in @(@($Headline, 13, 'Bold', 'Black'), @($Utterance, 18, 'Bold', 'DarkBlue'), @($Note, 10, 'Regular', 'DimGray'))) {
        if (-not $part[0]) { continue }
        $l = New-Object System.Windows.Forms.Label
        $l.Text = $part[0]; $l.Font = New-Object System.Drawing.Font('Segoe UI', [single]$part[1], [System.Drawing.FontStyle]$part[2])
        $l.ForeColor = [System.Drawing.Color]::FromName($part[3]); $l.Location = New-Object System.Drawing.Point 18, $y
        $l.MaximumSize = New-Object System.Drawing.Size 724, 0; $l.AutoSize = $true
        $f.Controls.Add($l); $y += $l.PreferredHeight + 14
    }
    $x = 760 - 18
    for ($i = $Buttons.Count - 1; $i -ge 0; $i--) {
        $b = New-Object System.Windows.Forms.Button
        $b.Text = $Buttons[$i]; $b.Font = New-Object System.Drawing.Font('Segoe UI', 11); $b.AutoSize = $true; $b.Height = 40
        $b.Tag = $i; $b.Add_Click({ param($s, $e) $s.FindForm().Tag = $s.Tag; $s.FindForm().Close() })
        $w = [Math]::Max(150, $b.PreferredSize.Width + 20); $b.Width = $w; $x -= $w
        $b.Location = New-Object System.Drawing.Point $x, 270; $f.Controls.Add($b); $x -= 12
    }
    $f.Tag = -1
    return $f
}
function Show-VoiceChoice([string]$Title, [string]$Headline, [string]$Utterance, [string]$Note, [string[]]$Buttons) {
    $f = New-VoiceForm $Title $Headline $Utterance $Note $Buttons
    $shown = $null; $visible = $false
    $f.Add_Shown({ param($s, $e) $script:__voiceShown = (Get-Date).ToUniversalTime(); $script:__voiceVisible = $s.Visible; $s.Activate() })
    $script:__voiceShown = $null; $script:__voiceVisible = $false
    [void]$f.ShowDialog()
    $shown = $script:__voiceShown; $visible = [bool]$script:__voiceVisible
    $choice = [int]$f.Tag; $f.Dispose()
    return [pscustomobject]@{ index = $choice; shownUtc = $(if ($shown) { $shown.ToString('o') }); ackUtc = (Get-Date).ToUniversalTime().ToString('o'); visible = $visible }
}
