# Click-through over the orb itself, with real mouse input and a real application placed directly behind the orb's
# centre. Covers ambient (centre and outer ring), interactive (centre, drag, scroll), the switches between them,
# repeated switching, Emergency Stop in ambient, a second HUD instance, and a hotkey held by another program.
# Starts and stops only its own processes. Results go to -OutDir (orb-clickthrough.json and screenshots).
param([string]$OutDir, [string]$Config = 'Release', [string]$Root)
$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = (Resolve-Path "$PSScriptRoot\..\..").Path }
. "$PSScriptRoot\hud-driver.ps1"
New-Item -ItemType Directory -Force $OutDir | Out-Null

if (-not ('OrbW' -as [type])) {
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Threading;
public static class OrbW {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint c);
  // True when `lower` comes after `upper` in the z-order.
  public static bool IsBelow(IntPtr lower, IntPtr upper) { for (IntPtr w = GetWindow(upper, 2); w != IntPtr.Zero; w = GetWindow(w, 2)) if (w == lower) return true; return false; }
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, int d, IntPtr e);
  [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr h, int id, uint mods, uint vk);
  [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr h, int id);
  [DllImport("user32.dll")] static extern bool GetMessage(out MSG m, IntPtr h, uint a, uint b);
  [DllImport("user32.dll")] static extern bool PostThreadMessage(uint t, uint m, IntPtr w, IntPtr l);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr h; public uint m; public IntPtr w; public IntPtr l; public uint t; public POINT p; }
  // Holds Ctrl+Alt+Space on a thread of this process, the way another program would.
  static uint holderThread; public static bool HeldOk;
  public static void HoldToggleHotkey() {
    var ready = new ManualResetEvent(false);
    var t = new Thread(() => { holderThread = GetCurrentThreadId(); HeldOk = RegisterHotKey(IntPtr.Zero, 0x7001, 0x0002 | 0x0001 | 0x4000, 0x20); ready.Set(); MSG m; while (GetMessage(out m, IntPtr.Zero, 0, 0)) { } UnregisterHotKey(IntPtr.Zero, 0x7001); });
    t.IsBackground = true; t.Start(); ready.WaitOne();
  }
  public static void ReleaseToggleHotkey() { PostThreadMessage(holderThread, 0x0012, IntPtr.Zero, IntPtr.Zero); Thread.Sleep(200); }
}
'@
}

$script:results = New-Object System.Collections.ArrayList
function Record([string]$Name, [bool]$Pass, $Detail) {
    [void]$script:results.Add([pscustomobject]@{ name = $Name; pass = $Pass; detail = $Detail })
    "{0}  {1}  {2}" -f $(if ($Pass) { ' ok ' } else { 'FAIL' }), $Name, ($Detail | ConvertTo-Json -Compress -Depth 4)
}
function HudAt([int]$x, [int]$y) { $p = New-Object OrbW+POINT; $p.X = $x; $p.Y = $y; [OrbW]::GetAncestor([OrbW]::WindowFromPoint($p), 2) -eq $script:hwnd }
function Clicks { for ($i = 0; $i -lt 20; $i++) { try { return (Get-Content $probeLog -Raw -ErrorAction Stop | ConvertFrom-Json).clicks } catch { Start-Sleep -Milliseconds 50 } }; throw 'probe log unreadable' }
# A real click at a point; returns how many clicks the probe received.
function ClickAt([int]$x, [int]$y) { [void][HudInput]::SetCursorPos($x, $y); Start-Sleep -Milliseconds 120; $b = Clicks; [HudInput]::Click(); Start-Sleep -Milliseconds 350; (Clicks) - $b }
function Telemetry([string]$Label) {
    $lines = (Get-HudText $hwnd) -split "`n"
    $i = [Array]::IndexOf($lines, "$($Label):")
    if ($i -lt 0) { return $null }
    for ($j = $i + 1; $j -lt [Math]::Min($i + 4, $lines.Count); $j++) { if ($lines[$j] -match '^-?\d+(\.\d+)?$') { return [double]$lines[$j] } }
    return $null
}
function Start-Hud {
    & "$PSScriptRoot\start-stack.ps1" -OutDir $OutDir -Config $Config -Root $Root | Out-Null
    $script:pids = Get-Content "$OutDir\pids.json" -Raw | ConvertFrom-Json
    $script:hwnd = Get-HudHwnd $pids.hud
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while (-not (Select-String -Path "$OutDir\hud.log" -Pattern 'Registered Ctrl\+Alt\+H|Could not register Ctrl\+Alt\+H' -Quiet) -and $sw.ElapsedMilliseconds -lt 20000) { Start-Sleep -Milliseconds 200 }
    while (-not (Select-String -Path "$OutDir\hud.log" -Pattern 'Page viewport' -Quiet) -and $sw.ElapsedMilliseconds -lt 30000) { Start-Sleep -Milliseconds 200 }
    Start-Sleep -Seconds 2
}

# The orb is centred in the work area; its outer ring is about 200 px from the centre at this size.
$wr = New-Object OrbW+RECT
$probeLog = Join-Path $OutDir 'probe.json'
$probe = $null
try {
    $before = @(Get-Process hud-native -ErrorAction SilentlyContinue)
    if ($before.Count) { throw "Another hud-native is running (pid $($before.Id -join ', ')). Close it first; these tests need the hotkeys." }

    Start-Hud
    [void][OrbW]::GetWindowRect($hwnd, [ref]$wr)
    $cx = [int](($wr.L + $wr.R) / 2); $cy = [int](($wr.T + $wr.B) / 2)
    $ox = $cx + 200; $oy = $cy + 20

    if (Test-Path $probeLog) { Remove-Item $probeLog }
    $probe = Start-Process powershell -ArgumentList @('-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', "$PSScriptRoot\overlay-probe-app.ps1", '-X', ($cx - 220), '-Y', ($cy - 85), '-Width', 440, '-Height', 170, '-LogPath', $probeLog, '-TopMost') -WindowStyle Hidden -PassThru
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while (-not ((Test-Path $probeLog) -and (Get-Content $probeLog -Raw | ConvertFrom-Json).ready) -and $sw.ElapsedMilliseconds -lt 20000) { Start-Sleep -Milliseconds 200 }
    Start-Sleep -Milliseconds 800
    # Stacking: the HUD above the probe, and the probe above everything else (a maximised editor, say).
    [void][OrbW]::SetWindowPos($hwnd, [IntPtr](-1), 0, 0, 0, 0, 0x13)
    Start-Sleep -Milliseconds 300
    $probeWin = [OrbW]::GetAncestor([OrbW]::WindowFromPoint((New-Object OrbW+POINT -Property @{ X = $cx; Y = $cy })), 2)
    $probeWinPid = 0; [void][OrbW]::GetWindowThreadProcessId($probeWin, [ref]$probeWinPid)
    $order = [OrbW]::IsBelow($probeWin, $hwnd)
    $stackOk = ($probeWinPid -eq $probe.Id) -and $order
    Record 'setup: the probe is behind the orb, the HUD above it, and nothing else between' $stackOk @{ windowBehindOrbIsProbe = ($probeWinPid -eq $probe.Id); hudAboveProbe = $order }
    if (-not $stackOk) { throw 'The probe is not directly behind the HUD; clicks would land elsewhere.' }
    Save-HudShot $hwnd "$OutDir\01-probe-behind-orb.png"

    # 1 and 2. Ambient: centre and outer ring
    $mode = Get-HudMode $hwnd
    $c = ClickAt $cx $cy
    $o = ClickAt $ox $oy
    Record '1. ambient: a click on the orb centre reaches the application behind it' (($mode -eq 'ambient') -and ($c -eq 1) -and -not (HudAt $cx $cy)) @{ mode = $mode; probeClicks = $c; point = "$cx,$cy" }
    Record '2. ambient: a click on the orb outer ring reaches the application behind it' (($o -eq 1) -and -not (HudAt $ox $oy)) @{ probeClicks = $o; point = "$ox,$oy" }

    # 3. Interactive: the centre belongs to the orb
    Enter-HudInteractive $hwnd
    [void][HudInput]::SetCursorPos($cx, $cy); Start-Sleep -Milliseconds 150
    $c = ClickAt $cx $cy
    Record '3. interactive: a click on the orb centre goes to the orb, not behind it' (($c -eq 0) -and (HudAt $cx $cy)) @{ probeClicks = $c }

    # 4. Interactive: drag rotates the orb, the wheel zooms it
    $yaw0 = Telemetry 'YAW'; $zoom0 = Telemetry 'ZOOM'
    [void][HudInput]::SetCursorPos($cx, $cy); Start-Sleep -Milliseconds 150
    [OrbW]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
    for ($i = 1; $i -le 15; $i++) { [void][HudInput]::SetCursorPos($cx + 12 * $i, $cy); Start-Sleep -Milliseconds 25 }
    [OrbW]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 600
    $yaw1 = Telemetry 'YAW'
    [void][HudInput]::SetCursorPos($cx, $cy); Start-Sleep -Milliseconds 150
    for ($i = 0; $i -lt 3; $i++) { [OrbW]::mouse_event(0x0800, 0, 0, -120, [IntPtr]::Zero); Start-Sleep -Milliseconds 80 }
    Start-Sleep -Milliseconds 600
    $zoom1 = Telemetry 'ZOOM'
    Record '4. interactive: dragging rotates the orb and scrolling zooms it' (($null -ne $yaw1) -and ($yaw1 -ne $yaw0) -and ($null -ne $zoom1) -and ($zoom1 -ne $zoom0) -and ((Clicks) -ge 0)) @{ yawBefore = $yaw0; yawAfter = $yaw1; zoomBefore = $zoom0; zoomAfter = $zoom1 }
    Click-HudElement $hwnd (Find-HudButton $hwnd '^RESET \(R\)$')

    # 5. Interactive to ambient, both ways, with the cursor resting on the orb
    [void][HudInput]::SetCursorPos($cx, $cy); Start-Sleep -Milliseconds 200
    Send-HudToggleHotkey; [void](Wait-HudMode $hwnd 'ambient')
    $c = ClickAt $cx $cy; $o = ClickAt $ox $oy
    Enter-HudInteractive $hwnd
    [void][HudInput]::SetCursorPos($cx, $cy); Start-Sleep -Milliseconds 200
    Assert-HudForeground $hwnd; [HudInput]::Vk(0x1B); [void](Wait-HudMode $hwnd 'ambient')
    $c2 = ClickAt $cx $cy; $o2 = ClickAt $ox $oy
    Record '5. after interactive -> ambient (hotkey or Escape), every orb click passes through' (($c -eq 1) -and ($o -eq 1) -and ($c2 -eq 1) -and ($o2 -eq 1)) @{ hotkey = "$c,$o"; escape = "$c2,$o2" }

    # 6. Repeated switching with the cursor on the orb: no state leaks between modes
    $bad = @()
    [void][HudInput]::SetCursorPos($cx, $cy)
    for ($i = 1; $i -le 20; $i++) {
        Send-HudToggleHotkey
        $want = if ($i % 2 -eq 1) { 'interactive' } else { 'ambient' }
        [void](Wait-HudMode $hwnd $want)
        Start-Sleep -Milliseconds (40 + 20 * ($i % 4))
        $ex = Get-HudExStyle $hwnd
        $transparent = ($ex -band 0x20) -ne 0
        if ($want -eq 'ambient' -and -not $transparent) { $bad += "round $i ambient without click-through" }
        if ($want -eq 'interactive' -and $transparent) { $bad += "round $i interactive but click-through over the orb" }
    }
    $c = ClickAt $cx $cy; $o = ClickAt $ox $oy
    Record '6. 20 quick switches with the cursor on the orb: each mode had the right input state; ambient at the end passes clicks' (($bad.Count -eq 0) -and ((Get-HudMode $hwnd) -eq 'ambient') -and ($c -eq 1) -and ($o -eq 1)) @{ problems = $bad; finalClicks = "$c,$o" }

    # 7. Emergency Stop in ambient, cursor on the orb, during a real task
    Enter-HudInteractive $hwnd
    # The daemon's own record that the task started: the HUD shows UNDERSTANDING as soon as it submits.
    $accepted = @(Select-String -Path "$OutDir\daemon.log" -Pattern 'task t[0-9a-f]+ accepted').Count
    Submit-HudRequest $hwnd 'What is 31*4?'
    $sw.Restart(); while (@(Select-String -Path "$OutDir\daemon.log" -Pattern 'task t[0-9a-f]+ accepted').Count -le $accepted -and $sw.ElapsedMilliseconds -lt 60000) { Start-Sleep -Milliseconds 50 }
    Start-Sleep -Milliseconds 300
    Send-HudToggleHotkey; [void](Wait-HudMode $hwnd 'ambient')
    [void][HudInput]::SetCursorPos($cx, $cy)
    $stops = @(Select-String -Path "$OutDir\daemon.log" -Pattern "Triggered from source 'GlobalHotkey'").Count
    [HudInput]::Chord([uint16[]]@(0x11, 0x10), 0x7B)
    $sw.Restart(); while (@(Select-String -Path "$OutDir\daemon.log" -Pattern "Triggered from source 'GlobalHotkey'").Count -le $stops -and $sw.ElapsedMilliseconds -lt 5000) { Start-Sleep -Milliseconds 20 }
    $stopMs = $sw.ElapsedMilliseconds
    $c = ClickAt $cx $cy
    $cancelled = $false; $sw.Restart(); while (-not $cancelled -and $sw.ElapsedMilliseconds -lt 15000) { $cancelled = Select-String -Path "$OutDir\daemon.log" -Pattern 'finished: cancelled' -Quiet; Start-Sleep -Milliseconds 100 }
    Record '7. Ctrl+Shift+F12 in ambient stops the task; the orb still passes clicks' ((@(Select-String -Path "$OutDir\daemon.log" -Pattern "Triggered from source 'GlobalHotkey'").Count -gt $stops) -and $cancelled -and ($c -eq 1) -and ((Get-HudMode $hwnd) -eq 'ambient')) @{ hotkeyToDaemonMs = $stopMs; taskCancelled = $cancelled; orbClickAfterStop = $c }
    Enter-HudInteractive $hwnd
    Click-HudElement $hwnd (Find-HudButton $hwnd 'RESUME')
    [void](Find-HudButton $hwnd 'STOP \[Ctrl' 8000)
    Send-HudToggleHotkey; [void](Wait-HudMode $hwnd 'ambient')

    # The cause found in human testing: a second HUD. It must exit and leave the first one as it was.
    $second = Start-Process -FilePath (Join-Path $Root "src\hud-native\target\$($Config.ToLower())\hud-native.exe") -WorkingDirectory $Root -PassThru
    $exited = $second.WaitForExit(10000)
    $c = ClickAt $cx $cy
    Record 'a second HUD instance exits at once; the first stays ambient and click-through' ($exited -and ((Get-HudMode $hwnd) -eq 'ambient') -and ($c -eq 1)) @{ secondExited = $exited; firstMode = Get-HudMode $hwnd; orbClick = $c }
} catch {
    Record 'orb click-through tests aborted' $false @{ error = "$_"; line = $_.InvocationInfo.ScriptLineNumber }
    if ($hwnd) { try { Save-HudShot $hwnd "$OutDir\aborted.png" } catch {} }
} finally {
    if (Test-Path "$OutDir\pids.json") { & "$PSScriptRoot\stop-stack.ps1" -OutDir $OutDir | Out-Null }
}

# The other half of that cause: a hotkey owned by another program. The HUD must stay click-through, not interactive.
try {
    [OrbW]::HoldToggleHotkey()
    $held = [OrbW]::HeldOk
    $dir2 = Join-Path $OutDir 'hotkey-taken'
    $saved = $OutDir; $OutDir = $dir2; New-Item -ItemType Directory -Force $dir2 | Out-Null
    Start-Hud
    $warned = Select-String -Path "$dir2\hud.log" -Pattern 'Could not register Ctrl\+Alt\+Space' -Quiet
    $mode = Get-HudMode $hwnd
    $c = ClickAt $cx $cy; $o = ClickAt $ox $oy
    Save-HudShot $hwnd "$dir2\hotkey-taken.png"
    $notice = (Wait-HudText $hwnd 'ANOTHER PROGRAM' 8000).Found
    Record 'with Ctrl+Alt+Space owned by another program, the HUD stays ambient and the orb passes clicks' ($held -and $warned -and ($mode -eq 'ambient') -and ($c -eq 1) -and ($o -eq 1) -and $notice) @{ hotkeyHeldByTest = $held; hudLoggedConflict = [bool]$warned; mode = $mode; orbClicks = "$c,$o"; noticeShown = $notice }
} catch {
    Record 'hotkey-conflict test aborted' $false @{ error = "$_"; line = $_.InvocationInfo.ScriptLineNumber }
} finally {
    [OrbW]::ReleaseToggleHotkey()
    if (Test-Path "$OutDir\pids.json") { & "$PSScriptRoot\stop-stack.ps1" -OutDir $OutDir | Out-Null }
    if ($saved) { $OutDir = $saved }
    if ($probe) { Stop-Process -Id $probe.Id -Force -ErrorAction SilentlyContinue }
}
$script:results | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 "$OutDir\orb-clickthrough.json"
"`n$(@($script:results | Where-Object pass).Count) of $($script:results.Count) passed"
