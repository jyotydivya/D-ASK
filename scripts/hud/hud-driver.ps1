# Drives the real HUD window with real OS mouse and keyboard input and records what it shows.
# It finds controls through UI Automation, then clicks and types with SendInput, so everything goes
# through the same path as a person using the HUD. It never scripts the page.
# Input is only sent while the HUD is the foreground window; otherwise it stops instead of typing elsewhere.
#
#   . scripts/hud/hud-driver.ps1
#
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing
if (-not ('HudInput' -as [type])) {
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class HudInput {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; public uint pad1, pad2; }
  [StructLayout(LayoutKind.Explicit)] public struct U { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public U u; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] i, int size);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  static INPUT Key(ushort vk, ushort scan, uint flags) { var i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; return i; }
  public static void Click() { var a = new INPUT[2]; a[0].type = 0; a[0].u.mi.dwFlags = 2; a[1].type = 0; a[1].u.mi.dwFlags = 4; SendInput(2, a, Marshal.SizeOf(typeof(INPUT))); }
  public static void Text(string s) { foreach (char c in s) { var a = new[] { Key(0, c, 4), Key(0, c, 4 | 2) }; SendInput(2, a, Marshal.SizeOf(typeof(INPUT))); System.Threading.Thread.Sleep(8); } }
  public static void Vk(ushort vk) { var a = new[] { Key(vk, 0, 0), Key(vk, 0, 2) }; SendInput(2, a, Marshal.SizeOf(typeof(INPUT))); }
  public static void Chord(ushort[] mods, ushort vk) { foreach (var m in mods) { var d = new[] { Key(m, 0, 0) }; SendInput(1, d, Marshal.SizeOf(typeof(INPUT))); } Vk(vk); for (int k = mods.Length - 1; k >= 0; k--) { var u = new[] { Key(mods[k], 0, 2) }; SendInput(1, u, Marshal.SizeOf(typeof(INPUT))); } }
}
'@
}
[void][HudInput]::SetProcessDPIAware()

function Get-HudHwnd([int]$HudPid) {
    # By title and process: MainWindowHandle can be a helper window, since the HUD starts hidden and is shown without
    # being activated.
    [void](Get-Process -Id $HudPid -ErrorAction Stop)
    for ($i = 0; $i -lt 100; $i++) {
        $found = [HudWindows]::Find([uint32]$HudPid, 'D-ASK Holographic Orb HUD')
        if ($found -ne [IntPtr]::Zero) { return $found }
        Start-Sleep -Milliseconds 200
    }
    throw "HUD process $HudPid has no HUD window"
}

if (-not ('HudWindows' -as [type])) {
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class HudWindows {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static IntPtr Find(uint pid, string title) {
    IntPtr result = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid) return true;
      var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
      if (sb.ToString() == title) { result = h; return false; }
      return true;
    }, IntPtr.Zero);
    return result;
  }
}
'@
}

function Assert-HudForeground([IntPtr]$Hwnd) {
    [void][HudInput]::SetForegroundWindow($Hwnd)
    for ($i = 0; $i -lt 20; $i++) {
        if ([HudInput]::GetForegroundWindow() -eq $Hwnd) { return }
        Start-Sleep -Milliseconds 100
        [void][HudInput]::SetForegroundWindow($Hwnd)
    }
    throw "The HUD is not the foreground window; refusing to send input."
}

function Get-HudRoot([IntPtr]$Hwnd) { [System.Windows.Automation.AutomationElement]::FromHandle($Hwnd) }

function Find-HudElement([IntPtr]$Hwnd, [string]$Name, [string]$AutomationId, [int]$TimeoutMs = 8000) {
    $AE = [System.Windows.Automation.AutomationElement]
    $prop = if ($AutomationId) { $AE::AutomationIdProperty } else { $AE::NameProperty }
    $val = if ($AutomationId) { $AutomationId } else { $Name }
    $cond = New-Object System.Windows.Automation.PropertyCondition($prop, $val)
    $sw = [Diagnostics.Stopwatch]::StartNew()
    do {
        $e = (Get-HudRoot $Hwnd).FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
        if ($e) { return $e }
        Start-Sleep -Milliseconds 200
    } while ($sw.ElapsedMilliseconds -lt $TimeoutMs)
    throw "Control not found: $val"
}

function Click-HudElement([IntPtr]$Hwnd, $Element) {
    Assert-HudForeground $Hwnd
    $r = $Element.Current.BoundingRectangle
    if ($r.IsEmpty) { throw 'Control has no on-screen rectangle' }
    $x = [int]($r.X + $r.Width / 2); $y = [int]($r.Y + $r.Height / 2)
    [void][HudInput]::SetCursorPos($x, $y)
    Start-Sleep -Milliseconds 120
    Assert-HudForeground $Hwnd
    [HudInput]::Click()
}

function Type-HudText([IntPtr]$Hwnd, [string]$Text) {
    Assert-HudForeground $Hwnd
    [HudInput]::Text($Text)
}

function Press-HudEnter([IntPtr]$Hwnd) { Assert-HudForeground $Hwnd; [HudInput]::Vk(0x0D) }

function Save-HudShot([IntPtr]$Hwnd, [string]$Path) {
    $r = New-Object HudInput+RECT
    [void][HudInput]::GetWindowRect($Hwnd, [ref]$r)
    $w = $r.R - $r.L; $h = $r.B - $r.T
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($r.L, $r.T, 0, 0, (New-Object System.Drawing.Size $w, $h))
    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
}

# All text the HUD exposes right now, for the record and for waiting on a state.
function Get-HudText([IntPtr]$Hwnd) {
    $AE = [System.Windows.Automation.AutomationElement]
    $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)
    $all = (Get-HudRoot $Hwnd).FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
    $out = New-Object System.Collections.Generic.List[string]
    foreach ($e in $all) { $n = $e.Current.Name; if ($n) { $out.Add($n) } }
    return ($out -join "`n")
}

function Wait-HudText([IntPtr]$Hwnd, [string]$Pattern, [int]$TimeoutMs = 120000) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    do {
        $t = Get-HudText $Hwnd
        if ($t -match $Pattern) { return [pscustomobject]@{ Found = $true; Ms = $sw.ElapsedMilliseconds; Text = $t } }
        Start-Sleep -Milliseconds 100
    } while ($sw.ElapsedMilliseconds -lt $TimeoutMs)
    return [pscustomobject]@{ Found = $false; Ms = $sw.ElapsedMilliseconds; Text = $t }
}

# Sends one request the way a person would: click the box, type, press Enter.
function Submit-HudRequest([IntPtr]$Hwnd, [string]$Text) {
    $input_ = Find-HudElement $Hwnd -AutomationId 'ultron-command'
    Click-HudElement $Hwnd $input_
    Start-Sleep -Milliseconds 150
    Type-HudText $Hwnd $Text
    Start-Sleep -Milliseconds 150
    Press-HudEnter $Hwnd
}

function Find-HudButton([IntPtr]$Hwnd, [string]$Pattern, [int]$TimeoutMs = 8000) {
    $AE = [System.Windows.Automation.AutomationElement]
    $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
    $sw = [Diagnostics.Stopwatch]::StartNew()
    do {
        foreach ($b in (Get-HudRoot $Hwnd).FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)) {
            if ($b.Current.Name -match $Pattern) { return $b }
        }
        Start-Sleep -Milliseconds 100
    } while ($sw.ElapsedMilliseconds -lt $TimeoutMs)
    throw "Button not found: $Pattern"
}

# The panel's final outcome as text, or null while the task is running.
function Get-HudOutcome([IntPtr]$Hwnd) {
    $m = [regex]::Match((Get-HudText $Hwnd), '(?m)^RESULT[^\n]*\n(COMPLETED|UNVERIFIED|PARTIAL|FAILED|REFUSED|CANCELLED)', 'IgnoreCase')
    if ($m.Success) { return $m.Groups[1].Value.ToUpper() }
    return $null
}

function Wait-HudOutcome([IntPtr]$Hwnd, [int]$TimeoutMs = 120000) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    do {
        $o = Get-HudOutcome $Hwnd
        if ($o) { return [pscustomobject]@{ Outcome = $o; Ms = $sw.ElapsedMilliseconds } }
        Start-Sleep -Milliseconds 50
    } while ($sw.ElapsedMilliseconds -lt $TimeoutMs)
    return [pscustomobject]@{ Outcome = $null; Ms = $sw.ElapsedMilliseconds }
}

# ── Overlay modes (Phase 6 full-screen HUD) ──────────────────────────────────
# The HUD starts in ambient mode: click-through, never focused, with the command input folded away. A person
# switches it with Ctrl+Alt+Space; these helpers press the same keys.
$script:WS_EX_TRANSPARENT = 0x20
$script:WS_EX_NOACTIVATE = 0x08000000

function Get-HudExStyle([IntPtr]$Hwnd) { [int64][HudExStyle]::Get($Hwnd) }

if (-not ('HudExStyle' -as [type])) {
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class HudExStyle {
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public static long Get(IntPtr h) { return GetWindowLongPtr(h, -20).ToInt64(); }
}
'@
}

function Get-HudMode([IntPtr]$Hwnd) {
    if (-not [HudExStyle]::IsWindowVisible($Hwnd)) { return 'hidden' }
    if ((Get-HudExStyle $Hwnd) -band $script:WS_EX_NOACTIVATE) { return 'ambient' }
    return 'interactive'
}

function Send-HudToggleHotkey { [HudInput]::Chord([uint16[]]@(0x11, 0x12), 0x20) }   # Ctrl+Alt+Space
function Send-HudHideHotkey { [HudInput]::Chord([uint16[]]@(0x11, 0x12), 0x48) }     # Ctrl+Alt+H

function Wait-HudMode([IntPtr]$Hwnd, [string]$Mode, [int]$TimeoutMs = 5000) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    do { if ((Get-HudMode $Hwnd) -eq $Mode) { return $sw.ElapsedMilliseconds }; Start-Sleep -Milliseconds 20 } while ($sw.ElapsedMilliseconds -lt $TimeoutMs)
    throw "The HUD did not reach $Mode mode (it is $(Get-HudMode $Hwnd))"
}

# Interactive, with the command input on screen. Waits for the host to register its hotkeys first.
function Enter-HudInteractive([IntPtr]$Hwnd, [int]$TimeoutMs = 20000) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ((Get-HudMode $Hwnd) -ne 'interactive' -and $sw.ElapsedMilliseconds -lt $TimeoutMs) {
        Send-HudToggleHotkey
        try { [void](Wait-HudMode $Hwnd 'interactive' 1500) } catch { }
    }
    [void](Wait-HudMode $Hwnd 'interactive' 100)
    [void](Find-HudElement $Hwnd -AutomationId 'ultron-command' -TimeoutMs $TimeoutMs)
}
