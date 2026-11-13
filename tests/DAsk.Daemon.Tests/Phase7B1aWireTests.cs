using System.IO.Pipes;
using System.Text.Json;
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
/// Phase 7B.1a at wire level: HUD liveness (F1), owner-only approval delivery and state (F3/F4), and explicit rejection
/// of unhandled messages (F6), over the real pipe with a fake HUD. The liveness monitor runs on a manual clock, so lease
/// expiry is exercised without sleeping. Nothing here performs desktop input.
/// Run alone with:  --filter "FullyQualifiedName~P7B1a_"
/// </summary>
public partial class PipeSecurityBehaviorTests
{
    // ───────────────────────── shared liveness helpers (also used by the adapted H38/H39/lifecycle tests) ─────────────

    private static HeartbeatPing ValidPing(long seq, DateTimeOffset? at = null) => new()
    {
        Sequence = seq,
        Timestamp = at ?? DateTimeOffset.UtcNow,
        EventLoopAck = seq - 1,
        HotkeyAck = seq - 1,
        HotkeyRegistered = true,
    };

    private static Task SendHotkeyAsync(Stream s, bool available) =>
        SendAsync(s, IpcEnvelope.Create(nameof(PanicHotkeyStatusNotification),
            new PanicHotkeyStatusNotification { IsAvailable = available, Reason = available ? "test hotkey registered" : "test hotkey failed", ErrorCode = available ? 0 : -1 }));

    private static async Task<IpcEnvelope> ReadUntilAsync(Stream s, string type, TimeSpan? timeout = null, List<IpcEnvelope>? seen = null)
    {
        var deadline = DateTime.UtcNow + (timeout ?? TimeSpan.FromSeconds(5));
        while (DateTime.UtcNow < deadline)
        {
            var (env, closed) = await ReadFrameAsync(s, deadline - DateTime.UtcNow);
            if (env == null) { Assert.False(closed, $"connection closed while waiting for {type}"); break; }
            seen?.Add(env);
            if (env.Type == type) return env;
        }
        throw new Xunit.Sdk.XunitException($"no {type} received");
    }

    private static async Task<HeartbeatPong> PingAsync(Stream s, HeartbeatPing ping)
    {
        await SendAsync(s, IpcEnvelope.Create(nameof(HeartbeatPing), ping));
        return (await ReadUntilAsync(s, nameof(HeartbeatPong))).DeserializePayload<HeartbeatPong>()!;
    }

    /// <summary>What a healthy HUD does after the handshake: confirm the hotkey, then send a valid heartbeat.</summary>
    private static async Task MakeLiveAsync(Stream s, long seq = 1, DateTimeOffset? at = null)
    {
        await SendHotkeyAsync(s, true);
        var pong = await PingAsync(s, ValidPing(seq, at));
        Assert.True(pong.LeaseRenewed, $"the heartbeat should have renewed the lease: {pong.Reason}");
    }

    private sealed class ManualClock
    {
        private DateTimeOffset _now = DateTimeOffset.UtcNow;
        public DateTimeOffset Now() { lock (this) return _now; }
        public void Advance(TimeSpan by) { lock (this) _now += by; }
    }

    private sealed class LivenessRig : IAsyncDisposable
    {
        public required NamedPipeServer Server { get; init; }
        public required ActionPolicyEngine Policy { get; init; }
        public required ActionExecutionEngine Engine { get; init; }
        public required HudLivenessMonitor Liveness { get; init; }
        public required ManualClock Clock { get; init; }
        public required string PipeName { get; init; }

        public static async Task<LivenessRig> StartAsync()
        {
            var opts = new DaemonOptions
            {
                PipeName = "test-p7b1a-" + Guid.NewGuid().ToString("N"),
                MaxConnectedClients = 4,
                TelemetryIntervalMs = 600_000,
                HandshakeTimeoutMs = 3000,
                AllowedClientImagePaths = { Environment.ProcessPath! },
            };
            var state = new RecordingStateManager();
            var policy = new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance, null);
            // Deliberately NOT SetPanicHotkeyStatus(true): availability must come from a live HUD only.
            var engine = new ActionExecutionEngine(NullLogger<ActionExecutionEngine>.Instance, state, policy, null,
                ActionExecutionEngine.MaxQueueCapacityDefault, 1);
            var clock = new ManualClock();
            var liveness = new HudLivenessMonitor(NullLogger.Instance, engine, policy, null,
                leaseMs: 12_000, maxSkewMs: 3_000, clock: clock.Now, startSweepTimer: false);
            var server = new NamedPipeServer(NullLogger<NamedPipeServer>.Instance, new FakeSystemMonitor(),
                new FakeResourceManager(), state, Microsoft.Extensions.Options.Options.Create(opts),
                executionEngine: engine, policyEngine: policy, peerVerifier: TestPeerVerifiers.AllowAll, livenessMonitor: liveness);
            await server.StartAsync(CancellationToken.None);
            return new LivenessRig { Server = server, Policy = policy, Engine = engine, Liveness = liveness, Clock = clock, PipeName = opts.PipeName };
        }

        public async ValueTask DisposeAsync()
        {
            try { await Server.StopAsync(CancellationToken.None); } catch { }
            try { Server.Dispose(); } catch { }
            try { Liveness.Dispose(); } catch { }
            try { Engine.Dispose(); } catch { }
        }
    }

    private static ActionApprovalRequest P7Request(string approvalId, string owner, TimeSpan? ttl = null) => new()
    {
        ApprovalId = approvalId,
        ActionId = "act_" + approvalId,
        ActionType = "SimulatedType",
        ActionParameters = new() { ["text"] = "hello world", ["field"] = "Search box" },
        TargetProcessName = "fixture.exe",
        TargetWindowTitle = "Fixture window",
        TargetHwnd = 0x1234,
        TargetProcessId = 4321,
        SessionId = owner,
        StopGeneration = 1,
        RiskLevel = "Elevated",
        Reason = "Phase 7B.1a wire test",
        ExpiresAtUtc = DateTimeOffset.UtcNow + (ttl ?? TimeSpan.FromSeconds(20)),
    };

    private static async Task<bool> WaitForAsync(Func<bool> condition, int timeoutMs = 4000)
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (DateTime.UtcNow < deadline)
        {
            if (condition()) return true;
            await Task.Delay(20);
        }
        return condition();
    }

    // ───────────────────────── F1: liveness ─────────────────────────

    [Fact]
    public async Task P7B1a_Wire_OpenPipeAndHotkeyReport_AreNotLiveness_NoActionAuthorized()
    {
        await using var rig = await LivenessRig.StartAsync();
        using var c = await ConnectAsync(rig.PipeName);
        string session = (await HandshakeOkAsync(c)).SessionToken;
        await SendHotkeyAsync(c, true);
        await Task.Delay(200);

        Assert.Equal(HudLivenessState.Unknown, rig.Liveness.GetState(session));
        Assert.False(rig.Engine.IsPanicHotkeyAvailable, "a hotkey report without a valid heartbeat must not establish availability");

        var res = await rig.Engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest { ActionId = "a1", ActionType = "SimulatedScroll", SimulatedDurationMs = 1 }, session);
        Assert.False(res.Success);
        Assert.Contains("liveness", res.ErrorMessage, StringComparison.OrdinalIgnoreCase);

        var approval = await rig.Policy.RequestApprovalAsync(P7Request("appr_p7_notlive", session));
        Assert.False(approval.Approved);
        Assert.Equal("SessionDisconnectedDenied", approval.DecisionSource);
    }

    [Fact]
    public async Task P7B1a_Wire_ValidHeartbeat_EstablishesLiveness_AndHotkeyAvailability()
    {
        await using var rig = await LivenessRig.StartAsync();
        using var c = await ConnectAsync(rig.PipeName);
        string session = (await HandshakeOkAsync(c)).SessionToken;
        await MakeLiveAsync(c, at: rig.Clock.Now());

        Assert.Equal(HudLivenessState.Live, rig.Liveness.GetState(session));
        Assert.True(rig.Engine.IsPanicHotkeyAvailable);
        var res = await rig.Engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest { ActionId = "a2", ActionType = "SimulatedScroll", SimulatedDurationMs = 1 }, session);
        Assert.True(res.Success, res.ErrorMessage);
    }

    [Fact]
    public async Task P7B1a_Wire_HudDisconnect_InvalidatesHotkeyAvailability_AndPendingApprovals()
    {
        await using var rig = await LivenessRig.StartAsync();
        Task<ActionApprovalResponse> pending;
        using (var c = await ConnectAsync(rig.PipeName))
        {
            string session = (await HandshakeOkAsync(c)).SessionToken;
            await MakeLiveAsync(c, at: rig.Clock.Now());
            Assert.True(rig.Engine.IsPanicHotkeyAvailable);
            pending = rig.Policy.RequestApprovalAsync(P7Request("appr_p7_disc", session));
            Assert.Equal(1, rig.Policy.PendingApprovalCount);
        } // the HUD process ends: on a named pipe, termination and disconnect look identical to the server

        Assert.True(await WaitForAsync(() => !rig.Engine.IsPanicHotkeyAvailable), "disconnect must withdraw panic-hotkey availability");
        Assert.True(await WaitForAsync(() => pending.IsCompleted));
        var r = await pending;
        Assert.False(r.Approved);
        Assert.Equal("SessionDisconnectedDenied", r.DecisionSource);
    }

    [Fact]
    public async Task P7B1a_Wire_SuspendedHud_PipeStillOpen_LeaseExpires_AuthorizationStops()
    {
        await using var rig = await LivenessRig.StartAsync();
        using var c = await ConnectAsync(rig.PipeName);
        string session = (await HandshakeOkAsync(c)).SessionToken;
        await MakeLiveAsync(c, at: rig.Clock.Now());
        var pending = rig.Policy.RequestApprovalAsync(P7Request("appr_p7_susp", session));
        var owned = await ReadUntilAsync(c, nameof(ActionApprovalRequest));

        // The HUD stops pinging (suspended) but the pipe stays open.
        rig.Clock.Advance(rig.Liveness.Lease + TimeSpan.FromSeconds(1));
        Assert.False(rig.Liveness.IsLive(session), "a lapsed lease is not live even before the sweep");
        rig.Liveness.Sweep();

        Assert.True(c.IsConnected, "test is vacuous: the pipe must still be open");
        Assert.Equal(HudLivenessState.Expired, rig.Liveness.GetState(session));
        Assert.False(rig.Engine.IsPanicHotkeyAvailable);

        var r = await pending.WaitAsync(TimeSpan.FromSeconds(3));
        Assert.False(r.Approved);
        Assert.Equal("SessionDisconnectedDenied", r.DecisionSource);
        var state = (await ReadUntilAsync(c, nameof(ApprovalStateNotification))).DeserializePayload<ApprovalStateNotification>()!;
        Assert.Equal(ApprovalStates.Disconnected, state.State);

        // No new authorization of any kind after expiry.
        var again = await rig.Policy.RequestApprovalAsync(P7Request("appr_p7_after", session));
        Assert.False(again.Approved);
        Assert.Equal("SessionDisconnectedDenied", again.DecisionSource);
        var act = await rig.Engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest { ActionId = "a3", ActionType = "SimulatedScroll" }, session);
        Assert.False(act.Success);
    }

    [Fact]
    public async Task P7B1a_Wire_DelayedHeartbeat_CannotRenewOrRevive()
    {
        await using var rig = await LivenessRig.StartAsync();
        using var c = await ConnectAsync(rig.PipeName);
        string session = (await HandshakeOkAsync(c)).SessionToken;
        await SendHotkeyAsync(c, true);

        // A ping generated 10 s ago (held in a buffer while the HUD was suspended) is stale.
        var delayed = await PingAsync(c, ValidPing(1, rig.Clock.Now() - TimeSpan.FromSeconds(10)));
        Assert.False(delayed.LeaseRenewed);
        Assert.Contains("stale", delayed.Reason);
        Assert.Equal(HudLivenessState.Unknown, rig.Liveness.GetState(session));

        // Live, then expire; a delayed ping must not revive it.
        await MakeLiveAsync(c, seq: 2, at: rig.Clock.Now());
        rig.Clock.Advance(rig.Liveness.Lease + TimeSpan.FromSeconds(1));
        rig.Liveness.Sweep();
        await SendHotkeyAsync(c, true);
        var late = await PingAsync(c, ValidPing(3, rig.Clock.Now() - TimeSpan.FromSeconds(13)));
        Assert.False(late.LeaseRenewed);
        Assert.Equal(HudLivenessState.Expired, rig.Liveness.GetState(session));
        Assert.False(rig.Engine.IsPanicHotkeyAvailable);
    }

    [Fact]
    public async Task P7B1a_Wire_HeartbeatReplay_IsRejected()
    {
        await using var rig = await LivenessRig.StartAsync();
        using var c = await ConnectAsync(rig.PipeName);
        string session = (await HandshakeOkAsync(c)).SessionToken;
        await MakeLiveAsync(c, seq: 5, at: rig.Clock.Now());

        rig.Clock.Advance(TimeSpan.FromSeconds(8));
        var replay = await PingAsync(c, ValidPing(5, rig.Clock.Now()));
        Assert.False(replay.LeaseRenewed);
        Assert.Contains("replayed", replay.Reason);
        var older = await PingAsync(c, ValidPing(4, rig.Clock.Now()));
        Assert.False(older.LeaseRenewed);

        // Neither renewed the lease: it still lapses on its original schedule.
        rig.Clock.Advance(TimeSpan.FromSeconds(5));
        Assert.False(rig.Liveness.IsLive(session));
    }

    [Fact]
    public async Task P7B1a_Wire_UnresponsiveEventLoop_ExpiresImmediately()
    {
        await using var rig = await LivenessRig.StartAsync();
        using var c = await ConnectAsync(rig.PipeName);
        string session = (await HandshakeOkAsync(c)).SessionToken;
        await MakeLiveAsync(c, seq: 1, at: rig.Clock.Now());

        // Ping 2 arrives, but the UI event loop never acknowledged probe 1 (it is hung).
        var hung = await PingAsync(c, new HeartbeatPing { Sequence = 2, Timestamp = rig.Clock.Now(), EventLoopAck = 0, HotkeyAck = 1, HotkeyRegistered = true });
        Assert.False(hung.LeaseRenewed);
        Assert.Contains("event loop", hung.Reason);
        Assert.Equal(HudLivenessState.Expired, rig.Liveness.GetState(session));
        Assert.True(await WaitForAsync(() => !rig.Engine.IsPanicHotkeyAvailable));

        // Same for the panic-hotkey message loop.
        await MakeLiveAsync(c, seq: 3, at: rig.Clock.Now());
        var hotkeyHung = await PingAsync(c, new HeartbeatPing { Sequence = 4, Timestamp = rig.Clock.Now(), EventLoopAck = 3, HotkeyAck = 1, HotkeyRegistered = true });
        Assert.False(hotkeyHung.LeaseRenewed);
        Assert.Contains("hotkey loop", hotkeyHung.Reason);
        Assert.Equal(HudLivenessState.Expired, rig.Liveness.GetState(session));
    }

    [Fact]
    public async Task P7B1a_Wire_HotkeyRegistrationFailure_NeverLive_AndWithdrawalExpiresAtOnce()
    {
        await using var rig = await LivenessRig.StartAsync();
        using var c = await ConnectAsync(rig.PipeName);
        string session = (await HandshakeOkAsync(c)).SessionToken;

        await SendHotkeyAsync(c, false);
        var p1 = await PingAsync(c, ValidPing(1, rig.Clock.Now()) with { HotkeyRegistered = false });
        Assert.False(p1.LeaseRenewed);
        var p2 = await PingAsync(c, ValidPing(2, rig.Clock.Now()));   // claims registered, but the session reported failure
        Assert.False(p2.LeaseRenewed);
        Assert.False(rig.Engine.IsPanicHotkeyAvailable);

        // A live HUD that reports its hotkey lost is expired at once.
        await MakeLiveAsync(c, seq: 3, at: rig.Clock.Now());
        Assert.True(rig.Engine.IsPanicHotkeyAvailable);
        await SendHotkeyAsync(c, false);
        Assert.True(await WaitForAsync(() => !rig.Engine.IsPanicHotkeyAvailable));
        Assert.Equal(HudLivenessState.Expired, rig.Liveness.GetState(session));
    }

    [Fact]
    public async Task P7B1a_Wire_Recovery_NeedsFreshHotkeyConfirmation_AndFreshHeartbeat()
    {
        await using var rig = await LivenessRig.StartAsync();
        using var c = await ConnectAsync(rig.PipeName);
        string session = (await HandshakeOkAsync(c)).SessionToken;
        await MakeLiveAsync(c, seq: 1, at: rig.Clock.Now());
        rig.Clock.Advance(rig.Liveness.Lease + TimeSpan.FromSeconds(1));
        rig.Liveness.Sweep();

        var pingOnly = await PingAsync(c, ValidPing(2, rig.Clock.Now()));
        Assert.False(pingOnly.LeaseRenewed, "a heartbeat alone must not restore liveness after expiry");
        Assert.Contains("hotkey registration confirmation", pingOnly.Reason);

        await MakeLiveAsync(c, seq: 3, at: rig.Clock.Now());
        Assert.Equal(HudLivenessState.Live, rig.Liveness.GetState(session));
        Assert.True(rig.Engine.IsPanicHotkeyAvailable);
    }

    [Fact]
    public async Task P7B1a_Wire_Reconnection_StartsUnknown_AndRestoresNoEarlierAuthorization()
    {
        await using var rig = await LivenessRig.StartAsync();
        string oldSession;
        Task<ActionApprovalResponse> pending;
        using (var first = await ConnectAsync(rig.PipeName))
        {
            oldSession = (await HandshakeOkAsync(first)).SessionToken;
            await MakeLiveAsync(first, at: rig.Clock.Now());
            pending = rig.Policy.RequestApprovalAsync(P7Request("appr_p7_recon", oldSession));
        }
        Assert.True(await WaitForAsync(() => pending.IsCompleted && !rig.Engine.IsPanicHotkeyAvailable));

        using var second = await ConnectAsync(rig.PipeName);
        string newSession = (await HandshakeOkAsync(second)).SessionToken;
        Assert.NotEqual(oldSession, newSession);
        Assert.Equal(HudLivenessState.Unknown, rig.Liveness.GetState(newSession));
        Assert.False(rig.Engine.IsPanicHotkeyAvailable, "reconnection alone must not restore availability");
        Assert.Equal(0, rig.Policy.PendingApprovalCount);
        Assert.Equal(0, rig.Policy.GrantedApprovalCount);

        // The old approval cannot be decided from the new session, even once live.
        await MakeLiveAsync(second, at: rig.Clock.Now());
        await SendAsync(second, IpcEnvelope.Create(nameof(ActionApprovalResponse), new ActionApprovalResponse
        { ApprovalId = "appr_p7_recon", ActionId = "act_appr_p7_recon", Approved = true }));
        var answer = (await ReadUntilAsync(second, nameof(ApprovalStateNotification))).DeserializePayload<ApprovalStateNotification>()!;
        Assert.False(answer.DecisionAccepted);
        Assert.Equal(0, rig.Policy.GrantedApprovalCount);
    }

    [Fact]
    public async Task P7B1a_Wire_EmergencyStopDuringLeaseExpiry_StaysLatched()
    {
        await using var rig = await LivenessRig.StartAsync();
        using var c = await ConnectAsync(rig.PipeName);
        await HandshakeOkAsync(c);
        await MakeLiveAsync(c, at: rig.Clock.Now());

        await SendAsync(c, IpcEnvelope.Create(nameof(EmergencyStopRequest), new EmergencyStopRequest { StopId = "p7_stop", Source = "Hotkey", Reason = "test" }));
        await ReadUntilAsync(c, nameof(EmergencyStopResponse));
        Assert.True(rig.Engine.IsEmergencyStopped);

        rig.Clock.Advance(rig.Liveness.Lease + TimeSpan.FromSeconds(1));
        rig.Liveness.Sweep();
        Assert.True(rig.Engine.IsEmergencyStopped, "lease expiry must not touch the stop latch");

        // Liveness recovering does not resume anything.
        await MakeLiveAsync(c, seq: 2, at: rig.Clock.Now());
        Assert.True(rig.Engine.IsEmergencyStopped, "only an explicit, validated Resume clears the latch");
    }

    // ───────────────────────── F3/F4: owner-only exact operation and terminal states ─────────────────────────

    [Fact]
    public async Task P7B1a_Wire_ApprovalGoesToOwnerOnly_WithCanonicalAction_AndStateUpdates()
    {
        await using var rig = await LivenessRig.StartAsync();
        using var a = await ConnectAsync(rig.PipeName);
        using var b = await ConnectAsync(rig.PipeName);
        string sa = (await HandshakeOkAsync(a)).SessionToken;
        await HandshakeOkAsync(b);
        await MakeLiveAsync(a, at: rig.Clock.Now());
        await MakeLiveAsync(b, at: rig.Clock.Now());

        var task = rig.Policy.RequestApprovalAsync(P7Request("appr_p7_owner", sa) with { ParametersSha256 = "", ActionDigest = "forged", CanonicalAction = "{}" });
        var req = (await ReadUntilAsync(a, nameof(ActionApprovalRequest))).DeserializePayload<ActionApprovalRequest>()!;

        // The daemon replaced the caller's digest and canonical text with its own.
        Assert.NotEqual("forged", req.ActionDigest);
        Assert.Equal(ActionPolicyEngine.BuildCanonicalAction(req with { ActionDigest = null, CanonicalAction = null }).Digest, req.ActionDigest);
        using (var doc = JsonDocument.Parse(req.CanonicalAction!))
        {
            Assert.Equal("hello world", doc.RootElement.GetProperty("parameters").GetProperty("text").GetString());
            Assert.Equal("Fixture window", doc.RootElement.GetProperty("target").GetProperty("windowTitle").GetString());
        }
        Assert.True(req.ExpiresAtUtc - req.CreatedAtUtc <= ActionPolicyEngine.MaxApprovalTtl);

        var (bFrames, _) = await DrainAsync(b, TimeSpan.FromMilliseconds(500));
        Assert.DoesNotContain(bFrames, f => f.Type == nameof(ActionApprovalRequest));

        await SendAsync(a, IpcEnvelope.Create(nameof(ActionApprovalResponse), new ActionApprovalResponse
        {
            ApprovalId = req.ApprovalId, ActionId = req.ActionId, ActionType = req.ActionType,
            ParametersSha256 = req.ParametersSha256, ActionDigest = req.ActionDigest, Approved = true,
        }));
        var granted = await task.WaitAsync(TimeSpan.FromSeconds(3));
        Assert.True(granted.Approved);
        var state = (await ReadUntilAsync(a, nameof(ApprovalStateNotification))).DeserializePayload<ApprovalStateNotification>()!;
        Assert.Equal(ApprovalStates.Approved, state.State);

        // A duplicate decision authorizes nothing more and is answered.
        await SendAsync(a, IpcEnvelope.Create(nameof(ActionApprovalResponse), new ActionApprovalResponse
        {
            ApprovalId = req.ApprovalId, ActionId = req.ActionId, ParametersSha256 = req.ParametersSha256, ActionDigest = req.ActionDigest, Approved = true,
        }));
        var dup = (await ReadUntilAsync(a, nameof(ApprovalStateNotification))).DeserializePayload<ApprovalStateNotification>()!;
        Assert.False(dup.DecisionAccepted);
        Assert.Equal(ApprovalStates.Approved, dup.State);
        Assert.Equal(1, rig.Policy.GrantedApprovalCount);
    }

    [Fact]
    public async Task P7B1a_Wire_ExpiredApproval_IsReported_AndLateDecisionRejected()
    {
        await using var rig = await LivenessRig.StartAsync();
        using var a = await ConnectAsync(rig.PipeName);
        string sa = (await HandshakeOkAsync(a)).SessionToken;
        await MakeLiveAsync(a, at: rig.Clock.Now());

        var task = rig.Policy.RequestApprovalAsync(P7Request("appr_p7_exp", sa, TimeSpan.FromMilliseconds(300)));
        var req = (await ReadUntilAsync(a, nameof(ActionApprovalRequest))).DeserializePayload<ActionApprovalRequest>()!;
        var expired = (await ReadUntilAsync(a, nameof(ApprovalStateNotification))).DeserializePayload<ApprovalStateNotification>()!;
        Assert.Equal(ApprovalStates.Expired, expired.State);
        Assert.Equal("TimeoutDenied", (await task).DecisionSource);

        await SendAsync(a, IpcEnvelope.Create(nameof(ActionApprovalResponse), new ActionApprovalResponse
        {
            ApprovalId = req.ApprovalId, ActionId = req.ActionId, ParametersSha256 = req.ParametersSha256, ActionDigest = req.ActionDigest, Approved = true,
        }));
        var late = (await ReadUntilAsync(a, nameof(ApprovalStateNotification))).DeserializePayload<ApprovalStateNotification>()!;
        Assert.False(late.DecisionAccepted);
        Assert.Equal(ApprovalStates.Expired, late.State);
        Assert.Equal(0, rig.Policy.GrantedApprovalCount);
    }

    [Fact]
    public async Task P7B1a_Wire_EmergencyStop_InvalidatesPending_AndOwnerIsTold()
    {
        await using var rig = await LivenessRig.StartAsync();
        using var a = await ConnectAsync(rig.PipeName);
        string sa = (await HandshakeOkAsync(a)).SessionToken;
        await MakeLiveAsync(a, at: rig.Clock.Now());
        var task = rig.Policy.RequestApprovalAsync(P7Request("appr_p7_stop", sa));
        await ReadUntilAsync(a, nameof(ActionApprovalRequest));

        await SendAsync(a, IpcEnvelope.Create(nameof(EmergencyStopRequest), new EmergencyStopRequest { StopId = "p7_stop2", Source = "Hotkey", Reason = "test" }));
        var state = (await ReadUntilAsync(a, nameof(ApprovalStateNotification))).DeserializePayload<ApprovalStateNotification>()!;
        Assert.Equal(ApprovalStates.InvalidatedByEmergencyStop, state.State);
        Assert.False((await task).Approved);
    }

    // ───────────────────────── F6: nothing is dropped silently ─────────────────────────

    [Fact]
    public async Task P7B1a_Wire_TaskApproval_IsRejectedExplicitly_AndAuthorizesNothing()
    {
        await using var rig = await LivenessRig.StartAsync();
        using var a = await ConnectAsync(rig.PipeName);
        string sa = (await HandshakeOkAsync(a)).SessionToken;
        await MakeLiveAsync(a, at: rig.Clock.Now());
        var task = rig.Policy.RequestApprovalAsync(P7Request("appr_p7_legacy", sa));
        await ReadUntilAsync(a, nameof(ActionApprovalRequest));

        var legacy = IpcEnvelope.Create("TaskApproval", new { taskId = "appr_p7_legacy", approved = true });
        await SendAsync(a, legacy);
        var rej = await ReadUntilAsync(a, nameof(MessageRejectedNotification));
        var payload = rej.DeserializePayload<MessageRejectedNotification>()!;
        Assert.Equal("obsolete_authorization_message", payload.Code);
        Assert.Equal("TaskApproval", payload.RejectedType);
        Assert.Equal(legacy.Id, rej.ReplyToId);
        await Task.Delay(200);
        Assert.False(task.IsCompleted, "the obsolete message must not decide anything");
        Assert.Equal(0, rig.Policy.GrantedApprovalCount);

        await SendAsync(a, IpcEnvelope.Create("UserCommand", new { text = "hi" }));
        var unsupported = (await ReadUntilAsync(a, nameof(MessageRejectedNotification))).DeserializePayload<MessageRejectedNotification>()!;
        Assert.Equal("unsupported_message", unsupported.Code);
    }
}
