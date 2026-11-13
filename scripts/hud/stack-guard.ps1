# Pure helpers of start-stack.ps1: refuse to start a second D-ASK stack on top of a left-over one.
# Why: the daemon owns the exclusive named pipe 'd-ask-ipc-v1'. A daemon left running by a killed acceptance run keeps the pipe, the NEW daemon
# exits at once ("Cannot establish exclusive ... ownership of pipe"), and the new HUD handshakes with the OLD daemon, whose environment (its
# workflow store, journal, flags) belongs to the previous run. That is what made run 20261112T171739 see a stale "nightly".
# Unit-tested by stack-guard.tests.ps1. No process is touched here; start-stack.ps1 decides.

$script:StackExeNames = 'DAsk.Daemon.exe', 'hud-native.exe'

# $All: Win32_Process-like objects (Name, ProcessId, CreationDate). $PidFiles: @{ Path; WrittenUtc (datetime); Daemon; Hud }.
# A process is "reapable" only if an acceptance launcher recorded exactly its pid in a pids.json written within $WindowSeconds of its start
# (so a reused pid, or the user's own D-ASK, is never mistaken for one). Anything else that is a D-ASK stack process is "blocking".
function Get-StackConflict($All, $PidFiles, [int]$WindowSeconds = 180) {
    $blocking = New-Object System.Collections.ArrayList; $reapable = New-Object System.Collections.ArrayList
    foreach ($p in @($All)) {
        if ($script:StackExeNames -notcontains $p.Name) { continue }
        $owner = $null
        foreach ($f in @($PidFiles)) {
            if ($p.ProcessId -ne $f.Daemon -and $p.ProcessId -ne $f.Hud) { continue }
            if ($null -eq $p.CreationDate) { continue }
            $started = ([datetime]$p.CreationDate).ToUniversalTime()
            if ([math]::Abs(($started - $f.WrittenUtc.ToUniversalTime()).TotalSeconds) -le $WindowSeconds) { $owner = $f.Path; break }
        }
        $row = [pscustomobject]@{ Name = $p.Name; ProcessId = [int]$p.ProcessId; Owner = $owner }
        if ($owner) { [void]$reapable.Add($row) } else { [void]$blocking.Add($row) }
    }
    return [pscustomobject]@{ blocking = @($blocking.ToArray()); reapable = @($reapable.ToArray()); any = ($blocking.Count + $reapable.Count) -gt 0 }
}

# After starting: did the daemon we launched really become the pipe owner? Returns $null when fine, otherwise the reason.
function Get-DaemonStartViolation([bool]$Alive, [string]$LogText, [int]$ExpectedPid) {
    if (-not $Alive) { return "the daemon (pid $ExpectedPid) exited right after starting" }
    if ($LogText -match 'Cannot establish exclusive, access-controlled ownership of pipe') { return 'the daemon could not own the named pipe (another D-ASK daemon is running)' }
    $m = [regex]::Match($LogText, 'Daemon process PID: (\d+)')
    if ($m.Success -and [int]$m.Groups[1].Value -ne $ExpectedPid) { return "the daemon log reports pid $($m.Groups[1].Value), not the launched pid $ExpectedPid" }
    return $null
}
