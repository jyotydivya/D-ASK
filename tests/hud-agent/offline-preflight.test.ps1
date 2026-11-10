# The offline preflight's decision, tested on recorded and constructed network states. No network access, no probe.
#   powershell -ExecutionPolicy Bypass -File tests\hud-agent\offline-preflight.test.ps1
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\..\..\scripts\hud\offline-preflight.ps1"
$script:passed = 0; $script:failed = 0
function Check([bool]$Ok, [string]$Name, $Detail) {
    if ($Ok) { $script:passed++; Write-Host "  ok  $Name" }
    else { $script:failed++; Write-Host "FAIL  $Name :: $($Detail | ConvertTo-Json -Compress -Depth 4)" }
}
function Iface($i, $alias, $fam, $state) { [pscustomobject]@{ ifIndex = $i; InterfaceAlias = $alias; AddressFamily = $fam; ConnectionState = $state } }
function Route($i, $alias, $fam, $hop) { [pscustomobject]@{ ifIndex = $i; InterfaceAlias = $alias; AddressFamily = $fam; DestinationPrefix = $(if ($fam -eq 'IPv6') { '::/0' } else { '0.0.0.0/0' }); NextHop = $hop; State = 'Alive'; PolicyStore = 'ActiveStore' } }
function Evidence($interfaces, $routes = @(), $profiles = @(), $probe = @()) {
    [pscustomobject]@{ interfaces = @($interfaces); defaultRoutes = @($routes); profiles = @($profiles); probe = @($probe); probeSkipped = $false }
}
$offlineIfaces = @(
    (Iface 1 'Loopback Pseudo-Interface 1' 'IPv4' 'Connected'), (Iface 1 'Loopback Pseudo-Interface 1' 'IPv6' 'Connected'),
    (Iface 4 'Wi-Fi' 'IPv4' 'Disconnected'), (Iface 4 'Wi-Fi' 'IPv6' 'Disconnected'),
    (Iface 15 'Ethernet' 'IPv4' 'Disconnected'), (Iface 15 'Ethernet' 'IPv6' 'Disconnected')
)
$noProbe = @([pscustomobject]@{ target = '1.1.1.1:443'; connected = $false; error = 'unreachable' })
$staleRoute = Route 4 'Wi-Fi' 'IPv4' '172.18.192.10'

Write-Host 'the reported false positive'
$d = Test-OfflineEvidence (Evidence $offlineIfaces @($staleRoute) @() $noProbe)
Check $d.offline 'a default route on the disconnected Wi-Fi no longer blocks the run' $d
Check ($d.ignoredRoutes.Count -eq 1 -and $d.ignoredRoutes[0] -match 'Wi-Fi.*Disconnected') 'and it is recorded as ignored, with why' $d.ignoredRoutes

Write-Host 'still refused when online'
$d = Test-OfflineEvidence (Evidence ($offlineIfaces + (Iface 4 'Wi-Fi' 'IPv4' 'Connected')) @($staleRoute) @() $noProbe)
Check (-not $d.offline) 'a connected interface is refused even if every probe fails' $d
$connectedWifi = @((Iface 1 'Loopback Pseudo-Interface 1' 'IPv4' 'Connected'), (Iface 4 'Wi-Fi' 'IPv4' 'Connected'), (Iface 4 'Wi-Fi' 'IPv6' 'Disconnected'))
$d = Test-OfflineEvidence (Evidence $connectedWifi @($staleRoute) @() $noProbe)
Check ((-not $d.offline) -and ($d.reasons -match 'default route.*Connected').Count -eq 1) 'a default route on a connected interface counts' $d.reasons
$d = Test-OfflineEvidence (Evidence $offlineIfaces @((Route 22 'vEthernet (WSL)' 'IPv4' '172.20.0.1')) @() $noProbe)
Check ((-not $d.offline) -and ($d.reasons -match 'unknown')) 'a default route on an interface with no known state counts (fail closed)' $d.reasons
$d = Test-OfflineEvidence (Evidence $offlineIfaces @((Route 4 'Wi-Fi' 'IPv6' 'fe80::1')) @() $noProbe)
Check $d.offline 'an IPv6 default route on the disconnected interface is ignored too' $d
$mixed = @((Iface 4 'Wi-Fi' 'IPv4' 'Disconnected'), (Iface 4 'Wi-Fi' 'IPv6' 'Connected'))
$d = Test-OfflineEvidence (Evidence $mixed @((Route 4 'Wi-Fi' 'IPv6' 'fe80::1')) @() $noProbe)
Check (-not $d.offline) 'the route is judged by its own address family (IPv6 connected, IPv4 not)' $d.reasons
foreach ($state in 'Internet', 'LocalNetwork', 'Subnet') {
    $d = Test-OfflineEvidence (Evidence $offlineIfaces @() @([pscustomobject]@{ InterfaceAlias = 'Wi-Fi'; IPv4Connectivity = $state; IPv6Connectivity = 'Disconnected' }) $noProbe)
    Check (-not $d.offline) "Windows reporting $state connectivity is refused" $d.reasons
}
$d = Test-OfflineEvidence (Evidence $offlineIfaces @() @([pscustomobject]@{ InterfaceAlias = 'Wi-Fi'; IPv4Connectivity = 'NoTraffic'; IPv6Connectivity = 'Disconnected' }) $noProbe)
Check $d.offline 'NoTraffic and Disconnected profiles do not block' $d
$d = Test-OfflineEvidence (Evidence $offlineIfaces @() @() @([pscustomobject]@{ target = '8.8.8.8:53'; connected = $true; error = $null }))
Check ((-not $d.offline) -and ($d.reasons -match '8\.8\.8\.8')) 'a successful probe is refused even when every interface says Disconnected' $d.reasons
$d = Test-OfflineEvidence (Evidence $offlineIfaces)
Check $d.offline 'loopback alone is not connectivity' $d

Write-Host 'the recorded preflight snapshot'
$recorded = Get-Content "$PSScriptRoot\..\..\results\phase6\offline-live\preflight-2026-11-06T004556-false-positive.json" -Raw | ConvertFrom-Json
Check (@($recorded.upAdapters).Count -eq 0 -and @($recorded.defaultRoutes).Count -eq 1 -and $recorded.defaultRoutes[0].InterfaceAlias -eq 'Wi-Fi') 'the snapshot shows no adapter up and one Wi-Fi default route' $recorded
Check (@($recorded.adapters | Where-Object { $_.Name -eq 'Wi-Fi' -and $_.Status -eq 'Disconnected' }).Count -eq 1) 'with Wi-Fi Disconnected' $recorded.adapters

Write-Host "`n$script:passed passed, $script:failed failed"
exit $(if ($script:failed) { 1 } else { 0 })
