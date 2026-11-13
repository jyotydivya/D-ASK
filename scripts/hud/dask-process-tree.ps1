# The D-ASK process trees for the offline network monitors: the daemon and HUD processes and every descendant.
#   . scripts\hud\dask-process-tree.ps1;  $tree = Get-DAskProcessTree @(Get-CimInstance Win32_Process)   # pid -> name
#
# Windows reuses process ids, and a process keeps the parent id it was started with even after that parent exits. So a
# parent id alone does not prove descent: on 2026-11-10 (results/offline-summarize/20261110T205223) a Chrome started
# 13 minutes earlier still named its long-gone launcher's id, which the HUD's new WebView2 process had just reused, and
# the whole Chrome tree was counted as D-ASK. A child is therefore accepted only if its parent was created no later
# than the child itself. When either creation time is unknown, the child is still accepted: an unknown never hides a
# process from the monitor.
function Get-DAskProcessTree {
    param([object[]]$Processes, [string[]]$RootNames = @('DAsk.Daemon.exe', 'hud-native.exe'))
    $created = { param($p) if ($p.CreationDate -is [datetime]) { $p.CreationDate } else { $null } }
    $kids = @{}
    foreach ($p in $Processes) { $k = [int]$p.ParentProcessId; if (-not $kids.ContainsKey($k)) { $kids[$k] = New-Object System.Collections.ArrayList }; [void]$kids[$k].Add($p) }
    $tree = @{}
    $stack = New-Object System.Collections.Stack
    foreach ($p in $Processes | Where-Object { $RootNames -contains $_.Name }) { $stack.Push($p) }
    while ($stack.Count) {
        $p = $stack.Pop()
        if ($tree.ContainsKey([int]$p.ProcessId)) { continue }
        $tree[[int]$p.ProcessId] = $p.Name
        $pc = & $created $p
        foreach ($c in @($kids[[int]$p.ProcessId])) {
            if (-not $c -or [int]$c.ProcessId -eq [int]$p.ProcessId) { continue }
            $cc = & $created $c
            if ($pc -and $cc -and $pc -gt $cc) { continue }   # the "parent" is younger than the child: a reused id, not its parent
            $stack.Push($c)
        }
    }
    return $tree
}
