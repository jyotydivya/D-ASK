# Wi-Fi-OFF acceptance of universal Windows control (real Windows, real applications), run through the radio wrapper:
#   powershell -ExecutionPolicy Bypass -File D:\D-ASK\D-ASK\scripts\hud\run-offline-acceptance-7b3.ps1 -AcceptanceScript offline-universal-control-acceptance.ps1 -ScriptTimeoutMin 15
#
# Requires the daemon tests built (dotnet build tests\DAsk.Daemon.Tests). Runs, with DASK_LIVE_OFFLINE=1:
#   1. UniversalAppLaunchLiveTests: Word, Chrome, VS Code, Excel launch; Chrome web search REFUSED (offline mode); VS Code project; Settings
#      -> Display; running applications; Emergency Stop; Resume (wrong generation refused); Terminal.
#   2. OfficeDocumentLiveTests: a Word document and an Excel workbook created in Documents, read back from the files.
#   3. tests\agent-runtime\pdf-summary.live.ts: find a PDF (real research papers, copied) and summarise it; quotes re-verified.
# Network monitor: every process descended from THIS script, every 300 ms. Connections of D-ASK's own processes (PowerShell, dotnet and its
# test host, node) must be ZERO; connection attempts of applications D-ASK launched at the user's request (Word, Chrome, ...) and their
# descendants are recorded separately (that is the application's own behaviour, not D-ASK's).
# Exit 0 only if: offline before and after, every capability passed, and D-ASK made no non-loopback connection.
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\offline-preflight.ps1"
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
$stamp = (Get-Date).ToString('yyyyMMddTHHmmss')
$out = Join-Path $root "results\universal-control\offline-$stamp"
New-Item -ItemType Directory -Force $out | Out-Null
$before = Get-OfflineEvidence; $d0 = Test-OfflineEvidence $before
[pscustomobject]@{ evidence = $before; decision = $d0 } | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $out 'network-before.json')
if (-not $d0.offline) { Write-OfflineDecision $d0 $before; Write-Host 'Online: the acceptance was NOT run.' -ForegroundColor Red; exit 2 }

$connFile = Join-Path $out 'connections.txt'
$monitor = Start-Job -ArgumentList $connFile, $PID -ScriptBlock {
    param($file, $rootPid)
    $own = @('powershell.exe', 'pwsh.exe', 'dotnet.exe', 'testhost.exe', 'node.exe', 'conhost.exe', 'cmd.exe', 'esbuild.exe')
    $seen = @{}
    while ($true) {
        $procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
        $kids = @{}; foreach ($p in $procs) { $k = [int]$p.ParentProcessId; if (-not $kids.ContainsKey($k)) { $kids[$k] = @() }; $kids[$k] += $p }
        $class = @{}; $names = @{}
        $self = $procs | Where-Object { $_.ProcessId -eq $rootPid } | Select-Object -First 1
        $stack = New-Object System.Collections.Stack
        if ($self) { $stack.Push(@($self, 'dask')) }
        while ($stack.Count) {
            $item = $stack.Pop(); $p = $item[0]; $cls = $item[1]
            if ($class.ContainsKey([int]$p.ProcessId)) { continue }
            $class[[int]$p.ProcessId] = $cls; $names[[int]$p.ProcessId] = $p.Name
            foreach ($c in @($kids[[int]$p.ProcessId])) {
                if ($null -eq $c) { continue }
                # A reused parent id is not descent: the child must not be older than its parent.
                if ($c.CreationDate -is [datetime] -and $p.CreationDate -is [datetime] -and $c.CreationDate -lt $p.CreationDate) { continue }
                $childCls = if ($cls -eq 'app' -or $own -notcontains $c.Name) { 'app' } else { 'dask' }
                $stack.Push(@($c, $childCls))
            }
        }
        foreach ($t in @(Get-NetTCPConnection -ErrorAction SilentlyContinue) + @(Get-NetUDPEndpoint -ErrorAction SilentlyContinue | Where-Object { $_.RemoteAddress })) {
            $procId = [int]$t.OwningProcess
            if (-not $class.ContainsKey($procId)) { continue }
            $remote = "$($t.RemoteAddress)"
            if (-not $remote -or $remote -match '^(127\.|::1$|0\.0\.0\.0$|::$)') { continue }
            $key = "$($class[$procId])|$($names[$procId])|$remote|$($t.RemotePort)|$($t.State)"
            if (-not $seen.ContainsKey($key)) { $seen[$key] = 1; Add-Content -Path $file -Value "$((Get-Date).ToString('o')) $key pid=$procId" }
        }
        Start-Sleep -Milliseconds 300
    }
}

$results = [ordered]@{}
function Run-Step([string]$Name, [scriptblock]$Body) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $ErrorActionPreference = 'Continue'
    $log = & $Body 2>&1 | ForEach-Object { "$_" }
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    $log | Set-Content -Encoding utf8 (Join-Path $out "$Name.log")
    $results[$Name] = [ordered]@{ exitCode = $code; seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1) }
    Write-Host "$Name exit $code in $($results[$Name].seconds) s"
}

try {
    $env:DASK_LIVE_APPS = '1'; $env:DASK_LIVE_OFFLINE = '1'
    $env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'; $env:DOTNET_NOLOGO = '1'; $env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'
    $startedAt = Get-Date
    Run-Step 'daemon-live' {
        dotnet test "$root\tests\DAsk.Daemon.Tests\DAsk.Daemon.Tests.csproj" --nologo -v q --no-build --no-restore `
            --filter "FullyQualifiedName~UniversalAppLaunchLive|FullyQualifiedName~OfficeDocumentLive" `
            --logger "trx;LogFileName=daemon-live.trx" --results-directory $out --blame-hang-timeout 400s --blame-hang-dump-type none
    }
    $lib = Join-Path $out 'pdf-library'
    New-Item -ItemType Directory -Force $lib | Out-Null
    Copy-Item (Join-Path $root 'results\offline-voice-chain\20261113T214254\voice-chain\library\*.pdf') $lib   # a copy: the evidence folder is only read
    $tsx = Get-ChildItem "$env:LOCALAPPDATA\npm-cache\_npx\*\node_modules\tsx\dist\cli.mjs" -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $tsx) { throw 'tsx is not available locally (npm cache); the PDF step cannot run offline' }
    Run-Step 'pdf-summary' { node $tsx.FullName "$root\tests\agent-runtime\pdf-summary.live.ts" $lib (Join-Path $out 'pdf-summary.json') }
} finally {
    Start-Sleep -Seconds 2
    Stop-Job $monitor -ErrorAction SilentlyContinue; Remove-Job $monitor -Force -ErrorAction SilentlyContinue
    Remove-Item Env:\DASK_LIVE_APPS, Env:\DASK_LIVE_OFFLINE -ErrorAction SilentlyContinue
}

$after = Get-OfflineEvidence; $d1 = Test-OfflineEvidence $after
[pscustomobject]@{ evidence = $after; decision = $d1 } | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $out 'network-after.json')
$lines = if (Test-Path $connFile) { @(Get-Content $connFile) } else { @() }
$daskConn = @($lines | Where-Object { $_ -match ' dask\|' })
$appConn = @($lines | Where-Object { $_ -match ' app\|' })

# Per-capability verdicts from the evidence the live tests wrote.
$uc = Get-ChildItem (Join-Path $root 'results\universal-control') -Directory | Where-Object { $_.Name -match '^\d{8}T\d{6}$' -and $_.CreationTime -ge $startedAt } | Sort-Object CreationTime | Select-Object -Last 1
$of = Get-ChildItem (Join-Path $root 'results\universal-control') -Directory | Where-Object { $_.Name -like 'office-*' -and $_.CreationTime -ge $startedAt } | Sort-Object CreationTime | Select-Object -Last 1
$steps = if ($uc -and (Test-Path (Join-Path $uc.FullName 'acceptance.json'))) { Get-Content (Join-Path $uc.FullName 'acceptance.json') -Raw | ConvertFrom-Json } else { @() }
$office = if ($of -and (Test-Path (Join-Path $of.FullName 'office.json'))) { Get-Content (Join-Path $of.FullName 'office.json') -Raw | ConvertFrom-Json } else { $null }
$pdf = if (Test-Path (Join-Path $out 'pdf-summary.json')) { Get-Content (Join-Path $out 'pdf-summary.json') -Raw | ConvertFrom-Json } else { $null }
function Step($match) { @($steps | Where-Object { $_.request -like $match }) | Select-Object -First 1 }
function Verdict($s, [string]$want = 'ok') { if (-not $s) { 'not tested' } elseif ($s.status -eq $want) { 'passed' } else { "failed ($($s.error.Message))" } }
$search = Step 'Open Chrome and search*'
$caps = [ordered]@{
    'Word launch'                       = Verdict (Step 'Open Microsoft Word*')
    'Chrome launch'                     = Verdict (Step 'Open Chrome.')
    'VS Code launch'                    = Verdict (Step 'Open VS Code.')
    'Excel launch'                      = Verdict (Step 'Open Excel*')
    'Chrome web search refused offline' = if (-not $search) { 'not tested' } elseif ($search.error.Code -eq 'offline_mode') { 'passed' } else { "failed (expected offline_mode, got $($search.status) $($search.error.Code))" }
    'VS Code project'                   = Verdict (Step 'Open VS Code and inspect*')
    'Settings -> Display'               = Verdict (Step 'Open Windows Settings*')
    'Running applications'              = Verdict (Step 'Show me the currently running*')
    'Emergency Stop'                    = if ((Step 'Stop the current action*') -and (Step 'Open Windows Terminal. (while stopped)').error.Code -eq 'emergency_stopped') { 'passed' } elseif (-not (Step 'Stop the current action*')) { 'not tested' } else { 'failed' }
    'Resume'                            = if (-not (Step 'Resume execution*')) { 'not tested' } elseif ((Step 'Resume execution*').result.resumed -and (Step 'Resume execution*').result.wrongGenerationRefused) { 'passed' } else { 'failed' }
    'Terminal launch'                   = Verdict (Step 'Open Windows Terminal. (after resume)')
    'Word document created + verified'  = if (-not $office) { 'not tested' } elseif ($office.word.Status -eq 'ok') { 'passed' } else { "failed ($($office.word.Error.Message))" }
    'Excel workbook created + verified' = if (-not $office) { 'not tested' } elseif ($office.excel.Status -eq 'ok') { 'passed' } else { "failed ($($office.excel.Error.Message))" }
    'PDF find + summarise'              = if (-not $pdf) { 'not tested' } elseif ($pdf.ok -and $pdf.independentCheck.ok) { 'passed' } else { 'failed' }
}
$allPassed = @($caps.Values | Where-Object { $_ -ne 'passed' }).Count -eq 0
# Every step must also have exited 0: a failing assertion (e.g. an Office process left behind) is a failure even if the evidence looks right.
$stepsOk = @($results.Values | Where-Object { $_.exitCode -ne 0 }).Count -eq 0
$pass = $allPassed -and $stepsOk -and $d0.offline -and $d1.offline -and $daskConn.Count -eq 0
$summary = [ordered]@{
    offlineBefore = $d0.offline; offlineAfter = $d1.offline; capabilities = $caps; steps = $results; allStepsExitedZero = $stepsOk
    daskNonLoopbackConnections = $daskConn; launchedAppConnectionAttempts = $appConn
    evidence = [ordered]@{ universal = $uc.FullName; office = $of.FullName; pdf = (Join-Path $out 'pdf-summary.json') }
    overall = $(if ($pass) { 'PASS' } else { 'FAIL' })
}
$summary | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $out 'SUMMARY.json')
Write-Host ($summary | ConvertTo-Json -Depth 6)
Write-Host "Evidence: $out"
exit $(if ($pass) { 0 } else { 1 })
