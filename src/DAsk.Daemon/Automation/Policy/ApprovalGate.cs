using System.Diagnostics;
using DAsk.Daemon.Automation.Desktop;
using DAsk.Daemon.Research;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Extensions.Logging;

namespace DAsk.Daemon.Automation.Policy;

/// <summary>
/// The approval pathway shared by the daemon's non-window actions (clipboard, Windows administration, Chrome session, code edits), the
/// same sequence DevTaskService uses: owner HUD present → not stopped → policy says Elevated → requested (audited) → the owner's HUD
/// approves the exact canonical parameters → still not stopped, same stop generation → the approval is validated and consumed once →
/// the HUD lease is live → a write-ahead "admitted" audit record is written (none, no action). Callers then act once and verify.
/// </summary>
public sealed class ApprovalGate
{
    private readonly ActionPolicyEngine _policy;
    private readonly Func<bool> _isStopped;
    private readonly Func<ulong> _generation;
    private readonly IEvidenceRecorder? _evidence;
    private readonly Func<string, bool>? _isSessionLive;
    private readonly ILogger? _logger;
    private readonly string _source;

    public ApprovalGate(ActionPolicyEngine policy, Func<bool> isStopped, Func<ulong> generation, IEvidenceRecorder? evidence, Func<string, bool>? isSessionLive, string source, ILogger? logger = null)
    {
        _policy = policy; _isStopped = isStopped; _generation = generation; _evidence = evidence; _isSessionLive = isSessionLive; _source = source; _logger = logger;
    }

    /// <summary>Whether actions can be approved at all (an audit journal and a HUD lease check are required).</summary>
    public bool Available => _evidence != null && _isSessionLive != null;
    public bool Stopped => _isStopped();
    /// <summary>True while no Emergency Stop happened since the approval was asked for.</summary>
    public bool StillValid(ActionApprovalRequest r) => !_isStopped() && _generation() == r.StopGeneration;

    public static TimeSpan DefaultTtl => TimeSpan.FromSeconds(60);

    public async Task<(ActionApprovalRequest? Request, DesktopCallResult? Refusal)> RequestAsync(string actionType, Dictionary<string, string> parameters,
        string targetName, string targetTitle, string reason, DesktopActionContext ctx, CancellationToken ct, TimeSpan? ttl = null)
    {
        if (!Available) return (null, DesktopCallResult.Fail("unavailable", "No approval journal or HUD lease is available, so nothing can be approved. Nothing was done."));
        if (string.IsNullOrWhiteSpace(ctx.OwnerSessionId)) return (null, DesktopCallResult.Fail("no_owner", "The task has no owning HUD session, so nobody can approve this."));
        if (_isStopped()) return (null, DesktopCallResult.Fail("emergency_stopped", "Emergency Stop is active; nothing can be requested."));
        var (allowed, risk, why) = _policy.EvaluatePolicy(actionType, new Dictionary<string, string>(), targetName);
        if (allowed || risk != ActionRiskLevel.Elevated) return (null, DesktopCallResult.Fail("policy_denied", $"The policy does not permit this request ({why})."));
        using var self = Process.GetCurrentProcess();
        var started = new DateTimeOffset(self.StartTime.ToUniversalTime(), TimeSpan.Zero);
        var life = ttl ?? DefaultTtl;
        if (life > ActionPolicyEngine.MaxApprovalTtl) life = ActionPolicyEngine.MaxApprovalTtl;
        var request = new ActionApprovalRequest
        {
            ApprovalId = Guid.NewGuid().ToString("N"), ActionId = Guid.NewGuid().ToString("N"), ActionType = actionType, ActionParameters = parameters,
            TargetProcessName = targetName, TargetWindowTitle = targetTitle, TargetHwnd = 0, TargetProcessId = self.Id, TargetProcessCreationTime = started,
            SessionId = ctx.OwnerSessionId, StopGeneration = _generation(), RiskLevel = risk.ToString(),
            CreatedAtUtc = DateTimeOffset.UtcNow, ExpiresAtUtc = DateTimeOffset.UtcNow + life, Reason = reason,
        };
        await AuditAsync("Requested", request, ctx, $"agent call {ctx.CallId}");
        var decision = await _policy.RequestApprovalAsync(request, ct);
        if (ct.IsCancellationRequested) return (null, DesktopCallResult.Cancelled());
        if (!decision.Approved)
        {
            await AuditAsync("NotApproved", request, ctx, decision.DecisionSource ?? "denied");
            var (code, message) = decision.DecisionSource switch
            {
                "UserExplicitConfirmation" => ("approval_denied", "You declined. Nothing was done."),
                "TimeoutDenied" => ("approval_expired", "The approval expired before a decision. Nothing was done."),
                "EmergencyStopDenied" or "StaleGenerationDenied" => ("emergency_stopped", "Emergency Stop cancelled the request. Nothing was done."),
                "SessionDisconnectedDenied" => ("hud_unavailable", "The HUD is not connected or not responding, so the request could not be approved. Nothing was done."),
                _ => ("approval_denied", "The request was not approved. Nothing was done."),
            };
            return (null, DesktopCallResult.Fail(code, message));
        }
        if (!StillValid(request)) return (null, DesktopCallResult.Fail("emergency_stopped", "An Emergency Stop happened after the approval, so it no longer applies. Nothing was done."));
        var (valid, error) = _policy.ValidateConsumedApproval(request.ApprovalId, request.ActionId, request.ActionType, parameters, request.TargetProcessName, 0, self.Id, started,
            ctx.OwnerSessionId, _generation(), _isStopped());
        if (!valid) { await AuditAsync("ApprovalInvalid", request, ctx, error ?? "invalid"); return (null, DesktopCallResult.Fail("approval_invalid", "The approval could not be validated. Nothing was done.")); }
        if (!_isSessionLive!(request.SessionId)) return (null, DesktopCallResult.Fail("hud_unavailable", "The HUD that approved this is no longer live. Nothing was done."));
        try
        {
            await _evidence!.RecordSafetyAuditAsync(new SafetyAuditRecord
            {
                EventType = $"{_source}Admitted", Source = _source, ActionId = request.ActionId, ApprovalId = request.ApprovalId, SessionId = request.SessionId,
                RiskLevel = request.RiskLevel, StopGeneration = request.StopGeneration, Decision = "Admitted", Reason = "approval consumed once",
                DetailsJson = AuditJson.Details(new { taskId = ctx.TaskId, actionType, target = targetName }),
            });
        }
        catch (Exception ex)
        {
            _logger?.LogError(ex, "[{Source}] Write-ahead audit failed; refusing to act.", _source);
            return (null, DesktopCallResult.Fail("journal_unavailable", "The action could not be recorded before acting, so it was not performed. Nothing was done."));
        }
        return (request, null);
    }

    public async Task AuditAsync(string evt, ActionApprovalRequest q, DesktopActionContext ctx, string reason)
    {
        if (_evidence == null) return;
        try
        {
            await _evidence.RecordSafetyAuditAsync(new SafetyAuditRecord
            {
                EventType = _source + evt, Source = _source, ActionId = q.ActionId, ApprovalId = q.ApprovalId, SessionId = q.SessionId, RiskLevel = q.RiskLevel,
                StopGeneration = q.StopGeneration, Decision = evt, Reason = AuditJson.Bound(reason),
                DetailsJson = AuditJson.Details(new { taskId = ctx.TaskId, actionType = q.ActionType, target = q.TargetProcessName }),
            });
        }
        catch (Exception ex) { _logger?.LogWarning(ex, "[{Source}] Audit record {Event} failed.", _source, evt); }
    }
}
