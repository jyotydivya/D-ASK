# Real-HUD acceptance of GRANULAR PLUGIN PERMISSIONS and the MANAGEMENT PANEL (plugins, memory, workflows).
# Every request is typed into the REAL HUD and every panel button is clicked with the real, guarded mouse; approvals are clicked in the REAL cards.
# Effects are checked independently: the daemon's approved list, the host's audit log, the memory database (memoryCli), the workflow store, the HUD text.
# Plugins, Memory and Workflows are enabled ONLY in this run's environment; every store is inside -OutDir. A synthetic fixture (with a canary secret) is the only readable folder.
#   powershell -ExecutionPolicy Bypass -File scripts/hud/approval-live-plugperm.ps1 -OutDir results/plugperm-hud/live-<stamp>
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
    flags = 'Z0 Plugins, Memory and Workflows default OFF in appsettings.json and in code; enabled here only via this run''s environment'
    setup = 'Z1 setup: real HUD handshook with the real daemon; plugin folder, isolated memory database, seeded workflows and a synthetic readable fixture ready'
    pre   = 'Z2 memory preflight: the local model would be admitted with the HUD running'
    a1 = 'A1 "Install the plugin note_reader": a Plugin.Install card says compute only and that files.read / memory.read are NOT granted by it; APPROVE; the approved list holds granted = [compute]'
    a2 = 'A2 DENIED BY DEFAULT: "Show me the first lines of docs/brief.txt" is refused with a message saying how to allow it; no file was read; the denial is in the audit log'
    a3 = 'A3 MANAGE panel (real clicks): MANAGE > PLUGINS > REFRESH shows note_reader ENABLED with compute GRANTED and files.read / memory.read NOT GRANTED (read back from the real reply)'
    a4 = 'A4 panel GRANT of files.read: a Plugin.GrantPermission card names note_reader, files.read and what it allows; APPROVE; granted = [compute, files.read]; the panel then shows files.read GRANTED and memory.read NOT GRANTED'
    a5 = 'A5 with files.read granted, the first lines of docs/brief.txt are returned, labelled not independently verified; the use is in the audit log (without the text)'
    a6 = 'A6 even granted, the capability is bounded: "first lines of .env" is refused and the fixture canary secret is shown nowhere in the HUD'
    a7 = 'A7 INDIVIDUAL: memory.read was never granted, so "my saved notes about editor" is refused for memory.read'
    a8 = 'A8 panel REVOKE of files.read: NO card; granted = [compute]; the next file request is refused again (audited as denied)'
    a9 = 'A9 panel DISABLE / ENABLE: the approved list shows disabled then enabled; while disabled the plugin does not run'
    m1 = 'M1 MEMORY tab: the seeded memory is listed with its id; FORGET needs a second click (CONFIRM?); the database no longer holds it (independent read)'
    w1 = 'W1 WORKFLOWS tab: both seeded workflows listed; UNSCHEDULE nightly removes only its schedule; DELETE (two clicks) of the first listed workflow removes only that one (store read independently)'
    log = 'L1 no plugin, memory or workflow error in the daemon log'
    end = 'Z3 end state: all three flags still off; the user''s own plugins-approved.json, memory.db and workflows.json are byte-identical to before'
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

. "$PSScriptRoot\timed-helpers.ps1"
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
    $ok = $true
    foreach ($f in 'Plugins', 'Memory', 'Workflows') {
        $cfg = -not ($settings.AgentHost.PSObject.Properties.Name -contains $f) -or $settings.AgentHost.$f -eq $false
        $code = $src -match "public bool $f \{ get; set; \} = false;"
        if (-not ($cfg -and $code)) { $ok = $false }
    }
    [pscustomobject]@{ ok = $ok }
}
function Read-Approved { if (Test-Path $approved) { @((Get-Content $approved -Raw | ConvertFrom-Json)) } else { @() } }
function Read-Audit { if (Test-Path $audit) { @(Get-Content $audit | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json }) } else { @() } }
function Db-List { $env:DASK_MEMORY_DB = $db; try { Push-Location $Root; @(& npx tsx agent/runtime/memory/memoryCli.ts list 2>&1 | ForEach-Object { "$_" } | Where-Object { $_ -match '\[' }) } finally { Pop-Location; Remove-Item Env:\DASK_MEMORY_DB -ErrorAction SilentlyContinue } }
function Read-Store { if (Test-Path $wfStore) { @(ConvertFrom-WorkflowStore (Get-Content $wfStore -Raw)) } else { @() } }
function Panel-Text { Normalize (Safe-HudText) }
function Has-Btn([string]$Pattern) { try { [void](Find-HudButton $script:hwnd $Pattern 3000); $true } catch { $false } }
function Click([string]$Pattern) { Restore-HudFront; Invoke-GuardedClick -Label $Pattern -ButtonPattern $Pattern -WaitEnabled }
function Panel-Open([string]$Tab) {
    $t = Panel-Text
    if ($t -notmatch 'Manage workflows, plugins and memory' -and $t -notmatch 'REFRESH') { [void](Click '^MANAGE( ▾)?$'); Start-Sleep -Milliseconds 700 }
    [void](Click "^$Tab$"); Start-Sleep -Milliseconds 500
}
function Panel-Refresh {
    $m = Mark-Logs
    [void](Click '^REFRESH$')
    $r = Wait-NewResult $m $null 240000 20000
    Start-Sleep -Milliseconds 900
    $r
}
function Panel-Act([string]$Pattern, [bool]$Card, [bool]$Approve = $true, [string]$Need = $null) {
    $m = Mark-Logs
    $c = Click $Pattern
    $a = $null; $d = $null
    if ($Card) {
        $a = Wait-NewApproval $m 120000
        if ($a.Found) { Set-Content -Encoding utf8 (Join-Path $OutDir ("card-" + ($Pattern -replace '\W', '') + "-" + (Get-Date -Format HHmmss) + ".txt")) $a.Text; try { Restore-HudFront } catch { }; $d = Decide $m $a $Approve }
    }
    $r = Wait-NewResult $m $null 240000 20000
    $cards = [regex]::Matches((Read-LogSince $script:hudLog $m.hud), 'Approval surface opened for').Count
    Start-Sleep -Milliseconds 1500    # the panel asks for the list again when the task ends
    [pscustomobject]@{ click = $c; card = $a; decision = $d; result = $r; cards = $cards }
}

# ---- the run's own world (nothing of the user's is read or written) ----
$plugins = Join-Path $OutDir 'plugins'; New-Item -ItemType Directory -Force (Join-Path $plugins 'note_reader') | Out-Null
Copy-Item (Join-Path $Root 'plugins-samples\note_reader\*') (Join-Path $plugins 'note_reader')
$approved = Join-Path $OutDir 'plugins-approved.json'; $audit = Join-Path $OutDir 'plugins-audit.jsonl'
$db = Join-Path $OutDir 'memory.db'; $wfStore = Join-Path $OutDir 'workflows.json'
$ws = Join-Path $OutDir 'fixture'; New-Item -ItemType Directory -Force (Join-Path $ws 'docs') | Out-Null
[IO.File]::WriteAllText((Join-Path $ws 'docs\brief.txt'), "alpha line`nbeta line`ngamma line`n", (New-Object Text.UTF8Encoding($false)))
[IO.File]::WriteAllText((Join-Path $ws '.env'), "CANARY_SECRET=do-not-show-12345`n", (New-Object Text.UTF8Encoding($false)))
$canary = 'do-not-show-12345'
# seed memory (through the user-control CLI, into the run's own database) and workflows
$env:DASK_MEMORY_DB = $db; Push-Location $Root
$seedOut = & npx tsx -e "import { MemoryStore } from './agent/runtime/memory/memoryStore'; const s = new MemoryStore(process.env.DASK_MEMORY_DB!); s.remember({ kind: 'preference', content: 'my favourite editor is Neovim', source: 'user' }); s.close(); console.log('seeded');" 2>&1
Pop-Location; Remove-Item Env:\DASK_MEMORY_DB -ErrorAction SilentlyContinue
$now = Get-Date; $nowUtc = (Get-Date).ToUniversalTime().ToString('o')
$seedWf = @(
    [ordered]@{ Name = 'nightly'; Steps = @('What is 2+3?'); CreatedUtc = $nowUtc; Schedule = [ordered]@{ Kind = 'daily'; Time = $now.AddHours(7).ToString('HH:mm'); Day = $null; Date = $null; ApprovedUtc = $nowUtc; LastRunUtc = $null; LastNote = $null } },
    [ordered]@{ Name = 'dropme'; Steps = @('What is 7+8?'); CreatedUtc = $nowUtc; Schedule = $null }
)
[IO.File]::WriteAllText($wfStore, (ConvertTo-Json -InputObject @($seedWf) -Depth 6), (New-Object Text.UTF8Encoding($false)))
$realApproved = Join-Path $env:LOCALAPPDATA 'D-ASK\plugins-approved.json'; $realDb = Join-Path $env:LOCALAPPDATA 'D-ASK\memory.db'; $realWf = Join-Path $env:LOCALAPPDATA 'D-ASK\workflows.json'
$realBefore = @{ a = (Sha $realApproved); d = (Sha $realDb); w = (Sha $realWf) }
$names = 'Plugins', 'PluginsDir', 'PluginsApprovedPath', 'Memory', 'ExtraEnvironment__DASK_MEMORY_DB', 'Workflows', 'WorkflowStorePath'
$saved = @{ DASK_WORKSPACE_ROOT = $env:DASK_WORKSPACE_ROOT; DASK_FS_ROOTS = $env:DASK_FS_ROOTS }
$script:hudLog = Join-Path $OutDir 'hud.log'; $script:daemonLog = Join-Path $OutDir 'daemon.log'
$started = $false
try {
    Record $N.flags (FlagsOff).ok (FlagsOff)
    $env:DASK_AgentHost__Plugins = 'true'; $env:DASK_AgentHost__PluginsDir = $plugins; $env:DASK_AgentHost__PluginsApprovedPath = $approved
    $env:DASK_AgentHost__Memory = 'true'; $env:DASK_AgentHost__ExtraEnvironment__DASK_MEMORY_DB = $db
    $env:DASK_AgentHost__Workflows = 'true'; $env:DASK_AgentHost__WorkflowStorePath = $wfStore
    $env:DASK_WORKSPACE_ROOT = $ws; Remove-Item Env:\DASK_FS_ROOTS -ErrorAction SilentlyContinue
    & "$PSScriptRoot\start-stack.ps1" -OutDir $OutDir -Config $Config -Root $Root | Out-Null
    $started = $true
    $pids = Get-Content "$OutDir\pids.json" -Raw | ConvertFrom-Json
    $script:hwnd = Get-HudHwnd $pids.hud
    $hs = [Diagnostics.Stopwatch]::StartNew(); while (-not ((Get-Content $script:hudLog -Raw -ErrorAction SilentlyContinue) -match 'Handshake accepted') -and $hs.ElapsedMilliseconds -lt 40000) { Start-Sleep -Milliseconds 200 }
    Enter-HudInteractive $script:hwnd
    $seeded = (Db-List).Count -eq 1
    Record $N.setup (((Get-Content $script:hudLog -Raw) -match 'Handshake accepted') -and $seeded -and (Read-Store).Count -eq 2) @{ plugins = $plugins; db = $db; seededMemories = (Db-List).Count; workflows = (Read-Store).Count; seedOut = "$seedOut" }
    try {
        $adm = Get-ModelMemoryAdmission $Root; $mp = Test-ModelMemoryPreflight $adm
        [pscustomobject]@{ utc = (Get-Utc); measurement = $adm; decision = $mp } | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 (Join-Path $OutDir 'memory-preflight.json')
        Record $N.pre $mp.ok @{ availableMB = $adm.availableMB; requiredMB = $adm.requiredMB }
        if (-not $mp.ok) { Abort $mp.reason }
    } catch { Record $N.pre $false @{ error = "$_" }; Abort "memory preflight failed: $_" }

    if (-not $script:Aborted) {
        # A1
        $r = Carded 'Install the plugin note_reader' 'card-a1-install.txt' @('Install a plugin', 'note_reader', 'compute only', 'does NOT grant', 'files.read') $true 'Installed the plugin'
        $ap = @(Read-Approved)
        Record $N.a1 ($r.ok -and $r.matched -and $r.cards -eq 1 -and $ap.Count -eq 1 -and (@($ap[0].granted) -join ',') -eq 'compute') ($r.detail + @{ approved = $ap })
        # A2
        $r = Plain 'Show me the first lines of docs/brief.txt' 'files\.read permission'
        Set-Content -Encoding utf8 (Join-Path $OutDir 'hud-a2.txt') $r.full
        $au = @(Read-Audit)
        Record $N.a2 ($r.matched -and $r.outcome -ne 'COMPLETED' -and ($r.full -match 'does not have the files\.read permission') -and ($r.full -match 'Grant the plugin note_reader the files\.read permission') -and @($au | Where-Object { $_.decision -eq 'denied' -and $_.permission -eq 'files.read' }).Count -ge 1 -and @($au | Where-Object { $_.decision -eq 'allowed' }).Count -eq 0 -and $r.full -notmatch 'alpha line') ($r.detail + @{ audit = $au })
        # A3
        Panel-Open 'PLUGINS'
        $rf = Panel-Refresh
        $t = Panel-Text
        Set-Content -Encoding utf8 (Join-Path $OutDir 'hud-a3-panel.txt') $t
        Record $N.a3 (($t -match 'note_reader') -and ($t -match 'ENABLED') -and ($t -match 'compute\W+GRANTED') -and ($t -match 'files\.read\W+NOT GRANTED') -and ($t -match 'memory\.read\W+NOT GRANTED')) @{ refresh = $rf.outcome; panelExcerpt = $(if ($t.Length -gt 900) { $t.Substring([Math]::Max(0, $t.IndexOf('note_reader') - 40), 700) } else { $t }) }
        # A4
        $g = Panel-Act '^GRANT$' $true $true
        $ap = @(Read-Approved); $t = Panel-Text
        Set-Content -Encoding utf8 (Join-Path $OutDir 'hud-a4-panel.txt') $t
        $cardOk = $g.card.Found -and (Contains-Text $g.card.Text 'Give a plugin one extra permission') -and (Contains-Text $g.card.Text 'note_reader') -and (Contains-Text $g.card.Text 'files.read') -and (Contains-Text $g.card.Text 'never secret files')
        Record $N.a4 ($cardOk -and $g.decision.ok -and $g.cards -eq 1 -and (@($ap[0].granted) -join ',') -eq 'compute,files.read' -and ($t -match 'files\.read\W+GRANTED') -and ($t -match 'memory\.read\W+NOT GRANTED')) @{ cardFound = $g.card.Found; decisionOk = $g.decision.ok; cards = $g.cards; granted = @($ap[0].granted); panelShowsGranted = ($t -match 'files\.read\W+GRANTED') }
        # A5
        $r = Plain 'Show me the first lines of docs/brief.txt' 'alpha line'
        Set-Content -Encoding utf8 (Join-Path $OutDir 'hud-a5.txt') $r.full
        $au = @(Read-Audit); $allowed = @($au | Where-Object { $_.decision -eq 'allowed' -and $_.permission -eq 'files.read' })
        Record $N.a5 ($r.matched -and ($r.full -match 'alpha line') -and ($r.full -match 'not independently verified') -and $r.outcome -ne 'COMPLETED' -and $allowed.Count -ge 1 -and (($allowed | ForEach-Object { $_.detail }) -join ' ') -notmatch 'alpha') ($r.detail + @{ allowedAudit = $allowed })
        # A6
        $r = Plain 'Show me the first lines of .env' 'secret|did not read|never read|refus|outside|excluded'
        Set-Content -Encoding utf8 (Join-Path $OutDir 'hud-a6.txt') $r.full
        $all = Safe-HudText
        Record $N.a6 ($r.outcome -ne 'COMPLETED' -and ($all -notmatch [regex]::Escape($canary)) -and ($r.full -notmatch [regex]::Escape($canary))) ($r.detail + @{ canaryShownAnywhere = ($all -match [regex]::Escape($canary)) })
        # A7
        $r = Plain 'Show my saved notes about editor' 'memory\.read permission'
        Set-Content -Encoding utf8 (Join-Path $OutDir 'hud-a7.txt') $r.full
        Record $N.a7 ($r.matched -and ($r.full -match 'does not have the memory\.read permission') -and $r.full -notmatch 'Neovim' -and $r.outcome -ne 'COMPLETED') $r.detail
        # A8
        $deniedBefore = @(Read-Audit | Where-Object { $_.decision -eq 'denied' -and $_.permission -eq 'files.read' }).Count
        $v = Panel-Act '^REVOKE$' $false
        $ap = @(Read-Approved)
        $r = Plain 'Show me the first lines of docs/brief.txt' 'files\.read permission'
        $au = @(Read-Audit); $denied = @($au | Where-Object { $_.decision -eq 'denied' -and $_.permission -eq 'files.read' })
        Record $N.a8 ($v.cards -eq 0 -and (@($ap[0].granted) -join ',') -eq 'compute' -and ($r.full -match 'does not have the files\.read permission') -and $denied.Count -eq ($deniedBefore + 1)) @{ revokeCards = $v.cards; granted = @($ap[0].granted); deniedAudit = $denied.Count; refusedAgain = ($r.full -match 'does not have the files\.read permission') }
        # A9 (re-grant files.read first so a disabled plugin has something to prove, then disable)
        $g2 = Panel-Act '^GRANT$' $true $true
        $allowedBefore = @(Read-Audit | Where-Object { $_.decision -eq 'allowed' }).Count
        $dis = Panel-Act '^DISABLE$' $false
        $apD = @(Read-Approved); $tD = Panel-Text
        $r = Plain 'Show me the first lines of docs/brief.txt' ''
        $allowedWhileOff = @(Read-Audit | Where-Object { $_.decision -eq 'allowed' }).Count
        $en = Panel-Act '^ENABLE$' $false
        $apE = @(Read-Approved)
        Record $N.a9 ($apD[0].disabled -eq $true -and ($tD -match 'DISABLED') -and $allowedWhileOff -eq $allowedBefore -and ($apE[0].disabled -ne $true)) @{ disabledInList = $apD[0].disabled; panelShowsDisabled = ($tD -match 'DISABLED'); allowedUsesAfterDisable = $allowedWhileOff; ranWhileDisabled = ($r.full -match 'alpha line'); enabledAgain = ($apE[0].disabled -ne $true); grantedAfterRegrant = @($apD[0].granted) }
        # M1
        Panel-Open 'MEMORY'
        [void](Panel-Refresh); $t = Panel-Text
        $listed = $t -match 'Neovim'
        $idm = [regex]::Match($t, '\b([0-9a-f]{8})\b')
        $dbBefore = (Db-List).Count
        $tasksBefore = [regex]::Matches((Get-Content $script:daemonLog -Raw), ' accepted').Count
        $first = Click '^FORGET$'; Start-Sleep -Milliseconds 500
        $armed = Has-Btn '^CONFIRM\?$'
        # the panel's confirm window is 4 s: nothing slow may happen between the two clicks. Nothing ran after the first click if no task was accepted.
        $stillThere = ([regex]::Matches((Get-Content $script:daemonLog -Raw), ' accepted').Count -eq $tasksBefore) -and $dbBefore -eq 1
        $f = Panel-Act '^CONFIRM\?$' $false
        Record $N.m1 ($listed -and $idm.Success -and $armed -and $stillThere -and (Db-List).Count -eq 0) @{ listed = $listed; shortId = $idm.Value; armedAfterFirstClick = $armed; firstClickSent = $first.sent; firstClickAbort = $first.abortReason; nothingRanAfterFirstClick = $stillThere; dbAfter = (Db-List).Count; reply = ($f.result.text -split "`n" | Select-Object -First 4) -join ' | ' }
        # W1
        Panel-Open 'WORKFLOWS'
        [void](Panel-Refresh); $t = Panel-Text
        $both = ($t -match 'nightly') -and ($t -match 'dropme')
        $u = Panel-Act '^UNSCHEDULE$' $false
        $st = Read-Store; $nightly = $st | Where-Object { $_.Name -eq 'nightly' }
        $unsched = $nightly -and -not $nightly.Schedule -and @($st).Count -eq 2
        $d1 = Click '^DELETE$'; Start-Sleep -Milliseconds 600
        $t2 = $(if (Has-Btn '^CONFIRM\?$') { 'CONFIRM' } else { '' })
        # the first DELETE in the list is for the first workflow shown; remember which one is armed by deleting only dropme: look at the store afterwards
        $d2 = Panel-Act '^CONFIRM\?$' $false
        $st2 = Read-Store
        Record $N.w1 ($both -and $unsched -and (@($st2).Count -eq 1) -and ($st2 | Where-Object { $_.Name -eq 'dropme' }) -and ($t2 -match 'CONFIRM')) @{ bothListed = $both; nightlyUnscheduledOnly = $unsched; storeAfterDelete = @($st2 | ForEach-Object { $_.Name }); armedPrompt = ($t2 -match 'CONFIRM\?') }
    }
} catch {
    Record 'unexpected error' $false @{ error = "$($_.Exception.Message)" }
    Abort "unexpected error: $($_.Exception.Message)"
} finally {
    try {
        $errs = @(Select-String -Path $script:daemonLog -Pattern '\[(Plugins|Workflows|Memory)\].*(fail|error|exception)' -ErrorAction SilentlyContinue | ForEach-Object { $_.Line })
        Record $N.log ($errs.Count -eq 0) @{ errorLines = $errs }
    } catch { Record $N.log $false @{ error = "$_" } }
    try { if ($started) { & "$PSScriptRoot\stop-stack.ps1" -OutDir $OutDir | Out-Null } } catch { }
    foreach ($v in $names) { Remove-Item "Env:\DASK_AgentHost__$v" -ErrorAction SilentlyContinue }
    foreach ($k in $saved.Keys) { if ($null -ne $saved[$k]) { Set-Item "Env:\$k" $saved[$k] } else { Remove-Item "Env:\$k" -ErrorAction SilentlyContinue } }
    $f1 = FlagsOff
    $same = ((Sha $realApproved) -eq $realBefore.a) -and ((Sha $realDb) -eq $realBefore.d) -and ((Sha $realWf) -eq $realBefore.w)
    Record $N.end ($f1.ok -and $same) @{ flagsOff = $f1.ok; realStoresUnchanged = $same }
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
