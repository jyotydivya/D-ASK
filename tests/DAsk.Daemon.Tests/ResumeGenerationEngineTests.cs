using DAsk.Daemon.Automation.Execution;
using DAsk.Daemon.Automation.Policy;
using DAsk.Daemon.State;
using DAsk.Protocol.IPC.Messages;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace DAsk.Daemon.Tests;

/// <summary>
/// Phase 4B-1R.9a (H3-8), engine level: ActionExecutionEngine.ResumeExecutionAsync requires the exact,
/// currently active Stop generation. Independent of H3-9. Run alone with:  --filter "FullyQualifiedName~H38_"
/// </summary>
public class ResumeGenerationEngineTests
{
    private sealed class StubState : IStateManager
    {
        public string ActiveStatus { get; private set; } = "Normal";
        public string OrbMode { get; private set; } = "idle";
        public long CurrentSequenceNumber => 1;
        public event EventHandler<StateUpdate>? StateChanged { add { } remove { } }
        public void SetStatus(string status, string? orbMode = null) { ActiveStatus = status; if (orbMode != null) OrbMode = orbMode; }
        public void AddOrUpdateTask(string id, string t, string s) { }
        public void RemoveTask(string id) { }
        public StateRestoreResponse CreateStateSnapshot() => new();
        public bool RestoreClientState(StateRestoreRequest r, out StateRestoreResponse resp) { resp = new(); return true; }
    }

    private static ActionExecutionEngine NewEngine()
    {
        var policy = new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance, null);
        var engine = new ActionExecutionEngine(NullLogger<ActionExecutionEngine>.Instance, new StubState(), policy, null,
            ActionExecutionEngine.MaxQueueCapacityDefault, 1);
        engine.SetPanicHotkeyStatus(true, "test hotkey", 0);
        return engine;
    }

    /// <summary>Starts an action whose cancellation unwinding is held open until the returned gate is released.</summary>
    private static async Task<(Task<SimulatedActionResponse> action, TaskCompletionSource<bool> gate, TaskCompletionSource<bool> reached)>
        StartHeldActionAsync(ActionExecutionEngine engine, string actionId)
    {
        var gate = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var reached = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        engine.ActionLifecycleChanged += (_, n) =>
        {
            if (n.ActionId == actionId && n.Reason == "Simulation cancelled")
            {
                reached.TrySetResult(true);
                gate.Task.GetAwaiter().GetResult();
            }
        };
        var action = engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
        {
            ActionId = actionId,
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 8000,
        }, "sess_h38");
        var deadline = DateTime.UtcNow.AddSeconds(3);
        while (engine.ActiveActionCount == 0 && DateTime.UtcNow < deadline) await Task.Delay(10);
        Assert.Equal(1, engine.ActiveActionCount);
        return (action, gate, reached);
    }

    // ───────── R1: zero ─────────

    [Fact]
    public async Task H38_Engine_ZeroGeneration_WhileStopped_IsRejected_LatchStays()
    {
        using var engine = NewEngine();
        var stop = await engine.TriggerEmergencyStopAsync("Test", "stop");

        var resp = await engine.ResumeExecutionAsync("Test", "zero", stopGeneration: 0);

        Assert.False(resp.Success);
        Assert.Contains("Missing or zero stop generation", resp.ErrorMessage);
        Assert.True(engine.IsEmergencyStopped);
        Assert.Equal(stop.StopGeneration, engine.CurrentStopGeneration);
        Assert.Equal(stop.StopGeneration, resp.StopGeneration);
    }

    // ───────── R3 / R4 / R5: stale, future, exact while stopped ─────────

    [Fact]
    public async Task H38_Engine_StaleAndFuture_WhileStopped_AreRejected_ExactResumes()
    {
        using var engine = NewEngine();
        var stop = await engine.TriggerEmergencyStopAsync("Test", "stop");
        ulong gen = stop.StopGeneration;

        var stale = await engine.ResumeExecutionAsync("Test", "stale", gen - 1);
        var future = await engine.ResumeExecutionAsync("Test", "future", gen + 1);
        Assert.False(stale.Success);
        Assert.False(future.Success);
        Assert.Contains("Generation mismatch", stale.ErrorMessage);
        Assert.Contains("Generation mismatch", future.ErrorMessage);
        Assert.True(engine.IsEmergencyStopped);

        var exact = await engine.ResumeExecutionAsync("Test", "exact", gen, resumeId: "res_exact", sessionId: "sess_x");
        Assert.True(exact.Success);
        Assert.Equal("res_exact", exact.ResumeId);
        Assert.Equal("sess_x", exact.SessionId);
        Assert.Equal(gen, exact.StopGeneration);
        Assert.False(engine.IsEmergencyStopped);
    }

    // ───────── R6 / R7 / R8: not stopped ─────────

    [Fact]
    public async Task H38_Engine_NotStopped_OnlyExactGenerationIsIdempotentSuccess()
    {
        using var engine = NewEngine();
        Assert.False(engine.IsEmergencyStopped);
        ulong gen = engine.CurrentStopGeneration;

        Assert.False((await engine.ResumeExecutionAsync("Test", "zero", 0)).Success);
        Assert.False((await engine.ResumeExecutionAsync("Test", "future", gen + 1)).Success);
        Assert.True((await engine.ResumeExecutionAsync("Test", "exact", gen)).Success);

        // After a Stop/Resume cycle the previous generation is stale although nothing is stopped.
        var stop = await engine.TriggerEmergencyStopAsync("Test", "stop");
        Assert.True((await engine.ResumeExecutionAsync("Test", "resume", stop.StopGeneration)).Success);
        Assert.False((await engine.ResumeExecutionAsync("Test", "stale", gen)).Success);
        Assert.True((await engine.ResumeExecutionAsync("Test", "exact retry", stop.StopGeneration)).Success);
        Assert.False(engine.IsEmergencyStopped);
    }

    // ───────── R11: invalid requests never wait for the drain ─────────

    [Fact]
    public async Task H38_Engine_InvalidResume_IsRejectedBeforeDrain_ValidOneStillDrains()
    {
        using var engine = NewEngine();
        var (action, gate, reached) = await StartHeldActionAsync(engine, "act_h38_engine_hold");
        var stop = await engine.TriggerEmergencyStopAsync("Test", "stop");
        await reached.Task.WaitAsync(TimeSpan.FromSeconds(3));
        Assert.Equal(1, engine.ActiveActionCount);

        try
        {
            foreach (var (label, gen) in new[] { ("zero", 0UL), ("stale", stop.StopGeneration - 1), ("future", stop.StopGeneration + 1) })
            {
                var sw = System.Diagnostics.Stopwatch.StartNew();
                var resp = await engine.ResumeExecutionAsync("Test", label, gen, drainTimeout: TimeSpan.FromSeconds(10));
                sw.Stop();
                Assert.False(resp.Success, label);
                Assert.True(sw.Elapsed < TimeSpan.FromSeconds(1),
                    $"{label}: rejected after {sw.Elapsed.TotalMilliseconds:F0} ms; invalid Resumes must not wait for the drain");
            }

            // Preservation: a VALID resume still honours the drain (and times out while cleanup is held).
            var valid = await engine.ResumeExecutionAsync("Test", "valid", stop.StopGeneration, drainTimeout: TimeSpan.FromMilliseconds(100));
            Assert.False(valid.Success);
            Assert.Contains("still completing cancellation", valid.ErrorMessage);
            Assert.True(engine.IsEmergencyStopped);
        }
        finally
        {
            gate.TrySetResult(true);
            await action;
        }

        var after = await engine.ResumeExecutionAsync("Test", "valid after unwind", stop.StopGeneration, drainTimeout: TimeSpan.FromSeconds(2));
        Assert.True(after.Success);
    }

    // ───────── Race: a new Stop advances the generation before an older Resume attempts to clear it ─────────

    [Fact]
    public async Task H38_Engine_NewStopBeforeOlderResumeClears_OlderResumeIsRejected_NewStopSurvives()
    {
        using var engine = NewEngine();
        ulong olderGen = engine.CurrentStopGeneration;   // 1: running, not stopped, action in flight

        var (action, gate, reached) = await StartHeldActionAsync(engine, "act_h38_race_hold");

        // The older Resume is VALID when it starts (exact current generation) and parks in the drain
        // behind the in-flight action.
        var older = engine.ResumeExecutionAsync("Test", "older resume", olderGen, drainTimeout: TimeSpan.FromSeconds(10));
        await Task.Delay(150);
        Assert.False(older.IsCompleted, "the older Resume must be waiting for the drain");

        // A new Stop now latches and advances the generation.
        var stop = await engine.TriggerEmergencyStopAsync("Test", "newer stop");
        Assert.True(stop.StopGeneration > olderGen);
        await reached.Task.WaitAsync(TimeSpan.FromSeconds(3));

        // Let the in-flight action finish unwinding: the drain completes and the older Resume proceeds.
        gate.TrySetResult(true);
        await action;
        var resp = await older.WaitAsync(TimeSpan.FromSeconds(5));

        Assert.False(resp.Success, "an older Resume must not clear a newer Stop");
        Assert.Contains("Generation mismatch", resp.ErrorMessage);
        Assert.True(engine.IsEmergencyStopped, "the newer Stop must survive");
        Assert.Equal(stop.StopGeneration, engine.CurrentStopGeneration);

        // Only the new generation can resume.
        Assert.True((await engine.ResumeExecutionAsync("Test", "current", stop.StopGeneration)).Success);
        Assert.False(engine.IsEmergencyStopped);
    }

    [Fact]
    public async Task H38_Engine_ConcurrentTwinResumesVersusNewStop_NeverClearANewerStop()
    {
        using var engine = NewEngine();
        for (int i = 0; i < 100; i++)
        {
            var stop = await engine.TriggerEmergencyStopAsync("Test", $"stop {i}", $"stop_conc_{i}");
            ulong g = stop.StopGeneration;

            var twinA = Task.Run(() => engine.ResumeExecutionAsync("Test", "twin A", g, drainTimeout: TimeSpan.FromSeconds(2)));
            var twinB = Task.Run(() => engine.ResumeExecutionAsync("Test", "twin B", g, drainTimeout: TimeSpan.FromSeconds(2)));
            var newer = Task.Run(() => engine.TriggerEmergencyStopAsync("Test", $"newer {i}", $"stop_conc_newer_{i}"));
            await Task.WhenAll(twinA, twinB, newer);

            // Either the newer Stop landed while still stopped (same epoch, then resumed by a twin) or it
            // landed after the clear (new epoch). In the second case the older twins must not have cleared it.
            if (engine.CurrentStopGeneration > g)
            {
                Assert.True(engine.IsEmergencyStopped,
                    $"iteration {i}: generation advanced to {engine.CurrentStopGeneration} but a Resume for {g} cleared it");
            }

            // Reset to a known running state for the next iteration.
            if (engine.IsEmergencyStopped)
            {
                var r = await engine.ResumeExecutionAsync("Test", "reset", engine.CurrentStopGeneration);
                Assert.True(r.Success);
            }
        }
    }
}
