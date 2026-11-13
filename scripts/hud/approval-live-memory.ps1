# Real-HUD acceptance for LOCAL PERSISTENT MEMORY (memory.remember / recall / forget).
# Requests are typed into the REAL HUD. The memory database is checked independently (memoryCli list + raw bytes of the .db/-wal). Memory is enabled ONLY in this
# run's daemon environment and the database is inside -OutDir (DASK_MEMORY_DB via AgentHost:ExtraEnvironment); appsettings.json and the code default stay off.
# The stack is restarted once with the SAME database to prove persistence across a restart. Nothing here touches the user's real memory.db (hash checked).
#   powershell -ExecutionPolicy Bypass -File scripts\hud\approval-live-memory.ps1 -OutDir results\memory-hud\live-<stamp>
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


$script:ExpectedChecks = 11
$N = [ordered]@{
    flags = 'Z0 Memory defaults OFF in appsettings.json and in code; enabled here only via this run''s environment'
    setup = 'Z1 setup: real HUD handshook with the real daemon; HUD interactive; isolated memory database inside OutDir'
    pre   = 'Z2 memory preflight: the local model would be admitted with the HUD running'
    m1 = 'M1 "Remember that my favourite editor is Neovim.": COMPLETED, no card, the database holds exactly that memory (independent read)'
    m2 = 'M2 "Remember that my password is hunter2.": NOT stored (not COMPLETED); the secret appears nowhere in the database or WAL bytes'
    m3 = 'M3 "What is my favourite editor?": the HUD answer contains Neovim'
    m4 = 'M4 RESTART (new daemon + HUD, same database): the memory is still in the database and the question still answers Neovim'
    m5 = 'M5 "Forget my favourite editor.": COMPLETED; the database no longer holds it (independent read)'
    m6 = 'M6 recall after forgetting: the answer does not contain Neovim, and the text is gone from the database and WAL bytes'
    log = 'L1 no memory error in either daemon log'
    end = 'Z3 end state: Memory flag still off; the user''s real memory.db is byte-identical to before'
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
function Carded([string]$Text, [string]$CardFile, [string[]]$Need, [bool]$Approve, [string]$ResultPattern) {
    $s = Next-Request $Text
    if (-not $s -or -not $s.Ok) { return [pscustomobject]@{ ok = $false; detail = @{ submit = $(if ($s) { $s.Record } else { $null }) } } }
    $a = Wait-NewApproval $s.Marks 180000
    if ($a.Found) { Set-Content -Encoding utf8 (Join-Path $OutDir $CardFile) $a.Text }
    $missing = if ($a.Found) { @($Need | Where-Object { -not (Contains-Text $a.Text $_) }) } else { $Need }
    if (-not $a.Found -or $missing.Count) { return [pscustomobject]@{ ok = $false; detail = @{ found = $a.Found; reason = $a.Reason; missing = $missing } } }
    $d = Decide $s.Marks $a $Approve
    $r = Wait-NewResult $s.Marks $ResultPattern 240000
    $cards = [regex]::Matches((Read-LogSince $script:hudLog $s.Marks.hud), 'Approval surface opened for').Count
    return [pscustomobject]@{ ok = $d.ok -and $r.arrived; outcome = $r.outcome; matched = $r.matched; cards = $cards; full = [string]$r.text
        detail = @{ decision = $d.decision; cards = $cards; result = @{ arrived = $r.arrived; outcome = $r.outcome; matched = $r.matched; text = ($r.text -split "`n" | Select-Object -First 14) -join ' | ' } } }
}

function Plain([string]$Text, [string]$ResultPattern) {
    $s = Next-Request $Text
    if (-not $s -or -not $s.Ok) { return [pscustomobject]@{ ok = $false; outcome = $null; matched = $false; cards = 0; full = ''; detail = @{ submit = $(if ($s) { $s.Record } else { $null }) } } }
    $r = Wait-NewResult $s.Marks $ResultPattern 240000
    $cards = [regex]::Matches((Read-LogSince $script:hudLog $s.Marks.hud), 'Approval surface opened for').Count
    return [pscustomobject]@{ ok = $r.arrived; outcome = $r.outcome; matched = $r.matched; cards = $cards; full = [string]$r.text; detail = @{ outcome = $r.outcome; matched = $r.matched; cards = $cards; text = ($r.text -split "`n" | Select-Object -First 14) -join ' | ' } }
}
function Sha([string]$Path) { if (Test-Path -LiteralPath $Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLower() } else { $null } }
function FlagsOff {
    $settings = Get-Content (Join-Path $Root 'src\DAsk.Daemon\appsettings.json') -Raw | ConvertFrom-Json
    $src = Get-Content (Join-Path $Root 'src\DAsk.Daemon\AgentHost\AgentHostManager.cs') -Raw
    $cfg = -not ($settings.AgentHost.PSObject.Properties.Name -contains 'Memory') -or $settings.AgentHost.Memory -eq $false
    $code = $src -match 'public bool Memory \{ get; set; \} = false;'
    [pscustomobject]@{ ok = $cfg -and $code; appsettings = $cfg; code = $code }
}
$db = Join-Path $OutDir 'memory.db'
function Db-List { $env:DASK_MEMORY_DB = $db; try { Push-Location $Root; @(& npx tsx agent/runtime/memory/memoryCli.ts list 2>&1 | ForEach-Object { "$_" } | Where-Object { $_ -match '\[' }) } finally { Pop-Location; Remove-Item Env:\DASK_MEMORY_DB -ErrorAction SilentlyContinue } }
function Db-HasBytes([string]$Needle) {
    $hit = $false
    foreach ($f in @($db, "$db-wal", "$db-shm")) { if (Test-Path -LiteralPath $f) { $fs = [IO.File]::Open($f, 'Open', 'Read', 'ReadWrite'); try { $ms = New-Object IO.MemoryStream; $fs.CopyTo($ms); $t = [Text.Encoding]::UTF8.GetString($ms.ToArray()) } finally { $fs.Dispose() }; if ($t.Contains($Needle)) { $hit = $true } } }
    $hit
}
function Start-Run([string]$Name) {
    $dir = Join-Path $OutDir $Name
    $script:hudLog = Join-Path $dir 'hud.log'; $script:daemonLog = Join-Path $dir 'daemon.log'
    & "$PSScriptRoot\start-stack.ps1" -OutDir $dir -Config $Config -Root $Root | Out-Null
    $pids = Get-Content "$dir\pids.json" -Raw | ConvertFrom-Json
    $script:hwnd = Get-HudHwnd $pids.hud
    $hs = [Diagnostics.Stopwatch]::StartNew(); while (-not ((Get-Content $script:hudLog -Raw -ErrorAction SilentlyContinue) -match 'Handshake accepted') -and $hs.ElapsedMilliseconds -lt 40000) { Start-Sleep -Milliseconds 200 }
    Enter-HudInteractive $script:hwnd
    [pscustomobject]@{ dir = $dir; pids = $pids; handshake = ((Get-Content $script:hudLog -Raw) -match 'Handshake accepted') }
}

$realDb = Join-Path $env:LOCALAPPDATA 'D-ASK\memory.db'
$realBefore = Sha $realDb
$run1 = $null; $run2 = $null
try {
    $f0 = FlagsOff
    Record $N.flags $f0.ok $f0
    $env:DASK_AgentHost__Memory = 'true'; $env:DASK_AgentHost__ExtraEnvironment__DASK_MEMORY_DB = $db
    $run1 = Start-Run 'run1'
    Record $N.setup ($run1.handshake -and $db.StartsWith($OutDir)) @{ db = $db; daemonPid = $run1.pids.daemon; hudPid = $run1.pids.hud }
    try {
        $adm = Get-ModelMemoryAdmission $Root; $mp = Test-ModelMemoryPreflight $adm
        [pscustomobject]@{ utc = (Get-Utc); measurement = $adm; decision = $mp } | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 (Join-Path $OutDir 'memory-preflight.json')
        Record $N.pre $mp.ok @{ availableMB = $adm.availableMB; requiredMB = $adm.requiredMB }
        if (-not $mp.ok) { Abort $mp.reason }
    } catch { Record $N.pre $false @{ error = "$_" }; Abort "memory preflight failed: $_" }

    if (-not $script:Aborted) {
        $r1 = Plain 'Remember that my favourite editor is Neovim.' 'Remembered'
        Set-Content -Encoding utf8 (Join-Path $OutDir 'hud-m1.txt') $r1.full
        $l1 = @(Db-List)
        Record $N.m1 ($r1.ok -and $r1.outcome -eq 'COMPLETED' -and $r1.cards -eq 0 -and $l1.Count -eq 1 -and ($l1[0] -match 'favourite editor is Neovim')) ($r1.detail + @{ dbList = $l1 })
        $r2 = Plain 'Remember that my password is hunter2.' ''
        Set-Content -Encoding utf8 (Join-Path $OutDir 'hud-m2.txt') $r2.full
        $l2 = @(Db-List)
        Record $N.m2 ($r2.ok -and $r2.outcome -ne 'COMPLETED' -and $l2.Count -eq 1 -and -not (Db-HasBytes 'hunter2')) ($r2.detail + @{ dbList = $l2 })
        $r3 = Plain 'What is my favourite editor?' 'Neovim'
        Set-Content -Encoding utf8 (Join-Path $OutDir 'hud-m3.txt') $r3.full
        Record $N.m3 ($r3.ok -and $r3.matched -and $r3.full -match 'Neovim') $r3.detail
        # M4: restart with the SAME database.
        try { & "$PSScriptRoot\stop-stack.ps1" -OutDir $run1.dir | Out-Null } catch { }
        Start-Sleep -Seconds 4
        $run2 = Start-Run 'run2'
        $l4 = @(Db-List)
        $r4 = if ($run2.handshake) { Plain 'What is my favourite editor?' 'Neovim' } else { [pscustomobject]@{ ok = $false; matched = $false; full = ''; detail = @{ handshake = $false } } }
        Set-Content -Encoding utf8 (Join-Path $OutDir 'hud-m4.txt') $r4.full
        Record $N.m4 ($run2.handshake -and $l4.Count -eq 1 -and $r4.ok -and $r4.matched -and $r4.full -match 'Neovim' -and $run2.pids.daemon -ne $run1.pids.daemon) ($r4.detail + @{ dbListAfterRestart = $l4; oldDaemon = $run1.pids.daemon; newDaemon = $run2.pids.daemon })
        $r5 = Plain 'Forget my favourite editor.' 'Deleted'
        Set-Content -Encoding utf8 (Join-Path $OutDir 'hud-m5.txt') $r5.full
        $l5 = @(Db-List)
        Record $N.m5 ($r5.ok -and $r5.outcome -eq 'COMPLETED' -and $l5.Count -eq 0) ($r5.detail + @{ dbList = $l5 })
        $r6 = Plain 'What is my favourite editor?' ''
        Set-Content -Encoding utf8 (Join-Path $OutDir 'hud-m6.txt') $r6.full
        # the newest answer only: the HUD lists history newest first, so the first occurrence of the question is this one; read up to the next timestamp
        $m6 = [regex]::Match([string]$r6.full, '(?s)WHAT IS MY FAVOURITE EDITOR\?\s*(.*?)(?:\r?\n\d\d:\d\d\r?\n> |\r?\nDRAG|\z)')
        $blk6 = if ($m6.Success) { $m6.Groups[1].Value } else { '' }
        Record $N.m6 ($r6.ok -and $m6.Success -and $blk6 -notmatch 'Neovim' -and $blk6 -match 'nothing saved' -and -not (Db-HasBytes 'Neovim')) ($r6.detail + @{ neovimBytesInDb = (Db-HasBytes 'Neovim'); newestAnswer = $blk6.Trim() })
    }
} catch {
    Record 'unexpected error' $false @{ error = "$($_.Exception.Message)" }
    Abort "unexpected error: $($_.Exception.Message)"
} finally {
    try {
        $errs = @()
        foreach ($d in 'run1', 'run2') { $lp = Join-Path (Join-Path $OutDir $d) 'daemon.log'; if (Test-Path $lp) { $errs += @(Select-String -Path $lp -Pattern '(?i)\[Memory\].*(fail|error|exception)|memory[^\n]{0,40}(unhandled|exception)' | ForEach-Object { $_.Line }) } }
        Record $N.log ($errs.Count -eq 0) @{ errorLines = $errs }
    } catch { Record $N.log $false @{ error = "$_" } }
    foreach ($r in $run2, $run1) { try { if ($r -and (Get-Process -Id $r.pids.daemon -ErrorAction SilentlyContinue)) { & "$PSScriptRoot\stop-stack.ps1" -OutDir $r.dir | Out-Null } } catch { } }
    foreach ($v in 'Memory', 'ExtraEnvironment__DASK_MEMORY_DB') { Remove-Item "Env:\DASK_AgentHost__$v" -ErrorAction SilentlyContinue }
    $f1 = FlagsOff
    Record $N.end ($f1.ok -and (Sha $realDb) -eq $realBefore) @{ flagsOff = $f1.ok; realMemoryDbUnchanged = ((Sha $realDb) -eq $realBefore) }
    foreach ($k in $N.Keys) { if (-not ($script:results | Where-Object { $_.name -eq $N[$k] })) { Record $N[$k] $false @{ notRun = "not reached: $($script:AbortReason)" } } }
    $checks = @($script:results.ToArray() | Where-Object { $_.name -ne 'unexpected error' })
    $passed = @($checks | Where-Object { $_.pass -eq $true }).Count
    $failed = @($script:results.ToArray() | Where-Object { $_.pass -ne $true }).Count
    $summary = [ordered]@{ expectedTotal = $script:ExpectedChecks; total = $checks.Count; passed = $passed; failed = $failed; aborted = $script:Aborted; abortReason = $script:AbortReason; db = $db }
    ConvertTo-Json -InputObject @($script:results.ToArray()) -Depth 8 | Set-Content -Encoding utf8 (Join-Path $OutDir 'approval-live.json')
    ConvertTo-Json -InputObject ([pscustomobject]$summary) -Depth 6 | Set-Content -Encoding utf8 (Join-Path $OutDir 'approval-live-summary.json')
    Write-Host "`n$passed / $($checks.Count) checks passed (expected $($script:ExpectedChecks)); failed $failed; aborted: $($script:Aborted)$(if ($script:AbortReason) { " ($($script:AbortReason))" })"
    Write-Host "Results: $OutDir"
    if ($passed -ne $script:ExpectedChecks -or $script:Aborted) { exit 1 }
}
