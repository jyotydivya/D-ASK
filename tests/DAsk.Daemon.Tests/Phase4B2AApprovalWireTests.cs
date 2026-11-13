using DAsk.Daemon.Automation.Policy;
using DAsk.Protocol.IPC;
using DAsk.Protocol.IPC.Messages;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Xunit;

namespace DAsk.Daemon.Tests;

/// <summary>
/// Phase 4B-2A, wire level (the real named pipe and IpcClientSession): approval records cannot be created, decided or used by
/// an IPC client that is not the authenticated owner, and an invented approval id never authorizes an action over IPC.
/// Run alone with:  --filter "FullyQualifiedName~P4B2A_Wire_"
/// </summary>
public partial class PipeSecurityBehaviorTests
{
    private static async Task<SimulatedActionResponse> P4B2AExecuteAsync(Stream s, SimulatedActionRequest request)
    {
        await SendAsync(s, IpcEnvelope.Create(nameof(SimulatedActionRequest), request));
        var deadline = DateTime.UtcNow.AddSeconds(8);
        while (DateTime.UtcNow < deadline)
        {
            var (env, closed) = await ReadFrameAsync(s, deadline - DateTime.UtcNow);
            Assert.False(closed, "the daemon closed the connection");
            if (env?.Type == nameof(SimulatedActionResponse)) return env.DeserializePayload<SimulatedActionResponse>()!;
        }
        throw new TimeoutException("no SimulatedActionResponse");
    }

    private static SimulatedActionRequest P4B2ASimulated(string approvalId) => new()
    {
        ActionId = "act_h39_wire", ActionType = "SimulatedType", Parameters = new(H39Params), ApprovalId = approvalId,
        StopGeneration = 1, SimulatedDurationMs = 10,
    };

    [Fact]
    public async Task P4B2A_Wire_UnauthenticatedClient_CannotDecide_AndIsDisconnected()
    {
        await using var rig = await ApprovalWireRig.StartAsync();
        using var owner = await ConnectAsync(rig.PipeName);
        string ownerSession = (await HandshakeOkAsync(owner)).SessionToken;
        await MakeLiveAsync(owner);
        var task = rig.Policy.RequestApprovalAsync(H39Request("appr_4b2a_wire_unauth", ownerSession));

        using var stranger = await ConnectAsync(rig.PipeName);   // never sends a handshake
        await H39SendDecisionAsync(stranger, "appr_4b2a_wire_unauth", approved: true, claimedSession: ownerSession, rig.Policy);
        var (_, closed) = await DrainAsync(stranger, TimeSpan.FromSeconds(3));
        Assert.True(closed, "an unauthenticated client must be disconnected");
        Assert.False(task.IsCompleted);
        Assert.Equal(1, rig.Policy.PendingApprovalCount);
        Assert.Equal(0, rig.Policy.GrantedApprovalCount);
    }

    [Fact]
    public async Task P4B2A_Wire_AuthenticatedClient_CannotCreateApprovalRecords_OrGrantAnUnissuedId()
    {
        await using var rig = await ApprovalWireRig.StartAsync();
        using var c = await ConnectAsync(rig.PipeName);
        string session = (await HandshakeOkAsync(c)).SessionToken;
        await MakeLiveAsync(c);

        // There is no IPC path that registers an approval: a client-sent ActionApprovalRequest is refused as unsupported.
        // (The client reads each reply before sending again, as the HUD's read loop does: both ends flush, and a Windows pipe
        // flush waits until the other end has read.)
        await SendAsync(c, IpcEnvelope.Create(nameof(ActionApprovalRequest), H39Request("appr_4b2a_wire_forged", session)));
        var (replies, closed) = await DrainAsync(c, TimeSpan.FromMilliseconds(800));
        Assert.False(closed);
        var rejected = Assert.Single(replies, e => e.Type == nameof(MessageRejectedNotification));
        Assert.Equal("unsupported_message", rejected.DeserializePayload<MessageRejectedNotification>()!.Code);

        // Nor does a decision for an id the engine never issued create a record.
        await H39SendDecisionAsync(c, "appr_4b2a_wire_forged", approved: true, claimedSession: session);
        await DrainAsync(c, TimeSpan.FromMilliseconds(500));
        await H39SendDecisionAsync(c, "appr_4b2a_wire_invented", approved: true, claimedSession: session);
        await DrainAsync(c, TimeSpan.FromMilliseconds(500));
        Assert.Equal(0, rig.Policy.PendingApprovalCount);
        Assert.Equal(0, rig.Policy.GrantedApprovalCount);

        // And an action presenting such an id is blocked.
        var r = await P4B2AExecuteAsync(c, P4B2ASimulated("appr_4b2a_wire_forged"));
        Assert.False(r.Success);
        Assert.Equal("Blocked", r.Status);
        Assert.Contains("never granted", r.ErrorMessage);
    }

    [Fact]
    public async Task P4B2A_Wire_ValidApproval_AuthorizesExactlyOnce_ReplayIsBlocked()
    {
        await using var rig = await ApprovalWireRig.StartAsync();
        using var c = await ConnectAsync(rig.PipeName);
        string session = (await HandshakeOkAsync(c)).SessionToken;
        await MakeLiveAsync(c);

        var task = rig.Policy.RequestApprovalAsync(H39Request("appr_4b2a_wire_valid", session));
        await H39SendDecisionAsync(c, "appr_4b2a_wire_valid", approved: true, claimedSession: null, rig.Policy);
        var finished = await Task.WhenAny(task, Task.Delay(4000));
        Assert.True(ReferenceEquals(finished, task) && (await task).Approved, "the owner's approval should be granted");

        var tampered = await P4B2AExecuteAsync(c, P4B2ASimulated("appr_4b2a_wire_valid") with { Parameters = new() { ["text"] = "rm -rf" } });
        Assert.False(tampered.Success);
        Assert.Contains("hash mismatch", tampered.ErrorMessage);

        var first = await P4B2AExecuteAsync(c, P4B2ASimulated("appr_4b2a_wire_valid"));
        Assert.True(first.Success, first.ErrorMessage);
        var replay = await P4B2AExecuteAsync(c, P4B2ASimulated("appr_4b2a_wire_valid"));
        Assert.False(replay.Success);
        Assert.Contains("already been consumed", replay.ErrorMessage);
    }
}
