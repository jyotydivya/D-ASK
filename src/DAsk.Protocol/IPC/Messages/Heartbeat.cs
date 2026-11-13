using System.Text.Json.Serialization;

namespace DAsk.Protocol.IPC.Messages;

/// <summary>
/// HUD liveness proof (Phase 7B.1a). A ping proves more than an open pipe: before each ping the HUD posts probe
/// <c>n-1</c> to its UI event loop and to its panic-hotkey message loop, and ping <c>n</c> carries the last probe
/// each loop acknowledged. A hung loop stops acknowledging, so its pings stop renewing the daemon's lease.
/// Old HUDs omit the proof fields; their pings therefore never establish liveness (fail closed).
/// </summary>
public record HeartbeatPing
{
    [JsonPropertyName("sequence")]
    public long Sequence { get; init; }

    [JsonPropertyName("timestamp")]
    public DateTimeOffset Timestamp { get; init; } = DateTimeOffset.UtcNow;

    /// <summary>Last liveness probe the HUD's UI event loop acknowledged.</summary>
    [JsonPropertyName("eventLoopAck")]
    public long EventLoopAck { get; init; }

    /// <summary>Last liveness probe the panic-hotkey message loop acknowledged.</summary>
    [JsonPropertyName("hotkeyAck")]
    public long HotkeyAck { get; init; }

    /// <summary>The panic hotkey is registered by the HUD right now.</summary>
    [JsonPropertyName("hotkeyRegistered")]
    public bool HotkeyRegistered { get; init; }
}

public record HeartbeatPong
{
    [JsonPropertyName("sequence")]
    public long Sequence { get; init; }

    [JsonPropertyName("pingTimestamp")]
    public DateTimeOffset PingTimestamp { get; init; }

    [JsonPropertyName("pongTimestamp")]
    public DateTimeOffset PongTimestamp { get; init; } = DateTimeOffset.UtcNow;

    /// <summary>Whether this ping renewed the HUD liveness lease (diagnostic only; the daemon is authoritative).</summary>
    [JsonPropertyName("leaseRenewed")]
    public bool LeaseRenewed { get; init; }

    [JsonPropertyName("reason")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Reason { get; init; }
}

/// <summary>
/// Sent in reply to any message the daemon does not handle, so nothing (in particular nothing authorization-related)
/// is ever silently dropped. Informational only: it grants nothing.
/// </summary>
public record MessageRejectedNotification
{
    [JsonPropertyName("rejectedType")]
    public string RejectedType { get; init; } = string.Empty;

    /// <summary><c>unsupported_message</c>, or <c>obsolete_authorization_message</c> for the retired TaskApproval path.</summary>
    [JsonPropertyName("code")]
    public string Code { get; init; } = "unsupported_message";

    [JsonPropertyName("message")]
    public string Message { get; init; } = string.Empty;

    [JsonPropertyName("timestamp")]
    public DateTimeOffset Timestamp { get; init; } = DateTimeOffset.UtcNow;
}
