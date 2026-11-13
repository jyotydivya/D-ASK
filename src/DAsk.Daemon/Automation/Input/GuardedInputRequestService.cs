using System.Diagnostics;
using System.Text.Json;
using DAsk.Daemon.Automation.Desktop;
using DAsk.Daemon.Automation.Observation;
using DAsk.Daemon.Automation.Policy;
using DAsk.Daemon.Research;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Extensions.Logging;

namespace DAsk.Daemon.Automation.Input;

/// <summary>
/// P1 + P2: approval-gated, element-bound desktop input. Same pathway as the 7B.3 window operations (strict args → Stop
/// check → the daemon resolves the window from the OS → policy (Elevated) → the exact canonical action, bound to the full
/// window AND control identity, is approved by the owner's HUD → validated and consumed once → the window (with an
/// unchanged title, D-3) and the control are re-read) and then:
///   write-ahead audit (awaited; none, no input) → D-4 monitor installed → foreground / focus established once (no retry)
///   → per-event gate → events (atomic batches; held state always released) → independent verification.
/// Mouse and keyboard are separate execution policies; a disabled kind is refused before anything is asked.
/// The agent never supplies coordinates, handles or key codes. Typed text is never written to logs or the audit trail
/// (only its length and SHA-256); it is shown to the user in the approval, since that is what they approve.
/// </summary>
public sealed class GuardedInputRequestService : IDesktopActionRequestService
{
    public const string Performed = "Performed once, right after your approval, on exactly this control (window and control checked again first, and before every input event); the result is then verified. Any physical mouse or keyboard use stops it.";

    private readonly DesktopReadService _reader;
    private readonly IUiAutomationService _uia;
    private readonly ActionPolicyEngine _policy;
    private readonly Func<bool> _isStopped;
    private readonly Func<ulong> _generation;
    private readonly IEvidenceRecorder? _evidence;
    private readonly Func<string, bool>? _isSessionLive;
    private readonly IDesktopInputPlatform _platform;
    private readonly GuardedInputOptions _options;
    private readonly ILogger? _logger;
    private readonly LaunchedWindowRegistry? _launched;

    public GuardedInputRequestService(DesktopReadService reader, IUiAutomationService uia, ActionPolicyEngine policy, Func<bool> isStopped,
        Func<ulong> generation, IEvidenceRecorder? evidence, Func<string, bool>? isSessionLive, IDesktopInputPlatform platform,
        GuardedInputOptions? options = null, ILogger? logger = null, LaunchedWindowRegistry? launched = null)
    {
        _launched = launched;
        _reader = reader; _uia = uia; _policy = policy; _isStopped = isStopped; _generation = generation; _evidence = evidence;
        _isSessionLive = isSessionLive; _platform = platform; _options = options ?? new GuardedInputOptions(); _logger = logger;
    }

    /// <summary>Only the enabled kinds are offered to the agent, so the model never sees a tool that would be refused.</summary>
    public IReadOnlyList<string> Tools => GuardedInputTools.All.Where(t => Enabled(t == GuardedInputTools.ClickElement ? InputKind.Mouse : InputKind.Keyboard)).ToArray();
    public int MaxCallMs => (int)Math.Min(_options.ApprovalTtl.TotalMilliseconds, ActionPolicyEngine.MaxApprovalTtl.TotalMilliseconds) + 15_000;

    private bool Enabled(InputKind k) => (k == InputKind.Mouse ? _options.MouseEnabled : _options.KeyboardEnabled) && _evidence != null && _isSessionLive != null;

    private sealed record Request(string Tool, string ActionType, InputKind Kind, string? Process, string? TitleContains, ControlSelector Control, string? Text, KeyChords.Chord? Chord);

    private string? Parse(string tool, JsonElement args, out Request req)
    {
        req = null!;
        if (args.ValueKind != JsonValueKind.Object) return "arguments must be an object";
        string? process = null, title = null, text = null, keys = null;
        ControlSelector? control = null;
        foreach (var p in args.EnumerateObject())
        {
            switch (p.Name)
            {
                case "process": if (p.Value.ValueKind != JsonValueKind.String) return "process must be text"; process = p.Value.GetString()!.Trim(); break;
                case "titleContains": if (p.Value.ValueKind != JsonValueKind.String) return "titleContains must be text"; title = p.Value.GetString(); break;
                case "element":
                    if (p.Value.ValueKind != JsonValueKind.Object) return "element must be an object { controlType, automationId?, name? }";
                    string? ct = null, aid = null, nm = null;
                    foreach (var e in p.Value.EnumerateObject())
                    {
                        if (e.Value.ValueKind != JsonValueKind.String) return $"element.{e.Name} must be text";
                        string v = e.Value.GetString()!;
                        if (v.Length > 200) return $"element.{e.Name} is too long";
                        switch (e.Name) { case "controlType": ct = v.Trim(); break; case "automationId": aid = v; break; case "name": nm = v; break; default: return $"unknown element field '{(e.Name.Length > 30 ? e.Name[..30] : e.Name)}'"; }
                    }
                    if (string.IsNullOrWhiteSpace(ct)) return "element.controlType is required";
                    if (string.IsNullOrEmpty(aid) && string.IsNullOrEmpty(nm)) return "element needs an automationId or a name";
                    control = new ControlSelector(ct!, aid, nm);
                    break;
                case "text" when tool == GuardedInputTools.TypeText: if (p.Value.ValueKind != JsonValueKind.String) return "text must be text"; text = p.Value.GetString(); break;
                case "keys" when tool == GuardedInputTools.PressKeys: if (p.Value.ValueKind != JsonValueKind.String) return "keys must be text"; keys = p.Value.GetString(); break;
                default: return $"unknown argument '{(p.Name.Length > 40 ? p.Name[..40] : p.Name)}'"; // never coordinates, handles, key codes or approvals
            }
        }
        if (DesktopReadService.ValidateSelector(process, title) is { } bad) return bad;
        if (control == null) return "element is required";
        KeyChords.Chord? chord = null;
        if (tool == GuardedInputTools.TypeText && TextRules.Validate(text, _options.MaxTextLength) is { } tbad) return tbad;
        if (tool == GuardedInputTools.PressKeys && KeyChords.Parse(keys, out chord) is { } kbad) return kbad;
        req = tool switch
        {
            GuardedInputTools.ClickElement => new Request(tool, DesktopActionTypes.ClickElement, InputKind.Mouse, process, title, control, null, null),
            GuardedInputTools.TypeText => new Request(tool, DesktopActionTypes.TypeText, InputKind.Keyboard, process, title, control, text, null),
            _ => new Request(tool, DesktopActionTypes.PressKeys, InputKind.Keyboard, process, title, control, null, chord),
        };
        return null;
    }

    public async Task<DesktopCallResult> ExecuteAsync(string tool, JsonElement args, DesktopActionContext ctx, CancellationToken ct)
    {
        DesktopCallResult result;
        try { result = await RunAsync(tool, args, ctx, ct); }
        catch (OperationCanceledException) { result = DesktopCallResult.Cancelled(); }
        // Every refusal is logged with its code only (never arguments, text or titles), including those before any approval.
        if (result.Status != "ok")
            _logger?.LogInformation("[DesktopInput] {Tool} for task {TaskId}: not performed ({Code}).", tool, ctx.TaskId, result.Error?.Code ?? result.Status);
        return result;
    }

    private Task<UiaInspection> Inspect(long hwnd, CancellationToken ct) =>
        _uia.InspectTreeAsync(new IntPtr(hwnd), ControlResolver.MaxDepth, ControlResolver.MaxElements, 3000, ct);

    private async Task<DesktopCallResult> RunAsync(string tool, JsonElement args, DesktopActionContext ctx, CancellationToken ct)
    {
        if (!GuardedInputTools.All.Contains(tool)) return DesktopCallResult.Fail("unknown_tool", "This operation is not available.");
        if (Parse(tool, args, out var r) is { } bad) return DesktopCallResult.Fail("invalid_args", bad);
        if (!Enabled(r.Kind))
            return DesktopCallResult.Fail("input_disabled", r.Kind == InputKind.Mouse
                ? "Mouse input is switched off in this installation (AgentHost:DesktopMouseInput). Nothing was asked or done."
                : "Keyboard input is switched off in this installation (AgentHost:DesktopKeyboardInput). Nothing was asked or done.");
        if (string.IsNullOrWhiteSpace(ctx.OwnerSessionId)) return DesktopCallResult.Fail("no_owner", "The task has no owning HUD session, so nobody can approve this.");
        if (_isStopped()) return DesktopCallResult.Fail("emergency_stopped", "Emergency Stop is active; no action can be requested.");

        // A window this daemon opened for THIS task (desktop.launch_app) is the target when it still is the same window and matches the
        // selector; otherwise the selector is resolved from the OS as always (ambiguity and missing windows are refused as before).
        WindowIdentity? target = _launched?.For(ctx.TaskId) is { } lw
            ? _reader.ResolveLaunched(lw.Hwnd, lw.ProcessId, lw.ProcessCreationFileTime, r.Process, r.TitleContains) : null;
        // A window D-ASK itself opened for this task may retitle itself as its content changes (Notepad: "*HELLO - Notepad"). Only for typing.
        bool titleMayFollowContent = target != null && r.Tool == GuardedInputTools.TypeText;
        if (target == null && _reader.ResolveTarget(r.Process, r.TitleContains, "acted on", out target) is { } notResolved) return notResolved;
        if (WindowIdentityRules.Incomplete(target!) is { } why)
            return DesktopCallResult.Fail("identity_uncertain", $"The window's identity cannot be established ({why}); nothing can be requested for it.");
        if (_options.DeniedImageNames.Contains(target!.ImageName))
            return DesktopCallResult.Fail("target_forbidden", $"{target.ImageName} never receives input from D-ASK.");
        var (allowed, risk, policyReason) = _policy.EvaluatePolicy(r.ActionType, new Dictionary<string, string>(), target.ImageName);
        if (allowed || risk != ActionRiskLevel.Elevated) return DesktopCallResult.Fail("policy_denied", $"The policy does not permit this request ({policyReason}).");

        // The control: exactly one element, resolved by the daemon from a complete inspection.
        var insp = await Inspect(target.Hwnd, ct);
        if (ControlResolver.Resolve(insp, r.Control, out var control) is { } rf)
        {
            // Control identifiers only (they are shown in approvals anyway); never typed text.
            _logger?.LogInformation("[DesktopInput] {Tool} for task {TaskId}: control {Selector} not resolved ({Code}; inspection {Status}, {Count} elements).",
                r.Tool, ctx.TaskId, r.Control.Describe(), rf.Code, insp.Status, insp.Nodes.Count);
            return DesktopCallResult.Fail(rf.Code, rf.Message);
        }
        if (ControlResolver.Revalidate(control!, insp, out _) is { } unusable) return DesktopCallResult.Fail(unusable.Code, unusable.Message);
        var (cx, cy) = control!.Center;
        var wb = target.Bounds;
        if (wb.Length != 4 || cx < wb[0] || cx >= wb[2] || cy < wb[1] || cy >= wb[3])
            return DesktopCallResult.Fail("target_unusable", "The control is not inside its window's visible area.");
        if (r.Kind == InputKind.Keyboard)
        {
            if (control.IsPassword) return DesktopCallResult.Fail("target_forbidden", "D-ASK never types into, or sends keys to, a password field.");
            if (!control.IsKeyboardFocusable) return DesktopCallResult.Fail("target_unusable", "The control cannot take keyboard focus.");
        }
        if (r.Tool == GuardedInputTools.TypeText)
        {
            if (!control.Patterns.Contains("Value")) return DesktopCallResult.Fail("target_unusable", "The control is not an editable text field.");
            var v0 = _platform.ReadValue(target.Hwnd, control.RuntimeId);
            if (!v0.Ok) return DesktopCallResult.Fail("target_unusable", "The control's text cannot be read, so typing could not be verified; nothing was asked.");
            if (v0.ReadOnly) return DesktopCallResult.Fail("target_unusable", "The text field is read-only.");
        }

        var created = DateTime.FromFileTimeUtc(target.ProcessCreationFileTime);
        var parameters = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["operation"] = r.Tool switch
            {
                GuardedInputTools.ClickElement => "Click this control once (left button)",
                GuardedInputTools.TypeText => "Type this text into this control",
                _ => $"Press {r.Chord!.Canonical} in this control",
            },
            ["inputPolicy"] = r.Kind == InputKind.Mouse ? "mouse" : "keyboard",
            ["window"] = target.Title,
            ["application"] = target.ImageName,
            ["imagePath"] = target.ImagePath,
            ["windowClass"] = target.WindowClass,
            ["processStarted"] = created.ToString("O"),
            ["logonSession"] = target.SessionId.ToString(),
            ["control"] = r.Control.Describe(),
            ["controlType"] = control.ControlType,
            ["controlAutomationId"] = control.AutomationId,
            ["controlName"] = control.Name,
            ["controlPath"] = control.ControlPathHash[..16],
            ["controlBounds"] = string.Join(",", control.Bounds),
            ["display"] = $"display {target.DisplayIndex + 1}{(target.DisplayIsPrimary ? " (primary)" : "")}, {target.Dpi} DPI",
            ["reversible"] = r.Tool == GuardedInputTools.TypeText ? "Usually: typed text can be deleted or undone (Ctrl+Z) in most applications." : "It depends on what this control does in that application.",
            ["execution"] = Performed,
        };
        if (r.Tool == GuardedInputTools.ClickElement) parameters["point"] = $"{cx},{cy}";
        if (titleMayFollowContent) parameters[TitleFollowsContentKey] = "This window was opened by D-ASK for this request; its title may change as it fills with the typed text (the part after the last ' - ' must stay the same). Window identity is still checked before every key.";
        if (r.Text != null) { parameters["text"] = r.Text; parameters["textLength"] = r.Text.Length.ToString(); }
        if (r.Chord != null) parameters["keys"] = r.Chord.Canonical;

        ulong generation = _generation();
        var request = new ActionApprovalRequest
        {
            ApprovalId = Guid.NewGuid().ToString("N"),
            ActionId = Guid.NewGuid().ToString("N"),
            ActionType = r.ActionType,
            ActionParameters = parameters,
            TargetProcessName = target.ImageName,
            TargetWindowTitle = target.Title,
            TargetHwnd = target.Hwnd,
            TargetProcessId = target.ProcessId,
            TargetProcessCreationTime = new DateTimeOffset(created, TimeSpan.Zero),
            SessionId = ctx.OwnerSessionId,
            StopGeneration = generation,
            RiskLevel = risk.ToString(),
            CreatedAtUtc = DateTimeOffset.UtcNow,
            ExpiresAtUtc = DateTimeOffset.UtcNow + _options.ApprovalTtl,
            Reason = $"D-ASK asks to {(r.Kind == InputKind.Mouse ? "click a control" : r.Tool == GuardedInputTools.TypeText ? "type text into a control" : "press keys in a control")} of {target.ImageName}.",
        };

        await AuditAsync("DesktopInputRequested", request, ctx, r, control, "Pending", $"agent call {ctx.CallId}", target);
        var sw = Stopwatch.StartNew();
        ActionApprovalResponse decision = await _policy.RequestApprovalAsync(request, ct);
        long decidedMs = sw.ElapsedMilliseconds;
        if (ct.IsCancellationRequested) return DesktopCallResult.Cancelled();
        if (!decision.Approved)
        {
            var (code, message) = decision.DecisionSource switch
            {
                "UserExplicitConfirmation" => ("approval_denied", "You declined. Nothing was done."),
                "TimeoutDenied" => ("approval_expired", "The approval expired before a decision. Nothing was done."),
                "EmergencyStopDenied" or "StaleGenerationDenied" => ("emergency_stopped", "Emergency Stop cancelled the request. Nothing was done."),
                "SessionDisconnectedDenied" => ("hud_unavailable", "The HUD is not connected or not responding, so the request could not be approved. Nothing was done."),
                "IntegrityMismatch" => ("approval_refused", "The request could not be offered for approval exactly as it would be performed. Nothing was done."),
                _ => ("approval_denied", "The request was not approved. Nothing was done."),
            };
            return DesktopCallResult.Fail(code, message);
        }

        var (valid, error) = _policy.ValidateConsumedApproval(request.ApprovalId, request.ActionId, request.ActionType, parameters,
            request.TargetProcessName, request.TargetHwnd, request.TargetProcessId, request.TargetProcessCreationTime,
            ctx.OwnerSessionId, _generation(), _isStopped());
        if (!valid)
        {
            await AuditAsync("DesktopInputApprovalInvalid", request, ctx, r, control, "Refused", error ?? "invalid", target);
            return DesktopCallResult.Fail("approval_invalid", "The approval could not be validated. Nothing was done.");
        }
        if (WindowCheck(target) is { } wchanged)
        {
            await AuditAsync("DesktopInputTargetChanged", request, ctx, r, control, "Refused", wchanged.Message, target);
            return DesktopCallResult.Fail(wchanged.Code, $"You approved it, but {wchanged.Message}. Nothing was done.");
        }
        var insp2 = await Inspect(target.Hwnd, ct);
        if (ControlResolver.Revalidate(control, insp2, out var control2) is { } cchanged)
        {
            await AuditAsync("DesktopInputTargetChanged", request, ctx, r, control, "Refused", cchanged.Message, target);
            return DesktopCallResult.Fail(cchanged.Code, $"You approved it, but: {cchanged.Message} Nothing was done.");
        }
        if (!control2!.Bounds.AsSpan().SequenceEqual(control.Bounds))
        {
            await AuditAsync("DesktopInputTargetChanged", request, ctx, r, control, "Refused", "control moved", target);
            return DesktopCallResult.Fail("target_changed", "You approved it, but the control moved afterwards. Nothing was done.");
        }

        return await ExecuteApprovedAsync(request, ctx, r, target, control, insp2, decidedMs, ct);
    }

    public const string TitleFollowsContentKey = "titleNote";

    /// <summary>
    /// The title of a window that holds a document is "[*]<document> - <application>": typing changes the document part (and adds the
    /// unsaved marker) while the application part stays. True only when both titles end in the same non-trivial " - <application>".
    /// </summary>
    public static bool SameApplicationSuffix(string before, string after)
    {
        int a = before.LastIndexOf(" - ", StringComparison.Ordinal), b = after.LastIndexOf(" - ", StringComparison.Ordinal);
        if (a < 0 || b < 0) return false;
        var sa = before[(a + 3)..]; var sb = after[(b + 3)..];
        return sa.Length >= 3 && string.Equals(sa, sb, StringComparison.Ordinal);
    }

    /// <summary>Safety contracts §3.4: full identity, plus an unchanged title for input tools (D-3), except for a window D-ASK opened for this task (see <see cref="TitleFollowsContentKey"/>).</summary>
    private InputRefusal? WindowCheck(WindowIdentity target, bool titleMayFollowContent = false)
    {
        var now = _reader.ReadNow(target.Hwnd);
        if (WindowIdentityRules.Mismatch(target, now) is { } m) return new(now == null ? "target_disappeared" : "target_changed", $"the window changed ({m})");
        if (!string.Equals(now!.Title, target.Title, StringComparison.Ordinal) && !(titleMayFollowContent && SameApplicationSuffix(target.Title, now.Title)))
            return new("target_changed", "the window's title changed");
        if (now.Minimized) return new("target_unusable", "the window is minimized");
        return null;
    }

    private InputRefusal? CommonGate(ActionApprovalRequest request, WindowIdentity target, IUserInputMonitor monitor, CancellationToken ct)
    {
        if (ct.IsCancellationRequested) return new("cancelled", "The request was cancelled.");
        if (_isStopped()) return new("emergency_stopped", "Emergency Stop is active.");
        if (_generation() != request.StopGeneration) return new("emergency_stopped", "An Emergency Stop happened after the approval, so it no longer applies.");
        if (!_isSessionLive!(request.SessionId)) return new("hud_unavailable", "The HUD that approved this is no longer live.");
        if (monitor.Interruption is { } who) return new("user_interrupted", $"Stopped because {who}.");
        if (_platform.ForegroundRoot() != target.Hwnd) return new("foreground_changed", "The target window is no longer in front.");
        if (WindowCheck(target, request.ActionParameters.ContainsKey(TitleFollowsContentKey)) is { } w) return new(w.Code, $"Just before the input, {w.Message}.");
        return null;
    }

    private async Task<DesktopCallResult> ExecuteApprovedAsync(ActionApprovalRequest request, DesktopActionContext ctx, Request r, WindowIdentity target,
        ControlIdentity control, UiaInspection before, long decidedMs, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        try
        {
            await RecordRequiredAsync("DesktopInputExecutionAdmitted", request, ctx, r, control, "approval consumed; window and control revalidated", target);
        }
        catch (Exception ex)
        {
            _logger?.LogError(ex, "[DesktopInput] Write-ahead audit failed; refusing to act.");
            return DesktopCallResult.Fail("journal_unavailable", "The action could not be recorded before acting, so it was not performed. Nothing was done.");
        }

        IUserInputMonitor monitor;
        try { monitor = _platform.StartMonitor(); }
        catch (Exception ex)
        {
            await AuditAsync("DesktopInputExecutionRefused", request, ctx, r, control, "Refused", "input monitor unavailable", target);
            return DesktopCallResult.Fail("stop_path_unavailable", $"The safety monitor for this input could not start ({ex.Message}), so no input was sent. Nothing was done.");
        }

        SequenceOutcome outcome;
        string beforeSignature = ControlResolver.Signature(before);
        string valueBefore = "";
        var (cx, cy) = control.Center;
        try
        {
            if (_options.TestHookBeforeFirstEvent != null) await _options.TestHookBeforeFirstEvent();
            if (CommonGateNoForeground(request, target, monitor, ct) is { } g0)
            {
                await AuditAsync("DesktopInputExecutionRefused", request, ctx, r, control, "Refused", g0.Message, target);
                return DesktopCallResult.Fail(g0.Code, $"{g0.Message} Nothing was done.");
            }
            // Foreground once, then focus once for keyboard; both checked, neither retried. No input is sent for these.
            // ONE SetForegroundWindow call (never retried); activation of another process's window completes
            // asynchronously, so the result is then OBSERVED for a short while before any input is allowed.
            bool? fgCall = null;
            if (_platform.ForegroundRoot() != target.Hwnd) fgCall = _platform.BringToForeground(target.Hwnd);
            var fsw = Stopwatch.StartNew();
            while (_platform.ForegroundRoot() != target.Hwnd && fsw.ElapsedMilliseconds < 600)
            {
                try { await Task.Delay(20, ct); } catch (OperationCanceledException) { break; }
            }
            if (_platform.ForegroundRoot() != target.Hwnd)
            {
                _logger?.LogInformation("[DesktopInput] {Tool} for task {TaskId}: foreground not obtained (SetForegroundWindow returned {Result}; observed {Ms} ms).",
                    r.Tool, ctx.TaskId, fgCall?.ToString() ?? "not called", fsw.ElapsedMilliseconds);
                await AuditAsync("DesktopInputExecutionRefused", request, ctx, r, control, "Refused", "foreground not granted", target);
                return DesktopCallResult.Fail("foreground_denied", "Windows did not bring the window to the front, so no input was sent. Nothing was done.");
            }
            if (r.Kind == InputKind.Keyboard)
            {
                _platform.FocusElement(target.Hwnd, control.RuntimeId);
                if (_platform.FocusedRuntimeId() is not { } fid || !fid.AsSpan().SequenceEqual(control.RuntimeId))
                {
                    await AuditAsync("DesktopInputExecutionRefused", request, ctx, r, control, "Refused", "focus not on the control", target);
                    return DesktopCallResult.Fail("focus_denied", "The control did not take keyboard focus, so no keys were sent. Nothing was done.");
                }
                // Text entry is verified by exact insertion; a key chord on a value control by any change of its value
                // (password fields are refused before this point, so no secret is ever read).
                if (control.Patterns.Contains("Value")) valueBefore = _platform.ReadValue(target.Hwnd, control.RuntimeId).Value;
            }

            var steps = r.Tool switch
            {
                GuardedInputTools.ClickElement => GuardedInputSequencer.Click((cx, cy)),
                GuardedInputTools.TypeText => GuardedInputSequencer.Type(r.Text!),
                _ => GuardedInputSequencer.Chord(r.Chord!),
            };
            InputRefusal? Gate(int i)
            {
                if (CommonGate(request, target, monitor, ct) is { } g) return g;
                if (r.Kind == InputKind.Mouse)
                {
                    if (i != 1) return null; // the pointer move: common gate only
                    // Checked immediately before the button event, AFTER the pointer move: overlays such as the HUD stay
                    // hit-testable only while the pointer is over one of their controls (e.g. on APPROVE). The move presses nothing.
                    if (_platform.RootWindowAt(cx, cy) != target.Hwnd) return new("target_obscured", "Another window covers the control.");
                    if (_platform.CursorPos() is not { } p || Math.Abs(p.X - cx) > 1 || Math.Abs(p.Y - cy) > 1) return new("pointer_moved", "The pointer is not on the control.");
                    if (_platform.RuntimeIdAt(cx, cy) is not { } hit || !hit.AsSpan().SequenceEqual(control.RuntimeId)) return new("target_obscured", "The element under the pointer is not the approved control.");
                }
                else if (_platform.FocusedRuntimeId() is not { } f || !f.AsSpan().SequenceEqual(control.RuntimeId))
                    return new("focus_changed", "Keyboard focus left the approved control.");
                return null;
            }
            outcome = await GuardedInputSequencer.RunAsync(_platform.Injector, steps, Gate,
                r.Tool == GuardedInputTools.TypeText ? _options.InterEventDelayMs : r.Kind == InputKind.Mouse ? _options.PointerSettleMs : 0,
                _options.TestHookBetweenEvents, ct);
        }
        finally { monitor.Dispose(); }

        long executeMs = sw.ElapsedMilliseconds;
        await AuditAsync(outcome.AbortCode == null ? "DesktopInputSent" : "DesktopInputStopped", request, ctx, r, control,
            outcome.AbortCode == null ? "Executed" : "Stopped",
            $"{outcome.StepsSent}/{outcome.StepsTotal} steps{(outcome.AbortCode != null ? $"; stopped: {outcome.AbortCode}" : "")}{(outcome.ReleaseNeeded ? $"; release {(outcome.ReleaseSucceeded ? "ok" : "FAILED")}" : "")}", target);

        if (outcome.StepsSent == 0)
            return DesktopCallResult.Fail(outcome.AbortCode ?? "execution_failed", $"{outcome.AbortMessage} No input was sent. Nothing was done.");

        // Independent verification from a fresh observation.
        var vsw = Stopwatch.StartNew();
        bool verified = false; string observed = "no change observed";
        while (vsw.ElapsedMilliseconds < _options.VerifyTimeoutMs && !ct.IsCancellationRequested)
        {
            if (r.Tool == GuardedInputTools.TypeText)
            {
                var v = _platform.ReadValue(target.Hwnd, control.RuntimeId);
                if (v.Ok && TextRules.IsExactInsertion(valueBefore, v.Value, r.Text!)) { verified = true; observed = "the field now contains exactly the typed text, inserted once"; break; }
                if (v.Ok) observed = "the field's text does not show the typed text inserted exactly once";
            }
            else
            {
                if (r.Tool == GuardedInputTools.PressKeys && control.Patterns.Contains("Value")
                    && _platform.ReadValue(target.Hwnd, control.RuntimeId) is { Ok: true } kv && !string.Equals(kv.Value, valueBefore, StringComparison.Ordinal))
                { verified = true; observed = "the control's text changed after the keys"; break; }
                var now = await Inspect(target.Hwnd, ct);
                if (now.Status == "ok" && ControlResolver.Signature(now) != beforeSignature) { verified = true; observed = "the window's content changed after the input"; break; }
            }
            try { await Task.Delay(60, ct); } catch (OperationCanceledException) { break; }
        }
        long verifyMs = vsw.ElapsedMilliseconds;
        await AuditAsync(verified ? "DesktopInputVerified" : "DesktopInputUnverified", request, ctx, r, control, verified ? "Verified" : "Unverified", $"{observed}; verify {verifyMs} ms", target);
        _logger?.LogInformation("[DesktopInput] {Tool} for task {TaskId}: {Sent}/{Total} steps, stopped={Abort}, verified={Verified} ({Observed}) in {VerifyMs} ms.",
            r.Tool, ctx.TaskId, outcome.StepsSent, outcome.StepsTotal, outcome.AbortCode ?? "no", verified, observed, verifyMs);

        if (outcome.AbortCode != null)
            return DesktopCallResult.Fail(outcome.AbortCode, $"Stopped after {outcome.StepsSent} of {outcome.StepsTotal} input steps: {outcome.AbortMessage} It will not be retried.");
        if (!verified)
            return DesktopCallResult.Fail("execution_unverified", $"D-ASK sent the approved input once, but could not confirm its effect ({observed}). It will not be retried.");
        return DesktopCallResult.Ok(new
        {
            decision = "approved",
            approvalId = request.ApprovalId,
            actionType = request.ActionType,
            consumed = true,
            identityRevalidated = true,
            executed = true,
            verified = true,
            observed,
            control = new { controlType = control.ControlType, automationId = control.AutomationId, name = control.Name },
            keys = r.Chord?.Canonical,
            textLength = r.Text?.Length,
            target = new { process = target.ImageName, title = target.Title, pid = target.ProcessId },
            timings = new { decisionMs = decidedMs, executeMs, verifyMs },
        });
    }

    private InputRefusal? CommonGateNoForeground(ActionApprovalRequest request, WindowIdentity target, IUserInputMonitor monitor, CancellationToken ct)
    {
        if (ct.IsCancellationRequested) return new("cancelled", "The request was cancelled before the action.");
        if (_isStopped()) return new("emergency_stopped", "Emergency Stop is active.");
        if (_generation() != request.StopGeneration) return new("emergency_stopped", "An Emergency Stop happened after the approval, so it no longer applies.");
        if (!_isSessionLive!(request.SessionId)) return new("hud_unavailable", "The HUD that approved this is no longer live.");
        if (monitor.Interruption is { } who) return new("user_interrupted", $"Stopped because {who}.");
        return WindowCheck(target, request.ActionParameters.ContainsKey(TitleFollowsContentKey)) is { } w ? new(w.Code, $"Just before the input, {w.Message}.") : null;
    }

    private object Details(ActionApprovalRequest r, DesktopActionContext ctx, Request q, ControlIdentity c, WindowIdentity t) => new
    {
        actionType = r.ActionType, inputPolicy = q.Kind.ToString(), taskId = ctx.TaskId, callId = ctx.CallId, hwnd = t.Hwnd, pid = t.ProcessId,
        processCreationFileTime = t.ProcessCreationFileTime, image = AuditJson.Bound(t.ImagePath), windowClass = AuditJson.Bound(t.WindowClass), session = t.SessionId,
        controlType = c.ControlType, controlPath = c.ControlPathHash, keys = q.Chord?.Canonical,
        textLength = q.Text?.Length, textSha256 = q.Text != null ? TextRules.Sha256(q.Text) : null,   // never the text itself
    };

    private async Task RecordRequiredAsync(string evt, ActionApprovalRequest r, DesktopActionContext ctx, Request q, ControlIdentity c, string reason, WindowIdentity t)
    {
        if (_evidence == null) throw new InvalidOperationException("no audit journal");
        await _evidence.RecordSafetyAuditAsync(new SafetyAuditRecord
        {
            EventType = evt, Source = "GuardedInputRequestService", ActionId = r.ActionId, ApprovalId = r.ApprovalId, SessionId = r.SessionId,
            RiskLevel = r.RiskLevel, StopGeneration = r.StopGeneration, Decision = "Admitted", Reason = AuditJson.Bound(reason),
            DetailsJson = AuditJson.Details(Details(r, ctx, q, c, t)),
        });
    }

    private async Task AuditAsync(string evt, ActionApprovalRequest r, DesktopActionContext ctx, Request q, ControlIdentity c, string decision, string reason, WindowIdentity t)
    {
        if (_evidence == null) return;
        try
        {
            await _evidence.RecordSafetyAuditAsync(new SafetyAuditRecord
            {
                EventType = evt, Source = "GuardedInputRequestService", ActionId = r.ActionId, ApprovalId = r.ApprovalId, SessionId = r.SessionId,
                RiskLevel = r.RiskLevel, StopGeneration = r.StopGeneration, Decision = decision, Reason = AuditJson.Bound(reason),
                DetailsJson = AuditJson.Details(Details(r, ctx, q, c, t)),
            });
        }
        catch (Exception ex) { _logger?.LogWarning(ex, "[DesktopInput] Audit record {Event} failed.", evt); }
    }
}

/// <summary>Routes each agent tool to the service that owns it (window operations, guarded input).</summary>
public sealed class CompositeDesktopActionRequestService : IDesktopActionRequestService
{
    private readonly IDesktopActionRequestService[] _services;
    public CompositeDesktopActionRequestService(params IDesktopActionRequestService[] services)
    {
        _services = services;
        var dup = services.SelectMany(s => s.Tools).GroupBy(t => t).FirstOrDefault(g => g.Count() > 1);
        if (dup != null) throw new ArgumentException($"tool {dup.Key} is registered twice");
    }
    public IReadOnlyList<string> Tools => _services.SelectMany(s => s.Tools).ToArray();
    public int MaxCallMs => _services.Max(s => s.MaxCallMs);
    public Task<DesktopCallResult> ExecuteAsync(string tool, JsonElement args, DesktopActionContext ctx, CancellationToken ct) =>
        _services.FirstOrDefault(s => s.Tools.Contains(tool)) is { } owner
            ? owner.ExecuteAsync(tool, args, ctx, ct)
            : Task.FromResult(DesktopCallResult.Fail("unknown_tool", "This operation is not available."));
}
