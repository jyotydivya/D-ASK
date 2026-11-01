using System.Text.Json;
using System.Text.Json.Serialization;

namespace DAsk.Protocol.IPC;

public record IpcEnvelope
{
    [JsonPropertyName("version")]
    public uint Version { get; init; } = IpcConstants.CurrentProtocolVersion;

    [JsonPropertyName("id")]
    public string Id { get; init; } = Guid.NewGuid().ToString("N");

    [JsonPropertyName("replyToId")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ReplyToId { get; init; }

    [JsonPropertyName("type")]
    public string Type { get; init; } = string.Empty;

    [JsonPropertyName("timestamp")]
    public DateTimeOffset Timestamp { get; init; } = DateTimeOffset.UtcNow;

    [JsonPropertyName("payload")]
    public JsonElement Payload { get; init; }

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    public static IpcEnvelope Create<T>(string type, T payload, string? replyToId = null)
    {
        var rawJson = JsonSerializer.SerializeToElement(payload, JsonOpts);
        return new IpcEnvelope
        {
            Type = type,
            ReplyToId = replyToId,
            Payload = rawJson
        };
    }

    public T? DeserializePayload<T>()
    {
        return JsonSerializer.Deserialize<T>(Payload.GetRawText(), JsonOpts);
    }

    public byte[] ToLengthPrefixedBytes()
    {
        byte[] payloadBytes = JsonSerializer.SerializeToUtf8Bytes(this, JsonOpts);
        if (payloadBytes.Length > IpcConstants.MaxMessageSizeBytes)
        {
            throw new InvalidOperationException($"Message size {payloadBytes.Length} exceeds maximum limit of {IpcConstants.MaxMessageSizeBytes} bytes.");
        }

        byte[] frame = new byte[IpcConstants.HeaderSizeBytes + payloadBytes.Length];
        BitConverter.TryWriteBytes(frame.AsSpan(0, 4), (uint)payloadBytes.Length);
        payloadBytes.CopyTo(frame, 4);
        return frame;
    }

    public static IpcEnvelope? FromJsonBytes(ReadOnlySpan<byte> bytes)
    {
        return JsonSerializer.Deserialize<IpcEnvelope>(bytes, JsonOpts);
    }
}

