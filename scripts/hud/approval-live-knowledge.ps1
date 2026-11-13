# Real-HUD acceptance for LOCAL KNOWLEDGE (RAG) and RESEARCH MODE.
# Requests are typed into the REAL HUD (real daemon, real agent host, real bge-small embedder, real local Qwen). The knowledge index, the research
# folder and the indexable folder are all inside -OutDir (DASK_KNOWLEDGE_DB / DASK_RESEARCH_DIR / DASK_KNOWLEDGE_ROOTS via AgentHost:ExtraEnvironment).
# The index is checked independently (knowledge-db-check.mjs, read-only SQLite, not the product's store code); the report file is re-hashed here.
# The stack is restarted once with the SAME index to prove persistence. The user's real knowledge.db and Documents\D-ASK\Research are hashed before/after.
#   powershell -ExecutionPolicy Bypass -File scripts\hud\approval-live-knowledge.ps1 -OutDir results\knowledge-hud\live-<stamp> -Papers <folder with PDFs>
param([Parameter(Mandatory = $true)][string]$OutDir, [Parameter(Mandatory = $true)][string]$Papers, [string]$Root, [string]$Config = 'Debug')
$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = (Resolve-Path "$PSScriptRoot\..\..").Path }
if ((Test-Path $OutDir) -and @(Get-ChildItem $OutDir -Force).Count -gt 0) { throw "OutDir must be new or empty: $OutDir" }
New-Item -ItemType Directory -Force $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path
$keepOut = $OutDir; $keepRoot = $Root; $keepConfig = $Config; $keepPapers = (Resolve-Path $Papers).Path
. "$PSScriptRoot\approval-live-7b3.ps1" -OutDir $keepOut -Root $keepRoot -Config $keepConfig -LoadFunctionsOnly
$OutDir = $keepOut; $Root = $keepRoot; $Config = $keepConfig; $Papers = $keepPapers
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

$script:ExpectedChecks = 13
$N = [ordered]@{
    setup = 'Z1 setup: real HUD handshook with the real daemon; isolated index, research folder and indexable folder inside OutDir'
    pre   = 'Z2 memory preflight: the local model would be admitted with the HUD running (guard unchanged)'
    k1 = 'K1 "Index <papers> as research": COMPLETED + verified in the HUD; the index holds the PDFs with every passage embedded (independent read)'
    k2 = 'K2 incremental: a new note is added, "Refresh the collection research" reports 1 indexed and the PDFs unchanged; the index holds one more document'
    k3 = 'K3 grounded answer: ANSWERED with the knowledge badge, a Sources list and a page citation into the GraphSAGE PDF'
    k4 = 'K4 a fact only in the new note is answered from it and cited to that note'
    k5 = 'K5 insufficient evidence: an unrelated question is reported as not answerable from the documents (no source presented as support)'
    k6 = 'K6 literature review: COMPLETED in the HUD; the report exists in the research folder, has evidence and sources, and matches the SHA-256 in project.json'
    k7 = 'K7 RESTART (new daemon + HUD, same index): the collection and the research project are still listed'
    k8 = 'K8 MANAGE panel (real clicks): KNOWLEDGE tab REFRESH shows the research collection with SEMANTIC + KEYWORD; RESEARCH tab REFRESH shows the project'
    k9 = 'K9 MANAGE panel REMOVE FROM INDEX (two clicks): the collection is gone from the index; the PDFs on disk are untouched'
    log = 'L1 no knowledge error in either daemon log'
    end = 'Z3 end state: the user''s real knowledge.db and Documents\D-ASK\Research are unchanged'
}
function Restore-HudFront {
    if ([HudInput]::GetForegroundWindow() -eq $script:hwnd) { return }
    if ((Get-HudMode $script:hwnd) -eq 'interactive') { Send-HudToggleHotkey; try { [void](Wait-HudMode $script:hwnd 'ambient' 3000) } catch { } }
    Enter-HudInteractive $script:hwnd
    Assert-HudForeground $script:hwnd
    Start-Sleep -Milliseconds 1200
    [void](Find-HudElement $script:hwnd -AutomationId 'ultron-command' -TimeoutMs 8000)
}
function Next-Request([string]$Text) {
    if ((Wait-PanelClosed) -lt 0) { Abort 'the previous approval panel did not close'; return $null }
    Restore-HudFront
    return Invoke-Request $Text
}
function Plain([string]$Text, [string]$ResultPattern, [int]$TimeoutMs = 300000) {
    $s = Next-Request $Text
    if (-not $s -or -not $s.Ok) { return [pscustomobject]@{ ok = $false; outcome = $null; matched = $false; cards = 0; full = ''; detail = @{ submit = $(if ($s) { $s.Record } else { $null }) } } }
    $r = Wait-NewResult $s.Marks $ResultPattern $TimeoutMs 20000
    $cards = [regex]::Matches((Read-LogSince $script:hudLog $s.Marks.hud), 'Approval surface opened for').Count
    return [pscustomobject]@{ ok = $r.arrived; outcome = $r.outcome; matched = $r.matched; cards = $cards; full = [string]$r.text; ms = $r.msToArrive; detail = @{ outcome = $r.outcome; matched = $r.matched; cards = $cards; msToArrive = $r.msToArrive } }
}
function Sha([string]$Path) { if (Test-Path -LiteralPath $Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLower() } else { $null } }
function DirState([string]$Path) { if (Test-Path -LiteralPath $Path) { @(Get-ChildItem -LiteralPath $Path -Recurse -File | ForEach-Object { "$($_.FullName)|$($_.Length)|$($_.LastWriteTimeUtc.Ticks)" }) -join "`n" } else { '<absent>' } }
function Db { try { Push-Location $Root; (& node scripts/hud/knowledge-db-check.mjs $db 2>&1 | Out-String) | ConvertFrom-Json } finally { Pop-Location } }
function Coll($d, [string]$Name) { if ($d.exists) { @($d.collections | Where-Object { $_.name -eq $Name })[0] } else { $null } }
function Panel-Text { Normalize (Safe-HudText) }
function Has-Btn([string]$Pattern) { try { [void](Find-HudButton $script:hwnd $Pattern 1500); $true } catch { $false } }
function Click([string]$Pattern) { Restore-HudFront; Invoke-GuardedClick -Label $Pattern -ButtonPattern $Pattern -WaitEnabled }
function Panel-Open([string]$Tab) {
    # Get-HudText returns Text elements only (never buttons), so the panel is detected by its tab BUTTON, not by words that chat history may also contain.
    if (-not (Has-Btn "^$Tab$")) { [void](Click '^MANAGE( ▾)?$'); Start-Sleep -Milliseconds 700 }
    [void](Click "^$Tab$"); Start-Sleep -Milliseconds 500
}
function Panel-Refresh { $m = Mark-Logs; [void](Click '^REFRESH$'); $r = Wait-NewResult $m $null 240000 20000; Start-Sleep -Milliseconds 900; $r }
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
function Save([string]$Name, [string]$Text) { Set-Content -Encoding utf8 (Join-Path $OutDir $Name) $Text }

# ---- the run's own world ----
$lib = Join-Path $OutDir 'library'; $paperDir = Join-Path $lib 'papers'
New-Item -ItemType Directory -Force $paperDir | Out-Null
Copy-Item (Join-Path $Papers '*.pdf') $paperDir
$pdfs = @(Get-ChildItem $paperDir -Filter *.pdf)
$pdfHashes = @{}; foreach ($p in $pdfs) { $pdfHashes[$p.Name] = Sha $p.FullName }
$db = Join-Path $OutDir 'knowledge.db'
$researchDir = Join-Path $OutDir 'research'
$realDb = Join-Path $env:LOCALAPPDATA 'D-ASK\knowledge.db'
$realResearch = Join-Path $env:USERPROFILE 'Documents\D-ASK\Research'
$realDbBefore = Sha $realDb; $realResearchBefore = DirState $realResearch
$run1 = $null; $run2 = $null
try {
    $env:DASK_AgentHost__ExtraEnvironment__DASK_KNOWLEDGE_DB = $db
    $env:DASK_AgentHost__ExtraEnvironment__DASK_RESEARCH_DIR = $researchDir
    $env:DASK_AgentHost__ExtraEnvironment__DASK_KNOWLEDGE_ROOTS = $lib
    $run1 = Start-Run 'run1'
    Record $N.setup ($run1.handshake -and $pdfs.Count -ge 2) @{ db = $db; research = $researchDir; root = $lib; pdfs = @($pdfs.Name); daemonPid = $run1.pids.daemon; hudPid = $run1.pids.hud }
    try {
        $adm = Get-ModelMemoryAdmission $Root; $mp = Test-ModelMemoryPreflight $adm
        [pscustomobject]@{ utc = (Get-Utc); measurement = $adm; decision = $mp } | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 (Join-Path $OutDir 'memory-preflight.json')
        Record $N.pre $mp.ok @{ availableMB = $adm.availableMB; requiredMB = $adm.requiredMB }
        if (-not $mp.ok) { Abort $mp.reason }
    } catch { Record $N.pre $false @{ error = "$_" }; Abort "memory preflight failed: $_" }

    if (-not $script:Aborted) {
        # K1 index
        $r = Plain "Index `"$paperDir`" as research" 'Indexing finished'
        Save 'hud-k1.txt' $r.full
        $d = Db; $c = Coll $d 'research'
        $docs = if ($c) { @($c.documents) } else { @() }
        Record $N.k1 ($r.ok -and $r.outcome -eq 'COMPLETED' -and $r.full -match 'INDEPENDENTLY VERIFIED' -and $docs.Count -eq $pdfs.Count -and @($docs | Where-Object { $_.status -ne 'indexed' }).Count -eq 0 -and $c.chunks -gt 0 -and $c.embedded -eq $c.chunks) ($r.detail + @{ model = $d.model; docs = $docs; chunks = $c.chunks; embedded = $c.embedded })

        # K2 incremental
        Set-Content -Encoding utf8 (Join-Path $paperDir 'project-notes.md') "# Project notes`n`n## Schedule`n`nThe D-ASK evaluation deadline is 16 November 2026, and the viva is held in room B-214.`n"
        $r = Plain 'Refresh the collection research' 'Indexing finished'
        Save 'hud-k2.txt' $r.full
        $d2 = Db; $c2 = Coll $d2 'research'
        $lastRun = @($d2.runs)[-1]
        Record $N.k2 ($r.ok -and $r.outcome -eq 'COMPLETED' -and (Normalize $r.full) -match "1 indexed, $($pdfs.Count) unchanged" -and @($c2.documents).Count -eq $pdfs.Count + 1 -and $lastRun.indexed -eq 1 -and $lastRun.unchanged -eq $pdfs.Count) ($r.detail + @{ lastRun = $lastRun; documents = @($c2.documents).Count })

        # K3 grounded answer
        $r = Plain "According to my research papers, how does GraphSAGE aggregate features from a node's neighbours?" 'Sources:'
        Save 'hud-k3.txt' $r.full
        $t = Normalize $r.full
        Record $N.k3 ($r.ok -and $r.outcome -eq 'ANSWERED' -and $t -match 'ANSWERED FROM YOUR INDEXED DOCUMENTS' -and $t -match '\[\d\] [^\[]*1706\.02216\.pdf, p\. \d+') ($r.detail + @{ badge = ($t -match 'ANSWERED FROM YOUR INDEXED DOCUMENTS'); citation = ([regex]::Match($t, '\[\d\] [^\[]{0,160}1706\.02216\.pdf, p\. \d+[^\]]{0,80}').Value) })

        # K4 fact only in the new note
        $r = Plain 'According to my research papers, when is the D-ASK evaluation deadline?' 'project-notes\.md'
        Save 'hud-k4.txt' $r.full
        $t = Normalize $r.full
        Record $N.k4 ($r.ok -and $r.outcome -eq 'ANSWERED' -and $t -match '16 November' -and $t -match 'Sources: \[\d\] [^\[]*project-notes\.md') ($r.detail + @{ excerpt = ([regex]::Match($t, '.{0,200}project-notes\.md.{0,60}').Value) })

        # K5 insufficient evidence
        $r = Plain 'According to my research papers, what is the boiling point of water on Mars?' "couldn't find enough"
        Save 'hud-k5.txt' $r.full
        $t = Normalize $r.full
        Record $N.k5 ($r.ok -and $r.outcome -eq 'ANSWERED' -and $r.matched -and $t -match 'Closest passages:') ($r.detail + @{ excerpt = ([regex]::Match($t, "I couldn't find enough.{0,240}").Value) })

        # K6 literature review
        $r = Plain 'Prepare a literature review about graph neural networks from my research papers' 'Report:'
        Save 'hud-k6.txt' $r.full
        $proj = @(Get-ChildItem $researchDir -Directory -ErrorAction SilentlyContinue)
        $pj = if ($proj.Count -eq 1) { Get-Content (Join-Path $proj[0].FullName 'project.json') -Raw | ConvertFrom-Json } else { $null }
        $rep = if ($pj) { Join-Path $proj[0].FullName $pj.versions[0].report } else { $null }
        $repText = if ($rep -and (Test-Path $rep)) { Get-Content $rep -Raw } else { '' }
        if ($rep -and (Test-Path $rep)) { Copy-Item $rep (Join-Path $OutDir 'report-k6.md') }
        Record $N.k6 ($r.ok -and $r.outcome -eq 'COMPLETED' -and $pj -and (Sha $rep) -eq $pj.versions[0].sha256 -and $repText -match '## Evidence table' -and $repText -match '\[D1\]' -and $repText -match 'No online sources were consulted' -and $pj.versions[0].sources -ge 2) ($r.detail + @{ project = $pj; reportShaMatches = ($pj -and (Sha $rep) -eq $pj.versions[0].sha256) })

        # K7 restart with the same index
        try { & "$PSScriptRoot\stop-stack.ps1" -OutDir $run1.dir | Out-Null } catch { }
        Start-Sleep -Seconds 4
        $run2 = Start-Run 'run2'
        $r = if ($run2.handshake) { Plain 'List my knowledge collections.' 'research \[research\]' } else { [pscustomobject]@{ ok = $false; full = ''; detail = @{ handshake = $false } } }
        Save 'hud-k7a.txt' $r.full
        $ra = $r
        $r = if ($run2.handshake) { Plain 'List research projects.' 'Research projects:' } else { [pscustomobject]@{ ok = $false; full = ''; detail = @{} } }
        Save 'hud-k7b.txt' $r.full
        $t = Normalize $ra.full
        Record $N.k7 ($run2.handshake -and $run2.pids.daemon -ne $run1.pids.daemon -and $ra.ok -and $t -match "research \[research\] — $($pdfs.Count + 1) document\(s\)" -and $r.ok -and (Normalize $r.full) -match 'graph neural networks — Literature review') (@{ list = $ra.detail; projects = $r.detail; oldDaemon = $run1.pids.daemon; newDaemon = $run2.pids.daemon })

        # K8 MANAGE panel
        try {
            Panel-Open 'KNOWLEDGE'
            $rf = Panel-Refresh
            $pt = Panel-Text; Save 'hud-k8-knowledge.txt' $pt
            # Panel row format only ("·", the tag); the chat reply uses "—" and ",". Button labels are checked as buttons.
            # React renders "[{kind}]" as three text nodes, which UI Automation reports as "[ research ]".
            $okK = ($pt -match "research \[ ?research ?\] $($pdfs.Count + 1) document\(s\) · \d+ passage\(s\) SEMANTIC \+ KEYWORD") -and (Has-Btn '^REFRESH INDEX$') -and (Has-Btn '^REMOVE FROM INDEX$')
            Panel-Open 'RESEARCH'
            $rf2 = Panel-Refresh
            $pt2 = Panel-Text; Save 'hud-k8-research.txt' $pt2
            $okR = ($pt2 -match 'graph neural networks Literature review 1 version\(s\) \d+ source\(s\)') -and (Has-Btn '^UPDATE \(NEW VERSION\)$') -and (Has-Btn '^SHOW$')
            Record $N.k8 ($okK -and $okR) @{ knowledge = $okK; research = $okR; refresh1 = $rf.outcome; refresh2 = $rf2.outcome }
        } catch { Record $N.k8 $false @{ error = "$_" } }

        # K9 remove from index via the panel (second click confirms)
        try {
            Panel-Open 'KNOWLEDGE'
            [void](Panel-Refresh)
            [void](Click '^REMOVE FROM INDEX$'); Start-Sleep -Milliseconds 400
            $m = Mark-Logs
            [void](Click '^CONFIRM\?$')
            $rr = Wait-NewResult $m 'Removed the collection' 120000 20000
            Start-Sleep -Milliseconds 1500
            Save 'hud-k9.txt' $rr.text
            $d9 = Db
            $pdfsOk = @($pdfs | Where-Object { (Sha $_.FullName) -eq $pdfHashes[$_.Name] }).Count -eq $pdfs.Count
            Record $N.k9 ($rr.arrived -and $rr.matched -and -not (Coll $d9 'research') -and $pdfsOk) @{ outcome = $rr.outcome; collections = @($d9.collections | ForEach-Object { $_.name }); pdfsUnchanged = $pdfsOk }
        } catch { Record $N.k9 $false @{ error = "$_" } }
    }
} catch {
    Record 'unexpected error' $false @{ error = "$($_.Exception.Message)" }
    Abort "unexpected error: $($_.Exception.Message)"
} finally {
    try {
        $errs = @()
        foreach ($dn in 'run1', 'run2') { $lp = Join-Path (Join-Path $OutDir $dn) 'daemon.log'; if (Test-Path $lp) { $errs += @(Select-String -Path $lp -Pattern '(?i)knowledge (unavailable|task failed)|embedder exited \(code [1-9]|embedding (request failed|server)' | ForEach-Object { $_.Line }) } }
        Record $N.log ($errs.Count -eq 0) @{ errorLines = $errs }
    } catch { Record $N.log $false @{ error = "$_" } }
    foreach ($rn in $run2, $run1) { try { if ($rn -and (Get-Process -Id $rn.pids.daemon -ErrorAction SilentlyContinue)) { & "$PSScriptRoot\stop-stack.ps1" -OutDir $rn.dir | Out-Null } } catch { } }
    foreach ($v in 'DASK_KNOWLEDGE_DB', 'DASK_RESEARCH_DIR', 'DASK_KNOWLEDGE_ROOTS') { Remove-Item "Env:\DASK_AgentHost__ExtraEnvironment__$v" -ErrorAction SilentlyContinue }
    Record $N.end (((Sha $realDb) -eq $realDbBefore) -and ((DirState $realResearch) -eq $realResearchBefore)) @{ realKnowledgeDbUnchanged = ((Sha $realDb) -eq $realDbBefore); realResearchUnchanged = ((DirState $realResearch) -eq $realResearchBefore) }
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
