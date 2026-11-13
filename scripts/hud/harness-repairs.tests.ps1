# Regression tests for two harness repairs (2026-11-10; results/offline-summarize/20261110T205223):
#   T  process-tree attribution in the offline network monitors (dask-process-tree.ps1): a reused parent pid is not descent;
#   F  establishing the HUD as the foreground window before input (hud-driver.ps1 Invoke-HudForegroundAttempts).
# No HUD, daemon or network change: synthetic processes, injected foreground actions, and one real child process.
#   powershell -ExecutionPolicy Bypass -File scripts\hud\harness-repairs.tests.ps1
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\dask-process-tree.ps1"
. "$PSScriptRoot\hud-driver.ps1"
$script:pass = 0; $script:fail = 0
function Check([bool]$Cond, [string]$Name, $Detail) {
    if ($Cond) { $script:pass++; Write-Host "  PASS: $Name" } else { $script:fail++; Write-Host "  FAIL: $Name $(if ($null -ne $Detail) { '| ' + ($Detail | ConvertTo-Json -Compress -Depth 4) })" }
}
$t0 = Get-Date '2026-11-10T20:52:30'
function P([int]$Id, [int]$Parent, [string]$Name, $Created) { [pscustomobject]@{ ProcessId = $Id; ParentProcessId = $Parent; Name = $Name; CreationDate = $Created } }
$keys = { param($t) @($t.Keys | Sort-Object) -join ',' }

Write-Host "`n[T] process-tree attribution"
# The observed failure: Chrome (8728, started 20:39:40) still names its long-gone launcher 15664; the HUD's new WebView2
# process reuses 15664 at 20:52:37.
$observed = @(
    (P 19156 900 'DAsk.Daemon.exe' $t0), (P 13228 19156 'conhost.exe' $t0.AddSeconds(0.1)),
    (P 18196 901 'hud-native.exe' $t0.AddSeconds(3)), (P 17632 18196 'msedgewebview2.exe' $t0.AddSeconds(3.5)),
    (P 15664 17632 'msedgewebview2.exe' $t0.AddSeconds(7.6)),
    (P 8728 15664 'chrome.exe' (Get-Date '2026-11-10T20:39:40')), (P 12056 8728 'chrome.exe' (Get-Date '2026-11-10T20:39:40.5')),
    (P 5808 8728 'chrome.exe' (Get-Date '2026-11-10T20:43:00')), (P 4242 902 'notepad.exe' $t0))
$tree = Get-DAskProcessTree $observed
Check ((& $keys $tree) -eq '13228,15664,17632,18196,19156') 'T1 reused parent pid: the HUD''s WebView2 (15664) is D-ASK, the older Chrome tree that names 15664 is not' (& $keys $tree)
Check (-not $tree.ContainsKey(12056) -and -not $tree.ContainsKey(5808)) 'T2 nothing below the rejected Chrome process is reached (its connection would not be attributed)'
$chain = @((P 1 0 'hud-native.exe' $t0), (P 2 1 'msedgewebview2.exe' $t0.AddSeconds(1)), (P 3 2 'msedgewebview2.exe' $t0.AddSeconds(2)), (P 4 3 'node.exe' $t0.AddSeconds(3)))
Check ((& $keys (Get-DAskProcessTree $chain)) -eq '1,2,3,4') 'T3 a genuine chain of descendants, each younger than its parent, is fully included'
$same = @((P 1 0 'DAsk.Daemon.exe' $t0), (P 2 1 'node.exe' $t0))
Check ((& $keys (Get-DAskProcessTree $same)) -eq '1,2') 'T4 a child created in the same instant as its parent is included'
$unknown = @((P 1 0 'DAsk.Daemon.exe' $t0), (P 2 1 'node.exe' $null), (P 3 2 'llama-server.exe' $t0.AddSeconds(1)), (P 4 1 'x.exe' 'not a date'))
Check ((& $keys (Get-DAskProcessTree $unknown)) -eq '1,2,3,4') 'T5 unknown creation times never hide a process (monitoring is not weakened)'
$cycle = @((P 1 1 'DAsk.Daemon.exe' $t0), (P 2 3 'a.exe' $t0.AddSeconds(1)), (P 3 2 'b.exe' $t0.AddSeconds(1)))
Check ((& $keys (Get-DAskProcessTree $cycle)) -eq '1') 'T6 a process naming itself as parent, and an unrelated cycle, terminate and add nothing'
Check (($observed | Where-Object { $_.Name -eq 'chrome.exe' }).Count -eq 3 -and (Get-DAskProcessTree @((P 77 0 'chrome.exe' $t0))).Count -eq 0) 'T7 Chrome is not excluded by name: it is simply not a root (a Chrome started BY D-ASK would be included)'
$byDask = @((P 1 0 'hud-native.exe' $t0), (P 2 1 'chrome.exe' $t0.AddSeconds(1)))
Check ((& $keys (Get-DAskProcessTree $byDask)) -eq '1,2') 'T8 a browser genuinely started by a D-ASK process is still monitored'

# T9: real CIM objects (CreationDate as [datetime]) and a real child process, using this PowerShell as the root.
$me = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
$child = Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile', '-Command', 'Start-Sleep -Seconds 5' -PassThru -WindowStyle Hidden
Start-Sleep -Milliseconds 700
$real = Get-DAskProcessTree @(Get-CimInstance Win32_Process) -RootNames @($me.Name)
Check ($real.ContainsKey([int]$PID) -and $real.ContainsKey([int]$child.Id)) 'T9 real Win32_Process objects: this process and its real child are in the tree' @{ self = $PID; child = $child.Id }
try { $child.Kill() } catch { }

# T10: the helper works where the monitors use it, inside a Start-Job that dot-sources it by path.
$job = Start-Job -ScriptBlock { param($helper, $data) . $helper; $t = Get-DAskProcessTree $data; @($t.Keys | Sort-Object) -join ',' } -ArgumentList (Join-Path $PSScriptRoot 'dask-process-tree.ps1'), $observed
$jobOut = Receive-Job -Job $job -Wait -AutoRemoveJob
Check ($jobOut -eq '13228,15664,17632,18196,19156') 'T10 inside a background job (as the monitors run it), the same result' $jobOut

# T11: the four tree-walking monitors use the helper, pass its path, and no longer walk parent ids themselves.
foreach ($f in 'offline-features-acceptance.ps1', 'offline-notes-acceptance.ps1', 'offline-summarize-acceptance.ps1', 'offline-full-acceptance.ps1') {
    $s = Get-Content -Raw (Join-Path $PSScriptRoot $f)
    Check ($s -match '\. \$treeHelper' -and $s -match 'Get-DAskProcessTree \$all' -and $s -match "-ArgumentList \`$connections, \(Join-Path \`$PSScriptRoot 'dask-process-tree\.ps1'\)" -and $s -notmatch '\$kids\[\$k\] \+= \$p') "T11 $f uses the creation-time-checked tree"
}

Write-Host "`n[F] foreground before input"
function Sim([bool[]]$Seq) {
    # Each IsForeground call returns the next value; Recycle/Wait are counted; Owner reports a fixed thief.
    $state = [pscustomobject]@{ i = 0; recycles = 0; waits = 0 }
    $r = Invoke-HudForegroundAttempts -Attempts 3 -Owner { 'chrome (pid 12056)' } `
        -IsForeground { $v = $Seq[[Math]::Min($state.i, $Seq.Count - 1)]; $state.i++; $v }.GetNewClosure() `
        -Recycle { $state.recycles++ }.GetNewClosure() -Wait { $state.waits++ }.GetNewClosure()
    return [pscustomobject]@{ r = $r; s = $state }
}
$x = Sim @($true)
Check ($x.r.ok -and $x.r.attempts -eq 0 -and $x.s.recycles -eq 0) 'F1 already in front: no hotkey is sent, input may proceed'
$x = Sim @($false, $true)
Check ($x.r.ok -and $x.r.attempts -eq 1 -and $x.s.recycles -eq 1 -and $x.r.owners[0] -eq 'chrome (pid 12056)') 'F2 focus lost once: one HUD hotkey cycle restores it, and who held the foreground is recorded' $x.r
$x = Sim @($false, $false, $true)
Check ($x.r.ok -and $x.r.attempts -eq 2) 'F3 a second cycle is allowed when the first does not take'
$x = Sim @($false)
Check (-not $x.r.ok -and $x.s.recycles -eq 3 -and $x.r.reason -match 'after 3 attempt' -and $x.r.reason -match 'chrome \(pid 12056\)') 'F4 never in front: bounded (3 cycles), fails closed, names the foreground owner' $x.r
# F5: the guard itself is unchanged: input is refused when the HUD is not in front, and now says who is.
$drv = Get-Content -Raw (Join-Path $PSScriptRoot 'hud-driver.ps1')
Check ($drv -match 'throw "The HUD is not the foreground window; refusing to send input\. Foreground: \$\(Get-ForegroundOwner\)\."' -and $drv -match 'function Type-HudText\(\[IntPtr\]\$Hwnd, \[string\]\$Text\) \{\s+Assert-HudForeground \$Hwnd') 'F5 Assert-HudForeground still guards every typed input and refuses; it now names the foreground owner'
$ownerFn = [regex]::Match($drv, '(?s)function Get-ForegroundOwner \{.*?\n\}').Value
Check ($ownerFn -and $ownerFn -notmatch 'Title|GetWindowText' -and (Get-ForegroundOwner) -match '\(pid \d+\)$|^no foreground window$') 'F6 the foreground owner is recorded as process and pid only (no window title: other apps'' titles can be personal)' (Get-ForegroundOwner)
$sum = Get-Content -Raw (Join-Path $PSScriptRoot 'approval-live-summarize.ps1')
Check ($sum -match 'Confirm-HudForeground \$script:hwnd 3' -and $sum -match 'if \(-not \$f\.ok\) \{ throw "The HUD is not the foreground window; refusing to send input') 'F7 the summarisation harness verifies the foreground right before each request and stops (never types) if it cannot'

Write-Host "`n$script:pass passed, $script:fail failed"
if ($script:fail) { exit 1 }
