using System.Text.Json;
using DAsk.Daemon.Automation.Desktop;
using DAsk.Daemon.Automation.Policy;
using DAsk.Daemon.Automation.Workflows;
using DAsk.Daemon.Research;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace DAsk.Daemon.Tests;

/// <summary>Workflows: daemon-owned store, approval-gated schedules, and the scheduler's run/skip decisions (fake clock).</summary>
[Collection("AgentHost")]
public class WorkflowTests
{
    private const string Owner = "hud-session-owner";

    private sealed class Rig : IDisposable
    {
        public readonly ActionPolicyEngine Policy;
        public readonly WorkflowService Service;
        public readonly SqliteEvidenceRecorder Recorder;
        public readonly List<ActionApprovalRequest> Delivered = new();
        public readonly HashSet<string> Live = new() { Owner };
        public bool Stopped;
        public readonly string Store = Path.Combine(Path.GetTempPath(), $"dask-wf-{Guid.NewGuid():N}.json");
        private readonly string _db = Path.Combine(Path.GetTempPath(), $"dask-wf-{Guid.NewGuid():N}.db");

        public Rig(bool enabled = true)
        {
            Recorder = new SqliteEvidenceRecorder(NullLogger<SqliteEvidenceRecorder>.Instance, _db);
            Policy = new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance, Recorder);
            Policy.SetSessionLivenessGate(s => Live.Contains(s));
            Policy.ApprovalRequested += (_, r) => { lock (Delivered) Delivered.Add(r); };
            Service = new WorkflowService(Policy, () => Stopped, () => 1, Recorder, new WorkflowOptions { Enabled = enabled, StorePath = Store }, TimeSpan.FromSeconds(10));
        }

        public Task<DesktopCallResult> Call(string tool, object args) =>
            Service.ExecuteAsync(tool, JsonSerializer.SerializeToElement(args), new DesktopActionContext("t1", "c1", Owner), CancellationToken.None);

        public async Task<(DesktopCallResult res, ActionApprovalRequest req)> Schedule(object args, bool approve = true)
        {
            lock (Delivered) Delivered.Clear();
            var call = Call(WorkflowService.ScheduleTool, args);
            ActionApprovalRequest? r = null;
            for (var until = DateTime.UtcNow.AddSeconds(5); r == null && DateTime.UtcNow < until; await Task.Delay(5)) lock (Delivered) r = Delivered.LastOrDefault();
            Assert.NotNull(r);
            Assert.True(Policy.SubmitApprovalDecision(new ActionApprovalResponse
            {
                ApprovalId = r!.ApprovalId, ActionId = r.ActionId, ActionType = r.ActionType, ParametersSha256 = r.ParametersSha256,
                ActionDigest = r.ActionDigest, Approved = approve, DecisionSource = "UserExplicitConfirmation",
            }, Owner, () => Stopped, () => 1));
            return (await call, r);
        }

        public void Dispose() { SqliteConnection.ClearAllPools(); try { File.Delete(_db); } catch { } try { File.Delete(Store); } catch { } }
    }

    private static JsonElement J(DesktopCallResult r) => JsonSerializer.SerializeToElement(r.Result);
    private static readonly string[] Morning = { "Summarize docs/notes.md", "What time is it?" };

    [Fact]
    public async Task Save_List_Get_Delete_RoundTrip()
    {
        using var rig = new Rig(); await rig.Recorder.InitializeAsync();
        Assert.Equal("ok", (await rig.Call(WorkflowService.Save, new { name = "morning", steps = Morning })).Status);
        Assert.Equal("exists", (await rig.Call(WorkflowService.Save, new { name = "Morning", steps = Morning })).Error!.Code);
        var get = J(await rig.Call(WorkflowService.Get, new { name = "MORNING" }));
        Assert.Equal(Morning, get.GetProperty("steps").EnumerateArray().Select(x => x.GetString()).ToArray());
        Assert.Equal(1, J(await rig.Call(WorkflowService.List, new { })).GetProperty("workflows").GetArrayLength());
        Assert.Equal("ok", (await rig.Call(WorkflowService.Delete, new { name = "morning" })).Status);
        Assert.Equal("not_found", (await rig.Call(WorkflowService.Get, new { name = "morning" })).Error!.Code);
    }

    [Theory]
    [InlineData("run the workflow morning")]
    [InlineData("schedule something daily")]
    [InlineData("hi")]
    public async Task Save_RefusesRecursionAndBadSteps(string step)
    {
        using var rig = new Rig(); await rig.Recorder.InitializeAsync();
        Assert.Equal("invalid_args", (await rig.Call(WorkflowService.Save, new { name = "w", steps = new[] { "What time is it?", step } })).Error!.Code);
        Assert.False(File.Exists(rig.Store));
    }

    [Fact]
    public async Task Save_RefusesTooManyStepsAndBadNames()
    {
        using var rig = new Rig(); await rig.Recorder.InitializeAsync();
        Assert.Equal("invalid_args", (await rig.Call(WorkflowService.Save, new { name = "w", steps = Enumerable.Repeat("What time is it?", 9).ToArray() })).Error!.Code);
        Assert.Equal("invalid_args", (await rig.Call(WorkflowService.Save, new { name = "../x", steps = Morning })).Error!.Code);
        Assert.Equal("invalid_args", (await rig.Call(WorkflowService.Save, new { name = "w", steps = Morning, extra = 1 })).Error!.Code);
    }

    [Fact]
    public async Task Schedule_Approved_ShowsEveryStepAndTiming_AndIsStored()
    {
        using var rig = new Rig(); await rig.Recorder.InitializeAsync();
        await rig.Call(WorkflowService.Save, new { name = "morning", steps = Morning });
        var (res, req) = await rig.Schedule(new { name = "morning", kind = "daily", time = "09:00" });
        Assert.Equal("ok", res.Status);
        Assert.Equal("Workflow.Schedule", req.ActionType);
        Assert.Equal("Elevated", req.RiskLevel);
        Assert.Equal("1. Summarize docs/notes.md\n2. What time is it?", req.ActionParameters["steps"]);
        Assert.StartsWith("every day at 09:00", req.ActionParameters["when"]);
        Assert.Contains("HUD is connected", req.ActionParameters["conditions"]);
        Assert.Equal("every day at 09:00", J(await rig.Call(WorkflowService.Get, new { name = "morning" })).GetProperty("schedule").GetString());
    }

    [Fact]
    public async Task Schedule_Denied_NothingStored_AndBadTimingRefusedWithoutAsking()
    {
        using var rig = new Rig(); await rig.Recorder.InitializeAsync();
        await rig.Call(WorkflowService.Save, new { name = "morning", steps = Morning });
        var (res, _) = await rig.Schedule(new { name = "morning", kind = "weekly", time = "08:30", day = "monday" }, approve: false);
        Assert.Equal("approval_denied", res.Error!.Code);
        Assert.Equal(JsonValueKind.Null, J(await rig.Call(WorkflowService.Get, new { name = "morning" })).GetProperty("schedule").ValueKind);
        Assert.Equal("invalid_args", (await rig.Call(WorkflowService.ScheduleTool, new { name = "morning", kind = "daily", time = "25:00" })).Error!.Code);
        Assert.Equal("invalid_args", (await rig.Call(WorkflowService.ScheduleTool, new { name = "morning", kind = "weekly", time = "08:00" })).Error!.Code);
        Assert.Equal("in_the_past", (await rig.Call(WorkflowService.ScheduleTool, new { name = "morning", kind = "once", time = "08:00", date = "2020-01-01" })).Error!.Code);
        lock (rig.Delivered) Assert.Single(rig.Delivered);   // only the denied one was ever shown
    }

    [Fact]
    public void NextDue_Daily_Weekly_Once()
    {
        var at = new DateTime(2026, 11, 10, 10, 0, 0);   // a Tuesday
        Assert.Equal(new DateTime(2026, 11, 11, 9, 0, 0), WorkflowService.NextDue(new WorkflowSchedule("daily", "09:00", null, null, default, null, null), at));
        Assert.Equal(new DateTime(2026, 11, 10, 11, 0, 0), WorkflowService.NextDue(new WorkflowSchedule("daily", "11:00", null, null, default, null, null), at));
        Assert.Equal(new DateTime(2026, 11, 16, 8, 30, 0), WorkflowService.NextDue(new WorkflowSchedule("weekly", "08:30", "monday", null, default, null, null), at));
        Assert.Null(WorkflowService.NextDue(new WorkflowSchedule("once", "08:00", null, "2026-11-10", default, null, null), at));
    }

    /// <summary>A store with one schedule approved yesterday 08:00 local, daily at 09:00.</summary>
    private static void Seed(Rig rig, string kind = "daily", string? date = null)
    {
        var approved = new DateTime(2026, 11, 9, 8, 0, 0, DateTimeKind.Local).ToUniversalTime();
        var wf = new Workflow("morning", Morning.ToList(), approved, new WorkflowSchedule(kind, "09:00", null, date, approved, null, null));
        File.WriteAllText(rig.Store, JsonSerializer.Serialize(new List<Workflow> { wf }));
    }

    [Fact]
    public async Task Scheduler_DueWithLiveHud_SubmitsTheOrdinaryRunRequest_OnceOnly()
    {
        using var rig = new Rig(); await rig.Recorder.InitializeAsync();
        Seed(rig);
        var submitted = new List<(string obj, string session)>();
        var now = new DateTime(2026, 11, 9, 9, 1, 0);
        var s = new WorkflowScheduler(rig.Service, (o, sess, _) => { submitted.Add((o, sess)); return Task.FromResult((true, (string?)"submitted")); },
            () => new[] { Owner }, () => false, now: () => now);
        var r = await s.TickAsync(CancellationToken.None);
        Assert.Single(submitted);
        Assert.Equal(("Run the workflow \"morning\"", Owner), submitted[0]);
        Assert.Equal("submitted", r[0].outcome);
        now = now.AddMinutes(5);
        await s.TickAsync(CancellationToken.None);
        Assert.Single(submitted);   // not again until tomorrow 09:00
    }

    [Fact]
    public async Task Scheduler_NoHud_Stopped_Late_Disabled_AreSkippedNotRun()
    {
        var now = new DateTime(2026, 11, 9, 9, 1, 0);
        async Task<string?> Outcome(Func<IReadOnlyList<string>> live, Func<bool> stopped, DateTime at, bool enabled = true)
        {
            using var rig = new Rig(enabled); await rig.Recorder.InitializeAsync(); Seed(rig);
            int runs = 0;
            var s = new WorkflowScheduler(rig.Service, (_, _, _) => { runs++; return Task.FromResult((true, (string?)"submitted")); }, live, stopped, now: () => at);
            var r = await s.TickAsync(CancellationToken.None);
            Assert.Equal(0, runs);
            return r.FirstOrDefault().outcome;
        }
        Assert.Contains("HUD was not connected", await Outcome(() => Array.Empty<string>(), () => false, now));
        Assert.Contains("Emergency Stop", await Outcome(() => new[] { Owner }, () => true, now));
        Assert.Contains("missed", await Outcome(() => new[] { Owner }, () => false, now.AddHours(3)));
        Assert.Null(await Outcome(() => new[] { Owner }, () => false, now, enabled: false));
    }

    [Fact]
    public async Task Scheduler_OneOff_EndsAfterItsTime()
    {
        using var rig = new Rig(); await rig.Recorder.InitializeAsync();
        Seed(rig, kind: "once", date: "2026-11-09");
        var s = new WorkflowScheduler(rig.Service, (_, _, _) => Task.FromResult((true, (string?)"submitted")), () => new[] { Owner }, () => false, now: () => new DateTime(2026, 11, 9, 9, 0, 30));
        Assert.Single(await s.TickAsync(CancellationToken.None));
        Assert.Equal(JsonValueKind.Null, J(await rig.Call(WorkflowService.Get, new { name = "morning" })).GetProperty("schedule").ValueKind);
    }

    [Fact]
    public void Tools_OffByDefault_ReadOnlyCallsUnmetered()
    {
        using var off = new Rig(enabled: false);
        Assert.Empty(off.Service.Tools);
        Assert.False(new DAsk.Daemon.AgentHost.AgentHostOptions().Workflows);
        Assert.True(WorkflowService.IsUnmetered("workflows.get") && WorkflowService.IsUnmetered("workflows.list") && !WorkflowService.IsUnmetered("workflows.schedule"));
    }
}
