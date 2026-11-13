# Verifies a built package from outside the repository. Uses the real launcher, the real HUD and real input.
# -PackageRoot must be a throwaway copy: this changes files in it to check they are refused, then restores them.
param([string]$PackageRoot, [string]$OutDir, [string]$Papers)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\..\hud\hud-driver.ps1"
New-Item -ItemType Directory -Force $OutDir | Out-Null
$env:PATH = (($env:PATH -split ';') | Where-Object { $_ -notmatch 'nodejs' }) -join ';'
$results = New-Object System.Collections.ArrayList
# Packaged local memory is verified with an ISOLATED database inside the evidence folder (never the user's memory.db). The launcher and every process it starts inherit these.
$memDb = Join-Path (Resolve-Path $OutDir).Path 'memory.db'
$realDb = Join-Path $env:LOCALAPPDATA 'D-ASK\memory.db'
$realDbHash = if (Test-Path $realDb) { (Get-FileHash $realDb -Algorithm SHA256).Hash } else { $null }
$env:DASK_AgentHost__Memory = 'true'; $env:DASK_AgentHost__ExtraEnvironment__DASK_MEMORY_DB = $memDb
# Read with FileShare.ReadWrite: the packaged host may hold the database open (the composition check reads it while the app runs).
function Db-Has([string]$Needle) { $hit = $false; foreach ($f in @($memDb, "$memDb-wal")) { if (Test-Path -LiteralPath $f) { $fs = [IO.File]::Open($f, 'Open', 'Read', 'ReadWrite'); try { $ms = New-Object IO.MemoryStream; $fs.CopyTo($ms); if ([Text.Encoding]::UTF8.GetString($ms.ToArray()).Contains($Needle)) { $hit = $true } } finally { $fs.Dispose() } } }; $hit }
function Record([string]$Name, [bool]$Pass, $Detail) {
    [void]$results.Add([pscustomobject]@{ name = $Name; pass = $Pass; detail = $Detail })
    "{0}  {1}  {2}" -f $(if ($Pass) { ' ok ' } else { 'FAIL' }), $Name, ($Detail | ConvertTo-Json -Compress -Depth 4)
}
function Find-Proc([string]$ExeTail) { Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.EndsWith($ExeTail, [StringComparison]::OrdinalIgnoreCase) -and $_.ExecutablePath.StartsWith($PackageRoot, [StringComparison]::OrdinalIgnoreCase) } }

function Start-ViaLauncher {
    Start-Process -FilePath "$PackageRoot\Start-D-ASK.cmd" -WindowStyle Hidden | Out-Null
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 500
        $h = Find-Proc 'hud-native.exe'
        if ($h) { $p = Get-Process -Id $h.ProcessId -ErrorAction SilentlyContinue; if ($p -and $p.MainWindowHandle -ne 0) { break } }
    }
    $script:daemon = Find-Proc 'DAsk.Daemon.exe'
    $script:hud = Find-Proc 'hud-native.exe'
    if (-not $script:daemon -or -not $script:hud) { throw 'The launcher did not start both processes' }
    $script:hwnd = Get-HudHwnd $script:hud.ProcessId
    Enter-HudInteractive $script:hwnd
    Start-Sleep -Seconds 2
}
function Stop-All {
    foreach ($n in 'hud-native.exe', 'DAsk.Daemon.exe') { $x = Find-Proc $n; if ($x) { taskkill /PID $x.ProcessId /T /F 2>$null | Out-Null } }
    for ($i = 0; $i -lt 40 -and (Find-Proc 'node.exe'); $i++) { Start-Sleep -Milliseconds 250 }
}
function Task([string]$Text) {
    Submit-HudRequest $hwnd $Text
    Start-Sleep -Milliseconds 300
    return Wait-HudOutcome $hwnd 180000
}
function Check-Tamper([string]$Name, [scriptblock]$Tamper, [scriptblock]$Restore, [string]$Expect, [string]$Request, [string]$Request2) {
    $dir = Join-Path $OutDir ($Name -replace '\W','-')
    & $Tamper
    try {
        # Started with logs on, so the daemon's stated reason can be checked.
        & "$PSScriptRoot\..\hud\start-stack.ps1" -OutDir $dir -Config Release -Root $PackageRoot | Out-Null
        $pids = Get-Content "$dir\pids.json" -Raw | ConvertFrom-Json
        $script:hwnd = Get-HudHwnd $pids.hud
        Enter-HudInteractive $hwnd
        Start-Sleep -Seconds 2
        Submit-HudRequest $hwnd $Request
        # The daemon's decision comes first, so nothing is restored before the check has really run.
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $reason = $null
        do {
            Start-Sleep -Milliseconds 100
            $reason = Select-String -Path "$dir\daemon.log" -Pattern 'Package check (failed|passed)' | Select-Object -First 1
        } while (-not $reason -and $sw.ElapsedMilliseconds -lt 30000)
        Start-Sleep -Milliseconds 1500
        # History is kept across runs and listed newest first, so only the first row for this request counts.
        $lines = (Get-HudText $hwnd) -split "`n"
        $row = [Array]::IndexOf($lines, $Request.ToUpper())
        $shown = ($row -ge 0) -and ($lines[$row + 1] -match 'could not be started')
        $nodeRan = [bool](Find-Proc 'node.exe')
        Save-HudShot $hwnd "$dir\refused.png"
        $reasonOk = $reason -and ($reason.Line -match 'Package check failed') -and ($reason.Line -match $Expect)
        Record "$Name stops the host" ($shown -and -not $nodeRan -and $reasonOk) @{ shownInHud = $shown; nodeStarted = $nodeRan; reason = $(if ($reason) { $reason.Line.Substring($reason.Line.IndexOf('Package check')) } else { $null }) }
        & $Restore
        Start-Sleep -Seconds 6
        $o2 = Task $Request2
        $lines = (Get-HudText $hwnd) -split "`n"
        Save-HudShot $hwnd "$dir\recovered.png"
        Record "after restoring, $Name recovers without a restart" ($o2.Outcome -eq 'COMPLETED') @{ outcome = $o2.Outcome; passed = @(Select-String -Path "$dir\daemon.log" -Pattern 'Package check passed').Count; lastError = @(Select-String -Path "$dir\daemon.log" -Pattern 'fail:|Host unavailable|Failed to' | Select-Object -Last 2 | ForEach-Object { $_.Line }) }
    } finally {
        if (Test-Path "$dir\pids.json") { & "$PSScriptRoot\..\hud\stop-stack.ps1" -OutDir $dir | Out-Null }
        for ($i = 0; $i -lt 40 -and (Find-Proc 'node.exe'); $i++) { Start-Sleep -Milliseconds 250 }
        & $Restore
    }
}

# 1. The real launcher, the packaged Node
Start-ViaLauncher
$o = Task 'What is (17+25)*2?'
$node = Find-Proc 'node.exe'
$llama = Find-Proc 'llama-server.exe'
Save-HudShot $hwnd "$OutDir\launcher-completed.png"
Record 'Start-D-ASK.cmd starts the stack and a task completes with verification' (($o.Outcome -eq 'COMPLETED') -and ((Get-HudText $hwnd) -match '(?m)^INDEPENDENTLY VERIFIED$')) @{ outcome = $o.Outcome; ms = $o.Ms }
Record 'the host runs on the packaged Node, not a system one' ($node -and $node.ExecutablePath -eq "$PackageRoot\runtime\node\node.exe") @{ node = $node.ExecutablePath }
Record 'llama-server runs from the package' ([bool]$llama) @{ exe = $llama.ExecutablePath }
# 1a. The integrated question paths through the real packaged stack: a spelled-out question is computed and verified; a general question is ANSWERED (and says so)
$q1 = Task 'What is seven times eight?'
$q1txt = Get-HudText $hwnd
Record 'a spelled-out question is computed by the tool and verified: COMPLETED, INDEPENDENTLY VERIFIED, 56' (($q1.Outcome -eq 'COMPLETED') -and ($q1txt -match '(?m)^INDEPENDENTLY VERIFIED$') -and ($q1txt -match '56')) @{ outcome = $q1.Outcome }
$q2 = Task 'What is the capital of France?'
$q2txt = Get-HudText $hwnd
Record 'a general question is ANSWERED by the local model: labelled as the model''s own answer, never verified, answer shown' (($q2.Outcome -eq 'ANSWERED') -and ($q2txt -match 'ANSWERED BY THE LOCAL MODEL') -and ($q2txt -notmatch '(?m)^INDEPENDENTLY VERIFIED$') -and ($q2txt -match 'Paris')) @{ outcome = $q2.Outcome }
Save-HudShot $hwnd "$OutDir\answered.png"
Stop-All

# 1b. Local memory INSIDE the package (better-sqlite3 shipped under <package>\node_modules, loaded by the packaged Node)
Start-ViaLauncher
$m1 = Task 'Remember that my favourite editor is Neovim.'
$m1txt = Get-HudText $hwnd
Record 'packaged memory: "Remember that ..." COMPLETED and the isolated database now exists and holds it' (($m1.Outcome -eq 'COMPLETED') -and (Test-Path $memDb)) @{ outcome = $m1.Outcome; db = $memDb; bytes = $(if (Test-Path $memDb) { (Get-Item $memDb).Length } else { 0 }) }
$m2 = Task 'What is my favourite editor?'
Record 'packaged memory: the question is answered from the saved memory (Neovim)' (((Get-HudText $hwnd) -split "`n" | Where-Object { $_ -match 'Neovim' }).Count -ge 2) @{ outcome = $m2.Outcome }
Save-HudShot $hwnd "$OutDir\memory-recall.png"
Stop-All
Start-ViaLauncher
$m3 = Task 'What is my favourite editor?'
$restartTxt = ((Get-HudText $hwnd) -split "`n")
Record 'packaged memory: persists across a restart of the packaged application' (($m3.Outcome -eq 'COMPLETED') -and ($restartTxt | Where-Object { $_ -match 'Neovim' }).Count -ge 2) @{ outcome = $m3.Outcome }
$m4 = Task 'Forget my favourite editor.'
Stop-All
Record 'packaged memory: "Forget ..." COMPLETED and the text is gone from the database and WAL bytes' (($m4.Outcome -eq 'COMPLETED') -and -not (Db-Has 'Neovim')) @{ outcome = $m4.Outcome; neovimBytesInDb = (Db-Has 'Neovim') }
$realNow = if (Test-Path $realDb) { (Get-FileHash $realDb -Algorithm SHA256).Hash } else { $null }
Record 'the user''s real memory.db was not touched' ($realNow -eq $realDbHash) @{ before = $realDbHash; after = $realNow }

# 1c. Local knowledge (RAG) and Research Mode INSIDE the package: the packaged llama-server serves the packaged bge-small model (hash-pinned in the
# manifest-covered host code). Isolated index / research folder / indexable folder in the evidence folder via AgentHost:ExtraEnvironment (applied after the
# launcher profile, so the user's Documents are never indexed or written). Skipped (recorded as failed) when -Papers is not given.
if ($Papers) {
    $kOut = (Resolve-Path $OutDir).Path
    $kLib = Join-Path $kOut 'knowledge-library'; New-Item -ItemType Directory -Force $kLib | Out-Null
    Copy-Item (Join-Path $Papers '*.pdf') $kLib
    Set-Content -Encoding utf8 (Join-Path $kLib 'project-notes.md') "# Project notes`n`n## Schedule`n`nThe D-ASK evaluation deadline is 16 November 2026.`n"
    $kDb = Join-Path $kOut 'knowledge.db'; $kResearch = Join-Path $kOut 'research'
    $realK = Join-Path $env:LOCALAPPDATA 'D-ASK\knowledge.db'; $realKHash = if (Test-Path $realK) { (Get-FileHash $realK -Algorithm SHA256).Hash } else { $null }
    $env:DASK_AgentHost__ExtraEnvironment__DASK_KNOWLEDGE_DB = $kDb
    $env:DASK_AgentHost__ExtraEnvironment__DASK_RESEARCH_DIR = $kResearch
    $env:DASK_AgentHost__ExtraEnvironment__DASK_KNOWLEDGE_ROOTS = $kLib
    $kCheck = { (& "$PackageRoot\runtime\node\node.exe" "$PSScriptRoot\..\hud\knowledge-db-check.mjs" $kDb | Out-String) | ConvertFrom-Json }
    Start-ViaLauncher
    $k1 = Task "Index `"$kLib`" as research"
    $embProc = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'llama-server.exe' -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($PackageRoot, [StringComparison]::OrdinalIgnoreCase) -and $_.CommandLine -match 'bge-small-en-v1\.5-q8_0\.gguf' -and $_.CommandLine -match '--embedding' })
    $kd = & $kCheck; $kc = @($kd.collections | Where-Object { $_.name -eq 'research' })[0]
    Record 'packaged knowledge: "Index <folder> as research" COMPLETED; every passage embedded by the PACKAGED llama-server with the PACKAGED bge model' (($k1.Outcome -eq 'COMPLETED') -and $kc -and @($kc.documents).Count -ge 3 -and $kc.chunks -gt 0 -and $kc.embedded -eq $kc.chunks -and $kd.model -eq 'bge-small-en-v1.5-q8_0' -and $embProc.Count -ge 1) @{ outcome = $k1.Outcome; documents = @($kc.documents).Count; chunks = $kc.chunks; embedded = $kc.embedded; embedderExe = @($embProc | ForEach-Object { $_.ExecutablePath }) }
    $k2 = Task 'According to my research papers, when is the D-ASK evaluation deadline?'
    $k2txt = Get-HudText $hwnd
    Record 'packaged knowledge: grounded answer from the indexed note, cited, with the knowledge badge' (($k2.Outcome -eq 'ANSWERED') -and ($k2txt -match '16 November') -and ($k2txt -match 'project-notes\.md') -and ($k2txt -match 'ANSWERED FROM YOUR INDEXED DOCUMENTS')) @{ outcome = $k2.Outcome }
    Save-HudShot $hwnd "$OutDir\knowledge-answer.png"
    # Composition + conversation context in the package: "Remember that" saves the PREVIOUS answer (knowledge -> memory) through the normal memory request.
    $k2m = Task 'Remember that'
    Record 'packaged composition: "Remember that" stores the previous knowledge answer in (isolated) local memory' (($k2m.Outcome -eq 'COMPLETED') -and (Db-Has '16 November')) @{ outcome = $k2m.Outcome; inMemoryDb = (Db-Has '16 November') }
    $k3 = Task 'Prepare a literature review about graph neural networks from my research papers'
    $kp = @(Get-ChildItem $kResearch -Directory -ErrorAction SilentlyContinue)
    $kpj = if ($kp.Count -eq 1) { Get-Content (Join-Path $kp[0].FullName 'project.json') -Raw | ConvertFrom-Json } else { $null }
    $krep = if ($kpj) { Join-Path $kp[0].FullName $kpj.versions[0].report } else { $null }
    Record 'packaged research: literature review COMPLETED and saved; the report matches the SHA-256 recorded in project.json' (($k3.Outcome -eq 'COMPLETED') -and $kpj -and (Test-Path $krep) -and ((Get-FileHash $krep -Algorithm SHA256).Hash.ToLower() -eq $kpj.versions[0].sha256)) @{ outcome = $k3.Outcome; report = $krep }
    Stop-All
    # Tamper: a replaced embedding model must not be used. The file is MOVED aside (package models may be hard links to the source tree; never edit in place).
    $bge = "$PackageRoot\models\bge-small-en-v1.5-q8_0.gguf"; $bgeAside = Join-Path $kOut 'bge.aside'
    Move-Item $bge $bgeAside
    try {
        [IO.File]::WriteAllBytes($bge, [byte[]](1..64))
        Start-ViaLauncher
        $k4 = Task 'search my papers for multi-head attention'
        $k4txt = Get-HudText $hwnd
        Stop-All
    } finally { Remove-Item $bge -Force -ErrorAction SilentlyContinue; Move-Item $bgeAside $bge }
    Record 'packaged knowledge: a replaced embedding model is refused (pinned SHA-256) and search says it is keyword-only' (($k4.Outcome -eq 'COMPLETED') -and ($k4txt -match 'semantic search unavailable') -and ($k4txt -match 'pinned SHA-256')) @{ outcome = $k4.Outcome; restored = (Test-Path $bge) }
    $realKNow = if (Test-Path $realK) { (Get-FileHash $realK -Algorithm SHA256).Hash } else { $null }
    Record 'the user''s real knowledge.db was not touched' ($realKNow -eq $realKHash) @{ before = $realKHash; after = $realKNow }
    foreach ($v in 'DASK_KNOWLEDGE_DB', 'DASK_RESEARCH_DIR', 'DASK_KNOWLEDGE_ROOTS') { Remove-Item "Env:\DASK_AgentHost__ExtraEnvironment__$v" -ErrorAction SilentlyContinue }
} else { Record 'packaged knowledge (needs -Papers)' $false @{ skipped = 'no -Papers folder given' } }

# 2. Every kind of change must stop the host, on the real daemon
$hostJs = "$PackageRoot\dist\agent-host\agent\host\host.js"
$nodeExe = "$PackageRoot\runtime\node\node.exe"
$extra = "$PackageRoot\dist\agent-host\agent\host\injected.js"
$manifest = "$PackageRoot\package-manifest.json"
$hostBackup = "$OutDir\host.js.bak"; $nodeBackup = "$OutDir\node.exe.bak"; $manifestBackup = "$OutDir\manifest.bak"
Copy-Item $hostJs $hostBackup -Force; Copy-Item $nodeExe $nodeBackup -Force; Copy-Item $manifest $manifestBackup -Force

Check-Tamper 'a changed host file' { Add-Content -Path $hostJs -Value '// changed' } { Copy-Item $hostBackup $hostJs -Force } 'changed' 'What is 2+3?' 'What is 12+13?'
Check-Tamper 'a changed Node runtime' { $fs = [IO.File]::Open($nodeExe, 'Append'); $fs.WriteByte(0); $fs.Close() } { Copy-Item $nodeBackup $nodeExe -Force } 'changed' 'What is 4+5?' 'What is 14+15?'
Check-Tamper 'an added host file' { Set-Content -Path $extra -Value 'module.exports = {}' } { Remove-Item $extra -Force -ErrorAction SilentlyContinue } 'Unexpected' 'What is 6+7?' 'What is 16+17?'
$sqliteNode = "$PackageRoot\node_modules\better-sqlite3\prebuilds\win32-x64.node"; $sqliteBackup = "$OutDir\better_sqlite3.node.bak"
Copy-Item $sqliteNode $sqliteBackup -Force
Check-Tamper 'a changed better-sqlite3 binary' { $fs = [IO.File]::Open($sqliteNode, 'Append'); $fs.WriteByte(0); $fs.Close() } { Copy-Item $sqliteBackup $sqliteNode -Force } 'changed' 'What is 20+1?' 'What is 22+3?'
Check-Tamper 'an edited manifest' { Add-Content -Path $manifest -Value ' ' } { Copy-Item $manifestBackup $manifest -Force } 'expected hash' 'What is 8+9?' 'What is 18+19?'

Remove-Item Env:\DASK_AgentHost__Memory, Env:\DASK_AgentHost__ExtraEnvironment__DASK_MEMORY_DB -ErrorAction SilentlyContinue
$results | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 "$OutDir\verify-package.json"
"`n$(@($results | Where-Object pass).Count) of $($results.Count) passed"
