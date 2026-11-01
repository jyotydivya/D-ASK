using System.Text.Json.Serialization;

namespace DAsk.Protocol.IPC.Messages;

public record HandshakeRequest
{
    [JsonPropertyName("clientName")]
    public string ClientName { get; init; } = "DAsk.HUD.Native";

    [JsonPropertyName("protocolVersion")]
    public uint ProtocolVersion { get; init; } = IpcConstants.CurrentProtocolVersion;

    [JsonPropertyName("clientProcessId")]
    public int ClientProcessId { get; init; } = Environment.ProcessId;

    [JsonPropertyName("capabilities")]
    public string[] Capabilities { get; init; } = ["hud_v1", "wgpu_directx12", "telemetry_listener"];

    [JsonPropertyName("isEmergencyStopped")]
    public bool IsEmergencyStopped { get; init; } = false;

    [JsonPropertyName("stopId")]
    public string? StopId { get; init; }

    [JsonPropertyName("stopReason")]
    public string? StopReason { get; init; }

    [JsonPropertyName("stopGeneration")]
    public ulong StopGeneration { get; init; } = 0;
}

public record HandshakeResponse
{
    [JsonPropertyName("status")]
    public string Status { get; init; } = "Accepted"; // Accepted, Rejected

    [JsonPropertyName("protocolVersion")]
    public uint ProtocolVersion { get; init; } = IpcConstants.CurrentProtocolVersion;

    [JsonPropertyName("daemonProcessId")]
    public int DaemonProcessId { get; init; } = Environment.ProcessId;

    [JsonPropertyName("sessionToken")]
    public string SessionToken { get; init; } = string.Empty;

    [JsonPropertyName("message")]
    public string? Message { get; init; }

    [JsonPropertyName("isEmergencyStopped")]
    public bool IsEmergencyStopped { get; init; } = false;

    [JsonPropertyName("stopGeneration")]
    public ulong StopGeneration { get; init; } = 1;
}

