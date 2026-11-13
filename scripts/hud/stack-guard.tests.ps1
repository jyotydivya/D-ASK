# Unit tests for scripts\hud\stack-guard.ps1 (no processes are started or stopped).
#   powershell -ExecutionPolicy Bypass -File scripts\hud\stack-guard.tests.ps1
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\stack-guard.ps1"
$script:pass = 0; $script:fail = 0
function T([string]$Name, [bool]$Ok) { if ($Ok) { $script:pass++; Write-Host " ok   $Name" } else { $script:fail++; Write-Host "FAIL  $Name" } }
function P($n, $id, $t) { [pscustomobject]@{ Name = $n; ProcessId = $id; CreationDate = $t } }

$t0 = [datetime]'2026-11-12T17:13:00Z'
$files = @([pscustomobject]@{ Path = 'results\x\run2\pids.json'; WrittenUtc = $t0.AddSeconds(8); Daemon = 100; Hud = 200 })

$none = Get-StackConflict @((P 'chrome.exe' 1 $t0), (P 'node.exe' 2 $t0)) $files
T 'G1 no D-ASK stack process: nothing to do' (-not $none.any)
$st = Get-StackConflict @((P 'DAsk.Daemon.exe' 100 $t0), (P 'hud-native.exe' 200 $t0.AddSeconds(4))) $files
T 'G2 a daemon and HUD recorded by an acceptance launcher are reapable, not blocking' ($st.any -and $st.reapable.Count -eq 2 -and $st.blocking.Count -eq 0 -and $st.reapable[0].Owner -eq 'results\x\run2\pids.json')
$re = Get-StackConflict @((P 'DAsk.Daemon.exe' 100 $t0.AddHours(3))) $files
T 'G3 a reused pid (started hours after the file was written) is blocking, never reapable' ($re.blocking.Count -eq 1 -and $re.reapable.Count -eq 0)
$un = Get-StackConflict @((P 'DAsk.Daemon.exe' 999 $t0)) $files
T 'G4 a daemon no launcher recorded (the user''s own D-ASK) is blocking' ($un.blocking.Count -eq 1 -and $un.reapable.Count -eq 0)
$nd = Get-StackConflict @((P 'DAsk.Daemon.exe' 100 $null)) $files
T 'G5 an unknown start time is blocking (fail closed)' ($nd.blocking.Count -eq 1)
$mix = Get-StackConflict @((P 'DAsk.Daemon.exe' 100 $t0), (P 'DAsk.Daemon.exe' 999 $t0)) $files
T 'G6 one unknown daemon among stale ones keeps the whole conflict blocking' ($mix.blocking.Count -eq 1 -and $mix.reapable.Count -eq 1)
T 'G7 no pids.json at all: every stack process is blocking' ((Get-StackConflict @((P 'hud-native.exe' 5 $t0)) @()).blocking.Count -eq 1)

T 'G8 a healthy start is accepted' ($null -eq (Get-DaemonStartViolation $true "x`r`nDaemon process PID: 8068`r`nStarting D-ASK Named Pipe Server" 8068))
T 'G9 the exact failure of run 20261112T171739 is refused' ((Get-DaemonStartViolation $true "Daemon process PID: 8068`r`ncrit: Cannot establish exclusive, access-controlled ownership of pipe 'd-ask-ipc-v1'." 8068) -match 'named pipe')
T 'G10 a dead daemon is refused' ((Get-DaemonStartViolation $false '' 8068) -match 'exited')
T 'G11 a log naming another pid is refused' ((Get-DaemonStartViolation $true 'Daemon process PID: 1' 8068) -match 'not the launched pid')
T 'G12 a log with no pid line yet is not refused on that ground' ($null -eq (Get-DaemonStartViolation $true '' 8068))

Write-Host "`n$($script:pass) passed, $($script:fail) failed"
if ($script:fail -gt 0) { exit 1 }
