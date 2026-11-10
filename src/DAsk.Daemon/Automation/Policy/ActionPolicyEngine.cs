using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using DAsk.Daemon.Research;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Extensions.Logging;

namespace DAsk.Daemon.Automation.Policy;

public enum ActionRiskLevel
{
    Observation = 0,
    LowRisk = 1,
    Elevated = 2,
    Critical = 3
}

public class CachedApproval
{
    public required ActionApprovalRequest Request { get; init; }
    public TaskCompletionSource<ActionApprovalResponse> CompletionSource { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public CancellationTokenSource ExpirationCts { get; } = new();
}

public sealed record GrantedApprovalRecord
{
    public required string ApprovalId { get; init; }
    public required string ActionId { get; init; }
    public required string ActionType { get; init; }
    public required Dictionary<string, string> CanonicalParameters { get; init; }
    public required string ParametersSha256 { get; init; }
    public required long TargetHwnd { get; init; }
    public required int TargetProcessId { get; init; }
    public required string TargetProcessName { get; init; }
    public required DateTimeOffset? TargetProcessCreationTime { get; init; }
    public required ActionRiskLevel RiskLevel { get; init; }
    public required string SessionId { get; init; }
    public required ulong StopGeneration { get; init; }
    public required DateTimeOffset CreatedAtUtc { get; init; }
    public required DateTimeOffset ExpiresAtUtc { get; init; }
}

public class ActionPolicyEngine
{
    private readonly ILogger<ActionPolicyEngine> _logger;
    private readonly IEvidenceRecorder? _evidenceRecorder;

    private readonly ConcurrentDictionary<string, CachedApproval> _pendingApprovals = new();
    private readonly ConcurrentDictionary<string, GrantedApprovalRecord> _grantedApprovals = new();
    private readonly ConcurrentDictionary<string, DateTimeOffset> _consumedApprovals = new();
    private static readonly TimeSpan DefaultTtl = TimeSpan.FromSeconds(30);

    /// <summary>The longest an approval may stay pending, whatever the caller asks for (Phase 7B.1a).</summary>
    public static readonly TimeSpan MaxApprovalTtl = TimeSpan.FromSeconds(30);

    // Terminal states of recently finished approvals, so a late or duplicate decision gets a precise answer.
    private readonly ConcurrentDictionary<string, (string State, DateTimeOffset At)> _recentTerminal = new();
    private const int MaxRecentTerminal = 512;

    private Func<string, bool>? _isSessionLive;

    public int PendingApprovalCount => _pendingApprovals.Count;
    public int GrantedApprovalCount => _grantedApprovals.Count;

    /// <summary>A normalised, daemon-built request was registered and must be shown to its owner session only.</summary>
    public event EventHandler<ActionApprovalRequest>? ApprovalRequested;

    /// <summary>(target session, notification): an approval changed state, or a decision was refused.</summary>
    public event EventHandler<(string SessionId, ApprovalStateNotification Notification)>? ApprovalStateChanged;

    public ActionPolicyEngine(ILogger<ActionPolicyEngine> logger, IEvidenceRecorder? evidenceRecorder = null)
    {
        _logger = logger;
        _evidenceRecorder = evidenceRecorder;
    }

    /// <summary>
    /// Installs the HUD liveness check (Phase 7B.1a). When set, an approval is neither registered for nor decided by a
    /// session that is not live. The pipe server installs it in production; unit tests may leave it unset.
    /// </summary>
    public void SetSessionLivenessGate(Func<string, bool> isSessionLive) => _isSessionLive = isSessionLive;

    /// <summary>The daemon-normalised request of a pending approval (read-only snapshot), or false.</summary>
    public bool TryGetPendingRequest(string approvalId, out ActionApprovalRequest request)
    {
        if (_pendingApprovals.TryGetValue(approvalId, out var cached)) { request = cached.Request; return true; }
        request = null!;
        return false;
    }

    /// <summary>
    /// SHA-256 of the parameters in DASK-CJ-1 canonical form (an object of string values, ordinal key order), with the
    /// <see cref="CanonicalJson.ParametersDomain"/> tag. Injective: different parameter sets never share a hash.
    /// Throws <see cref="CanonicalEncodingException"/> for values that cannot be encoded exactly (e.g. unpaired surrogates).
    /// </summary>
    public static string ComputeCanonicalHash(Dictionary<string, string>? parameters)
    {
        var map = parameters?.ToDictionary(kv => kv.Key, kv => (string?)kv.Value, StringComparer.Ordinal);
        return CanonicalJson.Digest(CanonicalJson.ParametersDomain, CanonicalJson.EncodeStringMap(map));
    }

    private static bool TryComputeCanonicalHash(Dictionary<string, string>? parameters, out string hash)
    {
        try { hash = ComputeCanonicalHash(parameters); return true; }
        catch (CanonicalEncodingException) { hash = string.Empty; return false; }
    }

    private static readonly System.Text.RegularExpressions.Regex ActionTypePattern = new(@"^[A-Za-z][A-Za-z0-9_.]{0,63}$");
    private static readonly System.Text.RegularExpressions.Regex ParameterNamePattern = new(@"^[A-Za-z][A-Za-z0-9_.\-]{0,63}$");
    private static readonly System.Text.RegularExpressions.Regex SecretNamePattern =
        new(@"pass(word|wd|phrase)?|secret|token|api[_.\-]?key|credential|\bpin\b|otp|private[_.\-]?key", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    public const int MaxDisplayParameters = 32;
    public const int MaxParameterValueChars = 2000;

    /// <summary>
    /// Whether the operation can be shown to the user exactly as it will be authorized. Anything that could not be
    /// displayed faithfully (control characters, oversized values, unencodable text) or that names a secret is refused:
    /// an approval the user cannot read is never offered.
    /// </summary>
    public static string? ValidateRepresentable(ActionApprovalRequest r)
    {
        if (!ActionTypePattern.IsMatch(r.ActionType ?? string.Empty)) return "the action type is not a recognised name";
        var p = r.ActionParameters ?? new Dictionary<string, string>();
        if (p.Count > MaxDisplayParameters) return $"more than {MaxDisplayParameters} parameters";
        foreach (var (key, value) in p)
        {
            if (!ParameterNamePattern.IsMatch(key)) return "a parameter name cannot be displayed";
            if (SecretNamePattern.IsMatch(key)) return $"parameter '{key}' looks like a secret and is never shown or approved";
            if (value is null) return $"parameter '{key}' has no value";
            if (value.Length > MaxParameterValueChars) return $"parameter '{key}' is longer than {MaxParameterValueChars} characters";
            if (!DisplayableText(value, allowLineBreaks: true)) return $"parameter '{key}' contains characters that cannot be displayed";
        }
        if (!DisplayableText(r.TargetProcessName ?? string.Empty, false) || (r.TargetProcessName?.Length ?? 0) > 260) return "the target process name cannot be displayed";
        if (!DisplayableText(r.TargetWindowTitle ?? string.Empty, false) || (r.TargetWindowTitle?.Length ?? 0) > 512) return "the target window title cannot be displayed";
        if (!DisplayableText(r.Reason ?? string.Empty, false) || (r.Reason?.Length ?? 0) > 512) return "the reason cannot be displayed";
        return null;
    }

    private static bool DisplayableText(string s, bool allowLineBreaks)
    {
        for (int i = 0; i < s.Length; i++)
        {
            char c = s[i];
            if (char.IsHighSurrogate(c)) { if (i + 1 >= s.Length || !char.IsLowSurrogate(s[i + 1])) return false; i++; continue; }
            if (char.IsLowSurrogate(c)) return false;
            if (allowLineBreaks && (c == '\n' || c == '\t')) continue;
            if (char.IsControl(c)) return false;
            // Bidirectional overrides and isolates can make text read differently from what it is.
            if (c is >= '‪' and <= '‮' or >= '⁦' and <= '⁩') return false;
        }
        return true;
    }

    /// <summary>
    /// The exact action being authorized, in DASK-CJ-1 canonical JSON, and its digest. Built by the daemon only, from
    /// the normalised request; the HUD renders the approval from this text and must echo the digest.
    /// </summary>
    public static (string Canonical, string Digest) BuildCanonicalAction(ActionApprovalRequest r)
    {
        var parameters = new System.Text.Json.Nodes.JsonObject();
        foreach (var (k, v) in (r.ActionParameters ?? new Dictionary<string, string>()).OrderBy(kv => kv.Key, StringComparer.Ordinal))
            parameters[k] = v;

        var node = new System.Text.Json.Nodes.JsonObject
        {
            ["schema"] = "dask.approval.action.v1",
            ["approvalId"] = r.ApprovalId,
            ["actionId"] = r.ActionId,
            ["actionType"] = r.ActionType,
            ["parameters"] = parameters,
            ["parametersSha256"] = r.ParametersSha256,
            ["target"] = new System.Text.Json.Nodes.JsonObject
            {
                ["processName"] = r.TargetProcessName,
                ["windowTitle"] = r.TargetWindowTitle,
                ["hwnd"] = r.TargetHwnd,
                ["processId"] = r.TargetProcessId,
                ["processCreationTime"] = r.TargetProcessCreationTime?.ToUniversalTime().ToString("O"),
            },
            ["sessionId"] = r.SessionId,
            ["stopGeneration"] = checked((long)r.StopGeneration),
            ["riskLevel"] = r.RiskLevel,
            ["reason"] = r.Reason,
            ["createdAtUtc"] = r.CreatedAtUtc.ToUniversalTime().ToString("O"),
            ["expiresAtUtc"] = r.ExpiresAtUtc.ToUniversalTime().ToString("O"),
        };
        string canonical = CanonicalJson.EncodeToString(System.Text.Json.JsonSerializer.SerializeToElement(node));
        return (canonical, CanonicalJson.Digest(CanonicalJson.ActionDomain, canonical));
    }

    private void Notify(string sessionId, string approvalId, string actionId, string state, string? reason, bool? decisionAccepted = null)
    {
        if (ApprovalStates.IsTerminal(state) && decisionAccepted is null)
        {
            _recentTerminal[approvalId] = (state, DateTimeOffset.UtcNow);
            if (_recentTerminal.Count > MaxRecentTerminal)
                foreach (var old in _recentTerminal.OrderBy(kv => kv.Value.At).Take(_recentTerminal.Count - MaxRecentTerminal))
                    _recentTerminal.TryRemove(old.Key, out _);
        }
        if (string.IsNullOrWhiteSpace(sessionId)) return;
        try
        {
            ApprovalStateChanged?.Invoke(this, (sessionId, new ApprovalStateNotification
            {
                ApprovalId = approvalId,
                ActionId = actionId,
                State = state,
                Reason = reason is null ? null : AuditJson.Bound(reason, 300),
                DecisionAccepted = decisionAccepted,
            }));
        }
        catch (Exception ex) { _logger.LogError(ex, "[PolicyEngine] An approval-state subscriber failed."); }
    }

    /// <summary>Completes a pending approval exactly once and tells its owner the terminal state.</summary>
    private bool Finalize(CachedApproval cached, ActionApprovalResponse response, string state, string? reason)
    {
        bool set = cached.CompletionSource.TrySetResult(response);
        if (set) Notify(cached.Request.SessionId, cached.Request.ApprovalId, cached.Request.ActionId, state, reason);
        return set;
    }

    /// <summary>The state an approval went to when the daemon refused a decision source, for the owner's display.</summary>
    private static string StateFor(string decisionSource) => decisionSource switch
    {
        "TimeoutDenied" => ApprovalStates.Expired,
        "EmergencyStopDenied" => ApprovalStates.InvalidatedByEmergencyStop,
        "StaleGenerationDenied" => ApprovalStates.InvalidatedByEmergencyStop,
        "SessionDisconnectedDenied" => ApprovalStates.Disconnected,
        "UserCancelled" => ApprovalStates.Cancelled,
        _ => ApprovalStates.Rejected,
    };

    public (bool isAllowed, ActionRiskLevel riskLevel, string? reason) EvaluatePolicy(
        string actionType,
        Dictionary<string, string> parameters,
        string targetProcessName)
    {
        var normalizedType = actionType.Trim();

        if (string.IsNullOrEmpty(normalizedType))
        {
            return (false, ActionRiskLevel.Critical, "Action type cannot be empty.");
        }

        // Known Observation Actions
        if (normalizedType.Equals("CaptureObservation", StringComparison.OrdinalIgnoreCase) ||
            normalizedType.Equals("SimulatedObservation", StringComparison.OrdinalIgnoreCase))
        {
            return (true, ActionRiskLevel.Observation, "Read-only observation is permitted.");
        }

        // Known Low-Risk Actions
        if (normalizedType.Equals("SimulatedScroll", StringComparison.OrdinalIgnoreCase))
        {
            return (true, ActionRiskLevel.LowRisk, "Low-risk simulated scrolling is auto-allowed.");
        }

        // Known Elevated Actions
        if (normalizedType.Equals("SimulatedClick", StringComparison.OrdinalIgnoreCase) ||
            normalizedType.Equals("SimulatedType", StringComparison.OrdinalIgnoreCase))
        {
            return (false, ActionRiskLevel.Elevated, "Simulated desktop input requires explicit user confirmation.");
        }

        // Phase 7B.2: window operations on a daemon-verified window. Never auto-allowed: each needs the user's explicit
        // approval of the exact action. (Phase 7B.2 has no executor; an approval is validated and consumed, not acted on.)
        if (normalizedType.Equals(DesktopActionTypes.FocusWindow, StringComparison.Ordinal) ||
            normalizedType.Equals(DesktopActionTypes.SetWindowState, StringComparison.Ordinal))
        {
            return (false, ActionRiskLevel.Elevated, "Window operations require explicit user approval of the exact action.");
        }

        // P1 / P2: element-bound mouse and keyboard input. Never auto-allowed.
        if (normalizedType.Equals(DesktopActionTypes.ClickElement, StringComparison.Ordinal) ||
            normalizedType.Equals(DesktopActionTypes.TypeText, StringComparison.Ordinal) ||
            normalizedType.Equals(DesktopActionTypes.PressKeys, StringComparison.Ordinal))
        {
            return (false, ActionRiskLevel.Elevated, "Desktop input requires explicit user approval of the exact action.");
        }

        // Browser stage 2: one click or one field fill in D-ASK's private browser. Never auto-allowed.
        if (normalizedType.Equals(DesktopActionTypes.BrowserClick, StringComparison.Ordinal) ||
            normalizedType.Equals(DesktopActionTypes.BrowserFill, StringComparison.Ordinal))
        {
            return (false, ActionRiskLevel.Elevated, "Browser actions require explicit user approval of the exact action.");
        }

        // File organisation: moving named files of one folder into its subfolders (and undoing that). Never auto-allowed.
        if (normalizedType.Equals(DesktopActionTypes.FilesOrganize, StringComparison.Ordinal) ||
            normalizedType.Equals(DesktopActionTypes.FilesUndoOrganize, StringComparison.Ordinal))
        {
            return (false, ActionRiskLevel.Elevated, "Moving files requires explicit user approval of the exact list of moves.");
        }

        // Workflows: scheduling future runs of a saved workflow. Never auto-allowed.
        if (normalizedType.Equals(DesktopActionTypes.WorkflowSchedule, StringComparison.Ordinal))
        {
            return (false, ActionRiskLevel.Elevated, "Scheduling a workflow requires explicit user approval of its steps and timing.");
        }

        // Plugins: installing (approving) a plugin's code. Never auto-allowed.
        if (normalizedType.Equals(DesktopActionTypes.PluginInstall, StringComparison.Ordinal))
        {
            return (false, ActionRiskLevel.Elevated, "Installing a plugin requires explicit user approval of its tools and files.");
        }

        // Notes: creating ONE new text file (never overwriting) in the configured notes folder. Never auto-allowed.
        if (normalizedType.Equals(DesktopActionTypes.FilesCreateNote, StringComparison.Ordinal))
        {
            return (false, ActionRiskLevel.Elevated, "Creating a note requires explicit user approval of its exact title and text.");
        }

        // Known Critical / System Destruction Actions
        if (normalizedType.Contains("Shell", StringComparison.OrdinalIgnoreCase) ||
            normalizedType.Contains("PowerShell", StringComparison.OrdinalIgnoreCase) ||
            normalizedType.Contains("Cmd", StringComparison.OrdinalIgnoreCase) ||
            normalizedType.Contains("Format", StringComparison.OrdinalIgnoreCase) ||
            normalizedType.Contains("Delete", StringComparison.OrdinalIgnoreCase))
        {
            return (false, ActionRiskLevel.Critical, "Potentially destructive or shell action requires critical elevation approval.");
        }

        // Deny-by-default for any unmapped or unfamiliar action type
        return (false, ActionRiskLevel.Critical, $"Deny-by-default: Unrecognized action type '{actionType}'.");
    }

    public async Task<ActionApprovalResponse> RequestApprovalAsync(
        ActionApprovalRequest request,
        CancellationToken cancellationToken = default)
    {
        // H3-9: every approval has an owning session, and only that session may decide it. An approval
        // without an owner would be decidable (and later consumable) by anyone, so it is never registered.
        // The owner must come from the trusted, server-side session of whoever creates the request (the
        // server-generated IpcClientSession id), never from a client-supplied value.
        if (string.IsNullOrWhiteSpace(request.SessionId))
        {
            _logger.LogError("[PolicyEngine SECURITY] Refusing to register approval {ApprovalId}: no owning session.", request.ApprovalId);
            return new ActionApprovalResponse
            {
                ApprovalId = request.ApprovalId,
                ActionId = request.ActionId,
                ActionType = request.ActionType,
                ParametersSha256 = request.ParametersSha256,
                Approved = false,
                DecisionSource = "IntegrityMismatch",
                RejectionReason = "Approval request has no owning session; it cannot be registered."
            };
        }

        // Phase 7B.1a: an approval is offered only to a live HUD, only for an operation that can be shown exactly as it
        // will be authorized, and only with values the daemon computed itself.
        if (_isSessionLive != null && !_isSessionLive(request.SessionId))
        {
            _logger.LogError("[PolicyEngine SECURITY] Refusing to register approval {ApprovalId}: the owning HUD session has no valid liveness lease.", request.ApprovalId);
            return Refused(request, "SessionDisconnectedDenied", "The owning HUD is not live (no valid heartbeat lease); the approval cannot be offered.");
        }

        string? unrepresentable = ValidateRepresentable(request);
        if (unrepresentable != null)
        {
            _logger.LogError("[PolicyEngine SECURITY] Refusing to register approval {ApprovalId}: {Reason}.", request.ApprovalId, unrepresentable);
            return Refused(request, "IntegrityMismatch", $"The operation cannot be represented clearly ({unrepresentable}); approval refused.");
        }

        if (!TryComputeCanonicalHash(request.ActionParameters, out string paramsHash))
            return Refused(request, "IntegrityMismatch", "The parameters cannot be encoded canonically; approval refused.");
        if (!string.IsNullOrEmpty(request.ParametersSha256) &&
            !string.Equals(request.ParametersSha256, paramsHash, StringComparison.OrdinalIgnoreCase))
        {
            _logger.LogError("[PolicyEngine SECURITY] Refusing to register approval {ApprovalId}: supplied parameter hash is not the canonical hash.", request.ApprovalId);
            return Refused(request, "IntegrityMismatch", "Supplied parameter SHA-256 does not match the daemon's canonical hash of the parameters.");
        }

        var now = DateTimeOffset.UtcNow;
        if (request.ExpiresAtUtc <= now)
            return Refused(request, "TimeoutDenied", "The approval request had already expired when it was registered.");
        var expiresAt = request.ExpiresAtUtc - now > MaxApprovalTtl ? now + MaxApprovalTtl : request.ExpiresAtUtc;

        // The normalised request is the only one that exists from here on: daemon creation time, clamped expiry, the
        // daemon's own parameter hash, and the canonical action with its digest. Caller-supplied digests are discarded.
        var normalised = request with
        {
            CreatedAtUtc = now,
            ExpiresAtUtc = expiresAt,
            ParametersSha256 = paramsHash,
            ActionDigest = null,
            CanonicalAction = null,
        };
        string canonicalAction, actionDigest;
        try { (canonicalAction, actionDigest) = BuildCanonicalAction(normalised); }
        catch (Exception ex) when (ex is CanonicalEncodingException or OverflowException)
        {
            return Refused(request, "IntegrityMismatch", $"The action cannot be encoded canonically ({ex.Message}); approval refused.");
        }
        request = normalised with { ActionDigest = actionDigest, CanonicalAction = canonicalAction };

        var cached = new CachedApproval
        {
            Request = request
        };

        if (!_pendingApprovals.TryAdd(request.ApprovalId, cached))
        {
            return new ActionApprovalResponse
            {
                ApprovalId = request.ApprovalId,
                ActionId = request.ActionId,
                ActionType = request.ActionType,
                ParametersSha256 = request.ParametersSha256,
                Approved = false,
                DecisionSource = "IntegrityMismatch",
                RejectionReason = "Duplicate approval ID in flight."
            };
        }

        _logger.LogInformation(
            "[PolicyEngine] Registered pending approval {ApprovalId} for Action {ActionId} ({ActionType}, Risk={RiskLevel}, Gen={Gen}, Expires={ExpiresAt})",
            request.ApprovalId, request.ActionId, request.ActionType, request.RiskLevel, request.StopGeneration, request.ExpiresAtUtc);

        if (_evidenceRecorder != null)
        {
            try
            {
                await _evidenceRecorder.RecordSafetyAuditAsync(new SafetyAuditRecord
                {
                    EventType = "ApprovalRequested",
                    Source = "PolicyEngine",
                    ActionId = request.ActionId,
                    ApprovalId = request.ApprovalId,
                    SessionId = request.SessionId,
                    RiskLevel = request.RiskLevel,
                    ParametersSha256 = request.ParametersSha256,
                    StopGeneration = request.StopGeneration,
                    Decision = "Pending",
                    Reason = AuditJson.Bound(request.Reason),
                    // Serializer-built (F5): process names and titles cannot change the JSON structure. No parameter values.
                    DetailsJson = AuditJson.Details(new
                    {
                        actionType = AuditJson.Bound(request.ActionType),
                        targetProcess = AuditJson.Bound(request.TargetProcessName),
                        targetHwnd = request.TargetHwnd,
                        actionDigest = request.ActionDigest,
                        expiresAtUtc = request.ExpiresAtUtc,
                    })
                }, cancellationToken);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[PolicyEngine] Failed to log ApprovalRequested event to audit trail.");
            }
        }

        // Owner-only delivery of the exact operation (the pipe server routes it to request.SessionId).
        try { ApprovalRequested?.Invoke(this, request); }
        catch (Exception ex) { _logger.LogError(ex, "[PolicyEngine] An approval-request subscriber failed."); }

        // Schedule TTL expiration timer
        var ttl = request.ExpiresAtUtc - DateTimeOffset.UtcNow;
        if (ttl <= TimeSpan.Zero) ttl = TimeSpan.FromMilliseconds(1);

        cached.ExpirationCts.CancelAfter(ttl);
        var registered = request;
        using var reg = cached.ExpirationCts.Token.Register(() =>
        {
            if (_pendingApprovals.TryRemove(new KeyValuePair<string, CachedApproval>(registered.ApprovalId, cached)))
            {
                _logger.LogWarning("[PolicyEngine] Approval {ApprovalId} EXPIRED (TTL elapsed).", registered.ApprovalId);
                var expiredResp = new ActionApprovalResponse
                {
                    ApprovalId = registered.ApprovalId,
                    ActionId = registered.ActionId,
                    ActionType = registered.ActionType,
                    ParametersSha256 = registered.ParametersSha256,
                    Approved = false,
                    DecisionSource = "TimeoutDenied",
                    RejectionReason = "Approval request expired before user confirmation."
                };
                Finalize(cached, expiredResp, ApprovalStates.Expired, "The approval expired before a decision.");

                if (_evidenceRecorder != null)
                {
                    _ = _evidenceRecorder.RecordSafetyAuditAsync(new SafetyAuditRecord
                    {
                        EventType = "ApprovalExpired",
                        Source = "PolicyEngine",
                        ActionId = registered.ActionId,
                        ApprovalId = registered.ApprovalId,
                        SessionId = registered.SessionId,
                        RiskLevel = registered.RiskLevel,
                        ParametersSha256 = registered.ParametersSha256,
                        StopGeneration = registered.StopGeneration,
                        Decision = "Denied",
                        Reason = "Approval timed out before user confirmation"
                    });
                }
            }
        });

        using var cancelReg = cancellationToken.Register(() =>
        {
            if (_pendingApprovals.TryRemove(new KeyValuePair<string, CachedApproval>(registered.ApprovalId, cached)))
            {
                var cancelResp = new ActionApprovalResponse
                {
                    ApprovalId = registered.ApprovalId,
                    ActionId = registered.ActionId,
                    ActionType = registered.ActionType,
                    ParametersSha256 = registered.ParametersSha256,
                    Approved = false,
                    DecisionSource = "EmergencyStopDenied",
                    RejectionReason = "Operation cancelled before approval completed."
                };
                Finalize(cached, cancelResp, ApprovalStates.Cancelled, "The operation was cancelled before a decision.");
            }
        });

        return await cached.CompletionSource.Task;
    }

    private ActionApprovalResponse Refused(ActionApprovalRequest request, string source, string reason)
    {
        Notify(request.SessionId, request.ApprovalId, request.ActionId,
            source switch
            {
                "TimeoutDenied" => ApprovalStates.Expired,
                "SessionDisconnectedDenied" => ApprovalStates.Disconnected,
                _ => ApprovalStates.Rejected,
            }, reason);
        return new ActionApprovalResponse
        {
            ApprovalId = request.ApprovalId,
            ActionId = request.ActionId,
            ActionType = request.ActionType,
            ParametersSha256 = request.ParametersSha256,
            Approved = false,
            DecisionSource = source,
            RejectionReason = reason
        };
    }

    /// <summary>
    /// The authoritative decision point for approvals (H3-9). A decision is accepted only from the session that
    /// owns the pending request.
    /// </summary>
    /// <param name="callerSessionId">
    /// The authenticated, server-generated id of the IPC session that submitted the decision. REQUIRED, with no
    /// default: it must come from the transport (IpcClientSession), never from <c>response.SessionId</c>, which
    /// is attacker-controlled. Null, empty or whitespace is refused.
    /// </param>
    /// <returns>true only if this call finalized the owner's pending approval.</returns>
    public bool SubmitApprovalDecision(
        ActionApprovalResponse response,
        string callerSessionId,
        Func<bool>? isEmergencyStoppedFunc = null,
        Func<ulong>? getCurrentGenerationFunc = null)
    {
        if (string.IsNullOrWhiteSpace(callerSessionId))
        {
            _logger.LogError("[PolicyEngine SECURITY] Refusing approval decision for {ApprovalId}: missing caller session identity.", response.ApprovalId);
            return false;
        }

        if (string.IsNullOrEmpty(response.ApprovalId) ||
            !_pendingApprovals.TryGetValue(response.ApprovalId, out var cached))
        {
            _logger.LogWarning("[PolicyEngine] Received decision for unknown or already finalized approval {ApprovalId}", response.ApprovalId);
            // Phase 7B.1a: a late or duplicate decision is answered, never silently ignored. It authorizes nothing.
            string known = !string.IsNullOrEmpty(response.ApprovalId) && _recentTerminal.TryGetValue(response.ApprovalId, out var t)
                ? t.State : ApprovalStates.Rejected;
            Notify(callerSessionId, response.ApprovalId ?? string.Empty, response.ActionId ?? string.Empty, known,
                "This decision was not accepted: the approval is no longer pending.", decisionAccepted: false);
            return false;
        }

        // Ownership is checked BEFORE the entry is touched. A refused attempt leaves the owner's pending
        // approval intact, so another session cannot cancel (deny) a request it does not own either.
        string owner = cached.Request.SessionId;
        if (string.IsNullOrWhiteSpace(owner) || !string.Equals(owner, callerSessionId, StringComparison.Ordinal))
        {
            _logger.LogError("[PolicyEngine SECURITY] Ownership violation: approval {ApprovalId} is owned by session '{Owner}', decision attempted by '{Caller}'. Refused; request left pending.",
                response.ApprovalId, owner, callerSessionId);
            AuditOwnershipViolation(cached, response, callerSessionId);
            return false;
        }

        // Remove exactly the entry whose owner was just verified. ConcurrentDictionary.TryRemove(KeyValuePair)
        // removes only if the stored value still equals the pair's value; CachedApproval has no Equals override,
        // so that is reference identity. If the entry was finalized or replaced since the check, nothing is removed.
        if (!_pendingApprovals.TryRemove(new KeyValuePair<string, CachedApproval>(response.ApprovalId, cached)))
        {
            _logger.LogWarning("[PolicyEngine] Approval {ApprovalId} was finalized concurrently; decision ignored.", response.ApprovalId);
            return false;
        }

        cached.ExpirationCts.Dispose();

        // 0. Phase 7B.1a: a HUD whose liveness lease lapsed cannot decide. Fail closed: the approval is withdrawn.
        if (_isSessionLive != null && !_isSessionLive(callerSessionId))
        {
            _logger.LogError("[PolicyEngine SECURITY] Rejecting decision for {ApprovalId}: the deciding HUD session is not live.", response.ApprovalId);
            var notLive = response with
            {
                Approved = false,
                DecisionSource = "SessionDisconnectedDenied",
                RejectionReason = "The HUD's liveness lease is not valid; the approval was withdrawn."
            };
            return Finalize(cached, notLive, ApprovalStates.Disconnected, notLive.RejectionReason);
        }

        // 1. Verify not expired
        if (DateTimeOffset.UtcNow > cached.Request.ExpiresAtUtc)
        {
            _logger.LogWarning("[PolicyEngine SECURITY] Rejecting approval decision for expired token {ApprovalId}", response.ApprovalId);
            var expired = response with
            {
                Approved = false,
                DecisionSource = "TimeoutDenied",
                RejectionReason = "Approval expired before decision submission."
            };
            return Finalize(cached, expired, ApprovalStates.Expired, expired.RejectionReason);
        }

        // 2. Verify emergency stop
        if (isEmergencyStoppedFunc != null && isEmergencyStoppedFunc())
        {
            _logger.LogWarning("[PolicyEngine SECURITY] Rejecting approval decision for token {ApprovalId}: Emergency Stop active", response.ApprovalId);
            var stopped = response with
            {
                Approved = false,
                DecisionSource = "EmergencyStopDenied",
                RejectionReason = "Cannot grant approval while Emergency Stop is active."
            };
            return Finalize(cached, stopped, ApprovalStates.InvalidatedByEmergencyStop, stopped.RejectionReason);
        }

        // 3. Verify stop generation
        if (getCurrentGenerationFunc != null)
        {
            ulong currentGen = getCurrentGenerationFunc();
            if (cached.Request.StopGeneration != currentGen)
            {
                _logger.LogWarning("[PolicyEngine SECURITY] Rejecting approval decision for token {ApprovalId}: Generation mismatch (ReqGen={ReqGen}, CurrentGen={CurGen})",
                    response.ApprovalId, cached.Request.StopGeneration, currentGen);
                var stale = response with
                {
                    Approved = false,
                    DecisionSource = "StaleGenerationDenied",
                    RejectionReason = $"Approval generation ({cached.Request.StopGeneration}) does not match current epoch ({currentGen})."
                };
                return Finalize(cached, stale, ApprovalStates.InvalidatedByEmergencyStop, stale.RejectionReason);
            }
        }

        // 4. Parameter hash and action digest integrity. The daemon recomputes both from what it holds; the HUD's echoes
        //    must equal them, so an approval can only ever authorize the exact canonical action that was displayed.
        bool hashOk = TryComputeCanonicalHash(cached.Request.ActionParameters, out string recomputedPendingHash) &&
                      string.Equals(recomputedPendingHash, cached.Request.ParametersSha256, StringComparison.OrdinalIgnoreCase);
        bool digestOk = false;
        try
        {
            var (_, recomputedDigest) = BuildCanonicalAction(cached.Request with { ActionDigest = null, CanonicalAction = null });
            digestOk = string.Equals(recomputedDigest, cached.Request.ActionDigest, StringComparison.Ordinal);
        }
        catch (Exception ex) when (ex is CanonicalEncodingException or OverflowException) { digestOk = false; }

        if (!hashOk || !digestOk ||
            (response.Approved && !string.Equals(response.ParametersSha256, cached.Request.ParametersSha256, StringComparison.OrdinalIgnoreCase)) ||
            (response.Approved && !string.Equals(response.ActionDigest, cached.Request.ActionDigest, StringComparison.Ordinal)))
        {
            _logger.LogError("[PolicyEngine SECURITY] Integrity mismatch on approval {ApprovalId} (parameter hash or action digest). Rejection enforced.",
                response.ApprovalId);

            var tampered = response with
            {
                Approved = false,
                DecisionSource = "IntegrityMismatch",
                RejectionReason = "Parameter SHA-256 hash or action digest does not match original request."
            };
            return Finalize(cached, tampered, ApprovalStates.Rejected, tampered.RejectionReason);
        }

        // 5. If approved by user, atomically register in the authoritative granted registry
        if (response.Approved)
        {
            Enum.TryParse<ActionRiskLevel>(cached.Request.RiskLevel, true, out var risk);

            var granted = new GrantedApprovalRecord
            {
                ApprovalId = cached.Request.ApprovalId,
                ActionId = cached.Request.ActionId,
                ActionType = cached.Request.ActionType,
                CanonicalParameters = cached.Request.ActionParameters,
                ParametersSha256 = cached.Request.ParametersSha256,
                TargetHwnd = cached.Request.TargetHwnd,
                TargetProcessId = cached.Request.TargetProcessId,
                TargetProcessName = cached.Request.TargetProcessName,
                TargetProcessCreationTime = cached.Request.TargetProcessCreationTime,
                RiskLevel = risk,
                SessionId = cached.Request.SessionId,
                StopGeneration = cached.Request.StopGeneration,
                CreatedAtUtc = cached.Request.CreatedAtUtc,
                ExpiresAtUtc = cached.Request.ExpiresAtUtc
            };

            _grantedApprovals[granted.ApprovalId] = granted;

            _logger.LogInformation(
                "[PolicyEngine] AUTHORIZED: Granted approval record stored for {ApprovalId} (Action={ActionId}, Gen={Gen})",
                granted.ApprovalId, granted.ActionId, granted.StopGeneration);

            if (_evidenceRecorder != null)
            {
                _ = _evidenceRecorder.RecordSafetyAuditAsync(new SafetyAuditRecord
                {
                    EventType = "ApprovalGranted",
                    Source = response.DecisionSource,
                    ActionId = granted.ActionId,
                    ApprovalId = granted.ApprovalId,
                    RiskLevel = granted.RiskLevel.ToString(),
                    ParametersSha256 = granted.ParametersSha256,
                    StopGeneration = granted.StopGeneration,
                    Decision = "Approved",
                    Reason = "User explicitly granted approval"
                });
            }
        }
        else
        {
            if (_evidenceRecorder != null)
            {
                _ = _evidenceRecorder.RecordSafetyAuditAsync(new SafetyAuditRecord
                {
                    EventType = "ApprovalDenied",
                    Source = response.DecisionSource,
                    ActionId = cached.Request.ActionId,
                    ApprovalId = cached.Request.ApprovalId,
                    RiskLevel = cached.Request.RiskLevel,
                    ParametersSha256 = cached.Request.ParametersSha256,
                    StopGeneration = cached.Request.StopGeneration,
                    Decision = "Denied",
                    Reason = AuditJson.Bound(response.RejectionReason ?? "User rejected action")
                });
            }
        }

        return Finalize(cached, response,
            response.Approved ? ApprovalStates.Approved : ApprovalStates.Denied,
            response.Approved ? "Approved by the user; authorized by the daemon for this single action." : "Denied by the user.");
    }

    /// <summary>
    /// Records a refused cross-session decision. Best effort and strictly observational: it runs after the
    /// refusal is already decided and can neither throw into, nor alter, that outcome. Only identifiers are
    /// recorded (no action parameters).
    /// </summary>
    private void AuditOwnershipViolation(CachedApproval cached, ActionApprovalResponse response, string callerSessionId)
    {
        if (_evidenceRecorder == null) return;
        try
        {
            var record = new SafetyAuditRecord
            {
                EventType = "ApprovalOwnershipViolation",
                Source = "PolicyEngine",
                ActionId = cached.Request.ActionId,
                ApprovalId = cached.Request.ApprovalId,
                SessionId = callerSessionId,
                RiskLevel = cached.Request.RiskLevel,
                StopGeneration = cached.Request.StopGeneration,
                Decision = "Refused",
                Reason = "Approval decision submitted by a session that does not own the request",
                DetailsJson = System.Text.Json.JsonSerializer.Serialize(new
                {
                    ownerSessionId = cached.Request.SessionId,
                    callerSessionId,
                    attemptedApproved = response.Approved
                })
            };
            _evidenceRecorder.RecordSafetyAuditAsync(record).ContinueWith(
                t => _logger.LogWarning(t.Exception, "[SafetyAudit] Failed to log ApprovalOwnershipViolation."),
                TaskContinuationOptions.OnlyOnFaulted);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[SafetyAudit] Failed to log ApprovalOwnershipViolation.");
        }
    }

    public (bool isValid, string? error) ValidateConsumedApproval(
        string? approvalId,
        string actionId,
        string actionType,
        Dictionary<string, string> parameters,
        string targetProcessName,
        long targetHwnd = 0,
        int targetProcessId = 0,
        DateTimeOffset? targetProcessCreationTime = null,
        string sessionId = "",
        ulong currentGeneration = 1,
        bool isEmergencyStopped = false)
    {
        // 1. Rejects empty or malformed approval IDs
        if (string.IsNullOrWhiteSpace(approvalId) || approvalId.Length < 8)
        {
            return (false, "Missing or malformed required approval ID for elevated action.");
        }

        // 2. Replay rejection check
        if (_consumedApprovals.ContainsKey(approvalId))
        {
            _logger.LogError("[PolicyEngine SECURITY] Replay attack detected for approval token {ApprovalId}!", approvalId);
            return (false, $"Replay rejected: Approval token '{approvalId}' has already been consumed.");
        }

        // 3. Lookup in granted registry: reject IDs that were never granted
        if (!_grantedApprovals.TryGetValue(approvalId, out var granted))
        {
            _logger.LogError("[PolicyEngine SECURITY] Forgery detected: Approval token '{ApprovalId}' was never granted or does not exist!", approvalId);
            return (false, $"Security validation failed: Approval token '{approvalId}' was never granted or does not exist.");
        }

        // 4. Verify emergency stop latch
        if (isEmergencyStopped)
        {
            return (false, "Action blocked: Emergency Stop is currently active.");
        }

        // 5. Verify StopGeneration
        if (granted.StopGeneration != currentGeneration)
        {
            _logger.LogError("[PolicyEngine SECURITY] Stale generation: Token {ApprovalId} generation {TokenGen} != current generation {CurGen}!",
                approvalId, granted.StopGeneration, currentGeneration);
            return (false, $"Security validation failed: Approval token generation ({granted.StopGeneration}) does not match current execution epoch ({currentGeneration}).");
        }

        // 6. Verify SessionId (H3-9: fail closed; a missing owner or caller identity never skips the check)
        if (string.IsNullOrWhiteSpace(granted.SessionId) || string.IsNullOrWhiteSpace(sessionId))
        {
            _logger.LogError("[PolicyEngine SECURITY] Token {ApprovalId} cannot be consumed: missing owner or caller session identity.", approvalId);
            return (false, "Security validation failed: approval owner or caller session identity is missing.");
        }

        if (!string.Equals(granted.SessionId, sessionId, StringComparison.Ordinal))
        {
            _logger.LogError("[PolicyEngine SECURITY] Cross-session violation: Token {ApprovalId} owned by session '{OwnerSession}', attempted by '{CallerSession}'!",
                approvalId, granted.SessionId, sessionId);
            return (false, "Security validation failed: Cross-session approval token use rejected.");
        }

        // 7. Verify Expiration
        if (DateTimeOffset.UtcNow > granted.ExpiresAtUtc)
        {
            _logger.LogError("[PolicyEngine SECURITY] Expired token: Token {ApprovalId} expired at {Expiry}!", approvalId, granted.ExpiresAtUtc);
            return (false, "Security validation failed: Approval token has expired.");
        }

        // 8. Verify ActionId
        if (!string.Equals(granted.ActionId, actionId, StringComparison.Ordinal))
        {
            _logger.LogError("[PolicyEngine SECURITY] ActionId mismatch on token {ApprovalId}: Expected '{Exp}', Got '{Got}'!",
                approvalId, granted.ActionId, actionId);
            return (false, $"Security validation failed: Action ID mismatch. Expected '{granted.ActionId}', Got '{actionId}'.");
        }

        // 9. Verify ActionType
        if (!string.Equals(granted.ActionType, actionType, StringComparison.OrdinalIgnoreCase))
        {
            _logger.LogError("[PolicyEngine SECURITY] ActionType mismatch on token {ApprovalId}: Expected '{Exp}', Got '{Got}'!",
                approvalId, granted.ActionType, actionType);
            return (false, $"Security validation failed: Action type mismatch. Expected '{granted.ActionType}', Got '{actionType}'.");
        }

        // 10. Recompute and compare canonical SHA-256 hash
        if (!TryComputeCanonicalHash(parameters, out string computedHash))
            return (false, "Security validation failed: presented parameters cannot be encoded canonically.");
        if (!string.Equals(granted.ParametersSha256, computedHash, StringComparison.OrdinalIgnoreCase))
        {
            _logger.LogError("[PolicyEngine SECURITY] Parameter tampering detected on token {ApprovalId}! Granted='{Exp}', Computed='{Got}'!",
                approvalId, granted.ParametersSha256, computedHash);
            return (false, $"Security validation failed: Parameter SHA-256 hash mismatch! Granted='{granted.ParametersSha256}', Presented='{computedHash}'.");
        }

        // 11. Verify target HWND
        if (granted.TargetHwnd != 0 && targetHwnd != 0 && granted.TargetHwnd != targetHwnd)
        {
            _logger.LogError("[PolicyEngine SECURITY] Target HWND mismatch on token {ApprovalId}: Granted={Exp}, Attempted={Got}!",
                approvalId, granted.TargetHwnd, targetHwnd);
            return (false, $"Security validation failed: Target HWND mismatch. Expected {granted.TargetHwnd}, Got {targetHwnd}.");
        }

        // 12. Verify target PID
        if (granted.TargetProcessId != 0 && targetProcessId != 0 && granted.TargetProcessId != targetProcessId)
        {
            _logger.LogError("[PolicyEngine SECURITY] Target PID mismatch on token {ApprovalId}: Granted={Exp}, Attempted={Got}!",
                approvalId, granted.TargetProcessId, targetProcessId);
            return (false, $"Security validation failed: Target Process ID mismatch. Expected {granted.TargetProcessId}, Got {targetProcessId}.");
        }

        // 13. Verify process instance identity (creation time)
        if (granted.TargetProcessCreationTime.HasValue && targetProcessCreationTime.HasValue &&
            granted.TargetProcessCreationTime.Value != targetProcessCreationTime.Value)
        {
            _logger.LogError("[PolicyEngine SECURITY] Process instance mismatch on token {ApprovalId}! Reused HWND with different process instance.", approvalId);
            return (false, "Security validation failed: Target process instance creation time mismatch (reused HWND with different process instance).");
        }

        // 14. Verify target process name
        if (!string.IsNullOrEmpty(granted.TargetProcessName) && !string.IsNullOrEmpty(targetProcessName) &&
            !string.Equals(granted.TargetProcessName, targetProcessName, StringComparison.OrdinalIgnoreCase))
        {
            _logger.LogError("[PolicyEngine SECURITY] Process name mismatch on token {ApprovalId}: Granted='{Exp}', Attempted='{Got}'!",
                approvalId, granted.TargetProcessName, targetProcessName);
            return (false, $"Security validation failed: Target process name mismatch. Expected '{granted.TargetProcessName}', Got '{targetProcessName}'.");
        }

        // 15. Atomically consume the approval exactly once
        // TryRemove guarantees that only one concurrent consumer can ever obtain the token
        if (!_grantedApprovals.TryRemove(approvalId, out var removedRecord))
        {
            _logger.LogError("[PolicyEngine SECURITY] Concurrent consumption race on token {ApprovalId}! Token was already consumed.", approvalId);
            return (false, $"Concurrency rejection: Approval token '{approvalId}' was already consumed by a concurrent operation.");
        }

        _consumedApprovals.TryAdd(approvalId, DateTimeOffset.UtcNow);

        _logger.LogInformation("[PolicyEngine] Approval token {ApprovalId} consumed successfully for Action {ActionId}.",
            approvalId, actionId);

        return (true, null);
    }

    public int InvalidateAllPendingAndGrantedApprovals(string reason)
    {
        int count = 0;

        foreach (var kvp in _pendingApprovals)
        {
            if (_pendingApprovals.TryRemove(kvp.Key, out var cached))
            {
                count++;
                try { cached.ExpirationCts.Cancel(); } catch { }
                try { cached.ExpirationCts.Dispose(); } catch { }

                var cancelledResp = new ActionApprovalResponse
                {
                    ApprovalId = cached.Request.ApprovalId,
                    ActionId = cached.Request.ActionId,
                    ActionType = cached.Request.ActionType,
                    ParametersSha256 = cached.Request.ParametersSha256,
                    Approved = false,
                    DecisionSource = "EmergencyStopDenied",
                    RejectionReason = $"Invalidated: {reason}"
                };
                Finalize(cached, cancelledResp, ApprovalStates.InvalidatedByEmergencyStop, cancelledResp.RejectionReason);
            }
        }

        int grantedRemoved = _grantedApprovals.Count;
        _grantedApprovals.Clear();
        count += grantedRemoved;

        if (count > 0)
        {
            _logger.LogWarning("[PolicyEngine] Invalidated {Count} approvals ({Granted} granted, {Pending} pending): {Reason}",
                count, grantedRemoved, count - grantedRemoved, reason);
        }
        return count;
    }

    public int InvalidateApprovalsForSession(string sessionId, string reason)
    {
        int count = 0;

        foreach (var kvp in _pendingApprovals)
        {
            if (kvp.Value.Request.SessionId == sessionId)
            {
                if (_pendingApprovals.TryRemove(kvp.Key, out var cached))
                {
                    count++;
                    try { cached.ExpirationCts.Cancel(); } catch { }
                    try { cached.ExpirationCts.Dispose(); } catch { }

                    var cancelledResp = new ActionApprovalResponse
                    {
                        ApprovalId = cached.Request.ApprovalId,
                        ActionId = cached.Request.ActionId,
                        ActionType = cached.Request.ActionType,
                        ParametersSha256 = cached.Request.ParametersSha256,
                        Approved = false,
                        DecisionSource = "SessionDisconnectedDenied",
                        RejectionReason = $"Session disconnected: {reason}"
                    };
                    Finalize(cached, cancelledResp, ApprovalStates.Disconnected, cancelledResp.RejectionReason);
                }
            }
        }

        foreach (var kvp in _grantedApprovals)
        {
            if (kvp.Value.SessionId == sessionId)
            {
                if (_grantedApprovals.TryRemove(kvp.Key, out _))
                {
                    count++;
                }
            }
        }

        if (count > 0)
        {
            _logger.LogWarning("[PolicyEngine] Invalidated {Count} approvals for disconnected session {SessionId}: {Reason}",
                count, sessionId, reason);
        }
        return count;
    }

    public int InvalidateApprovalsForGeneration(ulong staleGeneration, string reason)
    {
        int count = 0;

        foreach (var kvp in _pendingApprovals)
        {
            if (kvp.Value.Request.StopGeneration <= staleGeneration)
            {
                if (_pendingApprovals.TryRemove(kvp.Key, out var cached))
                {
                    count++;
                    try { cached.ExpirationCts.Cancel(); } catch { }
                    try { cached.ExpirationCts.Dispose(); } catch { }

                    var cancelledResp = new ActionApprovalResponse
                    {
                        ApprovalId = cached.Request.ApprovalId,
                        ActionId = cached.Request.ActionId,
                        ActionType = cached.Request.ActionType,
                        ParametersSha256 = cached.Request.ParametersSha256,
                        Approved = false,
                        DecisionSource = "StaleGenerationDenied",
                        RejectionReason = $"Invalidated: {reason}"
                    };
                    Finalize(cached, cancelledResp, ApprovalStates.InvalidatedByEmergencyStop, cancelledResp.RejectionReason);
                }
            }
        }

        foreach (var kvp in _grantedApprovals)
        {
            if (kvp.Value.StopGeneration <= staleGeneration)
            {
                if (_grantedApprovals.TryRemove(kvp.Key, out _))
                {
                    count++;
                }
            }
        }

        return count;
    }
}

/// <summary>Phase 7B.2: the canonical action types of the window operations (design: protocol §6.4–6.5).</summary>
public static class DesktopActionTypes
{
    public const string FocusWindow = "Desktop.FocusWindow";
    public const string SetWindowState = "Desktop.SetWindowState";
    // P1 / P2 guarded input: element-bound, each needs the user's explicit approval of the exact action.
    public const string ClickElement = "Desktop.ClickElement";
    public const string TypeText = "Desktop.TypeText";
    public const string PressKeys = "Desktop.PressKeys";
    public const string BrowserClick = "Browser.Click";
    public const string BrowserFill = "Browser.Fill";
    public const string FilesOrganize = "Files.Organize";
    public const string FilesUndoOrganize = "Files.UndoOrganize";
    public const string WorkflowSchedule = "Workflow.Schedule";
    public const string PluginInstall = "Plugin.Install";
    public const string FilesCreateNote = "Files.CreateNote";
}
