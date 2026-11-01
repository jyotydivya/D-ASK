using System.Text.Json.Serialization;

namespace DAsk.Protocol.IPC.Messages.ComputerUse;

public record ActionApprovalRequest
{
    [JsonPropertyName("approvalId")]
    public string ApprovalId { get; init; } = Guid.NewGuid().ToString("N");

    [JsonPropertyName("actionId")]
    public string ActionId { get; init; } = Guid.NewGuid().ToString("N");

    [JsonPropertyName("actionType")]
    public string ActionType { get; init; } = string.Empty;

    [JsonPropertyName("parametersSha256")]
    public string ParametersSha256 { get; init; } = string.Empty;

    [JsonPropertyName("actionParameters")]
    public Dictionary<string, string> ActionParameters { get; init; } = new();

    [JsonPropertyName("targetProcessName")]
    public string TargetProcessName { get; init; } = string.Empty;

    [JsonPropertyName("targetWindowTitle")]
    public string TargetWindowTitle { get; init; } = string.Empty;

    [JsonPropertyName("targetHwnd")]
    public long TargetHwnd { get; init; }

    [JsonPropertyName("targetProcessId")]
    public int TargetProcessId { get; init; }

    [JsonPropertyName("targetProcessCreationTime")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public DateTimeOffset? TargetProcessCreationTime { get; init; }

    [JsonPropertyName("sessionId")]
    public string SessionId { get; init; } = string.Empty;

    [JsonPropertyName("stopGeneration")]
    public ulong StopGeneration { get; init; }

    [JsonPropertyName("riskLevel")]
    public string RiskLevel { get; init; } = "Elevated"; // Observation, LowRisk, Elevated, Critical

    [JsonPropertyName("createdAtUtc")]
    public DateTimeOffset CreatedAtUtc { get; init; } = DateTimeOffset.UtcNow;

    [JsonPropertyName("expiresAtUtc")]
    public DateTimeOffset ExpiresAtUtc { get; init; } = DateTimeOffset.UtcNow.AddSeconds(30);

    [JsonPropertyName("reason")]
    public string Reason { get; init; } = string.Empty;
}

public record ActionApprovalResponse
{
    [JsonPropertyName("approvalId")]
    public string ApprovalId { get; init; } = string.Empty;

    [JsonPropertyName("actionId")]
    public string ActionId { get; init; } = string.Empty;

    [JsonPropertyName("actionType")]
    public string ActionType { get; init; } = string.Empty;

    [JsonPropertyName("parametersSha256")]
    public string ParametersSha256 { get; init; } = string.Empty;

    [JsonPropertyName("approved")]
    public bool Approved { get; init; }

    [JsonPropertyName("decisionSource")]
    public string DecisionSource { get; init; } = "UserExplicitConfirmation"; // UserExplicitConfirmation, TimeoutDenied, IntegrityMismatch, EmergencyStopDenied, ReplayDenied, TargetMismatch

    [JsonPropertyName("decidedAtUtc")]
    public DateTimeOffset DecidedAtUtc { get; init; } = DateTimeOffset.UtcNow;

    [JsonPropertyName("sessionId")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? SessionId { get; init; }

    [JsonPropertyName("stopGeneration")]
    public ulong StopGeneration { get; init; }

    [JsonPropertyName("rejectionReason")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? RejectionReason { get; init; }
}

public record ResumeExecutionRequest
{
    [JsonPropertyName("resumeId")]
    public string ResumeId { get; init; } = Guid.NewGuid().ToString("N");

    [JsonPropertyName("source")]
    public string Source { get; init; } = "FrontendButton"; // FrontendButton, UserExplicitConfirmation, AdminOverride

    [JsonPropertyName("reason")]
    public string Reason { get; init; } = "User requested execution resumption";

    [JsonPropertyName("sessionId")]
    public string SessionId { get; init; } = string.Empty;

    [JsonPropertyName("stopGeneration")]
    public ulong StopGeneration { get; init; }

    [JsonPropertyName("timestamp")]
    public DateTimeOffset Timestamp { get; init; } = DateTimeOffset.UtcNow;
}

public record ResumeExecutionResponse
{
    [JsonPropertyName("resumeId")]
    public string ResumeId { get; init; } = string.Empty;

    [JsonPropertyName("success")]
    public bool Success { get; init; }

    [JsonPropertyName("sessionId")]
    public string SessionId { get; init; } = string.Empty;

    [JsonPropertyName("stopGeneration")]
    public ulong StopGeneration { get; init; }

    [JsonPropertyName("errorMessage")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ErrorMessage { get; init; }

    [JsonPropertyName("timestamp")]
    public DateTimeOffset Timestamp { get; init; } = DateTimeOffset.UtcNow;
}

public record SimulatedActionRequest
{
    [JsonPropertyName("actionId")]
    public string ActionId { get; init; } = Guid.NewGuid().ToString("N");

    [JsonPropertyName("actionType")]
    public string ActionType { get; init; } = "SimulatedClick"; // SimulatedClick, SimulatedType, SimulatedScroll, SimulatedObservation

    [JsonPropertyName("parameters")]
    public Dictionary<string, string> Parameters { get; init; } = new();

    [JsonPropertyName("targetProcessName")]
    public string TargetProcessName { get; init; } = string.Empty;

    [JsonPropertyName("targetWindowTitle")]
    public string TargetWindowTitle { get; init; } = string.Empty;

    [JsonPropertyName("targetHwnd")]
    public long TargetHwnd { get; init; }

    [JsonPropertyName("targetProcessId")]
    public int TargetProcessId { get; init; }

    [JsonPropertyName("targetProcessCreationTime")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public DateTimeOffset? TargetProcessCreationTime { get; init; }

    [JsonPropertyName("sessionId")]
    public string SessionId { get; init; } = string.Empty;

    [JsonPropertyName("stopGeneration")]
    public ulong StopGeneration { get; init; }

    [JsonPropertyName("simulatedDurationMs")]
    public int SimulatedDurationMs { get; init; } = 100;

    [JsonPropertyName("approvalId")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ApprovalId { get; init; }
}

public record SimulatedActionResponse
{
    [JsonPropertyName("actionId")]
    public string ActionId { get; init; } = string.Empty;

    [JsonPropertyName("success")]
    public bool Success { get; init; }

    [JsonPropertyName("status")]
    public string Status { get; init; } = "Completed"; // Completed, Cancelled, Blocked, Failed

    [JsonPropertyName("errorMessage")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ErrorMessage { get; init; }

    [JsonPropertyName("executionDurationMs")]
    public double ExecutionDurationMs { get; init; }

    [JsonPropertyName("timestamp")]
    public DateTimeOffset Timestamp { get; init; } = DateTimeOffset.UtcNow;
}

public record ActionLifecycleNotification
{
    [JsonPropertyName("actionId")]
    public string ActionId { get; init; } = string.Empty;

    [JsonPropertyName("actionType")]
    public string ActionType { get; init; } = string.Empty;

    [JsonPropertyName("previousState")]
    public string PreviousState { get; init; } = string.Empty;

    [JsonPropertyName("currentState")]
    public string CurrentState { get; init; } = string.Empty;

    [JsonPropertyName("reason")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Reason { get; init; }

    [JsonPropertyName("timestamp")]
    public DateTimeOffset Timestamp { get; init; } = DateTimeOffset.UtcNow;
}

public record PanicHotkeyStatusNotification
{
    [JsonPropertyName("isAvailable")]
    public bool IsAvailable { get; init; }

    [JsonPropertyName("reason")]
    public string Reason { get; init; } = string.Empty;

    [JsonPropertyName("errorCode")]
    public int ErrorCode { get; init; }

    [JsonPropertyName("timestamp")]
    public DateTimeOffset Timestamp { get; init; } = DateTimeOffset.UtcNow;
}
