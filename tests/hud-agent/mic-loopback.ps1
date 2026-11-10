# REAL microphone capture without a person: the local SAPI voice speaks through the speakers while the default
# microphone records (Windows MCI, 16 kHz mono 16-bit), then both engines transcribe the recording through the HUD's real
# path (tests\hud-agent\stt-engines.ps1). Acoustic loopback, not a human voice: it proves the capture path and the
# engines on real room audio, not accuracy for a particular speaker. Plays audible speech. No network.
#   powershell -ExecutionPolicy Bypass -File tests\hud-agent\mic-loopback.ps1 [-OutDir results\voice-local\mic-<stamp>]
param([string]$OutDir)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
if (-not $OutDir) { $OutDir = Join-Path $root ("results\voice-local\mic-" + (Get-Date).ToString('yyyyMMddTHHmmss')) }
New-Item -ItemType Directory -Force $OutDir | Out-Null
$rec = Join-Path $OutDir 'recorded'
New-Item -ItemType Directory -Force $rec | Out-Null
Add-Type -Namespace DAsk -Name Mci -MemberDefinition @'
[DllImport("winmm.dll", CharSet = CharSet.Unicode)] public static extern int mciSendString(string cmd, System.Text.StringBuilder ret, int len, System.IntPtr cb);
[DllImport("winmm.dll")] public static extern uint waveInGetNumDevs();
'@
function Mci([string]$c) { $sb = New-Object Text.StringBuilder 256; $r = [DAsk.Mci]::mciSendString($c, $sb, 256, [IntPtr]::Zero); if ($r -ne 0) { throw "MCI '$c' failed: $r" }; $sb.ToString() }
if ([DAsk.Mci]::waveInGetNumDevs() -lt 1) { throw 'no microphone (waveIn device) present' }
Add-Type -AssemblyName System.Speech
$sentences = @('open the notes window and type hello', 'what is the weather like today', 'remember that my sister lives in pune')
for ($i = 1; $i -le $sentences.Count; $i++) {
    $file = Join-Path $rec "utterance-$i.wav"
    Mci 'open new type waveaudio alias dask_rec' | Out-Null
    try {
        Mci 'set dask_rec bitspersample 16 samplespersec 16000 channels 1 alignment 2 bytespersec 32000' | Out-Null
        Mci 'record dask_rec' | Out-Null
        Start-Sleep -Milliseconds 400
        $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
        $synth.Volume = 100; $synth.Rate = -1
        $synth.SetOutputToDefaultAudioDevice(); $synth.Speak($sentences[$i - 1]); $synth.Dispose()
        Start-Sleep -Milliseconds 600
        Mci 'stop dask_rec' | Out-Null
        Mci "save dask_rec `"$file`"" | Out-Null
    } finally { try { Mci 'close dask_rec' | Out-Null } catch { } }
    $bytes = [IO.File]::ReadAllBytes($file)
    $peak = 0; for ($k = 44; $k + 1 -lt $bytes.Length; $k += 2) { $v = [Math]::Abs([int][BitConverter]::ToInt16($bytes, $k)); if ($v -gt $peak) { $peak = $v } }
    Write-Host ("recorded utterance-{0}.wav: {1} bytes, peak {2} / 32767" -f $i, $bytes.Length, $peak)
}
& powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'stt-engines.ps1') -OutDir (Join-Path $OutDir 'engines') -WavDir $rec
exit $LASTEXITCODE
