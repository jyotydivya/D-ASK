using System.Diagnostics;
using System.Text.Json;
using DAsk.Daemon.Automation.Observation;
using DAsk.Daemon.Automation.Policy;
using DAsk.Daemon.Research;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Extensions.Logging;

namespace DAsk.Daemon.Automation.Desktop;

/// <summary>Who is asking: the agent task and its call, and the HUD session that owns the task (from the daemon's task record).</summary>
public sealed record DesktopActionContext(string TaskId, string CallId, string OwnerSessionId);

/// <summary>Phase 7B.2: agent requests for window operations that need the user's approval.</summary>
public interface IDesktopActionRequestService
{
    IReadOnlyList<string> Tools { get; }
    /// <summary>Longest a call may wait (the approval's lifetime plus validation).</summary>
    int MaxCallMs { get; }
    Task<DesktopCallResult> ExecuteAsync(string tool, JsonElement args, DesktopActionContext ctx, CancellationToken ct);
}

public sealed class DesktopActionOptions
{
    /// <summary>How long the user has to decide. The policy engine clamps it to 30 s regardless.</summary>
    public TimeSpan ApprovalTtl { get; init; } = TimeSpan.FromSeconds(30);

    /// <summary>
    /// Phase 7B.3: perform the approved operation (one Win32 call) and verify it. Disabled by default (safety contracts
    /// §10): when false the pathway is approval-only, exactly as in Phase 7B.2. Enabled by AgentHost:DesktopActionExecution.
    /// </summary>
    public bool ExecutionEnabled { get; init; } = false;

    /// <summary>How long the independent observation may take to show the approved result.</summary>
    public int VerifyTimeoutMs { get; init; } = 2000;

    /// <summary>TESTS ONLY: runs after the write-ahead audit record and before the final gate (to trip stop, cancel,
    /// epoch or liveness exactly in that window). Never set in production.</summary>
    public Func<Task>? TestHookBeforeFinalGate { get; init; }
}

/// <summary>
/// Phase 7B.2: the production-connected approval pathway for window operations, with NO executor.
///
///   agent call → strict args → Emergency Stop check → daemon resolves the target from the OS (same rules as the
///   read-only tools; the agent never supplies an HWND or PID) → policy (Elevated, approval required) → the exact
///   canonical action, bound to the full identity, is registered with the policy engine, which delivers it to the
///   task owner's HUD only → the user's explicit decision is validated by the policy engine (owner session, liveness,
///   expiry, Emergency Stop, epoch, digest) → on approval the grant is consumed exactly once and the target's identity is
///   re-read from the OS → the agent is told the action was approved and NOT performed.
///
/// Phase 7B.3: when execution is enabled (AgentHost:DesktopActionExecution, off by default in code), the daemon then
/// writes a write-ahead audit record, passes a final gate (cancellation, Emergency Stop latch, epoch, owner HUD lease, OS
/// identity), makes exactly ONE Win32 call through <see cref="IWindowOperationExecutor"/>, and verifies the result with a
/// fresh observation; success is reported only when verified. When disabled, the agent is told the action was approved
/// and NOT performed (the line above). This class sends no keyboard or mouse input.
/// </summary>
public sealed class DesktopActionRequestService : IDesktopActionRequestService
{
    public const string FocusWindowTool = "desktop.focus_window";
    public const string SetWindowStateTool = "desktop.set_window_state";
    public const string NotPerformed =
        "Not performed: D-ASK cannot act on windows in this version. Approving records your consent to this one action; nothing on screen changes.";
    public const string Performed =
        "Performed once, right after your approval, on exactly this window (checked again first); the result is then verified. Nothing else is done.";

    private static readonly HashSet<string> States = new(StringComparer.Ordinal) { "minimize", "maximize", "restore" };

    private readonly DesktopReadService _reader;
    private readonly ActionPolicyEngine _policy;
    private readonly Func<bool> _isStopped;
    private readonly Func<ulong> _generation;
    private readonly IEvidenceRecorder? _evidence;
    private readonly DesktopActionOptions _options;
    private readonly ILogger? _logger;
    private readonly IWindowOperationExecutor? _executor;
    private readonly Func<string, bool>? _isSessionLive;

    public DesktopActionRequestService(DesktopReadService reader, ActionPolicyEngine policy, Func<bool> isStopped, Func<ulong> generation,
        IEvidenceRecorder? evidence = null, DesktopActionOptions? options = null, ILogger? logger = null,
        IWindowOperationExecutor? executor = null, Func<string, bool>? isSessionLive = null)
    {
        _reader = reader;
        _policy = policy;
        _isStopped = isStopped;
        _generation = generation;
        _evidence = evidence;
        _options = options ?? new DesktopActionOptions();
        _logger = logger;
        _executor = executor;
        _isSessionLive = isSessionLive;
    }

    /// <summary>Execution needs the switch, an executor, the audit journal (write-ahead) and a liveness source.</summary>
    private bool ExecutionReady => _options.ExecutionEnabled && _executor != null && _evidence != null && _isSessionLive != null;

    public IReadOnlyList<string> Tools { get; } = new[] { FocusWindowTool, SetWindowStateTool };
    public int MaxCallMs => (int)Math.Min(_options.ApprovalTtl.TotalMilliseconds, ActionPolicyEngine.MaxApprovalTtl.TotalMilliseconds) + 5_000;

    private sealed record Request(string ActionType, string? Process, string? TitleContains, string? State);

    private static string? Parse(string tool, JsonElement args, out Request req)
    {
        req = null!;
        if (args.ValueKind != JsonValueKind.Object) return "arguments must be an object";
        string? process = null, title = null, state = null;
        bool stateTool = tool == SetWindowStateTool;
        foreach (var p in args.EnumerateObject())
        {
            switch (p.Name)
            {
                case "process":
                    if (p.Value.ValueKind != JsonValueKind.String) return "process must be text";
                    process = p.Value.GetString()!.Trim();
                    break;
                case "titleContains":
                    if (p.Value.ValueKind != JsonValueKind.String) return "titleContains must be text";
                    title = p.Value.GetString()!;
                    break;
                case "state" when stateTool:
                    if (p.Value.ValueKind != JsonValueKind.String || !States.Contains(p.Value.GetString()!)) return "state must be minimize, maximize or restore";
                    state = p.Value.GetString();
                    break;
                default:
                    // No hwnd, pid, session, approval, digest or "approved" is ever accepted from the agent.
                    return $"unknown argument '{(p.Name.Length > 40 ? p.Name[..40] : p.Name)}'";
            }
        }
        if (DesktopReadService.ValidateSelector(process, title) is { } bad) return bad;
        if (stateTool && state == null) return "state is required (minimize, maximize or restore)";
        req = new Request(stateTool ? DesktopActionTypes.SetWindowState : DesktopActionTypes.FocusWindow, process, title, state);
        return null;
    }

    private static (string Verb, string Operation, string Reversible) Describe(Request r) => (r.ActionType, r.State) switch
    {
        (DesktopActionTypes.FocusWindow, _) => ("bring to the front", "Bring this window to the front (focus it)",
            "Yes: you can switch back to any other window at any time."),
        (_, "minimize") => ("minimize", "Minimize this window", "Yes: the window can be restored from the taskbar."),
        (_, "maximize") => ("maximize", "Maximize this window", "Yes: the window can be restored to its previous size."),
        _ => ("restore", "Restore this window (neither minimized nor maximized)", "Yes: the window can be minimized or maximized again."),
    };

    public async Task<DesktopCallResult> ExecuteAsync(string tool, JsonElement args, DesktopActionContext ctx, CancellationToken ct)
    {
        try { return await RunAsync(tool, args, ctx, ct); }
        catch (OperationCanceledException) { return DesktopCallResult.Cancelled(); }
    }

    private async Task<DesktopCallResult> RunAsync(string tool, JsonElement args, DesktopActionContext ctx, CancellationToken ct)
    {
        if (tool is not (FocusWindowTool or SetWindowStateTool)) return DesktopCallResult.Fail("unknown_tool", "This operation is not available.");
        if (Parse(tool, args, out var r) is { } bad) return DesktopCallResult.Fail("invalid_args", bad);
        if (string.IsNullOrWhiteSpace(ctx.OwnerSessionId)) return DesktopCallResult.Fail("no_owner", "The task has no owning HUD session, so nobody can approve this.");
        if (_isStopped()) return DesktopCallResult.Fail("emergency_stopped", "Emergency Stop is active; no action can be requested.");

        // The target comes from the OS, never from the agent.
        if (_reader.ResolveTarget(r.Process, r.TitleContains, "acted on", out var target) is { } notResolved) return notResolved;
        if (WindowIdentityRules.Incomplete(target!) is { } why)
            return DesktopCallResult.Fail("identity_uncertain", $"The window's identity cannot be established ({why}); nothing can be requested for it.");

        var (allowed, risk, policyReason) = _policy.EvaluatePolicy(r.ActionType, new Dictionary<string, string>(), target!.ImageName);
        if (allowed || risk != ActionRiskLevel.Elevated)
            return DesktopCallResult.Fail("policy_denied", $"The policy does not permit this request ({policyReason}).");

        var (verb, operation, reversible) = Describe(r);
        var created = DateTime.FromFileTimeUtc(target.ProcessCreationFileTime);
        var parameters = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["operation"] = operation,
            ["window"] = target.Title,
            ["application"] = target.ImageName,
            ["imagePath"] = target.ImagePath,
            ["windowClass"] = target.WindowClass,
            ["processStarted"] = created.ToString("O"),
            ["logonSession"] = target.SessionId.ToString(),
            ["display"] = $"display {target.DisplayIndex + 1}{(target.DisplayIsPrimary ? " (primary)" : "")}, {target.Dpi} DPI",
            ["reversible"] = reversible,
            // What the user is told is exactly what will happen: bound into the digest like every other parameter.
            ["execution"] = ExecutionReady ? Performed : NotPerformed,
        };
        if (r.State != null) parameters["state"] = r.State;

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
            // No window title here: the reason is written to the audit trail, and titles can be personal. The HUD shows the
            // title from the target and the "window" parameter, both bound into the digest.
            Reason = Bounded($"D-ASK asks to {verb} a window of {target.ImageName}.", 500),
        };

        await AuditAsync("DesktopActionRequested", request, ctx, "Pending", $"agent call {ctx.CallId}", target);
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
                "IntegrityMismatch" => ("approval_refused", $"The request could not be offered for approval exactly as it would be performed ({Bounded(decision.RejectionReason ?? "", 200)}). Nothing was done."),
                _ => ("approval_denied", "The request was not approved. Nothing was done."),
            };
            return DesktopCallResult.Fail(code, message);
        }

        // Approved and validated by the policy engine. Consume the grant exactly once (it can never be used again),
        // with the daemon-held canonical action, then re-read the target from the OS.
        var (valid, error) = _policy.ValidateConsumedApproval(request.ApprovalId, request.ActionId, request.ActionType, parameters,
            request.TargetProcessName, request.TargetHwnd, request.TargetProcessId, request.TargetProcessCreationTime,
            ctx.OwnerSessionId, _generation(), _isStopped());
        if (!valid)
        {
            await AuditAsync("DesktopActionApprovalInvalid", request, ctx, "Refused", error ?? "invalid", target);
            return DesktopCallResult.Fail("approval_invalid", $"The approval could not be validated ({Bounded(error ?? "", 200)}). Nothing was done.");
        }
        var now = _reader.ReadNow(target.Hwnd);
        if (WindowIdentityRules.Mismatch(target, now) is { } changed)
        {
            await AuditAsync("DesktopActionTargetChanged", request, ctx, "Refused", changed, target);
            return DesktopCallResult.Fail(now == null ? "target_disappeared" : "target_changed",
                $"You approved it, but the window changed afterwards ({changed}). Nothing was done.");
        }

        if (ExecutionReady) return await ExecuteApprovedAsync(request, ctx, target, r.State, decidedMs, ct);

        await AuditAsync("DesktopActionApprovedNotExecuted", request, ctx, "Approved", "approval consumed; Phase 7B.2 has no executor", target);
        _logger?.LogInformation("[DesktopAction] {ActionType} for task {TaskId} approved and consumed; not executed (no executor in this version).", request.ActionType, ctx.TaskId);
        return DesktopCallResult.Ok(new
        {
            decision = "approved",
            approvalId = request.ApprovalId,
            actionType = request.ActionType,
            state = r.State,
            consumed = true,
            identityRevalidated = true,
            executed = false,
            executionAvailable = false,
            target = new { process = target.ImageName, title = now!.Title, pid = target.ProcessId },
            decisionMs = decidedMs,
            note = NotPerformed,
        });
    }

    /// <summary>
    /// Phase 7B.3: performs the approved, consumed, revalidated operation once and verifies it independently.
    /// Order: write-ahead audit (awaited; none, no action) → final gate (cancellation, Emergency Stop latch, epoch,
    /// owner HUD lease, OS identity) → one Win32 call → audit → fresh observation until the approved state is seen or
    /// the verification window ends. Success is reported only when the observation confirms it. Nothing is retried.
    /// </summary>
    private async Task<DesktopCallResult> ExecuteApprovedAsync(ActionApprovalRequest request, DesktopActionContext ctx, WindowIdentity target,
        string? state, long decidedMs, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        try
        {
            await RecordRequiredAsync("DesktopActionExecutionAdmitted", request, ctx, "Admitted", "approval consumed and target revalidated; executing once", target);
        }
        catch (Exception ex)
        {
            _logger?.LogError(ex, "[DesktopAction] Write-ahead audit failed; refusing to act.");
            return DesktopCallResult.Fail("journal_unavailable", "The action could not be recorded before acting, so it was not performed. Nothing was done.");
        }
        if (_options.TestHookBeforeFinalGate != null) await _options.TestHookBeforeFinalGate();

        // Final gate, immediately before the single event.
        if (FinalGate(request, target, ct) is { } gate)
        {
            await AuditAsync("DesktopActionExecutionRefused", request, ctx, "Refused", gate.Message, target);
            return DesktopCallResult.Fail(gate.Code, $"{gate.Message} Nothing was done.");
        }
        long admitToExecuteMs = sw.ElapsedMilliseconds;
        WindowOperationAttempt attempt;
        try { attempt = _executor!.Apply(target.Hwnd, request.ActionType, state); }
        catch (Exception ex)
        {
            await AuditAsync("DesktopActionExecutionFailed", request, ctx, "Failed", ex.GetType().Name, target);
            return DesktopCallResult.Fail("execution_failed", "The window operation could not be performed. It will not be retried.");
        }
        long executeMs = sw.ElapsedMilliseconds - admitToExecuteMs;
        await AuditAsync("DesktopActionExecuted", request, ctx, attempt.Called ? "Executed" : "NotExecuted",
            $"{attempt.Api} returned {attempt.ApiResult} (Win32 error {attempt.LastError})", target);
        if (!attempt.Called)
            return DesktopCallResult.Fail("execution_failed", "The approved operation is not one the executor can perform. Nothing was done.");

        // Independent verification: a fresh read of the same window from the OS.
        var vsw = Stopwatch.StartNew();
        (bool Verified, string Observed) v;
        bool cancelled = false;
        while (true)
        {
            v = WindowOperationVerifier.Check(request.ActionType, state, target, _reader.ReadNow(target.Hwnd));
            if (v.Verified) break;
            if (ct.IsCancellationRequested) { cancelled = true; break; }
            if (vsw.ElapsedMilliseconds >= _options.VerifyTimeoutMs) break;
            try { await Task.Delay(50, ct); } catch (OperationCanceledException) { cancelled = true; break; }
        }
        long verifyMs = vsw.ElapsedMilliseconds;
        await AuditAsync(v.Verified ? "DesktopActionVerified" : "DesktopActionUnverified", request, ctx, v.Verified ? "Verified" : "Unverified",
            $"{v.Observed}; verify {verifyMs} ms{(cancelled ? "; cancelled" : "")}", target);
        _logger?.LogInformation("[DesktopAction] {ActionType} {State} for task {TaskId}: {Api} -> {ApiResult}; verified={Verified} ({Observed}) in {VerifyMs} ms.",
            request.ActionType, state, ctx.TaskId, attempt.Api, attempt.ApiResult, v.Verified, v.Observed, verifyMs);

        string what = DescribeDone(request.ActionType, state);
        if (!v.Verified)
        {
            if (cancelled)
                return DesktopCallResult.Fail("cancelled_after_execution", $"D-ASK {what} once, but the check was cancelled, so the result is not confirmed ({v.Observed}). It will not be retried.");
            return DesktopCallResult.Fail("execution_unverified",
                $"D-ASK asked Windows to {VerbFor(request.ActionType, state)} the window once, but could not confirm it happened ({v.Observed}; {attempt.Api} returned {attempt.ApiResult}). It will not be retried.");
        }
        var final = _reader.ReadNow(target.Hwnd);
        return DesktopCallResult.Ok(new
        {
            decision = "approved",
            approvalId = request.ApprovalId,
            actionType = request.ActionType,
            state,
            consumed = true,
            identityRevalidated = true,
            executed = true,
            executionAvailable = true,
            verified = true,
            observed = v.Observed,
            api = attempt.Api,
            target = new { process = target.ImageName, title = final?.Title ?? target.Title, pid = target.ProcessId },
            timings = new { decisionMs = decidedMs, admitToExecuteMs, executeMs, verifyMs },
        });
    }

    private sealed record GateFailure(string Code, string Message);

    private GateFailure? FinalGate(ActionApprovalRequest request, WindowIdentity target, CancellationToken ct)
    {
        if (ct.IsCancellationRequested) return new("cancelled", "The request was cancelled before the action.");
        if (_isStopped()) return new("emergency_stopped", "Emergency Stop is active.");
        if (_generation() != request.StopGeneration) return new("emergency_stopped", "An Emergency Stop happened after the approval, so it no longer applies.");
        if (!_isSessionLive!(request.SessionId)) return new("hud_unavailable", "The HUD that approved this is no longer live.");
        var now = _reader.ReadNow(target.Hwnd);
        if (WindowIdentityRules.Mismatch(target, now) is { } changed)
            return new(now == null ? "target_disappeared" : "target_changed", $"The window changed just before the action ({changed}).");
        return null;
    }

    private static string VerbFor(string actionType, string? state) => actionType == DesktopActionTypes.FocusWindow ? "bring to the front" : state ?? "change";
    private static string DescribeDone(string actionType, string? state) => actionType == DesktopActionTypes.FocusWindow
        ? "asked Windows to bring the window to the front"
        : state switch { "minimize" => "minimized the window", "maximize" => "maximized the window", _ => "restored the window" };

    /// <summary>Like <see cref="AuditAsync"/> but throws: used for the write-ahead record that must exist before acting.</summary>
    private async Task RecordRequiredAsync(string evt, ActionApprovalRequest r, DesktopActionContext ctx, string decision, string reason, WindowIdentity t)
    {
        if (_evidence == null) throw new InvalidOperationException("no audit journal");
        await _evidence.RecordSafetyAuditAsync(new SafetyAuditRecord
        {
            EventType = evt, Source = "DesktopActionRequestService", ActionId = r.ActionId, ApprovalId = r.ApprovalId, SessionId = r.SessionId,
            RiskLevel = r.RiskLevel, StopGeneration = r.StopGeneration, Decision = decision, Reason = AuditJson.Bound(reason),
            DetailsJson = AuditJson.Details(new
            {
                actionType = r.ActionType, taskId = ctx.TaskId, callId = ctx.CallId, hwnd = t.Hwnd, pid = t.ProcessId,
                processCreationFileTime = t.ProcessCreationFileTime, image = AuditJson.Bound(t.ImagePath), windowClass = AuditJson.Bound(t.WindowClass), session = t.SessionId,
            }),
        });
    }

    private static string Bounded(string s, int n) => s.Length <= n ? s : s[..n] + "…";

    private async Task AuditAsync(string evt, ActionApprovalRequest r, DesktopActionContext ctx, string decision, string reason, WindowIdentity t)
    {
        if (_evidence == null) return;
        try
        {
            await _evidence.RecordSafetyAuditAsync(new SafetyAuditRecord
            {
                EventType = evt,
                Source = "DesktopActionRequestService",
                ActionId = r.ActionId,
                ApprovalId = r.ApprovalId,
                SessionId = r.SessionId,
                RiskLevel = r.RiskLevel,
                StopGeneration = r.StopGeneration,
                Decision = decision,
                Reason = AuditJson.Bound(reason),
                DetailsJson = AuditJson.Details(new
                {
                    actionType = r.ActionType,
                    taskId = ctx.TaskId,
                    callId = ctx.CallId,
                    hwnd = t.Hwnd,
                    pid = t.ProcessId,
                    processCreationFileTime = t.ProcessCreationFileTime,
                    image = AuditJson.Bound(t.ImagePath),
                    windowClass = AuditJson.Bound(t.WindowClass),
                    session = t.SessionId,
                }),
            });
        }
        catch (Exception ex) { _logger?.LogWarning(ex, "[DesktopAction] Audit record {Event} failed.", evt); }
    }
}
