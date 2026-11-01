using System.Text.Json;
using DAsk.Protocol.IPC;
using DAsk.Protocol.IPC.Messages;
using Xunit;

namespace DAsk.Daemon.Tests;

public class IpcProtocolTests
{
    [Fact]
    public void Envelope_Serialization_Roundtrip_PreservesAllFields()
    {
        var handshake = new HandshakeRequest
        {
            ClientName = "Test.HUD",
            ProtocolVersion = 1,
            ClientProcessId = 1234,
            Capabilities = ["hud_v1", "wgpu"]
        };

        var envelope = IpcEnvelope.Create(nameof(HandshakeRequest), handshake);
        byte[] frame = envelope.ToLengthPrefixedBytes();

        Assert.True(frame.Length > IpcConstants.HeaderSizeBytes);

        uint length = BitConverter.ToUInt32(frame.AsSpan(0, 4));
        Assert.Equal((uint)(frame.Length - 4), length);

        var deserialized = IpcEnvelope.FromJsonBytes(frame.AsSpan(4));
        Assert.NotNull(deserialized);
        Assert.Equal(envelope.Id, deserialized.Id);
        Assert.Equal(nameof(HandshakeRequest), deserialized.Type);
        Assert.Equal(1u, deserialized.Version);

        var payload = deserialized.DeserializePayload<HandshakeRequest>();
        Assert.NotNull(payload);
        Assert.Equal("Test.HUD", payload.ClientName);
        Assert.Equal(1234, payload.ClientProcessId);
        Assert.Equal(new string[] { "hud_v1", "wgpu" }, payload.Capabilities);
    }

    [Fact]
    public void Envelope_Rejects_MessagesExceedingMaxLimit()
    {
        // Allocate a payload slightly larger than 1 MB
        var hugeData = new string('A', IpcConstants.MaxMessageSizeBytes + 100);
        var envelope = IpcEnvelope.Create("HugeMessage", new { Data = hugeData });

        var ex = Assert.Throws<InvalidOperationException>(() => envelope.ToLengthPrefixedBytes());
        Assert.Contains("exceeds maximum limit", ex.Message);
    }

    [Fact]
    public void StateRestore_Roundtrip_DeserializesSuccessfully()
    {
        var request = new StateRestoreRequest
        {
            LastKnownSeq = 42,
            ClientStatus = "Active"
        };

        var envelope = IpcEnvelope.Create(nameof(StateRestoreRequest), request);
        var restored = envelope.DeserializePayload<StateRestoreRequest>();

        Assert.NotNull(restored);
        Assert.Equal(42, restored.LastKnownSeq);
        Assert.Equal("Active", restored.ClientStatus);
    }
}
