using System.Text.Json.Serialization;

namespace DAsk.Protocol.IPC.Messages;

public record HeartbeatPing
{
    [JsonPropertyName("sequence")]
    public long Sequence { get; init; }

    [JsonPropertyName("timestamp")]
    public DateTimeOffset Timestamp { get; init; } = DateTimeOffset.UtcNow;
}

public record HeartbeatPong
{
    [JsonPropertyName("sequence")]
    public long Sequence { get; init; }

    [JsonPropertyName("pingTimestamp")]
    public DateTimeOffset PingTimestamp { get; init; }

    [JsonPropertyName("pongTimestamp")]
    public DateTimeOffset PongTimestamp { get; init; } = DateTimeOffset.UtcNow;
}

