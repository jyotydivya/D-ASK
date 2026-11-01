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

    public int PendingApprovalCount => _pendingApprovals.Count;
    public int GrantedApprovalCount => _grantedApprovals.Count;

    public ActionPolicyEngine(ILogger<ActionPolicyEngine> logger, IEvidenceRecorder? evidenceRecorder = null)
    {
        _logger = logger;
        _evidenceRecorder = evidenceRecorder;
    }

    public static string ComputeCanonicalHash(Dictionary<string, string>? parameters)
    {
        if (parameters == null || parameters.Count == 0)
        {
            using var shaEmpty = SHA256.Create();
            return Convert.ToHexString(shaEmpty.ComputeHash(Encoding.UTF8.GetBytes(string.Empty))).ToLowerInvariant();
        }

        var sortedKeys = parameters.Keys.OrderBy(k => k, StringComparer.Ordinal);
        var sb = new StringBuilder();
        foreach (var key in sortedKeys)
        {
            sb.Append(key).Append('=').Append(parameters[key]).Append('\n');
        }

        using var sha = SHA256.Create();
        byte[] hash = sha.ComputeHash(Encoding.UTF8.GetBytes(sb.ToString()));
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

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
                    RiskLevel = request.RiskLevel,
                    ParametersSha256 = request.ParametersSha256,
                    StopGeneration = request.StopGeneration,
                    Decision = "Pending",
                    Reason = request.Reason,
                    DetailsJson = $"{{\"actionType\":\"{request.ActionType}\",\"targetProcess\":\"{request.TargetProcessName}\",\"targetHwnd\":{request.TargetHwnd}}}"
                }, cancellationToken);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[PolicyEngine] Failed to log ApprovalRequested event to audit trail.");
            }
        }

        // Schedule TTL expiration timer
        var ttl = request.ExpiresAtUtc - DateTimeOffset.UtcNow;
        if (ttl <= TimeSpan.Zero) ttl = DefaultTtl;

        cached.ExpirationCts.CancelAfter(ttl);
        using var reg = cached.ExpirationCts.Token.Register(() =>
        {
            if (_pendingApprovals.TryRemove(request.ApprovalId, out var expired))
            {
                _logger.LogWarning("[PolicyEngine] Approval {ApprovalId} EXPIRED (TTL elapsed).", request.ApprovalId);
                var expiredResp = new ActionApprovalResponse
                {
                    ApprovalId = request.ApprovalId,
                    ActionId = request.ActionId,
                    ActionType = request.ActionType,
                    ParametersSha256 = request.ParametersSha256,
                    Approved = false,
                    DecisionSource = "TimeoutDenied",
                    RejectionReason = "Approval request expired before user confirmation."
                };
                expired.CompletionSource.TrySetResult(expiredResp);

                if (_evidenceRecorder != null)
                {
                    _ = _evidenceRecorder.RecordSafetyAuditAsync(new SafetyAuditRecord
                    {
                        EventType = "ApprovalExpired",
                        Source = "PolicyEngine",
                        ActionId = request.ActionId,
                        ApprovalId = request.ApprovalId,
                        RiskLevel = request.RiskLevel,
                        ParametersSha256 = request.ParametersSha256,
                        StopGeneration = request.StopGeneration,
                        Decision = "Denied",
                        Reason = "Approval timed out before user confirmation"
                    });
                }
            }
        });

        using var cancelReg = cancellationToken.Register(() =>
        {
            if (_pendingApprovals.TryRemove(request.ApprovalId, out var cancelled))
            {
                var cancelResp = new ActionApprovalResponse
                {
                    ApprovalId = request.ApprovalId,
                    ActionId = request.ActionId,
                    ActionType = request.ActionType,
                    ParametersSha256 = request.ParametersSha256,
                    Approved = false,
                    DecisionSource = "EmergencyStopDenied",
                    RejectionReason = "Operation cancelled before approval completed."
                };
                cancelled.CompletionSource.TrySetResult(cancelResp);
            }
        });

        return await cached.CompletionSource.Task;
    }

    public bool SubmitApprovalDecision(
        ActionApprovalResponse response,
        Func<bool>? isEmergencyStoppedFunc = null,
        Func<ulong>? getCurrentGenerationFunc = null)
    {
        if (!_pendingApprovals.TryRemove(response.ApprovalId, out var cached))
        {
            _logger.LogWarning("[PolicyEngine] Received decision for unknown or already finalized approval {ApprovalId}", response.ApprovalId);
            return false;
        }

        cached.ExpirationCts.Dispose();

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
            return cached.CompletionSource.TrySetResult(expired);
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
            return cached.CompletionSource.TrySetResult(stopped);
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
                return cached.CompletionSource.TrySetResult(stale);
            }
        }

        // 4. Parameter hash integrity check
        string recomputedPendingHash = ComputeCanonicalHash(cached.Request.ActionParameters);
        if (!string.Equals(recomputedPendingHash, cached.Request.ParametersSha256, StringComparison.OrdinalIgnoreCase) ||
            (response.Approved && !string.Equals(response.ParametersSha256, cached.Request.ParametersSha256, StringComparison.OrdinalIgnoreCase)))
        {
            _logger.LogError("[PolicyEngine SECURITY] Parameter SHA256 mismatch on approval {ApprovalId}! Expected '{Exp}', Got '{Got}'. Rejection enforced.",
                response.ApprovalId, cached.Request.ParametersSha256, response.ParametersSha256);

            var tampered = response with
            {
                Approved = false,
                DecisionSource = "IntegrityMismatch",
                RejectionReason = "Parameter SHA-256 hash does not match original request."
            };
            return cached.CompletionSource.TrySetResult(tampered);
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
                    Reason = response.RejectionReason ?? "User rejected action"
                });
            }
        }

        return cached.CompletionSource.TrySetResult(response);
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

        // 6. Verify SessionId
        if (!string.IsNullOrEmpty(granted.SessionId) && !string.IsNullOrEmpty(sessionId) &&
            !string.Equals(granted.SessionId, sessionId, StringComparison.Ordinal))
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
        string computedHash = ComputeCanonicalHash(parameters);
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
                cached.CompletionSource.TrySetResult(cancelledResp);
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
                    cached.CompletionSource.TrySetResult(cancelledResp);
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
                    cached.CompletionSource.TrySetResult(cancelledResp);
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
