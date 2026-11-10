# Offline checks for the one Wi-Fi-off run of the Phase 5 live test. Functions only; dot-source this file.
#
# A default route alone does not show that a machine is online: Windows keeps a DHCP-installed default route in the
# route table after its adapter disconnects, until the lease lifetime runs out. Such a route can't carry traffic.
# So a route counts against going ahead unless its own interface is known to be disconnected.
#
# The machine is treated as online, and the test is refused, if ANY of these holds:
#   1. any non-loopback IP interface reports ConnectionState Connected (IPv4 or IPv6);
#   2. a default route sits on an interface that is not reported Disconnected for that address family, or whose
#      interface can't be found at all (unknown counts as online);
#   3. Windows' own connectivity check (the connection profile) reports Subnet, LocalNetwork or Internet;
#   4. an independent probe opens a TCP connection to any of several public addresses.
# Default routes on disconnected interfaces are recorded as ignored, with the reason, so the decision can be audited.

$script:ProbeTargets = @(
    @{ Address = '1.1.1.1'; Port = 443 },
    @{ Address = '8.8.8.8'; Port = 53 },
    @{ Address = '9.9.9.9'; Port = 443 },
    @{ Address = '2606:4700:4700::1111'; Port = 443 }
)

function Test-IsLoopbackInterface($Interface) {
    return ($Interface.InterfaceAlias -match 'Loopback') -or ([int]$Interface.ifIndex -eq 1)
}

# Tries each address once with a short timeout. Uses IP literals, so no DNS is involved. Only reports; changes nothing.
function Invoke-ConnectivityProbe([int]$TimeoutMs = 2000) {
    foreach ($t in $script:ProbeTargets) {
        $client = New-Object System.Net.Sockets.TcpClient([System.Net.IPAddress]::Parse($t.Address).AddressFamily)
        $connected = $false
        $errorText = $null
        try {
            $task = $client.ConnectAsync($t.Address, $t.Port)
            if ($task.Wait($TimeoutMs)) { $connected = $client.Connected } else { $errorText = 'timed out' }
        } catch {
            $errorText = $_.Exception.GetBaseException().Message
        } finally {
            $client.Dispose()
        }
        [pscustomobject]@{ target = "$($t.Address):$($t.Port)"; connected = $connected; error = $errorText }
    }
}

# Everything the decision is based on, as plain data. Read-only apart from the probe connections.
function Get-OfflineEvidence([switch]$SkipProbe) {
    $interfaces = @(Get-NetIPInterface -ErrorAction SilentlyContinue | ForEach-Object {
        [pscustomobject]@{ ifIndex = [int]$_.ifIndex; InterfaceAlias = $_.InterfaceAlias; AddressFamily = "$($_.AddressFamily)"; ConnectionState = "$($_.ConnectionState)" }
    })
    $routes = @(Get-NetRoute -DestinationPrefix '0.0.0.0/0', '::/0' -ErrorAction SilentlyContinue | ForEach-Object {
        [pscustomobject]@{
            ifIndex = [int]$_.ifIndex; InterfaceAlias = $_.InterfaceAlias; DestinationPrefix = $_.DestinationPrefix
            AddressFamily = $(if ($_.DestinationPrefix -eq '::/0') { 'IPv6' } else { 'IPv4' })
            NextHop = $_.NextHop; State = "$($_.State)"; PolicyStore = "$($_.PolicyStore)"; Protocol = "$($_.Protocol)"
        }
    })
    $profiles = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | ForEach-Object {
        [pscustomobject]@{ InterfaceAlias = $_.InterfaceAlias; IPv4Connectivity = "$($_.IPv4Connectivity)"; IPv6Connectivity = "$($_.IPv6Connectivity)" }
    })
    $adapters = @(Get-NetAdapter -ErrorAction SilentlyContinue | ForEach-Object {
        [pscustomobject]@{ ifIndex = [int]$_.ifIndex; Name = $_.Name; InterfaceDescription = $_.InterfaceDescription; Status = "$($_.Status)" }
    })
    $addresses = @(Get-NetIPAddress -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notmatch '^(127\.|::1$|fe80:|169\.254\.)' } | ForEach-Object {
        [pscustomobject]@{ InterfaceAlias = $_.InterfaceAlias; IPAddress = $_.IPAddress; AddressState = "$($_.AddressState)" }
    })
    $probe = if ($SkipProbe) { @() } else { @(Invoke-ConnectivityProbe) }
    [pscustomobject]@{
        at = (Get-Date).ToString('o'); interfaces = $interfaces; defaultRoutes = $routes; profiles = $profiles
        adapters = $adapters; addresses = $addresses; probe = $probe; probeSkipped = [bool]$SkipProbe
    }
}

# Pure decision over the evidence. Returns offline = $true only when no rule finds a sign of connectivity.
function Test-OfflineEvidence($Evidence) {
    $reasons = New-Object System.Collections.Generic.List[string]
    $ignored = New-Object System.Collections.Generic.List[string]

    # 1. Any operational non-loopback interface
    foreach ($i in @($Evidence.interfaces)) {
        if (-not (Test-IsLoopbackInterface $i) -and $i.ConnectionState -eq 'Connected') {
            $reasons.Add("interface '$($i.InterfaceAlias)' ($($i.AddressFamily)) is Connected")
        }
    }

    # 2. Default routes count unless their own interface, for the same address family, is known to be disconnected
    foreach ($r in @($Evidence.defaultRoutes)) {
        $iface = @($Evidence.interfaces | Where-Object { $_.ifIndex -eq $r.ifIndex -and $_.AddressFamily -eq $r.AddressFamily })
        if ($iface.Count -eq 0) {
            $reasons.Add("default route $($r.DestinationPrefix) via $($r.NextHop) on '$($r.InterfaceAlias)', whose interface state is unknown")
        } elseif ($iface[0].ConnectionState -ne 'Disconnected') {
            $reasons.Add("default route $($r.DestinationPrefix) via $($r.NextHop) on '$($r.InterfaceAlias)', which is $($iface[0].ConnectionState)")
        } else {
            $ignored.Add("default route $($r.DestinationPrefix) via $($r.NextHop) on '$($r.InterfaceAlias)': the interface is Disconnected, so the route can't carry traffic")
        }
    }

    # 3. Windows' own connectivity assessment
    foreach ($p in @($Evidence.profiles)) {
        foreach ($family in 'IPv4', 'IPv6') {
            $value = $p."$($family)Connectivity"
            if ($value -in 'Subnet', 'LocalNetwork', 'Internet') {
                $reasons.Add("Windows reports $family connectivity '$value' on '$($p.InterfaceAlias)'")
            }
        }
    }

    # 4. Independent probe
    if (-not $Evidence.probeSkipped) {
        foreach ($t in @($Evidence.probe)) {
            if ($t.connected) { $reasons.Add("a TCP connection to $($t.target) succeeded") }
        }
    }

    [pscustomobject]@{ offline = ($reasons.Count -eq 0); reasons = @($reasons); ignoredRoutes = @($ignored) }
}

function Write-OfflineDecision($Decision, $Evidence) {
    if ($Decision.offline) {
        Write-Host 'Offline: no connected interface, no usable default route, no connectivity reported by Windows, no probe connection.' -ForegroundColor Green
    } else {
        Write-Host 'Online: the test would NOT run. Reasons:' -ForegroundColor Red
        foreach ($r in $Decision.reasons) { Write-Host "  - $r" }
    }
    foreach ($r in $Decision.ignoredRoutes) { Write-Host "  (ignored) $r" -ForegroundColor DarkGray }
    if ($Evidence.probeSkipped) { Write-Host '  (the connectivity probe was skipped)' -ForegroundColor Yellow }
    else { foreach ($t in $Evidence.probe) { Write-Host ("  probe {0}: {1}" -f $t.target, $(if ($t.connected) { 'CONNECTED' } else { "no connection ($($t.error))" })) -ForegroundColor DarkGray } }
}
