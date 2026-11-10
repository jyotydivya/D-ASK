# Full-screen overlay tests on the real stack, with real mouse and keyboard input (SendInput) and real applications
# under the HUD: a probe window of known colour that records the input it receives, and Notepad. Starts and stops
# only its own processes. Results go to -OutDir (overlay-tests.json and screenshots).
# Notepad is NOT used unless -WithNotepad is given: Windows 11 Notepad restores the previous session when it starts,
# which reopens the user's own windows and unsaved tabs. Run that part only on a machine whose Notepad session holds
# nothing of value.
param([string]$OutDir, [string]$Config = 'Debug', [string]$Root, [switch]$WithNotepad)
$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = (Resolve-Path "$PSScriptRoot\..\..").Path }
. "$PSScriptRoot\hud-driver.ps1"
New-Item -ItemType Directory -Force $OutDir | Out-Null

if (-not ('OvW' -as [type])) {
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class OvW {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct MI { public int cb; public RECT mon; public RECT work; public uint flags; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MI i);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowDpiAwarenessContext(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetAwarenessFromDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
}
'@
}

$script:results = New-Object System.Collections.ArrayList
function Record([string]$Name, [bool]$Pass, $Detail) {
    [void]$script:results.Add([pscustomobject]@{ name = $Name; pass = $Pass; detail = $Detail })
    "{0}  {1}  {2}" -f $(if ($Pass) { ' ok ' } else { 'FAIL' }), $Name, ($Detail | ConvertTo-Json -Compress -Depth 4)
}
function Rect-Of([IntPtr]$h) { $r = New-Object OvW+RECT; [void][OvW]::GetWindowRect($h, [ref]$r); $r }
function Root-At([int]$x, [int]$y) { $p = New-Object OvW+POINT; $p.X = $x; $p.Y = $y; [OvW]::GetAncestor([OvW]::WindowFromPoint($p), 2) }
# A real click at a screen point. No foreground check on purpose: in ambient mode the click must go wherever
# Windows sends it, which is the point of the test.
function Click-At([int]$x, [int]$y) { [void][HudInput]::SetCursorPos($x, $y); Start-Sleep -Milliseconds 150; [HudInput]::Click(); Start-Sleep -Milliseconds 250 }
# The probe rewrites its log on every event, so a read can meet a write; retry briefly.
function Probe {
    for ($i = 0; $i -lt 20; $i++) {
        try { return (Get-Content $probeLog -Raw -ErrorAction Stop | ConvertFrom-Json) } catch { Start-Sleep -Milliseconds 50 }
    }
    throw "Could not read the probe log"
}
function Count-Log([string]$Pattern) { @(Select-String -Path "$OutDir\hud.log" -Pattern $Pattern).Count }
function Daemon-Log-Count([string]$Pattern) { @(Select-String -Path "$OutDir\daemon.log" -Pattern $Pattern).Count }
function Capture([int]$x, [int]$y, [int]$w, [int]$h, [string]$Path) {
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($x, $y, 0, 0, $bmp.Size); $g.Dispose()
    if ($Path) { $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png) }
    $bmp
}
# Per-pixel colour distance between two captures of the same area, sampled every 4 px.
function Compare-Captures($a, $b) {
    $d = New-Object System.Collections.Generic.List[double]
    for ($yy = 0; $yy -lt $a.Height; $yy += 4) { for ($xx = 0; $xx -lt $a.Width; $xx += 4) {
        $p = $a.GetPixel($xx, $yy); $q = $b.GetPixel($xx, $yy)
        $d.Add([math]::Sqrt([math]::Pow($p.R - $q.R, 2) + [math]::Pow($p.G - $q.G, 2) + [math]::Pow($p.B - $q.B, 2)))
    } }
    $sorted = $d | Sort-Object
    [pscustomobject]@{ samples = $d.Count; median = [math]::Round($sorted[[int]($d.Count / 2)], 1); within60 = [math]::Round(100 * @($d | Where-Object { $_ -le 60 }).Count / $d.Count, 1) }
}
function Refocus-Hud { Send-HudToggleHotkey; Start-Sleep -Milliseconds 400; if ((Get-HudMode $hwnd) -ne 'interactive') { Enter-HudInteractive $hwnd } }

# Probe placement (physical px): below the orb, clear of the panels, inside the work area.
$PX = 420; $PY = 800; $PW = 440; $PH = 170
$probeLog = Join-Path $OutDir 'probe.json'
$probeProc = $null; $notepadHwnd = [IntPtr]::Zero; $notepadFile = $null

try {
    & "$PSScriptRoot\start-stack.ps1" -OutDir $OutDir -Config $Config -Root $Root | Out-Null
    $pids = Get-Content "$OutDir\pids.json" -Raw | ConvertFrom-Json
    $script:hwnd = Get-HudHwnd $pids.hud
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ((Count-Log 'Page viewport') -eq 0 -and $sw.ElapsedMilliseconds -lt 20000) { Start-Sleep -Milliseconds 200 }
    while ((Count-Log 'Registered Ctrl\+Alt\+H') -eq 0 -and $sw.ElapsedMilliseconds -lt 20000) { Start-Sleep -Milliseconds 200 }
    Start-Sleep -Seconds 2
    $handshakesAtStart = Count-Log 'Handshake accepted'

    # ── 1. Bounds ──
    $mi = New-Object OvW+MI; $mi.cb = [Runtime.InteropServices.Marshal]::SizeOf($mi)
    [void][OvW]::GetMonitorInfo([OvW]::MonitorFromWindow($hwnd, 2), [ref]$mi)
    $wr = Rect-Of $hwnd
    $vp = [regex]::Match((Get-Content "$OutDir\hud.log" -Raw), 'Page viewport ([\d.]+)x([\d.]+) CSS px at DPR ([\d.]+)')
    $cssW = [double]$vp.Groups[1].Value; $cssH = [double]$vp.Groups[2].Value; $dpr = [double]$vp.Groups[3].Value
    $boundsOk = ($wr.L -eq $mi.work.L) -and ($wr.T -eq $mi.work.T) -and ($wr.R -eq $mi.work.R) -and ($wr.B -eq $mi.work.B)
    $pageOk = ([math]::Abs($cssW * $dpr - ($wr.R - $wr.L)) -le 2) -and ([math]::Abs($cssH * $dpr - ($wr.B - $wr.T)) -le 2)
    Record '1. the HUD covers exactly the work area, and the page fills it' ($boundsOk -and $pageOk) @{ window = "$($wr.L),$($wr.T),$($wr.R),$($wr.B)"; workArea = "$($mi.work.L),$($mi.work.T),$($mi.work.R),$($mi.work.B)"; monitor = "$($mi.mon.R)x$($mi.mon.B)"; page = "${cssW}x${cssH} CSS px at DPR $dpr" }
    Record 'starts in ambient mode, not focused' (((Get-HudMode $hwnd) -eq 'ambient') -and ([HudInput]::GetForegroundWindow() -ne $hwnd)) @{ mode = Get-HudMode $hwnd }

    # Probe application under the HUD
    if (Test-Path $probeLog) { Remove-Item $probeLog }
    $probeProc = Start-Process powershell -ArgumentList @('-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', "$PSScriptRoot\overlay-probe-app.ps1", '-X', $PX, '-Y', $PY, '-Width', $PW, '-Height', $PH, '-LogPath', $probeLog) -WindowStyle Hidden -PassThru
    $sw.Restart(); while (-not ((Test-Path $probeLog) -and (Probe).ready) -and $sw.ElapsedMilliseconds -lt 20000) { Start-Sleep -Milliseconds 200 }
    Start-Sleep -Milliseconds 800
    $btnX = $PX + 110; $btnY = $PY + 45; $boxX = $PX + 310; $boxY = $PY + 45
    $probeRoot = Root-At $btnX $btnY
    $probePid = 0; [void][OvW]::GetWindowThreadProcessId($probeRoot, [ref]$probePid)
    Save-HudShot $hwnd "$OutDir\01-ambient-over-probe.png"

    # ── 3. Ambient: clicks reach the application underneath ──
    $before = (Probe).clicks
    Click-At $btnX $btnY
    Click-At $btnX $btnY
    $after = (Probe).clicks
    Record '3. ambient: clicks pass through the HUD to the application underneath' (($after - $before) -eq 2 -and $probeRoot -ne $hwnd) @{ clicksReceived = $after - $before; windowUnderCursorIsHud = ($probeRoot -eq $hwnd); hudMode = Get-HudMode $hwnd }

    # ── 4. Ambient: keyboard goes to the focused application; the HUD never takes focus ──
    Click-At $boxX $boxY
    [HudInput]::Text('typed under the HUD')
    Start-Sleep -Milliseconds 400
    $fgHud = $false
    for ($i = 0; $i -lt 20; $i++) { if ([HudInput]::GetForegroundWindow() -eq $hwnd) { $fgHud = $true }; Start-Sleep -Milliseconds 100 }
    $fgPid = 0; [void][OvW]::GetWindowThreadProcessId([HudInput]::GetForegroundWindow(), [ref]$fgPid)
    Record '4. ambient: typing reaches the focused application and the HUD never takes focus' (((Probe).text -eq 'typed under the HUD') -and -not $fgHud -and ($fgPid -eq $probePid)) @{ probeText = (Probe).text; hudWasForeground = $fgHud }

    # ── 2 and 8. Transparency (ambient vs hidden), and hidden keeps everything running ──
    $sx = $PX + 20; $sy = $PY + 95; $swd = $PW - 40; $sht = 60
    $ambientCap = Capture $sx $sy $swd $sht "$OutDir\02-ambient-sample.png"
    $hostBefore = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'stdioHost' }).Count
    Send-HudHideHotkey
    $hideMs = Wait-HudMode $hwnd 'hidden'
    Start-Sleep -Milliseconds 600
    $hiddenCap = Capture $sx $sy $swd $sht "$OutDir\03-hidden-sample.png"
    $cmp = Compare-Captures $ambientCap $hiddenCap
    $probeColour = $hiddenCap.GetPixel([int]($swd / 2), [int]($sht / 2))
    $ambientCap.Dispose(); $hiddenCap.Dispose()
    Record '2. transparent regions show the application underneath (ambient vs hidden, same area)' (($cmp.median -le 40) -and ($cmp.within60 -ge 80)) @{ medianColourDistance = $cmp.median; percentWithin60 = $cmp.within60; samples = $cmp.samples; underlying = "$($probeColour.R),$($probeColour.G),$($probeColour.B)" }
    $alive = [bool](Get-Process -Id $pids.daemon -ErrorAction SilentlyContinue) -and [bool](Get-Process -Id $pids.hud -ErrorAction SilentlyContinue)
    Record '8. hidden: the window is hidden; HUD and daemon keep running' ((-not [OvW]::IsWindowVisible($hwnd)) -and $alive) @{ hideMs = $hideMs; daemonAndHudAlive = $alive }
    $before = (Probe).clicks; Click-At $btnX $btnY
    Record '8. hidden: the application underneath is fully usable' (((Probe).clicks - $before) -eq 1) @{}
    Send-HudHideHotkey
    [void](Wait-HudMode $hwnd 'ambient')
    Record '8. Ctrl+Alt+H brings the HUD back in ambient mode, without focus' (([OvW]::IsWindowVisible($hwnd)) -and ([HudInput]::GetForegroundWindow() -ne $hwnd)) @{ mode = Get-HudMode $hwnd }

    # ── 5. Interactive: HUD controls take clicks ──
    Enter-HudInteractive $hwnd
    $fgOk = [HudInput]::GetForegroundWindow() -eq $hwnd
    $sound = Find-HudButton $hwnd '^SOUND (ON|OFF) \(M\)$'
    $was = $sound.Current.Name
    Click-HudElement $hwnd $sound
    Start-Sleep -Milliseconds 400
    $now = (Find-HudButton $hwnd '^SOUND (ON|OFF) \(M\)$').Current.Name
    Click-HudElement $hwnd (Find-HudButton $hwnd '^SOUND (ON|OFF) \(M\)$')
    Save-HudShot $hwnd "$OutDir\04-interactive.png"
    Record '5. interactive: the hotkey focuses the HUD and its controls take clicks' ($fgOk -and ($was -ne $now)) @{ before = $was; afterClick = $now }

    # ── 6. Interactive: a task from the HUD ──
    Submit-HudRequest $hwnd 'What is (17+25)*2?'
    Start-Sleep -Milliseconds 300
    $o = Wait-HudOutcome $hwnd 180000
    $verified = (Get-HudText $hwnd) -match '(?m)^INDEPENDENTLY VERIFIED$'
    Save-HudShot $hwnd "$OutDir\05-task.png"
    Record '6. interactive: a task submitted from the HUD completes with verification' (($o.Outcome -eq 'COMPLETED') -and $verified) @{ outcome = $o.Outcome; ms = $o.Ms }

    # ── Selective hit-testing: in interactive mode, empty areas still pass clicks through ──
    $before = (Probe).clicks
    $probeRootNow = Root-At $btnX $btnY
    Click-At $btnX $btnY
    Record 'interactive: a click outside the HUD controls still reaches the application underneath' ((((Probe).clicks - $before) -eq 1) -and ((Get-HudMode $hwnd) -eq 'interactive')) @{ clicksReceived = (Probe).clicks - $before; mode = Get-HudMode $hwnd }
    $inputEl = Find-HudElement $hwnd -AutomationId 'ultron-command'
    $ib = $inputEl.Current.BoundingRectangle
    [void][HudInput]::SetCursorPos([int]($ib.X + $ib.Width / 2), [int]($ib.Y + $ib.Height / 2)); Start-Sleep -Milliseconds 200
    $overControl = (Root-At ([int]($ib.X + $ib.Width / 2)) ([int]($ib.Y + $ib.Height / 2))) -eq $hwnd
    [void][HudInput]::SetCursorPos($btnX, $btnY); Start-Sleep -Milliseconds 200
    $overEmpty = (Root-At $btnX $btnY) -eq $hwnd
    Record 'interactive: the HUD takes input over a control and not over empty space' ($overControl -and -not $overEmpty) @{ hudHitOverInput = $overControl; hudHitOverEmptySpace = $overEmpty }

    # ── 10. CANCEL, STOP and RESUME in interactive mode ──
    Refocus-Hud
    Submit-HudRequest $hwnd 'What is 91*3?'
    [void](Wait-HudText $hwnd '(?m)^(PLANNING|UNDERSTANDING|EXECUTING)$' 30000)
    Click-HudElement $hwnd (Find-HudButton $hwnd '^CANCEL$')
    $o = Wait-HudOutcome $hwnd 30000
    Record '10. CANCEL ends a running task as cancelled' ($o.Outcome -eq 'CANCELLED') @{ outcome = $o.Outcome }
    Start-Sleep -Seconds 6
    Submit-HudRequest $hwnd 'What is 123+456?'
    [void](Wait-HudText $hwnd '(?m)^(PLANNING|UNDERSTANDING|EXECUTING)$' 30000)
    Click-HudElement $hwnd (Find-HudButton $hwnd 'STOP \[Ctrl')
    $o = Wait-HudOutcome $hwnd 30000
    $resume = Find-HudButton $hwnd 'RESUME' 5000
    Click-HudElement $hwnd $resume
    $back = [bool](Find-HudButton $hwnd 'STOP \[Ctrl' 8000)
    $r = $null; Submit-HudRequest $hwnd 'What is 6*7?'; Start-Sleep -Milliseconds 300; $r = Wait-HudOutcome $hwnd 120000
    Record '10. STOP cancels, RESUME clears, and the next task completes' (($o.Outcome -eq 'CANCELLED') -and $back -and ($r.Outcome -eq 'COMPLETED')) @{ stop = $o.Outcome; resumed = $back; next = $r.Outcome }

    # ── 7. Escape returns to ambient, focus goes back, clicks pass through again ──
    Assert-HudForeground $hwnd
    [HudInput]::Vk(0x1B)
    $escMs = Wait-HudMode $hwnd 'ambient'
    Start-Sleep -Milliseconds 300
    $before = (Probe).clicks
    Click-At $btnX $btnY
    Record '7. Escape returns to ambient and clicks reach the application again' ((((Probe).clicks - $before) -eq 1) -and ([HudInput]::GetForegroundWindow() -ne $hwnd)) @{ escapeToAmbientMs = $escMs; clicksReceived = (Probe).clicks - $before }
    Enter-HudInteractive $hwnd
    Send-HudToggleHotkey
    $hkMs = Wait-HudMode $hwnd 'ambient'
    $before = (Probe).clicks; Click-At $btnX $btnY
    Record '7. Ctrl+Alt+Space also returns to ambient' (((Probe).clicks - $before) -eq 1) @{ hotkeyToAmbientMs = $hkMs }

    # ── 9. Emergency Stop in ambient and in hidden mode ──
    Enter-HudInteractive $hwnd
    Submit-HudRequest $hwnd 'What is 31*4?'
    [void](Wait-HudText $hwnd '(?m)^(PLANNING|UNDERSTANDING|EXECUTING)$' 30000)
    Send-HudToggleHotkey; [void](Wait-HudMode $hwnd 'ambient')
    $stopsBefore = Daemon-Log-Count "Triggered from source 'GlobalHotkey'"
    [HudInput]::Chord([uint16[]]@(0x11, 0x10), 0x7B)
    $sw.Restart(); while ((Daemon-Log-Count "Triggered from source 'GlobalHotkey'") -le $stopsBefore -and $sw.ElapsedMilliseconds -lt 5000) { Start-Sleep -Milliseconds 20 }
    $stopMs = $sw.ElapsedMilliseconds
    $o = Wait-HudOutcome $hwnd 30000
    Record '9. Ctrl+Shift+F12 in ambient mode stops the running task' (((Daemon-Log-Count "Triggered from source 'GlobalHotkey'") -gt $stopsBefore) -and ($o.Outcome -eq 'CANCELLED')) @{ outcome = $o.Outcome; hotkeyToDaemonLogMs = $stopMs }
    Enter-HudInteractive $hwnd
    Click-HudElement $hwnd (Find-HudButton $hwnd 'RESUME')
    [void](Find-HudButton $hwnd 'STOP \[Ctrl' 8000)
    Send-HudHideHotkey; [void](Wait-HudMode $hwnd 'hidden')
    $stopsBefore = Daemon-Log-Count "Triggered from source 'GlobalHotkey'"
    [HudInput]::Chord([uint16[]]@(0x11, 0x10), 0x7B)
    $sw.Restart(); while ((Daemon-Log-Count "Triggered from source 'GlobalHotkey'") -le $stopsBefore -and $sw.ElapsedMilliseconds -lt 5000) { Start-Sleep -Milliseconds 20 }
    Record '9. Ctrl+Shift+F12 works while the HUD is hidden' ((Daemon-Log-Count "Triggered from source 'GlobalHotkey'") -gt $stopsBefore) @{ hotkeyToDaemonLogMs = $sw.ElapsedMilliseconds }
    Send-HudToggleHotkey; [void](Wait-HudMode $hwnd 'interactive')
    [void](Find-HudElement $hwnd -AutomationId 'ultron-command' -TimeoutMs 10000)
    Click-HudElement $hwnd (Find-HudButton $hwnd 'RESUME')
    [void](Find-HudButton $hwnd 'STOP \[Ctrl' 8000)

    # ── 8. A task keeps running while hidden, and its result is there afterwards ──
    Submit-HudRequest $hwnd 'What is 144/12?'
    [void](Wait-HudText $hwnd '(?m)^(PLANNING|UNDERSTANDING|EXECUTING)$' 30000)
    Send-HudHideHotkey; [void](Wait-HudMode $hwnd 'hidden')
    $daemonTaskDone = -1
    $sw.Restart()
    $finishedBefore = Daemon-Log-Count 'finished: completed'
    while ($sw.ElapsedMilliseconds -lt 60000) { if ((Daemon-Log-Count 'finished: completed') -gt $finishedBefore) { $daemonTaskDone = $sw.ElapsedMilliseconds; break }; Start-Sleep -Milliseconds 200 }
    Send-HudHideHotkey; [void](Wait-HudMode $hwnd 'ambient')
    Enter-HudInteractive $hwnd
    $o = Wait-HudOutcome $hwnd 10000
    Save-HudShot $hwnd "$OutDir\06-result-after-hidden.png"
    Record '8. a task started before hiding completes while hidden; the HUD shows its result after' (($daemonTaskDone -ge 0) -and ($o.Outcome -eq 'COMPLETED')) @{ completedWhileHiddenAfterMs = $daemonTaskDone; outcomeShown = $o.Outcome }

    # ── 12. DPI and display changes ──
    $dpi = [OvW]::GetDpiForWindow($hwnd)
    $awareness = [OvW]::GetAwarenessFromDpiAwarenessContext([OvW]::GetWindowDpiAwarenessContext($hwnd))
    Record '12. per-monitor DPI aware, and the page scale matches the window DPI' (($awareness -eq 2) -and ([math]::Abs($dpi / 96.0 - $dpr) -lt 0.01)) @{ windowDpi = $dpi; awareness = $awareness; pageDpr = $dpr }
    Send-HudToggleHotkey; [void](Wait-HudMode $hwnd 'ambient')
    $changesBefore = Count-Log 'Display area changed'
    # Stand-in for a resolution, taskbar or monitor change: the window is moved off its area from outside.
    [void][OvW]::SetWindowPos($hwnd, [IntPtr]::Zero, 200, 150, 900, 600, 0x14)
    $moved = Rect-Of $hwnd
    $sw.Restart(); do { Start-Sleep -Milliseconds 100; $r2 = Rect-Of $hwnd } while (-not ($r2.L -eq $mi.work.L -and $r2.T -eq $mi.work.T -and $r2.R -eq $mi.work.R -and $r2.B -eq $mi.work.B) -and $sw.ElapsedMilliseconds -lt 5000)
    $restoreMs = $sw.ElapsedMilliseconds
    Start-Sleep -Milliseconds 1500
    $lastVp = [regex]::Matches((Get-Content "$OutDir\hud.log" -Raw), 'Page viewport ([\d.]+)x([\d.]+) CSS px')
    $lv = $lastVp[$lastVp.Count - 1]
    $pageBack = ([math]::Abs([double]$lv.Groups[1].Value * $dpr - ($mi.work.R - $mi.work.L)) -le 2)
    $hitAfter = (Root-At $btnX $btnY) -ne $hwnd
    Record '12. after the display area changes, the HUD refits itself, the page follows, and click-through holds' (($restoreMs -lt 5000) -and ((Count-Log 'Display area changed') -gt $changesBefore) -and $pageBack -and $hitAfter) @{ movedTo = "$($moved.L),$($moved.T),$($moved.R),$($moved.B)"; restoredMs = $restoreMs; pageViewportAfter = "$($lv.Groups[1].Value)x$($lv.Groups[2].Value)" }
    Save-HudShot $hwnd "$OutDir\07-after-refit.png"

    # ── Acceptance: Notepad under the full-screen HUD ──
    if (-not $WithNotepad) {
        Record 'Notepad under the HUD' $true @{ skipped = 'not requested (see -WithNotepad)' }
    } elseif (Get-Process -Name notepad -ErrorAction SilentlyContinue) {
        Record 'Notepad under the HUD' $true @{ skipped = 'Notepad was already open; not touched, so as not to disturb your documents' }
    } else {
        $notepadFile = Join-Path $OutDir 'notepad-under-hud.txt'
        Set-Content -Path $notepadFile -Value '' -NoNewline
        Start-Process notepad.exe -ArgumentList "`"$notepadFile`"" | Out-Null
        $leaf = [IO.Path]::GetFileNameWithoutExtension($notepadFile)
        $sw.Restart()
        while ($notepadHwnd -eq [IntPtr]::Zero -and $sw.ElapsedMilliseconds -lt 15000) {
            Start-Sleep -Milliseconds 300
            [void][OvW]::EnumWindows({ param($h, $l) $sb = New-Object Text.StringBuilder 512; [void][OvW]::GetWindowText($h, $sb, 512); if ([OvW]::IsWindowVisible($h) -and $sb.ToString() -like "*$leaf*") { $script:notepadHwnd = $h; return $false }; return $true }, [IntPtr]::Zero)
        }
        if ($notepadHwnd -eq [IntPtr]::Zero) { throw 'Notepad did not open' }
        # Over the left half, under the orb and the panels.
        [void][OvW]::SetWindowPos($notepadHwnd, [IntPtr]::Zero, 340, 260, 900, 520, 0x14)
        Start-Sleep -Seconds 1
        $nr = Rect-Of $notepadHwnd
        $tx = $nr.L + 300; $ty = $nr.T + 300
        $hudOnTop = (Get-HudMode $hwnd) -eq 'ambient'
        Click-At $tx $ty
        [HudInput]::Text('Typed into Notepad through the full-screen D-ASK overlay.')
        Start-Sleep -Milliseconds 300
        [HudInput]::Chord([uint16[]]@(0x11), 0x53)    # Ctrl+S
        Start-Sleep -Seconds 1
        $saved = Get-Content $notepadFile -Raw
        Save-HudShot $hwnd "$OutDir\08-notepad-under-hud.png"
        Record 'acceptance: Notepad takes clicks and typing under the visible full-screen HUD' ($hudOnTop -and ($saved -eq 'Typed into Notepad through the full-screen D-ASK overlay.')) @{ savedText = $saved; hudMode = Get-HudMode $hwnd }
    }

    # ── 11. Nothing above disconnected the HUD from the daemon ──
    Record '11. every mode change kept the same daemon session' (((Count-Log 'Handshake accepted') -eq $handshakesAtStart) -and ((Count-Log 'write timed out') -eq 0) -and [bool](Get-Process -Id $pids.daemon -ErrorAction SilentlyContinue)) @{ handshakes = Count-Log 'Handshake accepted'; modeChanges = Count-Log '\[OVERLAY\] Mode' }
} catch {
    Record 'overlay tests aborted' $false @{ error = "$_"; line = $_.InvocationInfo.ScriptLineNumber }
    if ($hwnd) { try { Save-HudShot $hwnd "$OutDir\aborted.png" } catch {} }
} finally {
    if ($notepadHwnd -ne [IntPtr]::Zero) { [void][OvW]::PostMessage($notepadHwnd, 0x10, [IntPtr]::Zero, [IntPtr]::Zero) }
    if ($probeProc) { Stop-Process -Id $probeProc.Id -Force -ErrorAction SilentlyContinue }
    if (Test-Path "$OutDir\pids.json") { & "$PSScriptRoot\stop-stack.ps1" -OutDir $OutDir }
}
$script:results | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 "$OutDir\overlay-tests.json"
"`n$(@($script:results | Where-Object pass).Count) of $($script:results.Count) passed"
