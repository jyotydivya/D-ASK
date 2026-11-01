using System.Text.Json;
using System.Text.Json.Serialization;

namespace DAsk.Daemon.Research;

public record SafetyAuditRecord
{
    [JsonPropertyName("eventId")]
    public string EventId { get; init; } = Guid.NewGuid().ToString("N");

    [JsonPropertyName("timestamp")]
    public DateTimeOffset Timestamp { get; init; } = DateTimeOffset.UtcNow;

    [JsonPropertyName("eventType")]
    public string EventType { get; init; } = string.Empty; // EmergencyStop, ExecutionResumed, ApprovalRequested, ApprovalDecided, ActionStateChange, PolicyViolation, SessionDisconnected

    [JsonPropertyName("source")]
    public string Source { get; init; } = string.Empty;

    [JsonPropertyName("actionId")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ActionId { get; init; }

    [JsonPropertyName("approvalId")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ApprovalId { get; init; }

    [JsonPropertyName("sessionId")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? SessionId { get; init; }

    [JsonPropertyName("stopGeneration")]
    public ulong StopGeneration { get; init; }

    [JsonPropertyName("riskLevel")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? RiskLevel { get; init; }

    [JsonPropertyName("parametersSha256")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ParametersSha256 { get; init; }

    [JsonPropertyName("decision")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Decision { get; init; }

    [JsonPropertyName("reason")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Reason { get; init; }

    [JsonPropertyName("detailsJson")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? DetailsJson { get; init; }

    public string ToJson() => JsonSerializer.Serialize(this);

    public static SafetyAuditRecord? FromJson(string json)
    {
        try
        {
            return JsonSerializer.Deserialize<SafetyAuditRecord>(json);
        }
        catch
        {
            return null;
        }
    }
}

