using System.IO.Pipes;
using DAsk.Daemon.Automation.Execution;
using DAsk.Daemon.Automation.Policy;
using DAsk.Daemon.Configuration;
using DAsk.Daemon.IPC;
using DAsk.Protocol.IPC;
using DAsk.Protocol.IPC.Messages;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace DAsk.Daemon.Tests;

/// <summary>
/// Phase 4B-1R.9b (H3-9), wire level: two authenticated sessions on the real pipe. The identity that counts is
/// the server-generated session id (the handshake's sessionToken), never anything inside the decision payload.
/// Run alone with:  --filter "FullyQualifiedName~H39_"
/// </summary>
public partial class PipeSecurityBehaviorTests
{
    private static readonly Dictionary<string, string> H39Params = new() { ["text"] = "hello" };

    private sealed class ApprovalWireRig : IAsyncDisposable
    {
        public required NamedPipeServer Server { get; init; }
        public required ActionPolicyEngine Policy { get; init; }
        public required ActionExecutionEngine Engine { get; init; }
        public required string PipeName { get; init; }

        public static async Task<ApprovalWireRig> StartAsync()
        {
            var opts = new DaemonOptions
            {
                PipeName = "test-h39-" + Guid.NewGuid().ToString("N"),
                MaxConnectedClients = 4,
                TelemetryIntervalMs = 600_000,
                HandshakeTimeoutMs = 1500,
                AllowedClientImagePaths = { Environment.ProcessPath! },
            };
            var state = new RecordingStateManager();
            var policy = new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance, null);
            var engine = new ActionExecutionEngine(NullLogger<ActionExecutionEngine>.Instance, state, policy, null,
                ActionExecutionEngine.MaxQueueCapacityDefault, 1);
            engine.SetPanicHotkeyStatus(true, "test hotkey", 0);
            var server = new NamedPipeServer(NullLogger<NamedPipeServer>.Instance, new FakeSystemMonitor(),
                new FakeResourceManager(), state, Microsoft.Extensions.Options.Options.Create(opts),
                executionEngine: engine, policyEngine: policy, peerVerifier: TestPeerVerifiers.AllowAll);
            await server.StartAsync(CancellationToken.None);
            return new ApprovalWireRig { Server = server, Policy = policy, Engine = engine, PipeName = opts.PipeName };
        }

        public async ValueTask DisposeAsync()
        {
            try { await Server.StopAsync(CancellationToken.None); } catch { }
            try { Server.Dispose(); } catch { }
            try { Engine.Dispose(); } catch { }
        }
    }

    private static ActionApprovalRequest H39Request(string approvalId, string ownerSessionId) => new()
    {
        ApprovalId = approvalId,
        ActionId = "act_h39_wire",
        ActionType = "SimulatedType",
        ActionParameters = H39Params,
        ParametersSha256 = ActionPolicyEngine.ComputeCanonicalHash(H39Params),
        SessionId = ownerSessionId,
        StopGeneration = 1,
        ExpiresAtUtc = DateTimeOffset.UtcNow.AddMinutes(1),
    };

    private static Task H39SendDecisionAsync(Stream s, string approvalId, bool approved, string? claimedSession, ActionPolicyEngine? policy = null) =>
        SendAsync(s, IpcEnvelope.Create(nameof(ActionApprovalResponse), new ActionApprovalResponse
        {
            ApprovalId = approvalId,
            ActionId = "act_h39_wire",
            ActionType = "SimulatedType",
            ParametersSha256 = ActionPolicyEngine.ComputeCanonicalHash(H39Params),
            Approved = approved,
            SessionId = claimedSession,
            StopGeneration = 1,
            // Phase 7B.1a: a correct HUD echoes the daemon's action digest.
            ActionDigest = policy != null && policy.TryGetPendingRequest(approvalId, out var pending) ? pending.ActionDigest : null,
        }));

    private static async Task<bool> H39WaitAsync(Func<bool> condition, int timeoutMs = 4000)
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (DateTime.UtcNow < deadline)
        {
            if (condition()) return true;
            await Task.Delay(20);
        }
        return condition();
    }

    [Fact]
    public void H39_Source_DecisionPath_IsOwnershipChecked_ConditionalRemoval_AndSessionComesFromTransport()
    {
        string root = RepoRoot();
        string policy = File.ReadAllText(Path.Combine(root, "src", "DAsk.Daemon", "Automation", "Policy", "ActionPolicyEngine.cs"));
        string session = File.ReadAllText(Path.Combine(root, "src", "DAsk.Daemon", "IPC", "IpcClientSession.cs"));

        int start = policy.IndexOf("public bool SubmitApprovalDecision(", StringComparison.Ordinal);
        int end = policy.IndexOf("private void AuditOwnershipViolation(", StringComparison.Ordinal);
        Assert.True(start > 0 && end > start);
        string decision = policy.Substring(start, end - start);

        // Exact-entry (compare-and-remove) removal, never a key-only TryRemove on the pending registry.
        Assert.Contains("_pendingApprovals.TryRemove(new KeyValuePair<string, CachedApproval>(", decision);
        Assert.DoesNotMatch(new System.Text.RegularExpressions.Regex(@"_pendingApprovals\.TryRemove\(\s*response\.ApprovalId"), decision);
        // The ownership comparison precedes the removal.
        Assert.True(decision.IndexOf("AuditOwnershipViolation(", StringComparison.Ordinal) <
                    decision.IndexOf("_pendingApprovals.TryRemove(", StringComparison.Ordinal));

        // The identity handed to the policy engine is the server-generated session id, not the payload's.
        var call = System.Text.RegularExpressions.Regex.Match(session,
            @"SubmitApprovalDecision\(\s*approvalDecision,\s*(?<caller>[^,]+),");
        Assert.True(call.Success, "IpcClientSession must pass a caller session to SubmitApprovalDecision");
        Assert.Equal("_sessionId", call.Groups["caller"].Value.Trim());
        Assert.DoesNotContain("approvalDecision.SessionId", session);

        // Exactly one production caller of the decision API.
        var callers = Directory.EnumerateFiles(Path.Combine(root, "src"), "*.cs", SearchOption.AllDirectories)
            .Where(f => !f.Contains(Path.DirectorySeparatorChar + "obj" + Path.DirectorySeparatorChar)
                        && !f.Contains(Path.DirectorySeparatorChar + "bin" + Path.DirectorySeparatorChar))
            .Where(f => File.ReadAllText(f).Contains(".SubmitApprovalDecision(", StringComparison.Ordinal))
            .Select(f => f.Substring(root.Length))
            .ToList();
        Assert.Equal(new[] { Path.DirectorySeparatorChar + Path.Combine("src", "DAsk.Daemon", "IPC", "IpcClientSession.cs") }, callers);
    }

    [Fact]
    public async Task H39_Wire_ForeignAuthenticatedSession_CannotDecide_OwnerCan_PayloadSessionIsIgnored()
    {
        await using var rig = await ApprovalWireRig.StartAsync();
        using var a = await ConnectAsync(rig.PipeName);
        using var b = await ConnectAsync(rig.PipeName);
        string sessionA = (await HandshakeOkAsync(a)).SessionToken;
        await MakeLiveAsync(a);
        string sessionB = (await HandshakeOkAsync(b)).SessionToken;
        await MakeLiveAsync(b);
        Assert.NotEqual(sessionA, sessionB);

        var task = rig.Policy.RequestApprovalAsync(H39Request("appr_h39_wire_1", sessionA));
        Assert.Equal(1, rig.Policy.PendingApprovalCount);

        // B knows the id and claims to be A inside the payload.
        await H39SendDecisionAsync(b, "appr_h39_wire_1", approved: true, claimedSession: sessionA, rig.Policy);
        await Task.Delay(400);
        Assert.False(task.IsCompleted, "a decision from another authenticated session must be ignored");
        Assert.Equal(1, rig.Policy.PendingApprovalCount);
        Assert.Equal(0, rig.Policy.GrantedApprovalCount);

        // A decides, while claiming to be B inside the payload: the transport identity is what counts.
        await H39SendDecisionAsync(a, "appr_h39_wire_1", approved: true, claimedSession: sessionB, rig.Policy);
        var finished = await Task.WhenAny(task, Task.Delay(4000));
        Assert.True(ReferenceEquals(finished, task), "the owner's decision should have been accepted");
        Assert.True((await task).Approved);
        Assert.Equal(1, rig.Policy.GrantedApprovalCount);
    }

    [Fact]
    public async Task H39_Wire_TwoOwners_EachCrossAttemptRefused_BothPendingStayIntact_ThenEachOwnerDecidesOwn()
    {
        await using var rig = await ApprovalWireRig.StartAsync();
        using var a = await ConnectAsync(rig.PipeName);
        using var b = await ConnectAsync(rig.PipeName);
        string sessionA = (await HandshakeOkAsync(a)).SessionToken;
        await MakeLiveAsync(a);
        string sessionB = (await HandshakeOkAsync(b)).SessionToken;
        await MakeLiveAsync(b);
        Assert.NotEqual(sessionA, sessionB);

        // 1. One pending approval owned by each session. Owners are the server-generated connection ids.
        var taskA = rig.Policy.RequestApprovalAsync(H39Request("appr_h39_wire_own_A", sessionA));
        var taskB = rig.Policy.RequestApprovalAsync(H39Request("appr_h39_wire_own_B", sessionB));
        Assert.Equal(2, rig.Policy.PendingApprovalCount);
        Assert.Equal(0, rig.Policy.GrantedApprovalCount);

        // 2. A tries to approve B's approval, with a payload that claims B's session.
        await H39SendDecisionAsync(a, "appr_h39_wire_own_B", approved: true, claimedSession: sessionB, rig.Policy);
        await Task.Delay(400);

        // 3. B's approval is untouched, A's is untouched, nothing was granted.
        Assert.False(taskB.IsCompleted, "A must not be able to decide B's approval");
        Assert.False(taskA.IsCompleted);
        Assert.Equal(2, rig.Policy.PendingApprovalCount);
        Assert.Equal(0, rig.Policy.GrantedApprovalCount);

        // 4. B tries to approve A's approval, with a payload that claims A's session.
        await H39SendDecisionAsync(b, "appr_h39_wire_own_A", approved: true, claimedSession: sessionA, rig.Policy);
        await Task.Delay(400);

        // 5. Still both pending, still nothing granted.
        Assert.False(taskA.IsCompleted, "B must not be able to decide A's approval");
        Assert.False(taskB.IsCompleted);
        Assert.Equal(2, rig.Policy.PendingApprovalCount);
        Assert.Equal(0, rig.Policy.GrantedApprovalCount);

        // 6. Each actual owner decides its own approval (payloads deliberately name the OTHER session).
        await H39SendDecisionAsync(a, "appr_h39_wire_own_A", approved: true, claimedSession: sessionB, rig.Policy);
        var doneA = await Task.WhenAny(taskA, Task.Delay(4000));
        Assert.True(ReferenceEquals(doneA, taskA), "A's own decision should have been accepted");
        Assert.True((await taskA).Approved);
        Assert.False(taskB.IsCompleted, "A's decision must not have touched B's approval");
        Assert.Equal(1, rig.Policy.PendingApprovalCount);
        Assert.Equal(1, rig.Policy.GrantedApprovalCount);

        await H39SendDecisionAsync(b, "appr_h39_wire_own_B", approved: true, claimedSession: sessionA, rig.Policy);
        var doneB = await Task.WhenAny(taskB, Task.Delay(4000));
        Assert.True(ReferenceEquals(doneB, taskB), "B's own decision should have been accepted");
        Assert.True((await taskB).Approved);

        // 7. Both completed; nothing pending; both granted.
        Assert.Equal(0, rig.Policy.PendingApprovalCount);
        Assert.Equal(2, rig.Policy.GrantedApprovalCount);
    }

    [Fact]
    public async Task H39_Wire_Reconnect_GetsNewIdentity_AndInheritsNothing()
    {
        await using var rig = await ApprovalWireRig.StartAsync();
        string oldSession;
        Task<ActionApprovalResponse> pending;
        using (var first = await ConnectAsync(rig.PipeName))
        {
            oldSession = (await HandshakeOkAsync(first)).SessionToken;
            await MakeLiveAsync(first);
            pending = rig.Policy.RequestApprovalAsync(H39Request("appr_h39_wire_2", oldSession));
        }   // connection dropped

        Assert.True(await H39WaitAsync(() => pending.IsCompleted), "disconnect must invalidate the session's pending approvals");
        Assert.Equal("SessionDisconnectedDenied", (await pending).DecisionSource);

        using var second = await ConnectAsync(rig.PipeName);
        string newSession = (await HandshakeOkAsync(second)).SessionToken;
        Assert.NotEqual(oldSession, newSession);

        await H39SendDecisionAsync(second, "appr_h39_wire_2", approved: true, claimedSession: oldSession, rig.Policy);
        await Task.Delay(300);
        Assert.Equal(0, rig.Policy.GrantedApprovalCount);
        Assert.Equal(0, rig.Policy.PendingApprovalCount);
    }
}
