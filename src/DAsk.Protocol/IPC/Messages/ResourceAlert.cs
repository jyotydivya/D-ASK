using System.Text.Json.Serialization;

namespace DAsk.Protocol.IPC.Messages;

public record ResourceAlert
{
    [JsonPropertyName("severity")]
    public string Severity { get; init; } = "Warning"; // "Warning", "Critical"

    [JsonPropertyName("reason")]
    public string Reason { get; init; } = string.Empty;

    [JsonPropertyName("availableMemoryBytes")]
    public ulong AvailableMemoryBytes { get; init; }

    [JsonPropertyName("thresholdBytes")]
    public ulong ThresholdBytes { get; init; }

    [JsonPropertyName("actionTaken")]
    public string ActionTaken { get; init; } = "None"; // "None", "DegradedMode", "ModelLoadBlocked", "CachePurged"

    [JsonPropertyName("isBlockedFromModelLoad")]
    public bool IsBlockedFromModelLoad { get; init; }

    [JsonPropertyName("timestamp")]
    public DateTimeOffset Timestamp { get; init; } = DateTimeOffset.UtcNow;
}

