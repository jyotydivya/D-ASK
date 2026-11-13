using System.Text.Json;
using DAsk.Daemon.AgentHost;
using DAsk.Daemon.Automation.Desktop;
using DAsk.Daemon.Automation.Observation;
using DAsk.Daemon.Automation.Policy;
using DAsk.Daemon.Research;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
using static DAsk.Daemon.Tests.Phase7B1bTests;

namespace DAsk.Daemon.Tests;

/// <summary>
/// Phase 7B.2 — approval-connected window-operation requests, with no executor. The pathway under test is the real one:
/// DesktopActionRequestService → ActionPolicyEngine (registration, owner-only delivery event, decision validation,
/// single-use consumption) → identity revalidation. The HUD is represented by the policy engine's delivery event and
/// SubmitApprovalDecision, exactly as IpcClientSession calls it. Windows are constructed (no real desktop is touched).
/// </summary>
[Collection("AgentHost")]
public class Phase7B2Tests
{
    private const string Owner = "hud-session-owner";
    private const string Other = "hud-session-other";

    private sealed class Rig : IDisposable
    {
        public readonly FakeWindows Windows = new();
        public readonly ActionPolicyEngine Policy;
        public readonly DesktopActionRequestService Service;
        public readonly HashSet<string> Live = new() { Owner, Other };
        public bool Stopped;
        public ulong Generation = 1;
        public readonly List<ActionApprovalRequest> Delivered = new();
        public readonly List<(string Session, ApprovalStateNotification N)> States = new();
        public readonly SqliteEvidenceRecorder? Recorder;
        public readonly string? Db;

        public Rig(TimeSpan? ttl = null, bool audit = false)
        {
            if (audit)
            {
                Db = Path.Combine(Path.GetTempPath(), $"dask-7b2-{Guid.NewGuid():N}.db");
                Recorder = new SqliteEvidenceRecorder(NullLogger<SqliteEvidenceRecorder>.Instance, Db);
            }
            Policy = new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance, Recorder);
            Policy.SetSessionLivenessGate(s => Live.Contains(s));
            Policy.ApprovalRequested += (_, r) => { lock (Delivered) Delivered.Add(r); };
            Policy.ApprovalStateChanged += (_, e) => { lock (States) States.Add(e); };
            Windows.Windows.Add(W(100, 4000, "notepad.exe", "Untitled - Notepad"));
            var reader = new DesktopReadService(Windows, new FakeUia());
            Service = new DesktopActionRequestService(reader, Policy, () => Stopped, () => Generation, Recorder,
                new DesktopActionOptions { ApprovalTtl = ttl ?? TimeSpan.FromSeconds(30) });
        }

        public Task<DesktopCallResult> Ask(object args, CancellationToken ct = default, string tool = DesktopActionRequestService.SetWindowStateTool, string owner = Owner) =>
            Service.ExecuteAsync(tool, JsonSerializer.SerializeToElement(args), new DesktopActionContext("t1", "c1", owner), ct);

        public async Task<ActionApprovalRequest> DeliveredAsync(int n = 1)
        {
            var until = DateTime.UtcNow.AddSeconds(5);
            while (DateTime.UtcNow < until) { lock (Delivered) if (Delivered.Count >= n) return Delivered[n - 1]; await Task.Delay(5); }
            throw new TimeoutException("no approval reached the HUD");
        }

        /// <summary>What the HUD sends: the decision with the echoed hash and digest, from the deciding session.</summary>
        public bool Decide(ActionApprovalRequest r, bool approved, string session = Owner, string? digest = null) =>
            Policy.SubmitApprovalDecision(new ActionApprovalResponse
            {
                ApprovalId = r.ApprovalId, ActionId = r.ActionId, ActionType = r.ActionType, ParametersSha256 = r.ParametersSha256,
                ActionDigest = digest ?? r.ActionDigest, Approved = approved, DecisionSource = "UserExplicitConfirmation",
            }, session, () => Stopped, () => Generation);

        public void Dispose()
        {
            if (Db != null) { SqliteConnection.ClearAllPools(); try { File.Delete(Db); } catch { } }
        }
    }

    private static JsonElement J(DesktopCallResult r) => JsonSerializer.SerializeToElement(r.Result);
    private static readonly object Minimize = new { process = "notepad.exe", state = "minimize" };

    // ── request construction, identity and display ──

    [Fact]
    public async Task Request_IsBoundToTheDaemonResolvedIdentity_AndFullyDisplayable()
    {
        using var rig = new Rig();
        var call = rig.Ask(Minimize);
        var r = await rig.DeliveredAsync();

        Assert.Equal(DesktopActionTypes.SetWindowState, r.ActionType);
        Assert.Equal(Owner, r.SessionId);                 // the task's owner, from the daemon's record
        Assert.Equal(100, r.TargetHwnd);                  // from the OS (fake source), never from the agent
        Assert.Equal(4000, r.TargetProcessId);
        Assert.Equal(DateTime.FromFileTimeUtc(T0), r.TargetProcessCreationTime!.Value.UtcDateTime);
        Assert.Equal("Elevated", r.RiskLevel);
        Assert.Equal(1UL, r.StopGeneration);
        Assert.True(r.ExpiresAtUtc - r.CreatedAtUtc <= ActionPolicyEngine.MaxApprovalTtl);
        foreach (var key in new[] { "operation", "state", "window", "application", "imagePath", "windowClass", "processStarted", "logonSession", "display", "reversible", "execution" })
            Assert.True(r.ActionParameters.ContainsKey(key), $"parameter {key} is shown");
        Assert.Equal("minimize", r.ActionParameters["state"]);
        Assert.Equal(@"C:\Fixture\notepad.exe", r.ActionParameters["imagePath"]);
        Assert.Contains("Not performed", r.ActionParameters["execution"]);
        Assert.Null(ActionPolicyEngine.ValidateRepresentable(r));

        // The canonical action (what the HUD renders) contains every parameter and the identity, and its digest is the daemon's.
        var (canonical, digest) = ActionPolicyEngine.BuildCanonicalAction(r with { ActionDigest = null, CanonicalAction = null });
        Assert.Equal(r.CanonicalAction, canonical);
        Assert.Equal(r.ActionDigest, digest);
        using var doc = JsonDocument.Parse(canonical);
        Assert.Equal(r.ActionParameters.Count, doc.RootElement.GetProperty("parameters").EnumerateObject().Count());
        Assert.Equal(100, doc.RootElement.GetProperty("target").GetProperty("hwnd").GetInt64());
        Assert.Equal(ActionPolicyEngine.ComputeCanonicalHash(r.ActionParameters), r.ParametersSha256);

        rig.Decide(r, approved: false);
        Assert.Equal("approval_denied", (await call).Error!.Code);
    }

    [Fact]
    public void Digest_IsInjective_DifferentParametersOrTargetsNeverCollide()
    {
        var baseReq = new ActionApprovalRequest
        {
            ApprovalId = "a1a1a1a1", ActionId = "b1", ActionType = DesktopActionTypes.SetWindowState, SessionId = Owner,
            ActionParameters = new() { ["state"] = "minimize", ["window"] = "x" }, TargetHwnd = 1, TargetProcessId = 2,
            CreatedAtUtc = DateTimeOffset.UnixEpoch, ExpiresAtUtc = DateTimeOffset.UnixEpoch.AddSeconds(30),
        };
        var d0 = ActionPolicyEngine.BuildCanonicalAction(baseReq).Digest;
        Assert.Equal(d0, ActionPolicyEngine.BuildCanonicalAction(baseReq).Digest); // deterministic
        Assert.NotEqual(d0, ActionPolicyEngine.BuildCanonicalAction(baseReq with { ActionParameters = new() { ["state"] = "maximize", ["window"] = "x" } }).Digest);
        Assert.NotEqual(d0, ActionPolicyEngine.BuildCanonicalAction(baseReq with { TargetHwnd = 3 }).Digest);
        Assert.NotEqual(d0, ActionPolicyEngine.BuildCanonicalAction(baseReq with { SessionId = Other }).Digest);
        // Separator ambiguity cannot make two different parameter sets equal.
        Assert.NotEqual(ActionPolicyEngine.ComputeCanonicalHash(new() { ["a"] = "b,c=d" }), ActionPolicyEngine.ComputeCanonicalHash(new() { ["a"] = "b", ["c"] = "d" }));
    }

    [Theory]
    [InlineData("{\"process\":\"notepad.exe\",\"state\":\"minimize\",\"hwnd\":100}")]
    [InlineData("{\"process\":\"notepad.exe\",\"state\":\"minimize\",\"pid\":4000}")]
    [InlineData("{\"process\":\"notepad.exe\",\"state\":\"minimize\",\"approvalId\":\"x\"}")]
    [InlineData("{\"process\":\"notepad.exe\",\"state\":\"minimize\",\"approved\":true}")]
    [InlineData("{\"process\":\"notepad.exe\",\"state\":\"minimize\",\"sessionId\":\"hud-session-other\"}")]
    [InlineData("{\"process\":\"notepad.exe\",\"state\":\"close\"}")]
    [InlineData("{\"process\":\"notepad.exe\"}")]
    [InlineData("{\"state\":\"minimize\"}")]
    [InlineData("{\"process\":\"..\\\\x\",\"state\":\"minimize\"}")]
    public async Task MalformedOrUnknownArgs_AreRejected_AndNothingReachesTheHud(string json)
    {
        using var rig = new Rig();
        using var doc = JsonDocument.Parse(json);
        var r = await rig.Service.ExecuteAsync(DesktopActionRequestService.SetWindowStateTool, doc.RootElement, new DesktopActionContext("t1", "c1", Owner), default);
        Assert.Equal("invalid_args", r.Error!.Code);
        Assert.Empty(rig.Delivered);
    }

    [Fact]
    public async Task AmbiguousMissingSensitiveOrIncompleteTargets_NeverProduceAnApproval()
    {
        using var rig = new Rig();
        rig.Windows.Windows.Add(W(101, 4001, "notepad.exe", "Other - Notepad"));
        Assert.Equal("ambiguous_target", (await rig.Ask(Minimize)).Error!.Code);
        Assert.Equal("target_not_found", (await rig.Ask(new { process = "missing.exe", state = "minimize" })).Error!.Code);
        rig.Windows.Windows.Add(W(102, 4002, "KeePass.exe", "db - KeePass"));
        Assert.Equal("target_forbidden", (await rig.Ask(new { process = "KeePass.exe", state = "minimize" })).Error!.Code);
        rig.Windows.Windows.Add(W(103, 4003, "bad.exe", "Bad") with { ProcessCreationFileTime = 0 });
        Assert.Equal("identity_uncertain", (await rig.Ask(new { process = "bad.exe", state = "minimize" })).Error!.Code);
        Assert.Equal("unknown_tool", (await rig.Ask(Minimize, tool: "desktop.click")).Error!.Code);
        Assert.Empty(rig.Delivered);
        Assert.Equal(0, rig.Policy.PendingApprovalCount);
    }

    [Fact]
    public async Task UndisplayableTitle_IsNeverOffered()
    {
        using var rig = new Rig();
        rig.Windows.Windows[0] = W(100, 4000, "notepad.exe", "Invoice \u202Etxt.exe");
        var r = await rig.Ask(Minimize);
        Assert.Equal("approval_refused", r.Error!.Code);
        Assert.Empty(rig.Delivered);
    }

    // ── lifecycle ──

    [Fact]
    public async Task Approve_IsValidatedConsumedOnce_RevalidatedAndNotExecuted()
    {
        using var rig = new Rig();
        var call = rig.Ask(Minimize);
        var r = await rig.DeliveredAsync();
        Assert.True(rig.Decide(r, approved: true));
        var res = await call;
        Assert.Equal("ok", res.Status);
        var j = J(res);
        Assert.Equal("approved", j.GetProperty("decision").GetString());
        Assert.True(j.GetProperty("consumed").GetBoolean());
        Assert.True(j.GetProperty("identityRevalidated").GetBoolean());
        Assert.False(j.GetProperty("executed").GetBoolean());
        Assert.False(j.GetProperty("executionAvailable").GetBoolean());
        Assert.Equal(0, rig.Policy.GrantedApprovalCount); // consumed

        // Replay: the same approval can never be used again.
        var (valid, error) = rig.Policy.ValidateConsumedApproval(r.ApprovalId, r.ActionId, r.ActionType, r.ActionParameters, r.TargetProcessName,
            r.TargetHwnd, r.TargetProcessId, r.TargetProcessCreationTime, Owner, rig.Generation, false);
        Assert.False(valid);
        Assert.Contains("Replay", error);
        // Duplicate or late decision: not accepted.
        Assert.False(rig.Decide(r, approved: true));
        Assert.Contains(rig.States, s => s.N.ApprovalId == r.ApprovalId && s.N.State == ApprovalStates.Approved);
    }

    [Fact]
    public async Task OnlyTheOwnerSessionCanDecide()
    {
        using var rig = new Rig();
        var call = rig.Ask(Minimize);
        var r = await rig.DeliveredAsync();
        Assert.False(rig.Decide(r, approved: true, session: Other));
        Assert.False(call.IsCompleted);
        Assert.Equal(1, rig.Policy.PendingApprovalCount); // still pending for the owner
        Assert.True(rig.Decide(r, approved: false, session: Owner));
        Assert.Equal("approval_denied", (await call).Error!.Code);
    }

    [Fact]
    public async Task TamperedDigestOrHash_IsRejected()
    {
        using var rig = new Rig();
        var call = rig.Ask(Minimize);
        var r = await rig.DeliveredAsync();
        Assert.True(rig.Decide(r, approved: true, digest: new string('0', 64)));
        Assert.Equal("approval_refused", (await call).Error!.Code);
        Assert.Equal(0, rig.Policy.GrantedApprovalCount);
    }

    [Fact]
    public async Task Expiry_EndsTheRequest()
    {
        using var rig = new Rig(ttl: TimeSpan.FromMilliseconds(300));
        var call = rig.Ask(Minimize);
        var r = await rig.DeliveredAsync();
        Assert.Equal("approval_expired", (await call.WaitAsync(TimeSpan.FromSeconds(5))).Error!.Code);
        Assert.False(rig.Decide(r, approved: true)); // late decision
        Assert.Equal(0, rig.Policy.GrantedApprovalCount);
    }

    [Fact]
    public async Task Cancellation_InvalidatesThePendingApproval()
    {
        using var rig = new Rig();
        using var cts = new CancellationTokenSource();
        var call = rig.Ask(Minimize, cts.Token);
        var r = await rig.DeliveredAsync();
        cts.Cancel();
        Assert.Equal("cancelled", (await call).Status);
        Assert.Equal(0, rig.Policy.PendingApprovalCount);
        Assert.False(rig.Decide(r, approved: true));
        Assert.Contains(rig.States, s => s.Session == Owner && s.N.ApprovalId == r.ApprovalId && s.N.State == ApprovalStates.Cancelled);
    }

    [Fact]
    public async Task HudDisconnect_InvalidatesThePendingApproval()
    {
        using var rig = new Rig();
        var call = rig.Ask(Minimize);
        var r = await rig.DeliveredAsync();
        rig.Live.Remove(Owner);
        rig.Policy.InvalidateApprovalsForSession(Owner, "Client disconnected"); // what IpcClientSession does on disconnect
        Assert.Equal("hud_unavailable", (await call).Error!.Code);
        Assert.False(rig.Decide(r, approved: true));
    }

    [Fact]
    public async Task LeaseLoss_BeforeOrDuringTheRequest()
    {
        using var rig = new Rig();
        rig.Live.Remove(Owner);
        Assert.Equal("hud_unavailable", (await rig.Ask(Minimize)).Error!.Code); // never offered to a HUD that is not live
        Assert.Empty(rig.Delivered);

        rig.Live.Add(Owner);
        var call = rig.Ask(Minimize);
        var r = await rig.DeliveredAsync();
        rig.Live.Remove(Owner); // the lease lapses while the user is deciding
        Assert.True(rig.Decide(r, approved: true));
        Assert.Equal("hud_unavailable", (await call).Error!.Code);
        Assert.Equal(0, rig.Policy.GrantedApprovalCount);
    }

    [Fact]
    public async Task EmergencyStop_BeforeDuringAndAtDecision()
    {
        using var rig = new Rig();
        rig.Stopped = true;
        Assert.Equal("emergency_stopped", (await rig.Ask(Minimize)).Error!.Code);
        Assert.Empty(rig.Delivered);
        rig.Stopped = false;

        var call = rig.Ask(Minimize);
        var r = await rig.DeliveredAsync();
        rig.Stopped = true;
        rig.Policy.InvalidateAllPendingAndGrantedApprovals("Emergency stop"); // what the engine does on Stop
        Assert.Equal("emergency_stopped", (await call).Error!.Code);
        Assert.False(rig.Decide(r, approved: true));
        rig.Stopped = false;

        var call2 = rig.Ask(Minimize);
        var r2 = await rig.DeliveredAsync(2);
        rig.Stopped = true; // latched, decision arrives afterwards
        Assert.True(rig.Decide(r2, approved: true));
        Assert.Equal("emergency_stopped", (await call2).Error!.Code);
        Assert.Equal(0, rig.Policy.GrantedApprovalCount);
    }

    [Fact]
    public async Task EpochChange_MakesThePendingApprovalStale()
    {
        using var rig = new Rig();
        var call = rig.Ask(Minimize);
        var r = await rig.DeliveredAsync();
        rig.Generation = 2; // Stop and resume happened in between
        Assert.True(rig.Decide(r, approved: true));
        Assert.Equal("emergency_stopped", (await call).Error!.Code);
        Assert.Equal(0, rig.Policy.GrantedApprovalCount);
    }

    [Fact]
    public async Task TargetReplacedOrGone_AfterApproval_IsRejected_AndTheGrantIsBurnt()
    {
        using var rig = new Rig();
        var call = rig.Ask(Minimize);
        var r = await rig.DeliveredAsync();
        rig.Windows.Now[100] = W(100, 4000, "notepad.exe", "Untitled - Notepad", created: T0 + 1); // same HWND and PID, new process
        Assert.True(rig.Decide(r, approved: true));
        var res = await call;
        Assert.Equal("target_changed", res.Error!.Code);
        Assert.Equal(0, rig.Policy.GrantedApprovalCount);

        rig.Windows.Now.Clear();
        var call2 = rig.Ask(Minimize);
        var r2 = await rig.DeliveredAsync(2);
        rig.Windows.Now[100] = W(100, 5000, "notepad.exe", "Untitled - Notepad"); // HWND reused by another process
        Assert.True(rig.Decide(r2, approved: true));
        Assert.Equal("target_changed", (await call2).Error!.Code);

        rig.Windows.Now.Clear();
        var call3 = rig.Ask(Minimize);
        var r3 = await rig.DeliveredAsync(3);
        rig.Windows.Now[100] = null;
        Assert.True(rig.Decide(r3, approved: true));
        Assert.Equal("target_disappeared", (await call3).Error!.Code);
    }

    [Fact]
    public async Task DaemonRestart_OldApprovalsNeverBecomeValid()
    {
        using var before = new Rig();
        var call = before.Ask(Minimize);
        var r = await before.DeliveredAsync();
        before.Decide(r, approved: true);
        await call;

        // A restarted daemon has a new, empty policy engine: no approval from before exists, pending or granted.
        using var after = new Rig();
        Assert.False(after.Decide(r, approved: true));
        var (valid, _) = after.Policy.ValidateConsumedApproval(r.ApprovalId, r.ActionId, r.ActionType, r.ActionParameters, r.TargetProcessName,
            r.TargetHwnd, r.TargetProcessId, r.TargetProcessCreationTime, Owner, 1, false);
        Assert.False(valid);
    }

    [Fact]
    public async Task Audit_RecordsTheWholeLifecycle_AndTheChainVerifies()
    {
        using var rig = new Rig(audit: true);
        await rig.Recorder!.InitializeAsync();
        var call = rig.Ask(Minimize);
        var r = await rig.DeliveredAsync();
        rig.Decide(r, approved: true);
        Assert.Equal("ok", (await call).Status);
        var deny = rig.Ask(Minimize);
        var r2 = await rig.DeliveredAsync(2);
        rig.Decide(r2, approved: false);
        await deny;
        await Task.Delay(200); // fire-and-forget audit writes in the policy engine

        var events = (await rig.Recorder.GetSafetyAuditRecordsAsync()).Select(e => e.EventType).ToList();
        foreach (var e in new[] { "DesktopActionRequested", "ApprovalRequested", "ApprovalGranted", "DesktopActionApprovedNotExecuted", "ApprovalDenied" })
            Assert.Contains(e, events);
        Assert.True((await rig.Recorder.VerifyAuditChainAsync()).Ok);
        // No title or parameter value leaks into the audit trail beyond the bounded identity fields.
        var all = string.Join("\n", (await rig.Recorder.GetSafetyAuditRecordsAsync()).Select(e => e.DetailsJson + e.Reason));
        Assert.DoesNotContain("Untitled - Notepad", all);
    }

    [Fact]
    public void Service_HasNoExecutor()
    {
        // Phase 7B.3 added exactly one executor dependency: the window-operation executor (one Win32 window call, no
        // input). Nothing else may act: no execution engine, no input injector, no other executor. With execution off
        // (the 7B.2 mode, the default) it is never called; Phase7B3Tests.ApprovalText_SaysExactlyWhatWillHappen proves it.
        var types = typeof(DesktopActionRequestService).GetConstructors().Single().GetParameters().Select(p => p.ParameterType).ToList();
        Assert.DoesNotContain(types, t => t != typeof(IWindowOperationExecutor) &&
            (t.Name.Contains("Execution") || t.Name.Contains("Input") || t.Name.Contains("Executor")));
        Assert.Single(types, t => t == typeof(IWindowOperationExecutor));
        Assert.Equal(new[] { "Apply" }, typeof(IWindowOperationExecutor).GetMethods().Select(m => m.Name).ToArray());
        var (allowed, risk, _) = new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance).EvaluatePolicy(DesktopActionTypes.FocusWindow, new(), "x");
        Assert.False(allowed);
        Assert.Equal(ActionRiskLevel.Elevated, risk);
    }

    // ── protocol v2 integration (real AgentHostManager over real pipes; fake action service records what it got) ──

    private sealed class FakeActions : IDesktopActionRequestService
    {
        public IReadOnlyList<string> Tools { get; } = new[] { DesktopActionRequestService.FocusWindowTool, DesktopActionRequestService.SetWindowStateTool };
        public int MaxCallMs => 35_000;
        public readonly List<DesktopActionContext> Contexts = new();
        public async Task<DesktopCallResult> ExecuteAsync(string tool, JsonElement args, DesktopActionContext ctx, CancellationToken ct)
        {
            lock (Contexts) Contexts.Add(ctx);
            try { await Task.Delay(7_000, ct); } // longer than a read-only call may ever take
            catch (OperationCanceledException) { return DesktopCallResult.Cancelled(); }
            return DesktopCallResult.Ok(new { decision = "approved", executed = false });
        }
    }

    private static AgentHostManager Manager(FakeActions a, object[] script) =>
        new(Microsoft.Extensions.Options.Options.Create(AgentHostManagerTests.Options("tests/agent-host/fixtures/desktopProtoHost.cjs", o =>
        {
            o.ExtraEnvironment["DASK_DESKTOP_SCRIPT"] = JsonSerializer.Serialize(script);
            o.ExtraEnvironment["DASK_DESKTOP_SETTLE"] = "300";
        })), NullLogger<AgentHostManager>.Instance, null, null, new FakeDesktop(), a);

    private static async Task<List<JsonElement>> RunAsync(AgentHostManager m, string session = "s1")
    {
        var ok = await m.SubmitAsync("minimize notepad", session);
        Assert.True(ok.Accepted, ok.ErrorMessage);
        var until = DateTime.UtcNow.AddSeconds(30);
        while (DateTime.UtcNow < until)
        {
            var r = m.GetTask(ok.TaskId!, session)?.Result;
            if (r != null) return JsonDocument.Parse(r.Response).RootElement.EnumerateArray().Select(e => e.Clone()).ToList();
            await Task.Delay(20);
        }
        throw new TimeoutException();
    }

    [Fact]
    public async Task Proto_ActionCall_GetsTheApprovalDeadline_TheOwnerSession_AndOnlyOnePerTask()
    {
        var a = new FakeActions();
        await using var m = Manager(a, new object[]
        {
            Call("c1", tool: "desktop.set_window_state", args: new { process = "notepad.exe", state = "minimize" }, deadline: 20_000), Await(1),
            Call("c2", tool: "desktop.focus_window", args: new { process = "notepad.exe" }, deadline: 20_000), Await(2),
        });
        var replies = await RunAsync(m, "hud-7");
        var c1 = replies.Single(x => x.GetProperty("callId").GetString() == "c1");
        Assert.Equal("ok", c1.GetProperty("status").GetString()); // 7 s: beyond the 6 s read-only cap, within the approval cap
        var c2 = replies.Single(x => x.GetProperty("callId").GetString() == "c2");
        Assert.Equal("action_limit", c2.GetProperty("error").GetProperty("code").GetString());
        var ctx = Assert.Single(a.Contexts);
        Assert.Equal("hud-7", ctx.OwnerSessionId); // from the daemon's task record
        Assert.Equal("c1", ctx.CallId);
    }

    [Fact]
    public async Task Proto_ActionCall_CancelReachesTheApproval()
    {
        var a = new FakeActions();
        await using var m = Manager(a, new object[]
        {
            Call("c1", tool: "desktop.focus_window", args: new { process = "notepad.exe" }, deadline: 20_000),
            new { sleep = 300 },
            new { line = new { v = 2, kind = "call.cancel", callId = "c1" } }, Await(1),
        });
        var replies = await RunAsync(m);
        Assert.Equal("cancelled", replies.Single().GetProperty("status").GetString());
    }

    [Fact]
    public async Task Proto_ActionsDisabled_AreUnknownTools()
    {
        var a = new FakeActions();
        var o = AgentHostManagerTests.Options("tests/agent-host/fixtures/desktopProtoHost.cjs", o =>
        {
            o.DesktopActionRequests = false;
            o.ExtraEnvironment["DASK_DESKTOP_SCRIPT"] = JsonSerializer.Serialize(new object[] { Call("c1", tool: "desktop.focus_window", args: new { process = "notepad.exe" }), Await(1) });
        });
        await using var m = new AgentHostManager(Microsoft.Extensions.Options.Options.Create(o), NullLogger<AgentHostManager>.Instance, null, null, new FakeDesktop(), a);
        var replies = await RunAsync(m);
        Assert.Equal("unknown_tool", replies.Single().GetProperty("error").GetProperty("code").GetString());
        Assert.Empty(a.Contexts);
    }
}
