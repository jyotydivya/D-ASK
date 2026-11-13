using System.Diagnostics;
using System.IO.Pipes;
using DAsk.Daemon.AgentHost;
using DAsk.Daemon.Automation.Execution;
using DAsk.Daemon.Automation.Policy;
using DAsk.Daemon.Configuration;
using DAsk.Daemon.IPC;
using DAsk.Daemon.ModelRuntime;
using DAsk.Protocol.IPC;
using DAsk.Protocol.IPC.Messages;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace DAsk.Daemon.Tests;

/// <summary>
/// Phase 5, wire level: authenticated sessions on the real named pipe → daemon → real host process (scripted
/// model). Ownership comes from the connection; nothing in a payload can claim it.
/// Run alone with: --filter "FullyQualifiedName~AgentWire_"
/// </summary>
public partial class PipeSecurityBehaviorTests
{
    private sealed class AgentRig : IAsyncDisposable
    {
        public required NamedPipeServer Server { get; init; }
        public required ActionExecutionEngine Engine { get; init; }
        public required AgentHostManager Host { get; init; }
        public required string PipeName { get; init; }

        public static async Task<AgentRig> StartAsync()
        {
            var opts = new DaemonOptions
            {
                PipeName = "test-agent-" + Guid.NewGuid().ToString("N"),
                MaxConnectedClients = 4,
                TelemetryIntervalMs = 600_000,
                HandshakeTimeoutMs = 2000,
                AllowedClientImagePaths = { Environment.ProcessPath! },
            };
            var state = new RecordingStateManager();
            var policy = new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance, null);
            var engine = new ActionExecutionEngine(NullLogger<ActionExecutionEngine>.Instance, state, policy, null, ActionExecutionEngine.MaxQueueCapacityDefault, 1);
            engine.SetPanicHotkeyStatus(true, "test hotkey", 0);
            var host = new AgentHostManager(Microsoft.Extensions.Options.Options.Create(AgentHostManagerTests.Options()), NullLogger<AgentHostManager>.Instance, engine);
            var server = new NamedPipeServer(NullLogger<NamedPipeServer>.Instance, new FakeSystemMonitor(), new FakeResourceManager(), state,
                Microsoft.Extensions.Options.Options.Create(opts), executionEngine: engine, policyEngine: policy, peerVerifier: TestPeerVerifiers.AllowAll, agentHost: host);
            await server.StartAsync(CancellationToken.None);
            return new AgentRig { Server = server, Engine = engine, Host = host, PipeName = opts.PipeName };
        }

        public async ValueTask DisposeAsync()
        {
            try { await Host.DisposeAsync(); } catch { }
            try { await Server.StopAsync(CancellationToken.None); } catch { }
            try { Server.Dispose(); } catch { }
            try { Engine.Dispose(); } catch { }
        }
    }

    private static async Task<NamedPipeClientStream> AgentClientAsync(string pipe)
    {
        var c = await ConnectAsync(pipe);
        await SendAsync(c, IpcEnvelope.Create(nameof(HandshakeRequest), new HandshakeRequest
        {
            ClientName = "AgentWireTest",
            ProtocolVersion = IpcConstants.CurrentProtocolVersion,
            ClientProcessId = Environment.ProcessId,
            Capabilities = ["agent"],
        }));
        var resp = await AgentReadUntilAsync(c, e => e.Type == nameof(HandshakeResponse));
        Assert.Equal("Accepted", resp.DeserializePayload<HandshakeResponse>()!.Status);
        return c;
    }

    private static async Task<IpcEnvelope> AgentReadUntilAsync(Stream s, Func<IpcEnvelope, bool> match, int timeoutMs = 10_000, List<IpcEnvelope>? seen = null)
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (DateTime.UtcNow < deadline)
        {
            var (env, closed) = await ReadFrameAsync(s, deadline - DateTime.UtcNow);
            if (closed || env == null) break;
            seen?.Add(env);
            if (match(env)) return env;
        }
        throw new TimeoutException("Expected message did not arrive");
    }

    private static async Task<AgentTaskSubmitResponse> AgentSubmitAsync(Stream s, string objective)
    {
        var req = IpcEnvelope.Create(nameof(AgentTaskSubmitRequest), new AgentTaskSubmitRequest { Objective = objective });
        await SendAsync(s, req);
        var resp = await AgentReadUntilAsync(s, e => e.ReplyToId == req.Id);
        Assert.Equal(nameof(AgentTaskSubmitResponse), resp.Type);
        return resp.DeserializePayload<AgentTaskSubmitResponse>()!;
    }

    [Fact]
    public async Task AgentWire_Submit_CorrelatesReply_AndDeliversResult_OnlyToTheOwner()
    {
        await using var rig = await AgentRig.StartAsync();
        using var a = await AgentClientAsync(rig.PipeName);
        using var b = await AgentClientAsync(rig.PipeName);

        var health = IpcEnvelope.Create(nameof(AgentHostHealthRequest), new AgentHostHealthRequest());
        await SendAsync(a, health);
        var hr = await AgentReadUntilAsync(a, e => e.ReplyToId == health.Id);
        Assert.Equal("stopped", hr.DeserializePayload<AgentHostHealthResponse>()!.State); // not started until used

        var ack = await AgentSubmitAsync(a, "What time is it?");
        Assert.True(ack.Accepted, ack.ErrorMessage);
        var seen = new List<IpcEnvelope>();
        var result = await AgentReadUntilAsync(a, e => e.Type == nameof(AgentTaskResultNotification), seen: seen);
        var r = result.DeserializePayload<AgentTaskResultNotification>()!;
        Assert.Equal(ack.TaskId, r.TaskId);
        Assert.Equal("completed", r.Outcome);
        Assert.Contains(seen, e => e.Type == nameof(AgentTaskProgressNotification));

        // Status: the owner sees it; another session is told it does not exist.
        var st = IpcEnvelope.Create(nameof(AgentTaskStatusRequest), new AgentTaskStatusRequest { TaskId = ack.TaskId! });
        await SendAsync(a, st);
        var ours = (await AgentReadUntilAsync(a, e => e.ReplyToId == st.Id)).DeserializePayload<AgentTaskStatusResponse>()!;
        Assert.True(ours.Found);
        Assert.Equal("finished", ours.State);
        Assert.Equal("completed", ours.Result!.Outcome);

        var st2 = IpcEnvelope.Create(nameof(AgentTaskStatusRequest), new AgentTaskStatusRequest { TaskId = ack.TaskId! });
        var bSeen = new List<IpcEnvelope>();
        await SendAsync(b, st2);
        var theirs = (await AgentReadUntilAsync(b, e => e.ReplyToId == st2.Id, seen: bSeen)).DeserializePayload<AgentTaskStatusResponse>()!;
        Assert.False(theirs.Found);
        Assert.Null(theirs.Result);
        Assert.DoesNotContain(bSeen, e => e.Type is nameof(AgentTaskResultNotification) or nameof(AgentTaskProgressNotification));
    }

    [Fact]
    public async Task AgentWire_FinishedResult_IsRecoverable_OnlyAfterItsOwnerDisconnected()
    {
        await using var rig = await AgentRig.StartAsync();
        var a = await AgentClientAsync(rig.PipeName);
        using var b = await AgentClientAsync(rig.PipeName);
        var ack = await AgentSubmitAsync(a, "What time is it?");
        Assert.True(ack.Accepted, ack.ErrorMessage);
        await AgentReadUntilAsync(a, e => e.Type == nameof(AgentTaskResultNotification));

        var st = IpcEnvelope.Create(nameof(AgentTaskStatusRequest), new AgentTaskStatusRequest { TaskId = ack.TaskId! });
        await SendAsync(b, st);
        Assert.False((await AgentReadUntilAsync(b, e => e.ReplyToId == st.Id)).DeserializePayload<AgentTaskStatusResponse>()!.Found);   // owner still connected

        a.Dispose();                                                    // the owner's HUD goes away (closed or killed)
        AgentTaskStatusResponse? got = null;
        for (int i = 0; i < 50 && got?.Found != true; i++)
        {
            await Task.Delay(100);
            var st2 = IpcEnvelope.Create(nameof(AgentTaskStatusRequest), new AgentTaskStatusRequest { TaskId = ack.TaskId! });
            await SendAsync(b, st2);
            got = (await AgentReadUntilAsync(b, e => e.ReplyToId == st2.Id)).DeserializePayload<AgentTaskStatusResponse>();
        }
        Assert.True(got!.Found);
        Assert.Equal("finished", got.State);
        Assert.Equal("completed", got.Result!.Outcome);

        var unknown = IpcEnvelope.Create(nameof(AgentTaskStatusRequest), new AgentTaskStatusRequest { TaskId = "t" + Guid.NewGuid().ToString("N") });
        await SendAsync(b, unknown);
        Assert.False((await AgentReadUntilAsync(b, e => e.ReplyToId == unknown.Id)).DeserializePayload<AgentTaskStatusResponse>()!.Found);
    }

    [Fact]
    public async Task AgentWire_BeforeHandshake_NothingIsProcessed_AndTheConnectionCloses()
    {
        await using var rig = await AgentRig.StartAsync();
        using var c = await ConnectAsync(rig.PipeName);
        await SendAsync(c, IpcEnvelope.Create(nameof(AgentTaskSubmitRequest), new AgentTaskSubmitRequest { Objective = "What time is it?" }));
        var (env, closed) = await ReadFrameAsync(c, TimeSpan.FromSeconds(3));
        Assert.True(closed || env == null);
        Assert.Null(rig.Host.HostPid);
        Assert.Equal(0, rig.Host.ProcessesStarted);
    }

    [Fact]
    public async Task AgentWire_EmergencyStop_OnTheSameConnection_IsNotDelayedByARunningTask()
    {
        await using var rig = await AgentRig.StartAsync();
        using var a = await AgentClientAsync(rig.PipeName);
        var ack = await AgentSubmitAsync(a, "slowmodel");
        Assert.True(ack.Accepted);
        await Task.Delay(150);

        var sw = Stopwatch.StartNew();
        var stop = IpcEnvelope.Create(nameof(EmergencyStopRequest), new EmergencyStopRequest { Source = "test", Reason = "wire test", StopId = "s-" + Guid.NewGuid().ToString("N") });
        await SendAsync(a, stop);
        var seen = new List<IpcEnvelope>();
        await AgentReadUntilAsync(a, e => e.ReplyToId == stop.Id, 3000, seen);
        long ackMs = sw.ElapsedMilliseconds;
        var result = seen.FirstOrDefault(e => e.Type == nameof(AgentTaskResultNotification))
            ?? await AgentReadUntilAsync(a, e => e.Type == nameof(AgentTaskResultNotification), 3000);
        Assert.Equal("cancelled", result.DeserializePayload<AgentTaskResultNotification>()!.Outcome);
        Assert.True(ackMs < 500 && sw.ElapsedMilliseconds < 1000, $"ack {ackMs} ms, task ended {sw.ElapsedMilliseconds} ms");

        var refused = await AgentSubmitAsync(a, "What time is it?");
        Assert.False(refused.Accepted);
        Assert.Equal("emergency_stopped", refused.RejectionCode);
    }

    [Fact]
    public async Task AgentWire_Disconnect_CancelsTheOwnersTask()
    {
        await using var rig = await AgentRig.StartAsync();
        string taskId;
        using (var a = await AgentClientAsync(rig.PipeName))
        {
            var ack = await AgentSubmitAsync(a, "slowtool");
            Assert.True(ack.Accepted);
            taskId = ack.TaskId!;
            await Task.Delay(100);
        }
        Assert.True(await H39WaitAsync(() => rig.Host.Health().ActiveTaskId == null, 5000), "the task should be cancelled when its owner disconnects");
    }

    private sealed class FakeModelRuntime : IModelRuntime
    {
        public ModelRuntimeState State { get; set; } = ModelRuntimeState.Unloaded;
        public ModelManifest Manifest { get; } = new() { Id = "fake", Name = "fake", FilePath = "fake" };
        public InferenceBackend ActiveBackend => InferenceBackend.Cpu_AVX2;
        public int Generations;
        public int Unloads;
        public Task<bool> LoadModelAsync(InferenceBackend? b = null, CancellationToken c = default) => Task.FromResult(true);
        public Task UnloadModelAsync(string reason, CancellationToken c = default) { Unloads++; State = ModelRuntimeState.Unloaded; return Task.CompletedTask; }
        public async IAsyncEnumerable<TokenChunk> GenerateStreamAsync(ModelInferenceRequest r, [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken c = default) { await Task.CompletedTask; yield break; }
        public Task<(string Text, ModelExecutionTelemetry Telemetry)> GenerateAsync(ModelInferenceRequest r, CancellationToken c = default) { Generations++; return Task.FromResult(("hello", new ModelExecutionTelemetry())); }
        public event EventHandler<ModelRuntimeState>? StateChanged { add { } remove { } }
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    [Fact]
    public async Task AgentWire_OneModelOwner_DirectInferenceRefusedWhileTheAgentOwnsTheModel()
    {
        var runtime = new FakeModelRuntime();
        var opts = new DaemonOptions { PipeName = "test-agent-" + Guid.NewGuid().ToString("N"), MaxConnectedClients = 4, TelemetryIntervalMs = 600_000, HandshakeTimeoutMs = 2000, AllowedClientImagePaths = { Environment.ProcessPath! } };
        var state = new RecordingStateManager();
        var policy = new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance, null);
        using var engine = new ActionExecutionEngine(NullLogger<ActionExecutionEngine>.Instance, state, policy, null, ActionExecutionEngine.MaxQueueCapacityDefault, 1);
        engine.SetPanicHotkeyStatus(true, "test hotkey", 0);
        await using var host = new AgentHostManager(Microsoft.Extensions.Options.Options.Create(AgentHostManagerTests.Options()), NullLogger<AgentHostManager>.Instance, engine, runtime);
        using var server = new NamedPipeServer(NullLogger<NamedPipeServer>.Instance, new FakeSystemMonitor(), new FakeResourceManager(), state,
            Microsoft.Extensions.Options.Options.Create(opts), runtime, null, engine, policy, TestPeerVerifiers.AllowAll, host);
        await server.StartAsync(CancellationToken.None);
        try
        {
            using var a = await AgentClientAsync(opts.PipeName);

            async Task<ModelInferenceIpcResponse> InferAsync()
            {
                var req = IpcEnvelope.Create(nameof(ModelInferenceIpcRequest), new ModelInferenceIpcRequest { TaskId = "i1", Prompt = "hi" });
                await SendAsync(a, req);
                return (await AgentReadUntilAsync(a, e => e.ReplyToId == req.Id)).DeserializePayload<ModelInferenceIpcResponse>()!;
            }

            // Outside agent mode the daemon's own inference still works.
            var before = await InferAsync();
            Assert.True(before.IsSuccess, before.ErrorMessage);
            Assert.Equal(1, runtime.Generations);

            // The daemon's model is busy: the agent does not take over mid-generation.
            runtime.State = ModelRuntimeState.Generating;
            var busy = await AgentSubmitAsync(a, "What time is it?");
            Assert.Equal("daemon_model_busy", busy.RejectionCode);

            // The daemon's model is loaded and idle: it is unloaded before the agent starts.
            runtime.State = ModelRuntimeState.Ready;
            var ack = await AgentSubmitAsync(a, "slowmodel");
            Assert.True(ack.Accepted, ack.ErrorMessage);
            Assert.Equal(1, runtime.Unloads);

            // While the agent owns the model, direct inference is refused and generates nothing.
            var refused = await InferAsync();
            Assert.False(refused.IsSuccess);
            Assert.Equal("AgentModelOwnerActive", refused.RejectionCode);
            Assert.Equal(1, runtime.Generations);
        }
        finally
        {
            await host.ShutdownAsync("test");
            await server.StopAsync(CancellationToken.None);
        }
    }
}
