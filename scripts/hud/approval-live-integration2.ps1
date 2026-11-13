# Real-HUD CROSS-FEATURE acceptance, round 2: file copy/rename/undo, Character Map, plugins (install, permission refusal, grant, plugin -> memory),
# history recovery after a FORCED kill, and (only with -Online) browser page -> note, web page -> knowledge, online research with a named URL.
# Every store is isolated inside -OutDir. The user's real stores are hashed before/after.
#   powershell -ExecutionPolicy Bypass -File scripts\hud\approval-live-integration2.ps1 -OutDir results\integration-hud\round2-<stamp> -Papers <pdfs> [-Online]
param([Parameter(Mandatory = $true)][string]$OutDir, [Parameter(Mandatory = $true)][string]$Papers, [string]$Root, [string]$Config = 'Debug', [switch]$Online)
$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = (Resolve-Path "$PSScriptRoot\..\..").Path }
if ((Test-Path $OutDir) -and @(Get-ChildItem $OutDir -Force).Count -gt 0) { throw "OutDir must be new or empty: $OutDir" }
New-Item -ItemType Directory -Force $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path
$keepOut = $OutDir; $keepRoot = $Root; $keepConfig = $Config; $keepPapers = (Resolve-Path $Papers).Path; $keepOnline = [bool]$Online
. "$PSScriptRoot\approval-live-7b3.ps1" -OutDir $keepOut -Root $keepRoot -Config $keepConfig -LoadFunctionsOnly
$OutDir = $keepOut; $Root = $keepRoot; $Config = $keepConfig; $Papers = $keepPapers; $IsOnline = $keepOnline
$ErrorActionPreference = 'Stop'
$p0Lines = Get-Content "$PSScriptRoot\approval-live-7b3.ps1"
$from = [Array]::FindIndex($p0Lines, [Predicate[string]] { param($l) $l -eq 'if ($LoadFunctionsOnly) { return }' })
if ($from -lt 0) { throw 'the P0 harness layout changed; refusing to guess which helpers to load' }
$to = [Array]::FindIndex($p0Lines, $from + 1, [Predicate[string]] { param($l) $l -match '^\S' -and $l -notmatch '^(function |\}|#|\$script:procNames = @\{\})' })
if ($to -le $from + 1) { throw 'the P0 helper region could not be delimited; refusing to run it' }
$helperText = ($p0Lines[($from + 1)..($to - 1)] -join "`r`n")
foreach ($fn in 'Invoke-Request', 'Invoke-GuardedClick', 'Wait-NewApproval', 'Confirm-Decision', 'Wait-NewResult', 'Wait-PanelClosed', 'Wait-Log') {
    if ($helperText -notmatch "(?m)^function $fn\b") { throw "the P0 helper region does not define $fn; refusing to run" }
}
. ([scriptblock]::Create($helperText))
Add-Type @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class YWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static List<long> Titled(string t) { var r = new List<long>(); EnumWindows((h, l) => { if (IsWindowVisible(h)) { var s = new StringBuilder(256); GetWindowText(h, s, 256); if (s.ToString() == t) r.Add((long)h); } return true; }, IntPtr.Zero); return r; }
}
"@

$N = [ordered]@{
    setup = 'Z1 setup: real HUD + daemon; files, plugins, notes, memory, app launch, knowledge and browser reading enabled; every store isolated inside OutDir'
    pre   = 'Z2 memory preflight (guard unchanged)'
    y1 = 'Y1 files: copy (card names source and destination; byte-identical copy), rename (card; renamed), "undo the last rename" (card; name restored)'
    y2 = 'Y2 "Open Character Map": card names Character Map (charmap.exe); a NEW Character Map window was confirmed; it was then closed'
    y3 = 'Y3 plugins: install (card), a files.read use is REFUSED until granted, grant (card), then "first lines of … and remember it" puts the plugin result into memory'
    y4 = 'Y4 history recovery: the HUD is KILLED while a task runs (the daemon then cancels it: a session''s tasks never outlive it); the whole stack is killed and restarted; the history entry shows the RECOVERED real outcome instead of "result unknown"'
}
if ($IsOnline) {
    $N['y5'] = 'Y5 ONLINE browser -> note: "Read https://example.com then save the page as a note called Example page" (card shows the page text; the note holds the URL)'
    $N['y6'] = 'Y6 ONLINE web -> knowledge: "Read https://example.org and add it to my knowledge" indexes that page into the web collection'
    $N['y7'] = 'Y7 ONLINE research with a named URL: the saved report cites the URL and says it is a web page the user named'
}
$N['log'] = 'L1 no knowledge/notes/memory/plugin/file errors in the daemon logs'
$N['end'] = 'Z3 end state: the user''s real stores are unchanged'
$script:ExpectedChecks = $N.Count

function Restore-HudFront {
    if ([HudInput]::GetForegroundWindow() -eq $script:hwnd) { return }
    if ((Get-HudMode $script:hwnd) -eq 'interactive') { Send-HudToggleHotkey; try { [void](Wait-HudMode $script:hwnd 'ambient' 3000) } catch { } }
    Enter-HudInteractive $script:hwnd
    Assert-HudForeground $script:hwnd
    Start-Sleep -Milliseconds 1200
    [void](Find-HudElement $script:hwnd -AutomationId 'ultron-command' -TimeoutMs 8000)
}
function Decide($Marks, $A, [bool]$Approve) {
    Restore-HudFront
    $click = Invoke-GuardedClick -Label $(if ($Approve) { 'APPROVE' } else { 'DENY' }) -ButtonPattern $(if ($Approve) { '^APPROVE$' } else { '^DENY$' }) -WaitEnabled
    if (-not $click.sent) { return [pscustomobject]@{ ok = $false; click = $click; decision = $null } }
    $d = Confirm-Decision $Marks $A.Id $Approve $click
    return [pscustomobject]@{ ok = ($d.evidence.state -eq 'confirmed'); click = $click; decision = $d }
}
function Next-Request([string]$Text) {
    if ((Wait-PanelClosed) -lt 0) { Abort 'the previous approval panel did not close'; return $null }
    Restore-HudFront
    return Invoke-Request $Text
}
function Plain([string]$Text, [string]$ResultPattern, [int]$TimeoutMs = 300000) {
    $s = Next-Request $Text
    if (-not $s -or -not $s.Ok) { return [pscustomobject]@{ ok = $false; outcome = $null; matched = $false; full = ''; detail = @{ submit = $(if ($s) { $s.Record } else { $null }) } } }
    $r = Wait-NewResult $s.Marks $ResultPattern $TimeoutMs 20000
    return [pscustomobject]@{ ok = $r.arrived; outcome = $r.outcome; matched = $r.matched; full = [string]$r.text; detail = @{ outcome = $r.outcome; matched = $r.matched; msToArrive = $r.msToArrive } }
}
function Carded([string]$Text, [string]$CardFile, [string[]]$Need, [string]$ResultPattern) {
    $s = Next-Request $Text
    if (-not $s -or -not $s.Ok) { return [pscustomobject]@{ ok = $false; full = ''; detail = @{ submit = $(if ($s) { $s.Record } else { $null }) } } }
    $a = Wait-NewApproval $s.Marks 300000
    if ($a.Found) { Save $CardFile $a.Text }
    $missing = if ($a.Found) { @($Need | Where-Object { -not (Contains-Text $a.Text $_) }) } else { $Need }
    if (-not $a.Found -or $missing.Count) { return [pscustomobject]@{ ok = $false; full = ''; detail = @{ found = $a.Found; reason = $a.Reason; missing = $missing } } }
    $d = Decide $s.Marks $a $true
    $r = Wait-NewResult $s.Marks $ResultPattern 240000 20000
    return [pscustomobject]@{ ok = $d.ok -and $r.arrived; outcome = $r.outcome; matched = $r.matched; full = [string]$r.text; detail = @{ decision = $d.ok; outcome = $r.outcome; matched = $r.matched } }
}
function Sha([string]$Path) { if (Test-Path -LiteralPath $Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLower() } else { $null } }
function DirState([string]$Path) { if (Test-Path -LiteralPath $Path) { @(Get-ChildItem -LiteralPath $Path -Recurse -File | ForEach-Object { "$($_.FullName)|$($_.Length)|$($_.LastWriteTimeUtc.Ticks)" }) -join "`n" } else { '<absent>' } }
function Save([string]$Name, [string]$Text) { Set-Content -Encoding utf8 (Join-Path $OutDir $Name) $Text }
function Mem-Has([string]$Needle) { foreach ($f in @($memDb, "$memDb-wal")) { if (Test-Path -LiteralPath $f) { $fs = [IO.File]::Open($f, 'Open', 'Read', 'ReadWrite'); try { $ms = New-Object IO.MemoryStream; $fs.CopyTo($ms); if ([Text.Encoding]::UTF8.GetString($ms.ToArray()).Contains($Needle)) { return $true } } finally { $fs.Dispose() } } }; $false }
function Start-Run([string]$Name) {
    $dir = Join-Path $OutDir $Name
    $script:hudLog = Join-Path $dir 'hud.log'; $script:daemonLog = Join-Path $dir 'daemon.log'
    & "$PSScriptRoot\start-stack.ps1" -OutDir $dir -Config $Config -Root $Root | Out-Null
    $script:pids = Get-Content "$dir\pids.json" -Raw | ConvertFrom-Json
    $script:hwnd = Get-HudHwnd $script:pids.hud
    $hs = [Diagnostics.Stopwatch]::StartNew(); while (-not ((Get-Content $script:hudLog -Raw -ErrorAction SilentlyContinue) -match 'Handshake accepted') -and $hs.ElapsedMilliseconds -lt 40000) { Start-Sleep -Milliseconds 200 }
    Enter-HudInteractive $script:hwnd
    [pscustomobject]@{ dir = $dir; pids = $script:pids; handshake = ((Get-Content $script:hudLog -Raw) -match 'Handshake accepted') }
}

# ---- the run's own world ----
$ws = Join-Path $OutDir 'ws'; New-Item -ItemType Directory -Force (Join-Path $ws 'docs') | Out-Null
[IO.File]::WriteAllText((Join-Path $ws 'docs\brief.txt'), "alpha line`nbeta line`ngamma line`n", (New-Object Text.UTF8Encoding($false)))
$files = Join-Path $OutDir 'files'; New-Item -ItemType Directory -Force (Join-Path $files 'Archive') | Out-Null
[IO.File]::WriteAllText((Join-Path $files 'plan.txt'), "the plan for the demo`n", (New-Object Text.UTF8Encoding($false)))
$lib = Join-Path $OutDir 'library'; New-Item -ItemType Directory -Force $lib | Out-Null; Copy-Item (Join-Path $Papers '*.pdf') $lib
$plugins = Join-Path $OutDir 'plugins'; New-Item -ItemType Directory -Force (Join-Path $plugins 'note_reader') | Out-Null
Copy-Item (Join-Path $Root 'plugins-samples\note_reader\*') (Join-Path $plugins 'note_reader')
$memDb = Join-Path $OutDir 'memory.db'; $notes = Join-Path $OutDir 'notes'; New-Item -ItemType Directory -Force $notes | Out-Null
$real = [ordered]@{ knowledge = Join-Path $env:LOCALAPPDATA 'D-ASK\knowledge.db'; memory = Join-Path $env:LOCALAPPDATA 'D-ASK\memory.db'; plugins = Join-Path $env:LOCALAPPDATA 'D-ASK\plugins-approved.json'; results = Join-Path $env:LOCALAPPDATA 'D-ASK\task-results.json' }
$realDirs = [ordered]@{ research = Join-Path $env:USERPROFILE 'Documents\D-ASK\Research'; notes = Join-Path $env:USERPROFILE 'Documents\D-ASK Notes'; undo = Join-Path $env:LOCALAPPDATA 'D-ASK\file-undo' }
$before = @{}; foreach ($k in $real.Keys) { $before[$k] = Sha $real[$k] }; foreach ($k in $realDirs.Keys) { $before[$k] = DirState $realDirs[$k] }
$envs = [ordered]@{
    FileOrganize = 'true'; FileOrganizeRoots__0 = $files; FileOrganizeJournalDir = (Join-Path $OutDir 'file-undo'); DesktopAppLaunch = 'true'
    Plugins = 'true'; PluginsDir = $plugins; PluginsApprovedPath = (Join-Path $OutDir 'plugins-approved.json'); Notes = 'true'; NotesDir = $notes; Memory = 'true'
    BrowserRead = $(if ($IsOnline) { 'true' } else { 'false' }); TaskResultsPath = (Join-Path $OutDir 'task-results.json')
    ExtraEnvironment__DASK_MEMORY_DB = $memDb; ExtraEnvironment__DASK_KNOWLEDGE_DB = (Join-Path $OutDir 'knowledge.db'); ExtraEnvironment__DASK_RESEARCH_DIR = (Join-Path $OutDir 'research'); ExtraEnvironment__DASK_KNOWLEDGE_ROOTS = $lib
    ExtraEnvironment__DASK_WORKSPACE_ROOT = $ws
}
$savedWs = $env:DASK_WORKSPACE_ROOT
try {
    foreach ($k in $envs.Keys) { Set-Item "Env:\DASK_AgentHost__$k" $envs[$k] }
    $run1 = Start-Run 'run1'
    Record $N.setup $run1.handshake @{ pids = $run1.pids; online = $IsOnline }
    try { $adm = Get-ModelMemoryAdmission $Root; $mp = Test-ModelMemoryPreflight $adm; Record $N.pre $mp.ok @{ availableMB = $adm.availableMB; requiredMB = $adm.requiredMB }; if (-not $mp.ok) { Abort $mp.reason } }
    catch { Record $N.pre $false @{ error = "$_" }; Abort "memory preflight failed: $_" }

    if (-not $script:Aborted) {
        # Fail fast: one quick request must complete, or the agent host is not working and every later step would only wait for its timeout.
        $probe = Plain 'What time is it?' '' 90000
        if (-not $probe.ok) {
            $why = @(Select-String -Path $script:daemonLog -Pattern 'Agent host startup failed: .*' -ErrorAction SilentlyContinue | Select-Object -Last 1 | ForEach-Object { $_.Matches[0].Value })
            Abort "the agent host did not answer a probe request$(if ($why) { ": $why" })"
        }
    }
    if (-not $script:Aborted) {
        # Y1 files
        $src = Join-Path $files 'plan.txt'; $arch = Join-Path $files 'Archive'
        $c = Carded "Copy `"$src`" to `"$arch`"" 'card-y1-copy.txt' @('Copy a file', 'plan.txt', 'Archive') ''
        $copied = (Test-Path (Join-Path $arch 'plan.txt')) -and ((Sha (Join-Path $arch 'plan.txt')) -eq (Sha $src))
        $rn = Carded "Rename `"$src`" to `"final plan.txt`"" 'card-y1-rename.txt' @('Rename a file', 'plan.txt', 'final plan.txt') ''
        $renamed = (Test-Path (Join-Path $files 'final plan.txt')) -and -not (Test-Path $src)
        $un = Carded 'Undo the last rename' 'card-y1-undo.txt' @('Undo the last copy or rename', 'final plan.txt') ''
        $restored = (Test-Path $src) -and -not (Test-Path (Join-Path $files 'final plan.txt'))
        Save 'hud-y1.txt' $un.full
        Record $N.y1 ($c.ok -and $c.outcome -eq 'COMPLETED' -and $copied -and $rn.ok -and $rn.outcome -eq 'COMPLETED' -and $renamed -and $un.ok -and $un.outcome -eq 'COMPLETED' -and $restored) @{ copy = $c.detail; copied = $copied; rename = $rn.detail; renamed = $renamed; undo = $un.detail; restored = $restored }

        # Y2 Character Map
        $cmBefore = @([YWin]::Titled('Character Map'))
        $r = Carded 'Open Character Map' 'card-y2.txt' @('Open Character Map', 'charmap.exe', 'none') ''
        Start-Sleep -Milliseconds 800
        $cmNew = @([YWin]::Titled('Character Map') | Where-Object { $cmBefore -notcontains $_ })
        foreach ($h in $cmNew) { [void][YWin]::PostMessage([IntPtr]$h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }
        Record $N.y2 ($r.ok -and $r.outcome -eq 'COMPLETED' -and $cmNew.Count -eq 1) ($r.detail + @{ newWindows = $cmNew.Count })

        # Y3 plugins
        $i = Carded 'Install the plugin note_reader' 'card-y3-install.txt' @('Install a plugin', 'note_reader', 'compute only') 'Installed the plugin'
        $d1 = Plain 'Show me the first lines of docs/brief.txt' 'files\.read permission'
        $g = Carded 'Grant the plugin note_reader the files.read permission' 'card-y3-grant.txt' @('Give a plugin one extra permission', 'note_reader', 'files.read') ''
        $u = Plain 'Show me the first lines of docs/brief.txt and remember it' 'Saved the result'
        Save 'hud-y3.txt' $u.full
        Record $N.y3 ($i.ok -and $d1.matched -and $d1.full -notmatch 'alpha line' -and $g.ok -and $u.ok -and $u.full -match 'alpha line' -and (Mem-Has 'alpha line')) @{ install = $i.detail; refusedBeforeGrant = $d1.matched; grant = $g.detail; use = $u.detail; inMemory = (Mem-Has 'alpha line') }

        # Y4 history recovery after a forced kill
        $ix = Plain "Index `"$lib`" as research" 'Indexing finished'
        $s = Next-Request "According to my research papers, how does GraphSAGE aggregate features from a node's neighbours?"
        $recovered = $false; $detail = @{ index = $ix.detail }
        if ($s -and $s.Ok) {
            Start-Sleep -Milliseconds 1500                                   # the task id reaches the history entry when the daemon accepts the task
            taskkill /PID $run1.pids.hud /F 2>$null | Out-Null               # the HUD dies while the task runs
            $fin = Wait-Log 'daemon' $s.Marks 'finished: \w+ in \d+ ms' 120000   # the daemon (still running) finishes the task
            $detail.finishedInDaemon = $fin.Found
            & "$PSScriptRoot\stop-stack.ps1" -OutDir $run1.dir | Out-Null   # now the whole stack is killed (taskkill /F)
            Start-Sleep -Seconds 3
            $run2 = Start-Run 'run2'
            $w = Wait-HudText $script:hwnd 'RECOVERED AFTER RESTART' 60000
            Save 'hud-y4.txt' $w.Text
            $recovered = $w.Found -and $w.Text -match '(?i)RECOVERED AFTER RESTART[\s\S]{0,200}cancel'
            $detail.recoveredShown = $w.Found; $detail.newDaemon = $run2.pids.daemon
        }
        Record $N.y4 $recovered $detail

        if ($IsOnline) {
            $r = Carded 'Read https://example.com then save the page as a note called Example page' 'card-y5.txt' @('Create a new note', 'Example page.txt', 'Example Domain') 'Saved the result'
            $nt = if (Test-Path (Join-Path $notes 'Example page.txt')) { Get-Content (Join-Path $notes 'Example page.txt') -Raw } else { '' }
            Record $N.y5 ($r.ok -and $nt -match 'Example Domain' -and $nt -match 'https://example\.com') ($r.detail + @{ noteText = $nt })
            $r = Plain 'Read https://example.org and add it to my knowledge' 'Saved the result'
            Save 'hud-y6.txt' $r.full
            Record $N.y6 ($r.ok -and $r.outcome -eq 'COMPLETED' -and $r.full -match 'example\.org') $r.detail
            $r = Plain 'Research example domains using https://example.com' 'Report:'
            Save 'hud-y7.txt' $r.full
            $rep = @(Get-ChildItem (Join-Path $OutDir 'research') -Recurse -Filter 'report*.md' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1)
            $rt = if ($rep.Count) { Get-Content $rep[0].FullName -Raw } else { '' }
            Record $N.y7 ($r.ok -and $r.outcome -eq 'COMPLETED' -and $rt -match 'https://example\.com' -and $rt -match 'web page\(s\) the user named') @{ result = $r.detail; report = $(if ($rep.Count) { $rep[0].FullName } else { $null }) }
        }
    }
} catch {
    Record 'unexpected error' $false @{ error = "$($_.Exception.Message)" }
    Abort "unexpected error: $($_.Exception.Message)"
} finally {
    try {
        $errs = @(); foreach ($dn in 'run1', 'run2') { $lp = Join-Path (Join-Path $OutDir $dn) 'daemon.log'; if (Test-Path $lp) { $errs += @(Select-String -Path $lp -Pattern '(?i)knowledge (unavailable|task failed)|\[(Notes|Memory|Plugin|FileOrganize)\w*\].*(fail|exception)|unhandled' | ForEach-Object { $_.Line }) } }
        Record $N.log ($errs.Count -eq 0) @{ errorLines = $errs }
    } catch { Record $N.log $false @{ error = "$_" } }
    foreach ($d in 'run2', 'run1') { try { $pp = Join-Path (Join-Path $OutDir $d) 'pids.json'; if (Test-Path $pp) { $p = Get-Content $pp -Raw | ConvertFrom-Json; if (Get-Process -Id $p.daemon -ErrorAction SilentlyContinue) { & "$PSScriptRoot\stop-stack.ps1" -OutDir (Join-Path $OutDir $d) | Out-Null } } } catch { } }
    foreach ($k in $envs.Keys) { Remove-Item "Env:\DASK_AgentHost__$k" -ErrorAction SilentlyContinue }
    $diff = @(); foreach ($k in $real.Keys) { if ((Sha $real[$k]) -ne $before[$k]) { $diff += $k } }; foreach ($k in $realDirs.Keys) { if ((DirState $realDirs[$k]) -ne $before[$k]) { $diff += $k } }
    Record $N.end ($diff.Count -eq 0) @{ changed = $diff }
    foreach ($k in $N.Keys) { if (-not ($script:results | Where-Object { $_.name -eq $N[$k] })) { Record $N[$k] $false @{ notRun = "not reached: $($script:AbortReason)" } } }
    $checks = @($script:results.ToArray() | Where-Object { $_.name -ne 'unexpected error' })
    $passed = @($checks | Where-Object { $_.pass -eq $true }).Count
    $failed = @($script:results.ToArray() | Where-Object { $_.pass -ne $true }).Count
    ConvertTo-Json -InputObject @($script:results.ToArray()) -Depth 8 | Set-Content -Encoding utf8 (Join-Path $OutDir 'approval-live.json')
    ConvertTo-Json -InputObject ([pscustomobject]([ordered]@{ expectedTotal = $script:ExpectedChecks; total = $checks.Count; passed = $passed; failed = $failed; aborted = $script:Aborted; abortReason = $script:AbortReason; online = $IsOnline })) | Set-Content -Encoding utf8 (Join-Path $OutDir 'approval-live-summary.json')
    Write-Host "`n$passed / $($checks.Count) checks passed (expected $($script:ExpectedChecks)); failed $failed; aborted: $($script:Aborted)$(if ($script:AbortReason) { " ($($script:AbortReason))" })"
    Write-Host "Results: $OutDir"
    if ($passed -ne $script:ExpectedChecks -or $script:Aborted) { exit 1 }
}
