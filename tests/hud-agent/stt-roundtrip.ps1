# Offline STT round trip (no network, no microphone): the local SAPI voice speaks a sentence into a 16 kHz mono 16-bit
# WAV; the HUD's SAPI recognizer (src/hud-native/src/stt.rs) transcribes it; at least 70 % of the words must come back.
#   powershell -ExecutionPolicy Bypass -File tests\hud-agent\stt-roundtrip.ps1 [-OutDir results\voice-local\stt-<stamp>]
param([string]$OutDir)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
if (-not $OutDir) { $OutDir = Join-Path $root ("results\voice-local\stt-" + (Get-Date).ToString('yyyyMMddTHHmmss')) }
New-Item -ItemType Directory -Force $OutDir | Out-Null
Add-Type -AssemblyName System.Speech
$sentences = @(
    'open the notes window and type hello',
    'what is the weather like today',
    'remember that my sister lives in pune'
)
$results = @()
$i = 0
foreach ($s in $sentences) {
    $i++
    $wav = Join-Path $OutDir "utterance-$i.wav"
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
    $synth.SetOutputToWaveFile($wav, $fmt)
    $synth.Speak($s)
    $synth.Dispose()
    $env:DASK_STT_FIXTURE = $wav
    $env:DASK_STT_EXPECT = $s
    Push-Location (Join-Path $root 'src\hud-native')
    $ErrorActionPreference = 'Continue'
    $out = & cargo test --quiet real_sapi_transcribes_a_local_fixture -- --ignored --nocapture 2>&1 | Out-String
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    Pop-Location
    $t = [regex]::Match($out, 'TRANSCRIPT \[(\d+) ms\]: (.*)')
    $results += [pscustomobject]@{ expected = $s; transcript = $(if ($t.Success) { $t.Groups[2].Value.Trim() } else { $null }); ms = $(if ($t.Success) { [int]$t.Groups[1].Value } else { $null }); pass = ($code -eq 0) }
}
Remove-Item Env:\DASK_STT_FIXTURE, Env:\DASK_STT_EXPECT -ErrorAction SilentlyContinue
$results | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $OutDir 'stt-roundtrip.json')
$results | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
$passed = @($results | Where-Object pass).Count
Write-Host "$passed / $($results.Count) utterances transcribed (>= 70 % of words). Evidence: $OutDir"
exit $(if ($passed -eq $results.Count) { 0 } else { 1 })
