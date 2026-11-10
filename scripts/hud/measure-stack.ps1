# Measures the complete desktop stack while real tasks run from the real HUD: daemon, HUD, WebView2, agent host and
# llama-server. Everything in the output is measured here. Starts and stops only its own processes.
param(
    [string]$OutDir,
    [string]$ModelId,
    [string]$Config = 'Debug',
    [string]$Root,
    [int]$IdleSeconds = 15
)
$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = (Resolve-Path "$PSScriptRoot\..\..").Path }
. "$PSScriptRoot\hud-driver.ps1"
New-Item -ItemType Directory -Force $OutDir | Out-Null
$MiB = 1024 * 1024

function Get-FreeMB { [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1024) }

function Get-StackSample($DaemonPid, $HudPid) {
    $all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, WorkingSetSize, CommandLine
    $kids = @{}
    foreach ($p in $all) { $k = [int]$p.ParentProcessId; if (-not $kids.ContainsKey($k)) { $kids[$k] = New-Object System.Collections.ArrayList }; [void]$kids[$k].Add($p) }
    $tree = New-Object System.Collections.ArrayList
    $stack = New-Object System.Collections.Stack
    $stack.Push([int]$HudPid)
    while ($stack.Count) { foreach ($c in @($kids[[int]$stack.Pop()])) { if ($c) { [void]$tree.Add($c); $stack.Push([int]$c.ProcessId) } } }
    $web = ($tree | Where-Object { $_.Name -like 'msedgewebview2*' } | Measure-Object WorkingSetSize -Sum).Sum
    $hud = ($all | Where-Object ProcessId -eq $HudPid).WorkingSetSize
    $dm = ($all | Where-Object ProcessId -eq $DaemonPid).WorkingSetSize
    $h = @($all | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'stdioHost' })
    $l = @($all | Where-Object Name -eq 'llama-server.exe')
    $s = [pscustomobject]@{
        freeMB = Get-FreeMB
        daemonMB = [math]::Round($dm / $MiB); hudMB = [math]::Round($hud / $MiB); webviewMB = [math]::Round($web / $MiB)
        hostMB = [math]::Round((($h | Measure-Object WorkingSetSize -Sum).Sum) / $MiB)
        llamaMB = [math]::Round((($l | Measure-Object WorkingSetSize -Sum).Sum) / $MiB)
        llamaCount = $l.Count
    }
    $s | Add-Member totalMB ($s.daemonMB + $s.hudMB + $s.webviewMB + $s.hostMB + $s.llamaMB)
    return $s
}

function Get-LlamaGpuSharedMB {
    $p = Get-Process -Name 'llama-server' -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $p) { return $null }
    try {
        $c = Get-Counter "\GPU Process Memory(pid_$($p.Id)_*)\Shared Usage" -ErrorAction Stop
        return [math]::Round((($c.CounterSamples | Measure-Object CookedValue -Sum).Sum) / $MiB)
    } catch { return $null }
}

$before = Get-FreeMB
$stackArgs = @{ OutDir = $OutDir; Config = $Config; Root = $Root }
if ($ModelId) { $stackArgs.ModelId = $ModelId }
& "$PSScriptRoot\start-stack.ps1" @stackArgs | Out-Null
try {
    $pids = Get-Content "$OutDir\pids.json" -Raw | ConvertFrom-Json
    $hwnd = Get-HudHwnd $pids.hud
    Enter-HudInteractive $hwnd
    Start-Sleep -Seconds $IdleSeconds
    $idle = Get-StackSample $pids.daemon $pids.hud

    $samples = New-Object System.Collections.ArrayList
    $tasks = New-Object System.Collections.ArrayList
    $gpu = @()
    $requests = 'What is (17+25)*2?', 'What is 144/12?', 'What is 91*3?', 'What is 7*8?'
    foreach ($req in $requests) {
        $sw = [Diagnostics.Stopwatch]::StartNew()
        Submit-HudRequest $hwnd $req
        Start-Sleep -Milliseconds 300
        $outcome = $null
        do {
            [void]$samples.Add((Get-StackSample $pids.daemon $pids.hud))
            $g = Get-LlamaGpuSharedMB
            if ($null -ne $g) { $gpu += $g }
            $outcome = Get-HudOutcome $hwnd
            Start-Sleep -Milliseconds 200
        } while (-not $outcome -and $sw.ElapsedMilliseconds -lt 240000)
        $text = Get-HudText $hwnd
        [void]$tasks.Add([pscustomobject]@{
            request = $req; outcome = $outcome; ms = $sw.ElapsedMilliseconds
            verified = ($text -match '(?m)^INDEPENDENTLY VERIFIED$')
            memoryRefused = ($text -match 'memory|headroom')
        })
        Start-Sleep -Seconds 2
    }
    Save-HudShot $hwnd "$OutDir\final.png"
    $loaded = Get-StackSample $pids.daemon $pids.hud
    $withModel = @($samples | Where-Object llamaCount -gt 0)
    $report = [pscustomobject]@{
        at = (Get-Date).ToString('o'); model = $(if ($ModelId) { $ModelId } else { 'default' }); config = $Config
        freeBeforeStackMB = $before
        idle = $idle
        afterTasks = $loaded
        peakTotalMB = ($samples | Measure-Object totalMB -Maximum).Maximum
        peakLlamaMB = ($samples | Measure-Object llamaMB -Maximum).Maximum
        lowestFreeMB = ($samples | Measure-Object freeMB -Minimum).Minimum
        maxLlamaProcesses = ($samples | Measure-Object llamaCount -Maximum).Maximum
        llamaGpuSharedPeakMB = $(if ($gpu.Count) { ($gpu | Measure-Object -Maximum).Maximum } else { $null })
        sampleCount = $samples.Count
        samplesWithModel = $withModel.Count
        tasks = $tasks
        resourceAlerts = @(Select-String -Path "$OutDir\daemon.log" -Pattern 'Resource Alert|ResourceAlert|Critical').Count
        modelRefusals = @(Select-String -Path "$OutDir\daemon.log" -Pattern 'insufficient|refus.*memory|memory.*refus|headroom' ).Count
    }
    $report | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 "$OutDir\memory.json"
    $report | ConvertTo-Json -Depth 5
} finally {
    & "$PSScriptRoot\stop-stack.ps1" -OutDir $OutDir
}
