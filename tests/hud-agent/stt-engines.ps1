# Offline STT engine comparison (no network, no microphone): the same 16 kHz mono WAVs through the HUD's real
# transcription path (src/hud-native/src/stt.rs `transcribe`) with whisper.cpp (installed + verified) and with the
# Windows SAPI recognizer (DASK_STT_ENGINE=sapi). Each utterance must return >= 70 % of its words.
#   powershell -ExecutionPolicy Bypass -File tests\hud-agent\stt-engines.ps1 [-OutDir results\voice-local\engines-<stamp>] [-WavDir <dir with utterance-N.wav>]
# Without -WavDir, the local SAPI voice synthesises the utterances first (as stt-roundtrip.ps1 does).
param([string]$OutDir, [string]$WavDir)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
if (-not $OutDir) { $OutDir = Join-Path $root ("results\voice-local\engines-" + (Get-Date).ToString('yyyyMMddTHHmmss')) }
New-Item -ItemType Directory -Force $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path   # cargo runs in src\hud-native: the fixture paths must be absolute
if ($WavDir) { $WavDir = (Resolve-Path $WavDir).Path }
$sentences = @(
    'open the notes window and type hello',
    'what is the weather like today',
    'remember that my sister lives in pune'
)
$wavs = @()
for ($i = 1; $i -le $sentences.Count; $i++) {
    $wav = Join-Path $OutDir "utterance-$i.wav"
    if ($WavDir) { Copy-Item (Join-Path $WavDir "utterance-$i.wav") $wav }
    else {
        Add-Type -AssemblyName System.Speech
        $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
        $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
        $synth.SetOutputToWaveFile($wav, $fmt); $synth.Speak($sentences[$i - 1]); $synth.Dispose()
    }
    $wavs += $wav
}
$results = @()
foreach ($engine in 'whisper-local', 'sapi-local') {
    for ($i = 0; $i -lt $sentences.Count; $i++) {
        $env:DASK_STT_FIXTURE = $wavs[$i]; $env:DASK_STT_EXPECT = $sentences[$i]; $env:DASK_STT_ROOT = $root; $env:DASK_STT_EXPECT_ENGINE = $engine
        if ($engine -eq 'sapi-local') { $env:DASK_STT_ENGINE = 'sapi' } else { Remove-Item Env:\DASK_STT_ENGINE -ErrorAction SilentlyContinue }
        Push-Location (Join-Path $root 'src\hud-native')
        $ErrorActionPreference = 'Continue'
        $out = & cargo test --quiet --offline real_engine_transcribes_a_local_fixture -- --ignored --nocapture 2>&1 | Out-String
        $code = $LASTEXITCODE
        $ErrorActionPreference = 'Stop'
        Pop-Location
        $t = [regex]::Match($out, 'TRANSCRIPT \[(\d+) ms\] \[([^\]]+)\]: (.*)')
        $results += [pscustomobject]@{ engine = $engine; expected = $sentences[$i]; transcript = $(if ($t.Success) { $t.Groups[3].Value.Trim() } else { $null })
            answeredBy = $(if ($t.Success) { $t.Groups[2].Value } else { $null }); ms = $(if ($t.Success) { [int]$t.Groups[1].Value } else { $null }); pass = ($code -eq 0) }
    }
}
Remove-Item Env:\DASK_STT_FIXTURE, Env:\DASK_STT_EXPECT, Env:\DASK_STT_ROOT, Env:\DASK_STT_EXPECT_ENGINE, Env:\DASK_STT_ENGINE -ErrorAction SilentlyContinue
$results | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $OutDir 'stt-engines.json')
$results | Format-Table -AutoSize | Out-String -Width 220 | Write-Host
$passed = @($results | Where-Object pass).Count
Write-Host "$passed / $($results.Count) passed. Evidence: $OutDir"
if ($passed -ne $results.Count) { exit 1 }
