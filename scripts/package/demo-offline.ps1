# OFFLINE demonstration on the PACKAGED D-ASK, through the real HUD. Meant to be run by scripts\hud\offline-package-acceptance.ps1 (Wi-Fi off, process-tree
# network monitor), but it also checks for itself that the machine has no internet before it starts.
#   local inference + a verified tool answer ("What is seven times eight?"), the local model's own answer, persistent memory (remember, recall, forget),
#   a saved reusable workflow that is then run (two steps, each an ordinary verified request), and (optionally) opening Notepad and typing into it.
# -PackageRoot is a throwaway copy of a built package.
param([Parameter(Mandatory = $true)][string]$PackageRoot, [Parameter(Mandatory = $true)][string]$OutDir, [switch]$IncludeNotepad)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\..\hud\hud-driver.ps1"
. "$PSScriptRoot\demo-common.ps1"
if ((Test-Path $OutDir) -and @(Get-ChildItem $OutDir -Force).Count -gt 0) { throw "OutDir must be new or empty: $OutDir" }
New-Item -ItemType Directory -Force $OutDir | Out-Null
$script:OutDir = (Resolve-Path $OutDir).Path
$script:PackageRoot = (Resolve-Path $PackageRoot).Path
$script:results = New-Object System.Collections.ArrayList
# Isolated stores: nothing here may touch the user's real memory or workflows.
$memDb = Join-Path $script:OutDir 'memory.db'; $wfStore = Join-Path $script:OutDir 'workflows.json'
$env:DASK_AgentHost__ExtraEnvironment__DASK_MEMORY_DB = $memDb
$env:DASK_AgentHost__WorkflowStorePath = $wfStore
function Online-Now {
    $a = [bool](Test-NetConnection 1.1.1.1 -Port 443 -WarningAction SilentlyContinue).TcpTestSucceeded
    $b = $false; try { [void][Net.Dns]::GetHostAddresses('example.com'); $b = $true } catch { }
    return ($a -or $b)
}
function Db-Has([string]$Needle) {
    # Read with FileShare.ReadWrite (never an exclusive read), and only ever called with the packaged app STOPPED (Stop-Packaged), so the files are complete.
    $hit = $false
    foreach ($f in @($memDb, "$memDb-wal")) {
        if (-not (Test-Path -LiteralPath $f)) { continue }
        $fs = [IO.File]::Open($f, 'Open', 'Read', 'ReadWrite')
        try { $ms = New-Object IO.MemoryStream; $fs.CopyTo($ms); if ([Text.Encoding]::UTF8.GetString($ms.ToArray()).Contains($Needle)) { $hit = $true } } finally { $fs.Dispose() }
    }
    return $hit
}
try {
    $avail = [int]((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1024)
    $on = Online-Now
    Record 'there is NO internet connectivity (no route to 1.1.1.1:443, no DNS)' (-not $on) @{ online = $on; availableMB = $avail }
    if ($on) { throw 'the machine is online; this demonstration is only valid offline' }
    Start-Packaged
    Record 'the packaged app started from its own launcher (HUD, daemon, agent host and the local model are all local)' ([bool](Find-Proc 'DAsk.Daemon.exe')) @{ package = $script:PackageRoot }

    $a = Invoke-DemoRequest 'What is seven times eight?' @() 'math'
    Record 'LOCAL INFERENCE + tool: "What is seven times eight?" -> COMPLETED, INDEPENDENTLY VERIFIED, 56' (($a.outcome -eq 'COMPLETED') -and $a.verified -and ($a.text -match '56')) @{ outcome = $a.outcome; verified = $a.verified; ms = $a.ms }
    $b = Invoke-DemoRequest 'What is the capital of France?' @() 'answer'
    Record 'LOCAL MODEL answer: "What is the capital of France?" -> ANSWERED, labelled as the local model''s own answer, NOT independently verified, Paris' (($b.outcome -eq 'ANSWERED') -and $b.answeredLabel -and -not $b.verified -and ($b.text -match 'Paris')) @{ outcome = $b.outcome; label = $b.answeredLabel; ms = $b.ms }

    $m1 = Invoke-DemoRequest 'Remember that my favourite editor is Neovim.' @() 'mem1'
    Stop-Packaged; Start-Sleep -Seconds 4     # the packaged app is stopped BEFORE the database is read
    $held = Db-Has 'Neovim'
    Record 'MEMORY: remember -> COMPLETED, and (app stopped, file read) the isolated database holds it' (($m1.outcome -eq 'COMPLETED') -and (Test-Path $memDb) -and $held) @{ outcome = $m1.outcome; neovimInDb = $held }
    Start-Packaged                            # a fresh start of the packaged app on the same database: persistence across a restart
    Record 'the packaged app restarted from its own launcher (offline)' ([bool](Find-Proc 'DAsk.Daemon.exe')) @{}
    $m2 = Invoke-DemoRequest 'What is my favourite editor?' @() 'mem2'
    Record 'MEMORY: recall after the restart -> COMPLETED, answers from the saved memory (Neovim)' (($m2.outcome -eq 'COMPLETED') -and ($m2.text -match 'Neovim')) @{ outcome = $m2.outcome }
    $m3 = Invoke-DemoRequest 'Forget my favourite editor.' @() 'mem3'
    Stop-Packaged; Start-Sleep -Seconds 4
    $gone = -not (Db-Has 'Neovim')
    Record 'MEMORY: forget -> COMPLETED, and (app stopped, file read) the text is gone from the database and its log' (($m3.outcome -eq 'COMPLETED') -and $gone) @{ outcome = $m3.outcome; neovimBytesInDb = (-not $gone) }
    Start-Packaged
    Record 'the packaged app restarted from its own launcher (offline), for the workflow' ([bool](Find-Proc 'DAsk.Daemon.exe')) @{}

    $w1 = Invoke-DemoRequest 'Save a workflow called "morning check": What is 6*7?; then What is 2+3?' @() 'wf-save'
    $stored = if (Test-Path $wfStore) { Get-Content $wfStore -Raw } else { '' }
    Record 'WORKFLOW: saved (two steps, no approval needed: it only stores text); the workflow store file holds it' (($w1.outcome -eq 'COMPLETED') -and ($stored -match 'morning check') -and ($stored -match '6\*7')) @{ outcome = $w1.outcome }
    $w2 = Invoke-DemoRequest 'Run the workflow "morning check"' @() 'wf-run' 300000
    Record 'WORKFLOW: run -> both steps executed in order and verified (42 and 5 shown)' (($w2.outcome -eq 'COMPLETED') -and ($w2.text -match '6\*7 = 42') -and ($w2.text -match '2\+3 = 5')) @{ outcome = $w2.outcome; ms = $w2.ms }

    if ($IncludeNotepad) {
        $n = Invoke-DemoRequest 'Open Notepad and type HELLO' @('Open Notepad', 'Type (this text|exactly)') 'notepad' 240000
        Record 'NATIVE CONTROL: open Notepad and type HELLO (two approvals) -> COMPLETED, INDEPENDENTLY VERIFIED' (($n.outcome -eq 'COMPLETED') -and $n.verified) @{ outcome = $n.outcome }
        Desktop-Shot "$script:OutDir\desktop-notepad.png"
        Get-Process notepad -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
    }
    $still = Online-Now
    Record 'still no internet at the end of the demonstration' (-not $still) @{ online = $still }
} catch {
    Record 'unexpected error' $false @{ error = "$($_.Exception.Message)" }
    try { Desktop-Shot "$script:OutDir\desktop-error.png"; Save-HudShot $script:hwnd "$script:OutDir\hud-error.png"; Set-Content -Encoding utf8 "$script:OutDir\hud-error.txt" (Get-HudText $script:hwnd) } catch { }
} finally {
    Stop-Packaged
    $failed = Save-DemoResults 'demo-offline'
    if ($failed) { exit 1 }
}
