# Regression tests for the interactive voice acceptance step (voice-step-gate.ps1) and its harness wiring
# (approval-live-voice-chain.ps1, offline-voice-chain-acceptance.ps1). Repair of results/offline-voice-chain/20261113T214254: the prompts were
# never shown, nobody acknowledged anything, and "can you hear me" / "what is 25 multiplied by 4" / "tell me a joke" became S1-S3.
# No HUD, no daemon, no microphone, no network: fake operations record their order; the gate file protocol runs against a fake HUD that
# behaves like src/hud-native/src/voice_gate.rs (whose own Rust tests cover the HUD side: cargo test --bin hud-native voice_gate).
#   powershell -ExecutionPolicy Bypass -File scripts\hud\voice-step-gate.tests.ps1
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\voice-step-gate.ps1"
$script:pass = 0; $script:fail = 0
function Check([bool]$Cond, [string]$Name, $Detail) {
    if ($Cond) { $script:pass++; Write-Host "  PASS: $Name" } else { $script:fail++; Write-Host "  FAIL: $Name $(if ($null -ne $Detail) { '| ' + ($Detail | ConvertTo-Json -Compress -Depth 5) })" }
}
$S1 = 'What is seven times eight?'
$S2 = 'According to my research papers, when is the D-ASK evaluation deadline? Then remember it.'
$S3 = 'What do you remember about the evaluation deadline?'

# ---------------------------------------------------------------------------------------------------------------------------------
# Fake operations. $script:calls is the ordered log of side effects; scripts are queues of what the person / HUD does.
#   Prompts: 'ack' | 'cancel' | 'invisible'      Armed: $true | $false      Heard: @{ text; engine?; stale?; wav?; nonce?; cancel? } | $null
#   Retries: 'retry' | 'cancel'                  MicArmedAtStart: $true to simulate a microphone left armed
# ---------------------------------------------------------------------------------------------------------------------------------
function New-Fake([object[]]$Prompts, [object[]]$Armed = @($true), [object[]]$Heard = @(), [object[]]$Retries = @(), [bool]$MicArmedAtStart = $false) {
    $script:calls = New-Object System.Collections.Generic.List[string]
    $script:verdicts = New-Object System.Collections.Generic.List[object]
    $script:fq = @{ prompts = [System.Collections.Queue]::new([object[]]$Prompts); armed = [System.Collections.Queue]::new([object[]]$Armed)
        heard = [System.Collections.Queue]::new([object[]]$Heard); retries = [System.Collections.Queue]::new([object[]]$Retries); mic = $MicArmedAtStart; open = $null; n = 0 }
    return @{
        ShowPrompt = { param($s, $e, $a) $c = $script:fq.prompts.Dequeue(); $script:calls.Add("prompt:${s}:$e"); [pscustomobject]@{ choice = $(if ($c -eq 'invisible') { 'ack' } else { $c }); visible = ($c -ne 'invisible'); shownUtc = 'x'; ackUtc = 'y' } }
        MicIsArmed = { $script:fq.mic }
        Arm = { $script:calls.Add('arm'); $script:fq.mic = $true }
        Disarm = { if ($script:fq.mic) { $script:calls.Add('disarm') }; $script:fq.mic = $false }
        WaitArmed = { $ok = $(if ($script:fq.armed.Count) { [bool]$script:fq.armed.Dequeue() } else { $true }); $script:calls.Add("armed:$ok"); if (-not $ok) { $script:fq.mic = $false }; $ok }
        OpenGate = { param($s, $nonce, $e) $script:calls.Add("open:$s"); $script:fq.open = $nonce; (Get-Date).ToUniversalTime() }
        CloseGate = { if ($script:fq.open) { $script:calls.Add('close') }; $script:fq.open = $null }
        ShowSpeakNow = { param($s, $e) $script:calls.Add('speak-now') }
        HideSpeakNow = { }
        WaitHeld = {
            param($nonce, $opened)
            $h = $script:fq.heard.Dequeue()
            if ($null -eq $h) { $script:calls.Add('held:none'); return $null }
            if ($h.cancel) { $script:calls.Add('held:cancel'); return 'cancel' }
            if (-not $script:fq.mic) { throw 'a recording was held while the microphone was off' }
            $script:fq.n++
            $t = "$($h.text)"
            $rec = [pscustomobject]@{ stem = $(if ($h.stem) { $h.stem } else { "utt-$($script:fq.n)" }); step = 'x'; nonce = $(if ($h.nonce) { $h.nonce } else { $nonce })
                transcript = $t; transcriptSha256 = (Get-TextSha256 $t); engine = $(if ($h.engine) { $h.engine } else { 'whisper-local' })
                wavBytes = 1000; wavSha256 = $(if ($h.wav) { $h.wav } else { "wav$($script:fq.n)" + ('0' * 20) })
                utc = $(if ($h.stale) { $opened.AddSeconds(-30).ToString('o') } else { $opened.AddSeconds(2).ToString('o') })
                recordingStartedUtc = $(if ($h.early) { $opened.AddSeconds(-2).ToString('o') } elseif ($h.stale) { $opened.AddSeconds(-33).ToString('o') } else { $opened.AddSeconds(0.5).ToString('o') }) }
            $script:calls.Add("held:$t")
            $rec
        }
        WriteVerdict = { param($held, $release, $reason) $script:calls.Add("verdict:$release"); $script:verdicts.Add([pscustomobject]@{ stem = $held.stem; transcript = $held.transcript; release = $release; reason = $reason }) }
        WaitReleased = { param($held) $true }
        AskRetry = { param($s, $reason, $heard, $e) $c = $script:fq.retries.Dequeue(); $script:calls.Add("ask-retry:$c"); $c }
        Log = { param($m) }
    }
}
function Run([string]$Expected, $Ops, [hashtable]$SeenWav = @{}, [hashtable]$SeenStem = @{}, [int]$Max = 5) { Invoke-VoiceStep 's' $Expected $Ops $SeenWav $SeenStem $Max }
function Released { , @($script:verdicts | Where-Object { $_.release }) }   # always an array (PS 5.1: a lone PSCustomObject has no .Count)

Write-Host "`n[R] the observed failure, replayed"
$ops = New-Fake -Prompts @('ack', 'ack', 'ack', 'cancel') -Heard @(@{ text = 'can you hear me' }, @{ text = 'what is 25 multiplied by 4' }, @{ text = 'tell me a joke' }) -Retries @('retry', 'retry', 'retry')
$r = Run $S1 $ops
Check ($r.status -eq 'cancelled' -and (Released).Count -eq 0) 'R1 the three unrelated utterances of 20261113T214254 are all rejected for S1; none is released for submission' $script:calls
Check (@($script:verdicts | Where-Object { -not $_.release }).Count -eq 3 -and ($script:calls -join ',') -match 'held:can you hear me,disarm,close,verdict:False') 'R2 each one got an explicit REJECT verdict after the microphone was switched off'

Write-Host "`n[P] visible prompt and explicit acknowledgement"
$ops = New-Fake -Prompts @('ack') -Heard @(@{ text = 'What is seven times eight?' })
$r = Run $S1 $ops
Check ($script:calls[0] -eq "prompt:s:$S1") 'P1 the first action of a step is the prompt, with the EXACT expected utterance' $script:calls[0]
Check ($r.status -eq 'released' -and $r.attempts[0].prompt.visible -and $r.attempts[0].prompt.ackUtc) 'P2 the step records that the prompt was visible and when it was acknowledged'
$ops = New-Fake -Prompts @('invisible')
$r = Run $S1 $ops
Check ($r.status -eq 'cancelled' -and $script:calls -notcontains 'arm' -and -not ($script:calls -match '^open')) 'P3 a prompt that could not be shown (only logged) is NOT treated as presented: no arming, no gate' $script:calls

Write-Host "`n[A] no microphone recording before acknowledgement"
$ops = New-Fake -Prompts @('cancel')
$r = Run $S1 $ops
Check ($r.status -eq 'cancelled' -and ($script:calls -join ',') -eq "prompt:s:$S1") 'A1 cancel at the prompt: the microphone is never armed and the gate never opened' $script:calls
$ops = New-Fake -Prompts @('ack') -Heard @(@{ text = $S1 })
[void](Run $S1 $ops)
$i = [Collections.Generic.List[string]]$script:calls
Check ($i.IndexOf("prompt:s:$S1") -lt $i.IndexOf('arm') -and $i.IndexOf('arm') -lt $i.IndexOf('armed:True') -and $i.IndexOf('armed:True') -lt $i.IndexOf('open:s') -and $i.IndexOf('open:s') -lt $i.IndexOf('speak-now')) 'A2 order: prompt -> acknowledgement -> arm -> HUD ARMED -> gate opened -> SPEAK NOW' $script:calls
$ops = New-Fake -Prompts @('ack') -Heard @(@{ text = $S1 }) -MicArmedAtStart $true
[void](Run $S1 $ops)
Check (($script:calls -join ',') -match "^prompt:s:[^,]+,disarm,arm,") 'A3 a microphone left armed before the step is switched OFF after the acknowledgement and re-armed for this step only' $script:calls
Check ($script:calls[-1] -eq 'verdict:True' -and ($script:calls -join ',') -match 'held:[^,]+,disarm,close,verdict') 'A4 after the recording: microphone off and gate closed BEFORE the verdict' $script:calls

Write-Host "`n[F] fresh recording for every step; no stale audio or transcript reuse"
$seenW = @{}; $seenS = @{}
$ops = New-Fake -Prompts @('ack') -Heard @(@{ text = $S1; wav = 'aaaa111122223333aaaa' })
$r1 = Run $S1 $ops $seenW $seenS
$ops = New-Fake -Prompts @('ack', 'cancel') -Heard @(@{ text = $S2; wav = 'aaaa111122223333aaaa'; stem = 'utt-b' }) -Retries @('cancel')
$r2 = Run $S2 $ops $seenW $seenS
Check ($r1.status -eq 'released' -and $r2.status -eq 'cancelled' -and (Released).Count -eq 0 -and $r2.reason -match 'stale audio') 'F1 the same recording (same WAV hash) offered again for the next step is rejected as stale' $r2.reason
$ops = New-Fake -Prompts @('ack') -Heard @(@{ text = $S2; stem = 'utt-1' }) -Retries @('cancel')
$r = Run $S2 $ops @{} @{ 'utt-1' = 's1' }
Check ($r.status -eq 'cancelled' -and (Released).Count -eq 0 -and $r.reason -match 'already used') 'F2 a recording id already used by an earlier step is rejected' $r.reason
$ops = New-Fake -Prompts @('ack') -Heard @(@{ text = $S1; stale = $true }) -Retries @('cancel')
$r = Run $S1 $ops
Check ($r.status -eq 'cancelled' -and (Released).Count -eq 0 -and $r.reason -match '^stale: transcribed') 'F3 a transcript from before the step opened is rejected' $r.reason
$ops = New-Fake -Prompts @('ack') -Heard @(@{ text = $S1; early = $true }) -Retries @('cancel')
$r = Run $S1 $ops
Check ($r.status -eq 'cancelled' -and (Released).Count -eq 0 -and $r.reason -match 'recording began') 'F5 a recording that BEGAN before the step opened (transcribed after it) is rejected, even if the words match' $r.reason
$seenW = @{}; $seenS = @{}
$all = foreach ($p in @(@('s1', $S1), @('s2', $S2), @('s3', $S3))) { $o = New-Fake -Prompts @('ack') -Heard @(@{ text = $p[1] }); $script:fq.n = [array]::IndexOf(@('s1', 's2', 's3'), $p[0]) * 10; Invoke-VoiceStep $p[0] $p[1] $o $seenW $seenS 5 }
Check (@($all | Where-Object status -eq 'released').Count -eq 3 -and @($all | ForEach-Object { $_.held.wavSha256 } | Select-Object -Unique).Count -eq 3) 'F4 three steps, three distinct fresh recordings' @($all | ForEach-Object { $_.held.stem })

Write-Host "`n[C] transcript-to-step correlation"
$ops = New-Fake -Prompts @('ack') -Heard @(@{ text = $S1; nonce = 'nonce-of-another-step' }) -Retries @('cancel')
$r = Run $S1 $ops
Check ($r.status -eq 'cancelled' -and (Released).Count -eq 0 -and $r.reason -match 'another step') 'C1 a held transcript carrying another step''s nonce is rejected' $r.reason
$ops = New-Fake -Prompts @('ack') -Heard @(@{ text = $S1 })
$r = Run $S1 $ops
Check ($r.held.nonce -eq $r.attempts[0].nonce -and $r.transcript -eq $S1 -and (Released)[0].stem -eq $r.held.stem) 'C2 the released transcript is the one held under THIS step''s nonce, and the verdict names that recording'
$ops = New-Fake -Prompts @('ack') -Heard @(@{ text = $S3 }) -Retries @('cancel')
$r = Run $S2 $ops
Check ($r.status -eq 'cancelled' -and (Released).Count -eq 0) 'C3 a correct utterance for a DIFFERENT step (S3 spoken during S2) is rejected'

Write-Host "`n[M] mismatch rejection, retry, and no submission after a mismatch"
$ops = New-Fake -Prompts @('ack', 'ack') -Heard @(@{ text = 'What is seven times nine?' }, @{ text = "What's 7 x 8?" }) -Retries @('retry')
$r = Run $S1 $ops
Check ($r.status -eq 'released' -and $r.attempts.Count -eq 2 -and $r.attempts[0].verdict -eq 'rejected' -and $r.transcript -eq "What's 7 x 8?") 'M1 a near miss ("seven times NINE") is rejected; the retry is accepted' $script:calls
Check ((Released).Count -eq 1 -and (Released)[0].transcript -eq "What's 7 x 8?" -and ($script:calls -join ',') -match 'verdict:False,ask-retry:retry,prompt:') 'M2 exactly one release, for the matching transcript; the retry starts again from the visible prompt'
$ops = New-Fake -Prompts @('ack') -Heard @(@{ text = 'tell me a joke' }) -Retries @('cancel')
$r = Run $S1 $ops
Check ($r.status -eq 'cancelled' -and (Released).Count -eq 0 -and $script:calls -notcontains 'verdict:True') 'M3 mismatch then cancel: no release verdict is ever written, so nothing can be submitted' $script:calls
$ops = New-Fake -Prompts @('ack', 'ack') -Heard @(@{ text = 'nope' }, @{ text = 'still nope' }) -Retries @('retry', 'retry')
$r = Run $S1 $ops -Max 2
Check ($r.status -eq 'failed' -and (Released).Count -eq 0) 'M4 the attempt limit ends the step as FAILED, never as released'

Write-Host "`n[H] HUD not armed"
$ops = New-Fake -Prompts @('ack') -Armed @($false) -Retries @('cancel')
$r = Run $S1 $ops
Check ($r.status -eq 'cancelled' -and -not ($script:calls -match '^open') -and $script:calls -notcontains 'speak-now' -and $r.reason -match 'did not confirm') 'H1 no ARMED confirmation: the gate is never opened and the person is never told to speak' $script:calls
$ops = New-Fake -Prompts @('ack', 'ack') -Armed @($false, $true) -Heard @(@{ text = $S1 }) -Retries @('retry')
$r = Run $S1 $ops
Check ($r.status -eq 'released' -and $r.attempts[0].armed -eq $false -and $r.attempts[1].armed) 'H2 retry after a failed arming re-prompts, re-arms and then succeeds'

Write-Host "`n[X] user cancellation"
$ops = New-Fake -Prompts @('ack') -Heard @(@{ cancel = $true })
$r = Run $S1 $ops
Check ($r.status -eq 'cancelled' -and ($script:calls -join ',') -match 'held:cancel,disarm,close$' -and (Released).Count -eq 0) 'X1 cancel in the SPEAK NOW window: microphone off, gate closed, nothing released' $script:calls
$ops = New-Fake -Prompts @('ack') -Heard @($null) -Retries @('cancel')
$r = Run $S1 $ops
Check ($r.status -eq 'cancelled' -and $r.reason -match 'cancelled|no speech' -and ($script:calls -join ',') -match 'held:none,disarm,close,ask-retry:cancel') 'X2 no speech in time: microphone off, gate closed, then retry/cancel offered' $script:calls

Write-Host "`n[N] transcript comparison (normalised, otherwise exact)"
$ok = @(@($S1, 'what is seven times eight'), @($S1, "What's 7 times 8?"), @($S1, "What is 7 $([char]0x00D7) 8?"), @($S2, 'According to my research papers, when is the DASK evaluation deadline? Then remember it.'),
    @($S2, 'according to my research papers when is the d ask evaluation deadline then remember it'), @($S2, 'According to my research papers, when is the D.A.S.K. evaluation deadline? Then, remember it.'), @($S3, ' What do you remember about the evaluation deadline '),
    @($S2, 'According to my research papers, when is the de-ask evaluation deadline? Then remember it.'),   # the exact Whisper transcript of 20261113T225616
    @($S2, 'According to my research papers, when is the de ask evaluation deadline? Then remember it.'), @($S2, 'According to my research papers, when is the deask evaluation deadline? Then remember it.'),
    @($S2, 'According to my research papers, when is the D ASK evaluation deadline? Then remember it.'),
    @($S2, 'According to my research papers, when is the de-asked evaluation deadline? Then remember it.'),   # the exact Whisper transcript of 20261113T232906
    @($S2, 'According to my research papers, when is the de asked evaluation deadline? Then remember it.'))
$bad = @(@($S1, 'what is 25 multiplied by 4'), @($S1, 'can you hear me'), @($S1, 'what is seven times nine'), @($S1, 'what is seven times eight please'), @($S1, ''),
    @($S2, 'According to my research papers, when is the evaluation deadline? Then remember it.'), @($S2, 'evaluation deadline? Then remember it.'), @($S3, 'tell me a joke'),
    @($S2, 'According to my research papers, when is the de-ask evaluation deadline? Then remember it please.'),   # extra words
    @($S2, 'According to my research notes, when is the de-ask evaluation deadline? Then remember it.'),          # changed wording
    @($S2, 'According to my research papers, when is the de-ask evaluation deadline?'),                            # truncated
    @($S2, ''),                                                                                                    # empty
    @($S2, 'According to my research papers, when is the desk evaluation deadline? Then remember it.'),           # other tokens in place of D-ASK
    @($S2, 'According to my research papers, when is the task evaluation deadline? Then remember it.'),
    @($S2, 'According to my research papers, when is the the ask evaluation deadline? Then remember it.'),
    @($S2, 'According to my research papers, when is the de evaluation deadline? Then remember it.'),
    @($S2, 'According to my research papers, when is the made ask evaluation deadline? Then remember it.'),
    @($S2, 'According to my research papers, when is the D-ASH evaluation deadline? Then remember it.'),
    @($S2, 'According to my research papers, when is the de-asked evaluation deadline? Then remember it please.'),   # extra words, with the new variant
    @($S2, 'According to my research notes, when is the de-asked evaluation deadline? Then remember it.'),          # changed wording, with the new variant
    @($S2, 'According to my research papers, when is the de-asked evaluation deadline?'),                            # truncated, with the new variant
    @($S2, 'According to my research papers, when is the made asked evaluation deadline? Then remember it.'),
    @($S2, 'According to my research papers, when is the de-asking evaluation deadline? Then remember it.'),
    @($S2, 'According to my research papers, when is the de-askeds evaluation deadline? Then remember it.'))
Check (@($ok | Where-Object { -not (Test-UtteranceMatch $_[0] $_[1]).match }).Count -eq 0) 'N1 recognizer variations (case, punctuation, digits, "what''s", D-ASK spellings) match' @($ok | Where-Object { -not (Test-UtteranceMatch $_[0] $_[1]).match } | ForEach-Object { $_[1] })
Check (@($bad | Where-Object { (Test-UtteranceMatch $_[0] $_[1]).match }).Count -eq 0) 'N2 different words, extra words, missing words, empty, or a truncated sentence never match' @($bad | Where-Object { (Test-UtteranceMatch $_[0] $_[1]).match } | ForEach-Object { $_[1] })

Write-Host "`n[L] local-only transcription and offline operation"
$ops = New-Fake -Prompts @('ack') -Heard @(@{ text = $S1; engine = 'cloud-api' }) -Retries @('cancel')
$r = Run $S1 $ops
Check ($r.status -eq 'cancelled' -and (Released).Count -eq 0 -and $r.reason -match 'not a local recognizer') 'L1 a transcript from anything but whisper-local / sapi-local is rejected, even if it matches' $r.reason
$net = 'https?://|Invoke-WebRequest|Invoke-RestMethod|Net\.WebClient|HttpClient|TcpClient|reqwest|ureq|hyper::'
$files = @("$PSScriptRoot\voice-step-gate.ps1", "$PSScriptRoot\approval-live-voice-chain.ps1", "$PSScriptRoot\..\..\src\hud-native\src\voice_gate.rs", "$PSScriptRoot\..\..\lib\voiceCommand.ts")
$hits = @($files | ForEach-Object { Select-String -LiteralPath $_ -Pattern $net } | ForEach-Object { "$($_.Filename):$($_.LineNumber)" })
Check ($hits.Count -eq 0) 'L2 the step library, the chain harness, the HUD voice gate and the voice parser contain no network client or URL' $hits
$wrap = Get-Content -Raw "$PSScriptRoot\offline-voice-chain-acceptance.ps1"
Check ($wrap -match '\$before = Get-OfflineEvidence; \$d0 = Test-OfflineEvidence \$before' -and $wrap -match "if \(-not \`$d0\.offline\) \{[^\n]*exit 2 \}" -and $wrap -match '\$after = Get-OfflineEvidence; \$d1 = Test-OfflineEvidence \$after' -and
    $wrap -match 'Get-NetTCPConnection' -and $wrap -match '\$d0\.offline -and \$d1\.offline -and \$conn -eq 0') 'L3 the offline wrapper still refuses to run online, checks offline before AND after, and fails on any non-loopback connection'
$whisper = Get-Content -Raw "$PSScriptRoot\..\..\src\hud-native\src\stt.rs"
Check ($whisper -match '"whisper-local"' -and $whisper -match 'crate::whisper::locate') 'L4 the HUD''s local Whisper path is unchanged (stt.rs still answers whisper-local through whisper::locate)'

Write-Host "`n[W] harness wiring (the prompts can be seen; the gate is set up before speech)"
Check ($wrap -notmatch '\$log = & powershell[^\n]*2>&1\s*\r?\n' -and $wrap -match 'ForEach-Object \{ Write-Host "\$_"; \$_ \}') 'W1 the wrapper streams the harness output instead of buffering it until the end'
$chain = Get-Content -Raw "$PSScriptRoot\approval-live-voice-chain.ps1"
$pos = { param($p) $m = [regex]::Match($chain, $p); if ($m.Success) { $m.Index } else { -1 } }
Check ((& $pos 'Test-CanShowWindows\)\)') -gt 0 -and (& $pos 'Test-CanShowWindows\)\)') -lt (& $pos 'start-stack\.ps1"')) 'W2 the harness refuses to start if no window can be shown to a person'
Check ((& $pos 'DASK_VOICE_GATE_DIR = ') -lt (& $pos 'start-stack\.ps1"') -and (& $pos "'enforce'") -gt (& $pos 'Invoke-Request "Index') -and (& $pos "'enforce'") -lt (& $pos "Spoken 's1'")) 'W3 the HUD starts with the gate; it is enforced after the typed setup and before the first spoken step'
Check ($chain -notmatch 'Add-Content[^\n]*PROMPT\.txt' -and $chain -match 'Show-VoiceChoice') 'W4 prompts are windows the person must answer, not lines appended to a log'
Check ((& $pos "Abort `"S1 did not pass") -lt (& $pos "Spoken 's2'") -and (& $pos "Abort `"S2 did not pass") -lt (& $pos "Spoken 's3'")) 'W5 the next step starts only if the current one passed'

Write-Host "`n[G] gate file protocol against a fake HUD (same files and fields as voice_gate.rs)"
$g = Join-Path ([IO.Path]::GetTempPath()) "dask-voice-gate-ps-$([guid]::NewGuid().ToString('N'))"; New-Item -ItemType Directory $g | Out-Null
$fops = New-GateFileOps $g 10 5
$nonce = [guid]::NewGuid().ToString('N')
$opened = & $fops.OpenGate 's1' $nonce $S1
$raw = [IO.File]::ReadAllBytes((Join-Path $g 'open.json'))
$o = Read-GateJson (Join-Path $g 'open.json')
Check ($raw[0] -ne 0xEF -and $o.step -eq 's1' -and $o.nonce -eq $nonce -and $o.expected -eq $S1) 'G1 open.json: step, nonce, expected; UTF-8 without BOM (serde_json rejects a BOM)'
# Fake HUD: claims the opening (rename), writes the held record, waits for the verdict, writes released/withheld.
$hud = Start-Job -ArgumentList $g, $S1 -ScriptBlock {
    param($g, $text)
    $sw = [Diagnostics.Stopwatch]::StartNew(); while (-not (Test-Path "$g\open.json") -and $sw.ElapsedMilliseconds -lt 5000) { Start-Sleep -Milliseconds 50 }
    Move-Item "$g\open.json" "$g\utt-1.open.json"
    $o = Get-Content "$g\utt-1.open.json" -Raw | ConvertFrom-Json
    $sha = [System.Security.Cryptography.SHA256]::Create(); $h = (($sha.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($text)) | ForEach-Object { $_.ToString('x2') }) -join '')
    [IO.File]::WriteAllText("$g\utt-1.held.json", (@{ stem = 'utt-1'; step = $o.step; nonce = $o.nonce; transcript = $text; transcriptSha256 = $h; engine = 'whisper-local'; wavBytes = 5; wavSha256 = ('ab' * 32); utc = (Get-Date).ToUniversalTime().ToString('o'); recordingStartedUtc = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress))
    $sw.Restart(); while (-not (Test-Path "$g\utt-1.verdict.json") -and $sw.ElapsedMilliseconds -lt 8000) { Start-Sleep -Milliseconds 50 }
    $vb = [IO.File]::ReadAllBytes("$g\utt-1.verdict.json"); $v = [Text.Encoding]::UTF8.GetString($vb) | ConvertFrom-Json
    $ok = $vb[0] -ne 0xEF -and $v.stem -eq 'utt-1' -and $v.nonce -eq $o.nonce -and $v.transcriptSha256 -eq $h -and $v.release -eq $true
    Set-Content "$g\utt-1.$(if ($ok) { 'released' } else { 'withheld' }).json" '{}'
}
$held = & $fops.WaitHeld $nonce $opened
$problem = Get-HeldRecordProblem $held $nonce $opened @{} @{}
& $fops.WriteVerdict $held $true 'match'
$rel = & $fops.WaitReleased $held
Wait-Job $hud -Timeout 15 | Out-Null; Receive-Job $hud -ErrorAction SilentlyContinue | Out-Null; Remove-Job $hud -Force
Check ($held -and $held.nonce -eq $nonce -and -not $problem) 'G2 the harness finds the held record for its nonce and accepts it as fresh' $problem
Check ($rel -and (Test-Path (Join-Path $g 'utt-1.released.json'))) 'G3 verdict fields (stem, nonce, transcriptSha256, release) and encoding are what the HUD requires: released'
Check ((Get-TextSha256 'abc') -eq 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') 'G4 transcript hashes are SHA-256 of UTF-8, as the HUD computes them'
& $fops.CloseGate
Check (-not (Test-Path (Join-Path $g 'open.json'))) 'G5 closing the gate removes any open step'
Remove-Item -Recurse -Force $g

Write-Host "`n$($script:pass) passed, $($script:fail) failed"
if ($script:fail) { exit 1 }
