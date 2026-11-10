# Phase 7B.1a: the Ambient-mode approval surface, with real mouse input, on a controlled fixture only.
#
# Starts the TEST-ONLY fixture HUD (built with --features approval-fixture into target\fixture; it never connects to the
# daemon and its approvals authorize nothing) and a probe window (overlay-probe-app.ps1) directly behind the HUD's
# centre. Synthetic approvals are requested through the fixture's command file. Every click is refused unless the
# window under the cursor is the fixture HUD or the probe, so no input can reach another application. Hotkey chords are
# sent only after the HUD has confirmed it registered them (registered hotkeys are consumed by the HUD).
#
#   powershell -ExecutionPolicy Bypass -File scripts\hud\approval-surface-tests.ps1 -OutDir results\phase7b1a\approval-surface
#
# Starts and stops only its own two processes. Writes approval-surface.json and hud.log to -OutDir. No screenshots.
param([Parameter(Mandatory = $true)][string]$OutDir, [string]$Root)
$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = (Resolve-Path "$PSScriptRoot\..\..").Path }
. "$PSScriptRoot\hud-driver.ps1"
New-Item -ItemType Directory -Force $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path

if (-not ('ApprW' -as [type])) {
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class ApprW {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
}

$exe = Join-Path $Root 'src\hud-native\target\fixture\release\hud-native.exe'
if (-not (Test-Path $exe)) { throw "Fixture HUD not built: cargo build --release --features approval-fixture --target-dir target\fixture" }
$running = @(Get-Process hud-native -ErrorAction SilentlyContinue)
if ($running.Count) { throw "Another hud-native is running (pid $($running.Id -join ', ')). Close it first; these tests need the hotkeys." }

$cmd = Join-Path $OutDir 'fixture-cmd.txt'
$log = Join-Path $OutDir 'hud.log'
$probeLog = Join-Path $OutDir 'probe.json'
foreach ($f in $cmd, $log, $probeLog) { if (Test-Path $f) { Remove-Item $f } }
New-Item -ItemType File $cmd | Out-Null

$script:results = New-Object System.Collections.ArrayList
function Record([string]$Name, [bool]$Pass, $Detail) {
    [void]$script:results.Add([pscustomobject]@{ name = $Name; pass = $Pass; detail = $Detail })
    "{0}  {1}  {2}" -f $(if ($Pass) { ' ok ' } else { 'FAIL' }), $Name, ($Detail | ConvertTo-Json -Compress -Depth 4)
}
function Clicks { for ($i = 0; $i -lt 20; $i++) { try { return [int](Get-Content $probeLog -Raw -ErrorAction Stop | ConvertFrom-Json).clicks } catch { Start-Sleep -Milliseconds 50 } }; throw 'probe log unreadable' }
function Decisions([string]$Id) { @(Select-String -Path $log -Pattern "\[FIXTURE\] decision approval_id=$Id approved=(\w+)" -ErrorAction SilentlyContinue | ForEach-Object { $_.Matches[0].Groups[1].Value }) }
function Owner([int]$x, [int]$y) { $p = New-Object ApprW+POINT; $p.X = $x; $p.Y = $y; [ApprW]::GetAncestor([ApprW]::WindowFromPoint($p), 2) }

# A real click, but only on the fixture HUD or the probe. Returns how many clicks the probe received.
function SafeClickAt([int]$x, [int]$y) {
    if ($x -lt $script:probeRect.L -or $x -ge $script:probeRect.R -or $y -lt $script:probeRect.T -or $y -ge $script:probeRect.B) { throw "refusing to click at ${x},${y}: outside the probe window" }
    [void][HudInput]::SetCursorPos($x, $y)
    Start-Sleep -Milliseconds 150
    $o = Owner $x $y
    if ($o -ne $script:hwnd -and $o -ne $script:probeHwnd) { throw "refusing to click at ${x},${y}: the window there is neither the fixture HUD nor the probe" }
    $b = Clicks; [HudInput]::Click(); Start-Sleep -Milliseconds 400; (Clicks) - $b
}
function Request([string]$Id, [int]$TtlMs) { Add-Content -Path $cmd -Value "request $Id $TtlMs" }
function Cancel([string]$Id) { Add-Content -Path $cmd -Value "cancel $Id" }
function Centre($el) { $r = $el.Current.BoundingRectangle; [pscustomobject]@{ X = [int]($r.X + $r.Width / 2); Y = [int]($r.Y + $r.Height / 2) } }
function WaitText([string]$Pattern, [int]$TimeoutMs = 8000) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    do { if ((Get-HudText $script:hwnd) -match $Pattern) { return $true }; Start-Sleep -Milliseconds 100 } while ($sw.ElapsedMilliseconds -lt $TimeoutMs)
    return $false
}
function Transparent { ((Get-HudExStyle $script:hwnd) -band $script:WS_EX_TRANSPARENT) -ne 0 }
function NoActivate { ((Get-HudExStyle $script:hwnd) -band $script:WS_EX_NOACTIVATE) -ne 0 }

$hud = $null; $probe = $null
$saved = @{}
try {
    foreach ($k in 'DASK_HUD_APPROVAL_FIXTURE', 'DASK_HUD_FIXTURE_CMD', 'DASK_HUD_LOG', 'DASK_HUD_INSTANCE') { $saved[$k] = [Environment]::GetEnvironmentVariable($k) }
    $env:DASK_HUD_APPROVAL_FIXTURE = '1'; $env:DASK_HUD_FIXTURE_CMD = $cmd; $env:DASK_HUD_LOG = $log; $env:DASK_HUD_INSTANCE = 'D-ASK-HUD-APPROVAL-FIXTURE'
    $hud = Start-Process -FilePath $exe -WorkingDirectory $Root -PassThru
    foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }

    $script:hwnd = Get-HudHwnd $hud.Id
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while (-not ((Test-Path $log) -and (Select-String -Path $log -Pattern 'Page viewport' -Quiet)) -and $sw.ElapsedMilliseconds -lt 30000) { Start-Sleep -Milliseconds 200 }
    $hotkeysOk = (Select-String -Path $log -Pattern 'Registered Ctrl\+Alt\+Space' -Quiet) -and (Select-String -Path $log -Pattern 'Registered Ctrl\+Alt\+H' -Quiet)
    Record 'setup: fixture HUD started without a daemon; page loaded' ((Select-String -Path $log -Pattern '\[FIXTURE\] Approval-surface fixture mode' -Quiet) -and (Select-String -Path $log -Pattern 'Page viewport' -Quiet)) @{ pid = $hud.Id; hotkeys = $hotkeysOk }
    Start-Sleep -Seconds 2

    $wr = New-Object ApprW+RECT
    [void][ApprW]::GetWindowRect($script:hwnd, [ref]$wr)
    $cx = [int](($wr.L + $wr.R) / 2); $cy = [int](($wr.T + $wr.B) / 2)
    $probe = Start-Process powershell -ArgumentList @('-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', "$PSScriptRoot\overlay-probe-app.ps1", '-X', ($cx - 340), '-Y', ($cy - 340), '-Width', 680, '-Height', 680, '-LogPath', $probeLog, '-TopMost') -WindowStyle Hidden -PassThru
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while (-not ((Test-Path $probeLog) -and (Get-Content $probeLog -Raw | ConvertFrom-Json).ready) -and $sw.ElapsedMilliseconds -lt 20000) { Start-Sleep -Milliseconds 200 }
    Start-Sleep -Milliseconds 800
    $script:probeHwnd = [HudWindows]::Find([uint32]((Get-Content $probeLog -Raw | ConvertFrom-Json).pid), 'D-ASK overlay probe')
    $script:probeRect = New-Object ApprW+RECT
    [void][ApprW]::GetWindowRect($script:probeHwnd, [ref]$script:probeRect)
    # The HUD above the probe, the probe above everything else.
    [void][ApprW]::SetWindowPos($script:hwnd, [IntPtr](-1), 0, 0, 0, 0, 0x13)
    Start-Sleep -Milliseconds 300
    $corner = [pscustomobject]@{ X = $script:probeRect.L + 40; Y = $script:probeRect.B - 40 }   # inside the probe, outside the panel

    # 1. Ambient with no approval: click-through everywhere.
    Record '1. ambient, no approval: a click at the centre reaches the application behind' ((SafeClickAt $cx $cy) -eq 1) @{ mode = (Get-HudMode $script:hwnd) }

    # 2. An approval appears; outside the panel stays click-through; the panel takes the click without taking focus.
    Request 'ap1' 20000
    $deny = Find-HudButton $script:hwnd '^DENY$' 8000
    $approve = Find-HudButton $script:hwnd '^APPROVE$' 2000
    $pd = Centre $deny; $pa = Centre $approve
    Start-Sleep -Milliseconds 1300   # armed (page 1 s, host 0.8 s)
    $shown = WaitText 'APPROVAL REQUIRED: ONE ACTION' 2000
    $text = Get-HudText $script:hwnd
    Record '2a. the panel shows the exact operation, target, parameters, text and expiry' ($shown -and $text -match 'fixture\.exe' -and $text -match 'D-ASK approval fixture' -and $text -match 'Fixture search box' -and $text -match 'fixture text to enter' -and $text -match 'expires in' -and $text -match 'Elevated') @{ shown = $shown }
    Record '2b. outside the panel, an approval does not make the HUD interactive' ((SafeClickAt $corner.X $corner.Y) -eq 1) @{ mode = (Get-HudMode $script:hwnd) }
    [void][HudInput]::SetCursorPos($pd.X, $pd.Y); Start-Sleep -Milliseconds 200
    Record '2c. over the panel, only the panel takes input, still non-activating' ((-not (Transparent)) -and (NoActivate) -and ((Get-HudMode $script:hwnd) -eq 'ambient')) @{ exStyle = ('0x{0:X}' -f (Get-HudExStyle $script:hwnd)) }
    $fgBefore = [ApprW]::GetForegroundWindow()
    $leak = SafeClickAt $pd.X $pd.Y
    $denied = WaitText 'APPROVAL DENIED' 4000
    Record '2d. Deny works: decision sent, nothing reached the application behind, focus not taken' (($leak -eq 0) -and ((Decisions 'ap1') -join ',') -eq 'false' -and $denied -and ([ApprW]::GetForegroundWindow() -ne $script:hwnd)) @{ probeClicks = $leak; decisions = (Decisions 'ap1'); terminalShown = $denied; foregroundUnchanged = ([ApprW]::GetForegroundWindow() -eq $fgBefore) }
    Record '2e. after the decision the panel no longer takes clicks; nothing more is decided' (((SafeClickAt $pa.X $pa.Y) -eq 1) -and (Decisions 'ap1').Count -eq 1) @{ decisions = (Decisions 'ap1') }

    # 3. Approve works.
    Start-Sleep -Seconds 5   # the terminal panel closes
    Request 'ap2' 20000
    $approve = Find-HudButton $script:hwnd '^APPROVE$' 8000; $pa = Centre $approve
    Start-Sleep -Milliseconds 1300
    $leak = SafeClickAt $pa.X $pa.Y
    Record '3. Approve works, and the panel shows approved only after the (fixture) daemon confirms' (($leak -eq 0) -and ((Decisions 'ap2') -join ',') -eq 'true' -and (WaitText 'APPROVAL APPROVED' 4000)) @{ probeClicks = $leak; decisions = (Decisions 'ap2') }

    # 4. A click in flight when the panel appears does not land on it (arming).
    Start-Sleep -Seconds 5
    Request 'ap3' 20000
    $approve = Find-HudButton $script:hwnd '^APPROVE$' 8000; $pa = Centre $approve
    $early = SafeClickAt $pa.X $pa.Y
    Record '4. a click before the panel is armed passes through and decides nothing' (($early -eq 1) -and (Decisions 'ap3').Count -eq 0) @{ probeClicks = $early; decisions = (Decisions 'ap3') }
    Cancel 'ap3'
    $cancelled = WaitText 'APPROVAL CANCELLED' 4000
    Record '5. cancellation removes the approval: the panel says so and takes no more clicks' ($cancelled -and ((SafeClickAt $pa.X $pa.Y) -eq 1) -and (Decisions 'ap3').Count -eq 0) @{ shown = $cancelled; decisions = (Decisions 'ap3') }

    # 6. Expiry.
    Start-Sleep -Seconds 5
    Request 'ap4' 3000
    $approve = Find-HudButton $script:hwnd '^APPROVE$' 8000; $pa = Centre $approve
    Start-Sleep -Milliseconds 3500
    $expired = WaitText 'APPROVAL EXPIRED' 3000
    Record '6. expiry: the panel says so, and a click where Approve was reaches the application behind' ($expired -and ((SafeClickAt $pa.X $pa.Y) -eq 1) -and (Decisions 'ap4').Count -eq 0) @{ shown = $expired; decisions = (Decisions 'ap4') }

    # 7. Interactive and Hidden behave as before.
    if ($hotkeysOk) {
        Start-Sleep -Seconds 5
        [void][HudInput]::SetForegroundWindow($script:probeHwnd); Start-Sleep -Milliseconds 300
        Send-HudToggleHotkey
        $interactive = $true; try { [void](Wait-HudMode $script:hwnd 'interactive' 5000) } catch { $interactive = $false }
        Record '7a. interactive: Ctrl+Alt+Space still makes the HUD interactive' $interactive @{ mode = (Get-HudMode $script:hwnd) }
        if ($interactive) {
            Record '7b. interactive: empty areas still pass clicks through' ((SafeClickAt $corner.X $corner.Y) -eq 1) @{}
            Send-HudToggleHotkey; try { [void](Wait-HudMode $script:hwnd 'ambient' 5000) } catch { }
        }
        [void][HudInput]::SetForegroundWindow($script:probeHwnd); Start-Sleep -Milliseconds 300
        Send-HudHideHotkey
        $hidden = $true; try { [void](Wait-HudMode $script:hwnd 'hidden' 5000) } catch { $hidden = $false }
        Record '7c. hidden: Ctrl+Alt+H hides the HUD and clicks reach the application' ($hidden -and ((SafeClickAt $cx $cy) -eq 1)) @{ mode = (Get-HudMode $script:hwnd) }
        Send-HudHideHotkey; try { [void](Wait-HudMode $script:hwnd 'ambient' 5000) } catch { }
        Record '7d. back to ambient: click-through restored' (((Get-HudMode $script:hwnd) -eq 'ambient') -and ((SafeClickAt $cx $cy) -eq 1)) @{ mode = (Get-HudMode $script:hwnd) }
    } else {
        Record '7. interactive/hidden checks skipped: the HUD did not register its hotkeys' $false @{ reason = 'hotkey registration failed; no chord was sent' }
    }
}
catch {
    Record 'aborted' $false @{ error = $_.Exception.Message }
}
finally {
    if ($probe) { try { Stop-Process -Id $probe.Id -Force -ErrorAction SilentlyContinue } catch { } }
    if ($hud) { try { Stop-Process -Id $hud.Id -Force -ErrorAction SilentlyContinue } catch { } }
    foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
    $pass = @($script:results | Where-Object { -not $_.pass }).Count -eq 0
    [pscustomobject]@{ when = (Get-Date).ToString('o'); passed = @($script:results | Where-Object pass).Count; failed = @($script:results | Where-Object { -not $_.pass }).Count; results = $script:results } |
        ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $OutDir 'approval-surface.json')
    "{0} passed, {1} failed" -f @($script:results | Where-Object pass).Count, @($script:results | Where-Object { -not $_.pass }).Count
    if (-not $pass) { exit 1 }
}
