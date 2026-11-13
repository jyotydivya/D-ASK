using System.Text.Json;
using System.Text.Json.Serialization;

namespace DAsk.Daemon.Research;

public record ActionMetadata
{
    [JsonPropertyName("agentName")]
    public required string AgentName { get; init; }

    [JsonPropertyName("toolName")]
    public required string ToolName { get; init; }

    [JsonPropertyName("parameters")]
    public JsonElement Parameters { get; init; }

    [JsonPropertyName("intentDescription")]
    public string? IntentDescription { get; init; }
}

public record RiskAssessment
{
    [JsonPropertyName("sideEffectRisk")]
    public string SideEffectRisk { get; init; } = "Low"; // None, Low, Medium, High, Critical

    [JsonPropertyName("reversibility")]
    public string Reversibility { get; init; } = "FullyReversible"; // FullyReversible, PartiallyReversible, Irreversible

    [JsonPropertyName("priorUncertainty")]
    public double PriorUncertainty { get; init; } = 0.0; // 0.0 to 1.0

    [JsonPropertyName("policyGateApproved")]
    public bool PolicyGateApproved { get; init; } = true;

    [JsonPropertyName("policyViolationReason")]
    public string? PolicyViolationReason { get; init; }
}

public record PreActionObservation
{
    [JsonPropertyName("observationTimestamp")]
    public DateTimeOffset ObservationTimestamp { get; init; } = DateTimeOffset.UtcNow;

    [JsonPropertyName("systemStateSnapshot")]
    public Dictionary<string, object?> SystemStateSnapshot { get; init; } = new();

    [JsonPropertyName("telemetry")]
    public Dictionary<string, object?> Telemetry { get; init; } = new();
}

public record ExecutionOutcome
{
    [JsonPropertyName("status")]
    public string Status { get; init; } = "Success"; // Success, Failure, Throttled, AbortedByPolicy, Timeout

    [JsonPropertyName("executionDurationMs")]
    public double ExecutionDurationMs { get; init; }

    [JsonPropertyName("rawOutput")]
    public JsonElement? RawOutput { get; init; }

    [JsonPropertyName("errorMessage")]
    public string? ErrorMessage { get; init; }
}

public record PostActionObservation
{
    [JsonPropertyName("observationTimestamp")]
    public DateTimeOffset ObservationTimestamp { get; init; } = DateTimeOffset.UtcNow;

    [JsonPropertyName("stateDivergenceDetected")]
    public bool StateDivergenceDetected { get; init; }

    [JsonPropertyName("observedChanges")]
    public List<string> ObservedChanges { get; init; } = new();
}

public record VerificationDecision
{
    [JsonPropertyName("verified")]
    public bool Verified { get; init; }

    [JsonPropertyName("verificationMethod")]
    public string VerificationMethod { get; init; } = "ProcessInspection"; // VisualInspection, FileExistenceCheck, ProcessInspection, ExitCodeCheck, SelfReported

    [JsonPropertyName("evidenceDescription")]
    public string? EvidenceDescription { get; init; }
}

public record RecoveryDecision
{
    [JsonPropertyName("recoveryRequired")]
    public bool RecoveryRequired { get; init; }

    [JsonPropertyName("recoveryStrategy")]
    public string? RecoveryStrategy { get; init; } // Retry, Rollback, AlternativeTool, EscalateToUser, AbortTask

    [JsonPropertyName("recoveryActionId")]
    public string? RecoveryActionId { get; init; }

    [JsonPropertyName("recoveryRationale")]
    public string? RecoveryRationale { get; init; }
}

public record FinalTaskOutcome
{
    [JsonPropertyName("taskCompleted")]
    public bool TaskCompleted { get; init; }

    [JsonPropertyName("terminalStatus")]
    public string TerminalStatus { get; init; } = "CompletedSuccessfully";

    [JsonPropertyName("totalActionsExecuted")]
    public int TotalActionsExecuted { get; init; }

    [JsonPropertyName("totalDurationMs")]
    public double TotalDurationMs { get; init; }
}

public record ExecutionEvidenceRecord
{
    [JsonPropertyName("schemaVersion")]
    public string SchemaVersion { get; init; } = "1.0.0";

    [JsonPropertyName("recordId")]
    public string RecordId { get; init; } = Guid.NewGuid().ToString();

    [JsonPropertyName("taskId")]
    public required string TaskId { get; init; }

    [JsonPropertyName("actionId")]
    public required string ActionId { get; init; }

    [JsonPropertyName("timestamp")]
    public DateTimeOffset Timestamp { get; init; } = DateTimeOffset.UtcNow;

    [JsonPropertyName("actionMetadata")]
    public required ActionMetadata ActionMetadata { get; init; }

    [JsonPropertyName("riskAssessment")]
    public required RiskAssessment RiskAssessment { get; init; }

    [JsonPropertyName("preActionObservation")]
    public required PreActionObservation PreActionObservation { get; init; }

    [JsonPropertyName("executionOutcome")]
    public required ExecutionOutcome ExecutionOutcome { get; init; }

    [JsonPropertyName("postActionObservation")]
    public required PostActionObservation PostActionObservation { get; init; }

    [JsonPropertyName("verificationDecision")]
    public required VerificationDecision VerificationDecision { get; init; }

    [JsonPropertyName("recoveryDecision")]
    public RecoveryDecision? RecoveryDecision { get; init; }

    [JsonPropertyName("finalTaskOutcome")]
    public FinalTaskOutcome? FinalTaskOutcome { get; init; }

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = false
    };

    public string ToJson() => JsonSerializer.Serialize(this, JsonOpts);

    public static ExecutionEvidenceRecord? FromJson(string json) =>
        JsonSerializer.Deserialize<ExecutionEvidenceRecord>(json, JsonOpts);
}

