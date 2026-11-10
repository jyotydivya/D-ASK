# Real-HUD acceptance for file organisation, workflows, plugin installation and OCR (batches 5–9).
# Every request is typed into the REAL HUD; approvals are clicked in the REAL HUD card; effects are checked independently
# (files on disk, the workflow store, the approved-plugin list, the fixture window's known text).
# The features are enabled ONLY in this run's daemon environment, with every store/journal/plugin folder inside -OutDir;
# appsettings.json and code defaults stay off (checked before and after).
#   powershell -ExecutionPolicy Bypass -File scripts\hud\approval-live-features.ps1 -OutDir results\features-hud\live-<stamp>
param([Parameter(Mandatory = $true)][string]$OutDir, [string]$Root, [string]$Config = 'Debug')
$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = (Resolve-Path "$PSScriptRoot\..\..").Path }
if ((Test-Path $OutDir) -and @(Get-ChildItem $OutDir -Force).Count -gt 0) { throw "OutDir must be new or empty: $OutDir" }
New-Item -ItemType Directory -Force $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path
$keepOut = $OutDir; $keepRoot = $Root; $keepConfig = $Config
. "$PSScriptRoot\approval-live-7b3.ps1" -OutDir $keepOut -Root $keepRoot -Config $keepConfig -LoadFunctionsOnly
$OutDir = $keepOut; $Root = $keepRoot; $Config = $keepConfig
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

$script:ExpectedChecks = 16
$N = [ordered]@{
    flags = '0b FileOrganize, Workflows, Plugins and DesktopOcr default OFF in appsettings.json and in code; enabled here only via this run''s environment'
    setup = '0 setup: real HUD handshook with the real daemon; HUD interactive; organise folder, plugin folder and OCR fixture window ready'
    pre   = '0c memory preflight: the local model would be admitted with the HUD running'
    o1 = 'O1 "organize … by type": a Files.Organize card listing the exact moves; APPROVE; COMPLETED'
    o2 = 'O2 the files are independently in Documents\ and Images\ on disk; the unknown type stayed; an undo journal exists'
    o3 = 'O3 "undo the last file organisation": a Files.UndoOrganize card; APPROVE; COMPLETED; the files are back'
    o4 = 'O4 organise again and DENY: nothing moved; not completed'
    w1 = 'W1 "save a workflow called check: …": COMPLETED without any approval card; the store holds exactly the two steps'
    w2 = 'W2 "run the workflow check every day at …": a Workflow.Schedule card showing both steps; APPROVE; COMPLETED; the store holds the schedule'
    w3 = 'W3 "run the workflow check": both steps run as ordinary tasks; COMPLETED with 2 of 2 steps'
    p1 = 'P1 "install the plugin text_tools": a Plugin.Install card (tools, compute only); APPROVE; COMPLETED; the approved list holds the exact file hashes'
    p2 = 'P2 a word-count request runs the plugin in the sandbox: the result shows its output, labelled, and is not "completed"'
    p3 = 'P3 "remove the plugin text_tools": COMPLETED; the approved list is empty'
    v1 = 'V1 "read the text in the window titled …": COMPLETED; the recognised text contains the fixture''s field text, never its password'
    log = 'L1 no D-ASK process reported an error for these features in the daemon log'
    end = 'Z  end state: flags still off in appsettings.json; every store this run wrote is inside OutDir'
}

function Restore-HudFront {
    if ([HudInput]::GetForegroundWindow() -eq $script:hwnd) { return }
    if ((Get-HudMode $script:hwnd) -eq 'interactive') { Send-HudToggleHotkey; try { [void](Wait-HudMode $script:hwnd 'ambient' 3000) } catch { } }
    Enter-HudInteractive $script:hwnd
    Assert-HudForeground $script:hwnd
    Start-Sleep -Milliseconds 1200
    [void](Find-HudElement $script:hwnd -AutomationId 'ultron-command' -TimeoutMs 8000)
}
function Decide($Marks, $A, [bool]$Approve) {
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
# One request that must show ONE card (of $Type, containing $Need), be decided ($Approve), and end with $ResultPattern.
function Carded([string]$Key, [string]$Text, [string]$CardFile, [string[]]$Need, [bool]$Approve, [string]$ResultPattern) {
    $s = Next-Request $Text
    if (-not $s -or -not $s.Ok) { Record $N[$Key] $false @{ submit = $s.Record }; return $null }
    $a = Wait-NewApproval $s.Marks 180000
    if ($a.Found) { Set-Content -Encoding utf8 (Join-Path $OutDir $CardFile) $a.Text }
    $missing = if ($a.Found) { @($Need | Where-Object { -not (Contains-Text $a.Text $_) }) } else { $Need }
    if (-not $a.Found -or $missing.Count) { return [pscustomobject]@{ ok = $false; detail = @{ found = $a.Found; reason = $a.Reason; missing = $missing } } }
    $d = Decide $s.Marks $a $Approve
    $r = Wait-NewResult $s.Marks $ResultPattern
    return [pscustomobject]@{ ok = $d.ok -and $r.arrived; outcome = $r.outcome; matched = $r.matched; detail = @{ decision = $d.decision; result = @{ arrived = $r.arrived; outcome = $r.outcome; matched = $r.matched; text = ($r.text -split "`n" | Select-Object -First 12) -join ' | ' } } }
}
function Plain([string]$Text, [string]$ResultPattern) {
    $s = Next-Request $Text
    if (-not $s -or -not $s.Ok) { return [pscustomobject]@{ ok = $false; outcome = $null; matched = $false; cards = 0; detail = @{ submit = $s.Record } } }
    $r = Wait-NewResult $s.Marks $ResultPattern 240000
    $cards = [regex]::Matches((Read-LogSince $script:hudLog $s.Marks.hud), 'Approval surface opened for').Count
    return [pscustomobject]@{ ok = $r.arrived; outcome = $r.outcome; matched = $r.matched; cards = $cards; full = [string]$r.text; detail = @{ outcome = $r.outcome; matched = $r.matched; cards = $cards; text = ($r.text -split "`n" | Select-Object -First 14) -join ' | ' } }
}

$script:hudLog = Join-Path $OutDir 'hud.log'
$script:daemonLog = Join-Path $OutDir 'daemon.log'
$org = Join-Path $OutDir 'organize-me'; New-Item -ItemType Directory -Force $org | Out-Null
foreach ($fileName in 'report.pdf', 'notes.txt', 'photo.jpg', 'mystery.qqq') { Set-Content -Encoding ascii (Join-Path $org $fileName) "content of $fileName" }   # not $n: PowerShell names are case-insensitive ($N holds the checks)
$plugins = Join-Path $OutDir 'plugins'; New-Item -ItemType Directory -Force (Join-Path $plugins 'text_tools') | Out-Null
Copy-Item (Join-Path $Root 'plugins-samples\text_tools\*') (Join-Path $plugins 'text_tools')
$approved = Join-Path $OutDir 'plugins-approved.json'; $store = Join-Path $OutDir 'workflows.json'; $journal = Join-Path $OutDir 'file-undo'
$title = "DASK OCR Fixture $([Guid]::NewGuid().ToString('N').Substring(0, 6))"
$fx = $null
$names = 'FileOrganize', 'FileOrganizeRoots__0', 'FileOrganizeJournalDir', 'Workflows', 'WorkflowStorePath', 'Plugins', 'PluginsDir', 'PluginsApprovedPath', 'DesktopOcr', 'DesktopReadAllowedProcessIds__0'
function FlagsOff {
    $settings = Get-Content (Join-Path $Root 'src\DAsk.Daemon\appsettings.json') -Raw | ConvertFrom-Json
    $src = Get-Content (Join-Path $Root 'src\DAsk.Daemon\AgentHost\AgentHostManager.cs') -Raw
    $cfg = foreach ($f in 'FileOrganize', 'Workflows', 'Plugins', 'DesktopOcr') { -not ($settings.AgentHost.PSObject.Properties.Name -contains $f) -or $settings.AgentHost.$f -eq $false }
    $code = foreach ($f in 'FileOrganize', 'Workflows', 'Plugins', 'DesktopOcr') { $src -match "public bool $f \{ get; set; \} = false;" }
    [pscustomobject]@{ ok = (@($cfg) -notcontains $false) -and (@($code) -notcontains $false); appsettings = @($cfg); code = @($code) }
}
try {
    $f0 = FlagsOff
    Record $N.flags $f0.ok $f0
    # The OCR fixture: the Phase 7B.1b window (known field text, a password field). Never focused, receives no input.
    $psi = New-Object Diagnostics.ProcessStartInfo -ArgumentList 'powershell.exe', ("-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$Root\tests\DAsk.Daemon.Tests\Fixtures\desktop-fixture.ps1`" -Title `"$title`" -Secret `"dask-fixture-secret-7b1b`" -X 900 -Y 120")
    $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardInput = $true; $psi.CreateNoWindow = $true
    $fx = [Diagnostics.Process]::Start($psi)
    $ready = $fx.StandardOutput.ReadLineAsync(); if (-not $ready.Wait(30000) -or -not $ready.Result.StartsWith('READY ')) { throw 'the OCR fixture did not start' }

    $env:DASK_AgentHost__FileOrganize = 'true'; $env:DASK_AgentHost__FileOrganizeRoots__0 = $org; $env:DASK_AgentHost__FileOrganizeJournalDir = $journal
    $env:DASK_AgentHost__Workflows = 'true'; $env:DASK_AgentHost__WorkflowStorePath = $store
    $env:DASK_AgentHost__Plugins = 'true'; $env:DASK_AgentHost__PluginsDir = $plugins; $env:DASK_AgentHost__PluginsApprovedPath = $approved
    $env:DASK_AgentHost__DesktopOcr = 'true'; $env:DASK_AgentHost__DesktopReadAllowedProcessIds__0 = "$($fx.Id)"
    & "$PSScriptRoot\start-stack.ps1" -OutDir $OutDir -Config $Config -Root $Root | Out-Null
    $pids = Get-Content "$OutDir\pids.json" -Raw | ConvertFrom-Json
    $script:hwnd = Get-HudHwnd $pids.hud
    $hs = [Diagnostics.Stopwatch]::StartNew(); while (-not ((Get-Content $script:hudLog -Raw -ErrorAction SilentlyContinue) -match 'Handshake accepted') -and $hs.ElapsedMilliseconds -lt 30000) { Start-Sleep -Milliseconds 200 }
    Enter-HudInteractive $script:hwnd
    Record $N.setup ((Get-Content $script:hudLog -Raw) -match 'Handshake accepted') @{ fixturePid = $fx.Id; organiseFolder = $org }
    try {
        $adm = Get-ModelMemoryAdmission $Root; $mp = Test-ModelMemoryPreflight $adm
        [pscustomobject]@{ utc = (Get-Utc); measurement = $adm; decision = $mp } | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 (Join-Path $OutDir 'memory-preflight.json')
        Record $N.pre $mp.ok @{ availableMB = $adm.availableMB; requiredMB = $adm.requiredMB }
        if (-not $mp.ok) { Abort $mp.reason }
    } catch { Record $N.pre $false @{ error = "$_" }; Abort "memory preflight failed: $_" }

    # ---- File organisation ----
    if (-not $script:Aborted) {
        $r = Carded 'o1' "Organize the files in `"$org`" by type" 'card-o1-organize.txt' @('Move files into subfolders', 'report.pdf', 'Documents', 'photo.jpg', 'Images') $true 'Moved and verified'
        Record $N.o1 ($r -and $r.ok -and $r.outcome -eq 'COMPLETED' -and $r.matched) $(if ($r) { $r.detail } else { $null })
        $onDisk = (Test-Path "$org\Documents\report.pdf") -and (Test-Path "$org\Documents\notes.txt") -and (Test-Path "$org\Images\photo.jpg") -and (Test-Path "$org\mystery.qqq") -and -not (Test-Path "$org\report.pdf")
        Record $N.o2 ($onDisk -and @(Get-ChildItem $journal -Filter *.json -ErrorAction SilentlyContinue).Count -eq 1) @{ files = @(Get-ChildItem $org -Recurse -File | ForEach-Object { $_.FullName.Substring($org.Length + 1) }); journals = @(Get-ChildItem $journal -Filter *.json -ErrorAction SilentlyContinue).Count }
        $r = Carded 'o3' 'Undo the last file organisation' 'card-o3-undo.txt' @('Move files back', 'report.pdf') $true 'Moved back and verified'
        $back = (Test-Path "$org\report.pdf") -and (Test-Path "$org\photo.jpg") -and -not (Test-Path "$org\Images")
        Record $N.o3 ($r -and $r.ok -and $r.outcome -eq 'COMPLETED' -and $back) @{ result = $(if ($r) { $r.detail } else { $null }); filesBack = $back }
        $r = Carded 'o4' "Organize the files in `"$org`" by type" 'card-o4-deny.txt' @('Move files into subfolders') $false ''
        Record $N.o4 ($r -and $r.ok -and $r.outcome -ne 'COMPLETED' -and (Test-Path "$org\report.pdf") -and -not (Test-Path "$org\Documents\report.pdf")) $(if ($r) { $r.detail } else { $null })
    }
    # ---- Workflows ----
    if (-not $script:Aborted) {
        $r = Plain 'Save a workflow called check: What is 2+3?; then What is 10*4?' 'Saved the workflow'
        $steps = if (Test-Path $store) { @((Get-Content $store -Raw | ConvertFrom-Json)[0].Steps) } else { @() }
        Record $N.w1 ($r.outcome -eq 'COMPLETED' -and $r.cards -eq 0 -and ($steps -join '|') -eq 'What is 2+3?|What is 10*4?') @{ result = $r.detail; steps = $steps }
        $t = (Get-Date).AddHours(2).ToString('HH:mm')
        $r = Carded 'w2' "Run the workflow check every day at $t" 'card-w2-schedule.txt' @('Run a saved workflow on a schedule', 'What is 2+3?', 'What is 10*4?', $t) $true 'will run every day'
        $sched = if (Test-Path $store) { (Get-Content $store -Raw | ConvertFrom-Json)[0].Schedule } else { $null }
        Record $N.w2 ($r -and $r.ok -and $r.outcome -eq 'COMPLETED' -and $sched -and $sched.Kind -eq 'daily' -and $sched.Time -eq $t) @{ result = $(if ($r) { $r.detail } else { $null }); schedule = $sched }
        $r = Plain 'Run the workflow check' '2 of 2 step'
        Record $N.w3 ($r.outcome -eq 'COMPLETED' -and $r.matched) $r.detail
    }
    # ---- Plugins ----
    if (-not $script:Aborted) {
        $r = Carded 'p1' 'Install the plugin text_tools' 'card-p1-plugin.txt' @('Install a plugin', 'word_count', 'compute only') $true 'Installed the plugin'
        $ap = if (Test-Path $approved) { Get-Content $approved -Raw | ConvertFrom-Json } else { $null }
        $hashOk = $ap -and (@($ap)[0].files.'index.js' -eq (Get-FileHash (Join-Path $plugins 'text_tools\index.js') -Algorithm SHA256).Hash.ToLower())
        Record $N.p1 ($r -and $r.ok -and $r.outcome -eq 'COMPLETED' -and $hashOk) @{ result = $(if ($r) { $r.detail } else { $null }); approvedHashMatches = $hashOk }
        $r = Plain 'Give me the word count of: alpha beta gamma delta' 'output not independently verified'
        Record $N.p2 ($r.matched -and $r.outcome -ne 'COMPLETED' -and ((Normalize $r.full) -match '4 word\(s\)')) ($r.detail + @{ pluginOutputShown = ((Normalize $r.full) -match '4 word\(s\)') })
        $r = Plain 'Remove the plugin text_tools' 'Removed the plugin'
        Record $N.p3 ($r.outcome -eq 'COMPLETED' -and (Get-Content $approved -Raw).Trim() -eq '[]') $r.detail
    }
    # ---- OCR ----
    if (-not $script:Aborted) {
        $r = Plain "Read the text in the window titled `"$title`"" 'fixture plain text'
        Record $N.v1 ($r.outcome -eq 'COMPLETED' -and $r.matched -and ($r.full -notmatch 'dask-fixture-secret')) ($r.detail + @{ secretShown = ($r.full -match 'dask-fixture-secret') })
    }
} catch {
    Record 'unexpected error' $false @{ error = "$($_.Exception.Message)" }
    Abort "unexpected error: $($_.Exception.Message)"
} finally {
    try {
        $errs = @(Select-String -Path $script:daemonLog -Pattern '\[(FileOrganize|Workflows|Plugins|DesktopOcr)\].*(fail|error|exception)' -ErrorAction SilentlyContinue | ForEach-Object { $_.Line })
        Record $N.log ($errs.Count -eq 0) @{ lines = $errs }
    } catch { Record $N.log $false @{ error = "$_" } }
    try { & "$PSScriptRoot\stop-stack.ps1" -OutDir $OutDir | Out-Null } catch { }
    try { if ($fx -and -not $fx.HasExited) { $fx.Kill() } } catch { }
    foreach ($v in $names) { Remove-Item "Env:\DASK_AgentHost__$v" -ErrorAction SilentlyContinue }
    $f1 = FlagsOff
    Record $N.end ($f1.ok -and -not (Test-Path (Join-Path $env:LOCALAPPDATA 'D-ASK\workflows.json.tmp'))) @{ flagsOff = $f1.ok; stores = @($store, $approved, $journal) }
    foreach ($k in $N.Keys) { if (-not ($script:results | Where-Object { $_.name -eq $N[$k] })) { Record $N[$k] $false @{ notRun = "not reached: $($script:AbortReason)" } } }
    $checks = @($script:results.ToArray() | Where-Object { $_.name -ne 'unexpected error' })
    $passed = @($checks | Where-Object { $_.pass -eq $true }).Count
    $failed = @($script:results.ToArray() | Where-Object { $_.pass -ne $true }).Count
    $summary = [ordered]@{ expectedTotal = $script:ExpectedChecks; total = $checks.Count; passed = $passed; failed = $failed; aborted = $script:Aborted; abortReason = $script:AbortReason }
    ConvertTo-Json -InputObject @($script:results.ToArray()) -Depth 8 | Set-Content -Encoding utf8 (Join-Path $OutDir 'approval-live.json')
    ConvertTo-Json -InputObject ([pscustomobject]$summary) -Depth 6 | Set-Content -Encoding utf8 (Join-Path $OutDir 'approval-live-summary.json')
    Write-Host "`n$passed / $($checks.Count) checks passed (expected $($script:ExpectedChecks)); failed $failed; aborted: $($script:Aborted)$(if ($script:AbortReason) { " ($($script:AbortReason))" })"
    Write-Host "Results: $OutDir"
    if ($passed -ne $script:ExpectedChecks -or $script:Aborted) { exit 1 }
}
