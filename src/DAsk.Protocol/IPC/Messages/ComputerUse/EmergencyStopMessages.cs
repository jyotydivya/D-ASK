using System.Text.Json.Serialization;

namespace DAsk.Protocol.IPC.Messages.ComputerUse;

public record EmergencyStopRequest
{
    [JsonPropertyName("stopId")]
    public string StopId { get; init; } = Guid.NewGuid().ToString("N");

    [JsonPropertyName("source")]
    public string Source { get; init; } = "FrontendButton"; // FrontendButton, Hotkey, SafetyGuard, DaemonDisconnect

    [JsonPropertyName("reason")]
    public string Reason { get; init; } = "User requested emergency stop";

    [JsonPropertyName("timestamp")]
    public DateTimeOffset Timestamp { get; init; } = DateTimeOffset.UtcNow;
}

public record EmergencyStopResponse
{
    [JsonPropertyName("stopId")]
    public string StopId { get; init; } = string.Empty;

    [JsonPropertyName("success")]
    public bool Success { get; init; }

    [JsonPropertyName("activeActionsCancelled")]
    public int ActiveActionsCancelled { get; init; }

    [JsonPropertyName("queuedActionsCancelled")]
    public int QueuedActionsCancelled { get; init; }

    [JsonPropertyName("stopGeneration")]
    public ulong StopGeneration { get; init; }

    [JsonPropertyName("sessionId")]
    public string SessionId { get; init; } = string.Empty;

    [JsonPropertyName("timestamp")]
    public DateTimeOffset Timestamp { get; init; } = DateTimeOffset.UtcNow;
}
