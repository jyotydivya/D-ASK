# Phase 7B.2 live run: approval-connected window-operation requests through the REAL stack.
#   natural language typed into the real HUD -> real daemon -> real agent host + local model -> protocol v2 -> daemon
#   resolves the target from the OS -> policy -> approval delivered to the real HUD -> the HUD's Approve/Deny/STOP buttons
#   -> daemon validates the decision -> reply -> the HUD shows the outcome.
#
# Safety:
#   * Desktop observation is restricted (AgentHost:DesktopReadAllowedProcessIds) to one disposable fixture window this
#     script creates. No personal window can be listed, inspected or named in an approval.
#   * Phase 7B.2 has no executor: an approved request is validated and consumed, never performed. The script checks that
#     the fixture window was not minimized, maximized, focused or moved.
#   * Clicks and keys go only to the D-ASK HUD (hud-driver.ps1 refuses input unless the HUD is in front). Every click is
#     guarded here as well: the control's name and rectangle are read, the cursor is moved to its centre, and the click
#     is sent only if the cursor is still exactly there, the control is unchanged, it is enabled, the window under the
#     cursor is the HUD and the HUD is the foreground window. Otherwise nothing is clicked.
#   * Every decision is confirmed from the HUD log AND the daemon log. A click whose effect is missing, duplicated or
#     different from the intent is "uncertain": it is never retried, every later stateful interaction is skipped (and
#     recorded as not run), and only independent, non-interactive diagnostics continue.
#   * Starts and stops only its own processes. Writes results to -OutDir, which must be new or empty (no evidence is
#     ever overwritten).
#
#   powershell -ExecutionPolicy Bypass -File scripts\hud\approval-live-7b2.ps1 -OutDir results\phase7b2\live-<stamp>
#
# Exit code 0 only if every check passed and nothing was aborted.
param([Parameter(Mandatory = $true)][string]$OutDir, [string]$Root, [string]$Config = 'Debug', [switch]$LoadFunctionsOnly)
$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = (Resolve-Path "$PSScriptRoot\..\..").Path }
. "$PSScriptRoot\hud-driver.ps1"

if (-not ('Fx7B2' -as [type])) {
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class Fx7B2 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct PT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out PT p);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(PT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
'@
}

# ---------------------------------------------------------------------------------------------------------------
# State and records
# ---------------------------------------------------------------------------------------------------------------
$script:results = New-Object System.Collections.ArrayList
$script:clicks = New-Object System.Collections.ArrayList
$script:submits = New-Object System.Collections.ArrayList
$script:decisions = New-Object System.Collections.ArrayList
$script:Aborted = $false
$script:AbortReason = $null
$script:hwnd = [IntPtr]::Zero
$script:hudLog = $null
$script:daemonLog = $null
# Every check this script reports. A check that cannot run is recorded as failed ("not run"), never omitted.
$script:ExpectedChecks = 13

function Get-Utc { (Get-Date).ToUniversalTime().ToString('o') }
function Normalize([string]$s) { if ($null -eq $s) { return '' }; return ([regex]::Replace($s, '\s+', ' ')).Trim() }
function Strip-Ansi([string]$s) { if ($null -eq $s) { return '' }; return [regex]::Replace($s, ([string][char]27) + '\[[0-9;]*m', '') }
function Contains-Text([string]$Haystack, [string]$Needle) { return (Normalize $Haystack).IndexOf((Normalize $Needle), [StringComparison]::OrdinalIgnoreCase) -ge 0 }

function Record([string]$Name, [bool]$Pass, $Detail) {
    [void]$script:results.Add([pscustomobject]@{ name = $Name; pass = $Pass; utc = (Get-Utc); detail = $Detail })
    Write-Host ("{0}  {1}  {2}" -f $(if ($Pass) { ' ok ' } else { 'FAIL' }), $Name, ($Detail | ConvertTo-Json -Compress -Depth 5))
}
function Abort([string]$Why) {
    if (-not $script:Aborted) {
        $script:Aborted = $true
        $script:AbortReason = $Why
        Write-Host "ABORT: no further stateful interaction ($Why)"
    }
}
function Skipped([string]$Name) { Record $Name $false @{ notRun = "skipped after abort: $($script:AbortReason)" } }

# ---------------------------------------------------------------------------------------------------------------
# Logs (authoritative evidence that something new happened, independent of what the UI still shows)
# ---------------------------------------------------------------------------------------------------------------
function Get-LogLength([string]$Path) { if ($Path -and (Test-Path $Path)) { return (Get-Item $Path).Length } else { return 0 } }
function Read-LogSince([string]$Path, [long]$Offset) {
    if (-not $Path -or -not (Test-Path $Path)) { return '' }
    $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
        if ($fs.Length -le $Offset) { return '' }
        [void]$fs.Seek($Offset, [System.IO.SeekOrigin]::Begin)
        $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
        return (Strip-Ansi $sr.ReadToEnd())
    } finally { $fs.Dispose() }
}
function Mark-Logs { return [pscustomobject]@{ hud = (Get-LogLength $script:hudLog); daemon = (Get-LogLength $script:daemonLog); utc = (Get-Utc) } }
function Parse-Utc([string]$s) {
    try { return [datetime]::Parse($s, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime() } catch { return $null }
}

# Pure: what the logs since a mark say about one approval's decision. No waiting, no UI.
function Get-DecisionEvidence([string]$HudText, [string]$DaemonText, [string]$ApprovalId, [bool]$IntendedApproved) {
    $id = [regex]::Escape($ApprovalId)
    $hm = [regex]::Matches($HudText, '(\d{4}-\d\d-\d\dT[0-9:.]+Z)\s+INFO\s+hud_native:\s+\[IPC BRIDGE\] Action approval decision: approval_id=' + $id + ', approved=(true|false)')
    $dm = [regex]::Matches($DaemonText, 'Received user approval decision for ' + $id + ': Approved=(True|False)')
    $e = [ordered]@{ approvalId = $ApprovalId; intendedApproved = $IntendedApproved; hudDecisions = $hm.Count; daemonDecisions = $dm.Count
        hudApproved = $null; daemonApproved = $null; hudDecisionUtc = $null; state = 'pending' }
    if ($hm.Count -ge 1) { $e.hudApproved = ($hm[0].Groups[2].Value -eq 'true'); $e.hudDecisionUtc = $hm[0].Groups[1].Value }
    if ($dm.Count -ge 1) { $e.daemonApproved = ($dm[0].Groups[1].Value -eq 'True') }
    if ($hm.Count -gt 1 -or $dm.Count -gt 1) { $e.state = 'duplicate' }
    elseif (($null -ne $e.hudApproved -and $e.hudApproved -ne $IntendedApproved) -or ($null -ne $e.daemonApproved -and $e.daemonApproved -ne $IntendedApproved)) { $e.state = 'mismatch' }
    elseif ($hm.Count -eq 1 -and $dm.Count -eq 1) { $e.state = 'confirmed' }
    return [pscustomobject]$e
}

# Pure: whether a click may be sent. Returns $null when every guard holds, otherwise why not.
function Get-ClickGuardViolation {
    param([string]$ExpectedName, [string]$ExpectedAutomationId, [string]$Name1, [string]$AutomationId1, $Rect1,
          [string]$Name2, [string]$AutomationId2, $Rect2, [bool]$Enabled2, [int]$TargetX, [int]$TargetY, $Cursor,
          [bool]$UnderCursorIsHud, [bool]$HudIsForeground, $HudRect)
    if ($ExpectedName) {
        if ($Name1 -notmatch $ExpectedName) { return "the control's name '$Name1' is not '$ExpectedName'" }
        if ($Name2 -ne $Name1) { return "the control's name changed from '$Name1' to '$Name2'" }
    }
    if ($ExpectedAutomationId) {
        if ($AutomationId1 -ne $ExpectedAutomationId) { return "the control's AutomationId '$AutomationId1' is not '$ExpectedAutomationId'" }
        if ($AutomationId2 -ne $AutomationId1) { return "the control's AutomationId changed to '$AutomationId2'" }
    }
    if ($null -eq $Rect1 -or $Rect1.Width -lt 4 -or $Rect1.Height -lt 4) { return 'the control has no usable rectangle' }
    if ($null -eq $Rect2 -or [math]::Abs($Rect2.X - $Rect1.X) -gt 1 -or [math]::Abs($Rect2.Y - $Rect1.Y) -gt 1 -or
        [math]::Abs($Rect2.Width - $Rect1.Width) -gt 1 -or [math]::Abs($Rect2.Height - $Rect1.Height) -gt 1) {
        return "the control moved or resized ($($Rect1.X),$($Rect1.Y),$($Rect1.Width),$($Rect1.Height) -> $($Rect2.X),$($Rect2.Y),$($Rect2.Width),$($Rect2.Height))"
    }
    if (-not $Enabled2) { return 'the control is disabled (not armed)' }
    if ($null -ne $HudRect -and ($TargetX -lt $HudRect.L -or $TargetX -ge $HudRect.R -or $TargetY -lt $HudRect.T -or $TargetY -ge $HudRect.B)) { return 'the target point is outside the HUD window' }
    if ($null -eq $Cursor -or [math]::Abs($Cursor.X - $TargetX) -gt 1 -or [math]::Abs($Cursor.Y - $TargetY) -gt 1) {
        return "the cursor is at $($Cursor.X),$($Cursor.Y), not at the control's centre $TargetX,$TargetY"
    }
    if (-not $UnderCursorIsHud) { return 'the window under the cursor is not the HUD' }
    if (-not $HudIsForeground) { return 'the HUD is not the foreground window' }
    return $null
}

# Pure: the task outcome the HUD panel shows in this text (same rule as hud-driver's Get-HudOutcome).
function Get-OutcomeFromText([string]$Text) {
    $m = [regex]::Match($Text, '(?m)^RESULT[^\n]*\n(COMPLETED|UNVERIFIED|PARTIAL|FAILED|REFUSED|CANCELLED)', 'IgnoreCase')
    if ($m.Success) { return $m.Groups[1].Value.ToUpper() }
    return $null
}

# Pure: whether the HUD still shows an approval panel (its header), whatever its state.
function Test-ApprovalPanelShown([string]$Text) {
    return ($Text -cmatch '\bAPPROVAL (REQUIRED|APPROVED|DENIED|EXPIRED|CANCELLED|INVALIDATEDBYEMERGENCYSTOP|DISCONNECTED|REJECTED)\b')
}

# Pure: whether the next keystroke may be sent. $null when both guards hold.
function Get-TypingGuardViolation([bool]$HudIsForeground, [string]$FocusedAutomationId) {
    if (-not $HudIsForeground) { return 'the HUD is not the foreground window' }
    # -cne: exact, case-sensitive identity (PowerShell's -ne ignores case).
    if ($FocusedAutomationId -cne 'ultron-command') { return "the focused element is '$FocusedAutomationId', not the command input" }
    return $null
}

# Types $Text one character at a time. $Probe returns the current state (hudIsForeground, focusedAutomationId, ...);
# $SendChar sends one character. The guard is checked before the first character and after every character, and
# typing stops at the first failure: no further key is ever sent. Never re-activates the HUD (that would hide a change).
function Invoke-GuardedTyping([string]$Text, [scriptblock]$Probe, [scriptblock]$SendChar) {
    $steps = New-Object System.Collections.ArrayList
    $res = [ordered]@{ ok = $false; typedCount = 0; stoppedAfterIndex = $null; reason = $null; steps = $null }
    $check = {
        param([int]$AfterIndex)
        $p = $null
        try { $p = & $Probe } catch { $p = $null; $err = "$($_.Exception.Message)" }
        $v = if ($null -eq $p) { "the state could not be read ($err)" } else { Get-TypingGuardViolation ([bool]$p.hudIsForeground) ([string]$p.focusedAutomationId) }
        [void]$steps.Add([pscustomobject]@{ afterIndex = $AfterIndex; utc = (Get-Utc); ok = ($null -eq $v)
            focusedAutomationId = $(if ($p) { $p.focusedAutomationId }); focusedName = $(if ($p) { $p.focusedName }); focusedControlType = $(if ($p) { $p.focusedControlType })
            foregroundProcess = $(if ($p) { $p.foregroundProcess }); hudIsForeground = $(if ($p) { $p.hudIsForeground }); violation = $v })
        return $v
    }
    $v = & $check -1
    if ($v) { $res.reason = "before typing: $v"; $res.steps = @($steps.ToArray()); return [pscustomobject]$res }
    for ($i = 0; $i -lt $Text.Length; $i++) {
        & $SendChar ([string]$Text[$i])
        $res.typedCount = $i + 1
        $v = & $check $i
        if ($v) { $res.stoppedAfterIndex = $i; $res.reason = "after character $($i + 1) of $($Text.Length): $v"; $res.steps = @($steps.ToArray()); return [pscustomobject]$res }
    }
    $res.ok = $true
    $res.steps = @($steps.ToArray())
    return [pscustomobject]$res
}

# Pure: an observed input value against the request. 'match' only for exact (ordinal) equality.
function Get-ValueVerdict($Value, [string]$Expected) {
    # $Value is deliberately untyped: a [string] parameter would turn $null (unreadable) into "" (a harmless prefix).
    if ($null -eq $Value) { return 'unreadable' }
    $Value = [string]$Value
    if ([string]::Equals($Value, $Expected, [StringComparison]::Ordinal)) { return 'match' }
    if ($Expected.StartsWith($Value, [StringComparison]::Ordinal)) { return 'prefix' }
    return 'mismatch'
}

# Polls the input's value until it equals $Expected exactly, for at most $TimeoutMs. A value that is a strict prefix may
# still be catching up (the accessibility value updates asynchronously) and is waited for; anything else is a mismatch
# and ends the wait at once. Every distinct value is recorded with its time. Never types, never presses a key.
function Wait-SettledValue([string]$Expected, [scriptblock]$ReadValue, [int]$TimeoutMs = 2000, [int]$PollMs = 50) {
    $values = New-Object System.Collections.ArrayList
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $last = $null
    $haveLast = $false
    $verdict = 'unreadable'
    $value = $null
    while ($true) {
        $value = $null; $err = $null
        try { $value = & $ReadValue } catch { $err = "$($_.Exception.Message)" }
        $verdict = Get-ValueVerdict $value $Expected
        $key = if ($null -eq $value) { "<unreadable: $err>" } else { $value }
        # -cne: values differing only in letter case are different values.
        if (-not $haveLast -or $key -cne $last) { [void]$values.Add([pscustomobject]@{ utc = (Get-Utc); ms = $sw.ElapsedMilliseconds; value = $key; verdict = $verdict }); $last = $key; $haveLast = $true }
        if ($verdict -eq 'match' -or $verdict -eq 'mismatch') { break }
        if ($sw.ElapsedMilliseconds -ge $TimeoutMs) { break }
        Start-Sleep -Milliseconds $PollMs
    }
    $reason = switch ($verdict) {
        'match' { $null }
        'mismatch' { "the input holds '$value', which is not the request" }
        'prefix' { "after $TimeoutMs ms the input still holds only '$value'" }
        default { "the input value could not be read within $TimeoutMs ms" }
    }
    return [pscustomobject]@{ matched = ($verdict -eq 'match'); verdict = $verdict; reason = $reason; finalValue = $value; ms = $sw.ElapsedMilliseconds; values = @($values.ToArray()) }
}

if ($LoadFunctionsOnly) { return }

# ---------------------------------------------------------------------------------------------------------------
# Desktop helpers (read-only except Invoke-GuardedClick / Invoke-Request, which are the only input paths)
# ---------------------------------------------------------------------------------------------------------------
function Get-Cursor { $p = New-Object Fx7B2+PT; [void][Fx7B2]::GetCursorPos([ref]$p); return [pscustomobject]@{ X = $p.X; Y = $p.Y } }
function Test-HudUnderCursor([int]$X, [int]$Y) {
    $pt = New-Object Fx7B2+PT; $pt.X = $X; $pt.Y = $Y
    $h = [Fx7B2]::WindowFromPoint($pt)
    if ($h -eq [IntPtr]::Zero) { return $false }
    return ($h -eq $script:hwnd -or [Fx7B2]::GetAncestor($h, 2) -eq $script:hwnd)
}
function Get-ForegroundInfo {
    $h = [Fx7B2]::GetForegroundWindow()
    if ($h -eq [IntPtr]::Zero) { return [pscustomobject]@{ hwnd = 0; title = ''; pid = 0; process = 'none' } }
    $sb = New-Object System.Text.StringBuilder 256
    [void][Fx7B2]::GetWindowText($h, $sb, 256)
    $p = [uint32]0; [void][Fx7B2]::GetWindowThreadProcessId($h, [ref]$p)
    $name = '(exited)'
    try { $name = (Get-Process -Id ([int]$p) -ErrorAction Stop).ProcessName } catch { }
    $t = $sb.ToString(); if ($t.Length -gt 100) { $t = $t.Substring(0, 100) + '...' }
    return [pscustomobject]@{ hwnd = [int64]$h; title = $t; pid = [int]$p; process = $name }
}
function FixtureState {
    $r = New-Object Fx7B2+RECT; [void][Fx7B2]::GetWindowRect($script:fxHwnd, [ref]$r)
    [pscustomobject]@{ exists = [Fx7B2]::IsWindow($script:fxHwnd); minimized = [Fx7B2]::IsIconic($script:fxHwnd); maximized = [Fx7B2]::IsZoomed($script:fxHwnd)
        foreground = ([Fx7B2]::GetForegroundWindow() -eq $script:fxHwnd); rect = "$($r.L),$($r.T),$($r.R),$($r.B)" }
}
function Safe-HudText { try { return (Get-HudText $script:hwnd) } catch { return '' } }

# The only mouse path. Never retries: one attempt, sent only if every guard holds; the record says exactly what happened.
function Invoke-GuardedClick {
    param([string]$Label, [string]$ButtonPattern, [string]$AutomationId, [switch]$WaitEnabled)
    $rec = [ordered]@{ label = $Label; startedUtc = (Get-Utc); sent = $false; sentUtc = $null; abortReason = $null
        name = $null; automationId = $null; rect = $null; target = $null; cursorBeforeClick = $null; cursorAfterClick = $null; enabledAfterMs = $null }
    try {
        Assert-HudForeground $script:hwnd
        $el = if ($ButtonPattern) { Find-HudButton $script:hwnd $ButtonPattern 8000 } else { Find-HudElement $script:hwnd -AutomationId $AutomationId -TimeoutMs 8000 }
        if ($WaitEnabled) {
            # State-aware arming: the page enables Approve/Deny only once the approval is armed.
            $sw = [Diagnostics.Stopwatch]::StartNew()
            while (-not $el.Current.IsEnabled -and $sw.ElapsedMilliseconds -lt 8000) { Start-Sleep -Milliseconds 50 }
            $rec.enabledAfterMs = $sw.ElapsedMilliseconds
        }
        $name1 = $el.Current.Name; $aid1 = $el.Current.AutomationId; $r1 = $el.Current.BoundingRectangle
        $rec.name = $name1; $rec.automationId = $aid1
        $rec.rect = "$([int]$r1.X),$([int]$r1.Y),$([int]$r1.Width),$([int]$r1.Height)"
        $cx = [int]($r1.X + $r1.Width / 2); $cy = [int]($r1.Y + $r1.Height / 2)
        $rec.target = "$cx,$cy"
        $hr = New-Object Fx7B2+RECT; [void][Fx7B2]::GetWindowRect($script:hwnd, [ref]$hr)
        [void][HudInput]::SetCursorPos($cx, $cy)
        Start-Sleep -Milliseconds 120
        # Re-read everything right before the click.
        $name2 = $el.Current.Name; $aid2 = $el.Current.AutomationId; $r2 = $el.Current.BoundingRectangle; $en2 = $el.Current.IsEnabled
        $cur = Get-Cursor
        $v = Get-ClickGuardViolation -ExpectedName $ButtonPattern -ExpectedAutomationId $AutomationId -Name1 $name1 -AutomationId1 $aid1 -Rect1 $r1 `
            -Name2 $name2 -AutomationId2 $aid2 -Rect2 $r2 -Enabled2 $en2 -TargetX $cx -TargetY $cy -Cursor $cur `
            -UnderCursorIsHud (Test-HudUnderCursor $cx $cy) -HudIsForeground ([Fx7B2]::GetForegroundWindow() -eq $script:hwnd) -HudRect $hr
        if ($v) { throw $v }
        # Last-instant cursor check: a person moving the mouse now would redirect the click.
        $cur2 = Get-Cursor
        if ([math]::Abs($cur2.X - $cx) -gt 1 -or [math]::Abs($cur2.Y - $cy) -gt 1) { throw "the cursor moved to $($cur2.X),$($cur2.Y) just before the click" }
        $rec.cursorBeforeClick = "$($cur2.X),$($cur2.Y)"
        $rec.sentUtc = Get-Utc
        [HudInput]::Click()
        $rec.sent = $true
        $c3 = Get-Cursor; $rec.cursorAfterClick = "$($c3.X),$($c3.Y)"
    } catch {
        $rec.abortReason = "$($_.Exception.Message)"
    }
    $o = [pscustomobject]$rec
    [void]$script:clicks.Add($o)
    return $o
}

# Read-only: what has the keyboard right now (foreground window and its process, the focused UI Automation element).
$script:procNames = @{}
function Get-InputProbe {
    $fg = [Fx7B2]::GetForegroundWindow()
    $p = [uint32]0; [void][Fx7B2]::GetWindowThreadProcessId($fg, [ref]$p)
    $pidKey = [int]$p
    if (-not $script:procNames.ContainsKey($pidKey)) {
        $n = '(exited)'
        try { $n = (Get-Process -Id $pidKey -ErrorAction Stop).ProcessName } catch { }
        $script:procNames[$pidKey] = $n
    }
    $aid = $null; $name = $null; $type = $null
    try {
        $f = [System.Windows.Automation.AutomationElement]::FocusedElement
        if ($f) {
            $aid = $f.Current.AutomationId
            $name = $f.Current.Name; if ($name -and $name.Length -gt 60) { $name = $name.Substring(0, 60) + '...' }
            $type = $f.Current.ControlType.ProgrammaticName
        }
    } catch { $aid = $null }
    return [pscustomobject]@{ hudIsForeground = ($fg -eq $script:hwnd); foregroundProcess = $script:procNames[$pidKey]; foregroundPid = $pidKey
        focusedAutomationId = $aid; focusedName = $name; focusedControlType = $type }
}

# Read-only: the command input's current value (throws if it cannot be read; the caller treats that as unreadable).
function Read-CommandValue {
    $el = Find-HudElement $script:hwnd -AutomationId 'ultron-command' -TimeoutMs 1000
    $vp = $null
    if (-not $el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { throw 'the command input exposes no value' }
    return $vp.Current.Value
}

# Types one request into the HUD the way a person would and confirms the daemon accepted exactly one new task.
function Invoke-Request([string]$Text) {
    $marks = Mark-Logs
    $rec = [ordered]@{ text = $Text; marks = $marks; ok = $false; reason = $null; typedVerified = $null; typing = $null; readBack = $null; beforeEnter = $null; submitUtc = $null; acceptedMs = $null }
    $sw = $null
    try {
        $c = Invoke-GuardedClick -Label 'command input' -AutomationId 'ultron-command'
        if (-not $c.sent) { throw "the command input was not clicked: $($c.abortReason)" }
        Start-Sleep -Milliseconds 150
        # Guarded typing: HUD in front and the command input focused, before the first and after every character.
        $t = Invoke-GuardedTyping $Text { Get-InputProbe } { param($ch) [HudInput]::Text($ch) }
        $rec.typing = [pscustomobject]@{ ok = $t.ok; typedCount = $t.typedCount; length = $Text.Length; stoppedAfterIndex = $t.stoppedAfterIndex; reason = $t.reason; steps = $t.steps }
        if (-not $t.ok) { throw "typing stopped, Enter was not pressed: $($t.reason)" }
        # Settling read-back: Enter only once the input holds exactly the request.
        $rb = Wait-SettledValue $Text { Read-CommandValue } 2000 50
        $rec.readBack = $rb
        $rec.typedVerified = $rb.matched
        if (-not $rb.matched) { throw "$($rb.reason); Enter was not pressed" }
        # One snapshot for both conditions, recorded with the request.
        $pre = Get-InputProbe
        $rec.beforeEnter = $pre
        $g = Get-TypingGuardViolation ([bool]$pre.hudIsForeground) ([string]$pre.focusedAutomationId)
        if ($g) { throw "before Enter: $g; Enter was not pressed" }
        Press-HudEnter $script:hwnd
        $rec.submitUtc = Get-Utc
        $sw = [Diagnostics.Stopwatch]::StartNew()
        while ($sw.ElapsedMilliseconds -lt 20000) {
            $n = [regex]::Matches((Read-LogSince $script:hudLog $marks.hud), 'HUD received IPC message: AgentTaskSubmitResponse').Count
            if ($n -ge 1) { break }
            Start-Sleep -Milliseconds 50
        }
        Start-Sleep -Milliseconds 300
        $n = [regex]::Matches((Read-LogSince $script:hudLog $marks.hud), 'HUD received IPC message: AgentTaskSubmitResponse').Count
        if ($n -eq 0) { throw 'the daemon never answered a submission (no new AgentTaskSubmitResponse)' }
        if ($n -gt 1) { throw "more than one task was submitted ($n responses)" }
        $rec.acceptedMs = $sw.ElapsedMilliseconds
        $rec.ok = $true
    } catch { $rec.reason = "$($_.Exception.Message)" }
    $o = [pscustomobject]$rec
    [void]$script:submits.Add($o)
    return [pscustomobject]@{ Ok = $o.ok; Reason = $o.reason; Marks = $marks; Clock = $sw; Record = $o }
}

# A NEW approval: opened after the mark (log), and shown by the HUD now (UI).
function Wait-NewApproval($Marks, [int]$TimeoutMs = 180000) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt $TimeoutMs) {
        $hud = Read-LogSince $script:hudLog $Marks.hud
        $m = [regex]::Match($hud, 'Approval surface opened for ([0-9a-f]{32})')
        if ($m.Success) {
            $t = Safe-HudText
            if ($t -cmatch 'APPROVAL REQUIRED') { return [pscustomobject]@{ Found = $true; Id = $m.Groups[1].Value; Ms = $sw.ElapsedMilliseconds; Text = $t; Reason = $null } }
        } elseif ($hud -match 'HUD received IPC message: AgentTaskResultNotification') {
            return [pscustomobject]@{ Found = $false; Id = $null; Ms = $sw.ElapsedMilliseconds; Text = (Safe-HudText); Reason = 'the task ended without an approval' }
        }
        Start-Sleep -Milliseconds 100
    }
    return [pscustomobject]@{ Found = $false; Id = $null; Ms = $sw.ElapsedMilliseconds; Text = (Safe-HudText); Reason = "no new approval within $TimeoutMs ms" }
}

# Confirms one decision from both logs. Never clicks.
function Confirm-Decision($Marks, [string]$ApprovalId, [bool]$Approve, $Click, [int]$TimeoutMs = 15000) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    do {
        $e = Get-DecisionEvidence (Read-LogSince $script:hudLog $Marks.hud) (Read-LogSince $script:daemonLog $Marks.daemon) $ApprovalId $Approve
        if ($e.state -ne 'pending') { break }
        Start-Sleep -Milliseconds 50
    } while ($sw.ElapsedMilliseconds -lt $TimeoutMs)
    Start-Sleep -Milliseconds 300 # a second, duplicate decision would show up now
    $e = Get-DecisionEvidence (Read-LogSince $script:hudLog $Marks.hud) (Read-LogSince $script:daemonLog $Marks.daemon) $ApprovalId $Approve
    $latency = $null
    if ($e.hudDecisionUtc -and $Click.sentUtc) { $a = Parse-Utc $e.hudDecisionUtc; $b = Parse-Utc $Click.sentUtc; if ($a -and $b) { $latency = [int]($a - $b).TotalMilliseconds } }
    $d = [pscustomobject]@{ evidence = $e; clickToHudDecisionMs = $latency; utc = (Get-Utc) }
    [void]$script:decisions.Add($d)
    return $d
}

# A NEW task result: delivered after the mark (log), and the HUD shows an outcome whose text is specific to this request.
function Wait-NewResult($Marks, [string]$ExpectPattern, [int]$TimeoutMs = 120000, [int]$DisplayMs = 15000) {
    $res = [ordered]@{ arrived = $false; displayed = $false; matched = $false; outcome = $null; msToArrive = $null; text = '' }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt $TimeoutMs) {
        if ((Read-LogSince $script:hudLog $Marks.hud) -match 'HUD received IPC message: AgentTaskResultNotification') { $res.arrived = $true; $res.msToArrive = $sw.ElapsedMilliseconds; break }
        Start-Sleep -Milliseconds 50
    }
    if (-not $res.arrived) { return [pscustomobject]$res }
    $d = [Diagnostics.Stopwatch]::StartNew()
    while ($d.ElapsedMilliseconds -lt $DisplayMs) {
        $t = Safe-HudText
        $o = Get-OutcomeFromText $t
        if ($o) {
            $res.displayed = $true; $res.outcome = $o; $res.text = $t
            if (-not $ExpectPattern -or (Normalize $t) -match $ExpectPattern) { $res.matched = $true; break }
        }
        Start-Sleep -Milliseconds 100
    }
    return [pscustomobject]$res
}

# State-aware: the previous approval panel is gone before the next request.
function Wait-PanelClosed([int]$TimeoutMs = 20000) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    do { if (-not (Test-ApprovalPanelShown (Safe-HudText))) { return $sw.ElapsedMilliseconds }; Start-Sleep -Milliseconds 100 } while ($sw.ElapsedMilliseconds -lt $TimeoutMs)
    return -1
}

# Waits for a log line after a mark (no UI, no input).
function Wait-Log([string]$Which, $Marks, [string]$Pattern, [int]$TimeoutMs = 15000) {
    $path = if ($Which -eq 'hud') { $script:hudLog } else { $script:daemonLog }
    $off = if ($Which -eq 'hud') { $Marks.hud } else { $Marks.daemon }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    do {
        $m = [regex]::Match((Read-LogSince $path $off), $Pattern)
        if ($m.Success) { return [pscustomobject]@{ Found = $true; Ms = $sw.ElapsedMilliseconds; Match = $m } }
        Start-Sleep -Milliseconds 50
    } while ($sw.ElapsedMilliseconds -lt $TimeoutMs)
    return [pscustomobject]@{ Found = $false; Ms = $sw.ElapsedMilliseconds; Match = $null }
}

# ---------------------------------------------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------------------------------------------
if ((Test-Path $OutDir) -and @(Get-ChildItem $OutDir -Force -ErrorAction SilentlyContinue).Count -gt 0) {
    throw "OutDir '$OutDir' is not empty; refusing to overwrite earlier evidence. Use a new folder."
}
New-Item -ItemType Directory -Force $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path
$script:hudLog = Join-Path $OutDir 'hud.log'
$script:daemonLog = Join-Path $OutDir 'daemon.log'

foreach ($n in 'hud-native', 'DAsk.Daemon', 'llama-server') {
    $p = @(Get-Process $n -ErrorAction SilentlyContinue)
    if ($p.Count) { throw "$n is already running (pid $($p.Id -join ', ')); this test needs a clean start." }
}

$N = @{
    setup = 'setup: real HUD handshook with the real daemon; HUD interactive; fixture window ready'
    pre   = '0 precondition: the fixture window was not the foreground window before D-ASK started'
    a1    = '1a request typed in the HUD reached the daemon and came back as a NEW approval in the HUD'
    b1    = '1b the approval shows the operation, target, process identity, every parameter, risk, expiry, reversibility'
    c1    = '1c Deny: the click was guarded; HUD and daemon both logged approved=false; a NEW result says declined'
    a2    = '2a focus request reached the HUD as a NEW approval'
    b2    = '2b Approve: HUD and daemon both logged approved=true; a NEW result says NOT performed'
    c2    = '2c the fixture window was not changed (not focused, minimized, maximized or moved)'
    a3    = '3a maximize request reached the HUD as a NEW approval'
    b3    = '3b Emergency Stop (guarded click) reached the daemon and invalidated the pending approval; task not completed'
    c3    = '3c Resume (guarded click) reached the daemon'
    d4    = '4 "Minimize this window" -> a NEW refused result asking which window; no approval offered'
    e5    = '5 fixture unchanged at the end (independent check)'
}

$tag = [Guid]::NewGuid().ToString('N').Substring(0, 6)
$title = "DASK Approval Fixture $tag"
$fxOut = Join-Path $OutDir 'fixture.out'
$fx = Start-Process powershell -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    "`"$Root\tests\DAsk.Daemon.Tests\Fixtures\desktop-fixture.ps1`"", '-Title', "`"$title`"", '-Secret', 'dask-7b2-synthetic', '-X', '60', '-Y', '60') `
    -RedirectStandardOutput $fxOut -WindowStyle Hidden -PassThru
$sw0 = [Diagnostics.Stopwatch]::StartNew()
while ($sw0.ElapsedMilliseconds -lt 30000 -and -not ((Test-Path $fxOut) -and ((Get-Content $fxOut -Raw) -match 'READY (\d+)'))) { Start-Sleep -Milliseconds 200 }
if (-not ((Get-Content $fxOut -Raw) -match 'READY (\d+)')) { throw 'fixture window did not start' }
$script:fxHwnd = [IntPtr][int64]$Matches[1]
$fxBefore = FixtureState
$fgBefore = Get-ForegroundInfo

$env:DASK_AgentHost__DesktopReadAllowedProcessIds__0 = "$($fx.Id)"
# Phase 7B.2 verifies the approval-only mode: execution (Phase 7B.3, on in appsettings) is switched off explicitly.
$env:DASK_AgentHost__DesktopActionExecution = 'false'
try {
    & "$PSScriptRoot\start-stack.ps1" -OutDir $OutDir -Config $Config -Root $Root | Out-Null
    $pids = Get-Content "$OutDir\pids.json" -Raw | ConvertFrom-Json
    $script:hwnd = Get-HudHwnd $pids.hud
    Start-Sleep -Seconds 2
    if ((Get-Content $script:hudLog -Raw) -match 'Could not register Ctrl\+Alt\+Space') {
        Record $N.setup $false @{ blocked = 'another application owns Ctrl+Alt+Space; the HUD stays ambient and no request can be typed' }
        Abort 'Ctrl+Alt+Space is owned by another application'
    } else {
        Enter-HudInteractive $script:hwnd
        $hudText = Get-Content $script:hudLog -Raw
        $ok = ($hudText -match 'Handshake accepted') -and $fxBefore.exists
        Record $N.setup $ok @{ fixturePid = $fx.Id; fixtureHwnd = [int64]$script:fxHwnd; title = $title }
        if (-not $ok) { Abort 'setup failed' }
    }
    Record $N.pre (-not $fxBefore.foreground) @{ fixtureBefore = $fxBefore; foregroundBefore = $fgBefore }
    if ($fxBefore.foreground) { Abort 'precondition violated: the fixture was already foreground (focused by something outside D-ASK)' }

    # ---- 1. Deny ----
    if ($script:Aborted) { Skipped $N.a1; Skipped $N.b1; Skipped $N.c1 } else {
        $s = Invoke-Request "Minimize the window titled `"$title`""
        if (-not $s.Ok) { Record $N.a1 $false @{ submit = $s.Record }; Abort "request 1 not submitted: $($s.Reason)"; Skipped $N.b1; Skipped $N.c1 } else {
            $a = Wait-NewApproval $s.Marks
            Record $N.a1 $a.Found @{ approvalId = $a.Id; msSubmitToApproval = $(if ($s.Clock) { $s.Clock.ElapsedMilliseconds } else { $null }); reason = $a.Reason }
            if (-not $a.Found) { Abort "request 1: $($a.Reason)"; Skipped $N.b1; Skipped $N.c1 } else {
                Set-Content -Encoding utf8 (Join-Path $OutDir 'approval-panel-text-1.txt') $a.Text
                $need = @('APPROVAL REQUIRED', "Change a window's state", 'powershell.exe', $title, "PID $($fx.Id)", 'minimize', 'imagePath', 'windowClass', 'DAskDesktopFixture',
                    'processStarted', 'logonSession', 'reversible', 'Approval only', 'expires in', 'Elevated', 'Action digest')
                $missing = @($need | Where-Object { -not (Contains-Text $a.Text $_) })
                Record $N.b1 ($missing.Count -eq 0) @{ missing = $missing }

                $click = Invoke-GuardedClick -Label 'DENY' -ButtonPattern '^DENY$' -WaitEnabled
                if (-not $click.sent) { Record $N.c1 $false @{ click = $click }; Abort "DENY was not clicked: $($click.abortReason)" } else {
                    $d = Confirm-Decision $s.Marks $a.Id $false $click
                    if ($d.evidence.state -ne 'confirmed') {
                        Record $N.c1 $false @{ click = $click; decision = $d }
                        Abort "uncertain click: DENY was sent but the decision is '$($d.evidence.state)' (hud approved=$($d.evidence.hudApproved), daemon approved=$($d.evidence.daemonApproved))"
                    } else {
                        $r = Wait-NewResult $s.Marks 'You declined'
                        Record $N.c1 ($r.matched -and $r.outcome -ne 'COMPLETED') @{ click = $click; decision = $d; result = @{ arrived = $r.arrived; matched = $r.matched; outcome = $r.outcome; msToArrive = $r.msToArrive } }
                        if (-not $r.matched) { Abort 'request 1: no new result saying it was declined' }
                    }
                }
            }
        }
    }

    # ---- 2. Approve (approval only: nothing may change) ----
    if (-not $script:Aborted) { if ((Wait-PanelClosed) -lt 0) { Abort 'the previous approval panel did not close' } }
    if ($script:Aborted) { Skipped $N.a2; Skipped $N.b2; Skipped $N.c2 } else {
        $s = Invoke-Request "Bring the window titled `"$title`" to the front"
        if (-not $s.Ok) { Record $N.a2 $false @{ submit = $s.Record }; Abort "request 2 not submitted: $($s.Reason)"; Skipped $N.b2; Skipped $N.c2 } else {
            $a = Wait-NewApproval $s.Marks
            $ok = $a.Found -and (Contains-Text $a.Text 'Bring a window to the front')
            Record $N.a2 $ok @{ approvalId = $a.Id; msSubmitToApproval = $(if ($s.Clock) { $s.Clock.ElapsedMilliseconds } else { $null }); reason = $a.Reason }
            if (-not $ok) { Abort "request 2: $(if ($a.Reason) { $a.Reason } else { 'not the focus approval' })"; Skipped $N.b2; Skipped $N.c2 } else {
                Set-Content -Encoding utf8 (Join-Path $OutDir 'approval-panel-text-2.txt') $a.Text
                $click = Invoke-GuardedClick -Label 'APPROVE' -ButtonPattern '^APPROVE$' -WaitEnabled
                if (-not $click.sent) { Record $N.b2 $false @{ click = $click }; Abort "APPROVE was not clicked: $($click.abortReason)"; Skipped $N.c2 } else {
                    $d = Confirm-Decision $s.Marks $a.Id $true $click
                    if ($d.evidence.state -ne 'confirmed') {
                        Record $N.b2 $false @{ click = $click; decision = $d }
                        Abort "uncertain click: APPROVE was sent but the decision is '$($d.evidence.state)' (hud approved=$($d.evidence.hudApproved), daemon approved=$($d.evidence.daemonApproved))"
                        Skipped $N.c2
                    } else {
                        $r = Wait-NewResult $s.Marks 'did not perform it'
                        Record $N.b2 ($r.matched -and $r.outcome -ne 'COMPLETED') @{ click = $click; decision = $d; result = @{ arrived = $r.arrived; matched = $r.matched; outcome = $r.outcome; msToArrive = $r.msToArrive } }
                        $fxAfter = FixtureState
                        $c2ok = $fxAfter.exists -and -not $fxAfter.foreground -and -not $fxAfter.minimized -and -not $fxAfter.maximized -and $fxAfter.rect -eq $fxBefore.rect
                        Record $N.c2 $c2ok @{ before = $fxBefore; after = $fxAfter; foreground = $(if (-not $c2ok) { Get-ForegroundInfo } else { $null }) }
                        if (-not $r.matched) { Abort 'request 2: no new result saying it was not performed' }
                    }
                }
            }
        }
    }

    # ---- 3. Emergency Stop while the approval is pending, then Resume ----
    if (-not $script:Aborted) { if ((Wait-PanelClosed) -lt 0) { Abort 'the previous approval panel did not close' } }
    if ($script:Aborted) { Skipped $N.a3; Skipped $N.b3; Skipped $N.c3 } else {
        $s = Invoke-Request "Maximize the window titled `"$title`""
        if (-not $s.Ok) { Record $N.a3 $false @{ submit = $s.Record }; Abort "request 3 not submitted: $($s.Reason)"; Skipped $N.b3; Skipped $N.c3 } else {
            $a = Wait-NewApproval $s.Marks
            Record $N.a3 $a.Found @{ approvalId = $a.Id; reason = $a.Reason }
            if (-not $a.Found) { Abort "request 3: $($a.Reason)"; Skipped $N.b3; Skipped $N.c3 } else {
                $click = Invoke-GuardedClick -Label 'STOP' -ButtonPattern 'STOP \[Ctrl\+Shift\+F12\]$'
                if (-not $click.sent) { Record $N.b3 $false @{ click = $click }; Abort "STOP was not clicked: $($click.abortReason)"; Skipped $N.c3 } else {
                    $stopD = Wait-Log 'daemon' $s.Marks '\[EMERGENCY STOP\] Triggered'
                    $stopH = Wait-Log 'hud' $s.Marks 'Emergency Stop requested from HUD UI'
                    $inv = Wait-Log 'hud' $s.Marks ('(\d{4}-\d\d-\d\dT[0-9:.]+Z)\s+INFO\s+hud_native::ipc::client:\s+Approval ' + $a.Id + ' is now (InvalidatedByEmergencyStop|Cancelled)')
                    $invMs = $null
                    if ($inv.Found) { $x = Parse-Utc $inv.Match.Groups[1].Value; $y = Parse-Utc $click.sentUtc; if ($x -and $y) { $invMs = [int]($x - $y).TotalMilliseconds } }
                    $noDecision = (Get-DecisionEvidence (Read-LogSince $script:hudLog $s.Marks.hud) (Read-LogSince $script:daemonLog $s.Marks.daemon) $a.Id $false).hudDecisions -eq 0
                    if (-not ($stopD.Found -and $stopH.Found)) {
                        Record $N.b3 $false @{ click = $click; daemonStop = $stopD.Found; hudStop = $stopH.Found }
                        Abort 'uncertain click: STOP was sent but the Emergency Stop is not confirmed in both logs'
                        Skipped $N.c3
                    } else {
                        $r = Wait-NewResult $s.Marks 'Emergency Stop'
                        $fxNow = FixtureState
                        Record $N.b3 ($inv.Found -and $noDecision -and $r.arrived -and $r.outcome -ne 'COMPLETED' -and -not $fxNow.maximized) @{
                            click = $click; approvalState = $(if ($inv.Found) { $inv.Match.Groups[2].Value } else { $null }); clickToInvalidatedMs = $invMs
                            noApprovalDecisionSent = $noDecision; result = @{ arrived = $r.arrived; matched = $r.matched; outcome = $r.outcome } }
                        if (-not $inv.Found) { Abort 'the pending approval was not invalidated' }
                        if (-not $script:Aborted) { if ((Wait-PanelClosed) -lt 0) { Abort 'the invalidated approval panel did not close' } }
                        if ($script:Aborted) { Skipped $N.c3 } else {
                            $m3 = Mark-Logs
                            $rc = Invoke-GuardedClick -Label 'RESUME' -ButtonPattern '(^|\s)RESUME$'
                            if (-not $rc.sent) { Record $N.c3 $false @{ click = $rc }; Abort "RESUME was not clicked: $($rc.abortReason)" } else {
                                $res = Wait-Log 'daemon' $m3 '\[RESUME\] Execution resumed'
                                Record $N.c3 $res.Found @{ click = $rc; msToResumed = $res.Ms }
                                if (-not $res.Found) { Abort 'uncertain click: RESUME was sent but the daemon did not resume' }
                            }
                        }
                    }
                }
            }
        }
    }

    # ---- 4. Unnamed target: a question, no approval ----
    if ($script:Aborted) { Skipped $N.d4 } else {
        Start-Sleep -Seconds 1
        $s = Invoke-Request 'Minimize this window'
        if (-not $s.Ok) { Record $N.d4 $false @{ submit = $s.Record }; Abort "request 4 not submitted: $($s.Reason)" } else {
            $r = Wait-NewResult $s.Marks 'Which window' 30000
            $noApproval = -not ((Read-LogSince $script:hudLog $s.Marks.hud) -match 'Approval surface opened for')
            Record $N.d4 ($r.matched -and $r.outcome -eq 'REFUSED' -and $noApproval) @{ outcome = $r.outcome; matched = $r.matched; noApproval = $noApproval; msToArrive = $r.msToArrive }
        }
    }
}
catch {
    Record 'unexpected error' $false @{ error = "$($_.Exception.Message)"; at = "$($_.InvocationInfo.ScriptLineNumber)" }
    Abort "unexpected error: $($_.Exception.Message)"
}
finally {
    # ---- 5. Independent, non-interactive diagnostics (run whatever happened above) ----
    try {
        $fxEnd = FixtureState
        $ok5 = $fxEnd.exists -and -not $fxEnd.minimized -and -not $fxEnd.maximized -and $fxEnd.rect -eq $fxBefore.rect
        Record $N.e5 $ok5 @{ end = $fxEnd; foreground = (Get-ForegroundInfo) }
    } catch { Record $N.e5 $false @{ error = "$($_.Exception.Message)" } }
    try { & "$PSScriptRoot\stop-stack.ps1" -OutDir $OutDir | Out-Null } catch { }
    try { if (-not $fx.HasExited) { Stop-Process -Id $fx.Id -Force } } catch { }
    Remove-Item Env:\DASK_AgentHost__DesktopReadAllowedProcessIds__0 -ErrorAction SilentlyContinue
    Remove-Item Env:\DASK_AgentHost__DesktopActionExecution -ErrorAction SilentlyContinue

    # Checks never reached (e.g. after an unexpected error) are listed as not run, so the total is always complete.
    foreach ($k in 'setup', 'pre', 'a1', 'b1', 'c1', 'a2', 'b2', 'c2', 'a3', 'b3', 'c3', 'd4', 'e5') {
        if (-not ($script:results | Where-Object { $_.name -eq $N[$k] })) { Record $N[$k] $false @{ notRun = "not reached: $($script:AbortReason)" } }
    }
    $hudAll = Read-LogSince $script:hudLog 0
    $dmAll = Read-LogSince $script:daemonLog 0
    $diag = [ordered]@{
        aborted = $script:Aborted; abortReason = $script:AbortReason
        approvalsShownByHud = [regex]::Matches($hudAll, 'Approval surface opened for').Count
        decisionsSentByHud = [regex]::Matches($hudAll, 'Action approval decision: approval_id=').Count
        decisionsReceivedByDaemon = [regex]::Matches($dmAll, 'Received user approval decision for').Count
        tasksSubmittedToDaemon = [regex]::Matches($dmAll, "Type='AgentTaskSubmitRequest'").Count
        approvedNotExecuted = [regex]::Matches($dmAll, 'approved and consumed; not executed').Count
    }
    $checks = @($script:results.ToArray() | Where-Object { $_.name -ne 'unexpected error' })
    $passed = @($checks | Where-Object { $_.pass -eq $true }).Count
    $failed = @($script:results.ToArray() | Where-Object { $_.pass -ne $true }).Count
    $summary = [ordered]@{ expectedTotal = $script:ExpectedChecks; total = $checks.Count; passed = $passed; failed = $failed
        aborted = $script:Aborted; abortReason = $script:AbortReason; diagnostics = $diag }
    ConvertTo-Json -InputObject @($script:results.ToArray()) -Depth 8 | Set-Content -Encoding utf8 (Join-Path $OutDir 'approval-live.json')
    ConvertTo-Json -InputObject ([pscustomobject]@{ clicks = @($script:clicks.ToArray()); submits = @($script:submits.ToArray()); decisions = @($script:decisions.ToArray()) }) -Depth 8 |
        Set-Content -Encoding utf8 (Join-Path $OutDir 'interaction-log.json')
    ConvertTo-Json -InputObject ([pscustomobject]$summary) -Depth 6 | Set-Content -Encoding utf8 (Join-Path $OutDir 'approval-live-summary.json')
    Write-Host "`n$passed / $($checks.Count) checks passed (expected $($script:ExpectedChecks)); failed $failed; aborted: $($script:Aborted) $(if ($script:AbortReason) { "($($script:AbortReason))" })"
    Write-Host "Results: $OutDir"
}
$allPassed = (-not $script:Aborted) -and ($failed -eq 0) -and ($checks.Count -eq $script:ExpectedChecks)
exit $(if ($allPassed) { 0 } else { 1 })
