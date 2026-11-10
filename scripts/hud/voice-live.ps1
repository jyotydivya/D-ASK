# Real voice through the REAL HUD with a PERSON speaking: starts the real stack, makes the HUD interactive, and records,
# for each utterance the HUD transcribes, the engine (whisper-local / sapi-local), its time, and the transcript as the
# HUD shows it in the command box (read through UI Automation). The person clicks the microphone button and speaks.
# The HUD submits the transcript as a request (as in normal use); nothing here clicks or types for the person.
#   powershell -ExecutionPolicy Bypass -File scripts\hud\voice-live.ps1 -OutDir results\voice-local\hud-<stamp> [-Count 3] [-TimeoutSec 420]
param([Parameter(Mandatory = $true)][string]$OutDir, [int]$Count = 3, [int]$TimeoutSec = 420, [string]$Config = 'Debug')
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path "$PSScriptRoot\..\..").Path
if ((Test-Path $OutDir) -and @(Get-ChildItem $OutDir -Force).Count -gt 0) { throw "OutDir must be new or empty: $OutDir" }
New-Item -ItemType Directory -Force $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path
. "$PSScriptRoot\hud-driver.ps1"
$hudLog = Join-Path $OutDir 'hud.log'
$records = @()
$sttDir = Join-Path $OutDir 'stt'
New-Item -ItemType Directory -Force $sttDir | Out-Null
$env:DASK_STT_EVIDENCE_DIR = $sttDir   # this run's HUD only: keep recordings + transcripts as evidence
try {
    & "$PSScriptRoot\start-stack.ps1" -OutDir $OutDir -Config $Config -Root $Root | Out-Null
    $pids = Get-Content "$OutDir\pids.json" -Raw | ConvertFrom-Json
    $hwnd = Get-HudHwnd $pids.hud
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while (-not ((Get-Content $hudLog -Raw -ErrorAction SilentlyContinue) -match 'Handshake accepted') -and $sw.Elapsed.TotalSeconds -lt 30) { Start-Sleep -Milliseconds 200 }
    Enter-HudInteractive $hwnd
    Write-Host "READY: click the microphone button in the HUD and speak. Waiting for $Count utterance(s), up to $TimeoutSec s." -ForegroundColor Green
    $seen = 0; $lastValue = ''
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $cmd = $null
    $nonEmpty = 0
    while ($nonEmpty -lt $Count -and (Get-Date) -lt $deadline) {
        try { if (-not $cmd) { $cmd = Find-HudElement $hwnd -AutomationId 'ultron-command' -TimeoutMs 2000 } } catch { $cmd = $null }
        $value = ''
        try { if ($cmd) { $value = ($cmd.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)).Current.Value } } catch { $cmd = $null }
        if ($value -and $value -ne $lastValue -and $value -ne 'Processing audio...') { $lastValue = $value; $records += [pscustomobject]@{ utc = (Get-Date).ToUniversalTime().ToString('o'); kind = 'commandBox'; text = $value } }
        $lines = @(Select-String -Path $hudLog -Pattern '\[STT\] Transcribed (\d+) bytes of audio \((\d+) characters\) with (\S+) in (\d+) ms' -ErrorAction SilentlyContinue)
        while ($seen -lt $lines.Count) {
            $m = $lines[$seen].Matches[0]
            $records += [pscustomobject]@{ utc = (Get-Date).ToUniversalTime().ToString('o'); kind = 'stt'; bytes = [int]$m.Groups[1].Value; chars = [int]$m.Groups[2].Value; engine = $m.Groups[3].Value; ms = [int]$m.Groups[4].Value }
            $seen++; if ([int]$m.Groups[2].Value -gt 0) { $nonEmpty++ }
            Write-Host ("utterance {0}: {1} in {2} ms ({3} characters)" -f $seen, $m.Groups[3].Value, $m.Groups[4].Value, $m.Groups[2].Value)
        }
        Start-Sleep -Milliseconds 100
    }
    Start-Sleep -Seconds 2
    try { $value = ($cmd.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)).Current.Value; if ($value -and $value -ne $lastValue) { $records += [pscustomobject]@{ utc = (Get-Date).ToUniversalTime().ToString('o'); kind = 'commandBox'; text = $value } } } catch { }
    try { Get-HudText $hwnd | Set-Content -Encoding utf8 (Join-Path $OutDir 'hud-text-end.txt') } catch { }
    $failures = @(Select-String -Path $hudLog -Pattern '\[STT\] (Transcription failed|whisper failed|whisper not available)' -ErrorAction SilentlyContinue | ForEach-Object { $_.Line })
    $records | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 (Join-Path $OutDir 'voice-records.json')
    $failures | Set-Content -Encoding utf8 (Join-Path $OutDir 'stt-failures.txt')
    $records | Format-Table -AutoSize | Out-String -Width 220 | Write-Host
    Get-ChildItem $sttDir -Filter *.txt | Sort-Object Name | ForEach-Object { $records += [pscustomobject]@{ kind = 'transcript'; file = $_.BaseName; text = (Get-Content $_.FullName -Raw).Trim() } }
    $records | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 (Join-Path $OutDir 'voice-records.json')
    $records | Where-Object kind -eq 'transcript' | Format-Table -AutoSize | Out-String -Width 220 | Write-Host
    Write-Host "non-empty $nonEmpty / $Count; recordings $seen; failures logged: $($failures.Count). Evidence: $OutDir"
} finally {
    try { & "$PSScriptRoot\stop-stack.ps1" -OutDir $OutDir | Out-Null } catch { }
    Remove-Item Env:\DASK_STT_EVIDENCE_DIR -ErrorAction SilentlyContinue
}
