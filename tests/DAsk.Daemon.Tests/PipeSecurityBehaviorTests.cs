using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using DAsk.Daemon.Automation.Execution;
using DAsk.Daemon.Automation.Policy;
using DAsk.Daemon.Configuration;
using DAsk.Daemon.IPC;
using DAsk.Daemon.ResourceManagement;
using DAsk.Daemon.State;
using DAsk.Daemon.Telemetry;
using DAsk.Protocol.IPC;
using DAsk.Protocol.IPC.Messages;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Microsoft.Win32.SafeHandles;
using Xunit;
using Xunit.Abstractions;

namespace DAsk.Daemon.Tests;

/// <summary>
/// Phase 4B-1R.8 (H3): behavioral tests of the real NamedPipeServer over real pipes.
/// They exercise the actual pipe: real opens (including under a restricted token and over the
/// SMB path), real message sequences, and real engine state.
/// </summary>
public partial class PipeSecurityBehaviorTests
{
    private readonly ITestOutputHelper _output;
    public PipeSecurityBehaviorTests(ITestOutputHelper output) => _output = output;

    // ───────────────────────── fakes & harness ─────────────────────────

    private sealed class FakeSystemMonitor : ISystemMonitor
    {
        public Task<SystemRamMetrics> GetRamMetricsAsync(CancellationToken c = default) => throw new NotSupportedException();
        public Task<CpuMetrics> GetCpuMetricsAsync(CancellationToken c = default) => throw new NotSupportedException();
        public Task<GpuMetrics> GetGpuMetricsAsync(CancellationToken c = default) => throw new NotSupportedException();
        public ProcessMemoryMetrics GetProcessMemoryMetrics() => throw new NotSupportedException();
        public Task<TelemetryUpdate> CaptureCompleteTelemetryAsync(string s, CancellationToken c = default) => throw new NotSupportedException();
    }

    private sealed class FakeResourceManager : IResourceManager
    {
        public ResourceSeverity CurrentSeverity => ResourceSeverity.Normal;
        public bool IsDegradedMode => false;
        public ulong TotalActiveReservationsBytes => 0;
        public Task<ResourceSeverity> EvaluateCurrentResourcesAsync(CancellationToken c = default) => throw new NotSupportedException();
        public Task<ModelAllocationCheckResult> CanAllocateModelAsync(string m, ulong b, CancellationToken c = default) => throw new NotSupportedException();
        public Task<ModelAllocationCheckResult> TryAcquireReservationAsync(string m, ulong b, CancellationToken c = default) => throw new NotSupportedException();
        public void ReleaseReservation(MemoryReservationLease lease) { }
        public void RegisterSubsystemAllocation(SubsystemType s, string n, ulong b) { }
        public void UnregisterSubsystemAllocation(SubsystemType s, string n) { }
        public IReadOnlyList<SubsystemAllocationRecord> GetSubsystemAllocations() => Array.Empty<SubsystemAllocationRecord>();
        public event EventHandler<ResourceAlert>? ResourceAlertTriggered { add { } remove { } }
    }

    private sealed class RecordingStateManager : IStateManager
    {
        private int _mutations;
        public int Mutations => Volatile.Read(ref _mutations);
        public string ActiveStatus { get; private set; } = "Normal";
        public string OrbMode { get; private set; } = "idle";
        public long CurrentSequenceNumber => 1;
        public event EventHandler<StateUpdate>? StateChanged { add { } remove { } }
        public void SetStatus(string status, string? orbMode = null) { Interlocked.Increment(ref _mutations); ActiveStatus = status; if (orbMode != null) OrbMode = orbMode; }
        public void AddOrUpdateTask(string id, string t, string s) => Interlocked.Increment(ref _mutations);
        public void RemoveTask(string id) => Interlocked.Increment(ref _mutations);
        public StateRestoreResponse CreateStateSnapshot() => new();
        public bool RestoreClientState(StateRestoreRequest r, out StateRestoreResponse resp) { Interlocked.Increment(ref _mutations); resp = new(); return true; }
    }

    private sealed class Harness : IAsyncDisposable
    {
        public required string PipeName { get; init; }
        public required NamedPipeServer Server { get; init; }
        public required ActionExecutionEngine Engine { get; init; }
        public required RecordingStateManager State { get; init; }
        public required DaemonOptions Config { get; init; }

        public static async Task<Harness> StartAsync(Action<DaemonOptions>? configure = null, string? pipeName = null, IPipePeerVerifier? verifier = null)
        {
            var opts = new DaemonOptions
            {
                PipeName = pipeName ?? ("test-h3-" + Guid.NewGuid().ToString("N")),
                MaxConnectedClients = 4,
                TelemetryIntervalMs = 600_000,
                HandshakeTimeoutMs = 1500,
                AllowedClientImagePaths = new List<string> { Environment.ProcessPath! },
            };
            configure?.Invoke(opts);

            var state = new RecordingStateManager();
            var policy = new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance, null);
            var engine = new ActionExecutionEngine(NullLogger<ActionExecutionEngine>.Instance, state, policy, null,
                ActionExecutionEngine.MaxQueueCapacityDefault, 1);
            engine.SetPanicHotkeyStatus(true, "test hotkey", 0);

            var server = new NamedPipeServer(NullLogger<NamedPipeServer>.Instance, new FakeSystemMonitor(),
                new FakeResourceManager(), state, Microsoft.Extensions.Options.Options.Create(opts),
                executionEngine: engine, policyEngine: policy, peerVerifier: verifier);
            await server.StartAsync(CancellationToken.None);
            return new Harness { PipeName = opts.PipeName, Server = server, Engine = engine, State = state, Config = opts };
        }

        public async ValueTask DisposeAsync()
        {
            try { await Server.StopAsync(CancellationToken.None); } catch { }
            try { Server.Dispose(); } catch { }
            try { Engine.Dispose(); } catch { }
        }
    }

    // ───────────────────────── wire helpers ─────────────────────────

    private static async Task<NamedPipeClientStream> ConnectAsync(string pipeName, int timeoutMs = 5000)
    {
        var c = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        await c.ConnectAsync(timeoutMs);
        return c;
    }

    private static async Task SendAsync(Stream s, IpcEnvelope env)
    {
        await s.WriteAsync(env.ToLengthPrefixedBytes());
        await s.FlushAsync();
    }

    /// <returns>envelope, or null when the peer closed the connection / timed out.</returns>
    private static async Task<(IpcEnvelope? env, bool closed)> ReadFrameAsync(Stream s, TimeSpan timeout)
    {
        using var cts = new CancellationTokenSource(timeout);
        try
        {
            var header = new byte[4];
            if (!await ReadExactAsync(s, header, cts.Token)) return (null, true);
            var payload = new byte[BitConverter.ToUInt32(header, 0)];
            if (!await ReadExactAsync(s, payload, cts.Token)) return (null, true);
            return (IpcEnvelope.FromJsonBytes(payload), false);
        }
        catch (OperationCanceledException) { return (null, false); }
        catch (IOException) { return (null, true); }
        catch (ObjectDisposedException) { return (null, true); }
    }

    private static async Task<bool> ReadExactAsync(Stream s, byte[] buf, CancellationToken ct)
    {
        int total = 0;
        while (total < buf.Length)
        {
            int n = await s.ReadAsync(buf.AsMemory(total), ct);
            if (n == 0) return false;
            total += n;
        }
        return true;
    }

    /// <summary>Reads until the peer closes or the timeout elapses.</summary>
    private static async Task<(List<IpcEnvelope> frames, bool closed)> DrainAsync(Stream s, TimeSpan timeout)
    {
        var frames = new List<IpcEnvelope>();
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            var (env, closed) = await ReadFrameAsync(s, deadline - DateTime.UtcNow);
            if (env != null) { frames.Add(env); continue; }
            return (frames, closed);
        }
        return (frames, false);
    }

    private static IpcEnvelope Handshake(int? pid = null, bool stopped = false) =>
        IpcEnvelope.Create(nameof(HandshakeRequest), new HandshakeRequest
        {
            ClientName = "PipeSecurityTest",
            ProtocolVersion = IpcConstants.CurrentProtocolVersion,
            ClientProcessId = pid ?? Environment.ProcessId,
            IsEmergencyStopped = stopped,
            StopId = stopped ? "stop_h3_test" : null,
            StopReason = stopped ? "h3 test" : null,
            StopGeneration = stopped ? 1UL : 0UL,
        });

    private static async Task<HandshakeResponse> HandshakeOkAsync(Stream s)
    {
        await SendAsync(s, Handshake());
        var (env, closed) = await ReadFrameAsync(s, TimeSpan.FromSeconds(5));
        Assert.True(env != null, $"no HandshakeResponse (closed={closed})");
        Assert.Equal(nameof(HandshakeResponse), env!.Type);
        var resp = env.DeserializePayload<HandshakeResponse>()!;
        Assert.Equal("Accepted", resp.Status);
        return resp;
    }

    // ───────────────────────── A. effective permissions ─────────────────────────

    [Fact]
    public async Task Dacl_IsCurrentUserOnly_WithNetworkDeny()
    {
        await using var h = await Harness.StartAsync();
        // FILE_GENERIC_READ includes READ_CONTROL, so an ordinary read/write client handle can read the DACL.
        using var probe = await ConnectAsync(h.PipeName);

        var sec = probe.GetAccessControl();
        var me = WindowsIdentity.GetCurrent().User!;
        var rules = sec.GetAccessRules(true, true, typeof(SecurityIdentifier)).Cast<PipeAccessRule>().ToList();
        foreach (var r in rules) _output.WriteLine($"{r.AccessControlType} {r.IdentityReference} {r.PipeAccessRights}");
        _output.WriteLine("SDDL: " + sec.GetSecurityDescriptorSddlForm(AccessControlSections.Access | AccessControlSections.Owner));

        Assert.Equal(me, sec.GetOwner(typeof(SecurityIdentifier)));
        var allows = rules.Where(r => r.AccessControlType == AccessControlType.Allow).ToList();
        Assert.Single(allows);
        Assert.Equal(me, allows[0].IdentityReference);
        Assert.Contains(rules, r => r.AccessControlType == AccessControlType.Deny
            && r.IdentityReference.Equals(new SecurityIdentifier(WellKnownSidType.NetworkSid, null)));
        foreach (var banned in new[] { WellKnownSidType.WorldSid, WellKnownSidType.AnonymousSid,
                     WellKnownSidType.BuiltinAdministratorsSid, WellKnownSidType.LocalSystemSid, WellKnownSidType.AuthenticatedUserSid })
        {
            Assert.DoesNotContain(rules, r => r.AccessControlType == AccessControlType.Allow
                && r.IdentityReference.Equals(new SecurityIdentifier(banned, null)));
        }
    }

    [Fact]
    public async Task EffectiveAccess_RestrictedEveryoneToken_IsDenied_ButDefaultAclControlIsNot()
    {
        // Control: a pipe created exactly like the pre-fix daemon (default DACL). The restricted
        // "Everyone-only" principal MUST be able to open it read-only, proving the harness can see a hole.
        string controlName = "test-h3-ctl-" + Guid.NewGuid().ToString("N");
        using var control = new NamedPipeServerStream(controlName, PipeDirection.InOut, 4, PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | PipeOptions.WriteThrough);
        _ = control.WaitForConnectionAsync();
        Assert.True(RestrictedEveryone.TryOpen(controlName, PipeDirection.In, out var controlErr),
            "control (default-DACL) pipe must be readable by an Everyone-only principal; harness invalid: " + controlErr);

        await using var h = await Harness.StartAsync();
        Assert.False(RestrictedEveryone.TryOpen(h.PipeName, PipeDirection.In, out var readErr),
            "Everyone-only principal could open the daemon pipe read-only");
        Assert.Contains("UnauthorizedAccess", readErr);
        Assert.False(RestrictedEveryone.TryOpen(h.PipeName, PipeDirection.InOut, out var rwErr),
            "Everyone-only principal could open the daemon pipe read/write");
        Assert.Contains("UnauthorizedAccess", rwErr);

        // Positive: the real (unrestricted) current user still connects and handshakes.
        using var legit = await ConnectAsync(h.PipeName);
        await HandshakeOkAsync(legit);
    }

    [Fact]
    [Trait("Category", "SmbLoopback")]
    public async Task RemoteSmbPath_IsDenied_ButDefaultAclControlIsReachable()
    {
        string machine = Environment.MachineName;
        string controlName = "test-h3-smb-" + Guid.NewGuid().ToString("N");
        using var control = new NamedPipeServerStream(controlName, PipeDirection.InOut, 4, PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | PipeOptions.WriteThrough);
        _ = control.WaitForConnectionAsync();
        using (var viaSmb = new NamedPipeClientStream(machine, controlName, PipeDirection.InOut, PipeOptions.Asynchronous))
        {
            try { await viaSmb.ConnectAsync(5000); }
            catch (Exception e) { Assert.Fail($"SMB loopback unavailable, cannot verify remote denial: {e.GetType().Name}: {e.Message}"); }
        }

        await using var h = await Harness.StartAsync();
        using var remote = new NamedPipeClientStream(machine, h.PipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        var ex = await Assert.ThrowsAnyAsync<Exception>(() => remote.ConnectAsync(5000));
        _output.WriteLine($"SMB path result: {ex.GetType().Name}: {ex.Message}");
        Assert.IsType<UnauthorizedAccessException>(ex);
    }

    // ───────────────────────── B. squatting & instances ─────────────────────────

    private sealed class CapturingLoggerProvider : ILoggerProvider
    {
        public readonly System.Collections.Concurrent.ConcurrentQueue<(LogLevel Level, string Category, string Message)> Entries = new();
        public ILogger CreateLogger(string categoryName) => new L(this, categoryName);
        public void Dispose() { }
        private sealed class L(CapturingLoggerProvider p, string cat) : ILogger
        {
            public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
            public bool IsEnabled(LogLevel logLevel) => true;
            public void Log<TState>(LogLevel level, EventId id, TState state, Exception? ex, Func<TState, Exception?, string> f)
                => p.Entries.Enqueue((level, cat, f(state, ex)));
        }
    }

    private static IHost BuildRealHost(string pipeName, IPipePeerVerifier verifier, CapturingLoggerProvider logs) =>
        Host.CreateDefaultBuilder()
            .ConfigureLogging(l => { l.ClearProviders(); l.AddProvider(logs); })
            .ConfigureServices(s =>
            {
                s.Configure<DaemonOptions>(o =>
                {
                    o.PipeName = pipeName;
                    o.MaxConnectedClients = 4;
                    o.TelemetryIntervalMs = 600_000;
                    o.HandshakeTimeoutMs = 1500;
                    o.AllowedClientImagePaths = new List<string> { Environment.ProcessPath! };
                });
                s.AddSingleton<ISystemMonitor, FakeSystemMonitor>();
                s.AddSingleton<IResourceManager, FakeResourceManager>();
                s.AddSingleton<IStateManager, RecordingStateManager>();
                s.AddSingleton(verifier);
                s.AddHostedService<NamedPipeServer>();   // the real daemon hosted service, resolved by DI
            })
            .Build();

    [Fact]
    public async Task SquattedPipe_RealHost_RunAsyncReturnsThroughControlledShutdown_ExitCode1_NothingServed_NoRetry()
    {
        string name = "test-h3-squat-host-" + Guid.NewGuid().ToString("N");
        using var squatter = new NamedPipeServerStream(name, PipeDirection.InOut, 4, PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | PipeOptions.WriteThrough);
        var verifier = new CountingVerifier(TestPeerVerifiers.AllowAll);
        var logs = new CapturingLoggerProvider();
        using var host = BuildRealHost(name, verifier, logs);

        int savedExit = Environment.ExitCode;
        Environment.ExitCode = 0;
        try
        {
            // Must RETURN (not throw an unhandled exception out of StartAsync, and not run forever).
            var run = host.RunAsync();
            var winner = await Task.WhenAny(run, Task.Delay(TimeSpan.FromSeconds(15)));
            Assert.True(ReferenceEquals(winner, run), "RunAsync did not return: the daemon kept running or retried");
            await run;   // propagates if RunAsync threw instead of returning normally

            Assert.Equal(1, Environment.ExitCode);

            // The controlled path, not the crash path.
            Assert.Contains(logs.Entries, e => e.Message.Contains("BackgroundService failed"));
            Assert.DoesNotContain(logs.Entries, e => e.Message.Contains("Hosting failed to start"));

            // Fail closed, exactly once, and it stays that way.
            int fatalLogs() => logs.Entries.Count(e => e.Level == LogLevel.Critical && e.Message.Contains("Cannot establish exclusive"));
            int startLogs() => logs.Entries.Count(e => e.Message.Contains("Starting D-ASK Named Pipe Server"));
            Assert.Equal(1, fatalLogs());
            Assert.Equal(1, startLogs());
            await Task.Delay(1500);
            Assert.Equal(1, fatalLogs());   // no retry loop
            Assert.Equal(1, startLogs());

            // No client was served: nothing was accepted or verified, and no session exists.
            Assert.Equal(0, verifier.Calls);
            Assert.DoesNotContain(logs.Entries, e => e.Message.Contains("Client connected"));
            _output.WriteLine($"exit code {Environment.ExitCode}; entries={logs.Entries.Count}");
        }
        finally { Environment.ExitCode = savedExit; }
    }

    [Fact]
    public async Task LegitimatePipe_RealHost_StartsServesAndShutsDownCleanly_ExitCodeStaysZero()
    {
        string name = "test-h3-legit-host-" + Guid.NewGuid().ToString("N");
        var verifier = new CountingVerifier(TestPeerVerifiers.AllowAll);
        var logs = new CapturingLoggerProvider();
        using var host = BuildRealHost(name, verifier, logs);

        int savedExit = Environment.ExitCode;
        Environment.ExitCode = 0;
        try
        {
            using var cts = new CancellationTokenSource();
            var run = host.RunAsync(cts.Token);

            using (var client = await ConnectAsync(name, 5000))
            {
                var deadline = DateTime.UtcNow.AddSeconds(5);
                while (verifier.Calls == 0 && DateTime.UtcNow < deadline) await Task.Delay(25);
                Assert.Equal(1, verifier.Calls);   // the connection really was accepted and verified
            }

            cts.Cancel();
            var winner = await Task.WhenAny(run, Task.Delay(TimeSpan.FromSeconds(15)));
            Assert.True(ReferenceEquals(winner, run), "host did not shut down");
            await run;

            Assert.Equal(0, Environment.ExitCode);
            Assert.DoesNotContain(logs.Entries, e => e.Level >= LogLevel.Critical);
            Assert.DoesNotContain(logs.Entries, e => e.Message.Contains("BackgroundService failed"));
            Assert.Contains(logs.Entries, e => e.Message.Contains("Named Pipe Server stopping"));
        }
        finally { Environment.ExitCode = savedExit; }
    }

    [Fact]
    public async Task PreExistingPipeName_FailsStartup_InsteadOfJoiningOrRetrying()
    {
        string name = "test-h3-squat-" + Guid.NewGuid().ToString("N");
        using var squatter = new NamedPipeServerStream(name, PipeDirection.InOut, 4, PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | PipeOptions.WriteThrough);

        var opts = new DaemonOptions { PipeName = name, TelemetryIntervalMs = 600_000, AllowedClientImagePaths = { Environment.ProcessPath! } };
        var state = new RecordingStateManager();
        using var server = new NamedPipeServer(NullLogger<NamedPipeServer>.Instance, new FakeSystemMonitor(),
            new FakeResourceManager(), state, Microsoft.Extensions.Options.Options.Create(opts));
        try
        {
            Exception? startupFailure = null;
            try { await server.StartAsync(CancellationToken.None); }
            catch (Exception e) { startupFailure = e; }

            if (startupFailure == null)
            {
                // StartAsync may return before the execute task faults; give it a moment, then require a fault.
                await Task.WhenAny(server.ExecuteTask!, Task.Delay(2000));
                if (server.ExecuteTask is { IsFaulted: true } t) startupFailure = t.Exception!.GetBaseException();
            }

            Assert.True(startupFailure != null,
                "server kept running (joined the squatter's pipe or entered a retry loop) instead of terminating startup");
            _output.WriteLine($"startup failure: {startupFailure!.GetType().Name}: {startupFailure.Message}");
        }
        finally { try { await server.StopAsync(CancellationToken.None); } catch { } }
    }

    [Fact]
    public async Task SubsequentInstances_AreCreated_SoFourConcurrentHostsWork()
    {
        await using var h = await Harness.StartAsync();
        var clients = new List<NamedPipeClientStream>();
        try
        {
            for (int i = 0; i < 4; i++)
            {
                var c = await ConnectAsync(h.PipeName);
                clients.Add(c);
                await HandshakeOkAsync(c);
            }
        }
        finally { foreach (var c in clients) c.Dispose(); }
    }

    // ───────────────────────── C. pre-handshake behaviour ─────────────────────────

    public static IEnumerable<object[]> PreHandshakeMessages() => new[]
    {
        new object[] { nameof(EmergencyStopRequest) },
        new object[] { nameof(ResumeExecutionRequest) },
        new object[] { nameof(PanicHotkeyStatusNotification) },
        new object[] { nameof(ActionApprovalResponse) },
        new object[] { nameof(SimulatedActionRequest) },
        new object[] { nameof(ModelInferenceIpcRequest) },
        new object[] { nameof(CaptureObservationRequest) },
        new object[] { nameof(StateRestoreRequest) },
        new object[] { nameof(HeartbeatPing) },
        new object[] { "TotallyUnknownType" },
    };

    private static IpcEnvelope Build(string type) => type switch
    {
        nameof(EmergencyStopRequest) => IpcEnvelope.Create(type, new EmergencyStopRequest { StopId = "forged", Source = "attacker", Reason = "forged" }),
        nameof(ResumeExecutionRequest) => IpcEnvelope.Create(type, new ResumeExecutionRequest { Source = "attacker", Reason = "forged", StopGeneration = 0 }),
        nameof(PanicHotkeyStatusNotification) => IpcEnvelope.Create(type, new PanicHotkeyStatusNotification { IsAvailable = false, Reason = "forged" }),
        nameof(ActionApprovalResponse) => IpcEnvelope.Create(type, new ActionApprovalResponse { ApprovalId = "forged", Approved = true }),
        nameof(SimulatedActionRequest) => IpcEnvelope.Create(type, new SimulatedActionRequest { ActionId = "forged", ActionType = "SimulatedScroll", SimulatedDurationMs = 10 }),
        nameof(ModelInferenceIpcRequest) => IpcEnvelope.Create(type, new ModelInferenceIpcRequest { TaskId = "forged", Prompt = "x" }),
        nameof(CaptureObservationRequest) => IpcEnvelope.Create(type, new CaptureObservationRequest()),
        nameof(StateRestoreRequest) => IpcEnvelope.Create(type, new StateRestoreRequest()),
        nameof(HeartbeatPing) => IpcEnvelope.Create(type, new HeartbeatPing { Sequence = 1 }),
        _ => IpcEnvelope.Create(type, new { x = 1 }),
    };

    [Theory]
    [MemberData(nameof(PreHandshakeMessages))]
    public async Task PreHandshake_AnyNonHandshakeMessage_IsRejectedWithoutSideEffects(string type)
    {
        await using var h = await Harness.StartAsync();

        // Engine is in a state where each forged message WOULD change something if it were processed.
        await h.Engine.TriggerEmergencyStopAsync("test", "pre-stopped", "pre_stop_id", "setup");
        Assert.True(h.Engine.IsEmergencyStopped);
        ulong genBefore = h.Engine.CurrentStopGeneration;
        int mutationsBefore = h.State.Mutations;

        using var attacker = await ConnectAsync(h.PipeName);
        await SendAsync(attacker, Build(type));
        var (frames, closed) = await DrainAsync(attacker, TimeSpan.FromSeconds(3));

        Assert.Empty(frames);
        Assert.True(closed, "connection must be closed after a pre-handshake message");
        Assert.True(h.Engine.IsEmergencyStopped, "forged message changed the emergency-stop latch");
        Assert.Equal(genBefore, h.Engine.CurrentStopGeneration);
        Assert.True(h.Engine.IsPanicHotkeyAvailable, "forged message changed panic-hotkey availability");
        Assert.Equal(mutationsBefore, h.State.Mutations);
    }

    [Fact]
    public async Task Handshake_WithMismatchedClientProcessId_IsRejected_WithoutReconcilingStop()
    {
        await using var h = await Harness.StartAsync();
        Assert.False(h.Engine.IsEmergencyStopped);
        int mutationsBefore = h.State.Mutations;

        using var c = await ConnectAsync(h.PipeName);
        await SendAsync(c, Handshake(pid: Environment.ProcessId + 1_000_003, stopped: true));
        var (frames, closed) = await DrainAsync(c, TimeSpan.FromSeconds(3));

        Assert.DoesNotContain(frames, f => f.Type == nameof(HandshakeResponse)
            && f.DeserializePayload<HandshakeResponse>()!.Status == "Accepted");
        Assert.True(closed);
        Assert.False(h.Engine.IsEmergencyStopped, "rejected handshake must not reconcile the stop latch");
        Assert.Equal(mutationsBefore, h.State.Mutations);
    }

    [Fact]
    public async Task ValidHandshake_StillReconcilesEmergencyStop_AndDeliversStopAfterwards()
    {
        await using var h = await Harness.StartAsync();
        using var c = await ConnectAsync(h.PipeName);
        await SendAsync(c, Handshake(stopped: true));
        var (env, _) = await ReadFrameAsync(c, TimeSpan.FromSeconds(5));
        Assert.Equal(nameof(HandshakeResponse), env!.Type);
        var resp = env.DeserializePayload<HandshakeResponse>()!;
        Assert.Equal("Accepted", resp.Status);
        Assert.True(resp.IsEmergencyStopped);
        Assert.True(h.Engine.IsEmergencyStopped);

        // Post-handshake the stop path still works end to end.
        await SendAsync(c, IpcEnvelope.Create(nameof(EmergencyStopRequest),
            new EmergencyStopRequest { StopId = "post_hs_stop", Source = "HudPanic", Reason = "post-handshake stop" }));
        var (frames, _) = await DrainAsync(c, TimeSpan.FromSeconds(3));
        Assert.Contains(frames, f => f.Type == nameof(EmergencyStopResponse));
    }

    [Fact]
    public async Task HandshakeTimeout_ClosesSilentClients_AndReleasesSlotsForLegitHost()
    {
        await using var h = await Harness.StartAsync(o => o.HandshakeTimeoutMs = 1000);
        var idle = new List<NamedPipeClientStream>();
        try
        {
            for (int i = 0; i < 4; i++) idle.Add(await ConnectAsync(h.PipeName));

            foreach (var c in idle)
            {
                var (frames, closed) = await DrainAsync(c, TimeSpan.FromSeconds(4));
                Assert.Empty(frames);
                Assert.True(closed, "silent client was not disconnected by the handshake timeout");
            }

            using var legit = await ConnectAsync(h.PipeName, 5000);
            await HandshakeOkAsync(legit);
        }
        finally { foreach (var c in idle) c.Dispose(); }
    }

    [Fact]
    public async Task LifecycleNotifications_AreNotSentToUnauthenticatedSessions()
    {
        await using var h = await Harness.StartAsync(o => o.HandshakeTimeoutMs = 6000);
        using var silent = await ConnectAsync(h.PipeName);
        using var authed = await ConnectAsync(h.PipeName);
        var hsAuthed = await HandshakeOkAsync(authed);
        await MakeLiveAsync(authed);   // Phase 7B.1a: actions are admitted only for a live HUD session
        await Task.Delay(300); // let the server register both sessions

        var res = await h.Engine.ExecuteSimulatedActionAsync(
            new SimulatedActionRequest { ActionId = "act_h3_lifecycle", ActionType = "SimulatedScroll", SimulatedDurationMs = 50 },
            hsAuthed.SessionToken);
        Assert.True(res.Success);

        var (authFrames, _) = await DrainAsync(authed, TimeSpan.FromSeconds(1));
        Assert.Contains(authFrames, f => f.Type == nameof(ActionLifecycleNotification));

        var (silentFrames, silentClosed) = await DrainAsync(silent, TimeSpan.FromSeconds(1));
        Assert.False(silentClosed, "test is vacuous: the silent client was already disconnected");
        Assert.DoesNotContain(silentFrames, f => f.Type == nameof(ActionLifecycleNotification));
        Assert.Empty(silentFrames);
    }

    // ───────────────────────── C2. identity enforcement by the production verifier ─────────────────────────

    private sealed class CountingVerifier : IPipePeerVerifier
    {
        private readonly IPipePeerVerifier _inner;
        private int _calls;
        public int Calls => Volatile.Read(ref _calls);
        public CountingVerifier(IPipePeerVerifier inner) => _inner = inner;
        public PeerVerificationResult Verify(NamedPipeServerStream pipe, long acceptedAt)
        {
            Interlocked.Increment(ref _calls);
            return _inner.Verify(pipe, acceptedAt);
        }
    }

    [Theory]
    [InlineData("empty-allowlist")]
    [InlineData("wrong-image")]
    public async Task ProductionVerifier_RejectsUnconfiguredOrWrongIdentity_BeforeAnyMessage(string kind)
    {
        await using var h = await Harness.StartAsync(o =>
        {
            o.AllowedClientImagePaths = kind == "empty-allowlist"
                ? new List<string>()
                : new List<string> { Path.Combine(Environment.SystemDirectory, "cmd.exe") };
        });
        int mutationsBefore = h.State.Mutations;

        using var c = await ConnectAsync(h.PipeName);
        // Even a perfectly valid handshake from an unverified identity must go unanswered. The server may
        // drop the connection before the write lands (broken pipe), which is also a correct outcome.
        try { await SendAsync(c, Handshake(stopped: true)); } catch (IOException) { }
        var (frames, closed) = await DrainAsync(c, TimeSpan.FromSeconds(3));

        Assert.Empty(frames);
        Assert.True(closed);
        Assert.False(h.Engine.IsEmergencyStopped);
        Assert.Equal(mutationsBefore, h.State.Mutations);
    }

    [Fact]
    public async Task EveryNewConnection_IsVerified_IncludingReconnects()
    {
        var counting = new CountingVerifier(new WindowsPipePeerVerifier(
            new[] { Environment.ProcessPath! }, AppContext.BaseDirectory, NullLogger.Instance));
        await using var h = await Harness.StartAsync(verifier: counting);

        for (int i = 1; i <= 3; i++)
        {
            using var c = await ConnectAsync(h.PipeName);
            await HandshakeOkAsync(c);
            Assert.Equal(i, counting.Calls);
        }
    }

    // ───────────────────────── D. restricted-token helper ─────────────────────────

    /// <summary>Opens a pipe as a principal whose only enabled SID is Everyone (user/groups deny-only).</summary>
    private static class RestrictedEveryone
    {
        [StructLayout(LayoutKind.Sequential)] private struct SidAndAttributes { public IntPtr Sid; public uint Attributes; }

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool CreateRestrictedToken(SafeAccessTokenHandle existing, uint flags,
            uint disableCount, SidAndAttributes[]? disable, uint deletePrivCount, IntPtr deletePriv,
            uint restrictCount, SidAndAttributes[]? restrict, out SafeAccessTokenHandle newToken);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool DuplicateTokenEx(SafeAccessTokenHandle token, uint access, IntPtr attrs,
            int impersonationLevel, int tokenType, out SafeAccessTokenHandle dup);

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool ConvertStringSidToSid(string s, out IntPtr sid);

        [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr p);

        public static bool TryOpen(string pipeName, PipeDirection dir, out string error)
        {
            var toFree = new List<IntPtr>();
            try
            {
                var identity = WindowsIdentity.GetCurrent();
                var everyone = new SecurityIdentifier(WellKnownSidType.WorldSid, null);
                var disable = new List<SidAndAttributes>();
                void AddDisable(SecurityIdentifier sid)
                {
                    if (!ConvertStringSidToSid(sid.Value, out var p)) throw new InvalidOperationException("ConvertStringSidToSid");
                    toFree.Add(p); disable.Add(new SidAndAttributes { Sid = p });
                }
                AddDisable(identity.User!);
                foreach (var g in identity.Groups!.Cast<SecurityIdentifier>().Where(g => !g.Equals(everyone))) AddDisable(g);

                ConvertStringSidToSid(everyone.Value, out var ev); toFree.Add(ev);
                var restrict = new[] { new SidAndAttributes { Sid = ev } };

                if (!CreateRestrictedToken(identity.AccessToken, 0x1 /*DISABLE_MAX_PRIVILEGE*/, (uint)disable.Count, disable.ToArray(),
                        0, IntPtr.Zero, 1, restrict, out var restricted))
                    throw new InvalidOperationException("CreateRestrictedToken failed: " + Marshal.GetLastWin32Error());
                using (restricted)
                {
                    if (!DuplicateTokenEx(restricted, 0xF01FF /*TOKEN_ALL_ACCESS*/, IntPtr.Zero, 2 /*SecurityImpersonation*/, 2 /*TokenImpersonation*/, out var imp))
                        throw new InvalidOperationException("DuplicateTokenEx failed: " + Marshal.GetLastWin32Error());
                    using (imp)
                    {
                        string? err = null; bool ok = false;
                        WindowsIdentity.RunImpersonated(imp, () =>
                        {
                            try
                            {
                                using var c = new NamedPipeClientStream(".", pipeName, dir, PipeOptions.None);
                                c.Connect(3000);
                                ok = true;
                            }
                            catch (Exception e) { err = e.GetType().Name + ": " + e.Message; }
                        });
                        error = err ?? "";
                        return ok;
                    }
                }
            }
            finally { foreach (var p in toFree) LocalFree(p); }
        }
    }
}
