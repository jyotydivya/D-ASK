using System.IO.Pipes;
using System.Text.RegularExpressions;
using DAsk.Protocol.IPC;
using DAsk.Protocol.IPC.Messages;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Xunit;

namespace DAsk.Daemon.Tests;

/// <summary>
/// Phase 4B-1R.9a (H3-8), wire level: a Resume must name the exact active Stop generation.
/// Missing, zero, stale and future generations fail closed and never clear the latch.
/// Independent of H3-9. Run alone with:  --filter "FullyQualifiedName~H38_"
/// Shares the real-pipe harness (real NamedPipeServer, real engine) with PipeSecurityBehaviorTests.
/// </summary>
public partial class PipeSecurityBehaviorTests
{
    private static async Task<ulong> StopOnWireAsync(Stream s, string stopId)
    {
        await SendAsync(s, IpcEnvelope.Create(nameof(EmergencyStopRequest),
            new EmergencyStopRequest { StopId = stopId, Source = "H38Test", Reason = "h38 test stop" }));
        var deadline = DateTime.UtcNow.AddSeconds(8);
        while (DateTime.UtcNow < deadline)
        {
            var (env, _) = await ReadFrameAsync(s, deadline - DateTime.UtcNow);
            if (env == null) break;
            if (env.Type == nameof(EmergencyStopResponse))
                return env.DeserializePayload<EmergencyStopResponse>()!.StopGeneration;
        }
        Assert.Fail("no EmergencyStopResponse");
        return 0;
    }

    /// <summary>Sends an arbitrary Resume payload (so the generation field can be omitted) and returns the reply.</summary>
    private static async Task<ResumeExecutionResponse> ResumeOnWireAsync(Stream s, object payload, TimeSpan? timeout = null)
    {
        await SendAsync(s, IpcEnvelope.Create(nameof(ResumeExecutionRequest), payload));
        var deadline = DateTime.UtcNow + (timeout ?? TimeSpan.FromSeconds(10));
        while (DateTime.UtcNow < deadline)
        {
            var (env, _) = await ReadFrameAsync(s, deadline - DateTime.UtcNow);
            if (env == null) break;
            if (env.Type == nameof(ResumeExecutionResponse))
                return env.DeserializePayload<ResumeExecutionResponse>()!;
        }
        Assert.Fail("no ResumeExecutionResponse");
        return null!;
    }

    private static object ResumeWithGeneration(ulong gen) =>
        new { resumeId = Guid.NewGuid().ToString("N"), source = "H38Test", reason = "h38 test", stopGeneration = gen };

    private static object ResumeWithoutGeneration() =>
        new { resumeId = Guid.NewGuid().ToString("N"), source = "H38Test", reason = "h38 test" };

    // ───────── Null execution engine: Resume fails closed ─────────

    [Fact]
    public async Task H38_NullEngine_Resume_FailsClosed_ForAnyGeneration_AndDoesNotMutateState()
    {
        var opts = new DAsk.Daemon.Configuration.DaemonOptions
        {
            PipeName = "test-h38-nullengine-" + Guid.NewGuid().ToString("N"),
            TelemetryIntervalMs = 600_000,
            HandshakeTimeoutMs = 1500,
            AllowedClientImagePaths = { Environment.ProcessPath! },
        };
        var state = new RecordingStateManager();
        using var server = new DAsk.Daemon.IPC.NamedPipeServer(
            Microsoft.Extensions.Logging.Abstractions.NullLogger<DAsk.Daemon.IPC.NamedPipeServer>.Instance,
            new FakeSystemMonitor(), new FakeResourceManager(), state,
            Microsoft.Extensions.Options.Options.Create(opts),
            executionEngine: null, peerVerifier: TestPeerVerifiers.AllowAll);
        await server.StartAsync(CancellationToken.None);
        try
        {
            using var c = await ConnectAsync(opts.PipeName);
            await HandshakeOkAsync(c);
            await StopOnWireAsync(c, "h38_null_engine");
            Assert.Equal("EmergencyStop", state.OrbMode);
            int mutations = state.Mutations;

            foreach (var payload in new[] { ResumeWithGeneration(0), ResumeWithGeneration(1), ResumeWithGeneration(2), ResumeWithoutGeneration() })
            {
                var resp = await ResumeOnWireAsync(c, payload);
                Assert.False(resp.Success, "without an engine no Resume may succeed");
                Assert.Equal("EmergencyStop", state.OrbMode);
            }
            Assert.Equal(mutations, state.Mutations);
        }
        finally { try { await server.StopAsync(CancellationToken.None); } catch { } }
    }

    // ───────── R1 / R2: zero and omitted generation while stopped ─────────

    [Fact]
    public async Task H38_WireResume_ExplicitZeroGeneration_WhileStopped_IsRejected_AndStaysStopped()
    {
        await using var h = await Harness.StartAsync();
        using var c = await ConnectAsync(h.PipeName);
        await HandshakeOkAsync(c);
        ulong gen = await StopOnWireAsync(c, "h38_r1");
        Assert.True(h.Engine.IsEmergencyStopped);

        var resp = await ResumeOnWireAsync(c, ResumeWithGeneration(0));

        Assert.False(resp.Success, "a generation of 0 must never clear the stop latch");
        Assert.True(h.Engine.IsEmergencyStopped, "latch must remain set");
        Assert.Equal(gen, h.Engine.CurrentStopGeneration);
        Assert.Equal(gen, resp.StopGeneration);
    }

    [Fact]
    public async Task H38_WireResume_OmittedGeneration_WhileStopped_IsRejected_AndStaysStopped()
    {
        await using var h = await Harness.StartAsync();
        using var c = await ConnectAsync(h.PipeName);
        await HandshakeOkAsync(c);
        await StopOnWireAsync(c, "h38_r2");

        var resp = await ResumeOnWireAsync(c, ResumeWithoutGeneration());

        Assert.False(resp.Success, "an omitted generation must never clear the stop latch");
        Assert.True(h.Engine.IsEmergencyStopped);
    }

    // ───────── R3 / R4 / R5: stale, future, exact ─────────

    [Fact]
    public async Task H38_WireResume_StaleAndFuture_WhileStopped_AreRejected_ExactGenerationResumes()
    {
        await using var h = await Harness.StartAsync();
        using var c = await ConnectAsync(h.PipeName);
        await HandshakeOkAsync(c);
        ulong gen = await StopOnWireAsync(c, "h38_r3");
        Assert.True(gen >= 2);

        var stale = await ResumeOnWireAsync(c, ResumeWithGeneration(gen - 1));
        Assert.False(stale.Success);
        Assert.True(h.Engine.IsEmergencyStopped);

        var future = await ResumeOnWireAsync(c, ResumeWithGeneration(gen + 1));
        Assert.False(future.Success);
        Assert.True(h.Engine.IsEmergencyStopped);

        var exact = await ResumeOnWireAsync(c, ResumeWithGeneration(gen));
        Assert.True(exact.Success, exact.ErrorMessage);
        Assert.False(h.Engine.IsEmergencyStopped, "the exact current generation still resumes");
        Assert.Equal(gen, exact.StopGeneration);
    }

    // ───────── R6 / R7 / R8: not stopped ─────────

    [Fact]
    public async Task H38_WireResume_WhileNotStopped_ZeroOmittedStaleFuture_AreRejected_ExactIsIdempotentSuccess()
    {
        await using var h = await Harness.StartAsync();
        using var c = await ConnectAsync(h.PipeName);
        await HandshakeOkAsync(c);
        Assert.False(h.Engine.IsEmergencyStopped);
        ulong gen = h.Engine.CurrentStopGeneration;   // 1 on a fresh engine

        Assert.False((await ResumeOnWireAsync(c, ResumeWithGeneration(0))).Success, "zero, not stopped");
        Assert.False((await ResumeOnWireAsync(c, ResumeWithoutGeneration())).Success, "omitted, not stopped");
        Assert.False((await ResumeOnWireAsync(c, ResumeWithGeneration(gen + 1))).Success, "future, not stopped");

        var exact = await ResumeOnWireAsync(c, ResumeWithGeneration(gen));
        Assert.True(exact.Success, "exact generation is an idempotent retry");
        Assert.False(h.Engine.IsEmergencyStopped);

        // Stale: after a stop/resume cycle the old generation is stale even though nothing is stopped.
        ulong g2 = await StopOnWireAsync(c, "h38_r7");
        Assert.True((await ResumeOnWireAsync(c, ResumeWithGeneration(g2))).Success);
        Assert.False((await ResumeOnWireAsync(c, ResumeWithGeneration(g2 - 1))).Success, "stale, not stopped");
        Assert.True((await ResumeOnWireAsync(c, ResumeWithGeneration(g2))).Success, "exact retry still idempotent");
    }

    // ───────── R9 / R10: replay and new Stop racing an older Resume ─────────

    [Fact]
    public async Task H38_WireResume_ReplayedAfterNewStop_IsRejected_NewStopStaysLatched()
    {
        await using var h = await Harness.StartAsync();
        using var c = await ConnectAsync(h.PipeName);
        await HandshakeOkAsync(c);

        ulong g1 = await StopOnWireAsync(c, "h38_r9a");
        var request = ResumeWithGeneration(g1);
        Assert.True((await ResumeOnWireAsync(c, request)).Success);

        ulong g2 = await StopOnWireAsync(c, "h38_r9b");   // a new Stop: new generation
        Assert.True(g2 > g1);

        var replay = await ResumeOnWireAsync(c, request);   // byte-identical replay of the older Resume
        Assert.False(replay.Success, "an older Resume must not clear a newer Stop");
        Assert.True(h.Engine.IsEmergencyStopped);
        Assert.Equal(g2, h.Engine.CurrentStopGeneration);
    }

    // ───────── R11: invalid Resumes must not wait for the drain ─────────

    [Fact]
    public async Task H38_InvalidResume_DoesNotWaitForActiveActionDrain()
    {
        await using var h = await Harness.StartAsync();
        using var c = await ConnectAsync(h.PipeName);
        var hsH38 = await HandshakeOkAsync(c);
        await MakeLiveAsync(c);   // Phase 7B.1a: actions are admitted only for a live HUD session

        var gate = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var reached = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        h.Engine.ActionLifecycleChanged += (_, n) =>
        {
            if (n.ActionId == "act_h38_hold" && n.Reason == "Simulation cancelled")
            {
                reached.TrySetResult(true);
                gate.Task.GetAwaiter().GetResult();   // hold the unwinding open
            }
        };

        var running = h.Engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
        {
            ActionId = "act_h38_hold",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 8000,
        }, hsH38.SessionToken);
        var deadline = DateTime.UtcNow.AddSeconds(3);
        while (h.Engine.ActiveActionCount == 0 && DateTime.UtcNow < deadline) await Task.Delay(10);
        Assert.Equal(1, h.Engine.ActiveActionCount);

        ulong gen = await StopOnWireAsync(c, "h38_r11");
        await reached.Task.WaitAsync(TimeSpan.FromSeconds(3));
        Assert.Equal(1, h.Engine.ActiveActionCount);   // the drain would block here (default timeout 5 s)

        try
        {
            foreach (var (label, payload) in new (string, object)[]
            {
                ("zero", ResumeWithGeneration(0)),
                ("omitted", ResumeWithoutGeneration()),
                ("stale", ResumeWithGeneration(gen - 1)),
                ("future", ResumeWithGeneration(gen + 1)),
            })
            {
                var sw = System.Diagnostics.Stopwatch.StartNew();
                var resp = await ResumeOnWireAsync(c, payload, TimeSpan.FromSeconds(15));
                sw.Stop();
                Assert.False(resp.Success, label);
                Assert.True(sw.Elapsed < TimeSpan.FromSeconds(2),
                    $"{label} Resume waited {sw.Elapsed.TotalMilliseconds:F0} ms: invalid requests must be rejected before the drain");
            }
            Assert.True(h.Engine.IsEmergencyStopped);
        }
        finally
        {
            gate.TrySetResult(true);
            await running;
        }
    }

    // ───────── R12 / R13: another session cannot clear a Stop without the generation ─────────

    [Fact]
    public async Task H38_SecondSession_ZeroGenerationResume_CannotClearAnotherSessionsStop()
    {
        await using var h = await Harness.StartAsync();
        using var host = await ConnectAsync(h.PipeName);
        using var other = await ConnectAsync(h.PipeName);
        await HandshakeOkAsync(host);
        await HandshakeOkAsync(other);

        ulong gen = await StopOnWireAsync(host, "h38_r13");

        Assert.False((await ResumeOnWireAsync(other, ResumeWithGeneration(0))).Success);
        Assert.False((await ResumeOnWireAsync(other, ResumeWithoutGeneration())).Success);
        Assert.True(h.Engine.IsEmergencyStopped, "the legitimate Stop must survive a forged Resume");
        Assert.Equal(gen, h.Engine.CurrentStopGeneration);
    }

    // ───────── R14: structural guards ─────────

    private static string RepoRoot() =>
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));

    [Fact]
    public void H38_Source_NoNullableGenerationBypass_AndSingleProductionResumeCaller()
    {
        string root = RepoRoot();
        string session = File.ReadAllText(Path.Combine(root, "src", "DAsk.Daemon", "IPC", "IpcClientSession.cs"));
        string engine = File.ReadAllText(Path.Combine(root, "src", "DAsk.Daemon", "Automation", "Execution", "ActionExecutionEngine.cs"));

        // The 0 -> null rewrite that disabled the check must be gone.
        Assert.DoesNotMatch(new Regex(@"StopGeneration\s*>\s*0\s*\?"), session);
        // The engine API must not accept an optional/nullable generation.
        Assert.DoesNotMatch(new Regex(@"ulong\?\s+(expectedGeneration|stopGeneration)"), engine);
        Assert.DoesNotMatch(new Regex(@"expectedGeneration"), engine);

        // Exactly one production caller of ResumeExecutionAsync, in IpcClientSession.
        var callers = new List<string>();
        foreach (var f in Directory.EnumerateFiles(Path.Combine(root, "src", "DAsk.Daemon"), "*.cs", SearchOption.AllDirectories))
        {
            string rel = f.Substring(root.Length);
            if (rel.Contains(@"\obj\") || rel.Contains(@"\bin\")) continue;
            string text = File.ReadAllText(f);
            if (rel.EndsWith("ActionExecutionEngine.cs")) continue;   // the definition itself
            foreach (Match _ in Regex.Matches(text, @"\.ResumeExecutionAsync\("))
                callers.Add(rel);
        }
        Assert.Equal(new[] { @"\src\DAsk.Daemon\IPC\IpcClientSession.cs" }, callers.ToArray());
    }
}
