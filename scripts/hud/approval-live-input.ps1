# P1/P2 live run: guarded mouse and keyboard input through the REAL HUD, on ONE disposable fixture window.
#   natural language typed into the real HUD -> real daemon -> real agent host + local model -> protocol v2 -> the daemon
#   resolves the window AND the control from the OS -> approval card in the real HUD -> APPROVE / DENY / STOP clicked ->
#   the daemon validates, consumes once, revalidates window + control, writes the audit record, then sends the input
#   event by event (each gated) -> independent verification -> verified result in the HUD. The fixture independently
#   reports what it received ("CLICKS n", "TEXT len sha256"); this script also reads key states from the OS.
#
# Safety: identical guards to approval-live-7b3.ps1 (whose helpers are reused verbatim via -LoadFunctionsOnly). The
# only window that receives input from D-ASK is the fixture this script creates; mouse and keyboard input are enabled
# for THIS daemon process only (environment), never in appsettings. Nothing is retried; an uncertain step aborts.
#
#   powershell -ExecutionPolicy Bypass -File scripts\hud\approval-live-input.ps1 -OutDir results\p1p2-hud\live-<stamp>
#
# Exit code 0 only if every check passed and nothing was aborted.
param([Parameter(Mandatory = $true)][string]$OutDir, [string]$Root, [string]$Config = 'Debug')
$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = (Resolve-Path "$PSScriptRoot\..\..").Path }
if ((Test-Path $OutDir) -and @(Get-ChildItem $OutDir -Force).Count -gt 0) { throw "OutDir must be new or empty: $OutDir" }
New-Item -ItemType Directory -Force $OutDir | Out-Null
$keepOut = $OutDir; $keepRoot = $Root; $keepConfig = $Config
. "$PSScriptRoot\approval-live-7b3.ps1" -OutDir $keepOut -Root $keepRoot -Config $keepConfig -LoadFunctionsOnly
$OutDir = $keepOut; $Root = $keepRoot; $Config = $keepConfig
$ErrorActionPreference = 'Stop'
# -LoadFunctionsOnly stops before the interactive helpers (guarded clicks/typing, request, approval, decision and result
# waits). Load exactly that region of the UNMODIFIED P0 script: from its early-return line to the start of its main part.
$p0Lines = Get-Content "$PSScriptRoot\approval-live-7b3.ps1"
$from = [Array]::FindIndex($p0Lines, [Predicate[string]] { param($l) $l -eq 'if ($LoadFunctionsOnly) { return }' })
if ($from -lt 0) { throw 'the P0 harness layout changed; refusing to guess which helpers to load' }
# The region ends at the first top-level statement (P0's main part). Only definitions are loaded: function bodies are
# indented, so every top-level line taken is a function start, a closing brace, a comment or the known initialiser.
$to = [Array]::FindIndex($p0Lines, $from + 1, [Predicate[string]] { param($l) $l -match '^\S' -and $l -notmatch '^(function |\}|#|\$script:procNames = @\{\})' })
if ($to -le $from + 1) { throw 'the P0 helper region could not be delimited; refusing to run it' }
$helperText = ($p0Lines[($from + 1)..($to - 1)] -join "`r`n")
foreach ($fn in 'Invoke-Request', 'Invoke-GuardedClick', 'Wait-NewApproval', 'Confirm-Decision', 'Wait-NewResult', 'Wait-PanelClosed', 'Wait-Log') {
    if ($helperText -notmatch "(?m)^function $fn\b") { throw "the P0 helper region does not define $fn; refusing to run" }
}
. ([scriptblock]::Create($helperText))

if (-not ('KeyStateX' -as [type])) {
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class KeyStateX {
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public static bool Down(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }
}
'@
}

$script:ExpectedChecks = 23
$N = [ordered]@{
    setup = '0 setup: real HUD handshook with the real daemon (mouse + keyboard input enabled for THIS run only); HUD interactive; input fixture ready'
    flags = '0b input flags default OFF: absent/false in appsettings.json and false in code; enabled here only through this run''s environment'
    pre   = '0c memory preflight: the local model would be admitted with the HUD running (no task was sent before this)'
    a1 = '1a click request typed in the HUD came back as a NEW approval'
    b1 = '1b the click card shows WHAT WILL HAPPEN (control, id, point), the application, window, risk, expiry and digest'
    c1 = '1c APPROVE: both logs show approved=true; the daemon sent the input and verified it; a NEW completed result says Verified'
    d1 = '1d the fixture independently reports exactly ONE click'
    a2 = '2a typing request came back as a NEW approval'
    b2 = '2b the typing card shows the COMPLETE text and its length, the control and WHAT WILL HAPPEN'
    c2 = '2c APPROVE: executed and verified by exact insertion; a NEW completed result'
    d2 = '2d the fixture independently reports exactly the approved text'
    a3 = '3a key request (Backspace) came back as a NEW approval showing the key'
    b3 = '3b APPROVE: executed and verified by the value change; a NEW completed result'
    c3 = '3c the fixture independently reports the text one character shorter'
    a4 = '4a click request came back as a NEW approval'
    b4 = '4b DENY: both logs show approved=false; no input was sent; the fixture reports no new click; a NEW declined result'
    a5 = '5a click request came back as a NEW approval'
    b5 = '5b STOP while pending: approval invalidated, no decision sent, no input sent, no new click'
    c5 = '5c RESUME reached the daemon'
    a6 = '6a long typing request approved; typing started (the fixture reported a change)'
    b6 = '6b foreign input (injected by this script, no D-ASK marker) stopped the typing before it finished; not reported as completed; nothing retried'
    c6 = '6c after the interruption no mouse button and no modifier key is held (OS key state)'
    end = '7 end state: the fixture exists; its final text is consistent with exactly what was approved and verified'
}

$fxFile = Join-Path $OutDir 'fixture-reports.txt'
function Fx-Lines { if (Test-Path $fxFile) { @(Get-Content $fxFile) } else { @() } }
function Fx-Clicks { $c = @(Fx-Lines | Where-Object { $_ -like 'CLICKS *' }); if ($c.Count) { [int]($c[-1].Split(' ')[1]) } else { 0 } }
function Fx-LastText { $t = @(Fx-Lines | Where-Object { $_ -like 'TEXT *' }); if ($t.Count) { $p = $t[-1].Split(' '); [pscustomobject]@{ len = [int]$p[1]; sha = $p[2] } } else { [pscustomobject]@{ len = 0; sha = $null } } }
function Sha([string]$s) { ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($s)))).Replace('-', '') }
function Wait-Fx([scriptblock]$Cond, [int]$TimeoutMs = 10000) { $sw = [Diagnostics.Stopwatch]::StartNew(); while ($sw.ElapsedMilliseconds -lt $TimeoutMs) { if (& $Cond) { return $true }; Start-Sleep -Milliseconds 50 }; return $false }
function InputLog($Marks, [string]$Tool) { Wait-Log 'daemon' $Marks ('\[DesktopInput\] ' + [regex]::Escape($Tool) + ' for task \S+: (\d+)/(\d+) steps, stopped=(\S+), verified=(\w+) \(([^)]*)\)') 30000 }

# After an input action the target window (not the HUD) is in front, and the daemon sent the last input, so a plain
# SetForegroundWindow from this script is refused. The HUD's own toggle hotkey lets the HUD bring itself back. Only
# used BETWEEN actions (no input action is running then, and the daemon's input monitor is off).
function Restore-HudFront {
    if ([HudInput]::GetForegroundWindow() -eq $script:hwnd) { return }
    if ((Get-HudMode $script:hwnd) -eq 'interactive') {
        Send-HudToggleHotkey
        try { [void](Wait-HudMode $script:hwnd 'ambient' 3000) } catch { }
    }
    Enter-HudInteractive $script:hwnd
    Assert-HudForeground $script:hwnd
    # The page re-renders after a mode change; let it settle so the click helper's element re-reads are stable
    # (an unstable read makes it refuse the click, correctly, which would abort the run).
    Start-Sleep -Milliseconds 1200
    [void](Find-HudElement $script:hwnd -AutomationId 'ultron-command' -TimeoutMs 8000)
}
function Invoke-RequestFront([string]$Text) { Restore-HudFront; Invoke-Request $Text }

# One approved input: ask, check the card, APPROVE, confirm both logs, daemon log, HUD result. Returns $true when verified.
function Invoke-ApprovedInput([string]$Request, [string]$KA, [string]$KB, [string]$KC, [string[]]$Need, [string]$Tool, [string]$ResultPattern, [string]$CardFile) {
    $s = Invoke-RequestFront $Request
    if (-not $s.Ok) { Record $N[$KA] $false @{ submit = $s.Record }; Abort "$KA not submitted: $($s.Reason)"; return $false }
    $a = Wait-NewApproval $s.Marks
    Record $N[$KA] $a.Found @{ approvalId = $a.Id; msSubmitToApproval = $(if ($s.Clock) { $s.Clock.ElapsedMilliseconds } else { $null }); reason = $a.Reason }
    if (-not $a.Found) { Abort "${KA}: $($a.Reason)"; return $false }
    Set-Content -Encoding utf8 (Join-Path $OutDir $CardFile) $a.Text
    if ($KB) {
        $missing = @($Need | Where-Object { -not (Contains-Text $a.Text $_) })
        Record $N[$KB] ($missing.Count -eq 0) @{ missing = $missing }
    }
    $click = Invoke-GuardedClick -Label 'APPROVE' -ButtonPattern '^APPROVE$' -WaitEnabled
    if (-not $click.sent) { Record $N[$KC] $false @{ click = $click }; Abort "APPROVE was not clicked: $($click.abortReason)"; return $false }
    $d = Confirm-Decision $s.Marks $a.Id $true $click
    if ($d.evidence.state -ne 'confirmed') { Record $N[$KC] $false @{ decision = $d }; Abort "uncertain click: decision '$($d.evidence.state)'"; return $false }
    $exec = InputLog $s.Marks $Tool
    $r = Wait-NewResult $s.Marks $ResultPattern
    $ok = $exec.Found -and $exec.Match.Groups[4].Value -eq 'True' -and $exec.Match.Groups[3].Value -eq 'no' -and $r.matched -and $r.outcome -eq 'COMPLETED' -and (Contains-Text $r.text 'Verified')
    Record $N[$KC] $ok @{ decision = $d; daemonInput = $(if ($exec.Found) { $exec.Match.Value } else { $null }); result = @{ arrived = $r.arrived; matched = $r.matched; outcome = $r.outcome; msToArrive = $r.msToArrive } }
    if (-not $ok) { Abort "${KC}: not executed and verified as expected" }
    return $ok
}

$script:hudLog = Join-Path $OutDir 'hud.log'
$script:daemonLog = Join-Path $OutDir 'daemon.log'
$tag = [Guid]::NewGuid().ToString('N').Substring(0, 6)
$title = "DASK Input Fixture $tag"
$fxPsi = New-Object Diagnostics.ProcessStartInfo 'powershell.exe'
$fxPsi.Arguments = "-NoProfile -STA -ExecutionPolicy Bypass -File `"$Root\tests\DAsk.Daemon.Tests\Fixtures\input-fixture.ps1`" -Title `"$title`" -X 140 -Y 140 -OutFile `"$fxFile`""
$fxPsi.UseShellExecute = $false; $fxPsi.CreateNoWindow = $true
$fx = [Diagnostics.Process]::Start($fxPsi)
if (-not (Wait-Fx { @(Fx-Lines | Where-Object { $_ -like 'READY *' }).Count -gt 0 } 30000)) { throw 'the input fixture did not start' }
$script:fxHwnd = [IntPtr][int64](@(Fx-Lines | Where-Object { $_ -like 'READY *' })[0].Split(' ')[1])
$typed = ''   # what the fixture's field should contain, from approved and verified actions only

$env:DASK_AgentHost__DesktopReadAllowedProcessIds__0 = "$($fx.Id)"
$env:DASK_AgentHost__DesktopActionExecution = 'true'
$env:DASK_AgentHost__DesktopMouseInput = 'true'      # this run only
$env:DASK_AgentHost__DesktopKeyboardInput = 'true'   # this run only
try {
    # ---- 0b. defaults: before anything is started ----
    $settings = Get-Content (Join-Path $Root 'src\DAsk.Daemon\appsettings.json') -Raw | ConvertFrom-Json
    $src = Get-Content (Join-Path $Root 'src\DAsk.Daemon\AgentHost\AgentHostManager.cs') -Raw
    $cfgOff = (-not ($settings.AgentHost.PSObject.Properties.Name -contains 'DesktopMouseInput') -or $settings.AgentHost.DesktopMouseInput -eq $false) -and
              (-not ($settings.AgentHost.PSObject.Properties.Name -contains 'DesktopKeyboardInput') -or $settings.AgentHost.DesktopKeyboardInput -eq $false)
    $codeOff = ($src -match 'public bool DesktopMouseInput \{ get; set; \} = false;') -and ($src -match 'public bool DesktopKeyboardInput \{ get; set; \} = false;')
    Record $N.flags ($cfgOff -and $codeOff) @{ appsettingsOff = $cfgOff; codeDefaultOff = $codeOff; enabledForThisRunVia = 'environment of this daemon process only' }

    & "$PSScriptRoot\start-stack.ps1" -OutDir $OutDir -Config $Config -Root $Root | Out-Null
    $pids = Get-Content "$OutDir\pids.json" -Raw | ConvertFrom-Json
    $script:hwnd = Get-HudHwnd $pids.hud
    Start-Sleep -Seconds 2
    if ((Get-Content $script:hudLog -Raw) -match 'Could not register Ctrl\+Alt\+Space') {
        Record $N.setup $false @{ blocked = 'another application owns Ctrl+Alt+Space' }; Abort 'Ctrl+Alt+Space is owned by another application'
    } else {
        Enter-HudInteractive $script:hwnd
        $ok = ((Get-Content $script:hudLog -Raw) -match 'Handshake accepted') -and [Fx7B2]::IsWindow($script:fxHwnd)
        Record $N.setup $ok @{ fixturePid = $fx.Id; fixtureHwnd = [int64]$script:fxHwnd; title = $title }
        if (-not $ok) { Abort 'setup failed' }
    }

    # ---- 0c. memory preflight (unchanged rule: 2973 MB with the HUD running) ----
    if (-not $script:Aborted) {
        try {
            $adm = Get-ModelMemoryAdmission $Root; $mp = Test-ModelMemoryPreflight $adm
            [pscustomobject]@{ utc = (Get-Utc); measurement = $adm; decision = $mp } | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 (Join-Path $OutDir 'memory-preflight.json')
            Record $N.pre $mp.ok @{ availableMB = $adm.availableMB; requiredMB = $adm.requiredMB }
            if (-not $mp.ok) { Abort $mp.reason }
        } catch { Record $N.pre $false @{ error = "$_" }; Abort "memory preflight failed: $_" }
    }

    # ---- 1. click ----
    if ($script:Aborted) { foreach ($k in 'a1', 'b1', 'c1', 'd1') { Skipped $N[$k] } } else {
        $c0 = Fx-Clicks
        $ok = Invoke-ApprovedInput "Click the Go button in the window titled `"$title`"" 'a1' 'b1' 'c1' @('WHAT WILL HAPPEN', 'Left-click ONCE', 'Button', '"Go"', '#go', 'screen point', 'Click one control once', 'powershell.exe', $title, 'Elevated', 'expires in', 'Action digest', 'mouse') 'desktop.click_element' 'Clicked' 'card-1-click.txt'
        if ($ok) {
            $one = Wait-Fx { (Fx-Clicks) -eq $c0 + 1 } 5000
            Start-Sleep -Milliseconds 500
            Record $N.d1 ($one -and (Fx-Clicks) -eq $c0 + 1) @{ clicksBefore = $c0; clicksAfter = (Fx-Clicks) }
            if (-not $one) { Abort 'the fixture did not report exactly one click' }
        } else { foreach ($k in 'a1', 'b1', 'c1', 'd1') { if (-not ($script:results | Where-Object { $_.name -eq $N[$k] })) { Skipped $N[$k] } } }
    }

    # ---- 2. type exact text ----
    if (-not $script:Aborted) { if ((Wait-PanelClosed) -lt 0) { Abort 'the previous approval panel did not close' } }
    if ($script:Aborted) { foreach ($k in 'a2', 'b2', 'c2', 'd2') { Skipped $N[$k] } } else {
        $text = 'hello d-ask'
        $ok = Invoke-ApprovedInput "Type `"$text`" into the notes field of the window titled `"$title`"" 'a2' 'b2' 'c2' @('WHAT WILL HAPPEN', 'Type exactly the 11 character(s)', $text, '11 characters, shown in full', 'Edit', '#notes', 'Type text into one field', 'keyboard') 'desktop.type_text' 'Typed' 'card-2-type.txt'
        if ($ok) {
            $typed = $typed + $text
            $exact = Wait-Fx { $t = Fx-LastText; $t.len -eq $typed.Length -and $t.sha -eq (Sha $typed) } 5000
            Record $N.d2 $exact @{ expectedLength = $typed.Length; fixture = (Fx-LastText) }
            if (-not $exact) { Abort 'the fixture does not hold exactly the approved text' }
        } else { foreach ($k in 'a2', 'b2', 'c2', 'd2') { if (-not ($script:results | Where-Object { $_.name -eq $N[$k] })) { Skipped $N[$k] } } }
    }

    # ---- 3. key chord (Backspace) ----
    if (-not $script:Aborted) { if ((Wait-PanelClosed) -lt 0) { Abort 'the previous approval panel did not close' } }
    if ($script:Aborted) { foreach ($k in 'a3', 'b3', 'c3') { Skipped $N[$k] } } else {
        $ok = Invoke-ApprovedInput "Press Backspace in the notes field of the window titled `"$title`"" 'a3' $null 'b3' @() 'desktop.press_keys' 'Pressed' 'card-3-keys.txt'
        $card = Get-Content (Join-Path $OutDir 'card-3-keys.txt') -Raw -ErrorAction SilentlyContinue
        if ($script:results | Where-Object { $_.name -eq $N.a3 -and $_.pass }) {
            # 3a also requires that the card named the key exactly.
            $named = $card -and (Contains-Text $card 'Press Backspace ONCE') -and (Contains-Text $card 'Press one key combination')
            if (-not $named) { Record $N.a3 $false @{ cardShowsKey = $false }; Abort 'the key card did not show the key' }
        }
        if ($ok) {
            $typed = $typed.Substring(0, $typed.Length - 1)
            $one = Wait-Fx { $t = Fx-LastText; $t.len -eq $typed.Length -and $t.sha -eq (Sha $typed) } 5000
            Record $N.c3 $one @{ expectedLength = $typed.Length; fixture = (Fx-LastText) }
            if (-not $one) { Abort 'the fixture text did not lose exactly one character' }
        } else { foreach ($k in 'a3', 'b3', 'c3') { if (-not ($script:results | Where-Object { $_.name -eq $N[$k] })) { Skipped $N[$k] } } }
    }

    # ---- 4. DENY ----
    if (-not $script:Aborted) { if ((Wait-PanelClosed) -lt 0) { Abort 'the previous approval panel did not close' } }
    if ($script:Aborted) { foreach ($k in 'a4', 'b4') { Skipped $N[$k] } } else {
        $c0 = Fx-Clicks
        $s = Invoke-RequestFront "Click the Go button in the window titled `"$title`""
        if (-not $s.Ok) { Record $N.a4 $false @{ submit = $s.Record }; Abort "request 4 not submitted: $($s.Reason)"; Skipped $N.b4 } else {
            $a = Wait-NewApproval $s.Marks
            Record $N.a4 $a.Found @{ approvalId = $a.Id; reason = $a.Reason }
            if (-not $a.Found) { Abort "request 4: $($a.Reason)"; Skipped $N.b4 } else {
                $click = Invoke-GuardedClick -Label 'DENY' -ButtonPattern '^DENY$' -WaitEnabled
                if (-not $click.sent) { Record $N.b4 $false @{ click = $click }; Abort "DENY was not clicked: $($click.abortReason)" } else {
                    $d = Confirm-Decision $s.Marks $a.Id $false $click
                    $r = Wait-NewResult $s.Marks 'declined'
                    Start-Sleep -Milliseconds 800
                    $noInput = -not ((Read-LogSince $script:daemonLog $s.Marks.daemon) -match '\[DesktopInput\] \S+ for task \S+: \d+/\d+ steps')   # a line that reports input SENT (refusals say 'not performed')
                    Record $N.b4 ($d.evidence.state -eq 'confirmed' -and $noInput -and (Fx-Clicks) -eq $c0 -and $r.arrived -and $r.outcome -ne 'COMPLETED') @{
                        decision = $d; noInputSent = $noInput; clicksBefore = $c0; clicksAfter = (Fx-Clicks); result = @{ arrived = $r.arrived; outcome = $r.outcome } }
                }
            }
        }
    }

    # ---- 5. Emergency Stop while pending, then Resume ----
    if (-not $script:Aborted) { if ((Wait-PanelClosed) -lt 0) { Abort 'the previous approval panel did not close' } }
    if ($script:Aborted) { foreach ($k in 'a5', 'b5', 'c5') { Skipped $N[$k] } } else {
        $c0 = Fx-Clicks
        $s = Invoke-RequestFront "Click the Go button in the window titled `"$title`""
        if (-not $s.Ok) { Record $N.a5 $false @{ submit = $s.Record }; Abort "request 5 not submitted: $($s.Reason)"; Skipped $N.b5; Skipped $N.c5 } else {
            $a = Wait-NewApproval $s.Marks
            Record $N.a5 $a.Found @{ approvalId = $a.Id; reason = $a.Reason }
            if (-not $a.Found) { Abort "request 5: $($a.Reason)"; Skipped $N.b5; Skipped $N.c5 } else {
                $click = Invoke-GuardedClick -Label 'STOP' -ButtonPattern 'STOP \[Ctrl\+Shift\+F12\]$'
                if (-not $click.sent) { Record $N.b5 $false @{ click = $click }; Abort "STOP was not clicked: $($click.abortReason)"; Skipped $N.c5 } else {
                    $stopD = Wait-Log 'daemon' $s.Marks '\[EMERGENCY STOP\] Triggered'
                    $inv = Wait-Log 'hud' $s.Marks ('Approval ' + $a.Id + ' is now (InvalidatedByEmergencyStop|Cancelled)')
                    $r = Wait-NewResult $s.Marks 'Emergency Stop'
                    Start-Sleep -Milliseconds 800
                    $noDecision = (Get-DecisionEvidence (Read-LogSince $script:hudLog $s.Marks.hud) (Read-LogSince $script:daemonLog $s.Marks.daemon) $a.Id $false).hudDecisions -eq 0
                    $noInput = -not ((Read-LogSince $script:daemonLog $s.Marks.daemon) -match '\[DesktopInput\] \S+ for task \S+: \d+/\d+ steps')   # a line that reports input SENT (refusals say 'not performed')
                    Record $N.b5 ($stopD.Found -and $inv.Found -and $noDecision -and $noInput -and (Fx-Clicks) -eq $c0 -and $r.outcome -ne 'COMPLETED') @{
                        click = $click; stopInDaemon = $stopD.Found; invalidated = $inv.Found; noDecisionSent = $noDecision; noInputSent = $noInput; clicks = (Fx-Clicks); result = @{ arrived = $r.arrived; outcome = $r.outcome } }
                    if (-not $inv.Found) { Abort 'the pending approval was not invalidated' }
                    if (-not $script:Aborted) { if ((Wait-PanelClosed) -lt 0) { Abort 'the invalidated approval panel did not close' } }
                    if ($script:Aborted) { Skipped $N.c5 } else {
                        $m5 = Mark-Logs
                        $rc = Invoke-GuardedClick -Label 'RESUME' -ButtonPattern '(^|\s)RESUME$'
                        if (-not $rc.sent) { Record $N.c5 $false @{ click = $rc }; Abort "RESUME was not clicked: $($rc.abortReason)" } else {
                            $res = Wait-Log 'daemon' $m5 '\[RESUME\] Execution resumed'
                            Record $N.c5 $res.Found @{ click = $rc; msToResumed = $res.Ms }
                            if (-not $res.Found) { Abort 'RESUME did not reach the daemon' }
                        }
                    }
                }
            }
        }
    }

    # ---- 6. External input during typing stops it; nothing stays pressed ----
    if (-not $script:Aborted) { if ((Wait-PanelClosed) -lt 0) { Abort 'the previous approval panel did not close' } }
    if ($script:Aborted) { foreach ($k in 'a6', 'b6', 'c6') { Skipped $N[$k] } } else {
        $long = ('abcdefghij' * 12)   # 120 characters: typed one gated event at a time
        $base = (Fx-LastText).len
        $s = Invoke-RequestFront "Type `"$long`" into the notes field of the window titled `"$title`""
        if (-not $s.Ok) { Record $N.a6 $false @{ submit = $s.Record }; Abort "request 6 not submitted: $($s.Reason)"; Skipped $N.b6; Skipped $N.c6 } else {
            $a = Wait-NewApproval $s.Marks
            if (-not $a.Found) { Record $N.a6 $false @{ reason = $a.Reason }; Abort "request 6: $($a.Reason)"; Skipped $N.b6; Skipped $N.c6 } else {
                Set-Content -Encoding utf8 (Join-Path $OutDir 'card-6-long.txt') $a.Text
                $click = Invoke-GuardedClick -Label 'APPROVE' -ButtonPattern '^APPROVE$' -WaitEnabled
                $d = if ($click.sent) { Confirm-Decision $s.Marks $a.Id $true $click } else { $null }
                $started = $click.sent -and $d.evidence.state -eq 'confirmed' -and (Wait-Fx { (Fx-LastText).len -gt $base } 20000)
                Record $N.a6 $started @{ click = $click; decision = $d; lengthBefore = $base; fixture = (Fx-LastText) }
                if (-not $started) { Abort 'the long typing did not start'; Skipped $N.b6; Skipped $N.c6 } else {
                    # Foreign input: F24 (no effect in a text box), injected WITHOUT the D-ASK marker.
                    $injectedUtc = Get-Utc
                    [KeyStateX]::keybd_event(0x87, 0, 0, [UIntPtr]::Zero); [KeyStateX]::keybd_event(0x87, 0, 2, [UIntPtr]::Zero)
                    $exec = InputLog $s.Marks 'desktop.type_text'
                    $r = Wait-NewResult $s.Marks 'Stopped|interrupted|another program'
                    Start-Sleep -Milliseconds 800
                    $final = (Fx-LastText).len
                    $stopped = $exec.Found -and $exec.Match.Groups[3].Value -eq 'user_interrupted' -and [int]$exec.Match.Groups[1].Value -lt [int]$exec.Match.Groups[2].Value
                    $partial = $final -gt $base -and $final -lt ($base + $long.Length)
                    $notRetried = @([regex]::Matches((Read-LogSince $script:daemonLog $s.Marks.daemon), 'DesktopInputExecutionAdmitted')).Count -le 1
                    Record $N.b6 ($stopped -and $partial -and $r.outcome -ne 'COMPLETED' -and $notRetried) @{
                        injectedUtc = $injectedUtc; daemonInput = $(if ($exec.Found) { $exec.Match.Value } else { $null }); fixtureLength = $final; expectedFull = $base + $long.Length
                        result = @{ arrived = $r.arrived; outcome = $r.outcome }; notRetried = $notRetried }
                    $held = @{ leftButton = [KeyStateX]::Down(0x01); shift = [KeyStateX]::Down(0x10); ctrl = [KeyStateX]::Down(0x11); alt = [KeyStateX]::Down(0x12) }
                    Record $N.c6 (-not ($held.leftButton -or $held.shift -or $held.ctrl -or $held.alt)) $held
                    # Whatever the fixture holds now is the verified text plus a prefix of the long text (the part typed before the stop).
                    $script:expectedEnd = [pscustomobject]@{ prefix = $typed; long = $long }
                }
            }
        }
    }
} catch {
    Record 'unexpected error' $false @{ error = "$($_.Exception.Message)" }
    Abort "unexpected error: $($_.Exception.Message)"
} finally {
    try {
        $t = Fx-LastText
        $okEnd = [Fx7B2]::IsWindow($script:fxHwnd)
        if ($script:expectedEnd) {
            $k = $t.len - $script:expectedEnd.prefix.Length
            $okEnd = $okEnd -and $k -ge 0 -and $k -le $script:expectedEnd.long.Length -and $t.sha -eq (Sha ($script:expectedEnd.prefix + $script:expectedEnd.long.Substring(0, $k)))
        } elseif ($typed) { $okEnd = $okEnd -and $t.sha -eq (Sha $typed) }
        Record $N.end $okEnd @{ fixtureText = $t; verifiedPrefixLength = $typed.Length }
    } catch { Record $N.end $false @{ error = "$($_.Exception.Message)" } }
    try { & "$PSScriptRoot\stop-stack.ps1" -OutDir $OutDir | Out-Null } catch { }
    try { if (-not $fx.HasExited) { $fx.Kill() } } catch { }
    foreach ($v in 'DesktopReadAllowedProcessIds__0', 'DesktopActionExecution', 'DesktopMouseInput', 'DesktopKeyboardInput') { Remove-Item "Env:\DASK_AgentHost__$v" -ErrorAction SilentlyContinue }

    foreach ($k in $N.Keys) { if (-not ($script:results | Where-Object { $_.name -eq $N[$k] })) { Record $N[$k] $false @{ notRun = "not reached: $($script:AbortReason)" } } }
    $dmAll = Read-LogSince $script:daemonLog 0
    $hudAll = Read-LogSince $script:hudLog 0
    $diag = [ordered]@{
        aborted = $script:Aborted; abortReason = $script:AbortReason
        approvalsShownByHud = [regex]::Matches($hudAll, 'Approval surface opened for').Count
        decisionsSentByHud = [regex]::Matches($hudAll, 'Action approval decision: approval_id=').Count
        decisionsReceivedByDaemon = [regex]::Matches($dmAll, 'Received user approval decision for').Count
        inputExecutions = [regex]::Matches($dmAll, '\[DesktopInput\] desktop\.\w+ for task').Count
        fixtureReports = @(Fx-Lines).Count
    }
    $checks = @($script:results.ToArray() | Where-Object { $_.name -ne 'unexpected error' })
    $passed = @($checks | Where-Object { $_.pass -eq $true }).Count
    $failed = @($script:results.ToArray() | Where-Object { $_.pass -ne $true }).Count
    $summary = [ordered]@{ expectedTotal = $script:ExpectedChecks; total = $checks.Count; passed = $passed; failed = $failed; aborted = $script:Aborted; abortReason = $script:AbortReason; diagnostics = $diag }
    ConvertTo-Json -InputObject @($script:results.ToArray()) -Depth 8 | Set-Content -Encoding utf8 (Join-Path $OutDir 'approval-live.json')
    ConvertTo-Json -InputObject ([pscustomobject]$summary) -Depth 6 | Set-Content -Encoding utf8 (Join-Path $OutDir 'approval-live-summary.json')
    Write-Host "`n$passed / $($checks.Count) checks passed (expected $($script:ExpectedChecks)); failed $failed; aborted: $($script:Aborted)$(if ($script:AbortReason) { " ($($script:AbortReason))" })"
    Write-Host "Results: $OutDir"
}
exit $(if ($failed -eq 0 -and -not $script:Aborted -and $checks.Count -eq $script:ExpectedChecks) { 0 } else { 1 })
