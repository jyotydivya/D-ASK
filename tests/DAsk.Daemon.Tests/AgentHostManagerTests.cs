using System.Diagnostics;
using System.Text.Json;
using DAsk.Daemon.AgentHost;
using DAsk.Daemon.Automation.Execution;
using DAsk.Daemon.Automation.Policy;
using DAsk.Protocol.IPC.Messages;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;
using Xunit.Abstractions;

namespace DAsk.Daemon.Tests;

/// <summary>
/// Phase 5: daemon-side lifecycle of the stdio agent host. These start real Node processes over real
/// pipes. The model is scripted (tests/agent-host/fixtures/scriptedHost.ts); protocol, runtime, planner,
/// verifier and tools are real. Build first: npm run build:agent-host-test.
/// </summary>
[Collection("AgentHost")]
public class AgentHostManagerTests
{
    private const string Scripted = "dist/agent-host-test/tests/agent-host/fixtures/scriptedHost.js";
    private const string BadHost = "tests/agent-host/fixtures/badHost.cjs";
    private static readonly string Root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));

    private readonly ITestOutputHelper _output;
    public AgentHostManagerTests(ITestOutputHelper output) => _output = output;

    internal static AgentHostOptions Options(string entry = Scripted, Action<AgentHostOptions>? configure = null)
    {
        Assert.True(File.Exists(Path.Combine(Root, Scripted)), "Build the test host first: npm run build:agent-host-test");
        var o = new AgentHostOptions
        {
            RepoRoot = Root,
            EntryPath = entry,
            AutoRestart = false,
            ReadyTimeoutMs = 10_000,
            RequestTimeoutMs = 2_000,
            HealthIntervalMs = 200,
            RestartBackoffMs = 50,
            ShutdownTimeoutMs = 3_000,
        };
        configure?.Invoke(o);
        return o;
    }

    private static AgentHostManager Manager(AgentHostOptions o, ActionExecutionEngine? engine = null) =>
        new(Microsoft.Extensions.Options.Options.Create(o), NullLogger<AgentHostManager>.Instance, engine);

    private static AgentHostOptions Bad(string mode, Action<AgentHostOptions>? configure = null) => Options(BadHost, o =>
    {
        o.ExtraEnvironment["DASK_BAD_HOST_MODE"] = mode;
        configure?.Invoke(o);
    });

    /// <summary>Awaits the next finished task of a manager, whichever way it ended.</summary>
    private static async Task<AgentTaskResultNotification> FinishedAsync(AgentHostManager m, string taskId, int timeoutMs = 10_000)
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (DateTime.UtcNow < deadline)
        {
            var r = m.GetTask(taskId, "s1")?.Result;
            if (r != null) return r;
            await Task.Delay(10);
        }
        throw new TimeoutException($"Task {taskId} did not finish in {timeoutMs} ms");
    }

    private static async Task<bool> WaitAsync(Func<bool> cond, int timeoutMs = 8_000)
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (DateTime.UtcNow < deadline)
        {
            if (cond()) return true;
            await Task.Delay(20);
        }
        return cond();
    }

    private static bool Alive(int? pid)
    {
        if (pid is not int p) return false;
        try { using var x = Process.GetProcessById(p); return !x.HasExited; }
        catch (ArgumentException) { return false; }
    }

    private static string Evidence(AgentTaskResultNotification r) =>
        r.Steps!.Value.EnumerateArray().First().GetProperty("evidence").GetString() ?? "";

    private sealed class NullStateManager : DAsk.Daemon.State.IStateManager
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

    private static (ActionExecutionEngine engine, ActionPolicyEngine policy) Engine()
    {
        var state = new NullStateManager();
        var policy = new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance, null);
        var engine = new ActionExecutionEngine(NullLogger<ActionExecutionEngine>.Instance, state, policy, null, ActionExecutionEngine.MaxQueueCapacityDefault, 1);
        engine.SetPanicHotkeyStatus(true, "test hotkey", 0);
        return (engine, policy);
    }

    // ── Startup and readiness ────────────────────────────────────────────────

    [Fact]
    public async Task Start_DetectsReadiness_AndConcurrentStartsCreateOneProcess()
    {
        await using var m = Manager(Options());
        Assert.Equal(AgentHostState.Stopped, m.State);
        Assert.Null(m.HostPid); // lazy: nothing runs until first use

        var sw = Stopwatch.StartNew();
        await Task.WhenAll(Enumerable.Range(0, 10).Select(_ => m.EnsureStartedAsync(CancellationToken.None)));
        _output.WriteLine($"MEASURED start to ready (scripted host): {sw.ElapsedMilliseconds} ms");

        Assert.Equal(AgentHostState.Ready, m.State);
        int pid = m.HostPid!.Value;
        Assert.True(Alive(pid));
        await m.EnsureStartedAsync(CancellationToken.None);
        Assert.Equal(pid, m.HostPid); // already running: reused, not duplicated
        Assert.Equal(1, m.ProcessesStarted); // ten concurrent callers, one process
    }

    [Fact]
    public async Task StartupFailure_MissingEntry_IsReported_NotThrownAtTheCaller()
    {
        await using var m = Manager(Options("dist/does-not-exist.js"));
        var r = await m.SubmitAsync("What time is it?", "s1");
        Assert.False(r.Accepted);
        Assert.Equal("host_unavailable", r.RejectionCode);
        Assert.Contains("build:agent-host", r.ErrorMessage);
        Assert.Equal(AgentHostState.Failed, m.State);
    }

    [Fact]
    public async Task StartupFailure_MissingNode_IsReported()
    {
        await using var m = Manager(Options(configure: o => o.NodePath = "no-such-node-binary-xyz"));
        var r = await m.SubmitAsync("What time is it?", "s1");
        Assert.False(r.Accepted);
        Assert.Equal("host_unavailable", r.RejectionCode);
    }

    [Theory]
    [InlineData("exit-immediately")]
    [InlineData("refuse-hello")]
    public async Task StartupFailure_BadHost_IsRefused(string mode)
    {
        await using var m = Manager(Bad(mode));
        var r = await m.SubmitAsync("What time is it?", "s1");
        Assert.False(r.Accepted);
        Assert.Equal("host_unavailable", r.RejectionCode);
        Assert.Null(m.HostPid);
    }

    [Fact]
    public async Task StartupFailure_HostThatNeverAnswers_TimesOut_AndIsKilled()
    {
        await using var m = Manager(Bad("never-ready", o => o.ReadyTimeoutMs = 700));
        var r = await m.SubmitAsync("What time is it?", "s1");
        Assert.False(r.Accepted);
        Assert.Contains("startup failed", r.ErrorMessage);
        Assert.True(await WaitAsync(() => !Alive(m.LastHostPid)), "the unresponsive host must not be left running");
    }

    [Fact]
    public async Task Disabled_RefusesTasks()
    {
        await using var m = Manager(Options(configure: o => o.Enabled = false));
        var r = await m.SubmitAsync("What time is it?", "s1");
        Assert.Equal("agent_host_disabled", r.RejectionCode);
        Assert.Null(m.HostPid);
    }

    // ── Tasks: real outcomes, correlation ────────────────────────────────────

    [Fact]
    public async Task Submit_RunsRuntime_AndReportsTheActualOutcome()
    {
        await using var m = Manager(Options());
        var ok = await m.SubmitAsync("What time is it?", "s1");
        Assert.True(ok.Accepted);
        var done = await FinishedAsync(m, ok.TaskId!);
        Assert.Equal("completed", done.Outcome);
        Assert.False(done.Interrupted);
        Assert.Equal(ok.TaskId, done.TaskId);
        Assert.True(done.Verification!.Value.GetProperty("independentlyVerified").GetBoolean());

        var unverified = await m.SubmitAsync("Do the thing we discussed about the time", "s1");
        Assert.Equal("unverified", (await FinishedAsync(m, unverified.TaskId!)).Outcome);

        var failed = await m.SubmitAsync("calc 1/0", "s1");
        Assert.Equal("failed", (await FinishedAsync(m, failed.TaskId!)).Outcome);
    }

    [Fact]
    public async Task ConcurrentSubmit_IsBusy_AndEachResultReachesItsOwnTask()
    {
        await using var m = Manager(Options());
        var a = await m.SubmitAsync("slowtool", "s1");
        Assert.True(a.Accepted);
        var b = await m.SubmitAsync("What time is it?", "s1");
        Assert.False(b.Accepted);
        Assert.Equal("busy", b.RejectionCode);
        Assert.Null(m.GetTask(b.TaskId ?? "", "s1"));
        await m.CancelAsync(a.TaskId!, "s1");
        Assert.Equal("cancelled", (await FinishedAsync(m, a.TaskId!)).Outcome);

        // Sequential tasks get their own results.
        var c = await m.SubmitAsync("calc 2+2", "s1");
        var cDone = await FinishedAsync(m, c.TaskId!);
        var d = await m.SubmitAsync("calc 3+3", "s1");
        var dDone = await FinishedAsync(m, d.TaskId!);
        Assert.Contains("= 4", Evidence(cDone));
        Assert.Contains("= 6", Evidence(dDone));
    }

    [Fact]
    public async Task InvalidObjective_IsRefused_WithoutStartingTheHost()
    {
        await using var m = Manager(Options());
        Assert.Equal("invalid_request", (await m.SubmitAsync("   ", "s1")).RejectionCode);
        Assert.Equal("invalid_request", (await m.SubmitAsync(new string('x', 4001), "s1")).RejectionCode);
        Assert.Null(m.HostPid);
    }

    [Fact]
    public async Task CloudCredentials_NeverReachTheHost()
    {
        Environment.SetEnvironmentVariable("GROQ_API_KEY", "gsk_must_not_reach_host");
        try
        {
            await using var m = Manager(Options());
            var r = await m.SubmitAsync("envcheck", "s1");
            Assert.Equal("token=absent cloud=absent", Evidence(await FinishedAsync(m, r.TaskId!)));
        }
        finally { Environment.SetEnvironmentVariable("GROQ_API_KEY", null); }
    }

    // ── Cancellation and ownership ───────────────────────────────────────────

    [Theory]
    [InlineData("slowmodel")]
    [InlineData("slowtool")]
    public async Task Cancel_DuringInferenceOrTool(string objective)
    {
        await using var m = Manager(Options());
        var r = await m.SubmitAsync(objective, "s1");
        await Task.Delay(150);
        var sw = Stopwatch.StartNew();
        var c = await m.CancelAsync(r.TaskId!, "s1");
        Assert.True(c.Cancelling);
        var done = await FinishedAsync(m, r.TaskId!);
        _output.WriteLine($"MEASURED daemon cancel round trip during {objective}: {sw.ElapsedMilliseconds} ms");
        Assert.Equal("cancelled", done.Outcome);
        Assert.True(sw.ElapsedMilliseconds < 1000);
        Assert.Equal("already_finished", (await m.CancelAsync(r.TaskId!, "s1")).RejectionCode);
    }

    [Fact]
    public async Task OtherSessions_CannotSeeOrCancelATask()
    {
        await using var m = Manager(Options());
        var r = await m.SubmitAsync("slowtool", "owner");
        Assert.Null(m.GetTask(r.TaskId!, "intruder"));
        Assert.Equal("unknown_task", (await m.CancelAsync(r.TaskId!, "intruder")).RejectionCode);
        Assert.Equal("running", m.GetTask(r.TaskId!, "owner")!.State);

        // The owner going away cancels its work, like the execution engine does.
        m.CancelTasksForSession("owner");
        Assert.True(await WaitAsync(() => m.GetTask(r.TaskId!, "owner")!.Result != null));
        Assert.Equal("cancelled", m.GetTask(r.TaskId!, "owner")!.Result!.Outcome);
    }

    // ── Crash, restart, no replay ────────────────────────────────────────────

    [Fact]
    public async Task HostCrash_InterruptsTheTask_RestartsIdle_AndNeverReplays()
    {
        await using var m = Manager(Options(configure: o => o.AutoRestart = true));
        var r = await m.SubmitAsync("crash", "s1");
        Assert.True(r.Accepted);
        int firstPid = m.HostPid!.Value;

        var sw = Stopwatch.StartNew();
        var done = await FinishedAsync(m, r.TaskId!);
        Assert.Equal("failed", done.Outcome);
        Assert.True(done.Interrupted);
        Assert.Equal("host_crashed", done.ErrorCode);
        Assert.Contains("will not be retried", done.Response);

        Assert.True(await WaitAsync(() => m.State == AgentHostState.Ready && m.HostPid != firstPid), "the host should come back");
        _output.WriteLine($"MEASURED crash to ready again: {sw.ElapsedMilliseconds} ms (backoff {50} ms)");
        Assert.False(Alive(firstPid));
        Assert.Equal(1, m.Restarts);

        // Nothing was replayed: the new host is idle, and stays up (a replay of "crash" would kill it).
        await Task.Delay(500);
        Assert.Equal(AgentHostState.Ready, m.State);
        Assert.Null(m.Health().ActiveTaskId);
        Assert.Equal(1, m.Restarts);

        var again = await m.SubmitAsync("What time is it?", "s1");
        Assert.Equal("completed", (await FinishedAsync(m, again.TaskId!)).Outcome);
    }

    [Fact]
    public async Task RepeatedCrashes_AreBounded_ThenStayDown()
    {
        await using var m = Manager(Options(configure: o => { o.AutoRestart = true; o.MaxRestarts = 2; o.RestartBackoffMs = 10; }));
        for (int i = 0; i < 3; i++)
        {
            Assert.True(await WaitAsync(() => m.State != AgentHostState.Restarting));
            var r = await m.SubmitAsync("crash", "s1");
            Assert.True(r.Accepted, $"submit {i}: {r.RejectionCode} {r.ErrorMessage}");
            await FinishedAsync(m, r.TaskId!);
            await WaitAsync(() => m.State != AgentHostState.Ready || m.HostPid == null, 1000);
        }
        Assert.True(await WaitAsync(() => m.State == AgentHostState.Failed), $"state is {m.State}");
        var refused = await m.SubmitAsync("What time is it?", "s1");
        Assert.False(refused.Accepted);
        Assert.Equal("host_unavailable", refused.RejectionCode);
        Assert.Contains("not restarting", refused.ErrorMessage);
    }

    [Fact]
    public async Task Restart_DoesNotBypassApprovals_OrRepeatActions()
    {
        string marker = Path.Combine(Path.GetTempPath(), "dask-host-marker-" + Guid.NewGuid().ToString("N"));
        await using var m = Manager(Options(configure: o => { o.AutoRestart = true; o.ExtraEnvironment["DASK_TEST_MARKER_FILE"] = marker; }));

        var denied = await m.SubmitAsync("approval", "s1");
        var result = await FinishedAsync(m, denied.TaskId!);
        Assert.Equal("failed", result.Outcome);
        Assert.Contains("Approval denied", result.Steps!.Value[0].GetProperty("error").GetString());

        var crash = await m.SubmitAsync("crash", "s1");
        await FinishedAsync(m, crash.TaskId!);
        int? pid = null;
        Assert.True(await WaitAsync(() => { pid = m.HostPid; return m.State == AgentHostState.Ready && pid != null; }));

        var deniedAgain = await m.SubmitAsync("approval", "s1");
        Assert.Equal("failed", (await FinishedAsync(m, deniedAgain.TaskId!)).Outcome);
        Assert.False(File.Exists(marker), "an approval-required tool executed");
    }

    // ── Malformed host output and hung hosts ─────────────────────────────────

    [Theory]
    [InlineData("stdout-noise")]
    [InlineData("wrong-id")]
    [InlineData("forged-event")]
    public async Task ProtocolViolation_KillsTheHost(string mode)
    {
        await using var m = Manager(Bad(mode));
        await m.EnsureStartedAsync(CancellationToken.None);
        int pid = m.HostPid!.Value;
        Assert.True(await WaitAsync(() => !Alive(pid)), "a host that corrupts the protocol must be terminated");
        Assert.Contains("invalid protocol message", m.Health().LastError);
    }

    [Fact]
    public async Task ForgedOutcome_FromAHost_IsNeverReportedAsSuccess()
    {
        await using var m = Manager(Bad("bad-outcome"));
        var r = await m.SubmitAsync("What time is it?", "s1");
        var done = await FinishedAsync(m, r.TaskId!);
        Assert.Equal("failed", done.Outcome);
    }

    [Fact]
    public async Task HungHost_MuteAfterHello_IsDetected_AndTheTaskIsInterrupted()
    {
        await using var m = Manager(Bad("mute-after-hello", o => { o.RequestTimeoutMs = 300; o.HealthIntervalMs = 100; }));
        await m.EnsureStartedAsync(CancellationToken.None);
        int pid = m.HostPid!.Value;
        Assert.True(await WaitAsync(() => !Alive(pid)), "the hung host should be killed");
        Assert.Contains("stopped responding", m.Health().LastError);
    }

    [Fact]
    public async Task HungHost_BlockedEventLoop_InterruptsTheTask()
    {
        await using var m = Manager(Options(configure: o => { o.RequestTimeoutMs = 400; o.HealthIntervalMs = 100; }));
        var r = await m.SubmitAsync("wedge", "s1");
        Assert.True(r.Accepted);
        var done = await FinishedAsync(m, r.TaskId!);
        Assert.True(done.Interrupted);
        Assert.Equal("host_unresponsive", done.ErrorCode);
        Assert.Equal("failed", done.Outcome);
    }

    // ── Shutdown ─────────────────────────────────────────────────────────────

    [Fact]
    public async Task Shutdown_Graceful_AndDuringATask()
    {
        var m = Manager(Options());
        var r = await m.SubmitAsync("slowtool", "s1");
        int pid = m.HostPid!.Value;
        await Task.Delay(100);
        var sw = Stopwatch.StartNew();
        await m.ShutdownAsync("test");
        _output.WriteLine($"MEASURED shutdown during a task: {sw.ElapsedMilliseconds} ms");
        Assert.False(Alive(pid));
        Assert.Equal(AgentHostState.Stopped, m.State);
        var result = m.GetTask(r.TaskId!, "s1")!.Result!;
        Assert.Contains(result.Outcome, new[] { "cancelled", "failed" });
        Assert.NotEqual("completed", result.Outcome);
        await m.DisposeAsync();
    }

    [Fact]
    public async Task Shutdown_OfAHostThatIgnoresIt_KillsTheProcess()
    {
        var m = Manager(Bad("mute-after-hello", o => { o.RequestTimeoutMs = 300; o.ShutdownTimeoutMs = 300; o.HealthIntervalMs = 60_000; }));
        await m.EnsureStartedAsync(CancellationToken.None);
        int pid = m.HostPid!.Value;
        await m.ShutdownAsync("test");
        Assert.True(await WaitAsync(() => !Alive(pid)));
        await m.DisposeAsync();
    }

    // ── Emergency Stop (the daemon's engine is the authority) ────────────────

    [Fact]
    public async Task EmergencyStop_AbortsTheTask_RefusesNew_AndResumeRequiresAValidEngineResume()
    {
        var (engine, _) = Engine();
        await using var m = Manager(Options(), engine);
        var r = await m.SubmitAsync("slowtool", "s1");
        await Task.Delay(150);

        var sw = Stopwatch.StartNew();
        var stop = await engine.TriggerEmergencyStopAsync("test", "unit test");
        var done = await FinishedAsync(m, r.TaskId!);
        _output.WriteLine($"MEASURED engine stop to task ended: {sw.ElapsedMilliseconds} ms");
        Assert.Equal("cancelled", done.Outcome);
        Assert.True(sw.ElapsedMilliseconds < 500, $"{sw.ElapsedMilliseconds} ms");

        Assert.Equal("emergency_stopped", (await m.SubmitAsync("What time is it?", "s1")).RejectionCode);

        // A stale resume is refused by the engine, so it never reaches the host.
        var stale = await engine.ResumeExecutionAsync("test", "stale", stop.StopGeneration + 5, "r1", "s1");
        Assert.False(stale.Success);
        Assert.Equal("emergency_stopped", (await m.SubmitAsync("What time is it?", "s1")).RejectionCode);

        var resume = await engine.ResumeExecutionAsync("test", "ok", stop.StopGeneration, "r2", "s1");
        Assert.True(resume.Success);
        Assert.True(await WaitAsync(() => !engine.IsEmergencyStopped));
        // Host side catches up asynchronously; submit may be refused briefly until it has.
        AgentSubmitResult after = new(false, null, null, null);
        Assert.True(await WaitAsync(() => { after = m.SubmitAsync("What time is it?", "s1").GetAwaiter().GetResult(); return after.Accepted; }));
        Assert.Equal("completed", (await FinishedAsync(m, after.TaskId!)).Outcome);
    }

    [Fact]
    public async Task EmergencyStop_HostThatDoesNotAcknowledge_IsKilled_AndRestartStaysStopped()
    {
        var (engine, _) = Engine();
        await using var m = Manager(Bad("mute-after-hello", o => { o.HealthIntervalMs = 60_000; o.StopAckTimeoutMs = 300; o.RequestTimeoutMs = 300; }), engine);
        await m.EnsureStartedAsync(CancellationToken.None);
        int pid = m.HostPid!.Value;

        var sw = Stopwatch.StartNew();
        await engine.TriggerEmergencyStopAsync("test", "unit test");
        Assert.True(await WaitAsync(() => !Alive(pid), 3000), "an unacknowledging host must be killed");
        _output.WriteLine($"MEASURED unacknowledged stop to process dead: {sw.ElapsedMilliseconds} ms");
        Assert.Contains("did not acknowledge", m.Health().LastError);
        Assert.Equal("emergency_stopped", (await m.SubmitAsync("What time is it?", "s1")).RejectionCode);
    }

    [Fact]
    public async Task EmergencyStop_DuringAHostRestart_NewHostStartsStopped()
    {
        var (engine, _) = Engine();
        await using var m = Manager(Options(configure: o => o.AutoRestart = true), engine);
        var crash = await m.SubmitAsync("crash", "s1");
        await engine.TriggerEmergencyStopAsync("test", "during restart");
        await FinishedAsync(m, crash.TaskId!);
        Assert.True(await WaitAsync(() => m.State == AgentHostState.Ready));
        Assert.True(m.Health().EmergencyStopped);
        Assert.Equal("emergency_stopped", (await m.SubmitAsync("What time is it?", "s1")).RejectionCode);
    }
}

[CollectionDefinition("AgentHost", DisableParallelization = true)]
public class AgentHostCollection { }
